/**
 * lib/talk-contract.ts — 은우 자유대화 라우트(`/api/english/talk/**`)와 화면이 함께 보는 요청·응답 계약 (docs/SPEC.md §21,
 * docs/harness/english.md §12-1·§12-3·§12-4·§12-6)
 *
 * **클라이언트 번들 안전**: `lib/ai/*`에서는 `import type`/`export type`만 한다(zod·프롬프트가 폰 번들로 새지 않게 — 계약 파일
 * 관용구, app-patterns §3). 여기 있는 값(상수·주소 함수·저장 본문 계획)은 이 파일 안에서 정의한 순수 값뿐이다(런타임 import 0).
 * qa-inspector가 라우트 응답 shape ↔ 화면 기대 타입을 교차 검증할 단일 정의처다.
 *
 * 라우트 일람(상태코드별 shape은 아래 각 절):
 * - POST   /api/english/talk/connect          SDP offer + 주제 선택 → SDP answer·callId·주제 스냅샷 (관문 R, 키 없으면 호출 전 501)
 * - POST   /api/english/talk/scene            주제 선택 → 장면 문장 → 주제 일러스트 1장(저장하지 않는다 — 대화 저장 때 함께 보낸다)
 * - POST   /api/english/talk/hangup           callId → 서버 hangup(과금 이중 안전장치, sendBeacon 본문 허용, 실패해도 200)
 * - POST   /api/english/talk                  대화 저장(은우 발화 ≥ 1) + 주제 일러스트(talkImages) — clientSessionId 멱등
 * - POST   /api/english/talk/reorder          목록 순서(범용 lib/reorder-contract.ts)
 * - POST   /api/english/talk/[id]/explain     문장 설명(호출 I) — 서버가 문장·문맥을 꺼낸다, 같은 문장은 저장된 설명 재사용(AI 0)
 * - POST   /api/english/talk/[id]/rename      화면 이름
 * - DELETE /api/english/talk/[id]             대화 + 주제 일러스트 연쇄 삭제(prod-guard 403)
 * - GET    /api/english/talk/images/[id]      주제 일러스트 바이트(cache-control: private)
 */

import type {
  TalkCard,
  TalkExplanation,
  TalkKeyWord,
  TalkScriptPiece,
  TalkSpeaker,
  TalkTopic,
  TalkTopicWord,
  TalkTurn,
} from "./ai/english/talk-schemas";
import type { TalkSpeed } from "./talk-topics";

export type { TalkCard, TalkExplanation, TalkKeyWord, TalkScriptPiece, TalkSpeaker, TalkTopic, TalkTopicWord, TalkTurn, TalkSpeed };

// ===========================================================================
// 상한·키 — 화면과 라우트가 같은 값을 본다
// ===========================================================================

/**
 * 주제 일러스트 data URL 길이 상한(§12-6 "900,000자 초과 시 압축 40으로 1회 재생성"). 사진 생성 관문(lib/talk-image.ts)이 이 값으로
 * 재생성을 판정하고, 저장 라우트가 같은 값으로 받은 그림을 검사한다(Firestore 문서 1MB).
 */
export const TALK_SCENE_DATA_URL_MAX = 900_000;

/** 대화 화면 이름(titleKo) 글자 상한 — 편집창 maxLength와 rename 라우트 zod가 같은 값을 본다 */
export const TALK_TITLE_MAX_CHARS = 60;

/** SDP offer 글자 상한(방어선 — 보통 수 KB) */
export const TALK_SDP_MAX_CHARS = 100_000;

/** Realtime 모델·음성 이름 형식(저장 요청이 돌려보내는 값 검사) */
export const TALK_MODEL_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * 저장 멱등 키(`TalkSaveRequest.clientSessionId`) 형식 — 소문자 UUID(36자). 대화 한 번에 컨트롤러가 하나 만들고(`newTalkSaveId`),
 * 스토어가 그 값을 대화 문서 id(와 주제 일러스트 문서 id)로 쓴다. 저장 응답이 유실돼 다시 저장해도(화면 복귀 자동 재시도·
 * "다시 저장"·뒤로가기 정리) 같은 대화가 두 번 생기지 않는다(QA english_talk_1 P2-1). Firestore 문서 id 규칙도 만족한다.
 */
export const TALK_SAVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 저장 요청을 `keepalive`로 보낼 수 있는 본문 **바이트**(UTF-8) 상한 — 브라우저 keepalive 본문 한도(64KiB = 65,536바이트, 진행 중인
 * keepalive 요청들의 합)보다 조금 작게. 잴 때는 `talkSaveBodyBytes`로 — **글자 수(`String.length`)로 재지 않는다**: 한글 한 글자는
 * 3바이트라 6만 자 미만의 본문도 64KiB를 넘는다. 그러면 keepalive fetch가 곧바로 TypeError로 거부되고, 같은 판정을 되풀이하는
 * 재시도가 모두 실패해 그 대화를 영영 저장하지 못한다(QA english_talk_2 P2-A).
 * 화면이 사라지는 중(pagehide)에는 이 한도 안에서만 요청이 끝까지 가므로, 넘으면 그림을 뺀 본문으로 보낸다(`planTalkSaveBody`).
 */
export const TALK_SAVE_KEEPALIVE_MAX_BYTES = 60_000;

/** 문자열 본문이 요청으로 나갈 때의 바이트 수 — fetch는 문자열 본문을 UTF-8로 보낸다(keepalive 한도가 재는 값) */
export function talkSaveBodyBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

/** 저장 요청 한 번의 본문과 전송 방식(`planTalkSaveBody`) */
export interface TalkSaveBodyPlan {
  body: string;
  /** body의 UTF-8 바이트 수 */
  bytes: number;
  /** bytes < TALK_SAVE_KEEPALIVE_MAX_BYTES */
  keepalive: boolean;
  /** 문서가 내려가는 중이라 keepalive 한도에 맞추려고 그림을 뺐다 */
  sceneDropped: boolean;
}

/**
 * 저장 본문과 keepalive 여부 — 화면의 모든 저장 경로(끝남·숨김·다시 저장·화면 복귀·언마운트·pagehide)가 이 한 곳을 지난다.
 * - 바이트가 상한 미만이면 keepalive(화면이 숨겨지는 중에도 요청이 끝까지 간다). 넘으면 일반 요청.
 * - `unloading`(pagehide — 문서가 내려가는 중)이고 그림이 실려 상한을 넘으면 그림을 뺀 본문으로 다시 잰다 — 그림보다 대화가 남아야 한다.
 * - 그림을 빼도 넘으면(아주 긴 전사) keepalive 없이 보낸다. 문서가 내려가면 끊길 수 있지만, keepalive로 보내면 곧바로 거부되니
 *   이쪽이 조금이라도 낫다.
 */
export function planTalkSaveBody(payload: TalkSaveRequest, opts: { unloading: boolean }): TalkSaveBodyPlan {
  let body = JSON.stringify(payload);
  let bytes = talkSaveBodyBytes(body);
  let sceneDropped = false;
  if (opts.unloading && payload.scene && bytes >= TALK_SAVE_KEEPALIVE_MAX_BYTES) {
    body = JSON.stringify({ ...payload, scene: null });
    bytes = talkSaveBodyBytes(body);
    sceneDropped = true;
  }
  return { body, bytes, keepalive: bytes < TALK_SAVE_KEEPALIVE_MAX_BYTES, sceneDropped };
}

/**
 * 저장 멱등 키 하나 — `crypto.randomUUID`(보안 컨텍스트), 없으면 `crypto.getRandomValues`로 같은 모양(v4)을 만든다.
 * 둘 다 없으면(아주 오래된 브라우저) Math.random 기반 — 충돌해도 스토어가 시작 시각으로 다른 대화임을 알아보고 새 id로 만든다.
 */
export function newTalkSaveId(): string {
  const c = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * **개발 빌드 전용** 가짜 전송(localStorage 키, 값 `"1"`) — 합성 이벤트(인사·도구 호출·은우 발화·늦은 전사·침묵·끊김)를 흘려
 * 화면 흐름을 실호출 없이 e2e로 돌린다(SPEC §21-6). production 번들에서는 읽지 않는다(`process.env.NODE_ENV === "production"`이면
 * localStorage를 읽기 **전에** false — 컴파일 때 상수로 접히고, 가짜 전송 모듈은 동적 import라 번들에서 빠진다).
 */
export const TALK_DEBUG_FAKE_KEY = "talk-debug-fake";

/**
 * **개발 빌드 전용** 시간 배율(localStorage 키, 0.01~1) — 5분 상한·마무리 대기(8초·25초)·도움 카드 5초·도움 요청 12초를 곱한다.
 * production에서는 1로 고정(토익 `toeic-debug-timescale`과 같은 가드).
 */
export const TALK_DEBUG_TIMESCALE_KEY = "talk-debug-timescale";

/** 대화 보기 주소 */
export function talkSessionHref(id: string): string {
  return `/english/talk/${encodeURIComponent(id)}`;
}

/** 주제 일러스트 주소(PIN 게이트 안 — 확장자를 붙이지 않는다) */
export function talkImageHref(id: string): string {
  return `/api/english/talk/images/${encodeURIComponent(id)}`;
}

// ===========================================================================
// 공통 오류 모양
// ===========================================================================

export interface TalkIssue {
  path: string;
  message: string;
}

export interface TalkFailure<C extends string> {
  ok: false;
  error: C;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: TalkIssue[];
}

// ===========================================================================
// 주제 선택 — 클라이언트는 키·글자·단어장 id만 보낸다(지시문·단어 목록은 서버가 만든다, §12-1)
// ===========================================================================

export type TalkTopicRequest =
  | { kind: "preset"; key: string }
  | { kind: "custom"; text: string }
  | { kind: "vocab"; vocabBookId: string };

// ===========================================================================
// POST /api/english/talk/connect — 관문 R 연결(통합 인터페이스, 키는 서버에만)
//  200 TalkConnectSuccess
//  400 invalid_input(형식·모르는 프리셋·30자 넘는 직접 입력·단어 없는 단어장)
//  404 vocab_not_found
//  501 no_api_key(OpenAI를 부르지 않는다)
//  500 connect_failed(상류 오류·시간 초과·answer 모양 아님)
// ===========================================================================

export interface TalkConnectRequest {
  /** RTCPeerConnection offer SDP */
  sdp: string;
  topic: TalkTopicRequest;
  speed: TalkSpeed;
}

export interface TalkConnectSuccess {
  ok: true;
  /** answer SDP — setRemoteDescription({type:"answer"}) */
  sdp: string;
  /** 연결 응답 Location의 마지막 조각. 없으면 null(대화는 되지만 서버 hangup 이중 장치를 못 건다) */
  callId: string | null;
  /** 서버가 해석해 지시문에 넣은 주제 스냅샷 — 저장 요청에 그대로 돌려보낸다 */
  topic: TalkTopic;
  /** 실제로 쓴 Realtime 모델·선생님 음성(저장 레코드) */
  model: string;
  voice: string;
}

export type TalkConnectErrorCode = "invalid_input" | "vocab_not_found" | "no_api_key" | "connect_failed";
export type TalkConnectResponse = TalkConnectSuccess | TalkFailure<TalkConnectErrorCode>;

// ===========================================================================
// POST /api/english/talk/scene — 주제 일러스트 1장(연결과 병렬, 비치명)
//  200 TalkSceneSuccess
//  400 invalid_input · 404 vocab_not_found
//  501 no_api_key(생성하지 않는다 — 대화는 그림 없이)
//  500 image_failed(실패·시간 초과·상한 초과 — 대화는 그림 없이)
// ===========================================================================

export interface TalkSceneRequest {
  topic: TalkTopicRequest;
}

export interface TalkSceneSuccess {
  ok: true;
  /** `data:image/jpeg;base64,…` (≤ TALK_SCENE_DATA_URL_MAX) */
  dataUrl: string;
  /** 장면 문장(영어) — 선생님 안내(TALK_SCENE_NOTE)의 {scene} */
  sceneEn: string;
  /**
   * 선생님에게 넣을 숨은 system 메시지 글(`buildTalkSceneNote(sceneEn)` — TALK_SCENE_NOTE 치환 결과). 서버가 조립해 준다 —
   * 화면이 프롬프트 원문·치환 규칙을 따로 갖지 않게(단일 정의처는 lib/ai/english/talk-prompts.ts).
   */
  note: string;
  model: string;
}

export type TalkSceneErrorCode = "invalid_input" | "vocab_not_found" | "no_api_key" | "image_failed";
export type TalkSceneResponse = TalkSceneSuccess | TalkFailure<TalkSceneErrorCode>;

// ===========================================================================
// POST /api/english/talk/hangup — 서버 hangup(sendBeacon 본문 — content-type에 기대지 않고 본문 글자를 JSON으로 읽는다)
//  200 { ok:true, hungUp }  — 상류 실패·이미 끊김도 200(hungUp:false). 끝내기는 이미 브라우저가 했다
//  400 invalid_input(callId 형식) · 501 no_api_key
// ===========================================================================

export interface TalkHangupRequest {
  callId: string;
}

export interface TalkHangupSuccess {
  ok: true;
  hungUp: boolean;
}

export type TalkHangupResponse = TalkHangupSuccess | TalkFailure<"invalid_input" | "no_api_key">;

// ===========================================================================
// POST /api/english/talk — 대화 저장(끝난 뒤 1회, 키 검사 없음) — clientSessionId로 멱등
//  200 TalkSaveSuccess(같은 clientSessionId로 다시 오면 이미 저장된 대화를 그대로 돌려준다 — 새로 만들지 않는다)
//  400 invalid_input · no_child_turn(은우 발화 0 — 화면은 저장을 부르지 않는다)
//  500 save_failed
// ===========================================================================

export interface TalkSaveRequest {
  /**
   * 저장 멱등 키(TALK_SAVE_ID_RE — 대화 한 번에 하나, `newTalkSaveId`). 스토어가 대화 문서 id로 쓴다 — 응답이 유실돼 다시 보내도
   * 같은 대화가 두 번 생기지 않는다. 같은 키에 시작 시각이 다른 대화가 이미 있으면(충돌) 스토어가 새 id로 만든다.
   */
  clientSessionId: string;
  /** connect가 돌려준 주제 스냅샷 그대로 */
  topic: TalkTopic;
  /** toTalkTurns(lines) — 상한(턴 200·턴 글자 1,000)을 넘으면 서버가 앞에서부터 잘라 저장한다(trimmed) */
  turns: TalkTurn[];
  /** 대화 중 보인 그림 카드(보인 순서) — 서버가 sanitizeTalkCards로 다시 검사한다(최대 30장) */
  cards: TalkCard[];
  /** 주제 일러스트(도착했으면) — 서버가 형식·크기를 검사해 talkImages에 넣는다. sceneEn은 서버가 주제에서 다시 계산한다 */
  scene: { dataUrl: string; sceneEn: string } | null;
  /** 연결이 열린 시각·끝난 시각(ISO) — 스트릭 날짜는 startedAt의 KST 일자 */
  startedAt: string;
  endedAt: string;
  model: string;
  voice: string;
}

export interface TalkSaveSuccess {
  ok: true;
  id: string;
  childTurnCount: number;
  /** 주제 일러스트를 함께 저장했다(보냈는데 false면 형식·크기 검사에 떨어졌다 — 대화는 저장됐다) */
  sceneSaved: boolean;
  /** 턴 상한 때문에 뒤쪽을 잘랐다 */
  trimmed: boolean;
}

export type TalkSaveErrorCode = "invalid_input" | "no_child_turn" | "save_failed";
export type TalkSaveResponse = TalkSaveSuccess | TalkFailure<TalkSaveErrorCode>;

// ===========================================================================
// POST /api/english/talk/[id]/explain — 문장 설명(호출 I)
//  200 TalkExplainSuccess — cached:true면 저장된 설명(AI 호출 0, 키 없어도 된다)
//  400 invalid_input · sentence_not_found(범위 밖 번호 — 과금 전에)
//  404 talk_not_found
//  501 no_api_key(저장된 설명이 없을 때만)
//  500 explain_failed(재요청까지 실패)
// ===========================================================================

export interface TalkExplainRequest {
  turnIndex: number;
  sentenceIndex: number;
}

export interface TalkExplainSuccess {
  ok: true;
  explanation: TalkExplanation;
  /** 저장된 설명을 돌려줬다(이번 요청은 AI를 부르지 않았다) */
  cached: boolean;
  /** 대화 기록에 저장됐다(설명 상한에 닿아 저장 못 했으면 false — 설명은 그대로 보인다) */
  saved: boolean;
}

export type TalkExplainErrorCode = "invalid_input" | "sentence_not_found" | "talk_not_found" | "no_api_key" | "explain_failed";
export type TalkExplainResponse = TalkExplainSuccess | TalkFailure<TalkExplainErrorCode>;

// ===========================================================================
// POST /api/english/talk/[id]/rename — 화면 이름만(수정이라 prod-guard 무관)
//  200 { ok:true, id, titleKo } · 400 invalid_input · 404 talk_not_found · 500 save_failed
// ===========================================================================

export interface TalkRenameRequest {
  titleKo: string;
}

export interface TalkRenameSuccess {
  ok: true;
  id: string;
  titleKo: string;
}

export type TalkRenameResponse = TalkRenameSuccess | TalkFailure<"invalid_input" | "talk_not_found" | "save_failed">;

// ===========================================================================
// DELETE /api/english/talk/[id] — 대화 + 주제 일러스트 연쇄 삭제
//  200 { ok:true } · 404 talk_not_found · 403 prod_guard(개발 환경에서 실데이터) · 500 delete_failed
// ===========================================================================

export type TalkDeleteResponse = { ok: true } | TalkFailure<"talk_not_found" | "prod_guard" | "delete_failed">;

// ===========================================================================
// GET /api/english/talk/images/[id] — 200 image/jpeg 바이트(cache-control: private) · 아래는 JSON 오류
// ===========================================================================

export type TalkImageGetErrorResponse = TalkFailure<"image_not_found" | "image_unreadable">;

// ===========================================================================
// 화면 데이터 — 서버 컴포넌트가 줄여 내리는 모양(레코드 전문을 넘기지 않는다)
// ===========================================================================

/** 시작 화면의 단어장 한 줄(단어 목록은 넘기지 않는다 — 서버가 id로 읽는다, §12-1) */
export interface TalkVocabBookOption {
  id: string;
  titleKo: string;
  dayLabel: string | null;
  wordCount: number;
  /** "모은 단어" 단어장인가(서버가 dayLabel 마커로 계산) */
  collected: boolean;
}

/** 지난 대화 목록 한 줄 */
export interface TalkHistoryItem {
  id: string;
  titleKo: string;
  topicLabelKo: string;
  topicKind: TalkTopic["kind"];
  childTurnCount: number;
  durationSec: number;
  hasScene: boolean;
  explanationCount: number;
  createdAt: string;
  startedAt: string;
  sortIndex: number | null;
}

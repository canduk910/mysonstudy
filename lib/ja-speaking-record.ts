/**
 * lib/ja-speaking-record.ts — 아빠의 일본어 **🎙️ 말하기 모의고사** 저장 레코드 3종의 타입·정규화·원자 단위 판정/적용 순수 함수
 * (docs/harness/japanese.md §15-9)
 *
 * 컬렉션 셋 `jaSpeakingMocks`·`jaSpeakingImages`·`jaSpeakingAttempts` — 토익 컬렉션(`toeicMocks`·`toeicImages`·`toeicAttempts`)에
 * **섞지 않는다**(토익 모의고사 목록·제목 번호·영어 스트릭·추정 등급 오염 방지, §15-9 머리말).
 *
 * 두 백엔드(lib/store.ts 파일 mutate · lib/store-firestore.ts runTransaction)가 **같은 함수**로 정규화·판정·적용한다 — 판정이 두 벌이면
 * 한쪽만 "먼저 만든 사진을 덮는"·"닫힌 응시를 다시 닫는" 구멍이 난다(lib/toeic-mock-apply.ts·toeic-attempt-rules.ts와 같은 방침).
 * 응시 범위·한 번만 닫기·범위 채우기 판정은 언어와 무관해 토익 순수 함수(`decideAttemptScope`·`decideAttemptFinish`·`completeFinishAnswers`)를
 * 그대로 쓴다(형식표 공유 — §15-2).
 *
 * 전부 필수 nullable — 선택 키(`?`) 없음(Firestore가 undefined를 거부한다). Firestore 배열 속 배열은 없다(§15-9-1 — `tokens`는 늘 객체 안,
 * 답의 `readDiff.missing`·`feedback.fixes`도 객체 안 배열) — `toeicFirestoreCodec` 같은 감싸기가 필요 없다.
 *
 * ⚠️ 런타임 import는 순수 모듈뿐(lib/ja-speaking·lib/toeic-attempt-rules) — lib/ai는 `import type`만. eval·두 백엔드가 가볍게 부른다.
 */

import type { JlptLevel } from "./ai/japanese/schemas";
import type { JaSpeakingFeedback, JaSpeakingImageSlot, JaSpeakingPartRecordMap } from "./ai/japanese/speaking-schemas";
import type { JaSpeakingParts } from "./ai/japanese/speaking";
import type { JaReadDiff } from "./ja-speaking-score";
import { JA_SPEAKING_LEVELS, JA_SPEAKING_PARTS, type JaSpeakingPart } from "./ja-speaking";
import { isToeicAttemptClosed } from "./toeic-attempt-rules";

export type { JaSpeakingParts };

// ---------------------------------------------------------------------------
// 레코드 (§15-9-1~3)
// ---------------------------------------------------------------------------

/** `jaSpeakingMocks` */
export interface JaSpeakingMockRecord {
  id: string;
  /** 기본 "말하기 모의고사 {n}"(defaultJaSpeakingTitle) 또는 사용자 수정 */
  titleKo: string;
  /** 만들 때 고른 레벨 하나 — 파트 다시 만들기·채점(호출 F)이 같은 값을 쓴다 */
  level: JlptLevel;
  /** 호출 E에 넘긴 주제 힌트(normalizeJaSpeakingTopicHints 결과 그대로) — 다시 만들기가 같은 입력 */
  topicHints: string[];
  /** 실패·미선택이면 null. 완전한 세트 = 다섯 파트 모두 non-null */
  parts: JaSpeakingParts;
  model: string;
  createdAt: string;
  sortIndex: number | null;
}

/** `jaSpeakingImages` — 토익 §7-4와 같은 모양 */
export interface JaSpeakingImageRecord {
  id: string;
  mockId: string;
  slot: 0 | 1;
  dataUrl: string;
  model: string;
  createdAt: string;
}

/** 응시 문항 하나(§15-9-3) */
export interface JaSpeakingAnswer {
  q: number;
  recorded: boolean;
  durationMs: number | null;
  /** 관문 T-ja */
  transcript: string | null;
  /** Q1–2만(§15-5) */
  readDiff: JaReadDiff | null;
  /** Q3–11만(호출 F 결과 그대로). 무응답이면 null */
  feedback: JaSpeakingFeedback | null;
  /** 전사 글자 < 4 → 호출 F 없이 0점(Q1–2는 화면 문구용 표시만) */
  noResponse: boolean;
  /** Q1–2 = jaReadProxyScore, Q3–11 = feedback.score, 무응답 0 */
  score: number | null;
  scoredAt: string | null;
}

/** `jaSpeakingAttempts` — 서버 녹음 메타(recordings)는 두지 않는다(녹음이 기기 전용, §15-9-4) */
export interface JaSpeakingAttemptRecord {
  id: string;
  mockId: string;
  scope: "full" | "part";
  parts: JaSpeakingPart[];
  /** 응시 범위(jaSpeakingQuestionsForParts) — 스트릭 한 판 판정이 본다 */
  questions: number[];
  startedAt: string;
  finishedAt: string | null;
  answers: JaSpeakingAnswer[];
}

export type NewJaSpeakingMock = Omit<JaSpeakingMockRecord, "id" | "createdAt" | "sortIndex">;
export type NewJaSpeakingAttempt = Omit<JaSpeakingAttemptRecord, "id">;

/** 끝/그만두기 입력 — 문항별 녹음 여부·길이(점수는 건드리지 않는다). 범위 채우기는 라우트가 completeFinishAnswers로 */
export interface FinishJaSpeakingAttemptInput {
  finishedAt: string | null;
  answers: { q: number; recorded: boolean; durationMs: number | null }[];
}
/** 끝/그만두기 결과 — 한 번만(already_closed면 아무것도 쓰지 않았다). 없는 id면 스토어가 null */
export type FinishJaSpeakingAttemptResult = { outcome: "finished" | "already_closed"; record: JaSpeakingAttemptRecord };

/** 문항 하나 채점 결과 — 그 문항만 바꾼다 */
export type JaSpeakingAnswerScorePatch = Pick<JaSpeakingAnswer, "transcript" | "readDiff" | "feedback" | "noResponse" | "score" | "scoredAt">;

/** 파트 채우기 결과(빈 자리만). 없는 id면 스토어가 null */
export type FillJaSpeakingMockPartResult = { outcome: "filled" | "exists"; record: JaSpeakingMockRecord };

/** 사진 저장 입력(관문 P) — 사진 문서 생성과 모의고사 칸 갱신을 한 원자 단위로 */
export interface SaveJaSpeakingPictureImageInput {
  mockId: string;
  slot: 0 | 1;
  /** 사진을 만든 E2 imagePrompt — 지금 레코드의 장면과 다르면 쓰지 않는다(stale) */
  imagePrompt: string;
  dataUrl: string;
  model: string;
}
export type SaveJaSpeakingPictureImageResult =
  | { outcome: "saved"; record: JaSpeakingMockRecord; image: JaSpeakingImageRecord }
  | { outcome: "kept" | "stale"; record: JaSpeakingMockRecord }
  | { outcome: "missing"; record: JaSpeakingMockRecord | null };
export type MarkJaSpeakingPictureImageFailedResult =
  | { outcome: "marked" | "kept" | "stale"; record: JaSpeakingMockRecord }
  | { outcome: "missing"; record: JaSpeakingMockRecord | null };

// ---------------------------------------------------------------------------
// 정규화 — 옛·손으로 넣은 문서 방어(두 백엔드 공유). 모양만 채운다(품질 판정은 lib/japanese-record.ts isRenderableJaSpeakingMock)
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function nullableNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function normalizeJaSpeakingParts(raw: unknown): JaSpeakingParts {
  const o = asObj(raw);
  const out = {} as Record<JaSpeakingPart, unknown>;
  for (const p of JA_SPEAKING_PARTS) out[p] = o[p] === undefined ? null : o[p];
  return out as JaSpeakingParts;
}

export function normalizeJaSpeakingMockRecord(raw: unknown): JaSpeakingMockRecord {
  const o = asObj(raw);
  const level = (JA_SPEAKING_LEVELS as readonly string[]).includes(o.level as string) ? (o.level as JlptLevel) : "N4";
  return {
    id: str(o.id),
    titleKo: str(o.titleKo),
    level,
    topicHints: Array.isArray(o.topicHints) ? o.topicHints.filter((h): h is string => typeof h === "string") : [],
    parts: normalizeJaSpeakingParts(o.parts),
    model: str(o.model),
    createdAt: str(o.createdAt),
    sortIndex: nullableNum(o.sortIndex),
  };
}

export function normalizeJaSpeakingImageRecord(raw: unknown): JaSpeakingImageRecord {
  const o = asObj(raw);
  return {
    id: str(o.id),
    mockId: str(o.mockId),
    slot: o.slot === 1 ? 1 : 0,
    dataUrl: str(o.dataUrl),
    model: str(o.model),
    createdAt: str(o.createdAt),
  };
}

export function normalizeJaSpeakingAnswer(raw: unknown): JaSpeakingAnswer {
  const o = asObj(raw);
  return {
    q: typeof o.q === "number" ? o.q : 0,
    recorded: o.recorded === true,
    durationMs: nullableNum(o.durationMs),
    transcript: nullableStr(o.transcript),
    readDiff: o.readDiff && typeof o.readDiff === "object" ? (o.readDiff as JaReadDiff) : null,
    feedback: o.feedback && typeof o.feedback === "object" ? (o.feedback as JaSpeakingFeedback) : null,
    noResponse: o.noResponse === true,
    score: nullableNum(o.score),
    scoredAt: nullableStr(o.scoredAt),
  };
}

export function normalizeJaSpeakingAttemptRecord(raw: unknown): JaSpeakingAttemptRecord {
  const o = asObj(raw);
  const parts = Array.isArray(o.parts) ? JA_SPEAKING_PARTS.filter((p) => (o.parts as unknown[]).includes(p)) : [];
  return {
    id: str(o.id),
    mockId: str(o.mockId),
    scope: o.scope === "part" ? "part" : "full",
    parts,
    questions: Array.isArray(o.questions) ? o.questions.filter((q): q is number => typeof q === "number" && Number.isInteger(q)) : [],
    startedAt: str(o.startedAt),
    finishedAt: nullableStr(o.finishedAt),
    answers: Array.isArray(o.answers) ? o.answers.map(normalizeJaSpeakingAnswer) : [],
  };
}

// ---------------------------------------------------------------------------
// 원자 단위 판정·적용 (두 백엔드가 같은 함수 — lib/toeic-mock-apply.ts·toeic-attempt-rules.ts 관용구)
// ---------------------------------------------------------------------------

/** 파트 채우기 — 빈 자리만(이미 있으면 exists, 쓰지 않는다) */
export function decideJaSpeakingFillPart(current: JaSpeakingMockRecord, part: JaSpeakingPart): "fill" | "exists" {
  return current.parts[part] === null || current.parts[part] === undefined ? "fill" : "exists";
}

export function applyJaSpeakingFillPart<P extends JaSpeakingPart>(current: JaSpeakingMockRecord, part: P, value: JaSpeakingPartRecordMap[P]): JaSpeakingMockRecord {
  return { ...current, parts: { ...current.parts, [part]: value } };
}

/**
 * 사진 상태 쓰기 판정 — missing(파트·칸 없음) · stale(장면이 바뀜) · kept(이미 ready — 먼저 준비된 사진이 이긴다) · apply
 */
export function decideJaSpeakingPictureImage(current: JaSpeakingMockRecord, slot: 0 | 1, imagePrompt: string): "apply" | "kept" | "stale" | "missing" {
  const item = current.parts.picture?.items[slot];
  if (!item) return "missing";
  if (item.imagePrompt !== imagePrompt) return "stale";
  if (item.image?.status === "ready" && item.image.imageId) return "kept";
  return "apply";
}

export function applyJaSpeakingPictureImage(current: JaSpeakingMockRecord, slot: 0 | 1, image: JaSpeakingImageSlot): JaSpeakingMockRecord {
  const picture = current.parts.picture;
  if (!picture) return current;
  const items = picture.items.map((it, k) => (k === slot ? { ...it, image } : it));
  return { ...current, parts: { ...current.parts, picture: { ...picture, items } } };
}

/** 닫힌 응시인가 — 토익 규칙 그대로(finishedAt ≠ null || answers.length > 0) */
export function isJaSpeakingAttemptClosed(a: Pick<JaSpeakingAttemptRecord, "finishedAt" | "answers">): boolean {
  return isToeicAttemptClosed(a);
}

/** 끝/그만두기 적용 — answers를 범위 전체로 채운 입력(completeFinishAnswers 결과)으로 바꾼다. 판정(한 번만)은 호출측이 먼저 */
export function applyJaSpeakingFinish(current: JaSpeakingAttemptRecord, input: FinishJaSpeakingAttemptInput): JaSpeakingAttemptRecord {
  return {
    ...current,
    finishedAt: input.finishedAt,
    answers: input.answers.map((a) => ({
      q: a.q,
      recorded: a.recorded === true,
      durationMs: a.recorded ? a.durationMs : null,
      transcript: null,
      readDiff: null,
      feedback: null,
      noResponse: false,
      score: null,
      scoredAt: null,
    })),
  };
}

/** 그 문항만 채점 결과로 바꾼다(다른 문항은 그대로 — 동시 채점 2개가 서로 덮지 않게 원자 단위 안에서 부른다) */
export function applyJaSpeakingAnswer(current: JaSpeakingAttemptRecord, q: number, patch: JaSpeakingAnswerScorePatch): JaSpeakingAttemptRecord {
  return { ...current, answers: current.answers.map((a) => (a.q === q ? { ...a, ...patch } : a)) };
}

/** AI 채점 대상인가 — 녹음됐고 아직 점수가 없다(녹음이 이 기기에 있는지는 화면이 따로 본다) */
export function isScorableJaSpeakingAnswer(a: Pick<JaSpeakingAnswer, "recorded" | "score">): boolean {
  return a.recorded === true && a.score === null;
}

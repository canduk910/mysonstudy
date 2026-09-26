/**
 * lib/talk-realtime.ts — 은우 자유대화 **실시간 클라이언트**(관문 R 브라우저 쪽) (docs/harness/english.md §12-1·§12-2·§12-6,
 * SPEC §21-2·§21-5·§21-7)
 *
 * 대화 한 번을 맡는 컨트롤러(`TalkCallController`)와 전송 인터페이스(`TalkTransport`)다. 화면(components/talk-call-overlay.tsx)은
 * `subscribe`/`getSnapshot`(useSyncExternalStore)으로 스냅숏만 그리고, 동작은 이 모듈이 한다.
 *
 * ── 전송 ─────────────────────────────────────────────────────────────────────
 * - 실제: WebRTC(`WebRtcTalkTransport`) — RTCPeerConnection에 마이크 트랙(lib/mic-session.ts `acquireMicStream`이 잡은 것)을 싣고,
 *   원격 트랙은 `<audio autoplay playsinline>` 요소로, JSON 이벤트는 데이터 채널 `oai-events`로. offer SDP는 우리 서버
 *   `/api/english/talk/connect`(PIN 게이트 안)가 표준 키로 OpenAI에 넘긴다 — 브라우저에는 키가 없다.
 * - **개발 빌드 전용 가짜 전송**(localStorage `talk-debug-fake`="1", lib/talk-fake-transport.ts): 합성 이벤트로 인사·도구 호출·
 *   은우 발화(늦은 전사 포함)·침묵·끊김을 흘린다. production에서는 localStorage를 읽기 **전에** false이고(컴파일 때 접힌다),
 *   가짜 전송 모듈은 그 분기 안의 동적 import라 production 번들에 실리지 않는다.
 * - **개발 전용 시간 배율**(`talk-debug-timescale`, 0.01~1): 5분 상한·마무리 대기 8초·25초·도움 5초·12초를 곱한다. production은 1.
 *
 * ── 앱이 선생님에게 넣는 안내 — 전부 숨은 system 메시지(`app_` id) + `response.create`(인자 없음) ─────────────────
 *   첫 인사(데이터 채널이 열리면)·마무리(5분)·도움 요청(12초·🙋)은 `buildTalkSystemNoteEvent` + `buildTalkResponseCreateEvent`.
 *   응답 단위 instructions는 쓰지 않는다 — 세션 지시문(성격·안전 규칙)을 덮어쓴다(§12-1 2026-09-26 정정).
 *   주제 일러스트 안내(TALK_SCENE_NOTE)는 system 메시지**만**(response.create 없음 — 선생님이 다음 차례에 자연스럽게 쓴다).
 *   안내 글 원문은 이 모듈이 import하지 않는다(프롬프트 원문을 폰 번들에 싣지 않는다) — 서버 컴포넌트가 props로 내린 것
 *   (`TalkAppNotes`)과 장면 라우트가 조립해 준 안내(`TalkSceneSuccess.note`)를 쓴다.
 *
 * ── 응답이 진행 중일 때 response.create를 보내지 않는다(QA talk-cards P2-3) ─────────────────────────
 *   "한 번에 한 응답만 대화에 쓸 수 있다"(SDK 주석). `response.created` → 진행 중, `response.done` → 끝으로 따라가며, 진행 중에
 *   생긴 도움 요청은 보류했다가 그 응답이 **오디오 없이** 끝나면 보낸다(오디오가 있었으면 선생님이 방금 새 차례를 말한 것이라 버린다 —
 *   그 응답 뒤에 이어 말하기를 보내도 버린다).
 *   마무리도 진행 중 응답이 끝나기를 기다린다(오래 끌면 response.cancel 뒤에 보낸다).
 *
 * ── 도구 호출(§12-6) ───────────────────────────────────────────────────────────
 *   `response.output_item.done`·`response.done`에서 function_call을 꺼내 callId로 **한 번만** `parseTalkToolCall`(모델 출력을 믿지
 *   않는다) → show_hints는 도움 상태 기계로, show_picture는 큰 그림 카드(+ 단어장 모드 ✓). `response.done`에서 호출마다
 *   function_call_output(`{"shown":true}`, id `app_out_n`)을 보내고, **도구를 부르고 말한 글자에 질문 없이 끝난 응답**(오디오가
 *   없던 응답 포함 — 2026-09-26 실연결: 선생님이 한두 마디 하다 도구를 부르고 질문 없이 응답을 끝내 은우가 기다리던 것)이면
 *   response.create로 이어 말하게 한다. 판정·연속 상한 2회는 lib/talk-cards.ts `stepTalkContinue` 한 곳 — 셈은 **은우 발화로만** 0
 *   (말만 하고 질문 없는 응답이 끝없이 이어 말하기를 부르지 않게. 매 응답이 대화 전체를 되풀이 과금한다). 질문을 했으면 은우 차례라
 *   보내지 않는다. 마무리 중 도구 호출은 표시도 이어 말하기도 하지 않는다. 카드는 **소리를 내지 않는다**(마이크가 열려 있다).
 *
 * ── 5분 상한 ───────────────────────────────────────────────────────────────────
 *   닿으면 도움 상태 기계에 wrapup_started(카드·요청 중지) → 선생님이 말하는 중이면 최대 8초 기다린 뒤 마무리 안내 → 그 응답의
 *   소리가 멈추면(또는 오디오 없이 끝나면, 또는 25초 상한) 종료.
 *
 * ── 주제 일러스트 ─────────────────────────────────────────────────────────────────
 *   요청은 마이크를 얻은 **뒤**에 연결과 병렬로 시작한다(QA english_talk_1 P2-4 — 마이크 거부·대화 전 끝에는 생성 요청 0).
 *   도착했을 때 대화 중(연결 중 포함)·마무리 전이면 띄우고(`scene.shown`) 선생님에게 알린다. 마무리 중에 도착하면 띄우지도 알리지도
 *   않고 저장에만 싣는다(§12-6 "대화 중이고 마무리 전이면" — QA english_talk_1 P2-3).
 *
 * ── 끝내기(`end`) ───────────────────────────────────────────────────────────────
 *   데이터 채널·피어 연결 close → 마이크 release(트랙 stop → activeCaptures-- → playback, lib/mic-session.ts) → 서버 hangup을
 *   `navigator.sendBeacon`으로(탭이 닫혀도 간다 — 과금 이중 안전장치). 저장은 화면이 `getSavePayload()`로 한다(은우 발화 0이면 null).
 *   저장 본문에는 컨트롤러가 만들 때 정한 멱등 키(`saveId` → `clientSessionId`)가 실린다 — 몇 번을 보내도 대화는 하나다(P2-1).
 *
 * ── 끝내기 전 전사 기다림(`finish`) — 끝내기 버튼·5분 마무리 뒤 종료만 ────────────────────────────────
 *   은우 줄이 아직 "듣는 중…"(listening)이나 글자가 오는 중(partial)이면 바로 닫지 않고 그 줄의 전사 완료(completed·failed)를
 *   **최대 TALK_FINISH_TRANSCRIPT_WAIT_MS(2.5초)** 기다린 뒤 end()한다 — 은우의 마지막 말이 저장에서 빠지지 않게. 그동안(`finishing`):
 *   마이크 트랙을 끄고(enabled=false — 무음 프레임), 서버 턴 감지를 끄고(session.update `turn_detection: null` — 새 은우 차례·자동
 *   응답이 생기지 않는다), 은우가 말하는 중이었으면 지금까지의 소리를 커밋한다(input_audio_buffer.commit — 턴 감지를 끄면 서버가
 *   스스로 커밋하지 않는다. 말하는 중이 아니면 보내지 않는다 — 침묵을 커밋하면 전사 모델이 없는 말을 지어낼 수 있다). 진행 중 응답은
 *   취소하고(response.cancel + output_audio_buffer.clear) 선생님 소리는 음소거한다. 턴 감지 끄기가 늦거나 거부돼 응답이 새로
 *   시작되면(response.created) 그 자리에서 취소한다(두 겹). 화면 숨김·뒤로가기·pagehide·끊김은 기다리지 않는다 — `end()` 즉시.
 *
 * ⚠️ 클라이언트 전용 모듈. 런타임 import는 클라이언트 안전 모듈(talk-transcript·talk-hints·talk-cards·talk-contract·kst 없음)뿐 —
 * lib/ai·openai·zod·store는 `import type`만. 정규식 lookbehind를 쓰지 않는다(iOS 16.3 이하 Safari).
 */

import type {
  InputAudioBufferCommitEvent,
  OutputAudioBufferClearEvent,
  ResponseCancelEvent,
  SessionUpdateEvent,
} from "openai/resources/realtime/realtime";
import type { TalkCard } from "./ai/english/talk-schemas";
import { MicError, type MicStreamHandle } from "./mic-session";
import {
  TALK_CARD_LIMITS,
  buildTalkToolOutputEvent,
  extractTalkFunctionCalls,
  matchTalkWord,
  parseTalkToolCall,
  stepTalkContinue,
  type TalkResponseDoneSummary,
} from "./talk-cards";
import {
  TALK_DEBUG_FAKE_KEY,
  TALK_DEBUG_TIMESCALE_KEY,
  newTalkSaveId,
  type TalkConnectRequest,
  type TalkConnectResponse,
  type TalkConnectSuccess,
  type TalkSaveRequest,
  type TalkSceneResponse,
  type TalkTopicRequest,
} from "./talk-contract";
import {
  createTalkHints,
  reduceTalkHints,
  talkHintEventFromServer,
  talkHintTimings,
  viewTalkHints,
  type TalkHintsEvent,
  type TalkHintsState,
  type TalkHintsView,
} from "./talk-hints";
import { TALK_MAX_DURATION_SEC, type TalkSpeed } from "./talk-topics";
import {
  buildTalkResponseCreateEvent,
  buildTalkSystemNoteEvent,
  childTurnCount,
  createTalkTranscript,
  reduceTalkTranscript,
  toTalkTurns,
  type TalkLine,
  type TalkTranscriptState,
} from "./talk-transcript";

// ===========================================================================
// 상수 — 한 곳
// ===========================================================================

/** 마무리 때 선생님이 말하는 중이면 기다리는 최대 시간(ms, §21-2 "최대 8초") */
export const TALK_WRAPUP_WAIT_MS = 8_000;
/** 마무리 안내를 보낸 뒤 그 응답이 끝나기를 기다리는 최대 시간(ms — 넘으면 그냥 끝낸다) */
export const TALK_WRAPUP_END_MS = 25_000;
/** 화면 시계·도움 상태 기계 tick 간격(ms) */
export const TALK_TICK_MS = 250;
/** 연결 요청 상한(ms) — 서버 상한(20초)보다 조금 길게 */
export const TALK_CONNECT_CLIENT_TIMEOUT_MS = 25_000;
/** 우리가 보낸 response.create에 response.created가 이만큼 안 오면 거부된 것으로 본다(ms) */
const RESPONSE_CREATED_WAIT_MS = 5_000;
/**
 * 끝내기(버튼·5분 마무리 뒤) 때 아직 전사 중인 은우 줄을 기다리는 최대 시간(ms). 개발 시간 배율을 곱하지 않는다 — 5분·8초 같은
 * 대화 규칙이 아니라 실제 전사 지연(네트워크)을 기다리는 값이다. 숨김·뒤로가기는 기다리지 않는다.
 */
export const TALK_FINISH_TRANSCRIPT_WAIT_MS = 2_500;
/** 서버 hangup 주소(sendBeacon) */
export const TALK_HANGUP_URL = "/api/english/talk/hangup";

// ===========================================================================
// 개발 전용 스위치 — production에서는 localStorage를 읽기 **전에** 고정값(컴파일 때 접힌다)
// ===========================================================================

/** 개발 빌드 전용 시간 배율(0.01~1). production은 1. */
export function readTalkDebugTimescale(): number {
  if (process.env.NODE_ENV === "production") return 1;
  try {
    const v = Number(window.localStorage.getItem(TALK_DEBUG_TIMESCALE_KEY));
    return Number.isFinite(v) && v > 0 && v < 1 ? Math.max(0.01, v) : 1;
  } catch {
    return 1;
  }
}

/** 개발 빌드 전용 가짜 전송을 쓰는가. production은 false. */
export function readTalkDebugFake(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    return window.localStorage.getItem(TALK_DEBUG_FAKE_KEY) === "1";
  } catch {
    return false;
  }
}

// ===========================================================================
// 서버 안내 글 — 서버 컴포넌트가 props로 내린다(프롬프트 원문을 이 모듈에 import하지 않는다)
// ===========================================================================

export interface TalkAppNotes {
  /** TALK_GREETING_INSTRUCTIONS */
  greeting: string;
  /** TALK_WRAPUP_INSTRUCTIONS */
  wrapup: string;
  /** TALK_NUDGE_NOTE */
  nudge: string;
}

// ===========================================================================
// 전송
// ===========================================================================

export interface TalkTransportHandlers {
  /** 데이터 채널 서버 이벤트(JSON 그대로) */
  onEvent(event: unknown): void;
  /** 데이터 채널이 열렸다(이제 이벤트를 보낼 수 있다) */
  onOpen(): void;
  /** 연결이 끊겼다(피어 연결 failed·데이터 채널 닫힘 — 우리가 닫은 경우는 부르지 않는다) */
  onDisconnect(reason: string): void;
}

export interface TalkConnectArgs {
  topic: TalkTopicRequest;
  speed: TalkSpeed;
}

export interface TalkTransport {
  readonly kind: "webrtc" | "fake";
  /** 연결(offer → /connect → answer). 실패는 TalkConnectError로 throw */
  connect(args: TalkConnectArgs, handlers: TalkTransportHandlers): Promise<TalkConnectSuccess>;
  /** 클라이언트 이벤트 하나(데이터 채널이 열려 있을 때만 — 아니면 조용히 버린다) */
  send(event: object): void;
  /** 닫기(멱등) */
  close(): void;
}

/** 연결 실패 — 화면에 보일 한국어와 상태 코드 */
export class TalkConnectError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly messageKo: string;
  constructor(code: string, messageKo: string, status: number | null) {
    super(`[talk] connect ${code}`);
    this.name = "TalkConnectError";
    this.code = code;
    this.status = status;
    this.messageKo = messageKo;
  }
}

/** `/api/english/talk/connect` 호출(실제·가짜 전송 공용). 실패는 TalkConnectError. */
export async function postTalkConnect(body: TalkConnectRequest, signal?: AbortSignal): Promise<TalkConnectSuccess> {
  let res: Response;
  try {
    res = await fetch("/api/english/talk/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new TalkConnectError("network", "인터넷 연결을 확인해 주세요. 선생님과 연결하지 못했어요.", null);
  }
  const data = (await res.json().catch(() => null)) as TalkConnectResponse | null;
  if (!data) throw new TalkConnectError("bad_response", "선생님과 연결하지 못했어요. 잠시 후 다시 걸어 볼까요?", res.status);
  if (!data.ok) throw new TalkConnectError(data.error, data.messageKo, res.status);
  return data;
}

/** 실제 전송 — WebRTC(원격 소리는 `<audio autoplay playsinline>` 요소, 이벤트는 데이터 채널 `oai-events`) */
export class WebRtcTalkTransport implements TalkTransport {
  readonly kind = "webrtc" as const;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private closed = false;
  private abort = new AbortController();

  constructor(
    private readonly mic: MediaStream,
    private readonly audio: HTMLAudioElement,
  ) {}

  async connect(args: TalkConnectArgs, handlers: TalkTransportHandlers): Promise<TalkConnectSuccess> {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.audio.srcObject = stream;
      const p = this.audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {}); // 자동재생은 캡처 중이면 허용된다 — 실패해도 조용히
    };
    for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      handlers.onEvent(parsed);
    };
    dc.onopen = () => handlers.onOpen();
    dc.onclose = () => {
      if (!this.closed) handlers.onDisconnect("data_channel_closed");
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") handlers.onDisconnect(`pc_${pc.connectionState}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const timeout = setTimeout(() => this.abort.abort(), TALK_CONNECT_CLIENT_TIMEOUT_MS);
    try {
      const info = await postTalkConnect({ sdp: offer.sdp ?? "", topic: args.topic, speed: args.speed }, this.abort.signal);
      if (this.closed) return info;
      await pc.setRemoteDescription({ type: "answer", sdp: info.sdp });
      return info;
    } finally {
      clearTimeout(timeout);
    }
  }

  send(event: object): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify(event));
    } catch {
      /* 닫히는 중 — 버린다 */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    try {
      this.pc?.getSenders().forEach((s) => {
        try {
          s.track?.stop();
        } catch {
          /* noop */
        }
      });
      this.pc?.close();
    } catch {
      /* noop */
    }
    try {
      this.audio.pause();
      this.audio.srcObject = null;
    } catch {
      /* noop */
    }
  }
}

/** 전송 만들기 — 개발 빌드 + 가짜 스위치면 가짜 전송(동적 import — production 번들에서 빠진다), 아니면 WebRTC */
export async function createTalkTransport(mic: MediaStream, audio: HTMLAudioElement): Promise<TalkTransport> {
  if (process.env.NODE_ENV !== "production" && readTalkDebugFake()) {
    const mod = await import("./talk-fake-transport");
    return mod.createFakeTalkTransport();
  }
  return new WebRtcTalkTransport(mic, audio);
}

// ===========================================================================
// 스냅숏 — 화면이 그리는 것
// ===========================================================================

/** finishing = 끝내기를 눌렀고(또는 5분 마무리가 끝났고) 아직 전사 중인 은우 줄을 최대 2.5초 기다리는 중 */
export type TalkPhase = "connecting" | "live" | "wrapping" | "finishing" | "ended";
export type TalkEndReason = "user" | "time" | "hidden" | "error" | "disconnected";
/** 전사를 기다렸다 끝낼 수 있는 사유 — 끝내기 버튼·5분 마무리 뒤 종료만(숨김·끊김·오류는 즉시) */
export type TalkFinishReason = Extract<TalkEndReason, "user" | "time">;

export interface TalkSceneView {
  /** loading = 만드는 중 · ready = 도착 · failed = 실패·키 없음·대화가 먼저 끝남(칸을 숨긴다) */
  status: "loading" | "ready" | "failed";
  /**
   * 화면에 띄웠다 — 대화 중(연결 중 포함)·마무리 전에 도착했을 때만 true(§12-6). 마무리 중에 도착한 그림은 ready지만 false —
   * 띄우지 않고 저장에만 싣는다(QA english_talk_1 P2-3).
   */
  shown: boolean;
  dataUrl: string | null;
  sceneEn: string | null;
}

export interface TalkUsage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface TalkSnapshot {
  phase: TalkPhase;
  lines: readonly TalkLine[];
  hints: TalkHintsView;
  teacherSpeaking: boolean;
  childSpeaking: boolean;
  /** 선생님 응답을 만드는 중(소리가 나기 전) — "선생님이 생각하는 중…" */
  responding: boolean;
  /** 큰 그림 카드(가장 최근 show_picture) */
  picture: TalkCard | null;
  /** 작은 칩 — 지난 카드(최근 것부터, 최대 TALK_CARD_LIMITS.recentChips) */
  recentCards: readonly TalkCard[];
  /** 단어장 모드 "오늘의 단어" — 주제 스냅샷 단어(연결 뒤에만) */
  todayWords: readonly { en: string; ko: string | null }[];
  /** 연습한(그림 카드로 나온) 오늘의 단어 — 목록에 적힌 en 그대로 */
  practiced: readonly string[];
  scene: TalkSceneView;
  /** 5분 상한 시각(epoch ms) — 연결 뒤에만 */
  capAtMs: number | null;
  endReason: TalkEndReason | null;
  errorKo: string | null;
  /** 연결 정보(모델·음성·주제) — 연결 성공 뒤 */
  topicLabelKo: string | null;
  usage: TalkUsage;
  fake: boolean;
  timescale: number;
}

// ===========================================================================
// 컨트롤러
// ===========================================================================

export interface TalkCallOptions {
  topic: TalkTopicRequest;
  speed: TalkSpeed;
  notes: TalkAppNotes;
  /** 탭 안에서 동기로 시작한 마이크 획득(acquireMicStream) */
  micPromise: Promise<MicStreamHandle>;
  /** 원격 소리를 낼 요소(탭 안에서 play()로 재생 준비를 마친 것) */
  audio: HTMLAudioElement;
  /** 시작 화면이 고른 주제의 한국어 라벨(연결 전 헤더 표시용) */
  labelKo: string;
}

/** 마이크 실패 → 대화 화면 안내(녹음 문구 대신 전화 문구로) */
function talkMicErrorKo(err: unknown): string {
  const kind = err instanceof MicError ? err.kind : "failed";
  switch (kind) {
    case "denied":
      return "마이크를 쓸 수 있게 허용해 주세요. 브라우저 설정에서 마이크를 허용한 뒤 다시 걸어 볼까요?";
    case "unsupported":
      return "이 브라우저에서는 마이크를 쓸 수 없어요(https 주소·최신 브라우저에서 해 주세요).";
    case "no_device":
      return "마이크를 찾지 못했어요. 이어폰 마이크가 연결돼 있는지 확인해 주세요.";
    case "busy":
      return "다른 앱이 마이크를 쓰고 있어요. 그 앱을 닫고 다시 걸어 볼까요?";
    case "timeout":
      return "마이크가 응답하지 않아요. 권한 창이 떠 있었다면 허용한 뒤 다시 걸어 주세요.";
    default:
      return "마이크를 열지 못했어요. 잠시 후 다시 걸어 볼까요?";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

// 끝내기 전 전사 기다림(finishing)에 보내는 클라이언트 이벤트 — 모양은 설치된 SDK(openai 7.4.0) GA 타입으로 검사된다
/** 서버 턴 감지 끄기 — 새 은우 차례(자동 커밋)·자동 응답(create_response)이 생기지 않는다. 바꾸는 필드만 보낸다(부분 갱신) */
const TALK_VAD_OFF_EVENT = {
  type: "session.update",
  session: { type: "realtime", audio: { input: { turn_detection: null } } },
} as const satisfies SessionUpdateEvent;
/** 지금까지의 은우 소리를 커밋 → 전사(응답은 만들지 않는다 — SDK 주석). 은우가 말하는 중일 때만 보낸다 */
const TALK_COMMIT_EVENT = { type: "input_audio_buffer.commit" } as const satisfies InputAudioBufferCommitEvent;
/** 진행 중 응답 취소 */
const TALK_CANCEL_EVENT = { type: "response.cancel" } as const satisfies ResponseCancelEvent;
/** 재생 중인 선생님 소리 비우기(WebRTC 전용 — response.cancel 뒤에 보낸다, SDK 주석) */
const TALK_AUDIO_CLEAR_EVENT = { type: "output_audio_buffer.clear" } as const satisfies OutputAudioBufferClearEvent;

/** 시각(epoch ms) — 테스트가 바꾸지 않는다(화면 시계와 같은 기준) */
const nowMs = () => Date.now();

export class TalkCallController {
  private readonly opts: TalkCallOptions;
  /** 저장 멱등 키(QA english_talk_1 P2-1) — 대화 한 번에 하나. 저장 본문의 clientSessionId(스토어가 문서 id로 쓴다) */
  readonly saveId: string = newTalkSaveId();
  private readonly timescale: number;
  private readonly fake: boolean;
  private transport: TalkTransport | null = null;
  private mic: MicStreamHandle | null = null;
  private listeners = new Set<() => void>();

  private phase: TalkPhase = "connecting";
  private transcript: TalkTranscriptState = createTalkTranscript();
  private hints: TalkHintsState;
  private info: TalkConnectSuccess | null = null;
  private endReason: TalkEndReason | null = null;
  private errorKo: string | null = null;

  private startedAtIso: string | null = null;
  private endedAtIso: string | null = null;
  private capAtMs: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  // 선생님 소리·응답 진행 상태
  private teacherSpeaking = false;
  private childSpeaking = false;
  private responseActive = false;
  /** 우리가 response.create를 보냈고 아직 response.created를 못 받았다(보낸 시각) */
  private awaitingCreatedSince: number | null = null;
  private pendingNudge = false;
  private pendingSceneNote = false;
  /** 이어 말하기 연속 셈(lib/talk-cards.ts `stepTalkContinue` — 은우 발화로만 0, 상한 TALK_CONTINUE_CHAIN_MAX) */
  private continueChain = 0;
  private noteSeq = 0;

  // 도구 호출
  private shownCallIds = new Set<string>();
  private answeredCallIds = new Set<string>();
  private picture: TalkCard | null = null;
  private recentCards: TalkCard[] = [];
  private shownCards: TalkCard[] = [];
  private practiced: string[] = [];

  // 마무리
  private wrapRequestedAt: number | null = null;
  private wrapupSentAt: number | null = null;
  private wrapupCancelSent = false;
  private wrapupResponseId: string | null = null;

  // 끝내기 전 전사 기다림(finishing)
  /** 지금 말하는 중인 은우 항목(speech_started의 item_id — speech_stopped에서 비운다) */
  private childSpeechItemId: string | null = null;
  /** 커밋된 은우 항목(input_audio_buffer.committed) — 수동 커밋이 새 항목을 만들었을 때 옛 줄을 버릴지 판정 */
  private committedItemIds = new Set<string>();
  private finishing: {
    reason: TalkFinishReason;
    /** 전사 완료를 기다리는 은우 줄 */
    pending: Set<string>;
    /** 수동 커밋을 보냈을 때 그 순간 말하던 항목(아니면 null) */
    committedSpeechId: string | null;
    timer: ReturnType<typeof setTimeout>;
    /** 선생님 소리 요소의 원래 음소거 값(end에서 되돌린다 — 요소는 다음 대화가 다시 쓴다) */
    prevMuted: boolean;
  } | null = null;

  // 주제 일러스트
  private scene: TalkSceneView = { status: "loading", shown: false, dataUrl: null, sceneEn: null };
  private sceneNote: string | null = null;
  private sceneNoted = false;
  private sceneAbort = new AbortController();

  private usage: TalkUsage = { responses: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  private snapshot: TalkSnapshot;
  private disposed = false;

  constructor(opts: TalkCallOptions) {
    this.opts = opts;
    this.timescale = readTalkDebugTimescale();
    this.fake = readTalkDebugFake();
    this.hints = createTalkHints(talkHintTimings(this.timescale));
    this.snapshot = this.buildSnapshot();
  }

  // ---- 구독(useSyncExternalStore) ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): TalkSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 구독자 예외는 컨트롤러를 깨지 않는다 */
      }
    }
  }

  private buildSnapshot(): TalkSnapshot {
    const words = this.info?.topic.kind === "vocab" ? this.info.topic.words : [];
    return {
      phase: this.phase,
      lines: this.transcript.lines,
      hints: viewTalkHints(this.hints),
      teacherSpeaking: this.teacherSpeaking,
      childSpeaking: this.childSpeaking,
      responding: this.phase === "live" && this.responseActive && !this.teacherSpeaking && !this.childSpeaking,
      picture: this.picture,
      recentCards: this.recentCards,
      todayWords: words,
      practiced: this.practiced,
      scene: this.scene,
      capAtMs: this.capAtMs,
      endReason: this.endReason,
      errorKo: this.errorKo,
      topicLabelKo: this.info?.topic.labelKo ?? this.opts.labelKo,
      usage: this.usage,
      fake: this.fake,
      timescale: this.timescale,
    };
  }

  // ---- 시작 ----

  /** 비동기 사이에 끝났는가(await 뒤 좁히기를 피하려고 메서드로 읽는다) */
  private isEnded(): boolean {
    return this.phase === "ended";
  }

  /**
   * 시작 — 마이크 기다림 → 주제 일러스트(연결과 병렬) + 연결. 실패는 end("error")로 접는다(던지지 않는다).
   * 일러스트 요청은 마이크를 얻은 **뒤**에 보낸다(QA english_talk_1 P2-4) — 권한 거부·마이크 실패·기다리는 사이 끝남에는 생성 요청이
   * 나가지 않는다(자동으로 도는 비용 0, SPEC §21-4). 연결 실패로 끝나면 end()가 진행 중인 요청을 abort한다.
   */
  async start(): Promise<void> {
    let mic: MicStreamHandle;
    try {
      mic = await this.opts.micPromise;
    } catch (err) {
      this.fail(talkMicErrorKo(err));
      return;
    }
    if (this.isEnded()) {
      mic.release(); // 기다리는 사이에 끝났다(숨김·끝내기)
      return;
    }
    this.mic = mic;
    void this.loadScene();
    try {
      this.transport = await createTalkTransport(mic.stream, this.opts.audio);
    } catch {
      this.fail("대화 연결을 준비하지 못했어요.");
      return;
    }
    if (this.isEnded()) {
      this.transport.close();
      return;
    }
    try {
      const info = await this.transport.connect(
        { topic: this.opts.topic, speed: this.opts.speed },
        {
          onEvent: (ev) => this.onServerEvent(ev),
          onOpen: () => this.onOpen(),
          onDisconnect: () => this.onDisconnect(),
        },
      );
      if (this.isEnded()) {
        this.transport.close();
        return;
      }
      this.info = info;
      this.emit();
    } catch (err) {
      const msg = err instanceof TalkConnectError ? err.messageKo : "선생님과 연결하지 못했어요. 잠시 후 다시 걸어 볼까요?";
      this.fail(msg);
    }
  }

  /**
   * 주제 일러스트 — 연결과 병렬(비치명). 도착하면 대화 중(연결 중 포함)·마무리 전일 때만 띄우고(shown) 선생님에게 알린다(§12-6).
   * 마무리 중에 도착하면 띄우지도 알리지도 않고 저장 본문에만 싣는다(대화 보기에서 보인다 — QA english_talk_1 P2-3).
   */
  private async loadScene(): Promise<void> {
    try {
      const res = await fetch("/api/english/talk/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: this.opts.topic }),
        signal: this.sceneAbort.signal,
      });
      const data = (await res.json().catch(() => null)) as TalkSceneResponse | null;
      if (this.disposed) return;
      if (!data || !data.ok) {
        this.scene = { status: "failed", shown: false, dataUrl: null, sceneEn: null };
        this.emit();
        return;
      }
      if (this.phase === "ended") return; // 대화가 먼저 끝났다(end가 이미 failed로 접었다) — 저장 본문이 바뀌지 않게
      const shown = this.phase === "connecting" || this.phase === "live";
      this.scene = { status: "ready", shown, dataUrl: data.dataUrl, sceneEn: data.sceneEn };
      this.sceneNote = data.note;
      if (this.phase === "live") this.sendSceneNote();
      this.emit();
    } catch {
      if (this.disposed) return;
      if (this.scene.status === "loading") {
        this.scene = { status: "failed", shown: false, dataUrl: null, sceneEn: null };
        this.emit();
      }
    }
  }

  private onOpen(): void {
    if (this.phase !== "connecting") return;
    this.phase = "live";
    const now = nowMs();
    this.startedAtIso = new Date(now).toISOString();
    this.capAtMs = now + TALK_MAX_DURATION_SEC * 1000 * this.timescale;
    this.tickTimer = setInterval(() => this.onTick(), TALK_TICK_MS);
    // 선생님이 먼저 말한다 — 숨은 system 메시지 + response.create(인자 없음, §12-1)
    this.sendNote("app_greet", this.opts.notes.greeting);
    this.sendResponseCreate();
    if (this.scene.status === "ready") this.sendSceneNote();
    this.emit();
  }

  private onDisconnect(): void {
    if (this.phase === "ended") return;
    this.end("disconnected");
  }

  private fail(messageKo: string): void {
    if (this.phase === "ended") return;
    this.errorKo = messageKo;
    this.end("error");
  }

  // ---- 보내기 ----

  private send(ev: object): void {
    this.transport?.send(ev);
  }

  private nextNoteId(prefix: string): string {
    this.noteSeq += 1;
    return `${prefix}_${this.noteSeq}`;
  }

  private sendNote(id: string, text: string): void {
    this.send(buildTalkSystemNoteEvent(id, text));
  }

  private sendResponseCreate(): void {
    // 진행 중 응답 표시는 response.created가 켠다 — 여기서 미리 켜 두면 created가 오기 전 두 번째 요청을 막는다.
    // 서버가 요청을 거부해(error 이벤트) created가 끝내 안 오면 tick이 RESPONSE_CREATED_WAIT_MS 뒤에 푼다(영영 보류되지 않게).
    this.responseActive = true;
    this.awaitingCreatedSince = nowMs();
    this.send(buildTalkResponseCreateEvent());
  }

  private sendSceneNote(): void {
    if (this.sceneNoted || !this.sceneNote || this.phase !== "live") return;
    if (this.responseActive) {
      this.pendingSceneNote = true; // 응답이 끝나면 넣는다(보수적 — 진행 중 응답에 끼우지 않는다)
      return;
    }
    this.sceneNoted = true;
    this.pendingSceneNote = false;
    this.sendNote("app_scene", this.sceneNote); // response.create 없음(§12-6)
  }

  private requestNudge(): void {
    if (this.phase !== "live") return;
    if (this.responseActive) {
      this.pendingNudge = true;
      return;
    }
    this.sendNudgeNow();
  }

  private sendNudgeNow(): void {
    this.pendingNudge = false;
    this.sendNote(this.nextNoteId("app_nudge"), this.opts.notes.nudge);
    this.sendResponseCreate();
  }

  // ---- 도움 상태 기계 ----

  private applyHints(ev: TalkHintsEvent): void {
    const next = reduceTalkHints(this.hints, ev);
    if (next === this.hints) return;
    this.hints = next;
    if (viewTalkHints(next).shouldNudge) this.requestNudge();
  }

  /** 🙋 도와줘요 */
  helpTapped(): void {
    if (this.phase !== "live") return;
    this.applyHints({ type: "help_tapped", now: nowMs() });
    this.emit();
  }

  // ---- 서버 이벤트 ----

  private onServerEvent(ev: unknown): void {
    if (this.phase === "ended" || !isRec(ev)) return;
    const now = nowMs();
    const type = typeof ev.type === "string" ? ev.type : "";

    // 1) 스크립트 리듀서(순수 — 모르는 이벤트는 같은 상태)
    this.transcript = reduceTalkTranscript(this.transcript, ev);

    // 이어 말하기 셈(§12-6 — 판정은 lib/talk-cards.ts 한 곳): 은우 발화 → 0, response.done → 보낼지. 말한 글자가 response.done에
    // 없으면 방금 리듀서가 모은 선생님 줄로 대신 본다
    const cont = stepTalkContinue(this.continueChain, ev, this.phase === "live", (itemId) => this.teacherLineText(itemId));
    this.continueChain = cont.chain;

    // 2) 소리·말하기 상태
    if (type === "output_audio_buffer.started") this.teacherSpeaking = true;
    if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
      this.teacherSpeaking = false;
      this.onTeacherAudioStopped(typeof ev.response_id === "string" ? ev.response_id : null);
    }
    if (type === "input_audio_buffer.speech_started") {
      this.childSpeaking = true;
      this.childSpeechItemId = typeof ev.item_id === "string" ? ev.item_id : null;
      this.pendingNudge = false; // 은우가 말을 시작했다 — 보류한 도움 요청은 버린다
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.childSpeaking = false;
      this.childSpeechItemId = null;
    }
    if (type === "input_audio_buffer.committed" && typeof ev.item_id === "string") this.onCommitted(ev.item_id);

    // 끝내기 전 전사 기다림 — 턴 감지 끄기보다 먼저 시작된 응답은 그 자리에서 끊는다(두 겹), 새 소리도 비운다
    if (this.phase === "finishing") {
      if (type === "response.created") this.send(TALK_CANCEL_EVENT);
      if (type === "output_audio_buffer.started") this.send(TALK_AUDIO_CLEAR_EVENT);
    }

    // 3) 도움 상태 기계
    const hintEv = talkHintEventFromServer(ev, now);
    if (hintEv) this.applyHints(hintEv);

    // 4) 응답 진행
    if (type === "response.created") {
      this.responseActive = true;
      this.awaitingCreatedSince = null;
      const rid = isRec(ev.response) && typeof ev.response.id === "string" ? ev.response.id : null;
      if (this.wrapupSentAt !== null && this.wrapupResponseId === null && rid) this.wrapupResponseId = rid;
    }

    // 5) 도구 호출 표시(callId로 한 번만)
    for (const ref of extractTalkFunctionCalls(ev)) {
      if (this.shownCallIds.has(ref.callId)) continue;
      this.shownCallIds.add(ref.callId);
      if (this.phase !== "live") continue; // 마무리 중 도구 호출은 무시(§12-6)
      const call = parseTalkToolCall(ref.name, ref.argumentsJson);
      if (!call) continue;
      if (call.name === "show_hints") this.applyHints({ type: "hints_received", now, hints: call.hints });
      else this.showPicture(call.card);
    }

    if (type === "response.done" && cont.summary) this.onResponseDone(ev, cont.summary, cont.send);

    // 기다리던 은우 줄의 전사가 다 왔으면 지금 끝낸다(end가 스냅숏을 알린다)
    const fin = this.finishing;
    if (this.phase === "finishing" && fin && this.finishResolved(fin.pending)) {
      this.end(fin.reason);
      return;
    }
    this.emit();
  }

  /**
   * 은우 소리가 커밋됐다. 끝내기 전 기다림에서 우리가 수동 커밋을 보냈는데 말하던 항목(speech_started의 id)과 **다른** 항목으로
   * 커밋됐으면(턴 감지를 끄면 서버가 새 항목을 만들 수 있다) 기다릴 줄을 새 항목으로 바꾼다 — 옛 줄은 커밋되지 않았으면 전사가 영영
   * 오지 않는다(저장에서는 글자 없는 줄이라 빠진다). 옛 줄이 이미 커밋돼 있었으면(서버 VAD가 먼저 커밋) 둘 다 기다린다.
   */
  private onCommitted(itemId: string): void {
    const fin = this.finishing;
    if (this.phase === "finishing" && fin && fin.committedSpeechId !== null && itemId !== fin.committedSpeechId && !fin.pending.has(itemId)) {
      if (!this.committedItemIds.has(fin.committedSpeechId)) fin.pending.delete(fin.committedSpeechId);
      fin.pending.add(itemId);
    }
    this.committedItemIds.add(itemId);
  }

  /** 기다리던 은우 줄이 모두 전사 완료(final·empty·failed)인가 — 줄이 아직 안 생긴 새 항목은 기다린다 */
  private finishResolved(pending: ReadonlySet<string>): boolean {
    for (const id of pending) {
      const line = this.transcript.lines.find((l) => l.itemId === id);
      if (!line || line.status === "listening" || line.status === "partial") return false;
    }
    return true;
  }

  private showPicture(card: TalkCard): void {
    const key = card.en.toLowerCase();
    const prev = this.picture;
    if (prev && prev.en.toLowerCase() !== key) {
      // 지난 큰 카드를 칩 맨 앞으로(같은 영어는 한 장만, 새 큰 카드와 같은 칩은 뺀다) — 최근 것부터 최대 6장
      const prevKey = prev.en.toLowerCase();
      this.recentCards = [prev, ...this.recentCards.filter((c) => c.en.toLowerCase() !== key && c.en.toLowerCase() !== prevKey)].slice(
        0,
        TALK_CARD_LIMITS.recentChips,
      );
    } else if (!prev) {
      this.recentCards = this.recentCards.filter((c) => c.en.toLowerCase() !== key);
    }
    this.picture = card;
    if (!this.shownCards.some((c) => c.en.toLowerCase() === key) && this.shownCards.length < TALK_CARD_LIMITS.savedCardsMax) {
      this.shownCards = [...this.shownCards, card];
    }
    const words = this.info?.topic.kind === "vocab" ? this.info.topic.words : [];
    const hit = words.length > 0 ? matchTalkWord(card.en, words) : null;
    if (hit && !this.practiced.includes(hit)) this.practiced = [...this.practiced, hit];
  }

  /** 선생님 줄의 글자(스크립트 리듀서가 모은 것) — 없거나 비었으면 null */
  private teacherLineText(itemId: string): string | null {
    const line = this.transcript.lines.find((l) => l.itemId === itemId && l.speaker === "teacher");
    return line && line.text !== "" ? line.text : null;
  }

  /** `continueSend` = stepTalkContinue의 판정(대화 중·도구·정상 완료·질문 없음·연속 상한 아래) */
  private onResponseDone(ev: Rec, summary: TalkResponseDoneSummary, continueSend: boolean): void {
    this.responseActive = false;
    this.awaitingCreatedSince = null;

    // 사용량(진단 — 서버 로그 없이 화면에서 본다, SPEC §21-4)
    const usage = isRec(ev.response) && isRec(ev.response.usage) ? ev.response.usage : null;
    if (usage) {
      const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const details = isRec(usage.input_token_details) ? usage.input_token_details : null;
      const cached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
      this.usage = {
        responses: this.usage.responses + 1,
        inputTokens: this.usage.inputTokens + inTok,
        outputTokens: this.usage.outputTokens + outTok,
        cachedTokens: this.usage.cachedTokens + cached,
      };
    }

    // 마무리 응답이 오디오 없이 끝났으면 바로 끝낸다
    if (this.phase === "wrapping") {
      if (this.wrapupSentAt !== null && summary.responseId !== null && summary.responseId === this.wrapupResponseId && !summary.hadAudio) {
        this.finish("time");
      }
      return; // 마무리 중에는 도구 결과·이어 말하기·도움 요청 없음
    }
    if (this.phase !== "live") return;

    // 호출 결과(호출마다 한 번, id app_out_n)
    for (const call of summary.functionCalls) {
      if (this.answeredCallIds.has(call.callId)) continue;
      this.answeredCallIds.add(call.callId);
      this.send(buildTalkToolOutputEvent(call.callId, this.nextNoteId("app_out")));
    }

    if (this.pendingSceneNote) this.sendSceneNote();

    // 선생님이 방금 말했다(새 차례) — 지난 차례의 도움 요청은 버린다(이어 말하기와 상관없이)
    if (this.pendingNudge && summary.hadAudio) this.pendingNudge = false;

    if (continueSend) {
      // 도구를 부르고 질문 없이 끝났다 — 이어 말하게(질문을 했으면 은우 차례라 보내지 않는다). 셈은 stepTalkContinue가 이미 올렸다.
      // 보류한 도움 요청(오디오 없는 응답일 때만 남아 있다)은 같은 응답에 싣는다
      if (this.pendingNudge) {
        this.pendingNudge = false;
        this.sendNote(this.nextNoteId("app_nudge"), this.opts.notes.nudge);
      }
      this.sendResponseCreate();
      return;
    }
    if (this.pendingNudge) this.sendNudgeNow();
  }

  private onTeacherAudioStopped(responseId: string | null): void {
    if (this.phase === "wrapping" && this.wrapupSentAt !== null && responseId !== null && responseId === this.wrapupResponseId) {
      this.finish("time"); // 작별 인사 소리가 끝났다(아직 전사 중인 은우 줄이 있으면 최대 2.5초 기다린다)
    }
  }

  // ---- 시계 ----

  private onTick(): void {
    if (this.phase === "ended") return;
    const now = nowMs();
    if (this.awaitingCreatedSince !== null && now - this.awaitingCreatedSince >= RESPONSE_CREATED_WAIT_MS) {
      // 보낸 response.create에 응답이 시작되지 않았다(거부·유실) — 진행 중 표시를 푼다
      this.awaitingCreatedSince = null;
      this.responseActive = false;
    }
    this.applyHints({ type: "tick", now });

    if (this.phase === "live" && this.capAtMs !== null && now >= this.capAtMs) this.beginWrapup(now);

    if (this.phase === "wrapping") {
      if (this.wrapupSentAt === null) {
        const waited = now - (this.wrapRequestedAt ?? now);
        const waitMax = TALK_WRAPUP_WAIT_MS * this.timescale;
        const teacherDone = !this.teacherSpeaking || waited >= waitMax;
        if (teacherDone && !this.responseActive) {
          // 보내기 **전에** 표시한다 — response.created가 곧바로(같은 호출 안에서) 되돌아와도(개발용 가짜 전송) 그 응답을 마무리 응답으로
          // 알아보게(wrapupResponseId). 늦게 세우면 작별 인사 소리가 멈춰도 끝나지 않고 25초 상한까지 간다.
          this.wrapupSentAt = now;
          this.sendNote("app_wrapup", this.opts.notes.wrapup);
          this.sendResponseCreate();
        } else if (teacherDone && this.responseActive && waited >= waitMax && !this.wrapupCancelSent) {
          // 진행 중 응답이 오래 끈다 — 끊고(response.done cancelled가 오면) 다음 tick에 마무리를 보낸다
          this.wrapupCancelSent = true;
          this.send(TALK_CANCEL_EVENT);
        } else if (waited >= waitMax * 3) {
          this.finish("time"); // 응답이 끝내 끝나지 않는다 — 더 기다리지 않는다
        }
      } else if (now - this.wrapupSentAt >= TALK_WRAPUP_END_MS * this.timescale) {
        this.finish("time");
      }
    }
    this.emit();
  }

  private beginWrapup(now: number): void {
    if (this.phase !== "live") return;
    this.phase = "wrapping";
    this.wrapRequestedAt = now;
    this.pendingNudge = false;
    this.applyHints({ type: "wrapup_started", now });
  }

  // ---- 끝내기 ----

  /**
   * 끝내기 버튼·5분 마무리 뒤 종료 — 아직 전사 중인 은우 줄(listening·partial)이 있으면 그 전사를 **최대 2.5초** 기다린 뒤 끝내고,
   * 없으면(또는 연결 전이면) 바로 end()한다. 기다리는 동안의 처리는 `beginFinishing`. 숨김·뒤로가기·pagehide는 이것을 쓰지 않고
   * end()를 바로 부른다(기다리는 중이어도 즉시 닫힌다).
   */
  finish(reason: TalkFinishReason): void {
    if (this.phase === "ended" || this.phase === "finishing") return;
    const pending = new Set<string>();
    if (this.phase !== "connecting") {
      for (const l of this.transcript.lines) {
        if (l.speaker === "child" && (l.status === "listening" || l.status === "partial")) pending.add(l.itemId);
      }
    }
    if (pending.size === 0) {
      this.end(reason);
      return;
    }
    this.beginFinishing(reason, pending);
  }

  /**
   * 전사 기다림 시작 — ① 마이크 트랙을 끈다(enabled=false: 무음 프레임. 트랙 stop·세션 전환은 end()의 release가 한다)
   * ② 서버 턴 감지를 끈다(session.update turn_detection null — 새 은우 차례·자동 응답이 생기지 않는다) ③ 은우가 말하는 중이었으면
   * 지금까지의 소리를 커밋한다(턴 감지가 꺼지면 서버가 스스로 커밋하지 않는다. 말하는 중이 아니면 보내지 않는다 — 침묵을 커밋하면
   * 전사가 없는 말을 지어낼 수 있다) ④ 진행 중 응답 취소 + 재생 중 소리 비우기 + 선생님 소리 음소거 ⑤ 2.5초 상한 타이머.
   * 도움 요청·일러스트 안내는 `phase !== "live"`라 더 나가지 않는다. 늦게 시작된 응답은 onServerEvent가 취소한다(두 겹).
   */
  private beginFinishing(reason: TalkFinishReason, pending: Set<string>): void {
    this.phase = "finishing";
    this.endedAtIso = new Date().toISOString(); // 대화가 끝난 시각은 끝내기를 누른 때다(기다린 시간은 대화가 아니다)
    this.pendingNudge = false;
    this.pendingSceneNote = false;
    try {
      for (const t of this.mic?.stream.getAudioTracks() ?? []) t.enabled = false;
    } catch {
      /* noop */
    }
    let prevMuted = false;
    try {
      prevMuted = this.opts.audio.muted;
      this.opts.audio.muted = true;
    } catch {
      /* noop */
    }
    // 판정은 보내기 전에 한 번에 읽고, 기다림 상태도 보내기 전에 세운다 — 전송이 응답 이벤트를 곧바로(같은 호출 안에서) 되돌려도
    // (개발용 가짜 전송) 커밋 항목 바꿔 치기·상태 판정이 어긋나지 않게
    const speechId = this.childSpeaking ? this.childSpeechItemId : null;
    const wasResponding = this.responseActive;
    const wasSpeaking = this.teacherSpeaking;
    const timer = setTimeout(() => this.end(reason), TALK_FINISH_TRANSCRIPT_WAIT_MS);
    this.finishing = { reason, pending, committedSpeechId: speechId, timer, prevMuted };
    this.send(TALK_VAD_OFF_EVENT);
    if (speechId !== null) this.send(TALK_COMMIT_EVENT);
    if (wasResponding) this.send(TALK_CANCEL_EVENT);
    if (wasSpeaking) this.send(TALK_AUDIO_CLEAR_EVENT);
    if (this.phase === "finishing") this.emit();
  }

  /**
   * 끝내기(멱등) — 연결 닫기 → 마이크 놓기 → 서버 hangup(sendBeacon). 저장은 화면이 getSavePayload()로 한다.
   * 전사를 기다리는 중(finishing)에 불리면(전사 도착·2.5초 상한·숨김·뒤로가기·끊김) 사유는 기다림을 시작한 사유(끝내기·5분)로 남긴다.
   */
  end(reason: TalkEndReason): void {
    if (this.phase === "ended") return;
    const fin = this.finishing;
    this.finishing = null;
    this.phase = "ended";
    this.endReason = fin ? fin.reason : reason;
    if (!fin || this.endedAtIso === null) this.endedAtIso = new Date().toISOString();
    if (fin) clearTimeout(fin.timer);
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.scene.status === "loading") {
      this.sceneAbort.abort(); // 대화가 먼저 끝났다 — 그림 생성도 멈춘다(그림 없이 저장)
      this.scene = { status: "failed", shown: false, dataUrl: null, sceneEn: null };
    }
    try {
      this.transport?.close();
    } catch {
      /* noop */
    }
    if (fin) {
      try {
        this.opts.audio.muted = fin.prevMuted; // 닫은 뒤에 되돌린다 — 소리 요소는 시작 화면이 다음 대화에 다시 쓴다
      } catch {
        /* noop */
      }
    }
    try {
      this.mic?.release(); // 트랙 stop → activeCaptures-- → playback(lib/mic-session.ts)
    } catch {
      /* noop */
    }
    this.hangupBeacon();
    this.emit();
  }

  private hangupBeacon(): void {
    const callId = this.info?.callId;
    if (!callId || typeof window === "undefined") return;
    const body = JSON.stringify({ callId });
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        if (navigator.sendBeacon(TALK_HANGUP_URL, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
      }
    } catch {
      /* 아래 fetch로 */
    }
    void fetch(TALK_HANGUP_URL, { method: "POST", body, keepalive: true }).catch(() => {});
  }

  /**
   * 저장 본문 — 연결이 안 됐거나 은우 발화가 0이면 null(저장하지 않는다, SPEC §21-2 5). 몇 번을 불러도 같은 멱등 키
   * (`clientSessionId` = saveId)가 실린다 — 다시 저장·화면 복귀 재시도·뒤로가기 정리가 겹쳐도 대화는 하나다(QA english_talk_1 P2-1).
   */
  getSavePayload(): TalkSaveRequest | null {
    if (!this.info || !this.startedAtIso) return null;
    const turns = toTalkTurns(this.transcript.lines);
    if (childTurnCount(turns) < 1) return null;
    const scene =
      this.scene.status === "ready" && this.scene.dataUrl && this.scene.sceneEn ? { dataUrl: this.scene.dataUrl, sceneEn: this.scene.sceneEn } : null;
    return {
      clientSessionId: this.saveId,
      topic: this.info.topic,
      turns,
      cards: this.shownCards,
      scene,
      startedAt: this.startedAtIso,
      endedAt: this.endedAtIso ?? new Date().toISOString(),
      model: this.info.model,
      voice: this.info.voice,
    };
  }

  /** 은우가 한마디라도 했는가(끝난 뒤 "다음엔 한마디 해 볼까요?" 분기) */
  childSpoke(): boolean {
    return childTurnCount(toTalkTurns(this.transcript.lines)) > 0;
  }

  /** 화면을 닫을 때 — 끝나지 않았으면 끝내고 구독을 끊는다 */
  dispose(): void {
    if (this.phase !== "ended") this.end("user");
    this.disposed = true;
    this.sceneAbort.abort();
    this.listeners.clear();
  }
}

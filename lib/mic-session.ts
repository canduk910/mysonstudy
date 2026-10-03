/**
 * lib/mic-session.ts — 녹음 **단일 관문** (클라이언트 전용) (docs/harness/toeic.md §5-0·§6-4, _workspace/understand_toeic_audio.md)
 *
 * 저장소 첫 녹음 경로다. 오디오 세션 전환·getUserMedia·MediaRecorder·레벨 미터·WAV 정규화를 **여기 한 곳**에 둔다 — 특히
 * `navigator.audioSession.type`을 바꾸는 코드는 이 모듈 밖에 두지 않는다(순서를 어기면 녹음이 끊긴다).
 *
 * ── 재생과 캡처를 시간상 겹치지 않는다(§6-4, 전략 A: 답변마다 획득·해제) ───────────────
 *   녹음 직전: audioSession.type = "play-and-record" → getUserMedia → MediaRecorder.start()
 *   답변 타이머는 recorder "start" 이벤트에서 시작한다(`started` 약속 — 권한·장치 지연만큼 답변 시간을 잃지 않게)
 *   끝: recorder.stop() → 모든 트랙 stop() → **그다음에** "playback"
 *   ⚠️ 녹음 중에 "playback"으로 바꾸면 마이크 트랙이 끝난다(W3C Audio Session: play-and-record·auto가 아니면 end track).
 *      그래서 녹음 중(activeCaptures > 0)에는 setAudioSessionPlayback()이 아무것도 하지 않는다.
 *   녹음하지 않는 구간(질문 음성·준비·비프)은 "playback" — iOS에서 Web Audio 비프가 무음 스위치에 묻히지 않고, 캡처가 끝난 뒤
 *   재생이 수화기로 가지 않게(WebKit 218012). Safari 16.4+만 이 API가 있다 — 없으면 조용히 넘어간다(기능 감지).
 *
 * ── 기다림에는 전부 상한이 있다(QA m2 P2-B) — 상한 상수는 아래 "상한" 절 한 곳 ────────────────
 *   getUserMedia가 끝내 답하지 않으면(iPhone에서 탭 밖 권한 창 등) activeCaptures가 새어 이후 모든 playback 복귀가 무시되고
 *   세션이 play-and-record에 갇힌다. 그래서 getUserMedia 대기(MIC_GUM_TIMEOUT_MS, 점검 탭은 MIC_CHECK_GUM_TIMEOUT_MS)가 넘으면
 *   activeCaptures를 되돌리고 playback으로 복귀한 뒤 MicError("timeout")를 던진다. **늦게 도착한 스트림은 트랙을 즉시 stop**한다.
 *   start 이벤트가 상한(MIC_START_TIMEOUT_MS) 안에 안 오거나 recorder 오류로 `started`가 거부되면 이 모듈이 스스로 버린다
 *   (트랙 stop → playback). 호출부의 abort()는 그 뒤에 불러도 한 번만 정리된다(멱등).
 *
 * ── 형식 ─────────────────────────────────────────────────────────────────────
 * - MediaRecorder 형식: Apple WebKit(iOS 전부·데스크톱 Safari)은 `audio/mp4` 우선(기기 안 다시 듣기 호환), 그 밖은 webm/opus.
 *   **실제 형식은 recorder.mimeType을 기록**한다(요청과 다를 수 있다 — 진단 캡션).
 * - start()에 timeslice를 주지 않는다 — 단일 Blob이 표준 mp4(moov 포함)라 decodeAudioData에 유리하다(조사 §4-4, 실기기 확인 항목).
 * - 채점 업로드 전 `toWav16kMono`: decodeAudioData(OfflineAudioContext) → mono → **선형 보간** 16kHz → 16-bit PCM WAV.
 *   iOS mp4가 전사 API에서 형식 오류·잘림을 내는 보고가 반복되고, 서버(buildpacks)에 ffmpeg가 없어서다(§5-0 1).
 *   리샘플은 OfflineAudioContext의 저샘플레이트 지원에 기대지 않고 JS로 한다. 60초 ≈ 1.92MB.
 *
 * ── 마이크 유지(`createMicKeeper`, 전략 B) — 토익 응시·틀 테스트(2026-10-03, SPEC §20-4) ─────────────
 *   iPhone(특히 홈 화면 앱)은 트랙을 모두 멈춘 뒤 다시 getUserMedia하면 권한 창을 또 띄운다. 그래서 정책이 "keep"이면 세션의
 *   첫 녹음에서 얻은 스트림을 세션 끝까지 쥐고(녹음 사이 track.enabled=false), 녹음마다 새 MediaRecorder만 만든다.
 *   쥔 동안 activeCaptures가 1이라 세션은 play-and-record에 머문다(playback으로 바꾸면 트랙이 끝난다 — W3C Audio Session).
 *   정책은 순수 함수 micKeepPolicyFor 하나 — Apple WebKit + navigator.audioSession(16.4+)에서만 keep, 그 밖은 전략 A(per-answer).
 *   놓기(release): 트랙 stop → activeCaptures-- → **그다음에** playback(위 규약 그대로). 트랙 ended면 버리고 다음 녹음이 다시 얻는다.
 *
 * ── 스트림만 잡기(`acquireMicStream`) — 은우 자유대화(2026-09-26) ───────────────────────────
 *   WebRTC 대화는 녹음기 없이 마이크 트랙을 **대화 내내** 보낸다(재생과 캡처가 겹친다 — 전략 A의 예외, SPEC §21-5 1).
 *   세션 전환·대기 상한·놓는 순서는 위 규약 그대로다: play-and-record → getUserMediaWithin → … → release(트랙 stop →
 *   activeCaptures-- → playback). 토익 녹음(startRecording)은 이 함수와 무관하게 그대로다.
 *
 * 순수 함수(mixToMono·resampleLinear·encodeWavPcm16·pickMimeTypeFrom)는 브라우저 전역 없이 돌아 eval이 잠근다.
 * ⚠️ 모듈 최상위에서 window·navigator를 읽지 않는다(SSR·eval import 안전). 런타임 import 0.
 */

// ===========================================================================
// 오디오 세션 (Safari 16.4+ `navigator.audioSession`)
// ===========================================================================

type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";

function audioSession(): { type: AudioSessionType } | null {
  if (typeof navigator === "undefined") return null;
  const s = (navigator as unknown as { audioSession?: { type: AudioSessionType } }).audioSession;
  return s && typeof s === "object" && "type" in s ? s : null;
}

/** 지금 캡처 중인 녹음 수 — 0보다 크면 세션을 playback으로 되돌리지 않는다(트랙이 끝난다) */
let activeCaptures = 0;
/** 마지막으로 건 세션 타입(진단용) */
let lastSessionType: AudioSessionType | null = null;

// ---------------------------------------------------------------------------
// 지금 누가 녹음하는가 — 녹음기(MediaRecorder) 단위 공유 신호 (2026-10-03, 표현 도우미 🎤 ↔ 토익 "고칠 문장 다시 녹음" 겹침 방지)
// activeCaptures는 마이크 유지(keep) 정책이 녹음 사이에도 1을 쥐므로 "지금 녹음 중"을 뜻하지 않는다. 그래서 녹음기가 실제로
// 돌기 시작한 순간 +1, 그 녹음이 끝나거나 버려질 때 -1을 따로 센다(recordOn 한 곳 — startRecording·keeper 두 경로 모두).
// 녹음을 시작하는 쪽은 `owner`(StartRecordingOptions)로 이름을 붙일 수 있다 — 구독자는 남이 시작한 녹음을 알아보고 자기 녹음을 끝낸다.
// ---------------------------------------------------------------------------

/** 지금 돌고 있는 녹음기 수와 각 이름(owner 없음 = null) */
const liveRecordings: (string | null)[] = [];
const recordingListeners = new Set<(ev: { type: "start" | "end"; owner: string | null }) => void>();

function emitRecording(type: "start" | "end", owner: string | null): void {
  for (const fn of [...recordingListeners]) {
    try {
      fn({ type, owner });
    } catch {
      /* 구독자 예외는 녹음을 깨지 않는다 */
    }
  }
}

/** 지금 돌고 있는 녹음기의 이름 목록(owner를 안 준 녹음은 null) — 시작 전에 "다른 녹음이 진행 중인가"를 본다 */
export function getLiveRecordingOwners(): (string | null)[] {
  return [...liveRecordings];
}

/** 녹음 시작·끝 알림 구독(해제 함수 반환). 알림은 녹음기 시작 직후·놓은 직후 동기로 온다 */
export function subscribeMicRecording(fn: (ev: { type: "start" | "end"; owner: string | null }) => void): () => void {
  recordingListeners.add(fn);
  return () => {
    recordingListeners.delete(fn);
  };
}

function setSessionType(t: AudioSessionType): boolean {
  const s = audioSession();
  if (!s) return false;
  try {
    if (s.type !== t) s.type = t;
    lastSessionType = t;
    return true;
  } catch {
    return false;
  }
}

/**
 * 녹음하지 않는 구간의 세션 — "playback". 응시 시작 탭·녹음 끝(트랙 stop **뒤**)이 부른다. 녹음 중이면 아무것도 하지 않고
 * false(바꾸면 트랙이 끝난다). 이 API가 없는 브라우저도 false.
 */
export function setAudioSessionPlayback(): boolean {
  if (activeCaptures > 0) return false;
  return setSessionType("playback");
}

// ===========================================================================
// 기능 감지
// ===========================================================================

export interface MicSupport {
  /** https·localhost — getUserMedia는 secure context에서만 */
  secureContext: boolean;
  getUserMedia: boolean;
  mediaRecorder: boolean;
  /** navigator.audioSession(Safari 16.4+) */
  audioSession: boolean;
  ok: boolean;
  /** ok가 아니면 화면에 보일 이유(한국어) */
  reasonKo: string | null;
}

export function detectMicSupport(): MicSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { secureContext: false, getUserMedia: false, mediaRecorder: false, audioSession: false, ok: false, reasonKo: "브라우저 밖이에요." };
  }
  const secureContext = window.isSecureContext !== false;
  const getUserMedia = Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
  const mediaRecorder = typeof window.MediaRecorder === "function";
  const session = audioSession() !== null;
  let reasonKo: string | null = null;
  if (!secureContext) reasonKo = "보안 연결(https)이 아니라 마이크를 쓸 수 없어요.";
  else if (!getUserMedia) reasonKo = "이 브라우저는 마이크를 쓸 수 없어요.";
  else if (!mediaRecorder) reasonKo = "이 브라우저는 녹음(MediaRecorder)을 지원하지 않아요.";
  return { secureContext, getUserMedia, mediaRecorder, audioSession: session, ok: reasonKo === null, reasonKo };
}

// ===========================================================================
// MediaRecorder 형식
// ===========================================================================

/** Apple WebKit(iOS 전부 — 모든 브라우저가 WebKit — 과 데스크톱 Safari)에서의 후보 순서: mp4 우선 */
export const MIC_MIME_CANDIDATES_APPLE: readonly string[] = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
/** 그 밖(Chrome·Firefox·Android) */
export const MIC_MIME_CANDIDATES_OTHER: readonly string[] = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** 후보 중 지원되는 첫 형식(순수 — eval이 잠근다). 하나도 없으면 null(브라우저 기본값에 맡긴다). */
export function pickMimeTypeFrom(apple: boolean, isSupported: (t: string) => boolean): string | null {
  for (const t of apple ? MIC_MIME_CANDIDATES_APPLE : MIC_MIME_CANDIDATES_OTHER) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/** iOS(iPadOS 데스크톱 모드 포함)·데스크톱 Safari인가 */
export function isAppleWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
  const desktopSafari = /^((?!chrome|chromium|crios|fxios|android|edg).)*safari/i.test(ua);
  return iOS || desktopSafari;
}

/** 이 브라우저에서 요청할 녹음 형식. null이면 브라우저 기본값. */
export function pickRecorderMimeType(): string | null {
  if (typeof window === "undefined" || typeof window.MediaRecorder !== "function") return null;
  const check = typeof MediaRecorder.isTypeSupported === "function" ? (t: string) => MediaRecorder.isTypeSupported(t) : () => false;
  return pickMimeTypeFrom(isAppleWebKit(), check);
}

// ===========================================================================
// 오류
// ===========================================================================

export type MicErrorKind = "unsupported" | "denied" | "no_device" | "busy" | "timeout" | "failed";

export const MIC_ERROR_KO: Record<MicErrorKind, string> = {
  unsupported: "이 브라우저·연결에서는 녹음을 할 수 없어요.",
  denied: "마이크 권한이 거부됐어요 — 브라우저 설정에서 마이크를 허용하면 녹음할 수 있어요.",
  no_device: "마이크를 찾지 못했어요.",
  busy: "마이크를 다른 앱이 쓰고 있거나 열 수 없어요.",
  timeout: "마이크가 응답하지 않아요 — 권한 창이 떠 있었다면 허용한 뒤 다시 시도해 주세요.",
  failed: "녹음을 시작하지 못했어요.",
};

export class MicError extends Error {
  readonly kind: MicErrorKind;
  constructor(kind: MicErrorKind, detail?: string) {
    super(detail ? `${MIC_ERROR_KO[kind]} (${detail})` : MIC_ERROR_KO[kind]);
    this.name = "MicError";
    this.kind = kind;
  }
}

function toMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = (e as { name?: unknown } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return new MicError("denied", String(name));
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return new MicError("no_device", String(name));
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return new MicError("busy", String(name));
    default:
      return new MicError("failed", typeof name === "string" ? name : undefined);
  }
}

// ===========================================================================
// 진단 — 서버 로그를 못 보는 폰에서 판정하려고(§8 진단 캡션, SPEC §16-5 관용구)
// ===========================================================================

export interface MicDiag {
  /** 요청한 형식(null = 브라우저 기본) */
  requestedMimeType: string | null;
  /** recorder.mimeType(실제) */
  mimeType: string | null;
  durationMs: number | null;
  size: number | null;
  /** 마지막 오류(없으면 null) */
  error: string | null;
  /** 마지막으로 건 오디오 세션 타입(API가 없으면 null) */
  audioSession: string | null;
  /** 마지막으로 쓴 마이크 유지 정책과 그 세션의 getUserMedia 호출 수(createMicKeeper — 없으면 null) */
  keep: { policy: MicKeepPolicy; acquisitions: number } | null;
}

let lastDiag: Omit<MicDiag, "audioSession" | "keep"> = { requestedMimeType: null, mimeType: null, durationMs: null, size: null, error: null };
let lastKeep: { policy: MicKeepPolicy; acquisitions: number } | null = null;

/** 마지막 녹음의 진단(메모리, 세션 한정). 렌더 중이 아니라 이벤트·effect에서 읽는다. */
export function getMicDiag(): MicDiag {
  return { ...lastDiag, audioSession: lastSessionType, keep: lastKeep ? { ...lastKeep } : null };
}

function noteDiag(patch: Partial<Omit<MicDiag, "audioSession" | "keep">>): void {
  lastDiag = { ...lastDiag, ...patch };
}

// ===========================================================================
// 녹음
// ===========================================================================

export interface RecordingResult {
  blob: Blob;
  /** 실제 형식(recorder.mimeType, 없으면 조각 타입) */
  mimeType: string;
  /** start 이벤트 ~ stop 요청 */
  durationMs: number;
  size: number;
}

export interface MicRecording {
  /** 요청한 형식(null = 브라우저 기본) */
  readonly requestedMimeType: string | null;
  /** 녹음이 **실제로 시작된** 시각(epoch ms) — MediaRecorder start 이벤트. 시간 안에 시작하지 못하면 MicError로 reject */
  readonly started: Promise<number>;
  /** 실제 형식(시작 뒤 recorder.mimeType) */
  mimeType(): string;
  /** 입력 레벨 0..1(레벨 미터용, 컨텍스트가 없으면 0) */
  level(): number;
  /**
   * 지금 읽은 level()을 무음 판정에 써도 되는가 — 분석기가 있고 오디오 컨텍스트가 running일 때만(멈춘 컨텍스트의 분석기는 0을 낸다 —
   * 무음 오탐, docs/harness/toeic.md §15-10)
   */
  levelReliable(): boolean;
  /** keep 정책에서 입력을 켠 뒤 트랙이 muted라 마이크를 다시 연 횟수(§15-10 — 진단). per-answer·전략 A는 0 */
  readonly remuted: number;
  /**
   * 녹음을 끝낸다 — recorder.stop() → 트랙 stop → **그다음에** 세션 playback. 소리가 하나도 안 담겼거나 시작 전이면 null.
   * 여러 번 불러도 같은 약속을 돌려준다.
   */
  stop(): Promise<RecordingResult | null>;
  /** 버린다(화면이 숨겨졌다·그만두기) — 담긴 소리를 쓰지 않고 트랙·세션만 정리한다. */
  abort(): void;
}

export interface StartRecordingOptions {
  /** 레벨 미터에 쓸 컨텍스트(응시 화면의 싱글턴). 없으면 level()은 0 */
  audioContext?: AudioContext | null;
  /** getUserMedia 응답을 기다리는 상한(ms). 기본 MIC_GUM_TIMEOUT_MS — 마이크 점검(탭)은 MIC_CHECK_GUM_TIMEOUT_MS */
  gumTimeoutMs?: number;
  /** start 이벤트를 기다리는 상한(ms). 기본 MIC_START_TIMEOUT_MS */
  startTimeoutMs?: number;
  /** 이 녹음을 시작한 쪽의 이름(공유 신호 getLiveRecordingOwners·subscribeMicRecording에 실린다). 없으면 null */
  owner?: string;
}

// ---------------------------------------------------------------------------
// 상한 — 녹음 경로의 기다림 상한은 여기 한 곳에 둔다(응시 화면의 감시 타이머도 이 값을 import한다)
// ---------------------------------------------------------------------------

/**
 * getUserMedia 응답 대기 상한 — 답변 단계. 권한은 시작 전 마이크 점검(탭)에서 이미 받았으므로, 여기서 권한 창이 떠 멈추면
 * 그 자체가 실패다. 넘으면 activeCaptures를 되돌리고 playback으로 복귀(MicError "timeout"). 응시 화면의 녹음 시작 감시와 같은 값.
 */
export const MIC_GUM_TIMEOUT_MS = 8000;
/**
 * 마이크 점검(탭)의 getUserMedia 대기 상한 — 처음이면 권한 창에 사람이 답할 시간을 준다. 이 상한이 곧 점검 버튼이
 * "듣는 중…"에 머무는 최대 대기다(그 뒤 start 이벤트 MIC_START_TIMEOUT_MS · 2초 녹음 · stop MIC_STOP_TIMEOUT_MS도 모두 상한이 있다).
 */
export const MIC_CHECK_GUM_TIMEOUT_MS = 15_000;
/** MediaRecorder start 이벤트 대기 상한 — 넘으면 `started`가 MicError로 거부되고 이 모듈이 녹음을 버린다(트랙 stop → playback) */
export const MIC_START_TIMEOUT_MS = 5000;
/** stop 뒤 onstop 대기 상한 — 넘으면 담긴 조각으로 끝낸다 */
export const MIC_STOP_TIMEOUT_MS = 3000;

const GUM_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* noop */
    }
  }
}

/**
 * getUserMedia에 **대기 상한**을 건다. 상한을 넘으면 MicError("timeout")로 거부하고, 그 뒤에 늦게 도착한 스트림은 트랙을 즉시
 * stop한다(아무도 붙잡지 않은 캡처가 마이크 표시등·세션을 쥐고 있지 않게). 늦은 스트림을 놓은 뒤에도 playback 복귀를 한 번 더 건다
 * (그사이 다른 캡처가 시작됐으면 activeCaptures > 0이라 아무것도 하지 않는다). setTimeout 수동 구현 — `AbortSignal.timeout`은 iOS 16 이하에 없다.
 */
function getUserMediaWithin(ms: number): Promise<MediaStream> {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new MicError("timeout", `${Math.round(ms / 1000)}초`));
    }, ms);
    let req: Promise<MediaStream>;
    try {
      req = navigator.mediaDevices.getUserMedia(GUM_CONSTRAINTS);
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
      return;
    }
    req.then(
      (stream) => {
        if (settled) {
          stopTracks(stream); // 늦게 도착 — 이미 포기했다
          setAudioSessionPlayback(); // 트랙 stop **뒤에**
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(stream);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 녹음을 시작한다(전략 A — 답변마다 마이크를 새로 잡고 끝나면 놓는다). 세션 play-and-record → getUserMedia → MediaRecorder.start().
 * 실패하면 MicError로 throw(트랙·세션은 정리된 뒤). 첫 호출은 권한 창이 뜰 수 있어 **탭 안**(마이크 점검)에서 먼저 부른다.
 * 세션 내내 마이크를 쥐는 전략 B는 아래 `createMicKeeper` — 응시·틀 테스트 화면은 그쪽을 거친다.
 */
export async function startRecording(opts: StartRecordingOptions = {}): Promise<MicRecording> {
  const sup = detectMicSupport();
  if (!sup.ok) {
    const err = new MicError("unsupported", sup.reasonKo ?? undefined);
    noteDiag({ error: err.message });
    throw err;
  }

  activeCaptures += 1; // getUserMedia 대기 중에도 다른 곳이 playback으로 되돌리지 못하게
  setSessionType("play-and-record"); // 캡처 **전에**
  let stream: MediaStream;
  try {
    // 대기 상한 — 끝내 답하지 않아도 activeCaptures가 새지 않게(새면 이후 모든 playback 복귀가 무시된다)
    stream = await getUserMediaWithin(opts.gumTimeoutMs ?? MIC_GUM_TIMEOUT_MS);
  } catch (e) {
    activeCaptures = Math.max(0, activeCaptures - 1);
    setAudioSessionPlayback();
    const err = toMicError(e);
    noteDiag({ error: err.message });
    throw err;
  }
  // 이 녹음이 끝나면 스트림을 놓는다: 트랙 stop → activeCaptures-- → **그다음에** playback
  return recordOn(stream, opts, () => {
    stopTracks(stream);
    activeCaptures = Math.max(0, activeCaptures - 1);
    setAudioSessionPlayback(); // 트랙 stop **뒤에**
  });
}

/**
 * 이미 얻은 스트림에 녹음기 하나를 건다(전략 A·B 공용). `releaseStream`은 녹음이 끝나거나 버려질 때 **한 번** 불린다 —
 * 전략 A는 트랙 stop·세션 복귀, 전략 B는 입력 끄기(enabled=false)만. 녹음기 생성·start가 실패하면 놓은 뒤 MicError로 throw.
 */
function recordOn(stream: MediaStream, opts: StartRecordingOptions, releaseStream: () => void, remuted = 0): MicRecording {
  let released = false;
  let source: MediaStreamAudioSourceNode | null = null;
  const owner = opts.owner ?? null;
  let counted = false; // 공유 신호에 올렸는가(녹음기가 실제로 start된 뒤에만)
  const release = () => {
    if (released) return;
    released = true;
    if (counted) {
      counted = false;
      const i = liveRecordings.indexOf(owner);
      if (i >= 0) liveRecordings.splice(i, 1);
      emitRecording("end", owner);
    }
    try {
      source?.disconnect();
    } catch {
      /* noop */
    }
    releaseStream();
  };

  const requested = pickRecorderMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = requested ? new MediaRecorder(stream, { mimeType: requested }) : new MediaRecorder(stream);
  } catch {
    try {
      recorder = new MediaRecorder(stream);
    } catch (e) {
      release();
      const err = toMicError(e);
      noteDiag({ error: err.message });
      throw err;
    }
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  // 레벨 미터 — 응시 화면의 컨텍스트에 붙인다(destination에는 잇지 않는다 — 되울림 방지)
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  const ctx = opts.audioContext ?? null;
  if (ctx) {
    try {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      source.connect(analyser);
    } catch {
      analyser = null;
    }
  }

  let stopping: Promise<RecordingResult | null> | null = null;
  /** 담긴 소리를 쓰지 않고 트랙·세션만 정리한다(abort()와 시작 실패가 같이 쓴다 — 멱등) */
  const abandon = () => {
    if (stopping) return;
    stopping = Promise.resolve(null);
    chunks.length = 0;
    try {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* noop */
    }
    release();
  };

  let startedAt: number | null = null;
  let startFailed = false;
  const started = new Promise<number>((resolve, reject) => {
    const fail = (detail: string) => {
      if (startedAt !== null || startFailed) return;
      startFailed = true;
      noteDiag({ error: new MicError("failed", detail).message });
      reject(new MicError("failed", detail));
      abandon(); // 시작하지 못한 녹음은 쓸 수 없다 — 호출부가 abort()를 잊어도 트랙·activeCaptures가 새지 않게
    };
    recorder.onstart = () => {
      if (startFailed) return; // 상한 뒤 늦게 온 start — 이미 버렸다
      if (startedAt === null) startedAt = Date.now();
      resolve(startedAt);
    };
    recorder.onerror = () => fail("recorder error");
    setTimeout(() => fail("start timeout"), opts.startTimeoutMs ?? MIC_START_TIMEOUT_MS);
  });
  started.catch(() => {}); // 호출부가 안 기다려도 unhandled rejection이 나지 않게

  try {
    recorder.start(); // timeslice 없음 — 단일 Blob(위 머리 주석)
  } catch (e) {
    release();
    const err = toMicError(e);
    noteDiag({ error: err.message });
    throw err;
  }
  noteDiag({ requestedMimeType: requested, mimeType: recorder.mimeType || requested, durationMs: null, size: null, error: null });
  if (!released) {
    counted = true;
    liveRecordings.push(owner);
    emitRecording("start", owner);
  }

  const actualType = () => recorder.mimeType || chunks[0]?.type || requested || "";

  return {
    requestedMimeType: requested,
    started,
    mimeType: actualType,
    remuted,
    levelReliable() {
      return analyser !== null && ctx !== null && ctx.state === "running";
    },
    level() {
      if (!analyser || !buf) return 0;
      try {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms <= 0) return 0;
        const db = 20 * Math.log10(rms); // -∞..0
        return Math.max(0, Math.min(1, (db + 60) / 60)); // -60dB → 0, 0dB → 1
      } catch {
        return 0;
      }
    },
    stop() {
      if (stopping) return stopping;
      const stoppedAt = Date.now();
      stopping = new Promise<RecordingResult | null>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          release();
          const type = actualType();
          const blob = chunks.length > 0 ? new Blob(chunks, { type }) : null;
          if (!blob || blob.size === 0 || startedAt === null) {
            noteDiag({ mimeType: type || null, durationMs: null, size: blob?.size ?? 0, error: "빈 녹음" });
            resolve(null);
            return;
          }
          const result = { blob, mimeType: type, durationMs: Math.max(0, stoppedAt - startedAt), size: blob.size };
          noteDiag({ mimeType: type, durationMs: result.durationMs, size: result.size, error: null });
          resolve(result);
        };
        recorder.onstop = () => finish(); // dataavailable이 onstop보다 먼저 온다
        try {
          if (recorder.state !== "inactive") recorder.stop();
          else finish();
        } catch {
          finish();
        }
        setTimeout(finish, MIC_STOP_TIMEOUT_MS);
      });
      return stopping;
    },
    abort() {
      abandon();
    },
  };
}

// ===========================================================================
// 마이크 유지 — 전략 B (토익 응시·틀 테스트, 2026-10-03 — SPEC §20-4, docs/harness/toeic.md §6-4)
// ===========================================================================

/** "keep" = 세션 내내 스트림 하나(녹음 사이 입력 끔) · "per-answer" = 녹음마다 획득·해제(전략 A) */
export type MicKeepPolicy = "keep" | "per-answer";

/** 기기 설정 "문항마다 마이크 다시 열기" — 켜면 이 기기는 per-answer(질문 소리가 작거나 수화기로 날 때의 탈출구) */
export const MIC_PER_ANSWER_PREF_KEY = "toeic-mic-per-answer";

/**
 * keep 녹음에서 입력을 켠 뒤 트랙이 muted면 unmute를 기다리는 상한(ms) — 넘으면 쥔 스트림을 버리고 한 번 다시 얻는다
 * (docs/harness/toeic.md §15-10, QA q34-norec 갈래 A — iOS가 중단·우선순위 오류 때 캡처를 끝내지 않고 mute한다)
 */
export const MIC_UNMUTE_WAIT_MS = 300;

export interface MicKeepEnv {
  /** iOS·iPadOS·데스크톱 Safari(isAppleWebKit) */
  appleWebKit: boolean;
  /** navigator.audioSession(Safari 16.4+) — 쥔 채 세션을 play-and-record로 **명시**할 수 있는가 */
  audioSession: boolean;
  /** 기기 설정 "문항마다 마이크 다시 열기" */
  perAnswerPref: boolean;
}

/**
 * 마이크 유지 정책(순수 — eval이 잠근다). keep은 Apple WebKit **이고** 오디오 세션 API가 있을 때만:
 * - 권한 재요청이 문제인 곳이 Apple WebKit이다(Chrome·Android는 권한을 기억한다 — 쥘 이득이 없고 마이크 표시만 남는다).
 * - 세션 API가 없는 구형 iOS는 쥔 채 재생 경로를 고를 수 없다 → 소리를 지키려고 전략 A(권한 재요청은 감수).
 */
export function micKeepPolicyFor(env: MicKeepEnv): MicKeepPolicy {
  if (env.perAnswerPref) return "per-answer";
  return env.appleWebKit && env.audioSession ? "keep" : "per-answer";
}

/**
 * 결과 화면 **고칠 문장 녹음**의 마이크 정책(순수 — docs/harness/toeic.md §15-13) — 기기 설정 "문항마다 마이크 다시 열기"와 **상관없이**
 * Apple WebKit + 오디오 세션 API면 keep, 그 밖 per-answer. 그 화면의 녹음은 모두 사용자의 🎤 탭으로 시작하고 끝나면 바로 들을 수 있어
 * 무음을 사람이 곧 알아챈다 — 타이머가 탭 없이 이어 가는 응시 화면과 달리 권한을 한 번만 묻는 이득이 위험보다 크다.
 */
export function toeicFixRecMicPolicy(env: MicKeepEnv): MicKeepPolicy {
  return env.appleWebKit && env.audioSession ? "keep" : "per-answer";
}

/**
 * 기기 설정 읽기 — **기본은 켬(문항마다 열기)**. 2026-10-03 아빠 iPhone에서 마이크 유지 중 Q3·Q4가 "녹음 실패"(놓은 뒤 다시 열기가
 * 8초 안에 응답 없음 — QA q34-norec)로 비어, 무음·재획득 대책(F1~F3)이 들어갈 때까지 예전 방식을 기본으로 되돌렸다.
 * 명시적으로 끈 기기("0")만 마이크 유지(keep 정책 판정으로). 못 읽으면 켬. 렌더 중이 아니라 effect·핸들러에서 부른다.
 */
export function readMicPerAnswerPref(): boolean {
  try {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MIC_PER_ANSWER_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** 기기 설정 쓰기(best-effort) */
export function writeMicPerAnswerPref(on: boolean): void {
  try {
    window.localStorage.setItem(MIC_PER_ANSWER_PREF_KEY, on ? "1" : "0");
  } catch {
    /* 저장 못 해도 이번 화면에는 적용된다 */
  }
}

/** 이 브라우저의 환경(기기 설정 포함) — 브라우저 밖이면 per-answer로 떨어진다 */
export function detectMicKeepEnv(): MicKeepEnv {
  return { appleWebKit: isAppleWebKit(), audioSession: audioSession() !== null, perAnswerPref: readMicPerAnswerPref() };
}

export interface MicKeeper {
  readonly policy: MicKeepPolicy;
  /** 이 세션에서 getUserMedia를 부른 횟수(진단·e2e) */
  acquisitions(): number;
  /** keep 정책에서 살아 있는 스트림을 쥐고 있는가(per-answer는 늘 false) */
  holding(): boolean;
  /** keep 정책에서 스트림을 얻는 중인가(진행 중인 getUserMedia — 탭 안 재획득 게이트가 "놓였다"로 오판하지 않게) */
  opening(): boolean;
  /**
   * 녹음을 연다 — keep: 쥔 스트림을 재사용(없거나 ended면 다시 얻는다 — 그때만 권한 창) → 입력 켜기 → 새 MediaRecorder,
   * 끝나면 입력만 끈다(트랙 stop 없음). per-answer: startRecording 그대로. 앞선 녹음이 아직 돌면 먼저 버린다(한 번에 하나).
   */
  startRecording(opts?: StartRecordingOptions): Promise<MicRecording>;
  /** keep이면 **탭 안에서** 미리 연다(권한 창을 탭 안에) — 이미 쥐었으면 즉시. per-answer는 아무것도 하지 않는다. */
  prime(opts?: { gumTimeoutMs?: number }): Promise<void>;
  /** 놓는다 — 돌던 녹음은 버리고 트랙 stop → activeCaptures-- → **그다음에** playback. 멱등, 놓은 뒤 녹음하면 다시 얻는다. */
  release(): void;
}

function trackList(stream: MediaStream): MediaStreamTrack[] {
  try {
    return stream.getTracks();
  } catch {
    return [];
  }
}

/** 트랙이 하나라도 있고 모두 ended가 아니다(꺼 둔 동안의 muted는 근거로 쓰지 않는다 — 입력을 꺼 둔 트랙이 muted로 보일 수 있다) */
function streamLive(stream: MediaStream): boolean {
  const ts = trackList(stream);
  return ts.length > 0 && ts.every((t) => t.readyState !== "ended");
}

/** 입력을 **켠 뒤에** 트랙이 muted인가(§15-10) — 꺼 둔 동안에는 부르지 않는다 */
function tracksMutedAfterEnable(stream: MediaStream): boolean {
  return trackList(stream).some((t) => t.readyState !== "ended" && t.muted === true);
}

/** muted 트랙이 unmute될 때까지 기다린다(상한 ms) — unmute 이벤트 또는 상한 */
function waitUnmute(stream: MediaStream, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const ts = trackList(stream);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const t of ts) {
        try {
          t.removeEventListener("unmute", onUnmute);
        } catch {
          /* noop */
        }
      }
      resolve();
    };
    const onUnmute = () => {
      if (!tracksMutedAfterEnable(stream)) finish();
    };
    const timer = setTimeout(finish, ms);
    for (const t of ts) {
      try {
        t.addEventListener("unmute", onUnmute);
      } catch {
        /* noop */
      }
    }
  });
}

function setTracksEnabled(stream: MediaStream, on: boolean): void {
  for (const t of trackList(stream)) {
    try {
      t.enabled = on;
    } catch {
      /* noop */
    }
  }
}

/**
 * 화면 세션 하나의 마이크(응시·틀 테스트가 세션마다 하나 만든다). 정책을 넘기지 않으면 이 브라우저에서 판정한다.
 * activeCaptures 계약: keep이 스트림을 쥔 동안(획득 대기 포함) 1을 차지한다 — 녹음 사이에도 playback 전환이 무시되어 트랙이 산다.
 */
export function createMicKeeper(opts: { policy?: MicKeepPolicy } = {}): MicKeeper {
  const policy: MicKeepPolicy = opts.policy ?? micKeepPolicyFor(detectMicKeepEnv());
  let gumCount = 0;
  let stream: MediaStream | null = null;
  let pending: Promise<MediaStream> | null = null;
  /** 놓을 때마다 오른다 — 놓기 전에 시작된 획득이 늦게 끝나면 그 스트림은 바로 닫는다 */
  let gen = 0;
  let current: MicRecording | null = null;
  /** keep 녹음 순번 — 입력 끄기는 마지막 녹음만 */
  let recSeq = 0;
  /**
   * startRecording 호출 순번(QA mic-keep P3-1) — 획득을 기다리는 사이 다시 불리면 앞 호출은 녹음기를 만들지 않고 "superseded"로 끝난다.
   * 같은 스트림에 녹음기가 둘 달려 뒤 녹음이 끝날 때 앞 녹음의 입력이 꺼지는(무음으로 계속 도는) 경합을 막는다. 한 번에 하나.
   */
  let callSeq = 0;
  const note = () => {
    lastKeep = { policy, acquisitions: gumCount };
  };
  note();
  /** 돌던 녹음을 버린다(한 번에 하나) */
  const abortCurrent = () => {
    const c = current;
    current = null;
    c?.abort();
  };

  /** 쥔 스트림을 놓는다(트랙 stop → activeCaptures-- → playback). 쥔 것이 없으면 아무것도 하지 않는다. */
  const drop = () => {
    const s = stream;
    stream = null;
    if (!s) return;
    stopTracks(s);
    activeCaptures = Math.max(0, activeCaptures - 1);
    setAudioSessionPlayback(); // 트랙 stop **뒤에**
  };

  const onEnded = (s: MediaStream) => () => {
    // 권한 철회·장치 분리 등 — 다음 녹음이 다시 얻는다(그때만 권한 창)
    if (stream === s && !streamLive(s)) drop();
  };

  const acquire = (ms: number): Promise<MediaStream> => {
    if (stream && streamLive(stream)) return Promise.resolve(stream);
    if (stream) drop(); // ended — 버리고 다시 얻는다
    if (pending) return pending; // 진행 중인 획득에 합류(두 번 열지 않는다)
    const sup = detectMicSupport();
    if (!sup.getUserMedia || !sup.secureContext) {
      const err = new MicError("unsupported", sup.reasonKo ?? undefined);
      noteDiag({ error: err.message });
      return Promise.reject(err);
    }
    const myGen = gen;
    activeCaptures += 1; // 획득 대기 중에도 다른 곳이 playback으로 되돌리지 못하게
    setSessionType("play-and-record"); // 캡처 **전에** — 쥔 동안 내내 이 모드(명시해야 WebKit이 스피커 기본으로 잡는다)
    gumCount += 1;
    note();
    const p = getUserMediaWithin(ms).then(
      (s) => {
        if (myGen !== gen) {
          // 기다리는 사이 놓았다(화면 숨김·끝) — 이 스트림은 쓰지 않는다
          stopTracks(s);
          activeCaptures = Math.max(0, activeCaptures - 1);
          setAudioSessionPlayback();
          throw new MicError("failed", "released");
        }
        stream = s;
        setTracksEnabled(s, false); // 녹음 사이에는 입력을 꺼 둔다
        const handler = onEnded(s);
        for (const t of trackList(s)) {
          try {
            t.addEventListener("ended", handler);
          } catch {
            /* noop */
          }
        }
        noteDiag({ error: null });
        return s;
      },
      (e: unknown) => {
        activeCaptures = Math.max(0, activeCaptures - 1);
        setAudioSessionPlayback();
        const err = toMicError(e);
        noteDiag({ error: err.message });
        throw err;
      },
    );
    pending = p;
    const clear = () => {
      if (pending === p) pending = null;
    };
    p.then(clear, clear);
    return p;
  };

  return {
    policy,
    acquisitions: () => gumCount,
    holding: () => policy === "keep" && stream !== null && streamLive(stream),
    opening: () => policy === "keep" && pending !== null,
    async startRecording(o: StartRecordingOptions = {}): Promise<MicRecording> {
      const myCall = ++callSeq;
      abortCurrent();
      if (policy === "per-answer") {
        // 열기 횟수는 실제로 getUserMedia를 부를 때만 센다(QA mic-keep P3-6 — 미지원 브라우저에서 부풀지 않게)
        if (detectMicSupport().ok) {
          gumCount += 1;
          note();
        }
        const myGen = gen;
        const rec = await startRecording(o);
        if (myGen !== gen) {
          // 기다리는 사이 놓였다(숨김·끝) — keep과 같이 버린다(QA mic-keep P3-5)
          rec.abort();
          throw new MicError("failed", "released");
        }
        if (myCall !== callSeq) {
          // 기다리는 사이 뒤 호출이 왔다 — 이 녹음은 버린다(뒤 호출이 하나만 남는다)
          rec.abort();
          throw new MicError("failed", "superseded");
        }
        abortCurrent();
        current = rec;
        return rec;
      }
      const sup = detectMicSupport();
      if (!sup.ok) {
        const err = new MicError("unsupported", sup.reasonKo ?? undefined);
        noteDiag({ error: err.message });
        throw err;
      }
      const myGen = gen;
      const gumMs = o.gumTimeoutMs ?? MIC_GUM_TIMEOUT_MS;
      let s = await acquire(gumMs);
      if (myGen !== gen || stream !== s) throw new MicError("failed", "released"); // 기다리는 사이 놓였다
      if (myCall !== callSeq) throw new MicError("failed", "superseded"); // 기다리는 사이 다시 불렸다 — 뒤 호출이 녹음기를 단다
      abortCurrent(); // 녹음기를 만들기 **직전에** 한 번 더 — 같은 스트림에 녹음기가 둘 달리지 않게
      setTracksEnabled(s, true); // 녹음기 **전에** 입력을 켠다
      // 켠 **뒤에도** muted면(iOS가 중단·우선순위 오류 뒤 캡처를 mute로 둔다 — QA q34-norec 갈래 A) 잠깐 기다리고, 그래도면 한 번 다시 연다(§15-10)
      let remuted = 0;
      if (tracksMutedAfterEnable(s)) {
        await waitUnmute(s, MIC_UNMUTE_WAIT_MS);
        if (myGen !== gen || stream !== s) throw new MicError("failed", "released");
        if (myCall !== callSeq) throw new MicError("failed", "superseded");
        if (tracksMutedAfterEnable(s)) {
          remuted = 1;
          drop(); // 트랙 stop → activeCaptures-- → playback(순서 그대로) — 다음 acquire가 다시 play-and-record
          s = await acquire(gumMs);
          if (myGen !== gen || stream !== s) throw new MicError("failed", "released");
          if (myCall !== callSeq) throw new MicError("failed", "superseded");
          abortCurrent();
          setTracksEnabled(s, true); // 다시 얻은 트랙도 muted면 그대로 녹음한다 — 무음 판정(F1)이 잡는다
        }
      }
      const live = s;
      const mySeq = ++recSeq;
      // 끝나면 입력만 끈다(트랙 stop 없음 — 권한 창을 다시 띄우지 않게). 늦게 끝난 앞 녹음이 뒤 녹음의 입력을 끄지 않게 순번을 본다.
      const rec = recordOn(
        live,
        o,
        () => {
          if (recSeq === mySeq) setTracksEnabled(live, false);
        },
        remuted,
      );
      current = rec;
      return rec;
    },
    async prime(o: { gumTimeoutMs?: number } = {}): Promise<void> {
      if (policy !== "keep") return;
      await acquire(o.gumTimeoutMs ?? MIC_CHECK_GUM_TIMEOUT_MS);
    },
    release() {
      gen += 1;
      const rec = current;
      current = null;
      rec?.abort(); // 돌던 녹음은 버린다(입력 끔) — 그다음에 트랙 stop
      pending = null;
      drop();
    },
  };
}

// ===========================================================================
// 스트림만 잡기 — 은우 자유대화(관문 R, WebRTC)의 **대화 내내 열린 마이크** (docs/harness/english.md §12, SPEC §21-5)
// ===========================================================================

/**
 * `acquireMicStream`의 결과 — 스트림과 놓기 함수. `release()`는 멱등이다(여러 번 불러도 한 번만 정리).
 * 순서(이 모듈 머리의 규약 그대로): 트랙 stop → activeCaptures-- → **그다음에** playback.
 */
export interface MicStreamHandle {
  readonly stream: MediaStream;
  release(): void;
}

export interface AcquireMicStreamOptions {
  /**
   * getUserMedia 응답 대기 상한(ms). 기본 MIC_CHECK_GUM_TIMEOUT_MS(15초) — 대화 시작 탭이 **처음 권한 창**을 띄울 수 있어서
   * 사람이 답할 시간을 준다(토익 마이크 점검과 같은 값).
   */
  gumTimeoutMs?: number;
}

/**
 * 마이크 스트림만 잡는다(녹음기 없이) — 자유대화의 WebRTC 연결이 이 트랙을 그대로 보낸다. **재생과 캡처가 대화 내내 겹친다** —
 * 토익의 전략 A(겹치지 않음)를 쓸 수 없는 경로라 iOS 수화기·저음량 위험을 실기기로 확인한다(SPEC §21-5 1).
 *
 * - 세션 play-and-record → getUserMediaWithin(대기 상한·늦은 스트림 정리) → 핸들. 실패하면 activeCaptures를 되돌리고 playback으로
 *   복귀한 뒤 MicError로 throw(startRecording과 같은 정리 순서).
 * - **탭 핸들러 안에서 동기로** 부른다 — getUserMedia 요청이 첫 await 전에 나간다(async 함수 본문은 첫 await까지 동기로 돈다).
 * - `navigator.audioSession.type`은 여기서만 바꾼다(단일 관문). WebRTC 쪽은 getUserMedia·audioSession을 직접 부르지 않는다.
 * - 대화 중 다른 화면 코드가 setAudioSessionPlayback()을 불러도 activeCaptures > 0이라 무시된다(트랙이 끊기지 않는다).
 */
export async function acquireMicStream(opts: AcquireMicStreamOptions = {}): Promise<MicStreamHandle> {
  const sup = detectMicSupport();
  if (!sup.getUserMedia || !sup.secureContext) {
    const err = new MicError("unsupported", sup.reasonKo ?? undefined);
    noteDiag({ error: err.message });
    throw err;
  }

  activeCaptures += 1; // getUserMedia 대기 중에도 다른 곳이 playback으로 되돌리지 못하게
  setSessionType("play-and-record"); // 캡처 **전에**
  let stream: MediaStream;
  try {
    stream = await getUserMediaWithin(opts.gumTimeoutMs ?? MIC_CHECK_GUM_TIMEOUT_MS);
  } catch (e) {
    activeCaptures = Math.max(0, activeCaptures - 1);
    setAudioSessionPlayback();
    const err = toMicError(e);
    noteDiag({ error: err.message });
    throw err;
  }
  noteDiag({ error: null });

  let released = false;
  return {
    stream,
    release() {
      if (released) return;
      released = true;
      stopTracks(stream);
      activeCaptures = Math.max(0, activeCaptures - 1);
      setAudioSessionPlayback(); // 트랙 stop **뒤에**
    },
  };
}

// ===========================================================================
// WAV 정규화 — 16kHz mono 16-bit PCM (§5-0 1)
// ===========================================================================

export const TOEIC_WAV_SAMPLE_RATE = 16_000;

/** 채널들 → mono(평균). 채널이 하나면 복사본. 길이는 가장 짧은 채널에 맞춘다. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < len; i++) out[i] += ch[i];
  }
  for (let i = 0; i < len; i++) out[i] /= channels.length;
  return out;
}

/**
 * 선형 보간 리샘플(순수). 출력 길이 = round(입력 길이 × to/from). 같은 레이트면 복사본.
 * 저역 통과 필터 없이 보간만 한다(§5-0 — 전사 정확도에 충분하다는 판단, 실측은 실기기 확인 항목).
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("[mic-session] 샘플레이트는 0보다 커야 합니다.");
  if (fromRate === toRate) return Float32Array.from(input);
  const outLen = Math.max(0, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  if (input.length === 0) return out;
  const ratio = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** mono float 샘플 → 16-bit PCM WAV 바이트(RIFF/fmt/data — lib/speech.ts makeSilentWav의 헤더 작성과 같은 구조, 16bit). */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataLen = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 청크 크기
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPerSample, true); // byteRate = rate × 1ch × 2byte
  v.setUint16(32, bytesPerSample, true); // blockAlign
  v.setUint16(34, 16, true); // bits
  str(36, "data");
  v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    off += 2;
  }
  return buf;
}

/** 오프라인 컨텍스트로 디코드(하드웨어 컨텍스트 개수를 쓰지 않는다). 구형 Safari의 콜백형 decodeAudioData도 받는다. */
function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) return Promise.reject(new Error("OfflineAudioContext 없음"));
  const ctx = new Ctor(1, 1, 44_100);
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === "function") p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

export interface WavResult {
  blob: Blob;
  /** 디코드된 길이(ms) — 녹음 길이와 크게 다르면 디코드가 잘렸다(진단) */
  durationMs: number;
  /** 디코드 샘플레이트 */
  sourceRate: number;
}

/**
 * 녹음 Blob → 16kHz mono 16-bit WAV(채점 업로드용). 디코드에 실패하면 throw — 화면은 원본을 그대로 올린다(§5-0 1).
 * 빈 오디오(길이 0)도 실패로 본다.
 */
export async function toWav16kMono(blob: Blob): Promise<WavResult> {
  if (typeof window === "undefined") throw new Error("브라우저에서만 변환할 수 있어요.");
  const decoded = await decodeAudio(await blob.arrayBuffer());
  if (!decoded || decoded.length === 0) throw new Error("디코드 결과가 비었어요.");
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const mono = mixToMono(channels);
  const pcm = resampleLinear(mono, decoded.sampleRate, TOEIC_WAV_SAMPLE_RATE);
  return {
    blob: new Blob([encodeWavPcm16(pcm, TOEIC_WAV_SAMPLE_RATE)], { type: "audio/wav" }),
    durationMs: Math.round((decoded.length / decoded.sampleRate) * 1000),
    sourceRate: decoded.sampleRate,
  };
}

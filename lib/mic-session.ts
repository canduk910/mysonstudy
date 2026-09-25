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
}

let lastDiag: MicDiag = { requestedMimeType: null, mimeType: null, durationMs: null, size: null, error: null, audioSession: null };

/** 마지막 녹음의 진단(메모리, 세션 한정). 렌더 중이 아니라 이벤트·effect에서 읽는다. */
export function getMicDiag(): MicDiag {
  return { ...lastDiag, audioSession: lastSessionType };
}

function noteDiag(patch: Partial<MicDiag>): void {
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

  let released = false;
  let source: MediaStreamAudioSourceNode | null = null;
  const release = () => {
    if (released) return;
    released = true;
    try {
      source?.disconnect();
    } catch {
      /* noop */
    }
    stopTracks(stream);
    activeCaptures = Math.max(0, activeCaptures - 1);
    setAudioSessionPlayback(); // 트랙 stop **뒤에**
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

  const actualType = () => recorder.mimeType || chunks[0]?.type || requested || "";

  return {
    requestedMimeType: requested,
    started,
    mimeType: actualType,
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

/** mono float 샘플 → 16-bit PCM WAV 바이트(RIFF/fmt/data — lib/speech.ts makeSilentWavUrl의 헤더 작성과 같은 구조, 16bit). */
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

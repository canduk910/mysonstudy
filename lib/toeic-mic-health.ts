/**
 * lib/toeic-mic-health.ts — 응시 녹음의 **마이크 건강** 판정 순수 함수 (docs/harness/toeic.md §15-10·§15-11·§15-12, SPEC §20-13)
 *
 * QA q34-norec(2026-10-03)의 대책 F1~F3를 화면 밖 순수 함수로 둔다 — 응시 화면·eval이 **같은 함수**를 본다.
 * - F1 무음 감지: 녹음 중 레벨 표본 → 최고 레벨·조용한 시간 → 판정(`toeicSilenceVerdict`)·실시간 알림(`toeicSilenceAlertOn`)·
 *   같은 응시에서 문제 횟수(`toeicMicTroubleAction` — 2번이면 남은 문항을 문항마다 열기로).
 * - F2 문항별 진단: `ToeicAnswerDiag` 모양·정리(`toToeicAnswerDiag`)·한 줄 글(`toeicAnswerDiagLineKo`).
 * - F3 탭 안 재획득: 게이트(`toeicMicGate`)·실패 분기(`toeicMicFailureAction`)·상태 기계(`toeicMicPromptReducer`).
 *
 * 레벨 척도는 lib/mic-session `level()`과 같다 — -60dB → 0, 0dB → 1(선형 dB). 문턱 상수는 **이 모듈 한 곳**이다(점검 ✓·무음 판정이
 * 같은 상수를 import한다 — 두 벌이면 어긋난다).
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import 0. 모듈 최상위에서 브라우저 전역을 읽지 않는다.
 */

// ===========================================================================
// 문턱 상수 (단일 정의)
// ===========================================================================

/** 마이크 점검(2초)에서 "✓ 소리가 잘 들어와요"로 보는 최고 레벨 — 응시 화면이 import한다 */
export const TOEIC_MIC_CHECK_OK_LEVEL = 0.35;
/** 답변 녹음을 "소리 없음(무음)"으로 보는 최고 레벨 — 점검 문턱의 1/3(약 -53dB). 방 소음(-50dB 안팎)보다 낮고 디지털 0보다 높다 */
export const TOEIC_SILENT_PEAK_LEVEL = TOEIC_MIC_CHECK_OK_LEVEL / 3;
/** 판정에 필요한 믿을 표본 수(90ms 간격이면 약 0.9초) — 모자라면 판정하지 않는다(unknown) */
export const TOEIC_SILENCE_MIN_SAMPLES = 10;
/** 녹음 중 문턱 아래가 이만큼 이어지면 화면에 바로 알린다 */
export const TOEIC_SILENCE_ALERT_MS = 3000;
/** 같은 응시에서 마이크 문제(무음 판정 + 켠 뒤 muted 다시 열기)가 이 횟수에 닿으면 남은 문항은 문항마다 연다 */
export const TOEIC_MIC_TROUBLE_MAX = 2;

// ===========================================================================
// F1 — 레벨 표본 · 무음 판정 · 실시간 알림
// ===========================================================================

export interface ToeicLevelTrack {
  /** 믿을 표본의 최고 레벨(0..1) */
  peak: number;
  /** 믿을 표본 수 */
  samples: number;
  /** 문턱 아래가 시작된 시각(epoch ms) — 소리가 들어오면 null */
  quietSince: number | null;
}

export function initialToeicLevelTrack(): ToeicLevelTrack {
  return { peak: 0, samples: 0, quietSince: null };
}

/**
 * 표본 하나를 더한다(순수). `reliable`이 false(분석기 없음·오디오 컨텍스트가 running이 아님)면 **아무것도 바꾸지 않는다** —
 * 멈춘 컨텍스트의 분석기는 0을 내어 무음으로 잘못 판정하게 한다.
 */
export function stepToeicLevelTrack(s: ToeicLevelTrack, sample: { at: number; level: number; reliable: boolean }): ToeicLevelTrack {
  if (!sample.reliable || !Number.isFinite(sample.level)) return s;
  const level = Math.max(0, Math.min(1, sample.level));
  const quiet = level < TOEIC_SILENT_PEAK_LEVEL;
  return {
    peak: Math.max(s.peak, level),
    samples: s.samples + 1,
    quietSince: quiet ? (s.quietSince ?? sample.at) : null,
  };
}

/** 지금 "🔇 소리가 안 들어와요"를 띄울까 — 문턱 아래가 TOEIC_SILENCE_ALERT_MS 넘게 이어졌다 */
export function toeicSilenceAlertOn(s: ToeicLevelTrack, at: number): boolean {
  return s.quietSince !== null && at - s.quietSince >= TOEIC_SILENCE_ALERT_MS;
}

export type ToeicSilenceVerdict = "sound" | "silent" | "unknown";

/** 녹음 하나의 판정 — 믿을 표본이 모자라면 unknown(판정하지 않는다), 최고 레벨이 문턱 아래면 silent */
export function toeicSilenceVerdict(s: ToeicLevelTrack): ToeicSilenceVerdict {
  if (s.samples < TOEIC_SILENCE_MIN_SAMPLES) return "unknown";
  return s.peak < TOEIC_SILENT_PEAK_LEVEL ? "silent" : "sound";
}

/**
 * 마이크 문제가 하나 더 났다(무음 판정 또는 켠 뒤 muted라 다시 열기) — 무엇을 할까(순수).
 * - release: 쥔 마이크를 놓아 다음 답변이 새로 연다(무음 판정일 때 — muted 다시 열기는 이미 새로 열었다)
 * - perAnswer: 문제 횟수가 TOEIC_MIC_TROUBLE_MAX에 닿았고 지금 keep이면 남은 문항을 문항마다 열기로(기기 설정은 바꾸지 않는다)
 */
export function toeicMicTroubleAction(input: { troubles: number; policy: "keep" | "per-answer"; kind: "silent" | "remuted" }): {
  release: boolean;
  perAnswer: boolean;
} {
  return { release: input.kind === "silent", perAnswer: input.policy === "keep" && input.troubles >= TOEIC_MIC_TROUBLE_MAX };
}

// ===========================================================================
// F2 — 문항별 진단
// ===========================================================================

export const TOEIC_ANSWER_DIAG_STATUSES = ["recorded", "silent", "interrupted", "failed", "empty", "nomic", "none"] as const;
export type ToeicAnswerDiagStatus = (typeof TOEIC_ANSWER_DIAG_STATUSES)[number];
/** 진단 글자 상한 */
export const TOEIC_ANSWER_DIAG_ERROR_MAX = 120;
/** 열기 횟수 상한(진단 — 화면이 보낸 값의 범위) */
export const TOEIC_ANSWER_DIAG_OPENS_MAX = 20;
export const TOEIC_ANSWER_DIAG_REMUTED_MAX = 5;

/** 문항 하나의 진단(§15-11) — 응시 화면이 모아 끝내기 본문에 싣고 서버는 범위만 확인해 둔다(판정에는 쓰지 않는다) */
export interface ToeicAnswerDiag {
  q: number;
  status: ToeicAnswerDiagStatus;
  /** 이 문항을 녹음할 때의 마이크 정책 */
  policy: "keep" | "per-answer" | null;
  /** 이 문항 동안 getUserMedia 호출 수 */
  opens: number;
  /** 켠 뒤 muted라 다시 연 횟수 */
  remuted: number;
  /** 마지막 오류(≤120자) */
  error: string | null;
  /** 최고 레벨 0..1(소수 둘째 자리) — 잴 수 없었으면 null */
  peak: number | null;
  size: number | null;
  durationMs: number | null;
  /** F1 무음 판정 */
  silent: boolean;
}

const clampInt = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : lo;
  return Math.max(lo, Math.min(hi, n));
};
const intOrNull = (v: unknown, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(hi, Math.round(v)) : null);

/** 아무 값 → 진단 하나(던지지 않는다 — 저장 정규화와 화면 정리가 같이 쓴다). q가 1..11이 아니면 null. */
export function toToeicAnswerDiag(v: unknown): ToeicAnswerDiag | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const q = o.q;
  if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > 11) return null;
  const status = (TOEIC_ANSWER_DIAG_STATUSES as readonly string[]).includes(o.status as string) ? (o.status as ToeicAnswerDiagStatus) : "none";
  const peak = typeof o.peak === "number" && Number.isFinite(o.peak) ? Math.round(Math.max(0, Math.min(1, o.peak)) * 100) / 100 : null;
  return {
    q,
    status,
    policy: o.policy === "keep" || o.policy === "per-answer" ? o.policy : null,
    opens: clampInt(o.opens, 0, TOEIC_ANSWER_DIAG_OPENS_MAX),
    remuted: clampInt(o.remuted, 0, TOEIC_ANSWER_DIAG_REMUTED_MAX),
    error: typeof o.error === "string" && o.error.trim() !== "" ? o.error.slice(0, TOEIC_ANSWER_DIAG_ERROR_MAX) : null,
    peak,
    size: intOrNull(o.size, 64 * 1024 * 1024),
    durationMs: intOrNull(o.durationMs, 10 * 60 * 1000),
    silent: o.silent === true,
  };
}

/** 진단 목록 정규화 — 깨진 항목은 버리고 같은 q는 뒤의 것 하나, q 오름차순 */
export function normalizeToeicAnswerDiags(v: unknown): ToeicAnswerDiag[] {
  if (!Array.isArray(v)) return [];
  const byQ = new Map<number, ToeicAnswerDiag>();
  for (const raw of v) {
    const d = toToeicAnswerDiag(raw);
    if (d) byQ.set(d.q, d);
  }
  return [...byQ.values()].sort((a, b) => a.q - b.q);
}

export const TOEIC_ANSWER_DIAG_STATUS_KO: Record<ToeicAnswerDiagStatus, string> = {
  recorded: "녹음됨",
  silent: "소리 없음(무음)",
  interrupted: "중단됨",
  failed: "녹음 실패",
  empty: "소리 없음",
  nomic: "녹음 없이",
  none: "안 함",
};

function kbKo(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/** 진단 한 줄 — "녹음됨 · 30.1초 · 18KB · 최고 레벨 85 · 마이크 유지 · 열기 1회" */
export function toeicAnswerDiagLineKo(d: ToeicAnswerDiag): string {
  const parts: string[] = [TOEIC_ANSWER_DIAG_STATUS_KO[d.status]];
  if (d.durationMs !== null && d.durationMs > 0) parts.push(`${(d.durationMs / 1000).toFixed(1)}초`);
  if (d.size !== null && d.size > 0) parts.push(kbKo(d.size));
  parts.push(d.peak === null ? "최고 레벨 —" : `최고 레벨 ${Math.round(d.peak * 100)}`);
  if (d.policy) parts.push(d.policy === "keep" ? "마이크 유지" : "마이크 문항마다");
  parts.push(`열기 ${d.opens}회`);
  if (d.remuted > 0) parts.push(`말 없음 다시 열기 ${d.remuted}회`);
  if (d.error) parts.push(`오류 ${d.error}`);
  return parts.join(" · ");
}

// ===========================================================================
// F3 — 탭 안 재획득
// ===========================================================================

/**
 * 준비 단계·답변을 열기 직전 — 그대로 갈까, 멈추고 탭으로 다시 켜게 할까(순수).
 * keep인데 쥔 스트림이 없고 여는 중도 아니면(숨김·무음 판정·트랙 ended로 놓였다) 타이머 콜백에서 다시 열면 iPhone이 권한 창을
 * 띄워 8초 감시가 그 문항을 비운다(QA q34-norec 갈래 B) — 멈추고 "🎙️ 마이크 다시 켜기"로 탭 안에서 연다.
 * per-answer는 원래 녹음마다 연다 — 게이트를 두지 않는다(실패하면 toeicMicFailureAction이 같은 화면을 띄운다).
 */
export function toeicMicGate(s: { mode: "mic" | "nomic"; policy: "keep" | "per-answer"; holding: boolean; opening: boolean }): "go" | "ask_tap" {
  if (s.mode !== "mic" || s.policy !== "keep") return "go";
  return s.holding || s.opening ? "go" : "ask_tap";
}

/** 답변 녹음 시작이 실패했다 — 탭으로 다시 켜게 할까(ask_tap), 지금처럼 시간만 잴까(timer_only). 권한 거부·미지원은 탭으로도 안 된다 */
export function toeicMicFailureAction(kind: "denied" | "unsupported" | "no_device" | "busy" | "timeout" | "failed" | "watchdog"): "ask_tap" | "timer_only" {
  return kind === "denied" || kind === "unsupported" ? "timer_only" : "ask_tap";
}

export type ToeicMicPromptReason = "released" | "failed";
export type ToeicMicPromptState =
  | { phase: "idle" }
  | { phase: "ask"; reason: ToeicMicPromptReason; q: number | null; message: string | null }
  | { phase: "opening"; q: number | null }
  | { phase: "failed"; q: number | null; message: string };
export type ToeicMicPromptEvent =
  | { type: "need"; reason: ToeicMicPromptReason; q: number | null; message?: string | null }
  | { type: "tap" }
  | { type: "opened" }
  | { type: "fail"; message: string }
  | { type: "skip" };

/**
 * "🎙️ 마이크 다시 켜기" 상태 기계(순수 — eval이 전이표를 잠근다).
 * idle →need→ ask →tap→ opening →opened→ idle · opening →fail→ failed →tap→ opening · 어디서든 skip → idle.
 * 맞지 않는 사건은 상태를 바꾸지 않는다(늦게 온 opened·fail이 다음 화면을 흔들지 않게).
 */
export function toeicMicPromptReducer(s: ToeicMicPromptState, e: ToeicMicPromptEvent): ToeicMicPromptState {
  switch (e.type) {
    case "skip":
      return { phase: "idle" };
    case "need":
      return s.phase === "idle" ? { phase: "ask", reason: e.reason, q: e.q, message: e.message ?? null } : s;
    case "tap":
      return s.phase === "ask" || s.phase === "failed" ? { phase: "opening", q: s.q } : s;
    case "opened":
      return s.phase === "opening" ? { phase: "idle" } : s;
    case "fail":
      return s.phase === "opening" ? { phase: "failed", q: s.q, message: e.message } : s;
  }
}

/**
 * lib/toeic-compare.ts — 결과 화면 "🎧 비교" 판정 순수 함수 (docs/harness/toeic.md §13-9, SPEC §20-11)
 *
 * AI 없음. 서버 페이지(줄인 자료 만들기)·결과 화면(이어 듣기 대상·다시 풀기 기록·점수 변화)·eval이 **같은 함수**를 본다.
 * - ① 이어 듣기 대상 `pickToeicCompareTarget` — Q3–11은 개선 답변 우선(없으면 모범답변), Q1–2는 지문.
 * - ③ 다시 풀기 기록 `toeicQuestionHistory` — 같은 모의고사(한 문제 연습은 같은 연습 문서)·같은 문항, 시간순, 최근 5(이번 포함).
 * - 점수 변화 `toeicScoreDelta` — 이번 − 이번보다 **앞선** 가장 가까운 채점 행. 뒤 응시(옛 결과를 다시 연 경우)는 쓰지 않는다.
 * - 응시 전체 변화 `toeicAttemptDelta` — 실전끼리 둘 다 추정 총점이면 총점 차, 아니면 둘 다 채점된 같은 문항들의 합.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-attempt-rules·lib/toeic-mock·lib/toeic-score)뿐. lib/ai·lib/store는 타입만.
 */

import type { ToeicAttemptScope } from "./ai/toeic/schemas";
import { isToeicAttemptClosed } from "./toeic-attempt-rules";
import { TOEIC_QUESTION_COUNT, toeicMaxScore } from "./toeic-mock";
import type { ToeicStoredRecording } from "./toeic-rec-rules";
import { estimateToeicTotal } from "./toeic-score";

/** 결과 페이지가 읽는 같은 모의고사 응시 수 상한(최신부터) */
export const TOEIC_COMPARE_ATTEMPTS_MAX = 20;
/** 문항마다 보이는 다시 풀기 기록 수(이번 포함) */
export const TOEIC_COMPARE_HISTORY_MAX = 5;
/** 비교 대상 칩의 마지막 선택(기기 localStorage — 실패하면 기본값) */
export const TOEIC_COMPARE_TARGET_STORAGE_KEY = "toeic-compare-target:v1";

// ===========================================================================
// ① 이어 듣기 대상
// ===========================================================================

export type ToeicCompareTargetPref = "improved" | "sample";
export type ToeicCompareTargetKind = "improved" | "sample" | "passage";

export const TOEIC_COMPARE_TARGET_KO: Record<ToeicCompareTargetKind, string> = {
  improved: "개선 답변",
  sample: "모범답변",
  passage: "지문",
};

/**
 * 비교 대상 — Q1–2는 지문(내 읽기 → 지문 낭독). Q3–11은 `prefer`가 improved면 AI 피드백의 개선 답변(없으면 모범답변),
 * sample이면 모범답변(없으면 개선 답변). 글이 하나도 없으면 null.
 */
export function pickToeicCompareTarget(
  question: { q: number; passage: string | null; sampleAnswer: string | null },
  answer: { feedback: { improvedAnswer: string } | null } | null | undefined,
  prefer: ToeicCompareTargetPref = "improved",
): { kind: ToeicCompareTargetKind; text: string } | null {
  const nonEmpty = (t: string | null | undefined): string | null => (t && t.trim() !== "" ? t : null);
  if (question.q <= 2) {
    const p = nonEmpty(question.passage);
    return p ? { kind: "passage", text: p } : null;
  }
  const improved = nonEmpty(answer?.feedback?.improvedAnswer);
  const sample = nonEmpty(question.sampleAnswer);
  if (prefer === "sample") {
    if (sample) return { kind: "sample", text: sample };
    return improved ? { kind: "improved", text: improved } : null;
  }
  if (improved) return { kind: "improved", text: improved };
  return sample ? { kind: "sample", text: sample } : null;
}

/** 기기에 기억한 선택(모르는 값은 기본값 improved) */
export function parseToeicCompareTargetPref(raw: string | null | undefined): ToeicCompareTargetPref {
  return raw === "sample" ? "sample" : "improved";
}

// ===========================================================================
// ③ 다시 풀기 기록 — 서버 페이지가 줄여 넘기는 자료
// ===========================================================================

/** 비교에 쓰는 응시 한 줄(피드백 본문은 넘기지 않는다) */
export interface ToeicCompareAttempt {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  scope: ToeicAttemptScope;
  answers: { q: number; recorded: boolean; score: number | null; transcript: string | null }[];
  recordings: ToeicStoredRecording[];
}

/** 응시 레코드 → 줄인 자료 */
export function toToeicCompareAttempt(a: {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  scope: ToeicAttemptScope;
  answers: readonly { q: number; recorded: boolean; score: number | null; transcript: string | null }[];
  recordings: readonly ToeicStoredRecording[];
}): ToeicCompareAttempt {
  return {
    id: a.id,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    scope: a.scope,
    answers: a.answers.map((x) => ({ q: x.q, recorded: x.recorded === true, score: x.score, transcript: x.transcript })),
    recordings: a.recordings.map((r) => ({ ...r })),
  };
}

/** 같은 모의고사 응시들 → 최신 max개(시간순 오름차순으로 돌려준다). 이번 응시는 늘 포함. */
export function pickToeicCompareAttempts<T extends { id: string; startedAt: string }>(
  attempts: readonly T[],
  currentId: string,
  max: number = TOEIC_COMPARE_ATTEMPTS_MAX,
): T[] {
  const sorted = [...attempts].sort(byStartedAsc);
  const last = sorted.slice(-Math.max(1, max));
  if (!last.some((a) => a.id === currentId)) {
    const cur = sorted.find((a) => a.id === currentId);
    if (cur) return [...sorted.filter((a) => a.id !== currentId).slice(-(Math.max(1, max) - 1)), cur].sort(byStartedAsc);
  }
  return last;
}

function byStartedAsc(a: { id: string; startedAt: string }, b: { id: string; startedAt: string }): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ToeicHistoryRow {
  attemptId: string;
  startedAt: string;
  isCurrent: boolean;
  score: number | null;
  maxScore: number;
  transcript: string | null;
  /** 서버 메타가 있거나 이 기기에 사본이 있음(화면이 기기 쪽을 합친다 — localCopies) */
  hasRecording: boolean;
}

/**
 * 그 문항의 기록 — 이번 응시를 포함해 **시간순**(오래된 → 최신), 최근 max개(이번은 늘 포함). 다른 응시는 닫혔고(§7-5) 그 문항을 녹음한
 * (`recorded`) 것만. `localCopies`는 이 기기에 사본이 있는 응시 id(그 문항) — hasRecording에 합친다.
 */
export function toeicQuestionHistory(
  attempts: readonly ToeicCompareAttempt[],
  currentId: string,
  q: number,
  opts: { max?: number; localCopies?: ReadonlySet<string> } = {},
): ToeicHistoryRow[] {
  const max = Math.max(1, opts.max ?? TOEIC_COMPARE_HISTORY_MAX);
  const maxScore = Number.isInteger(q) && q >= 1 && q <= TOEIC_QUESTION_COUNT ? toeicMaxScore(q) : 0;
  const rows: ToeicHistoryRow[] = [];
  for (const a of [...attempts].sort(byStartedAsc)) {
    const isCurrent = a.id === currentId;
    const ans = a.answers.find((x) => x.q === q);
    if (!isCurrent && (!isToeicAttemptClosed(a) || !ans || ans.recorded !== true)) continue;
    rows.push({
      attemptId: a.id,
      startedAt: a.startedAt,
      isCurrent,
      score: ans?.score ?? null,
      maxScore,
      transcript: ans?.transcript ?? null,
      hasRecording: a.recordings.some((r) => r.q === q) || (opts.localCopies?.has(a.id) ?? false),
    });
  }
  const ci = rows.findIndex((r) => r.isCurrent);
  if (rows.length <= max) return rows;
  if (ci < 0 || ci >= rows.length - max) return rows.slice(-max);
  return [...rows.filter((r) => !r.isCurrent).slice(-(max - 1)), rows[ci]].sort((a, b) => byStartedAsc({ id: a.attemptId, startedAt: a.startedAt }, { id: b.attemptId, startedAt: b.startedAt }));
}

/** 점수 변화 — 이번 점수 − 이번보다 앞선 가장 가까운 채점 행. 어느 쪽이든 없으면 null. */
export function toeicScoreDelta(history: readonly ToeicHistoryRow[]): { delta: number; previous: number; current: number } | null {
  const ci = history.findIndex((r) => r.isCurrent);
  if (ci < 0) return null;
  const current = history[ci].score;
  if (current === null) return null;
  for (let i = ci - 1; i >= 0; i--) {
    const p = history[i].score;
    if (p !== null) return { delta: current - p, previous: p, current };
  }
  return null;
}

/** 점수 변화 칩 글 — "▲1 (지난번 2)" / "▼1 (지난번 3)" / "＝ (지난번 2)" */
export function toeicScoreDeltaLabelKo(d: { delta: number; previous: number }): string {
  const head = d.delta > 0 ? `▲${d.delta}` : d.delta < 0 ? `▼${-d.delta}` : "＝";
  return `${head} (지난번 ${d.previous})`;
}

// ===========================================================================
// 응시 전체 변화(결과 머리 한 줄)
// ===========================================================================

/**
 * 비교할 앞선 응시 — 이번보다 먼저 시작해 닫힌 응시 중 가장 가까운 것. 실전 응시는 실전 응시끼리, 그 밖은 같은 범위(scope)끼리.
 * 없으면 null.
 */
export function toeicPreviousAttempt(attempts: readonly ToeicCompareAttempt[], currentId: string): ToeicCompareAttempt | null {
  const cur = attempts.find((a) => a.id === currentId);
  if (!cur) return null;
  const earlier = attempts
    .filter((a) => a.id !== currentId && a.scope === cur.scope && isToeicAttemptClosed(a) && byStartedAsc(a, cur) < 0)
    .sort(byStartedAsc);
  return earlier[earlier.length - 1] ?? null;
}

export type ToeicAttemptDelta =
  | { kind: "total"; from: number; to: number; delta: number }
  | { kind: "sum"; count: number; from: number; to: number; delta: number };

/**
 * 응시 전체 변화 — 실전(full)끼리 둘 다 추정 총점이 있으면 총점 차. 그 밖(유형 연습·한 문제 연습, 어느 한쪽이 덜 채점됨)은 둘 다 채점된
 * 같은 문항들의 합. 겹치는 채점 문항이 없으면 null.
 */
export function toeicAttemptDelta(current: ToeicCompareAttempt, previous: ToeicCompareAttempt | null): ToeicAttemptDelta | null {
  if (!previous) return null;
  if (current.scope === "full" && previous.scope === "full") {
    const a = estimateToeicTotal(previous.answers);
    const b = estimateToeicTotal(current.answers);
    if (a.complete && b.complete) return { kind: "total", from: a.scaled, to: b.scaled, delta: b.scaled - a.scaled };
  }
  const prevScore = new Map(previous.answers.filter((x) => x.score !== null).map((x) => [x.q, x.score as number] as const));
  let count = 0;
  let from = 0;
  let to = 0;
  for (const x of current.answers) {
    if (x.score === null || !prevScore.has(x.q)) continue;
    count += 1;
    from += prevScore.get(x.q)!;
    to += x.score;
  }
  return count === 0 ? null : { kind: "sum", count, from, to, delta: to - from };
}

/** 머리 한 줄 — "추정 140 → 150 (+10) · 추정(참고용)" / "같은 문항 3개 합 5 → 7 (+2)" */
export function toeicAttemptDeltaLabelKo(d: ToeicAttemptDelta): string {
  const sign = d.delta > 0 ? `+${d.delta}` : d.delta < 0 ? `${d.delta}` : "±0";
  return d.kind === "total"
    ? `지난 실전보다 추정 ${d.from} → ${d.to} (${sign}) · 추정(참고용)`
    : `지난번과 같은 문항 ${d.count}개 합 ${d.from} → ${d.to} (${sign})`;
}

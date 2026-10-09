/**
 * lib/streak-v2-sources.ts — 학습 기록 → "한 판" 판정·일자별 판 수(가족 스트릭 강화 스펙 §2). 순수, store 의존 없음(최소 모양만).
 */

import { kstDateString } from "./kst";
import type { MomLessonRecord } from "./mom-contract";
import { isFullMomLesson, type MomLesson } from "./mom-plan";

/** 자유대화 한 판 — 은우 발화 수 하한(1학년에게 높으면 이 값만 낮춘다) */
export const TALK_STREAK_MIN_CHILD_TURNS = 3;

export function isFullQuiz(q: { finishedAt: string | null; items: readonly { answered: boolean | null }[] }): boolean {
  return q.finishedAt !== null && q.items.length > 0 && q.items.every((i) => i.answered === true);
}

export function isFullAttempt(a: { finishedAt: string | null; questions: readonly number[]; answers: readonly { q: number; recorded: boolean }[] }): boolean {
  if (a.finishedAt === null || a.questions.length === 0) return false;
  const rec = new Set(a.answers.filter((x) => x.recorded === true).map((x) => x.q));
  return a.questions.every((q) => rec.has(q));
}

export function isFullFrameDrill(d: { items: readonly { outcome: string }[] }): boolean {
  return d.items.length > 0 && d.items.some((i) => i.outcome === "spoken");
}

export function isFullTalk(t: { childTurnCount: number }): boolean {
  return Number.isFinite(t.childTurnCount) && t.childTurnCount >= TALK_STREAK_MIN_CHILD_TURNS;
}

/** 세션 시작 시각들 → KST 일자별 판 수 누적 */
export function addRuns(into: Map<string, number>, startedAts: readonly string[]): void {
  for (const at of startedAts) {
    const d = kstDateString(at);
    into.set(d, (into.get(d) ?? 0) + 1);
  }
}

/** 날짜 단위 한 판(복습·운동 지킨 날) → 그날 +1 */
export function addDays(into: Map<string, number>, days: Iterable<string>): void {
  for (const d of days) into.set(d, (into.get(d) ?? 0) + 1);
}

/**
 * 엄마 레슨 한 판(엄마 설계 §7) — 계획(buildMomWeeks)에 있는 레슨이면 isFullMomLesson(말하기 문장 전부 체크 + 끝냄).
 * 계획에 없는 레슨은 자동 감속 가상 복습 주(`rw101-d1`…, 진도 걷기에서만 생긴다)일 때만 — 끝냈고 체크가 하나 이상이면 한 판.
 * 그 밖(계획에 없는 `w…` — 블록이 빠졌거나 바뀐 주)은 판정할 기준이 없어 한 판이 아니다.
 */
export function isFullMomLessonRun(
  rec: Pick<MomLessonRecord, "lessonId" | "finishedAt" | "checks">,
  planned: Pick<MomLesson, "speakIds"> | undefined,
): boolean {
  if (planned) return isFullMomLesson(rec, planned);
  return /^rw\d{1,3}-d[1-4]$/.test(rec.lessonId) && rec.finishedAt !== null && rec.checks.length >= 1;
}

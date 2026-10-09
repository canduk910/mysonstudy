/**
 * lib/streak-v2-sources.ts — 학습 기록 → "한 판" 판정·일자별 판 수(가족 스트릭 강화 스펙 §2). 순수, store 의존 없음(최소 모양만).
 */

import { kstDateString } from "./kst";
import type { MomLessonRecord } from "./mom-contract";

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
 * 엄마 레슨 한 판(엄마 설계 §7) — **기록만 본다**: 끝냈고(finishedAt) 체크가 하나 이상. `w…`·`rw…` 모두 같다.
 * 지금의 계획(buildMomWeeks)과 대조하지 않는다 — 내용을 다시 가져와 그 주 말하기 문장이 바뀌어도 지난 날의 🔥·가족 연속이
 * 소급해 사라지면 안 된다(스트릭 기록은 뒤늦게 바뀌지 않는다). 저장 라우트·러너는 말하기 문장마다 체크를 남긴 끝낸 레슨만 저장하므로
 * 지금 데이터에선 isFullMomLesson과 같은 결과다. 진도(mom-plan)의 완료 판정은 따로 그대로 isFullMomLesson을 쓴다.
 */
export function isFullMomLessonRecord(rec: Pick<MomLessonRecord, "finishedAt" | "checks">): boolean {
  return rec.finishedAt !== null && rec.checks.length >= 1;
}

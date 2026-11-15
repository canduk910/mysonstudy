/**
 * lib/ja-daily-streak.ts — 🗓️ 오늘의 일본어 회차 → 아빠 📚 어학(일본어 쪽) 스트릭(설계 §7, SPEC §17-10·§25-5).
 *
 * - **한 판**(v2): 끝낸 회차(replay 포함) 중 네 칸 가운데 done이 하나 이상(`isFullJaDailySession`). 모두 건너뛴 회차는 한 판이 아니다.
 * - **옛 일본어 세션**(legacy — computeStreak): 네 칸을 문항으로 보고 done을 "답한 문항"으로.
 * - 오늘 라벨: `오늘의 일본어 · Day n`(헤드라인이 `일본어 · `를 앞에 붙인다).
 * 알림·가족 보드는 아빠 한 칸을 그대로 읽으므로 여기서 바꿀 것이 없다. 토익·은우 트랙에 섞지 않는다(컬렉션부터 다르다 — jaDailySessions).
 *
 * - **그날의 한 판**(`jaDailyFullRunsOn`)·**홈 "오늘 완료"**(`jaDailyDoneTodayN`) — 날짜는 스트릭과 같은 **startedAt(KST)**, 판정은 `isFullJaDailySession`.
 *   홈·허브 카드("오늘 완료 ✓")와 스트릭이 같은 함수를 봐서 자정을 넘긴 회차·전부 건너뛴 회차에서 둘이 갈리지 않는다(QA daily1 P2-A).
 *
 * 순수(store 의존 없음 — 최소 모양만). lib/streak-server.ts·GET /api/japanese/daily와 eval:streak·eval:ja-daily가 쓴다.
 */
import { kstDateString } from "./kst";
import type { StreakSession } from "./streak";

export interface JaDailyStreakRecord {
  n: number;
  startedAt: string;
  finishedAt: string | null;
  steps: { kaiwa: string; vocab: string; exam: string; review: string };
}

const doneSteps = (r: JaDailyStreakRecord): boolean[] => [r.steps.kaiwa, r.steps.vocab, r.steps.exam, r.steps.review].map((s) => s === "done");

/** 한 판 — 끝냈고 done 칸 ≥ 1 */
export function isFullJaDailySession(r: JaDailyStreakRecord): boolean {
  return r.finishedAt !== null && doneSteps(r).some(Boolean);
}

/** 옛 규칙 일본어 세션 — 칸 하나 = 문항 하나, done = 답함(끝내지 않은 기록은 답한 문항 0) */
export function jaDailyStreakSessions(records: readonly JaDailyStreakRecord[]): StreakSession[] {
  return records.map((r) => ({ startedAt: r.startedAt, items: doneSteps(r).map((d) => ({ answered: r.finishedAt !== null && d })) }));
}

/** 일본어 트랙 오늘 라벨(앞의 `일본어 · `는 헤드라인이 붙인다) */
export function jaDailyStreakLabel(r: Pick<JaDailyStreakRecord, "n">): string {
  return `오늘의 일본어 · Day ${r.n}`;
}

/** KST 날짜 day에 **시작한** 한 판들(replay 포함) — 늦게 시작한 것이 앞 */
export function jaDailyFullRunsOn<T extends JaDailyStreakRecord>(records: readonly T[], day: string): T[] {
  return records
    .filter((r) => kstDateString(r.startedAt) === day && isFullJaDailySession(r))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/**
 * 홈·허브 카드의 "오늘 완료" — 오늘(KST) 시작한 **진도** 한 판(replay 아님)의 가장 큰 n, 없으면 null.
 * 스트릭과 같은 날짜·같은 한 판 판정이라 "오늘 완료"가 보이면 그날 어학 칸도 켜져 있다.
 */
export function jaDailyDoneTodayN(records: readonly (JaDailyStreakRecord & { replay: boolean })[], today: string): number | null {
  const ns = jaDailyFullRunsOn(records, today).filter((r) => !r.replay).map((r) => r.n);
  return ns.length > 0 ? Math.max(...ns) : null;
}

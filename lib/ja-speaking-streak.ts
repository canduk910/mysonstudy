/**
 * lib/ja-speaking-streak.ts — 🎙️ 일본어 말하기 모의고사 → 아빠 📚 어학(일본어 트랙) 스트릭 (docs/harness/japanese.md §15-11-2)
 *
 * - **한 판**(v2): `isFullAttempt`를 **그대로** 쓴다(lib/streak-v2-sources — finishedAt ≠ null이고 응시 범위의 모든 문항이 녹음됨). 토익 응시와
 *   같은 규칙이라 함수를 새로 두지 않는다. "녹음 없이 연습"(마이크 거부)은 한 판이 아니다.
 * - **옛 일본어 세션**(legacy — computeStreak): 녹음된 문항을 "답한 문항"으로 보는 세션. 끝/그만두기 전(answers 빈 배열)은 답한 문항 0.
 * - 오늘 라벨: `말하기 모의고사 · {titleKo}`(헤드라인이 `일본어 · `를 앞에 붙인다 — SPEC §17-10).
 * 토익 트랙(toeicStreakSessions)·은우 트랙에 섞지 않는다 — 컬렉션부터 다르다(jaSpeakingAttempts).
 *
 * 순수(store 의존 없음 — 최소 모양만). /api/streak(lib/streak-server.ts)와 eval:streak가 쓴다.
 */

import type { StreakSession } from "./streak";

export interface JaSpeakingStreakAttempt {
  startedAt: string;
  answers: readonly { recorded: boolean }[];
}

/** 옛 규칙 일본어 세션 — 녹음된 문항 = 답한 문항 */
export function jaSpeakingStreakSessions(attempts: readonly JaSpeakingStreakAttempt[]): StreakSession[] {
  return attempts.map((a) => ({ startedAt: a.startedAt, items: a.answers.map((x) => ({ answered: x.recorded === true })) }));
}

/** 오늘 라벨 후보로 세는가 — 녹음된 문항 ≥ 1(옛 규칙과 같은 기준) */
export function isCountedJaSpeakingAttempt(a: JaSpeakingStreakAttempt): boolean {
  return a.answers.some((x) => x.recorded === true);
}

/** 일본어 트랙 오늘 라벨(앞에 `일본어 · `는 헤드라인이 붙인다) */
export function jaSpeakingStreakLabel(mock: { titleKo: string } | null): string {
  return mock ? `말하기 모의고사 · ${mock.titleKo}` : "말하기 모의고사";
}

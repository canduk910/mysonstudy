/**
 * lib/toeic-streak.ts — 아빠 · 🎙️ 영어 트랙(토익스피킹)의 스트릭 입력을 만드는 **순수 함수** (docs/harness/toeic.md §0-2, SPEC §17-7)
 *
 * 영어 트랙이 세는 것은 두 가지다 — ① 표현 시험 세션(`toeicQuizzes`) 중 **답한 문항이 1개 이상**, ② 모의고사 응시
 * (`toeicAttempts`) 중 **끝까지 녹음된 문항이 1개 이상**. 둘을 같은 연속 판정 코어(computeStreak)에 넣기 위해 응시를
 * StreakSession 모양으로 옮긴다(녹음된 문항 = answered:true, 녹음 안 된 문항 = null — "답한 문항 0 세션 제외" 규칙이 그대로
 * "녹음 0 응시 제외"가 된다).
 *
 * **트랙 분리**: 이 함수는 토익 기록만 받는다. 은우(영어 단어 시험)·아빠 일본어(단어·한자 시험)·아빠 운동과 한 집합에 섞지
 * 않는다 — 섞으면 한쪽만 한 날도 이어져 보인다(§0-2 스트릭 결정, eval:streak "트랙 분리" 반례가 잠근다).
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import 0(타입만).
 */

import type { StreakSession } from "./streak";

/** 표현 시험 세션 최소 모양(ToeicQuizRecord가 만족) */
export interface ToeicQuizStreakLike {
  startedAt: string;
  items: readonly { answered: boolean | null }[];
}

/** 모의고사 응시 최소 모양(ToeicAttemptRecord가 만족) */
export interface ToeicAttemptStreakLike {
  startedAt: string;
  answers: readonly { recorded: boolean }[];
}

/** 표현 시험 + 모의고사 응시 → 영어 트랙 스트릭 세션(computeStreak 입력). */
export function toeicStreakSessions(
  quizzes: readonly ToeicQuizStreakLike[],
  attempts: readonly ToeicAttemptStreakLike[],
): StreakSession[] {
  return [
    ...quizzes.map((q) => ({ startedAt: q.startedAt, items: q.items.map((it) => ({ answered: it.answered })) })),
    ...attempts.map((a) => ({
      startedAt: a.startedAt,
      items: a.answers.map((x) => ({ answered: x.recorded === true ? true : null })),
    })),
  ];
}

/** 녹음된 문항이 1개 이상인 응시인가(영어 트랙에 세는 응시) */
export function isCountedToeicAttempt(a: ToeicAttemptStreakLike): boolean {
  return a.answers.some((x) => x.recorded === true);
}

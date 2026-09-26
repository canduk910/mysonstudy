/**
 * lib/talk-streak.ts — 은우 트랙에 **자유대화**를 넣기 위한 스트릭 입력 순수 함수 (SPEC §17-9, docs/harness/english.md §12-4)
 *
 * 사용자 확정(2026-09-26): 자유대화도 은우가 학습한 날로 센다 — §17-1 "시험만 센다"의 은우 트랙 한정 예외.
 * 조건은 **은우 발화 줄이 1개 이상**(`childTurnCount ≥ 1`, 빈 전사 제외 — toTalkTurns가 이미 뺐다). 연결만 하고 한마디도 안 한
 * 대화는 세지 않는다(저장도 하지 않는다, SPEC §21-2).
 *
 * 대화를 StreakSession 모양으로 옮겨 **같은 연속 판정 코어**(computeStreak, §17-3)에 넣는다 — "은우 발화 = 답한 문항".
 * 연속 판정은 "답한 문항 ≥ 1"만 보므로 발화 수만큼 문항을 복제하지 않고, 발화가 있으면 답한 문항 하나로 옮긴다.
 * 날짜는 대화 `startedAt`의 KST 일자다(computeStreak가 접는다).
 *
 * **트랙 분리**: 은우 트랙 = 영어 단어장 시험(`vocabQuizzes`) + 자유대화(`talkSessions`). 아빠(일본어·영어·운동) 기록과 섞지 않는다.
 * 대화 컬렉션을 못 읽으면 은우 트랙은 단어장 시험만으로 계산한다(라우트 몫 — SPEC §17-9).
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import 0(타입만) — lib/toeic-streak.ts 관용구.
 */

import type { StreakSession } from "./streak";

/** 대화 기록 최소 모양(TalkSessionRecord가 만족) */
export interface TalkSessionStreakLike {
  startedAt: string;
  childTurnCount: number;
}

/** 은우 발화가 1개 이상인 대화인가(은우 트랙에 세는 대화) */
export function isCountedTalkSession(s: TalkSessionStreakLike): boolean {
  return Number.isFinite(s.childTurnCount) && s.childTurnCount >= 1;
}

/** 자유대화 → 은우 트랙 스트릭 세션(computeStreak 입력). 발화 0 대화는 답한 문항 0 세션이 되어 코어가 뺀다. */
export function talkStreakSessions(sessions: readonly TalkSessionStreakLike[]): StreakSession[] {
  return sessions.map((s) => ({
    startedAt: s.startedAt,
    items: isCountedTalkSession(s) ? [{ answered: true }] : [],
  }));
}

/** 헤드라인 todayLabel(SPEC §17-9 — 대화면 `자유대화 · {주제}`). 주제 = 대화 주제의 한국어 라벨. */
export function talkStreakLabel(s: { topic: { labelKo: string } }): string {
  return `자유대화 · ${s.topic.labelKo}`;
}

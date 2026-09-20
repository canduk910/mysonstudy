/**
 * lib/streak-contract.ts — `/api/streak` 응답 계약(타입 전용). 서버(route)와 헤드라인(client)이 공유한다.
 * StreakInfo는 순수 모듈 lib/streak.ts에서 재수출 — 클라이언트 번들에 store/ai가 새지 않는다.
 */

import type { StreakInfo } from "./streak";
export type { StreakInfo };

export interface PersonStreak {
  info: StreakInfo;
  /** 오늘 한 과목·주제(예: "영어 단어장 · DAY 08" / "한자 시험"). 오늘 안 했으면 null. */
  todayLabel: string | null;
}

export interface StreakResponse {
  ok: true;
  /** 서버가 계산한 KST 오늘 일자 YYYY-MM-DD */
  today: string;
  eunwoo: PersonStreak;
  appa: PersonStreak;
}

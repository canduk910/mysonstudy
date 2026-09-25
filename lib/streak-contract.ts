/**
 * lib/streak-contract.ts — `/api/streak` 응답 계약(타입 전용). 서버(route)와 헤드라인(client)이 공유한다.
 * StreakInfo는 순수 모듈 lib/streak.ts에서 재수출 — 클라이언트 번들에 store/ai가 새지 않는다.
 */

import type { StreakInfo } from "./streak";
export type { StreakInfo };

export interface PersonStreak {
  info: StreakInfo;
  /**
   * 오늘 한 과목·주제(짧게). 오늘 안 했으면 null.
   * 은우 "영어 단어장 · DAY 08" / 아빠·일본어 "단어장 · {제목}"·"한자 시험"(헤드라인이 "일본어"를 앞에 붙인다) /
   * 아빠·영어 "표현집 · {제목}"·"모의고사 · {제목}" /
   * 아빠·운동 "Day 7 ✓"·"Day 5 목표 ✓"·"Day 7 ✗"·"휴식"·"회복 휴식"·"마무리 휴식 2/3"·"재측정 ✓"(§17-7).
   */
  todayLabel: string | null;
}

export interface StreakResponse {
  ok: true;
  /** 서버가 계산한 KST 오늘 일자 YYYY-MM-DD */
  today: string;
  eunwoo: PersonStreak;
  /** 아빠 · 🗾 일본어 트랙(일본어 단어 시험 + 한자 시험). 필드 이름은 호환을 위해 그대로 둔다(§17-7). */
  appa: PersonStreak;
  /**
   * 아빠 · 💪 운동 트랙 — 러시안 파이터 루틴을 **지킨 날**(운동·실패 기록일 + 계획된 휴식일 + 재측정 끝낸 날, §17-7).
   * 일본어 트랙과 합치지 않는다(합치면 운동만 한 날에 일본어가 이어져 보인다). 오늘이 휴식 슬롯이면 doneToday=true.
   * 서버가 운동 계산에 실패하면 이 트랙만 중립값(current 0·doneToday false·todayLabel null)으로 온다.
   */
  appaWorkout: PersonStreak;
  /**
   * 아빠 · 🎙️ 영어 트랙(토익스피킹, docs/harness/toeic.md §0-2) — 표현 시험(답한 문항 1개 이상) + 모의고사 응시(녹음된 문항
   * 1개 이상). 일본어·운동 트랙과 합치지 않는다(합치면 한쪽만 한 날도 이어져 보인다). todayLabel은 "표현집 · {제목}" 또는
   * "모의고사 · {제목}"(헤드라인이 "영어"를 앞에 붙인다). 서버가 영어 계산에 실패하면 이 트랙만 중립값으로 온다.
   */
  appaEnglish: PersonStreak;
}

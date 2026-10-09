/**
 * lib/streak-contract.ts — `/api/streak` 응답 계약(타입 전용). 서버(route)와 헤드라인(client)이 공유한다.
 * StreakInfo는 순수 모듈 lib/streak.ts에서 재수출 — 클라이언트 번들에 store/ai가 새지 않는다.
 */

import type { StreakInfo } from "./streak";
import type { StreakV2Info, WeekCell } from "./streak-v2";
export type { StreakInfo };

export interface PersonStreak {
  /** 연속 정보. 스트릭 v2(가족 스트릭 강화) 트랙은 카드·만회 필드(freezeDays·repairedDays·pendingRepairDay·freezeLeftThisMonth·runsToday)가 더 온다 */
  info: StreakInfo & Partial<Omit<StreakV2Info, keyof StreakInfo>>;
  /**
   * 오늘 한 과목·주제(짧게). 오늘 안 했으면 null.
   * 은우 "영어 단어장 · DAY 08"·"자유대화 · {주제}"(오늘 가장 늦게 시작한 것 — §17-9) /
   * 아빠·일본어 "단어장 · {제목}"·"한자 시험"(헤드라인이 "일본어"를 앞에 붙인다) /
   * 아빠·영어 "표현집 · {제목}"·"모의고사 · {제목}" /
   * 아빠·운동 "Day 7 ✓"·"Day 5 목표 ✓"·"Day 7 ✗"·"휴식"·"회복 휴식"·"마무리 휴식 2/3"·"재측정 ✓"(§17-7).
   * 은우·일본어·영어 트랙은 그날 다른 기록이 없고 복습만 했으면 "오늘의 복습 · n개"(SPEC §23-9).
   */
  todayLabel: string | null;
}

export type StreakBadgeKey = "eunwoo" | "appa" | "appaLanguage" | "appaWorkout" | "mom" | "family";

export interface StreakResponse {
  ok: true;
  /** 서버가 계산한 KST 오늘 일자 YYYY-MM-DD */
  today: string;
  /**
   * 은우 트랙 — 영어 단어장 시험(답한 문항 1개 이상) + 자유대화(은우 발화 1개 이상, §17-9 은우 트랙 한정 예외).
   * 아빠 트랙과 섞지 않는다. 서버가 자유대화 기록을 못 읽으면 단어장 시험만으로 계산한다.
   */
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
  /**
   * 아빠 · 📚 어학 트랙(SPEC §17-10, 2026-10-08 사용자 요청) — 일본어(`appa`)와 영어(`appaEnglish`)의 날짜 **합집합**.
   * 둘 중 하나만 해도 그날이 켜진다. 2026-10-09부터 헤드라인·보드는 칸으로 그리지 않는다(아빠는 `appaPerson` 하나) — 호환·라벨용.
   * todayLabel은 오늘 가장 늦게 한 쪽의 라벨에 "일본어 · "/"영어 · "를 붙인 것(복습만이면 기록 있는 쪽, 일본어 먼저).
   * 토익 기록을 못 읽으면 일본어 + 토익 복습만으로 계산한다.
   */
  appaLanguage: PersonStreak;
  /**
   * 🧑 아빠 **사람 하나**(2026-10-09 사용자 결정 — 헤드라인·보드·가족·알림이 아빠로 보는 값). `appaPersonV2`:
   * APPA_BOTH_FROM(2026-10-10)부터는 📚 어학·💪 운동 **둘 다** 해야 그날이 켜지고(운동 계획 휴식일은 어학만), 그 전 날짜는 옛 규칙(둘 중 하나).
   * 만회 대기(`pendingRepairDay`)·오늘 판 수(`runsToday`)·연속·🧊 카드는 이 값으로 본다(트랙 값은 한 트랙만 센다).
   * todayLabel은 트랙별 한 것/남은 것 — "어학 ✓ · 운동 ✓"·"어학 ✓ · 운동 남음"·"운동 ✓ · 어학 남음"·"어학·운동 남음"·
   * "어학 ✓ · 운동 쉬는 날"·"운동 쉬는 날 · 어학 남음". v2 계산이 실패하면 옛 규칙(어학 ∪ 운동 지킨 날)으로 내고, 그것마저 실패하면 없다.
   */
  appaPerson?: PersonStreak;
  /** 👩 엄마 트랙 — 엄마 영역(②) 전에는 null */
  mom: PersonStreak | null;
  /** 👪 가족 연속일(가족 스트릭 강화 스펙 §3-2) — 그날 참여자(첫 기록일 이후인 사람) 전원이 지킨 날(켜짐·🧊·🔁·만회 대기)이 이어진 수 */
  family: PersonStreak;
  /** 이번 주(월~일, KST) 사람별 칸 — lit·freeze·repaired·pending(만회 대기)·missed·future·none(첫 기록 전) */
  week: { days: string[]; rows: { eunwoo: WeekCell[]; appa: WeekCell[]; mom: WeekCell[] | null } };
  /**
   * 배지(스펙 §4-1) — 최고 기록으로 얻은 배지, 오늘 막 도달한 배지(없으면 null). 아빠는 2026-10-09부터 사람 하나(`appa` — appaPerson의 best).
   * `appaLanguage`·`appaWorkout` 키는 옛 응답 호환으로만 타입에 남는다(서버는 더 내지 않는다).
   */
  badges: { key: StreakBadgeKey; earned: number[]; reachedToday: number | null }[];
  /** 새 규칙(한 판·카드·만회) 적용일 — 보드 안내용 */
  v2From: string;
}

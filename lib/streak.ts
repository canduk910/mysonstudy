/**
 * lib/streak.ts — 학습 스트릭(연속 학습일) 계산의 **순수 함수** (SPEC §17-3). AI·저장 없음.
 *
 * 입력은 **구조적 최소 타입**(세션 목록 또는 KST 일자 집합)만 받는다 — `lib/store`·`lib/ai`에 의존하지 않는다(영어 vocab-quiz.ts 관용구).
 * "오늘"은 인자로 받아 결정적으로 둔다(테스트 가능). 시험만 세고(§17-1), **답한 문항 0인 세션은 제외**한다.
 * 아빠의 운동 트랙(§17-7)은 세션이 아니라 엔진이 접은 "루틴을 지킨 날" 집합(lib/workout `workoutKeptDays`)을 코어에 넣는다.
 */

import { kstDateString, shiftDateString } from "./kst";

/** 시험 세션의 최소 형태 — VocabQuizRecord·JaQuizRecord·JaKanjiQuizRecord가 모두 이걸 만족한다. */
export interface StreakSession {
  startedAt: string; // ISO(UTC)
  items: { answered: boolean | null }[];
}

export interface StreakInfo {
  /** 연속 일수(듀오링고 방식) */
  current: number;
  /** 오늘(KST) 이미 했는가 */
  doneToday: boolean;
  /** 마지막으로 한 KST 일자 (없으면 null) */
  lastDate: string | null;
  /** 최고 기록(가장 긴 연속) */
  best: number;
}

/** 시험 저장 성공 직후 헤드라인을 갱신하는 커스텀 이벤트 이름(성취감이 여기서 나온다, §17-4). */
export const STREAK_REFRESH_EVENT = "eunwoo:streak-refresh";

/** 한 문항이라도 답한(answered===true) 세션만 "실제로 푼" 것으로 센다(§17-1). */
function hasAnswered(s: StreakSession): boolean {
  return s.items.some((it) => it.answered === true);
}

/**
 * 세션 목록을 사람별로 접어 스트릭을 계산한다. 같은 날 여러 세션은 하루로 접는다.
 * 세션 → (답한 세션만) KST 일자 집합 → 날짜 코어(computeStreakFromDays). 코어를 떼어 낸 뒤에도 동작은 그대로다(§17-7).
 * @param sessions 한 사람의 시험 세션들(사람 분리는 호출측 책임 — 은우/아빠를 섞지 마라)
 * @param todayKst 오늘 KST 일자 `YYYY-MM-DD`
 */
export function computeStreak(sessions: readonly StreakSession[], todayKst: string): StreakInfo {
  // 답한 세션만 → KST 일자 집합(같은 날 접기)
  const days = new Set<string>();
  for (const s of sessions) {
    if (hasAnswered(s)) days.add(kstDateString(s.startedAt));
  }
  return computeStreakFromDays(days, todayKst);
}

/**
 * 날짜 집합 코어 — "한 날"의 KST 일자들을 받아 연속·최고 기록을 접는다(§17-3 규칙, 듀오링고 방식).
 * 시험 세션(computeStreak)과 운동 "지킨 날"(workoutKeptDays, §17-7)이 **같은 규칙**을 쓰도록 떼어 냈다.
 * 트랙 분리는 호출측 책임이다 — 일본어 날짜와 운동 날짜를 한 집합에 섞지 마라(운동만 한 날에 일본어가 이어져 보인다).
 * @param days KST 일자 `YYYY-MM-DD`들(배열·Set, 정렬·중복 무관 — 집합으로 접는다)
 * @param todayKst 오늘 KST 일자 `YYYY-MM-DD`
 */
export function computeStreakFromDays(days: ReadonlySet<string> | readonly string[], todayKst: string): StreakInfo {
  const set = new Set<string>(days); // 같은 날 접기(배열 입력의 중복도 여기서)
  if (set.size === 0) return { current: 0, doneToday: false, lastDate: null, best: 0 };

  const sorted = [...set].sort(); // YYYY-MM-DD는 사전순 = 시간순
  const lastDate = sorted[sorted.length - 1];
  const doneToday = set.has(todayKst);

  // 최고 기록 — 정렬된 일자에서 가장 긴 연속 구간
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (shiftDateString(sorted[i - 1], 1) === sorted[i]) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }

  // 현재 연속 — 오늘 했으면 오늘부터, 아니면 어제 했을 때만 어제부터(아직 살아 있음), 둘 다 아니면 0
  let anchor: string | null = null;
  if (doneToday) anchor = todayKst;
  else if (set.has(shiftDateString(todayKst, -1))) anchor = shiftDateString(todayKst, -1);

  let current = 0;
  if (anchor) {
    let d = anchor;
    while (set.has(d)) {
      current += 1;
      d = shiftDateString(d, -1);
    }
  }

  return { current, doneToday, lastDate, best };
}

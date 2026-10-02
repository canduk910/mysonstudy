/**
 * lib/test-status.ts — 목록 카드의 **시험 응시 배지**(SPEC §15-4)의 단일 정의처. **순수 함수**(AI·저장·현재 시각 의존 없음).
 *
 * 은우 영어 단어장(`/english/vocab`) · 아빠 일본어 단어장(`/japanese/vocab`) · 토익 표현집(`/toeic/sets`) · 토익 유형별 공략 폴더
 * (`/toeic/guides`)가 같은 규칙으로 "시험 전 / 오늘 ✓ / ✓ M월 D일 · 맞힘/답함"을 보인다. 화면마다 규칙을 복사하면 반드시 갈린다.
 *
 * 규칙:
 * - **판 = 같은 대상(setId)·같은 `startedAt`의 세션 문서 묶음.** 혼합 시험은 모드마다 문서를 따로 저장하지만(영어 관계 문항·토익 표현
 *   시험·틀 시험) 같은 startedAt을 공유한다 — 한 판으로 묶어 점수를 합친다(`recentTemplateChoiceTests`와 같은 묶음 규칙).
 * - **센다 = 답한 문항(answered===true)이 하나라도 있는 판.** 스트릭(§17-1)과 같은 기준이라 상단 헤드라인이 "오늘 했다"고 할 때 목록도
 *   "오늘 ✓"다. 답한 문항 0인 판(바로 그만둠)은 없는 것으로 본다. 그만두기로 끝난 판(finishedAt null)도 답했으면 센다 — `finished:false`로
 *   알려 화면이 "중단"을 붙인다(시험 기록 화면의 "중단" 표시와 같은 사실).
 * - **점수 = 그 판의 맞힌 수 / 답한 문항 수.** 시험 기록 화면 셋(영어·일본어·토익)이 쓰는 분모와 같다(미응답은 분모에서 뺀다).
 * - **마지막 판 = startedAt이 가장 늦은 판.** 같은 날 여러 판이면 그중 마지막 판의 점수다. 모드가 여럿이어도 모드를 가리지 않는다.
 * - **오늘 = 마지막 판의 KST 일자가 `todayKst`와 같다**(lib/kst — 자정은 KST 00:00). `todayKst`는 서버가 요청 시점에 한 번 정해 넘긴다
 *   (목록 페이지는 force-dynamic 서버 컴포넌트 — SSR·클라이언트가 같은 값을 보인다).
 * - 시간대가 없거나 깨진 `startedAt`은 날짜를 정할 수 없어 건너뛴다(`isZonedIsoTimestamp` — 우리가 저장하는 값은 전부 통과).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/kst(import 0)뿐. 배지 문구(`testStatusLabelKo`)도 여기서 만들어 화면은 그대로 쓴다.
 */

import { isZonedIsoTimestamp, kstDateString } from "./kst";

/** 시험 세션 문서의 최소 형태 — VocabQuizRecord·JaQuizRecord·ToeicQuizRecord가 구조적으로 만족한다(bookId/setId는 호출측이 꺼낸다). */
export interface TestStatusSession {
  startedAt: string;
  finishedAt: string | null;
  items: readonly { correct: boolean; answered: boolean | null }[];
}

export type TestStatusState = "none" | "today" | "past";

export interface TestStatus {
  state: TestStatusState;
  /** 마지막 판의 KST 일자 `YYYY-MM-DD`. 시험 전이면 null */
  lastDate: string | null;
  /** 마지막 판의 맞힌 수(답한 문항 중). 시험 전이면 0 */
  correct: number;
  /** 마지막 판의 답한 문항 수(분모). 시험 전이면 0 */
  answered: number;
  /** 마지막 판의 문서가 모두 끝까지 풀렸는가(그만두기면 false). 시험 전이면 true */
  finished: boolean;
}

export const TEST_STATUS_NONE: TestStatus = { state: "none", lastDate: null, correct: 0, answered: 0, finished: true };

/**
 * 한 대상(단어장·표현집·폴더)의 세션들 → 배지 상태. 세션 순서는 무관하다.
 * @param todayKst 오늘 KST 일자 `YYYY-MM-DD`(kstTodayString())
 */
export function summarizeTestStatus(sessions: readonly TestStatusSession[], todayKst: string): TestStatus {
  // startedAt으로 판 묶기 — 답한 문항 수·맞힌 수·끝까지 풀었는가를 합친다
  const rounds = new Map<string, { correct: number; answered: number; finished: boolean }>();
  for (const s of sessions) {
    if (!isZonedIsoTimestamp(s.startedAt)) continue;
    const r = rounds.get(s.startedAt) ?? { correct: 0, answered: 0, finished: true };
    for (const it of s.items ?? []) {
      if (it.answered !== true) continue;
      r.answered += 1;
      if (it.correct === true) r.correct += 1;
    }
    if (s.finishedAt === null) r.finished = false;
    rounds.set(s.startedAt, r);
  }
  let lastAt: string | null = null;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const [at, r] of rounds) {
    if (r.answered === 0) continue; // 답한 문항 0인 판은 세지 않는다(§17-1과 같은 기준)
    const ms = Date.parse(at);
    // 같은 순간을 다른 표기로 적은 두 판이면 문자열이 큰 쪽(결정적)
    if (ms > lastMs || (ms === lastMs && lastAt !== null && at > lastAt)) {
      lastMs = ms;
      lastAt = at;
    }
  }
  if (lastAt === null) return TEST_STATUS_NONE;
  const r = rounds.get(lastAt)!;
  const lastDate = kstDateString(lastAt);
  return { state: lastDate === todayKst ? "today" : "past", lastDate, correct: r.correct, answered: r.answered, finished: r.finished };
}

/**
 * 여러 대상의 세션을 **한 번 읽은 목록**에서 대상별로 묶어 배지 상태를 낸다(목록마다 대상 수만큼 쿼리하지 않는다).
 * 목록에 없는 대상의 세션(지운 단어장의 잔여·틀 은행 세션 등)은 결과에 들어가도 화면이 찾지 않으니 무해하다.
 */
export function testStatusByTarget<T extends TestStatusSession>(
  sessions: readonly T[],
  targetOf: (s: T) => string,
  todayKst: string,
): Map<string, TestStatus> {
  const groups = new Map<string, T[]>();
  for (const s of sessions) {
    const key = targetOf(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out = new Map<string, TestStatus>();
  for (const [key, list] of groups) out.set(key, summarizeTestStatus(list, todayKst));
  return out;
}

/** 맵에서 대상 하나 — 세션이 없으면 시험 전 */
export function testStatusOf(map: ReadonlyMap<string, TestStatus>, id: string): TestStatus {
  return map.get(id) ?? TEST_STATUS_NONE;
}

/** `YYYY-MM-DD` → "M월 D일"(앞 0 없음). 올해(todayKst의 해)가 아니면 "YYYY년 M월 D일". 형식이 틀리면 원문 */
export function testStatusDateKo(date: string, todayKst: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const md = `${Number(m[2])}월 ${Number(m[3])}일`;
  return todayKst.slice(0, 4) === m[1] ? md : `${m[1]}년 ${md}`;
}

/**
 * 배지 문구 — "시험 전" / "오늘 ✓ · 8/10" / "✓ 10월 2일 · 8/10". 그만두기로 끝난 판이면 끝에 " · 중단".
 * 날짜 표시에 todayKst가 필요한 것은 해가 다를 때만이다.
 */
export function testStatusLabelKo(status: TestStatus, todayKst: string): string {
  if (status.state === "none" || status.lastDate === null) return "시험 전";
  const score = `${status.correct}/${status.answered}`;
  const tail = status.finished ? "" : " · 중단";
  if (status.state === "today") return `오늘 ✓ · ${score}${tail}`;
  return `✓ ${testStatusDateKo(status.lastDate, todayKst)} · ${score}${tail}`;
}

/** 목록 항목에 싣는 배지 데이터(서버 → 클라이언트 직렬화 가능) — 화면은 이것만 받는다(components/test-status-chip.tsx) */
export interface TestStatusBadge {
  state: TestStatusState;
  labelKo: string;
}

/** 상태 → 배지 데이터 */
export function toTestStatusBadge(status: TestStatus, todayKst: string): TestStatusBadge {
  return { state: status.state, labelKo: testStatusLabelKo(status, todayKst) };
}

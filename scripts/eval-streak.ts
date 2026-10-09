/**
 * scripts/eval-streak.ts — 학습 스트릭(연속 학습일) 회귀 가드 (docs/SPEC.md §17). **실호출 0회.**
 *
 * 스트릭은 **과목 교차 기능**이다(은우=영어 VocabQuizRecord, 아빠=일본어 JaQuizRecord·JaKanjiQuizRecord, §17-1).
 * docs/SPEC.md §17에 살고 어느 과목 하네스(english/math/japanese)에도 속하지 않아, 한 과목 eval에 붙이면
 * 오귀속이 된다 — 그래서 **별도 진입점**으로 둔다(eval:english가 lib/kst·lib/streak에 의존하게 만들지 않는다).
 *
 * 대상(순수 함수): computeStreak·computeStreakFromDays(lib/streak.ts) · kstDateString/formatKst/formatKstDate/isZonedIsoTimestamp/shiftDateString(lib/kst.ts).
 * formatKstDate 경계는 실행 기기 TZ에 기대지 않는다 — 판정을 값으로 단언하고, 같은 표를 TZ 3곳으로 바꿔 다시 돌린다(아래 "KST 환산").
 * computeStreak은 "오늘(todayKst)"을 인자로 받는 순수 함수라 현재 시각에 의존하지 않는다(테스트 안정, §17-2·17-6).
 * 운동 트랙의 "지킨 날" 계산(workoutKeptDays)은 운동 엔진 소관이라 eval-workout.ts가 잠근다(§17-7).
 * 아빠 · 🎙️ 영어 트랙(토익스피킹, docs/harness/toeic.md §0-2)은 toeicStreakSessions(lib/toeic-streak.ts)가 표현 시험(답한 문항≥1)과
 * 모의고사 응시(녹음된 문항≥1)를 세션 모양으로 옮긴다 — 아래 6)이 세는 규칙과 **트랙 분리**(은우·일본어·운동과 무혼합)를 반례로 잠근다.
 * 은우 트랙의 **자유대화**(SPEC §17-9 — 은우 트랙 한정 예외)는 talkStreakSessions(lib/talk-streak.ts)가 "은우 발화 ≥ 1 = 답한 문항"으로
 * 옮긴다 — 아래 7)이 발화 0 대화 제외·대화만 한 날·아빠 트랙 무오염·/api/streak 배선을 잠근다.
 * 목록 카드의 **시험 응시 배지**(SPEC §15-4 — lib/test-status.ts)도 KST "오늘"과 "답한 문항 ≥ 1" 기준을 스트릭과 공유하는 과목 교차 규칙이라
 * 여기서 잠근다 — 아래 8)이 세션 0개·자정 KST·같은 날 여러 판·혼합 판 묶기·미완료 판·공략 폴더 틀 세션·네 목록 배선을 반례로 본다.
 */

import { readFileSync } from "node:fs";
import { computeStreak, computeStreakFromDays, streakDays, type StreakSession } from "../lib/streak";
import { formatKst, formatKstDate, isZonedIsoTimestamp, kstDateString, shiftDateString } from "../lib/kst";
import { isCountedToeicAttempt, toeicAttemptStreakLabel, toeicQuizStreakLabel, toeicStreakSessions, type ToeicQuizLabelNames } from "../lib/toeic-streak";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, isToeicGuidePart } from "../lib/toeic-guide";
import { toeicMockPartLabelKo } from "../lib/toeic-mock-contract";
import { TOEIC_TEMPLATE_BANK_MODE_LABELS_KO, isToeicTemplateBankMode } from "../lib/toeic-quiz";
import { isCountedTalkSession, talkStreakLabel, talkStreakSessions } from "../lib/talk-streak";
import {
  TEST_STATUS_NONE,
  summarizeTestStatus,
  testStatusByTarget,
  testStatusDateKo,
  testStatusLabelKo,
  testStatusOf,
  toTestStatusBadge,
  type TestStatusSession,
} from "../lib/test-status";
import { templateSessionsForPart } from "../lib/toeic-guide-view";
import { reviewFullDays, reviewStreakSessions, reviewTodayLabel } from "../lib/review-schedule";
import { APPA_BOTH_FROM, FREEZES_PER_MONTH, STREAK_BADGES, STREAK_V2_FROM, badgesOf, decideBridges, doneForPush, kstWeekDays, litDaysOf, needsMoreToday, repairHintText, streakFromStatus, weekCells } from "../lib/streak-v2";
import { appaInputV2, appaPersonV2, appaTodayLabel, familyV2, personV2, trackV2 } from "../lib/streak-v2-assemble";
import { addDays, addRuns, isFullAttempt, isFullFrameDrill, isFullMomLessonRecord, isFullQuiz, isFullTalk } from "../lib/streak-v2-sources";
import { decidePushes, isQuietHHMM, kstHalfHourHHMM, pushStates, pushText, PUSH_DAILY_MAX, TICK_SKEW_MS } from "../lib/push-decide";
import type { PersonStreak, StreakResponse } from "../lib/streak-contract";
import { DEFAULT_PUSH_PREFS } from "../lib/push-contract";
import { MOM_REVIEW_WEEKS, momStreakWeekKo } from "../lib/mom-plan";
import { PERSON_HUB_HREF, personOfPath } from "../lib/person-area";
import { EXAM_SCREEN_EXTRA_PATHS, EXAM_SCREEN_STREAK_H_CSS, isExamScreen, isExamScreenPath } from "../lib/exam-screen";

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| ${"결과".padEnd(4)} | ${"영역".padEnd(14)} | 점검 항목 | 상세 |`);
  console.log(`|------|----------------|-----------|------|`);
  for (const r of results) {
    console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.book.padEnd(14)} | ${r.check} | ${r.detail} |`);
  }
  console.log("");
}

/** KST 일자 D에 세는 세션 — 12:00 KST(=03:00Z)라 UTC·KST 일자가 같아 픽스처가 헷갈리지 않는다. */
function at(kstDate: string, answered: boolean | null = true): StreakSession {
  return { startedAt: `${kstDate}T03:00:00.000Z`, items: [{ answered }] };
}

const results: CheckResult[] = [];
const add = (book: string, check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

// ---------------------------------------------------------------------------
// 1) KST 일자 환산 — 자정 경계 양쪽, UTC 날짜와 다른 날 (§17-2)
// ---------------------------------------------------------------------------
add("KST 환산", "15:00Z → 다음날 KST(+9h 자정 넘김)", kstDateString("2026-09-20T15:00:00.000Z") === "2026-09-21", `→ ${kstDateString("2026-09-20T15:00:00.000Z")}`);
add("KST 환산", "14:59Z → 같은날 KST(자정 직전)", kstDateString("2026-09-20T14:59:59.000Z") === "2026-09-20", `→ ${kstDateString("2026-09-20T14:59:59.000Z")}`);
add("KST 환산", "00:00Z → 같은날 KST(09:00 KST)", kstDateString("2026-09-20T00:00:00.000Z") === "2026-09-20", `→ ${kstDateString("2026-09-20T00:00:00.000Z")}`);
add("KST 환산", "formatKst 15:00Z → 2026.09.21 00:00", formatKst("2026-09-20T15:00:00.000Z") === "2026.09.21 00:00", `→ ${formatKst("2026-09-20T15:00:00.000Z")}`);
add("KST 환산", "shiftDateString 월말 경계(-1)", shiftDateString("2026-10-01", -1) === "2026-09-30", `→ ${shiftDateString("2026-10-01", -1)}`);

// "만든 날짜" 표시(formatKstDate) — 목록·상세·카드 이력이 createdAt을 이 함수로만 보인다(예전엔 UTC 날짜부 자르기라
// KST 00:00~08:59에 만든 기록이 전날로 보였다). 깨진 값은 예전 동작(원문 앞 10자, -→.)으로 떨어져야 하고, 시간대 없는
// 시각·달력에 없는 날은 엔진마다 해석이 갈려(로컬 시각·V8 굴림) hydration이 깨지므로 KST 환산에 넘기지 않는다.
const FMT_CASES: { input: string; want: string; why: string }[] = [
  { input: "2026-09-20T15:00:00.000Z", want: "2026.09.21", why: "15:00Z → 다음날(KST 00:00)" },
  { input: "2026-09-20T14:59:59.999Z", want: "2026.09.20", why: "14:59:59Z → 같은날(KST 23:59)" },
  { input: "2026-09-20T00:00:00.000Z", want: "2026.09.20", why: "00:00Z → 같은날(KST 09:00)" },
  { input: "2026-12-31T15:00:00.000Z", want: "2027.01.01", why: "연말 15:00Z → 새해(연 경계)" },
  { input: "2026-09-21T00:30:00+09:00", want: "2026.09.21", why: "+09:00 오프셋 → 그대로 KST 날짜" },
  { input: "2026-09-20", want: "2026.09.20", why: "날짜만(UTC 자정) → 같은날" },
  { input: "garbage", want: "garbage", why: "깨진 입력 → 원문 앞 10자" },
  { input: "", want: "", why: "빈 문자열 → 빈 문자열(throw 없음)" },
  { input: "2026-09-20T20:00:00", want: "2026.09.20", why: "시간대 없는 시각 → 환산 안 함(로컬 해석 차단)" },
  { input: "2026-02-30T15:00:00.000Z", want: "2026.02.30", why: "달력에 없는 날 → 환산 안 함(V8 굴림 차단)" },
  { input: "2026-09-20T24:00:00Z", want: "2026.09.20", why: "24:00 → 환산 안 함(엔진별 해석 차단)" },
  { input: "2026-09-20T15:00:00.123456Z", want: "2026.09.20", why: "소수 4자리 이상 → 환산 안 함(ES 형식 밖·엔진 재량)" },
];
for (const c of FMT_CASES) {
  const got = formatKstDate(c.input);
  add("KST 환산", `formatKstDate ${c.why}`, got === c.want, `${JSON.stringify(c.input)} → ${JSON.stringify(got)}`);
}
{
  // 실행 환경 시간대와 무관 — +9h→getUTC*만 쓰므로 TZ를 바꿔도 같은 값(서버 UTC·폰 KST SSR/hydration 일치의 근거)
  const probe = "2026-09-20T15:00:00.000Z";
  add("KST 환산", "formatKstDate = kstDateString의 -→. (단일 정의)", formatKstDate(probe) === kstDateString(probe).replace(/-/g, "."), `→ ${formatKstDate(probe)}`);
}

// 위 표는 이 eval을 돌리는 기기의 TZ에서만 돈다. 그런데 KST 기기에서는 "시간대 없는 시각"을 로컬(KST)로 읽고 +9h를 해도
// 원래 날짜로 돌아와, 가드를 지워도 결과가 같다(QA F1 — 가드가 잠기지 않았다). 그래서 두 겹으로 잠근다.
// ① 판정 자체(isZonedIsoTimestamp)를 값으로 단언한다 — 참/거짓만 보므로 실행 TZ와 무관하다.
// ② 같은 표를 TZ=Asia/Seoul·UTC·America/Los_Angeles로 바꿔 가며 다시 돌린다. Node는 process.env.TZ 대입을 즉시 반영한다 —
//    반영됐는지 먼저 확인(로컬 생성자 → UTC)해, 전환이 먹지 않는 환경에서 조용히 빈 검사가 되지 않게 한다.
{
  const accept = [
    "2026-09-20T15:00:00.000Z", // toISOString 그대로(저장 형식)
    "2026-09-20", // 날짜만(UTC 자정)
    "2026-09-20T15:00Z", // 초 생략
    "2026-09-20T15:00:00Z",
    "2026-09-20T15:00:00.1Z", // 소수 1~2자리 — 밀리초로 정확히 떨어진다
    "2026-09-20T15:00:00.12Z",
    "2026-09-21T00:30:00+09:00",
    "2026-09-20T23:59:59.999-00:00",
    "2028-02-29T00:00:00.000Z", // 윤년
  ];
  const rejectNoZone = ["2026-09-20T20:00:00", "2026-09-20T20:00", "2026-09-20T20:00:00.000"];
  const rejectRange = [
    "2026-09-20T15:00:00.1234Z", // 소수 4자리 이상
    "2026-09-20T15:00:00.123456Z",
    "2026-09-20T24:00:00Z", // 24:00
    "2026-09-20T23:60:00Z",
    "2026-09-20T23:59:60Z",
    "2026-09-20T15:00:00+24:00",
    "2026-02-30T15:00:00.000Z", // 달력에 없는 날
    "2027-02-29",
    "2026-09-20T15:00:00.000z", // 소문자 z
    "2026-09-20 15:00:00Z", // T 대신 공백
    "garbage",
    "",
  ];
  const nonStrings: unknown[] = [undefined, null, 1758380400000, new Date("2026-09-20T15:00:00.000Z"), new String("2026-09-20"), { toString: () => "2026-09-20" }];
  const wrongAccept = accept.filter((x) => !isZonedIsoTimestamp(x));
  const wrongNoZone = rejectNoZone.filter((x) => isZonedIsoTimestamp(x));
  const wrongRange = rejectRange.filter((x) => isZonedIsoTimestamp(x));
  // 던져도 "거절 못 함"으로 센다 — 가드가 빠지면 toString 객체가 패턴을 통과한 뒤 .slice에서 던진다(크래시 대신 FAIL 행으로)
  const wrongNonString = nonStrings
    .filter((x) => {
      try {
        return isZonedIsoTimestamp(x);
      } catch {
        return true;
      }
    })
    .map((x) => Object.prototype.toString.call(x));
  add("KST 환산", `isZonedIsoTimestamp 받음 — 저장 형식·날짜만·초 생략·소수 1~3자리·오프셋·윤년 (${accept.length}건)`, wrongAccept.length === 0, wrongAccept.length === 0 ? "전부 true" : `false: ${JSON.stringify(wrongAccept)}`);
  add("KST 환산", `isZonedIsoTimestamp 거절 — 시간대 없는 시각(실행 TZ와 무관한 판정, ${rejectNoZone.length}건)`, wrongNoZone.length === 0, wrongNoZone.length === 0 ? "전부 false" : `true: ${JSON.stringify(wrongNoZone)}`);
  add("KST 환산", `isZonedIsoTimestamp 거절 — 소수 4자리+·24:00·60분초·오프셋 범위 밖·달력 밖·형식 밖 (${rejectRange.length}건)`, wrongRange.length === 0, wrongRange.length === 0 ? "전부 false" : `true: ${JSON.stringify(wrongRange)}`);
  add("KST 환산", `isZonedIsoTimestamp 거절 — 비문자열(undefined·null·숫자·Date·String 객체·toString 객체, ${nonStrings.length}건)`, wrongNonString.length === 0, wrongNonString.length === 0 ? "전부 false" : `true: ${JSON.stringify(wrongNonString)}`);
}
{
  // 옛 레코드(필드 없음)·깨진 문서가 화면을 죽이지 않는다 — 비문자열은 throw 없이 "" (typeof 가드, QA F1 M7)
  const got = [undefined, null, 1758380400000, {}].map((x) => {
    try {
      return formatKstDate(x as unknown as string);
    } catch (e) {
      return `THROW ${(e as Error).message}`;
    }
  });
  add("KST 환산", "formatKstDate 비문자열(undefined·null·숫자·객체) → \"\"(throw 없음)", got.every((g) => g === ""), JSON.stringify(got));
}
{
  // 로컬 생성자 2026-09-20 20:00 → UTC. TZ 전환이 실제로 먹었는지의 증거(LA는 9월에 PDT = UTC-7)
  const TZ_MATRIX: { tz: string; local2000: string }[] = [
    { tz: "Asia/Seoul", local2000: "2026-09-20T11:00:00.000Z" },
    { tz: "UTC", local2000: "2026-09-20T20:00:00.000Z" },
    { tz: "America/Los_Angeles", local2000: "2026-09-21T03:00:00.000Z" },
  ];
  const hadTz = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const originalTz = process.env.TZ;
  try {
    for (const { tz, local2000 } of TZ_MATRIX) {
      process.env.TZ = tz;
      const probe = new Date(2026, 8, 20, 20, 0, 0).toISOString();
      const bad = FMT_CASES.map((c) => ({ c, got: formatKstDate(c.input) })).filter(({ c, got }) => got !== c.want);
      add(
        "KST 환산",
        `formatKstDate 경계표 ${FMT_CASES.length}건 — TZ=${tz}에서도 같음(TZ 전환 확인 포함)`,
        probe === local2000 && bad.length === 0,
        probe !== local2000
          ? `TZ 전환이 반영되지 않음: 로컬 20:00 → ${probe} (기대 ${local2000})`
          : bad.length === 0
            ? `전부 일치 · 로컬 20:00 → ${probe}`
            : bad.map(({ c, got }) => `${JSON.stringify(c.input)} → ${JSON.stringify(got)} (기대 ${c.want})`).join(" / "),
      );
    }
  } finally {
    if (hadTz) process.env.TZ = originalTz;
    else delete process.env.TZ;
  }
}

// ---------------------------------------------------------------------------
// 2) 연속 판정 (§17-3)
// ---------------------------------------------------------------------------
const TODAY = "2026-09-21";
{
  // ① 오늘 함 → 오늘 포함 3연속
  const r = computeStreak([at("2026-09-19"), at("2026-09-20"), at("2026-09-21")], TODAY);
  add("연속 판정", "① 오늘 함 → current 3·doneToday·lastDate 오늘", r.current === 3 && r.doneToday && r.lastDate === "2026-09-21" && r.best === 3, JSON.stringify(r));
}
{
  // ② 오늘 안 했고 어제 함 → 어제까지 살아 있음(current 2, doneToday false)
  const r = computeStreak([at("2026-09-19"), at("2026-09-20")], TODAY);
  add("연속 판정", "② 오늘 안 함·어제 함 → current 2·doneToday false·lastDate 어제", r.current === 2 && !r.doneToday && r.lastDate === "2026-09-20", JSON.stringify(r));
}
{
  // ③ 그제까지만 → 끊김(0)
  const r = computeStreak([at("2026-09-18"), at("2026-09-19")], TODAY);
  add("연속 판정", "③ 그제까지만 → current 0(끊김)·doneToday false", r.current === 0 && !r.doneToday && r.lastDate === "2026-09-19", JSON.stringify(r));
}
{
  // ④ 같은 날 여러 세션 → 하루로 접힘
  const r = computeStreak([at("2026-09-21"), at("2026-09-21"), at("2026-09-21")], TODAY);
  add("연속 판정", "④ 같은 날 3세션 → current 1(하루로 접힘)", r.current === 1 && r.doneToday && r.best === 1, JSON.stringify(r));
}
{
  // ⑤ best(과거 최고) — 3연속(끊김)2연속, 오늘 포함
  const r = computeStreak([at("2026-09-10"), at("2026-09-11"), at("2026-09-12"), at("2026-09-20"), at("2026-09-21")], TODAY);
  add("연속 판정", "⑤ best=과거 최고 3, current=2(오늘 포함)", r.best === 3 && r.current === 2 && r.doneToday, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 3) 답한 문항 0 세션 제외 (§17-1 마지막 문단)
// ---------------------------------------------------------------------------
{
  // 오늘 세션이 answered:null(그만하기)뿐 → 안 셈: current 0, lastDate null
  const r = computeStreak([at("2026-09-21", null)], TODAY);
  add("0문항 제외", "answered:null만 있으면 current 0·lastDate null", r.current === 0 && !r.doneToday && r.lastDate === null, JSON.stringify(r));
}
{
  // answered:false도 시도로 안 셈(hasAnswered는 ===true만)
  const r = computeStreak([at("2026-09-21", false)], TODAY);
  add("0문항 제외", "answered:false도 제외(current 0)", r.current === 0 && r.lastDate === null, JSON.stringify(r));
}
{
  // 같은 날 answered:null 세션 + answered:true 세션 → 그 날은 센다(답한 세션이 있으므로)
  const r = computeStreak([at("2026-09-21", null), at("2026-09-21", true)], TODAY);
  add("0문항 제외", "같은 날 0문항+답한 세션 공존 → 그 날 셈(current 1)", r.current === 1 && r.doneToday, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 4) 사람 분리 — 은우 세션과 아빠 세션이 섞이면 값이 달라진다(§17-6, 값으로 고정)
// computeStreak은 한 사람분만 받는다(분리는 호출측 책임). 섞으면 doneToday·current가 실제로 달라짐을 못박는다.
// ---------------------------------------------------------------------------
{
  const eunwoo = [at("2026-09-20")]; // 은우: 어제만
  const appa = [at("2026-09-21")]; // 아빠: 오늘만
  const rEunwoo = computeStreak(eunwoo, TODAY);
  const rAppa = computeStreak(appa, TODAY);
  const rMerged = computeStreak([...eunwoo, ...appa], TODAY); // 섞으면(잘못) 오늘+어제 2연속

  // 분리 계산: 은우는 아직 안 함(어제까지 살아 current 1), 아빠는 오늘 함(current 1)
  const separated = rEunwoo.current === 1 && !rEunwoo.doneToday && rAppa.current === 1 && rAppa.doneToday;
  // 섞으면 값이 달라진다: current 2·doneToday true (은우가 오늘 한 것처럼 보인다)
  const mergedDiffers = rMerged.current === 2 && rMerged.doneToday && rMerged.current !== rEunwoo.current;
  add(
    "사람 분리",
    "은우(어제만)·아빠(오늘만) 분리 값 고정 + 섞으면 달라짐(오염 반례)",
    separated && mergedDiffers,
    `은우=${JSON.stringify(rEunwoo)} 아빠=${JSON.stringify(rAppa)} 섞음=${JSON.stringify(rMerged)}`,
  );
}
{
  // 세션 없음(콜드스타트) → 전부 0/null
  const r = computeStreak([], TODAY);
  add("사람 분리", "세션 없으면 current 0·doneToday false·lastDate null·best 0", r.current === 0 && !r.doneToday && r.lastDate === null && r.best === 0, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 5) 날짜 집합 코어 — computeStreakFromDays (§17-7). 운동 트랙(아빠 · 운동)이 세션이 아니라 "지킨 날" 집합으로 부른다.
// 위 1~4의 항목은 코어 분리 뒤에도 그대로 통과해야 한다(computeStreak = 세션 → 날짜 집합 → 코어, 동작 불변).
// ---------------------------------------------------------------------------
{
  // 배열·Set 둘 다 받는다 — 같은 날짜 집합이면 같은 답
  const arr = computeStreakFromDays(["2026-09-19", "2026-09-20", "2026-09-21"], TODAY);
  const set = computeStreakFromDays(new Set(["2026-09-19", "2026-09-20", "2026-09-21"]), TODAY);
  add(
    "날짜 코어",
    "배열·Set 입력 → 같은 값(current 3·doneToday·best 3·lastDate 오늘)",
    arr.current === 3 && arr.doneToday && arr.best === 3 && arr.lastDate === TODAY && JSON.stringify(arr) === JSON.stringify(set),
    `배열=${JSON.stringify(arr)} Set=${JSON.stringify(set)}`,
  );
}
{
  // 정렬 안 된·중복 있는 배열 → 날짜 집합으로 접는다
  const r = computeStreakFromDays(["2026-09-21", "2026-09-19", "2026-09-21", "2026-09-20"], TODAY);
  add("날짜 코어", "정렬 안 됨·중복 → 집합으로 접힘(current 3·best 3·lastDate 오늘)", r.current === 3 && r.best === 3 && r.lastDate === TODAY, JSON.stringify(r));
}
{
  // 어제까지 살아 있음 / 끊김 / 빈 집합 — §17-3 규칙이 코어에 그대로
  const alive = computeStreakFromDays(["2026-09-19", "2026-09-20"], TODAY);
  const broken = computeStreakFromDays(["2026-09-18", "2026-09-19"], TODAY);
  const empty = computeStreakFromDays([], TODAY);
  add(
    "날짜 코어",
    "어제까지 → current 2·doneToday false / 그제까지 → 0 / 빈 집합 → 0·null·best 0",
    alive.current === 2 && !alive.doneToday && broken.current === 0 && broken.best === 2 && empty.current === 0 && empty.lastDate === null && empty.best === 0,
    `살아있음=${JSON.stringify(alive)} 끊김=${JSON.stringify(broken)} 빈=${JSON.stringify(empty)}`,
  );
}
{
  // 코어 분리 회귀 — computeStreak(세션)와 computeStreakFromDays(답한 세션의 KST 일자)가 모든 픽스처에서 같다
  const fixtures: StreakSession[][] = [
    [at("2026-09-19"), at("2026-09-20"), at("2026-09-21")],
    [at("2026-09-10"), at("2026-09-11"), at("2026-09-12"), at("2026-09-20"), at("2026-09-21")],
    [at("2026-09-21", null), at("2026-09-20", true), at("2026-09-19", false)],
    // 자정 경계 — 15:00Z는 다음 날 KST
    [{ startedAt: "2026-09-19T15:00:00.000Z", items: [{ answered: true }] }, at("2026-09-21")],
    [],
  ];
  const bad = fixtures.filter((f) => {
    const days = f.filter((s) => s.items.some((i) => i.answered === true)).map((s) => kstDateString(s.startedAt));
    return JSON.stringify(computeStreak(f, TODAY)) !== JSON.stringify(computeStreakFromDays(days, TODAY));
  });
  add("날짜 코어", "computeStreak = 세션 → KST 일자 집합 → 코어(픽스처 5종 전부 같음)", bad.length === 0, bad.length === 0 ? "5/5 일치" : `불일치 ${bad.length}건`);
}
{
  // 트랙 분리 — 일본어 날짜와 운동 날짜를 섞으면 값이 달라진다(§17-7 "두 트랙을 한 스트릭으로 합치지 않는다")
  const ja = ["2026-09-19"]; // 일본어: 그제만 → 끊김
  const workout = ["2026-09-20", "2026-09-21"]; // 운동: 어제·오늘
  const rJa = computeStreakFromDays(ja, TODAY);
  const rMerged = computeStreakFromDays([...ja, ...workout], TODAY);
  add(
    "날짜 코어",
    "일본어(그제만)는 0 — 운동 날짜를 섞으면 3연속으로 이어져 보인다(오염 반례)",
    rJa.current === 0 && rMerged.current === 3 && rMerged.doneToday,
    `일본어=${JSON.stringify(rJa)} 섞음=${JSON.stringify(rMerged)}`,
  );
}

// ---------------------------------------------------------------------------
// 6) 아빠 · 🎙️ 영어 트랙(토익스피킹, toeic.md §0-2) — 세는 규칙 + 트랙 분리(은우·일본어·운동·영어 무혼합)
// ---------------------------------------------------------------------------
{
  /** 토익 표현 시험 세션(ToeicQuizRecord 최소 모양) */
  const tq = (kstDate: string, answered: boolean | null = true) => ({ startedAt: `${kstDate}T03:00:00.000Z`, items: [{ answered }] });
  /** 토익 모의고사 응시(ToeicAttemptRecord 최소 모양) — recorded 배열 */
  const ta = (kstDate: string, recorded: boolean[]) => ({ startedAt: `${kstDate}T03:00:00.000Z`, answers: recorded.map((r) => ({ recorded: r })) });

  // ① 표현 시험(답함) + 응시(녹음 1개 이상)가 각각 하루를 센다 — 어제 응시 + 오늘 시험 → 2연속
  const both = computeStreak(toeicStreakSessions([tq("2026-09-21")], [ta("2026-09-20", [true, false])]), TODAY);
  add("영어 트랙", "① 오늘 표현 시험 + 어제 응시(녹음 1개) → current 2·doneToday", both.current === 2 && both.doneToday, JSON.stringify(both));

  // ② 녹음이 하나도 끝나지 않은 응시(전부 recorded:false)는 세지 않는다 — "녹음 0 응시 제외"
  const noRec = computeStreak(toeicStreakSessions([], [ta("2026-09-21", [false, false, false])]), TODAY);
  add(
    "영어 트랙",
    "② 녹음 0 응시는 제외(current 0·lastDate null) + isCountedToeicAttempt 판정 일치",
    noRec.current === 0 && noRec.lastDate === null && !isCountedToeicAttempt(ta("x", [false])) && isCountedToeicAttempt(ta("x", [false, true])),
    JSON.stringify(noRec),
  );

  // ③ 답한 문항 0(그만하기만)인 표현 시험은 세지 않는다(§17-1 규칙이 영어 트랙에도)
  const noAns = computeStreak(toeicStreakSessions([tq("2026-09-21", null), tq("2026-09-21", false)], []), TODAY);
  add("영어 트랙", "③ answered:null·false뿐인 표현 시험은 제외(current 0)", noAns.current === 0 && noAns.lastDate === null, JSON.stringify(noAns));

  // ④ 트랙 분리 반례 — 은우(오늘)·일본어(어제)·운동(그제)·영어(나흘 전만). 분리하면 영어는 0(끊김),
  //    섞으면 오늘까지 3연속으로 이어져 보인다(영어만 안 한 날이 "했다"로 오염).
  const eunwooDays = ["2026-09-21"];
  const jaDays = ["2026-09-20"];
  const workoutDays = ["2026-09-19"];
  const english = computeStreak(toeicStreakSessions([tq("2026-09-17")], []), TODAY);
  const merged = computeStreakFromDays([...eunwooDays, ...jaDays, ...workoutDays, "2026-09-17"], TODAY);
  add(
    "영어 트랙",
    "④ 트랙 분리: 영어(나흘 전만)는 0 — 은우·일본어·운동 날짜를 섞으면 3연속으로 이어져 보인다(오염 반례)",
    english.current === 0 && !english.doneToday && merged.current === 3 && merged.doneToday,
    `영어=${JSON.stringify(english)} 섞음=${JSON.stringify(merged)}`,
  );

  // ⑤ 역방향 — 영어만 오늘 한 날에 일본어 트랙(어제까지)이 "오늘 함"으로 바뀌지 않는다(각자 계산)
  const jaOnly = computeStreakFromDays(jaDays, TODAY);
  const enToday = computeStreak(toeicStreakSessions([tq("2026-09-21")], []), TODAY);
  add(
    "영어 트랙",
    "⑤ 영어만 오늘 함 → 영어 doneToday, 일본어는 여전히 오늘 아직(각자 계산)",
    enToday.doneToday && !jaOnly.doneToday && jaOnly.current === 1,
    `영어=${JSON.stringify(enToday)} 일본어=${JSON.stringify(jaOnly)}`,
  );

  // ⑥ 라우트 배선(정적) — /api/streak가 영어 트랙을 **토익 두 컬렉션만으로** 계산하고, 은우·일본어 계산식은 그대로인가.
  //    누가 영어 날짜를 일본어·은우 계산에 섞거나(한 집합), 영어 트랙에 은우 vocabQuizzes를 넣으면 여기서 걸린다.
  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  // 2026-10-03 소재별 틀 말하기(toeic.md §20-9) — 셋째 인자 frameDrills(토익 컬렉션 toeicFrameDrills)만 더해졌다
  //    2026-10-08(§17-10) — 세션을 변수(toeicSessions·jaSessions)로 받아 어학 합집합에도 쓰게 했다. 식 자체는 같다.
  const wiredEnglish = /const toeicSessions: StreakSession\[\] = \[\.\.\.toeicStreakSessions\(toeicQuizzes, toeicAttempts, frameDrills\), \.\.\.reviewStreakSessions\(reviewsOf\("toeic"\)\)\];/.test(route) && /info: computeStreak\(toeicSessions, today\)/.test(route) && /const frameDrills = toeicFrameDrills \?\? \[\];/.test(route);
  // 은우 계산식 — §17-9부터 단어장 시험 + 자유대화(talkStreakSessions)다. 그 밖의 것(토익·일본어)은 여기 섞이지 않는다(noLeak).
  const eunwooUntouched = /computeStreak\(\[\.\.\.vocab, \.\.\.talkStreakSessions\(talks\), \.\.\.reviewStreakSessions\(reviewsOf\("english"\)\)\], today\)/.test(route);
  const jaUntouched = /const jaSessions: StreakSession\[\] = \[\.\.\.jaVocab, \.\.\.jaKanji, \.\.\.reviewStreakSessions\(reviewsOf\("japanese"\)\)\];/.test(route) && /info: computeStreak\(jaSessions, today\)/.test(route);
  const noLeak = !/toeicStreakSessions\([^)]*\b(vocab|jaVocab|jaKanji)\b/.test(route) && !/computeStreak\(\[\.\.\.(?:vocab|jaVocab)\b[^\]]*toeic/i.test(route);
  add(
    "영어 트랙",
    "⑥ /api/streak 배선: 영어=toeicStreakSessions(토익 컬렉션 — 표현 시험·응시 + 틀 말하기)만, 은우(단어장+자유대화 §17-9)·일본어 계산식 그대로",
    wiredEnglish && eunwooUntouched && jaUntouched && noLeak,
    `영어배선=${wiredEnglish} 은우=${eunwooUntouched} 일본어=${jaUntouched} 무혼합=${noLeak}`,
  );
  // ⑥-2 틀 말하기 배선(toeic.md §20-9) — 읽기 실패는 null → [](표현 시험·응시만으로), 라벨은 셋 중 가장 늦게 시작한 판
  const frameFallback = /listToeicFrameDrillSessions\(\)\.catch\(/.test(route);
  const frameLabel = /toeicFrameDrillStreakLabel\(tFrame, TOEIC_LABEL_NAMES\.guidePartKo\)/.test(route) && /it\.outcome === "spoken"/.test(route);
  const frameNoLeak = !/computeStreak\(\[\.\.\.(?:vocab|jaVocab)\b[^\]]*frameDrills/.test(route) && (route.match(/frameDrills\)/g) ?? []).length === 1;
  add(
    "영어 트랙",
    "⑥-2 /api/streak 틀 말하기: 영어 트랙 셋째 인자로만·읽기 실패 폴백·오늘 라벨(말한 문항 ≥1 판)",
    frameFallback && frameLabel && frameNoLeak,
    `폴백=${frameFallback} 라벨=${frameLabel} 무혼합=${frameNoLeak}`,
  );

  // ⑦ 오늘 라벨(docs/harness/toeic.md §12-9) — 계산식은 그대로, 라벨만 가른다. 이름표는 라우트와 같은 단일 정의처에서.
  const names: ToeicQuizLabelNames = {
    // 2026-10-02(docs/harness/toeic.md §12-13-2·§12-13-5) — 틀 모드 다섯(② 말하기 둘 + ③ 틀 시험 고르기 셋)
    templateModeKo: (m) => (isToeicTemplateBankMode(m) ? TOEIC_TEMPLATE_BANK_MODE_LABELS_KO[m] : null),
    guidePartKo: (p) => (isToeicGuidePart(p) ? toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[p]) : null),
  };
  const bankSet = { titleKo: "템플릿 훈련", guide: { kind: "templates", flows: [], items: [] } };
  const partSet = { titleKo: "Q3–4 사진 묘사", guide: { kind: "part", part: "q3_4", sections: [] } };
  const legacyPart = { titleKo: "Q11 의견 말하기", guide: { part: "q11", sections: [] } }; // kind 없음 → "part"로 읽는다
  const brokenPart = { titleKo: "지어낸 세트", guide: { kind: "part", part: "q1_2" } }; // 유형 밖 → 표현집 라벨로
  const bookSet = { titleKo: "DAY 03 여행", guide: null };
  const labels = {
    recall: toeicQuizStreakLabel({ mode: "tpl-recall" }, bankSet, names),
    swap: toeicQuizStreakLabel({ mode: "tpl-swap" }, null, names),
    choice: toeicQuizStreakLabel({ mode: "tpl-ko-frame" }, bankSet, names),
    cloze: toeicQuizStreakLabel({ mode: "tpl-cloze" }, null, names),
    guide: toeicQuizStreakLabel({ mode: "speak" }, partSet, names),
    legacy: toeicQuizStreakLabel({ mode: "ko-to-expr" }, legacyPart, names),
    broken: toeicQuizStreakLabel({ mode: "speak" }, brokenPart, names),
    book: toeicQuizStreakLabel({ mode: "ko-to-expr" }, bookSet, names),
    none: toeicQuizStreakLabel({ mode: "speak" }, null, names),
  };
  add(
    "영어 트랙",
    "⑦ 오늘 라벨: 틀 테스트·틀 시험 `템플릿 훈련 · {모드}`(유형 이름 없음 — 모드 다섯) · 공략 `공략 표현 · {유형}` · 표현집 `표현집 · {세트}` 그대로",
    labels.recall === "템플릿 훈련 · 예문 말하기" &&
      labels.swap === "템플릿 훈련 · 틀 바꿔 말하기" &&
      labels.choice === "템플릿 훈련 · 한→영 고르기" &&
      labels.cloze === "템플릿 훈련 · 빈칸 채우기" &&
      labels.guide === "공략 표현 · Q3–4 사진 묘사" &&
      labels.legacy === "공략 표현 · Q11 의견 말하기" &&
      labels.broken === "표현집 · 지어낸 세트" &&
      labels.book === "표현집 · DAY 03 여행" &&
      labels.none === "표현집",
    JSON.stringify(labels),
  );
  // 틀 모드 세션도 영어 트랙에 든다(모드를 보지 않는다 — 답한 문항 ≥ 1) + 라우트가 라벨을 이 함수로 만든다(소스 대조)
  const tplDay = computeStreak(toeicStreakSessions([{ startedAt: "2026-09-21T03:00:00.000Z", items: [{ answered: true }] }], []), TODAY);
  const labelWired = /toeicQuizStreakLabel\(tQuiz, set, TOEIC_LABEL_NAMES\)/.test(route) && /isToeicTemplateBankMode\(mode\) \? TOEIC_TEMPLATE_BANK_MODE_LABELS_KO\[mode\]/.test(route) && /toeicMockPartLabelKo\(TOEIC_GUIDE_PART_TO_MOCK_PART\[part\]\)/.test(route);
  add(
    "영어 트랙",
    "⑦ 틀 테스트 세션(답한 문항 ≥ 1)도 영어 트랙에 든다 + /api/streak가 라벨을 toeicQuizStreakLabel(단일 정의처 이름표)로 만든다",
    tplDay.doneToday && tplDay.current === 1 && labelWired,
    `오늘=${JSON.stringify(tplDay)} 라벨배선=${labelWired}`,
  );

  // ⑧ 한 문제 연습 응시(§12-9) — 계산식 그대로(녹음된 문항 ≥ 1 응시), 라벨만 `공략 연습 · {유형}`. 이름표는 라우트와 같은 단일 정의처.
  const drillPartKo = (p: string) => (["read", "picture", "respond", "info", "opinion"].includes(p) ? toeicMockPartLabelKo(p as "picture") : null);
  const aLabels = {
    drill: toeicAttemptStreakLabel({ titleKo: "사진 묘사 연습 2", drillPart: "picture" }, drillPartKo),
    drill11: toeicAttemptStreakLabel({ titleKo: "의견 말하기 연습 1", drillPart: "opinion" }, drillPartKo),
    mock: toeicAttemptStreakLabel({ titleKo: "모의고사 4", drillPart: null }, drillPartKo),
    legacy: toeicAttemptStreakLabel({ titleKo: "모의고사 1", drillPart: undefined }, drillPartKo),
    broken: toeicAttemptStreakLabel({ titleKo: "모의고사 5", drillPart: "q3_4" }, drillPartKo),
    none: toeicAttemptStreakLabel(null, drillPartKo),
  };
  const drillDay = computeStreak(toeicStreakSessions([], [ta("2026-09-21", [true])]), TODAY);
  const drillNoRec = computeStreak(toeicStreakSessions([], [ta("2026-09-21", [false])]), TODAY);
  const attemptLabelWired = /toeicAttemptStreakLabel\(mock, TOEIC_DRILL_PART_KO\)/.test(route) && /toeicMockPartLabelKo\(part as ToeicMockPart\)/.test(route);
  add(
    "영어 트랙",
    "⑧ 연습 응시 라벨 `공략 연습 · {유형}`(모의고사·옛 문서는 `모의고사 · {제목}` 그대로) · 녹음 1문항 연습 응시는 세고 녹음 0은 안 센다 · 라우트 배선",
    aLabels.drill === "공략 연습 · Q3–4 사진 묘사" &&
      aLabels.drill11 === "공략 연습 · Q11 의견 말하기" &&
      aLabels.mock === "모의고사 · 모의고사 4" &&
      aLabels.legacy === "모의고사 · 모의고사 1" &&
      aLabels.broken === "모의고사 · 모의고사 5" &&
      aLabels.none === "모의고사" &&
      drillDay.doneToday && !drillNoRec.doneToday && attemptLabelWired,
    `${JSON.stringify(aLabels)} 배선=${attemptLabelWired}`,
  );
}

// ---------------------------------------------------------------------------
// 7) 은우 트랙의 자유대화(SPEC §17-9) — 은우 발화 ≥ 1 대화만 세고, 아빠 트랙에는 한 날도 섞이지 않는다
// ---------------------------------------------------------------------------
{
  /** 대화 기록(TalkSessionRecord 최소 모양) — 12:00 KST(=03:00Z) */
  const talk = (kstDate: string, childTurnCount: number) => ({ startedAt: `${kstDate}T03:00:00.000Z`, childTurnCount });

  // ① 발화 0 대화(연결만 하고 한마디도 안 함)는 세지 않는다 + 판정 함수 일치
  const silent = computeStreak(talkStreakSessions([talk("2026-09-21", 0)]), TODAY);
  add(
    "자유대화",
    "① 은우 발화 0 대화는 제외(current 0·lastDate null) + isCountedTalkSession 판정 일치(0·NaN·음수 → 안 셈)",
    silent.current === 0 &&
      silent.lastDate === null &&
      !isCountedTalkSession(talk("x", 0)) &&
      !isCountedTalkSession(talk("x", Number.NaN)) &&
      !isCountedTalkSession(talk("x", -1)) &&
      isCountedTalkSession(talk("x", 1)),
    JSON.stringify(silent),
  );

  // ② 대화만 한 날도 은우 스트릭이 는다 — 어제 단어장 시험 + 오늘 대화(발화 2) → 2연속·오늘 함
  const vocabYesterday = [at("2026-09-20")];
  const onlyVocab = computeStreak(vocabYesterday, TODAY);
  const withTalk = computeStreak([...vocabYesterday, ...talkStreakSessions([talk("2026-09-21", 2)])], TODAY);
  add(
    "자유대화",
    "② 대화만 한 날(오늘) → 은우 current 1→2·doneToday(단어장 시험만이면 어제까지 1·오늘 아직)",
    onlyVocab.current === 1 && !onlyVocab.doneToday && withTalk.current === 2 && withTalk.doneToday,
    `시험만=${JSON.stringify(onlyVocab)} 대화포함=${JSON.stringify(withTalk)}`,
  );

  // ③ KST 날짜 — 대화 startedAt 15:30Z(= 다음날 00:30 KST)는 다음날로 센다
  const lateNight = computeStreak(talkStreakSessions([{ startedAt: "2026-09-20T15:30:00.000Z", childTurnCount: 1 }]), TODAY);
  add("자유대화", "③ startedAt KST 일자로 센다(15:30Z → 다음날 = 오늘)", lateNight.doneToday && lateNight.current === 1, JSON.stringify(lateNight));

  // ④ 아빠 트랙 무오염 — 대화 날짜가 일본어·영어·운동 계산에 들어가면 이어져 보인다(오염 반례). 각자 계산은 그대로.
  const jaDays = ["2026-09-19"]; // 일본어: 그제만 → 끊김
  const talkDays = talkStreakSessions([talk("2026-09-20", 1), talk("2026-09-21", 3)]);
  const ja = computeStreakFromDays(jaDays, TODAY);
  const jaPolluted = computeStreak([...jaDays.map((d) => at(d)), ...talkDays], TODAY);
  const enAppa = computeStreak(toeicStreakSessions([], []), TODAY);
  add(
    "자유대화",
    "④ 아빠 트랙 무오염: 일본어(그제만)=0, 대화 날짜를 섞으면 3연속으로 오염돼 보인다 · 영어 트랙은 대화가 있어도 0",
    ja.current === 0 && jaPolluted.current === 3 && enAppa.current === 0 && !enAppa.doneToday,
    `일본어=${JSON.stringify(ja)} 섞음=${JSON.stringify(jaPolluted)} 영어=${JSON.stringify(enAppa)}`,
  );

  // ⑤ 헤드라인 라벨 모양
  add("자유대화", "⑤ todayLabel = \"자유대화 · {주제}\"", talkStreakLabel({ topic: { labelKo: "공룡" } }) === "자유대화 · 공룡", talkStreakLabel({ topic: { labelKo: "공룡" } }));

  // ⑥ 라우트 배선(정적) — 은우 = 단어장 시험 + 대화, 대화 읽기 실패는 null → [](단어장만), 대화가 아빠 계산식에 들어가지 않는다,
  //    라벨은 가장 늦게 시작한 것(isCountedTalkSession 거른 오늘 대화 vs 오늘 시험)
  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  const wired = /computeStreak\(\[\.\.\.vocab, \.\.\.talkStreakSessions\(talks\), \.\.\.reviewStreakSessions\(reviewsOf\("english"\)\)\], today\)/.test(route);
  const fallback = /listAllTalkSessions\(\)\.catch\(/.test(route) && /const talks = talkSessions \?\? \[\];/.test(route);
  const noLeakToAppa =
    !/computeStreak\(\[\.\.\.jaVocab[^\]]*talk/i.test(route) &&
    !/toeicStreakSessions\([^)]*talk/i.test(route) &&
    !/workoutKeptDays\([^)]*talk/i.test(route) &&
    // 대화는 은우 세션 배열에만 — legacy 은우 계산과 v2 은우 트랙(legacyDays)이 같은 배열을 쓴다(그 밖의 talkStreakSessions 호출 0)
    (route.match(/talkStreakSessions\(/g) ?? []).length ===
      route.split('[...vocab, ...talkStreakSessions(talks), ...reviewStreakSessions(reviewsOf("english"))]').length - 1;
  const label = /isCountedTalkSession\(t\)/.test(route) && /talkStreakLabel\(tToday\)/.test(route);
  add(
    "자유대화",
    "⑥ /api/streak 배선: 은우 = 단어장 시험 + talkStreakSessions(talks), 대화 읽기 실패 → 단어장만, 아빠 트랙 무혼합, 라벨 = 가장 늦은 것",
    wired && fallback && noLeakToAppa && label,
    `배선=${wired} 폴백=${fallback} 무혼합=${noLeakToAppa} 라벨=${label}`,
  );
}

// ---------------------------------------------------------------------------
// 8) 목록 시험 응시 배지(SPEC §15-4 — lib/test-status.ts) — 시험 전 / 오늘 ✓ / ✓ M월 D일 · 맞힘/답함
//    판 = 같은 startedAt 묶음 · 센다 = 답한 문항 ≥ 1(스트릭 §17-1과 같은 기준) · 점수 = 맞힘/답함(기록 화면과 같은 분모) · 오늘 = KST
// ---------------------------------------------------------------------------
{
  const B = "시험 배지";
  const TODAY = "2026-10-03";
  type It = { correct: boolean; answered: boolean | null };
  const ok = (n: number): It[] => Array.from({ length: n }, () => ({ correct: true, answered: true }));
  const no = (n: number): It[] => Array.from({ length: n }, () => ({ correct: false, answered: true }));
  const skip = (n: number): It[] => Array.from({ length: n }, () => ({ correct: false, answered: null }));
  const ses = (startedAt: string, items: It[], finished = true): TestStatusSession => ({ startedAt, finishedAt: finished ? startedAt : null, items });
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ① 세션 0개 · 답한 문항 0 판만 → 시험 전
  const none0 = summarizeTestStatus([], TODAY);
  add(B, "① 세션 0개 → none · \"시험 전\"", eq(none0, TEST_STATUS_NONE) && testStatusLabelKo(none0, TODAY) === "시험 전", JSON.stringify(none0));
  const quitAll = summarizeTestStatus([ses("2026-10-03T03:00:00.000Z", skip(10), false)], TODAY);
  add(B, "① 답한 문항 0 판(바로 그만둠)만 → none(스트릭 §17-1과 같은 기준)", quitAll.state === "none", JSON.stringify(quitAll));

  // ② 자정 KST 경계 — 15:00Z = 다음날 00:00 KST(오늘), 14:59:59.999Z = 전날 23:59 KST(지난 날)
  const mid = summarizeTestStatus([ses("2026-10-02T15:00:00.000Z", [...ok(8), ...no(2)])], TODAY);
  add(B, "② 2026-10-02T15:00Z = KST 10-03 00:00 → today · \"오늘 ✓ · 8/10\"", mid.state === "today" && mid.lastDate === TODAY && testStatusLabelKo(mid, TODAY) === "오늘 ✓ · 8/10", `${JSON.stringify(mid)} → ${testStatusLabelKo(mid, TODAY)}`);
  const pre = summarizeTestStatus([ses("2026-10-02T14:59:59.999Z", [...ok(8), ...no(2)])], TODAY);
  add(B, "② 2026-10-02T14:59:59.999Z = KST 10-02 23:59 → past · \"✓ 10월 2일 · 8/10\"", pre.state === "past" && pre.lastDate === "2026-10-02" && testStatusLabelKo(pre, TODAY) === "✓ 10월 2일 · 8/10", `${JSON.stringify(pre)} → ${testStatusLabelKo(pre, TODAY)}`);
  // UTC 날짜는 같은 10-03이어도 KST로는 다른 날이 될 수 있다 — UTC 자르기 회귀 반례
  const utcSame = summarizeTestStatus([ses("2026-10-03T15:30:00.000Z", ok(3))], TODAY);
  add(B, "② UTC 10-03 15:30Z = KST 10-04 → today 아님(UTC 날짜 자르기 회귀 반례)", utcSame.state === "past" && utcSame.lastDate === "2026-10-04", JSON.stringify(utcSame));

  // ③ 같은 날 여러 판 — 마지막 판의 점수, 입력 순서 무관
  const morning = ses("2026-10-03T00:10:00.000Z", [...ok(3), ...no(7)]);
  const evening = ses("2026-10-03T11:00:00.000Z", [...ok(9), ...no(1)]);
  const a1 = summarizeTestStatus([morning, evening], TODAY);
  const a2 = summarizeTestStatus([evening, morning], TODAY);
  add(B, "③ 같은 날 두 판 → 마지막 판(9/10), 입력 순서 무관", a1.correct === 9 && a1.answered === 10 && eq(a1, a2), `${JSON.stringify(a1)} / ${JSON.stringify(a2)}`);
  const olderAfter = summarizeTestStatus([evening, ses("2026-10-01T02:00:00.000Z", ok(5))], TODAY);
  add(B, "③ 지난 판이 뒤에 와도 오늘 판이 마지막", olderAfter.state === "today" && olderAfter.correct === 9, JSON.stringify(olderAfter));

  // ④ 혼합 판 묶기 — 같은 startedAt의 모드별 문서(토익 혼합·영어 관계 문항·틀 시험)는 한 판으로 합친다
  const T = "2026-10-01T05:00:00.000Z";
  const mixed = summarizeTestStatus([ses(T, [...ok(4), ...no(1)]), ses(T, [...ok(2), ...no(1)]), ses(T, ok(1))], TODAY);
  add(B, "④ 같은 startedAt 세 문서 → 한 판 7/9 · \"✓ 10월 1일 · 7/9\"", mixed.correct === 7 && mixed.answered === 9 && testStatusLabelKo(mixed, TODAY) === "✓ 10월 1일 · 7/9", `${JSON.stringify(mixed)} → ${testStatusLabelKo(mixed, TODAY)}`);

  // ⑤ 미완료 판 — 답했으면 센다, 분모는 답한 문항만, "· 중단" 표시. 묶은 문서 중 하나라도 그만두면 중단
  const quit = summarizeTestStatus([ses("2026-10-03T02:00:00.000Z", [...ok(2), ...no(1), ...skip(7)], false)], TODAY);
  add(B, "⑤ 그만둔 판(답 3·미응답 7) → today · 2/3 · \"오늘 ✓ · 2/3 · 중단\"", quit.state === "today" && quit.correct === 2 && quit.answered === 3 && !quit.finished && testStatusLabelKo(quit, TODAY) === "오늘 ✓ · 2/3 · 중단", `${JSON.stringify(quit)} → ${testStatusLabelKo(quit, TODAY)}`);
  const halfQuit = summarizeTestStatus([ses(T, ok(3)), ses(T, [...ok(1), ...skip(2)], false)], TODAY);
  add(B, "⑤ 같은 판의 한 모드만 그만둠 → 판 전체 중단", !halfQuit.finished && halfQuit.answered === 4, JSON.stringify(halfQuit));
  const emptyLater = summarizeTestStatus([ses("2026-10-02T03:00:00.000Z", ok(5)), ses("2026-10-03T03:00:00.000Z", skip(10), false)], TODAY);
  add(B, "⑤ 오늘 답 0으로 그만둔 판은 무시 → 어제 판 past 5/5", emptyLater.state === "past" && emptyLater.lastDate === "2026-10-02" && emptyLater.correct === 5, JSON.stringify(emptyLater));

  // ⑥ 스트릭과 같은 기준 — 오늘 판의 유무가 computeStreak.doneToday와 일치한다
  const fixtures: TestStatusSession[][] = [[], [ses("2026-10-03T03:00:00.000Z", skip(4), false)], [ses("2026-10-02T15:00:00.000Z", ok(1))], [ses("2026-10-02T14:59:59.999Z", ok(1))]];
  const asStreak = (f: TestStatusSession[]): StreakSession[] => f.map((x) => ({ startedAt: x.startedAt, items: [...x.items] }));
  const agree = fixtures.every((f) => (summarizeTestStatus(f, TODAY).state === "today") === computeStreak(asStreak(f), TODAY).doneToday);
  add(B, "⑥ 배지 today ⇔ 스트릭 doneToday(같은 세션 4벌)", agree, fixtures.map((f) => `${summarizeTestStatus(f, TODAY).state}/${computeStreak(asStreak(f), TODAY).doneToday}`).join(" "));

  // ⑦ 깨진 startedAt은 건너뛴다(날짜를 정할 수 없다) · 해가 다르면 연도 표시
  const broken = summarizeTestStatus([ses("garbage", ok(5)), ses("2026-10-03T03:00:00", ok(5))], TODAY);
  add(B, "⑦ 깨진·시간대 없는 startedAt만 → none", broken.state === "none", JSON.stringify(broken));
  const lastYear = summarizeTestStatus([ses("2025-12-31T03:00:00.000Z", [...ok(1), ...no(1)])], TODAY);
  add(B, "⑦ 작년 판 → \"✓ 2025년 12월 31일 · 1/2\" · 날짜 표시 M월 D일(앞 0 없음)", testStatusLabelKo(lastYear, TODAY) === "✓ 2025년 12월 31일 · 1/2" && testStatusDateKo("2026-01-05", TODAY) === "1월 5일", testStatusLabelKo(lastYear, TODAY));

  // ⑧ 대상별 묶기(한 번 읽은 목록) · 없는 대상은 시험 전 · 배지 데이터
  const all = [
    { bookId: "a", ...ses("2026-10-03T01:00:00.000Z", ok(2)) },
    { bookId: "b", ...ses("2026-09-30T01:00:00.000Z", [...ok(1), ...no(1)]) },
    { bookId: "a", ...ses("2026-09-01T01:00:00.000Z", no(5)) },
  ];
  const map = testStatusByTarget(all, (q) => q.bookId, TODAY);
  const ba = toTestStatusBadge(testStatusOf(map, "a"), TODAY);
  const bb = toTestStatusBadge(testStatusOf(map, "b"), TODAY);
  const bc = toTestStatusBadge(testStatusOf(map, "c"), TODAY);
  add(
    B,
    "⑧ testStatusByTarget: a=오늘 2/2 · b=9월 30일 1/2 · c(세션 없음)=시험 전",
    eq(ba, { state: "today", labelKo: "오늘 ✓ · 2/2" }) && eq(bb, { state: "past", labelKo: "✓ 9월 30일 · 1/2" }) && eq(bc, { state: "none", labelKo: "시험 전" }),
    `${JSON.stringify(ba)} ${JSON.stringify(bb)} ${JSON.stringify(bc)}`,
  );

  // ⑨ 공략 폴더 — 그 유형 틀(tpl:{key})을 **답한** 세션만. 다른 유형 틀만 답한 세션·미응답만 있는 세션은 뺀다
  const partKeys = new Set(["scene-a", "scene-b"]);
  const tplSes = (startedAt: string, items: { word: string; correct: boolean; answered: boolean | null }[]) => ({ startedAt, finishedAt: startedAt, items });
  const mine = tplSes("2026-10-02T03:00:00.000Z", [{ word: "tpl:scene-a", correct: true, answered: true }, { word: "tpl:reason-x", correct: false, answered: true }]);
  const other = tplSes("2026-10-03T03:00:00.000Z", [{ word: "tpl:opinion-z", correct: true, answered: true }]);
  const unanswered = tplSes("2026-10-03T04:00:00.000Z", [{ word: "tpl:scene-b", correct: false, answered: null }]);
  const picked = templateSessionsForPart([mine, other, unanswered], partKeys);
  const folder = summarizeTestStatus(picked, TODAY);
  add(
    B,
    "⑨ templateSessionsForPart: 이 유형 틀을 답한 세션만(다른 유형·미응답 제외) → past 10월 2일 · 판 점수는 세션 전체 1/2",
    picked.length === 1 && picked[0] === mine && testStatusLabelKo(folder, TODAY) === "✓ 10월 2일 · 1/2",
    `${picked.length}개 → ${testStatusLabelKo(folder, TODAY)}`,
  );

  // ⑩ 네 목록 배선(정적) — 세션을 한 번 읽어 묶는다(대상마다 쿼리 금지) · 칩을 렌더한다 · 토익 표현집은 표현 시험 모드만
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
  const enPage = src("../app/english/vocab/page.tsx");
  const jaPage = src("../app/japanese/vocab/page.tsx");
  const tsPage = src("../app/toeic/sets/page.tsx");
  const tgPage = src("../app/toeic/guides/page.tsx");
  const wiredEn = /listAllVocabQuizzes\(\)/.test(enPage) && /testStatusByTarget\(quizzes, \(q\) => q\.bookId, todayKst\)/.test(enPage) && !/listVocabQuizzes\(/.test(enPage);
  const wiredJa = /listAllJaQuizzes\(\)/.test(jaPage) && /testStatusByTarget\(quizzes, \(q\) => q\.bookId, todayKst\)/.test(jaPage) && !/listJaQuizzes\(/.test(jaPage) && !/JaKanjiQuizzes/.test(jaPage);
  const wiredTs = /listAllToeicQuizzes\(\)/.test(tsPage) && /testStatusByTarget\(quizzes\.filter\(isToeicQuizModeSession\), \(q\) => q\.setId, todayKst\)/.test(tsPage) && !/listToeicQuizzes\(/.test(tsPage);
  const wiredTg = /templateSessionsForPart\(bankSessions, partKeys\)/.test(tgPage) && /<TestStatusChip badge=\{c\.test\} \/>/.test(tgPage) && (tgPage.match(/listToeicQuizzes\(/g) ?? []).length === 1;
  const views = ["../components/vocab-library-view.tsx", "../components/ja-vocab-library-view.tsx", "../components/toeic-set-library-view.tsx"].every((f) => /<TestStatusChip badge=\{item\.test\} \/>/.test(src(f)));
  const todayOnce = [enPage, jaPage, tsPage, tgPage].every((p) => (p.match(/kstTodayString\(\)/g) ?? []).length === 1);
  add(
    B,
    "⑩ 배선: 영어·일본어·토익 표현집 = 전체 세션 한 번 읽어 대상별 묶기(대상별 쿼리 없음, 일본어 한자 시험·토익 틀 세션 제외) · 공략 폴더 = 기존 틀 은행 세션 재사용 · 세 목록 뷰가 칩 렌더 · 오늘은 페이지마다 한 번",
    wiredEn && wiredJa && wiredTs && wiredTg && views && todayOnce,
    `en=${wiredEn} ja=${wiredJa} toeic=${wiredTs} guides=${wiredTg} views=${views} today1=${todayOnce}`,
  );
}

// ---------------------------------------------------------------------------
// 9) 오늘의 복습(SPEC §23-9) — 복습 1개 이상 끝낸 날을 각 영역 트랙에 센다(영역 = 트랙, 섞지 않는다)
// ---------------------------------------------------------------------------
{
  const B = "오늘의 복습";
  const rv = (area: "english" | "japanese" | "toeic", itemKey: string, days: string[]) => ({
    id: itemKey,
    area,
    kind: itemKey.split(":")[0],
    itemKey,
    history: days.map((on) => ({ on, at: `${on}T03:00:00.000Z`, hintLevel: 0, judge: "got", step: 1 })),
    lastReviewedOn: days[days.length - 1] ?? null,
  });
  const TODAY9 = "2026-10-03";
  const en = [rv("english", "en-word:apple", ["2026-10-02", TODAY9])];
  const ja = [rv("japanese", "ja-word:猫", ["2026-10-01"])];
  // 은우 트랙: 단어장 시험 없이 복습만 이틀 → 2일 연속 · 아빠 일본어 복습은 섞이지 않는다
  const enInfo = computeStreak(reviewStreakSessions(en as never), TODAY9);
  const mixed = computeStreak([...reviewStreakSessions(en as never), ...reviewStreakSessions(ja as never)], TODAY9);
  add(B, "복습만 한 날도 그 영역 트랙에 센다(은우 2일 연속) · 트랙을 섞으면 달라진다(반례 — 라우트는 영역별로 가른다)", enInfo.current === 2 && enInfo.doneToday && mixed.current === 3, `en=${enInfo.current} mixed=${mixed.current}`);
  add(B, "라벨 `오늘의 복습 · n개`(오늘 복습한 항목 수) · 오늘 안 했으면 null", reviewTodayLabel(en as never, TODAY9) === "오늘의 복습 · 1개" && reviewTodayLabel(ja as never, TODAY9) === null, String(reviewTodayLabel(en as never, TODAY9)));
  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  add(
    B,
    "/api/streak 배선: 영역별 reviewsOf로 은우·일본어·영어 트랙에 각각 · 복습 일정을 못 읽으면 복습만 빼고 · 라벨은 그 트랙에 다른 기록이 없을 때만",
    /reviewsOf = \(area: ReviewArea\) => \(reviewSchedules \?\? \[\]\)\.filter\(\(r\) => r\.area === area\)/.test(route) &&
      /reviewStreakSessions\(reviewsOf\("english"\)\)/.test(route) &&
      /reviewStreakSessions\(reviewsOf\("japanese"\)\)/.test(route) &&
      /reviewStreakSessions\(reviewsOf\("toeic"\)\)/.test(route) &&
      /listReviewSchedules\(\)\.catch/.test(route) &&
      /appa\.todayLabel === null\) appa\.todayLabel = reviewTodayLabel\(reviewsOf\("japanese"\)/.test(route),
    "",
  );
}

// ---------------------------------------------------------------------------
// 10) 아빠 📚 어학 트랙(SPEC §17-10, 2026-10-08) — 일본어 + 영어 날짜의 합집합. 둘 중 하나만 해도 그날이 켜진다.
//     은우·운동은 섞지 않는다. 헤드라인은 이 트랙 하나만(🗾·🎙️ 칸 대신) 보인다.
// ---------------------------------------------------------------------------
{
  const B = "어학 트랙";
  const TODAY10 = "2026-10-08";
  const at = (d: string, answered = true): StreakSession => ({ startedAt: `${d}T03:00:00.000Z`, items: [{ answered }] });
  // 일본어는 10-06·10-08, 영어는 10-07만 → 각자는 끊기지만 합치면 3일 연속
  const ja = [at("2026-10-06"), at(TODAY10)];
  const en = [at("2026-10-07")];
  const merged = computeStreakFromDays(new Set([...streakDays(ja), ...streakDays(en)]), TODAY10);
  add(B, "번갈아 해도 이어진다(일·영·일 → 3일 연속, 따로 세면 일본어 1·영어는 오늘 아직)", merged.current === 3 && merged.doneToday && computeStreak(ja, TODAY10).current === 1 && !computeStreak(en, TODAY10).doneToday, JSON.stringify(merged));
  const enOnly = computeStreakFromDays(new Set([...streakDays([]), ...streakDays([at(TODAY10)])]), TODAY10);
  add(B, "영어만 오늘 함 → 어학 doneToday", enOnly.doneToday && enOnly.current === 1, JSON.stringify(enOnly));
  const both = computeStreakFromDays(new Set([...streakDays([at(TODAY10)]), ...streakDays([at(TODAY10)])]), TODAY10);
  add(B, "같은 날 둘 다 → 하루로 접는다", both.current === 1 && both.best === 1, JSON.stringify(both));
  const unanswered = computeStreakFromDays(new Set([...streakDays([at(TODAY10, false)]), ...streakDays([])]), TODAY10);
  add(B, "답한 문항 0 세션은 합집합에도 안 들어간다", !unanswered.doneToday && unanswered.current === 0, JSON.stringify(unanswered));
  add(B, "streakDays ∘ computeStreakFromDays = computeStreak(같은 결과)", JSON.stringify(computeStreakFromDays(streakDays(ja), TODAY10)) === JSON.stringify(computeStreak(ja, TODAY10)), "");

  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  const wired =
    /const langDays = new Set\(\[\.\.\.streakDays\(jaSessions\), \.\.\.streakDays\(enSessions\)\]\);/.test(route) &&
    /computeStreakFromDays\(langDays, today\)/.test(route) &&
    /legacyDays: langDays,/.test(route);
  // streakDays는 일본어·영어 세션(어학 합집합 — legacy와 v2 어학 트랙)과 v2 은우 트랙의 은우 세션 배열에만
  const sdCount = (needle: string) => route.split(needle).length - 1;
  const noLeak =
    !/streakDays\((?:vocab|talks|workoutCycles)/.test(route) &&
    sdCount("streakDays(") === sdCount("streakDays(jaSessions)") + sdCount("streakDays(enSessions)") + sdCount("streakDays([...vocab, ...talkStreakSessions(talks)") &&
    sdCount("streakDays(jaSessions)") === 1 &&
    sdCount("streakDays(enSessions)") === 1;
  const fallback = /let enSessions: StreakSession\[\] = reviewStreakSessions\(reviewsOf\("toeic"\)\);/.test(route);
  const label = /`일본어 · \$\{appa\.todayLabel\}`/.test(route) && /`영어 · \$\{appaEnglish\.todayLabel\}`/.test(route);
  const inBody = /appaWorkout, appaEnglish, appaLanguage \}/.test(route);
  add(B, "/api/streak 배선: 일본어∪영어 날짜 · 은우·운동 무혼합 · 토익 읽기 실패면 토익 복습만 · 라벨 접두 · 응답에 appaLanguage", wired && noLeak && fallback && label && inBody, `배선=${wired} 무혼합=${noLeak} 폴백=${fallback} 라벨=${label} 응답=${inBody}`);

  const head = readFileSync(new URL("../components/streak-headline.tsx", import.meta.url), "utf-8");
  // 2026-10-09 사용자 결정: 아빠 칸은 사람 하나(appaPerson — 없으면 appaLanguage로 대신). 📚·💪·🗾·🎙️ 트랙 칸 없음
  const one =
    /<Person emoji="🧑" name="아빠" p=\{appaCell\}[^>]*\/>/.test(head) &&
    /const appaCell = data \? \(data\.appaPerson \?\? data\.appaLanguage\) : undefined;/.test(head) &&
    !/emoji="📚"|emoji="💪"|emoji="🗾"|emoji="🎙️"/.test(head) &&
    !/p=\{data\?\.(?:appa|appaEnglish|appaWorkout|appaLanguage)\}/.test(head);
  add(B, "헤드라인: 아빠 칸 = 사람 하나(appaPerson) — 📚·💪·🗾·🎙️ 트랙 칸 없음", one, "");
}

// ---------------------------------------------------------------------------
// 11) 스트릭 v2 코어(가족 스트릭 강화 스펙 §4) — 카드·만회·연속·주간·배지. from을 인자로 넘겨 상수와 무관하게 잠근다.
// ---------------------------------------------------------------------------
{
  const B = "v2 코어";
  const FROM = "2026-10-10";
  const runsOf = (o: Record<string, number>) => new Map(Object.entries(o));
  const calc = (legacy: string[], runs: Record<string, number>, today: string) => {
    const input = { legacyDays: new Set(legacy), runs: runsOf(runs), from: FROM };
    const lit = litDaysOf(input);
    const bridges = decideBridges({ ...input, today });
    return streakFromStatus({ litDays: lit, bridges, today, runsToday: runs[today] ?? 0 });
  };
  // ① 적용일 경계 — 전날까지 legacy로 이어 오던 연속이 적용일에도 이어진다
  const a = calc(["2026-10-08", "2026-10-09"], { "2026-10-10": 1 }, "2026-10-10");
  add(B, "① 적용일 당일 한 판 → legacy 2일 + 1 = 3", a.current === 3 && a.doneToday, JSON.stringify(a));
  // ② legacy는 적용일 이후 날짜를 무시한다(새 규칙만)
  const b = calc(["2026-10-10"], {}, "2026-10-10");
  add(B, "② 적용일 이후 legacy 날짜는 무시(오늘 아직)", !b.doneToday && b.current === 0, JSON.stringify(b));
  // ③ 카드 자동 사용 — 놓친 하루를 잇되 숫자는 안 오른다
  const c = calc(["2026-10-09"], { "2026-10-10": 1, "2026-10-12": 1 }, "2026-10-12");
  add(B, "③ 10-11 놓침 → 🧊 자동, current = 3(카드 날 제외)", c.current === 3 && c.freezeDays.includes("2026-10-11") && c.freezeLeftThisMonth === FREEZES_PER_MONTH - 1, JSON.stringify(c));
  // ④ 월 2장 — 같은 달 세 번째 놓침은 카드 없음 → 다음 날 한 판이면 끊김
  const d = calc([], { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1, "2026-10-16": 1, "2026-10-17": 1 }, "2026-10-17");
  add(B, "④ 10-11·10-13 카드, 10-15 카드 없음 + 10-16 한 판 → 끊김(current 2)", d.current === 2 && d.freezeDays.length === 2 && d.repairedDays.length === 0, JSON.stringify(d));
  // ⑤ 만회 — 카드 없을 때 다음 날 두 판이면 살아나고 숫자 +1
  const e = calc([], { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1, "2026-10-16": 2 }, "2026-10-16");
  add(B, "⑤ 10-15 놓침·카드 없음 → 10-16 두 판으로 만회(🔁)", e.repairedDays.includes("2026-10-15") && e.current === 5, JSON.stringify(e));
  // ⑥ 만회 대기 — 어제 놓침·카드 없음·오늘 한 판 0~1 → 대기(연속 살아 있음)
  const f0 = calc([], { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1 }, "2026-10-16");
  const f1 = calc([], { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1, "2026-10-16": 1 }, "2026-10-16");
  add(B, "⑥ 어제 놓침·카드 없음 → pendingRepairDay=어제, 오늘 한 판 1개면 아직 대기", f0.pendingRepairDay === "2026-10-15" && f0.current === 3 && f1.pendingRepairDay === "2026-10-15" && f1.doneToday, `f0=${JSON.stringify(f0)} f1=${JSON.stringify(f1)}`);
  // ⑦ 월 경계 이월 없음 — 10월 1장 남겨도 11월은 2장
  const g = calc([], { "2026-10-30": 1, "2026-11-01": 1, "2026-11-03": 1, "2026-11-05": 1 }, "2026-11-05");
  add(B, "⑦ 10-31(10월 카드)·11-02·11-04(11월 2장) 모두 🧊, 11월 남은 카드 0", g.freezeDays.length === 3 && g.freezeLeftThisMonth === 0 && g.current === 4, JSON.stringify(g));
  // ⑧ 이미 끊긴 뒤에는 카드를 쓰지 않는다
  const h = calc([], { "2026-10-10": 1, "2026-10-20": 1 }, "2026-10-20");
  add(B, "⑧ 긴 공백: 처음 2일만 카드, 이후 끊김 — 카드 2장 이상 쓰지 않음", h.freezeDays.length === 2 && h.current === 1, JSON.stringify(h));
  // ⑨ 오늘에는 카드를 쓰지 않는다(오늘 아직)
  const i = calc([], { "2026-10-10": 1 }, "2026-10-11");
  add(B, "⑨ 오늘 아직 → 카드 미사용, current 1(어제까지)", i.freezeDays.length === 0 && i.current === 1 && !i.doneToday, JSON.stringify(i));
  // ⑩ best는 카드로 이은 구간을 하나로 본다
  add(B, "⑩ best = 카드로 이은 켜진 날 수", c.best === 3, JSON.stringify(c));
  // ⑪ 주간 칸
  const week = kstWeekDays("2026-10-16"); // 금요일
  const cells = weekCells({ info: e, litDays: litDaysOf({ legacyDays: new Set(), runs: runsOf({ "2026-10-14": 1, "2026-10-16": 2 }), from: FROM }), weekDays: week, today: "2026-10-16", startDay: "2026-10-10" });
  add(B, "⑪ 주간(10-12 월요일 시작): 수 10-14 lit, 목 10-15 repaired, 금 10-16 lit, 토·일 future", week[0] === "2026-10-12" && week[6] === "2026-10-18" && cells[2] === "lit" && cells[3] === "repaired" && cells[4] === "lit" && cells[5] === "future" && cells[6] === "future", JSON.stringify(cells));
  // ⑫ 배지
  const bg = badgesOf({ best: 31, current: 30, doneToday: true });
  add(B, "⑫ 배지: best 31 → 7·30, 오늘 30에 닿음", STREAK_BADGES.join() === "7,30,100,200,365" && bg.earned.join() === "7,30" && bg.reachedToday === 30, JSON.stringify(bg));
}

// ---------------------------------------------------------------------------
// 12) 한 판 판정(가족 스트릭 강화 스펙 §2) — 그만둠·일부 답·발화 2·녹음 일부는 한 판이 아니다
// ---------------------------------------------------------------------------
{
  const B = "한 판";
  const it = (answered: boolean | null) => ({ answered });
  add(B, "시험: 끝까지·전부 답함 → 한 판", isFullQuiz({ finishedAt: "2026-10-10T03:00:00.000Z", items: [it(true), it(true)] }), "");
  add(B, "시험: 그만둠(finishedAt null) → 아님", !isFullQuiz({ finishedAt: null, items: [it(true)] }), "");
  add(B, "시험: 끝났지만 답 안 한 문항 있음 → 아님", !isFullQuiz({ finishedAt: "x", items: [it(true), it(null)] }), "");
  add(B, "시험: 문항 0 → 아님", !isFullQuiz({ finishedAt: "x", items: [] }), "");
  const ans = (q: number, recorded: boolean) => ({ q, recorded });
  add(B, "응시: 범위 문항 전부 녹음 → 한 판", isFullAttempt({ finishedAt: "x", questions: [3, 4], answers: [ans(3, true), ans(4, true)] }), "");
  add(B, "응시: 일부만 녹음 → 아님", !isFullAttempt({ finishedAt: "x", questions: [3, 4], answers: [ans(3, true), ans(4, false)] }), "");
  add(B, "응시: 그만둠 → 아님", !isFullAttempt({ finishedAt: null, questions: [3], answers: [ans(3, true)] }), "");
  add(B, "틀 말하기: 결과 전부 + 말한 문항 ≥ 1 → 한 판", isFullFrameDrill({ items: [{ outcome: "spoken" }, { outcome: "no_speech" }] }), "");
  add(B, "틀 말하기: 말한 문항 0 → 아님", !isFullFrameDrill({ items: [{ outcome: "no_speech" }] }), "");
  add(B, "자유대화: 발화 3 → 한 판, 2 → 아님", isFullTalk({ childTurnCount: 3 }) && !isFullTalk({ childTurnCount: 2 }) && !isFullTalk({ childTurnCount: Number.NaN }), "");
  const m = new Map<string, number>();
  addRuns(m, ["2026-10-09T15:30:00.000Z", "2026-10-10T03:00:00.000Z"]); // 둘 다 KST 10-10
  addDays(m, ["2026-10-10", "2026-10-11"]);
  add(B, "판 수 접기: KST 일자로 더한다", m.get("2026-10-10") === 3 && m.get("2026-10-11") === 1, JSON.stringify([...m]));
  // 복습 한 판 — 차례가 온 기존 항목을 모두 했거나, 20개 이상, 차례 온 것이 없는 날은 5개 이상
  const h = (on: string, step: number) => ({ on, at: `${on}T03:00:00.000Z`, hintLevel: 0, judge: "got", step });
  const rv = (key: string, hist: ReturnType<typeof h>[]) => ({ id: key, area: "english", kind: "en-word", itemKey: key, step: 0, dueOn: "2099-01-01", streak: 0, lastJudge: null, lastHintLevel: null, lastReviewedOn: null, reviewCount: hist.length, history: hist, createdAt: "", updatedAt: "" });
  // a·b: 10-09에 step 0(간격 1일) → 10-10에 차례. a만 10-10에 복습 → 미완, 둘 다 → 완
  const part = reviewFullDays([rv("en-word:a", [h("2026-10-09", 0), h("2026-10-10", 1)]), rv("en-word:b", [h("2026-10-09", 0)])] as never);
  const full = reviewFullDays([rv("en-word:a", [h("2026-10-09", 0), h("2026-10-10", 1)]), rv("en-word:b", [h("2026-10-09", 0), h("2026-10-10", 1)])] as never);
  add(B, "복습: 차례 온 2개 중 1개 → 아님, 2개 → 한 판", !part.has("2026-10-10") && full.has("2026-10-10"), `part=${[...part]} full=${[...full]}`);
  const newOnly = (n: number) => reviewFullDays(Array.from({ length: n }, (_, i) => rv(`en-word:n${i}`, [h("2026-10-12", 0)])) as never);
  add(B, "복습: 차례 온 것 없는 날 — 4개 아님, 5개 한 판", !newOnly(4).has("2026-10-12") && newOnly(5).has("2026-10-12"), "");
}

// ---------------------------------------------------------------------------
// 13) 조립(스펙 §3·§4-2) — 아빠 사람 단위 카드, 가족 = 참여자 전원, 엄마 없음
// ---------------------------------------------------------------------------
{
  const B = "v2 조립";
  const FROM = "2026-10-10";
  const T = (legacy: string[], runs: Record<string, number>) => ({ legacyDays: new Set(legacy), runs: new Map(Object.entries(runs)) });
  const lang = T([], { "2026-10-10": 1, "2026-10-12": 1 });
  const gym = T([], { "2026-10-11": 1, "2026-10-12": 1 });
  // 옛 규칙(둘 중 하나)을 보려고 bothFrom을 먼 미래로 — 실제 APPA_BOTH_FROM부터의 "둘 다"는 아래 묶음 "아빠 합침"
  const appa = appaPersonV2(lang, gym, "2026-10-12", FROM, "2099-01-01");
  add(B, "아빠 사람(bothFrom 전 = 옛 규칙): 어학·운동 중 하나면 그날 지킴 → 3일, 카드 0", appa.info.current === 3 && appa.info.freezeDays.length === 0, JSON.stringify(appa.info));
  const appaBoth = appaPersonV2(lang, gym, "2026-10-12", FROM, FROM);
  add(B, "아빠 사람(bothFrom부터): 같은 기록이면 둘 다 한 10-12만 켜짐 → 1일", appaBoth.info.current === 1 && [...appaBoth.litDays].join() === "2026-10-12", JSON.stringify(appaBoth.info));
  const langInfo = trackV2(lang, appa, "2026-10-12", FROM);
  add(B, "어학 트랙: 10-11(운동만) 놓침 — 사람은 안 놓쳐 카드 없음 → current 1", langInfo.current === 1, JSON.stringify(langInfo));
  const off = T([], { "2026-10-10": 1, "2026-10-12": 1 });
  const p2 = personV2([off], "2026-10-12", FROM);
  const t2 = trackV2(off, p2, "2026-10-12", FROM);
  add(B, "사람이 놓친 날 카드는 트랙에도 적용(10-11 🧊)", t2.current === 2 && t2.freezeDays.includes("2026-10-11"), JSON.stringify(t2));
  const eun = personV2([T(["2026-10-09"], { "2026-10-10": 1, "2026-10-11": 1, "2026-10-12": 1 })], "2026-10-12", FROM);
  const fam2 = familyV2([eun, appa, null], "2026-10-12");
  add(B, "가족: 엄마 null이어도 은우·아빠로 계산(10-09는 은우만 참여자 → 10-09~12 = 4)", fam2.info.current === 4, JSON.stringify(fam2.info));
  const momP = personV2([T([], { "2026-10-12": 1 })], "2026-10-12", FROM);
  const fam3 = familyV2([eun, appa, momP], "2026-10-12");
  add(B, "가족: 엄마는 첫날(10-12)부터 참여 — 그 전은 은우·아빠 기준 → 4", momP.startDay === "2026-10-12" && fam3.info.current === 4, JSON.stringify(fam3.info));
  const momLate = personV2([T([], { "2026-10-11": 1 })], "2026-10-12", FROM);
  const fam4 = familyV2([eun, appa, momLate], "2026-10-12");
  add(B, "가족: 오늘 엄마 아직 → 가족 오늘 아직(어제까지 10-09~11 = 3)", !fam4.info.doneToday && fam4.info.current === 3, JSON.stringify(fam4.info));
  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  // 은우 복습 한 판은 은우 트랙에만 — 라우트에 한 번만 나오고 어학 트랙(langT) 정의보다 앞에 있어야 한다
  const enReview = 'reviewFullDays(reviewsOf("english"))';
  const enReviewAt = route.indexOf(enReview);
  const onceBefore = (needle: string, limit: number) => {
    const at = route.indexOf(needle);
    return route.split(needle).length - 1 === 1 && at >= 0 && limit >= 0 && at < limit;
  };
  const wiredV2 =
    /personV2\(\[eunwooT\], today\)/.test(route) &&
    /appaPersonV2\(langT, gymT, today\)/.test(route) &&
    !/personV2\(\[langT, gymT\]/.test(route) &&
    /familyV2\(\[eunwooP, appaP, momP\], today\)/.test(route) &&
    /vocab\.filter\(isFullQuiz\)/.test(route) &&
    /talks\.filter\(isFullTalk\)/.test(route) &&
    /toeicAttempts\.filter\(isFullAttempt\)/.test(route) &&
    /reviewFullDays\(reviewsOf\("english"\)\)/.test(route) &&
    route.split(enReview).length - 1 === 1 &&
    enReviewAt >= 0 &&
    enReviewAt < route.indexOf("const langT") &&
    // 은우 한 판 출처도 은우 트랙에만 — 한 번만, langT 앞. 토익 응시는 어학 트랙(langT 뒤)
    onceBefore("vocab.filter(isFullQuiz)", route.indexOf("const langT")) &&
    onceBefore("talks.filter(isFullTalk)", route.indexOf("const langT")) &&
    route.indexOf("toeicAttempts.filter(isFullAttempt)") > route.indexOf("const langT") &&
    // 토익 기록 하나가 이상해도 라우트가 500이 되지 않게(토익 한 판만 뺀다)
    route.includes("v2 토익 판정 실패");
  add(B, "/api/streak v2 배선: 사람·트랙·가족 조립, 한 판 판정 적용, 은우 복습은 은우에만", wiredV2, "");
}

// ---------------------------------------------------------------------------
// 묶음 14 — v2 화면(정적 배선): 헤드라인 👪 가족 칸·오늘 아직 점, 그만둔 판의 "한 판을 끝내야" 안내
{
  const B = "v2 화면";
  const head = readFileSync(new URL("../components/streak-headline.tsx", import.meta.url), "utf-8");
  add(B, "헤드라인: 👪 가족 칸이 family를 읽고 맨 앞", /<Track emoji="👪" name="가족" p=\{data\?\.family\}(?: tight=\{fourPeople\})? \/>/.test(head) && head.indexOf('name="가족"') < head.indexOf('name="은우"'), "");
  add(B, "헤드라인: 오늘 아직 점(aria-hidden) — Track·Person 둘 다", (head.match(/data-pending-dot/g) ?? []).length >= 2, "");
  const files = ["vocab-quiz-view", "vocab-speak-quiz-runner", "ja-quiz-runner", "ja-kanji-quiz-runner", "toeic-quiz-runner", "toeic-template-quiz", "toeic-template-test", "toeic-frame-drill-runner", "toeic-take-view"];
  const missing = files.filter((f) => !/<StreakFinishHint /.test(readFileSync(new URL(`../components/${f}.tsx`, import.meta.url), "utf-8")));
  add(B, "그만둠 화면 9곳에 '한 판을 끝내야' 안내", missing.length === 0, `빠짐=${missing.join(",")}`);
}

// ---------------------------------------------------------------------------
// 묶음 15 — 알림 결정(스펙 §6-2): 종류·조건·상한·조용한 시간
{
  const B = "알림 결정";
  const st = (person: "eunwoo" | "appa" | "mom", o: Partial<{ doneToday: boolean; current: number; freezeLeft: number; pendingRepairYesterday: boolean }> = {}) => ({ person, doneToday: false, current: 5, freezeLeft: 1, pendingRepairYesterday: false, missingTracks: [], ...o });
  const run = (now: string, states: ReturnType<typeof st>[], sent: { person: "eunwoo" | "appa" | "mom"; kind: "today" | "last" | "repair" | "family" | "poke" }[] = []) =>
    decidePushes({ nowHHMM: now, states, prefs: DEFAULT_PUSH_PREFS, sentToday: sent });
  add(B, "은우 18:00 오늘 아직 → today 1건", run("18:00", [st("eunwoo")]).map((p) => `${p.person}:${p.kind}`).join() === "eunwoo:today", "");
  add(B, "18:00 전·켜짐이면 없음", run("17:30", [st("eunwoo")]).length === 0 && run("18:00", [st("eunwoo", { doneToday: true })]).length === 0, "");
  add(B, "이미 보낸 종류는 다시 안 보냄(30분 뒤 틱)", run("18:30", [st("eunwoo")], [{ person: "eunwoo", kind: "today" }]).length === 0, "");
  add(B, "22:30 마지막 — 카드 남음 문구", (() => { const r = run("22:30", [st("appa")], [{ person: "appa", kind: "today" }]); return r.length === 1 && r[0].kind === "last" && r[0].body.includes("🧊"); })(), "");
  add(B, "조용한 시간(22:31~07:59) 없음", run("23:00", [st("appa")]).length === 0 && run("07:30", [st("appa", { pendingRepairYesterday: true })]).length === 0, "");
  add(B, "08:30 만회 기회", run("08:30", [st("mom", { pendingRepairYesterday: true })]).some((p) => p.kind === "repair"), "");
  add(B, "21:00 가족 — 은우 아직이면 엄마에게", run("21:00", [st("eunwoo"), st("mom", { doneToday: true })], [{ person: "eunwoo", kind: "today" }]).some((p) => p.person === "mom" && p.kind === "family"), "");
  add(B, `하루 상한 ${PUSH_DAILY_MAX}건(콕 포함)`, run("22:30", [st("appa")], [{ person: "appa", kind: "today" }, { person: "appa", kind: "poke" }, { person: "appa", kind: "poke" }]).length === 0, "");
  {
    // 틱의 지금 — KST 30분 내림·0 채움(UTC 입력). 15:05Z = KST 00:05, 23:44Z = KST 08:44, 12:59Z = KST 21:59
    const got = ["2026-10-09T15:05:00.000Z", "2026-10-09T23:44:00.000Z", "2026-10-09T12:59:00.000Z"].map((t) => kstHalfHourHHMM(new Date(t)));
    add(B, "틱 시각 kstHalfHourHHMM: 00:05→00:00·08:44→08:30·21:59→21:30", got.join() === "00:00,08:30,21:30", got.join());
  }
  {
    // 스케줄러 지터 — 22:28:30 KST(13:28:30Z)에 불려도 2분 여유로 "22:30"(마지막 알림 칸), 08:01은 그대로 "08:00". 여유 없으면 "22:00"
    const late = kstHalfHourHHMM(new Date("2026-10-09T13:28:30.000Z"), TICK_SKEW_MS);
    const early = kstHalfHourHHMM(new Date("2026-10-09T23:01:00.000Z"), TICK_SKEW_MS);
    const raw = kstHalfHourHHMM(new Date("2026-10-09T13:28:30.000Z"));
    const tick = readFileSync(new URL("../app/api/push/tick/route.ts", import.meta.url), "utf-8");
    add(B, "틱 시각 여유 2분: 22:28:30→22:30·08:01→08:00(여유 없으면 22:00) · 틱 라우트가 TICK_SKEW_MS를 넘긴다", late === "22:30" && early === "08:00" && raw === "22:00" && /kstHalfHourHHMM\(now, TICK_SKEW_MS\)/.test(tick), `${late},${early},${raw}`);
  }
  {
    // 조용한 시간 단일 정의처(틱·콕 찌르기 공용) — 22:30까지는 보내고 22:31부터 07:59까지는 조용
    const q = ["22:30", "22:31", "07:59", "08:00"].map((t) => `${t}=${isQuietHHMM(t)}`);
    add(B, "조용한 시간 isQuietHHMM: 22:30 아님·22:31 조용·07:59 조용·08:00 아님", q.join() === "22:30=false,22:31=true,07:59=true,08:00=false", q.join());
  }
}

// ---------------------------------------------------------------------------
// 묶음 16 — 만회 대기 한 판 뒤(최종 리뷰 Important): 어제 놓침·카드 없음에서 오늘 한 판만 하면 doneToday는 켜지지만
//   두 판 전에는 자정에 어제가 끊긴다 → 헤드라인·보드는 "한 판 더" 안내, 알림은 "오늘 다 함"으로 보지 않는다(needsMoreToday 단일 판정).
//   아빠는 사람 단위(appaPerson — 어학 ∪ 운동) 값으로 본다. v2 계산이 던지면 옛 규칙으로 폴백(500 아님).
{
  const B = "만회 대기 한 판 뒤";
  const FROM = "2026-10-10";
  const T = (runs: Record<string, number>) => ({ legacyDays: new Set<string>(), runs: new Map(Object.entries(runs)) });
  const base = { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1 };
  const p0 = personV2([T(base)], "2026-10-16", FROM).info;
  const p1 = personV2([T({ ...base, "2026-10-16": 1 })], "2026-10-16", FROM).info;
  const p2 = personV2([T({ ...base, "2026-10-16": 2 })], "2026-10-16", FROM).info;
  const plain = personV2([T({ "2026-10-15": 1, "2026-10-16": 1 })], "2026-10-16", FROM).info;
  add(
    B,
    "needsMoreToday: 대기·0판 true · 대기·1판(doneToday) true · 2판(만회됨) false · 대기 없음 false",
    needsMoreToday(p0) && p1.doneToday && p1.pendingRepairDay === "2026-10-15" && needsMoreToday(p1) && !needsMoreToday(p2) && p2.pendingRepairDay === null && !needsMoreToday(plain),
    `p1=${JSON.stringify({ d: p1.doneToday, pend: p1.pendingRepairDay, r: p1.runsToday })} p2=${JSON.stringify({ pend: p2.pendingRepairDay, r: p2.runsToday })}`,
  );
  add(
    B,
    "needsMoreToday 직접 값: pending+runs 1 true · runs 2 false · pending null false",
    needsMoreToday({ pendingRepairDay: "2026-10-15", runsToday: 1 }) && !needsMoreToday({ pendingRepairDay: "2026-10-15", runsToday: 2 }) && !needsMoreToday({ pendingRepairDay: null, runsToday: 1 }),
    "",
  );
  add(
    B,
    "안내 문구: 0판 '오늘 두 판이면' · 1판 '한 판 더' · 2판 null · doneForPush(1판)=false·(2판)=true",
    repairHintText(p0) === "오늘 두 판이면 어제 🔥가 돌아와요" && repairHintText(p1) === "한 판 더 하면 어제 🔥가 돌아와요" && repairHintText(p2) === null && !doneForPush(p1) && doneForPush(p2),
    String(repairHintText(p1)),
  );

  // 응답 → pushStates → decidePushes(21:00). 은우: 대기·1판(doneToday) / 아빠: 어학 1판 켜짐·운동 아직, 사람 단위 대기·1판·연속 12
  const neutral = { current: 0, doneToday: false, lastDate: null, best: 0 };
  const ps = (info: PersonStreak["info"]): PersonStreak => ({ info, todayLabel: null });
  const resp = (appaRuns: number, appaTrackRuns = 1): StreakResponse => ({
    ok: true,
    today: "2026-10-16",
    eunwoo: ps(p1),
    appa: ps(neutral),
    appaEnglish: ps(neutral),
    appaLanguage: ps({ current: 3, doneToday: true, lastDate: "2026-10-16", best: 3, pendingRepairDay: "2026-10-15", runsToday: appaTrackRuns }),
    appaWorkout: ps({ current: 40, doneToday: false, lastDate: "2026-10-14", best: 40, pendingRepairDay: "2026-10-15", runsToday: 0 }),
    appaPerson: ps({ current: 12, doneToday: true, lastDate: "2026-10-16", best: 40, pendingRepairDay: appaRuns >= 2 ? null : "2026-10-15", runsToday: appaRuns }),
    mom: null,
    family: ps(neutral),
    week: { days: [], rows: { eunwoo: [], appa: [], mom: null } },
    badges: [],
    v2From: FROM,
  });
  const st1 = pushStates(resp(1));
  const kinds = (now: string, r: StreakResponse) => decidePushes({ nowHHMM: now, states: pushStates(r), prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).map((x) => `${x.person}:${x.kind}`);
  const at2100 = kinds("21:00", resp(1));
  add(
    B,
    "pushStates: 대기·1판은 doneToday=false·만회 어제 → 21:00 은우·아빠 알림이 나간다(만회 + 오늘)",
    st1.find((x) => x.person === "eunwoo")?.doneToday === false && st1.find((x) => x.person === "appa")?.pendingRepairYesterday === true && at2100.includes("eunwoo:repair") && at2100.includes("eunwoo:today") && at2100.includes("appa:repair") && at2100.includes("appa:today"),
    at2100.join(),
  );
  // 아빠 사람 단위: 트랙 판 수가 2여도(어학만) 사람 값이 1이면 알림 · 사람 값 2(만회됨)면 아빠 알림 없음 · 숫자는 사람 단위 12(📚 3·💪 40 아님)
  const appaTrack2 = kinds("21:00", resp(1, 2));
  const appaDone = kinds("21:00", resp(2));
  const appaCur = st1.find((x) => x.person === "appa")?.current;
  add(
    B,
    "아빠는 사람 단위(appaPerson): 판 수·대기·연속 숫자(12) — 사람 2판이면 아빠 알림 없음",
    appaTrack2.includes("appa:today") && !appaDone.some((k) => k.startsWith("appa:")) && appaCur === 12,
    `track2=${appaTrack2.join()} done=${appaDone.join()} cur=${appaCur}`,
  );
  // 운동만 이어 온 아빠(어학·운동 모두 오늘 아직) — 알림 숫자는 사람 단위
  const workoutOnly: StreakResponse = { ...resp(0), appaLanguage: ps({ current: 0, doneToday: false, lastDate: null, best: 0 }), appaWorkout: ps({ current: 40, doneToday: false, lastDate: "2026-10-15", best: 40 }), appaPerson: ps({ current: 40, doneToday: false, lastDate: "2026-10-15", best: 40, pendingRepairDay: null, runsToday: 0 }) };
  const wo = decidePushes({ nowHHMM: "21:00", states: pushStates(workoutOnly), prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).find((x) => x.person === "appa" && x.kind === "today");
  add(B, "운동만 이어 온 아빠의 오늘 알림 숫자 = 사람 단위 🔥 40일(📚 0일 아님)", !!wo && wo.body.includes("🔥 40일"), wo?.body ?? "없음");

  // 정적 배선 — 헤드라인·보드·알림이 같은 판정, 아빠는 appaPerson, v2 실패 폴백
  const head = readFileSync(new URL("../components/streak-headline.tsx", import.meta.url), "utf-8");
  const board = readFileSync(new URL("../components/family-board.tsx", import.meta.url), "utf-8");
  const push = readFileSync(new URL("../lib/push-decide.ts", import.meta.url), "utf-8");
  const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
  add(
    B,
    "배선: 헤드라인 Person·보드 repairHintText(아빠 = appaPerson 칸 하나) · pushStates는 doneForPush·appaPerson",
    /repairHintText\(p\.info\)/.test(head) &&
      /const appaCell = data \? \(data\.appaPerson \?\? data\.appaLanguage\) : undefined;/.test(head) &&
      /<Person emoji="🧑" name="아빠" p=\{appaCell\}/.test(head) &&
      !/pendingRepairDay \?/.test(head) &&
      /repairHintText\(who\)/.test(board) &&
      /person=\{data\.appaPerson\?\.info\}/.test(board) &&
      /doneForPush\(/.test(push) &&
      /r\.appaPerson\?\.info/.test(push) &&
      /appaPerson: \{ info: v2\.appaPerson, todayLabel: v2\.appaLabel \}/.test(route),
    "",
  );
  add(
    B,
    "v2 실패 폴백: buildV2를 try로 감싸고 로그 '[streak] v2 계산 실패 — 옛 규칙으로 보낸다' · 배지 [] · 주간 'none'",
    /try \{\s*v2 = buildV2\(\);\s*\} catch \(err\) \{\s*console\.error\("\[streak\] v2 계산 실패 — 옛 규칙으로 보낸다", err\);/.test(route) &&
      /badges: \[\],/.test(route) &&
      /days\.map\(\(\): WeekCell => "none"\)/.test(route) &&
      !/pushStates/.test(route.replace(/\/\*[\s\S]*?\*\//g, "")),
    "",
  );
}

// ---------------------------------------------------------------------------
// 17) 엄마 트랙(엄마의 생활영어 설계 §7)
{
  const B = "엄마 트랙";
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
  const ss = src("../lib/streak-server.ts");
  add(B, "가족 조립에 엄마 사람(momP) — null 아님", /familyV2\(\[eunwooP, appaP, momP\]/.test(ss), "");
  add(B, "엄마 runs = 완료 레슨 + 완료 테스트 + mom 복습 한 판", /isFullMomLesson/.test(ss) && /isFullMomTest/.test(ss) && /reviewFullDays\(reviewsOf\("mom"\)\)/.test(ss), "");
  add(B, "엄마 기록 읽기 실패는 엄마만 null(라우트 200)", /listMomLessons\(\)\.catch/.test(ss), "");
  add(
    B,
    "엄마 영역 열림은 hasMomContent로(블록 전체 읽기 없음) · 실패는 엄마만 null",
    /store\.hasMomContent\(\)\.catch/.test(ss) && !/listMomBlocks\(/.test(ss) && /momHasContent === true/.test(ss),
    "",
  );
  {
    const real = MOM_REVIEW_WEEKS.map(momStreakWeekKo);
    const ok =
      real.every((x) => x === "복습 주") &&
      momStreakWeekKo(108) === "복습 주" &&
      momStreakWeekKo(7) === "7주차" &&
      momStreakWeekKo(9) === "9주차" &&
      /weekKo = momStreakWeekKo/.test(ss);
    add(B, "엄마 라벨: 실제 복습 주(8·16·…·48)·가상 복습 주 → 「복습 주」, 새 주 → 「n주차」", ok, real.join());
  }
  const pd = src("../lib/push-decide.ts");
  add(B, "알림: 엄마 자리표시 제거·URL /mom", !/person: "mom", doneToday: true/.test(pd) && /mom: "\/mom"/.test(pd), "");
  add(B, "헤드라인 👩 칸", /emoji="👩"/.test(src("../components/streak-headline.tsx")), "");
  {
    // 2026-10-09 사용자 요청: 순서 가족 → 은우 → 엄마 → 아빠, 엄마도 은우처럼 이름 글자(이름 숨김 예외 없음)
    const hd = src("../components/streak-headline.tsx");
    const iE = hd.indexOf('name="은우"'), iM = hd.indexOf('name="엄마"'), iA = hd.indexOf('name="아빠"');
    add(B, "헤드라인 순서: 은우 → 엄마 → 아빠(JSX 위치)", iE > 0 && iM > iE && iA > iM, `은우=${iE} 엄마=${iM} 아빠=${iA}`);
    const momTag = hd.match(/<Person emoji="👩"[^>]*\/>/)?.[0] ?? "";
    const kidTag = hd.match(/<Person emoji="🧒"[^>]*\/>/)?.[0] ?? "";
    // emoji·name·p를 뺀 나머지 소품이 은우 칸과 같아야 한다(엄마만의 예외 소품 금지)
    const rest = (t: string) => t.replace(/ (emoji|name)="[^"]*"/g, "").replace(/ p=\{[^}]*\}/, "");
    add(
      B,
      "엄마 칸 = 은우 칸과 같은 Person 소품(이름 숨김 소품 없음 — Person 이름은 늘 보이는 글자)",
      momTag !== "" && rest(momTag) === rest(kidTag) && !/phoneNameSr|NameSr|hideName/.test(hd) && /<span className="t-caption font-medium text-ink">\{name\}<\/span>/.test(hd),
      momTag,
    );
    add(
      B,
      "헤드라인 aria-label: 엄마 있으면 '가족, 은우, 엄마, 아빠', 없으면 '가족, 은우, 아빠'(아빠 사람 하나 — 트랙 괄호 없음)",
      hd.includes('"학습 스트릭 — 가족, 은우, 엄마, 아빠"') && hd.includes('"학습 스트릭 — 가족, 은우, 아빠"') && !hd.includes("아빠(어학·운동)"),
      "",
    );
  }

  // 레슨 한 판 판정(순수) — 기록만 본다(끝냄 + 체크 ≥ 1), w…·rw… 같다. 지금 계획과 대조하지 않는다(소급 금지)
  const ck = (id: string) => ({ sentenceId: id, verdict: "pass" as const, transcript: null, hintLevel: 0 as const });
  const L = (lessonId: string, finished: boolean, ids: string[]) => ({ lessonId, finishedAt: finished ? "2026-10-16T01:00:00.000Z" : null, checks: ids.map(ck) });
  const runs = [
    isFullMomLessonRecord(L("w1-d1", true, ["s1", "s2"])),
    isFullMomLessonRecord(L("rw109-d2", true, ["x"])),
    !isFullMomLessonRecord(L("w1-d1", false, ["s1", "s2"])),
    !isFullMomLessonRecord(L("rw109-d2", false, ["x"])),
    !isFullMomLessonRecord(L("w1-d1", true, [])),
    !isFullMomLessonRecord(L("rw109-d2", true, [])),
  ];
  add(B, "레슨 한 판: 끝냄 + 체크 ≥ 1(w…·rw… 같다) · 끝내지 않음·체크 0은 아님", runs.every(Boolean), runs.join());
  {
    // 소급 금지 — 내용을 다시 가져와 w3-d1의 말하기 문장이 바뀌었다(옛 기록은 old-a·old-b를 체크). 그래도 지난 날 한 판으로 남는다.
    const nowPlan = { speakIds: ["new-a", "new-b"] };
    const old = { ...L("w3-d1", true, ["old-a", "old-b"]), startedAt: "2026-10-14T01:00:00.000Z" };
    const stillFull = isFullMomLessonRecord(old);
    const T = (runs: Record<string, number>) => ({ legacyDays: new Set<string>(), runs: new Map(Object.entries(runs)) });
    const m = new Map<string, number>();
    addRuns(m, [old].filter(isFullMomLessonRecord).map((r) => r.startedAt));
    const mom = personV2([T(Object.fromEntries(m))], "2026-10-14", "2026-10-10");
    const planMismatch = !nowPlan.speakIds.every((id) => old.checks.some((c) => c.sentenceId === id));
    const ss2 = src("../lib/streak-server.ts");
    add(
      B,
      "소급 금지: 지금 계획과 말하기 문장이 달라진 옛 레슨도 한 판 · 스트릭이 buildMomWeeks를 보지 않는다",
      planMismatch && stillFull && m.get("2026-10-14") === 1 && mom.info.current === 1 && !/buildMomWeeks\(/.test(ss2) && /momLessons\.filter\(isFullMomLessonRecord\)/.test(ss2),
      JSON.stringify(mom.info),
    );
  }
  // 가족 참여: 엄마는 첫 레슨 완료일부터(그 전 날은 은우·아빠만으로)
  {
    const T = (runs: Record<string, number>) => ({ legacyDays: new Set<string>(), runs: new Map(Object.entries(runs)) });
    const eun = personV2([T({ "2026-10-14": 1, "2026-10-15": 1, "2026-10-16": 1 })], "2026-10-16", "2026-10-10");
    const ap = personV2([T({ "2026-10-14": 1, "2026-10-15": 1, "2026-10-16": 1 })], "2026-10-16", "2026-10-10");
    const mom = personV2([T({ "2026-10-16": 1 })], "2026-10-16", "2026-10-10");
    const momNot = personV2([T({ "2026-10-15": 1 })], "2026-10-16", "2026-10-10");
    const f1 = familyV2([eun, ap, mom], "2026-10-16").info;
    const f2 = familyV2([eun, ap, momNot], "2026-10-16").info;
    add(B, "가족: 엄마 첫날 전은 은우·아빠만 → 3일 · 오늘 엄마 아직이면 가족 오늘 아직", f1.current === 3 && f1.doneToday && !f2.doneToday, `${JSON.stringify(f1)} ${JSON.stringify(f2)}`);
  }

  // pushStates 순수: mom null → 엄마 state 없음. 그래도 prefs.mom.familyAlerts면 21:00 가족 알림은 엄마 폰에 간다
  const neutral = { current: 0, doneToday: false, lastDate: null, best: 0 };
  const ps = (info: PersonStreak["info"]): PersonStreak => ({ info, todayLabel: null });
  const r: StreakResponse = {
    ok: true,
    today: "2026-10-16",
    eunwoo: ps({ current: 5, doneToday: false, lastDate: "2026-10-15", best: 5 }),
    appa: ps(neutral),
    appaEnglish: ps(neutral),
    appaLanguage: ps({ current: 3, doneToday: true, lastDate: "2026-10-16", best: 3 }),
    appaWorkout: ps(neutral),
    mom: null,
    family: ps(neutral),
    week: { days: [], rows: { eunwoo: [], appa: [], mom: null } },
    badges: [],
    v2From: "2026-10-10",
  };
  const states = pushStates(r);
  const fam = decidePushes({ nowHHMM: "21:00", states, prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).filter((x) => x.kind === "family").map((x) => x.person);
  add(B, "pushStates(mom null): 엄마 state 없음 · 21:00 가족 알림은 엄마에게도(familyAlerts)", !states.some((s) => s.person === "mom") && DEFAULT_PUSH_PREFS.mom.familyAlerts && fam.includes("mom"), fam.join());
  const capped = decidePushes({ nowHHMM: "21:00", states, prefs: DEFAULT_PUSH_PREFS, sentToday: [{ person: "mom", kind: "poke" }, { person: "mom", kind: "poke" }, { person: "mom", kind: "today" }] }).filter((x) => x.person === "mom");
  add(B, "state 없는 엄마도 하루 상한은 sentCount로", capped.length === 0, JSON.stringify(capped));
  // mom 있음 → 실제 상태(오늘 아직이면 today 알림, URL /mom)
  const withMom = pushStates({ ...r, mom: ps({ current: 2, doneToday: false, lastDate: "2026-10-15", best: 2 }) });
  const momToday = decidePushes({ nowHHMM: "21:00", states: withMom, prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).find((x) => x.person === "mom" && x.kind === "today");
  add(B, "엄마 실제 상태: 오늘 아직 → today 알림·URL /mom", !!momToday && momToday.url === "/mom", JSON.stringify(momToday ?? null));
  {
    // 0일 문구 — "🔥 0일이 걸려 있어요"·0일인데 🧊 카드 안내 금지. 5일은 기존 문구 그대로
    const S = (current: number, freezeLeft = 1) => ({ person: "mom" as const, doneToday: false, current, freezeLeft, pendingRepairYesterday: false, missingTracks: [] as string[] });
    const t0 = pushText("mom", "today", S(0)).body;
    const k0 = pushText("eunwoo", "today", { ...S(0), person: "eunwoo" }).body;
    const l0 = pushText("mom", "last", S(0)).body;
    const t5 = pushText("mom", "today", S(5)).body;
    const k5 = pushText("eunwoo", "today", { ...S(5), person: "eunwoo" }).body;
    const l5 = pushText("mom", "last", S(5)).body;
    const l5n = pushText("mom", "last", S(5, 0)).body;
    add(
      B,
      "알림 문구 0일: today '0일' 없음(어른·아이) · last '🧊' 없음 · 5일은 기존 문구",
      !t0.includes("0일") && t0 === "오늘 한 판 해 볼까요? 🔥를 켜 봐요" && !k0.includes("0일") && k0 === "오늘 한 판 하자! 🔥를 켜 보자" &&
        !l0.includes("🧊") && l0 === "오늘 한 판이면 🔥가 켜져요." &&
        t5 === "🔥 5일이 걸려 있어요. 한 판만 하면 돼요!" && k5 === "🔥 5일째야. 한 판만 하자!" &&
        l5 === "오늘 못 하면 🧊 쉬는 날 카드가 쓰여요." && l5n === "오늘 못 하면 🔥가 내일 두 판으로만 살아나요.",
      [t0, k0, l0, t5, k5, l5, l5n].join(" | "),
    );
  }
}


// ---------------------------------------------------------------------------
// 사람 진입 — 경로 → 사람(lib/person-area.ts). 헤드라인 아래 "누구 습관" 표시줄과 과목 화면 "← 과목 선택"이 같은 표를 본다.
{
  const B = "사람 진입";
  const cases: [string, ReturnType<typeof personOfPath>][] = [
    ["/eunwoo", "eunwoo"],
    ["/english/vocab/abc/quiz", "eunwoo"],
    ["/math", "eunwoo"],
    ["/card/xyz", "eunwoo"],
    ["/library", "eunwoo"],
    ["/mama", "mama"],
    ["/mom/lesson?x=1", "mama"],
    ["/appa", "appa"],
    ["/japanese/kanji", "appa"],
    ["/toeic/attempts/x", "appa"],
    ["/workout/", "appa"],
  ];
  const bad = cases.filter(([p, want]) => personOfPath(p) !== want);
  add(B, "사람 영역 접두사 11개가 은우·엄마·아빠로 갈린다(쿼리·끝 슬래시 무관)", bad.length === 0, bad.length === 0 ? `${cases.length}건` : bad.map(([p]) => `${p}→${personOfPath(p)}`).join(", "));
  const nulls = ["/", "", "/family", "/unlock", "/api/streak", null, undefined];
  const badNull = nulls.filter((p) => personOfPath(p) !== null);
  add(B, "홈·가족 보드·잠금 화면·api·빈 값 → null(표시줄 숨김)", badNull.length === 0, badNull.length === 0 ? `${nulls.length}건` : badNull.map(String).join(", "));
  const near = ["/mother", "/english2", "/appartment", "/mamas", "/toeicx/1"];
  const badNear = near.filter((p) => personOfPath(p) !== null);
  add(B, "앞 글자만 같은 경로(/mother·/english2 등) → null", badNear.length === 0, badNear.length === 0 ? near.join(" ") : badNear.join(", "));
  add(
    B,
    "허브 경로가 다시 자기 사람으로 판정된다(왕복)",
    (Object.keys(PERSON_HUB_HREF) as (keyof typeof PERSON_HUB_HREF)[]).every((k) => personOfPath(PERSON_HUB_HREF[k]) === k),
    JSON.stringify(PERSON_HUB_HREF),
  );
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const backs: [string, string][] = [
    ["app/math/page.tsx", "/eunwoo"],
    ["components/english-nav.tsx", "/eunwoo"],
    ["app/mom/page.tsx", "/mama"],
    ["app/japanese/page.tsx", "/appa"],
    ["app/toeic/page.tsx", "/appa"],
    ["app/workout/page.tsx", "/appa"],
  ];
  const badBack = backs.filter(([f, href]) => !src(f).includes(`href="${href}"`) || src(f).includes('href="/"'));
  add(B, "과목 첫 화면 '← 과목 선택'이 그 사람 허브로 간다(6곳, href=\"/\" 없음)", badBack.length === 0, badBack.length === 0 ? "6곳" : badBack.map(([f]) => f).join(", "));
}

// ---------------------------------------------------------------------------
// 시험 화면 숨김 — 시험 중엔 상단 스트릭 헤드라인·"누구 습관" 표시줄을 내린다(lib/exam-screen.ts, 2026-10-09).
{
  const B = "시험 화면 숨김";
  const exams = [
    "/toeic/mocks/m1/take",
    "/toeic/attempts/a1/retake",
    "/toeic/sets/s1/quiz",
    "/toeic/guides/q5_7/templates/quiz",
    "/toeic/guides/q5_7/templates/test",
    "/toeic/guides/q5_7/frame-drill/take",
    "/japanese/vocab/v1/quiz",
    "/japanese/kanji/quiz",
    "/english/vocab/v1/quiz?mode=wrong",
    "/english/vocab/v1/speak/",
    "/english/review",
    "/japanese/review",
    "/toeic/review",
    "/mom/review",
    "/mom/test/3",
    "/mom/test/107",
  ];
  const badExam = exams.filter((p) => !isExamScreenPath(p) || !isExamScreen({ pathname: p, blockCount: 0 }));
  add(B, "시험·응시·복습 경로는 숨김(쿼리·끝 슬래시 무관, 엄마 주간 테스트 포함)", badExam.length === 0, badExam.length === 0 ? `${exams.length}건` : badExam.join(", "));
  const normals = ["/", "/eunwoo", "/appa", "/mama", "/family", "/english", "/english/vocab/v1", "/english/talk", "/japanese", "/japanese/vocab/v1", "/toeic", "/toeic/sets/s1", "/toeic/mocks/m1", "/toeic/guides/q5_7/frame-drill/fd-1", "/mom", "/mom/lesson/l1", "/workout", "/math", "/mom/test", "/mom/test/3/x", null, undefined];
  const badNormal = normals.filter((p) => isExamScreen({ pathname: p, blockCount: 0 }));
  add(B, "보통 화면(허브·목록·상세·엄마 오늘의 레슨·운동)은 보인다", badNormal.length === 0, badNormal.length === 0 ? `${normals.length}건` : badNormal.map(String).join(", "));
  add(B, "블록이 걸리면(경로로 못 가르는 통화 오버레이 등) 보통 경로도 숨김", isExamScreen({ pathname: "/english/talk", blockCount: 1 }) && !isExamScreen({ pathname: "/english/talk", blockCount: 0 }), "");
  add(B, "추가 시험 경로 정규식은 ^…$로 닫혔다", EXAM_SCREEN_EXTRA_PATHS.every((x) => x.re.source.startsWith("^") && x.re.source.endsWith("$")), `${EXAM_SCREEN_EXTRA_PATHS.length}개`);
  add(B, "숨김 CSS가 --streak-h를 0으로 내린다", /--streak-h:\s*0(px)?\b/.test(EXAM_SCREEN_STREAK_H_CSS), EXAM_SCREEN_STREAK_H_CSS);
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const users = ["components/streak-headline.tsx", "components/person-bar.tsx"];
  const badUse = users.filter((f) => !/import \{ useExamScreen \} from "@\/components\/use-exam-screen"/.test(src(f)) || !/useExamScreen\(\)/.test(src(f)) || /isPhraseHelperExamPath|PHRASE_HELPER_EXAM_PATHS/.test(src(f)));
  add(B, "헤드라인·표시줄이 같은 판정(useExamScreen) 하나를 쓴다(시험 목록을 따로 두지 않는다)", badUse.length === 0, badUse.length === 0 ? users.join(" ") : badUse.join(", "));
  const hook = src("components/use-exam-screen.ts");
  add(B, "훅이 isExamScreen + 블록 카운터 구독(서버 snapshot 0)을 쓴다", hook.includes("isExamScreen(") && hook.includes("useSyncExternalStore(subscribePhraseHelperBlock, getPhraseHelperBlockCount, () => 0)"), "");
  const head = src("components/streak-headline.tsx");
  add(B, "헤드라인은 숨겨도 마운트된 채 STREAK_REFRESH_EVENT를 듣는다(훅이 숨김 분기보다 앞)", head.indexOf("useExamScreen()") < head.indexOf("if (exam)") && head.indexOf("STREAK_REFRESH_EVENT, onRefresh") < head.indexOf("if (exam)") && head.includes("EXAM_SCREEN_STREAK_H_CSS"), "");
  const scope = src("lib/phrase-helper-scope.ts");
  add(B, "표현 도우미 시험 목록은 넓히지 않았다(엄마 테스트는 exam-screen 쪽에만)", !scope.includes("/mom\\/test") && !scope.includes("mom\\/test"), "");
}

// ---------------------------------------------------------------------------
// 아빠 합침(2026-10-09 사용자 결정, 옵션 1) — 헤드라인·보드·가족·알림의 아빠는 사람 하나(appaPersonV2).
//   APPA_BOTH_FROM(2026-10-10)부터는 📚 어학 한 판 ≥ 1 **그리고** 💪 운동을 지킨 날만 켜진다. 그 전 날짜는 옛 규칙(둘 중 하나) — 소급 없음.
{
  const B = "아빠 합침";
  const T = (legacy: string[], runs: Record<string, number>) => ({ legacyDays: new Set(legacy), runs: new Map(Object.entries(runs)) });
  add(B, "상수: APPA_BOTH_FROM = 2026-10-10(결정 다음 날) · STREAK_V2_FROM 이후", APPA_BOTH_FROM === "2026-10-10" && APPA_BOTH_FROM >= STREAK_V2_FROM, APPA_BOTH_FROM);

  // (a) 적용일 전 — 둘 중 하나만 해도 켜진다(legacy 기간 · runs 기간 둘 다)
  {
    const lang = T(["2026-10-07", "2026-10-09"], {});
    const gym = T(["2026-10-08", "2026-10-09"], {});
    const p = appaPersonV2(lang, gym, "2026-10-09");
    // runs 기간에서도(from을 앞당겨 bothFrom 전 날짜를 runs로 판정) 하나면 켜진다
    const lang2 = T([], { "2026-10-05": 1, "2026-10-07": 1 });
    const gym2 = T([], { "2026-10-06": 1, "2026-10-07": 1 });
    const p2 = appaPersonV2(lang2, gym2, "2026-10-07", "2026-10-05", "2026-10-10");
    add(B, "(a) 적용일 전: 어학만·운동만·둘 다 모두 켜짐(legacy 3일 · runs 3일)", p.info.current === 3 && p.info.doneToday && p2.info.current === 3 && p2.info.doneToday, `${JSON.stringify(p.info)} ${JSON.stringify(p2.info)}`);
  }
  // (b) 적용일부터 — 둘 다만 켜진다
  {
    const lang = T([], { "2026-10-10": 1, "2026-10-11": 2 });
    const gym = T([], { "2026-10-10": 1, "2026-10-12": 1 });
    const p = appaPersonV2(lang, gym, "2026-10-12");
    add(B, "(b) 적용일부터: 10-10 둘 다만 켜짐 · 10-11 어학만·10-12 운동만은 아님", [...p.litDays].join() === "2026-10-10" && !p.info.doneToday, JSON.stringify([...p.litDays]));
  }
  // (c) 연속이 적용일을 넘어 이어진다 — 하나만 한 3일 + 적용일 둘 다 → 4
  const pre = { lang: ["2026-10-07", "2026-10-09"], gym: ["2026-10-08"] };
  {
    const p = appaPersonV2(T(pre.lang, { "2026-10-10": 1 }), T(pre.gym, { "2026-10-10": 1 }), "2026-10-10");
    add(B, "(c) 10-07 어학·10-08 운동·10-09 어학(옛 규칙) + 10-10 둘 다 → current 4", p.info.current === 4 && p.info.doneToday, JSON.stringify(p.info));
  }
  // (d) 적용일에 운동만 → 안 켜짐, 연속은 어제까지, 오늘 아직 점 · 라벨 "운동 ✓ · 어학 남음"
  {
    const p = appaPersonV2(T(pre.lang, {}), T(pre.gym, { "2026-10-10": 1 }), "2026-10-10");
    const head = readFileSync(new URL("../components/streak-headline.tsx", import.meta.url), "utf-8");
    const dot = /\{loaded && !done && <span data-pending-dot aria-hidden/.test(head);
    add(
      B,
      "(d) 적용일 운동만: doneToday false · current 3(어제까지) · 오늘 아직 점(Person !done) · 라벨 '운동 ✓ · 어학 남음'",
      !p.info.doneToday && p.info.current === 3 && p.info.runsToday === 0 && dot && appaTodayLabel({ lang: false, gym: true, gymRest: false }) === "운동 ✓ · 어학 남음",
      JSON.stringify(p.info),
    );
  }
  // 오늘(2026-10-09, 적용일 전)의 숫자는 바뀌지 않는다 — 무작위 기록 300개로 옛 조립(personV2([lang, gym]))과 같은지
  {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    // 기록은 오늘(10-09)까지만 있을 수 있다(미래 날짜 기록 없음) — 09-01 ~ 10-09. 적용일 뒤 비교용으로 10-10~10-20 기록을 따로 붙인다
    const days = Array.from({ length: 39 }, (_, i) => shiftDateString("2026-09-01", i));
    const later = Array.from({ length: 11 }, (_, i) => shiftDateString("2026-10-10", i));
    let bad = 0;
    let badFuture = 0;
    for (let k = 0; k < 300; k++) {
      const mk = () => {
        const legacy: string[] = [];
        const runs: Record<string, number> = {};
        for (const d of days) {
          if (rnd() < 0.55) legacy.push(d);
          if (rnd() < 0.5) runs[d] = 1 + Math.floor(rnd() * 3);
        }
        return T(legacy, runs);
      };
      const lang = mk();
      const gym = mk();
      for (const today of ["2026-10-05", "2026-10-09"]) {
        const a = appaPersonV2(lang, gym, today);
        const b = personV2([lang, gym], today);
        if (JSON.stringify(a.info) !== JSON.stringify(b.info) || a.startDay !== b.startDay) bad++;
      }
      // 적용일 뒤 오늘에도 적용일 전 날짜의 켜짐은 같다(앞으로의 날만 다르다)
      for (const d of later) {
        if (rnd() < 0.6) lang.runs.set(d, 1 + Math.floor(rnd() * 2));
        if (rnd() < 0.6) gym.runs.set(d, 1);
      }
      const a = appaPersonV2(lang, gym, "2026-10-20");
      const b = personV2([lang, gym], "2026-10-20");
      const before = (s: Set<string>) => [...s].filter((d) => d < APPA_BOTH_FROM).sort().join();
      if (before(a.litDays) !== before(b.litDays)) badFuture++;
    }
    add(B, "오늘(10-09)·그 전 오늘의 아빠 info·startDay = 옛 조립 그대로(무작위 300×2) · 적용일 뒤에도 지난 날 켜짐 불변", bad === 0 && badFuture === 0, `다름=${bad} 지난날=${badFuture}`);
  }
  // (e) 만회 — 적용일부터는 둘 다 + 어학 두 판
  {
    // 10-11·10-13 카드(10월 2장 다 씀), 10-15 놓침 → 10-16에 만회 여부
    const lit = { "2026-10-10": 1, "2026-10-12": 1, "2026-10-14": 1 };
    const L = (extra: Record<string, number>) => T([], { ...lit, ...extra });
    const G = (extra: Record<string, number>) => T([], { ...lit, ...extra });
    const ok = appaPersonV2(L({ "2026-10-16": 2 }), G({ "2026-10-16": 1 }), "2026-10-16").info;
    const noGym = appaPersonV2(L({ "2026-10-16": 2 }), G({}), "2026-10-16").info;
    const oneLang = appaPersonV2(L({ "2026-10-16": 1 }), G({ "2026-10-16": 1 }), "2026-10-16").info;
    const noGymNext = appaPersonV2(L({ "2026-10-16": 2 }), G({}), "2026-10-17").info;
    const legacyRepair = personV2([L({ "2026-10-16": 1 }), G({ "2026-10-16": 1 })], "2026-10-16").info; // 옛 합(어학 1 + 운동 1 = 2)
    add(
      B,
      "(e) 만회: 어학 2판 + 운동 → 🔁 · 어학 2판만 → 대기(오늘 판 0) · 어학 1판 + 운동 → 대기(한 판 더) · 운동 없이 지나면 끊김",
      ok.repairedDays.includes("2026-10-15") && ok.pendingRepairDay === null && ok.current === 5 &&
        noGym.pendingRepairDay === "2026-10-15" && !noGym.doneToday && noGym.runsToday === 0 && needsMoreToday(noGym) &&
        oneLang.pendingRepairDay === "2026-10-15" && oneLang.doneToday && oneLang.runsToday === 1 && repairHintText(oneLang) === "한 판 더 하면 어제 🔥가 돌아와요" &&
        noGymNext.current === 0 && noGymNext.repairedDays.length === 0 &&
        legacyRepair.repairedDays.includes("2026-10-15"),
      `ok=${JSON.stringify(ok)} noGym=${JSON.stringify(noGym)} one=${JSON.stringify(oneLang)}`,
    );
  }
  // 입력 접기 순수 확인 — bothFrom 전 = 합, 부터 = 둘 다일 때 어학 판 수
  {
    const m = appaInputV2(T(["2026-10-09"], { "2026-10-09": 1, "2026-10-10": 3, "2026-10-11": 2 }), T(["2026-10-08"], { "2026-10-09": 1, "2026-10-10": 1, "2026-10-12": 1 }), "2026-10-10");
    add(B, "appaInputV2: 10-09 합 2 · 10-10 둘 다 → 어학 3 · 10-11·10-12 한쪽만 → 없음 · legacy 합집합(전)", m.runs.get("2026-10-09") === 2 && m.runs.get("2026-10-10") === 3 && !m.runs.has("2026-10-11") && !m.runs.has("2026-10-12") && [...m.legacyDays].sort().join() === "2026-10-08,2026-10-09", JSON.stringify([...m.runs]));
  }
  // 운동 계획 휴식일(workoutKeptDays에 든다)은 운동을 지킨 날 → 어학만으로 켜진다
  {
    const p = appaPersonV2(T([], { "2026-10-11": 1 }), T([], { "2026-10-11": 1 /* 휴식 슬롯 */ }), "2026-10-11");
    add(B, "운동 쉬는 날(지킨 날) + 어학 한 판 → 켜짐", p.info.doneToday, JSON.stringify(p.info));
  }
  // 라벨
  {
    const L = (lang: boolean, gym: boolean, gymRest = false) => appaTodayLabel({ lang, gym, gymRest });
    const got = [L(true, true), L(true, false), L(false, true), L(false, false), L(true, true, true), L(false, true, true)];
    add(B, "라벨 6가지(짧게)", got.join("|") === "어학 ✓ · 운동 ✓|어학 ✓ · 운동 남음|운동 ✓ · 어학 남음|어학·운동 남음|어학 ✓ · 운동 쉬는 날|운동 쉬는 날 · 어학 남음", got.join("|"));
  }
  // (f) 가족 — 아빠는 합친 사람
  {
    const eun = personV2([T(["2026-10-09"], { "2026-10-10": 1, "2026-10-11": 1, "2026-10-12": 1 })], "2026-10-12");
    const lang = T(["2026-10-09"], { "2026-10-10": 1, "2026-10-11": 1, "2026-10-12": 1 });
    const gym = T([], { "2026-10-10": 1, "2026-10-11": 1 }); // 10-12(오늘) 운동 아직
    const famNew = familyV2([eun, appaPersonV2(lang, gym, "2026-10-12"), null], "2026-10-12").info;
    const famOld = familyV2([eun, personV2([lang, gym], "2026-10-12"), null], "2026-10-12").info;
    const route = readFileSync(new URL("../lib/streak-server.ts", import.meta.url), "utf-8");
    add(
      B,
      "(f) 가족: 오늘 아빠 어학만 → 가족 오늘 아직(옛 조립이면 켜짐) · 어제까지 4 · 라우트가 appaP = appaPersonV2를 가족·주간에 쓴다",
      !famNew.doneToday && famNew.current === 3 && famOld.doneToday && /const appaP = appaPersonV2\(langT, gymT, today\);/.test(route) && /familyV2\(\[eunwooP, appaP, momP\], today\)/.test(route) && /appa: weekCells\(\{ info: appaP\.info, litDays: appaP\.litDays/.test(route),
      `new=${JSON.stringify(famNew)} old=${JSON.stringify(famOld)}`,
    );
  }
  // (g) 알림 — 적용일부터 운동만 한 날은 오늘·마지막 알림이 나가고 남은 것 = ["어학"]
  {
    const neutral = { current: 0, doneToday: false, lastDate: null, best: 0 };
    const ps = (info: PersonStreak["info"], todayLabel: string | null = null): PersonStreak => ({ info, todayLabel });
    const r: StreakResponse = {
      ok: true,
      today: "2026-10-10",
      eunwoo: ps({ current: 5, doneToday: true, lastDate: "2026-10-10", best: 5 }),
      appa: ps(neutral),
      appaEnglish: ps(neutral),
      appaLanguage: ps({ current: 3, doneToday: false, lastDate: "2026-10-09", best: 3 }),
      appaWorkout: ps({ current: 2, doneToday: true, lastDate: "2026-10-10", best: 2 }),
      appaPerson: ps({ current: 3, doneToday: false, lastDate: "2026-10-09", best: 3, pendingRepairDay: null, runsToday: 0, freezeLeftThisMonth: 2 }, "운동 ✓ · 어학 남음"),
      mom: null,
      family: ps(neutral),
      week: { days: [], rows: { eunwoo: [], appa: [], mom: null } },
      badges: [],
      v2From: "2026-10-10",
    };
    const st = pushStates(r).find((x) => x.person === "appa");
    const at21 = decidePushes({ nowHHMM: "21:00", states: pushStates(r), prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).find((x) => x.person === "appa");
    const at2230 = decidePushes({ nowHHMM: "22:30", states: pushStates(r), prefs: DEFAULT_PUSH_PREFS, sentToday: [{ person: "appa", kind: "today" }] }).find((x) => x.person === "appa");
    // 옛 응답(appaPerson 없음)은 옛 규칙 — 운동만 해도 켜짐
    const { appaPerson: _drop, ...old } = r;
    void _drop;
    const stOld = pushStates(old as StreakResponse).find((x) => x.person === "appa");
    add(
      B,
      "(g) 알림: 운동만 한 날(적용일) → doneToday false · missingTracks ['어학'] · 21:00 today '(어학)' · 22:30 last · 옛 응답은 둘 중 하나",
      st?.doneToday === false && JSON.stringify(st.missingTracks) === '["어학"]' && at21?.kind === "today" && at21.body.includes("(어학)") && at2230?.kind === "last" && stOld?.doneToday === true,
      `${JSON.stringify(st)} ${at21?.body} ${at2230?.kind}`,
    );
    const both: StreakResponse = { ...r, appaLanguage: ps({ ...r.appaLanguage.info, doneToday: true }), appaPerson: ps({ ...r.appaPerson!.info, doneToday: true, runsToday: 1 }) };
    add(B, "(g') 둘 다 하면 아빠 알림 없음", !decidePushes({ nowHHMM: "21:00", states: pushStates(both), prefs: DEFAULT_PUSH_PREFS, sentToday: [] }).some((x) => x.person === "appa"), "");
  }
  // (h) 정적 — 헤드라인 아빠 칸 하나·순서·배지 아빠 하나
  {
    const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const hd = src("components/streak-headline.tsx");
    const iF = hd.indexOf('name="가족"'), iE = hd.indexOf('name="은우"'), iM = hd.indexOf('name="엄마"'), iA = hd.indexOf('name="아빠"');
    add(
      B,
      "(h) 헤드라인: 아빠 Person 하나(📚·💪 Track 없음) · 순서 가족 → 은우 → 엄마 → 아빠 · 아빠 라벨은 아직일 때도",
      (hd.match(/<Track /g) ?? []).length === 1 && !/emoji="📚"|emoji="💪"/.test(hd) && (hd.match(/name="아빠"/g) ?? []).length === 1 && iF < iE && iE < iM && iM < iA && /name="아빠" p=\{appaCell\}[^>]*labelWhenPending/.test(hd),
      `${iF},${iE},${iM},${iA}`,
    );
    const route = src("lib/streak-server.ts");
    const board = src("components/family-board.tsx");
    const cel = src("components/streak-celebrate.tsx");
    add(
      B,
      "(h) 배지: 라우트는 아빠 하나(key 'appa' = appaP.info) · 트랙 배지 없음 · 보드·축하가 '아빠' 이름 · 축하는 옛 트랙 키로 본 숫자를 다시 띄우지 않음",
      /\{ key: "appa" as const, \.\.\.badgesOf\(appaP\.info\) \}/.test(route) && !/key: "appaLanguage"|key: "appaWorkout"/.test(route) &&
        /appa: "아빠"/.test(board) && !/workoutNeutral/.test(board) && /appa: "아빠"/.test(cel) && /appa: \["appaLanguage", "appaWorkout"\]/.test(cel),
      "",
    );
    add(
      B,
      "(h) 보드: 아빠 줄 = appaPerson(아직이면 '아직 · 라벨') · 카드 수도 사람 값 · 안내에 APPA_BOTH_FROM",
      /const appa: PersonStreak = data\.appaPerson \?\?/.test(board) && /labelWhenPending=\{data\.appaPerson != null\}/.test(board) && /`아직 · \$\{p\.todayLabel\}`/.test(board) && /아빠 \{appa\.info\.freezeLeftThisMonth/.test(board) && /\{APPA_BOTH_FROM\}부터 어학과 운동을 둘 다/.test(board),
      "",
    );
  }
}

// ---------------------------------------------------------------------------
printTable(results);
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`FAIL — 스트릭 ${failed.length}개 항목 실패.`);
  process.exit(1);
}
console.log(`PASS — 스트릭 ${results.length}개 항목 통과 (실호출 0회).`);

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
 */

import { readFileSync } from "node:fs";
import { computeStreak, computeStreakFromDays, type StreakSession } from "../lib/streak";
import { formatKst, formatKstDate, isZonedIsoTimestamp, kstDateString, shiftDateString } from "../lib/kst";
import { isCountedToeicAttempt, toeicStreakSessions } from "../lib/toeic-streak";
import { isCountedTalkSession, talkStreakLabel, talkStreakSessions } from "../lib/talk-streak";

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
  const route = readFileSync(new URL("../app/api/streak/route.ts", import.meta.url), "utf-8");
  const wiredEnglish = /computeStreak\(toeicStreakSessions\(toeicQuizzes, toeicAttempts\), today\)/.test(route);
  // 은우 계산식 — §17-9부터 단어장 시험 + 자유대화(talkStreakSessions)다. 그 밖의 것(토익·일본어)은 여기 섞이지 않는다(noLeak).
  const eunwooUntouched = /computeStreak\(\[\.\.\.vocab, \.\.\.talkStreakSessions\(talks\)\], today\)/.test(route);
  const jaUntouched = /computeStreak\(\[\.\.\.jaVocab, \.\.\.jaKanji\], today\)/.test(route);
  const noLeak = !/toeicStreakSessions\([^)]*\b(vocab|jaVocab|jaKanji)\b/.test(route) && !/computeStreak\(\[[^\]]*toeic/i.test(route);
  add(
    "영어 트랙",
    "⑥ /api/streak 배선: 영어=toeicStreakSessions(토익 2컬렉션)만, 은우(단어장+자유대화 §17-9)·일본어 계산식 그대로",
    wiredEnglish && eunwooUntouched && jaUntouched && noLeak,
    `영어배선=${wiredEnglish} 은우=${eunwooUntouched} 일본어=${jaUntouched} 무혼합=${noLeak}`,
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
  const route = readFileSync(new URL("../app/api/streak/route.ts", import.meta.url), "utf-8");
  const wired = /computeStreak\(\[\.\.\.vocab, \.\.\.talkStreakSessions\(talks\)\], today\)/.test(route);
  const fallback = /listAllTalkSessions\(\)\.catch\(/.test(route) && /const talks = talkSessions \?\? \[\];/.test(route);
  const noLeakToAppa =
    !/computeStreak\(\[\.\.\.jaVocab[^\]]*talk/i.test(route) &&
    !/toeicStreakSessions\([^)]*talk/i.test(route) &&
    !/workoutKeptDays\([^)]*talk/i.test(route) &&
    (route.match(/talkStreakSessions\(/g) ?? []).length === 1;
  const label = /isCountedTalkSession\(t\)/.test(route) && /talkStreakLabel\(tToday\)/.test(route);
  add(
    "자유대화",
    "⑥ /api/streak 배선: 은우 = 단어장 시험 + talkStreakSessions(talks), 대화 읽기 실패 → 단어장만, 아빠 트랙 무혼합, 라벨 = 가장 늦은 것",
    wired && fallback && noLeakToAppa && label,
    `배선=${wired} 폴백=${fallback} 무혼합=${noLeakToAppa} 라벨=${label}`,
  );
}

// ---------------------------------------------------------------------------
printTable(results);
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`FAIL — 스트릭 ${failed.length}개 항목 실패.`);
  process.exit(1);
}
console.log(`PASS — 스트릭 ${results.length}개 항목 통과 (실호출 0회).`);

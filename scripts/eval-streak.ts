/**
 * scripts/eval-streak.ts — 학습 스트릭(연속 학습일) 회귀 가드 (docs/SPEC.md §17). **실호출 0회.**
 *
 * 스트릭은 **과목 교차 기능**이다(은우=영어 VocabQuizRecord, 아빠=일본어 JaQuizRecord·JaKanjiQuizRecord, §17-1).
 * docs/SPEC.md §17에 살고 어느 과목 하네스(english/math/japanese)에도 속하지 않아, 한 과목 eval에 붙이면
 * 오귀속이 된다 — 그래서 **별도 진입점**으로 둔다(eval:english가 lib/kst·lib/streak에 의존하게 만들지 않는다).
 *
 * 대상(순수 함수): computeStreak·computeStreakFromDays(lib/streak.ts) · kstDateString/formatKst/shiftDateString(lib/kst.ts).
 * computeStreak은 "오늘(todayKst)"을 인자로 받는 순수 함수라 현재 시각에 의존하지 않는다(테스트 안정, §17-2·17-6).
 * 운동 트랙의 "지킨 날" 계산(workoutKeptDays)은 운동 엔진 소관이라 eval-workout.ts가 잠근다(§17-7).
 */

import { computeStreak, computeStreakFromDays, type StreakSession } from "../lib/streak";
import { formatKst, kstDateString, shiftDateString } from "../lib/kst";

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
// 위 1~4의 15항목은 코어 분리 뒤에도 그대로 통과해야 한다(computeStreak = 세션 → 날짜 집합 → 코어, 동작 불변).
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
printTable(results);
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`FAIL — 스트릭 ${failed.length}개 항목 실패.`);
  process.exit(1);
}
console.log(`PASS — 스트릭 ${results.length}개 항목 통과 (실호출 0회).`);

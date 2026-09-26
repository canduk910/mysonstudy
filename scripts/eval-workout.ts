/**
 * scripts/eval-workout.ts — 아빠의 운동(러시안 파이터 풀업·푸시업 사다리) 엔진 회귀 가드 (docs/SPEC.md §19-7). **실호출 0회.**
 *
 * 운동은 AI 호출이 없는 **순수 상태 기계**다(§19-0). 같은 입력이면 언제나 같은 답이 나와야 하므로,
 * 원안 Python 생성기를 JS 오라클로 옮겨 계획을 대조하고, 사건 재생·오늘 상태·판정 함수를 시나리오로 잠근다.
 *
 * ⚠️ `lib/workout.ts`·`lib/kst.ts`만 import한다 — store 금지(어떤 DB도 만지지 않는다, §19-7).
 *   예외: 상단 스트릭 운동 트랙(§17-7)의 doneToday·연속 판정은 같은 순수 코어 `lib/streak.ts`의 computeStreakFromDays로 확인한다
 *   (store·AI 의존 없음 — "지킨 날" 집합이 스트릭 규칙을 거쳐 어떤 값이 되는지까지 잠근다).
 *   예외 둘: 총 운동 소요시간(§19-8)의 표시 문자열("14분 12초"·"약 13분"·섞인 합계의 "약")은 화면 보조 components/workout-shared.tsx의
 *   **순수 포맷 함수**로 확인한다(스펙이 문자열 정의처를 그 파일로 정했다 — store·AI·브라우저 의존 없음, React는 import만 된다).
 * 날짜는 전부 인자로 넘긴다("오늘"은 픽스처 상수) — 현재 시각에 의존하지 않는다.
 */

import {
  baseLadder,
  makeBase,
  lowRmWarning,
  isValidRm,
  dayKind,
  isWorkoutDay,
  targetFor,
  buildPlan,
  nextWorkoutDay,
  restDaysBetween,
  supersetSteps,
  restFollowsStep,
  stepFollowsRest,
  stepsAfterRest,
  roundDisplayOrder,
  repsForEvent,
  replay,
  todayStatus,
  upcoming,
  snapshot,
  decideLog,
  decideUndo,
  decideStart,
  closingStatus,
  pickActiveWorkoutCycle,
  workoutHistory,
  normalizeWorkoutCycle,
  normalizeWorkoutEvent,
  workoutKeptDays,
  workoutStreakTodayLabel,
  cycleDuration,
  estimateEventSec,
  eventDuration,
  isValidDurationSec,
  sumDurations,
  workoutLog,
  DEFAULT_REST_SEC,
  DURATION_ESTIMATE_SEC,
  WORKOUT_DURATION_MAX_SEC,
  type FailedAt,
  type SetPair,
  type TodayStatus,
  type Upcoming,
  type WorkoutCycleRecord,
  type WorkoutEvent,
} from "../lib/workout";
import { diffDateStrings, isZonedIsoTimestamp, shiftDateString } from "../lib/kst";
import { computeStreakFromDays } from "../lib/streak";
import {
  durationBreakdownText,
  durationText,
  durationTotalText,
  formatDurationApprox,
  formatDurationExact,
  formatElapsedClock,
  formatKstTime,
} from "../components/workout-shared";

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

const results: CheckResult[] = [];
const add = (book: string, check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

/** 시나리오 하나를 감싼다 — 구성 중 예외가 나도 스크립트가 죽지 않고 FAIL 한 줄로 남는다. */
function scenario(book: string, check: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    add(book, check, false, `예외: ${(err as Error).message}`);
  }
}

/** 기대한 예외(RangeError 등)가 나는지 */
function throws(fn: () => unknown, ctor: ErrorConstructor = RangeError): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof ctor;
  }
}

const S = (x: unknown) => JSON.stringify(x);
const eq = (a: unknown, b: unknown) => S(a) === S(b);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** RSC props·Firestore로 그대로 넘길 수 있는 값인가 — undefined·Date·함수·NaN/∞·클래스 인스턴스가 하나라도 있으면 false */
function isPlainData(x: unknown): boolean {
  if (x === null) return true;
  if (typeof x === "string" || typeof x === "boolean") return true;
  if (typeof x === "number") return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(isPlainData);
  if (typeof x === "object") return Object.getPrototypeOf(x) === Object.prototype && Object.values(x as object).every(isPlainData);
  return false;
}

// ---------------------------------------------------------------------------
// 픽스처 — 풀업 10RM / 푸시업 18RM(원안의 현재 상태), 시작일 2026-09-01
// ---------------------------------------------------------------------------
const RM = { pullup: 10, pushup: 18 };
const BASE = makeBase(RM);
const D0 = "2026-09-01";
const dt = (n: number) => shiftDateString(D0, n);
/** 12:00 KST(=03:00Z) — UTC·KST 일자가 같아 픽스처가 헷갈리지 않는다(eval-streak 관용구). */
const nowIsoFor = (date: string) => `${date}T03:00:00.000Z`;

function newCycle(over: Partial<WorkoutCycleRecord> = {}): WorkoutCycleRecord {
  return {
    id: "c1",
    createdAt: "2026-08-31T03:00:00.000Z",
    cycleNo: 1,
    startDate: D0,
    rm: RM,
    base: BASE,
    status: "active",
    endedAt: null,
    rev: 0,
    events: [],
    ...over,
  };
}

/** 스토어가 하듯 writes를 id로 upsert한 결과(순서: 기존 → 새 id) — decideStart 적용 후 상태 검사용 */
function applyWrites(all: readonly WorkoutCycleRecord[], writes: readonly WorkoutCycleRecord[]): WorkoutCycleRecord[] {
  const byId = new Map(all.map((c) => [c.id, c] as const));
  for (const w of writes) byId.set(w.id, w);
  return [...byId.values()];
}

/** console.warn을 잠시 가로채 호출을 센다(정규화가 깨진 사건을 버릴 때 경고하는지) — 출력은 삼킨다 */
function captureWarn<T>(fn: () => T): { value: T; warns: string[] } {
  const orig = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

/** 상태·일정 한 줄 요약 — 시퀀스 비교용 */
function desc(s: TodayStatus | Upcoming): string {
  switch (s.kind) {
    case "workout":
      return `workout(${s.day},${s.targetDay})`;
    case "rest":
      return `rest(${s.day},${s.index}/${s.of}${s.cycleEnd ? ",end" : ""})`;
    case "recovery":
      return `recovery(${s.pendingDay})`;
    case "recorded_today":
      return `recorded(${s.outcome},${s.day},${s.targetDay})`;
    case "retest":
      return "retest";
    case "not_started":
      return `not_started(${s.daysUntil})`;
  }
}

const FAIL_PU0: FailedAt = { exercise: "pullup", setIndex: 0, reps: null };

/**
 * 서버 흐름 그대로 기록 — 그날 오늘 상태의 day·targetDay로 decideLog. 운동일이 아니거나 거절되면 던진다(시나리오 구성용).
 * durationSec(§19-8)은 기본 null(세션 없이 한 기록) — 소요시간 시나리오만 값을 넘긴다.
 */
function log(
  c: WorkoutCycleRecord,
  date: string,
  kind: "complete" | "fail",
  failed: FailedAt = FAIL_PU0,
  durationSec: number | null = null,
): WorkoutCycleRecord {
  const st = todayStatus(c, date);
  if (st.kind !== "workout") throw new Error(`시나리오 오류: ${date} 상태가 ${desc(st)}`);
  const r = decideLog(c, {
    expectedRev: c.rev,
    kind,
    day: st.day,
    targetDay: st.targetDay,
    failed: kind === "fail" ? failed : null,
    durationSec,
    todayKst: date,
    nowIso: nowIsoFor(date),
  });
  if (r.status !== "ok") throw new Error(`시나리오 오류: ${date} decideLog → ${r.status}`);
  return r.next;
}

/** fromDate부터 하루씩 — 운동일이면 완료 기록, 휴식일은 달력으로 지나간다 — Day lastDay를 보통 완료할 때까지. */
function completeThrough(c: WorkoutCycleRecord, fromDate: string, lastDay: number): { c: WorkoutCycleRecord; date: string } {
  let date = fromDate;
  for (let guard = 0; guard < 200; guard++) {
    const st = todayStatus(c, date);
    if (st.kind === "workout") {
      c = log(c, date, "complete");
      if (st.day === lastDay && st.targetDay === st.day) return { c, date };
    }
    date = shiftDateString(date, 1);
  }
  throw new Error(`시나리오 오류: Day ${lastDay}까지 못 감`);
}

/** date부터 k일 동안의 오늘 상태 요약 */
function statusRun(c: WorkoutCycleRecord, date: string, k: number): string[] {
  return Array.from({ length: k }, (_, i) => desc(todayStatus(c, shiftDateString(date, i))));
}

// ---------------------------------------------------------------------------
// 원안 Python 생성기 — JS 오라클 (§19-0 "계획의 오라클")
//   def generate(pu_start, ps_start): … step_indices=[None,4,3,2,1], 블록마다 직전 블록 베이스 +1
// ---------------------------------------------------------------------------
interface OracleDay {
  type: "workout" | "rest";
  day: number;
  pu: number[];
  ps: number[];
}
function oracleGenerate(puStart: number[], psStart: number[]): OracleDay[] {
  const days: OracleDay[] = [];
  let pu = [...puStart];
  let ps = [...psStart];
  let puBlockBase: number[] = [];
  let psBlockBase: number[] = [];
  const stepIndices: (number | null)[] = [null, 4, 3, 2, 1];
  for (let block = 0; block < 4; block++) {
    if (block > 0) {
      pu = puBlockBase.map((x) => x + 1);
      ps = psBlockBase.map((x) => x + 1);
    }
    puBlockBase = [...pu];
    psBlockBase = [...ps];
    for (let d = 0; d < 5; d++) {
      const dayNum = block * 6 + (d + 1);
      if (d > 0) {
        const idx = stepIndices[d] as number;
        pu[idx] += 1;
        ps[idx] += 1;
      }
      days.push({ type: "workout", day: dayNum, pu: [...pu], ps: [...ps] }); // 스냅샷(원안의 append 시점 값)
    }
    days.push({ type: "rest", day: (block + 1) * 6, pu: [], ps: [] });
  }
  return days;
}

// ===========================================================================
// 1) 베이스 (§19-1 Day 1 사다리)
// ===========================================================================
add("베이스", "풀업 10RM → [6,5,4,3,2]", eq(baseLadder(10, "pullup"), [6, 5, 4, 3, 2]), S(baseLadder(10, "pullup")));
add("베이스", "푸시업 18RM → [9,8,7,6,5]", eq(baseLadder(18, "pushup"), [9, 8, 7, 6, 5]), S(baseLadder(18, "pushup")));
add("베이스", "풀업 3RM → [1,1,1,1,1](최소 1)", eq(baseLadder(3, "pullup"), [1, 1, 1, 1, 1]), S(baseLadder(3, "pullup")));
add("베이스", "풀업 11RM → top 6", baseLadder(11, "pullup")[0] === 6, S(baseLadder(11, "pullup")));
add("베이스", "푸시업 17RM → top 8", baseLadder(17, "pushup")[0] === 8, S(baseLadder(17, "pushup")));
add("베이스", "풀업 1RM → [1,1,1,1,1]", eq(baseLadder(1, "pullup"), [1, 1, 1, 1, 1]), S(baseLadder(1, "pullup")));
add("베이스", "makeBase(10/18) = {pullup,pushup} 5개씩", eq(BASE, { pullup: [6, 5, 4, 3, 2], pushup: [9, 8, 7, 6, 5] }), S(BASE));
{
  // 1~150 전 범위 — 정수 분수 floor(r*3/5)·floor(r/2), 1회씩 내려가며 최소 1. floor(r*0.6)과도 한 번도 안 갈린다.
  const bad: string[] = [];
  for (let r = 1; r <= 150; r++) {
    const puTop = Math.max(1, Math.floor((r * 3) / 5));
    const psTop = Math.max(1, Math.floor(r / 2));
    const pu = baseLadder(r, "pullup");
    const ps = baseLadder(r, "pushup");
    const expPu = [0, 1, 2, 3, 4].map((i) => Math.max(1, puTop - i));
    const expPs = [0, 1, 2, 3, 4].map((i) => Math.max(1, psTop - i));
    if (!eq(pu, expPu) || !eq(ps, expPs)) bad.push(`r=${r}`);
    if (Math.max(1, Math.floor(r * 0.6)) !== puTop) bad.push(`r=${r} 0.6≠3/5`);
  }
  add("베이스", "1~150 전 범위 정수 분수 사다리(최소 1)", bad.length === 0, bad.length ? bad.slice(0, 5).join(",") : "150×2 일치");
}
add(
  "베이스",
  "낮은 RM 경고: 풀업 <9·푸시업 <10일 때만",
  lowRmWarning({ pullup: 8, pushup: 18 }) && !lowRmWarning({ pullup: 9, pushup: 10 }) && lowRmWarning({ pullup: 10, pushup: 9 }),
  `8/18=${lowRmWarning({ pullup: 8, pushup: 18 })} 9/10=${lowRmWarning({ pullup: 9, pushup: 10 })} 10/9=${lowRmWarning({ pullup: 10, pushup: 9 })}`,
);
add(
  "베이스",
  "RM 범위 1~150 정수만 유효",
  isValidRm(1) && isValidRm(150) && !isValidRm(0) && !isValidRm(151) && !isValidRm(10.5) && !isValidRm(Number.NaN) && !isValidRm("10"),
  "1·150 ok / 0·151·10.5·NaN·'10' 거절",
);
add("베이스", "유효하지 않은 RM → RangeError", throws(() => baseLadder(0, "pullup")) && throws(() => makeBase({ pullup: 10, pushup: 151 })), "0·151");

// ===========================================================================
// 2) 계획 (§19-1 27일 사이클·운동일 목표)
// ===========================================================================
{
  const oracle = oracleGenerate(BASE.pullup, BASE.pushup);
  const workouts = oracle.filter((d) => d.type === "workout");
  const mism = workouts.filter((d) => !eq(targetFor(BASE, d.day), { pullup: d.pu, pushup: d.ps })).map((d) => d.day);
  add("계획", "원안 Python 오라클 20개 운동일 전부 일치(10/18)", workouts.length === 20 && mism.length === 0, mism.length ? `불일치 Day ${mism.join(",")}` : "20/20");
  const oracleRest = oracle.filter((d) => d.type === "rest").map((d) => d.day);
  add(
    "계획",
    "오라클 휴식일 [6,12,18,24] — 전부 비운동일(24는 마무리 휴식)",
    eq(oracleRest, [6, 12, 18, 24]) && oracleRest.every((d) => !isWorkoutDay(d)) && dayKind(24) === "cycle_rest",
    S(oracleRest),
  );
}
{
  // 전 RM 범위에서도 공식 = 오라클
  const bad: string[] = [];
  for (let r = 1; r <= 150; r++) {
    const base: SetPair = { pullup: baseLadder(r, "pullup"), pushup: baseLadder(r, "pushup") };
    for (const d of oracleGenerate(base.pullup, base.pushup)) {
      if (d.type === "workout" && !eq(targetFor(base, d.day), { pullup: d.pu, pushup: d.ps })) bad.push(`r=${r} Day ${d.day}`);
    }
  }
  add("계획", "RM 1~150 전 범위 × 20일 오라클 일치", bad.length === 0, bad.length ? bad.slice(0, 5).join(",") : "3000/3000");
}
{
  // §19-1 기준 픽스처 표 10행
  const table: [number, number[], number, number[], number][] = [
    [1, [6, 5, 4, 3, 2], 20, [9, 8, 7, 6, 5], 35],
    [2, [6, 5, 4, 3, 3], 21, [9, 8, 7, 6, 6], 36],
    [3, [6, 5, 4, 4, 3], 22, [9, 8, 7, 7, 6], 37],
    [4, [6, 5, 5, 4, 3], 23, [9, 8, 8, 7, 6], 38],
    [5, [6, 6, 5, 4, 3], 24, [9, 9, 8, 7, 6], 39],
    [7, [7, 6, 5, 4, 3], 25, [10, 9, 8, 7, 6], 40],
    [11, [7, 7, 6, 5, 4], 29, [10, 10, 9, 8, 7], 44],
    [13, [8, 7, 6, 5, 4], 30, [11, 10, 9, 8, 7], 45],
    [19, [9, 8, 7, 6, 5], 35, [12, 11, 10, 9, 8], 50],
    [23, [9, 9, 8, 7, 6], 39, [12, 12, 11, 10, 9], 54],
  ];
  const plan = buildPlan(BASE);
  const bad: number[] = [];
  for (const [day, pu, puSum, ps, psSum] of table) {
    const t = targetFor(BASE, day);
    const row = plan[day - 1];
    if (!eq(t, { pullup: pu, pushup: ps }) || sum(t.pullup) !== puSum || sum(t.pushup) !== psSum) bad.push(day);
    if (!row || row.day !== day || !eq(row.totals, { pullup: puSum, pushup: psSum }) || !eq(row.target, t)) bad.push(day);
  }
  add("계획", "§19-1 기준 픽스처 표 10행(배열·합·계획표 행)", bad.length === 0, bad.length ? `불일치 Day ${bad.join(",")}` : "10/10");
}
{
  const plan = buildPlan(BASE);
  const pu = sum(plan.map((r) => r.totals?.pullup ?? 0));
  const ps = sum(plan.map((r) => r.totals?.pushup ?? 0));
  add("계획", "사이클 전체 목표 볼륨 풀업 590·푸시업 890", pu === 590 && ps === 890, `풀업 ${pu} · 푸시업 ${ps}`);
}
{
  const plan = buildPlan(BASE);
  const by = (k: string) => plan.filter((r) => r.kind === k).map((r) => r.day);
  const ok =
    plan.length === 27 &&
    plan.every((r, i) => r.day === i + 1 && r.kind === dayKind(r.day)) &&
    by("workout").length === 20 &&
    eq(by("rest"), [6, 12, 18]) &&
    eq(by("cycle_rest"), [24, 25, 26]) &&
    eq(by("retest"), [27]) &&
    plan.filter((r) => r.kind !== "workout").every((r) => r.target === null && r.totals === null);
  add("계획", "Day 종류: 운동 20·rest [6,12,18]·cycle_rest [24,25,26]·retest [27]·27행", ok, `workout=${S(by("workout"))}`);
}
add(
  "계획",
  "nextWorkoutDay 5→7·11→13·23→27·1→2·17→19",
  nextWorkoutDay(5) === 7 && nextWorkoutDay(11) === 13 && nextWorkoutDay(23) === 27 && nextWorkoutDay(1) === 2 && nextWorkoutDay(17) === 19,
  `5→${nextWorkoutDay(5)} 11→${nextWorkoutDay(11)} 23→${nextWorkoutDay(23)}`,
);
add(
  "계획",
  "restDaysBetween (5,7)→[6]·(23,27)→[24,25,26]·(1,2)→[]",
  eq(restDaysBetween(5, 7), [6]) && eq(restDaysBetween(23, 27), [24, 25, 26]) && eq(restDaysBetween(1, 2), []),
  `${S(restDaysBetween(5, 7))} ${S(restDaysBetween(23, 27))} ${S(restDaysBetween(1, 2))}`,
);
add(
  "계획",
  "범위 밖 Day → RangeError·isWorkoutDay 경계",
  throws(() => dayKind(0)) &&
    throws(() => dayKind(28)) &&
    throws(() => dayKind(2.5)) &&
    throws(() => targetFor(BASE, 6)) &&
    throws(() => targetFor(BASE, 27)) &&
    isWorkoutDay(1) &&
    isWorkoutDay(23) &&
    !isWorkoutDay(6) &&
    !isWorkoutDay(24) &&
    !isWorkoutDay(0) &&
    !isWorkoutDay(1.5),
  "dayKind(0/28/2.5)·targetFor(6/27) 던짐",
);

// ===========================================================================
// 3) 스텝·휴식·세트 목록 순서·횟수 (§19-1 슈퍼세트·§19-6 세트 사이 휴식·음성 안내 대상·세트 목록 순서·§19-2 수행 횟수)
// ===========================================================================
{
  const t = targetFor(BASE, 1);
  const steps = supersetSteps(t);
  const order = steps.map((s) => `${s.exercise === "pullup" ? "pu" : "ps"}${s.setIndex}`).join(",");
  const ok =
    steps.length === 10 &&
    order === "pu0,ps0,pu1,ps1,pu2,ps2,pu3,ps3,pu4,ps4" &&
    steps.every((s, k) => s.step === k && s.reps === t[s.exercise][s.setIndex]) &&
    steps[5].exercise === "pushup" &&
    steps[5].setIndex === 2;
  add("스텝·횟수", "10스텝 교차 순서·스텝 5 = 푸시업 setIndex 2", ok, order);
}
{
  // 휴식은 세트(풀업+푸시업) 사이에만 — 2026-09-25 사용자 정정(§19-1 슈퍼세트·§19-6). 기대값은 스펙 문장에서 손으로 적는다.
  const range = Array.from({ length: 15 }, (_, i) => i - 2); // −2..12 (범위 밖 포함)
  const restAfter = range.filter((k) => restFollowsStep(k));
  const afterRest = range.filter((k) => stepFollowsRest(k));
  const oddballs = [2.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 9, 10];
  const noOddball = oddballs.every((k) => !restFollowsStep(k) && !stepFollowsRest(k));
  add(
    "스텝·휴식",
    "휴식은 푸시업 스텝 [1,3,5,7] 뒤에만(풀업 ✓·마지막 ✓ 뒤엔 없음) · 범위 밖·정수 아님 → false",
    eq(restAfter, [1, 3, 5, 7]) && noOddball,
    `휴식 앞=${S(restAfter)}`,
  );
  add("스텝·휴식", "휴식 뒤 스텝 = [2,4,6,8](2~5세트 풀업)", eq(afterRest, [2, 4, 6, 8]), `휴식 뒤=${S(afterRest)}`);
  // 엔진 스텝과 맞물리는지 — 휴식 앞은 전부 푸시업(세트 끝), 휴식 뒤는 전부 풀업(세트 시작), 휴식 4번 = 세트 5개 − 1
  const steps = supersetSteps(targetFor(BASE, 1));
  const aligned =
    steps.filter((st) => restFollowsStep(st.step)).every((st) => st.exercise === "pushup" && st.setIndex < 4) &&
    steps.filter((st) => stepFollowsRest(st.step)).every((st) => st.exercise === "pullup" && st.setIndex > 0) &&
    steps.filter((st) => restFollowsStep(st.step)).length === 4;
  add("스텝·휴식", "휴식 앞 = 1~4세트 푸시업 · 휴식 뒤 = 2~5세트 풀업 · 휴식 4번", aligned, steps.map((st) => (restFollowsStep(st.step) ? `${st.step}|` : `${st.step}`)).join(" "));
}
{
  // 음성 안내 프리페치 대상 — 휴식 끝에 읽히는 스텝 정확히 4개(2~5세트 풀업). 픽스처 4종(보통·Day 23·평평한 1RM·두 자리 수)
  const fixtures: [string, SetPair][] = [
    ["Day 1 (10/18RM)", targetFor(BASE, 1)],
    ["Day 23 (10/18RM)", targetFor(BASE, 23)],
    ["1/1RM 평평", targetFor(makeBase({ pullup: 1, pushup: 1 }), 1)],
    ["150/150RM 두 자리", targetFor(makeBase({ pullup: 150, pushup: 150 }), 1)],
  ];
  const bad: string[] = [];
  for (const [name, t] of fixtures) {
    const picked = stepsAfterRest(t);
    const ok =
      picked.length === 4 &&
      eq(
        picked.map((st) => st.step),
        [2, 4, 6, 8],
      ) &&
      picked.every((st, i) => st.exercise === "pullup" && st.setIndex === i + 1 && st.reps === t.pullup[i + 1]);
    if (!ok) bad.push(`${name}:${S(picked.map((st) => `${st.exercise}${st.setIndex}x${st.reps}`))}`);
  }
  add(
    "스텝·휴식",
    "음성 안내 대상 stepsAfterRest = 정확히 4개(2~5세트 풀업, 목표 횟수 그대로) — 픽스처 4종",
    bad.length === 0,
    bad.length === 0 ? `Day1 → ${S(stepsAfterRest(targetFor(BASE, 1)).map((st) => `pu${st.setIndex + 1}x${st.reps}`))}` : bad.join(" "),
  );
}
// 세트 목록 순서(§19-6 — 2026-09-25 사용자 요청 "완료한 세트는 아래로, 해야 할 세트가 위로 실시간"): 지금 할 세트 맨 위 →
// 남은 세트(번호순) → 완료 세트 맨 아래(번호순). 축하 중인 세트(held)는 축하가 끝날 때까지 제자리(맨 위), 풀업 ✓에는 재배치 없음.
// 기대값은 스펙 문장에서 **손으로** 적는다(구현을 따라 계산하지 않는다). 세트 번호 0..4 = 1~5세트, doneFrom = 완료 구역이 시작하는 위치.
{
  type Row = { order: number[]; doneFrom: number };
  const show = (x: Row) => `${x.order.slice(0, x.doneFrom).join("")}|${x.order.slice(x.doneFrom).join("")}`;
  const NO_HELD: [number, number[], number][] = [
    [0, [0, 1, 2, 3, 4], 5], // 1세트 풀업 — 끝낸 세트 없음(구분선 없음)
    [1, [0, 1, 2, 3, 4], 5], // 1세트 푸시업
    [2, [1, 2, 3, 4, 0], 4], // 2세트 풀업 — 1세트는 맨 아래
    [3, [1, 2, 3, 4, 0], 4],
    [4, [2, 3, 4, 0, 1], 3],
    [5, [2, 3, 4, 0, 1], 3],
    [6, [3, 4, 0, 1, 2], 2],
    [7, [3, 4, 0, 1, 2], 2],
    [8, [4, 0, 1, 2, 3], 1],
    [9, [4, 0, 1, 2, 3], 1], // 5세트 푸시업(마지막 스텝)
  ];
  scenario("세트 목록 순서", "스텝 0~9(축하 없음) = [지금 → 남은(번호순) → 완료(번호순)]·완료 구역 시작 위치", () => {
    const bad = NO_HELD.filter(([k, order, doneFrom]) => !eq(roundDisplayOrder(k, null), { order, doneFrom })).map(
      ([k]) => `step${k}:${show(roundDisplayOrder(k, null))}`,
    );
    add(
      "세트 목록 순서",
      "스텝 0~9(축하 없음) = [지금 → 남은(번호순) → 완료(번호순)]·완료 구역 시작 위치",
      bad.length === 0,
      bad.length === 0 ? NO_HELD.map(([k]) => show(roundDisplayOrder(k, null))).join(" ") : bad.join(" "),
    );
  });
  // 방금 끝낸 세트(= 지금 세트 바로 앞)를 축하 중 — 맨 위 제자리(탭 직전 순서 그대로). 홀수 스텝은 축하 중 휴식을 건너뛰고 풀업 ✓한 경우
  const HELD: [number, number, number[], number][] = [
    [2, 0, [0, 1, 2, 3, 4], 5],
    [3, 0, [0, 1, 2, 3, 4], 5],
    [4, 1, [1, 2, 3, 4, 0], 4],
    [5, 1, [1, 2, 3, 4, 0], 4],
    [6, 2, [2, 3, 4, 0, 1], 3],
    [7, 2, [2, 3, 4, 0, 1], 3],
    [8, 3, [3, 4, 0, 1, 2], 2],
    [9, 3, [3, 4, 0, 1, 2], 2],
  ];
  scenario("세트 목록 순서", "스텝 2~9 + 방금 끝낸 세트 축하 중 → 그 세트가 맨 위 제자리(완료 구역에 아직 안 내려감)", () => {
    const bad = HELD.filter(([k, h, order, doneFrom]) => !eq(roundDisplayOrder(k, h), { order, doneFrom })).map(
      ([k, h]) => `step${k}/held${h}:${show(roundDisplayOrder(k, h))}`,
    );
    add(
      "세트 목록 순서",
      "스텝 2~9 + 방금 끝낸 세트 축하 중 → 그 세트가 맨 위 제자리(완료 구역에 아직 안 내려감)",
      bad.length === 0,
      bad.length === 0 ? HELD.map(([k, h]) => `${k}/${h}=${show(roundDisplayOrder(k, h))}`).join(" ") : bad.join(" "),
    );
  });
  scenario("세트 목록 순서", "푸시업 ✓(세트 끝) 탭 순간 재배치 없음 → 축하가 끝나면 끝낸 세트는 완료 구역 맨 아래·다음 세트가 맨 위", () => {
    const bad: string[] = [];
    for (let r = 0; r <= 3; r++) {
      const before = roundDisplayOrder(2 * r + 1, null); // r+1세트 푸시업 차례
      const atTap = roundDisplayOrder(2 * r + 2, r); // ✓ 직후(스텝은 이미 다음 세트) — 축하 중
      const after = roundDisplayOrder(2 * r + 2, null); // 축하 끝
      const ok =
        eq(atTap, before) &&
        after.order[0] === r + 1 &&
        after.order[after.order.length - 1] === r &&
        after.doneFrom === before.doneFrom - 1;
      if (!ok) bad.push(`r${r}:${show(before)}→${show(atTap)}→${show(after)}`);
    }
    add(
      "세트 목록 순서",
      "푸시업 ✓(세트 끝) 탭 순간 재배치 없음 → 축하가 끝나면 끝낸 세트는 완료 구역 맨 아래·다음 세트가 맨 위",
      bad.length === 0,
      bad.length === 0 ? "1~4세트 끝 전부 탭 순간 = 탭 직전, 축하 끝 = 끝낸 세트 맨 아래" : bad.join(" "),
    );
  });
  scenario("세트 목록 순서", "풀업 ✓(같은 세트의 푸시업으로) 직후 재배치 없음 — 축하 없음·앞 세트 축하 중 둘 다", () => {
    const bad: string[] = [];
    for (let r = 0; r <= 4; r++) {
      for (const h of r >= 1 ? [null, r - 1] : [null]) {
        const a = roundDisplayOrder(2 * r, h);
        const b = roundDisplayOrder(2 * r + 1, h);
        if (!eq(a, b)) bad.push(`r${r}/held${h}:${show(a)}→${show(b)}`);
      }
    }
    add("세트 목록 순서", "풀업 ✓(같은 세트의 푸시업으로) 직후 재배치 없음 — 축하 없음·앞 세트 축하 중 둘 다", bad.length === 0, bad.length === 0 ? "1~5세트 풀업 ✓ 9경우" : bad.join(" "));
  });
  scenario("세트 목록 순서", "아직 안 끝난 세트·범위 밖·정수 아닌 held는 무시(축하 없음과 같다)", () => {
    const bad: string[] = [];
    for (const [k] of NO_HELD) {
      const cur = Math.floor(k / 2);
      const junk = [...Array.from({ length: 5 - cur }, (_, i) => cur + i), -1, 5, 1.5, Number.NaN];
      for (const h of junk) if (!eq(roundDisplayOrder(k, h), roundDisplayOrder(k, null))) bad.push(`step${k}/held${h}:${show(roundDisplayOrder(k, h))}`);
    }
    add("세트 목록 순서", "아직 안 끝난 세트·범위 밖·정수 아닌 held는 무시(축하 없음과 같다)", bad.length === 0, bad.length === 0 ? "스텝 0~9 × 무효 held" : bad.slice(0, 6).join(" "));
  });
  scenario("세트 목록 순서", "held가 두 세트 이상 뒤여도 held만 맨 위 — 다른 끝낸 세트는 완료 구역(번호순) · 모든 입력에서 0..4 순열", () => {
    // 지금은 축하(1초) < 연타 가드(1.2초)라 도달하지 않는 조합이지만, 두 상수가 바뀌어도 끝낸 세트가 남은 구역에 끼지 않게 잠근다
    const deep = [
      [roundDisplayOrder(6, 0), { order: [0, 3, 4, 1, 2], doneFrom: 3 }],
      [roundDisplayOrder(8, 1), { order: [1, 4, 0, 2, 3], doneFrom: 2 }],
    ] as const;
    const deepOk = deep.every(([got, want]) => eq(got, want));
    const weird: string[] = [];
    const stepsAll = [-3, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 99, 2.5, Number.NaN];
    const heldAll: (number | null)[] = [null, -1, 0, 1, 2, 3, 4, 5, 1.5, Number.NaN];
    for (const k of stepsAll) {
      for (const h of heldAll) {
        const x = roundDisplayOrder(k, h);
        const doneZone = x.order.slice(x.doneFrom);
        const perm = eq([...x.order].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
        const asc = doneZone.every((v, i) => i === 0 || doneZone[i - 1] < v);
        if (!perm || !asc || x.doneFrom < 1 || x.doneFrom > 5) weird.push(`step${k}/held${h}:${show(x)}`);
      }
    }
    add(
      "세트 목록 순서",
      "held가 두 세트 이상 뒤여도 held만 맨 위 — 다른 끝낸 세트는 완료 구역(번호순) · 모든 입력에서 0..4 순열",
      deepOk && weird.length === 0,
      `${deep.map(([got]) => show(got)).join(" ")}${weird.length ? ` 이상=${weird.slice(0, 4).join(" ")}` : ""}`,
    );
  });
}
{
  const t = targetFor(BASE, 1);
  const r = repsForEvent(t, "fail", { exercise: "pushup", setIndex: 2, reps: 4 });
  add("스텝·횟수", "Day 1 푸시업 3세트 4회 실패 → [6,5,4,0,0]/[9,8,4,0,0]", eq(r, { pullup: [6, 5, 4, 0, 0], pushup: [9, 8, 4, 0, 0] }), S(r));
  const r0 = repsForEvent(t, "fail", { exercise: "pullup", setIndex: 0, reps: null });
  add("스텝·횟수", "풀업 1세트 횟수 없음(null) → 전부 0", eq(r0, { pullup: [0, 0, 0, 0, 0], pushup: [0, 0, 0, 0, 0] }), S(r0));
  const rOver = repsForEvent(t, "fail", { exercise: "pushup", setIndex: 2, reps: 99 });
  add("스텝·횟수", "목표 초과 횟수 → 목표로(0..목표 — 자세 무너짐도 담는다)", eq(rOver, { pullup: [6, 5, 4, 0, 0], pushup: [9, 8, 7, 0, 0] }), S(rOver));
  const rNeg = repsForEvent(t, "fail", { exercise: "pullup", setIndex: 1, reps: -3 });
  add("스텝·횟수", "음수 횟수 → 0", eq(rNeg, { pullup: [6, 0, 0, 0, 0], pushup: [9, 0, 0, 0, 0] }), S(rNeg));
  const rc = repsForEvent(t, "complete", null);
  add("스텝·횟수", "complete → 목표 그대로(복사본)", eq(rc, t) && rc.pullup !== t.pullup, S(rc));
  add(
    "스텝·횟수",
    "fail인데 failed 없음·setIndex 범위 밖 → RangeError",
    throws(() => repsForEvent(t, "fail", null)) && throws(() => repsForEvent(t, "fail", { exercise: "pullup", setIndex: 5, reps: 1 })),
    "null·setIndex 5",
  );
}
scenario("스텝·횟수", "재부여 실패의 reps는 Day 5 목표 기준(서버 계산)", () => {
  // Day 1~5 완료 → Day 6 휴식 → Day 7 실패 → 회복 → (7,5) 재부여에서 풀업 5세트 1회 실패
  let { c, date } = completeThrough(newCycle(), D0, 5);
  c = log(c, shiftDateString(date, 2), "fail");
  const repeatDate = shiftDateString(date, 4);
  const st = todayStatus(c, repeatDate);
  c = log(c, repeatDate, "fail", { exercise: "pullup", setIndex: 4, reps: 1 });
  const ev = c.events[c.events.length - 1];
  // Day 5 목표 풀업 [6,6,5,4,3] 푸시업 [9,9,8,7,6] — 풀업 5세트(스텝 8)에서 1회, 푸시업 5세트(스텝 9)는 0
  add(
    "스텝·횟수",
    "재부여 실패의 reps는 Day 5 목표 기준(서버 계산)",
    desc(st) === "workout(7,5)" && ev.day === 7 && ev.targetDay === 5 && eq(ev.reps, { pullup: [6, 6, 5, 4, 1], pushup: [9, 9, 8, 7, 0] }),
    `${desc(st)} reps=${S(ev.reps)}`,
  );
});

// ===========================================================================
// 4) 상태 (§19-2 재생·휴식 슬롯·오늘 상태)
// ===========================================================================
{
  const c = newCycle({ startDate: dt(2) });
  const st = todayStatus(c, D0);
  add(
    "상태",
    "사건 없음·시작 전 → not_started(daysUntil 2, displayDay 1)",
    st.kind === "not_started" && st.daysUntil === 2 && st.startDate === dt(2) && st.displayDay === 1,
    S(st),
  );
  const st0 = todayStatus(c, dt(2));
  add(
    "상태",
    "시작일 당일 → Day 1 운동(isRepeat false, 목표 20/35)",
    st0.kind === "workout" && st0.day === 1 && st0.targetDay === 1 && !st0.isRepeat && !st0.retestHint && st0.displayDay === 1 && eq(st0.totals, { pullup: 20, pushup: 35 }) && eq(st0.target, targetFor(BASE, 1)),
    S(st0),
  );
  add("상태", "열흘 뒤에도 Day 1(운동일은 기다린다)", desc(todayStatus(c, dt(12))) === "workout(1,1)", desc(todayStatus(c, dt(12))));
}
scenario("상태", "Day 1 완료 당일 → recorded_today(complete, tomorrow Day 2)", () => {
  const c = log(newCycle(), D0, "complete");
  const st = todayStatus(c, D0);
  add(
    "상태",
    "Day 1 완료 당일 → recorded_today(complete, tomorrow Day 2)",
    st.kind === "recorded_today" && st.outcome === "complete" && st.day === 1 && st.displayDay === 1 && desc(st.tomorrow) === "workout(2,2)",
    S(st),
  );
});
scenario("상태", "Day 5 완료 D → D+1 rest 6 → D+2 Day 7 → D+5 Day 7", () => {
  const { c, date } = completeThrough(newCycle(), D0, 5);
  const run = [0, 1, 2, 5].map((i) => desc(todayStatus(c, shiftDateString(date, i))));
  const rest = todayStatus(c, shiftDateString(date, 1));
  const recorded = todayStatus(c, date);
  add(
    "상태",
    "Day 5 완료 D → D+1 rest 6 → D+2 Day 7 → D+5 Day 7",
    eq(run, ["recorded(complete,5,5)", "rest(6,1/1)", "workout(7,7)", "workout(7,7)"]) &&
      rest.kind === "rest" &&
      rest.displayDay === 6 &&
      desc(rest.next) === "workout(7,7)" &&
      recorded.kind === "recorded_today" &&
      desc(recorded.tomorrow) === "rest(6,1/1)",
    run.join(" → "),
  );
});
scenario("상태", "Day 2 완료 D → D+4 Day 3", () => {
  const { c, date } = completeThrough(newCycle(), D0, 2);
  const s = desc(todayStatus(c, shiftDateString(date, 4)));
  add("상태", "Day 2 완료 D → D+4 Day 3", s === "workout(3,3)", s);
});
scenario("상태", "Day 23 완료 → 24·25·26 마무리 휴식(1..3/3) → 재측정 → 한 달 뒤에도 재측정", () => {
  const { c, date } = completeThrough(newCycle(), D0, 23);
  const run = statusRun(c, date, 5);
  const r1 = todayStatus(c, shiftDateString(date, 1));
  const later = todayStatus(c, shiftDateString(date, 30));
  add(
    "상태",
    "Day 23 완료 → 24·25·26 마무리 휴식(1..3/3) → 재측정 → 한 달 뒤에도 재측정",
    eq(run, ["recorded(complete,23,23)", "rest(24,1/3,end)", "rest(25,2/3,end)", "rest(26,3/3,end)", "retest"]) &&
      r1.kind === "rest" &&
      r1.displayDay === 24 &&
      later.kind === "retest" &&
      later.displayDay === 27,
    `${run.join(" → ")} / D+30 ${desc(later)}`,
  );
});
scenario("상태", "실패 → 당일 기록함(fail) → 회복 → 재부여(X,X−1) → 성공 → (X,X) → 성공 → X+1", () => {
  let { c, date } = completeThrough(newCycle(), D0, 2);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail", { exercise: "pullup", setIndex: 2, reps: 2 });
  const s0 = todayStatus(c, D);
  const s1 = todayStatus(c, shiftDateString(D, 1));
  const s2 = todayStatus(c, shiftDateString(D, 2));
  c = log(c, shiftDateString(D, 2), "complete");
  const s2b = todayStatus(c, shiftDateString(D, 2));
  const s3 = todayStatus(c, shiftDateString(D, 3));
  c = log(c, shiftDateString(D, 3), "complete");
  const s4 = todayStatus(c, shiftDateString(D, 4));
  const ok =
    s0.kind === "recorded_today" &&
    s0.outcome === "fail" &&
    s0.displayDay === 3 &&
    desc(s0.tomorrow) === "recovery(3)" &&
    s1.kind === "recovery" &&
    s1.pendingDay === 3 &&
    s1.resumeTargetDay === 2 &&
    s1.displayDay === 3 &&
    desc(s1.next) === "workout(3,2)" &&
    s2.kind === "workout" &&
    s2.day === 3 &&
    s2.targetDay === 2 &&
    s2.isRepeat &&
    s2.displayDay === 3 &&
    eq(s2.target, targetFor(BASE, 2)) &&
    desc(s3) === "workout(3,3)" &&
    s3.kind === "workout" &&
    !s3.isRepeat &&
    desc(s4) === "workout(4,4)";
  add(
    "상태",
    "실패 → 당일 기록함(fail) → 회복 → 재부여(X,X−1) → 성공 → (X,X) → 성공 → X+1",
    ok,
    [s0, s1, s2, s2b, s3, s4].map(desc).join(" → "),
  );
  add(
    "상태",
    "재부여 성공 당일 → recorded_today(repeat_complete, tomorrow = 같은 Day, 휴식 없음)",
    s2b.kind === "recorded_today" && s2b.outcome === "repeat_complete" && s2b.day === 3 && s2b.targetDay === 2 && s2b.displayDay === 3 && desc(s2b.tomorrow) === "workout(3,3)",
    S(s2b),
  );
});
scenario("상태", "Day 7 실패 → Day 5 목표(Day 6 휴식 재삽입 없음)", () => {
  let { c, date } = completeThrough(newCycle(), D0, 5);
  const D = shiftDateString(date, 2); // Day 6 휴식 다음 날
  c = log(c, D, "fail");
  const before = statusRun(c, D, 3);
  c = log(c, shiftDateString(D, 2), "complete");
  const after = desc(todayStatus(c, shiftDateString(D, 3)));
  add(
    "상태",
    "Day 7 실패 → Day 5 목표(Day 6 휴식 재삽입 없음)",
    eq(before, ["recorded(fail,7,7)", "recovery(7)", "workout(7,5)"]) && after === "workout(7,7)",
    `${before.join(" → ")} → 성공 → ${after}`,
  );
});
scenario("상태", "Day 1 실패 → Day 1 재도전(isRepeat false)", () => {
  const c = log(newCycle(), D0, "fail");
  const rec = todayStatus(c, dt(1));
  const st = todayStatus(c, dt(2));
  add(
    "상태",
    "Day 1 실패 → Day 1 재도전(isRepeat false)",
    rec.kind === "recovery" && rec.pendingDay === 1 && rec.resumeTargetDay === 1 && st.kind === "workout" && st.day === 1 && st.targetDay === 1 && !st.isRepeat,
    `${desc(rec)} → ${desc(st)}`,
  );
});
scenario("상태", "재부여 실패 → 같은 목표 다시 + retestHint", () => {
  let { c, date } = completeThrough(newCycle(), D0, 5);
  const D = shiftDateString(date, 2);
  c = log(c, D, "fail"); // Day 7 실패 (1회)
  const first = todayStatus(c, shiftDateString(D, 2));
  c = log(c, shiftDateString(D, 2), "fail"); // (7,5) 재부여도 실패 (2회)
  const st = todayStatus(c, shiftDateString(D, 4));
  add(
    "상태",
    "재부여 실패 → 같은 목표 다시 + retestHint",
    first.kind === "workout" && !first.retestHint && st.kind === "workout" && st.day === 7 && st.targetDay === 5 && st.retestHint,
    `1회 후 ${desc(first)} hint=${first.kind === "workout" && first.retestHint} / 2회 후 ${desc(st)} hint=${st.kind === "workout" && st.retestHint}`,
  );
});
scenario("상태", "실패 → 재부여 성공 → 실패 루프 → retestHint true", () => {
  let { c, date } = completeThrough(newCycle(), D0, 5);
  const D = shiftDateString(date, 2);
  c = log(c, D, "fail"); // Day 7 실패
  c = log(c, shiftDateString(D, 2), "complete"); // (7,5) 재부여 성공 — 실패 수를 되돌리지 않는다
  const mid = todayStatus(c, shiftDateString(D, 3)); // (7,7) — 아직 1회
  c = log(c, shiftDateString(D, 3), "fail"); // Day 7 또 실패
  const st = todayStatus(c, shiftDateString(D, 5));
  add(
    "상태",
    "실패 → 재부여 성공 → 실패 루프 → retestHint true",
    mid.kind === "workout" && desc(mid) === "workout(7,7)" && !mid.retestHint && st.kind === "workout" && desc(st) === "workout(7,5)" && st.retestHint,
    `${desc(mid)} hint=${mid.kind === "workout" && mid.retestHint} → 실패 → ${desc(st)} hint=${st.kind === "workout" && st.retestHint}`,
  );
});
scenario("상태", "보통 성공은 실패 수를 0으로(다음 Day에 안내 안 뜸)", () => {
  let c = log(newCycle(), D0, "fail"); // Day 1 실패
  c = log(c, dt(2), "fail"); // Day 1 또 실패 → hint
  const hinted = todayStatus(c, dt(4));
  c = log(c, dt(4), "complete"); // Day 1 보통 성공
  const st = todayStatus(c, dt(5));
  add(
    "상태",
    "보통 성공은 실패 수를 0으로(다음 Day에 안내 안 뜸)",
    hinted.kind === "workout" && hinted.retestHint && st.kind === "workout" && st.day === 2 && !st.retestHint,
    `${desc(hinted)} hint → 성공 → ${desc(st)}`,
  );
});
scenario("상태", "실패 후 닷새 뒤 첫 접속 → 재부여 운동", () => {
  let { c, date } = completeThrough(newCycle(), D0, 2);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail");
  const s = desc(todayStatus(c, shiftDateString(D, 5)));
  add("상태", "실패 후 닷새 뒤 첫 접속 → 재부여 운동", s === "workout(3,2)", s);
});
scenario("상태", "Day 23 실패 → 22 → 23 → 24~26 → 27", () => {
  let { c, date } = completeThrough(newCycle(), D0, 22);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail");
  const seq = [desc(todayStatus(c, shiftDateString(D, 1)))];
  seq.push(desc(todayStatus(c, shiftDateString(D, 2))));
  c = log(c, shiftDateString(D, 2), "complete");
  seq.push(desc(todayStatus(c, shiftDateString(D, 3))));
  c = log(c, shiftDateString(D, 3), "complete");
  seq.push(...statusRun(c, shiftDateString(D, 4), 4));
  add(
    "상태",
    "Day 23 실패 → 22 → 23 → 24~26 → 27",
    eq(seq, ["recovery(23)", "workout(23,22)", "workout(23,23)", "rest(24,1/3,end)", "rest(25,2/3,end)", "rest(26,3/3,end)", "retest"]),
    seq.join(" → "),
  );
});
scenario("상태", "Day 5 실패 → 4 → 5 → 6 → 7", () => {
  let { c, date } = completeThrough(newCycle(), D0, 4);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail");
  const seq = [desc(todayStatus(c, shiftDateString(D, 1))), desc(todayStatus(c, shiftDateString(D, 2)))];
  c = log(c, shiftDateString(D, 2), "complete");
  seq.push(desc(todayStatus(c, shiftDateString(D, 3))));
  c = log(c, shiftDateString(D, 3), "complete");
  seq.push(...statusRun(c, shiftDateString(D, 4), 2));
  add("상태", "Day 5 실패 → 4 → 5 → 6 → 7", eq(seq, ["recovery(5)", "workout(5,4)", "workout(5,5)", "rest(6,1/1)", "workout(7,7)"]), seq.join(" → "));
});
{
  const ok =
    diffDateStrings("2026-09-30", "2026-10-01") === 1 &&
    diffDateStrings("2026-12-31", "2027-01-01") === 1 &&
    diffDateStrings("2028-02-28", "2028-03-01") === 2 &&
    diffDateStrings("2026-10-01", "2026-09-30") === -1 &&
    diffDateStrings("2026-09-24", "2026-09-24") === 0 &&
    diffDateStrings("2026-01-01", "2026-12-31") === 364;
  add("상태", "diffDateStrings 월·연 경계·윤년·음수·같은 날", ok, `09-30→10-01=${diffDateStrings("2026-09-30", "2026-10-01")}`);
}
scenario("상태", "diffDateStrings 형식·달력 밖 → NaN", () => {
  // 형식이 틀리면 NaN(주석의 약속) — 예전엔 ""가 1900-01-01로, "2026-02-30"이 03-02로 조용히 해석됐다(QA F6).
  const bad =["", "2026-09", "2026-13-01", "2026-00-10", "2026-09-00", "2026-02-30", "2026-02-29", "2026-04-31", "2026-9-1", " 2026-09-01", "2026-09-01T00:00", "abc"];
  const leaked = bad.filter((b) => !Number.isNaN(diffDateStrings(b, "2026-09-01")) || !Number.isNaN(diffDateStrings("2026-09-01", b)));
  const nonString = [undefined, null, 20260901].filter((v) => !Number.isNaN(diffDateStrings(v as unknown as string, "2026-09-01")));
  const leap = diffDateStrings("2028-02-29", "2028-03-01") === 1 && diffDateStrings("2024-02-29", "2024-02-29") === 0;
  add(
    "상태",
    "diffDateStrings 형식·달력 밖('', 월 13, 2월 30, 평년 2월 29 …)·비문자열 → NaN, 윤일은 유효",
    leaked.length === 0 && nonString.length === 0 && leap,
    leaked.length || nonString.length ? `NaN 아님: ${S(leaked)} ${S(nonString)}` : `${bad.length}종 NaN · 윤일 ok`,
  );
});
{
  // 성질 — 2025~2028 모든 날 d: diff(d,d)=0, diff(d, shift(d,k))=k. 엄격 검증이 유효한 날짜를 NaN으로 떨구지 않는다.
  const bad: string[] = [];
  const ks = [-400, -31, -1, 1, 29, 365, 800];
  for (let i = 0; i < 4 * 366; i++) {
    const d = shiftDateString("2025-01-01", i);
    if (diffDateStrings(d, d) !== 0) bad.push(`${d}:0`);
    for (const k of ks) if (diffDateStrings(d, shiftDateString(d, k)) !== k) bad.push(`${d}:${k}`);
  }
  add("상태", "diffDateStrings ↔ shiftDateString 역관계(2025~2028 매일 × 7간격)", bad.length === 0, bad.length ? bad.slice(0, 5).join(",") : `${4 * 366 * 8}쌍 일치`);
}
scenario("상태", "월 경계 gap(09-30 → 10-01 = 1)", () => {
  let c = newCycle({ startDate: "2026-09-29" });
  c = log(c, "2026-09-29", "complete");
  c = log(c, "2026-09-30", "complete");
  const s = desc(todayStatus(c, "2026-10-01"));
  add("상태", "월 경계 gap(09-30 완료 → 10-01 Day 3)", s === "workout(3,3)", s);
});

// ===========================================================================
// 5) 판정 함수 (§19-4 decideLog·decideUndo·decideStart, §19-3 closingStatus)
// ===========================================================================
scenario("판정 decideLog", "거절 분기", () => {
  const c1 = log(newCycle(), D0, "complete"); // Day 1 완료(rev 1)
  const base = { expectedRev: c1.rev, kind: "complete" as const, failed: null, durationSec: null, todayKst: D0, nowIso: nowIsoFor(D0) };
  const twice = decideLog(c1, { ...base, day: 2, targetDay: 2 });
  add("판정 decideLog", "같은 날 두 번째 기록 → stale_state", twice.status === "stale_state", twice.status);

  const { c: c5, date: d5 } = completeThrough(newCycle(), D0, 5);
  const onRest = decideLog(c5, { ...base, expectedRev: c5.rev, day: 7, targetDay: 7, todayKst: shiftDateString(d5, 1) });
  const { c: c23, date: d23 } = completeThrough(newCycle(), D0, 23);
  const onRetest = decideLog(c23, { ...base, expectedRev: c23.rev, day: 23, targetDay: 23, todayKst: shiftDateString(d23, 4) });
  const onCycleRest = decideLog(c23, { ...base, expectedRev: c23.rev, day: 23, targetDay: 23, todayKst: shiftDateString(d23, 2) });
  const notStarted = decideLog(newCycle({ startDate: dt(1) }), { ...base, expectedRev: 0, day: 1, targetDay: 1 });
  const cFail = log(newCycle(), D0, "fail");
  const onRecovery = decideLog(cFail, { ...base, expectedRev: cFail.rev, day: 1, targetDay: 1, todayKst: dt(1) });
  add(
    "판정 decideLog",
    "휴식·마무리 휴식·회복·재측정·시작 전 → stale_state",
    [onRest, onCycleRest, onRecovery, onRetest, notStarted].every((r) => r.status === "stale_state"),
    [onRest, onCycleRest, onRecovery, onRetest, notStarted].map((r) => r.status).join(","),
  );

  const c0 = newCycle();
  const dayMismatch = decideLog(c0, { ...base, expectedRev: 0, day: 2, targetDay: 2 });
  let cr = log(newCycle(), D0, "complete");
  cr = log(cr, dt(1), "fail"); // Day 2 실패 → 재부여 (2,1)
  const targetMismatch = decideLog(cr, { ...base, expectedRev: cr.rev, day: 2, targetDay: 2, todayKst: dt(3) });
  add(
    "판정 decideLog",
    "day·targetDay 불일치 → stale_state",
    dayMismatch.status === "stale_state" && targetMismatch.status === "stale_state" && desc(todayStatus(cr, dt(3))) === "workout(2,1)",
    `${dayMismatch.status}, ${targetMismatch.status}`,
  );

  const revMismatch = decideLog(newCycle({ rev: 3 }), { ...base, expectedRev: 2, day: 1, targetDay: 1 });
  add("판정 decideLog", "rev 불일치 → conflict", revMismatch.status === "conflict", revMismatch.status);

  const closed = decideLog(newCycle({ status: "abandoned", endedAt: nowIsoFor(D0) }), { ...base, expectedRev: 0, day: 1, targetDay: 1 });
  add("판정 decideLog", "닫힌 사이클 → not_active", closed.status === "not_active", closed.status);
});
scenario("판정 decideLog", "day만 다른 요청(targetDay 일치) → stale_state", () => {
  // Day 7 실패 → 회복 → 오늘 (7,5). Day 5 화면을 띄워 둔 낡은 탭은 {day 5, targetDay 5}를 보낸다 — targetDay만 보면 통과해 버린다.
  let { c, date } = completeThrough(newCycle(), D0, 5);
  const D = shiftDateString(date, 2);
  c = log(c, D, "fail");
  const T = shiftDateString(D, 2);
  const st = desc(todayStatus(c, T));
  const req = { expectedRev: c.rev, kind: "complete" as const, failed: null, durationSec: null, todayKst: T, nowIso: nowIsoFor(T) };
  const staleTab = decideLog(c, { ...req, day: 5, targetDay: 5 });
  const fresh = decideLog(c, { ...req, day: 7, targetDay: 5 }); // 대조군 — 같은 입력에서 올바른 쌍은 받는다
  add(
    "판정 decideLog",
    "day만 다른 요청(targetDay 일치) → stale_state",
    st === "workout(7,5)" && staleTab.status === "stale_state" && fresh.status === "ok",
    `${st} · (5,5)→${staleTab.status} · (7,5)→${fresh.status}`,
  );
});
scenario("판정 decideLog", "사건은 서버 계산값", () => {
  const c = newCycle({ rev: 4 });
  const input = {
    expectedRev: 4,
    kind: "fail" as const,
    day: 1,
    targetDay: 1,
    failed: { exercise: "pushup" as const, setIndex: 2, reps: 4 },
    durationSec: null,
    todayKst: dt(3),
    nowIso: "2026-09-04T11:22:33.000Z",
  };
  const r = decideLog(c, input);
  const r2 = decideLog(c, input);
  const ok =
    r.status === "ok" &&
    r.event.date === dt(3) &&
    r.event.at === "2026-09-04T11:22:33.000Z" &&
    r.event.kind === "fail" &&
    r.event.day === 1 &&
    r.event.targetDay === 1 &&
    eq(r.event.failed, { exercise: "pushup", setIndex: 2, reps: 4 }) &&
    eq(r.event.reps, { pullup: [6, 5, 4, 0, 0], pushup: [9, 8, 4, 0, 0] }) &&
    r.next.rev === 5 &&
    r.next.events.length === 1 &&
    eq(r.next.events[0], r.event) &&
    c.rev === 4 &&
    c.events.length === 0; // 입력 불변(순수)
  add("판정 decideLog", "사건 date=today·at=nowIso·reps 서버 계산·rev+1·입력 불변", ok, r.status === "ok" ? S(r.event) : r.status);
  add("판정 decideLog", "결정적(같은 입력 → 같은 출력, 트랜잭션 재시도 안전)·직렬화 가능", S(r) === S(r2) && isPlainData(r), "JSON 동일");

  const over = decideLog(c, { ...input, failed: { exercise: "pushup", setIndex: 2, reps: 99 } });
  add(
    "판정 decideLog",
    "실패 횟수 클램프가 사건 failed에도 반영(99 → 목표 7)",
    over.status === "ok" && over.event.failed?.reps === 7 && eq(over.event.reps.pushup, [9, 8, 7, 0, 0]),
    over.status === "ok" ? S(over.event.failed) : over.status,
  );
  const cmp = decideLog(c, { ...input, kind: "complete", failed: null });
  add(
    "판정 decideLog",
    "complete 사건은 failed null·reps = 목표",
    cmp.status === "ok" && cmp.event.failed === null && eq(cmp.event.reps, targetFor(BASE, 1)),
    cmp.status === "ok" ? S(cmp.event) : cmp.status,
  );
  add("판정 decideLog", "fail인데 failed null → RangeError(입력 형태는 라우트 zod가 보장)", throws(() => decideLog(c, { ...input, failed: null })), "던짐");
});
scenario("판정 decideUndo", "취소", () => {
  const empty = decideUndo(newCycle(), { expectedRev: 0 });
  add("판정 decideUndo", "사건 0개 → empty", empty.status === "empty", empty.status);

  // ABA — 탭 A가 rev 2를 보는 동안 탭 B가 취소 후 다시 기록(사건 수는 같아진다)
  let c = log(newCycle(), D0, "complete");
  c = log(c, dt(1), "complete"); // rev 2, 사건 2
  const seenByA = c.rev;
  const bUndo = decideUndo(c, { expectedRev: c.rev });
  if (bUndo.status !== "ok") throw new Error("B undo 실패");
  const bRelog = log(bUndo.next, dt(1), "fail"); // rev 4, 사건 2
  const aUndo = decideUndo(bRelog, { expectedRev: seenByA });
  add(
    "판정 decideUndo",
    "rev 불일치(ABA: 취소 후 다시 기록해 개수가 같아도) → conflict",
    bRelog.events.length === 2 && bRelog.rev === 4 && aUndo.status === "conflict",
    `사건 ${bRelog.events.length}개 rev ${bRelog.rev} → ${aUndo.status}`,
  );
  add(
    "판정 decideUndo",
    "취소 = 마지막 사건 제거·removed·rev+1·입력 불변",
    bUndo.removed.day === 2 && bUndo.next.events.length === 1 && bUndo.next.rev === 3 && c.events.length === 2 && c.rev === 2,
    S(bUndo.removed),
  );

  const closed = decideUndo(newCycle({ status: "completed", endedAt: nowIsoFor(D0), events: c.events, rev: 2 }), { expectedRev: 2 });
  add("판정 decideUndo", "닫힌 사이클 → not_active", closed.status === "not_active", closed.status);

  const { c: c23, date: d23 } = completeThrough(newCycle(), D0, 23);
  const u = decideUndo(c23, { expectedRev: c23.rev });
  const s = u.status === "ok" ? desc(todayStatus(u.next, shiftDateString(d23, 2))) : u.status;
  add("판정 decideUndo", "Day 23 완료를 Day 25에 취소 → Day 23 운동", s === "workout(23,23)", s);

  let cf = log(newCycle(), D0, "fail");
  const uf = decideUndo(cf, { expectedRev: cf.rev });
  let relog = "";
  if (uf.status === "ok") {
    cf = log(uf.next, D0, "complete");
    relog = desc(todayStatus(cf, D0));
  }
  add("판정 decideUndo", "같은 날 fail → 취소 → complete 허용", relog === "recorded(complete,1,1)", relog || uf.status);
});
scenario("판정 decideStart", "사이클 시작", () => {
  const input = { rm: { pullup: 13, pushup: 20 }, startDate: dt(1), expectedActiveCycleId: null, todayKst: D0, nowIso: nowIsoFor(D0) };

  // 첫 시작
  const first = decideStart([], input, "n1");
  add(
    "판정 decideStart",
    "활성 없음 → created(cycleNo 1·rev 0·events []·base=makeBase(rm))",
    first.status === "ok" &&
      first.mode === "created" &&
      first.record.id === "n1" &&
      first.record.cycleNo === 1 &&
      first.record.rev === 0 &&
      first.record.events.length === 0 &&
      first.record.status === "active" &&
      first.record.endedAt === null &&
      first.record.createdAt === nowIsoFor(D0) &&
      first.record.startDate === dt(1) &&
      eq(first.record.base, makeBase({ pullup: 13, pushup: 20 })) &&
      first.closed === null &&
      !first.closedHadEvents &&
      first.writes.length === 1,
    first.status === "ok" ? S({ mode: first.mode, cycleNo: first.record.cycleNo, writes: first.writes.length }) : first.status,
  );

  // expected 불일치
  const active = newCycle({ id: "a1", cycleNo: 3 });
  const stale = decideStart([active], { ...input, expectedActiveCycleId: null }, "n2");
  const stale2 = decideStart([], { ...input, expectedActiveCycleId: "gone" }, "n2");
  add(
    "판정 decideStart",
    "expectedActiveCycleId 불일치 → conflict(activeCycleId)",
    stale.status === "conflict" && stale.activeCycleId === "a1" && stale2.status === "conflict" && stale2.activeCycleId === null,
    `${S(stale)} ${S(stale2)}`,
  );

  // 사건 0개 활성 → 제자리 교체
  const rep = decideStart([active], { ...input, expectedActiveCycleId: "a1" }, "n3");
  add(
    "판정 decideStart",
    "사건 0개 활성 → replaced(id·cycleNo·createdAt 유지, rm·base·startDate 교체, rev+1)",
    rep.status === "ok" &&
      rep.mode === "replaced" &&
      rep.record.id === "a1" &&
      rep.record.cycleNo === 3 &&
      rep.record.createdAt === active.createdAt &&
      eq(rep.record.rm, { pullup: 13, pushup: 20 }) &&
      eq(rep.record.base, makeBase({ pullup: 13, pushup: 20 })) &&
      rep.record.startDate === dt(1) &&
      rep.record.rev === active.rev + 1 &&
      rep.record.status === "active" &&
      rep.closed === null &&
      !rep.closedHadEvents &&
      rep.writes.length === 1,
    rep.status === "ok" ? S({ mode: rep.mode, id: rep.record.id, cycleNo: rep.record.cycleNo, rev: rep.record.rev }) : rep.status,
  );

  // 사건 있는 활성 → 닫고 새로
  const old = completeThrough(newCycle({ id: "a1", cycleNo: 3 }), D0, 4).c;
  const closedPrev = newCycle({ id: "p1", cycleNo: 2, status: "completed", endedAt: nowIsoFor(D0), createdAt: "2026-08-01T00:00:00.000Z" });
  const nowIso = nowIsoFor(dt(10));
  const cr = decideStart([closedPrev, old], { ...input, expectedActiveCycleId: "a1", todayKst: dt(10), startDate: dt(10), nowIso }, "n4");
  const closedW = cr.status === "ok" ? cr.writes.find((w) => w.id === "a1") : undefined;
  add(
    "판정 decideStart",
    "사건 있는 활성 → closed(abandoned·endedAt·rev+1) + created(cycleNo max+1)",
    cr.status === "ok" &&
      cr.mode === "created" &&
      cr.record.id === "n4" &&
      cr.record.cycleNo === 4 &&
      cr.record.events.length === 0 &&
      eq(cr.closed, { id: "a1", status: "abandoned" }) &&
      cr.closedHadEvents &&
      cr.writes.length === 2 &&
      closedW !== undefined &&
      closedW.status === "abandoned" &&
      closedW.endedAt === nowIso &&
      closedW.rev === old.rev + 1 &&
      closedW.events.length === old.events.length,
    cr.status === "ok" ? S({ closed: cr.closed, cycleNo: cr.record.cycleNo, writes: cr.writes.map((w) => `${w.id}:${w.status}`) }) : cr.status,
  );

  // 20일을 다 마친 사이클을 마무리 휴식 중에 재측정 → completed
  const { c: done23, date: d23 } = completeThrough(newCycle({ id: "a2" }), D0, 23);
  const fin = decideStart([done23], { ...input, expectedActiveCycleId: "a2", todayKst: shiftDateString(d23, 2), startDate: shiftDateString(d23, 3) }, "n5");
  add(
    "판정 decideStart",
    "20일 완료 사이클을 Day 25에 재측정 → closed completed",
    fin.status === "ok" && eq(fin.closed, { id: "a2", status: "completed" }) && fin.record.cycleNo === 2,
    fin.status === "ok" ? S(fin.closed) : fin.status,
  );

  // 레거시 활성 여러 개 — 가장 늦은 것을 대조 기준으로, 나머지도 전부 닫는다
  const la = newCycle({ id: "L1", createdAt: "2026-09-01T00:00:00.000Z", cycleNo: 1 });
  const lb = log(newCycle({ id: "L2", createdAt: "2026-09-02T00:00:00.000Z", cycleNo: 2 }), D0, "complete");
  const multi = decideStart([la, lb], { ...input, expectedActiveCycleId: "L2" }, "n6");
  add(
    "판정 decideStart",
    "레거시 다중 활성 → 가장 늦은 것 기준·나머지도 닫음(활성 1개로 수렴)",
    multi.status === "ok" &&
      eq(multi.closed, { id: "L2", status: "abandoned" }) &&
      multi.writes.filter((w) => w.status === "active").length === 1 &&
      multi.writes.some((w) => w.id === "L1" && w.status === "abandoned") &&
      multi.record.cycleNo === 3,
    multi.status === "ok" ? S(multi.writes.map((w) => `${w.id}:${w.status}`)) : multi.status,
  );

  add(
    "판정 decideStart",
    "잘못된 RM·시작일(오늘/내일 밖) → RangeError",
    throws(() => decideStart([], { ...input, rm: { pullup: 0, pushup: 20 } }, "x")) &&
      throws(() => decideStart([], { ...input, startDate: dt(5) }, "x")) &&
      throws(() => decideStart([], { ...input, startDate: shiftDateString(D0, -1) }, "x")),
    "rm 0·D+5·D−1",
  );
  const again = decideStart([closedPrev, old], { ...input, expectedActiveCycleId: "a1", todayKst: dt(10), startDate: dt(10), nowIso }, "n4");
  add("판정 decideStart", "결정적(같은 입력 → 같은 출력)·직렬화 가능", S(again) === S(cr) && isPlainData(cr) && isPlainData(first), "JSON 동일");
});
scenario("판정 decideStart", "replaced + 레거시 다중 활성", () => {
  // 선택된 활성(L2, 더 최근)은 사건 0개 → 제자리 교체. 여분 활성 L1(더 오래됨)도 닫아 활성 1개로 수렴해야 하고,
  // L1에 사건이 있으면 closedHadEvents = true(Firestore prod-guard 신호). API의 closed는 선택된 활성만 말하므로 null.
  const input = { rm: { pullup: 13, pushup: 20 }, startDate: dt(1), expectedActiveCycleId: "L2", todayKst: D0, nowIso: nowIsoFor(D0) };
  const L1 = log(newCycle({ id: "L1", createdAt: "2026-08-20T00:00:00.000Z", cycleNo: 1 }), D0, "complete");
  const L2 = newCycle({ id: "L2", createdAt: "2026-08-25T00:00:00.000Z", cycleNo: 2 });
  const r = decideStart([L1, L2], input, "n7");
  const w1 = r.status === "ok" ? r.writes.find((w) => w.id === "L1") : undefined;
  const after = r.status === "ok" ? applyWrites([L1, L2], r.writes) : [];
  const actives = after.filter((c) => c.status === "active");
  add(
    "판정 decideStart",
    "replaced + 레거시 여분 활성(사건 있음) → 여분도 닫음·closedHadEvents true·closed null·활성 1개",
    r.status === "ok" &&
      r.mode === "replaced" &&
      r.record.id === "L2" &&
      r.record.cycleNo === 2 &&
      r.closed === null &&
      r.closedHadEvents === true &&
      r.writes.length === 2 &&
      w1 !== undefined &&
      w1.status === "abandoned" &&
      w1.endedAt === nowIsoFor(D0) &&
      w1.rev === L1.rev + 1 &&
      w1.events.length === 1 &&
      actives.length === 1 &&
      actives[0].id === "L2",
    r.status === "ok" ? S({ mode: r.mode, writes: r.writes.map((w) => `${w.id}:${w.status}`), hadEvents: r.closedHadEvents, actives: actives.map((c) => c.id) }) : r.status,
  );

  // 여분 활성에 사건이 없으면 closedHadEvents = false(가드가 헛발동하지 않는다) — 그래도 닫는다
  const E1 = newCycle({ id: "E1", createdAt: "2026-08-20T00:00:00.000Z", cycleNo: 1 });
  const E2 = newCycle({ id: "E2", createdAt: "2026-08-25T00:00:00.000Z", cycleNo: 2 });
  const r2 = decideStart([E1, E2], { ...input, expectedActiveCycleId: "E2" }, "n8");
  const after2 = r2.status === "ok" ? applyWrites([E1, E2], r2.writes) : [];
  add(
    "판정 decideStart",
    "replaced + 레거시 여분 활성(사건 0개) → 닫되 closedHadEvents false",
    r2.status === "ok" &&
      r2.mode === "replaced" &&
      r2.closedHadEvents === false &&
      r2.writes.some((w) => w.id === "E1" && w.status === "abandoned") &&
      after2.filter((c) => c.status === "active").map((c) => c.id).join() === "E2",
    r2.status === "ok" ? S({ writes: r2.writes.map((w) => `${w.id}:${w.status}`), hadEvents: r2.closedHadEvents }) : r2.status,
  );
});
scenario("판정 decideStart", "cycleNo = 전체 max+1", () => {
  // 활성(cycleNo 3)이 최대가 아닌 레거시 — 닫힌 사이클이 cycleNo 5. 활성+1(4)이나 개수+1(3)이 아니라 6이어야 한다.
  const nowIso = nowIsoFor(dt(10));
  const closed5 = newCycle({ id: "k5", cycleNo: 5, status: "completed", endedAt: "2026-08-30T03:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" });
  const act3 = completeThrough(newCycle({ id: "k3", cycleNo: 3 }), D0, 2).c;
  const r = decideStart(
    [act3, closed5],
    { rm: { pullup: 12, pushup: 20 }, startDate: dt(10), expectedActiveCycleId: "k3", todayKst: dt(10), nowIso },
    "k6",
  );
  add(
    "판정 decideStart",
    "cycleNo = 전체 max+1(활성 3·닫힌 5 → 6)",
    r.status === "ok" && r.mode === "created" && r.record.cycleNo === 6 && eq(r.closed, { id: "k3", status: "abandoned" }),
    r.status === "ok" ? `cycleNo ${r.record.cycleNo}` : r.status,
  );
});
scenario("판정 closingStatus", "종료 판정", () => {
  const { c: c23, date: d23 } = completeThrough(newCycle(), D0, 23);
  const mid = completeThrough(newCycle(), D0, 10).c;
  const ok =
    closingStatus(c23) === "completed" && // Day 23 완료 당일
    todayStatus(c23, shiftDateString(d23, 2)).kind === "rest" && // Day 25 — 판정은 사건 재생이라 날짜 무관
    todayStatus(c23, shiftDateString(d23, 4)).kind === "retest" &&
    closingStatus(mid) === "abandoned" &&
    closingStatus(newCycle()) === "abandoned";
  add("판정 closingStatus", "Day 23 완료 당일·Day 25·재측정 → completed / 도중·사건 0 → abandoned", ok, `23=${closingStatus(c23)} 10=${closingStatus(mid)} 0=${closingStatus(newCycle())}`);
});
scenario("판정 closingStatus", "경계 — nextDay 23은 abandoned", () => {
  // Day 22까지만 / Day 23 실패 직후 / (23,22) 재부여 성공 직후 — 전부 nextDay 23이라 abandoned. (23,23) 보통 성공에서야 27 → completed.
  const { c: c22, date: d22 } = completeThrough(newCycle(), D0, 22);
  const D = shiftDateString(d22, 1);
  const f23 = log(c22, D, "fail");
  const rep = log(f23, shiftDateString(D, 2), "complete");
  const fin = log(rep, shiftDateString(D, 3), "complete");
  const seq = [c22, f23, rep, fin].map((c) => `${replay(c.events).nextDay}:${closingStatus(c)}`);
  add(
    "판정 closingStatus",
    "경계 — Day 22까지·Day 23 실패·(23,22) 재부여 성공 → abandoned / (23,23) 성공 → completed",
    eq(seq, ["23:abandoned", "23:abandoned", "23:abandoned", "27:completed"]) && rep.events[rep.events.length - 1].targetDay === 22,
    seq.join(" → "),
  );
});

// ===========================================================================
// 6) 진행률·볼륨·일정·스냅샷
// ===========================================================================
scenario("진행·볼륨", "진행률·볼륨", () => {
  // Day 1·2 완료 → Day 3 실패(풀업 3세트 2회) → (3,2) 재부여 성공 → Day 3 성공
  let { c, date } = completeThrough(newCycle(), D0, 2);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail", { exercise: "pullup", setIndex: 2, reps: 2 });
  c = log(c, shiftDateString(D, 2), "complete");
  c = log(c, shiftDateString(D, 3), "complete");
  const r = replay(c.events);
  // 볼륨: Day1(20/35) + Day2(21/36) + 실패 Day3 목표[6,5,4,4,3]/[9,8,7,7,6] → 풀업 [6,5,2,0,0]=13, 푸시업 [9,8,0,0,0]=17
  //       + 재부여 Day2(21/36) + Day3(22/37)
  const expPu = 20 + 21 + 13 + 21 + 22;
  const expPs = 35 + 36 + 17 + 36 + 37;
  const snap = snapshot(c, shiftDateString(D, 4));
  add(
    "진행·볼륨",
    "진행률 = 서로 다른 보통 완료 Day / 20(재부여 제외), Math.round",
    eq(r.completedDays, [1, 2, 3]) && snap.progress.done === 3 && snap.progress.total === 20 && snap.progress.pct === 15,
    S(snap.progress),
  );
  add(
    "진행·볼륨",
    "볼륨 = 모든 사건 reps 합(실패 부분·재부여 포함)·실패 수",
    eq(r.volume, { pullup: expPu, pushup: expPs }) && eq(snap.volume, r.volume) && r.failCount === 1 && snap.failCount === 1 && r.failsByDay[3] === 1,
    `${S(r.volume)} 기대 ${expPu}/${expPs} fails=${r.failCount}`,
  );
});
scenario("진행·볼륨", "진행률 Math.round — done 0..20 전부", () => {
  // done/20×100은 done=11일 때 55.00000000000001(부동소수 잡음) — 반올림이 빠지면 여기서만 드러난다.
  let c = newCycle();
  let date = D0;
  let done = 0;
  const bad: string[] = [];
  let at11 = "";
  const check = () => {
    const p = snapshot(c, date).progress;
    if (p.done !== done || p.total !== 20 || p.pct !== done * 5 || !Number.isInteger(p.pct)) bad.push(`${done}:${S(p)}`);
    if (done === 11) at11 = S(p);
  };
  check();
  for (let guard = 0; guard < 60 && done < 20; guard++) {
    if (todayStatus(c, date).kind === "workout") {
      c = log(c, date, "complete");
      done += 1;
      check();
    }
    date = shiftDateString(date, 1);
  }
  add(
    "진행·볼륨",
    "진행률 Math.round — done 0..20 전부 pct = done×5 정수(done 11 → 55)",
    done === 20 && bad.length === 0 && at11 === S({ done: 11, total: 20, pct: 55 }),
    bad.length ? bad.slice(0, 3).join(" ") : `21단계 일치 · 11 → ${at11}`,
  );
});
scenario("진행·볼륨", "재부여 성공은 진행률 제외", () => {
  // Day 1·2 완료 → Day 3 실패 → (3,2) 재부여 성공. 그 당일·다음 날·다음 날 또 실패 — 어느 시점에도 Day 3은 ✓가 아니고 done 2.
  // (재부여 성공 뒤 곧바로 Day 3을 보통 완료하면 Set 중복 제거가 차이를 가린다 — 그래서 그 전에 본다)
  let { c, date } = completeThrough(newCycle(), D0, 2);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail");
  const R = shiftDateString(D, 2);
  c = log(c, R, "complete");
  const sR = snapshot(c, R);
  const N = shiftDateString(R, 1);
  const sN = snapshot(c, N);
  const cF = log(c, N, "fail");
  const sF = snapshot(cF, N);
  const chk = (s: ReturnType<typeof snapshot>) =>
    s.progress.done === 2 && s.progress.pct === 10 && s.plan[0].completed && s.plan[1].completed && !s.plan[2].completed;
  add(
    "진행·볼륨",
    "재부여 성공은 진행률·✓ 제외(당일 repeat_complete·다음 날·또 실패 후)",
    sR.today.kind === "recorded_today" &&
      sR.today.outcome === "repeat_complete" &&
      desc(sN.today) === "workout(3,3)" &&
      chk(sR) &&
      chk(sN) &&
      chk(sF) &&
      sF.plan[2].fails === 2 &&
      eq(replay(cF.events).completedDays, [1, 2]),
    `당일 ${S(sR.progress)} · 다음 날 ${S(sN.progress)} · 또 실패 ${S(sF.progress)} ✗${sF.plan[2].fails}`,
  );
});
scenario("일정", "upcoming 시뮬레이션", () => {
  let { c, date } = completeThrough(newCycle(), D0, 2);
  const D = shiftDateString(date, 1);
  c = log(c, D, "fail");
  const up = upcoming(c, D, 3);
  add(
    "일정",
    "실패 당일 upcoming → [회복, (X,X−1), (X,X)] (날짜 D+1..D+3)",
    eq(
      up.map((u) => desc(u.item)),
      ["recovery(3)", "workout(3,2)", "workout(3,3)"],
    ) && eq(
      up.map((u) => u.date),
      [1, 2, 3].map((i) => shiftDateString(D, i)),
    ),
    up.map((u) => `${u.date}:${desc(u.item)}`).join(" "),
  );

  const c4 = completeThrough(newCycle(), D0, 4);
  const today5 = shiftDateString(c4.date, 1);
  const up5 = upcoming(c4.c, today5, 3).map((u) => desc(u.item));
  add("일정", "오늘이 운동일이면 오늘 성공을 가정(Day 5 → [rest 6, 7, 8])", eq(up5, ["rest(6,1/1)", "workout(7,7)", "workout(8,8)"]), up5.join(" "));

  const pre = upcoming(newCycle({ startDate: dt(3) }), D0, 2);
  add(
    "일정",
    "시작 전 날짜는 건너뛰고 시작일부터(날짜로 드러남)",
    eq(
      pre.map((u) => `${u.date}:${desc(u.item)}`),
      [`${dt(3)}:workout(1,1)`, `${dt(4)}:workout(2,2)`],
    ),
    pre.map((u) => `${u.date}:${desc(u.item)}`).join(" "),
  );
  const { c: c23, date: d23 } = completeThrough(newCycle(), D0, 23);
  const tail = upcoming(c23, d23, 5).map((u) => desc(u.item));
  add("일정", "Day 23 완료 당일 → [24,25,26 마무리, 재측정, 재측정]", eq(tail, ["rest(24,1/3,end)", "rest(25,2/3,end)", "rest(26,3/3,end)", "retest", "retest"]), tail.join(" "));
  add("일정", "n ≤ 0 → []", upcoming(c23, d23, 0).length === 0, "0");
});
scenario("스냅샷", "snapshot", () => {
  let { c, date } = completeThrough(newCycle({ id: "s1", cycleNo: 2 }), D0, 5);
  const D = shiftDateString(date, 2);
  c = log(c, D, "fail"); // Day 7 실패
  const today = shiftDateString(D, 1); // 회복
  const snap = snapshot(c, today);
  const row = (d: number) => snap.plan[d - 1];
  const ok =
    snap.cycleId === "s1" &&
    snap.cycleNo === 2 &&
    snap.rev === c.rev &&
    snap.eventCount === 6 &&
    snap.today.kind === "recovery" &&
    snap.plan.length === 27 &&
    row(1).completed &&
    row(5).completed &&
    !row(7).completed &&
    row(7).fails === 1 &&
    row(7).current &&
    snap.plan.filter((r) => r.current).length === 1 &&
    row(6).kind === "rest" &&
    snap.progress.done === 5 &&
    snap.progress.pct === 25 &&
    snap.failCount === 1 &&
    snap.upcoming.length === 3 &&
    snap.lastEvent !== null &&
    snap.lastEvent.kind === "fail" &&
    isPlainData(snap); // 직렬화 가능(Date·undefined 없음 — RSC props)
  add("스냅샷", "plan 27행(✓·✗ 수·▶)·progress·rev·upcoming 3·lastEvent·직렬화 가능", ok, `today=${desc(snap.today)} progress=${S(snap.progress)} up=${snap.upcoming.map((u) => desc(u.item)).join(",")}`);

  const fresh = snapshot(newCycle({ startDate: dt(2) }), D0);
  add(
    "스냅샷",
    "시작 전 — ▶ 없음·진행 0·lastEvent null",
    fresh.today.kind === "not_started" && fresh.plan.every((r) => !r.current) && fresh.progress.done === 0 && fresh.progress.pct === 0 && fresh.lastEvent === null,
    desc(fresh.today),
  );
});
scenario("스냅샷", "✗는 슬롯 day 기준", () => {
  // Day 7 실패(7,7) → (7,5) 재부여도 실패 — 두 번째 실패의 targetDay는 5지만 ✗는 슬롯 Day 7에 쌓인다.
  let { c, date } = completeThrough(newCycle(), D0, 5);
  const D = shiftDateString(date, 2);
  c = log(c, D, "fail");
  c = log(c, shiftDateString(D, 2), "fail");
  const ev = c.events[c.events.length - 1];
  const snap = snapshot(c, shiftDateString(D, 3));
  const r = replay(c.events);
  add(
    "스냅샷",
    "✗는 슬롯 day 기준 — (7,7) 실패 + (7,5) 재부여 실패 → Day 7 ✗2·Day 5 ✗0(✓ 유지)",
    ev.day === 7 && ev.targetDay === 5 && snap.plan[6].fails === 2 && snap.plan[4].fails === 0 && snap.plan[4].completed && r.failsByDay[7] === 2 && r.failsByDay[5] === undefined,
    `Day7 ✗${snap.plan[6].fails} · Day5 ✗${snap.plan[4].fails} · failsByDay=${S(r.failsByDay)}`,
  );
});
{
  const mk = (id: string, createdAt: string, status: WorkoutCycleRecord["status"] = "active") => newCycle({ id, createdAt, status });
  const a = mk("a", "2026-09-01T00:00:00.000Z");
  const b = mk("b", "2026-09-03T00:00:00.000Z");
  const c = mk("c", "2026-09-02T00:00:00.000Z");
  const z = mk("z", "2026-09-09T00:00:00.000Z", "completed");
  const t1 = mk("t1", "2026-09-05T00:00:00.000Z");
  const t2 = mk("t2", "2026-09-05T00:00:00.000Z");
  const p1 = pickActiveWorkoutCycle([a, b, c, z])?.id;
  const p2 = pickActiveWorkoutCycle([c, z, b, a])?.id;
  const tie1 = pickActiveWorkoutCycle([t1, t2])?.id;
  const tie2 = pickActiveWorkoutCycle([t2, t1])?.id;
  add(
    "활성 선택",
    "pickActiveWorkoutCycle 다중 활성 → createdAt 가장 늦은 것(순서 무관·동률은 id로 결정적)·없으면 null",
    p1 === "b" && p2 === "b" && tie1 === tie2 && pickActiveWorkoutCycle([z]) === null && pickActiveWorkoutCycle([]) === null,
    `${p1},${p2} tie=${tie1},${tie2}`,
  );
}
scenario("격리", "사이클 격리", () => {
  const old = completeThrough(newCycle({ id: "o1" }), D0, 11).c;
  const r = decideStart([old], { rm: { pullup: 12, pushup: 20 }, startDate: dt(20), expectedActiveCycleId: "o1", todayKst: dt(20), nowIso: nowIsoFor(dt(20)) }, "n1");
  if (r.status !== "ok") throw new Error(r.status);
  const snap = snapshot(r.record, dt(20));
  add(
    "격리",
    "새 사이클은 이전 사건을 섞지 않는다(Day 1·볼륨 0·실패 0·진행 0)",
    desc(snap.today) === "workout(1,1)" && snap.volume.pullup === 0 && snap.volume.pushup === 0 && snap.failCount === 0 && snap.progress.done === 0 && replay(r.record.events).nextDay === 1,
    `${desc(snap.today)} vol=${S(snap.volume)}`,
  );
});
{
  // 지난 사이클 — RM 변화는 다음 cycleNo의 rm에서 파생(별도 필드 없음)
  const c1 = newCycle({ id: "h1", cycleNo: 1, rm: { pullup: 10, pushup: 18 }, status: "completed", endedAt: "2026-09-28T03:00:00.000Z" });
  const c2 = newCycle({ id: "h2", cycleNo: 2, rm: { pullup: 13, pushup: 20 }, status: "abandoned", endedAt: "2026-10-05T03:00:00.000Z" });
  const c3 = newCycle({ id: "h3", cycleNo: 3, rm: { pullup: 14, pushup: 22 } });
  const h = workoutHistory([c3, c1, c2]);
  add(
    "지난 사이클",
    "workoutHistory — 닫힌 것만·cycleNo 내림차순·nextRm = 다음 사이클 rm",
    h.length === 2 &&
      h[0].id === "h2" &&
      eq(h[0].nextRm, { pullup: 14, pushup: 22 }) &&
      h[0].status === "abandoned" &&
      h[1].id === "h1" &&
      eq(h[1].nextRm, { pullup: 13, pushup: 20 }) &&
      h[1].status === "completed",
    S(h.map((r) => ({ id: r.id, rm: r.rm, nextRm: r.nextRm, status: r.status }))),
  );
  const solo = workoutHistory([newCycle({ id: "only", status: "completed" })]);
  add("지난 사이클", "다음 사이클이 없으면 nextRm null", solo.length === 1 && solo[0].nextRm === null, S(solo[0]?.nextRm));
}

// ===========================================================================
// 7) 정규화 (두 스토어 백엔드 공유 — Firestore는 undefined를 거부한다)
// ===========================================================================
{
  const raw = {
    id: "x",
    createdAt: "2026-09-01T00:00:00.000Z",
    cycleNo: 2,
    startDate: "2026-09-02",
    rm: { pullup: 10, pushup: 18 },
    base: undefined,
    status: "active",
    rev: undefined,
    events: [
      { date: "2026-09-02", at: "2026-09-02T03:00:00.000Z", kind: "complete", day: 1, targetDay: 1, reps: { pullup: [6, 5, 4], pushup: [9, 8, 7, 6, 5] } },
      { date: "2026-09-03", at: "2026-09-03T03:00:00.000Z", kind: "fail", day: 2, targetDay: 2, failed: { exercise: "pushup", setIndex: 1, reps: undefined }, reps: undefined },
    ],
  };
  const n = normalizeWorkoutCycle(raw);
  const json = S(n);
  const ok =
    n.endedAt === null &&
    n.rev === 0 &&
    eq(n.base, BASE) && // base 없으면 rm으로 재계산(방어)
    n.events.length === 2 &&
    n.events[0].failed === null &&
    eq(n.events[0].reps.pullup, [6, 5, 4, 0, 0]) &&
    n.events[1].failed !== null &&
    n.events[1].failed.reps === null &&
    eq(n.events[1].reps, { pullup: [0, 0, 0, 0, 0], pushup: [0, 0, 0, 0, 0] }) &&
    isPlainData(n); // undefined가 하나라도 남으면 Firestore가 거부한다
  add("정규화", "normalizeWorkoutCycle — undefined → null·기본값, base 없으면 rm으로, 배열 5칸", ok, json.slice(0, 160));
  const junk = normalizeWorkoutCycle(undefined);
  add(
    "정규화",
    "쓰레기 입력도 던지지 않고 안전한 닫힌 레코드",
    junk.status === "abandoned" && Array.isArray(junk.events) && junk.events.length === 0 && junk.endedAt === null && junk.base.pullup.length === 5 && typeof junk.createdAt === "string",
    S({ status: junk.status, rm: junk.rm }),
  );
  const e = normalizeWorkoutEvent({ kind: "complete", day: 3, targetDay: 3, failed: { exercise: "pullup", setIndex: 0, reps: 1 }, reps: { pullup: [1, -2, "x"], pushup: null } });
  add(
    "정규화",
    "normalizeWorkoutEvent — complete의 failed는 null·음수/비숫자 → 0",
    e.failed === null && eq(e.reps, { pullup: [1, 0, 0, 0, 0], pushup: [0, 0, 0, 0, 0] }) && e.date === "" && e.at === "",
    S(e),
  );
  // 모르는 Day를 추측하지 않는다 — 예전엔 day 없음 → 1(끝에 있으면 사이클이 Day 2로 되감긴다), 2.5 → 2로 잘랐다
  const noDay = normalizeWorkoutEvent({ date: D0, kind: "complete", targetDay: 3 });
  const floatDay = normalizeWorkoutEvent({ date: D0, kind: "complete", day: 2.5, targetDay: 2 });
  const noTarget = normalizeWorkoutEvent({ date: D0, kind: "complete", day: 3 });
  add(
    "정규화",
    "normalizeWorkoutEvent — day·targetDay가 없거나 정수가 아니면 0(알 수 없음 — 사이클 정규화가 버린다)",
    noDay.day === 0 && noDay.targetDay === 3 && floatDay.day === 0 && floatDay.targetDay === 2 && noTarget.day === 3 && noTarget.targetDay === 0 && isPlainData([noDay, floatDay, noTarget]),
    S([noDay, floatDay, noTarget].map((x) => [x.day, x.targetDay])),
  );
}
scenario("정규화", "깨진 레코드", () => {
  // 손으로 고치거나 깨진 문서 — 예전엔 snapshot이 targetFor(Day 6)에서 RangeError를 던져 /workout이 500이 됐다(QA P2-5).
  const t1 = targetFor(BASE, 1);
  const t2 = targetFor(BASE, 2);
  const ev = (over: Record<string, unknown>) => ({ at: "2026-09-01T03:00:00.000Z", kind: "complete", failed: null, reps: t1, ...over });
  const raw = {
    id: "bk",
    createdAt: "garbage",
    cycleNo: 1,
    startDate: "2026-13-01",
    rm: RM,
    base: BASE,
    status: "active",
    endedAt: null,
    rev: 7,
    events: [
      ev({ date: dt(0), day: 1, targetDay: 1 }), // 정상
      ev({ date: dt(1), day: 6, targetDay: 6 }), // 휴식일 — 운동일 아님
      ev({ date: dt(2), kind: "fail", day: 2, targetDay: 24, failed: FAIL_PU0 }), // targetDay 마무리 휴식
      ev({ date: "", day: 2, targetDay: 2 }), // 날짜 없음
      ev({ date: "2026-02-30", day: 2, targetDay: 2 }), // 달력 밖
      ev({ date: dt(3), targetDay: 2 }), // day 없음
      ev({ date: dt(4), day: 2.5, targetDay: 2 }), // 정수 아님
      ev({ date: dt(5), day: 2, targetDay: 2, reps: t2 }), // 정상
    ],
  };
  const { value: n, warns } = captureWarn(() => normalizeWorkoutCycle(raw));
  const snap = snapshot(n, dt(6));
  add(
    "정규화",
    "깨진 사건(운동일 아닌 day·targetDay, 날짜 없음·달력 밖, day 없음·소수) → 버리고 console.warn",
    n.events.length === 2 &&
      n.events[0].day === 1 &&
      n.events[1].date === dt(5) &&
      warns.length === 6 &&
      warns.every((w) => w.startsWith("[workout]")) &&
      n.rev === 7,
    `남은 ${n.events.length}건 · 경고 ${warns.length}건 · ${warns[0] ?? ""}`,
  );
  add(
    "정규화",
    "createdAt이 ISO가 아니면 epoch ISO·startDate가 달력 밖이면 createdAt의 KST 일자로",
    n.createdAt === "1970-01-01T00:00:00.000Z" && n.startDate === "1970-01-01",
    `${n.createdAt} · ${n.startDate}`,
  );
  add(
    "정규화",
    "깨진 레코드 → 정규화 → snapshot이 던지지 않는다(페이지 500 방지)·직렬화 가능",
    desc(snap.today) === "workout(3,3)" && snap.progress.done === 2 && snap.eventCount === 2 && isPlainData(snap),
    `today=${desc(snap.today)} progress=${S(snap.progress)}`,
  );

  // QA 재현 그대로 — complete Day 6 다음 fail Day 7
  const qa = { ...raw, createdAt: "2026-08-31T03:00:00.000Z", startDate: D0, events: [ev({ date: dt(0), day: 6, targetDay: 6 }), ev({ date: dt(1), kind: "fail", day: 7, targetDay: 7, failed: FAIL_PU0 })] };
  const qn = captureWarn(() => normalizeWorkoutCycle(qa)).value;
  const qs = snapshot(qn, dt(3));
  add("정규화", "QA 재현(complete Day 6 → fail Day 7) → 정규화 후 snapshot 성공", qn.events.length === 1 && isPlainData(qs), `사건 ${qn.events.length}건 · today=${desc(qs.today)}`);

  // 정상 ISO 변형은 그대로 둔다(쓰기 경계에서도 정규화가 돌므로 멀쩡한 값을 epoch로 덮으면 안 된다)
  const keep = ["2026-09-01T00:00:00Z", "2026-09-01T09:00:00+09:00", "2026-09-01T00:00:00.123Z", "2026-09-01"];
  const kept = keep.map((iso) => normalizeWorkoutCycle({ ...raw, createdAt: iso, events: [] }).createdAt);
  const drop = ["2026-09-01T00:00:00", "September 1, 2026", "2026-02-30T00:00:00Z", "", "2026-09-01T25:00:00Z"];
  const dropped = drop.map((iso) => normalizeWorkoutCycle({ ...raw, createdAt: iso, events: [] }).createdAt);
  add(
    "정규화",
    "createdAt — ISO(타임존 있음·날짜만)는 유지, 타임존 없는 로컬 시각·영문·달력 밖·시각 범위 밖은 epoch",
    eq(kept, keep) && dropped.every((x) => x === "1970-01-01T00:00:00.000Z"),
    `${S(kept)} / ${S(dropped)}`,
  );

  // ISO 판정은 lib/kst isZonedIsoTimestamp 한 곳 — "만든 날짜" 표시(formatKstDate)와 경계가 같아야 한다(예전엔 운동만
  // 소수 1~9자리·24:00을 받아 `…15:00:00.123456Z`를 표시는 폴백, 운동은 유효로 봤다). 경계값은 기대값으로 직접 적는다.
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const boundary: { iso: string; keep: boolean }[] = [
    { iso: "2026-09-01T00:00:00.1Z", keep: true },
    { iso: "2026-09-01T00:00:00.12Z", keep: true },
    { iso: "2026-09-01T23:59:59.999Z", keep: true },
    { iso: "2026-09-01T00:00Z", keep: true },
    { iso: "2026-09-01T00:00:00.1234Z", keep: false }, // 소수 4자리 이상
    { iso: "2026-09-01T15:00:00.123456Z", keep: false },
    { iso: "2026-09-01T00:00:00.123456789Z", keep: false },
    { iso: "2026-09-01T24:00:00Z", keep: false }, // 24:00
    { iso: "2026-09-01T24:00Z", keep: false },
  ];
  const got = boundary.map((b) => normalizeWorkoutCycle({ ...raw, createdAt: b.iso, events: [] }).createdAt);
  const wrong = boundary.filter((b, i) => got[i] !== (b.keep ? b.iso : EPOCH) || isZonedIsoTimestamp(b.iso) !== b.keep);
  add(
    "정규화",
    "createdAt ISO 경계 = lib/kst isZonedIsoTimestamp(소수 1~3자리 유지, 4자리+·24:00은 epoch — 표시와 같은 경계)",
    wrong.length === 0,
    wrong.length === 0 ? `${boundary.length}건 일치` : `불일치: ${S(wrong.map((b) => b.iso))}`,
  );
});

// ===========================================================================
// 8) 깨진 날짜·오늘 방어 (§19-2 "workout은 gap ≥ 1에서만" — 날짜 차를 모르면 기록을 받지 않는다)
// ===========================================================================
scenario("날짜 방어", "정규화 안 된 사건열", () => {
  // 엔진도 정규화와 같은 규칙으로 깨진 사건을 없는 것으로 본다 — 스토어를 거치지 않은 호출자(eval·장래 코드)도 같은 답.
  // Day 1을 D0에 완료한 뒤 날짜가 빈 사건이 끝에 붙은 경우: 예전엔 ""가 1900-01-01로 해석돼 D0에 두 번째 기록을 받았다.
  const c1 = log(newCycle(), D0, "complete");
  const brokenLast = { ...targetFor(BASE, 2) };
  const raw: WorkoutCycleRecord = {
    ...c1,
    events: [...c1.events, { date: "", at: "", kind: "complete", day: 2, targetDay: 2, failed: null, reps: brokenLast, durationSec: null }],
  };
  const norm = captureWarn(() => normalizeWorkoutCycle(raw)).value;
  const st = todayStatus(raw, D0);
  const second = decideLog(raw, { expectedRev: raw.rev, kind: "complete", day: 3, targetDay: 3, failed: null, durationSec: null, todayKst: D0, nowIso: nowIsoFor(D0) });
  const second2 = decideLog(raw, { expectedRev: raw.rev, kind: "complete", day: 2, targetDay: 2, failed: null, durationSec: null, todayKst: D0, nowIso: nowIsoFor(D0) });
  const next = decideLog(raw, { expectedRev: raw.rev, kind: "complete", day: 2, targetDay: 2, failed: null, durationSec: null, todayKst: dt(1), nowIso: nowIsoFor(dt(1)) });
  add(
    "날짜 방어",
    "날짜가 깨진 마지막 사건은 '오늘 기록'도 '아주 오래전'도 아니다 — 없는 것으로(정규화와 같은 답)·같은 날 두 번째 기록 거절",
    desc(st) === "recorded(complete,1,1)" &&
      eq(st, todayStatus(norm, D0)) &&
      eq(snapshot(raw, dt(1)).today, snapshot(norm, dt(1)).today) &&
      eq(replay(raw.events).completedDays, [1]) &&
      second.status === "stale_state" &&
      second2.status === "stale_state" &&
      next.status === "ok" &&
      next.event.day === 2,
    `${desc(st)} · D0 (3,3)→${second.status} (2,2)→${second2.status} · D+1 (2,2)→${next.status}`,
  );

  // 운동일이 아닌 day 사건(QA 재현)을 정규화 없이 넘겨도 snapshot이 던지지 않는다
  const qa: WorkoutCycleRecord = {
    ...newCycle(),
    events: [
      { date: dt(0), at: "", kind: "complete", day: 6, targetDay: 6, failed: null, reps: brokenLast, durationSec: null },
      { date: dt(1), at: "", kind: "fail", day: 7, targetDay: 7, failed: FAIL_PU0, reps: brokenLast, durationSec: null },
    ],
  };
  let threw = "";
  let qs: ReturnType<typeof snapshot> | null = null;
  try {
    qs = snapshot(qa, dt(3));
  } catch (err) {
    threw = (err as Error).message;
  }
  const qn = captureWarn(() => normalizeWorkoutCycle(qa)).value;
  add(
    "날짜 방어",
    "운동일 아닌 day 사건을 정규화 없이 넘겨도 snapshot이 던지지 않는다(정규화와 같은 오늘 상태)",
    threw === "" && qs !== null && isPlainData(qs) && eq(qs.today, todayStatus(qn, dt(3))),
    threw ? `예외: ${threw}` : `today=${qs ? desc(qs.today) : "-"}`,
  );
});
scenario("날짜 방어", "오늘이 형식 밖", () => {
  // 서버는 kstTodayString()만 넘기지만, 형식 밖 오늘은 판정에선 RangeError(프로그래밍 오류), 읽기에선 던지지 않고
  // "달력이 흐르지 않은 것"(마지막 사건일, 없으면 시작일에 멈춤)으로 본다 → 기록함/Day 1. 휴식 슬롯을 지난 것으로 치지 않는다.
  const { c, date: d5 } = completeThrough(newCycle(), D0, 5);
  const badToday = ["garbage", "2026-02-30", ""];
  const reads = badToday.map((b) => todayStatus(c, b));
  const snaps = badToday.map((b) => snapshot(c, b));
  const frozen = snapshot(c, d5);
  add(
    "날짜 방어",
    "형식 밖 오늘 → 읽기는 마지막 사건일에 멈춤(기록함·내일 = rest 6)·snapshot·upcoming 날짜 유효",
    reads.every((s) => s.kind === "recorded_today" && s.day === 5 && desc(s.tomorrow) === "rest(6,1/1)") &&
      snaps.every((s) => isPlainData(s) && eq(s.today, frozen.today) && eq(s.upcoming, frozen.upcoming)) &&
      snaps.every((s) => s.upcoming.length === 3 && s.upcoming.every((u) => diffDateStrings(u.date, u.date) === 0)),
    `${reads.map(desc).join(" / ")} · up=${snaps[0].upcoming.map((u) => `${u.date}:${desc(u.item)}`).join(" ")}`,
  );
  const pre = todayStatus(newCycle({ startDate: dt(2) }), "garbage");
  const upBad = upcoming(newCycle({ startDate: "garbage" }), "garbage", 3);
  add(
    "날짜 방어",
    "형식 밖 오늘·사건 없음 → 시작일에 멈춤(Day 1)·시작일도 깨졌으면 upcoming []",
    desc(pre) === "workout(1,1)" && upBad.length === 0 && isPlainData(snapshot(newCycle({ startDate: "garbage" }), "garbage")),
    `${desc(pre)} · up=${upBad.length}`,
  );
  const req = { expectedRev: c.rev, kind: "complete" as const, day: 7, targetDay: 7, failed: null, durationSec: null, nowIso: nowIsoFor(D0) };
  add(
    "날짜 방어",
    "판정 함수는 달력 밖 날짜(2026-02-30·평년 2월 29)를 RangeError로 거절",
    throws(() => decideLog(c, { ...req, todayKst: "2026-02-30" })) &&
      throws(() => decideStart([], { rm: RM, startDate: "2026-02-29", expectedActiveCycleId: null, todayKst: "2026-02-28", nowIso: nowIsoFor(D0) }, "x")) &&
      throws(() => decideStart([], { rm: RM, startDate: "2026-03-01", expectedActiveCycleId: null, todayKst: "2026-02-29", nowIso: nowIsoFor(D0) }, "x")),
    "decideLog 02-30 · decideStart 02-29",
  );
});

// ===========================================================================
// 9) 상단 스트릭 — 루틴을 지킨 날 (§17-7 workoutKeptDays · workoutStreakTodayLabel)
//   센다: 사건일(complete·fail) · 엔진이 정한 휴식·회복·마무리 휴식 슬롯(오늘까지만) · 재측정 끝낸 날(completed의 endedAt KST)
//   안 센다: 기록 없이 지난 운동일 · RM 안 넣고 지난 재측정일 · 시작 전·사이클 없던 날 · 오늘 뒤 슬롯
// ===========================================================================
const keptDays = workoutKeptDays;
const todayLabel = workoutStreakTodayLabel;
/** dt(a)..dt(b) 날짜 목록(양끝 포함) */
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => dt(a + i));
const streakAt = (cycles: readonly WorkoutCycleRecord[], today: string) => computeStreakFromDays(workoutKeptDays(cycles, today), today);
const ZERO_REPS = (): SetPair => ({ pullup: [0, 0, 0, 0, 0], pushup: [0, 0, 0, 0, 0] });

/** 손으로 만든 사건 — 엔진 판정을 거치지 않는다(불변식 밖 사건열·깨진 사건 시나리오 전용) */
function rawEvent(date: string, kind: "complete" | "fail", day: number, targetDay = day): WorkoutEvent {
  return { date, at: nowIsoFor(date), kind, day, targetDay, failed: kind === "fail" ? FAIL_PU0 : null, reps: ZERO_REPS(), durationSec: null };
}

/** 사이클 새로 시작 — 서버 흐름 그대로(decideStart → writes를 id로 upsert). 거절되면 던진다(시나리오 구성용) */
function restart(all: readonly WorkoutCycleRecord[], today: string, start: "today" | "tomorrow", newId: string): WorkoutCycleRecord[] {
  const r = decideStart(
    all,
    {
      rm: RM,
      startDate: start === "today" ? today : shiftDateString(today, 1),
      expectedActiveCycleId: pickActiveWorkoutCycle(all)?.id ?? null,
      todayKst: today,
      nowIso: nowIsoFor(today),
    },
    newId,
  );
  if (r.status !== "ok") throw new Error(`시나리오 오류: ${today} decideStart → ${r.status}`);
  return applyWrites(all, r.writes);
}

/** 활성 사이클에 기록(log와 같은 서버 흐름) — 배열 안 그 사이클만 갈아끼운다 */
function logActive(all: readonly WorkoutCycleRecord[], date: string, kind: "complete" | "fail"): WorkoutCycleRecord[] {
  const active = pickActiveWorkoutCycle(all);
  if (!active) throw new Error(`시나리오 오류: ${date} 활성 사이클 없음`);
  const next = log(active, date, kind);
  return all.map((c) => (c.id === next.id ? next : c));
}

/** §17-7 라벨 규칙을 오늘 상태(TodayStatus)에서 독립적으로 유도 — 엔진 라벨과 대조하는 기대값(오늘 안 했으면 null) */
function labelFromStatus(st: TodayStatus): string | null {
  switch (st.kind) {
    case "recorded_today":
      return st.outcome === "fail" ? `Day ${st.day} ✗` : st.outcome === "repeat_complete" ? `Day ${st.targetDay} 목표 ✓` : `Day ${st.day} ✓`;
    case "rest":
      return st.cycleEnd ? `마무리 휴식 ${st.index}/${st.of}` : "휴식";
    case "recovery":
      return "회복 휴식";
    default:
      return null;
  }
}

scenario("운동 스트릭", "운동일 + Day 6 휴식이 이어진다", () => {
  const { c, date } = completeThrough(newCycle(), D0, 7); // Day 1~5 = dt0~dt4, Day 6 휴식 = dt5, Day 7 = dt6
  const k = keptDays([c], date);
  const s = streakAt([c], date);
  add(
    "운동 스트릭",
    "Day 1~5·Day 6 휴식·Day 7 → 7일 연속(휴식일이 끊지 않는다)·doneToday·라벨 'Day 7 ✓'",
    date === dt(6) && eq(k, range(0, 6)) && s.current === 7 && s.doneToday && s.best === 7 && todayLabel([c], date) === "Day 7 ✓",
    `date=${date} kept=${k.length}일 ${S(s)} 라벨=${todayLabel([c], date)}`,
  );
});

scenario("운동 스트릭", "실패일·회복 휴식·재부여 성공", () => {
  let c = completeThrough(newCycle(), D0, 5).c; // Day 5 = dt4, Day 6 휴식 = dt5
  c = log(c, dt(6), "fail"); // Day 7 실패
  const lFail = todayLabel([c], dt(6));
  const lRecovery = todayLabel([c], dt(7));
  const sRecovery = streakAt([c], dt(7));
  c = log(c, dt(8), "complete"); // 재부여 (7, 5) 성공
  const lRepeat = todayLabel([c], dt(8));
  const k = keptDays([c], dt(8));
  const s9 = streakAt([c], dt(9)); // Day 7 재도전일 — 아직 안 함
  add(
    "운동 스트릭",
    "실패일·회복 휴식도 지킨 날 — 라벨 'Day 7 ✗' → '회복 휴식'(doneToday) → 'Day 5 목표 ✓', 9일 연속",
    lFail === "Day 7 ✗" &&
      lRecovery === "회복 휴식" &&
      sRecovery.doneToday &&
      lRepeat === "Day 5 목표 ✓" &&
      eq(k, range(0, 8)) &&
      s9.current === 9 &&
      !s9.doneToday &&
      todayLabel([c], dt(9)) === null,
    `${lFail} → ${lRecovery} → ${lRepeat} · kept=${k.length}일 · 다음날=${S(s9)}`,
  );
});

scenario("운동 스트릭", "운동일 건너뜀", () => {
  let c = log(newCycle(), dt(0), "complete"); // Day 1
  const kMid = keptDays([c], dt(1));
  const sMid = streakAt([c], dt(1));
  const lMid = todayLabel([c], dt(1));
  c = log(c, dt(2), "complete"); // Day 2 — dt1은 기록 없이 지나간 운동일
  const k = keptDays([c], dt(2));
  const s = streakAt([c], dt(2));
  add(
    "운동 스트릭",
    "운동일에 기록 없이 지나면 끊긴다 — 그날은 '오늘 아직'(어제까지 살아 있음, 라벨 null), 다음 기록은 1일부터",
    eq(kMid, [dt(0)]) && sMid.current === 1 && !sMid.doneToday && lMid === null && eq(k, [dt(0), dt(2)]) && s.current === 1 && s.best === 1,
    `당일=${S(sMid)} 라벨=${lMid} · 다음=${S(k)} ${S(s)}`,
  );
});

scenario("운동 스트릭", "마무리 휴식·미래 휴식", () => {
  const { c, date } = completeThrough(newCycle(), D0, 23); // Day 23 = dt22, 마무리 휴식 dt23~dt25
  const k22 = keptDays([c], dt(22));
  const k23 = keptDays([c], dt(23));
  const labels = [22, 23, 24, 25].map((i) => todayLabel([c], dt(i)));
  add(
    "운동 스트릭",
    "Day 23 당일엔 뒤 휴식(오늘 뒤)을 세지 않고, 마무리 휴식은 하루씩 — 라벨 'Day 23 ✓'·'마무리 휴식 1/3·2/3·3/3'",
    date === dt(22) &&
      eq(k22, range(0, 22)) &&
      eq(k23, range(0, 23)) &&
      eq(labels, ["Day 23 ✓", "마무리 휴식 1/3", "마무리 휴식 2/3", "마무리 휴식 3/3"]),
    `당일 끝=${k22[k22.length - 1]} 다음날 끝=${k23[k23.length - 1]} · ${labels.join(" / ")}`,
  );
});

scenario("운동 스트릭", "재측정 대기·끝낸 날", () => {
  const { c } = completeThrough(newCycle(), D0, 23); // 재측정일(Day 27) = dt26
  const waiting = keptDays([c], dt(27)); // dt26에 RM을 안 넣고 지나감
  const lWaiting = todayLabel([c], dt(27));
  let all = restart([c], dt(27), "tomorrow", "c2"); // dt27에 재측정 끝냄 → c1 completed, 새 사이클은 내일부터
  const closed = all.find((x) => x.id === "c1");
  const after = keptDays(all, dt(27));
  const lRetest = todayLabel(all, dt(27));
  all = logActive(all, dt(28), "complete"); // 새 사이클 Day 1
  const s = streakAt(all, dt(28));
  add(
    "운동 스트릭",
    "RM 안 넣고 지난 재측정일(dt26)은 빠지고, 재측정 끝낸 날(dt27)은 센다 — 라벨 '재측정 ✓' → 새 사이클 'Day 1 ✓'",
    eq(waiting, range(0, 25)) &&
      lWaiting === null &&
      closed?.status === "completed" &&
      eq(after, [...range(0, 25), dt(27)]) &&
      lRetest === "재측정 ✓" &&
      s.current === 2 &&
      s.best === 26 &&
      todayLabel(all, dt(28)) === "Day 1 ✓",
    `대기 끝=${waiting[waiting.length - 1]} 라벨=${lWaiting} · 닫힘=${closed?.status} · ${lRetest} · ${S(s)}`,
  );
});

scenario("운동 스트릭", "두 사이클 합집합", () => {
  const { c } = completeThrough(newCycle(), D0, 23);
  let all = restart([c], dt(26), "today", "c2"); // 재측정일에 재측정, 오늘 시작
  all = logActive(all, dt(26), "complete"); // 같은 날 새 사이클 Day 1
  const k = keptDays(all, dt(26));
  const lToday = todayLabel(all, dt(26));
  all = logActive(all, dt(27), "complete"); // 새 사이클 Day 2
  const s = streakAt(all, dt(27));
  add(
    "운동 스트릭",
    "지난 사이클 + 새 사이클 날을 합집합으로 — 끊김 없이 28일, 같은 날 재측정·Day 1이면 활성 사이클 라벨 'Day 1 ✓'",
    eq(k, range(0, 26)) && lToday === "Day 1 ✓" && s.current === 28 && s.best === 28,
    `kept=${k.length}일 라벨=${lToday} ${S(s)}`,
  );
});

scenario("운동 스트릭", "중단 사이클", () => {
  const { c } = completeThrough(newCycle(), D0, 5); // Day 5 = dt4, Day 6 휴식 슬롯 = dt5
  let all = restart([c], dt(4), "tomorrow", "c2"); // Day 5 한 날 도중 재측정 → c1 abandoned(endedAt dt4)
  const closed = all.find((x) => x.id === "c1");
  const lClosed = todayLabel(all, dt(4));
  const kBefore = keptDays(all, dt(5));
  const lBefore = todayLabel(all, dt(5));
  all = logActive(all, dt(5), "complete"); // 새 사이클 Day 1
  const kAfter = keptDays(all, dt(5));
  add(
    "운동 스트릭",
    "중단 사이클의 사건도 센다 · 휴식 슬롯은 닫힌 날(dt4)에서 자른다 · 오늘 사건이 닫힌 사이클에만 있으면 그 라벨('Day 5 ✓')",
    closed?.status === "abandoned" &&
      lClosed === "Day 5 ✓" &&
      eq(kBefore, range(0, 4)) &&
      lBefore === null &&
      eq(kAfter, range(0, 5)),
    `닫힘=${closed?.status} 라벨=${lClosed} · 새 Day 1 전=${kBefore.length}일(${lBefore}) 후=${kAfter.length}일`,
  );
});

scenario("운동 스트릭", "도중 재측정한 날", () => {
  // retestHint를 따라 운동일에 기록 없이 RM을 다시 잰 날 — "건너뛴 날"로 끊기면 앱 안내를 따른 벌이 된다(§17-7).
  const { c } = completeThrough(newCycle(), D0, 5); // Day 5 = dt4, Day 6 휴식 = dt5, Day 7 운동일 = dt6
  let all = restart([c], dt(6), "tomorrow", "c2"); // dt6: 기록 없이 도중 재측정 → c1 abandoned(사건 있음)
  const closed = all.find((x) => x.id === "c1");
  const k6 = keptDays(all, dt(6));
  const l6 = todayLabel(all, dt(6));
  all = logActive(all, dt(7), "complete"); // 새 사이클 Day 1
  const s7 = streakAt(all, dt(7));
  // 사건 0개로 닫힌 사이클(레거시 다중 활성 정리)의 닫힌 날은 루틴 밖 — 세지 않는다
  const legacy = newCycle({ id: "L0", status: "abandoned", endedAt: nowIsoFor(dt(3)) });
  const kLegacy = keptDays([legacy], dt(3));
  add(
    "운동 스트릭",
    "사건 있는 사이클을 도중 재측정으로 닫은 날(abandoned)도 '재측정 ✓'로 센다 — 끊김 없이 8일 / 사건 0개 사이클이 닫힌 날은 안 센다",
    closed?.status === "abandoned" &&
      eq(k6, range(0, 6)) &&
      l6 === "재측정 ✓" &&
      s7.current === 8 &&
      s7.doneToday &&
      eq(kLegacy, []) &&
      todayLabel([legacy], dt(3)) === null,
    `닫힘=${closed?.status} dt6=${l6} · 새 Day 1 뒤 ${S(s7)} · 레거시=${S(kLegacy)}`,
  );
  // 닫힌 날(endedAt) 판정도 lib/kst isZonedIsoTimestamp 한 곳 — createdAt·"만든 날짜" 표시와 같은 경계.
  // 소수 3자리(toISOString)는 닫힌 날로 읽고, 소수 4자리+·24:00은 ISO가 아니라 닫힌 날이 없다(재측정 ✓ 없음).
  if (closed) {
    const at = (endedAt: string) => keptDays([{ ...closed, endedAt }], dt(6)).includes(dt(6));
    const ms = at(`${dt(6)}T03:00:00.123Z`);
    const micro = at(`${dt(6)}T03:00:00.123456Z`);
    const h24 = at(`${dt(5)}T24:00:00Z`);
    add(
      "운동 스트릭",
      "endedAt ISO 경계 = lib/kst isZonedIsoTimestamp — .123Z는 닫힌 날(재측정 ✓), .123456Z·24:00은 닫힌 날 없음",
      ms && !micro && !h24,
      `.123Z=${ms} .123456Z=${micro} 24:00=${h24}`,
    );
  }
});

scenario("운동 스트릭", "다음 사건 전날에서 자름", () => {
  // 불변식 밖 사건열(손으로 고친 문서·사고) — Day 23 완료 다음 날 사건이 또 있다.
  // Day 23의 마무리 휴식 슬롯(dt23~25)은 다음 사건 전날(dt22)에서 잘린다 → dt23은 사건, dt24는 그 실패의 회복, dt25는 세지 않는다.
  const { c } = completeThrough(newCycle(), D0, 23);
  const broken: WorkoutCycleRecord = { ...c, events: [...c.events, rawEvent(dt(23), "fail", 23)] };
  const k = keptDays([broken], dt(26));
  add("운동 스트릭", "슬롯은 다음 사건 전날에서 자른다(앞 사건의 휴식이 뒤 사건을 넘어 새지 않는다)", eq(k, range(0, 24)), `끝=${k[k.length - 1]} (${k.length}일)`);
});

scenario("운동 스트릭", "시작 전·사이클 없음", () => {
  const pre = keptDays([newCycle({ startDate: dt(3) })], dt(5)); // 시작일 지났지만 기록 없음
  const preNotYet = keptDays([newCycle({ startDate: dt(3) })], dt(1)); // 시작 전
  const none = keptDays([], dt(5));
  const late = log(newCycle(), dt(2), "complete"); // 시작일 dt0, 첫 운동은 dt2
  const kLate = keptDays([late], dt(2));
  add(
    "운동 스트릭",
    "시작 전·기록 없는 사이클·사이클 없음 → [] / 첫 사건 전 날(dt0·dt1)은 세지 않는다",
    eq(pre, []) && eq(preNotYet, []) && eq(none, []) && todayLabel([], dt(5)) === null && todayLabel([newCycle({ startDate: dt(3) })], dt(1)) === null && eq(kLate, [dt(2)]),
    `시작전=${S(preNotYet)} 기록없음=${S(pre)} 없음=${S(none)} 늦은시작=${S(kLate)}`,
  );
});

scenario("운동 스트릭", "오늘 휴식이면 doneToday", () => {
  const { c } = completeThrough(newCycle(), D0, 5); // dt5 = Day 6 휴식
  const s = streakAt([c], dt(5));
  add(
    "운동 스트릭",
    "오늘이 휴식 슬롯이면 doneToday=true('오늘 아직'으로 흐리게 두지 않는다)·current 6·라벨 '휴식'",
    s.doneToday && s.current === 6 && todayLabel([c], dt(5)) === "휴식",
    `${S(s)} 라벨=${todayLabel([c], dt(5))}`,
  );
});

scenario("운동 스트릭", "깨진 사건·형식 밖 오늘·오늘 뒤 사건", () => {
  const c1 = log(newCycle(), dt(0), "complete");
  const withBroken: WorkoutCycleRecord = { ...c1, events: [...c1.events, rawEvent(dt(1), "complete", 6), rawEvent("2026-02-30", "complete", 2)] };
  const kBroken = keptDays([withBroken], dt(1));
  const kGarbage = keptDays([c1], "garbage");
  const lGarbage = todayLabel([c1], "garbage");
  const future: WorkoutCycleRecord = { ...c1, events: [...c1.events, rawEvent(dt(3), "complete", 2)] };
  const kFuture = keptDays([future], dt(2));
  add(
    "운동 스트릭",
    "깨진 사건(Day 6·2월 30일)은 없는 것으로 · 형식 밖 오늘 → [] / null(던지지 않음) · 오늘 뒤 사건(시계 어긋남)은 세지 않는다",
    eq(kBroken, [dt(0)]) && todayLabel([withBroken], dt(1)) === null && eq(kGarbage, []) && lGarbage === null && eq(kFuture, [dt(0)]),
    `깨짐=${S(kBroken)} 형식밖=${S(kGarbage)}/${lGarbage} 미래=${S(kFuture)}`,
  );
});

scenario("운동 스트릭", "상태 기계와 일치", () => {
  // 70일 시뮬레이션 — 운동일마다 패턴대로 성공·실패·건너뜀(마무리 휴식·재측정 대기까지 간다).
  // 그날그날: "지킨 날" ⇔ 오늘 상태가 기록함·휴식·회복, 라벨 = 오늘 상태에서 유도한 §17-7 라벨.
  // 끝에서 과거를 다시 접어도(다음 사건들이 붙은 뒤) 그날그날 판정과 같은 날짜 집합이어야 한다.
  const pattern = ["complete", "complete", "skip", "complete", "fail", "complete", "complete", "complete", "skip"] as const;
  let c = newCycle();
  let p = 0;
  const daily: string[] = [];
  const bad: string[] = [];
  const kinds = new Set<string>();
  for (let i = 0; i < 70; i++) {
    const d = dt(i);
    if (todayStatus(c, d).kind === "workout") {
      const act = pattern[p++ % pattern.length];
      if (act !== "skip") c = log(c, d, act);
    }
    const st = todayStatus(c, d);
    kinds.add(st.kind === "rest" && st.cycleEnd ? "cycle_rest" : st.kind);
    const isKept = keptDays([c], d).includes(d);
    const expectKept = st.kind === "recorded_today" || st.kind === "rest" || st.kind === "recovery";
    const label = todayLabel([c], d);
    if (isKept !== expectKept || label !== labelFromStatus(st)) bad.push(`${d}:${desc(st)}:${isKept}:${label}`);
    if (isKept) daily.push(d);
  }
  const final = keptDays([c], dt(69));
  add(
    "운동 스트릭",
    "70일 시뮬레이션 — 그날그날 지킨 날·라벨 = 상태 기계, 나중에 다시 접어도 같은 집합(정렬·중복 없음·직렬화 가능)",
    bad.length === 0 && eq(final, daily) && eq(final, [...new Set(final)].sort()) && isPlainData(final) && kinds.has("cycle_rest") && kinds.has("retest") && kinds.has("recovery"),
    bad.length === 0 ? `${daily.length}일 지킴 · 상태 ${[...kinds].join(",")}` : `불일치 ${bad.slice(0, 4).join(" ")}`,
  );
});

// ===========================================================================
// 10) 총 운동 소요시간 (§19-8) — 실측(세션이 잰 durationSec, 클라이언트 보고값) + 근사(reps·휴식 규칙, 읽을 때 계산)
// ===========================================================================
scenario("소요시간", "상수", () => {
  add(
    "소요시간",
    "상한 3시간 = 10800초 · 기본 휴식 120초 · 계수 풀업 3·푸시업 2·스텝 10초",
    WORKOUT_DURATION_MAX_SEC === 10800 &&
      DEFAULT_REST_SEC === 120 &&
      DURATION_ESTIMATE_SEC.pullupRep === 3 &&
      DURATION_ESTIMATE_SEC.pushupRep === 2 &&
      DURATION_ESTIMATE_SEC.step === 10,
    S({ WORKOUT_DURATION_MAX_SEC, DEFAULT_REST_SEC, DURATION_ESTIMATE_SEC }),
  );
  const valid = [0, 1, 852, 10800].every(isValidDurationSec);
  const invalid = [-1, 10801, 12.5, Number.NaN, Number.POSITIVE_INFINITY, "852", null, undefined].every((v) => !isValidDurationSec(v));
  add("소요시간", "isValidDurationSec — 정수 0..10800만(음수·초과·소수·NaN·문자열·null·undefined 거부)", valid && invalid, `${valid}/${invalid}`);
});
scenario("소요시간", "옛 사건 정규화", () => {
  // 이 기능 전에 저장된 사건엔 필드가 없다 — 정규화가 null로 채워야 Firestore(undefined 거부)·snapshot이 안전하다.
  const old = normalizeWorkoutEvent({ date: D0, at: nowIsoFor(D0), kind: "complete", day: 1, targetDay: 1, failed: null, reps: targetFor(BASE, 1) });
  const vals = [852, 0, 10800, 10801, -3, 12.9, "852", null].map(
    (v) => normalizeWorkoutEvent({ date: D0, at: nowIsoFor(D0), kind: "complete", day: 1, targetDay: 1, failed: null, reps: targetFor(BASE, 1), durationSec: v }).durationSec,
  );
  const cyc = normalizeWorkoutCycle({
    ...newCycle(),
    events: [
      { date: D0, at: nowIsoFor(D0), kind: "complete", day: 1, targetDay: 1, failed: null, reps: targetFor(BASE, 1) },
      { date: dt(1), at: nowIsoFor(dt(1)), kind: "complete", day: 2, targetDay: 2, failed: null, reps: targetFor(BASE, 2), durationSec: 700 },
    ],
  });
  add(
    "소요시간",
    "옛 사건(필드 없음) → durationSec null·직렬화 가능 / 유효값은 보존 / 범위 밖·소수·문자열 → null",
    old.durationSec === null &&
      isPlainData(old) &&
      eq(vals, [852, 0, 10800, null, null, null, null, null]) &&
      cyc.events[0].durationSec === null &&
      cyc.events[1].durationSec === 700 &&
      isPlainData(cyc),
    `old=${S(old.durationSec)} vals=${S(vals)} cyc=${S(cyc.events.map((e) => e.durationSec))}`,
  );
});
scenario("소요시간", "decideLog가 싣는다", () => {
  const c = newCycle({ rev: 2 });
  const req = { expectedRev: 2, kind: "complete" as const, day: 1, targetDay: 1, failed: null, todayKst: D0, nowIso: nowIsoFor(D0) };
  const at = (durationSec: number | null) => {
    const r = decideLog(c, { ...req, durationSec });
    return r.status === "ok" ? r.event.durationSec : `거절:${r.status}`;
  };
  const r852 = decideLog(c, { ...req, durationSec: 852 });
  const r852b = decideLog(c, { ...req, durationSec: 852 });
  // ⚠️ 두 스토어는 쓰기 직전에 normalizeWorkoutCycle을 태운다 — 정규화가 새 필드를 모르면 여기서 값이 지워진다(§19-8 함정)
  const written = r852.status === "ok" ? normalizeWorkoutCycle(r852.next) : null;
  add(
    "소요시간",
    "decideLog — 사건에 durationSec 그대로(852)·결정적·쓰기 경계 정규화 뒤에도 보존",
    r852.status === "ok" &&
      r852.event.durationSec === 852 &&
      r852.next.events[r852.next.events.length - 1].durationSec === 852 &&
      S(r852) === S(r852b) &&
      written !== null &&
      written.events[written.events.length - 1].durationSec === 852 &&
      isPlainData(written),
    r852.status === "ok" ? S({ event: r852.event.durationSec, written: written?.events.at(-1)?.durationSec }) : r852.status,
  );
  const edge = [0, 10800, 10801, -1, 12.5, Number.NaN, null].map(at);
  add(
    "소요시간",
    "범위 밖(10801·음수·소수·NaN)은 기록은 받고(ok) 소요시간만 null · 0·10800은 그대로",
    eq(edge, [0, 10800, null, null, null, null, null]),
    S(edge),
  );
  const failR = decideLog(c, { ...req, kind: "fail", failed: { exercise: "pushup", setIndex: 2, reps: 4 }, durationSec: 431 });
  add(
    "소요시간",
    "실패 기록도 durationSec을 싣는다(세션의 실패 기록 경로)",
    failR.status === "ok" && failR.event.durationSec === 431 && failR.event.kind === "fail",
    failR.status === "ok" ? S(failR.event.durationSec) : failR.status,
  );
  // 거절 분기(stale·conflict)는 소요시간과 무관하게 그대로 — 값이 있어도 같은 날 두 번째 기록은 거절
  const c1 = log(newCycle(), D0, "complete", FAIL_PU0, 600);
  const twice = decideLog(c1, { ...req, expectedRev: c1.rev, day: 2, targetDay: 2, durationSec: 600 });
  add("소요시간", "소요시간이 있어도 거절 규칙 불변(같은 날 두 번째 → stale_state)", twice.status === "stale_state", twice.status);
});
scenario("소요시간", "근사식 결정성", () => {
  const ev = (day: number, kind: "complete" | "fail", failed: FailedAt | null): WorkoutEvent => ({
    date: D0,
    at: nowIsoFor(D0),
    kind,
    day,
    targetDay: day,
    failed,
    reps: repsForEvent(targetFor(BASE, day), kind, failed),
    durationSec: null,
  });
  // 스펙 예(10/18RM): Day 1 완주 = 20×3 + 35×2 + 10×10 + 4×120 = 710초, Day 23 = 39×3 + 54×2 + 100 + 480 = 805초
  const d1 = estimateEventSec(ev(1, "complete", null));
  const d23 = estimateEventSec(ev(23, "complete", null));
  add("소요시간", "완주 근사 — Day 1 710초(≈12분)·Day 23 805초(≈13분)", d1 === 710 && d23 === 805, `${d1}, ${d23}`);

  // 스텝 k(0..9)에서 실패(그 세트 0회): 수행 스텝 k+1, 쉰 휴식 = k 앞의 restFollowsStep 수 → [0,0,1,1,2,2,3,3,4,4]
  const RESTS = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
  const bad: string[] = [];
  for (let k = 0; k < 10; k++) {
    const failed: FailedAt = { exercise: k % 2 === 0 ? "pullup" : "pushup", setIndex: Math.floor(k / 2), reps: null };
    const e = ev(1, "fail", failed);
    const oracle = sum(e.reps.pullup) * 3 + sum(e.reps.pushup) * 2 + (k + 1) * 10 + RESTS[k] * 120;
    const got = estimateEventSec(e);
    if (got !== oracle) bad.push(`k${k}:${got}≠${oracle}`);
  }
  add("소요시간", "스텝별 실패 근사 — 수행 스텝 k+1·쉰 휴식 [0,0,1,1,2,2,3,3,4,4](실패 스텝 앞의 휴식만)", bad.length === 0, bad.join(" ") || "10스텝 일치");

  const p5 = estimateEventSec(ev(1, "fail", { exercise: "pushup", setIndex: 2, reps: 4 }));
  add("소요시간", "푸시업 3세트(스텝 5)에서 4회 실패 = 15×3 + 21×2 + 6×10 + 2×120 = 387초", p5 === 387, String(p5));

  const base = ev(5, "complete", null);
  const same = [
    estimateEventSec(base),
    estimateEventSec({ ...base }),
    estimateEventSec({ ...base, durationSec: 999 } as WorkoutEvent),
    estimateEventSec({ ...base, at: "2030-01-01T00:00:00.000Z" } as WorkoutEvent),
  ];
  add("소요시간", "근사는 결정적 — at·durationSec을 보지 않는다(같은 reps·실패 지점 → 같은 값)", same.every((x) => x === same[0]), S(same));

  // 실패 지점이 없는 fail(손상 — 정규화가 exercise를 못 읽은 경우)도 던지지 않고 결정적인 값(읽기 함수는 던지지 않는다)
  const damaged = normalizeWorkoutEvent({ date: D0, at: "", kind: "fail", day: 1, targetDay: 1, failed: { exercise: "?" }, reps: { pullup: [6, 5, 0, 0, 0], pushup: [9, 0, 0, 0, 0] } });
  const dm = [estimateEventSec(damaged), estimateEventSec(damaged)];
  add(
    "소요시간",
    "실패 지점 없는 fail(손상) — 던지지 않고 결정적(reps 있는 앞 스텝 수로 대체: 스텝 3에서 멈춤)",
    damaged.failed === null && dm[0] === dm[1] && dm[0] === 11 * 3 + 9 * 2 + 4 * 10 + 1 * 120,
    S(dm),
  );

  const m = eventDuration({ ...base, durationSec: 852 });
  const n = eventDuration(base);
  const over = eventDuration({ ...base, durationSec: 20000 });
  add(
    "소요시간",
    "eventDuration — 유효한 durationSec이면 실측, null·범위 밖이면 근사",
    eq(m, { sec: 852, source: "measured" }) && eq(n, { sec: estimateEventSec(base), source: "estimated" }) && over.source === "estimated",
    S([m, n, over]),
  );
});
scenario("소요시간", "스냅샷·지난 사이클·합계", () => {
  // Day 1(실측 600) → Day 2(실측 900) → Day 3(세션 없이 — 근사 720 = 22×3 + 37×2 + 100 + 480)
  let c = log(newCycle(), D0, "complete", FAIL_PU0, 600);
  c = log(c, dt(1), "complete", FAIL_PU0, 900);
  c = log(c, dt(2), "complete");
  const snap = snapshot(c, dt(2));
  const est3 = estimateEventSec(c.events[2]);
  add(
    "소요시간",
    "snapshot.duration = 실측 2 + 근사 1(합 2220)·lastEventDuration = 오늘 기록(근사 720)·직렬화 가능",
    est3 === 720 &&
      eq(snap.duration, { totalSec: 2220, measuredCount: 2, estimatedCount: 1 }) &&
      eq(snap.lastEventDuration, { sec: 720, source: "estimated" }) &&
      isPlainData(snap),
    S({ duration: snap.duration, last: snap.lastEventDuration }),
  );
  const undone = decideUndo(c, { expectedRev: c.rev });
  const snapU = undone.status === "ok" ? snapshot(undone.next, dt(2)) : null;
  add(
    "소요시간",
    "취소(undo)하면 소요시간도 사건과 함께 사라진다(합 1500·실측만·last = Day 2 실측 900)",
    snapU !== null &&
      eq(snapU.duration, { totalSec: 1500, measuredCount: 2, estimatedCount: 0 }) &&
      eq(snapU.lastEventDuration, { sec: 900, source: "measured" }),
    snapU ? S({ duration: snapU.duration, last: snapU.lastEventDuration }) : undone.status,
  );
  const empty = snapshot(newCycle(), D0);
  add(
    "소요시간",
    "사건 없음 → 합계 0/0/0·lastEventDuration null",
    eq(empty.duration, { totalSec: 0, measuredCount: 0, estimatedCount: 0 }) && empty.lastEventDuration === null,
    S(empty.duration),
  );
  // 깨진 사건은 replay와 같은 기준으로 없는 것으로 본다(합계에 넣지 않는다)
  const withBroken: WorkoutCycleRecord = { ...c, events: [...c.events, rawEvent("2026-02-30", "complete", 4)] };
  add(
    "소요시간",
    "깨진 사건은 합계에서 빠진다(replay와 같은 기준)",
    eq(cycleDuration(withBroken), cycleDuration(c)),
    S(cycleDuration(withBroken)),
  );
  const closed: WorkoutCycleRecord = { ...c, status: "completed", endedAt: nowIsoFor(dt(20)) };
  const h = workoutHistory([closed]);
  add(
    "소요시간",
    "workoutHistory 행에 사이클 총 시간(duration)",
    h.length === 1 && eq(h[0].duration, { totalSec: 2220, measuredCount: 2, estimatedCount: 1 }) && isPlainData(h),
    S(h[0]?.duration),
  );
  const tot = sumDurations([
    { sec: 10, source: "measured" },
    { sec: 20, source: "estimated" },
    { sec: 30, source: "measured" },
  ]);
  add("소요시간", "sumDurations — 합과 출처별 개수", eq(tot, { totalSec: 60, measuredCount: 2, estimatedCount: 1 }), S(tot));
});
scenario("소요시간", "운동 기록 목록", () => {
  // 사이클 1: D0 Day 1(근사), dt1 Day 2(실측 800) → dt1에 도중 재측정(오늘 시작) → 사이클 2: dt1 Day 1(실측 650) — 같은 날 두 사이클
  let all: WorkoutCycleRecord[] = [newCycle({ id: "c1" })];
  all = logActive(all, D0, "complete");
  const a1 = pickActiveWorkoutCycle(all)!;
  all = all.map((c) => (c.id === a1.id ? log(a1, dt(1), "complete", FAIL_PU0, 800) : c));
  all = restart(all, dt(1), "today", "c2");
  const a2 = pickActiveWorkoutCycle(all)!;
  all = all.map((c) => (c.id === a2.id ? log(a2, dt(1), "complete", FAIL_PU0, 650) : c));
  const rows = workoutLog(all);
  const rowsRev = workoutLog([...all].reverse());
  const keys = rows.map((r) => r.key);
  add(
    "소요시간",
    "workoutLog — 모든 사이클·최신 먼저(같은 날·같은 시각이면 cycleNo 큰 쪽 먼저)·입력 순서 무관·key 유일·직렬화 가능",
    eq(keys, ["c2#0", "c1#1", "c1#0"]) &&
      eq(rows, rowsRev) &&
      new Set(keys).size === keys.length &&
      eq(rows.map((r) => r.cycleNo), [2, 1, 1]) &&
      eq(rows.map((r) => r.duration.source), ["measured", "measured", "estimated"]) &&
      eq(rows.map((r) => r.duration.sec), [650, 800, 710]) &&
      isPlainData(rows),
    S(rows.map((r) => `${r.key}:${r.event.date}:${r.duration.sec}${r.duration.source === "measured" ? "" : "~"}`)),
  );
  const broken = workoutLog([{ ...all[0], events: [...all[0].events, rawEvent("", "complete", 3)] }]);
  add("소요시간", "workoutLog — 깨진 사건은 목록에서 빠진다", broken.length === all[0].events.length, String(broken.length));
  add("소요시간", "workoutLog — 사이클이 없으면 []", workoutLog([]).length === 0, "0");
});
scenario("소요시간", "표시 문자열·'약' 규칙", () => {
  const cases: [string, string | null, string | null][] = [
    ["실측 852초", durationText({ sec: 852, source: "measured" }), "14분 12초"],
    ["근사 805초", durationText({ sec: 805, source: "estimated" }), "약 13분"],
    ["근사 710초", durationText({ sec: 710, source: "estimated" }), "약 12분"],
    ["섞인 합계 3900초", durationTotalText({ totalSec: 3900, measuredCount: 3, estimatedCount: 1 }), "약 1시간 5분"],
    ["전부 실측 합계", durationTotalText({ totalSec: 3912, measuredCount: 4, estimatedCount: 0 }), "1시간 5분 12초"],
    ["전부 근사 합계", durationTotalText({ totalSec: 3600, measuredCount: 0, estimatedCount: 5 }), "약 1시간"],
    ["사건 없음", durationTotalText({ totalSec: 0, measuredCount: 0, estimatedCount: 0 }), null],
    ["실측 45초", formatDurationExact(45), "45초"],
    ["실측 900초", formatDurationExact(900), "15분"],
    ["실측 0초", formatDurationExact(0), "0초"],
    ["근사 10초(최소 1분)", formatDurationApprox(10), "약 1분"],
    ["출처 한 줄", durationBreakdownText({ totalSec: 1, measuredCount: 3, estimatedCount: 2 }), "실측 3회 · 근사 2회"],
    ["경과 754초", formatElapsedClock(754_000), "12:34"],
    ["경과 1시간 2분 3초", formatElapsedClock(3_723_000), "1:02:03"],
    ["경과 음수", formatElapsedClock(-5), "0:00"],
    ["끝낸 시각 KST", formatKstTime("2026-09-25T11:41:00.000Z"), "20:41"],
    ["끝낸 시각 모름", formatKstTime(""), null],
  ];
  const bad = cases.filter(([, got, want]) => got !== want).map(([name, got, want]) => `${name}: ${S(got)}≠${S(want)}`);
  add("소요시간", "실측 '14분 12초' · 근사 '약 13분' · 근사 섞인 합계 '약 1시간 5분' · 전부 실측이면 '약' 없음", bad.length === 0, bad.join(" / ") || `${cases.length}건 일치`);
  // 스냅샷 합계와 "약" — 근사가 하나라도 섞이면 "약", 전부 실측이면 없다(엔진 값 → 화면 문자열)
  let c = log(newCycle(), D0, "complete", FAIL_PU0, 600);
  const allMeasured = durationTotalText(snapshot(c, D0).duration);
  c = log(c, dt(1), "complete");
  const mixed = durationTotalText(snapshot(c, dt(1)).duration);
  add(
    "소요시간",
    "스냅샷 합계 — 실측만 '10분' → 근사 섞이면 '약 …'",
    allMeasured === "10분" && typeof mixed === "string" && mixed.startsWith("약 "),
    `${allMeasured} → ${mixed}`,
  );
});

// ---------------------------------------------------------------------------
printTable(results);
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`FAIL — 운동 엔진 ${failed.length}개 항목 실패.`);
  process.exit(1);
}
console.log(`PASS — 운동 엔진 ${results.length}개 항목 통과 (실호출 0회).`);

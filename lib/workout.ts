/**
 * lib/workout.ts — 아빠의 운동(러시안 파이터 풀업·푸시업 사다리) **순수 엔진** (SPEC §19-1~§19-4, 총 운동 소요시간 §19-8). AI·저장 없음.
 *
 * - 운동 타입의 **단일 정의처**다. lib/store.ts는 `import type`으로 가져와 재수출하고,
 *   lib/workout-contract.ts는 `export type` 재수출 + 요청·응답 shape만 둔다(§19-4).
 * - 런타임 의존성은 `./kst`뿐 — 클라이언트 번들(설정 미리보기·세션)과 eval이 그대로 import한다.
 *   ⚠️ 이 파일이 store를 import하면 안 된다(store는 node:fs·firebase-admin을 끌고 오는 서버 전용).
 * - **저장하는 것은 사건(event)뿐이다.** 현재 Day·실패 플래그·누적 볼륨은 사건을 재생해 계산한다
 *   (§19-2 — 스트릭 §17-5와 같은 규약. 저장하면 두 진실이 갈린다).
 * - "오늘"(todayKst)·"지금"(nowIso)·새 id는 전부 **인자로** 받는다. 판정 함수(decide*)는 순수·결정적이라
 *   Firestore 트랜잭션이 재시도해도 같은 답을 낸다(§19-4).
 * - 반환 값은 전부 직렬화 가능(Date 객체·undefined 없음 — RSC props로 넘어간다).
 */

import { diffDateStrings, isZonedIsoTimestamp, kstDateString, shiftDateString } from "./kst";

// ===========================================================================
// 상수
// ===========================================================================

/** 운동마다 세트 수(사다리 5칸) */
export const SETS_PER_EXERCISE = 5;
/** 사이클 길이 — 4블록 × 6일 + 마무리 휴식 2일 + 재측정 1일 (§19-1) */
export const CYCLE_DAYS = 27;
/** 재측정 Day */
export const RETEST_DAY = 27;
/** 마지막 운동일(그 뒤 24·25·26은 마무리 휴식) */
export const LAST_WORKOUT_DAY = 23;
/** 사이클의 운동일 수 — 진행률 분모 */
export const TOTAL_WORKOUT_DAYS = 20;
/** RM 입력 범위(정수) — 라우트 zod와 같은 값 */
export const RM_MIN = 1;
export const RM_MAX = 150;
/** 처음 시작 화면의 RM 기본값 — 원안의 현재 상태(§19-3) */
export const DEFAULT_RM: Readonly<WorkoutRm> = { pullup: 10, pushup: 18 };
/** snapshot이 싣는 앞으로의 일정 일수 */
export const SNAPSHOT_UPCOMING_DAYS = 3;

/**
 * 실측 소요시간 상한(초) — 3시간 (§19-8). 기록 요청의 `durationSec`이 이 범위(정수 0..상한) 밖이면 **기록은 받되 소요시간만 null**
 * (닫아 둔 채 몇 시간 뒤 끝낸 벽시계 값이 총합을 망치지 않게). 판정(decideLog)과 정규화(normalizeWorkoutEvent)가 같은 검사를 쓴다.
 */
export const WORKOUT_DURATION_MAX_SEC = 3 * 60 * 60;
/**
 * 세트 사이 기본 휴식(초) — 세션 타이머의 기본값(2분)과 근사식의 "쉰 휴식 한 번"이 **같은 상수**를 본다(§19-8, 정의처 하나).
 * 세션(components/workout-session.tsx)은 이 값으로 DEFAULT_REST_MS를 만든다. 실제로 고른 3분·+30초·건너뛰기는 저장되지 않는다.
 */
export const DEFAULT_REST_SEC = 120;
/**
 * 근사 소요시간 계수(초, §19-8) — **추정값**이다(코드·스펙 밖 근거 없음). 실측이 쌓이면 중앙값으로 보정할 수 있다.
 * `추정초 = Σ풀업 reps × pullupRep + Σ푸시업 reps × pushupRep + 수행 스텝 수 × step + 쉰 휴식 수 × DEFAULT_REST_SEC`
 */
export const DURATION_ESTIMATE_SEC = { pullupRep: 3, pushupRep: 2, step: 10 } as const;

// ===========================================================================
// 타입 — 단일 정의처 (§19-2·§19-4)
// ===========================================================================

export type WorkoutExercise = "pullup" | "pushup";

export interface WorkoutRm {
  pullup: number;
  pushup: number;
}

/** 운동별 5세트 횟수(목표·수행 공용) */
export interface SetPair {
  pullup: number[];
  pushup: number[];
}

/** 운동별 합계(목표 합·누적 볼륨) */
export interface RepTotals {
  pullup: number;
  pushup: number;
}

/** 실패 지점 — 어느 운동의 몇 번째 세트(0..4)에서, 그 세트를 몇 회까지 했는지(선택, 0..목표) */
export interface FailedAt {
  exercise: WorkoutExercise;
  setIndex: number;
  reps: number | null;
}

export type WorkoutEventKind = "complete" | "fail";

export interface WorkoutEvent {
  /** KST 일자 YYYY-MM-DD — 서버가 기록 시점에 찍는다 */
  date: string;
  /** ISO UTC */
  at: string;
  kind: WorkoutEventKind;
  /** 이 운동이 차지한 계획 Day(슬롯) */
  day: number;
  /** 실제로 쓴 목표의 Day — 보통 day, 실패 후 복귀(재부여)면 직전 성공 Day */
  targetDay: number;
  /** fail일 때만(complete는 null) */
  failed: FailedAt | null;
  /** 실제 수행 횟수 — 서버가 계산해 넣는다 */
  reps: SetPair;
  /**
   * 실측 소요시간(초, §19-8) — 세션을 처음 연 순간부터 기록 요청을 처음 보낸 순간까지의 벽시계 시간(휴식 포함).
   * **클라이언트 보고값**이라 서버는 형식·범위(정수 0..WORKOUT_DURATION_MAX_SEC)만 검증한다(§19-2 "서버 계산값" 원칙의 예외).
   * 세션 없이 한 기록·옛 사건·범위 밖은 null → 읽을 때 근사치(estimateEventSec)로 보인다.
   */
  durationSec: number | null;
}

/** 소요시간의 출처 — 실측(세션이 잰 값) / 근사(사건의 reps·휴식 규칙으로 계산) */
export type DurationSource = "measured" | "estimated";

/** 사건 하나의 소요시간 — 저장하지 않고 읽을 때 엔진이 만든다(§19-8) */
export interface EventDuration {
  sec: number;
  source: DurationSource;
}

/** 사건 여러 개의 소요시간 합계 — 근사가 하나라도 섞이면(estimatedCount > 0) 화면은 "약"을 붙인다 */
export interface DurationTotal {
  totalSec: number;
  measuredCount: number;
  estimatedCount: number;
}

export type WorkoutCycleStatus = "active" | "completed" | "abandoned";
/** 닫힌 사이클의 상태 */
export type ClosedCycleStatus = Exclude<WorkoutCycleStatus, "active">;

/** Firestore 컬렉션 `workoutCycles` / db.json `workoutCycles` 한 건 (§19-4) */
export interface WorkoutCycleRecord {
  id: string;
  /** ISO */
  createdAt: string;
  /** 1, 2, 3 … (전체 max + 1) */
  cycleNo: number;
  /** KST YYYY-MM-DD — Day 1을 할 수 있는 첫날 */
  startDate: string;
  rm: WorkoutRm;
  /** Day 1 사다리 — RM에서 계산해 고정 저장. 목표는 항상 이것으로 계산한다(RM에서 다시 계산하지 않는다) */
  base: SetPair;
  status: WorkoutCycleStatus;
  /** ISO */
  endedAt: string | null;
  /** 변경마다 +1 (낙관적 동시성 토큰, 생성 시 0) */
  rev: number;
  /** 시간순 append — 배열 끝이 undo 대상 */
  events: WorkoutEvent[];
}

/** 상태 계산에 필요한 최소 형태(구조적 타입 — 레코드 전체가 아니어도 된다) */
export type WorkoutCycleLike = Pick<WorkoutCycleRecord, "startDate" | "base" | "events">;

export type DayKind = "workout" | "rest" | "cycle_rest" | "retest";

/** 27일 계획표 한 행(운동일만 목표가 있다) */
export interface PlanRow {
  day: number;
  kind: DayKind;
  target: SetPair | null;
  totals: RepTotals | null;
}

/** 슈퍼세트 진행 스텝(0..9) — 짝수 = 풀업, 홀수 = 푸시업, 세트 = floor(k/2) */
export interface WorkoutStep {
  step: number;
  exercise: WorkoutExercise;
  setIndex: number;
  reps: number;
}

/** 앞으로의 하루 — `tomorrow`·`next`·미리보기 (§19-2) */
export type Upcoming =
  | { kind: "workout"; day: number; targetDay: number }
  | { kind: "rest"; day: number; cycleEnd: boolean; index: number; of: number }
  | { kind: "recovery"; pendingDay: number }
  | { kind: "retest" };

/** upcoming()의 한 칸 — 날짜를 함께 싣는다(시작 전 날짜를 건너뛸 때 간격이 날짜로 드러난다) */
export interface UpcomingEntry {
  date: string;
  item: Upcoming;
}

export type RecordedOutcome = "complete" | "repeat_complete" | "fail";

/** 오늘 상태 — 화면이 보는 **유일한 계약**. 화면은 규칙을 다시 구현하지 않는다 (§19-2) */
export type TodayStatus =
  | { kind: "not_started"; startDate: string; daysUntil: number; displayDay: 1 }
  | {
      kind: "workout";
      day: number;
      targetDay: number;
      isRepeat: boolean;
      target: SetPair;
      totals: RepTotals;
      retestHint: boolean;
      displayDay: number;
    }
  | { kind: "rest"; day: number; cycleEnd: boolean; index: number; of: number; next: Upcoming; displayDay: number }
  | { kind: "recovery"; pendingDay: number; resumeTargetDay: number; next: Upcoming; displayDay: number }
  | { kind: "recorded_today"; outcome: RecordedOutcome; day: number; targetDay: number; tomorrow: Upcoming; displayDay: number }
  | { kind: "retest"; displayDay: 27 };

/** 사건 재생 결과 (§19-2) */
export interface ReplayState {
  /** 다음에 도전할 슬롯 Day(23 완료 뒤 27) */
  nextDay: number;
  /** 재부여 목표 Day — 실패 직후 직전 성공 Day, 재부여 성공이면 null */
  repeatOf: number | null;
  lastSuccessDay: number | null;
  /** 현재 슬롯 Day(nextDay)에서 난 실패 수 — 보통 성공만 0으로 되돌린다(재부여 성공은 안 되돌림). ≥2면 재측정 안내 */
  failsAtNextDay: number;
  /** 보통 complete로 끝낸 서로 다른 운동 Day(오름차순) — 진행률 분자 */
  completedDays: number[];
  /** 슬롯 Day별 실패 수 — 계획표 ✗ */
  failsByDay: Record<number, number>;
  failCount: number;
  /** 모든 사건 reps 합(성공·실패 부분·재부여 모두) */
  volume: RepTotals;
}

/** snapshot의 계획표 행 — 표시용 정보(✓ 완료·✗ 실패 수·▶ 현재)를 함께 싣는다 */
export interface CyclePlanRow extends PlanRow {
  /** 보통 complete로 끝냈는가(✓) — 재부여 성공은 넣지 않는다 */
  completed: boolean;
  /** 이 Day(슬롯)에서 난 실패 수(✗) */
  fails: number;
  /** ▶ — 브리핑 displayDay와 같은 행(시작 전엔 없음) */
  current: boolean;
}

/** 화면 한 번에 필요한 것 전부 — 서버 컴포넌트가 계산해 props로 넘긴다 */
export interface CycleSnapshot {
  cycleId: string;
  cycleNo: number;
  startDate: string;
  rm: WorkoutRm;
  status: WorkoutCycleStatus;
  /** 기록·취소 요청의 expectedRev */
  rev: number;
  eventCount: number;
  /** 마지막 기록(취소 확인 패널용), 없으면 null */
  lastEvent: WorkoutEvent | null;
  /** 마지막 기록의 소요시간(실측 또는 근사, §19-8) — 오늘 기록 카드 */
  lastEventDuration: EventDuration | null;
  /** 이번 사이클 총 운동 시간(§19-8) */
  duration: DurationTotal;
  today: TodayStatus;
  plan: CyclePlanRow[];
  progress: { done: number; total: typeof TOTAL_WORKOUT_DAYS; pct: number };
  volume: RepTotals;
  failCount: number;
  /** 내일부터 SNAPSHOT_UPCOMING_DAYS일(오늘이 운동일이면 오늘 성공을 가정) */
  upcoming: UpcomingEntry[];
}

/** 지난 사이클 한 줄 — RM 변화는 다음 사이클 rm에서 파생한다(별도 필드 없음, §19-3) */
export interface WorkoutHistoryRow {
  id: string;
  cycleNo: number;
  startDate: string;
  createdAt: string;
  endedAt: string | null;
  status: ClosedCycleStatus;
  rm: WorkoutRm;
  /** cycleNo 순으로 바로 다음 사이클의 rm — 없으면 null */
  nextRm: WorkoutRm | null;
  done: number;
  failCount: number;
  volume: RepTotals;
  /** 그 사이클의 총 운동 시간(§19-8) */
  duration: DurationTotal;
}

/** 📒 운동 기록 한 줄(§19-8) — 모든 사이클의 사건을 최신 먼저. 화면은 사건 값과 소요시간을 글자로 옮기기만 한다 */
export interface WorkoutLogRow {
  /** 목록 key — `{cycleId}#{사건 배열 위치}` */
  key: string;
  cycleId: string;
  cycleNo: number;
  event: WorkoutEvent;
  duration: EventDuration;
}

export interface DecideLogInput {
  expectedRev: number;
  kind: WorkoutEventKind;
  day: number;
  targetDay: number;
  failed: FailedAt | null;
  /** 실측 소요시간(초) — 클라이언트 보고값. 정수 0..WORKOUT_DURATION_MAX_SEC가 아니면 사건엔 null로 싣는다(기록은 받는다) */
  durationSec: number | null;
  todayKst: string;
  nowIso: string;
}
export type DecideLogResult =
  | { status: "ok"; next: WorkoutCycleRecord; event: WorkoutEvent }
  | { status: "conflict" | "stale_state" | "not_active" };

export interface DecideUndoInput {
  expectedRev: number;
}
export type DecideUndoResult =
  | { status: "ok"; next: WorkoutCycleRecord; removed: WorkoutEvent }
  | { status: "conflict" | "empty" | "not_active" };

export interface DecideStartInput {
  rm: WorkoutRm;
  startDate: string;
  expectedActiveCycleId: string | null;
  todayKst: string;
  nowIso: string;
}
export type DecideStartResult =
  | { status: "conflict"; activeCycleId: string | null }
  | {
      status: "ok";
      mode: "created" | "replaced";
      /** 새로 만든(created) 또는 제자리 교체한(replaced) 활성 사이클 */
      record: WorkoutCycleRecord;
      /** 스토어가 **id로 upsert**할 레코드 전부(닫은 사이클 + record). 한 원자 단위로 쓴다 */
      writes: WorkoutCycleRecord[];
      /** 닫은 활성 사이클(선택된 것) — 없으면 null */
      closed: { id: string; status: ClosedCycleStatus } | null;
      /** 닫은 사이클 중 사건이 있던 것이 있는가 — Firestore는 이때 prod-guard(`closeWorkoutCycle`)를 부른다 */
      closedHadEvents: boolean;
    };

// ===========================================================================
// 내부 보조
// ===========================================================================

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
// ISO 시각 판정(createdAt·endedAt)은 lib/kst의 isZonedIsoTimestamp 한 곳이다 — 여기에 정규식을 따로 두지 않는다
// (예전엔 소수 1~9자리·24:00을 받는 별도 정의라 "만든 날짜" 표시 formatKstDate와 경계가 갈렸다).

const sumOf = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** 달력에 있는 `YYYY-MM-DD`인가 — 판정은 lib/kst의 diffDateStrings 한 곳(형식·달력 밖이면 NaN) */
function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(diffDateStrings(value, value));
}

function assertDateString(value: unknown, label: string): asserts value is string {
  if (!isDateString(value)) throw new RangeError(`${label}는 달력에 있는 YYYY-MM-DD여야 한다: ${String(value)}`);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new RangeError(`${label}가 비어 있다`);
}

/** 레코드를 필드 목록 그대로 다시 짠다 — 여분 속성(스토어 메타)을 떨구고 키 순서를 고정한다(결정적 JSON) */
function recordOf(c: WorkoutCycleRecord, patch: Partial<WorkoutCycleRecord> = {}): WorkoutCycleRecord {
  const m = { ...c, ...patch };
  return {
    id: m.id,
    createdAt: m.createdAt,
    cycleNo: m.cycleNo,
    startDate: m.startDate,
    rm: m.rm,
    base: m.base,
    status: m.status,
    endedAt: m.endedAt,
    rev: m.rev,
    events: m.events,
  };
}

// ===========================================================================
// 사다리 (§19-1)
// ===========================================================================

/** RM 입력이 유효한가 — 정수 1~150 */
export function isValidRm(rm: unknown): rm is number {
  return typeof rm === "number" && Number.isInteger(rm) && rm >= RM_MIN && rm <= RM_MAX;
}

/**
 * Day 1 사다리의 맨 위 세트 = `max(1, floor(RM × 비율))` — 풀업 3/5, 푸시업 1/2.
 * 부동소수 오차를 피하려고 **정수 분수**로 계산한다. 유효하지 않은 RM이면 RangeError(isValidRm 먼저).
 */
export function topSet(rm: number, exercise: WorkoutExercise): number {
  if (!isValidRm(rm)) throw new RangeError(`${exercise} RM은 ${RM_MIN}~${RM_MAX} 정수여야 한다: ${rm}`);
  const raw = exercise === "pullup" ? Math.floor((rm * 3) / 5) : Math.floor(rm / 2);
  return Math.max(1, raw);
}

/** Day 1 사다리 — `[top, top-1, …, top-4]`, 각 세트 최소 1 */
export function baseLadder(rm: number, exercise: WorkoutExercise): number[] {
  const top = topSet(rm, exercise);
  return Array.from({ length: SETS_PER_EXERCISE }, (_, i) => Math.max(1, top - i));
}

/** RM 한 쌍 → 사이클에 고정 저장할 base */
export function makeBase(rm: WorkoutRm): SetPair {
  return { pullup: baseLadder(rm.pullup, "pullup"), pushup: baseLadder(rm.pushup, "pushup") };
}

/** 사다리가 평평해지는가(`top − 4 < 1` — 풀업 RM < 9, 푸시업 RM < 10). 유효하지 않은 RM이면 false(입력 중 화면용) */
export function isFlatLadder(rm: number, exercise: WorkoutExercise): boolean {
  if (!isValidRm(rm)) return false;
  return topSet(rm, exercise) - (SETS_PER_EXERCISE - 1) < 1;
}

/** 설정 화면 경고("RM이 낮으면 이 루틴의 부담이 커요") 여부 — 막지는 않는다 */
export function lowRmWarning(rm: WorkoutRm): boolean {
  return isFlatLadder(rm.pullup, "pullup") || isFlatLadder(rm.pushup, "pushup");
}

// ===========================================================================
// 27일 계획 (§19-1)
// ===========================================================================

/** 운동일인가 — 1~5, 7~11, 13~17, 19~23. 던지지 않는다(zod refine용) */
export function isWorkoutDay(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= LAST_WORKOUT_DAY && day % 6 !== 0;
}

/** 운동일 20개 [1..5, 7..11, 13..17, 19..23] */
export const WORKOUT_DAY_LIST: readonly number[] = Array.from({ length: LAST_WORKOUT_DAY }, (_, i) => i + 1).filter(isWorkoutDay);

/** Day 종류 — 1~27 정수 밖이면 RangeError */
export function dayKind(day: number): DayKind {
  if (!Number.isInteger(day) || day < 1 || day > CYCLE_DAYS) throw new RangeError(`Day는 1~${CYCLE_DAYS} 정수여야 한다: ${day}`);
  if (day === RETEST_DAY) return "retest";
  if (day > LAST_WORKOUT_DAY) return "cycle_rest";
  return day % 6 === 0 ? "rest" : "workout";
}

/**
 * 운동일 목표 — 블록 b = floor((n−1)/6), 블록 안 d = (n−1) % 6:
 * `target[i] = base[i] + b + (d > 0 && i ≥ 5 − d ? 1 : 0)`. 뒤쪽 세트부터 하루에 하나씩 +1.
 * **항상 저장된 base로 계산한다**(RM에서 다시 계산하지 않는다). 운동일이 아니면 RangeError.
 */
export function targetFor(base: SetPair, day: number): SetPair {
  if (!isWorkoutDay(day)) throw new RangeError(`운동일이 아니다: Day ${day}`);
  const b = Math.floor((day - 1) / 6);
  const d = (day - 1) % 6;
  const ladder = (arr: readonly number[]) => arr.map((v, i) => v + b + (d > 0 && i >= SETS_PER_EXERCISE - d ? 1 : 0));
  return { pullup: ladder(base.pullup), pushup: ladder(base.pushup) };
}

/** 운동별 합계 */
export function setTotals(p: SetPair): RepTotals {
  return { pullup: sumOf(p.pullup), pushup: sumOf(p.pushup) };
}

/** 27일 계획표(27행) */
export function buildPlan(base: SetPair): PlanRow[] {
  return Array.from({ length: CYCLE_DAYS }, (_, i): PlanRow => {
    const day = i + 1;
    const kind = dayKind(day);
    if (kind !== "workout") return { day, kind, target: null, totals: null };
    const target = targetFor(base, day);
    return { day, kind, target, totals: setTotals(target) };
  });
}

/** day 다음 운동일 — 5→7, 11→13, 23→27(재측정). 던지지 않는다 */
export function nextWorkoutDay(day: number): number {
  for (let d = Math.floor(day) + 1; d <= LAST_WORKOUT_DAY; d++) {
    if (isWorkoutDay(d)) return d;
  }
  return RETEST_DAY;
}

/** from과 to 사이(양끝 제외)의 계획 휴식일 — (5,7)→[6], (23,27)→[24,25,26], (1,2)→[] */
export function restDaysBetween(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = Math.max(1, Math.floor(from) + 1); d < to && d < RETEST_DAY; d++) {
    if (!isWorkoutDay(d)) out.push(d);
  }
  return out;
}

// ===========================================================================
// 슈퍼세트 스텝·수행 횟수 (§19-1·§19-2)
// ===========================================================================

/** (운동, 세트) → 스텝 번호 0..9 */
export function stepIndexOf(exercise: WorkoutExercise, setIndex: number): number {
  return setIndex * 2 + (exercise === "pushup" ? 1 : 0);
}

/** 풀업 1세트 → 푸시업 1세트 → 풀업 2세트 … 총 10스텝 */
export function supersetSteps(target: SetPair): WorkoutStep[] {
  return Array.from({ length: SETS_PER_EXERCISE * 2 }, (_, k): WorkoutStep => {
    const exercise: WorkoutExercise = k % 2 === 0 ? "pullup" : "pushup";
    const setIndex = Math.floor(k / 2);
    return { step: k, exercise, setIndex, reps: target[exercise][setIndex] };
  });
}

/**
 * 이 스텝의 ✓ 뒤에 휴식이 오는가 — **세트(라운드)를 끝내는 푸시업 스텝**(홀수), 마지막 스텝 제외 → [1,3,5,7] (§19-1 슈퍼세트·§19-6).
 * 풀업(짝수 스텝)의 ✓는 쉬지 않고 같은 세트의 푸시업으로, 마지막 스텝의 ✓는 곧바로 완료 기록이다.
 * 휴식 규칙의 **유일한 정의처** — 세션의 ✓ 처리·휴식 끝 음성 안내 대상·진행 복원 정규화·목록의 휴식 줄이 전부 이것(과 stepFollowsRest)을 본다.
 * 스텝 번호 규칙(k 짝수 = 풀업, 홀수 = 푸시업, 세트 = floor(k/2))은 supersetSteps와 같다. 범위 밖·정수 아님 → false.
 */
export function restFollowsStep(k: number): boolean {
  return Number.isInteger(k) && k >= 0 && k < SETS_PER_EXERCISE * 2 - 1 && k % 2 === 1;
}

/** 이 스텝이 휴식 뒤에 오는가 → [2,4,6,8](= 2~5세트의 풀업). 쉬는 중 "다음"이 가리킬 수 있는 스텝, 휴식 끝 음성 안내가 읽는 스텝 */
export function stepFollowsRest(k: number): boolean {
  return Number.isInteger(k) && k > 0 && restFollowsStep(k - 1);
}

/**
 * 휴식 끝에 음성으로 안내할 스텝 — 휴식 뒤 스텝(2~5세트 풀업) **정확히 4개**, 스텝 순. 세션 시작 탭의 프리페치 대상이다(§19-6).
 * 첫 스텝과 푸시업 스텝은 휴식 뒤에 오지 않아 읽히지 않으므로 뺀다(합성 낭비 방지). 문구로 옮기는 것은 화면(stepPhrase)이 한다.
 */
export function stepsAfterRest(target: SetPair): WorkoutStep[] {
  return supersetSteps(target).filter((st) => stepFollowsRest(st.step));
}

/**
 * 세션 세트(라운드) 목록의 표시 순서(§19-6 — 2026-09-25 사용자 요청) — **지금 할 세트가 맨 위**, 그 아래 남은 세트(번호순),
 * **끝낸 세트는 맨 아래**(번호순). 현재 스텝에서 파생한다(순서를 저장하지 않으므로 새로고침 복원·재진입은 곧바로 최종 순서다).
 * `held` = 축하 중인 세트 — 방금 끝냈지만 축하가 끝날 때까지 맨 위 제자리에 붙잡아 두는 세트(표시만 늦출 뿐 진행 상태가 아니다).
 * **이미 끝낸 세트(지금 세트보다 앞)일 때만** 맨 위에 두고, 나머지는 완료 여부로 가른다 — held가 두 세트 이상 뒤여도 다른 끝낸 세트가
 * 남은 구역에 끼지 않는다. 아직 안 끝난 세트·범위 밖·정수 아닌 held는 무시한다.
 * 돌려주는 값: 세트 번호(0..4)의 표시 순서와 완료 구역이 시작하는 위치 `doneFrom`(이 앞은 held·지금·남은 세트).
 * 화면(components/workout-session.tsx)이 쓰고, eval:workout "세트 목록 순서"가 스텝 0~9 × 축하 유무로 잠근다.
 */
export function roundDisplayOrder(step: number, held: number | null): { order: number[]; doneFrom: number } {
  const last = SETS_PER_EXERCISE - 1;
  const cur = Number.isInteger(step) ? Math.min(last, Math.max(0, Math.floor(step / 2))) : 0;
  const top = held !== null && Number.isInteger(held) && held >= 0 && held < cur ? [held] : [];
  const ahead: number[] = [];
  const done: number[] = [];
  for (let r = 0; r <= last; r++) {
    if (top.includes(r)) continue;
    (r >= cur ? ahead : done).push(r);
  }
  return { order: [...top, ...ahead, ...done], doneFrom: top.length + ahead.length };
}

/** 실패 지점 형태 검사 — 입력 형태는 라우트 zod가 보장하므로 어긋나면 프로그래밍 오류(RangeError) */
function assertFailedAt(failed: FailedAt | null | undefined): FailedAt {
  if (
    !failed ||
    (failed.exercise !== "pullup" && failed.exercise !== "pushup") ||
    !Number.isInteger(failed.setIndex) ||
    failed.setIndex < 0 ||
    failed.setIndex >= SETS_PER_EXERCISE
  ) {
    throw new RangeError(`fail 기록에는 실패 지점(exercise·setIndex 0..${SETS_PER_EXERCISE - 1})이 필요하다`);
  }
  return failed;
}

/** 실패 세트에서 한 횟수 — 없으면 0, `0..목표`로 클램프(횟수는 채웠지만 자세가 무너진 경우도 담는다) */
function clampReps(reps: unknown, max: number): number {
  if (typeof reps !== "number" || !Number.isFinite(reps)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(reps)));
}

/**
 * 사건의 실제 수행 횟수 — 서버가 계산한다(클라이언트 숫자를 믿지 않는다). 기준 목표 = target(base, targetDay).
 * - complete → 목표 그대로(복사본)
 * - fail → 실패 스텝 **이전**은 목표 그대로, 실패 세트는 입력 횟수(0..목표), 이후는 0
 */
export function repsForEvent(target: SetPair, kind: WorkoutEventKind, failed: FailedAt | null): SetPair {
  if (kind === "complete") return { pullup: [...target.pullup], pushup: [...target.pushup] };
  if (kind !== "fail") throw new RangeError(`알 수 없는 기록 종류: ${String(kind)}`);
  const f = assertFailedAt(failed);
  const failStep = stepIndexOf(f.exercise, f.setIndex);
  const out: SetPair = { pullup: target.pullup.map(() => 0), pushup: target.pushup.map(() => 0) };
  for (const s of supersetSteps(target)) {
    if (s.step < failStep) out[s.exercise][s.setIndex] = s.reps;
    else if (s.step === failStep) out[s.exercise][s.setIndex] = clampReps(f.reps, s.reps);
  }
  return out;
}

// ===========================================================================
// 재생 (§19-2)
// ===========================================================================

/**
 * 상태 기계가 쓸 수 없는 사건인가 — 그 이유(쓸 수 있으면 null). day·targetDay가 운동일이 아니거나 date가 달력 밖이면 깨진 것.
 * 엔진이 직접 쓴 사건에선 생길 수 없다(손으로 고친 문서·사고). **엔진(replay·resolveDay)과 정규화가 같은 규칙**을 쓴다 —
 * 정규화는 버리고(경고), 엔진은 없는 것으로 본다. 그래서 정규화를 거쳤든 안 거쳤든 같은 상태가 나온다.
 */
function brokenEventReason(e: WorkoutEvent): string | null {
  if (!isWorkoutDay(e.day)) return `day ${String(e.day)}는 운동일이 아니다`;
  if (!isWorkoutDay(e.targetDay)) return `targetDay ${String(e.targetDay)}는 운동일이 아니다`;
  if (!isDateString(e.date)) return `date ${JSON.stringify(e.date) ?? String(e.date)}가 달력에 있는 YYYY-MM-DD가 아니다`;
  return null;
}

const isUsableEvent = (e: WorkoutEvent) => brokenEventReason(e) === null;

/**
 * 사건을 **배열 순서 그대로** 접는다 — 정렬하지 않는다(배열 끝이 undo 대상이고, 저장 불변식이 날짜 순서를 보장한다).
 * 깨진 사건(brokenEventReason)은 건너뛴다 — 예전엔 Day 6 사건이 targetFor에서 RangeError를 일으켜 페이지가 500이 됐다.
 * - complete·재부여(targetDay ≠ day): repeatOf = null, lastSuccessDay = targetDay. nextDay·failsAtNextDay는 그대로
 *   (실패했던 그 Day에 다시 도전한다 / 재부여 성공은 실패 수를 되돌리지 않는다 — 되돌리면 루프에서 안내가 영영 안 뜬다).
 * - complete·보통: 완료 집합에 day, lastSuccessDay = day, nextDay = 다음 운동일, failsAtNextDay = 0.
 * - fail: repeatOf = lastSuccessDay(없으면 null → 같은 Day 그대로 재도전), failsAtNextDay += 1.
 * - 모든 사건: 볼륨 += reps 합.
 */
export function replay(events: readonly WorkoutEvent[]): ReplayState {
  let nextDay = 1;
  let repeatOf: number | null = null;
  let lastSuccessDay: number | null = null;
  let failsAtNextDay = 0;
  let failCount = 0;
  const done = new Set<number>();
  const failsByDay: Record<number, number> = {};
  const volume: RepTotals = { pullup: 0, pushup: 0 };

  for (const e of events) {
    if (!isUsableEvent(e)) continue;
    volume.pullup += sumOf(e.reps.pullup);
    volume.pushup += sumOf(e.reps.pushup);
    if (e.kind === "complete") {
      if (e.targetDay !== e.day) {
        repeatOf = null;
        lastSuccessDay = e.targetDay;
      } else {
        done.add(e.day);
        lastSuccessDay = e.day;
        nextDay = nextWorkoutDay(e.day);
        failsAtNextDay = 0;
        repeatOf = null; // 방어 — decideLog를 거친 사건열에선 이미 null이다
      }
    } else {
      repeatOf = lastSuccessDay;
      failsAtNextDay += 1;
      failCount += 1;
      failsByDay[e.day] = (failsByDay[e.day] ?? 0) + 1;
    }
  }

  return {
    nextDay,
    repeatOf,
    lastSuccessDay,
    failsAtNextDay,
    completedDays: [...done].sort((a, b) => a - b),
    failsByDay,
    failCount,
    volume,
  };
}

// ===========================================================================
// 총 운동 소요시간 (§19-8) — 실측(세션이 잰 durationSec)과 근사(reps·휴식 규칙). **저장하지 않고 읽을 때 계산한다**
// (§19-2 "저장은 사건뿐, 파생값은 재생" — 근사치를 백필하려고 프로덕션 DB를 고치지 않는다).
// ===========================================================================

/** 실측 소요시간으로 쓸 수 있는 값인가 — 정수 0..WORKOUT_DURATION_MAX_SEC. 판정(decideLog)·정규화·표시가 같은 검사를 쓴다 */
export function isValidDurationSec(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= WORKOUT_DURATION_MAX_SEC;
}

/** 스텝 0..n−1 가운데 뒤에 휴식이 오는 스텝 수 — 휴식 규칙은 restFollowsStep 하나(완주 = 4) */
function restsBefore(n: number): number {
  let count = 0;
  for (let k = 0; k < n; k++) if (restFollowsStep(k)) count += 1;
  return count;
}

/**
 * 사건이 멈춘 스텝(0..9) — fail이면 실패 지점의 스텝. 실패 지점이 없는 fail(손상 — 정규화가 exercise를 못 읽은 경우)은
 * reps가 있는 앞쪽 스텝 수로 본다(결정적 대체값 — 엔진이 쓴 사건에선 생기지 않는다). complete는 null(멈추지 않았다).
 */
function failStepOf(e: Pick<WorkoutEvent, "kind" | "failed" | "reps">): number | null {
  if (e.kind !== "fail") return null;
  if (e.failed) return stepIndexOf(e.failed.exercise, e.failed.setIndex);
  let k = 0;
  const total = SETS_PER_EXERCISE * 2;
  while (k < total - 1) {
    const exercise: WorkoutExercise = k % 2 === 0 ? "pullup" : "pushup";
    if (!((e.reps[exercise]?.[Math.floor(k / 2)] ?? 0) > 0)) break;
    k += 1;
  }
  return k;
}

/**
 * 근사 소요시간(초, §19-8) — 실측이 없는 사건(지난 기록·세션 없이 한 기록·상한 초과)용. 순수·결정적(at·durationSec을 보지 않는다).
 * `Σ풀업 reps × 3 + Σ푸시업 reps × 2 + 수행 스텝 수 × 10 + 쉰 휴식 수 × 120`
 * - 수행 스텝 수: 완료 10, 실패는 실패 스텝 번호 + 1(멈춘 세트도 시도했다).
 * - 쉰 휴식 수: 완료 4, 실패는 실패 스텝 **앞**에서 restFollowsStep인 스텝 수(멈춘 세트 뒤엔 쉬지 않았다).
 * 예(10/18RM): Day 1 완주 710초(≈12분), Day 23 완주 805초(≈13분). 2026-09-25 이전(스텝마다 쉬던 시기) 사건도 같은 식이다
 * — 해당 사건이 1건 이하라 규칙을 나누지 않았다.
 */
export function estimateEventSec(e: Pick<WorkoutEvent, "kind" | "failed" | "reps">): number {
  const totalSteps = SETS_PER_EXERCISE * 2;
  const failStep = failStepOf(e);
  const stepsDone = failStep === null ? totalSteps : Math.min(totalSteps, failStep + 1);
  const rests = restsBefore(failStep === null ? totalSteps : failStep);
  const repSum = (arr: readonly number[] | undefined) =>
    (arr ?? []).reduce((a, x) => a + (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0), 0);
  return (
    repSum(e.reps.pullup) * DURATION_ESTIMATE_SEC.pullupRep +
    repSum(e.reps.pushup) * DURATION_ESTIMATE_SEC.pushupRep +
    stepsDone * DURATION_ESTIMATE_SEC.step +
    rests * DEFAULT_REST_SEC
  );
}

/** 사건 하나의 소요시간 — 실측(durationSec이 유효)이면 그 값, 아니면 근사 */
export function eventDuration(e: WorkoutEvent): EventDuration {
  return isValidDurationSec(e.durationSec) ? { sec: e.durationSec, source: "measured" } : { sec: estimateEventSec(e), source: "estimated" };
}

/** 소요시간 합계 — 개수별로 센다(근사가 하나라도 있으면 화면이 "약"을 붙인다) */
export function sumDurations(ds: readonly EventDuration[]): DurationTotal {
  const out: DurationTotal = { totalSec: 0, measuredCount: 0, estimatedCount: 0 };
  for (const d of ds) {
    out.totalSec += d.sec;
    if (d.source === "measured") out.measuredCount += 1;
    else out.estimatedCount += 1;
  }
  return out;
}

/** 한 사이클의 총 운동 시간 — 쓸 수 있는 사건만(깨진 사건은 replay와 같은 기준으로 없는 것으로 본다) */
export function cycleDuration(cycle: Pick<WorkoutCycleRecord, "events">): DurationTotal {
  return sumDurations(cycle.events.filter(isUsableEvent).map(eventDuration));
}

/**
 * 📒 운동 기록(§19-8) — 모든 사이클(닫힌 것 포함)의 쓸 수 있는 사건을 **최신 먼저**. 날짜 → 기록 시각(at) → cycleNo → 배열 위치 내림차순
 * (도중 재측정한 날은 닫힌 사이클과 새 사이클에 같은 날 사건이 있을 수 있다). 입력 순서와 무관하게 결정적, 직렬화 가능.
 */
export function workoutLog(cycles: readonly WorkoutCycleRecord[]): WorkoutLogRow[] {
  const rows: (WorkoutLogRow & { index: number })[] = [];
  for (const c of cycles) {
    c.events.forEach((event, index) => {
      if (!isUsableEvent(event)) return;
      rows.push({ key: `${c.id}#${index}`, cycleId: c.id, cycleNo: c.cycleNo, event, duration: eventDuration(event), index });
    });
  }
  rows.sort(
    (a, b) =>
      desc(a.event.date, b.event.date) ||
      desc(a.event.at, b.event.at) ||
      desc(a.cycleNo, b.cycleNo) ||
      desc(a.cycleId, b.cycleId) ||
      desc(a.index, b.index),
  );
  return rows.map(({ index: _index, ...row }) => row);
}

// ===========================================================================
// 오늘 상태 (§19-2) — "휴식은 달력이 채우고, 운동은 기록이 채운다"
// ===========================================================================

/** 하루의 판정(일정 필드 없이) — todayStatus·upcoming·decideLog의 공통 핵심 */
type DayCore =
  | { kind: "not_started"; daysUntil: number }
  | { kind: "workout"; day: number; targetDay: number; retestHint: boolean }
  | { kind: "rest"; day: number; cycleEnd: boolean; index: number; of: number }
  | { kind: "recovery"; pendingDay: number; resumeTargetDay: number }
  | { kind: "recorded_today"; outcome: RecordedOutcome; day: number; targetDay: number }
  | { kind: "retest" };

type Slot = { kind: "rest"; day: number; cycleEnd: boolean; index: number; of: number } | { kind: "recovery" };

/** 사건 하나의 결과 — 오늘 상태(recorded_today)와 스트릭 라벨(§17-7)이 같이 쓴다(규칙 한 곳) */
function eventOutcome(e: WorkoutEvent): RecordedOutcome {
  return e.kind === "fail" ? "fail" : e.targetDay !== e.day ? "repeat_complete" : "complete";
}

/** 마지막 사건 L 다음부터 달력이 채울 휴식 슬롯 */
function slotsAfter(last: WorkoutEvent, s: ReplayState): Slot[] {
  if (last.kind === "fail") return [{ kind: "recovery" }]; // 회복 휴식 1일
  if (last.targetDay !== last.day) return []; // 재부여 성공 — 회복 휴식을 이미 했다(계획 휴식 재삽입 없음)
  const days = restDaysBetween(last.day, s.nextDay); // Day 5 뒤 [6], Day 23 뒤 [24,25,26]
  return days.map((day, i): Slot => ({ kind: "rest", day, cycleEnd: day > LAST_WORKOUT_DAY, index: i + 1, of: days.length }));
}

function resolveDay(startDate: string, allEvents: readonly WorkoutEvent[], date: string): DayCore {
  // 깨진 사건은 없는 것으로 본다(정규화와 같은 규칙) — 날짜가 깨진 마지막 사건을 "오늘 기록"으로도 "아주 오래전"으로도 치지 않는다.
  // 그래서 gap은 항상 마지막 **유효** 사건일에서 잰다(같은 날 두 번째 기록을 막는 불변식이 깨진 사건 하나로 뚫리지 않는다).
  const events = allEvents.filter(isUsableEvent);
  if (events.length === 0) {
    const daysUntil = diffDateStrings(date, startDate);
    // NaN(시작일·오늘을 모름 — 정규화된 레코드에선 생기지 않는다)은 "시작 전"이 아니다 → Day 1. 사건이 없어 어길 순서 불변식도 없다.
    if (daysUntil > 0) return { kind: "not_started", daysUntil };
    return { kind: "workout", day: 1, targetDay: 1, retestHint: false };
  }
  const s = replay(events);
  const last = events[events.length - 1];
  const gap = diffDateStrings(last.date, date);
  // `!(gap > 0)` = gap ≤ 0 **또는 NaN**. 날짜 차를 모르면 "gap ≥ 1"을 증명할 수 없고, 스펙은 "workout은 gap ≥ 1에서만 나온다"(§19-2)
  // — 그래서 새 기록을 받지 않는 기록함으로 본다. (읽기 함수는 readToday가 형식 밖 오늘을 먼저 대체하고, 판정 함수는
  // assertDateString이 먼저 던지므로 여기 NaN은 방어선일 뿐이다.)
  if (!(gap > 0)) {
    return { kind: "recorded_today", outcome: eventOutcome(last), day: last.day, targetDay: last.targetDay };
  }
  const slots = slotsAfter(last, s);
  if (gap <= slots.length) {
    const slot = slots[gap - 1];
    if (slot.kind === "recovery") return { kind: "recovery", pendingDay: s.nextDay, resumeTargetDay: s.repeatOf ?? s.nextDay };
    return slot;
  }
  if (s.nextDay >= RETEST_DAY) return { kind: "retest" };
  return { kind: "workout", day: s.nextDay, targetDay: s.repeatOf ?? s.nextDay, retestHint: s.failsAtNextDay >= 2 };
}

/**
 * 읽기 함수(todayStatus·upcoming·snapshot)의 "오늘". 서버는 kstTodayString()만 넘기므로 형식 밖 오늘은 호출측 버그지만,
 * 읽기는 던지지 않는다(페이지 500 방지). 대신 **달력이 흐르지 않은 것으로** 본다 — 마지막 유효 사건일(없으면 시작일)에 멈춘다.
 * 그러면 사건이 있으면 기록함(새 기록 없음, 내일 미리보기는 그 사건 다음 날 기준), 없으면 Day 1이다.
 * 휴식 슬롯을 지난 것으로 치거나 운동을 새로 열지 않는 가장 보수적인 해석이다. 판정 함수(decide*)는 이 대체를 쓰지 않고 RangeError.
 */
function readToday(cycle: WorkoutCycleLike, todayKst: string): string {
  if (isDateString(todayKst)) return todayKst;
  const events = cycle.events.filter(isUsableEvent);
  return events.length > 0 ? events[events.length - 1].date : cycle.startDate;
}

/** 가상의 성공 사건 — upcoming 시뮬레이션 전용(볼륨은 쓰지 않는다) */
function virtualSuccess(date: string, day: number, targetDay: number): WorkoutEvent {
  const zeros = () => Array.from({ length: SETS_PER_EXERCISE }, () => 0);
  return { date, at: "", kind: "complete", day, targetDay, failed: null, reps: { pullup: zeros(), pushup: zeros() }, durationSec: null };
}

/**
 * 앞으로의 일정 — 내일부터 n칸. 오늘부터 하루씩, 운동일이면 **가상의 성공 사건을 덧붙여** 상태를 되풀이한다.
 * 오늘이 운동일이면 오늘 성공을 가정한다. 시작 전 날짜는 건너뛴다(각 칸의 date로 간격이 드러난다).
 * 예: 실패 당일 → [회복, 재부여 운동(X, X−1), 운동(X, X)].
 * 형식 밖 오늘은 readToday로 대체하고, 그래도 날짜가 없으면(시작일까지 깨짐) 달력을 셀 수 없으니 [].
 */
export function upcoming(cycle: WorkoutCycleLike, rawTodayKst: string, n: number): UpcomingEntry[] {
  const out: UpcomingEntry[] = [];
  if (!(n > 0)) return out;
  const todayKst = readToday(cycle, rawTodayKst);
  if (!isDateString(todayKst)) return out;
  const events = [...cycle.events];
  const today = resolveDay(cycle.startDate, events, todayKst);
  if (today.kind === "workout") events.push(virtualSuccess(todayKst, today.day, today.targetDay));

  // i는 오늘로부터의 일수. 시작 전이면 시작일로 건너뛴다. iter는 무한 루프 방어(미래 날짜 사건 등 비정상 데이터).
  for (let i = 1, iter = 0; out.length < n && iter < n + 400; i++, iter++) {
    const date = shiftDateString(todayKst, i);
    const core = resolveDay(cycle.startDate, events, date);
    switch (core.kind) {
      case "not_started":
        i += core.daysUntil - 1;
        continue;
      case "recorded_today":
        continue; // 미래 날짜 사건(시계 어긋남) — 지나간다
      case "workout":
        events.push(virtualSuccess(date, core.day, core.targetDay));
        out.push({ date, item: { kind: "workout", day: core.day, targetDay: core.targetDay } });
        break;
      case "rest":
        out.push({ date, item: { kind: "rest", day: core.day, cycleEnd: core.cycleEnd, index: core.index, of: core.of } });
        break;
      case "recovery":
        out.push({ date, item: { kind: "recovery", pendingDay: core.pendingDay } });
        break;
      case "retest":
        out.push({ date, item: { kind: "retest" } });
        break;
    }
  }
  return out;
}

/** 내일 일정 — 사건이 있는 상태에서만 부른다(그땐 항상 한 칸이 나온다) */
function tomorrowOf(cycle: WorkoutCycleLike, todayKst: string): Upcoming {
  return upcoming(cycle, todayKst, 1)[0]?.item ?? { kind: "retest" };
}

/**
 * 오늘 상태 — 마지막 사건 L(날짜 dL) 다음부터 휴식 슬롯이 달력 하루씩 차지하고,
 * `gap = diffDateStrings(dL, today)`가 ≤0이면 기록함, 슬롯 수 이하면 휴식/회복, 넘으면 운동(또는 재측정).
 * 운동일은 기다리고(벌칙 없음), 휴식일은 기다리지 않는다. 형식 밖 오늘은 readToday(달력이 멈춘 것으로) — 던지지 않는다.
 */
export function todayStatus(cycle: WorkoutCycleLike, rawTodayKst: string): TodayStatus {
  const todayKst = readToday(cycle, rawTodayKst);
  const core = resolveDay(cycle.startDate, cycle.events, todayKst);
  switch (core.kind) {
    case "not_started":
      return { kind: "not_started", startDate: cycle.startDate, daysUntil: core.daysUntil, displayDay: 1 };
    case "workout": {
      const target = targetFor(cycle.base, core.targetDay);
      return {
        kind: "workout",
        day: core.day,
        targetDay: core.targetDay,
        isRepeat: core.targetDay !== core.day,
        target,
        totals: setTotals(target),
        retestHint: core.retestHint,
        displayDay: core.day,
      };
    }
    case "rest":
      return {
        kind: "rest",
        day: core.day,
        cycleEnd: core.cycleEnd,
        index: core.index,
        of: core.of,
        next: tomorrowOf(cycle, todayKst),
        displayDay: core.day,
      };
    case "recovery":
      return {
        kind: "recovery",
        pendingDay: core.pendingDay,
        resumeTargetDay: core.resumeTargetDay,
        next: tomorrowOf(cycle, todayKst),
        displayDay: core.pendingDay,
      };
    case "recorded_today":
      return {
        kind: "recorded_today",
        outcome: core.outcome,
        day: core.day,
        targetDay: core.targetDay,
        tomorrow: tomorrowOf(cycle, todayKst),
        displayDay: core.day,
      };
    case "retest":
      return { kind: "retest", displayDay: RETEST_DAY };
  }
}

/** 화면 한 번에 필요한 것 전부 — 오늘 상태·계획표(✓·✗·▶)·진행률·볼륨·rev·앞으로 3일 */
export function snapshot(cycle: WorkoutCycleRecord, todayKst: string): CycleSnapshot {
  const s = replay(cycle.events);
  const today = todayStatus(cycle, todayKst);
  const done = new Set(s.completedDays);
  const currentDay = today.kind === "not_started" ? null : today.displayDay;
  const plan: CyclePlanRow[] = buildPlan(cycle.base).map((row) => ({
    ...row,
    completed: done.has(row.day),
    fails: s.failsByDay[row.day] ?? 0,
    current: row.day === currentDay,
  }));
  const doneCount = s.completedDays.length;
  return {
    cycleId: cycle.id,
    cycleNo: cycle.cycleNo,
    startDate: cycle.startDate,
    rm: { pullup: cycle.rm.pullup, pushup: cycle.rm.pushup },
    status: cycle.status,
    rev: cycle.rev,
    eventCount: cycle.events.length,
    lastEvent: cycle.events.length > 0 ? cycle.events[cycle.events.length - 1] : null,
    lastEventDuration: cycle.events.length > 0 ? eventDuration(cycle.events[cycle.events.length - 1]) : null,
    duration: cycleDuration(cycle),
    today,
    plan,
    progress: { done: doneCount, total: TOTAL_WORKOUT_DAYS, pct: Math.round((doneCount / TOTAL_WORKOUT_DAYS) * 100) },
    volume: s.volume,
    failCount: s.failCount,
    upcoming: upcoming(cycle, todayKst, SNAPSHOT_UPCOMING_DAYS),
  };
}

// ===========================================================================
// 사이클 전환 (§19-3)
// ===========================================================================

/** 닫는 사이클의 상태 — 사건 재생으로 판정: 20개 운동일을 다 마쳤으면 completed(재측정 화면이 아닌 곳에서 닫아도) */
export function closingStatus(cycle: Pick<WorkoutCycleRecord, "events">): ClosedCycleStatus {
  return replay(cycle.events).nextDay === RETEST_DAY ? "completed" : "abandoned";
}

const createdAtMs = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};
const desc = (x: number | string, y: number | string) => (x > y ? -1 : x < y ? 1 : 0);
/** 최신 먼저 — createdAt(시각) → createdAt(문자열) → id. 입력 순서와 무관하게 결정적 */
function compareNewest(a: Pick<WorkoutCycleRecord, "id" | "createdAt">, b: Pick<WorkoutCycleRecord, "id" | "createdAt">): number {
  return desc(createdAtMs(a.createdAt), createdAtMs(b.createdAt)) || desc(a.createdAt, b.createdAt) || desc(a.id, b.id);
}

/**
 * 활성 사이클 하나를 결정적으로 고른다 — 여러 개 보이면(레거시·사고) createdAt이 가장 늦은 것.
 * 한 곳에만 정의 — 페이지·두 스토어 백엔드가 같이 쓴다(§19-3).
 */
export function pickActiveWorkoutCycle<T extends Pick<WorkoutCycleRecord, "id" | "createdAt" | "status">>(cycles: readonly T[]): T | null {
  const actives = cycles.filter((c) => c.status === "active");
  if (actives.length === 0) return null;
  return [...actives].sort(compareNewest)[0];
}

/** 지난(닫힌) 사이클 목록 — cycleNo 내림차순, RM 변화는 cycleNo 순 다음 사이클의 rm에서 파생 */
export function workoutHistory(cycles: readonly WorkoutCycleRecord[]): WorkoutHistoryRow[] {
  const byNo = [...cycles].sort((a, b) => a.cycleNo - b.cycleNo || -compareNewest(a, b));
  const rows: WorkoutHistoryRow[] = [];
  byNo.forEach((c, i) => {
    if (c.status === "active") return;
    const next = byNo[i + 1] ?? null;
    const s = replay(c.events);
    rows.push({
      id: c.id,
      cycleNo: c.cycleNo,
      startDate: c.startDate,
      createdAt: c.createdAt,
      endedAt: c.endedAt,
      status: c.status,
      rm: { pullup: c.rm.pullup, pushup: c.rm.pushup },
      nextRm: next ? { pullup: next.rm.pullup, pushup: next.rm.pushup } : null,
      done: s.completedDays.length,
      failCount: s.failCount,
      volume: s.volume,
      duration: cycleDuration(c),
    });
  });
  return rows.reverse();
}

// ===========================================================================
// 상단 스트릭 — 루틴을 지킨 날 (§17-7). 운동에는 계획된 휴식이 있어 "운동한 날"만 세면 6일마다 끊긴다.
// 휴식 슬롯은 사건 재생 규칙(replay·slotsAfter)이 정한 것 **그대로** 쓴다 — 스트릭이 휴식 규칙을 따로 구현하지 않는다.
// ===========================================================================

/** 그날이 "지킨 날"인 이유 — 사건(운동·실패) / 엔진이 정한 휴식 슬롯 / 재측정 끝냄 */
type KeptReason = { kind: "event"; event: WorkoutEvent } | { kind: "slot"; slot: Slot } | { kind: "retest_done" };

/** 닫힌 사이클이 닫힌 KST 일자 — 활성이거나 endedAt이 ISO가 아니면 null(자르지 않는다) */
function closedDayOf(cycle: Pick<WorkoutCycleRecord, "status" | "endedAt">): string | null {
  if (cycle.status === "active" || !isZonedIsoTimestamp(cycle.endedAt)) return null;
  const day = kstDateString(cycle.endedAt);
  return isDateString(day) ? day : null;
}

/**
 * 한 사이클에서 루틴을 지킨 날 → 이유. **오늘(todayKst, 유효한 날짜) 뒤는 넣지 않는다.**
 * - 사건일: 쓸 수 있는 사건(깨진 사건은 정규화와 같은 기준으로 없는 것으로 본다)의 date. 오늘 뒤 사건(시계 어긋남)은 아직 오지 않은 날이다.
 * - 휴식 슬롯: 사건 i 뒤의 slotsAfter(사건 i, replay(사건 0..i)) — 오늘 상태가 "그 사건이 마지막일 때" 보이는 슬롯과 같다.
 *   다음 사건 전날·사이클이 닫힌 날·오늘 중 가장 이른 날에서 자른다(그날까지 포함).
 * - 재측정 끝낸 날: **사건이 있는** 사이클이 닫힌 endedAt KST 일자 — completed(Day 27)든 abandoned(도중 재측정)든.
 *   재측정 안내(retestHint)를 따라 운동일에 RM을 다시 잰 날이 "건너뛴 날"로 스트릭을 끊으면 안 된다(§17-7).
 *   사건 0개로 닫힌 사이클(레거시 다중 활성 정리)은 루틴 밖이라 세지 않는다.
 * 한 날에 이유가 겹치면 사건 > 재측정 끝냄 > 슬롯(라벨이 가장 구체적인 것을 보이게).
 */
function keptDaysOfCycle(cycle: WorkoutCycleRecord, todayKst: string): Map<string, KeptReason> {
  const out = new Map<string, KeptReason>();
  const events = cycle.events.filter(isUsableEvent);
  const closedDay = closedDayOf(cycle);
  events.forEach((e, i) => {
    if (e.date > todayKst) return; // 오늘 뒤 — 그 슬롯도 전부 오늘 뒤다
    out.set(e.date, { kind: "event", event: e });
    let cut = todayKst;
    const next = events[i + 1];
    if (next) {
      const eve = shiftDateString(next.date, -1);
      if (eve < cut) cut = eve;
    }
    if (closedDay !== null && closedDay < cut) cut = closedDay;
    // O(사건²)이지만 사이클당 사건은 수십 건이다 — 재생 규칙을 새로 짜지 않고 그대로 부르는 쪽을 택한다
    slotsAfter(e, replay(events.slice(0, i + 1))).forEach((slot, k) => {
      const d = shiftDateString(e.date, k + 1);
      if (d <= cut && !out.has(d)) out.set(d, { kind: "slot", slot });
    });
  });
  if (events.length > 0 && closedDay !== null && closedDay <= todayKst && out.get(closedDay)?.kind !== "event") {
    out.set(closedDay, { kind: "retest_done" });
  }
  return out;
}

/**
 * 상단 스트릭 운동 트랙의 "지킨 날" — 모든 사이클(중단 포함)의 날을 합집합으로 접어 정렬·중복 없이 낸다(§17-7).
 * 연속 판정은 lib/streak의 computeStreakFromDays(시험 스트릭과 같은 함수)가 한다. 오늘이 휴식 슬롯이면 오늘도 들어간다(doneToday).
 * 읽기 함수라 던지지 않는다 — 형식 밖 오늘이면 [](달력을 모르면 아무 날도 증명할 수 없다).
 */
export function workoutKeptDays(cycles: readonly WorkoutCycleRecord[], todayKst: string): string[] {
  if (!isDateString(todayKst)) return [];
  const days = new Set<string>();
  for (const c of cycles) for (const d of keptDaysOfCycle(c, todayKst).keys()) days.add(d);
  return [...days].sort(); // YYYY-MM-DD는 사전순 = 시간순
}

function keptReasonLabel(r: KeptReason): string {
  switch (r.kind) {
    case "event": {
      const e = r.event;
      const outcome = eventOutcome(e);
      if (outcome === "fail") return `Day ${e.day} ✗`;
      if (outcome === "repeat_complete") return `Day ${e.targetDay} 목표 ✓`;
      return `Day ${e.day} ✓`;
    }
    case "slot":
      if (r.slot.kind === "recovery") return "회복 휴식";
      return r.slot.cycleEnd ? `마무리 휴식 ${r.slot.index}/${r.slot.of}` : "휴식";
    case "retest_done":
      return "재측정 ✓";
  }
}

/**
 * 헤드라인 운동 트랙의 짧은 라벨(§17-7) — 오늘이 지킨 날일 때만, 아니면 null.
 * 기록함 `Day 7 ✓` / 재부여 성공 `Day 5 목표 ✓` / 실패 `Day 7 ✗` / `휴식` / `회복 휴식` / `마무리 휴식 2/3` / `재측정 ✓`.
 * 활성 사이클 기준이되, 오늘 사건·슬롯이 닫힌 사이클에만 있으면(오늘 재측정·도중 재측정) 그 사이클 기준 — 닫힌 것끼리는 최신 먼저.
 * workoutKeptDays와 같은 계산(keptDaysOfCycle)에서 나오므로 "라벨이 있다 ⇔ 오늘이 지킨 날"이다. 던지지 않는다.
 */
export function workoutStreakTodayLabel(cycles: readonly WorkoutCycleRecord[], todayKst: string): string | null {
  if (!isDateString(todayKst)) return null;
  const active = pickActiveWorkoutCycle(cycles);
  const ordered = [...(active ? [active] : []), ...cycles.filter((c) => c !== active).sort(compareNewest)];
  for (const c of ordered) {
    const reason = keptDaysOfCycle(c, todayKst).get(todayKst);
    if (reason) return keptReasonLabel(reason);
  }
  return null;
}

// ===========================================================================
// 판정 함수 (§19-4) — 스토어가 원자 단위(file: mutate 콜백 / Firestore: runTransaction) 안에서 부른다
// ===========================================================================

/**
 * 기록 판정 — 서버는 **자기가 계산한 값으로** 사건을 만든다. 요청의 day·targetDay는 "화면이 낡지 않았다"를 확인하는 데만 쓴다.
 * 순서: 닫힌 사이클 → not_active, rev 불일치 → conflict, 오늘 상태가 workout이 아니거나 day·targetDay가 다르면 → stale_state.
 * 입력 형태(kind·failed·날짜)가 어긋나면 RangeError(라우트 zod가 보장하므로 프로그래밍 오류). complete의 failed는 무시하고 null로 쓴다.
 * 예외 하나 — `durationSec`(§19-8)는 서버가 알 수 없는 클라이언트 보고값이라 그대로 싣되, 정수 0..WORKOUT_DURATION_MAX_SEC가 아니면
 * **던지지도 거절하지도 않고** null로 싣는다(기록은 받는다). 원자 단위 밖에서 정해진 입력이라 트랜잭션 재시도에도 결정적이다.
 */
export function decideLog(cycle: WorkoutCycleRecord, input: DecideLogInput): DecideLogResult {
  assertDateString(input.todayKst, "todayKst");
  assertNonEmpty(input.nowIso, "nowIso");
  if (input.kind !== "complete" && input.kind !== "fail") throw new RangeError(`알 수 없는 기록 종류: ${String(input.kind)}`);
  const failed = input.kind === "fail" ? assertFailedAt(input.failed) : null;

  if (cycle.status !== "active") return { status: "not_active" };
  if (cycle.rev !== input.expectedRev) return { status: "conflict" };
  const core = resolveDay(cycle.startDate, cycle.events, input.todayKst);
  if (core.kind !== "workout" || core.day !== input.day || core.targetDay !== input.targetDay) return { status: "stale_state" };

  const target = targetFor(cycle.base, core.targetDay);
  const event: WorkoutEvent = {
    date: input.todayKst,
    at: input.nowIso,
    kind: input.kind,
    day: core.day,
    targetDay: core.targetDay,
    failed:
      failed === null
        ? null
        : {
            exercise: failed.exercise,
            setIndex: failed.setIndex,
            reps: typeof failed.reps === "number" && Number.isFinite(failed.reps) ? clampReps(failed.reps, target[failed.exercise][failed.setIndex]) : null,
          },
    reps: repsForEvent(target, input.kind, failed),
    // 클라이언트 보고값 — 형식·범위(정수 0..WORKOUT_DURATION_MAX_SEC)만 본다. 밖이면 기록은 받고 소요시간만 null(§19-8)
    durationSec: isValidDurationSec(input.durationSec) ? input.durationSec : null,
  };
  const next = recordOf(cycle, { rev: cycle.rev + 1, events: [...cycle.events, event] });
  return { status: "ok", next, event };
}

/** 마지막 기록 취소 판정 — 닫힌 사이클 → not_active, rev 불일치(ABA 포함) → conflict, 사건 0개 → empty */
export function decideUndo(cycle: WorkoutCycleRecord, input: DecideUndoInput): DecideUndoResult {
  if (cycle.status !== "active") return { status: "not_active" };
  if (cycle.rev !== input.expectedRev) return { status: "conflict" };
  if (cycle.events.length === 0) return { status: "empty" };
  const removed = cycle.events[cycle.events.length - 1];
  const next = recordOf(cycle, { rev: cycle.rev + 1, events: cycle.events.slice(0, -1) });
  return { status: "ok", next, removed };
}

/**
 * 사이클 시작 판정 — 활성(pickActiveWorkoutCycle)과 expectedActiveCycleId를 대조한다(연타·두 탭에서 두 번 만들어지지 않게).
 * - 활성 사건 0개 → 닫지 않고 제자리에서 rm·base·startDate 교체(replaced — id·cycleNo·createdAt 유지, rev+1).
 * - 그 밖 → 활성을 closingStatus로 닫고(endedAt=nowIso, rev+1) 새 사이클(cycleNo = 전체 max+1, rev 0) — created.
 * - 레거시로 활성이 여럿이면 나머지도 전부 닫는다(활성 최대 1개로 수렴).
 * 입력 형태(RM 1~150 정수, startDate = 오늘 또는 내일, newId)가 어긋나면 RangeError.
 */
export function decideStart(allCycles: readonly WorkoutCycleRecord[], input: DecideStartInput, newId: string): DecideStartResult {
  assertDateString(input.todayKst, "todayKst");
  assertDateString(input.startDate, "startDate");
  assertNonEmpty(input.nowIso, "nowIso");
  assertNonEmpty(newId, "newId");
  const lead = diffDateStrings(input.todayKst, input.startDate);
  if (lead !== 0 && lead !== 1) throw new RangeError(`시작일은 오늘 또는 내일이어야 한다: ${input.startDate}`);
  const rm: WorkoutRm = { pullup: input.rm.pullup, pushup: input.rm.pushup };
  const base = makeBase(rm); // 유효하지 않은 RM이면 여기서 RangeError

  const active = pickActiveWorkoutCycle(allCycles);
  const activeId = active?.id ?? null;
  if (activeId !== input.expectedActiveCycleId) return { status: "conflict", activeCycleId: activeId };

  const close = (c: WorkoutCycleRecord) => recordOf(c, { status: closingStatus(c), endedAt: input.nowIso, rev: c.rev + 1 });
  const others = allCycles.filter((c) => c.status === "active" && c.id !== activeId).sort(compareNewest);
  const closedOthers = others.map(close);

  if (active && active.events.length === 0) {
    const record = recordOf(active, { rm, base, startDate: input.startDate, rev: active.rev + 1 });
    return {
      status: "ok",
      mode: "replaced",
      record,
      writes: [...closedOthers, record],
      closed: null,
      closedHadEvents: others.some((c) => c.events.length > 0),
    };
  }

  const closedActive = active ? close(active) : null;
  const cycleNo = allCycles.reduce((m, c) => Math.max(m, Number.isFinite(c.cycleNo) ? c.cycleNo : 0), 0) + 1;
  const record: WorkoutCycleRecord = {
    id: newId,
    createdAt: input.nowIso,
    cycleNo,
    startDate: input.startDate,
    rm,
    base,
    status: "active",
    endedAt: null,
    rev: 0,
    events: [],
  };
  return {
    status: "ok",
    mode: "created",
    record,
    writes: [...(closedActive ? [closedActive] : []), ...closedOthers, record],
    closed: active && closedActive ? { id: active.id, status: closingStatus(active) } : null,
    closedHadEvents: (active ? [active, ...others] : others).some((c) => c.events.length > 0),
  };
}

// ===========================================================================
// 정규화 — 두 스토어 백엔드 공유 (normalizeJaDialogRecord 관용구)
// Firestore는 undefined를 거부하므로 failed·endedAt은 반드시 null로, 숫자·배열은 방어한다.
// ===========================================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** 5칸 횟수 배열 — 음수·비숫자 → 0, 모자라면 0으로 채운다 */
function repsArray(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  return Array.from({ length: SETS_PER_EXERCISE }, (_, i) => {
    const x: unknown = arr[i];
    return typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0;
  });
}

function normalizeSetPair(v: unknown): SetPair {
  const o = isObj(v) ? v : {};
  return { pullup: repsArray(o.pullup), pushup: repsArray(o.pushup) };
}

/** 저장된 base가 온전한가 — 운동마다 1 이상 정수 5개 */
function isIntactBase(v: unknown): boolean {
  if (!isObj(v)) return false;
  const ok = (a: unknown) =>
    Array.isArray(a) && a.length === SETS_PER_EXERCISE && a.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 1);
  return ok(v.pullup) && ok(v.pushup);
}

function normalizeFailedAt(v: unknown): FailedAt | null {
  if (!isObj(v)) return null;
  const exercise: WorkoutExercise | null = v.exercise === "pullup" ? "pullup" : v.exercise === "pushup" ? "pushup" : null;
  if (exercise === null) return null;
  const setIndex = Math.min(SETS_PER_EXERCISE - 1, Math.max(0, intOr(v.setIndex, 0)));
  const reps = typeof v.reps === "number" && Number.isFinite(v.reps) ? Math.max(0, Math.trunc(v.reps)) : null;
  return { exercise, setIndex, reps };
}

/** Day 번호 — 정수가 아니면(없음·소수·문자열) 0 = 알 수 없음. 0은 운동일이 아니라 normalizeWorkoutCycle이 그 사건을 버린다 */
function dayOrUnknown(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}

/**
 * 저장·읽기 경계의 사건 방어 — undefined → null, complete의 failed는 null, reps는 5칸. 던지지 않는다.
 * 모르는 Day는 **추측하지 않는다**: day·targetDay가 없거나 정수가 아니면 0, date가 문자열이 아니면 ""(둘 다 깨진 표시 —
 * 사이클 정규화가 버린다). 예전 기본값 day 1은 끝 사건이면 사이클을 Day 2로 되감았고, 2.5는 2로 잘렸다.
 */
export function normalizeWorkoutEvent(raw: unknown): WorkoutEvent {
  const e = isObj(raw) ? raw : {};
  const kind: WorkoutEventKind = e.kind === "fail" ? "fail" : "complete";
  return {
    date: typeof e.date === "string" ? e.date : "",
    at: typeof e.at === "string" ? e.at : "",
    kind,
    day: dayOrUnknown(e.day),
    targetDay: dayOrUnknown(e.targetDay),
    failed: kind === "fail" ? normalizeFailedAt(e.failed) : null,
    reps: normalizeSetPair(e.reps),
    // ⚠️ 새 필드는 여기에도 넣어야 한다 — 두 스토어가 쓰기 직전에 이 함수를 태우므로 빠뜨리면 값이 조용히 지워진다(§19-8).
    // 옛 사건(필드 없음)·범위 밖은 null(Firestore는 undefined를 거부한다). 소수는 추측하지 않고 null — 판정과 같은 검사.
    durationSec: isValidDurationSec(e.durationSec) ? e.durationSec : null,
  };
}

/** 사건 배열 정규화 — 깨진 사건(brokenEventReason)은 버리고 console.warn(조용히 사라지지 않게 — 로그로 추적) */
function normalizeEvents(v: unknown, cycleId: string): WorkoutEvent[] {
  if (!Array.isArray(v)) return [];
  const out: WorkoutEvent[] = [];
  v.forEach((raw: unknown, i) => {
    const e = normalizeWorkoutEvent(raw);
    const reason = brokenEventReason(e);
    if (reason !== null) {
      console.warn(`[workout] 깨진 사건을 버린다 — 사이클 ${cycleId || "(id 없음)"} #${i}: ${reason}`);
      return;
    }
    out.push(e);
  });
  return out;
}

function rmOr(v: unknown, fallback: number): number {
  if (isValidRm(v)) return v;
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(RM_MAX, Math.max(RM_MIN, Math.trunc(v)));
  return fallback;
}

/**
 * 저장·읽기 경계의 사이클 방어 — undefined → null·기본값, 여분 속성은 떨군다. **던지지 않고, 결과로 snapshot도 던지지 않는다.**
 * - Firestore Timestamp 같은 비문자열 createdAt은 호출측이 ISO로 바꿔 넘긴다(toIso). 그래도 ISO(isZonedIsoTimestamp)가 아니면 epoch ISO.
 * - startDate가 달력에 있는 YYYY-MM-DD가 아니면 createdAt의 KST 일자.
 * - base가 깨졌으면 rm으로 재계산, 알 수 없는 status는 "abandoned"(깨진 레코드가 활성을 가로채지 않게).
 * - 깨진 사건(운동일 아닌 day·targetDay, 달력 밖 date)은 버리고 console.warn — 예전엔 Day 6 사건 하나로 /workout이 500이 됐다.
 * ⚠️ 두 스토어는 **쓰기 경계에서도** 이 함수를 태운다 — 깨진 사건이 든 사이클에 기록·취소하면 버린 결과가 저장된다.
 */
export function normalizeWorkoutCycle(raw: unknown): WorkoutCycleRecord {
  const d = isObj(raw) ? raw : {};
  const id = typeof d.id === "string" ? d.id : "";
  const rmRaw = isObj(d.rm) ? d.rm : {};
  const rm: WorkoutRm = { pullup: rmOr(rmRaw.pullup, DEFAULT_RM.pullup), pushup: rmOr(rmRaw.pushup, DEFAULT_RM.pushup) };
  const createdAt = isZonedIsoTimestamp(d.createdAt) ? d.createdAt : EPOCH_ISO;
  const status: WorkoutCycleStatus = d.status === "active" || d.status === "completed" || d.status === "abandoned" ? d.status : "abandoned";
  return {
    id,
    createdAt,
    cycleNo: Math.max(1, intOr(d.cycleNo, 1)),
    startDate: isDateString(d.startDate) ? d.startDate : kstDateString(createdAt),
    rm,
    base: isIntactBase(d.base) ? normalizeSetPair(d.base) : makeBase(rm),
    status,
    endedAt: typeof d.endedAt === "string" ? d.endedAt : null,
    rev: Math.max(0, intOr(d.rev, 0)),
    events: normalizeEvents(d.events, id),
  };
}

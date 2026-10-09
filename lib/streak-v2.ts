/**
 * lib/streak-v2.ts — 스트릭 v2 순수 코어(가족 스트릭 강화 스펙 §4). AI·저장 없음, "오늘"은 인자.
 *
 * 입력은 날짜 단위다 — legacyDays(옛 규칙 "답한 문항 ≥ 1"로 켜진 날) + runs(새 규칙 "한 판"의 그날 개수).
 * STREAK_V2_FROM 이전 날짜는 legacy, 그날부터는 runs만 본다(소급 없음). 카드·만회도 from부터.
 * 카드가 먼저다 — 놓친 날 D(오늘 제외)에 그 달 카드가 남았으면 자동 사용, 바닥났을 때만 D+1 두 판 만회.
 */

import { diffDateStrings, shiftDateString } from "./kst";

/** 새 규칙 적용일(KST). 첫 배포일로 박는다 — 바꾸면 지난 판정이 바뀐다(배포 뒤 고정). */
export const STREAK_V2_FROM = "2026-10-10";
/**
 * 아빠 스트릭 하나로 — 이날(KST)부터 아빠의 하루는 📚 어학과 💪 운동을 **둘 다** 해야 켜진다(2026-10-09 사용자 결정, 옵션 1).
 * 이날 전(오늘 2026-10-09까지)은 옛 규칙(둘 중 하나) 그대로 — 지금 이어 온 연속이 그대로 넘어간다(소급 없음, STREAK_V2_FROM과 같은 원칙).
 * 배포 뒤 고정 — 바꾸면 지난 판정이 바뀐다. 조립은 lib/streak-v2-assemble.ts `appaPersonV2`.
 */
export const APPA_BOTH_FROM = "2026-10-10";
export const FREEZES_PER_MONTH = 2;
export const REPAIR_MIN_RUNS = 2;
export const STREAK_BADGES: readonly number[] = [7, 30, 100, 200, 365];

export interface DayRuns {
  legacyDays: ReadonlySet<string>;
  runs: ReadonlyMap<string, number>;
}

export interface Bridges {
  freezeDays: Set<string>;
  repairedDays: Set<string>;
  pendingRepairDay: string | null;
  freezeLeftThisMonth: number;
}

/** 켜진 날 — from 이전은 legacy, from부터는 한 판 ≥ 1 */
export function litDaysOf(input: DayRuns & { from: string }): Set<string> {
  const lit = new Set<string>();
  for (const d of input.legacyDays) if (d < input.from) lit.add(d);
  for (const [d, n] of input.runs) if (d >= input.from && n >= 1) lit.add(d);
  return lit;
}

const runsOn = (runs: ReadonlyMap<string, number>, d: string) => runs.get(d) ?? 0;

/** from부터 어제까지 날짜를 걸으며 카드·만회를 정한다(결정적). */
export function decideBridges(input: DayRuns & { from: string; today: string }): Bridges {
  const { from, today, runs } = input;
  const lit = litDaysOf(input);
  const freezeDays = new Set<string>();
  const repairedDays = new Set<string>();
  const used = new Map<string, number>(); // YYYY-MM → 쓴 장수
  let pendingRepairDay: string | null = null;
  // from 전날까지 이어지고 있었나(legacy 켜짐)
  let alive = lit.has(shiftDateString(from, -1));
  if (from <= today) {
    for (let d = from; d < today; d = shiftDateString(d, 1)) {
      if (lit.has(d)) {
        alive = true;
        continue;
      }
      if (!alive) continue;
      const month = d.slice(0, 7);
      const u = used.get(month) ?? 0;
      if (u < FREEZES_PER_MONTH) {
        used.set(month, u + 1);
        freezeDays.add(d);
        continue;
      }
      const next = shiftDateString(d, 1);
      if (runsOn(runs, next) >= REPAIR_MIN_RUNS) {
        repairedDays.add(d);
      } else if (next === today) {
        pendingRepairDay = d; // 오늘이 끝나기 전 — 대기
      } else {
        alive = false;
      }
    }
  }
  const thisMonth = today.slice(0, 7);
  return { freezeDays, repairedDays, pendingRepairDay, freezeLeftThisMonth: FREEZES_PER_MONTH - (used.get(thisMonth) ?? 0) };
}

export interface StreakV2Info {
  current: number;
  doneToday: boolean;
  lastDate: string | null;
  best: number;
  freezeDays: string[];
  repairedDays: string[];
  pendingRepairDay: string | null;
  freezeLeftThisMonth: number;
  /** 오늘 한 판 수(만회 안내용) */
  runsToday: number;
}

/** 연속 계산 — 켜진 날·만회 날은 +1, 카드 날·만회 대기 날은 잇기만 한다 */
export function streakFromStatus(input: { litDays: ReadonlySet<string>; bridges: Bridges; today: string; runsToday: number }): StreakV2Info {
  const { bridges, today } = input;
  const counted = new Set<string>(input.litDays);
  for (const d of bridges.repairedDays) counted.add(d);
  const bridge = new Set<string>(bridges.freezeDays);
  if (bridges.pendingRepairDay) bridge.add(bridges.pendingRepairDay);

  const sorted = [...counted].sort();
  const lastDate = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const doneToday = counted.has(today);

  // best — 정렬된 날 사이가 카드/대기 날로만 채워져 있으면 같은 구간
  let best = sorted.length > 0 ? 1 : 0;
  let run = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    let d = shiftDateString(sorted[i - 1], 1);
    while (d < sorted[i] && bridge.has(d)) d = shiftDateString(d, 1);
    run = d === sorted[i] ? run + 1 : 1;
    if (run > best) best = run;
  }

  // current — 오늘 켜졌으면 오늘부터, 아니면 어제부터 거꾸로(카드·대기는 건너뜀)
  let current = 0;
  let d = doneToday ? today : shiftDateString(today, -1);
  while (counted.has(d) || bridge.has(d)) {
    if (counted.has(d)) current += 1;
    d = shiftDateString(d, -1);
  }

  return {
    current,
    doneToday,
    lastDate,
    best: Math.max(best, current),
    freezeDays: [...bridges.freezeDays].sort(),
    repairedDays: [...bridges.repairedDays].sort(),
    pendingRepairDay: bridges.pendingRepairDay,
    freezeLeftThisMonth: bridges.freezeLeftThisMonth,
    runsToday: input.runsToday,
  };
}

export type WeekCell = "lit" | "freeze" | "repaired" | "pending" | "missed" | "future" | "none";

/** 오늘이 든 주의 월~일(KST) */
export function kstWeekDays(today: string): string[] {
  // 2026-10-12는 월요일 — 기준점과의 차이로 요일을 낸다(Date의 로컬 해석을 피한다)
  const dow = (((diffDateStrings("2026-10-12", today) % 7) + 7) % 7); // 0 = 월
  const monday = shiftDateString(today, -dow);
  return Array.from({ length: 7 }, (_, i) => shiftDateString(monday, i));
}

export function weekCells(input: { info: StreakV2Info; litDays: ReadonlySet<string>; weekDays: readonly string[]; today: string; startDay: string | null }): WeekCell[] {
  const { info } = input;
  const freeze = new Set(info.freezeDays);
  const repaired = new Set(info.repairedDays);
  return input.weekDays.map((d) => {
    if (input.startDay !== null && d < input.startDay) return "none";
    if (input.litDays.has(d)) return "lit";
    if (repaired.has(d)) return "repaired";
    if (freeze.has(d)) return "freeze";
    if (info.pendingRepairDay === d) return "pending";
    if (d >= input.today) return "future";
    return "missed";
  });
}

export function badgesOf(info: Pick<StreakV2Info, "best" | "current" | "doneToday">): { earned: number[]; reachedToday: number | null } {
  const earned = STREAK_BADGES.filter((n) => info.best >= n);
  const reachedToday = info.doneToday && STREAK_BADGES.includes(info.current) ? info.current : null;
  return { earned, reachedToday };
}

/**
 * 만회 대기인데 오늘 판이 아직 모자란가(가족 스트릭 강화 §4-3) — 헤드라인·보드·알림이 함께 쓰는 단일 판정.
 * 만회 대기(`pendingRepairDay`)는 decideBridges가 "어제를 놓쳤고 카드가 없다"일 때만 세운다(항상 어제다).
 * 한 판만 해도 doneToday는 켜지지만 두 판(REPAIR_MIN_RUNS) 전에는 자정에 어제가 끊긴다 — 그래서 "다 했다"로 보면 안 된다.
 * `runsToday`는 사람 단위 값을 넣어야 한다(아빠 = appaPersonV2의 판 수 — APPA_BOTH_FROM부터는 운동도 한 날의 어학 판 수, 트랙 값은 한 트랙만 센다).
 */
export function needsMoreToday(info: { pendingRepairDay?: string | null; runsToday?: number }): boolean {
  return info.pendingRepairDay != null && (info.runsToday ?? 0) < REPAIR_MIN_RUNS;
}

/** 만회 안내 문구 — 아직 한 판도 안 했으면 "두 판이면", 한 판 했으면 "한 판 더". 만회 대기가 아니거나 다 채웠으면 null */
export function repairHintText(info: { pendingRepairDay?: string | null; runsToday?: number }): string | null {
  if (!needsMoreToday(info)) return null;
  return (info.runsToday ?? 0) === 0 ? "오늘 두 판이면 어제 🔥가 돌아와요" : "한 판 더 하면 어제 🔥가 돌아와요";
}

/** 알림·콕 찌르기에서 "오늘 다 했다" — 켜졌고 만회 판이 모자라지 않을 때만 */
export function doneForPush(info: { doneToday: boolean; pendingRepairDay?: string | null; runsToday?: number }): boolean {
  return info.doneToday && !needsMoreToday(info);
}

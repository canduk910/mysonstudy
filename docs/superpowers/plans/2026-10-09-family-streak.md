# 가족 스트릭 강화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 은우·아빠·엄마 스트릭을 "한 판 끝내기" 규칙·가족 연속일·가족 보드·🧊 쉬는 날 카드·🔁 만회·배지·폰 알림으로 강화한다.

**Architecture:** 판정·카드·만회·배지·알림 결정은 전부 순수 모듈(`lib/streak-v2.ts`, `lib/streak-v2-sources.ts`, `lib/push-decide.ts`)에 두고 기존 학습 기록에서 파생한다(새 저장 없음). `/api/streak`가 이를 조립해 응답을 넓히고, 헤드라인·가족 보드가 읽는다. 알림만 새 저장(`pushSubscriptions`·`pushLog`)과 새 인프라(VAPID·Cloud Scheduler)를 쓴다.

**Tech Stack:** Next.js 16(App Router — `node_modules/next/dist/docs/` 먼저 읽기), TypeScript, tsx eval 스크립트(`npm run eval:streak`), Firestore/file 스토어(`lib/store.ts`), `web-push`(Task 7에서 추가).

**Spec:** `docs/superpowers/specs/2026-10-09-family-streak-design.md`

## Global Constraints

- 로컬 실행은 항상 `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= …` 형태(프로덕션 Firestore 사고 방지 — CLAUDE.md). eval은 `EVAL_OFFLINE_ONLY=1`까지.
- 작업 전 `shasum data/db.json`, 끝나면 대조(불변).
- **git push 금지**(main 푸시 = 프로덕션 배포). 커밋은 로컬만, 푸시는 사용자 승인 뒤 오케스트레이터.
- 적용일 `STREAK_V2_FROM` 이전 날짜는 옛 규칙 그대로(소급 금지). 카드·만회도 적용일부터.
- 🧊 카드 = 사람마다 KST 달력 달마다 2장, 이월 없음, 자동 사용, **카드가 먼저·만회는 카드가 바닥났을 때만**.
- 🔁 만회 = 놓친 날 D의 다음 날 D+1에 한 판 2개 이상, D+1 하루만.
- 배지 기준 = 7·30·100·200·365일.
- 자유대화 한 판 = 은우 발화 3회 이상(`TALK_STREAK_MIN_CHILD_TURNS = 3`).
- 알림: 사람당 하루 최대 3개(콕 찌르기 포함), 22:30 뒤·08:00 전 발송 없음, 켜지면 그날 남은 알림 없음, 콕 찌르기 받는 사람당 하루 2회.
- 기존 응답 필드(`eunwoo`·`appa`·`appaEnglish`·`appaWorkout`·`appaLanguage`)는 이름·의미 유지(호환).
- 화면 문구는 한국어, 은우 대상 문구는 1학년 눈높이.

## Review Focus

1. **적용일 당일·전날 경계** — 전날까지 "1문항"으로 이어 온 🔥가 적용일 당일에 끊기지 않아야 한다(전날 legacy 켜짐 → 적용일 alive 시작). Task 1에 테스트.
2. **월 경계에서 카드 이월** — 9월에 1장 남기고 10월 1일에 놓쳐도 10월 2장만 쓴다(이월 없음), 같은 달 3번째 놓침은 만회로만. Task 1에 테스트.
3. **오늘 아직인데 어제 놓침 + 카드 없음** — 오늘 화면이 0으로 보이면 안 되고 "만회 대기"로 살아 있어야 하며, 오늘 한 판 1개뿐이면 아직 대기, 2개가 되면 어제가 살아난다. Task 1에 테스트.
4. **그만두고 나간 시험·녹음 일부만 된 응시** — 옛 규칙에선 켜졌지만 적용일부터는 안 켜져야 한다. Task 2에 테스트.
5. **엄마 영역이 없을 때 가족 연속일** — `mom = null`이어도 가족 🔥가 은우·아빠 둘로 계산되고 0이 되지 않아야 한다. Task 3에 테스트.

---

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `lib/streak-v2.ts` | 순수 코어 — 카드·만회 결정(`decideBridges`), 연속 계산(`streakFromStatus`), 주간 칸, 배지 | 새로 |
| `lib/streak-v2-sources.ts` | 순수 — 기록 → "한 판" 판정·일자별 판 수(트랙별), 사람·가족 조립 | 새로 |
| `lib/review-schedule.ts` | `reviewFullDays` 추가(복습 한 판의 날) | 수정 |
| `lib/streak-contract.ts` | 응답 타입 확장(`StreakV2Info`·`family`·`week`·`badges`·`mom`) | 수정 |
| `app/api/streak/route.ts` | 조립 | 수정 |
| `components/streak-headline.tsx` | 👪 칸·오늘 아직 점 | 수정 |
| `components/streak-finish-hint.tsx` | "한 판을 끝내야 🔥가 켜져요" 한 줄 | 새로 |
| `app/family/page.tsx`, `components/family-board.tsx` | 가족 보드 | 새로 |
| `components/streak-celebrate.tsx` | 배지 축하(헤드라인 안) | 새로 |
| `lib/push-decide.ts` | 순수 — 알림 결정 | 새로 |
| `lib/push-contract.ts` | 구독·prefs 타입·검증 | 새로 |
| `lib/store.ts`, `lib/store-firestore.ts` | `pushSubscriptions`·`pushLog` | 수정 |
| `app/manifest.ts`, `public/sw.js` | PWA | 새로 |
| `app/api/push/{subscribe,tick,poke}/route.ts` | 알림 라우트 | 새로 |
| `components/push-settings.tsx`, `app/family/settings/page.tsx` | "나는 누구"·알림 켜기·시각 | 새로 |
| `proxy.ts` | `/api/push/tick` 공개 경로(라우트가 비밀 검사) | 수정 |
| `scripts/eval-streak.ts` | 새 묶음 10~14 | 수정 |
| `docs/SPEC.md` §17-11, `CLAUDE.md` 변경 이력 | 문서 | 수정 |

---

### Task 1: 순수 코어 `lib/streak-v2.ts` — 카드·만회·연속·주간·배지

**Files:**
- Create: `lib/streak-v2.ts`
- Modify: `scripts/eval-streak.ts` (끝의 `printTable(results);` 바로 앞에 묶음 11 추가, import 한 줄)

**Interfaces:**
- Consumes: `shiftDateString(date, delta)`, `diffDateStrings(from, to)` from `lib/kst.ts`; `computeStreakFromDays` 규칙(같은 날 접기·듀오링고 anchor)과 같은 의미
- Produces:
  ```ts
  export const STREAK_V2_FROM: string;              // KST YYYY-MM-DD
  export const FREEZES_PER_MONTH = 2;
  export const REPAIR_MIN_RUNS = 2;
  export const STREAK_BADGES: readonly number[];    // [7,30,100,200,365]
  export interface DayRuns { legacyDays: ReadonlySet<string>; runs: ReadonlyMap<string, number> }
  export interface Bridges { freezeDays: Set<string>; repairedDays: Set<string>; pendingRepairDay: string | null; freezeLeftThisMonth: number }
  export function litDaysOf(input: DayRuns & { from: string }): Set<string>;
  export function decideBridges(input: DayRuns & { from: string; today: string }): Bridges;
  export interface StreakV2Info { current: number; doneToday: boolean; lastDate: string | null; best: number; freezeDays: string[]; repairedDays: string[]; pendingRepairDay: string | null; freezeLeftThisMonth: number; runsToday: number }
  export function streakFromStatus(input: { litDays: ReadonlySet<string>; bridges: Bridges; today: string; runsToday: number }): StreakV2Info;
  export type WeekCell = "lit" | "freeze" | "repaired" | "pending" | "missed" | "future" | "none";
  export function weekCells(input: { info: StreakV2Info; litDays: ReadonlySet<string>; weekDays: readonly string[]; today: string; startDay: string | null }): WeekCell[];
  export function kstWeekDays(today: string): string[]; // 월~일 7개
  export function badgesOf(info: Pick<StreakV2Info, "best" | "current" | "doneToday">): { earned: number[]; reachedToday: number | null };
  ```

- [ ] **Step 1: 실패하는 eval 묶음을 쓴다**

`scripts/eval-streak.ts` import 줄 아래에 추가:
```ts
import { FREEZES_PER_MONTH, STREAK_BADGES, badgesOf, decideBridges, kstWeekDays, litDaysOf, streakFromStatus, weekCells } from "../lib/streak-v2";
```
`printTable(results);` 바로 앞에 추가:
```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run -s eval:streak`
Expected: 모듈을 못 찾아 실패(`Cannot find module '../lib/streak-v2'`).

- [ ] **Step 3: 구현**

`lib/streak-v2.ts`:
```ts
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
```
주의: ⑪의 `weekCells` — 오늘(10-16) 켜졌으면 `"lit"`(오늘 판정이 `future`보다 먼저), 오늘 아직이면 `"future"`로 보인다(오늘 칸은 화면에서 "오늘"로 강조).

- [ ] **Step 4: 통과 확인**

Run: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run -s eval:streak 2>&1 | grep -E "^\| FAIL|PASS —|FAIL —"`
Expected: `PASS — 스트릭 96개 항목 통과` (84 + 12). 실패하면 항목의 detail JSON으로 코어를 고친다 — 기대값을 바꾸지 마라(스펙 §4가 기준).

- [ ] **Step 5: 타입 확인 + 커밋**

```bash
npx tsc --noEmit -p .
git add lib/streak-v2.ts scripts/eval-streak.ts
git commit -m "feat(streak): v2 코어 — 쉬는 날 카드·만회·연속·주간·배지(순수)"
```

---

### Task 2: "한 판" 판정과 일자별 판 수 — `lib/streak-v2-sources.ts` + `reviewFullDays`

**Files:**
- Create: `lib/streak-v2-sources.ts`
- Modify: `lib/review-schedule.ts` (파일 끝에 `reviewFullDays` 추가)
- Modify: `scripts/eval-streak.ts` (묶음 12)

**Interfaces:**
- Consumes: `REVIEW_DAILY_CAP`, `REVIEW_INTERVAL_DAYS`, `ReviewScheduleRecord`, `shiftDateString`, `kstDateString`; 레코드 최소 모양(아래)
- Produces:
  ```ts
  // lib/review-schedule.ts
  export const REVIEW_NEW_ONLY_MIN_RUN = 5;
  export function reviewFullDays(schedules: readonly ReviewScheduleRecord[]): Set<string>;
  // lib/streak-v2-sources.ts
  export const TALK_STREAK_MIN_CHILD_TURNS = 3;
  export function isFullQuiz(q: { finishedAt: string | null; items: readonly { answered: boolean | null }[] }): boolean;
  export function isFullAttempt(a: { finishedAt: string | null; questions: readonly number[]; answers: readonly { q: number; recorded: boolean }[] }): boolean;
  export function isFullFrameDrill(d: { items: readonly { outcome: string }[] }): boolean;
  export function isFullTalk(t: { childTurnCount: number }): boolean;
  export function addRuns(into: Map<string, number>, startedAts: readonly string[]): void;
  export function addDays(into: Map<string, number>, days: Iterable<string>): void;
  ```

- [ ] **Step 1: 실패하는 eval 묶음**

import 추가:
```ts
import { addDays, addRuns, isFullAttempt, isFullFrameDrill, isFullQuiz, isFullTalk } from "../lib/streak-v2-sources";
import { reviewFullDays } from "../lib/review-schedule";
```
(이미 `reviewStreakSessions, reviewTodayLabel`을 import하는 줄에 `reviewFullDays`를 더해도 된다.)

묶음 12(`printTable` 앞):
```ts
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
```

- [ ] **Step 2: 실패 확인** — 같은 eval 명령, 모듈 없음으로 실패.

- [ ] **Step 3: 구현**

`lib/review-schedule.ts` 끝에:
```ts
/** 차례 온 기존 항목이 없는 날, 이만큼 복습하면 한 판(가족 스트릭 강화 스펙 §2-1) */
export const REVIEW_NEW_ONLY_MIN_RUN = 5;

/**
 * 복습 "한 판"을 한 KST 일자 집합(스펙 §2-1). 그날 D에 대해:
 * - 차례 온 기존 항목 = D 이전 마지막 이력 e의 (e.on + 간격[e.step]) ≤ D인 항목
 * - 한 판 = 그날 복습 ≥ 1 그리고 (그날 복습 ≥ REVIEW_DAILY_CAP, 또는 차례 온 기존 항목이 있고 전부 그날 복습, 또는 차례 온 것이 없고 그날 복습 ≥ REVIEW_NEW_ONLY_MIN_RUN)
 * 영역 분리는 호출측 책임.
 */
export function reviewFullDays(schedules: readonly ReviewScheduleRecord[]): Set<string> {
  const reviewedOn = new Map<string, Set<string>>(); // day → itemKeys
  for (const s of schedules) for (const e of s.history) {
    if (!reviewedOn.has(e.on)) reviewedOn.set(e.on, new Set());
    reviewedOn.get(e.on)!.add(s.itemKey);
  }
  const out = new Set<string>();
  for (const [day, done] of reviewedOn) {
    const dueBefore: string[] = [];
    for (const s of schedules) {
      let last: ReviewHistoryEntry | null = null;
      for (const e of s.history) if (e.on < day && (last === null || e.on >= last.on)) last = e;
      if (last === null) continue;
      const step = Math.min(REVIEW_MAX_STEP, Math.max(0, last.step));
      if (shiftDateString(last.on, REVIEW_INTERVAL_DAYS[step]) <= day) dueBefore.push(s.itemKey);
    }
    const n = done.size;
    const ok =
      n >= REVIEW_DAILY_CAP ||
      (dueBefore.length > 0 ? dueBefore.every((k) => done.has(k)) : n >= REVIEW_NEW_ONLY_MIN_RUN);
    if (n >= 1 && ok) out.add(day);
  }
  return out;
}
```
(`ReviewHistoryEntry`는 이 파일의 이력 타입 이름이다 — 다르면 이 파일의 `history` 원소 타입 이름을 쓴다. `shiftDateString`은 이미 import돼 있다.)

`lib/streak-v2-sources.ts`:
```ts
/**
 * lib/streak-v2-sources.ts — 학습 기록 → "한 판" 판정·일자별 판 수(가족 스트릭 강화 스펙 §2). 순수, store 의존 없음(최소 모양만).
 */

import { kstDateString } from "./kst";

/** 자유대화 한 판 — 은우 발화 수 하한(1학년에게 높으면 이 값만 낮춘다) */
export const TALK_STREAK_MIN_CHILD_TURNS = 3;

export function isFullQuiz(q: { finishedAt: string | null; items: readonly { answered: boolean | null }[] }): boolean {
  return q.finishedAt !== null && q.items.length > 0 && q.items.every((i) => i.answered === true);
}

export function isFullAttempt(a: { finishedAt: string | null; questions: readonly number[]; answers: readonly { q: number; recorded: boolean }[] }): boolean {
  if (a.finishedAt === null || a.questions.length === 0) return false;
  const rec = new Set(a.answers.filter((x) => x.recorded === true).map((x) => x.q));
  return a.questions.every((q) => rec.has(q));
}

export function isFullFrameDrill(d: { items: readonly { outcome: string }[] }): boolean {
  return d.items.length > 0 && d.items.some((i) => i.outcome === "spoken");
}

export function isFullTalk(t: { childTurnCount: number }): boolean {
  return Number.isFinite(t.childTurnCount) && t.childTurnCount >= TALK_STREAK_MIN_CHILD_TURNS;
}

/** 세션 시작 시각들 → KST 일자별 판 수 누적 */
export function addRuns(into: Map<string, number>, startedAts: readonly string[]): void {
  for (const at of startedAts) {
    const d = kstDateString(at);
    into.set(d, (into.get(d) ?? 0) + 1);
  }
}

/** 날짜 단위 한 판(복습·운동 지킨 날) → 그날 +1 */
export function addDays(into: Map<string, number>, days: Iterable<string>): void {
  for (const d of days) into.set(d, (into.get(d) ?? 0) + 1);
}
```

- [ ] **Step 4: 통과 확인** — Expected: `PASS — 스트릭 109개 항목 통과` (96 + 13).

- [ ] **Step 5: 커밋**
```bash
npx tsc --noEmit -p .
git add lib/streak-v2-sources.ts lib/review-schedule.ts scripts/eval-streak.ts
git commit -m "feat(streak): 한 판 판정·복습 한 판의 날(순수)"
```

---

### Task 3: `/api/streak` 조립 — 트랙별 v2·아빠 사람 단위 카드·가족·주간·배지

**Files:**
- Modify: `lib/streak-contract.ts`
- Create: `lib/streak-v2-assemble.ts` (라우트에서 쓰는 순수 조립 — 테스트 가능하게 분리)
- Modify: `app/api/streak/route.ts`
- Modify: `scripts/eval-streak.ts` (묶음 13)
- Modify: `docs/SPEC.md` (§17-11 append, `## 18.` 앞), `docs/superpowers/specs/2026-10-09-family-streak-design.md` §2-1(복습 규칙을 Task 2 정의로)·§5(`pending` 칸)

**Interfaces:**
- Consumes: Task 1·2 전부
- Produces:
  ```ts
  // lib/streak-v2-assemble.ts
  export interface TrackInput { legacyDays: ReadonlySet<string>; runs: ReadonlyMap<string, number> }
  export interface PersonV2 { info: StreakV2Info; litDays: Set<string>; bridges: Bridges; startDay: string | null }
  export function personV2(tracks: readonly TrackInput[], today: string, from?: string): PersonV2;   // 트랙들을 사람으로 합쳐 카드·만회 결정
  export function trackV2(track: TrackInput, person: PersonV2, today: string, from?: string): StreakV2Info; // 사람의 카드·만회로 트랙 연속
  export function familyV2(people: readonly (PersonV2 | null)[], today: string): { info: StreakInfoLike; keptDays: Set<string> };
  // lib/streak-contract.ts
  export interface PersonStreak { info: StreakInfo & Partial<Omit<StreakV2Info, keyof StreakInfo>>; todayLabel: string | null }
  StreakResponse += { mom: PersonStreak | null; family: PersonStreak; week: { days: string[]; rows: { eunwoo: WeekCell[]; appa: WeekCell[]; mom: WeekCell[] | null } }; badges: { key: "eunwoo" | "appaLanguage" | "appaWorkout" | "mom" | "family"; earned: number[]; reachedToday: number | null }[]; v2From: string }
  ```

- [ ] **Step 1: 실패하는 eval 묶음 13**

```ts
import { familyV2, personV2, trackV2 } from "../lib/streak-v2-assemble";
```
```ts
// ---------------------------------------------------------------------------
// 13) 조립(스펙 §3·§4-2) — 아빠 사람 단위 카드, 가족 = 참여자 전원, 엄마 없음
// ---------------------------------------------------------------------------
{
  const B = "v2 조립";
  const FROM = "2026-10-10";
  const T = (legacy: string[], runs: Record<string, number>) => ({ legacyDays: new Set(legacy), runs: new Map(Object.entries(runs)) });
  const lang = T([], { "2026-10-10": 1, "2026-10-12": 1 });
  const gym = T([], { "2026-10-11": 1, "2026-10-12": 1 });
  const appa = personV2([lang, gym], "2026-10-12", FROM);
  add(B, "아빠 사람: 어학·운동 중 하나면 그날 지킴 → 3일, 카드 0", appa.info.current === 3 && appa.info.freezeDays.length === 0, JSON.stringify(appa.info));
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
}
```

- [ ] **Step 2: 실패 확인** (모듈 없음)

- [ ] **Step 3: 조립 구현** — `lib/streak-v2-assemble.ts`:
```ts
/**
 * lib/streak-v2-assemble.ts — 트랙 → 사람 → 가족 조립(가족 스트릭 강화 스펙 §3·§4-2). 순수.
 * 카드·만회는 사람 단위로 한 번 정하고(아빠는 어학·운동 합쳐서), 트랙 연속에 그대로 적용한다.
 */

import { computeStreakFromDays, type StreakInfo } from "./streak";
import { STREAK_V2_FROM, decideBridges, litDaysOf, streakFromStatus, type Bridges, type StreakV2Info } from "./streak-v2";

export interface TrackInput {
  legacyDays: ReadonlySet<string>;
  runs: ReadonlyMap<string, number>;
}

export interface PersonV2 {
  info: StreakV2Info;
  litDays: Set<string>;
  bridges: Bridges;
  /** 이 사람의 첫 기록일(legacy·runs 중 가장 이른 날) — 가족 참여 시작. 기록 없음 = null */
  startDay: string | null;
}

function mergeTracks(tracks: readonly TrackInput[]): TrackInput {
  const legacy = new Set<string>();
  const runs = new Map<string, number>();
  for (const t of tracks) {
    for (const d of t.legacyDays) legacy.add(d);
    for (const [d, n] of t.runs) runs.set(d, (runs.get(d) ?? 0) + n);
  }
  return { legacyDays: legacy, runs };
}

export function personV2(tracks: readonly TrackInput[], today: string, from: string = STREAK_V2_FROM): PersonV2 {
  const merged = mergeTracks(tracks);
  const litDays = litDaysOf({ ...merged, from });
  const bridges = decideBridges({ ...merged, from, today });
  const info = streakFromStatus({ litDays, bridges, today, runsToday: merged.runs.get(today) ?? 0 });
  const all = [...merged.legacyDays, ...[...merged.runs].filter(([, n]) => n > 0).map(([d]) => d)].sort();
  return { info, litDays, bridges, startDay: all[0] ?? null };
}

export function trackV2(track: TrackInput, person: PersonV2, today: string, from: string = STREAK_V2_FROM): StreakV2Info {
  const litDays = litDaysOf({ ...track, from });
  return streakFromStatus({ litDays, bridges: person.bridges, today, runsToday: track.runs.get(today) ?? 0 });
}

/** 사람의 "지킨 날" = 켜짐 ∪ 카드 ∪ 만회 ∪ 만회 대기 */
function keptDays(p: PersonV2): Set<string> {
  const s = new Set<string>(p.litDays);
  for (const d of p.bridges.freezeDays) s.add(d);
  for (const d of p.bridges.repairedDays) s.add(d);
  if (p.bridges.pendingRepairDay) s.add(p.bridges.pendingRepairDay);
  return s;
}

/** 가족 — 그날 참여자(그날 ≥ startDay인 사람) 전원이 지킨 날. null(영역 없음)·기록 없는 사람은 참여자가 아니다. */
export function familyV2(people: readonly (PersonV2 | null)[], today: string): { info: StreakInfo; keptDays: Set<string> } {
  const ps = people.filter((p): p is PersonV2 => p !== null && p.startDay !== null);
  const kept = ps.map(keptDays);
  const candidates = new Set<string>();
  for (const k of kept) for (const d of k) candidates.add(d);
  const days = new Set<string>();
  for (const d of candidates) {
    const participants = ps.map((p, i) => ({ p, k: kept[i] })).filter(({ p }) => p.startDay! <= d);
    if (participants.length > 0 && participants.every(({ k }) => k.has(d))) days.add(d);
  }
  return { info: computeStreakFromDays(days, today), keptDays: days };
}
```
주의: `familyV2`의 `doneToday`는 "오늘 참여자 전원 켜짐"이어야 한다 — 만회 대기는 오늘이 될 수 없고 카드는 오늘 쓰지 않으므로 `keptDays`에 오늘이 들어가는 건 켜졌을 때뿐이다.

- [ ] **Step 4: 묶음 13 통과 확인** — Expected: `PASS — 스트릭 115개 항목 통과`.

- [ ] **Step 5: 계약 확장** — `lib/streak-contract.ts`:
  - 맨 위 import에 `import type { StreakV2Info, WeekCell } from "./streak-v2";` 추가(타입만 — 클라이언트 번들 안전).
  - `PersonStreak.info` 타입을 `StreakInfo & Partial<Omit<StreakV2Info, keyof StreakInfo>>`로 바꾼다.
  - `StreakResponse`에 추가(주석은 스펙 §5 요약):
  ```ts
  /** 👩 엄마 트랙 — 엄마 영역(②) 전에는 null */
  mom: PersonStreak | null;
  /** 👪 가족 연속일(스펙 §3-2) */
  family: PersonStreak;
  /** 이번 주(월~일) 사람별 칸 */
  week: { days: string[]; rows: { eunwoo: WeekCell[]; appa: WeekCell[]; mom: WeekCell[] | null } };
  /** 배지(스펙 §4-1) */
  badges: { key: "eunwoo" | "appaLanguage" | "appaWorkout" | "mom" | "family"; earned: number[]; reachedToday: number | null }[];
  /** 새 규칙 적용일 — 보드 안내용 */
  v2From: string;
  ```

- [ ] **Step 6: 라우트 조립** — `app/api/streak/route.ts`. 기존 계산(legacy 세션 배열과 라벨)은 **그대로 두고** 끝에서 v2를 덧씌운다. import 추가:
```ts
import { STREAK_V2_FROM, badgesOf, kstWeekDays, weekCells } from "@/lib/streak-v2";
import { addDays, addRuns, isFullAttempt, isFullFrameDrill, isFullQuiz, isFullTalk } from "@/lib/streak-v2-sources";
import { familyV2, personV2, trackV2, type TrackInput } from "@/lib/streak-v2-assemble";
import { reviewFullDays } from "@/lib/review-schedule";
```
`const body: StreakResponse = …` 바로 앞에 삽입:
```ts
  // ── 스트릭 v2(가족 스트릭 강화 스펙) — legacy = 기존 세션 배열의 날짜, runs = 적용일부터의 "한 판" 수 ──
  const v2 = (() => {
    const runs = (fill: (m: Map<string, number>) => void) => {
      const m = new Map<string, number>();
      fill(m);
      return m;
    };
    const eunwooT: TrackInput = {
      legacyDays: streakDays([...vocab, ...talkStreakSessions(talks), ...reviewStreakSessions(reviewsOf("english"))]),
      runs: runs((m) => {
        addRuns(m, vocab.filter(isFullQuiz).map((q) => q.startedAt));
        addRuns(m, talks.filter(isFullTalk).map((t) => t.startedAt));
        addDays(m, reviewFullDays(reviewsOf("english")));
      }),
    };
    const langT: TrackInput = {
      legacyDays: new Set([...streakDays(jaSessions), ...streakDays(enSessions)]),
      runs: runs((m) => {
        addRuns(m, [...jaVocab, ...jaKanji].filter(isFullQuiz).map((q) => q.startedAt));
        addDays(m, reviewFullDays(reviewsOf("japanese")));
        addDays(m, reviewFullDays(reviewsOf("toeic")));
        if (toeicQuizzes) addRuns(m, toeicQuizzes.filter(isFullQuiz).map((q) => q.startedAt));
        if (toeicAttempts) addRuns(m, toeicAttempts.filter(isFullAttempt).map((a) => a.startedAt));
        if (toeicFrameDrills) addRuns(m, toeicFrameDrills.filter(isFullFrameDrill).map((d) => d.startedAt));
      }),
    };
    let gymDays: string[] = [];
    try {
      if (workoutCycles) gymDays = workoutKeptDays(workoutCycles, today);
    } catch {
      gymDays = [];
    }
    const gymT: TrackInput = { legacyDays: new Set(gymDays), runs: runs((m) => addDays(m, gymDays)) };

    const eunwooP = personV2([eunwooT], today);
    const appaP = personV2([langT, gymT], today);
    const fam = familyV2([eunwooP, appaP, null], today);
    const week = kstWeekDays(today);
    const langInfo = trackV2(langT, appaP, today);
    const gymInfo = trackV2(gymT, appaP, today);
    return {
      eunwoo: eunwooP.info,
      appaLanguage: langInfo,
      appaWorkout: gymInfo,
      family: fam.info,
      week: {
        days: week,
        rows: {
          eunwoo: weekCells({ info: eunwooP.info, litDays: eunwooP.litDays, weekDays: week, today, startDay: eunwooP.startDay }),
          appa: weekCells({ info: appaP.info, litDays: appaP.litDays, weekDays: week, today, startDay: appaP.startDay }),
          mom: null,
        },
      },
      badges: [
        { key: "eunwoo" as const, ...badgesOf(eunwooP.info) },
        { key: "appaLanguage" as const, ...badgesOf(langInfo) },
        { key: "appaWorkout" as const, ...badgesOf(gymInfo) },
        { key: "family" as const, ...badgesOf(fam.info) },
      ],
    };
  })();
  eunwoo.info = v2.eunwoo;
  appaLanguage.info = v2.appaLanguage;
  if (appaWorkout !== NEUTRAL_STREAK) appaWorkout = { ...appaWorkout, info: v2.appaWorkout };
```
그리고 `body`를:
```ts
  const body: StreakResponse = {
    ok: true, today, eunwoo, appa, appaWorkout, appaEnglish, appaLanguage,
    mom: null,
    family: { info: v2.family, todayLabel: null },
    week: v2.week,
    badges: v2.badges,
    v2From: STREAK_V2_FROM,
  };
```
주의: `appa`·`appaEnglish`(호환 필드)는 legacy 계산 그대로 둔다 — 헤드라인은 더 이상 읽지 않는다. `streakDays`는 이미 import돼 있다. `reviewStreakSessions`를 v2 legacy에서도 쓰므로 기존 import 유지.

- [ ] **Step 7: 라우트 배선 eval** — 묶음 13 끝에 추가:
```ts
  const route = readFileSync(new URL("../app/api/streak/route.ts", import.meta.url), "utf-8");
  const wiredV2 =
    /personV2\(\[eunwooT\], today\)/.test(route) &&
    /personV2\(\[langT, gymT\], today\)/.test(route) &&
    /familyV2\(\[eunwooP, appaP, null\], today\)/.test(route) &&
    /vocab\.filter\(isFullQuiz\)/.test(route) &&
    /talks\.filter\(isFullTalk\)/.test(route) &&
    /toeicAttempts\.filter\(isFullAttempt\)/.test(route) &&
    /reviewFullDays\(reviewsOf\("english"\)\)/.test(route) &&
    !/reviewFullDays\(reviewsOf\("english"\)\)[\s\S]{0,200}langT/.test(route);
  add(B, "/api/streak v2 배선: 사람·트랙·가족 조립, 한 판 판정 적용, 은우 복습은 은우에만", wiredV2, "");
```
Expected: `PASS — 스트릭 116개 항목 통과`.

- [ ] **Step 8: 적용일 박기** — `lib/streak-v2.ts`의 `STREAK_V2_FROM`을 이 작업을 **배포하는 날의 KST 날짜**로 바꾼다: `TZ=Asia/Seoul date +%F`. eval은 from을 인자로 넘기므로 값과 무관하게 통과해야 한다.

- [ ] **Step 9: 로컬 실측**
```bash
shasum data/db.json > /tmp/db.sha  # (스크래치패드 경로 사용)
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= APP_PIN= npx next dev -p 3917 &
curl -s localhost:3917/api/streak | python3 -m json.tool | head -80
```
Expected: `family`·`week.days`(7개)·`badges`(4개)·`v2From`이 있고 200. dev 서버를 끄고 `git checkout CLAUDE.md`로 next dev가 다시 쓴 자동 블록을 되돌린 뒤 sha 대조.

- [ ] **Step 10: 문서** — `docs/SPEC.md`의 `## 18. 대화 해설 낭독` 앞에 `### 17-11. 스트릭 v2 — 한 판·가족·카드·만회 (YYYY-MM-DD)` 절을 추가(스펙 문서 §2~§5 요약 + `STREAK_V2_FROM` 값 + eval 항목 수). 설계 스펙 §2-1을 Task 2의 `reviewFullDays` 정의로, §5 칸 목록에 `pending`을 더한다.

- [ ] **Step 11: 커밋**
```bash
npx tsc --noEmit -p .
git add lib/streak-v2*.ts lib/streak-contract.ts app/api/streak/route.ts scripts/eval-streak.ts docs/SPEC.md docs/superpowers/specs/2026-10-09-family-streak-design.md
git commit -m "feat(streak): /api/streak v2 — 한 판 규칙·사람 단위 카드·가족 연속일·주간·배지"
```

---

### Task 4: 헤드라인 👪 칸·오늘 아직 점 + "한 판을 끝내야" 안내

**Files:**
- Modify: `components/streak-headline.tsx`
- Create: `components/streak-finish-hint.tsx`
- Modify(안내 삽입): `components/vocab-quiz-view.tsx`, `components/vocab-speak-quiz-runner.tsx`, `components/ja-quiz-runner.tsx`, `components/ja-kanji-quiz-runner.tsx`, `components/toeic-quiz-runner.tsx`, `components/toeic-template-quiz.tsx`, `components/toeic-template-test.tsx`, `components/toeic-frame-drill-runner.tsx`, `components/toeic-take-view.tsx`
- Modify: `scripts/eval-streak.ts` (묶음 14 — 정적 배선)

**Interfaces:**
- Consumes: `StreakResponse.family`·`info.pendingRepairDay`·`info.runsToday`
- Produces: `export default function StreakFinishHint({ partial }: { partial: boolean })` — `partial`이 참일 때만 한 줄을 그린다

- [ ] **Step 1: eval 묶음 14(실패)**
```ts
{
  const B = "v2 화면";
  const head = readFileSync(new URL("../components/streak-headline.tsx", import.meta.url), "utf-8");
  add(B, "헤드라인: 👪 가족 칸이 family를 읽고 맨 앞", /<Track emoji="👪" name="가족" p=\{data\?\.family\} \/>/.test(head) && head.indexOf('name="가족"') < head.indexOf('name="은우"'), "");
  add(B, "헤드라인: 오늘 아직 점(aria-hidden) — Track·Person 둘 다", (head.match(/data-pending-dot/g) ?? []).length >= 2, "");
  const files = ["vocab-quiz-view", "vocab-speak-quiz-runner", "ja-quiz-runner", "ja-kanji-quiz-runner", "toeic-quiz-runner", "toeic-template-quiz", "toeic-template-test", "toeic-frame-drill-runner", "toeic-take-view"];
  const missing = files.filter((f) => !/<StreakFinishHint /.test(readFileSync(new URL(`../components/${f}.tsx`, import.meta.url), "utf-8")));
  add(B, "그만둠 화면 9곳에 '한 판을 끝내야' 안내", missing.length === 0, `빠짐=${missing.join(",")}`);
}
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 안내 컴포넌트** — `components/streak-finish-hint.tsx`:
```tsx
"use client";

/** 그만둔 판에만 보이는 한 줄 — 새 규칙(가족 스트릭 강화 스펙 §2-2): 한 판을 끝까지 해야 🔥가 켜진다 */
export default function StreakFinishHint({ partial }: { partial: boolean }) {
  if (!partial) return null;
  return <p className="t-caption text-ink-3" role="note">🔥 한 판을 끝까지 해야 오늘 불이 켜져요.</p>;
}
```

- [ ] **Step 4: 9곳 삽입** — 각 파일에서 **그만둔 뒤 보이는 결과(부분 결과) 블록**을 찾아(`그만하기`/`그만두기` 처리 뒤 `finishedAt === null` 또는 "중단" 상태를 그리는 JSX) 그 블록 맨 위에 넣는다:
```tsx
import StreakFinishHint from "@/components/streak-finish-hint";
// …
<StreakFinishHint partial={/* 그 파일에서 '그만둠으로 끝남'을 뜻하는 기존 불리언 */} />
```
파일마다 기존 상태 이름을 그대로 쓴다(새 상태를 만들지 않는다). 찾는 법: `grep -n "그만" components/<file>.tsx`. 응시(`toeic-take-view.tsx`)는 "그만둠" 결과 화면, 틀 말하기는 판이 끝났는데 말한 문항이 0인 경우도 `partial`로 본다.

- [ ] **Step 5: 헤드라인** — `components/streak-headline.tsx`:
  - `Person`·`Track`의 "오늘 아직" 표시 앞에 점 추가: `{loaded && !done && <span data-pending-dot aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent,theme(colors.orange.500))]" />}` (색 토큰은 `app/globals.css`에 있는 강조 토큰 이름을 쓴다 — 없으면 `bg-orange-500`).
  - 만회 대기 표시: `Track`·`Person`에서 `p?.info.pendingRepairDay`가 있고 오늘 아직이면 라벨 자리에 `오늘 두 판이면 어제 🔥가 돌아와요`(sm 이상, 폰은 sr-only).
  - 렌더 순서: `<Track emoji="👪" name="가족" p={data?.family} />` → 구분선 → 은우 → 구분선 → 아빠 묶음.
  - `compact` 판정 배열에 `data.family` 추가, `aria-label`을 `"학습 스트릭 — 가족, 은우, 아빠(어학·운동)"`로.
  - 머리 주석에 2026-10 v2 줄 추가(👪 칸·점·만회 대기).

- [ ] **Step 6: 폭 실측** — dev 서버(Task 3 Step 9 명령)에서 Playwright로 360·390px 헤드라인 `scrollWidth - clientWidth`를 잰다. 두 자리 값으로 확인하려면 `/api/streak` 응답을 route 가로채기로 주입(`page.route('**/api/streak', …)` — 각 current 12·34·56·78, family 23). 넘침 > 0이면 `compact` 문턱(`COMPACT_FROM_DAYS`)을 10으로 낮춰 다시 잰다. 스크린샷은 `.playwright-mcp/` 아래에 저장하고 끝나면 지운다.

- [ ] **Step 7: 통과·커밋**
```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run -s eval:streak | tail -1   # PASS — 119
npx tsc --noEmit -p . && npm run -s lint
git add components/streak-headline.tsx components/streak-finish-hint.tsx components/*.tsx scripts/eval-streak.ts
git commit -m "feat(streak): 헤드라인 가족 칸·오늘 아직 점·만회 안내 + 그만둠 안내"
```
(`git add components/*.tsx` 대신 바꾼 파일 이름을 하나씩 적는다 — 다른 작업 파일이 섞이지 않게.)

---

### Task 5: 가족 보드 `/family` + 홈 카드 + 배지 축하

**Files:**
- Create: `app/family/page.tsx`, `components/family-board.tsx`, `components/streak-celebrate.tsx`
- Modify: `app/page.tsx` (홈 카드 하나), `components/streak-headline.tsx` (축하 마운트)

**Interfaces:**
- Consumes: `GET /api/streak`(Task 3 응답), `STREAK_REFRESH_EVENT`
- Produces: `/family` 화면, `StreakCelebrate({ badges })`

- [ ] **Step 1: 페이지** — `app/family/page.tsx`:
```tsx
import type { Metadata } from "next";
import FamilyBoard from "@/components/family-board";

export const metadata: Metadata = { title: "가족 보드 · 은우학습" };

export default function FamilyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <FamilyBoard />
    </main>
  );
}
```

- [ ] **Step 2: 보드** — `components/family-board.tsx`(client). `/api/streak`를 헤드라인과 같은 방식(seq 가드·`STREAK_REFRESH_EVENT`)으로 읽고 세 블록을 그린다:
```tsx
"use client";

import { useEffect, useState } from "react";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import type { StreakResponse, PersonStreak } from "@/lib/streak-contract";
import type { WeekCell } from "@/lib/streak-v2";

const CELL: Record<WeekCell, { icon: string; label: string }> = {
  lit: { icon: "🔥", label: "했음" },
  freeze: { icon: "🧊", label: "쉬는 날 카드" },
  repaired: { icon: "🔁", label: "만회" },
  pending: { icon: "⏳", label: "만회 대기" },
  missed: { icon: "✗", label: "놓침" },
  future: { icon: "·", label: "아직" },
  none: { icon: "", label: "기록 전" },
};
const DOW = ["월", "화", "수", "목", "금", "토", "일"];

function Today({ name, emoji, p }: { name: string; emoji: string; p: PersonStreak | null | undefined }) {
  if (!p) return null;
  const done = p.info.doneToday;
  return (
    <li className="flex items-center justify-between rounded-xl border border-line px-4 py-3">
      <span className="t-body font-medium">{emoji} {name}</span>
      <span className="t-caption text-ink-2">
        {done ? `✓ ${p.todayLabel ?? "오늘 완료"}` : p.info.pendingRepairDay ? "오늘 두 판이면 어제가 돌아와요" : "아직"}
        {" · "}🔥{p.info.current}일
      </span>
    </li>
  );
}

export default function FamilyBoard() {
  const [data, setData] = useState<StreakResponse | null>(null);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      try {
        const res = await fetch("/api/streak", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as StreakResponse;
        if (alive && mine === seq) setData(json);
      } catch {
        /* 보조 화면 — 조용히 */
      }
    };
    void load();
    const on = () => void load();
    window.addEventListener(STREAK_REFRESH_EVENT, on);
    return () => {
      alive = false;
      window.removeEventListener(STREAK_REFRESH_EVENT, on);
    };
  }, []);
  if (!data) return <p className="t-body text-ink-3">불러오는 중…</p>;

  const appa: PersonStreak = data.appaLanguage.info.doneToday || !data.appaWorkout.info.doneToday ? data.appaLanguage : data.appaWorkout;
  const rows: { key: "eunwoo" | "appa" | "mom"; name: string }[] = [
    { key: "eunwoo", name: "은우" },
    { key: "appa", name: "아빠" },
    ...(data.week.rows.mom ? [{ key: "mom" as const, name: "엄마" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="t-title">👪 가족 보드</h1>
        <p className="t-body text-ink-2">
          가족 🔥 {data.family.info.current}일 · 최고 {data.family.info.best}일
        </p>
      </header>
      <section aria-label="오늘">
        <h2 className="t-subtitle mb-2">오늘</h2>
        <ul className="flex flex-col gap-2">
          <Today name="은우" emoji="🧒" p={data.eunwoo} />
          <Today name="아빠" emoji="🧑" p={appa} />
          <Today name="엄마" emoji="👩" p={data.mom} />
        </ul>
      </section>
      <section aria-label="이번 주">
        <h2 className="t-subtitle mb-2">이번 주</h2>
        <table className="w-full table-fixed text-center">
          <thead>
            <tr>
              <th className="w-14" />
              {DOW.map((d, i) => (
                <th key={d} className={`t-caption ${data.week.days[i] === data.today ? "font-bold text-ink" : "text-ink-3"}`}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th className="t-caption text-left">{r.name}</th>
                {(data.week.rows[r.key] ?? []).map((c, i) => (
                  <td key={i} className="py-1" title={CELL[c].label} aria-label={`${DOW[i]} ${CELL[c].label}`}>{CELL[c].icon}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label="기록">
        <h2 className="t-subtitle mb-2">기록</h2>
        <ul className="t-body flex flex-col gap-1">
          <li>🧊 이번 달 남은 쉬는 날 카드 — 은우 {data.eunwoo.info.freezeLeftThisMonth ?? 0}장 · 아빠 {data.appaLanguage.info.freezeLeftThisMonth ?? 0}장{data.mom ? ` · 엄마 ${data.mom.info.freezeLeftThisMonth ?? 0}장` : ""}</li>
          {data.badges.map((b) => (
            <li key={b.key}>🏅 {({ eunwoo: "은우", appaLanguage: "아빠 어학", appaWorkout: "아빠 운동", mom: "엄마", family: "가족" } as const)[b.key]} — {b.earned.length > 0 ? b.earned.map((n) => `${n}일`).join(" · ") : "아직 없음"}</li>
          ))}
        </ul>
        <p className="t-caption mt-2 text-ink-3">{data.v2From}부터 한 판을 끝까지 해야 🔥가 켜져요. 하루를 놓치면 쉬는 날 카드(한 달 2장)가 자동으로 쓰이고, 카드가 없으면 다음 날 두 판으로 메울 수 있어요.</p>
      </section>
    </div>
  );
}
```
(클래스 이름 `t-title`·`t-subtitle`·`t-body`·`t-caption`·`text-ink-*`·`border-line`은 기존 토큰이다 — `app/globals.css`에서 이름을 확인하고 없는 것은 가장 가까운 기존 토큰으로 바꾼다.)

- [ ] **Step 3: 홈 카드** — `app/page.tsx`의 운동 `<Link href="/workout" …>` 블록 **앞에** 같은 모양의 카드를 추가:
```tsx
        <Link href="/family" className="u-entry u-entry-secondary sm:col-span-2">
          <span className="u-entry-icon" aria-hidden>👪</span>
          <span className="u-entry-title">가족 보드</span>
          <span className="u-entry-desc">오늘 누가 했는지, 이번 주 불꽃과 쉬는 날 카드, 가족 연속일을 한눈에 봐요.</span>
        </Link>
```

- [ ] **Step 4: 배지 축하** — `components/streak-celebrate.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";

const NAME = { eunwoo: "은우", appaLanguage: "아빠 어학", appaWorkout: "아빠 운동", mom: "엄마", family: "가족" } as const;
type Badge = { key: keyof typeof NAME; reachedToday: number | null };

/** 그날 배지 숫자에 닿은 트랙을 한 번 축하한다(본 축하는 기기 localStorage — 실패하면 다시 보일 뿐, 스펙 §4-1) */
export default function StreakCelebrate({ badges, today }: { badges: readonly Badge[]; today: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const hit = badges.find((b) => b.reachedToday !== null);
    if (!hit) return;
    const key = `streak-celebrated:${today}:${hit.key}:${hit.reachedToday}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      /* 저장 실패 — 그래도 보인다 */
    }
    setMsg(`🏅 ${NAME[hit.key]} ${hit.reachedToday}일 연속! 대단해요!`);
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [badges, today]);
  if (!msg) return null;
  return (
    <div role="status" className="fixed inset-x-4 top-12 z-[16] mx-auto max-w-sm rounded-xl bg-ink px-4 py-3 text-center text-bg shadow-lg">
      {msg}
    </div>
  );
}
```
`components/streak-headline.tsx`의 최상위 `<div …>` 뒤(같은 fragment 안)에 `{data && <StreakCelebrate badges={data.badges} today={data.today} />}`를 둔다(반환을 `<>…</>`로 감싼다).

- [ ] **Step 5: 화면 확인** — Task 3 Step 9의 dev 서버에서 `/family`를 360px로 열어 Playwright 스크린샷(응답 주입으로 lit·freeze·repaired·pending·missed가 모두 있는 주를 만든다). 가로 넘침 0, 표 칸이 보이는지 본다.

- [ ] **Step 6: 커밋**
```bash
npx tsc --noEmit -p . && npm run -s lint
git add app/family/page.tsx components/family-board.tsx components/streak-celebrate.tsx components/streak-headline.tsx app/page.tsx
git commit -m "feat(streak): 가족 보드·홈 카드·배지 축하"
```

**→ 여기까지가 비용 0 묶음. 사용자 승인 뒤 푸시·배포(배포일 = `STREAK_V2_FROM`과 같은 날이어야 한다 — 다르면 Step 8 값을 배포일로 고치고 다시 커밋).**

---

### Task 6: 알림 결정 순수 함수 `lib/push-decide.ts`

**Files:**
- Create: `lib/push-decide.ts`, `lib/push-contract.ts`
- Modify: `scripts/eval-streak.ts` (묶음 15)

**Interfaces:**
- Produces:
  ```ts
  // lib/push-contract.ts
  export const PUSH_PEOPLE = ["eunwoo", "appa", "mom"] as const;
  export type PushPerson = (typeof PUSH_PEOPLE)[number];
  export type PushKind = "today" | "last" | "repair" | "family" | "poke";
  export interface PushPrefs { remindAt: string /* "HH:MM" */; familyAlerts: boolean }
  export const DEFAULT_PUSH_PREFS: Record<PushPerson, PushPrefs>; // 은우 18:00, 엄마 20:00, 아빠 21:00, familyAlerts: 엄마 true·나머지 false
  export function isPushPerson(v: unknown): v is PushPerson;
  export function parsePushPrefs(v: unknown, person: PushPerson): PushPrefs;
  // lib/push-decide.ts
  export const PUSH_DAILY_MAX = 3, POKE_DAILY_MAX = 2, QUIET_FROM = "22:30", QUIET_UNTIL = "08:00", LAST_AT = "22:30", REPAIR_AT = "08:30", FAMILY_AT = "21:00";
  export interface PersonState { person: PushPerson; doneToday: boolean; current: number; freezeLeft: number; pendingRepairYesterday: boolean; missingTracks: string[] }
  export interface PushToSend { person: PushPerson; kind: PushKind; title: string; body: string; url: string }
  export function decidePushes(input: { nowHHMM: string; states: readonly PersonState[]; prefs: Readonly<Record<PushPerson, PushPrefs>>; sentToday: readonly { person: PushPerson; kind: PushKind }[] }): PushToSend[];
  export function pushText(person: PushPerson, kind: PushKind, s: PersonState, extra?: { from?: string; about?: PushPerson }): { title: string; body: string; url: string };
  ```

- [ ] **Step 1: eval 묶음 15(실패)**
```ts
import { decidePushes, PUSH_DAILY_MAX } from "../lib/push-decide";
import { DEFAULT_PUSH_PREFS } from "../lib/push-contract";
```
```ts
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
}
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: `lib/push-contract.ts`**
```ts
/** lib/push-contract.ts — 알림 구독·설정 계약(클라이언트·서버 공유, 순수) */

export const PUSH_PEOPLE = ["eunwoo", "appa", "mom"] as const;
export type PushPerson = (typeof PUSH_PEOPLE)[number];
export type PushKind = "today" | "last" | "repair" | "family" | "poke";
export const PUSH_PERSON_KO: Record<PushPerson, string> = { eunwoo: "은우", appa: "아빠", mom: "엄마" };

export interface PushPrefs {
  /** 오늘 아직 알림 시각 "HH:MM"(30분 단위, 08:00~22:00) */
  remindAt: string;
  /** 은우가 아직일 때 21:00 가족 알림을 받을지 */
  familyAlerts: boolean;
}

export const DEFAULT_PUSH_PREFS: Record<PushPerson, PushPrefs> = {
  eunwoo: { remindAt: "18:00", familyAlerts: false },
  appa: { remindAt: "21:00", familyAlerts: false },
  mom: { remindAt: "20:00", familyAlerts: true },
};

export function isPushPerson(v: unknown): v is PushPerson {
  return typeof v === "string" && (PUSH_PEOPLE as readonly string[]).includes(v);
}

const HHMM = /^(0[89]|1\d|2[0-2]):(00|30)$/;

export function parsePushPrefs(v: unknown, person: PushPerson): PushPrefs {
  const d = DEFAULT_PUSH_PREFS[person];
  if (typeof v !== "object" || v === null) return d;
  const o = v as Record<string, unknown>;
  return {
    remindAt: typeof o.remindAt === "string" && HHMM.test(o.remindAt) ? o.remindAt : d.remindAt,
    familyAlerts: typeof o.familyAlerts === "boolean" ? o.familyAlerts : d.familyAlerts,
  };
}
```

- [ ] **Step 4: `lib/push-decide.ts`**
```ts
/**
 * lib/push-decide.ts — 알림 결정(가족 스트릭 강화 스펙 §6-2). 순수 — 시각("HH:MM", KST)·상태·설정·오늘 보낸 것 → 보낼 것.
 * 틱이 30분마다 부르므로 "그 시각 이후 아직 안 보낸 것"을 보낸다(틱이 늦어도 놓치지 않게).
 */

import { PUSH_PERSON_KO, type PushKind, type PushPerson, type PushPrefs } from "./push-contract";

export const PUSH_DAILY_MAX = 3;
export const POKE_DAILY_MAX = 2;
export const QUIET_FROM = "22:30"; // 이 시각 초과부터 조용
export const QUIET_UNTIL = "08:00";
export const LAST_AT = "22:30";
export const REPAIR_AT = "08:30";
export const FAMILY_AT = "21:00";

export interface PersonState {
  person: PushPerson;
  doneToday: boolean;
  current: number;
  freezeLeft: number;
  pendingRepairYesterday: boolean;
  /** 아빠 — 아직인 트랙 이름("어학"·"운동") */
  missingTracks: string[];
}

export interface PushToSend {
  person: PushPerson;
  kind: PushKind;
  title: string;
  body: string;
  url: string;
}

const URL_OF: Record<PushPerson, string> = { eunwoo: "/english", appa: "/", mom: "/" };

export function pushText(person: PushPerson, kind: PushKind, s: PersonState, extra: { from?: PushPerson; about?: PushPerson } = {}): { title: string; body: string; url: string } {
  const kid = person === "eunwoo";
  switch (kind) {
    case "today":
      return {
        title: kid ? "은우야, 오늘 공부할 시간!" : "오늘 🔥 아직이에요",
        body: kid ? `🔥 ${s.current}일째야. 한 판만 하자!` : `🔥 ${s.current}일이 걸려 있어요. 한 판만 하면 돼요!${s.missingTracks.length ? ` (${s.missingTracks.join("·")})` : ""}`,
        url: URL_OF[person],
      };
    case "last":
      return {
        title: kid ? "오늘이 곧 끝나요!" : "1시간 반 남았어요",
        body: s.freezeLeft > 0 ? "오늘 못 하면 🧊 쉬는 날 카드가 쓰여요." : "오늘 못 하면 🔥가 내일 두 판으로만 살아나요.",
        url: URL_OF[person],
      };
    case "repair":
      return { title: "🔁 어제를 되살릴 수 있어요", body: "오늘 두 판 하면 어제 🔥가 돌아와요.", url: URL_OF[person] };
    case "family":
      return { title: "👪 가족 알림", body: `${PUSH_PERSON_KO[extra.about ?? "eunwoo"]}가 오늘 아직이에요.`, url: "/family" };
    case "poke":
      return { title: `👉 ${PUSH_PERSON_KO[extra.from ?? "mom"]}가 콕 찔렀어요`, body: kid ? "오늘 한 판 하자!" : "오늘 한 판 해요!", url: URL_OF[person] };
  }
}

export function decidePushes(input: {
  nowHHMM: string;
  states: readonly PersonState[];
  prefs: Readonly<Record<PushPerson, PushPrefs>>;
  sentToday: readonly { person: PushPerson; kind: PushKind }[];
}): PushToSend[] {
  const now = input.nowHHMM;
  if (now > QUIET_FROM || now < QUIET_UNTIL) return [];
  const sentCount = (p: PushPerson) => input.sentToday.filter((s) => s.person === p).length;
  const was = (p: PushPerson, k: PushKind) => input.sentToday.some((s) => s.person === p && s.kind === k);
  const out: PushToSend[] = [];
  const push = (s: PersonState, kind: PushKind, extra?: { about?: PushPerson }) => {
    if (was(s.person, kind) || sentCount(s.person) + out.filter((o) => o.person === s.person).length >= PUSH_DAILY_MAX) return;
    out.push({ person: s.person, kind, ...pushText(s.person, kind, s, extra) });
  };
  for (const s of input.states) {
    if (s.pendingRepairYesterday && !s.doneToday && now >= REPAIR_AT) push(s, "repair");
    if (s.doneToday) continue;
    if (now >= LAST_AT) push(s, "last");
    else if (now >= input.prefs[s.person].remindAt) push(s, "today");
  }
  const kid = input.states.find((s) => s.person === "eunwoo");
  if (kid && !kid.doneToday && now >= FAMILY_AT) {
    for (const s of input.states) {
      if (s.person !== "eunwoo" && input.prefs[s.person].familyAlerts) push(s, "family", { about: "eunwoo" });
    }
  }
  return out;
}
```
주의: 22:30 틱에서 `today`를 아직 안 보낸 사람은 `last`만 받는다(늦은 시각이 우선). 콕 찌르기는 이 함수가 아니라 `/api/push/poke`가 상한(`POKE_DAILY_MAX`·`PUSH_DAILY_MAX`)을 검사해 즉시 보낸다.

- [ ] **Step 5: 통과·커밋** — Expected `PASS — 스트릭 127개 항목 통과`.
```bash
npx tsc --noEmit -p .
git add lib/push-decide.ts lib/push-contract.ts scripts/eval-streak.ts
git commit -m "feat(push): 알림 결정 순수 함수·설정 계약"
```

---

### Task 7: 알림 기반 — PWA·구독 저장·틱·콕 찌르기·설정 화면

**Files:**
- Create: `app/manifest.ts`, `public/sw.js`, `app/api/push/subscribe/route.ts`, `app/api/push/tick/route.ts`, `app/api/push/poke/route.ts`, `lib/push-send.ts`, `components/push-settings.tsx`, `app/family/settings/page.tsx`
- Modify: `lib/store.ts`(인터페이스 + file 구현), `lib/store-firestore.ts`, `proxy.ts`, `package.json`(`web-push`), `.env.example`, `components/family-board.tsx`(콕 찌르기·설정 링크)

**Interfaces:**
- Consumes: Task 6 전부, `/api/streak`의 사람 상태(라우트 내부 함수로 뽑아 재사용 — 아래 Step 5)
- Produces:
  ```ts
  // store
  interface PushSubscriptionRecord { id: string; person: PushPerson; endpoint: string; keys: { p256dh: string; auth: string }; prefs: PushPrefs; createdAt: string; lastOkAt: string | null }
  upsertPushSubscription(rec: Omit<PushSubscriptionRecord, "createdAt" | "lastOkAt">): Promise<void>;
  deletePushSubscription(id: string): Promise<void>;
  listPushSubscriptions(): Promise<PushSubscriptionRecord[]>;
  markPushOk(id: string, at: string): Promise<void>;
  /** 문서 id = `${day}:${person}:${kind}:${n}` — 이미 있으면 false(멱등) */
  claimPushLog(id: string, at: string): Promise<boolean>;
  listPushLog(day: string): Promise<{ id: string; person: PushPerson; kind: PushKind }[]>;
  // lib/push-send.ts
  export function pushConfigured(): boolean; // VAPID 두 키 있음
  export async function sendTo(subs: readonly PushSubscriptionRecord[], msg: { title: string; body: string; url: string }): Promise<{ ok: string[]; gone: string[] }>;
  ```

- [ ] **Step 1: 의존성** — `npm install web-push@^3 && npm install -D @types/web-push`. `.env.example`에 `VAPID_PUBLIC_KEY=`·`VAPID_PRIVATE_KEY=`·`VAPID_SUBJECT=mailto:`·`PUSH_CRON_SECRET=` 4줄(빈 값, 주석: "비면 알림 501").

- [ ] **Step 2: 스토어** — `lib/store.ts`의 `Store` 인터페이스에 위 6개 메서드를 추가하고, file 백엔드는 `db.json`의 새 키 `pushSubscriptions`(객체 맵)·`pushLog`(객체 맵)로 구현한다(기존 컬렉션 구현 관용구를 그대로 — `mutate` 안에서). `lib/store-firestore.ts`는 컬렉션 `pushSubscriptions`·`pushLog`, `claimPushLog`는 `doc(id).create()`(이미 있으면 `ALREADY_EXISTS` → false — 토익 `ref.create()` 멱등 관용구). `listPushLog(day)`는 id 접두 `day:` 범위 조회(`where(FieldPath.documentId(), ">=", day + ":")`·`"<", day + ";"`). `PushSubscriptionRecord.id` = `endpoint`의 sha256 hex 앞 32자(`crypto.createHash`). 삭제는 `lib/prod-guard.ts`의 `DestructiveOp`에 `"push-subscription-delete"`를 더하고 가드를 통과시킨다(기존 삭제 관용구).

- [ ] **Step 3: 발송 모듈** — `lib/push-send.ts`:
```ts
import "server-only";
import webpush from "web-push";
import type { PushSubscriptionRecord } from "./store";

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

let ready = false;
function init() {
  if (ready) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:family@example.com", process.env.VAPID_PUBLIC_KEY!.trim(), process.env.VAPID_PRIVATE_KEY!.trim());
  ready = true;
}

/** 구독들에 보낸다. 410/404 = 사라진 기기(gone) — 호출측이 지운다. 그 밖 실패는 조용히 건너뛴다. */
export async function sendTo(subs: readonly PushSubscriptionRecord[], msg: { title: string; body: string; url: string }): Promise<{ ok: string[]; gone: string[] }> {
  init();
  const ok: string[] = [];
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600 });
        ok.push(s.id);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.id);
        else console.error("[push] 발송 실패", code);
      }
    }),
  );
  return { ok, gone };
}
```

- [ ] **Step 4: 사람 상태 함수 분리** — `app/api/streak/route.ts`의 GET 본문을 `export async function computeStreakResponse(store, today): Promise<StreakResponse>`로 `lib/streak-server.ts`(새 파일, `import "server-only"`)에 옮기고 GET은 그것을 부른다(동작 불변 — `eval:streak`의 라우트 정적 검사가 읽는 파일 경로를 `lib/streak-server.ts`로 바꾼다). 같은 파일에 상태 변환을 추가:
```ts
export function pushStates(r: StreakResponse): PersonState[] {
  const s = (person: PushPerson, info: PersonStreak["info"], missing: string[] = []): PersonState => ({
    person,
    doneToday: info.doneToday,
    current: info.current,
    freezeLeft: info.freezeLeftThisMonth ?? 0,
    pendingRepairYesterday: info.pendingRepairDay === shiftDateString(r.today, -1),
    missingTracks: missing,
  });
  const appaDone = r.appaLanguage.info.doneToday || r.appaWorkout.info.doneToday;
  const appaMissing = [!r.appaLanguage.info.doneToday ? "어학" : null, !r.appaWorkout.info.doneToday ? "운동" : null].filter((x): x is string => x !== null);
  const out: PersonState[] = [s("eunwoo", r.eunwoo.info), { ...s("appa", r.appaLanguage.info, appaMissing), doneToday: appaDone }];
  if (r.mom) out.push(s("mom", r.mom.info));
  return out;
}
```

- [ ] **Step 5: PWA** — `app/manifest.ts`:
```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "은우학습",
    short_name: "은우학습",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/apple-icon.png", sizes: "180x180", type: "image/png" }, { src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
```
`public/sw.js`:
```js
// 알림 표시·클릭만 — 데이터·캐시 없음(PIN 게이트 밖 정적 파일이라 비밀을 두지 않는다)
self.addEventListener("push", (event) => {
  let msg = { title: "은우학습", body: "", url: "/" };
  try { msg = { ...msg, ...event.data.json() }; } catch (_) {}
  event.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, data: { url: msg.url }, icon: "/apple-icon.png" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) { c.navigate(url); return c.focus(); }
      return self.clients.openWindow(url);
    }),
  );
});
```
(`/manifest.webmanifest`·`/sw.js`는 `proxy.ts`의 `STATIC_FILE`(webmanifest·js)로 이미 공개다 — 확인만 한다.)

- [ ] **Step 6: 라우트**
  - `POST /api/push/subscribe` `{person, subscription: {endpoint, keys:{p256dh,auth}}, prefs}` → 검증(`isPushPerson`·endpoint `https://` 시작·키 문자열 ≤ 200자) → upsert → 200 `{ok:true}`. `DELETE` `{endpoint}` → delete. `GET` → `{publicKey: process.env.VAPID_PUBLIC_KEY ?? null}`(공개키는 비밀 아님). `pushConfigured()`가 아니면 POST/DELETE 501.
  - `POST /api/push/tick` — 헤더 `x-push-secret`를 `PUSH_CRON_SECRET`와 `crypto.timingSafeEqual`로 비교(비밀 없음·불일치 401). `today = kstTodayString()`, `nowHHMM` = KST 시:분(30분 내림). `computeStreakResponse` → `pushStates` → `listPushLog(today)` → `decidePushes` → 각 알림마다 `claimPushLog(\`${today}:${person}:${kind}:0\`)`가 true일 때만 그 사람 구독들에 `sendTo`, gone 삭제, ok `markPushOk`. 응답 `{ok:true, sent:n}`.
  - `POST /api/push/poke` `{from, to}`(PIN 게이트 안) → `to`가 오늘 아직이 아니면 409, `listPushLog(today)`로 `to`의 poke 수 ≥ `POKE_DAILY_MAX` 또는 전체 ≥ `PUSH_DAILY_MAX`면 429 → `claimPushLog(\`${today}:${to}:poke:${n}\`)` → `sendTo`.
  - `proxy.ts`: `PUBLIC_PATHS`에 `"/api/push/tick"`을 더하고 주석 "라우트가 x-push-secret으로 검사(PIN 대신)"를 단다.

- [ ] **Step 7: 설정 화면** — `components/push-settings.tsx`(client):
  - `"나는 누구"` 라디오(은우·아빠·엄마) — `localStorage` `push-person`에 기억.
  - 홈 화면 미설치 판별: `window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true`. 미설치 + iOS(`/iPhone|iPad/.test(navigator.userAgent)`)면 "Safari 공유 버튼 → 홈 화면에 추가 → 그 아이콘으로 열기" 3단계 안내만 보이고 켜기 버튼을 숨긴다.
  - "알림 켜기": `navigator.serviceWorker.register("/sw.js")` → `Notification.requestPermission()`(버튼 탭 안에서) → `GET /api/push/subscribe`로 공개키 → `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`(base64url → Uint8Array 변환 함수 포함) → `POST /api/push/subscribe`.
  - 시각 선택(08:00~22:00, 30분 단위 `<select>`)·가족 알림 체크박스 → 바뀌면 같은 POST로 prefs 갱신.
  - "알림 끄기": `subscription.unsubscribe()` + `DELETE`.
  - 키 없는 서버(501)면 "아직 알림 준비 중이에요" 한 줄.
  `app/family/settings/page.tsx`가 이것을 그리고, 가족 보드 머리에 "🔔 알림 설정" 링크, 오늘 블록의 아직인 사람 옆에 "👉 콕"(`POST /api/push/poke`, 응답 409·429·501이면 짧은 안내) — 콕 버튼은 `GET /api/push/subscribe`의 `publicKey`가 있을 때만 보인다.

- [ ] **Step 8: 로컬 검증(키 비움 → 501, 테스트 키 → 루프백)**
```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= APP_PIN= npx next dev -p 3917 &
curl -s -X POST localhost:3917/api/push/tick -o /dev/null -w '%{http_code}\n'             # 401 (비밀 없음)
curl -s -X POST localhost:3917/api/push/subscribe -H 'content-type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n'   # 501
```
그다음 `npx web-push generate-vapid-keys --json`으로 **로컬 전용** 키를 만들어 env로만 넘기고(파일에 쓰지 않는다), Playwright Chromium에서 `/family/settings` → 알림 켜기(권한 자동 허용 `context.grantPermissions(['notifications'])`) → `POST /api/push/tick`(비밀 헤더, `PUSH_CRON_SECRET=local-test`) → 서비스 워커 `push` 이벤트가 `showNotification`을 불렀는지 `page.evaluate`로 `registration.getNotifications()` 길이 확인. `data/db.json` 백업 → 끝나면 복원·sha 대조.

- [ ] **Step 9: 커밋**
```bash
npx tsc --noEmit -p . && npm run -s lint && OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run -s eval:streak | tail -1
git add app/manifest.ts public/sw.js app/api/push lib/push-send.ts lib/streak-server.ts app/api/streak/route.ts lib/store.ts lib/store-firestore.ts lib/prod-guard.ts proxy.ts package.json package-lock.json .env.example components/push-settings.tsx components/family-board.tsx app/family/settings/page.tsx scripts/eval-streak.ts
git commit -m "feat(push): PWA·구독 저장·30분 틱·콕 찌르기·알림 설정"
```

---

### Task 8: 운영 — 비밀값·스케줄러·실기기 (사용자 확인 단계)

**Files:**
- Modify: `.github/workflows/deploy.yml`(env 3개 전달), `docs/SPEC.md` §17-11(알림 운영 줄), `CLAUDE.md` 변경 이력 1행

- [ ] **Step 1: deploy.yml** — `gcloud run deploy` 의 `--set-env-vars`/`--update-secrets` 관용구(이 파일이 이미 쓰는 방식)대로 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`·`VAPID_SUBJECT`·`PUSH_CRON_SECRET`을 GitHub Secrets에서 넘긴다. 커밋만.

- [ ] **Step 2: 사용자 확인 후 실행(오케스트레이터)** — 아래를 사용자에게 보여 주고 승인받는다:
  1. `npx web-push generate-vapid-keys --json` → 값은 출력하지 않고 바로 `gh secret set VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`로(파이프), `VAPID_SUBJECT`=`mailto:<사용자 이메일>`, `PUSH_CRON_SECRET`=`openssl rand -hex 24`.
  2. 푸시 → 배포 완료 확인(`gh run watch --exit-status`).
  3. `gcloud scheduler jobs create http family-streak-push-tick --location=asia-northeast3 --schedule="0,30 8-22 * * *" --time-zone="Asia/Seoul" --http-method=POST --uri="https://<서비스 URL>/api/push/tick" --headers="x-push-secret=<값>"` (값은 셸 변수로, 화면 출력 금지).
  4. `gcloud scheduler jobs run family-streak-push-tick` 한 번 → Cloud Run 로그에 `{ok:true}` 확인.

- [ ] **Step 3: 실기기 확인 목록(세 폰)** — ① Safari → 홈 화면에 추가 → 아이콘으로 열기 → PIN ② `/family/settings`에서 나 고르기·알림 켜기(권한 창) ③ 다른 폰에서 콕 → 알림 도착·탭하면 해당 화면 ④ 그날 한 판 하면 그 사람의 남은 알림이 오지 않음 ⑤ 22:30 이후 무알림. 결과를 사용자에게 받아 SPEC §17-11에 "실기기 확인 YYYY-MM-DD" 한 줄.

- [ ] **Step 4: 문서·커밋** — CLAUDE.md 변경 이력 표(자동 블록 `<!-- BEGIN:nextjs-agent-rules -->` **위**)에 한 행 추가, SPEC §17-11 운영 줄.
```bash
git add .github/workflows/deploy.yml docs/SPEC.md CLAUDE.md
git commit -m "docs+ci: 가족 스트릭 알림 운영(비밀값 전달·스케줄러)"
```

---

## Self-Review 결과

- 스펙 커버리지: §2 → Task 2·3·4, §2-1 → Task 2(정의 정밀화, Task 3 Step 10에서 스펙 갱신), §3-1 → Task 4, §3-2 → Task 3, §3-3 → Task 5·7(콕), §4 → Task 1·3·5, §5 → Task 3, §6 → Task 6·7·8, §7 → 각 Task eval + Task 4·5·7 화면 확인 + Task 8 실기기, §8 순서 = Task 순서.
- 엄마 트랙(`mom`)은 ①에서 `null` 자리만 — ② 스펙에서 채운다(가족 조립·주간·배지·알림은 `mom`이 들어오면 그대로 동작하도록 이미 배선).
- 이름 일관성: `decideBridges`·`streakFromStatus`·`litDaysOf`·`personV2`·`trackV2`·`familyV2`·`reviewFullDays`·`decidePushes`·`pushStates`·`computeStreakResponse` — 정의 Task와 사용 Task 대조 완료.

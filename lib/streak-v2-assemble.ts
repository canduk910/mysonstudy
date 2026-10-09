/**
 * lib/streak-v2-assemble.ts — 트랙 → 사람 → 가족 조립(가족 스트릭 강화 스펙 §3·§4-2). 순수.
 * 카드·만회는 사람 단위로 한 번 정하고(아빠는 어학·운동 합쳐서 — `appaPersonV2`), 트랙 연속에 그대로 적용한다.
 */

import { computeStreakFromDays, type StreakInfo } from "./streak";
import { APPA_BOTH_FROM, STREAK_V2_FROM, decideBridges, litDaysOf, streakFromStatus, type Bridges, type StreakV2Info } from "./streak-v2";

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

/** 트랙들을 한 사람으로 합쳐 켜진 날·카드·만회를 정한다(판 수를 더한다 — 아빠는 이것 대신 appaPersonV2) */
export function personV2(tracks: readonly TrackInput[], today: string, from: string = STREAK_V2_FROM): PersonV2 {
  const merged = mergeTracks(tracks);
  const litDays = litDaysOf({ ...merged, from });
  const bridges = decideBridges({ ...merged, from, today });
  const info = streakFromStatus({ litDays, bridges, today, runsToday: merged.runs.get(today) ?? 0 });
  return { info, litDays, bridges, startDay: startDayOf(merged) };
}

function startDayOf(t: TrackInput): string | null {
  const all = [...t.legacyDays, ...[...t.runs].filter(([, n]) => n > 0).map(([d]) => d)].sort();
  return all[0] ?? null;
}

/**
 * 아빠 하루의 입력(2026-10-09 사용자 결정 — 아빠 스트릭 하나로). 순수.
 * - `bothFrom`(APPA_BOTH_FROM) **전** 날짜: 옛 규칙 그대로 — legacy = 어학 ∪ 운동, 판 수 = 어학 판 + 운동(지킨 날 1). 둘 중 하나면 켜진다.
 * - `bothFrom`**부터**: 그날 어학 한 판 ≥ 1 **그리고** 운동을 지킨 날일 때만 판 수 = 어학 판 수, 아니면 0.
 *   그래서 켜지려면 둘 다, 🔁 만회(D+1 두 판)는 운동을 지킨 날 + 어학 두 판이다. legacy(적용일 전 날짜)도 bothFrom부터는 교집합.
 * 운동의 "지킨 날"에는 계획된 휴식일이 들어 있다(workoutKeptDays) — 쉬는 날은 어학만으로 켜진다.
 */
export function appaInputV2(lang: TrackInput, gym: TrackInput, bothFrom: string = APPA_BOTH_FROM): TrackInput {
  const legacy = new Set<string>();
  for (const d of lang.legacyDays) if (d < bothFrom || gym.legacyDays.has(d)) legacy.add(d);
  for (const d of gym.legacyDays) if (d < bothFrom || lang.legacyDays.has(d)) legacy.add(d);
  const runs = new Map<string, number>();
  for (const d of new Set([...lang.runs.keys(), ...gym.runs.keys()])) {
    const l = lang.runs.get(d) ?? 0;
    const g = gym.runs.get(d) ?? 0;
    if (d < bothFrom) runs.set(d, l + g);
    else if (l >= 1 && g >= 1) runs.set(d, l);
  }
  return { legacyDays: legacy, runs };
}

/**
 * 아빠 사람 하나(헤드라인·보드·가족·알림이 함께 쓴다). bothFrom 전 날짜의 판정은 `personV2([lang, gym])`와 같다 —
 * 그래서 오늘(bothFrom 전)의 연속은 바뀌지 않고 앞으로의 날만 "둘 다"로 판정된다.
 * startDay(가족 참여 시작)는 규칙과 무관하게 어느 트랙이든 첫 기록일(운동만 한 날도 아빠는 이미 참여자다).
 */
export function appaPersonV2(lang: TrackInput, gym: TrackInput, today: string, from: string = STREAK_V2_FROM, bothFrom: string = APPA_BOTH_FROM): PersonV2 {
  const p = personV2([appaInputV2(lang, gym, bothFrom)], today, from);
  return { ...p, startDay: startDayOf(mergeTracks([lang, gym])) };
}

/**
 * 아빠 오늘 라벨(짧게) — 한 것 ✓ 먼저, 남은 것 뒤. 운동이 계획된 휴식일이면 "운동 쉬는 날"(그날은 어학만 하면 된다).
 * "어학 ✓ · 운동 ✓" / "어학 ✓ · 운동 남음" / "운동 ✓ · 어학 남음" / "어학·운동 남음" / "어학 ✓ · 운동 쉬는 날" / "운동 쉬는 날 · 어학 남음"
 */
export function appaTodayLabel(s: { lang: boolean; gym: boolean; gymRest: boolean }): string {
  const gymDone = s.gymRest ? "운동 쉬는 날" : "운동 ✓";
  if (s.lang && (s.gym || s.gymRest)) return `어학 ✓ · ${gymDone}`;
  if (s.lang) return "어학 ✓ · 운동 남음";
  if (s.gym || s.gymRest) return `${gymDone} · 어학 남음`;
  return "어학·운동 남음";
}

/** 트랙 연속 — 켜진 날은 트랙 자신의 것, 카드·만회는 사람이 정한 것 */
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

/**
 * 가족 — 그날 참여자(그날 ≥ startDay인 사람) 전원이 지킨 날. null(영역 없음)·기록 없는 사람은 참여자가 아니다.
 * doneToday = 오늘 참여자 전원 켜짐(만회 대기는 오늘이 될 수 없고 카드는 오늘 쓰지 않으므로 오늘은 켜졌을 때만 들어간다).
 */
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

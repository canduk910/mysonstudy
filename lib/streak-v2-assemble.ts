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

/** 트랙들을 한 사람으로 합쳐 켜진 날·카드·만회를 정한다(아빠 = 어학 ∪ 운동) */
export function personV2(tracks: readonly TrackInput[], today: string, from: string = STREAK_V2_FROM): PersonV2 {
  const merged = mergeTracks(tracks);
  const litDays = litDaysOf({ ...merged, from });
  const bridges = decideBridges({ ...merged, from, today });
  const info = streakFromStatus({ litDays, bridges, today, runsToday: merged.runs.get(today) ?? 0 });
  const all = [...merged.legacyDays, ...[...merged.runs].filter(([, n]) => n > 0).map(([d]) => d)].sort();
  return { info, litDays, bridges, startDay: all[0] ?? null };
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

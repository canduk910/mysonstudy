"use client";

/** 그만둔 판에만 보이는 한 줄 — 새 규칙(가족 스트릭 강화 스펙 §2-2): 한 판을 끝까지 해야 🔥가 켜진다 */
export default function StreakFinishHint({ partial }: { partial: boolean }) {
  if (!partial) return null;
  return <p className="t-caption text-ink-3" role="note">🔥 한 판을 끝까지 해야 오늘 불이 켜져요.</p>;
}

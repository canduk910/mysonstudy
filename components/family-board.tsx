"use client";

/**
 * 가족 보드(가족 스트릭 강화) — `/api/streak`를 헤드라인과 같은 방식(seq 가드·STREAK_REFRESH_EVENT)으로 읽어
 * 오늘 · 이번 주 · 기록 세 블록을 그린다. 보조 화면이라 실패는 조용히.
 * - 아빠 오늘 줄: 어학·운동 중 하나라도 했으면 ✓(둘 다면 어학 라벨).
 * - 아빠 운동 배지 줄: 운동 기록이 없으면(중립값) 숨긴다.
 */

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
const BADGE_NAME = { eunwoo: "은우", appaLanguage: "아빠 어학", appaWorkout: "아빠 운동", mom: "엄마", family: "가족" } as const;

function Today({ name, emoji, p }: { name: string; emoji: string; p: PersonStreak | null | undefined }) {
  if (!p) return null;
  const done = p.info.doneToday;
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
      <span className="t-body shrink-0 font-medium">
        {emoji} {name}
      </span>
      <span className="t-caption min-w-0 text-right text-ink-2">
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

  // 아빠 오늘 — 어학·운동 중 하나라도 했으면 ✓(둘 다면 어학 라벨). 둘 다 아직이면 어학(만회 대기 문구도 어학 기준).
  const appa: PersonStreak = data.appaLanguage.info.doneToday || !data.appaWorkout.info.doneToday ? data.appaLanguage : data.appaWorkout;
  const workoutNeutral = data.appaWorkout.info.current === 0 && data.appaWorkout.info.best === 0 && data.appaWorkout.todayLabel === null;
  const badges = data.badges.filter((b) => !(b.key === "appaWorkout" && workoutNeutral));
  const rows: { key: "eunwoo" | "appa" | "mom"; name: string }[] = [
    { key: "eunwoo", name: "은우" },
    { key: "appa", name: "아빠" },
    ...(data.week.rows.mom ? [{ key: "mom" as const, name: "엄마" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="t-book-title">👪 가족 보드</h1>
        <p className="t-body mt-1 text-ink-2">
          가족 🔥 {data.family.info.current}일 · 최고 {data.family.info.best}일
        </p>
      </header>
      <section aria-label="오늘">
        <h2 className="t-section-title mb-2">오늘</h2>
        <ul className="flex flex-col gap-2">
          <Today name="은우" emoji="🧒" p={data.eunwoo} />
          <Today name="아빠" emoji="🧑" p={appa} />
          <Today name="엄마" emoji="👩" p={data.mom} />
        </ul>
      </section>
      <section aria-label="이번 주">
        <h2 className="t-section-title mb-2">이번 주</h2>
        <table className="w-full table-fixed text-center">
          <thead>
            <tr>
              <th className="w-12" />
              {DOW.map((d, i) => (
                <th key={d} className={`t-caption ${data.week.days[i] === data.today ? "font-bold text-ink" : "text-ink-3"}`}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th className="t-caption text-left font-medium text-ink">{r.name}</th>
                {(data.week.rows[r.key] ?? []).map((c, i) => (
                  <td key={i} className="py-1" title={CELL[c].label} aria-label={`${DOW[i]} ${CELL[c].label}`}>
                    {CELL[c].icon}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="t-caption mt-2">🔥 했음 · 🧊 쉬는 날 카드 · 🔁 만회 · ⏳ 만회 대기 · ✗ 놓침</p>
      </section>
      <section aria-label="기록">
        <h2 className="t-section-title mb-2">기록</h2>
        <ul className="t-body flex flex-col gap-1">
          <li>
            🧊 이번 달 남은 쉬는 날 카드 — 은우 {data.eunwoo.info.freezeLeftThisMonth ?? 0}장 · 아빠 {data.appaLanguage.info.freezeLeftThisMonth ?? 0}장
            {data.mom ? ` · 엄마 ${data.mom.info.freezeLeftThisMonth ?? 0}장` : ""}
          </li>
          {badges.map((b) => (
            <li key={b.key}>
              🏅 {BADGE_NAME[b.key]} — {b.earned.length > 0 ? b.earned.map((n) => `${n}일`).join(" · ") : "아직 없음"}
            </li>
          ))}
        </ul>
        <p className="t-caption mt-2">
          {data.v2From}부터 한 판을 끝까지 해야 🔥가 켜져요. 하루를 놓치면 쉬는 날 카드(한 달 2장)가 자동으로 쓰이고, 카드가 없으면 다음 날 두 판으로 메울 수 있어요.
        </p>
      </section>
    </div>
  );
}

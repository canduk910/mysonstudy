"use client";

/**
 * 학습 스트릭 헤드라인 (SPEC §17-4) — 모든 화면 상단 고정. **은우와 아빠를 나란히** 대조해 습관을 자극한다.
 *
 * - `sticky top-0` + z는 10~19(카드 오버레이 z:20이 몰입 화면에서 덮는 게 의도). `print-hide`.
 * - `/unlock`에선 숨긴다. 데이터는 클라이언트가 `/api/streak`로 가져온다(초기 렌더는 중립 → 마운트 후 채움, hydration 안전).
 * - 시험 저장 성공 시 STREAK_REFRESH_EVENT로 즉시 갱신(성취감).
 * - 높이는 `--streak-h` 고정 — 영어 모바일 상단바(sticky top-0)가 이 높이만큼 내려가 겹치지 않는다(globals.css·english-nav.module.css).
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import type { PersonStreak, StreakResponse } from "@/lib/streak-contract";

function Person({ emoji, name, p }: { emoji: string; name: string; p: PersonStreak | undefined }) {
  const loaded = p != null;
  const done = p?.info.doneToday ?? false;
  const days = p?.info.current ?? 0;
  return (
    <div className={`flex items-center gap-1.5 whitespace-nowrap ${loaded && !done ? "opacity-55" : ""}`}>
      <span aria-hidden>{emoji}</span>
      <span className="t-caption font-medium text-ink">{name}</span>
      <span className="t-caption font-bold text-ink" aria-label={loaded ? `${days}일 연속` : undefined}>
        🔥{loaded ? days : "··"}일
      </span>
      {loaded && !done && <span className="t-caption text-ink-3">오늘 아직</span>}
      {loaded && done && p?.todayLabel && <span className="t-caption text-ink-3">· {p.todayLabel}</span>}
    </div>
  );
}

export default function StreakHeadline() {
  const pathname = usePathname();
  const [data, setData] = useState<StreakResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/streak", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as StreakResponse;
        if (alive) setData(json);
      } catch {
        /* 조용히 — 헤드라인은 보조 UI, 실패해도 앱은 정상 */
      }
    };
    void load();
    const onRefresh = () => void load(); // 시험 저장 직후 갱신
    window.addEventListener(STREAK_REFRESH_EVENT, onRefresh);
    return () => {
      alive = false;
      window.removeEventListener(STREAK_REFRESH_EVENT, onRefresh);
    };
  }, []);

  if (pathname === "/unlock") return null; // 잠금 화면엔 학습 현황을 보이지 않는다

  return (
    <div
      className="print-hide sticky top-0 z-[15] flex items-center gap-4 overflow-x-auto border-b border-line bg-bg px-3"
      style={{ height: "var(--streak-h)" }}
      aria-label="학습 스트릭"
    >
      <Person emoji="🧒" name="은우" p={data?.eunwoo} />
      <Person emoji="🧑" name="아빠" p={data?.appa} />
    </div>
  );
}

"use client";

/**
 * 학습 스트릭 헤드라인 (SPEC §17-4·§17-7) — 모든 화면 상단 고정. **은우와 아빠를 나란히** 대조해 습관을 자극한다.
 *
 * - 아빠 칸은 **두 트랙** `🗾 일본어` · `💪 운동` — 트랙마다 따로 흐리게/"오늘 아직"/짧은 라벨(§17-7).
 *   한 스트릭으로 합치지 않는다(합치면 운동만 한 날에 일본어가 이어져 보인다). 은우 칸 내용은 그대로(폰 축약만 공통).
 * - `sticky top-0` + z는 10~19(카드 오버레이 z:20이 몰입 화면에서 덮는 게 의도). `print-hide`.
 * - `/unlock`에선 숨긴다. 데이터는 클라이언트가 `/api/streak`로 가져온다(초기 렌더는 중립 → 마운트 후 채움, hydration 안전).
 * - 시험 저장·운동 기록/취소/사이클 시작 성공 시 STREAK_REFRESH_EVENT로 즉시 갱신(성취감).
 * - 높이는 `--streak-h` 고정·한 줄 — 넘치면 가로 스크롤, 긴 라벨은 말줄임.
 * - **폰(<640px)은 `이모지 (사람 이름) 🔥N일`만**(§17-7 폰 표시) — 360px 한 화면에 은우·일본어·운동 🔥가 다 보이게.
 *   "오늘 아직"·트랙 이름·오늘 라벨은 sm 이상에서만 보이고 폰에선 `max-sm:sr-only`(스크린리더엔 남음). 오늘 아직은 흐림이 신호.
 *   영어 모바일 상단바(sticky top-0)가 이 높이만큼 내려가 겹치지 않는다(globals.css·english-nav.module.css).
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
      <span className="t-caption font-bold text-ink" role={loaded ? "img" : undefined} aria-label={loaded ? `${name} ${days}일 연속` : undefined}>
        🔥{loaded ? days : "··"}일
      </span>
      {loaded && !done && <span className="t-caption text-ink-3 max-sm:sr-only">오늘 아직</span>}
      {loaded && done && p?.todayLabel && <span className="t-caption text-ink-3 max-sm:sr-only">· {p.todayLabel}</span>}
    </div>
  );
}

/** 아빠의 한 트랙 — 흐림·"오늘 아직"·라벨이 트랙마다 따로다(일본어는 했고 운동은 아직일 수 있다) */
function Track({ emoji, name, p }: { emoji: string; name: string; p: PersonStreak | undefined }) {
  const loaded = p != null;
  const done = p?.info.doneToday ?? false;
  const days = p?.info.current ?? 0;
  return (
    <div className={`flex shrink-0 items-center gap-1 whitespace-nowrap ${loaded && !done ? "opacity-55" : ""}`}>
      <span aria-hidden>{emoji}</span>
      {/* 폰에선 이모지(🗾·💪)가 트랙을 가른다 — 이름은 스크린리더에만 */}
      <span className="t-caption text-ink-2 max-sm:sr-only">{name}</span>
      <span className="t-caption font-bold text-ink" role={loaded ? "img" : undefined} aria-label={loaded ? `${name} ${days}일 연속` : undefined}>
        🔥{loaded ? days : "··"}일
      </span>
      {loaded && !done && <span className="t-caption text-ink-3 max-sm:sr-only">오늘 아직</span>}
      {loaded && done && p?.todayLabel && (
        // 긴 단어장 제목은 말줄임 — 전체는 title로. 폰에선 스크린리더에만(🔥가 한 화면에 들어오게)
        <span className="t-caption inline-block max-w-[11rem] truncate text-ink-3 max-sm:sr-only" title={p.todayLabel}>
          · {p.todayLabel}
        </span>
      )}
    </div>
  );
}

export default function StreakHeadline() {
  const pathname = usePathname();
  const [data, setData] = useState<StreakResponse | null>(null);

  useEffect(() => {
    let alive = true;
    let seq = 0; // 기록 직후 취소처럼 load()가 겹치면 늦게 온 옛 응답이 새 데이터를 덮지 않게 — 마지막 요청만 반영
    const load = async () => {
      const mine = ++seq;
      try {
        const res = await fetch("/api/streak", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as StreakResponse;
        if (alive && mine === seq) setData(json);
      } catch {
        /* 조용히 — 헤드라인은 보조 UI, 실패해도 앱은 정상 */
      }
    };
    void load();
    const onRefresh = () => void load(); // 시험 저장·운동 기록 직후 갱신
    window.addEventListener(STREAK_REFRESH_EVENT, onRefresh);
    return () => {
      alive = false;
      window.removeEventListener(STREAK_REFRESH_EVENT, onRefresh);
    };
  }, []);

  if (pathname === "/unlock") return null; // 잠금 화면엔 학습 현황을 보이지 않는다

  return (
    <div
      className="print-hide sticky top-0 z-[15] flex items-center gap-3 overflow-x-auto overflow-y-hidden border-b border-line bg-bg px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ height: "var(--streak-h)" }}
      role="group"
      aria-label="학습 스트릭 — 은우, 아빠(일본어·운동)"
    >
      <Person emoji="🧒" name="은우" p={data?.eunwoo} />
      {/* 두 사람 사이 — 기존 경계선 색(line)의 얇은 세로선 */}
      <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
      <div role="group" aria-label="아빠" className="flex shrink-0 items-center gap-2.5 whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          <span aria-hidden>🧑</span>
          <span className="t-caption font-medium text-ink">아빠</span>
        </span>
        <Track emoji="🗾" name="일본어" p={data?.appa} />
        <Track emoji="💪" name="운동" p={data?.appaWorkout} />
      </div>
    </div>
  );
}

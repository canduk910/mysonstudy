"use client";

/**
 * 배지 축하 토스트(가족 스트릭 강화 스펙 §4-1). 이 기기에서 아직 축하하지 않은 **얻은 배지**(`earned`)를 한 번 축하한다.
 * - `reachedToday`에 기대지 않는다 — 만회가 `current`를 문턱 너머로 한 번에 올리면 그날 숫자가 문턱과 같지 않고,
 *   끊겼다가 다시 문턱에 닿을 때는 다시 축하하지 않는다(얻은 배지는 최고 기록 기준).
 * - 한 번 불러올 때 토스트는 최대 하나(새로 얻은 숫자 중 가장 큰 것). 보여 준 뒤 **지금 얻은 배지 전부**를 축하함으로 적어
 *   처음 여는 기기가 이후에 옛 배지 토스트를 줄줄이 보지 않게 한다.
 * - 기록은 기기 localStorage `streak-celebrated:<key>:<n>` — 접근이 막히면 다시 보일 뿐이다(try/catch).
 */

import { useEffect, useState } from "react";

const NAME = { eunwoo: "은우", appaLanguage: "아빠 어학", appaWorkout: "아빠 운동", mom: "엄마", family: "가족" } as const;
type Badge = { key: keyof typeof NAME; earned: readonly number[] };

const storageKey = (key: string, n: number) => `streak-celebrated:${key}:${n}`;

function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function mark(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* 저장 실패 — 다음에 다시 보일 뿐 */
  }
}

export default function StreakCelebrate({ badges }: { badges: readonly Badge[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let best: { key: Badge["key"]; n: number } | null = null;
    for (const b of badges) {
      for (const n of b.earned) {
        if (!seen(storageKey(b.key, n)) && (best === null || n > best.n)) best = { key: b.key, n };
      }
    }
    if (!best) return;
    for (const b of badges) for (const n of b.earned) mark(storageKey(b.key, n));
    // 동기 setMsg — 표시는 타이머에 걸지 않는다(StrictMode 두 번 실행에서 첫 실행이 기록만 하고 표시가 지워지지 않게)
    setMsg(`🏅 ${NAME[best.key]} ${best.n}일 연속! 대단해요!`);
  }, [badges]);
  // 숨김은 메시지에 묶는다 — 새로고침 이벤트로 badges가 바뀌어도 토스트가 남지 않게
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div role="status" className="fixed inset-x-4 top-12 z-[16] mx-auto max-w-sm rounded-xl bg-ink px-4 py-3 text-center text-bg shadow-lg">
      {msg}
    </div>
  );
}

"use client";

/**
 * useToeicWakeLock — 모의고사 응시 중 화면 꺼짐 방지 훅 (docs/harness/toeic.md §6-4·§10)
 *
 * 운동 세션의 Wake Lock 관용구(components/workout-session.tsx)를 **따라 새로** 쓴다 — 운동 코드는 건드리지 않는다(§10).
 * - `active`인 동안 `navigator.wakeLock.request("screen")`. 미지원·거부는 조용히 넘어간다(시험은 약 20분이라 자동 잠금 방지가 필요하다).
 * - 화면이 다시 보이면(visibilitychange → visible) **재요청**한다 — 숨겨지면 브라우저가 잠금을 풀어 버린다.
 * - `onVisible`: visible 복귀 때 부를 콜백(응시 화면이 시계를 즉시 갱신하고 오디오 컨텍스트를 깨운다). 최신 콜백을 ref로 본다.
 * - 끄거나 언마운트하면 release.
 */

import { useEffect, useRef } from "react";

export function useToeicWakeLock(active: boolean, onVisible?: () => void): void {
  const onVisibleRef = useRef(onVisible);
  useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    const request = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        if (sentinel && !sentinel.released) return;
        const got = await navigator.wakeLock.request("screen");
        if (disposed) {
          void got.release().catch(() => {});
          return;
        }
        sentinel = got;
      } catch {
        /* 미지원·거부 — 조용히 넘어간다 */
      }
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      try {
        onVisibleRef.current?.();
      } catch {
        /* 콜백 예외는 잠금 재요청을 막지 않는다 */
      }
      void request();
    };
    void request();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}

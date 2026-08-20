"use client";

/**
 * 새 배포 감지 배너 (클라이언트) — 모든 화면 공통. `app/layout.tsx`가 붙인다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * 2026-08-20: 배포는 성공했는데 사용자 화면이 옛날 그대로였다. 캐시 헤더는
 * `next.config.ts`에서 고쳤지만, **홈 화면에 추가한 앱이나 며칠째 열려 있는 탭**은
 * 새로 문서를 받지 않으므로 옛 화면을 든 채로 남는다. 그래서 앱이 스스로 알아차린다.
 *
 * ── 동작 ────────────────────────────────────────────────────────────────────
 * 1. 화면이 뜨면 `/api/version`을 한 번 불러 **그 값을 기준(baseline)으로 삼는다.**
 * 2. 앱으로 **돌아올 때**(탭 전환·홈 화면에서 재진입 = `visibilitychange`,
 *    뒤로가기 복원 = `pageshow`) 다시 부른다.
 * 3. 값이 baseline과 다르면 배너를 띄운다.
 *
 * ── 하지 않는 것 (의도) ────────────────────────────────────────────────────
 * · **자동 새로고침 금지.** 아이가 문제를 풀거나 엄빠가 사진을 고르는 중에 화면이
 *   날아가면 배포 지연보다 나쁘다. 누르는 것은 사람이다.
 * · **폴링 금지.** 타이머로 서버를 두드리지 않는다. 확인 시점은 "앱으로 돌아왔을 때"
 *   뿐이고, 이 앱은 하루 몇 번 열리므로 그것으로 충분하다.
 * · **거짓 알림 금지.** 응답이 200이 아니거나(잠금 401 등) `buildId`가 `null`이면
 *   아무것도 하지 않는다. 모를 때는 조용한 쪽이 옳다.
 *
 * ── 남는 사각지대 ──────────────────────────────────────────────────────────
 * baseline이 "처음 받은 값"이므로, **문서 자체가 캐시에서 나온 옛 화면**이면 baseline이
 * 새 빌드로 잡혀 배너가 뜨지 않는다. 그 경우는 이 배너가 아니라 `next.config.ts`의
 * `private, no-cache`가 막는다(문서를 매번 재검증하게 한다). 두 장치가 짝이다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 이벤트가 몰아쳐도 원본을 연달아 두드리지 않도록 하는 최소 간격 */
const MIN_INTERVAL_MS = 5000;

interface VersionPayload {
  ok?: boolean;
  buildId?: string | null;
}

export default function VersionWatch() {
  /** 이 화면이 시작될 때의 빌드 — 비교 기준 */
  const baselineRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const lastCheckedAtRef = useRef(0);

  /** 배너를 띄우게 만든 새 빌드 ID (없으면 배너 없음) */
  const [freshBuildId, setFreshBuildId] = useState<string | null>(null);
  /** "나중에"를 누른 빌드 ID — 그보다 더 새 빌드가 오면 다시 띄운다 */
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastCheckedAtRef.current < MIN_INTERVAL_MS) return;

    inFlightRef.current = true;
    lastCheckedAtRef.current = now;
    try {
      const res = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return; // 잠금(401)·오류 → 모름으로 두고 조용히 넘어간다
      const data: VersionPayload = await res.json();
      const buildId = typeof data.buildId === "string" && data.buildId.length > 0 ? data.buildId : null;
      if (!buildId) return; // 서버가 자기 빌드를 모른다 → 판정하지 않는다

      if (baselineRef.current === null) {
        baselineRef.current = buildId;
        return;
      }
      if (buildId !== baselineRef.current) setFreshBuildId(buildId);
    } catch {
      // 오프라인·중단 — 다음 복귀 때 다시 본다
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void check();

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    // bfcache 복원(뒤로가기·홈 화면 앱 재진입)에서 visibilitychange가 안 오는 브라우저 대비
    const onPageShow = () => void check();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [check]);

  const visible = freshBuildId !== null && freshBuildId !== dismissedBuildId;
  if (!visible) return null;

  return (
    /**
     * 자리 잡는 방식: `sticky bottom-0`로 **문서 흐름 안 마지막 요소**다.
     * 자기 높이만큼 자리를 차지하므로 페이지 끝까지 내려도 마지막 줄이 가려지지 않고,
     * 스크롤 중에는 화면 아래에 붙어 보인다. (`fixed`는 자리를 안 만들어 끝줄을 먹는다)
     * 색은 흰 카드 + line 테두리 — 파랑은 "새로고침" 버튼 하나에만 쓴다(DESIGN §2:
     * 파랑은 강조 하나뿐이므로 배너 전체를 파랗게 칠하면 화면의 주인공이 뒤바뀐다).
     */
    <div className="print-hide sticky bottom-0 z-40 px-3 py-3">
      <div
        role="status"
        aria-live="polite"
        className="u-card mx-auto flex max-w-md flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3"
      >
        <div className="min-w-0">
          <p className="t-list-title">새 버전이 나왔어요</p>
          <p className="t-caption mt-0.5">엄빠, 지금 하던 게 끝나면 새로고침해 주세요.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className="u-navbtn" onClick={() => setDismissedBuildId(freshBuildId)}>
            나중에
          </button>
          <button type="button" className="u-btn u-btn-primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </div>
    </div>
  );
}

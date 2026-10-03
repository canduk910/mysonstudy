"use client";

/**
 * 인쇄(PDF 저장) 때 닫힌 접기를 펼치는 훅 — 토익 응시 결과(첨삭) 화면 인쇄(docs/harness/toeic.md §16, SPEC §20-14).
 *
 * 닫힌 `<details>`는 CSS만으로 내용이 인쇄되지 않는 브라우저가 있다(Safari·옛 Chrome). 그래서:
 * - 인쇄 대상 접기에 `data-print-expand`를 달아 두고, 인쇄 직전(`beforeprint` — 키보드 Cmd+P·브라우저 메뉴)과 인쇄 버튼 핸들러
 *   양쪽에서 **닫혀 있던 것만** 열어 "훅이 연 것"으로 기억한다(사용자가 열어 둔 접기는 건드리지 않는다). `afterprint`에서 기억한 것만 닫는다.
 * - **사용자 조작은 기억에서 뺀다**(QA print 1 F2) — 루트에서 `toggle`을 잡아, 훅이 바꾼 상태가 아닌 여닫기(사용자 탭)가 일어난 접기는
 *   기억에서 지운다. 그래서 iOS Safari처럼 `afterprint`가 오지 않아 훅이 연 접기가 열린 채 남아도: 사용자가 손대지 않았으면 다음 인쇄의
 *   `afterprint`가 닫고(훅이 연 것), 사용자가 닫았다가 다시 열었으면 사용자 것이라 닫지 않는다.
 * - 루트 안의 `loading="lazy"` 사진은 eager로 바꾼다. 버튼 경로는 기다릴 사진이 없으면 **클릭 핸들러 안에서 동기로** `window.print()`를
 *   부른다(iOS Safari·홈 화면 앱은 사용자 제스처 밖 print를 막을 수 있다). 안 받은 사진이 있을 때만 최대 `PRINT_IMAGE_WAIT_MS` 기다린 뒤
 *   부르고, 그사이 화면을 떠났으면(언마운트) 부르지 않는다(QA print 1 F3).
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 인쇄 때 펼칠 접기 표시 — `<details data-print-expand>` */
export const PRINT_EXPAND_ATTR = "data-print-expand";
/** 버튼 경로 — 안 받은 사진을 기다리는 최대 시간 */
export const PRINT_IMAGE_WAIT_MS = 4000;

/** 훅이 접기를 여닫는다 — 기대 상태를 먼저 적어 뒤따르는 `toggle`을 사용자 조작으로 보지 않게 */
function setOpen(expected: Map<HTMLDetailsElement, boolean>, d: HTMLDetailsElement, open: boolean) {
  expected.set(d, open);
  d.open = open;
}

export function usePrintExpand(rootRef: RefObject<HTMLElement | null>): { printNow: () => void; preparing: boolean } {
  /** 훅이 열었고 그 뒤 사용자가 손대지 않은 접기 */
  const openedRef = useRef(new Set<HTMLDetailsElement>());
  /** 훅이 바꾼 상태(접기 → 기대 open 값) — 뒤따르는 `toggle` 이벤트를 사용자 조작과 가른다 */
  const expectedRef = useRef(new Map<HTMLDetailsElement, boolean>());
  const aliveRef = useRef(true);
  const [preparing, setPreparing] = useState(false);

  const expand = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const d of Array.from(root.querySelectorAll<HTMLDetailsElement>(`details[${PRINT_EXPAND_ATTR}]`))) {
      if (!d.open) {
        setOpen(expectedRef.current, d, true);
        openedRef.current.add(d);
      }
    }
    for (const img of Array.from(root.querySelectorAll("img"))) if (img.loading === "lazy") img.loading = "eager";
  }, [rootRef]);

  const restore = useCallback(() => {
    for (const d of openedRef.current) if (d.isConnected && d.open) setOpen(expectedRef.current, d, false);
    openedRef.current.clear();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const root = rootRef.current;
    // toggle은 거품이 일지 않는다 — 캡처로 잡는다
    const onToggle = (e: Event) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.hasAttribute(PRINT_EXPAND_ATTR)) return;
      const exp = expectedRef.current.get(d);
      expectedRef.current.delete(d);
      if (exp !== undefined && d.open === exp) return; // 훅이 바꾼 것
      openedRef.current.delete(d); // 사용자 조작 — 이 접기는 이제 사용자 것
    };
    root?.addEventListener("toggle", onToggle, true);
    window.addEventListener("beforeprint", expand);
    window.addEventListener("afterprint", restore);
    return () => {
      aliveRef.current = false;
      root?.removeEventListener("toggle", onToggle, true);
      window.removeEventListener("beforeprint", expand);
      window.removeEventListener("afterprint", restore);
    };
  }, [expand, restore, rootRef]);

  const printNow = useCallback(() => {
    expand();
    const root = rootRef.current;
    const pending = root ? Array.from(root.querySelectorAll("img")).filter((img) => !img.complete) : [];
    if (pending.length === 0) {
      window.print(); // 클릭 핸들러 안 동기 호출(사용자 제스처 안)
      return;
    }
    setPreparing(true);
    const loaded = Promise.all(pending.map((img) => img.decode().catch(() => undefined)));
    const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, PRINT_IMAGE_WAIT_MS));
    void Promise.race([loaded, timeout]).then(() => {
      if (!aliveRef.current || !rootRef.current) return; // 기다리는 사이 화면을 떠났다 — 다른 화면에서 인쇄 창을 띄우지 않는다
      setPreparing(false);
      expand(); // 기다리는 사이 다시 닫았을 수 있다
      window.print();
    });
  }, [expand, rootRef]);

  return { printNow, preparing };
}

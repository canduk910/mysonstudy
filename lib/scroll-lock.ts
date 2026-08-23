/**
 * lib/scroll-lock.ts — 공용 body 스크롤 락 (참조 카운트로 중첩 안전).
 *
 * 왜 별도 모듈인가: 여러 오버레이(영어 셸 드로어·단어장 카드 오버레이·사진 크롭 모달)가
 * 각자 `document.body.style.overflow`를 저장/복원했다. 두 개가 겹치면 — 예: 단어장 상세에서
 * 드로어를 연 채 카드 오버레이가 뜨면 — 안쪽 락이 이미 "hidden"인 값을 저장했다가 그대로
 * 복원해, 둘 다 닫혀도 문서 스크롤이 영영 잠긴다(QA P2-1). 락을 한 곳으로 모아 **참조 카운트**로
 * 센다: 첫 락만 원래 overflow를 저장하고 hidden으로 바꾸며, 마지막 해제만 원래 값을 되돌린다.
 *
 * 런타임 의존성 0(브라우저 전역만). SSR(document 없음)에서는 no-op을 돌려준다.
 * React StrictMode의 이중 mount(effect→cleanup→effect)에도 카운트가 0으로 수렴한다.
 */

let lockCount = 0;
let savedOverflow = "";

/**
 * body 스크롤을 잠그고 **해제 함수**를 돌려준다.
 * 해제 함수는 여러 번 불려도 안전하다(멱등) — 한 락은 카운트를 정확히 1만 내린다.
 *
 * 사용: `useEffect`에서 열린 동안 잠그고 cleanup에서 해제한다.
 *   useEffect(() => { if (!open) return; return lockBodyScroll(); }, [open]);
 */
export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return; // 멱등 — 같은 해제 함수가 두 번 불려도 카운트를 한 번만 내린다
    released = true;
    lockCount -= 1;
    if (lockCount <= 0) {
      lockCount = 0;
      document.body.style.overflow = savedOverflow;
    }
  };
}

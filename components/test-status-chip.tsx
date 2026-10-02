/**
 * 목록 카드의 시험 응시 배지(SPEC §15-4) — 영어 단어장·일본어 단어장·토익 표현집·토익 공략 폴더가 같은 칩을 쓴다.
 *
 * 상태·문구는 서버가 `lib/test-status.ts`로 정해 넘긴다(오늘 판정은 요청 시점 KST 한 번 — SSR·클라이언트가 같은 값).
 * 이 컴포넌트는 모양만 가른다: 시험 전 = 점선·흐린 글자 / 오늘 = 강조 칩 / 지난 날 = 기본 칩. 새 CSS 없음(전역 `u-chip` + 토큰 유틸).
 * 훅·이벤트가 없어 서버·클라이언트 어느 쪽에서도 렌더된다("use client" 없음).
 */

import type { TestStatusBadge } from "@/lib/test-status";

export default function TestStatusChip({ badge }: { badge: TestStatusBadge }) {
  const tone =
    badge.state === "today" ? "u-chip-accent" : badge.state === "none" ? "border-dashed text-ink-3" : "";
  return (
    // 관리 모드 폰 폭(카드 약 200px)에서 긴 문구가 카드 밖으로 넘치지 않게 — 전역 u-chip의 nowrap을 이 칩만 풀고 폭을 카드에 묶는다(QA test-badge P2-A)
    <span className={`u-chip max-w-full whitespace-normal ${tone}`} data-testid="test-status" data-state={badge.state}>
      {badge.labelKo}
    </span>
  );
}

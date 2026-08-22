/**
 * 영어 공통 셸 `app/english/layout.tsx` (IA 재편) — 서버 컴포넌트.
 *
 * `/english/*` 아래 모든 화면(허브·북카드·단어장)을 같은 학습 셸로 감싼다. 실제 내비게이션은
 * 클라이언트 `<EnglishNav/>`가 그린다(lg↑ 좌측 사이드바 / lg미만 상단 버거→드로어). 여기서는
 * 셸 래퍼와 콘텐츠 영역만 잡는다 — 콘텐츠는 lg↑에서 사이드바 폭(15rem)만큼 밀리고, 각 페이지의
 * `mx-auto max-w-*`는 그 안에서 가운데 정렬된다(충돌 없음).
 *
 * 참고: 단어장 상세의 카드 오버레이(`position:fixed; z-index:20`)는 이 셸(z-index:10)을 덮는다 —
 * 카드 모드는 몰입이라 그게 맞고, 오버레이 안 "← 목록"으로 빠져나온다.
 */

import type { ReactNode } from "react";
import EnglishNav from "@/components/english-nav";
import s from "@/components/english-nav.module.css";

export default function EnglishLayout({ children }: { children: ReactNode }) {
  return (
    <div className={s.shell}>
      <EnglishNav />
      <div className={s.content}>{children}</div>
    </div>
  );
}

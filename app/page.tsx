/**
 * 과목 선택 `/` — 서버 컴포넌트(정적).
 *
 * 저장소가 과목 둘을 기른다(영어, 수학 = 수학코치). 접속하면 여기서 갈린다.
 * 영어는 그 아래 다시 북카드·단어장 두 학습 메뉴로 갈리므로, `/english`는 기능 없이
 * 그 둘을 고르는 **허브**다(북카드 홈은 `/english/books`, 단어장은 `/english/vocab`).
 * 이 화면(`/`)은 과목 갈림길만 담당하고 기능은 하나도 갖지 않는다.
 *
 * **탭 수**: 영어 사용자는 여기서 한 번 더 누르게 된다. 대신
 *   1) 영어를 주요(accent)·첫 번째 버튼으로 두고,
 *   2) 영어 화면들(`/library`·`/card/[id]`)의 "홈"은 `/`가 아니라 북카드 홈
 *      (`/english/books`)을 가리켜, 카드를 보다 돌아올 때는 이 화면을 지나지 않게 했다.
 *   3) `/english`(영어 허브)는 그 자체로 북마크·홈 화면 추가가 되는 주소다.
 *
 * 디자인: 새 스타일을 만들지 않는다 — 예전 홈의 큰 진입 버튼과 **같은 `.u-entry`**를
 * 그대로 쓴다(app/globals.css, docs/DESIGN.md §5). 버튼이 아니라 링크인 것만 다르다.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "은우학습",
  description: "영어책 학습 카드와 수학 문제 풀이 설명을 한곳에서.",
};

export default function SubjectPickerPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <p className="t-caption">은우학습</p>
        <h1 className="t-book-title mt-4">오늘은 무엇을 해볼까요?</h1>
        <p className="t-lead mt-1">과목을 골라 주세요. 언제든 여기로 돌아올 수 있어요.</p>
      </header>

      {/* 큰 진입 버튼 2개 — 이 화면의 전부. 주요(영어)만 accent 배경 (DESIGN §5) */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/english" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            📚
          </span>
          <span className="u-entry-title">영어</span>
          <span className="u-entry-desc">
            영어책 표지를 찍어 학습 카드를 만드는 북카드와, 단어장을 찍어 표·카드로 모으는 단어장
            정복. 서재에 읽은 책이 쌓여요.
          </span>
        </Link>

        <Link href="/math" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🔢
          </span>
          <span className="u-entry-title">수학 · 수학코치</span>
          <span className="u-entry-desc">
            문제를 입력하면 &lsquo;왜 그렇게 푸는지&rsquo;를 탐정 시간 · 되감기 · 다시 재생 3막으로
            설명해요. 문제집 사진으로 읽어 오는 건 준비 중이에요.
          </span>
        </Link>
      </div>
    </main>
  );
}

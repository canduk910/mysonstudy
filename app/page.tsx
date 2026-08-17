/**
 * 과목 선택 `/` — 서버 컴포넌트(정적).
 *
 * 저장소가 과목 둘을 기른다(영어 = 북카드, 수학 = 수학코치). 접속하면 여기서 갈린다.
 * 예전 홈(사진으로 만들기·책 이름으로 만들기·최근 카드)은 통째로 `/english`로 옮겼다 —
 * 이 화면은 갈림길만 담당하고 기능은 하나도 갖지 않는다.
 *
 * **탭 수**: 영어 사용자는 여기서 한 번 더 누르게 된다. 대신
 *   1) 영어를 주요(accent)·첫 번째 버튼으로 두고,
 *   2) 영어 화면들(`/library`·`/card/[id]`)의 "홈"은 `/`가 아니라 `/english`를 가리켜
 *      카드를 보다 돌아올 때는 이 화면을 지나지 않게 했다.
 *   3) `/english`는 그 자체로 북마크·홈 화면 추가가 되는 주소다(반복 사용 시 0탭).
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
          <span className="u-entry-title">영어 · 북카드</span>
          <span className="u-entry-desc">
            영어책 표지를 찍으면 단어·질문·활동이 담긴 학습 카드를 만들어요. 서재에 읽은
            책이 쌓여요.
          </span>
        </Link>

        <Link href="/math" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🔢
          </span>
          <span className="u-entry-title">수학 · 수학코치</span>
          <span className="u-entry-desc">
            문제집 사진으로 &lsquo;왜 그렇게 푸는지&rsquo;를 설명해요. 지금은 준비 중이에요.
          </span>
        </Link>
      </div>
    </main>
  );
}

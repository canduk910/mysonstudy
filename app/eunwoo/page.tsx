/**
 * 은우 허브 `/eunwoo` — 서버 컴포넌트(정적). 은우의 과목(영어·수학)을 고른다.
 * 카드 문구는 예전 홈(`/`)의 과목 카드를 그대로 옮겼다. 사람 판정은 lib/person-area.ts.
 * 영어(`/english`)는 그 아래 다시 북카드·단어장·자유대화를 고르는 허브다(SPEC §21).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "은우의 습관 · 은우학습",
  description: "은우의 영어(북카드·단어장·자유대화)와 수학코치.",
};

export default function EunwooHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <Link href="/" className="u-navbtn">
          ← 사람 선택
        </Link>
        <h1 className="t-book-title mt-4">🧒 은우의 습관</h1>
        <p className="t-lead mt-1">과목을 골라 주세요.</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/english" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            📚
          </span>
          <span className="u-entry-title">영어</span>
          <span className="u-entry-desc">
            영어책 표지를 찍어 학습 카드를 만드는 북카드, 단어장을 찍어 표·카드로 모으는 단어장
            정복, 그리고 Sunny 선생님과 영어로 이야기하는 자유대화.
          </span>
        </Link>

        <Link href="/math" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🔢
          </span>
          <span className="u-entry-title">수학 · 수학코치</span>
          <span className="u-entry-desc">
            문제집 사진을 찍거나 문제를 입력하면 &lsquo;왜 그렇게 푸는지&rsquo;를 탐정 시간 · 되감기 ·
            다시 재생 3막으로 설명해요. 답은 검산을 거쳐 보여 줘요.
          </span>
        </Link>
      </div>
    </main>
  );
}

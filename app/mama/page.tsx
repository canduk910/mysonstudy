/**
 * 엄마 허브 `/mama` — 서버 컴포넌트(정적). 엄마의 과목을 고른다(지금은 생활영어 하나 — 그래도 목록 화면으로 둔다).
 * 카드 문구는 예전 홈(`/`)의 과목 카드를 그대로 옮겼다. 사람 판정은 lib/person-area.ts.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "엄마의 습관 · 은우학습",
  description: "엄마의 생활영어 — 소리 블록 틀로 듣고 따라 하고 말하기.",
};

export default function MamaHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <Link href="/" className="u-navbtn">
          ← 사람 선택
        </Link>
        <h1 className="t-book-title mt-4">👩 엄마의 습관</h1>
        <p className="t-lead mt-1">과목을 골라 주세요.</p>
      </header>

      <div className="grid gap-3">
        <Link href="/mom" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            👩
          </span>
          <span className="u-entry-title">엄마의 생활영어</span>
          <span className="u-entry-desc">하루 5분부터 — 소리 블록 틀로 듣고 따라 하고 말해 봐요.</span>
        </Link>
      </div>
    </main>
  );
}

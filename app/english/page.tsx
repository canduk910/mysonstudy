/**
 * 영어 허브 `/english` (IA 재편) — 서버 컴포넌트(정적).
 *
 * 영어 아래 두 학습(북카드·단어장)을 동등 레벨로 고르는 진입 화면이다. 예전엔 이 경로가
 * "영어 랜딩 + 북카드 홈"을 겸했으나(단어장이 부차 링크로 얹혀 있었다), 이제 북카드 홈은
 * `/english/books`로 옮기고 여기는 **환영 + 카드 2개**만 담는다.
 *
 * 상단 내비(← 과목 선택·서재)는 공통 셸(`app/english/layout.tsx`)이 담당하므로 여기서는 자체
 * 헤더 알약을 두지 않는다. 큰 진입 버튼은 루트 과목 선택과 **같은 `.u-entry`** 관용구를 쓴다
 * (새 스타일 없음, app/globals.css / docs/DESIGN.md §5).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "영어 · 은우학습",
  description: "북카드로 책을 읽고, 단어장으로 단어를 정복해요.",
};

export default function EnglishHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <p className="t-caption">영어</p>
        <h1 className="t-book-title mt-4">무엇을 해볼까요?</h1>
        <p className="t-lead mt-1">북카드와 단어장 중에서 골라 주세요.</p>
      </header>

      {/* 큰 진입 버튼 2개 — 루트 과목 선택과 같은 .u-entry. 북카드를 주요(accent)로 둔다 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/english/books" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            📚
          </span>
          <span className="u-entry-title">북카드</span>
          <span className="u-entry-desc">
            영어책 표지를 찍으면 단어·질문·활동이 담긴 학습 카드를 만들어요. 서재에 읽은 책이
            쌓여요.
          </span>
        </Link>

        <Link href="/english/vocab" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            📓
          </span>
          <span className="u-entry-title">단어장 정복</span>
          <span className="u-entry-desc">
            단어장을 찍으면 단어·뜻·예문을 카드와 표로 모아 둬요. 단어·문장 발음도 들을 수 있어요.
          </span>
        </Link>
      </div>
    </main>
  );
}

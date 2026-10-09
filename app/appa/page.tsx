/**
 * 아빠 허브 `/appa` — 서버 컴포넌트(정적). 아빠의 과목(일본어·영어(토익스피킹)·운동)을 고른다.
 * 카드 문구는 예전 홈(`/`)의 과목 카드를 그대로 옮겼다. 사람 판정은 lib/person-area.ts.
 * 아빠의 영어(토익스피킹, `/toeic`)는 은우의 영어(`/english`)와 다른 과목이다(toeic.md §0-1).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "아빠의 습관 · 은우학습",
  description: "아빠의 일본어, 영어(토익스피킹), 운동.",
};

export default function AppaHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <Link href="/" className="u-navbtn">
          ← 사람 선택
        </Link>
        <h1 className="t-book-title mt-4">🧑 아빠의 습관</h1>
        <p className="t-lead mt-1">과목을 골라 주세요.</p>
      </header>

      {/* 일본어·영어가 윗줄, 운동이 아랫줄 한 칸 전체(sm:col-span-2) — 예전 홈의 아빠 줄 그대로 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/japanese" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🗾
          </span>
          <span className="u-entry-title">아빠의 일본어</span>
          <span className="u-entry-desc">
            아빠가 일본어를 공부하는 곳. JLPT 단어장을 레벨·주제로 만들고, 듀오링고 대화를 찍어 복습해요.
          </span>
        </Link>

        <Link href="/toeic" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🎙️
          </span>
          <span className="u-entry-title">아빠의 영어 · 토익스피킹</span>
          <span className="u-entry-desc">
            아빠가 토익스피킹을 준비하는 곳. 표현집을 찍거나 파일로 넣어 발화 포인트와 함께 외우고, 소리 내어 말하는 시험을 봐요.
          </span>
        </Link>

        <Link href="/workout" className="u-entry u-entry-secondary sm:col-span-2">
          <span className="u-entry-icon" aria-hidden>
            💪
          </span>
          <span className="u-entry-title">아빠의 운동</span>
          <span className="u-entry-desc">
            러시안 파이터 풀업·푸시업 사다리 — 오늘 할 세트를 계산해 주고, 기록하면 다음 날을 정해요.
          </span>
        </Link>
      </div>
    </main>
  );
}

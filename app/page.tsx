/**
 * 사람 선택 `/` — 서버 컴포넌트(정적).
 *
 * 접속하면 여기서 **사람**이 갈린다 — 🧒 은우(`/eunwoo`) · 👩 엄마(`/mama`) · 🧑 아빠(`/appa`). 과목은 각 사람 허브가 나열한다
 * (은우: 영어·수학 / 엄마: 생활영어 / 아빠: 일본어·영어(토익스피킹)·운동). 가족 보드(`/family`)는 사람이 아니라 가족 전체라
 * 사람 카드 아래 따로 둔다. 경로 → 사람 판정은 lib/person-area.ts 한 곳이다(상단 "누구 습관" 표시줄과 공유).
 * 은우의 "영어"(`/english`)와 아빠의 영어(토익스피킹, `/toeic`)는 다른 과목이다(toeic.md §0-1) — 사람이 먼저 갈리니 섞일 일이 없다.
 *
 * 디자인: 새 스타일을 만들지 않는다 — 같은 `.u-entry`(app/globals.css, docs/DESIGN.md §5). 은우만 주요(accent).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "은우학습",
  description: "은우의 영어·수학, 엄마의 생활영어, 아빠의 일본어·영어(토익스피킹)·운동을 한곳에서.",
};

export default function PersonPickerPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <p className="t-caption">은우학습</p>
        <h1 className="t-book-title mt-4">누구의 습관을 할까요?</h1>
        <p className="t-lead mt-1">사람을 고르면 그 사람의 과목이 나와요. 언제든 여기로 돌아올 수 있어요.</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Link href="/eunwoo" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            🧒
          </span>
          <span className="u-entry-title">은우</span>
          <span className="u-entry-desc">영어(북카드·단어장·자유대화)와 수학코치.</span>
        </Link>

        <Link href="/mama" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            👩
          </span>
          <span className="u-entry-title">엄마</span>
          <span className="u-entry-desc">엄마의 생활영어 — 하루 5분 소리 블록.</span>
        </Link>

        <Link href="/appa" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🧑
          </span>
          <span className="u-entry-title">아빠</span>
          <span className="u-entry-desc">일본어, 영어(토익스피킹), 운동.</span>
        </Link>

        {/* 가족 보드 — 오늘·이번 주·쉬는 날 카드·가족 연속일(가족 스트릭 강화), 한 줄 전체 */}
        <Link href="/family" className="u-entry u-entry-secondary sm:col-span-3">
          <span className="u-entry-icon" aria-hidden>
            👪
          </span>
          <span className="u-entry-title">가족 보드</span>
          <span className="u-entry-desc">오늘 누가 했는지, 이번 주 불꽃과 쉬는 날 카드, 가족 연속일을 한눈에 봐요.</span>
        </Link>
      </div>
    </main>
  );
}

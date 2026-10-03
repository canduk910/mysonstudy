/**
 * 아빠의 일본어 — 오늘의 복습 `/japanese/review` (SPEC §23-7). 서버 컴포넌트가 오늘 큐를 만들어(lib/review-server) 러너에 넘긴다.
 * AI 없음. 큐는 서버가 한 번 고정한다(hydration 안전) — 다시 열면 그때 다시 계산한다. 표현 도우미는 이 경로에서 막힌다(lib/phrase-helper-scope).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ReviewRunner from "@/components/review-runner";
import { kstTodayString } from "@/lib/kst";
import { loadReviewQueue } from "@/lib/review-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "아빠의 일본어 · 오늘의 복습 — 은우학습",
};

export default async function ReviewPage() {
  const q = await loadReviewQueue("japanese", kstTodayString());
  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese" className="u-navbtn">
            ← 일본어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📅 오늘의 복습</h1>
        <p className="t-lead mt-1">다시 읽지 말고 가린 채 떠올리세요. 힌트를 늦게 열수록 다음 복습이 멀어져요.</p>
      </header>
      <ReviewRunner
        area="japanese"
        tone="adult"
        cards={q.cards}
        doneToday={q.doneToday}
        dueCount={q.dueCount}
        cap={q.cap}
        failedSources={q.failedSources}
        backHref="/japanese"
        backLabel="일본어로 돌아가기"
      />
    </main>
  );
}

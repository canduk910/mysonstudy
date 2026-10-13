/**
 * 아빠의 영어 — 오늘의 복습 `/toeic/review` (SPEC §23-7). 서버 컴포넌트가 오늘 큐를 만들어(lib/review-server) 러너에 넘긴다.
 * 큐 자체는 AI 없이 만든다. 답변 섬 문장 가운데 한국어 해석이 빠진 것이 있으면 그 자리에서 한 묶음만 채워 단서에 반영한다
 * (best-effort · 최대 10초 — 키 없음·실패·지연이면 옛 단서 그대로, toeic.md §21-7). 큐는 서버가 한 번 고정한다(hydration 안전) — 다시 열면 그때 다시 계산한다. 표현 도우미는 이 경로에서 막힌다(lib/phrase-helper-scope).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ReviewRunner from "@/components/review-runner";
import { kstTodayString } from "@/lib/kst";
import { loadReviewQueue } from "@/lib/review-server";
import { fillIslandTranslationsForReview } from "@/lib/toeic-island-translate-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "아빠의 영어 · 오늘의 복습 — 은우학습",
};

export default async function ReviewPage() {
  const today = kstTodayString();
  let q = await loadReviewQueue("toeic", today);
  // 답변 섬 해석 채우기(부수 효과 — 던지지 않는다). 하나라도 붙었을 때만 큐를 다시 만들어 단서에 반영한다
  if (await fillIslandTranslationsForReview(q.cards)) {
    q = await loadReviewQueue("toeic", today).catch(() => q);
  }
  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📅 오늘의 복습</h1>
        <p className="t-lead mt-1">다시 읽지 말고 가린 채 떠올리세요. 힌트를 늦게 열수록 다음 복습이 멀어져요.</p>
      </header>
      <ReviewRunner
        area="toeic"
        tone="adult"
        cards={q.cards}
        doneToday={q.doneToday}
        dueCount={q.dueCount}
        cap={q.cap}
        failedSources={q.failedSources}
        backHref="/toeic"
        backLabel="아빠의 영어로 돌아가기"
      />
    </main>
  );
}

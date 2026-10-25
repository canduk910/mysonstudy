/**
 * 은우 영어 — 오늘의 복습 `/english/review` (SPEC §23-7·§23-11). 서버 컴포넌트가 오늘 큐를 만들고(lib/review-server), 카드마다
 * **영단어 5지선다**를 붙여(lib/review-sources `buildEnglishReviewQuiz` — 보기·순서는 오늘 날짜 시드로 고정) 시험 러너에 넘긴다.
 * 은우는 힌트 사다리·스스로 판정 대신 단어장 시험과 같은 "문제 맞히기"다 — 첫 선택으로 앱이 채점한다(lib/review-quiz).
 * AI 없음. 큐는 서버가 한 번 고정한다(hydration 안전) — 다시 열면 그때 다시 계산한다. 표현 도우미는 이 경로에서 막힌다(lib/phrase-helper-scope).
 */

import type { Metadata } from "next";
import ReviewQuizRunner from "@/components/review-quiz-runner";
import { kstTodayString } from "@/lib/kst";
import { loadReviewQueue } from "@/lib/review-server";
import { buildEnglishReviewQuiz } from "@/lib/review-sources";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "은우 영어 · 오늘의 복습 — 은우학습",
};

export default async function ReviewPage() {
  const today = kstTodayString();
  // 보기는 단어장 단어로 만든다 — 큐 읽기와 같은 목록(englishWordItems가 읽는 listVocabBooks). 못 읽으면 문제를 못 만든다(skipped로 안내)
  const [q, books] = await Promise.all([loadReviewQueue("english", today), getStore().listVocabBooks().catch(() => [])]);
  const quiz = buildEnglishReviewQuiz(q.cards, books, today);
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <p className="t-caption">영어</p>
        <h1 className="t-book-title mt-4">📅 오늘의 복습</h1>
        <p className="t-lead mt-1">전에 시험 본 단어예요. 뜻을 읽고 알맞은 단어를 골라요.</p>
      </header>
      <ReviewQuizRunner
        questions={quiz.questions}
        skipped={quiz.skipped}
        doneToday={q.doneToday}
        dueCount={q.dueCount}
        cap={q.cap}
        failedSources={q.failedSources}
        backHref="/english"
        backLabel="영어로 돌아가기"
      />
    </main>
  );
}

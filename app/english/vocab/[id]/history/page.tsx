/**
 * 시험 응시기록 — DAY 안 `/english/vocab/[id]/history` (V8) — 서버 컴포넌트.
 *
 * 그 DAY의 시험 세션(`listVocabQuizzes`, startedAt 오름차순)을 **최근순으로 뒤집어** 클라이언트 화면
 * (`components/vocab-quiz-history-view.tsx`)에 넘긴다. **저장된 `VocabQuizRecord`를 읽어 보여주기만** 한다
 * (AI·스토어 스키마 변경 0, 집계는 화면이 읽을 때 계산 — 오답노트 `/wrong`과 같은 규약).
 *
 * 존재·렌더 판정은 상세/시험/오답노트와 **같은 함수**(lib/vocabbook-record.ts) — 404 규약·generateMetadata 관용구 동일.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabQuizHistoryView, {
  type QuizHistorySession,
} from "@/components/vocab-quiz-history-view";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface HistoryPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: HistoryPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} 시험 기록 — 은우 북카드` };
}

export default async function VocabHistoryPage({ params }: HistoryPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) notFound();

  // listVocabQuizzes는 startedAt 오름차순 — 화면은 최근순이라 뒤집는다(집계는 화면이 계산, 순서 의존 없음).
  const quizzes = await store.listVocabQuizzes(id);
  const sessions: QuizHistorySession[] = [...quizzes].reverse().map((q) => ({
    id: q.id,
    mode: q.mode,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    items: q.items.map((it) => ({ word: it.word, correct: it.correct, answered: it.answered })),
  }));

  const header = (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/english/vocab/${id}`} className="u-navbtn">
          ← 단어장으로
        </Link>
        <p className="t-caption flex-none">시험 기록</p>
      </div>
      <h1 className="t-book-title mt-4">📊 {record.titleKo}</h1>
      <p className="t-lead mt-1">
        지금까지 본 단어 시험을 모아 봤어요.
        {record.dayLabel && record.dayLabel !== record.titleKo ? ` · ${record.dayLabel}` : ""}
      </p>
      <div className="mt-3">
        <Link href="/english/vocab/history" className="u-btn u-btn-secondary">
          <span aria-hidden>🗂️</span> 모든 단어장 기록 보기
        </Link>
      </div>
    </header>
  );

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {header}
      {sessions.length === 0 ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📊✨
          </p>
          <h2 className="t-section-title mt-2">아직 시험 기록이 없어요</h2>
          <p className="t-lead mt-2">
            단어장에서 <b>시험</b>을 보면, 응시한 기록이 여기에 쌓여요. 한 번 풀어 볼까요?
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/english/vocab/${id}/quiz`} className="u-btn u-btn-primary">
              <span aria-hidden>📝</span> 시험 보기
            </Link>
            <Link href={`/english/vocab/${id}`} className="u-btn u-btn-secondary">
              <span aria-hidden>📖</span> 단어장으로
            </Link>
          </div>
        </section>
      ) : (
        <VocabQuizHistoryView sessions={sessions} scope="book" />
      )}
    </main>
  );
}

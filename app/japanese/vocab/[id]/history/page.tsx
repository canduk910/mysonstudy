/**
 * 일본어 시험 기록 `/japanese/vocab/[id]/history` (아빠의 일본어 J2, §6-2) — 서버 컴포넌트.
 *
 * 그 단어장의 시험 세션(listJaQuizzes, startedAt 오름차순)을 **최근순으로 뒤집어** 클라이언트 화면에 넘긴다.
 * 저장된 레코드를 읽어 보여주기만 한다(집계는 화면이 읽을 때 계산). 영어 시험 기록과 같은 골격. AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaQuizHistoryView, { type JaHistorySession } from "@/components/ja-quiz-history-view";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface HistoryPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: HistoryPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) return { title: "단어장을 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `${record.titleKo} 시험 기록 — 아빠의 일본어` };
}

export default async function JaHistoryPage({ params }: HistoryPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) notFound();

  const quizzes = await store.listJaQuizzes(id);
  // listJaQuizzes는 startedAt 오름차순 — 화면은 최근순이라 뒤집는다(집계는 순서 무관).
  const sessions: JaHistorySession[] = [...quizzes].reverse().map((q) => ({
    id: q.id,
    mode: q.mode,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    items: q.items.map((it) => ({ word: it.word, correct: it.correct, answered: it.answered })),
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/japanese/vocab/${id}`} className="u-navbtn">
            ← 단어장으로
          </Link>
          <p className="t-caption flex-none">시험 기록</p>
        </div>
        <h1 className="t-book-title mt-4">📊 {record.titleKo}</h1>
        <p className="t-lead mt-1">지금까지 본 시험을 방식 배지와 함께 모아 봤어요.</p>
      </header>

      {sessions.length === 0 ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>📊✨</p>
          <h2 className="t-section-title mt-2">아직 시험 기록이 없어요</h2>
          <p className="t-lead mt-2">시험을 보면 응시한 기록이 여기에 쌓여요.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/japanese/vocab/${id}/quiz`} className="u-btn u-btn-primary">📝 시험 보기</Link>
            <Link href={`/japanese/vocab/${id}`} className="u-btn u-btn-secondary">📖 단어장으로</Link>
          </div>
        </section>
      ) : (
        <JaQuizHistoryView sessions={sessions} />
      )}
    </main>
  );
}

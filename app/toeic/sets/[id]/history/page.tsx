/**
 * 표현 시험 기록 `/toeic/sets/[id]/history` (아빠의 영어 T2, docs/harness/toeic.md §6-2) — 서버 컴포넌트.
 *
 * 그 세트의 시험 세션(listToeicQuizzes, startedAt 오름차순)을 **최근순으로 뒤집어** 클라이언트 화면에 넘긴다. 저장된 레코드를
 * 보여주기만 한다(모드 배지·점수·중단·문항별 O/X, 시각은 KST — lib/kst 단일 정의). 일본어 시험 기록 골격. AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicQuizHistoryView, { type ToeicHistorySession } from "@/components/toeic-quiz-history-view";
import { getStore } from "@/lib/store";
import { toeicItemKeyLabel } from "@/lib/toeic-quiz-contract";
import { isRenderableToeicSet } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

interface HistoryPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: HistoryPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) return { title: "표현집을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${record.titleKo} 시험 기록 — 아빠의 영어` };
}

export default async function ToeicHistoryPage({ params }: HistoryPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) notFound();

  const quizzes = await store.listToeicQuizzes(id);
  const sessions: ToeicHistorySession[] = [...quizzes].reverse().map((q) => ({
    id: q.id,
    mode: q.mode,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    items: q.items.map((it) => ({ label: toeicItemKeyLabel(it.word), correct: it.correct, answered: it.answered })),
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/toeic/sets/${id}`} className="u-navbtn">
            ← 표현집으로
          </Link>
          <p className="t-caption flex-none">시험 기록</p>
        </div>
        <h1 className="t-book-title mt-4">📊 {record.titleKo}</h1>
        <p className="t-lead mt-1">지금까지 본 시험을 방식 배지와 함께 모아 봤어요.</p>
      </header>

      {sessions.length === 0 ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📊✨
          </p>
          <h2 className="t-section-title mt-2">아직 시험 기록이 없어요</h2>
          <p className="t-lead mt-2">시험을 보면 응시한 기록이 여기에 쌓여요.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/toeic/sets/${id}/quiz`} className="u-btn u-btn-primary">
              📝 시험 보기
            </Link>
            <Link href={`/toeic/sets/${id}`} className="u-btn u-btn-secondary">
              📒 표현집으로
            </Link>
          </div>
        </section>
      ) : (
        <ToeicQuizHistoryView sessions={sessions} />
      )}
    </main>
  );
}

/**
 * 일본어 오답노트 `/japanese/vocab/[id]/wrong` (아빠의 일본어 J2, §6-2) — 서버 컴포넌트.
 *
 * 그 단어장의 시험 세션을 `aggregateJaStatsByMode`로 **모드별로 갈라** 접고, 모드마다 틀리고 미졸업인 단어를
 * 만들어 클라이언트 탭 화면에 넘긴다. 집계는 저장하지 않고 읽을 때 계산(영어 규약). AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaQuizWrongView, {
  type JaWrongModeGroup,
} from "@/components/ja-quiz-wrong-view";
import { JA_QUIZ_CONTENT_MODES, aggregateJaStatsByMode } from "@/lib/ai/japanese/quiz";
import { isStatMastered } from "@/lib/vocab-mastery";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface WrongPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: WrongPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) return { title: "단어장을 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `${record.titleKo} 오답노트 — 아빠의 일본어` };
}

export default async function JaWrongPage({ params }: WrongPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) notFound();

  const quizzes = await store.listJaQuizzes(id);
  const byMode = aggregateJaStatsByMode(quizzes);

  const groups: JaWrongModeGroup[] = JA_QUIZ_CONTENT_MODES.map((mode) => {
    const stats = byMode[mode] ?? {};
    let attempted = 0;
    let mastered = 0;
    const words: JaWrongModeGroup["words"] = [];
    for (const e of record.entries) {
      const st = stats[e.word];
      if (!st || st.total === 0) continue;
      attempted += 1;
      if (isStatMastered(st)) mastered += 1;
      else if (st.wrong > 0) {
        words.push({ word: e.word, wordTokens: e.wordTokens, kana: e.kana, meaningsKo: e.meaningsKo, wrong: st.wrong });
      }
    }
    return { mode, attempted, mastered, words };
  });

  const anyAttempted = groups.some((g) => g.attempted > 0);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/japanese/vocab/${id}`} className="u-navbtn">
            ← 단어장으로
          </Link>
          <p className="t-caption flex-none">오답노트</p>
        </div>
        <h1 className="t-book-title mt-4">📕 {record.titleKo}</h1>
        <p className="t-lead mt-1">
          방식(뜻·독음·빈칸)마다 따로 봐요 — 뜻은 아는데 독음이 약한 곳이 바로 보여요.
        </p>
      </header>

      {!anyAttempted ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>📝✨</p>
          <h2 className="t-section-title mt-2">아직 오답이 없어요</h2>
          <p className="t-lead mt-2">시험을 보면 틀린 단어가 방식별로 여기에 모여요.</p>
          <div className="mt-6 flex justify-center">
            <Link href={`/japanese/vocab/${id}/quiz`} className="u-btn u-btn-primary">📝 시험 보기</Link>
          </div>
        </section>
      ) : (
        <JaQuizWrongView id={id} groups={groups} />
      )}
    </main>
  );
}

/**
 * 단어장 시험 `/english/vocab/[id]/quiz` (단어장 정복 V4) — 서버 컴포넌트.
 *
 * 저장된 DAY 하나를 읽어, **영영 정의가 있는 단어(definitionEn !== null)만** 문제 풀로 골라
 * 클라이언트 시험 화면(`components/vocab-quiz-view.tsx`)에 넘긴다. 진행·채점·저장은 전부
 * 클라이언트에서 돈다 — 이 서버 컴포넌트는 데이터 로딩·404 판정·**게이트**만 맡는다.
 *
 * ── 게이트 (계획 §V4) ───────────────────────────────────────────────────────
 * 시험은 V3에서 만든 정의에 의존한다. 정의 있는 단어가 최소치(5, 5지선다라 정답1+오답4)에
 * 못 미치면 문제를 낼 수 없으므로, "먼저 정의를 만들어 주세요"로 막고 상세로 돌아가는 링크를 준다.
 * (진입 버튼은 상세에서 enriched일 때만 뜨지만, URL 직접 진입도 여기서 정직하게 막는다.)
 *
 * 존재·렌더 판정은 상세/보강과 **같은 함수**(lib/vocabbook-record.ts) — 갈리면 "목록엔 보이는데
 * 눌렀더니 500"이 된다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabQuizView from "@/components/vocab-quiz-view";
import { MIN_QUIZ_WORDS } from "@/lib/vocab-quiz";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface QuizPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: QuizPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} 시험 — 은우 북카드` };
}

export default async function VocabQuizPage({ params }: QuizPageProps) {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) notFound();

  // 문제 풀 = 영영 정의가 있는 단어만(정의가 곧 문제). 오답 후보는 DAY 전체 단어.
  const pool = record.entries
    .filter((e) => e.definitionEn !== null)
    .map((e) => ({ word: e.word, definitionEn: e.definitionEn as string }));
  const dayWords = record.entries.map((e) => e.word);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/english/vocab/${id}`} className="u-navbtn">
            ← 단어장으로
          </Link>
          <p className="t-caption flex-none">단어 시험</p>
        </div>
        <h1 className="t-book-title mt-4">{record.titleKo}</h1>
      </header>

      {pool.length < MIN_QUIZ_WORDS ? (
        // ── 게이트: 정의가 부족하면 시험을 낼 수 없다 ──────────────────────────
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📖✨
          </p>
          <h2 className="t-section-title mt-2">먼저 영영 뜻을 만들어 주세요</h2>
          <p className="t-lead mt-2">
            시험은 <b>영영 뜻</b>을 보고 단어를 맞히는 놀이예요. 그래서 뜻이 있는 단어가 최소{" "}
            {MIN_QUIZ_WORDS}개는 있어야 해요.
            <br />
            지금은 {pool.length}개예요 — 단어장에서 “영영 뜻 만들기”를 눌러 채워 주세요.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/english/vocab/${id}`} className="u-btn u-btn-primary">
              <span aria-hidden>📖</span> 단어장으로 가서 뜻 만들기
            </Link>
            <Link href="/english/vocab" className="u-btn u-btn-secondary">
              <span aria-hidden>📓</span> 단어장 목록
            </Link>
          </div>
        </section>
      ) : (
        <VocabQuizView
          id={record.id}
          titleKo={record.titleKo}
          dayLabel={record.dayLabel}
          pool={pool}
          dayWords={dayWords}
        />
      )}
    </main>
  );
}

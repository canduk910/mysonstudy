/**
 * 오답노트 — DAY 안 `/english/vocab/[id]/wrong` (단어장 정복 V5 층1) — 서버 컴포넌트.
 *
 * 그 DAY의 시험 세션(`listVocabQuizzes`, startedAt 오름차순)을 `aggregateWordStats`로 접어
 * 단어별 {total, wrong, streak}를 만들고, 정의 있는 단어(시험에 나오는 단어)마다 붙여 클라이언트
 * 화면(`components/vocab-wrong-view.tsx`)에 넘긴다. **집계는 저장하지 않고 읽을 때 계산한다**(계획 §V5).
 *
 * 존재·렌더 판정은 상세/시험과 **같은 함수**(lib/vocabbook-record.ts) — 갈리면 "목록엔 보이는데
 * 눌렀더니 500"이 된다. AI 호출·비용은 없다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabWrongView, { type WrongWordRow } from "@/components/vocab-wrong-view";
import { aggregateWordStats, isStatMastered } from "@/lib/vocab-mastery";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface WrongPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: WrongPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} 오답노트 — 은우 북카드` };
}

export default async function VocabWrongPage({ params }: WrongPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) notFound();

  // startedAt 오름차순 세션 → 단어별 집계(streak는 이 순서에 의존, 재정렬 금지).
  const quizzes = await store.listVocabQuizzes(id);
  const stats = aggregateWordStats(quizzes);

  // 오답노트의 대상 = 시험에 나오는 단어(정의가 있는 단어). 정의 없는 단어는 시험에 못 나오므로
  // total===0("안 본")으로만 뜨게 되어 아이가 눌러도 할 게 없다 — 대상 우주를 시험 풀과 맞춘다.
  const rows: WrongWordRow[] = record.entries
    .filter((e) => e.definitionEn !== null)
    .map((e) => {
      const st = stats[e.word] ?? { total: 0, wrong: 0, streak: 0 };
      return {
        word: e.word,
        definitionEn: e.definitionEn as string,
        total: st.total,
        wrong: st.wrong,
        streak: st.streak,
        mastered: isStatMastered(st),
      };
    });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/english/vocab/${id}`} className="u-navbtn">
            ← 단어장으로
          </Link>
          <p className="t-caption flex-none">오답노트</p>
        </div>
        <h1 className="t-book-title mt-4">📕 {record.titleKo}</h1>
        <p className="t-lead mt-1">
          틀린 단어를 모아 다시 풀어요.
          {record.dayLabel && record.dayLabel !== record.titleKo ? ` · ${record.dayLabel}` : ""}
        </p>
      </header>

      <VocabWrongView
        id={record.id}
        titleKo={record.titleKo}
        dayLabel={record.dayLabel}
        rows={rows}
        hasQuizzes={quizzes.length > 0}
      />
    </main>
  );
}

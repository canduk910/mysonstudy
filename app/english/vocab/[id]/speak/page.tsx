/**
 * 그림 보고 말하기 `/english/vocab/[id]/speak` (2026-10-03, SPEC §15-5, docs/harness/english.md §14) — 서버 컴포넌트.
 *
 * 저장된 DAY 하나를 읽어 **영영 정의가 있는 단어**만 낼 풀로 만들고, 그림 보고 말하기 모드(`picture-speak`)만의 단어 통계를
 * 붙여 클라이언트 러너(`components/vocab-speak-quiz-runner.tsx`)에 넘긴다. 진행·판정·저장은 전부 클라이언트에서 돈다.
 *
 * - 러너에는 **word·definitionEn·emoji만** 넘긴다 — 한국어 뜻(meanings·definitionKo)은 화면에 가지 않는다(번역 없는 떠올리기, 구조로 보장).
 * - `?mode=wrong`: 이 모드에서 틀렸고 아직 졸업 못 한 단어만(오답노트의 "다시 말해 보기"). 없으면 축하 화면.
 * - 숙련도는 이 모드만 접는다(`aggregateWordStatsForMode(…, "picture-speak")`) — 5지선다 시험·관계 문제와 섞지 않는다.
 * - 보기 5개가 필요 없어 최소 단어 수 게이트는 1개다(정의가 하나도 없으면 "먼저 영영 뜻을 만들어 주세요").
 *
 * 존재·렌더 판정은 상세/시험과 **같은 함수**(lib/vocabbook-record.ts). AI 호출은 없다 — 전사(관문 W)는 화면이 말할 때마다 부른다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabSpeakQuizRunner from "@/components/vocab-speak-quiz-runner";
import { KID_SPEAK_MODE, type KidSpeakPoolItem, type KidSpeakStatLike } from "@/lib/kid-speak";
import { aggregateWordStatsForMode, isStatMastered } from "@/lib/vocab-mastery";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface SpeakPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}

export async function generateMetadata({ params }: SpeakPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} 그림 보고 말하기 — 은우 북카드` };
}

export default async function VocabSpeakPage({ params, searchParams }: SpeakPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const isWrong = (Array.isArray(sp.mode) ? sp.mode[0] : sp.mode) === "wrong";

  const store = getStore();
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) notFound();

  // 낼 수 있는 단어 = 영영 정의가 있는 단어(정의가 곧 단서). 한국어는 싣지 않는다.
  const defined: KidSpeakPoolItem[] = record.entries
    .filter((e) => e.definitionEn !== null)
    .map((e) => ({ word: e.word, definitionEn: e.definitionEn as string, emoji: e.imageEmoji ?? null }));

  // 이 모드만의 통계(startedAt 오름차순 세션 → 순서 의존, 재정렬 금지)
  const quizzes = await store.listVocabQuizzes(id);
  const allStats = aggregateWordStatsForMode(quizzes, KID_SPEAK_MODE);

  const pool = isWrong
    ? defined.filter((w) => {
        const st = allStats[w.word];
        return st != null && st.wrong > 0 && !isStatMastered(st);
      })
    : defined;
  const stats: Record<string, KidSpeakStatLike> = {};
  for (const w of pool) {
    const st = allStats[w.word];
    if (st) stats[w.word] = { total: st.total, wrong: st.wrong, streak: st.streak };
  }

  const backHeader = (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/english/vocab/${id}`} className="u-navbtn">
          ← 단어장으로
        </Link>
        <p className="t-caption flex-none">{isWrong ? "다시 말해 보기" : "그림 보고 말하기"}</p>
      </div>
      <h1 className="t-book-title mt-4">{record.titleKo}</h1>
    </header>
  );

  if (pool.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        {backHeader}
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            {isWrong ? "🎓🎉" : "📖✨"}
          </p>
          <h2 className="t-section-title mt-2">{isWrong ? "다시 말할 단어가 없어요" : "먼저 영영 뜻을 만들어 주세요"}</h2>
          <p className="t-lead mt-2">
            {isWrong
              ? "못 떠올린 단어를 모두 졸업했거나, 아직 그림 보고 말하기를 하지 않았어요."
              : "그림 보고 말하기는 영영 뜻을 보고 단어를 떠올리는 놀이예요. 단어장에서 “영영 뜻 만들기”를 눌러 주세요."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={isWrong ? `/english/vocab/${id}/speak` : `/english/vocab/${id}`} className="u-btn u-btn-primary">
              {isWrong ? (
                <>
                  <span aria-hidden>🎤</span> 그림 보고 말하기
                </>
              ) : (
                <>
                  <span aria-hidden>📖</span> 단어장으로 가서 뜻 만들기
                </>
              )}
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {backHeader}
      <VocabSpeakQuizRunner
        id={record.id}
        titleKo={record.titleKo}
        dayLabel={record.dayLabel}
        pool={pool}
        stats={stats}
        variant={isWrong ? "wrong" : "all"}
      />
    </main>
  );
}

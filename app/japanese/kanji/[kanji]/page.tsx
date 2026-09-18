/**
 * 한자 카드 `/japanese/kanji/[kanji]` (아빠의 일본어 JK, §12-5) — 서버 컴포넌트.
 *
 * 그 한자의 저장 정보(있으면)와, **내 단어장에서 이 한자가 든 단어들**(읽을 때 계산)을 조인해 카드에 넘긴다.
 * 한자가 어느 단어장에도 없고 정보도 없으면 notFound. AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaKanjiCardView from "@/components/ja-kanji-card-view";
import type { JaKanjiCardData } from "@/lib/japanese-kanji-contract";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface KanjiPageProps {
  params: Promise<{ kanji: string }>;
}

export async function generateMetadata({ params }: KanjiPageProps): Promise<Metadata> {
  const { kanji } = await params;
  return { title: `${decodeURIComponent(kanji)} — 아빠의 일본어 한자` };
}

/** 이 한자가 든 내 단어들(표기·어느 단어장). 단어별 첫 등장 단어장으로 링크(§12-1, 저장 없이 계산). */
async function collectWordsFor(kanji: string): Promise<{ word: string; bookId: string }[]> {
  const books = await getStore().listJaVocabBooks(500);
  const out: { word: string; bookId: string }[] = [];
  const seen = new Set<string>();
  for (const b of books) {
    for (const e of b.entries) {
      if (e.word.includes(kanji) && !seen.has(e.word)) {
        seen.add(e.word);
        out.push({ word: e.word, bookId: b.id });
      }
    }
  }
  return out;
}

export default async function JaKanjiCardPage({ params }: KanjiPageProps) {
  const { kanji: raw } = await params;
  const kanji = decodeURIComponent(raw);
  const store = getStore();

  const [infos, words] = await Promise.all([store.listJaKanji(), collectWordsFor(kanji)]);
  const info = infos.find((k) => k.kanji === kanji) ?? null;

  // 어느 단어장에도 없고 정보도 없으면 존재하지 않는 한자 카드다.
  if (!info && words.length === 0) notFound();

  const data: JaKanjiCardData = {
    kanji,
    hasInfo: !!info,
    koReading: info?.koReading ?? null,
    onyomi: info?.onyomi ?? [],
    kunyomi: info?.kunyomi ?? [],
    meaningKo: info?.meaningKo ?? "",
    words,
  };

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese/kanji" className="u-navbtn">
            ← 한자 목록
          </Link>
        </div>
      </header>
      <JaKanjiCardView data={data} />
    </main>
  );
}

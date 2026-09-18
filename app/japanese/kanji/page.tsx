/**
 * 한자 목록 `/japanese/kanji` (아빠의 일본어 JK, §12-5) — 서버 컴포넌트.
 *
 * 저장된 JLPT 단어장 전체에서 한자를 **수집**하고(collectKanjiFromBooks, AI 0), 저장된 한자 정보와 조인해 목록을 만든다.
 * 한자가 든 단어 목록은 저장하지 않고 **여기서 계산**한다(§12-1). 화면은 독립이지만 데이터는 단어장 파생이다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaKanjiListView from "@/components/ja-kanji-list-view";
import { collectKanjiFromBooks } from "@/lib/ai/japanese/kanji";
import type { JaKanjiListItem } from "@/lib/japanese-kanji-contract";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "한자 — 아빠의 일본어",
  description: "내 단어장에서 모은 한자를 한국 한자음을 다리로 익혀요.",
};

const LIST_LIMIT = 500;

export default async function JaKanjiListPage() {
  const store = getStore();
  const [books, kanjiInfos] = await Promise.all([store.listJaVocabBooks(LIST_LIMIT), store.listJaKanji()]);
  const collected = collectKanjiFromBooks(books);
  const infoByKanji = new Map(kanjiInfos.map((k) => [k.kanji, k]));

  const items: JaKanjiListItem[] = collected.map((c) => {
    const info = infoByKanji.get(c.kanji);
    return {
      kanji: c.kanji,
      wordCount: c.words.length,
      hasInfo: !!info,
      koReading: info?.koReading ?? null,
      meaningKo: info?.meaningKo ?? "",
    };
  });
  const hasAnyInfo = items.some((it) => it.hasInfo);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese" className="u-navbtn">
            ← 아빠의 일본어
          </Link>
          {hasAnyInfo && (
            <Link href="/japanese/kanji/quiz" className="u-navbtn">
              <span aria-hidden>📝</span> 한자 시험
            </Link>
          )}
        </div>
        <h1 className="t-book-title mt-4">🈳 한자</h1>
        <p className="t-lead mt-1">
          단어장에서 모은 한자예요. 한국 한자음을 다리 삼아 음독을 익히면 새 한자어 읽기가 빨라져요.
        </p>
      </header>

      <JaKanjiListView items={items} />
    </main>
  );
}

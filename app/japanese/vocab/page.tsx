/**
 * JLPT 단어장 목록 `/japanese/vocab` (아빠의 일본어 J1) — 서버 컴포넌트.
 *
 * J0 플레이스홀더를 실제 목록으로 교체했다. `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 영어·수학 규약)
 * 목록 줄에 필요한 것만 줄여 넘긴다(entries 전문은 무겁다). 렌더 판정은 상세와 **같은 함수**(lib/japanese-record).
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaVocabLibraryView, { type JaVocabLibraryItem } from "@/components/ja-vocab-library-view";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "JLPT 단어장 — 아빠의 일본어",
  description: "레벨·주제로 만든 JLPT 단어장을 모아 봐요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function JaVocabLibraryPage() {
  const stored = await getStore().listJaVocabBooks(LIST_LIMIT);
  const records = stored.filter(isRenderableJaVocabBook);
  const skippedCount = stored.length - records.length;

  const items: JaVocabLibraryItem[] = records.map((record) => ({
    id: record.id,
    titleKo: record.titleKo,
    kind: record.kind,
    levels: record.levels,
    topic: record.topic,
    wordCount: record.entries.length,
    createdAt: record.createdAt,
    sortIndex: record.sortIndex,
  }));

  // 정렬 규칙(서재·영어 단어장과 동일) — sortIndex null 먼저(createdAt 역순=최신 위), 그다음 sortIndex 오름차순.
  items.sort((a, b) => {
    const aNull = a.sortIndex == null;
    const bNull = b.sortIndex == null;
    if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    if (aNull) return -1;
    if (bNull) return 1;
    return a.sortIndex! - b.sortIndex!;
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese" className="u-navbtn">
            ← 아빠의 일본어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🗂️ JLPT 단어장</h1>
        <p className="t-lead mt-1">레벨과 주제로 단어장을 만들어 두면, 언제든 다시 보고 외울 수 있어요.</p>
      </header>

      <JaVocabLibraryView items={items} skippedCount={skippedCount} />
    </main>
  );
}

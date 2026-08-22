/**
 * 단어장 목록 `/english/vocab` (단어장 정복 V1) — 서버 컴포넌트.
 *
 * `getStore()`를 **직접 읽는다.** 목록 조회용 API 라우트를 만들지 않는다 —
 * 영어 `/library`·수학 `/math/library`와 같은 규약이다(서버에서 읽어 화면 데이터로 줄여 넘긴다).
 *
 * **레코드 전문을 클라이언트로 넘기지 않는다.** `VocabBookRecord.entries`는 DAY 하나의 단어
 * 전부(예문 포함)라, 여러 개면 목록 한 장에 수백 KB가 실린다. 줄에 필요한 것은 이름·단어 수·
 * 날짜뿐이라 이 자리에서 줄여 보낸다(수학 서재와 같은 판단).
 */

import type { Metadata } from "next";
import VocabLibraryView, { type VocabLibraryItem } from "@/components/vocab-library-view";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

// 저장 데이터는 요청 시점에 읽는다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "단어장 — 은우 북카드",
  description: "찍어 만든 단어장을 모아 봐요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function VocabLibraryPage() {
  const stored = await getStore().listVocabBooks(LIST_LIMIT);

  // 읽는 필드가 빠진 레코드는 건너뛴다 — 상세 화면과 **같은 함수**(lib/vocabbook-record.ts).
  const records = stored.filter(isRenderableVocabBook);
  const skippedCount = stored.length - records.length;

  const items: VocabLibraryItem[] = records.map((record) => ({
    id: record.id,
    titleKo: record.titleKo,
    dayLabel: record.dayLabel,
    wordCount: record.entries.length,
    photoCount: record.photoCount,
    createdAt: record.createdAt,
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {/* 상단 내비는 공통 셸(app/english/layout.tsx)이 담당 — 여기선 제목·리드만 (셸에 위임) */}
      <header className="mb-8">
        <h1 className="t-book-title">📓 단어장 정복</h1>
        <p className="t-lead mt-1">단어장을 찍어 표로 모아 두면, 언제든 다시 볼 수 있어요.</p>
      </header>

      <VocabLibraryView items={items} skippedCount={skippedCount} />
    </main>
  );
}

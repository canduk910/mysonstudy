/**
 * 대화 복습 목록 `/japanese/dialog` (아빠의 일본어 J3, §8) — 서버 컴포넌트.
 *
 * J0 플레이스홀더를 실제 목록으로 교체했다. `getStore()`를 직접 읽어 줄에 필요한 것만 넘긴다(전사 전문은 무겁다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaDialogLibraryView, { type JaDialogLibraryItem } from "@/components/ja-dialog-library-view";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "대화 복습 — 아빠의 일본어",
  description: "듀오링고 대화를 찍어 전사·해설로 복습해요.",
};

const LIST_LIMIT = 500;

export default async function JaDialogLibraryPage() {
  const stored = await getStore().listJaDialogs(LIST_LIMIT);
  const items: JaDialogLibraryItem[] = stored.map((d) => ({
    id: d.id,
    titleKo: d.titleKo,
    createdAt: d.createdAt,
    turnCount: d.turns.length,
    hasCoaching: d.coaching !== null,
    partial: d.partial,
    sortIndex: d.sortIndex,
  }));
  // 정렬 규칙(서재·단어장과 동일) — sortIndex null 먼저(최신 위), 그다음 sortIndex 오름차순.
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
        <h1 className="t-book-title mt-4">💬 대화 복습</h1>
        <p className="t-lead mt-1">듀오링고 대화 스크린샷을 찍어 전사하고, 잘한 점·고칠 점·어휘로 복습해요.</p>
      </header>

      <JaDialogLibraryView items={items} />
    </main>
  );
}

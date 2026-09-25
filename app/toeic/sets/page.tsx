/**
 * 표현집 목록 `/toeic/sets` (아빠의 영어 T1, docs/harness/toeic.md §8) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 영어·일본어 규약) 목록 줄에 필요한 것만 줄여 넘긴다(entries 전문은
 * 무겁다). 렌더 판정은 상세와 **같은 함수**(lib/toeic-record). 관리모드 삭제·순서변경, "사진으로 추가", "파일로 가져오기"는
 * 클라이언트 뷰가 한다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicSetLibraryView, { type ToeicSetLibraryItem } from "@/components/toeic-set-library-view";
import { getStore } from "@/lib/store";
import { isRenderableToeicSet } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "표현집 — 아빠의 영어",
  description: "토익스피킹 표현집을 모아 보고, 사진이나 파일로 새로 넣어요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function ToeicSetLibraryPage() {
  const stored = await getStore().listToeicSets(LIST_LIMIT);
  const records = stored.filter(isRenderableToeicSet);
  const skippedCount = stored.length - records.length;

  const items: ToeicSetLibraryItem[] = records.map((r) => ({
    id: r.id,
    titleKo: r.titleKo,
    dayNo: r.dayNo,
    topicKo: r.topicKo,
    source: r.source,
    exprCount: r.entries.length,
    quizCount: r.quiz.length,
    pointsCount: r.entries.filter((e) => e.points !== null).length,
    createdAt: r.createdAt,
    sortIndex: r.sortIndex,
  }));

  // 정렬 규칙(서재·단어장과 동일) — sortIndex null 먼저(createdAt 역순=최신 위), 그다음 sortIndex 오름차순.
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
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📒 표현집</h1>
        <p className="t-lead mt-1">
          표현 암기장 한 DAY가 한 세트예요. 표현마다 시험 답변에 꺼내 쓰는 발화 포인트가 붙어요.
        </p>
      </header>

      <ToeicSetLibraryView items={items} skippedCount={skippedCount} />
    </main>
  );
}

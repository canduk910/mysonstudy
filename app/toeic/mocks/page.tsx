/**
 * 모의고사 목록 `/toeic/mocks` (아빠의 영어 T3, docs/harness/toeic.md §4-0·§8) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 표현집·일본어 규약) 목록 줄에 필요한 것만 줄여 넘긴다(파트 본문은 무겁다).
 * 렌더 판정은 상세·라우트와 **같은 함수**(lib/toeic-record). "새 모의고사 만들기"(목표 등급·파트·주제 힌트), 관리모드
 * 삭제·순서변경은 클라이언트 뷰가 한다.
 *
 * 주제 힌트 칩은 표현집 세트의 주제(topicKo)들이다(§4-0 "표현집 세트의 topicKo들 + 사용자가 고른 주제") — 여기서 모아
 * 넘기고, 사용자가 고른 것만 요청에 싣는다. 활용할 표현은 서버가 만들 때 표현집에서 고른다(화면은 개수만 안내).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicMockLibraryView, { type ToeicMockLibraryItem } from "@/components/toeic-mock-library-view";
import { TOEIC_MOCK_EXPRESSIONS_MAX } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { missingToeicMockParts } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS } from "@/lib/toeic-mock";
import { isRenderableToeicMock, isRenderableToeicSet } from "@/lib/toeic-record";
import { collapseSpaces } from "@/lib/toeic-text";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "모의고사 — 아빠의 영어",
  description: "AI가 새로 만든 토익스피킹 11문항 — 모범답변·사진으로 공부하고 실전처럼 응시해요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function ToeicMocksPage() {
  const store = getStore();
  const [storedMocks, sets, attempts] = await Promise.all([
    store.listToeicMocks(LIST_LIMIT),
    store.listToeicSets(LIST_LIMIT),
    store.listAllToeicAttempts(),
  ]);
  const mocks = storedMocks.filter(isRenderableToeicMock);
  const skippedCount = storedMocks.length - mocks.length;

  const attemptCount = new Map<string, number>();
  for (const a of attempts) attemptCount.set(a.mockId, (attemptCount.get(a.mockId) ?? 0) + 1);

  const items: ToeicMockLibraryItem[] = mocks.map((m) => {
    const pictureItems = m.parts.picture?.items ?? [];
    return {
      id: m.id,
      titleKo: m.titleKo,
      targetGrade: m.targetGrade,
      readyParts: TOEIC_MOCK_PARTS.length - missingToeicMockParts(m.parts).length,
      totalParts: TOEIC_MOCK_PARTS.length,
      pictureTotal: pictureItems.length,
      pictureReady: pictureItems.filter((it) => it.image.status === "ready" && it.image.imageId).length,
      attemptCount: attemptCount.get(m.id) ?? 0,
      createdAt: m.createdAt,
      sortIndex: m.sortIndex,
    };
  });
  // 정렬 규칙(서재·표현집과 동일) — sortIndex null 먼저(createdAt 역순=최신 위), 그다음 sortIndex 오름차순.
  items.sort((a, b) => {
    const aNull = a.sortIndex == null;
    const bNull = b.sortIndex == null;
    if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    if (aNull) return -1;
    if (bNull) return 1;
    return a.sortIndex! - b.sortIndex!;
  });

  // 주제 칩 — 표현집 세트 주제(공백 정리·대소문자 무시 중복 제거, 표현집 목록 순서)
  const renderableSets = sets.filter(isRenderableToeicSet);
  const topicChoices: string[] = [];
  const seenTopic = new Set<string>();
  for (const s of renderableSets) {
    const t = collapseSpaces(s.topicKo ?? "");
    if (t === "" || seenTopic.has(t.toLowerCase())) continue;
    seenTopic.add(t.toLowerCase());
    topicChoices.push(t);
  }
  const exprKeys = new Set<string>();
  for (const s of renderableSets) for (const e of s.entries) exprKeys.add(collapseSpaces(e.expression).toLowerCase());

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🧑‍💼 모의고사</h1>
        <p className="t-lead mt-1">
          AI가 새로 만든 11문항이에요(기출이 아니에요). 모범답변·사진으로 먼저 공부하고, 실전 시간대로 응시해요.
        </p>
      </header>

      <ToeicMockLibraryView
        items={items}
        skippedCount={skippedCount}
        topicChoices={topicChoices}
        setCount={renderableSets.length}
        expressionCount={exprKeys.size}
        expressionsMax={TOEIC_MOCK_EXPRESSIONS_MAX}
      />
    </main>
  );
}

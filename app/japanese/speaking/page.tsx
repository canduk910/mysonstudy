/**
 * 🎙️ 말하기 모의고사 목록 `/japanese/speaking` (아빠의 일본어, docs/harness/japanese.md §15-10-2) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 일본어·토익 규약) 목록 줄에 필요한 것만 줄여 넘긴다. 렌더 판정은 상세·라우트와
 * 같은 함수(lib/japanese-record isRenderableJaSpeakingMock). 새로 만들기(레벨 하나·파트·주제)·관리모드 삭제·순서변경은 클라이언트 뷰.
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaSpeakingLibraryView, { type JaSpeakingLibraryItem } from "@/components/ja-speaking-library-view";
import { JA_VOCAB_TOPIC_PRESETS } from "@/lib/ai/japanese/schemas";
import { JA_SPEAKING_LIMITS } from "@/lib/ai/japanese/speaking-schemas";
import { JA_SPEAKING_PARTS } from "@/lib/ja-speaking";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "말하기 모의고사 — 아빠의 일본어",
  description: "토익스피킹 11문항 형식을 일본어로 — JLPT 레벨에 맞춘 AI 출제·실전 응시·AI 채점.",
};

export default async function JaSpeakingListPage() {
  const store = getStore();
  const [mocks, attempts] = await Promise.all([store.listJaSpeakingMocks(), store.listAllJaSpeakingAttempts()]);
  const renderable = mocks.filter(isRenderableJaSpeakingMock);
  const skippedCount = mocks.length - renderable.length;
  const attemptCount = new Map<string, number>();
  for (const a of attempts) attemptCount.set(a.mockId, (attemptCount.get(a.mockId) ?? 0) + 1);

  const items: JaSpeakingLibraryItem[] = renderable.map((m) => {
    const pictureItems = m.parts.picture?.items ?? [];
    return {
      id: m.id,
      titleKo: m.titleKo,
      level: m.level,
      readyParts: JA_SPEAKING_PARTS.filter((p) => m.parts[p] !== null).length,
      totalParts: JA_SPEAKING_PARTS.length,
      pictureTotal: pictureItems.length,
      pictureReady: pictureItems.filter((it) => it.image.status === "ready" && it.image.imageId).length,
      attemptCount: attemptCount.get(m.id) ?? 0,
      createdAt: m.createdAt,
      sortIndex: m.sortIndex,
    };
  });
  // 정렬 규칙(서재·표현집·토익 모의고사와 같다) — sortIndex null 먼저(최신 위), 그다음 sortIndex 오름차순
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
        <h1 className="t-book-title mt-4">🎙️ 말하기 모의고사</h1>
        <p className="t-lead mt-1">
          토익스피킹 11문항 형식을 일본어로 연습해요. JLPT 레벨 하나를 골라 AI가 새로 만들고, 실전 시간대로 응시한 뒤 버튼을 눌러 AI 채점을 받아요.
        </p>
      </header>
      <JaSpeakingLibraryView
        items={items}
        skippedCount={skippedCount}
        topicChoices={JA_VOCAB_TOPIC_PRESETS}
        hintsMax={JA_SPEAKING_LIMITS.topicHintsMax}
        hintMaxChars={JA_SPEAKING_LIMITS.topicHintMax}
      />
    </main>
  );
}

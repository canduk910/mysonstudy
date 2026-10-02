/**
 * 모의고사 목록 `/toeic/mocks` (아빠의 영어 T3, docs/harness/toeic.md §4-0·§8) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 표현집·일본어 규약) 목록 줄에 필요한 것만 줄여 넘긴다(파트 본문은 무겁다).
 * 렌더 판정은 상세·라우트와 **같은 함수**(lib/toeic-record). "새 모의고사 만들기"(목표 등급·파트·주제 힌트), 관리모드
 * 삭제·순서변경은 클라이언트 뷰가 한다.
 *
 * 주제 힌트 칩은 표현집 세트의 주제(topicKo)들이다(§4-0 "표현집 세트의 topicKo들 + 사용자가 고른 주제") — 여기서 모아
 * 넘기고, 사용자가 고른 것만 요청에 싣는다. 활용할 표현은 서버가 만들 때 표현집에서 고른다(화면은 개수만 안내).
 * 유형별 공략 계열 문서(같은 toeicSets 컬렉션 — §12-3)는 주제 칩·표현 수에서 뺀다(실전 모의고사의 입력은 표현집 그대로, §12-12 1).
 * 유형별 공략의 **한 문제 연습**(같은 toeicMocks 컬렉션, drillPart)은 목록에서 뺀다 — 상한 없이 전부 읽어 **먼저** 연습을 빼고 그다음
 * skippedCount를 센다(lib/toeic-record listableToeicMocks). 상한으로 자른 뒤 거르면 연습이 많아질 때 오래된 모의고사가 빠진다(§12-3 표).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicMockLibraryView, { type ToeicMockLibraryItem } from "@/components/toeic-mock-library-view";
import { TOEIC_MOCK_EXPRESSIONS_MAX } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { missingToeicMockParts } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS } from "@/lib/toeic-mock";
import { isRenderableToeicSet, isRenderableToeicTemplateBank, isToeicGuideSet, listableToeicMocks } from "@/lib/toeic-record";
import { TOEIC_GUIDE_PARTS, TOEIC_TEMPLATE_BANK_ID } from "@/lib/toeic-guide";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import { collapseSpaces } from "@/lib/toeic-text";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "모의고사 — 아빠의 영어",
  description: "AI가 새로 만든 토익스피킹 11문항 — 모범답변·사진으로 공부하고 실전처럼 응시해요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한(연습을 뺀 **뒤에** 자른다) */
const LIST_LIMIT = 500;

export default async function ToeicMocksPage() {
  const store = getStore();
  const [storedMocks, sets, attempts] = await Promise.all([
    store.listToeicMocks(),
    store.listToeicSets(),
    store.listAllToeicAttempts(),
  ]);
  const listed = listableToeicMocks(storedMocks);
  const mocks = listed.mocks.slice(0, LIST_LIMIT);
  const skippedCount = listed.skippedCount;

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

  // 주제 칩 — 표현집 세트 주제(공백 정리·대소문자 무시 중복 제거, 표현집 목록 순서). 공략 계열을 먼저 뺀다(§12-3 표).
  const renderableSets = sets.filter((s) => !isToeicGuideSet(s)).filter(isRenderableToeicSet);
  const topicChoices: string[] = [];
  const seenTopic = new Set<string>();
  for (const s of renderableSets) {
    const t = collapseSpaces(s.topicKo ?? "");
    if (t === "" || seenTopic.has(t.toLowerCase())) continue;
    seenTopic.add(t.toLowerCase());
    topicChoices.push(t);
  }
  // 답변 흐름 안내(§12-13-3) — 같은 목록(sets)에서 틀 은행을 찾아 네 유형의 렌더 가능한 틀 수(공통 틀은 한 번). 읽기 추가 0
  const bank = sets.find((s) => s.id === TOEIC_TEMPLATE_BANK_ID) ?? null;
  const bankItems: unknown[] = bank !== null && isRenderableToeicTemplateBank(bank) ? ((bank.guide as { items: unknown[] }).items ?? []) : [];
  const flowTemplateCount = new Set(TOEIC_GUIDE_PARTS.flatMap((p) => guideTemplatesForPart(bankItems, p).templates.map((t) => t.key))).size;
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
        flowTemplateCount={flowTemplateCount}
      />
    </main>
  );
}

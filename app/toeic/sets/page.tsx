/**
 * 표현집 목록 `/toeic/sets` (아빠의 영어 T1, docs/harness/toeic.md §8) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽어(조회용 API 라우트 없음 — 영어·일본어 규약) 목록 줄에 필요한 것만 줄여 넘긴다(entries 전문은
 * 무겁다). 렌더 판정은 상세와 **같은 함수**(lib/toeic-record). 관리모드 삭제·순서변경, "사진으로 추가", "파일로 가져오기"는
 * 클라이언트 뷰가 한다.
 *
 * 유형별 공략 계열 문서(유형 공략 `guide-{part}`·틀 은행 `guide-templates` — 같은 toeicSets 컬렉션, §12-3)는 **먼저 빼고** 그다음
 * "열지 못한 n개"를 센다(순서가 반대면 공략 4개·틀 은행이 깨진 표현집으로 보고된다). 판정은 isToeicGuideSet 하나.
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicSetLibraryView, { type ToeicSetLibraryItem } from "@/components/toeic-set-library-view";
import { getStore } from "@/lib/store";
import { isRenderableToeicSet, isToeicGuideSet } from "@/lib/toeic-record";
import { kstTodayString } from "@/lib/kst";
import { isToeicQuizModeSession } from "@/lib/toeic-quiz";
import { testStatusByTarget, testStatusOf, toTestStatusBadge } from "@/lib/test-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "표현집 — 아빠의 영어",
  description: "토익스피킹 표현집을 모아 보고, 사진이나 파일로 새로 넣어요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function ToeicSetLibraryPage() {
  // 공략 계열(유형 공략·틀 은행)을 먼저 빼고, 남은 표현집만으로 "열지 못한 n개"를 센다(§12-3 — 순서가 반대면 공략이 깨진 문서로 보고된다)
  const store = getStore();
  const [allSets, quizzes] = await Promise.all([store.listToeicSets(), store.listAllToeicQuizzes()]);
  const stored = allSets.filter((s) => !isToeicGuideSet(s)).slice(0, LIST_LIMIT);
  // 시험 응시 배지(SPEC §15-4) — 표현 시험 세션(네 모드)을 **한 번** 읽어 setId로 묶는다. 혼합 시험은 모드마다 문서가 따로지만 같은
  // startedAt이라 한 판으로 합쳐진다. 틀 은행 세션(setId guide-templates, 틀 모드)은 표현 시험이 아니라 거른다.
  const todayKst = kstTodayString();
  const testBySet = testStatusByTarget(quizzes.filter(isToeicQuizModeSession), (q) => q.setId, todayKst);
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
    test: toTestStatusBadge(testStatusOf(testBySet, r.id), todayKst),
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

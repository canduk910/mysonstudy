/**
 * 수학 서재 `/math/library` (M4, docs/harness/math.md §9-4) — 서버 컴포넌트.
 *
 * `getStore()`를 **직접 읽는다.** 목록 조회용 API 라우트를 만들지 않는다 —
 * 영어 `/library`와 같은 규약이다(서버에서 읽어 화면 데이터로 줄여 넘긴다).
 *
 * 여기서 계산하는 것: 유형별 집계(건수·채점된 건수·정답 수·보류 수)와 목록 항목.
 * 비율로 바꾸는 일과 분모 0 처리는 화면(`components/math-library-view.tsx`)이 한다 —
 * "—"로 보일지 말지가 문구와 붙어 있어서다.
 *
 * **레코드 전문을 클라이언트로 넘기지 않는다.** `ExplanationRecord.content`는 3막 설명
 * 전문(장면 대본 포함)이라, 수십 건이면 목록 한 장에 수백 KB가 실린다. 줄에 필요한 것은
 * 문제 문장·유형·채점·보류·날짜뿐이라 이 자리에서 줄여 보낸다(카드 히스토리와 같은 판단).
 */

import type { Metadata } from "next";
import Link from "next/link";
import MathLibraryView, {
  type MathLibraryItem,
  type PatternStat,
} from "@/components/math-library-view";
import { type ProblemPattern } from "@/lib/ai/math/schemas";
import { isRenderableExplanation } from "@/lib/math-record";
import { SCENE_TIERS, type SceneTier } from "@/lib/scene/types";
import { getStore } from "@/lib/store";

// 저장 데이터는 요청 시점에 읽는다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "지난 문제 — 은우 수학코치",
  description: "만든 설명과 유형별 정답률·보류율을 한눈에 봐요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 (영어 서재의 500과 같은 규모 감각) */
const LIST_LIMIT = 500;

/**
 * 그림 단계 집계의 시작값 — **세 값을 모두 0으로 깔고 시작한다.**
 * `SCENE_TIERS`에서 만들므로 단수가 늘면(예: 새 전용 렌더러 단계) 여기가 저절로 따라온다.
 * 화면은 `Record<SceneTier, number>`를 받아 빠짐없이 그린다 — "그 유형에 2단이 0건"과
 * "집계에 그 칸이 없다"는 다른 말이고, 뒤엣것은 표에서 빈칸으로 새어 나온다.
 */
function emptyTierCounts(): Record<SceneTier, number> {
  return Object.fromEntries(SCENE_TIERS.map((t) => [t, 0])) as Record<SceneTier, number>;
}

export default async function MathLibraryPage() {
  const store = getStore();
  const stored = await store.listExplanations(LIST_LIMIT);

  // 읽는 필드가 빠진 문서는 건너뛴다 (QA 5-4) — 한 건 때문에 목록 전체를 잃지 않게.
  // 판정은 `lib/math-record.ts` 한 곳뿐이다 — 상세 화면(`/math/problem/[id]`)이 같은 함수를 본다.
  const records = stored.filter(isRenderableExplanation);
  const skippedCount = stored.length - records.length;

  const items: MathLibraryItem[] = records.map((record) => {
    const held = record.verify.status === "held";
    return {
      id: record.id,
      number: record.problem.number ?? null,
      problemText: record.problem.text,
      pattern: record.content.problemPattern,
      patternNameKo: record.content.patternNameKo ?? "",
      childGrade: record.content.childGrade,
      held,
      /*
       * [QA P3-1] 보류 건의 답은 **서버에서 자른다.** 화면이 감추는 것만으로는 답 문자열이
       * 클라이언트 페이로드(페이지 소스)에 그대로 남아, 접어 둔 답이 검색되면 접은 뜻이 없어진다.
       * 상세 화면(`/math/problem/[id]`)은 접힌 영역에 **의도적으로** 보여주므로 그대로 둔다.
       */
      answerText: held ? "" : record.content.answerText,
      createdAt: record.createdAt,
      sortIndex: record.sortIndex,
    };
  });
  /*
   * 정렬 규칙(서재와 동일) — sortIndex null이 먼저(createdAt 역순=최신이 위), 그다음 sortIndex 오름차순.
   * listExplanations는 createdAt desc로 오지만, 수동 정렬 블록을 반영하려면 여기서 다시 세운다.
   * (아래 유형별 집계는 records로 따로 돌므로 이 정렬과 무관하다.)
   */
  items.sort((a, b) => {
    const aNull = a.sortIndex == null;
    const bNull = b.sortIndex == null;
    if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    if (aNull) return -1;
    if (bNull) return 1;
    return a.sortIndex! - b.sortIndex!;
  });

  /*
   * 유형별 집계 (§8 "held 비율을 유형별로 남긴다").
   * - count       : 그 유형의 전체 건수 — 보류율의 분모
   * - gradedCount : childGrade !== 'none' — **정답률의 분모**. 아이가 답을 쓰지 않아
   *                 채점할 것이 없었던 문제를 빼야 정답률이 거짓말을 하지 않는다(§9-4).
   * - correctCount: 'correct'만 센다. 'partial'은 분모에 남고 분자에서는 빠진다 —
   *                 반만 맞은 것을 맞았다고 세면 "자주 막히는 유형"이 흐려진다.
   * - tierCounts  : **그림 단계별 건수** (§8[개정 4] "sceneTier를 유형별로 집계해 서재에
   *                 보여준다"). 이 숫자를 읽는 목적이 하나 더 있다 — **HTML(2단)로 자주
   *                 그려지는 유형이 곧 다음에 만들 전용 렌더러(1단)다.** 2단은 문제마다 호출
   *                 E를 한 번씩 더 태우는 가장 비싼 경로라, 어느 유형에서 그 비용이 반복되는지
   *                 보이면 승격 대상이 정해진다.
   *
   * `record.sceneTier`를 키로 그대로 쓴다 — 값이 SCENE_TIERS 안에 있다는 것은 위
   * `isRenderableExplanation()`이 이미 확인했다(모르는 값이면 목록에도 걸리지 않는다).
   */
  const byPattern = new Map<ProblemPattern, PatternStat>();
  for (const record of records) {
    const pattern = record.content.problemPattern;
    const stat = byPattern.get(pattern) ?? {
      pattern,
      count: 0,
      gradedCount: 0,
      correctCount: 0,
      heldCount: 0,
      tierCounts: emptyTierCounts(),
    };
    stat.count += 1;
    if (record.content.childGrade !== "none") {
      stat.gradedCount += 1;
      if (record.content.childGrade === "correct") stat.correctCount += 1;
    }
    if (record.verify.status === "held") stat.heldCount += 1;
    stat.tierCounts[record.sceneTier] += 1;
    byPattern.set(pattern, stat);
  }
  // 많이 푼 유형이 위로 — 표를 위에서부터 읽으면 "요즘 하는 것"이 먼저 온다
  const stats = [...byPattern.values()].sort((a, b) => b.count - a.count);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/math" className="u-navbtn">
            ← 수학 홈
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🧮 지난 문제</h1>
        <p className="t-lead mt-1">
          만든 설명이 쌓이는 곳이에요. 어떤 유형에서 자주 막히는지도 함께 보여드려요.
        </p>
      </header>

      <MathLibraryView items={items} stats={stats} skippedCount={skippedCount} />
    </main>
  );
}

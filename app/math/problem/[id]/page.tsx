/**
 * 저장된 설명 보기 `/math/problem/[id]` (M4, docs/harness/math.md §9-4) — 서버 컴포넌트.
 *
 * 레코드를 `MathExplainSuccess` 모양으로 **되살려 기존 `<MathExplanationView>`에 그대로
 * 넘긴다.** 새 뷰를 만들지 않는다 — 두 벌이 되면 반드시 어긋나고, 그때 어긋나는 것이
 * 하필 "보류면 답을 접는다" 같은 안전장치다.
 *
 * `getStore()`를 직접 읽는다(영어 `/card/[id]`와 같은 규약). 없는 id면 `notFound()`.
 *
 * **열 수 없는 기록도 `notFound()`다** (QA P3-5). 필드가 빠졌거나 반쪽인 문서를 그대로
 * 그리면 `stepsKo.map()` 같은 자리에서 던져 **500**이 된다 — 서버가 고장 난 게 아니라
 * 기록이 못 쓰는 상태이므로 404가 맞다. 판정은 서재와 **같은 함수**를 쓴다
 * (`lib/math-record.ts`) — 두 벌이 되면 "목록엔 보이는데 눌렀더니 500"이 돌아온다.
 * 레코드를 응답 모양으로 되살리는 `toExplainSuccess()`도 같은 모듈에 있다(옛 기록 정규화).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import MathExplanationView from "@/components/math-explanation-view";
import { isRenderableExplanation, toExplainSuccess } from "@/lib/math-record";
import { getStore } from "@/lib/store";

// 저장 데이터는 요청 시점에 읽는다
export const dynamic = "force-dynamic";

interface MathProblemPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: MathProblemPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getExplanation(id);
  // 본문과 같은 판정 — 여기만 통과시키면 `problem.text.slice()`가 던져 메타데이터에서 500이 난다
  if (!record || !isRenderableExplanation(record)) {
    return { title: "설명을 찾을 수 없어요 — 은우 수학코치" };
  }
  // 문제 문장 앞머리를 제목으로 — 브라우저 탭에서 어느 문제인지 구분된다
  const head = record.problem.text.slice(0, 24);
  return { title: `${head}${record.problem.text.length > 24 ? "…" : ""} — 은우 수학코치` };
}

export default async function MathProblemPage({ params }: MathProblemPageProps) {
  const { id } = await params;
  const record = await getStore().getExplanation(id);
  // 없는 id도, 열 수 없는 기록도 같은 404 (QA P3-5) — 서재가 "예전 형식이라 열지 못한
  // 기록이 N건" 안내를 이미 띄우므로 사용자에게는 맥락이 있다.
  if (!record || !isRenderableExplanation(record)) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/math/library" className="u-navbtn">
            ← 지난 문제
          </Link>
          <p className="t-caption flex-none">{record.createdAt.slice(0, 10).replace(/-/g, ".")}</p>
        </div>
      </header>

      <MathExplanationView problemText={record.problem.text} result={toExplainSuccess(record)} />

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href="/math/new" className="u-btn u-btn-secondary">
          <span aria-hidden>✏️</span> 새 문제 설명하기
        </Link>
        <Link href="/math/library" className="u-btn u-btn-secondary">
          <span aria-hidden>🧮</span> 지난 문제 보기
        </Link>
      </div>
    </main>
  );
}

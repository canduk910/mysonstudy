/**
 * 모의고사 응시 `/toeic/mocks/[id]/take?scope=full | ?scope=part&part=<part>` (아빠의 영어 T4, docs/harness/toeic.md §6-4·§8) — 서버 컴포넌트.
 *
 * 모의고사를 읽어 응시 범위를 판정하고(시작 라우트와 **같은 함수** decideAttemptScope — 링크 toeicTakeHref가 만든 쿼리),
 * 문항별 화면 자료(buildToeicQuestionViews — 형식표 숫자 + 파트 자료)를 클라이언트 응시 화면에 넘긴다. 타이머·질문 음성·
 * 녹음·IndexedDB·시작/끝 라우트 호출은 클라이언트(ToeicTakeView)가 한다.
 * 범위가 맞지 않으면(빠진 파트·모르는 파트) 이유와 돌아갈 링크만 보인다. 없는 모의고사는 404.
 *
 * 유형별 공략의 **한 문제 연습**(문서의 drillPart — docs/harness/toeic.md §12-7-4): 판정에 drillPart를 넘겨 응시 범위 문항을 연습
 * 단위표에서 받는다(사진 묘사는 Q3 하나). 범위 라벨은 toeicDrillScopeLabelKo("공략 연습 · …"), "뒤로"는 그 유형 폴더(④ 탭),
 * 녹음 보관 풀은 "drill"(연습이 실전 녹음을 밀어내지 않게 — §12-7-6).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicTakeView from "@/components/toeic-take-view";
import { getStore } from "@/lib/store";
import { buildToeicQuestionViews, toeicDrillScopeLabelKo, toeicScopeLabelKo } from "@/lib/toeic-attempt-contract";
import { decideAttemptScope } from "@/lib/toeic-attempt-rules";
import { toeicMockBackLink } from "@/lib/toeic-drill-view";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, type ToeicMockPart } from "@/lib/toeic-mock";
import { isRenderableToeicMock } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

interface TakePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params }: TakePageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicMock(id);
  if (!record || !isRenderableToeicMock(record)) return { title: "모의고사를 찾을 수 없어요 — 아빠의 영어" };
  return { title: `응시 · ${record.titleKo} — 아빠의 영어` };
}

export default async function ToeicTakePage({ params, searchParams }: TakePageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const mock = await getStore().getToeicMock(id);
  if (!mock || !isRenderableToeicMock(mock)) notFound();

  const scope = first(sp.scope) === "part" ? "part" : "full";
  const partParam = first(sp.part);
  const requested: ToeicMockPart[] =
    scope === "full"
      ? [...TOEIC_MOCK_PARTS]
      : (TOEIC_MOCK_PARTS as readonly string[]).includes(partParam ?? "")
        ? [partParam as ToeicMockPart]
        : [];
  const decided = requested.length > 0 ? decideAttemptScope(scope, requested, mock.parts, mock.drillPart) : null;
  const back = toeicMockBackLink(mock);

  if (!decided || !decided.ok) {
    const reason =
      !decided || decided.reason === "scope_parts_mismatch"
        ? mock.drillPart !== null
          ? "공략 연습은 그 유형 하나로만 응시해요."
          : "응시 범위(파트)가 올바르지 않아요."
        : decided.reason === "incomplete_mock"
          ? "빠진 파트가 있어 실전 응시를 할 수 없어요. 학습 보기에서 파트를 먼저 만들거나, 있는 파트로 유형 연습을 해 주세요."
          : `이 모의고사에는 ${partParam ? toeicMockPartLabelKo(partParam as ToeicMockPart) : "그"} 파트가 아직 없어요.`;
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <header className="mb-4">
          <Link href={back.href} className="u-navbtn">
            {back.labelKo}
          </Link>
        </header>
        <div className="u-box" role="alert">
          <p className="t-body">{reason}</p>
        </div>
      </main>
    );
  }

  // 응시 범위 문항은 판정이 돌려준 questions(연습의 사진 묘사는 [3] — 시작 라우트와 같은 함수)
  const qs = decided.questions;
  return (
    <ToeicTakeView
      mockId={mock.id}
      titleKo={mock.titleKo}
      scope={scope}
      parts={decided.parts}
      scopeLabelKo={mock.drillPart !== null ? toeicDrillScopeLabelKo(mock.drillPart, qs) : toeicScopeLabelKo(scope, decided.parts)}
      questions={buildToeicQuestionViews(mock.parts, qs)}
      back={back}
      recPool={mock.drillPart !== null ? "drill" : "mock"}
    />
  );
}

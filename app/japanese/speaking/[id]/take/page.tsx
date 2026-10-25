/**
 * 🎙️ 말하기 모의고사 응시 `/japanese/speaking/[id]/take?scope=full | ?scope=part&part=<part>` (docs/harness/japanese.md §15-10-2·§15-10-3) — 서버 컴포넌트.
 *
 * 응시 범위 판정은 시작 라우트와 **같은 함수**(decideAttemptScope — 토익 순수 함수, 형식표 공유). 문항별 화면 자료(buildJaSpeakingQuestionViews —
 * 형식표 숫자 + 일본어 원문·토큰)를 클라이언트 응시 화면(JaSpeakingTakeView → 토익 응시 화면 + 일본어 시험 프로필)에 넘긴다.
 * 이 경로는 **시험 화면**이다(lib/phrase-helper-scope.ts 시험 경로 — 표현 도우미·상단 스트릭이 첫 렌더부터 숨는다, §15-10-2).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaSpeakingTakeView from "@/components/ja-speaking-take-view";
import { JA_SPEAKING_PARTS, type JaSpeakingPart } from "@/lib/ja-speaking";
import { buildJaSpeakingQuestionViews, jaSpeakingMockBackLink, jaSpeakingPartLabelKo, jaSpeakingScopeLabelKo } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";
import { decideAttemptScope } from "@/lib/toeic-attempt-rules";

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
  const record = await getStore().getJaSpeakingMock(id);
  if (!record || !isRenderableJaSpeakingMock(record)) return { title: "모의고사를 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `응시 · ${record.titleKo} — 아빠의 일본어` };
}

export default async function JaSpeakingTakePage({ params, searchParams }: TakePageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const mock = await getStore().getJaSpeakingMock(id);
  if (!mock || !isRenderableJaSpeakingMock(mock)) notFound();

  const scope = first(sp.scope) === "part" ? "part" : "full";
  const partParam = first(sp.part);
  const requested: JaSpeakingPart[] =
    scope === "full" ? [...JA_SPEAKING_PARTS] : (JA_SPEAKING_PARTS as readonly string[]).includes(partParam ?? "") ? [partParam as JaSpeakingPart] : [];
  const decided = requested.length > 0 ? decideAttemptScope(scope, requested, mock.parts) : null;
  const back = jaSpeakingMockBackLink(mock.id);

  if (!decided || !decided.ok) {
    const reason =
      !decided || decided.reason === "scope_parts_mismatch"
        ? "응시 범위(파트)가 올바르지 않아요."
        : decided.reason === "incomplete_mock"
          ? "빠진 파트가 있어 실전 응시를 할 수 없어요. 학습 보기에서 파트를 먼저 만들거나, 있는 파트로 유형 연습을 해 주세요."
          : `이 모의고사에는 ${partParam ? jaSpeakingPartLabelKo(partParam as JaSpeakingPart) : "그"} 파트가 아직 없어요.`;
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

  const qs = decided.questions;
  return (
    <JaSpeakingTakeView
      mockId={mock.id}
      titleKo={mock.titleKo}
      scope={scope}
      parts={decided.parts}
      scopeLabelKo={jaSpeakingScopeLabelKo(scope, decided.parts)}
      questions={buildJaSpeakingQuestionViews(mock.parts, qs)}
      speechParts={{ respond: mock.parts.respond, info: mock.parts.info, opinion: mock.parts.opinion }}
      back={back}
    />
  );
}

/**
 * 🎙️ 말하기 모의고사 응시 결과 `/japanese/speaking/attempts/[id]` (docs/harness/japanese.md §15-10-2) — 서버 컴포넌트.
 *
 * 응시 기록과 그 모의고사를 읽어 문항별 화면 자료(buildJaSpeakingQuestionViews)와 함께 클라이언트 결과 화면에 넘긴다. 내 녹음 ▶(이 기기)·
 * AI 채점 받기·피드백·추정 수준·달성도는 클라이언트(JaSpeakingAttemptView). 시험 화면이 아니다(표현 도우미·상단 스트릭이 보인다 — 토익 결과와 같다).
 * 없는 응시·모의고사는 404(모의고사를 지우면 응시도 함께 지워진다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaSpeakingAttemptView from "@/components/ja-speaking-attempt-view";
import { buildJaSpeakingQuestionViews, jaSpeakingMockBackLink, jaSpeakingScopeLabelKo } from "@/lib/ja-speaking-contract";
import { isJaSpeakingAttemptClosed } from "@/lib/ja-speaking-record";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { formatKst } from "@/lib/kst";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface AttemptPageProps {
  params: Promise<{ id: string }>;
}

export const metadata: Metadata = { title: "말하기 모의고사 결과 — 아빠의 일본어" };

export default async function JaSpeakingAttemptPage({ params }: AttemptPageProps) {
  const { id } = await params;
  const store = getStore();
  const attempt = await store.getJaSpeakingAttempt(id);
  if (!attempt) notFound();
  const mock = await store.getJaSpeakingMock(attempt.mockId);
  if (!mock || !isRenderableJaSpeakingMock(mock)) notFound();
  const back = jaSpeakingMockBackLink(mock.id);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={back.href} className="u-navbtn">
            {back.labelKo}
          </Link>
          <p className="t-caption flex-none">{formatKst(attempt.startedAt)}</p>
        </div>
      </header>
      <JaSpeakingAttemptView
        attemptId={attempt.id}
        mockTitleKo={mock.titleKo}
        level={mock.level}
        scopeLabelKo={jaSpeakingScopeLabelKo(attempt.scope, attempt.parts)}
        questions={buildJaSpeakingQuestionViews(mock.parts, attempt.questions)}
        initialAnswers={attempt.answers}
        closed={isJaSpeakingAttemptClosed(attempt)}
        finished={attempt.finishedAt !== null}
      />
    </main>
  );
}

/**
 * 모의고사 응시 결과 `/toeic/attempts/[id]` (아빠의 영어 T5, docs/harness/toeic.md §5·§8) — 서버 컴포넌트.
 *
 * 응시 기록과 그 모의고사를 읽어 문항별 화면 자료(buildToeicQuestionViews)와 함께 클라이언트 결과 화면에 넘긴다.
 * 내 녹음 ▶(IndexedDB — 응시한 기기에만)·AI 채점 받기(WAV 정규화 → `POST /api/toeic/attempts/[id]/score`)·피드백 표시·
 * 추정 총점은 클라이언트(ToeicAttemptView)가 한다. 없는 응시·모의고사는 404(모의고사를 지우면 응시도 함께 지워진다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicAttemptView from "@/components/toeic-attempt-view";
import { formatKst } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { buildToeicQuestionViews, toeicScopeLabelKo } from "@/lib/toeic-attempt-contract";
import { isToeicAttemptClosed, toeicAttemptQuestions } from "@/lib/toeic-attempt-rules";
import { isRenderableToeicMock } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

interface AttemptPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: AttemptPageProps): Promise<Metadata> {
  const { id } = await params;
  const attempt = await getStore().getToeicAttempt(id);
  if (!attempt) return { title: "응시 기록을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `응시 결과 — 아빠의 영어` };
}

export default async function ToeicAttemptPage({ params }: AttemptPageProps) {
  const { id } = await params;
  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) notFound();
  const mock = await store.getToeicMock(attempt.mockId);
  if (!mock || !isRenderableToeicMock(mock)) notFound();

  const qs = toeicAttemptQuestions(attempt.parts);
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/toeic/mocks/${encodeURIComponent(mock.id)}`} className="u-navbtn">
            ← 학습 보기
          </Link>
          <p className="t-caption flex-none">{formatKst(attempt.startedAt)}</p>
        </div>
      </header>
      <ToeicAttemptView
        attempt={attempt}
        mockId={mock.id}
        mockTitleKo={mock.titleKo}
        scopeLabelKo={toeicScopeLabelKo(attempt.scope, attempt.parts)}
        closed={isToeicAttemptClosed(attempt)}
        questions={buildToeicQuestionViews(mock.parts, qs)}
      />
    </main>
  );
}

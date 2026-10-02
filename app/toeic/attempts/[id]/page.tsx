/**
 * 모의고사 응시 결과 `/toeic/attempts/[id]` (아빠의 영어 T5, docs/harness/toeic.md §5·§8) — 서버 컴포넌트.
 *
 * 응시 기록과 그 모의고사를 읽어 문항별 화면 자료(buildToeicQuestionViews)와 함께 클라이언트 결과 화면에 넘긴다.
 * 내 녹음 ▶(IndexedDB — 응시한 기기에만)·AI 채점 받기(WAV 정규화 → `POST /api/toeic/attempts/[id]/score`)·피드백 표시·
 * 추정 총점은 클라이언트(ToeicAttemptView)가 한다. 없는 응시·모의고사는 404(모의고사를 지우면 응시도 함께 지워진다).
 *
 * 문항 범위는 응시 기록의 `questions`(시작 라우트가 적었다 — 연습의 사진 묘사는 [3], 옛 문서는 파트 문항, §12-3).
 * 유형별 공략의 **한 문제 연습**(모의고사 문서의 drillPart — §12-7-5·§12-7-9):
 * - "뒤로"는 그 유형 폴더 ④ 탭(toeicMockBackLink), 범위 라벨은 "공략 연습 · …"(toeicDrillScopeLabelKo).
 * - 끝 버튼 줄은 "같은 문제 다시"·"새 문제"(학습 보기는 연습을 폴더로 보내므로 "학습 보기로"를 숨긴다 — 결과 화면이 받는 `drill`).
 * "🧩 틀 점검"(AI 없음 — 2026-10-02부터 **실전 모의고사에도**, docs/harness/toeic.md §12-13-3): 응시 범위의 파트마다(read 제외 — drillPart와
 * 상관없이) 틀 은행을 읽어 그 유형 틀·흐름과 단계마다 가장 약한 틀을 줄여 넘긴다(toeicTemplateCheckData — 클라이언트에는 예문·테스트 채움 없이
 * 틀 줄만). 틀 은행이 없거나 그 유형 틀이 0이면 그 파트는 점검이 없다. 모범답변 점검 줄("🧩 모범답변의 틀 n개 · 단계 a/b")은 문서에
 * **저장된 흐름**(answerFlows — 만들 때의 입력)으로 잰다(옛 문서는 [] → 줄 없음).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicAttemptView, { type ToeicAttemptDrillInfo } from "@/components/toeic-attempt-view";
import type { ToeicTemplateFlow } from "@/lib/ai/toeic/schemas";
import { formatKst } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { buildToeicQuestionViews, toeicDrillScopeLabelKo, toeicScopeLabelKo } from "@/lib/toeic-attempt-contract";
import { isToeicAttemptClosed } from "@/lib/toeic-attempt-rules";
import { toeicDrillUnitForMockPart } from "@/lib/toeic-drill";
import { toeicDrillFolderHref, toeicMockBackLink, toeicTemplateCheckData, type ToeicTemplateCheckData } from "@/lib/toeic-drill-view";
import { TOEIC_TEMPLATE_BANK_ID, toeicGuidePartOfMockPart } from "@/lib/toeic-guide";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import { toeicTakeHref } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, type ToeicMockPart } from "@/lib/toeic-mock";
import { isRenderableToeicMock, isRenderableToeicTemplateBank } from "@/lib/toeic-record";

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

  const qs = attempt.questions;
  const back = toeicMockBackLink(mock);

  const questions = buildToeicQuestionViews(mock.parts, qs);

  // ── 🧩 틀 점검 자료 — 응시 범위의 파트마다(read 제외 — 연습·실전 모의고사 모두, §12-13-3) ──
  const checks: Partial<Record<ToeicMockPart, ToeicTemplateCheckData>> = {};
  const checkParts = TOEIC_MOCK_PARTS.filter((p) => toeicGuidePartOfMockPart(p) !== null && questions.some((v) => v.part === p));
  if (checkParts.length > 0) {
    const [bank, bankSessions] = await Promise.all([store.getToeicSet(TOEIC_TEMPLATE_BANK_ID), store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID)]);
    if (bank !== null && isRenderableToeicTemplateBank(bank)) {
      const doc = bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[] };
      for (const p of checkParts) {
        const guidePart = toeicGuidePartOfMockPart(p);
        if (guidePart === null) continue;
        const { templates } = guideTemplatesForPart(doc.items, guidePart); // 렌더 가능한 틀만(깨진 틀은 빠진다)
        if (templates.length > 0) checks[p] = toeicTemplateCheckData(guidePart, templates, doc.flows, bankSessions);
      }
    }
  }

  // ── 한 문제 연습이면 끝 버튼 줄 ──
  let drill: ToeicAttemptDrillInfo | null = null;
  if (mock.drillPart !== null && toeicDrillUnitForMockPart(mock.drillPart)) {
    drill = {
      retakeHref: toeicTakeHref(mock.id, "part", mock.drillPart),
      newHref: toeicDrillFolderHref(mock.drillPart),
    };
  }

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
      <ToeicAttemptView
        attempt={attempt}
        mockId={mock.id}
        mockTitleKo={mock.titleKo}
        scopeLabelKo={mock.drillPart !== null ? toeicDrillScopeLabelKo(mock.drillPart, qs) : toeicScopeLabelKo(attempt.scope, attempt.parts)}
        closed={isToeicAttemptClosed(attempt)}
        questions={questions}
        drill={drill}
        checks={checks}
        answerFlows={mock.answerFlows}
      />
    </main>
  );
}

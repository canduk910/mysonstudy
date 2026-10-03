/**
 * 모의고사 응시 결과 `/toeic/attempts/[id]` (아빠의 영어 T5, docs/harness/toeic.md §5·§8) — 서버 컴포넌트.
 *
 * 응시 기록과 그 모의고사를 읽어 문항별 화면 자료(buildToeicQuestionViews)와 함께 클라이언트 결과 화면에 넘긴다.
 * 내 녹음 ▶(이 기기 IndexedDB 사본 → 서버 보관 사본 순, §13-8)·AI 채점 받기(WAV 정규화 → `POST /api/toeic/attempts/[id]/score`)·피드백 표시·
 * 추정 총점·🎧 비교(§13-9)는 클라이언트(ToeicAttemptView)가 한다. 비교 ③에 쓸 같은 모의고사 응시 기록(최신 20회, 줄인 자료)을 여기서 읽어 넘긴다. 없는 응시·모의고사는 404(모의고사를 지우면 응시도 함께 지워진다).
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
import { TOEIC_COMPARE_ATTEMPTS_MAX, pickToeicCompareAttempts, toToeicCompareAttempt } from "@/lib/toeic-compare";
import { frameDrillFramesForPart, frameDrillTopicsForPart } from "@/lib/toeic-frame-drill";
import { islandDocId, islandPartOfMockPart, suggestIslandTopic, type ToeicIslandPart } from "@/lib/toeic-island";
import type { ToeicAttemptIslandData } from "@/lib/toeic-island-contract";

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

  // ── 🏝️ 내 섬에 담기(§21-3 ②) — Q5–7·Q11 문항에 채점 결과가 있을 때만. 소재 칩 = 틀 말하기 은행 소재, 추천 = 문장에 쓰인 틀의 소재(AI 없음) ──
  let island: ToeicAttemptIslandData | null = null;
  const islandQs = questions.filter((v) => islandPartOfMockPart(v.part) !== null && attempt.answers.some((a) => a.q === v.q && a.feedback));
  if (islandQs.length > 0) {
    const [frameBank, entries, tplBank] = await Promise.all([
      store.getToeicFrameDrillBank().catch(() => null),
      store.listToeicIslandEntries().catch(() => []),
      store.getToeicSet(TOEIC_TEMPLATE_BANK_ID).catch(() => null),
    ]);
    const tplItems = tplBank !== null && isRenderableToeicTemplateBank(tplBank) ? (tplBank.guide as { items: unknown[] }).items : [];
    const topicsByPart: ToeicAttemptIslandData["topicsByPart"] = {};
    const suggest: Record<string, string | null> = {};
    for (const v of islandQs) {
      const ip = islandPartOfMockPart(v.part) as ToeicIslandPart;
      const frames = frameBank ? frameDrillFramesForPart(frameBank, ip) : [];
      const tpls = tplItems.length > 0 ? guideTemplatesForPart(tplItems, ip).templates : [];
      if (!topicsByPart[ip]) topicsByPart[ip] = frameBank ? frameDrillTopicsForPart(frameBank, ip).map((t) => ({ key: t.topic.key, nameKo: t.topic.nameKo })) : [];
      const fb = attempt.answers.find((a) => a.q === v.q)?.feedback;
      if (!fb) continue;
      const imp = islandDocId({ kind: "attempt", attemptId: attempt.id, q: v.q, fixIndex: null });
      if (imp) suggest[imp] = suggestIslandTopic(fb.improvedAnswer, frames, tpls);
      fb.fixes.forEach((f, k) => {
        const fid = islandDocId({ kind: "attempt", attemptId: attempt.id, q: v.q, fixIndex: k });
        if (fid) suggest[fid] = suggestIslandTopic(f.better, frames, tpls) ?? (imp ? suggest[imp] : null);
      });
    }
    const savedIds = entries.filter((e) => e.origin.kind === "attempt" && e.origin.attemptId === attempt.id).map((e) => e.id);
    island = { topicsByPart, savedIds, suggest };
  }

  // ── 🎧 비교 ③ 다시 풀기 기록(§13-9) — 같은 모의고사(연습은 같은 연습 문서)의 응시를 최신 20회까지, **줄인 자료**만 넘긴다(피드백 본문 없음) ──
  const sameMock = await store.listToeicAttemptsByMock(mock.id);
  const history = pickToeicCompareAttempts(sameMock, attempt.id, TOEIC_COMPARE_ATTEMPTS_MAX).map(toToeicCompareAttempt);

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
      {/* 인쇄(§16)에서는 머리째로 뺀다 — 응시 날짜는 결과 화면의 인쇄 전용 줄이 다시 적는다 */}
      <header className="print-hide mb-4">
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
        history={history}
        island={island}
      />
    </main>
  );
}

/**
 * 🧩 틀 테스트 `/toeic/guides/[part]/templates/test?mode=recall|swap&scope=group|step|wrong|all&group=&step=`
 * (docs/harness/toeic.md §12-5-3·§12-8, SPEC §20-10) — 서버 컴포넌트.
 *
 * **문항 조립을 서버가 한다**(lib/toeic-template의 순수 함수 buildTemplateTestQuestions — 약한 틀 먼저 + 복습 칸 최대 2 + 흐름 순서,
 * 한 판 한 틀, 예문·채움은 시도 수로 결정적). 서버가 1회 조립해 넘기면 문항이 고정이라 hydration이 안전하다(표현 시험 페이지 관용구).
 * `?t=`는 "다시 테스트" 논스 — 서버 재조립을 강제하고 화면을 remount한다.
 *
 * 읽기: 틀 은행(`guide-templates` — isRenderableToeicTemplateBank, 틀은 하나씩 isRenderableToeicTemplate)과 틀 세션(setId 하나).
 * 범위의 틀은 흐름 순서(templateFlowOrder)로 자르고(templateTestScopeTemplates), "틀린 틀만"은 그 모드의 틀린 틀(onlyWrong)이다.
 * (가) 예문 말하기는 같은 유형 안 한국어 틀이 같은 **대안 틀**(templateAlternatives — 교재가 같은 뜻으로 가르친 어휘 짝)을 함께 넘긴다
 * (화면이 compareWithAlternatives로 대조). 화면에는 문항에 필요한 칸만 넘긴다(다른 예문·다른 테스트 채움은 넘기지 않는다).
 * AI 없음 — 받아쓰기(관문 T)는 화면이 🎤 멈춤 때 전사 라우트로 부른다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicTemplateTest, { type ToeicTemplateTestItemView } from "@/components/toeic-template-test";
import s from "@/components/toeic-template-test.module.css";
import { getStore } from "@/lib/store";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, TOEIC_TEMPLATE_BANK_ID, isToeicGuidePart } from "@/lib/toeic-guide";
import type { ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { isRenderableToeicTemplateBank } from "@/lib/toeic-record";
import { buildTemplateTestQuestions, templateAlternatives, templateFlowOrder } from "@/lib/toeic-template";
import { parseTemplateTestParams, templateTestScopeTemplates, toeicTemplateTabHref, toeicTemplateTestHref } from "@/lib/toeic-template-test-view";

export const dynamic = "force-dynamic";

interface TestPageProps {
  params: Promise<{ part: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: TestPageProps): Promise<Metadata> {
  const { part } = await params;
  if (!isToeicGuidePart(part)) return { title: "유형을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `🧩 틀 테스트 — ${toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])}` };
}

export default async function ToeicTemplateTestPage({ params, searchParams }: TestPageProps) {
  const { part } = await params;
  if (!isToeicGuidePart(part)) notFound();
  const sp = await searchParams;
  const p = parseTemplateTestParams(sp);
  const nonce = Array.isArray(sp.t) ? sp.t[0] : (sp.t ?? "0");

  const store = getStore();
  const [bank, sessions] = await Promise.all([store.getToeicSet(TOEIC_TEMPLATE_BANK_ID), store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID)]);
  const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
  const bankDoc = bankOk ? (bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[] }) : null;
  const { templates } = guideTemplatesForPart(bankDoc?.items ?? [], part);
  const groups = templateFlowOrder({ flows: bankDoc?.flows ?? [], items: templates }, part);
  const scoped = templateTestScopeTemplates(groups, p);
  const built = buildTemplateTestQuestions(scoped.templates, sessions, { mode: p.mode, onlyWrong: p.scope === "wrong" });

  const questions: ToeicTemplateTestItemView[] = built.map((q) => ({
    key: q.key,
    groupKo: q.template.groupKo,
    useKo: q.template.useKo,
    frameEn: q.template.frameEn,
    frameKo: q.template.frameKo,
    answerEn: q.answerEn,
    answerFills: q.answerFills,
    answerKo: q.answerKo,
    listenEn: q.listenEn,
    review: q.review,
    alternatives: p.mode === "tpl-recall" ? templateAlternatives(q.template, templates).map((a) => ({ key: a.key, frameEn: a.frameEn, frameKo: a.frameKo })) : [],
  }));

  const partLabelKo = toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]);
  const backHref = toeicTemplateTabHref(part);
  const modeHrefs = {
    "tpl-recall": toeicTemplateTestHref(part, { ...p, mode: "tpl-recall" }),
    "tpl-swap": toeicTemplateTestHref(part, { ...p, mode: "tpl-swap" }),
  };

  let emptyKo: string | null = null;
  if (!bankOk) emptyKo = bank ? "⚠️ 틀 모음 문서의 형식이 맞지 않아 열지 못했어요. 가져오기 파일을 다시 넣어 주세요." : "아직 틀이 없어요. 공략 파일을 먼저 가져와 주세요.";
  else if (templates.length === 0) emptyKo = "이 유형에는 아직 틀이 없어요.";
  else if (questions.length === 0) emptyKo = p.scope === "wrong" ? "이 범위에 틀린 틀이 없어요. 🎉" : "이 범위에 테스트할 틀이 없어요.";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className={s.head}>
        <div className="flex items-center justify-between gap-3">
          <Link href={backHref} className="u-navbtn">
            ← 템플릿 훈련
          </Link>
          <p className="t-caption flex-none">{partLabelKo}</p>
        </div>
        <h1 className="t-book-title mt-3">🧩 틀 테스트</h1>
      </header>

      {emptyKo !== null ? (
        <section className={s.empty}>
          <p className={s.emptyText}>{emptyKo}</p>
          <Link href={backHref} className="u-btn u-btn-primary">
            🧩 템플릿 훈련으로
          </Link>
        </section>
      ) : (
        <ToeicTemplateTest
          key={`${p.mode}|${p.scope}|${p.group ?? ""}|${p.step ?? ""}|${nonce}`}
          part={part}
          mode={p.mode}
          scope={p.scope}
          scopeLabelKo={scoped.labelKo}
          questions={questions}
          backHref={backHref}
          modeHrefs={modeHrefs}
          retryHref={toeicTemplateTestHref(part, p)}
          wrongRetryHref={toeicTemplateTestHref(part, { mode: p.mode, scope: "wrong" })}
        />
      )}
    </main>
  );
}

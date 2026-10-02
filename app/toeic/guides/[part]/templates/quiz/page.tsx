/**
 * 👀 틀 시험 한 판 `/toeic/guides/[part]/templates/quiz?modes=…&scope=all|step|group|wrong&i=…&wrong=…`
 * (docs/harness/toeic.md §12-13-2, SPEC §20-10) — 서버 컴포넌트.
 *
 * **문항 조립을 서버가 한다**(lib/toeic-template-quiz의 순수 함수 buildTemplateChoiceQuestions — 약한 틀 먼저, 한 판 한 틀 한 문항, 모드별로 묶어
 * 섞기, 빈칸 낱말은 시도 수로 결정적). 서버가 1회 조립해 넘기면 문항이 고정이라 hydration이 안전하다(5지선다라 정답은 화면이 채점한다).
 * `?t=`는 "다시 풀기" 논스 — 서버 재조립을 강제하고 화면을 remount한다.
 *
 * 읽기: 틀 은행(`guide-templates` — isRenderableToeicTemplateBank, 틀은 하나씩 isRenderableToeicTemplate)과 틀 은행 세션(setId 하나 — 고르기
 * 세 모드 통계만 본다, 말하기와 섞지 않는다). 범위의 틀은 흐름 순서(templateFlowOrder)로 자르고(templateChoiceScopeTemplates — 주소의 번호 `i`,
 * 범위 밖이면 유형 전체), 오답 보기는 범위와 상관없이 그 유형 틀 전부에서 고른다. 화면에는 문항 칸만 넘긴다(틀 객체·testFills 없음).
 * AI 없음 — 발음만(답한 뒤 영어 틀·예문 en-US).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicTemplateQuiz from "@/components/toeic-template-quiz";
import s from "@/components/toeic-template-test.module.css";
import { getStore } from "@/lib/store";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, TOEIC_TEMPLATE_BANK_ID, isToeicGuidePart } from "@/lib/toeic-guide";
import type { ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { guideTemplatesForPart, parseTemplateChoiceQuizParams, templateChoiceScopeTemplates, toeicGuideFolderHref, toeicTemplateChoiceQuizHref } from "@/lib/toeic-guide-view";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO } from "@/lib/toeic-quiz";
import { isRenderableToeicTemplateBank } from "@/lib/toeic-record";
import { templateFlowOrder } from "@/lib/toeic-template";
import { buildTemplateChoiceQuestions } from "@/lib/toeic-template-quiz";

export const dynamic = "force-dynamic";

interface QuizPageProps {
  params: Promise<{ part: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ params }: QuizPageProps): Promise<Metadata> {
  const { part } = await params;
  if (!isToeicGuidePart(part)) return { title: "유형을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `👀 틀 시험 — ${toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])}` };
}

export default async function ToeicTemplateQuizPage({ params, searchParams }: QuizPageProps) {
  const { part } = await params;
  if (!isToeicGuidePart(part)) notFound();
  const sp = await searchParams;
  const p = parseTemplateChoiceQuizParams((name) => one(sp[name]));
  const nonce = one(sp.t) ?? "0";

  const store = getStore();
  const [bank, sessions] = await Promise.all([store.getToeicSet(TOEIC_TEMPLATE_BANK_ID), store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID)]);
  const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
  const bankDoc = bankOk ? (bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[] }) : null;
  const { templates } = guideTemplatesForPart(bankDoc?.items ?? [], part);
  const flows = bankDoc?.flows ?? [];
  const groups = templateFlowOrder({ flows, items: templates }, part);
  const scoped = templateChoiceScopeTemplates(groups, p);
  const onlyWrong = scoped.scope === "wrong" && p.wrong !== null ? p.wrong : undefined;
  const built = buildTemplateChoiceQuestions(scoped.templates, templates, sessions, {
    modes: p.modes,
    onlyWrong,
    flow: flows.find((f) => f.part === part) ?? null,
  });

  // 범위 이름(화면에만 — 주소에는 번호만 싣는다)
  const steps: string[] = [];
  for (const g of groups) if (g.kind === "step" && g.stepKo !== null && !steps.includes(g.stepKo)) steps.push(g.stepKo);
  const scopeLabelKo =
    scoped.scope === "step" && p.i !== null
      ? `단계 · ${steps[p.i] ?? ""}`
      : scoped.scope === "group" && p.i !== null
        ? `묶음 · ${groups[p.i]?.groupKo ?? ""}`
        : onlyWrong
          ? `틀린 틀 · ${TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO[onlyWrong]}`
          : "유형 전체";

  const partLabelKo = toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]);
  const backHref = toeicGuideFolderHref(part, { tab: "quiz" });

  let emptyKo: string | null = null;
  if (!bankOk) emptyKo = bank ? "⚠️ 틀 모음 문서의 형식이 맞지 않아 열지 못했어요. 가져오기 파일을 다시 넣어 주세요." : "아직 틀이 없어요. 공략 파일을 먼저 가져와 주세요.";
  else if (templates.length === 0) emptyKo = "이 유형에는 아직 틀이 없어요.";
  else if (built.questions.length === 0) emptyKo = onlyWrong ? "이 방식에서 다시 볼 틀린 틀이 없어요. 🎉" : "이 범위·방식으로 낼 수 있는 문항이 없어요.";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className={s.head}>
        <div className="flex items-center justify-between gap-3">
          <Link href={backHref} className="u-navbtn">
            ← 틀 시험
          </Link>
          <p className="t-caption flex-none">{partLabelKo}</p>
        </div>
        <h1 className="t-book-title mt-3">👀 틀 시험</h1>
      </header>

      {emptyKo !== null ? (
        <section className={s.empty}>
          <p className={s.emptyText}>{emptyKo}</p>
          <Link href={backHref} className="u-btn u-btn-primary">
            👀 틀 시험으로
          </Link>
        </section>
      ) : (
        <ToeicTemplateQuiz
          key={`${p.modes.join(",")}|${p.scope}|${p.i ?? ""}|${p.wrong ?? ""}|${nonce}`}
          part={part}
          scopeLabelKo={scopeLabelKo}
          questions={built.questions}
          skipped={built.skipped}
          backHref={backHref}
          retryHref={toeicTemplateChoiceQuizHref(part, p)}
        />
      )}
    </main>
  );
}

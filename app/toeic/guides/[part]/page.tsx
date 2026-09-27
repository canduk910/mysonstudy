/**
 * 유형 폴더 `/toeic/guides/[part]` (docs/harness/toeic.md §12-8, SPEC §20-10) — 서버 컴포넌트.
 *
 * part ∈ q3_4 | q5_7 | q8_10 | q11(그 밖은 404). 탭은 학습 흐름 순서(① 📖 공략 읽기 ② 🧩 템플릿 훈련 ③ 📝 표현 시험 ④ 🎤 한 문제 연습)이고
 * 주소가 탭을 기억한다(`?tab=` — 클라이언트 뷰가 useSearchParams로 읽는다). `?tab`이 없으면 그 유형 틀이 1개 이상일 때 ② 템플릿 훈련,
 * 없으면 ① 읽기(§12-8). ④ 한 문제 연습(`?tab=drill`)은 공략·틀 없이도 된다(AI가 새로 만든다 — §12-8 빈 상태).
 *
 * 이 페이지는 데이터 로딩·404·렌더 판정만 맡는다(판정은 lib/toeic-record 단일 정의처):
 * - 유형 공략 문서 `guide-{part}` — isToeicGuidePartSet + isRenderableToeicSet + isRenderableToeicGuide(📖 읽기·③ 표현 목록)
 * - 틀 은행 `guide-templates` — isRenderableToeicTemplateBank, 틀은 하나씩 isRenderableToeicTemplate(깨진 틀만 빠진다)
 * - 틀 테스트 세션(setId `guide-templates`) → 배지·틀린 틀·익힘·최근 테스트·모드별 틀린 틀 수(§12-5-6), 유형 공략 세트의 표현 시험 세션 → 틀 카드의 표현 시험 상태
 *   (읽기만 — 숙련도는 섞지 않는다, §12-5-7). "오늘"은 서버가 kstTodayString()으로(hydration 안전 — app-patterns §1).
 * - ④ 한 문제 연습(§12-7·§12-8): 그 유형 연습(`listToeicDrills` — drillPart 등호 하나)과 그 응시들(응시 컬렉션을 읽어 메모리에서 모은다)
 *   → 최근 연습 최신 10·응시 전 연습 수·가장 최근 응시 전 연습(lib/toeic-drill-view summarizeToeicDrill), 🧩 이 유형 답변 흐름(단계마다
 *   가장 약한 틀 하나 — drillStepPicks, 틀 테스트 세션으로). 파트 본문(모범답변 등)은 넘기지 않는다 — 응시 전 노출 방지.
 * 클라이언트에는 직렬화 가능한 값만 넘긴다(lib/ai 값은 넘기지 않는다 — 타입은 lib/toeic-guide-contract 재수출).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicGuideFolderView, { type ToeicGuideFolderData } from "@/components/toeic-guide-folder-view";
import s from "@/components/toeic-guide-folder-view.module.css";
import { kstTodayString } from "@/lib/kst";
import { getStore } from "@/lib/store";
import type { ToeicGuideSection, ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, TOEIC_TEMPLATE_BANK_ID, isToeicGuidePart, toeicGuideSetId } from "@/lib/toeic-guide";
import {
  TOEIC_TEMPLATE_CARD_EXPRESSION_MODES,
  expressionStatBadge,
  guideTemplatesForPart,
  templateSwapMasteredKeys,
} from "@/lib/toeic-guide-view";
import { toeicDrillUnit } from "@/lib/toeic-drill";
import { TOEIC_DRILL_RECENT_MAX, drillStepPicks, pendingToeicDrills, summarizeToeicDrill } from "@/lib/toeic-drill-view";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_TEMPLATE_QUIZ_MODES, aggregateToeicStatsByMode, isToeicQuizModeSession } from "@/lib/toeic-quiz";
import { isRenderableToeicGuide, isRenderableToeicMock, isRenderableToeicSet, isRenderableToeicTemplateBank, isToeicGuidePartSet } from "@/lib/toeic-record";
import { toeicTemplateBadges, toeicTemplateWrongKeysAnyMode } from "@/lib/toeic-template";
import { recentTemplateTests, templateWrongCountsByMode } from "@/lib/toeic-template-test-view";
import { expressionKey } from "@/lib/toeic-text";

export const dynamic = "force-dynamic";

interface FolderPageProps {
  params: Promise<{ part: string }>;
}

export async function generateMetadata({ params }: FolderPageProps): Promise<Metadata> {
  const { part } = await params;
  if (!isToeicGuidePart(part)) return { title: "유형을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])} — 유형별 공략` };
}

export default async function ToeicGuideFolderPage({ params }: FolderPageProps) {
  const { part } = await params;
  if (!isToeicGuidePart(part)) notFound();

  const store = getStore();
  const guideId = toeicGuideSetId(part);
  const unit = toeicDrillUnit(part)!; // 네 유형 모두 단위표에 있다(isToeicGuidePart 뒤)
  const [guideSet, bank, bankSessions, guideSessions, drills, attempts] = await Promise.all([
    store.getToeicSet(guideId),
    store.getToeicSet(TOEIC_TEMPLATE_BANK_ID),
    store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID),
    store.listToeicQuizzes(guideId),
    store.listToeicDrills(unit.mockPart),
    store.listAllToeicAttempts(),
  ]);

  // ── 유형 공략(📖·③) ──
  const guideOk = guideSet !== null && isToeicGuidePartSet(guideSet) && isRenderableToeicSet(guideSet) && isRenderableToeicGuide(guideSet);
  const guideDoc = guideOk ? (guideSet.guide as { introKo: string | null; sections: ToeicGuideSection[] }) : null;

  // ── 틀 은행(②) ──
  const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
  const bankDoc = bankOk ? (bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[] }) : null;
  const { templates, broken: brokenTemplates } = guideTemplatesForPart(bankDoc?.items ?? [], part);
  const partKeys = new Set(templates.map((t) => t.key));
  const onlyPart = <T,>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([k]) => partKeys.has(k)));

  // 배지·틀린 틀·익힘 — 틀 은행 세션(setId 하나, 두 모드 따로, 같은 날 ○ 접기는 순수 함수가 한다)
  const allBadges = toeicTemplateBadges(bankSessions, kstTodayString());
  const badges = Object.fromEntries(TOEIC_TEMPLATE_QUIZ_MODES.map((m) => [m, onlyPart(allBadges[m])])) as ToeicGuideFolderData["badges"];
  const wrongKeys = [...toeicTemplateWrongKeysAnyMode(bankSessions)].filter((k) => partKeys.has(k));
  const masteredKeys = [...templateSwapMasteredKeys(bankSessions)].filter((k) => partKeys.has(k));

  // 틀 카드의 표현 시험 상태(§12-5-7) — 틀이 연결한 교재 표현만, 공략 세트의 표현 시험 세션(표현 시험 모드만)으로. 시도가 있는 모드만 싣는다.
  const exprBadges: ToeicGuideFolderData["exprBadges"] = {};
  if (guideOk) {
    const stats = aggregateToeicStatsByMode(guideSessions.filter(isToeicQuizModeSession));
    for (const t of templates) {
      for (const r of t.guideRefs) {
        if (r.kind !== "expression" || r.part !== part) continue;
        const k = expressionKey(r.expression);
        if (k in exprBadges) continue;
        const entry = guideSet.entries.find((e) => expressionKey(e.expression) === k);
        if (!entry) continue;
        const list = TOEIC_TEMPLATE_CARD_EXPRESSION_MODES.map((mode) => ({ mode, badge: expressionStatBadge(stats[mode][entry.expression]) })).filter(
          (x): x is { mode: (typeof x)["mode"]; badge: NonNullable<(typeof x)["badge"]> } => x.badge !== null,
        );
        if (list.length > 0) exprBadges[k] = list;
      }
    }
  }

  // ── ④ 한 문제 연습 — 최근 연습·응시 전 연습·답변 흐름(단계마다 가장 약한 틀) ──
  const drillIds = new Set(drills.map((d) => d.id));
  const drillAttempts = attempts.filter((a) => drillIds.has(a.mockId));
  const drillSummaries = drills.filter(isRenderableToeicMock).map((d) => summarizeToeicDrill(d, drillAttempts));
  const pendingDrills = pendingToeicDrills(drillSummaries);
  const partFlows = (bankDoc?.flows ?? []).filter((f) => f.part === part);

  const partLabelKo = toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]);
  const data: ToeicGuideFolderData = {
    part,
    partLabelKo,
    guide: guideDoc
      ? {
          sections: guideDoc.sections,
          expressions: guideSet!.entries.map((e) => ({ no: e.no, expression: e.expression, meaningKo: e.meaningKo, example: e.example, exampleKo: e.exampleKo })),
          speakCount: guideSet!.quiz.length,
        }
      : null,
    guideBroken: guideSet !== null && guideSet.guide !== null && !guideOk,
    // testFills는 비워서 — 틀 바꿔 말하기의 정답 채움이 ② 카드·페이지 소스에 먼저 나오지 않게(§12-5-1, S1 QA P3-6). ②·①·③ 탭은 쓰지 않는다.
    templates: templates.map((t) => ({ ...t, testFills: [] })),
    flows: (bankDoc?.flows ?? []).filter((f) => f.part === part),
    brokenTemplates: bankOk ? brokenTemplates : 0,
    bankBroken: bank !== null && !bankOk,
    badges,
    wrongKeys,
    masteredKeys,
    exprBadges,
    recentTests: recentTemplateTests(bankSessions, partKeys),
    wrongCounts: templateWrongCountsByMode(bankSessions, partKeys),
    drill: {
      mockPart: unit.mockPart,
      recent: drillSummaries.slice(0, TOEIC_DRILL_RECENT_MAX),
      pendingCount: pendingDrills.length,
      latestPending: pendingDrills[0] ?? null,
      flow: drillStepPicks(templates, bankSessions, part, partFlows).map((p) => ({
        stepKo: p.stepKo,
        template: p.template ? { key: p.template.key, frameEn: p.template.frameEn, frameKo: p.template.frameKo } : null,
      })),
    },
  };

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className={s.head}>
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic/guides" className="u-navbtn">
            ← 유형별 공략
          </Link>
        </div>
        <h1 className="t-book-title mt-3">{partLabelKo}</h1>
        {guideDoc?.introKo && <p className={s.intro}>{guideDoc.introKo}</p>}
      </header>

      <ToeicGuideFolderView data={data} />
    </main>
  );
}

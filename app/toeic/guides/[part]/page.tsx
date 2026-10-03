/**
 * 유형 폴더 `/toeic/guides/[part]` (docs/harness/toeic.md §12-8, SPEC §20-10) — 서버 컴포넌트.
 *
 * part ∈ q3_4 | q5_7 | q8_10 | q11(그 밖은 404). 탭은 학습 흐름 순서(① 📖 공략 읽기 ② 🧩 템플릿 훈련 ③ 👀 틀 시험 ④ 🎤 한 문제 연습)이고
 * 주소가 탭을 기억한다(`?tab=` — 클라이언트 뷰가 useSearchParams로 읽는다). `?tab`이 없으면 그 유형 틀이 1개 이상일 때 ② 템플릿 훈련,
 * 없으면 ① 읽기(§12-8). ④ 한 문제 연습(`?tab=drill`)은 공략·틀 없이도 된다(AI가 새로 만든다 — §12-8 빈 상태).
 *
 * 이 페이지는 데이터 로딩·404·렌더 판정만 맡는다(판정은 lib/toeic-record 단일 정의처):
 * - 유형 공략 문서 `guide-{part}` — isToeicGuidePartSet + isRenderableToeicSet + isRenderableToeicGuide(📖 읽기 + 끝의 📘 교재 표현 목록)
 * - 틀 은행 `guide-templates` — isRenderableToeicTemplateBank, 틀은 하나씩 isRenderableToeicTemplate(깨진 틀만 빠진다). 같은 자리 다른 표현
 *   (`alternates` — 그 유형 것)은 ① 읽기의 접기 판정(guideReadMarks)에, "① 본문에 외울 틀 줄이 있는 틀 key"는 ② 카드의 📘 교재 틀(표현 연결)에.
 * - 틀 은행 세션(setId `guide-templates`) → ② 배지·틀린 틀·익힘·최근 테스트·모드별 틀린 틀 수(말하기 두 모드, §12-5-6), ③ 👀 틀 시험의
 *   틀린 틀·최근 틀 시험(고르기 세 모드 — §12-13-2, 말하기와 섞지 않는다), ② 카드의 "👀 ✕ n"(틀린 고르기 모드 수). **유형 공략 세트의 시험
 *   세션은 읽지 않는다**(2026-10-02 — 교재 표현 시험을 닫았다). "오늘"은 서버가 kstTodayString()으로(hydration 안전 — app-patterns §1).
 * - ④ 한 문제 연습(§12-7·§12-8): 그 유형 연습(`listToeicDrills` — drillPart 등호 하나)과 그 응시들(응시 컬렉션을 읽어 메모리에서 모은다)
 *   → 최근 연습 최신 10·응시 전 연습 수·가장 최근 응시 전 연습(lib/toeic-drill-view summarizeToeicDrill), 🧩 이 유형 답변 흐름(§12-13-3 —
 *   buildAnswerFlow(…, { order: "flow" }) → drillPrepFlowFold: 단계마다 첫 틀 + "+n", 소재 틀 — 모범답변이 고르는 목록과 같다). 파트 본문
 *   (모범답변 등)은 넘기지 않는다 — 응시 전 노출 방지.
 * - ⑤ 🗣️ 틀 말하기(§20 — Q5–7·Q11 폴더만): 소재별 틀 말하기 은행(`toeicFrameBank`)·통계·지난 판 → buildFrameDrillTabData(소재·틀·문항 수·
 *   오답률·질문 유형·최근 판). 문항 글(한국어·모범 영어)은 넘기지 않는다 — 출제는 진행 화면이 서버에서 한다. 읽기 실패는 이 탭만 빈 상태.
 * 클라이언트에는 직렬화 가능한 값만 넘긴다(lib/ai 값은 넘기지 않는다 — 타입은 lib/toeic-guide-contract 재수출).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicGuideFolderView, { type ToeicGuideFolderData } from "@/components/toeic-guide-folder-view";
import s from "@/components/toeic-guide-folder-view.module.css";
import { kstTodayString } from "@/lib/kst";
import { getStore } from "@/lib/store";
import type { ToeicGuideSection, ToeicTemplateAlternate, ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, TOEIC_TEMPLATE_BANK_ID, isToeicGuidePart, toeicGuideSetId } from "@/lib/toeic-guide";
import { guideReadFrameKeys, guideReadMarks, guideTemplatesForPart, templateSwapMasteredKeys } from "@/lib/toeic-guide-view";
import { toeicDrillUnit } from "@/lib/toeic-drill";
import { TOEIC_DRILL_RECENT_MAX, drillPrepFlowFold, pendingToeicDrills, summarizeToeicDrill } from "@/lib/toeic-drill-view";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_TEMPLATE_CHOICE_MODES, TOEIC_TEMPLATE_QUIZ_MODES } from "@/lib/toeic-quiz";
import { isRenderableToeicGuide, isRenderableToeicMock, isRenderableToeicSet, isRenderableToeicTemplateBank, isToeicGuidePartSet } from "@/lib/toeic-record";
import {
  buildAnswerFlow,
  templateAlternateLinks,
  templateLinksForGuide,
  toeicTemplateBadges,
  toeicTemplateWrongKeysAnyMode,
} from "@/lib/toeic-template";
import {
  aggregateToeicTemplateChoiceStats,
  recentTemplateChoiceTests,
  toeicTemplateChoiceBadges,
  toeicTemplateChoiceWrongKeys,
  toeicTemplateChoiceWrongModeCounts,
} from "@/lib/toeic-template-quiz";
import { recentTemplateTests, templateWrongCountsByMode } from "@/lib/toeic-template-test-view";
import { TOEIC_FRAME_DRILL_PARTS, type ToeicFrameDrillPart } from "@/lib/toeic-frame-drill";
import { buildFrameDrillTabData, type ToeicFrameDrillTabData } from "@/lib/toeic-frame-drill-view";

/** ⑤ 틀 말하기 탭 자료 — 은행·통계·판을 읽는다. 읽기 실패는 이 탭만 "열지 못했어요"(다른 탭을 죽이지 않게) */
async function loadFrameDrillTab(part: ToeicFrameDrillPart): Promise<ToeicFrameDrillTabData> {
  const store = getStore();
  try {
    const [bank, stats, sessions] = await Promise.all([store.getToeicFrameDrillBank(), store.getToeicFrameDrillStats(), store.listToeicFrameDrillSessions()]);
    return buildFrameDrillTabData({ part, bank, bankExists: bank !== null, stats: stats.items, sessions });
  } catch (err) {
    console.error("[toeic guides] 틀 말하기 은행을 읽지 못했다:", err instanceof Error ? err.name : "unknown");
    return { part, bankState: "broken", topics: [], questionTypes: [], recent: [], bankItems: 0 };
  }
}

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
  const framePart = (TOEIC_FRAME_DRILL_PARTS as readonly string[]).includes(part) ? (part as ToeicFrameDrillPart) : null;
  const [guideSet, bank, bankSessions, drills, attempts, frameTab] = await Promise.all([
    store.getToeicSet(guideId),
    store.getToeicSet(TOEIC_TEMPLATE_BANK_ID),
    store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID),
    store.listToeicDrills(unit.mockPart),
    store.listAllToeicAttempts(),
    framePart ? loadFrameDrillTab(framePart) : Promise.resolve(null),
  ]);
  const today = kstTodayString();

  // ── 유형 공략(📖·③) ──
  const guideOk = guideSet !== null && isToeicGuidePartSet(guideSet) && isRenderableToeicSet(guideSet) && isRenderableToeicGuide(guideSet);
  const guideDoc = guideOk ? (guideSet.guide as { introKo: string | null; sections: ToeicGuideSection[] }) : null;

  // ── 틀 은행(②) ──
  const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
  const bankDoc = bankOk ? (bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[]; alternates: ToeicTemplateAlternate[] }) : null;
  const { templates, broken: brokenTemplates } = guideTemplatesForPart(bankDoc?.items ?? [], part);
  const bankAlternates = Array.isArray(bankDoc?.alternates) ? bankDoc.alternates : [];
  const partAlternates = bankAlternates.filter((a) => a.part === part);
  const partKeys = new Set(templates.map((t) => t.key));
  const onlyPart = <T,>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([k]) => partKeys.has(k)));

  // 배지·틀린 틀·익힘 — 틀 은행 세션(setId 하나, 두 모드 따로, 같은 날 ○ 접기는 순수 함수가 한다)
  const allBadges = toeicTemplateBadges(bankSessions, today);
  const badges = Object.fromEntries(TOEIC_TEMPLATE_QUIZ_MODES.map((m) => [m, onlyPart(allBadges[m])])) as ToeicGuideFolderData["badges"];
  const wrongKeys = [...toeicTemplateWrongKeysAnyMode(bankSessions)].filter((k) => partKeys.has(k));
  const masteredKeys = [...templateSwapMasteredKeys(bankSessions)].filter((k) => partKeys.has(k));

  // ③ 👀 틀 시험(§12-13-2) — 고르기 세 모드 통계(틀 은행 세션 — 말하기 두 모드와 섞지 않는다). 그 유형 틀만.
  const choiceStats = aggregateToeicTemplateChoiceStats(bankSessions);
  const choiceBadges = toeicTemplateChoiceBadges(bankSessions, today);
  const choiceWrong = Object.fromEntries(
    TOEIC_TEMPLATE_CHOICE_MODES.map((m) => {
      const keys = [...toeicTemplateChoiceWrongKeys(bankSessions, m)].filter((k) => partKeys.has(k));
      const rows = keys
        .map((key) => ({ key, wrong: choiceStats[m][key]?.wrong ?? 0, badge: choiceBadges[m][key] ?? "wrong" }))
        .sort((a, b) => b.wrong - a.wrong);
      return [m, rows];
    }),
  ) as ToeicGuideFolderData["choice"]["wrong"];
  // ② 카드 "👀 ✕ n" — 고르기 세 모드 중 그 틀이 틀린 틀에 든 모드 수(0이면 키 없음 — 칩 없음)
  const choiceWrongCounts = onlyPart(Object.fromEntries(toeicTemplateChoiceWrongModeCounts(bankSessions)));

  // ① 읽기의 외울 틀 줄(§12-13-1) — ② 카드의 📘 교재 틀(표현 연결)은 ① 본문에 그 틀의 외울 틀 줄이 있을 때만 보인다
  const readFrameKeys =
    guideDoc && bankDoc
      ? [...guideReadFrameKeys(guideReadMarks(guideDoc.sections, templateLinksForGuide({ items: templates }, part), templateAlternateLinks(bankDoc, part), templates))]
      : [];

  // ── ④ 한 문제 연습 — 최근 연습·응시 전 연습·답변 흐름(단계마다 가장 약한 틀) ──
  const drillIds = new Set(drills.map((d) => d.id));
  const drillAttempts = attempts.filter((a) => drillIds.has(a.mockId));
  const drillSummaries = drills.filter(isRenderableToeicMock).map((d) => summarizeToeicDrill(d, drillAttempts));
  const pendingDrills = pendingToeicDrills(drillSummaries);
  // 🧩 이 유형 답변 흐름(§12-13-3) — 모범답변이 고르는 목록과 같은 흐름(순서 "flow") → 단계마다 첫 틀 + "+n", 소재 틀
  const tplByKey = new Map(templates.map((t) => [t.key, t] as const));
  const foldFrame = (f: { key: string }) => {
    const t = tplByKey.get(f.key);
    return t ? [{ key: t.key, frameEn: t.frameEn, frameKo: t.frameKo }] : [];
  };
  const prepFold = drillPrepFlowFold(bankDoc ? buildAnswerFlow(bankDoc, unit.mockPart, templates, { order: "flow" }) : null);

  const partLabelKo = toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]);
  const data: ToeicGuideFolderData = {
    part,
    partLabelKo,
    guide: guideDoc
      ? {
          sections: guideDoc.sections,
          expressions: guideSet!.entries.map((e) => ({ no: e.no, expression: e.expression, meaningKo: e.meaningKo, example: e.example, exampleKo: e.exampleKo })),
        }
      : null,
    guideBroken: guideSet !== null && guideSet.guide !== null && !guideOk,
    // testFills는 비워서 — 틀 바꿔 말하기의 정답 채움이 ② 카드·페이지 소스에 먼저 나오지 않게(§12-5-1, S1 QA P3-6). ②·①·③ 탭은 쓰지 않는다.
    templates: templates.map((t) => ({ ...t, testFills: [] })),
    flows: (bankDoc?.flows ?? []).filter((f) => f.part === part),
    brokenTemplates: bankOk ? brokenTemplates : 0,
    bankBroken: bank !== null && !bankOk,
    bankReady: bankOk,
    alternates: partAlternates,
    alternatesEmpty: bankOk && bankAlternates.length === 0,
    readFrameKeys,
    badges,
    wrongKeys,
    masteredKeys,
    choiceWrongCounts,
    recentTests: recentTemplateTests(bankSessions, partKeys),
    wrongCounts: templateWrongCountsByMode(bankSessions, partKeys),
    choice: { wrong: choiceWrong, recent: recentTemplateChoiceTests(bankSessions, partKeys) },
    drill: {
      mockPart: unit.mockPart,
      recent: drillSummaries.slice(0, TOEIC_DRILL_RECENT_MAX),
      pendingCount: pendingDrills.length,
      latestPending: pendingDrills[0] ?? null,
      flowFold: prepFold
        ? {
            steps: prepFold.steps.map((st) => ({ stepKo: st.stepKo, frames: st.all.flatMap(foldFrame) })).filter((st) => st.frames.length > 0),
            banks: prepFold.banks.flatMap(foldFrame),
          }
        : null,
    },
    frame: frameTab,
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

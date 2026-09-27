/**
 * lib/toeic-drill-view.ts — 유형별 공략 **④ 한 문제 연습** 화면이 판단하는 자리를 모은 순수 함수 (docs/harness/toeic.md §12-7·§12-8)
 *
 * 연습 탭(최근 연습 상태·응시 전 연습·목표 등급 기억·비용 캡션·🧩 이 유형 답변 흐름), 응시·결과 화면의 "뒤로"(연습이면 유형 폴더),
 * 결과 화면의 "🧩 틀 점검"(쓴 틀·빠진 단계·쓸 수 있었던 틀 — AI 없음)이 판단하는 것을 여기 한 곳에 둔다. 화면·서버 페이지는 판단하지
 * 않고 소비만 한다(§6-3 관용구). 규칙 자체(단위표·틀 고르기·전사문 속 틀·단계 커버리지·되짚기)는 lib/toeic-drill·lib/toeic-template이
 * 단일 정의처다 — 여기서는 조합만 한다(다시 정의하지 않는다).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/toeic-drill·lib/toeic-guide-view·lib/toeic-template·lib/toeic-mock뿐, lib/ai·lib/store·
 * lib/toeic-quiz는 `import type`만. localStorage·window를 읽지 않는다(문자열을 받아 값을 돌려준다 — 저장은 화면 몫). 정규식 lookbehind 금지.
 */

import { toeicDrillUnitForMockPart } from "./toeic-drill";
import { guidePartShortKo, toeicGuideFolderHref, type ToeicSetBackLink } from "./toeic-guide-view";
import {
  TOEIC_TEMPLATE_FLOW_CHECK_PARTS,
  findTemplatesInTranscript,
  missingTemplateSteps,
  pickTemplatesForDrill,
  templateByExpression,
  templateStepCoverage,
  templatesCouldHaveUsed,
  type ToeicTemplateSuggestion,
} from "./toeic-template";
import { TOEIC_DEFAULT_TARGET_GRADE, TOEIC_TARGET_GRADES, toeicMaxScore, type ToeicMockPart, type ToeicTargetGrade } from "./toeic-mock";
import type { ToeicGuidePart } from "./toeic-guide";
import type { ToeicQuizSessionLike } from "./toeic-quiz";
import type { ToeicTemplate, ToeicTemplateFlow } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 주소·"뒤로" (§12-3 표 "뒤로"·이동 링크 · §12-7-5)
// ---------------------------------------------------------------------------

/** 연습 문서의 유형 폴더 ④ 탭 — `/toeic/guides/{유형}?tab=drill`(연습이 아닌 파트면 폴더 목록) */
export function toeicDrillFolderHref(drillPart: ToeicMockPart): string {
  const unit = toeicDrillUnitForMockPart(drillPart);
  return unit ? toeicGuideFolderHref(unit.part, { tab: "drill" }) : "/toeic/guides";
}

/**
 * 응시·결과 화면의 "뒤로"(서버 페이지가 내려준다) — 연습이면 그 유형 폴더 ④ 탭("← Q3–4 공략" · "🧭 Q3–4 공략으로"), 모의고사면
 * 학습 보기("← 학습 보기" · "학습 보기로" — 기존 문구 그대로). 공략 세트 시험의 toeicSetBackLink와 같은 모양·같은 문구 계열이다.
 */
export function toeicMockBackLink(mock: { id: string; drillPart: ToeicMockPart | null }): ToeicSetBackLink {
  if (mock.drillPart !== null) {
    const unit = toeicDrillUnitForMockPart(mock.drillPart);
    if (unit) {
      const short = guidePartShortKo(unit.part);
      return { href: toeicGuideFolderHref(unit.part, { tab: "drill" }), labelKo: `← ${short} 공략`, buttonKo: `🧭 ${short} 공략으로` };
    }
    return { href: "/toeic/guides", labelKo: "← 유형별 공략", buttonKo: "🧭 유형별 공략으로" };
  }
  return { href: `/toeic/mocks/${encodeURIComponent(mock.id)}`, labelKo: "← 학습 보기", buttonKo: "학습 보기로" };
}

// ---------------------------------------------------------------------------
// 최근 연습 목록·응시 전 연습 (§12-7-2 비용 캡션·응시 전 안내 · §12-8 최근 연습)
// ---------------------------------------------------------------------------

/** 사진 묘사 연습의 사진 칸 상태(다른 유형은 null) */
export type ToeicDrillPictureState = "pending" | "ready" | "failed";

/** 최근 연습 한 줄(서버 페이지가 연습 문서 + 그 응시들로 줄여 넘긴다 — 파트 본문 없음) */
export interface ToeicDrillSummary {
  id: string;
  titleKo: string;
  createdAt: string;
  targetGrade: ToeicTargetGrade;
  /** 사진 묘사면 사진 칸(slot 0) 상태, 다른 유형은 null */
  picture: ToeicDrillPictureState | null;
  attemptCount: number;
  /** 가장 늦게 시작한 응시(없으면 null) — 녹음·채점 수와 점수 합·만점(응시 범위 문항의 만점 합) */
  latest: { id: string; recorded: number; scored: number; scoreSum: number; scoreMax: number } | null;
}

interface DrillMockLike {
  id: string;
  titleKo: string;
  createdAt: string;
  targetGrade: ToeicTargetGrade;
  parts: { picture: { items: readonly { image: { status: string } }[] } | null };
}

interface DrillAttemptLike {
  id: string;
  mockId: string;
  startedAt: string;
  questions: readonly number[];
  answers: readonly { q: number; recorded: boolean; score: number | null }[];
}

function pictureStateOf(mock: DrillMockLike): ToeicDrillPictureState | null {
  const pic = mock.parts.picture;
  if (!pic) return null;
  const status = pic.items[0]?.image?.status;
  return status === "ready" ? "ready" : status === "failed" ? "failed" : "pending";
}

/** 연습 문서 + (그 문서의) 응시들 → 최근 연습 한 줄. 응시는 다른 문서 것이 섞여 와도 mockId로 거른다. */
export function summarizeToeicDrill(mock: DrillMockLike, attempts: readonly DrillAttemptLike[]): ToeicDrillSummary {
  const mine = attempts.filter((a) => a.mockId === mock.id);
  const latestA = [...mine].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
  let latest: ToeicDrillSummary["latest"] = null;
  if (latestA) {
    const inRange = new Set(latestA.questions);
    const answers = latestA.answers.filter((x) => inRange.has(x.q));
    latest = {
      id: latestA.id,
      recorded: answers.filter((x) => x.recorded === true).length,
      scored: answers.filter((x) => x.score !== null).length,
      scoreSum: answers.reduce((n, x) => n + (x.score ?? 0), 0),
      scoreMax: latestA.questions.reduce((n, q) => n + (q >= 1 && q <= 11 ? toeicMaxScore(q) : 0), 0),
    };
  }
  return {
    id: mock.id,
    titleKo: mock.titleKo,
    createdAt: mock.createdAt,
    targetGrade: mock.targetGrade,
    picture: pictureStateOf(mock),
    attemptCount: mine.length,
    latest,
  };
}

/** 녹음된 문항을 모두 채점했는가(점수 합을 보일 수 있는가) */
function isFullyScored(latest: NonNullable<ToeicDrillSummary["latest"]>): boolean {
  return latest.recorded > 0 && latest.scored >= latest.recorded;
}

/**
 * 최근 연습 한 줄의 상태(§12-8) — 응시가 없으면 "사진 준비 중"(사진 묘사의 사진이 아직 pending) / "응시 전", 응시가 있으면 가장 늦은 응시로
 * "녹음 n · 채점 m", 녹음된 문항을 모두 채점했으면 "점수 합 / 만점".
 */
export function toeicDrillStatusKo(s: Pick<ToeicDrillSummary, "picture" | "latest">): string {
  if (s.latest === null) return s.picture === "pending" ? "사진 준비 중" : "응시 전";
  if (isFullyScored(s.latest)) return `점수 ${s.latest.scoreSum} / ${s.latest.scoreMax}`;
  return `녹음 ${s.latest.recorded} · 채점 ${s.latest.scored}`;
}

/** 응시 전 연습(응시 기록이 하나도 없는 연습) — 받은 순서 그대로(최신순이면 첫 줄이 "가장 최근 것") */
export function pendingToeicDrills<T extends Pick<ToeicDrillSummary, "attemptCount">>(summaries: readonly T[]): T[] {
  return summaries.filter((s) => s.attemptCount === 0);
}

/** 폴더 카드(§12-8 "최근 연습 수·마지막 점수") — 연습 수와, 최신순으로 처음 만나는 "다 채점한" 연습의 점수(없으면 null) */
export function toeicDrillFolderCard(summaries: readonly Pick<ToeicDrillSummary, "latest">[]): { count: number; lastScoreKo: string | null } {
  const scored = summaries.find((s) => s.latest !== null && isFullyScored(s.latest));
  return { count: summaries.length, lastScoreKo: scored?.latest ? `${scored.latest.scoreSum}/${scored.latest.scoreMax}` : null };
}

/** 최근 연습 목록의 줄 수(§12-8 "그 유형 연습 최신 10개") */
export const TOEIC_DRILL_RECENT_MAX = 10;

// ---------------------------------------------------------------------------
// 목표 등급 기억(§12-7-2 "마지막 선택은 기기 localStorage에") · 비용 캡션
// ---------------------------------------------------------------------------

/** 목표 등급을 기억하는 기기 키(화면이 try/catch로 읽고 쓴다) */
export const TOEIC_DRILL_GRADE_STORAGE_KEY = "toeic-drill-grade:v1";

/** 기기에 기억한 값 → 목표 등급(없거나 모르는 값이면 기본 IH) */
export function parseDrillGrade(raw: string | null | undefined): ToeicTargetGrade {
  return (TOEIC_TARGET_GRADES as readonly string[]).includes(raw ?? "") ? (raw as ToeicTargetGrade) : TOEIC_DEFAULT_TARGET_GRADE;
}

/**
 * "새 문제 만들기" 옆 비용 캡션(§12-7-2) — 호출 C 1회(사진 묘사는 사진 1장 포함). 폴더를 보거나 공략을 듣는 건 AI 0. 스펙 문장의
 * "(Q3–4는 사진 1장 포함)"을 폴더마다 맞게 줄였다(사진 폴더에만 "사진 1장 포함").
 */
export function toeicDrillCostCaptionKo(part: ToeicGuidePart): string {
  return `AI 문제 만들기 1회${part === "q3_4" ? "(사진 1장 포함)" : ""} — 폴더를 보거나 공략을 듣는 건 AI 0`;
}

// ---------------------------------------------------------------------------
// 단계마다 틀 하나 (§12-7-9 — 연습 탭 "🧩 이 유형 답변 흐름" · 틀 점검 "빠진 단계의 가장 약한 틀")
// ---------------------------------------------------------------------------

/** 결정적 순서(무작위 섞기를 하지 않는 rng — 같은 약함이면 받은 순서 = 파일 순서). 화면 표시가 새로 읽을 때마다 바뀌지 않게. */
const KEEP_ORDER_RNG = () => 0.999999;

/**
 * 흐름의 **단계**마다 가장 약한 틀 하나(두 테스트 모드 합친 약함 — 연습 입력과 **같은 함수** pickTemplatesForDrill을 단계 수만큼 불러
 * 단계 몫만 읽는다). 같은 약함은 파일 순서(결정적). 그 단계에 틀이 없으면 null. 흐름이 없으면 빈 배열.
 */
export function drillStepPicks(
  templates: readonly ToeicTemplate[],
  sessions: readonly ToeicQuizSessionLike[],
  part: ToeicGuidePart,
  flows: readonly ToeicTemplateFlow[],
): { stepKo: string; template: ToeicTemplate | null }[] {
  const flow = flows.find((f) => f.part === part);
  if (!flow || flow.steps.length === 0) return [];
  const chosen = pickTemplatesForDrill(templates, sessions, { part, flows, max: flow.steps.length, rng: KEEP_ORDER_RNG });
  return flow.steps.map((st) => {
    const groups = new Set(st.groupsKo);
    return { stepKo: st.stepKo, template: chosen.find((t) => groups.has(t.groupKo)) ?? null };
  });
}

// ---------------------------------------------------------------------------
// 결과 화면 "🧩 틀 점검"(§12-7-9 — 연습만, AI 없음)
// ---------------------------------------------------------------------------

/** 틀 점검이 쓰는 틀 모양(결과 페이지가 틀 은행에서 줄여 넘긴다 — 예문·테스트 채움은 넘기지 않는다) */
export type ToeicDrillCheckTemplate = Pick<ToeicTemplate, "key" | "frameEn" | "frameKo" | "groupKo" | "parts" | "guideRefs">;

/** 결과 페이지(서버)가 연습일 때만 만들어 넘기는 자료 */
export interface ToeicDrillCheckData {
  part: ToeicGuidePart;
  /** 그 유형의 렌더 가능한 틀(파일 순서) */
  templates: ToeicDrillCheckTemplate[];
  /** 그 유형 흐름(0~1개) */
  flows: ToeicTemplateFlow[];
  /** 단계마다 가장 약한 틀(drillStepPicks — 빠진 단계의 "쓸 수 있었던 틀" ③) */
  stepPicks: { stepKo: string; key: string | null }[];
}

export interface ToeicDrillCheckResult {
  /** 전사문이 있다(채점 뒤) — 없으면 "모범답변이 쓴 틀"만 */
  scored: boolean;
  /** "빠진 단계"를 보이는 유형인가(Q3–4·Q11 — TOEIC_TEMPLATE_FLOW_CHECK_PARTS) */
  flowChecked: boolean;
  /** 내 답에서 쓴 틀(전사문 속 첫 위치 순) — 단계 이름(소재 묶음이면 null)·묶음 이름 */
  used: { key: string; stepKo: string | null; groupKo: string }[];
  /** 쓴 틀이 없는 단계(흐름 순서) */
  missingSteps: string[];
  /** 쓸 수 있었던 틀(최대 5 — 모범답변 → 피드백 → 빠진 단계) */
  suggestions: ToeicTemplateSuggestion[];
}

/** 틀 key → 단계 이름(그 유형 흐름의 단계 묶음에 든 틀만, 소재·기타는 null) */
function stepOfTemplate(data: Pick<ToeicDrillCheckData, "part" | "flows">, groupKo: string): string | null {
  const flow = data.flows.find((f) => f.part === data.part);
  const st = flow?.steps.find((s) => s.groupsKo.includes(groupKo));
  return st ? st.stepKo : null;
}

/**
 * 문항 하나의 틀 점검(§12-7-9) — 전사문(채점 때 이미 만든 것)과 저장된 C·D 출력만 쓴다(AI 0).
 * - 쓴 틀: findTemplatesInTranscript(전사문, 그 유형 틀). 무응답(전사문은 있지만 낱말이 거의 없음)도 전사문으로 본다 — 쓴 틀 0.
 * - 빠진 단계: templateStepCoverage → missingTemplateSteps(Q3–4·Q11만, 소재 묶음은 세지 않는다).
 * - 쓸 수 있었던 틀: templatesCouldHaveUsed(① 모범답변 usedExpressions → ② 피드백 tryExpressions → ③ 빠진 단계의 가장 약한 틀, 내가 쓴 틀 제외).
 * - 채점 전(전사문 null)에는 ①만.
 */
export function drillTemplateCheck(
  data: ToeicDrillCheckData,
  input: { transcript: string | null; sampleUsedExpressions: readonly string[]; tryExpressions: readonly string[] },
): ToeicDrillCheckResult {
  const flowChecked = (TOEIC_TEMPLATE_FLOW_CHECK_PARTS as readonly string[]).includes(data.part);
  const byExpression = templateByExpression(data.templates);
  const groupOf = new Map(data.templates.map((t) => [t.key, t.groupKo] as const));
  if (input.transcript === null) {
    return {
      scored: false,
      flowChecked,
      used: [],
      missingSteps: [],
      suggestions: templatesCouldHaveUsed({
        sampleUsedExpressions: input.sampleUsedExpressions,
        tryExpressions: [],
        missingStepKeys: [],
        mine: new Set(),
        byExpression,
      }),
    };
  }
  const found = findTemplatesInTranscript(input.transcript, data.templates).found;
  const keys = found.map((f) => f.key);
  const coverage = templateStepCoverage(data.part, keys, { flows: data.flows, items: data.templates });
  const missingSteps = missingTemplateSteps(data.part, coverage);
  const pickOf = new Map(data.stepPicks.map((p) => [p.stepKo, p.key] as const));
  const missingStepKeys = missingSteps.map((st) => pickOf.get(st) ?? null).filter((k): k is string => k !== null);
  return {
    scored: true,
    flowChecked,
    used: keys.map((key) => {
      const groupKo = groupOf.get(key) ?? "";
      return { key, stepKo: stepOfTemplate(data, groupKo), groupKo };
    }),
    missingSteps,
    suggestions: templatesCouldHaveUsed({
      sampleUsedExpressions: input.sampleUsedExpressions,
      tryExpressions: input.tryExpressions,
      missingStepKeys,
      mine: new Set(keys),
      byExpression,
    }),
  };
}

/** "쓸 수 있었던 틀"의 출처 이름 */
export const TOEIC_DRILL_SUGGESTION_SOURCE_KO: Record<ToeicTemplateSuggestion["source"], string> = {
  sample: "모범답변이 쓴 틀",
  feedback: "AI가 권한 틀",
  step: "빠진 단계의 틀",
};

/** 결과 페이지(서버) — 틀 은행의 그 유형 틀·흐름·틀 세션 → 틀 점검 자료(예문·테스트 채움은 빼고 줄인다) */
export function toeicDrillCheckData(
  part: ToeicGuidePart,
  templates: readonly ToeicTemplate[],
  flows: readonly ToeicTemplateFlow[],
  sessions: readonly ToeicQuizSessionLike[],
): ToeicDrillCheckData {
  const partFlows = flows.filter((f) => f.part === part);
  return {
    part,
    templates: templates.map((t) => ({ key: t.key, frameEn: t.frameEn, frameKo: t.frameKo, groupKo: t.groupKo, parts: t.parts, guideRefs: t.guideRefs })),
    flows: partFlows,
    stepPicks: drillStepPicks(templates, sessions, part, partFlows).map((p) => ({ stepKo: p.stepKo, key: p.template?.key ?? null })),
  };
}

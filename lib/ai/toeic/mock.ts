/**
 * lib/ai/toeic/mock.ts — 호출 C·D 전후 순수 함수 (docs/harness/toeic.md §4-0·§4-9·§5-2·§5-3)
 *
 * - usedExpressions 정리(§4-9): 입력 목록에 없는 표현·모범답변에 없는 구간은 **버린다**(거부 아님).
 * - 파트 결과 → 레코드 파트 변환(§4-9): C2는 items[i].image = {status:"pending", imageId:null}을 붙인다(관문 P가 채운다).
 * - 피드백 자료(§5-2 buildFeedbackMaterial)·피드백 후처리(§5-3 tryExpressions는 입력 목록에 있는 것만).
 * - 활용할 표현 고르기(§4-0 pickExpressionsForMock): 세트·시험 통계에서 최대 24개, 숙련도 낮은 것 우선, 없으면 무작위.
 *
 * 실호출 없이 eval이 잠그는 순수 함수다. 값을 만드는 곳은 여기뿐이다.
 */

import { collapseSpaces, matchKey } from "../../toeic-text";
import { TOEIC_MOCK_PART_NAME_KO, toeicQuestionFormat, type ToeicMockPart } from "../../toeic-mock";
import { aggregateToeicStatsByMode, TOEIC_QUIZ_MODES, type ToeicQuizSessionLike } from "../../toeic-quiz";
import { isStatMastered } from "../../vocab-mastery";
import type { Rng } from "../../vocab-quiz";
import {
  TOEIC_FEEDBACK_LIMITS,
  TOEIC_MOCK_EXPRESSIONS_MAX,
  type ToeicFeedback,
  type ToeicMockPartGenMap,
  type ToeicMockPartRecordMap,
  type ToeicMockParts,
  type ToeicPicturePart,
  type ToeicPictureGeneration,
  type ToeicUsedExpression,
} from "./schemas";

// ---------------------------------------------------------------------------
// usedExpressions 정리 (§4-9)
// ---------------------------------------------------------------------------

/**
 * `expression`이 입력 목록에 대소문자 무시로 있어야 하고(표기는 목록 쪽으로 맞춘다), `span`이 그 모범답변의 부분 문자열
 * (대소문자·연속 공백 무시)이어야 한다. 어긋난 항목은 버린다. span은 모범답변 속 실제 표기로 맞춘다(하이라이트용).
 * 같은 (expression, span) 쌍은 한 번만.
 */
export function cleanUsedExpressions(
  used: readonly ToeicUsedExpression[],
  expressions: readonly string[],
  sampleAnswer: string,
): ToeicUsedExpression[] {
  const byLower = new Map<string, string>();
  for (const e of expressions) {
    const k = matchKey(e);
    if (k !== "" && !byLower.has(k)) byLower.set(k, collapseSpaces(e));
  }
  const out: ToeicUsedExpression[] = [];
  const seen = new Set<string>();
  for (const u of used) {
    const expression = byLower.get(matchKey(u.expression));
    if (expression === undefined) continue;
    const span = findSpanIn(sampleAnswer, u.span);
    if (span === null) continue;
    const key = `${expression.toLowerCase()} ${span.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ expression, span });
  }
  return out;
}

/** span을 text에서 대소문자·연속 공백 무시로 찾아 text의 실제 표기로 돌려준다. 없으면 null. */
function findSpanIn(text: string, span: string): string | null {
  const words = collapseSpaces(span).split(" ").filter((w) => w !== "");
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(escaped.join("\\s+"), "i").exec(text);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// 파트 결과 → 레코드 파트 (§4-9)
// ---------------------------------------------------------------------------

/** C2 결과에 사진 참조(pending)를 붙인다 — 관문 P가 ready/failed로 바꾼다(§4-10) */
export function attachPendingImages(gen: ToeicPictureGeneration): ToeicPicturePart {
  return { items: gen.items.map((it) => ({ ...it, image: { status: "pending", imageId: null } })) };
}

/**
 * 모델 출력(zod 통과) → ToeicMockRecord.parts.<part>. usedExpressions를 정리하고 C2엔 image pending을 붙인다.
 * @param expressions 이 모의고사를 만들 때 넘긴 활용할 표현(레코드의 expressionsUsed)
 */
export function toMockRecordPart<P extends ToeicMockPart>(
  part: P,
  gen: ToeicMockPartGenMap[P],
  expressions: readonly string[],
): ToeicMockPartRecordMap[P] {
  const clean = (used: readonly ToeicUsedExpression[], answer: string) => cleanUsedExpressions(used, expressions, answer);
  switch (part) {
    case "read":
      return gen as ToeicMockPartRecordMap[P];
    case "picture": {
      const g = gen as ToeicPictureGeneration;
      const cleaned: ToeicPictureGeneration = {
        items: g.items.map((it) => ({ ...it, usedExpressions: clean(it.usedExpressions, it.sampleAnswer) })),
      };
      return attachPendingImages(cleaned) as ToeicMockPartRecordMap[P];
    }
    case "respond": {
      const g = gen as ToeicMockPartGenMap["respond"];
      return { ...g, questions: g.questions.map((q) => ({ ...q, usedExpressions: clean(q.usedExpressions, q.sampleAnswer) })) } as ToeicMockPartRecordMap[P];
    }
    case "info": {
      const g = gen as ToeicMockPartGenMap["info"];
      return { ...g, questions: g.questions.map((q) => ({ ...q, usedExpressions: clean(q.usedExpressions, q.sampleAnswer) })) } as ToeicMockPartRecordMap[P];
    }
    case "opinion": {
      const g = gen as ToeicMockPartGenMap["opinion"];
      return { ...g, usedExpressions: clean(g.usedExpressions, g.sampleAnswer) } as ToeicMockPartRecordMap[P];
    }
    default:
      throw new Error(`[toeic-mock] 알 수 없는 파트: ${String(part)}`);
  }
}

// ---------------------------------------------------------------------------
// 호출 D 입력 (§5-2)
// ---------------------------------------------------------------------------

/**
 * 수험자가 본 자료(§5-2) — Q3–4 = sceneKo + keyPointsKo, Q5–7 = intro + 그 질문, Q8–10 = 표 텍스트(제목·meta·
 * rows "left — right"·notes) + callerIntro + 그 질문, Q11 = 질문. 줄바꿈으로 잇고 목록은 "- "로 적는다.
 * Q1–2(호출 D를 부르지 않는다)이거나 그 파트가 null이면 null.
 */
export function buildFeedbackMaterial(parts: ToeicMockParts, q: number): string | null {
  const f = toeicQuestionFormat(q);
  const lines: string[] = [];
  switch (f.part) {
    case "read":
      return null;
    case "picture": {
      const item = parts.picture?.items[f.slot];
      if (!item) return null;
      lines.push(`사진 설명: ${item.sceneKo}`, "묘사 포인트:", ...item.keyPointsKo.map((k) => `- ${k}`));
      break;
    }
    case "respond": {
      const p = parts.respond;
      const question = p?.questions[f.slot];
      if (!p || !question) return null;
      lines.push(`상황: ${p.intro}`, `질문: ${question.question}`);
      break;
    }
    case "info": {
      const p = parts.info;
      const question = p?.questions[f.slot];
      if (!p || !question) return null;
      lines.push(
        `표: ${p.table.title}`,
        ...p.table.meta,
        ...p.table.rows.map((r) => `${r.left} — ${r.right}`),
        ...p.table.notes,
        `전화 건 사람: ${p.callerIntro}`,
        `질문: ${question.question}`,
      );
      break;
    }
    case "opinion": {
      if (!parts.opinion) return null;
      lines.push(`질문: ${parts.opinion.question}`);
      break;
    }
  }
  return lines.join("\n");
}

/** 그 문항의 모범답변(참고용). 없으면 null */
export function sampleAnswerFor(parts: ToeicMockParts, q: number): string | null {
  const f = toeicQuestionFormat(q);
  switch (f.part) {
    case "read":
      return null;
    case "picture":
      return parts.picture?.items[f.slot]?.sampleAnswer ?? null;
    case "respond":
      return parts.respond?.questions[f.slot]?.sampleAnswer ?? null;
    case "info":
      return parts.info?.questions[f.slot]?.sampleAnswer ?? null;
    case "opinion":
      return parts.opinion?.sampleAnswer ?? null;
  }
}

/** 호출 D 입력 한 벌(lib/ai/toeic/calls.ts generateFeedback이 받는 것) */
export interface ToeicFeedbackInput {
  q: number;
  material: string;
  sampleAnswer: string;
  expressions: string[];
  transcript: string;
}

/**
 * 모의고사 레코드 + 문항 + 전사문 → 호출 D 입력. Q1–2이거나 파트·문항이 없으면 null(호출하지 않는다).
 */
export function buildFeedbackInput(
  mock: { parts: ToeicMockParts; expressionsUsed: readonly string[] },
  q: number,
  transcript: string,
): ToeicFeedbackInput | null {
  const material = buildFeedbackMaterial(mock.parts, q);
  const sampleAnswer = sampleAnswerFor(mock.parts, q);
  if (material === null || sampleAnswer === null) return null;
  return { q, material, sampleAnswer, expressions: [...mock.expressionsUsed], transcript };
}

/** 문항 유형 이름(§5-2 "{유형 이름}") */
export function toeicQuestionPartNameKo(q: number): string {
  return TOEIC_MOCK_PART_NAME_KO[toeicQuestionFormat(q).part];
}

/**
 * 호출 D 후처리(§5-3) — tryExpressions는 입력 목록에 있는 것만(대소문자 무시, 표기는 목록 쪽), 중복 제거, 최대 3개.
 */
export function postprocessFeedback(fb: ToeicFeedback, expressions: readonly string[]): ToeicFeedback {
  const byLower = new Map<string, string>();
  for (const e of expressions) {
    const k = matchKey(e);
    if (k !== "" && !byLower.has(k)) byLower.set(k, collapseSpaces(e));
  }
  const tries: string[] = [];
  for (const t of fb.tryExpressions) {
    const hit = byLower.get(matchKey(t));
    if (hit !== undefined && !tries.includes(hit)) tries.push(hit);
  }
  return { ...fb, tryExpressions: tries.slice(0, TOEIC_FEEDBACK_LIMITS.tryExpressionsMax) };
}

// ---------------------------------------------------------------------------
// 활용할 표현 고르기 (§4-0)
// ---------------------------------------------------------------------------

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 표현집에서 모의고사에 넘길 활용할 표현을 고른다(§4-0 — 최대 24개, 숙련도가 낮은 것 우선, 없으면 무작위).
 *
 * 숙련도는 모드별 통계(aggregateToeicStatsByMode)를 **합치지 않고** 본다 — 어느 모드에서든 "틀렸고 아직 졸업 전"이면 약함,
 * 시도한 모드마다 졸업했으면 강함, 그 밖(안 해 봤거나 틀린 적 없이 진행 중)은 보통. 약함(오답 합계 많은 순) → 보통 → 강함,
 * 같은 순위 안은 무작위(rng). 표현은 대소문자 무시로 중복을 접고 세트·항목 순서의 첫 표기를 쓴다.
 *
 * @param sets     표현집 세트들(entries[].expression만 본다)
 * @param sessions 표현 시험 세션들(startedAt 오름차순, 모든 세트·모드) — 없으면 빈 배열 → 전부 무작위
 */
export function pickExpressionsForMock(
  sets: readonly { entries: readonly { expression: string }[] }[],
  sessions: readonly ToeicQuizSessionLike[],
  opts: { max?: number; rng?: Rng } = {},
): string[] {
  const max = opts.max ?? TOEIC_MOCK_EXPRESSIONS_MAX;
  const rng = opts.rng ?? Math.random;
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const s of sets) {
    for (const e of s.entries) {
      const v = collapseSpaces(e.expression);
      const k = v.toLowerCase();
      if (v === "" || seen.has(k)) continue;
      seen.add(k);
      pool.push(v);
    }
  }
  if (pool.length === 0 || max <= 0) return [];

  const byMode = aggregateToeicStatsByMode(sessions);
  const statsFor = (expr: string) =>
    TOEIC_QUIZ_MODES.map((m) => byMode[m][expr]).filter((st): st is NonNullable<typeof st> => st !== undefined && st.total > 0);

  const scored = shuffle(pool, rng).map((expr, order) => {
    const stats = statsFor(expr);
    const weak = stats.some((st) => st.wrong > 0 && !isStatMastered(st));
    const strong = stats.length > 0 && stats.every((st) => isStatMastered(st));
    const rank = weak ? 0 : strong ? 2 : 1;
    const wrong = stats.reduce((n, st) => n + st.wrong, 0);
    return { expr, order, rank, wrong };
  });
  scored.sort((a, b) => a.rank - b.rank || b.wrong - a.wrong || a.order - b.order);
  return scored.slice(0, max).map((s) => s.expr);
}

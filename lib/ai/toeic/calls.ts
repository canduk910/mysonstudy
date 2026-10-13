/**
 * lib/ai/toeic/calls.ts — 토익 호출 A·B·C·D(+ 소재별 틀 말하기 E·F — §20, 답변 섬 해석 G — §21-7) 진입 함수 (**서버 전용**) (docs/harness/toeic.md §2~§5)
 *
 * 공유 래퍼 `callWithSchema`(lib/ai/client.ts)를 **그대로** 부른다 — client.ts에 과목 분기·진입 함수를 넣지 않는다(docs/HARNESS.md §2).
 * 프롬프트·스키마·옵션은 prompts.ts·schemas.ts에서 가져온다. 모델(2026-10-02 사용자 결정): 출제·채점(C·D)은 resolveToeicModel()
 * (env OPENAI_TOEIC_MODEL, 빈 값이면 gpt-6.1-sol — model.ts), 판독·발화 포인트(A·B)와 섬 문장 해석(G)은 메인 resolveModel()(env OPENAI_MODEL).
 *
 * - 사진·묶음·파트·문항마다 **호출 하나**다(요청 하나가 60초를 넘지 않게, §1-1). 병렬·부분 성공은 라우트가 Promise.allSettled로 한다.
 * - 키 검사(501)는 라우트가 이 함수들보다 **먼저** 한다. 키가 없으면 getOpenAIClient가 throw한다.
 * - 재요청까지 실패하면 throw — 라우트가 상태코드로 바꾼다.
 * - 답변 흐름(§12-13-3 — 2026-10-02): C는 흐름을 받으면 시스템 프롬프트 끝에 흐름 규칙을 붙이고(buildMockSystemPrompt(part, hasFlow)),
 *   C·D 후처리 허용 목록을 **여기서** 합친다 — `[...answerFlowExpressions(흐름), ...활용할 표현]`, 흐름 틀을 **앞에**(두 후처리는 같은 키면
 *   먼저 나온 표기를 쓴다 → 저장 표기가 흐름 쪽). 합친 목록을 normalizeMockExpressions에 다시 넣지 않는다(24에서 잘려 흐름 틀이 버려진다).
 *
 * ⚠️ 클라이언트 컴포넌트에서 import 금지(openai·API 키). 화면이 타입이 필요하면 lib/toeic-*-contract.ts가 `export type`으로 재수출한다.
 */

import { callWithSchema, imagePart, resolveModel, textPart } from "../client";
import { resolveToeicModel } from "./model";
import {
  TOEIC_EXTRACT_CALL_OPTIONS,
  TOEIC_EXTRACT_SYSTEM_PROMPT,
  TOEIC_EXTRACT_USER_TEXT,
  TOEIC_FEEDBACK_CALL_OPTIONS,
  TOEIC_FEEDBACK_SYSTEM_PROMPT,
  TOEIC_MOCK_CALL_OPTIONS,
  TOEIC_POINTS_CALL_OPTIONS,
  TOEIC_POINTS_SYSTEM_PROMPT,
  buildFeedbackUserMessage,
  buildMockSystemPrompt,
  buildMockUserMessage,
  buildPointsUserMessage,
  normalizeMockExpressions,
  toeicMockCallLabel,
  type ToeicMockUserMessageInput,
} from "./prompts";
import {
  TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA,
  TOEIC_EXPR_EXTRACTION_JSON_SCHEMA,
  TOEIC_MOCK_JSON_SCHEMAS,
  TOEIC_MOCK_ZOD,
  TOEIC_SPEAKING_POINTS_JSON_SCHEMA,
  buildFeedbackZod,
  buildPointsZod,
  toeicExprExtractionSchema,
  type ToeicExprExtraction,
  type ToeicFeedback,
  type ToeicMockPart,
  type ToeicMockPartGenMap,
  type ToeicMockPartRecordMap,
  type ToeicPointsInput,
  type ToeicPointsItem,
} from "./schemas";
import { postprocessFeedback, toMockRecordPart, type ToeicFeedbackInput } from "./mock";
import { toeicMaxScore } from "../../toeic-mock";
import { answerFlowExpressions } from "../../toeic-template";
import {
  TOEIC_FRAME_JUDGE_CALL_OPTIONS,
  TOEIC_FRAME_JUDGE_SYSTEM_PROMPT,
  TOEIC_FRAME_SUPPLY_CALL_OPTIONS,
  TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT,
  buildFrameJudgeUserMessage,
  buildFrameSupplyUserMessage,
  type ToeicFrameJudgeInput,
} from "./frame-drill-prompts";
import {
  TOEIC_FRAME_JUDGE_JSON_SCHEMA,
  TOEIC_FRAME_SUPPLY_JSON_SCHEMA,
  buildFrameJudgeZod,
  buildFrameSupplyZod,
  type ToeicFrameJudgeOutput,
  type ToeicFrameSupplyOutput,
} from "./frame-drill-schemas";
import type { ToeicFrameDrillSupplyPlan } from "../../toeic-frame-drill";
import {
  TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS,
  TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES,
  TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT,
  TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS,
  buildIslandTranslateUserMessage,
  type ToeicIslandTranslateInput,
} from "./island-prompts";
import { TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA, buildIslandTranslateZod } from "./island-schemas";
import { TOEIC_ISLAND_EN_MAX, TOEIC_ISLAND_TR_BATCH_MAX, cleanIslandText } from "../../toeic-island";

/**
 * 호출 A — 표현집 한 페이지 판독(vision). 사진 1장 = 호출 1회. 이미지 파트를 텍스트보다 먼저 넣는다(§2-2).
 * 반환은 zod를 통과한 판독 원문이다. 공백 정리·DAY 묶기·병합은 라우트가 extract-merge.ts의 mergeToeicExtractions로 한다.
 */
export async function extractToeicPage(dataUrl: string): Promise<ToeicExprExtraction> {
  return callWithSchema({
    call: TOEIC_EXTRACT_CALL_OPTIONS.call,
    system: TOEIC_EXTRACT_SYSTEM_PROMPT,
    user: [imagePart(dataUrl), textPart(TOEIC_EXTRACT_USER_TEXT)],
    jsonSchema: TOEIC_EXPR_EXTRACTION_JSON_SCHEMA,
    zodSchema: toeicExprExtractionSchema,
    temperature: TOEIC_EXTRACT_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_EXTRACT_CALL_OPTIONS.maxOutputTokens,
    model: resolveModel(),
  });
}

/**
 * 호출 B — 발화 포인트 한 묶음(최대 7개, points.ts의 planPointsChunks가 나눈다).
 * zod는 이 묶음의 입력을 알고 만든다(index 집합·exampleSpan ⊂ example). 반환 items를 applyPointsResults로 세트에 합친다.
 */
export async function generatePointsChunk(topicKo: string | null, chunk: readonly ToeicPointsInput[]): Promise<ToeicPointsItem[]> {
  if (chunk.length === 0) return [];
  const { items } = await callWithSchema({
    call: TOEIC_POINTS_CALL_OPTIONS.call,
    system: TOEIC_POINTS_SYSTEM_PROMPT,
    user: [textPart(buildPointsUserMessage(topicKo, chunk))],
    jsonSchema: TOEIC_SPEAKING_POINTS_JSON_SCHEMA,
    zodSchema: buildPointsZod(chunk),
    temperature: TOEIC_POINTS_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_POINTS_CALL_OPTIONS.maxOutputTokens,
    model: resolveModel(),
  });
  return items;
}

/**
 * 호출 C — 모의고사 파트 하나(C1~C5). 파트마다 호출 하나(라우트가 5개를 병렬로).
 * 반환은 **레코드에 바로 넣을 파트**다 — usedExpressions 정리(입력 목록·모범답변 대조)와 C2 image pending이 붙어 있다.
 * `input.expressions`는 normalizeMockExpressions를 거친 목록을 레코드 expressionsUsed에 그대로 저장하라(보낸 목록 = 저장 목록).
 * `input.answerFlow`(필수 칸 — 없으면 null)는 레코드 answerFlows에 저장된 흐름과 같은 것이어야 한다(다시 만들기·채점이 같은 흐름).
 * read(C1)는 흐름을 받지 않는다 — 넘겨도 null로 본다(§4-0 "read는 흐름이 늘 null").
 */
export async function generateMockPart<P extends ToeicMockPart>(
  part: P,
  input: ToeicMockUserMessageInput,
): Promise<ToeicMockPartRecordMap[P]> {
  const answerFlow = part === "read" ? null : input.answerFlow;
  const raw = await callWithSchema<ToeicMockPartGenMap[P]>({
    call: toeicMockCallLabel(part),
    system: buildMockSystemPrompt(part, answerFlow !== null),
    user: [textPart(buildMockUserMessage({ ...input, answerFlow }))],
    jsonSchema: TOEIC_MOCK_JSON_SCHEMAS[part],
    zodSchema: TOEIC_MOCK_ZOD[part],
    temperature: TOEIC_MOCK_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_MOCK_CALL_OPTIONS.maxOutputTokens,
    model: resolveToeicModel(),
  });
  // 허용 목록 = 흐름 틀(앞) + 정규화한 활용할 표현 — 합친 목록을 다시 normalizeMockExpressions에 넣지 않는다(검토 S4)
  return toMockRecordPart(part, raw, [...answerFlowExpressions(answerFlow), ...normalizeMockExpressions(input.expressions)]);
}

/**
 * 호출 D — 문항 하나의 답변 피드백(Q3–11). 입력은 mock.ts의 buildFeedbackInput이 만든다.
 * zod는 만점·전사문을 알고 만든다(score 범위, fixes.said ⊂ 전사문). 반환은 tryExpressions 후처리까지 끝난 값이다.
 * Q1–2는 호출하지 않는다(lib/toeic-score.ts의 alignReadAloud) — 부르면 throw.
 */
export async function generateFeedback(input: ToeicFeedbackInput): Promise<ToeicFeedback> {
  if (input.q < 3) throw new Error("[ai:toeic_feedback] Q1–2는 호출 D를 쓰지 않습니다(지문 대조 순수 함수).");
  const raw = await callWithSchema({
    call: TOEIC_FEEDBACK_CALL_OPTIONS.call,
    system: TOEIC_FEEDBACK_SYSTEM_PROMPT,
    user: [textPart(buildFeedbackUserMessage(input))],
    jsonSchema: TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA,
    zodSchema: buildFeedbackZod({ maxScore: toeicMaxScore(input.q), transcript: input.transcript }),
    temperature: TOEIC_FEEDBACK_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_FEEDBACK_CALL_OPTIONS.maxOutputTokens,
    model: resolveToeicModel(),
  });
  // 허용 목록 = 흐름 틀(앞) + 활용할 표현 — 흐름은 input.expressions에 섞지 않는다(D `활용할 표현:` 줄에 찍히지 않게, 검토 S4)
  return postprocessFeedback(raw, [...answerFlowExpressions(input.answerFlow), ...input.expressions]);
}

// ===========================================================================
// 소재별 틀 말하기 (§20 — 2026-10-03) — 호출 E(판정·총평)·F(보충 출제). 모델은 토익 출제·채점(resolveToeicModel)
// ===========================================================================

/**
 * 호출 E — 한 판의 판정·총평(§20-5). 입력은 말한 문항(spoken)만 — `frameDrillJudgeTargets`(lib/toeic-frame-drill.ts)가 고른다.
 * 무응답·전사 실패는 보내지 않는다(무응답은 AI 없이 wrong — mergeFrameDrillVerdicts). 입력이 비면 throw(호출측이 no_ai로 먼저 가른다).
 * zod는 보낸 문항 번호·틀 key를 알고 만든다(buildFrameJudgeZod). 반환은 zod를 통과한 원본 — 합치기는 mergeFrameDrillVerdicts.
 */
export async function judgeFrameDrill(input: ToeicFrameJudgeInput): Promise<ToeicFrameJudgeOutput> {
  if (input.items.length === 0) throw new Error("[ai:toeic_frame_judge] 보낼 문항이 없습니다(모두 무응답이면 호출하지 않는다).");
  return callWithSchema({
    call: TOEIC_FRAME_JUDGE_CALL_OPTIONS.call,
    system: TOEIC_FRAME_JUDGE_SYSTEM_PROMPT,
    user: [textPart(buildFrameJudgeUserMessage(input))],
    jsonSchema: TOEIC_FRAME_JUDGE_JSON_SCHEMA,
    zodSchema: buildFrameJudgeZod(input),
    temperature: TOEIC_FRAME_JUDGE_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_FRAME_JUDGE_CALL_OPTIONS.maxOutputTokens,
    model: resolveToeicModel(),
  });
}

/**
 * 호출 F — 보충 출제(§20-6). 계획은 planFrameDrillSupply(lib/toeic-frame-drill.ts)가 만든다(개수 0이면 throw — 호출측이 먼저 가른다).
 * zod는 계획을 알고 만든다(buildFrameSupplyZod — 틀·개수·자리 수·채움 규칙). 반환은 zod를 통과한 출력이고, 영어 문장은 아직 없다 —
 * acceptFrameDrillSupply가 fillFrame으로 만들고 은행과 겹치는 것을 버린 뒤 새 문항(source "ai")으로 만든다.
 */
export async function supplyFrameDrillItems(plan: ToeicFrameDrillSupplyPlan): Promise<ToeicFrameSupplyOutput> {
  if (plan.count <= 0 || plan.frames.length === 0) throw new Error("[ai:toeic_frame_supply] 만들 문항이 없습니다.");
  return callWithSchema({
    call: TOEIC_FRAME_SUPPLY_CALL_OPTIONS.call,
    system: TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT,
    user: [textPart(buildFrameSupplyUserMessage(plan))],
    jsonSchema: TOEIC_FRAME_SUPPLY_JSON_SCHEMA,
    zodSchema: buildFrameSupplyZod(plan),
    temperature: TOEIC_FRAME_SUPPLY_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_FRAME_SUPPLY_CALL_OPTIONS.maxOutputTokens,
    model: resolveToeicModel(),
  });
}

// ===========================================================================
// 나만의 답변 섬 (§21-7 — 2026-10-13) — 호출 G(섬 문장 해석). 모델은 메인(resolveModel) — 출제·채점이 아니다
// ===========================================================================

/**
 * 호출 G의 끊는 신호 — 서버 시간 상한(TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS)과 호출측 신호(라우트의 req.signal 등)를 하나로 합친다.
 * 둘 중 먼저 온 쪽이 호출 전체(zod 재요청 포함)를 끊는다. `ms`는 eval이 짧은 값으로 보려고 받는다(운영은 기본값).
 */
export function islandTranslateAbortSignal(external?: AbortSignal | null, ms: number = TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

/**
 * 호출 G — 섬 문장 한 묶음의 한국어 해석(§21-7). 입력은 영어 문장 1~TOEIC_ISLAND_TR_BATCH_MAX개(묶음은 lib/toeic-island.ts
 * planIslandTranslateBatches가 나눈다 — 묶음 하나 = 호출 하나 = 요청 하나). 반환은 **입력과 같은 길이·같은 순서**의 해석 배열이다
 * (index는 이 함수가 0부터 붙이고 zod가 집합·개수를 잠근 뒤 순서대로 되돌린다 — 호출측은 자리로 짝짓는다).
 * 저장은 호출측이 applyIslandTranslation(원자 단위 안)으로 한다 — 그사이 섬 문장이 바뀌었거나 이미 채워졌으면 쓰지 않는다.
 *
 * - 모델: 메인 `resolveModel()`(env OPENAI_MODEL) — `resolveToeicModel()`(출제·채점)이 아니다.
 * - 시간 상한: 45초(재요청 포함 전체). `options.signal`이 끊겨도 멈춘다 — 둘 다 SDK가 던진다(래퍼는 삼키지 않는다).
 * - SDK 자동 재시도: 기본 0(시간 상한이 있는 호출 — retry-after 대기가 신호를 보지 않는다). 화면이 기다리지 않는 경로는
 *   `options.maxRetries`로 늘릴 수 있다.
 * - 빈 입력·상한 초과·빈 문장·섬 문장 상한 초과는 **호출 전에** throw(과금 0). 키 검사(501)는 라우트가 먼저 한다.
 * - 재요청까지 실패하면 throw — 호출측이 best-effort로 삼킨다(해석이 없으면 복습 단서는 옛 순서로 떨어진다).
 */
export async function translateIslandSentences(
  sentences: readonly string[],
  options: { signal?: AbortSignal | null; maxRetries?: number } = {},
): Promise<string[]> {
  if (sentences.length === 0 || sentences.length > TOEIC_ISLAND_TR_BATCH_MAX) {
    throw new Error(`[ai:toeic_island_translate] 문장은 1~${TOEIC_ISLAND_TR_BATCH_MAX}개여야 합니다(지금 ${sentences.length}개).`);
  }
  const input: ToeicIslandTranslateInput = {
    items: sentences.map((raw, index) => {
      const en = cleanIslandText(raw);
      if (en === null || en.length > TOEIC_ISLAND_EN_MAX) throw new Error(`[ai:toeic_island_translate] ${index}번 문장이 비었거나 너무 깁니다.`);
      return { index, en };
    }),
  };
  const { items } = await callWithSchema({
    call: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.call,
    system: TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT,
    user: [textPart(buildIslandTranslateUserMessage(input))],
    jsonSchema: TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA,
    zodSchema: buildIslandTranslateZod(input),
    temperature: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.maxOutputTokens,
    model: resolveModel(),
    signal: islandTranslateAbortSignal(options.signal),
    maxRetries: options.maxRetries ?? TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES,
  });
  const byIndex = new Map(items.map((it) => [it.index, it.ko] as const));
  return input.items.map((it) => (cleanIslandText(byIndex.get(it.index)) as string));
}

/**
 * lib/ai/toeic/calls.ts — 토익 호출 A·B·C·D 진입 함수 (**서버 전용**) (docs/harness/toeic.md §2~§5)
 *
 * 공유 래퍼 `callWithSchema`(lib/ai/client.ts)를 **그대로** 부른다 — client.ts에 과목 분기·진입 함수를 넣지 않는다(docs/HARNESS.md §2).
 * 프롬프트·스키마·옵션은 prompts.ts·schemas.ts에서 가져오고, 모델은 resolveModel()로만 고른다(env OPENAI_MODEL).
 *
 * - 사진·묶음·파트·문항마다 **호출 하나**다(요청 하나가 60초를 넘지 않게, §1-1). 병렬·부분 성공은 라우트가 Promise.allSettled로 한다.
 * - 키 검사(501)는 라우트가 이 함수들보다 **먼저** 한다. 키가 없으면 getOpenAIClient가 throw한다.
 * - 재요청까지 실패하면 throw — 라우트가 상태코드로 바꾼다.
 *
 * ⚠️ 클라이언트 컴포넌트에서 import 금지(openai·API 키). 화면이 타입이 필요하면 lib/toeic-*-contract.ts가 `export type`으로 재수출한다.
 */

import { callWithSchema, imagePart, resolveModel, textPart } from "../client";
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
 */
export async function generateMockPart<P extends ToeicMockPart>(
  part: P,
  input: ToeicMockUserMessageInput,
): Promise<ToeicMockPartRecordMap[P]> {
  const raw = await callWithSchema<ToeicMockPartGenMap[P]>({
    call: toeicMockCallLabel(part),
    system: buildMockSystemPrompt(part),
    user: [textPart(buildMockUserMessage(input))],
    jsonSchema: TOEIC_MOCK_JSON_SCHEMAS[part],
    zodSchema: TOEIC_MOCK_ZOD[part],
    temperature: TOEIC_MOCK_CALL_OPTIONS.temperature,
    maxOutputTokens: TOEIC_MOCK_CALL_OPTIONS.maxOutputTokens,
    model: resolveModel(),
  });
  return toMockRecordPart(part, raw, normalizeMockExpressions(input.expressions));
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
    model: resolveModel(),
  });
  return postprocessFeedback(raw, input.expressions);
}

/**
 * lib/ai/client.ts — OpenAI 클라이언트 + callWithSchema() 공통 래퍼 (docs/HARNESS.md §4)
 *
 * 서버 전용 모듈이다. 클라이언트 컴포넌트/클라이언트 번들에서 import 금지 (API 키 노출 방지).
 * 호출 흐름: Responses API(Structured Outputs) → JSON.parse → zod → 실패 시 1회 재요청 → 재실패 throw.
 * 성공/실패 무관하게 { call, model, inputTokens, outputTokens, ms }를 서버 로그로 남긴다.
 */

import OpenAI from "openai";
import type { z } from "zod";
import {
  BOOK_EXTRACTION_JSON_SCHEMA,
  LEARNING_CARD_JSON_SCHEMA,
  bookExtractionSchema,
  makeLearningCardSchema,
  type BookExtraction,
  type LearningCard,
  type StrictJsonSchema,
} from "./schemas";
import {
  CARD_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_USER_TEXT,
  buildCardUserMessage,
  type CardUserMessageInput,
} from "./prompts";

/**
 * OPENAI_MODEL 미설정 시 기본 모델.
 * gpt-5.5: OpenAI 공식 문서 기준 비전(이미지 입력)과 Structured Outputs를 모두 지원하는
 * 현행 최신 모델 (developers.openai.com/api/docs/models/gpt-5.5, 2026-08 확인).
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

function resolveModel(): string {
  return process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}

let cachedClient: OpenAI | null = null;

/** OpenAI 클라이언트 (지연 생성 — 빌드 시점에 키를 요구하지 않기 위해) */
export function getOpenAIClient(): OpenAI {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY가 설정되지 않았습니다 (서버 전용 env).");
    }
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

/** 호출별 파라미터 (HARNESS §1 표) */
export const EXTRACT_CALL_OPTIONS = { temperature: 0, maxOutputTokens: 1_000 } as const;
export const CARD_CALL_OPTIONS = { temperature: 0.7, maxOutputTokens: 6_000 } as const;

/** 사용자 메시지 파트: 텍스트 또는 이미지 */
export type UserContentPart =
  | OpenAI.Responses.ResponseInputText
  | OpenAI.Responses.ResponseInputImage;

export function textPart(text: string): UserContentPart {
  return { type: "input_text", text };
}

/** base64 data URL 이미지 파트. 스티커의 작은 글씨(AR·Lexile)를 읽어야 하므로 detail: "high". */
export function imagePart(dataUrl: string): UserContentPart {
  return { type: "input_image", image_url: dataUrl, detail: "high" };
}

export interface CallWithSchemaArgs<T> {
  call: "extract" | "card";
  system: string;
  user: UserContentPart[];
  jsonSchema: StrictJsonSchema;
  zodSchema: z.ZodType<T>;
  temperature: number;
  maxOutputTokens: number;
}

type ValidationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; errorSummary: string; raw: string };

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function validateResponse<T>(
  res: OpenAI.Responses.Response,
  zodSchema: z.ZodType<T>,
): ValidationOutcome<T> {
  const raw = res.output_text ?? "";
  if (res.status === "incomplete") {
    // 출력 한도 도달 등 — JSON 파싱 실패와 동일하게 재요청 경로로 보낸다
    return {
      ok: false,
      raw,
      errorSummary: `출력이 완성되지 않았습니다 (status: incomplete, reason: ${res.incomplete_details?.reason ?? "unknown"}). 전체 JSON을 한도 안에서 다시 출력해`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, raw, errorSummary: "출력이 유효한 JSON이 아닙니다" };
  }
  const result = zodSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, raw, errorSummary: summarizeZodError(result.error) };
  }
  return { ok: true, data: result.data };
}

/**
 * 공통 래퍼 (HARNESS §4):
 * 1. Responses API 호출 (text.format: json_schema, strict)
 * 2. JSON 파싱 → zodSchema.safeParse()
 * 3. 실패 시: 원래 메시지 + 검증 오류를 첨부해 1회만 재요청
 * 4. 재요청도 실패하면 throw (라우트에서 재시도 버튼 노출)
 * 5. 성공/실패 무관 로깅: { call, model, inputTokens, outputTokens, ms }
 */
export async function callWithSchema<T>(args: CallWithSchemaArgs<T>): Promise<T> {
  const { call, system, user, jsonSchema, zodSchema, temperature, maxOutputTokens } = args;
  const model = resolveModel();
  const startedAt = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  const requestOnce = async (
    input: OpenAI.Responses.ResponseInput,
  ): Promise<OpenAI.Responses.Response> => {
    const res = await getOpenAIClient().responses.create({
      model,
      input,
      text: {
        format: {
          type: "json_schema",
          name: jsonSchema.name,
          strict: jsonSchema.strict,
          schema: jsonSchema.schema,
        },
      },
      temperature,
      max_output_tokens: maxOutputTokens,
    });
    // 재요청이 발생하면 두 호출의 토큰을 합산해 기록한다
    inputTokens += res.usage?.input_tokens ?? 0;
    outputTokens += res.usage?.output_tokens ?? 0;
    return res;
  };

  const baseInput: OpenAI.Responses.ResponseInput = [
    { role: "system", content: [{ type: "input_text", text: system }] },
    { role: "user", content: user },
  ];

  try {
    const firstRes = await requestOnce(baseInput);
    const first = validateResponse(firstRes, zodSchema);
    if (first.ok) return first.data;

    // 1회 재요청: 이전 출력 원문(assistant 턴) + 오류 요약(user 턴)을 덧붙인다
    const retryInput: OpenAI.Responses.ResponseInput = [
      ...baseInput,
      { role: "assistant", content: first.raw },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `다음 검증 오류를 고쳐 다시 출력해: ${first.errorSummary}`,
          },
        ],
      },
    ];
    const secondRes = await requestOnce(retryInput);
    const second = validateResponse(secondRes, zodSchema);
    if (second.ok) return second.data;

    throw new Error(
      `[ai:${call}] 응답 검증에 재요청까지 2회 실패했습니다: ${second.errorSummary}`,
    );
  } finally {
    console.log(
      JSON.stringify({ call, model, inputTokens, outputTokens, ms: Date.now() - startedAt }),
    );
  }
}

// ---------------------------------------------------------------------------
// 호출 A/B 편의 함수 — 프롬프트·스키마·파라미터를 한 곳에서 배선한다.
// (route handler와 scripts/eval-cards.ts가 공유)
// ---------------------------------------------------------------------------

/** 호출 A — 표지 판독. 이미지 1~2장(base64 data URL)을 받는다. */
export async function extractBook(imageDataUrls: string[]): Promise<BookExtraction> {
  return callWithSchema({
    call: "extract",
    system: EXTRACT_SYSTEM_PROMPT,
    user: [...imageDataUrls.map(imagePart), textPart(EXTRACT_USER_TEXT)],
    jsonSchema: BOOK_EXTRACTION_JSON_SCHEMA,
    zodSchema: bookExtractionSchema,
    ...EXTRACT_CALL_OPTIONS,
  });
}

/** 호출 B — 학습 카드 생성. 메타데이터로 §3-2 사용자 메시지를 조립해 호출한다. */
export async function generateCard(input: CardUserMessageInput): Promise<LearningCard> {
  return callWithSchema({
    call: "card",
    system: CARD_SYSTEM_PROMPT,
    user: [textPart(buildCardUserMessage(input))],
    jsonSchema: LEARNING_CARD_JSON_SCHEMA,
    zodSchema: makeLearningCardSchema({
      arLevel: input.arLevel ?? null,
      isFiction: input.isFiction,
    }),
    ...CARD_CALL_OPTIONS,
  });
}

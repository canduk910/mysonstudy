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
  MAX_SCENE_DIGEST_ITEMS,
  PAGE_DIGEST_JSON_SCHEMA,
  bookExtractionSchema,
  makeLearningCardSchema,
  makePageDigestSchema,
  resolveAllowedStorySource,
  type BookExtraction,
  type LearningCard,
  type SceneDigestItem,
  type SceneSourceKind,
  type StrictJsonSchema,
} from "./schemas";
import {
  CARD_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_USER_TEXT,
  PAGES_SYSTEM_PROMPT,
  buildCardUserMessage,
  buildPagesUserMessage,
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
export const EXTRACT_CALL_OPTIONS = { temperature: 0, maxOutputTokens: 2_000 } as const;
export const PAGES_CALL_OPTIONS = { temperature: 0.3, maxOutputTokens: 4_000 } as const;
export const CARD_CALL_OPTIONS = { temperature: 0.7, maxOutputTokens: 6_000 } as const;

/**
 * 호출 A′ 배치 크기 (HARNESS §2A-5). 사진을 이 단위로 나눠 병렬 호출한다:
 * 이미지 토큰이 한 호출에 몰리지 않고, 실패가 배치 안에 갇히고, 전체 지연이 짧아진다.
 */
export const PAGES_BATCH_SIZE = 6;

/** 권당 사진 상한 — 그림책 펼침면 12~16장, 챕터북 목차 몇 장을 여유 있게 덮는다 */
export const PAGES_MAX_IMAGES = 40;

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
  call: "extract" | "pages" | "card";
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
// 추론 계열 모델은 temperature 파라미터 자체를 400으로 거부한다.
// 한 번 거부한 모델은 기억해 두고 이후 호출에서는 처음부터 파라미터를 뺀다.
const modelsRejectingTemperature = new Set<string>();

function isTemperatureUnsupportedError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status !== 400) return false;
  const param = (err as { param?: string | null }).param;
  return param === "temperature" || /'temperature'/.test(err.message);
}

export async function callWithSchema<T>(args: CallWithSchemaArgs<T>): Promise<T> {
  const { call, system, user, jsonSchema, zodSchema, temperature, maxOutputTokens } = args;
  const model = resolveModel();
  const startedAt = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  const requestOnce = async (
    input: OpenAI.Responses.ResponseInput,
  ): Promise<OpenAI.Responses.Response> => {
    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
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
      max_output_tokens: maxOutputTokens,
    };
    if (!modelsRejectingTemperature.has(model)) params.temperature = temperature;

    let res: OpenAI.Responses.Response;
    try {
      res = await getOpenAIClient().responses.create(params);
    } catch (err) {
      // 스펙(HARNESS §1)의 temperature 다이얼은 이 계열 모델에는 적용 자체가 불가하므로,
      // 파라미터를 빼는 것이 스펙 의도를 유지하는 최소 변형이다.
      if (params.temperature === undefined || !isTemperatureUnsupportedError(err)) throw err;
      modelsRejectingTemperature.add(model);
      delete params.temperature;
      res = await getOpenAIClient().responses.create(params);
    }
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
      // 실제로 넘긴 근거만 storySource로 주장할 수 있다 (schemas.ts §storySource)
      allowedStorySource: resolveAllowedStorySource(input),
    }),
    ...CARD_CALL_OPTIONS,
  });
}

// ---------------------------------------------------------------------------
// 호출 A′ — 본문·목차 판독 (HARNESS §2A)
// 사진 N장을 PAGES_BATCH_SIZE 단위로 나눠 병렬 호출하고, 결과를 촬영 순서대로 병합한다.
// ---------------------------------------------------------------------------

/**
 * `digestPages`가 던지는 오류의 종류. 라우트가 상태코드를 고르려면 이 구분이 필요하다.
 * - `invalid_input` → 400. 사용자가 고칠 수 있다 (사진 0장, 상한 초과). 재시도해도 그대로 실패한다
 * - `ai_failed`     → 500. 재시도할 가치가 있다 (전 배치 실패)
 */
export type PagesErrorCode = "invalid_input" | "ai_failed";

/**
 * 판별 가능한 A′ 오류. `instanceof`는 모듈이 중복 로드되면 어긋날 수 있으므로
 * `code` 필드를 함께 두고, 라우트는 `isPagesError()`로 좁힌다.
 */
export class PagesError extends Error {
  readonly code: PagesErrorCode;
  constructor(code: PagesErrorCode, message: string) {
    super(message);
    this.name = "PagesError";
    this.code = code;
  }
}

/** 라우트용 타입 가드 — 이 함수로 좁힌 뒤 `err.code`로 상태코드를 고른다 */
export function isPagesError(err: unknown): err is PagesError {
  return (
    err instanceof PagesError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "PagesError" &&
      ((err as { code?: unknown }).code === "invalid_input" ||
        (err as { code?: unknown }).code === "ai_failed"))
  );
}

export interface DigestPagesArgs {
  /** 촬영 순서대로 정렬된 base64 data URL 목록 */
  images: string[];
  /** 목차 판독인지 본문 장면인지 */
  sourceKind: SceneSourceKind;
  /** 맥락 힌트 (선택) — 없으면 프롬프트가 "미상"으로 폴백한다 */
  book?: {
    title?: string | null;
    author?: string | null;
    isFiction?: boolean | null;
    topic?: string | null;
  };
  /** 이어 찍기: 이미 만든 장면 뒤에 붙일 때의 첫 장면 번호 (기본 1) */
  startSeq?: number;
}

/** 배치 단위 성패 — 한 배치가 실패해도 나머지 장면은 살린다 */
export interface PageDigestBatchOutcome {
  batchIndex: number; // 0부터
  imageCount: number;
  fromImageIndex: number; // 1부터 (사진 순번)
  toImageIndex: number;
  ok: boolean;
  errorMessage: string | null;
}

export interface DigestPagesResult {
  sourceKind: SceneSourceKind;
  /** 성공한 배치의 장면을 촬영 순서대로 병합하고 seq를 다시 매긴 결과 */
  scenes: SceneDigestItem[];
  batches: PageDigestBatchOutcome[];
  /** 실패한 배치 수 — 0보다 크면 사용자에게 부분 실패를 알린다 */
  failedBatchCount: number;
  /**
   * 상한(MAX_SCENE_DIGEST_ITEMS) 초과로 잘라낸 뒤쪽 장면 수. 보통 0이다.
   * 라우트가 노출하지 않아도 동작에 문제는 없다 — 알리고 싶을 때만 쓴다.
   */
  truncatedSceneCount: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 호출 A′ — 본문/목차 사진 묶음 → 장면별 요약.
 *
 * - 배치(PAGES_BATCH_SIZE장)로 나눠 병렬 호출한다. 한 배치의 실패는 그 배치의 사진만 잃는다.
 * - 모델이 돌려준 seq는 배치 안에서만 의미가 있으므로, 병합 시 촬영 순서대로 다시 매긴다.
 * - 마지막 배치에는 "책의 마지막 구간"임을 알려 결말 노출을 막는다 (프롬프트 [결말] 규칙).
 * - 전 배치가 실패하면 throw — 라우트는 재시도 버튼을 노출한다.
 */
export async function digestPages(args: DigestPagesArgs): Promise<DigestPagesResult> {
  const { images, sourceKind, book, startSeq = 1 } = args;

  if (images.length === 0) {
    throw new PagesError("invalid_input", "[ai:pages] 사진이 1장 이상 필요합니다.");
  }
  if (images.length > PAGES_MAX_IMAGES) {
    throw new PagesError(
      "invalid_input",
      `[ai:pages] 사진은 한 번에 최대 ${PAGES_MAX_IMAGES}장까지입니다 (받은 장수: ${images.length}).`,
    );
  }

  const batches = chunk(images, PAGES_BATCH_SIZE);

  const settled = await Promise.allSettled(
    batches.map((batchImages, batchIndex) => {
      const fromImageIndex = batchIndex * PAGES_BATCH_SIZE + 1;
      // 배치별 seq 힌트는 사진 순번 기준 — 목차 모드는 챕터 수가 사진 수와 달라
      // 정확히 맞지 않을 수 있어, 최종 번호는 병합 단계에서 다시 매긴다.
      return callWithSchema({
        call: "pages",
        system: PAGES_SYSTEM_PROMPT,
        user: [
          ...batchImages.map(imagePart),
          textPart(
            buildPagesUserMessage({
              sourceKind,
              imageCount: batchImages.length,
              totalImageCount: images.length,
              fromImageIndex,
              startSeq: startSeq + fromImageIndex - 1,
              isFinalBatch: batchIndex === batches.length - 1,
              title: book?.title ?? null,
              author: book?.author ?? null,
              isFiction: book?.isFiction ?? null,
              topic: book?.topic ?? null,
            }),
          ),
        ],
        jsonSchema: PAGE_DIGEST_JSON_SCHEMA,
        zodSchema: makePageDigestSchema({ sourceKind, imageCount: batchImages.length }),
        ...PAGES_CALL_OPTIONS,
      });
    }),
  );

  const outcomes: PageDigestBatchOutcome[] = [];
  const merged: SceneDigestItem[] = [];
  // 직전 배치가 실패했는지 — 실패로 생긴 구멍을 다음 장면에 gapBefore로 표시한다
  let pendingGap = false;

  settled.forEach((result, batchIndex) => {
    const imageCount = batches[batchIndex].length;
    const fromImageIndex = batchIndex * PAGES_BATCH_SIZE + 1;
    const base = {
      batchIndex,
      imageCount,
      fromImageIndex,
      toImageIndex: fromImageIndex + imageCount - 1,
    };

    if (result.status === "fulfilled") {
      outcomes.push({ ...base, ok: true, errorMessage: null });
      const batchScenes = result.value.scenes;
      // 앞 배치가 통째로 빠졌다면 여기서 내용이 끊긴 것이 확실하다. 번호만 이어 붙이면
      // 호출 B가 매끄러운 목록을 보고 빈 구간을 상상으로 메운다 — SPEC §7-1′이 금지한 실패 모드다.
      if (pendingGap && batchScenes.length > 0) {
        batchScenes[0] = { ...batchScenes[0], gapBefore: true };
      }
      merged.push(...batchScenes);
      pendingGap = false;
      return;
    }
    const reason = result.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`[ai:pages] 배치 ${batchIndex} 실패:`, message);
    outcomes.push({ ...base, ok: false, errorMessage: message });
    pendingGap = true;
  });

  const failedBatchCount = outcomes.filter((o) => !o.ok).length;
  if (failedBatchCount === batches.length) {
    throw new PagesError(
      "ai_failed",
      `[ai:pages] 사진 판독에 모두 실패했습니다 (배치 ${batches.length}개).`,
    );
  }

  // 장면 수 상한은 배치별 zod가 이미 막지만, 배치를 넘나드는 '합계' 초과는 거기서 잡히지
  // 않는다 (toc 3배치 × 60장면 = 180). 여기서 잘라낸다 — 소비자(/api/card)가 통째로
  // 400을 내면 사용자가 A′ 값을 치르고도 카드를 못 얻기 때문이다 (QA F12).
  const truncatedSceneCount = Math.max(0, merged.length - MAX_SCENE_DIGEST_ITEMS);
  if (truncatedSceneCount > 0) {
    console.warn(
      `[ai:pages] 장면 ${merged.length}개가 상한 ${MAX_SCENE_DIGEST_ITEMS}개를 넘어 뒤쪽 ${truncatedSceneCount}개를 잘라냅니다.`,
    );
    merged.length = MAX_SCENE_DIGEST_ITEMS;
  }

  // 촬영 순서대로 seq 재부여 — 배치가 빠져도 번호가 끊기지 않게 연속 부여한다.
  // (마지막 배치가 실패한 경우의 '뒤쪽 누락'은 뒤에 붙일 장면이 없어 목록으로 표현할 수
  //  없다 — failedBatchCount로만 알린다. HARNESS §2A-5)
  const scenes = merged.map((scene, i) => ({ ...scene, seq: startSeq + i }));

  return { sourceKind, scenes, batches: outcomes, failedBatchCount, truncatedSceneCount };
}

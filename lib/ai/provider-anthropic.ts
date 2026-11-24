/**
 * lib/ai/provider-anthropic.ts — Claude(Anthropic Messages API) 어댑터의 **순수 변환 함수** (docs/HARNESS.md §5)
 *
 * 런타임 의존 0 — SDK는 `import type`만 한다(지워지는 타입). 네트워크·클라이언트 생성은 `lib/ai/client.ts`가 한다.
 * eval-provider가 함수별 입력·출력을 행으로 잠근다.
 *
 * 1. 스키마 정리(`sanitizeSchemaForClaude`) — Claude 구조화 출력이 받지 않는 키(문자열 길이·숫자 범위·배열 개수 등)를 깊이 재귀로 떼고,
 *    모든 객체에 `additionalProperties: false`를 강제한다. 뗀 제약은 기존 zod가 그대로 검증한다(스펙 JSON Schema 원문은 손대지 않는다 —
 *    보낼 사본만 바꾼다).
 * 2. 파트 변환(`toClaudeUserContent`) — `input_text` → text 블록, `input_image`(data URL) → base64 image 블록. 이미지가 텍스트보다
 *    먼저인 순서는 그대로 둔다(영어 §2A 관용구).
 * 3. 요청 조립(`buildClaudeRequest`) — system·user·output_config(format + effort)·max_tokens. temperature·thinking은 싣지 않는다
 *    (claude-opus-5-5는 temperature를 400으로 거부하고 thinking을 끌 수 없다 — 깊이는 effort). 서버 측 거절 폴백(beta)을 기본 포함.
 * 4. 응답 해석(`interpretClaudeResponse`) — text 블록을 합치고 stop_reason을 정상·미완성(max_tokens 등 → zod 재요청 경로)·거절
 *    (refusal → 재요청 없이 백업 경로)로 가른다.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AiEffort } from "./provider";

type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Claude 요청의 max_tokens 하한(2026-11-25, QA common_provider_1 P2-2).
 * claude-opus-5-5는 thinking을 끌 수 없고(adaptive 고정) thinking 토큰이 max_tokens를 함께 쓴다. 과목 옵션의 maxOutputTokens는
 * OpenAI 기준으로 잡혀 400~1,500인 호출(엄마 총평·단어 뜻·유의어 추천·문장 설명)이 있어, 그대로 보내면 thinking만으로 한도가 차서
 * 잘림 → 같은 한도로 재요청 → 또 잘림 → 백업으로 번져 지연·비용이 3배가 된다. max_tokens는 상한일 뿐 과금은 실제 생성분이라
 * 하한을 올려도 비용은 늘지 않는다. 8,000은 SDK 비스트리밍 계산(약 21,333토큰 초과 시 "Streaming is required")에 한참 못 미친다.
 * OpenAI 경로·과목 옵션 상수(spec-sync 대상)는 건드리지 않는다 — Claude 요청 조립에서만 `max(maxOutputTokens, 하한)`.
 */
export const CLAUDE_MIN_MAX_TOKENS = 8_000;

/**
 * Claude 이미지 한도(base64 문자열 길이 기준 — 디코드 크기보다 커서 보수적). 이미지 1장 5MB, 요청 전체 32MB(이미지 외 텍스트 여유를 둬 30MB).
 * 서버 상한(`MAX_IMAGE_DATA_URL_CHARS` 8,000,000자 ≈ 6MB)이 Claude 1장 한도보다 크고, 사진 여러 장 판독은 요청 한도를 넘을 수 있다.
 * 넘으면 요청 전에 ClaudeInputError(백업 대상) — 400·413 왕복 없이 OpenAI로 넘긴다(QA P3-5).
 */
export const CLAUDE_MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
export const CLAUDE_MAX_TOTAL_IMAGE_BASE64_CHARS = 30 * 1024 * 1024;

/** 서버 측 거절 폴백 beta 헤더 — `fallbacks: "default"`(거절 분류별로 서버가 대체 모델을 고른다)와 짝 */
export const CLAUDE_SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude 구조화 출력이 지원하지 않아 보낼 사본에서 떼는 키. `minItems`는 0·1만 받으므로 그 밖의 값일 때만 뗀다(아래 함수).
 * `pattern`·`default`·`examples` 등 문서가 지원 목록에 올리지 않은 키도 보수적으로 뗀다 — 검증은 zod가 한다.
 */
export const CLAUDE_UNSUPPORTED_SCHEMA_KEYS: readonly string[] = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "pattern",
  "default",
  "examples",
  "not",
];

/** Claude가 받는 string `format` 값 — 밖의 값은 뗀다 */
export const CLAUDE_SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

export interface SanitizedSchema {
  schema: Record<string, unknown>;
  /** 뗀(또는 바꾼) 자리 — `경로:키` 목록. 0이 보통이다(스펙 스키마는 이미 strict 모양). */
  removed: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isObjectNode(node: Record<string, unknown>): boolean {
  const t = node.type;
  return t === "object" || (Array.isArray(t) && t.includes("object")) || isPlainObject(node.properties);
}

function sanitizeNode(node: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(node)) return node.map((v, i) => sanitizeNode(v, `${path}[${i}]`, removed));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (CLAUDE_UNSUPPORTED_SCHEMA_KEYS.includes(key)) {
      removed.push(`${path}:${key}`);
      continue;
    }
    if (key === "minItems" && value !== 0 && value !== 1) {
      removed.push(`${path}:${key}`);
      continue;
    }
    if (key === "format" && (typeof value !== "string" || !CLAUDE_SUPPORTED_STRING_FORMATS.has(value))) {
      removed.push(`${path}:${key}`);
      continue;
    }
    if (key === "oneOf" && Array.isArray(value)) {
      // oneOf는 받지 않는다 — anyOf로 바꾼다(zod가 '정확히 하나'를 다시 본다)
      removed.push(`${path}:oneOf→anyOf`);
      out.anyOf = sanitizeNode(value, `${path}.anyOf`, removed);
      continue;
    }
    if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = isPlainObject(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeNode(v, `${path}.${k}`, removed)]))
        : value;
      continue;
    }
    if (key === "items" || key === "anyOf" || key === "allOf" || key === "prefixItems") {
      out[key] = sanitizeNode(value, `${path}.${key}`, removed);
      continue;
    }
    if (key === "additionalProperties") continue; // 아래에서 객체면 false로 강제
    out[key] = value;
  }
  if (isObjectNode(node)) {
    if (node.additionalProperties !== false) removed.push(`${path}:additionalProperties→false`);
    out.additionalProperties = false;
  } else if ("additionalProperties" in node) {
    removed.push(`${path}:additionalProperties`);
  }
  return out;
}

/**
 * Claude로 보낼 스키마 사본 — 깊이 재귀(properties·items·anyOf·allOf·$defs). 원본은 바꾸지 않는다.
 * 재귀 스키마(`$ref`가 자기 조상을 가리킴)는 Claude가 받지 않는다 — 이 저장소의 스펙 스키마에는 `$ref`가 없고, 있으면 그대로 두어
 * API가 400으로 거부하게 한다(요청 오류는 숨기지 않는다 — 백업으로 넘기지도 않는다).
 */
export function sanitizeSchemaForClaude(schema: Record<string, unknown>): SanitizedSchema {
  const removed: string[] = [];
  const out = sanitizeNode(schema, "$", removed) as Record<string, unknown>;
  return { schema: out, removed };
}

/**
 * 정리된 스키마가 Claude 구조화 출력 제약을 만족하는지 — 순수 점검(위반 목록, 빈 배열이 통과).
 * ① 지원 안 하는 키 0(minItems는 0·1만, format은 지원 목록만, oneOf 없음) ② 모든 객체 노드 additionalProperties === false
 * ③ 재귀 없음(`$ref`가 `#`이거나 `$defs` 참조 그래프에 순환) ④ 각 노드에 type·enum·const·anyOf·allOf·$ref 중 하나(SDK 변환과 같은 요구).
 * 실호출 없이 "스키마 컴파일 400"의 흔한 원인을 미리 잡는다 — 수용 여부 자체는 스모크 게이트(scripts/smoke-anthropic-schemas.ts)가 본다.
 */
export function validateClaudeSchema(schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const defs = (isPlainObject(schema.$defs) ? schema.$defs : isPlainObject(schema.definitions) ? schema.definitions : {}) as Record<string, unknown>;
  const refEdges = new Map<string, Set<string>>();
  const refTarget = (ref: string): string | null => {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    return m ? m[1] : null;
  };
  const visit = (node: unknown, path: string, owner: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`, owner));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (CLAUDE_UNSUPPORTED_SCHEMA_KEYS.includes(key)) issues.push(`${path}: 지원 안 하는 키 ${key}`);
    }
    if ("oneOf" in node) issues.push(`${path}: oneOf`);
    if ("minItems" in node && node.minItems !== 0 && node.minItems !== 1) issues.push(`${path}: minItems ${String(node.minItems)}`);
    if ("format" in node && (typeof node.format !== "string" || !CLAUDE_SUPPORTED_STRING_FORMATS.has(node.format))) issues.push(`${path}: format ${String(node.format)}`);
    if (isObjectNode(node) && node.additionalProperties !== false) issues.push(`${path}: additionalProperties가 false가 아님`);
    if (typeof node.$ref === "string") {
      if (node.$ref === "#") issues.push(`${path}: 루트 자기 참조($ref "#") — 재귀`);
      const t = refTarget(node.$ref);
      if (t !== null) {
        if (!refEdges.has(owner)) refEdges.set(owner, new Set());
        refEdges.get(owner)!.add(t);
        if (!(t in defs)) issues.push(`${path}: 없는 $defs 참조 ${node.$ref}`);
      }
    } else if (!("type" in node) && !("enum" in node) && !("const" in node) && !("anyOf" in node) && !("allOf" in node)) {
      issues.push(`${path}: type·enum·const·anyOf·allOf·$ref 중 아무것도 없음`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isPlainObject(value)) {
        for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`, owner);
      } else if (key === "items" || key === "anyOf" || key === "allOf" || key === "prefixItems") {
        visit(value, `${path}.${key}`, owner);
      }
    }
  };
  const { $defs: _d, definitions: _f, ...root } = schema;
  visit(root, "$", "$root");
  for (const [name, def] of Object.entries(defs)) visit(def, `$defs.${name}`, name);
  // $defs 참조 순환(재귀) — 깊이 우선
  const state = new Map<string, 1 | 2>();
  const dfs = (n: string, trail: string[]): void => {
    state.set(n, 1);
    for (const m of refEdges.get(n) ?? []) {
      if (state.get(m) === 1) issues.push(`재귀 참조: ${[...trail, m].join(" → ")}`);
      else if (!state.get(m)) dfs(m, [...trail, m]);
    }
    state.set(n, 2);
  };
  for (const n of Object.keys(defs)) if (!state.get(n)) dfs(n, [n]);
  return issues;
}

const sanitizedCache = new WeakMap<object, SanitizedSchema>();

/** 같은 스키마 상수를 호출마다 다시 걷지 않게 — 스키마 객체 단위 기억(결과는 같은 순수 함수 결과) */
export function sanitizeSchemaForClaudeCached(schema: Record<string, unknown>): SanitizedSchema {
  const hit = sanitizedCache.get(schema);
  if (hit) return hit;
  const made = sanitizeSchemaForClaude(schema);
  sanitizedCache.set(schema, made);
  return made;
}

/** Claude 어댑터가 받지 못하는 입력 — 다른 공급자(OpenAI)는 받을 수 있으므로 백업 대상이다(`decideFallback`). */
export class ClaudeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeInputError";
  }
}

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** data URL → Claude base64 이미지 소스. media_type은 jpeg·png·gif·webp만(`image/jpg`는 jpeg로). 밖이면 ClaudeInputError. */
export function dataUrlToClaudeImageSource(dataUrl: string): { type: "base64"; media_type: ClaudeImageMediaType; data: string } {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) throw new ClaudeInputError("이미지가 base64 data URL 형식이 아닙니다.");
  const raw = m[1].toLowerCase();
  const media = raw === "image/jpg" ? "image/jpeg" : raw;
  if (media !== "image/jpeg" && media !== "image/png" && media !== "image/gif" && media !== "image/webp") {
    throw new ClaudeInputError(`Claude가 받지 않는 이미지 형식입니다: ${raw}`);
  }
  const data = m[2].replace(/\s+/g, "");
  if (data.length > CLAUDE_MAX_IMAGE_BASE64_CHARS) {
    throw new ClaudeInputError(`이미지가 Claude 한도(장당 ${CLAUDE_MAX_IMAGE_BASE64_CHARS}자)를 넘습니다: ${data.length}자`);
  }
  return { type: "base64", media_type: media, data };
}

/** 공유 래퍼의 사용자 파트(OpenAI Responses 모양) — 구조만 본다(런타임 import 없이) */
export type ProviderNeutralPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url?: string | null; detail?: string | null; file_id?: string | null };

/** 사용자 파트 → Claude content 블록. 순서 보존(이미지가 텍스트보다 먼저인 관용구 그대로). */
export function toClaudeUserContent(parts: readonly ProviderNeutralPart[]): BetaContentBlockParam[] {
  let totalImageChars = 0;
  const blocks = parts.map((part): BetaContentBlockParam => {
    if (part.type === "input_text") return { type: "text", text: part.text };
    if (typeof part.image_url !== "string") throw new ClaudeInputError("이미지 파트에 data URL이 없습니다.");
    const source = dataUrlToClaudeImageSource(part.image_url);
    totalImageChars += source.data.length;
    return { type: "image", source };
  });
  if (totalImageChars > CLAUDE_MAX_TOTAL_IMAGE_BASE64_CHARS) {
    throw new ClaudeInputError(`이미지 합계가 Claude 요청 한도(${CLAUDE_MAX_TOTAL_IMAGE_BASE64_CHARS}자)를 넘습니다: ${totalImageChars}자`);
  }
  return blocks;
}

/** 재요청 user 턴 문구 — OpenAI 경로(`callWithSchema`)와 같은 문장 */
export function retryInstructionText(errorSummary: string): string {
  return `다음 검증 오류를 고쳐 다시 출력해: ${errorSummary}`;
}

/** 빈 assistant 턴은 API가 거부한다 — 이전 출력이 비었을 때 대신 넣는 자리표시 */
export const EMPTY_ASSISTANT_PLACEHOLDER = "(출력 없음)";

export interface ClaudeRequestInput {
  model: string;
  system: string;
  user: readonly ProviderNeutralPart[];
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  effort: AiEffort;
  /** zod 재요청이면 이전 출력 원문과 오류 요약 */
  retry?: { raw: string; errorSummary: string } | null;
}

/**
 * Claude 요청 조립 — 순수 함수. temperature·thinking 없음, max_tokens = max(maxOutputTokens, CLAUDE_MIN_MAX_TOKENS), effort는 output_config에.
 * 재요청은 원래 user 턴 뒤에 assistant(이전 출력) + user(오류 요약)를 덧붙인다(마지막이 user라 프리필이 아니다).
 */
export function buildClaudeRequest(input: ClaudeRequestInput): BetaCreateParams {
  const messages: BetaMessageParam[] = [{ role: "user", content: toClaudeUserContent(input.user) }];
  if (input.retry) {
    messages.push(
      { role: "assistant", content: input.retry.raw.trim() === "" ? EMPTY_ASSISTANT_PLACEHOLDER : input.retry.raw },
      { role: "user", content: [{ type: "text", text: retryInstructionText(input.retry.errorSummary) }] },
    );
  }
  return {
    model: input.model,
    max_tokens: Math.max(input.maxOutputTokens, CLAUDE_MIN_MAX_TOKENS),
    system: input.system,
    messages,
    output_config: {
      effort: input.effort,
      format: { type: "json_schema", schema: sanitizeSchemaForClaudeCached(input.schema).schema },
    },
    betas: [CLAUDE_SERVER_FALLBACK_BETA],
    fallbacks: "default",
  };
}

/** 응답 해석에 필요한 최소 모양(가짜 응답으로 eval이 돌 수 있게) */
export interface ClaudeResponseLike {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
}

export type ClaudeOutcome =
  | { kind: "text"; raw: string }
  | { kind: "incomplete"; raw: string; reason: string }
  | { kind: "refusal"; raw: string; category: string | null };

/**
 * 응답 해석 — text 블록만 이어 붙인다(thinking·fallback 블록 무시).
 * - `refusal` → 거절(스키마와 안 맞을 수 있다 — zod 재요청 없이 백업 경로로).
 * - `max_tokens`·`model_context_window_exceeded`·`pause_turn` → 미완성(OpenAI `status: incomplete`와 같은 zod 재요청 경로).
 * - 그 밖(`end_turn` 등) → 정상 텍스트(JSON 파싱·zod는 래퍼가).
 */
export function interpretClaudeResponse(res: ClaudeResponseLike): ClaudeOutcome {
  const raw = res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  if (res.stop_reason === "refusal") return { kind: "refusal", raw, category: res.stop_details?.category ?? null };
  if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded" || res.stop_reason === "pause_turn") {
    return { kind: "incomplete", raw, reason: res.stop_reason };
  }
  return { kind: "text", raw };
}

/** 미완성 응답의 재요청 오류 요약 — OpenAI 경로의 incomplete 문장과 같은 모양 */
export function incompleteErrorSummary(reason: string): string {
  return `출력이 완성되지 않았습니다 (status: incomplete, reason: ${reason}). 전체 JSON을 한도 안에서 다시 출력해`;
}

/** 토큰 합계 — 입력은 캐시 쓰기·읽기를 더한다(비용 추적 로그의 inputTokens) */
export function claudeUsageTokens(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null | undefined): { inputTokens: number; outputTokens: number } {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

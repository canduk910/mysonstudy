/**
 * scripts/eval-provider.ts — 텍스트 LLM 공급자 층(Anthropic 메인 + OpenAI 백업) 회귀 가드 (docs/HARNESS.md §5). **실호출 0회.**
 *
 * 과목 공유 래퍼(`lib/ai/client.ts` callWithSchema)의 공급자 층은 어느 과목 하네스에도 속하지 않아 별도 진입점으로 둔다.
 *
 * 1) 순수 함수: 스키마 정리(지원 안 하는 키 제거·additionalProperties 강제·중첩·원본 불변 + 저장소의 모든 strict 스키마 무손실) ·
 *    파트 변환(data URL → base64 블록) · 요청 조립(temperature·thinking 없음, effort, max_tokens, 서버 측 거절 폴백) ·
 *    응답 해석(refusal·max_tokens·정상) · 토큰 합계.
 * 2) 공급자 선택: env 조합(빈 값·오타·키 유무·AI_FALLBACK·호출부 고정) → 계획, hasLlmKey.
 * 3) 백업 판정 표: 실제 SDK 오류 클래스 인스턴스(가짜 오류 객체)로 넘김/안 넘김.
 * 4) 흐름(행위): **루프백 스텁**(127.0.0.1)에서 callWithSchema를 실제로 태운다 — 메인 529 → 백업, 400 → 던짐(백업 0), 거절 → 백업,
 *    취소 → 백업 0, 기본 설정은 OpenAI만, 호출부 고정, zod 재요청. 전역 fetch를 감싸 127.0.0.1 밖으로 나가는 요청은 **던진다**
 *    (키가 가짜라도 실제 공급자에 닿지 않게 — 두 겹 방어). 스텁 키는 `sk-stub`.
 * 5) 정적: 순수 모듈의 런타임 import 0, client.ts에 라벨 분기 없음, 호출 J OpenAI 고정, 라우트 키 검사 분류.
 *
 * 실행(안전 접두어 — 키·DB를 명령으로 막는다):
 *   OPENAI_API_KEY= ANTHROPIC_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= APP_PIN= EVAL_OFFLINE_ONLY=1 npm run eval:provider
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import {
  DEFAULT_AI_EFFORT,
  DEFAULT_ANTHROPIC_MODEL,
  hasLlmKey,
  providerHasKey,
  resolveAiFallbackEnabled,
  resolveAiProvider,
  resolveAnthropicModel,
  resolveProviderPlan,
} from "../lib/ai/provider";
import {
  CLAUDE_SERVER_FALLBACK_BETA,
  ClaudeInputError,
  EMPTY_ASSISTANT_PLACEHOLDER,
  buildClaudeRequest,
  claudeUsageTokens,
  dataUrlToClaudeImageSource,
  interpretClaudeResponse,
  sanitizeSchemaForClaude,
  toClaudeUserContent,
} from "../lib/ai/provider-anthropic";
import { AiRefusalError, AiValidationError, decideFallback } from "../lib/ai/provider-errors";

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}
const results: CheckResult[] = [];
const add = (book: string, check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
// 1) 스키마 정리
// ---------------------------------------------------------------------------
function runSchemaChecks(): void {
  const B = "스키마 정리";
  const input = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 20, pattern: "^a" },
      age: { type: "integer", minimum: 0, maximum: 120, multipleOf: 1 },
      mail: { type: "string", format: "email" },
      odd: { type: "string", format: "my-format" },
      tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, uniqueItems: true },
      one: { type: "array", items: { type: "string" }, minItems: 1 },
      nested: {
        type: ["object", "null"],
        properties: { deep: { type: "object", properties: { x: { type: "number", exclusiveMinimum: 0 } }, required: ["x"] } },
        required: ["deep"],
        additionalProperties: true,
      },
      choice: { oneOf: [{ type: "string", maxLength: 3 }, { type: "null" }] },
      kind: { type: ["string", "null"], enum: ["a", "b", null], default: "a" },
    },
    required: ["name", "age", "mail", "odd", "tags", "one", "nested", "choice", "kind"],
    additionalProperties: false,
  };
  const before = JSON.stringify(input);
  const { schema, removed } = sanitizeSchemaForClaude(input);
  const s = schema as any;
  add(B, "원본 스키마는 바뀌지 않는다(보낼 사본만 정리)", JSON.stringify(input) === before);
  add(B, "문자열 길이·pattern 제거", !("minLength" in s.properties.name) && !("maxLength" in s.properties.name) && !("pattern" in s.properties.name) && s.properties.name.type === "string");
  add(B, "숫자 범위·multipleOf 제거(중첩 exclusiveMinimum까지)", !("minimum" in s.properties.age) && !("maximum" in s.properties.age) && !("multipleOf" in s.properties.age) && !("exclusiveMinimum" in s.properties.nested.properties.deep.properties.x));
  add(B, "지원 format(email)은 유지, 모르는 format은 제거", s.properties.mail.format === "email" && !("format" in s.properties.odd));
  add(B, "배열 maxItems·uniqueItems·minItems(2) 제거, minItems 1은 유지", !("maxItems" in s.properties.tags) && !("uniqueItems" in s.properties.tags) && !("minItems" in s.properties.tags) && s.properties.one.minItems === 1);
  add(
    B,
    "모든 객체에 additionalProperties:false — 타입 배열 [object,null]·깊은 중첩·true였던 자리까지",
    s.additionalProperties === false && s.properties.nested.additionalProperties === false && s.properties.nested.properties.deep.additionalProperties === false,
  );
  add(B, "oneOf → anyOf(가지 안 제약도 정리)", Array.isArray(s.properties.choice.anyOf) && !("oneOf" in s.properties.choice) && !("maxLength" in s.properties.choice.anyOf[0]));
  add(B, "enum·required·type 배열은 그대로, default 제거", JSON.stringify(s.properties.kind.enum) === JSON.stringify(["a", "b", null]) && !("default" in s.properties.kind) && JSON.stringify(s.required) === JSON.stringify(input.required) && Array.isArray(s.properties.kind.type));
  add(B, "뗀 자리 목록(removed)이 경로와 함께 남는다", removed.includes("$.name:minLength") && removed.includes("$.nested.deep.x:exclusiveMinimum") && removed.includes("$.choice:oneOf→anyOf"), `${removed.length}곳`);
}

/** 저장소의 모든 strict 스키마 상수(이름·strict·schema 모양)를 모아 정리해도 아무것도 떼지 않는지 — 스펙 스키마가 이미 Claude 호환 */
async function runRepoSchemaChecks(): Promise<void> {
  const B = "스키마 정리";
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && /JSON_SCHEMA/.test(readFileSync(p, "utf-8"))) files.push(p);
    }
  };
  walk(join(ROOT, "lib/ai"));
  const found: { where: string; schema: Record<string, unknown> }[] = [];
  const isStrict = (v: unknown): v is { name: string; strict: true; schema: Record<string, unknown> } =>
    typeof v === "object" && v !== null && (v as any).strict === true && typeof (v as any).name === "string" && typeof (v as any).schema === "object";
  for (const f of files) {
    if (/calls\.ts$|client\.ts$/.test(f)) continue; // 진입 함수 모듈은 스키마를 import만 한다(서버 클라이언트 생성 회피)
    const mod = (await import(f)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(mod)) {
      if (isStrict(v)) found.push({ where: `${relative(ROOT, f)}:${k}`, schema: v.schema });
      else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (isStrict(v2)) found.push({ where: `${relative(ROOT, f)}:${k}.${k2}`, schema: v2.schema });
      }
    }
  }
  const unique = [...new Map(found.map((x) => [x.schema, x])).values()];
  const lossy = unique
    .map((x) => ({ where: x.where, removed: sanitizeSchemaForClaude(x.schema).removed }))
    .filter((x) => x.removed.length > 0);
  add(
    B,
    "저장소의 strict JSON Schema 전부가 Claude용 정리에서 떼는 키 0(스펙 원문이 이미 호환 — 뗀 게 생기면 zod가 그 제약을 맡는지 확인)",
    unique.length >= 30 && lossy.length === 0,
    `${unique.length}개 스키마 · ${lossy.map((x) => `${x.where}(${x.removed.join(",")})`).join(" / ") || "제거 0"}`,
  );
}

// ---------------------------------------------------------------------------
// 1) 파트 변환 · 요청 조립 · 응답 해석
// ---------------------------------------------------------------------------
function runAdapterChecks(): void {
  const B = "어댑터";
  const jpeg = "data:image/jpeg;base64,QUJD";
  const content = toClaudeUserContent([
    { type: "input_image", image_url: jpeg, detail: "high" },
    { type: "input_text", text: "읽어 줘" },
  ]);
  add(
    B,
    "파트 변환: 이미지(data URL) → base64 image 블록, 텍스트 → text 블록, 순서 보존(이미지 먼저)",
    JSON.stringify(content) ===
      JSON.stringify([
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
        { type: "text", text: "읽어 줘" },
      ]),
  );
  add(B, "media_type: image/jpg → image/jpeg, png 유지", dataUrlToClaudeImageSource("data:image/jpg;base64,QQ==").media_type === "image/jpeg" && dataUrlToClaudeImageSource("data:image/png;base64,QQ==").media_type === "image/png");
  const throwsInput = (f: () => unknown) => {
    try {
      f();
      return false;
    } catch (e) {
      return e instanceof ClaudeInputError;
    }
  };
  add(B, "Claude가 받지 않는 형식(heic)·data URL 아님 → ClaudeInputError(백업 대상)", throwsInput(() => dataUrlToClaudeImageSource("data:image/heic;base64,QQ==")) && throwsInput(() => dataUrlToClaudeImageSource("https://x/y.png")) && decideFallback(new ClaudeInputError("x")).fallback);

  const schema = { type: "object", properties: { a: { type: "string", minLength: 1 } }, required: ["a"], additionalProperties: false };
  const req = buildClaudeRequest({ model: "claude-x", system: "SYS", user: [{ type: "input_text", text: "U" }], schema, maxOutputTokens: 1234, effort: "low" }) as any;
  add(B, "요청: temperature·thinking·top_p 없음(claude-opus-5-5는 temperature 400, thinking 끄기 불가)", !("temperature" in req) && !("thinking" in req) && !("top_p" in req));
  add(B, "요청: max_tokens = maxOutputTokens, system 문자열, model 그대로", req.max_tokens === 1234 && req.system === "SYS" && req.model === "claude-x");
  add(B, "요청: output_config = { effort, format: json_schema(정리된 사본) }", req.output_config.effort === "low" && req.output_config.format.type === "json_schema" && !("minLength" in req.output_config.format.schema.properties.a));
  add(B, `요청: 서버 측 거절 폴백 beta(${CLAUDE_SERVER_FALLBACK_BETA}) + fallbacks "default"`, JSON.stringify(req.betas) === JSON.stringify([CLAUDE_SERVER_FALLBACK_BETA]) && req.fallbacks === "default");
  add(B, "요청: 첫 요청은 user 한 턴", req.messages.length === 1 && req.messages[0].role === "user");
  const retry = buildClaudeRequest({ model: "m", system: "S", user: [{ type: "input_text", text: "U" }], schema, maxOutputTokens: 10, effort: "medium", retry: { raw: '{"a":""}', errorSummary: "a: 짧음" } }) as any;
  add(
    B,
    "재요청: user → assistant(이전 출력) → user(OpenAI 경로와 같은 오류 문장) — 마지막이 user라 프리필 아님",
    retry.messages.length === 3 && retry.messages[1].role === "assistant" && retry.messages[1].content === '{"a":""}' && retry.messages[2].role === "user" && retry.messages[2].content[0].text === "다음 검증 오류를 고쳐 다시 출력해: a: 짧음",
  );
  const emptyRetry = buildClaudeRequest({ model: "m", system: "S", user: [{ type: "input_text", text: "U" }], schema, maxOutputTokens: 10, effort: "medium", retry: { raw: "  ", errorSummary: "x" } }) as any;
  add(B, "재요청: 이전 출력이 비면 자리표시로 채운다(빈 assistant 턴은 API가 거부)", emptyRetry.messages[1].content === EMPTY_ASSISTANT_PLACEHOLDER);
  add(B, `기본 effort = ${DEFAULT_AI_EFFORT}`, DEFAULT_AI_EFFORT === "medium");

  const ok = interpretClaudeResponse({ content: [{ type: "thinking", text: "" }, { type: "text", text: '{"a":' }, { type: "text", text: '"x"}' }], stop_reason: "end_turn" });
  add(B, "응답: end_turn → text 블록만 이어 붙인 원문(thinking 무시)", ok.kind === "text" && ok.raw === '{"a":"x"}');
  const ref = interpretClaudeResponse({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } });
  add(B, "응답: refusal → 거절(분류 포함)", ref.kind === "refusal" && ref.category === "cyber");
  const cut = interpretClaudeResponse({ content: [{ type: "text", text: '{"a":"x' }], stop_reason: "max_tokens" });
  add(B, "응답: max_tokens → 미완성(zod 재요청 경로)", cut.kind === "incomplete" && cut.reason === "max_tokens" && cut.raw === '{"a":"x');
  add(B, "토큰: 입력 = input + 캐시 쓰기 + 캐시 읽기, 출력 = output, 없으면 0", JSON.stringify(claudeUsageTokens({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 })) === JSON.stringify({ inputTokens: 13, outputTokens: 3 }) && claudeUsageTokens(null).inputTokens === 0);
}

// ---------------------------------------------------------------------------
// 2) 공급자 선택
// ---------------------------------------------------------------------------
function runSelectionChecks(): void {
  const B = "공급자 선택";
  const O = { OPENAI_API_KEY: "sk-o" };
  const A = { ANTHROPIC_API_KEY: "sk-a" };
  const rows: Array<[string, Record<string, string>, string]> = [
    ["미설정 · OpenAI 키만 → openai, 백업 없음(1단계 기본 — 배포해도 동작 불변)", { ...O }, "openai|-|false"],
    ["AI_PROVIDER 빈 값·공백 → openai", { ...O, ...A, AI_PROVIDER: "  " }, "openai|anthropic|false"],
    ["AI_PROVIDER 오타(claude) → openai(모르는 값으로 공급자가 바뀌지 않게)", { ...O, AI_PROVIDER: "claude" }, "openai|-|false"],
    ["anthropic + 두 키 → anthropic 메인, openai 백업", { ...O, ...A, AI_PROVIDER: " Anthropic " }, "anthropic|openai|false"],
    ["anthropic + AI_FALLBACK=off → 백업 없음", { ...O, ...A, AI_PROVIDER: "anthropic", AI_FALLBACK: "off" }, "anthropic|-|false"],
    ["anthropic + Anthropic 키 없음 + 백업 on → openai를 메인으로 올림(primary_no_key)", { ...O, AI_PROVIDER: "anthropic" }, "openai|-|true"],
    ["anthropic + Anthropic 키 없음 + 백업 off → anthropic 그대로(호출이 키 오류로 던진다)", { ...O, AI_PROVIDER: "anthropic", AI_FALLBACK: "off" }, "anthropic|-|false"],
    ["openai + 두 키 → openai 메인, anthropic 백업", { ...O, ...A }, "openai|anthropic|false"],
    ["키 빈 값(공백)은 없음으로 본다", { OPENAI_API_KEY: " ", ANTHROPIC_API_KEY: "" }, "openai|-|false"],
  ];
  const bad: string[] = [];
  for (const [label, env, want] of rows) {
    const p = resolveProviderPlan(undefined, env);
    const got = `${p.primary}|${p.backup ?? "-"}|${p.primaryNoKey}`;
    if (got !== want) bad.push(`${label}: ${got} ≠ ${want}`);
  }
  add(B, `계획 표 ${rows.length}행(env 조합·빈 값·오타·키 유무·AI_FALLBACK)`, bad.length === 0, bad.join(" / ") || "ok");
  const fixed = resolveProviderPlan("openai", { ...O, ...A, AI_PROVIDER: "anthropic" });
  add(B, "호출부 고정(openai) → AI_PROVIDER=anthropic이어도 openai 하나, 백업 없음", fixed.primary === "openai" && fixed.backup === null);
  add(B, "AI_FALLBACK: off·0·false·no만 끔, 빈 값·on·모르는 값은 켬", [["off", false], ["0", false], ["FALSE", false], ["no", false], ["", true], ["on", true], ["yes", true]].every(([v, want]) => resolveAiFallbackEnabled({ AI_FALLBACK: v as string }) === want));
  add(B, `ANTHROPIC_MODEL 빈 값·공백 → ${DEFAULT_ANTHROPIC_MODEL}, 값은 공백을 걷어 그대로`, resolveAnthropicModel({}) === "claude-opus-5-5" && resolveAnthropicModel({ ANTHROPIC_MODEL: "  " }) === "claude-opus-5-5" && resolveAnthropicModel({ ANTHROPIC_MODEL: " claude-sonnet-5-5 " }) === "claude-sonnet-5-5");
  add(B, "resolveAiProvider 기본 openai", resolveAiProvider({}) === "openai" && resolveAiProvider({ AI_PROVIDER: "anthropic" }) === "anthropic");
  const keyRows: Array<[Record<string, string>, boolean]> = [
    [{}, false],
    [{ ...O }, true],
    [{ ...A }, true], // 메인 openai·키 없음 + 백업 on + Anthropic 키 → anthropic이 메인으로 올라간다
    [{ ...O, ...A, AI_PROVIDER: "anthropic" }, true],
    [{ ...O, AI_PROVIDER: "anthropic" }, true],
    [{ ...O, AI_PROVIDER: "anthropic", AI_FALLBACK: "off" }, false],
    [{ ...A, AI_PROVIDER: "anthropic" }, true],
    [{ ...A, AI_FALLBACK: "off" }, false],
  ];
  const keyBad = keyRows.filter(([env, want]) => hasLlmKey(env) !== want).map(([env]) => JSON.stringify(env));
  add(B, "hasLlmKey: 실제로 부를 공급자의 키가 있을 때만 참(백업 off면 메인 키만)", keyBad.length === 0, keyBad.join(" / ") || "ok");
  add(B, "providerHasKey: 공급자별 env 키", providerHasKey("openai", O) && !providerHasKey("anthropic", O) && providerHasKey("anthropic", A));
}

// ---------------------------------------------------------------------------
// 3) 백업 판정 표 — 실제 SDK 오류 클래스 인스턴스
// ---------------------------------------------------------------------------
function runFallbackDecisionChecks(): void {
  const B = "백업 판정";
  const h = new Headers();
  const rows: Array<[string, unknown, boolean]> = [
    ["Anthropic 529 overloaded", new Anthropic.OverloadedError(529, undefined, "overloaded", h), true],
    ["Anthropic 500", new Anthropic.InternalServerError(500, undefined, "boom", h), true],
    ["Anthropic 503", new Anthropic.ServiceUnavailableError(503, undefined, "x", h), true],
    ["Anthropic 429(재시도 소진 후)", new Anthropic.RateLimitError(429, undefined, "rl", h), true],
    ["Anthropic 408", new Anthropic.RequestTimeoutError(408, undefined, "t", h), true],
    ["Anthropic 연결 오류", new Anthropic.APIConnectionError({ message: "conn" }), true],
    ["Anthropic 타임아웃", new Anthropic.APIConnectionTimeoutError(), true],
    ["Anthropic 400", new Anthropic.BadRequestError(400, undefined, "bad", h), false],
    ["Anthropic 401", new Anthropic.AuthenticationError(401, undefined, "auth", h), false],
    ["Anthropic 403", new Anthropic.PermissionDeniedError(403, undefined, "perm", h), false],
    ["Anthropic 404", new Anthropic.NotFoundError(404, undefined, "nf", h), false],
    ["Anthropic 사용자 취소", new Anthropic.APIUserAbortError(), false],
    ["OpenAI 500", new OpenAI.InternalServerError(500, undefined, "boom", h), true],
    ["OpenAI 429", new OpenAI.RateLimitError(429, undefined, "rl", h), true],
    ["OpenAI 연결 오류", new OpenAI.APIConnectionError({ message: "conn" }), true],
    ["OpenAI 타임아웃", new OpenAI.APIConnectionTimeoutError(), true],
    ["OpenAI 400", new OpenAI.BadRequestError(400, undefined, "bad", h), false],
    ["OpenAI 401", new OpenAI.AuthenticationError(401, undefined, "auth", h), false],
    ["OpenAI 사용자 취소", new OpenAI.APIUserAbortError(), false],
    ["거절(refusal)", new AiRefusalError("anthropic", "cyber", "refused"), true],
    ["재요청까지 검증 실패", new AiValidationError("[ai:x] 응답 검증에 재요청까지 2회 실패했습니다: y"), true],
    ["키 없음 같은 일반 예외", new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다"), false],
    ["메시지에 overloaded가 있어도 일반 Error(문자열 매칭 금지)", new Error("529 overloaded"), false],
  ];
  const bad = rows.filter(([, e, want]) => decideFallback(e).fallback !== want).map(([l]) => l);
  add(B, `오류 종류 ${rows.length}행 — 가용성 실패만 넘기고 요청/설정 오류·취소는 던진다`, bad.length === 0, bad.join(" / ") || "ok");
  const ac = new AbortController();
  ac.abort();
  add(B, "신호가 끊겼으면 529라도 넘기지 않는다(사용자 취소·시간 상한은 백업으로도 지킨다)", !decideFallback(new Anthropic.OverloadedError(529, undefined, "o", h), ac.signal).fallback);
}

// ---------------------------------------------------------------------------
// 4) 흐름 — 루프백 스텁 위에서 callWithSchema를 실제로 태운다
// ---------------------------------------------------------------------------
type StubHit = { path: string; body: any; headers: IncomingMessage["headers"] };
type StubReply = { status: number; body: unknown; headers?: Record<string, string> };

const openaiOk = (text: string): StubReply => ({
  status: 200,
  body: {
    id: "resp_stub",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-stub",
    output: [{ type: "message", id: "msg_stub", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  },
});
const claudeMsg = (text: string, stop: string = "end_turn", extra: Record<string, unknown> = {}): StubReply => ({
  status: 200,
  body: {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-stub-served",
    content: text === "" ? [] : [{ type: "text", text }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  },
});
const claudeErr = (status: number, type: string): StubReply => ({
  status,
  body: { type: "error", error: { type, message: `stub ${status}` } },
  headers: { "retry-after-ms": "1", "x-should-retry": "false" },
});

async function runFlowChecks(): Promise<void> {
  const B = "흐름(스텁)";
  const hits: StubHit[] = [];
  let script: { openai: StubReply[]; anthropic: StubReply[] } = { openai: [], anthropic: [] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      hits.push({ path, body, headers: req.headers });
      const queue = path.startsWith("/anthropic") ? script.anthropic : script.openai;
      const reply = queue.shift() ?? { status: 500, body: { error: { message: "stub: 대본 없음" } } };
      res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  // 루프백 밖으로 나가는 요청은 던진다 — base URL env가 무시되는 일이 있어도 실제 공급자에 닿지 않게(두 번째 방어선)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) throw new Error(`eval-provider: 루프백 밖 요청 차단 — ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const saved = { ...process.env };
  Object.assign(process.env, {
    OPENAI_API_KEY: "sk-stub",
    ANTHROPIC_API_KEY: "sk-stub",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/openai/v1`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
    OPENAI_MODEL: "gpt-4.1-mini", // temperature를 받는 계열 — 요청에 실리는지 본다
    ANTHROPIC_MODEL: "",
    AI_PROVIDER: "",
    AI_FALLBACK: "",
  });
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const logs: any[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => {
    const s = String(a[0]);
    if (s.startsWith('{"call":')) logs.push(JSON.parse(s));
    else realLog(...a);
  };
  console.warn = () => {};

  const { callWithSchema } = await import("../lib/ai/client");
  const jsonSchema = { name: "stub_out", strict: true as const, schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false } };
  const zodSchema = z.object({ a: z.string().min(1) });
  const base = { system: "SYS", user: [{ type: "input_text" as const, text: "U" }], jsonSchema, zodSchema, temperature: 0.2, maxOutputTokens: 300 };
  const run = async (call: string, plan: typeof script, env: Record<string, string>, extra: Record<string, unknown> = {}) => {
    hits.length = 0;
    logs.length = 0;
    script = { openai: [...plan.openai], anthropic: [...plan.anthropic] };
    Object.assign(process.env, { AI_PROVIDER: "", AI_FALLBACK: "", OPENAI_API_KEY: "sk-stub", ANTHROPIC_API_KEY: "sk-stub", ...env });
    try {
      const out = await callWithSchema({ ...base, call, ...extra });
      return { out, err: null as unknown };
    } catch (err) {
      return { out: null, err };
    }
  };
  const count = (prefix: string) => hits.filter((h) => h.path.startsWith(prefix)).length;

  try {
    // (a) 기본 설정(AI_PROVIDER 미설정, Anthropic 키 없음) → OpenAI만, 요청 모양 기존 그대로
    let r = await run("t-default", { openai: [openaiOk('{"a":"x"}')], anthropic: [] }, { ANTHROPIC_API_KEY: "" });
    const oBody = hits[0]?.body ?? {};
    add(
      B,
      "기본(미설정·Anthropic 키 없음) → OpenAI 1회만, 요청에 text.format strict·temperature 그대로·effort/output_config 없음",
      (r.out as any)?.a === "x" && count("/openai") === 1 && count("/anthropic") === 0 && oBody.text?.format?.strict === true && oBody.temperature === 0.2 && !("output_config" in oBody) && !("reasoning" in oBody),
      `hits ${hits.map((h) => h.path).join(",")}`,
    );
    add(B, "로그: { call, model, inputTokens, outputTokens, ms, provider: openai, fallback: null }", logs.length === 1 && logs[0].provider === "openai" && logs[0].fallback === null && logs[0].model === "gpt-4.1-mini" && logs[0].inputTokens === 5, JSON.stringify(logs[0]));

    // (b) anthropic 메인 정상 — Claude 요청 모양
    r = await run("t-claude", { openai: [], anthropic: [claudeMsg('{"a":"y"}')] }, { AI_PROVIDER: "anthropic" }, { effort: "high", model: "gpt-should-not-be-used" });
    const cBody = hits[0]?.body ?? {};
    const beta = String(hits[0]?.headers["anthropic-beta"] ?? "");
    add(
      B,
      "anthropic 메인 → Claude 1회, model=ANTHROPIC_MODEL 기본(args.model은 OpenAI용이라 안 씀), temperature 없음, effort·format·max_tokens",
      (r.out as any)?.a === "y" && count("/anthropic/v1/messages") === 1 && count("/openai") === 0 && cBody.model === "claude-opus-5-5" && !("temperature" in cBody) && !("thinking" in cBody) && cBody.output_config?.effort === "high" && cBody.output_config?.format?.type === "json_schema" && cBody.max_tokens === 300,
      JSON.stringify({ model: cBody.model, oc: cBody.output_config?.effort }),
    );
    add(B, "Claude 요청: anthropic-beta 헤더에 서버 측 거절 폴백, 본문 fallbacks \"default\"", beta.includes(CLAUDE_SERVER_FALLBACK_BETA) && cBody.fallbacks === "default", beta);
    add(B, "로그: provider anthropic · 실제 응답 모델(서버 폴백 반영) · 토큰", logs[0]?.provider === "anthropic" && logs[0]?.model === "claude-stub-served" && logs[0]?.inputTokens === 7 && logs[0]?.fallback === null, JSON.stringify(logs[0]));

    // (c) 529 → SDK 재시도 1회 → 백업 OpenAI
    r = await run("t-529", { openai: [openaiOk('{"a":"z"}')], anthropic: [claudeErr(529, "overloaded_error"), claudeErr(529, "overloaded_error")] }, { AI_PROVIDER: "anthropic" });
    add(B, "Claude 529(재시도 소진) → 백업 OpenAI가 답한다, 로그 fallback {from: anthropic, reason: overloaded}", (r.out as any)?.a === "z" && count("/openai") === 1 && logs[0]?.provider === "openai" && logs[0]?.fallback?.from === "anthropic" && logs[0]?.fallback?.reason === "overloaded", `anthropic ${count("/anthropic")}회 · ${JSON.stringify(logs[0]?.fallback)}`);
    add(B, "Claude SDK 재시도는 1회(클라이언트 maxRetries 1 → 요청 최대 2회)", count("/anthropic") <= 2, `${count("/anthropic")}회`);

    // (d) 400 → 던짐, 백업 0
    r = await run("t-400", { openai: [openaiOk('{"a":"z"}')], anthropic: [claudeErr(400, "invalid_request_error")] }, { AI_PROVIDER: "anthropic" });
    add(B, "Claude 400(요청 오류) → 백업으로 넘기지 않고 던진다", r.err instanceof Anthropic.BadRequestError && count("/openai") === 0 && logs[0]?.fallback === null);

    // (e) 거절 → 재요청 없이 백업
    r = await run("t-refusal", { openai: [openaiOk('{"a":"r"}')], anthropic: [claudeMsg("", "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })] }, { AI_PROVIDER: "anthropic" });
    add(B, "Claude 거절(refusal) → zod 재요청 없이 곧바로 백업 OpenAI(reason: refusal)", (r.out as any)?.a === "r" && count("/anthropic") === 1 && count("/openai") === 1 && logs[0]?.fallback?.reason === "refusal");

    // (f) 검증 실패 2회 → 백업
    r = await run("t-zod", { openai: [openaiOk('{"a":"ok"}')], anthropic: [claudeMsg('{"a":""}'), claudeMsg("not json")] }, { AI_PROVIDER: "anthropic" });
    const retryBody = hits.filter((h) => h.path.startsWith("/anthropic"))[1]?.body ?? {};
    add(
      B,
      "Claude zod 재요청: 두 번째 요청에 assistant(이전 출력) + user(오류 요약) — 재요청까지 실패하면 백업(reason: validation)",
      count("/anthropic") === 2 && retryBody.messages?.length === 3 && retryBody.messages?.[1]?.role === "assistant" && /다음 검증 오류를 고쳐 다시 출력해/.test(JSON.stringify(retryBody.messages?.[2])) && (r.out as any)?.a === "ok" && logs[0]?.fallback?.reason === "validation",
    );

    // (g) max_tokens → 재요청으로 회복(백업 없음)
    r = await run("t-maxtok", { openai: [], anthropic: [claudeMsg('{"a":"x', "max_tokens"), claudeMsg('{"a":"done"}')] }, { AI_PROVIDER: "anthropic" });
    add(B, "Claude max_tokens 잘림 → 같은 공급자 zod 재요청으로 회복(토큰 합산)", (r.out as any)?.a === "done" && count("/anthropic") === 2 && count("/openai") === 0 && logs[0]?.outputTokens === 6);

    // (h) 사용자 취소 → 백업 0
    const ac = new AbortController();
    ac.abort();
    r = await run("t-abort", { openai: [openaiOk('{"a":"z"}')], anthropic: [claudeMsg('{"a":"y"}')] }, { AI_PROVIDER: "anthropic" }, { signal: ac.signal });
    add(B, "끊긴 신호(사용자 취소) → 던지고 백업 0", r.err !== null && count("/openai") === 0);

    // (i) AI_FALLBACK=off → 529면 그대로 던짐
    r = await run("t-off", { openai: [openaiOk('{"a":"z"}')], anthropic: [claudeErr(529, "overloaded_error"), claudeErr(529, "overloaded_error")] }, { AI_PROVIDER: "anthropic", AI_FALLBACK: "off" });
    add(B, "AI_FALLBACK=off → Claude 529를 그대로 던진다(백업 0)", r.err instanceof Anthropic.APIError && count("/openai") === 0);

    // (j) 호출부 고정 openai → AI_PROVIDER=anthropic이어도 OpenAI만, 실패해도 백업 0
    r = await run("t-fixed", { openai: [{ status: 500, body: { error: { message: "x" } }, headers: { "x-should-retry": "false" } }], anthropic: [claudeMsg('{"a":"y"}')] }, { AI_PROVIDER: "anthropic" }, { provider: "openai", maxRetries: 0 });
    add(B, "호출부 고정(provider: openai, 호출 J 모양) → OpenAI만, 500이어도 Claude로 넘기지 않음", r.err instanceof OpenAI.InternalServerError && count("/anthropic") === 0 && count("/openai") === 1);

    // (k) OpenAI 메인 + Anthropic 백업(키 둘) → OpenAI 5xx면 Claude가 답한다
    r = await run("t-openai-down", { openai: [{ status: 503, body: { error: { message: "x" } }, headers: { "x-should-retry": "false" } }], anthropic: [claudeMsg('{"a":"c"}')] }, {});
    add(B, "OpenAI 메인 503 → 백업 Claude(키가 있을 때만 — 1단계 프로덕션엔 키가 없어 이 길이 안 열린다)", (r.out as any)?.a === "c" && logs[0]?.fallback?.from === "openai" && logs[0]?.provider === "anthropic");

    // (l) primary_no_key
    r = await run("t-nokey", { openai: [openaiOk('{"a":"n"}')], anthropic: [] }, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" });
    add(B, "anthropic 설정인데 키 없음 → OpenAI로 곧바로(로그 reason: primary_no_key)", (r.out as any)?.a === "n" && count("/anthropic") === 0 && logs[0]?.fallback?.reason === "primary_no_key");
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// 5) 정적
// ---------------------------------------------------------------------------
function runStaticChecks(): void {
  const B = "정적";
  for (const f of ["lib/ai/provider.ts", "lib/ai/provider-anthropic.ts"]) {
    const src = read(f);
    const runtimeImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]).filter((p) => p !== "./provider");
    add(B, `${f}: 런타임 import 0(클라이언트 안전 — SDK는 import type만)`, runtimeImports.length === 0 && !/^import\s+(?!type\b)[^;]*from\s+"\.\/provider"/m.test(src.replace(/import type[^;]*;/g, "")), runtimeImports.join(", ") || "ok");
  }
  const client = stripComments(read("lib/ai/client.ts"));
  add(B, "client.ts: 라벨(call)로 공급자·분기를 고르지 않는다(call === 없음)", !/\bcall\s*===|===\s*call\b|args\.call\s*[=!]==/.test(client));
  add(B, "client.ts: Anthropic 클라이언트 지연 생성 + timeout·maxRetries 지정, OpenAI 클라이언트에도 timeout·maxRetries", /new Anthropic\(\{[^}]*timeout: LLM_CLIENT_TIMEOUT_MS[^}]*maxRetries: LLM_CLIENT_MAX_RETRIES/.test(client) && /new OpenAI\(\{ apiKey, timeout: LLM_CLIENT_TIMEOUT_MS, maxRetries: LLM_CLIENT_MAX_RETRIES \}\)/.test(client));
  const talk = client.slice(client.indexOf("export async function generateTalkCards("));
  add(B, "호출 J(generateTalkCards): provider: \"openai\" 고정(6초 상한 — Claude로 넘기지 않음)", /provider: "openai"/.test(talk.slice(0, talk.indexOf("sanitizeTalkScreenCards("))));
  add(B, "client.ts: 백업 판정은 decideFallback(typed 오류 클래스) 하나 — 신호를 함께 넘긴다", /decideFallback\(err, args\.signal\)/.test(client));
}

/**
 * 라우트 키 검사 분류 — LLM(callWithSchema)만 부르는 라우트는 hasLlmKey(), OpenAI 전용 기능(TTS·전사·실시간 음성·사진)은 OPENAI_API_KEY.
 * 목록은 손으로 둔다: 라우트가 무엇을 부르는지는 소스만 보고 자동 판정하기 어렵다(진입 함수 이름이 과목마다 다르다). 새 AI 라우트를 만들면 여기에 한 줄.
 */
export const LLM_KEY_ROUTES: readonly string[] = [
  "app/api/extract/route.ts",
  "app/api/pages/route.ts",
  "app/api/card/route.ts",
  "app/api/chapterize/route.ts",
  "app/api/word-meaning/route.ts",
  "app/api/english/vocab/extract/route.ts",
  "app/api/english/vocab/[id]/enrich/route.ts",
  "app/api/english/vocab/[id]/add-word/route.ts",
  "app/api/english/vocab/[id]/add-related/route.ts",
  "app/api/english/vocab/[id]/suggest-related/route.ts",
  "app/api/english/talk/[id]/explain/route.ts",
  "app/api/math/extract/route.ts",
  "app/api/math/explain/route.ts",
  "app/api/japanese/vocab/generate/route.ts",
  "app/api/japanese/dialog/extract/route.ts",
  "app/api/japanese/dialog/coach/route.ts",
  "app/api/japanese/kanji/enrich/route.ts",
  "app/api/japanese/speaking/mocks/route.ts",
  "app/api/japanese/speaking/mocks/[id]/regenerate/route.ts",
  "app/api/toeic/sets/extract/route.ts",
  "app/api/toeic/sets/[id]/points/route.ts",
  "app/api/toeic/mocks/route.ts",
  "app/api/toeic/mocks/[id]/regenerate/route.ts",
  "app/api/toeic/guides/[part]/drills/route.ts",
  "app/api/toeic/frame-drill/sessions/[id]/judge/route.ts",
  "app/api/toeic/frame-drill/sessions/[id]/supply/route.ts",
  "app/api/phrase-helper/route.ts",
  "app/api/mom/tests/[id]/summary/route.ts",
];
/** OpenAI 전용 기능 라우트 — OPENAI_API_KEY를 그대로 본다(Anthropic 대체 없음) */
export const OPENAI_ONLY_KEY_ROUTES: readonly string[] = [
  "app/api/tts/route.ts",
  "app/api/toeic/mocks/[id]/image/route.ts",
  "app/api/japanese/speaking/mocks/[id]/image/route.ts",
];

function runRouteKeyChecks(): void {
  const B = "라우트 키 검사";
  const llmBad = LLM_KEY_ROUTES.filter((f) => {
    const src = stripComments(read(f));
    return !/hasLlmKey\(\)/.test(src) || /process\.env\.OPENAI_API_KEY/.test(src);
  });
  add(B, `LLM 전용 라우트 ${LLM_KEY_ROUTES.length}개: hasLlmKey()로 검사(OPENAI_API_KEY 직접 검사 없음)`, llmBad.length === 0, llmBad.join(", ") || "ok");
  const oaBad = OPENAI_ONLY_KEY_ROUTES.filter((f) => {
    const src = stripComments(read(f));
    return !/process\.env\.OPENAI_API_KEY/.test(src) || /hasLlmKey\(\)/.test(src);
  });
  add(B, `OpenAI 전용 기능 라우트 ${OPENAI_ONLY_KEY_ROUTES.length}개(TTS·사진): OPENAI_API_KEY 그대로`, oaBad.length === 0, oaBad.join(", ") || "ok");
  // 둘 다 부르는 라우트 — 채점(전사 = OpenAI 전용 관문 → 호출 D/F = LLM): AI 앞 hasLlmKey(), 전사 관문은 자기 OPENAI_API_KEY 검사의
  // no_api_key를 501로 내린다(각자). 라우트가 OPENAI_API_KEY를 직접 보지 않아도 전사 키가 없으면 네트워크 전에 501이다.
  const both = ["app/api/toeic/attempts/[id]/score/route.ts", "app/api/japanese/speaking/attempts/[id]/score/route.ts"];
  const bothBad = both.filter((f) => {
    const src = stripComments(read(f));
    return !/hasLlmKey\(\)/.test(src) || !/r\.error === "no_api_key"/.test(src) || /process\.env\.OPENAI_API_KEY/.test(src);
  });
  add(B, "채점 라우트 2개(전사 + 피드백): AI 앞 hasLlmKey(), 전사 관문의 no_api_key → 501(각자)", bothBad.length === 0, bothBad.join(", ") || "ok");
  add(B, "토익 섬 해석(호출 G, 후처리 서버 모듈): 키 판정 hasLlmKey()", /return hasLlmKey\(\);/.test(stripComments(read("lib/toeic-island-translate-server.ts"))) && !/process\.env\.OPENAI_API_KEY/.test(stripComments(read("lib/toeic-island-translate-server.ts"))));
  // 호출 J는 OpenAI 고정이라 OpenAI 키(hasTalkApiKey)를 그대로 본다
  add(B, "자유대화 화면 카드 라우트: OpenAI 고정이라 hasTalkApiKey() 그대로(hasLlmKey 아님)", /hasTalkApiKey\(\)/.test(read("app/api/english/talk/cards/route.ts")) && !/hasLlmKey/.test(read("app/api/english/talk/cards/route.ts")));
  // 전수 — app/api 아래 OPENAI_API_KEY를 검사하는 라우트는 위 두 목록(+ 채점 2개) 밖에 없어야 한다(새 라우트가 분류 없이 생기지 않게)
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "route.ts") routes.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "app/api"));
  const known = new Set([...LLM_KEY_ROUTES, ...OPENAI_ONLY_KEY_ROUTES, ...both]);
  const stray = routes.filter((f) => !known.has(f) && /process\.env\.OPENAI_API_KEY|hasLlmKey\(\)/.test(stripComments(readFileSync(join(ROOT, f), "latin1"))));
  add(B, "app/api 전수: 키를 검사하는 라우트는 전부 분류돼 있다(목록 밖 0)", stray.length === 0, stray.join(", ") || `${routes.length}개 라우트 확인`);
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  runSchemaChecks();
  await runRepoSchemaChecks();
  runAdapterChecks();
  runSelectionChecks();
  runFallbackDecisionChecks();
  await runFlowChecks();
  runStaticChecks();
  runRouteKeyChecks();

  console.log("");
  console.log(`| 결과 | 영역 | 점검 항목 | 상세 |`);
  console.log(`|------|------|-----------|------|`);
  for (const r of results) console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.book} | ${r.check} | ${r.detail} |`);
  console.log("");
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`FAIL — ${failed.length}/${results.length}개 항목 실패 (실호출 0회 · 루프백 스텁만).`);
    process.exit(1);
  }
  console.log(`PASS — 공급자 층 ${results.length}개 항목 통과 (실호출 0회 · 루프백 스텁만).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

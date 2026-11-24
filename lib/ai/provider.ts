/**
 * lib/ai/provider.ts — 텍스트·이미지 판독 LLM 호출(callWithSchema)의 **공급자 선택** 순수 함수 (docs/HARNESS.md §5)
 *
 * 과목 공유·런타임 의존 0(import 없음 — env 객체만 읽는다). 라우트의 키 검사(`hasLlmKey`)와 공유 래퍼(`lib/ai/client.ts`)가
 * 같은 판단을 쓰도록 한 곳에 둔다. eval-provider가 env 조합별 결과를 행으로 잠근다.
 *
 * - env `AI_PROVIDER`   : `openai` | `anthropic`. 빈 값·공백·모르는 값 = `openai`(1단계 기본 — 배포해도 동작 불변).
 * - env `AI_FALLBACK`   : `on`(기본) | `off`. 메인이 가용성 실패를 내면 백업 공급자로 같은 흐름을 한 번 더 — 백업 키가 있을 때만 의미.
 * - env `ANTHROPIC_MODEL`: 비면 `claude-opus-5-5`.
 * - 키: `OPENAI_API_KEY` · `ANTHROPIC_API_KEY`(앞뒤 공백 무시, 빈 값 = 없음).
 *
 * 비LLM OpenAI 기능(TTS·전사·실시간 음성·사진)은 이 선택과 무관하게 OpenAI 전용이다 — 그 라우트는 OPENAI_API_KEY를 그대로 본다.
 */

export type AiProvider = "openai" | "anthropic";

/** Claude 쪽 깊이 다이얼(output_config.effort). OpenAI 경로에는 싣지 않는다(기존 요청 모양 불변). */
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** ANTHROPIC_MODEL 미설정(빈 값 포함) 시 기본 모델 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** 호출부가 effort를 넘기지 않았을 때 Claude에 싣는 값 — claude-opus-5-5의 서버 기본과 같지만 명시한다(모델이 바뀌어도 흔들리지 않게). */
export const DEFAULT_AI_EFFORT: AiEffort = "medium";

type Env = Record<string, string | undefined>;

function envValue(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

/** 메인 공급자 — `anthropic`만 Claude, 그 밖(빈 값·오타 포함)은 전부 openai(보수적 — 모르는 값으로 공급자가 바뀌지 않게). */
export function resolveAiProvider(env: Env = process.env): AiProvider {
  return envValue(env, "AI_PROVIDER").toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

/** 백업 사용 여부 — `off`·`0`·`false`·`no`만 끈다. 빈 값·그 밖은 켬(기본 on). */
export function resolveAiFallbackEnabled(env: Env = process.env): boolean {
  return !["off", "0", "false", "no"].includes(envValue(env, "AI_FALLBACK").toLowerCase());
}

/** Claude 모델 — env `ANTHROPIC_MODEL`(앞뒤 공백 무시), 비면 DEFAULT_ANTHROPIC_MODEL */
export function resolveAnthropicModel(env: Env = process.env): string {
  return envValue(env, "ANTHROPIC_MODEL") || DEFAULT_ANTHROPIC_MODEL;
}

/**
 * 수학 검산(호출 C) 전용 Claude 모델 — env `ANTHROPIC_MODEL_VERIFY`, 비면 resolveAnthropicModel().
 * OpenAI 쪽 `OPENAI_MODEL_VERIFY`(심판만 더 강한 모델로 올릴 여지)와 짝이다. 호출부(검산)가 `anthropicModel`로 넘긴다 — 래퍼는 라벨로 고르지 않는다.
 */
export function resolveAnthropicVerifyModel(env: Env = process.env): string {
  return envValue(env, "ANTHROPIC_MODEL_VERIFY") || resolveAnthropicModel(env);
}

/** 그 공급자의 키가 있는가(빈 값·공백 = 없음) */
export function providerHasKey(provider: AiProvider, env: Env = process.env): boolean {
  return envValue(env, provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY") !== "";
}

export function otherProvider(provider: AiProvider): AiProvider {
  return provider === "openai" ? "anthropic" : "openai";
}

/**
 * 한 호출의 공급자 계획.
 * - `primary`: 먼저 부를 공급자. `backup`: 메인이 가용성 실패일 때 한 번 더 부를 공급자(없으면 null).
 * - `primaryNoKey`: 설정상 메인은 다른 쪽인데 그 키가 없어 백업을 곧바로 메인으로 올렸는지(로그 `fallback.reason = "primary_no_key"`).
 */
export interface ProviderPlan {
  primary: AiProvider;
  backup: AiProvider | null;
  primaryNoKey: boolean;
}

/**
 * 공급자 계획 — 순수 함수.
 * - `fixed`(호출부 고정, 예: 자유대화 호출 J는 `openai`): 그 공급자 하나만, 백업 없음.
 * - 아니면 메인 = `AI_PROVIDER`, 백업 = `AI_FALLBACK`이 켜져 있고 다른 쪽 키가 있을 때만 다른 쪽.
 * - 메인 키가 없고 백업이 있으면 백업을 메인으로 올린다(키 하나만 둔 배포도 돈다). 둘 다 없으면 메인 그대로 — 호출이 키 오류로 던진다
 *   (라우트는 그 전에 `hasLlmKey()`로 501을 낸다).
 */
export function resolveProviderPlan(fixed?: AiProvider, env: Env = process.env): ProviderPlan {
  if (fixed) return { primary: fixed, backup: null, primaryNoKey: false };
  const primary = resolveAiProvider(env);
  const other = otherProvider(primary);
  const backup = resolveAiFallbackEnabled(env) && providerHasKey(other, env) ? other : null;
  if (!providerHasKey(primary, env) && backup) return { primary: backup, backup: null, primaryNoKey: true };
  return { primary, backup, primaryNoKey: false };
}

/**
 * LLM 호출(callWithSchema)을 할 수 있는 키가 있는가 — 라우트의 501 `no_api_key` 판정용.
 * 현재 설정의 메인 키, 또는 (백업이 켜져 있으면) 백업 키 중 하나라도 있으면 참. 호출 계획이 실제로 부를 공급자의 키가 있는지와 같다.
 * TTS·전사·실시간 음성·사진 같은 OpenAI 전용 기능은 이 함수가 아니라 `OPENAI_API_KEY`를 본다.
 */
export function hasLlmKey(env: Env = process.env): boolean {
  return providerHasKey(resolveProviderPlan(undefined, env).primary, env);
}

/** callWithSchema 한 번이 **성공해 답한** 공급자·모델(2단계 — 레코드 `model` 칸을 실제 답한 모델로 남기기 위해). */
export interface LlmCallMeta {
  call: string;
  provider: AiProvider;
  /** 실제 답한 모델(Claude 서버 측 폴백이 돌면 대체 모델 이름) */
  model: string;
  /** 메인이 실패해 백업이 답했는지(primary_no_key 포함) */
  fallback: boolean;
}

/**
 * 레코드에 남길 모델 이름 — 순수 함수. 이 요청에서 답한 호출들의 모델을 중복 없이 `+`로 잇는다(메인이 답한 모델 먼저, 그다음 백업 — 각각 이름순. 여러 파트를 병렬로 만들다
 * 일부만 백업이 답하면 `claude-opus-5-5+gpt-6-luna`처럼 둘 다 남는다). 답한 호출이 없으면 `fallbackModel`(설정상 모델) 그대로.
 * 저장 스키마에 provider 칸을 더하지 않는다 — 모델 이름이 공급자를 스스로 드러내고(claude-·gpt-), 레코드 정규화 함수 여러 곳을 넓히지 않는다.
 */
export function answeredModel(calls: readonly LlmCallMeta[], fallbackModel: string): string {
  // 결정적 순서(QA 3차 P3-B): 병렬 호출은 완료 순서로 쌓이므로 그대로 이으면 같은 조합이 `a+b`·`b+a`로 갈린다.
  // 메인이 답한 모델(fallback false)을 먼저, 그다음 백업이 답한 모델 — 각 무리 안은 이름순. 한 모델이 양쪽에 있으면 메인 쪽으로 친다.
  const rank = new Map<string, number>();
  for (const c of calls) {
    if (c.model.trim() === "") continue;
    const r = c.fallback ? 1 : 0;
    rank.set(c.model, Math.min(rank.get(c.model) ?? r, r));
  }
  const models = [...rank.keys()].sort((a, b) => rank.get(a)! - rank.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
  return models.length > 0 ? models.join("+") : fallbackModel;
}

/**
 * 호출이 같은 요청 안에 없을 때(예: 사진 판독은 앞 요청, 저장은 뒤 요청) 레코드에 남길 **설정상** 모델 — 지금 계획의 메인이 Claude면
 * Claude 모델(`anthropicModel`, 비면 ANTHROPIC_MODEL), 아니면 `openaiModel`. 백업이 실제로 답했는지는 모른다(그건 answeredModel의 몫).
 */
export function plannedModel(openaiModel: string, anthropicModel?: string, env: Env = process.env): string {
  return resolveProviderPlan(undefined, env).primary === "anthropic" ? anthropicModel?.trim() || resolveAnthropicModel(env) : openaiModel;
}

/**
 * 실호출 eval 게이트·리포트용 한 줄 — 지금 설정에서 LLM 호출이 어느 공급자로 도는지(키 값은 담지 않는다).
 * 예: `메인 anthropic(claude-opus-5-5) · 백업 openai(호출부 model 또는 OPENAI_MODEL)`, 키가 없으면 `LLM 키 없음`.
 * `openaiModel`은 리포트에 찍을 OpenAI 쪽 모델 이름(호출부가 아는 값 — 이 모듈은 OPENAI_MODEL 기본값을 모른다).
 */
export function describeProviderPlan(openaiModel: string, env: Env = process.env): string {
  if (!hasLlmKey(env)) return "LLM 키 없음(OPENAI_API_KEY·ANTHROPIC_API_KEY 모두 비었거나 메인 키만 없고 백업이 꺼짐)";
  const plan = resolveProviderPlan(undefined, env);
  const name = (p: AiProvider) => (p === "anthropic" ? `anthropic(${resolveAnthropicModel(env)})` : `openai(${openaiModel})`);
  return `메인 ${name(plan.primary)}${plan.primaryNoKey ? "(설정상 메인의 키가 없어 올라옴)" : ""} · 백업 ${plan.backup ? name(plan.backup) : "없음"}`;
}

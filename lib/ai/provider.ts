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

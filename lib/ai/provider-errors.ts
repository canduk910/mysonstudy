/**
 * lib/ai/provider-errors.ts — 공급자 실패를 **백업으로 넘길지** 판정 (docs/HARNESS.md §5). 서버 전용(두 SDK의 오류 클래스를 import).
 *
 * 판정은 SDK의 typed 오류 클래스로만 한다(메시지 문자열 매칭 금지). eval-provider가 가짜 오류 객체(실제 SDK 클래스 인스턴스)로
 * 넘김/안 넘김 표를 잠근다.
 *
 * 넘긴다(가용성 실패): 529 overloaded · 5xx · 429(SDK 재시도 소진 후) · 408 · 연결 오류 · 타임아웃 · 거절(refusal) ·
 *   재요청까지 검증 실패 · Claude가 받지 못하는 입력(이미지 형식 등).
 * 넘기지 않는다: 사용자 취소(signal abort — 어떤 경우에도) · 400·401·403·404·422 같은 요청/설정 오류 · 그 밖의 예외(키 없음 등).
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ClaudeInputError } from "./provider-anthropic";
import type { AiProvider } from "./provider";

/** 모델이 거절했다(Claude `stop_reason: "refusal"` — 서버 측 폴백까지 거절). 백업 대상. */
export class AiRefusalError extends Error {
  readonly provider: AiProvider;
  readonly category: string | null;
  constructor(provider: AiProvider, category: string | null, message: string) {
    super(message);
    this.name = "AiRefusalError";
    this.provider = provider;
    this.category = category;
  }
}

/** 응답 검증(JSON·zod)이 재요청까지 2회 실패했다. 메시지는 기존 문장 그대로(`[ai:call] 응답 검증에 재요청까지 2회 실패했습니다: …`). 백업 대상. */
export class AiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiValidationError";
  }
}

export type FallbackDecision = { fallback: boolean; reason: string };

/** 오류 한 줄 요약 — 클래스 이름·상태·메시지 앞 200자(로그·cause 보존용, 프롬프트·사진은 담기지 않는다) */
export function summarizeProviderError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 200);
  const status = (err as { status?: unknown }).status;
  return `${err.name}${typeof status === "number" ? ` ${status}` : ""}: ${err.message.slice(0, 200)}`;
}

/**
 * 백업까지 실패했을 때 던질 백업 오류에 메인 오류를 붙인다(QA P3-4) — 오류 객체·클래스는 바꾸지 않는다(라우트의 instanceof 판정 보존).
 * `primaryError`(메인 오류 원본)를 덧붙이고, `cause`가 비어 있으면 거기에도 메인 오류를 둔다. Error가 아니면 그대로 둔다.
 */
export function attachPrimaryError(backupErr: unknown, primaryErr: unknown): unknown {
  if (!(backupErr instanceof Error)) return backupErr;
  try {
    Object.defineProperty(backupErr, "primaryError", { value: primaryErr, enumerable: false, configurable: true, writable: true });
    if ((backupErr as { cause?: unknown }).cause === undefined) {
      Object.defineProperty(backupErr, "cause", { value: primaryErr, enumerable: false, configurable: true, writable: true });
    }
  } catch {
    // 동결된 오류 객체 등 — 로그(fallback.error)에는 이미 남는다
  }
  return backupErr;
}

/**
 * 메인 공급자 실패를 백업으로 넘길지 — 순수 판정(오류 객체 + 끊는 신호만 본다).
 * 신호가 이미 끊겼으면 오류 종류와 무관하게 넘기지 않는다(사용자 취소·시간 상한은 백업으로도 지킨다).
 */
export function decideFallback(err: unknown, signal?: AbortSignal | null): FallbackDecision {
  if (signal?.aborted) return { fallback: false, reason: "aborted" };
  if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError) return { fallback: false, reason: "aborted" };
  if (err instanceof AiRefusalError) return { fallback: true, reason: "refusal" };
  if (err instanceof AiValidationError) return { fallback: true, reason: "validation" };
  if (err instanceof ClaudeInputError) return { fallback: true, reason: "unsupported_input" };

  // Anthropic — 구체 클래스부터
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { fallback: true, reason: "timeout" };
  if (err instanceof Anthropic.APIConnectionError) return { fallback: true, reason: "connection" };
  if (err instanceof Anthropic.OverloadedError) return { fallback: true, reason: "overloaded" };
  if (err instanceof Anthropic.RateLimitError) return { fallback: true, reason: "rate_limit" };
  if (err instanceof Anthropic.RequestTimeoutError) return { fallback: true, reason: "timeout" };
  // 413 — 이 공급자의 요청 크기 한도(Claude 32MB·이미지 5MB 등)를 넘었다. 다른 공급자는 받을 수 있어 넘긴다(크기는 요청 전 판정이 먼저 잡는다).
  if (err instanceof Anthropic.ContentTooLargeError) return { fallback: true, reason: "too_large" };
  if (err instanceof Anthropic.InternalServerError) return { fallback: true, reason: "server_error" };
  if (err instanceof Anthropic.APIError) return { fallback: false, reason: `status_${err.status ?? "unknown"}` };

  // OpenAI
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { fallback: true, reason: "timeout" };
  if (err instanceof OpenAI.APIConnectionError) return { fallback: true, reason: "connection" };
  if (err instanceof OpenAI.RateLimitError) return { fallback: true, reason: "rate_limit" };
  if (err instanceof OpenAI.InternalServerError) return { fallback: true, reason: "server_error" };
  if (err instanceof OpenAI.APIError) return { fallback: err.status === 408 || err.status === 413, reason: `status_${err.status ?? "unknown"}` };

  return { fallback: false, reason: "not_retriable" };
}

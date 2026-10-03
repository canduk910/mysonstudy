/**
 * lib/ai/phrase-helper/calls.ts — 표현 도우미 진입 함수 (**서버 전용**) (docs/harness/phrase-helper.md §7·§8)
 *
 * 세 모드(toeic·japanese·english-kid)가 이 함수 하나를 지난다. 공유 래퍼 `callWithSchema`(lib/ai/client.ts)를 **그대로** 부른다 —
 * client.ts에 진입 함수·과목 분기를 넣지 않는다(docs/HARNESS.md §2, 토익 calls.ts와 같은 모양). 모드 차이는 여기서 파라미터
 * (system·jsonSchema·zodSchema·call 라벨)로만 넘긴다.
 *
 * 순서: 입력 정리(거부면 PhraseHelperInputError — AI 0) → 로컬 판정(한글 없음이면 안내 결과 — AI 0) → callWithSchema 1회
 * (+ zod 재요청 1회) → 출력 다듬기. 저장하지 않는다.
 * - 모델: resolvePhraseHelperModel()(env OPENAI_PHRASE_HELPER_MODEL, 빈 값이면 gpt-6-luna — OPENAI_MODEL로 폴백하지 않는다).
 * - 시간 상한 30초(재요청 포함 전체) + 라우트의 요청 취소 신호(req.signal). 끊기면 SDK가 APIUserAbortError를 던진다.
 * - SDK 자동 재시도 0(retry-after 대기가 신호를 보지 않아 상한을 뚫는다). 상류 429·5xx는 곧바로 던진다 → 라우트 500 retriable.
 * - 키 검사(501)는 라우트가 이 함수보다 먼저 한다. 키가 없으면 getOpenAIClient가 throw한다(로컬 판정 결과는 키 없이도 돌려준다).
 *
 * ⚠️ 클라이언트 컴포넌트에서 import 금지(openai·API 키). 화면은 lib/phrase-helper.ts(클라이언트 안전)의 타입·함수만 쓴다.
 */

import { callWithSchema, textPart } from "../client";
import {
  normalizePhraseHelperInput,
  phraseHelperLocalResult,
  type PhraseHelperInputReason,
  type PhraseHelperMode,
  type PhraseHelperResult,
} from "../../phrase-helper";
import { resolvePhraseHelperModel } from "./model";
import {
  PHRASE_HELPER_CALL_OPTIONS,
  PHRASE_HELPER_SDK_MAX_RETRIES,
  PHRASE_HELPER_SYSTEM_PROMPTS,
  buildPhraseHelperUserMessage,
  phraseHelperAbortSignal,
  phraseHelperCallLabel,
} from "./prompts";
import {
  PHRASE_HELPER_EN_JSON_SCHEMA,
  PHRASE_HELPER_JA_JSON_SCHEMA,
  buildPhraseHelperEnZod,
  buildPhraseHelperJaZod,
  finalizePhraseHelperEnOutput,
  finalizePhraseHelperJaOutput,
} from "./schemas";

/** 입력 거부 — 라우트가 400 invalid_input으로 바꾼다(messageKo를 그대로 싣는다). AI를 부르기 전에 던진다 */
export class PhraseHelperInputError extends Error {
  readonly code: PhraseHelperInputReason;
  readonly messageKo: string;
  constructor(code: PhraseHelperInputReason, messageKo: string) {
    super(`[phrase_helper] 입력 거부: ${code}`);
    this.name = "PhraseHelperInputError";
    this.code = code;
    this.messageKo = messageKo;
  }
}

export function isPhraseHelperInputError(err: unknown): err is PhraseHelperInputError {
  return err instanceof PhraseHelperInputError;
}

/**
 * 표현 도우미 — 한국어 단어·구·문장(정리 뒤 1~200자) → 가장 회화적인 표현 1 + 대안 + 예문(모드별 눈높이·언어).
 * 반환은 다듬기까지 끝난 값이다(라우트는 그대로 200 본문 `result`로 내리면 된다). `status`가 ok가 아니어도 정상 결과다(noteKo가 안내).
 */
export async function explainPhrase(
  mode: PhraseHelperMode,
  input: string,
  options: { signal?: AbortSignal | null } = {},
): Promise<PhraseHelperResult> {
  const verdict = normalizePhraseHelperInput(input);
  if (!verdict.ok) throw new PhraseHelperInputError(verdict.reason, verdict.messageKo);
  const text = verdict.text;

  // 한글이 한 글자도 없으면 AI를 부르지 않는다(비용 0 — §2-2)
  const local = phraseHelperLocalResult(mode, text);
  if (local !== null) return local;

  const model = resolvePhraseHelperModel();
  const common = {
    call: phraseHelperCallLabel(mode),
    system: PHRASE_HELPER_SYSTEM_PROMPTS[mode],
    user: [textPart(buildPhraseHelperUserMessage(text))],
    temperature: PHRASE_HELPER_CALL_OPTIONS.temperature,
    maxOutputTokens: PHRASE_HELPER_CALL_OPTIONS.maxOutputTokens,
    model,
    signal: phraseHelperAbortSignal(options.signal),
    maxRetries: PHRASE_HELPER_SDK_MAX_RETRIES,
  };

  if (mode === "japanese") {
    const out = await callWithSchema({ ...common, jsonSchema: PHRASE_HELPER_JA_JSON_SCHEMA, zodSchema: buildPhraseHelperJaZod() });
    return { ...finalizePhraseHelperJaOutput(out), mode, input: text, source: "ai", model };
  }
  const out = await callWithSchema({ ...common, jsonSchema: PHRASE_HELPER_EN_JSON_SCHEMA, zodSchema: buildPhraseHelperEnZod(mode) });
  return { ...finalizePhraseHelperEnOutput(out), mode, input: text, source: "ai", model };
}

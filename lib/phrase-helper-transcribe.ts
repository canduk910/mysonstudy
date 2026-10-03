/**
 * lib/phrase-helper-transcribe.ts — 관문 K: 표현 도우미 마이크 모드의 **한국어** 음성 전사 (**서버 전용**)
 * (SPEC §22-2, docs/harness/phrase-helper.md §13, docs/HARNESS.md 하네스 밖 관문 표)
 *
 * **하네스 밖 관문**이다 — 오디오 → 텍스트 호출이라 `callWithSchema`·zod·재요청을 거치지 않는다(토익 관문 T `lib/toeic-transcribe.ts`와
 * 같은 부류). 토익 관문 T는 그대로 두고(영어 고정·재시도 1·30초 — `eval:toeic`이 소스로 잠근다) **모양만 따라** 새로 쓴다:
 * - 모델은 관문 T와 **같은 env** `OPENAI_TRANSCRIBE_MODEL`(빈 값이면 `gpt-4o-mini-transcribe`) — `resolveToeicTranscribeModel`을 그대로 부른다
 *   (전사 모델 설정이 둘로 갈리지 않게).
 * - `language: "ko"` 고정, `response_format: "json"`.
 * - **`prompt`를 넣지 않는다** — 이 함수는 prompt 인자가 없다. 기대 문장이 없는 자유 입력이라 유도할 대상도 없고, 사람이 고칠 입력 칸에
 *   채워 넣기만 한다(자동 전송 없음).
 * - 사람이 기다리는 호출이라 시간 상한 20초 + **SDK 재시도 0**(실패는 사람이 🎤를 다시 누른다 — 녹음이 30초 이하라 다시 말하기가 싸다).
 *   `signal`: 라우트가 `req.signal`을 넘긴다 — 화면이 끊으면(패널 닫힘·시험 시작) 상류 전사도 멈춘다.
 * - 실패는 throw하지 않고 결과 값. 키가 없으면 **네트워크 호출 없이** `no_api_key`.
 * - 녹음은 요청 메모리에서만 쓰고 저장하지 않는다. 로그에는 모델·바이트·ms·글자 수만(전사문·오디오 없음).
 */

import OpenAI, { toFile } from "openai";
import { resolveToeicTranscribeModel } from "./toeic-transcribe";

/** 전사 언어(ISO-639-1) — 표현 도우미 입력은 한국어다 */
export const PHRASE_HELPER_TRANSCRIBE_LANGUAGE = "ko";
/** 전사 한 번의 시간 상한(ms) */
export const PHRASE_HELPER_TRANSCRIBE_TIMEOUT_MS = 20_000;
/** SDK 자동 재시도 — 0(사람이 기다리는 호출, retry-after 대기가 상한을 뚫지 않게) */
export const PHRASE_HELPER_TRANSCRIBE_SDK_MAX_RETRIES = 0;

/** 전사 모델 — 관문 T와 같은 env·같은 기본값 */
export function resolvePhraseHelperTranscribeModel(): string {
  return resolveToeicTranscribeModel();
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다 */
export function hasPhraseHelperTranscribeApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey, maxRetries: PHRASE_HELPER_TRANSCRIBE_SDK_MAX_RETRIES, timeout: PHRASE_HELPER_TRANSCRIBE_TIMEOUT_MS });
  }
  return cachedClient;
}

export interface KoreanAudioInput {
  bytes: ArrayBuffer;
  /** 형식에 맞는 확장자가 붙은 파일 이름(speech.wav …) */
  fileName: string;
  /** 기본 타입(audio/wav …) */
  type: string;
}

export type KoreanTranscribeResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: "no_api_key" | "aborted" | "failed"; model: string; detail: string };

/** 한국어 음성 → 글자. 앞뒤 공백만 걷는다(입력 칸에서 사람이 고친다). */
export async function transcribeKorean(input: KoreanAudioInput, signal?: AbortSignal): Promise<KoreanTranscribeResult> {
  const model = resolvePhraseHelperTranscribeModel();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음" };

  const started = Date.now();
  try {
    const file = await toFile(new Uint8Array(input.bytes), input.fileName, { type: input.type });
    const res = await getClient(apiKey).audio.transcriptions.create(
      { file, model, language: PHRASE_HELPER_TRANSCRIBE_LANGUAGE, response_format: "json" },
      { signal },
    );
    const text = typeof res?.text === "string" ? res.text.trim() : "";
    console.log(`[phrase_helper:transcribe] model=${model} bytes=${input.bytes.byteLength} type=${input.type} chars=${[...text].length} ms=${Date.now() - started}`);
    return { ok: true, text, model };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "aborted", model, detail: "client closed" };
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[phrase_helper:transcribe] 실패 model=${model} bytes=${input.bytes.byteLength} type=${input.type} ms=${Date.now() - started}: ${detail}`);
    return { ok: false, error: "failed", model, detail };
  }
}

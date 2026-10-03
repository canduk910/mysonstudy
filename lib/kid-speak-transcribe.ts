/**
 * lib/kid-speak-transcribe.ts — 관문 W: 은우 "그림 보고 말하기"의 **영어 단어** 음성 전사 (**서버 전용**)
 * (2026-10-03, SPEC §15-5, docs/harness/english.md §14)
 *
 * **하네스 밖 관문**이다 — 오디오 → 텍스트 호출이라 `callWithSchema`·zod·재요청을 거치지 않는다(토익 관문 T `lib/toeic-transcribe.ts`·
 * 표현 도우미 관문 K `lib/phrase-helper-transcribe.ts`와 같은 부류). 두 관문은 그대로 두고(각 eval이 소스로 잠근다) **모양만 따라** 새로 쓴다:
 * - 모델은 관문 T·K와 **같은 env** `OPENAI_TRANSCRIBE_MODEL`(빈 값이면 `gpt-4o-mini-transcribe`) — `resolveToeicTranscribeModel`을 그대로 부른다.
 * - `language: "en"` 고정(아이 영어를 다른 언어로 적지 않게 — 자유대화 관문 R과 같은 이유), `response_format: "json"`.
 * - **`prompt`를 넣지 않는다** — 이 함수는 prompt 인자가 없다. 정답 단어를 넣으면 전사가 그쪽으로 끌려가 **말하지 않은 단어가 맞게 적힌다**
 *   (관문 T §5-0과 같은 무유도 원칙). 라우트는 정답을 받지도 않는다(lib/kid-speak-contract.ts).
 * - 아이가 기다리는 호출이라 시간 상한 12초 + **SDK 재시도 0**(실패는 🎤를 다시 누른다 — 녹음이 6초 이하라 다시 말하기가 싸다).
 *   `signal`: 라우트가 `req.signal`을 넘긴다 — 화면이 끊으면(그만하기·뒤로가기·스스로 확인으로 바꾸기) 상류 전사도 멈춘다.
 * - 실패는 throw하지 않고 결과 값. 키가 없으면 **네트워크 호출 없이** `no_api_key`.
 * - 녹음은 요청 메모리에서만 쓰고 저장하지 않는다. 로그에는 모델·바이트·ms·낱말 수만(전사문·오디오 없음 — 아이 목소리·말은 남기지 않는다).
 */

import OpenAI, { toFile } from "openai";
import { KID_SPEAK_TRANSCRIBE_TIMEOUT_MS } from "./kid-speak-contract";
import { resolveToeicTranscribeModel } from "./toeic-transcribe";

/** 전사 언어(ISO-639-1) — 영어 단어를 말한다 */
export const KID_SPEAK_TRANSCRIBE_LANGUAGE = "en";
/** SDK 자동 재시도 — 0(아이가 기다리는 호출, retry-after 대기가 상한을 뚫지 않게) */
export const KID_SPEAK_TRANSCRIBE_SDK_MAX_RETRIES = 0;

/** 전사 모델 — 관문 T·K와 같은 env·같은 기본값 */
export function resolveKidSpeakTranscribeModel(): string {
  return resolveToeicTranscribeModel();
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다 */
export function hasKidSpeakTranscribeApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey, maxRetries: KID_SPEAK_TRANSCRIBE_SDK_MAX_RETRIES, timeout: KID_SPEAK_TRANSCRIBE_TIMEOUT_MS });
  }
  return cachedClient;
}

export interface KidSpeakAudioInput {
  bytes: ArrayBuffer;
  /** 형식에 맞는 확장자가 붙은 파일 이름(word.wav …) */
  fileName: string;
  /** 기본 타입(audio/wav …) */
  type: string;
}

export type KidSpeakTranscribeResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: "no_api_key" | "aborted" | "failed"; model: string; detail: string };

/** 아이 음성 → 영어 글자. 앞뒤 공백만 걷는다(판정은 화면의 순수 함수가 정규화한다). */
export async function transcribeKidWord(input: KidSpeakAudioInput, signal?: AbortSignal): Promise<KidSpeakTranscribeResult> {
  const model = resolveKidSpeakTranscribeModel();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음" };

  const started = Date.now();
  try {
    const file = await toFile(new Uint8Array(input.bytes), input.fileName, { type: input.type });
    const res = await getClient(apiKey).audio.transcriptions.create(
      { file, model, language: KID_SPEAK_TRANSCRIBE_LANGUAGE, response_format: "json" },
      { signal },
    );
    const text = typeof res?.text === "string" ? res.text.trim() : "";
    const words = text === "" ? 0 : text.split(/\s+/).length;
    console.log(`[kid_speak:transcribe] model=${model} bytes=${input.bytes.byteLength} type=${input.type} words=${words} ms=${Date.now() - started}`);
    return { ok: true, text, model };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "aborted", model, detail: "client closed" };
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[kid_speak:transcribe] 실패 model=${model} bytes=${input.bytes.byteLength} type=${input.type} ms=${Date.now() - started}: ${detail}`);
    return { ok: false, error: "failed", model, detail };
  }
}

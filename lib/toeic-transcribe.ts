/**
 * lib/toeic-transcribe.ts — 관문 T: 모의고사 답변 음성 전사 (**서버 전용**) (docs/harness/toeic.md §1-1·§5-0)
 *
 * **하네스 밖 관문**이다 — Structured Outputs가 아니라 오디오 → 텍스트 호출이라 `callWithSchema`·zod·재요청을 거치지 않는다
 * (lib/tts.ts·lib/toeic-image.ts와 같은 부류, docs/HARNESS.md §0). 그래서 lib/ai/client.ts(스키마 관문)와 섞지 않고 **독립 OpenAI
 * 클라이언트**를 따로 쥔다 — 키 규약(없으면 호출하지 않는다)만 같은 모양이다. lib/ai/client.ts에 과목 분기를 두지 않는다.
 *
 * - 모델 `OPENAI_TRANSCRIBE_MODEL`(빈 값이면 `gpt-4o-mini-transcribe`), `language: "en"`, `response_format: "json"`
 *   (gpt-4o 계열 전사는 json만 된다).
 * - **기대 문장(지문·모범답변·질문)을 `prompt`로 넣지 않는다**(§5-0 2) — 전사가 기대 문장 쪽으로 끌려가 점수가 부풀려진다.
 *   그래서 이 함수는 prompt를 받는 인자 자체가 없다(eval이 소스에 prompt 필드가 없는지 정적으로 본다).
 * - `signal`: 라우트가 `req.signal`을 넘긴다 — 클라이언트가 끊으면 상류 전사도 멈춘다(비용 가드, /api/tts와 같은 관용구).
 * - 실패는 throw하지 않고 결과 값으로 돌려준다. 키가 없으면 **네트워크 호출 없이** `no_api_key`.
 *
 * 로그에는 모델·바이트·ms·단어 수만 남긴다(전사문·오디오는 남기지 않는다).
 */

import OpenAI, { toFile } from "openai";
import { countWords } from "./toeic-text";

/** 기본 전사 모델(§1-1 관문 표). env `OPENAI_TRANSCRIBE_MODEL`로 바꾼다. */
export const DEFAULT_TOEIC_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
/** 전사 언어(ISO-639-1) — 영어 답변만 받는다(정확도·지연 개선) */
export const TOEIC_TRANSCRIBE_LANGUAGE = "en";
/** 전사 한 번의 시간 상한(ms) — 채점 요청 전체(전사 + 호출 D)가 프로덕션 60초 상한 안에 들게 */
export const TOEIC_TRANSCRIBE_TIMEOUT_MS = 30_000;

/** 실제 쓸 모델 — 비었거나 공백뿐이면 기본값(빈 값이 `""`로 새면 호출이 400으로 실패한다, SPEC §11 빈 값 폴백). */
export function resolveToeicTranscribeModel(): string {
  return process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TOEIC_TRANSCRIBE_MODEL;
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다(lib/ai/client.ts·lib/tts.ts와 같은 규약). */
export function hasToeicTranscribeApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;

/** 전사 전용 OpenAI 클라이언트(캐시). 재시도 1회 — 60초 상한 안에서 두 번 이상 기다리지 않는다. */
function getTranscribeClient(apiKey: string): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI({ apiKey, maxRetries: 1, timeout: TOEIC_TRANSCRIBE_TIMEOUT_MS });
  return cachedClient;
}

export interface TranscribeAudioInput {
  /** 오디오 바이트(업로드 파일 그대로 — WAV 정규화본이거나 원본) */
  bytes: ArrayBuffer;
  /** 형식에 맞는 확장자가 붙은 파일 이름(answer.wav·answer.mp4 …) — 라우트가 계약의 toeicAudioFileName으로 정한다 */
  fileName: string;
  /** 기본 타입(audio/wav …) */
  type: string;
}

export type TranscribeResult =
  | { ok: true; text: string; model: string }
  | {
      ok: false;
      /** no_api_key: 키 없음(호출 안 함) · aborted: 클라이언트가 먼저 끊었다 · failed: API 오류·빈 응답·시간 초과 */
      error: "no_api_key" | "aborted" | "failed";
      model: string;
      /** 서버 로그용 짧은 원인(화면에 그대로 보이지 않는다) */
      detail: string;
    };

/**
 * 답변 음성 → 영어 전사문. 기대 문장을 넣지 않는다(위 머리 주석). 전사문은 앞뒤 공백만 걷는다(단어·문장부호는 그대로 —
 * Q1–2 대조와 호출 D의 said 대조가 정규화를 따로 한다).
 */
export async function transcribeAnswer(input: TranscribeAudioInput, signal?: AbortSignal): Promise<TranscribeResult> {
  const model = resolveToeicTranscribeModel();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음" };

  const started = Date.now();
  try {
    const file = await toFile(new Uint8Array(input.bytes), input.fileName, { type: input.type });
    const res = await getTranscribeClient(apiKey).audio.transcriptions.create(
      { file, model, language: TOEIC_TRANSCRIBE_LANGUAGE, response_format: "json" },
      { signal },
    );
    const text = typeof res?.text === "string" ? res.text.trim() : "";
    console.log(
      `[toeic:transcribe] model=${model} bytes=${input.bytes.byteLength} type=${input.type} words=${countWords(text)} ms=${Date.now() - started}`,
    );
    return { ok: true, text, model };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "aborted", model, detail: "client closed" };
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[toeic:transcribe] 실패 model=${model} bytes=${input.bytes.byteLength} type=${input.type} ms=${Date.now() - started}: ${detail}`);
    return { ok: false, error: "failed", model, detail };
  }
}

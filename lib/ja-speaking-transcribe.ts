/**
 * lib/ja-speaking-transcribe.ts — 관문 T-ja: 일본어 말하기 모의고사 답변 음성 전사 (**서버 전용**) (docs/harness/japanese.md §15-8)
 *
 * **하네스 밖 관문**이다 — 오디오 → 텍스트 호출이라 `callWithSchema`·zod·재요청을 거치지 않고 **독립 OpenAI 클라이언트**를 쥔다(키 규약만 같다).
 * 토익 lib/toeic-transcribe.ts는 `language: "en"` 고정이고 eval이 소스를 잠그므로 **고치지 않고 모양만 따라** 새로 쓴다(은우 관문 W 선례).
 *
 * - 모델: 토익 관문 T와 같은 env `OPENAI_TRANSCRIBE_MODEL`(빈 값이면 gpt-4o-mini-transcribe) — `resolveToeicTranscribeModel()`을 그대로 부른다.
 * - **`language: "ja"` 고정**(일본어 답을 다른 언어로 적지 않게), `response_format: "json"`, `maxRetries: 1`, 시간 상한 30초.
 * - **표기 지시 하나만 고정 문구로 보낸다(`JA_SPEAKING_TRANSCRIBE_PROMPT`)** — `language:"ja"`인데도 짧은 단어만 말하면 모델이 로마자로
 *   적는 일이 있어서(2026-11-18 실기기 "gadko sakka") "가나·한자로 적어라"만 말한다. 내용 단서는 하나도 없다 — 상수이고 입력에서 만들지 않는다.
 * - 🗓️ 오늘의 일본어 🎤 체크는 `transcribeJaDailyLine` — 같은 관문에 **히라가나 전용** 고정 지시(`JA_DAILY_LINE_TRANSCRIBE_PROMPT`)만 다르다.
 *   짧은 가나 단어를 말하면 모델이 한자로 넘겨짚어(「さっか」→「作家」) 가나 문장과 대조가 0%가 됐다. 판정은 한자 문장도 읽기 갈래로 대조하므로
 *   히라가나 받아쓰기가 손해가 없다(실호출 2026-11-18: 빠른 「がっこう さっか」 0% → 100%, 「山へ行きます」「わたしは学生です」 100%).
 *   모의고사는 전사문을 아빠가 읽고 AI 채점에 넣으므로 한자 섞인 표기를 그대로 둔다.
 * - **기대 문장(지문·모범답변·질문)을 넣지 않는다 — 두 함수 모두 그 인자 자체가 없다.** 넣으면 전사가 그쪽으로 끌려가 하지 않은 말이 맞게
 *   적힌다(Q1–2 대조가 특히 무너진다). eval(scripts/eval-japanese-speaking.ts)이 소스를 정적으로 본다.
 * - `signal`: 라우트가 `req.signal`을 넘긴다 — 화면이 끊으면 상류 전사도 멈춘다(499).
 * - 실패는 throw하지 않고 결과 값으로. 키가 없으면 네트워크 호출 없이 no_api_key.
 *
 * 로그에는 모델·바이트·형식·글자 수·ms만(전사문·오디오 없음).
 */

import OpenAI, { toFile } from "openai";
import { countJaSpeechChars } from "./ja-speaking";
import { resolveToeicTranscribeModel, type TranscribeAudioInput, type TranscribeResult } from "./toeic-transcribe";

/** 전사 언어(ISO-639-1) — 일본어 답변만 받는다 */
export const JA_SPEAKING_TRANSCRIBE_LANGUAGE = "ja";
/** 표기 지시(고정 문구 — 내용 단서 없음). 로마자 전사를 막는다 */
export const JA_SPEAKING_TRANSCRIBE_PROMPT = "日本語の音声です。ローマ字は使わず、ひらがな・カタカナ・漢字で書き起こしてください。";
/** 오늘의 일본어 🎤 체크 표기 지시(고정 문구 — 내용 단서 없음). 로마자·한자 넘겨짚기를 막는다 */
export const JA_DAILY_LINE_TRANSCRIBE_PROMPT = "日本語の音声です。ローマ字や漢字は使わず、聞こえたとおりにすべてひらがなで書き起こしてください。";
type JaTranscribePrompt = typeof JA_SPEAKING_TRANSCRIBE_PROMPT | typeof JA_DAILY_LINE_TRANSCRIBE_PROMPT;
/** 전사 한 번의 시간 상한(ms) — 채점 요청 전체(전사 + 호출 F)가 60초 상한 안에 들게 */
export const JA_SPEAKING_TRANSCRIBE_TIMEOUT_MS = 30_000;

let cachedClient: OpenAI | null = null;

/** 전사 전용 OpenAI 클라이언트(캐시). 재시도 1회 */
function getClient(apiKey: string): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI({ apiKey, maxRetries: 1, timeout: JA_SPEAKING_TRANSCRIBE_TIMEOUT_MS });
  return cachedClient;
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다 */
export function hasJaSpeakingTranscribeApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** 답변 음성 → 일본어 전사문(앞뒤 공백만 걷는다 — 대조·said 판정이 정규화를 따로 한다) */
export async function transcribeJaSpeakingAnswer(input: TranscribeAudioInput, signal?: AbortSignal): Promise<TranscribeResult> {
  return transcribeJa(input, JA_SPEAKING_TRANSCRIBE_PROMPT, signal);
}

/** 🗓️ 오늘의 일본어 🎤 핵심 문장 녹음 → 히라가나 전사문 */
export async function transcribeJaDailyLine(input: TranscribeAudioInput, signal?: AbortSignal): Promise<TranscribeResult> {
  return transcribeJa(input, JA_DAILY_LINE_TRANSCRIBE_PROMPT, signal);
}

/** 공통 몸통 — prompt는 위 두 고정 상수만 받는다(타입으로 잠금) */
async function transcribeJa(input: TranscribeAudioInput, fixedPrompt: JaTranscribePrompt, signal?: AbortSignal): Promise<TranscribeResult> {
  const model = resolveToeicTranscribeModel();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음" };

  const started = Date.now();
  try {
    const file = await toFile(new Uint8Array(input.bytes), input.fileName, { type: input.type });
    const res = await getClient(apiKey).audio.transcriptions.create(
      { file, model, language: JA_SPEAKING_TRANSCRIBE_LANGUAGE, prompt: fixedPrompt, response_format: "json" },
      { signal },
    );
    const text = typeof res?.text === "string" ? res.text.trim() : "";
    console.log(
      `[ja_speaking:transcribe] model=${model} bytes=${input.bytes.byteLength} type=${input.type} chars=${countJaSpeechChars(text)} ms=${Date.now() - started}`,
    );
    return { ok: true, text, model };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "aborted", model, detail: "client closed" };
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[ja_speaking:transcribe] 실패 model=${model} bytes=${input.bytes.byteLength} type=${input.type} ms=${Date.now() - started}: ${detail}`);
    return { ok: false, error: "failed", model, detail };
  }
}

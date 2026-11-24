/**
 * lib/transcribe-core.ts — 음성 전사 관문 공통 몸통 (**서버 전용**, 2026-11-25 정리)
 *
 * 전사 관문 넷 — T(토익 답변, `lib/toeic-transcribe.ts`) · T-ja(일본어 말하기·오늘의 일본어, `lib/ja-speaking-transcribe.ts`) ·
 * W(은우 단어 말하기, `lib/kid-speak-transcribe.ts`) · K(표현 도우미 한국어, `lib/phrase-helper-transcribe.ts`) — 가
 * 같은 몸통을 네 벌 들고 있었다: 키 없으면 네트워크 없이 no_api_key → `toFile` → 전사 API 호출(json) →
 * 앞뒤 공백만 걷기 → 성공·실패 한 줄 로그 → 끊김은 aborted · 그 밖은 failed(throw하지 않는다).
 * 여기에는 그 몸통만 있다. **언어·고정 표기 지시·시간 상한·재시도·로그에 실을 길이 단위는 각 관문이 정한다**
 * (공개 함수·오류 코드·상한은 각 모듈 그대로 — 이 파일은 그 모듈들만 부른다).
 *
 * ── 전사 무유도 ─────────────────────────────────────────────────────────────
 * `prompt`는 **선택 인자**이고, 넣는 것은 일본어 관문의 고정 표기 지시 상수뿐이다(그 모듈이 타입으로 잠근다).
 * T·W·K는 이 인자를 아예 쓰지 않는다 — 기대 문장(지문·정답·모범답변)을 넣으면 전사가 그쪽으로 끌려가 하지 않은 말이
 * 맞게 적힌다. 각 eval이 모듈 소스에 prompt가 없는지, 이 파일이 prompt를 **받은 경우에만** 싣는지 정적으로 본다.
 *
 * 로그에는 모델·바이트·형식·길이·ms만(전사문·오디오 없음).
 */

import OpenAI, { toFile } from "openai";

/** 전사 입력 — 업로드 파일 바이트·확장자가 맞는 파일 이름·기본 타입 */
export interface TranscribeCoreInput {
  bytes: ArrayBuffer;
  fileName: string;
  type: string;
}

export type TranscribeCoreResult =
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
 * 관문마다 따로 캐시하는 전사 전용 OpenAI 클라이언트 getter를 만든다(관문마다 재시도·시간 상한이 다르다).
 * 키는 부를 때 받는다 — 키 검사가 클라이언트 만들기보다 먼저다.
 */
export function makeTranscribeClientGetter(opts: { maxRetries: number; timeout: number }): (apiKey: string) => OpenAI {
  let cached: OpenAI | null = null;
  return (apiKey: string) => {
    if (!cached) cached = new OpenAI({ apiKey, maxRetries: opts.maxRetries, timeout: opts.timeout });
    return cached;
  };
}

export interface TranscribeCoreSpec {
  /** 로그 머리표(`toeic`·`ja_speaking`·`kid_speak`·`phrase_helper`) */
  logTag: string;
  /** 실제 쓸 모델(각 관문의 resolve 함수 결과) */
  model: string;
  /** 전사 언어(ISO-639-1) */
  language: string;
  /** 고정 표기 지시 — 일본어 관문만. 없으면 요청에 prompt 필드 자체가 없다 */
  prompt?: string;
  getClient: (apiKey: string) => OpenAI;
  /** 성공 로그에 실을 길이 조각(`words=3`·`chars=12`) — 전사문 자체는 싣지 않는다 */
  measure: (text: string) => string;
}

export async function runTranscription(
  spec: TranscribeCoreSpec,
  input: TranscribeCoreInput,
  opts: { signal?: AbortSignal } = {},
): Promise<TranscribeCoreResult> {
  const { model, logTag } = spec;
  const signal = opts.signal;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음" };

  const started = Date.now();
  try {
    const file = await toFile(new Uint8Array(input.bytes), input.fileName, { type: input.type });
    const res = await spec.getClient(apiKey).audio.transcriptions.create(
      {
        file,
        model,
        language: spec.language,
        ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
        response_format: "json",
      },
      { signal },
    );
    const text = typeof res?.text === "string" ? res.text.trim() : "";
    console.log(
      `[${logTag}:transcribe] model=${model} bytes=${input.bytes.byteLength} type=${input.type} ${spec.measure(text)} ms=${Date.now() - started}`,
    );
    return { ok: true, text, model };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "aborted", model, detail: "client closed" };
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[${logTag}:transcribe] 실패 model=${model} bytes=${input.bytes.byteLength} type=${input.type} ms=${Date.now() - started}: ${detail}`);
    return { ok: false, error: "failed", model, detail };
  }
}

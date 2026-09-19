/**
 * lib/tts.ts — 서버 전용 클라우드 TTS 합성 (SPEC §16). **서버에서만** import한다(openai 클라이언트를 쥔다).
 *
 * lib/ai/client.ts(Structured Outputs 전용 관문)와 **섞지 않는다**: 저쪽은 스키마·zod·callWithSchema로 JSON을
 * 검증해 받는 호출이고, TTS는 스키마가 없는 오디오 바이트 호출이다. 성격이 달라 관문을 공유하면 양쪽이 서로를
 * 오염시킨다. 그래서 여기서 **독립된 OpenAI 클라이언트**를 따로 쥔다(키·throw 규약만 lib/ai/client.ts와 같은 모양).
 *
 * 모델·음성은 하드코딩하지 않고 env로 뺀다(SPEC §2 규약). 기본값 근거는 리포트/주석 참고.
 */

import OpenAI from "openai";
import { clampTtsSpeed, type TtsLang } from "./tts-shared";

/**
 * 기본 TTS 모델. **`gpt-4o-mini-tts`** — OpenAI의 최신·가장 자연스러운 TTS(steerable). tts-1/tts-1-hd의
 * 압축·기계음보다 사람 같은 발음이라 "로봇 발음" 불만의 직접 해법이다. 비용도 낮다(§16-0: 무시할 만함).
 * `speed`(0.25~4.0) 파라미터를 지원한다(SDK 타입 기준 speed엔 모델 제외 단서가 없다 — 3단 속도가 그대로 전달됨).
 * 스냅샷 고정이 필요하면 env로 `gpt-4o-mini-tts-2025-12-15`를, 혹시 품질/속도 이슈가 있으면 `tts-1-hd`를 지정.
 */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

/**
 * 기본 음성. **en-US·ja-JP를 한 음성으로** 읽는다 — "한 선생님이 두 언어를 읽어 준다"는 일관성(SPEC "값 하나"
 * 원칙; 화면마다 목소리가 달라지면 앱이 여러 개처럼 느껴진다). gpt-4o-mini-tts는 다국어라 한 음성이 두 언어를
 * 모두 자연스럽게 낸다. `alloy`는 중립·또렷해 아이·부모 공용에 무난하다. 더 따뜻한 톤이 필요하면 env로
 * `nova`·`coral`·`sage` 등으로 바꾼다(품질 프로브에서 코드 변경 없이 A/B 가능).
 */
export const DEFAULT_TTS_VOICE = "alloy";

/** 실제 쓸 모델 — `OPENAI_TTS_MODEL` 없으면 기본값. */
export function resolveTtsModel(): string {
  return process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
}

/** 실제 쓸 음성 — `OPENAI_TTS_VOICE` 없으면 기본값. */
export function resolveTtsVoice(): string {
  return process.env.OPENAI_TTS_VOICE ?? DEFAULT_TTS_VOICE;
}

/** 키가 있는가 — 라우트가 501(폴백 신호)을 낼지 판정한다(lib/ai/client.ts와 같은 규약). */
export function hasTtsApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;

/** TTS 전용 OpenAI 클라이언트(캐시). 키 없으면 throw → 라우트가 501로 잡는다. */
function getTtsClient(): OpenAI {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다 (TTS, 서버 전용 env).");
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

export interface SynthesizeInput {
  text: string;
  /** 검증·로깅용. 합성 언어는 모델이 텍스트로 자동 판별하므로 API에 따로 넘기지 않는다(한 음성 규약). */
  lang: TtsLang;
  speed: number;
}

export interface SynthesizedAudio {
  audio: Buffer;
  contentType: string;
  model: string;
  voice: string;
}

/**
 * 텍스트 → mp3 오디오 바이트. 실패는 throw(라우트가 500으로 잡고, 클라이언트는 기기 음성으로 폴백).
 * mp3는 어디서나 `<audio>`로 재생되고 용량이 작다(§16-1).
 */
export async function synthesizeSpeech({ text, speed }: SynthesizeInput): Promise<SynthesizedAudio> {
  const model = resolveTtsModel();
  const voice = resolveTtsVoice();
  const res = await getTtsClient().audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
    speed: clampTtsSpeed(speed),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, contentType: "audio/mpeg", model, voice };
}

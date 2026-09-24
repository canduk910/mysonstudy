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
 * 기본 음성. **en-US·ja-JP·ko-KR을 한 음성으로** 읽는다 — "한 선생님이 여러 언어를 읽어 준다"는 일관성(SPEC "값 하나"
 * 원칙; 화면마다 목소리가 달라지면 앱이 여러 개처럼 느껴진다). gpt-4o-mini-tts는 다국어라 한 음성이 세 언어를
 * 모두 자연스럽게 낸다(ko-KR은 일본어 해설 듣기 §18·운동 세션 음성 안내 §19-6). `alloy`는 중립·또렷해 아이·부모 공용에 무난하다. 더 따뜻한 톤이 필요하면 env로
 * `nova`·`coral`·`sage` 등으로 바꾼다(품질 프로브에서 코드 변경 없이 A/B 가능).
 */
export const DEFAULT_TTS_VOICE = "alloy";

/** 실제 쓸 모델 — `OPENAI_TTS_MODEL`이 없거나 비어 있으면 기본값(빈 값이 `""`로 새면 합성이 실패해 조용히 기기 음성만 난다). */
export function resolveTtsModel(): string {
  return process.env.OPENAI_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;
}

/** 실제 쓸 음성 — `OPENAI_TTS_VOICE`가 없거나 비어 있으면 기본값. */
export function resolveTtsVoice(): string {
  return process.env.OPENAI_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE;
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
  /**
   * 합성 언어. **반드시 모델에 알려야 한다**(아래 `TTS_INSTRUCTIONS`).
   *
   * 예전에는 "모델이 텍스트로 자동 판별한다"고 보고 안 넘겼는데 **틀린 가정이었다** — 일본어 단어는
   * `約束`·`目標`처럼 한자만인 경우가 많고, 한자 카드는 아예 한 글자(`学`)다. 이런 텍스트는 중국어와
   * 구분이 안 돼서 **중국어 발음으로 읽혔다**(실사용에서 발견). 기기 음성은 `utterance.lang`을 주므로
   * 같은 사고가 없었다. 언어는 추측에 맡길 값이 아니다.
   */
  lang: TtsLang;
  speed: number;
}

/**
 * 언어별 낭독 지시. `gpt-4o-mini-tts`는 `instructions`로 말투를 조절할 수 있어, 여기에 **언어를 못박고**
 * 학습용 낭독 톤까지 함께 준다(교사가 예문을 읽어 주듯 또박또박).
 *
 * 일본어는 피치 액센트가 뜻을 가르므로(橋/箸) 표준어 억양을 명시한다 — 기기의 일본어 전용 음성이
 * 더 자연스럽게 들렸던 이유가 억양이었다.
 */
/**
 * 낭독 지시 버전. **지시를 고치면 이 값을 올려라.**
 *
 * 영속 캐시(IndexedDB)의 지문에 들어간다 — 지시가 바뀌면 옛 오디오가 통째로 비워진다. 이게 없으면
 * 언어 지시를 고쳐도 **이미 중국어로 합성돼 캐시된 단어는 계속 중국어로 들린다**(음성·모델이 그대로라
 * 지문이 안 바뀌므로). 발음이 달라지는 변경은 반드시 이 버전을 올려야 사용자에게 반영된다.
 */
export const TTS_INSTRUCTIONS_VERSION = 2;

/**
 * ko-KR(§18-3)은 대화 해설 낭독용 — 한국어 설명 속에 일본어 인용(「は」)이 섞인다. 그래서 "일본어 부분은 일본어로,
 * 중국어 금지"를 못박는다. ⚠️ 새 언어 **추가**는 기존 캐시 키와 겹치지 않아 버전을 올리지 않았다(2 유지 — 올리면
 * 영어·일본어 캐시까지 통째로 비워져 재합성 비용이 난다). 나중에 ko 지시를 **튜닝**하면 버전을 올려야 하고,
 * 그러면 전 언어 캐시가 비워진다 — 그 비용을 감수할 때만 고친다.
 */
const TTS_INSTRUCTIONS: Record<TtsLang, string> = {
  "ja-JP":
    "Read the text in Japanese. The text is Japanese, never Chinese — read kanji with their Japanese readings. " +
    "Use natural standard-Tokyo pitch accent. Speak calmly and clearly, like a language teacher reading an example for a learner.",
  "en-US":
    "Read the text in English with a natural American accent. " +
    "Speak clearly and warmly, like a teacher reading a word or sentence for a young learner.",
  "ko-KR":
    "Read the text in Korean with a clear, standard Seoul accent. " +
    "Parts written in Japanese (kana or kanji, especially inside 「」) must be read in Japanese with Japanese readings — never Chinese. " +
    "Speak calmly and clearly, like a teacher explaining a lesson to an adult learner.",
};

/** 언어별 낭독 지시(합성·eval 공용). tsx eval은 타입 검사를 안 하므로 모든 TTS_LANGS가 채워졌는지 이걸로 확인한다. */
export function ttsInstructionsFor(lang: TtsLang): string {
  return TTS_INSTRUCTIONS[lang] ?? "";
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
export async function synthesizeSpeech({ text, speed, lang }: SynthesizeInput): Promise<SynthesizedAudio> {
  const model = resolveTtsModel();
  const voice = resolveTtsVoice();
  const res = await getTtsClient().audio.speech.create({
    model,
    voice,
    input: text,
    // 언어를 지시로 못박는다 — 안 주면 한자 텍스트를 중국어로 읽는다(위 SynthesizeInput.lang 주석).
    instructions: ttsInstructionsFor(lang),
    response_format: "mp3",
    speed: clampTtsSpeed(speed),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, contentType: "audio/mpeg", model, voice };
}

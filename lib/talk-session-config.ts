/**
 * lib/talk-session-config.ts — 관문 R(OpenAI Realtime) 세션 설정 조립 (**서버 전용**) (docs/harness/english.md §12-1, SPEC §21-3)
 *
 * **하네스 밖 관문**이다 — Realtime 음성 대화는 Structured Outputs가 아니라 `callWithSchema`·zod·재요청을 거치지 않는다
 * (lib/tts.ts·토익 관문 P/T와 같은 부류, docs/HARNESS.md §0). 그래서 lib/ai/client.ts와 섞지 않는다 — 키 규약(없으면
 * OpenAI를 부르지 않는다, 라우트 501)만 같은 모양이다. 이 파일은 네트워크를 부르지 않는 **순수 조립**이다(연결·hangup은 라우트).
 *
 * 하는 일:
 * 1. 입력 정리 — 주제 프리셋 키(lib/talk-topics.ts에 있는 것만), 직접 입력(줄바꿈·제어문자·따옴표·#·백틱 제거, 1~30자),
 *    단어장(책 순서로 최대 20 단어, 각 {en, 첫 우리말 뜻|null}) → `TalkTopic` 스냅샷. 저장 레코드는 이 스냅샷을 그대로 남긴다.
 * 2. 지시문 조립 — TALK_TEACHER_INSTRUCTIONS의 `{lesson}` 한 자리에 수업 블록(주제·단어장) 하나. 스냅샷만 보고 만든다
 *    (같은 스냅샷 = 같은 지시문). 지시문은 **서버만** 만든다 — 클라이언트는 주제 키·직접 입력 글자·단어장 id만 보낸다.
 * 3. Realtime 세션 설정 객체 — 필드 이름은 설치된 SDK(openai 7.4.0)의 GA 타입 `RealtimeSessionCreateRequest`로 타입 검사된다.
 *    모델·음성·전사 모델은 env(빈 값·공백이면 기본값 — `?.trim() ||`, SPEC §11 빈 값 폴백), 속도는 천천히 0.85 / 보통 1.0 두 값만.
 *    화면 카드(§12-6): 지시문 뒤에 TALK_CARDS_INSTRUCTIONS를 덧붙이고, 도구 TALK_TOOLS·`tool_choice: "auto"`를 싣는다.
 * 4. 주제 일러스트 장면 문장(§12-6) — 프리셋은 lib/talk-topics.ts의 sceneEn, 직접 입력은 `a cheerful scene about: {주제}`,
 *    단어장은 `a cheerful scene with: {앞 4개 단어}`. 장면 라우트가 연결과 **같은 해석 함수**로 주제를 만든 뒤 부른다.
 *
 * 로그에 지시문·SDP·전사를 남기지 않는다(§12-1) — 이 파일은 아무것도 찍지 않는다.
 * ⚠️ 클라이언트 컴포넌트에서 import 금지(지시문 조립은 서버 몫). 화면에 필요한 키·라벨은 lib/talk-topics.ts에 있다.
 */

import type { RealtimeSessionCreateRequest } from "openai/resources/realtime/realtime";
import {
  TALK_CARDS_INSTRUCTIONS,
  TALK_CARDS_INSTRUCTIONS_JOINER,
  TALK_LESSON_TOPIC,
  TALK_LESSON_WORDS,
  TALK_SCENE_CUSTOM_PREFIX,
  TALK_SCENE_VOCAB_WORDS,
  TALK_SCENE_WORDS_JOINER,
  TALK_SCENE_WORDS_PREFIX,
  TALK_TEACHER_INSTRUCTIONS,
  fillTalkTemplate,
} from "./ai/english/talk-prompts";
import { TALK_LIMITS, TALK_TOOLS, TALK_TOOL_CHOICE, type TalkTopic, type TalkTopicWord } from "./ai/english/talk-schemas";
import { TALK_CUSTOM_TOPIC_MAX_CHARS, findTalkTopicPreset, isTalkSpeed, type TalkSpeed } from "./talk-topics";

// ---------------------------------------------------------------------------
// env — 모델·음성·전사 모델 (빈 값 폴백)
// ---------------------------------------------------------------------------

/** 기본 Realtime 모델(SPEC §21-1 사용자 결정). env `OPENAI_REALTIME_MODEL`로 바꾼다. */
export const DEFAULT_TALK_REALTIME_MODEL = "gpt-realtime-2.1";
/** 기본 선생님 음성(공식 권장 음성). env `OPENAI_REALTIME_VOICE`로 바꾼다. */
export const DEFAULT_TALK_REALTIME_VOICE = "marin";
/** 기본 은우 발화 전사 모델. env `OPENAI_REALTIME_TRANSCRIBE_MODEL`로 바꾼다. */
export const DEFAULT_TALK_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/** 선생님 한 차례의 출력 토큰 상한(§12-1 — 오디오 1초 ≈ 20토큰. 짧게 말하기는 지시문이 1차로 강제한다) */
export const TALK_REALTIME_MAX_OUTPUT_TOKENS = 1200;

/** 말 빠르기 → Realtime `audio.output.speed`(§12-1 — 서버는 이 두 값만 쓴다) */
export const TALK_SPEED_VALUES: Readonly<Record<TalkSpeed, number>> = {
  slow: 0.85,
  normal: 1.0,
};

/** 실제 쓸 Realtime 모델 — 비었거나 공백뿐이면 기본값 */
export function resolveTalkRealtimeModel(): string {
  return process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_TALK_REALTIME_MODEL;
}

/** 실제 쓸 선생님 음성 — 비었거나 공백뿐이면 기본값 */
export function resolveTalkRealtimeVoice(): string {
  return process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_TALK_REALTIME_VOICE;
}

/** 실제 쓸 은우 발화 전사 모델 — 비었거나 공백뿐이면 기본값 */
export function resolveTalkTranscribeModel(): string {
  return process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL?.trim() || DEFAULT_TALK_TRANSCRIBE_MODEL;
}

/** 키가 있는가 — 라우트가 OpenAI를 부르기 **전에** 501을 낼지 판정한다(lib/ai/client.ts·lib/tts.ts와 같은 규약) */
export function hasTalkApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * `reasoning` 필드를 받는 모델인가 — SDK 주석상 "reasoning-capable Realtime models such as gpt-realtime-2".
 * 기본값(gpt-realtime-2.1)은 해당한다. env로 비추론 모델(gpt-realtime-mini 등)로 바꿨을 때 이 필드 때문에 연결이 거부되지 않게
 * 2 계열(gpt-realtime-2, -2.1, -2.1-mini …)에만 싣는다(§12-1 "SDK가 지원할 때"의 보수적 해석).
 */
export function supportsRealtimeReasoning(model: string): boolean {
  return /^gpt-realtime-2(?:[.-]|$)/.test(model);
}

// ---------------------------------------------------------------------------
// 입력 정리 (§12-1) — 지시문에 넣기 전에 끝낸다
// ---------------------------------------------------------------------------

/** 줄바꿈·제어문자·폭 없는 공백을 공백으로, 연속 공백을 하나로, 앞뒤 정리 */
function cleanInline(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 지시문 주입을 막으려고 걷어 내는 글자 — 따옴표(곧은·굽은)·백틱·#(§12-1) */
const TOPIC_STRIP_RE = /["'“”‘’„‟«»`#＃]/g;

/**
 * 직접 입력 주제 정리(§12-1): 줄바꿈·제어문자 제거 → 따옴표·#·백틱 제거 → 공백 정리 → 1~30자(코드 포인트)면 그 글자, 아니면 null.
 * 30자를 넘으면 자르지 않고 null이다(라우트 400 — 입력창이 TALK_CUSTOM_TOPIC_MAX_CHARS로 먼저 막는다).
 */
export function cleanTalkCustomTopic(raw: unknown): string | null {
  const s = cleanInline(cleanInline(raw).replace(TOPIC_STRIP_RE, ""));
  const len = Array.from(s).length;
  if (len < 1 || len > TALK_CUSTOM_TOPIC_MAX_CHARS) return null;
  return s;
}

/** 단어장 단어가 읽는 최소 모양 — VocabEntry·"모은 단어"의 단어가 모두 만족한다(word·meanings[].ko·definitionKo) */
export interface TalkVocabEntryLike {
  word: string;
  meanings: readonly { ko: string }[];
  definitionKo: string | null;
}

/**
 * 단어장 → 선생님에게 넘길 단어(§12-1): 책 순서로 **최대 TALK_LIMITS.vocabWords(20)개**, 각 `{en: word, ko}`.
 * ko = `meanings[0].ko`, 비었으면 `definitionKo`, 둘 다 없으면 null(지시문에서 뜻 생략). 빈 단어와 같은 단어(대소문자 무시)의
 * 되풀이는 건너뛴다(자리를 낭비하지 않게). 줄바꿈·제어문자는 공백으로 — 단어 목록의 줄 구조를 깨지 않게.
 */
export function buildTalkVocabWords(entries: readonly TalkVocabEntryLike[]): TalkTopicWord[] {
  const out: TalkTopicWord[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (out.length >= TALK_LIMITS.vocabWords) break;
    const en = cleanInline(e?.word);
    if (en === "") continue;
    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ko = cleanInline(e.meanings?.[0]?.ko) || cleanInline(e.definitionKo) || null;
    out.push({ en, ko });
  }
  return out;
}

/** 프리셋 키 → 주제 스냅샷(lib/talk-topics.ts에 없는 키면 null → 라우트 400) */
export function resolvePresetTalkTopic(key: unknown): TalkTopic | null {
  const p = findTalkTopicPreset(key);
  if (!p) return null;
  return { kind: "preset", key: p.key, labelKo: p.labelKo, labelEn: p.labelEn, vocabBookId: null, words: [] };
}

/** 직접 입력 → 주제 스냅샷(정리 후 1~30자가 아니면 null → 라우트 400) */
export function resolveCustomTalkTopic(text: unknown): TalkTopic | null {
  const cleaned = cleanTalkCustomTopic(text);
  if (cleaned === null) return null;
  return { kind: "custom", key: null, labelKo: cleaned, labelEn: null, vocabBookId: null, words: [] };
}

/** 단어장 제목 기본값(제목이 정리 후 비었을 때) */
export const TALK_VOCAB_TITLE_FALLBACK = "단어장";

/**
 * 단어장 → 주제 스냅샷. 라우트가 `getVocabBook(id)` + `isRenderableVocabBook`으로 404를 가른 **뒤에** 부른다(클라이언트는 id만 보낸다).
 * 넘길 단어가 하나도 없으면 null(라우트 400). 제목은 지시문에서 큰따옴표 안에 들어가므로 줄바꿈·제어문자·큰따옴표를 걷는다.
 */
export function resolveVocabTalkTopic(book: {
  id: string;
  titleKo: string;
  entries: readonly TalkVocabEntryLike[];
}): TalkTopic | null {
  const words = buildTalkVocabWords(book.entries ?? []);
  if (words.length === 0) return null;
  const title = cleanInline(cleanInline(book.titleKo).replace(/["“”`]/g, "")) || TALK_VOCAB_TITLE_FALLBACK;
  return { kind: "vocab", key: null, labelKo: title, labelEn: null, vocabBookId: book.id, words };
}

// ---------------------------------------------------------------------------
// 지시문 조립 (§12-1)
// ---------------------------------------------------------------------------

/** 수업 블록 하나 — 프리셋 `{labelEn} ({labelKo})`, 직접 입력은 글자 그대로, 단어장은 `- word (뜻)` 줄 목록 */
export function buildTalkLesson(topic: TalkTopic): string {
  if (topic.kind === "vocab") {
    const words = topic.words.map((w) => (w.ko ? `- ${w.en} (${w.ko})` : `- ${w.en}`)).join("\n");
    return fillTalkTemplate(TALK_LESSON_WORDS, { title: topic.labelKo, words });
  }
  const label = topic.kind === "preset" && topic.labelEn ? `${topic.labelEn} (${topic.labelKo})` : topic.labelKo;
  return fillTalkTemplate(TALK_LESSON_TOPIC, { topic: label });
}

/**
 * 세션 지시문 완성본 = 선생님 지시문(`{lesson}` 한 자리 치환 — 치환은 이 한 자리뿐) + `"\n\n"` + 화면 카드 덧붙임
 * (TALK_CARDS_INSTRUCTIONS, §12-6). 덧붙임은 치환하지 않는다(자리표시자가 없다).
 */
export function buildTalkInstructions(topic: TalkTopic): string {
  const teacher = fillTalkTemplate(TALK_TEACHER_INSTRUCTIONS, { lesson: buildTalkLesson(topic) });
  return `${teacher}${TALK_CARDS_INSTRUCTIONS_JOINER}${TALK_CARDS_INSTRUCTIONS}`;
}

// ---------------------------------------------------------------------------
// 주제 일러스트 장면 문장 (§12-6)
// ---------------------------------------------------------------------------

/**
 * 주제 스냅샷 → 장면 문장(sceneEn, 영어 한 줄). 사진 생성 프롬프트(buildTalkSceneImagePrompt)와 선생님 안내(buildTalkSceneNote)의 `{scene}`.
 * - 프리셋: lib/talk-topics.ts의 sceneEn(§12-6 표). 키를 못 찾으면(옛 기록 등) 직접 입력처럼 영어 라벨로.
 * - 직접 입력: `a cheerful scene about: {정리한 주제 글자}` — 한국어 주제면 한국어 그대로 들어간다(모델이 이해한다).
 * - 단어장: `a cheerful scene with: {앞 4개 단어를 ", "로}` — 스냅샷 단어(책 순서) 앞 TALK_SCENE_VOCAB_WORDS개.
 * 넣는 글자는 한 줄로 평탄화한다(라벨·단어는 입력 정리를 이미 거쳤다).
 */
export function buildTalkSceneEn(topic: TalkTopic): string {
  if (topic.kind === "preset") {
    const preset = findTalkTopicPreset(topic.key);
    if (preset) return preset.sceneEn;
    return `${TALK_SCENE_CUSTOM_PREFIX}${cleanInline(topic.labelEn ?? topic.labelKo)}`;
  }
  if (topic.kind === "vocab") {
    const words = topic.words
      .slice(0, TALK_SCENE_VOCAB_WORDS)
      .map((w) => cleanInline(w.en))
      .filter((w) => w !== "");
    return `${TALK_SCENE_WORDS_PREFIX}${words.join(TALK_SCENE_WORDS_JOINER)}`;
  }
  return `${TALK_SCENE_CUSTOM_PREFIX}${cleanInline(topic.labelKo)}`;
}

// ---------------------------------------------------------------------------
// Realtime 세션 설정 (§12-1 표) — 통합 인터페이스 `POST {OPENAI_BASE_URL}/realtime/calls` multipart `session`
// ---------------------------------------------------------------------------

/**
 * §12-1 표 그대로의 세션 설정. 라우트는 이것을 `JSON.stringify`해 multipart `session` 필드로 보낸다.
 * - 전사: 모델만 준다 — **language·prompt 지정 없음**(은우가 한국어를 섞는다; 단어장 단어를 prompt로 주면 하지 않은 말이 맞게
 *   적힐 위험 — 토익 관문 T와 같은 원칙). eval이 이 두 키가 없는지 본다.
 * - 턴 감지: semantic_vad, eagerness low(아이의 긴 쉼·"음…"에서 끊지 않게, 최대 약 8초), 응답 자동 생성·끼어들기 허용.
 * - 소음 억제: far_field(폰을 들고 스피커로 말하는 상황).
 * - 화면 카드(§12-6): 도구 TALK_TOOLS(show_hints·show_picture) + `tool_choice: "auto"`, 지시문 뒤 TALK_CARDS_INSTRUCTIONS.
 * 표에 없는 필드(tracing·truncation·include·prompt)는 싣지 않는다.
 */
export function buildTalkSessionConfig(args: { topic: TalkTopic; speed: TalkSpeed }): RealtimeSessionCreateRequest {
  if (!isTalkSpeed(args.speed)) throw new Error(`[talk] 알 수 없는 말 빠르기입니다: ${String(args.speed)}`);
  const model = resolveTalkRealtimeModel();
  const config: RealtimeSessionCreateRequest = {
    type: "realtime",
    model,
    instructions: buildTalkInstructions(args.topic),
    output_modalities: ["audio"],
    max_output_tokens: TALK_REALTIME_MAX_OUTPUT_TOKENS,
    tools: [...TALK_TOOLS],
    tool_choice: TALK_TOOL_CHOICE,
    audio: {
      input: {
        transcription: { model: resolveTalkTranscribeModel() },
        turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
        noise_reduction: { type: "far_field" },
      },
      output: {
        voice: resolveTalkRealtimeVoice(),
        speed: TALK_SPEED_VALUES[args.speed],
      },
    },
  };
  if (supportsRealtimeReasoning(model)) config.reasoning = { effort: "low" };
  return config;
}

// ---------------------------------------------------------------------------
// callId — 연결 응답 `Location` 헤더의 마지막 조각(§12-1). hangup 라우트가 받은 값도 같은 형식 검사를 거친다.
// ---------------------------------------------------------------------------

/** callId 형식 — 경로에 끼워 넣어도 안전한 글자만(`rtc_…` 모양, 길이 상한) */
const TALK_CALL_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** callId 형식인가(hangup 라우트가 URL 경로에 넣기 전에 본다) */
export function isTalkCallId(value: unknown): value is string {
  return typeof value === "string" && TALK_CALL_ID_RE.test(value);
}

/** `Location` 헤더(예: `/v1/realtime/calls/rtc_abc`) → callId. 없거나 형식이 틀리면 null. */
export function parseTalkCallId(location: string | null | undefined): string | null {
  if (typeof location !== "string") return null;
  const path = location.split(/[?#]/)[0];
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return isTalkCallId(last) ? last : null;
}

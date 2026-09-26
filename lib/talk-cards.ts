/**
 * lib/talk-cards.ts — 자유대화 **화면 카드**(선생님의 도구 호출) 검사·기본 도움 문구·단어장 ✓ 매칭 (docs/harness/english.md §12-6, SPEC §21-7)
 *
 * 선생님(Realtime 모델)은 도구 호출(function calling)로 화면 카드를 보낸다 — `show_hints`(말문 막힘 도움: 답 예시·핵심 단어)와
 * `show_picture`(그림 카드: 이모지·영어·뜻). 카드는 조용하다(앱은 소리를 내지 않는다 — 마이크가 열려 있다).
 *
 * - `parseTalkToolCall(name, argumentsJson)` — 모델 출력이라 믿지 않는다. **잘못된 항목만 버리고**(한글 섞인 답·빈 이모지·너무 긴 값),
 *   남는 게 없으면 null. 모르는 도구 이름도 null. 폭은 TALK_CARD_LIMITS 한 곳(§12-6: answers 1~3개·각 60자·라틴 포함·한글 금지,
 *   words 0~3개, emoji 1~16자, en 라틴 30자, ko 한글 20자). emoji에는 그림이 하나는 있어야 한다 — 이모지·국기·키캡과
 *   도형·기호 블록(▲●■◆☆ 등, containsPictograph). 글자·숫자만 있는 값은 거부.
 * - `TALK_FALLBACK_HINTS` — 받은 도움이 없을 때 보이는 기본 문구 4개(§12-6).
 * - `matchTalkWord(cardEn, words)` — 단어장 모드 "오늘의 단어" ✓(대소문자 무시·끝의 s 허용).
 * - 이벤트 도우미: 응답에서 function_call 꺼내기(`extractTalkFunctionCalls`), 응답 끝 요약(`summarizeTalkResponseDone` —
 *   도구를 부르고 **말한 글자에 질문 없이** 끝났으면(오디오 없음 포함) 이어 말하게 할 후보), 이어 말하기 판정(`decideTalkContinue`·
 *   `stepTalkContinue` — 연속 상한 `TALK_CONTINUE_CHAIN_MAX`, 은우 발화로만 0), 호출 결과 항목(`buildTalkToolOutputEvent`, id 접두사 `app_`).
 *
 * 도구 정의(JSON)는 세션 설정과 함께 서버만 쓰므로 lib/ai/english/talk-schemas.ts `TALK_TOOLS`에 있다(이름은 여기 TALK_TOOL_NAMES를 쓴다).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈 lib/talk-transcript.ts(런타임 import 0)뿐. lib/ai·openai·zod는 `import type`만.
 */

import type { ConversationItemCreateEvent } from "openai/resources/realtime/realtime";
import type { TalkCard } from "./ai/english/talk-schemas";
import { TALK_HIDDEN_ITEM_PREFIX, isTalkHiddenItemId } from "./talk-transcript";

// ---------------------------------------------------------------------------
// 이름·폭 — 한 곳에서 정의한다(TALK_TOOLS·저장 상한·화면이 이 값을 본다)
// ---------------------------------------------------------------------------

/** 도구 이름(§12-6 도구 정의의 name) */
export const TALK_TOOL_NAMES = {
  hints: "show_hints",
  picture: "show_picture",
} as const;
export type TalkToolName = (typeof TALK_TOOL_NAMES)[keyof typeof TALK_TOOL_NAMES];

/** 도구 호출 검사 폭(§12-6)과 카드 보관 수 */
export const TALK_CARD_LIMITS = {
  /** show_hints.answers — 1~3개 */
  answersMin: 1,
  answersMax: 3,
  /** 답 예시 하나의 글자 상한 */
  answerMaxChars: 60,
  /** show_hints.words — 0~3개 */
  wordsMax: 3,
  /** 이모지 칸 글자 수(코드 포인트) 1~16 */
  emojiMinChars: 1,
  emojiMaxChars: 16,
  /** 카드 영어 칸 글자 상한 */
  enMaxChars: 30,
  /** 카드 뜻(한국어) 칸 글자 상한 */
  koMaxChars: 20,
  /** 대화 기록에 남기는 그림 카드 수 상한(§12-6 "최대 30장") */
  savedCardsMax: 30,
  /** 화면에 작은 칩으로 남기는 지난 카드 수(§12-6 "최근 6장까지") */
  recentChips: 6,
} as const;

/** show_hints 결과 — answers는 늘 1개 이상이다(없으면 parseTalkToolCall이 null) */
export interface TalkHints {
  answers: string[];
  words: TalkCard[];
}

/** 검사를 통과한 도구 호출 */
export type TalkToolCall =
  | { name: typeof TALK_TOOL_NAMES.hints; hints: TalkHints }
  | { name: typeof TALK_TOOL_NAMES.picture; card: TalkCard };

/** 받은 도움이 없을 때 보이는 기본 문구(§12-6 `TALK_FALLBACK_HINTS` — 영어 4개는 스펙 그대로, 뜻은 1학년 눈높이 우리말) */
export interface TalkFallbackHint {
  en: string;
  ko: string;
}
export const TALK_FALLBACK_HINTS: readonly TalkFallbackHint[] = [
  { en: "Yes!", ko: "네!" },
  { en: "No.", ko: "아니요." },
  { en: "I don't know.", ko: "잘 모르겠어요." },
  { en: "Can you say it again?", ko: "다시 말해 줄래요?" },
];

// ---------------------------------------------------------------------------
// 글자 판정 — zod 파일(lib/ai/english/schemas.ts)을 클라이언트에서 부를 수 없어 여기서 정의한다
// ---------------------------------------------------------------------------

/** 라틴 문자(반각·전각). lib/ai/english/talk-schemas.ts `containsLatin`이 이 함수를 그대로 다시 내보낸다(정의 한 곳). */
export function containsLatin(text: string): boolean {
  return /[A-Za-zＡ-Ｚａ-ｚ]/.test(text);
}

/** 한글(완성형·자모). lib/ai/english/schemas.ts `containsHangul`과 같은 범위다(eval이 두 함수의 판정이 같은지 본다). */
export function containsHangulText(text: string): boolean {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
}

/**
 * 그림 문자가 하나라도 있는가(이모지 칸에 글자·`:dog:` 같은 단축어를 넣지 않게). 키캡(1️⃣)·국기도 인정한다.
 * 이모지 표현이 아닌 **도형·기호 블록**도 그림으로 인정한다 — "색깔과 모양" 주제에서 모델이 ▲●■◆△○□☆⬟⬢✦ 같은 텍스트 기호를 주면
 * 그림 카드가 조용히 사라지던 문제(QA cards P2-1). 블록: Geometric Shapes U+25A0–25FF, Misc Symbols U+2600–26FF,
 * Dingbats U+2700–27BF, Misc Symbols and Arrows U+2B00–2BFF, Geometric Shapes Extended U+1F780–1F7FF.
 * 그 블록 안이라도 **글자·숫자(`\p{L}`·`\p{N}` — ❶~➓ 같은 동그라미 숫자)**는 그림으로 치지 않는다. 블록 밖의 글자형 기호
 * (Ⓐ·①·㉠)도 그림이 아니다 — `\p{So}` 전체를 열지 않은 이유다. 라틴·한글 금지는 sanitizeTalkCard가 따로 건다.
 */
const PICTOGRAPH_RE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3|(?![\p{L}\p{N}])[\u25A0-\u27BF\u2B00-\u2BFF\u{1F780}-\u{1F7FF}]/u;
function containsPictograph(text: string): boolean {
  return PICTOGRAPH_RE.test(text);
}

/** 글자 수 — 코드 포인트 기준 */
function countChars(text: string): number {
  return Array.from(text).length;
}

/** 모델이 준 값 정리 — 문자열이 아니면 null. 제어문자·줄바꿈·폭 없는 공백을 공백으로, 연속 공백 하나로, 앞뒤 정리. 비면 null.
 *  (이모지 결합에 쓰는 ZWJ U+200D·이체 선택자 U+FE0F는 건드리지 않는다) */
function cleanValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// 카드·도움 검사
// ---------------------------------------------------------------------------

/**
 * 카드 한 장(show_picture 인자 · show_hints.words 항목 · 저장 요청의 cards 항목) 검사. 하나라도 어긋나면 null.
 * - emoji: 1~16자(코드 포인트), 그림 문자(이모지·도형 기호 블록 — containsPictograph) 포함, 라틴·한글 금지
 * - en: 1~30자, 라틴 포함, 한글 금지
 * - ko: 1~20자, 한글 포함
 */
export function sanitizeTalkCard(raw: unknown): TalkCard | null {
  if (!isRec(raw)) return null;
  const L = TALK_CARD_LIMITS;
  const emoji = cleanValue(raw.emoji);
  const en = cleanValue(raw.en);
  const ko = cleanValue(raw.ko);
  if (emoji === null || en === null || ko === null) return null;
  const emojiLen = countChars(emoji);
  if (emojiLen < L.emojiMinChars || emojiLen > L.emojiMaxChars) return null;
  if (!containsPictograph(emoji) || containsLatin(emoji) || containsHangulText(emoji)) return null;
  if (countChars(en) > L.enMaxChars || !containsLatin(en) || containsHangulText(en)) return null;
  if (countChars(ko) > L.koMaxChars || !containsHangulText(ko)) return null;
  return { emoji, en, ko };
}

/** 답 예시 하나 검사 — 1~60자, 라틴 포함, 한글 금지. 어긋나면 null. */
function sanitizeAnswer(raw: unknown): string | null {
  const a = cleanValue(raw);
  if (a === null) return null;
  if (countChars(a) > TALK_CARD_LIMITS.answerMaxChars || !containsLatin(a) || containsHangulText(a)) return null;
  return a;
}

/** 도구 인자 JSON → 객체(문자열이 아니거나 JSON이 아니거나 객체가 아니면 null) */
function parseArguments(argumentsJson: unknown): Rec | null {
  if (typeof argumentsJson !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return isRec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 같은 영어(대소문자·공백 무시)는 한 번만 — 앞의 것이 이긴다 */
const dedupeKey = (en: string) => en.toLowerCase().replace(/\s+/g, " ");

/**
 * 도구 호출 검사(§12-6). 잘못된 항목만 버리고 남는 게 없으면 null. 모르는 도구 이름도 null.
 * - show_hints: answers에서 검사를 통과한 것 앞 3개(같은 문장 되풀이는 하나로) — **1개도 없으면 null**(답 예시가 도움 카드의 본체다).
 *   words에서 검사를 통과한 카드 앞 3개(같은 영어 되풀이는 하나로).
 * - show_picture: 인자 자체가 카드 한 장 — 검사에 어긋나면 null.
 */
export function parseTalkToolCall(name: unknown, argumentsJson: unknown): TalkToolCall | null {
  if (name !== TALK_TOOL_NAMES.hints && name !== TALK_TOOL_NAMES.picture) return null;
  const args = parseArguments(argumentsJson);
  if (args === null) return null;
  const L = TALK_CARD_LIMITS;

  if (name === TALK_TOOL_NAMES.picture) {
    const card = sanitizeTalkCard(args);
    return card ? { name, card } : null;
  }

  const answers: string[] = [];
  const seenAnswers = new Set<string>();
  for (const raw of Array.isArray(args.answers) ? args.answers : []) {
    if (answers.length >= L.answersMax) break;
    const a = sanitizeAnswer(raw);
    if (a === null) continue;
    const key = dedupeKey(a);
    if (seenAnswers.has(key)) continue;
    seenAnswers.add(key);
    answers.push(a);
  }
  if (answers.length < L.answersMin) return null;

  const words: TalkCard[] = [];
  const seenWords = new Set<string>();
  for (const raw of Array.isArray(args.words) ? args.words : []) {
    if (words.length >= L.wordsMax) break;
    const w = sanitizeTalkCard(raw);
    if (w === null) continue;
    const key = dedupeKey(w.en);
    if (seenWords.has(key)) continue;
    seenWords.add(key);
    words.push(w);
  }
  return { name, hints: { answers, words } };
}

/**
 * 대화 기록에 남길 그림 카드 목록(저장 라우트·화면 공용). 카드마다 sanitizeTalkCard를 다시 거치고(클라이언트가 보낸 값을 믿지 않는다),
 * 같은 영어는 처음 것 하나만, 보인 순서대로 최대 TALK_CARD_LIMITS.savedCardsMax(30)장. 배열이 아니면 [].
 */
export function sanitizeTalkCards(raw: unknown): TalkCard[] {
  if (!Array.isArray(raw)) return [];
  const out: TalkCard[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= TALK_CARD_LIMITS.savedCardsMax) break;
    const card = sanitizeTalkCard(item);
    if (card === null) continue;
    const key = dedupeKey(card.en);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 단어장 ✓ 매칭 (§12-6 — 대소문자 무시, 끝의 s 허용)
// ---------------------------------------------------------------------------

/** 비교용 정규화 — 소문자·아포스트로피 통일·앞뒤 문장부호 제거·앞 관사(a/an/the) 제거·공백 하나로 */
function normalizeWordForMatch(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'“”.,!?;:()[\]]+|[\s"'“”.,!?;:()[\]]+$/g, "")
    .replace(/^(?:a|an|the) (?=\S)/, "")
    .trim();
}

/** 두 낱말이 같은가 — 같거나, 한쪽이 다른 쪽 + s / es, 또는 y ↔ ies(berry ↔ berries) */
function sameWordLoose(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b) return true;
  const plural = (base: string, other: string) =>
    other === `${base}s` || other === `${base}es` || (base.endsWith("y") && base.length > 1 && other === `${base.slice(0, -1)}ies`);
  return plural(a, b) || plural(b, a);
}

/**
 * 그림 카드의 영어(cardEn)가 오늘의 단어 가운데 하나와 같으면 그 단어(목록에 적힌 그대로의 `en`)를, 없으면 null.
 * 대소문자·앞뒤 문장부호·앞 관사는 무시하고, 끝의 s(es·y→ies 포함)는 같은 단어로 본다(dog = dogs = a dog).
 */
export function matchTalkWord(cardEn: string, words: readonly { en: string }[]): string | null {
  const c = normalizeWordForMatch(typeof cardEn === "string" ? cardEn : "");
  if (c === "") return null;
  for (const w of words) {
    if (typeof w?.en !== "string") continue;
    if (sameWordLoose(c, normalizeWordForMatch(w.en))) return w.en;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 이벤트 도우미 — 도구 호출 꺼내기·응답 끝 요약·호출 결과 항목
// ---------------------------------------------------------------------------

/** 응답에서 꺼낸 function_call 하나(검사 전 원본) */
export interface TalkFunctionCallRef {
  callId: string;
  name: string;
  argumentsJson: string;
  responseId: string | null;
}

function functionCallFromItem(item: unknown, responseId: string | null): TalkFunctionCallRef | null {
  if (!isRec(item) || item.type !== "function_call") return null;
  if (typeof item.call_id !== "string" || item.call_id === "") return null;
  if (typeof item.name !== "string") return null;
  return {
    callId: item.call_id,
    name: item.name,
    argumentsJson: typeof item.arguments === "string" ? item.arguments : "",
    responseId,
  };
}

/**
 * 서버 이벤트에서 function_call 항목을 꺼낸다(§12-6 "response.output_item.done 또는 response.done의 output").
 * 같은 호출이 두 이벤트에 다 나오므로 **앱은 callId로 한 번만** 처리한다. 그 밖의 이벤트면 [].
 */
export function extractTalkFunctionCalls(event: unknown): TalkFunctionCallRef[] {
  if (!isRec(event)) return [];
  if (event.type === "response.output_item.done") {
    const ref = functionCallFromItem(event.item, typeof event.response_id === "string" ? event.response_id : null);
    return ref ? [ref] : [];
  }
  if (event.type === "response.done" && isRec(event.response)) {
    const responseId = typeof event.response.id === "string" ? event.response.id : null;
    const output = Array.isArray(event.response.output) ? event.response.output : [];
    return output.map((it) => functionCallFromItem(it, responseId)).filter((r): r is TalkFunctionCallRef => r !== null);
  }
  return [];
}

/**
 * 이어 말하기(response.create)의 **연속 상한**(§12-6) — 한 곳. 은우 발화(`input_audio_buffer.speech_started`)에서만 0으로 돌아간다.
 * 선생님 소리가 있던 응답으로는 되돌리지 않는다 — 말만 하고 질문 없이 끝나는 응답이 이어 말하기를 끝없이 부르지 않게(매 응답이
 * 대화 전체를 다시 입력으로 과금한다).
 */
export const TALK_CONTINUE_CHAIN_MAX = 2;

/** 질문 표시 — 반각 `?`·전각 `？` */
const QUESTION_MARK_RE = /[?？]/;

/** 선생님이 말한 글자에 질문이 있는가(`?`·`？`) */
export function talkSpokeQuestion(text: string): boolean {
  return QUESTION_MARK_RE.test(text);
}

/** response.done 요약 — 도구를 부르고 질문 없이 끝났는지(§12-6) */
export interface TalkResponseDoneSummary {
  responseId: string | null;
  status: string | null;
  /** 선생님 말(assistant 메시지 항목)이 있었는가 — 오디오 모드라 메시지 = 오디오 */
  hadAudio: boolean;
  /**
   * 이 응답에서 선생님이 말한 글자 — output의 assistant 메시지 content의 오디오 전사(`transcript`, 글자 모드면 `text`)를 이은 것.
   * 오디오가 없으면 "". 오디오는 있었는데 글자를 끝내 모르면(전사가 비어 오고 대체 조회도 없음) null.
   */
  spokenText: string | null;
  /** 말한 글자에 질문(`?`·`？`)이 있었는가. 글자를 모르면(null) false — 판정은 shouldContinue가 보수적으로 한다 */
  askedQuestion: boolean;
  functionCalls: TalkFunctionCallRef[];
  /**
   * 도구를 부르고 정상 완료했는데 **말한 글자에 질문이 없다**(오디오가 없던 응답 포함) → 앱이 호출 결과를 넣은 **뒤**
   * `response.create`를 보내 선생님이 이어 말하게 할 **후보**다(2026-09-26 실연결 — 선생님이 한두 마디 하다 도구를 부르고 질문 없이
   * 응답을 끝내 은우가 질문을 못 듣고 기다리던 것). 질문을 했으면(은우 차례), 끊긴·실패한 응답이면, 도구가 없으면, 오디오는 있었는데
   * 글자를 모르면(질문했을지 모른다 — 은우 차례를 빼앗지 않는다) false. 연속 상한·마무리는 `decideTalkContinue`가 본다.
   */
  shouldContinue: boolean;
}

/** 메시지 항목 하나의 말한 글자 — content의 transcript(오디오)·text(글자)를 잇는다. 하나도 없으면 null */
function spokenTextOfMessage(item: Rec): string | null {
  const parts = Array.isArray(item.content) ? item.content : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRec(part)) continue;
    // 빈 전사("")·공백은 "글자 없음"으로 본다 — 글자로 받으면 대체 조회를 건너뛰어, 질문한 응답 뒤에도 이어 말하기를 보낸다(QA 5 P2-A).
    if (typeof part.transcript === "string" && part.transcript.trim() !== "") texts.push(part.transcript);
    else if (typeof part.text === "string" && part.text.trim() !== "") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join(" ") : null;
}

/**
 * response.done 이벤트면 요약, 아니면 null.
 * `spokenFallback(itemId)` — response.done의 메시지 content에 전사가 없을 때 그 항목의 글자를 찾는 대체 조회(앱은 스크립트 리듀서가
 * `response.output_audio_transcript.*`로 모은 선생님 줄을 넘긴다). 둘 다 없으면 그 응답의 말한 글자는 모르는 것(null)이다.
 */
export function summarizeTalkResponseDone(
  event: unknown,
  spokenFallback?: (itemId: string) => string | null,
): TalkResponseDoneSummary | null {
  if (!isRec(event) || event.type !== "response.done" || !isRec(event.response)) return null;
  const resp = event.response;
  const output = Array.isArray(resp.output) ? resp.output : [];
  const messages = output.filter((it): it is Rec => isRec(it) && it.type === "message" && it.role === "assistant");
  const hadAudio = messages.length > 0;
  const texts: string[] = [];
  let unknown = false;
  for (const m of messages) {
    let t = spokenTextOfMessage(m);
    if (t === null && spokenFallback && typeof m.id === "string") t = spokenFallback(m.id);
    if (t === null) unknown = true;
    else texts.push(t);
  }
  const spokenText = unknown ? null : texts.join(" ");
  const askedQuestion = spokenText !== null && talkSpokeQuestion(spokenText);
  const functionCalls = extractTalkFunctionCalls(event);
  const status = typeof resp.status === "string" ? resp.status : null;
  return {
    responseId: typeof resp.id === "string" ? resp.id : null,
    status,
    hadAudio,
    spokenText,
    askedQuestion,
    functionCalls,
    shouldContinue: status === "completed" && functionCalls.length > 0 && spokenText !== null && !askedQuestion,
  };
}

/** 이어 말하기 판정 결과 — send면 앱이 호출 결과를 넣은 뒤 response.create를 보낸다. chain은 다음 연속 셈 */
export interface TalkContinueDecision {
  send: boolean;
  chain: number;
}

/**
 * response.done 뒤 이어 말하기를 보낼지(§12-6) — 순수 판정.
 * - 대화 중(`live`)이 아니면(마무리·끝내기 기다림) 보내지 않는다.
 * - `summary.shouldContinue`(도구 + 정상 완료 + 질문 없음)이고 연속 셈이 `TALK_CONTINUE_CHAIN_MAX` 아래면 보내고 셈 +1.
 * - 그 밖에는 보내지 않고 셈은 **그대로** — 선생님 소리가 있던 응답이어도 0으로 되돌리지 않는다(되돌림은 은우 발화만,
 *   `stepTalkContinue`).
 */
export function decideTalkContinue(chain: number, summary: TalkResponseDoneSummary, live: boolean): TalkContinueDecision {
  if (!live) return { send: false, chain };
  if (summary.shouldContinue && chain < TALK_CONTINUE_CHAIN_MAX) return { send: true, chain: chain + 1 };
  return { send: false, chain };
}

/**
 * 서버 이벤트 하나에 대한 이어 말하기 셈(§12-6) — 앱 컨트롤러가 이벤트마다 부르는 한 곳.
 * `input_audio_buffer.speech_started`(은우 발화) → 셈 0. `response.done` → `decideTalkContinue`. 그 밖 → 그대로.
 * `summary`는 response.done일 때만 채운다(앱이 사용량·호출 결과에 그대로 쓴다).
 */
export function stepTalkContinue(
  chain: number,
  event: unknown,
  live: boolean,
  spokenFallback?: (itemId: string) => string | null,
): TalkContinueDecision & { summary: TalkResponseDoneSummary | null } {
  if (isRec(event) && event.type === "input_audio_buffer.speech_started") return { send: false, chain: 0, summary: null };
  const summary = summarizeTalkResponseDone(event, spokenFallback);
  if (!summary) return { send: false, chain, summary: null };
  return { ...decideTalkContinue(chain, summary, live), summary };
}

/**
 * 호출 결과 글(§12-6 `{"shown":true}`). 검사에 떨어져 화면에 못 띄운 호출에도 같은 글을 보낸다 — shown:false를 받은 모델이 같은
 * 도구를 다시 부르며 응답을 되풀이할 수 있다(카드는 조용해서 대화에는 차이가 없다). 호출마다 한 번씩(§12-6).
 */
export const TALK_TOOL_OUTPUT = '{"shown":true}';

/**
 * 호출 결과 항목(§12-6) — `conversation.item.create {type:"function_call_output", call_id, output:'{"shown":true}'}`. id는 반드시 `app_`
 * 접두사(lib/talk-transcript.ts 리듀서가 줄로 만들지 않는다). 형식이 틀린 id면 던진다(개발 중에 바로 드러나게).
 */
export function buildTalkToolOutputEvent(callId: string, itemId: string): ConversationItemCreateEvent {
  if (!isTalkHiddenItemId(itemId)) {
    throw new Error(`[talk] 앱이 넣는 항목 id는 ${TALK_HIDDEN_ITEM_PREFIX}로 시작하는 형식이어야 합니다: ${itemId}`);
  }
  return {
    type: "conversation.item.create",
    item: { id: itemId, type: "function_call_output", call_id: callId, output: TALK_TOOL_OUTPUT },
  };
}

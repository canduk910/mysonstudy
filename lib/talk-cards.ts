/**
 * lib/talk-cards.ts — 자유대화 **화면 카드** 검사·기본 도움 문구·단어장 ✓ 매칭 (docs/harness/english.md §12-6·§12-7, SPEC §21-7)
 *
 * 2026-09-27(§12-7): 화면 카드는 음성 모델의 도구 호출이 아니라 **호출 J**(`POST /api/english/talk/cards` → lib/ai/client.ts
 * `generateTalkCards`)가 만든다 — 선생님 줄이 끝날 때마다 한 번. 카드는 조용하다(앱은 소리를 내지 않는다 — 마이크가 열려 있다).
 *
 * §12-7 호출 J(지금 쓰는 경로):
 * - `sanitizeTalkScreenCards(raw, ctx)` — 호출 J 후처리(순수). §12-6의 항목 단위 검사 규칙(이모지 그림 문자 필수·영어 칸 라틴·한글 금지·
 *   우리말 칸 한글)을 그대로 재사용해 **잘못된 항목만 버린다**. answers는 3개·단어 2~8개로 자르고, 그림 카드 `en`은 선생님 말(단어 경계·
 *   대소문자 무시·끝의 s·es 허용 — `isTalkPictureInLine`) 또는 오늘의 단어에 있어야 하며, 이미 보여 준 것이면 null.
 * - `TALK_CARDS_REQUEST_LIMITS` — 호출 J 입력 폭 한 곳(라우트 zod·조립 함수·앱이 같은 값을 본다).
 * - 앱 배선 도우미(순수): `buildTalkCardsRequest`(요청 본문 한 곳 — 폭에 맞춰 자른다)·`pickTalkCardsContext`(선생님 줄 앞 최근 4줄)·
 *   `pickTalkCardsShown`(보인 그림 카드 최근 12개)·`decideTalkCardsArrival`(도착한 카드를 쓸지 — 마무리·종료 중이면 둘 다 버림, 그 줄
 *   뒤에 은우가 이미 말을 시작했거나 새 줄이 생겼으면 도움만 버리고 그림 카드는 띄운다).
 * - `sanitizeTalkEmoji(raw)` — 이모지 칸 판정 한 곳(카드·도움 단어·단어장 스냅샷 `TalkTopicWord.emoji`가 모두 이 판정을 지난다).
 * - `sanitizeTalkCards(raw)` — 대화 기록에 남길 그림 카드 목록(저장 라우트, §12-6 — 호출 J 후처리와 다른 함수다).
 * - `TALK_FALLBACK_HINTS` — 받은 도움이 없을 때 보이는 기본 문구 4개(§12-6). 호출 J가 실패·시간 초과여도 이것.
 * - `matchTalkWord(cardEn, words)` — 단어장 모드 "오늘의 단어" ✓(대소문자 무시·끝의 s 허용).
 *
 * §12-6의 도구 호출 경로(`parseTalkToolCall`·이어 말하기 판정 `decideTalkContinue`/`stepTalkContinue`·연속 상한·호출 결과 항목)는
 * 2026-09-27 컨트롤러에서 걷어 내며 지웠다 — 세션에 도구가 없어 호출이 오지 않고, 앱이 response.create를 보내는 경우는 첫 인사·
 * 도움 요청·마무리 셋뿐이다(§12-7). 도구 검사의 항목 단위 규칙(이모지·영어 칸·우리말 칸)은 호출 J 후처리가 그대로 쓴다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈 lib/talk-transcript.ts(런타임 import 0)뿐. lib/ai·openai·zod는 `import type`만.
 * 정규식 lookbehind를 쓰지 않는다(iOS 16.3 이하 Safari는 번들을 읽다 멈춘다 — lib/talk-realtime.ts와 같은 규칙).
 */

import type { TalkCard, TalkSpeaker } from "./ai/english/talk-schemas";
import type { TalkCardsRequest } from "./talk-contract";
import type { TalkLine } from "./talk-transcript";

// ---------------------------------------------------------------------------
// 폭 — 한 곳에서 정의한다(호출 J 후처리·저장 상한·화면이 이 값을 본다)
// ---------------------------------------------------------------------------

/** 카드 검사 폭(§12-6 — 호출 J 후처리가 그대로 쓴다)과 카드 보관 수 */
export const TALK_CARD_LIMITS = {
  /** 도움 답 예시 — 1~3개(§12-6 문장의 폭. 호출 J는 0개면 도움 없음 — 화면은 기본 문구) */
  answersMin: 1,
  answersMax: 3,
  /** 답 예시 하나의 글자 상한 */
  answerMaxChars: 60,
  /** 도움 핵심 단어 — 0~3개 */
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

/**
 * 호출 J(§12-7) 답 예시 하나의 단어 수 — 2~8개(프롬프트의 2~6보다 넓게). 밖이면 그 답만 버린다("Yes!" 한 단어는 도움 카드의 본체가
 * 되기 어렵고 기본 문구가 이미 있다). 개수(3개)는 TALK_CARD_LIMITS.answersMax를 그대로 쓴다.
 */
export const TALK_SCREEN_ANSWER_WORDS = { min: 2, max: 8 } as const;

/**
 * 호출 J(§12-7) 입력 폭 — **한 곳**. 라우트 zod(`POST /api/english/talk/cards`)·조립 함수(buildTalkCardsUserMessage)·앱 도우미가
 * 같은 값을 본다. 스펙 문장의 개수(`{words}` 최대 20·`{shown}` 최근 12개·`{context}` 최근 4줄)와 eval이 맞춘다.
 */
export const TALK_CARDS_REQUEST_LIMITS = {
  /** 주제 라벨 글자 상한(단어장 이름이 길 수 있다) */
  topicLabelMaxChars: 200,
  /** 오늘의 단어 수 상한(책 순서 앞에서부터) — **정의처**. 저장 상한 TALK_LIMITS.vocabWords(선생님에게 넘기는 단어 수)가 이 값을 가리킨다 */
  words: 20,
  /** 단어·뜻 하나의 글자 상한 */
  wordMaxChars: 200,
  /** 이미 보여 준 그림 카드 수(최근 것) */
  shown: 12,
  /** 보여 준 그림 카드 영어 하나의 글자 상한 — 카드 영어 칸 폭 그대로(TALK_CARD_LIMITS.enMaxChars) */
  shownMaxChars: TALK_CARD_LIMITS.enMaxChars,
  /** 문맥 줄 수(선생님 줄 바로 앞의 최근 줄) */
  context: 4,
  /** 문맥 줄·선생님 말 하나의 글자 상한 — **정의처**. 저장 상한 TALK_LIMITS.turnChars(턴 하나의 글자)가 이 값을 가리킨다 */
  lineMaxChars: 1000,
} as const;

/** 도움 카드 내용(도움 상태 기계 `hints_received`) — answers는 늘 1개 이상이다(없으면 decideTalkCardsArrival이 null — 화면은 기본 문구) */
export interface TalkHints {
  answers: string[];
  words: TalkCard[];
}

/**
 * 호출 J(§12-7) 결과 — 모델 출력(zod 통과)과 후처리 결과가 같은 모양이다. 후처리 뒤에는 `answers` 0~3개(각 2~8단어),
 * `words` 0~3개(answers가 비면 []), `picture`는 근거가 있는 카드 한 장 또는 null. 라우트 200 본문도 이 모양이다.
 */
export interface TalkScreenCards {
  answers: string[];
  words: TalkCard[];
  picture: TalkCard | null;
}

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
 * 이모지 칸 하나 검사 — 정리(cleanValue) 뒤 1~16자(코드 포인트), 그림 문자(이모지·도형 기호 블록 — containsPictograph) 포함,
 * 라틴·한글 금지. 어긋나면 null. **판정은 이 함수 한 곳**이다: 카드(sanitizeTalkCard)와 단어장 스냅샷의 단어 이모지
 * (lib/talk-session-config.ts `buildTalkVocabWords`, 저장 라우트의 단어장 주제 재확인)가 같은 판정을 지난다.
 */
export function sanitizeTalkEmoji(raw: unknown): string | null {
  const L = TALK_CARD_LIMITS;
  const emoji = cleanValue(raw);
  if (emoji === null) return null;
  const emojiLen = countChars(emoji);
  if (emojiLen < L.emojiMinChars || emojiLen > L.emojiMaxChars) return null;
  if (!containsPictograph(emoji) || containsLatin(emoji) || containsHangulText(emoji)) return null;
  return emoji;
}

/**
 * 카드 한 장(show_picture 인자 · show_hints.words 항목 · 저장 요청의 cards 항목) 검사. 하나라도 어긋나면 null.
 * - emoji: sanitizeTalkEmoji(1~16자(코드 포인트), 그림 문자(이모지·도형 기호 블록 — containsPictograph) 포함, 라틴·한글 금지)
 * - en: 1~30자, 라틴 포함, 한글 금지
 * - ko: 1~20자, 한글 포함
 */
export function sanitizeTalkCard(raw: unknown): TalkCard | null {
  if (!isRec(raw)) return null;
  const L = TALK_CARD_LIMITS;
  const emoji = sanitizeTalkEmoji(raw.emoji);
  const en = cleanValue(raw.en);
  const ko = cleanValue(raw.ko);
  if (emoji === null || en === null || ko === null) return null;
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

/** 같은 영어(대소문자·공백 무시)는 한 번만 — 앞의 것이 이긴다 */
const dedupeKey = (en: string) => en.toLowerCase().replace(/\s+/g, " ");

/** 공백으로 나눈 단어 수 */
function countWordsOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * 답 예시 목록 정리(§12-6 규칙 — 호출 J가 재사용): 검사(sanitizeAnswer)를 통과한 것만, 같은 문장 되풀이는 하나로, 앞 answersMax(3)개.
 * `wordRange`를 주면 단어 수가 그 범위 밖인 답도 그 항목만 버린다(호출 J — 2~8단어). 배열이 아니면 [].
 */
function collectTalkAnswers(raw: unknown, wordRange: { min: number; max: number } | null): string[] {
  const answers: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (answers.length >= TALK_CARD_LIMITS.answersMax) break;
    const a = sanitizeAnswer(item);
    if (a === null) continue;
    if (wordRange) {
      const n = countWordsOf(a);
      if (n < wordRange.min || n > wordRange.max) continue;
    }
    const key = dedupeKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push(a);
  }
  return answers;
}

/** 핵심 단어 목록 정리(§12-6 규칙 — 호출 J가 재사용): 카드 검사(sanitizeTalkCard) 통과만, 같은 영어는 하나로, 앞 wordsMax(3)개 */
function collectTalkWords(raw: unknown): TalkCard[] {
  const words: TalkCard[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (words.length >= TALK_CARD_LIMITS.wordsMax) break;
    const w = sanitizeTalkCard(item);
    if (w === null) continue;
    const key = dedupeKey(w.en);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
  }
  return words;
}

// ---------------------------------------------------------------------------
// §12-7 호출 J — 후처리(근거 검사)·앱 배선 도우미
// ---------------------------------------------------------------------------

/** 정규식 글자 이스케이프 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 그림 카드 영어(cardEn)가 선생님 말(line)에 **단어 경계로** 있는가(§12-7) — 대소문자 무시, 끝의 s·es 허용(양쪽 방향: dog ↔ dogs,
 * box ↔ boxes), 카드 앞 관사(a/an/the)·앞뒤 문장부호는 무시, 여러 낱말(ice cream)은 공백 폭 무시. 끝의 y ↔ ies는 스펙 밖이라
 * 인정하지 않는다(보수적 — 근거를 못 찾은 그림 카드는 버려질 뿐이다). 소유격("the dog's ball")은 인정한다.
 * lookbehind 없이 앞 경계를 `(?:^|[^a-z0-9])`로 잰다(iOS 16.3 이하 Safari).
 */
export function isTalkPictureInLine(cardEn: string, line: string): boolean {
  const phrase = normalizeWordForMatch(typeof cardEn === "string" ? cardEn : "");
  if (phrase === "") return false;
  const parts = phrase.split(" ");
  const last = parts.pop() as string;
  const forms = new Set([last, `${last}s`, `${last}es`]);
  if (last.length > 2 && last.endsWith("s")) forms.add(last.slice(0, -1));
  if (last.length > 3 && last.endsWith("es")) forms.add(last.slice(0, -2));
  const head = parts.map(escapeRe).join("\\s+");
  const body = `${head ? `${head}\\s+` : ""}(?:${[...forms].map(escapeRe).join("|")})`;
  const text = (typeof line === "string" ? line : "").normalize("NFC").toLowerCase().replace(/[’‘ʼ]/g, "'");
  return new RegExp(`(?:^|[^a-z0-9])${body}(?![a-z0-9])`).test(text);
}

/** 호출 J 후처리의 근거 — 선생님이 방금 한 말·오늘의 단어(단어장 모드, 아니면 [])·이번 대화에서 이미 보여 준 그림 카드 영어 */
export interface TalkScreenCardsContext {
  teacherLine: string;
  words: readonly { en: string }[];
  shown: readonly string[];
}

/**
 * 호출 J 후처리(§12-7 — 순수 함수). zod는 타입·폭만 보고(재요청으로 카드를 늦추지 않게) **근거 검사는 여기서** 거른다.
 * §12-6의 항목 단위 검사 규칙을 그대로 재사용한다 — 잘못된 항목만 버린다.
 * - answers: 답 검사(1~60자·라틴 포함·한글 금지) + **2~8단어**, 같은 문장 되풀이는 하나로, 앞 3개.
 * - words: 카드 검사(이모지 그림 문자 필수·영어 칸 라틴·한글 금지·우리말 칸 한글), 같은 영어는 하나로, 앞 3개.
 *   **answers가 비면 words도 []** — 답 예시가 도움 카드의 본체다(§12-6 show_hints 규칙, 화면은 기본 문구).
 * - picture: 카드 검사 + `en`이 **선생님 말(isTalkPictureInLine) 또는 오늘의 단어(matchTalkWord)에 있어야** 하고, 이미 보여 준 카드와
 *   같은 단어(matchTalkWord — 대소문자·관사·복수 무시)면 null. 선생님 말에 없는 것을 그림 카드로 만들지 않는다(환각 차단).
 * raw가 객체가 아니면 빈 결과.
 */
export function sanitizeTalkScreenCards(raw: unknown, ctx: TalkScreenCardsContext): TalkScreenCards {
  if (!isRec(raw)) return { answers: [], words: [], picture: null };
  const answers = collectTalkAnswers(raw.answers, TALK_SCREEN_ANSWER_WORDS);
  const words = answers.length > 0 ? collectTalkWords(raw.words) : [];
  let picture = sanitizeTalkCard(raw.picture);
  if (picture) {
    const grounded = isTalkPictureInLine(picture.en, ctx.teacherLine) || matchTalkWord(picture.en, ctx.words) !== null;
    const alreadyShown = matchTalkWord(picture.en, ctx.shown.map((en) => ({ en }))) !== null;
    if (!grounded || alreadyShown) picture = null;
  }
  return { answers, words, picture };
}

/**
 * 호출 J `context` — 선생님 줄(teacherItemId) **앞의** 최근 줄 TALK_CARDS_REQUEST_LIMITS.context(4)개, `{speaker, text}`.
 * 글자 없는 줄(듣는 중·빈 전사·전사 실패)은 건너뛴다. 그 줄을 못 찾으면 [](앱은 이미 끝난 선생님 줄에만 부른다).
 */
export function pickTalkCardsContext(lines: readonly TalkLine[], teacherItemId: string): { speaker: TalkSpeaker; text: string }[] {
  const i = lines.findIndex((l) => l.itemId === teacherItemId);
  if (i < 0) return [];
  return lines
    .slice(0, i)
    .filter((l) => l.status !== "empty" && l.status !== "failed" && l.text.trim() !== "")
    .slice(-TALK_CARDS_REQUEST_LIMITS.context)
    .map((l) => ({ speaker: l.speaker, text: l.text.trim() }));
}

/** 호출 J `shown` — 이번 대화에서 띄운 그림 카드(보인 순서)의 영어, 최근 TALK_CARDS_REQUEST_LIMITS.shown(12)개(보인 순서 유지) */
export function pickTalkCardsShown(cards: readonly { en: string }[]): string[] {
  return cards.map((c) => c.en).slice(-TALK_CARDS_REQUEST_LIMITS.shown);
}

/** 주제 라벨이 비었을 때 요청에 싣는 값(라우트 zod가 빈 라벨을 거부한다 — 스냅샷 라벨은 늘 있지만 방어) */
const TALK_CARDS_TOPIC_FALLBACK = "자유대화";

/**
 * 문자열을 라우트 zod 폭(`.max(n)` — UTF-16 길이)에 맞춰 자른다. 서로게이트 쌍(이모지 등)을 반으로 가르지 않는다.
 * 앞뒤 공백은 걷는다.
 */
function clampTalkCardsText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trim();
}

/**
 * 호출 J 요청 본문(`POST /api/english/talk/cards` — lib/talk-contract.ts `TalkCardsRequest`)을 만든다(§12-7 앱 배선 — 순수 함수, 한 곳).
 * 라우트 zod는 폭을 넘으면 **거부**하므로(화면 버그를 드러내려고) 여기서 같은 폭(`TALK_CARDS_REQUEST_LIMITS`)으로 미리 자른다 —
 * 정상 경로에서는 400이 나지 않는다.
 * - teacherLine: 그 선생님 줄의 글자(앞뒤 공백 정리, 줄 글자 폭으로 자름). 줄을 못 찾거나 선생님 줄이 아니거나 글자가 비면 **null**
 *   (요청하지 않는다 — 호출 J 진입 함수도 빈 말에는 AI를 부르지 않는다).
 * - context: 그 줄 앞 최근 4줄(`pickTalkCardsContext`), 줄마다 폭으로 자름.
 * - shown: 보인 그림 카드 최근 12개(`pickTalkCardsShown`), 카드 영어 폭으로 자름·빈 값 건너뜀.
 * - words: 단어장 스냅샷 앞 20개(책 순서), 빈 단어 건너뜀, 단어·뜻 폭으로 자름(뜻이 비면 null).
 * - topic: 주제 라벨(비면 "자유대화"), 라벨 폭으로 자름.
 */
export function buildTalkCardsRequest(args: {
  topicLabel: string;
  words: readonly { en: string; ko: string | null }[];
  shownCards: readonly { en: string }[];
  lines: readonly TalkLine[];
  teacherItemId: string;
}): TalkCardsRequest | null {
  const R = TALK_CARDS_REQUEST_LIMITS;
  const line = args.lines.find((l) => l.itemId === args.teacherItemId);
  if (!line || line.speaker !== "teacher") return null;
  const teacherLine = clampTalkCardsText(line.text, R.lineMaxChars);
  if (teacherLine === "") return null;
  const topic = clampTalkCardsText(typeof args.topicLabel === "string" ? args.topicLabel : "", R.topicLabelMaxChars) || TALK_CARDS_TOPIC_FALLBACK;
  const words: TalkCardsRequest["words"] = [];
  for (const w of args.words) {
    if (words.length >= R.words) break;
    const en = clampTalkCardsText(typeof w?.en === "string" ? w.en : "", R.wordMaxChars);
    if (en === "") continue;
    const ko = typeof w.ko === "string" ? clampTalkCardsText(w.ko, R.wordMaxChars) : "";
    words.push({ en, ko: ko === "" ? null : ko });
  }
  const shown = pickTalkCardsShown(args.shownCards)
    .map((en) => clampTalkCardsText(typeof en === "string" ? en : "", R.shownMaxChars))
    .filter((en) => en !== "");
  const context = pickTalkCardsContext(args.lines, args.teacherItemId)
    .map((c) => ({ speaker: c.speaker, text: clampTalkCardsText(c.text, R.lineMaxChars) }))
    .filter((c) => c.text !== "");
  return { topic, words, shown, context, teacherLine };
}

/** 도착한 호출 J 결과 가운데 앱이 쓸 것 — hints는 도움 상태 기계에 `hints_received`로, picture는 그림 카드로 */
export interface TalkCardsArrival {
  hints: TalkHints | null;
  picture: TalkCard | null;
}

/**
 * 호출 J 결과가 도착했을 때 쓸지(§12-7 앱 배선 — 순수 판정).
 * - 대화 중(`live`)이 아니면(마무리·끝내기 기다림·종료) 둘 다 버린다 — 작별 인사 뒤에 카드를 띄우지 않는다.
 * - 요청한 선생님 줄(teacherItemId) **뒤에 줄이 이미 있으면**(은우가 말을 시작했다 — 듣는 중·빈 전사 포함, 또는 선생님의 새 줄) 도움은
 *   **철 지난 도움**이라 버리고 그림 카드는 띄운다. 그 줄을 못 찾아도 도움은 버린다(어느 질문의 도움인지 모른다).
 * - answers가 비었으면(질문 없는 말) 도움은 null — 화면은 기본 문구.
 */
export function decideTalkCardsArrival(args: {
  cards: TalkScreenCards;
  lines: readonly TalkLine[];
  teacherItemId: string;
  live: boolean;
}): TalkCardsArrival {
  if (!args.live) return { hints: null, picture: null };
  const i = args.lines.findIndex((l) => l.itemId === args.teacherItemId);
  const stale = i < 0 || i < args.lines.length - 1;
  const hints = stale || args.cards.answers.length === 0 ? null : { answers: [...args.cards.answers], words: [...args.cards.words] };
  return { hints, picture: args.cards.picture };
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

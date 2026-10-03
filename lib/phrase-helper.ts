/**
 * lib/phrase-helper.ts — 표현 도우미(한국어 → 가장 회화적인 표현 + 예문)의 **클라이언트 안전 순수 모듈**
 * (docs/harness/phrase-helper.md §1·§2·§8, SPEC §22)
 *
 * 세 영역이 같은 호출 하나를 모드로 나눠 쓴다 — `toeic`(아빠의 영어) · `japanese`(아빠의 일본어) · `english-kid`(은우 영어).
 * 이 파일이 담는 것(화면·라우트·진입 함수·eval이 **같은 값 하나**를 쓰게):
 * - 모드 목록·판별, 입력 상한, 입력 정리 `normalizePhraseHelperInput`(공백·제어문자·너비 0 문자 정리 + 길이 판정)
 * - 로컬 판정 `phraseHelperLocalResult` — 한글이 한 글자도 없는 입력은 AI를 부르지 않고 안내 문구로 끝낸다(비용 0)
 * - 결과 타입(진입 함수의 반환·라우트 200 본문의 모양), 일본어 말투 표시 이름, 🔊 언어
 * - 예문이 대표 표현을 담았는지 대략 재는 `phraseHelperExampleCoverage`(실호출 점검 **알림**용 — zod 강제 아님, §6)
 *
 * ⚠️ 런타임 import 0 — lib/ai·store·openai·zod를 끌어오지 않는다(eval "번들 경계"가 잠근다). 정규식 lookbehind 금지(구형 iOS Safari).
 */

// ---------------------------------------------------------------------------
// 모드
// ---------------------------------------------------------------------------

/** 표현 도우미 모드 — toeic(아빠의 영어) · japanese(아빠의 일본어) · english-kid(은우 영어). 순서는 문서 표 순서 */
export const PHRASE_HELPER_MODES = ["toeic", "japanese", "english-kid"] as const;
export type PhraseHelperMode = (typeof PHRASE_HELPER_MODES)[number];

export function isPhraseHelperMode(v: unknown): v is PhraseHelperMode {
  return typeof v === "string" && (PHRASE_HELPER_MODES as readonly string[]).includes(v);
}

/** 영어로 답하는 모드(같은 JSON Schema `phrase_helper_en`) */
export type PhraseHelperEnMode = Exclude<PhraseHelperMode, "japanese">;

/** 결과 표현·예문을 읽을 🔊 언어(lib/speech.ts의 언어 인자) */
export function phraseHelperSpeechLang(mode: PhraseHelperMode): "en-US" | "ja-JP" {
  return mode === "japanese" ? "ja-JP" : "en-US";
}

// ---------------------------------------------------------------------------
// 입력 정리 (§2)
// ---------------------------------------------------------------------------

/** 입력 글자 상한(정리 뒤, 코드 포인트 수). 넘으면 자르지 않고 거부한다 — 자른 문장은 사용자가 하지 않은 말이다 */
export const PHRASE_HELPER_INPUT_MAX = 200;

export type PhraseHelperInputReason = "not_text" | "empty" | "too_long";

export type PhraseHelperInputVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: PhraseHelperInputReason; messageKo: string };

/** 입력 거부 안내(화면·라우트 400 문구) */
export const PHRASE_HELPER_INPUT_MESSAGES_KO: Readonly<Record<PhraseHelperInputReason, string>> = {
  not_text: "글자를 넣어 주세요.",
  empty: "단어나 문장을 넣어 주세요.",
  too_long: `${PHRASE_HELPER_INPUT_MAX}자까지 넣을 수 있어요.`,
};

/** 너비 0 문자·BOM·방향 표시 — 보이지 않는데 모델 입력과 길이를 바꾼다 */
const INVISIBLE_RE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/** C0·DEL·C1 제어문자(줄바꿈·탭 포함) — 공백 하나로 바꾼다 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** 코드 포인트 수(이모지·확장 한자 한 글자 = 1) */
export function phraseHelperCharCount(text: string): number {
  return [...text].length;
}

/**
 * 입력 정리 — 순서: 문자열 아님 거부 → NFC → 보이지 않는 문자 삭제 → 제어문자(줄바꿈·탭 포함)를 공백으로 → 연속 공백 하나로 → 앞뒤 공백 제거
 * → 빈 값 거부 → 상한 초과 거부. 결과 `text`가 모델에 가는 글이다(라우트·진입 함수가 같은 함수를 부른다).
 */
export function normalizePhraseHelperInput(raw: unknown): PhraseHelperInputVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "not_text", messageKo: PHRASE_HELPER_INPUT_MESSAGES_KO.not_text };
  const text = raw
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return { ok: false, reason: "empty", messageKo: PHRASE_HELPER_INPUT_MESSAGES_KO.empty };
  if (phraseHelperCharCount(text) > PHRASE_HELPER_INPUT_MAX) {
    return { ok: false, reason: "too_long", messageKo: PHRASE_HELPER_INPUT_MESSAGES_KO.too_long };
  }
  return { ok: true, text };
}

/** 한글(완성형 음절·자모·호환 자모)이 한 글자라도 있는가 */
export function phraseHelperHasHangul(text: string): boolean {
  return /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(text);
}

// ---------------------------------------------------------------------------
// 결과 타입 (§8 — 진입 함수 반환 = 라우트 200 본문의 결과 칸)
// ---------------------------------------------------------------------------

/** ok = 바꿔 줌 · not_korean = 한국어가 아님 · out_of_scope = 바꿔 줄 말이 아님(뜻 없음·다른 일 요청·해로움) */
export const PHRASE_HELPER_STATUSES = ["ok", "not_korean", "out_of_scope"] as const;
export type PhraseHelperStatus = (typeof PHRASE_HELPER_STATUSES)[number];

/** 일본어 말투 — casual(반말) · polite(정중체 です・ます) · formal(존경어·겸양어) · neutral(단어라 말투 없음) */
export const PHRASE_HELPER_JA_REGISTERS = ["casual", "polite", "formal", "neutral"] as const;
export type PhraseHelperJaRegister = (typeof PHRASE_HELPER_JA_REGISTERS)[number];

/** 말투 표시 이름(화면) */
export const PHRASE_HELPER_JA_REGISTER_LABELS_KO: Readonly<Record<PhraseHelperJaRegister, string>> = {
  casual: "반말",
  polite: "정중체",
  formal: "존경·겸양",
  neutral: "말투 무관",
};

export interface PhraseHelperEnMain {
  expression: string;
  usageKo: string;
}
export interface PhraseHelperEnAlternative {
  expression: string;
  noteKo: string;
}
export interface PhraseHelperEnExample {
  en: string;
  ko: string;
}

export interface PhraseHelperJaMain {
  expression: string;
  reading: string;
  register: PhraseHelperJaRegister;
  usageKo: string;
}
export interface PhraseHelperJaAlternative {
  expression: string;
  reading: string;
  register: PhraseHelperJaRegister;
  noteKo: string;
}
export interface PhraseHelperJaExample {
  ja: string;
  reading: string;
  ko: string;
}

/** 모델이 낸 모양(JSON Schema `phrase_helper_en`) */
export interface PhraseHelperEnOutput {
  status: PhraseHelperStatus;
  noteKo: string | null;
  main: PhraseHelperEnMain | null;
  alternatives: PhraseHelperEnAlternative[];
  examples: PhraseHelperEnExample[];
}

/** 모델이 낸 모양(JSON Schema `phrase_helper_ja`) */
export interface PhraseHelperJaOutput {
  status: PhraseHelperStatus;
  noteKo: string | null;
  main: PhraseHelperJaMain | null;
  alternatives: PhraseHelperJaAlternative[];
  examples: PhraseHelperJaExample[];
}

interface PhraseHelperResultMeta {
  /** 정리한 입력(모델에 간 글) */
  input: string;
  /** ai = 모델이 답함 · local = 한글이 없어 AI 없이 안내만(비용 0) */
  source: "ai" | "local";
  /** 실제로 쓴 모델(local이면 null) */
  model: string | null;
}

export type PhraseHelperEnResult = PhraseHelperEnOutput & PhraseHelperResultMeta & { mode: PhraseHelperEnMode };
export type PhraseHelperJaResult = PhraseHelperJaOutput & PhraseHelperResultMeta & { mode: "japanese" };
export type PhraseHelperResult = PhraseHelperEnResult | PhraseHelperJaResult;

// ---------------------------------------------------------------------------
// 로컬 판정 — 한글이 없으면 AI를 부르지 않는다 (§2-2)
// ---------------------------------------------------------------------------

/** 한글이 없는 입력에 보이는 안내(모드별). 스펙 §2-2 표와 글자까지 같다(eval이 대조) */
export const PHRASE_HELPER_LOCAL_NOTES_KO: Readonly<Record<PhraseHelperMode, string>> = {
  toeic: "한국어 단어나 문장을 넣어 주세요. 영어 표현으로 바꿔 드려요.",
  japanese: "한국어 단어나 문장을 넣어 주세요. 일본어 표현으로 바꿔 드려요.",
  "english-kid": "한글로 적어 줘요. 그러면 영어로 바꿔 줄게요!",
};

/**
 * 정리한 입력에 한글이 한 글자도 없으면 AI 없이 `not_korean` 결과를 만든다(비용 0). 한글이 있으면 null — 모델에 보낸다.
 * (한글이 섞인 입력 "회의 reschedule" · 자모만 "ㅋㅋ"는 모델이 판정한다 — 앞은 ok, 뒤는 out_of_scope가 보통이다.)
 */
export function phraseHelperLocalResult(mode: PhraseHelperMode, text: string): PhraseHelperResult | null {
  if (phraseHelperHasHangul(text)) return null;
  const base = { status: "not_korean" as const, noteKo: PHRASE_HELPER_LOCAL_NOTES_KO[mode], main: null, alternatives: [], examples: [], input: text, source: "local" as const, model: null };
  // 모드로 결과 갈래를 고른다(일본어 / 영어 두 모드) — 빈 결과라 칸 모양은 같다
  return mode === "japanese" ? { ...base, mode } : { ...base, mode };
}

// ---------------------------------------------------------------------------
// 예문 포함 알림 (§6 — zod로 강제하지 않는다, 실호출 점검이 비율만 찍는다)
// ---------------------------------------------------------------------------

function enWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

/** 영어: 대표 표현의 단어열이 예문 안에 그대로 있거나, 세 글자 이상 단어가 모두 앞 네 글자로 예문 단어와 맞으면(활용형) 담은 것으로 본다 */
function enExampleHas(expression: string, example: string): boolean {
  const e = enWords(expression);
  const x = enWords(example);
  if (e.length === 0) return false;
  for (let i = 0; i + e.length <= x.length; i++) if (e.every((w, j) => x[i + j] === w)) return true;
  const content = e.filter((w) => w.length >= 3);
  if (content.length === 0) return false;
  return content.every((w) => x.some((y) => y.slice(0, Math.min(4, w.length)) === w.slice(0, Math.min(4, w.length))));
}

/** 일본어: 공백·문장부호를 걷고 대표 표현이 예문에 있거나, 끝 두 글자(활용 어미)를 뗀 앞부분이 있으면 담은 것으로 본다 */
function jaExampleHas(expression: string, example: string): boolean {
  const strip = (s: string) => s.replace(/[\s、。！？!?「」『』・,.]/g, "");
  const e = strip(expression);
  const x = strip(example);
  if (e === "") return false;
  if (x.includes(e)) return true;
  const stem = [...e].slice(0, Math.max(1, [...e].length - 2)).join("");
  return x.includes(stem);
}

/** 예문 몇 개가 대표 표현을 담았나(대략 — 알림용). ok가 아니면 {0, 0} */
export function phraseHelperExampleCoverage(result: PhraseHelperResult): { covered: number; total: number } {
  if (result.main === null) return { covered: 0, total: 0 };
  if (result.mode === "japanese") {
    const expr = result.main.expression;
    return { covered: result.examples.filter((x) => jaExampleHas(expr, x.ja)).length, total: result.examples.length };
  }
  const expr = result.main.expression;
  return { covered: result.examples.filter((x) => enExampleHas(expr, x.en)).length, total: result.examples.length };
}

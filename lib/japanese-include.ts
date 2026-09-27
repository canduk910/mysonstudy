/**
 * lib/japanese-include.ts — 일본어 단어장 "꼭 넣을 단어" 한 줄 판별 **순수 함수** (docs/harness/japanese.md §2-2·§8)
 *
 * 꼭 넣을 단어는 줄마다 **일본어 표기** 또는 **한국어 뜻** 중 하나다(2026-09-27, §0-2). 한 줄 안에 두 문자를 섞으면
 * 어느 쪽도 아니다(거부). 이 판정을 라우트 검증(400)·배분 계획(`planIncludeDistribution`)·zod(`fromKo` 대조)·
 * 만들기 화면(줄 칩)이 **같은 함수로** 하게 여기 한 곳에만 둔다 — 규칙이 두 벌 생기면 화면이 받은 줄을 라우트가
 * 거부하거나, 라우트가 받은 한국어 줄을 계획이 일본어로 오인하는 구멍이 난다.
 *
 * ⚠️ 클라이언트 번들 안전: import 0. lib/ai/*를 import하지 않는다(`lib/toeic-text.ts`와 같은 자리).
 * `lib/ai/japanese/schemas.ts`가 이 파일의 값을 import·재수출한다(반대 방향 import 금지 — zod가 번들에 샌다).
 */

/** 꼭 넣을 단어 한 줄의 길이 상한 (§2-2 "1~20자") — 일본어 줄·한국어 줄 공용 단일 정의. schemas.ts가 재수출한다. */
export const JA_INCLUDE_WORD_MAX = 20;

/** 일본어 줄 — 히라가나·가타카나·한자(CJK 통합) + 반복부호 々〆·장음 ー만. 공백·라틴·숫자·한글 없음. */
export const JA_INCLUDE_JA_PATTERN = /^[぀-ヿ一-鿿々〆ー]+$/;

/** 한국어 줄 — 한글 음절과 낱말 사이 공백 한 칸만(정규화 뒤). 일본 문자·라틴·숫자·자모 단독 없음. */
export const JA_INCLUDE_KO_PATTERN = /^[가-힣]+(?: [가-힣]+)*$/;

export type JaIncludeLang = "ja" | "ko";

/** 일본어 줄 정규화 — NFKC(반각 가나 → 전각) + 앞뒤 공백 제거. 안쪽 공백은 남겨 두어 판정에서 거부된다. */
export function normalizeJaIncludeLine(s: string): string {
  return s.normalize("NFKC").trim();
}

/** 한국어 줄 정규화 — NFKC + 앞뒤 공백 제거 + 안쪽 연속 공백을 한 칸으로. 프롬프트·fromKo 대조·보고가 이 값을 쓴다. */
export function normalizeKoInclude(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** 일본어 표기 줄인가 (정규화 후 1~20자, 일본 문자만). */
export function isJapaneseIncludeLine(s: string): boolean {
  const n = normalizeJaIncludeLine(s);
  return n.length >= 1 && n.length <= JA_INCLUDE_WORD_MAX && JA_INCLUDE_JA_PATTERN.test(n);
}

/** 한국어 뜻 줄인가 (정규화 후 1~20자, 한글 음절+낱말 사이 공백만). */
export function isKoreanIncludeLine(s: string): boolean {
  const n = normalizeKoInclude(s);
  return n.length >= 1 && n.length <= JA_INCLUDE_WORD_MAX && JA_INCLUDE_KO_PATTERN.test(n);
}

/**
 * 한 줄을 판별한다 — "ja"(일본어 표기) · "ko"(한국어 뜻) · null(섞임·라틴·숫자·빈 줄·20자 초과 → 거부).
 * 두 패턴은 겹치지 않는다(한글 ↔ 일본 문자) — 그래서 판정 순서가 결과를 바꾸지 않는다.
 * 거부 **이유**(문구용)는 아래 `jaIncludeRejectReason`이 고른다.
 */
export function classifyJaIncludeLine(s: string): JaIncludeLang | null {
  if (isJapaneseIncludeLine(s)) return "ja";
  if (isKoreanIncludeLine(s)) return "ko";
  return null;
}

// ---------------------------------------------------------------------------
// 거부 이유 — **문구만** 가른다(판정은 위 classifyJaIncludeLine 그대로). 2026-09-27 QA 3회차 P3-D.
// ---------------------------------------------------------------------------

/**
 * 거부된 줄의 이유. 라우트 400 `issues[].message`와 만들기 화면 칩이 **같은 함수**로 고른다(두 벌이면 문구가 갈린다).
 * - `empty`    공백만 있는 줄
 * - `listed`   여러 단어를 한 줄에 이어 쓴 줄 → "한 줄에 하나씩"
 * - `too_long` 정규화 뒤 20자 초과
 * - `mixed`    그 밖 — 일본 문자와 한글이 섞였거나 라틴·숫자·기호가 들었다
 */
export type JaIncludeRejectReason = "empty" | "listed" | "too_long" | "mixed";

/** 나열 구분자(NFKC 뒤 값) — 공백·쉼표·、·쌍반점·빗금. 전각 ，；／와 반각 ､는 NFKC가 , ; / 、로 바꾼다. */
const LIST_HARD_SEP = /[\s,、;/]/u;
/**
 * 가운뎃점류 — ·(U+00B7, 한국어 자판)·・(U+30FB)·ㆍ(U+318D 천지인 — NFKC가 U+119E로 바꾼다)·•·∙·⋅.
 * ・는 일본어 줄 안에서는 표기의 일부라(約束・水는 일본어 한 줄로 통과) **이미 거부된 줄**을 나눌 때만 구분자로 본다.
 */
const LIST_DOT_SEP = /[·・ㆍᆞ•∙⋅]/u;
const LIST_ANY_SEP = /[\s,、;/·・ㆍᆞ•∙⋅]+/u;
/** 가타카나만(장음 ー 포함) — 가운뎃점으로 이은 외래어 복합어(ボール·ペン)를 나열과 가르는 데 쓴다. */
const KATAKANA_ONLY = /^[゠-ヿ]+$/u;

/**
 * 여러 단어를 한 줄에 이어 쓴 줄인가 — 이미 거부된 줄이고, 나열 구분자로 나눈 조각이 2개 이상이며, 조각마다 **따로는
 * 받아들여지는** 줄이고, 조각이 모두 **같은 언어**일 때만 참이다(여권, 비자 · 約束 水 · 約束、水 · 여권·비자).
 * - 언어가 섞인 조각(約束 약속, 여권 パスポート)은 단어와 번역을 나란히 쓴 것에 가까워 나열로 보지 않는다(→ mixed).
 * - 가운뎃점으로**만** 이은 가타카나(ボール·ペン)는 외래어 복합어를 한국어 자판 가운뎃점으로 쓴 것으로 보인다 —
 *   줄을 나누면 뜻이 바뀌므로 나열로 보지 않는다(→ mixed "기호는 빼 주세요" — ボールペン·ボール・ペン은 통과한다).
 */
function isListedLine(s: string): boolean {
  const n = s.normalize("NFKC").trim();
  const parts = n.split(LIST_ANY_SEP).filter((p) => p !== "");
  // 결합 부호로 시작하는 조각은 낱말이 아니다 — か゛(U+309B)는 NFKC가 "か + 공백 + 결합 탁점"으로 바꿔 공백에서 나뉜다
  if (parts.length < 2 || parts.some((p) => /^\p{M}/u.test(p))) return false;
  const langs = parts.map(classifyJaIncludeLine);
  const first = langs[0];
  if (first === null || langs.some((l) => l !== first)) return false;
  const dotOnly = !LIST_HARD_SEP.test(n) && LIST_DOT_SEP.test(n);
  if (dotOnly && first === "ja" && parts.every((p) => KATAKANA_ONLY.test(p))) return false;
  return true;
}

/**
 * 한 줄의 거부 이유 — 받아들여지는 줄이면 null. `jaIncludeRejectReason(s) === null` ⇔ `classifyJaIncludeLine(s) !== null`
 * (판정은 바꾸지 않는다). `listed`를 `too_long`보다 먼저 본다 — 20자를 넘는 나열 줄은 줄을 나누면 풀리므로 그 안내가 맞다.
 */
export function jaIncludeRejectReason(s: string): JaIncludeRejectReason | null {
  if (classifyJaIncludeLine(s) !== null) return null;
  if (s.trim() === "") return "empty";
  if (isListedLine(s)) return "listed";
  if (normalizeKoInclude(s).length > JA_INCLUDE_WORD_MAX) return "too_long";
  return "mixed";
}

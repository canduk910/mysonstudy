/**
 * lib/toeic-text.ts — 아빠의 영어(토익스피킹) 문자열 판정·정리 **순수 함수** (docs/harness/toeic.md §2-4·§3-4·§4-9·§5-3)
 *
 * zod(lib/ai/toeic/schemas.ts)·후처리(lib/ai/toeic/*.ts)·클라이언트 순수 함수(lib/toeic-*.ts)가 같은 판정을 쓰게
 * 여기 한 곳에만 둔다. "라틴 포함"·"한글 금지"·"단어 수" 규칙이 두 벌 생기면 zod가 받은 것을 화면이 거부하는 구멍이 난다.
 *
 * ⚠️ 클라이언트 번들 안전: import 0. lib/ai/*를 import하지 않는다.
 */

/** 라틴 문자(영문) — "영어 필드는 라틴 포함"(§2-4·§4-9) */
const LATIN_RE = /[A-Za-z]/;
/** 한글(완성형 + 자모 + 호환 자모) — "한글 금지 / 한글 포함" */
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힣]/;

export function hasLatin(s: string): boolean {
  return LATIN_RE.test(s);
}

export function hasHangul(s: string): boolean {
  return HANGUL_RE.test(s);
}

/** 연속 공백(줄바꿈·탭 포함)을 하나로 접고 앞뒤를 자른다 — §2-4 후처리 1(공백 정리)·§4-9 chunks 대조의 단일 정의 */
export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 대소문자·연속 공백 무시 비교 키 — §4-9 usedExpressions 대조, §6-1 보기 중복 판정 */
export function matchKey(s: string): string {
  return collapseSpaces(s).toLowerCase();
}

/**
 * 영어 단어 수 — 공백으로 가른 덩어리 수. 하이픈으로 이은 말(`well-known`)은 한 단어다.
 * 프롬프트의 "6~32단어"·zod의 폭(§4-9)이 모두 이 함수로 센다.
 */
export function countWords(s: string): number {
  const t = s.trim();
  if (t === "") return 0;
  return t.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// 세트 안 표현 중복 (§2-4·§7-1·§7-6) — 항목 키가 곧 표현이라(§6-1) 한 세트에 같은 표현이 둘이면 숙련도가 섞인다
// ---------------------------------------------------------------------------

/**
 * 표현 동일성 키 — 대소문자·연속 공백(앞뒤 포함) 무시. "Hand out  flyers"와 "hand out flyers"는 같은 표현이다.
 * 세트 안 중복 판정·5지선다 보기 중복 제거가 이 한 함수를 쓴다.
 */
export function expressionKey(s: string): string {
  return matchKey(s);
}

/**
 * 세트 안에서 **앞 항목과 같은 표현**(expressionKey 기준)인 항목의 위치들 — 첫 등장은 빼고 두 번째부터(오름차순).
 * 빈 표현은 세지 않는다(빈 값은 다른 규칙이 거부한다). 가져오기 zod(lib/ai/toeic/schemas.ts)와 저장 라우트가 같이 쓴다.
 */
export function findDuplicateExpressionIndexes(entries: readonly { expression: string }[]): number[] {
  const seen = new Set<string>();
  const dup: number[] = [];
  entries.forEach((e, i) => {
    const k = expressionKey(e.expression);
    if (k === "") return;
    if (seen.has(k)) dup.push(i);
    else seen.add(k);
  });
  return dup;
}

/** 세트 안 중복 표현 오류 문구(저장·가져오기 공통 — 값은 넣지 않는다) */
export const TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO = "같은 표현이 이 세트에 이미 있어요(대소문자·띄어쓰기만 달라도 같은 표현) — 하나만 남겨 주세요";

// ---------------------------------------------------------------------------
// 문장부호 무시 단어열 대조 (§5-3 said ⊂ 전사문)
// ---------------------------------------------------------------------------

/**
 * 대조용 단어열 — 소문자, 문자·숫자·아포스트로피 밖의 글자(문장부호·하이픈·기호)는 공백, 둥근 아포스트로피는 `'`로,
 * 단어 앞뒤에 붙은 아포스트로피(따옴표로 쓴 것)는 뗀다. 단어 안 아포스트로피는 남긴다(`don't` ≠ `dont`).
 * ⚠️ lookbehind 없음 — 클라이언트 번들(결과 화면 하이라이트)에서도 쓴다.
 */
export function looseWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w !== "");
}

/**
 * `needle`의 단어열이 `haystack` 단어열 안에 **연속으로, 같은 순서로** 있는가(단어 경계 — 단어 조각은 일치로 보지 않는다).
 * 대소문자·연속 공백·문장부호는 무시하고 단어 순서는 그대로 본다: 쉼표 하나 빠진 인용은 통과, 순서를 바꾸거나 사이 단어를
 * 뺀 이어 붙이기는 거부(§5-3 환각 가드). 단어가 하나도 없으면 false.
 */
export function containsWordSequence(haystack: string, needle: string): boolean {
  const n = looseWords(needle);
  if (n.length === 0) return false;
  const h = looseWords(haystack);
  for (let i = 0; i + n.length <= h.length; i++) {
    let j = 0;
    while (j < n.length && h[i + j] === n[j]) j++;
    if (j === n.length) return true;
  }
  return false;
}

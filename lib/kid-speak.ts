/**
 * lib/kid-speak.ts — 은우 단어장 "그림 보고 말하기" 순수 함수 + 상수 (2026-10-03, SPEC §15-5, docs/harness/english.md §14)
 *
 * 번역을 거치지 않는 떠올리기: 이모지(크게) + 영영 정의만 보여 주고 한국어 뜻은 숨긴다 → 은우가 영어 단어를 **말한다** →
 * 전사(관문 W, lib/kid-speak-transcribe.ts)한 글자를 여기 `judgeKidSpeech`가 정답과 대조한다 → 틀리면 단계적 도움
 * (첫 글자 → 글자 수 밑줄 → 정답 공개 + 🔊). 마이크가 없으면 "스스로 확인"(정답 보기 → 😀🤔😢).
 *
 * ⚠️ 런타임 import 0 — 화면(클라이언트)·서버 페이지·eval이 같은 함수를 부른다(lib/vocab-quiz.ts 관용구). `window` 미사용.
 * 정규식 lookbehind 금지(구형 iOS Safari).
 *
 * ── 판정의 관대함 — 근거 (2026-10-03 QA review_1 P3-D로 좁힘) ─────────────────
 * 전사 모델은 아이 발음을 **실제 영어 단어로** 적는다(없는 철자를 지어내기보다 가까운 진짜 단어를 고른다). 그래서 관대함은
 * "전사가 같은 말을 다르게 적는 경우"만 받고, "다른 진짜 단어"는 받지 않는 쪽으로 정했다(맞다고 해 주면 잘못 배운다).
 * - 정규화: 대소문자·구두점·하이픈은 버린다("Apple!" = apple, "ice-cream" = "ice cream"). **숫자는 영단어로**(전사가 "6"으로 적는다 —
 *   0~20·30~90·100·1000, 양쪽 모두 같은 표로 바꾼다).
 * - 덧말: 정답 밖의 낱말은 **기능어·군말 목록**(it's·is·this·that·a·an·the·my·um·uh·I think … — `KID_SPEAK_FUNCTION_WORDS`)만 허용,
 *   최대 4낱말. 다른 **내용어**가 하나라도 섞이면 늘어놓아 찍은 것("cat dog apple") → `"list"`("한 단어만 말해 볼까요?", 저장은 틀림).
 *   정답 낱말을 되풀이한 것("apple, apple!")은 괜찮다.
 * - 복수형: **정답 4글자 이상**에서 `s`, `es`(s·x·z·ch·sh·o 뒤에서만), `y→ies`, 그리고 불규칙 복수 표(mice·children·feet·teeth·men·women …).
 *   다른 글자가 끼면 안 된다(car ← cares·hi ← his·us ← uses는 정답 아님). 불규칙 표는 길이와 무관(man ← men).
 * - **한 글자 바꿈 = 정답은 정답 6글자 이상·같은 길이·첫 글자 같음일 때만**(넣기·빼기 없음). 넣기·빼기는 다른 진짜 단어를 받는다
 *   (planet ← plane, banana ← bandana), 첫 글자 바꿈도 그렇다(button ← mutton). 짧은 낱말(≤ 5)은 한 글자 차이가 대개 다른 단어(cat/cap,
 *   bear/pear, horse/house) — 허용 0. 3글자 이하는 복수형도 허용 0.
 * - 정답은 아니지만 가까우면(이웃 글자 자리 바꿈 포함 거리 ≤ 1, 정답 6글자 이상은 ≤ 2) **"close"** — 저장은 틀림과 같고(도움 단계도 오른다)
 *   화면 문구만 "거의 다 왔어요!"로 다정하게. "appel"(자리 바꿈)·"colour"/"color"(넣기)는 여기다.
 * - 정답의 괄호 부분은 있어도 없어도 된다("(be) interested in"), 빗금은 어느 쪽이든("color/colour").
 * 이 경계는 `scripts/eval-english.ts`(그림 보고 말하기 묶음)가 표로 잠근다.
 */

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 저장 모드(lib/vocab-quiz.ts VOCAB_QUIZ_MODES의 한 값) — 다른 모드와 숙련도를 섞지 않는다(VOCAB_SEPARATE_MASTERY_MODES) */
export const KID_SPEAK_MODE = "picture-speak" as const;

/** 한 판 단어 수 상한 — 1학년이 한 번에 말하기 좋은 길이(DAY 단어는 30~40개라 다 내면 지친다). 약한 단어부터 고른다 */
export const KID_SPEAK_SESSION_MAX = 10;

/** 정답 밖에 허용하는 기능어·군말 낱말 수 상한("I think it's an apple" → i·think·its = 3) */
export const KID_SPEAK_EXTRA_WORDS = 4;

/** 한 글자 바꿈을 **정답으로** 쳐 주기 시작하는 정답 낱말 길이(글자) — 같은 길이·첫 글자 같음일 때만 */
export const KID_SPEAK_FUZZY_MIN_LEN = 6;
/** 복수형 허용을 시작하는 정답 낱말 길이 — 3글자 이하(car·hi·us)는 허용 0(불규칙 표는 예외) */
export const KID_SPEAK_PLURAL_MIN_LEN = 4;
/** "거의 다 왔어요"(close)로 볼 거리(이웃 자리 바꿈 포함) — 정답 전체(띄어쓰기 뺀 글자) 길이가 6 이상이면 2, 3~5면 1, 3글자 미만은 close 없음 */
export function kidSpeakCloseDistance(answerLen: number): number {
  if (answerLen >= KID_SPEAK_FUZZY_MIN_LEN) return 2;
  if (answerLen >= 3) return 1;
  return 0;
}

/** 도움 단계 — 0 없음 · 1 첫 글자 · 2 글자 수 밑줄 · 3 정답 공개(🔊). 틀리게 말하거나 💡를 누를 때마다 한 단계씩 */
export const KID_SPEAK_REVEAL_STEP = 3;

/** 관사 — 정답 쪽에서도 뺀다(정답이 관사뿐이면 그대로) */
const ARTICLES: readonly string[] = ["a", "an", "the"];
/**
 * 정답 밖에 와도 되는 낱말 — 관사·군말·지시어·"it's"·"is it"·"I think"·소유격. 이 목록 밖의 낱말이 정답 밖에 있으면 "list".
 * 정규화 뒤 모양(아포스트로피 삭제: it's → its, that's → thats, I'm → im).
 */
export const KID_SPEAK_FUNCTION_WORDS: readonly string[] = [
  ...ARTICLES,
  "um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "ah", "eh", "oh", "ooh", "uhhuh",
  "it", "its", "is", "this", "thats", "that", "these", "those", "theyre", "they", "are", "there", "here", "heres", "theres",
  "my", "your", "i", "im", "think", "guess", "maybe", "so", "okay", "ok", "well", "like", "answer", "word",
];

/** 숫자 → 영단어(전사가 숫자로 적는다). 양쪽에 같은 표를 쓴다 */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
  "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen",
  "18": "eighteen", "19": "nineteen", "20": "twenty", "30": "thirty", "40": "forty", "50": "fifty", "60": "sixty", "70": "seventy",
  "80": "eighty", "90": "ninety", "100": "hundred", "1000": "thousand",
};

/** 불규칙 복수 → 단수(정답 단수와 같게 — 양쪽 어느 쪽이 복수여도) */
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  mice: "mouse", children: "child", feet: "foot", teeth: "tooth", men: "man", women: "woman", geese: "goose", people: "person",
  oxen: "ox", knives: "knife", leaves: "leaf", wolves: "wolf", wives: "wife", lives: "life", halves: "half", shelves: "shelf",
  loaves: "loaf", calves: "calf", elves: "elf", fish: "fish", sheep: "sheep", deer: "deer",
};

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

/** 말한 글·정답을 낱말 배열로 — 소문자·NFKC·아포스트로피 제거·영숫자 밖은 띄어쓰기·숫자는 영단어로 */
export function kidSpeakTokens(text: string): string[] {
  const raw = typeof text === "string" ? text : "";
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ']/g, "") // don't = dont (아포스트로피는 낱말 안에서 지운다)
    .replace(/(\d),(\d)/g, "$1$2") // 1,000 = 1000
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "")
    .map((t) => NUMBER_WORDS[t] ?? t);
}

/**
 * 정답 표기 → 비교할 변형들(낱말 배열). 빗금은 어느 쪽이든, 괄호 부분은 넣은 것·뺀 것 둘 다.
 * 예: "(be) interested in" → [["be","interested","in"], ["interested","in"]] · "color/colour" → [["color"], ["colour"]]
 */
export function kidSpeakAnswerVariants(answer: string): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = kidSpeakTokens(s);
    const key = t.join(" ");
    if (t.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  const parts = String(answer ?? "").split("/");
  for (const part of parts) {
    push(part.replace(/[()]/g, " ")); // 괄호 안을 넣은 것
    push(part.replace(/\([^)]*\)/g, " ")); // 괄호 안을 뺀 것
  }
  return out;
}

/** 레벤슈타인 거리(짧은 낱말용 — 상한을 넘으면 일찍 끝낸다). `transpose`면 이웃 글자 자리 바꿈도 1로 센다(OSA) */
export function kidSpeakEditDistance(a: string, b: string, cap = 3, transpose = false): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      let v = Math.min(rows[i - 1][j] + 1, cur[j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (transpose && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    rows.push(cur);
  }
  return rows[a.length][b.length];
}

/** 규칙 복수형 — base에서 plural이 정확히 s·es(s·x·z·ch·sh·o 뒤)·y→ies로만 만들어지는가 */
function isRegularPlural(base: string, plural: string): boolean {
  if (plural === `${base}s`) return true;
  if (plural === `${base}es`) return /(s|x|z|ch|sh|o)$/.test(base);
  if (base.length > 1 && base.endsWith("y") && plural === `${base.slice(0, -1)}ies`) return !/[aeiou]y$/.test(base);
  return false;
}

/** 복수형 허용 — 불규칙 표(길이 무관) · 정답 4글자 이상의 규칙 복수(양쪽) */
function pluralEquivalent(spoken: string, answer: string): boolean {
  const irrS = IRREGULAR_PLURALS[spoken];
  const irrA = IRREGULAR_PLURALS[answer];
  if ((irrS && irrS === answer) || (irrA && irrA === spoken)) return true;
  if (answer.length < KID_SPEAK_PLURAL_MIN_LEN) return false;
  return isRegularPlural(answer, spoken) || isRegularPlural(spoken, answer);
}

/** 낱말 하나가 정답 낱말과 같은가 — 같음 · 복수형 · (정답 6글자 이상) 같은 길이·첫 글자 같은 한 글자 바꿈 */
export function kidSpeakTokenMatches(spoken: string, answer: string): boolean {
  if (spoken === answer) return true;
  if (pluralEquivalent(spoken, answer)) return true;
  if (answer.length >= KID_SPEAK_FUZZY_MIN_LEN && spoken.length === answer.length && spoken[0] === answer[0]) {
    let diff = 0;
    for (let i = 0; i < answer.length; i += 1) if (spoken[i] !== answer[i]) diff += 1;
    return diff === 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

/** correct 정답 · close 거의(저장은 틀림) · list 여러 낱말을 늘어놓음(저장은 틀림) · wrong 틀림 · empty 낱말 없음(단계 그대로) */
export type KidSpeakVerdict = "correct" | "close" | "list" | "wrong" | "empty";

export interface KidSpeakJudgement {
  verdict: KidSpeakVerdict;
  /** 화면에 보일 "이렇게 들렸어요" — 앞뒤 공백만 걷고 40자로 자른 전사문(빈 글이면 "") */
  heard: string;
}

/** 화면 표시 상한(글자) — 긴 전사(엉뚱한 문장)가 화면을 밀지 않게 */
export const KID_SPEAK_HEARD_MAX_CHARS = 40;

/**
 * 전사문이 정답을 말한 것인가. 순수·결정적. 근거는 머리 주석.
 * 1. 기능어·군말을 빼고 남은 "내용어"가 0이면 "empty"(도움 단계를 올리지 않는다).
 * 2. 정답 변형과 맞는 구간이 있고, 그 밖의 낱말이 전부 기능어(≤ 4)이거나 정답 낱말의 되풀이면 "correct".
 * 3. 맞는 구간이 있어도, 또는 없더라도 내용어가 정답 낱말 수보다 많으면 "list".
 * 4. 남은 내용어가 정답과 가까우면(kidSpeakCloseDistance, 이웃 자리 바꿈 포함) "close", 그 밖은 "wrong".
 */
export function judgeKidSpeech(transcript: string, answer: string): KidSpeakJudgement {
  const heardRaw = typeof transcript === "string" ? transcript.trim() : "";
  const heardChars = [...heardRaw];
  const heard = heardChars.length > KID_SPEAK_HEARD_MAX_CHARS ? `${heardChars.slice(0, KID_SPEAK_HEARD_MAX_CHARS).join("")}…` : heardRaw;

  // 정답 변형 — 관사는 양쪽에서 뺀다(정답이 관사뿐이면 그대로)
  const variants = kidSpeakAnswerVariants(answer).map((v) => {
    const noArt = v.filter((t) => !ARTICLES.includes(t));
    return noArt.length > 0 ? noArt : v;
  });
  if (variants.length === 0) return { verdict: "wrong", heard };
  const spokenAll = kidSpeakTokens(heardRaw);

  let sawList = false;
  let close = false;
  let anyContent = false;
  for (const v of variants) {
    const inAnswer = new Set(v);
    const isFn = (t: string) => !inAnswer.has(t) && KID_SPEAK_FUNCTION_WORDS.includes(t);
    const content = spokenAll.filter((t) => !isFn(t));
    if (content.length === 0) continue;
    anyContent = true;
    const fnCount = spokenAll.length - content.length;
    const vJoined = v.join("");

    // 붙여 쓴 것·띄어 쓴 것(ice cream / icecream) — 내용어를 통째로 붙여 같으면
    if (content.join("") === vJoined && fnCount <= KID_SPEAK_EXTRA_WORDS) return { verdict: "correct", heard };

    for (let start = 0; start + v.length <= content.length; start += 1) {
      const win = content.slice(start, start + v.length);
      if (!win.every((t, k) => kidSpeakTokenMatches(t, v[k]))) continue;
      // 구간 밖 내용어는 정답 낱말의 되풀이만 허용("apple, apple!")
      const rest = [...content.slice(0, start), ...content.slice(start + v.length)];
      const restOk = rest.every((t) => v.some((a) => kidSpeakTokenMatches(t, a)));
      if (restOk && fnCount <= KID_SPEAK_EXTRA_WORDS) return { verdict: "correct", heard };
      sawList = true;
    }
    if (content.length > v.length) {
      sawList = true;
      continue;
    }
    const closeCap = kidSpeakCloseDistance(vJoined.length);
    if (!close && closeCap > 0 && kidSpeakEditDistance(content.join(""), vJoined, closeCap, true) <= closeCap) close = true;
  }
  if (!anyContent) return { verdict: "empty", heard };
  if (sawList) return { verdict: "list", heard };
  return { verdict: close ? "close" : "wrong", heard };
}

// ---------------------------------------------------------------------------
// 도움 — 첫 글자 → 글자 수 밑줄 → 정답
// ---------------------------------------------------------------------------

export interface KidSpeakHintCell {
  /** 보일 글자(가린 칸은 "_") */
  ch: string;
  /** 글자 칸인가(띄어쓰기·기호 칸은 false — 밑줄을 긋지 않는다) */
  letter: boolean;
}

/**
 * 도움 단계별로 보일 것. step 0 → null(도움 없음).
 * - step 1: 첫 글자만 — `{ first: "a", cells: null }` (화면: "a로 시작해요")
 * - step 2: 글자 수 밑줄 — 각 낱말의 첫 글자만 보이고 나머지 글자는 "_"(띄어쓰기·하이픈·아포스트로피는 그대로)
 * - step ≥ 3: 정답 전부 — 모든 칸이 보인다
 * 정답 표기는 저장값 그대로 쓴다(괄호·빗금 포함 — 아이가 보는 건 단어장에 적힌 모양).
 */
export function kidSpeakHint(answer: string, step: number): { first: string; cells: KidSpeakHintCell[] | null } | null {
  const word = String(answer ?? "").trim();
  if (step <= 0 || word === "") return null;
  const chars = [...word];
  const firstIdx = chars.findIndex((c) => /[A-Za-z0-9]/.test(c));
  const first = firstIdx >= 0 ? chars[firstIdx].toLowerCase() : chars[0];
  if (step === 1) return { first, cells: null };
  const reveal = step >= KID_SPEAK_REVEAL_STEP;
  const cells: KidSpeakHintCell[] = [];
  let atWordStart = true;
  for (const c of chars) {
    const isLetter = /[A-Za-z0-9]/.test(c);
    if (!isLetter) {
      cells.push({ ch: c, letter: false });
      atWordStart = c === " " || c === "/" || c === "(" || c === ")";
      continue;
    }
    cells.push({ ch: reveal || atWordStart ? c : "_", letter: true });
    atWordStart = false;
  }
  return { first, cells };
}

// ---------------------------------------------------------------------------
// 문항 결과 → 저장 문항(VocabQuizItem의 correct·answered)
// ---------------------------------------------------------------------------

/**
 * 한 단어의 끝난 모양.
 * - `said`       : 도움 없이 말해 냈다
 * - `said-hint`  : 첫 글자·밑줄 도움을 받고 말해 냈다 — 회상 단서(cue)를 받은 떠올리기도 떠올리기다(정답 공개와 다르다)
 * - `revealed`   : 정답 공개(도움 3단계)까지 갔다 — 떠올리지 못했다
 * - `self-good`  : 스스로 확인 😀 "말했어요"
 * - `self-unsure`: 스스로 확인 🤔 "헷갈렸어요" — 졸업을 늦추는 쪽(틀림)으로 센다
 * - `self-miss`  : 스스로 확인 😢 "몰랐어요"
 * - `unanswered` : 그만하기로 못 푼 단어
 */
export type KidSpeakOutcome = "said" | "said-hint" | "revealed" | "self-good" | "self-unsure" | "self-miss" | "unanswered";

/** 저장 문항의 correct·answered — VocabQuizItem 3상태 규약(맞힘 true/true · 틀림 true/false · 미응답 null/false) 그대로 */
export function kidSpeakItemResult(outcome: KidSpeakOutcome): { correct: boolean; answered: boolean | null } {
  switch (outcome) {
    case "said":
    case "said-hint":
    case "self-good":
      return { correct: true, answered: true };
    case "revealed":
    case "self-unsure":
    case "self-miss":
      return { correct: false, answered: true };
    default:
      return { correct: false, answered: null };
  }
}

// ---------------------------------------------------------------------------
// 단어 고르기 — 약한 단어부터 KID_SPEAK_SESSION_MAX개
// ---------------------------------------------------------------------------

/** 그림 보고 말하기에 낼 단어 하나 — 영영 정의가 있는 단어만(정의가 곧 단서) */
export interface KidSpeakPoolItem {
  word: string;
  definitionEn: string;
  /** 이모지(없으면 null — 화면은 그림 칸 없이 정의만 보인다. 첫 글자 배지는 쓰지 않는다: 답의 첫 글자를 미리 알려 준다) */
  emoji: string | null;
}

/** 그림 보고 말하기 모드만의 단어 통계(lib/vocab-mastery WordStat과 같은 모양 — 구조적 최소 타입) */
export interface KidSpeakStatLike {
  total: number;
  wrong: number;
  streak: number;
}

/** 졸업 문턱 — lib/vocab-mastery MASTERY_STREAK와 같은 값(eval이 두 값을 대조한다 — 런타임 import 0을 지키려고 값을 옮겨 둔다) */
export const KID_SPEAK_MASTERY_STREAK = 2;

/**
 * 약함 순위 — 틀렸고 미졸업(0) → 안 해 봄(1) → 해 봤고 틀린 적 없음·미졸업(2) → 졸업(3).
 * 토익 `weaknessRank`(lib/toeic-quiz.ts)와 같은 순서다 — 과목 경계(은우 모듈이 토익 모듈을 import하지 않는다) 때문에 옮겨 두고
 * eval이 모든 통계 모양에서 두 함수가 같은 값을 내는지 대조한다.
 */
export function kidSpeakRank(stat: KidSpeakStatLike | undefined): number {
  if (!stat || stat.total === 0) return 1;
  if (stat.streak >= KID_SPEAK_MASTERY_STREAK) return 3;
  return stat.wrong > 0 ? 0 : 2;
}

/**
 * 한 판에 낼 단어를 고른다 — 셔플 → 약함 순위 → 오답 많은 순 → 앞에서 max개. rng 주입(테스트 결정성).
 * 같은 단어(표기 기준)는 한 번만.
 */
export function pickKidSpeakWords(
  pool: readonly KidSpeakPoolItem[],
  stats: Readonly<Record<string, KidSpeakStatLike>>,
  options: { max?: number; rng?: () => number } = {},
): KidSpeakPoolItem[] {
  const max = options.max ?? KID_SPEAK_SESSION_MAX;
  const rng = options.rng ?? Math.random;
  const seen = new Set<string>();
  const uniq = pool.filter((p) => {
    if (seen.has(p.word)) return false;
    seen.add(p.word);
    return true;
  });
  const a = [...uniq];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a
    .map((p, order) => ({ p, order, st: stats[p.word] }))
    .sort((x, y) => kidSpeakRank(x.st) - kidSpeakRank(y.st) || (y.st?.wrong ?? 0) - (x.st?.wrong ?? 0) || x.order - y.order)
    .slice(0, Math.max(0, max))
    .map((x) => x.p);
}

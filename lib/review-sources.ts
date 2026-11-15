/**
 * lib/review-sources.ts — 오늘의 복습 **항목 출처 어댑터**(순수 함수, docs/SPEC.md §23-5)
 *
 * 각 영역의 기존 저장 모양(단어장·시험 기록·한자·표현집·틀 은행·틀 말하기)을 읽어 복습 카드(단서·힌트1·힌트2·정답·발음)와
 * 시험 기록 요약(답한 수·틀린 수·마지막 시험 시각)을 만든다. **시험 본 항목만** 낸다 — 큐 엔진(lib/review-schedule)이 일정과 합친다.
 *
 * 입력은 **구조적 최소 타입**이라 store·ai에 의존하지 않는다(eval이 지어낸 데이터로 부른다). 서버 등록부(lib/review-server.ts
 * `REVIEW_SOURCES`)가 store에서 읽어 여기로 넘긴다. **새 출처** = 어댑터 함수 하나 + 엔진 종류 한 줄 + 등록부 한 줄.
 *
 * 힌트 사다리(§23-2) — 영역별로 자연스럽게:
 * - 은우 단어(en-word): 단서 = 이모지 + 영영 정의(**한국어 뜻은 싣지 않는다** — 정답 공개 때 정답과 함께) · 힌트1 = 첫 글자 · 힌트2 = 첫 글자 + 글자 수 밑줄(`a____`)
 * - 일본어 단어(ja-word): 단서 = 한국어 뜻(+ 이모지) · 힌트1 = 읽기 첫 글자 · 힌트2 = 읽기 뼈대(`た○○`)
 * - 한자(ja-kanji): 단서 = 뜻 + 한국 한자음 · 힌트1 = 읽기 첫 글자 · 힌트2 = 음독·훈독
 * - 토익 표현(toeic-expr): 단서 = 한국어 뜻(+ 예문 해석) · 힌트1 = 첫 글자 · 힌트2 = 낱말마다 첫 글자 + 밑줄(`~` 자리는 그대로)
 * - 토익 틀(toeic-template): 단서 = 한국어 틀(+ 쓰임) · 힌트1 = 첫 낱말 · 힌트2 = 틀의 `~` 자리만 보이고 고정 부분은 첫 글자 + 밑줄
 * - 토익 답변 섬(toeic-island): 단서 = 한국어 단서·메모(없으면 소재 + 틀) · 힌트1 = 첫 낱말 · 힌트2 = 쓰인 틀 고정 부분만 보이는 뼈대
 *   (틀을 못 찾으면 낱말 수 밑줄). **시험 기록이 아니라 "담음"이 입장 조건** — 담은 다음 날이 첫 복습일.
 * - 은우 단어(en-word)의 시험 기록은 **모든 모드**를 합친다(그림 보고 말하기 `picture-speak` 포함 — 같은 단어를 두 번 복습하지 않게 새 종류를 두지 않는다).
 *
 * 단서에 정답 글자가 그대로 들어 있으면(영영 정의 속 표제어 등) 밑줄로 가린다 — 단서가 곧 정답이 되지 않게.
 *
 * - 엄마 문장(mom-sentence): 단서 = 한국어 뜻(+ 틀) · 힌트1 = 첫 글자 · 힌트2 = 첫 덩어리 + " …". **레슨에서 결과가 난 말하기 문장만**
 *   (넘어감 포함) — 첫 복습일 = 그 문장이 든 레슨을 처음 끝낸 날(KST) + 1(섬과 같은 "담은 다음 날부터").
 *
 * - 🗓️ 오늘의 일본어 N5 단어(ja-n5-word): ja-word와 같은 사다리(단서 = 한국어 뜻 · 힌트1 = 읽기 첫 글자 · 힌트2 = 읽기 뼈대).
 *   **회차에서 답한 단어만** — 첫 복습일 = 그 단어를 처음 답한 끝낸 회차(KST) + 1(DAY 앞 절반·뒤 절반이 이틀에 나뉘어 들어온다).
 *   통계 = 회차 기록의 vocabAnswers(뜻·읽기 모드 합산 — 같은 단어 한 항목). 일본어 단어장의 ja-word와는 키가 달라 따로 센다.
 *
 * - 은우 오늘의 복습 화면은 힌트 사다리 대신 **5지선다 문제 맞히기**다(§23-11) — 카드는 위와 같고, 보기·순서는 `buildEnglishReviewQuiz`가 붙인다.
 *
 * ⚠️ 서버·eval에서만 부른다(카드는 서버가 만들어 props로 내린다). 런타임 import: ./review-schedule·./toeic-text·./toeic-template·./kst·./mom-content·./vocab-quiz·./review-quiz.
 */

import { reviewItemKey, type ReviewKind, type ReviewQueueCandidate } from "./review-schedule";
import { buildChoices } from "./vocab-quiz";
import { REVIEW_QUIZ_CHOICE_COUNT, REVIEW_QUIZ_MIN_CHOICES, type ReviewQuizQuestion } from "./review-quiz";
import { expressionKey } from "./toeic-text";
import { frameToExpression, templateRunSpans } from "./toeic-template";
import { kstDateString, shiftDateString } from "./kst";
import type { TtsLang } from "./tts-shared";
import { isSpeakRole, type MomRole } from "./mom-content";

// ---------------------------------------------------------------------------
// 카드 모양 — 화면(lib/review-contract.ts가 type 재수출)이 그대로 그린다
// ---------------------------------------------------------------------------

/** 루비 조각(일본어 정답 표기 — components/ja-ruby가 그린다) */
export interface ReviewRubyToken {
  surface: string;
  reading: string | null;
}

export interface ReviewCard {
  itemKey: string;
  kind: ReviewKind;
  /** 단서 — 정답을 떠올리게 하는 쪽 */
  cue: {
    emoji: string | null;
    main: string;
    sub: string | null;
    /** main의 언어(글꼴·읽기 방향 판단용) */
    lang: "ko" | "en" | "ja";
  };
  /** 힌트1 — 첫 글자(틀은 첫 낱말) */
  hint1: string;
  /** 힌트2 — 뼈대 */
  hint2: string;
  /** 힌트2 옆 짧은 설명(글자 수 등). 없으면 null */
  hint2Note: string | null;
  answer: {
    main: string;
    sub: string | null;
    /** 일본어 단어면 후리가나 조각, 아니면 null */
    ruby: ReviewRubyToken[] | null;
  };
  /** 정답 공개 뒤 🔊(탭할 때만) — 없으면 null */
  speak: { text: string; lang: TtsLang } | null;
  /** 어디서 온 항목인가(단어장 제목 등) — 작게 보인다 */
  sourceKo: string;
}

/** 어댑터 산출 = 카드 + 시험 기록 요약 */
export interface ReviewSourceItem {
  card: ReviewCard;
  stats: Omit<ReviewQueueCandidate, "itemKey">;
}

// ---------------------------------------------------------------------------
// 힌트 재료 — 순수 문자열 함수
// ---------------------------------------------------------------------------

const LATIN_LETTER = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

/** 첫 라틴 글자(없으면 첫 글자) */
export function firstLetterHint(text: string): string {
  const t = text.trim();
  for (const ch of t) if (LATIN_LETTER.test(ch)) return ch;
  return t.slice(0, 1);
}

/**
 * 영어 뼈대 — 낱말마다 첫 글자만 남기고 나머지 글자는 `_`. 공백·`~`·구두점·숫자는 그대로(낱말 경계를 보인다).
 * 예: `hand out flyers` → `h___ o__ f_____`, `I'd like to ~` → `I'_ l___ t_ ~`.
 */
export function latinSkeleton(text: string): string {
  let out = "";
  let inWord = false;
  for (const ch of text.trim().replace(/\s+/g, " ")) {
    if (LATIN_LETTER.test(ch)) {
      out += inWord ? "_" : ch;
      inWord = true;
    } else {
      out += ch;
      // 낱말 안 아포스트로피·하이픈은 낱말을 끊지 않는다(I'd · well-known)
      inWord = inWord && (ch === "'" || ch === "’" || ch === "-");
    }
  }
  return out;
}

/** 라틴 글자 수 */
export function latinLetterCount(text: string): number {
  let n = 0;
  for (const ch of text) if (LATIN_LETTER.test(ch)) n += 1;
  return n;
}

/** 가나 뼈대 — 첫 글자 + 나머지는 ○(작은 가나·장음도 한 칸) */
export function kanaSkeleton(kana: string): string {
  const chars = [...kana.trim()];
  if (chars.length === 0) return "";
  return chars[0] + "○".repeat(chars.length - 1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 흔한 불규칙 굴절(동사 과거·과거분사, 명사 복수, 비교급) — 단서 가리기 전용 소수 목록 */
const IRREGULAR_FORMS: Readonly<Record<string, readonly string[]>> = {
  be: ["am", "is", "are", "was", "were", "been", "being"], have: ["has", "had"], do: ["does", "did", "done"], go: ["goes", "went", "gone"],
  run: ["ran"], eat: ["ate", "eaten"], see: ["saw", "seen"], come: ["came"], make: ["made"], take: ["took", "taken"], give: ["gave", "given"],
  swim: ["swam", "swum"], sing: ["sang", "sung"], drink: ["drank", "drunk"], write: ["wrote", "written"], fly: ["flew", "flown"],
  buy: ["bought"], bring: ["brought"], think: ["thought"], catch: ["caught"], teach: ["taught"], sleep: ["slept"], feel: ["felt"],
  keep: ["kept"], sit: ["sat"], get: ["got", "gotten"], begin: ["began", "begun"], break: ["broke", "broken"], choose: ["chose", "chosen"],
  draw: ["drew", "drawn"], drive: ["drove", "driven"], fall: ["fell", "fallen"], find: ["found"], forget: ["forgot", "forgotten"],
  grow: ["grew", "grown"], hide: ["hid", "hidden"], hold: ["held"], know: ["knew", "known"], leave: ["left"], lose: ["lost"],
  meet: ["met"], ride: ["rode", "ridden"], ring: ["rang", "rung"], rise: ["rose", "risen"], say: ["said"], sell: ["sold"], send: ["sent"],
  speak: ["spoke", "spoken"], stand: ["stood"], steal: ["stole", "stolen"], tell: ["told"], throw: ["threw", "thrown"], wake: ["woke", "woken"],
  wear: ["wore", "worn"], win: ["won"], blow: ["blew", "blown"], dig: ["dug"], feed: ["fed"], fight: ["fought"], hear: ["heard"], lead: ["led"],
  child: ["children"], mouse: ["mice"], foot: ["feet"], tooth: ["teeth"], man: ["men"], woman: ["women"], goose: ["geese"], person: ["people"],
  good: ["better", "best"], bad: ["worse", "worst"],
};

const VOWEL = /[aeiou]/;

/**
 * 한 낱말의 흔한 굴절형(소문자, 자기 자신 포함) — 규칙 굴절(-s/-es/-ed/-ing/-er/-est, y→i, e 탈락, 끝 자음 겹침, f→ves) + 불규칙 소수.
 * 표시 단계의 가리기 전용이다(정의 zod는 손대지 않는다 — QA common_review_1 C). 과하게 넓혀 다른 낱말을 가려도 단서가 덜 보일 뿐 답이 새지는 않는다.
 */
export function englishInflections(word: string): string[] {
  const w = word.trim().toLowerCase();
  if (!/^[a-z]+$/.test(w)) return w === "" ? [] : [w];
  const out = new Set<string>([w, w + "s", w + "es", w + "ed", w + "ing", w + "er", w + "est"]);
  const last = w[w.length - 1];
  const prev = w.length >= 2 ? w[w.length - 2] : "";
  if (last === "y" && prev && !VOWEL.test(prev)) {
    const st = w.slice(0, -1);
    for (const suf of ["ies", "ied", "ier", "iest"]) out.add(st + suf);
  }
  if (last === "e") {
    const st = w.slice(0, -1);
    for (const f of [w + "d", w + "r", w + "st", st + "ing"]) out.add(f);
  }
  if (w.length >= 3 && !VOWEL.test(last) && !"wxy".includes(last) && VOWEL.test(prev) && !VOWEL.test(w[w.length - 3])) {
    for (const suf of ["ed", "ing", "er", "est"]) out.add(w + last + suf);
  }
  if (last === "f") out.add(w.slice(0, -1) + "ves");
  if (w.endsWith("fe")) out.add(w.slice(0, -2) + "ves");
  for (const f of IRREGULAR_FORMS[w] ?? []) out.add(f);
  return [...out];
}

/**
 * 단서 속 정답 가리기 — 대소문자 무시, 낱말 경계(앞뒤가 라틴 글자가 아닐 때만)로 `answer`와 그 굴절형(한 낱말이면 englishInflections)을
 * 밑줄로 바꾼다. 긴 형태부터 맞춘다(running이 run+ning으로 반만 가려지지 않게). lookbehind를 쓰지 않는다(구형 iOS Safari).
 */
export function maskAnswerInCue(cue: string, answer: string): string {
  const a = answer.trim();
  if (a === "" || cue === "") return cue;
  const forms = (/\s/.test(a) ? [a] : englishInflections(a)).sort((x, y) => y.length - x.length);
  const re = new RegExp(forms.map(escapeRe).join("|"), "gi");
  let out = "";
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cue)) !== null) {
    const at = m.index;
    const end = at + m[0].length;
    const before = at > 0 ? cue[at - 1] : "";
    const after = end < cue.length ? cue[end] : "";
    if ((before && LATIN_LETTER.test(before)) || (after && LATIN_LETTER.test(after))) {
      re.lastIndex = at + 1;
      continue;
    }
    out += cue.slice(from, at) + "_".repeat(Math.max(3, m[0].length));
    from = end;
  }
  return out + cue.slice(from);
}

/** 틀 자리 `{이름}` → `[이름]`(단서·정답 표시용) */
export function frameForDisplay(frame: string): string {
  return frame.replace(/\{([^{}]*)\}/g, (_m, name: string) => `[${name.trim()}]`);
}

/** 발음용 — `~`·대괄호 자리를 지우고 공백을 접는다 */
function cleanForSpeech(s: string): string {
  return s.replace(/[~〜]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 시험 기록 요약 — "답한 문항"만 센다(스트릭·숙련도와 같은 기준)
// ---------------------------------------------------------------------------

export interface QuizSessionLike {
  startedAt: string;
  items: readonly { word: string; correct: boolean; answered: boolean | null }[];
}

type Stats = ReviewSourceItem["stats"];

/** 세션들 → 키별 {답한 수, 틀린 수, 마지막 시험 시각}. keyOf가 null이면 그 문항은 이 출처가 아니다 */
export function aggregateReviewStats(sessions: readonly QuizSessionLike[], keyOf: (word: string) => string | null): Map<string, Stats> {
  const out = new Map<string, Stats>();
  for (const s of sessions) {
    for (const it of s.items) {
      if (it.answered !== true) continue;
      const k = keyOf(it.word);
      if (k === null || k === "") continue;
      const cur = out.get(k) ?? { attempts: 0, wrongCount: 0, lastTestedAt: null };
      cur.attempts += 1;
      if (!it.correct) cur.wrongCount += 1;
      if (cur.lastTestedAt === null || s.startedAt > cur.lastTestedAt) cur.lastTestedAt = s.startedAt;
      out.set(k, cur);
    }
  }
  return out;
}

function byCreatedDesc<T extends { createdAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// 은우 단어장 단어 (en-word)
// ---------------------------------------------------------------------------

export interface EnVocabBookLike {
  id: string;
  titleKo: string;
  createdAt: string;
  entries: readonly {
    word: string;
    meanings: readonly { ko: string }[];
    definitionEn: string | null;
    imageEmoji: string | null;
  }[];
}

export function enWordKey(word: string): string {
  return word.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 은우 단어장 — 같은 단어(대소문자 무시)는 한 항목(가장 최근 단어장의 뜻으로). 시험에서 답한 단어만 */
export function englishWordItems(books: readonly EnVocabBookLike[], quizzes: readonly QuizSessionLike[]): ReviewSourceItem[] {
  const stats = aggregateReviewStats(quizzes, enWordKey);
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const b of byCreatedDesc(books)) {
    for (const e of b.entries) {
      const word = e.word.trim();
      const k = enWordKey(word);
      if (k === "" || seen.has(k)) continue;
      const st = stats.get(k);
      if (!st) continue;
      seen.add(k);
      const ko = e.meanings.map((m) => m.ko.trim()).filter(Boolean).slice(0, 2).join(" · ");
      const def = e.definitionEn?.trim() || null;
      // 단서에는 한국어 뜻을 싣지 않는다(번역 없이 그림·영어 정의로 떠올리기 — 그림 보고 말하기와 같은 원리, QA common_review_1 P2-A 결정).
      // 한국어 뜻은 정답 공개 데이터(answer.sub)에만. 정의도 이모지도 없으면 번역 없이 떠올릴 단서가 없어 큐에 들이지 않는다.
      if (!def && !e.imageEmoji) continue;
      const main = def ? maskAnswerInCue(def, word) : "그림을 보고 영어로 떠올려 봐요";
      out.push({
        card: {
          itemKey: reviewItemKey("en-word", k),
          kind: "en-word",
          cue: { emoji: e.imageEmoji, main, sub: null, lang: def ? "en" : "ko" },
          hint1: firstLetterHint(word),
          hint2: latinSkeleton(word),
          hint2Note: `${latinLetterCount(word)}글자`,
          answer: { main: word, sub: ko || null, ruby: null },
          speak: { text: word, lang: "en-US" },
          sourceKo: b.titleKo,
        },
        stats: st,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 은우 오늘의 복습 — 문제 맞히기(5지선다) 보기·순서 (SPEC §23-11). 일본어·토익 카드에는 손대지 않는다
// ---------------------------------------------------------------------------

/** 32비트 FNV-1a — 결정적 시드 */
function quizHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — 시드 고정 [0,1) 생성기(같은 날 같은 항목이면 같은 보기·같은 순서) */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface EnglishReviewQuizBuild {
  /** 문항(순서 = 오늘 날짜로 섞은 고정 순서) */
  questions: ReviewQuizQuestion[];
  /** 보기를 2개 이상 만들 수 없어 뺀 카드 수(단어장 전체에 다른 단어가 없을 때) */
  skipped: number;
}

/** 관련어 최소 shape(VocabRelated가 구조적으로 만족) — 같은 뜻 오답 거르기에 유의어만 본다 */
interface EnQuizRelatedLike {
  kind: string;
  word: string;
}

/**
 * 보기 만들기가 읽는 단어장 — EnVocabBookLike에 관련어(선택)를 더한 것. 저장 레코드(VocabBookRecord)가 구조적으로 만족한다.
 * englishWordItems의 입력 모양은 바꾸지 않는다(다른 카드 불변).
 */
export interface EnQuizBookLike {
  id: string;
  titleKo: string;
  createdAt: string;
  entries: readonly {
    word: string;
    meanings: readonly { ko: string; related?: readonly EnQuizRelatedLike[] }[];
    definitionEn: string | null;
    imageEmoji: string | null;
    related?: readonly EnQuizRelatedLike[];
  }[];
}

/** 은우 문제 맞히기 밑줄 — 글자 수와 무관한 고정 길이(밑줄 길이로 보기를 좁히지 못하게, QA english_review-quiz_1 P3-B) */
export const KID_QUIZ_MASK = "____";

/** 파생 접미사(가리기 전용 — 넓게 가려도 단서가 덜 보일 뿐 답이 새지 않는다) */
const KID_DERIVATION_SUFFIXES = ["ness", "ly", "ful", "less", "ment", "able", "ish", "ily", "iness", "ier", "iest", "y"];

/** 한 낱말의 굴절형 + 흔한 파생형(happy → happiness·happily, care → careful·careless) — 소문자 */
export function kidWordForms(word: string): string[] {
  const w = word.trim().toLowerCase();
  const out = new Set(englishInflections(w));
  if (!/^[a-z]+$/.test(w)) return [...out];
  const stems = new Set([w]);
  const last = w[w.length - 1];
  const prev = w.length >= 2 ? w[w.length - 2] : "";
  if (last === "y" && prev && !VOWEL.test(prev)) stems.add(w.slice(0, -1) + "i");
  if (last === "e" && w.length >= 3) stems.add(w.slice(0, -1));
  if (last === "y") stems.add(w.slice(0, -1));
  for (const st of stems) for (const suf of KID_DERIVATION_SUFFIXES) out.add(st + suf);
  return [...out];
}

/**
 * 은우 문제 맞히기 전용 정답 가리기(§23-11) — 공용 maskAnswerInCue(일본어·토익·힌트 사다리 카드)는 그대로 두고 은우 문제만 이걸 쓴다.
 * - 밑줄은 고정 길이 `KID_QUIZ_MASK`
 * - 정답을 공백·하이픈으로 나눈 낱말마다 굴절형·파생형을 맞추고, 낱말 사이는 공백·하이픈이 있든 없든(`Ice-cream`·`Ice  cream`·`icecream`) 같은 것으로 본다.
 *   구 답(`look after`)은 앞 낱말 굴절(`looks after`)도 가린다
 * - 낱말 경계(앞뒤가 라틴 글자가 아님)에서만, 대소문자 무시. lookbehind 없음(구형 iOS Safari)
 */
export function maskAnswerForKidQuiz(cue: string, answer: string): string {
  const parts = answer.trim().toLowerCase().split(/[\s\-\u2010\u2011]+/).filter(Boolean);
  if (parts.length === 0 || cue === "") return cue;
  const alt = (forms: string[]) => forms.sort((x, y) => y.length - x.length).map(escapeRe).join("|");
  const body = parts.map((p) => `(?:${alt(kidWordForms(p))})`).join("[\\s\\-\\u2010\\u2011]*");
  const re = new RegExp(body, "gi");
  let out = "";
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cue)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const at = m.index;
    const end = at + m[0].length;
    const before = at > 0 ? cue[at - 1] : "";
    const after = end < cue.length ? cue[end] : "";
    if ((before && LATIN_LETTER.test(before)) || (after && LATIN_LETTER.test(after))) {
      re.lastIndex = at + 1;
      continue;
    }
    out += cue.slice(from, at) + KID_QUIZ_MASK;
    from = end;
  }
  return out + cue.slice(from);
}

/** 정의 비교용 정규화 — 소문자·공백 접기·끝 구두점 제거 */
function normDefinition(def: string | null): string | null {
  const d = def?.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?。]+$/, "").trim() ?? "";
  return d === "" ? null : d;
}

/**
 * 은우 복습 문항 — 오늘 큐(en-word 카드)마다 영단어 5지선다를 만들고 순서를 섞는다. 서버(페이지)·eval에서만 부른다.
 *
 * 보기 규칙(단어장 시험 lib/vocab-quiz `buildChoices`와 같은 모양 — 그 함수를 그대로 쓴다):
 * - 정답 = 카드의 정답 글자(가장 최근 단어장의 표기). 오답 후보 ① **같은 DAY**(정답 단어가 든 가장 최근 단어장)의 다른 단어
 *   ② 그것이 4개보다 모자라면 **다른 단어장**의 단어로 채운다(최근 단어장 먼저 모아 시드로 섞어 모자란 수만큼).
 *   같은 단어(대소문자·공백 무시 — enWordKey)는 한 번만, 정답과 같은 단어는 빠진다.
 * - **같은 뜻 오답 제외**(QA P3-A): 영영 정의가 정답의 정의와 같은 단어(정규화 비교 — 어느 단어장의 정의든), 정답과 유의어로
 *   이어진 단어(어느 쪽에 적혔든 — 단어 아래·뜻 아래 related의 synonym)는 오답 후보에서 빠진다. 빠진 만큼 다른 단어장에서 채운다.
 * - 그래도 모자라면 있는 만큼(최소 2지 — REVIEW_QUIZ_MIN_CHOICES). 1개뿐이면 그 카드는 빼고 `skipped`로 센다.
 * - 셔플은 시드 고정 — 시드 = `{오늘}|{항목 키}`. 같은 날 다시 열면 같은 보기(서버 렌더 한 번 — hydration 안전).
 * 문제 글(`cue`): 정답 단어장 항목의 영영 정의를 `maskAnswerForKidQuiz`로 다시 가린 것(정의가 없으면 null — 그림만). 카드 자체는 바꾸지 않는다.
 * 순서: 큐가 고른 카드(간격 규칙이 정한 오늘 할 것 — 그대로)를 `{오늘}|order|{항목 키}` 해시 순으로 놓는다 — 문항 순서는 무작위로
 * 보이되 같은 날 다시 열어 남은 카드만 와도 서로의 앞뒤가 같다.
 */
export function buildEnglishReviewQuiz(cards: readonly ReviewCard[], books: readonly EnQuizBookLike[], todayKst: string): EnglishReviewQuizBuild {
  const ordered = byCreatedDesc(books);
  // 단어 키 → 정규화 정의 집합 · 유의어 키 집합(양방향)
  const defsOf = new Map<string, Set<string>>();
  const synOf = new Map<string, Set<string>>();
  const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(v);
  };
  for (const b of ordered) {
    for (const e of b.entries) {
      const k = enWordKey(e.word);
      if (k === "") continue;
      const d = normDefinition(e.definitionEn);
      if (d) addTo(defsOf, k, d);
      const rels = [...(e.related ?? []), ...e.meanings.flatMap((m) => m.related ?? [])];
      for (const r of rels) {
        if (r.kind !== "synonym") continue;
        const rk = enWordKey(r.word);
        if (rk === "" || rk === k) continue;
        addTo(synOf, k, rk);
        addTo(synOf, rk, k);
      }
    }
  }
  const questions: ReviewQuizQuestion[] = [];
  let skipped = 0;
  for (const card of cards) {
    if (card.kind !== "en-word") continue;
    const answer = card.answer.main;
    const answerKey = enWordKey(answer);
    const home = ordered.find((b) => b.entries.some((e) => enWordKey(e.word) === answerKey)) ?? null;
    const answerDefs = defsOf.get(answerKey) ?? new Set<string>();
    const answerSyns = synOf.get(answerKey) ?? new Set<string>();
    const sameMeaning = (k: string) => answerSyns.has(k) || [...(defsOf.get(k) ?? [])].some((d) => answerDefs.has(d));
    const seen = new Set<string>([answerKey]);
    const uniq = (words: readonly string[]): string[] => {
      const out: string[] = [];
      for (const raw of words) {
        const w = raw.trim();
        const k = enWordKey(w);
        if (k === "" || seen.has(k) || sameMeaning(k)) continue;
        seen.add(k);
        out.push(w);
      }
      return out;
    };
    const same = uniq(home ? home.entries.map((e) => e.word) : []);
    const others = uniq(ordered.filter((b) => b !== home).flatMap((b) => b.entries.map((e) => e.word)));
    const rng = seededRng(quizHash(`${todayKst}|${card.itemKey}`));
    const need = REVIEW_QUIZ_CHOICE_COUNT - 1;
    const pool = same.length >= need ? same : [...same, ...seededShuffle(others, rng).slice(0, need - same.length)];
    const choices = buildChoices(answer, pool, REVIEW_QUIZ_CHOICE_COUNT, rng);
    if (choices.length < REVIEW_QUIZ_MIN_CHOICES) {
      skipped += 1;
      continue;
    }
    const homeEntry = home?.entries.find((e) => enWordKey(e.word) === answerKey) ?? null;
    const def = homeEntry?.definitionEn?.trim() || null;
    questions.push({ card, choices, cue: def ? maskAnswerForKidQuiz(def, answer) : null });
  }
  const orderKey = (q: ReviewQuizQuestion) => quizHash(`${todayKst}|order|${q.card.itemKey}`);
  questions.sort((a, b) => orderKey(a) - orderKey(b) || (a.card.itemKey < b.card.itemKey ? -1 : a.card.itemKey > b.card.itemKey ? 1 : 0));
  return { questions, skipped };
}

// ---------------------------------------------------------------------------
// 일본어 단어장 단어 (ja-word)
// ---------------------------------------------------------------------------

export interface JaVocabBookLike {
  id: string;
  titleKo: string;
  createdAt: string;
  entries: readonly {
    word: string;
    kana: string;
    meaningsKo: readonly string[];
    imageEmoji: string | null;
    wordTokens: readonly ReviewRubyToken[];
  }[];
}

/** 일본어 단어장 — 같은 표기는 한 항목(가장 최근 단어장). 시험에서 답한 단어만 */
export function japaneseWordItems(books: readonly JaVocabBookLike[], quizzes: readonly QuizSessionLike[]): ReviewSourceItem[] {
  const stats = aggregateReviewStats(quizzes, (w) => w.trim());
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const b of byCreatedDesc(books)) {
    for (const e of b.entries) {
      const word = e.word.trim();
      if (word === "" || seen.has(word)) continue;
      const st = stats.get(word);
      if (!st) continue;
      seen.add(word);
      const kana = e.kana.trim();
      const ko = e.meaningsKo.map((m) => m.trim()).filter(Boolean).slice(0, 3).join(", ");
      out.push({
        card: {
          itemKey: reviewItemKey("ja-word", word),
          kind: "ja-word",
          cue: { emoji: e.imageEmoji, main: ko || "?", sub: null, lang: "ko" },
          hint1: [...kana][0] ?? [...word][0] ?? "",
          hint2: kanaSkeleton(kana || word),
          hint2Note: `읽기 ${[...(kana || word)].length}글자`,
          answer: {
            main: word,
            sub: kana && kana !== word ? kana : null,
            ruby: e.wordTokens.length > 0 ? e.wordTokens.map((t) => ({ surface: t.surface, reading: t.reading })) : null,
          },
          speak: { text: word, lang: "ja-JP" },
          sourceKo: b.titleKo,
        },
        stats: st,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 한자 (ja-kanji)
// ---------------------------------------------------------------------------

export interface JaKanjiLike {
  kanji: string;
  koReading: string | null;
  onyomi: readonly string[];
  kunyomi: readonly string[];
  meaningKo: string;
}

function kanjiReadingsKo(k: JaKanjiLike): string {
  const parts: string[] = [];
  if (k.onyomi.length > 0) parts.push(`음 ${k.onyomi.join("・")}`);
  if (k.kunyomi.length > 0) parts.push(`훈 ${k.kunyomi.join("・")}`);
  return parts.join(" · ");
}

/** 한자 — 한자 시험에서 답한 한자만 */
export function japaneseKanjiItems(kanji: readonly JaKanjiLike[], quizzes: readonly QuizSessionLike[]): ReviewSourceItem[] {
  const stats = aggregateReviewStats(quizzes, (w) => w.trim());
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const k of kanji) {
    const ch = k.kanji.trim();
    if (ch === "" || seen.has(ch)) continue;
    const st = stats.get(ch);
    if (!st) continue;
    seen.add(ch);
    const firstReading = k.onyomi[0] ?? k.kunyomi[0] ?? "";
    const readings = kanjiReadingsKo(k);
    out.push({
      card: {
        itemKey: reviewItemKey("ja-kanji", ch),
        kind: "ja-kanji",
        cue: { emoji: null, main: k.meaningKo.trim() || "?", sub: k.koReading ? `한국 한자음 「${k.koReading}」` : null, lang: "ko" },
        hint1: [...firstReading][0] ?? "",
        hint2: readings || kanaSkeleton(firstReading),
        hint2Note: null,
        answer: { main: ch, sub: readings || null, ruby: null },
        speak: { text: ch, lang: "ja-JP" },
        sourceKo: "한자",
      },
      stats: st,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 토익 표현집 표현 (toeic-expr)
// ---------------------------------------------------------------------------

export interface ToeicSetLike {
  id: string;
  titleKo: string;
  createdAt: string;
  entries: readonly { expression: string; meaningKo: string; example: string | null; exampleKo: string | null }[];
}

/**
 * 토익 표현 — 표현 시험(네 모드)에서 답한 표현만. 같은 표현(대소문자·공백 무시)은 한 항목. 호출측이 틀 은행 문서를 빼고
 * 표현 시험 모드 세션만 넘긴다(lib/review-server.ts — 틀 세션의 `tpl:` 키는 여기 섞이지 않는다).
 */
export function toeicExpressionItems(sets: readonly ToeicSetLike[], quizzes: readonly QuizSessionLike[]): ReviewSourceItem[] {
  const stats = aggregateReviewStats(quizzes, (w) => (w.startsWith("tpl:") ? null : expressionKey(w)));
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const s of byCreatedDesc(sets)) {
    for (const e of s.entries) {
      const expr = e.expression.trim().replace(/\s+/g, " ");
      const k = expressionKey(expr);
      if (k === "" || seen.has(k)) continue;
      const st = stats.get(k);
      if (!st) continue;
      seen.add(k);
      out.push({
        card: {
          itemKey: reviewItemKey("toeic-expr", k),
          kind: "toeic-expr",
          cue: { emoji: null, main: e.meaningKo.trim() || "?", sub: e.exampleKo?.trim() || null, lang: "ko" },
          hint1: firstLetterHint(expr),
          hint2: latinSkeleton(expr),
          hint2Note: null,
          answer: { main: expr, sub: e.example?.trim() || null, ruby: null },
          speak: cleanForSpeech(expr) ? { text: cleanForSpeech(expr), lang: "en-US" } : null,
          sourceKo: s.titleKo,
        },
        stats: st,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 토익 틀 은행 틀 (toeic-template)
// ---------------------------------------------------------------------------

export interface ToeicTemplateLike {
  key: string;
  frameEn: string;
  frameKo: string;
  useKo: string;
  examples: readonly { en: string; ko: string }[];
}

export interface ToeicFrameDrillLike {
  startedAt: string;
  items: readonly { frameKey: string; outcome: string; verdict: string | null }[];
}

/** 틀 말하기 은행의 틀 → 틀 은행 key 연결 */
export interface ToeicFrameDrillFrameLink {
  key: string;
  bankKey: string | null;
}

/**
 * 토익 틀 — 틀 테스트·틀 시험(틀 은행 세션 다섯 모드, 항목 키 `tpl:{key}`)이나 소재별 틀 말하기(말한 문항 — 은행 틀과 이어진 틀만)
 * 기록이 있는 틀만. 템플릿 따라 말하기는 저장 기록이 없어(기기 진행 표시뿐) 들어오지 않는다.
 */
export function toeicTemplateItems(
  templates: readonly ToeicTemplateLike[],
  templateQuizzes: readonly QuizSessionLike[],
  frameDrills: readonly ToeicFrameDrillLike[] = [],
  frameLinks: readonly ToeicFrameDrillFrameLink[] = [],
): ReviewSourceItem[] {
  const stats = aggregateReviewStats(templateQuizzes, (w) => (w.startsWith("tpl:") ? w.slice(4) : null));
  const bankKeyOf = new Map<string, string>();
  for (const f of frameLinks) if (f.bankKey) bankKeyOf.set(f.key, f.bankKey);
  for (const d of frameDrills) {
    for (const it of d.items) {
      if (it.outcome !== "spoken") continue;
      const k = bankKeyOf.get(it.frameKey);
      if (!k) continue;
      const cur = stats.get(k) ?? { attempts: 0, wrongCount: 0, lastTestedAt: null };
      cur.attempts += 1;
      if (it.verdict !== null && it.verdict !== "correct") cur.wrongCount += 1;
      if (cur.lastTestedAt === null || d.startedAt > cur.lastTestedAt) cur.lastTestedAt = d.startedAt;
      stats.set(k, cur);
    }
  }
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const t of templates) {
    const key = t.key.trim();
    if (key === "" || seen.has(key)) continue;
    const st = stats.get(key);
    if (!st) continue;
    seen.add(key);
    const expr = frameToExpression(t.frameEn);
    const firstWord = expr.split(" ").find((w) => w !== "") ?? "";
    const example = t.examples.find((x) => x.en.trim() !== "") ?? null;
    out.push({
      card: {
        itemKey: reviewItemKey("toeic-template", key),
        kind: "toeic-template",
        cue: { emoji: null, main: frameForDisplay(t.frameKo), sub: t.useKo.trim() || null, lang: "ko" },
        hint1: firstWord,
        hint2: latinSkeleton(expr),
        hint2Note: null,
        answer: { main: frameForDisplay(t.frameEn), sub: example ? example.en.trim() : null, ruby: null },
        speak: example ? { text: example.en.trim(), lang: "en-US" } : null,
        sourceKo: "틀 은행",
      },
      stats: st,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 토익 나만의 답변 섬 (toeic-island) — 담은 문장이 곧 복습 항목
// ---------------------------------------------------------------------------

export interface ToeicIslandLike {
  id: string;
  en: string;
  /** 한국어 단서 — 틀 말하기 원본이면 한글 문장, 그 밖은 사용자가 적은 한 줄 메모 */
  ko: string | null;
  /** AI 한국어 해석(호출 G — toeic.md §21-7). 있으면 단서의 주 문장. 선택 칸 — 옛 호출부·옛 문서는 없다(= null) */
  trKo?: string | null;
  topicNameKo: string | null;
  question: string | null;
  frameKey: string | null;
  createdAt: string;
}

/** 틀 고정 부분을 찾을 틀 목록(틀 말하기 틀 + 틀 은행 틀) */
export interface IslandFrameLike {
  key: string;
  frameEn: string;
  frameKo?: string | null;
}

/** 낱말 수 밑줄 — 라틴 글자는 전부 `_`, 공백·구두점 유지(첫 글자도 가린다 — 힌트1이 첫 낱말이라) */
export function wordUnderscores(text: string): string {
  let out = "";
  for (const ch of text.trim().replace(/\s+/g, " ")) out += LATIN_LETTER.test(ch) ? "_" : ch;
  return out;
}

/** 틀 뼈대 — 쓰인 틀의 고정 조각 글자 범위만 보이고 나머지 라틴 글자는 `_`. 틀이 안 찾히면 null */
export function islandFrameSkeleton(en: string, frames: readonly IslandFrameLike[]): string | null {
  const spans = templateRunSpans(en, frames.map((f) => ({ key: f.key, frameEn: f.frameEn })));
  if (spans.length === 0) return null;
  const keep = new Array<boolean>(en.length).fill(false);
  for (const sp of spans) for (const r of sp.runs) for (let i = Math.max(0, r.start); i < Math.min(en.length, r.end); i++) keep[i] = true;
  let out = "";
  for (let i = 0; i < en.length; i++) out += keep[i] || !LATIN_LETTER.test(en[i]) ? en[i] : "_";
  // 틀 고정 부분이 문장을 다 덮으면 뼈대 = 정답이다(QA common_review_1 B) — 가린 글자가 하나도 없으면 null(호출측이 낱말 수 밑줄로)
  if (!out.includes("_")) return null;
  return out.replace(/\s+/g, " ").trim();
}

/** 낱말만 남긴 소문자 꼴(구두점·공백 차이를 지운다) */
function islandLooseText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

/**
 * 해석 단서의 곁줄에 메모를 붙여도 되나 — 메모에 한글이 없거나(영어뿐인 메모는 정답의 조각이기 쉽다) 정답 영어 문장을 통째로 담고 있으면
 * 정답을 흘린다(true). 구두점·대소문자·공백 차이는 같은 것으로 본다.
 */
export function islandMemoLeaksAnswer(memo: string, answerEn: string): boolean {
  if (!/[가-힣]/.test(memo)) return true;
  const a = islandLooseText(answerEn);
  return a !== "" && ` ${islandLooseText(memo)} `.includes(` ${a} `);
}

/**
 * 답변 섬 — 담긴 문장 전부(시험 기록 없음). 단서: AI 해석 trKo가 있으면 그것이 주 문장(곁줄 = 메모 · 소재), 없으면 옛 순서
 * (한국어 단서 → 소재/한국어 틀 → 질문 → 고정 문구). 첫 복습일 = 담은 날(KST) + 1. 섬에서 지운 문장은 목록에 없으니 큐에서 빠진다(일정은 고아로 무해).
 * frames: 틀 말하기 은행 틀(frameKey로 한국어 틀을 찾고, 뼈대 대조에도 쓴다) + 틀 은행 틀.
 */
export function toeicIslandItems(entries: readonly ToeicIslandLike[], frames: readonly IslandFrameLike[] = []): ReviewSourceItem[] {
  const frameByKey = new Map(frames.map((f) => [f.key, f] as const));
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const en = e.en.trim().replace(/\s+/g, " ");
    if (e.id === "" || en === "" || seen.has(e.id)) continue;
    seen.add(e.id);
    const ko = e.ko?.trim() || null;
    const topic = e.topicNameKo?.trim() || null;
    const frame = e.frameKey ? frameByKey.get(e.frameKey) ?? null : null;
    const frameKo = frame?.frameKo?.trim() ? frameForDisplay(frame.frameKo.trim()) : null;
    let main: string;
    let sub: string | null;
    let lang: "ko" | "en" = "ko";
    const trKo = e.trKo?.trim() || null;
    if (trKo) {
      // 해석이 주 문장 — 메모(해석과 다를 때만)와 소재는 곁들인다. 메모만으로는 어떤 문장인지 떠올릴 수 없다(2026-10-13 사용자 신고)
      main = trKo;
      // 메모가 정답을 흘리면 뺀다 — 한글이 없는 메모(영어뿐)·정답 영어 문장을 담은 메모(QA island-tr 1 P3-B)
      const memo = ko && ko !== trKo && !islandMemoLeaksAnswer(ko, en) ? ko : null;
      sub = [memo, topic ? `소재 · ${topic}` : null].filter((x): x is string => x !== null).join(" · ") || null;
    } else if (ko) {
      main = ko;
      sub = topic ? `소재 · ${topic}` : null;
    } else if (topic || frameKo) {
      main = topic ? `소재 · ${topic}` : (frameKo as string);
      sub = topic && frameKo ? frameKo : null;
    } else if (e.question?.trim()) {
      main = e.question.trim();
      sub = "이 질문에 담아 둔 내 답";
      lang = "en";
    } else {
      main = "담아 둔 내 답변";
      sub = null;
    }
    const firstWord = en.split(" ").find((w) => w !== "") ?? "";
    const skeleton = islandFrameSkeleton(en, frames);
    const words = en.split(" ").filter((w) => /[A-Za-z]/.test(w)).length;
    const created = kstDateString(e.createdAt);
    out.push({
      card: {
        itemKey: reviewItemKey("toeic-island", e.id),
        kind: "toeic-island",
        cue: { emoji: "🏝️", main, sub, lang },
        hint1: firstWord,
        hint2: skeleton ?? wordUnderscores(en),
        hint2Note: skeleton ? "쓰인 틀" : `${words}낱말`,
        answer: { main: en, sub: null, ruby: null },
        speak: { text: en, lang: "en-US" },
        sourceKo: topic ? `답변 섬 · ${topic}` : "답변 섬",
      },
      stats: { attempts: 0, wrongCount: 0, lastTestedAt: null, // 담은 시각이 깨졌으면 이미 담긴 것으로 보고 바로 들인다(빠뜨리지 않게)
        firstDueOn: /^\d{4}-\d{2}-\d{2}$/.test(created) ? shiftDateString(created, 1) : "2000-01-01" },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 엄마의 생활영어 문장 (mom-sentence)
// ---------------------------------------------------------------------------

export interface MomBlockLike {
  id: string;
  week: number;
  frame: { text: string };
  sentences: readonly { id: string; role: MomRole; en: string; ko: string; chunks: readonly string[] }[];
}
export interface MomLessonLike {
  startedAt: string;
  finishedAt: string | null;
  checks: readonly { sentenceId: string; verdict: string }[];
}
export interface MomTestLike {
  startedAt: string;
  items: readonly { sentenceId: string; verdict: string }[];
}

/**
 * 엄마 문장 — 말하기 역할(core·expand·situation) 문장 중 **끝낸 레슨에서 결과가 한 번이라도 난 것**만(넘어감 포함).
 * 통계 = 레슨 checks + 주간 테스트 items(맞음 = pass, 틀림 = close·retry·skipped). 첫 복습일 = 그 문장이 든 레슨을 처음 끝낸 날(KST) + 1.
 */
export function momSentenceItems(blocks: readonly MomBlockLike[], lessons: readonly MomLessonLike[], tests: readonly MomTestLike[]): ReviewSourceItem[] {
  const toSession = (startedAt: string, rows: readonly { sentenceId: string; verdict: string }[]): QuizSessionLike => ({
    startedAt,
    items: rows.map((r) => ({ word: r.sentenceId, correct: r.verdict === "pass", answered: true })),
  });
  const stats = aggregateReviewStats(
    [...lessons.map((l) => toSession(l.startedAt, l.checks)), ...tests.map((t) => toSession(t.startedAt, t.items))],
    (id) => id.trim() || null,
  );
  // 문장 → 처음 끝낸 레슨의 KST 날짜
  const firstDone = new Map<string, string>();
  for (const l of lessons) {
    if (!l.finishedAt) continue;
    const day = kstDateString(l.finishedAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const c of l.checks) {
      const k = c.sentenceId.trim();
      const cur = firstDone.get(k);
      if (cur === undefined || day < cur) firstDone.set(k, day);
    }
  }
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const s of b.sentences) {
      const id = s.id.trim();
      const en = s.en.trim().replace(/\s+/g, " ");
      if (id === "" || en === "" || seen.has(id) || !isSpeakRole(s.role)) continue;
      const day = firstDone.get(id);
      const st = stats.get(id);
      if (day === undefined || !st) continue;
      seen.add(id);
      const ko = s.ko.trim();
      const frame = b.frame.text.trim() || null;
      const chunk0 = s.chunks.map((c) => c.trim()).find((c) => c !== "") ?? (en.split(" ")[0] ?? "");
      out.push({
        card: {
          itemKey: reviewItemKey("mom-sentence", id),
          kind: "mom-sentence",
          cue: { emoji: "👩", main: ko, sub: frame, lang: "ko" },
          hint1: firstLetterHint(en),
          hint2: `${chunk0} …`,
          hint2Note: null,
          answer: { main: en, sub: ko, ruby: null },
          speak: { text: en, lang: "en-US" },
          sourceKo: `엄마의 생활영어 · ${b.week}주차`,
        },
        stats: { ...st, firstDueOn: shiftDateString(day, 1) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 🗓️ 오늘의 일본어 N5 단어 (ja-n5-word)
// ---------------------------------------------------------------------------

export interface JaN5VocabDayLike {
  day: number;
  words: readonly { id: string; written: string; reading: string; meaningKo: string }[];
}
export interface JaDailySessionLike {
  startedAt: string;
  finishedAt: string | null;
  vocabAnswers: readonly { wordId: string; correct: boolean }[];
}

/** 표기가 한자만이면 루비 한 조각, 가나 표기·섞인 표기는 루비 없이(읽기는 sub로) */
function n5Ruby(written: string, reading: string): ReviewRubyToken[] | null {
  return /^[\u4e00-\u9fff\u3400-\u4dbf\u3005]+$/.test(written) && written !== reading ? [{ surface: written, reading }] : null;
}

/** N5 단어 — 끝낸 회차에서 답한 단어만, 처음 답한 회차의 다음 날부터 */
export function jaN5WordItems(days: readonly JaN5VocabDayLike[], sessions: readonly JaDailySessionLike[]): ReviewSourceItem[] {
  const done = sessions.filter((s) => s.finishedAt !== null);
  const stats = aggregateReviewStats(
    done.map((s) => ({ startedAt: s.startedAt, items: s.vocabAnswers.map((a) => ({ word: a.wordId, correct: a.correct, answered: true })) })),
    (id) => id.trim() || null,
  );
  const firstDone = new Map<string, string>();
  for (const s of done) {
    const day = kstDateString(s.finishedAt as string);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const a of s.vocabAnswers) {
      const k = a.wordId.trim();
      const cur = firstDone.get(k);
      if (cur === undefined || day < cur) firstDone.set(k, day);
    }
  }
  const out: ReviewSourceItem[] = [];
  const seen = new Set<string>();
  for (const d of [...days].sort((a, b) => a.day - b.day)) {
    for (const w of d.words) {
      const id = w.id.trim();
      if (id === "" || seen.has(id)) continue;
      const first = firstDone.get(id);
      const st = stats.get(id);
      if (first === undefined || !st) continue;
      seen.add(id);
      const written = w.written.trim();
      const kana = w.reading.trim();
      out.push({
        card: {
          itemKey: reviewItemKey("ja-n5-word", id),
          kind: "ja-n5-word",
          cue: { emoji: null, main: w.meaningKo.trim() || "?", sub: null, lang: "ko" },
          hint1: [...kana][0] ?? [...written][0] ?? "",
          hint2: kanaSkeleton(kana || written),
          hint2Note: `읽기 ${[...(kana || written)].length}글자`,
          answer: { main: written, sub: kana && kana !== written ? kana : null, ruby: n5Ruby(written, kana) },
          speak: { text: written, lang: "ja-JP" },
          sourceKo: `오늘의 일본어 · N5 DAY ${d.day}`,
        },
        stats: { ...st, firstDueOn: shiftDateString(first, 1) },
      });
    }
  }
  return out;
}

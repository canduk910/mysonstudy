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
 * ⚠️ 서버·eval에서만 부른다(카드는 서버가 만들어 props로 내린다). 런타임 import: ./review-schedule·./toeic-text·./toeic-template·./kst·./mom-content.
 */

import { reviewItemKey, type ReviewKind, type ReviewQueueCandidate } from "./review-schedule";
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
  ko: string | null;
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

/**
 * 답변 섬 — 담긴 문장 전부(시험 기록 없음). 첫 복습일 = 담은 날(KST) + 1. 섬에서 지운 문장은 목록에 없으니 큐에서 빠진다(일정은 고아로 무해).
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
    if (ko) {
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

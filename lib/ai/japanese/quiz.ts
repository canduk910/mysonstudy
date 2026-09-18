/**
 * lib/ai/japanese/quiz.ts — 아빠의 일본어 시험(J2) 순수 함수 (docs/harness/japanese.md §6)
 *
 * **AI 호출 0.** 4모드 문항·보기 생성과 모드별 숙련도 집계를 전부 순수 함수로 둔다(부수효과·외부 의존 최소).
 * 언어 중립이 확인된 영어 자산을 **그대로 재사용**한다(복제 금지, §10):
 * - 보기 생성: `lib/vocab-quiz.ts`의 `buildChoices`
 * - 숙련도·복습: `lib/vocab-mastery.ts`의 `aggregateWordStats`, `lib/vocab-review.ts`의 `buildReviewCandidates`
 *
 * ── 모드별 숙련도 분리 (§6-2, 핵심) ───────────────────────────────────────────
 * 뜻은 아는데 독음을 모르는 상태가 흔하다. `kanji-to-kana`에서 틀린 것이 `ko-to-word` 통계를 오염시키면
 * "안다" 판정이 거짓이 된다. 그래서 집계를 **모드별로** 낸다(영어 mode:"relation" 분리와 같은 규약·함정).
 *
 * ── 입력은 구조적 최소 타입 ────────────────────────────────────────────────────
 * lib/ai/* 값을 클라이언트로 끌지 않으려고 VocabEntry를 직접 import하지 않고, 시험에 필요한 필드만
 * 구조적으로 받는다(JaVocabEntry가 이를 만족한다). 세션 레코드도 구조적 최소 타입으로 받는다.
 */

import { buildChoices, DEFAULT_CHOICE_COUNT, type Rng } from "../../vocab-quiz";
import { aggregateWordStats, type WordStat } from "../../vocab-mastery";
import { buildReviewCandidates, type ReviewCandidate } from "../../vocab-review";
import type { VocabQuizRecord } from "../../store";

// ---------------------------------------------------------------------------
// 모드 (§6-1·§7-3)
// ---------------------------------------------------------------------------

/** 단어 콘텐츠 4모드 — 단어장 엔트리로 만드는 축(§6-1). */
export const JA_QUIZ_CONTENT_MODES = ["ko-to-word", "kanji-to-kana", "word-to-ko", "cloze"] as const;
export type JaQuizContentMode = (typeof JA_QUIZ_CONTENT_MODES)[number];

/** 단어 저장 레코드의 mode 축 — 단어 4모드 + 오답복습(§7-3). 집계는 모드별로 가른다(§6-2). */
export const JA_QUIZ_MODES = [...JA_QUIZ_CONTENT_MODES, "wrong-review"] as const;
export type JaQuizMode = (typeof JA_QUIZ_MODES)[number];

/**
 * 한자 축 2모드 — 한자 정보(JaKanjiInfo)로 만든다(§12-4). **JA_QUIZ_MODES와 별도 축**이다(단어 라벨 Record를
 * 깨지 않게). 집계(aggregateJaStatsByMode)는 mode 문자열로 가르므로, 한자 세션도 자기 버킷으로 들어가 단어
 * 모드 통계와 섞이지 않는다(모드 무오염, §6-2). 한자 시험 세션 레코드는 이 mode를 쓴다(§12-4 scope:"kanji").
 */
export const JA_KANJI_QUIZ_MODES = ["kanji-to-on", "kanji-to-meaning"] as const;
export type JaKanjiQuizMode = (typeof JA_KANJI_QUIZ_MODES)[number];

// ---------------------------------------------------------------------------
// 입력 최소 타입 (JaVocabEntry가 구조적으로 만족)
// ---------------------------------------------------------------------------

export interface JaQuizSourceEntry {
  word: string;
  kana: string;
  meaningsKo: readonly string[];
  pos: readonly string[];
  example: { ja: string };
}

/** 시험 문항 하나 — 어느 모드든 word(엔트리 정체)로 채점·기록한다(JaQuizRecord.items의 word). */
export interface JaQuizQuestion {
  mode: JaQuizContentMode;
  /** 엔트리 정체 — 채점·기록 키(표기) */
  word: string;
  /** 화면에 보여줄 문제(뜻 / 표기 / 표기+읽기 / 빈칸 문장) */
  prompt: string;
  /** 정답 보기 텍스트 */
  answer: string;
  /** 5지선다(정답 포함·셔플). 단어장이 작으면 count 미만일 수 있다 */
  choices: string[];
}

export interface JaQuizBuildResult {
  questions: JaQuizQuestion[];
  /** 출제 불가로 건너뛴 (엔트리,모드) 조합 수 — 화면이 "N개는 출제 못 함"을 사실대로 알린다 */
  skipped: number;
}

export interface JaQuizBuildOptions {
  /** 출제할 콘텐츠 모드(부분집합 가능). 생략하면 4모드 전부 */
  modes?: readonly JaQuizContentMode[];
  /** 한 문항의 보기 수(기본 5) */
  count?: number;
  rng?: Rng;
}

// ---------------------------------------------------------------------------
// 문자·품사 판정
// ---------------------------------------------------------------------------

function hasKanji(s: string): boolean {
  return /[一-鿿㐀-䶿々]/.test(s);
}

/** 두 엔트리가 품사를 하나라도 공유하는가 — cloze 오답의 '같은 품사 우선'용. */
function sharesPos(a: JaQuizSourceEntry, b: JaQuizSourceEntry): boolean {
  return a.pos.some((p) => b.pos.includes(p));
}

/** 한 엔트리의 한국어 뜻을 한 문자열로 — word-to-ko의 정답/오답 텍스트. */
function meaningText(e: JaQuizSourceEntry): string {
  return e.meaningsKo.join(", ");
}

/** Fisher-Yates 셔플(rng 주입) — 순수하게 복제 반환. */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// 문항 하나 만들기 (모드별) — 출제 불가면 null
// ---------------------------------------------------------------------------

function buildOne(
  mode: JaQuizContentMode,
  entry: JaQuizSourceEntry,
  entries: readonly JaQuizSourceEntry[],
  count: number,
  rng: Rng,
): JaQuizQuestion | null {
  switch (mode) {
    case "ko-to-word": {
      const prompt = meaningText(entry);
      if (prompt.trim() === "") return null;
      const choices = buildChoices(entry.word, entries.map((e) => e.word), count, rng);
      return { mode, word: entry.word, prompt, answer: entry.word, choices };
    }
    case "kanji-to-kana": {
      // 한자가 있는 단어만(word !== kana이고 한자 포함) — 가나 단어는 문제가 성립하지 않는다(§6-1)
      if (entry.word === entry.kana || !hasKanji(entry.word)) return null;
      const choices = buildChoices(entry.kana, entries.map((e) => e.kana), count, rng);
      return { mode, word: entry.word, prompt: entry.word, answer: entry.kana, choices };
    }
    case "word-to-ko": {
      const answer = meaningText(entry);
      if (answer.trim() === "") return null;
      const choices = buildChoices(answer, entries.map((e) => meaningText(e)), count, rng);
      return { mode, word: entry.word, prompt: `${entry.word}(${entry.kana})`, answer, choices };
    }
    case "cloze": {
      // 예문에 표제어가 실제로 포함될 때만 출제(zod가 보장하지만 코드에서도 확인, §6-1)
      if (!entry.example.ja.includes(entry.word)) return null;
      const prompt = entry.example.ja.replace(entry.word, "___"); // 표기 기준 1회 치환
      const others = entries.filter((e) => e.word !== entry.word);
      // 같은 품사 오답 우선 — 충분하면 같은 품사만, 부족하면 나머지로 채운다(§6-1)
      const samePos = others.filter((e) => sharesPos(e, entry)).map((e) => e.word);
      const anyPos = others.map((e) => e.word);
      const pool = samePos.length >= count - 1 ? samePos : [...samePos, ...anyPos];
      const choices = buildChoices(entry.word, pool, count, rng);
      return { mode, word: entry.word, prompt, answer: entry.word, choices };
    }
  }
}

/**
 * 세션 문항 전체를 1회 조립한다(§6-1: 문항·보기 셔플은 세션 시작 1회).
 * 각 엔트리 × 요청 모드마다 문항을 만들고(출제 불가면 skip 카운트), 문항 순서를 한 번 셔플한다.
 * 보기는 buildChoices가 이미 셔플한다.
 */
export function buildJaQuizQuestions(
  entries: readonly JaQuizSourceEntry[],
  options: JaQuizBuildOptions = {},
): JaQuizBuildResult {
  const modes = options.modes ?? JA_QUIZ_CONTENT_MODES;
  const count = options.count ?? DEFAULT_CHOICE_COUNT;
  const rng = options.rng ?? Math.random;

  const questions: JaQuizQuestion[] = [];
  let skipped = 0;
  for (const entry of entries) {
    for (const mode of modes) {
      const q = buildOne(mode, entry, entries, count, rng);
      if (q) questions.push(q);
      else skipped += 1;
    }
  }
  return { questions: shuffle(questions, rng), skipped };
}

// ---------------------------------------------------------------------------
// 한자 시험 2모드 (§12-4) — 한자 정보(JaKanjiInfo)로 만든다. 단어 시험과 같은 buildChoices·question shape.
// ---------------------------------------------------------------------------

/** 한자 시험이 읽는 최소 shape(JaKanjiInfo가 구조적으로 만족). */
export interface JaKanjiQuizSource {
  kanji: string;
  onyomi: readonly string[];
  meaningKo: string;
}

/** 한자 문항 — word 자리에 한자를 담아 채점·기록 키로 쓴다(단어 시험과 같은 규약). */
export interface JaKanjiQuizQuestion {
  mode: JaKanjiQuizMode;
  /** 채점·기록 키(한자 문자) */
  word: string;
  prompt: string;
  answer: string;
  choices: string[];
}

export interface JaKanjiQuizBuildOptions {
  modes?: readonly JaKanjiQuizMode[];
  count?: number;
  rng?: Rng;
}

function buildKanjiOne(
  mode: JaKanjiQuizMode,
  item: JaKanjiQuizSource,
  items: readonly JaKanjiQuizSource[],
  count: number,
  rng: Rng,
): JaKanjiQuizQuestion | null {
  if (mode === "kanji-to-on") {
    // 음독 없는 한자(훈독만)는 제외 — 가나 단어를 kanji-to-kana에서 빼는 것과 같은 규칙(§12-4)
    if (item.onyomi.length === 0) return null;
    const answer = item.onyomi[0];
    const pool = items.flatMap((k) => k.onyomi); // 다른 한자의 음독(정답은 buildChoices가 배제·중복 제거)
    const choices = buildChoices(answer, pool, count, rng);
    return { mode, word: item.kanji, prompt: item.kanji, answer, choices };
  }
  // kanji-to-meaning
  if (item.meaningKo.trim() === "") return null;
  const choices = buildChoices(item.meaningKo, items.map((k) => k.meaningKo), count, rng);
  return { mode, word: item.kanji, prompt: item.kanji, answer: item.meaningKo, choices };
}

/**
 * 한자 시험 문항을 조립한다(§12-4). 각 한자 × 요청 모드마다 문항을 만들고(음독 없는 한자의 kanji-to-on은 skip),
 * 문항 순서를 1회 셔플한다. 보기는 buildChoices가 이미 셔플한다.
 */
export function buildJaKanjiQuizQuestions(
  items: readonly JaKanjiQuizSource[],
  options: JaKanjiQuizBuildOptions = {},
): { questions: JaKanjiQuizQuestion[]; skipped: number } {
  const modes = options.modes ?? JA_KANJI_QUIZ_MODES;
  const count = options.count ?? DEFAULT_CHOICE_COUNT;
  const rng = options.rng ?? Math.random;

  const questions: JaKanjiQuizQuestion[] = [];
  let skipped = 0;
  for (const item of items) {
    for (const mode of modes) {
      const q = buildKanjiOne(mode, item, items, count, rng);
      if (q) questions.push(q);
      else skipped += 1;
    }
  }
  return { questions: shuffle(questions, rng), skipped };
}

// ---------------------------------------------------------------------------
// 모드별 숙련도·복습 (§6-2) — 영어 순수 함수를 모드별로 갈라 호출하는 얇은 헬퍼
// ---------------------------------------------------------------------------

/**
 * 집계·복습이 읽는 시험 세션 최소 타입(JaQuizRecord가 구조적으로 만족).
 * mode는 단어 모드·한자 모드 어느 쪽이든 받는다 — 집계는 문자열로 가르므로 두 축이 한 함수에서 안전히 분리된다.
 */
export interface JaQuizSessionLike {
  id: string;
  bookId: string;
  mode: JaQuizMode | JaKanjiQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: readonly { word: string; correct: boolean; answered: boolean | null }[];
}

/**
 * ja 세션을 영어 aggregateWordStats/buildReviewCandidates가 받는 VocabQuizRecord 형태로 옮긴다.
 * mode는 "def-to-word"로 고정한다 — 두 함수는 mode를 "relation" 제외 판정에만 쓰는데(ja엔 relation이 없다),
 * **호출 전에 이미 ja 모드로 걸러 두므로** 이 고정값은 집계에 영향이 없다(같은 그룹 안은 전부 같은 ja 모드).
 */
function toVocabQuizRecords(quizzes: readonly JaQuizSessionLike[]): VocabQuizRecord[] {
  return quizzes.map((q) => ({
    id: q.id,
    bookId: q.bookId,
    mode: "def-to-word" as VocabQuizRecord["mode"],
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    items: q.items.map((it) => ({ ...it })),
  }));
}

/**
 * 모드별 숙련도 집계(§6-2) — 세션을 mode로 가른 뒤 각 그룹에 aggregateWordStats를 돌린다.
 * 반환은 { [mode]: { [word]: WordStat } }. 어떤 모드도 서로의 통계에 섞이지 않는다(무오염).
 */
export function aggregateJaStatsByMode(
  quizzes: readonly JaQuizSessionLike[],
): Record<string, Record<string, WordStat>> {
  const byMode = new Map<string, JaQuizSessionLike[]>();
  for (const q of quizzes) {
    const bucket = byMode.get(q.mode);
    if (bucket) bucket.push(q);
    else byMode.set(q.mode, [q]);
  }
  const out: Record<string, Record<string, WordStat>> = {};
  for (const [mode, group] of byMode) {
    out[mode] = aggregateWordStats(toVocabQuizRecords(group));
  }
  return out;
}

/**
 * 모드별 복습 후보(§6-2) — 주어진 모드의 세션만으로 buildReviewCandidates를 돌린다.
 * 다른 모드 세션은 이 모드의 복습 후보에 영향을 주지 않는다(무오염).
 */
export function buildJaReviewCandidatesByMode(
  quizzes: readonly JaQuizSessionLike[],
  mode: JaQuizMode | JaKanjiQuizMode,
): ReviewCandidate[] {
  return buildReviewCandidates(toVocabQuizRecords(quizzes.filter((q) => q.mode === mode)));
}

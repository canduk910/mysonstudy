/**
 * lib/toeic-quiz.ts — 아빠의 영어 표현 시험 **순수 함수** (docs/harness/toeic.md §6-1·§6-2)
 *
 * **AI 호출 0.** 네 모드의 출제·보기·빈칸 가림·말하기 항목 선정·세션 조립·모드별 집계를 여기 한 곳에 둔다.
 * 언어 중립이 확인된 은우 자산을 **수정 없이** 재사용한다(§10):
 * - 5지선다 보기: `lib/vocab-quiz.ts`의 `buildChoices`
 * - 숙련도(연속 2회 정답 졸업): `lib/vocab-mastery.ts`의 `aggregateWordStats`·`isStatMastered` — 어댑터 경유
 * - 오답 후보: `lib/vocab-review.ts`의 `buildReviewCandidates` — 어댑터 경유
 *
 * ── 모드별 숙련도 분리 (§6-2, 핵심) ───────────────────────────────────────────
 * 뜻은 아는데 말로 못 꺼내는 상태가 흔하다. `speak` 통계가 `ko-to-expr`를 오염시키면 "안다" 판정이 거짓이 된다.
 * 그래서 집계를 **모드별로** 낸다(일본어 aggregateJaStatsByMode와 같은 규약).
 *
 * ── 항목 키 ────────────────────────────────────────────────────────────────────
 * 세션 레코드의 `items[].word` = 항목 키. 5지선다 세 모드와 말하기의 useIn은 **표현(expression)**, 교재 QUIZ는 첫
 * keyExpressions(없으면 `quiz:{no}`, 번호도 없으면 `quiz:{promptKo}`). 숙련도는 이 키로 센다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 은우 순수 함수 3개와 lib/toeic-text(import 0)뿐, lib/ai·lib/store는 `import type`만.
 */

import { buildChoices, DEFAULT_CHOICE_COUNT, type Rng } from "./vocab-quiz";
import { aggregateWordStats, isStatMastered, type WordStat } from "./vocab-mastery";
import { buildReviewCandidates, type ReviewCandidate } from "./vocab-review";
import { expressionKey, matchKey } from "./toeic-text";
import type { VocabQuizRecord } from "./store";
import type { ToeicPart } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 모드 (§6-1·§7-3)
// ---------------------------------------------------------------------------

export const TOEIC_QUIZ_MODES = ["ko-to-expr", "expr-to-ko", "cloze", "speak"] as const;
export type ToeicQuizMode = (typeof TOEIC_QUIZ_MODES)[number];

/** 5지선다 세 모드 — 기본 세션은 이 셋을 섞는다(§6-1). speak는 따로 */
export const TOEIC_CHOICE_QUIZ_MODES = ["ko-to-expr", "expr-to-ko", "cloze"] as const;
export type ToeicChoiceQuizMode = (typeof TOEIC_CHOICE_QUIZ_MODES)[number];

export const TOEIC_QUIZ_MODE_LABELS_KO: Record<ToeicQuizMode, string> = {
  "ko-to-expr": "뜻 → 표현",
  "expr-to-ko": "표현 → 뜻",
  cloze: "빈칸",
  speak: "말하기",
};

export function isToeicQuizMode(v: unknown): v is ToeicQuizMode {
  return typeof v === "string" && (TOEIC_QUIZ_MODES as readonly string[]).includes(v);
}

/** 말하기 세션 최대 문항 수(§6-1) */
export const TOEIC_SPEAK_SESSION_MAX = 10;

/**
 * 5지선다 문항의 최소 보기 수(정답 포함) — 이보다 적으면 출제하지 않는다(skipped). 보기가 정답 하나뿐인 문항은 무조건
 * 맞아 숙련도(연속 2회 졸업)를 거짓으로 채운다. 보기는 최대 5개, 오답 후보가 모자라면 있는 만큼(§6-1).
 */
export const TOEIC_CHOICE_MIN = 2;

/** cloze 빈칸 표시(§6-1 `_____`) */
export const TOEIC_CLOZE_BLANK = "_____";

// ---------------------------------------------------------------------------
// 입력 최소 타입 (ToeicSetRecord가 구조적으로 만족)
// ---------------------------------------------------------------------------

export interface ToeicQuizSourceEntry {
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  points: { exampleSpan: string | null; useIn: readonly { part: ToeicPart; sentence: string; sentenceKo: string }[] } | null;
}

export interface ToeicQuizSourceBookQuiz {
  no: number | null;
  promptKo: string;
  hint: string | null;
  modelAnswer: string;
  keyExpressions: readonly string[];
}

export interface ToeicQuizSourceSet {
  entries: readonly ToeicQuizSourceEntry[];
  quiz: readonly ToeicQuizSourceBookQuiz[];
}

/** 시험 세션 최소 타입(ToeicQuizRecord가 구조적으로 만족) */
export interface ToeicQuizSessionLike {
  id: string;
  setId: string;
  mode: ToeicQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: readonly { word: string; correct: boolean; answered: boolean | null }[];
}

// ---------------------------------------------------------------------------
// 문항 타입
// ---------------------------------------------------------------------------

/** 5지선다 문항 */
export interface ToeicChoiceQuestion {
  mode: ToeicChoiceQuizMode;
  /** 항목 키(= 표현) — 채점·기록 */
  key: string;
  /** 세트 entries 위치 */
  entryIndex: number;
  /** 문제(뜻 / 표현 / 빈칸 문장) */
  prompt: string;
  /** cloze만 예문 해석(정답을 하나로 정한다, §6-1). 그 밖 null */
  promptSubKo: string | null;
  answer: string;
  /** 보기(정답 포함·셔플). 세트가 작으면 5개 미만일 수 있다 */
  choices: string[];
}

/** 말하기 문항(자기 채점 — 보기 없음) */
export interface ToeicSpeakQuestion {
  mode: "speak";
  key: string;
  source: "quiz" | "useIn";
  /** useIn이면 세트 entries 위치, 교재 QUIZ면 null */
  entryIndex: number | null;
  /** useIn이면 문항 축, 교재 QUIZ면 null */
  part: ToeicPart | null;
  /** 문제(한국어) */
  promptKo: string;
  /** 교재 QUIZ 괄호 힌트(없으면 null) */
  hint: string | null;
  /** 모범 문장(영어) — "정답 보기"에서 보이고 en-US로 읽는다 */
  answer: string;
}

// ---------------------------------------------------------------------------
// 출제 조각
// ---------------------------------------------------------------------------

/** Fisher-Yates 셔플(rng 주입) — 순수하게 복제 반환 */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 단어 글자(문자·숫자, 모든 문자 체계). 아포스트로피·하이픈·공백·문장부호는 경계로 본다(`cart's` → `_____'s`). */
const CLOZE_WORD_CHAR = /[\p{L}\p{N}]/u;

function isClozeWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== "" && CLOZE_WORD_CHAR.test(ch);
}

/** 문자열 첫/끝 **코드 포인트**(서로게이트 쌍을 반으로 자르지 않는다) */
function firstCodePoint(s: string): string | undefined {
  const cp = s.codePointAt(0);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}
function lastCodePoint(s: string): string | undefined {
  if (s === "") return undefined;
  const last = s.charCodeAt(s.length - 1);
  // 끝이 low surrogate면 한 글자 앞에서 쌍으로 읽는다
  if (last >= 0xdc00 && last <= 0xdfff && s.length >= 2) return s.slice(-2);
  return s.slice(-1);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 예문에서 exampleSpan을 `_____`로 가린다(§6-1 cloze 문제 문장).
 *
 * - **모든 등장**을 가린다(대소문자 무시) — 같은 구간이 예문에 두 번 나오면 첫 번째만 가렸을 때 정답이 문제에 그대로
 *   남는다(QA P2-1: 교재 데이터 실측 1문항). 문장 첫머리의 대문자 형태도 정답이 보이는 것이므로 함께 가린다.
 * - **단어 경계**에서만 가린다 — span 끝 글자가 단어 글자면 그 바깥 글자가 단어 글자가 아니어야 한다
 *   (`cart`가 `cartoon` 안을 가리지 않는다). 경계 판정은 lookbehind 없이 직접 한다(구형 iOS Safari에서 정규식
 *   lookbehind가 문법 오류로 던진다 — 이 모듈은 클라이언트 번들에 들어간다).
 * - 단어 경계에 맞는 등장이 하나도 없으면 null(출제 불가 → skipped). 단어 조각만 가린 문제(`_____ing a …`)는
 *   보기만 봐도 답이 갈려 시험이 되지 않는다.
 */
export function maskCloze(example: string, span: string): string | null {
  if (span.trim() === "") return null;
  const needLeft = isClozeWordChar(firstCodePoint(span));
  const needRight = isClozeWordChar(lastCodePoint(span));
  const re = new RegExp(escapeRegExp(span), "giu");
  let out = "";
  let from = 0;
  let masked = 0;
  for (let m = re.exec(example); m !== null; m = re.exec(example)) {
    const at = m.index;
    const end = at + m[0].length;
    if (m[0].length === 0) break;
    const leftOk = !needLeft || !isClozeWordChar(lastCodePoint(example.slice(0, at)));
    const rightOk = !needRight || !isClozeWordChar(firstCodePoint(example.slice(end)));
    if (!leftOk || !rightOk) {
      // 단어 안의 부분 일치 — 건너뛰고 바로 다음 글자부터 다시 찾는다(겹친 올바른 등장을 놓치지 않게)
      re.lastIndex = at + 1;
      continue;
    }
    out += example.slice(from, at) + TOEIC_CLOZE_BLANK;
    from = end;
    masked += 1;
  }
  if (masked === 0) return null;
  return out + example.slice(from);
}

/** 교재 QUIZ의 말하기 항목 키 — 첫 keyExpressions, 없으면 `quiz:{no}`, 번호도 없으면 `quiz:{promptKo}` */
export function speakKeyForBookQuiz(q: Pick<ToeicQuizSourceBookQuiz, "no" | "promptKo" | "keyExpressions">): string {
  const first = q.keyExpressions.find((k) => k.trim() !== "");
  if (first !== undefined) return first;
  return q.no !== null ? `quiz:${q.no}` : `quiz:${q.promptKo.trim()}`;
}

/**
 * 오답 후보 정리 — `key`(정규화 키)로 중복을 접고(첫 표기), 정답과 같은 키는 뺀다. `buildChoices`(은우 공유 함수, 수정 금지 §10)는
 * **글자까지 같은** 문자열만 거르므로, 대소문자·공백만 다른 "같아 보이는 보기 두 개"는 여기서 미리 걸러 넘긴다(QA P2-7).
 */
function distinctDistractors(answer: string, candidates: readonly string[], key: (s: string) => string): string[] {
  const seen = new Set<string>([key(answer)]);
  const out: string[] = [];
  for (const c of candidates) {
    const k = key(c);
    if (k === "" || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * 한 (항목, 모드) 문항. 출제 불가면 null.
 *
 * 오답 보기 거르기(§6-1, QA P2-7) — **맞는 답이 오답 보기로 나와 틀린 것으로 채점되는 경로**를 막는다:
 * - 같은 표현(expressionKey — 대소문자·공백 무시)인 다른 항목은 어느 모드에서도 오답 후보가 아니다(같은 항목이다).
 * - `ko-to-expr`·`cloze`: 정답과 **뜻이 같은**(matchKey — 공백·대소문자 무시) 항목의 표현·구간은 뺀다. 같은 뜻을 보고 둘 중
 *   하나를 고르라는 문제는 정답이 둘이다(cloze도 예문 해석이 정답을 정하므로 뜻이 같은 구간은 똑같이 들어맞는다).
 * - `expr-to-ko`: 정답 뜻과 같은 뜻은 보기에서 뺀다(공백·대소문자 무시로 중복 제거).
 * - 보기는 정규화 키로 중복을 접는다(cloze의 대소문자만 다른 구간 등).
 * - 거른 뒤 보기가 `TOEIC_CHOICE_MIN`(2)개 미만이면 출제하지 않는다.
 */
function buildOne(
  mode: ToeicChoiceQuizMode,
  index: number,
  entries: readonly ToeicQuizSourceEntry[],
  count: number,
  rng: Rng,
): ToeicChoiceQuestion | null {
  const e = entries[index];
  const selfExpr = expressionKey(e.expression);
  const selfMeaning = matchKey(e.meaningKo);
  const others = entries.filter((o, i) => i !== index && expressionKey(o.expression) !== selfExpr);
  const otherMeaning = others.filter((o) => matchKey(o.meaningKo) !== selfMeaning);
  const finish = (q: Omit<ToeicChoiceQuestion, "choices">, pool: string[]): ToeicChoiceQuestion | null => {
    const choices = buildChoices(q.answer, pool, count, rng);
    return choices.length < TOEIC_CHOICE_MIN ? null : { ...q, choices };
  };
  switch (mode) {
    case "ko-to-expr":
      if (selfMeaning === "") return null;
      return finish(
        { mode, key: e.expression, entryIndex: index, prompt: e.meaningKo, promptSubKo: null, answer: e.expression },
        distinctDistractors(e.expression, otherMeaning.map((o) => o.expression), expressionKey),
      );
    case "expr-to-ko":
      if (selfMeaning === "") return null;
      return finish(
        { mode, key: e.expression, entryIndex: index, prompt: e.expression, promptSubKo: null, answer: e.meaningKo },
        distinctDistractors(e.meaningKo, others.map((o) => o.meaningKo), matchKey),
      );
    case "cloze": {
      // 예문과 exampleSpan이 있을 때만(§6-1). 오답은 같은 세트의 다른 exampleSpan(없으면 표현) — 뜻이 같은 항목은 뺀다
      const span = e.points?.exampleSpan ?? null;
      if (e.example === null || span === null) return null;
      const prompt = maskCloze(e.example, span);
      if (prompt === null) return null;
      return finish(
        { mode, key: e.expression, entryIndex: index, prompt, promptSubKo: e.exampleKo, answer: span },
        distinctDistractors(span, otherMeaning.map((o) => o.points?.exampleSpan ?? o.expression), matchKey),
      );
    }
  }
}

export interface ToeicChoiceBuildOptions {
  /** 출제할 모드(부분집합). 생략하면 5지선다 세 모드 혼합 */
  modes?: readonly ToeicChoiceQuizMode[];
  /** 보기 수(기본 5) */
  count?: number;
  /** 이 키(표현)만 출제 — 오답 재시험(`?wrong=<mode>`)용. 생략하면 전부 */
  onlyKeys?: ReadonlySet<string>;
  rng?: Rng;
}

/**
 * 5지선다 세션 문항을 1회 조립한다(셔플은 세션 시작 1회). 항목 × 모드마다 문항을 만들고(출제 불가면 skipped),
 * 문항 순서를 한 번 섞는다. 보기는 buildChoices가 섞는다.
 */
export function buildToeicChoiceQuestions(
  set: Pick<ToeicQuizSourceSet, "entries">,
  options: ToeicChoiceBuildOptions = {},
): { questions: ToeicChoiceQuestion[]; skipped: number } {
  const modes = options.modes ?? TOEIC_CHOICE_QUIZ_MODES;
  const count = options.count ?? DEFAULT_CHOICE_COUNT;
  const rng = options.rng ?? Math.random;
  const questions: ToeicChoiceQuestion[] = [];
  let skipped = 0;
  set.entries.forEach((e, i) => {
    if (options.onlyKeys && !options.onlyKeys.has(e.expression)) return;
    for (const mode of modes) {
      const q = buildOne(mode, i, set.entries, count, rng);
      if (q) questions.push(q);
      else skipped += 1;
    }
  });
  return { questions: shuffle(questions, rng), skipped };
}

export interface ToeicSpeakBuildOptions {
  /** 최대 문항 수(기본 TOEIC_SPEAK_SESSION_MAX) */
  max?: number;
  /** 이 키만 — 오답 재시험용 */
  onlyKeys?: ReadonlySet<string>;
  rng?: Rng;
}

/** 말하기 우선순위용 약함 순위 — 틀렸고 미졸업(0) → 안 해 봄(1) → 해 봤고 틀린 적 없음·미졸업(2) → 졸업(3) */
function weaknessRank(stat: WordStat | undefined): number {
  if (!stat || stat.total === 0) return 1;
  if (isStatMastered(stat)) return 3;
  return stat.wrong > 0 ? 0 : 2;
}

/**
 * 말하기 세션(§6-1) — 교재 QUIZ 먼저, 그다음 **말하기 모드** 숙련도가 낮은 표현의 useIn(표현마다 하나, rng로 고름).
 * 같은 키는 한 세션에 한 번만 낸다(QUIZ가 이미 그 표현 키를 쓰면 그 표현의 useIn은 건너뛴다).
 *
 * @param speakSessions 이 세트의 **speak 모드** 세션(startedAt 오름차순). 다른 모드 세션을 넘기면 걸러낸다(무오염).
 */
export function buildToeicSpeakSession(
  set: ToeicQuizSourceSet,
  speakSessions: readonly ToeicQuizSessionLike[],
  options: ToeicSpeakBuildOptions = {},
): ToeicSpeakQuestion[] {
  const max = options.max ?? TOEIC_SPEAK_SESSION_MAX;
  const rng = options.rng ?? Math.random;
  const allow = (key: string) => !options.onlyKeys || options.onlyKeys.has(key);
  const out: ToeicSpeakQuestion[] = [];
  const used = new Set<string>();

  for (const q of set.quiz) {
    if (out.length >= max) return out;
    const key = speakKeyForBookQuiz(q);
    if (used.has(key) || !allow(key)) continue;
    used.add(key);
    out.push({ mode: "speak", key, source: "quiz", entryIndex: null, part: null, promptKo: q.promptKo, hint: q.hint, answer: q.modelAnswer });
  }

  const stats = aggregateToeicStatsByMode(speakSessions)["speak"];
  const candidates = shuffle(
    set.entries.map((e, i) => ({ e, i })).filter(({ e }) => (e.points?.useIn.length ?? 0) > 0 && allow(e.expression) && !used.has(e.expression)),
    rng,
  );
  // 약함 순위 → 오답 많은 순 → (셔플된 순서 유지 — 동률은 무작위)
  const ranked = candidates
    .map((c, order) => ({ ...c, order, stat: stats[c.e.expression] }))
    .sort((a, b) => weaknessRank(a.stat) - weaknessRank(b.stat) || (b.stat?.wrong ?? 0) - (a.stat?.wrong ?? 0) || a.order - b.order);

  for (const { e, i } of ranked) {
    if (out.length >= max) break;
    const useIn = e.points!.useIn;
    const pick = useIn[Math.floor(rng() * useIn.length)];
    used.add(e.expression);
    out.push({ mode: "speak", key: e.expression, source: "useIn", entryIndex: i, part: pick.part, promptKo: pick.sentenceKo, hint: null, answer: pick.sentence });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 세션 저장 모양 — 혼합 세션은 모드별로 나눠 모드마다 POST 1건(§6-2)
// ---------------------------------------------------------------------------

export interface ToeicAnsweredItem {
  mode: ToeicQuizMode;
  key: string;
  correct: boolean;
  /** 답했으면 true, 그만하기로 못 답했으면 null */
  answered: boolean | null;
}

/** 혼합 세션 결과를 모드별 items로 가른다(등장 순서 유지). 비어 있는 모드는 키가 없다. */
export function splitToeicItemsByMode(
  items: readonly ToeicAnsweredItem[],
): Partial<Record<ToeicQuizMode, { word: string; correct: boolean; answered: boolean | null }[]>> {
  const out: Partial<Record<ToeicQuizMode, { word: string; correct: boolean; answered: boolean | null }[]>> = {};
  for (const it of items) {
    const bucket = out[it.mode] ?? (out[it.mode] = []);
    bucket.push({ word: it.key, correct: it.correct, answered: it.answered });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 모드별 숙련도·오답 (§6-2) — 은우 순수 함수를 모드별로 갈라 부르는 어댑터
// ---------------------------------------------------------------------------

/**
 * 토익 세션을 은우 aggregateWordStats/buildReviewCandidates가 받는 VocabQuizRecord 모양으로 옮긴다.
 * mode는 "def-to-word"로 고정한다 — 두 함수는 mode를 "relation" 제외 판정에만 쓰고, 호출 전에 이미 토익 모드로 걸러 두므로
 * 이 고정값은 집계에 영향이 없다(일본어 어댑터와 같은 규약). setId는 bookId 자리로.
 */
function toVocabQuizRecords(sessions: readonly ToeicQuizSessionLike[]): VocabQuizRecord[] {
  return sessions.map((s) => ({
    id: s.id,
    bookId: s.setId,
    mode: "def-to-word" as VocabQuizRecord["mode"],
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    items: s.items.map((it) => ({ word: it.word, correct: it.correct, answered: it.answered })),
  }));
}

/**
 * 모드별 숙련도 집계 — 세션을 mode로 가른 뒤 각 그룹에 aggregateWordStats를 돌린다.
 * 반환은 네 모드 키가 모두 있는 `{ [mode]: { [key]: WordStat } }`. 어떤 모드도 서로의 통계에 섞이지 않는다(무오염).
 * **sessions는 startedAt 오름차순**이어야 한다(streak의 시간 축 — vocab-mastery 계약).
 */
export function aggregateToeicStatsByMode(
  sessions: readonly ToeicQuizSessionLike[],
): Record<ToeicQuizMode, Record<string, WordStat>> {
  const out = {} as Record<ToeicQuizMode, Record<string, WordStat>>;
  for (const mode of TOEIC_QUIZ_MODES) {
    out[mode] = aggregateWordStats(toVocabQuizRecords(sessions.filter((s) => s.mode === mode)));
  }
  return out;
}

/** 모드별 오답 후보(오답노트 모드 탭) — 그 모드 세션만으로 buildReviewCandidates. 다른 모드는 영향 없음. */
export function buildToeicReviewCandidatesByMode(
  sessions: readonly ToeicQuizSessionLike[],
  mode: ToeicQuizMode,
): ReviewCandidate[] {
  return buildReviewCandidates(toVocabQuizRecords(sessions.filter((s) => s.mode === mode)));
}

/** 오답 재시험(`?wrong=<mode>`) 대상 키 — 그 모드에서 틀린 적 있고 아직 졸업(연속 2회 정답) 전인 것 */
export function toeicWrongKeys(sessions: readonly ToeicQuizSessionLike[], mode: ToeicQuizMode): Set<string> {
  const stats = aggregateToeicStatsByMode(sessions)[mode];
  const out = new Set<string>();
  for (const [key, st] of Object.entries(stats)) if (st.wrong > 0 && !isStatMastered(st)) out.add(key);
  return out;
}

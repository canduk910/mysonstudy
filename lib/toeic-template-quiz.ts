/**
 * lib/toeic-template-quiz.ts — 유형별 공략 **③ 틀 시험**(보고 고르기·빈칸) 순수 함수 (docs/harness/toeic.md §12-13-2 — 2026-10-02)
 *
 * 유형 폴더의 ③ 탭이 교재 표현 시험 대신 **틀**을 시험한다 — 한국어 틀 → 영어 틀 5지선다(tpl-ko-frame), 영어 틀 → 뜻 5지선다
 * (tpl-frame-ko), 틀 고정 낱말 빈칸(tpl-cloze, 낱말 5지선다). ② 틀 테스트(말하기)를 보완하는 "보는 눈·손" 연습이다. AI 0.
 * 출제(문항·보기·빈칸 낱말)·숙련도·오답·최근 기록·저장 본문을 **여기 한 곳**에 둔다 — 서버 페이지·화면·eval이 같은 함수를 본다.
 *
 * - 고르기 두 모드는 자리 이름을 `~`로 가린다(영어·한국어 틀은 자리 이름 모임이 같다 — 이름만 맞춰 고를 수 없게). 빈칸은 이름을 보인다.
 * - 통계는 ② 말하기 두 모드와 **분리**한다(같은 날 ○ 접기 길은 lib/toeic-template.ts aggregateTemplateStatsByModes 하나 — 모드 목록만 다르다).
 * - 보기는 은우 공유 함수 buildChoices(lib/vocab-quiz.ts)를 **그대로** 쓴다 — 오답 후보는 넘기기 전에 여기서 거른다(같은 뜻·중복·같은 낱말).
 *
 * ⚠️ 클라이언트 번들 안전(번들 경계 목록 등록): 런타임 import는 lib/toeic-template·lib/toeic-quiz·lib/toeic-text·lib/vocab-quiz·
 * lib/vocab-mastery·lib/kst뿐, lib/ai·계약 파일은 `import type`만. 정규식 lookbehind 금지(구형 iOS Safari).
 * 순환 금지: lib/toeic-template·lib/toeic-quiz는 이 모듈을 import하지 않는다.
 */

import { buildChoices, DEFAULT_CHOICE_COUNT, type Rng } from "./vocab-quiz";
import { isStatMastered, type WordStat } from "./vocab-mastery";
import { formatKst } from "./kst";
import { collapseSpaces, matchKey } from "./toeic-text";
import {
  TOEIC_CHOICE_MIN,
  TOEIC_TEMPLATE_CHOICE_MODES,
  isToeicTemplateChoiceMode,
  weaknessRank,
  type ToeicQuizSessionLike,
  type ToeicTemplateChoiceMode,
} from "./toeic-quiz";
import {
  aggregateTemplateStatsByModes,
  frameSlotNames,
  frameToExpression,
  normalizeTemplateWords,
  sameTemplateWord,
  templateAttemptCounts,
  templateBadgesByModes,
  templateItemKey,
  templateKeyFromItemKey,
  type ToeicTemplateBadge,
} from "./toeic-template";
import type { ToeicTemplate, ToeicTemplateFlow } from "./ai/toeic/schemas";
import type { ToeicTemplateSessionRequest } from "./toeic-guide-contract";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/**
 * 틀 시험 한 판 최대 문항(§12-13-2) — 기록 라우트 zod의 고르기 모드 `items` 상한도 이 값이다. 이름이 `…_CHOICE_MAX`인 까닭(검토 S12):
 * 기존 TOEIC_TEMPLATE_QUIZ_MODES가 ② 말하기 두 모드라 `QUIZ_MAX`로 두면 라우트 상한 갈래에서 바꿔 쓰기 쉽다.
 */
export const TOEIC_TEMPLATE_CHOICE_MAX = 20;

/** 빈칸으로 가리지 않는 낱말 — 관사·주어 대명사(대소문자 무시). 축약형(`It's`)·전치사·be동사는 후보다(전치사 하나가 틀의 핵심인 경우가 많다) */
export const TOEIC_TEMPLATE_CLOZE_SKIP_WORDS = ["a", "an", "the", "i", "you", "he", "she", "we", "they", "it"] as const;

const ARTICLES: ReadonlySet<string> = new Set(["a", "an", "the"]);
const CLOZE_SKIP: ReadonlySet<string> = new Set(TOEIC_TEMPLATE_CLOZE_SKIP_WORDS);

// ---------------------------------------------------------------------------
// 표기
// ---------------------------------------------------------------------------

/** 한국어 틀의 `~` 형태 — `{…}`마다 `~`, 공백 접기. 고르기 두 모드의 문제·보기(자리 이름을 가린다 — 이름만 맞춰 고르지 않게) */
export function koFrameToTilde(frameKo: string): string {
  return collapseSpaces((frameKo ?? "").replace(/\{[^{}]*\}/g, "~"));
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// 빈칸 낱말 (§12-13-2 — 결정적)
// ---------------------------------------------------------------------------

interface FixedWord {
  /** 원문 낱말(앞뒤 문장부호를 뗀 것 — 빈칸 밖에 남는다) */
  text: string;
  start: number;
  end: number;
  /** normalizeTemplateWords(text) — 같은 낱말 판정용(축약형·대소문자) */
  norm: string[];
}

/** 틀 고정 부분의 낱말(위치 포함). 자리 `{…}`는 건너뛴다. 낱말 앞뒤의 문장부호(따옴표·쉼표·마침표 등)는 낱말에 넣지 않는다 */
function frameFixedWords(frameEn: string): FixedWord[] {
  const out: FixedWord[] = [];
  const segments: { text: string; start: number }[] = [];
  const slotRe = /\{[^{}]*\}/g;
  let pos = 0;
  for (let m = slotRe.exec(frameEn); m !== null; m = slotRe.exec(frameEn)) {
    if (m.index > pos) segments.push({ text: frameEn.slice(pos, m.index), start: pos });
    pos = m.index + m[0].length;
  }
  if (pos < frameEn.length) segments.push({ text: frameEn.slice(pos), start: pos });
  for (const seg of segments) {
    const tokRe = /\S+/g;
    for (let m = tokRe.exec(seg.text); m !== null; m = tokRe.exec(seg.text)) {
      const tok = m[0];
      const lead = (/^[^A-Za-z0-9]*/.exec(tok) ?? [""])[0].length;
      const trail = (/[^A-Za-z0-9]*$/.exec(tok) ?? [""])[0].length;
      if (lead + trail >= tok.length) continue;
      const text = tok.slice(lead, tok.length - trail);
      const start = seg.start + m.index + lead;
      out.push({ text, start, end: start + text.length, norm: normalizeTemplateWords(text) });
    }
  }
  return out;
}

/** 같은 낱말 — 편 낱말 배열끼리 길이가 같고 자리마다 sameTemplateWord(축약형 두 뜻·대소문자) */
function sameWordSeq(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((w, i) => sameTemplateWord(w, b[i]));
}

/** 빈칸 후보 낱말(위치 순) — 라틴 글자가 있고 관사·주어 대명사가 아니며 그 틀 고정 부분에 **한 번만** 나오는 낱말. 없으면 관사만 뺀 것 */
function clozeCandidates(frameEn: string): { words: FixedWord[]; candidates: FixedWord[] } {
  const words = frameFixedWords(frameEn);
  const once = (w: FixedWord) => words.filter((x) => sameWordSeq(x.norm, w.norm)).length === 1;
  const latin = words.filter((w) => /[A-Za-z]/.test(w.text) && w.norm.length > 0 && once(w));
  const primary = latin.filter((w) => !CLOZE_SKIP.has(w.text.toLowerCase()));
  return { words, candidates: primary.length > 0 ? primary : latin.filter((w) => !ARTICLES.has(w.text.toLowerCase())) };
}

/**
 * 빈칸으로 가릴 낱말(§12-13-2) — 후보[`attempts mod 후보 수`]. attempts = 그 틀의 `tpl-cloze` 시도 수(같은 날 ○ 접기 전 원래 수 —
 * templateAttemptCounts). 시도를 거듭하면 틀 전체의 고정 낱말을 돈다. before·after는 frameEn을 그 낱말 앞·뒤로 자른 글(자리 `{…}`는
 * 그대로 — 화면이 칩으로). 후보가 없으면 null(출제하지 않는다).
 */
export function templateClozeTarget(frameEn: string, attempts: number): { word: string; before: string; after: string } | null {
  const { candidates } = clozeCandidates(frameEn ?? "");
  if (candidates.length === 0) return null;
  const t = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  const w = candidates[t % candidates.length];
  return { word: w.text, before: frameEn.slice(0, w.start), after: frameEn.slice(w.end) };
}

/** 빈칸 자리의 대소문자 — before가 비었거나 여는 따옴표뿐이면 첫 글자 대문자, 아니면 소문자(두 글자 이상 모두 대문자인 약어와 `I`는 그대로) */
function caseForBlank(word: string, before: string): string {
  if (/^[A-Z]{2,}$/.test(word.replace(/[^A-Za-z]/g, "")) || word === "I") return word;
  if (/^["'“‘\s]*$/.test(before)) return word.charAt(0).toUpperCase() + word.slice(1);
  return word.toLowerCase();
}

// ---------------------------------------------------------------------------
// 문항 조립 (§12-13-2)
// ---------------------------------------------------------------------------

export interface ToeicTemplateChoiceQuestion {
  mode: ToeicTemplateChoiceMode;
  /** 틀 key — 기록 항목 키는 templateItemKey(key) */
  key: string;
  /** ko-frame: 한국어 틀 ~ 형태 / frame-ko: 영어 틀 ~ 형태 / cloze: 한국어 틀 ~ 형태(뜻 단서) */
  prompt: string;
  /** cloze만 — frameEn을 가린 낱말 앞·뒤로 자른 글(자리 {…}는 화면이 칩으로) */
  cloze: { before: string; after: string } | null;
  /** 문제 아래 작은 글씨 */
  groupKo: string;
  /** 2~5개, 섞인 순서 */
  choices: string[];
  /** choices 안의 한 글자열 */
  answer: string;
  /** 답한 뒤 틀 줄·🔊 */
  frameEn: string;
  /** 답한 뒤 한 줄 — examples[t mod n](t = 그 모드 시도 수) */
  example: { en: string; ko: string } | null;
}

export interface ToeicTemplateChoiceOptions {
  /** 낼 모드(부분집합). 기본 셋 다 */
  modes?: readonly ToeicTemplateChoiceMode[];
  /** 그 모드에서 틀렸고 미졸업인 틀만(모드도 그 하나) */
  onlyWrong?: ToeicTemplateChoiceMode;
  /** 한 판 상한(기본 TOEIC_TEMPLATE_CHOICE_MAX 20) */
  max?: number;
  rng?: Rng;
  /** 그 유형 흐름 — 오답 보기 ② 층(같은 단계의 다른 묶음)을 가른다. 없으면 ① 같은 묶음 → ③ 나머지 */
  flow?: Pick<ToeicTemplateFlow, "steps"> | null;
}

type ChoiceTemplate = Pick<ToeicTemplate, "key" | "groupKo" | "frameEn" | "frameKo" | "examples">;

/**
 * 오답 후보 틀을 층 순서로(§12-13-2) — ① 같은 묶음 ② 같은 단계의 다른 묶음 ③ 나머지, 층 안은 rng로 섞는다. 고르기 두 모드(bySlots)는
 * **자리 수가 정답과 같은 후보를 먼저**(층 순서 그대로 ①②③), 모자라면 자리 수가 다른 후보(①②③)로 채운다(검토 S6 — `~` 개수가 다른
 * 보기는 읽지 않고 지울 수 있다. 같은 묶음의 자리 수 다른 틀보다 다른 층의 자리 수 같은 틀이 먼저다 — §12-13-5 반례).
 */
function layeredOthers<T extends ChoiceTemplate>(t: T, pool: readonly T[], stepOfGroup: ReadonlyMap<string, string>, rng: Rng, bySlots: boolean): T[] {
  const others = pool.filter((o) => o.key !== t.key);
  const myStep = stepOfGroup.get(t.groupKo);
  const l1 = others.filter((o) => o.groupKo === t.groupKo);
  const l2 = others.filter((o) => o.groupKo !== t.groupKo && myStep !== undefined && stepOfGroup.get(o.groupKo) === myStep);
  const inL12 = new Set([...l1, ...l2].map((o) => o.key));
  const l3 = others.filter((o) => !inL12.has(o.key));
  const layered = [...shuffle(l1, rng), ...shuffle(l2, rng), ...shuffle(l3, rng)];
  if (!bySlots) return layered;
  const n = frameSlotNames(t.frameEn).length;
  return [...layered.filter((o) => frameSlotNames(o.frameEn).length === n), ...layered.filter((o) => frameSlotNames(o.frameEn).length !== n)];
}

/** 오답 보기 글자들 — 정답·서로와 matchKey가 같은 것을 접고, 앞에서 (보기 수 − 1)개 */
function pickDistractors(answer: string, candidates: readonly string[]): string[] {
  const seen = new Set<string>([matchKey(answer)]);
  const out: string[] = [];
  for (const c of candidates) {
    const k = matchKey(c);
    if (k === "" || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= DEFAULT_CHOICE_COUNT - 1) break;
  }
  return out;
}

function exampleAt(t: ChoiceTemplate, tries: number): { en: string; ko: string } | null {
  const list = Array.isArray(t.examples) ? t.examples : [];
  if (list.length === 0) return null;
  const e = list[tries % list.length];
  return { en: e.en, ko: e.ko };
}

function buildOneChoice<T extends ChoiceTemplate>(
  mode: ToeicTemplateChoiceMode,
  t: T,
  pool: readonly T[],
  stepOfGroup: ReadonlyMap<string, string>,
  tries: number,
  rng: Rng,
): ToeicTemplateChoiceQuestion | null {
  const koTilde = koFrameToTilde(t.frameKo);
  const enTilde = frameToExpression(t.frameEn);
  const base = { mode, key: t.key, groupKo: t.groupKo, frameEn: t.frameEn, example: exampleAt(t, tries) };
  const finish = (q: Omit<ToeicTemplateChoiceQuestion, "choices" | keyof typeof base> & { answer: string }, distractors: string[]): ToeicTemplateChoiceQuestion | null => {
    const choices = buildChoices(q.answer, distractors, DEFAULT_CHOICE_COUNT, rng);
    return choices.length < TOEIC_CHOICE_MIN ? null : { ...base, ...q, choices };
  };
  switch (mode) {
    case "tpl-ko-frame": {
      if (koTilde === "" || enTilde === "") return null;
      // 같은 뜻(한국어 ~ 형태가 같은 틀)은 둘 다 정답이 되므로 뺀다
      const others = layeredOthers(t, pool, stepOfGroup, rng, true).filter((o) => matchKey(koFrameToTilde(o.frameKo)) !== matchKey(koTilde));
      return finish({ prompt: koTilde, cloze: null, answer: enTilde }, pickDistractors(enTilde, others.map((o) => frameToExpression(o.frameEn))));
    }
    case "tpl-frame-ko": {
      if (koTilde === "" || enTilde === "") return null;
      const others = layeredOthers(t, pool, stepOfGroup, rng, true);
      return finish({ prompt: enTilde, cloze: null, answer: koTilde }, pickDistractors(koTilde, others.map((o) => koFrameToTilde(o.frameKo))));
    }
    case "tpl-cloze": {
      const target = templateClozeTarget(t.frameEn, tries);
      if (target === null || koTilde === "") return null;
      const own = frameFixedWords(t.frameEn);
      const answerNorm = normalizeTemplateWords(target.word);
      const otherForms = new Set(pool.filter((o) => o.key !== t.key).map((o) => matchKey(frameToExpression(o.frameEn))));
      const words: string[] = [];
      for (const o of layeredOthers(t, pool, stepOfGroup, rng, false)) {
        for (const w of clozeCandidates(o.frameEn).candidates) {
          if (sameWordSeq(w.norm, answerNorm)) continue; // 정답과 같은 낱말(축약형·대소문자)
          if (own.some((x) => sameWordSeq(x.norm, w.norm))) continue; // 이 틀 고정 부분에 이미 있는 낱말
          if (otherForms.has(matchKey(frameToExpression(`${target.before}${w.text}${target.after}`)))) continue; // 넣으면 다른 틀이 된다
          words.push(caseForBlank(w.text, target.before));
        }
      }
      const answer = caseForBlank(target.word, target.before);
      return finish({ prompt: koTilde, cloze: { before: target.before, after: target.after }, answer }, pickDistractors(answer, words));
    }
  }
}

/**
 * 틀 시험 한 판(§12-13-2). `scope` = 범위의 틀(흐름 순서), `partTemplates` = 그 유형 렌더 가능한 틀 전부(오답 보기 풀 — 범위가 묶음
 * 하나여도 보기는 유형 전체에서), `sessions` = 틀 은행 세션(startedAt 오름차순 — 모드 무관, 고르기 모드만 본다).
 * - (틀, 모드)마다 문항을 만들어 본다(못 만들면 skipped + 1). 순위는 **그 모드의** 통계로 weaknessRank → 오답 많은 순 → 무작위.
 * - **한 판에 한 틀 한 문항** — 틀마다 순위가 가장 앞선 모드 하나(같은 틀이 두 모드로 나오면 한쪽 보기가 다른 쪽 정답을 보인다).
 * - 같은 순위로 앞에서 max개 → 모드별로 묶어(한→영 → 영→뜻 → 빈칸) 묶음 안에서 한 번씩 섞는다.
 * 문항에 testFills 글자는 없다(정답 채움이 다른 화면으로 새지 않게). 같은 rng면 결정적.
 */
export function buildTemplateChoiceQuestions<T extends ChoiceTemplate>(
  scope: readonly T[],
  partTemplates: readonly T[],
  sessions: readonly ToeicQuizSessionLike[],
  opts: ToeicTemplateChoiceOptions = {},
): { questions: ToeicTemplateChoiceQuestion[]; skipped: number } {
  const rng = opts.rng ?? Math.random;
  const max = Math.max(0, Math.floor(opts.max ?? TOEIC_TEMPLATE_CHOICE_MAX));
  const wanted = opts.onlyWrong !== undefined ? [opts.onlyWrong] : (opts.modes ?? TOEIC_TEMPLATE_CHOICE_MODES);
  const modes = TOEIC_TEMPLATE_CHOICE_MODES.filter((m) => wanted.includes(m));
  const stats = aggregateToeicTemplateChoiceStats(sessions);
  const attempts = new Map(modes.map((m) => [m, templateAttemptCounts(sessions, m)] as const));

  const stepOfGroup = new Map<string, string>();
  for (const st of opts.flow?.steps ?? []) for (const g of st.groupsKo) if (!stepOfGroup.has(g)) stepOfGroup.set(g, st.stepKo);
  const dedupe = (list: readonly T[]): T[] => {
    const seen = new Set<string>();
    return list.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  };
  const pool = dedupe(partTemplates);
  let candidates = dedupe(scope);
  if (opts.onlyWrong !== undefined) {
    const wrong = toeicTemplateChoiceWrongKeys(sessions, opts.onlyWrong);
    candidates = candidates.filter((t) => wrong.has(t.key));
  }
  if (candidates.length === 0 || modes.length === 0 || max === 0) return { questions: [], skipped: 0 };

  const built: { q: ToeicTemplateChoiceQuestion; st: WordStat | undefined }[] = [];
  let skipped = 0;
  for (const t of candidates) {
    for (const m of modes) {
      const q = buildOneChoice(m, t, pool, stepOfGroup, attempts.get(m)?.get(t.key)?.count ?? 0, rng);
      if (q) built.push({ q, st: stats[m][t.key] });
      else skipped += 1;
    }
  }
  const ranked = shuffle(built, rng)
    .map((x, order) => ({ ...x, order }))
    .sort((a, b) => weaknessRank(a.st) - weaknessRank(b.st) || (b.st?.wrong ?? 0) - (a.st?.wrong ?? 0) || a.order - b.order);
  const taken = new Set<string>();
  const one: ToeicTemplateChoiceQuestion[] = [];
  for (const x of ranked) {
    if (taken.has(x.q.key)) continue;
    taken.add(x.q.key);
    one.push(x.q);
  }
  const picked = one.slice(0, max);
  const questions = modes.flatMap((m) => shuffle(picked.filter((q) => q.mode === m), rng));
  return { questions, skipped };
}

// ---------------------------------------------------------------------------
// 숙련도·오답노트·기록 (§12-13-2) — ② 말하기와 분리(같은 날 ○ 접기 길은 하나)
// ---------------------------------------------------------------------------

/** 고르기 세 모드 통계 → `{ [mode]: { [틀 key]: WordStat } }`. 말하기 세션은 들지 않는다. **sessions는 startedAt 오름차순** */
export function aggregateToeicTemplateChoiceStats(sessions: readonly ToeicQuizSessionLike[]): Record<ToeicTemplateChoiceMode, Record<string, WordStat>> {
  return aggregateTemplateStatsByModes(sessions, TOEIC_TEMPLATE_CHOICE_MODES);
}

/** 그 고르기 모드에서 틀렸고 미졸업인 틀 key */
export function toeicTemplateChoiceWrongKeys(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateChoiceMode): Set<string> {
  const stats = aggregateToeicTemplateChoiceStats(sessions)[mode];
  const out = new Set<string>();
  for (const [key, st] of Object.entries(stats)) if (st.wrong > 0 && !isStatMastered(st)) out.add(key);
  return out;
}

/** 고르기 세 모드 배지(§12-5-6 규칙 그대로 — 오늘 ○ 포함). `todayKst`는 화면이 kstTodayString()으로 넘긴다 */
export function toeicTemplateChoiceBadges(
  sessions: readonly ToeicQuizSessionLike[],
  todayKst: string,
): Record<ToeicTemplateChoiceMode, Record<string, ToeicTemplateBadge>> {
  return templateBadgesByModes(sessions, todayKst, TOEIC_TEMPLATE_CHOICE_MODES);
}

/**
 * ② 틀 카드의 "👀 ✕ n" 칩(§12-13-2) — 틀 key → 고르기 세 모드 중 그 틀이 틀린 틀(toeicTemplateChoiceWrongKeys)에 든 모드 수.
 * 0인 틀은 키가 없다(칩 없음). 고르기 졸업·진행 중은 세지 않는다(카드에서 말하기 숙련처럼 보이지 않게).
 */
export function toeicTemplateChoiceWrongModeCounts(sessions: readonly ToeicQuizSessionLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const mode of TOEIC_TEMPLATE_CHOICE_MODES) for (const k of toeicTemplateChoiceWrongKeys(sessions, mode)) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** 최근 틀 시험 한 줄 — 같은 startedAt의 모드 문서를 한 줄로 묶는다 */
export interface ToeicRecentTemplateChoiceTest {
  startedAt: string;
  whenKo: string;
  /** 이 판에 든 모드(한→영 → 영→뜻 → 빈칸 순) */
  modes: ToeicTemplateChoiceMode[];
  correct: number;
  answered: number;
  /** 모든 모드 문서가 끝까지 풀었는가(아니면 "그만둠") */
  finished: boolean;
}

/**
 * 최근 틀 시험(§12-13-2) — 그 유형 틀(partKeys)이 든 고르기 세션을 startedAt으로 묶어 최신 `max`판(기본 10). ○ n / 전체는 묶은 문서들의
 * 답한 문항 기준. 말하기 세션·답한 문항 0 세션은 뺀다.
 */
export function recentTemplateChoiceTests(sessions: readonly ToeicQuizSessionLike[], partKeys: ReadonlySet<string>, max = 10): ToeicRecentTemplateChoiceTest[] {
  const byStart = new Map<string, ToeicQuizSessionLike[]>();
  for (const s of sessions) {
    if (!isToeicTemplateChoiceMode(s.mode)) continue;
    if (!s.items.some((it) => it.answered === true && partKeys.has(templateKeyFromItemKey(it.word) ?? ""))) continue;
    const list = byStart.get(s.startedAt) ?? [];
    list.push(s);
    byStart.set(s.startedAt, list);
  }
  const starts = [...byStart.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return starts.slice(0, Math.max(0, max)).map((startedAt) => {
    const docs = byStart.get(startedAt) ?? [];
    const answered = docs.flatMap((d) => d.items.filter((it) => it.answered === true));
    return {
      startedAt,
      whenKo: formatKst(startedAt),
      modes: TOEIC_TEMPLATE_CHOICE_MODES.filter((m) => docs.some((d) => d.mode === m)),
      correct: answered.filter((it) => it.correct === true).length,
      answered: answered.length,
      finished: docs.every((d) => d.finishedAt !== null),
    };
  });
}

/**
 * 러너 저장 본문(§12-13-2 — 모드마다 한 건). 답한 문항만 싣고(answered true — 그만둬서 못 본 문항은 싣지 않는다), **답한 문항이 0인 모드는
 * 본문을 만들지 않는다**(빈 items는 라우트 zod `.min(1)`이 400 — "다시 저장"이 영영 실패한다). 판 전체가 0이면 빈 배열(저장하지 않는다).
 * clientSessionId는 시작할 때 모드마다 하나씩 만든 것, startedAt은 모두 같다. 같은 틀 두 번은 첫 답만.
 */
export function buildTemplateChoiceSessionBodies(args: {
  answers: readonly { mode: ToeicTemplateChoiceMode; key: string; correct: boolean }[];
  sessionIds: Readonly<Record<ToeicTemplateChoiceMode, string>>;
  startedAt: string;
  finishedAt: string | null;
}): ToeicTemplateSessionRequest[] {
  const out: ToeicTemplateSessionRequest[] = [];
  for (const mode of TOEIC_TEMPLATE_CHOICE_MODES) {
    const seen = new Set<string>();
    const items: ToeicTemplateSessionRequest["items"] = [];
    for (const a of args.answers) {
      if (a.mode !== mode || seen.has(a.key)) continue;
      seen.add(a.key);
      items.push({ word: templateItemKey(a.key), correct: a.correct, answered: true });
    }
    if (items.length === 0) continue;
    out.push({ clientSessionId: args.sessionIds[mode], mode, startedAt: args.startedAt, finishedAt: args.finishedAt, items });
  }
  return out;
}

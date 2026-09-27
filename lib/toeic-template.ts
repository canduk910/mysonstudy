/**
 * lib/toeic-template.ts — 토익스피킹 **템플릿(틀) 훈련** 순수 함수 (docs/harness/toeic.md §12-5·§12-7-9)
 *
 * 학습 단위는 **틀**(바꿔 끼울 `{자리}`가 있는 문장 뼈대)이다. 틀 채우기·`~` 형태·표시 분할·흐름 순서·교재 연결 표, 따라 말하기 대본·
 * 예상 시간·이어 듣기 위치, 전사 비교(축약형 두 뜻·숫자·관사), 테스트 문항 고르기·숙련도(같은 날 ○ 접기)·틀린 틀, 연습에 넘길 틀
 * 고르기·전사문 속 틀 찾기·단계 커버리지를 **여기 한 곳**에 둔다. 화면·라우트·zod(lib/ai/toeic/schemas.ts)·eval이 같은 함수를 본다.
 *
 * 경계(§12-5-9):
 * - 런타임 import는 lib/toeic-guide·lib/toeic-text·lib/toeic-score·lib/toeic-quiz·lib/vocab-mastery·lib/kst·lib/tts-split·
 *   lib/tts-shared뿐. lib/ai는 `import type`만(eval "번들 경계"가 잠근다). 정규식 lookbehind 금지(구형 iOS Safari).
 * - lib/toeic-guide·lib/toeic-quiz는 이 모듈을 import하지 않는다(순환 금지).
 * - 약함 순위(weaknessRank)와 세션 어댑터(toeicSessionsToVocabRecords)는 표현 시험 모듈의 것을 **그대로** 부른다(검토 B3 — 사본 없음).
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { splitForTts } from "./tts-split";
import {
  TOEIC_SHADOW_PAUSE,
  TOEIC_SHADOW_PAUSE_LEVELS,
  TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT,
  cleanGuideEnForTts,
  cleanGuideKoForTts,
  scanSlots,
  shadowPauseMs,
  type ToeicGuidePart,
  type ToeicShadowPauseLevel,
} from "./toeic-guide";
import { collapseSpaces, countWords, expressionKey, matchKey } from "./toeic-text";
import { alignWordSeq, normalizeReadWords } from "./toeic-score";
import {
  TOEIC_TEMPLATE_QUIZ_MODES,
  toeicSessionsToVocabRecords,
  weaknessRank,
  type ToeicQuizSessionLike,
  type ToeicTemplateQuizMode,
} from "./toeic-quiz";
import { aggregateWordStats, isStatMastered, type WordStat } from "./vocab-mastery";
import { kstDateString } from "./kst";
import type { Rng } from "./vocab-quiz";
import type { ToeicGuideFileEntry, ToeicTemplate, ToeicTemplateFlow } from "./ai/toeic/schemas";

export { TOEIC_SHADOW_PAUSE, TOEIC_SHADOW_PAUSE_LEVELS, TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT, shadowPauseMs };
export type { ToeicShadowPauseLevel };

// ---------------------------------------------------------------------------
// 상수 (§12-5-9 — 화면·라우트·eval이 import한다. 숫자를 다시 적지 않는다)
// ---------------------------------------------------------------------------

/** 따라 말하기 영어 반복 기본값·범위(§12-5-2) */
export const TOEIC_SHADOW_REPEAT_DEFAULT = 4;
export const TOEIC_SHADOW_REPEAT_MIN = 1;
export const TOEIC_SHADOW_REPEAT_MAX = 4;
/** 예상 시간 추정(§12-5-2 검토 S3) — 영어 낱말 × 380ms, 한국어 글자(공백 뺌) × 180ms, 조각 사이 300ms */
export const TOEIC_SHADOW_ESTIMATE = { enPerWordMs: 380, koPerCharMs: 180, gapMs: 300 } as const;
/** 틀 테스트 한 판 최대 문항(§12-5-3) */
export const TOEIC_TEMPLATE_TEST_MAX = 10;
/** 한 판 안 복습 칸 — 졸업한 틀 중 마지막 시도가 가장 오래된 것(§12-5-3 검토 S9) */
export const TOEIC_TEMPLATE_TEST_REVIEW_SLOTS = 2;
/** 제안 ○ 기준 — 틀 정확도(§12-5-5) */
export const TOEIC_TEMPLATE_SUGGEST_MIN = 0.85;
/** 녹음 상한·하한(§12-5-3·§12-5-4) */
export const TOEIC_TEMPLATE_REC_MAX_MS = 20_000;
export const TOEIC_TEMPLATE_REC_MIN_MS = 600;
/** 받아쓰기 상한 — 문항당 2회(처음 + 유효하지 않은 시도 뒤 다시 1회), 세션당 20회(§12-5-4) */
export const TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION = 2;
export const TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION = 20;
/** 화면의 받아쓰기 요청 타임아웃 — 관문 T(30초 × 재시도 1)가 Hosting 60초를 넘기지 않게(§12-5-4 검토 개선 8) */
export const TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS = 45_000;
/** 연습에 넘길 틀 최대 수(§12-7-2) */
export const TOEIC_DRILL_TEMPLATES_MAX = 10;
/** "빠진 단계"를 보이는 유형 — 한 답이 흐름 전체를 지나야 하는 유형만(§12-7-9) */
export const TOEIC_TEMPLATE_FLOW_CHECK_PARTS = ["q3_4", "q11"] as const satisfies readonly ToeicGuidePart[];
/** "쓸 수 있었던 틀" 최대 수(§12-7-9) */
export const TOEIC_TEMPLATE_SUGGESTIONS_MAX = 5;
/** 흐름에 없는 묶음의 틀을 모으는 자리 이름(§12-5-1 — zod가 막지만 정규화된 옛 문서 방어) */
export const TOEIC_TEMPLATE_OTHER_GROUP_KO = "기타";

/** 틀 key 형식(§12-2-7 zod) */
export const TOEIC_TEMPLATE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** 틀 테스트 세션의 항목 키 = `tpl:{key}`(§12-5-6) */
export const TOEIC_TEMPLATE_ITEM_PREFIX = "tpl:";
export const TOEIC_TEMPLATE_ITEM_KEY_RE = /^tpl:[a-z0-9][a-z0-9-]{0,39}$/;

export function templateItemKey(key: string): string {
  return `${TOEIC_TEMPLATE_ITEM_PREFIX}${key}`;
}
/** `tpl:{key}` → key. 틀 항목 키가 아니면 null */
export function templateKeyFromItemKey(word: string): string | null {
  return word.startsWith(TOEIC_TEMPLATE_ITEM_PREFIX) ? word.slice(TOEIC_TEMPLATE_ITEM_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// 틀 쪼개기·채우기·`~` 형태 (§12-2-7·§12-5-7)
// ---------------------------------------------------------------------------

export type ToeicFramePart = { kind: "fixed"; text: string } | { kind: "slot"; name: string; index: number };

/** 틀을 고정 조각과 자리로 나눈다(자리 순서 index). 짝이 맞은 자리만 자리로 본다. */
export function parseFrame(frame: string): ToeicFramePart[] {
  const { slots } = scanSlots(frame);
  const parts: ToeicFramePart[] = [];
  let pos = 0;
  slots.forEach((s, i) => {
    if (s.start > pos) parts.push({ kind: "fixed", text: frame.slice(pos, s.start) });
    parts.push({ kind: "slot", name: s.name, index: i });
    pos = s.end;
  });
  if (pos < frame.length) parts.push({ kind: "fixed", text: frame.slice(pos) });
  return parts;
}

/** 자리 이름들(자리 순서) */
export function frameSlotNames(frame: string): string[] {
  return scanSlots(frame).slots.map((s) => s.name);
}

/**
 * i번째 `{…}`를 fills[i]로 바꾼다 — **대소문자를 고치지 않는다**(문장 첫 자리 채움은 원본이 대문자로 적는다, 정렬 규칙 11).
 * 예문은 이 결과와 글자까지 같아야 한다(zod). fills가 모자라면 남은 자리는 그대로 둔다.
 */
export function fillFrame(frameEn: string, fills: readonly string[]): string {
  let i = 0;
  return frameEn.replace(/\{[^{}]*\}/g, (m) => {
    const v = i < fills.length ? fills[i] : m;
    i += 1;
    return v;
  });
}

/**
 * 틀 → 교재 쪽 `~` 표기(§12-5-7): 자리마다 `~`, 공백 접기, 끝의 마침표 하나 떼기(`?`는 그대로).
 * 연습의 "활용할 표현"·C·D 출력 되짚기·① 탭 줄 머리 🧩 칩이 이 글자를 쓴다.
 */
export function frameToExpression(frameEn: string): string {
  let s = collapseSpaces(frameEn.replace(/\{[^{}]*\}/g, "~"));
  if (s.endsWith(".")) s = s.slice(0, -1).trimEnd();
  return s;
}

export interface ToeicFrameDisplaySegment {
  /** 원문 조각(이어 붙이면 원문 — 자리 조각은 `{이름}` 그대로) */
  text: string;
  /** 자리 순서(0부터). 고정 조각이면 null */
  slot: number | null;
  /** 자리 이름(칩 글자). 고정 조각이면 null */
  name: string | null;
}

/** 틀 줄 표시 — 고정 부분은 굵게, 자리는 자리 칩(자리 순서마다 다른 색). 영어·한국어 틀 모두 */
export function splitFrameForDisplay(frame: string): ToeicFrameDisplaySegment[] {
  const { slots } = scanSlots(frame);
  const out: ToeicFrameDisplaySegment[] = [];
  let pos = 0;
  slots.forEach((s, i) => {
    if (s.start > pos) out.push({ text: frame.slice(pos, s.start), slot: null, name: null });
    out.push({ text: frame.slice(s.start, s.end), slot: i, name: s.name });
    pos = s.end;
  });
  if (pos < frame.length) out.push({ text: frame.slice(pos), slot: null, name: null });
  return out;
}

export interface ToeicExampleDisplaySegment {
  text: string;
  /** 채움 i 구간이면 i, 틀 고정 조각이면 null */
  slot: number | null;
}

/** 예문 표시 — 틀 고정 조각과 채움 i 구간(예문 = fillFrame(frameEn, fills)이라 위치가 결정적이다). 이어 붙이면 예문 */
export function splitExampleByFills(frameEn: string, fills: readonly string[]): ToeicExampleDisplaySegment[] {
  const out: ToeicExampleDisplaySegment[] = [];
  for (const p of parseFrame(frameEn)) {
    if (p.kind === "fixed") out.push({ text: p.text, slot: null });
    else out.push({ text: p.index < fills.length ? fills[p.index] : `{${p.name}}`, slot: p.index });
  }
  return out.filter((s) => s.text !== "");
}

// ---------------------------------------------------------------------------
// 전사 비교 정규화 (§12-5-5)
// ---------------------------------------------------------------------------

/** 대안 낱말 구분자 — `is|has`는 둘 중 하나와 맞으면 같은 낱말 */
const ALT_SEP = "|";
/** 두 뜻 `'s`를 대안으로 푸는 대명사·지시어·의문사 */
const S_ALT_WORDS = "it|that|there|here|what|who|where|he|she|how|when|why";

/**
 * 축약형 풀기 — 아포스트로피가 지워지기 **전에** 푼다(곧은·둥근 아포스트로피 둘 다). 두 뜻 축약형은 대안 낱말로
 * (`it's` → `it is|has`, `'d` → `would|had`). 명사 소유격 `'s`는 풀지 않는다(아포스트로피만 뒤에서 지워진다).
 */
export function expandContractions(text: string): string {
  return (text ?? "")
    .replace(/[’‘`´]/g, "'")
    .replace(/\bcan't\b/gi, "can not")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bshan't\b/gi, "shall not")
    .replace(/\bcannot\b/gi, "can not")
    .replace(/n't\b/gi, " not")
    .replace(/\blet's\b/gi, "let us")
    .replace(/'m\b/gi, " am")
    .replace(/'re\b/gi, " are")
    .replace(/'ve\b/gi, " have")
    .replace(/'ll\b/gi, " will")
    .replace(new RegExp(`\\b(${S_ALT_WORDS})'s\\b`, "gi"), `$1 is${ALT_SEP}has`)
    .replace(/'d\b/gi, ` would${ALT_SEP}had`);
}

/**
 * 틀 비교용 낱말 배열 = 축약형 풀기 → normalizeReadWords(§5-4 — 소문자·문장부호 제거·0~100 숫자 통일·`p.m.` 접기·아포스트로피 삭제).
 * 대안 낱말(`is|has`)은 정규화를 지나는 동안 자리표로 지켰다가 되돌린다.
 */
export function normalizeTemplateWords(text: string): string[] {
  const alts: string[] = [];
  const guarded = expandContractions(text).replace(/\b([A-Za-z]+)\|([A-Za-z]+)\b/g, (_m, x: string, y: string) => {
    alts.push(`${x.toLowerCase()}${ALT_SEP}${y.toLowerCase()}`);
    return ` qxaltq${alts.length - 1}q `;
  });
  return normalizeReadWords(guarded).map((w) => {
    const m = /^qxaltq(\d+)q$/.exec(w);
    return m ? (alts[Number(m[1])] ?? w) : w;
  });
}

/** 낱말 같음 — 대안 낱말(`is|has`)은 겹치는 뜻이 하나라도 있으면 같다 */
export function sameTemplateWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.includes(ALT_SEP) && !b.includes(ALT_SEP)) return false;
  const bs = new Set(b.split(ALT_SEP));
  return a.split(ALT_SEP).some((x) => bs.has(x));
}

const ARTICLES = new Set(["a", "an", "the"]);

// ---------------------------------------------------------------------------
// 전사 비교 (§12-5-5)
// ---------------------------------------------------------------------------

export interface TemplateCompareWord {
  word: string;
  role: "fixed" | "slot";
  /** 자리 낱말이면 자리 순서, 고정 낱말이면 null */
  slot: number | null;
  status: "ok" | "wrong" | "missing";
  heard: string | null;
}

export interface TemplateSlotCheck {
  slot: number;
  /** 그 자리 앞뒤의 맞은 고정 낱말 사이에 관사가 아닌 들은 낱말이 있는가(너그럽게) */
  filled: boolean;
  /** 참고 — 자리 낱말(관사 뺌) 중 그대로 들은 수 / 전체 */
  matched: number;
  total: number;
}

export interface TemplateAnswerCheck {
  /** 기대 낱말(정규화) — 고정·자리 */
  words: TemplateCompareWord[];
  /** 들은 낱말(정규화) */
  heard: string[];
  /** 맞은 고정 낱말 ÷ 고정 낱말 수 — 핵심 지표 */
  frameAccuracy: number;
  fixedTotal: number;
  missingFixed: string[];
  wrongFixed: { expected: string; heard: string }[];
  slots: TemplateSlotCheck[];
  /** 더한 말(표시만 — 점수에 들지 않는다) */
  extra: string[];
  noSpeech: boolean;
  /** 제안(최종 ○/✕는 아빠가 정한다) */
  suggest: "pass" | "fail";
}

/**
 * 틀 비교(§12-5-5) — 틀 고정 부분과 자리를 따로 본다.
 * 1. 기대 낱말열: 고정 조각은 normalizeTemplateWords로 고정 낱말, 자리 i는 fills[i]를 같은 함수로(관사 a·an·the는 뺀다 — 자리 안의
 *    관사는 채점하지 않는다. 고정 부분의 관사는 본다).
 * 2. 들은 낱말열: normalizeTemplateWords(transcript).
 * 3. alignWordSeq(…, sameTemplateWord, 치환 비용 2 — 맞은 낱말 수를 최대화, 어순이 바뀐 두 낱말은 "빠짐 1 + 더함 1").
 * 4. frameAccuracy = 맞은 고정 낱말 ÷ 고정 낱말 수.
 * 5. 자리 filled = 앞뒤의 맞은 고정 낱말(없으면 문장 처음·끝) 사이 들은 낱말 중 관사가 아닌 것이 하나라도 있는가.
 * 6. suggest = 들은 말이 있고 frameAccuracy ≥ 0.85이고 모든 자리 filled면 "pass".
 */
export function compareTemplateAnswer(frameEn: string, fills: readonly string[], transcript: string): TemplateAnswerCheck {
  const words: Omit<TemplateCompareWord, "status" | "heard">[] = [];
  /** 자리 i의 기대 낱말 구간 [start, end) — 채움이 관사뿐이면 빈 구간(위치는 남는다) */
  const slotSpan = new Map<number, { start: number; end: number }>();
  for (const p of parseFrame(frameEn)) {
    if (p.kind === "fixed") {
      for (const w of normalizeTemplateWords(p.text)) words.push({ word: w, role: "fixed", slot: null });
    } else {
      const start = words.length;
      const fill = p.index < fills.length ? fills[p.index] : "";
      for (const w of normalizeTemplateWords(fill)) if (!ARTICLES.has(w)) words.push({ word: w, role: "slot", slot: p.index });
      slotSpan.set(p.index, { start, end: words.length });
    }
  }
  const heard = normalizeTemplateWords(transcript ?? "");
  const aligned = alignWordSeq(
    words.map((w) => w.word),
    heard,
    sameTemplateWord,
    { substitutionCost: 2 },
  );
  const full: TemplateCompareWord[] = words.map((w, i) => ({ ...w, status: aligned.expected[i].status, heard: aligned.expected[i].heard }));
  const fixed = full.filter((w) => w.role === "fixed");
  const fixedOk = fixed.filter((w) => w.status === "ok").length;
  const frameAccuracy = fixed.length === 0 ? 0 : fixedOk / fixed.length;
  const okFixedHeardAt = (k: number): number | null =>
    full[k].role === "fixed" && full[k].status === "ok" ? aligned.expected[k].heardIndex : null;

  const slots: TemplateSlotCheck[] = [];
  for (const [s, span] of [...slotSpan.entries()].sort((a, b) => a[0] - b[0])) {
    // 경계 = 자리 앞뒤의 가장 가까운 맞은 고정 낱말(바로 앞뒤가 빠졌으면 더 멀리, 없으면 문장 처음·끝)
    let start = 0;
    for (let k = span.start - 1; k >= 0; k--) {
      const at = okFixedHeardAt(k);
      if (at !== null) {
        start = at + 1;
        break;
      }
    }
    let end = heard.length;
    for (let k = span.end; k < full.length; k++) {
      const at = okFixedHeardAt(k);
      if (at !== null) {
        end = at;
        break;
      }
    }
    const filled = heard.slice(start, Math.max(start, end)).some((w) => !ARTICLES.has(w));
    let matched = 0;
    for (let k = span.start; k < span.end; k++) if (full[k].status === "ok") matched++;
    slots.push({ slot: s, filled, matched, total: span.end - span.start });
  }

  const noSpeech = heard.length === 0;
  const suggest = !noSpeech && frameAccuracy >= TOEIC_TEMPLATE_SUGGEST_MIN && slots.every((x) => x.filled) ? "pass" : "fail";
  return {
    words: full,
    heard,
    frameAccuracy,
    fixedTotal: fixed.length,
    missingFixed: fixed.filter((w) => w.status === "missing").map((w) => w.word),
    wrongFixed: fixed.filter((w) => w.status === "wrong").map((w) => ({ expected: w.word, heard: w.heard ?? "" })),
    slots,
    extra: aligned.extra.map((x) => x.word),
    noSpeech,
    suggest,
  };
}

/** 같은 뜻 교재 틀(대안) 대조 결과 */
export interface TemplateAlternativeCheck {
  check: TemplateAnswerCheck;
  /** 가장 잘 맞은 틀의 key — 물은 틀이거나 대안 */
  matchedKey: string;
  /** 대안으로 맞았는가(화면이 "같은 뜻의 다른 교재 틀로 말했어요"와 그 틀 줄을 보인다) */
  viaAlternative: boolean;
}

type FrameLike = Pick<ToeicTemplate, "key" | "frameEn" | "frameKo">;

/** 같은 유형 안에서 한국어 틀이 글자까지 같고(trim) 자리 수가 같은 다른 틀(§12-5-5 검토 S6) */
export function templateAlternatives<T extends FrameLike>(asked: FrameLike, sameTypeTemplates: readonly T[]): T[] {
  const ko = asked.frameKo.trim();
  const n = frameSlotNames(asked.frameEn).length;
  return sameTypeTemplates.filter((t) => t.key !== asked.key && t.frameKo.trim() === ko && frameSlotNames(t.frameEn).length === n);
}

/**
 * (가) 예문 말하기의 대안 대조 — 물은 틀과 대안마다 같은 채움으로 비교해 틀 정확도가 가장 높은 결과를 쓴다(같으면 제안 ○ 쪽,
 * 그다음 물은 틀). 기록 키는 호출측이 물은 틀로 남긴다. (나) 틀 바꿔 말하기에는 쓰지 않는다(예문 소리로 틀을 이미 들었다).
 */
export function compareWithAlternatives(
  asked: FrameLike,
  alternatives: readonly FrameLike[],
  fills: readonly string[],
  transcript: string,
): TemplateAlternativeCheck {
  const askedCheck = compareTemplateAnswer(asked.frameEn, fills, transcript);
  let best: TemplateAlternativeCheck = { check: askedCheck, matchedKey: asked.key, viaAlternative: false };
  for (const alt of templateAlternatives(asked, alternatives)) {
    const c = compareTemplateAnswer(alt.frameEn, fills, transcript);
    const better =
      c.frameAccuracy > best.check.frameAccuracy || (c.frameAccuracy === best.check.frameAccuracy && c.suggest === "pass" && best.check.suggest !== "pass");
    if (better) best = { check: c, matchedKey: alt.key, viaAlternative: true };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 교재 틀 고정 부분 대조 — 가져오기 zod(§12-2-7)가 쓴다
// ---------------------------------------------------------------------------

/** 틀의 고정 조각들(자리로 끊은 것)을 정규화한 낱말 배열들 — 빈 조각은 뺀다 */
export function frameFixedWordRuns(frameEn: string): string[][] {
  return parseFrame(frameEn)
    .filter((p): p is { kind: "fixed"; text: string } => p.kind === "fixed")
    .map((p) => normalizeTemplateWords(p.text))
    .filter((ws) => ws.length > 0);
}

/** 틀 머리부터의 낱말열(고정 낱말과 자리) — 머리 사례 판정용 */
function frameTokenSeq(frameEn: string): ({ kind: "word"; word: string } | { kind: "slot" })[] {
  const out: ({ kind: "word"; word: string } | { kind: "slot" })[] = [];
  for (const p of parseFrame(frameEn)) {
    if (p.kind === "fixed") for (const w of normalizeTemplateWords(p.text)) out.push({ kind: "word", word: w });
    else out.push({ kind: "slot" });
  }
  return out;
}

/** needle 낱말열이 hay 안에 from 이후로 이어서 있는 첫 위치(없으면 -1) */
function findRun(hay: readonly string[], needle: readonly string[], from: number, eq: (a: string, b: string) => boolean): number {
  if (needle.length === 0) return from;
  for (let i = Math.max(0, from); i + needle.length <= hay.length; i++) {
    let j = 0;
    while (j < needle.length && eq(needle[j], hay[i + j])) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** 슬래시 대안(`a/b`)을 펼친 글자들 — 낱말 단위 곱, 최대 max개 */
export function expandSlashAlternatives(text: string, max = 16): string[] {
  const tokens = (text ?? "").split(/\s+/).filter((t) => t !== "");
  let acc: string[] = [""];
  for (const t of tokens) {
    const alts = t.includes("/") ? t.split("/").filter((x) => x !== "") : [t];
    const next: string[] = [];
    for (const a of acc) for (const b of alts.length > 0 ? alts : [t]) if (next.length < max) next.push(a === "" ? b : `${a} ${b}`);
    acc = next;
  }
  return acc.filter((s) => s !== "");
}

/**
 * 교재 표현(`~`·첫 낱말이 아닌 `A`·`B` 자리)의 고정 부분이 틀에 온전히 들어 있는가(§12-2-7 zod).
 * 표현을 자리에서 끊은 조각마다, 그 조각의 낱말이 틀의 **한 고정 구간 안에 이어서, 순서대로** 있어야 한다(normalizeTemplateWords
 * 기준 — 대소문자·문장부호·축약형 차이는 같게 본다). 표현이 **소문자로 시작하는 동사 연어**면 첫 조각의 첫 낱말은 -s·-es·-ed·-d
 * 꼴도 같게 본다(틀 문장에서 동사가 활용된다 — 불규칙 활용은 거부).
 */
export function expressionFixedPartsInFrame(expression: string, frameEn: string): boolean {
  const tokens = (expression ?? "").trim().split(/\s+/).filter((t) => t !== "");
  const chunks: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    const ws = normalizeTemplateWords(cur.join(" "));
    if (ws.length > 0) chunks.push(ws);
    cur = [];
  };
  tokens.forEach((tok, i) => {
    const bare = tok.replace(/^[^A-Za-z~～〜]+|[^A-Za-z~～〜]+$/g, "");
    if (i > 0 && (bare === "A" || bare === "B")) {
      flush();
      return;
    }
    // 낱말 안의 물결(`~'s` 같은 것)도 자리 경계로 끊는다
    const pieces = tok.split(/[~～〜]/);
    pieces.forEach((pc, k) => {
      if (k > 0) flush();
      if (pc !== "") cur.push(pc);
    });
  });
  flush();
  const runs = frameFixedWordRuns(frameEn);
  const verbPhrase = /^[a-z]/.test((expression ?? "").trim());
  const inflects = (base: string, w: string) => base === w || w === `${base}s` || w === `${base}es` || w === `${base}ed` || w === `${base}d`;
  // 조각마다 (구간, 위치) 순서대로 — 앞 조각이 끝난 뒤에서 찾는다(같은 구간의 뒤쪽이거나 뒤 구간)
  let runIdx = 0;
  let pos = 0;
  for (let c = 0; c < chunks.length; c++) {
    const needle = chunks[c];
    const lenient = c === 0 && verbPhrase;
    const eq = (a: string, b: string, k: number): boolean => sameTemplateWord(a, b) || (lenient && k === 0 && inflects(a, b));
    let found = false;
    for (let r = runIdx; r < runs.length && !found; r++) {
      const hay = runs[r];
      const from = r === runIdx ? pos : 0;
      for (let i = from; i + needle.length <= hay.length; i++) {
        let j = 0;
        while (j < needle.length && eq(needle[j], hay[i + j], j)) j++;
        if (j === needle.length) {
          runIdx = r;
          pos = i + needle.length;
          found = true;
          break;
        }
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * 이어 말하기 머리말이 틀에 이어지는가(§12-2-7 정렬 규칙 3) — (a) **포함**: 머리말 낱말이 틀의 한 고정 구간 안에 이어서 있다,
 * (b) **머리 사례**: 머리말이 틀 머리(처음부터)의 자리를 채운 한 사례다 — 고정 낱말은 그대로 맞고 자리는 머리말 낱말 1개 이상을
 * 받으며, 머리말 끝까지 맞추고, 맞춘 고정 낱말이 2개 이상. 머리말의 `a/b` 낱말 대안은 둘 중 하나와 맞으면 된다.
 */
export function leadMatchesFrame(leadEn: string, frameEn: string): boolean {
  const runs = frameFixedWordRuns(frameEn);
  const seq = frameTokenSeq(frameEn);
  for (const variant of expandSlashAlternatives(leadEn)) {
    const lead = normalizeTemplateWords(variant);
    if (lead.length === 0) continue;
    if (runs.some((run) => findRun(run, lead, 0, sameTemplateWord) >= 0)) return true;
    if (headInstance(lead, seq, 0, 0, 0)) return true;
  }
  return false;
}

/** 머리 사례 — lead[li..]를 seq[si..]에 맞춘다(자리는 1개 이상 흡수, 되짚기). fixed = 지금까지 맞춘 고정 낱말 수 */
function headInstance(lead: readonly string[], seq: readonly ({ kind: "word"; word: string } | { kind: "slot" })[], li: number, si: number, fixed: number): boolean {
  if (li === lead.length) return fixed >= 2;
  if (si === seq.length) return false;
  const t = seq[si];
  if (t.kind === "word") return sameTemplateWord(lead[li], t.word) ? headInstance(lead, seq, li + 1, si + 1, fixed + 1) : false;
  // 자리: 1개 이상 흡수. 머리말이 자리 안에서 끝나도 된다.
  for (let k = li + 1; k <= lead.length; k++) {
    if (headInstance(lead, seq, k, si + 1, fixed)) return true;
    if (k === lead.length && fixed >= 2) return true;
  }
  return false;
}

/**
 * 자리 있는 교재 표현인가(정렬 규칙 1 (a)) — `~`(`～`·`〜`) 또는 **첫 낱말이 아닌** 대문자 한 글자 `A`·`B` 자리가 있다.
 * 자리 없는 연결어·낱말 표현("In short" 같은 것)은 정렬 대상이 아니다.
 */
export function isGuideAlignmentExpression(expression: string): boolean {
  if (/[~～〜]/.test(expression)) return true;
  const tokens = expression.trim().split(/\s+/);
  return tokens.some((tok, i) => i > 0 && /^[^A-Za-z]*[AB][^A-Za-z]*$/.test(tok));
}

/**
 * 한 유형 공략 항목의 **정렬 대상**(§12-2-7 정렬 규칙 1) — (a) 자리 있는 표현 틀(표현 키로 하나), (b) 답변 틀 단계 = template 블록 줄의
 * label(같은 이름은 하나), (c) 이어 말하기 머리말 = completions 블록 lead.en(공백 정리 후 같은 글자는 하나). 문서 순서.
 * 가져오기 zod의 "정렬 빠짐 0"과 eval의 실제 파일 집계가 이 함수 하나를 쓴다.
 */
export function toeicGuideAlignmentTargets(entry: Pick<ToeicGuideFileEntry, "expressions" | "sections">): {
  expression: string[];
  template: string[];
  lead: string[];
} {
  const out = { expression: [] as string[], template: [] as string[], lead: [] as string[] };
  const seenExpr = new Set<string>();
  for (const e of entry.expressions) {
    if (!isGuideAlignmentExpression(e.expression)) continue;
    const k = expressionKey(e.expression);
    if (seenExpr.has(k)) continue;
    seenExpr.add(k);
    out.expression.push(e.expression);
  }
  const seenLabel = new Set<string>();
  const seenLead = new Set<string>();
  for (const sec of entry.sections) {
    for (const b of sec.blocks) {
      if (b.kind !== "lines") continue;
      if (b.style === "template") {
        for (const ln of b.lines) {
          const label = ln.label?.trim() ?? "";
          if (label === "" || seenLabel.has(label)) continue;
          seenLabel.add(label);
          out.template.push(label);
        }
      } else if (b.style === "completions" && b.lead?.en) {
        const k = collapseSpaces(b.lead.en);
        if (seenLead.has(k)) continue;
        seenLead.add(k);
        out.lead.push(b.lead.en);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 교재 연결 표 (§12-4 🧩 칩·§12-5-7)
// ---------------------------------------------------------------------------

export interface ToeicTemplateGuideLinks {
  /** 템플릿 줄 label(답변 틀 단계) → 틀 key들(파일 순서) */
  templateLabels: Map<string, string[]>;
  /** 이어 말하기 머리말(공백 정리) → 틀 key들 */
  leads: Map<string, string[]>;
  /** 교재 표현(expressionKey) → 틀 key들 */
  expressions: Map<string, string[]>;
}

function pushKey(map: Map<string, string[]>, k: string, key: string): void {
  const list = map.get(k);
  if (!list) map.set(k, [key]);
  else if (!list.includes(key)) list.push(key);
}

/** 한 유형 공략과 틀 은행의 연결 표 — guideRefs 배열을 모두 본다(① 탭 블록·줄 칩, ③ 탭 표현 칩이 같은 함수) */
export function templateLinksForGuide(bank: { items: readonly Pick<ToeicTemplate, "key" | "guideRefs">[] }, part: ToeicGuidePart): ToeicTemplateGuideLinks {
  const links: ToeicTemplateGuideLinks = { templateLabels: new Map(), leads: new Map(), expressions: new Map() };
  for (const t of bank.items) {
    for (const r of t.guideRefs ?? []) {
      if (r.part !== part) continue;
      if (r.kind === "template") pushKey(links.templateLabels, r.step, t.key);
      else if (r.kind === "lead") pushKey(links.leads, collapseSpaces(r.leadEn), t.key);
      else pushKey(links.expressions, expressionKey(r.expression), t.key);
    }
  }
  return links;
}

/**
 * ① 탭 줄 머리 🧩 칩 — list 블록의 머리말·줄 영어를 `~` 모양으로 바꾼 글자(frameToExpression과 같은 규칙)의 표현 키가 틀이 연결한
 * 교재 표현과 같으면 그 틀 key들. 슬래시 대안이 든 줄은 대안을 펼친 글자 중 하나가 맞으면 된다. 없으면 빈 배열.
 */
export function guideLineTemplateKeys(links: ToeicTemplateGuideLinks, en: string | null): string[] {
  if (!en) return [];
  const variants = en.includes("/") ? expandSlashAlternatives(en) : [en];
  for (const v of variants) {
    const hit = links.expressions.get(expressionKey(frameToExpression(v)));
    if (hit) return hit;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 흐름 순서 (§12-5-1)
// ---------------------------------------------------------------------------

export interface ToeicTemplateFlowGroup {
  groupKo: string;
  /** 단계 묶음이면 단계 이름, 소재·기타면 null */
  stepKo: string | null;
  kind: "step" | "bank" | "other";
  templates: ToeicTemplate[];
}

/**
 * 한 유형의 흐름 순서 — 그 유형 flows의 단계 순서 → 단계 안 묶음 순서 → 소재 묶음 순서 → 묶음 안은 파일 순서.
 * 틀은 parts에 그 유형이 든 것만. 흐름에 없는 묶음의 틀은 맨 뒤 "기타"로 모은다. 빈 묶음은 내지 않는다.
 * 목록·대본·테스트 재정렬·연습 틀 고르기가 이 함수 하나를 쓴다(렌더 불가 틀은 호출측이 먼저 뺀다).
 */
export function templateFlowOrder(bank: { flows: readonly ToeicTemplateFlow[]; items: readonly ToeicTemplate[] }, part: ToeicGuidePart): ToeicTemplateFlowGroup[] {
  const mine = bank.items.filter((t) => Array.isArray(t.parts) && t.parts.includes(part));
  const flow = bank.flows.find((f) => f.part === part);
  const groups: ToeicTemplateFlowGroup[] = [];
  const placed = new Set<string>();
  const add = (groupKo: string, stepKo: string | null, kind: ToeicTemplateFlowGroup["kind"]) => {
    if (placed.has(groupKo)) return;
    placed.add(groupKo);
    const templates = mine.filter((t) => t.groupKo === groupKo);
    if (templates.length > 0) groups.push({ groupKo, stepKo, kind, templates });
  };
  if (flow) {
    for (const st of flow.steps) for (const g of st.groupsKo) add(g, st.stepKo, "step");
    for (const g of flow.banksKo) add(g, null, "bank");
  }
  const rest = mine.filter((t) => !placed.has(t.groupKo));
  if (rest.length > 0) groups.push({ groupKo: TOEIC_TEMPLATE_OTHER_GROUP_KO, stepKo: null, kind: "other", templates: rest });
  return groups;
}

/** 흐름 순서로 편 틀 목록 */
export function flattenTemplateFlow(groups: readonly ToeicTemplateFlowGroup[]): ToeicTemplate[] {
  return groups.flatMap((g) => g.templates);
}

// ---------------------------------------------------------------------------
// 따라 말하기 대본·예상 시간·이어 듣기 (§12-5-2)
// ---------------------------------------------------------------------------

export interface ToeicShadowOptions {
  /** 영어 반복 1~4(기본 4) */
  repeat?: number;
  /** 따라 말할 틈(기본 켬) */
  pause?: boolean;
  pauseLevel?: ToeicShadowPauseLevel;
  /** 한국어 틀 소개(기본 켬) */
  intro?: boolean;
  /** 영어 틀 소개(기본 끔 — 검토 S16) */
  introEn?: boolean;
}

export interface ToeicShadowPiece {
  text: string;
  lang: "en-US" | "ko-KR";
  pauseAfterMs: number;
  /** 틀 key */
  key: string;
  /** 예문 번호. 틀 소개 조각은 null */
  example: number | null;
  /** 영어 반복 번호 1..N. 소개·한국어 조각은 0 */
  rep: number;
}

/** 반복 수를 1~4 정수로 */
export function clampShadowRepeat(n: number | undefined): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : TOEIC_SHADOW_REPEAT_DEFAULT;
  return Math.min(TOEIC_SHADOW_REPEAT_MAX, Math.max(TOEIC_SHADOW_REPEAT_MIN, v));
}

/**
 * 따라 말하기 대본(§12-5-2) — 틀마다: (intro) 한국어 틀 → (introEn) 영어 틀(자리 "…", 쉼 없음) → 예문마다 ko 한 조각 → en × repeat
 * (조각마다 틈 = pause ? shadowPauseMs(en, level) : 0). 예문 en은 **trim만**(카드 🔊·정답 🔊와 캐시 키가 같게), 한국어는
 * cleanGuideKoForTts(자리 "…"). 모든 조각은 splitForTts(…, 300) — 나뉘면 틈은 마지막 조각에만.
 */
export function buildTemplateShadowScript(templates: readonly ToeicTemplate[], opts: ToeicShadowOptions = {}): ToeicShadowPiece[] {
  const repeat = clampShadowRepeat(opts.repeat);
  const pause = opts.pause !== false;
  const level = opts.pauseLevel ?? TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT;
  const intro = opts.intro !== false;
  const introEn = opts.introEn === true;
  const out: ToeicShadowPiece[] = [];
  const push = (text: string, lang: ToeicShadowPiece["lang"], pauseMs: number, key: string, example: number | null, rep: number) => {
    if (text === "") return;
    const pieces = splitForTts(text, TTS_TEXT_MAX_CHARS);
    pieces.forEach((t, k) => out.push({ text: t, lang, pauseAfterMs: k === pieces.length - 1 ? pauseMs : 0, key, example, rep }));
  };
  for (const t of templates) {
    if (intro) push(cleanGuideKoForTts(t.frameKo), "ko-KR", 0, t.key, null, 0);
    if (introEn) push(cleanGuideEnForTts(t.frameEn), "en-US", 0, t.key, null, 0);
    t.examples.forEach((ex, j) => {
      push(cleanGuideKoForTts(ex.ko), "ko-KR", 0, t.key, j, 0);
      const en = ex.en.trim();
      const ms = pause ? shadowPauseMs(en, level) : 0;
      for (let r = 1; r <= repeat; r++) push(en, "en-US", ms, t.key, j, r);
    });
  }
  return out;
}

/** 조각 하나의 말 길이 추정(ms, 속도 1) — 영어 낱말 × 380, 한국어 글자(공백 뺌) × 180 */
export function estimateSpeechMs(piece: { text: string; lang: string }): number {
  const E = TOEIC_SHADOW_ESTIMATE;
  return piece.lang === "ko-KR" ? piece.text.replace(/\s+/g, "").length * E.koPerCharMs : countWords(piece.text) * E.enPerWordMs;
}

/**
 * 예상 시간(ms) = Σ(말 길이 추정 + 틈) + 조각 사이 300ms × (조각 수 − 1), 전체를 말 속도 배율로 나눈다(느리게 들으면 길어진다).
 * 범위 옆 "약 n분"과 eval이 같은 함수를 쓴다.
 */
export function estimateShadowMs(script: readonly { text: string; lang: string; pauseAfterMs: number }[], speedFactor = 1): number {
  if (script.length === 0) return 0;
  const k = Number.isFinite(speedFactor) && speedFactor > 0 ? speedFactor : 1;
  let ms = TOEIC_SHADOW_ESTIMATE.gapMs * (script.length - 1);
  for (const p of script) ms += estimateSpeechMs(p) + Math.max(0, p.pauseAfterMs || 0);
  return Math.round(ms / k);
}

/**
 * 이어 듣기 시작 위치(§12-5-2 검토 S4) — 멈춘 조각이 예문 조각이면 **그 예문의 머리**(한국어 조각), 틀 소개 조각이면 **그 틀의 첫 조각**.
 * 범위 밖이면 가장 가까운 끝으로, 빈 대본이면 0.
 */
export function shadowResumeIndex(script: readonly Pick<ToeicShadowPiece, "key" | "example">[], index: number): number {
  if (script.length === 0 || !Number.isFinite(index) || index <= 0) return 0;
  let i = Math.min(Math.floor(index), script.length - 1);
  const cur = script[i];
  if (cur.example === null) {
    while (i > 0 && script[i - 1].key === cur.key) i--;
    return i;
  }
  while (i > 0 && script[i - 1].key === cur.key && script[i - 1].example === cur.example) i--;
  return i;
}

// ---------------------------------------------------------------------------
// 숙련도 — 틀 단위, 두 모드 따로, 같은 날 잇단 ○는 하나로 (§12-5-6)
// ---------------------------------------------------------------------------

/**
 * 같은 날 잇단 ○ 접기(검토 S8) — 한 틀의 시도를 시간순으로 걸을 때, ○ 바로 앞 시도도 ○이고 두 시도의 날짜(KST, 세션 startedAt)가
 * 같으면 뒤의 ○를 세지 않는다(그 항목을 뺀 세션 사본). ✕는 언제나 센다. 그래서 졸업(연속 2회 ○)에는 **서로 다른 날** 두 번의 ○가 필요하다.
 * 세션은 startedAt 오름차순(§6-2 계약). 은우 aggregateWordStats는 바꾸지 않는다.
 */
function foldSameDayCorrect(sessions: readonly ToeicQuizSessionLike[]): ToeicQuizSessionLike[] {
  const last = new Map<string, { correct: boolean; day: string }>();
  return sessions.map((s) => {
    const day = kstDateString(s.startedAt);
    const items = s.items.filter((it) => {
      if (it.answered !== true) return true;
      const prev = last.get(it.word);
      last.set(it.word, { correct: it.correct === true, day });
      return !(it.correct === true && prev !== undefined && prev.correct && prev.day === day);
    });
    return { ...s, items };
  });
}

/** 세션들 중 그 모드만 */
function modeSessions(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateQuizMode): ToeicQuizSessionLike[] {
  return sessions.filter((s) => s.mode === mode);
}

/** item 키(`tpl:{key}`) → 틀 key로 옮긴 통계 */
function byTemplateKey(stats: Record<string, WordStat>): Record<string, WordStat> {
  const out: Record<string, WordStat> = {};
  for (const [word, st] of Object.entries(stats)) {
    const key = templateKeyFromItemKey(word);
    if (key !== null) out[key] = st;
  }
  return out;
}

/**
 * 틀 숙련도(§12-5-6) → `{ [mode]: { [틀 key]: WordStat } }`. 모드로 가른 뒤 같은 날 잇단 ○를 접고 aggregateWordStats(은우 순수 함수)를
 * 부른다(세션 → VocabQuizRecord는 표현 시험의 어댑터 toeicSessionsToVocabRecords 그대로). 표현 시험 세션이 섞여 들어와도 틀 모드만 본다.
 * **sessions는 startedAt 오름차순.**
 */
export function aggregateToeicTemplateStats(sessions: readonly ToeicQuizSessionLike[]): Record<ToeicTemplateQuizMode, Record<string, WordStat>> {
  const out = {} as Record<ToeicTemplateQuizMode, Record<string, WordStat>>;
  for (const mode of TOEIC_TEMPLATE_QUIZ_MODES) {
    out[mode] = byTemplateKey(aggregateWordStats(toeicSessionsToVocabRecords(foldSameDayCorrect(modeSessions(sessions, mode)))));
  }
  return out;
}

/** 틀린 틀(§12-5-6) = 그 모드에서 틀린 적 있고 아직 졸업하지 않은 틀 key */
export function toeicTemplateWrongKeys(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateQuizMode): Set<string> {
  const stats = aggregateToeicTemplateStats(sessions)[mode];
  const out = new Set<string>();
  for (const [key, st] of Object.entries(stats)) if (st.wrong > 0 && !isStatMastered(st)) out.add(key);
  return out;
}

/** "틀린 틀만 따라 말하기" 범위 — 두 모드의 합집합 */
export function toeicTemplateWrongKeysAnyMode(sessions: readonly ToeicQuizSessionLike[]): Set<string> {
  const out = new Set<string>();
  for (const mode of TOEIC_TEMPLATE_QUIZ_MODES) for (const k of toeicTemplateWrongKeys(sessions, mode)) out.add(k);
  return out;
}

export type ToeicTemplateBadge = "new" | "progress" | "today" | "wrong" | "mastered";

/**
 * 모드마다 배지(§12-5-6) — 진행 중(progress — 마지막 ○, 연속 1) · 오늘 ○ — 내일 한 번 더(today — 마지막 시도가 오늘 ○이고 연속 1 —
 * 같은 날 ○를 더해도 이 상태) · ✕(wrong — 마지막이 ✕) · 🎓(mastered). **시도한 틀만 키가 있다 — 키가 없으면 안 해 봄(new)**.
 * `todayKst`는 화면이 kstTodayString()으로 구해 넘긴다(lib/kst — 스트릭과 같은 하루 기준).
 */
export function toeicTemplateBadges(
  sessions: readonly ToeicQuizSessionLike[],
  todayKst: string,
): Record<ToeicTemplateQuizMode, Record<string, ToeicTemplateBadge>> {
  const stats = aggregateToeicTemplateStats(sessions);
  const out = {} as Record<ToeicTemplateQuizMode, Record<string, ToeicTemplateBadge>>;
  for (const mode of TOEIC_TEMPLATE_QUIZ_MODES) {
    const lastRaw = new Map<string, { correct: boolean; day: string }>();
    for (const s of modeSessions(sessions, mode)) {
      for (const it of s.items) {
        const key = templateKeyFromItemKey(it.word);
        if (key === null || it.answered !== true) continue;
        lastRaw.set(key, { correct: it.correct === true, day: kstDateString(s.startedAt) });
      }
    }
    const badges: Record<string, ToeicTemplateBadge> = {};
    for (const [key, last] of lastRaw) {
      const st = stats[mode][key];
      if (!st || st.total === 0) continue;
      if (isStatMastered(st)) badges[key] = "mastered";
      else if (!last.correct) badges[key] = "wrong";
      else if (last.day === todayKst && st.streak === 1) badges[key] = "today";
      else badges[key] = "progress";
    }
    out[mode] = badges;
  }
  return out;
}

/** 그 모드에서 틀 key의 시도 수(원래 수 — 같은 날 ○ 접기 전). 예문·채움 차례(§12-5-3)가 이 값으로 돈다 */
function rawAttemptCounts(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateQuizMode): Map<string, { count: number; lastAt: string }> {
  const out = new Map<string, { count: number; lastAt: string }>();
  for (const s of modeSessions(sessions, mode)) {
    for (const it of s.items) {
      const key = templateKeyFromItemKey(it.word);
      if (key === null || it.answered !== true) continue;
      const prev = out.get(key);
      out.set(key, { count: (prev?.count ?? 0) + 1, lastAt: s.startedAt });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 틀 테스트 문항 (§12-5-3)
// ---------------------------------------------------------------------------

export interface ToeicTemplateTestOptions {
  mode: ToeicTemplateQuizMode;
  /** 그 모드의 틀린 틀만(복습 칸 없음) */
  onlyWrong?: boolean;
  max?: number;
  rng?: Rng;
}

export interface ToeicTemplateTestQuestion {
  mode: ToeicTemplateQuizMode;
  /** 틀 key(기록 항목 키는 templateItemKey(key)) */
  key: string;
  template: ToeicTemplate;
  /** (가) 정답 예문 번호 a / (나) 소리로만 들려줄 예문 번호 m */
  exampleIndex: number;
  /** 정답 문장 — (가) examples[a].en / (나) fillFrame(frameEn, testFills[t mod L]) — 대본·카드에 없던 새 문장 */
  answerEn: string;
  /** 정답의 채움(자리 순서) — 비교·표시(채움 밑줄)에 쓴다 */
  answerFills: string[];
  /** (가) 정답 예문의 ko(화면 단서) / (나) null(단서는 한국어 틀 + 영어 채움 칩) */
  answerKo: string | null;
  /** (나) 문항을 여는 탭에서 소리로만 읽는 예문 m의 영어 / (가) null */
  listenEn: string | null;
  /** 복습 칸(졸업 틀 중 마지막 시도가 가장 오래된 것)인가 */
  review: boolean;
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 틀 테스트 한 판(§12-5-3). `templates`는 범위의 틀(흐름 순서 — templateFlowOrder). 한 판에 한 틀 한 문항(같은 key 두 번 없음 —
 * 한 판 안 "연속 2회 ○" 거짓 졸업 방지). onlyWrong이 아니면 최대 2칸을 그 모드 졸업 틀 중 마지막 시도가 가장 오래된 것에 먼저 준다.
 * 나머지는 약함 순위(weaknessRank — 표현 시험과 같은 함수) → 오답 많은 순 → 무작위. 고른 뒤 흐름 순서로 다시 늘어놓는다.
 * 예문·채움은 결정적: 그 모드 시도 수 t(원래 수)로 (가) a = t mod n, (나) m = t mod n · 채움 testFills[t mod L].
 */
export function buildTemplateTestQuestions(
  templates: readonly ToeicTemplate[],
  sessions: readonly ToeicQuizSessionLike[],
  opts: ToeicTemplateTestOptions,
): ToeicTemplateTestQuestion[] {
  const max = Math.max(0, Math.floor(opts.max ?? TOEIC_TEMPLATE_TEST_MAX));
  const rng = opts.rng ?? Math.random;
  const mode = opts.mode;
  const stats = aggregateToeicTemplateStats(sessions)[mode];
  const attempts = rawAttemptCounts(sessions, mode);

  // 범위 — 같은 key는 한 번(흐름 순서의 첫 자리), 출제에 필요한 칸이 있는 틀만
  const order = new Map<string, number>();
  const pool: ToeicTemplate[] = [];
  for (const t of templates) {
    if (order.has(t.key)) continue;
    if (!Array.isArray(t.examples) || t.examples.length === 0) continue;
    if (mode === "tpl-swap" && (!Array.isArray(t.testFills) || t.testFills.length === 0)) continue;
    order.set(t.key, order.size);
    pool.push(t);
  }
  const candidates = opts.onlyWrong ? pool.filter((t) => { const st = stats[t.key]; return !!st && st.wrong > 0 && !isStatMastered(st); }) : pool;
  if (candidates.length === 0 || max === 0) return [];

  const review = new Set<string>();
  if (!opts.onlyWrong) {
    const graduated = candidates
      .filter((t) => { const st = stats[t.key]; return !!st && isStatMastered(st); })
      .map((t) => ({ t, lastAt: attempts.get(t.key)?.lastAt ?? "" }))
      .sort((a, b) => (a.lastAt < b.lastAt ? -1 : a.lastAt > b.lastAt ? 1 : (order.get(a.t.key) ?? 0) - (order.get(b.t.key) ?? 0)));
    for (const g of graduated.slice(0, Math.min(TOEIC_TEMPLATE_TEST_REVIEW_SLOTS, max))) review.add(g.t.key);
  }
  const rest = shuffle(candidates.filter((t) => !review.has(t.key)), rng)
    .map((t, i) => ({ t, i, st: stats[t.key] }))
    .sort((a, b) => weaknessRank(a.st) - weaknessRank(b.st) || (b.st?.wrong ?? 0) - (a.st?.wrong ?? 0) || a.i - b.i)
    .map((x) => x.t);
  const chosen = [...candidates.filter((t) => review.has(t.key)), ...rest].slice(0, max);
  chosen.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  return chosen.map((t) => {
    const tries = attempts.get(t.key)?.count ?? 0;
    const n = t.examples.length;
    const ex = tries % n;
    if (mode === "tpl-recall") {
      const e = t.examples[ex];
      return { mode, key: t.key, template: t, exampleIndex: ex, answerEn: e.en, answerFills: [...e.fills], answerKo: e.ko, listenEn: null, review: review.has(t.key) };
    }
    const fills = t.testFills[tries % t.testFills.length];
    return {
      mode,
      key: t.key,
      template: t,
      exampleIndex: ex,
      answerEn: fillFrame(t.frameEn, fills),
      answerFills: [...fills],
      answerKo: null,
      listenEn: t.examples[ex].en,
      review: review.has(t.key),
    };
  });
}

/** 받아쓰기를 한 번 더 보낼 수 있는가(§12-5-4) — 문항당·세션당 지금까지 보낸 수. 버튼 잠금·"다시 말하기"·자기 판정 전환·"n/20"이 같이 본다 */
export function canTranscribeAgain(counts: { perQuestion: number; perSession: number }): boolean {
  return counts.perQuestion < TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION && counts.perSession < TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION;
}

/** 보낼 만한 녹음인가 — 0.6초 미만은 보내지 않는다("잘 안 들렸어요", §12-5-4) */
export function isSendableTemplateRecording(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= TOEIC_TEMPLATE_REC_MIN_MS;
}

// ---------------------------------------------------------------------------
// 실전 적용 — 연습에 넘길 틀·전사문 속 틀·단계 커버리지·되짚기 (§12-7-9)
// ---------------------------------------------------------------------------

/**
 * 두 모드를 합친 약함(§12-7-9) — 어느 모드든 틀렸고 미졸업(0) → 둘 다 안 해 봄(1) → 진행 중(2) → 두 모드 다 졸업(3).
 * 같은 순위는 오답 합이 많은 순. 반환은 순위·오답(정렬은 호출측).
 */
function combinedWeakness(key: string, stats: Record<ToeicTemplateQuizMode, Record<string, WordStat>>): { rank: number; wrong: number } {
  const per = TOEIC_TEMPLATE_QUIZ_MODES.map((m) => stats[m][key]);
  const tried = per.filter((st): st is WordStat => st !== undefined && st.total > 0);
  const wrong = tried.reduce((n, st) => n + st.wrong, 0);
  if (tried.some((st) => st.wrong > 0 && !isStatMastered(st))) return { rank: 0, wrong };
  if (tried.length === 0) return { rank: 1, wrong };
  if (tried.length === TOEIC_TEMPLATE_QUIZ_MODES.length && tried.every((st) => isStatMastered(st))) return { rank: 3, wrong };
  return { rank: 2, wrong };
}

/** 틀들을 두 모드 합친 약한 순으로(같은 순위는 오답 많은 순 → 무작위) */
export function templatesByWeakness(items: readonly ToeicTemplate[], sessions: readonly ToeicQuizSessionLike[], rng: Rng = Math.random): ToeicTemplate[] {
  if (items.length === 0) return [];
  const stats = aggregateToeicTemplateStats(sessions);
  return shuffle(items, rng)
    .map((t, i) => ({ t, i, w: combinedWeakness(t.key, stats) }))
    .sort((a, b) => a.w.rank - b.w.rank || b.w.wrong - a.w.wrong || a.i - b.i)
    .map((x) => x.t);
}

/**
 * 연습에 넘길 틀(§12-7-9) — 그 유형 틀 중 **단계마다** 가장 약한 틀 하나를 단계 순서로 먼저, 남은 칸을 단계·소재 묶음을 통틀어
 * 약한 순으로 채워 최대 10개. 약함은 두 테스트 모드를 합쳐 본다. 틀이 없으면 rng를 쓰지 않고 빈 배열(틀 은행이 없을 때 결과가
 * 기존 활용할 표현 고르기와 같게).
 */
export function pickTemplatesForDrill(
  items: readonly ToeicTemplate[],
  sessions: readonly ToeicQuizSessionLike[],
  opts: { part: ToeicGuidePart; flows: readonly ToeicTemplateFlow[]; max?: number; rng?: Rng },
): ToeicTemplate[] {
  const max = Math.max(0, Math.floor(opts.max ?? TOEIC_DRILL_TEMPLATES_MAX));
  const mine = items.filter((t) => Array.isArray(t.parts) && t.parts.includes(opts.part));
  if (mine.length === 0 || max === 0) return [];
  const ranked = templatesByWeakness(mine, sessions, opts.rng ?? Math.random);
  const flow = opts.flows.find((f) => f.part === opts.part);
  const chosen: ToeicTemplate[] = [];
  const taken = new Set<string>();
  for (const st of flow?.steps ?? []) {
    if (chosen.length >= max) break;
    const groups = new Set(st.groupsKo);
    const pick = ranked.find((t) => groups.has(t.groupKo) && !taken.has(t.key));
    if (pick) {
      chosen.push(pick);
      taken.add(pick.key);
    }
  }
  for (const t of ranked) {
    if (chosen.length >= max) break;
    if (taken.has(t.key)) continue;
    chosen.push(t);
    taken.add(t.key);
  }
  return chosen;
}

export interface ToeicTemplateFound {
  key: string;
  /** 첫 조각이 시작한 들은 낱말 위치 */
  at: number;
}

/**
 * 전사문에서 쓴 틀 찾기(§12-5-5) — 틀마다 두 낱말 이상인 고정 조각만 찾는다. 그런 조각이 **모두** 전사문 낱말열에 이어서, 순서대로
 * (겹치지 않게 — 앞 조각 뒤에서, 낱말 같음은 sameTemplateWord) 있으면 "쓴 틀". 두 낱말 이상 조각이 없는 틀은 찾지 않고
 * `unmatchable`로 따로 센다. 결과는 첫 조각 위치 순, 같은 틀은 한 번.
 */
export function findTemplatesInTranscript(
  transcript: string,
  templates: readonly Pick<ToeicTemplate, "key" | "frameEn">[],
): { found: ToeicTemplateFound[]; unmatchable: string[] } {
  const heard = normalizeTemplateWords(transcript ?? "");
  const found: ToeicTemplateFound[] = [];
  const unmatchable: string[] = [];
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const runs = frameFixedWordRuns(t.frameEn).filter((r) => r.length >= 2);
    if (runs.length === 0) {
      unmatchable.push(t.key);
      continue;
    }
    let pos = 0;
    let first = -1;
    let ok = true;
    for (const r of runs) {
      const at = findRun(heard, r, pos, sameTemplateWord);
      if (at < 0) {
        ok = false;
        break;
      }
      if (first < 0) first = at;
      pos = at + r.length;
    }
    if (ok) found.push({ key: t.key, at: first });
  }
  found.sort((a, b) => a.at - b.at);
  return { found, unmatchable };
}

/**
 * 단계 커버리지(§12-5-5 검토 B2) — 그 유형 흐름의 **단계**마다 `{ stepKo, used }`(단계 안 묶음들의 틀 중 찾은 key — foundKeys 순서).
 * 소재 묶음은 세지 않는다. 흐름이 없으면 빈 배열.
 */
export function templateStepCoverage(
  part: ToeicGuidePart,
  foundKeys: readonly string[],
  bank: { flows: readonly ToeicTemplateFlow[]; items: readonly Pick<ToeicTemplate, "key" | "groupKo" | "parts">[] },
): { stepKo: string; used: string[] }[] {
  const flow = bank.flows.find((f) => f.part === part);
  if (!flow) return [];
  const groupOf = new Map<string, string>();
  for (const t of bank.items) if (Array.isArray(t.parts) && t.parts.includes(part)) groupOf.set(t.key, t.groupKo);
  return flow.steps.map((st) => {
    const groups = new Set(st.groupsKo);
    return { stepKo: st.stepKo, used: foundKeys.filter((k, i) => foundKeys.indexOf(k) === i && groups.has(groupOf.get(k) ?? "\u0000")) };
  });
}

/** 빠진 단계 — "빠진 단계"를 보이는 유형(Q3–4·Q11)에서만, 쓴 틀이 없는 단계 이름. 그 밖 유형은 빈 배열 */
export function missingTemplateSteps(part: ToeicGuidePart, coverage: readonly { stepKo: string; used: readonly string[] }[]): string[] {
  if (!(TOEIC_TEMPLATE_FLOW_CHECK_PARTS as readonly string[]).includes(part)) return [];
  return coverage.filter((c) => c.used.length === 0).map((c) => c.stepKo);
}

/**
 * 되짚는 표(§12-7-9) — `matchKey(frameToExpression(frameEn))` → 틀 key(zod가 은행 안 유일을 보장), 그다음 guideRefs의 교재 표현마다
 * `matchKey(표현)` → 틀 key(교재 표현 글자와 `~` 형태가 다를 때 — 여러 틀이 같은 표현을 가리키면 파일 순서로 첫 틀). 틀 글자가 먼저다.
 */
export function templateByExpression(items: readonly Pick<ToeicTemplate, "key" | "frameEn" | "guideRefs">[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of items) {
    const k = matchKey(frameToExpression(t.frameEn));
    if (k !== "" && !map.has(k)) map.set(k, t.key);
  }
  for (const t of items) {
    for (const r of t.guideRefs ?? []) {
      if (r.kind !== "expression") continue;
      const k = matchKey(r.expression);
      if (k !== "" && !map.has(k)) map.set(k, t.key);
    }
  }
  return map;
}

export interface ToeicTemplateSuggestion {
  key: string;
  source: "sample" | "feedback" | "step";
}

/**
 * "쓸 수 있었던 틀"(§12-7-9) — 겹치지 않게 이 순서로 최대 5개: ① 모범답변이 쓴 틀(문항 usedExpressions를 틀로 되짚은 것) ②
 * 피드백 tryExpressions 중 틀로 되짚히는 것 ③ 빠진 단계마다 그 단계의 가장 약한 틀 하나(호출측이 key로 넘긴다). 내가 쓴 틀은 뺀다.
 */
export function templatesCouldHaveUsed(args: {
  sampleUsedExpressions: readonly string[];
  tryExpressions: readonly string[];
  missingStepKeys: readonly string[];
  mine: ReadonlySet<string>;
  byExpression: ReadonlyMap<string, string>;
  max?: number;
}): ToeicTemplateSuggestion[] {
  const max = args.max ?? TOEIC_TEMPLATE_SUGGESTIONS_MAX;
  const out: ToeicTemplateSuggestion[] = [];
  const seen = new Set<string>(args.mine);
  const add = (key: string | undefined, source: ToeicTemplateSuggestion["source"]) => {
    if (key === undefined || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ key, source });
  };
  for (const e of args.sampleUsedExpressions) add(args.byExpression.get(matchKey(e)), "sample");
  for (const e of args.tryExpressions) add(args.byExpression.get(matchKey(e)), "feedback");
  for (const k of args.missingStepKeys) add(k, "step");
  return out;
}

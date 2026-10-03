/**
 * lib/toeic-template.ts — 토익스피킹 **템플릿(틀) 훈련** 순수 함수 (docs/harness/toeic.md §12-5·§12-7-9)
 *
 * 학습 단위는 **틀**(바꿔 끼울 `{자리}`가 있는 문장 뼈대)이다. 틀 채우기·`~` 형태·표시 분할·흐름 순서·교재 연결 표, 따라 말하기 대본·
 * 예상 시간·이어 듣기 위치, 전사 비교(축약형 두 뜻·숫자·관사), 테스트 문항 고르기·숙련도(같은 날 ○ 접기)·틀린 틀, 연습에 넘길 틀
 * 고르기·전사문 속 틀 찾기·단계 커버리지를 **여기 한 곳**에 둔다. 화면·라우트·zod(lib/ai/toeic/schemas.ts)·eval이 같은 함수를 본다.
 * 2026-10-02(§12-13 템플릿 중심 재정렬): 같은 자리 다른 표현 연결 표(templateAlternateLinks)·연습에서 뺄 공략 표현(guideExpressionKeysInFlow)·
 * **답변 흐름**(buildAnswerFlow·buildMockAnswerFlows — 호출 C·D 입력)·모범답변 점검(checkAnswerAgainstFlow·isWeakFlowCheck)과
 * 모드 목록을 받는 통계 도우미(aggregateTemplateStatsByModes 등 — ③ 틀 시험 lib/toeic-template-quiz.ts가 같은 길을 탄다)도 여기 산다.
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
  TOEIC_GUIDE_PARTS,
  TOEIC_GUIDE_PART_TO_MOCK_PART,
  TOEIC_SHADOW_PAUSE,
  TOEIC_SHADOW_PAUSE_LEVELS,
  TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT,
  cleanGuideEnForTts,
  cleanGuideKoForTts,
  scanSlots,
  shadowPauseMs,
  toeicGuidePartOfMockPart,
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
  type ToeicTemplateBankMode,
  type ToeicTemplateQuizMode,
} from "./toeic-quiz";
import { aggregateWordStats, isStatMastered, type WordStat } from "./vocab-mastery";
import { kstDateString } from "./kst";
import type { Rng } from "./vocab-quiz";
import type {
  ToeicAnswerFlow,
  ToeicAnswerFlowFrame,
  ToeicGuideFileEntry,
  ToeicTemplate,
  ToeicTemplateAlternate,
  ToeicTemplateFlow,
} from "./ai/toeic/schemas";
import type { ToeicMockPart } from "./toeic-mock";

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
function modeSessions(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateBankMode): ToeicQuizSessionLike[] {
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
 * 틀 숙련도 — **받은 모드 목록마다** `{ [mode]: { [틀 key]: WordStat } }`(§12-5-6·§12-13-2). 모드로 가른 뒤 같은 날 잇단 ○를 접고
 * aggregateWordStats(은우 순수 함수)를 부른다(세션 → VocabQuizRecord는 표현 시험의 어댑터 toeicSessionsToVocabRecords 그대로).
 * ② 틀 테스트(말하기 두 모드)와 ③ 틀 시험(고르기 세 모드)이 **이 길 하나**를 모드 목록만 바꿔 탄다 — 복사하면 같은 날 접기 규칙이 두 벌이
 * 된다. 다른 모드 세션이 섞여 들어와도 받은 모드만 본다. **sessions는 startedAt 오름차순.**
 */
export function aggregateTemplateStatsByModes<M extends ToeicTemplateBankMode>(
  sessions: readonly ToeicQuizSessionLike[],
  modes: readonly M[],
): Record<M, Record<string, WordStat>> {
  const out = {} as Record<M, Record<string, WordStat>>;
  for (const mode of modes) {
    out[mode] = byTemplateKey(aggregateWordStats(toeicSessionsToVocabRecords(foldSameDayCorrect(modeSessions(sessions, mode)))));
  }
  return out;
}

/**
 * 틀 숙련도(§12-5-6) — ② 틀 테스트 두 모드(말하기). aggregateTemplateStatsByModes의 얇은 함수(결과는 옛 함수와 글자까지 같다).
 * 고르기 세션(③ 틀 시험)이 섞여 들어와도 말하기 두 모드만 본다.
 */
export function aggregateToeicTemplateStats(sessions: readonly ToeicQuizSessionLike[]): Record<ToeicTemplateQuizMode, Record<string, WordStat>> {
  return aggregateTemplateStatsByModes(sessions, TOEIC_TEMPLATE_QUIZ_MODES);
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
  return templateBadgesByModes(sessions, todayKst, TOEIC_TEMPLATE_QUIZ_MODES);
}

/** 모드 목록을 받는 배지(§12-5-6 규칙 그대로) — ② 말하기 두 모드·③ 고르기 세 모드가 같은 함수를 쓴다(§12-13-2) */
export function templateBadgesByModes<M extends ToeicTemplateBankMode>(
  sessions: readonly ToeicQuizSessionLike[],
  todayKst: string,
  modes: readonly M[],
): Record<M, Record<string, ToeicTemplateBadge>> {
  const stats = aggregateTemplateStatsByModes(sessions, modes);
  const out = {} as Record<M, Record<string, ToeicTemplateBadge>>;
  for (const mode of modes) {
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

/**
 * 그 모드에서 틀 key의 시도 수(원래 수 — 같은 날 ○ 접기 전)와 마지막 시도 세션 시각. 예문·채움 차례(§12-5-3)와 ③ 빈칸 낱말 차례·답한 뒤
 * 예문(§12-13-2)이 이 값으로 돈다.
 */
export function templateAttemptCounts(sessions: readonly ToeicQuizSessionLike[], mode: ToeicTemplateBankMode): Map<string, { count: number; lastAt: string }> {
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
  const attempts = templateAttemptCounts(sessions, mode);

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

export interface ToeicTemplateRunSpan {
  /** 틀 key */
  key: string;
  /** 고정 조각마다 글자 범위 [start, end) — 원문 안, 조각끼리 겹치지 않음(앞 조각 뒤에서 찾는다) */
  runs: { start: number; end: number }[];
}

/**
 * 원문 낱말 토큰(공백으로 끊은 것)의 글자 범위 — 앞뒤 문장부호는 범위에서 뺀다(밑줄이 쉼표·마침표까지 긋지 않게).
 * 낱말 글자가 하나도 없는 토큰(문장부호뿐)도 위치를 지키려고 빈 범위로 둔다.
 */
function textTokens(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let start = m.index;
    let end = m.index + m[0].length;
    while (start < end && !/[A-Za-z0-9]/.test(text[start])) start++;
    while (end > start && !/[A-Za-z0-9]/.test(text[end - 1])) end--;
    out.push(start < end ? { start, end } : { start: m.index, end: m.index });
  }
  return out;
}

/**
 * 정규화 낱말 j → 원문 토큰 범위 [첫 토큰, 끝 토큰]. 정규화는 토큰을 합치기도 한다(twenty five → 25, a hundred → 100) — 그래서 낱말마다
 * "앞 k개 토큰을 정규화한 낱말 수"로 경계를 잡는다: 낱말 j의 첫 토큰 = 낱말 수가 처음 j보다 커지는 토큰, 끝 토큰 = 낱말 수가 처음
 * j+1보다 커지기 직전 토큰. 축약형(it's → it is|has)처럼 토큰 하나가 낱말 둘이 되면 두 낱말이 같은 토큰을 가리킨다.
 */
function wordTokenMap(text: string, tokens: readonly { start: number; end: number }[]): { first: number; last: number }[] {
  const raw = (text.match(/\S+/g) ?? []) as string[];
  const counts: number[] = [];
  for (let k = 0; k < raw.length; k++) counts.push(normalizeTemplateWords(raw.slice(0, k + 1).join(" ")).length);
  const total = counts.length > 0 ? counts[counts.length - 1] : 0;
  const map: { first: number; last: number }[] = [];
  for (let j = 0; j < total; j++) {
    const first = counts.findIndex((c) => c > j);
    const nextStart = counts.findIndex((c) => c > j + 1);
    const last = nextStart < 0 ? tokens.length - 1 : Math.max(first, nextStart - 1);
    map.push({ first, last });
  }
  return map;
}

/**
 * 틀 고정 조각의 **글자 범위**(§13-9 ② 글자 나란히) — findTemplatesInTranscript와 **같은 일치 규칙**(두 낱말 이상 고정 조각이 모두 순서대로,
 * 낱말 같음은 sameTemplateWord)이라 찾은 key 집합이 같다(eval이 잠근다). 결과는 첫 조각 위치 순. 틀끼리는 범위가 겹칠 수 있다
 * (화면이 겹친 구간을 한 번만 칠한다 — templateSpanSegments).
 */
export function templateRunSpans(text: string, templates: readonly Pick<ToeicTemplate, "key" | "frameEn">[]): ToeicTemplateRunSpan[] {
  const src = text ?? "";
  const heard = normalizeTemplateWords(src);
  if (heard.length === 0) return [];
  const tokens = textTokens(src);
  const map = wordTokenMap(src, tokens);
  const charRange = (from: number, len: number): { start: number; end: number } | null => {
    const a = map[from];
    const b = map[from + len - 1];
    if (!a || !b || a.first < 0 || b.last < 0) return null;
    const s0 = tokens[a.first];
    const e0 = tokens[b.last];
    if (!s0 || !e0) return null;
    return { start: s0.start, end: Math.max(s0.start, e0.end) };
  };
  const out: (ToeicTemplateRunSpan & { at: number })[] = [];
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const runs = frameFixedWordRuns(t.frameEn).filter((r) => r.length >= 2);
    if (runs.length === 0) continue;
    let pos = 0;
    let first = -1;
    const spans: { start: number; end: number }[] = [];
    let ok = true;
    for (const r of runs) {
      const at = findRun(heard, r, pos, sameTemplateWord);
      if (at < 0) {
        ok = false;
        break;
      }
      if (first < 0) first = at;
      pos = at + r.length;
      const range = charRange(at, r.length);
      if (range && range.end > range.start) {
        const prev = spans[spans.length - 1];
        // 한 토큰이 두 조각에 걸치면(축약형) 앞 조각 뒤로 민다 — 한 틀 안 조각끼리 겹치지 않게
        if (prev && range.start < prev.end) range.start = prev.end;
        if (range.end > range.start) spans.push(range);
      }
    }
    if (ok) out.push({ key: t.key, runs: spans, at: first });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(({ key, runs }) => ({ key, runs }));
}

/** 글자 범위들 → 화면 조각(겹친 구간은 한 번만, 그 구간의 key들을 함께) */
export function templateSpanSegments(text: string, spans: readonly ToeicTemplateRunSpan[]): { text: string; keys: string[] }[] {
  const src = text ?? "";
  const cuts = new Set<number>([0, src.length]);
  for (const sp of spans) for (const r of sp.runs) {
    cuts.add(Math.max(0, Math.min(src.length, r.start)));
    cuts.add(Math.max(0, Math.min(src.length, r.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: { text: string; keys: string[] }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (b <= a) continue;
    const keys = spans.filter((sp) => sp.runs.some((r) => r.start <= a && r.end >= b)).map((sp) => sp.key);
    const prev = out[out.length - 1];
    if (prev && prev.keys.join("\u0001") === keys.join("\u0001")) prev.text += src.slice(a, b);
    else out.push({ text: src.slice(a, b), keys });
  }
  return out;
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
 * "쓸 수 있었던 틀"(§12-7-9 → §12-13-3 검토 B4 — 2026-10-02 순서 바꿈) — 겹치지 않게 이 순서로 최대 5개, 내가 쓴 틀은 뺀다:
 * ① `step` — 빠진 단계마다 하나(단계 순서 — 호출측 drillTemplateCheck가 그 단계에서 모범답변이 쓴 틀, 없으면 가장 약한 틀을 key로 넘긴다)
 * ② `feedback` — 피드백 tryExpressions 중 지금 틀 은행에서 틀로 되짚히는 것
 * ③ `sample` — 남은 모범답변 틀(호출측이 이미 틀 key로 되짚은 sampleKeys — 모범답변 글에서 찾은 순서 → usedExpressions 되짚기)
 * 까닭: 모범답변이 단계마다 틀로 조립되면 모범답변 틀만으로 5칸이 차서 "내가 건너뛴 단계"(가장 행동할 만한 신호)와 내 답 맞춤
 * 피드백 틀이 늘 잘린다. 빠진 단계가 없으면 feedback → sample 순이다(옛 sample → feedback → step과 다르다 — 같은 근거).
 */
export function templatesCouldHaveUsed(args: {
  missingStepKeys: readonly string[];
  tryExpressions: readonly string[];
  sampleKeys: readonly string[];
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
  for (const k of args.missingStepKeys) add(k, "step");
  for (const e of args.tryExpressions) add(args.byExpression.get(matchKey(e)), "feedback");
  for (const k of args.sampleKeys) add(k, "sample");
  return out;
}

// ---------------------------------------------------------------------------
// ① 공략 읽기 정렬 — 같은 자리 다른 표현 연결 표 (§12-13-1)
// ---------------------------------------------------------------------------

/**
 * 같은 자리 다른 표현 연결 표(§12-13-1) — 틀 은행 문서 `alternates`에서 그 유형 것만 골라 templateLinksForGuide와 **같은 모양·같은 키
 * 정규화**로(템플릿 줄 label → key들, 머리말(공백 정리) → key들, 표현(expressionKey) → key들 — 값은 coveredBy). 두 표를 같은 줄에 대 본다.
 * alternates가 배열이 아니면(깨진 문서) 빈 표.
 */
export function templateAlternateLinks(bank: { alternates?: readonly ToeicTemplateAlternate[] | null }, part: ToeicGuidePart): ToeicTemplateGuideLinks {
  const links: ToeicTemplateGuideLinks = { templateLabels: new Map(), leads: new Map(), expressions: new Map() };
  const list = Array.isArray(bank.alternates) ? bank.alternates : [];
  for (const a of list) {
    if (!a || a.part !== part || typeof a.ref !== "string" || typeof a.coveredBy !== "string") continue;
    if (a.kind === "template") pushKey(links.templateLabels, a.ref, a.coveredBy);
    else if (a.kind === "lead") pushKey(links.leads, collapseSpaces(a.ref), a.coveredBy);
    else if (a.kind === "expression") pushKey(links.expressions, expressionKey(a.ref), a.coveredBy);
  }
  return links;
}

/**
 * 한 문제 연습의 활용할 표현에서 뺄 공략 표현 키(§12-13-3 pickExpressionsForDrill `guide.exclude`) — 틀이 guideRefs로 연결한 그 유형 교재
 * 표현의 expressionKey ∪ 그 유형 `alternates` 중 표현 종류의 expressionKey. 외울 틀은 답변 흐름에 이미 있고(두 칸에 같은 틀이 있으면
 * 모델이 어느 칸 글자로 적을지 갈린다), 같은 자리 다른 표현은 외우지 않을 대안이다.
 */
export function guideExpressionKeysInFlow(
  bank: { items: readonly Pick<ToeicTemplate, "guideRefs">[]; alternates?: readonly ToeicTemplateAlternate[] | null },
  part: ToeicGuidePart,
): Set<string> {
  const out = new Set<string>();
  for (const t of Array.isArray(bank.items) ? bank.items : []) {
    // 정규화 뒤 틀 은행 items는 모양을 믿지 않는다(깨진 틀은 렌더 판정이 막는다) — 여기서도 형식을 본다
    for (const r of Array.isArray(t?.guideRefs) ? t.guideRefs : []) {
      if (r && r.kind === "expression" && r.part === part && typeof r.expression === "string") out.add(expressionKey(r.expression));
    }
  }
  for (const k of templateAlternateLinks(bank, part).expressions.keys()) out.add(k);
  return out;
}

/**
 * 틀이 자리로 끝나는가(§12-13-1 규칙 4) — 끝의 공백·`.`·`?`·`!`·따옴표를 떼면 `}`로 끝난다. 가운데에만 자리가 있는 틀은 false.
 * 이어 말하기 머리말이 같은 자리 다른 표현일 때, 대표 틀이 자리로 끝나면 머리말 줄만 접고 조각은 남긴다(조각이 그 끝 자리의 재료).
 */
export function frameEndsWithSlot(frameEn: string): boolean {
  const t = (frameEn ?? "").replace(/[\s.?!"'“”‘’]+$/u, "");
  return t.endsWith("}");
}

// ---------------------------------------------------------------------------
// ④ 답변 흐름 — 호출 C·D의 새 입력 (§12-13-3)
// ---------------------------------------------------------------------------

/** 답변 흐름 틀 상한(§12-13-3·§12-12 31) — 넘으면 소재 틀을 뒤에서 자르고, 단계 틀만으로 넘으면 단계마다 앞에서 ⌊60 ÷ 단계 수⌋개 */
export const TOEIC_ANSWER_FLOW_FRAMES_MAX = 60;
/** 모범답변 점검 미달 기준(§12-13-3) — Q3–4·Q11은 쓴 단계 비율 < 0.75면 미달. 화면 경고와 실호출 점검이 **같은 값**을 쓴다 */
export const TOEIC_ANSWER_FLOW_STEP_MIN_RATIO = 0.75;

export interface ToeicAnswerFlowOptions {
  /** "flow"(실전 모의고사 — 흐름 순서 그대로, rng 안 씀) / "weakness"(한 문제 연습 — 단계 안·소재 안 틀을 두 테스트 모드 합친 약한 순) */
  order: "flow" | "weakness";
  /** "weakness"의 틀 세션(setId guide-templates, startedAt 오름차순). 없으면 모두 "안 해 봄"(무작위) */
  sessions?: readonly ToeicQuizSessionLike[];
  rng?: Rng;
}

function flowFrame(t: Pick<ToeicTemplate, "key" | "frameEn">): ToeicAnswerFlowFrame {
  return { key: t.key, expression: frameToExpression(t.frameEn) };
}

/**
 * 답변 흐름(§12-13-3) — 그 파트 유형의 단계마다 그 단계 틀 전부(중복 정리 뒤 은행 — 자리마다 하나) + 소재 틀.
 * - 유형 = toeicGuidePartOfMockPart(mockPart) — `read`면 null(흐름 없음).
 * - `templates` = 그 유형 **렌더 가능한** 틀(호출측이 guideTemplatesForPart로 거른다 — 깨진 틀은 넣지 않는다).
 * - 순서는 templateFlowOrder 하나 — 단계 묶음의 틀은 그 단계로(단계 순서·단계 안 묶음 순서·묶음 안 파일 순서), 소재·기타 묶음의 틀은 banks로.
 *   틀이 없는 단계는 내지 않는다.
 * - `order: "weakness"`면 단계마다·소재 안을 templatesByWeakness(두 말하기 모드 합친 약함 — 같은 rng면 결정적)로. 모델은 앞쪽의 맞는 틀을
 *   먼저 고르기 쉽다 — 강제는 아니다(§12-12 30). "flow"는 rng를 쓰지 않는다.
 * - 상한 TOEIC_ANSWER_FLOW_FRAMES_MAX(60) — 넘으면 소재 틀을 뒤에서 자르고, 단계 틀만으로 넘으면 단계마다 앞에서 ⌊60 ÷ 단계 수⌋개(소재 0).
 * - 틀이 하나도 없으면 null.
 */
export function buildAnswerFlow(
  bank: { flows: readonly ToeicTemplateFlow[] },
  mockPart: ToeicMockPart,
  templates: readonly ToeicTemplate[],
  opts: ToeicAnswerFlowOptions,
): ToeicAnswerFlow | null {
  const part = toeicGuidePartOfMockPart(mockPart);
  if (part === null) return null;
  const groups = templateFlowOrder({ flows: Array.isArray(bank.flows) ? bank.flows : [], items: templates }, part);
  const steps: { stepKo: string; templates: ToeicTemplate[] }[] = [];
  const bankTemplates: ToeicTemplate[] = [];
  for (const g of groups) {
    if (g.kind === "step" && g.stepKo !== null) {
      const last = steps[steps.length - 1];
      if (last && last.stepKo === g.stepKo) last.templates.push(...g.templates);
      else steps.push({ stepKo: g.stepKo, templates: [...g.templates] });
    } else {
      bankTemplates.push(...g.templates);
    }
  }
  const reorder = (list: readonly ToeicTemplate[]): ToeicTemplate[] =>
    opts.order === "weakness" ? templatesByWeakness(list, opts.sessions ?? [], opts.rng ?? Math.random) : [...list];
  let outSteps = steps.map((st) => ({ stepKo: st.stepKo, frames: reorder(st.templates).map(flowFrame) })).filter((st) => st.frames.length > 0);
  let banks = reorder(bankTemplates).map(flowFrame);

  const max = TOEIC_ANSWER_FLOW_FRAMES_MAX;
  const stepTotal = outSteps.reduce((n, st) => n + st.frames.length, 0);
  if (stepTotal + banks.length > max) {
    if (stepTotal <= max) {
      banks = banks.slice(0, max - stepTotal);
    } else {
      const per = Math.floor(max / outSteps.length);
      outSteps = outSteps.map((st) => ({ stepKo: st.stepKo, frames: st.frames.slice(0, per) })).filter((st) => st.frames.length > 0);
      banks = [];
    }
  }
  if (outSteps.length === 0 && banks.length === 0) return null;
  return { part: mockPart, steps: outSteps, banks };
}

/**
 * 실전 모의고사가 만들 때 저장할 흐름(§12-13-3 검토 B1) — **고른 파트와 상관없이** read를 뺀 네 파트(틀이 있는 유형)의 흐름을 형식표
 * 순서로(order "flow"). 틀 은행이 없으면 []. 틀이 없는 유형은 빠진다. 한 파트의 흐름 만들기가 던지면 그 파트만 빠지고(onError로 알린다)
 * 나머지는 계속한다 — 흐름 때문에 모의고사를 실패시키지 않는다(§0-4). 라우트는 이것을 부르기만 하고, 호출 C에는 고른 파트의 흐름만 넘긴다.
 * @param templatesByPart 유형마다 렌더 가능한 틀(guideTemplatesForPart — 호출측이 거른다)
 */
export function buildMockAnswerFlows(
  bank: { flows: readonly ToeicTemplateFlow[] } | null,
  templatesByPart: Partial<Record<ToeicGuidePart, readonly ToeicTemplate[]>>,
  onError?: (part: ToeicGuidePart, err: unknown) => void,
): ToeicAnswerFlow[] {
  if (bank === null) return [];
  const out: ToeicAnswerFlow[] = [];
  for (const part of TOEIC_GUIDE_PARTS) {
    try {
      const flow = buildAnswerFlow(bank, TOEIC_GUIDE_PART_TO_MOCK_PART[part], templatesByPart[part] ?? [], { order: "flow" });
      if (flow !== null) out.push(flow);
    } catch (err) {
      onError?.(part, err);
    }
  }
  return out;
}

/** 흐름의 틀 글자 전부(단계 → 소재 순, matchKey 같으면 한 번) — 호출 C·D 후처리 허용 목록의 **앞**에 둔다(표기가 흐름 쪽) */
export function answerFlowExpressions(flow: ToeicAnswerFlow | null): string[] {
  if (flow === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of [...flow.steps.flatMap((st) => st.frames), ...flow.banks]) {
    const k = matchKey(f.expression);
    if (k === "" || seen.has(k)) continue;
    seen.add(k);
    out.push(f.expression);
  }
  return out;
}

/**
 * 흐름 틀을 전사문 속 틀 찾기(findTemplatesInTranscript)가 받는 모양으로 — `~`(`～`·`〜`)를 자리 `{_}`로 바꾼 frameEn(단계 → 소재 순).
 * **저장된 흐름**으로 재므로 틀 은행이 나중에 바뀌어도 결과가 같다.
 */
export function answerFlowMatchFrames(flow: ToeicAnswerFlow): { key: string; frameEn: string }[] {
  return [...flow.steps.flatMap((st) => st.frames), ...flow.banks].map((f) => ({ key: f.key, frameEn: f.expression.replace(/[~～〜]/g, "{_}") }));
}

/** 모범답변(또는 개선 답변) 점검 결과(§12-13-3) */
export interface ToeicAnswerFlowCheck {
  /** 쓴 틀(첫 위치 순). step = 단계 번호(0부터), 소재 틀이면 null */
  used: { key: string; step: number | null }[];
  /** 쓴 틀이 하나라도 있는 단계 수 */
  stepsUsed: number;
  /** 흐름의 단계 수 */
  stepsTotal: number;
  /** 쓴 단계들의 첫 위치가 단계 순서대로 늘어섰는가(쓴 단계가 1개 이하면 true) */
  inOrder: boolean;
  /** 두 낱말 이상 고정 조각이 없어 찾을 수 없는 흐름 틀 수 */
  unmatchable: number;
}

/**
 * 모범답변 점검(§12-13-3 — **측정만**, 재요청하지 않는다). 찾기는 findTemplatesInTranscript(두 낱말 이상 고정 조각이 순서대로,
 * sameTemplateWord — 축약형·대소문자 무시) 그대로. 한 낱말 조각뿐인 틀은 unmatchable로 센다(판정 자체가 근사다).
 */
export function checkAnswerAgainstFlow(answer: string, flow: ToeicAnswerFlow): ToeicAnswerFlowCheck {
  const stepOf = new Map<string, number>();
  flow.steps.forEach((st, i) => st.frames.forEach((f) => { if (!stepOf.has(f.key)) stepOf.set(f.key, i); }));
  const { found, unmatchable } = findTemplatesInTranscript(answer ?? "", answerFlowMatchFrames(flow));
  const used = found.map((f) => ({ key: f.key, step: stepOf.has(f.key) ? (stepOf.get(f.key) as number) : null }));
  const firstAt = new Map<number, number>();
  for (const f of found) {
    const st = stepOf.get(f.key);
    if (st !== undefined && !firstAt.has(st)) firstAt.set(st, f.at);
  }
  const usedSteps = [...firstAt.keys()].sort((a, b) => a - b);
  let inOrder = true;
  for (let i = 1; i < usedSteps.length; i++) {
    if ((firstAt.get(usedSteps[i - 1]) as number) > (firstAt.get(usedSteps[i]) as number)) inOrder = false;
  }
  return { used, stepsUsed: usedSteps.length, stepsTotal: flow.steps.length, inOrder, unmatchable: unmatchable.length };
}

/**
 * 모범답변이 틀을 덜 따랐는가(§12-13-3 미달 경고 — AI 0). 흐름 없음(null) → false. Q3–4·Q11(TOEIC_TEMPLATE_FLOW_CHECK_PARTS — 한 답이
 * 흐름 전체를 지나는 유형)은 쓴 단계 비율 < TOEIC_ANSWER_FLOW_STEP_MIN_RATIO(0.75)면 참, 그 밖(Q5–7·Q8–10 — 질문마다 짧게 답한다)은
 * 쓴 틀 0이면 참. 단계가 0인 흐름(소재 틀만)은 쓴 틀 0이면 참. 기준 이상이면 단계가 비어도 결핍이 아니다(필요 없는 단계를 건너뛴 경우).
 */
export function isWeakFlowCheck(check: ToeicAnswerFlowCheck | null, mockPart: ToeicMockPart): boolean {
  if (check === null) return false;
  const part = toeicGuidePartOfMockPart(mockPart);
  if (part !== null && (TOEIC_TEMPLATE_FLOW_CHECK_PARTS as readonly string[]).includes(part) && check.stepsTotal > 0) {
    return check.stepsUsed / check.stepsTotal < TOEIC_ANSWER_FLOW_STEP_MIN_RATIO;
  }
  return check.used.length === 0;
}

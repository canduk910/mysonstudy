/**
 * lib/toeic-normalize.ts — 아빠의 영어(토익스피킹) 저장 레코드 방어 정규화 **단일 정의처** (docs/harness/toeic.md §7)
 *
 * 두 저장 백엔드(파일 `lib/store.ts`·Firestore `lib/store-firestore.ts`)가 **같은 함수**로 읽고 쓴다 — 예전에 정규화가
 * 한쪽 백엔드에만 있어 키를 잃은 선례가 있다(normalizeProblem·normalizeVocabEntry 주석). 파일 백엔드는 readDb와 쓰기에서,
 * Firestore는 to*(읽기)와 쓰기 직전에 부른다.
 *
 * 규칙(app-patterns §4 normalize 관용구):
 * - **던지지 않는다.** 없는 키는 null·빈 배열·기본값으로 채우고, 깨진 조각(모르는 문항 축의 useIn 등)은 버린다 — 읽기가
 *   던지면 페이지가 500이 된다.
 * - **값을 손보지 않는다.** 교재 원문(표현·뜻·예문)과 AI 결과는 다듬으면 원문이 바뀐다. "없는 것을 없음으로" 적을 뿐.
 * - **undefined를 남기지 않는다** — Firestore가 거부한다(getDb는 ignoreUndefinedProperties를 켜지 않는다).
 * - 세트의 `enriched`는 저장값을 믿지 않고 entries에서 **다시 계산**한다(단일 정의처 isToeicSetEnriched, §3-4) —
 *   파생 상태를 저장값과 따로 두면 진실이 둘이 된다.
 *
 * 서버 전용(lib/ai/toeic/schemas·points가 zod를 싣는다) — 클라이언트 컴포넌트에서 값으로 import하지 말 것.
 * 레코드 타입은 lib/store.ts에 있고 여기서는 `import type`만 한다(타입 순환은 컴파일 때 지워진다).
 */

import type {
  ToeicAttemptRecord,
  ToeicImageRecord,
  ToeicMockRecord,
  ToeicQuizItem,
  ToeicQuizRecord,
  ToeicSetRecord,
} from "./store";
import {
  TOEIC_CONFIDENCES,
  TOEIC_IMAGE_STATUSES,
  TOEIC_PARTS,
  type ToeicAnswer,
  type ToeicBookQuiz,
  type ToeicExprEntry,
  type ToeicFeedback,
  type ToeicMockParts,
  type ToeicPart,
  type ToeicPictureImage,
  type ToeicReadDiff,
  type ToeicSpeakingPoints,
} from "./ai/toeic/schemas";
import { isToeicSetEnriched } from "./ai/toeic/points";
import { isToeicQuizMode } from "./toeic-quiz";
import { TOEIC_DEFAULT_TARGET_GRADE, TOEIC_MOCK_PARTS, TOEIC_TARGET_GRADES, type ToeicMockPart } from "./toeic-mock";

// ---------------------------------------------------------------------------
// 작은 방어 헬퍼
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function obj(v: unknown): Loose | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function isoOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}
const EPOCH = new Date(0).toISOString();

const PART_SET: ReadonlySet<string> = new Set(TOEIC_PARTS);
const CONFIDENCE_SET: ReadonlySet<string> = new Set(TOEIC_CONFIDENCES);
const IMAGE_STATUS_SET: ReadonlySet<string> = new Set(TOEIC_IMAGE_STATUSES);
const MOCK_PART_SET: ReadonlySet<string> = new Set(TOEIC_MOCK_PARTS);
const GRADE_SET: ReadonlySet<string> = new Set(TOEIC_TARGET_GRADES);

function enKo(v: unknown): { en: string; ko: string } {
  const o = obj(v) ?? {};
  return { en: str(o.en), ko: str(o.ko) };
}

// ---------------------------------------------------------------------------
// 표현집 세트(§7-1)
// ---------------------------------------------------------------------------

/** 발화 포인트(호출 B 결과) — 객체가 아니면 null(= 아직 없음). 모르는 문항 축의 useIn은 버린다. */
export function normalizeToeicSpeakingPoints(v: unknown): ToeicSpeakingPoints | null {
  const p = obj(v);
  if (!p) return null;
  const useIn = Array.isArray(p.useIn)
    ? p.useIn.flatMap((u) => {
        const o = obj(u);
        if (!o || typeof o.part !== "string" || !PART_SET.has(o.part)) return [];
        return [{ part: o.part as ToeicPart, sentence: str(o.sentence), sentenceKo: str(o.sentenceKo) }];
      })
    : [];
  return {
    exampleSpan: strOrNull(p.exampleSpan),
    coreKo: str(p.coreKo),
    useIn,
    frames: strArr(p.frames),
    variations: Array.isArray(p.variations) ? p.variations.map(enKo) : [],
    pronunciationKo: str(p.pronunciationKo),
    pitfallKo: strOrNull(p.pitfallKo),
    grammarKo: strOrNull(p.grammarKo),
    followUp: enKo(p.followUp),
  };
}

/** 표현 항목(§7-1). `example`이 null이면 `exampleKo`도 null(§2-4 불변). */
export function normalizeToeicExprEntry(v: unknown): ToeicExprEntry {
  const e = obj(v) ?? {};
  const example = strOrNull(e.example);
  return {
    no: intOrNull(e.no),
    expression: str(e.expression),
    meaningKo: str(e.meaningKo),
    example,
    exampleKo: example === null ? null : strOrNull(e.exampleKo),
    points: normalizeToeicSpeakingPoints(e.points),
    confidence: typeof e.confidence === "string" && CONFIDENCE_SET.has(e.confidence) ? (e.confidence as ToeicExprEntry["confidence"]) : "medium",
    partial: e.partial === true,
  };
}

/** 교재 하단 QUIZ(§7-1) */
export function normalizeToeicBookQuiz(v: unknown): ToeicBookQuiz {
  const q = obj(v) ?? {};
  return {
    no: intOrNull(q.no),
    promptKo: str(q.promptKo),
    hint: strOrNull(q.hint),
    modelAnswer: str(q.modelAnswer),
    keyExpressions: strArr(q.keyExpressions),
  };
}

/** 표현집 세트 레코드(§7-1) — enriched는 entries에서 다시 계산한다. */
export function normalizeToeicSetRecord(v: unknown): ToeicSetRecord {
  const r = obj(v) ?? {};
  const entries = Array.isArray(r.entries) ? r.entries.map(normalizeToeicExprEntry) : [];
  return {
    id: str(r.id),
    titleKo: str(r.titleKo),
    dayNo: intOrNull(r.dayNo),
    topicKo: strOrNull(r.topicKo),
    source: r.source === "import" ? "import" : "photo",
    presetKey: strOrNull(r.presetKey),
    entries,
    quiz: Array.isArray(r.quiz) ? r.quiz.map(normalizeToeicBookQuiz) : [],
    photoCount: typeof r.photoCount === "number" && Number.isFinite(r.photoCount) ? r.photoCount : 0,
    enriched: entries.length > 0 && isToeicSetEnriched(entries),
    model: strOrNull(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
    sortIndex: numOrNull(r.sortIndex),
  };
}

// ---------------------------------------------------------------------------
// 표현 시험 세션(§7-3)
// ---------------------------------------------------------------------------

/** 문항 결과 — answered 3상태(true/false/null) 유지, correct는 boolean으로 굳힌다(영어·일본어와 같은 규약). */
export function normalizeToeicQuizItem(v: unknown): ToeicQuizItem {
  const it = obj(v) ?? {};
  return {
    word: str(it.word),
    correct: it.correct === true,
    answered: it.answered === true ? true : it.answered === false ? false : null,
  };
}

/**
 * 시험 세션 레코드. **모르는 mode면 null**(호출측이 버린다) — 모드별 숙련도(§6-2)가 이 축에 매달려 있어, 모르는 값을
 * 아무 모드로 떨어뜨리면 그 모드의 "안다" 판정이 오염된다. 저장 라우트 zod가 막으므로 정상 경로에서는 오지 않는다.
 */
export function normalizeToeicQuizRecord(v: unknown): ToeicQuizRecord | null {
  const r = obj(v) ?? {};
  if (!isToeicQuizMode(r.mode)) return null;
  return {
    id: str(r.id),
    setId: str(r.setId),
    mode: r.mode,
    startedAt: isoOr(r.startedAt, EPOCH),
    finishedAt: strOrNull(r.finishedAt),
    items: Array.isArray(r.items) ? r.items.map(normalizeToeicQuizItem) : [],
  };
}

// ---------------------------------------------------------------------------
// 모의고사·생성 사진·응시(§7-2·§7-4·§7-5) — T3~T5가 채운다. 파트 본문은 쓰기 때 zod를 통과한 값이라 통째로 담고
// (설명 기록 toExplanation과 같은 판단), 화면이 곧바로 쓰는 자리(사진 상태·배열)만 조인다.
// ---------------------------------------------------------------------------

function normalizePictureImage(v: unknown): ToeicPictureImage {
  const o = obj(v) ?? {};
  const status = typeof o.status === "string" && IMAGE_STATUS_SET.has(o.status) ? (o.status as ToeicPictureImage["status"]) : "failed";
  return { status, imageId: status === "ready" ? strOrNull(o.imageId) : null };
}

function normalizeMockParts(v: unknown): ToeicMockParts {
  const src = obj(v) ?? {};
  const out = {} as Record<ToeicMockPart, unknown>;
  for (const part of TOEIC_MOCK_PARTS) {
    const p = obj(src[part]);
    if (!p) {
      out[part] = null;
      continue;
    }
    if (part === "picture") {
      const items = Array.isArray(p.items) ? p.items : [];
      out[part] = { ...p, items: items.map((it) => ({ ...(obj(it) ?? {}), image: normalizePictureImage(obj(it)?.image) })) };
    } else {
      out[part] = p;
    }
  }
  return out as ToeicMockParts;
}

export function normalizeToeicMockRecord(v: unknown): ToeicMockRecord {
  const r = obj(v) ?? {};
  return {
    id: str(r.id),
    titleKo: str(r.titleKo),
    targetGrade: typeof r.targetGrade === "string" && GRADE_SET.has(r.targetGrade) ? (r.targetGrade as ToeicMockRecord["targetGrade"]) : TOEIC_DEFAULT_TARGET_GRADE,
    expressionsUsed: strArr(r.expressionsUsed),
    // T3에서 더한 필드 — 이전 문서는 빈 배열(파트 다시 만들기가 "주제 힌트 없음"으로 부른다)
    topicHints: strArr(r.topicHints),
    parts: normalizeMockParts(r.parts),
    model: str(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
    sortIndex: numOrNull(r.sortIndex),
  };
}

export function normalizeToeicImageRecord(v: unknown): ToeicImageRecord {
  const r = obj(v) ?? {};
  return {
    id: str(r.id),
    mockId: str(r.mockId),
    slot: r.slot === 1 ? 1 : 0,
    dataUrl: str(r.dataUrl),
    model: str(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
  };
}

function normalizeReadDiff(v: unknown): ToeicReadDiff | null {
  const d = obj(v);
  if (!d) return null;
  return {
    accuracy: typeof d.accuracy === "number" && Number.isFinite(d.accuracy) ? d.accuracy : 0,
    missing: strArr(d.missing),
    extra: strArr(d.extra),
    substituted: Array.isArray(d.substituted)
      ? d.substituted.map((s) => {
          const o = obj(s) ?? {};
          return { expected: str(o.expected), heard: str(o.heard) };
        })
      : [],
  };
}

function normalizeFeedback(v: unknown): ToeicFeedback | null {
  const f = obj(v);
  if (!f) return null;
  return {
    score: typeof f.score === "number" && Number.isFinite(f.score) ? f.score : 0,
    summaryKo: str(f.summaryKo),
    strengths: strArr(f.strengths),
    fixes: Array.isArray(f.fixes)
      ? f.fixes.map((x) => {
          const o = obj(x) ?? {};
          return { said: str(o.said), better: str(o.better), whyKo: str(o.whyKo) };
        })
      : [],
    missingKo: strArr(f.missingKo),
    improvedAnswer: str(f.improvedAnswer),
    tryExpressions: strArr(f.tryExpressions),
  };
}

/** 응시 문항 결과(§7-5). q가 정수가 아니면 0(추정 총점이 1..11 밖으로 건너뛴다 — QA P2-9 방어). */
export function normalizeToeicAnswer(v: unknown): ToeicAnswer {
  const a = obj(v) ?? {};
  return {
    q: typeof a.q === "number" && Number.isInteger(a.q) ? a.q : 0,
    recorded: a.recorded === true,
    durationMs: numOrNull(a.durationMs),
    transcript: strOrNull(a.transcript),
    readDiff: normalizeReadDiff(a.readDiff),
    feedback: normalizeFeedback(a.feedback),
    score: numOrNull(a.score),
    scoredAt: strOrNull(a.scoredAt),
  };
}

export function normalizeToeicAttemptRecord(v: unknown): ToeicAttemptRecord {
  const r = obj(v) ?? {};
  return {
    id: str(r.id),
    mockId: str(r.mockId),
    scope: r.scope === "part" ? "part" : "full",
    parts: strArr(r.parts).filter((p): p is ToeicMockPart => MOCK_PART_SET.has(p)),
    startedAt: isoOr(r.startedAt, EPOCH),
    finishedAt: strOrNull(r.finishedAt),
    answers: Array.isArray(r.answers) ? r.answers.map(normalizeToeicAnswer) : [],
  };
}

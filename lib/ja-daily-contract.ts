/**
 * lib/ja-daily-contract.ts — 🗓️ 오늘의 일본어 **저장·라우트 계약**(설계 §2-1·§4·§6). 순수 — 라우트·화면·스토어·eval 공용.
 *
 * - 저장 레코드: `JaDailyContentRecord`(컬렉션 `jaDailyContent`, 문서 id = `{kind}:{contentId}`) · `JaDailySessionRecord`(`jaDailySessions`, 문서 id = 클라이언트 id)
 * - 가져오기 결정 `decideJaDailyImport`(문서 단위 upsert — 해시 같으면 그대로, 파일에 없는 문서는 지우지 않는다)
 * - 세션 저장 zod `jaDailySessionSaveSchema` + 저장 결정 `decideJaDailySave`(앞질러 저장 400 · replay는 끝낸 n만)
 * - 🎤 판정 상수(0.8 맞음 · 0.5 아깝다)와 `judgeJaDailyLine` — 글자 대조는 말하기 모의고사의 `alignJaReadAloud`를 그대로 쓴다(AI 없음)
 * - 라우트 응답 타입(GET 색인·회차 내용·가져오기·저장·받아쓰기)
 *
 * store → 계약 한 방향(엄마 선례). 런타임 import: zod · ./ja-daily-content(값: 해시·분할 — 그쪽이 lib/ai/japanese/schemas를 끈다) ·
 * ./ja-speaking-score(import 0). 화면은 판정 함수·상수를 값으로 써도 되지만 zod·일본어 스키마 모듈이 함께 내려간다 — 판정만 필요하면
 * `./ja-speaking-score`를 직접 쓰는 편이 가볍다.
 */
import { z } from "zod";
import { JA_DAILY_VERDICTS, type JaDailyVerdict } from "./ja-daily-judge";
import {
  jaDailyDocId,
  jaDailyHash,
  splitJaDailyFile,
  JA_DAILY_CONTENT_KINDS,
  type JaDailyContentData,
  type JaDailyContentKind,
  type JaDailyImportFile,
  type JaDailyLesson,
  type JaDailyListeningItem,
  type JaDailyListeningTip,
  type JaDailyMock,
  type JaDailyMockItem,
  type JaDailyMockSection,
  type JaDailyTrack,
  type JaDailyVocabDay,
  type JaDailyWord,
} from "./ja-daily-content";
import type { JaDailyContentIndex, JaDailySession } from "./ja-daily-plan";

// ---------------------------------------------------------------------------
// 저장 레코드
// ---------------------------------------------------------------------------

export interface JaDailyContentRecord {
  /** 문서 id = `{kind}:{contentId}` */
  id: string;
  kind: JaDailyContentKind;
  /** 파일 안의 id(날은 `d{day}`, 모의 회차는 `r{round}`) */
  contentId: string;
  data: JaDailyContentData;
  hash: string;
  presetKey: string;
  importedAt: string;
}

export const JA_DAILY_STEP_STATES = ["done", "skipped"] as const;
export type JaDailyStepState = (typeof JA_DAILY_STEP_STATES)[number];
// 판정 상수·함수는 lib/ja-daily-judge.ts가 정의처다(2단계 — 화면 번들 경계). 여기서는 재수출만 한다.
export {
  JA_DAILY_VERDICTS,
  JA_DAILY_VERDICT_KO,
  JA_DAILY_PASS_ACCURACY,
  JA_DAILY_CLOSE_ACCURACY,
  jaDailyVerdictOf,
  judgeJaDailyLine,
  type JaDailyVerdict,
} from "./ja-daily-judge";
export const JA_DAILY_VOCAB_MODES = ["meaning", "reading"] as const;
export type JaDailyVocabMode = (typeof JA_DAILY_VOCAB_MODES)[number];

export interface JaDailyKaiwaCheck {
  lineId: string;
  /** 글자 일치율 0..1. 받아쓰기 없이 넘어감·스스로 판정이면 null(결과를 보고 넘어간 skipped는 잰 값을 남긴다) */
  accuracy: number | null;
  verdict: JaDailyVerdict;
  transcript: string | null;
}
export interface JaDailySessionRecord {
  id: string;
  n: number;
  replay: boolean;
  startedAt: string;
  finishedAt: string;
  steps: { kaiwa: JaDailyStepState; vocab: JaDailyStepState; exam: JaDailyStepState; review: JaDailyStepState };
  kaiwaChecks: JaDailyKaiwaCheck[];
  vocabAnswers: { wordId: string; mode: JaDailyVocabMode; correct: boolean }[];
  /** choice는 1부터. 청해 문제1·2처럼 스스로 확인하는 문항은 choice·correct 둘 다 null */
  examAnswers: { itemId: string; choice: number | null; correct: boolean | null }[];
}

export interface JaDailyImportCounts {
  added: number;
  updated: number;
  unchanged: number;
}
export type JaDailyImportResult = Record<JaDailyContentKind, JaDailyImportCounts>;

// ---------------------------------------------------------------------------
// 가져오기 결정(순수)
// ---------------------------------------------------------------------------

/**
 * 문서 단위 upsert. 비교는 **저장된 hash 필드**로만(저장 문서를 다시 해시하지 않는다 — Firestore 왕복이 키 순서를 바꿀 수 있다).
 * 파일에 없는 기존 문서는 건드리지 않는다(진도·기록 유지).
 */
export function decideJaDailyImport(
  file: JaDailyImportFile,
  existing: readonly Pick<JaDailyContentRecord, "id" | "hash">[],
  nowIso: string,
): { result: JaDailyImportResult; writes: JaDailyContentRecord[] } {
  const byId = new Map(existing.map((r) => [r.id, r.hash] as const));
  const result = Object.fromEntries(JA_DAILY_CONTENT_KINDS.map((k) => [k, { added: 0, updated: 0, unchanged: 0 }])) as JaDailyImportResult;
  const writes: JaDailyContentRecord[] = [];
  for (const part of splitJaDailyFile(file)) {
    const id = jaDailyDocId(part.kind, part.contentId);
    const hash = jaDailyHash(part.data);
    const cur = byId.get(id);
    if (cur === hash) {
      result[part.kind].unchanged += 1;
      continue;
    }
    result[part.kind][cur === undefined ? "added" : "updated"] += 1;
    writes.push({ id, kind: part.kind, contentId: part.contentId, data: part.data, hash, presetKey: file.presetKey, importedAt: nowIso });
  }
  return { result, writes };
}

/** 저장된 내용 → 과정 엔진 색인(문장·뜻 없이) */
export function toJaDailyContentIndex(records: readonly JaDailyContentRecord[]): JaDailyContentIndex {
  const idx: JaDailyContentIndex = { lessons: [], vocabDays: [], tips: [], litems: [], mocks: [] };
  for (const r of records) {
    if (r.kind === "lesson") {
      const l = r.data as JaDailyLesson;
      idx.lessons.push({
        id: l.id,
        step: l.step,
        lesson: l.lesson,
        kind: l.kind,
        titleJa: l.titleJa,
        titleKo: l.titleKo,
        tracks: l.tracks.map((t) => ({ audioKey: t.audioKey, part: t.part, lineIds: t.lines.map((x) => x.id) })),
        keyLineIds: [...l.keyLineIds],
      });
    } else if (r.kind === "vocab") {
      const d = r.data as JaDailyVocabDay;
      idx.vocabDays.push({ day: d.day, wordIds: d.words.map((w) => w.id) });
    } else if (r.kind === "tip") {
      const t = r.data as JaDailyListeningTip;
      idx.tips.push({ id: t.id, audioKey: t.audioKey, titleKo: t.titleKo });
    } else if (r.kind === "litem") {
      const it = r.data as JaDailyListeningItem;
      idx.litems.push({ id: it.id, audioKey: it.audioKey, mondai: it.mondai, no: it.no, example: it.example === true });
    } else if (r.kind === "mock") {
      const m = r.data as JaDailyMock;
      idx.mocks.push({
        round: m.round,
        sections: m.sections.map((s) => ({ section: s.section, mondai: s.mondai, points: s.points, items: s.items.map((it) => ({ id: it.id, no: it.no, passageId: it.passageId ?? null })) })),
      });
    }
  }
  // 색인 순서도 결정적으로(저장소 읽기 순서에 기대지 않는다)
  idx.lessons.sort((a, b) => a.step - b.step || a.lesson - b.lesson || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  idx.vocabDays.sort((a, b) => a.day - b.day);
  idx.tips.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  idx.litems.sort((a, b) => a.mondai - b.mondai || a.no - b.no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  idx.mocks.sort((a, b) => a.round - b.round);
  return idx;
}

// ---------------------------------------------------------------------------
// 세션 저장 계약
// ---------------------------------------------------------------------------

const RID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const CID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ISO = z.string().datetime();
const stepState = z.enum(JA_DAILY_STEP_STATES);

export const JA_DAILY_SAVE_LIMITS = { kaiwaChecks: 40, vocabAnswers: 80, examAnswers: 120, transcriptMax: 400, nMax: 999 } as const;

export const jaDailySessionSaveSchema: z.ZodType<JaDailySessionRecord> = z
  .object({
    id: RID,
    n: z.number().int().min(1).max(JA_DAILY_SAVE_LIMITS.nMax),
    replay: z.boolean(),
    startedAt: ISO,
    finishedAt: ISO,
    steps: z.object({ kaiwa: stepState, vocab: stepState, exam: stepState, review: stepState }).strict(),
    kaiwaChecks: z
      .array(
        z
          .object({
            lineId: CID,
            accuracy: z.number().min(0).max(1).nullable(),
            verdict: z.enum(JA_DAILY_VERDICTS),
            transcript: z.string().max(JA_DAILY_SAVE_LIMITS.transcriptMax).nullable(),
          })
          .strict(),
      )
      .max(JA_DAILY_SAVE_LIMITS.kaiwaChecks),
    vocabAnswers: z.array(z.object({ wordId: CID, mode: z.enum(JA_DAILY_VOCAB_MODES), correct: z.boolean() }).strict()).max(JA_DAILY_SAVE_LIMITS.vocabAnswers),
    examAnswers: z
      .array(z.object({ itemId: CID, choice: z.number().int().min(1).max(4).nullable(), correct: z.boolean().nullable() }).strict())
      .max(JA_DAILY_SAVE_LIMITS.examAnswers),
  })
  .strict()
  .refine((r) => r.finishedAt >= r.startedAt, { message: "finishedAt은 startedAt 이후여야 해요", path: ["finishedAt"] })
  .refine((r) => r.examAnswers.every((a) => (a.choice === null) === (a.correct === null)), { message: "choice와 correct는 함께 있거나 함께 null", path: ["examAnswers"] });

export type JaDailySaveDecision =
  | { kind: "reused"; record: JaDailySessionRecord }
  | { kind: "conflict" }
  | { kind: "ok" }
  | { kind: "ahead"; next: number }
  | { kind: "replay_not_done" };

/** 키 순서와 무관한 JSON(저장소 왕복이 키 순서를 바꿀 수 있다) */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * 저장 결정(순수). 같은 id → 넘긴 필드가 저장된 것과 모두 같으면 reused(그대로 200), 하나라도 다르면 conflict(409 — 클라이언트 버그를
 * 조용히 삼키지 않는다, QA daily1 P3-a). 진도 회차(replay=false)는 n ≤ 다음 회차만(앞질러 저장 거부),
 * 다시 하기(replay=true)는 진도 기록으로 끝낸 n만. 다음 회차 = 진도 기록의 n 최댓값 + 1(nextJaDailySession과 같은 규칙).
 */
export function decideJaDailySave(
  rec: Pick<JaDailySessionRecord, "id" | "n" | "replay"> & Partial<JaDailySessionRecord>,
  existing: readonly JaDailySessionRecord[],
): JaDailySaveDecision {
  const same = existing.find((r) => r.id === rec.id);
  if (same) {
    const fields = Object.keys(rec) as (keyof JaDailySessionRecord)[];
    const equal = fields.every((k) => canonicalJson(rec[k]) === canonicalJson(same[k]));
    return equal ? { kind: "reused", record: same } : { kind: "conflict" };
  }
  const progress = existing.filter((r) => !r.replay);
  const next = progress.reduce((m, r) => Math.max(m, r.n), 0) + 1;
  if (rec.replay) return progress.some((r) => r.n === rec.n) ? { kind: "ok" } : { kind: "replay_not_done" };
  return rec.n <= next ? { kind: "ok" } : { kind: "ahead", next };
}

// ---------------------------------------------------------------------------
// 🎤 핵심 문장 판정(0.8 맞음 · 0.5 아깝다, alignJaReadAloud(tokens, transcript) 재사용) — lib/ja-daily-judge.ts

// ---------------------------------------------------------------------------
// 실전모의 채점표(84회) — N5 환산(언어지식·독해 120점 · 청해 60점)
// ---------------------------------------------------------------------------

/** 합격 기준 — 종합 80/180 · 언어지식(문자·어휘·문법)·독해 38/120 · 청해 19/60 */
export const JA_N5_PASS = { total: 80, langReading: 38, listening: 19, langReadingMax: 120, listeningMax: 60 } as const;

export interface JaDailyMockScore {
  round: number;
  langReading: { raw: number; max: number; scaled: number; pass: boolean };
  listening: { raw: number; max: number; scaled: number; pass: boolean };
  total: number;
  pass: boolean;
  wrongItemIds: string[];
  unansweredItemIds: string[];
}

/**
 * 채점표 — 섹션의 `points`(문항 배점) 합을 원점수로, 언어지식·독해는 ÷(배점 합)×120, 청해는 ÷(배점 합)×60(반올림).
 * 배점 합은 교재 기준 79·54지만 반입 파일의 실제 합으로 나눈다(파일이 다르면 그 합이 기준). answers는 문항별 최신 답.
 */
export function scoreJaDailyMock(mock: JaDailyMock, answers: ReadonlyMap<string, { correct: boolean | null }>): JaDailyMockScore {
  let lr = 0;
  let lrMax = 0;
  let li = 0;
  let liMax = 0;
  const wrong: string[] = [];
  const unanswered: string[] = [];
  for (const s of mock.sections) {
    for (const it of s.items) {
      const listen = s.section === "listening";
      if (listen) liMax += s.points;
      else lrMax += s.points;
      const a = answers.get(it.id);
      if (!a || a.correct === null) unanswered.push(it.id);
      else if (a.correct) {
        if (listen) li += s.points;
        else lr += s.points;
      } else wrong.push(it.id);
    }
  }
  const scale = (raw: number, max: number, to: number) => (max > 0 ? Math.round((raw / max) * to) : 0);
  const lrScaled = scale(lr, lrMax, JA_N5_PASS.langReadingMax);
  const liScaled = scale(li, liMax, JA_N5_PASS.listeningMax);
  const total = lrScaled + liScaled;
  const lrPass = lrScaled >= JA_N5_PASS.langReading;
  const liPass = liScaled >= JA_N5_PASS.listening;
  return {
    round: mock.round,
    langReading: { raw: lr, max: lrMax, scaled: lrScaled, pass: lrPass },
    listening: { raw: li, max: liMax, scaled: liScaled, pass: liPass },
    total,
    pass: total >= JA_N5_PASS.total && lrPass && liPass,
    wrongItemIds: wrong,
    unansweredItemIds: unanswered,
  };
}

/** 기록들 → 문항별 최신 답(끝낸 기록의 finishedAt 순으로 덮는다 — 같은 시각이면 뒤의 것) */
export function latestJaDailyExamAnswers(records: readonly Pick<JaDailySessionRecord, "finishedAt" | "examAnswers">[]): Map<string, { choice: number | null; correct: boolean | null }> {
  const sorted = [...records].sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0));
  const out = new Map<string, { choice: number | null; correct: boolean | null }>();
  for (const r of sorted) for (const a of r.examAnswers) out.set(a.itemId, { choice: a.choice, correct: a.correct });
  return out;
}

// ---------------------------------------------------------------------------
// 라우트 응답
// ---------------------------------------------------------------------------

export interface JaDailyRecordSummary {
  id: string;
  n: number;
  replay: boolean;
  startedAt: string;
  finishedAt: string;
  steps: JaDailySessionRecord["steps"];
  checkCount: number;
  /** 🎤 정확도 평균(정확도 있는 체크만). 없으면 null */
  avgAccuracy: number | null;
  vocab: { correct: number; total: number };
  exam: { correct: number; total: number };
}

export function summarizeJaDailyRecord(r: JaDailySessionRecord): JaDailyRecordSummary {
  const acc = r.kaiwaChecks.map((c) => c.accuracy).filter((a): a is number => a !== null);
  const graded = r.examAnswers.filter((a) => a.correct !== null);
  return {
    id: r.id,
    n: r.n,
    replay: r.replay,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    steps: r.steps,
    checkCount: r.kaiwaChecks.length,
    avgAccuracy: acc.length > 0 ? acc.reduce((s, a) => s + a, 0) / acc.length : null,
    vocab: { correct: r.vocabAnswers.filter((a) => a.correct).length, total: r.vocabAnswers.length },
    exam: { correct: graded.filter((a) => a.correct === true).length, total: graded.length },
  };
}

/** GET /api/japanese/daily — 200 */
export interface JaDailyIndexOk {
  ok: true;
  today: string;
  hasContent: boolean;
  /** 종류별 저장 문서 수 */
  counts: Record<JaDailyContentKind, number>;
  content: JaDailyContentIndex;
  course: JaDailySession[];
  next: { n: number; session: JaDailySession | null; courseDone: boolean };
  /** 오늘(KST) 끝낸 진도 회차가 있으면 그 n(가장 큰 것), 없으면 null */
  doneTodayN: number | null;
  /** finishedAt 오름차순 */
  records: JaDailyRecordSummary[];
}
export type JaDailyIndexResponse = JaDailyIndexOk | { ok: false; error: "load_failed"; messageKo: string };

/** 회차 n의 칸별 내용 — GET /api/japanese/daily/session/[n] */
export interface JaDailyMockItemView {
  round: number;
  section: JaDailyMockSection["section"];
  mondai: number;
  points: number;
  instructionJa: string | null;
  instructionKo: string | null;
  passage: { id: string; ja: string; ko: string | null; introJa: string | null } | null;
  item: JaDailyMockItem;
}
export type JaDailyKaiwaView =
  | {
      type: "unit";
      lesson: Pick<JaDailyLesson, "id" | "step" | "lesson" | "kind" | "titleJa" | "titleKo" | "pointsKo">;
      unit: string;
      tracks: JaDailyTrack[];
      keyLineIds: string[];
      withPoints: boolean;
      /** 약한 과 다시 하기(큐가 끝난 뒤) — 과 전체 트랙 + 그 과의 🎤 */
      review: boolean;
    }
  | { type: "empty" };
export interface JaDailyVocabView {
  mode: "cards" | "dayTest" | "weak";
  day: number | null;
  /** 이번에 배우거나 시험 볼 단어 */
  words: JaDailyWord[];
  /** 오답 보기 재료 — 같은 DAY + 앞뒤 DAY 단어(weak면 고른 단어들의 DAY와 그 앞뒤) */
  pool: JaDailyWord[];
}
export type JaDailyExamView =
  | { type: "tip"; tip: JaDailyListeningTip; examples: JaDailyListeningItem[] }
  | { type: "litems"; items: JaDailyListeningItem[] }
  | { type: "mockItems" | "mockSection" | "mockReview"; round: number; items: JaDailyMockItemView[] }
  | { type: "mockScore"; round: number; score: JaDailyMockScore; items: JaDailyMockItemView[] }
  | { type: "weakItems" | "final"; litems: JaDailyListeningItem[]; mockItems: JaDailyMockItemView[] }
  | { type: "empty" };
export interface JaDailySessionOk {
  ok: true;
  n: number;
  total: number;
  /** 진도 다음 회차 */
  nextN: number;
  /** 이미 끝낸 회차를 다시 여는가(저장은 replay:true) */
  replay: boolean;
  session: JaDailySession;
  kaiwa: JaDailyKaiwaView;
  vocab: JaDailyVocabView;
  exam: JaDailyExamView;
}
export type JaDailySessionResponse =
  | JaDailySessionOk
  | { ok: false; error: "invalid_input" | "no_content" | "ahead" | "load_failed"; messageKo: string; nextN?: number };

/** POST /api/japanese/daily/import */
export type JaDailyImportResponse =
  | { ok: true; result: JaDailyImportResult }
  | { ok: false; error: "invalid_input"; messageKo: string; issues?: { path: string; message: string }[] }
  | { ok: false; error: "too_large" | "save_failed"; messageKo: string };

/** POST /api/japanese/daily/sessions */
export type JaDailySaveResponse =
  | { ok: true; reused: boolean }
  | { ok: false; error: "invalid_input"; messageKo: string; issues?: { path: string; message: string }[]; nextN?: number }
  | { ok: false; error: "too_large" | "save_failed" | "id_conflict"; messageKo: string };

/** POST /api/japanese/daily/transcribe */
export type JaDailyTranscribeResponse =
  | { ok: true; text: string }
  | { ok: false; error: "invalid_input" | "audio_too_large" | "no_api_key" | "client_closed"; messageKo: string }
  | { ok: false; error: "transcribe_failed"; messageKo: string; retriable: true };

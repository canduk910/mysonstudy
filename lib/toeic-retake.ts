/**
 * lib/toeic-retake.ts — 모의고사 **문항 단위 다시 풀기** 판정·합치기 순수 함수 (docs/harness/toeic.md §15, SPEC §20-13)
 *
 * 라우트(`POST …/retakes`·`POST …/retakes/[rid]/finish`·`PUT …/recordings/[q]`·지우기)·스토어 두 백엔드(파일 mutate · Firestore runTransaction)·
 * 결과 화면·"내 녹음" 목록·eval이 **같은 함수**를 본다(lib/toeic-attempt-rules 관용구 — 판정이 두 벌이면 어긋난다).
 *
 * ── 레코드(§15-1) ─────────────────────────────────────────────────────────────
 * 응시 기록에 셋을 더한다 — `retakes`(다시 풀기 기록) · `answerHistory`(밀려난 예전 답) · `answerDiags`(지금 답의 문항별 진단, §15-11).
 * **셋 다 answers 밖**이다: "닫힌 응시"(finishedAt !== null || answers.length > 0)·끝내기 한 번만(409 already_finished)은 그대로이고,
 * 합칠 때는 answers의 **그 q 항목만** 바꿔 끼운다(길이 불변 — 닫힘 판정이 뒤집힐 일이 없다).
 *
 * ── 세대 ──────────────────────────────────────────────────────────────────────
 * 지금 답의 세대 = 그 q 이력 마지막 줄의 replacedBy(= 지금 답을 만든 다시 풀기 id), 이력이 없으면 null(처음 응시).
 * 이력 줄의 세대 = 바로 앞 줄의 replacedBy(첫 줄은 null). 업로드 판정·채점 경합·이 기기 사본 쓰임새가 이 값 하나를 본다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-rec-rules·lib/toeic-mic-health·lib/toeic-score·lib/toeic-mock)뿐.
 *    lib/ai·lib/store는 타입만. 모듈 최상위에서 브라우저 전역을 읽지 않는다.
 */

import type { ToeicAnswer } from "./ai/toeic/schemas";
import { isToeicAttemptClosed } from "./toeic-attempt-rules";
import { normalizeToeicAnswerDiags, type ToeicAnswerDiag, type ToeicAnswerDiagStatus } from "./toeic-mic-health";
import { TOEIC_QUESTION_COUNT, toeicMaxScore } from "./toeic-mock";
import {
  applyToeicAttemptRecording,
  applyToeicRecordingDeletion,
  decideToeicRecordingUpload,
  isToeicRecQuestion,
  isToeicRecordingTombstoned,
  normalizeToeicStoredFixRecordings,
  normalizeToeicStoredRecordings,
  toeicRecDeletionPrefixes,
  toeicRecObjectPrefix,
  toeicRecordingDeletedAt,
  type ToeicRecDeleteTarget,
  type ToeicRecordingDeletion,
  type ToeicStoredFixRecording,
  type ToeicStoredRecording,
} from "./toeic-rec-rules";
import { estimateToeicTotal } from "./toeic-score";

// ===========================================================================
// 레코드 모양(§15-1)
// ===========================================================================

/** 다시 풀기 한 번 */
export interface ToeicRetakeSession {
  /** ^[A-Za-z0-9_-]{1,64}$ — 서버가 만든다 */
  id: string;
  /** 다시 푸는 문항(오름차순, attempt.questions 안, 1개 이상) */
  questions: number[];
  /** 서버 시각(ISO) */
  startedAt: string;
  /** null = 진행 중 */
  closedAt: string | null;
  /** 끝까지 = 시각 · 그만둠·닫힘(교체·만료) = null */
  finishedAt: string | null;
  /** 닫을 때 원래 결과에 합친 문항 */
  merged: number[];
  /** 진행 중에 올라온 녹음(합치기 전 대기 자리 — 합치면 비운다) */
  recordings: ToeicStoredRecording[];
  /** 이 다시 풀기의 문항별 진단(§15-11) */
  diags: ToeicAnswerDiag[];
}

/** 다시 풀기로 밀려난 예전 답 */
export interface ToeicAnswerHistoryEntry {
  q: number;
  /** 이 답을 밀어낸 다시 풀기 id */
  replacedBy: string;
  /** 밀려난 시각(그 다시 풀기를 닫은 서버 시각) */
  replacedAt: string;
  /** 밀려난 답 그대로 */
  answer: ToeicAnswer;
  /** 밀려난 녹음 메타(객체는 그대로 — 같은 키) */
  recording: ToeicStoredRecording | null;
  /** 밀려난 답의 고칠 문장 녹음(자리 번호가 그 답의 피드백 기준이라 함께 옮긴다) */
  fixRecordings: ToeicStoredFixRecording[];
  diag: ToeicAnswerDiag | null;
  /** 예전 답의 녹음을 지운 시각(지우면 recording·fixRecordings를 비운다 — 답은 남긴다) */
  recordingDeletedAt: string | null;
}

/** 같은 q 이력 줄 상한 — 넘으면 다시 풀기를 시작하지 않는다(409 history_full — 조용히 버리지 않는다) */
export const TOEIC_RETAKE_HISTORY_MAX = 10;
/** 진행 중 기록이 이보다 오래되면 다음 시작이 먼저 닫는다(탭이 죽어 끝 저장을 못 보낸 경우) */
export const TOEIC_RETAKE_STALE_MS = 2 * 60 * 60 * 1000;
/** 이력이 가리키지 않는 닫힌 기록은 최근 이만큼만 남긴다 */
export const TOEIC_RETAKE_SESSIONS_KEEP = 30;
/** 다시 풀기 id 모양(경로 조각 — 점·슬래시 없음) */
export const TOEIC_RETAKE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isToeicRetakeId(v: unknown): v is string {
  return typeof v === "string" && TOEIC_RETAKE_ID_RE.test(v);
}

/** 판정·합치기가 보는 응시 기록 최소 모양(ToeicAttemptRecord가 만족) */
export interface ToeicRetakeAttemptLike {
  questions: readonly number[];
  finishedAt: string | null;
  answers: readonly ToeicAnswer[];
  recordings: readonly ToeicStoredRecording[];
  fixRecordings: readonly ToeicStoredFixRecording[];
  recordingDeletions: readonly ToeicRecordingDeletion[];
  retakes: readonly ToeicRetakeSession[];
  answerHistory: readonly ToeicAnswerHistoryEntry[];
  answerDiags: readonly ToeicAnswerDiag[];
}

function isoMs(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** 빈 답(합칠 때의 새 답) — 채점 전 */
export function freshToeicAnswer(q: number, durationMs: number | null): ToeicAnswer {
  return { q, recorded: true, durationMs, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null };
}

// ===========================================================================
// 세대
// ===========================================================================

/** 그 q의 이력 줄(시간순) */
export function toeicHistoryOf<E extends { q: number }>(history: readonly E[], q: number): E[] {
  return history.filter((h) => h.q === q);
}

/** 지금 답의 세대 — 이력 마지막 줄의 replacedBy, 없으면 null(처음 응시) */
export function toeicAnswerSourceOf(attempt: { answerHistory: readonly { q: number; replacedBy: string }[] }, q: number): string | null {
  const rows = toeicHistoryOf(attempt.answerHistory, q);
  return rows.length > 0 ? rows[rows.length - 1].replacedBy : null;
}

/** 이력 줄(그 q 안의 순번 i)의 세대 — 앞 줄의 replacedBy, 첫 줄은 null */
export function toeicHistoryGenerationOf(rows: readonly { replacedBy: string }[], i: number): string | null {
  return i <= 0 ? null : rows[i - 1].replacedBy;
}

/** 세대의 시작 시각 — null(처음 응시)이면 응시 시작, 다시 풀기면 그 시작 */
export function toeicGenerationStartedAt(attempt: { startedAt: string; retakes: readonly { id: string; startedAt: string }[] }, gen: string | null): string {
  if (gen === null) return attempt.startedAt;
  return attempt.retakes.find((r) => r.id === gen)?.startedAt ?? attempt.startedAt;
}

/** 진행 중인 다시 풀기(없으면 null) */
export function toeicOpenRetake<R extends { closedAt: string | null }>(retakes: readonly R[]): R | null {
  return retakes.find((r) => r.closedAt === null) ?? null;
}

// ===========================================================================
// 시작(§15-2)
// ===========================================================================

/** 화면 주소의 `q=3,4` → 문항 목록(오름차순·중복 제거). 모양이 틀리면 null */
export function parseToeicRetakeQuestions(raw: string | null | undefined): number[] | null {
  const t = (raw ?? "").trim();
  if (!/^\d{1,2}(,\d{1,2}){0,10}$/.test(t)) return null;
  const qs = [...new Set(t.split(",").map(Number))].sort((a, b) => a - b);
  return qs.every((q) => isToeicRecQuestion(q)) ? qs : null;
}

/** 다시 풀기 결과 화면 주소 — `/toeic/attempts/{id}/retake?q=3,4` */
export function toeicRetakeHref(attemptId: string, qs: readonly number[]): string {
  const list = [...new Set(qs)].filter((q) => Number.isInteger(q)).sort((a, b) => a - b);
  return `/toeic/attempts/${encodeURIComponent(attemptId)}/retake?q=${list.join(",")}`;
}

export type ToeicRetakeStartDecision =
  | { kind: "start"; close: string[] }
  | { kind: "invalid" }
  | { kind: "question_not_found"; questions: number[] }
  | { kind: "not_finished" }
  | { kind: "in_progress"; open: { id: string; startedAt: string; questions: number[] } }
  | { kind: "history_full"; questions: number[] };

/**
 * 시작 판정(순수 — 원자 단위 **안에서도** 다시 부른다). 진행 중 기록은 응시 하나에 하나 — 오래됐거나(`TOEIC_RETAKE_STALE_MS`)
 * `replaceOpen`으로 고른 것은 `close`에 담아 시작 전에 닫는다(합치기 규칙 그대로 — 대기 자리 녹음이 있는 문항은 합친다).
 */
export function decideToeicRetakeStart(
  attempt: ToeicRetakeAttemptLike,
  questions: readonly unknown[],
  nowMs: number,
  replaceOpen: string | null = null,
): ToeicRetakeStartDecision {
  if (questions.length === 0 || questions.length > TOEIC_QUESTION_COUNT) return { kind: "invalid" };
  if (!questions.every((q) => typeof q === "number" && Number.isInteger(q))) return { kind: "invalid" };
  const qs = questions as number[];
  if (new Set(qs).size !== qs.length) return { kind: "invalid" };
  const outside = qs.filter((q) => !attempt.questions.includes(q));
  if (outside.length > 0) return { kind: "question_not_found", questions: [...outside].sort((a, b) => a - b) };
  if (!isToeicAttemptClosed(attempt)) return { kind: "not_finished" };
  const open = toeicOpenRetake(attempt.retakes);
  const close: string[] = [];
  if (open) {
    const stale = nowMs - isoMs(open.startedAt) >= TOEIC_RETAKE_STALE_MS;
    if (!stale && replaceOpen !== open.id) {
      return { kind: "in_progress", open: { id: open.id, startedAt: open.startedAt, questions: [...open.questions] } };
    }
    close.push(open.id);
  }
  const full = qs.filter((q) => toeicHistoryOf(attempt.answerHistory, q).length >= TOEIC_RETAKE_HISTORY_MAX);
  if (full.length > 0) return { kind: "history_full", questions: [...full].sort((a, b) => a - b) };
  return { kind: "start", close };
}

/** 새 다시 풀기 기록(진행 중) */
export function newToeicRetakeSession(id: string, questions: readonly number[], startedAtIso: string): ToeicRetakeSession {
  return { id, questions: [...new Set(questions)].sort((a, b) => a - b), startedAt: startedAtIso, closedAt: null, finishedAt: null, merged: [], recordings: [], diags: [] };
}

/**
 * 시작 적용(순수) — `close`의 진행 중 기록을 먼저 닫고(대기 자리 녹음이 있는 문항만 합친다 — 길이는 그 녹음 메타에서) 새 기록을 더한다.
 * 이력이 가리키지 않는 닫힌 기록은 최근 TOEIC_RETAKE_SESSIONS_KEEP개만 남긴다.
 */
export function applyToeicRetakeStart<T extends ToeicRetakeAttemptLike>(attempt: T, close: readonly string[], session: ToeicRetakeSession, nowIso: string): T {
  let next = attempt;
  for (const id of close) next = closeToeicRetake(next, id, null, nowIso).next;
  return pruneToeicRetakes({ ...next, retakes: [...next.retakes, session] });
}

function pruneToeicRetakes<T extends ToeicRetakeAttemptLike>(attempt: T): T {
  const referenced = new Set(attempt.answerHistory.map((h) => h.replacedBy));
  const closedFree = attempt.retakes.filter((r) => r.closedAt !== null && !referenced.has(r.id));
  if (closedFree.length <= TOEIC_RETAKE_SESSIONS_KEEP) return attempt;
  const drop = new Set(
    [...closedFree]
      .sort((a, b) => isoMs(a.startedAt) - isoMs(b.startedAt))
      .slice(0, closedFree.length - TOEIC_RETAKE_SESSIONS_KEEP)
      .map((r) => r.id),
  );
  return { ...attempt, retakes: attempt.retakes.filter((r) => !drop.has(r.id)) };
}

// ===========================================================================
// 끝·합치기(§15-5)
// ===========================================================================

export interface ToeicRetakeFinishInput {
  finishedAt: string | null;
  answers: readonly { q: number; recorded: boolean; durationMs: number | null }[];
  diags?: readonly ToeicAnswerDiag[];
}

/**
 * 기록 하나를 닫는다(순수). `input`이 null이면 자동 닫기(교체·만료 — 대기 자리에 녹음이 있는 문항만 합친다).
 * 합치기 — 녹음됐거나(recorded + 길이) 대기 자리에 녹음이 있는 문항: 지금 답·지금 녹음 메타·그 답의 고칠 문장 녹음·지금 진단을 이력 한 줄로
 * 옮기고 그 자리를 새 답(채점 전)·대기 녹음 메타·이번 진단으로 바꾼다. 녹음이 없는 문항은 원래 답을 그대로 둔다.
 */
function closeToeicRetake<T extends ToeicRetakeAttemptLike>(
  attempt: T,
  retakeId: string,
  input: ToeicRetakeFinishInput | null,
  nowIso: string,
): { next: T; merged: number[] } {
  const session = attempt.retakes.find((r) => r.id === retakeId);
  if (!session || session.closedAt !== null) return { next: attempt, merged: [] };
  const byQ = new Map((input?.answers ?? []).map((a) => [a.q, a] as const));
  const diagsIn = normalizeToeicAnswerDiags(input?.diags ?? []).filter((d) => session.questions.includes(d.q));
  let answers = [...attempt.answers];
  let recordings = [...attempt.recordings];
  let fixRecordings = [...attempt.fixRecordings];
  let answerDiags = [...attempt.answerDiags];
  const history = [...attempt.answerHistory];
  const merged: number[] = [];
  for (const q of session.questions) {
    const a = byQ.get(q);
    const staged = session.recordings.find((r) => r.q === q) ?? null;
    const recordedNow = a !== undefined && a.recorded === true && a.durationMs !== null && a.durationMs > 0;
    if (!recordedNow && staged === null) continue; // 녹음이 없다 — 원래 답 그대로(다시 풀다 또 실패해도 잃지 않는다)
    const oldAnswer = answers.find((x) => x.q === q) ?? { ...freshToeicAnswer(q, null), recorded: false };
    history.push({
      q,
      replacedBy: session.id,
      replacedAt: nowIso,
      answer: { ...oldAnswer },
      recording: recordings.find((r) => r.q === q) ?? null,
      fixRecordings: fixRecordings.filter((r) => r.q === q),
      diag: answerDiags.find((d) => d.q === q) ?? null,
      recordingDeletedAt: null,
    });
    const durationMs = recordedNow ? Math.round(a!.durationMs!) : staged!.durationMs;
    const fresh = freshToeicAnswer(q, durationMs);
    answers = answers.some((x) => x.q === q) ? answers.map((x) => (x.q === q ? fresh : x)) : [...answers, fresh].sort((x, y) => x.q - y.q);
    recordings = recordings.filter((r) => r.q !== q);
    if (staged) recordings = [...recordings, staged].sort((x, y) => x.q - y.q);
    fixRecordings = fixRecordings.filter((r) => r.q !== q);
    const d = diagsIn.find((x) => x.q === q) ?? null;
    answerDiags = answerDiags.filter((x) => x.q !== q);
    if (d) answerDiags = [...answerDiags, d].sort((x, y) => x.q - y.q);
    merged.push(q);
  }
  history.sort((x, y) => x.q - y.q || isoMs(x.replacedAt) - isoMs(y.replacedAt));
  const closed: ToeicRetakeSession = {
    ...session,
    closedAt: nowIso,
    finishedAt: input ? input.finishedAt : null,
    merged,
    recordings: [],
    diags: diagsIn,
  };
  return {
    next: {
      ...attempt,
      answers,
      recordings,
      fixRecordings,
      answerDiags,
      answerHistory: history,
      retakes: attempt.retakes.map((r) => (r.id === session.id ? closed : r)),
    },
    merged,
  };
}

/**
 * 다시 풀기 끝 적용(순수) — **한 번만**(이미 닫혔으면 already_closed, 쓰지 않는다). 범위 밖 문항은 무시한다(라우트 zod가 먼저 400).
 */
export function applyToeicRetakeFinish<T extends ToeicRetakeAttemptLike>(
  attempt: T,
  retakeId: string,
  input: ToeicRetakeFinishInput,
  nowIso: string,
): { outcome: "finished" | "already_closed" | "retake_not_found"; next: T; merged: number[] } {
  const session = attempt.retakes.find((r) => r.id === retakeId);
  if (!session) return { outcome: "retake_not_found", next: attempt, merged: [] };
  if (session.closedAt !== null) return { outcome: "already_closed", next: attempt, merged: [...session.merged] };
  const { next, merged } = closeToeicRetake(attempt, retakeId, input, nowIso);
  return { outcome: "finished", next, merged };
}

// ===========================================================================
// 업로드 세대 판정(§15-4)
// ===========================================================================

export type ToeicAnswerUploadDecision =
  | { kind: "question_not_found" }
  | { kind: "retake_not_found" }
  | { kind: "deleted" }
  | { kind: "locked" }
  | { kind: "retaken" }
  | { kind: "store"; slot: "current" }
  | { kind: "store_staged"; slot: "staged" }
  | { kind: "store_history"; slot: "history"; index: number }
  | { kind: "reused" | "superseded"; slot: "current" | "staged" | "history"; existing: ToeicStoredRecording };

/**
 * 답변 녹음 업로드 판정 — 녹음의 세대(`gen` = 그 녹음을 만든 다시 풀기 id, 처음 응시는 null)를 본다. 원자 단위 **안에서도** 다시 부른다.
 * 이력이 없고 gen이 null이면 §13-4 표(decideToeicRecordingUpload)와 같은 결과다(eval이 무작위로 대조한다).
 */
export function decideToeicAnswerUpload(
  attempt: ToeicRetakeAttemptLike,
  q: number,
  gen: string | null,
  incoming: { sha256: string; recordedAtMs: number },
): ToeicAnswerUploadDecision {
  if (!attempt.questions.includes(q)) return { kind: "question_not_found" };
  let session: ToeicRetakeSession | null = null;
  if (gen !== null) {
    session = attempt.retakes.find((r) => r.id === gen) ?? null;
    if (!session) return { kind: "retake_not_found" };
    if (!session.questions.includes(q)) return { kind: "question_not_found" };
  }
  if (isToeicRecordingTombstoned(attempt.recordingDeletions, q, null, incoming.recordedAtMs)) return { kind: "deleted" };
  // 진행 중 — 대기 자리 표(잠그지 않는다 — 아직 채점 전)
  if (session && session.closedAt === null) {
    const cur = session.recordings.find((r) => r.q === q);
    if (!cur) return { kind: "store_staged", slot: "staged" };
    if (cur.sha256 === incoming.sha256) return { kind: "reused", slot: "staged", existing: cur };
    if (incoming.recordedAtMs <= isoMs(cur.recordedAt)) return { kind: "superseded", slot: "staged", existing: cur };
    return { kind: "store_staged", slot: "staged" };
  }
  if (session && !session.merged.includes(q)) return { kind: "retaken" };
  const source = toeicAnswerSourceOf(attempt, q);
  if (gen === source) {
    const d = decideToeicRecordingUpload(attempt, q, incoming);
    const cur = attempt.recordings.find((r) => r.q === q) ?? null;
    if (d === "store") return { kind: "store", slot: "current" };
    if ((d === "reused" || d === "superseded") && cur) return { kind: d, slot: "current", existing: cur };
    if (d === "locked") return { kind: "locked" };
    if (d === "deleted") return { kind: "deleted" };
    if (d === "question_not_found") return { kind: "question_not_found" };
    return { kind: "store", slot: "current" };
  }
  // 예전 세대 — 그 이력 줄에 녹음이 없으면 붙인다(다른 기기에서 늦게 온 예전 녹음)
  const rows = toeicHistoryOf(attempt.answerHistory, q);
  const i = rows.findIndex((_, k) => toeicHistoryGenerationOf(rows, k) === gen);
  if (i < 0) return { kind: "retaken" };
  const row = rows[i];
  if (row.recording && row.recording.sha256 === incoming.sha256) return { kind: "reused", slot: "history", existing: row.recording };
  if (row.recording || row.recordingDeletedAt !== null || row.answer.recorded !== true) return { kind: "retaken" };
  const index = attempt.answerHistory.indexOf(row);
  return { kind: "store_history", slot: "history", index };
}

/** 판정 적용(순수) — store·store_staged·store_history만 바꾼다(다른 판정이면 그대로) */
export function applyToeicAnswerUpload<T extends ToeicRetakeAttemptLike>(attempt: T, gen: string | null, decision: ToeicAnswerUploadDecision, recording: ToeicStoredRecording): T {
  if (decision.kind === "store") return applyToeicAttemptRecording(attempt, recording);
  if (decision.kind === "store_staged") {
    return {
      ...attempt,
      retakes: attempt.retakes.map((r) =>
        r.id === gen ? { ...r, recordings: [...r.recordings.filter((x) => x.q !== recording.q), recording].sort((a, b) => a.q - b.q) } : r,
      ),
    };
  }
  if (decision.kind === "store_history") {
    return { ...attempt, answerHistory: attempt.answerHistory.map((h, k) => (k === decision.index ? { ...h, recording } : h)) };
  }
  return attempt;
}

/** 저장 뒤 그 자리의 메타(응답용) — slot에 따라 지금 자리·대기 자리·이력 줄 */
export function toeicAnswerUploadSlotMeta(
  attempt: ToeicRetakeAttemptLike,
  q: number,
  gen: string | null,
  slot: "current" | "staged" | "history",
  sha256: string,
): ToeicStoredRecording | null {
  if (slot === "current") return attempt.recordings.find((r) => r.q === q) ?? null;
  if (slot === "staged") return attempt.retakes.find((r) => r.id === gen)?.recordings.find((r) => r.q === q) ?? null;
  return attempt.answerHistory.find((h) => h.q === q && h.recording?.sha256 === sha256)?.recording ?? null;
}

/** 이력 줄 하나(q · replacedBy) */
export function toeicHistoryEntryOf<E extends { q: number; replacedBy: string }>(history: readonly E[], q: number, replacedBy: string): E | null {
  return history.find((h) => h.q === q && h.replacedBy === replacedBy) ?? null;
}

// ===========================================================================
// 지우기(§15-8)
// ===========================================================================

/** 지울 대상 — §14의 셋 + 예전 답 하나(그 줄의 답변 녹음 + 고칠 문장 녹음) */
export type ToeicRecDeleteTargetAll = ToeicRecDeleteTarget | { kind: "history"; q: number; replacedBy: string };

/**
 * 지울 계획(순수) — 이력이 없으면 §14-2 접두사 그대로. 그 q에 이력이 있으면 지금 답·고칠 문장은 **그 메타의 키만**(세대가 같은 접두사를
 * 쓰므로 접두사로 지우면 예전 답 녹음까지 사라진다). 예전 답은 늘 그 줄의 키들만. 응시 통째는 접두사.
 */
export function toeicRecDeletionPlan(attemptId: string, attempt: ToeicRetakeAttemptLike, target: ToeicRecDeleteTargetAll): { prefixes: string[]; keys: string[] } {
  toeicRecObjectPrefix(attemptId); // 모양 검사(던진다)
  if (target.kind === "attempt") return { prefixes: toeicRecDeletionPrefixes(attemptId, target), keys: [] };
  if (target.kind === "history") {
    const row = toeicHistoryEntryOf(attempt.answerHistory, target.q, target.replacedBy);
    if (!row) return { prefixes: [], keys: [] };
    return { prefixes: [], keys: [...(row.recording ? [row.recording.objectKey] : []), ...row.fixRecordings.map((f) => f.objectKey)] };
  }
  const hasHistory = toeicHistoryOf(attempt.answerHistory, target.q).length > 0;
  if (!hasHistory) return { prefixes: toeicRecDeletionPrefixes(attemptId, target), keys: [] };
  if (target.kind === "answer") {
    const cur = attempt.recordings.find((r) => r.q === target.q);
    return { prefixes: [], keys: cur ? [cur.objectKey] : [] };
  }
  const cur = attempt.fixRecordings.find((r) => r.q === target.q && r.fixIndex === target.fixIndex);
  return { prefixes: [], keys: cur ? [cur.objectKey] : [] };
}

/**
 * 지우기 적용(순수) — §14의 셋은 lib/toeic-rec-rules applyToeicRecordingDeletion 그대로(+ 응시 통째면 이력 녹음·대기 자리 메타도 비운다).
 * 예전 답은 그 줄의 recording·fixRecordings를 비우고 recordingDeletedAt을 남긴다(답·점수는 그대로, 지운 자리는 남기지 않는다 —
 * 예전 세대 업로드는 recordingDeletedAt을 보고 받지 않는다).
 */
export function applyToeicRecordingDeletionAll<T extends ToeicRetakeAttemptLike>(
  attempt: T,
  target: ToeicRecDeleteTargetAll,
  deletedAtIso: string,
): { next: T; removedAnswers: ToeicStoredRecording[]; removedFixes: ToeicStoredFixRecording[] } {
  if (target.kind === "history") {
    const row = toeicHistoryEntryOf(attempt.answerHistory, target.q, target.replacedBy);
    if (!row) return { next: attempt, removedAnswers: [], removedFixes: [] };
    const next = {
      ...attempt,
      answerHistory: attempt.answerHistory.map((h) => (h === row ? { ...h, recording: null, fixRecordings: [], recordingDeletedAt: deletedAtIso } : h)),
    };
    return { next, removedAnswers: row.recording ? [row.recording] : [], removedFixes: [...row.fixRecordings] };
  }
  const base = applyToeicRecordingDeletion(attempt, target, deletedAtIso);
  if (target.kind !== "attempt") return base;
  const removedAnswers = [...base.removedAnswers];
  const removedFixes = [...base.removedFixes];
  const answerHistory = base.next.answerHistory.map((h) => {
    if (h.recording) removedAnswers.push(h.recording);
    removedFixes.push(...h.fixRecordings);
    return h.recording || h.fixRecordings.length > 0 ? { ...h, recording: null, fixRecordings: [], recordingDeletedAt: deletedAtIso } : h;
  });
  const retakes = base.next.retakes.map((r) => {
    removedAnswers.push(...r.recordings);
    return r.recordings.length > 0 ? { ...r, recordings: [] } : r;
  });
  return { next: { ...base.next, answerHistory, retakes }, removedAnswers, removedFixes };
}

// ===========================================================================
// 결과 화면(§15-6·§15-7)
// ===========================================================================

/**
 * 이 기기 사본의 쓰임새 — 사본의 retakeId(옛 메타 = null)가 지금 세대와 같으면 "지금 녹음", 이력 줄의 세대와 같으면 그 줄, 아니면 쓰지 않는다.
 * 다른 기기에서 다시 풀어 세대가 바뀐 뒤 이 기기의 예전 사본으로 새 답을 채점하던 길을 막는다.
 */
export function toeicLocalCopyRole(
  attempt: { answerHistory: readonly { q: number; replacedBy: string }[] },
  q: number,
  localRetakeId: string | null | undefined,
): { role: "current" } | { role: "history"; replacedBy: string } | { role: "stale" } {
  const gen = localRetakeId ?? null;
  if (gen === toeicAnswerSourceOf(attempt, q)) return { role: "current" };
  const rows = toeicHistoryOf(attempt.answerHistory, q);
  const i = rows.findIndex((_, k) => toeicHistoryGenerationOf(rows, k) === gen);
  return i >= 0 ? { role: "history", replacedBy: rows[i].replacedBy } : { role: "stale" };
}

/**
 * 지금 답의 녹음을 지웠는가(순수 — 결과 화면 "🗑 녹음을 지웠어요"·오류 문항 "녹음 지움") — 그 자리(응시 통째 포함)의 가장 늦은 지운 시각이
 * **지금 답 세대의 시작보다 늦을 때만** 참이다(QA rec-retake P2-1). 지운 뒤 다시 풀어 합친 새 답은 지운 자리보다 늦게 시작했으므로 "지움"이 아니라
 * "아직 서버에 올라가지 않았어요" 갈래다(서버도 그 세대의 늦은 업로드를 지운 자리로 막지 않는다 — 녹음 시각 > 지운 시각).
 * 소리(이 기기·서버 사본)가 있는지는 부르는 쪽이 따로 본다.
 */
export function toeicAnswerRecordingDeleted(
  attempt: {
    startedAt: string;
    retakes: readonly { id: string; startedAt: string }[];
    answerHistory: readonly { q: number; replacedBy: string }[];
    recordingDeletions: readonly ToeicRecordingDeletion[];
  },
  q: number,
): boolean {
  const deletedAt = toeicRecordingDeletedAt(attempt.recordingDeletions, q, null);
  if (deletedAt === null) return false;
  return isoMs(deletedAt) > isoMs(toeicGenerationStartedAt(attempt, toeicAnswerSourceOf(attempt, q)));
}

/**
 * 지운 예전 답의 이 기기 사본(순수 — QA rec-retake P2-4) — 사본의 쓰임새가 이력 줄이고 그 줄의 `recordingDeletedAt`이 있으면 지울 대상이다.
 * 예전 답 지우기는 지운 자리를 남기지 않으므로(§15-8) 지운 자리만 보는 정리로는 다른 기기 사본이 남아 ③에서 계속 재생된다.
 * `keepGeneration` = 그 q의 지금 답 세대 — lib/toeic-rec-store deleteToeicRecordingsLocal에 그대로 넘겨 지금 답 사본은 남긴다. q 오름차순·중복 없음.
 */
export function toeicDeletedHistoryLocalCopies(
  attempt: { answerHistory: readonly { q: number; replacedBy: string; recordingDeletedAt: string | null }[] },
  locals: readonly { q: number; retakeId?: string | null }[],
): { q: number; keepGeneration: string | null }[] {
  const out = new Map<number, { q: number; keepGeneration: string | null }>();
  for (const m of locals) {
    const role = toeicLocalCopyRole(attempt, m.q, m.retakeId ?? null);
    if (role.role !== "history") continue;
    const row = toeicHistoryEntryOf(attempt.answerHistory, m.q, role.replacedBy);
    if (!row || typeof row.recordingDeletedAt !== "string" || row.recordingDeletedAt === "") continue; // 없거나 null = 지운 적 없음(옛 요약 방어)
    out.set(m.q, { q: m.q, keepGeneration: toeicAnswerSourceOf(attempt, m.q) });
  }
  return [...out.values()].sort((a, b) => a.q - b.q);
}

/**
 * 다른 응시(같은 모의고사의 앞 응시)의 이 기기 사본 가르기(순수 — QA rec-retake 2 P2-5) — 결과 화면 ③ "그 응시의 지금 답" 행은 이 기기 사본을
 * 서버 사본보다 먼저 트므로, **그 응시의 answerHistory 기준 쓰임새가 current인 사본만** `current`에 넣는다(이 응시 사본·목록과 같은 판정 —
 * `toeicLocalCopyRole`). 다른 기기에서 그 응시를 다시 풀어 합쳤으면 이 기기의 예전 세대 사본은 history(서버 이력 사본으로 충분하다)·stale이라 쓰지 않는다.
 * `purge` = 그 응시에서 지운 예전 답의 이 기기 사본(`toeicDeletedHistoryLocalCopies` 그대로 — keepGeneration은 그 응시의 지금 세대).
 * 이력 줄에 `recordingDeletedAt`이 없으면(옛 요약) 지운 적 없음으로 읽는다. 입력 순서를 지킨다.
 */
export function toeicOtherAttemptLocalCopies<T extends { q: number; retakeId?: string | null }>(
  attempt: { answerHistory: readonly { q: number; replacedBy: string; recordingDeletedAt?: string | null }[] },
  locals: readonly T[],
): { current: T[]; purge: { q: number; keepGeneration: string | null }[] } {
  const hist = { answerHistory: attempt.answerHistory.map((h) => ({ q: h.q, replacedBy: h.replacedBy, recordingDeletedAt: h.recordingDeletedAt ?? null })) };
  return {
    current: locals.filter((m) => toeicLocalCopyRole(hist, m.q, m.retakeId ?? null).role === "current"),
    purge: toeicDeletedHistoryLocalCopies(hist, locals),
  };
}

/**
 * 다시 풀기 끝 화면의 문구 근거(순수 — QA rec-retake P2-2) — 이 기기에서 녹음한 문항(`recordedHere`)을 서버 응답(200·409 already_finished)의
 * `merged`로 가른다. `merged` = 원래 결과에 합쳐진 문항(이 기기에서 녹음하지 않았어도 대기 자리에 올라와 합쳐졌으면 든다),
 * `notMerged` = 이 기기에서 녹음했는데 합쳐지지 않은 문항(다른 기기·탭이 다시 풀기를 새로 시작해 먼저 닫았거나 오래돼 닫혔다 —
 * 그 녹음은 들어갈 자리가 없어 서버가 저장하지 않는다, §15-4 5번 `retaken`).
 */
export function toeicRetakeFinishOutcome(recordedHere: readonly number[], merged: readonly number[]): { merged: number[]; notMerged: number[] } {
  const m = new Set(merged);
  return {
    merged: [...m].sort((a, b) => a - b),
    notMerged: [...new Set(recordedHere)].filter((q) => !m.has(q)).sort((a, b) => a - b),
  };
}

export type ToeicErrorReason = "no_recording" | "failed" | "interrupted" | "empty" | "nomic" | "silent" | "deleted" | "score_failed";

export const TOEIC_ERROR_REASON_KO: Record<ToeicErrorReason, string> = {
  no_recording: "녹음 없음",
  failed: "녹음 실패",
  interrupted: "중단됨",
  empty: "소리 없음",
  nomic: "녹음 없이",
  silent: "소리 없음(무음)",
  deleted: "녹음 지움",
  score_failed: "채점 실패",
};

/**
 * 오류 문항(순수 — "↻ 오류 문항 n개 다시 풀기") — 녹음 없음(진단 상태로 실패·중단·소리 없음·녹음 없이를 가른다) · 소리 없음(무음) ·
 * 녹음 지움(녹음됐는데 소리가 없고 지운 자리가 있다) · 채점 실패(전사문은 있는데 점수가 없다, 또는 이 화면의 채점이 실패했다).
 */
export function toeicErrorQuestions(
  rows: readonly {
    q: number;
    recorded: boolean;
    score: number | null;
    transcript: string | null;
    diagStatus: ToeicAnswerDiagStatus | null;
    silent: boolean;
    deleted: boolean;
    scoreFailed: boolean;
  }[],
): { q: number; reason: ToeicErrorReason }[] {
  const out: { q: number; reason: ToeicErrorReason }[] = [];
  for (const r of [...rows].sort((a, b) => a.q - b.q)) {
    if (!r.recorded) {
      const s = r.diagStatus;
      out.push({ q: r.q, reason: s === "failed" || s === "interrupted" || s === "empty" || s === "nomic" || s === "silent" ? s : "no_recording" });
      continue;
    }
    if (r.silent) out.push({ q: r.q, reason: "silent" });
    else if (r.deleted) out.push({ q: r.q, reason: "deleted" });
    else if (r.score === null && (r.scoreFailed || r.transcript !== null)) out.push({ q: r.q, reason: "score_failed" });
  }
  return out;
}

/**
 * 다시 풀기 전 추정(순수) — 이력이 있는 문항은 **첫** 줄의 답(처음 응시의 답)으로 바꿔 끼운 추정. 이력이 없으면 null.
 * 결과 머리 "다시 풀기 전 추정 140 → 지금 150 (+10)".
 */
export function toeicRetakeEstimates(
  answers: readonly { q: number; score: number | null }[],
  history: readonly { q: number; answer: { q: number; score: number | null } }[],
): { before: ReturnType<typeof estimateToeicTotal>; now: ReturnType<typeof estimateToeicTotal> } | null {
  if (history.length === 0) return null;
  const firstByQ = new Map<number, { q: number; score: number | null }>();
  for (const h of history) if (!firstByQ.has(h.q)) firstByQ.set(h.q, h.answer);
  const before = answers.map((a) => (firstByQ.has(a.q) ? { ...a, score: firstByQ.get(a.q)!.score } : a));
  return { before: estimateToeicTotal(before), now: estimateToeicTotal(answers) };
}

/** 비교 ③에 넘기는 이력 줄(줄인 자료 — 피드백 본문 없음) */
export interface ToeicCompareHistoryEntry {
  q: number;
  replacedBy: string;
  /** 그 답 세대의 시작 시각(처음 응시면 응시 시작, 다시 풀기면 그 시작) */
  startedAt: string;
  recorded: boolean;
  score: number | null;
  transcript: string | null;
  hasRecording: boolean;
  /** 그 예전 답의 녹음을 지운 시각(없으면 null) — 결과 화면이 그 응시의 지운 예전 답 이 기기 사본을 정리한다(QA rec-retake 2 P2-5). 옛 자료엔 없다 */
  recordingDeletedAt?: string | null;
}

/** 응시 기록 → 비교용 이력 줄 + 지금 답의 세대 시작 시각(문항마다) */
export function toToeicCompareHistory(attempt: {
  startedAt: string;
  retakes: readonly { id: string; startedAt: string }[];
  answerHistory: readonly ToeicAnswerHistoryEntry[];
}): { answerHistory: ToeicCompareHistoryEntry[]; answerSince: { q: number; startedAt: string }[] } {
  const out: ToeicCompareHistoryEntry[] = [];
  const since: { q: number; startedAt: string }[] = [];
  const qs = [...new Set(attempt.answerHistory.map((h) => h.q))].sort((a, b) => a - b);
  for (const q of qs) {
    const rows = toeicHistoryOf(attempt.answerHistory, q);
    rows.forEach((h, k) => {
      out.push({
        q,
        replacedBy: h.replacedBy,
        startedAt: toeicGenerationStartedAt(attempt, toeicHistoryGenerationOf(rows, k)),
        recorded: h.answer.recorded === true,
        score: h.answer.score,
        transcript: h.answer.transcript,
        hasRecording: h.recording !== null,
        recordingDeletedAt: h.recordingDeletedAt ?? null,
      });
    });
    since.push({ q, startedAt: toeicGenerationStartedAt(attempt, rows[rows.length - 1].replacedBy) });
  }
  return { answerHistory: out, answerSince: since };
}

/** 만점(비교 행) — 범위 밖이면 0 */
export function toeicRetakeMaxScore(q: number): number {
  return Number.isInteger(q) && q >= 1 && q <= TOEIC_QUESTION_COUNT ? toeicMaxScore(q) : 0;
}

// ===========================================================================
// 정규화(§15-1) — 저장 레코드 방어. 던지지 않는다. (이력 줄의 answer 정규화는 서버 lib/toeic-normalize가 한다)
// ===========================================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const qList = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.filter((q): q is number => isToeicRecQuestion(q)))].sort((a, b) => a - b) : [];

/** 다시 풀기 기록 정규화 — 깨진 항목은 버리고 같은 id는 처음 하나, startedAt 오름차순 */
export function normalizeToeicRetakes(v: unknown): ToeicRetakeSession[] {
  if (!Array.isArray(v)) return [];
  const out: ToeicRetakeSession[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isObj(raw) || !isToeicRetakeId(raw.id) || seen.has(raw.id)) continue;
    if (typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) continue;
    const questions = qList(raw.questions);
    if (questions.length === 0) continue;
    seen.add(raw.id);
    out.push({
      id: raw.id,
      questions,
      startedAt: raw.startedAt,
      closedAt: typeof raw.closedAt === "string" ? raw.closedAt : null,
      finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
      merged: qList(raw.merged).filter((q) => questions.includes(q)),
      recordings: normalizeToeicStoredRecordings(raw.recordings),
      diags: normalizeToeicAnswerDiags(raw.diags),
    });
  }
  return out.sort((a, b) => isoMs(a.startedAt) - isoMs(b.startedAt));
}

/**
 * 이력 줄 정규화 — `normalizeAnswer`(서버의 normalizeToeicAnswer)를 받는다(이 모듈은 zod를 싣지 않는다). 깨진 줄은 버리고
 * q 오름차순 · 같은 q는 replacedAt 오름차순. 같은 (q, replacedBy)는 처음 하나.
 */
export function normalizeToeicAnswerHistory(v: unknown, normalizeAnswer: (v: unknown) => ToeicAnswer): ToeicAnswerHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ToeicAnswerHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isObj(raw) || !isToeicRecQuestion(raw.q) || !isToeicRetakeId(raw.replacedBy)) continue;
    if (typeof raw.replacedAt !== "string" || !Number.isFinite(Date.parse(raw.replacedAt))) continue;
    const k = `${raw.q}:${raw.replacedBy}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const answer = normalizeAnswer(raw.answer);
    const recs = normalizeToeicStoredRecordings(raw.recording ? [raw.recording] : []);
    const diags = normalizeToeicAnswerDiags(raw.diag ? [raw.diag] : []);
    out.push({
      q: raw.q,
      replacedBy: raw.replacedBy,
      replacedAt: raw.replacedAt,
      answer: { ...answer, q: raw.q },
      recording: recs[0] ?? null,
      fixRecordings: normalizeToeicStoredFixRecordings(raw.fixRecordings).filter((f) => f.q === raw.q),
      diag: diags[0] ?? null,
      recordingDeletedAt: typeof raw.recordingDeletedAt === "string" ? raw.recordingDeletedAt : null,
    });
  }
  return out.sort((a, b) => a.q - b.q || isoMs(a.replacedAt) - isoMs(b.replacedAt));
}

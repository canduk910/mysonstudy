/**
 * lib/toeic-rec-delete.ts — 내 녹음 **지우기** 한 벌(서버 전용) (docs/harness/toeic.md §14-4, SPEC §20-12)
 *
 * 세 라우트(`DELETE …/recordings/[q]` 답변 한 문항 · `DELETE …/recordings/[q]/fixes/[i]` 고칠 문장 하나 · `DELETE …/recordings` 응시 통째)가
 * 같은 순서를 쓴다 — **서버 보관소 먼저 → 메타 정리**:
 *   1. 응시(404 attempt_not_found)·문항 범위(404 question_not_found — 응시 통째는 검사 없음)
 *   2. 보관소에서 그 자리 접두사를 지운다(대체된 옛 객체까지). 실패하면 **메타를 건드리지 않고** 500 delete_failed(retriable) —
 *      다시 누르면 접두사 지우기부터(이미 지운 것은 0건 — 멱등). prod-guard(개발 환경 GCS)면 403 prod_guard.
 *   3. 스토어 원자 단위 안에서 메타를 빼고 **지운 자리**(recordingDeletions)를 남긴다 — 지운 뒤 다른 기기 대기열이 같은 녹음을 다시 올려도
 *      업로드 판정이 "deleted"로 거부한다(녹음이 되살아나지 않게). answers(점수·전사·피드백)는 그대로다.
 *      메타 정리가 실패하면 500 delete_failed — 객체는 이미 없으니 GET은 recording_missing, 다시 누르면 2(0건)·3이 다시 돈다.
 * 반대 순서(메타 먼저)면 메타가 사라진 객체가 버킷에 영영 남는다(가리키는 문서 없는 목소리 — §13-7과 같은 이유).
 *
 * 응답은 lib/toeic-attempt-contract `ToeicRecordingDeleteResponse` 단일 정의. 로그에는 응시 id·대상·지운 수·ms만.
 *
 * **문항 단위 다시 풀기(2026-10-03, §15-8)**: 넷째 대상 `{kind:"history"}`(예전 답 하나 — `DELETE …/recordings/[q]/history/[rid]`)와 **지울 계획**
 * (`toeicRecDeletionPlan` — 이력이 없으면 지금처럼 접두사, 그 q에 이력이 있으면 지금 답·고칠 문장은 그 메타의 **객체 키만** — 세대가 같은 접두사를
 * 쓰므로 접두사로 지우면 예전 답 녹음까지 사라진다). 순서(보관소 먼저 → 메타)는 그대로다.
 */

import { getStore } from "./store";
import { isProdGuardError } from "./prod-guard";
import { deleteRecordingObject, deleteRecordingPrefixes } from "./toeic-rec-blob";
import { isToeicRecAttemptId } from "./toeic-rec-rules";
import { toeicHistoryEntryOf, toeicRecDeletionPlan, type ToeicRecDeleteTargetAll } from "./toeic-retake";
import type { ToeicRecordingDeleteResponse } from "./toeic-attempt-contract";

const NOT_FOUND_ATTEMPT = "응시 기록을 찾을 수 없어요.";
const PROD_GUARD_KO = "개발 환경에서는 실제 녹음을 지울 수 없어요(prod-guard).";

function targetLabel(t: ToeicRecDeleteTargetAll): string {
  return t.kind === "attempt" ? "attempt" : t.kind === "answer" ? `q${t.q}` : t.kind === "fix" ? `q${t.q}/fix${t.fixIndex}` : `q${t.q}/history/${t.replacedBy}`;
}

/** 지우기 한 번 — 상태코드와 본문을 돌려준다(던지지 않는다) */
export async function deleteToeicRecordingTarget(
  attemptId: string,
  target: ToeicRecDeleteTargetAll,
): Promise<{ status: number; body: ToeicRecordingDeleteResponse }> {
  const t0 = Date.now();
  const log = (result: string, n = 0) =>
    console.log(`[toeic-rec] DELETE attempt=${attemptId} target=${targetLabel(target)} objects=${n} result=${result} ms=${Date.now() - t0}`);
  if (!isToeicRecAttemptId(attemptId)) return { status: 404, body: { ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT } };

  // ── 1. 응시·문항 ──
  const store = getStore();
  const attempt = await store.getToeicAttempt(attemptId);
  if (!attempt) return { status: 404, body: { ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT } };
  if (target.kind !== "attempt" && !attempt.questions.includes(target.q)) {
    return { status: 404, body: { ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${target.q}가 없어요.` } };
  }
  if (target.kind === "history" && !toeicHistoryEntryOf(attempt.answerHistory, target.q, target.replacedBy)) {
    return { status: 404, body: { ok: false, error: "history_not_found", messageKo: `Q${target.q}의 그 예전 답을 찾을 수 없어요.` } };
  }

  // ── 2. 보관소 먼저(지울 계획 — 접두사 또는 객체 키, §15-8) ──
  let removedObjects = 0;
  try {
    const plan = toeicRecDeletionPlan(attemptId, attempt, target);
    removedObjects = await deleteRecordingPrefixes(plan.prefixes);
    for (const key of plan.keys) if (await deleteRecordingObject(key)) removedObjects += 1;
  } catch (err) {
    if (isProdGuardError(err)) {
      log("prod_guard");
      return { status: 403, body: { ok: false, error: "prod_guard", messageKo: PROD_GUARD_KO } };
    }
    console.error(`[toeic-rec] DELETE attempt=${attemptId} target=${targetLabel(target)} 보관소 지우기 실패:`, err instanceof Error ? err.message : err);
    return { status: 500, body: { ok: false, error: "delete_failed", messageKo: "녹음을 지우지 못했어요. 잠시 뒤 다시 눌러 주세요.", retriable: true } };
  }

  // ── 3. 메타 정리(원자 단위) ──
  try {
    const res = await store.deleteToeicAttemptRecordingMeta(attemptId, target, new Date().toISOString());
    if (!res) return { status: 404, body: { ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT } };
    const removedMeta = res.removedAnswers.length + res.removedFixes.length;
    log(removedMeta > 0 ? "deleted" : "absent", removedObjects);
    return {
      status: 200,
      body: {
        ok: true,
        outcome: removedMeta > 0 ? "deleted" : "absent",
        removedObjects,
        recordings: res.record.recordings,
        fixRecordings: res.record.fixRecordings,
        recordingDeletions: res.record.recordingDeletions,
        answerHistory: res.record.answerHistory,
      },
    };
  } catch (err) {
    if (isProdGuardError(err)) {
      log("prod_guard");
      return { status: 403, body: { ok: false, error: "prod_guard", messageKo: PROD_GUARD_KO } };
    }
    console.error(`[toeic-rec] DELETE attempt=${attemptId} target=${targetLabel(target)} 메타 정리 실패:`, err instanceof Error ? err.message : err);
    return { status: 500, body: { ok: false, error: "delete_failed", messageKo: "녹음 기록을 정리하지 못했어요. 다시 눌러 주세요.", retriable: true } };
  }
}

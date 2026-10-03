/**
 * /api/toeic/attempts/[id]/recordings/[q]/history/[rid] — 다시 풀기로 밀려난 **예전 답의 녹음** (docs/harness/toeic.md §15-8, SPEC §20-13)
 *
 * `rid` = 그 예전 답을 밀어낸 다시 풀기 id(이력 줄의 replacedBy). PIN 게이트 뒤 프록시 — 경로 조각에 점이 없다. AI를 부르지 않는다(키 검사 없음).
 *
 * ── GET ── 응시(404 attempt_not_found) → 이력 줄(404 history_not_found) → 녹음 메타(404 recording_not_found) → 객체(404 recording_missing)
 *   → 200 본문 전체. 헤더는 답변 녹음 GET과 같다(content-type = 메타 mimeType · private, no-store · nosniff · inline). 500 storage_failed.
 *   화면은 fetch → Blob → objectURL로 미리 받는다(`<audio src>`에 이 주소를 넣지 않는다 — iOS 탭 규칙).
 * ── DELETE ── 그 예전 답의 답변 녹음 + 고칠 문장 녹음(객체 키만 — 같은 문항 다른 세대 녹음은 남는다) → 그 줄의 녹음 메타를 비우고
 *   recordingDeletedAt(답·점수·전사·피드백은 남는다). 지우기 한 벌 lib/toeic-rec-delete(보관소 먼저 → 메타). 응답 ToeicRecordingDeleteResponse:
 *   200 { ok:true, outcome, removedObjects, recordings, fixRecordings, recordingDeletions, answerHistory } · 400 invalid_input · 404 attempt_not_found|
 *   question_not_found|history_not_found · 403 prod_guard · 500 delete_failed(retriable)
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import type { ToeicHistoryRecordingGetErrorResponse, ToeicRecordingDeleteResponse } from "@/lib/toeic-attempt-contract";
import { getToeicRecBlobStore } from "@/lib/toeic-rec-blob";
import { deleteToeicRecordingTarget } from "@/lib/toeic-rec-delete";
import { isToeicRecAttemptId, parseToeicRecQuestion } from "@/lib/toeic-rec-rules";
import { isToeicRetakeId, toeicHistoryEntryOf } from "@/lib/toeic-retake";

export const runtime = "nodejs";

function getError(body: ToeicHistoryRecordingGetErrorResponse, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; q: string; rid: string }> }) {
  const { id, q: qRaw, rid } = await params;
  const q = parseToeicRecQuestion(qRaw);
  if (!isToeicRecAttemptId(id)) return getError({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  const attempt = await getStore().getToeicAttempt(id);
  if (!attempt) return getError({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  const row = q === null || !isToeicRetakeId(rid) ? null : toeicHistoryEntryOf(attempt.answerHistory, q, rid);
  if (!row) return getError({ ok: false, error: "history_not_found", messageKo: "그 예전 답을 찾을 수 없어요." }, 404);
  const meta = row.recording;
  if (!meta) return getError({ ok: false, error: "recording_not_found", messageKo: "서버에 보관된 예전 녹음이 없어요." }, 404);

  let bytes: Uint8Array | null;
  try {
    bytes = await getToeicRecBlobStore().get(meta.objectKey);
  } catch (err) {
    console.error(`[toeic-rec] GET history attempt=${id} q=${q} 읽기 실패:`, err instanceof Error ? err.message : err);
    return getError({ ok: false, error: "storage_failed", messageKo: "녹음을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.", retriable: true }, 500);
  }
  if (!bytes) return getError({ ok: false, error: "recording_missing", messageKo: "서버 사본이 없어요." }, 404);

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": meta.mimeType,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; q: string; rid: string }> }) {
  const { id, q: qRaw, rid } = await params;
  const q = parseToeicRecQuestion(qRaw);
  if (q === null || !isToeicRetakeId(rid)) {
    const body: ToeicRecordingDeleteResponse = { ok: false, error: "invalid_input", messageKo: "문항 번호·다시 풀기 id가 올바르지 않아요." };
    return NextResponse.json(body, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const { status, body } = await deleteToeicRecordingTarget(id, { kind: "history", q, replacedBy: rid });
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

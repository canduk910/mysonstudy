/**
 * /api/toeic/attempts/[id]/recordings/[q] — 내 녹음 **서버 보관** 한 문항 올리기·내려받기 (docs/harness/toeic.md §13-4, SPEC §20-11)
 *
 * PIN 게이트(proxy.ts — `/api/*` 401 `locked`) 뒤의 **프록시**다. 서명 URL·공개 URL은 만들지 않는다. 경로 조각에 **점이 없다**
 * (proxy의 정적 확장자 예외를 피한다 — eval이 잠근다). AI를 부르지 않으므로 키 검사가 없다.
 * 보관소는 스토어와 같은 백엔드 판정(lib/toeic-rec-blob — file이면 data/recordings, firestore면 GCS 비공개 버킷).
 *
 * ── PUT (multipart: `audio` 파일 · `durationMs` · `recordedAt` epoch ms 정수 — 필드 이름은 lib/toeic-attempt-contract) ──
 * 검사 순서: 400(형식 — multipart·q·필드·받는 타입·바이트 판정·빈 파일)·413(크기 4MB) → 404(응시·문항) → 판정(decideToeicRecordingUpload)
 *   → **객체 먼저** 쓰기 → 메타 저장(스토어 원자 단위 안에서 같은 판정을 다시 — 동시 두 요청도 메타를 쓰는 쪽이 하나).
 * sha256은 서버가 바이트로 계산한다. 저장 contentType은 바이트로 판정한 계열(선언 타입을 믿지 않는다).
 * **문항 단위 다시 풀기(2026-10-03, docs/harness/toeic.md §15-4)**: 선택 필드 `retakeId`(그 녹음을 만든 다시 풀기 — 없으면 처음 응시의 녹음)로
 * 녹음의 **세대**를 가른다 — 판정 decideToeicAnswerUpload(이력이 없고 세대가 null이면 §13-4 표와 같다): 진행 중 다시 풀기면 대기 자리, 지금 답 세대면
 * 지금 자리(§13-4 표), 예전 세대면 그 이력 줄(녹음이 비었을 때만), 자리가 없으면 저장하지 않고 200 retaken.
 * 응답(단일 정의처 ToeicRecordingPutResponse):
 * - 200 { ok:true, q, outcome:"stored"|"reused"|"superseded", slot:"current"|"staged"|"history", recording }   ← superseded면 recording은 서버의 더 새 녹음 메타
 * - 200 { ok:true, q, outcome:"retaken", slot:null, recording:null }      ← 다시 풀기로 바뀐 문항의 옛 세대 녹음(저장 안 함 — 기기는 done)
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 413 { ok:false, error:"audio_too_large", messageKo }
 * - 404 { ok:false, error:"attempt_not_found"|"question_not_found"|"retake_not_found", messageKo }
 * - 409 { ok:false, error:"recording_locked", messageKo }                  ← 그 문항이 이미 전사됨(채점한 소리와 보관한 소리가 어긋나지 않게)
 * - 409 { ok:false, error:"recording_deleted", messageKo }                 ← 지운 녹음(지운 자리가 이 녹음 시각을 덮는다 — §14-3). 기기 대기열은 사본을 지운다
 * - 500 { ok:false, error:"storage_failed"|"save_failed", messageKo, retriable:true }
 *
 * ── GET ──
 * 응시(404 attempt_not_found) → 그 문항 메타(404 recording_not_found) → 객체(404 recording_missing — 메타는 있는데 객체가 없다) → 200 본문 전체.
 * 헤더: content-type = 메타의 mimeType(바이트 판정), content-length, **cache-control: private, no-store**(Hosting CDN 공유 캐시 금지),
 * x-content-type-options: nosniff, content-disposition: inline. Range는 받지 않는다(늘 200 전체 — 4MB 이하).
 * 화면은 이 주소를 `<audio src>`에 넣지 않고 fetch → Blob → objectURL로 미리 받는다(iOS 탭 규칙).
 * - 500 { ok:false, error:"storage_failed", messageKo, retriable:true }
 *
 * ── DELETE (2026-10-03, docs/harness/toeic.md §14-4) ── 이 문항의 **답변 녹음**만 지운다(고칠 문장 녹음·점수·전사·피드백은 남는다).
 * 서버 보관소 먼저(그 문항 접두사 — 대체된 옛 객체까지) → 메타 정리 + 지운 자리(lib/toeic-rec-delete 한 벌). 응답 ToeicRecordingDeleteResponse:
 * - 200 { ok:true, outcome:"deleted"|"absent", removedObjects, recordings, fixRecordings, recordingDeletions }
 * - 400 invalid_input(q 모양) · 404 attempt_not_found|question_not_found · 403 prod_guard · 500 delete_failed(retriable)
 *
 * 로그에는 응시 id·q·바이트 수·결과·ms만 남긴다(바이트·파일 이름은 남기지 않는다).
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import {
  TOEIC_REC_FIELD_AUDIO,
  TOEIC_REC_FIELD_DURATION_MS,
  TOEIC_REC_FIELD_RECORDED_AT,
  TOEIC_REC_FIELD_RETAKE_ID,
  type ToeicRecordingDeleteResponse,
  type ToeicRecordingGetErrorResponse,
  type ToeicRecordingPutResponse,
} from "@/lib/toeic-attempt-contract";
import { getToeicRecBlobStore } from "@/lib/toeic-rec-blob";
import { deleteToeicRecordingTarget } from "@/lib/toeic-rec-delete";
import {
  checkToeicRecordingUpload,
  isToeicRecAttemptId,
  parseToeicRecQuestion,
  toeicRecObjectKey,
  toeicStoredRecordingOf,
  type ToeicStoredRecording,
} from "@/lib/toeic-rec-rules";
import { decideToeicAnswerUpload, isToeicRetakeId, toeicAnswerUploadSlotMeta } from "@/lib/toeic-retake";

export const runtime = "nodejs";

function json(body: ToeicRecordingPutResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function getError(body: ToeicRecordingGetErrorResponse, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const NOT_FOUND_ATTEMPT = "응시 기록을 찾을 수 없어요.";
const DELETED_KO = "이 녹음은 지운 녹음이라 다시 올리지 않았어요.";
const RETAKE_NOT_FOUND_KO = "이 녹음의 다시 풀기 기록을 찾을 수 없어요.";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; q: string }> }) {
  const t0 = Date.now();
  const { id, q: qRaw } = await params;
  const log = (q: number | string, bytes: number, result: string) =>
    console.log(`[toeic-rec] PUT attempt=${id} q=${q} bytes=${bytes} result=${result} ms=${Date.now() - t0}`);

  // ── 1. 형식(400)·크기(413) ──
  if (!isToeicRecAttemptId(id)) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "녹음 업로드 형식(multipart)이 올바르지 않아요." }, 400);
  }
  const audio = form.get(TOEIC_REC_FIELD_AUDIO);
  if (!(audio instanceof Blob)) return json({ ok: false, error: "invalid_input", messageKo: "녹음 파일(audio)이 없어요." }, 400);
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const checked = checkToeicRecordingUpload({
    q: qRaw,
    durationMs: form.get(TOEIC_REC_FIELD_DURATION_MS),
    recordedAt: form.get(TOEIC_REC_FIELD_RECORDED_AT),
    declaredType: audio.type,
    fileName: typeof (audio as File).name === "string" ? (audio as File).name : "",
    size: bytes.byteLength,
    head: bytes.subarray(0, 16),
  });
  if (!checked.ok) {
    log(qRaw, bytes.byteLength, checked.error);
    return json({ ok: false, error: checked.error, messageKo: checked.messageKo }, checked.status);
  }
  const { q, durationMs, recordedAtMs, mimeType } = checked;
  // 녹음의 세대(§15-4) — 없으면(옛 대기열·처음 응시) null
  const rawRetake = form.get(TOEIC_REC_FIELD_RETAKE_ID);
  const gen = typeof rawRetake === "string" && rawRetake.trim() !== "" ? rawRetake.trim() : null;
  if (gen !== null && !isToeicRetakeId(gen)) return json({ ok: false, error: "invalid_input", messageKo: "다시 풀기 id(retakeId)가 올바르지 않아요." }, 400);

  // ── 2. 응시·문항(404) ──
  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  if (!attempt.questions.includes(q)) {
    return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
  }

  // ── 3. 판정(쓰기 전) — 쓸 필요 없는 reused·superseded·locked·retaken이면 객체를 쓰지 않는다 ──
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const decided = decideToeicAnswerUpload(attempt, q, gen, { sha256, recordedAtMs });
  if (decided.kind === "question_not_found") return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
  if (decided.kind === "retake_not_found") return json({ ok: false, error: "retake_not_found", messageKo: RETAKE_NOT_FOUND_KO }, 404);
  if (decided.kind === "locked") {
    log(q, bytes.byteLength, "locked");
    return json({ ok: false, error: "recording_locked", messageKo: "이 문항은 이미 채점된 녹음이 있어 바꾸지 않았어요." }, 409);
  }
  if (decided.kind === "deleted") {
    log(q, bytes.byteLength, "deleted");
    return json({ ok: false, error: "recording_deleted", messageKo: DELETED_KO }, 409);
  }
  if (decided.kind === "retaken") {
    log(q, bytes.byteLength, "retaken");
    return json({ ok: true, q, outcome: "retaken", slot: null, recording: null });
  }
  if (decided.kind === "reused" || decided.kind === "superseded") {
    log(q, bytes.byteLength, decided.kind);
    return json({ ok: true, q, outcome: decided.kind, slot: decided.slot, recording: decided.existing });
  }

  // ── 4. 객체 먼저 ──
  const objectKey = toeicRecObjectKey(id, q, recordedAtMs);
  try {
    await getToeicRecBlobStore().put(objectKey, bytes, mimeType);
  } catch (err) {
    console.error(`[toeic-rec] PUT attempt=${id} q=${q} 객체 쓰기 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "storage_failed", messageKo: "녹음을 서버에 보관하지 못했어요. 잠시 뒤 다시 올려요.", retriable: true }, 500);
  }

  // ── 5. 메타(원자 단위 안에서 다시 판정) ──
  const recording: ToeicStoredRecording = {
    q,
    objectKey,
    mimeType,
    size: bytes.byteLength,
    sha256,
    durationMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
    uploadedAt: new Date().toISOString(),
  };
  try {
    const res = await store.setToeicAttemptRecording(id, recording, gen);
    if (!res) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
    if (res.outcome === "question_not_found") return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
    if (res.outcome === "retake_not_found") return json({ ok: false, error: "retake_not_found", messageKo: RETAKE_NOT_FOUND_KO }, 404);
    if (res.outcome === "retaken") {
      // 쓰기 전 판정과 메타 저장 사이에 그 다시 풀기가 닫혔거나 문항이 바뀌었다 — 방금 쓴 객체는 가리키는 메타가 없다(알려진 틈 §14-9와 같은 부류)
      log(q, bytes.byteLength, "retaken");
      return json({ ok: true, q, outcome: "retaken", slot: null, recording: null });
    }
    if (res.outcome === "locked") {
      log(q, bytes.byteLength, "locked");
      return json({ ok: false, error: "recording_locked", messageKo: "이 문항은 이미 채점된 녹음이 있어 바꾸지 않았어요." }, 409);
    }
    if (res.outcome === "deleted") {
      // 쓰기 전 판정과 메타 저장 사이에 지워졌다 — 방금 쓴 객체는 가리키는 메타가 없다(알려진 틈 §14-9 — 다음 지우기·모의고사 삭제가 접두사째 지운다)
      log(q, bytes.byteLength, "deleted");
      return json({ ok: false, error: "recording_deleted", messageKo: DELETED_KO }, 409);
    }
    const slot = res.slot ?? "current";
    const saved = toeicAnswerUploadSlotMeta(res.record, q, gen, slot, sha256);
    if (!saved) throw new Error("저장 뒤 메타가 없어요");
    log(q, bytes.byteLength, `${res.outcome}/${slot}`);
    return json({ ok: true, q, outcome: res.outcome, slot, recording: saved });
  } catch (err) {
    console.error(`[toeic-rec] PUT attempt=${id} q=${q} 메타 저장 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "녹음 기록을 저장하지 못했어요. 잠시 뒤 다시 올려요.", retriable: true }, 500);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; q: string }> }) {
  const { id, q: qRaw } = await params;
  const q = parseToeicRecQuestion(qRaw);
  if (!isToeicRecAttemptId(id)) return getError({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  const attempt = await getStore().getToeicAttempt(id);
  if (!attempt) return getError({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  const meta = q === null ? null : toeicStoredRecordingOf(attempt, q);
  if (!meta) return getError({ ok: false, error: "recording_not_found", messageKo: "서버에 보관된 녹음이 없어요." }, 404);

  let bytes: Uint8Array | null;
  try {
    bytes = await getToeicRecBlobStore().get(meta.objectKey);
  } catch (err) {
    console.error(`[toeic-rec] GET attempt=${id} q=${q} 읽기 실패:`, err instanceof Error ? err.message : err);
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

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; q: string }> }) {
  const { id, q: qRaw } = await params;
  const q = parseToeicRecQuestion(qRaw);
  if (q === null) {
    const body: ToeicRecordingDeleteResponse = { ok: false, error: "invalid_input", messageKo: "문항 번호는 1~11이어야 해요." };
    return NextResponse.json(body, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const { status, body } = await deleteToeicRecordingTarget(id, { kind: "answer", q });
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * /api/toeic/attempts/[id]/recordings/[q]/fixes/[i] — **고칠 문장 다시 녹음** 하나 올리기·내려받기·지우기
 * (docs/harness/toeic.md §14-5, SPEC §20-12)
 *
 * 결과 화면 피드백의 "고칠 문장"(feedback.fixes[i]: said → better)을 아빠가 다시 말한 녹음. **AI를 부르지 않는다**(받아쓰기 비교 없음 —
 * 키 검사도 없다). 답변 녹음 라우트(`…/recordings/[q]`)와 같은 규칙: PIN 게이트 뒤 프록시 · 경로 조각에 점 없음 · 바이트 형식 판정 ·
 * 4MB 상한(TOEIC_SCORE_AUDIO_MAX_BYTES) · sha256 서버 계산 · 객체 먼저 → 메타(원자 단위 안에서 같은 판정을 다시).
 * 다른 점(§14-5):
 * - **잠그지 않는다** — 채점과 무관한 연습이라 몇 번이고 다시 말하면 최신 하나로 바뀐다(decideToeicFixRecordingUpload).
 * - **바꿔 낀 옛 객체는 메타 커밋 뒤에 지운다**(best-effort — 실패하면 로그만, 다음 지우기·모의고사 삭제가 접두사째 지운다). 메타보다 먼저
 *   지우면 메타 저장이 실패했을 때 지금 녹음을 잃는다. 연습은 자주 다시 하므로 옛 객체를 남기면 쌓인다(답변 녹음과 다른 선택).
 * - 판정에서 자리를 얻지 못한 방금 쓴 객체(동시 업로드 경합·지운 자리)는 지금 메타가 가리키는 것이 아니면 지운다(best-effort).
 * - 메타의 `better`는 서버가 응시 기록의 피드백에서 옮긴다(클라이언트 값을 받지 않는다).
 * - 길이 상한 TOEIC_FIX_REC_MAX_MS(화면 자동 멈춤 TOEIC_FIX_REC_LIMIT_MS + 여유).
 *
 * ── PUT (multipart: `audio` · `durationMs` · `recordedAt` — 필드 이름은 TOEIC_REC_FIELD_*) ── 응답 ToeicFixRecordingPutResponse:
 * - 200 { ok:true, q, fixIndex, outcome:"stored"|"reused"|"superseded", recording }
 * - 400 invalid_input · 413 audio_too_large · 404 attempt_not_found|question_not_found|fix_not_found
 * - 409 recording_deleted(지운 자리가 이 녹음 시각을 덮는다) · 500 storage_failed|save_failed(retriable)
 * - 409 answer_changed(2026-10-03 §15-6 — multipart `answerSource`(화면이 본 답의 세대, 처음 응시 = 빈 문자열)가 지금 세대와 다르다: 그 문항을
 *   다시 풀어 피드백이 바뀌었다. 예전 피드백 자리의 녹음을 새 피드백의 같은 번호에 붙이지 않는다. 필드가 없으면(옛 화면) 검사하지 않는다)
 * ── GET ── 200 바이트(content-type = 메타 mimeType, private, no-store, nosniff, inline) · 404 attempt_not_found|recording_not_found|recording_missing · 500 storage_failed
 * ── DELETE ── 서버 보관소 먼저(그 자리 접두사) → 메타 정리 + 지운 자리(lib/toeic-rec-delete). 응답 ToeicRecordingDeleteResponse
 *
 * 로그에는 응시 id·q·i·바이트 수·결과·ms만 남긴다(바이트·파일 이름은 남기지 않는다).
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import {
  TOEIC_REC_FIELD_AUDIO,
  TOEIC_REC_FIELD_DURATION_MS,
  TOEIC_REC_FIELD_RECORDED_AT,
  TOEIC_REC_FIELD_ANSWER_SOURCE,
  type ToeicFixRecordingPutResponse,
  type ToeicRecordingDeleteResponse,
  type ToeicRecordingGetErrorResponse,
} from "@/lib/toeic-attempt-contract";
import { deleteRecordingObject, getToeicRecBlobStore } from "@/lib/toeic-rec-blob";
import { deleteToeicRecordingTarget } from "@/lib/toeic-rec-delete";
import {
  checkToeicFixRecordingUpload,
  decideToeicFixRecordingUpload,
  isToeicRecAttemptId,
  parseToeicFixRecIndex,
  parseToeicRecQuestion,
  toeicFixBetterOf,
  toeicFixRecObjectKey,
  toeicStoredFixRecordingOf,
  type ToeicStoredFixRecording,
} from "@/lib/toeic-rec-rules";
import { isToeicRetakeId, toeicAnswerSourceOf } from "@/lib/toeic-retake";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; q: string; i: string }> };

function json(body: ToeicFixRecordingPutResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function getError(body: ToeicRecordingGetErrorResponse, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const NOT_FOUND_ATTEMPT = "응시 기록을 찾을 수 없어요.";
const FIX_NOT_FOUND = "이 문항에는 그 고칠 문장이 없어요.";
const DELETED_KO = "지운 녹음이라 다시 올리지 않았어요.";
const CHANGED_KO = "이 문항을 다시 풀어 피드백이 바뀌었어요 — 화면을 새로 고친 뒤 다시 말해 주세요.";

/** 지울 수 있으면 지운다 — 실패해도 응답을 바꾸지 않는다(고아 객체는 다음 지우기·모의고사 삭제가 접두사째 지운다) */
async function dropObject(key: string, why: string, tag: string): Promise<void> {
  try {
    await deleteRecordingObject(key);
  } catch (err) {
    console.warn(`[toeic-rec] ${tag} 옛 객체 지우기 실패(${why}):`, err instanceof Error ? err.message : err);
  }
}

export async function PUT(req: Request, { params }: Params) {
  const t0 = Date.now();
  const { id, q: qRaw, i: iRaw } = await params;
  const tag = `PUT fix attempt=${id} q=${qRaw} i=${iRaw}`;
  const log = (bytes: number, result: string) => console.log(`[toeic-rec] ${tag} bytes=${bytes} result=${result} ms=${Date.now() - t0}`);

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
  const checked = checkToeicFixRecordingUpload({
    q: qRaw,
    fixIndex: iRaw,
    durationMs: form.get(TOEIC_REC_FIELD_DURATION_MS),
    recordedAt: form.get(TOEIC_REC_FIELD_RECORDED_AT),
    declaredType: audio.type,
    fileName: typeof (audio as File).name === "string" ? (audio as File).name : "",
    size: bytes.byteLength,
    head: bytes.subarray(0, 16),
  });
  if (!checked.ok) {
    log(bytes.byteLength, checked.error);
    return json({ ok: false, error: checked.error, messageKo: checked.messageKo }, checked.status);
  }
  const { q, fixIndex, durationMs, recordedAtMs, mimeType } = checked;
  // 화면이 본 답의 세대(§15-6) — 없으면(옛 화면) undefined: 검사하지 않는다. 빈 문자열 = 처음 응시(null)
  const rawSource = form.get(TOEIC_REC_FIELD_ANSWER_SOURCE);
  const expectSource: string | null | undefined = typeof rawSource === "string" ? (rawSource.trim() === "" ? null : rawSource.trim()) : undefined;
  if (typeof expectSource === "string" && !isToeicRetakeId(expectSource)) {
    return json({ ok: false, error: "invalid_input", messageKo: "답 세대(answerSource)가 올바르지 않아요." }, 400);
  }

  // ── 2. 응시·문항·고칠 문장(404) + 판정(쓰기 전) ──
  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectSource !== undefined && toeicAnswerSourceOf(attempt, q) !== expectSource) {
    log(bytes.byteLength, "answer_changed");
    return json({ ok: false, error: "answer_changed", messageKo: CHANGED_KO }, 409);
  }
  const decided = decideToeicFixRecordingUpload(attempt, q, fixIndex, { sha256, recordedAtMs });
  if (decided === "question_not_found") return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
  if (decided === "fix_not_found") return json({ ok: false, error: "fix_not_found", messageKo: FIX_NOT_FOUND }, 404);
  if (decided === "deleted") {
    log(bytes.byteLength, "deleted");
    return json({ ok: false, error: "recording_deleted", messageKo: DELETED_KO }, 409);
  }
  if (decided === "reused" || decided === "superseded") {
    const cur = toeicStoredFixRecordingOf(attempt, q, fixIndex);
    if (cur) {
      log(bytes.byteLength, decided);
      return json({ ok: true, q, fixIndex, outcome: decided, recording: cur });
    }
  }
  const better = toeicFixBetterOf(attempt, q, fixIndex);
  if (better === null) return json({ ok: false, error: "fix_not_found", messageKo: FIX_NOT_FOUND }, 404);

  // ── 3. 객체 먼저 ──
  const objectKey = toeicFixRecObjectKey(id, q, fixIndex, recordedAtMs);
  try {
    await getToeicRecBlobStore().put(objectKey, bytes, mimeType);
  } catch (err) {
    console.error(`[toeic-rec] ${tag} 객체 쓰기 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "storage_failed", messageKo: "녹음을 서버에 보관하지 못했어요. 다시 올려 주세요.", retriable: true }, 500);
  }

  // ── 4. 메타(원자 단위 안에서 다시 판정) → 커밋 뒤 옛 객체 지우기 ──
  const recording: ToeicStoredFixRecording = {
    q,
    fixIndex,
    better,
    objectKey,
    mimeType,
    size: bytes.byteLength,
    sha256,
    durationMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
    uploadedAt: new Date().toISOString(),
  };
  try {
    const res = await store.setToeicAttemptFixRecording(id, recording, expectSource);
    if (!res) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
    if (res.outcome === "stored") {
      if (res.replaced && res.replaced.objectKey !== objectKey) await dropObject(res.replaced.objectKey, "다시 녹음으로 바뀜", tag);
      log(bytes.byteLength, "stored");
      return json({ ok: true, q, fixIndex, outcome: "stored", recording: toeicStoredFixRecordingOf(res.record, q, fixIndex) ?? recording });
    }
    // 자리를 얻지 못했다 — 방금 쓴 객체가 지금 메타가 가리키는 것이 아니면 지운다(가리키는 메타 없는 객체를 남기지 않게)
    const cur = toeicStoredFixRecordingOf(res.record, q, fixIndex);
    if (!cur || cur.objectKey !== objectKey) await dropObject(objectKey, res.outcome, tag);
    log(bytes.byteLength, res.outcome);
    if (res.outcome === "question_not_found") return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
    if (res.outcome === "fix_not_found") return json({ ok: false, error: "fix_not_found", messageKo: FIX_NOT_FOUND }, 404);
    if (res.outcome === "deleted") return json({ ok: false, error: "recording_deleted", messageKo: DELETED_KO }, 409);
    if (res.outcome === "answer_changed") return json({ ok: false, error: "answer_changed", messageKo: CHANGED_KO }, 409);
    if (!cur) throw new Error("판정 뒤 메타가 없어요");
    return json({ ok: true, q, fixIndex, outcome: res.outcome, recording: cur });
  } catch (err) {
    console.error(`[toeic-rec] ${tag} 메타 저장 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "녹음 기록을 저장하지 못했어요. 다시 올려 주세요.", retriable: true }, 500);
  }
}

export async function GET(_req: Request, { params }: Params) {
  const { id, q: qRaw, i: iRaw } = await params;
  const q = parseToeicRecQuestion(qRaw);
  const fixIndex = parseToeicFixRecIndex(iRaw);
  if (!isToeicRecAttemptId(id)) return getError({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  const attempt = await getStore().getToeicAttempt(id);
  if (!attempt) return getError({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
  const meta = q === null || fixIndex === null ? null : toeicStoredFixRecordingOf(attempt, q, fixIndex);
  if (!meta) return getError({ ok: false, error: "recording_not_found", messageKo: "서버에 보관된 녹음이 없어요." }, 404);

  let bytes: Uint8Array | null;
  try {
    bytes = await getToeicRecBlobStore().get(meta.objectKey);
  } catch (err) {
    console.error(`[toeic-rec] GET fix attempt=${id} q=${q} i=${fixIndex} 읽기 실패:`, err instanceof Error ? err.message : err);
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

export async function DELETE(_req: Request, { params }: Params) {
  const { id, q: qRaw, i: iRaw } = await params;
  const q = parseToeicRecQuestion(qRaw);
  const fixIndex = parseToeicFixRecIndex(iRaw);
  if (q === null || fixIndex === null) {
    const body: ToeicRecordingDeleteResponse = { ok: false, error: "invalid_input", messageKo: "문항·고칠 문장 번호가 올바르지 않아요." };
    return NextResponse.json(body, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const { status, body } = await deleteToeicRecordingTarget(id, { kind: "fix", q, fixIndex });
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

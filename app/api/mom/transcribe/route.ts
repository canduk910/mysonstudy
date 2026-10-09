/**
 * POST /api/mom/transcribe — 엄마의 생활영어 말하기 녹음 → 글자(설계 §6).
 *
 * `app/api/toeic/guides/templates/transcribe/route.ts`를 그대로 본떴다. 녹음을 글자로만 바꾸고 **저장하지 않는다**.
 * 본문은 multipart `audio` 하나 — 기대 문장·틀은 받지 않는다(받아쓰기 무유도: 전사가 기대 문장 쪽으로 끌려가면 판정이 뜻을 잃는다).
 * 관문 T `transcribeAnswer`에는 문장을 넘길 인자가 아예 없다. 판정(`judgeMomSpeech`)은 화면이 돌려받은 `text`로 한다.
 *
 * 검사 순서: 1. 키(501 — 본문을 읽기 전에) 2. content-length(413 — 본문을 읽기 전에) 3. multipart·audio·형식·빈 파일(400)
 * 4. 파일 크기(413) 5. 전사 → 200 { ok:true, text } / 끊김 499 / 실패 500 { error:"transcribe_failed", retriable:true }.
 * 스토어를 import하지 않는다. 로그는 바이트 수만(전사문·오디오 없음).
 */

import { NextResponse } from "next/server";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName, toeicAudioTypeFromName } from "@/lib/toeic-attempt-contract";
import { hasToeicTranscribeApiKey, transcribeAnswer } from "@/lib/toeic-transcribe";

export const runtime = "nodejs";

/** 녹음 상한 1 MiB(20초 16kHz mono WAV ≈ 640KB) */
const MOM_AUDIO_MAX_BYTES = 1024 * 1024;
/** multipart 머리·경계 여유 */
const MOM_AUDIO_MULTIPART_SLACK_BYTES = 16 * 1024;

type MomTranscribeResponse =
  | { ok: true; text: string }
  | { ok: false; error: "invalid_input" | "audio_too_large" | "no_api_key" | "client_closed"; messageKo: string }
  | { ok: false; error: "transcribe_failed"; messageKo: string; retriable: true };

function json(body: MomTranscribeResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}

function tooLarge() {
  return json({ ok: false, error: "audio_too_large", messageKo: "녹음이 너무 길어요. 조금 짧게 다시 말해 주세요." }, 413);
}

function noKey() {
  return json({ ok: false, error: "no_api_key", messageKo: "받아쓰기를 아직 쓸 수 없어요. 스스로 판정해 주세요." }, 501);
}

export async function POST(req: Request) {
  // ── 1. 키 — 본문을 읽기 전에 ──
  if (!hasToeicTranscribeApiKey()) return noKey();

  // ── 2. 선언된 길이 — 본문을 읽기 전에 ──
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MOM_AUDIO_MAX_BYTES + MOM_AUDIO_MULTIPART_SLACK_BYTES) {
    console.warn(`[/api/mom/transcribe] 선언 길이 초과 bytes=${declared}`);
    return tooLarge();
  }

  // ── 3. 형식 ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("녹음 업로드 형식(multipart)이 올바르지 않아요.");
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const uploadedName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  // 타입 없는 Blob은 `application/octet-stream`으로 오므로 빈 타입으로 보고 파일 이름에서 채운다
  const declaredType = toeicAudioBaseType(audio.type);
  const type = declaredType && declaredType !== "application/octet-stream" ? declaredType : toeicAudioTypeFromName(uploadedName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");

  // ── 4. 크기 ──
  if (audio.size > MOM_AUDIO_MAX_BYTES) {
    console.warn(`[/api/mom/transcribe] 파일 크기 초과 bytes=${audio.size}`);
    return tooLarge();
  }

  // ── 5. 관문 T — 기대 문장 없이, 끊기면 상류도 멈춘다 ──
  const fileName = toeicAudioFileName(type)!;
  const r = await transcribeAnswer({ bytes: await audio.arrayBuffer(), fileName, type }, req.signal);
  if (!r.ok) {
    if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    if (r.error === "no_api_key") return noKey();
    return json({ ok: false, error: "transcribe_failed", messageKo: "받아쓰기를 하지 못했어요. 다시 말하거나 스스로 판정해 주세요.", retriable: true }, 500);
  }
  return json({ ok: true, text: r.text });
}

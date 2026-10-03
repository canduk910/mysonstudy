/**
 * POST /api/phrase-helper/transcribe — 표현 도우미 마이크 모드: 녹음 → 한국어 글자 (SPEC §22-2, docs/harness/phrase-helper.md §13)
 *
 * 녹음을 글자로만 바꾼다. **저장하지 않는다**(녹음·전사문 모두 — 요청 메모리에서 쓰고 버린다). 화면은 돌려받은 글을 입력 칸에
 * **채워 넣기만** 한다(자동 전송 없음 — 사람이 고친 뒤 보낸다). 본문은 multipart `audio` 하나다(토익 틀 테스트 전사 라우트와 같은 모양).
 *
 * ── 검사 순서 ─────────────────────────────────────────────────────────────
 * 1. 키(501) — **본문을 읽기 전에**.
 * 2. `content-length`가 PHRASE_HELPER_AUDIO_MAX_BYTES + multipart 여유를 넘으면 본문을 읽지 않고 413.
 *    본문은 스트림으로 읽으며 **누적 바이트**를 센다 — content-length가 없는(chunked) 요청도 상한을 넘는 순간 읽기를 끊고 413
 *    (readBodyCapped, QA P3-E). 다 읽은 바이트로 multipart를 해석한다.
 * 3. 400 — multipart 아님 · `audio` 없음 · 받지 않는 형식 · 빈 파일. 타입이 비었거나 `application/octet-stream`이면 파일 이름의 확장자로
 *    (토익 업로드와 같은 도우미 — lib/toeic-attempt-contract의 형식 표를 그대로 쓴다: wav·mp4·m4a·webm).
 * 4. 413 — 파일 크기 상한(1.25 MiB — 30초 16kHz mono WAV ≈ 0.96 MB).
 * 5. 관문 K `transcribeKorean({bytes, fileName, type}, req.signal)` — language "ko", prompt 없음, 20초 상한, 재시도 0.
 *
 * 응답 shape(단일 정의처 lib/phrase-helper-contract.ts PhraseHelperTranscribeResponse):
 * - 200 { ok:true, text }
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 413 { ok:false, error:"audio_too_large", messageKo }
 * - 499 { ok:false, error:"client_closed", messageKo }
 * - 500 { ok:false, error:"transcribe_failed", messageKo, retriable:true }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 */

import { NextResponse } from "next/server";
import {
  PHRASE_HELPER_AUDIO_FIELD,
  PHRASE_HELPER_AUDIO_MAX_BYTES,
  PHRASE_HELPER_AUDIO_MULTIPART_SLACK_BYTES,
  type PhraseHelperTranscribeResponse,
} from "@/lib/phrase-helper-contract";
import { hasPhraseHelperTranscribeApiKey, transcribeKorean } from "@/lib/phrase-helper-transcribe";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName, toeicAudioTypeFromName } from "@/lib/toeic-attempt-contract";

export const runtime = "nodejs";

function json(body: PhraseHelperTranscribeResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}

function tooLarge() {
  return json({ ok: false, error: "audio_too_large", messageKo: "녹음이 너무 길어요. 30초 안으로 말해 주세요." }, 413);
}

/** 본문을 상한까지만 읽는다 — 넘으면 읽기를 끊고 null(chunked 요청도 메모리에 다 쌓지 않는다) */
async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const NO_KEY_KO = "OpenAI API 키가 아직 설정되지 않아 말로 넣기를 쓸 수 없어요. 글자로 넣어 주세요.";

export async function POST(req: Request) {
  // ── 1. 키 — 본문을 읽기 전에 ──
  if (!hasPhraseHelperTranscribeApiKey()) return json({ ok: false, error: "no_api_key", messageKo: NO_KEY_KO }, 501);

  // ── 2. 선언된 길이 ──
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PHRASE_HELPER_AUDIO_MAX_BYTES + PHRASE_HELPER_AUDIO_MULTIPART_SLACK_BYTES) {
    console.warn(`[/api/phrase-helper/transcribe] 선언 길이 초과 bytes=${declared}`);
    return tooLarge();
  }

  // ── 3. 형식 ──
  let body: Uint8Array | null;
  try {
    body = await readBodyCapped(req, PHRASE_HELPER_AUDIO_MAX_BYTES + PHRASE_HELPER_AUDIO_MULTIPART_SLACK_BYTES);
  } catch {
    return bad("녹음을 받지 못했어요.");
  }
  if (body === null) {
    console.warn("[/api/phrase-helper/transcribe] 읽는 중 상한 초과");
    return tooLarge();
  }
  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return bad("녹음 업로드 형식(multipart)이 올바르지 않아요.");
  }
  const audio = form.get(PHRASE_HELPER_AUDIO_FIELD);
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const uploadedName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  const declaredType = toeicAudioBaseType(audio.type);
  const type = declaredType && declaredType !== "application/octet-stream" ? declaredType : toeicAudioTypeFromName(uploadedName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");

  // ── 4. 크기 ──
  if (audio.size > PHRASE_HELPER_AUDIO_MAX_BYTES) {
    console.warn(`[/api/phrase-helper/transcribe] 파일 크기 초과 bytes=${audio.size}`);
    return tooLarge();
  }

  // ── 5. 관문 K — 한국어, prompt 없음, 끊기면 상류도 멈춘다 ──
  const fileName = toeicAudioFileName(type)!.replace(/^[^.]*/, "speech");
  const r = await transcribeKorean({ bytes: await audio.arrayBuffer(), fileName, type }, req.signal);
  if (!r.ok) {
    if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    if (r.error === "no_api_key") return json({ ok: false, error: "no_api_key", messageKo: NO_KEY_KO }, 501);
    return json({ ok: false, error: "transcribe_failed", messageKo: "말을 글자로 바꾸지 못했어요. 다시 말해 주세요.", retriable: true }, 500);
  }
  return json({ ok: true, text: r.text });
}

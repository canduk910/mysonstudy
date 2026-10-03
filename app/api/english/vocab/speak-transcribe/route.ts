/**
 * POST /api/english/vocab/speak-transcribe — 은우 "그림 보고 말하기": 녹음 → 영어 글자 (2026-10-03, SPEC §15-5, docs/harness/english.md §14)
 *
 * 녹음을 글자로만 바꾼다. **저장하지 않는다**(녹음·전사문 모두 — 요청 메모리에서 쓰고 버린다). **정답을 받지 않는다** — 판정은 화면의
 * 순수 함수(lib/kid-speak.ts `judgeKidSpeech`)가 하고, 라우트가 정답을 모르니 전사에 넘길 수도 없다(무유도). 본문은 multipart `audio` 하나다
 * (표현 도우미 전사 라우트와 같은 모양).
 *
 * ── 검사 순서 ─────────────────────────────────────────────────────────────
 * 1. 키(501) — **본문을 읽기 전에**.
 * 2. `content-length`가 KID_SPEAK_AUDIO_MAX_BYTES + multipart 여유를 넘으면 본문을 읽지 않고 413. 본문은 스트림으로 읽으며 누적 바이트를 센다
 *    (content-length가 없는 chunked 요청도 상한을 넘는 순간 끊고 413).
 * 3. 400 — multipart 아님 · `audio` 없음 · 받지 않는 형식 · 빈 파일. 타입이 비었거나 `application/octet-stream`이면 파일 이름의 확장자로
 *    (토익 업로드와 같은 형식 표 — lib/toeic-attempt-contract: wav·mp4·m4a·webm).
 * 4. 413 — 파일 크기 상한(256 KiB — 6초 16kHz mono WAV ≈ 192 KB).
 * 5. 관문 W `transcribeKidWord({bytes, fileName, type}, req.signal)` — language "en", prompt 없음, 12초 상한, 재시도 0.
 *
 * 응답 shape(단일 정의처 lib/kid-speak-contract.ts KidSpeakTranscribeResponse):
 * - 200 { ok:true, text }
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 413 { ok:false, error:"audio_too_large", messageKo }
 * - 499 { ok:false, error:"client_closed", messageKo }
 * - 500 { ok:false, error:"transcribe_failed", messageKo, retriable:true }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 */

import { NextResponse } from "next/server";
import {
  KID_SPEAK_AUDIO_FIELD,
  KID_SPEAK_AUDIO_MAX_BYTES,
  KID_SPEAK_AUDIO_MULTIPART_SLACK_BYTES,
  type KidSpeakTranscribeResponse,
} from "@/lib/kid-speak-contract";
import { hasKidSpeakTranscribeApiKey, transcribeKidWord } from "@/lib/kid-speak-transcribe";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName, toeicAudioTypeFromName } from "@/lib/toeic-attempt-contract";

export const runtime = "nodejs";

function json(body: KidSpeakTranscribeResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}

function tooLarge() {
  return json({ ok: false, error: "audio_too_large", messageKo: "녹음이 너무 길어요. 단어 하나만 짧게 말해 주세요." }, 413);
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

const NO_KEY_KO = "OpenAI API 키가 아직 설정되지 않아 말하기 채점을 쓸 수 없어요. 스스로 확인으로 해요.";

export async function POST(req: Request) {
  // ── 1. 키 — 본문을 읽기 전에 ──
  if (!hasKidSpeakTranscribeApiKey()) return json({ ok: false, error: "no_api_key", messageKo: NO_KEY_KO }, 501);

  // ── 2. 선언된 길이 ──
  const cap = KID_SPEAK_AUDIO_MAX_BYTES + KID_SPEAK_AUDIO_MULTIPART_SLACK_BYTES;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    console.warn(`[/api/english/vocab/speak-transcribe] 선언 길이 초과 bytes=${declared}`);
    return tooLarge();
  }

  // ── 3. 형식 ──
  let body: Uint8Array | null;
  try {
    body = await readBodyCapped(req, cap);
  } catch {
    return bad("녹음을 받지 못했어요.");
  }
  if (body === null) {
    console.warn("[/api/english/vocab/speak-transcribe] 읽는 중 상한 초과");
    return tooLarge();
  }
  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return bad("녹음 업로드 형식(multipart)이 올바르지 않아요.");
  }
  const audio = form.get(KID_SPEAK_AUDIO_FIELD);
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const uploadedName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  const declaredType = toeicAudioBaseType(audio.type);
  const type = declaredType && declaredType !== "application/octet-stream" ? declaredType : toeicAudioTypeFromName(uploadedName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");

  // ── 4. 크기 ──
  if (audio.size > KID_SPEAK_AUDIO_MAX_BYTES) {
    console.warn(`[/api/english/vocab/speak-transcribe] 파일 크기 초과 bytes=${audio.size}`);
    return tooLarge();
  }

  // ── 5. 관문 W — 영어, prompt 없음, 끊기면 상류도 멈춘다 ──
  const fileName = toeicAudioFileName(type)!.replace(/^[^.]*/, "word");
  const r = await transcribeKidWord({ bytes: await audio.arrayBuffer(), fileName, type }, req.signal);
  if (!r.ok) {
    if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    if (r.error === "no_api_key") return json({ ok: false, error: "no_api_key", messageKo: NO_KEY_KO }, 501);
    return json({ ok: false, error: "transcribe_failed", messageKo: "잘 못 들었어요. 한 번 더 말해 볼까요?", retriable: true }, 500);
  }
  return json({ ok: true, text: r.text });
}

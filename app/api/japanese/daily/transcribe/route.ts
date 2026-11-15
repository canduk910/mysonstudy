/**
 * POST /api/japanese/daily/transcribe — 🎤 핵심 문장 체크 녹음 → 일본어 글자(설계 §4 회화·§8). **저장하지 않는다.**
 *
 * 관문 T-ja `transcribeJaSpeakingAnswer`(lib/ja-speaking-transcribe.ts — `language:"ja"` 고정)를 **그대로** 부른다. 새 관문을 두지 않는다.
 * 본문은 multipart `audio` 하나 — **기대 문장은 받지 않는다**(받아쓰기 무유도: 전사가 기대 문장 쪽으로 끌려가면 판정이 뜻을 잃는다.
 * 관문 함수에도 그 인자가 없다). 판정(`judgeJaDailyLine` — alignJaReadAloud)은 화면이 돌려받은 `text`로 한다.
 *
 * 검사 순서(엄마 /api/mom/transcribe와 같다): 1. 키(501 — 본문을 읽기 전에) 2. content-length(413 — 본문을 읽기 전에)
 * 3. 실제 본문 바이트(413 — 읽으면서 센다) · multipart·audio·형식·빈 파일(400) 4. 파일 크기 1 MiB(413) 5. 전사 → 200 { ok:true, text } / 끊김 499 / 실패 500 { retriable:true }.
 * 스토어를 import하지 않는다. 로그는 바이트 수만(전사문·오디오 없음 — 관문이 모델·바이트·글자 수만 찍는다).
 * 응답 shape 정의처: lib/ja-daily-contract.ts `JaDailyTranscribeResponse`.
 */
import { NextResponse } from "next/server";
import type { JaDailyTranscribeResponse } from "@/lib/ja-daily-contract";
import { hasJaSpeakingTranscribeApiKey, transcribeJaSpeakingAnswer } from "@/lib/ja-speaking-transcribe";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName, toeicAudioTypeFromName } from "@/lib/toeic-attempt-contract";

export const runtime = "nodejs";

/** 녹음 상한 1 MiB(문장 하나 — 20초 16kHz mono WAV ≈ 640KB) */
const JA_DAILY_AUDIO_MAX_BYTES = 1024 * 1024;
/** multipart 머리·경계 여유 */
const JA_DAILY_AUDIO_MULTIPART_SLACK_BYTES = 16 * 1024;

function json(body: JaDailyTranscribeResponse, status = 200) {
  return NextResponse.json(body, { status });
}
const bad = (messageKo: string) => json({ ok: false, error: "invalid_input", messageKo }, 400);
const tooLarge = () => json({ ok: false, error: "audio_too_large", messageKo: "녹음이 너무 길어요. 조금 짧게 다시 말해 주세요." }, 413);
const noKey = () => json({ ok: false, error: "no_api_key", messageKo: "받아쓰기를 아직 쓸 수 없어요. 스스로 판정해 주세요." }, 501);

/** 본문을 max 바이트까지만 읽는다 — 넘으면 "too_large"(스트림 취소), 읽기 실패면 null */
async function readCappedBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | "too_large" | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function POST(req: Request) {
  // ── 1. 키 — 본문을 읽기 전에 ──
  if (!hasJaSpeakingTranscribeApiKey()) return noKey();

  // ── 2. 선언된 길이 — 본문을 읽기 전에 ──
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > JA_DAILY_AUDIO_MAX_BYTES + JA_DAILY_AUDIO_MULTIPART_SLACK_BYTES) {
    console.warn(`[/api/japanese/daily/transcribe] 선언 길이 초과 bytes=${declared}`);
    return tooLarge();
  }

  // ── 3. 형식 ──
  // 머리(content-length)가 없거나 틀려도 실제로 읽은 바이트로 상한을 건다(QA daily1 P3-b) — 넘으면 읽기를 멈추고 413
  const body = await readCappedBody(req, JA_DAILY_AUDIO_MAX_BYTES + JA_DAILY_AUDIO_MULTIPART_SLACK_BYTES);
  if (body === "too_large") {
    console.warn("[/api/japanese/daily/transcribe] 실제 본문 초과");
    return tooLarge();
  }
  if (body === null) return bad("녹음 업로드를 읽지 못했어요.");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
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
  if (audio.size > JA_DAILY_AUDIO_MAX_BYTES) {
    console.warn(`[/api/japanese/daily/transcribe] 파일 크기 초과 bytes=${audio.size}`);
    return tooLarge();
  }

  // ── 5. 관문 T-ja — 기대 문장 없이, 끊기면 상류도 멈춘다 ──
  const fileName = toeicAudioFileName(type)!;
  const r = await transcribeJaSpeakingAnswer({ bytes: await audio.arrayBuffer(), fileName, type }, req.signal);
  if (!r.ok) {
    if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    if (r.error === "no_api_key") return noKey();
    return json({ ok: false, error: "transcribe_failed", messageKo: "받아쓰기를 하지 못했어요. 다시 말하거나 스스로 판정해 주세요.", retriable: true }, 500);
  }
  return json({ ok: true, text: r.text });
}

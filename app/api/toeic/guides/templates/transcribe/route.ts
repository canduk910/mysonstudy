/**
 * POST /api/toeic/guides/templates/transcribe — 템플릿 테스트 녹음 → 글자 (docs/harness/toeic.md §12-5-4, SPEC §20-10)
 *
 * 녹음을 글자로만 바꾼다. **저장하지 않는다**(전사문·녹음 모두 — 남는 것은 화면이 저장하는 ○/✕ 기록뿐이다).
 * 본문은 multipart `audio` 하나다. 정답·틀·표현은 받지 않는다 — 서버는 무엇을 말해야 했는지 모른다. 기대 문장을 전사 `prompt`로
 * 넣지 않는 원칙(§5-0 2 — 전사가 기대 문장 쪽으로 끌려가면 비교가 뜻을 잃는다)을 구조로 지킨다(관문 T `transcribeAnswer`에는 prompt
 * 인자가 아예 없다). 비교(`compareTemplateAnswer`)는 화면이 돌려받은 `text`로 한다.
 *
 * ── 검사 순서(검토 개선 8) ──────────────────────────────────────────────────────
 * 1. 키(501) — **본문을 읽기 전에**. 키가 없으면 화면은 그 세션을 자기 판정으로 돌린다.
 * 2. `content-length`가 1 MiB + multipart 여유 16 KiB를 넘으면 본문을 읽지 않고 413.
 * 3. 400 — multipart 아님 · `audio` 없음 · 받지 않는 형식(isAcceptedToeicAudioType) · 빈 파일.
 * 4. 413 — 파일 크기 1 MiB(TOEIC_TEMPLATE_AUDIO_MAX_BYTES — 20초 16kHz mono WAV가 약 640KB).
 * 5. 관문 T `transcribeAnswer({bytes, fileName, type}, req.signal)` — 모델·language "en"·30초 상한·재시도 1회 그대로.
 *    파일 이름은 형식에 맞는 확장자(toeicAudioFileName), 타입이 비었으면(타입 없는 Blob의 `application/octet-stream` 포함) 파일 이름에서
 *    (toeicAudioTypeFromName) — 채점 업로드와 같은 도우미.
 *
 * 비용 가드: 이 라우트에는 세션 상태가 없다(가족 전용 PIN 게이트가 바깥 울타리 — §12-12 18). 상한(한 번에 하나·문항당 2·세션당 20·
 * 0.6초 미만 안 보냄·화면 45초 타임아웃)은 화면이 `canTranscribeAgain` 하나로 지킨다. 화면이 끊으면 `req.signal`로 상류 전사도 멈춘다(499).
 * 스토어를 import하지 않는다(eval이 소스로 본다). 로그는 바이트·ms·낱말 수만(전사문·오디오 없음 — transcribeAnswer의 규칙).
 *
 * 응답 shape (단일 정의처 `lib/toeic-guide-contract.ts` ToeicTemplateTranscribeResponse):
 * - 200 { ok:true, text, words }            ← words = countWords(text). 0이면 화면이 "잘 안 들렸어요"(유효하지 않은 시도)
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 413 { ok:false, error:"audio_too_large", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 499 { ok:false, error:"client_closed", messageKo }
 * - 500 { ok:false, error:"transcribe_failed", messageKo, retriable:true }
 */

import { NextResponse } from "next/server";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName, toeicAudioTypeFromName } from "@/lib/toeic-attempt-contract";
import {
  TOEIC_TEMPLATE_AUDIO_MAX_BYTES,
  TOEIC_TEMPLATE_AUDIO_MULTIPART_SLACK_BYTES,
  TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO,
  type ToeicTemplateTranscribeResponse,
} from "@/lib/toeic-guide-contract";
import { countWords } from "@/lib/toeic-text";
import { hasToeicTranscribeApiKey, transcribeAnswer } from "@/lib/toeic-transcribe";

export const runtime = "nodejs";

function json(body: ToeicTemplateTranscribeResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}

function tooLarge() {
  return json(
    { ok: false, error: "audio_too_large", messageKo: `녹음 파일이 너무 커요(최대 ${Math.round(TOEIC_TEMPLATE_AUDIO_MAX_BYTES / 1024 / 1024)}MB).` },
    413,
  );
}

export async function POST(req: Request) {
  // ── 1. 키 — 본문을 읽기 전에(키가 없으면 업로드를 받아 봐야 쓸 곳이 없다) ──
  if (!hasToeicTranscribeApiKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 받아쓰기를 할 수 없어요. 스스로 판정해 주세요." }, 501);
  }

  // ── 2. 선언된 길이 — 본문을 읽기 전에 한 번(검토 개선 8) ──
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TOEIC_TEMPLATE_AUDIO_MAX_BYTES + TOEIC_TEMPLATE_AUDIO_MULTIPART_SLACK_BYTES) {
    console.warn(`[/api/toeic/guides/templates/transcribe] 선언 길이 초과 bytes=${declared}`);
    return tooLarge();
  }

  // ── 3. 형식 ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("녹음 업로드 형식(multipart)이 올바르지 않아요.");
  }
  const audio = form.get(TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO);
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const uploadedName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  // 타입이 비었으면 파일 이름의 확장자로 채운다. 브라우저·undici는 타입 없는 Blob을 `application/octet-stream`으로 보내므로 그것도 빈 타입으로 본다
  const declaredType = toeicAudioBaseType(audio.type);
  const type = declaredType && declaredType !== "application/octet-stream" ? declaredType : toeicAudioTypeFromName(uploadedName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");

  // ── 4. 크기 ──
  if (audio.size > TOEIC_TEMPLATE_AUDIO_MAX_BYTES) {
    console.warn(`[/api/toeic/guides/templates/transcribe] 파일 크기 초과 bytes=${audio.size}`);
    return tooLarge();
  }

  // ── 5. 관문 T — 기대 문장 없이(prompt 인자가 없다), 끊기면 상류도 멈춘다 ──
  const fileName = toeicAudioFileName(type)!;
  const r = await transcribeAnswer({ bytes: await audio.arrayBuffer(), fileName, type }, req.signal);
  if (!r.ok) {
    if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    if (r.error === "no_api_key") {
      return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 받아쓰기를 할 수 없어요. 스스로 판정해 주세요." }, 501);
    }
    return json({ ok: false, error: "transcribe_failed", messageKo: "받아쓰기를 하지 못했어요. 다시 말하거나 스스로 판정해 주세요.", retriable: true }, 500);
  }
  return json({ ok: true, text: r.text, words: countWords(r.text) });
}

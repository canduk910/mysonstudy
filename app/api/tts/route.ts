/**
 * POST /api/tts — 클라우드 TTS 합성 (SPEC §16). 기존 PIN 게이트(proxy.ts)로 자동 보호된다.
 *
 * 요청 `{ text, lang, speed }` → mp3 오디오 바이트(200). 클라이언트(lib/speech.ts)가 받아 재생하고,
 * 아래 어떤 경우든 실패로 오면 **조용히 기기 음성으로 폴백**한다(§16-2, 에러 화면 없음):
 *   - 501 no_api_key   : `OPENAI_API_KEY` 미설정(로컬 데모)
 *   - 400 invalid_input: 본문 형식·언어 화이트리스트·길이 상한·속도 범위 위반
 *   - 500 tts_failed   : 네트워크·API 실패
 *
 * lib/ai/client.ts(Structured Outputs)와 섞지 않는다 — 합성은 lib/tts.ts의 독립 클라이언트가 한다.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesizeSpeech } from "@/lib/tts";
import { TTS_LANGS, TTS_SPEED_MAX, TTS_SPEED_MIN, TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";

export const runtime = "nodejs";

const bodySchema = z.object({
  text: z.string().trim().min(1, "읽을 내용이 없어요").max(TTS_TEXT_MAX_CHARS),
  lang: z.enum(TTS_LANGS),
  speed: z.number().min(TTS_SPEED_MIN).max(TTS_SPEED_MAX),
});

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request) {
  // 키 없으면 501(폴백 신호) — 합성 시도조차 하지 않는다.
  if (!process.env.OPENAI_API_KEY) return fail("no_api_key", 501);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_input", 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_input", 400);

  try {
    const { audio, contentType } = await synthesizeSpeech(parsed.data);
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(audio.length),
        // 같은 문장은 클라이언트가 메모리로도 캐시하지만, 브라우저 HTTP 캐시도 하루 둔다(비공개 콘텐츠).
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    console.error("[/api/tts] 합성 실패:", err);
    return fail("tts_failed", 500);
  }
}

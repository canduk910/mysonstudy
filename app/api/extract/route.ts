/**
 * POST /api/extract — 표지 판독 (SPEC §3-(1)·§7-1, M2)
 *
 * 이미지 1~3장(표지 / 정보 스티커 / 뒤표지, base64 data URL)을 받아 lib/ai의
 * extractBook()으로 판독한다. 상한이 3장인 이유(SPEC §4-1): 세 면은 서로 대체 불가한
 * 정보를 담는다 — 표지=제목·저자, 스티커=AR·Lexile·단어 수, 뒤표지=소개글(blurbText).
 * 2장이면 사용자가 스티커를 포기해야만 뒤표지를 찍을 수 있어 blurbText 판독이 사실상 죽는다
 * (HARNESS §2의 프롬프트·스키마·callWithSchema를 그대로 사용 — 재구현 금지).
 *
 * 개인정보 최소화(SPEC §5): 업로드된 사진은 이 요청의 메모리에서만 쓰고
 * 어디에도 저장·로깅하지 않는다. 판독 실패는 예외가 아니라 정상 흐름 —
 * 200 + 명시적 retake 신호로 처리하고, 500은 재시도 소진(throw)에만 쓴다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, extraction: BookExtraction }
 * - 200 { ok: false, reason: "retake", messageKo, extraction: BookExtraction }
 *       ← isBookCover=false 또는 title=null (SPEC §9 "다시 찍어주세요" + 수동 폼 폴백.
 *          부분 판독값은 수동 폼 프리필용으로 함께 내려준다)
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { extractBook } from "@/lib/ai/client";
import { COVER_MAX_IMAGES, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/upload-limits";

export const runtime = "nodejs";

const bodySchema = z.object({
  images: z
    .array(
      z
        .string()
        .regex(/^data:image\/[a-z0-9.+-]+;base64,/i, "이미지 data URL 형식이어야 해요")
        // 한 장의 길이 상한도 lib/upload-limits가 단일 정의처다 — 수학 판독
        // (`/api/math/extract`)이 같은 숫자를 쓴다. 한쪽만 고치면 같은 사진이
        // 한 라우트에서만 거절되는 일이 생긴다.
        .max(MAX_IMAGE_DATA_URL_CHARS, "사진이 너무 커요 — 다시 시도해 주세요"),
    )
    .min(1, "사진을 1장 이상 보내 주세요")
    // SPEC §4-1 · HARNESS §2-2 — 표지 / 정보 스티커 / 뒤표지.
    // 숫자를 여기 적지 않는다: UI(home-create)와 상한이 어긋나면 뒤표지가 잘려
    // blurbText 판독이 조용히 죽는다 (QA F10) → lib/upload-limits.ts가 단일 정의처
    .max(COVER_MAX_IMAGES, `사진은 최대 ${COVER_MAX_IMAGES}장까지예요 (표지 · 정보 스티커 · 뒤표지)`),
});

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (/api/card와 동일 정책)
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요. (시드 데모 카드는 키 없이도 볼 수 있어요)",
      },
      { status: 501 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "사진 데이터를 확인해 주세요.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    // 사진은 여기서 판독에만 쓰고 저장하지 않는다 (SPEC §5 개인정보 최소화)
    const extraction = await extractBook(parsed.data.images);

    // 판독 실패 = 정상 흐름 (HARNESS §2-4): 안내 + 수동 입력 폼 폴백 신호
    if (!extraction.isBookCover || extraction.title === null) {
      return NextResponse.json({
        ok: false,
        reason: "retake",
        messageKo:
          "사진에서 책 표지를 잘 읽지 못했어요. 표지가 잘 보이게 다시 찍어 주시거나, 아래에 직접 입력해 주세요.",
        extraction,
      });
    }

    return NextResponse.json({ ok: true, extraction });
  } catch (err) {
    // callWithSchema 재시도 소진(throw)에만 500 (SPEC §9 — 재시도 안내)
    console.error("[/api/extract] 표지 판독 실패:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "ai_failed",
        messageKo: "표지를 읽다가 문제가 생겼어요. 잠시 후 '재시도'를 눌러 주세요.",
        retriable: true,
      },
      { status: 500 },
    );
  }
}

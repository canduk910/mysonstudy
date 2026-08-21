/**
 * POST /api/math/extract — 문제집 사진 판독 (docs/harness/math.md §2, 호출 A · M3)
 *
 * 사진 **1장**(base64 data URL)을 받아 `callWorksheetExtract()`로 판독한다. 프롬프트·스키마·
 * 재요청·로깅은 전부 `lib/ai/math/extract.ts`와 `lib/ai/client.ts` 소관이다 — 이 라우트는
 * **입력을 검사해 넘기고 결과를 그대로 내려주는 일만** 한다(재구현·우회 금지).
 *
 * 사진은 이 요청의 메모리에서만 쓰고 **어디에도 저장·로깅하지 않는다.** 버킷도 서명 URL도
 * 새 환경 변수도 없다 — 영어 `/api/extract`가 이미 같은 일을 그렇게 한다(§11-2가 옛 전제를 걷어냈다).
 *
 * ── 판독 실패는 정상 흐름이다 ──────────────────────────────────────────────
 * `isWorksheet=false`나 빈 `problems`는 모델이 §2-1 6번 지시대로 답한 결과이지 오류가 아니다.
 * 200 + `{ ok: false, reason: "retake" }`로 내려 화면이 "다시 찍어주세요" + 직접 입력 폴백을
 * 띄우게 한다(§2-4). 500은 재요청까지 소진한 throw에만 쓴다 — 두 경우를 같은 코드로 내리면
 * "사진이 문제집이 아님"과 "AI가 죽음"이 화면에서 구분되지 않는다.
 *
 * ── 비용: 여기서 설명을 만들지 않는다 (§8) ────────────────────────────────
 * 이 라우트는 **판독만** 한다. 판독된 문제로 설명을 만드는 것은 사용자가 확인 화면에서 고른
 * 문제에 한해 `/api/math/explain`이 한 건씩 처리한다. 문제 1개 = 호출 2~4회이고 교재 한 페이지가
 * 12문제라, **페이지 전체를 자동으로 설명까지 만드는 경로를 여기에도 어디에도 만들지 않는다.**
 *
 * 응답 shape (단일 정의처는 `lib/math-extract-contract.ts`):
 * - 200 { ok: true, extraction }
 * - 200 { ok: false, reason: "retake", messageKo, extraction }   ← **오류 아님**
 * - 400 { ok: false, error: "invalid_input", messageKo, issues }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * (401 locked / 503 not_configured는 proxy.ts가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { callWorksheetExtract } from "@/lib/ai/math/extract";
import { MATH_IMAGE_DATA_URL_PATTERN } from "@/lib/ai/math/prompts";
import { MAX_IMAGE_DATA_URL_CHARS } from "@/lib/upload-limits";

export const runtime = "nodejs";

/**
 * 이미지 **1장**만 받는다 (§2-2). 길이 상한은 `lib/upload-limits.ts`가 단일 정의처다 —
 * 여기에 숫자를 직접 적으면 영어 라우트·UI와 어긋나고, 어긋난 상한은 조용히 실패한다.
 *
 * [M6 §12] 형식 정규식도 같은 이유로 `MATH_IMAGE_DATA_URL_PATTERN`을 가져다 쓴다.
 * **여기서 통과한 사진이 그대로 `/api/math/explain`으로 다시 간다**(§12-3 — 판독에 쓴 사진
 * 그대로). 두 라우트가 같은 리터럴을 각자 적고 있으면 한쪽만 손봤을 때 "판독은 됐는데
 * 설명은 거절되는" 사진이 생긴다. 정규식·상한 모두 한 곳만 본다.
 */
const bodySchema = z.object({
  image: z
    .string()
    .regex(MATH_IMAGE_DATA_URL_PATTERN, "이미지 data URL 형식이어야 해요")
    .max(MAX_IMAGE_DATA_URL_CHARS, "사진이 너무 커요 — 다시 시도해 주세요"),
});

function invalidInput(messageKo: string, issues: { path: string; message: string }[]) {
  return NextResponse.json(
    { ok: false, error: "invalid_input", messageKo, issues },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (영어 `/api/extract`와 같은 정책).
  // 호출 A는 vision이라 이미지 토큰이 붙는다 — 키가 빈 로컬에서 실호출이 나가지 않는 것이
  // 이 순서의 요점이다.
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      { status: 501 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidInput("요청 본문이 올바른 JSON이 아니에요.", []);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidInput(
      "사진 데이터를 확인해 주세요.",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  try {
    // 사진은 여기서 판독에만 쓰고 저장하지 않는다
    const extraction = await callWorksheetExtract(parsed.data.image);

    // §2-4 폴백 — 문제집이 아니거나 한 문제도 못 읽었다. 오류가 아니라 정상 갈래다.
    if (!extraction.isWorksheet || extraction.problems.length === 0) {
      return NextResponse.json({
        ok: false,
        reason: "retake",
        messageKo:
          "사진에서 문제를 읽지 못했어요. 문제집 페이지가 화면에 꽉 차게, 그림자 없이 다시 찍어 주시거나 문제를 직접 적어 주세요.",
        extraction,
      });
    }

    return NextResponse.json({ ok: true, extraction });
  } catch (err) {
    // 여기까지 오는 것은 재요청 1회까지 쓰고도 스키마를 못 맞춘 경우다.
    console.error("[/api/math/extract] 문제집 판독 실패:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "ai_failed",
        messageKo: "사진을 읽다가 문제가 생겼어요. 잠시 후 '다시 읽기'를 눌러 주세요.",
        retriable: true,
      },
      { status: 500 },
    );
  }
}

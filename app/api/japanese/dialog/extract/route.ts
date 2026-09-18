/**
 * POST /api/japanese/dialog/extract — 듀오링고 대화 전사 (호출 B, vision · docs/harness/japanese.md §3)
 *
 * 스크린샷 N장(base64 data URL, 화면이 미리 리사이즈)을 받아 planJaDialogBatches로 나눠 **병렬** 판독하고
 * mergeJaDialogBatches로 경계 겹침을 접는다. **저장하지 않는다** — 병합 전사를 검토 화면에 돌려준다(사진 원본도 안 남긴다, SPEC §1).
 * 부분 실패 격리: 한 배치가 실패해도 나머지 전사는 살리고 partial=true, **전 배치 실패만 500**. 키 없으면 501.
 *
 * 상한은 공유 정의처 재사용(lib/upload-limits.ts: 형식·길이). 장수 상한은 이 라우트 정책(듀오링고 세션 여러 장).
 *
 * 응답 shape (단일 정의처 `lib/japanese-dialog-contract.ts`):
 * - 200 { ok:true, focusKo, turns, partial, mergedCount, allUnknown, model }
 * - 400 invalid_input / 501 no_api_key / 500 extract_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { extractJaDialog, resolveModel } from "@/lib/ai/client";
import { planJaDialogBatches, mergeJaDialogBatches } from "@/lib/ai/japanese/dialog";
import type { JaDialogExtraction } from "@/lib/ai/japanese/schemas";
import type { JaDialogExtractResponse } from "@/lib/japanese-dialog-contract";
import { IMAGE_DATA_URL_PATTERN, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/upload-limits";

export const runtime = "nodejs";

// 한 세션의 스크린샷 상한(듀오링고 대화는 5장 안팎, 넉넉히). 형식·길이는 공유 상수.
const MAX_DIALOG_IMAGES = 20;
const MAX_TOTAL_CHARS = 40_000_000;

const bodySchema = z.object({
  images: z
    .array(
      z
        .string()
        .regex(IMAGE_DATA_URL_PATTERN, "이미지 형식이 올바르지 않아요")
        .max(MAX_IMAGE_DATA_URL_CHARS, "사진 한 장이 너무 커요 — 다시 시도해 주세요"),
    )
    .min(1, "사진이 없어요")
    .max(MAX_DIALOG_IMAGES, `사진은 한 번에 최대 ${MAX_DIALOG_IMAGES}장까지예요`)
    .superRefine((images, ctx) => {
      const total = images.reduce((sum, img) => sum + img.length, 0);
      if (total > MAX_TOTAL_CHARS) {
        ctx.addIssue({ code: "custom", message: "사진 전체 크기가 너무 커요 — 장수를 줄여 주세요" });
      }
    }),
});

function json(body: JaDialogExtractResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "사진을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  const images = parsed.data.images;

  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "대화를 읽으려면 OpenAI API 키가 필요해요." }, 501);
  }

  // 배치별 병렬 판독(부분 실패 격리).
  const batches = planJaDialogBatches(images.length);
  const settled = await Promise.allSettled(
    batches.map((group) => extractJaDialog({ images: group.map((i) => images[i]) })),
  );

  const okBatches: JaDialogExtraction[] = [];
  let anyFailed = false;
  settled.forEach((res) => {
    if (res.status === "fulfilled") okBatches.push(res.value);
    else {
      anyFailed = true;
      console.error("[/api/japanese/dialog/extract] 배치 실패(격리):", res.reason);
    }
  });

  if (okBatches.length === 0) {
    return json({ ok: false, error: "extract_failed", messageKo: "대화를 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  const merged = mergeJaDialogBatches(okBatches);
  return json({
    ok: true,
    focusKo: merged.focusKo,
    turns: merged.turns,
    // 배치 하나라도 실패했으면 전사가 불완전 — partial로 정직하게 알린다.
    partial: merged.partial || anyFailed,
    mergedCount: merged.mergedCount,
    allUnknown: merged.allUnknown,
    model: resolveModel(),
  });
}

/**
 * POST /api/toeic/sets/extract — 표현집 페이지 판독 (docs/harness/toeic.md §2, 호출 A)
 *
 * 사진 **여러 장**(base64 data URL)을 받아 **사진마다 호출 1회**로 병렬 판독하고(`Promise.allSettled` — 요청 하나가 60초를
 * 넘지 않게, §1-1), `mergeToeicExtractions`(§2-4 후처리 1~5)로 DAY별 **초안**을 만든다. **저장하지 않는다** — 사용자가
 * 검토 화면에서 고친 뒤 `POST /api/toeic/sets`가 저장한다(§8). 프롬프트·스키마·재요청·로깅은 lib/ai/toeic/calls.ts와
 * lib/ai/client.ts의 callWithSchema 소관이다 — 여기는 입력을 검사해 넘기고 결과를 묶어 내려줄 뿐이다.
 *
 * 사진은 이 요청의 메모리에서만 쓰고 저장·로깅하지 않는다(SPEC §1·§5). 로그에 판독 내용(교재 원문)도 남기지 않는다.
 *
 * ── 판독 실패는 정상 흐름이다 ──────────────────────────────────────────────────
 * 표현을 하나도 못 읽었으면(전부 비표현 페이지·빈 판독) 200 `{ok:false, reason:"retake"}`. **모든 사진이 throw(재요청까지
 * 소진)한 경우에만** 500이다 — 한 장이라도 성공하면 그 결과를 살린다(실패한 장 수는 failedPhotoCount로 사실대로).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-set-contract.ts` ToeicExtractResponse):
 * - 200 { ok:true, drafts, photoCount, failedPhotoCount, notExpressionPhotoCount, pages, model }
 * - 200 { ok:false, reason:"retake", messageKo }                         ← 오류 아님
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }       ← 전 사진 실패
 * - 501 { ok:false, error:"no_api_key", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveModel } from "@/lib/ai/client";
import { extractToeicPage } from "@/lib/ai/toeic/calls";
import { mergeToeicExtractions, type ToeicPhotoExtraction } from "@/lib/ai/toeic/extract-merge";
import { TOEIC_EXTRACT_MAX_PHOTOS } from "@/lib/ai/toeic/schemas";
import type { ToeicExtractPhotoOutcome, ToeicExtractRequest, ToeicExtractResponse } from "@/lib/toeic-set-contract";
import { IMAGE_DATA_URL_PATTERN, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/upload-limits";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

/** 한 장의 형식·길이 상한은 lib/upload-limits.ts, 장수 상한은 TOEIC_EXTRACT_MAX_PHOTOS(§2-0 "최대 8장")가 단일 정의처 */
const bodySchema = z.object({
  images: z
    .array(
      z
        .string()
        .regex(IMAGE_DATA_URL_PATTERN, "이미지 data URL 형식이어야 해요")
        .max(MAX_IMAGE_DATA_URL_CHARS, "사진이 너무 커요 — 다시 시도해 주세요"),
    )
    .min(1, "사진을 1장 이상 보내 주세요")
    .max(TOEIC_EXTRACT_MAX_PHOTOS, `사진은 한 번에 최대 ${TOEIC_EXTRACT_MAX_PHOTOS}장까지예요`),
});

// 요청 계약 ↔ zod 양방향 묶기 — 화면은 계약 타입으로 보내고 라우트는 zod로 받는다(한쪽만 바꾸면 tsc가 잡는다)
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicExtractRequest, BodyInput] extends [BodyInput, ToeicExtractRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicExtractResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않는다 — 키를 비운 로컬에서 vision 실호출이 구조적으로 불가능해진다.
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      501,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "사진 데이터를 확인해 주세요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }
  const images = parsed.data.images;

  // 사진 1장 = 호출 1회(§2-0). 한 장이 실패해도 그 장만 잃고 나머지는 살린다.
  const settled = await Promise.allSettled(images.map((dataUrl) => extractToeicPage(dataUrl)));

  const pagesForMerge: ToeicPhotoExtraction[] = [];
  const pages: ToeicExtractPhotoOutcome[] = [];
  settled.forEach((result, photoIndex) => {
    if (result.status === "fulfilled") {
      const x = result.value;
      pagesForMerge.push({ photoIndex, extraction: x });
      pages.push({
        photoIndex,
        ok: true,
        isExpressionPage: x.isExpressionPage,
        entryCount: x.entries.length,
        quizCount: x.quiz.length,
      });
    } else {
      // 재요청 1회까지 쓰고도 스키마를 못 맞춘 경우. 메시지(검증 오류 경로)만 남기고 판독 내용은 남기지 않는다.
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[/api/toeic/sets/extract] 사진 ${photoIndex} 판독 실패:`, message.slice(0, 300));
      pages.push({ photoIndex, ok: false, isExpressionPage: false, entryCount: 0, quizCount: 0 });
    }
  });

  const failedPhotoCount = pages.filter((p) => !p.ok).length;
  if (failedPhotoCount === images.length) {
    return json(
      {
        ok: false,
        error: "ai_failed",
        messageKo: "사진을 읽다가 문제가 생겼어요. 잠시 후 '다시 읽기'를 눌러 주세요.",
        retriable: true,
      },
      500,
    );
  }

  const merged = mergeToeicExtractions(pagesForMerge);
  // 표현이 하나도 없는 초안(QUIZ만 찍힌 사진)은 저장할 수 없다(§7-1 entries 1개 이상) — 그것만 남으면 다시 찍기.
  if (!merged.drafts.some((d) => d.entries.length > 0)) {
    return json({
      ok: false,
      reason: "retake",
      messageKo:
        "사진에서 표현을 읽지 못했어요. 표현 암기장 페이지가 화면에 꽉 차게, 그림자 없이 다시 찍어 주세요.",
    });
  }

  return json({
    ok: true,
    drafts: merged.drafts,
    photoCount: images.length,
    failedPhotoCount,
    notExpressionPhotoCount: merged.notExpressionPhotoIndexes.length,
    pages,
    model: resolveModel(),
  });
}

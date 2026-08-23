/**
 * POST /api/english/vocab/extract — 단어장 페이지 판독 (docs/harness/english.md §7, 호출 C · V1)
 *
 * 사진 **여러 장**(base64 data URL 배열)을 받아 **각 장을 병렬로** 판독하고(호출 A′ 관용구,
 * `Promise.allSettled`), 결과를 `mergeVocabPages`로 번호 병합해 DAY 하나로 만든다. 프롬프트·
 * 스키마·재요청·로깅은 전부 `lib/ai/english/vocabbook-*`와 `lib/ai/client.ts` 소관이다 —
 * 이 라우트는 **입력을 검사해 넘기고 결과를 병합해 내려주는 일만** 한다(재구현·우회 금지).
 *
 * 사진은 이 요청의 메모리에서만 쓰고 **어디에도 저장·로깅하지 않는다**(§7-6 · SPEC §5).
 *
 * ── 판독 실패는 정상 흐름이다 (§7-6) ──────────────────────────────────────────
 * 모든 사진이 단어장이 아니거나 한 단어도 못 읽으면(병합 결과 0개) 200 + `{ ok:false,
 * reason:"retake" }`로 내려 화면이 "다시 찍어주세요"를 띄우게 한다(표지 `isBookCover=false`·
 * 수학 `isWorksheet=false`와 같은 갈래). **모든 사진이 throw(재요청까지 소진)한 경우에만** 500이다 —
 * 한 장이라도 성공하면 그 결과를 살려 병합한다(부분 실패는 `failedPhotoCount`로 알린다).
 *
 * 응답 shape (단일 정의처는 `lib/vocab-extract-contract.ts`):
 * - 200 { ok:true, entries, dayLabel, mergedCount, missingNos, photoCount, failedPhotoCount, pages }
 * - 200 { ok:false, reason:"retake", messageKo }                       ← **오류 아님**
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }     ← 전 사진 실패
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { callWithSchema, imagePart, textPart } from "@/lib/ai/client";
import {
  VOCAB_EXTRACT_CALL_OPTIONS,
  VOCAB_EXTRACT_SYSTEM_PROMPT,
  VOCAB_EXTRACT_USER_TEXT,
} from "@/lib/ai/english/vocabbook-prompts";
import {
  VOCAB_EXTRACTION_JSON_SCHEMA,
  vocabExtractionSchema,
} from "@/lib/ai/english/vocabbook-schemas";
import {
  mergeVocabPages,
  type VocabPageForMerge,
} from "@/lib/ai/english/vocabbook-merge";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import type {
  VocabExtractResponse,
  VocabPageOutcome,
} from "@/lib/vocab-extract-contract";
import { IMAGE_DATA_URL_PATTERN, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/upload-limits";

export const runtime = "nodejs";

/**
 * 이미지 **여러 장**을 받는다 (§7-2 · §7-5). 한 장의 형식·길이 상한은 `lib/upload-limits.ts`가,
 * 장수 상한은 `VOCAB_LIMITS.photos`가 단일 정의처다 — 여기에 숫자를 직접 적으면 UI와 어긋난다.
 */
const bodySchema = z.object({
  images: z
    .array(
      z
        .string()
        .regex(IMAGE_DATA_URL_PATTERN, "이미지 data URL 형식이어야 해요")
        .max(MAX_IMAGE_DATA_URL_CHARS, "사진이 너무 커요 — 다시 시도해 주세요"),
    )
    .min(1, "사진을 1장 이상 보내 주세요")
    .max(VOCAB_LIMITS.photos, `사진은 한 번에 최대 ${VOCAB_LIMITS.photos}장까지예요`),
});

function json(body: VocabExtractResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (영어 `/api/extract`와 같은 정책).
  // 호출 C는 vision이라 이미지 토큰이 붙는다 — 키가 빈 로컬에서 실호출이 나가지 않는 것이 요점.
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      501,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] },
      400,
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "사진 데이터를 확인해 주세요.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const images = parsed.data.images;

  // 사진 1장 = 판독 1회. **각 장을 병렬로** 따로 호출한다(§7-5, 호출 A′ 관용구).
  // 한 장이 실패해도 그 장의 단어만 잃고 나머지는 살린다.
  const settled = await Promise.allSettled(
    images.map((dataUrl) =>
      callWithSchema({
        call: VOCAB_EXTRACT_CALL_OPTIONS.call, // "vocab-extract"
        system: VOCAB_EXTRACT_SYSTEM_PROMPT,
        user: [imagePart(dataUrl), textPart(VOCAB_EXTRACT_USER_TEXT)], // 이미지 먼저, 텍스트 나중
        jsonSchema: VOCAB_EXTRACTION_JSON_SCHEMA,
        zodSchema: vocabExtractionSchema,
        temperature: VOCAB_EXTRACT_CALL_OPTIONS.temperature, // 0
        maxOutputTokens: VOCAB_EXTRACT_CALL_OPTIONS.maxOutputTokens,
      }),
    ),
  );

  const pagesForMerge: VocabPageForMerge[] = [];
  const pages: VocabPageOutcome[] = [];
  let dayLabel: string | null = null;

  settled.forEach((result, photoIndex) => {
    if (result.status === "fulfilled") {
      const extraction = result.value;
      pagesForMerge.push({ photoIndex, entries: extraction.entries });
      pages.push({
        photoIndex,
        ok: true,
        isVocabPage: extraction.isVocabPage,
        entryCount: extraction.entries.length,
        errorMessage: null,
      });
      // DAY 대표값: 처음 발견한 non-null dayLabel(사진마다 다를 수 있어 대표를 앱이 고른다, §5 인계)
      if (dayLabel === null && extraction.dayLabel) dayLabel = extraction.dayLabel;
    } else {
      // 여기 오는 것은 그 사진이 재요청 1회까지 쓰고도 스키마를 못 맞춘 경우다
      const reason = result.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(`[/api/english/vocab/extract] 사진 ${photoIndex} 판독 실패:`, message);
      pages.push({ photoIndex, ok: false, isVocabPage: false, entryCount: 0, errorMessage: message });
    }
  });

  const failedPhotoCount = pages.filter((p) => !p.ok).length;

  // **모든** 사진이 throw했다 = AI가 전부 죽었다. 이때만 500(재시도 버튼).
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

  const merged = mergeVocabPages(pagesForMerge);

  // §7-6 폴백 — 한 단어도 못 읽었다(단어장이 아니거나 흐림). 오류가 아니라 정상 갈래다.
  if (merged.entries.length === 0) {
    return json({
      ok: false,
      reason: "retake",
      messageKo:
        "사진에서 단어를 읽지 못했어요. 단어장 페이지가 화면에 꽉 차게, 그림자 없이 다시 찍어 주세요.",
    });
  }

  return json({
    ok: true,
    entries: merged.entries,
    dayLabel,
    mergedCount: merged.mergedCount,
    missingNos: merged.missingNos,
    photoCount: images.length,
    failedPhotoCount,
    pages,
  });
}

/**
 * POST /api/pages — 본문·목차 판독 (SPEC §3-(2′)·§7-1′, HARNESS §2A / 호출 A′)
 *
 * 순서대로 찍은 본문 사진 N장(또는 목차 사진 1~2장)을 받아 lib/ai의 digestPages()로
 * 장면별 우리말 요약(sceneDigest)을 만든다. 배치 분할·병렬 호출·부분 실패 격리·
 * seq 재부여는 전부 lib/ai가 한다 — 이 라우트는 입력 검증과 상태코드 매핑만 맡는다.
 *
 * 사진 취급은 /api/extract와 같은 정책(SPEC §1·§5): 이 요청의 메모리에서만 쓰고
 * 어디에도 저장·로깅하지 않는다. 남는 것은 우리말 요약 텍스트뿐이다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, sourceKind, scenes, batches, failedBatchCount: 0, messageKo: null, bookId }
 * - 200 { ok: true, ...동일, failedBatchCount: n>0, messageKo }   ← 부분 실패(나머지 장면은 정상)
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }
 * - 404 { ok: false, error: "book_not_found", messageKo }
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { digestPages, isPagesError, PAGES_BATCH_SIZE, PAGES_MAX_IMAGES } from "@/lib/ai/client";
import { normalizeSceneDigest, SCENE_SOURCE_KINDS } from "@/lib/ai/english/schemas";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// 입력 스키마
// ---------------------------------------------------------------------------

/** 이미지 1장 상한 — /api/extract와 같은 값(같은 리사이즈 파이프라인을 지난다) */
const MAX_IMAGE_CHARS = 8_000_000;

/**
 * 요청 전체 상한. 이미지당 상한만 두면 40장 × 8MB = 320MB 본문이 가능해진다(QA 관찰 3).
 * 24MB로 잡은 이유: Cloud Run의 요청 상한이 32MiB이고, 클라이언트가 긴 변 1500px JPEG로
 * 리사이즈해 보내면 40장이 대략 12~20MB라 정상 사용은 넉넉히 들어온다.
 */
const MAX_TOTAL_CHARS = 24_000_000;

const bodySchema = z.object({
  images: z
    .array(
      z
        .string()
        .regex(/^data:image\/[a-z0-9.+-]+;base64,/i, "이미지 data URL 형식이어야 해요")
        .max(MAX_IMAGE_CHARS, "사진 한 장이 너무 커요 — 다시 시도해 주세요"),
    )
    .min(1, "사진을 1장 이상 보내 주세요")
    // 상한 숫자를 여기에 다시 적지 않는다 — lib/ai가 단일 정의처다(두 곳에 적으면 어긋난다).
    // lib/ai도 같은 검사를 하지만, 라우트가 먼저 잡아야 400이 보장된다(§2-4).
    .max(PAGES_MAX_IMAGES, `사진은 한 번에 최대 ${PAGES_MAX_IMAGES}장까지예요`)
    .superRefine((images, ctx) => {
      const total = images.reduce((sum, img) => sum + img.length, 0);
      if (total > MAX_TOTAL_CHARS) {
        ctx.addIssue({
          code: "custom",
          message: `사진 용량이 너무 커요 — 몇 장씩 나눠서 올려 주세요 (전체 최대 ${Math.round(
            MAX_TOTAL_CHARS / 1_000_000,
          )}MB)`,
        });
      }
    }),
  sourceKind: z.enum(SCENE_SOURCE_KINDS),
  /** 있으면 책 맥락을 힌트로 넘기고, 판독 결과를 그 책에 저장한다 */
  bookId: z.string().trim().min(1).max(200).optional(),
  /** bookId가 없을 때의 맥락 힌트 (판독 직후 아직 book이 없는 신규 흐름) */
  book: z
    .object({
      title: z.string().trim().max(300).nullish(),
      author: z.string().trim().max(200).nullish(),
      isFiction: z.boolean().nullish(),
      topic: z.string().trim().max(500).nullish(),
    })
    .optional(),
  /** 이어 찍기 — 이미 만든 장면 뒤에 붙일 때의 첫 장면 번호 (기본 1) */
  startSeq: z.number().int().min(1).max(10_000).optional(),
});

// ---------------------------------------------------------------------------
// 응답 헬퍼
// ---------------------------------------------------------------------------

function invalidInput(messageKo: string, error?: z.ZodError) {
  return NextResponse.json(
    {
      ok: false,
      error: "invalid_input",
      messageKo,
      issues:
        error?.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })) ?? [],
    },
    { status: 400 },
  );
}

function aiFailed() {
  return NextResponse.json(
    {
      ok: false,
      error: "ai_failed",
      messageKo: "사진을 읽다가 문제가 생겼어요. 잠시 후 '재시도'를 눌러 주세요.",
      retriable: true, // SPEC §9 — 클라이언트는 재시도 버튼을 노출한다
    },
    { status: 500 },
  );
}

/**
 * 부분 실패 안내 문구.
 *
 * `gapBefore` 마커는 불리언이라 (a) 마지막 배치가 실패하면 붙일 장면이 없고,
 * (b) 배치가 연달아 실패하면 마커 1개로 합쳐진다(HARNESS §2A-5). 그래서 "어느 사진이
 * 안 읽혔는지"는 배치 범위로만 정확히 알릴 수 있다 — 몇 장면이 빠졌는지는 말하지 않는다.
 */
function partialFailureMessage(
  batches: { ok: boolean; fromImageIndex: number; toImageIndex: number }[],
): string {
  const failed = batches.filter((b) => !b.ok);
  const ranges = failed
    .map((b) =>
      b.fromImageIndex === b.toImageIndex
        ? `${b.fromImageIndex}번째`
        : `${b.fromImageIndex}~${b.toImageIndex}번째`,
    )
    .join(", ");
  return `사진 ${ranges} 묶음을 읽지 못했어요. 나머지 장면은 그대로 쓸 수 있어요 — 그 사진들만 다시 찍어 올리면 채워 넣을 수 있어요.`;
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (/api/card·/api/extract와 동일 정책)
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
    return invalidInput("요청 본문이 올바른 JSON이 아니에요.");
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidInput("사진 데이터를 확인해 주세요.", parsed.error);
  }
  const input = parsed.data;

  // bookId를 줬으면 그 책의 메타데이터를 맥락 힌트로 쓰고, 결과도 그 책에 저장한다
  const store = getStore();
  const book = input.bookId ? await store.getBook(input.bookId) : null;
  if (input.bookId && !book) {
    return NextResponse.json(
      {
        ok: false,
        error: "book_not_found",
        messageKo: "책 정보를 찾을 수 없어요. 홈에서 다시 만들어 주세요.",
      },
      { status: 404 },
    );
  }

  let result;
  try {
    // 사진은 여기서 판독에만 쓰고 저장하지 않는다 (SPEC §1·§5)
    result = await digestPages({
      images: input.images,
      sourceKind: input.sourceKind,
      book: book
        ? {
            title: book.title,
            author: book.author,
            isFiction: book.isFiction,
            topic: book.topic,
          }
        : input.book ?? undefined,
      startSeq: input.startSeq,
    });
  } catch (err) {
    // 입력 오류(0장·상한 초과)는 재시도해도 그대로 실패한다 — 400으로 갈라 보낸다.
    // 라우트 zod가 먼저 막지만, 뚫린 경우 여기가 마지막 관문이다 (HARNESS §2A-5).
    if (isPagesError(err) && err.code === "invalid_input") {
      console.error("[/api/pages] 입력 오류:", err.message);
      return invalidInput("사진 장수를 확인해 주세요.");
    }
    // PagesError("ai_failed")(전 배치 실패) 및 예상 밖 오류
    console.error("[/api/pages] 본문 판독 실패:", err);
    return aiFailed();
  }

  // digestPages는 성공 시 항상 장면 1개 이상을 돌려준다 — 빈 배열이면 버그다(§2-4)
  if (result.scenes.length === 0) {
    console.error("[/api/pages] 판독은 성공했는데 장면이 0개입니다 (버그):", result.batches);
    return aiFailed();
  }

  const scenes = normalizeSceneDigest(result.scenes);

  // 기존 책에 붙인 경우에만 저장한다. 신규 흐름은 아직 book이 없으므로
  // 클라이언트가 이 결과를 그대로 /api/card로 넘기고, 그때 book에 저장된다.
  if (book) {
    await store.updateBookEvidence(book.id, { sceneDigest: scenes, sceneKind: result.sourceKind });
  }

  return NextResponse.json({
    ok: true,
    sourceKind: result.sourceKind,
    scenes,
    batches: result.batches,
    failedBatchCount: result.failedBatchCount,
    messageKo:
      result.failedBatchCount > 0 ? partialFailureMessage(result.batches) : null,
    /** 저장까지 마친 경우에만 값이 있다 — 없으면 클라이언트가 scenes를 들고 /api/card로 간다 */
    bookId: book?.id ?? null,
    /** 진행 안내에 쓰는 참고값 (사진 N장이 몇 묶음으로 나뉘었는지) */
    batchSize: PAGES_BATCH_SIZE,
  });
}

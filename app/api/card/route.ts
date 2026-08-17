/**
 * POST /api/card — 학습 카드 생성 (M1 수동 입력 + M2 판독·식별 결과 수신)
 *
 * 흐름: zod 입력 검증 → (§3-2 템플릿 조립 + callWithSchema('card') = lib/ai의
 * generateCard) → 성공 시에만 book+card 저장 → { bookId, cardId } 반환.
 * 불완전 데이터 저장 금지(SPEC §9): AI 생성이 성공한 뒤에만 저장한다.
 *
 * M2 확장: 식별 단계(/api/identify) 결과인 isbn·coverUrl·googleBooksId·description과
 * levelEstimated를 받아 book에 저장한다. description은 §3-2 템플릿의
 * googleBooksDescription으로 카드 생성 입력에 전달된다.
 *
 * story-2 확장 (줄거리 근거): blurbText(호출 A) · sceneKind/sceneDigest(호출 A′ =
 * /api/pages)를 받아 (a) 호출 B 입력에 싣고, (b) book에 보관하고,
 * (c) 생성된 카드에 attachSceneDigest로 붙여 저장한다. 세 곳 모두 필요하다 —
 * (a)가 없으면 줄거리가 안 길어지고, (b)가 없으면 "다시 생성"이 근거를 잃고,
 * (c)가 없으면 카드 화면에 장면 메모가 안 나온다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, bookId, cardId }
 * - 200 { ok: false, reason: "duplicate", messageKo, bookId, cardId | null }  ← SPEC §9 동일 책 재등록
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }
 * - 404 { ok: false, error: "book_not_found", messageKo }                     ← 재생성 시 bookId 미존재
 * - 501 { ok: false, error: "no_api_key", messageKo }                         ← OPENAI_API_KEY 없음
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }         ← AI 오류·검증 재시도 소진 (SPEC §9 재시도 안내)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_OPENAI_MODEL, generateCard } from "@/lib/ai/client";
import type { CardUserMessageInput } from "@/lib/ai/english/prompts";
import {
  attachSceneDigest,
  MAX_SCENE_DIGEST_ITEMS,
  normalizeSceneDigest,
  SCENE_ASK_KO_MAX,
  SCENE_CONFIDENCE_LEVELS,
  SCENE_LABEL_KO_MAX,
  SCENE_SOURCE_KINDS,
  SCENE_SUMMARY_KO_MAX,
  type Card,
  type LearningCard,
  type SceneDigestItem,
} from "@/lib/ai/english/schemas";
import { getStore, type BookRecord } from "@/lib/store";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// 입력 스키마
// ---------------------------------------------------------------------------

/**
 * 호출 A′ 결과를 그대로 받는 스키마 — 길이 상한이 없으면 그대로 호출 B 프롬프트에 실린다.
 *
 * 상한 값을 **여기에 숫자로 적지 않는다.** 생산자(A′ zod)와 소비자(이 라우트)가 서로
 * 다른 상한을 쓰면 `/api/pages`가 200으로 내려준 장면을 `/api/card`가 400으로 거부하는
 * 구멍이 생긴다(QA F12 — labelKo 131자로 실증됨). `lib/ai/english/schemas.ts`가 단일 정의처다.
 */
const sceneDigestItemSchema = z.object({
  seq: z.number().int().min(0).max(10_000),
  labelKo: z.string().trim().min(1).max(SCENE_LABEL_KO_MAX),
  summaryKo: z.string().trim().min(1).max(SCENE_SUMMARY_KO_MAX),
  askKo: z.string().trim().max(SCENE_ASK_KO_MAX).nullish(),
  confidence: z.enum(SCENE_CONFIDENCE_LEVELS).nullish(),
  gapBefore: z.boolean().nullish(),
});

/**
 * 줄거리 근거 3필드 — 신규 생성 경로가 `/api/extract`·`/api/pages` 결과를 실어 보낸다.
 * 이 세 필드가 빠지면 storySource가 metadata로 떨어져 줄거리가 3~4문장으로 줄어든다.
 */
const evidenceShape = {
  blurbText: z.string().trim().max(4000).nullish(),
  sceneKind: z.enum(SCENE_SOURCE_KINDS).nullish(),
  sceneDigest: z.array(sceneDigestItemSchema).max(MAX_SCENE_DIGEST_ITEMS).nullish(),
};

/** 재생성 경로 — 기존 book으로 새 카드만 만든다 ("다시 생성" 버튼) */
const regenerateBodySchema = z.object({
  bookId: z.string().min(1),
});

/** 신규 경로 — 수동 메타데이터 전체 (SPEC §4-1 "책 이름으로 만들기" 폼) */
const newCardBodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).optional(),
  series: z.string().trim().max(200).optional(),
  arLevel: z.number().min(0).max(13).nullish(),
  lexile: z.number().int().min(0).max(2000).nullish(),
  wordCount: z.number().int().min(1).max(1_000_000).nullish(),
  arQuizNo: z.string().trim().max(50).optional(),
  isFiction: z.boolean(),
  topic: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4000).optional(),
  coverEmoji: z.string().trim().max(16).optional(),
  // --- M2: 식별 단계(/api/identify) 결과 ---
  isbn: z.string().trim().max(40).optional(),
  coverUrl: z.string().trim().regex(/^https:\/\//, "https URL이어야 해요").max(1000).optional(),
  googleBooksId: z.string().trim().max(120).optional(),
  /** 명시하지 않으면 arLevel 부재로 판단한다 (SPEC §3 — AR 미확보 시 레벨 추정) */
  levelEstimated: z.boolean().optional(),
  force: z.boolean().optional(), // 동일 책 재등록 시 "그래도 새로 만들기"
  // --- story-2: 줄거리 근거 (호출 A의 blurbText + 호출 A′의 sceneDigest) ---
  ...evidenceShape,
});

// ---------------------------------------------------------------------------
// 응답 헬퍼
// ---------------------------------------------------------------------------

function invalidInput(error: z.ZodError) {
  return NextResponse.json(
    {
      ok: false,
      error: "invalid_input",
      messageKo: "입력 내용을 확인해 주세요.",
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

function aiFailed() {
  return NextResponse.json(
    {
      ok: false,
      error: "ai_failed",
      messageKo: "카드를 만들다가 문제가 생겼어요. 잠시 후 '재시도'를 눌러 다시 만들어 주세요.",
      retriable: true, // SPEC §9 — 클라이언트는 재시도 버튼을 노출한다
    },
    { status: 500 },
  );
}

function resolveModel(): string {
  return process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}

/** AI 호출 — throw(재시도 소진)를 500 응답으로 변환하기 위한 래핑 */
async function tryGenerate(
  meta: CardUserMessageInput,
): Promise<{ ok: true; card: LearningCard } | { ok: false }> {
  try {
    const card = await generateCard(meta);
    return { ok: true, card };
  } catch (err) {
    console.error("[/api/card] 카드 생성 실패:", err);
    return { ok: false };
  }
}

/**
 * 저장된 book → 호출 B 입력.
 *
 * **근거 3필드를 반드시 함께 넘긴다.** 빠뜨리면 "다시 생성"이 근거를 잃고
 * storySource가 metadata로 떨어져 줄거리가 장면 수에 비례한 분량(14장면이면
 * 8~10문장)에서 3~4문장으로 조용히 퇴화한다 — 사진 재업로드 없는 재생성이
 * 2단계 분리(HARNESS §2A)의 핵심 이득이다.
 * `sceneKind`도 반드시 함께 — 빠지면 목차 근거가 "본문 확인"으로 오표기된다.
 */
function bookToMeta(book: BookRecord): CardUserMessageInput {
  return {
    title: book.title,
    author: book.author,
    series: book.series,
    isFiction: book.isFiction,
    arLevel: book.arLevel,
    lexile: book.lexile,
    wordCount: book.wordCount,
    topic: book.topic,
    googleBooksDescription: book.description,
    childNote: null,
    blurbText: book.blurbText,
    sceneKind: book.sceneKind,
    sceneDigest: book.sceneDigest,
  };
}

/** 요청·저장 어느 쪽으로 가든 선택 키의 undefined를 없앤 형태로 통일한다 */
function toStoredScenes(
  scenes: readonly SceneDigestItem[] | null | undefined,
): SceneDigestItem[] | null {
  return scenes && scenes.length > 0 ? normalizeSceneDigest(scenes) : null;
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (M1 로컬 데모 배려)
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

  const store = getStore();
  const model = resolveModel();

  // --- 재생성 경로: 같은 book으로 새 카드 (기존 카드는 유지) ---
  if (typeof body === "object" && body !== null && "bookId" in body) {
    const parsed = regenerateBodySchema.safeParse(body);
    if (!parsed.success) return invalidInput(parsed.error);

    const book = await store.getBook(parsed.data.bookId);
    if (!book) {
      return NextResponse.json(
        { ok: false, error: "book_not_found", messageKo: "책 정보를 찾을 수 없어요. 홈에서 다시 만들어 주세요." },
        { status: 404 },
      );
    }

    const gen = await tryGenerate(bookToMeta(book));
    if (!gen.ok) return aiFailed();

    // 장면 메모는 호출 B의 출력이 아니다 — book에 보관한 원본을 카드에 그대로 복사한다
    // (HARNESS §2A-6: 모델에게 되돌려 받으면 출력 토큰만 늘고 요약이 변조된다)
    const content: Card = attachSceneDigest(gen.card, book.sceneDigest);
    const card = await store.createCard({ bookId: book.id, content, model });
    return NextResponse.json({ ok: true, bookId: book.id, cardId: card.id });
  }

  // --- 신규 경로: 수동 메타데이터 → 카드 생성 ---
  const parsed = newCardBodySchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;

  // 저자 선택 입력(SPEC §4-1) — 비어 있으면 "미상"으로 통일 (§3-2 템플릿의 author는 필수 슬롯)
  const author = input.author || "미상";

  // 동일 책 재등록(제목+저자 일치, SPEC §9): 기존 카드로 안내하고 "그래도 새로 만들기" 선택지 제공
  const existing = await store.findBookByTitleAuthor(input.title, author);
  if (existing && !input.force) {
    const cards = await store.listCardsForBook(existing.id);
    return NextResponse.json({
      ok: false,
      reason: "duplicate",
      messageKo: "이미 이 책으로 만든 카드가 있어요.",
      bookId: existing.id,
      cardId: cards[0]?.id ?? null,
    });
  }

  // 근거 3필드는 카드 생성 입력이자 book 저장분이다 — 같은 값을 두 곳에 쓴다
  const blurbText = input.blurbText?.trim() || null;
  const sceneDigest = toStoredScenes(input.sceneDigest);
  // 장면이 없으면 sceneKind도 의미가 없다(배지 오표기 방지)
  const sceneKind = sceneDigest ? (input.sceneKind ?? "pages") : null;

  const meta: CardUserMessageInput = {
    title: input.title,
    author,
    series: input.series || null,
    isFiction: input.isFiction,
    arLevel: input.arLevel ?? null,
    lexile: input.lexile ?? null,
    wordCount: input.wordCount ?? null,
    topic: input.topic,
    googleBooksDescription: input.description || null,
    childNote: null,
    blurbText,
    sceneKind,
    sceneDigest,
  };

  const gen = await tryGenerate(meta);
  if (!gen.ok) return aiFailed();

  // 생성 성공 후에만 저장 (불완전 데이터 저장 금지, SPEC §9)
  const book =
    existing ??
    (await store.createBook({
      title: input.title,
      author,
      series: input.series || null,
      isbn: input.isbn || null,
      arLevel: input.arLevel ?? null,
      lexile: input.lexile ?? null,
      wordCount: input.wordCount ?? null,
      arQuizNo: input.arQuizNo || null,
      isFiction: input.isFiction,
      topic: input.topic,
      coverUrl: input.coverUrl || null,
      googleBooksId: input.googleBooksId || null,
      coverEmoji: input.coverEmoji || null,
      description: input.description || null,
      // 명시값 우선, 없으면 AR 부재로 판단 — 레벨 추정 배지 대상 (SPEC §3)
      levelEstimated: input.levelEstimated ?? (input.arLevel == null),
      // 근거 보관 (SPEC §5) — 사진을 저장하지 않으므로 이 요약이 유일한 사본이다.
      // 여기가 비면 "다시 생성"이 metadata로 퇴화한다 (QA F7)
      blurbText,
      sceneKind,
      sceneDigest,
    }));

  // "그래도 새로 만들기"(force)로 기존 book을 재사용한 경우 — 이번에 새로 얻은 근거가
  // 있으면 book에 갱신해 둔다. 갱신하지 않으면 다음 재생성이 옛 근거로 돌아간다.
  // 빈 값으로 기존 근거를 지우지는 않는다(넘어온 키만 덮어쓴다).
  if (existing && (blurbText || sceneDigest)) {
    await store.updateBookEvidence(existing.id, {
      ...(blurbText ? { blurbText } : {}),
      ...(sceneDigest ? { sceneDigest, sceneKind } : {}),
    });
  }

  const content: Card = attachSceneDigest(gen.card, sceneDigest);
  const card = await store.createCard({ bookId: book.id, content, model });
  return NextResponse.json({ ok: true, bookId: book.id, cardId: card.id });
}

/**
 * POST /api/card — 학습 카드 생성 (M1: 수동 메타데이터 입력)
 *
 * 흐름: zod 입력 검증 → (§3-2 템플릿 조립 + callWithSchema('card') = lib/ai의
 * generateCard) → 성공 시에만 book+card 저장 → { bookId, cardId } 반환.
 * 불완전 데이터 저장 금지(SPEC §9): AI 생성이 성공한 뒤에만 저장한다.
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
import type { CardUserMessageInput } from "@/lib/ai/prompts";
import type { LearningCard } from "@/lib/ai/schemas";
import { getStore, type BookRecord } from "@/lib/store";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// 입력 스키마
// ---------------------------------------------------------------------------

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
  force: z.boolean().optional(), // 동일 책 재등록 시 "그래도 새로 만들기"
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
  };
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

    const card = await store.createCard({ bookId: book.id, content: gen.card, model });
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
      isbn: null,
      arLevel: input.arLevel ?? null,
      lexile: input.lexile ?? null,
      wordCount: input.wordCount ?? null,
      arQuizNo: input.arQuizNo || null,
      isFiction: input.isFiction,
      topic: input.topic,
      coverUrl: null,
      googleBooksId: null,
      coverEmoji: input.coverEmoji || null,
      description: input.description || null,
      // AR을 못 받았으면 레벨 추정 배지 대상 (SPEC §3)
      levelEstimated: input.arLevel == null,
    }));

  const card = await store.createCard({ bookId: book.id, content: gen.card, model });
  return NextResponse.json({ ok: true, bookId: book.id, cardId: card.id });
}

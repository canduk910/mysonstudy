/**
 * /api/readings — 읽음 기록 (M3, SPEC §4-3 "오늘 읽었어요" + §5 readings 컬렉션)
 *
 * POST: 읽음 기록 추가. readAt은 클라이언트의 "로컬 날짜"(YYYY-MM-DD)를 받는다 —
 *       서버(UTC)와 사용자(KST)의 '오늘'이 다를 수 있어, 읽은 날의 기준은 사용자
 *       쪽 달력이어야 자연스럽다. 미전달 시 서버 UTC 날짜로 폴백.
 *       같은 책 + 같은 날짜 기록이 이미 있으면 중복 삽입하지 않고 기존 기록을
 *       돌려준다(자연스러운 중복 처리 — ok: true + duplicate: true).
 * GET:  ?bookId= 로 책별 조회, 없으면 전체 — 최신순.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트 M3에도 명시):
 * - POST 200 신규:  { ok: true, duplicate: false, reading: ReadingRecord, messageKo }
 * - POST 200 중복:  { ok: true, duplicate: true,  reading: ReadingRecord, messageKo }
 * - POST 400:       { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }
 * - POST 404:       { ok: false, error: "book_not_found", messageKo }
 * - GET  200:       { ok: true, readings: ReadingRecord[] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const postBodySchema = z.object({
  bookId: z.string().min(1),
  /** 클라이언트 로컬 날짜 — 시간 없는 ISO 8601 날짜만 받는다 */
  readAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 해요")
    .optional(),
  rating: z.number().int().min(1).max(5).nullish(),
  noteKo: z.string().trim().max(500).optional(),
});

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

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] },
      { status: 400 },
    );
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;

  const store = getStore();
  const book = await store.getBook(input.bookId);
  if (!book) {
    return NextResponse.json(
      { ok: false, error: "book_not_found", messageKo: "책 정보를 찾을 수 없어요." },
      { status: 404 },
    );
  }

  const date = input.readAt ?? new Date().toISOString().slice(0, 10);

  // 같은 날 중복 체크 — 하루에 한 번만 기록한다 (여러 번 눌러도 안심)
  const existing = (await store.listReadings(book.id)).find(
    (r) => r.readAt.slice(0, 10) === date,
  );
  if (existing) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      reading: existing,
      messageKo: "이 책은 오늘 이미 기록했어요. 내일 또 읽으면 새로 기록돼요!",
    });
  }

  const reading = await store.addReading({
    bookId: book.id,
    readAt: date, // 날짜만 저장 — 읽은 '날'이 의미 단위 (시각은 쓰지 않는다)
    rating: input.rating ?? null,
    noteKo: input.noteKo || null,
  });

  return NextResponse.json({
    ok: true,
    duplicate: false,
    reading,
    messageKo: "오늘의 읽기를 기록했어요!",
  });
}

export async function GET(req: Request) {
  const bookId = new URL(req.url).searchParams.get("bookId") ?? undefined;
  const readings = await getStore().listReadings(bookId);
  return NextResponse.json({ ok: true, readings });
}

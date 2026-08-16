/**
 * POST /api/identify — 책 식별 단계 (SPEC §3-(2), M2)
 *
 * 제목(+저자)로 Google Books → Open Library 폴백 검색 (lib/identify).
 * 식별 실패는 정상 흐름이다 — 둘 다 실패해도 200 + null 필드로 응답해
 * 카드 생성을 막지 않는다 (SPEC §9). AI 호출·API 키가 필요 없는 라우트.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, found: boolean, result: IdentifyResult }  ← found = source !== null
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { identifyBook } from "@/lib/identify";

export const runtime = "nodejs";

const bodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).optional(),
});

function invalidInput(issues: { path: string; message: string }[]) {
  return NextResponse.json(
    { ok: false, error: "invalid_input", messageKo: "책 제목을 확인해 주세요.", issues },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidInput([]);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  const result = await identifyBook(parsed.data.title, parsed.data.author || null);
  return NextResponse.json({ ok: true, found: result.source !== null, result });
}

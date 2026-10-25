/**
 * POST /api/japanese/speaking/mocks/reorder — 말하기 모의고사 목록 순서 (SPEC §15 공통 순서변경, lib/reorder-contract.ts)
 *
 * 응답 shape (lib/reorder-contract.ts ReorderResponse): 200 { ok:true, count } · 400 invalid_input · 500 save_failed
 */

import { NextResponse } from "next/server";
import { reorderRequestSchema, type ReorderResponse } from "@/lib/reorder-contract";
import { getStore } from "@/lib/store";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

function json(body: ReorderResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = reorderRequestSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      { ok: false, error: "invalid_input", messageKo: parsed.error.issues[0]?.message ?? "정렬 순서를 확인해 주세요.", issues: toToeicIssues(parsed.error.issues) },
      400,
    );
  }
  try {
    await getStore().reorderJaSpeakingMocks(parsed.data.orderedIds);
    return json({ ok: true, count: parsed.data.orderedIds.length });
  } catch {
    return json({ ok: false, error: "save_failed", messageKo: "순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

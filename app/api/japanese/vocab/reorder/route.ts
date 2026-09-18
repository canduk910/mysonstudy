/**
 * POST /api/japanese/vocab/reorder — 일본어 단어장 목록 수동 정렬 저장 (아빠의 일본어 J1)
 *
 * `/api/english/vocab/reorder`와 같은 골격 — 범용 계약(lib/reorder-contract) 재사용, 스토어 메서드만
 * reorderJaVocabBooks로 갈아끼운다. 본문 `{ orderedIds }`가 곧 최종 순서. **수정이라 prod-guard 무관.** AI 없음.
 *
 * - 200 { ok:true, count } / 400 invalid_input / 500 save_failed
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { reorderRequestSchema, type ReorderResponse } from "@/lib/reorder-contract";

export const runtime = "nodejs";

function json(body: ReorderResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = reorderRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "정렬 순서를 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }

  try {
    await store.reorderJaVocabBooks(parsed.data.orderedIds);
    return json({ ok: true, count: parsed.data.orderedIds.length });
  } catch {
    return json(
      { ok: false, error: "save_failed", messageKo: "순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

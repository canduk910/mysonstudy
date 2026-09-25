/**
 * POST /api/toeic/sets/reorder — 표현집 목록 수동 정렬 저장 (docs/harness/toeic.md §8, SPEC §15-1)
 *
 * `/api/japanese/vocab/reorder`와 같은 골격 — 범용 계약(lib/reorder-contract) 재사용, 스토어 메서드만 reorderToeicSets로
 * 갈아끼운다. 본문 `{ orderedIds }`가 곧 최종 순서. **수정이라 prod-guard 무관.** AI 없음.
 *
 * - 200 { ok:true, count } / 400 invalid_input / 500 save_failed
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { reorderRequestSchema, type ReorderResponse } from "@/lib/reorder-contract";
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
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "정렬 순서를 확인해 주세요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }

  try {
    await getStore().reorderToeicSets(parsed.data.orderedIds);
    return json({ ok: true, count: parsed.data.orderedIds.length });
  } catch {
    return json({ ok: false, error: "save_failed", messageKo: "순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * POST /api/math/reorder — 수학 서재(설명) 목록 수동 정렬 저장 (math.md §9-4)
 *
 * 관리 모드에서 드래그·↑/↓로 맞춘 설명 순서를 받아 저장한다. 본문 `{ orderedIds }`가 곧 최종
 * 순서이고, 스토어가 각 설명의 sortIndex를 0..n으로 재색인한다(reorderExplanations). **수정이라
 * prod-guard 무관**(삭제가 아니다). AI 호출 없음. 서재 `/api/library/reorder`와 같은 골격이다.
 *
 * 인증: 앱 전체가 proxy.ts의 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에 닿기 전에 막힌다.
 *
 * 계약의 단일 정의처는 `lib/reorder-contract.ts`(범용):
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
    return json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." },
      400,
    );
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
  const { orderedIds } = parsed.data;

  try {
    await store.reorderExplanations(orderedIds);
    return json({ ok: true, count: orderedIds.length });
  } catch {
    return json(
      { ok: false, error: "save_failed", messageKo: "순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

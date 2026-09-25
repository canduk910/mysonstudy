/**
 * DELETE /api/toeic/sets/[id] — 표현집 세트 1개 삭제 (docs/harness/toeic.md §7-3·§8)
 *
 * 세트와 **그 세트의 시험 세션까지** 지운다(스토어가 딸린 세션 먼저, 세트 마지막). 확인 단계는 화면(목록 인라인 확인)이 맡는다.
 * 개발 환경에서 실데이터(firestore) 삭제는 prod-guard가 막는다 → 403(파일 백엔드는 안전). `/api/japanese/vocab/[id]` 규약.
 *
 * 응답 shape (단일 정의처는 `lib/toeic-set-contract.ts` ToeicSetDeleteResponse):
 * - 200 { ok:true }
 * - 404 { ok:false, error:"set_not_found", messageKo }
 * - 403 { ok:false, error:"prod_guard", messageKo }
 * - 500 { ok:false, error:"delete_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";
import type { ToeicSetDeleteResponse } from "@/lib/toeic-set-contract";

export const runtime = "nodejs";

function json(body: ToeicSetDeleteResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404(이미 지운 것을 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const record = await store.getToeicSet(id);
  if (!record) {
    return json({ ok: false, error: "set_not_found", messageKo: "이미 지워졌거나 없는 표현집이에요." }, 404);
  }

  try {
    await store.deleteToeicSet(id);
  } catch (e) {
    if (isProdGuardError(e)) {
      console.error(e.message);
      return json(
        {
          ok: false,
          error: "prod_guard",
          messageKo: "개발 환경이라 실제 데이터를 지우지 않았어요. 로컬 테스트는 STORE_BACKEND=file 로 돌려 주세요.",
        },
        403,
      );
    }
    console.error(`[/api/toeic/sets/${id}] 삭제 실패:`, e);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  return json({ ok: true });
}

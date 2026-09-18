/**
 * DELETE /api/japanese/dialog/[id] — 대화 복습 1개 삭제 (J3) — 딸린 것 없음. 개발 환경 실데이터 삭제는 prod-guard가 막는다.
 * - 200 { ok:true } / 404 not_found / 403 prod_guard / 500 delete_failed
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import type { JaDialogDeleteResponse } from "@/lib/japanese-dialog-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

function json(body: JaDialogDeleteResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  const record = await store.getJaDialog(id);
  if (!record) {
    return json({ ok: false, error: "not_found", messageKo: "이미 지워졌거나 없는 대화예요." }, 404);
  }
  try {
    await store.deleteJaDialog(id);
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
    console.error(`[/api/japanese/dialog/${id}] 삭제 실패:`, e);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
  return json({ ok: true });
}

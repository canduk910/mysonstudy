/**
 * DELETE /api/english/talk/[id] — 자유대화 기록 삭제 + 딸린 주제 일러스트 연쇄 (docs/harness/english.md §12-4·§12-6)
 *
 * 스토어가 딸린 그림(`talkImages`)을 먼저, 대화를 마지막에 지운다. Firestore는 `deleteTalkSession` prod-guard를 지난다 —
 * 개발 환경에서 실데이터를 지우려 하면 던지고, 여기서 403 `prod_guard`로 옮긴다. AI 없음(키 검사 없음).
 *
 * 응답(lib/talk-contract.ts `TalkDeleteResponse`):
 * - 200 { ok:true }
 * - 404 { ok:false, error:"talk_not_found", messageKo }
 * - 403 { ok:false, error:"prod_guard", messageKo }
 * - 500 { ok:false, error:"delete_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import { isFirestoreDocId } from "@/lib/reorder-contract";
import { getStore } from "@/lib/store";
import type { TalkDeleteResponse } from "@/lib/talk-contract";

export const runtime = "nodejs";

function json(body: TalkDeleteResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isFirestoreDocId(id)) return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요." }, 404);
  try {
    const result = await getStore().deleteTalkSession(id);
    if (!result.ok) return json({ ok: false, error: "talk_not_found", messageKo: "이미 지워진 대화예요." }, 404);
    return json({ ok: true });
  } catch (err) {
    if (isProdGuardError(err)) {
      return json({ ok: false, error: "prod_guard", messageKo: "개발 환경에서는 실제 기록을 지울 수 없어요." }, 403);
    }
    console.error(`[/api/english/talk/${id}] 삭제 실패`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

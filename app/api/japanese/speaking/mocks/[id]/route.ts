/**
 * GET·DELETE /api/japanese/speaking/mocks/[id] — 모의고사 새로 읽기(사진 실패 재확인) · 연쇄 삭제 (docs/harness/japanese.md §15-10-1)
 *
 * - GET: 학습 보기 화면이 사진 요청 뒤 레코드를 다시 읽는다(cache-control no-store — 옛 상태를 보면 판정이 틀린다).
 * - DELETE: 모의고사 + 생성 사진 + 응시 기록(store.deleteJaSpeakingMock — Firestore는 prod-guard `deleteJaSpeakingMock`). 녹음은 기기에만 있다.
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingMockGetResponse · JaSpeakingMockDeleteResponse):
 * - GET 200 { ok:true, mock } · 404 { ok:false, error:"mock_not_found", messageKo } · 500 { ok:false, error:"load_failed", messageKo }
 * - DELETE 200 { ok:true } · 404 mock_not_found · 403 prod_guard · 500 delete_failed
 */

import { NextResponse } from "next/server";
import type { JaSpeakingMockDeleteResponse, JaSpeakingMockGetResponse } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const headers = { "cache-control": "no-store" };
  try {
    const record = await getStore().getJaSpeakingMock(id);
    if (!record || !isRenderableJaSpeakingMock(record)) {
      const body: JaSpeakingMockGetResponse = { ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." };
      return NextResponse.json(body, { status: 404, headers });
    }
    const body: JaSpeakingMockGetResponse = { ok: true, mock: record };
    return NextResponse.json(body, { headers });
  } catch (err) {
    console.error(`[/api/japanese/speaking/mocks/${id}] 읽기 실패:`, err);
    const body: JaSpeakingMockGetResponse = { ok: false, error: "load_failed", messageKo: "모의고사를 읽지 못했어요." };
    return NextResponse.json(body, { status: 500, headers });
  }
}

function json(body: JaSpeakingMockDeleteResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getJaSpeakingMock(id);
  if (!record) return json({ ok: false, error: "mock_not_found", messageKo: "이미 지워졌거나 없는 모의고사예요." }, 404);
  try {
    await store.deleteJaSpeakingMock(id);
  } catch (e) {
    if (isProdGuardError(e)) {
      console.error(e.message);
      return json(
        { ok: false, error: "prod_guard", messageKo: "개발 환경이라 실제 데이터를 지우지 않았어요. 로컬 테스트는 STORE_BACKEND=file 로 돌려 주세요." },
        403,
      );
    }
    console.error(`[/api/japanese/speaking/mocks/${id}] 삭제 실패:`, e);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
  return json({ ok: true });
}

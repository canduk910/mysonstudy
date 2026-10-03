/**
 * DELETE /api/toeic/attempts/[id]/recordings — 응시 하나의 **녹음 통째** 지우기 (docs/harness/toeic.md §14-4, SPEC §20-12)
 *
 * 답변 녹음·고칠 문장 녹음을 모두(대체된 옛 객체까지 — 응시 접두사 `attempts/{id}/`) 지운다. **응시 기록·점수·전사·피드백은 남는다**
 * (모의고사를 지우는 것과 다르다 — 스트릭 과거도 그대로). 순서는 lib/toeic-rec-delete 한 벌: 서버 보관소 먼저 → 메타 정리 + 지운 자리
 * (`q: null` — 지운 뒤 다른 기기 대기열이 올리는 이 응시의 옛 녹음은 전부 거부된다).
 * PIN 게이트(proxy.ts) 뒤. AI를 부르지 않으므로 키 검사가 없다. GCS 백엔드는 prod-guard(`deleteToeicRecordings`).
 *
 * 응답(ToeicRecordingDeleteResponse):
 * - 200 { ok:true, outcome:"deleted"|"absent", removedObjects, recordings:[], fixRecordings:[], recordingDeletions }
 * - 404 { ok:false, error:"attempt_not_found", messageKo }
 * - 403 { ok:false, error:"prod_guard", messageKo }
 * - 500 { ok:false, error:"delete_failed", messageKo, retriable:true }
 */

import { NextResponse } from "next/server";
import { deleteToeicRecordingTarget } from "@/lib/toeic-rec-delete";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, body } = await deleteToeicRecordingTarget(id, { kind: "attempt" });
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * /api/toeic/mocks/[id] — 모의고사 한 세트 읽기·삭제 (docs/harness/toeic.md §4-10·§7-2·§8)
 *
 * GET — 레코드 한 벌을 JSON으로. 학습 보기 화면이 사진 요청을 실패로 받았을 때 **이미 저장됐는지 한 번 새로 읽는** 자리다
 * (§4-10 — 응답이 60초 상한에 끊겨도 서버는 끝까지 저장하므로, 실패 표시는 다시 읽은 뒤에만). 목록·상세 페이지는 서버
 * 컴포넌트가 스토어를 직접 읽는다(조회 라우트를 거치지 않는 영어·일본어 규약) — 이 GET은 클라이언트의 재확인용이다.
 * 렌더 판정은 목록·상세와 **같은 함수**(lib/toeic-record).
 *
 * DELETE — 모의고사와 **그 생성 사진·응시 기록까지** 지운다(스토어가 딸린 문서 먼저, 모의고사 마지막). 확인 단계는 화면이
 * 맡는다. 개발 환경에서 실데이터(firestore) 삭제는 prod-guard가 막는다 → 403(파일 백엔드는 안전). 표현집 DELETE와 같은 규약.
 * (응시 녹음은 기기 IndexedDB에만 있다 — 서버 삭제 범위 밖.)
 *
 * 응답 shape (단일 정의처는 `lib/toeic-mock-contract.ts`):
 * - GET 200 { ok:true, mock } / 404 { ok:false, error:"mock_not_found", messageKo }     (ToeicMockGetResponse)
 * - DELETE 200 { ok:true } / 404 mock_not_found / 403 prod_guard / 500 delete_failed      (ToeicMockDeleteResponse)
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";
import type { ToeicMockDeleteResponse, ToeicMockGetResponse } from "@/lib/toeic-mock-contract";
import { isRenderableToeicMock } from "@/lib/toeic-record";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getStore().getToeicMock(id);
  if (!record || !isRenderableToeicMock(record)) {
    const body: ToeicMockGetResponse = { ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." };
    return NextResponse.json(body, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const body: ToeicMockGetResponse = { ok: true, mock: record };
  // 재확인용 — 캐시된 옛 상태를 보면 "이미 저장됐는지" 판정이 틀린다
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

function json(body: ToeicMockDeleteResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404(이미 지운 것을 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const record = await store.getToeicMock(id);
  if (!record) {
    return json({ ok: false, error: "mock_not_found", messageKo: "이미 지워졌거나 없는 모의고사예요." }, 404);
  }

  try {
    await store.deleteToeicMock(id);
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
    console.error(`[/api/toeic/mocks/${id}] 삭제 실패:`, e);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  return json({ ok: true });
}

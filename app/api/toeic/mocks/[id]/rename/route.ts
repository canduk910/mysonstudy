/**
 * POST /api/toeic/mocks/[id]/rename — 모의고사 이름(titleKo) 수정 (docs/harness/toeic.md §7-2·§8)
 *
 * **화면 이름만** 바꾼다(파트·사진·응시는 손대지 않는다). 수정이라 prod-guard 무관. AI 없음. 표현집 rename과 같은 규약
 * (성공 뒤 화면이 router.refresh).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-mock-contract.ts` ToeicMockRenameResponse):
 * - 200 { ok:true, id, titleKo }
 * - 400 invalid_input / 404 mock_not_found / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import { TOEIC_MOCK_TITLE_MAX, type ToeicMockRenameResponse } from "@/lib/toeic-mock-contract";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { collapseSpaces } from "@/lib/toeic-text";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  titleKo: z
    .string()
    .transform(collapseSpaces)
    .pipe(z.string().min(1, "모의고사 이름을 입력해 주세요").max(TOEIC_MOCK_TITLE_MAX, `이름은 최대 ${TOEIC_MOCK_TITLE_MAX}자예요`)),
});

function json(body: ToeicMockRenameResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "모의고사 이름을 확인해 주세요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }

  const record = await store.getToeicMock(id);
  if (!record || !isRenderableToeicMock(record)) {
    return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
  }

  try {
    const updated = await store.updateToeicMockTitle(id, parsed.data.titleKo);
    if (!updated) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch (err) {
    console.error(`[/api/toeic/mocks/${id}/rename] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

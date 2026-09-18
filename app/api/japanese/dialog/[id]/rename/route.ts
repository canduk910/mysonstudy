/**
 * POST /api/japanese/dialog/[id]/rename — 대화 복습 이름(titleKo) 수정 (J3) — 전사·해설 불변. AI 없음.
 * - 200 { ok:true, id, titleKo } / 400 / 404 / 500
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { JA_DIALOG_TITLE_MAX, type JaDialogRenameResponse } from "@/lib/japanese-dialog-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  titleKo: z.string().trim().min(1, "이름을 입력해 주세요").max(JA_DIALOG_TITLE_MAX, `이름은 최대 ${JA_DIALOG_TITLE_MAX}자예요`),
});

function json(body: JaDialogRenameResponse, status = 200) {
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
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "이름을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }

  try {
    const updated = await store.updateJaDialogTitle(id, parsed.data.titleKo);
    if (!updated) return json({ ok: false, error: "not_found", messageKo: "없는 대화예요." }, 404);
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch {
    return json({ ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

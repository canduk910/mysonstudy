/**
 * POST /api/english/talk/[id]/rename — 자유대화 화면 이름(titleKo)만 바꾼다 (docs/harness/english.md §12-4, SPEC §21-2)
 *
 * 스크립트·설명·그림은 그대로. 수정이라 prod-guard 무관. AI 없음(키 검사 없음). 성공하면 화면이 `router.refresh()`로 다시 읽는다.
 *
 * 응답(lib/talk-contract.ts `TalkRenameResponse`):
 * - 200 { ok:true, id, titleKo }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }   ← 빈 이름·상한(TALK_TITLE_MAX_CHARS) 초과
 * - 404 { ok:false, error:"talk_not_found", messageKo }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isFirestoreDocId } from "@/lib/reorder-contract";
import { getStore } from "@/lib/store";
import { TALK_TITLE_MAX_CHARS, type TalkRenameRequest, type TalkRenameResponse } from "@/lib/talk-contract";
import { isRenderableTalkSession } from "@/lib/talk-record";

export const runtime = "nodejs";

const bodySchema = z.object({
  titleKo: z
    .string()
    .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "이름을 입력해 주세요.").max(TALK_TITLE_MAX_CHARS, `이름은 ${TALK_TITLE_MAX_CHARS}자까지예요.`)),
});
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [TalkRenameRequest, BodyInput] extends [BodyInput, TalkRenameRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkRenameResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  if (!isFirestoreDocId(id)) return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요." }, 404);
  try {
    const store = getStore();
    if (!isRenderableTalkSession(await store.getTalkSession(id))) {
      return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요. 지워졌을 수 있어요." }, 404);
    }
    const updated = await store.updateTalkSessionTitle(id, parsed.data.titleKo);
    if (!updated) return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요. 지워졌을 수 있어요." }, 404);
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch (err) {
    console.error(`[/api/english/talk/${id}/rename] 저장 실패`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

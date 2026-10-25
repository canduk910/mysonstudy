/**
 * POST /api/japanese/speaking/mocks/[id]/rename — 말하기 모의고사 이름 바꾸기 (docs/harness/japanese.md §15-10-1)
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingRenameResponse):
 * 200 { ok:true, id, titleKo } · 400 invalid_input(+issues) · 404 mock_not_found · 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { JA_SPEAKING_TITLE_MAX_CHARS, type JaSpeakingRenameRequest, type JaSpeakingRenameResponse } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  titleKo: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "이름을 입력해 주세요").max(JA_SPEAKING_TITLE_MAX_CHARS, `이름은 최대 ${JA_SPEAKING_TITLE_MAX_CHARS}자예요`)),
});
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [JaSpeakingRenameRequest, BodyInput] extends [BodyInput, JaSpeakingRenameRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: JaSpeakingRenameResponse, status = 200) {
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
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      { ok: false, error: "invalid_input", messageKo: parsed.error.issues[0]?.message ?? "이름을 확인해 주세요.", issues: toToeicIssues(parsed.error.issues) },
      400,
    );
  }
  const store = getStore();
  const record = await store.getJaSpeakingMock(id);
  if (!record || !isRenderableJaSpeakingMock(record)) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
  try {
    const updated = await store.updateJaSpeakingMockTitle(id, parsed.data.titleKo);
    if (!updated) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch (err) {
    console.error(`[/api/japanese/speaking/mocks/${id}/rename] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

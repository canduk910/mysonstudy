/**
 * POST /api/japanese/vocab/[id]/rename — 일본어 단어장 이름(titleKo) 수정 (아빠의 일본어 J1)
 *
 * 단어장의 **화면 이름만** 바꾼다. entries·levels·topic·model은 손대지 않는다. **수정이라 prod-guard 무관.** AI 없음.
 * `/api/english/vocab/[id]/rename`와 같은 규약(성공 뒤 프론트 router.refresh).
 *
 * 응답 shape (단일 정의처는 `lib/japanese-vocab-contract.ts`):
 * - 200 { ok:true, id, titleKo }
 * - 400 invalid_input / 404 vocabbook_not_found / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { JA_TITLE_MAX, type JaVocabRenameResponse } from "@/lib/japanese-vocab-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  titleKo: z
    .string()
    .trim()
    .min(1, "단어장 이름을 입력해 주세요")
    .max(JA_TITLE_MAX, `이름은 최대 ${JA_TITLE_MAX}자예요`),
});

function json(body: JaVocabRenameResponse, status = 200) {
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
        messageKo: parsed.error.issues[0]?.message ?? "단어장 이름을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  const titleKo = parsed.data.titleKo;

  // 존재·렌더 가능 판정 — 목록/상세와 같은 함수(lib/japanese-record.ts).
  const record = await store.getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) {
    return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
  }

  try {
    const updated = await store.updateJaVocabBookTitle(id, titleKo);
    if (!updated) {
      return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
    }
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch {
    return json({ ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * POST /api/japanese/vocab/[id]/quiz — 일본어 시험 세션 저장 (아빠의 일본어 J2, §6-2·§7-3)
 *
 * 시험은 전부 클라이언트에서 진행되고, 이 라우트는 **끝(완료)/중단 시** 세션 결과를 받아 저장한다. **AI 없음.**
 * 혼합 세션은 화면이 **콘텐츠 모드별로 갈라** 여러 번 부른다(§6-2 무오염 — 한 레코드 = 한 모드). bookId는 URL에서.
 * 영어 vocabQuizzes와 **분리된 컬렉션**(jaQuizzes)에 append만 한다 — 수정·삭제 없어 prod-guard도 없다.
 *
 * 응답 shape (단일 정의처는 `lib/japanese-vocab-contract.ts`):
 * - 200 { ok:true, id }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { JA_QUIZ_MODES } from "@/lib/ai/japanese/quiz";
import { JA_WORD_MAX } from "@/lib/ai/japanese/schemas";
import type { JaQuizSubmitResponse } from "@/lib/japanese-vocab-contract";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const itemSchema = z.object({
  word: z.string().trim().min(1, "단어가 비어 있어요").max(JA_WORD_MAX),
  correct: z.boolean(),
  answered: z.boolean().nullable(),
});

const bodySchema = z.object({
  mode: z.enum(JA_QUIZ_MODES),
  startedAt: z.string().datetime({ message: "startedAt이 올바른 시각이 아니에요" }),
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  // 한 모드 세션의 문항 상한 — 단어장 하나의 단어 수보다 넉넉한 방어선(가족용 규모).
  items: z.array(itemSchema).min(1, "저장할 문항이 없어요").max(300, "문항 수가 너무 많아요"),
});

function json(body: JaQuizSubmitResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 유령 bookId 방어 — 존재·렌더 판정은 상세/시험과 같은 함수(lib/japanese-record).
  const book = await store.getJaVocabBook(id);
  if (!book || !isRenderableJaVocabBook(book)) {
    return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "시험 결과를 저장할 수 없어요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { mode, startedAt, finishedAt, items } = parsed.data;

  try {
    // bookId는 URL에서 — 본문 값을 믿지 않는다. 저장 계층이 items의 undefined를 마지막으로 조인다.
    const record = await store.addJaQuiz({ bookId: id, mode, startedAt, finishedAt, items });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error(`[/api/japanese/vocab/${id}/quiz] 시험 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "시험 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

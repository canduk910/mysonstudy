/**
 * POST /api/english/vocab/[id]/quiz — 시험 세션 저장 (V4, 계획 §V4)
 *
 * 시험은 **전부 클라이언트에서** 진행된다(정의 제시 → 5지선다 → 즉시 피드백). 진행 중 상태는
 * 브라우저에만 있고, 이 라우트는 **끝(완료) 또는 중단(그만하기) 시 딱 1회** 세션 결과를 받아
 * 저장한다. **AI를 호출하지 않는다** — 키가 없어도 저장은 되어야 한다(키 검사 없음, /vocab 저장과 같은 정책).
 *
 * bookId는 URL의 [id]에서 온다(본문에 없다). 저장 전 그 단어장이 실제로 있는지 확인해 유령 bookId를
 * 막는다(404). 시험은 전사본을 건드리지 않는 **별도 컬렉션(vocabQuizzes)**에 append로만 쌓인다 —
 * 수정·삭제가 없어 prod-guard도 걸지 않는다(계획 §V4).
 *
 * 응답 shape (단일 정의처는 `lib/vocab-quiz-contract.ts`):
 * - 200 { ok:true, id }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import type { VocabQuizSubmitResponse } from "@/lib/vocab-quiz-contract";
import { VOCAB_QUIZ_MODES } from "@/lib/vocab-quiz";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/**
 * 시험 문항 하나 — 저장 레코드(`VocabQuizItem`)와 같은 shape. `answered`는 세 상태를 유지하려고
 * nullable boolean이다(true=답함, false=답 안 함, null=미응답). `correct`는 boolean.
 * 값은 화면이 저장값 그대로 만들어 보내므로 관대하게 받되(word 길이만 제한), 저장 계층의
 * `normalizeVocabQuizItem`이 undefined를 마지막으로 조인다.
 */
const itemSchema = z.object({
  word: z.string().trim().min(1, "단어가 비어 있어요").max(VOCAB_LIMITS.word),
  correct: z.boolean(),
  answered: z.boolean().nullable(),
});

const bodySchema = z.object({
  mode: z.enum(VOCAB_QUIZ_MODES),
  // ISO 8601 시각(클라이언트가 세션 시작·완료에 찍는다). finishedAt은 부분 결과면 null.
  startedAt: z.string().datetime({ message: "startedAt이 올바른 시각이 아니에요" }),
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  items: z
    .array(itemSchema)
    .min(1, "저장할 문항이 없어요")
    .max(VOCAB_LIMITS.entriesPerBook, "문항 수가 너무 많아요"),
});

function json(body: VocabQuizSubmitResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 유령 bookId 방어 — 존재·렌더 가능 판정은 상세/보강과 **같은 함수**(lib/vocabbook-record.ts).
  const book = await store.getVocabBook(id);
  if (!book || !isRenderableVocabBook(book)) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] },
      400,
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "시험 결과를 저장할 수 없어요.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const { mode, startedAt, finishedAt, items } = parsed.data;

  try {
    // bookId는 URL에서 — 본문 값을 믿지 않는다. 저장 계층이 items의 undefined를 마지막으로 조인다.
    const record = await store.addVocabQuiz({ bookId: id, mode, startedAt, finishedAt, items });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/quiz] 시험 저장 실패:`, err);
    return json(
      { ok: false, error: "save_failed", messageKo: "시험 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

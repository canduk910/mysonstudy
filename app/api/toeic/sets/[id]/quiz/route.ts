/**
 * POST /api/toeic/sets/[id]/quiz — 표현 시험 세션 저장 (docs/harness/toeic.md §6-1·§6-2·§7-3)
 *
 * 시험은 전부 클라이언트에서 진행되고(표현 시험은 AI를 부르지 않는다, §1-1), 이 라우트는 끝(완료)/그만하기 때 결과를 받아
 * 저장한다. **한 요청 = 한 모드** — 혼합 세션은 화면이 모드별로 갈라 모드마다 부른다(§6-2 무오염: speak 통계가 ko-to-expr를
 * 오염시키면 "안다" 판정이 거짓이 된다). setId는 URL에서 — 본문 값을 믿지 않는다. `toeicQuizzes`에 append만(수정·삭제 없음 →
 * prod-guard 없음). AI 없음(키가 없어도 저장된다).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-quiz-contract.ts`):
 * - 200 { ok:true, id }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 404 { ok:false, error:"set_not_found", messageKo }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicQuizSubmitRequest, ToeicQuizSubmitResponse } from "@/lib/toeic-quiz-contract";
import { TOEIC_QUIZ_MODES } from "@/lib/toeic-quiz";
import { isRenderableToeicSet } from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const itemSchema = z.object({
  // 항목 키 — 표현(≤80자) 또는 QUIZ 키(`quiz:{no}`·`quiz:{promptKo}`). 넉넉한 방어선.
  word: z.string().trim().min(1, "항목 키가 비어 있어요").max(320),
  correct: z.boolean(),
  answered: z.boolean().nullable(),
});

const bodySchema = z.object({
  mode: z.enum(TOEIC_QUIZ_MODES),
  startedAt: z.string().datetime({ message: "startedAt이 올바른 시각이 아니에요" }),
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  // 한 모드 세션의 문항 상한 — 세트 표현 상한(60)보다 넉넉한 방어선
  items: z.array(itemSchema).min(1, "저장할 문항이 없어요").max(300, "문항 수가 너무 많아요"),
});

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicQuizSubmitRequest, BodyInput] extends [BodyInput, ToeicQuizSubmitRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicQuizSubmitResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 유령 setId 방어 — 존재·렌더 판정은 상세/시험 페이지와 같은 함수(lib/toeic-record)
  const set = await store.getToeicSet(id);
  if (!set || !isRenderableToeicSet(set)) {
    return json({ ok: false, error: "set_not_found", messageKo: "없거나 열 수 없는 표현집이에요." }, 404);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "시험 결과를 저장할 수 없어요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }
  const { mode, startedAt, finishedAt, items } = parsed.data;

  try {
    const record = await store.addToeicQuiz({ setId: id, mode, startedAt, finishedAt, items });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error(`[/api/toeic/sets/${id}/quiz] 시험 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "시험 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

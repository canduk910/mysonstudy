/**
 * POST /api/japanese/kanji/quiz — 한자 시험 세션 저장 (JK, §12-4) — **AI 없음.**
 *
 * 한자 시험은 전역 한자 풀 대상이라 `bookId`가 없다 — `scope:"kanji"`로 세션을 구분한다(서버가 붙인다).
 * **단어 시험(jaQuizzes)과 별도 컬렉션(jaKanjiQuizzes)**이라 집계가 섞이지 않는다(모드 무오염, §12-4). append만 한다.
 *
 * 응답 shape (단일 정의처는 `lib/japanese-kanji-contract.ts`):
 * - 200 { ok:true, id } / 400 invalid_input / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { JA_KANJI_QUIZ_MODES } from "@/lib/ai/japanese/quiz";
import { JA_WORD_MAX } from "@/lib/ai/japanese/schemas";
import type { JaKanjiQuizSubmitResponse } from "@/lib/japanese-kanji-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const itemSchema = z.object({
  word: z.string().trim().min(1).max(JA_WORD_MAX), // word 자리에 한자 문자
  correct: z.boolean(),
  answered: z.boolean().nullable(),
});

const bodySchema = z.object({
  mode: z.enum(JA_KANJI_QUIZ_MODES),
  startedAt: z.string().datetime({ message: "startedAt이 올바른 시각이 아니에요" }),
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  items: z.array(itemSchema).min(1, "저장할 문항이 없어요").max(600, "문항 수가 너무 많아요"),
});

function json(body: JaKanjiQuizSubmitResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const store = getStore();

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
    const record = await store.addJaKanjiQuiz({ scope: "kanji", mode, startedAt, finishedAt, items });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error("[/api/japanese/kanji/quiz] 한자 시험 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "시험 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

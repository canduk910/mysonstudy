/**
 * POST /api/japanese/dialog/coach — 대화 학습 해설 생성·재생성 (호출 C · §4) — best-effort.
 *
 * 두 모드: 저장된 대화면 `{id}`(재생성 후 그 레코드의 coaching을 갱신), 아직 안 저장한 전사면 `{focusKo,turns}`
 * (생성만 해서 돌려줌 — 검토 화면이 저장으로 넘긴다). **전사가 본체, 해설은 부수 효과**(§7-2) — 실패해도 전사는 남는다.
 *
 * 응답 shape (단일 정의처 `lib/japanese-dialog-contract.ts`):
 * - 200 { ok:true, coaching }
 * - 400 invalid_input / 404 not_found / 501 no_api_key / 500 coach_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { coachJaDialog } from "@/lib/ai/client";
import type { JaDialogTurn } from "@/lib/ai/japanese/schemas";
import type { JaDialogCoachResponse } from "@/lib/japanese-dialog-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const turnSchema = z.object({
  speaker: z.enum(["partner", "me", "unknown"]),
  ja: z.string(),
  tokens: z.array(z.object({ surface: z.string(), reading: z.string().nullable() })),
  feedback: z.object({ kind: z.enum(["praise", "tip"]), textKo: z.string() }).nullable(),
});

const bodySchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ focusKo: z.string().nullable(), turns: z.array(turnSchema).min(1, "전사가 비어 있어요") }),
]);

function json(body: JaDialogCoachResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "해설 요청을 확인해 주세요." }, 400);
  }

  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "해설을 만들려면 OpenAI API 키가 필요해요." }, 501);
  }

  // 저장된 대화(재생성) vs 전사(생성만)를 가른다.
  let focusKo: string | null;
  let turns: JaDialogTurn[];
  let savedId: string | null = null;
  if ("id" in parsed.data) {
    savedId = parsed.data.id;
    const dialog = await store.getJaDialog(savedId);
    if (!dialog) return json({ ok: false, error: "not_found", messageKo: "없는 대화예요." }, 404);
    focusKo = dialog.focusKo;
    turns = dialog.turns;
  } else {
    focusKo = parsed.data.focusKo;
    turns = parsed.data.turns as JaDialogTurn[];
  }

  let coaching;
  try {
    coaching = await coachJaDialog({ focusKo, turns });
  } catch (err) {
    console.error("[/api/japanese/dialog/coach] 해설 생성 실패(비치명):", err);
    return json({ ok: false, error: "coach_failed", messageKo: "해설을 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  // 저장된 대화면 그 자리에서 coaching을 갱신한다(재생성). 전사만 넘어온 경우는 저장하지 않고 돌려준다.
  if (savedId) {
    const updated = await store.updateJaDialogCoaching(savedId, coaching);
    if (!updated) return json({ ok: false, error: "not_found", messageKo: "없는 대화예요." }, 404);
  }
  return json({ ok: true, coaching });
}

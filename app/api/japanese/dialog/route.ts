/**
 * POST /api/japanese/dialog — 대화 복습 저장 (아빠의 일본어 §7-2) — AI 없음.
 *
 * 검토 화면이 확정한 대화를 저장한다. **전사가 본체, 해설은 부수 효과** — 해설 생성이 실패했으면 `coaching:null`로
 * 저장하고 화면에서 "해설 다시 만들기"로 채운다. **사진 원본은 받지도 저장하지도 않는다**(SPEC §1). 저장 계층이 방어 정규화.
 *
 * - 200 { ok:true, id } / 400 invalid_input / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { JaDialogCoaching, JaDialogTurn } from "@/lib/ai/japanese/schemas";
import { JA_DIALOG_TITLE_MAX, type JaDialogSaveResponse } from "@/lib/japanese-dialog-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const turnSchema = z.object({
  speaker: z.enum(["partner", "me", "unknown"]),
  ja: z.string(),
  tokens: z.array(z.object({ surface: z.string(), reading: z.string().nullable() })),
  feedback: z.object({ kind: z.enum(["praise", "tip"]), textKo: z.string() }).nullable(),
});

// 해설 top-level shape만 확인(깊은 검증은 coach 라우트 zod가 이미 함). 저장 계층은 있으면 그대로 굳힌다.
const coachingSchema = z
  .object({
    summaryKo: z.string(),
    goods: z.array(z.unknown()),
    fixes: z.array(z.unknown()),
    items: z.array(z.unknown()),
    practice: z.array(z.unknown()),
  })
  .nullable();

const bodySchema = z.object({
  titleKo: z.string().trim().min(1, "이름을 입력해 주세요").max(JA_DIALOG_TITLE_MAX, `이름은 최대 ${JA_DIALOG_TITLE_MAX}자예요`),
  focusKo: z.string().nullable(),
  turns: z.array(turnSchema).min(1, "저장할 대화가 없어요").max(400, "대화가 너무 길어요"),
  coaching: coachingSchema,
  photoCount: z.number().int().min(0).max(50),
  partial: z.boolean(),
  model: z.string().max(120),
});

function json(body: JaDialogSaveResponse, status = 200) {
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
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "대화를 저장할 수 없어요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { titleKo, focusKo, photoCount, partial, model } = parsed.data;
  // zod가 형태를 검증했고, store의 normalizeJaDialogRecord가 undefined를 마지막으로 조인다(영어 저장 규약).
  const turns = parsed.data.turns as JaDialogTurn[];
  const coaching = parsed.data.coaching as JaDialogCoaching | null;

  try {
    const record = await store.createJaDialog({ titleKo, focusKo, turns, coaching, photoCount, partial, model });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error("[/api/japanese/dialog] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "대화를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

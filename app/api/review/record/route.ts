/**
 * POST /api/review/record — 복습 결과 하나 기록(SPEC §23-3·§23-6). AI 없음(키 검사 없음 — 키가 없어도 복습은 저장된다).
 *
 * 본문 `ReviewRecordRequest` { area, itemKey(`{종류}:{원본 키}`), hintLevel 0~3, judge got|unsure|forgot }.
 * 200 `ReviewRecordResponse` — outcome `applied` | `already_today`(오늘 이미 이 항목을 복습 — 아무것도 바꾸지 않았고 화면은 성공으로 본다)
 * 400 `invalid_input`(+issues — 형식·영역과 항목 키 종류 불일치) · 500 `save_failed`.
 * 판정과 쓰기는 저장소의 원자 단위 안(파일 mutate·Firestore 트랜잭션)에서 순수 함수 decideReview가 한다. 시각은 여기서 한 번만 읽는다.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { ReviewErrorResponse, ReviewRecordRequest, ReviewRecordResponse } from "@/lib/review-contract";
import { REVIEW_AREAS, REVIEW_ITEM_KEY_MAX, REVIEW_JUDGES, isReviewItemKeyOfArea } from "@/lib/review-schedule";
import { recordReview } from "@/lib/review-server";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    area: z.enum(REVIEW_AREAS),
    itemKey: z.string().min(3).max(REVIEW_ITEM_KEY_MAX),
    hintLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    judge: z.enum(REVIEW_JUDGES),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!isReviewItemKeyOfArea(v.itemKey, v.area)) ctx.addIssue({ code: "custom", path: ["itemKey"], message: "이 영역의 항목 키가 아니에요" });
  });

type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [ReviewRecordRequest, BodyInput] extends [BodyInput, ReviewRecordRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ReviewRecordResponse | ReviewErrorResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 형식이 올바르지 않아요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "복습 결과 형식이 올바르지 않아요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { area, itemKey, hintLevel, judge } = parsed.data;
  try {
    const { decision, intervalDays } = await recordReview(area, itemKey, { hintLevel, judge });
    const r = decision.record;
    return json({ ok: true, outcome: decision.kind, judge: r.lastJudge ?? judge, step: r.step, dueOn: r.dueOn, intervalDays });
  } catch (err) {
    console.error("[review] 결과를 저장하지 못했다", err);
    return json({ ok: false, error: "save_failed", messageKo: "복습 결과를 저장하지 못했어요. 다시 눌러 주세요." }, 500);
  }
}

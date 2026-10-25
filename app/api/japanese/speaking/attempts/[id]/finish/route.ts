/**
 * POST /api/japanese/speaking/attempts/[id]/finish — 끝/그만두기, **한 번만** (docs/harness/japanese.md §15-9-3)
 *
 * 토익 §7-5 규칙 그대로: 범위의 모든 문항을 채운다(녹음 안 된 문항은 recorded:false — completeFinishAnswers), 이미 닫힌 응시는 409
 * already_finished(화면은 성공으로 본다 — pagehide sendBeacon·재시도·다른 탭). 판정과 쓰기는 한 원자 단위(store.finishJaSpeakingAttempt).
 * 본문 형식·범위 검사는 토익 끝내기 본문과 같은 함수(toeicFinishBodySchema·finishAnswerIssues — 응시 화면이 같은 본문을 보낸다).
 * 진단(diag)은 받기만 하고 저장하지 않는다(토익 §15-11 전용).
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingAttemptFinishResponse):
 * 200 { ok:true, id, finishedAt, recordedCount, answers } · 400 invalid_input(+issues) · 404 attempt_not_found ·
 * 409 { ok:false, error:"already_finished", messageKo, recordedCount } · 500 save_failed
 */

import { NextResponse } from "next/server";
import type { z } from "zod";
import type { JaSpeakingAttemptFinishRequest, JaSpeakingAttemptFinishResponse } from "@/lib/ja-speaking-contract";
import { isJaSpeakingAttemptClosed } from "@/lib/ja-speaking-record";
import { getStore } from "@/lib/store";
import { completeFinishAnswers, recordedToeicCount } from "@/lib/toeic-attempt-rules";
import { finishAnswerIssues, toeicFinishBodySchema } from "@/lib/toeic-finish-body";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = toeicFinishBodySchema;
// 요청 계약 ⊇ 본문(진단 자리는 화면이 실어 보낸다 — 받기만 한다)
type BodyOutput = z.output<typeof bodySchema>;
const requestCovers: BodyOutput extends JaSpeakingAttemptFinishRequest ? true : never = true;
void requestCovers;

function json(body: JaSpeakingAttemptFinishResponse, status = 200) {
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
    return json({ ok: false, error: "invalid_input", messageKo: "응시 결과 형식이 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }
  const store = getStore();
  const attempt = await store.getJaSpeakingAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  if (isJaSpeakingAttemptClosed(attempt)) {
    return json({ ok: false, error: "already_finished", messageKo: "이미 저장된 응시예요.", recordedCount: recordedToeicCount(attempt.answers) }, 409);
  }
  const qs = attempt.questions;
  const issues = finishAnswerIssues(qs, parsed.data.answers);
  if (issues.length > 0) return json({ ok: false, error: "invalid_input", messageKo: "응시 결과에 맞지 않는 문항이 있어요.", issues }, 400);

  try {
    const answers = completeFinishAnswers(qs, parsed.data.answers);
    const result = await store.finishJaSpeakingAttempt(id, { finishedAt: parsed.data.finishedAt, answers });
    if (!result) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
    if (result.outcome === "already_closed") {
      return json({ ok: false, error: "already_finished", messageKo: "이미 저장된 응시예요.", recordedCount: recordedToeicCount(result.record.answers) }, 409);
    }
    const rec = result.record;
    return json({ ok: true, id: rec.id, finishedAt: rec.finishedAt, recordedCount: recordedToeicCount(rec.answers), answers: rec.answers });
  } catch (err) {
    console.error(`[/api/japanese/speaking/attempts/${id}/finish] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "응시 결과를 저장하지 못했어요. 다시 저장해 주세요." }, 500);
  }
}

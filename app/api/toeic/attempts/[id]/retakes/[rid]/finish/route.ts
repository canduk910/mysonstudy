/**
 * POST /api/toeic/attempts/[id]/retakes/[rid]/finish — 다시 풀기 **끝·합치기** (docs/harness/toeic.md §15-5, SPEC §20-13)
 *
 * 본문은 응시 끝내기와 같은 모양 `{finishedAt, answers:[{q, recorded, durationMs, diag?}]}`(zod·검사 한 벌 — lib/toeic-finish-body). 범위는 그
 * 다시 풀기의 문항. **녹음된 문항만** 원래 응시 결과에 합친다(applyToeicRetakeFinish — 지금 답·녹음 메타·고칠 문장 녹음·진단을 이력 한 줄로 옮기고
 * 그 자리를 새 답(채점 전)으로). 녹음이 없는 문항은 원래 답 그대로. answers 길이·finishedAt은 바꾸지 않는다(닫힘 판정·끝내기 409 불변).
 * **한 번만** — 이미 닫힌 다시 풀기는 409 already_finished(+ merged·recordedCount — 저장 실패가 아니라 "이미 닫혔다"라 화면은 오류로 멈추지 않는다,
 * 비콘·재시도·다른 탭). 다만 409는 이 기기 녹음이 합쳐졌다는 뜻이 아니다 — 끝 화면 문구는 응답(200·409)의 merged로 정한다(§15-5, toeicRetakeFinishOutcome). 판정·합치기는 스토어 원자 단위 안에서.
 *
 * AI를 부르지 않는다(키 검사 없음). 응답 shape(단일 정의처 ToeicRetakeFinishResponse):
 * - 200 { ok:true, retakeId, merged, recordedCount, answers }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"attempt_not_found"|"retake_not_found", messageKo }
 * - 409 { ok:false, error:"already_finished", messageKo, merged, recordedCount }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import type { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicRetakeFinishRequest, ToeicRetakeFinishResponse } from "@/lib/toeic-attempt-contract";
import { finishAnswerIssues, finishBodyDiags, toeicFinishBodySchema } from "@/lib/toeic-finish-body";
import { isToeicRecAttemptId } from "@/lib/toeic-rec-rules";
import { isToeicRetakeId } from "@/lib/toeic-retake";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

type BodyInput = z.input<typeof toeicFinishBodySchema>;
const requestMatchesSchema: [ToeicRetakeFinishRequest, BodyInput] extends [BodyInput, ToeicRetakeFinishRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicRetakeFinishResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const { id, rid } = await params;
  if (!isToeicRecAttemptId(id)) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  if (!isToeicRetakeId(rid)) return json({ ok: false, error: "retake_not_found", messageKo: "다시 풀기 기록을 찾을 수 없어요." }, 404);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = toeicFinishBodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "다시 풀기 결과 형식이 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }

  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  const session = attempt.retakes.find((r) => r.id === rid);
  if (!session) return json({ ok: false, error: "retake_not_found", messageKo: "다시 풀기 기록을 찾을 수 없어요." }, 404);
  const recordedCount = (merged: readonly number[]) => merged.length;
  if (session.closedAt !== null) {
    return json({ ok: false, error: "already_finished", messageKo: "이미 저장된 다시 풀기예요.", merged: session.merged, recordedCount: recordedCount(session.merged) }, 409);
  }
  const issues = finishAnswerIssues(session.questions, parsed.data.answers);
  if (issues.length > 0) {
    return json({ ok: false, error: "invalid_input", messageKo: "다시 풀기 결과에 맞지 않는 문항이 있어요.", issues }, 400);
  }

  try {
    const res = await store.finishToeicRetake(id, rid, {
      finishedAt: parsed.data.finishedAt,
      answers: parsed.data.answers.map((a) => ({ q: a.q, recorded: a.recorded, durationMs: a.durationMs })),
      diags: finishBodyDiags(parsed.data.answers),
      nowIso: new Date().toISOString(),
    });
    if (!res) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
    if (res.outcome === "retake_not_found") return json({ ok: false, error: "retake_not_found", messageKo: "다시 풀기 기록을 찾을 수 없어요." }, 404);
    if (res.outcome === "already_closed") {
      return json({ ok: false, error: "already_finished", messageKo: "이미 저장된 다시 풀기예요.", merged: res.merged, recordedCount: recordedCount(res.merged) }, 409);
    }
    console.log(`[toeic-retake] FINISH attempt=${id} retake=${rid} merged=${res.merged.join(",") || "-"}`);
    return json({ ok: true, retakeId: rid, merged: res.merged, recordedCount: recordedCount(res.merged), answers: res.record.answers });
  } catch (err) {
    console.error(`[/api/toeic/attempts/${id}/retakes/${rid}/finish] 저장 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "다시 풀기 결과를 저장하지 못했어요. 다시 저장해 주세요." }, 500);
  }
}

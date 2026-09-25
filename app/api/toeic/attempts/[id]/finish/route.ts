/**
 * POST /api/toeic/attempts/[id]/finish — 모의고사 응시 끝/그만두기 (docs/harness/toeic.md §6-4·§7-5, 로드맵 T4)
 *
 * 본문 `{finishedAt: ISO | null, answers: [{q, recorded, durationMs}]}` → 응시 기록에 문항별 녹음 여부·길이를 채운다.
 * 녹음 자체는 기기(IndexedDB)에만 있다 — 서버에는 녹음 여부·길이만(§0-2 "녹음은 기기에만").
 * - finishedAt: 끝까지 마쳤으면 시각, 중간에 그만뒀으면 null(§7-5).
 * - answers: 응시 범위의 문항만(범위 밖·중복 q는 400). 보내지 않은 문항은 서버가 recorded:false로 채운다
 *   (completeFinishAnswers — "닫힌 응시" 판정의 근거, lib/toeic-attempt-rules 머리 주석).
 * - durationMs: recorded면 필수(0 초과 ~ 답변 시간 + 여유), 아니면 null 또는 그 범위.
 *
 * ── 한 번만 받는다(스펙 공백 — 여기서 정한다) ──────────────────────────────────
 * 이미 닫힌 응시에 다시 오면 **409 already_finished**로 거절하고 아무것도 쓰지 않는다(판정은 스토어 원자 단위 안 —
 * decideAttemptFinish). 네트워크 재시도·연타·다른 탭의 늦은 요청이 "끝까지"를 "중단"으로 바꾸거나 채점된 문항의 recorded를
 * 뒤집지 못하게 하려는 것이다. 화면은 409 already_finished를 **성공으로** 본다(첫 요청이 이미 저장됐다 — recordedCount 동봉).
 *
 * AI를 부르지 않는다(키 검사 없음).
 *
 * 응답 shape (단일 정의처 `lib/toeic-attempt-contract.ts` ToeicAttemptFinishResponse):
 * - 200 { ok:true, id, finishedAt, recordedCount, answers }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"attempt_not_found", messageKo }
 * - 409 { ok:false, error:"already_finished", messageKo, recordedCount }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicAttemptFinishRequest, ToeicAttemptFinishResponse } from "@/lib/toeic-attempt-contract";
import {
  completeFinishAnswers,
  decideAttemptFinish,
  maxToeicRecordingMs,
  recordedToeicCount,
  toeicAttemptQuestions,
} from "@/lib/toeic-attempt-rules";
import { TOEIC_QUESTION_COUNT } from "@/lib/toeic-mock";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  answers: z
    .array(
      z.object({
        q: z.number().int().min(1).max(TOEIC_QUESTION_COUNT),
        recorded: z.boolean(),
        durationMs: z.number().int().min(0).nullable(),
      }),
    )
    .max(TOEIC_QUESTION_COUNT),
});

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicAttemptFinishRequest, BodyInput] extends [BodyInput, ToeicAttemptFinishRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicAttemptFinishResponse, status = 200) {
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
    return json(
      { ok: false, error: "invalid_input", messageKo: "응시 결과 형식이 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) },
      400,
    );
  }

  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);

  // 이미 닫힌 응시 — 입력 검사보다 먼저 알린다(재시도가 같은 본문이면 어차피 같은 결론)
  if (decideAttemptFinish(attempt) === "already_closed") {
    return json(
      { ok: false, error: "already_finished", messageKo: "이미 저장된 응시예요.", recordedCount: recordedToeicCount(attempt.answers) },
      409,
    );
  }

  // 응시 범위·중복·길이 검사(범위는 레코드의 parts에서 — 형식표 단일 정의)
  const qs = toeicAttemptQuestions(attempt.parts);
  const allowed = new Set(qs);
  const seen = new Set<number>();
  const issues: { path: string; message: string }[] = [];
  parsed.data.answers.forEach((a, i) => {
    if (!allowed.has(a.q)) issues.push({ path: `answers.${i}.q`, message: "이 응시 범위에 없는 문항이에요" });
    else if (seen.has(a.q)) issues.push({ path: `answers.${i}.q`, message: "같은 문항이 두 번 있어요" });
    seen.add(a.q);
    if (allowed.has(a.q) && a.durationMs !== null && a.durationMs > maxToeicRecordingMs(a.q)) {
      issues.push({ path: `answers.${i}.durationMs`, message: "녹음 길이가 답변 시간보다 너무 길어요" });
    }
    if (a.recorded && (a.durationMs === null || a.durationMs <= 0)) {
      issues.push({ path: `answers.${i}.durationMs`, message: "녹음된 문항은 길이가 있어야 해요" });
    }
  });
  if (issues.length > 0) {
    return json({ ok: false, error: "invalid_input", messageKo: "응시 결과에 맞지 않는 문항이 있어요.", issues: issues.slice(0, 10) }, 400);
  }

  try {
    const answers = completeFinishAnswers(qs, parsed.data.answers);
    const result = await store.finishToeicAttempt(id, { finishedAt: parsed.data.finishedAt, answers });
    if (!result) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
    if (result.outcome === "already_closed") {
      return json(
        { ok: false, error: "already_finished", messageKo: "이미 저장된 응시예요.", recordedCount: recordedToeicCount(result.record.answers) },
        409,
      );
    }
    const rec = result.record;
    return json({ ok: true, id: rec.id, finishedAt: rec.finishedAt, recordedCount: recordedToeicCount(rec.answers), answers: rec.answers });
  } catch (err) {
    console.error(`[/api/toeic/attempts/${id}/finish] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "응시 결과를 저장하지 못했어요. 다시 저장해 주세요." }, 500);
  }
}

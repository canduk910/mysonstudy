/**
 * POST /api/toeic/attempts/[id]/retakes — 모의고사 **문항 단위 다시 풀기** 시작 (docs/harness/toeic.md §15-2, SPEC §20-13)
 *
 * 본문 `{ questions: number[], replaceOpen?: string | null }` → 진행 중 다시 풀기 기록 하나를 만든다(녹음 IndexedDB 키는 원래 응시 id 그대로,
 * 업로드는 이 다시 풀기 id를 `retakeId`로 싣는다 — §15-4). 판정은 순수 함수 decideToeicRetakeStart를 **스토어 원자 단위 안에서**(파일 mutate ·
 * Firestore runTransaction) — 동시 두 시작(다른 탭·기기)이 겹쳐도 진행 중 기록은 하나다. 오래됐거나(2시간) replaceOpen으로 고른 진행 중 기록은
 * 먼저 닫는다(합치기 규칙 그대로 — 대기 자리 녹음이 있는 문항만 합친다).
 *
 * AI를 부르지 않는다(키 검사 없음). 응답 shape(단일 정의처 `lib/toeic-attempt-contract.ts` ToeicRetakeStartResponse):
 * - 200 { ok:true, retakeId, questions, startedAt }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }              ← 문항 없음·중복·정수 아님·replaceOpen 모양
 * - 404 { ok:false, error:"attempt_not_found"|"question_not_found", messageKo }
 * - 409 { ok:false, error:"not_finished", messageKo }                        ← 아직 닫히지 않은 응시
 * - 409 { ok:false, error:"retake_in_progress", messageKo, openRetake }      ← 다른 곳에서 진행 중(그 다시 풀기를 닫고 새로 시작 = replaceOpen)
 * - 409 { ok:false, error:"history_full", messageKo, questions }             ← 그 문항 이력이 10줄
 * - 500 { ok:false, error:"save_failed", messageKo, retriable:true }
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicRetakeStartRequest, ToeicRetakeStartResponse } from "@/lib/toeic-attempt-contract";
import { TOEIC_QUESTION_COUNT } from "@/lib/toeic-mock";
import { isToeicRecAttemptId } from "@/lib/toeic-rec-rules";
import { TOEIC_RETAKE_HISTORY_MAX, TOEIC_RETAKE_ID_RE } from "@/lib/toeic-retake";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  questions: z.array(z.number().int().min(1).max(TOEIC_QUESTION_COUNT)).min(1).max(TOEIC_QUESTION_COUNT),
  replaceOpen: z.string().regex(TOEIC_RETAKE_ID_RE).nullable().optional(),
});

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicRetakeStartRequest, BodyInput] extends [BodyInput, ToeicRetakeStartRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicRetakeStartResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

const NOT_FOUND_ATTEMPT = "응시 기록을 찾을 수 없어요.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isToeicRecAttemptId(id)) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "다시 풀 문항이 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }
  const questions = parsed.data.questions;
  if (new Set(questions).size !== questions.length) {
    return json({ ok: false, error: "invalid_input", messageKo: "같은 문항이 두 번 있어요." }, 400);
  }

  const store = getStore();
  try {
    const res = await store.startToeicRetake(id, {
      questions: [...questions].sort((a, b) => a - b),
      replaceOpen: parsed.data.replaceOpen ?? null,
      newId: randomUUID(),
      nowIso: new Date().toISOString(),
    });
    if (!res) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_ATTEMPT }, 404);
    if (res.outcome === "started") {
      console.log(`[toeic-retake] START attempt=${id} retake=${res.session.id} q=${res.session.questions.join(",")}`);
      return json({ ok: true, retakeId: res.session.id, questions: res.session.questions, startedAt: res.session.startedAt });
    }
    const d = res.decision;
    switch (d.kind) {
      case "invalid":
        return json({ ok: false, error: "invalid_input", messageKo: "다시 풀 문항이 올바르지 않아요." }, 400);
      case "question_not_found":
        return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 ${d.questions.map((q) => `Q${q}`).join("·")}가 없어요.` }, 404);
      case "not_finished":
        return json({ ok: false, error: "not_finished", messageKo: "아직 끝나지 않은 응시예요 — 응시를 마친 뒤 문항을 다시 풀 수 있어요." }, 409);
      case "in_progress":
        return json(
          {
            ok: false,
            error: "retake_in_progress",
            messageKo: `다른 곳에서 ${d.open.questions.map((q) => `Q${q}`).join("·")} 다시 풀기가 진행 중이에요.`,
            openRetake: d.open,
          },
          409,
        );
      case "history_full":
        return json(
          {
            ok: false,
            error: "history_full",
            messageKo: `${d.questions.map((q) => `Q${q}`).join("·")}는 다시 풀기 기록이 ${TOEIC_RETAKE_HISTORY_MAX}개라 더 다시 풀 수 없어요 — 새 응시로 풀어 주세요.`,
            questions: d.questions,
          },
          409,
        );
    }
  } catch (err) {
    console.error(`[/api/toeic/attempts/${id}/retakes] 저장 실패:`, err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "다시 풀기를 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.", retriable: true }, 500);
  }
}

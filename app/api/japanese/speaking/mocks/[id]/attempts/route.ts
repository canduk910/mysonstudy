/**
 * POST /api/japanese/speaking/mocks/[id]/attempts — 응시 시작(범위 판정) (docs/harness/japanese.md §15-9-3·§15-10-1)
 *
 * 범위 판정은 토익 순수 함수 `decideAttemptScope` 그대로(형식표 공유 — 실전은 다섯 파트 + 완전한 세트, 유형 연습은 파트 하나 + 그 파트가 있다).
 * 시작에 레코드를 만든다(녹음 IndexedDB 키 `{attemptId}:{q}`에 id가 필요 — 토익 §7-5). answers는 빈 배열로 시작한다(닫힘 판정 규칙).
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingAttemptCreateResponse):
 * 200 { ok:true, attemptId, scope, parts, questions, startedAt } · 400 invalid_input · 404 mock_not_found · 409 incomplete_mock·part_missing · 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { JA_SPEAKING_PARTS } from "@/lib/ja-speaking";
import type { JaSpeakingAttemptCreateRequest, JaSpeakingAttemptCreateResponse } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";
import { decideAttemptScope } from "@/lib/toeic-attempt-rules";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  scope: z.enum(["full", "part"]),
  parts: z.array(z.enum(JA_SPEAKING_PARTS)).min(1).max(JA_SPEAKING_PARTS.length),
});
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [JaSpeakingAttemptCreateRequest, BodyInput] extends [BodyInput, JaSpeakingAttemptCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: JaSpeakingAttemptCreateResponse, status = 200) {
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
    return json({ ok: false, error: "invalid_input", messageKo: "응시 범위(scope·parts)가 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }
  const store = getStore();
  const mock = await store.getJaSpeakingMock(id);
  if (!mock || !isRenderableJaSpeakingMock(mock)) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);

  const scope = decideAttemptScope(parsed.data.scope, parsed.data.parts, mock.parts);
  if (!scope.ok) {
    if (scope.reason === "scope_parts_mismatch") {
      return json(
        { ok: false, error: "invalid_input", messageKo: parsed.data.scope === "full" ? "실전 응시는 다섯 파트를 모두 보내야 해요." : "유형 연습은 파트 하나만 보내야 해요(중복 없이)." },
        400,
      );
    }
    return json(
      scope.reason === "incomplete_mock"
        ? { ok: false, error: "incomplete_mock", messageKo: "빠진 파트가 있어 실전 응시를 할 수 없어요 — 학습 보기에서 파트를 먼저 만들어 주세요." }
        : { ok: false, error: "part_missing", messageKo: "이 모의고사에는 그 파트가 아직 없어요." },
      409,
    );
  }
  try {
    const record = await store.createJaSpeakingAttempt({
      mockId: id,
      scope: parsed.data.scope,
      parts: scope.parts,
      questions: scope.questions,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      answers: [],
    });
    return json({ ok: true, attemptId: record.id, scope: record.scope, parts: record.parts, questions: record.questions, startedAt: record.startedAt });
  } catch (err) {
    console.error(`[/api/japanese/speaking/mocks/${id}/attempts] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "응시 기록을 만들지 못했어요. 잠시 뒤 다시 시작해 주세요." }, 500);
  }
}

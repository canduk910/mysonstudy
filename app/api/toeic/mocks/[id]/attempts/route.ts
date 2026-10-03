/**
 * POST /api/toeic/mocks/[id]/attempts — 모의고사 응시 시작 (docs/harness/toeic.md §6-4·§7-5, 로드맵 T4)
 *
 * 본문 `{scope:"full"|"part", parts}` → 응시 기록을 **시작에 만든다**(녹음 IndexedDB 키 `{attemptId}:{q}`에 id가 필요하다).
 * answers는 빈 배열로 시작한다 — 끝/그만두기(finish)가 응시 범위의 모든 문항을 채운다(lib/toeic-attempt-rules "닫힌 응시").
 * AI를 부르지 않는다(키 검사 없음 — 키가 없어도 응시·녹음은 된다).
 *
 * 범위 규칙(lib/toeic-attempt-rules decideAttemptScope — 화면 링크 toeicTakeHref와 같은 규칙):
 * - full: parts = 다섯 파트 전부(순서 무관, 형식표 순서로 저장) + 모의고사가 완전해야 한다(빠진 파트가 있으면 409 incomplete_mock)
 * - part: 파트 하나 + 그 파트가 있어야 한다(없으면 409 part_missing)
 * - 한 문제 연습(문서의 drillPart — docs/harness/toeic.md §12-7-4): scope "part" + parts [drillPart]만(아니면 400 invalid_input
 *   "공략 연습은 그 유형 하나로만 응시해요."). 응시 범위 문항(`questions`)은 **서버가 연습 단위표에서** 정한다(사진 묘사는 [3]) —
 *   요청 본문은 그대로이고 클라이언트가 문항 부분집합을 고를 길은 없다. 응시 기록에 questions를 적는다(끝내기·채점 범위의 원천).
 *
 * 응답 shape (단일 정의처 `lib/toeic-attempt-contract.ts` ToeicAttemptCreateResponse):
 * - 200 { ok:true, attemptId, scope, parts, questions, startedAt }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"mock_not_found", messageKo }
 * - 409 { ok:false, error:"incomplete_mock" | "part_missing", messageKo }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicAttemptCreateRequest, ToeicAttemptCreateResponse } from "@/lib/toeic-attempt-contract";
import { decideAttemptScope } from "@/lib/toeic-attempt-rules";
import { TOEIC_MOCK_PARTS } from "@/lib/toeic-mock";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  scope: z.enum(["full", "part"]),
  parts: z.array(z.enum(TOEIC_MOCK_PARTS)).min(1).max(TOEIC_MOCK_PARTS.length),
});

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicAttemptCreateRequest, BodyInput] extends [BodyInput, ToeicAttemptCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicAttemptCreateResponse, status = 200) {
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
      { ok: false, error: "invalid_input", messageKo: "응시 범위(scope·parts)가 올바르지 않아요.", issues: toToeicIssues(parsed.error.issues, 10) },
      400,
    );
  }

  const store = getStore();
  const mock = await store.getToeicMock(id);
  if (!mock || !isRenderableToeicMock(mock)) {
    return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
  }

  const scope = decideAttemptScope(parsed.data.scope, parsed.data.parts, mock.parts, mock.drillPart);
  if (!scope.ok) {
    if (scope.reason === "scope_parts_mismatch") {
      return json(
        {
          ok: false,
          error: "invalid_input",
          // 연습에는 "실전 응시는 다섯 파트를…" 문구를 내지 않는다(§12-7-4)
          messageKo:
            mock.drillPart !== null
              ? "공략 연습은 그 유형 하나로만 응시해요."
              : parsed.data.scope === "full"
                ? "실전 응시는 다섯 파트를 모두 보내야 해요."
                : "유형 연습은 파트 하나만 보내야 해요(중복 없이).",
        },
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
    const startedAt = new Date().toISOString();
    const record = await store.createToeicAttempt({
      mockId: id,
      scope: parsed.data.scope,
      parts: scope.parts,
      questions: scope.questions,
      startedAt,
      finishedAt: null,
      answers: [],
      recordings: [], // 내 녹음 서버 보관 메타(§13-5) — 문항 녹음 업로드가 채운다(answers 밖)
      fixRecordings: [], // 고칠 문장 다시 녹음 메타(§14-2) — 결과 화면이 채운다
      recordingDeletions: [], // 지운 자리(§14-3)
      retakes: [], // 문항 단위 다시 풀기 기록(§15-1)
      answerHistory: [], // 다시 풀기로 밀려난 예전 답(§15-1)
      answerDiags: [], // 문항별 진단(§15-11) — 끝내기가 채운다
    });
    return json({
      ok: true,
      attemptId: record.id,
      scope: record.scope,
      parts: record.parts,
      questions: record.questions,
      startedAt: record.startedAt,
    });
  } catch (err) {
    console.error(`[/api/toeic/mocks/${id}/attempts] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "응시 기록을 만들지 못했어요. 잠시 뒤 다시 시작해 주세요." }, 500);
  }
}

/**
 * POST /api/workout/undo — 마지막 기록 취소 (SPEC §19-3·§19-5) — AI 없음(OPENAI_API_KEY 무관).
 *
 * 활성 사이클의 마지막 사건 1개를 뺀다(rev+1). 사건 **개수**가 아니라 `expectedRev`로 대조한다 — 다른 탭에서
 * "취소 후 다시 기록"하면 개수는 같아져 낡은 탭의 취소가 엉뚱한 사건을 지운다(ABA). 가족 기록을 되돌릴 수 없게
 * 바꾸는 작업이라 **prod-guard 대상**이다(개발 환경 Firestore에서 막힌다 — 스토어가 판정).
 *
 * - 200 { ok:true, cycleId, rev }
 * - 400 invalid_input / 404 not_found / 409 conflict·not_active·empty / 403 prod_guard / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";
import type { WorkoutUndoRequest, WorkoutUndoResponse } from "@/lib/workout-contract";

export const runtime = "nodejs";

const bodySchema = z.object({
  // 문서 id로 그대로 쓰인다(Firestore doc 경로) — "/"가 섞이면 다른 경로를 가리키므로 입력에서 막는다.
  cycleId: z
    .string()
    .min(1)
    .max(128)
    .refine((s) => !s.includes("/"), "사이클 id 형식이 아니에요"),
  expectedRev: z.number().int().min(0).max(1_000_000),
});

// 요청 계약(WorkoutUndoRequest, lib/workout-contract.ts)과 이 zod 스키마가 갈리면 tsc가 잡는다 — 양방향 대입 검사.
// 화면은 계약 타입으로 보내고 라우트는 zod로 받는다. 한쪽만 필드명을 바꾸면 런타임 400이 되므로 컴파일 때 묶어 둔다.
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [WorkoutUndoRequest, BodyInput] extends [BodyInput, WorkoutUndoRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: WorkoutUndoResponse, status = 200) {
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
        messageKo: "기록을 취소할 수 없어요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { cycleId, expectedRev } = parsed.data;

  try {
    const result = await store.undoWorkoutEvent(cycleId, { expectedRev });
    switch (result.status) {
      case "ok":
        return json({ ok: true, cycleId: result.record.id, rev: result.record.rev });
      case "not_found":
        return json({ ok: false, error: "not_found", messageKo: "운동 사이클을 찾을 수 없어요. 최신 상태로 새로 고칠게요." }, 404);
      case "conflict":
      // "stale_state"는 기록 전용 상태라 취소에선 나오지 않는다 — 오면 화면이 낡은 것으로 보고 같은 conflict로 알린다.
      case "stale_state":
        return json(
          {
            ok: false,
            error: "conflict",
            messageKo: "다른 화면에서 이미 기록이 바뀌어 취소하지 않았어요. 최신 상태로 새로 고칠게요.",
          },
          409,
        );
      case "not_active":
        return json({ ok: false, error: "not_active", messageKo: "이미 끝난 사이클이라 취소할 수 없어요." }, 409);
      case "empty":
        return json({ ok: false, error: "empty", messageKo: "취소할 기록이 없어요." }, 409);
    }
  } catch (err) {
    // 개발 환경에서 프로덕션 실데이터(운동 기록)를 빼려 한 경우 (lib/prod-guard.ts)
    if (isProdGuardError(err)) {
      console.error(err.message);
      return json(
        {
          ok: false,
          error: "prod_guard",
          messageKo: "개발 환경이라 실제 데이터를 지우지 않았어요. 로컬 테스트는 STORE_BACKEND=file 로 돌려 주세요.",
        },
        403,
      );
    }
    console.error("[/api/workout/undo] 취소 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "기록을 취소하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

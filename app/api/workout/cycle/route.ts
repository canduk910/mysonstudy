/**
 * POST /api/workout/cycle — 아빠의 운동 사이클 시작·재측정 (SPEC §19-3·§19-5) — AI 없음(OPENAI_API_KEY 무관).
 *
 * 처음 시작·재측정(Day 27)·도중 재측정 공용. 화면이 본 활성 사이클 id(`expectedActiveCycleId`, 없으면 null)를 서버의
 * 활성과 대조해 연타·두 탭에서 두 번 만들어지지 않게 한다. 활성 사건 0개면 닫지 않고 제자리 교체(replaced — cycleNo 유지),
 * 아니면 `closingStatus`로 닫고 새 사이클(created — cycleNo = 전체 max+1). 판정·쓰기는 스토어가 한 원자 단위로 한다.
 *
 * - 200 { ok:true, cycleId, cycleNo, mode, closed }
 * - 400 invalid_input / 409 conflict(활성 id 불일치) / 403 prod_guard(개발 환경 Firestore에서 사건 있는 활성을 닫으려 할 때)
 *   / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { kstTodayString, shiftDateString } from "@/lib/kst";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";
import { RM_MAX, RM_MIN } from "@/lib/workout";
import type { WorkoutCycleRequest, WorkoutCycleResponse } from "@/lib/workout-contract";

export const runtime = "nodejs";

// RM은 정수 1~150(§19-1) — 경계값은 엔진 상수(설정 화면 미리보기와 같은 값).
const rm = z
  .number()
  .int("RM은 정수로 입력해 주세요")
  .min(RM_MIN, `${RM_MIN}회 이상이어야 해요`)
  .max(RM_MAX, `${RM_MAX}회 이하로 입력해 주세요`);

const bodySchema = z.object({
  pullupRm: rm,
  pushupRm: rm,
  start: z.enum(["today", "tomorrow"]),
  expectedActiveCycleId: z.string().min(1).max(128).nullable(),
});

// 요청 계약(WorkoutCycleRequest, lib/workout-contract.ts)과 이 zod 스키마가 갈리면 tsc가 잡는다 — 양방향 대입 검사.
// 화면은 계약 타입으로 보내고 라우트는 zod로 받는다. 한쪽만 필드명을 바꾸면 런타임 400이 되므로 컴파일 때 묶어 둔다.
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [WorkoutCycleRequest, BodyInput] extends [BodyInput, WorkoutCycleRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: WorkoutCycleResponse, status = 200) {
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
        messageKo: "RM을 다시 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { pullupRm, pushupRm, start, expectedActiveCycleId } = parsed.data;

  // "오늘"은 서버에서 한 번만 계산한다(Cloud Run은 UTC → lib/kst). 같은 순간에서 두 값을 뽑아 자정 경계에서도
  // 어긋나지 않게 하고, 트랜잭션이 재시도돼도 같은 값이 쓰이게 스토어에 그대로 넘긴다(§19-4).
  const now = new Date();
  const nowIso = now.toISOString();
  const todayKst = kstTodayString(now);
  const startDate = start === "today" ? todayKst : shiftDateString(todayKst, 1);

  try {
    const result = await store.startWorkoutCycle({
      rm: { pullup: pullupRm, pushup: pushupRm },
      startDate,
      expectedActiveCycleId,
      todayKst,
      nowIso,
    });
    if (result.status === "conflict") {
      return json(
        { ok: false, error: "conflict", messageKo: "다른 화면에서 이미 사이클이 바뀌었어요. 최신 상태로 새로 고칠게요." },
        409,
      );
    }
    const { record, mode, closed } = result;
    return json({ ok: true, cycleId: record.id, cycleNo: record.cycleNo, mode, closed });
  } catch (err) {
    // 개발 환경에서 프로덕션 실데이터(사건 있는 활성 사이클)를 닫으려 한 경우 (lib/prod-guard.ts)
    if (isProdGuardError(err)) {
      console.error(err.message);
      return json(
        {
          ok: false,
          error: "prod_guard",
          messageKo: "개발 환경이라 실제 운동 기록을 닫지 않았어요. 로컬 테스트는 STORE_BACKEND=file 로 돌려 주세요.",
        },
        403,
      );
    }
    console.error("[/api/workout/cycle] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "사이클을 시작하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

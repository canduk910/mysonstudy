/**
 * POST /api/workout/log — 오늘 운동 기록(완료·실패) (SPEC §19-2·§19-5) — AI 없음(OPENAI_API_KEY 무관).
 *
 * 서버가 오늘 상태를 **다시 계산해 대조한 뒤** 사건을 append한다. 요청의 `day`·`targetDay`는 "화면이 낡지 않았다"를
 * 확인하는 데만 쓰고, 사건의 day·targetDay·date·at·reps는 서버 계산값이다(클라이언트 숫자를 믿지 않는다).
 * 예외는 `durationSec`(§19-8 실측 소요시간) — 서버가 알 수 없는 클라이언트 보고값이라 형식(정수·0 이상)만 zod가 보고,
 * 상한(WORKOUT_DURATION_MAX_SEC) 초과는 엔진 decideLog가 기록은 받되 소요시간만 null로 싣는다(400으로 기록을 잃지 않게).
 * `expectedRev`로 다른 탭·연타를 가른다. 판정·쓰기는 스토어가 한 원자 단위로 한다. 기록(append)은 prod-guard 대상이 아니다.
 *
 * - 200 { ok:true, cycleId, rev, event } — event.durationSec = 보낸 값(범위 밖이면 null)
 * - 400 invalid_input / 404 not_found / 409 conflict·stale_state·not_active / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { kstTodayString } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { isWorkoutDay, LAST_WORKOUT_DAY, SETS_PER_EXERCISE } from "@/lib/workout";
import type { WorkoutLogRequest, WorkoutLogResponse } from "@/lib/workout-contract";

export const runtime = "nodejs";

// 문서 id로 그대로 쓰인다(Firestore doc 경로) — "/"가 섞이면 다른 경로를 가리키므로 입력에서 막는다.
const cycleId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !s.includes("/"), "사이클 id 형식이 아니에요");
// 운동일(1~23 중 휴식일 제외)만 — 휴식·재측정 날엔 기록 버튼이 없다(§19-2).
const workoutDay = z.number().int().min(1).max(LAST_WORKOUT_DAY).refine(isWorkoutDay, "운동일이 아니에요");
const common = {
  cycleId,
  expectedRev: z.number().int().min(0).max(1_000_000),
  day: workoutDay,
  targetDay: workoutDay,
  // 실측 소요시간(초) — 세션 없이 기록하면 null. 상한은 여기서 막지 않는다(초과 → 엔진이 null로, 기록은 받는다 — §19-8).
  // `.nullish()` 금지 — undefined가 Firestore로 샌다(§19-5). 대신 **필드가 빠진 요청은 null로 채운다**(`.default(null)` —
  // 결과 타입은 여전히 `number | null`이라 아래 양방향 검사가 계약의 필수 nullable과 그대로 묶인다). 이유: 배포 전 번들을 든 채
  // 며칠째 열려 있는 폰 화면(version-watch는 자동 새로고침을 하지 않는다)이 세션 끝에 보낸 기록이 400으로 날아가면 안 된다 —
  // 그 화면은 어차피 잴 수 없었으니 null(근사)이 맞는 값이다. 새 화면은 계약 타입으로 항상 싣는다.
  durationSec: z.number().int().min(0).nullable().default(null),
};

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("complete"), failed: z.null() }),
  z.object({
    ...common,
    kind: z.literal("fail"),
    failed: z.object({
      exercise: z.enum(["pullup", "pushup"]),
      setIndex: z.number().int().min(0).max(SETS_PER_EXERCISE - 1),
      // 그 세트에서 한 횟수는 선택(안 고르면 null). 목표를 넘으면 서버가 목표로 클램프한다.
      // `.nullish()` 금지 — undefined가 Firestore로 샌다(§19-5).
      reps: z.number().int().min(0).max(500).nullable(),
    }),
  }),
]);

// 요청 계약(WorkoutLogRequest, lib/workout-contract.ts)과 이 zod 스키마가 갈리면 tsc가 잡는다 — 양방향 대입 검사.
// 화면은 계약 타입으로 보내고 라우트는 zod로 받는다. 한쪽만 필드명을 바꾸면 런타임 400이 되므로 컴파일 때 묶어 둔다.
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [WorkoutLogRequest, BodyInput] extends [BodyInput, WorkoutLogRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: WorkoutLogResponse, status = 200) {
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
        messageKo: "기록을 저장할 수 없어요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { cycleId: id, expectedRev, kind, day, targetDay, failed, durationSec } = parsed.data;

  // "오늘"은 서버에서 한 번만 계산해 스토어에 넘긴다(§19-4 — 트랜잭션이 재시도돼도 같은 날짜·시각으로 판정).
  const now = new Date();
  const nowIso = now.toISOString();
  const todayKst = kstTodayString(now);

  try {
    const result = await store.logWorkoutEvent(id, { expectedRev, kind, day, targetDay, failed, durationSec, todayKst, nowIso });
    switch (result.status) {
      case "ok": {
        const { record } = result;
        // 방금 붙인 사건 = 배열 끝(서버가 만든 date·at·reps)
        return json({ ok: true, cycleId: record.id, rev: record.rev, event: record.events[record.events.length - 1] });
      }
      case "not_found":
        return json({ ok: false, error: "not_found", messageKo: "운동 사이클을 찾을 수 없어요. 최신 상태로 새로 고칠게요." }, 404);
      case "conflict":
        return json(
          { ok: false, error: "conflict", messageKo: "다른 화면에서 이미 기록이 바뀌었어요. 최신 상태로 새로 고칠게요." },
          409,
        );
      case "not_active":
        return json({ ok: false, error: "not_active", messageKo: "이미 끝난 사이클이에요. 최신 상태로 새로 고칠게요." }, 409);
      case "stale_state":
      // "empty"는 취소 전용 상태라 기록에선 나오지 않는다 — 오면 화면이 낡은 것으로 보고 같은 409로 새로 고치게 한다.
      case "empty":
        return json(
          {
            ok: false,
            error: "stale_state",
            messageKo: "오늘 할 운동이 화면과 달라요(이미 기록했거나 쉬는 날이에요). 최신 상태로 새로 고칠게요.",
          },
          409,
        );
    }
  } catch (err) {
    console.error("[/api/workout/log] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * /api/push/workout-rest — ⏱ 휴식 알림 예약·취소(SPEC §19-9). PIN 게이트 안(proxy 자동). 화면(운동 세션)이 부른다.
 *
 * GET  → 200 `{ ok: true, enabled: true }` · 501 `{ ok: false, error: "not_configured" }`(VAPID·큐·기본 URL·비밀 중 하나라도 없음 — 화면은 안내 줄을 숨긴다)
 * POST `{ op: "schedule", remainingMs, label, setNo, seq }` — 휴식 중 화면이 숨겨지는 순간(keepalive). 서버 시계로 끝 시각을 정하고
 *        사람 문서(`workoutRestAlerts/appa`)를 원자적으로 새 token·rev+1로 덮은 뒤 Cloud Tasks에 알림 1~2개를 예약한다.
 *        → 200 `{ ok: true, rev, scheduled }`(scheduled = 만든 태스크 수, 30초 알림을 건너뛰면 1) · 500 `schedule_failed`(태스크 전부 실패)
 * POST `{ op: "cancel", seq }` — 화면이 다시 보일 때·세션을 열 때. 살아 있는 예약이면 cancelled·rev+1, 아니면 순번만 기록
 *        → 200 `{ ok: true, cancelled }`(cancelled = 이번에 살아 있는 예약을 취소했는가)
 * seq(QA 1 P2-A): 화면 요청 순번(시각 기반 단조 증가). 저장된 순번 이하인 요청은 쓰지 않고 200 `{ ok: true, stale: true }` —
 *   keepalive 숨김 예약이 보임 취소보다 늦게 도착해도 화면을 보는 중에 알림이 살아나지 않는다.
 * 공통: 400 `invalid_input`(+messageKo) · 500 `save_failed` · 501 `not_configured`.
 * 이 알림은 본인이 시작한 타이머라 가족 알림의 조용한 시간·하루 상한·콕 셈과 무관하다(§17-11 예외).
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import {
  decideRestCancel,
  decideRestSchedule,
  isRestAlertSeqPlausible,
  parseRestAlertRequest,
  planRestAlerts,
  WORKOUT_REST_ALERT_PERSON,
  type WorkoutRestAlertRecord,
} from "@/lib/workout-rest-alert";
import { createRestAlertTask, restAlertConfig } from "@/lib/workout-rest-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notConfigured() {
  return NextResponse.json({ ok: false, error: "not_configured", messageKo: "휴식 알림이 아직 준비되지 않았어요." }, { status: 501 });
}

export async function GET() {
  if (!restAlertConfig()) return notConfigured();
  return NextResponse.json({ ok: true, enabled: true }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const cfg = restAlertConfig();
  if (!cfg) return notConfigured();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "요청 형식이 올바르지 않아요." }, { status: 400 });
  }
  const parsed = parseRestAlertRequest(raw);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: "invalid_input", messageKo: parsed.messageKo }, { status: 400 });
  const req1 = parsed.value;
  const store = getStore();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  if (!isRestAlertSeqPlausible(req1.seq, now)) {
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "폰 시계가 맞지 않아 휴식 알림을 예약하지 못했어요." }, { status: 400 });
  }

  if (req1.op === "cancel") {
    try {
      const r = await store.updateWorkoutRestAlert(WORKOUT_REST_ALERT_PERSON, (cur) => {
        const next = decideRestCancel(cur, nowIso, req1.seq);
        return { next, result: next === null ? ("stale" as const) : cur !== null && !cur.cancelled };
      });
      if (r === "stale") return NextResponse.json({ ok: true, stale: true });
      return NextResponse.json({ ok: true, cancelled: r });
    } catch (err) {
      console.error("[/api/push/workout-rest] 취소 실패:", err instanceof Error ? err.name : "unknown");
      return NextResponse.json({ ok: false, error: "save_failed", messageKo: "휴식 알림을 끄지 못했어요." }, { status: 500 });
    }
  }

  const endsAtMs = now + req1.remainingMs;
  let rec: WorkoutRestAlertRecord | null;
  try {
    rec = await store.updateWorkoutRestAlert(WORKOUT_REST_ALERT_PERSON, (cur) => {
      const next = decideRestSchedule(cur, { endsAtMs, label: req1.label, setNo: req1.setNo, token: randomUUID(), nowIso, seq: req1.seq });
      return { next, result: next };
    });
  } catch (err) {
    console.error("[/api/push/workout-rest] 저장 실패:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "휴식 알림을 예약하지 못했어요." }, { status: 500 });
  }
  if (!rec) return NextResponse.json({ ok: true, stale: true });
  const saved = rec;
  const plans = planRestAlerts(endsAtMs, now);
  const results = await Promise.allSettled(
    plans.map((p) => createRestAlertTask(cfg, { person: WORKOUT_REST_ALERT_PERSON, token: saved.token, rev: saved.rev, kind: p.kind, at: p.at })),
  );
  const scheduled = results.filter((r) => r.status === "fulfilled").length;
  for (const r of results) {
    if (r.status === "rejected") console.error("[/api/push/workout-rest] 태스크 예약 실패:", r.reason instanceof Error ? r.reason.message.slice(0, 80) : "unknown");
  }
  if (plans.length > 0 && scheduled === 0) {
    return NextResponse.json({ ok: false, error: "schedule_failed", messageKo: "휴식 알림을 예약하지 못했어요." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, rev: saved.rev, scheduled });
}

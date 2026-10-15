/**
 * POST /api/push/workout-rest/fire — ⏱ 휴식 알림 발송(SPEC §19-9). Cloud Tasks가 예약 시각에 부른다.
 *
 * PIN 게이트 밖(proxy PUBLIC_PATHS) — 대신 헤더 `x-push-secret`(= PUSH_CRON_SECRET, 틱과 같은 `pushSecretOk`).
 * 본문 = 태스크 payload `{ person: "appa", token, rev, kind: "pre"|"end", at }`.
 * 흐름: 사람 문서를 읽어 `decideRestFire`(rev·token 같음·취소 아님·예정 시각 근처)일 때만, 발송 기록 `rest:appa:{token}:{kind}`를
 *   선점(create 멱등 — Cloud Tasks의 재시도·중복 배달에도 한 번)하고 아빠 기기들에 보낸다(가족 알림과 같은 구독, `deliver`).
 *   발송 기록 id가 `day:` 접두가 아니라 가족 알림의 하루 상한(listPushLog)에 섞이지 않는다. 조용한 시간도 보지 않는다(본인 타이머).
 * 200 `{ ok: true, sent, reason? }`(보내지 않기로 한 것도 200 — 큐가 다시 부르지 않게) · 400 본문 · 401 비밀 · 500 저장소 · 501 VAPID 없음.
 */

import { NextResponse } from "next/server";
import { pushSecretOk } from "@/lib/push-secret";
import { deliver, pushConfigured } from "@/lib/push-send";
import { getStore } from "@/lib/store";
import { decideRestFire, parseRestAlertTask, REST_ALERT_TTL_SEC, restAlertMessage } from "@/lib/workout-rest-alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!pushSecretOk(req.headers.get("x-push-secret"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 501 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const task = parseRestAlertTask(raw);
  if (!task) return NextResponse.json({ ok: false, error: "invalid_input" }, { status: 400 });

  const store = getStore();
  try {
    const doc = await store.getWorkoutRestAlert(task.person);
    const now = Date.now();
    const decision = decideRestFire(doc, task, now);
    if (!decision.send || !doc) return NextResponse.json({ ok: true, sent: 0, reason: decision.send ? "no_doc" : decision.reason });
    // 구독을 **먼저** 읽는다(읽기는 멱등) — 발송 기록을 잡은 뒤 조회가 던지면 재시도가 duplicate로 막혀 영영 안 간다(QA 1 P3-C)
    const subs = (await store.listPushSubscriptions()).filter((s) => s.person === task.person);
    if (!(await store.claimPushLog(`rest:${task.person}:${task.token}:${task.kind}`, new Date(now).toISOString()))) {
      return NextResponse.json({ ok: true, sent: 0, reason: "duplicate" });
    }
    const sent = await deliver(store, subs, restAlertMessage(task.kind, doc), { ttlSec: REST_ALERT_TTL_SEC, urgency: "high" });
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    console.error("[/api/push/workout-rest/fire] 실패:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, error: "fire_failed" }, { status: 500 });
  }
}

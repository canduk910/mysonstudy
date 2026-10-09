/**
 * POST /api/push/tick — 30분 알림 틱(가족 스트릭 강화 스펙 §6-1·§6-2). Cloud Scheduler가 08:00~22:30 KST 30분마다 부른다.
 *
 * PIN 게이트 밖(proxy PUBLIC_PATHS) — 대신 헤더 `x-push-secret`을 env `PUSH_CRON_SECRET`과 상수 시간 비교한다(비밀 없음·불일치 401).
 * 흐름: KST 오늘·지금(2분 여유 더해 30분 내림) → computeStreakResponse → pushStates → 오늘 보낸 기록 → decidePushes →
 *   알림마다 그 사람 구독이 있을 때만 발송 기록(`${today}:${person}:${kind}:0`)을 선점(create 멱등)하고 그 사람 기기들에 보낸다.
 *   가족 알림은 그 설정을 켠 기기에만. 사라진 기기는 지우고, 성공 기기는 lastOkAt.
 * 200 `{ ok: true, sent }`(sent = 성공한 기기 발송 수) · 401 비밀 · 501 VAPID 키 없음.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { kstTodayString } from "@/lib/kst";
import { TICK_SKEW_MS, decidePushes, kstHalfHourHHMM, pushStates } from "@/lib/push-decide";
import { deliver, prefsByPerson, pushConfigured } from "@/lib/push-send";
import { getStore } from "@/lib/store";
import { computeStreakResponse } from "@/lib/streak-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 길이가 달라도 상수 시간 — 둘 다 sha256으로 같은 길이로 만든 뒤 비교 */
function secretOk(given: string | null): boolean {
  const want = process.env.PUSH_CRON_SECRET?.trim();
  if (!want || !given) return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(want));
}

export async function POST(req: Request) {
  if (!secretOk(req.headers.get("x-push-secret"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 501 });

  const store = getStore();
  const now = new Date();
  const today = kstTodayString(now);
  // 2분 여유를 더해 내린다 — 22:29:59에 불려도 22:30 마지막 알림 칸(스케줄러 지터)
  const nowHHMM = kstHalfHourHHMM(now, TICK_SKEW_MS);
  try {
    const [streak, subs, sentToday] = await Promise.all([computeStreakResponse(store, today), store.listPushSubscriptions(), store.listPushLog(today)]);
    const pushes = decidePushes({ nowHHMM, states: pushStates(streak), prefs: prefsByPerson(subs), sentToday });
    let sent = 0;
    for (const p of pushes) {
      const targets = subs.filter((s) => s.person === p.person && (p.kind !== "family" || s.prefs.familyAlerts));
      // 기기가 없으면 선점하지 않는다 — 오늘 늦게 켠 기기도 다음 틱에 받게(그리고 하루 상한을 헛되이 쓰지 않게)
      if (targets.length === 0) continue;
      if (!(await store.claimPushLog(`${today}:${p.person}:${p.kind}:0`, now.toISOString()))) continue;
      sent += await deliver(store, targets, { title: p.title, body: p.body, url: p.url });
    }
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    console.error("[/api/push/tick] 실패:", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown");
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

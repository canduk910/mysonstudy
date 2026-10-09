/**
 * POST /api/push/poke — 👉 콕 찌르기(가족 스트릭 강화 스펙 §6-2). PIN 게이트 안(proxy 자동).
 *
 * 본문 `{ from, to }`(둘 다 은우·아빠·엄마, 서로 달라야). `to`가 오늘 아직일 때만, 받는 사람당 하루 POKE_DAILY_MAX(2)회·
 * 그 사람 전체 알림 PUSH_DAILY_MAX(3)개 안에서. 발송 기록 `${today}:${to}:poke:${n}`을 선점(create 멱등)한 뒤 보낸다.
 * 조용한 시간(22:30 초과~08:00 전, KST — 스펙 §6-2 모든 알림 공통)에는 보내지 않는다(409 reason "quiet").
 * 200 `{ ok: true, delivered }` · 400 형식 · 404 그 사람 폰에 알림이 꺼짐 · 409 이미 오늘 함(reason "done")·조용한 시간(reason "quiet") · 429 오늘 상한 · 501 VAPID 키 없음.
 */

import { NextResponse } from "next/server";
import { kstTodayString } from "@/lib/kst";
import { isPushPerson } from "@/lib/push-contract";
import { POKE_DAILY_MAX, PUSH_DAILY_MAX, isQuietHHMM, kstHHMM, pushText } from "@/lib/push-decide";
import { deliver, pushConfigured } from "@/lib/push-send";
import { getStore } from "@/lib/store";
import { computeStreakResponse, pushStates } from "@/lib/streak-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, messageKo: string, reason?: "quiet" | "done") {
  return NextResponse.json({ ok: false, error, messageKo, ...(reason ? { reason } : {}) }, { status });
}

export async function POST(req: Request) {
  if (!pushConfigured()) return fail(501, "not_configured", "아직 알림 준비 중이에요.");
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, "invalid_input", "요청 형식이 올바르지 않아요.");
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const { from, to } = o;
  if (!isPushPerson(from) || !isPushPerson(to) || from === to) return fail(400, "invalid_input", "누가 누구를 찌르는지 알려 주세요.");

  const now = new Date();
  if (isQuietHHMM(kstHHMM(now))) return fail(409, "quiet", "지금은 조용한 시간이에요 (밤 10시 반~아침 8시)", "quiet");

  const store = getStore();
  const today = kstTodayString(now);
  try {
    const [streak, subs, log] = await Promise.all([computeStreakResponse(store, today), store.listPushSubscriptions(), store.listPushLog(today)]);
    const state = pushStates(streak).find((s) => s.person === to);
    if (!state || state.doneToday) return fail(409, "already_done", "오늘은 벌써 했어요!", "done");
    const targets = subs.filter((s) => s.person === to);
    if (targets.length === 0) return fail(404, "no_device", "그 사람 폰에 알림이 꺼져 있어요.");
    const pokes = log.filter((l) => l.person === to && l.kind === "poke").length;
    const total = log.filter((l) => l.person === to).length;
    if (pokes >= POKE_DAILY_MAX || total >= PUSH_DAILY_MAX) return fail(429, "limit", "오늘은 더 찌를 수 없어요.");
    // 동시에 두 번 눌러도 같은 n은 한 번만 선점된다 — 진 쪽은 상한으로 본다
    if (!(await store.claimPushLog(`${today}:${to}:poke:${pokes}`, new Date().toISOString()))) return fail(429, "limit", "오늘은 더 찌를 수 없어요.");
    const delivered = await deliver(store, targets, pushText(to, "poke", state, { from }));
    return NextResponse.json({ ok: true, delivered });
  } catch (err) {
    console.error("[/api/push/poke] 실패:", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown");
    return fail(500, "poke_failed", "보내지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
}

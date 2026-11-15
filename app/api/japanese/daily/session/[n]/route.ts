/**
 * GET /api/japanese/daily/session/[n] — 회차 n에 필요한 내용을 한 번에(설계 §4). 읽기 전용 · AI 없음.
 *
 * 칸 배정은 과정 엔진(lib/ja-daily-plan), 내용 풀기·약한 것 고르기는 lib/ja-daily-session(순수).
 * 200 JaDailySessionOk · 400 invalid_input(n 형식) · 404 no_content(내용 없음) · 409 ahead(아직 오지 않은 회차 — nextN) · 500 load_failed.
 * 끝낸 회차를 다시 열면 replay:true(저장 때 replay로 보낸다). 과정 뒤 회차(n > total, n ≤ 다음 회차)는 반복 모드.
 */
import { NextResponse } from "next/server";
import type { JaDailySessionResponse } from "@/lib/ja-daily-contract";
import { resolveJaDailySession } from "@/lib/ja-daily-session";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: JaDailySessionResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ n: string }> }) {
  const { n: raw } = await params;
  if (!/^[1-9]\d{0,2}$/.test(raw)) return json({ ok: false, error: "invalid_input", messageKo: "회차 번호가 올바르지 않아요." }, 400);
  try {
    const store = getStore();
    const [content, sessions] = await Promise.all([store.listJaDailyContent(), store.listJaDailySessions()]);
    const r = resolveJaDailySession(Number(raw), content, sessions);
    if (r.ok) return json(r);
    if (r.error === "no_content") return json(r, 404);
    if (r.error === "ahead") return json(r, 409);
    return json(r, 400);
  } catch (err) {
    console.error("[ja-daily/session] 읽기 실패", err);
    return json({ ok: false, error: "load_failed", messageKo: "불러오지 못했어요. 잠시 뒤 다시 해 주세요." }, 500);
  }
}

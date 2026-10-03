/**
 * POST /api/toeic/frame-drill/sessions/[id]/supply — 보충 출제(한 판에 한 번) (docs/harness/toeic.md §20-4·§20-6·§20-10 ③, SPEC §20-17)
 *
 * 결과 화면이 판정을 받은 뒤 best-effort로 한 번 부른다. 본문 없음. 판정과 한 요청에 묶지 않는다(sol 모델 두 번이 60초 상한을 넘을 수 있다).
 *
 * 1. 스토어 `startToeicFrameDrillSupply` — **한 원자 단위**에서 잡기(decideFrameDrillSupplyClaim)와 보충 판정(decideFrameDrillSupply —
 *    판정 때 더한 뒤의 통계로)을 한다(lib/toeic-frame-drill-record decideFrameDrillSupplyStart):
 *    - review 없음 → 409 not_judged
 *    - 이미 끝남(added·skipped) → AI 0, 그 표시를 돌려준다(fresh:false — 재방문은 호출 F 0회)
 *    - 다른 탭이 진행 중(2분 안) → 409 running
 *    - skip(no_scope·sample·rate·full) → 표시 skipped를 쓰고 AI 0
 *    - supply → 표시 running을 쓰고 다음으로
 * 2. 키 검사(501) — AI 호출 직전. 키가 없으면 표시를 failed(no_api_key)로 되돌린다(running으로 2분 막히지 않게 — 다음에 다시 잡는다).
 * 3. `planFrameDrillSupply`(잡을 때 읽은 은행) → 호출 F `supplyFrameDrillItems`(모델 resolveToeicModel).
 * 4. 스토어 `finishToeicFrameDrillSupply` — **최신 은행 위에** acceptFrameDrillSupply(영어 = fillFrame — 틀 글자는 코드가 쓴다, 은행과
 *    겹치면 버림, 결정적 id) + 표시 added. 호출 F가 실패하면 표시 failed(다음에 결과를 열면 다시 잡는다) → 500 ai_failed.
 * - 로그: 개수·이유·ms만(문장 없음).
 *
 * 응답 shape (단일 정의처 `lib/toeic-frame-drill-contract.ts` ToeicFrameDrillSupplyResponse):
 * - 200 { ok:true, status, fresh, added, dropped, reason }
 * - 404 { ok:false, error:"not_found", messageKo }
 * - 409 { ok:false, error:"not_judged" | "running", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true } | { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { supplyFrameDrillItems } from "@/lib/ai/toeic/calls";
import { getStore } from "@/lib/store";
import { planFrameDrillSupply } from "@/lib/toeic-frame-drill";
import { isToeicFrameDrillDocId, type ToeicFrameDrillSupplyResponse } from "@/lib/toeic-frame-drill-contract";

export const runtime = "nodejs";

function json(body: ToeicFrameDrillSupplyResponse, status = 200) {
  return NextResponse.json(body, { status });
}

const NOT_FOUND_KO = "연습 기록을 찾을 수 없어요.";
const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown");

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isToeicFrameDrillDocId(id)) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);
  const store = getStore();

  let started;
  try {
    started = await store.startToeicFrameDrillSupply(id, Date.now(), new Date().toISOString());
  } catch (err) {
    console.error("[/api/toeic/frame-drill/supply] 잡기 실패:", errName(err));
    return json({ ok: false, error: "save_failed", messageKo: "새 문제 확인을 하지 못했어요." }, 500);
  }
  if (!started) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);
  const { start, bank } = started;

  switch (start.kind) {
    case "not_judged":
      return json({ ok: false, error: "not_judged", messageKo: "판정이 끝난 뒤에 새 문제를 확인해요." }, 409);
    case "running":
      return json({ ok: false, error: "running", messageKo: "다른 화면에서 새 문제를 만드는 중이에요." }, 409);
    case "already":
      return json({ ok: true, status: start.mark.status, fresh: false, added: start.mark.added, dropped: 0, reason: start.mark.reason });
    case "skip":
      console.log(`[/api/toeic/frame-drill/supply] 보충 안 함(${start.reason}) · 오답률 ${start.rate === null ? "-" : start.rate.toFixed(3)}`);
      return json({ ok: true, status: "skipped", fresh: true, added: 0, dropped: 0, reason: start.reason });
    case "supply":
      break;
  }

  const nowIso = () => new Date().toISOString();
  // 키 검사 — AI 호출 직전. 잡아 둔 표시는 failed로 되돌린다(다음에 다시 잡게)
  if (!process.env.OPENAI_API_KEY) {
    await store.finishToeicFrameDrillSupply(id, null, "no_api_key", nowIso()).catch(() => null);
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 새 문제를 만들 수 없어요." }, 501);
  }

  const plan = bank ? planFrameDrillSupply(bank, start.scopeFrameKeys, start.count) : null;
  if (!plan || plan.count <= 0 || plan.frames.length === 0) {
    // 판정과 계획 사이에 범위가 비는 일은 없다(같은 은행) — 방어: 더할 것 없이 끝
    const fin = await store.finishToeicFrameDrillSupply(id, [], null, nowIso()).catch(() => null);
    return json({ ok: true, status: fin?.mark.status ?? "added", fresh: true, added: 0, dropped: 0, reason: null });
  }

  const t0 = Date.now();
  let out;
  try {
    out = await supplyFrameDrillItems(plan);
  } catch (err) {
    console.error(`[/api/toeic/frame-drill/supply] 호출 F 실패(${Date.now() - t0}ms):`, errName(err));
    await store.finishToeicFrameDrillSupply(id, null, "ai_failed", nowIso()).catch(() => null);
    return json({ ok: false, error: "ai_failed", messageKo: "새 문제를 만들지 못했어요. 다음에 결과를 열 때 다시 해 볼게요.", retriable: true }, 500);
  }

  try {
    const fin = await store.finishToeicFrameDrillSupply(id, out.items, null, nowIso());
    if (!fin) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);
    console.log(`[/api/toeic/frame-drill/supply] 보충 계획 ${plan.count} · 더함 ${fin.added} · 버림 ${fin.dropped} · ${Date.now() - t0}ms`);
    return json({ ok: true, status: fin.mark.status, fresh: true, added: fin.added, dropped: fin.dropped, reason: fin.mark.reason });
  } catch (err) {
    console.error("[/api/toeic/frame-drill/supply] 저장 실패:", errName(err));
    await store.finishToeicFrameDrillSupply(id, null, "save_failed", nowIso()).catch(() => null);
    return json({ ok: false, error: "save_failed", messageKo: "새 문제를 저장하지 못했어요." }, 500);
  }
}

/**
 * POST /api/toeic/frame-drill/sessions/[id]/judge — 한 판 판정·총평 + 통계 (docs/harness/toeic.md §20-5·§20-10 ②, SPEC §20-17)
 *
 * 결과 화면이 열릴 때 판정이 없으면 부른다. 본문 없음.
 *
 * 1. 한 판을 읽는다(없으면 404). `decideFrameDrillJudge`:
 *    - already → AI 0, 저장된 판을 그대로(judged:false). 판정은 있는데 통계를 못 더한 판이면 스토어가 지금 더한다.
 *    - no_ai(말한 문항 0 — 모두 무응답·전사 실패) → AI 0, `frameDrillNoAiReview` 총평.
 *    - call → **키 검사(501) — AI 호출 직전** → 호출 E `judgeFrameDrill`(말한 문항만 — frameDrillJudgeTargets, 모델 resolveToeicModel).
 * 2. 스토어 `judgeToeicFrameDrillSession` — 판정 합치기(mergeFrameDrillVerdicts — 무응답은 AI 없이 wrong)·review·통계 더하기·
 *    statsAppliedAt을 **한 원자 단위**로(lib/toeic-frame-drill-record decideFrameDrillJudgeWrite). 두 탭이 겹쳐도 먼저 저장된 판정이 이기고
 *    통계는 한 번만 더해진다.
 * - 호출 E가 실패하면(재요청까지 소진) 아무것도 저장하지 않는다 — 500 ai_failed(retriable). 화면은 "다시 판정 받기".
 * - 로그: 판정 분포·개수·ms만(문장·전사문 없음).
 *
 * 응답 shape (단일 정의처 `lib/toeic-frame-drill-contract.ts` ToeicFrameDrillJudgeResponse):
 * - 200 { ok:true, session, judged, ai }
 * - 404 { ok:false, error:"not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }               ← call일 때만(AI 호출 직전)
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true } ← 아무것도 저장하지 않았다
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { judgeFrameDrill } from "@/lib/ai/toeic/calls";
import { resolveToeicModel } from "@/lib/ai/toeic/model";
import { getStore } from "@/lib/store";
import { decideFrameDrillJudge, frameDrillJudgeTargets } from "@/lib/toeic-frame-drill";
import { isToeicFrameDrillDocId, type ToeicFrameDrillJudgeResponse } from "@/lib/toeic-frame-drill-contract";
import type { FrameDrillJudged } from "@/lib/toeic-frame-drill-record";

export const runtime = "nodejs";

function json(body: ToeicFrameDrillJudgeResponse, status = 200) {
  return NextResponse.json(body, { status });
}

const NOT_FOUND_KO = "연습 기록을 찾을 수 없어요.";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isToeicFrameDrillDocId(id)) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);
  const store = getStore();

  let session;
  try {
    session = await store.getToeicFrameDrillSession(id);
  } catch (err) {
    console.error("[/api/toeic/frame-drill/judge] 읽기 실패:", err instanceof Error ? err.name : "unknown");
    return json({ ok: false, error: "save_failed", messageKo: "연습 기록을 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
  if (!session) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);

  const decision = decideFrameDrillJudge(session);
  let judged: FrameDrillJudged | null = null;
  if (decision === "call") {
    // 키 검사 — AI 호출 직전(already·no_ai는 키 없이도 결과가 보여야 한다)
    if (!process.env.OPENAI_API_KEY) {
      return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 판정·총평을 만들 수 없어요." }, 501);
    }
    const targets = frameDrillJudgeTargets(session.items);
    const t0 = Date.now();
    try {
      const out = await judgeFrameDrill({
        items: targets.map(({ no, item }) => ({ no, ko: item.ko, frameKey: item.frameKey, frame: item.frame, en: item.en, transcript: item.transcript ?? "" })),
      });
      judged = {
        items: out.items,
        summaryKo: out.summaryKo,
        improvements: out.improvements,
        strongFrameKeys: out.strongFrames,
        weakFrameKeys: out.weakFrames,
        model: resolveToeicModel(),
      };
      const dist = { correct: 0, close: 0, wrong: 0 };
      for (const it of out.items) dist[it.verdict] += 1;
      console.log(`[/api/toeic/frame-drill/judge] 판정 ${targets.length}문항 · ✓${dist.correct} △${dist.close} ✕${dist.wrong} · ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`[/api/toeic/frame-drill/judge] 호출 E 실패(${Date.now() - t0}ms):`, err instanceof Error ? err.name : "unknown");
      return json({ ok: false, error: "ai_failed", messageKo: "판정을 만들지 못했어요. 잠시 후 다시 판정 받기를 눌러 주세요.", retriable: true }, 500);
    }
  }

  try {
    const w = await store.judgeToeicFrameDrillSession(id, judged, new Date().toISOString());
    if (w === null) return json({ ok: false, error: "not_found", messageKo: NOT_FOUND_KO }, 404);
    if (w.kind === "needs_ai") {
      // 읽은 뒤 판이 바뀔 일은 없다(판정 칸만 바뀐다) — 방어. 아무것도 쓰지 않았다
      return json({ ok: false, error: "ai_failed", messageKo: "판정을 만들지 못했어요. 다시 판정 받기를 눌러 주세요.", retriable: true }, 500);
    }
    return json({ ok: true, session: w.session, judged: w.kind === "write", ai: judged !== null });
  } catch (err) {
    console.error("[/api/toeic/frame-drill/judge] 저장 실패:", err instanceof Error ? err.name : "unknown");
    return json({ ok: false, error: "save_failed", messageKo: "판정을 저장하지 못했어요. 다시 판정 받기를 눌러 주세요." }, 500);
  }
}

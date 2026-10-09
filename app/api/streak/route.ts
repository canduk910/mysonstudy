/**
 * GET /api/streak — 학습 스트릭 (SPEC §17). 읽기 전용·AI 없음. 계산은 lib/streak-server.ts의 computeStreakResponse
 * (알림 틱 /api/push/tick도 같은 함수로 사람 상태를 얻는다). 캐시 없음(no-store). PIN 게이트는 proxy가 자동.
 */

import { NextResponse } from "next/server";
import { kstTodayString } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { computeStreakResponse } from "@/lib/streak-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const body = await computeStreakResponse(getStore(), kstTodayString());
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

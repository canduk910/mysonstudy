/**
 * GET /api/review/{area} — 오늘의 복습 큐(SPEC §23-6). 읽기 전용·AI 없음(키 검사 없음). area = english | japanese | toeic.
 *
 * 200 `ReviewQueueResponse`(lib/review-contract.ts) · 400 `invalid_input`(모르는 영역) · 500 `load_failed`(일정 컬렉션을 못 읽음).
 * 출처 하나를 못 읽으면 그 출처만 빠지고 200(`failedSources`). 캐시 없음(no-store). PIN 게이트는 proxy가 자동.
 * 홈의 "📅 오늘의 복습 n개" 카드가 이 개수를 읽는다(cards.length).
 */

import { NextResponse } from "next/server";
import { kstTodayString } from "@/lib/kst";
import type { ReviewErrorResponse, ReviewQueueResponse } from "@/lib/review-contract";
import { isReviewArea } from "@/lib/review-schedule";
import { loadReviewQueue } from "@/lib/review-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: ReviewQueueResponse | ReviewErrorResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  if (!isReviewArea(area)) return json({ ok: false, error: "invalid_input", messageKo: "모르는 복습 영역이에요." }, 400);
  try {
    const q = await loadReviewQueue(area, kstTodayString());
    return json({ ok: true, ...q });
  } catch (err) {
    console.error("[review] 큐를 만들지 못했다", err);
    return json({ ok: false, error: "load_failed", messageKo: "오늘의 복습을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요." }, 500);
  }
}

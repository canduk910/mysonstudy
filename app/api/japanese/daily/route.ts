/**
 * GET /api/japanese/daily — 🗓️ 오늘의 일본어 홈 자료(설계 §5): 내용 색인 + 과정(회차 배정) + 다음 회차 + 기록 요약. 읽기 전용 · AI 없음.
 *
 * 200 JaDailyIndexOk(lib/ja-daily-contract.ts) — 내용이 하나도 없으면 hasContent:false · course [] (화면은 가져오기 안내만).
 * 500 { ok:false, error:"load_failed" }. "오늘"(KST)은 여기서 한 번만 읽는다.
 */
import { NextResponse } from "next/server";
import { JA_DAILY_CONTENT_KINDS } from "@/lib/ja-daily-content";
import { summarizeJaDailyRecord, toJaDailyContentIndex, type JaDailyIndexResponse } from "@/lib/ja-daily-contract";
import { buildJaDailyCourse, nextJaDailySession } from "@/lib/ja-daily-plan";
import { jaDailyDoneTodayN } from "@/lib/ja-daily-streak";
import { kstTodayString } from "@/lib/kst";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: JaDailyIndexResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  const today = kstTodayString(new Date());
  try {
    const store = getStore();
    const [content, sessions] = await Promise.all([store.listJaDailyContent(), store.listJaDailySessions()]);
    const index = toJaDailyContentIndex(content);
    const course = buildJaDailyCourse(index);
    const counts = Object.fromEntries(JA_DAILY_CONTENT_KINDS.map((k) => [k, content.filter((r) => r.kind === k).length])) as Record<(typeof JA_DAILY_CONTENT_KINDS)[number], number>;
    return json({
      ok: true,
      today,
      hasContent: content.length > 0,
      counts,
      content: index,
      course,
      next: nextJaDailySession(course, sessions),
      // 스트릭과 같은 판정(startedAt KST + 한 판) — lib/ja-daily-streak(QA daily1 P2-A)
      doneTodayN: jaDailyDoneTodayN(sessions, today),
      records: sessions.map(summarizeJaDailyRecord),
    });
  } catch (err) {
    console.error("[ja-daily] 읽기 실패", err);
    return json({ ok: false, error: "load_failed", messageKo: "불러오지 못했어요. 잠시 뒤 다시 해 주세요." }, 500);
  }
}

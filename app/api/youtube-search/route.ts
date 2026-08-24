/**
 * GET /api/youtube-search — 책 낭독 영상 후보 검색 (표지 판독·식별 이후)
 *
 * 쿼리 title(필수)·author(선택)을 받아 lib/youtube-search로 유튜브 낭독 영상 후보
 * 상위 3개를 돌려준다. 부모가 한 번 탭해 고른 영상 URL이 /api/card의 youtubeUrl로
 * 들어가 카드를 그 자막에 grounding한다(선택 기능).
 *
 * 검색 실패(키 없음·결과 0·API 오류)는 **비치명**이다 — 200 + { ok:false, error, messageKo }로
 * 되돌려 클라이언트가 "표지 기준으로 만들게요"로 조용히 폴백하게 한다. 카드 생성을 막지 않는다.
 * (PIN 게이트는 proxy.ts가 모든 /api/*에 적용하므로 라우트에서 별도 처리하지 않는다.)
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, results: ReadaloudCandidate[] }                          ← 후보 최대 3개(0개는 아래 폴백)
 * - 200 { ok: false, error, messageKo }                                      ← no_key|no_results|api_error|timeout|network (비치명)
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path,message}[] } ← title 누락 등
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { searchReadalouds } from "@/lib/youtube-search";

export const runtime = "nodejs";

const querySchema = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    title: url.searchParams.get("title") ?? undefined,
    author: url.searchParams.get("author") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "책 제목을 확인해 주세요.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const result = await searchReadalouds(parsed.data.title, parsed.data.author || null);
  if ("results" in result) {
    return NextResponse.json({ ok: true, results: result.results });
  }
  // 검색 실패는 비치명 — 200으로 사유만 알리고, 클라이언트가 표지 기준으로 폴백한다
  return NextResponse.json({ ok: false, error: result.error, messageKo: result.messageKo });
}

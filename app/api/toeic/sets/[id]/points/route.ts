/**
 * POST /api/toeic/sets/[id]/points — 표현집 세트의 **발화 포인트**(호출 B) 만들기 (docs/harness/toeic.md §3)
 *
 * - 대상: 기본은 points가 null인 표현만(빈 자리만 채운다), `force:true`("다시 만들기")면 전부(§3-4).
 * - **7개씩 묶어 병렬 호출**(`planPointsChunks` → `generatePointsChunk` × N, `Promise.allSettled`) — 14개 한 번이면 출력이 길어
 *   60초 상한에 가깝다(§3-0). 한 묶음이 실패해도 나머지는 저장한다(부분 성공 — remaining으로 사실대로 알린다).
 * - 저장은 스토어 `mergeToeicSetPoints`가 **원자 단위 안에서 최신 entries 위에** 병합한다 — 저장 직후 자동 호출과 사용자의
 *   "만들기"가 겹쳐도 먼저 채운 포인트를 뒤 호출이 덮지 않는다(force=false 불변).
 * - 발화 포인트는 부수 효과다(§3-0) — 실패해도 카드·시험(뜻·표현 모드)은 동작한다.
 *
 * 키 검사(501)는 **AI 호출 앞**에 둔다. 채울 것이 없으면 호출 없이 200 nothingToFill(키가 없어도).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-set-contract.ts` ToeicPointsResponse):
 * - 200 { ok:true, filled, remaining, enriched, failedChunks, totalChunks, nothingToFill }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 404 { ok:false, error:"set_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"points_failed", messageKo }   ← 모든 묶음 실패
 * - 500 { ok:false, error:"save_failed", messageKo }     ← 병합 저장 실패
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generatePointsChunk } from "@/lib/ai/toeic/calls";
import { planPointsChunks } from "@/lib/ai/toeic/points";
import type { ToeicPointsItem } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { isRenderableToeicSet } from "@/lib/toeic-record";
import type { ToeicPointsRequest, ToeicPointsResponse } from "@/lib/toeic-set-contract";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({ force: z.boolean() });

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicPointsRequest, BodyInput] extends [BodyInput, ToeicPointsRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicPointsResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "요청 형식을 확인해 주세요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }
  const force = parsed.data.force;

  const set = await store.getToeicSet(id);
  if (!set || !isRenderableToeicSet(set)) {
    return json({ ok: false, error: "set_not_found", messageKo: "없거나 열 수 없는 표현집이에요." }, 404);
  }

  const chunks = planPointsChunks(set.entries, { force });
  if (chunks.length === 0) {
    // 기본 모드에서 이미 전부 있다 — 호출 없음(비용 0)
    return json({ ok: true, filled: 0, remaining: 0, enriched: set.enriched, failedChunks: 0, totalChunks: 0, nothingToFill: true });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "OpenAI API 키가 아직 설정되지 않아 발화 포인트를 만들 수 없어요. 카드와 시험(뜻·표현)은 그대로 쓸 수 있어요.",
      },
      501,
    );
  }

  const settled = await Promise.allSettled(chunks.map((chunk) => generatePointsChunk(set.topicKo, chunk)));
  const items: ToeicPointsItem[] = [];
  let failedChunks = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      failedChunks += 1;
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[/api/toeic/sets/${id}/points] 묶음 ${i} 실패:`, message.slice(0, 300));
    }
  });

  if (failedChunks === chunks.length) {
    return json({ ok: false, error: "points_failed", messageKo: "발화 포인트를 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  try {
    const merged = await store.mergeToeicSetPoints(id, items, { force });
    if (!merged) return json({ ok: false, error: "set_not_found", messageKo: "그사이 지워진 표현집이에요." }, 404);
    return json({
      ok: true,
      filled: merged.filled,
      remaining: merged.remaining,
      enriched: merged.record.enriched,
      failedChunks,
      totalChunks: chunks.length,
      nothingToFill: false,
    });
  } catch (err) {
    console.error(`[/api/toeic/sets/${id}/points] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "발화 포인트를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

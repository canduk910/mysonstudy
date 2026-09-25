/**
 * POST /api/toeic/mocks/[id]/regenerate?part=<part> — 빈 파트 하나 만들기 (docs/harness/toeic.md §4-0, 호출 C 한 파트)
 *
 * "이 파트 다시 만들기"(생성 때 실패한 파트)와 "이 파트 만들기"(생성 때 고르지 않은 파트)가 같은 라우트다. **빈 자리만**
 * 채운다 — 이미 있는 파트는 덮지 않고 409 `part_exists`(보던 모범답변·응시 기록이 가리키는 문항이 말없이 바뀌지 않게,
 * 발화 포인트 "빈 자리만"과 같은 방침). 판정·쓰기는 스토어 `fillToeicMockPart`가 원자 단위 안에서 한다(두 번 눌러도 한 번).
 *
 * 입력은 처음 만들 때와 **같다** — 레코드의 목표 등급·주제 힌트(`topicHints`)·활용할 표현(`expressionsUsed`). 그래서 채운
 * 파트도 같은 세트의 일부처럼 읽힌다. picture를 채우면 사진은 pending으로 저장되고, 화면이 `POST [id]/image`로 따로 요청한다.
 *
 * 키 검사(501)는 AI 호출 **앞**(400 → 404 → 409 → 501 순 — 채울 수 없는 요청에 키 안내를 먼저 보이지 않는다).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-mock-contract.ts` ToeicMockRegenerateResponse):
 * - 200 { ok:true, id, part }
 * - 400 { ok:false, error:"invalid_input", messageKo }            ← part 쿼리 없음·모르는 값
 * - 404 { ok:false, error:"mock_not_found", messageKo }
 * - 409 { ok:false, error:"part_exists", messageKo }              ← 이미 있다(그사이 채워진 경우 포함 — 만든 결과는 버림)
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true } / 500 save_failed
 */

import { NextResponse } from "next/server";
import { generateMockPart } from "@/lib/ai/toeic/calls";
import type { ToeicMockPartRecordMap } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { toeicMockPartLabelKo, type ToeicMockRegenerateResponse } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, type ToeicMockPart } from "@/lib/toeic-mock";
import { isRenderableToeicMock } from "@/lib/toeic-record";

export const runtime = "nodejs";

function json(body: ToeicMockRegenerateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function isMockPart(v: string | null): v is ToeicMockPart {
  return v !== null && (TOEIC_MOCK_PARTS as readonly string[]).includes(v);
}

const EXISTS_KO = "이 파트는 이미 있어요 — 화면을 새로 읽을게요.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const partParam = new URL(req.url).searchParams.get("part");
  if (!isMockPart(partParam)) {
    return json({ ok: false, error: "invalid_input", messageKo: `만들 파트를 ?part=로 알려 주세요(${TOEIC_MOCK_PARTS.join(" · ")}).` }, 400);
  }
  const part = partParam;
  const store = getStore();

  const mock = await store.getToeicMock(id);
  if (!mock || !isRenderableToeicMock(mock)) {
    return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
  }
  if (mock.parts[part] !== null) {
    return json({ ok: false, error: "part_exists", messageKo: EXISTS_KO }, 409);
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(
      { ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 파트를 만들 수 없어요. 이미 있는 파트는 그대로 볼 수 있어요." },
      501,
    );
  }

  let value: ToeicMockPartRecordMap[ToeicMockPart];
  try {
    value = await generateMockPart(part, {
      targetGrade: mock.targetGrade,
      topicHints: mock.topicHints,
      expressions: mock.expressionsUsed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/api/toeic/mocks/${id}/regenerate] 파트 ${part} 실패:`, message.slice(0, 300));
    return json(
      { ok: false, error: "ai_failed", messageKo: `${toeicMockPartLabelKo(part)} 파트를 만들지 못했어요. 잠시 후 다시 시도해 주세요.`, retriable: true },
      500,
    );
  }

  try {
    const filled = await store.fillToeicMockPart(id, part, value);
    if (!filled) return json({ ok: false, error: "mock_not_found", messageKo: "그사이 지워진 모의고사예요." }, 404);
    if (filled.outcome === "exists") return json({ ok: false, error: "part_exists", messageKo: EXISTS_KO }, 409);
    return json({ ok: true, id, part });
  } catch (err) {
    console.error(`[/api/toeic/mocks/${id}/regenerate] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "파트를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

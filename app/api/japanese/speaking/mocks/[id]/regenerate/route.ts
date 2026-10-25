/**
 * POST /api/japanese/speaking/mocks/[id]/regenerate?part= — 빈 파트 하나 만들기 (docs/harness/japanese.md §15-9-1·§15-10-1, 호출 E)
 *
 * 입력은 처음과 같다(레코드의 level·topicHints). **빈 자리만 채운다** — 이미 있으면 409 part_exists(판정은 원자 단위 안 —
 * store.fillJaSpeakingMockPart, 두 탭이 겹쳐도 먼저 채운 파트가 남는다). 키 검사(501)는 AI 직전(존재·빈 자리 확인 뒤).
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingRegenerateResponse):
 * 200 { ok:true, id, part } · 400 invalid_input · 404 mock_not_found · 409 part_exists · 501 no_api_key · 500 ai_failed(retriable)·save_failed
 */

import { NextResponse } from "next/server";
import { generateJaSpeakingPart } from "@/lib/ai/client";
import type { JaSpeakingPartRecordMap } from "@/lib/ai/japanese/speaking-schemas";
import { JA_SPEAKING_PARTS, type JaSpeakingPart } from "@/lib/ja-speaking";
import { jaSpeakingPartLabelKo, type JaSpeakingRegenerateResponse } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

function json(body: JaSpeakingRegenerateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function isPart(v: string | null): v is JaSpeakingPart {
  return v !== null && (JA_SPEAKING_PARTS as readonly string[]).includes(v);
}

const EXISTS_KO = "이 파트는 이미 있어요 — 화면을 새로 읽을게요.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const partParam = new URL(req.url).searchParams.get("part");
  if (!isPart(partParam)) {
    return json({ ok: false, error: "invalid_input", messageKo: `만들 파트를 ?part=로 알려 주세요(${JA_SPEAKING_PARTS.join(" · ")}).` }, 400);
  }
  const part = partParam;
  const store = getStore();
  const mock = await store.getJaSpeakingMock(id);
  if (!mock || !isRenderableJaSpeakingMock(mock)) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요." }, 404);
  if (mock.parts[part] !== null) return json({ ok: false, error: "part_exists", messageKo: EXISTS_KO }, 409);

  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 파트를 만들 수 없어요. 이미 있는 파트는 그대로 볼 수 있어요." }, 501);
  }

  let value: JaSpeakingPartRecordMap[JaSpeakingPart];
  try {
    value = await generateJaSpeakingPart(part, { level: mock.level, topicHints: mock.topicHints });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/api/japanese/speaking/mocks/${id}/regenerate] 파트 ${part} 실패:`, message.slice(0, 300));
    return json({ ok: false, error: "ai_failed", messageKo: `${jaSpeakingPartLabelKo(part)} 파트를 만들지 못했어요. 잠시 후 다시 시도해 주세요.`, retriable: true }, 500);
  }

  try {
    const filled = await store.fillJaSpeakingMockPart(id, part, value);
    if (!filled) return json({ ok: false, error: "mock_not_found", messageKo: "그사이 지워진 모의고사예요." }, 404);
    if (filled.outcome === "exists") return json({ ok: false, error: "part_exists", messageKo: EXISTS_KO }, 409);
    return json({ ok: true, id, part });
  } catch (err) {
    console.error(`[/api/japanese/speaking/mocks/${id}/regenerate] 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "파트를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

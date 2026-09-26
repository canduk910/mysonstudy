/**
 * POST /api/english/talk/[id]/explain — 자유대화 **문장 설명**(호출 I) (docs/harness/english.md §12-3, SPEC §21-2 6)
 *
 * 대화 보기에서 문장 하나를 탭하면 `{turnIndex, sentenceIndex}`만 보낸다 — **문장·문맥은 서버가** 저장된 대화에서 꺼낸다
 * (`pickTalkSentence` → `explainTalkSentence`, 클라이언트가 문장을 보내지 않는다).
 *
 * 순서(과금을 막는 쪽이 먼저):
 * 1. 본문·id 형식 → 400/404
 * 2. 대화 읽기 + 렌더 판정(`isRenderableTalkSession`) → 404
 * 3. 범위 밖 번호(`pickTalkSentence` null) → 400 **과금 전에**
 * 4. 같은 문장의 설명이 이미 있으면 그것을 돌려준다(cached:true) — **AI 0회, 키가 없어도 된다**(두 번 탭해도 한 번 과금)
 * 5. 키 없음 → 501
 * 6. 호출 I(재요청 1회는 callWithSchema가) → 실패 500
 * 7. 저장: "같은 키가 없을 때만 append"(스토어 원자 단위 — 파일 mutate·Firestore 트랜잭션). 다른 탭이 먼저 저장했으면 그 설명을
 *    돌려준다(exists). 설명 상한이면 저장 없이 이번 설명만 돌려준다(saved:false).
 *
 * 응답(lib/talk-contract.ts `TalkExplainResponse`):
 * - 200 { ok:true, explanation, cached, saved }
 * - 400 { ok:false, error:"invalid_input"|"sentence_not_found", messageKo, issues? }
 * - 404 { ok:false, error:"talk_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"explain_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { explainTalkSentence } from "@/lib/ai/client";
import { getStore } from "@/lib/store";
import type { TalkExplainRequest, TalkExplainResponse } from "@/lib/talk-contract";
import { findTalkExplanation } from "@/lib/talk-normalize";
import { isRenderableTalkSession } from "@/lib/talk-record";
import { isFirestoreDocId } from "@/lib/reorder-contract";
import { pickTalkSentence } from "@/lib/talk-transcript";

export const runtime = "nodejs";

const bodySchema = z.object({
  turnIndex: z.number().int().min(0).max(10_000),
  sentenceIndex: z.number().int().min(0).max(10_000),
});
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [TalkExplainRequest, BodyInput] extends [BodyInput, TalkExplainRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkExplainResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "고른 문장 번호를 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { turnIndex, sentenceIndex } = parsed.data;

  if (!isFirestoreDocId(id)) return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요." }, 404);
  const store = getStore();
  const record = await store.getTalkSession(id);
  if (!isRenderableTalkSession(record)) {
    return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요. 지워졌을 수 있어요." }, 404);
  }

  // 범위 밖 번호 — 과금 전에(explainTalkSentence도 같은 함수로 던지지만, 그 전에 400으로 가른다)
  if (!pickTalkSentence(record.turns, turnIndex, sentenceIndex)) {
    return json({ ok: false, error: "sentence_not_found", messageKo: "그 문장을 찾지 못했어요." }, 400);
  }

  // 같은 문장의 설명이 이미 있으면 재사용 — AI 0회(키 검사보다 먼저: 키가 없어도 저장된 설명은 보인다)
  const existing = findTalkExplanation(record, turnIndex, sentenceIndex);
  if (existing) return json({ ok: true, explanation: existing, cached: true, saved: true });

  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 설정되지 않아 설명을 만들 수 없어요." }, 501);
  }

  let result;
  try {
    result = await explainTalkSentence({ topicLabel: record.topic.labelKo, turns: record.turns, turnIndex, sentenceIndex });
  } catch (err) {
    console.error(`[/api/english/talk/${id}/explain] 호출 I 실패`, err instanceof Error ? err.message.slice(0, 200) : err);
    return json({ ok: false, error: "explain_failed", messageKo: "설명을 만들지 못했어요. 잠시 후 다시 눌러 볼까요?" }, 500);
  }

  const explanation = { ...result, createdAt: new Date().toISOString() };
  try {
    const saved = await store.addTalkExplanation(id, explanation);
    if (!saved) return json({ ok: false, error: "talk_not_found", messageKo: "대화를 찾지 못했어요. 지워졌을 수 있어요." }, 404);
    if (saved.outcome === "full") return json({ ok: true, explanation, cached: false, saved: false });
    // exists = 다른 탭·연타가 먼저 저장했다 → 먼저 저장된 설명을 보인다(기록과 화면이 같게)
    return json({ ok: true, explanation: saved.explanation, cached: saved.outcome === "exists", saved: true });
  } catch (err) {
    // 저장이 실패해도 이미 과금한 설명은 보여 준다(다음 탭은 다시 만든다)
    console.error(`[/api/english/talk/${id}/explain] 설명 저장 실패`, err instanceof Error ? err.message : err);
    return json({ ok: true, explanation, cached: false, saved: false });
  }
}

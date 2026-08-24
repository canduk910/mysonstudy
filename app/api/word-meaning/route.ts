/**
 * POST /api/word-meaning — 챕터 리더 단어 더블탭 뜻 조회 (M2 · 호출 G, docs/harness/english.md §10)
 *
 * 챕터 리더의 영어 문장에서 은우가 더블탭한 **단어**와 그 단어가 속한 **문장(맥락)**을 받아,
 * 호출 G(`lookupWordMeaning`)로 그 문맥에서의 짧은 우리말 뜻을 돌려준다. 다의어는 문장 맥락의
 * 뜻을 고른다(예: "Turn left." → "왼쪽" / "She left." → "떠났다").
 *
 * ── 판독 실패가 아니라 뜻 조회다 ────────────────────────────────────────────
 * 실패는 화면이 비치명 안내로 받는다(단어 담기는 별도 동작이라 뜻 실패로 막히지 않는다).
 * 상태코드는 `lib/word-meaning-contract.ts`가 단일 정의처:
 * - 400 invalid_input  — 단어/문장 누락·형식 오류(zod 방어)
 * - 501 no_api_key     — 서버에 OPENAI_API_KEY 없음. **실호출 전 구조적 거절**(로컬 실호출 차단, ai-harness-impl 규약)
 * - 500 ai_failed      — 호출 G 재요청 소진(throw). 재시도 가치 있음
 * - 200 { ok:true, word, meaningKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { lookupWordMeaning } from "@/lib/ai/client";
import { VOCAB_WORD_MAX } from "@/lib/ai/english/vocabbook-schemas";
import type { WordMeaningResponse } from "@/lib/word-meaning-contract";

export const runtime = "nodejs";

// 단어는 표제어 하나(길이 상한은 단어장 표제어와 같은 값). 문장은 챕터 자막 한 문장 — 넉넉히 2000자.
const bodySchema = z.object({
  word: z.string().trim().min(1, "단어가 비어 있어요").max(VOCAB_WORD_MAX),
  sentence: z.string().trim().min(1, "문장이 비어 있어요").max(2000),
});

function json(body: WordMeaningResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // ── 본문 검증 (400) ──
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." },
      400,
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "단어와 문장을 모두 보내 주세요.",
      },
      400,
    );
  }

  // ── 키 없음 (501) — 실호출 전에 구조적으로 거절(add-word 라우트와 같은 관문). ──
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "지금은 뜻을 불러올 수 없어요(서버 준비 중). 발음은 그대로 들을 수 있어요.",
      },
      501,
    );
  }

  const { word, sentence } = parsed.data;
  try {
    const { meaningKo } = await lookupWordMeaning(word, sentence);
    return json({ ok: true, word, meaningKo }, 200);
  } catch (err) {
    console.error("[/api/word-meaning] 뜻 조회 실패:", err);
    return json(
      { ok: false, error: "ai_failed", messageKo: "뜻을 불러오지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

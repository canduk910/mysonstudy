/**
 * POST /api/english/vocab/[id]/suggest-related — 유의어/반의어 후보 추천 (호출 H · docs/harness/english.md §11)
 *
 * 그 단어의 한 뜻(meaningKo)에 맞는 실제 영어 유의어(또는 반의어) 후보를 **AI(호출 H)** 로 받아 화면에 준다.
 * 사진 없는 텍스트 단일 호출이다. 후보는 lib/ai가 이미 청소한다(표제어 자신·중복·굴절형 제외) — 화면은 그대로 칩으로.
 *
 * 이 라우트는 **후보만 돌려준다** — 실제 추가·연결은 사용자가 하나를 고른 뒤 `add-related`가 한다(스토어 무변경).
 * 그래서 AI 호출은 여기 한 번뿐이고, 저장 계층을 건드리지 않는다(prod-guard 무관 — 읽기·추천만).
 *
 * ── AI 실패 처리(스킬 "라우트 연결" 규약) ──────────────────────────────────────
 * - 키 없음(OPENAI_API_KEY 미설정) → **501 no_api_key**. 추천은 AI가 필수라 진행 불가(add-word의 501과 같은 자리).
 * - 호출 H throw(재요청 소진) → **500 suggest_failed**(재시도 가치 있음 — 화면은 "다시" 버튼).
 * - 판독 실패가 정상 흐름인 extract와 달리, 추천은 성공/키없음/실패 셋뿐이라 200-폴백 신호가 없다.
 *
 * 응답 shape (단일 정의처는 `lib/vocab-link-contract.ts`):
 * - 200 { ok:true, candidates:[{word, glossKo}] }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"suggest_failed", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { suggestRelatedWords } from "@/lib/ai/client";
import { VOCAB_MEANING_KO_MAX } from "@/lib/ai/english/vocabbook-schemas";
import type { VocabSuggestRelatedResponse } from "@/lib/vocab-link-contract";
import { RELATION_QUIZ_KINDS } from "@/lib/vocab-quiz";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  word: z.string().trim().min(1, "단어가 비어 있어요").max(VOCAB_LIMITS.word),
  meaningKo: z.string().trim().min(1, "뜻이 비어 있어요").max(VOCAB_MEANING_KO_MAX),
  kind: z.enum(RELATION_QUIZ_KINDS),
});

function json(body: VocabSuggestRelatedResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // ── 본문 검증 (400) ──
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
        messageKo: "추천 요청을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }

  // ── 대상 단어장 존재·렌더 가능 (404) — 상세/보강과 같은 함수. ──
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
  }

  // ── 키 없음 (501) — 추천은 AI 필수. 키 검사를 호출 앞에 두어 실호출을 구조적으로 막는다. ──
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "추천을 받으려면 OpenAI API 키가 필요해요. 직접 입력으로 단어를 이어 줄 수도 있어요.",
      },
      501,
    );
  }

  // ── 호출 H — 실패면 500(재시도 가치 있음). ──
  try {
    const { word, meaningKo, kind } = parsed.data;
    const result = await suggestRelatedWords({ word, meaningKo, kind });
    return json({ ok: true, candidates: result.candidates });
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/suggest-related] 추천 실패:`, err);
    return json(
      { ok: false, error: "suggest_failed", messageKo: "후보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

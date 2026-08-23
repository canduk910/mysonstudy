/**
 * POST /api/english/vocab/[id]/add-word — 모르는 단어를 현재 DAY에 담기 (V8 · docs/harness/english.md §8)
 *
 * 정의(EN)·예문(EN) 텍스트에서 은우가 더블탭한 단어를 **경로의 DAY 단어장**에 새 항목으로 붙이고,
 * 붙이는 즉시 호출 D(enrichVocab)로 그 단어의 영영정의·우리말해석·이모지를 만들어 채운다. 사진이
 * 필요 없다 — 보강(/enrich)과 같은 텍스트 호출 D를 **단어 1개에 재사용**한다(새 프롬프트·스키마 없음).
 *
 * ── 단어 유실 금지(best-effort) — 이 라우트의 제1원칙 ──────────────────────────
 * 주목적은 **단어를 담는 것**이고 뜻 생성은 부수적이다. 그래서 뜻 생성이 실패해도 단어는 남긴다:
 * - 호출 D throw(재요청 소진) → 단어를 뜻 null로 저장하고 200(`enrichSkipped:"enrich_failed"`).
 * - API 키 없음 → 단어를 뜻 null로 저장하고 **501 + `added:true`**(enrich 라우트 no_api_key 관용구와
 *   맞추되 단어는 잃지 않는다 — 화면은 added:true로 refresh, "뜻은 나중에" 안내).
 *
 * ── 정의 불변(계획 §V3)을 우회하지 않는다 ──────────────────────────────────────
 * 새 단어의 뜻도 반드시 `enrichVocab([entry])` → `mergeEnrichment([entry], items)`를 거쳐 채운다
 * (EN 불변·null 자리에만 채움 규칙의 단일 정의처). 이 파일은 정의를 직접 손대지 않는다.
 *
 * ── 중복 방지 ──────────────────────────────────────────────────────────────
 * 대소문자 무시 word 비교로 이미 있으면 담지 않는다. 1차로 여기서(호출 D 낭비 방지), 최종은
 * `store.appendVocabEntry`가 원자적으로 다시 확인한다(load~append 사이 경합 방어). 둘 다 `added:false`.
 *
 * 응답 shape (단일 정의처는 `lib/vocab-add-word-contract.ts`):
 * - 200 { ok:true, id, word, added:true,  definitionFilled, enrichSkipped }   ← 새로 담음
 * - 200 { ok:true, id, word, added:false, definitionFilled:false, enrichSkipped:null } ← 중복
 * - 400 { ok:false, error:"invalid_word", messageKo }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo, added:true }   ← 단어는 저장됨(뜻 null)
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { enrichVocab } from "@/lib/ai/client";
import { mergeEnrichment } from "@/lib/ai/english/vocabbook-enrich";
import type { VocabEntry } from "@/lib/ai/english/vocabbook-schemas";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import type { VocabAddWordResponse } from "@/lib/vocab-add-word-contract";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// 영문 단어 하나 — 알파벳으로 시작하고, 내부에만 아포스트로피/하이픈 허용(don't · well-known).
// 숫자·기호·비라틴은 거른다. 토큰에서 앞뒤 구두점은 화면이 이미 벗겨 보내지만 서버도 다시 방어한다.
const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

const bodySchema = z.object({
  word: z
    .string()
    .trim()
    .min(1, "담을 단어가 비어 있어요")
    .max(VOCAB_LIMITS.word, `단어는 최대 ${VOCAB_LIMITS.word}자예요`)
    .regex(WORD_PATTERN, "영어 단어만 담을 수 있어요"),
});

function json(body: VocabAddWordResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 새로 담는 단어의 완성형 VocabEntry — (B) 창작 필드는 null로 열고 호출 D가 채운다(required-nullable 규약). */
function newVocabEntry(word: string): VocabEntry {
  return {
    // (A) 책 전사 — 손으로 담은 단어라 교재 번호(no)·발음기호·뜻·예문·관련어가 없다(전부 빈/ null).
    no: null,
    word,
    ipa: null,
    pos: [],
    meanings: [],
    examples: [],
    related: [],
    // (B) AI 창작 — enrich 결과로 채운다. 실패하면 null 그대로("다시 만들기"가 나중에 채움).
    definitionEn: null,
    definitionKo: null,
    imageEmoji: null,
    imageSvg: null,
    // (C) 앱 부착 — 사진에서 나온 게 아니라 사용자가 담은 것. 신뢰도 high, 첫 사진 자리.
    photoIndex: 0,
    confidence: "high",
    partial: false,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // ── 본문 검증 (400) ──
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(
      { ok: false, error: "invalid_word", messageKo: "요청 본문이 올바른 JSON이 아니에요." },
      400,
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_word",
        messageKo: parsed.error.issues[0]?.message ?? "담을 단어를 확인해 주세요.",
      },
      400,
    );
  }
  const word = parsed.data.word;

  // ── 대상 단어장 존재·렌더 가능 (404) ──
  // 존재·렌더 판정은 상세/보강과 **같은 함수**(lib/vocabbook-record.ts) — 담을 곳이 정말 열리는 곳이어야.
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }

  // ── 1차 중복 검사 (호출 D 낭비 방지) — 이미 있으면 담지 않고 안내만. 최종 확인은 store가 다시 한다. ──
  const key = word.toLowerCase();
  if (record.entries.some((e) => e.word.trim().toLowerCase() === key)) {
    return json({
      ok: true,
      id,
      word,
      added: false,
      definitionFilled: false,
      enrichSkipped: null,
    });
  }

  const base = newVocabEntry(word);

  // ── 키 없음 (501) — 단어는 뜻 null로 저장한다(단어 유실 금지). enrich는 아예 시도하지 않는다. ──
  if (!process.env.OPENAI_API_KEY) {
    const appended = await store.appendVocabEntry(id, base);
    if (!appended.record) {
      return json(
        { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
        404,
      );
    }
    if (!appended.appended) {
      // load~append 사이에 같은 단어가 들어온 경합 — 중복으로 정직하게 안내(단어는 안 담김).
      return json({ ok: true, id, word, added: false, definitionFilled: false, enrichSkipped: null });
    }
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "단어는 담았어요! OpenAI API 키가 설정되면 '다시 만들기'로 뜻을 채울 수 있어요.",
        added: true,
      },
      501,
    );
  }

  // ── 호출 D로 뜻 생성 (best-effort) — 실패해도 단어는 뜻 null로 담는다. ──
  // enrichVocab([base]) → mergeEnrichment([base], items)로 EN 불변·null 자리에만 채우기 규칙을 재사용한다.
  let entry = base;
  let enrichSkipped: "enrich_failed" | null = null;
  try {
    const items = await enrichVocab([base]);
    entry = mergeEnrichment([base], items).entries[0] ?? base;
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/add-word] 보강 실패(비치명):`, err);
    enrichSkipped = "enrich_failed";
  }

  // ── 저장 — 수정이라 prod-guard가 걸리지 않는다. store가 최종 중복 검사를 원자적으로 한다. ──
  const appended = await store.appendVocabEntry(id, entry);
  if (!appended.record) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }
  if (!appended.appended) {
    return json({ ok: true, id, word, added: false, definitionFilled: false, enrichSkipped: null });
  }

  return json({
    ok: true,
    id,
    word,
    added: true,
    definitionFilled: entry.definitionEn !== null,
    enrichSkipped,
  });
}

/**
 * POST /api/english/vocab/[id]/add-related — 고른 유의어/반의어를 단어장에 반영 (V8 재작업 · docs/harness/english.md §11)
 *
 * 사용자가 추천(호출 H) 또는 직접 입력으로 고른 (word·glossKo)를 단어장에 잇는다. 두 갈래다:
 *   1. word가 **이미 단어장에 있으면**(대소문자 무시) → 그 엔트리로 **연결만**(중복 추가 없음). 대상 뜻은
 *      glossKo와 맞는 뜻이 있으면 그것, 없으면 0.
 *   2. **없으면** → `appendVocabEntry`로 **새 항목 추가**(뜻 하나 ko=glossKo) → `enrichVocab` **자동 보강**
 *      (호출 D, best-effort) → `linkVocabRelated`로 source 뜻 ↔ 새 엔트리 뜻[0] **상호 연결**.
 *
 * ── 단어 유실 금지 / 추가·연결 우선(best-effort) ─────────────────────────────
 * 주목적은 **잇는 것**이고 보강은 부수적이다(add-word와 같은 철학). 보강이 실패해도, 키가 없어도 **단어 추가와
 * 연결은 유지**한다 — 보강만 건너뛰고 `enrichSkipped`로 알린다(뜻은 나중에 "다시 만들기"로 채운다). 그래서
 * 이 라우트는 키가 없어도 200이다(연결은 AI가 필요 없다 — glossKo가 이미 뜻이다). 이 점이 suggest(501)와 다르다.
 *
 * ── 정의 불변(계획 §V3)을 우회하지 않는다 ─────────────────────────────────────
 * 새 단어 보강도 `enrichVocab([entry])` → `mergeEnrichment`를 거친다(EN 불변·null 자리에만 채움 단일 정의처).
 * 연결은 이미 만든 순수 함수 `applyVocabLink`(store.linkVocabRelated)를 그대로 쓴다 — 상호 기록·멱등 재사용.
 *
 * 응답 shape (단일 정의처는 `lib/vocab-link-contract.ts`):
 * - 200 { ok:true, added, linked, enrichSkipped }   ← added:true=새로 추가, false=이미 있어 연결만
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }   ← zod·source 범위·자기 자신·기존 대상 뜻 없음
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 500 { ok:false, error:"save_failed", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { enrichVocab } from "@/lib/ai/client";
import { mergeEnrichment } from "@/lib/ai/english/vocabbook-enrich";
import { VOCAB_MEANING_KO_MAX, type VocabEntry } from "@/lib/ai/english/vocabbook-schemas";
import type { VocabAddRelatedResponse } from "@/lib/vocab-link-contract";
import { RELATION_QUIZ_KINDS } from "@/lib/vocab-quiz";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// 영문 단어 하나 — add-word 라우트와 같은 규약(알파벳 시작, 내부에만 아포스트로피/하이픈).
const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

const bodySchema = z.object({
  sourceIndex: z.number().int().min(0),
  sourceMeaningIndex: z.number().int().min(0),
  chosen: z.object({
    word: z
      .string()
      .trim()
      .min(1, "단어가 비어 있어요")
      .max(VOCAB_LIMITS.word)
      .regex(WORD_PATTERN, "영어 단어만 이을 수 있어요"),
    glossKo: z.string().trim().min(1, "뜻을 입력해 주세요").max(VOCAB_MEANING_KO_MAX),
  }),
  kind: z.enum(RELATION_QUIZ_KINDS),
});

function json(body: VocabAddRelatedResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 대상 엔트리에서 glossKo와 맞는 뜻 인덱스 — 정확히 같은 ko가 있으면 그것, 없으면 0(대표 뜻). */
function matchMeaningIndex(entry: { meanings: { ko: string }[] }, glossKo: string): number {
  const g = glossKo.trim();
  const idx = entry.meanings.findIndex((m) => m.ko.trim() === g);
  return idx >= 0 ? idx : 0;
}

/** 새로 잇는 단어의 완성형 VocabEntry — 뜻 하나(ko=glossKo). (B) 창작 필드는 null로 열고 호출 D가 채운다. */
function newRelatedEntry(word: string, glossKo: string): VocabEntry {
  return {
    no: null,
    word,
    ipa: null,
    pos: [],
    meanings: [{ no: null, ko: glossKo, related: [] }],
    examples: [],
    related: [],
    definitionEn: null,
    definitionKo: null,
    imageEmoji: null,
    imageSvg: null,
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
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "연결 정보를 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  const { sourceIndex, sourceMeaningIndex, chosen, kind } = parsed.data;

  // ── 대상 단어장 존재·렌더 가능 (404) ──
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
  }

  // ── source 위치 방어 (400) — 최종 검증은 applyVocabLink(store)도 다시 한다. ──
  const source = record.entries[sourceIndex];
  if (!source || !source.meanings[sourceMeaningIndex]) {
    return json(
      { ok: false, error: "invalid_input", messageKo: "연결을 걸 단어의 뜻을 찾지 못했어요. 목록을 새로고침해 주세요." },
      400,
    );
  }

  const key = chosen.word.trim().toLowerCase();
  const existingIdx = record.entries.findIndex((e) => e.word.trim().toLowerCase() === key);

  // ── 1) 이미 있는 단어 → 연결만 ──────────────────────────────────────────────
  if (existingIdx >= 0) {
    if (existingIdx === sourceIndex) {
      return json(
        { ok: false, error: "invalid_input", messageKo: "같은 단어끼리는 이을 수 없어요." },
        400,
      );
    }
    const target = record.entries[existingIdx];
    if (target.meanings.length === 0) {
      return json(
        {
          ok: false,
          error: "invalid_input",
          messageKo: `"${target.word}"는 이미 단어장에 있지만 뜻이 없어 이을 수 없어요. 먼저 그 단어의 뜻을 만들어 주세요.`,
        },
        400,
      );
    }
    const targetMeaningIndex = matchMeaningIndex(target, chosen.glossKo);
    return finishLink(store, id, sourceIndex, sourceMeaningIndex, existingIdx, targetMeaningIndex, kind, false, null);
  }

  // ── 2) 없는 단어 → 새로 추가 + 자동 보강(best-effort) + 연결 ──────────────────
  let entry = newRelatedEntry(chosen.word.trim(), chosen.glossKo.trim());
  let enrichSkipped: "enrich_failed" | "no_api_key" | null = null;

  if (process.env.OPENAI_API_KEY) {
    try {
      const items = await enrichVocab([entry]);
      entry = mergeEnrichment([entry], items).entries[0] ?? entry;
    } catch (err) {
      // 보강 실패는 비치명 — 단어는 뜻(glossKo)만 가진 채 추가·연결된다(단어 유실 0).
      console.error(`[/api/english/vocab/${id}/add-related] 보강 실패(비치명):`, err);
      enrichSkipped = "enrich_failed";
    }
  } else {
    // 키 없음 — 보강만 생략하고 추가·연결은 그대로(연결은 AI가 필요 없다).
    enrichSkipped = "no_api_key";
  }

  const appended = await store.appendVocabEntry(id, entry);
  if (!appended.record) {
    return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
  }
  // 새 항목의 현재 인덱스(append는 맨 뒤에 붙는다). 경합으로 같은 단어가 먼저 들어왔으면 그 인덱스로 연결한다.
  const newIdx = appended.record.entries.findIndex((e) => e.word.trim().toLowerCase() === key);
  if (newIdx < 0) {
    return json({ ok: false, error: "save_failed", messageKo: "단어를 추가하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
  const targetEntry = appended.record.entries[newIdx];
  const targetMeaningIndex = matchMeaningIndex(targetEntry, chosen.glossKo);
  // appended.appended=false면 경합 중복(이미 있던 단어) — 추가는 아니지만 연결은 한다(added:false, enrich 무의미→null).
  return finishLink(
    store,
    id,
    sourceIndex,
    sourceMeaningIndex,
    newIdx,
    targetMeaningIndex,
    kind,
    appended.appended,
    appended.appended ? enrichSkipped : null,
  );
}

/** 공용 마무리 — store.linkVocabRelated(상호 기록·멱등)로 잇고 status를 응답으로 옮긴다. */
async function finishLink(
  store: ReturnType<typeof getStore>,
  id: string,
  sourceIndex: number,
  sourceMeaningIndex: number,
  targetIndex: number,
  targetMeaningIndex: number,
  kind: "synonym" | "antonym",
  added: boolean,
  enrichSkipped: "enrich_failed" | "no_api_key" | null,
): Promise<Response> {
  try {
    const result = await store.linkVocabRelated(id, {
      sourceIndex,
      sourceMeaningIndex,
      targetIndex,
      targetMeaningIndex,
      kind,
    });
    if (result.status === "not_found") {
      return json({ ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." }, 404);
    }
    if (result.status === "invalid") {
      return json(
        { ok: false, error: "invalid_input", messageKo: "이을 수 없는 단어예요. 목록을 새로고침해 주세요." },
        400,
      );
    }
    return json({ ok: true, added, linked: true, enrichSkipped });
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/add-related] 연결 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

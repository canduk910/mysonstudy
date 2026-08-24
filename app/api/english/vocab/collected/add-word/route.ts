/**
 * POST /api/english/vocab/collected/add-word — 챕터 리더에서 더블탭한 단어를 "모은 단어" 단어장에 담기
 * (M2, docs/harness/english.md §10 후속 · 계획 M2)
 *
 * DAY 단어장의 add-word(호출 D로 뜻 생성)와 달리, 이 라우트는 화면이 **이미 호출 G로 확보한 뜻
 * (meaningKo)**을 함께 받으므로 **AI를 호출하지 않는다.** "모은 단어" 수집 단어장을 get-or-create해
 * 그 단어를 붙일 뿐이다. 단어장 정복 뷰·시험·오답노트를 DAY 단어장과 그대로 재사용한다.
 *
 * ── "모은 단어" 단어장 ─────────────────────────────────────────────────────
 * 앱 전체에 딱 하나. `dayLabel === COLLECTED_VOCAB_DAY_LABEL`로 식별되는 단일 단어장이며(rename에
 * 불변, `lib/collected-vocab-contract.ts` 참고), 없으면 이 라우트가 첫 담기에서 만든다.
 *
 * ── 중복 방지 ──────────────────────────────────────────────────────────────
 * 대소문자 무시 word 비교로 이미 있으면 담지 않는다(`store.appendVocabEntry`가 원자적으로 판정).
 * 중복은 `added:false`로 알린다(화면: "이미 있어요").
 *
 * 응답 shape 단일 정의처: `lib/collected-vocab-contract.ts`
 * - 200 { ok:true,  id, word, added }                  ← added:true 새로 담음 / added:false 중복
 * - 400 { ok:false, error:"invalid_input", messageKo } ← 단어·뜻 누락·형식 오류
 * - 500 { ok:false, error:"store_failed",  messageKo } ← 저장 계층 오류(방어)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { VocabEntry } from "@/lib/ai/english/vocabbook-schemas";
import { VOCAB_MEANING_KO_MAX, VOCAB_WORD_MAX } from "@/lib/ai/english/vocabbook-schemas";
import type { CollectedAddWordResponse } from "@/lib/collected-vocab-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// 영문 단어 하나 — DAY add-word와 같은 패턴. 알파벳 시작 + 내부에만 아포스트로피/하이픈(don't · well-known).
const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

const bodySchema = z.object({
  word: z
    .string()
    .trim()
    .min(1, "담을 단어가 비어 있어요")
    .max(VOCAB_WORD_MAX, `단어는 최대 ${VOCAB_WORD_MAX}자예요`)
    .regex(WORD_PATTERN, "영어 단어만 담을 수 있어요"),
  meaningKo: z
    .string()
    .trim()
    .min(1, "뜻이 비어 있어요")
    .max(VOCAB_MEANING_KO_MAX, `뜻은 최대 ${VOCAB_MEANING_KO_MAX}자예요`),
});

function json(body: CollectedAddWordResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/**
 * 더블탭으로 담는 단어의 완성형 VocabEntry (required-nullable 규약).
 * 뜻은 화면이 넘긴 meaningKo를 그 자리에 넣는다 — (A) 책 전사 뜻 자리(meanings[].ko)에 담아
 * 정복 뷰·시험이 그대로 읽게 한다. (B) AI 창작 필드(definitionEn 등)는 null로 열어 둔다
 * (나중에 "다시 만들기"로 채울 수 있다).
 */
function newCollectedEntry(word: string, meaningKo: string): VocabEntry {
  return {
    no: null,
    word,
    ipa: null,
    pos: [],
    meanings: [{ no: null, ko: meaningKo, related: [] }],
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
        messageKo: parsed.error.issues[0]?.message ?? "담을 단어와 뜻을 확인해 주세요.",
      },
      400,
    );
  }
  const { word, meaningKo } = parsed.data;

  const store = getStore();
  try {
    // get-or-create + append. 생성이라 prod-guard가 걸리지 않는다(삭제가 아니다).
    const book = await store.getOrCreateCollectedVocabBook();
    const appended = await store.appendVocabEntry(book.id, newCollectedEntry(word, meaningKo));
    if (!appended.record) {
      // get-or-create 직후라 정상 흐름에선 도달하지 않지만, 없어진 경우를 방어한다.
      return json(
        { ok: false, error: "store_failed", messageKo: "단어장을 열 수 없었어요. 잠시 후 다시 시도해 주세요." },
        500,
      );
    }
    return json({ ok: true, id: book.id, word, added: appended.appended }, 200);
  } catch (err) {
    console.error("[/api/english/vocab/collected/add-word] 담기 실패:", err);
    return json(
      { ok: false, error: "store_failed", messageKo: "단어를 담지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

/**
 * POST /api/english/vocab — 단어장 저장 (V1, english.md §7-6)
 *
 * 검토 화면이 병합·편집·"빼기"를 끝낸 `VocabEntry[]`를 받아 zod로 검증하고 스토어에 저장한다.
 * **사진은 저장하지 않는다**(§7-6 · SPEC §5) — 텍스트만 남긴다. **V1은 정의·이모지 없이**
 * 저장한다(`enriched: false`) — 그건 V3 호출 D의 몫이다.
 *
 * `titleKo`가 비면 `dayLabel`이나 기본 이름으로 채운다(§5 스펙 공백 — 페이지 사진에 책 제목이
 * 없을 수 있어 앱이 이름을 정한다). 판독은 별도 요청(`/extract`)에서 이미 끝났으므로 이 라우트는
 * **AI를 호출하지 않는다** — 키가 없어도 저장은 되어야 한다(키 검사를 두지 않는 이유).
 *
 * 응답 shape (단일 정의처는 `lib/vocab-create-contract.ts`):
 * - 200 { ok:true, id }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveModel } from "@/lib/ai/client";
import {
  PARTS_OF_SPEECH,
  RELATED_KINDS,
  VOCAB_CONFIDENCE_LEVELS,
} from "@/lib/ai/english/vocabbook-schemas";
import { VOCAB_LIMITS, type VocabCreateResponse } from "@/lib/vocab-create-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/**
 * 완성형 `VocabEntry`의 zod — 판독 zod(`vocabExtractionSchema`)와 shape이 다르다(그건
 * `isVocabPage` 게이트가 있는 페이지 출력, 이건 (B)·(C)까지 굳은 저장 단위). 그래서 여기서
 * 새로 짓되, enum·길이 상수는 판독 zod와 **같은 단일 정의처**를 끌어다 쓴다.
 *
 * 편집을 거친 값이라 관대하게 둔다 — 개별 뜻·예문의 `min(1)`을 강제하지 않는다(사용자가 편집 중
 * 잠깐 빈 줄을 남길 수 있다). 빈 값 정리는 화면이 보내기 전에 하고, 저장 계층의
 * `normalizeVocabEntry`가 undefined를 마지막으로 조인다.
 */
const entrySchema = z.object({
  no: z.string().trim().max(VOCAB_LIMITS.no).nullable(),
  word: z.string().trim().min(1, "단어는 비울 수 없어요").max(VOCAB_LIMITS.word),
  ipa: z.string().trim().max(VOCAB_LIMITS.ipa).nullable(),
  pos: z.array(z.enum(PARTS_OF_SPEECH)).max(VOCAB_LIMITS.pos),
  meaningsKo: z.array(z.string().trim().max(VOCAB_LIMITS.meaningKo)).max(VOCAB_LIMITS.meanings),
  examples: z
    .array(
      z.object({
        en: z.string().trim().max(VOCAB_LIMITS.exampleEn),
        ko: z.string().trim().max(VOCAB_LIMITS.exampleKo),
      }),
    )
    .max(VOCAB_LIMITS.examples),
  related: z
    .array(
      z.object({
        kind: z.enum(RELATED_KINDS),
        word: z.string().trim().max(VOCAB_LIMITS.relatedWord),
        glossKo: z.string().trim().max(VOCAB_LIMITS.relatedGloss).nullable(),
      }),
    )
    .max(VOCAB_LIMITS.related),
  // (B) AI 창작 — V1에서는 null로 온다. V3 호출 D가 채우기 전이라 값이 있어도 여기선 그대로 받아 둔다.
  definitionEn: z.string().trim().max(VOCAB_LIMITS.definitionEn).nullable(),
  imageEmoji: z.string().nullable(),
  imageSvg: z.string().nullable(),
  // (C) 앱 부착
  photoIndex: z.number().int().min(0),
  confidence: z.enum(VOCAB_CONFIDENCE_LEVELS),
  partial: z.boolean(),
});

const bodySchema = z.object({
  titleKo: z.string().trim().max(VOCAB_LIMITS.titleKo).nullish(),
  dayLabel: z.string().trim().max(VOCAB_LIMITS.dayLabel).nullish(),
  photoCount: z.number().int().min(0).max(VOCAB_LIMITS.photos).nullish(),
  entries: z
    .array(entrySchema)
    .min(1, "저장할 단어가 없어요")
    .max(VOCAB_LIMITS.entriesPerBook, `단어는 한 번에 최대 ${VOCAB_LIMITS.entriesPerBook}개까지예요`),
});

function json(body: VocabCreateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(
      { ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] },
      400,
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "저장할 내용을 확인해 주세요.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const input = parsed.data;
  const dayLabel = input.dayLabel?.trim() || null;
  // 이름 폴백: 사용자 입력 → dayLabel → 기본 이름 (§5 스펙 공백)
  const titleKo = input.titleKo?.trim() || dayLabel || "단어장";

  try {
    const record = await getStore().createVocabBook({
      titleKo,
      dayLabel,
      // 저장 계층(normalizeVocabEntry)이 마지막으로 undefined를 조인다 — 여기선 검증분 그대로 넘긴다
      entries: input.entries,
      photoCount: input.photoCount ?? 0,
      enriched: false, // V1은 정의·이모지 없이 저장 — V3 호출 D가 채운다
      model: resolveModel(),
    });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error("[/api/english/vocab] 단어장 저장 실패:", err);
    return json(
      { ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

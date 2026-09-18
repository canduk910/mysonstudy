/**
 * POST /api/japanese/kanji/enrich — 한자 정보 생성 (호출 D · docs/harness/japanese.md §12-2)
 *
 * 사용자가 따로 만들지 않는다 — **저장된 JLPT 단어장 전체에서 한자를 수집**하고(§12-1), **아직 정보가 없는 한자만**
 * 채운다(불변 규약 §12-2). 한 번에 10자씩 배치(JA_KANJI_BATCH_SIZE)로 병렬 호출하고 부분 실패를 격리한다. AI 결과는
 * 저장 계층(별도 컬렉션 jaKanji)에 **insert-only**로 저장한다(이미 있는 한자는 덮어쓰지 않는다, §12-2 불변).
 * 한자가 든 단어 목록은 저장하지 않는다(읽을 때 계산, §12-1).
 *
 * 응답 shape (단일 정의처는 `lib/japanese-kanji-contract.ts`):
 * - 200 { ok:true, filled, missingKanji, droppedCount, batches:[{failed,droppedCount,missingKanji}], nothingToFill }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"enrich_failed", messageKo }   ← 전 배치 실패
 */

import { NextResponse } from "next/server";
import { generateKanjiInfo, resolveModel } from "@/lib/ai/client";
import { JA_KANJI_BATCH_SIZE } from "@/lib/ai/japanese/schemas";
import {
  applyKanjiPostprocess,
  collectKanjiFromBooks,
  selectKanjiToEnrich,
} from "@/lib/ai/japanese/kanji";
import type { JaKanjiEnrichBatch, JaKanjiEnrichResponse } from "@/lib/japanese-kanji-contract";
import type { NewJaKanji } from "@/lib/store";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

function json(body: JaKanjiEnrichResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST() {
  const store = getStore();

  // ── 키 없음 (501) — 생성은 AI 필수. 검사를 호출 앞에 둬 실호출을 구조적으로 막는다. ──
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "한자 정보를 만들려면 OpenAI API 키가 필요해요." }, 501);
  }

  // ── 수집 → 정보 없는 한자만 선별(§12-1·§12-2 불변) ──
  const [books, existing] = await Promise.all([store.listJaVocabBooks(), store.listJaKanji()]);
  const collected = collectKanjiFromBooks(books);
  const toEnrich = selectKanjiToEnrich(collected, existing.map((k) => k.kanji));

  if (toEnrich.length === 0) {
    return json({ ok: true, filled: 0, missingKanji: [], droppedCount: 0, batches: [], nothingToFill: true });
  }

  // ── 10자씩 배치 병렬(부분 실패 격리) ──
  const batchesInput: (typeof toEnrich)[] = [];
  for (let i = 0; i < toEnrich.length; i += JA_KANJI_BATCH_SIZE) {
    batchesInput.push(toEnrich.slice(i, i + JA_KANJI_BATCH_SIZE));
  }

  const settled = await Promise.allSettled(
    batchesInput.map(async (batch) => {
      const gen = await generateKanjiInfo({ items: batch });
      return applyKanjiPostprocess(gen.items, batch.map((b) => b.kanji));
    }),
  );

  const model = resolveModel();
  const toSave: NewJaKanji[] = [];
  const batches: JaKanjiEnrichBatch[] = [];
  const allMissing: string[] = [];
  let droppedTotal = 0;
  let anySuccess = false;

  settled.forEach((res, i) => {
    if (res.status === "fulfilled") {
      anySuccess = true;
      for (const info of res.value.items) {
        toSave.push({
          kanji: info.kanji,
          koReading: info.koReading,
          onyomi: info.onyomi,
          kunyomi: info.kunyomi,
          meaningKo: info.meaningKo,
          model,
        });
      }
      allMissing.push(...res.value.missingKanji);
      droppedTotal += res.value.droppedCount;
      batches.push({ failed: false, droppedCount: res.value.droppedCount, missingKanji: res.value.missingKanji });
    } else {
      console.error("[/api/japanese/kanji/enrich] 배치 실패(격리):", res.reason);
      // 실패 배치가 요청했던 한자를 못 채운 것으로 보고한다.
      const missing = batchesInput[i].map((b) => b.kanji);
      allMissing.push(...missing);
      batches.push({ failed: true, droppedCount: 0, missingKanji: missing });
    }
  });

  if (!anySuccess) {
    return json({ ok: false, error: "enrich_failed", messageKo: "한자 정보를 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  // ── 저장(insert-only by kanji) — 이미 있던 한자는 안 덮어쓰고, 새로 채운 수만 filled로(사실대로). ──
  let filled = 0;
  try {
    filled = await store.saveJaKanji(toSave);
  } catch (err) {
    console.error("[/api/japanese/kanji/enrich] 저장 실패:", err);
    return json({ ok: false, error: "enrich_failed", messageKo: "한자 정보를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  return json({ ok: true, filled, missingKanji: allMissing, droppedCount: droppedTotal, batches, nothingToFill: false });
}

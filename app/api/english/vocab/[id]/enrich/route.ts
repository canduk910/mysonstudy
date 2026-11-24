/**
 * POST /api/english/vocab/[id]/enrich — 단어장 보강 (호출 D, V3 · docs/harness/english.md §8)
 *
 * 저장된 DAY 하나를 읽어 **영영 뜻(EN)이나 우리말 해석(KO)이 비어 있는 단어만**(V7 해석 백필 포함)
 * 골라 호출 D로 정의·해석·이모지를 만들고, `mergeEnrichment`로 병합해 다시 저장한다. 사진이 필요 없다 —
 * 판독(호출 C)과 별개의 텍스트 호출이다("다시 만들기"도 이 라우트 하나로 처리한다).
 *
 * ── 정의 불변 (계획 §V3) ────────────────────────────────────────────────────
 * 시험(V4)이 저장된 정의에 매달리므로 **안정성이 정확성보다 우선**이다. 이 라우트는 정의 불변을
 * 스스로 구현하지 않고 **`lib/ai/english/vocabbook-enrich.ts`의 순수 함수에 전적으로 위임**한다:
 * - `entriesToEnrich(record.entries)` — 입력에서 이미 채워진 정의를 뺀다(1차 방어).
 * - `enrichVocab(...)` — 그 대상만 모델에 보낸다(client.ts, 대상 0이면 호출 자체를 안 한다).
 * - `mergeEnrichment(현재 entries, items)` — **저장 값의 단일 정의처.** null 자리에만 채운다(2차 방어).
 *   2026-11-25부터 이 병합은 라우트가 아니라 `store.updateVocabBookEnrichment(id, items)`가 원자 단위
 *   (Firestore 트랜잭션·파일 mutate) 안에서 **저장 시점의 현재 entries**에 대고 한다(`planVocabEnrichmentSave`).
 * 이 파일에서 정의를 손대는 곳은 없다(우회 금지).
 *
 * ── 실패는 치명적이지 않다 (계획 §V3 "생성 실패는 치명적 아님") ──────────────
 * - **부분 실패**(모델이 일부 단어를 정의 못 함)는 오류가 아니다 — mergeEnrichment가 그 자리를 null로
 *   남기고, 200 `{ ok:true, remainingDefinitions>0 }`로 내려 화면이 "남은 N개 다시 만들기"를 띄운다.
 * - **호출 D 전체 실패**(재요청까지 소진해 throw)나 저장 실패만 500 `enrich_failed`(retriable)다 —
 *   기존 정의는 그대로 남아 화면이 깨지지 않는다(재시도 버튼).
 *
 * 응답 shape (단일 정의처는 `lib/vocab-enrich-contract.ts`):
 * - 200 { ok:true, id, filledDefinitions, filledKoGlosses, filledEmojis, remainingDefinitions, remainingGlosses, enriched }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 500 { ok:false, error:"enrich_failed", messageKo, retriable:true }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { hasLlmKey } from "@/lib/ai/provider";
import { enrichVocab } from "@/lib/ai/client";
import { entriesToEnrich, isVocabBookEnriched } from "@/lib/ai/english/vocabbook-enrich";
import type { VocabEnrichSavePlan } from "@/lib/vocabbook-enrich-save";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import type { VocabEnrichResponse } from "@/lib/vocab-enrich-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

function json(body: VocabEnrichResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재·렌더 가능 판정은 상세 페이지와 **같은 함수**(lib/vocabbook-record.ts) — 목록/상세/보강이 갈리지 않게.
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }

  // 대상 = 영영 뜻이 비어 있는 단어만(정의 불변 1차 방어). 없으면 이미 완료 — **키 없이도** 조기 반환.
  const toEnrich = entriesToEnrich(record.entries);
  if (toEnrich.length === 0) {
    // EN·KO 둘 다 완료 — 채울 것도 남은 것도 없다(entriesToEnrich=EN null || KO null이 0).
    return json({
      ok: true,
      id,
      filledDefinitions: 0,
      filledKoGlosses: 0,
      filledEmojis: 0,
      remainingDefinitions: 0,
      remainingGlosses: 0,
      enriched: isVocabBookEnriched(record.entries), // 렌더러블이면 entries.length>0이라 true
    });
  }

  // 여기서부터 실호출이 필요하다 — 키가 없으면 아무것도 하지 않고 명시적으로 알린다(/extract와 같은 정책).
  if (!hasLlmKey()) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "AI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY 또는 ANTHROPIC_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      501,
    );
  }

  // 호출 D — 대상만 보낸다. client.ts가 callWithSchema(재요청·검증·로깅)를 감싼다(라우트가 우회하지 않는다).
  let items: Awaited<ReturnType<typeof enrichVocab>>;
  try {
    items = await enrichVocab(toEnrich);
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/enrich] 보강 실패:`, err);
    return json(
      {
        ok: false,
        error: "enrich_failed",
        messageKo: "영영 뜻을 만들지 못했어요. 잠시 후 '다시 만들기'를 눌러 주세요.",
        retriable: true,
      },
      500,
    );
  }

  // 병합·저장은 저장 계층의 원자 단위 안에서 — **저장 시점의 현재 entries**를 다시 읽어 mergeEnrichment로
  // null 자리에만 얹는다(lib/vocabbook-enrich-save.ts). AI가 도는 사이 담기·연결된 단어가 옛 읽기의
  // 통째 덮어쓰기로 사라지던 경합(2026-11-25)을 막는다. 집계(filled*·remaining*)도 그 현재 기준이다.
  // 수정이라 prod-guard가 걸리지 않는다(생성·수정은 그대로 통한다).
  let plan: VocabEnrichSavePlan;
  try {
    const saved = await store.updateVocabBookEnrichment(id, items);
    if (!saved) {
      // get과 update 사이에 지워진 드문 경합 — 404로 정직하게 알린다.
      return json(
        { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
        404,
      );
    }
    plan = saved.plan;
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/enrich] 저장 실패:`, err);
    return json(
      {
        ok: false,
        error: "enrich_failed",
        messageKo: "영영 뜻은 만들었지만 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
        retriable: true,
      },
      500,
    );
  }
  const { filledDefinitions, filledKoGlosses, filledEmojis, remainingDefinitions, remainingGlosses } = plan;

  return json({
    ok: true,
    id,
    filledDefinitions,
    filledKoGlosses,
    filledEmojis,
    remainingDefinitions,
    remainingGlosses,
    enriched: plan.enriched,
  });
}

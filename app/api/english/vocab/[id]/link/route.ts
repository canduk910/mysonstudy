/**
 * POST/DELETE /api/english/vocab/[id]/link — 유의어/반의어 연결·해제 (V8 관계 문제 · docs/harness/english.md §7)
 *
 * 사용자가 **단어장 안의 다른 (단어+뜻)을 골라** 유의어·반의어로 잇거나(POST) 푼다(DELETE). 의미별이고
 * 양쪽 뜻에 상호 표시된다(스토어 `linkVocabRelated`가 대칭 기록). **AI 호출이 전혀 없다** — glossKo는
 * 대상 뜻의 한글(ko)을 그대로 복사한다(키가 없어도 동작해야 하므로 키 검사 없음, rename·quiz 저장과 같은 정책).
 *
 * 대상 단어는 `entries` 배열의 0-based 인덱스로 가리킨다(교재 번호 no가 아니라) — 손입력 단어(add-word)는
 * no가 null이고 판독분도 no가 겹칠 수 있어서다(단일 정의처 `lib/vocab-link-contract.ts` 주석 참고).
 * **수정이라 prod-guard 무관**(레코드 삭제가 아니라 필드 편집). 성공 뒤 프론트는 router.refresh로 갱신한다.
 *
 * bookId는 URL의 [id]에서 온다. 저장 전 그 단어장이 실제로 있고 렌더 가능한지 확인해 유령 bookId를 막는다.
 * 존재·렌더 판정은 상세/보강/rename과 **같은 함수**(lib/vocabbook-record.ts) — 갈리면 "목록엔 보이는데 500".
 *
 * 응답 shape (단일 정의처는 `lib/vocab-link-contract.ts`, qa-inspector 교차 검증용):
 * - 200 { ok:true }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }   ← zod 실패·인덱스 밖·자기 자신 연결·JSON 아님
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }      ← 없거나 열 수 없는 단어장(경합 삭제 포함)
 * - 500 { ok:false, error:"save_failed", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { VocabLinkResponse } from "@/lib/vocab-link-contract";
import { RELATION_QUIZ_KINDS } from "@/lib/vocab-quiz";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore, type VocabLinkInput, type VocabLinkOp } from "@/lib/store";

export const runtime = "nodejs";

// 인덱스는 0 이상 정수. kind는 유의어·반의어만(RELATION_QUIZ_KINDS 단일 정의처 — 파생어 제외).
const bodySchema = z.object({
  sourceIndex: z.number().int().min(0),
  sourceMeaningIndex: z.number().int().min(0),
  targetIndex: z.number().int().min(0),
  targetMeaningIndex: z.number().int().min(0),
  kind: z.enum(RELATION_QUIZ_KINDS),
});

function json(body: VocabLinkResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** POST=연결, DELETE=해제 공통 핸들러 — op만 다르고 검증·404·저장 흐름이 같다. */
async function handle(req: Request, id: string, op: VocabLinkOp) {
  const store = getStore();

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
        messageKo: "연결 정보를 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  const input: VocabLinkInput = parsed.data;

  // ── 대상 단어장 존재·렌더 가능 (404) — 상세/보강과 같은 함수. ──
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }

  // ── 연결/해제 — 수정이라 prod-guard가 걸리지 않는다. 인덱스 방어는 스토어가 status로 알린다. ──
  try {
    const result =
      op === "link"
        ? await store.linkVocabRelated(id, input)
        : await store.unlinkVocabRelated(id, input);
    if (result.status === "not_found") {
      // load~mutate 사이에 지워진 경합 — 없어진 것으로 정직하게 안내.
      return json(
        { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
        404,
      );
    }
    if (result.status === "invalid") {
      return json(
        {
          ok: false,
          error: "invalid_input",
          messageKo:
            op === "link"
              ? "연결할 수 없는 단어예요. (자기 자신이거나 목록이 바뀌었을 수 있어요)"
              : "해제할 수 없는 연결이에요. (목록이 바뀌었을 수 있어요)",
        },
        400,
      );
    }
    return json({ ok: true });
  } catch (err) {
    console.error(`[/api/english/vocab/${id}/link] ${op} 실패:`, err);
    return json(
      { ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, id, "link");
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, id, "unlink");
}

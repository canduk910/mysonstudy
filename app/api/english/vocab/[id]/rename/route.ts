/**
 * POST /api/english/vocab/[id]/rename — 단어장 이름(titleKo) 수정 (english.md §7-6)
 *
 * 단어장(DAY 레코드)의 **화면 이름만** 바꾼다. 만들 때만 정하던 이름을 상세 헤더에서 인라인으로
 * 고칠 수 있게 한다. entries·정의·enriched·dayLabel·판독 결과는 손대지 않는다 — titleKo 한 필드만
 * 갈아끼운다. **수정이라 prod-guard 무관**(삭제가 아니다). AI 호출 없음.
 *
 * 인증: 앱 전체가 상위 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에 닿기 전에 막힌다.
 *
 * 존재·렌더 판정은 상세/보강/담기와 **같은 함수**(lib/vocabbook-record.ts) — 목록엔 보이는데 눌러서
 * 못 여는 레코드는 이름도 못 바꾼다(같은 404 규약).
 *
 * 응답 shape (단일 정의처는 `lib/vocab-rename-contract.ts`, qa-inspector 교차 검증용):
 * - 200 { ok:true, id, titleKo }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 500 { ok:false, error:"save_failed", messageKo }
 * (401 locked / 503 not_configured는 상위 PIN 게이트가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import type { VocabRenameResponse } from "@/lib/vocab-rename-contract";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// 이름 상한의 단일 정의처는 VOCAB_LIMITS.titleKo(저장 요청과 같은 값). trim 후 최소 1자.
const bodySchema = z.object({
  titleKo: z
    .string()
    .trim()
    .min(1, "단어장 이름을 입력해 주세요")
    .max(VOCAB_LIMITS.titleKo, `이름은 최대 ${VOCAB_LIMITS.titleKo}자예요`),
});

function json(body: VocabRenameResponse, status = 200) {
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
        messageKo: parsed.error.issues[0]?.message ?? "단어장 이름을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  const titleKo = parsed.data.titleKo;

  // ── 대상 단어장 존재·렌더 가능 (404) ──
  // 존재·렌더 판정은 상세/보강/담기와 **같은 함수** — 이름을 바꿀 곳이 정말 열리는 곳이어야.
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return json(
      { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
      404,
    );
  }

  // ── 저장 — 수정이라 prod-guard가 걸리지 않는다. titleKo만 갈아끼운다. ──
  try {
    const updated = await store.updateVocabBookTitle(id, titleKo);
    if (!updated) {
      // load~update 사이에 지워진 경합 — 없어진 것으로 정직하게 안내.
      return json(
        { ok: false, error: "vocabbook_not_found", messageKo: "없거나 열 수 없는 단어장이에요." },
        404,
      );
    }
    return json({ ok: true, id, titleKo: updated.titleKo });
  } catch {
    // 저장 계층 오류(디스크·Firestore 등) — 계약대로 save_failed를 방출한다(미가공 500 방지).
    return json(
      { ok: false, error: "save_failed", messageKo: "이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}

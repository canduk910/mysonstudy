/**
 * /api/english/vocab/[id] — 저장된 단어장 1개 삭제 (V1, english.md §7-6)
 *
 * DELETE: 그 단어장 문서 하나만 지운다. **V1은 연쇄 삭제가 없다**(퀴즈 세션은 V4에 생긴다).
 * 되돌릴 수 없다(휴지통 없음 — 가족용 소규모 앱). 확인 단계는 화면(목록의 인라인 확인)이 맡는다.
 *
 * 인증: 앱 전체가 상위 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에 닿기 전에 막힌다.
 *
 * 응답 shape (수학 `/api/math/explanations/[id]`와 같은 규약, qa-inspector 교차 검증용):
 * - 200 { ok:true, id }
 * - 404 { ok:false, error:"vocabbook_not_found", messageKo }
 * - 403 { ok:false, error:"prod_guard", messageKo }   ← 개발 환경에서 실데이터 삭제 차단
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404. (이미 지운 것을 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const record = await store.getVocabBook(id);
  if (!record) {
    return NextResponse.json(
      { ok: false, error: "vocabbook_not_found", messageKo: "이미 지워졌거나 없는 단어장이에요." },
      { status: 404 },
    );
  }

  try {
    await store.deleteVocabBook(id);
  } catch (e) {
    // 개발 환경에서 프로덕션 실데이터를 지우려 한 경우 (lib/prod-guard.ts) — 다른 삭제 라우트와 같은 처리
    if (isProdGuardError(e)) {
      console.error(e.message);
      return NextResponse.json(
        {
          ok: false,
          error: "prod_guard",
          messageKo:
            "개발 환경이라 실제 데이터를 지우지 않았어요. 로컬 테스트는 STORE_BACKEND=file 로 돌려 주세요.",
        },
        { status: 403 },
      );
    }
    throw e;
  }

  return NextResponse.json({ ok: true, id });
}

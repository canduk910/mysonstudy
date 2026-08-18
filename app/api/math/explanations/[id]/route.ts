/**
 * /api/math/explanations/[id] — 저장된 설명 1건 삭제 (M4, math.md §9-5)
 *
 * DELETE: 그 설명 문서 하나만 지운다. **연쇄 삭제가 없다** — 설명에 딸린 것이 없다.
 * (영어의 `/api/books/[id]`가 카드·읽음 기록까지 지우는 것과 다르다. 여기서는
 * 보이는 단위와 지우는 단위가 처음부터 같다.)
 *
 * 되돌릴 수 없다(휴지통 없음 — 가족용 소규모 앱). 확인 단계는 화면(수학 서재의
 * 인라인 확인)이 맡는다.
 *
 * 인증: 앱 전체가 proxy.ts의 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에
 *       닿기 전에 막힌다. 별도 인증 코드를 두지 않는다.
 *
 * 응답 shape (qa-inspector 교차 검증용):
 * - 200: { ok: true, id }
 * - 404: { ok: false, error: "explanation_not_found", messageKo }
 * - 403: { ok: false, error: "prod_guard", messageKo }   ← 개발 환경에서 실데이터 삭제 차단
 */

import { NextResponse } from "next/server";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404. (이미 지운 기록을 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const record = await store.getExplanation(id);
  if (!record) {
    return NextResponse.json(
      { ok: false, error: "explanation_not_found", messageKo: "이미 지워졌거나 없는 기록이에요." },
      { status: 404 },
    );
  }

  try {
    await store.deleteExplanation(id);
  } catch (e) {
    // 개발 환경에서 프로덕션 실데이터를 지우려 한 경우 (lib/prod-guard.ts) — 카드 라우트와 같은 처리
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

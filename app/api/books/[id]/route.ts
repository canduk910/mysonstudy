/**
 * /api/books/[id] — 서재 관리 (책 삭제)
 *
 * DELETE: 책 1권을 지운다. 그 책의 **카드와 읽음 기록까지 연쇄 삭제**하고
 *         지운 개수를 돌려준다(스토어의 deleteBook — 파일·Firestore 공통).
 *         되돌릴 수 없다(휴지통 없음 — 가족용 소규모 앱, 단순함 우선).
 *
 * 인증: 앱 전체가 proxy.ts의 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에
 *       닿기 전에 401로 막힌다. 별도 인증 코드를 두지 않는다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200: { ok: true, deleted: { cards: number, readings: number } }
 * - 404: { ok: false, error: "book_not_found", messageKo }
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { isProdGuardError } from "@/lib/prod-guard";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404. (이미 지워진 책을 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const book = await store.getBook(id);
  if (!book) {
    return NextResponse.json(
      { ok: false, error: "book_not_found", messageKo: "이미 지워졌거나 없는 책이에요." },
      { status: 404 },
    );
  }

  let deleted;
  try {
    deleted = await store.deleteBook(id);
  } catch (e) {
    // 개발 환경에서 프로덕션 실데이터를 지우려 한 경우 (lib/prod-guard.ts)
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
  return NextResponse.json({ ok: true, deleted });
}

/**
 * /api/cards/[id] — 카드 히스토리 관리 (카드 1장 삭제)
 *
 * DELETE: 카드 **1장만** 지운다. 책도, 형제 카드도, 읽음 기록도 건드리지 않는다.
 *
 * 왜 필요한가: 서재 목록이 카드 단위인데 삭제는 책 단위라, 한 줄을 지우면 형제 카드가
 * 통째로 사라지는 사고가 있었다. 이제 **보이는 단위 = 지우는 단위**로 맞춘다 —
 * 서재(책 단위 목록)는 `/api/books/[id]`로 책을, 카드 페이지의 히스토리(카드 단위
 * 목록)는 이 라우트로 그 카드만 지운다.
 *
 * **마지막 카드는 거부한다(409).** 지우면 카드 없는 유령 책이 서재에 남아 열 수도
 * 지울 수도 없는 상태가 된다. 조용히 책까지 지우는 것은 사용자가 요청하지 않은
 * 삭제라 더 나쁘다(읽음 기록까지 함께 사라진다). 그래서 막고 책 삭제 경로로 안내한다.
 *
 * 인증: 앱 전체가 proxy.ts의 PIN 게이트 뒤에 있다 — 쿠키 없는 요청은 이 라우트에
 *       닿기 전에 막힌다. 별도 인증 코드를 두지 않는다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200: { ok: true, cardId, bookId, remaining: number, latestCardId: string }
 * - 404: { ok: false, error: "card_not_found", messageKo }
 * - 409: { ok: false, error: "last_card", messageKo, bookId }   ← 책 삭제로 안내
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  // 존재 확인 → 404. (이미 지워진 카드를 다시 지우려는 두 번째 클릭도 여기서 걸린다)
  const card = await store.getCard(id);
  if (!card) {
    return NextResponse.json(
      { ok: false, error: "card_not_found", messageKo: "이미 지워졌거나 없는 카드예요." },
      { status: 404 },
    );
  }

  const siblings = await store.listCardsForBook(card.bookId);
  if (siblings.length <= 1) {
    // 마지막 한 장 — 지우면 열 수도 지울 수도 없는 유령 책이 남는다.
    // bookId를 함께 내려 UI가 "이 책을 지우시겠어요?"로 이어 갈 수 있게 한다.
    return NextResponse.json(
      {
        ok: false,
        error: "last_card",
        messageKo:
          "이 책의 마지막 카드예요. 카드만 지우면 열 수 없는 책이 서재에 남아요 — 지우시려면 서재에서 책을 지워 주세요.",
        bookId: card.bookId,
      },
      { status: 409 },
    );
  }

  await store.deleteCard(id);

  // 지운 뒤 남은 목록 — 지금 보던 카드를 지운 경우 UI가 어디로 갈지 알아야 한다
  const remaining = siblings.filter((c) => c.id !== id);
  return NextResponse.json({
    ok: true,
    cardId: id,
    bookId: card.bookId,
    remaining: remaining.length,
    /** 최신순 첫 카드 — 방금 보던 카드를 지웠으면 여기로 이동한다 */
    latestCardId: remaining[0]!.id,
  });
}

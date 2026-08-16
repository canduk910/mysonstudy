/**
 * 카드 페이지 `/card/[id]` (SPEC §4-2) — 서버 컴포넌트.
 * store에서 카드+책을 읽어 CardView(클라이언트)에 넘긴다.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CardView from "@/components/card-view";
import { getStore } from "@/lib/store";

// db.json은 요청 시점에 읽는다
export const dynamic = "force-dynamic";

interface CardPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: CardPageProps): Promise<Metadata> {
  const { id } = await params;
  const store = getStore();
  const card = await store.getCard(id);
  if (!card) return { title: "카드를 찾을 수 없어요 — 은우 북카드" };
  const book = await store.getBook(card.bookId);
  return { title: `${book?.title ?? "학습 카드"} — 은우 북카드` };
}

export default async function CardPage({ params }: CardPageProps) {
  const { id } = await params;
  const store = getStore();

  const card = await store.getCard(id);
  if (!card) notFound();

  const book = await store.getBook(card.bookId);
  if (!book) notFound();

  // M3 — 이 책의 읽음 기록. "오늘 읽었어요" 상태·횟수 표시는 CardView(클라이언트)가
  // 자신의 로컬 날짜로 판정한다 (서버 UTC와 사용자 달력의 '오늘'이 다를 수 있음).
  const readings = await store.listReadings(book.id);

  return (
    <main>
      <CardView book={book} card={card} readings={readings} />
    </main>
  );
}

/**
 * 서재 `/library` (M3, SPEC §4-3) — 서버 컴포넌트.
 * store에서 books/cards/readings를 읽어 요약(총 권수·최근 30일 권수)과
 * AR 추이 차트 데이터(readings.readAt × 그 책의 arLevel)를 계산해
 * LibraryView(클라이언트 — 제목 검색 필터·SVG 차트)에 넘긴다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import LibraryView, { type ChartPoint, type LibraryItem } from "@/components/library-view";
import { getStore } from "@/lib/store";

// 저장 데이터는 요청 시점에 읽는다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "서재 — 은우 북카드",
  description: "지금까지 만든 학습 카드와 읽기 기록을 한눈에 봐요.",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function LibraryPage() {
  const store = getStore();
  const [books, cardsWithBooks, readings] = await Promise.all([
    store.listBooks(),
    store.listRecentCards(500), // 가족용 소규모 앱 — 전체 목록으로 충분한 상한
    store.listReadings(),
  ]);

  // 요약 — "권수"는 책(book) 기준: 총 권수 = 등록된 책 수, 최근 30일 = 그중 최근 등록분
  const totalBooks = books.length;
  const cutoff = Date.now() - 30 * DAY_MS;
  const recent30Books = books.filter((b) => Date.parse(b.createdAt) >= cutoff).length;

  // AR 추이 차트 — x: readings.readAt(날짜), y: 그 책의 arLevel.
  // arLevel이 없는 책(레벨 추정 실패)의 기록은 점을 찍을 수 없어 제외한다.
  const bookMap = new Map(books.map((b) => [b.id, b]));
  const chartPoints: ChartPoint[] = readings
    .flatMap((r) => {
      const book = bookMap.get(r.bookId);
      if (!book || book.arLevel == null) return [];
      return [{ date: r.readAt.slice(0, 10), ar: book.arLevel, title: book.title }];
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const items: LibraryItem[] = cardsWithBooks.map(({ card, book }) => ({
    cardId: card.id,
    title: book.title,
    author: book.author,
    series: book.series,
    coverUrl: book.coverUrl,
    coverEmoji: book.coverEmoji,
    isFiction: book.isFiction,
    arLevel: book.arLevel,
    levelEstimated: book.levelEstimated,
    createdAt: card.createdAt,
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-10">
      <header className="mb-6">
        <Link href="/" className="text-[13px] font-semibold text-sub hover:text-ink">
          ← 홈으로
        </Link>
        <h1 className="mt-2 text-[26px] font-bold text-ink">📚 은우의 서재</h1>
        <p className="mt-1 text-sm text-sub">지금까지 만든 카드와 읽기 기록이 쌓이는 곳이에요.</p>
      </header>

      <LibraryView
        items={items}
        totalBooks={totalBooks}
        recent30Books={recent30Books}
        chartPoints={chartPoints}
      />
    </main>
  );
}

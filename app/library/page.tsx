/**
 * 서재 `/library` (M3, SPEC §4-3) — 서버 컴포넌트.
 * store에서 books/cards/readings를 읽어 요약(총 권수·최근 30일 권수)과
 * AR 추이 차트 데이터(readings.readAt × 그 책의 arLevel)를 계산해
 * LibraryView(클라이언트 — 제목 검색 필터·SVG 차트)에 넘긴다.
 *
 * **목록 단위는 책이다(story-4).** 예전에는 카드 단위라 한 책을 재생성하면 같은 책이
 * 여러 줄로 보였는데, 삭제는 책 단위여서 한 줄을 지우면 형제 카드가 전부 사라졌다.
 * 이제 보이는 단위와 지우는 단위가 같다 — 서재는 책, 카드 히스토리는 카드 페이지 하단.
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

  /*
   * 책별 카드 묶기 — listRecentCards는 최신순이므로 각 책의 **첫 등장이 대표(최신) 카드**다.
   * 서재의 한 줄은 이 대표 카드로 열린다(책을 누르면 바로 최신 카드 — 탭이 늘지 않는다).
   */
  const cardsByBook = new Map<string, { latestCardId: string; latestAt: string; count: number }>();
  for (const { card } of cardsWithBooks) {
    const cur = cardsByBook.get(card.bookId);
    if (cur) cur.count += 1;
    else cardsByBook.set(card.bookId, { latestCardId: card.id, latestAt: card.createdAt, count: 1 });
  }

  const readingCountByBook = new Map<string, number>();
  for (const r of readings) {
    readingCountByBook.set(r.bookId, (readingCountByBook.get(r.bookId) ?? 0) + 1);
  }

  /*
   * 카드가 한 장도 없는 책도 **목록에 남긴다**(QA F15).
   *
   * 정상 흐름에서는 생기지 않는다 — 카드 생성이 성공해야 책이 저장되고, 마지막 카드
   * 낱개 삭제는 라우트가 409로 막는다. 다만 두 탭에서 2장짜리 책의 서로 다른 카드를
   * 동시에 지우면 둘 다 "마지막 아님" 검사를 통과해 만들어질 수 있다.
   *
   * 이런 책을 숨기면 **지울 수단이 함께 사라져** 영구히 낀다. 그래서 숨기는 대신
   * "카드 없음"으로 보여주고 누를 수 없게만 한다(library-view의 Wrap).
   * **요약 타일도 같은 집합을 센다** — 타일과 실제 줄 수가 어긋나지 않게.
   */
  const shelfBooks = books;

  // 요약 — 책(book) 기준: 총 권수 = 서재에 보이는 책 수, 최근 30일 = 그중 최근 등록분
  const totalBooks = shelfBooks.length;
  const cutoff = Date.now() - 30 * DAY_MS;
  const recent30Books = shelfBooks.filter((b) => Date.parse(b.createdAt) >= cutoff).length;

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

  // 한 책 = 한 줄. 대표 카드로 열고, 카드가 여러 장이면 그 사실을 줄에 표시한다.
  const items: LibraryItem[] = shelfBooks.map((book) => {
    // 카드 0장인 책은 cards가 없다 — cardId를 null로 두면 줄이 링크가 아닌 상자로 렌더된다
    const cards = cardsByBook.get(book.id);
    return {
      bookId: book.id,
      cardId: cards?.latestCardId ?? null,
      cardCount: cards?.count ?? 0,
      readingCount: readingCountByBook.get(book.id) ?? 0,
      title: book.title,
      author: book.author,
      series: book.series,
      coverUrl: book.coverUrl,
      coverEmoji: book.coverEmoji,
      isFiction: book.isFiction,
      arLevel: book.arLevel,
      levelEstimated: book.levelEstimated,
      // 가장 최근에 만든 카드의 날짜 — "이 책을 마지막으로 손본 때".
      // 카드가 없으면 기댈 카드 날짜가 없으니 책 등록일로 되돌린다(정렬이 깨지지 않게).
      createdAt: cards?.latestAt ?? book.createdAt,
      // 서재 수동 정렬 값 — null이면 미정렬(맨 위 블록), 값이 있으면 사용자가 맞춘 순서
      sortIndex: book.sortIndex,
    };
  });
  /*
   * 정렬 규칙(SPEC §4-3 수동 정렬):
   * 1) sortIndex가 **null인 항목이 먼저** — 그 안에선 createdAt 역순(최신 카드가 위, 기존 동작 유지).
   * 2) 그다음 **sortIndex 있는 항목** — 오름차순(사용자가 맞춘 순서).
   * 즉 새로 만든 책(sortIndex=null)은 늘 맨 위에 뜨고, 사용자가 재배치한 블록은 그 아래 고정된다.
   */
  items.sort((a, b) => {
    const aNull = a.sortIndex == null;
    const bNull = b.sortIndex == null;
    if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    if (aNull) return -1; // null 블록이 위
    if (bNull) return 1;
    return a.sortIndex! - b.sortIndex!; // 둘 다 값 있음 → 오름차순
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        {/* 홈 ↔ 서재 내비게이션 — 홈·카드 화면과 같은 알약 버튼(.u-navbtn).
            여기서 "홈"은 북카드 홈(`/english/books`)이다 — `/english`는 허브(고르기),
            `/`는 과목 선택 갈림길이라 서재에서 돌아올 때 고르기를 다시 지나면 흐름이 무거워진다.
            (이 서재는 아직 영어 전용이다. 수학 서재는 `/math/library`로 따로 만든다.) */}
        <div className="flex items-center justify-between gap-3">
          <Link href="/english/books" className="u-navbtn">
            ← 홈으로
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📚 은우의 서재</h1>
        <p className="t-lead mt-1">지금까지 만든 카드와 읽기 기록이 쌓이는 곳이에요.</p>
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

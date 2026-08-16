/**
 * 홈 `/` (SPEC §4-1) — 서버 컴포넌트.
 * 큰 버튼 2개(사진=M2 자리, 책 이름=수동 입력 폼)는 HomeCreate(클라이언트),
 * 최근 카드 3개 미리보기(이모지 커버 + 제목 + AR 칩)는 여기서 store로 읽는다.
 */

import Link from "next/link";
import HomeCreate from "@/components/home-create";
import { getStore } from "@/lib/store";

// db.json은 요청 시점에 읽어야 한다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const recent = await getStore().listRecentCards(3);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-10">
      <header className="mb-8 text-center">
        <p className="text-[12px] uppercase tracking-[0.12em] text-sub">은우학습 · 영어책 학습 도우미</p>
        <h1 className="mt-2 text-[26px] font-bold text-ink">은우 북카드</h1>
        <p className="mt-1 text-sm text-sub">오늘 읽을 영어책으로 우리만의 학습 카드를 만들어요.</p>
      </header>

      <HomeCreate />

      <section className="mt-10">
        <h2 className="mb-3 text-[15px] font-bold text-ink">최근 만든 카드</h2>
        {recent.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-card px-5 py-6 text-center text-[13.5px] text-sub">
            아직 만든 카드가 없어요. 첫 번째 책으로 카드를 만들어 볼까요?
          </p>
        ) : (
          <ul className="grid gap-3">
            {recent.map(({ card, book }) => (
              <li key={card.id}>
                <Link
                  href={`/card/${card.id}`}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-card p-4 transition hover:shadow-sm"
                >
                  <span
                    className={`flex h-12 w-12 flex-none items-center justify-center rounded-xl text-2xl ${
                      book.isFiction ? "bg-fiction/10" : "bg-nonfiction/10"
                    }`}
                    aria-hidden
                  >
                    {book.coverEmoji || "📖"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold text-ink">{book.title}</span>
                    <span className="block truncate text-[12.5px] text-sub">
                      {book.author}
                      {book.series ? ` · ${book.series}` : ""}
                    </span>
                  </span>
                  <span
                    className={`flex-none rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
                      book.isFiction ? "bg-fiction/10 text-fiction" : "bg-nonfiction/10 text-nonfiction"
                    }`}
                  >
                    {book.arLevel != null ? `AR ${book.arLevel}` : "레벨 추정"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

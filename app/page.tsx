/**
 * 홈 `/` (SPEC §4-1) — 서버 컴포넌트.
 *
 * 화면의 주인공은 큰 진입 버튼 2개(사진/제목)다 — HomeCreate(클라이언트)가 그린다.
 * 여기서는 상단 내비(서재)와 "최근 만든 카드" 3개(작은 카드)를 store로 읽어 렌더한다.
 *
 * 디자인: docs/DESIGN.md — 색·크기는 app/globals.css의 토큰(.t-* / .u-* / 토큰 유틸)만 쓴다.
 */

import Link from "next/link";
import HomeCreate from "@/components/home-create";
import { getStore } from "@/lib/store";

// db.json은 요청 시점에 읽어야 한다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const recent = await getStore().listRecentCards(3);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        {/* 홈 ↔ 서재 내비게이션 — 카드 화면과 같은 알약 버튼(.u-navbtn) */}
        <div className="flex items-center justify-between gap-3">
          <p className="t-caption">은우학습 · 영어책 학습 도우미</p>
          <Link href="/library" className="u-navbtn">
            <span aria-hidden>📚</span> 서재
          </Link>
        </div>
        <h1 className="t-book-title mt-4">은우 북카드</h1>
        <p className="t-lead mt-1">오늘 읽을 영어책으로 우리만의 학습 카드를 만들어요.</p>
      </header>

      <HomeCreate />

      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">최근 만든 카드</h2>
          <Link href="/library" className="t-meta-chip text-accent">
            전체 보기 →
          </Link>
        </div>

        {recent.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 카드가 없어요. 첫 번째 책으로 카드를 만들어 볼까요?
          </p>
        ) : (
          /* grid가 아니라 세로 flex — grid 트랙은 긴 제목에 맞춰 늘어나 375px에서 넘친다 */
          <ul className="flex flex-col gap-2">
            {recent.map(({ card, book }) => (
              <li key={card.id}>
                <Link href={`/card/${card.id}`} className="u-item">
                  {book.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일, next/image 원격 설정은 과설계
                    <img src={book.coverUrl} alt="" className="u-item-cover" />
                  ) : (
                    <span className="u-item-thumb" aria-hidden>
                      {book.coverEmoji || "📖"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="t-question-ko block truncate font-medium text-ink">
                      {book.title}
                    </span>
                    <span className="t-caption block truncate">
                      {book.author}
                      {book.series ? ` · ${book.series}` : ""}
                    </span>
                  </span>
                  <span className="u-chip flex-none">
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

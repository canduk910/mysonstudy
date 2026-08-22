/**
 * 영어(북카드) 홈 `/english` (SPEC §4-1) — 서버 컴포넌트.
 *
 * **이 화면은 원래 `/`였다.** 저장소에 수학(수학코치)이 얹히면서 `/`는 과목 선택
 * 갈림길이 되고, 영어 홈은 통째로 여기로 옮겨 왔다(내용·동작은 그대로).
 * 영어 화면들(`/library`, `/card/[id]`)의 "홈"은 전부 이 경로를 가리킨다 —
 * 카드를 보다 돌아올 때 과목 선택을 한 번 더 지나지 않게 하기 위해서다.
 *
 * 화면의 주인공은 큰 진입 버튼 2개(사진/제목)다 — HomeCreate(클라이언트)가 그린다.
 * 여기서는 상단 내비(과목 선택·서재)와 "최근 만든 카드" 3개를 store로 읽어 렌더한다.
 *
 * 디자인: docs/DESIGN.md — 색·크기는 app/globals.css의 토큰(.t-* / .u-* / 토큰 유틸)만 쓴다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import HomeCreate from "@/components/home-create";
// 본문 사진 상한·배치 크기는 lib/ai/client.ts가 단일 정의처다. 그 모듈은 openai와
// API 키를 건드려 클라이언트 번들에 들어갈 수 없으므로, 서버 컴포넌트인 여기서 읽어
// props로 내려보낸다 (HomeCreate가 숫자를 다시 적지 않게 하는 유일한 방법).
import { PAGES_BATCH_SIZE, PAGES_MAX_IMAGES } from "@/lib/ai/client";
import { getStore } from "@/lib/store";

// db.json은 요청 시점에 읽어야 한다 (빌드 시점 정적화 방지)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "은우 북카드",
  description: "영어책 표지 사진이나 제목으로 우리 아이 학습 카드를 만들어요.",
};

export default async function EnglishHomePage() {
  const recent = await getStore().listRecentCards(3);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        {/* 과목 선택 ↔ 영어 홈 ↔ 서재 내비게이션 — 카드 화면과 같은 알약 버튼(.u-navbtn) */}
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
          <Link href="/library" className="u-navbtn">
            <span aria-hidden>📚</span> 서재
          </Link>
        </div>
        <h1 className="t-book-title mt-4">은우 북카드</h1>
        <p className="t-lead mt-1">오늘 읽을 영어책으로 우리만의 학습 카드를 만들어요.</p>
      </header>

      <HomeCreate pagesMaxImages={PAGES_MAX_IMAGES} pagesBatchSize={PAGES_BATCH_SIZE} />

      {/* 단어장 정복 진입 — 표지 카드와 나란한 다른 학습 흐름(단어장 페이지 → 표) */}
      <Link href="/english/vocab" className="u-item mt-6">
        <span className="u-item-thumb" aria-hidden>
          📓
        </span>
        <span className="min-w-0 flex-1">
          <span className="t-list-title block">단어장 정복</span>
          <span className="t-caption block">
            단어장을 찍으면 단어·뜻·예문을 표로 모아 둬요.
          </span>
        </span>
        <span className="u-chip flex-none">열기 →</span>
      </Link>

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

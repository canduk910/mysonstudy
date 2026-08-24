/**
 * 카드 페이지 `/card/[id]` (SPEC §4-2) — 서버 컴포넌트.
 * store에서 카드+책을 읽어 CardView(클라이언트)에 넘긴다.
 *
 * 이 페이지가 사실상 **책 상세**다 — 북헤더(제목·저자·AR 칩)를 이미 달고 있고,
 * 서재에서 책을 누르면 바로 여기(최신 카드)로 온다. 그래서 재생성으로 쌓인 카드
 * 버전 목록(히스토리)도 별도 페이지를 만들지 않고 이 페이지 하단에 둔다(story-4).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CardView, { type CardHistoryItem } from "@/components/card-view";
import { resolveStorySource } from "@/lib/ai/english/schemas";
import { canChapterizeBook, getStore } from "@/lib/store";

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

  /*
   * 카드 히스토리 — 이 책의 카드 버전 목록(최신순). "다시 생성"이 덮어쓰지 않고
   * 쌓기 때문에 이전 버전과 비교할 수 있다(SPEC §4-2).
   *
   * **요약만 넘긴다.** CardRecord를 통째로 넘기면 카드 본문(단어 12·질문 8·장면 메모…)이
   * 버전 수만큼 클라이언트 번들에 실린다 — 5장이면 수백 KB다. 화면에 필요한 것은
   * 날짜·모델·근거 배지·장면 수뿐이라 여기서 줄여 보낸다.
   */
  const siblings = await store.listCardsForBook(book.id);
  const history: CardHistoryItem[] = siblings.map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    model: c.model,
    storySource: resolveStorySource(c.content),
    sceneCount: c.content.sceneDigest?.length ?? 0,
  }));

  // 챕터 리더(호출 F) 진입 조건 — 낭독 자막이 있는가(목차는 선택, 없으면 "전체" 단일 챕터).
  // book.transcript(자막 전문)를 클라이언트가 다시 판정하지 않도록 여기서 boolean만 넘긴다.
  const canChapterize = canChapterizeBook(book);

  return (
    <main>
      <CardView
        book={book}
        card={card}
        readings={readings}
        history={history}
        canChapterize={canChapterize}
      />
    </main>
  );
}

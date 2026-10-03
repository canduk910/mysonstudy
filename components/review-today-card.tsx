"use client";

/**
 * "📅 오늘의 복습 n개" 진입 카드 (SPEC §23-7) — 세 영역 첫 화면(은우 영어 허브·일본어 허브·토익 허브)에 둔다.
 * 마운트 뒤 `GET /api/review/{area}`로 오늘 큐 길이를 읽는다(허브 페이지는 정적이라 서버에서 세지 않는다 — 허브가 store를 읽지 않게).
 * 못 읽으면 개수 없이 링크만 보인다(조용한 폴백). AI 없음.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReviewArea, ReviewQueueResponse } from "@/lib/review-contract";
import { REVIEW_AREA_PATH } from "@/lib/review-schedule";

export default function ReviewTodayCard({ area, tone }: { area: ReviewArea; tone: "kid" | "adult" }) {
  const [state, setState] = useState<{ count: number; doneToday: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/review/${area}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ReviewQueueResponse>) : null))
      .then((b) => {
        if (alive && b && b.ok) setState({ count: b.cards.length, doneToday: b.doneToday });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [area]);

  const count = state?.count ?? null;
  const title = count === null ? "📅 오늘의 복습" : count > 0 ? `📅 오늘의 복습 ${count}개` : "📅 오늘의 복습";
  const desc =
    count === null
      ? tone === "kid"
        ? "어제 배운 단어, 기억나는지 꺼내 볼까요?"
        : "가린 채 떠올리기 — 힌트를 조금씩 열어 가며 기억을 꺼내요."
      : count > 0
        ? tone === "kid"
          ? "보지 말고 머릿속에서 꺼내 봐요. 막히면 힌트가 있어요!"
          : "보지 말고 떠올리세요. 막히면 첫 글자 → 뼈대 순으로 힌트를 열어요."
        : state && state.doneToday > 0
          ? tone === "kid"
            ? `오늘 ${state.doneToday}개 복습 끝! 내일 또 만나요.`
            : `오늘 ${state.doneToday}개 끝 — 다음 복습은 간격에 맞춰 다시 나와요.`
          : tone === "kid"
            ? "단어장 시험을 보면 복습할 단어가 생겨요."
            : "시험을 본 항목이 1→3→7→14→30일 간격으로 여기 돌아와요.";
  return (
    <Link href={REVIEW_AREA_PATH[area]} className="u-entry u-entry-secondary mb-3 block" data-testid={`review-today-${area}`}>
      <span className="u-entry-title">{title}</span>
      <span className="u-entry-desc">{desc}</span>
    </Link>
  );
}

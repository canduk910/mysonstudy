"use client";

/**
 * components/ja-daily-hub-card.tsx — `/japanese` 허브 맨 위 **🗓️ 오늘의 일본어** 큰 카드(설계 §5, primary).
 *
 * 허브는 정적 서버 컴포넌트라 store를 읽지 않는다 — 마운트 뒤 `GET /api/japanese/daily`로 다음 회차를 읽는다(오늘의 복습 카드와 같은 모양).
 * "Day n · 회화 … · 단어 … · 시험 칸 · 약 30분" / 오늘 끝냈으면 "오늘 완료 ✓ — 내일 Day n+1"(`doneTodayN` — 스트릭과 같은 판정).
 * 못 읽으면 문구 없이 링크만(조용한 폴백). AI 없음.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { JaDailyIndexOk, JaDailyIndexResponse } from "@/lib/ja-daily-contract";
import { jaDailySessionSummary } from "@/lib/ja-daily-quiz";

export default function JaDailyHubCard() {
  const [ix, setIx] = useState<JaDailyIndexOk | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/japanese/daily", { cache: "no-store" })
      .then((r) => r.json() as Promise<JaDailyIndexResponse>)
      .then((b) => {
        if (alive && b.ok) setIx(b);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  let desc = "회화 · N5 단어 · 시험 대비 · 복습을 하루 30분으로 — 90회 과정이에요.";
  let title = "🗓️ 오늘의 일본어";
  if (ix) {
    if (!ix.hasContent) desc = "내용 파일을 먼저 가져오면 90회 과정이 열려요.";
    else if (ix.doneTodayN !== null) {
      title = "🗓️ 오늘의 일본어 · 오늘 완료 ✓";
      desc = `Day ${ix.doneTodayN} 끝 — 내일 Day ${ix.next.n}`;
    } else if (ix.next.session) desc = jaDailySessionSummary(ix.next.session, ix.content.lessons);
  }
  return (
    <Link href="/japanese/daily" className="u-entry u-entry-primary mb-3 block" data-testid="ja-hub-daily">
      <span className="u-entry-title">{title}</span>
      <span className="u-entry-desc">{desc}</span>
    </Link>
  );
}

/**
 * 🗓️ 오늘의 일본어 회차 `/japanese/daily/[n]` (설계 §4) — 서버 컴포넌트 껍데기. 회차 내용·진행·저장은 클라이언트(JaDailySessionView).
 * n 형식이 아니면 404. 아직 오지 않은 회차(409 ahead)·내용 없음은 화면이 안내한다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaDailySessionView from "@/components/ja-daily-session-view";

export const metadata: Metadata = {
  title: "오늘의 일본어 — 아빠의 일본어",
};

export default async function JaDailySessionPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  if (!/^[1-9]\d{0,2}$/.test(n)) notFound();
  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href="/japanese/daily" className="u-navbtn">
          ← 오늘의 일본어
        </Link>
      </div>
      <JaDailySessionView key={n} n={Number(n)} />
    </main>
  );
}

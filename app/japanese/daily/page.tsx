/**
 * 🗓️ 오늘의 일본어 홈 `/japanese/daily` (설계 docs/superpowers/specs/2026-11-15-ja-daily-design.md §5) — 서버 컴포넌트 껍데기.
 * 자료는 클라이언트(JaDailyHome)가 `GET /api/japanese/daily`로 읽는다(원음 상태는 이 기기의 IndexedDB라 어차피 클라이언트에서만 안다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaDailyHome from "@/components/ja-daily-home";

export const metadata: Metadata = {
  title: "오늘의 일본어 — 아빠의 일본어",
};

export default function JaDailyPage() {
  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-6">
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese" className="u-navbtn">
            ← 일본어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🗓️ 오늘의 일본어</h1>
        <p className="t-lead mt-1">하루 30분 — 회화 · N5 단어 · 시험 대비 · 복습. 쉬어도 내용을 건너뛰지 않고 끝낸 회차에서 이어 가요.</p>
      </header>
      <JaDailyHome />
    </main>
  );
}

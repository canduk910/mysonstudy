/**
 * 가족 보드 `/family` — 서버 셸(정적) + 클라이언트 보드(가족 스트릭 강화). 오늘 누가 했는지·이번 주 칸·쉬는 날 카드·배지.
 * 잠금: proxy.ts 허용목록 밖이라 PIN 게이트 안이다. 디자인: 새 스타일 없음(.u-navbtn·.t-*).
 */

import type { Metadata } from "next";
import Link from "next/link";
import FamilyBoard from "@/components/family-board";

export const metadata: Metadata = { title: "가족 보드 · 은우학습" };

export default function FamilyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4">
        <Link href="/" className="u-navbtn">
          ← 과목 선택
        </Link>
      </div>
      <FamilyBoard />
    </main>
  );
}

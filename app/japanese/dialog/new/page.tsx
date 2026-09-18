/**
 * 대화 복습 만들기 `/japanese/dialog/new` (아빠의 일본어 J3·J4, §8) — 서버 컴포넌트(정적 셸).
 * 스크린샷 업로드·전사·해설·저장은 클라이언트(JaDialogNewFlow)가 한다. 이 페이지는 헤더만.
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaDialogNewFlow from "@/components/ja-dialog-new-flow";

export const metadata: Metadata = {
  title: "대화 복습 만들기 — 아빠의 일본어",
};

export default function JaDialogNewPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese/dialog" className="u-navbtn">
            ← 대화 복습
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📷 대화 복습 만들기</h1>
      </header>
      <JaDialogNewFlow />
    </main>
  );
}

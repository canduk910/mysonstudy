/**
 * 대화 복습 목록 `/japanese/dialog` — **J0 플레이스홀더**. (스펙 §8)
 *
 * ⚠️ 임시 화면이다. 허브(`/japanese`)의 링크가 404로 떨어지지 않게 "준비 중"만 보여준다.
 * **J3에서 이 파일을 실제 목록 화면으로 갈아끼운다**(듀오링고 스크린샷 N장 → 호출 B 전사·병합 → 저장·목록·상세,
 * J4에서 호출 C 해설이 상세에 붙는다). J0에는 AI·저장·기능이 없다 — 이 파일은 링크 대상만 채운다.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "대화 복습 — 아빠의 일본어",
};

export default function JapaneseDialogPlaceholderPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese" className="u-navbtn">
            ← 아빠의 일본어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">💬 대화 복습</h1>
      </header>

      <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
        <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
          🛠️
        </p>
        <h2 className="t-section-title mt-2">곧 만나요</h2>
        <p className="t-lead mt-2">
          듀오링고 대화 스크린샷을 찍어 전사하고 복습하는 기능을 준비하고 있어요. 조금만 기다려 주세요.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/japanese" className="u-btn u-btn-primary">
            <span aria-hidden>🗾</span> 아빠의 일본어로
          </Link>
        </div>
      </section>
    </main>
  );
}

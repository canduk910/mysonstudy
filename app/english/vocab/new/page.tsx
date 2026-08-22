/**
 * `/english/vocab/new` — 단어장 사진 판독 → 검토 → 저장 (단어장 정복 V1)
 *
 * 서버 컴포넌트는 껍데기(제목·내비·metadata)만 맡고, 사진 고르기·리사이즈·판독 확인·저장은
 * 클라이언트 컴포넌트(`components/vocabbook-photo-flow.tsx`)가 한다. AI 호출은 전부
 * `POST /api/english/vocab/extract` 안에서만 일어난다 — 이 화면은 `lib/ai/*`의 **호출 코드**를
 * import하지 않는다(API 키가 클라이언트 번들로 새는 유일한 경로가 그것이다).
 *
 * 정적 세그먼트 `new`가 `[id]`보다 우선하므로 `/english/vocab/new`는 이 화면이 잡는다.
 * 사진은 저장하지 않는다 — 병합된 단어 텍스트만 남긴다(english.md §7-6).
 */

import type { Metadata } from "next";
import Link from "next/link";
import VocabbookPhotoFlow from "@/components/vocabbook-photo-flow";

export const metadata: Metadata = {
  title: "단어장 만들기 — 은우 북카드",
  description: "단어장 페이지를 찍으면 단어를 읽어 표로 만들어 드려요.",
};

export default function VocabNewPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/english/vocab" className="u-navbtn">
            ← 단어장 목록
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📷 단어장 만들기</h1>
        <p className="t-lead mt-1">
          단어장 페이지를 찍으면 단어·뜻·예문을 그대로 읽어 표로 만들어 드려요.
        </p>
      </header>

      <VocabbookPhotoFlow />
    </main>
  );
}

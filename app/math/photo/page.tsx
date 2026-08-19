/**
 * `/math/photo` — 문제집 사진 판독 → 문제 고르기 → 3막 설명 (M3, 호출 A)
 *
 * 서버 컴포넌트는 껍데기(제목·내비·metadata)만 맡고, 사진 고르기·리사이즈·판독 확인·
 * 설명 요청은 클라이언트 컴포넌트(`components/math-photo-flow.tsx`)가 한다.
 * AI 호출은 전부 `POST /api/math/extract`·`POST /api/math/explain` 안에서만 일어난다 —
 * 이 화면은 `lib/ai/*`의 **호출 코드**를 import하지 않는다(API 키가 클라이언트 번들로 새는
 * 유일한 경로가 그것이다).
 *
 * 경로 이름이 `/math/photo`인 이유: `/math/new`(직접 입력)와 나란히 서는 **입력 방식**이라
 * 방식 이름을 그대로 썼다. `/math/new/photo`로 두면 직접 입력의 하위처럼 읽히는데,
 * 실제로는 이쪽이 평소 쓰는 길이다(그림이 있는 문제는 타이핑으로 옮길 수단이 없다).
 *
 * 사진은 저장하지 않는다 — 버킷도 서명 URL도 없다(docs/harness/math.md §11-2).
 */

import type { Metadata } from "next";
import Link from "next/link";
import MathPhotoFlow from "@/components/math-photo-flow";

export const metadata: Metadata = {
  title: "문제집 사진으로 — 은우 수학코치",
  description: "문제집 페이지를 찍으면 문제를 하나씩 읽고, 고른 문제만 3막으로 설명해 드려요.",
};

export default function MathPhotoPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/math" className="u-navbtn">
            ← 수학 홈
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📷 문제집 사진으로</h1>
        <p className="t-lead mt-1">
          페이지를 찍으면 문제를 하나씩 읽어 드려요. 그중 설명이 필요한 문제만 골라 주세요.
        </p>
      </header>

      <MathPhotoFlow />
    </main>
  );
}

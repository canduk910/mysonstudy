/**
 * `/math/new` — 문제 직접 입력 → 3막 설명 (M1)
 *
 * 서버 컴포넌트는 껍데기(제목·내비·metadata)만 맡고, 폼과 결과 렌더는 클라이언트
 * 컴포넌트(`components/math-explain-form.tsx`)가 한다. AI 호출은 전부
 * `POST /api/math/explain` 안에서만 일어난다 — 이 화면은 `lib/ai/*`를 값으로
 * import하지 않는다(API 키가 클라이언트 번들로 새는 유일한 경로가 그것이다).
 *
 * 저장 없음: 만든 설명은 화면에만 있다. 설명 보관(`explanations` 컬렉션)은 M4다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import MathExplainForm from "@/components/math-explain-form";

export const metadata: Metadata = {
  title: "문제 직접 입력 — 은우 수학코치",
  description: "문제 문장을 적으면 3막(탐정 시간·되감기·다시 재생)으로 설명해 드려요.",
};

export default function MathNewProblemPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/math" className="u-navbtn">
            ← 수학 홈
          </Link>
        </div>
        <h1 className="t-book-title mt-4">✏️ 문제 직접 입력</h1>
        <p className="t-lead mt-1">
          문제를 적어 주시면 &lsquo;왜 그렇게 푸는지&rsquo;를 아이 눈높이로 설명해 드려요.
        </p>
      </header>

      <MathExplainForm />
    </main>
  );
}

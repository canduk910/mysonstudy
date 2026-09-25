/**
 * `/toeic/sets/new` — 표현집 사진 판독 → DAY별 검토·수정 → 저장 → 발화 포인트 (아빠의 영어 T1, docs/harness/toeic.md §2·§8)
 *
 * 서버 컴포넌트는 껍데기(제목·내비·metadata)와 **입력 상한 props**만 맡는다 — 상한 숫자의 단일 정의처는
 * lib/ai/toeic/schemas.ts(zod 모듈)라 화면이 값으로 import하면 zod가 폰 번들에 실린다. 그래서 여기서 읽어 내린다
 * (일본어 만들기 페이지와 같은 방침). 사진 고르기·자르기·리사이즈·판독·검토·저장은 클라이언트 컴포넌트가 한다.
 * 사진은 저장하지 않는다 — 판독한 텍스트만 남는다(§2-0).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicSetNewFlow from "@/components/toeic-set-new-flow";
import {
  TOEIC_EXAMPLE_MAX,
  TOEIC_EXPRESSION_MAX,
  TOEIC_EXTRACT_MAX_PHOTOS,
  TOEIC_HINT_MAX,
  TOEIC_MEANING_KO_MAX,
  TOEIC_SET_ENTRIES_MAX,
  TOEIC_SET_QUIZ_MAX,
  TOEIC_SET_TITLE_MAX,
} from "@/lib/ai/toeic/schemas";
import type { ToeicSetEditLimits } from "@/lib/toeic-set-contract";

export const metadata: Metadata = {
  title: "표현집 만들기 — 아빠의 영어",
  description: "표현 암기장 페이지를 찍으면 표현·뜻·예문·QUIZ를 그대로 읽어 표현집을 만들어요.",
};

const LIMITS: ToeicSetEditLimits = {
  photos: TOEIC_EXTRACT_MAX_PHOTOS,
  title: TOEIC_SET_TITLE_MAX,
  expression: TOEIC_EXPRESSION_MAX,
  meaningKo: TOEIC_MEANING_KO_MAX,
  example: TOEIC_EXAMPLE_MAX,
  hint: TOEIC_HINT_MAX,
  entriesMax: TOEIC_SET_ENTRIES_MAX,
  quizMax: TOEIC_SET_QUIZ_MAX,
};

export default function ToeicSetNewPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic/sets" className="u-navbtn">
            ← 표현집 목록
          </Link>
        </div>
        <h1 className="t-book-title mt-4">📷 표현집 만들기</h1>
        <p className="t-lead mt-1">
          표현 암기장 페이지를 찍으면 표현·뜻·예문·QUIZ를 그대로 읽어요. 읽은 내용은 저장 전에 고칠 수 있어요.
        </p>
      </header>

      <ToeicSetNewFlow limits={LIMITS} />
    </main>
  );
}

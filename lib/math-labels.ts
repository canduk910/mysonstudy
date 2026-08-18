/**
 * lib/math-labels.ts — 수학 화면이 공유하는 고정 문구 (QA P2-2)
 *
 * **타입 import만 쓰는 순수 상수 모듈이다.** 서버 컴포넌트(`/math/library`)와 클라이언트
 * 컴포넌트(`components/math-library-view.tsx`)가 함께 읽어도 openai·API 키가 딸려오지 않는다.
 *
 * 여기 있는 이유: 같은 표가 `components/math-explanation-view.tsx`(상세)와
 * `components/math-library-view.tsx`(목록)에 각각 복제돼 있었고, `wrong` 문구가 실제로
 * 어긋나 있었다("💪 다시 한 번" vs "💪 다시 한 번 해봐요"). 두 화면이 같은 레코드를
 * 다른 말로 부르면 부모가 같은 것을 두 가지로 읽는다 — 정의처를 하나로 모은다.
 */

import type { ChildGrade } from "./ai/math/schemas";

/**
 * 채점 배지 — `none`(아이가 답을 안 씀)은 배지를 만들지 않으므로 키에서 뺀다.
 * `Record<Exclude<ChildGrade,"none">, string>`이라 스키마에 채점 값이 늘면 여기서 컴파일이 깨진다.
 */
export const GRADE_BADGE: Record<Exclude<ChildGrade, "none">, string> = {
  correct: "🎉 잘 맞혔어요",
  partial: "🙂 반은 맞았어요",
  wrong: "💪 다시 한 번 해봐요",
};

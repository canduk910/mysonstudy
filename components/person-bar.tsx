"use client";

/**
 * components/person-bar.tsx — 스트릭 헤드라인 바로 아래 "누구 습관" 표시줄.
 *
 * 사람 영역(lib/person-area.ts `personOfPath`) 안의 화면에서만 보인다 — 홈·가족 보드·잠금 화면은 그리지 않는다.
 * 시험 화면(useExamScreen — lib/exam-screen.ts)에서도 그리지 않는다(헤드라인과 같은 판정).
 * sticky가 아니라 **문서 흐름 안의 얇은 줄**이다: 헤드라인(sticky top-0)·영어 모바일 상단바(sticky top: --streak-h)와 겹치지 않고,
 * 스크롤하면 함께 올라간다. 영어 셸은 lg↑에서 고정 사이드바(15rem)가 왼쪽을 덮으므로 그만큼 민다. `print-hide`.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useExamScreen } from "@/components/use-exam-screen";
import { PERSON_HUB_HREF, PERSON_LABEL_KO, personOfPath } from "@/lib/person-area";

export default function PersonBar() {
  const pathname = usePathname();
  const exam = useExamScreen(); // 시험 화면에선 헤드라인과 함께 숨는다(lib/exam-screen.ts — 같은 판정)
  const person = personOfPath(pathname);
  if (person == null || exam) return null;
  const { emoji, name } = PERSON_LABEL_KO[person];
  const english = pathname === "/english" || (pathname ?? "").startsWith("/english/");
  return (
    <div className={`print-hide border-b border-line bg-surface ${english ? "lg:pl-60" : ""}`} data-person-bar={person}>
      <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-1.5">
        <Link href={PERSON_HUB_HREF[person]} className="t-caption font-medium text-ink">
          <span aria-hidden>{emoji}</span> {name}의 습관
        </Link>
        <span className="t-caption text-ink-3" aria-hidden>
          ·
        </span>
        <Link href="/" className="t-caption text-ink-3 underline underline-offset-2">
          사람 바꾸기
        </Link>
      </div>
    </div>
  );
}

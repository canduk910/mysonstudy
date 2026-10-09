"use client";

/**
 * useExamScreen — 지금 화면이 시험 화면인가(lib/exam-screen.ts `isExamScreen`). 상단 스트릭 헤드라인과 "누구 습관" 표시줄이 같이 쓴다.
 *
 * 경로 판정은 서버 렌더에서도 같은 답이라 첫 화면부터 숨는다. 블록 카운터는 클라이언트 전용(서버 snapshot 0) —
 * 경로로 못 가르는 시험(자유대화 통화 오버레이)은 마운트 뒤에 숨는다.
 */

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { isExamScreen } from "@/lib/exam-screen";
import { getPhraseHelperBlockCount, subscribePhraseHelperBlock } from "@/lib/phrase-helper-scope";

export function useExamScreen(): boolean {
  const pathname = usePathname();
  const blockCount = useSyncExternalStore(subscribePhraseHelperBlock, getPhraseHelperBlockCount, () => 0);
  return isExamScreen({ pathname, blockCount });
}

"use client";

/**
 * usePhraseHelperBlock — 시험·응답 화면이 **마운트된 동안** 표현 도우미를 막는다 (SPEC §22-3, lib/phrase-helper-scope.ts)
 *
 * 경로만으로 못 가르는 시험(같은 페이지 안에서 열리는 자유대화 통화 오버레이)과, 경로로 이미 막히는 시험 러너 모두가 부른다(두 겹).
 * 블록이 걸리면 도우미 호스트가 버튼·패널을 내린다 — 열려 있던 패널은 닫히고, 진행 중 요청·녹음·🔊는 언마운트 정리에서 끊긴다.
 * 해제는 참조 카운트라 러너가 겹쳐도 안전하고, StrictMode의 정리 → 재실행도 카운트가 맞는다.
 */

import { useEffect } from "react";
import { acquirePhraseHelperBlock } from "@/lib/phrase-helper-scope";

export function usePhraseHelperBlock(active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    return acquirePhraseHelperBlock();
  }, [active]);
}

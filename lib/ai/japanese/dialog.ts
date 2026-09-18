/**
 * lib/ai/japanese/dialog.ts — 대화 전사(호출 B)의 순수 함수 (docs/harness/japanese.md §3-4)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 여러 장 배치 계획과 배치 결과 병합만 담는다.
 * 병합의 핵심: 스크린샷 경계에서 같은 발화가 반복될 수 있다(§3-1 7번). **표기(ja) 완전 일치·연속**일 때만
 * 하나로 접는다 — 유사도 추정으로 서로 다른 발화를 삼키지 않는다(§3-4).
 */

import { JA_DIALOG_BATCH_SIZE, type JaDialogExtraction, type JaDialogTurn } from "./schemas";

/** 배치 계획 — 사진 인덱스를 batchSize 단위로 묶는다(§3-4). app-builder가 각 묶음을 호출 B로 병렬 판독. */
export function planJaDialogBatches(imageCount: number, batchSize: number = JA_DIALOG_BATCH_SIZE): number[][] {
  const size = Math.max(1, batchSize);
  const out: number[][] = [];
  for (let i = 0; i < imageCount; i += size) {
    const group: number[] = [];
    for (let j = i; j < Math.min(i + size, imageCount); j += 1) group.push(j);
    out.push(group);
  }
  return out;
}

export interface JaDialogMergeResult {
  focusKo: string | null;
  turns: JaDialogTurn[];
  partial: boolean;
  /** 겹침(연속 ja 완전 일치)으로 접힌 발화 수 = 입력 turns 합 − 출력 turns */
  mergedCount: number;
  /** 발화가 있는데 전부 speaker="unknown"이면 true — 화면이 "화자를 확인하세요" 경고(§3-4) */
  allUnknown: boolean;
}

/**
 * 배치 결과들을 한 대화로 병합한다(§3-4). 배치 순서를 지켜 turns를 잇되, **직전에 채택한 발화와 ja가
 * 정확히 같은** 연속 발화는 접는다(경계 겹침 제거). 접힌 쪽에만 피드백이 보였으면 그 피드백을 살린다.
 * focusKo는 처음 발견된 non-null(첫 장에만 있다), partial은 하나라도 true면 true.
 */
export function mergeJaDialogBatches(batches: readonly JaDialogExtraction[]): JaDialogMergeResult {
  const turns: JaDialogTurn[] = [];
  let inputCount = 0;
  let focusKo: string | null = null;
  let partial = false;

  for (const batch of batches) {
    if (focusKo === null && batch.focusKo !== null) focusKo = batch.focusKo;
    if (batch.partial) partial = true;
    for (const turn of batch.turns) {
      inputCount += 1;
      const prev = turns[turns.length - 1];
      // 경계 겹침: 직전 채택 발화와 ja 완전 일치·연속이면 접는다(완전 일치로만 — 유사도 추정 금지)
      if (prev && prev.ja === turn.ja) {
        // 접히는 쪽에만 피드백이 보였으면(직전이 null) 그 피드백을 살린다
        if (prev.feedback === null && turn.feedback !== null) prev.feedback = turn.feedback;
        continue;
      }
      turns.push({ ...turn });
    }
  }

  const allUnknown = turns.length > 0 && turns.every((t) => t.speaker === "unknown");
  return { focusKo, turns, partial, mergedCount: inputCount - turns.length, allUnknown };
}

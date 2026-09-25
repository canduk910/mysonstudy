/**
 * lib/ai/toeic/points.ts — 호출 B(발화 포인트) 묶음 나누기 + 병합 순수 함수 (docs/harness/toeic.md §3-0·§3-4)
 *
 * - **기본은 빈 자리만 채운다** — `points`가 null인 항목에만 넣는다. 사용자가 "다시 만들기"(`force`)를 누른 경우만 덮어쓴다.
 *   포인트는 시험 채점 기준이 아니지만(숙련도는 expression 키로 센다, §6-2) 사용자가 보던 문장이 말없이 바뀌지 않게 한다.
 * - 묶음 호출이 재요청 뒤에도 실패하면 그 묶음의 항목은 그대로 두고 `remaining`으로 보고한다(부분 성공).
 * - `enriched = entries.every(e => e.points !== null)`.
 *
 * 실호출 없이 eval이 잠그는 순수 함수다. 값을 만드는 곳은 여기뿐이다.
 */

import {
  TOEIC_POINTS_CHUNK_SIZE,
  type ToeicExprEntry,
  type ToeicPointsInput,
  type ToeicPointsItem,
  type ToeicSpeakingPoints,
} from "./schemas";

/** 표현 항목 → 호출 B 입력 한 줄. index는 세트 전체 entries 배열 위치(§3-2) */
export function toPointsInput(entry: Pick<ToeicExprEntry, "expression" | "meaningKo" | "example" | "exampleKo">, index: number): ToeicPointsInput {
  return { index, expression: entry.expression, meaningKo: entry.meaningKo, example: entry.example, exampleKo: entry.exampleKo };
}

/** 이번 호출에서 채울 대상 index — 기본은 points가 null인 것만, force면 전부 */
export function pointsTargetIndexes(entries: readonly Pick<ToeicExprEntry, "points">[], force: boolean): number[] {
  const out: number[] = [];
  entries.forEach((e, i) => {
    if (force || e.points === null) out.push(i);
  });
  return out;
}

/**
 * 호출 B 묶음 계획 — 대상 항목을 TOEIC_POINTS_CHUNK_SIZE(7)개씩 끊는다(§3-0, 60초 상한).
 * 대상이 없으면 빈 배열(호출 없음).
 */
export function planPointsChunks(entries: readonly ToeicExprEntry[], opts: { force: boolean }): ToeicPointsInput[][] {
  const targets = pointsTargetIndexes(entries, opts.force).map((i) => toPointsInput(entries[i], i));
  const chunks: ToeicPointsInput[][] = [];
  for (let i = 0; i < targets.length; i += TOEIC_POINTS_CHUNK_SIZE) chunks.push(targets.slice(i, i + TOEIC_POINTS_CHUNK_SIZE));
  return chunks;
}

/** 모델 출력 항목에서 index를 떼어 저장 모양으로 */
function toPoints(item: ToeicPointsItem): ToeicSpeakingPoints {
  return {
    exampleSpan: item.exampleSpan,
    coreKo: item.coreKo,
    useIn: item.useIn.map((u) => ({ ...u })),
    frames: [...item.frames],
    variations: item.variations.map((v) => ({ ...v })),
    pronunciationKo: item.pronunciationKo,
    pitfallKo: item.pitfallKo,
    grammarKo: item.grammarKo,
    followUp: { ...item.followUp },
  };
}

export interface ToeicPointsMergeResult {
  entries: ToeicExprEntry[];
  /** 실제로 채우거나(빈 자리) 갈아 끼운(force) 항목 수 */
  filled: number;
  /** 이번에 대상이었지만 채우지 못한 항목 수(실패한 묶음) — 화면이 "N개는 다시 만들기"를 사실대로 알린다 */
  remaining: number;
  /** entries 전부 points !== null */
  enriched: boolean;
}

/**
 * 성공한 묶음들의 출력(items를 이어 붙인 것)을 세트에 합친다.
 * - 기본(force=false): points가 null인 항목에만 넣는다 — 이미 있는 포인트는 어떤 경로로도 덮지 않는다.
 * - force=true: 대상 항목을 갈아 끼운다. 실패한 묶음의 항목은 원래 포인트를 그대로 둔다.
 * - 범위 밖 index·같은 index 두 번째는 무시한다(zod가 이미 거부하지만 여기서도 방어).
 */
export function applyPointsResults(
  entries: readonly ToeicExprEntry[],
  items: readonly ToeicPointsItem[],
  opts: { force: boolean },
): ToeicPointsMergeResult {
  const targets = new Set(pointsTargetIndexes(entries, opts.force));
  const next = entries.map((e) => ({ ...e }));
  const done = new Set<number>();
  for (const it of items) {
    if (!targets.has(it.index) || done.has(it.index)) continue;
    next[it.index] = { ...next[it.index], points: toPoints(it) };
    done.add(it.index);
  }
  return {
    entries: next,
    filled: done.size,
    remaining: targets.size - done.size,
    enriched: isToeicSetEnriched(next),
  };
}

/** §3-4 enriched — 세트의 모든 표현에 발화 포인트가 있는가 */
export function isToeicSetEnriched(entries: readonly Pick<ToeicExprEntry, "points">[]): boolean {
  return entries.every((e) => e.points !== null);
}

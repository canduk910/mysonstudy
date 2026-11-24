/**
 * lib/vocabbook-enrich-save.ts — 단어장 보강(호출 D) 결과를 **저장 시점의 현재 entries**에 합치는 순수 함수
 * (docs/harness/english.md §8-5 · 2026-11-25 Firestore 경합 정리)
 *
 * ## 왜 따로 있나
 * 보강 라우트(`/api/english/vocab/[id]/enrich`)는 AI 호출(수 초~수십 초) **앞에서** 단어장을 읽는다.
 * 예전에는 그 옛 entries에 병합한 결과로 entries 전체를 덮어써서, AI가 도는 사이에
 * - 더블탭으로 담은 단어(`appendVocabEntry`),
 * - 유의어/반의어 연결(`linkVocabRelated`)
 * 이 저장 순간 **조용히 사라졌다.** 그래서 저장 계층이 원자 단위(Firestore `runTransaction`, 파일 `mutate`)
 * 안에서 현재 entries를 다시 읽고 이 함수로 보강 결과를 얹는다.
 *
 * ## 규칙
 * - 병합은 **`mergeEnrichment` 그대로**(정의 불변의 단일 정의처 — null 자리에만 채운다). 그 함수의 매칭은
 *   번호(no) → 표제어(소문자) 순이라, 보강 사이에 새로 붙은 단어(no:null·중복 표제어 금지)는 결과와 안 맞물려
 *   그대로 남는다. 연결(related)은 entry 스프레드로 보존된다.
 * - 집계(filled*·remaining*)도 **현재 entries 기준**으로 센다 — 라우트가 옛 읽기로 세면 숫자가 어긋난다.
 * - 저장형으로 굳히는 `normalizeVocabEntry`는 저장 계층이 마지막에 조인다(여기서는 순수 병합만).
 *
 * 순수 함수다 — openai·store를 import하지 않는다(오프라인 eval `eval:english`가 반례로 잠근다).
 */
import { mergeEnrichment } from "./ai/english/vocabbook-enrich";
import type { VocabEnrichItem, VocabEntry } from "./ai/english/vocabbook-schemas";

export interface VocabEnrichSavePlan {
  /** 저장할 entries — 현재 entries 순서·길이 그대로, null 자리에만 보강 결과가 채워진다 */
  entries: VocabEntry[];
  enriched: boolean;
  filledDefinitions: number;
  filledKoGlosses: number;
  filledEmojis: number;
  remainingDefinitions: number;
  remainingGlosses: number;
}

export function planVocabEnrichmentSave(
  current: readonly VocabEntry[],
  items: readonly VocabEnrichItem[],
): VocabEnrichSavePlan {
  const merged = mergeEnrichment(current, items);
  let filledDefinitions = 0;
  let filledKoGlosses = 0;
  let filledEmojis = 0;
  // mergeEnrichment는 순서·길이를 보존한다 — 인덱스로 현재 값과 대조한다.
  current.forEach((orig, i) => {
    const next = merged.entries[i];
    if (orig.definitionEn === null && next.definitionEn !== null) filledDefinitions += 1;
    if (orig.definitionKo === null && next.definitionKo !== null) filledKoGlosses += 1;
    if (orig.imageEmoji === null && next.imageEmoji !== null) filledEmojis += 1;
  });
  return {
    entries: merged.entries,
    enriched: merged.enriched,
    filledDefinitions,
    filledKoGlosses,
    filledEmojis,
    remainingDefinitions: merged.entries.filter((e) => e.definitionEn === null).length,
    remainingGlosses: merged.entries.filter((e) => e.definitionKo === null).length,
  };
}

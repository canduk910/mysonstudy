/**
 * lib/ai/english/vocabbook-enrich.ts — 호출 D(보강) 병합 순수 함수 (docs/harness/english.md §8-5)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 부수효과·import를 최소로 둔다(타입만 import) —
 * client.ts(openai)를 여기서 import하지 않는다. 그래야 오프라인 eval이 네트워크 없이 이 규칙을 잠근다.
 *
 * ## 왜 여기에 규칙을 박는가 — 정의 불변(계획 V3)
 * 시험(V4)이 **저장된 definitionEn에 매달린다.** 재생성 때마다 정의 문구가 바뀌면 은우가 외운
 * 정의와 시험 문제가 어긋난다. 그래서 이 기능은 **안정성이 정확성보다 우선**이다:
 * - 이미 채워진 definitionEn/imageEmoji는 **어떤 재생성 경로도 덮어쓰지 않는다.** null 자리에만 채운다.
 * - 이 규칙이 한 곳(mergeEnrichment)에만 살아야 새지 않는다 — 화면·라우트가 결과를 소비만 하게 한다.
 * 문구를 바꾸려면 오직 사람이 "고치기"로 수동 수정한다(자동 생성은 절대 손대지 않음).
 */

import type { VocabEnrichItem, VocabEntry, PartOfSpeech } from "./vocabbook-schemas";

/**
 * 호출 D 입력으로 보내는 단어 하나의 최소 shape.
 * 저장형 VocabEntry는 무겁다(예문·관련어·판독 판정…) — 모델이 정의를 쓰는 데 필요한 것만 추린다:
 * no·word(매칭키) + pos·meaningsKo(어느 의미로 정의할지 가르는 단서).
 */
export interface VocabEnrichRequestItem {
  no: string | null;
  word: string;
  pos: PartOfSpeech[];
  meaningsKo: string[];
}

/** mergeEnrichment 결과 — 병합된 entries와, 이 DAY가 보강 완료인지(enriched) 판정. */
export interface VocabEnrichMergeResult {
  entries: VocabEntry[];
  enriched: boolean;
}

/**
 * 보강 대상 = definitionEn === null인 단어만. 이미 정의가 있으면 호출 D 입력에서 뺀다.
 * 재실행("다시 만들기") 비용을 줄이고, 이미 있는 정의를 결과에서 아예 제외해 덮어쓸 여지를 없앤다(§8-5).
 */
export function entriesToEnrich(entries: readonly VocabEntry[]): VocabEntry[] {
  return entries.filter((e) => e.definitionEn === null);
}

/**
 * 호출 D 사용자 메시지에 실을 단어 목록을 만든다(§8-2). 보강 대상만 추려 최소 shape으로 내린다.
 * meaningsKo는 뜻 풀이 문자열만 뽑아(뜻 번호·관련어는 정의에 불필요) 토큰을 아낀다.
 */
export function buildEnrichRequestItems(entries: readonly VocabEntry[]): VocabEnrichRequestItem[] {
  return entriesToEnrich(entries).map((e) => ({
    no: e.no,
    word: e.word,
    pos: e.pos,
    meaningsKo: e.meanings.map((m) => m.ko),
  }));
}

/** 조인 키 — 번호가 있으면 번호, 없으면 표제어 소문자. mergeVocabPages의 joinKey와 같은 규약. */
function noKeyOf(item: { no: string | null }): string | null {
  const no = item.no?.trim();
  return no ? no : null;
}
function wordKeyOf(item: { word: string }): string {
  return item.word.trim().toLowerCase();
}

/**
 * 한 entry에 대응하는 보강 결과를 찾는다. 번호(no)로 먼저 잇고, 못 찾으면 표제어(소문자)로 잇는다
 * — 모델이 번호를 빠뜨렸어도 단어로 회수한다(부분 실패에 강하게).
 */
function findResultFor(
  entry: VocabEntry,
  byNo: Map<string, VocabEnrichItem>,
  byWord: Map<string, VocabEnrichItem>,
): VocabEnrichItem | undefined {
  const nk = noKeyOf(entry);
  if (nk) {
    const hit = byNo.get(nk);
    if (hit) return hit;
  }
  return byWord.get(wordKeyOf(entry));
}

/**
 * 호출 D 결과를 entries에 병합한다(§8-5). **정의 불변 규칙의 단일 정의처.**
 * - definitionEn: `entry.definitionEn === null`인 자리에만, 결과의 정의가 non-null일 때만 채운다.
 *   이미 채워진 정의는 절대 덮어쓰지 않는다.
 * - imageEmoji: 정의와 **독립적으로** 같은 규칙(null 자리에만 non-null 결과를 채움) — 정의는 있고
 *   이모지만 null이면 이모지만 채운다.
 * - 결과(result)에 없는 단어는 그대로 둔다(부분 실패 허용).
 * - enriched: **모든 entry의 definitionEn !== null**이면 true. 이모지 null은 추상어라 정상이므로
 *   enriched 판정에서 제외한다(정의만이 시험의 앵커라 이것만 본다).
 */
export function mergeEnrichment(
  entries: readonly VocabEntry[],
  result: readonly VocabEnrichItem[],
): VocabEnrichMergeResult {
  // 결과를 매칭키로 색인. 같은 키가 여러 번이면 먼저 온 것을 쓴다(모델 중복 방어).
  const byNo = new Map<string, VocabEnrichItem>();
  const byWord = new Map<string, VocabEnrichItem>();
  for (const item of result) {
    const nk = noKeyOf(item);
    if (nk && !byNo.has(nk)) byNo.set(nk, item);
    const wk = wordKeyOf(item);
    if (!byWord.has(wk)) byWord.set(wk, item);
  }

  const nextEntries = entries.map((entry) => {
    const item = findResultFor(entry, byNo, byWord);
    // 정의: null 자리에만, 결과 정의가 non-null일 때만. 이미 있으면 그대로(덮어쓰지 않음).
    const definitionEn =
      entry.definitionEn === null && item && item.definitionEn !== null
        ? item.definitionEn
        : entry.definitionEn;
    // 이모지: 독립적으로 같은 규칙.
    const imageEmoji =
      entry.imageEmoji === null && item && item.imageEmoji !== null
        ? item.imageEmoji
        : entry.imageEmoji;
    return { ...entry, definitionEn, imageEmoji };
  });

  return { entries: nextEntries, enriched: isVocabBookEnriched(nextEntries) };
}

/**
 * 저장된 entries만으로 enriched 상태를 계산한다(§8-5) — enriched의 **단일 정의처**.
 * 모든 entry의 definitionEn !== null이면 true(이모지 null은 추상어라 정상이므로 제외).
 * 빈 배열은 false(보강할 것이 없는 빈 DAY를 "완료"로 보지 않는다). mergeEnrichment도 이걸 쓴다.
 */
export function isVocabBookEnriched(entries: readonly VocabEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.definitionEn !== null);
}

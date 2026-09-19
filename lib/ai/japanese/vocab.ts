/**
 * lib/ai/japanese/vocab.ts — 호출 A 단어 생성의 코드 후처리 순수 함수 (docs/harness/japanese.md §2-4·§2-0)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 부수효과·값 import를 최소로 둔다(타입·상수만 import).
 * 값을 만드는 것은 여기뿐이고 다른 곳은 결과를 소비만 한다 — 후처리 규칙이 두 곳에 살면 어긋난다.
 *
 * 후처리(§2-4)는 프롬프트를 못 믿는 진짜 방어선이다: 제외 재적용(include 예외)·포함 이행 보고·중복 접기
 * (kana 기준, include 우선)·레벨 태깅(코드가 붙인다)·부분 성공. 그리고 §2-0의 레벨별 include 배분 계획.
 */

import {
  JA_VOCAB_DEFAULT_COUNT,
  type JaVocabEntry,
  type JaVocabGenEntry,
  type JlptLevel,
} from "./schemas";

// ---------------------------------------------------------------------------
// 정규화 — include/exclude 입력 정리 (§2-4: 공백·전각 정리)
// ---------------------------------------------------------------------------

/**
 * 일본어 표기 하나를 조인·비교용으로 정규화한다. NFKC로 전각/반각을 통일하고(예: 반각 가나 ｶﾞ→ガ,
 * 전각 공백 등) 공백을 전부 제거한다. 표제어에는 공백이 없어야 정상이므로 안전하다.
 */
export function normalizeJaWord(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "");
}

/** 표기 목록을 정규화하고 빈 값·중복(정규화 기준)을 제거한다(등장 순서 유지). */
export function normalizeJaWordList(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const w = normalizeJaWord(raw);
    if (w === "" || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 레벨별 include 배분 계획 (§2-0) — app-builder가 이걸로 병렬 호출을 만든다
// ---------------------------------------------------------------------------

/** 한 레벨 호출의 계획 — 이 레벨에서 만들 전체 개수(count)와 이 레벨에 배분된 include. */
export interface JaVocabCallPlan {
  level: JlptLevel;
  /** 이 레벨 호출의 전체 개수(include 포함). 새로 고르는 것은 count - include.length */
  count: number;
  /** 이 레벨 호출에 배분된 꼭 넣을 단어(표기). 첫 레벨에만 실린다 */
  include: string[];
}

/**
 * 레벨 여러 개일 때 include를 **첫 번째 레벨 호출에만** 배분한다(§2-0·§2-1 3번).
 * 예: N2·N3 + include 3개, perLevelCount 10 → [{N2, count 10, include 3}(새 7), {N3, count 10, include []}(새 10)].
 * 포함 단어를 레벨마다 쪼개 넣으면 같은 단어가 여러 번 나오므로 첫 레벨에 몰아준다.
 *
 * @param levels     선택한 레벨들(순서 = 화면 선택 순서). 첫 레벨이 include를 받는다
 * @param include    꼭 넣을 단어(표기). 내부에서 정규화·중복제거하고 perLevelCount로 상한을 건다
 * @param perLevelCount 레벨당 전체 개수(기본 10)
 */
export function planIncludeDistribution(
  levels: readonly JlptLevel[],
  include: readonly string[],
  perLevelCount: number = JA_VOCAB_DEFAULT_COUNT,
): JaVocabCallPlan[] {
  // 첫 레벨이 담을 수 있는 include는 최대 perLevelCount개(전체 개수를 넘을 수 없다)
  const normalizedInclude = normalizeJaWordList(include).slice(0, perLevelCount);
  return levels.map((level, i) => ({
    level,
    count: perLevelCount,
    include: i === 0 ? normalizedInclude : [],
  }));
}

// ---------------------------------------------------------------------------
// 생성 결과 후처리 (§2-4 1~5) — 한 레벨 호출의 zod 통과분에 적용
// ---------------------------------------------------------------------------

/** 후처리 입력 — 한 레벨 호출의 결과와 그 호출의 인자(레벨·include·누적 exclude). */
export interface JaVocabPostprocessInput {
  /** 호출 A(이 레벨) zod 통과 결과 */
  entries: readonly JaVocabGenEntry[];
  /** 이 단어장이 공부하는 레벨 — 각 entry에 코드가 붙인다(§2-4 4번) */
  level: JlptLevel;
  /** 이 레벨 호출에 배분된 꼭 넣을 단어(표기). 정규화 전이어도 내부에서 정규화한다 */
  include: readonly string[];
  /** 누적 제외 목록(표기+읽기). word 또는 kana가 같으면 버린다(include 예외) */
  exclude: readonly { word: string; kana: string }[];
}

export interface JaVocabPostprocessResult {
  /** 레벨 태깅·제외 재필터·중복 접기를 마친 저장용 엔트리 */
  entries: JaVocabEntry[];
  /** 제외 재적용 + 중복 접기로 버려진 개수(입력 − 출력) */
  filteredCount: number;
  /** include 중 결과에 못 들어간 표기(오류가 아니라 화면 보고 대상, §2-4 2번) */
  missingIncludes: string[];
}

/**
 * §2-4의 코드 후처리 1~5단계를 적용한다.
 * 1. 제외 재적용 — 기존 표제어와 word 또는 kana가 같으면 버린다. **단 include에 있으면 버리지 않는다.**
 * 2. 포함 이행 확인 — include의 각 표기가 결과에 있는지(word 일치, 없으면 kana 일치). 빠진 것은 보고만 한다.
 * 3. 중복 접기 — kana 기준으로 같은 단어를 접는다. 포함 단어와 겹치면 포함 쪽을 남긴다.
 * 4. 레벨 태깅 — 호출 인자 레벨을 각 entry에 붙인다(모델이 스스로 적게 하지 않는다).
 * 5. 부분 성공 — 10개보다 적어도 성공. 걸러진 수·못 넣은 include는 화면이 알린다.
 */
export function applyVocabPostprocess(input: JaVocabPostprocessInput): JaVocabPostprocessResult {
  const includeSet = new Set(normalizeJaWordList(input.include));
  const excludeWords = new Set(input.exclude.map((e) => normalizeJaWord(e.word)));
  const excludeKana = new Set(input.exclude.map((e) => normalizeJaWord(e.kana)));

  const originalCount = input.entries.length;

  // 1) 제외 재적용 (include 예외)
  const afterExclude = input.entries.filter((e) => {
    const w = normalizeJaWord(e.word);
    if (includeSet.has(w)) return true; // include는 제외보다 우선(§2-0)
    const k = normalizeJaWord(e.kana);
    return !(excludeWords.has(w) || excludeKana.has(k));
  });

  // 3) 중복 접기 — kana 기준. 같은 kana 그룹에서 include 쪽을 우선해 남긴다(첫 등장 순서 유지).
  const byKana = new Map<string, JaVocabGenEntry>();
  const order: string[] = [];
  for (const e of afterExclude) {
    const k = normalizeJaWord(e.kana);
    const existing = byKana.get(k);
    if (!existing) {
      byKana.set(k, e);
      order.push(k);
      continue;
    }
    // 이미 있는데 새로 온 것이 include면 include 쪽으로 교체(포함 우선). 그 외엔 첫 등장 유지.
    const newIsInclude = includeSet.has(normalizeJaWord(e.word));
    const existingIsInclude = includeSet.has(normalizeJaWord(existing.word));
    if (newIsInclude && !existingIsInclude) byKana.set(k, e);
  }
  const folded = order.map((k) => byKana.get(k)!);

  // 4) 레벨 태깅 (imageEmoji는 호출 A가 낸 값을 그대로 실어 나른다 — §작업1)
  const entries: JaVocabEntry[] = folded.map((e) => ({
    word: e.word,
    kana: e.kana,
    wordTokens: e.wordTokens,
    pos: e.pos,
    meaningsKo: e.meaningsKo,
    example: e.example,
    imageEmoji: e.imageEmoji,
    definitionJa: e.definitionJa,
    definitionTokens: e.definitionTokens,
    level: input.level,
  }));

  // 2) 포함 이행 확인 — 최종 결과 기준. word 일치, 없으면 kana 일치.
  const resultWords = new Set(entries.map((e) => normalizeJaWord(e.word)));
  const resultKana = new Set(entries.map((e) => normalizeJaWord(e.kana)));
  const missingIncludes = normalizeJaWordList(input.include).filter(
    (w) => !resultWords.has(w) && !resultKana.has(w),
  );

  return {
    entries,
    filteredCount: originalCount - entries.length,
    missingIncludes,
  };
}

// ---------------------------------------------------------------------------
// 저장 방어 정규화 — normalizeJaVocabEntry (하위호환)
// 이미 저장된 단어장에는 imageEmoji가 없다(호출 A 이모지는 J2에서 추가). 읽기/쓰기 경로에서 이 헬퍼로
// undefined를 정한 값으로 조인다(Firestore가 undefined 거부). **store.ts는 app-builder가 이 헬퍼를 호출**한다
// — 값 정규화를 여기 한 곳에만 두어(영어 normalizeRelated 관용구) store와 어긋나지 않게 한다.
// ---------------------------------------------------------------------------

/** normalizeJaVocabEntry가 받는 느슨한 입력 — 구 레코드는 imageEmoji가 없을 수 있다. */
export type LegacyOrNewJaVocabEntry = Partial<JaVocabEntry>;

/**
 * 저장·읽기 직전 방어 정규화. undefined를 정한 값으로 조이고, 구 레코드에 없는 imageEmoji는 null로 채운다.
 * 값을 손보지 않는다 — 없는 것을 없음(null·빈 배열)으로 적을 뿐이다(정렬·병합은 이미 끝났다).
 */
export function normalizeJaVocabEntry(entry: LegacyOrNewJaVocabEntry): JaVocabEntry {
  return {
    word: entry.word ?? "",
    kana: entry.kana ?? "",
    wordTokens: entry.wordTokens ?? [],
    pos: entry.pos ?? [],
    meaningsKo: entry.meaningsKo ?? [],
    example: entry.example ?? { ja: "", ko: "", tokens: [] },
    imageEmoji: entry.imageEmoji ?? null, // 구 레코드(이모지 없음) → null 폴백
    definitionJa: entry.definitionJa ?? null, // 구 레코드(일일정의 없음) → null 폴백(하위호환)
    definitionTokens: entry.definitionTokens ?? null, // 구 레코드(정의 토큰 없음) → null 폴백(하위호환)
    level: entry.level ?? null,
  };
}

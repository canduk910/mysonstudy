/**
 * lib/ai/japanese/kanji.ts — 한자 단위 학습(JK)의 순수 함수 (docs/harness/japanese.md §12-1·§12-2-3)
 *
 * **AI 호출 0.** 한자는 사용자가 따로 만들지 않고 **저장된 JLPT 단어장 표기에서 자동 수집**한다(§12-1).
 * 정보 채우기(호출 D)는 **아직 정보가 없는 한자만** 대상으로 하고(불변 규약), 요청 밖 한자는 코드가 버린다(§12-2-3).
 * 값을 만드는 것은 여기뿐 — 수집·선별·후처리 규칙이 두 곳에 살면 어긋난다.
 */

import { JA_KANJI_SAMPLE_WORDS_MAX, type JaKanjiInfo } from "./schemas";

/** 한자(CJK 통합·확장 A·반복부호 々) 한 글자인가. */
function isKanjiChar(ch: string): boolean {
  return /[一-鿿㐀-䶿々]/.test(ch);
}

/** 수집된 한자 하나 — 문자와 그 한자가 든 내 단어들(맥락·역인덱스). */
export interface CollectedKanji {
  kanji: string;
  /** 이 한자가 든 단어장 표기들(등장 순서·중복 제거) */
  words: string[];
}

/** 단어장 최소 입력(구조적) — JaVocabBookRecord가 만족. */
export interface JaKanjiSourceBook {
  entries: readonly { word: string }[];
}

/** 호출 D 요청 한 항목 — 한자 + 맥락 예시 단어. */
export interface JaKanjiRequestItem {
  kanji: string;
  sampleWords: string[];
}

/**
 * 저장된 단어장 전체에서 한자를 수집한다(§12-1). 표기(word)의 **한자 문자만**, 중복 제거, 등장 순서 유지.
 * 각 한자에 그 한자가 든 단어들을 역인덱스로 달아 준다(맥락·화면 "이 한자가 든 단어들").
 */
export function collectKanjiFromBooks(books: readonly JaKanjiSourceBook[]): CollectedKanji[] {
  const order: string[] = [];
  const wordsByKanji = new Map<string, string[]>();
  const wordSeen = new Map<string, Set<string>>();

  for (const book of books) {
    for (const entry of book.entries) {
      const word = entry.word;
      // 한 단어 안에서 같은 한자가 두 번 나와도 한 번만 센다
      const kanjiInWord = new Set<string>();
      for (const ch of word) {
        if (isKanjiChar(ch)) kanjiInWord.add(ch);
      }
      for (const kanji of kanjiInWord) {
        let words = wordsByKanji.get(kanji);
        if (!words) {
          words = [];
          wordsByKanji.set(kanji, words);
          wordSeen.set(kanji, new Set());
          order.push(kanji);
        }
        const seen = wordSeen.get(kanji)!;
        if (!seen.has(word)) {
          seen.add(word);
          words.push(word);
        }
      }
    }
  }

  return order.map((kanji) => ({ kanji, words: wordsByKanji.get(kanji)! }));
}

/**
 * 정보를 채울 한자만 고른다(§12-2 불변 규약) — 이미 정보가 있는 한자(existing)는 요청에 넣지 않는다.
 * 각 요청 항목에 맥락 예시 단어를 최대 JA_KANJI_SAMPLE_WORDS_MAX개 실어 준다(어느 음독이 실제로 쓰이는지 모델이 알게).
 *
 * @param collected collectKanjiFromBooks 결과
 * @param existing  이미 정보가 있는 한자 문자들(스토어에 JaKanjiRecord가 있는 것)
 */
export function selectKanjiToEnrich(
  collected: readonly CollectedKanji[],
  existing: Iterable<string>,
): JaKanjiRequestItem[] {
  const have = new Set(existing);
  const out: JaKanjiRequestItem[] = [];
  for (const c of collected) {
    if (have.has(c.kanji)) continue; // 이미 채워진 한자는 건너뛴다(불변)
    out.push({ kanji: c.kanji, sampleWords: c.words.slice(0, JA_KANJI_SAMPLE_WORDS_MAX) });
  }
  return out;
}

export interface JaKanjiPostprocessResult {
  /** 요청한 한자만·중복 제거된 정보 */
  items: JaKanjiInfo[];
  /** 요청 밖(또는 중복)이라 버린 개수 */
  droppedCount: number;
  /** 요청했지만 결과에 없는 한자(오류가 아니라 보고 대상, 부분 성공 §12-2-3) */
  missingKanji: string[];
}

/**
 * 호출 D 결과 후처리(§12-2-3): 요청한 한자만 남기고(요청 밖은 버림), 중복 접기, 빠진 한자는 보고한다.
 * 빠진 한자는 오류가 아니다 — 실패로 되돌리지 말고 "이 한자는 못 채웠어요"로 화면에 알린다(부분 성공).
 *
 * @param items     zod 통과한 호출 D items
 * @param requested 이 배치에서 요청한 한자 문자들
 */
export function applyKanjiPostprocess(
  items: readonly JaKanjiInfo[],
  requested: Iterable<string>,
): JaKanjiPostprocessResult {
  const requestedSet = new Set(requested);
  const kept: JaKanjiInfo[] = [];
  const keptSet = new Set<string>();
  for (const it of items) {
    if (!requestedSet.has(it.kanji)) continue; // 요청 밖 한자 버리기
    if (keptSet.has(it.kanji)) continue; // 중복 접기(첫 등장 유지)
    keptSet.add(it.kanji);
    kept.push(it);
  }
  const missingKanji = [...requestedSet].filter((k) => !keptSet.has(k));
  return { items: kept, droppedCount: items.length - kept.length, missingKanji };
}

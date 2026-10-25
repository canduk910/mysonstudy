/**
 * scripts/eval-review-fixture.ts — eval:review의 "은우만 문제 맞히기로 바꿔도 다른 영역 카드는 그대로" 점검용 고정 입력(지어낸 데이터).
 *
 * `nonEnglishReviewSnapshot(m)`은 어댑터 모듈(lib/review-sources)을 받아 일본어(단어·한자)·토익(표현·틀·답변 섬)·엄마 어댑터 산출을
 * JSON 한 줄로 낸다. eval은 이 문자열의 sha256을 고정값과 대조한다 — 고정값은 2026-10-25 은우 문제 맞히기 회차 **직전 커밋**
 * (HEAD 9a386e6의 lib/review-sources.ts)으로 같은 함수를 돌려 얻은 값이다(바이트 불변 확인). 다른 영역 카드를 일부러 바꾸는
 * 회차는 이 고정값을 그 회차 리포트와 함께 갱신한다.
 */

import type * as ReviewSources from "../lib/review-sources";

type M = Pick<typeof ReviewSources, "japaneseWordItems" | "japaneseKanjiItems" | "toeicExpressionItems" | "toeicTemplateItems" | "toeicIslandItems" | "momSentenceItems">;

const ses = (startedAt: string, items: [string, boolean, boolean | null][]) => ({ startedAt, items: items.map(([word, correct, answered]) => ({ word, correct, answered })) });

export function nonEnglishReviewSnapshot(m: M): string {
  const ja = m.japaneseWordItems(
    [{ id: "j1", titleKo: "N5 · 동물", createdAt: "2026-09-01T00:00:00.000Z", entries: [
      { word: "猫", kana: "ねこ", meaningsKo: ["고양이"], imageEmoji: "🐱", wordTokens: [{ surface: "猫", reading: "ねこ" }] },
      { word: "犬", kana: "いぬ", meaningsKo: ["개", "강아지"], imageEmoji: null, wordTokens: [{ surface: "犬", reading: "いぬ" }] },
    ] }],
    [ses("2026-09-02T00:00:00.000Z", [["猫", true, true], ["犬", false, true]])],
  );
  const kanji = m.japaneseKanjiItems(
    [{ kanji: "学", koReading: "학", onyomi: ["がく"], kunyomi: ["まなぶ"], meaningKo: "배우다" }],
    [ses("2026-09-03T00:00:00.000Z", [["学", false, true]])],
  );
  const expr = m.toeicExpressionItems(
    [{ id: "s1", titleKo: "DAY 1 출근", createdAt: "2026-09-01T00:00:00.000Z", entries: [
      { expression: "Hand out  flyers", meaningKo: "전단지를 나눠 주다", example: "They hand out flyers at the gate.", exampleKo: "그들은 문 앞에서 전단지를 나눠 준다." },
      { expression: "be in charge of ~", meaningKo: "~을 맡다", example: null, exampleKo: null },
    ] }],
    [ses("2026-09-02T00:00:00.000Z", [["hand out flyers", true, true], ["be in charge of ~", false, true]])],
  );
  const tpl = m.toeicTemplateItems(
    [{ key: "intro", frameEn: "I'd like to talk about {topic}.", frameKo: "{topic}에 대해 말하고 싶어요.", useKo: "말 꺼내기", examples: [{ en: "I'd like to talk about my weekend.", ko: "주말에 대해 말하고 싶어요." }] }],
    [ses("2026-09-04T00:00:00.000Z", [["tpl:intro", false, true]])],
    [],
    [],
  );
  const island = m.toeicIslandItems(
    [{ id: "isl-m-a1", en: "What I like most about my town is the quiet park.", ko: "우리 동네에서 가장 좋은 점은 조용한 공원이에요.", topicNameKo: "동네", question: null, frameKey: "fd-like", createdAt: "2026-10-02T03:00:00.000Z" }],
    [{ key: "fd-like", frameEn: "What I like most about {thing} is {reason}.", frameKo: "{thing}에서 가장 좋은 점은 {reason}이에요." }],
  );
  const mom = m.momSentenceItems(
    [{ id: "b1", week: 5, frame: { text: "I would like ~", slots: [] }, sentences: [{ id: "b1-s0", role: "core", en: "I would like tea.", ko: "차 주세요.", chunks: ["I would like", "tea."] }] }] as never,
    [{ id: "c1", lessonId: "w5-d1", startedAt: "2026-10-10T03:00:00.000Z", finishedAt: "2026-10-10T03:05:00.000Z", checks: [{ sentenceId: "b1-s0", verdict: "retry", transcript: "x", hintLevel: 0 }] }] as never,
    [],
  );
  return JSON.stringify({ ja, kanji, expr, tpl, island, mom });
}

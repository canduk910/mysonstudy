/**
 * lib/toeic-listen.ts — 표현집 **전체 듣기** 대본 순수 함수 (docs/harness/toeic.md §6-3)
 *
 * `buildToeicListenScript(set, mode)` → `{text, lang, entryIndex}[]`. 재생은 화면이 speakQueue로 한다(SPEC §18 관용구 —
 * 탭 안에서 동기 호출, onItem으로 지금 읽는 카드 강조). 화면은 판단하지 않고 이 대본을 소비만 한다.
 *
 * - 모드 ① basic: 표현(en) → 뜻(ko) → 예문(en) ② with-use: ①에 useIn 문장(en) 추가 ③ english-only: 표현·예문·useIn·followUp(en) — 따라 말하기용
 * - 300자(TTS_TEXT_MAX_CHARS)를 넘는 조각은 splitForTts(lib/tts-split.ts)로 문장 단위로 나눈다.
 * - 영어 조각은 trim만 한다 — 카드의 🔊 `speak(text, "en-US")`·프리페치와 글자까지 같아야 캐시가 맞는다.
 *   한국어 뜻은 물결표(~·〜·～, 교재의 "~에 따르다" 자리 표시)를 지우고 공백을 접는다(TTS가 기호를 읽지 않게).
 * - lang은 항상 명시한다(한국어를 영어 음성으로 읽는 실수 방지, §6-1 소리 규칙).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(tts-shared·tts-split)뿐, lib/ai는 `import type`만.
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { splitForTts } from "./tts-split";
import type { ToeicPart } from "./ai/toeic/schemas";

export const TOEIC_LISTEN_MODES = ["basic", "with-use", "english-only"] as const;
export type ToeicListenMode = (typeof TOEIC_LISTEN_MODES)[number];

export const TOEIC_LISTEN_MODE_LABELS_KO: Record<ToeicListenMode, string> = {
  basic: "표현·뜻·예문",
  "with-use": "활용 문장까지",
  "english-only": "영어만",
};

export interface ToeicListenPiece {
  text: string;
  lang: "en-US" | "ko-KR";
  /** 강조할 카드(세트 entries 위치) */
  entryIndex: number;
}

/** 대본이 읽는 최소 모양(ToeicSetRecord가 구조적으로 만족) */
export interface ToeicListenSource {
  entries: readonly {
    expression: string;
    meaningKo: string;
    example: string | null;
    points: {
      useIn: readonly { part: ToeicPart; sentence: string }[];
      followUp: { en: string };
    } | null;
  }[];
}

/** 한국어 뜻을 TTS용으로 — 물결표 제거·공백 접기 */
export function cleanKoForListen(text: string): string {
  return text.replace(/[~〜～]/g, " ").replace(/\s+/g, " ").trim();
}

/** 전체 듣기 대본(§6-3). 빈 조각은 넣지 않는다. */
export function buildToeicListenScript(set: ToeicListenSource, mode: ToeicListenMode): ToeicListenPiece[] {
  const out: ToeicListenPiece[] = [];
  const push = (raw: string | null | undefined, lang: ToeicListenPiece["lang"], entryIndex: number) => {
    const t = lang === "ko-KR" ? cleanKoForListen(raw ?? "") : (raw ?? "").trim();
    if (!t) return;
    for (const text of splitForTts(t, TTS_TEXT_MAX_CHARS)) out.push({ text, lang, entryIndex });
  };

  set.entries.forEach((e, i) => {
    push(e.expression, "en-US", i);
    if (mode !== "english-only") push(e.meaningKo, "ko-KR", i);
    push(e.example, "en-US", i);
    if (mode === "with-use" || mode === "english-only") {
      for (const u of e.points?.useIn ?? []) push(u.sentence, "en-US", i);
    }
    if (mode === "english-only") push(e.points?.followUp.en, "en-US", i);
  });
  return out;
}

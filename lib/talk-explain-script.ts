/**
 * lib/talk-explain-script.ts — 자유대화 문장 설명(호출 I의 script) → **낭독 대본**(speakQueue 조각) 순수 함수
 * (docs/harness/english.md §12-3 "설명 낭독", SPEC §18 관용구)
 *
 * - ko 조각 → `ko-KR`, en 조각 → `en-US`. lang은 늘 명시한다(한국어를 영어 음성으로 읽는 실수 방지).
 * - 한국어는 `normalizeKoForTts`(화살표·물결표·이모지 정리)를 **쪼개기 전에** 거치고, 300자(TTS_TEXT_MAX_CHARS)를 넘는 조각은
 *   `splitForTts`(lib/tts-split.ts)로 문장 단위로 나눈다 — speakQueue는 조각을 쪼개지 않으므로 넘치면 그 조각만 기기 음성이 된다.
 * - 영어는 trim만 한다(말풍선 🔊 `speak(text, "en-US")`·프리페치와 글자까지 같아야 캐시가 맞는다 — 토익 전체 듣기와 같은 규칙).
 * - `pieceIndex`는 원래 script 조각 번호다 — 화면이 speakQueue `onItem`으로 지금 읽는 말풍선을 강조한다.
 *
 * 재생은 화면이 한다: 결과가 fetch 뒤에 오므로 **문장 탭 핸들러 안에서 동기로 `unlockSpeechPlayback()`**을 먼저 부르고,
 * 설명이 도착하면 이 대본을 speakQueue에 넘긴다(탭 밖 재생 잠금 — 운동·토익 응시 관용구).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(tts-shared·tts-split·ja-coaching-script의 정리 함수)뿐, lib/ai는 `import type`만.
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { splitForTts } from "./tts-split";
import { normalizeKoForTts } from "./ja-coaching-script";
import type { TalkScriptLang, TalkScriptPiece } from "./ai/english/talk-schemas";

/** 설명 script의 lang → 클라우드 TTS 언어 */
export const TALK_SCRIPT_TTS_LANG: Readonly<Record<TalkScriptLang, "ko-KR" | "en-US">> = {
  ko: "ko-KR",
  en: "en-US",
};

/** 재생할 조각 하나(speakQueue의 SpeakQueueItem 모양 + 강조용 번호) */
export interface TalkExplainSpeakPiece {
  /** 읽을 텍스트(trim됨, 비어 있지 않음, length ≤ TTS_TEXT_MAX_CHARS) */
  text: string;
  lang: "ko-KR" | "en-US";
  /** 원래 script 조각 번호(쪼갠 조각은 같은 번호) */
  pieceIndex: number;
}

/** 설명 대본 → 낭독 조각. 빈 조각은 넣지 않는다. 같은 입력은 늘 같은 조각(결정적). */
export function buildTalkExplainSpeakQueue(script: readonly TalkScriptPiece[]): TalkExplainSpeakPiece[] {
  const out: TalkExplainSpeakPiece[] = [];
  script.forEach((piece, pieceIndex) => {
    const lang = TALK_SCRIPT_TTS_LANG[piece.lang];
    if (!lang) return;
    const t = piece.lang === "ko" ? normalizeKoForTts(piece.text ?? "") : (piece.text ?? "").trim();
    if (t === "") return;
    for (const text of splitForTts(t, TTS_TEXT_MAX_CHARS)) out.push({ text, lang, pieceIndex });
  });
  return out;
}

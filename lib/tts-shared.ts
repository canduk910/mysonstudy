/**
 * lib/tts-shared.ts — 클라우드 TTS의 **순수 상수·타입 단일 정의처** (SPEC §16)
 *
 * 왜 별도 파일인가: 이 상수들(언어 화이트리스트·길이 상한·속도 범위)을 **서버(lib/tts.ts·/api/tts)**와
 * **클라이언트(lib/speech.ts)**가 함께 써야 한다. 그런데 lib/tts.ts는 `openai`를 import하므로, speech.ts가
 * 거기서 상수를 끌어오면 **openai가 클라이언트 번들에 딸려 들어간다.** 그래서 런타임 의존성이 0인 이 파일에만
 * 상수를 두고, 양쪽이 여기서 가져간다(사이트워드 목록을 한 곳에만 두는 규약과 같은 자리).
 *
 * 이 파일은 브라우저/서버 어디서 import해도 안전하다 — 값·타입뿐, 부작용 없음.
 */

/** 클라우드 TTS를 적용할 언어(BCP-47). 그 밖의 언어는 기기 음성으로 폴백한다. */
export const TTS_LANGS = ["en-US", "ja-JP"] as const;
export type TtsLang = (typeof TTS_LANGS)[number];

/** 주어진 문자열이 클라우드 TTS 대상 언어인지 (클라이언트 사전판정·서버 검증 공용). */
export function isTtsLang(lang: string): lang is TtsLang {
  return (TTS_LANGS as readonly string[]).includes(lang);
}

/**
 * 한 번에 합성할 텍스트 길이 상한(문자). OpenAI 한도(4096)보다 훨씬 보수적으로 잡는다 —
 * 이 앱이 읽는 건 단어·한 문장·짧은 예문이라 이 정도면 충분하고, **사고성 대용량·비용 폭주를 막는다**(§16-1).
 * 넘으면 합성하지 않고 기기 음성으로 폴백한다(클라이언트가 사전 판정, 서버도 400으로 재확인).
 */
export const TTS_TEXT_MAX_CHARS = 300;

/** OpenAI speech `speed` 허용 범위(0.25~4.0). 3단 프리셋(0.7·0.9·1.1)은 이 안에 든다. */
export const TTS_SPEED_MIN = 0.25;
export const TTS_SPEED_MAX = 4.0;

/** speed를 허용 범위로 조인다(방어적 — 라우트 zod가 이미 막지만 lib/tts에서도 한 번 더). */
export function clampTtsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, speed));
}

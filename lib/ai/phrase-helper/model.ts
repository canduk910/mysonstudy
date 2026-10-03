/**
 * lib/ai/phrase-helper/model.ts — 표현 도우미 모델 해석 (docs/harness/phrase-helper.md §0-2·§7, SPEC §11)
 *
 * 사용자 결정(2026-10-03): 표현 도우미는 세 모드(toeic·japanese·english-kid) 모두 **gpt-6-luna**.
 * env `OPENAI_PHRASE_HELPER_MODEL`(앞뒤 공백 무시). 빈 값·공백이면 기본값(`||` — SPEC §11 빈 값 폴백 관용구).
 * `OPENAI_MODEL`로 폴백하지 **않는다** — 메인 모델을 바꿔도 도우미 모델이 따라 움직이지 않게(호출 J `OPENAI_TALK_CARDS_MODEL`·
 * 토익 `OPENAI_TOEIC_MODEL`과 같은 모양).
 *
 * 의존성 없는 순수 모듈이다 — openai SDK·client.ts를 끌어오지 않아 eval 오프라인 구간이 정적으로 import할 수 있다.
 */

/** 표현 도우미 기본 모델. 설치된 SDK의 `ChatModel` 목록에 아직 없어 string이다. */
export const DEFAULT_PHRASE_HELPER_MODEL: string = "gpt-6-luna";

/** 표현 도우미 모델 — env `OPENAI_PHRASE_HELPER_MODEL`, 비면 DEFAULT_PHRASE_HELPER_MODEL */
export function resolvePhraseHelperModel(): string {
  return process.env.OPENAI_PHRASE_HELPER_MODEL?.trim() || DEFAULT_PHRASE_HELPER_MODEL;
}

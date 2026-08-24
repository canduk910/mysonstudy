/**
 * lib/word-meaning-contract.ts — `POST /api/word-meaning`(북카드 M2 · 챕터 리더 단어 더블탭)의 응답 계약
 *
 * **타입만 있는 모듈이다**(vocab-add-word-contract와 같은 자리). 값 export가 없으므로 라우트(서버)와
 * 챕터 리더(클라이언트)가 같은 정의를 보면서도 클라이언트 번들에는 아무것도 새지 않는다.
 * qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을 교차 검증할 때 볼 단일 정의처다.
 *
 * ── 무엇을 하는 라우트인가 ─────────────────────────────────────────────────
 * 챕터 리더의 영어 문장에서 은우가 더블탭한 단어와, 그 단어가 속한 **문장(맥락)**을 받아,
 * 호출 G(lookupWordMeaning)로 **그 문맥에서의 짧은 우리말 뜻**을 돌려준다. 다의어는 문장 맥락의
 * 뜻을 고른다(예: "Turn left." → "왼쪽" / "She left." → "떠났다").
 *
 * ── 상태코드 계약 ──────────────────────────────────────────────────────────
 * - 200 { ok:true,  word, meaningKo }                         ← 정상
 * - 400 { ok:false, error:"invalid_input", messageKo }        ← 단어/문장 누락·형식 오류
 * - 500 { ok:false, error:"ai_failed",     messageKo }        ← 호출 G 재요청 소진(throw)
 * - 501 { ok:false, error:"no_api_key",    messageKo }        ← 서버에 OPENAI_API_KEY 없음(실호출 전 거절)
 * 판독 실패가 아니라 뜻 조회이므로, 실패는 전부 비치명 안내로 화면이 받는다(단어 담기는 별도 동작).
 */

export interface WordMeaningSuccess {
  ok: true;
  /** 조회에 쓴 정규화(trim)된 단어 — 화면이 팝업에 그대로 표시한다 */
  word: string;
  /** 그 문맥에서의 우리말 뜻(한 낱말~짧은 구). "모은 단어" 담기의 meanings[].ko로도 쓴다 */
  meaningKo: string;
}

export type WordMeaningErrorCode =
  | "invalid_input" // 400 — 단어·문장 누락 또는 형식 오류
  | "no_api_key" // 501 — 서버에 OPENAI_API_KEY 없음(실호출 전 구조적 거절)
  | "ai_failed"; // 500 — 호출 G 재요청 소진(throw)

export interface WordMeaningFailure {
  ok: false;
  error: WordMeaningErrorCode;
  messageKo: string;
}

export type WordMeaningResponse = WordMeaningSuccess | WordMeaningFailure;

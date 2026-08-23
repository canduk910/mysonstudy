/**
 * lib/vocab-enrich-contract.ts — `POST /api/english/vocab/[id]/enrich`(호출 D 보강)의 응답 계약 (V3)
 *
 * **타입만 있는 모듈이다**(vocab-extract-contract와 같은 자리). 값 export가 없으므로 라우트(서버)와
 * 단어장 상세 화면(클라이언트)이 같은 정의를 보면서도 클라이언트 번들에는 아무것도 새지 않는다.
 * qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을 교차 검증할 때 볼 단일 정의처다.
 *
 * ── 왜 요청 본문이 없나 ─────────────────────────────────────────────────────
 * 보강 대상은 **저장된 entries 중 `definitionEn === null`인 단어**로 서버가 정한다(정의 불변 —
 * 이미 채워진 정의는 입력에서 빠지고 병합도 null 자리에만 채운다). 화면이 무엇을 보강할지 고르지
 * 않으므로 body가 필요 없다(id는 경로에). POST만 보내면 서버가 대상을 추려 채운다.
 *
 * ── 왜 갱신된 entries를 응답에 싣지 않나 ────────────────────────────────────
 * 상세 페이지는 서버 컴포넌트(force-dynamic)라, 화면은 성공 뒤 `router.refresh()`로 최신 entries를
 * 다시 받아 그린다. 그래서 응답은 **무엇이 채워졌는지 개수만** 싣는다 — entries를 두 경로(응답 병합
 * vs 서버 재조회)로 그리면 어긋날 여지가 생긴다. 개수는 안내 문구(“N개 만들었어요”)에만 쓴다.
 *
 * 참조: `docs/harness/english.md` §8(호출 D) · 계획 §V3(정의 불변)
 */

/**
 * 200 성공 — 병합 결과가 저장됐다. **부분 성공도 여기로 온다**(일부 단어를 모델이 정의 못 해
 * `remainingDefinitions > 0`으로 남을 수 있다 — 그건 오류가 아니라 “다음에 다시 만들기” 대상이다).
 * 보강할 것이 없던(이미 완료) 경우도 여기로 온다(filled 0, remaining 0, enriched true).
 */
export interface VocabEnrichSuccess {
  ok: true;
  id: string;
  /** 이번 요청에서 새로 **영영 뜻(definitionEn)**을 채운 단어 수(원래 null이던 자리에 들어간 것만) */
  filledDefinitions: number;
  /**
   * 이번 요청에서 새로 **우리말 해석(definitionKo)**을 채운 단어 수(V7). 정의(EN)와 독립 —
   * EN은 이미 있고 KO만 비어 있던 단어를 백필하면 filledDefinitions=0인데 이 값만 오른다.
   */
  filledKoGlosses: number;
  /** 이번 요청에서 새로 **이모지**를 채운 단어 수(정의와 독립) */
  filledEmojis: number;
  /** 아직 **영영 뜻(EN)**이 비어 있는 단어 수. 0이면 모든 단어에 정의가 있다(시험 게이트 관점) */
  remainingDefinitions: number;
  /**
   * 아직 **우리말 해석(KO)**이 비어 있는 단어 수(V7). remainingDefinitions와 분리해,
   * "정의는 있는데 해석만 남은" 경우를 UI가 정확히 안내하게 한다(EN·KO를 한 숫자로 뭉치지 않는다).
   */
  remainingGlosses: number;
  /** 모든 단어에 영영 뜻(EN)이 찼는지 (`isVocabBookEnriched` 결과 = record.enriched, EN 기준·게이트 불변) */
  enriched: boolean;
}

/** 오류 코드 */
export type VocabEnrichErrorCode =
  | "vocabbook_not_found" // 404 — 없는 id이거나 열 수 없는(비렌더러블) 레코드
  | "enrich_failed" // 500 — 호출 D가 재요청까지 소진해 throw / 저장 실패 (retriable)
  | "no_api_key"; // 501 — 서버에 OPENAI_API_KEY가 없음

export interface VocabEnrichFailure {
  ok: false;
  error: VocabEnrichErrorCode;
  messageKo: string;
  /** enrich_failed일 때 true — 화면이 “다시 만들기”로 재시도해도 좋다는 신호 */
  retriable?: boolean;
}

export type VocabEnrichResponse = VocabEnrichSuccess | VocabEnrichFailure;

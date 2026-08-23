/**
 * lib/vocab-add-word-contract.ts — `POST /api/english/vocab/[id]/add-word`(V8 더블탭 담기)의 응답 계약
 *
 * **타입만 있는 모듈이다**(vocab-enrich-contract와 같은 자리). 값 export가 없으므로 라우트(서버)와
 * 단어장 상세 화면(클라이언트)이 같은 정의를 보면서도 클라이언트 번들에는 아무것도 새지 않는다.
 * qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을 교차 검증할 때 볼 단일 정의처다.
 *
 * ── 무엇을 하는 라우트인가 ─────────────────────────────────────────────────
 * 정의(EN)·예문(EN) 텍스트에서 은우가 모르는 단어를 더블탭하면, 그 단어를 **지금 보고 있는 DAY
 * 단어장**(경로의 id)에 새 항목으로 추가한다. 추가 즉시 호출 D(enrichVocab) 1콜로 그 단어의
 * 영영정의·우리말해석·이모지를 생성해 채운다.
 *
 * ── 단어 유실 금지(best-effort 보강) ───────────────────────────────────────
 * 이 라우트의 주목적은 **단어를 담는 것**이고, 뜻 생성은 부수적이다. 그래서:
 * - 호출 D가 실패해도(재요청 소진 throw) 단어는 뜻 null로 저장되고 200으로 내려간다
 *   (`enrichSkipped:"enrich_failed"`). 화면은 "다시 만들기"로 나중에 채운다.
 * - **API 키가 없어도 단어는 저장**한다. 다만 이 경우만 상태코드를 501로 내려(enrich 라우트의
 *   no_api_key 관용구와 맞춘다) 키 설정이 필요함을 알린다 — 그래도 `added:true`라 화면은
 *   router.refresh로 새 항목을 반영한다(단어 유실 0).
 *
 * ── 왜 갱신된 entries를 응답에 싣지 않나 ────────────────────────────────────
 * 상세 페이지는 서버 컴포넌트(force-dynamic)라, 화면은 성공 뒤 `router.refresh()`로 최신 entries를
 * 다시 받아 그린다(enrich 라우트와 같은 규약). 응답은 무엇이 일어났는지(담김·중복·뜻 채움)만 싣는다.
 *
 * 참조: `docs/harness/english.md` §8(호출 D) · 계획 §V3(정의 불변) · V8 오케스트레이터 결정
 */

/**
 * 200 성공 — 요청을 정상 처리했다. **"성공 = 그 단어가 이제 이 단어장에 있다"**로 읽는다:
 * - `added:true`  → 이번에 새로 담았다.
 * - `added:false` → 이미 그 단어장에 있어(대소문자 무시 word 비교) 담지 않았다(중복 안내).
 * enrich 실패(비치명)도 여기로 온다(`added:true` + `enrichSkipped:"enrich_failed"` + definitionFilled:false).
 */
export interface VocabAddWordSuccess {
  ok: true;
  id: string;
  /** 저장/조회에 쓴 정규화(trim)된 단어 */
  word: string;
  /** true=새로 담음 / false=이미 있어 담지 않음(중복) */
  added: boolean;
  /** 이번에 영영 뜻(definitionEn)을 채웠는지. added=false거나 enrich 스킵/실패면 false */
  definitionFilled: boolean;
  /** 뜻 생성을 건너뛴/실패한 사유(비치명). 정상 생성(또는 중복이라 시도 안 함)이면 null */
  enrichSkipped: null | "enrich_failed";
}

/** 오류 코드 */
export type VocabAddWordErrorCode =
  | "vocabbook_not_found" // 404 — 없는 id이거나 열 수 없는(비렌더러블) 레코드 → 담을 곳이 없다
  | "invalid_word" // 400 — 빈 단어·영문 단어 아님·길이 초과(사용자 입력 방어)
  | "no_api_key"; // 501 — 서버에 OPENAI_API_KEY가 없음(단어는 뜻 null로 저장됨)

export interface VocabAddWordFailure {
  ok: false;
  error: VocabAddWordErrorCode;
  messageKo: string;
  /**
   * `no_api_key`일 때만 true — 키가 없어 뜻은 못 만들었지만 **단어는 저장됐다**(뜻 null).
   * 클라이언트는 이 신호로 router.refresh를 돌려 새 항목을 반영하고 "뜻은 나중에" 안내만 띄운다.
   * 다른 오류(400·404)에는 없다(저장 자체가 일어나지 않음).
   */
  added?: boolean;
}

export type VocabAddWordResponse = VocabAddWordSuccess | VocabAddWordFailure;

/**
 * lib/vocab-rename-contract.ts — `POST /api/english/vocab/[id]/rename`(단어장 이름 수정)의 응답 계약
 *
 * **타입만 있는 모듈이다**(vocab-add-word-contract와 같은 자리). 값 export가 없으므로 라우트(서버)와
 * 상세 헤더의 인라인 편집 컴포넌트(클라이언트)가 같은 정의를 보면서도 클라이언트 번들에는 아무것도
 * 새지 않는다. qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을 교차 검증할 때 볼 단일 정의처다.
 *
 * ── 무엇을 하는 라우트인가 ─────────────────────────────────────────────────
 * 단어장(DAY 레코드)의 **화면 이름(titleKo)만** 바꾼다. entries·정의·enriched·dayLabel·판독 결과는
 * 손대지 않는다(수정이라 prod-guard 무관). 만들 때만 정하던 이름을 상세 헤더에서 인라인으로 고친다.
 *
 * ── 왜 갱신된 record 전체를 응답에 싣지 않나 ────────────────────────────────
 * 상세 페이지는 서버 컴포넌트(force-dynamic)라, 화면은 성공 뒤 `router.refresh()`로 최신 레코드를
 * 다시 받아 그린다(enrich·add-word 라우트와 같은 규약). 응답은 무엇이 바뀌었는지(새 titleKo)만 싣는다.
 *
 * 상한(`VOCAB_LIMITS.titleKo`)의 단일 정의처는 `lib/vocab-create-contract.ts`다 — 저장 요청과 같은
 * 값을 라우트 zod와 편집창 maxLength가 함께 본다(두 곳에 흩어지면 어긋난다).
 */

/** 200 성공 — 이름을 바꿨다. 클라이언트는 router.refresh로 목록·헤더·카드 chrome 제목을 갱신한다 */
export interface VocabRenameSuccess {
  ok: true;
  id: string;
  /** 저장된 정규화(trim)된 새 이름 */
  titleKo: string;
}

/** 오류 코드 */
export type VocabRenameErrorCode =
  | "invalid_input" // 400 — zod 검증 실패(빈 이름·길이 초과·JSON 아님)
  | "vocabbook_not_found" // 404 — 없는 id이거나 열 수 없는(비렌더러블) 레코드
  | "save_failed"; // 500 — 스토어 저장 실패

export interface VocabRenameFailure {
  ok: false;
  error: VocabRenameErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
}

export type VocabRenameResponse = VocabRenameSuccess | VocabRenameFailure;

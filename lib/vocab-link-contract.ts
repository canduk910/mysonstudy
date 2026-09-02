/**
 * lib/vocab-link-contract.ts — `POST/DELETE /api/english/vocab/[id]/link`(유의어/반의어 연결)의 요청·응답 계약
 *
 * **타입만 있는 모듈이다**(vocab-rename-contract·vocab-quiz-contract와 같은 자리). 값 export가 없으므로
 * 라우트(서버)와 연결 UI(클라이언트)가 같은 정의를 보면서도 클라이언트 번들에는 아무것도 새지 않는다.
 * qa-inspector가 라우트 요청·응답 shape ↔ 프론트가 보내는·기대하는 타입을 교차 검증할 단일 정의처다.
 *
 * ── 무엇을 하는 기능인가 ─────────────────────────────────────────────────────
 * 사용자가 어떤 단어 뜻의 유의어·반의어를 잇는다. 상대를 고르는 방식이 둘이다:
 * 1. **AI 추천(호출 H, `suggest-related`)** — 그 뜻에 맞는 실제 후보를 보여주고, 고르면
 * 2. **추가·연결(`add-related`)** — 그 단어가 단어장에 없으면 **새로 추가(+즉시 자동 보강 호출 D)**, 이미 있으면 **연결만**.
 * 직접 입력(영단어+짧은 우리말 뜻)도 같은 `add-related`로 흐른다. 연결은 의미별(meaning 단위)이고 양쪽
 * 뜻에 상호 표시된다(`source:"user"`). 관계 문제 시험(`buildRelationQuestions`)이 이 사용자 링크만 대상으로 삼는다.
 * 연결 자체는 AI 무관(glossKo는 대상 뜻 ko 복사)이지만, 후보 추천·새 단어 보강은 AI(호출 H·D)를 쓴다.
 *
 * 인덱스 기반 `POST/DELETE /link`(아래 VocabLinkRequest)는 **해제(unlink)** 와 기존 항목 간 직접 연결에 남고,
 * 추천 흐름의 "고름 → 추가/연결"은 `add-related`가 담당한다(word로 존재 판정 후 append 또는 link).
 *
 * ── 왜 인덱스(sourceIndex/targetIndex)로 가리키나 (교재 번호 no가 아니라) ──────────
 * 단어를 `VocabEntry.no`로 가리키면 손으로 담은 단어(add-word)는 no가 **null**이고, 판독분도 같은
 * no가 겹칠 수 있어(오독) 유일 식별이 안 된다. 그래서 UI가 보는 `entries` 배열의 **0-based 위치**로
 * 대상을 가리킨다 — 표·카드 모두 `entries`를 순서대로 그리므로 화면 인덱스 = 배열 인덱스다.
 * 저장 레코드(`VocabRelated.linkedNo`)에는 대상의 실제 no(없으면 null)를 **참조용**으로 그대로 담아
 * 인계 계약을 지킨다. 해제(unlink)는 no가 아니라 안정적인 (kind·상대 word·상대 meaningIndex)로 맞춘다.
 *
 * 상세 페이지는 서버 컴포넌트(force-dynamic)라 화면은 성공 뒤 `router.refresh()`로 최신 레코드를 다시
 * 받아 그린다(enrich·rename 라우트와 같은 규약). 그래서 성공 응답은 `{ ok:true }`만 싣는다.
 */

/** 연결/해제가 낼 수 있는 관계 종류 — 유의어·반의어만(파생어 제외). RELATION_QUIZ_KINDS(vocab-quiz)와 같은 집합. */
export type VocabLinkKind = "synonym" | "antonym";

/**
 * 연결(POST)·해제(DELETE) 공통 요청 본문. bookId는 URL의 [id]에서 오므로 본문에 없다.
 * 넷 다 `entries` 배열의 0-based 인덱스(단어)·뜻 인덱스다(위 "왜 인덱스인가" 참고).
 */
export interface VocabLinkRequest {
  /** 연결을 거는 쪽 단어의 entries 인덱스 */
  sourceIndex: number;
  /** 그 단어의 meanings 배열 인덱스(어느 뜻에 붙일지) */
  sourceMeaningIndex: number;
  /** 연결 대상 단어의 entries 인덱스 (source와 달라야 한다 — 자기 자신 금지) */
  targetIndex: number;
  /** 대상 단어의 meanings 배열 인덱스 */
  targetMeaningIndex: number;
  kind: VocabLinkKind;
}

/** 오류 코드 (rename·quiz 계약과 같은 3분류 + JSON 파싱). */
export type VocabLinkErrorCode =
  | "invalid_input" // 400 — zod 검증 실패·인덱스 범위 밖·자기 자신 연결·JSON 아님
  | "vocabbook_not_found" // 404 — 없는 id이거나 열 수 없는(비렌더러블) 레코드(경합 삭제 포함)
  | "save_failed"; // 500 — 스토어 저장 실패

/** 200 성공 — 연결/해제됨. 클라이언트는 router.refresh로 표·카드의 관계 칩을 갱신한다. */
export interface VocabLinkSuccess {
  ok: true;
}

export interface VocabLinkFailure {
  ok: false;
  error: VocabLinkErrorCode;
  messageKo: string;
  /** invalid_input일 때만 (zod issue 경로) */
  issues?: { path: string; message: string }[];
}

export type VocabLinkResponse = VocabLinkSuccess | VocabLinkFailure;

// ===========================================================================
// 호출 H 추천 — `POST /api/english/vocab/[id]/suggest-related` (V8 재작업)
// 그 단어의 한 뜻(meaningKo)에 맞는 유의어/반의어 후보를 AI(호출 H)로 받아온다. 사진 없는 텍스트 호출이다.
// ===========================================================================

/** 추천 요청 — 어느 단어의 어느 뜻(한글)에 대한, 어떤 관계의 후보를 원하는가. bookId는 URL의 [id]에서. */
export interface VocabSuggestRelatedRequest {
  /** 표제어(영단어) — 그 단어의 유의어/반의어를 찾는다 */
  word: string;
  /** 그 단어의 한 뜻(한글) — 후보를 이 뜻에 맞춘다(다의어 방어) */
  meaningKo: string;
  kind: VocabLinkKind;
}

/** 추천 후보 하나 — 화면이 그대로 칩으로 그린다(word + 짧은 우리말 뜻). 호출 H가 이미 청소함(표제어·중복·굴절형 제외). */
export interface VocabRelatedCandidate {
  word: string;
  glossKo: string;
}

/** 추천 오류 코드 — 키 없음(501)·AI 실패(500)·입력/대상 방어(400/404). */
export type VocabSuggestRelatedErrorCode =
  | "invalid_input" // 400 — zod 검증 실패·JSON 아님
  | "vocabbook_not_found" // 404 — 없거나 열 수 없는 단어장
  | "no_api_key" // 501 — OPENAI_API_KEY 미설정(추천은 AI 필수라 진행 불가)
  | "suggest_failed"; // 500 — 호출 H throw(재요청 소진) — 재시도 가치 있음

export type VocabSuggestRelatedResponse =
  | { ok: true; candidates: VocabRelatedCandidate[] }
  | { ok: false; error: VocabSuggestRelatedErrorCode; messageKo: string; issues?: { path: string; message: string }[] };

// ===========================================================================
// 추가·연결 — `POST /api/english/vocab/[id]/add-related` (V8 재작업)
// 고른(추천 또는 직접입력) (word·glossKo)를 단어장에 반영한다:
//   - word가 이미 있으면(대소문자 무시) → 그 엔트리로 **연결만**(중복 추가 없음).
//   - 없으면 → appendVocabEntry로 **새 항목 추가**(뜻 하나 ko=glossKo) → enrichVocab **자동 보강**(호출 D,
//     best-effort) → applyVocabLink로 source 뜻 ↔ 새 엔트리 뜻[0] **상호 연결**.
// ===========================================================================

/** 추가·연결 요청 — source(연결 거는 쪽) 위치 + 고른 상대(word·glossKo) + 관계. */
export interface VocabAddRelatedRequest {
  /** 연결을 거는 쪽 단어의 entries 인덱스 */
  sourceIndex: number;
  /** 그 단어의 meanings 배열 인덱스(어느 뜻에 이을지) */
  sourceMeaningIndex: number;
  /** 고른(추천 또는 직접입력) 상대 — 영단어 + 짧은 우리말 뜻 */
  chosen: VocabRelatedCandidate;
  kind: VocabLinkKind;
}

export type VocabAddRelatedErrorCode =
  | "invalid_input" // 400 — zod 실패·source 인덱스 범위 밖·자기 자신·기존 대상에 뜻 없음·JSON 아님
  | "vocabbook_not_found" // 404 — 없거나 열 수 없는 단어장(경합 삭제 포함)
  | "save_failed"; // 500 — 스토어 저장 실패

/**
 * 추가·연결 성공.
 * - `added`   : true=단어장에 없어 **새로 추가**함, false=이미 있어 **연결만** 함.
 * - `linked`  : 상호 연결 반영됨(멱등이라 이미 연결돼 있었어도 true).
 * - `enrichSkipped`: added=true일 때만 의미 — 새 단어 자동 보강(호출 D) 결과.
 *     null=보강 성공, "enrich_failed"=호출 D throw(추가·연결은 유지, 뜻은 나중에),
 *     "no_api_key"=키 없어 보강 생략(추가·연결은 유지). 어느 경우든 단어·연결은 남는다.
 */
export interface VocabAddRelatedSuccess {
  ok: true;
  added: boolean;
  linked: boolean;
  enrichSkipped: "enrich_failed" | "no_api_key" | null;
}

export type VocabAddRelatedResponse =
  | VocabAddRelatedSuccess
  | { ok: false; error: VocabAddRelatedErrorCode; messageKo: string; issues?: { path: string; message: string }[] };

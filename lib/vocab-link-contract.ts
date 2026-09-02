/**
 * lib/vocab-link-contract.ts — `POST/DELETE /api/english/vocab/[id]/link`(유의어/반의어 연결)의 요청·응답 계약
 *
 * **타입만 있는 모듈이다**(vocab-rename-contract·vocab-quiz-contract와 같은 자리). 값 export가 없으므로
 * 라우트(서버)와 연결 UI(클라이언트)가 같은 정의를 보면서도 클라이언트 번들에는 아무것도 새지 않는다.
 * qa-inspector가 라우트 요청·응답 shape ↔ 프론트가 보내는·기대하는 타입을 교차 검증할 단일 정의처다.
 *
 * ── 무엇을 하는 기능인가 ─────────────────────────────────────────────────────
 * 사용자가 **단어장 안의 다른 (단어+뜻)을 골라** 유의어·반의어로 잇는다. 의미별(meaning 단위)이고,
 * 양쪽 뜻에 상호 표시된다(A의 뜻에 B가, B의 뜻에 A가 붙는다). 저장분은 `source:"user"`로 표시되며
 * 관계 문제 시험(`buildRelationQuestions`)이 이것만 대상으로 삼는다. **AI 호출은 전혀 없다** —
 * glossKo는 대상 뜻의 한글(ko)을 그대로 복사한다.
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

/**
 * lib/collected-vocab-contract.ts — "모은 단어" 수집 단어장 + `POST /api/english/vocab/collected/add-word`의 계약
 *
 * ── "모은 단어" 단어장이란 ─────────────────────────────────────────────────
 * 챕터 리더에서 단어를 더블탭해 담을 때(M2), DAY 단어장처럼 사진으로 판독한 것이 아니라 **읽다가
 * 모은 단어**가 쌓이는 자동 생성·누적 단어장이다. 앱 전체에 **딱 하나**만 존재하며, 없으면 첫 담기
 * 순간에 만들어진다(get-or-create). 단어장 정복 뷰·시험·오답노트를 DAY 단어장과 **그대로 재사용**한다.
 *
 * ── 왜 dayLabel을 안정 마커로 쓰나 ──────────────────────────────────────────
 * titleKo는 이름 바꾸기(V8 rename, `updateVocabBookTitle`)로 사용자가 자유롭게 갈 수 있다 — titleKo로
 * 식별하면 이름을 바꾼 순간 get-or-create가 **중복 단어장을 새로 만든다.** 반면 dayLabel은 rename이
 * 건드리지 않으므로(titleKo 한 필드만 갱신) 정체성이 흔들리지 않는다. 그래서 **dayLabel === 이 마커**로
 * 수집 단어장을 식별한다. 처음엔 titleKo도 같은 값이라, dayLabel 칩이 titleKo와 겹쳐 중복 표시되지
 * 않는다(vocab-library-view는 `dayLabel !== titleKo`일 때만 칩을 그린다).
 *
 * 이 상수는 **서버 전용**(store.ts·라우트)만 import한다 — 클라이언트(챕터 리더)는 엔드포인트만 안다.
 */

/** "모은 단어" 수집 단어장을 식별하는 안정 마커(dayLabel). rename에도 불변 → 단일 수집 단어장 보장. */
export const COLLECTED_VOCAB_DAY_LABEL = "모은 단어";

/** 수집 단어장 생성 시 초기 표시 이름(titleKo). dayLabel과 같은 값이라 칩 중복 표시가 없다. */
export const COLLECTED_VOCAB_TITLE_KO = "모은 단어";

/**
 * `POST /api/english/vocab/collected/add-word` 응답 계약.
 * 뜻(meaningKo)은 화면이 이미 호출 G로 확보해 함께 보내므로, 이 라우트는 **AI를 호출하지 않는다**
 * (add-word[id] 라우트의 enrich 재호출과 다르다). get-or-create + append만 한다.
 *
 * - 200 { ok:true,  id, word, added }                  ← added:true 새로 담음 / added:false 이미 있음(중복)
 * - 400 { ok:false, error:"invalid_input", messageKo } ← 단어·뜻 누락·형식 오류
 * - 500 { ok:false, error:"store_failed",  messageKo } ← 저장 계층 오류(방어)
 */
export interface CollectedAddWordSuccess {
  ok: true;
  /** 담긴 "모은 단어" 단어장 id */
  id: string;
  /** 저장/조회에 쓴 정규화(trim)된 단어 */
  word: string;
  /** true=이번에 새로 담음 / false=이미 있어(대소문자 무시) 담지 않음 */
  added: boolean;
}

export type CollectedAddWordErrorCode =
  | "invalid_input" // 400 — 빈 단어·영문 단어 아님·뜻 누락·길이 초과
  | "store_failed"; // 500 — get-or-create/append 실패(저장 계층 방어)

export interface CollectedAddWordFailure {
  ok: false;
  error: CollectedAddWordErrorCode;
  messageKo: string;
}

export type CollectedAddWordResponse = CollectedAddWordSuccess | CollectedAddWordFailure;

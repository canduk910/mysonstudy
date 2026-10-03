/**
 * lib/toeic-island-contract.ts — 🏝️ 나만의 답변 섬 라우트의 요청·응답 계약 + 화면 이동 도우미 (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * - `POST   /api/toeic/island`        담기(멱등 — 문서 id = 원본 키). 틀 말하기·모의고사 원본은 **서버가 저장된 원본에서** 글자를 만든다.
 * - `PATCH  /api/toeic/island/[id]`   편집(섬 문장·한국어 메모·소재·유형)
 * - `DELETE /api/toeic/island/[id]`   삭제(prod-guard `deleteToeicIslandEntry`)
 * AI 호출 없음 — 키 검사도 없다(키가 없어도 담기·편집·삭제는 된다).
 *
 * ── 클라이언트 번들 경계 ── 값 import는 클라이언트 안전한 순수 모듈 `./toeic-island`뿐. lib/ai·lib/store 금지.
 */

import type { ToeicIslandEntry, ToeicIslandOrigin, ToeicIslandPart } from "./toeic-island";

export type { ToeicIslandEntry, ToeicIslandOrigin, ToeicIslandPart };

type Issue = { path: string; message: string };

/**
 * 담기 요청.
 * - 틀 말하기·모의고사: `origin`만 있으면 된다. `topicKey`가 없으면(undefined) 원본이 알려 주는 추천 소재, null이면 "소재 없음".
 *   `ko`는 한국어 메모(모의고사 원본은 한국어 단서가 없어 여기서 단다 — 틀 말하기는 없으면 한글 문장).
 * - 직접 쓰기: `origin.kind = "manual"` + `part`·`en` 필수, `ko`·`topicKey` 선택.
 */
export interface ToeicIslandCreateRequest {
  origin: ToeicIslandOrigin;
  topicKey?: string | null;
  ko?: string | null;
  part?: ToeicIslandPart;
  en?: string;
}

export type ToeicIslandCreateResponse =
  /** 200 — reused:true면 같은 원본이 이미 담겨 있어 쓰지 않았다(그 항목을 돌려준다) */
  | { ok: true; entry: ToeicIslandEntry; reused: boolean }
  /** 400 invalid_input · too_long(섬 문장 상한) · 404 source_not_found(원본 없음·그 문항에 글자 없음) · 422 unsupported_part(Q5–7·Q11 밖) · 409 full(상한) · 500 save_failed */
  | { ok: false; error: "invalid_input" | "too_long" | "source_not_found" | "unsupported_part" | "full" | "save_failed"; messageKo: string; issues?: Issue[] };

export interface ToeicIslandPatchRequest {
  en?: string;
  ko?: string | null;
  topicKey?: string | null;
  part?: ToeicIslandPart;
}

export type ToeicIslandPatchResponse =
  | { ok: true; entry: ToeicIslandEntry }
  /** 400 invalid_input·too_long · 404 not_found · 500 save_failed */
  | { ok: false; error: "invalid_input" | "too_long" | "not_found" | "save_failed"; messageKo: string; issues?: Issue[] };

export type ToeicIslandDeleteResponse =
  | { ok: true }
  /** 404 not_found · 403 prod_guard · 400 invalid_input · 500 delete_failed */
  | { ok: false; error: "invalid_input" | "not_found" | "prod_guard" | "delete_failed"; messageKo: string };

/** 섬 화면 주소 — part를 주면 그 유형 탭으로 연다 */
export function toeicIslandHref(part?: ToeicIslandPart | null): string {
  return part ? `/toeic/island?part=${part}` : "/toeic/island";
}

/** 결과 화면이 넘기는 소재 칩 자료(이 유형 소재 — 틀 말하기 은행 순서) */
export interface ToeicIslandTopicChip {
  key: string;
  nameKo: string;
}

/**
 * 모의고사 결과 화면에 넘기는 🏝️ 자료(서버가 만든다 — §21-3 ②). Q5–7·Q11 문항에 채점 결과가 있을 때만 버튼이 보인다.
 * - topicsByPart: 그 유형 소재 칩(틀 말하기 은행 순서 — 은행이 없으면 빈 배열 → "소재 없음"만)
 * - savedIds: 이 응시에서 이미 담긴 문서 id
 * - suggest: 문서 id → 추천 소재 key(문장에 쓰인 틀의 소재, 없으면 null)
 */
export interface ToeicAttemptIslandData {
  topicsByPart: Partial<Record<ToeicIslandPart, ToeicIslandTopicChip[]>>;
  savedIds: string[];
  suggest: Record<string, string | null>;
}

/**
 * lib/reorder-contract.ts — 목록 수동 정렬(재배치) 라우트의 **범용** 요청/응답 계약
 *
 * **타입 + zod 스키마(+ 그 스키마의 id 판정 isFirestoreDocId)만 있는 모듈이다.** 값 export(zod)는 라우트에서만 쓰이고
 * (isFirestoreDocId는 Firestore 재색인 `reorderBySortIndex`도 같은 판정으로 쓴다), 타입은 라우트(서버)와
 * 클라이언트 재정렬 훅이 같은 정의를 본다. qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을
 * 교차 검증할 단일 정의처다.
 *
 * ── 왜 과목 중립(범용)인가 ──────────────────────────────────────────────────
 * 서재(book)뿐 아니라 **단어장·수학 목록도 그대로 재사용**한다 — 재배치는 어느 목록이든 "id의 새
 * 순서를 통째로 넘긴다"는 한 가지 모양이라, 요청 본문을 `{ orderedIds: string[] }`로 통일한다.
 * 각 목록은 자기 라우트(`/api/library/reorder`, 향후 `/api/english/vocab/reorder` 등)에서 이 계약을
 * 재사용하고, 스토어의 재색인 메서드(reorderBooks 등)만 갈아끼운다.
 *
 * ── 왜 갱신된 목록을 응답에 싣지 않나 ───────────────────────────────────────
 * 목록 페이지는 서버 컴포넌트(force-dynamic)라 성공 뒤 `router.refresh()`로 최신 순서를 다시 받아
 * 그린다(rename·delete 라우트와 같은 규약). 응답은 성공/실패 신호만 싣는다 — 클라이언트는 이미
 * 낙관적으로 재배치해 뒀다.
 */

import { z } from "zod";

/** 한 번에 재배치할 수 있는 id 상한 — 가족용 소규모 목록(수십 개)이라 넉넉한 방어선 */
export const REORDER_MAX_IDS = 1000;

/** Firestore 문서 id의 UTF-8 바이트 상한(Firestore "Usage and limits" — Document ID 1,500 bytes) */
export const DOC_ID_MAX_BYTES = 1500;

/**
 * Firestore 문서 id 규칙을 지키는 id인가 — **두 저장 백엔드가 같은 뜻으로 읽는 id**의 단일 정의처.
 *
 * 왜: 파일 백엔드는 id를 문자열 그대로 비교하지만, Firestore는 `col.doc(id)`가 id를 **경로**로 해석한다.
 * `"a/"`·`"/a"`는 빈 세그먼트가 버려져 문서 `a`가 되고(SDK `ResourcePath.split`), `"a/b"`는 컬렉션 경로라 던진다.
 * `"."`·`".."`·`__…__`는 Firestore가 예약한 id다. 이런 id가 섞이면 같은 요청에 두 백엔드 결과가 갈린다
 * (`["b","a/"]` → 파일은 a를 안 건드리고 Firestore는 a=1). 그래서 계약에서 400으로 막고, Firestore 재색인도 같은 판정으로 건너뛴다.
 *
 * 규칙(Firestore 문서 id 제약 그대로): 비어 있지 않다 · `/` 없음 · `.`·`..`만으로 된 id 아님 · `__.*__` 모양 아님 ·
 * 올바른 UTF-8(짝 없는 서로게이트 없음) · UTF-8 1,500바이트 이하.
 * 실제로 저장되는 id(파일 백엔드 `randomUUID()` 36자, Firestore 자동 id 20자 영숫자)는 전부 통과한다.
 */
export function isFirestoreDocId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.includes("/") || id === "." || id === "..") return false;
  if (/^__[\s\S]*__$/.test(id)) return false;
  let bytes = 0;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = id.charCodeAt(i + 1); // 범위 밖이면 NaN → 짝 없음
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false; // 짝 없는 상위 서로게이트 = UTF-8로 못 옮긴다
      bytes += 4;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false; // 짝 없는 하위 서로게이트
    else bytes += 3;
    if (bytes > DOC_ID_MAX_BYTES) return false;
  }
  return true;
}

/**
 * 요청 본문 스키마 — `{ orderedIds: string[] }`. 최종 순서대로의 id 배열이다.
 * - 빈 배열은 막는다(재배치할 것이 없다 = 무의미한 호출).
 * - 중복 id는 막는다(재색인이 꼬인다).
 * - Firestore 문서 id 규칙을 어기는 id는 막는다(isFirestoreDocId — 두 백엔드가 같은 입력만 받게).
 * 존재하지 않는 id는 스토어가 조용히 건너뛴다(목록에 없는 항목 불간섭) — 여기서 막지 않는다.
 */
export const reorderRequestSchema = z.object({
  orderedIds: z
    .array(z.string().min(1).refine(isFirestoreDocId, "올바르지 않은 항목이 섞여 있어요."))
    .min(1, "재배치할 항목이 없어요.")
    .max(REORDER_MAX_IDS, `한 번에 정렬할 수 있는 항목은 ${REORDER_MAX_IDS}개까지예요.`)
    .refine((ids) => new Set(ids).size === ids.length, "중복된 항목이 있어요."),
});

export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

/** 200 성공 — 새 순서를 저장했다. 클라이언트는 router.refresh로 목록을 다시 받아 확정한다 */
export interface ReorderSuccess {
  ok: true;
  /** 저장한 항목 수(= orderedIds.length) — 로깅·확인용 */
  count: number;
}

export type ReorderErrorCode =
  | "invalid_input" // 400 — zod 검증 실패(JSON 아님·빈 배열·중복·상한 초과·Firestore 문서 id 규칙 위반)
  | "save_failed"; // 500 — 스토어 저장 실패

export interface ReorderFailure {
  ok: false;
  error: ReorderErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
}

export type ReorderResponse = ReorderSuccess | ReorderFailure;

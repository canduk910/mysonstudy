/**
 * lib/reorder-contract.ts — 목록 수동 정렬(재배치) 라우트의 **범용** 요청/응답 계약
 *
 * **타입 + zod 스키마만 있는 모듈이다.** 값 export(zod)는 라우트에서만 쓰이고, 타입은 라우트(서버)와
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

/**
 * 요청 본문 스키마 — `{ orderedIds: string[] }`. 최종 순서대로의 id 배열이다.
 * - 빈 배열은 막는다(재배치할 것이 없다 = 무의미한 호출).
 * - 중복 id는 막는다(재색인이 꼬인다).
 * 존재하지 않는 id는 스토어가 조용히 건너뛴다(목록에 없는 항목 불간섭) — 여기서 막지 않는다.
 */
export const reorderRequestSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
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
  | "invalid_input" // 400 — zod 검증 실패(JSON 아님·빈 배열·중복·상한 초과)
  | "save_failed"; // 500 — 스토어 저장 실패

export interface ReorderFailure {
  ok: false;
  error: ReorderErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
}

export type ReorderResponse = ReorderSuccess | ReorderFailure;

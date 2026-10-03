/**
 * lib/review-contract.ts — 오늘의 복습(SPEC §23) 라우트 ↔ 화면 계약(타입 전용 — 런타임 import 0).
 *
 * - `GET /api/review/{area}` → 200 `ReviewQueueResponse` / 400 `invalid_input`(모르는 영역)
 * - `POST /api/review/record` (본문 `ReviewRecordRequest`) → 200 `ReviewRecordResponse` / 400 `invalid_input` / 500 `save_failed`
 * AI 호출 없음 — 키 검사도 없다(키가 없어도 복습은 된다).
 */

import type { ReviewArea, ReviewHintLevel, ReviewJudge, ReviewKind } from "./review-schedule";
import type { ReviewCard, ReviewRubyToken } from "./review-sources";

export type { ReviewArea, ReviewCard, ReviewHintLevel, ReviewJudge, ReviewKind, ReviewRubyToken };

export interface ReviewQueueResponse {
  ok: true;
  area: ReviewArea;
  /** 서버가 계산한 KST 오늘 */
  today: string;
  /** 하루 상한 */
  cap: number;
  /** 오늘 이미 끝낸 수 */
  doneToday: number;
  /** 상한 전 오늘 할 것의 총수 */
  dueCount: number;
  /** 오늘 할 카드(상한 적용, 순서대로) */
  cards: ReviewCard[];
  /** 읽지 못한 출처 수(그 출처만 빠지고 나머지는 나온다) */
  failedSources: number;
}

export interface ReviewRecordRequest {
  area: ReviewArea;
  itemKey: string;
  hintLevel: ReviewHintLevel;
  judge: ReviewJudge;
}

export interface ReviewRecordResponse {
  ok: true;
  /** applied = 적용함 · already_today = 오늘 이미 이 항목을 복습해서 아무것도 바꾸지 않음(성공으로 본다) */
  outcome: "applied" | "already_today";
  /** 적용된 판정(정답을 봤으면 forgot) */
  judge: ReviewJudge;
  step: number;
  /** 다음 복습 KST 일자 */
  dueOn: string;
  /** 다음 복습까지 날 수 */
  intervalDays: number;
}

export interface ReviewErrorResponse {
  ok: false;
  error: "invalid_input" | "save_failed" | "load_failed";
  messageKo: string;
  issues?: { path: string; message: string }[];
}

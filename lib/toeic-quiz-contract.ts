/**
 * lib/toeic-quiz-contract.ts — 아빠의 영어 **표현 시험** 세션 저장 계약 (docs/harness/toeic.md §6-1·§6-2·§7-3)
 *
 * `POST /api/toeic/sets/[id]/quiz` — **한 요청 = 한 모드**(혼합 세션은 화면이 splitToeicItemsByMode로 갈라 모드마다 보낸다,
 * §6-2 무오염). 라우트 zod와 이 요청 타입은 라우트 파일에서 양방향으로 묶는다(한쪽 필드명만 바꾸면 tsc가 잡는다).
 * 타입·라벨은 클라이언트 안전 순수 모듈 lib/toeic-quiz.ts에서 재수출한다(런타임 의존: 은우 순수 함수뿐).
 */

import type { ToeicChoiceQuestion, ToeicChoiceQuizMode, ToeicQuizMode, ToeicSpeakQuestion } from "./toeic-quiz";

export type { ToeicChoiceQuestion, ToeicChoiceQuizMode, ToeicQuizMode, ToeicSpeakQuestion };

export interface ToeicQuizSubmitRequest {
  mode: ToeicQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];
}

export type ToeicQuizSubmitResponse =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "invalid_input" | "set_not_found" | "save_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

/** 항목 키 표시 — QUIZ 키(`quiz:{no}`·`quiz:{promptKo}`)는 "교재 QUIZ n"으로, 나머지(표현)는 그대로 */
export function toeicItemKeyLabel(key: string): string {
  if (!key.startsWith("quiz:")) return key;
  const rest = key.slice(5);
  return /^\d+$/.test(rest) ? `교재 QUIZ ${rest}` : `교재 QUIZ · ${rest}`;
}

/**
 * lib/review-quiz.ts — 은우 오늘의 복습 **문제 맞히기**(5지선다) 채점 규칙 (docs/SPEC.md §23-11, 2026-10-25). 순수·클라이언트 안전.
 *
 * 은우 영역(`english`)의 오늘의 복습은 힌트 사다리 + 스스로 판정이 아니라 **단어장 시험과 같은 5지선다**다
 * (사용자 요청 "은우에 한해서 복습 스타일을 문제 맞추기로" — 1학년이 스스로 "맞혔어/몰랐어"를 정직하게 고르기 어렵다).
 * 앱이 채점한다 — **첫 선택**이 정답이면 `{hintLevel: 0, judge: "got"}`(힌트 없이 맞힘 — 간격 +1, 연속이면 +2),
 * 오답이면 `{hintLevel: 3, judge: "forgot"}`(정답을 봄 — 내일 다시). 간격 규칙은 lib/review-schedule 그대로다.
 * "헷갈렸어요" 단계는 두지 않는다 — 고르기에는 "망설였다"는 신호가 없고, 찍어 맞힌 것은 다음 복습(3일 뒤)이 다시 확인한다.
 *
 * 보기 만들기(서버 — 저장된 단어장을 읽어야 해서)는 lib/review-sources `buildEnglishReviewQuiz`, 화면은 components/review-quiz-runner.
 * 일본어·토익·엄마 복습은 이 파일을 쓰지 않는다(힌트 사다리 그대로).
 *
 * ⚠️ 런타임 import 0(타입만) — 러너가 값으로 import한다.
 */

import type { ReviewOutcome } from "./review-schedule";
import type { ReviewCard } from "./review-sources";

/** 문항 하나 — 서버가 만든 카드 + 보기(정답 포함, 서로 다름, 순서 고정) */
export interface ReviewQuizQuestion {
  card: ReviewCard;
  /** 정답(card.answer.main) 포함 · 대소문자·공백 무시로 서로 다름 · 2~5개 · 서버가 섞어 고정(hydration 안전) */
  choices: string[];
  /**
   * 문제 글 — 영영 정의를 은우 문제용으로 다시 가린 것(고정 길이 밑줄·파생형·구 굴절형·하이픈/공백 변형까지 — lib/review-sources
   * `maskAnswerForKidQuiz`). 정의가 없으면 null(그림만). card.cue.main(공용 가리기)은 쓰지 않는다.
   */
  cue: string | null;
}

/** 보기 수 — 단어장 시험과 같은 5지선다(lib/vocab-quiz DEFAULT_CHOICE_COUNT와 같은 값 — eval이 대조) */
export const REVIEW_QUIZ_CHOICE_COUNT = 5;
/** 이보다 보기가 적으면 문제가 서지 않는다(정답 하나뿐) — 그 카드는 오늘 큐에서 빠지고 화면이 사유를 말한다 */
export const REVIEW_QUIZ_MIN_CHOICES = 2;

/** 정답 판정의 단일 정의처 — 첫 선택만 본다. 보기는 서버가 정답 글자 그대로 실어 보내므로 글자 그대로 비교한다 */
export function isReviewQuizCorrect(choice: string, answer: string): boolean {
  return choice === answer;
}

/** 첫 선택 → 기록할 결과(맞힘 = 힌트 없이 got · 틀림 = 정답 봄 forgot). `/api/review/record`에 그대로 싣는다 */
export function reviewQuizOutcome(choice: string, answer: string): ReviewOutcome {
  return isReviewQuizCorrect(choice, answer) ? { hintLevel: 0, judge: "got" } : { hintLevel: 3, judge: "forgot" };
}

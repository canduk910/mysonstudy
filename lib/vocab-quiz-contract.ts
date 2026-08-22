/**
 * lib/vocab-quiz-contract.ts — 시험 저장 라우트의 요청·응답 계약 (V4, 계획 §V4)
 *
 * **타입 전용 모듈이다**(값 export 0). 라우트(`POST /api/english/vocab/[id]/quiz`)와 시험
 * 화면(`components/vocab-quiz-view.tsx`)이 같은 shape을 보게 하는 단일 정의처다 — 이 파일이
 * 갈리면 프론트가 보낸 것과 서버가 기대하는 것이 어긋난다(vocab-enrich-contract와 같은 자리).
 *
 * 화면은 HTTP status가 아니라 JSON `ok`로 분기한다(extract retake·enrich와 같은 관용구).
 * 모든 실패 variant에 `messageKo`가 있어, 화면은 상태코드를 몰라도 사람이 읽을 안내를 그린다.
 */

import type { VocabQuizItem } from "./store";
import type { VocabQuizMode } from "./vocab-quiz";

/**
 * 시험 종료(완료·중단) 시 화면이 보내는 세션 결과 — bookId는 URL의 [id]에서 오므로 본문에 없다.
 * `finishedAt`: 끝까지 풀면 ISO, "그만하기"(부분 결과)면 null. items는 셔플된 문제 순서 그대로.
 */
export interface VocabQuizSubmitRequest {
  mode: VocabQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: VocabQuizItem[];
}

/**
 * 저장 응답. 진행 중 상태는 전부 클라이언트에 있고, 서버는 저장 확인만 돌려준다(id).
 * - 200 { ok:true, id }                         — 저장 완료
 * - 404 vocabbook_not_found                      — 없거나 열 수 없는 단어장(경합 삭제 포함)
 * - 400 invalid_input                            — zod 검증 실패(모드·시각·items shape)
 * - 500 save_failed                              — 저장 실패(재시도 가능)
 */
export type VocabQuizSubmitResponse =
  | { ok: true; id: string }
  | { ok: false; error: "vocabbook_not_found"; messageKo: string }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: { path: string; message: string }[] }
  | { ok: false; error: "save_failed"; messageKo: string };

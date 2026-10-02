/**
 * lib/ai/toeic/model.ts — 토익 출제·채점 모델 해석 (docs/harness/toeic.md §1, SPEC §11)
 *
 * 사용자 결정(2026-10-02): 텍스트 AI 모델 중 **토익스피킹 출제·채점만 gpt-6.1-sol**, 나머지는 메인(`OPENAI_MODEL`, 기본 gpt-6-luna).
 * - 출제 = 호출 C(모의고사 C1~C5 — 실전 모의고사·파트 다시 만들기·한 문제 연습이 모두 `generateMockPart`를 지난다)
 * - 채점 = 호출 D(답변 피드백 `generateFeedback`)
 * - 호출 A(표현집 판독)·B(발화 포인트)는 출제·채점이 아니라 메인 `resolveModel()`이다.
 *
 * env `OPENAI_TOEIC_MODEL`(앞뒤 공백 무시). 빈 값·공백이면 기본값(`||` — SPEC §11 빈 값 폴백 관용구).
 * `OPENAI_MODEL`로 폴백하지 **않는다** — 메인을 바꿔도 출제·채점 모델이 따라 움직이지 않게 따로 둔다(호출 J `OPENAI_TALK_CARDS_MODEL`과 같은 모양).
 *
 * 의존성 없는 순수 모듈이다 — openai SDK·client.ts를 끌어오지 않아 eval 오프라인 구간이 정적으로 import할 수 있다.
 * (진입 함수 calls.ts와 레코드 `model`을 남기는 라우트가 이 함수를 부른다.)
 */

/** 토익 호출 C·D 기본 모델. 설치된 SDK의 `ChatModel` 목록에 아직 없어 string이다. */
export const DEFAULT_TOEIC_MODEL: string = "gpt-6.1-sol";

/** 토익 호출 C·D 모델 — env `OPENAI_TOEIC_MODEL`, 비면 DEFAULT_TOEIC_MODEL */
export function resolveToeicModel(): string {
  return process.env.OPENAI_TOEIC_MODEL?.trim() || DEFAULT_TOEIC_MODEL;
}

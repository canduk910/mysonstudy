/**
 * lib/math-extract-contract.ts — `POST /api/math/extract`의 요청·응답 타입 (M3, 호출 A)
 *
 * **타입만 있는 모듈이다.** 값 export가 하나도 없으므로 라우트(서버)와 확인 화면(클라이언트)이
 * 같은 정의를 보면서도 클라이언트 번들에는 아무것도 들어가지 않는다.
 * `lib/math-explain-contract.ts`가 호출 B에 대해 서는 자리와 같은 자리다 —
 * 라우트가 내려주는 shape과 화면이 기대하는 shape이 서로 다른 파일에 따로 적히면 반드시 어긋난다.
 *
 * 참조: `docs/harness/math.md` §2(호출 A) · §2-4(후처리) · §8(비용 안전장치)
 */

import type {
  ExtractedProblem,
  GradedMark,
  WorksheetExtraction,
} from "./ai/math/schemas";

/**
 * 판독 결과 타입은 `lib/ai/math/schemas.ts`가 단일 정의처다(zod에서 추론된 것).
 * 여기서 **다시 선언하지 않고 통로만 낸다** — 화면이 `lib/ai/*`를 직접 가리키지 않게 하되
 * 정의가 두 벌이 되는 것은 막는다. (`import type`이라 번들에는 남지 않는다.)
 */
export type { ExtractedProblem, GradedMark, WorksheetExtraction };

/**
 * 요청 본문 — 사진 **1장**(base64 data URL)만 받는다 (§2-2).
 *
 * 배열이 아닌 이유: 호출 A는 "페이지 하나를 판독한다"는 호출이고, 여러 장을 한 번에 넘기면
 * 문제 번호가 페이지 경계 없이 뒤섞여 확인 화면이 원본과 대조할 수 없게 된다.
 * 두 페이지를 찍고 싶으면 한 장씩 두 번 돌린다.
 *
 * 사진은 이 요청의 메모리에서만 쓰고 **어디에도 저장하지 않는다**(영어 `/api/extract`와 같은 규약).
 * 버킷·서명 URL·새 환경 변수는 필요 없다 — §11-2가 그 전제를 걷어냈다.
 */
export interface MathExtractRequest {
  /** `data:image/jpeg;base64,…` 형식. 클라이언트가 긴 변 `MAX_IMAGE_EDGE`로 리사이즈해 보낸다 */
  image: string;
}

/** 200 성공 — 문제를 하나 이상 읽었다 */
export interface MathExtractSuccess {
  ok: true;
  extraction: WorksheetExtraction;
}

/**
 * 200 폴백 — **오류가 아니다.** `isWorksheet=false`이거나 `problems`가 비었을 때 (§2-4).
 *
 * 모델이 지시대로 "이건 문제집이 아니다"라고 답한 것이므로 상태 코드로 실패를 표현하지 않는다.
 * 화면은 이 신호를 받아 "다시 찍어주세요" + 직접 입력 폴백을 띄운다.
 * `extraction`을 함께 내려주는 것은 `source`(교재명)처럼 부분적으로 읽힌 값이 있을 수 있어서다.
 */
export interface MathExtractRetake {
  ok: false;
  reason: "retake";
  messageKo: string;
  extraction: WorksheetExtraction;
}

/** 오류 코드. `locked`·`not_configured`는 proxy.ts(PIN 게이트)가 내려보낸다 */
export type MathExtractErrorCode =
  | "invalid_input" // 400 — zod 검증 실패(형식·길이)
  | "no_api_key" // 501 — OPENAI_API_KEY 미설정
  | "ai_failed" // 500 — 재요청까지 쓰고 실패(throw). 화면은 '다시 읽기' 버튼을 띄운다
  | "locked" // 401 — PIN 잠금 (proxy.ts)
  | "not_configured"; // 503 — 프로덕션인데 APP_PIN 없음 (proxy.ts)

export interface MathExtractFailure {
  ok: false;
  error: MathExtractErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
  /** true면 같은 사진으로 다시 눌러 볼 만하다 */
  retriable?: boolean;
}

/**
 * 화면이 세 갈래를 구분하는 법:
 *   `data.ok === true`            → 문제 목록
 *   `"reason" in data`            → 다시 찍기 + 직접 입력 폴백 (정상 흐름)
 *   그 밖(`"error" in data`)      → 오류 배너
 */
export type MathExtractResponse =
  | MathExtractSuccess
  | MathExtractRetake
  | MathExtractFailure;

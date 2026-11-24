/**
 * lib/ai/math/extract.ts — 호출 A(문제집 사진 판독) 실행 (docs/harness/math.md §2)
 *
 * 조각은 이미 다 있고 여기서 배선만 한다:
 *   - 프롬프트   : `lib/ai/math/prompts.ts` (§2-1 원문 · §2-2 사용자 텍스트 · §1 파라미터)
 *   - 출력 스키마 : `lib/ai/math/schemas.ts` (`worksheet_extraction` JSON Schema + zod)
 *   - 래퍼       : `lib/ai/client.ts` (`callWithSchema` — Structured Outputs → zod → 1회 재요청 → 로깅)
 *
 * 영어 표지 판독(`extractBook`)과 같은 규약이다: 라우트는 프롬프트·스키마를 재구현하지 않고
 * 이 함수만 부른다. 파일을 `lib/ai/math/`에 두는 이유는 `lib/ai/client.ts`가 과목을 몰라야 하기
 * 때문이다 — 공유 래퍼에 수학 편의 함수를 더하면 그 파일이 곧 과목을 아는 물건이 된다
 * (docs/HARNESS.md §2 "과목별 분기를 이 파일에 넣지 않는다").
 *
 * **서버 전용 모듈이다.** 클라이언트 번들에서 import 금지 (`../client`가 API 키를 건드린다).
 *
 * ## §2-4 후처리는 여기서 하지 않는다 — 라우트·확인 화면의 몫이다
 * §2-4의 세 항목은 전부 **확인 화면의 동작**이라 이 함수의 반환 타입으로 표현할 수 없다:
 * 1. `isWorksheet=false` 또는 `problems`가 빈 배열 → "다시 찍어주세요" + 직접 입력 폴백.
 *    **판독 실패는 예외가 아니라 정상 흐름**이므로 이 함수는 그대로 돌려준다(아래 주석 참고).
 * 2. 판독 결과는 확인 화면에서 사용자가 수정 가능 — 수정본이 호출 B의 입력이 된다.
 * 3. `gradedMark !== 'none'`인 문제를 먼저·기본 선택으로 올린다 →
 *    `isMarkedProblem()`(schemas.ts)이 단일 판정처다. 여기서 `problems`를 정렬하면
 *    **사진에 찍힌 문제 순서가 사라져** 확인 화면이 원본과 대조할 수 없게 된다.
 */

import { callWithSchema, imagePart, textPart } from "../client";
import {
  WORKSHEET_EXTRACT_CALL_OPTIONS,
  WORKSHEET_EXTRACT_SYSTEM_PROMPT,
  WORKSHEET_EXTRACT_USER_TEXT,
  assertImageDataUrl,
} from "./prompts";
import {
  WORKSHEET_EXTRACTION_JSON_SCHEMA,
  worksheetExtractionSchema,
  type WorksheetExtraction,
} from "./schemas";

/**
 * 호출 A — 문제집 페이지 사진 1장 → 문제 목록(+아이 필기·채점 표시).
 * (§1 표: temperature 0 · 출력 한도 ~2,500 · §2-2 이미지 1장 + 텍스트 한 줄)
 *
 * 사용자 메시지는 영어 표지 판독과 같은 순서로 싣는다 — **이미지 파트 먼저, 지시 텍스트 나중**
 * (`lib/ai/client.ts`의 `extractBook`). `imagePart()`가 `detail: "high"`를 붙이는데, 여기서도
 * 그 값이 그대로 필요하다: 판독 대상이 인쇄된 문제 문장과 **연필 필기·빨간 채점 표시**라
 * 표지 스티커의 작은 글씨와 같은 급의 해상도를 요구한다.
 *
 * **판독 실패를 던지지 않는다.** `isWorksheet: false`나 빈 `problems`는 모델이 지시대로
 * 동작한 결과이지 검증 실패가 아니다(§2-1 6번). 예외로 바꾸면 "사진이 문제집이 아님"과
 * "AI 호출이 죽음"이 라우트에서 구분되지 않아, 사용자는 폴백 화면(§2-4) 대신 에러를 만난다.
 * 영어 `/api/extract`가 `isBookCover=false`를 200 + `reason: "retake"`로 내리는 것과 같은 갈래다.
 *
 * @throws 사진이 data URL 형식이 아니거나, `callWithSchema`가 재요청까지 2회 검증에 실패한 경우.
 *         (라우트는 전자를 400으로 막고 — 영어 라우트의 body zod와 같다 — 후자만 500으로 낸다)
 */
export async function callWorksheetExtract(imageDataUrl: string): Promise<WorksheetExtraction> {
  // vision 호출이라 이미지 토큰이 붙는다. 형식이 틀린 입력으로 호출을 태우지 않고 여기서 막는다.
  // [M6] 판정처는 `prompts.ts`로 옮겼다 — 같은 사진이 이제 호출 B·C에도 가므로(§12-2)
  // 형식 검사가 호출마다 따로 살면 "A는 통과, B는 400"처럼 갈라진다.
  assertImageDataUrl(imageDataUrl, WORKSHEET_EXTRACT_CALL_OPTIONS.call);

  return callWithSchema<WorksheetExtraction>({
    call: WORKSHEET_EXTRACT_CALL_OPTIONS.call,
    system: WORKSHEET_EXTRACT_SYSTEM_PROMPT,
    user: [imagePart(imageDataUrl), textPart(WORKSHEET_EXTRACT_USER_TEXT)],
    jsonSchema: WORKSHEET_EXTRACTION_JSON_SCHEMA,
    // zod 이중 검증은 `callWithSchema`가 한다. 그 위에 덧댈 것이 없다 —
    // `truncated`·`gradedMark`는 스키마(boolean·enum)로 완결되고, `problems` 최소 개수는
    // 걸면 안 된다(schemas.ts 주석: 빈 배열은 §2-4의 정상 폴백 경로다).
    zodSchema: worksheetExtractionSchema,
    temperature: WORKSHEET_EXTRACT_CALL_OPTIONS.temperature,
    maxOutputTokens: WORKSHEET_EXTRACT_CALL_OPTIONS.maxOutputTokens,
  });
}

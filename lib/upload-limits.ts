/**
 * lib/upload-limits.ts — 사진 업로드 상한의 단일 정의처 (클라이언트·서버 공용)
 *
 * 왜 별도 파일인가: 상한이 라우트 zod와 UI 양쪽에 필요한데, 두 곳에 숫자를 적으면
 * 반드시 어긋난다. 실제로 "표지 최대 2장"을 라우트만 3장으로 고치고 UI의
 * `slice(0, 2)`를 남겨 두면 뒤표지 사진이 잘려 blurbText 판독이 조용히 죽는다(QA F10).
 *
 * 본문 사진 상한(PAGES_MAX_IMAGES)·배치 크기(PAGES_BATCH_SIZE)는 여기 옮기지 않는다 —
 * `lib/ai/client.ts`가 단일 정의처이고, 그 모듈은 `openai`와 API 키를 건드려
 * 클라이언트 번들에 들어가면 안 된다. 서버 컴포넌트가 읽어 props로 내려보낸다.
 *
 * 이 파일은 순수 상수만 둔다(런타임 의존성 없음) — 어느 쪽에서 import해도 안전하다.
 */

/**
 * 표지 흐름의 사진 상한 (SPEC §4-1 · HARNESS §2-2).
 * 표지 / 정보 스티커 / 뒤표지 — 세 면이 서로 대체 불가한 정보를 담는다:
 * 제목·저자 / AR·Lexile·단어 수 / 소개글(blurbText).
 */
export const COVER_MAX_IMAGES = 3;

/** 업로드 전 리사이즈 — 긴 변 픽셀 상한 (토큰 절약, ai-harness-impl 스킬 권장) */
export const MAX_IMAGE_EDGE = 1500;

/** 리사이즈 JPEG 품질 */
export const JPEG_QUALITY = 0.85;

/**
 * base64 data URL 문자열 하나의 길이 상한 — 라우트 zod의 안전장치.
 *
 * `MAX_IMAGE_EDGE`로 리사이즈한 JPEG는 보통 0.3~0.8MB(≈0.4~1.1M자)라 한참 아래다.
 * 이 상한이 막는 것은 **리사이즈를 건너뛴 요청**이다 — 최신 폰 원본은 한 장에 5~10MB라
 * 그대로 오면 요청 본문 파싱과 프롬프트 조립에서 메모리를 밀어붙이고, vision 토큰도 함께 뛴다.
 *
 * 영어 표지 판독(`/api/extract`)과 수학 문제집 판독(`/api/math/extract`)이 **같은 숫자**를 쓴다.
 * 두 라우트에 따로 적어 두면 한쪽만 고쳐 놓고 다른 쪽에서 "왜 여긴 거절되지?"를 만난다.
 */
export const MAX_IMAGE_DATA_URL_CHARS = 8_000_000;

/**
 * base64 data URL **형식** 검사 — 길이 상한과 짝을 이루는 나머지 한 축.
 *
 * 왜 여기 있나(QA P3-1): M6에서 이 정규식은 `lib/ai/math/prompts.ts`에 살았는데, 그 모듈은
 * 같은 커밋에서 `openai` SDK를 새로 import했다. 클라이언트가 업로드 전에 형식을 미리 보려는
 * 순간 프롬프트 모듈이 딸려 오고 SDK가 번들에 실린다. 사진 검사 두 축(형식·길이)은
 * 성격이 같으므로 **런타임 의존성이 없는 이 파일**에 함께 둔다.
 *
 * 원격 URL(`https://…`)을 막는 것이 요점이다 — vision 호출은 원격 이미지도 받아들이지만,
 * 그러면 우리가 크기·형식을 통제하지 못하는 바이트가 모델에 들어간다.
 */
export const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

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

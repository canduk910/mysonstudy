/**
 * lib/toeic-image.ts — 관문 P: 모의고사 Q3–4 사진 생성 (**서버 전용**) (docs/harness/toeic.md §1-1·§4-10·§7-4)
 *
 * **하네스 밖 관문**이다 — Structured Outputs가 아니라 이미지 바이트를 받는 호출이라 `callWithSchema`·zod·재요청을 거치지
 * 않는다(lib/tts.ts와 같은 부류, docs/HARNESS.md §0). 그래서 lib/ai/client.ts(스키마 관문)와 섞지 않고 **독립 OpenAI 클라이언트**를
 * 따로 쥔다 — 키 규약(없으면 호출하지 않는다)만 같은 모양이다. lib/ai/client.ts에 과목 분기를 두지 않는다.
 *
 * - 프롬프트 = C2 `imagePrompt` + 고정 접미사(`buildSceneImagePrompt` — lib/ai/toeic/prompts.ts, 조립 규칙은 그쪽 단일 정의:
 *   앞뒤 공백을 걷은 imagePrompt + 공백 하나 + `TOEIC_IMAGE_PROMPT_SUFFIX`, spec-sync 대상).
 * - 파라미터: 모델 `OPENAI_IMAGE_MODEL`(빈 값이면 gpt-image-2), 품질 `OPENAI_IMAGE_QUALITY`(빈 값이면 medium), 1536×1024,
 *   JPEG 압축 70. 결과 data URL이 900,000자를 넘으면 압축 50으로 **1회** 다시 만들고, 그래도 넘으면 실패(Firestore 문서 1MB).
 * - 실패는 throw하지 않고 **결과 값**으로 돌려준다(`{ok:false, error}`) — 라우트가 사진 상태를 `failed`로 적고 화면은
 *   장면 설명(sceneKo)으로 대신한다. 키가 없으면 **네트워크 호출 없이** `no_api_key`.
 * - `signal`: 라우트는 요청 신호(req.signal)를 넘기지 않는다 — 응답이 끊겨도(60초 상한) 서버가 끝까지 만들어 저장해야
 *   하므로(§4-10) 서버 쪽 시간 상한 신호만 넘긴다.
 *
 * 프롬프트·사진 바이트는 로그에 남기지 않는다(모델·압축·크기·ms만).
 *
 * 2026-09-26: 모델 env 해석·키 규약·JPEG 조립·크기 초과 재생성 루프는 **공용 코어 lib/image-gen.ts**로 옮겼다 — 은우 자유대화
 * 주제 일러스트(lib/talk-image.ts, english.md §12-6)가 같은 코어를 쓴다. 이 파일은 토익 설정(품질 env·1536×1024·압축 70→50·
 * 프롬프트 접미사)만 넘긴다. **동작 불변**(같은 모델·품질·크기·압축·상한·결과 모양·로그 태그 `toeic_scene`, eval:toeic).
 */

import { buildSceneImagePrompt } from "./ai/toeic/prompts";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MIME,
  generateJpegImage,
  hasImageApiKey,
  normalizeImageQuality,
  resolveImageModel,
  type ImageQuality,
  type JpegImageResult,
} from "./image-gen";

/** 기본 사진 모델(§1-1 관문 표). env `OPENAI_IMAGE_MODEL`로 바꾼다(공용 코어와 같은 값). */
export const DEFAULT_TOEIC_IMAGE_MODEL = DEFAULT_IMAGE_MODEL;
/** 기본 품질(§1-1). env `OPENAI_IMAGE_QUALITY`로 바꾼다(low·medium·high·auto). */
export const DEFAULT_TOEIC_IMAGE_QUALITY: ImageQuality = "medium";
/** 가로 사진(§4-10) — 시험 화면의 사진 비율 */
export const TOEIC_IMAGE_SIZE = "1536x1024";
/** 첫 시도 JPEG 압축(§4-10) */
export const TOEIC_IMAGE_COMPRESSION = 70;
/** 크기 초과 때 한 번 더 시도하는 압축(§4-10) */
export const TOEIC_IMAGE_COMPRESSION_RETRY = 50;
/** 저장 가능한 data URL 길이 상한(§4-10·§7-4 — Firestore 문서 1MB) */
export const TOEIC_IMAGE_DATA_URL_MAX = 900_000;
/** 저장·전달 형식 — JPEG만 만든다 */
export const TOEIC_IMAGE_MIME = IMAGE_MIME;

/** 실제 쓸 모델 — 비었거나 공백뿐이면 기본값(빈 값이 `""`로 새면 호출이 400으로 실패한다, SPEC §11 빈 값 폴백). */
export function resolveToeicImageModel(): string {
  return resolveImageModel();
}

/** 실제 쓸 품질 — 비었거나 모르는 값이면 기본값(모르는 값을 그대로 보내면 400이라 조용히 사진이 사라진다). */
export function resolveToeicImageQuality(): ImageQuality {
  return normalizeImageQuality(process.env.OPENAI_IMAGE_QUALITY, DEFAULT_TOEIC_IMAGE_QUALITY);
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다(lib/ai/client.ts·lib/tts.ts와 같은 규약). */
export function hasToeicImageApiKey(): boolean {
  return hasImageApiKey();
}

/** 결과 모양(공용 코어와 같다) — ok면 dataUrl·model·compression(70 또는 50), 아니면 no_api_key·too_large·failed + detail */
export type SceneImageResult = JpegImageResult;

/**
 * C2 장면의 사진 한 장을 만든다(사진 한 장 = 요청 하나, §4-10). 실패는 throw하지 않고 결과 값으로 돌려준다.
 * @param imagePrompt C2 `items[slot].imagePrompt` 그대로 — 접미사는 여기서 붙인다(buildSceneImagePrompt)
 * @param signal 서버 쪽 시간 상한(요청 신호가 아니다 — 파일 머리말)
 */
export async function generateSceneImage(imagePrompt: string, signal?: AbortSignal): Promise<SceneImageResult> {
  return generateJpegImage({
    tag: "toeic_scene",
    prompt: buildSceneImagePrompt(imagePrompt),
    model: resolveToeicImageModel(),
    quality: resolveToeicImageQuality(),
    size: TOEIC_IMAGE_SIZE,
    compressions: [TOEIC_IMAGE_COMPRESSION, TOEIC_IMAGE_COMPRESSION_RETRY],
    maxDataUrlChars: TOEIC_IMAGE_DATA_URL_MAX,
    signal,
  });
}

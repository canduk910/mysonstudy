/**
 * lib/ja-speaking-image.ts — 관문 P(일본어 말하기 모의고사): Q3–4 **일본 배경** 사진 생성 (**서버 전용**) (docs/harness/japanese.md §15-7)
 *
 * **하네스 밖 관문**이다 — 사진 공용 코어 `lib/image-gen.ts`의 `generateJpegImage`를 **그대로** 부르는 얇은 모듈(토익 lib/toeic-image.ts와 같은
 * 설정: 모델 `OPENAI_IMAGE_MODEL` → gpt-image-2, 품질 `OPENAI_IMAGE_QUALITY` → medium, 1536×1024, JPEG 압축 70 → 초과 시 50으로 1회,
 * data URL 900,000자 상한). 로그 태그 `ja_speaking_scene`. 토익 모듈·코어는 고치지 않는다 — 토익 설정 상수만 같은 값으로 가져온다.
 *
 * 프롬프트 = E2 `imagePrompt` + 공백 하나 + `JA_SPEAKING_IMAGE_PROMPT_SUFFIX`(조립은 `buildJaSpeakingImagePrompt` 단일 정의 — spec-sync 대상).
 * 실패는 throw하지 않고 결과 값으로 돌려준다. 키가 없으면 네트워크 호출 없이 no_api_key. 프롬프트·사진 바이트는 로그에 남기지 않는다.
 */

import { buildJaSpeakingImagePrompt } from "./ai/japanese/speaking-prompts";
import { generateJpegImage, hasImageApiKey, type JpegImageResult } from "./image-gen";
import {
  TOEIC_IMAGE_COMPRESSION,
  TOEIC_IMAGE_COMPRESSION_RETRY,
  TOEIC_IMAGE_DATA_URL_MAX,
  TOEIC_IMAGE_SIZE,
  resolveToeicImageModel,
  resolveToeicImageQuality,
} from "./toeic-image";

/** 로그 태그(§15-7) */
export const JA_SPEAKING_IMAGE_TAG = "ja_speaking_scene";

export function hasJaSpeakingImageApiKey(): boolean {
  return hasImageApiKey();
}

/** E2 장면의 사진 한 장(사진 한 장 = 요청 하나). signal은 서버 쪽 시간 상한(요청 신호가 아니다 — 응답이 끊겨도 끝까지 만들어 저장) */
export async function generateJaSpeakingSceneImage(imagePrompt: string, signal?: AbortSignal): Promise<JpegImageResult> {
  return generateJpegImage({
    tag: JA_SPEAKING_IMAGE_TAG,
    prompt: buildJaSpeakingImagePrompt(imagePrompt),
    model: resolveToeicImageModel(),
    quality: resolveToeicImageQuality(),
    size: TOEIC_IMAGE_SIZE,
    compressions: [TOEIC_IMAGE_COMPRESSION, TOEIC_IMAGE_COMPRESSION_RETRY],
    maxDataUrlChars: TOEIC_IMAGE_DATA_URL_MAX,
    signal,
  });
}

/**
 * lib/talk-image.ts — 은우 자유대화 **주제 일러스트** 생성 (서버 전용, 하네스 밖 관문) (docs/harness/english.md §12-6, SPEC §21-7)
 *
 * 대화를 시작할 때 연결과 **병렬로** 주제 장면 그림을 한 장 만든다(`POST /api/english/talk/scene`). 사진 생성 공용 코어
 * (lib/image-gen.ts — 토익 관문 P와 같은 모델·키 규약·크기 초과 재생성)를 대화용 설정으로 부른다:
 * - 모델 env `OPENAI_IMAGE_MODEL`(빈 값이면 gpt-image-2) — 토익과 같은 env
 * - **품질 low**(빠르게 — 대화가 시작된 뒤 수십 초 안에 도착해야 쓸모가 있다), 1024×1024
 * - JPEG 압축 60, data URL이 TALK_SCENE_DATA_URL_MAX(900,000자)를 넘으면 압축 40으로 **1회** 다시 만든다
 * - 프롬프트 = TALK_SCENE_IMAGE_PROMPT의 `{scene}`에 장면 문장(buildTalkSceneImagePrompt — 한 번 훑기 치환, spec-sync 원문)
 *
 * 실패는 결과 값(`{ok:false, error}`) — 라우트가 501(키 없음)/500(그 밖)으로 옮기고, **대화는 그림 없이 그대로 간다**.
 * 생성한 그림은 여기서 저장하지 않는다 — 대화를 저장할 때(은우 발화 ≥ 1) 함께 `talkImages`에 들어간다(저장하지 않는 대화의 그림은
 * 서버에 남지 않는다).
 */

import { buildTalkSceneImagePrompt } from "./ai/english/talk-prompts";
import { generateJpegImage, resolveImageModel, type ImageQuality, type ImageSize, type JpegImageResult } from "./image-gen";
import { TALK_SCENE_DATA_URL_MAX } from "./talk-contract";

/** 대화용 품질(§12-6 "품질 low") — env로 바꾸지 않는다(토익 품질 env와 섞이지 않게) */
export const TALK_IMAGE_QUALITY: ImageQuality = "low";
/** 정사각형(§12-6 1024×1024) — 폰 화면 위쪽 그림 칸 */
export const TALK_IMAGE_SIZE: ImageSize = "1024x1024";
/** 첫 시도 JPEG 압축(§12-6) */
export const TALK_IMAGE_COMPRESSION = 60;
/** 크기 초과 때 한 번 더 시도하는 압축(§12-6) */
export const TALK_IMAGE_COMPRESSION_RETRY = 40;

/** 실제 쓸 모델(토익 관문 P와 같은 env·기본값) */
export function resolveTalkImageModel(): string {
  return resolveImageModel();
}

/**
 * 장면 문장(`buildTalkSceneEn(topic)`) → 주제 일러스트 한 장. 키가 없으면 네트워크 없이 no_api_key.
 * @param signal 서버 쪽 시간 상한 + 요청 끊김(대화가 먼저 끝나 화면이 요청을 버렸으면 상류 생성도 멈춘다)
 */
export async function generateTalkSceneImage(sceneEn: string, signal?: AbortSignal): Promise<JpegImageResult> {
  return generateJpegImage({
    tag: "talk_scene",
    prompt: buildTalkSceneImagePrompt(sceneEn),
    model: resolveTalkImageModel(),
    quality: TALK_IMAGE_QUALITY,
    size: TALK_IMAGE_SIZE,
    compressions: [TALK_IMAGE_COMPRESSION, TALK_IMAGE_COMPRESSION_RETRY],
    maxDataUrlChars: TALK_SCENE_DATA_URL_MAX,
    signal,
  });
}

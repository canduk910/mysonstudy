/**
 * lib/image-gen.ts — 사진 생성 **공용 코어** (서버 전용, 하네스 밖 관문)
 * (docs/harness/toeic.md §1-1·§4-10 관문 P, docs/harness/english.md §12-6 주제 일러스트)
 *
 * 토익 모의고사 Q3–4 사진(lib/toeic-image.ts)과 은우 자유대화 주제 일러스트(lib/talk-image.ts)가 **같은 코어**를 쓴다 —
 * 모델 env 해석·키 규약·JPEG data URL 조립·크기 상한 초과 시 낮은 압축으로 다시 만들기·로그 모양이 한 곳에 산다.
 * 과목별 차이(품질·크기·압축값·프롬프트 조립·로그 태그)는 호출부가 인자로 넘긴다(lib/ai/client.ts에 과목 분기를 두지 않는
 * 것과 같은 원칙 — 코어는 과목을 모른다).
 *
 * - **하네스 밖**이다 — Structured Outputs가 아니라 이미지 바이트를 받는 호출이라 `callWithSchema`·zod·재요청을 거치지 않고
 *   **독립 OpenAI 클라이언트**를 쥔다(lib/tts.ts와 같은 부류, docs/HARNESS.md §0). 키 규약만 같다 — 없으면 네트워크 없이 no_api_key.
 * - 실패는 throw하지 않고 **결과 값**으로 돌려준다(`{ok:false, error}`) — 라우트가 상태를 사실대로 기록한다.
 * - 모델 env `OPENAI_IMAGE_MODEL`(빈 값·공백이면 gpt-image-2 — SPEC §11 빈 값 폴백). 품질은 호출부가 정한다.
 * - 프롬프트·사진 바이트는 로그에 남기지 않는다(태그·모델·품질·압축·크기·ms만).
 */

import OpenAI from "openai";

/** 기본 사진 모델(toeic.md §1-1·english.md §12-6). env `OPENAI_IMAGE_MODEL`로 바꾼다. */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
/** 저장·전달 형식 — JPEG만 만든다 */
export const IMAGE_MIME = "image/jpeg";

export type ImageQuality = "low" | "medium" | "high" | "auto";
export const IMAGE_QUALITIES: readonly ImageQuality[] = ["low", "medium", "high", "auto"];
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

/** 실제 쓸 모델 — 비었거나 공백뿐이면 기본값(빈 값이 `""`로 새면 호출이 400으로 실패한다, SPEC §11 빈 값 폴백). */
export function resolveImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
}

/** 품질 문자열 정리 — 비었거나 모르는 값이면 fallback(모르는 값을 그대로 보내면 400이라 조용히 사진이 사라진다). */
export function normalizeImageQuality(raw: string | undefined | null, fallback: ImageQuality): ImageQuality {
  const v = raw?.trim().toLowerCase() || fallback;
  return (IMAGE_QUALITIES as readonly string[]).includes(v) ? (v as ImageQuality) : fallback;
}

/** 키가 있는가 — 라우트가 501을 낼지 판정한다(lib/ai/client.ts·lib/tts.ts와 같은 규약). */
export function hasImageApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;

/** 사진 전용 OpenAI 클라이언트(캐시). 키 확인은 호출부가 먼저 한다. 재시도는 1회(한 장이 오래 걸려 3회면 너무 길다). */
function getImageClient(apiKey: string): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI({ apiKey, maxRetries: 1 });
  return cachedClient;
}

export interface JpegImageRequest {
  /** 로그 태그(예: toeic_scene·talk_scene) */
  tag: string;
  /** 완성된 프롬프트(접미사·템플릿 조립은 호출부 몫) */
  prompt: string;
  model: string;
  quality: ImageQuality;
  size: ImageSize;
  /** 시도할 JPEG 압축값(앞에서부터). 결과가 `maxDataUrlChars`를 넘으면 다음 값으로 **다시 만든다** — 마지막 값도 넘으면 too_large */
  compressions: readonly number[];
  /** data URL 길이 상한(Firestore 문서 1MB 안) */
  maxDataUrlChars: number;
  /** 시간 상한 신호(라우트가 정한다) */
  signal?: AbortSignal;
}

export type JpegImageResult =
  | {
      ok: true;
      /** `data:image/jpeg;base64,…` — 길이 ≤ maxDataUrlChars */
      dataUrl: string;
      model: string;
      /** 실제로 통과한 압축값 */
      compression: number;
    }
  | {
      ok: false;
      /** no_api_key: 키 없음(호출 안 함) · too_large: 마지막 압축으로도 상한 초과 · failed: API 오류·빈 응답·시간 초과 */
      error: "no_api_key" | "too_large" | "failed";
      model: string;
      /** 서버 로그용 짧은 원인(화면에 그대로 보이지 않는다) */
      detail: string;
    };

/**
 * JPEG 사진 한 장을 만든다(사진 한 장 = 요청 하나). 실패는 throw하지 않고 결과 값으로 돌려준다.
 * 키가 없으면 **네트워크 호출 없이** no_api_key.
 */
export async function generateJpegImage(req: JpegImageRequest): Promise<JpegImageResult> {
  const { tag, model } = req;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", model, detail: "OPENAI_API_KEY 없음 — 호출하지 않음" };

  const client = getImageClient(apiKey);
  let lastLength = 0;
  let lastCompression = req.compressions[req.compressions.length - 1] ?? 0;

  for (const compression of req.compressions) {
    lastCompression = compression;
    const started = Date.now();
    try {
      const res = await client.images.generate(
        {
          model,
          prompt: req.prompt,
          n: 1,
          size: req.size,
          quality: req.quality,
          output_format: "jpeg",
          output_compression: compression,
        },
        { signal: req.signal },
      );
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) {
        console.warn(`[image] ${tag} model=${model} compression=${compression} ms=${Date.now() - started} 빈 응답`);
        return { ok: false, error: "failed", model, detail: "응답에 사진이 없음" };
      }
      const dataUrl = `data:${IMAGE_MIME};base64,${b64}`;
      lastLength = dataUrl.length;
      console.log(
        `[image] ${tag} model=${model} quality=${req.quality} compression=${compression} chars=${dataUrl.length} ms=${Date.now() - started}`,
      );
      if (dataUrl.length <= req.maxDataUrlChars) return { ok: true, dataUrl, model, compression };
      // 상한 초과 — 다음 압축값으로 한 번 더(루프), 마지막 값으로도 넘으면 아래 too_large
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[image] ${tag} model=${model} compression=${compression} ms=${Date.now() - started} 실패:`, message.slice(0, 300));
      return { ok: false, error: "failed", model, detail: message.slice(0, 300) };
    }
  }
  return { ok: false, error: "too_large", model, detail: `압축 ${lastCompression}에서도 ${lastLength}자 > ${req.maxDataUrlChars}` };
}

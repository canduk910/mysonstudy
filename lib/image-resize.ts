/**
 * lib/image-resize.ts — 업로드 전 사진 리사이즈 (클라이언트 전용)
 *
 * 왜 별도 모듈인가: 영어 표지(`components/home-create.tsx`)·수학 문제집
 * (`components/math-photo-flow.tsx`)·앞으로 붙을 화면이 **같은 리사이즈**를 써야 한다.
 * 상한이 어긋나면 한쪽만 원본 크기로 보내 vision 토큰이 조용히 몇 배로 뛴다.
 *
 * 런타임 의존성 0이 이 파일의 조건이다 — 브라우저 API(`Image`·`canvas`)와
 * `lib/upload-limits.ts`의 순수 상수만 쓴다. `lib/ai/*`를 import하면 OpenAI SDK와
 * API 키가 클라이언트 번들에 실리므로 절대 끌어오지 않는다.
 */

import { JPEG_QUALITY, MAX_IMAGE_EDGE } from "@/lib/upload-limits";

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러오지 못했어요"));
    };
    img.src = url;
  });
}

/** 긴 변을 `MAX_IMAGE_EDGE`로 줄여 JPEG data URL로 만든다(원본이 더 작으면 그대로). */
export async function resizeToJpegDataUrl(file: File): Promise<string> {
  const img = await loadImage(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(1, longEdge));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 사용 불가");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * lib/image-crop.ts — 업로드 전 사진 자르기 (클라이언트 전용)
 *
 * 왜 별도 모듈인가: 영어 표지(`components/home-create.tsx`)·수학 문제집
 * (`components/math-photo-flow.tsx`)·영어 단어장(`components/vocabbook-photo-flow.tsx`)이
 * **같은 자르기**를 써야 한다. 배경·손가락·옆 페이지를 잘라내 판독 정확도를 높이는 것이 목적이고,
 * 세 화면 모두 파일 선택 직후 이 모듈을 거쳐 `resizeToJpegDataUrl`로 넘긴다.
 *
 * 런타임 의존성 0이 이 파일의 조건이다 — 브라우저 API(`canvas`)와 순수 계산만 쓴다.
 * 이미지 로딩은 `lib/image-resize.ts`의 `loadImage`를 재사용한다(중복 금지). `JPEG_QUALITY`는
 * `lib/upload-limits.ts`의 순수 상수를 그대로 쓴다 — 자른 결과도 결국 `resizeToJpegDataUrl`을
 * 통과하므로 최종 품질 규약은 그쪽이 지킨다. `lib/ai/*`는 절대 import하지 않는다
 * (OpenAI SDK와 API 키가 클라이언트 번들에 실린다).
 *
 * 좌표 변환(표시 캔버스 ↔ 원본 픽셀)은 순수 함수로 분리해 단위 테스트가 가능하다:
 * `toSourceRect`·`clampRect`는 DOM 없이도 손으로 만든 케이스로 검증한다.
 */

import { loadImage } from "@/lib/image-resize";
import { JPEG_QUALITY } from "@/lib/upload-limits";

/** 자르기 사각형 — **원본 픽셀 좌표** 기준(표시 캔버스가 아니다). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 폭·높이 한 쌍 — 표시 캔버스 크기 / 원본 픽셀 크기 양쪽에 쓴다. */
export interface Size {
  width: number;
  height: number;
}

/**
 * 사각형을 경계 안으로 클램프한다 — 네 변을 각각 `[0, bounds]`로 자른다.
 *
 * 순수 함수(eval 대상). 음수 좌표(왼쪽·위로 넘침)나 음수 폭(위로 드래그)도 안전하게 다룬다:
 * 좌/상은 0으로 밀고, 우/하는 경계로 당기며, 폭·높이는 항상 0 이상이 된다. 그래서 드래그
 * 중간값을 그대로 넣어도 캔버스 밖으로 나가지 않는다.
 */
export function clampRect(rect: CropRect, bounds: Size): CropRect {
  const left = Math.max(0, Math.min(rect.x, bounds.width));
  const top = Math.max(0, Math.min(rect.y, bounds.height));
  // 오른쪽·아래쪽 변을 먼저 경계로 자른 뒤, 좌/상보다 작아지지 않게 잡는다(폭·높이 ≥ 0).
  const right = Math.max(left, Math.min(rect.x + rect.width, bounds.width));
  const bottom = Math.max(top, Math.min(rect.y + rect.height, bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 표시 캔버스 좌표의 선택 영역을 원본 픽셀 좌표로 옮긴다(그 뒤 원본 경계로 클램프).
 *
 * 순수 함수(eval 대상). 표시 캔버스는 원본을 축소해 그리므로, 선택 영역에 `원본/표시` 배율을
 * 곱해야 실제 잘라낼 픽셀 위치가 나온다. 정수로 반올림해 `drawImage`가 부분 픽셀을 흐리게
 * 그리지 않게 한다. `displaySize`가 0이면 1로 막아 0으로 나누지 않는다.
 */
export function toSourceRect(
  displayRect: CropRect,
  displaySize: Size,
  sourceSize: Size,
): CropRect {
  const sx = sourceSize.width / Math.max(1, displaySize.width);
  const sy = sourceSize.height / Math.max(1, displaySize.height);
  const scaled: CropRect = {
    x: Math.round(displayRect.x * sx),
    y: Math.round(displayRect.y * sy),
    width: Math.round(displayRect.width * sx),
    height: Math.round(displayRect.height * sy),
  };
  return clampRect(scaled, sourceSize);
}

/**
 * 이미지를 90°의 배수로 회전한 새 `File`을 만든다(0이면 원본 그대로 반환 — 재인코딩 없음).
 *
 * 세로 페이지를 가로로 찍은 사진을 크롭 전에 똑바로 세우는 용도. 항상 **원본에서** 누적 각도로
 * 한 번만 회전하므로(각도별로 원본을 다시 회전) 여러 번 눌러도 화질이 누적으로 상하지 않는다.
 * 결과는 회전된 픽셀을 담은 JPEG `File`이라, 이후 크롭(`cropImageFile`)·리사이즈가 그대로 이어진다.
 * canvas만 쓴다(순수 계산 + 브라우저 canvas).
 */
export async function rotateImageFile(file: File, degrees: number): Promise<File> {
  const rot = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  if (rot === 0) return file;
  const img = await loadImage(file);
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const quarter = rot === 90 || rot === 270;
  const canvas = document.createElement("canvas");
  canvas.width = quarter ? nh : nw;
  canvas.height = quarter ? nw : nh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 사용 불가");
  // 회전 원점을 옮긴 뒤 회전하고 원본을 (0,0)에 그린다 — 표준 90°/180°/270° 레시피.
  if (rot === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rot === 180) {
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
  } else {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("이미지를 회전하지 못했어요");
  return new File([blob], file.name, { type: "image/jpeg" });
}

/** `foo.jpg` → `foo-cropped.jpg`. 출력이 JPEG이므로 확장자를 `.jpg`로 맞춘다. */
function croppedName(name: string): string {
  const trimmed = name.trim() || "photo";
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base}-cropped.jpg`;
}

/**
 * `crop` 사각형(원본 픽셀 좌표)으로 `File`을 잘라 새 `File`을 만든다. canvas만 쓴다.
 *
 * 반환은 `File`(원본 파일명 + `-cropped` 접미사)이라 기존 `resizeToJpegDataUrl(file)`에 그대로
 * 들어간다. 잘린 영역이 1픽셀 미만이면(빈 선택·경계 밖) 원본을 그대로 돌려준다 — 자르기가
 * 사진을 삼켜 버리는 사고를 막는다. 이미지 로딩은 `loadImage`를 재사용한다.
 */
export async function cropImageFile(file: File, rect: CropRect): Promise<File> {
  const img = await loadImage(file);
  const source: Size = { width: img.naturalWidth, height: img.naturalHeight };
  const safe = clampRect(rect, source);
  // 자를 게 없으면(빈 선택 등) 원본을 그대로 — 다운스트림 규약은 그대로 지켜진다.
  if (safe.width < 1 || safe.height < 1) return file;

  const w = Math.round(safe.width);
  const h = Math.round(safe.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 사용 불가");
  ctx.drawImage(img, safe.x, safe.y, w, h, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("이미지를 자르지 못했어요");
  return new File([blob], croppedName(file.name), { type: "image/jpeg" });
}

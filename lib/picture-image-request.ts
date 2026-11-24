/**
 * lib/picture-image-request.ts — 사진 묘사 문항의 "사진 만들기" 요청 한 번의 판정 (클라이언트 공용, 2026-11-25)
 *
 * 토익 학습 보기(`components/toeic-mock-detail-view.tsx`)·토익 한 문제 연습(`components/toeic-drill-view.tsx`)·
 * 일본어 말하기 학습 보기(`components/ja-speaking-detail-view.tsx`)가 똑같은 흐름을 세 벌 들고 있었다:
 *   POST …/image → ok면 ready · 501이면 키 없음 · 409면 다른 탭이 바꿈(조용히 새로 읽기) ·
 *   그 밖의 실패(네트워크 끊김 포함)는 **한 번 새로 읽어 이미 저장됐는지 본 뒤에만** 실패로 보인다(toeic.md §4-10).
 * 여기서는 그 판정만 한다 — 화면 상태(setJob)·`router.refresh()`·중복 요청 잠금은 각 화면이 결과를 받아 처리한다
 * (화면마다 상태 모양이 다르다: 칸 번호/연습 id, imageId 유무, 시작 시각).
 *
 * 서버 모듈을 import하지 않는다(클라이언트 번들 안전 — 순수 fetch).
 */

import type { JaSpeakingImageResponse } from "./ja-speaking-contract";
import type { ToeicMockImageResponse } from "./toeic-mock-contract";

/** 사진 라우트 응답 중 이 판정이 보는 부분(토익·일본어 계약 둘 다 이 모양을 품는다) */
export type PictureImageResponseLike =
  | { ok: true; image: { imageId: string | null } }
  | { ok: false; messageKo: string };

export type PictureImageOutcome =
  | { kind: "ready"; imageId: string }
  | { kind: "nokey"; message: string }
  /** 409 — 장면이 바뀌었거나 다른 곳이 먼저 처리했다. 화면은 상태를 비우고 새로 읽는다 */
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

export interface RequestPictureImageArgs {
  /** POST 주소(`/api/…/image`) */
  url: string;
  /** 요청 본문의 칸 번호 */
  slot: 0 | 1;
  /** 실패를 받았을 때 한 번 새로 읽는다 — 저장된 사진이 준비됐으면 그 imageId, 아니면 null */
  reread: () => Promise<string | null>;
  /** 응답 본문조차 못 받았을 때(네트워크 끊김·JSON 아님) 보일 문구 — 화면마다 다음 행동 안내가 다르다 */
  noResponseMessageKo: string;
}

export async function requestPictureImage(args: RequestPictureImageArgs): Promise<PictureImageOutcome> {
  let status = 0;
  let data: PictureImageResponseLike | null = null;
  try {
    const res = await fetch(args.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: args.slot }),
    });
    status = res.status;
    data = (await res.json().catch(() => null)) as PictureImageResponseLike | null;
  } catch {
    data = null; // 네트워크가 끊겼다 — 아래에서 다시 읽어 확인
  }
  if (data?.ok && data.image.imageId) return { kind: "ready", imageId: data.image.imageId };
  if (status === 501 && data && !data.ok) return { kind: "nokey", message: data.messageKo };
  if (status === 409) return { kind: "conflict" };
  // 실패로 받았다 — 이미 저장됐는지 한 번 새로 읽은 뒤에만 실패로 보인다
  const savedId = await args.reread();
  if (savedId) return { kind: "ready", imageId: savedId };
  return { kind: "failed", message: data && !data.ok ? data.messageKo : args.noResponseMessageKo };
}

// 계약이 이 판정이 보는 모양을 벗어나면 컴파일에서 멈춘다(두 라우트 계약 ↔ 공용 판정 드리프트 방지).
type Covers<T> = [T] extends [PictureImageResponseLike] ? true : false;
const _toeicCovered: Covers<ToeicMockImageResponse> = true;
const _jaCovered: Covers<JaSpeakingImageResponse> = true;
void _toeicCovered;
void _jaCovered;

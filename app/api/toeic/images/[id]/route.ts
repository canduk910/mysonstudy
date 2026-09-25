/**
 * GET /api/toeic/images/[id] — 모의고사 Q3–4 생성 사진 한 장 (docs/harness/toeic.md §4-10·§7-4)
 *
 * `toeicImages` 문서의 data URL을 **이미지 바이트**로 풀어 내려준다(`<img src>`가 곧바로 쓴다). PIN 게이트(proxy.ts) 안이다 —
 * 경로에 확장자를 붙이지 않는다(정적 파일 확장자 예외에 걸리면 잠금을 우회한다).
 *
 * 캐시: `private`(공유 캐시 저장 금지 — 가족 전용 화면) + 긴 max-age·immutable. 사진 id 하나의 내용은 바뀌지 않는다(새 사진은
 * 새 id — lib/toeic-mock-apply.ts "먼저 준비된 사진이 이긴다"). 모의고사를 지우면 문서도 지워진다(연쇄).
 *
 * 응답:
 * - 200 image/jpeg 바이트(cache-control: private, max-age=31536000, immutable)
 * - 404 { ok:false, error:"image_not_found", messageKo }
 * - 500 { ok:false, error:"image_unreadable", messageKo }   ← 저장된 값이 data URL 모양이 아님
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import type { ToeicImageGetErrorResponse } from "@/lib/toeic-mock-contract";

export const runtime = "nodejs";

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

function error(body: ToeicImageGetErrorResponse, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getStore().getToeicImage(id);
  if (!record) return error({ ok: false, error: "image_not_found", messageKo: "없거나 지워진 사진이에요." }, 404);

  const m = DATA_URL_RE.exec(record.dataUrl);
  if (!m) {
    console.error(`[/api/toeic/images/${id}] 저장된 사진이 data URL 모양이 아님(길이 ${record.dataUrl.length})`);
    return error({ ok: false, error: "image_unreadable", messageKo: "사진을 읽지 못했어요." }, 500);
  }
  const bytes = Buffer.from(m[2], "base64");
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": m[1],
      "content-length": String(bytes.length),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

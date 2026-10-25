/**
 * GET /api/japanese/speaking/images/[id] — 말하기 모의고사 Q3–4 사진 바이트 (docs/harness/japanese.md §15-9-2)
 *
 * PIN 게이트 안(proxy.ts). 저장된 data URL을 바이트로 풀어 내준다(cache-control private — 같은 기기 두 번째부터 즉시).
 * 응답: 200 image/jpeg · 404 { ok:false, error:"image_not_found", messageKo } · 500 { ok:false, error:"image_unreadable", messageKo }
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

type ErrorBody = { ok: false; error: "image_not_found" | "image_unreadable"; messageKo: string };

function error(body: ErrorBody, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getStore().getJaSpeakingImage(id);
  if (!record) return error({ ok: false, error: "image_not_found", messageKo: "없거나 지워진 사진이에요." }, 404);
  const m = DATA_URL_RE.exec(record.dataUrl);
  if (!m) {
    console.error(`[/api/japanese/speaking/images/${id}] 저장된 사진이 data URL 모양이 아님(길이 ${record.dataUrl.length})`);
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

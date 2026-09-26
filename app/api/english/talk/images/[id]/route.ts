/**
 * GET /api/english/talk/images/[id] — 자유대화 주제 일러스트 한 장 (docs/harness/english.md §12-6)
 *
 * `talkImages` 문서의 data URL을 **이미지 바이트**로 풀어 내려준다(`<img src>`가 곧바로 쓴다). PIN 게이트(proxy.ts) 안이다 —
 * 경로에 확장자를 붙이지 않는다(정적 파일 확장자 예외에 걸리면 잠금을 우회한다). id가 문서 id 형식이 아니면(예: `x.png`)
 * 스토어를 읽지 않고 404 — 확장자 예외로 게이트를 지난 요청도 아무것도 얻지 못한다.
 *
 * 캐시: `private`(공유 캐시 저장 금지 — 가족 전용) + 긴 max-age·immutable(그림 id 하나의 내용은 바뀌지 않는다). 대화를 지우면
 * 문서도 지워진다(연쇄). 토익 `/api/toeic/images/[id]`와 같은 모양.
 *
 * 응답:
 * - 200 image/jpeg 바이트(cache-control: private, max-age=31536000, immutable)
 * - 404 { ok:false, error:"image_not_found", messageKo }
 * - 500 { ok:false, error:"image_unreadable", messageKo }   ← 저장된 값이 data URL 모양이 아님
 */

import { NextResponse } from "next/server";
import { isFirestoreDocId } from "@/lib/reorder-contract";
import { getStore } from "@/lib/store";
import type { TalkImageGetErrorResponse } from "@/lib/talk-contract";

export const runtime = "nodejs";

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
/** 저장소 id 모양(파일 randomUUID·Firestore 자동 id) — 확장자·경로 글자가 섞인 id는 문서가 될 수 없다 */
const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function error(body: TalkImageGetErrorResponse, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!IMAGE_ID_RE.test(id) || !isFirestoreDocId(id)) {
    return error({ ok: false, error: "image_not_found", messageKo: "없거나 지워진 그림이에요." }, 404);
  }
  const record = await getStore().getTalkImage(id);
  if (!record) return error({ ok: false, error: "image_not_found", messageKo: "없거나 지워진 그림이에요." }, 404);

  const m = DATA_URL_RE.exec(record.dataUrl);
  if (!m) {
    console.error(`[/api/english/talk/images/${id}] 저장된 그림이 data URL 모양이 아님(길이 ${record.dataUrl.length})`);
    return error({ ok: false, error: "image_unreadable", messageKo: "그림을 읽지 못했어요." }, 500);
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

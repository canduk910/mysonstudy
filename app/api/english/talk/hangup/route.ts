/**
 * POST /api/english/talk/hangup — 은우 자유대화 **서버 hangup**(과금 이중 안전장치) (docs/harness/english.md §12-1, SPEC §21-3)
 *
 * 화면이 대화를 끝낼 때(끝내기·5분 상한·화면 숨김·탭 닫힘) 브라우저 쪽 연결을 닫은 **뒤** 한 번 더 부른다 — 탭이 닫혀도 가도록
 * `navigator.sendBeacon`으로 보낸다. sendBeacon은 본문의 content-type을 마음대로 고를 수 없어(text/plain 등), 이 라우트는
 * content-type에 기대지 않고 **본문 글자를 JSON으로** 읽는다.
 *
 * - callId는 형식을 먼저 본다(`isTalkCallId` — 경로에 끼워 넣어도 안전한 글자만).
 * - 키가 없으면 OpenAI를 부르지 않고 501.
 * - 상류 실패(이미 끊겼다 등)는 무시한다 — 200 { hungUp:false }. 끝내기는 이미 브라우저가 했다.
 *
 * 응답(lib/talk-contract.ts `TalkHangupResponse`):
 * - 200 { ok:true, hungUp }
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 */

import { NextResponse } from "next/server";
import type { TalkHangupResponse } from "@/lib/talk-contract";
import { hangupTalkCall } from "@/lib/talk-gateway";
import { hasTalkApiKey, isTalkCallId } from "@/lib/talk-session-config";

export const runtime = "nodejs";

/** sendBeacon 본문 상한(방어선) */
const MAX_BODY_CHARS = 2_000;

function json(body: TalkHangupResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  let callId: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) throw new Error("too long");
    const parsed: unknown = JSON.parse(text);
    callId = typeof parsed === "object" && parsed !== null ? (parsed as { callId?: unknown }).callId : undefined;
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "끊기 요청을 읽지 못했어요." }, 400);
  }
  if (!isTalkCallId(callId)) {
    return json({ ok: false, error: "invalid_input", messageKo: "통화 번호 형식이 아니에요." }, 400);
  }
  if (!hasTalkApiKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 없어 서버에서 끊지 않았어요." }, 501);
  }
  const hungUp = await hangupTalkCall(callId);
  return json({ ok: true, hungUp });
}

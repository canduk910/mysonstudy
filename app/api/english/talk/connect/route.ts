/**
 * POST /api/english/talk/connect — 은우 자유대화 연결(관문 R, 통합 인터페이스) (docs/harness/english.md §12-1, SPEC §21-2·§21-3)
 *
 * 브라우저의 SDP offer + 주제 선택(키·직접 입력 글자·단어장 id) + 말 빠르기 → 서버가 주제 스냅샷을 해석하고 선생님 지시문·세션
 * 설정을 **서버에서** 조립해(lib/talk-session-config.ts) 표준 키로 OpenAI `/realtime/calls`에 multipart로 연결한다
 * (lib/talk-gateway.ts). 브라우저에는 SDP answer·callId·주제 스냅샷·모델·음성만 간다 — 키도 지시문도 나가지 않는다.
 *
 * - 키가 없으면 **OpenAI를 부르기 전에** 501(스토어도 읽지 않는다 — 로컬에서 키를 비우면 실호출이 구조적으로 0).
 * - 로그에는 SDP·지시문을 남기지 않는다(gateway가 상태·ms만).
 * - 요청 끊김(req.signal)을 상류에 넘긴다 — 화면이 연결을 포기했으면 통화를 만들지 않는다.
 *
 * 응답(lib/talk-contract.ts `TalkConnectResponse`):
 * - 200 { ok:true, sdp, callId, topic, model, voice }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 404 { ok:false, error:"vocab_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"connect_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { TALK_SDP_MAX_CHARS, type TalkConnectRequest, type TalkConnectResponse } from "@/lib/talk-contract";
import { connectTalkCall } from "@/lib/talk-gateway";
import { buildTalkSessionConfig, hasTalkApiKey, resolveTalkRealtimeModel, resolveTalkRealtimeVoice } from "@/lib/talk-session-config";
import { resolveTalkTopicRequest, talkTopicRequestSchema } from "@/lib/talk-topic-request";
import { TALK_SPEEDS } from "@/lib/talk-topics";

export const runtime = "nodejs";

const bodySchema = z.object({
  sdp: z.string().min(1).max(TALK_SDP_MAX_CHARS),
  topic: talkTopicRequestSchema,
  speed: z.enum(TALK_SPEEDS),
});

// 요청 계약 ↔ zod 양방향 묶기(app-patterns §2)
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [TalkConnectRequest, BodyInput] extends [BodyInput, TalkConnectRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkConnectResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "대화 시작 요청을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }

  // 키 검사 — OpenAI 호출·스토어 읽기보다 먼저
  if (!hasTalkApiKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 설정되지 않아 선생님과 연결할 수 없어요." }, 501);
  }

  const resolved = await resolveTalkTopicRequest(parsed.data.topic);
  if (!resolved.ok) return json({ ok: false, error: resolved.error, messageKo: resolved.messageKo }, resolved.status);

  const session = buildTalkSessionConfig({ topic: resolved.topic, speed: parsed.data.speed });
  const result = await connectTalkCall({ sdp: parsed.data.sdp, session, signal: req.signal });
  if (!result.ok) {
    if (result.error === "no_api_key") {
      return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 설정되지 않아 선생님과 연결할 수 없어요." }, 501);
    }
    return json({ ok: false, error: "connect_failed", messageKo: "선생님과 연결하지 못했어요. 잠시 후 다시 걸어 볼까요?" }, 500);
  }

  return json({
    ok: true,
    sdp: result.sdp,
    callId: result.callId,
    topic: resolved.topic,
    model: resolveTalkRealtimeModel(),
    voice: resolveTalkRealtimeVoice(),
  });
}

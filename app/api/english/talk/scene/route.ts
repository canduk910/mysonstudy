/**
 * POST /api/english/talk/scene — 은우 자유대화 **주제 일러스트** 1장 (docs/harness/english.md §12-6, SPEC §21-7)
 *
 * 대화를 시작할 때 화면이 연결(`/connect`)과 **병렬로** 부른다(연결을 기다리게 하지 않는다). 주제는 연결과 **같은 함수**
 * (lib/talk-topic-request.ts)로 해석하고 → 장면 문장 `buildTalkSceneEn(topic)` → 사진 생성 공용 코어(lib/talk-image.ts —
 * 품질 low·1024×1024·압축 60→40). **저장하지 않는다** — 대화를 저장할 때(은우 발화 ≥ 1) 화면이 그림을 함께 보내면 그때
 * `talkImages`에 들어간다(저장하지 않는 대화의 그림은 서버에 남지 않는다).
 *
 * - 비치명: 키가 없으면 501, 생성 실패면 500 — 화면은 그림 칸을 숨기고 **대화는 그대로 간다**.
 * - 요청 끊김을 상류에 넘긴다(대화가 먼저 끝나 화면이 요청을 버렸으면 생성도 멈춘다) + 서버 상한 55초(60초 요청 상한 안).
 * - 프롬프트·사진 바이트는 로그에 남기지 않는다(코어가 태그·모델·크기·ms만).
 *
 * 응답(lib/talk-contract.ts `TalkSceneResponse`):
 * - 200 { ok:true, dataUrl, sceneEn, note, model }   ← note = 선생님에게 넣을 안내(TALK_SCENE_NOTE 치환, 서버 조립)
 * - 400 invalid_input · 404 vocab_not_found
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"image_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { buildTalkSceneNote } from "@/lib/ai/english/talk-prompts";
import type { TalkSceneRequest, TalkSceneResponse } from "@/lib/talk-contract";
import { generateTalkSceneImage } from "@/lib/talk-image";
import { buildTalkSceneEn, hasTalkApiKey } from "@/lib/talk-session-config";
import { resolveTalkTopicRequest, talkTopicRequestSchema } from "@/lib/talk-topic-request";

export const runtime = "nodejs";

/** 서버 쪽 생성 상한 — 프로덕션 요청 상한(60초) 안 */
const SCENE_TIMEOUT_MS = 55_000;

const bodySchema = z.object({ topic: talkTopicRequestSchema });
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [TalkSceneRequest, BodyInput] extends [BodyInput, TalkSceneRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkSceneResponse, status = 200) {
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
        messageKo: "그림 요청을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }

  // 키 검사 — 사진 생성·스토어 읽기보다 먼저
  if (!hasTalkApiKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 없어 그림을 만들지 않았어요." }, 501);
  }

  const resolved = await resolveTalkTopicRequest(parsed.data.topic);
  if (!resolved.ok) return json({ ok: false, error: resolved.error, messageKo: resolved.messageKo }, resolved.status);

  const sceneEn = buildTalkSceneEn(resolved.topic);
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(SCENE_TIMEOUT_MS)]);
  const result = await generateTalkSceneImage(sceneEn, signal);
  if (!result.ok) {
    if (result.error === "no_api_key") {
      return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 없어 그림을 만들지 않았어요." }, 501);
    }
    return json({ ok: false, error: "image_failed", messageKo: "그림을 만들지 못했어요. 대화는 그대로 할 수 있어요." }, 500);
  }
  return json({ ok: true, dataUrl: result.dataUrl, sceneEn, note: buildTalkSceneNote(sceneEn), model: result.model });
}

/**
 * POST /api/english/talk/cards — 은우 자유대화 **화면 카드**(호출 J) (docs/harness/english.md §12-7, SPEC §21-7)
 *
 * 선생님 줄이 끝날 때마다(그 줄의 전사 `.done` + 응답 `response.done` completed) 화면(lib/talk-realtime.ts 컨트롤러)이 한 번 부른다.
 * 서버가 `generateTalkCards`(lib/ai/client.ts — `callWithSchema` 하네스 안 호출)로 도움(답 예시·핵심 단어)과 그림 카드를 만든다.
 * 음성 모델(관문 R)에는 도구가 없다 — 카드 때문에 선생님 응답이 끊기거나 "이어 말하기"가 새 응답을 만들지 않게(§12-7 "왜").
 *
 * - **저장하지 않는다.** 보인 그림 카드는 대화 저장 때 `cards`로 남는 기존 규칙 그대로다.
 * - 입력 폭은 lib/talk-cards.ts `TALK_CARDS_REQUEST_LIMITS` 한 곳을 import한다(숫자를 다시 적지 않는다). 폭을 넘으면 자르지 않고
 *   **400** — 화면은 `buildTalkCardsRequest`로 같은 폭에 미리 맞추므로, 400은 화면 버그의 신호다.
 * - 키 검사는 AI 호출 앞(501 — 로컬에서 키를 비우면 실호출이 구조적으로 불가능해진다).
 * - 시간 상한 6초·SDK 재시도 0·후처리(근거 없는 그림 null 등)는 진입 함수 안이다 — 라우트는 `req.signal`만 넘긴다(화면이 새 줄의
 *   요청으로 앞 요청을 끊으면 상류 호출도 멈춘다). 결과는 **그대로** 200 본문이다(다시 거르지 않는다).
 * - 실패·시간 초과·요청 취소는 500 `cards_failed` — 화면은 아무것도 하지 않는다(도움 카드는 기본 문구, 그림 카드는 없음).
 *   `retriable`은 싣지 않는다(다음 선생님 줄이 곧 새 요청을 만든다).
 * - 로그에는 대사·카드를 남기지 않는다(실패 종류와 ms만 — 호출 토큰은 callWithSchema가 한 줄로 남긴다).
 *
 * 응답(lib/talk-contract.ts `TalkCardsResponse`):
 * - 200 { ok:true, answers, words, picture }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues? }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"cards_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generateTalkCards } from "@/lib/ai/client";
import { TALK_SPEAKERS } from "@/lib/ai/english/talk-schemas";
import { TALK_CARDS_REQUEST_LIMITS } from "@/lib/talk-cards";
import type { TalkCardsRequest, TalkCardsResponse } from "@/lib/talk-contract";
import { hasTalkApiKey } from "@/lib/talk-session-config";

export const runtime = "nodejs";

const R = TALK_CARDS_REQUEST_LIMITS;

const bodySchema = z.object({
  topic: z.string().min(1).max(R.topicLabelMaxChars),
  words: z
    .array(z.object({ en: z.string().min(1).max(R.wordMaxChars), ko: z.string().max(R.wordMaxChars).nullable() }))
    .max(R.words),
  shown: z.array(z.string().min(1).max(R.shownMaxChars)).max(R.shown),
  context: z.array(z.object({ speaker: z.enum(TALK_SPEAKERS), text: z.string().min(1).max(R.lineMaxChars) })).max(R.context),
  teacherLine: z.string().min(1).max(R.lineMaxChars),
});

// 요청 계약 ↔ zod 양방향 묶기(app-patterns §2)
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [TalkCardsRequest, BodyInput] extends [BodyInput, TalkCardsRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkCardsResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** 실패 종류(로그용 — 대사·카드는 남기지 않는다) */
function failureKind(err: unknown, reqAborted: boolean): string {
  if (reqAborted) return "client_aborted";
  if (!(err instanceof Error)) return "error";
  // SDK 오류 클래스는 name이 "Error"로 남는 것이 있어 생성자 이름을 먼저 본다(APIUserAbortError·RateLimitError·InternalServerError…)
  const ctor = err.constructor?.name;
  const name = ctor && ctor !== "Error" ? ctor : err.name;
  if (name === "APIUserAbortError" || name === "AbortError" || name === "TimeoutError") return "timeout";
  return name && name !== "Error" ? name : "error";
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
        messageKo: "카드 요청을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }

  // 키 검사 — AI 호출보다 먼저
  if (!hasTalkApiKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI 키가 없어 화면 카드를 만들지 않았어요." }, 501);
  }

  const body = parsed.data;
  const started = Date.now();
  try {
    const cards = await generateTalkCards(
      { topicLabel: body.topic, words: body.words, shown: body.shown, context: body.context, teacherLine: body.teacherLine },
      { signal: req.signal },
    );
    return json({ ok: true, answers: cards.answers, words: cards.words, picture: cards.picture });
  } catch (err) {
    console.warn(`[/api/english/talk/cards] 실패(${failureKind(err, req.signal.aborted)}) ${Date.now() - started}ms`);
    return json({ ok: false, error: "cards_failed", messageKo: "화면 카드를 만들지 못했어요. 대화는 그대로 할 수 있어요." }, 500);
  }
}

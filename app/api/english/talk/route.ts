/**
 * POST /api/english/talk — 은우 자유대화 **저장**(끝난 뒤 1회) (docs/harness/english.md §12-4·§12-6, SPEC §21-2·§17-9)
 *
 * 화면이 대화를 끝내면(끝내기·5분 상한·화면 숨김) 스크립트(`toTalkTurns(lines)`)·보인 그림 카드·주제 일러스트(도착했으면)를
 * 한 번에 보낸다. AI를 부르지 않는다 — **키 검사 없음**(키가 없어도 저장은 된다).
 *
 * - 저장 조건: 은우 발화 ≥ 1(`childTurnCount` — 서버가 turns에서 다시 센다). 0이면 400 no_child_turn(화면은 애초에 부르지 않는다).
 * - 상한(QA talk-ai P2-6): 턴 200개·턴 글자 1,000자(`TALK_LIMITS`)를 넘으면 **거부하지 않고 앞에서부터 잘라** 저장한다(trimmed) —
 *   5분 대화 전체를 400으로 잃지 않게. 설명 키가 앞 턴부터라 앞쪽을 남기면 번호가 보존된다.
 * - 주제 스냅샷: connect가 돌려준 값을 그대로 받되 다시 확인한다 — 프리셋·직접 입력은 서버 해석 함수로 **다시 만든 값**을 저장하고
 *   (모르는 키·정리 뒤 빈 글자면 400), 단어장은 모양·상한만 본다(그 사이 단어장이 바뀌어도 "실제로 넘긴 단어" 스냅샷이 기록이다).
 * - 그림 카드: `sanitizeTalkCards`로 다시 검사(클라이언트 값을 믿지 않는다 — 같은 영어 1장, 최대 30장).
 * - 주제 일러스트: data URL 형식(JPEG base64)·크기(≤ TALK_SCENE_DATA_URL_MAX)를 검사해 통과하면 `talkImages`에 함께 저장하고
 *   sceneEn은 서버가 주제에서 다시 계산한다(`buildTalkSceneEn`). 검사에 떨어지면 **그림만 빼고** 대화는 저장한다(sceneSaved:false).
 * - 시각·모델: startedAt·endedAt은 시간대 있는 ISO만, durationSec은 서버가 두 시각에서 계산(0~3600초). 모델·음성은 이름 형식만 본다.
 * - **멱등(QA english_talk_1 P2-1)**: `clientSessionId`(TALK_SAVE_ID_RE — 화면이 대화 한 번에 하나 만든 저장 키)를 스토어가 문서 id로
 *   쓴다. 응답이 유실돼 다시 저장해도(화면 복귀 자동 재시도·"다시 저장"·뒤로가기 정리) 이미 저장된 대화를 그대로 돌려준다(200,
 *   같은 id) — 대화·그림이 두 번 생기지 않는다.
 *
 * 응답(lib/talk-contract.ts `TalkSaveResponse`):
 * - 200 { ok:true, id, childTurnCount, sceneSaved, trimmed } — 같은 clientSessionId의 두 번째 요청도 같은 id의 200
 * - 400 { ok:false, error:"invalid_input"|"no_child_turn", messageKo, issues? }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { TALK_LIMITS, TALK_SPEAKERS, TALK_TOPIC_KINDS, type TalkTopic, type TalkTurn } from "@/lib/ai/english/talk-schemas";
import { isZonedIsoTimestamp } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { sanitizeTalkCards } from "@/lib/talk-cards";
import {
  TALK_MODEL_NAME_RE,
  TALK_SAVE_ID_RE,
  TALK_SCENE_DATA_URL_MAX,
  type TalkSaveRequest,
  type TalkSaveResponse,
} from "@/lib/talk-contract";
import { resolveTalkImageModel } from "@/lib/talk-image";
import { defaultTalkTitle } from "@/lib/talk-record";
import { buildTalkSceneEn, resolveCustomTalkTopic, resolvePresetTalkTopic } from "@/lib/talk-session-config";
import { childTurnCount } from "@/lib/talk-transcript";

export const runtime = "nodejs";

/** 주제 일러스트 data URL 모양 — JPEG base64만(생성 관문이 JPEG만 만든다) */
const SCENE_DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
/** 대화 길이 상한(초) — 5분 상한 + 마무리·끊김 여유를 넉넉히. 넘는 값은 이 값으로 */
const MAX_DURATION_SEC = 3600;

const topicSchema = z.object({
  kind: z.enum(TALK_TOPIC_KINDS),
  key: z.string().max(64).nullable(),
  labelKo: z.string().min(1).max(200),
  labelEn: z.string().max(200).nullable(),
  vocabBookId: z.string().max(200).nullable(),
  words: z.array(z.object({ en: z.string().min(1).max(200), ko: z.string().max(200).nullable() })).max(TALK_LIMITS.vocabWords),
});

const bodySchema = z.object({
  clientSessionId: z.string().regex(TALK_SAVE_ID_RE, "저장 키 형식이 아니에요"),
  topic: topicSchema,
  // 넉넉한 방어선 — 실제 상한(TALK_LIMITS)은 아래에서 잘라 맞춘다(거부하지 않는다)
  turns: z
    .array(z.object({ speaker: z.enum(TALK_SPEAKERS), text: z.string().max(20_000), interrupted: z.boolean() }))
    .max(2_000),
  cards: z.array(z.object({ emoji: z.string(), en: z.string(), ko: z.string() })).max(500),
  scene: z
    .object({ dataUrl: z.string().max(TALK_SCENE_DATA_URL_MAX * 2), sceneEn: z.string().max(2_000) })
    .nullable(),
  startedAt: z.string().refine(isZonedIsoTimestamp, "시간대 있는 ISO 시각이어야 해요"),
  endedAt: z.string().refine(isZonedIsoTimestamp, "시간대 있는 ISO 시각이어야 해요"),
  model: z.string().regex(TALK_MODEL_NAME_RE),
  voice: z.string().regex(TALK_MODEL_NAME_RE),
});

// 요청 계약 ↔ zod 양방향 묶기(app-patterns §2)
type BodyInput = z.infer<typeof bodySchema>;
const requestMatchesSchema: [TalkSaveRequest, BodyInput] extends [BodyInput, TalkSaveRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: TalkSaveResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 코드 포인트 기준 자르기 */
function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** 받은 주제 스냅샷을 다시 확인한다 — 프리셋·직접 입력은 서버 해석 함수가 다시 만든 값, 단어장은 모양 그대로. 어긋나면 null */
function verifyTopic(t: z.infer<typeof topicSchema>): TalkTopic | null {
  if (t.kind === "preset") return resolvePresetTalkTopic(t.key);
  if (t.kind === "custom") return resolveCustomTalkTopic(t.labelKo);
  if (t.vocabBookId === null || t.words.length === 0) return null;
  return { kind: "vocab", key: null, labelKo: t.labelKo, labelEn: null, vocabBookId: t.vocabBookId, words: t.words };
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
        messageKo: "대화 기록을 확인해 주세요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const body = parsed.data;

  const topic = verifyTopic(body.topic);
  if (!topic) return json({ ok: false, error: "invalid_input", messageKo: "대화 주제를 확인하지 못했어요." }, 400);

  // 턴 — 빈 글자 제외, 앞에서부터 상한까지(설명 키가 앞 턴부터라 번호 보존), 글자 상한으로 자르기
  const cleaned: TalkTurn[] = body.turns
    .map((t) => ({ speaker: t.speaker, text: t.text.trim(), interrupted: t.speaker === "teacher" && t.interrupted }))
    .filter((t) => t.text !== "");
  let trimmed = cleaned.length > TALK_LIMITS.turns;
  const turns: TalkTurn[] = cleaned.slice(0, TALK_LIMITS.turns).map((t) => {
    const text = clampChars(t.text, TALK_LIMITS.turnChars);
    if (text !== t.text) trimmed = true;
    return { ...t, text };
  });
  const childCount = childTurnCount(turns);
  if (childCount < 1) {
    return json({ ok: false, error: "no_child_turn", messageKo: "은우가 한마디도 안 해서 저장하지 않았어요." }, 400);
  }

  // 시각 — 끝이 시작보다 앞이면 시작으로, 길이는 서버가 계산
  const startMs = Date.parse(body.startedAt);
  const endMs = Math.max(startMs, Date.parse(body.endedAt));
  const startedAt = new Date(startMs).toISOString();
  const endedAt = new Date(endMs).toISOString();
  const durationSec = Math.min(MAX_DURATION_SEC, Math.max(0, Math.round((endMs - startMs) / 1000)));

  // 주제 일러스트 — 형식·크기에 떨어지면 그림만 뺀다(대화가 더 중요하다)
  let scene: { dataUrl: string; sceneEn: string; model: string } | null = null;
  if (body.scene) {
    const ok = body.scene.dataUrl.length <= TALK_SCENE_DATA_URL_MAX && SCENE_DATA_URL_RE.test(body.scene.dataUrl);
    if (ok) scene = { dataUrl: body.scene.dataUrl, sceneEn: buildTalkSceneEn(topic), model: resolveTalkImageModel() };
    else console.warn(`[/api/english/talk] 주제 일러스트 형식·크기 검사 실패(길이 ${body.scene.dataUrl.length}) — 그림 없이 저장`);
  }

  try {
    const { record, created } = await getStore().createTalkSession(
      {
        titleKo: defaultTalkTitle(topic),
        topic,
        turns,
        startedAt,
        endedAt,
        durationSec,
        model: body.model,
        voice: body.voice,
        cards: sanitizeTalkCards(body.cards),
      },
      scene,
      body.clientSessionId,
    );
    if (!created) console.info("[/api/english/talk] 같은 저장 키로 다시 저장 — 이미 저장된 대화를 돌려준다(새로 만들지 않음)");
    return json({ ok: true, id: record.id, childTurnCount: record.childTurnCount, sceneSaved: record.sceneImageId !== null, trimmed });
  } catch (err) {
    console.error("[/api/english/talk] 저장 실패", err instanceof Error ? err.message : err);
    return json({ ok: false, error: "save_failed", messageKo: "대화를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * POST /api/toeic/frame-drill/sessions — 소재별 틀 말하기 **끝난 한 판** 저장 (docs/harness/toeic.md §20-2·§20-10 ①, SPEC §20-17)
 *
 * 진행 화면이 끝(또는 그만두기)에서 한 번 보낸다. 문항은 **출제 때의 글자 사본**(itemId는 은행에 없어도 받는다 — 출제 뒤 은행이
 * 바뀔 수 있다)과 결과(outcome·전사문)다. 판정 칸(verdict·reasonKo·fixedEn)·review·statsAppliedAt·supply는 서버가 null로 시작한다 —
 * 판정은 결과 화면이 `/sessions/[id]/judge`로 따로 받는다(요청 하나에 AI 한 번 — §1-1 60초 상한).
 *
 * - 결과는 서버가 다시 가른다: transcribe_failed가 아니면 `frameDrillOutcomeOf(transcript, false)`(전사 단어 < 2 → no_speech) —
 *   화면이 spoken이라 보내도 전사가 비었으면 무응답이다(판정·통계 규칙의 단일 정의처).
 * - 멱등: 문서 id = `fd-{clientSessionId}`(화면이 시작 탭에서 만든 id). 이미 있으면 쓰지 않고 reused:true("다시 저장"·응답 유실).
 * - AI·키 검사·prod-guard 없음(생성 — 키가 없어도 저장된다). 녹음은 받지 않는다(전사는 관문 T 라우트가 따로 — 저장 없음).
 * - 로그: 개수만(문장·전사문 없음 — 교재 유래 글).
 *
 * 응답 shape (단일 정의처 `lib/toeic-frame-drill-contract.ts` ToeicFrameDrillSessionResponse):
 * - 200 { ok:true, id, reused }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }   ← 경로·규칙만(값 없음)
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { TOEIC_FRAME_DRILL_ITEM_KO_MAX } from "@/lib/ai/toeic/frame-drill-schemas";
import { getStore } from "@/lib/store";
import {
  TOEIC_FRAME_DRILL_COUNT_MAX,
  TOEIC_FRAME_DRILL_COUNT_MIN,
  TOEIC_FRAME_DRILL_FRAMES_MAX,
  TOEIC_FRAME_DRILL_ITEM_ID_RE,
  TOEIC_FRAME_DRILL_KEY_RE,
  TOEIC_FRAME_DRILL_OUTCOMES,
  TOEIC_FRAME_DRILL_PARTS,
  TOEIC_FRAME_DRILL_QUESTION_TYPES_MAX,
  TOEIC_FRAME_DRILL_SESSION_ID_RE,
  TOEIC_FRAME_DRILL_TOPICS_MAX,
  frameDrillOutcomeOf,
  type ToeicFrameDrillSession,
} from "@/lib/toeic-frame-drill";
import {
  toeicFrameDrillSessionDocId,
  type ToeicFrameDrillSessionRequest,
  type ToeicFrameDrillSessionResponse,
} from "@/lib/toeic-frame-drill-contract";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

/** 전사문 상한 — 20초 녹음의 전사가 넉넉히 들어가는 길이(그 이상은 화면 버그) */
const TRANSCRIPT_MAX = 2000;

const key = z.string().regex(TOEIC_FRAME_DRILL_KEY_RE, "key 형식이 아니에요");
const keys = (max: number) => z.array(key).max(max).refine((a) => new Set(a).size === a.length, "key 중복 금지");

const bodySchema = z.object({
  clientSessionId: z.string().regex(TOEIC_FRAME_DRILL_SESSION_ID_RE, "clientSessionId 형식이 아니에요"),
  part: z.enum(TOEIC_FRAME_DRILL_PARTS),
  topicKeys: keys(TOEIC_FRAME_DRILL_TOPICS_MAX),
  questionTypeKeys: keys(TOEIC_FRAME_DRILL_QUESTION_TYPES_MAX),
  excludedFrameKeys: keys(TOEIC_FRAME_DRILL_FRAMES_MAX),
  requested: z.number().int().min(TOEIC_FRAME_DRILL_COUNT_MIN).max(TOEIC_FRAME_DRILL_COUNT_MAX),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  ended: z.enum(["done", "quit"]),
  items: z
    .array(
      z.object({
        itemId: z.string().regex(TOEIC_FRAME_DRILL_ITEM_ID_RE, "itemId 형식이 아니에요"),
        frameKey: key,
        ko: z.string().min(1).max(TOEIC_FRAME_DRILL_ITEM_KO_MAX),
        en: z.string().min(1).max(TTS_TEXT_MAX_CHARS),
        frame: z.string().min(1).max(TTS_TEXT_MAX_CHARS),
        outcome: z.enum(TOEIC_FRAME_DRILL_OUTCOMES),
        transcript: z.string().max(TRANSCRIPT_MAX).nullable(),
      }),
    )
    .min(1, "말한 문항이 하나도 없어요")
    .max(TOEIC_FRAME_DRILL_COUNT_MAX),
});

type BodyInput = z.infer<typeof bodySchema>;
// 요청 계약 ↔ zod 양방향(app-patterns §2) — 한쪽 필드명만 바꾸면 tsc가 잡는다
const requestMatchesSchema: [ToeicFrameDrillSessionRequest, BodyInput] extends [BodyInput, ToeicFrameDrillSessionRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicFrameDrillSessionResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "연습 기록을 저장할 수 없어요.", issues: toToeicIssues(parsed.error.issues, 20) }, 400);
  }
  const b = parsed.data;
  const session: ToeicFrameDrillSession = {
    part: b.part,
    topicKeys: b.topicKeys,
    questionTypeKeys: b.questionTypeKeys,
    excludedFrameKeys: b.excludedFrameKeys,
    requested: b.requested,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    ended: b.ended,
    items: b.items.map((it) => {
      const o = it.outcome === "transcribe_failed" ? frameDrillOutcomeOf(null, true) : frameDrillOutcomeOf(it.transcript, false);
      return { itemId: it.itemId, frameKey: it.frameKey, ko: it.ko, en: it.en, frame: it.frame, outcome: o.outcome, transcript: o.transcript, verdict: null, reasonKo: null, fixedEn: null };
    }),
    review: null,
    statsAppliedAt: null,
    supply: null,
  };

  try {
    const { record, reused } = await getStore().createToeicFrameDrillSession(toeicFrameDrillSessionDocId(b.clientSessionId), session);
    const spoken = record.items.filter((it) => it.outcome === "spoken").length;
    console.log(`[/api/toeic/frame-drill/sessions] ${b.part} 문항 ${record.items.length}(말함 ${spoken}) · ${reused ? "다시 저장(그대로)" : "새로 저장"}`);
    return json({ ok: true, id: record.id, reused });
  } catch (err) {
    const why = err instanceof SyntaxError ? err.name : err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown";
    console.error("[/api/toeic/frame-drill/sessions] 저장 실패:", why);
    return json({ ok: false, error: "save_failed", messageKo: "연습 기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

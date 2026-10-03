/**
 * POST /api/toeic/island — 🏝️ 나만의 답변 섬에 **담기** (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * 담는 길 셋(AI 호출 0 — 키 검사 없음, 키가 없어도 담긴다):
 * - `origin.kind = "frame_drill"` {sessionId, index} — 🗣️ 틀 말하기 결과의 한 문항. **서버가 저장된 판에서** 글자를 만든다
 *   (섬 문장 = 고친 문장, 없으면 모범 영어 · 한국어 단서 = 한글 문장 · 내가 말한 문장 = 전사 · 틀 key · 소재 = 그 틀의 소재).
 * - `origin.kind = "attempt"` {attemptId, q, fixIndex} — 모의고사 결과 Q5–7·Q11의 개선 답변(fixIndex null) 또는 고친 문장.
 *   서버가 응시 기록·모의고사에서 글자를 만든다. 소재는 요청의 topicKey(칩) — 없으면(undefined) 문장에 쓰인 틀의 소재 추천.
 * - `origin.kind = "manual"` {clientId} + part·en(+ko·topicKey) — 섬 화면에서 직접 쓰기.
 * 클라이언트가 보낸 글자를 원본 대신 믿지 않는다(직접 쓰기만 예외 — 그게 원본이다).
 *
 * 멱등: 문서 id = 원본 키(islandDocId). 같은 원본을 두 번 담으면 쓰지 않고 그 항목(reused:true). 생성이라 prod-guard 무관.
 * 로그: 종류·유형·길이만(문장 없음).
 *
 * 응답 shape (단일 정의처 `lib/toeic-island-contract.ts` ToeicIslandCreateResponse):
 * - 200 { ok:true, entry, reused }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues } · { error:"too_long" }
 * - 404 { ok:false, error:"source_not_found", messageKo }
 * - 422 { ok:false, error:"unsupported_part", messageKo }       ← Q5–7·Q11 밖 문항
 * - 409 { ok:false, error:"full", messageKo }                   ← 섬 문장 상한
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { ToeicTemplate } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { buildToeicQuestionViews } from "@/lib/toeic-attempt-contract";
import { frameDrillFramesForPart, type ToeicFrameDrillBank } from "@/lib/toeic-frame-drill";
import { TOEIC_TEMPLATE_BANK_ID } from "@/lib/toeic-guide";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import {
  TOEIC_ISLAND_CLIENT_ID_RE,
  TOEIC_ISLAND_EN_MAX,
  TOEIC_ISLAND_ENTRIES_MAX,
  TOEIC_ISLAND_KO_MAX,
  TOEIC_ISLAND_PARTS,
  TOEIC_ISLAND_TOPIC_KEY_RE,
  buildIslandFromAttempt,
  buildIslandFromFrameDrill,
  cleanIslandText,
  islandDocId,
  resolveIslandTopic,
  suggestIslandTopic,
  type ToeicIslandDraft,
  type ToeicIslandDraftResult,
  type ToeicIslandEntry,
  type ToeicIslandPart,
} from "@/lib/toeic-island";
import type { ToeicIslandCreateRequest, ToeicIslandCreateResponse } from "@/lib/toeic-island-contract";
import { isRenderableToeicMock, isRenderableToeicTemplateBank } from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const topicKey = z.union([z.string().regex(TOEIC_ISLAND_TOPIC_KEY_RE, "소재 key 형식이 아니에요"), z.null()]).optional();
const ko = z.union([z.string().max(TOEIC_ISLAND_KO_MAX * 2), z.null()]).optional();

const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame_drill"), sessionId: z.string().min(1).max(80), index: z.number().int().min(0).max(99) }),
  z.object({ kind: z.literal("attempt"), attemptId: z.string().min(1).max(80), q: z.number().int().min(1).max(11), fixIndex: z.union([z.number().int().min(0).max(9), z.null()]) }),
  z.object({ kind: z.literal("manual"), clientId: z.string().regex(TOEIC_ISLAND_CLIENT_ID_RE, "clientId 형식이 아니에요") }),
]);

const bodySchema = z.object({
  origin: originSchema,
  topicKey,
  ko,
  part: z.enum(TOEIC_ISLAND_PARTS).optional(),
  en: z.string().max(TOEIC_ISLAND_EN_MAX * 2).optional(),
});

type BodyInput = z.infer<typeof bodySchema>;
// 요청 계약 ↔ zod 양방향(app-patterns §2)
const requestMatchesSchema: [ToeicIslandCreateRequest, BodyInput] extends [BodyInput, ToeicIslandCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicIslandCreateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

const DRAFT_FAIL: Record<Exclude<ToeicIslandDraftResult, { ok: true }>["reason"], { status: number; body: ToeicIslandCreateResponse }> = {
  not_found: { status: 404, body: { ok: false, error: "source_not_found", messageKo: "담을 문장을 찾지 못했어요. 화면을 새로 고쳐 주세요." } },
  empty: { status: 404, body: { ok: false, error: "source_not_found", messageKo: "이 문항에는 담을 문장이 없어요." } },
  part: { status: 422, body: { ok: false, error: "unsupported_part", messageKo: "답변 섬은 Q5–7·Q11 문항만 담아요." } },
  too_long: { status: 400, body: { ok: false, error: "too_long", messageKo: `섬 문장이 너무 길어요(${TOEIC_ISLAND_EN_MAX}자까지).` } },
};

async function loadBank(): Promise<ToeicFrameDrillBank | null> {
  return getStore().getToeicFrameDrillBank().catch(() => null);
}

async function loadGuideTemplates(part: ToeicIslandPart): Promise<Pick<ToeicTemplate, "key" | "frameEn">[]> {
  try {
    const bank = await getStore().getToeicSet(TOEIC_TEMPLATE_BANK_ID);
    if (bank === null || !isRenderableToeicTemplateBank(bank)) return [];
    const doc = bank.guide as { items: unknown[] };
    return guideTemplatesForPart(doc.items, part).templates;
  } catch {
    return [];
  }
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
    return json({ ok: false, error: "invalid_input", messageKo: "섬에 담을 수 없어요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }
  const b = parsed.data;
  const id = islandDocId(b.origin);
  if (id === null) return json({ ok: false, error: "invalid_input", messageKo: "담을 원본 형식이 아니에요.", issues: [{ path: "origin", message: "원본 키 형식" }] }, 400);

  const store = getStore();
  try {
    // 이미 담긴 원본 — 원본을 다시 읽지 않고 그 항목을 돌려준다(두 번 눌러도 한 개)
    const existing = await store.getToeicIslandEntry(id);
    if (existing) return json({ ok: true, entry: existing, reused: true });

    const bank = await loadBank();
    let draft: ToeicIslandDraft;
    if (b.origin.kind === "manual") {
      const en = cleanIslandText(b.en);
      if (!b.part || en === null) return json({ ok: false, error: "invalid_input", messageKo: "유형과 영어 문장을 적어 주세요.", issues: [{ path: en === null ? "en" : "part", message: "필수" }] }, 400);
      if (en.length > TOEIC_ISLAND_EN_MAX) return json(DRAFT_FAIL.too_long.body, 400);
      const frames = bank ? frameDrillFramesForPart(bank, b.part) : [];
      draft = {
        part: b.part,
        en,
        ko: null,
        spokenEn: null,
        question: null,
        frameKey: null,
        origin: b.origin,
        suggestedTopicKey: suggestIslandTopic(en, frames, await loadGuideTemplates(b.part)),
      };
    } else if (b.origin.kind === "frame_drill") {
      const session = await store.getToeicFrameDrillSession(b.origin.sessionId);
      if (!session) return json(DRAFT_FAIL.not_found.body, 404);
      const r = buildIslandFromFrameDrill(session, b.origin.sessionId, b.origin.index, bank?.frames ?? []);
      if (!r.ok) return json(DRAFT_FAIL[r.reason].body, DRAFT_FAIL[r.reason].status);
      draft = r.draft;
    } else {
      const attempt = await store.getToeicAttempt(b.origin.attemptId);
      const mock = attempt ? await store.getToeicMock(attempt.mockId) : null;
      if (!attempt || !mock || !isRenderableToeicMock(mock)) return json(DRAFT_FAIL.not_found.body, 404);
      const q = b.origin.q;
      const view = buildToeicQuestionViews(mock.parts, attempt.questions).find((v) => v.q === q);
      const answer = attempt.answers.find((a) => a.q === q) ?? null;
      if (!view) return json(DRAFT_FAIL.not_found.body, 404);
      const r = buildIslandFromAttempt({
        attemptId: attempt.id,
        q,
        fixIndex: b.origin.fixIndex,
        mockPart: view.part,
        question: view.question ?? null,
        transcript: answer?.transcript ?? null,
        feedback: answer?.feedback ?? null,
      });
      if (!r.ok) return json(DRAFT_FAIL[r.reason].body, DRAFT_FAIL[r.reason].status);
      const frames = bank ? frameDrillFramesForPart(bank, r.draft.part) : [];
      draft = { ...r.draft, suggestedTopicKey: suggestIslandTopic(r.draft.en, frames, await loadGuideTemplates(r.draft.part)) };
    }

    // 소재 — 요청이 고른 것(null = 소재 없음), 안 골랐으면(undefined) 추천
    const topics = bank?.topics ?? [];
    const topic = resolveIslandTopic(b.topicKey !== undefined ? b.topicKey : draft.suggestedTopicKey, topics);
    if (!topic.ok) return json({ ok: false, error: "invalid_input", messageKo: "소재 형식이 아니에요.", issues: [{ path: "topicKey", message: "형식" }] }, 400);
    // 한국어 단서 — 요청이 준 메모(빈 값이면 null), 안 줬으면 원본의 한글 문장
    let koText = draft.ko;
    if (b.ko !== undefined) {
      koText = cleanIslandText(b.ko);
      if (koText !== null && koText.length > TOEIC_ISLAND_KO_MAX) return json({ ok: false, error: "too_long", messageKo: `한국어 메모가 너무 길어요(${TOEIC_ISLAND_KO_MAX}자까지).` }, 400);
    }

    const nowIso = new Date().toISOString();
    const entry: ToeicIslandEntry = {
      id,
      part: draft.part,
      topicKey: topic.topicKey,
      topicNameKo: topic.topicNameKo,
      en: draft.en,
      ko: koText,
      spokenEn: draft.spokenEn,
      question: draft.question,
      frameKey: draft.frameKey,
      origin: draft.origin,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    // 상한 검사는 저장소 원자 단위 안에서(동시 담기가 상한을 넘지 않게 — QA common_review_1 P3-E). 이미 담긴 원본은 상한과 무관하게 reused
    const { record, reused, full } = await store.createToeicIslandEntry(entry, TOEIC_ISLAND_ENTRIES_MAX);
    if (full) return json({ ok: false, error: "full", messageKo: `섬이 가득 찼어요(${TOEIC_ISLAND_ENTRIES_MAX}개). 안 쓰는 문장을 지워 주세요.` }, 409);
    console.log(`[/api/toeic/island] ${b.origin.kind} · ${record.part} · ${record.en.length}자 · ${reused ? "이미 있음(그대로)" : "새로 담음"}`);
    return json({ ok: true, entry: record, reused });
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown";
    console.error("[/api/toeic/island] 담기 실패:", why);
    return json({ ok: false, error: "save_failed", messageKo: "섬에 담지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

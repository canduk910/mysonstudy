/**
 * PATCH·DELETE /api/toeic/island/[id] — 🏝️ 답변 섬 문장 하나 편집·삭제 (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * - PATCH 본문 {en?, ko?, topicKey?, part?} — 바꾼 칸만 덮는다(applyIslandPatch). 섬 문장을 비우거나 상한을 넘으면 400.
 *   판정은 원자 단위 안에서(파일 mutate · Firestore runTransaction). 수정이라 prod-guard 무관. AI·키 검사 없음.
 * - DELETE — 딸린 것 없음. **삭제라 prod-guard**(`deleteToeicIslandEntry` — 개발 환경에서 Firestore면 403).
 *
 * 응답 shape (단일 정의처 `lib/toeic-island-contract.ts`):
 * - PATCH 200 { ok:true, entry } · 400 invalid_input|too_long · 404 not_found · 500 save_failed
 * - DELETE 200 { ok:true } · 400 invalid_input · 404 not_found · 403 prod_guard · 500 delete_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore } from "@/lib/store";
import {
  TOEIC_ISLAND_EN_MAX,
  TOEIC_ISLAND_KO_MAX,
  TOEIC_ISLAND_PARTS,
  TOEIC_ISLAND_TOPIC_KEY_RE,
  applyIslandPatch,
  isToeicIslandDocId,
  resolveIslandTopic,
  type IslandPatch,
} from "@/lib/toeic-island";
import type { ToeicIslandDeleteResponse, ToeicIslandPatchRequest, ToeicIslandPatchResponse } from "@/lib/toeic-island-contract";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

const patchSchema = z
  .object({
    en: z.string().max(TOEIC_ISLAND_EN_MAX * 2).optional(),
    ko: z.union([z.string().max(TOEIC_ISLAND_KO_MAX * 2), z.null()]).optional(),
    topicKey: z.union([z.string().regex(TOEIC_ISLAND_TOPIC_KEY_RE, "소재 key 형식이 아니에요"), z.null()]).optional(),
    part: z.enum(TOEIC_ISLAND_PARTS).optional(),
  })
  .refine((o) => o.en !== undefined || o.ko !== undefined || o.topicKey !== undefined || o.part !== undefined, "바꿀 칸이 없어요");

type PatchInput = z.infer<typeof patchSchema>;
const requestMatchesSchema: [ToeicIslandPatchRequest, PatchInput] extends [PatchInput, ToeicIslandPatchRequest] ? true : never = true;
void requestMatchesSchema;

export async function PATCH(req: Request, ctx: Ctx) {
  const json = (body: ToeicIslandPatchResponse, status = 200) => NextResponse.json(body, { status });
  const { id } = await ctx.params;
  if (!isToeicIslandDocId(id)) return json({ ok: false, error: "not_found", messageKo: "그 문장을 찾지 못했어요." }, 404);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = patchSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) return json({ ok: false, error: "invalid_input", messageKo: "고칠 수 없어요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  const b = parsed.data;

  const store = getStore();
  try {
    const topics = b.topicKey !== undefined ? ((await store.getToeicFrameDrillBank().catch(() => null))?.topics ?? []) : [];
    const nowIso = new Date().toISOString();
    type R = { ok: true; entry: import("@/lib/toeic-island").ToeicIslandEntry } | { ok: false; reason: "empty" | "too_long" | "topic" };
    const r = await store.updateToeicIslandEntry<R>(id, (cur) => {
      const patch: IslandPatch = {};
      if (b.en !== undefined) patch.en = b.en;
      if (b.ko !== undefined) patch.ko = b.ko;
      if (b.part !== undefined) patch.part = b.part;
      if (b.topicKey !== undefined) {
        const t = resolveIslandTopic(b.topicKey, topics, cur.topicKey === b.topicKey ? cur.topicNameKo : null);
        if (!t.ok) return { entry: null, result: { ok: false, reason: "topic" } };
        patch.topicKey = t.topicKey;
        patch.topicNameKo = t.topicNameKo;
      }
      const a = applyIslandPatch(cur, patch, nowIso);
      if (!a.ok) return { entry: null, result: { ok: false, reason: a.reason } };
      return { entry: a.changed ? a.entry : null, result: { ok: true, entry: a.entry } };
    });
    if (r === null) return json({ ok: false, error: "not_found", messageKo: "그 문장을 찾지 못했어요." }, 404);
    if (!r.ok) {
      if (r.reason === "too_long") return json({ ok: false, error: "too_long", messageKo: `너무 길어요(영어 ${TOEIC_ISLAND_EN_MAX}자 · 메모 ${TOEIC_ISLAND_KO_MAX}자까지).` }, 400);
      if (r.reason === "empty") return json({ ok: false, error: "invalid_input", messageKo: "영어 문장을 비울 수 없어요.", issues: [{ path: "en", message: "필수" }] }, 400);
      return json({ ok: false, error: "invalid_input", messageKo: "소재 형식이 아니에요.", issues: [{ path: "topicKey", message: "형식" }] }, 400);
    }
    return json({ ok: true, entry: r.entry });
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown";
    console.error("[/api/toeic/island/[id]] 편집 실패:", why);
    return json({ ok: false, error: "save_failed", messageKo: "고치지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const json = (body: ToeicIslandDeleteResponse, status = 200) => NextResponse.json(body, { status });
  const { id } = await ctx.params;
  if (!isToeicIslandDocId(id)) return json({ ok: false, error: "invalid_input", messageKo: "그 문장을 찾지 못했어요." }, 400);
  try {
    const ok = await getStore().deleteToeicIslandEntry(id);
    if (!ok) return json({ ok: false, error: "not_found", messageKo: "이미 지워진 문장이에요." }, 404);
    console.log("[/api/toeic/island/[id]] 지움");
    return json({ ok: true });
  } catch (err) {
    if (isProdGuardError(err)) return json({ ok: false, error: "prod_guard", messageKo: "개발 환경에서는 실데이터를 지울 수 없어요." }, 403);
    const why = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown";
    console.error("[/api/toeic/island/[id]] 삭제 실패:", why);
    return json({ ok: false, error: "delete_failed", messageKo: "지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

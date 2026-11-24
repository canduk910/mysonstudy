/**
 * POST /api/japanese/speaking/mocks — 🎙️ 일본어 말하기 모의고사 만들기 (docs/harness/japanese.md §15-3·§15-10-1, 호출 E1~E5)
 *
 * - 고른 파트마다 **호출 하나**를 `Promise.allSettled`로 병렬(요청 하나가 60초를 넘지 않게 파트로 쪼갠다 — 토익 C1~C5와 같은 모양).
 *   실패한 파트는 null로 저장하고 `failedParts`로 알린다(부분 성공 — 학습 보기의 "이 파트 만들기"가 채운다). **고른 파트가 전부 실패할 때만**
 *   500이고 그때는 저장하지 않는다(빈 모의고사를 남기지 않는다).
 * - 모델은 메인 기본(`resolveModel()` — 토익 출제 모델이 아니다, §15-0). 진입 함수 `generateJaSpeakingPart`(lib/ai/client.ts).
 * - 주제 힌트는 `normalizeJaSpeakingTopicHints` 결과를 그대로 저장한다(호출 E가 받은 것 = 저장 — 파트 다시 만들기가 같은 입력).
 * - E2(picture)는 `items[i].image = {pending}` — 사진은 학습 보기 화면이 `POST [id]/image`로 한 장씩 따로 요청한다(§15-7).
 *
 * 키 검사(501)는 **가장 먼저**(키를 비운 로컬에서 실호출이 구조적으로 불가능).
 *
 * 응답 shape (단일 정의처 `lib/ja-speaking-contract.ts` JaSpeakingCreateResponse):
 * - 200 { ok:true, id, titleKo, createdParts, failedParts }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }   ← 고른 파트 전부 실패(저장 안 함)
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { hasLlmKey } from "@/lib/ai/provider";
import { z } from "zod";
import { captureLlmMeta, generateJaSpeakingPart, resolveModel } from "@/lib/ai/client";
import { answeredModel } from "@/lib/ai/provider";
import { JLPT_LEVELS } from "@/lib/ai/japanese/schemas";
import { normalizeJaSpeakingTopicHints } from "@/lib/ai/japanese/speaking-prompts";
import { JA_SPEAKING_LIMITS } from "@/lib/ai/japanese/speaking-schemas";
import { JA_SPEAKING_PARTS, type JaSpeakingPart } from "@/lib/ja-speaking";
import { nextJaSpeakingTitle, type JaSpeakingCreateRequest, type JaSpeakingCreateResponse } from "@/lib/ja-speaking-contract";
import type { JaSpeakingParts } from "@/lib/ja-speaking-record";
import { getStore } from "@/lib/store";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  level: z.enum(JLPT_LEVELS),
  parts: z
    .array(z.enum(JA_SPEAKING_PARTS))
    .min(1, "만들 파트를 하나 이상 골라 주세요")
    .max(JA_SPEAKING_PARTS.length)
    .refine((ps) => new Set(ps).size === ps.length, "같은 파트를 두 번 고를 수 없어요")
    .optional(),
  topicHints: z
    .array(
      z
        .string()
        .transform((s) => s.replace(/\s+/g, " ").trim())
        .pipe(z.string().min(1, "빈 주제는 넣을 수 없어요").max(JA_SPEAKING_LIMITS.topicHintMax, `주제는 ${JA_SPEAKING_LIMITS.topicHintMax}자까지예요`)),
    )
    .max(JA_SPEAKING_LIMITS.topicHintsMax, `주제 힌트는 최대 ${JA_SPEAKING_LIMITS.topicHintsMax}개예요`)
    .optional(),
});

// 요청 계약 ↔ zod 양방향 묶기
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [JaSpeakingCreateRequest, BodyInput] extends [BodyInput, JaSpeakingCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: JaSpeakingCreateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  if (!hasLlmKey()) {
    return json({ ok: false, error: "no_api_key", messageKo: "AI API 키가 아직 설정되지 않아 모의고사를 만들 수 없어요." }, 501);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: parsed.error.issues[0]?.message ?? "만들기 설정을 확인해 주세요.",
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }
  const { level } = parsed.data;
  const requested = parsed.data.parts ?? [...JA_SPEAKING_PARTS];
  // 형식표 순서로(응답·로그가 늘 같은 순서)
  const chosen = JA_SPEAKING_PARTS.filter((p) => requested.includes(p));
  const topicHints = normalizeJaSpeakingTopicHints(parsed.data.topicHints ?? []);

  const store = getStore();
  let existingTitles: string[];
  try {
    existingTitles = (await store.listJaSpeakingMocks()).map((m) => m.titleKo);
  } catch (err) {
    console.error("[/api/japanese/speaking/mocks] 목록 읽기 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "모의고사 목록을 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  console.info(`[/api/japanese/speaking/mocks] 입력: 레벨 ${level} · 파트 ${chosen.length} · 주제 ${topicHints.length}`);
  const { value: settled, calls: llmCalls } = await captureLlmMeta(() => Promise.allSettled(chosen.map((part) => generateJaSpeakingPart(part, { level, topicHints }))));

  const parts: JaSpeakingParts = { read: null, picture: null, respond: null, info: null, opinion: null };
  const createdParts: JaSpeakingPart[] = [];
  const failedParts: JaSpeakingPart[] = [];
  settled.forEach((r, i) => {
    const part = chosen[i];
    if (r.status === "fulfilled") {
      (parts as Record<JaSpeakingPart, unknown>)[part] = r.value;
      createdParts.push(part);
    } else {
      failedParts.push(part);
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[/api/japanese/speaking/mocks] 파트 ${part} 실패:`, message.slice(0, 300));
    }
  });

  if (createdParts.length === 0) {
    return json({ ok: false, error: "ai_failed", messageKo: "모의고사를 만들지 못했어요. 잠시 후 다시 시도해 주세요.", retriable: true }, 500);
  }

  try {
    const record = await store.createJaSpeakingMock({
      titleKo: nextJaSpeakingTitle(existingTitles),
      level,
      topicHints,
      parts,
      model: answeredModel(llmCalls, resolveModel()), // 실제 답한 모델(공급자 층 2단계)
    });
    return json({ ok: true, id: record.id, titleKo: record.titleKo, createdParts, failedParts });
  } catch (err) {
    console.error("[/api/japanese/speaking/mocks] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "모의고사를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * POST /api/toeic/mocks — 모의고사 만들기 (docs/harness/toeic.md §4-0·§7-2, 호출 C1~C5)
 *
 * - 고른 파트마다 **호출 하나**를 `Promise.allSettled`로 병렬(요청 하나가 60초를 넘지 않게 파트로 쪼갠다, §1-1). 실패한 파트는
 *   null로 저장하고 `failedParts`로 사실대로 알린다(부분 성공 — 학습 보기의 "이 파트 다시 만들기"가 채운다). **고른 파트가
 *   전부 실패할 때만** 500이고 그때는 저장하지 않는다(빈 모의고사를 남기지 않는다).
 * - 활용할 표현(§4-0): 표현집 전 세트 + 전 시험 세션에서 `pickExpressionsForMock`(최대 24개, 숙련도 낮은 것 우선) →
 *   `normalizeMockExpressions` 결과를 호출 C에 넘기고 **같은 목록을** `expressionsUsed`로 저장한다(보낸 목록 = 저장 목록 —
 *   호출 D의 입력). 표현집이 비면 "없음".
 * - 주제 힌트: 화면이 고른 것(표현집 세트 주제 칩 + 직접 입력)만 쓴다. 공백 정리·중복 제거 뒤 `topicHints`로 저장한다
 *   (파트 다시 만들기가 같은 입력을 쓰게).
 * - C2(picture)는 `items[i].image = {pending}`으로 저장된다 — 사진은 화면이 `POST [id]/image`로 한 장씩 따로 요청한다(§4-10).
 *
 * 키 검사(501)는 **가장 먼저**(판독 라우트와 같은 규약 — 키를 비운 로컬에서 실호출이 구조적으로 불가능).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-mock-contract.ts` ToeicMockCreateResponse):
 * - 200 { ok:true, id, titleKo, createdParts, failedParts, expressionsCount }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }   ← 고른 파트 전부 실패(저장 안 함)
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveModel } from "@/lib/ai/client";
import { generateMockPart } from "@/lib/ai/toeic/calls";
import { pickExpressionsForMock } from "@/lib/ai/toeic/mock";
import { normalizeMockExpressions } from "@/lib/ai/toeic/prompts";
import type { ToeicMockParts } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import {
  TOEIC_MOCK_TOPIC_HINTS_MAX,
  TOEIC_MOCK_TOPIC_HINT_MAX_CHARS,
  nextToeicMockTitle,
  type ToeicMockCreateRequest,
  type ToeicMockCreateResponse,
} from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, TOEIC_TARGET_GRADES, type ToeicMockPart } from "@/lib/toeic-mock";
import { isRenderableToeicSet } from "@/lib/toeic-record";
import { collapseSpaces } from "@/lib/toeic-text";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({
  targetGrade: z.enum(TOEIC_TARGET_GRADES),
  parts: z
    .array(z.enum(TOEIC_MOCK_PARTS))
    .min(1, "만들 파트를 하나 이상 골라 주세요")
    .max(TOEIC_MOCK_PARTS.length)
    .refine((ps) => new Set(ps).size === ps.length, "같은 파트를 두 번 고를 수 없어요"),
  topicHints: z
    .array(
      z
        .string()
        .transform(collapseSpaces)
        .pipe(z.string().min(1, "빈 주제는 넣을 수 없어요").max(TOEIC_MOCK_TOPIC_HINT_MAX_CHARS, `주제는 ${TOEIC_MOCK_TOPIC_HINT_MAX_CHARS}자까지예요`)),
    )
    .max(TOEIC_MOCK_TOPIC_HINTS_MAX, `주제 힌트는 최대 ${TOEIC_MOCK_TOPIC_HINTS_MAX}개예요`),
});

// 요청 계약 ↔ zod 양방향 묶기
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicMockCreateRequest, BodyInput] extends [BodyInput, ToeicMockCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicMockCreateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 대소문자 무시 중복 제거(등장 순서 유지) — 호출 C 사용자 메시지의 주제 정리(buildMockUserMessage)와 같은 결과를 저장한다 */
function dedupeHints(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of list) {
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "OpenAI API 키가 아직 설정되지 않아 모의고사를 만들 수 없어요. 표현집은 그대로 쓸 수 있어요.",
      },
      501,
    );
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
  const { targetGrade } = parsed.data;
  // 형식표 순서로(응답·로그가 늘 같은 순서)
  const chosen = TOEIC_MOCK_PARTS.filter((p) => parsed.data.parts.includes(p));
  const topicHints = dedupeHints(parsed.data.topicHints);

  const store = getStore();
  let expressions: string[];
  let existingTitles: string[];
  try {
    const [sets, sessions, mocks] = await Promise.all([
      store.listToeicSets(),
      store.listAllToeicQuizzes(),
      store.listToeicMocks(),
    ]);
    expressions = normalizeMockExpressions(pickExpressionsForMock(sets.filter(isRenderableToeicSet), sessions));
    existingTitles = mocks.map((m) => m.titleKo);
  } catch (err) {
    console.error("[/api/toeic/mocks] 표현집 읽기 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "표현집을 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  const input = { targetGrade, topicHints, expressions };
  const settled = await Promise.allSettled(chosen.map((part) => generateMockPart(part, input)));

  const parts: ToeicMockParts = { read: null, picture: null, respond: null, info: null, opinion: null };
  const createdParts: ToeicMockPart[] = [];
  const failedParts: ToeicMockPart[] = [];
  settled.forEach((r, i) => {
    const part = chosen[i];
    if (r.status === "fulfilled") {
      (parts as Record<ToeicMockPart, unknown>)[part] = r.value;
      createdParts.push(part);
    } else {
      failedParts.push(part);
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[/api/toeic/mocks] 파트 ${part} 실패:`, message.slice(0, 300));
    }
  });

  if (createdParts.length === 0) {
    return json(
      { ok: false, error: "ai_failed", messageKo: "모의고사를 만들지 못했어요. 잠시 후 다시 시도해 주세요.", retriable: true },
      500,
    );
  }

  try {
    const record = await store.createToeicMock({
      titleKo: nextToeicMockTitle(existingTitles),
      targetGrade,
      expressionsUsed: expressions,
      topicHints,
      parts,
      model: resolveModel(),
    });
    return json({
      ok: true,
      id: record.id,
      titleKo: record.titleKo,
      createdParts,
      failedParts,
      expressionsCount: expressions.length,
    });
  } catch (err) {
    console.error("[/api/toeic/mocks] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "모의고사를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

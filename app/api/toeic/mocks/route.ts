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
 * - **답변 흐름**(§12-13-3 — 2026-10-02): 틀 은행(`guide-templates`)은 **이미 읽는 `listToeicSets()` 결과에서** id로 찾아
 *   `isRenderableToeicTemplateBank`로 본다(읽기를 하나 더하지 않는다). read를 뺀 **네 파트 전부**(고른 파트와 상관없이)의 흐름을
 *   `buildMockAnswerFlows`(순서 "flow")로 만들고, 호출 C에는 **고른 파트의 흐름만 파트마다** 넘긴다(read는 null — 흐름 규칙이 붙지 않는다).
 *   문서 `answerFlows`에는 흐름이 나온 파트 전부를 저장한다 — 나중의 "이 파트 만들기"(고르지 않은 파트)·다시 만들기·채점(호출 D)이 같은 흐름을
 *   쓴다. 틀 은행이 없거나 렌더 불가면 흐름 [] → 옛 요청 그대로. 흐름 만들기가 던지면 그 파트(또는 전부) 흐름 없이 계속한다 — 흐름 때문에
 *   모의고사를 실패시키지 않는다(§0-4). 로그는 개수·예외 이름만(틀 글자를 싣지 않는다 — 공개 저장소).
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
import { resolveToeicModel } from "@/lib/ai/toeic/model";
import { generateMockPart } from "@/lib/ai/toeic/calls";
import { pickExpressionsForMock } from "@/lib/ai/toeic/mock";
import { normalizeMockExpressions } from "@/lib/ai/toeic/prompts";
import type { ToeicAnswerFlow, ToeicMockParts, ToeicTemplate, ToeicTemplateFlow } from "@/lib/ai/toeic/schemas";
import { getStore, type ToeicSetRecord } from "@/lib/store";
import { TOEIC_GUIDE_PARTS, TOEIC_TEMPLATE_BANK_ID, type ToeicGuidePart } from "@/lib/toeic-guide";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import {
  TOEIC_MOCK_TOPIC_HINTS_MAX,
  TOEIC_MOCK_TOPIC_HINT_MAX_CHARS,
  nextToeicMockTitle,
  type ToeicMockCreateRequest,
  type ToeicMockCreateResponse,
} from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, TOEIC_TARGET_GRADES, type ToeicMockPart } from "@/lib/toeic-mock";
import { isToeicQuizModeSession } from "@/lib/toeic-quiz";
import { isRenderableToeicSet, isRenderableToeicTemplateBank, isToeicDrill, isToeicGuideSet } from "@/lib/toeic-record";
import { buildMockAnswerFlows } from "@/lib/toeic-template";
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

/** 오류 이름만(메시지에 파일 글이 실릴 수 있는 SyntaxError 등은 이름만 — 공개 저장소·로그) */
function errName(err: unknown): string {
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  return String(err).slice(0, 200);
}

/**
 * 답변 흐름(§12-13-3) — 이미 읽은 세트 목록에서 틀 은행을 찾아 read를 뺀 네 파트 흐름 전부(순서 "flow"). 틀 은행이 없거나 렌더 불가면 [].
 * 한 파트의 흐름 만들기가 던지면 그 파트만 빠지고(buildMockAnswerFlows onError), 그 밖의 예외는 흐름 전부 없이 — 모의고사를 실패시키지 않는다.
 */
function mockAnswerFlowsFrom(sets: readonly ToeicSetRecord[]): ToeicAnswerFlow[] {
  try {
    const bank = sets.find((s) => s.id === TOEIC_TEMPLATE_BANK_ID) ?? null;
    if (bank === null || !isRenderableToeicTemplateBank(bank)) return [];
    const bankDoc = bank.guide as { flows: ToeicTemplateFlow[]; items: unknown[] };
    const templatesByPart = Object.fromEntries(TOEIC_GUIDE_PARTS.map((p) => [p, guideTemplatesForPart(bankDoc.items, p).templates])) as Record<
      ToeicGuidePart,
      ToeicTemplate[]
    >;
    return buildMockAnswerFlows(bankDoc, templatesByPart, (part, err) => {
      console.error(`[/api/toeic/mocks] 답변 흐름 실패(${part}) — 그 파트는 흐름 없이:`, errName(err));
    });
  } catch (err) {
    console.error("[/api/toeic/mocks] 답변 흐름 실패 — 흐름 없이 계속:", errName(err));
    return [];
  }
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
  let answerFlows: ToeicAnswerFlow[];
  try {
    const [sets, sessions, mocks] = await Promise.all([
      store.listToeicSets(),
      store.listAllToeicQuizzes(),
      store.listToeicMocks(),
    ]);
    // 실전 모의고사의 활용할 표현은 **표현집만**(§12-3 표·§12-12 1): 공략 계열(유형 공략·틀 은행)을 빼고, 숙련도를 매기는 시험 세션도
    // 표현집 세트의 것만(setId ∈ 표현집) + 표현 시험 모드만(레코드 mode는 틀 테스트 모드까지 넓다 — "모드 타입 넓히기"). 통계 키가
    // 표현 문자열이라 공략 시험 세션이 섞이면 같은 글자의 표현집 표현 순위가 바뀐다.
    const bookSets = sets.filter((s) => !isToeicGuideSet(s)).filter(isRenderableToeicSet);
    const bookSetIds = new Set(bookSets.map((s) => s.id));
    const bookSessions = sessions.filter(isToeicQuizModeSession).filter((q) => bookSetIds.has(q.setId));
    expressions = normalizeMockExpressions(pickExpressionsForMock(bookSets, bookSessions));
    // 제목 번호는 모의고사끼리만 센다 — 한 문제 연습(drillPart)은 먼저 뺀다(§12-3 표, 연습은 "{유형} 연습 n"으로 따로 센다)
    existingTitles = mocks.filter((m) => !isToeicDrill(m)).map((m) => m.titleKo);
    // 답변 흐름 — 같은 목록(sets)에서 틀 은행을 찾는다(스토어 읽기 추가 0). 고른 파트로 거르지 않는다(검토 B1)
    answerFlows = mockAnswerFlowsFrom(sets);
  } catch (err) {
    console.error("[/api/toeic/mocks] 표현집 읽기 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "표현집을 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  // 파트마다 입력이 다르다 — 목표 등급·주제 힌트·활용할 표현은 같고 흐름만 그 파트 것(read는 늘 null)
  const flowOf = (part: ToeicMockPart): ToeicAnswerFlow | null => (part === "read" ? null : (answerFlows.find((f) => f.part === part) ?? null));
  console.info(
    `[/api/toeic/mocks] 입력: 파트 ${chosen.length} · 활용할 표현 ${expressions.length} · 답변 흐름 ${answerFlows
      .map((f) => `${f.part} 흐름 단계 ${f.steps.length} · 틀 ${f.steps.reduce((n, st) => n + st.frames.length, 0) + f.banks.length}`)
      .join(" / ") || "없음"}`,
  );
  const settled = await Promise.allSettled(
    chosen.map((part) => generateMockPart(part, { targetGrade, topicHints, expressions, answerFlow: flowOf(part) })),
  );

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
      drillPart: null,
      answerFlows,
      model: resolveToeicModel(), // 출제 모델(호출 C) — OPENAI_TOEIC_MODEL
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

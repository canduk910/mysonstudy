/**
 * POST /api/toeic/guides/[part]/drills — 유형별 공략 **한 문제 연습 만들기** (docs/harness/toeic.md §12-7-1·§12-7-2·§12-7-9, SPEC §20-10)
 *
 * 본문 `{ targetGrade }`(IM3·IH·AL). 그 유형의 연습 단위(`toeicDrillUnit` — 단위표 단일 정의)로 **호출 C 파트 하나**를 부르고, 사진 묘사면
 * C2가 낸 두 장면 중 하나만(무작위 — `toDrillRecordPart`) 남겨 `toeicMocks`에 **연습 문서**(`drillPart` = 그 파트, 그 파트만 non-null)로
 * 저장한다. 사진(관문 P)은 여기서 만들지 않는다 — 화면이 같은 버튼 흐름 안에서 `POST /api/toeic/mocks/[id]/image {slot:0}`를 부른다(§12-7-3).
 *
 * - **키 검사를 맨 먼저**(501 — 키를 비운 로컬에서 실호출이 구조적으로 불가능). 그다음 `[part]`가 네 유형 밖이면 404 `part_not_found`.
 * - **주제 힌트 하나**: `pickDrillTopic`(그 유형 최근 연습 3개가 쓴 주제를 뺀 풀에서 무작위) → `topicHints: [주제]`로 호출 C에 넘기고 문서에도
 *   그대로 저장한다(프롬프트 변경 0 — §4-7 "주제 힌트" 기존 입력).
 * - **답변 흐름**(§12-13-3 — 2026-10-02): 그 유형 틀(틀 은행에서 parts로 고른 렌더 가능한 틀)로 `buildAnswerFlow(…, { order: "weakness",
 *   sessions: 틀 세션 })` — 단계마다 그 단계 틀 전부(약한 틀 먼저)·소재 틀. 호출 C의 `answerFlow` 칸으로 넘기고(흐름 규칙이 시스템 프롬프트 끝에
 *   붙는다) 문서 `answerFlows: [흐름]`에 저장한다(흐름이 null이면 []) — 채점(호출 D)이 같은 흐름을 쓴다.
 * - **활용할 표현**: `pickExpressionsForDrill`(서버 전용 lib/ai/toeic/mock.ts, 2026-10-02 새 모양 — 틀은 흐름으로 갔다) — 그 유형 공략 표현 중
 *   틀이 연결한 것·같은 자리 다른 표현(`guideExpressionKeysInFlow`)을 뺀 것 → 표현집 표현, 최대 24개. 세션은 **setId로 갈라** 넘긴다(공략 세션 =
 *   그 공략 세트, 표현집 세션 = 표현집 세트들 — 통계 키가 표현 문자열이라 섞이면 서로의 순위가 움직인다). `normalizeMockExpressions`로 정리한
 *   **같은 목록을** 호출 C에 넘기고 `expressionsUsed`로 저장한다(보낸 목록 = 저장 목록 — 호출 D의 tryExpressions가 여기서 고른다).
 *   틀 은행·공략이 아직 없으면 있는 것만(셋 다 없으면 "없음") — 연습은 공략 없이도 된다(§12-8).
 * - 제목: `nextToeicDrillTitle`("사진 묘사 연습 3" — 연습끼리·유형별 번호). 모의고사 제목 번호와 섞이지 않는다.
 * - 요청이 도중에 끊겨도(60초 상한) 서버는 저장까지 마칠 수 있다 — 화면이 목록을 다시 읽어 누른 뒤 생긴 연습이 있으면 그것을 쓴다.
 * - 로그는 개수·오류 이름만(교재·틀 글자를 싣지 않는다 — 공개 저장소·§12-2).
 *
 * 응답 shape (단일 정의처 `lib/toeic-guide-contract.ts` ToeicDrillCreateResponse):
 * - 200 { ok:true, id, titleKo, mockPart, expressionsCount }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues: {path, message}[] }   ← 깨진 JSON(issues [])·targetGrade 밖(경로·규칙만)
 * - 404 { ok:false, error:"part_not_found", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }                 ← 호출 C 실패(파트가 하나라 부분 성공 없음 — 저장 안 함)
 * - 500 { ok:false, error:"save_failed", messageKo }                               ← 스토어 읽기·저장 예외
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveToeicModel } from "@/lib/ai/toeic/model";
import { generateMockPart } from "@/lib/ai/toeic/calls";
import { pickExpressionsForDrill } from "@/lib/ai/toeic/mock";
import { normalizeMockExpressions } from "@/lib/ai/toeic/prompts";
import type { ToeicAnswerFlow, ToeicMockParts, ToeicTemplate, ToeicTemplateAlternate, ToeicTemplateFlow } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { nextToeicDrillTitle, pickDrillTopic, toDrillRecordPart, toeicDrillUnit } from "@/lib/toeic-drill";
import { TOEIC_TEMPLATE_BANK_ID, isToeicGuidePart, toeicGuideSetId } from "@/lib/toeic-guide";
import type { ToeicDrillCreateRequest, ToeicDrillCreateResponse } from "@/lib/toeic-guide-contract";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import { buildAnswerFlow, guideExpressionKeysInFlow } from "@/lib/toeic-template";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_TARGET_GRADES } from "@/lib/toeic-mock";
import { isToeicQuizModeSession } from "@/lib/toeic-quiz";
import {
  isRenderableToeicGuide,
  isRenderableToeicSet,
  isRenderableToeicTemplateBank,
  isToeicGuidePartSet,
  isToeicGuideSet,
} from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const bodySchema = z.object({ targetGrade: z.enum(TOEIC_TARGET_GRADES) });

// 요청 계약 ↔ zod 양방향 묶기
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicDrillCreateRequest, BodyInput] extends [BodyInput, ToeicDrillCreateRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicDrillCreateResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 오류 이름만(메시지에 파일 글이 실릴 수 있는 SyntaxError 등은 이름만 — 공개 저장소·로그) */
function errName(err: unknown): string {
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  return String(err).slice(0, 200);
}

export async function POST(req: Request, { params }: { params: Promise<{ part: string }> }) {
  if (!process.env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        error: "no_api_key",
        messageKo: "OpenAI API 키가 아직 설정되지 않아 연습 문제를 만들 수 없어요. 공략 읽기·템플릿 훈련은 그대로 쓸 수 있어요.",
      },
      501,
    );
  }

  const { part } = await params;
  if (!isToeicGuidePart(part)) {
    return json({ ok: false, error: "part_not_found", messageKo: "그런 유형 폴더는 없어요." }, 404);
  }
  const unit = toeicDrillUnit(part);
  if (!unit) return json({ ok: false, error: "part_not_found", messageKo: "그런 유형 폴더는 없어요." }, 404);
  const mockPart = unit.mockPart;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "목표 등급(IM3·IH·AL)을 골라 주세요.", issues: toToeicIssues(parsed.error.issues, 10) }, 400);
  }
  const { targetGrade } = parsed.data;

  // ── 입력 모으기(AI 0) — 최근 연습(주제·제목), 틀 은행·틀 세션, 공략 세트·그 세션, 표현집 세트·그 세션 ──
  const store = getStore();
  let topic: string;
  let expressions: string[];
  let answerFlow: ToeicAnswerFlow | null = null;
  let existingTitles: string[];
  try {
    const guideId = toeicGuideSetId(part);
    const [drills, sets, guideSet, bank, quizzes] = await Promise.all([
      store.listToeicDrills(mockPart),
      store.listToeicSets(),
      store.getToeicSet(guideId),
      store.getToeicSet(TOEIC_TEMPLATE_BANK_ID),
      store.listAllToeicQuizzes(),
    ]);
    topic = pickDrillTopic(
      unit.mockPart,
      drills.map((d) => d.topicHints),
    );
    existingTitles = drills.map((d) => d.titleKo);

    // 틀 — 렌더 가능한 틀 은행의 그 유형 틀(깨진 틀은 빠진다), 틀 세션(setId guide-templates)
    const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
    const bankDoc = bankOk ? (bank.guide as { flows: ToeicTemplateFlow[]; items: ToeicTemplate[]; alternates: ToeicTemplateAlternate[] }) : null;
    const templates: ToeicTemplate[] = bankDoc ? guideTemplatesForPart(bankDoc.items, part).templates : [];
    const templateSessions = quizzes.filter((q) => q.setId === TOEIC_TEMPLATE_BANK_ID);

    // 공략 — 렌더 가능한 그 유형 공략 세트와 **그 세트의** 표현 시험 세션
    const guideOk = guideSet !== null && isToeicGuidePartSet(guideSet) && isRenderableToeicSet(guideSet) && isRenderableToeicGuide(guideSet);
    const guideSessions = guideOk ? quizzes.filter(isToeicQuizModeSession).filter((q) => q.setId === guideId) : [];

    // 표현집 — 공략 계열을 뺀 렌더 가능한 세트와 setId ∈ 표현집 세트인 표현 시험 세션
    const bookSets = sets.filter((s) => !isToeicGuideSet(s)).filter(isRenderableToeicSet);
    const bookSetIds = new Set(bookSets.map((s) => s.id));
    const bookSessions = quizzes.filter(isToeicQuizModeSession).filter((q) => bookSetIds.has(q.setId));

    // 답변 흐름(§12-13-3) — 단계 안·소재 안 약한 틀 먼저. 흐름 만들기가 던지면 흐름 없이 계속한다(흐름 때문에 연습을 실패시키지 않는다)
    try {
      answerFlow = bankDoc ? buildAnswerFlow(bankDoc, mockPart, templates, { order: "weakness", sessions: templateSessions }) : null;
    } catch (err) {
      console.error(`[/api/toeic/guides/${part}/drills] 답변 흐름 실패 — 흐름 없이 계속:`, errName(err));
      answerFlow = null;
    }

    expressions = normalizeMockExpressions(
      pickExpressionsForDrill({
        guide: { set: guideOk ? guideSet : null, sessions: guideSessions, exclude: bankDoc ? guideExpressionKeysInFlow(bankDoc, part) : new Set<string>() },
        book: { sets: bookSets, sessions: bookSessions },
      }),
    );
    const flowFrames = answerFlow ? answerFlow.steps.reduce((n, st) => n + st.frames.length, 0) + answerFlow.banks.length : 0;
    console.info(
      `[/api/toeic/guides/${part}/drills] 입력: 최근 연습 ${drills.length} · 틀 ${templates.length} · 흐름 단계 ${answerFlow?.steps.length ?? 0} · 틀 ${flowFrames} · 공략 ${guideOk ? "있음" : "없음"} · 표현집 ${bookSets.length}세트 → 활용할 표현 ${expressions.length}`,
    );
  } catch (err) {
    console.error(`[/api/toeic/guides/${part}/drills] 읽기 실패:`, errName(err));
    return json({ ok: false, error: "save_failed", messageKo: "연습 자료를 읽지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  // ── 호출 C 파트 하나(프롬프트·스키마·zod·옵션 §4 그대로) → 레코드 파트 → 사진이면 한 장면만 ──
  const topicHints = [topic];
  let parts: ToeicMockParts;
  try {
    const recordPart = await generateMockPart(mockPart, { targetGrade, topicHints, expressions, answerFlow });
    parts = { read: null, picture: null, respond: null, info: null, opinion: null };
    (parts as Record<string, unknown>)[mockPart] = toDrillRecordPart(mockPart, recordPart);
  } catch (err) {
    console.error(`[/api/toeic/guides/${part}/drills] 호출 C 실패:`, errName(err));
    return json(
      {
        ok: false,
        error: "ai_failed",
        messageKo: `${toeicMockPartLabelKo(mockPart)} 연습 문제를 만들지 못했어요. 잠시 후 다시 시도해 주세요.`,
        retriable: true,
      },
      500,
    );
  }

  try {
    const record = await store.createToeicMock({
      titleKo: nextToeicDrillTitle(mockPart, existingTitles),
      targetGrade,
      expressionsUsed: expressions,
      topicHints,
      parts,
      drillPart: mockPart,
      answerFlows: answerFlow ? [answerFlow] : [],
      model: resolveToeicModel(), // 출제 모델(호출 C) — OPENAI_TOEIC_MODEL
    });
    return json({ ok: true, id: record.id, titleKo: record.titleKo, mockPart, expressionsCount: expressions.length });
  } catch (err) {
    console.error(`[/api/toeic/guides/${part}/drills] 저장 실패:`, errName(err));
    return json({ ok: false, error: "save_failed", messageKo: "연습 문제를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

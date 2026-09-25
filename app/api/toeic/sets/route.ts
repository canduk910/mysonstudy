/**
 * POST /api/toeic/sets — 검토한 표현집 초안 하나를 세트로 저장 (docs/harness/toeic.md §7-1·§8)
 *
 * 판독(`/extract`)은 저장하지 않는다. 사용자가 검토 화면에서 고친 초안을 여기서 저장한다. **AI 호출 없음**(키가 없어도
 * 저장은 되어야 한다). 발화 포인트는 저장 뒤 화면이 `/api/toeic/sets/[id]/points`를 best-effort로 부른다(§3-0).
 *
 * 검증은 판독 zod(§2-4)와 **같은 글자 규칙**을 쓴다(lib/toeic-text의 단일 판정 — 영어 칸은 라틴 포함·한글 금지, 한국어
 * 칸은 한글 포함). 사람이 고친 값이 들어오는 자리라 개수·길이만 보면 한국어 뜻이 영어 칸에 들어가 en-US로 읽히는 일이 생긴다.
 * QUIZ의 keyExpressions는 **저장 세트의 표현과 대응되는 것만** 남긴다(표현을 고치거나 뺐으면 그 참조는 버린다 — §2-4
 * 후처리 2와 같은 cleanKeyExpressions). 버린 수는 응답에 사실대로 싣는다.
 * **세트 안 같은 표현은 거부한다**(§7-1 — 대소문자·연속 공백 무시, `findDuplicateExpressionIndexes` 하나를 가져오기 zod·검토
 * 화면과 같이 쓴다). 오류는 두 번째 항목의 `entries.{i}.expression` 경로에 건다 — 어느 항목이 겹치는지 화면이 짚을 수 있게.
 * zod 기본 문구(상한·타입)는 `toeicZodErrorKo`(per-parse)로 한국어가 된다 — 화면에 영어 문구가 그대로 보이지 않게.
 *
 * 응답 shape (단일 정의처는 `lib/toeic-set-contract.ts` ToeicSetSaveResponse):
 * - 200 { ok:true, id, droppedKeyExpressions }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { cleanKeyExpressions, defaultToeicSetTitle } from "@/lib/ai/toeic/extract-merge";
import {
  TOEIC_CONFIDENCES,
  TOEIC_EXAMPLE_MAX,
  TOEIC_EXAMPLE_MIN,
  TOEIC_EXPRESSION_MAX,
  TOEIC_EXTRACT_MAX_PHOTOS,
  TOEIC_HINT_MAX,
  TOEIC_MEANING_KO_MAX,
  TOEIC_NO_MAX,
  TOEIC_NO_MIN,
  TOEIC_SET_ENTRIES_MAX,
  TOEIC_SET_ENTRIES_MIN,
  TOEIC_SET_QUIZ_MAX,
  TOEIC_SET_TITLE_MAX,
} from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO, collapseSpaces, findDuplicateExpressionIndexes, hasHangul, hasLatin } from "@/lib/toeic-text";
import type { ToeicSetSaveRequest, ToeicSetSaveResponse } from "@/lib/toeic-set-contract";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

const no = z.number().int().min(TOEIC_NO_MIN).max(TOEIC_NO_MAX).nullable();
/** 앞뒤 공백·연속 공백 정리(§2-4 후처리 1과 같은 collapseSpaces) — 비면 null(nullable 칸) */
const cleanNullable = (s: string | null) => {
  if (s === null) return null;
  const v = collapseSpaces(s);
  return v === "" ? null : v;
};

const entrySchema = z
  .object({
    no,
    expression: z.string().transform(collapseSpaces).pipe(z.string().min(1, "표현이 비었어요").max(TOEIC_EXPRESSION_MAX)),
    meaningKo: z.string().transform(collapseSpaces).pipe(z.string().min(1, "뜻이 비었어요").max(TOEIC_MEANING_KO_MAX)),
    example: z.string().nullable().transform(cleanNullable).pipe(z.string().min(TOEIC_EXAMPLE_MIN).max(TOEIC_EXAMPLE_MAX).nullable()),
    exampleKo: z.string().nullable().transform(cleanNullable).pipe(z.string().max(TOEIC_EXAMPLE_MAX).nullable()),
    confidence: z.enum(TOEIC_CONFIDENCES),
    partial: z.boolean(),
  })
  .superRefine((e, ctx) => {
    if (!hasLatin(e.expression) || hasHangul(e.expression)) {
      ctx.addIssue({ code: "custom", path: ["expression"], message: "표현은 영어로 적어 주세요(한글 없이)" });
    }
    if (!hasHangul(e.meaningKo)) ctx.addIssue({ code: "custom", path: ["meaningKo"], message: "뜻은 한국어로 적어 주세요" });
    if (e.example !== null && (!hasLatin(e.example) || hasHangul(e.example))) {
      ctx.addIssue({ code: "custom", path: ["example"], message: "예문은 영어로 적어 주세요(한글 없이)" });
    }
    if (e.exampleKo !== null && !hasHangul(e.exampleKo)) {
      ctx.addIssue({ code: "custom", path: ["exampleKo"], message: "예문 해석은 한국어로 적어 주세요" });
    }
  })
  // example이 null이면 exampleKo도 null(§2-4 불변) — 예문을 지웠으면 해석도 함께 비운다
  .transform((e) => ({ ...e, exampleKo: e.example === null ? null : e.exampleKo }));

const quizSchema = z
  .object({
    no,
    promptKo: z.string().transform(collapseSpaces).pipe(z.string().min(1, "QUIZ 문장이 비었어요").max(300)),
    hint: z.string().nullable().transform(cleanNullable).pipe(z.string().max(TOEIC_HINT_MAX).nullable()),
    modelAnswer: z.string().transform(collapseSpaces).pipe(z.string().min(1, "모범답변이 비었어요").max(TOEIC_EXAMPLE_MAX)),
    keyExpressions: z.array(z.string()).max(20),
  })
  .superRefine((q, ctx) => {
    if (!hasHangul(q.promptKo)) ctx.addIssue({ code: "custom", path: ["promptKo"], message: "QUIZ 문장은 한국어로 적어 주세요" });
    if (!hasLatin(q.modelAnswer) || hasHangul(q.modelAnswer)) {
      ctx.addIssue({ code: "custom", path: ["modelAnswer"], message: "모범답변은 영어로 적어 주세요(한글 없이)" });
    }
  });

const bodySchema = z.object({
  titleKo: z.string().transform(collapseSpaces).pipe(z.string().max(TOEIC_SET_TITLE_MAX, `이름은 최대 ${TOEIC_SET_TITLE_MAX}자예요`)),
  dayNo: no,
  topicKo: z.string().nullable().transform(cleanNullable).pipe(z.string().max(60).nullable()),
  entries: z
    .array(entrySchema)
    .min(TOEIC_SET_ENTRIES_MIN, "저장할 표현이 없어요")
    .max(TOEIC_SET_ENTRIES_MAX, `표현은 한 세트에 최대 ${TOEIC_SET_ENTRIES_MAX}개예요`)
    // 세트 안 표현 중복 금지(§7-1) — 항목 키가 곧 표현이라 둘이면 숙련도가 섞이고 거짓 졸업이 난다(QA m1 P2-3)
    .superRefine((entries, ctx) => {
      for (const i of findDuplicateExpressionIndexes(entries)) {
        ctx.addIssue({ code: "custom", path: [i, "expression"], message: TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO });
      }
    }),
  quiz: z.array(quizSchema).max(TOEIC_SET_QUIZ_MAX, `QUIZ는 한 세트에 최대 ${TOEIC_SET_QUIZ_MAX}개예요`),
  photoCount: z.number().int().min(0).max(TOEIC_EXTRACT_MAX_PHOTOS),
  model: z.string().max(120).nullable(),
});

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicSetSaveRequest, BodyInput] extends [BodyInput, ToeicSetSaveRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicSetSaveResponse, status = 200) {
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
    return json(
      {
        ok: false,
        error: "invalid_input",
        // 머리 문구는 개수만 — 무엇을 어디서 고칠지는 issues(경로 + 한국어 규칙 문구)가 말한다(화면이 위치를 한국어로 붙인다)
        messageKo: `표현집을 저장할 수 없어요 — 고칠 곳이 ${parsed.error.issues.length}곳 있어요.`,
        issues: toToeicIssues(parsed.error.issues),
      },
      400,
    );
  }
  const body = parsed.data;

  // keyExpressions — 저장 세트의 표현과 대소문자 무시로 맞는 것만, 표기는 표현 쪽으로(§2-4 후처리 2와 같은 함수)
  let droppedKeyExpressions = 0;
  const quiz = body.quiz.map((q) => {
    const { kept, dropped } = cleanKeyExpressions(q.keyExpressions, body.entries);
    droppedKeyExpressions += dropped;
    return { ...q, keyExpressions: kept };
  });

  try {
    const record = await getStore().createToeicSet({
      titleKo: body.titleKo !== "" ? body.titleKo : defaultToeicSetTitle(body.dayNo, body.topicKo),
      dayNo: body.dayNo,
      topicKo: body.topicKo,
      source: "photo",
      presetKey: null,
      entries: body.entries.map((e) => ({ ...e, points: null })),
      quiz,
      photoCount: body.photoCount,
      enriched: false, // 저장 계층이 entries에서 다시 계산한다(파생 상태)
      model: body.model,
    });
    return json({ ok: true, id: record.id, droppedKeyExpressions });
  } catch (err) {
    console.error("[/api/toeic/sets] 저장 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "표현집을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

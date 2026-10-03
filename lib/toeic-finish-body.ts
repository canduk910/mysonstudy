/**
 * lib/toeic-finish-body.ts — 응시 끝내기·다시 풀기 끝의 **요청 본문 zod 한 벌** (서버 전용 — zod) (docs/harness/toeic.md §7-5·§15-5·§15-11)
 *
 * 두 라우트(`POST …/attempts/[id]/finish` · `POST …/attempts/[id]/retakes/[rid]/finish`)가 같은 모양을 받는다 — `{finishedAt, answers:[{q, recorded,
 * durationMs, diag?}]}`. 진단(diag)은 화면이 보낸 표시용 값이라 범위만 본다(정책 열거·정수 범위·글자 길이 — lib/toeic-mic-health 상한).
 * 범위·중복·길이 검사(`finishAnswerIssues`)도 한 벌이다 — 범위만 다르다(응시는 attempt.questions, 다시 풀기는 그 기록의 questions).
 */

import { z } from "zod";
import { maxToeicRecordingMs } from "./toeic-attempt-rules";
import {
  TOEIC_ANSWER_DIAG_ERROR_MAX,
  TOEIC_ANSWER_DIAG_OPENS_MAX,
  TOEIC_ANSWER_DIAG_REMUTED_MAX,
  TOEIC_ANSWER_DIAG_STATUSES,
  normalizeToeicAnswerDiags,
  type ToeicAnswerDiag,
} from "./toeic-mic-health";
import { TOEIC_QUESTION_COUNT } from "./toeic-mock";

export const toeicAnswerDiagSchema = z.object({
  q: z.number().int().min(1).max(TOEIC_QUESTION_COUNT),
  status: z.enum(TOEIC_ANSWER_DIAG_STATUSES),
  policy: z.enum(["keep", "per-answer"]).nullable(),
  opens: z.number().int().min(0).max(TOEIC_ANSWER_DIAG_OPENS_MAX),
  remuted: z.number().int().min(0).max(TOEIC_ANSWER_DIAG_REMUTED_MAX),
  error: z.string().max(TOEIC_ANSWER_DIAG_ERROR_MAX).nullable(),
  peak: z.number().min(0).max(1).nullable(),
  size: z.number().int().min(0).max(64 * 1024 * 1024).nullable(),
  durationMs: z.number().int().min(0).max(10 * 60 * 1000).nullable(),
  silent: z.boolean(),
});

/** 끝내기·다시 풀기 끝 본문 */
export const toeicFinishBodySchema = z.object({
  finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
  answers: z
    .array(
      z.object({
        q: z.number().int().min(1).max(TOEIC_QUESTION_COUNT),
        recorded: z.boolean(),
        durationMs: z.number().int().min(0).nullable(),
        diag: toeicAnswerDiagSchema.nullable().optional(),
      }),
    )
    .max(TOEIC_QUESTION_COUNT),
});

export type ToeicFinishBody = z.infer<typeof toeicFinishBodySchema>;

/** 범위·중복·길이·진단 문항 검사 — 문제가 없으면 [] */
export function finishAnswerIssues(qs: readonly number[], answers: ToeicFinishBody["answers"]): { path: string; message: string }[] {
  const allowed = new Set(qs);
  const seen = new Set<number>();
  const issues: { path: string; message: string }[] = [];
  answers.forEach((a, i) => {
    if (!allowed.has(a.q)) issues.push({ path: `answers.${i}.q`, message: "이 응시 범위에 없는 문항이에요" });
    else if (seen.has(a.q)) issues.push({ path: `answers.${i}.q`, message: "같은 문항이 두 번 있어요" });
    seen.add(a.q);
    if (allowed.has(a.q) && a.durationMs !== null && a.durationMs > maxToeicRecordingMs(a.q)) {
      issues.push({ path: `answers.${i}.durationMs`, message: "녹음 길이가 답변 시간보다 너무 길어요" });
    }
    if (a.recorded && (a.durationMs === null || a.durationMs <= 0)) {
      issues.push({ path: `answers.${i}.durationMs`, message: "녹음된 문항은 길이가 있어야 해요" });
    }
    if (a.diag && a.diag.q !== a.q) issues.push({ path: `answers.${i}.diag.q`, message: "진단의 문항 번호가 답과 달라요" });
  });
  return issues.slice(0, 10);
}

/** 본문의 진단들(있는 것만, 정규화) */
export function finishBodyDiags(answers: ToeicFinishBody["answers"]): ToeicAnswerDiag[] {
  return normalizeToeicAnswerDiags(answers.map((a) => a.diag).filter((d) => d !== null && d !== undefined));
}

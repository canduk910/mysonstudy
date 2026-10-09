/**
 * lib/ai/mom/schemas.ts — 엄마의 생활영어 호출 M1(주간 테스트 총평) JSON Schema·zod (설계 §5·§8).
 * 두 정의는 같은 필드(goodKo·fixKo)만 갖는다 — scripts/eval-mom.ts 묶음 7이 대조한다.
 */
import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";

export const MOM_SUMMARY_JSON_SCHEMA: StrictJsonSchema = {
  name: "mom_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["goodKo", "fixKo"],
    properties: {
      goodKo: { type: "string" },
      fixKo: { type: "string" },
    },
  },
};

const koLine = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => /[가-힣]/.test(s), { message: "한국어 문장이어야 해요" });

export const momSummaryZod: z.ZodType<{ goodKo: string; fixKo: string }> = z.object({ goodKo: koLine, fixKo: koLine }).strict();

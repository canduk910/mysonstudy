/**
 * lib/ai/toeic/island-schemas.ts — 🏝️ 나만의 답변 섬 호출 G(섬 문장 해석) JSON Schema(strict) + zod 팩토리
 * (docs/harness/toeic.md §21-7)
 *
 * - JSON Schema 상수는 스펙 JSON 코드블록을 그대로 옮겼다(scripts/eval-toeic-island.ts가 스펙을 파싱해 의미 동치로 대조).
 *   배열 개수 제약은 JSON Schema에 넣지 않는다(docs/HARNESS.md §1) — 프롬프트 + zod가 담당한다.
 * - zod는 입력을 알고 만든다 — 보낸 index 집합(개수 일치·모르는 번호·중복 거부). 해석은 빈 값 금지·한글 포함·길이 상한.
 * - zod 메시지에 값을 넣지 않는다(섬 문장이 로그·오류 본문에 새지 않게 — 경로가 위치를 알려 준다).
 * - 상한 TOEIC_ISLAND_TR_KO_MAX의 정의처는 lib/toeic-island.ts 한 곳이다(정규화·적용 판정이 같은 값을 쓴다).
 *
 * ⚠️ 서버 전용(zod). 화면은 lib/toeic-island.ts의 타입·상수만 쓴다.
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";
import { TOEIC_ISLAND_TR_KO_MAX } from "../../toeic-island";
import { checkKoText, issue } from "./schemas";
import type { ToeicIslandTranslateInput } from "./island-prompts";

// ===========================================================================
// JSON Schema (strict) — §21-7 원문 그대로
// ===========================================================================

export const TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA: StrictJsonSchema = {
  name: "toeic_island_translate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "ko"],
          properties: {
            index: { type: "integer" },
            ko: { type: "string" },
          },
        },
      },
    },
  },
};

// ===========================================================================
// zod — 입력을 알고 만든다
// ===========================================================================

export interface ToeicIslandTranslateItemOut {
  index: number;
  ko: string;
}

export interface ToeicIslandTranslateOutput {
  items: ToeicIslandTranslateItemOut[];
}

/**
 * 호출 G zod(§21-7) — 위반이면 공유 래퍼가 1회 재요청한다.
 * - items: 보낸 index마다 정확히 하나(개수 = 보낸 수 · 모르는 index 거부 · 중복 거부 → 빠진 index도 함께 알린다)
 * - ko: 1~TOEIC_ISLAND_TR_KO_MAX자(앞뒤 공백 뺀 길이) · 한글 포함(영어를 그대로 돌려준 답 거부)
 * 내용 낱말을 빠뜨렸는지는 코드로 잴 수 없다 — 프롬프트 몫이다(§21-7 알려진 틈).
 */
export function buildIslandTranslateZod(input: ToeicIslandTranslateInput): z.ZodType<ToeicIslandTranslateOutput> {
  const sent = new Set(input.items.map((it) => it.index));
  return z
    .object({
      items: z.array(z.object({ index: z.number().int(), ko: z.string() }).strict()),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.items.length !== sent.size) issue(ctx, ["items"], `items는 받은 항목 수와 같아야 합니다 (받은 ${sent.size}개, 지금 ${v.items.length}개)`);
      const seen = new Set<number>();
      v.items.forEach((it, i) => {
        if (!sent.has(it.index)) issue(ctx, ["items", i, "index"], "받지 않은 index입니다");
        else if (seen.has(it.index)) issue(ctx, ["items", i, "index"], "같은 index를 두 번 썼습니다");
        seen.add(it.index);
        checkKoText(ctx, ["items", i, "ko"], it.ko, TOEIC_ISLAND_TR_KO_MAX, "ko(해석)");
      });
      const missing = [...sent].filter((x) => !seen.has(x));
      if (missing.length > 0) issue(ctx, ["items"], `해석이 빠진 index가 있습니다: ${missing.join(", ")}`);
    });
}

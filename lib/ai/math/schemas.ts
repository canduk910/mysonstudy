/**
 * lib/ai/math/schemas.ts — 출력 JSON Schema + zod 이중 검증 (docs/harness/math.md §2-3·§3-3·§6)
 *
 * 이 파일이 담는 호출: **A(문제 판독) · B(설명 설계) · D(연습문제)**.
 * 호출 C(검산)의 `answer_check`는 pipeline.ts 쪽(§5-1), 호출 E의 `{html, stepCount}`는 §3-4 소관이다.
 *
 * 규약(docs/HARNESS.md §1):
 * - JSON Schema는 strict 모드용 — 모든 필드 `required`, 모든 객체에 `additionalProperties: false`,
 *   "선택"은 null 유니온으로 표현한다.
 * - **개수·길이 제약(minItems/maxItems/minLength)은 JSON Schema에 넣지 않는다.** 프롬프트 + zod가 담당한다.
 * - zod는 JSON Schema에서 자동 변환하지 않고 손으로 쓰되, 필드·타입이 1:1인지 대조한다.
 *   `Scene`·`Explanation`은 파일 끝의 컴파일 타임 대조(AssertExact)가 그 1:1을 강제한다.
 *
 * 다이얼 숫자(act2 3~6, checks 2~3, rules 2~3, steps 3~8)는 프롬프트 문장 안에도 박혀 있다.
 * 여기 상수를 고치면 `lib/ai/math/prompts.ts`의 문구와 `scripts/eval-math.ts`도 함께 고쳐야 한다.
 */

import { z } from "zod";
import {
  BAR_LAYOUTS,
  SCENE_KINDS,
  SCENE_STEP_MODES,
  SCENE_VISUALS,
  type AnswerItem,
  type Scene,
} from "../../scene/types";

/** Structured Outputs에 전달하는 json_schema 포맷 묶음 (`callWithSchema`의 `jsonSchema` 인자) */
export interface StrictJsonSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 공용 JSON Schema 조각
// ---------------------------------------------------------------------------

/**
 * nullable enum 조각.
 *
 * 스칼라·객체·배열의 nullable은 규약대로 `["type","null"]`을 쓰지만, **enum만은 `anyOf`로 쓴다.**
 * `{"type":["string","null"], "enum":[...]}`은 JSON Schema로 읽으면 자기모순이다 — enum에 null이
 * 없으므로 null이 거부되고, 그러면 `visual`이 null이어야 하는 bar·numberline 장면을 표현할 방법이
 * 사라진다. `anyOf: [{enum}, {null}]`은 zod v4의 공식 JSON Schema 변환(`z.toJSONSchema`,
 * OpenAI SDK의 zod 헬퍼가 쓰는 그 경로)이 `.nullable()` enum에 대해 내보내는 바로 그 형태다.
 * 해당하는 필드는 `visual`·`layout` 둘뿐이다.
 */
function nullableEnum(values: readonly string[], description: string) {
  return {
    anyOf: [{ type: "string", enum: [...values] }, { type: "null" }],
    description,
  };
}

/** 구조화된 답 배열 — 호출 B·D가 공유한다 (§3-1 [답과 채점]) */
const ANSWER_ARRAY_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", description: "문제 속 이름 그대로 (가/나/다, 승환/영민/지훈)" },
      value: { type: "number" },
      unit: { type: ["string", "null"] },
    },
    required: ["label", "value", "unit"],
  },
} as const;

/**
 * 1단 장면(`Scene`)의 JSON Schema — 호출 B·D가 공유한다 (§3-3).
 * nullable 객체이므로 `type: ["object","null"]`. 값의 정합성은 스키마가 아니라 §4 `verifyScene()`가 본다.
 */
const SCENE_JSON_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...SCENE_KINDS] },
    visual: nullableEnum(SCENE_VISUALS, "containers 전용. 물이면 tank, 돈이면 coin, 그 외 bar. 다른 kind면 null"),
    layout: nullableEnum(BAR_LAYOUTS, "bar 전용. parts=부분과 전체, compare=합과 차. 다른 kind면 null"),
    difference: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        amount: { type: "number" },
        labelKo: { type: "string" },
      },
      required: ["amount", "labelKo"],
      description: "bar layout='compare' 전용 — 두 띠의 길이 차. 그 외에는 null",
    },
    unit: { type: "string" },
    maxValue: { type: "number", description: "그림 눈금 상한 (값 중 최대의 1.3배쯤 반올림)" },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, labelKo: { type: "string" } },
        required: ["id", "labelKo"],
      },
    },
    moves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "integer", description: "entities 인덱스" },
          to: { type: "integer", description: "entities 인덱스" },
          amt: { type: "number" },
          labelKo: { type: "string" },
        },
        required: ["from", "to", "amt", "labelKo"],
      },
    },
    conservation: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        total: { type: "number" },
        labelKo: { type: "string" },
      },
      required: ["total", "labelKo"],
      description: "전체 합이 보존되면 채우고, 아니면 null",
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", enum: [...SCENE_STEP_MODES] },
          values: {
            type: "array",
            items: { type: ["number", "null"] },
            description: "길이는 entities 길이와 같다. 아직 모르는 값은 null",
          },
          move: {
            type: ["integer", "null"],
            description: "되감기 단계에서 되돌리는 원래 이동의 moves 인덱스. 그 외 단계는 null",
          },
          forward: { type: "boolean" },
          caption: {
            type: "object",
            additionalProperties: false,
            properties: {
              tag: { type: "string", description: '예: "되감기 1"' },
              title: { type: "string" },
              body: { type: "string", description: "아이에게 하는 말" },
              calc: { type: ["string", "null"] },
            },
            required: ["tag", "title", "body", "calc"],
          },
        },
        required: ["mode", "values", "move", "forward", "caption"],
      },
    },
  },
  required: [
    "kind", "visual", "layout", "difference", "unit", "maxValue",
    "entities", "moves", "conservation", "steps",
  ],
} as const;

// ---------------------------------------------------------------------------
// 호출 A — worksheet_extraction (HARNESS §2-3 원문)
// ---------------------------------------------------------------------------

/**
 * 채점 표시 [개정 2] — 어른이 빨간 펜으로 친 표시. **아이 필기가 아니다.**
 * `'none'`이 아닌 문제를 확인 화면에서 먼저·기본 선택으로 올린다 (§2-4) — 비용 안전장치이자
 * "틀린 표시가 있는 문제가 곧 설명이 필요한 문제"라는 신호다.
 */
export const GRADED_MARKS = ["circled", "checked", "none"] as const;
export type GradedMark = (typeof GRADED_MARKS)[number];

export const WORKSHEET_EXTRACTION_JSON_SCHEMA: StrictJsonSchema = {
  name: "worksheet_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isWorksheet: { type: "boolean" },
      source: { type: ["string", "null"] },
      problems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            number: { type: ["string", "null"] },
            text: { type: "string" },
            truncated: { type: "boolean" },
            figureDesc: { type: ["string", "null"] },
            givens: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string" },
                  value: { type: "number" },
                  unit: { type: ["string", "null"] },
                },
                required: ["label", "value", "unit"],
              },
            },
            childWork: { type: ["string", "null"] },
            childAnswer: { type: ["string", "null"] },
            gradedMark: { type: "string", enum: ["circled", "checked", "none"] },
          },
          required: [
            "number", "text", "truncated", "figureDesc", "givens",
            "childWork", "childAnswer", "gradedMark",
          ],
        },
      },
    },
    required: ["isWorksheet", "source", "problems"],
  },
};

const givenSchema = z.object({
  label: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
});

const extractedProblemSchema = z.object({
  number: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  figureDesc: z.string().nullable(),
  givens: z.array(givenSchema),
  childWork: z.string().nullable(),
  childAnswer: z.string().nullable(),
  gradedMark: z.enum(GRADED_MARKS),
});

/**
 * 호출 A 결과의 zod 스키마 (JSON Schema와 필드·타입 1:1).
 *
 * **`problems`에 최소 개수를 걸지 않는다.** 판독 실패(`isWorksheet:false` 또는 빈 배열)는 검증
 * 실패가 아니라 §2-4가 정의한 정상 흐름이다 — "다시 찍어주세요" + 직접 입력 폴백으로 간다.
 * 여기서 거부하면 재요청 1회를 태우고 throw까지 가서, 사용자는 폴백 화면 대신 에러를 만난다.
 */
export const worksheetExtractionSchema = z.object({
  isWorksheet: z.boolean(),
  source: z.string().nullable(),
  problems: z.array(extractedProblemSchema),
});

export type Given = z.infer<typeof givenSchema>;
export type ExtractedProblem = z.infer<typeof extractedProblemSchema>;
export type WorksheetExtraction = z.infer<typeof worksheetExtractionSchema>;

/**
 * 확인 화면의 기본 선택 대상 [개정 2] — 채점 표시가 있는 문제 (§2-4·§8).
 * 페이지당 문제가 12개인 교재에서 전부 설명을 만들면 비용이 감당되지 않는다.
 * UI는 이 함수로 고르고, **페이지 전체를 자동 처리하는 경로를 만들지 않는다.**
 */
export function isMarkedProblem(problem: { gradedMark: GradedMark }): boolean {
  return problem.gradedMark !== "none";
}

// ---------------------------------------------------------------------------
// 호출 B — explanation (HARNESS §3-3)
// ---------------------------------------------------------------------------

/**
 * 문제 유형 코드 (§3-1 [problemPattern]).
 * [개정 3] `counting`(빠짐없이·중복없이 세기)을 추가하고 `geometry`를 "길이·넓이·모양"으로 좁혔다 —
 * 소마의 도형 문제는 넓이가 아니라 세기이고, 설명 구조가 완전히 다르다.
 */
export const PROBLEM_PATTERNS = [
  "rewind-transfer",
  "part-whole",
  "multiple",
  "sequence-ops",
  "rate",
  "pattern",
  "geometry",
  "counting",
  "other",
] as const;
export type ProblemPattern = (typeof PROBLEM_PATTERNS)[number];

/** 답에 대한 AI 자신의 확신도. `low`면 파이프라인이 무조건 `held`로 보낸다 (§5-3) */
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** 아이 답 채점 (§3-1 [답과 채점]). childAnswer가 없으면 `none` */
export const CHILD_GRADES = ["correct", "partial", "wrong", "none"] as const;
export type ChildGrade = (typeof CHILD_GRADES)[number];

// --- 개수 다이얼 (프롬프트 문구·eval과 반드시 함께 움직인다) ---
/** act2 되감기 단계 수 (§3-1 "단계 3~6개") */
export const ACT2_STEPS_RANGE = [3, 6] as const;
/** act3 검사 포인트 수 (§3-1 "검사 포인트 2~3개") */
export const ACT3_CHECKS_RANGE = [2, 3] as const;
/** 규칙 카드 수 (§3-1 "기억할 규칙 2~3개") */
export const RULES_RANGE = [2, 3] as const;
/** 1단 장면 단계 수 (§3-1 "steps는 3~8개") */
export const SCENE_STEPS_RANGE = [3, 8] as const;

export const EXPLANATION_JSON_SCHEMA: StrictJsonSchema = {
  name: "explanation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      problemPattern: { type: "string", enum: [...PROBLEM_PATTERNS] },
      patternNameKo: { type: "string", description: '아이 말 이름 (예: "되감기형 · 양 옮기기")' },
      analogy: {
        type: "object",
        additionalProperties: false,
        properties: { titleKo: { type: "string" }, bodyKo: { type: "string" } },
        required: ["titleKo", "bodyKo"],
      },
      act1: {
        type: "object",
        additionalProperties: false,
        properties: {
          castKo: { type: "array", items: { type: "string" }, description: "등장인물/물건" },
          movesKo: {
            type: "array",
            items: { type: "string" },
            description: '방향이 드러나는 화살표 문장 (예: "민희 → 철희 : 연필 3자루")',
          },
          endSceneKo: { type: "string" },
          goalKo: { type: "string" },
          trap: { type: ["string", "null"], description: '함정이 있으면 "조심!" 한 문장, 없으면 null' },
        },
        required: ["castKo", "movesKo", "endSceneKo", "goalKo", "trap"],
      },
      act2: {
        type: "object",
        additionalProperties: false,
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                say: { type: "string", description: "아이에게 하는 말 1~2문장" },
                calc: { type: ["string", "null"], description: "계산 한 줄 또는 null" },
              },
              required: ["say", "calc"],
            },
          },
        },
        required: ["steps"],
      },
      act3: {
        type: "object",
        additionalProperties: false,
        properties: {
          checks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { titleKo: { type: "string" }, bodyKo: { type: "string" } },
              required: ["titleKo", "bodyKo"],
            },
          },
        },
        required: ["checks"],
      },
      rules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            emoji: { type: "string" },
            ko: { type: "string", description: "짧게" },
            why: { type: "string", description: "한 문장" },
          },
          required: ["emoji", "ko", "why"],
        },
      },
      parentTip: { type: "string" },
      answer: ANSWER_ARRAY_JSON_SCHEMA,
      answerText: { type: "string", description: "아이에게 보여줄 한 줄 답" },
      confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
      uncertaintyNote: { type: ["string", "null"] },
      childGrade: { type: "string", enum: [...CHILD_GRADES] },
      gradeNote: { type: ["string", "null"] },
      scene: SCENE_JSON_SCHEMA,
      sceneHtmlRequest: {
        type: "boolean",
        description: "1단 scene이 안 되는 문제만 true. scene이 있으면 반드시 false (1단 우선)",
      },
    },
    required: [
      "problemPattern", "patternNameKo", "analogy", "act1", "act2", "act3",
      "rules", "parentTip", "answer", "answerText", "confidence",
      "uncertaintyNote", "childGrade", "gradeNote", "scene", "sceneHtmlRequest",
    ],
  },
};

// --- zod: Scene ---

const captionSchema = z.object({
  tag: z.string(),
  title: z.string(),
  body: z.string(),
  calc: z.string().nullable(),
});

const sceneStepSchema = z.object({
  mode: z.enum(SCENE_STEP_MODES),
  values: z.array(z.number().nullable()),
  move: z.number().int().nullable(),
  forward: z.boolean(),
  caption: captionSchema,
});

/**
 * 1단 장면의 zod 스키마.
 *
 * **값의 정합성은 여기서 보지 않는다.** 되감기 산술·보존량·split·라벨 대조는 전부
 * §4 `verifyScene()`(lib/scene/verify.ts)의 몫이다. 이유는 실패의 결과가 다르기 때문이다:
 * zod 실패는 재요청 1회 뒤 throw라 **설명 전체를 잃고**, verifyScene 실패는 §5-3대로
 * **장면만 버리고 텍스트 3막은 살린다.** 그림 하나 때문에 설명을 통째로 날릴 이유가 없다.
 * 그래서 zod에는 스펙이 명시적으로 zod에 배정한 것(steps 개수, §3-3)만 둔다.
 */
export const sceneSchema = z
  .object({
    kind: z.enum(SCENE_KINDS),
    visual: z.enum(SCENE_VISUALS).nullable(),
    layout: z.enum(BAR_LAYOUTS).nullable(),
    difference: z.object({ amount: z.number(), labelKo: z.string() }).nullable(),
    unit: z.string(),
    maxValue: z.number(),
    entities: z.array(z.object({ id: z.string(), labelKo: z.string() })),
    moves: z.array(
      z.object({
        from: z.number().int(),
        to: z.number().int(),
        amt: z.number(),
        labelKo: z.string(),
      }),
    ),
    conservation: z.object({ total: z.number(), labelKo: z.string() }).nullable(),
    steps: z.array(sceneStepSchema),
  })
  .superRefine((scene, ctx) => {
    const [min, max] = SCENE_STEPS_RANGE;
    if (scene.steps.length < min || scene.steps.length > max) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `장면 단계는 ${min}~${max}개여야 합니다 (현재 ${scene.steps.length}개)`,
      });
    }
  });

const answerItemSchema = z.object({
  label: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
});

/** 호출 B zod 검증에 필요한 입력 쪽 사실 — 카드(영어)와 같은 팩토리 패턴 */
export interface ExplanationValidationMeta {
  /**
   * 이 호출에 아이가 쓴 답(`childAnswer`)을 넘겼는지.
   * §3-1: "childGrade: childAnswer가 있으면 'correct'|'partial'|'wrong', 없으면 'none'".
   * 입력에 의존하는 규칙이라 zod를 팩토리로 만든다. eval #5가 이 판정에 걸려 있다.
   */
  hasChildAnswer: boolean;
}

/**
 * 호출 B — zod 이중 검증.
 *
 * JSON Schema가 못 잡는 것만 본다: 개수 다이얼(§3-3), 입력 의존 규칙(childGrade),
 * 그리고 **1단/2단 배타**(§3-1 "scene 1단이 되는 문제는 sceneHtmlRequest를 false로 둔다").
 */
export function makeExplanationSchema(meta: ExplanationValidationMeta) {
  return z
    .object({
      problemPattern: z.enum(PROBLEM_PATTERNS),
      patternNameKo: z.string(),
      analogy: z.object({ titleKo: z.string(), bodyKo: z.string() }),
      act1: z.object({
        castKo: z.array(z.string()),
        movesKo: z.array(z.string()),
        endSceneKo: z.string(),
        goalKo: z.string(),
        trap: z.string().nullable(),
      }),
      act2: z.object({
        steps: z.array(z.object({ say: z.string(), calc: z.string().nullable() })),
      }),
      act3: z.object({
        checks: z.array(z.object({ titleKo: z.string(), bodyKo: z.string() })),
      }),
      rules: z.array(z.object({ emoji: z.string(), ko: z.string(), why: z.string() })),
      parentTip: z.string(),
      answer: z.array(answerItemSchema),
      answerText: z.string(),
      confidence: z.enum(CONFIDENCE_LEVELS),
      uncertaintyNote: z.string().nullable(),
      childGrade: z.enum(CHILD_GRADES),
      gradeNote: z.string().nullable(),
      scene: sceneSchema.nullable(),
      sceneHtmlRequest: z.boolean(),
    })
    .superRefine((explanation, ctx) => {
      checkRange(ctx, explanation.act2.steps.length, ACT2_STEPS_RANGE, ["act2", "steps"], "되감기 단계");
      checkRange(ctx, explanation.act3.checks.length, ACT3_CHECKS_RANGE, ["act3", "checks"], "검사 포인트");
      checkRange(ctx, explanation.rules.length, RULES_RANGE, ["rules"], "규칙 카드");

      // 답 없는 설명은 이 하네스의 존재 이유(정확한 답)를 못 지킨다. 검산(§5)도 비교할 대상이 없다
      if (explanation.answer.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["answer"],
          message: "answer는 1개 이상이어야 합니다",
        });
      }

      // childGrade는 입력(childAnswer 유무)이 정한다 — 아이가 안 쓴 답을 채점하거나
      // 쓴 답을 못 본 척하는 출력을 막는다 (§3-1 [답과 채점], eval #5)
      if (meta.hasChildAnswer && explanation.childGrade === "none") {
        ctx.addIssue({
          code: "custom",
          path: ["childGrade"],
          message: "아이가 쓴 답이 있으므로 correct·partial·wrong 중 하나여야 합니다",
        });
      }
      if (!meta.hasChildAnswer && explanation.childGrade !== "none") {
        ctx.addIssue({
          code: "custom",
          path: ["childGrade"],
          message: `아이가 쓴 답이 없으므로 "none"이어야 합니다 (현재 "${explanation.childGrade}")`,
        });
      }
      if (explanation.childGrade !== "none" && (explanation.gradeNote ?? "").trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["gradeNote"],
          message: "채점했으면 gradeNote를 1~2문장 적으세요 (틀렸어도 먼저 잘한 점 하나)",
        });
      }

      // "답이 확실하지 않으면 confidence를 낮게 쓰고 그 이유를 uncertaintyNote에 적는다" (§3-1 절대 규칙 1).
      // confidence 'low'는 §5-3에서 무조건 held로 가는 값이라, 사람이 읽을 사유가 반드시 있어야 한다
      if (explanation.confidence === "low" && (explanation.uncertaintyNote ?? "").trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["uncertaintyNote"],
          message: "confidence가 low면 그 이유를 uncertaintyNote에 적으세요",
        });
      }

      // 1단이 우선 — 둘 다 요청하면 호출 E 비용이 헛돈다 (§3-1 (2단) 마지막 줄)
      if (explanation.scene !== null && explanation.sceneHtmlRequest) {
        ctx.addIssue({
          code: "custom",
          path: ["sceneHtmlRequest"],
          message: "scene(1단)이 있으면 sceneHtmlRequest는 false여야 합니다 (1단이 우선)",
        });
      }
    });
}

function checkRange(
  ctx: z.RefinementCtx,
  actual: number,
  [min, max]: readonly [number, number],
  path: (string | number)[],
  labelKo: string,
): void {
  if (actual < min || actual > max) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${labelKo}는 ${min}~${max}개여야 합니다 (현재 ${actual}개)`,
    });
  }
}

/** 호출 B의 결과 타입 (§3-3 `Explanation`) */
export interface Explanation {
  problemPattern: ProblemPattern;
  patternNameKo: string;
  analogy: { titleKo: string; bodyKo: string };
  act1: {
    castKo: string[];
    movesKo: string[];
    endSceneKo: string;
    goalKo: string;
    trap: string | null;
  };
  act2: { steps: { say: string; calc: string | null }[] }; // 3~6개
  act3: { checks: { titleKo: string; bodyKo: string }[] }; // 2~3개
  rules: { emoji: string; ko: string; why: string }[]; // 2~3개
  parentTip: string;
  answer: AnswerItem[];
  answerText: string;
  confidence: Confidence;
  uncertaintyNote: string | null;
  childGrade: ChildGrade;
  gradeNote: string | null;
  scene: Scene | null;
  sceneHtmlRequest: boolean;
}

// ---------------------------------------------------------------------------
// 호출 D — practice (HARNESS §6)
// ---------------------------------------------------------------------------

export const PRACTICE_JSON_SCHEMA: StrictJsonSchema = {
  name: "practice",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", description: "숫자와 소재만 바꾼 새 문제 문장" },
      answer: ANSWER_ARRAY_JSON_SCHEMA,
      answerText: { type: "string" },
      hintKo: { type: "string" },
      scene: SCENE_JSON_SCHEMA,
    },
    required: ["text", "answer", "answerText", "hintKo", "scene"],
  },
};

/**
 * 호출 D — zod 이중 검증.
 *
 * §6이 명시한 수치 규칙 "답은 모두 0 이상의 정수"만 강제한다. "합계 100 이하 또는 100단위 깔끔한 수"는
 * 프롬프트가 지시하는 **다이얼**이라 zod로 굳히지 않는다 — 아이 반응 보고 조정할 값이고(§8),
 * 여기 박아 두면 다이얼을 돌릴 때 세 곳(프롬프트·zod·eval)이 어긋난다.
 *
 * 생성된 문제는 §6대로 **반드시 호출 C로 검산**한다. 이 zod는 검산을 대신하지 않는다.
 */
export const practiceSchema = z
  .object({
    text: z.string(),
    answer: z.array(answerItemSchema),
    answerText: z.string(),
    hintKo: z.string(),
    scene: sceneSchema.nullable(),
  })
  .superRefine((practice, ctx) => {
    if (practice.answer.length === 0) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "answer는 1개 이상이어야 합니다" });
    }
    practice.answer.forEach((item, i) => {
      if (!Number.isInteger(item.value) || item.value < 0) {
        ctx.addIssue({
          code: "custom",
          path: ["answer", i, "value"],
          message: `연습문제의 답은 0 이상의 정수여야 합니다 (현재 ${item.value})`,
        });
      }
    });
  });

/** 호출 D의 결과 타입 (§6 `practice`) */
export interface Practice {
  text: string;
  answer: AnswerItem[];
  answerText: string;
  hintKo: string;
  scene: Scene | null;
}

// ---------------------------------------------------------------------------
// 컴파일 타임 대조 — zod 추론 타입 ↔ 손으로 쓴 타입
//
// zod를 JSON Schema에서 자동 변환하지 않는 대신(스펙의 스키마 원문이 기준), 이 대조가
// "필드 하나를 한쪽에만 추가"하는 표류를 컴파일 단계에서 잡는다.
// 어긋나면 `true`를 `false`에 대입할 수 없다는 타입 에러가 이 줄에서 난다.
// ---------------------------------------------------------------------------

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _sceneMatchesSceneType: AssertExact<z.infer<typeof sceneSchema>, Scene> = true;
const _explanationMatchesType: AssertExact<
  z.infer<ReturnType<typeof makeExplanationSchema>>,
  Explanation
> = true;
const _practiceMatchesType: AssertExact<z.infer<typeof practiceSchema>, Practice> = true;

void _sceneMatchesSceneType;
void _explanationMatchesType;
void _practiceMatchesType;

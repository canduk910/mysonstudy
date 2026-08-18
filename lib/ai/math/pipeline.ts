/**
 * lib/ai/math/pipeline.ts — 호출 C(독립 검산)와 `explainProblem()` 흐름
 * (docs/harness/math.md §5-1 · §5-2 · §5-3)
 *
 * 수학은 정답이 있는 세계라 **틀린 답을 자신 있게 보여주는 것이 최악의 실패**다. 아이가 그대로 배운다.
 * 그래서 이 하네스에는 심판이 둘 붙는다:
 *
 *   심판 1 — 호출 C: 문제를 **독립적으로 다시 푸는** 두 번째 AI. 답 자체가 틀린 경우를 잡는다.
 *   심판 2 — `verifyScene()`: 장면 JSON의 숫자를 앱이 직접 더하고 빼 보는 순수 함수(§4).
 *            답은 맞는데 그림 대본이 어긋난 경우를 잡는다.
 *
 * 두 심판이 갈리면 답을 봉합하지 않고 **`held`(정직한 보류)**로 내보낸다. 화면은 텍스트 설명과
 * "아빠가 한 번 확인해 주세요" 배지를 보여주고 답은 접는다.
 * **보류율이 올라가는 것보다 틀린 답이 통과하는 것이 훨씬 나쁘다.**
 */

import { z } from "zod";
import { callWithSchema, resolveVerifyModel, textPart } from "../client";
import type { AnswerItem, SceneTier } from "../../scene/types";
import { compare, formatAnswer, verifyScene } from "../../scene/verify";
import {
  EXPLAIN_CALL_OPTIONS,
  EXPLAIN_SYSTEM_PROMPT,
  buildExplainUserMessage,
  type ExplainUserMessageInput,
} from "./prompts";
import {
  EXPLANATION_JSON_SCHEMA,
  makeExplanationSchema,
  type Explanation,
  type StrictJsonSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// 호출 C — 검산 (§5-1)
// ---------------------------------------------------------------------------

/** 호출 C 시스템 프롬프트 (§5-1 원문 그대로) */
export const VERIFY_SYSTEM_PROMPT = `너는 초등 수학 문제 검산 담당이다. 문제 문장만 보고 스스로 푼 뒤 답만 낸다.
설명·비유는 쓰지 않는다. 라벨은 문제 속 이름 그대로 쓴다. 답을 확정할 수 없으면 solvable을 false로.`;

/**
 * 호출 C 파라미터 (§1 표: temperature 0 · 출력 한도 ~800).
 * 모델은 `OPENAI_MODEL_VERIFY`(없으면 `OPENAI_MODEL`) — 심판만 더 강한 모델로 올릴 여지를 남긴 것이다.
 */
export const VERIFY_CALL_OPTIONS = {
  call: "math-verify",
  temperature: 0,
  maxOutputTokens: 800,
} as const;

/** 호출 C 출력 스키마 `answer_check` (§5-1, strict) */
export const ANSWER_CHECK_JSON_SCHEMA: StrictJsonSchema = {
  name: "answer_check",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      solvable: {
        type: "boolean",
        description: "문제 문장만으로 답을 확정할 수 있으면 true. 확정 못 하면 false(추측 금지)",
      },
      answer: {
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
        description: "solvable이 false면 빈 배열",
      },
    },
    required: ["solvable", "answer"],
  },
};

/** 호출 C — zod 이중 검증 */
export const answerCheckSchema = z.object({
  solvable: z.boolean(),
  answer: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      unit: z.string().nullable(),
    }),
  ),
});

export interface AnswerCheck {
  solvable: boolean;
  answer: AnswerItem[];
}

/** 호출 C 사용자 메시지 입력 — **문제 문장과 그림 설명뿐이다** */
export interface VerifyUserMessageInput {
  text: string;
  figureDesc?: string | null;
}

/**
 * 호출 C — 사용자 메시지 조립 (§5-1 템플릿 그대로).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ **B의 답을 절대 여기 넣지 마라.** 심판이 선수 답안지를 먼저 보면 그 답에      │
 * │ 끌려간다(anchoring). 두 번째 의견이 첫 번째의 복사본이 되면 심판이 둘이      │
 * │ 아니라 하나이고, 그러면 이 파일 전체가 하는 일이 없어진다.                  │
 * │                                                                          │
 * │ "컨텍스트를 더 주면 정확해지지 않나?"라는 **선의의 수정이 반드시 들어오는**  │
 * │ 자리다. 답·풀이·3막 텍스트·아이가 쓴 답(childAnswer)·이전 검산 결과 —        │
 * │ 무엇도 넘기지 않는다. C가 받는 것은 문제 문장과 그림 설명, 그 둘뿐이다.      │
 * │ 재시도 때도 같다(§5-3의 c2는 retryNote 없이 처음과 똑같은 입력으로 부른다).  │
 * │                                                                          │
 * │ 정확도를 올리고 싶으면 여기에 맥락을 붙이는 대신 `OPENAI_MODEL_VERIFY`로     │
 * │ 심판 모델을 올려라 — 그것이 독립성을 지키면서 품질을 사는 방법이다.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function buildVerifyUserMessage(input: VerifyUserMessageInput): string {
  return `[문제]
${input.text}
그림 설명: ${input.figureDesc ?? "없음"}

답을 계산해줘.`;
}

/** 호출 C 실행 — 문제를 독립적으로 다시 푼다 */
export async function callAnswerCheck(input: VerifyUserMessageInput): Promise<AnswerCheck> {
  return callWithSchema<AnswerCheck>({
    call: VERIFY_CALL_OPTIONS.call,
    system: VERIFY_SYSTEM_PROMPT,
    user: [textPart(buildVerifyUserMessage(input))],
    jsonSchema: ANSWER_CHECK_JSON_SCHEMA,
    zodSchema: answerCheckSchema,
    temperature: VERIFY_CALL_OPTIONS.temperature,
    maxOutputTokens: VERIFY_CALL_OPTIONS.maxOutputTokens,
    model: resolveVerifyModel(),
  });
}

// ---------------------------------------------------------------------------
// 호출 B — 설명 설계 (§3)
// ---------------------------------------------------------------------------

/** 호출 B 실행. `retryNote`가 있으면 §3-2 템플릿 끝에 [다시 풀기] 블록이 붙는다 */
export async function callExplain(input: ExplainUserMessageInput): Promise<Explanation> {
  return callWithSchema<Explanation>({
    call: EXPLAIN_CALL_OPTIONS.call,
    system: EXPLAIN_SYSTEM_PROMPT,
    user: [textPart(buildExplainUserMessage(input))],
    // childGrade 규칙은 "아이가 쓴 답을 넘겼는가"가 정한다 (schemas.ts §makeExplanationSchema).
    // 빈 문자열은 사용자가 지운 것이므로 '없음'으로 본다 — 프롬프트에도 빈칸으로 나간다.
    zodSchema: makeExplanationSchema({ hasChildAnswer: (input.childAnswer ?? "").trim() !== "" }),
    jsonSchema: EXPLANATION_JSON_SCHEMA,
    temperature: EXPLAIN_CALL_OPTIONS.temperature,
    maxOutputTokens: EXPLAIN_CALL_OPTIONS.maxOutputTokens,
  });
}

// ---------------------------------------------------------------------------
// 파이프라인 (§5-3)
// ---------------------------------------------------------------------------

/** `explainProblem()` 입력 — 호출 A 결과를 사용자가 확인 화면에서 수정한 값 */
export type ExplainProblemInput = ExplainUserMessageInput;

/** 보류 사유 코드. UI 배지 문구는 app-builder가 이 코드로 고른다 */
export const HELD_REASONS = [
  "answer-mismatch", // B와 C(검산)의 답이 다르다
  "verifier-unsolvable", // C가 답을 확정하지 못했다 (solvable: false)
  "verifier-failed", // C 호출 자체가 실패했다 — 두 번째 의견이 없다
  "low-confidence", // B가 스스로 자신 없다고 했다 (confidence: 'low')
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export interface ExplainVerifyReport {
  /** 'ok' | 'held'. `held`는 실패가 아니라 정직한 보류다 */
  status: "ok" | "held";
  /** B의 답이 독립 검산과 일치했는가 */
  answerMatch: boolean;
  /** 장면 숫자 검산 통과 여부 (장면이 없으면 true) */
  sceneCheck: boolean;
  /** 호출 B 시도 횟수 (1 또는 2 — 재시도는 §5-3대로 1회뿐) */
  attempts: number;
  /** 마지막 시도의 `verifyScene` 실패 사유. 장면을 왜 못 그렸는지 사람이 읽는 자리 */
  sceneErrors: string[];
  /**
   * 삼자 대조(§10-3)에서 두 번째 풀이(`insight`)를 버렸는가.
   * `insight.answer`가 본체 `answer`와 달라 `content.insight`를 null로 만든 경우에만 true다.
   *
   * **모델이 통찰을 아예 내지 않은 정상 출력(§10-2)은 false다.** "없었다"와 "버렸다"는 다른
   * 사건이고, §8에서 유형별로 집계할 때 둘이 섞이면 신호가 죽는다.
   *
   * **true여도 `status`는 `held`가 되지 않는다.** 통찰은 부가물이고 B·C 일치가 이미 답을
   * 뒷받침한다 — 부가물의 오류가 본체를 죽이지 않는 것은 장면 검산 실패 시 `scene`만 버리는
   * 처리(§5-3)와 같은 원칙이다.
   */
  insightDropped: boolean;
  /** 보류 사유(복수 가능). status가 'ok'면 빈 배열 */
  heldReasons: HeldReason[];
  /** 마지막 검산(심판)의 답. 보류 화면에서 "검산은 이렇게 봤어요"로 쓸 수 있다 */
  checkAnswer: AnswerItem[] | null;
}

export interface ExplainProblemResult {
  /**
   * 호출 B의 3막 설명. **부가물은 버려졌을 수 있고 본체 텍스트는 언제나 살아 있다** —
   * 장면 검산이 실패했으면 `content.scene`이 null이고(§5-3),
   * 삼자 대조가 어긋났으면 `content.insight`가 null이다(§10-3 · `verify.insightDropped`).
   */
  content: Explanation;
  /** 2단 그림 HTML (호출 E). 없으면 null */
  sceneHtml: string | null;
  /** 'typed' | 'html' | 'none' — 서재 집계용(§8) */
  sceneTier: SceneTier;
  verify: ExplainVerifyReport;
}

/** 호출 E(2단 플레이어 HTML) 렌더러. 실패는 예외가 아니라 null로 돌려준다 */
export type SceneHtmlRenderer = (args: {
  problem: ExplainProblemInput;
  explanation: Explanation;
}) => Promise<string | null>;

export interface ExplainProblemDeps {
  /**
   * 호출 E 렌더러(`lib/scene/html.ts` 소관 — player-builder).
   *
   * 주입으로 받는 이유 둘: (1) 파이프라인이 2단 구현에 컴파일 타임으로 묶이지 않는다.
   * (2) 흐름 테스트(재시도·held 분기)를 실호출 없이 스텁으로 돌릴 수 있다.
   * 넘기지 않으면 2단은 만들지 않고 `sceneTier: 'none'`이 된다.
   */
  renderSceneHtml?: SceneHtmlRenderer | null;
}

/**
 * 문제 1개 → 3막 설명 + 답 검증 (§5-3).
 *
 * 흐름: B와 C를 나란히 호출 → 답 비교 + 장면 검산 → 어긋나면 **1회만** 재시도
 * (재시도 때는 검산도 새로 해서 "같은 답을 두 번 독립 확인") → `ok`/`held` 판정.
 *
 * 비용: 문제 1개 = 2~4회 호출(+2단이면 E 1회). **페이지 전체를 자동으로 도는 경로를 만들지 마라**(§8).
 */
export async function explainProblem(
  input: ExplainProblemInput,
  deps: ExplainProblemDeps = {},
): Promise<ExplainProblemResult> {
  const problem: VerifyUserMessageInput = { text: input.text, figureDesc: input.figureDesc ?? null };

  // B(설명)와 C(검산)를 동시에 띄운다. C는 B의 결과를 입력으로 쓰지 않으므로 순서 의존이 없고,
  // 순차로 돌리면 지연만 두 배가 된다.
  const [b1, c1] = await Promise.all([callExplain(input), safeAnswerCheck(problem)]);

  let explanation = b1;
  let check = c1;
  let attempts = 1;
  let answerMatch = matches(explanation.answer, check);
  let sceneErrors = explanation.scene ? verifyScene(explanation.scene, explanation.answer) : [];

  if (!answerMatch || sceneErrors.length > 0) {
    // 재시도는 1회. 실호출 비용이 곱으로 늘고, 두 번 실패한 문제는 세 번째도 대개 실패한다.
    attempts = 2;
    const retryNote = buildRetryNote(explanation.answer, check, sceneErrors);
    const [b2, c2] = await Promise.all([
      callExplain({ ...input, retryNote }),
      // 검산도 새로 — 입력은 처음과 **글자 단위로 같다**(retryNote를 넘기지 않는다).
      // 재시도 맥락을 알려주면 그것 자체가 앵커가 되어 독립성이 사라진다.
      safeAnswerCheck(problem),
    ]);
    explanation = b2;
    // 두 번의 검산이 서로 같고, 그 답이 새 B와도 같아야 통과다 (§5-3).
    // 첫 검산이 실패·미해결이면 여기서 자연히 불일치가 되어 held로 간다 — 안전한 방향이다.
    answerMatch = matches(explanation.answer, c2) && matchesChecks(check, c2);
    check = c2;
    sceneErrors = explanation.scene ? verifyScene(explanation.scene, explanation.answer) : [];
  }

  const heldReasons: HeldReason[] = [];
  if (!answerMatch) {
    if (check.failed) heldReasons.push("verifier-failed");
    else if (!check.solvable) heldReasons.push("verifier-unsolvable");
    else heldReasons.push("answer-mismatch");
  }

  // ── 부가물 버리기 — 어긋난 자리만 비우고 3막 텍스트는 살린다 ──────────────────────────
  //
  // 장면: 그림 하나 때문에 설명을 통째로 날릴 이유가 없다(§5-3).
  // 통찰: **삼자 대조**(§10-3). 호출 C(독립 검산)에 더해 `insight.answer`가 세 번째 눈이다.
  //   B·C는 같은데 통찰만 다르면 **통찰만 버린다.** `held`로 만들지 않는다 — 통찰은 부가물이고
  //   다수결(B·C 일치)이 이미 답을 뒷받침한다. 부가물의 오류가 본체를 죽이지 않는다.
  //
  // **이 자리에 둔 이유**: 재시도가 일어났다면 `explanation`은 이미 **재시도 후의 B**다.
  // `sceneErrors`가 재시도 뒤 다시 계산되는 것과 같은 이유로 통찰도 마지막 B의 것을 대조해야
  // 한다. 첫 B의 통찰만 보고 재시도 결과를 그냥 두면 **검사되지 않은 통찰이 화면에 나간다.**
  //
  // `compare()`는 §5-2 구현(`lib/scene/verify.ts`)을 그대로 쓴다. 통찰 전용 비교 함수를 새로
  // 만들면 두 판정이 언젠가 갈리고, 그때 어느 쪽이 옳은지 아무도 모른다.
  //
  // `!= null`인 이유: 모델이 통찰을 안 낸 정상 출력(null, §10-2)과 `insight` 이전에 저장된
  // 옛 레코드(undefined)를 함께 "없음"으로 본다. **없는 것은 버린 것이 아니다** → false.
  const insightDropped =
    explanation.insight != null && !compare(explanation.insight.answer, explanation.answer);

  // 입력 객체를 그 자리에서 바꾸지 않고 새 객체로 만든다(호출자가 원본을 로그·eval에 쓴다).
  let content: Explanation = explanation;
  if (sceneErrors.length > 0) content = { ...content, scene: null };
  if (insightDropped) content = { ...content, insight: null };

  // AI가 스스로 자신 없다고 하면(§3-1 절대 규칙 1) 답이 맞아 보여도 보류다.
  if (content.confidence === "low") heldReasons.push("low-confidence");
  const status: "ok" | "held" = heldReasons.length === 0 ? "ok" : "held";

  let sceneHtml: string | null = null;
  if (status === "ok" && !content.scene && content.sceneHtmlRequest && deps.renderSceneHtml) {
    // 보류된 문제에는 2단 그림을 만들지 않는다 — 틀릴 수 있는 답을 그림으로 한 번 더 주장하게
    // 되고, 호출 E는 이 파이프라인에서 가장 비싼 호출이다(출력 한도 ~8,000).
    try {
      sceneHtml = (await deps.renderSceneHtml({ problem: input, explanation: content })) ?? null;
    } catch {
      sceneHtml = null; // §5-3 "실패 시 null" — 그림이 없다고 설명까지 잃지 않는다
    }
  }

  const sceneTier: SceneTier = content.scene ? "typed" : sceneHtml ? "html" : "none";

  // §8 운영 로그: 유형별 held 비율을 보려면 problemPattern·status·attempts가 함께 있어야 한다.
  // 특정 유형에서 held가 잦으면 **그 유형 프롬프트를 손볼 신호**다 — 검산을 느슨하게 할 신호가 아니다.
  console.log(
    JSON.stringify({
      call: "math-pipeline",
      problemPattern: content.problemPattern,
      status,
      attempts,
      answerMatch,
      sceneCheck: sceneErrors.length === 0,
      sceneErrorCount: sceneErrors.length,
      // 통찰이 "있었는가"와 "버려졌는가"를 함께 남긴다 — 둘이 있어야 §10-3이 말한
      // "어느 유형에서 통찰이 자주 어긋나는지"를 비율로 낼 수 있다(분모 없이 분자만으론 못 본다).
      insightPresent: explanation.insight != null,
      insightDropped,
      heldReasons,
      sceneTier,
    }),
  );

  return {
    content,
    sceneHtml,
    sceneTier,
    verify: {
      status,
      answerMatch,
      sceneCheck: sceneErrors.length === 0,
      attempts,
      sceneErrors,
      insightDropped,
      heldReasons,
      checkAnswer: check.solvable ? check.answer : null,
    },
  };
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

/** 실패해도 던지지 않는 검산 결과. C가 죽어도 3막 설명은 살리고 held로 내보내기 위해서다 */
interface CheckOutcome extends AnswerCheck {
  /** 호출 자체가 실패했는가 (네트워크·스키마 2회 실패 등) */
  failed: boolean;
  errorMessage: string | null;
}

async function safeAnswerCheck(problem: VerifyUserMessageInput): Promise<CheckOutcome> {
  try {
    const check = await callAnswerCheck(problem);
    return { ...check, failed: false, errorMessage: null };
  } catch (err) {
    // 심판이 없다고 선수 말을 믿을 수는 없다 → 불일치로 두고 held.
    // 여기서 throw하면 설명 전체를 잃는다(§5-3은 텍스트를 살리는 쪽이다).
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[math-pipeline] 검산 호출 실패 — 보류로 처리합니다: ${errorMessage}`);
    return { solvable: false, answer: [], failed: true, errorMessage };
  }
}

/** B의 답 ↔ 검산 결과. 확정 못 했거나(solvable false) 호출이 실패했으면 불일치다 */
function matches(answer: readonly AnswerItem[], check: CheckOutcome): boolean {
  if (check.failed || !check.solvable) return false;
  return compare(answer, check.answer);
}

/** 검산 두 번끼리의 일치 (§5-3 `compare(c.answer, c2.answer)`) */
function matchesChecks(a: CheckOutcome, b: CheckOutcome): boolean {
  if (a.failed || b.failed || !a.solvable || !b.solvable) return false;
  return compare(a.answer, b.answer);
}

/**
 * 재시도 지시문 (§5-3). **사유가 모호하면 재시도가 같은 실수를 반복한다** —
 * `verifyScene`이 준 "어느 단계·어느 인덱스·기대값·실제값"을 그대로 싣는다.
 */
function buildRetryNote(
  answer: readonly AnswerItem[],
  check: CheckOutcome,
  sceneErrors: readonly string[],
): string {
  const parts: string[] = [];
  if (check.failed) {
    parts.push(`이전 답 ${formatAnswer(answer)}를 독립 검산으로 확인하지 못했다(검산 호출 실패).`);
  } else if (!check.solvable) {
    parts.push(`이전 답 ${formatAnswer(answer)}에 대해 독립 검산이 "답을 확정할 수 없다"고 했다.`);
  } else if (!compare(answer, check.answer)) {
    parts.push(`이전 답 ${formatAnswer(answer)}가 독립 검산 ${formatAnswer(check.answer)}와 다르다.`);
  }
  if (sceneErrors.length > 0) {
    parts.push(`장면 검산 오류가 있었다: ${sceneErrors.join(" / ")}`);
  }
  parts.push("문제를 처음부터 다시 풀어라. 장면 대본의 숫자도 다시 계산해서 맞춰라.");
  return parts.join(" ");
}

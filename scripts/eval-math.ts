/**
 * scripts/eval-math.ts — 수학코치 설명 품질 평가 하네스 (docs/harness/math.md §7)
 *
 * 프롬프트를 고칠 때마다 돌리는 회귀 테스트. **픽스처는 은우가 실제로 푸는 교재에서 뽑는다** —
 * 합성 문제로는 이 아이의 오답 패턴을 재현할 수 없다(§7).
 *
 * 실행: npm run eval:math   — OPENAI_API_KEY 필요.
 *   비용: 문제 1개 = B + C (재시도 시 ×2) = **2~4회**. 픽스처 4개면 8~16회.
 *   영어(3회)보다 훨씬 비싸다. 돌리기 전에 아래 플래그로 범위를 좁혀라.
 *
 * | 환경 변수 | 효과 | 실호출 |
 * |---|---|---|
 * | `EVAL_OFFLINE_ONLY=1` | 오프라인 점검만 하고 끝낸다 (네트워크 차단까지 건다) | **0회** |
 * | `EVAL_ONLY=id,id`     | 지정한 픽스처만 돌린다                          | 2~4회/개 |
 * | `EVAL_SKIP_2DAN=1`    | 2단(호출 E) 대상 픽스처를 건너뛴다              | 6~12회 |
 * | (없음)                | 픽스처 4개 전부                                 | 8~16회 |
 *
 * **[M5] 점검 11(두 번째 풀이 insight)** — §10-5. 픽스처를 두 갈래로 나눠 잰다:
 *   통찰이 있는 문제(`ruler-eraser`)는 insight가 있어야 하고, 정석이 최단인 문제(`ribbon-hairpin`)는
 *   **insight가 null이어야 통과**한다. 억지 생성을 실패로 세는 것이 이 점검의 요점이다(§10-2).
 *   실호출 없이 도는 짝은 O6(프롬프트 문안)·O7(zod 제약)이다.
 *
 * **[M2.5] 점검 9(2단 그림)** — §3-4. `rect-count` **한 픽스처에만** 건다(§7이 그 픽스처를 2단
 *   담당으로 지목한다). 파이프라인에 호출 E 렌더러를 주입해 실제로 HTML을 받아 오고, 받은 것을
 *   9-B~9-F로 다시 잰다. **전체 픽스처에 걸지 마라** — 호출 E는 출력 한도 8,000의 가장 비싼
 *   호출이고 §8의 비용 구조가 호출 수에 곧바로 걸린다.
 *
 *   재는 것: `sceneTier==='html'`(9-B) · 정적 검사(9-C) · **답 태그 대조**(9-D, §5-2 `compare()`) ·
 *   단계 수 3~8(9-E) · srcdoc 조립(9-F).
 *   **못 재는 것: "headless iframe 3초 내 'ready'"(9-G는 언제나 SKIP).** playwright/puppeteer가
 *   devDependency에 없고 **eval에 브라우저 의존을 새로 들이지 않기로 했다**(CI는 `npm ci`→`tsc`→
 *   `build`만 돈다). 단계 수는 브라우저 대신 `Kit.mount(steps)`의 인자 길이를 세어 대신한다 —
 *   kit.js가 `ready`에 싣는 `steps.length`와 **같은 값**이다(`public/player-kit/kit.js`).
 *   조용히 빼면 다음 사람이 "검증됐다"고 오해하므로 9-G 행은 지우지 말고 SKIP으로 남겨 둔다.
 *   실호출 없이 도는 짝은 O8(스텁으로 9-B~9-F 판정을 실증)이다.
 *
 * **O9(프롬프트 ↔ 스펙 원문 대조)** — 이 파일의 프롬프트 상수가 `docs/harness/math.md`의 코드블록과
 *   글자 단위로 같은지를 **파일을 읽어서** 확인한다. O4·O6이 재는 것은 프롬프트↔`schemas.ts`의
 *   다이얼 상수이지 스펙 문서가 아니다. 방식·정규화 범위·제외 사유는 `scripts/spec-sync.ts`와
 *   아래 O9 절의 주석에 있다.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  ACT2_STEPS_RANGE,
  ACT3_CHECKS_RANGE,
  INSIGHT_STEPS_RANGE,
  PLAYER_STEPS_RANGE,
  PROBLEM_PATTERNS,
  RULES_RANGE,
  SCENE_STEPS_RANGE,
  STEP_SAY_MAX_CHARS,
  makeExplanationSchema,
  type ChildGrade,
  type Explanation,
  type Insight,
  type ProblemPattern,
} from "../lib/ai/math/schemas";
import {
  EXPLAIN_SYSTEM_PROMPT,
  PLAYER_HTML_FEWSHOT,
  PLAYER_HTML_SYSTEM_PROMPT,
  PRACTICE_SYSTEM_PROMPT,
  WORKSHEET_EXTRACT_SYSTEM_PROMPT,
  WORKSHEET_EXTRACT_USER_TEXT,
  buildExplainUserMessage,
  buildExplainUserParts,
  type ExplainUserMessageInput,
} from "../lib/ai/math/prompts";
import {
  VERIFY_SYSTEM_PROMPT,
  buildVerifyUserMessage,
  buildVerifyUserParts,
  explainProblem,
  type ExplainProblemResult,
} from "../lib/ai/math/pipeline";
import type { UserContentPart } from "../lib/ai/client";
import {
  checkSpecSync,
  extractSpecBlocks,
  normalizeForCompare,
  printSpecSyncDetails,
  type SpecSyncOutcome,
  type SpecSyncTarget,
} from "./spec-sync";
// 호출 E 렌더러 — **주입은 2단 픽스처에서만 한다**(main 참고). import만으로는 호출이 나가지 않는다
// (`getOpenAIClient()`는 지연 생성이고, 이 파일은 직접 실행일 때만 main을 돈다).
import { renderSceneHtml } from "../lib/ai/math/player";
import {
  SCENE_IFRAME_CSP,
  SCENE_IFRAME_SANDBOX,
  SCENE_READY_TIMEOUT_MS,
  buildSceneSrcdoc,
  inspectSceneHtml,
} from "../lib/scene/html";
import { compare, formatAnswer, verifyScene } from "../lib/scene/verify";
import type {
  AnswerItem,
  BarLayout,
  Scene,
  SceneKind,
  SceneStep,
  SceneStepMode,
} from "../lib/scene/types";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다.
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
}

// ---------------------------------------------------------------------------
// 비용 게이트 — 여기가 이 파일에서 가장 중요한 20줄이다.
//
// 과거에 "키가 없으니 실호출은 안 나겠지" 하고 돌렸다가 `.env`의 실키가 로드돼 돈이 나간 사고가
// 있었다. 그래서 **환경 변수 하나로 오프라인을 명시**하게 하고(§main의 이른 return),
// 그 게이트가 뚫리더라도 돈이 나가지 않도록 **네트워크 자체를 막는 2차 방어선**을 여기 둔다.
// (openai SDK는 전역 fetch를 쓴다 — 클라이언트는 지연 생성이라 이 시점에 아직 만들어지지 않았다.)
// ---------------------------------------------------------------------------
const OFFLINE_ONLY = process.env.EVAL_OFFLINE_ONLY === "1";
if (OFFLINE_ONLY) {
  const blocked = () => {
    throw new Error(
      "EVAL_OFFLINE_ONLY=1 — 네트워크 호출이 차단됐습니다. 오프라인 점검 앞에 실호출 코드가 들어왔습니다.",
    );
  };
  globalThis.fetch = blocked as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// 픽스처 — §7 표의 4종
//
// 출처는 은우가 실제로 푸는 교재이고, `childAnswer`는 **실제 오답 그대로**다(§0).
// 문제 문장 원문은 스펙에 실려 있지 않아(§7은 출처·유형·지키는 것만 적는다) 아래 문장은
// §0의 오답 표와 §7의 유형 설명이 성립하도록 복원한 것이다 — 숫자와 구조는 §0 그대로.
// 교재 실물을 다시 볼 기회가 있으면 문장을 원문으로 교체하되 **숫자는 바꾸지 마라.**
// 점검 5·10과 §4-9 split 검산이 전부 이 숫자에 걸려 있다.
// ---------------------------------------------------------------------------

type ExpectedScene =
  /** 종류까지 고정된 1단 장면 (§7이 명시한 것만) */
  | { kind: SceneKind; layout: BarLayout | null }
  /** 1단 여부를 스펙이 고정하지 않은 픽스처 — 검산 통과만 본다 */
  | "unpinned"
  /** 장면이 없어야 한다 (2단 대상) */
  | null;

/**
 * 점검 11 [M5] — 두 번째 풀이(§10-5 표).
 *
 * - `required`  : 통찰이 있는 문제. `insight != null` · 답 일치 · act2보다 짧음.
 * - `absent`    : **정석이 곧 최단인 문제.** `insight == null`이면 통과 —
 *                 §10-2대로 **억지 생성을 실패로 센다.** 여기서 FAIL이 나면 코드 버그가 아니라
 *                 "억지로 만들지 마라"가 프롬프트에서 덜 먹혔다는 뜻이다(prompt-tuner 신호).
 * - `unpinned`  : 스펙이 이 문제의 통찰 유무를 고정하지 않았다. 있으면 모양만 보고, 없어도 통과.
 */
type ExpectedInsight = "required" | "absent" | "unpinned";

/** 점검 10 — [개정 1]이 실제로 살아 있는지 재는 항목. 픽스처마다 재는 대상이 다르다 */
type Revision1Probe =
  | { kind: "moves-arrow"; names: [string, string] }
  | { kind: "difference-split"; amount: number };

export interface Fixture {
  id: string;
  /** 표에 찍히는 이름 */
  label: string;
  /** 교재 출처 (§7 표) */
  source: string;
  problem: ExplainUserMessageInput;
  expectedAnswer: AnswerItem[];
  expectedPattern: ProblemPattern;
  expectedScene: ExpectedScene;
  /**
   * 점검 4 — 함정 핵심어. 바깥 배열은 AND, 안쪽 배열은 OR(같은 뜻의 다른 말).
   * null이면 이 픽스처의 함정을 스펙이 고정하지 않았다는 뜻 — 점검하지 않는다(§7 "expectedTrap이 있으면").
   */
  expectedTrapKeywords: string[][] | null;
  /** 점검 5 — 채점 결과 (§7) */
  expectedGrade: ChildGrade;
  /** 점검 9-A — 2단 요청 여부 (§7: 1단 픽스처에서는 false) */
  expectSceneHtmlRequest: boolean;
  /** 점검 10 — [개정 1] 실증 대상. 없으면 해당 없음 */
  revision1: Revision1Probe | null;
  /** 점검 11 [M5] — 두 번째 풀이 기대 (§10-5) */
  expectedInsight: ExpectedInsight;
}

export const FIXTURES: Fixture[] = [
  {
    id: "pencil-transfer",
    label: "pencil-transfer",
    source: "소마 Premier 초급4 L1-05",
    problem: {
      number: "05",
      text: "민희가 철희에게 연필 3자루를 주었더니 두 사람의 연필이 각각 10자루가 되었습니다. 처음에 민희와 철희는 연필을 각각 몇 자루씩 가지고 있었을까요?",
      figureDesc: null,
      givens: [
        { label: "민희가 철희에게 준 연필", value: 3, unit: "자루" },
        { label: "나중 민희", value: 10, unit: "자루" },
        { label: "나중 철희", value: 10, unit: "자루" },
      ],
      // 은우 실제 오답 — 준 쪽은 맞고 **받은 쪽 방향을 뒤집었다**(§0). 한 사람만 맞아 'partial'이다.
      childAnswer: "민희 13자루, 철희 11자루",
      childWork: null,
    },
    expectedAnswer: [
      { label: "민희", value: 13, unit: "자루" },
      { label: "철희", value: 7, unit: "자루" },
    ],
    expectedPattern: "rewind-transfer",
    expectedScene: { kind: "containers", layout: null },
    // 이 문제의 함정은 "누가 누구에게" — 은우가 가장 자주 틀리는 지점이다(§3-1 [이 아이에 대해])
    expectedTrapKeywords: [["방향", "받은", "받는", "누구에게", "거꾸로", "반대"]],
    expectedGrade: "partial",
    expectSceneHtmlRequest: false,
    revision1: { kind: "moves-arrow", names: ["민희", "철희"] },
    // 합(20자루)이 보존되는 문제라 "전체에서 빼기"류의 통찰이 성립할 수도 있다.
    // §10-5 표가 이 문제를 어느 갈래로도 지정하지 않았으므로 유무를 고정하지 않는다.
    expectedInsight: "unpinned",
  },
  {
    id: "ruler-eraser",
    label: "ruler-eraser",
    source: "소마 Premier 초급4 L1-03",
    problem: {
      number: "03",
      text: "자와 지우개를 합해 900원입니다. 자가 지우개보다 300원 비쌉니다. 각각 얼마일까요?",
      figureDesc: null,
      givens: [
        { label: "자와 지우개의 합", value: 900, unit: "원" },
        { label: "자가 더 비싼 만큼", value: 300, unit: "원" },
      ],
      // 은우 실제 오답 — 900÷2로 반씩 나눠 **차 조건을 안 썼다**(§0). 둘 다 틀려 'wrong'이다.
      childAnswer: "자 450원, 지우개 150원",
      childWork: "900÷2=450",
    },
    expectedAnswer: [
      { label: "자", value: 600, unit: "원" },
      { label: "지우개", value: 300, unit: "원" },
    ],
    expectedPattern: "part-whole",
    expectedScene: { kind: "bar", layout: "compare" },
    expectedTrapKeywords: [
      ["합", "전체", "모두"],
      ["차", "차이"],
    ],
    expectedGrade: "wrong",
    expectSceneHtmlRequest: false,
    revision1: { kind: "difference-split", amount: 300 },
    // §10-5 표의 (a) 갈래 그 자체 — "합·차 → 차를 먼저 떼기". 통찰이 있어야 하는 문제다.
    expectedInsight: "required",
  },
  {
    id: "ribbon-hairpin",
    label: "ribbon-hairpin",
    source: "Math Master 3-1 p.55-12",
    problem: {
      number: "12",
      text: "리본 한 개를 만드는 데 색 테이프가 8cm 필요합니다. 머리핀 한 개를 만드는 데는 리본 한 개의 3배만큼 필요합니다. 색 테이프 96cm로 머리핀을 몇 개 만들 수 있는지 풀이 과정을 쓰고 답을 구하세요.",
      figureDesc: null,
      givens: [
        { label: "리본 한 개", value: 8, unit: "cm" },
        { label: "머리핀은 리본의", value: 3, unit: "배" },
        { label: "색 테이프 전체", value: 96, unit: "cm" },
      ],
      // §7: 서술형 · **childAnswer null 경로**(아이가 손을 못 댄 문제) → 채점은 'none'
      childAnswer: null,
      childWork: null,
    },
    expectedAnswer: [{ label: "머리핀", value: 4, unit: "개" }],
    expectedPattern: "multiple",
    // §7이 이 픽스처의 1단 종류를 고정하지 않았다. 임의로 못 박으면 정상 출력을 실패로 만든다.
    expectedScene: "unpinned",
    expectedTrapKeywords: null,
    expectedGrade: "none",
    expectSceneHtmlRequest: false,
    revision1: null,
    // 원래 §10-5 표의 (b) 갈래(정석이 최단)로 배정했으나 **실호출 결과를 보고 되돌렸다.**
    // 모델이 낸 통찰: "머리핀 하나마다 24cm씩 떼면 돼" → 8×3=24, 96÷24=4.
    // 계산 횟수는 정석(96÷8=12, 12÷3=4)과 같지만, **단위를 '리본 조각'에서
    // '머리핀 한 개분'으로 바꿔 나눗셈 한 번으로 끝내는** 것은 아이에게 다른 생각이다.
    // 억지 논리가 아니므로 실패로 셀 수 없다 — 사람 판단으로 unpinned로 내린다.
    //
    // **주의: 이 저장소에 `absent` 갈래 픽스처가 지금 하나도 없다.** 판정 코드(§10-5 (b))는
    // 살아 있지만 아무도 그것을 밟지 않으므로, 억지 생성 감시는 당분간 실사용 관찰이 맡는다.
    // "정석이 곧 최단"이 분명한 문제를 만나면 그 픽스처를 absent로 배정하라.
    expectedInsight: "unpinned",
  },
  {
    id: "rect-count",
    label: "rect-count (2단)",
    source: "소마 Premier 초급4 L2-04",
    problem: {
      number: "04",
      text: "작은 정사각형 6개를 가로로 한 줄로 이어 붙였습니다. 이 그림에서 찾을 수 있는 크고 작은 직사각형은 모두 몇 개인지 빠짐없이, 중복 없이 세어 구하세요.",
      figureDesc: "같은 크기의 작은 정사각형 6개가 가로 한 줄로 빈틈없이 붙어 있는 그림",
      givens: [{ label: "작은 정사각형", value: 6, unit: "개" }],
      childAnswer: null,
      childWork: null,
    },
    // 가로 1×6 띠에서 직사각형 개수 = 세로선 7개 중 2개 고르기 = 21
    expectedAnswer: [{ label: "직사각형", value: 21, unit: "개" }],
    expectedPattern: "counting",
    expectedScene: null, // 2단 대상 — scene은 null이어야 한다
    expectedTrapKeywords: null,
    expectedGrade: "none",
    expectSceneHtmlRequest: true,
    revision1: null,
    // 세기 문제에는 "선을 고른다"류의 통찰이 있지만 초3에게 통할지는 스펙이 정하지 않았다.
    expectedInsight: "unpinned",
  },
];

/** 2단(호출 E) 대상 픽스처 id — EVAL_SKIP_2DAN이 건너뛰는 대상 */
const TWO_TIER_FIXTURE_IDS = new Set(
  FIXTURES.filter((f) => f.expectSceneHtmlRequest).map((f) => f.id),
);

// ---------------------------------------------------------------------------
// 점검 결과
// ---------------------------------------------------------------------------

export type Status = "pass" | "fail" | "skip";

export interface CheckResult {
  fixture: string;
  check: string;
  status: Status;
  detail: string;
}

function statusLabel(status: Status): string {
  return status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
}

// ---------------------------------------------------------------------------
// 텍스트 유틸
// ---------------------------------------------------------------------------

/** 글자 수 — 이모지·한글을 코드 포인트로 센다 */
function charCount(text: string): number {
  return [...text].length;
}

/**
 * 연속된 영어 단어의 최대 길이. 단위(cm, L)나 코드 한 낱말은 통과시키고
 * "문장"만 잡는다 — 한도는 3단어(= 영어 문장으로 읽히기 시작하는 지점).
 */
const ENGLISH_WORD_RUN_LIMIT = 3;

export function longestEnglishWordRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const token of text.split(/[^A-Za-z가-힣0-9]+/)) {
    if (token === "") continue;
    if (/^[A-Za-z]{2,}$/.test(token)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/** 화살표 — §7 점검 10과 §3-1 프롬프트가 쓰는 문자는 "→"다 */
const ARROW = "→";
/** 다른 화살표 표기를 썼는지 알려주기 위한 목록 (통과시키지는 않는다) */
const ARROW_LOOKALIKES = ["->", "⇒", "➡", "⟶", "=>", "▶"];

// ---------------------------------------------------------------------------
// 픽스처별 점검 1~10 (§7 표)
// ---------------------------------------------------------------------------

export function runFixtureChecks(fixture: Fixture, result: ExplainProblemResult): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, status: Status, detail: string) =>
    results.push({ fixture: fixture.label, check, status, detail });
  const pass = (check: string, ok: boolean, detail: string) =>
    add(check, ok ? "pass" : "fail", detail);

  const content: Explanation = result.content;
  const expected = fixture.expectedAnswer;

  // --- 1. 답 정확도 — B와 C의 답이 fixture.expectedAnswer와 **모두** 일치 ---
  // 비교는 파이프라인이 쓰는 §5-2 `compare()` 그대로다(4중 정의 동기화). 라벨 표기가 달라
  // 떨어지는 경우를 사람이 바로 알아보도록 양쪽 답을 원문으로 찍는다.
  const bMatch = compare(content.answer, expected);
  const checkAnswer = result.verify.checkAnswer;
  const cMatch = checkAnswer !== null && compare(checkAnswer, expected);
  pass(
    "1. 답 정확도 (B·C 모두 기대 답과 일치)",
    bMatch && cMatch,
    `기대=${formatAnswer(expected)} / B=${formatAnswer(content.answer)} / C=${
      checkAnswer ? formatAnswer(checkAnswer) : "없음(검산 실패·미확정)"
    }`,
  );

  // --- 2. 장면 검산 — verifyScene 오류 0, kind·layout이 기대와 일치 ---
  // 주의: 장면 검산이 실패하면 파이프라인이 §5-3대로 scene을 null로 만든다(텍스트는 살린다).
  //       그래서 "오류 0"은 result.verify.sceneCheck로 본다.
  // 주의: §4-7(보존량)은 'split' 단계를 제외한다 — 여기서 합을 따로 다시 재지 않는다.
  //       재면 정상 합·차 대본이 100% 오탐된다. 검산은 verifyScene 하나에만 맡긴다.
  const sceneErrors = result.verify.sceneErrors;
  if (!result.verify.sceneCheck) {
    add("2. 장면 검산 (오류 0 · kind·layout 일치)", "fail", `verifyScene 오류: ${sceneErrors.join(" / ")}`);
  } else if (fixture.expectedScene === null) {
    pass(
      "2. 장면 검산 (2단 대상이라 scene은 null이어야 함)",
      content.scene === null,
      content.scene === null ? "scene=null (2단 경로)" : `scene이 있다: kind=${content.scene.kind}`,
    );
  } else if (fixture.expectedScene === "unpinned") {
    add(
      "2. 장면 검산 (오류 0 · 종류는 스펙 미고정)",
      "pass",
      content.scene ? `verifyScene 오류 0 · kind=${content.scene.kind}` : "scene 없음 (오류 0)",
    );
  } else {
    const want = fixture.expectedScene;
    const got = content.scene;
    const ok = got !== null && got.kind === want.kind && got.layout === want.layout;
    pass(
      `2. 장면 검산 (오류 0 · kind=${want.kind}·layout=${want.layout ?? "null"})`,
      ok,
      got === null
        ? "scene이 없다 (1단으로 그려야 하는 픽스처다)"
        : `kind=${got.kind} · layout=${got.layout ?? "null"} · steps ${got.steps.length}개`,
    );
  }

  // --- 3. 유형 분류 ---
  pass(
    `3. 유형 분류 (${fixture.expectedPattern})`,
    content.problemPattern === fixture.expectedPattern,
    `problemPattern=${content.problemPattern} · patternNameKo="${content.patternNameKo}"`,
  );

  // --- 4. 함정 감지 — expectedTrap이 있으면 trap이 null이 아니고 핵심어 포함 ---
  if (fixture.expectedTrapKeywords === null) {
    add("4. 함정 감지", "skip", "이 픽스처의 함정은 스펙이 고정하지 않았다 (§7 \"expectedTrap이 있으면\")");
  } else {
    const trap = content.act1.trap;
    const missing = trap
      ? fixture.expectedTrapKeywords.filter((group) => !group.some((word) => trap.includes(word)))
      : fixture.expectedTrapKeywords;
    pass(
      "4. 함정 감지 (trap 있음 + 핵심어 포함)",
      trap !== null && missing.length === 0,
      trap === null
        ? "trap=null — 이 문제에는 함정이 있다"
        : missing.length === 0
          ? `trap="${trap}"`
          : `trap="${trap}" — 빠진 핵심어: ${missing.map((g) => g.join("|")).join(", ")}`,
    );
  }

  // --- 5. 채점 ---
  pass(
    `5. 채점 (${fixture.expectedGrade})`,
    content.childGrade === fixture.expectedGrade,
    `childGrade=${content.childGrade} · gradeNote=${
      content.gradeNote ? `"${content.gradeNote}"` : "없음"
    }`,
  );

  // --- 6. 말투 길이 — 말풍선 ≤ 60자, act1 각 항목 ≤ 40자, 영어 문장 없음 ---
  // 상한 60은 `schemas.ts`의 STEP_SAY_MAX_CHARS 하나에서 온다 — zod(insight.stepsKo)·프롬프트
  // 문구(§10-6)·이 점검이 같은 숫자를 봐야 act2 다이얼을 튜닝했을 때 통찰만 어긋나는 일이 없다.
  // **[M5] insight.stepsKo도 같은 잣대로 잰다.** 아이가 읽는 말풍선인 것은 act2와 다르지 않다.
  const ACT1_ITEM_MAX = 40;
  const act1Items: { where: string; text: string }[] = [
    ...content.act1.castKo.map((t, i) => ({ where: `castKo[${i}]`, text: t })),
    ...content.act1.movesKo.map((t, i) => ({ where: `movesKo[${i}]`, text: t })),
    { where: "endSceneKo", text: content.act1.endSceneKo },
    { where: "goalKo", text: content.act1.goalKo },
    ...(content.act1.trap ? [{ where: "trap", text: content.act1.trap }] : []),
  ];
  const sayItems = [
    ...content.act2.steps.map((s, i) => ({ where: `act2.steps[${i}].say`, text: s.say })),
    // insight가 null이면 빈 배열 — 없는 것이 정답인 경로(§10-2)를 이 점검이 벌하지 않는다.
    ...(content.insight?.stepsKo ?? []).map((t, i) => ({ where: `insight.stepsKo[${i}]`, text: t })),
  ];

  const longAct1 = act1Items.filter((it) => charCount(it.text) > ACT1_ITEM_MAX);
  const longSay = sayItems.filter((it) => charCount(it.text) > STEP_SAY_MAX_CHARS);
  const englishHits = [...act1Items, ...sayItems].filter(
    (it) => longestEnglishWordRun(it.text) >= ENGLISH_WORD_RUN_LIMIT,
  );
  const lengthDetail = [
    longAct1.length > 0
      ? `act1 초과: ${longAct1.map((it) => `${it.where}(${charCount(it.text)}자)`).join(", ")}`
      : null,
    longSay.length > 0
      ? `말풍선 초과: ${longSay.map((it) => `${it.where}(${charCount(it.text)}자)`).join(", ")}`
      : null,
    englishHits.length > 0
      ? `영어 문장: ${englishHits.map((it) => `${it.where}="${it.text}"`).join(" / ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" / ");
  pass(
    `6. 말투 길이 (act2 say·insight 단계 ≤${STEP_SAY_MAX_CHARS}자 · act1 항목 ≤${ACT1_ITEM_MAX}자 · 영어 문장 없음)`,
    longAct1.length === 0 && longSay.length === 0 && englishHits.length === 0,
    lengthDetail ||
      `act1 최장 ${Math.max(0, ...act1Items.map((it) => charCount(it.text)))}자 · 말풍선 최장 ${Math.max(
        0,
        ...sayItems.map((it) => charCount(it.text)),
      )}자`,
  );

  // --- 7. 구조 개수 — steps 3~6, checks 2~3, rules 2~3, act3 첫 check 제목에 "다시" ---
  // 구간은 schemas.ts의 다이얼 상수에서 가져온다 — 프롬프트·zod·eval이 같은 숫자를 봐야 한다.
  const stepsOk = inRange(content.act2.steps.length, ACT2_STEPS_RANGE);
  const checksOk = inRange(content.act3.checks.length, ACT3_CHECKS_RANGE);
  const rulesOk = inRange(content.rules.length, RULES_RANGE);
  const firstCheckTitle = content.act3.checks[0]?.titleKo ?? "";
  const replayOk = firstCheckTitle.includes("다시");
  pass(
    `7. 구조 개수 (steps ${rangeText(ACT2_STEPS_RANGE)} · checks ${rangeText(
      ACT3_CHECKS_RANGE,
    )} · rules ${rangeText(RULES_RANGE)} · act3 첫 제목에 "다시")`,
    stepsOk && checksOk && rulesOk && replayOk,
    `steps ${content.act2.steps.length} · checks ${content.act3.checks.length} · rules ${content.rules.length} · act3[0]="${firstCheckTitle}"`,
  );

  // --- 9-A. 2단 요청 여부 (호출 B까지 확인 가능한 부분) ---
  pass(
    `9-A. sceneHtmlRequest === ${fixture.expectSceneHtmlRequest}`,
    content.sceneHtmlRequest === fixture.expectSceneHtmlRequest,
    `sceneHtmlRequest=${content.sceneHtmlRequest} · sceneTier=${result.sceneTier}`,
  );

  // --- 9-B~9-G. 2단 그림 — **2단 픽스처에서만.** 1단 픽스처는 9-A로 끝이다(§7) ---
  if (fixture.expectSceneHtmlRequest) results.push(...runSceneHtmlChecks(fixture, result));

  // --- 10. [개정 1] 방향·차 표현 — 이 eval이 존재하는 이유 ---
  if (fixture.revision1 === null) {
    add("10. [개정 1] 방향·차 표현", "skip", "이 픽스처는 개정 1의 측정 대상이 아니다 (§7)");
  } else if (fixture.revision1.kind === "moves-arrow") {
    // 화살표가 붙은 **그 문장 안에** 두 이름이 다 있어야 방향이 드러난다.
    // (이름이 여기저기 흩어져 있으면 "누가 누구에게"가 보이지 않는다 — 은우가 가장 자주 틀리는 지점)
    const [nameA, nameB] = fixture.revision1.names;
    const moves = content.act1.movesKo;
    const arrowLines = moves.filter((line) => line.includes(ARROW));
    const okLine = arrowLines.find((line) => line.includes(nameA) && line.includes(nameB));
    const lookalike = moves.find((line) => ARROW_LOOKALIKES.some((a) => line.includes(a)));
    pass(
      `10. [개정 1] act1.movesKo에 화살표(${ARROW}) + "${nameA}"·"${nameB}"`,
      okLine !== undefined,
      okLine
        ? `"${okLine}"`
        : arrowLines.length === 0
          ? `화살표(${ARROW}) 없음${lookalike ? ` — 다른 표기를 썼다: "${lookalike}"` : ""} · movesKo=${JSON.stringify(moves)}`
          : `화살표 문장에 두 이름이 다 있지 않다 · movesKo=${JSON.stringify(moves)}`,
    );
  } else {
    const want = fixture.revision1.amount;
    const scene = content.scene;
    const diff = scene?.difference ?? null;
    const splitSteps = scene ? scene.steps.filter((s) => s.mode === "split") : [];
    const ok = scene !== null && diff !== null && diff.amount === want && splitSteps.length > 0;
    pass(
      `10. [개정 1] scene.difference.amount === ${want} + 'split' 단계 존재`,
      ok,
      scene === null
        ? `scene이 없다${sceneErrors.length > 0 ? ` (장면 검산 실패: ${sceneErrors.join(" / ")})` : ""}`
        : `difference=${diff ? `${diff.amount}(${diff.labelKo})` : "null"} · split 단계 ${splitSteps.length}개 · steps=${scene.steps
            .map((s) => s.mode)
            .join("→")}`,
    );
  }

  // --- 11. [M5] 두 번째 풀이 — insight (§10-5) ---
  // **없으면 없는 것이 정답이다.** 억지로 만든 통찰을 통과시키면 아이가 그 억지 논리를 배운다.
  results.push(...insightChecks(fixture, content, result));

  return results;
}

/**
 * 점검 11 [M5] — §10-5 표 두 갈래.
 *
 * 통찰이 있어야 하는 문제: `insight != null` · `insight.answer == answer`(§5-2 `compare()` 그대로) ·
 * `stepsKo.length < act2.steps.length`.
 * 정석이 최단인 문제: `insight == null`이면 통과. 있으면 실패 — 억지 생성이다.
 */
function insightChecks(
  fixture: Fixture,
  content: Explanation,
  result: ExplainProblemResult,
): CheckResult[] {
  const insight: Insight | null = content.insight;
  const out: CheckResult[] = [];
  const add = (check: string, status: Status, detail: string) =>
    out.push({ fixture: fixture.label, check, status, detail });

  // 파이프라인(§10-3 삼자 대조)이 답이 어긋난 통찰을 버렸는지.
  const dropped = result.verify.insightDropped;
  const droppedNote = dropped ? " · 삼자 대조에서 버려짐(insightDropped)" : "";

  if (insight === null) {
    switch (fixture.expectedInsight) {
      case "required":
        add(
          "11. [M5] 두 번째 풀이 (있어야 하는 문제)",
          "fail",
          `insight=null — §10-5가 통찰을 기대하는 문제다${droppedNote}`,
        );
        break;
      case "absent":
        // **"없었다"와 "버렸다"를 가른다.** 모델이 통찰을 억지로 만들었는데 그 답이 3막과 달라
        // 삼자 대조(§10-3)가 버렸다면 `content.insight`는 여기서도 null이다 — 만들지 않은 출력과
        // 모양이 같다. 그것을 통과로 세면 §10-5가 재려는 "억지 생성을 실패로 센다"가 정확히
        // 가장 나쁜 형태(지어낸 지름길 + 틀린 답)에서만 무력해진다.
        // `verify.insightDropped`가 둘을 가르는 유일한 신호다(false=없었다 · true=버렸다).
        add(
          "11. [M5] 두 번째 풀이 (정석이 최단 → null이 정답)",
          dropped ? "fail" : "pass",
          dropped
            ? "억지 생성 — 통찰을 냈으나 답이 3막과 달라 삼자 대조에서 버려졌다(insightDropped) · " +
              "§10-2는 정석이 최단인 문제에서 통찰을 만들지 말라고 한다"
            : "insight=null — 억지로 만들지 않았다 (§10-2)",
        );
        break;
      default:
        add(
          "11. [M5] 두 번째 풀이 (유무 미고정)",
          "pass",
          `insight=null${droppedNote}`,
        );
    }
    return out;
  }

  const summary =
    `"${insight.titleKo}" · ${insight.stepsKo.length}단계(act2 ${content.act2.steps.length}단계) · ` +
    `답 ${formatAnswer(insight.answer)}`;

  if (fixture.expectedInsight === "absent") {
    add(
      "11. [M5] 두 번째 풀이 (정석이 최단 → null이 정답)",
      "fail",
      `억지 생성 — ${summary} / hook="${insight.hookKo}" / steps=${JSON.stringify(insight.stepsKo)}`,
    );
    return out;
  }

  // 답 대조 — 정석의 답과 같아야 한다(§10-3). 라벨 정규화는 §5-2 `compare()` 그대로다.
  const answerOk = compare(insight.answer, content.answer);
  // 통찰이 정석보다 길면 통찰이 아니다(§10-3). zod가 이미 막지만 4중 정의를 여기서도 재 둔다.
  const shorterOk = insight.stepsKo.length < content.act2.steps.length;
  const countOk = inRange(insight.stepsKo.length, INSIGHT_STEPS_RANGE);

  const label =
    fixture.expectedInsight === "required"
      ? `11. [M5] 두 번째 풀이 (있음 · 답 일치 · act2보다 짧음 · ${rangeText(INSIGHT_STEPS_RANGE)}단계)`
      : `11. [M5] 두 번째 풀이 (유무 미고정 — 있으면 모양 점검)`;
  add(
    label,
    answerOk && shorterOk && countOk ? "pass" : "fail",
    [
      answerOk ? null : `답이 3막과 다르다: 3막=${formatAnswer(content.answer)}`,
      shorterOk ? null : "act2보다 짧지 않다 — 또 다른 정석이다",
      countOk ? null : `단계 수가 ${rangeText(INSIGHT_STEPS_RANGE)} 밖이다`,
    ]
      .filter(Boolean)
      .join(" / ") || summary,
  );
  return out;
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return value >= min && value <= max;
}

function rangeText([min, max]: readonly [number, number]): string {
  return `${min}~${max}`;
}

// ---------------------------------------------------------------------------
// 점검 8 — 보류율: 픽스처 전체에서 'held' 0건 (전역 1행)
// ---------------------------------------------------------------------------

export function runHeldCheck(runs: { fixture: Fixture; result: ExplainProblemResult }[]): CheckResult {
  const held = runs.filter((r) => r.result.verify.status === "held");
  return {
    fixture: "(전체)",
    check: "8. 보류율 — 'held' 0건",
    status: held.length === 0 ? "pass" : "fail",
    detail:
      held.length === 0
        ? `${runs.length}건 전부 ok (재시도 ${runs.filter((r) => r.result.verify.attempts > 1).length}건)`
        : held
            .map((r) => `${r.fixture.label}: ${r.result.verify.heldReasons.join(",")}`)
            .join(" / "),
  };
}

// ---------------------------------------------------------------------------
// 점검 9 — 2단 그림 (§7 · §3-4). **`rect-count` 한 픽스처에만 건다.**
//
// 호출 E는 출력 한도 8,000의 가장 비싼 호출이고, 이 점검은 문제당 E를 1~2회(재생성 포함) 더
// 태운다. §7이 `rect-count`를 2단 담당으로 지목했으므로 거기서만 잰다 — 전체 픽스처에 걸면
// §8의 비용 구조가 곧바로 무너진다.
//
// **브라우저를 새로 들이지 않았다.** 스펙은 "headless iframe 3초 내 'ready'"까지 재라고 하지만
// playwright/puppeteer는 devDependency에 없고, eval에 브라우저를 들이면 CI(`npm ci`→`tsc`→`build`)가
// 무거워지고 깨지기 쉬워진다. 그래서 **브라우저 없이 잴 수 있는 것까지 재고(9-B~9-F), 실행 확인은
// 9-G 행에 SKIP으로 남겨 "못 쟀다"를 눈에 보이게 둔다.** 조용히 빼지 마라.
// ---------------------------------------------------------------------------

/**
 * `Kit.mount(steps)`에 넘어간 단계 수 — 브라우저 없이 재는 대역(代役).
 *
 * kit.js는 `mount` 직후 `postMessage({type:'ready', steps: steps.length})`를 보낸다. 즉 여기서 세는
 * 값은 **`ready`가 신고할 값과 같은 숫자**다(모델이 스스로 신고한 `stepCount`가 아니라 실제 배열 길이).
 *
 * 방법: HTML 안의 `<script>`(답 태그 제외)를 `node:vm`의 새 컨텍스트에서 **최상위만** 실행하고
 * `Kit.mount`의 인자를 가로챈다. `render()`는 부르지 않는다(그림을 그리는 것이 목적이 아니다).
 *
 * **`node:vm`은 보안 경계가 아니다.** 여기서 도는 코드는 (a) 개발자만 실행하는 eval에서,
 * (b) 이미 정적 검사를 통과한 HTML의, (c) 최상위 문장뿐이고, (d) 새 컨텍스트에는 `require`·`process`·
 * `fetch`가 없으며, (e) 폭주 루프는 `timeout`이 끊는다. 앱 런타임에서 AI HTML을 실행하는 경로는
 * 여전히 iframe+CSP 하나뿐이다(§3-4) — **이 함수를 그 자리에 쓰지 마라.**
 */
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STEP_COUNT_TIMEOUT_MS = 1_000;

function autoStub(): unknown {
  // 무엇을 물어도 다시 스텁을 주는 만능 대역. AI 코드가 최상위에서 만지는 DOM·Kit 반환값을 받는다.
  const target = function () {} as unknown as object;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      // Promise·전개 연산자에 잘못 걸리지 않게 둘만 비운다 (걸리면 아래 try/catch가 사유를 남긴다)
      if (prop === "then" || prop === Symbol.iterator) return undefined;
      return autoStub();
    },
    apply: () => autoStub(),
    construct: () => autoStub() as object,
    set: () => true,
    has: () => true,
  });
}

export function countMountedSteps(html: string): { count: number | null; note: string } {
  let captured: unknown[] | null = null;
  const kit = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "mount") {
        return (steps: unknown) => {
          if (Array.isArray(steps)) captured = steps;
          return autoStub();
        };
      }
      return autoStub();
    },
  });
  const sandbox: Record<string, unknown> = {
    Kit: kit,
    document: autoStub(),
    window: autoStub(),
    parent: autoStub(),
    self: autoStub(),
    navigator: autoStub(),
    // 새 vm 컨텍스트에는 타이머가 없다. 최상위에서 예약만 하고 실행은 하지 않는다.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    requestAnimationFrame: () => 0,
    console: { log() {}, warn() {}, error() {} },
  };

  const notes: string[] = [];
  SCRIPT_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_TAG_RE.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (/type\s*=\s*(?:"|')?application\/json/i.test(attrs)) continue; // 답 태그는 데이터다
    try {
      runInNewContext(m[2] ?? "", sandbox, { timeout: STEP_COUNT_TIMEOUT_MS });
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (captured === null) {
    return {
      count: null,
      note: notes.join(" / ") || "Kit.mount(steps) 호출을 찾지 못했다",
    };
  }
  return { count: (captured as unknown[]).length, note: notes.join(" / ") };
}

/** 키트 원본 — srcdoc 조립(9-F)에 넣는다. 화면은 fetch로 읽지만 eval은 파일에서 바로 읽는다 */
function readPlayerKit(): { css: string; js: string } {
  const dir = new URL("../public/player-kit/", import.meta.url);
  return {
    css: readFileSync(new URL("kit.css", dir), "utf-8"),
    js: readFileSync(new URL("kit.js", dir), "utf-8"),
  };
}

/**
 * 점검 9 본체 (§3-4 앱 측 처리 1~4번). **순수 함수다 — 실호출을 하지 않는다.**
 * 이미 받아 온 `result.sceneHtml`을 다시 잰다. 그래서 O8이 스텁으로 이 판정을 그대로 실증할 수 있다.
 *
 * 렌더러(`resolveSceneHtml`)가 이미 같은 검사를 하고 실패한 HTML은 null로 돌려주지만, **eval은 그
 * 판정을 믿지 않고 스스로 한 번 더 잰다.** 렌더러가 조용히 느슨해지면 그것을 잡는 것이 이 행의 몫이다.
 */
export function runSceneHtmlChecks(
  fixture: Fixture,
  result: ExplainProblemResult,
): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (check: string, status: Status, detail: string) =>
    out.push({ fixture: fixture.label, check, status, detail });
  const pass = (check: string, ok: boolean, detail: string) =>
    add(check, ok ? "pass" : "fail", detail);

  const html = result.sceneHtml;

  // --- 9-B. 2단이 실제로 만들어졌는가 (§5-3 sceneTier) ---
  const tierOk = result.sceneTier === "html" && html !== null;
  pass(
    "9-B. sceneTier === 'html' (호출 E 결과가 살아남음)",
    tierOk,
    tierOk
      ? `sceneHtml ${html!.length.toLocaleString()}자 · scene(1단)=null`
      : [
          `sceneTier=${result.sceneTier}`,
          result.verify.status === "held"
            ? "held라 E를 부르지 않았다 (보류된 답은 그림으로 다시 주장하지 않는다 · 점검 8이 1차 신호)"
            : null,
          result.content.scene !== null ? "1단 scene이 나와 E 경로로 가지 않았다" : null,
          result.content.sceneHtmlRequest === false ? "sceneHtmlRequest=false (점검 9-A 참고)" : null,
          html === null && result.verify.status === "ok" && result.content.sceneHtmlRequest
            ? "E가 두 번 다 검사를 통과하지 못해 null — 사유는 위 math-player 로그의 reasons"
            : null,
        ]
          .filter(Boolean)
          .join(" / "),
  );

  if (html === null) {
    // 아래 행들은 HTML이 있어야 잴 수 있다. 없는 것을 실패로 또 세면 같은 사고가 4줄로 불어난다.
    add("9-C~9-G. 정적 검사·답 대조·단계 수·srcdoc·ready", "skip", "sceneHtml이 없어 잴 대상이 없다 (9-B 참고)");
    return out;
  }

  // --- 9-C·9-D. 정적 검사 + 답 태그 대조 (§3-4 1~2번) ---
  // 답 비교는 §5-2의 `compare()`를 쓰는 `inspectSceneHtml` 그대로다 — eval 전용 비교 함수를 만들지 마라.
  const inspection = inspectSceneHtml(html, result.content.answer);
  pass(
    `9-C. 정적 검사 — 금지 문자열 0건`,
    inspection.forbidden.length === 0,
    inspection.forbidden.length === 0
      ? "금지 문자열 없음"
      : `걸림: ${inspection.forbidden.join(", ")}`,
  );

  const answerFailure = inspection.failures.find((f) => f !== "static-check");
  pass(
    '9-D. 답 태그 대조 — HTML의 id="answer" ≡ 호출 B의 answer (§5-2 compare)',
    answerFailure === undefined,
    answerFailure === undefined
      ? `${formatAnswer(inspection.answer ?? [])} (호출 B: ${formatAnswer(result.content.answer)})`
      : inspection.reasons.filter((r) => !r.startsWith("정적 검사")).join(" / "),
  );

  // --- 9-E. 단계 수 3~8 (§3-4 프롬프트 "3~8단계") ---
  const [minSteps, maxSteps] = PLAYER_STEPS_RANGE;
  const steps = countMountedSteps(html);
  if (steps.count === null) {
    // 세지 못한 것과 범위를 벗어난 것은 다르다. 파서 한계를 실패로 세면 멀쩡한 생성이 떨어진다.
    // 모델이 신고한 stepCount는 zod가 이미 3~8로 걸렀다(schemas.ts) — 그것이 남은 그물이다.
    add(
      `9-E. 단계 수 ${minSteps}~${maxSteps}`,
      "skip",
      `Kit.mount(steps)를 정적으로 세지 못했다: ${steps.note} · 모델 신고분은 zod가 ${minSteps}~${maxSteps}로 이미 걸렀다`,
    );
  } else {
    pass(
      `9-E. 단계 수 ${minSteps}~${maxSteps} (Kit.mount(steps) 길이 = ready의 steps)`,
      inRange(steps.count, PLAYER_STEPS_RANGE),
      `${steps.count}단계${steps.note ? ` · 실행 경고: ${steps.note}` : ""}`,
    );
  }

  // --- 9-F. srcdoc 조립 (§3-4 3번) — 브라우저에 넘길 문서가 문자열 단계에서 온전한가 ---
  let srcdocDetail: string;
  let srcdocOk: boolean;
  try {
    const kit = readPlayerKit();
    const srcdoc = buildSceneSrcdoc({ html, kitCss: kit.css, kitJs: kit.js });
    const hasCsp = srcdoc.includes(SCENE_IFRAME_CSP);
    const hasKit = srcdoc.includes("Kit") && srcdoc.includes("--ink");
    const hasBody = srcdoc.includes(html);
    srcdocOk = hasCsp && hasKit && hasBody;
    srcdocDetail = srcdocOk
      ? `${Math.round(srcdoc.length / 1024)}KB · CSP meta 포함 · kit.css/kit.js 임베드 · sandbox="${SCENE_IFRAME_SANDBOX}"`
      : [
          hasCsp ? null : "CSP meta 없음",
          hasKit ? null : "kit.css/kit.js가 안 실렸다",
          hasBody ? null : "본문 HTML이 변형됐다",
        ]
          .filter(Boolean)
          .join(" / ");
  } catch (error) {
    srcdocOk = false;
    srcdocDetail = `조립 실패: ${error instanceof Error ? error.message : String(error)}`;
  }
  pass("9-F. srcdoc 조립 (CSP meta · 키트 임베드 · 본문 보존)", srcdocOk, srcdocDetail);

  // --- 9-G. 실행 확인 — **못 잰다.** 지우지 말고 남겨 둔다 ---
  add(
    `9-G. headless iframe ${SCENE_READY_TIMEOUT_MS / 1000}초 내 'ready'`,
    "skip",
    "**측정하지 않음** — 브라우저가 필요하고 playwright/puppeteer는 devDependency에 없다. " +
      "eval에 브라우저 의존을 새로 들이지 않기로 했다(CI는 npm ci→tsc→build만 돈다). " +
      "단계 수는 9-E가 Kit.mount 인자로 대신 재지만, **초기화 중 예외로 ready가 안 오는 경우는 여기서 잡히지 않는다** — " +
      "앱은 이 경우 3초 폴백으로 텍스트 3막만 보여준다(§3-4 4번).",
  );

  return out;
}

/** 오프라인 모드(EVAL_OFFLINE_ONLY=1)에서 점검 9 자리에 남기는 표시 — 실호출이 필요하다 */
export function sceneHtmlOfflineNotice(fixture: Fixture): CheckResult {
  return {
    fixture: fixture.label,
    check: "9. 2단 그림 (호출 E)",
    status: "skip",
    detail:
      "EVAL_OFFLINE_ONLY=1 — 호출 E가 필요해 건너뛴다. 판정 로직 자체는 O8이 스텁으로 확인한다.",
  };
}

// ---------------------------------------------------------------------------
// 오프라인 점검 (실호출 0회) — 픽스처와 다이얼이 스스로 어긋나지 않았는지 먼저 본다.
// 돈을 쓰기 전에 여기서 걸리는 것이 가장 싸다.
// ---------------------------------------------------------------------------

function step(
  mode: SceneStepMode,
  values: (number | null)[],
  over: Partial<SceneStep> = {},
): SceneStep {
  return {
    mode,
    values,
    move: null,
    forward: mode === "ok",
    caption: { tag: mode, title: mode, body: "", calc: null },
    ...over,
  };
}

/** pencil-transfer 정답 대본 (§4-4 되감기 검산의 기준) */
const PENCIL_SCENE: Scene = {
  kind: "containers",
  visual: "bar",
  layout: null,
  difference: null,
  unit: "자루",
  maxValue: 20,
  entities: [
    { id: "m", labelKo: "민희" },
    { id: "c", labelKo: "철희" },
  ],
  moves: [{ from: 0, to: 1, amt: 3, labelKo: "민희 → 철희 : 연필 3자루" }],
  conservation: { total: 20, labelKo: "연필 전체" },
  steps: [
    step("end", [10, 10]),
    step("rewind", [13, 7], { move: 0 }),
    step("start", [13, 7]),
    step("ok", [10, 10]),
  ],
};

/** ruler-eraser 정답 대본 — [개정 1] bar layout='compare' + split (§4-9) */
const RULER_SCENE: Scene = {
  kind: "bar",
  visual: null,
  layout: "compare",
  difference: { amount: 300, labelKo: "자가 더 비싼 만큼" },
  unit: "원",
  maxValue: 1200,
  entities: [
    { id: "r", labelKo: "자" },
    { id: "e", labelKo: "지우개" },
  ],
  moves: [],
  conservation: { total: 900, labelKo: "두 물건 값의 합" },
  steps: [
    step("end", [null, null]), // 합 900·차 300만 안다
    step("split", [300, 300]), // 900 − 300 = 600 을 똑같이 둘로
    step("start", [600, 300]),
    step("ok", [600, 300]),
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * [M5] zod 제약을 실호출 없이 재기 위한 손수 만든 정상 출력 (ruler-eraser 모양).
 *
 * §10-3의 `stepsKo.length < act2.steps.length`는 **JSON Schema로는 걸 수 없는 제약**이라
 * zod가 유일한 그물이다. 그물이 실제로 걸리는지는 픽스처를 직접 parse시켜야만 알 수 있다 —
 * 실호출로 확인하려면 모델이 마침 그 실수를 해 주기를 기다려야 하는데, 그런 회귀 테스트는 없다.
 */
function sampleExplanation(): Explanation {
  return {
    problemPattern: "part-whole",
    patternNameKo: "합과 차형 · 띠 두 개",
    analogy: { titleKo: "시소 맞추기", bodyKo: "한쪽이 무거우면 그만큼 떼어 놓고 봐요." },
    act1: {
      castKo: ["자", "지우개"],
      movesKo: ["자 → 지우개보다 300원 비쌈"],
      endSceneKo: "둘을 합하면 900원이에요.",
      goalKo: "자와 지우개 값을 각각 구해요.",
      trap: "조심! 합만 보고 반씩 나누면 안 돼요. 차 300원이 숨어 있어요.",
    },
    act2: {
      steps: [
        { say: "둘을 합하면 900원이에요.", calc: null },
        { say: "자가 300원 더 비싸니 그만큼 먼저 떼요.", calc: "900 − 300 = 600" },
        { say: "남은 600원을 똑같이 둘로 나눠요.", calc: "600 ÷ 2 = 300" },
        { say: "떼어 둔 300원을 자에게 돌려줘요.", calc: "300 + 300 = 600" },
      ],
    },
    act3: {
      checks: [
        { titleKo: "답에서 다시 해 보기", bodyKo: "600 + 300 = 900, 600 − 300 = 300 맞아요." },
        { titleKo: "저울 검사", bodyKo: "둘을 합하면 언제나 900원이에요." },
      ],
    },
    rules: [
      { emoji: "✂️", ko: "차를 먼저 떼기", why: "남은 것이 똑같아져서 반으로 나눌 수 있어요." },
      { emoji: "⚖️", ko: "합은 안 변해요", why: "둘을 합한 값은 처음부터 끝까지 같아요." },
    ],
    parentTip: "아이에게 '차 300원은 어디로 갔을까?'를 먼저 물어보세요.",
    answer: [
      { label: "자", value: 600, unit: "원" },
      { label: "지우개", value: 300, unit: "원" },
    ],
    answerText: "자는 600원, 지우개는 300원이에요.",
    confidence: "high",
    uncertaintyNote: null,
    childGrade: "none",
    gradeNote: null,
    scene: clone(RULER_SCENE),
    sceneHtmlRequest: false,
    insight: {
      titleKo: "차를 먼저 떼어 내기",
      hookKo: "차를 떼면 둘이 똑같아져요.",
      stepsKo: ["900에서 300을 떼요.", "남은 600을 둘로 나눠요.", "뗀 300을 자에게 돌려줘요."],
      answer: [
        { label: "자", value: 600, unit: "원" },
        { label: "지우개", value: 300, unit: "원" },
      ],
      parentNoteKo: "합과 차가 함께 주어질 때만 통해요. 차를 모르면 쓸 수 없어요.",
    },
  };
}

/**
 * [M2.5] 점검 9를 실호출 없이 실증하기 위한 손수 만든 2단 HTML (`rect-count` 모양).
 *
 * 호출 E의 출력이 어떻게 생겼는지는 `PLAYER_HTML_FEWSHOT`이 보여 준다. 여기서는 **판정이 실제로
 * 갈리는지**만 보면 되므로 최소 형태로 만든다 — 답 태그 하나와 `Kit.mount(steps)` 하나.
 */
function sceneHtmlSample(answer: AnswerItem[], stepCount: number): string {
  return `<div class="kit-wrap">
  <div class="kit-card"><div class="kit-stage" id="stage"></div></div>
</div>

<script type="application/json" id="answer">${JSON.stringify(answer)}</script>

<script>
var G = Kit.grid("#stage", { label: "직사각형", rows: 1, cols: 6, size: 34 });
var steps = [];
for (var i = 0; i < ${stepCount}; i++) {
  steps.push({
    tag: "단계", title: "빠짐없이 세어요", body: "센 것은 색을 칠해요.", calc: null,
    render: function () { G.markAll("on"); }
  });
}
Kit.mount(steps);
</script>`;
}

/** 점검 9에 먹일 가짜 파이프라인 결과 — `runSceneHtmlChecks`가 읽는 자리만 채운다 */
function sceneHtmlSampleResult(html: string | null, answer: AnswerItem[]): ExplainProblemResult {
  const content: Explanation = {
    ...sampleExplanation(),
    problemPattern: "counting",
    patternNameKo: "빠짐없이 세기",
    answer,
    answerText: "모두 21개예요.",
    scene: null,
    sceneHtmlRequest: true,
    insight: null,
  };
  return {
    content,
    sceneHtml: html,
    sceneTier: html ? "html" : "none",
    verify: {
      status: "ok",
      answerMatch: true,
      sceneCheck: true,
      attempts: 1,
      sceneErrors: [],
      insightDropped: false,
      heldReasons: [],
      checkAnswer: answer,
    },
  };
}

/** zod 실패 사유를 한 줄로 (재요청 프롬프트가 쓰는 형태와 같다) */
function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(" / ");
}

// ---------------------------------------------------------------------------
// [M6] 사진 경로 스텁 — §12-7
//
// **실제 사진 파일을 픽스처에 넣지 않는다.** 저장소가 무거워지고, 픽스처에 사진이 붙으면
// 실호출 eval의 입력 토큰이 문제당 ~1,200씩 는다(§12-6). 재는 것은 "사진이 있고 없고에 따라
// 메시지가 어떻게 달라지는가"이고, 그것은 1×1 PNG로 충분히 재진다 — 모델이 볼 일이 없다.
// (오프라인 점검 전용이다. 네트워크는 파일 머리의 게이트가 이미 막아 두었다.)
// ---------------------------------------------------------------------------

/** 1×1 투명 PNG. 형식만 맞으면 되는 자리다 */
const STUB_PROBLEM_PHOTO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 파트 배열에서 텍스트만 이어 붙인다 (실제로 모델이 읽는 글이 이것이다) */
function partsText(parts: readonly UserContentPart[]): string {
  return parts.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join("\n");
}

/**
 * 소스에서 주석을 걷어 낸다 (O12 배선 점검 전용).
 *
 * 배선 점검은 "이 줄이 코드에 있는가"를 묻는데, **주석이 안티패턴을 인용하면 오탐이 난다** —
 * `pipeline.ts`의 [M6] 주석이 실제로 `textPart(buildVerifyUserMessage(input))`를 인용해
 * "이렇게 되돌리지 마라"고 적고 있다. 경고를 지우게 만드는 점검은 나쁜 점검이다.
 *
 * 블록 주석과 **줄 전체가 주석인 줄**만 지운다. 코드 줄 끝의 `//`는 남지만 그 자리에
 * 배선 패턴이 올 일이 없고, 문자열 안의 `//`를 잘못 자르지 않는 쪽이 더 중요하다.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** 파트 배열의 모양을 한 줄로 — 표에 찍어 사람이 눈으로 확인한다 */
function partsShape(parts: readonly UserContentPart[]): string {
  return parts.map((part) => part.type).join(" + ");
}

export function runOfflineChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (fixture: string, check: string, ok: boolean, detail: string) =>
    results.push({ fixture, check, status: ok ? "pass" : "fail", detail });

  // O1. 픽스처 자기 정합성 — 점검 5·9-A가 서로 모순되지 않는가
  for (const f of FIXTURES) {
    const hasChildAnswer = (f.problem.childAnswer ?? "").trim() !== "";
    const gradeOk = hasChildAnswer ? f.expectedGrade !== "none" : f.expectedGrade === "none";
    const patternOk = (PROBLEM_PATTERNS as readonly string[]).includes(f.expectedPattern);
    const answerOk = f.expectedAnswer.length > 0;
    const tierOk = f.expectSceneHtmlRequest ? f.expectedScene === null : f.expectedScene !== null;
    add(
      f.label,
      "O1. 픽스처 정합 (채점·유형·답·1단2단 배타)",
      gradeOk && patternOk && answerOk && tierOk,
      [
        gradeOk ? null : `childAnswer ${hasChildAnswer ? "있음" : "없음"}인데 expectedGrade=${f.expectedGrade}`,
        patternOk ? null : `알 수 없는 유형 ${f.expectedPattern}`,
        answerOk ? null : "expectedAnswer가 비었다",
        tierOk ? null : "1단/2단 기대가 서로 어긋난다 (§3-1 1단 우선)",
      ]
        .filter(Boolean)
        .join(" / ") ||
        `${f.source} · 기대 답 ${formatAnswer(f.expectedAnswer)} · 채점 ${f.expectedGrade}`,
    );
  }

  // O2. [개정 1] §4-9 split 검산 — 정답 대본은 통과, 은우 오답(반씩 나누기)은 거부
  //     점검 10의 오프라인 짝이다. 이게 깨지면 실호출을 해도 개정 1을 잴 수 없다.
  const rulerOk = verifyScene(RULER_SCENE, FIXTURES[1].expectedAnswer);
  add(
    "ruler-eraser",
    "O2. 정답 대본(split 600→300·300)이 §4 검산 통과",
    rulerOk.length === 0,
    rulerOk.length === 0 ? "verifyScene 오류 0 (§4-7이 split을 제외한다)" : rulerOk.join(" / "),
  );

  const halved = clone(RULER_SCENE);
  halved.steps[1].values = [450, 450]; // 차를 안 떼고 900을 반씩 — 은우의 오답
  halved.steps[2].values = [450, 150];
  halved.steps[3].values = [450, 150];
  const halvedErrors = verifyScene(halved, [
    { label: "자", value: 450, unit: "원" },
    { label: "지우개", value: 150, unit: "원" },
  ]);
  add(
    "ruler-eraser",
    "O2. 은우 오답 대본(반씩 나누기)을 §4-9가 거부",
    halvedErrors.some((e) => e.includes("split")),
    halvedErrors.length === 0
      ? "거부되지 않았다 — §4-9 split 규칙이 무력해졌다"
      : halvedErrors.join(" / "),
  );

  // O3. 되감기 방향 — 받은 쪽을 뒤집은 대본을 §4-4가 거부하는가 (은우 오답 철희 11)
  const pencilOk = verifyScene(PENCIL_SCENE, FIXTURES[0].expectedAnswer);
  add(
    "pencil-transfer",
    "O3. 정답 대본(되감기 13·7)이 §4 검산 통과",
    pencilOk.length === 0,
    pencilOk.length === 0 ? "verifyScene 오류 0" : pencilOk.join(" / "),
  );

  const flipped = clone(PENCIL_SCENE);
  flipped.steps[1].values = [13, 13]; // 받은 쪽도 더해 버림 (방향 뒤집기)
  flipped.steps[2].values = [13, 13];
  const flippedErrors = verifyScene(flipped, [
    { label: "민희", value: 13, unit: "자루" },
    { label: "철희", value: 13, unit: "자루" },
  ]);
  add(
    "pencil-transfer",
    "O3. 방향 뒤집은 대본을 §4-4가 거부",
    flippedErrors.length > 0,
    flippedErrors.length === 0 ? "거부되지 않았다 — §4-4 되감기 산술이 무력해졌다" : flippedErrors.join(" / "),
  );

  // O4. 다이얼 4중 동기화 — 점검 7이 재는 구간과 프롬프트가 지시하는 숫자가 같은가.
  //     한쪽만 고치면 모델은 지시를 지켰는데 eval이 떨어뜨린다.
  const dialCases: { label: string; needle: string }[] = [
    { label: "act2 단계", needle: `단계 ${rangeText(ACT2_STEPS_RANGE)}개` },
    { label: "act3 검사 포인트", needle: `검사 포인트 ${rangeText(ACT3_CHECKS_RANGE)}개` },
    { label: "규칙 카드", needle: `규칙 ${rangeText(RULES_RANGE)}개` },
    { label: "scene 단계", needle: `steps는 ${rangeText(SCENE_STEPS_RANGE)}개` },
  ];
  for (const c of dialCases) {
    add(
      "다이얼",
      `O4. 프롬프트가 "${c.needle}"을 지시 (${c.label})`,
      EXPLAIN_SYSTEM_PROMPT.includes(c.needle),
      EXPLAIN_SYSTEM_PROMPT.includes(c.needle)
        ? "프롬프트 ↔ schemas.ts 상수 일치"
        : "프롬프트 문장과 schemas.ts 상수가 어긋난다 — 둘을 함께 고쳐라",
    );
  }
  // 프롬프트가 화살표 규칙을 그대로 갖고 있는가 (점검 10이 여기 걸려 있다)
  add(
    "다이얼",
    `O4. 프롬프트에 movesKo 화살표 규칙(${ARROW})이 살아 있음`,
    EXPLAIN_SYSTEM_PROMPT.includes(`민희 ${ARROW} 철희`),
    EXPLAIN_SYSTEM_PROMPT.includes(`민희 ${ARROW} 철희`)
      ? '"민희 → 철희 : 연필 3자루" 예시 보존'
      : "화살표 예시가 사라졌다 — 점검 10이 무력해진다",
  );

  // O5. 앵커링 방어 — 호출 C의 입력에 B의 답도, 아이가 쓴 답도 들어가지 않는다(§5-1).
  //     "컨텍스트를 더 주면 정확해지지 않나?"라는 선의의 수정이 반드시 들어오는 자리다.
  //
  //     [M6] **조립된 파트 배열**을 재도록 바꿨다. 사진이 붙으면서 실제로 나가는 메시지는
  //     문자열이 아니라 파트 배열이 됐고, 문자열만 계속 보면 파트 쪽에 붙은 유출을 놓친다.
  //     사진을 붙인 갈래도 함께 재는 이유: 사진 때문에 텍스트가 한 글자라도 늘면 여기서 걸린다.
  //     **사진 안에 찍힌 아이 필기는 코드로 못 읽는다** — 그 구멍은 pipeline.ts의
  //     `buildVerifyUserParts` 주석에 남겨 두었다(§12-2가 사진을 C에도 주라고 명시한 결과다).
  for (const f of FIXTURES) {
    const childAnswer = (f.problem.childAnswer ?? "").trim();
    const childWork = (f.problem.childWork ?? "").trim();
    const leaks: string[] = [];
    for (const [branch, imageDataUrl] of [["사진 없음", null], ["사진 있음", STUB_PROBLEM_PHOTO]] as const) {
      const message = partsText(
        buildVerifyUserParts({
          text: f.problem.text,
          figureDesc: f.problem.figureDesc,
          imageDataUrl,
        }),
      );
      for (const [what, hit] of [
        ["아이가 쓴 답", childAnswer !== "" && message.includes(childAnswer)],
        ["아이가 쓴 풀이", childWork !== "" && message.includes(childWork)],
        ["아이 정보 블록", message.includes("아이가 쓴")],
        ["재시도 지시문", message.includes("[다시 풀기]")],
      ] as const) {
        if (hit) leaks.push(`${branch}: ${what}`);
      }
    }
    add(
      f.label,
      "O5. 호출 C 입력에 B의 답·아이 답이 없음 (앵커링 방어)",
      leaks.length === 0,
      leaks.length === 0 ? "문제 문장 + 그림 설명뿐 (사진 유무 두 갈래)" : `유출: ${leaks.join(", ")}`,
    );
  }

  // O6. [M5] 프롬프트가 §10-6 절을 그대로 갖고 있는가 — 점검 11이 여기 걸려 있다.
  //     프롬프트에서 이 절이 사라지면 모델은 insight를 낼 이유가 없고, 점검 11이 통째로 무너진다.
  const insightNeedles: { label: string; needle: string }[] = [
    { label: "절 제목", needle: "[다른 방법 — insight]" },
    { label: "단계 수 다이얼", needle: `stepsKo는 ${rangeText(INSIGHT_STEPS_RANGE)}단계` },
    // 길이 다이얼이 프롬프트에서 빠지면 모델은 이 한도를 zod 거부로만 배운다 — 재요청 1회를 태운다(§1 규약).
    { label: "단계 길이 다이얼", needle: `한 단계는 ${STEP_SAY_MAX_CHARS}자를 넘기지 마라` },
    { label: "억지 생성 금지", needle: "억지로 만들지 마라" },
    { label: "null 허용", needle: "insight를 null로 둔다" },
    { label: "답 일치 지시", needle: "3막의 answer와 같아야 한다" },
  ];
  for (const c of insightNeedles) {
    const has = EXPLAIN_SYSTEM_PROMPT.includes(c.needle);
    add(
      "다이얼",
      `O6. [M5] 프롬프트에 "${c.needle}" (${c.label})`,
      has,
      has ? "§10-6 문안 보존" : "§10-6 문안이 사라졌다 — 점검 11이 무력해진다",
    );
  }

  // O7. [M5] **zod가 §10-3을 실제로 강제하는가.** JSON Schema로는 걸 수 없는 제약이라
  //     이 그물이 뚫리면 "정석보다 긴 두 번째 풀이"가 그대로 아이에게 간다.
  const schema = makeExplanationSchema({ hasChildAnswer: false });

  const good = schema.safeParse(sampleExplanation());
  add(
    "zod",
    "O7. [M5] 정상 출력(stepsKo 3 < act2 4)이 통과",
    good.success,
    good.success ? "insight 3단계 · act2 4단계 · 답 일치" : zodIssues(good.error),
  );

  // act2를 3단계로 줄여 stepsKo(3) >= act2(3)을 만든다. 개수 다이얼(2~3)은 그대로 지켜서
  // **오직 §10-3 길이 비교만** 걸리게 한다 — 다른 규칙에 묻히면 그물을 실증한 것이 아니다.
  const tooLong = sampleExplanation();
  tooLong.act2.steps = tooLong.act2.steps.slice(0, 3);
  const tooLongResult = schema.safeParse(tooLong);
  const tooLongIssues = tooLongResult.success ? "" : zodIssues(tooLongResult.error);
  const caught =
    !tooLongResult.success &&
    tooLongResult.error.issues.some(
      (i) => i.path.join(".") === "insight.stepsKo" && i.message.includes("3개"),
    );
  add(
    "zod",
    "O7. [M5] stepsKo(3) >= act2.steps(3)을 거부 (§10-3)",
    caught,
    tooLongResult.success
      ? "거부되지 않았다 — 통찰이 정석보다 짧다는 보장이 사라졌다"
      : tooLongIssues,
  );

  // insight는 보너스다. 없다고 검증이 떨어지면 §10-2("없으면 만들지 않는다")가 코드에서 죽는다.
  const noInsight = sampleExplanation();
  noInsight.insight = null;
  const noInsightResult = schema.safeParse(noInsight);
  add(
    "zod",
    "O7. [M5] insight=null이 통과 (없으면 없는 것이 정답 · §10-2)",
    noInsightResult.success,
    noInsightResult.success ? "null 통과" : zodIssues(noInsightResult.error),
  );

  // 단계 수 다이얼(2~3)도 zod가 잡는가 — 프롬프트 문구(O6)와 같은 숫자여야 한다.
  const tooMany = sampleExplanation();
  tooMany.insight!.stepsKo = ["하나.", "둘.", "셋.", "넷."];
  const tooManyResult = schema.safeParse(tooMany);
  add(
    "zod",
    `O7. [M5] stepsKo ${rangeText(INSIGHT_STEPS_RANGE)}개 밖(4개)을 거부`,
    !tooManyResult.success,
    tooManyResult.success ? "거부되지 않았다 — 개수 다이얼이 무력하다" : zodIssues(tooManyResult.error),
  );

  // O8. [M2.5] **점검 9가 실제로 판정을 내는가.** 점검 9는 호출 E가 있어야 돌아서 오프라인에서는
  //     한 번도 실행되지 않는다 — 그 사이에 판정이 무력해져도(항상 pass를 주는 형태로) 아무도 모른다.
  //     그래서 스텁 HTML 두 벌로 **통과 한 건 + 답 불일치 실패 한 건**을 여기서 매번 확인한다.
  //
  //     픽스처는 **id로 집는다**(QA P3-3). 인덱스로 집으면 픽스처 순서가 바뀐 날 다른 문제를 재면서
  //     표에는 그대로 `rect-count`라고 찍는다 — 조용히 거짓말하는 점검이 된다. 표 라벨도 픽스처에서
  //     가져와야 같은 이유로 갈라지지 않는다. 아래 O10(§12-7 사진 경로)도 이 상수를 함께 쓴다.
  const rectFixture = FIXTURES.find((f) => f.id === "rect-count");
  if (!rectFixture) {
    // 사라졌다면 건너뛸 게 아니라 멈춘다 — 조용히 넘기면 O8·O10이 아무것도 재지 않는 상태가 된다.
    throw new Error("[eval:math] 픽스처 `rect-count`를 찾지 못했다 (O8 점검 9 표본 · O10 §12-7 사진 경로)");
  }
  const rectAnswer = rectFixture.expectedAnswer;
  const judged = (rows: CheckResult[], needle: string) => rows.find((r) => r.check.startsWith(needle));

  const goodRows = runSceneHtmlChecks(rectFixture, sceneHtmlSampleResult(sceneHtmlSample(rectAnswer, 5), rectAnswer));
  const goodFails = goodRows.filter((r) => r.status === "fail");
  add(
    rectFixture.label,
    "O8. [M2.5] 정상 2단 HTML이 점검 9(9-B~9-F)를 통과",
    goodFails.length === 0,
    goodFails.length === 0
      ? goodRows.map((r) => `${r.check.slice(0, 4)}${statusLabel(r.status)}`).join(" · ")
      : goodFails.map((r) => `${r.check}: ${r.detail}`).join(" / "),
  );

  // 답 태그만 21 → 20으로 바꾼다. **그림이 틀린 답을 주장하는 경우**가 정확히 이 모양이다(§3-4).
  const wrongAnswer: AnswerItem[] = [{ ...rectAnswer[0], value: rectAnswer[0].value - 1 }];
  const badRows = runSceneHtmlChecks(
    rectFixture,
    sceneHtmlSampleResult(sceneHtmlSample(wrongAnswer, 5), rectAnswer),
  );
  const mismatchRow = judged(badRows, "9-D");
  add(
    rectFixture.label,
    "O8. [M2.5] 답이 다른 2단 HTML을 9-D가 거부",
    mismatchRow?.status === "fail",
    mismatchRow === undefined
      ? "9-D 행이 사라졌다 — 답 태그 대조가 없어졌다"
      : mismatchRow.status === "fail"
        ? mismatchRow.detail
        : "거부되지 않았다 — 그림이 틀린 답을 주장해도 통과한다",
  );

  // 정적 검사도 같이 — 금지 문자열 하나면 9-C가 걸려야 한다.
  const dirtyRows = runSceneHtmlChecks(
    rectFixture,
    sceneHtmlSampleResult(
      sceneHtmlSample(rectAnswer, 5).replace("<div class=\"kit-wrap\">", "<div class=\"kit-wrap\"><link rel=\"stylesheet\">"),
      rectAnswer,
    ),
  );
  const staticRow = judged(dirtyRows, "9-C");
  add(
    rectFixture.label,
    "O8. [M2.5] 금지 문자열(<link)이 든 HTML을 9-C가 거부",
    staticRow?.status === "fail",
    staticRow === undefined
      ? "9-C 행이 사라졌다 — 정적 검사가 없어졌다"
      : staticRow.status === "fail"
        ? staticRow.detail
        : "거부되지 않았다 — 정적 검사가 무력하다",
  );

  // 단계 수 세기가 **실제 호출 E 출력 모양**에서도 되는가. few-shot이 그 모양의 유일한 표본이다
  // (5단계: 문제 → 1~3단계 → 검사). 여기서 null이 나오면 9-E는 언제나 SKIP이 된다.
  const fewshotSteps = countMountedSteps(PLAYER_HTML_FEWSHOT);
  add(
    rectFixture.label,
    "O8. [M2.5] few-shot HTML에서 Kit.mount 단계 5개를 세어 냄",
    fewshotSteps.count === 5,
    fewshotSteps.count === null
      ? `세지 못했다: ${fewshotSteps.note} — 9-E가 언제나 SKIP이 된다`
      : `${fewshotSteps.count}단계${fewshotSteps.note ? ` · 경고: ${fewshotSteps.note}` : ""}`,
  );

  // O10. [M6] 문제 사진을 실은 사용자 메시지 — **두 갈래를 스텁으로 실증한다**(§12-4·§12-7).
  //
  //   (1) 사진 없음: 파트는 텍스트 하나뿐이고, 그 글은 §3-2·§5-1 템플릿 그대로다.
  //       **기존 경로가 글자 하나 달라지지 않는 것**이 이 점검의 요점이다 — `/math/new`(직접 입력),
  //       저장된 기록의 "다시 만들기"(§9-1은 사진을 저장하지 않는다)가 전부 이 갈래로 돈다.
  //   (2) 사진 있음: 이미지 파트가 **먼저**, 텍스트가 나중(호출 A·영어 표지 판독과 같은 관례).
  //       그리고 텍스트는 (1)과 **글자 단위로 같아야** 한다 — 사진은 별도 파트로만 실리고
  //       템플릿 문자열에는 흔적을 남기지 않는다.
  for (const [call, buildText, buildParts] of [
    ["B", buildExplainUserMessage, buildExplainUserParts],
    ["C", buildVerifyUserMessage, buildVerifyUserParts],
  ] as const) {
    const problem = rectFixture.problem; // §12-7이 지목한 사진 경로 픽스처(도형 세기)
    const withoutPhoto = buildParts({ ...problem, imageDataUrl: null });
    const withPhoto = buildParts({ ...problem, imageDataUrl: STUB_PROBLEM_PHOTO });
    const baseText = buildText(problem);

    const noPhotoOk =
      withoutPhoto.length === 1 &&
      withoutPhoto[0].type === "input_text" &&
      partsText(withoutPhoto) === baseText;
    add(
      rectFixture.label,
      `O10. [M6] 호출 ${call} — 사진 없으면 기존 메시지 그대로`,
      noPhotoOk,
      noPhotoOk
        ? `파트 ${partsShape(withoutPhoto)} · 텍스트 ${baseText.length}자 (템플릿과 동일)`
        : `달라졌다 — 파트 ${partsShape(withoutPhoto)} · 사진 없는 경로가 깨졌다`,
    );

    const image = withPhoto[0];
    const photoOk =
      withPhoto.length === 2 &&
      image.type === "input_image" &&
      image.image_url === STUB_PROBLEM_PHOTO &&
      image.detail === "high" &&
      withPhoto[1].type === "input_text" &&
      partsText(withPhoto) === baseText;
    add(
      rectFixture.label,
      `O10. [M6] 호출 ${call} — 사진은 파트로만 실리고 텍스트는 불변`,
      photoOk,
      photoOk
        ? `파트 ${partsShape(withPhoto)} · detail high · 텍스트는 사진 없을 때와 동일`
        : `파트 ${partsShape(withPhoto)} · 순서/detail/텍스트 중 하나가 어긋난다`,
    );

    // 형식이 틀린 값은 **조용히 버리지 않고 던진다.** 사진을 버리면 B는 보고 C는 못 보는
    // 상태가 될 수 있고, 그것이 §12-2가 막으려던 "근거가 달라서 지는 검산"이다.
    let threw = false;
    try {
      buildParts({ ...problem, imageDataUrl: "https://example.com/page.jpg" });
    } catch {
      threw = true;
    }
    add(
      rectFixture.label,
      `O10. [M6] 호출 ${call} — data URL이 아닌 사진을 거부`,
      threw,
      threw ? "throw (호출 전에 막는다)" : "통과시켰다 — 형식 검사가 무력해졌다",
    );
  }

  // O10. 비용 가드 — 픽스처에 실제 사진을 넣지 않는다(§12-7). 넣는 순간 실호출 eval의 입력
  //      토큰이 문제당 ~1,200씩 늘고(§12-6) 저장소도 무거워진다. 사진 경로는 위 스텁이 잰다.
  //      **일부러 사진 픽스처를 들이기로 했다면** 이 점검을 지우는 것이 그 결정의 기록이 된다.
  const withPhotoFixtures = FIXTURES.filter((f) => (f.problem.imageDataUrl ?? "") !== "");
  add(
    "픽스처",
    "O10. [M6] 픽스처에 실제 사진이 없다 (실호출 비용 고정)",
    withPhotoFixtures.length === 0,
    withPhotoFixtures.length === 0
      ? "사진 0장 — 실호출 토큰은 M6 이전과 같다"
      : `사진이 붙은 픽스처: ${withPhotoFixtures.map((f) => f.id).join(", ")}`,
  );

  // O12. [M6] **배선** — 호출부가 파트 빌더를 쓰는가 (§12-2).
  //
  //      O10은 `buildXParts()`가 사진을 올바로 싣는지를 잰다. 그런데 M6에서 파트 빌더는
  //      기존 문자열 빌더를 **대체하지 않고 추가**됐다 — 즉 `user: [textPart(buildXUserMessage(input))]`
  //      로 되돌려도 **컴파일되고, 타입도 맞고, O10도 그대로 PASS한다.** 사진만 조용히 안 나간다.
  //      그 침묵이 이 점검이 존재하는 이유다.
  //
  //      되돌림이 반쪽만 일어나는 경우가 더 나쁘다: 호출 B만 파트 빌더면 **그림을 본 B와 못 본 C**가
  //      갈리고, §5-3이 그 불일치를 held로 접는다 — 검산이 일하는 게 아니라 근거가 달라서 지는 것이다.
  //      그래서 B·C·`explainProblem`의 C 입력 조립, **세 자리를 함께** 본다.
  //
  //      소스 텍스트를 읽는 이유: 회귀하는 대상이 "코드 한 줄"이고, 오프라인에서 이 배선을
  //      행동으로 관찰할 이음매가 없다(`callWithSchema`가 네트워크 뒤에 있다). 주석은 떼고 본다 —
  //      주석이 안티패턴을 인용할 수 있어야 하기 때문이다(실제로 인용하고 있다).
  {
    const PIPELINE_PATH = "lib/ai/math/pipeline.ts";
    const rawSource = readFileSync(new URL(`../${PIPELINE_PATH}`, import.meta.url), "utf-8");
    const code = stripComments(rawSource);
    const bodyOf = (fnDecl: string): string => {
      const start = code.indexOf(fnDecl);
      if (start < 0) return "";
      const rest = code.slice(start + fnDecl.length);
      const nextFn = rest.search(/\nexport (async )?function |\nfunction /);
      return nextFn < 0 ? rest : rest.slice(0, nextFn);
    };

    for (const [call, fnDecl, wanted, stale] of [
      [
        "B",
        "export async function callExplain",
        "user: buildExplainUserParts(input)",
        "buildExplainUserMessage",
      ],
      [
        "C",
        "export async function callAnswerCheck",
        "user: buildVerifyUserParts(input)",
        "buildVerifyUserMessage",
      ],
    ] as const) {
      const body = bodyOf(fnDecl);
      const usesParts = body.includes(wanted);
      const usesText = body.includes(`user: [textPart(${stale}`);
      add(
        "배선",
        `O12. [M6] 호출 ${call} 실행부가 파트 빌더를 쓴다 (사진이 실제로 나간다)`,
        usesParts && !usesText,
        body === ""
          ? `${PIPELINE_PATH}에서 ${fnDecl}를 찾지 못했다 — 점검이 무력해졌다`
          : usesParts && !usesText
            ? `${wanted}`
            : usesText
              ? `문자열 빌더로 되돌아갔다 — 사진이 조용히 빠진다(§12-2)`
              : `${wanted}를 찾지 못했다 — 배선을 확인하라`,
      );
    }

    // `explainProblem()`이 C 입력을 조립할 때 사진을 함께 넣는가.
    // 이 한 줄이 빠지면 **B만 그림을 본다** — 호출 C는 파트 빌더를 쓰고도 넘길 사진이 없다.
    const pipelineBody = code.slice(code.indexOf("export async function explainProblem"));
    const problemLiteral = pipelineBody.slice(
      pipelineBody.indexOf("const problem: VerifyUserMessageInput"),
    );
    const literal = problemLiteral.slice(0, problemLiteral.indexOf("};") + 2);
    const forwardsPhoto = /imageDataUrl:\s*input\.imageDataUrl/.test(literal);
    add(
      "배선",
      "O12. [M6] explainProblem이 C 입력에 사진을 실어 준다 (§12-2)",
      forwardsPhoto,
      forwardsPhoto
        ? "imageDataUrl: input.imageDataUrl ?? null — B가 보는 사진을 C도 본다"
        : "C 입력에 사진이 없다 — B만 그림을 보고, 그 불일치를 §5-3이 held로 접는다",
    );

    // 재시도(§5-3) 때도 **같은 사진이 다시 나가는가**(§12-2).
    //
    // 지금 이 성질은 코드가 아니라 **두 개의 재사용**이 떠받치고 있다: 호출 B는
    // `callExplain({ ...input, retryNote })`의 스프레드가, 호출 C는 같은 `problem` 객체를
    // 두 번 넘기는 것이 사진을 실어 나른다. 둘 중 하나만 풀려도 **두 번째 검산만 눈을 감고**,
    // 그 불일치는 held로 나타나 마치 검산이 일한 것처럼 보인다 — 가장 읽기 어려운 실패다.
    // 재시도는 오프라인에서 행동으로 재기 어려우므로(네트워크가 필요하다) 그 두 재사용을 이름으로 잡는다.
    const explainBody = pipelineBody.slice(0, pipelineBody.indexOf("\n// ---"));
    const retrySpreads = /callExplain\(\{\s*\.\.\.input,\s*retryNote\s*\}\)/.test(explainBody);
    const recheckReuses = (explainBody.match(/safeAnswerCheck\(problem\)/g) ?? []).length === 2;
    add(
      "배선",
      "O12. [M6] 재시도 때도 같은 사진이 다시 나간다 (§12-2)",
      retrySpreads && recheckReuses,
      retrySpreads && recheckReuses
        ? "B는 `{ ...input, retryNote }` 스프레드로 · C는 같은 `problem` 객체 재사용으로 사진이 유지된다"
        : !retrySpreads
          ? "재시도 B가 입력을 스프레드로 넘기지 않는다 — 두 번째 설명만 그림을 못 본다"
          : "두 번째 검산이 같은 `problem`을 쓰지 않는다 — 두 번째 검산만 눈을 감는다",
    );

    // 그 조립이 **스프레드가 아닌지**도 함께 본다. `{ ...input }`은 사진과 동시에
    // childAnswer·childWork·retryNote까지 C에 흘려 §5-1 앵커링 방어를 무너뜨린다.
    // O5가 결과를 감시하지만, 여기서 원인을 이름으로 잡아 두는 편이 고치기 쉽다.
    const spreadsInput = /const problem: VerifyUserMessageInput = \{\s*\.\.\.input/.test(literal);
    add(
      "배선",
      "O12. [M6] C 입력을 `{ ...input }`으로 조립하지 않는다 (앵커링)",
      !spreadsInput,
      spreadsInput
        ? "스프레드로 조립한다 — childAnswer·childWork·retryNote가 심판에게 샌다(§5-1)"
        : "필드를 하나씩 옮긴다 — 새 필드는 의식적으로만 C에 간다",
    );
  }

  // O11. [M6] §12-5가 "프롬프트에 더할 절"로 적어 둔 문안이 프롬프트 안에 그대로 있는가.
  //
  //      O9는 프롬프트를 §3-1·§5-1 코드블록과 대조한다. M6에서 그 두 블록에 사진 절을 **직접**
  //      써 넣었으므로, §12-5의 블록은 O9가 더 이상 건드리지 않는다 — §12-5만 고치면 스펙 안에서
  //      두 절이 조용히 갈라진다. 이 점검이 그 구멍을 막는다(스펙 ↔ 스펙 대조).
  {
    const blocks = extractSpecBlocks(MATH_SPEC_URL);
    const cases: { label: string; firstLine: string; prompt: string }[] = [
      { label: "호출 B [문제 사진] 절", firstLine: "[문제 사진]", prompt: EXPLAIN_SYSTEM_PROMPT },
      {
        label: "호출 C 사진 두 줄",
        firstLine: "사진이 함께 오면 그것을 보고 푼다. 그림 설명보다 사진이 우선이다.",
        prompt: VERIFY_SYSTEM_PROMPT,
      },
    ];
    for (const c of cases) {
      const block = blocks.find((b) => b.lines[0] === c.firstLine);
      const ok = block !== undefined && normalizeForCompare(c.prompt).includes(block.text);
      add(
        "프롬프트 ↔ 스펙",
        `O11. [M6] §12-5 ${c.label}이 프롬프트에 원문 그대로`,
        ok,
        block === undefined
          ? `§12-5에서 "${c.firstLine}"으로 시작하는 코드블록을 찾지 못했다`
          : ok
            ? `§12-5 (math.md:${block.fenceLine}) ${block.lines.length}줄 일치`
            : `§12-5 (math.md:${block.fenceLine})와 프롬프트가 갈라졌다 — §3-1·§5-1도 함께 고쳐라`,
      );
    }
  }

  // O9. 프롬프트 원문 ↔ 스펙 문서 대조 (아래 SPEC_SYNC_TARGETS 참고)
  results.push(...runSpecSyncChecks());

  return results;
}

// ---------------------------------------------------------------------------
// O9. 프롬프트 원문 ↔ 스펙 문서 대조 — `docs/harness/math.md`가 진실 원천인지 코드로 확인한다
//
// O4·O6은 프롬프트 문자열과 `schemas.ts`의 **다이얼 상수**가 같은 숫자를 말하는지를 잰다.
// 그것만으로는 "프롬프트가 스펙과 같은가"를 묻지 못한다 — 지금까지 그 근거는 사람이 그때그때
// 돌린 diff뿐이었고, 이 세션에서만 프롬프트를 세 번 고쳤다(§10-6 insight 절 / 호출 E의 xmlns 한 줄 /
// 호칭 규칙 "엄빠" 한 줄). 한 번만 빠뜨리면 스펙과 프롬프트가 **조용히** 갈라진다. O9가 그 구멍이다.
//
// 매핑은 "몇 번째 코드블록"으로 못 박지 않는다. 스펙의 코드블록을 전부 뽑아 두고 **내용으로**
// 같은 블록을 찾는다 (`scripts/spec-sync.ts` 머리주석 참고). 절이 하나 늘어도 깨지지 않는다.
//
// 대조에서 **뺀 것과 그 사유** — 조용히 빼지 않고 여기 남긴다:
//   - `PLAYER_HTML_FEWSHOT`: 스펙에 원문이 없다. §1 파일 배치가 "(+E few-shot HTML)"이라고 존재만
//     적고 §8이 "키트를 늘리면 few-shot을 갱신한다"고 할 뿐, 대조할 원문 자체가 문서에 없다.
//     대신 O8이 이 few-shot에서 Kit.mount 단계 5개를 세어 내는 것으로 형태를 지킨다.
//   - `PLAYER_HTML_SYSTEM_MESSAGE`: `${PLAYER_HTML_SYSTEM_PROMPT}` + 접착 문구 + `${PLAYER_HTML_FEWSHOT}`
//     보간이라 런타임 값과 스펙 원문이 구조적으로 다르다. 구성 요소인 `PLAYER_HTML_SYSTEM_PROMPT`를
//     따로 대조하므로 스펙 원문 부분은 그대로 덮인다(원문을 상수로 가른 이유가 이것이다).
//   - `buildExplainUserMessage` 등 사용자 메시지 빌더: 함수이고 런타임 값을 보간한다. 스펙 §3-2·§6의
//     템플릿은 플레이스홀더가 든 서술이라 "원문 그대로" 대조가 성립하지 않는다.
// ---------------------------------------------------------------------------

const MATH_SPEC_URL = new URL("../docs/harness/math.md", import.meta.url);

const SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  {
    constName: "WORKSHEET_EXTRACT_SYSTEM_PROMPT",
    source: "lib/ai/math/prompts.ts",
    specLabel: "§2-1 호출 A 시스템 프롬프트",
    text: WORKSHEET_EXTRACT_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "WORKSHEET_EXTRACT_USER_TEXT",
    source: "lib/ai/math/prompts.ts",
    specLabel: "§2-2 사용자 메시지",
    text: WORKSHEET_EXTRACT_USER_TEXT,
    // 스펙에 코드블록이 아니라 인라인 코드 한 줄로 적혀 있다 — 본문 포함 여부로 본다
    mode: "inline",
  },
  {
    constName: "EXPLAIN_SYSTEM_PROMPT",
    source: "lib/ai/math/prompts.ts",
    specLabel: "§3-1 호출 B 시스템 프롬프트 (+§10-6 삽입 절)",
    text: EXPLAIN_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "PLAYER_HTML_SYSTEM_PROMPT",
    source: "lib/ai/math/prompts.ts",
    specLabel: "§3-4 호출 E 시스템 프롬프트",
    text: PLAYER_HTML_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "VERIFY_SYSTEM_PROMPT",
    source: "lib/ai/math/pipeline.ts",
    specLabel: "§5-1 호출 C 시스템 프롬프트",
    text: VERIFY_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "PRACTICE_SYSTEM_PROMPT",
    source: "lib/ai/math/prompts.ts",
    specLabel: "§6 호출 D 시스템 프롬프트",
    text: PRACTICE_SYSTEM_PROMPT,
    mode: "block",
  },
];

/** 표 뒤에 상세 diff를 찍기 위해 남겨 둔다 (main이 읽는다) */
const specSyncOutcomes: SpecSyncOutcome[] = [];

export function runSpecSyncChecks(): CheckResult[] {
  specSyncOutcomes.length = 0;
  specSyncOutcomes.push(...checkSpecSync(MATH_SPEC_URL, SPEC_SYNC_TARGETS));
  return specSyncOutcomes.map((o) => ({
    fixture: "프롬프트 ↔ 스펙",
    check: `O9. ${o.constName}이 math.md 원문 그대로`,
    // 스펙을 못 읽거나 블록을 못 찾으면 FAIL이다. SKIP으로 삼키면 대조가 조용히 꺼진다.
    status: o.ok ? ("pass" as Status) : ("fail" as Status),
    detail: o.summary,
  }));
}

// ---------------------------------------------------------------------------
// 출력
// ---------------------------------------------------------------------------

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| ${"결과".padEnd(4)} | ${"픽스처".padEnd(18)} | 점검 항목 | 상세 |`);
  console.log("|------|--------------------|-----------|------|");
  for (const r of results) {
    console.log(
      `| ${statusLabel(r.status)} | ${r.fixture.padEnd(18)} | ${r.check} | ${r.detail} |`,
    );
  }
  console.log("");
}

function summarize(results: CheckResult[]): { passed: number; failed: number; skipped: number } {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
  };
}

function printExplanation(result: ExplainProblemResult): void {
  const c = result.content;
  // 숫자가 맞는 것과 아이가 읽을 만한 글인지는 다른 문제다 — 부모가 볼 물건이라 사람이 한 번 읽는다.
  // 이미 받아 온 응답을 찍을 뿐이라 실호출은 늘지 않는다.
  console.log(`  유형: ${c.problemPattern} (${c.patternNameKo}) · 비유: ${c.analogy.titleKo}`);
  console.log(`  act1.movesKo: ${JSON.stringify(c.act1.movesKo)}`);
  console.log(`  trap: ${c.act1.trap ?? "없음"}`);
  console.log(`  답: ${c.answerText} (${formatAnswer(c.answer)})`);
  console.log(
    `  insight: ${
      c.insight
        ? `"${c.insight.titleKo}" ${c.insight.stepsKo.length}단계 → ${formatAnswer(c.insight.answer)}`
        : "없음 (정석이 최단이거나 만들지 않았다)"
    }`,
  );
  console.log(
    `  검증: status=${result.verify.status} · attempts=${result.verify.attempts} · sceneTier=${result.sceneTier}` +
      (result.verify.heldReasons.length > 0 ? ` · held=${result.verify.heldReasons.join(",")}` : ""),
  );
  if (result.verify.sceneErrors.length > 0) {
    console.log(`  장면 검산 오류: ${result.verify.sceneErrors.join(" / ")}`);
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function selectFixtures(): Fixture[] {
  const only = (process.env.EVAL_ONLY ?? "").trim();
  if (only !== "") {
    const ids = only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = ids.filter((id) => !FIXTURES.some((f) => f.id === id));
    if (unknown.length > 0) {
      console.error(
        `EVAL_ONLY에 알 수 없는 픽스처 id: ${unknown.join(", ")} (가능한 값: ${FIXTURES.map((f) => f.id).join(", ")})`,
      );
      process.exit(1);
    }
    console.log(`EVAL_ONLY=${only} — 픽스처 ${ids.length}개만 돌립니다.`);
    return FIXTURES.filter((f) => ids.includes(f.id));
  }
  if (process.env.EVAL_SKIP_2DAN === "1") {
    console.log("EVAL_SKIP_2DAN=1 — 2단 대상 픽스처를 건너뜁니다 (실호출 2~4회 절약).");
    return FIXTURES.filter((f) => !TWO_TIER_FIXTURE_IDS.has(f.id));
  }
  return FIXTURES;
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  // 실호출 0회 — 픽스처·다이얼·검산 규칙부터 본다 (키 없이도 돈다)
  results.push(...runOfflineChecks());

  // ── 비용 게이트: 여기서 return하면 아래 실호출 구간에 절대 닿지 않는다 ──
  // (아래 for 루프의 explainProblem()이 이 파일의 유일한 네트워크 경로다.)
  if (OFFLINE_ONLY) {
    for (const f of FIXTURES.filter((x) => x.expectSceneHtmlRequest)) {
      results.push(sceneHtmlOfflineNotice(f));
    }
    printTable(results);
    printSpecSyncDetails(specSyncOutcomes);
    const { passed, failed, skipped } = summarize(results);
    console.log(
      "EVAL_OFFLINE_ONLY=1 — 실호출 0회. 모델 출력 품질(점검 1~10)은 검증하지 않았습니다.",
    );
    if (failed > 0) {
      console.error(`FAIL — 오프라인 ${failed}개 항목 실패 (통과 ${passed} · 건너뜀 ${skipped}).`);
      process.exit(1);
    }
    console.log(`PASS — 오프라인 ${passed}개 항목 통과 (건너뜀 ${skipped} · 실호출 미실행).`);
    return;
  }

  const fixtures = selectFixtures();
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY가 없습니다. 실호출 없이 정의 동기화만 보려면 EVAL_OFFLINE_ONLY=1로 돌리세요.",
    );
    process.exit(1);
  }
  const twoTier = fixtures.filter((f) => f.expectSceneHtmlRequest).length;
  console.log(
    `\n실호출 예상: 픽스처 ${fixtures.length}개 × (B+C 2회, 재시도 시 4회) = ${fixtures.length * 2}~${fixtures.length * 4}회` +
      (twoTier > 0
        ? ` + 호출 E ${twoTier}~${twoTier * 2}회(2단 ${twoTier}개 · 재생성 1회 포함, 출력 한도 8,000)`
        : " (2단 픽스처 없음 — 호출 E 0회)"),
  );

  const runs: { fixture: Fixture; result: ExplainProblemResult }[] = [];

  for (const fixture of fixtures) {
    console.log(`\n=== 설명 생성: ${fixture.label} (${fixture.source}) ===`);
    try {
      // 호출 E 렌더러는 **2단 픽스처에만** 주입한다. 주입하지 않으면 파이프라인이 2단을 만들지
      // 않고(sceneTier: 'none') 그만큼 비용도 안 든다 — §8의 비용 구조가 호출 수에 곧바로 걸린다.
      const result = await explainProblem(
        fixture.problem,
        fixture.expectSceneHtmlRequest ? { renderSceneHtml } : {},
      );
      printExplanation(result);
      runs.push({ fixture, result });
      results.push(...runFixtureChecks(fixture, result));
    } catch (error) {
      // 설명 생성 자체가 실패하면(재요청 포함 2회) 그 픽스처를 실패로 기록하고 다음으로 간다
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        fixture: fixture.label,
        check: "설명 생성 (재요청 포함 2회 실패)",
        status: "fail",
        detail: message,
      });
    }
  }

  if (runs.length > 0) results.push(runHeldCheck(runs));
  // 점검 9는 픽스처 루프 안에서 났다(9-B~9-G) — 2단 픽스처를 건너뛰었으면 그 사실을 남긴다.
  for (const f of FIXTURES.filter((x) => x.expectSceneHtmlRequest)) {
    if (!fixtures.some((x) => x.id === f.id)) {
      results.push({
        fixture: f.label,
        check: "9. 2단 그림 (호출 E)",
        status: "skip",
        detail: "이번 실행에서 제외된 픽스처다 (EVAL_ONLY / EVAL_SKIP_2DAN).",
      });
    }
  }

  printTable(results);
  printSpecSyncDetails(specSyncOutcomes);

  const { passed, failed, skipped } = summarize(results);
  if (skipped > 0) {
    // SKIP은 대개 9-G(브라우저 없이는 못 재는 'ready')와 이번 실행에서 제외된 픽스처다.
    console.log(`SKIP ${skipped}건 — 측정하지 않은 항목은 exit code에서 제외했습니다(상세 열 참고).`);
  }
  if (failed > 0) {
    console.error(`FAIL — ${failed}개 항목 실패 (통과 ${passed}). 프롬프트/스키마를 점검하세요.`);
    process.exit(1);
  }
  console.log(`PASS — ${passed}개 항목 통과 (건너뜀 ${skipped}).`);
}

/**
 * 이 파일을 **직접 실행했을 때만** main()이 돈다.
 *
 * 검증 스크립트가 점검 함수(`runFixtureChecks` 등)를 import해서 오프라인으로 단위 테스트할 수
 * 있게 하려는 것이고, 더 중요하게는 **import 한 줄만으로 실호출이 나가는 구조를 만들지 않기
 * 위해서**다. 이 가드가 없으면 누군가 픽스처를 재사용하려고 import하는 순간 돈이 나간다.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error("eval-math 실행 실패:", error);
    process.exit(1);
  });
}

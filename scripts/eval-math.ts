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
 * **[M1 범위] 점검 9(2단 그림)는 아직 통과시킬 수 없다.** 호출 E와 `lib/scene/html.ts`가
 * 없기 때문이다(M2.5 예정). 없는 기능을 '실패'로 세면 회귀 신호가 오염되므로 **SKIP으로 표시하고
 * exit code에서 제외**한다. 대신 호출 B까지 확인 가능한 부분(`sceneHtmlRequest` 값)은 9-A로 채점한다.
 */

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACT2_STEPS_RANGE,
  ACT3_CHECKS_RANGE,
  INSIGHT_STEPS_RANGE,
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
import { EXPLAIN_SYSTEM_PROMPT, type ExplainUserMessageInput } from "../lib/ai/math/prompts";
import {
  buildVerifyUserMessage,
  explainProblem,
  type ExplainProblemResult,
} from "../lib/ai/math/pipeline";
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
    // §10-5 표의 (b) 갈래 — **정석이 곧 최단인 문제.**
    // 8×3=24, 96÷24=4. 순서를 바꾼 96÷8=12, 12÷3=4는 같은 두 번의 계산이지 지름길이 아니다.
    // "왜 그렇게 되는지 한 번에 보이는" 방법이 없으므로 insight는 null이어야 한다(§10-2).
    expectedInsight: "absent",
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
  // §7 점검 9의 나머지(E 결과 정적 검사·답 대조·iframe ready·단계 3~8)는 호출 E가 없어 SKIP이다.
  pass(
    `9-A. sceneHtmlRequest === ${fixture.expectSceneHtmlRequest}`,
    content.sceneHtmlRequest === fixture.expectSceneHtmlRequest,
    `sceneHtmlRequest=${content.sceneHtmlRequest} · sceneTier=${result.sceneTier}`,
  );

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
// 점검 9 — 2단 그림. **M1에서는 구현 대상이 아니다** (호출 E · lib/scene/html.ts 없음).
//
// 없는 기능을 '실패'로 세면 회귀 신호가 오염되므로 SKIP으로 표시하고 exit code에서 뺀다.
// 대신 **구현되면 알려 주는 지뢰선**을 둔다: `lib/scene/html.ts`가 생겼는데 이 점검이 아직
// SKIP이면 eval이 낡은 것이다 — 그때는 FAIL로 바꿔 사람을 부른다(파일 존재만 보고, import는
// 하지 않는다. 없는 모듈을 import하면 eval 전체가 죽는다).
// ---------------------------------------------------------------------------

const SCENE_HTML_MODULE = fileURLToPath(new URL("../lib/scene/html.ts", import.meta.url));

export function runSceneHtmlCheck(): CheckResult {
  const implemented = existsSync(SCENE_HTML_MODULE);
  if (!implemented) {
    return {
      fixture: "rect-count (2단)",
      check: "9. 2단 그림 (E 정적 검사·답 대조·iframe ready·단계 3~8)",
      status: "skip",
      detail:
        "미구현(M2.5) — 호출 E와 lib/scene/html.ts가 아직 없다. exit code에서 제외했다. " +
        "구현되면 이 행을 실제 점검으로 바꿔라: E 호출 → 정적 검사 → 답 태그 대조 → headless iframe 3초 내 'ready' → 단계 3~8.",
    };
  }
  return {
    fixture: "rect-count (2단)",
    check: "9. 2단 그림 (E 정적 검사·답 대조·iframe ready·단계 3~8)",
    status: "fail",
    detail:
      "lib/scene/html.ts가 생겼는데 점검 9가 아직 SKIP이다 — eval이 낡았다. " +
      "§7 점검 9를 구현하고(explainProblem에 renderSceneHtml 주입) 이 함수를 교체하라.",
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

/** zod 실패 사유를 한 줄로 (재요청 프롬프트가 쓰는 형태와 같다) */
function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(" / ");
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
  for (const f of FIXTURES) {
    const message = buildVerifyUserMessage({ text: f.problem.text, figureDesc: f.problem.figureDesc });
    const childAnswer = (f.problem.childAnswer ?? "").trim();
    const childWork = (f.problem.childWork ?? "").trim();
    const leaks = [
      childAnswer !== "" && message.includes(childAnswer) ? "아이가 쓴 답" : null,
      childWork !== "" && message.includes(childWork) ? "아이가 쓴 풀이" : null,
      message.includes("아이가 쓴") ? "아이 정보 블록" : null,
      message.includes("[다시 풀기]") ? "재시도 지시문" : null,
    ].filter(Boolean);
    add(
      f.label,
      "O5. 호출 C 입력에 B의 답·아이 답이 없음 (앵커링 방어)",
      leaks.length === 0,
      leaks.length === 0 ? "문제 문장 + 그림 설명뿐" : `유출: ${leaks.join(", ")}`,
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

  return results;
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
    results.push(runSceneHtmlCheck());
    printTable(results);
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
  console.log(
    `\n실호출 예상: 픽스처 ${fixtures.length}개 × (B+C 2회, 재시도 시 4회) = ${fixtures.length * 2}~${fixtures.length * 4}회` +
      " (호출 E는 M1 미구현이라 0회)",
  );

  const runs: { fixture: Fixture; result: ExplainProblemResult }[] = [];

  for (const fixture of fixtures) {
    console.log(`\n=== 설명 생성: ${fixture.label} (${fixture.source}) ===`);
    try {
      // 호출 E 렌더러(renderSceneHtml)를 주입하지 않는다 — M1에는 lib/scene/html.ts가 없고,
      // 주입하지 않으면 파이프라인이 2단을 만들지 않는다(sceneTier: 'none'). 비용도 그만큼 안 든다.
      const result = await explainProblem(fixture.problem);
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
  results.push(runSceneHtmlCheck());

  printTable(results);

  const { passed, failed, skipped } = summarize(results);
  if (skipped > 0) {
    console.log(`SKIP ${skipped}건 — 미구현(M2.5) 항목은 exit code에서 제외했습니다.`);
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

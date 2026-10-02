/**
 * scripts/eval-toeic-template-centric.ts — 토익 유형별 공략 **템플릿 중심 재정렬**(docs/harness/toeic.md §12-13 — 2026-10-02) 오프라인 검증.
 * scripts/eval-toeic.ts가 부른다(AI 층 항목 — 프롬프트·사용자 메시지·zod·후처리 허용 목록·buildFeedbackInput — 은 eval-toeic.ts
 * "템플릿 중심 — 호출 C·D 흐름"에 있다. 이 파일은 순수 층·정규화·가져오기·파일 저장소 왕복·라우트 소스 대조·실제 파일 개수).
 *
 * §12-13-5의 항목: 답변 흐름(buildAnswerFlow·buildMockAnswerFlows)·모범답변 점검(checkAnswerAgainstFlow 반례 7·isWeakFlowCheck)·레코드
 * 정규화(answerFlows·alternates·모드 다섯)·① 읽기 정렬(가져오기 alternates·지문·guideReadMarks·대본 skip·goto k:)·③ 틀 시험(출제·오답 층·
 * 빈칸·통계 분리·기록 zod·저장 본문·러너 주소)·🧩 틀 점검(쓸 수 있었던 틀 새 순서·요약)·라우트 소스 대조(AI 층이 손댄 연습·다시 만들기)·
 * 앱 층 소스 대조(app-builder — 실전 모의고사 라우트 흐름 배선·① 접기 대본·③ 러너/탭·② 카드 칩·④ 접기·결과 틀 점검·학습 보기 흐름)·
 * 번들 경계·실제 가져오기 파일(있으면 — **개수만**).
 *
 * 공개 저장소: 픽스처의 틀·문장은 전부 **지어낸 것**이다(교재·틀 원본·강의 자막 문장을 옮기지 않는다). 실제 가져오기 파일
 * (data/private/, git 밖)은 개수만 보고 내용은 출력하지 않는다. 실호출 0 — 네트워크를 쓰지 않는다.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  toeicGuideFileSchema,
  toeicTemplateAlternatesFromSkips,
  toeicTemplateBankContent,
  toeicTemplateSessionBodySchema,
  type ToeicAnswerFlow,
  type ToeicGuideFile,
  type ToeicGuideSection,
  type ToeicTemplate,
  type ToeicTemplateAlternate,
  type ToeicTemplateBankDoc,
  type ToeicTemplateFlow,
} from "../lib/ai/toeic/schemas";
import { decideGuideUpsert, planToeicGuideImport, toeicTemplateBankContentHash } from "../lib/ai/toeic/guide-import";
import {
  TOEIC_GUIDE_PART_TO_MOCK_PART,
  TOEIC_GUIDE_PARTS,
  TOEIC_TEMPLATE_BANK_ID,
  buildToeicGuideScript,
  cleanGuideEnForTts,
  toeicGuideBlockKey,
  toeicGuideLeadPieces,
  toeicGuideLineKey,
  toeicGuideLinePieces,
  toeicGuidePartOfMockPart,
  toeicGuidePrefetchTexts,
  type ToeicGuidePart,
  type ToeicGuideScriptPiece,
} from "../lib/toeic-guide";
import {
  TOEIC_ANSWER_FLOW_FRAMES_MAX,
  TOEIC_ANSWER_FLOW_STEP_MIN_RATIO,
  aggregateToeicTemplateStats,
  answerFlowExpressions,
  answerFlowMatchFrames,
  buildAnswerFlow,
  buildMockAnswerFlows,
  checkAnswerAgainstFlow,
  fillFrame,
  frameEndsWithSlot,
  frameSlotNames,
  frameToExpression,
  guideExpressionKeysInFlow,
  isWeakFlowCheck,
  templateAlternateLinks,
  templateAttemptCounts,
  templateFlowOrder,
  templateItemKey,
  templateLinksForGuide,
  templatesByWeakness,
  templatesCouldHaveUsed,
  toeicTemplateBadges,
  toeicTemplateWrongKeysAnyMode,
} from "../lib/toeic-template";
import {
  TOEIC_TEMPLATE_CHOICE_MAX,
  TOEIC_TEMPLATE_CLOZE_SKIP_WORDS,
  aggregateToeicTemplateChoiceStats,
  buildTemplateChoiceQuestions,
  buildTemplateChoiceSessionBodies,
  koFrameToTilde,
  recentTemplateChoiceTests,
  templateClozeTarget,
  toeicTemplateChoiceBadges,
  toeicTemplateChoiceWrongKeys,
  toeicTemplateChoiceWrongModeCounts,
} from "../lib/toeic-template-quiz";
import {
  TOEIC_TEMPLATE_BANK_MODES,
  TOEIC_TEMPLATE_BANK_MODE_LABELS_KO,
  TOEIC_TEMPLATE_CHOICE_MODES,
  TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO,
  TOEIC_TEMPLATE_QUIZ_MODES,
  isToeicTemplateBankMode,
  isToeicTemplateChoiceMode,
  type ToeicQuizSessionLike,
  type ToeicTemplateChoiceMode,
} from "../lib/toeic-quiz";
import {
  TOEIC_GUIDE_GOTO_KEY_PREFIX,
  findGuideGotoBlock,
  guideReadFrameKeys,
  guideReadInitialOpen,
  guideReadMarks,
  guideReadScriptSkip,
  guideRefHref,
  guideTemplatesForPart,
  parseTemplateChoiceQuizParams,
  templateChoiceScopeTemplates,
  toeicTemplateChoiceQuizHref,
} from "../lib/toeic-guide-view";
import { recentTemplateTests } from "../lib/toeic-template-test-view";
import {
  TOEIC_ANSWER_FLOW_WEAK_KO,
  answerFlowCheckLine,
  drillPrepFlowFold,
  drillTemplateCheck,
  toeicDrillCheckData,
  toeicTemplateCheckData,
  toeicTemplateCheckSummary,
} from "../lib/toeic-drill-view";
import { normalizeToeicAnswerFlows, normalizeToeicMockRecord, normalizeToeicQuizRecord, normalizeToeicSetRecord, normalizeToeicTemplateAlternates } from "../lib/toeic-normalize";
import { isRenderableToeicTemplateBank } from "../lib/toeic-record";
import { decodeToeicGuideFromFirestore, encodeToeicGuideForFirestore, hasNestedArray } from "../lib/toeic-firestore-codec";
import { toeicZodErrorKo } from "../lib/toeic-zod-ko";
import { TTS_TEXT_MAX_CHARS } from "../lib/tts-shared";
import type { ToeicSetRecord } from "../lib/store";
import { fixtureFile, type GuideCheckResult } from "./eval-toeic-guides";

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
/** 주석을 뺀 코드 */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 런타임 import 경로(import type·전부 type인 named import 제외) */
function runtimeImportPaths(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m[1]) continue;
    const clause = m[2].trim();
    if (/^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 틀·문장
// ---------------------------------------------------------------------------

const FILLS = ["a sunny corner", "reading quietly", "a blue coat", "twenty minutes"];

function tpl(key: string, groupKo: string, frameEn: string, frameKo: string, parts: ToeicGuidePart[], guideRefs: ToeicTemplate["guideRefs"] = []): ToeicTemplate {
  const names = frameSlotNames(frameEn);
  const f1 = names.map((_n, i) => FILLS[i % FILLS.length]);
  const f2 = names.map((_n, i) => FILLS[(i + 1) % FILLS.length]);
  return {
    key,
    groupKo,
    frameEn,
    frameKo,
    useKo: "지어낸 틀",
    parts,
    source: "new",
    guideRefs,
    examples: [
      { en: fillFrame(frameEn, f1), ko: "지어낸 예문 하나", fills: f1 },
      { en: fillFrame(frameEn, f2), ko: "지어낸 예문 둘", fills: f2 },
    ],
    testFills: [names.map(() => "SECRETFILL")],
  };
}

const FLOW_Q34: ToeicTemplateFlow = {
  part: "q3_4",
  steps: [
    { stepKo: "장면 열기", groupsKo: ["장소"] },
    { stepKo: "인물", groupsKo: ["인물 동작", "인물 옷차림", "사물 상태"] },
    { stepKo: "인상", groupsKo: ["느낌"] },
  ],
  banksKo: ["날씨 소재"],
};

const Q34_ITEMS: ToeicTemplate[] = [
  tpl("venue-open", "장소", "The photo was snapped at {장소}.", "이 사진은 {장소}에서 찍혔다.", ["q3_4"], [{ kind: "expression", part: "q3_4", expression: "The photo was snapped at ~" }]),
  tpl("venue-inside", "장소", "We are looking inside {건물}.", "{건물} 안을 보고 있다.", ["q3_4"]),
  tpl("act-mid", "인물 동작", "In the middle, {사람} is {동작}.", "가운데에서 {사람}이 {동작} 있다.", ["q3_4"], [{ kind: "template", part: "q3_4", step: "인물 틀" }]),
  tpl("sit-near", "인물 동작", "{사람} is sitting near {장소}.", "{사람}이 {장소} 가까이 앉아 있다.", ["q3_4"], [{ kind: "expression", part: "q3_4", expression: "~ is sitting near ~" }]),
  tpl("wear", "인물 옷차림", "{사람} has on {옷}.", "{사람}은 {옷}을 입고 있다.", ["q3_4"]),
  tpl("placed", "사물 상태", "{물건} is placed on the shelf.", "{물건}이 선반 위에 놓여 있다.", ["q3_4"], [{ kind: "expression", part: "q3_4", expression: "~ is placed on the shelf" }]),
  tpl("feel", "느낌", "My overall take is that {느낌}.", "전체적으로 {느낌}라고 본다.", ["q3_4"]),
  tpl("weather", "날씨 소재", "The sky looks {날씨}.", "하늘이 {날씨} 보인다.", ["q3_4"]),
  tpl("bakers", "인물 동작", "Two bakers are {동작}.", "제빵사 두 명이 {동작} 있다.", ["q3_4"], [{ kind: "lead", part: "q3_4", leadEn: "Two bakers are" }]),
];

const FLOW_Q11: ToeicTemplateFlow = {
  part: "q11",
  steps: [
    { stepKo: "입장", groupsKo: ["입장"] },
    { stepKo: "이유", groupsKo: ["장단점"] },
    { stepKo: "예시", groupsKo: ["예시"] },
    { stepKo: "마무리", groupsKo: ["마무리"] },
  ],
  banksKo: ["취미"],
};

const Q11_ITEMS: ToeicTemplate[] = [
  tpl("side-with", "입장", "Personally, I side with {입장}.", "개인적으로 저는 {입장} 편이에요.", ["q11"]),
  tpl("leans", "입장", "My answer leans toward {선택}.", "제 답은 {선택} 쪽이에요.", ["q11"]),
  tpl("upside", "장단점", "The upside here is {점}.", "여기서 좋은 점은 {점}이에요.", ["q11"]),
  tpl("downside", "장단점", "The downside here is {점}.", "여기서 나쁜 점은 {점}이에요.", ["q11"]),
  tpl("best-part", "장단점", "The best part is {점}.", "가장 좋은 부분은 {점}이에요.", ["q11"]),
  tpl("cuts", "장단점", "It cuts down on {비용} and {시간}.", "{비용}과 {시간}을 줄여 줘요.", ["q11"]),
  tpl("costs-saves", "장단점", "It costs {돈} but saves {시간}.", "{돈}이 들지만 {시간}을 아껴 줘요.", ["q11"]),
  tpl("cousin", "예시", "Take my cousin, for example; {이야기}.", "제 사촌을 예로 들면 {이야기}.", ["q11"]),
  tpl("wrap", "마무리", "To wrap up, I {결론}.", "정리하자면 저는 {결론}.", ["q11"]),
  tpl("all-things", "마무리", "All things considered, I {결론}.", "정리하자면 저는 {결론}.", ["q11"]),
  tpl("weekends", "취미", "On weekends, I tend to {활동}.", "주말에 저는 {활동} 편이에요.", ["q11"]),
];

const BANK = { flows: [FLOW_Q34, FLOW_Q11], items: [...Q34_ITEMS, ...Q11_ITEMS] };

function sess(id: string, mode: ToeicQuizSessionLike["mode"], startedAt: string, items: [string, boolean][], finished = true): ToeicQuizSessionLike {
  return { id, setId: TOEIC_TEMPLATE_BANK_ID, mode, startedAt, finishedAt: finished ? startedAt : null, items: items.map(([k, c]) => ({ word: templateItemKey(k), correct: c, answered: true })) };
}

// ---------------------------------------------------------------------------
// 1. 답변 흐름 (§12-13-3)
// ---------------------------------------------------------------------------

function runAnswerFlowChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "답변 흐름");
  const q34 = Q34_ITEMS;
  const flow = buildAnswerFlow(BANK, "picture", q34, { order: "flow" });
  add("read → null(흐름 없음) · toeicGuidePartOfMockPart 역표", buildAnswerFlow(BANK, "read", q34, { order: "flow" }) === null && toeicGuidePartOfMockPart("read") === null && TOEIC_GUIDE_PARTS.every((p) => toeicGuidePartOfMockPart(TOEIC_GUIDE_PART_TO_MOCK_PART[p]) === p), "");
  add(
    "단계 순서 = templateFlowOrder(단계 안 묶음 순서·묶음 안 파일 순서), 소재 묶음 → banks, 틀 글자 = frameToExpression",
    flow !== null &&
      eqJson(flow.steps.map((st) => [st.stepKo, st.frames.map((f) => f.key)]), [
        ["장면 열기", ["venue-open", "venue-inside"]],
        ["인물", ["act-mid", "sit-near", "bakers", "wear", "placed"]],
        ["인상", ["feel"]],
      ]) &&
      eqJson(flow.banks.map((f) => f.key), ["weather"]) &&
      flow.steps[0].frames[0].expression === "The photo was snapped at ~" &&
      flow.part === "picture",
    flow ? flow.steps.map((st) => `${st.stepKo}:${st.frames.map((f) => f.key).join("+")}`).join(" | ") : "null",
  );
  {
    const orphan = tpl("orphan", "흐름에 없는 묶음", "Next to {물건} is {물건2}.", "{물건} 옆에 {물건2}이 있다.", ["q3_4"]);
    const f = buildAnswerFlow(BANK, "picture", [...q34, orphan], { order: "flow" });
    add("흐름에 없는 묶음(기타)은 banks 뒤에", f !== null && eqJson(f.banks.map((x) => x.key), ["weather", "orphan"]), f ? f.banks.map((x) => x.key).join(",") : "");
  }
  {
    const throwing = () => {
      throw new Error("flow 순서는 rng를 쓰지 않는다");
    };
    let ok = true;
    try {
      buildAnswerFlow(BANK, "picture", q34, { order: "flow", rng: throwing });
    } catch {
      ok = false;
    }
    add("\"flow\"는 rng를 쓰지 않는다", ok, "");
  }
  {
    const sessions = [sess("s1", "tpl-recall", "2026-10-01T00:00:00.000Z", [["wear", false], ["act-mid", true]])];
    const w1 = buildAnswerFlow(BANK, "picture", q34, { order: "weakness", sessions, rng: makeRng(5) });
    const w2 = buildAnswerFlow(BANK, "picture", q34, { order: "weakness", sessions, rng: makeRng(5) });
    const step = w1?.steps.find((st) => st.stepKo === "인물");
    add(
      "\"weakness\": 단계 안에서 약한 틀이 앞(틀렸고 미졸업 → 안 해 봄 → 진행 중), 같은 rng면 결정적, 단계 순서는 그대로",
      step !== undefined && step.frames[0].key === "wear" && step.frames[step.frames.length - 1].key === "act-mid" && eqJson(w1, w2) && eqJson(w1?.steps.map((s) => s.stepKo), ["장면 열기", "인물", "인상"]),
      step ? step.frames.map((f) => f.key).join(",") : "",
    );
  }
  {
    const manyBanks = Array.from({ length: 70 }, (_x, i) => tpl(`b-${i}`, "날씨 소재", `Extra bank frame number ${i} with {x} here.`, `소재 {x} ${i}`, ["q3_4"]));
    const f = buildAnswerFlow(BANK, "picture", [...q34, ...manyBanks], { order: "flow" });
    const stepCount = f ? f.steps.reduce((n, st) => n + st.frames.length, 0) : 0;
    add(
      `상한 ${TOEIC_ANSWER_FLOW_FRAMES_MAX}: 넘으면 소재 틀을 뒤에서 자른다(단계 틀은 그대로)`,
      f !== null && stepCount === 8 && f.banks.length === TOEIC_ANSWER_FLOW_FRAMES_MAX - 8 && f.banks[0].key === "weather",
      `${stepCount}/${f?.banks.length}`,
    );
    const bigStepFlow: ToeicTemplateFlow = { part: "q3_4", steps: [0, 1, 2].map((i) => ({ stepKo: `단계${i}`, groupsKo: [`묶음${i}`] })), banksKo: ["날씨 소재"] };
    const stepItems = [0, 1, 2].flatMap((g) => Array.from({ length: 25 }, (_x, i) => tpl(`s${g}-${i}`, `묶음${g}`, `Step frame ${g} number ${i} uses {x} here.`, `단계 {x}`, ["q3_4"])));
    const g = buildAnswerFlow({ flows: [bigStepFlow] }, "picture", [...stepItems, q34[7]], { order: "flow" });
    add(
      "단계 틀만으로 넘치면 단계마다 앞에서 ⌊60 ÷ 단계 수⌋개(같은 수)·소재 0",
      g !== null && g.steps.every((st) => st.frames.length === Math.floor(TOEIC_ANSWER_FLOW_FRAMES_MAX / 3)) && g.banks.length === 0 && g.steps[0].frames[0].key === "s0-0",
      g ? g.steps.map((st) => st.frames.length).join(",") : "null",
    );
  }
  add("틀 0개 → null", buildAnswerFlow(BANK, "picture", [], { order: "flow" }) === null && buildAnswerFlow(BANK, "info", q34, { order: "flow" }) === null, "");

  // buildMockAnswerFlows — 네 파트(틀이 있는 유형) 형식표 순서, 은행 없음 → [], 한 파트 예외는 그 파트만
  {
    const all = buildMockAnswerFlows(BANK, { q3_4: q34, q11: Q11_ITEMS });
    add("buildMockAnswerFlows: 고른 파트와 무관하게 틀이 있는 유형 전부(형식표 순서 picture → opinion), 틀이 없는 유형은 빠진다", eqJson(all.map((f) => f.part), ["picture", "opinion"]), all.map((f) => f.part).join(","));
    add("틀 은행 없음 → []", buildMockAnswerFlows(null, { q3_4: q34 }).length === 0, "");
    const errors: string[] = [];
    const boom = { filter: () => { throw new Error("boom"); } } as unknown as ToeicTemplate[];
    const iso = buildMockAnswerFlows(BANK, { q3_4: q34, q5_7: boom, q11: Q11_ITEMS }, (p) => errors.push(p));
    add("한 파트 흐름 만들기가 던지면 그 파트만 빠지고 나머지는 계속(onError로 알림)", eqJson(iso.map((f) => f.part), ["picture", "opinion"]) && eqJson(errors, ["q5_7"]), errors.join(","));
    const regenFlow = all.find((f) => f.part === "opinion") ?? null;
    add("고르지 않은 파트(opinion)의 흐름도 저장 결과에 있다 — 다시 만들기가 넘길 흐름이 null이 아님(검토 B1)", regenFlow !== null && regenFlow.steps.length === 4, "");
  }
  // 허용 목록·찾기 모양
  {
    const f = buildAnswerFlow(BANK, "picture", q34, { order: "flow" })!;
    const ex = answerFlowExpressions(f);
    add("answerFlowExpressions: 단계 → 소재 순·중복 없음·null → []", ex.length === 9 && ex[0] === "The photo was snapped at ~" && ex[ex.length - 1] === "The sky looks ~" && answerFlowExpressions(null).length === 0, ex.length.toString());
    const mf = answerFlowMatchFrames(f);
    add("answerFlowMatchFrames: ~ → 자리 {_}(찾기 함수 모양)", mf[0].frameEn === "The photo was snapped at {_}" && mf.every((x) => !/[~～〜]/.test(x.frameEn)), mf[0].frameEn);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. 모범답변 점검 (§12-13-3 — 측정만)
// ---------------------------------------------------------------------------

const CHECK_FLOW: ToeicAnswerFlow = {
  part: "picture",
  steps: [
    { stepKo: "장면 열기", frames: [{ key: "venue-open", expression: "The photo was snapped at ~" }] },
    { stepKo: "인물", frames: [{ key: "act-mid", expression: "In the middle, ~ is ~" }] },
    { stepKo: "옷차림", frames: [{ key: "wear", expression: "~ has on ~" }] },
    { stepKo: "인상", frames: [{ key: "feel", expression: "My overall take is that ~" }] },
  ],
  banks: [{ key: "weather", expression: "The sky looks ~" }, { key: "wow", expression: "Wow, ~" }],
};

function runFlowCheckChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "모범답변 점검");
  const full = "The photo was snapped at a park. In the middle, a man is reading. He has on a red coat. My overall take is that it is a calm day.";
  const c1 = checkAnswerAgainstFlow(full, CHECK_FLOW);
  add("단계 넷을 순서대로 다 쓴 답 → 4/4·inOrder", c1.stepsUsed === 4 && c1.stepsTotal === 4 && c1.inOrder && eqJson(c1.used.map((u) => u.step), [0, 1, 2, 3]), `${c1.stepsUsed}/${c1.stepsTotal}`);
  const c2 = checkAnswerAgainstFlow("The photo was snapped at a park. In the middle, a man is reading. My overall take is that it is a calm day.", CHECK_FLOW);
  add("한 단계를 뺀 답 → 3/4", c2.stepsUsed === 3 && c2.inOrder, `${c2.stepsUsed}/4`);
  const c3 = checkAnswerAgainstFlow("My overall take is that it is a calm day. The photo was snapped at a park. In the middle, a man is reading. He has on a coat.", CHECK_FLOW);
  add("단계 순서를 바꾼 답 → inOrder false", c3.stepsUsed === 4 && !c3.inOrder, "");
  const c4 = checkAnswerAgainstFlow("The photo got snapped at a park.", CHECK_FLOW);
  add("고정 낱말 하나를 바꾼 틀 → 쓴 틀이 아님", c4.used.length === 0, "");
  const contraction: ToeicAnswerFlow = { part: "picture", steps: [{ stepKo: "날씨", frames: [{ key: "it-is", expression: "It is ~ outside today" }] }], banks: [] };
  const c5 = checkAnswerAgainstFlow("It's sunny outside today.", contraction);
  add("축약형만 다른 틀(It is ↔ It's) → 쓴 틀", c5.used.length === 1 && c5.stepsUsed === 1, "");
  const c6 = checkAnswerAgainstFlow("The sky looks gray and heavy.", CHECK_FLOW);
  add("소재 틀만 쓴 답 → 단계 0(쓴 틀의 step = null)", c6.stepsUsed === 0 && eqJson(c6.used, [{ key: "weather", step: null }]), JSON.stringify(c6.used));
  add("한 낱말 조각뿐인 틀 → unmatchable", c1.unmatchable === 1, String(c1.unmatchable));
  // isWeakFlowCheck — 0.75 경계
  const mk = (stepsUsed: number, stepsTotal: number, used: number) => ({ used: Array.from({ length: used }, (_x, i) => ({ key: `k${i}`, step: null })), stepsUsed, stepsTotal, inOrder: true, unmatchable: 0 });
  add(
    `isWeakFlowCheck: Q3–4·Q11 단계 3/4 → false · 2/4 → true(경계 ${TOEIC_ANSWER_FLOW_STEP_MIN_RATIO}) · Q5–7·Q8–10 쓴 틀 0 → true · 1 → false · 흐름 없음 → false`,
    !isWeakFlowCheck(mk(3, 4, 3), "picture") && isWeakFlowCheck(mk(2, 4, 2), "picture") && isWeakFlowCheck(mk(3, 5, 3), "opinion") === true &&
      !isWeakFlowCheck(mk(4, 5, 4), "opinion") && isWeakFlowCheck(mk(0, 3, 0), "respond") && !isWeakFlowCheck(mk(0, 3, 1), "info") && !isWeakFlowCheck(null, "picture"),
    "",
  );
  // 화면 줄(AI 0)
  const l1 = answerFlowCheckLine(full, CHECK_FLOW, "picture");
  const l2 = answerFlowCheckLine("My overall take is that it is a calm day. The photo was snapped at a park.", CHECK_FLOW, "picture");
  const l3 = answerFlowCheckLine("I go there around four times each month.", { part: "respond", steps: [{ stepKo: "빈도", frames: [{ key: "times", expression: "I go there around ~ times each ~" }] }], banks: [] }, "respond");
  add(
    "answerFlowCheckLine: Q3–4 \"🧩 모범답변의 틀 n개 · 단계 a/b\"(+순서 다름) · Q5–7은 틀 수만 · 흐름 없음 → null · 미달이면 weak",
    l1?.textKo === "🧩 모범답변의 틀 4개 · 단계 4/4" && !l1.weak &&
      l2?.textKo === "🧩 모범답변의 틀 2개 · 단계 2/4 (순서 다름)" && l2.weak &&
      l3?.textKo === "🧩 모범답변의 틀 1개" && !l3.weak &&
      answerFlowCheckLine(full, null, "picture") === null &&
      TOEIC_ANSWER_FLOW_WEAK_KO.includes("틀을 덜 따랐어요"),
    `${l1?.textKo} | ${l2?.textKo} | ${l3?.textKo}`,
  );
  const fold = drillPrepFlowFold(CHECK_FLOW);
  add("준비 접기 자료: 단계마다 첫 틀 + 나머지 수·전부, 소재 틀은 따로 · 흐름 없음 → null", fold !== null && fold.steps.length === 4 && fold.steps[0].first.key === "venue-open" && fold.steps[0].more === 0 && fold.banks.length === 2 && drillPrepFlowFold(null) === null, "");
  return results;
}

// ---------------------------------------------------------------------------
// 3. 레코드 정규화 — answerFlows·alternates·모드 다섯 (§7-2·§12-3)
// ---------------------------------------------------------------------------

function runRecordChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "템플릿 중심 — 레코드");
  const base = { id: "m", titleKo: "모의고사 1", targetGrade: "IH", expressionsUsed: [], topicHints: [], parts: {}, drillPart: null, model: "x", createdAt: "2026-10-01T00:00:00.000Z", sortIndex: null };
  const good = buildMockAnswerFlows(BANK, { q3_4: Q34_ITEMS, q11: Q11_ITEMS });
  add("normalizeToeicMockRecord: answerFlows 없음 → [] · 배열 아님 → []", eqJson(normalizeToeicMockRecord(base).answerFlows, []) && eqJson(normalizeToeicMockRecord({ ...base, answerFlows: "x" }).answerFlows, []), "");
  const broken = [
    good[0],
    { part: "read", steps: [], banks: [] },
    { part: "nope", steps: [], banks: [] },
    { part: "info", steps: "x", banks: [] },
    { part: "respond", steps: [{ stepKo: "a", frames: [{ key: "", expression: "x ~" }] }], banks: [] },
    { ...good[0] },
    good[1],
  ];
  const n = normalizeToeicMockRecord({ ...base, answerFlows: broken });
  add("깨진 흐름 항목만 버린다(read·모르는 파트·steps 배열 아님·틀 모양 깨짐·같은 파트 두 번째) — 옳은 것은 그대로", eqJson(n.answerFlows, good), n.answerFlows.map((f) => f.part).join(","));
  add("옛 문서 = 기본값(흐름 없음)", eqJson(normalizeToeicAnswerFlows(undefined), []) && eqJson(normalizeToeicMockRecord({ ...base, answerFlows: good }).answerFlows, good), "");
  add("모의고사 본문에 배열 속 배열 0(흐름 = 배열 안 객체 안 배열 — Firestore 제약 밖)", !hasNestedArray(normalizeToeicMockRecord({ ...base, answerFlows: good })), "");
  // 틀 은행 alternates
  const bankDoc = { kind: "templates", flows: BANK.flows, items: BANK.items, contentHash: "h", updatedAt: "2026-10-01T00:00:00.000Z" };
  const rec = (guide: unknown) => normalizeToeicSetRecord({ id: TOEIC_TEMPLATE_BANK_ID, titleKo: "템플릿 훈련", entries: [], quiz: [], guide });
  const noAlt = rec(bankDoc).guide as ToeicTemplateBankDoc;
  const alts: unknown[] = [
    { part: "q3_4", kind: "expression", ref: "~ is sitting by ~", coveredBy: "sit-near" },
    { part: "q9", kind: "expression", ref: "x", coveredBy: "y" },
    { part: "q3_4", kind: "odd", ref: "x", coveredBy: "y" },
    { part: "q3_4", kind: "lead", ref: "", coveredBy: "y" },
    { part: "q3_4", kind: "lead", ref: "Whenever I", coveredBy: "" },
    "string",
    { part: "q11", kind: "template", ref: "옛 단계", coveredBy: "wrap", reasonKo: "버린다" },
  ];
  const withAlt = rec({ ...bankDoc, alternates: alts }).guide as ToeicTemplateBankDoc;
  add("틀 은행 정규화: alternates 없음 → [] · 모양이 깨진 항목만 버림(이유 글 같은 모르는 키도 버림)", eqJson(noAlt.alternates, []) && eqJson(withAlt.alternates, [
    { part: "q3_4", kind: "expression", ref: "~ is sitting by ~", coveredBy: "sit-near" },
    { part: "q11", kind: "template", ref: "옛 단계", coveredBy: "wrap" },
  ]), JSON.stringify(withAlt.alternates));
  add("alternates가 깨져도 틀 은행은 렌더 가능(접기만 빠진다)", isRenderableToeicTemplateBank(rec({ ...bankDoc, alternates: "broken" }) as ToeicSetRecord) && eqJson(normalizeToeicTemplateAlternates("broken"), []), "");
  {
    const g = rec({ ...bankDoc, alternates: alts }).guide;
    const enc = encodeToeicGuideForFirestore(g);
    add("Firestore 본문: alternates를 더해도 인코딩 뒤 배열 속 배열 0 · 왕복 불변", !hasNestedArray(enc) && eqJson(decodeToeicGuideFromFirestore(enc), g), "");
  }
  // 모드 다섯
  const q = (mode: string) => normalizeToeicQuizRecord({ id: "q", setId: TOEIC_TEMPLATE_BANK_ID, mode, startedAt: "2026-10-01T00:00:00.000Z", finishedAt: null, items: [] });
  add(
    "normalizeToeicQuizRecord: 틀 은행 모드 다섯(말하기 둘·고르기 셋)을 받고 모르는 모드는 버린다",
    TOEIC_TEMPLATE_BANK_MODES.length === 5 && TOEIC_TEMPLATE_BANK_MODES.every((m) => q(m)?.mode === m) && q("tpl-unknown") === null && q("ko-to-expr")?.mode === "ko-to-expr",
    "",
  );
  add(
    "모드 표: 고르기 셋 라벨(한→영 고르기·영→뜻 고르기·빈칸 채우기)·합친 다섯 라벨·판정 함수",
    eqJson([...TOEIC_TEMPLATE_CHOICE_MODES], ["tpl-ko-frame", "tpl-frame-ko", "tpl-cloze"]) &&
      TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO["tpl-ko-frame"] === "한→영 고르기" && TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO["tpl-cloze"] === "빈칸 채우기" &&
      Object.keys(TOEIC_TEMPLATE_BANK_MODE_LABELS_KO).length === 5 && TOEIC_TEMPLATE_BANK_MODE_LABELS_KO["tpl-recall"] === "예문 말하기" &&
      isToeicTemplateChoiceMode("tpl-cloze") && !isToeicTemplateChoiceMode("tpl-recall") && isToeicTemplateBankMode("tpl-recall") && !isToeicTemplateBankMode("cloze"),
    "",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 4. ① 공략 읽기 — 가져오기 alternates·지문 (§12-13-1·§12-2-5)
// ---------------------------------------------------------------------------

function parsedFixture(raw: unknown = fixtureFile()): ToeicGuideFile {
  const r = toeicGuideFileSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!r.success) throw new Error(`[eval-toeic-template-centric] 픽스처 zod 실패: ${r.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join(" / ")}`);
  return r.data;
}

/** 픽스처에 coveredBy null 건너뜀(틀로 쓰지 않는 교재 표현) 하나를 더한 변형 — 지어낸 표현 */
function fixtureWithNullSkip(): unknown {
  const f = clone(fixtureFile()) as { guides: { part: string; expressions: unknown[] }[]; templates: { alignmentSkips: unknown[] } };
  const q57 = f.guides.find((g) => g.part === "q5_7")!;
  q57.expressions.push({ no: 3, expression: "~ cheers me up", meaningKo: "~이 기운을 북돋아 준다", example: null, exampleKo: null });
  f.templates.alignmentSkips.push({ part: "q5_7", kind: "expression", ref: "~ cheers me up", reasonKo: "틀로 쓰지 않는 소재 표현", coveredBy: null });
  return f;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function runImportAlternatesChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "① 같은 자리 다른 표현 — 가져오기");
  const file = parsedFixture(fixtureWithNullSkip());
  const bank = file.templates!;
  const plan = planToeicGuideImport(file);
  const bankItem = plan.find((it) => it.docId === TOEIC_TEMPLATE_BANK_ID)!;
  const g = bankItem.guide as Omit<ToeicTemplateBankDoc, "updatedAt">;
  add(
    "alternates = coveredBy 있는 건너뜀만(파일 순서, 이유 글 없음) · coveredBy null은 빠진다",
    eqJson(g.alternates, [{ part: "q3_4", kind: "expression", ref: "The scene is set in ~", coveredBy: "scene-set-on" }]) && bank.alignmentSkips.length === 2 && !JSON.stringify(g.alternates).includes("reasonKo"),
    JSON.stringify(g.alternates),
  );
  add("toeicTemplateBankContent = flows·items·alternates(키 순서 고정) — 지문·바이트 상한이 같은 함수", eqJson(Object.keys(toeicTemplateBankContent(bank)), ["flows", "items", "alternates"]) && eqJson(toeicTemplateBankContent(bank).alternates, toeicTemplateAlternatesFromSkips(bank.alignmentSkips)), "");
  const schemaSrc = read("lib/ai/toeic/schemas.ts");
  add("가져오기 zod 바이트 상한이 alternates까지 잰다(소스 대조 — toeicTemplateBankContent(b))", /utf8ByteLength\(JSON\.stringify\(toeicTemplateBankContent\(b\)\)\) > TOEIC_GUIDE_MAX_BYTES/.test(schemaSrc), "");
  // 지문
  const oldHash = sha256(JSON.stringify({ flows: bank.flows, items: bank.items }));
  const newHash = toeicTemplateBankContentHash(bank);
  const reasonOnly = clone(bank);
  reasonOnly.alignmentSkips = reasonOnly.alignmentSkips.map((s) => ({ ...s, reasonKo: `${s.reasonKo} (고침)` }));
  add("지문이 alternates를 넣어 바뀐다(옛 지문 ≠ 새 지문) · 이유 글만 고친 파일 → 같은 지문", oldHash !== newHash && toeicTemplateBankContentHash(reasonOnly) === newHash, "");
  // 옛 지문의 저장 문서 + 같은 파일 → updated 한 번 → 다시 넣으면 unchanged
  const now = "2026-10-02T00:00:00.000Z";
  const legacy: ToeicSetRecord = normalizeToeicSetRecord({
    id: TOEIC_TEMPLATE_BANK_ID,
    titleKo: "템플릿 훈련",
    source: "import",
    presetKey: bankItem.presetKey,
    entries: [],
    quiz: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    sortIndex: 3,
    guide: { kind: "templates", flows: bank.flows, items: bank.items, contentHash: oldHash, updatedAt: "2026-09-27T00:00:00.000Z" },
  });
  const d1 = decideGuideUpsert([bankItem], [legacy], now);
  const updatedRec = d1.ok ? d1.writes[0]?.record ?? null : null;
  const updatedDoc = updatedRec?.guide as ToeicTemplateBankDoc | undefined;
  add(
    "옛 지문 저장 문서 + 같은 파일 → updated 한 번(alternates 채움, 틀 key·id·createdAt·sortIndex 그대로)",
    d1.ok && d1.results[0].outcome === "updated" && updatedRec !== null && updatedRec.id === TOEIC_TEMPLATE_BANK_ID && updatedRec.createdAt === legacy.createdAt && updatedRec.sortIndex === 3 &&
      updatedDoc?.alternates.length === 1 && eqJson(updatedDoc.items.map((t) => t.key), bank.items.map((t) => t.key)),
    d1.ok ? d1.results.map((r) => r.outcome).join(",") : "conflict",
  );
  const d2 = decideGuideUpsert([bankItem], updatedRec ? [normalizeToeicSetRecord(updatedRec)] : [], now);
  add("그 뒤 같은 파일 → unchanged", d2.ok && d2.results[0].outcome === "unchanged", d2.ok ? d2.results[0].outcome : "conflict");
  return results;
}

// ---------------------------------------------------------------------------
// 5. ① 공략 읽기 — 줄 표시 판정·대본 skip·goto (§12-13-1)
// ---------------------------------------------------------------------------

type LineIn = { label?: string | null; en?: string | null; ko?: string | null; alt?: boolean };
function ln(o: LineIn) {
  return { label: o.label ?? null, en: o.en ?? null, ko: o.ko ?? null, note: null, emphasis: [], underline: [], alt: o.alt ?? false, marked: false, example: null };
}

/** 지어낸 공략 읽기 섹션 — 블록마다 규칙 하나를 시험한다 */
function readSections(): ToeicGuideSection[] {
  return [
    {
      label: null,
      titleKo: "사진 묘사 읽기",
      introKo: null,
      groupKo: null,
      blocks: [
        { kind: "heading", textKo: "장면" },
        {
          kind: "lines",
          style: "list",
          captionKo: "자주 쓰는 줄",
          lead: null,
          lines: [
            ln({ en: "{사람} is sitting near/by {장소}.", ko: "~이 ~ 가까이 앉아 있다." }),
            ln({ en: "{물건} is/are placed on the shelf.", ko: "~이 선반 위에 놓여 있다." }),
            ln({ en: "The photo was snapped at {장소}.", ko: "이 사진은 ~에서 찍혔다." }),
            ln({ en: "Just an example sentence here.", ko: "그냥 예문이에요." }),
          ],
        },
        {
          kind: "lines",
          style: "list",
          captionKo: "다른 여는 말",
          lead: ln({ en: "The shot was captured at {장소}.", ko: "이 사진은 ~에서 찍혔다." }),
          lines: [ln({ en: "The shot was captured at a quiet pier.", ko: "조용한 부두에서 찍혔다." })],
        },
        {
          kind: "lines",
          style: "list",
          captionKo: null,
          lead: null,
          lines: [ln({ en: "{물건} is lying on {장소}.", ko: "~이 ~ 위에 놓여 있다." }), ln({ en: "{사람} is sitting by {장소}.", ko: "~이 ~ 옆에 앉아 있다." })],
        },
        {
          kind: "lines",
          style: "template",
          captionKo: "인물 틀",
          lead: null,
          lines: [
            ln({ label: "인물 틀", en: "In the middle, {사람} is {동작}.", ko: "가운데에서 ~이 ~하고 있다." }),
            ln({ label: "인물 틀", en: "Right in the middle, {사람} is {동작}.", ko: "바로 가운데에서 ~", alt: true }),
            ln({ label: "옛 인물 틀", en: "A person in the center is {동작}.", ko: "가운데 사람이 ~" }),
          ],
        },
        {
          kind: "lines",
          style: "completions",
          captionKo: "여가 이어 말하기",
          lead: ln({ en: "Whenever I get a spare hour, I", ko: "한 시간이 나면 저는" }),
          lines: [ln({ en: "fix old bikes.", ko: "낡은 자전거를 고쳐요." }), ln({ en: "bake bread.", ko: "빵을 구워요." })],
        },
        {
          kind: "lines",
          style: "completions",
          captionKo: null,
          lead: ln({ en: "Once a month, I", ko: "한 달에 한 번 저는" }),
          lines: [ln({ en: "visit a market.", ko: "시장에 가요." })],
        },
        {
          kind: "lines",
          style: "completions",
          captionKo: null,
          lead: ln({ en: "Every other day, I", ko: "이틀에 한 번 저는" }),
          lines: [ln({ en: "jog slowly.", ko: "천천히 뛰어요." })],
        },
        {
          kind: "lines",
          style: "completions",
          captionKo: null,
          lead: ln({ en: "Two bakers are", ko: "제빵사 두 명이" }),
          lines: [ln({ en: "kneading dough.", ko: "반죽을 하고 있다." })],
        },
        { kind: "text", label: "TIP", titleKo: "팁", bodyKo: "설명은 그대로 둔다.", lines: [ln({ en: "{물건} is lying on {장소}.", ko: "~이 ~ 위에 놓여 있다." })] },
      ],
    },
    {
      label: null,
      titleKo: "둘째 섹션",
      introKo: null,
      groupKo: null,
      blocks: [{ kind: "lines", style: "list", captionKo: null, lead: null, lines: [ln({ en: "Honestly, the mood is {느낌}.", ko: "솔직히 분위기는 ~이다." })] }],
    },
  ] as ToeicGuideSection[];
}

const READ_ALTERNATES: ToeicTemplateAlternate[] = [
  { part: "q3_4", kind: "expression", ref: "~ is sitting by ~", coveredBy: "sit-near" },
  { part: "q3_4", kind: "expression", ref: "The shot was captured at ~", coveredBy: "venue-open" },
  { part: "q3_4", kind: "expression", ref: "~ is lying on ~", coveredBy: "placed" },
  { part: "q3_4", kind: "lead", ref: "Whenever I get a spare hour, I", coveredBy: "saturdays" },
  { part: "q3_4", kind: "lead", ref: "Once  a month, I", coveredBy: "saturdays-near" },
  { part: "q3_4", kind: "lead", ref: "Every other day, I", coveredBy: "ghost" },
  { part: "q3_4", kind: "template", ref: "옛 인물 틀", coveredBy: "act-mid" },
  { part: "q11", kind: "expression", ref: "~ is lying on ~", coveredBy: "other-part" },
];

function readFixtures() {
  const items = [
    ...Q34_ITEMS,
    tpl("feel-guide", "느낌", "Honestly, the mood is {느낌}.", "솔직히 분위기는 {느낌}이다.", ["q3_4"], [{ kind: "expression", part: "q3_4", expression: "Honestly, the mood is ~" }]),
  ];
  const links = templateLinksForGuide({ items }, "q3_4");
  const altLinks = templateAlternateLinks({ alternates: READ_ALTERNATES }, "q3_4");
  const partTemplates = [
    ...items.map((t) => ({ key: t.key, frameEn: t.frameEn })),
    { key: "saturdays", frameEn: "Most Saturdays, I like to {활동}." },
    { key: "saturdays-near", frameEn: "Most Saturdays, I like to {활동} near my place." },
  ];
  return { links, altLinks, partTemplates };
}

function pieceInvariants(script: readonly ToeicGuideScriptPiece[]): boolean {
  return script.every((p) => p.text === p.text.trim() && p.text !== "" && p.text.length <= TTS_TEXT_MAX_CHARS && (p.lang === "en-US" || p.lang === "ko-KR"));
}

function runReadMarksChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "① 외울 틀 강조·같은 자리 접기");
  const sections = readSections();
  const { links, altLinks, partTemplates } = readFixtures();
  add(
    "templateAlternateLinks: 세 종류 키가 templateLinksForGuide와 같은 정규화(표현 expressionKey·머리말 공백 정리·label 그대로)·다른 유형은 빠진다",
    altLinks.expressions.get("~ is sitting by ~")?.[0] === "sit-near" && altLinks.leads.has("Once a month, I") && altLinks.templateLabels.get("옛 인물 틀")?.[0] === "act-mid" &&
      eqJson(altLinks.expressions.get("~ is lying on ~"), ["placed"]) && eqJson(templateAlternateLinks({ alternates: null }, "q3_4").expressions.size, 0),
    "",
  );
  const m = guideReadMarks(sections, links, altLinks, partTemplates);
  const k = toeicGuideLineKey;
  const b = toeicGuideBlockKey;
  add(
    "연결된 표현 줄 → 외울 틀 · 템플릿 label 연결 → 그 label 줄 전부(alt 줄 포함 — 접지 않음) · 머리말 연결 → 머리말 줄",
    eqJson(m.frameLines.get(k(0, 1, 0)), ["sit-near"]) && eqJson(m.frameLines.get(k(0, 1, 1)), ["placed"]) && eqJson(m.frameLines.get(k(0, 1, 2)), ["venue-open"]) &&
      eqJson(m.frameLines.get(k(0, 4, 0)), ["act-mid"]) && eqJson(m.frameLines.get(k(0, 4, 1)), ["act-mid"]) && eqJson(m.frameLines.get(k(0, 8, "lead")), ["bakers"]) &&
      !m.frameLines.has(k(0, 1, 3)) && !m.altLines.has(k(0, 1, 3)),
    [...m.frameLines.keys()].join(" "),
  );
  add(
    "슬래시 대안(규칙 1): 한 대안은 외울 틀·다른 대안은 같은 자리 → frameLines이고 framePicks = 외울 틀 쪽 / 일치 변형 줄(is/are)은 framePicks 없음",
    m.framePicks.get(k(0, 1, 0)) === "{사람} is sitting near {장소}." && !m.framePicks.has(k(0, 1, 1)) && m.framePicks.size === 1,
    JSON.stringify([...m.framePicks]),
  );
  add(
    "같은 자리 머리말의 list → 블록 통째(규칙 5) · 모든 줄이 같은 자리 → 블록 통째(규칙 6) · 줄 단위 접기는 블록 통째로 올리면 줄 접기에서 지운다",
    eqJson(m.altBlocks.get(b(0, 2)), ["venue-open"]) && eqJson(m.altBlocks.get(b(0, 3)), ["placed", "sit-near"]) && !m.altLines.has(k(0, 2, "lead")) && !m.altLines.has(k(0, 3, 0)),
    JSON.stringify([...m.altBlocks]),
  );
  add(
    "label 대안 줄(옛 인물 틀)은 줄 접기 — 외울 틀 줄이 섞인 블록은 통째로 올리지 않는다",
    eqJson(m.altLines.get(k(0, 4, 2)), ["act-mid"]) && !m.altBlocks.has(b(0, 4)),
    "",
  );
  add(
    "이어 말하기 머리말만 접기(규칙 4): 대표 틀이 자리로 끝나면 머리말 줄만 altLines + bareBlocks, 조각 줄은 어느 접기에도 없음",
    eqJson(m.altLines.get(k(0, 5, "lead")), ["saturdays"]) && eqJson(m.bareBlocks.get(b(0, 5)), ["saturdays"]) && !m.altBlocks.has(b(0, 5)) &&
      !m.altLines.has(k(0, 5, 0)) && !m.altLines.has(k(0, 5, 1)),
    "",
  );
  add(
    "대표 틀이 자리로 끝나지 않거나(…{활동} near my place.) 렌더 불가(partTemplates에 없음)면 블록 통째",
    eqJson(m.altBlocks.get(b(0, 6)), ["saturdays-near"]) && eqJson(m.altBlocks.get(b(0, 7)), ["ghost"]) && !m.bareBlocks.has(b(0, 6)) && !m.bareBlocks.has(b(0, 7)),
    "",
  );
  add(
    "heading·text 제목·본문은 판정 없음 — text 블록은 제목·본문이 있으면 줄 단위 접기로 둔다(교재 설명·팁은 접지 않는다)",
    eqJson(m.altLines.get(k(0, 9, 0)), ["placed"]) && !m.altBlocks.has(b(0, 9)) && !m.altBlocks.has(b(0, 0)) && ![...m.frameLines.keys(), ...m.altLines.keys()].some((x) => x.startsWith("0:0:")),
    "",
  );
  const empty = guideReadMarks(sections, { templateLabels: new Map(), leads: new Map(), expressions: new Map() }, { templateLabels: new Map(), leads: new Map(), expressions: new Map() }, []);
  add("틀 은행 없음 → 빈 판정", empty.frameLines.size + empty.altLines.size + empty.altBlocks.size + empty.bareBlocks.size + empty.framePicks.size === 0, "");
  add(
    "frameEndsWithSlot: 끝 . ? ! 따옴표·공백 무시 · 가운데에만 자리 → false",
    frameEndsWithSlot("Most Saturdays, I like to {활동}.") && frameEndsWithSlot("I'd say {답}?\" ") && frameEndsWithSlot("{a}") &&
      !frameEndsWithSlot("Most Saturdays, I like to {활동} near my place.") && !frameEndsWithSlot("No slot here."),
    "",
  );
  // guideReadFrameKeys · goto k: · initial open · guideRefHref
  const keys = guideReadFrameKeys(m);
  add("guideReadFrameKeys: frameLines 값의 합집합(label·머리말 연결 포함) · 틀 은행 없음 → 빈 집합", eqJson([...keys].sort(), ["act-mid", "bakers", "feel-guide", "placed", "sit-near", "venue-open"]) && guideReadFrameKeys(empty).size === 0, [...keys].join(","));
  add(
    "findGuideGotoBlock: marks를 주면 k:{key} → 그 key의 첫 외울 틀 줄 블록(문서 순서) · 없는 key → null · marks 없으면 k:는 null · t:·l:은 그대로",
    eqJson(findGuideGotoBlock(sections, `${TOEIC_GUIDE_GOTO_KEY_PREFIX}act-mid`, m), { section: 0, block: 4 }) &&
      eqJson(findGuideGotoBlock(sections, "k:bakers", m), { section: 0, block: 8 }) &&
      eqJson(findGuideGotoBlock(sections, "k:feel-guide", m), { section: 1, block: 0 }) &&
      findGuideGotoBlock(sections, "k:nope", m) === null &&
      findGuideGotoBlock(sections, "k:act-mid") === null &&
      eqJson(findGuideGotoBlock(sections, "t:인물 틀", m), findGuideGotoBlock(sections, "t:인물 틀")) &&
      eqJson(findGuideGotoBlock(sections, "t:인물 틀"), { section: 0, block: 4 }),
    "",
  );
  add("guideReadInitialOpen: marks를 주면 k: 목표 섹션도 첫 렌더부터 연다", eqJson(guideReadInitialOpen(sections, "k:feel-guide", m), [0, 1]) && eqJson(guideReadInitialOpen(sections, "k:feel-guide"), [0]), "");
  add(
    "guideRefHref(expression 연결, key) = ① ?tab=read&goto=k:{key} · key 없으면 옛 주소 · template·lead는 그대로",
    guideRefHref({ kind: "expression", part: "q3_4", expression: "~ is sitting near ~" }, "sit-near") === `/toeic/guides/q3_4?tab=read&goto=${encodeURIComponent("k:sit-near")}` &&
      guideRefHref({ kind: "expression", part: "q3_4", expression: "x ~" }).includes("tab=quiz") &&
      guideRefHref({ kind: "template", part: "q11", step: "이유" }, "k1").includes("goto=t%3A"),
    guideRefHref({ kind: "expression", part: "q3_4", expression: "~ is sitting near ~" }, "sit-near"),
  );
  return results;
}

function runReadScriptChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "① 대본 — 접은 것 빼기");
  const sections = readSections();
  const guide = { sections };
  const { links, altLinks, partTemplates } = readFixtures();
  const m = guideReadMarks(sections, links, altLinks, partTemplates);
  const skip = guideReadScriptSkip(m);
  const emptySkip = { blocks: new Set<string>(), lines: new Set<string>(), bareLeads: new Set<string>(), picks: new Map<string, string>() };
  for (const mode of ["all", "english-only"] as const) {
    const full = buildToeicGuideScript(guide, mode);
    add(`skip 없음 = 빈 skip(${mode}) — 글자까지 같은 대본`, eqJson(full, buildToeicGuideScript(guide, mode, { skip: emptySkip })), "");
  }
  const full = buildToeicGuideScript(guide, "all");
  const s = buildToeicGuideScript(guide, "all", { skip });
  const has = (sc: readonly ToeicGuideScriptPiece[], sec: number, blk: number, line?: number | "lead") => sc.some((p) => p.section === sec && p.block === blk && (line === undefined || p.line === line));
  add(
    "skip 적용 → 접은 블록·줄의 조각 0(블록 통째 2·3·6·7, 줄 4:2·9:0, bareBlocks 머리말 5:lead)",
    !has(s, 0, 2) && !has(s, 0, 3) && !has(s, 0, 6) && !has(s, 0, 7) && !has(s, 0, 4, 2) && !has(s, 0, 9, 0) && !has(s, 0, 5, "lead") && has(s, 0, 9) && has(s, 0, 4, 0),
    "",
  );
  const allText = (sc: readonly ToeicGuideScriptPiece[]) => sc.map((p) => p.text).join(" | ");
  const picked = s.filter((p) => p.section === 0 && p.block === 1 && p.line === 0 && p.lang === "en-US");
  add(
    "picks → 그 줄 영어 조각이 고른 글자의 정리 결과, 지운 대안 낱말(by)이 대본·프리페치 어디에도 없음, 같은 줄 한국어는 그대로",
    picked.length === 1 && picked[0].text === cleanGuideEnForTts("{사람} is sitting near {장소}.") && !/\bby\b/.test(allText(s)) && !toeicGuidePrefetchTexts(s).some((t) => /\bby\b/.test(t)) &&
      s.some((p) => p.section === 0 && p.block === 1 && p.line === 0 && p.lang === "ko-KR") && /\bby\b/.test(allText(full)),
    picked.map((p) => p.text).join(" / "),
  );
  const bare = s.filter((p) => p.section === 0 && p.block === 5 && p.lang === "en-US");
  add(
    "bareLeads → 조각 줄의 영어 조각이 조각 글자만(머리말 글자 0 — 대본·프리페치 전체), 조각 줄 🔊 = 그 조각만",
    eqJson(bare.map((p) => p.text), ["fix old bikes.", "bake bread."]) && !allText(s).includes("Whenever") && !toeicGuidePrefetchTexts(s).some((t) => t.includes("Whenever")) &&
      eqJson(toeicGuideLinePieces(s, 0, 5, 0).filter((p) => p.lang === "en-US").map((p) => p.text), ["fix old bikes."]) && allText(full).includes("Whenever"),
    bare.map((p) => p.text).join(" / "),
  );
  const block5 = sections[0].blocks[5];
  const lp = toeicGuideLeadPieces(block5, 0, 5, "all");
  const lpEn = toeicGuideLeadPieces(block5, 0, 5, "english-only");
  add(
    "toeicGuideLeadPieces: \"전부\"면 en·ko 두 조각, \"영어만\"이면 en 한 조각, completions가 아니면 []",
    lp.length === 2 && lp[0].lang === "en-US" && lp[0].text === "Whenever I get a spare hour, I" && lp[1].lang === "ko-KR" && lpEn.length === 1 && toeicGuideLeadPieces(sections[0].blocks[1], 0, 1, "all").length === 0,
    "",
  );
  const pf = toeicGuidePrefetchTexts(s);
  add(
    "프리페치 목록에 접은 줄 글자가 없다(같은 자리 블록의 영어)",
    !pf.some((t) => t.includes("shot was captured") || t.includes("is lying on") || t.includes("visit a market") || t.includes("jog slowly") || t.includes("A person in the center")),
    `${pf.length}개`,
  );
  add(
    "접힌 줄 🔊 = 접기 없는 대본의 그 주소 조각(미리 받지 않는다)",
    toeicGuideLinePieces(full, 0, 4, 2).length > 0 && eqJson(toeicGuideLinePieces(full, 0, 4, 2), full.filter((p) => p.section === 0 && p.block === 4 && p.line === 2)),
    "",
  );
  add("불변식(trim·≤300·lang) — skip 대본·영어만 대본", pieceInvariants(s) && pieceInvariants(buildToeicGuideScript(guide, "english-only", { skip, pause: true })), "");
  // text 블록 🔊가 skip 대본을 쓰는가 — 화면 소스 대조는 app 단계(§12-13-5), 여기서는 순수 함수가 같은 대본에서 거른다는 것만
  add("text 블록 조각도 skip 대본에서 거른다(접힌 줄 9:0 없음)", !s.some((p) => p.section === 0 && p.block === 9 && p.line === 0), "");
  return results;
}

// ---------------------------------------------------------------------------
// 6. 파일 저장소 왕복 — alternates 정규화 누락을 잡는다(검토 S3)
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const schemas = await import(process.env.EVAL_SCHEMAS_URL);
const imp = await import(process.env.EVAL_IMPORT_URL);
const fs = await import("node:fs");
const raw = JSON.parse(fs.readFileSync(process.env.EVAL_FILE, "utf-8"));
const parsed = schemas.toeicGuideFileSchema.safeParse(raw);
if (!parsed.success) { console.log("@@RESULT@@" + JSON.stringify({ error: "zod" })); process.exit(0); }
const st = store.getStore();
const plan = imp.planToeicGuideImport(parsed.data);
const planned = plan.find((it) => it.docId === "guide-templates").guide.alternates.length;
const d1 = await st.upsertToeicGuides(plan, "2026-10-02T00:00:00.000Z");
const bank1 = await st.getToeicSet("guide-templates");
const d2 = await st.upsertToeicGuides(plan, "2026-10-02T01:00:00.000Z");
const bank2 = await st.getToeicSet("guide-templates");
console.log("@@RESULT@@" + JSON.stringify({
  cwd: process.cwd(),
  planned,
  o1: d1.ok ? d1.results.map((r) => r.outcome) : "conflict",
  o2: d2.ok ? d2.results.map((r) => r.outcome) : "conflict",
  a1: bank1 && bank1.guide ? bank1.guide.alternates.length : -1,
  a2: bank2 && bank2.guide ? bank2.guide.alternates.length : -1,
  keys: bank2 && bank2.guide ? bank2.guide.items.map((t) => t.key).length : -1,
}));
`;

function shaFile(file: string): string | null {
  return existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : null;
}

function runFileStoreRoundTrip(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "① 파일 저장소 왕복");
  const repoDb = path.join(ROOT, "data", "db.json");
  const beforeSha = shaFile(repoDb);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-tpl-centric-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "db.json"), JSON.stringify({}));
    const filePath = path.join(dir, "guides.json");
    writeFileSync(filePath, JSON.stringify(fixtureWithNullSkip()));
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [script], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        STORE_BACKEND: "file",
        GOOGLE_APPLICATION_CREDENTIALS: "",
        GOOGLE_CLOUD_PROJECT: "",
        K_SERVICE: "",
        OPENAI_API_KEY: "",
        EVAL_FILE: filePath,
        EVAL_STORE_URL: pathToFileURL(path.join(ROOT, "lib", "store.ts")).href,
        EVAL_SCHEMAS_URL: pathToFileURL(path.join(ROOT, "lib", "ai", "toeic", "schemas.ts")).href,
        EVAL_IMPORT_URL: pathToFileURL(path.join(ROOT, "lib", "ai", "toeic", "guide-import.ts")).href,
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 300)}`);
      return results;
    }
    const out = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    add("자식 프로세스 cwd = 임시 폴더 · STORE_BACKEND=file", realpathSync(String(out.cwd)) === realpathSync(dir), "");
    add(
      "지어낸 가져오기 파일을 넣고 틀 은행을 다시 읽으면 alternates 개수 = 계획 개수(정규화가 명시적으로 옮긴다)",
      out.planned === 1 && out.a1 === 1 && eqJson((out.o1 as string[]).slice(-1), ["created"]),
      JSON.stringify([out.planned, out.a1, out.o1]),
    );
    add("같은 파일을 한 번 더 → unchanged이고 개수 그대로", (out.o2 as string[]).every((o) => o === "unchanged") && out.a2 === 1 && (out.keys as number) > 0, JSON.stringify([out.o2, out.a2]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("저장소 data/db.json 무접촉(전후 sha 같음)", shaFile(repoDb) === beforeSha, String(beforeSha));
  return results;
}

// ---------------------------------------------------------------------------
// 7. ③ 틀 시험 (§12-13-2)
// ---------------------------------------------------------------------------

function runTemplateQuizChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "③ 틀 시험");
  const q11 = Q11_ITEMS;
  add("koFrameToTilde: 자리마다 ~ · 공백 접기 · { } 없음", koFrameToTilde("  {비용}과   {시간}을 줄여 줘요. ") === "~과 ~을 줄여 줘요." && !/[{}]/.test(koFrameToTilde("{a}{b}")), koFrameToTilde("  {비용}과   {시간}을 줄여 줘요. "));

  const all = buildTemplateChoiceQuestions(q11, q11, [], { rng: makeRng(1), flow: FLOW_Q11 });
  const again = buildTemplateChoiceQuestions(q11, q11, [], { rng: makeRng(1), flow: FLOW_Q11 });
  const qs = all.questions;
  add(
    "한 판 한 틀(같은 key 두 번 없음) · 같은 rng면 결정적 · 상한 기본 20",
    new Set(qs.map((q) => q.key)).size === qs.length && qs.length === q11.length && eqJson(all, again) && TOEIC_TEMPLATE_CHOICE_MAX === 20,
    `${qs.length}문항 · skipped ${all.skipped}`,
  );
  const order = qs.map((q) => TOEIC_TEMPLATE_CHOICE_MODES.indexOf(q.mode));
  add("모드별 묶음: 한→영 → 영→뜻 → 빈칸 순으로 끊기지 않고 이어진다", order.every((v, i) => i === 0 || v >= order[i - 1]), qs.map((q) => q.mode.slice(4)).join(","));
  add(
    "보기 2~5·정답 포함·중복 없음(matchKey)",
    qs.every((q) => q.choices.length >= 2 && q.choices.length <= 5 && q.choices.includes(q.answer) && new Set(q.choices.map((c) => c.toLowerCase())).size === q.choices.length),
    "",
  );
  add("문항에 testFills 글자가 없다(직렬화 대조)", !JSON.stringify(all).includes("SECRETFILL"), "");
  add(
    "고르기 두 모드의 문제·보기에 자리 이름이 없다(~로 가림) · 빈칸은 before·after에 자리 이름을 보인다",
    qs.filter((q) => q.mode !== "tpl-cloze").every((q) => !/[{}]/.test(q.prompt) && q.choices.every((c) => !/[{}]/.test(c))) &&
      qs.filter((q) => q.mode === "tpl-cloze").every((q) => q.cloze !== null && /\{/.test(q.cloze.before + q.cloze.after)),
    "",
  );
  const sub = buildTemplateChoiceQuestions(q11, q11, [], { modes: ["tpl-frame-ko"], max: 3, rng: makeRng(2), flow: FLOW_Q11 });
  add("모드 부분집합·max", sub.questions.length === 3 && sub.questions.every((q) => q.mode === "tpl-frame-ko"), "");
  {
    const one = [q11[0]];
    const lone = buildTemplateChoiceQuestions(one, one, [], { rng: makeRng(3) });
    add("보기가 2개 미만이면 출제하지 않는다(skipped)", lone.questions.length === 0 && lone.skipped === 3, `skipped ${lone.skipped}`);
  }
  // 오답 보기 층·극성 쌍·같은 뜻·자리 수
  const ko = (key: string, seed: number, pool: readonly ToeicTemplate[] = q11) =>
    buildTemplateChoiceQuestions(pool.filter((t) => t.key === key), pool, [], { modes: ["tpl-ko-frame"], rng: makeRng(seed), flow: FLOW_Q11 }).questions[0];
  const up = ko("upside", 4);
  add(
    "극성 쌍은 서로 좋은 오답(The upside ↔ The downside) · 같은 묶음·같은 자리 수 후보가 먼저(best-part)",
    up !== undefined && up.choices.includes("The downside here is ~") && up.choices.includes("The best part is ~") && up.answer === "The upside here is ~" && up.prompt === "여기서 좋은 점은 ~이에요.",
    up ? up.choices.join(" / ") : "",
  );
  add(
    "자리 수: 같은 묶음에 자리 1개 셋·2개 둘이고 정답이 1개면 보기가 모두 자리 1개(다른 층의 1개가 같은 묶음 2개보다 먼저)",
    up !== undefined && up.choices.every((c) => (c.match(/~/g) ?? []).length === 1),
    up ? up.choices.map((c) => (c.match(/~/g) ?? []).length).join("") : "",
  );
  {
    const tiny = q11.filter((t) => ["upside", "cuts", "costs-saves"].includes(t.key));
    const t = ko("upside", 5, tiny);
    add("같은 자리 수 후보가 모자라면 다른 자리 수로 채운다", t !== undefined && t.choices.length === 3 && t.choices.includes("It cuts down on ~ and ~"), t ? t.choices.join(" / ") : "");
  }
  {
    const wrapQs = [6, 7, 8, 9].map((seed) => ko("wrap", seed));
    add("한→영: 정답과 한국어 ~ 형태가 같은 틀(All things considered)은 보기에서 빠진다(둘 다 정답)", wrapQs.every((q) => q !== undefined && !q.choices.includes("All things considered, I ~")), "");
    const fk = buildTemplateChoiceQuestions(q11.filter((t) => t.key === "wrap"), q11, [], { modes: ["tpl-frame-ko"], rng: makeRng(9), flow: FLOW_Q11 }).questions[0];
    add("영→뜻: 정답과 같은 한국어 보기는 한 번(같은 뜻 보기 제외)", fk !== undefined && fk.choices.filter((c) => c === "정리하자면 저는 ~.").length === 1 && fk.prompt === "To wrap up, I ~", fk ? fk.choices.join(" / ") : "");
  }
  // 빈칸
  add(
    "빈칸 낱말: 관사·주어 대명사는 비우지 않는다 · 시도 수 t가 늘면 다음 고정 낱말(후보 수로 돈다)",
    eqJson([0, 1, 2, 3, 4].map((t) => templateClozeTarget("The photo was snapped at {장소}.", t)?.word), ["photo", "was", "snapped", "at", "photo"]) &&
      [0, 1, 2, 3, 4, 5].every((t) => !["I", "the"].includes(templateClozeTarget("I think the {물건} is nice.", t)?.word ?? "")) &&
      TOEIC_TEMPLATE_CLOZE_SKIP_WORDS.includes("they"),
    "",
  );
  add(
    "전치사·be동사·축약형은 비운다 · 낱말 뒤 문장부호는 빈칸 밖",
    templateClozeTarget("It's set on {장소}.", 0)?.word === "It's" && templateClozeTarget("It's set on {장소}.", 2)?.word === "on" &&
      eqJson(templateClozeTarget("Look, {사람} is here.", 0), { word: "Look", before: "", after: ", {사람} is here." }) &&
      templateClozeTarget("{사람} is sitting near {장소}.", 1)?.after === " near {장소}.".replace(" near", " near") &&
      templateClozeTarget("Honestly, the mood is {느낌}.", 0)?.after.startsWith(",") === true,
    JSON.stringify(templateClozeTarget("Look, {사람} is here.", 0)),
  );
  add(
    "후보 없음 → 관사만 뺀 낱말(주어 대명사도 후보) → 그래도 없으면 출제 안 함(null)",
    templateClozeTarget("I {동작} it.", 0)?.word === "I" && templateClozeTarget("The {x}.", 0) === null && templateClozeTarget("{a} {b}.", 3) === null,
    "",
  );
  add(
    "고정 부분에 두 번 나오는 낱말은 후보가 아니다(said)",
    [0, 1, 2, 3].every((t) => templateClozeTarget("{사람} said yes, then said {대답}.", t)?.word !== "said"),
    [0, 1].map((t) => templateClozeTarget("{사람} said yes, then said {대답}.", t)?.word).join(","),
  );
  {
    const pool = [...q11, tpl("upside-matters", "장단점", "Upside matters to {사람}.", "좋은 점은 {사람}에게 중요하다.", ["q11"])];
    const cz = buildTemplateChoiceQuestions(pool.filter((t) => t.key === "upside"), pool, [], { modes: ["tpl-cloze"], rng: makeRng(11), flow: FLOW_Q11 }).questions[0];
    add(
      "빈칸 오답 보기: 정답과 같은 낱말(Upside — 대소문자)·이 틀 고정 낱말(here·is)·넣으면 다른 틀이 되는 낱말(downside)이 빠진다",
      cz !== undefined && cz.answer === "upside" && cz.cloze?.before === "The " && !cz.choices.some((c) => c.toLowerCase() === "downside" || c.toLowerCase() === "here" || c.toLowerCase() === "is") &&
        cz.choices.filter((c) => c.toLowerCase() === "upside").length === 1 && cz.prompt === "여기서 좋은 점은 ~이에요.",
      cz ? cz.choices.join(" / ") : "",
    );
    const head = buildTemplateChoiceQuestions(pool.filter((t) => t.key === "side-with"), pool, [], { modes: ["tpl-cloze"], rng: makeRng(12), flow: FLOW_Q11 }).questions[0];
    const slotFirst = tpl("helps", "예시", "{활동} helps me relax.", "{활동}은 긴장을 푸는 데 도움이 돼요.", ["q11"]);
    const sf = buildTemplateChoiceQuestions([slotFirst], [...pool, slotFirst], [], { modes: ["tpl-cloze"], rng: makeRng(13), flow: FLOW_Q11 }).questions[0];
    add(
      "보기 대소문자: before가 비었을 때만 대문자 머리 · 자리로 시작하는 틀의 첫 고정 낱말은 소문자",
      head !== undefined && head.cloze?.before === "" && head.choices.every((c) => /^[A-Z]/.test(c)) &&
        sf !== undefined && sf.answer === "helps" && sf.choices.every((c) => c === c.toLowerCase() || c === "I"),
      `${head?.choices.join("/")} | ${sf?.choices.join("/")}`,
    );
  }
  // onlyWrong
  {
    const sessions = [sess("w", "tpl-cloze", "2026-10-01T00:00:00.000Z", [["wrap", false], ["upside", true]])];
    const ow = buildTemplateChoiceQuestions(q11, q11, sessions, { onlyWrong: "tpl-cloze", rng: makeRng(14), flow: FLOW_Q11 });
    add("onlyWrong: 그 모드 틀린 틀만·모드 하나", ow.questions.length === 1 && ow.questions[0].key === "wrap" && ow.questions[0].mode === "tpl-cloze", ow.questions.map((q) => `${q.key}:${q.mode}`).join(","));
    const atts = templateAttemptCounts(sessions, "tpl-cloze").get("wrap")?.count ?? 0;
    add("빈칸 낱말 차례 t = 그 틀의 tpl-cloze 시도 수(templateAttemptCounts)", atts === 1 && ow.questions[0].answer.toLowerCase() === (templateClozeTarget("To wrap up, I {결론}.", 1)?.word ?? "").toLowerCase(), ow.questions[0].answer);
  }
  // 약한 순위 — 그 모드의 통계
  {
    const sessions = [sess("s", "tpl-ko-frame", "2026-10-01T00:00:00.000Z", [["cousin", false]])];
    const w = buildTemplateChoiceQuestions(q11, q11, sessions, { max: 1, modes: ["tpl-ko-frame"], rng: makeRng(15), flow: FLOW_Q11 });
    add("순위: 그 모드에서 틀렸고 미졸업인 틀이 먼저", w.questions[0]?.key === "cousin", w.questions[0]?.key ?? "");
  }
  return results;
}

function runTemplateQuizStatsChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "③ 틀 시험 — 통계·기록");
  const d1a = "2026-10-01T01:00:00.000Z";
  const d1b = "2026-10-01T05:00:00.000Z";
  const d2 = "2026-10-02T01:00:00.000Z";
  const choice = [sess("c1", "tpl-ko-frame", d1a, [["wrap", true], ["upside", false]]), sess("c2", "tpl-ko-frame", d1b, [["wrap", true]]), sess("c3", "tpl-cloze", d2, [["wrap", false]])];
  const st = aggregateToeicTemplateChoiceStats(choice);
  add(
    "고르기 세 모드가 서로 섞이지 않는다(같은 날 잇단 ○는 하나로 접는다)",
    st["tpl-ko-frame"]["wrap"]?.total === 1 && st["tpl-ko-frame"]["upside"]?.wrong === 1 && st["tpl-cloze"]["wrap"]?.total === 1 && st["tpl-cloze"]["wrap"]?.wrong === 1 && st["tpl-frame-ko"]["wrap"] === undefined,
    JSON.stringify(st["tpl-ko-frame"]["wrap"]),
  );
  add(
    "같은 날 ○○ → 연속 1(오늘 ○ 배지) · 다른 날 ○○ → 졸업",
    st["tpl-ko-frame"]["wrap"]?.streak === 1 && toeicTemplateChoiceBadges(choice, "2026-10-01")["tpl-ko-frame"]["wrap"] === "today" &&
      toeicTemplateChoiceBadges([...choice, sess("c4", "tpl-ko-frame", d2, [["wrap", true]])], "2026-10-03")["tpl-ko-frame"]["wrap"] === "mastered",
    "",
  );
  const speak = [sess("p1", "tpl-recall", d1a, [["wrap", false], ["cousin", false]]), sess("p2", "tpl-swap", d2, [["upside", true]])];
  const mixed = [...speak, ...choice].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  add(
    "말하기 세션이 고르기 통계를 바꾸지 않는다",
    eqJson(aggregateToeicTemplateChoiceStats(mixed), aggregateToeicTemplateChoiceStats(choice)) && eqJson(toeicTemplateChoiceBadges(mixed, "2026-10-03"), toeicTemplateChoiceBadges(choice, "2026-10-03")),
    "",
  );
  const keys = new Set(Q11_ITEMS.map((t) => t.key));
  add(
    "고르기 세션이 말하기 통계·배지·templatesByWeakness·틀린 틀(두 모드)·최근 틀 테스트를 바꾸지 않는다",
    eqJson(aggregateToeicTemplateStats(mixed), aggregateToeicTemplateStats(speak)) && eqJson(toeicTemplateBadges(mixed, "2026-10-03"), toeicTemplateBadges(speak, "2026-10-03")) &&
      eqJson(templatesByWeakness(Q11_ITEMS, mixed, makeRng(1)).map((t) => t.key), templatesByWeakness(Q11_ITEMS, speak, makeRng(1)).map((t) => t.key)) &&
      eqJson([...toeicTemplateWrongKeysAnyMode(mixed)].sort(), [...toeicTemplateWrongKeysAnyMode(speak)].sort()) &&
      eqJson(recentTemplateTests(mixed, keys).map((r) => r.id), recentTemplateTests(speak, keys).map((r) => r.id)),
    "",
  );
  add(
    "toeicTemplateChoiceWrongKeys = 그 모드에서 틀렸고 미졸업 · ② 카드 칩 = 틀린 고르기 모드 수(0이면 키 없음, 졸업만 있는 틀 → 칩 없음)",
    eqJson([...toeicTemplateChoiceWrongKeys(choice, "tpl-ko-frame")], ["upside"]) &&
      (() => {
        const mastered = [sess("m1", "tpl-frame-ko", d1a, [["leans", true]]), sess("m2", "tpl-frame-ko", d2, [["leans", true]])];
        const counts = toeicTemplateChoiceWrongModeCounts([...choice, ...mastered, sess("x", "tpl-frame-ko", d2, [["upside", false]])]);
        return counts.get("upside") === 2 && counts.get("wrap") === 1 && !counts.has("leans");
      })(),
    "",
  );
  {
    const recent = recentTemplateChoiceTests(
      [
        sess("r1", "tpl-ko-frame", d2, [["wrap", true], ["upside", false]], false),
        sess("r2", "tpl-cloze", d2, [["leans", true]]),
        sess("r3", "tpl-frame-ko", d1a, [["wrap", true]]),
        sess("r4", "tpl-recall", d2, [["wrap", true]]),
        sess("r5", "tpl-ko-frame", d1b, [["side", true]]),
      ],
      new Set(["wrap", "upside", "leans"]),
    );
    add(
      "최근 틀 시험: 같은 startedAt 모드 문서를 한 줄로(모드들·○ n / 전체·그만둠) · 최신 먼저 · 말하기·그 유형 틀 없는 세션 제외",
      recent.length === 2 && eqJson(recent[0].modes, ["tpl-ko-frame", "tpl-cloze"]) && recent[0].correct === 2 && recent[0].answered === 3 && !recent[0].finished && eqJson(recent[1].modes, ["tpl-frame-ko"]) && recent[1].finished,
      JSON.stringify(recent.map((r) => [r.modes, r.correct, r.answered, r.finished])),
    );
  }
  // 기록 라우트 zod
  const body = (mode: string, n: number) => ({
    clientSessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    mode,
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: null,
    items: Array.from({ length: n }, (_x, i) => ({ word: `tpl:t-${i}`, correct: true, answered: true })),
  });
  const ok = (v: unknown) => toeicTemplateSessionBodySchema.safeParse(v).success;
  add(
    "기록 라우트 zod: mode 다섯 · 고르기 items 20 통과·21 거부 · 말하기 10 통과·11 거부 · 모르는 모드 거부",
    TOEIC_TEMPLATE_BANK_MODES.every((m) => ok(body(m, 1))) && ok(body("tpl-cloze", 20)) && !ok(body("tpl-ko-frame", 21)) && ok(body("tpl-recall", 10)) && !ok(body("tpl-swap", 11)) && !ok(body("tpl-quiz", 1)),
    "",
  );
  // 러너 저장 본문
  const ids = { "tpl-ko-frame": "0f8fad5b-d9cb-469f-a165-70867728950e", "tpl-frame-ko": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "tpl-cloze": "16fd2706-8baf-433b-82eb-8c7fada847da" } as Record<ToeicTemplateChoiceMode, string>;
  const bodies = buildTemplateChoiceSessionBodies({
    answers: [
      { mode: "tpl-ko-frame", key: "wrap", correct: true },
      { mode: "tpl-ko-frame", key: "upside", correct: false },
      { mode: "tpl-cloze", key: "leans", correct: true },
    ],
    sessionIds: ids,
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: null,
  });
  add(
    "러너 저장 본문: 모드마다 한 건·답한 문항만(answered true)·답한 0인 모드는 본문을 만들지 않음·본문이 기록 zod를 통과 · 판 전체 0 → 본문 0",
    bodies.length === 2 && eqJson(bodies.map((b) => b.mode), ["tpl-ko-frame", "tpl-cloze"]) && bodies[0].clientSessionId === ids["tpl-ko-frame"] && bodies.every((b) => b.items.every((it) => it.answered === true)) &&
      bodies.every((b) => ok(b)) && buildTemplateChoiceSessionBodies({ answers: [], sessionIds: ids, startedAt: "2026-10-02T00:00:00.000Z", finishedAt: null }).length === 0,
    "",
  );
  // 러너 주소
  const groups = templateFlowOrder(BANK, "q11");
  const href = toeicTemplateChoiceQuizHref("q11", { modes: ["tpl-cloze", "tpl-ko-frame"], scope: "group", i: 1 });
  const parsed = parseTemplateChoiceQuizParams((n) => new URL(`https://x${href}`).searchParams.get(n));
  add(
    "러너 주소: scope=step|group의 i가 번호 → 범위 · 주소에 단계·묶음 이름이 없다",
    !href.includes(encodeURIComponent("장단점")) && !/[가-힣]/.test(decodeURIComponent(href)) && parsed.scope === "group" && parsed.i === 1 &&
      eqJson(templateChoiceScopeTemplates(groups, parsed).templates.map((t) => t.key), groups[1].templates.map((t) => t.key)) &&
      eqJson(templateChoiceScopeTemplates(groups, { scope: "step", i: 1 }).templates.map((t) => t.key), ["upside", "downside", "best-part", "cuts", "costs-saves"]),
    href,
  );
  add(
    "범위 밖 번호·모르는 값 → 유형 전체(모드 셋 다) · wrong 범위에 모드가 없으면 전체",
    templateChoiceScopeTemplates(groups, { scope: "group", i: 99 }).scope === "all" && templateChoiceScopeTemplates(groups, { scope: "step", i: 9 }).templates.length === Q11_ITEMS.length &&
      eqJson(parseTemplateChoiceQuizParams(() => null), { modes: [...TOEIC_TEMPLATE_CHOICE_MODES], scope: "all", i: null, wrong: null }) &&
      parseTemplateChoiceQuizParams((n) => (n === "scope" ? "wrong" : null)).scope === "all" &&
      parseTemplateChoiceQuizParams((n) => (n === "scope" ? "wrong" : n === "wrong" ? "tpl-cloze" : null)).wrong === "tpl-cloze",
    "",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 8. 🧩 틀 점검 (§12-13-3 검토 B4)
// ---------------------------------------------------------------------------

function runTemplateCheckChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "🧩 틀 점검 — 새 순서");
  const byExpression = new Map<string, string>([["f1 ~", "f1"], ["f2 ~", "f2"]]);
  const r = templatesCouldHaveUsed({
    missingStepKeys: ["s1", "s2", "s3", "s4"],
    tryExpressions: ["F1 ~", "f2 ~"],
    sampleKeys: ["a", "b", "c", "d", "e", "f"],
    mine: new Set(),
    byExpression,
  });
  add(
    "모범답변 틀 6·내 틀 0·빠진 단계 4·피드백 2 → 앞 4개 step(단계 순서), 다섯째 feedback 첫째, sample 잘림(최대 5)",
    eqJson(r.map((x) => `${x.source}:${x.key}`), ["step:s1", "step:s2", "step:s3", "step:s4", "feedback:f1"]),
    r.map((x) => `${x.source}:${x.key}`).join(","),
  );
  const r2 = templatesCouldHaveUsed({ missingStepKeys: [], tryExpressions: ["f1 ~"], sampleKeys: ["a", "b"], mine: new Set(["b"]), byExpression });
  add("빠진 단계 0·피드백 1·모범답변 2 → feedback → sample 순 · 내 틀은 어느 출처에서도 빠진다", eqJson(r2.map((x) => `${x.source}:${x.key}`), ["feedback:f1", "sample:a"]), "");

  const data = toeicTemplateCheckData("q3_4", Q34_ITEMS, BANK.flows, []);
  add("toeicTemplateCheckData = toeicDrillCheckData(옛 이름) · 예문·testFills를 넘기지 않는다", eqJson(data, toeicDrillCheckData("q3_4", Q34_ITEMS, BANK.flows, [])) && !JSON.stringify(data).includes("SECRETFILL") && !JSON.stringify(data).includes("examples"), "");
  const sampleAnswer = "The photo was snapped at a market. My overall take is that it is a festival.";
  const c = drillTemplateCheck(data, { transcript: "Um, there are some people.", sampleAnswer, sampleUsedExpressions: [], tryExpressions: [] });
  add(
    "빠진 단계의 key = 그 단계에서 모범답변이 쓴 틀(글에서 찾음), 없으면 가장 약한 틀(drillStepPicks)",
    eqJson(c.missingSteps, ["장면 열기", "인물", "인상"]) && eqJson(c.suggestions.map((x) => `${x.source}:${x.key}`), ["step:venue-open", `step:${data.stepPicks[1].key}`, "step:feel"]),
    c.suggestions.map((x) => `${x.source}:${x.key}`).join(","),
  );
  const pre = drillTemplateCheck(data, { transcript: null, sampleAnswer, sampleUsedExpressions: ["~ has on ~"], tryExpressions: ["The sky looks ~"] });
  add("채점 전 → sample만(글에서 찾은 순 → usedExpressions 되짚기)", !pre.scored && eqJson(pre.suggestions.map((x) => `${x.source}:${x.key}`), ["sample:venue-open", "sample:feel", "sample:wear"]), pre.suggestions.map((x) => x.key).join(","));
  const summary = toeicTemplateCheckSummary([
    { scored: true, used: [{ key: "a", stepKo: null, groupKo: "" }], missingSteps: ["x"] },
    { scored: true, used: [], missingSteps: [] },
    { scored: true, used: [{ key: "b", stepKo: null, groupKo: "" }], missingSteps: ["y", "z"] },
    { scored: false, used: [], missingSteps: [] },
  ]);
  add(
    "toeicTemplateCheckSummary: 채점 3문항(틀 쓴 문항 2) + 빠진 단계 1 + 2 → \"2/3 · 3\" · 채점 0 → null",
    summary?.textKo === "🧩 틀을 쓴 문항 2/3 · 빠진 단계 3" && toeicTemplateCheckSummary([{ scored: false, used: [], missingSteps: [] }]) === null,
    summary?.textKo ?? "null",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 9. 라우트 소스 대조 — 이 단계가 손댄 연습·다시 만들기(모의고사 라우트·화면은 app 단계)
// ---------------------------------------------------------------------------

function runRouteSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "템플릿 중심 — 라우트 소스");
  const drill = codeOnly(read("app/api/toeic/guides/[part]/drills/route.ts"));
  add(
    "연습 라우트: 흐름 = buildAnswerFlow(…, { order: \"weakness\", sessions: 틀 세션 }) → 호출 C answerFlow · 문서 answerFlows: [흐름] · 흐름 예외는 흐름 없이 계속",
    /buildAnswerFlow\(bankDoc, mockPart, templates, \{ order: "weakness", sessions: templateSessions \}\)/.test(drill) &&
      /generateMockPart\(mockPart, \{ targetGrade, topicHints, expressions, answerFlow \}\)/.test(drill) &&
      /answerFlows: answerFlow \? \[answerFlow\] : \[\],/.test(drill) &&
      /catch \(err\) \{\s*console\.error\(`[^`]*답변 흐름 실패[^`]*`, errName\(err\)\);\s*answerFlow = null;/.test(drill),
    "",
  );
  add(
    "연습 라우트: 새 pickExpressionsForDrill(틀 칸 없음, guide.exclude = guideExpressionKeysInFlow) · 키 검사가 호출 C보다 앞",
    /pickExpressionsForDrill\(\{\s*guide: \{ set: guideOk \? guideSet : null, sessions: guideSessions, exclude: bankDoc \? guideExpressionKeysInFlow\(bankDoc, part\) : new Set<string>\(\) \},/.test(drill) &&
      !/templates: \{ part, flows/.test(drill) &&
      drill.indexOf("process.env.OPENAI_API_KEY") >= 0 && drill.indexOf("process.env.OPENAI_API_KEY") < drill.indexOf("generateMockPart("),
    "",
  );
  add("연습 라우트 로그: 개수만(흐름 단계·틀 수) — 틀 글자를 싣지 않는다", !/console\.[a-z]+\([^;]*expression[^s]/.test(drill) && /흐름 단계 \$\{answerFlow\?\.steps\.length \?\? 0\}/.test(drill), "");
  const regen = codeOnly(read("app/api/toeic/mocks/[id]/regenerate/route.ts"));
  add(
    "다시 만들기 라우트: 문서의 그 파트 흐름을 넘기고 틀 은행을 읽지 않는다(실패 파트·고르지 않은 파트 같은 갈래) · 키 검사가 호출 C보다 앞",
    /answerFlow: mock\.answerFlows\.find\(\(f\) => f\.part === part\) \?\? null,/.test(regen) && !/TOEIC_TEMPLATE_BANK_ID|listToeicSets\(|getToeicSet\(/.test(regen) &&
      regen.indexOf("process.env.OPENAI_API_KEY") < regen.indexOf("generateMockPart("),
    "",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 9-1. 앱 층 소스 대조(§12-13-5 — app 단계: 모의고사 라우트·①③④ 화면·결과·학습 보기). 라우트 핸들러·화면을 부르지 않는다
// ---------------------------------------------------------------------------

function runAppSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "템플릿 중심 — 앱 소스");

  // ── 실전 모의고사 라우트(§12-13-3 검토 B1·S10) ──
  const mocks = codeOnly(read("app/api/toeic/mocks/route.ts"));
  const fnAt = mocks.indexOf("function mockAnswerFlowsFrom(");
  const fn = fnAt < 0 ? "" : mocks.slice(fnAt, mocks.indexOf("\nexport async function POST(", fnAt));
  add(
    "모의고사 라우트: 틀 은행은 이미 읽는 listToeicSets() 결과에서 TOEIC_TEMPLATE_BANK_ID로 찾고 isRenderableToeicTemplateBank(읽기 추가 0) → buildMockAnswerFlows(네 파트 전부·order flow)",
    /answerFlows = mockAnswerFlowsFrom\(sets\);/.test(mocks) &&
      /const bank = sets\.find\(\(s\) => s\.id === TOEIC_TEMPLATE_BANK_ID\) \?\? null;/.test(fn) &&
      /if \(bank === null \|\| !isRenderableToeicTemplateBank\(bank\)\) return \[\];/.test(fn) &&
      /TOEIC_GUIDE_PARTS\.map\(\(p\) => \[p, guideTemplatesForPart\(bankDoc\.items, p\)\.templates\]\)/.test(fn) &&
      /return buildMockAnswerFlows\(bankDoc, templatesByPart,/.test(fn) &&
      !/getToeicSet\(|listToeicQuizzes\(/.test(mocks) &&
      (mocks.match(/store\.listToeicSets\(\)/g) ?? []).length === 1,
    "",
  );
  add(
    "모의고사 라우트: 고른 파트로 거르지 않는다(chosen 없음) · 흐름 예외는 [](500으로 가지 않는다 — try/catch + onError)",
    fn !== "" && !/chosen/.test(fn) && /\} catch \(err\) \{\s*console\.error\([^;]*errName\(err\)\);\s*return \[\];/.test(fn) && /\(part, err\) => \{\s*console\.error\(/.test(fn),
    "",
  );
  add(
    "모의고사 라우트: 파트마다 다른 입력(흐름만 다르다) · read는 흐름 null · 문서 answerFlows = 네 파트 흐름 · 키 검사가 호출 C보다 앞",
    /const flowOf = \(part: ToeicMockPart\): ToeicAnswerFlow \| null => \(part === "read" \? null : \(answerFlows\.find\(\(f\) => f\.part === part\) \?\? null\)\);/.test(mocks) &&
      /generateMockPart\(part, \{ targetGrade, topicHints, expressions, answerFlow: flowOf\(part\) \}\)/.test(mocks) &&
      /drillPart: null,\s*answerFlows,/.test(mocks) &&
      !/answerFlow: null/.test(mocks) &&
      mocks.indexOf("process.env.OPENAI_API_KEY") >= 0 && mocks.indexOf("process.env.OPENAI_API_KEY") < mocks.indexOf("generateMockPart("),
    "",
  );
  add(
    "모의고사 라우트 로그: 개수만(흐름 단계·틀 수) — 틀 글자(expression)를 싣지 않는다",
    /흐름 단계 \$\{f\.steps\.length\}/.test(mocks) && !/console\.[a-z]+\([^;]*\.expression\b/.test(mocks),
    "",
  );

  // ── ① 공략 읽기(§12-13-1) ──
  const rv = codeOnly(read("components/toeic-guide-read-view.tsx"));
  add(
    "① 읽기: 판정은 guideReadMarks(연결 표·같은 자리 다른 표현 표·그 유형 틀) 하나 → skip = guideReadScriptSkip(marks)",
    /const marks = useMemo\(\(\) => guideReadMarks\(sections, links, altLinks, templates\)/.test(rv) &&
      /const altLinks: ToeicTemplateGuideLinks = useMemo\(\(\) => templateAlternateLinks\(\{ alternates \}, part\)/.test(rv) &&
      /const skip = useMemo\(\(\) => guideReadScriptSkip\(marks\), \[marks\]\);/.test(rv),
    "",
  );
  add(
    "① 읽기: 섹션 ▶·처음부터·진행·프리페치·줄 🔊·text 블록 🔊가 쓰는 대본(script·addr) = skip 적용 대본 · 프리페치는 그 대본만",
    /buildToeicGuideScript\(guide, mode, \{ pause: mode === "english-only" && pauseOn, pauseLevel, skip \}\)/.test(rv) &&
      /const addr = useMemo\(\(\) => buildAddress\(script\), \[script\]\);/.test(rv) &&
      /toeicGuidePrefetchTexts\(script, open\)/.test(rv) && !/toeicGuidePrefetchTexts\(fullScript/.test(rv) &&
      /: speakBtn\(addr\.block\.get\(`\$\{si\}:\$\{bi\}`\), "이 설명"\)/.test(rv),
    "",
  );
  add(
    "① 읽기: 접기 안 줄 🔊 = skip 없는 대본(toeicGuideLinePieces·toeicGuideBlockPieces(fullScript…)) · 접힌 머리말 🔊 = toeicGuideLeadPieces — 둘 다 탭할 때만(프리페치 없음)",
    /const fullScript = useMemo\(\(\) => buildToeicGuideScript\(guide, mode, \{ pause: mode === "english-only" && pauseOn, pauseLevel \}\)/.test(rv) &&
      /foldSpeakBtn\(toeicGuideLinePieces\(fullScript, si, bi, li\), label\)/.test(rv) &&
      /foldSpeakBtn\(toeicGuideBlockPieces\(fullScript, si, bi\), "이 설명"\)/.test(rv) &&
      /foldSpeakBtn\(toeicGuideLeadPieces\(block, si, bi, mode\), "이 머리말"\)/.test(rv) &&
      (rv.match(/prefetchSpeech\(/g) ?? []).length === 1,
    "",
  );
  add(
    "① 읽기: goto k: — findGuideGotoBlock·guideReadInitialOpen에 marks · 머리 줄 m = guideReadFrameKeys(marks) · 안쪽 접기 여닫기는 섹션 열림이 아니다",
    /findGuideGotoBlock\(sections, goto, marks\)/.test(rv) && /guideReadInitialOpen\(sections, goto, marks\)/.test(rv) &&
      /guideReadFrameKeys\(marks\)\.size/.test(rv) && /if \(e\.target !== e\.currentTarget\) return;/.test(rv),
    "",
  );
  add(
    "① 읽기: 틀 줄 🔊 = cleanGuideEnForTts(frameEn)(② 카드 영어 틀 소개와 같은 글자) · 끝에 읽기 전용 📘 교재 표현 목록",
    /playPieces\(splitForTts\(cleanGuideEnForTts\(frameEn\), TTS_TEXT_MAX_CHARS\)/.test(rv) && /<ToeicGuideExprList part=\{part\} expressions=\{expressions\}/.test(rv),
    "",
  );
  const ex = codeOnly(read("components/toeic-guide-expr-list.tsx"));
  add(
    "① 끝 교재 표현 목록: 읽기 전용 — prefetchSpeech·?expr·시험/오답노트/기록 링크·Link 없음, 🔊는 trim만(탭할 때만), 같은 자리 다른 표현은 안쪽 접기",
    !/prefetchSpeech|findGuideExpressionIndex|focusExpr|\/toeic\/sets\/|next\/link|toeicGuideSetId/.test(ex) &&
      /speak\(e\.expression\.trim\(\), "en-US"\)/.test(ex) && !/cleanGuideEnForTts/.test(ex) &&
      /altLinks\.expressions\.has\(expressionKey\(e\.expression\)\)/.test(ex) && /↳ 같은 자리 다른 표현/.test(ex),
    "",
  );

  // ── ③ 👀 틀 시험(§12-13-2) ──
  const qp = codeOnly(read("app/toeic/guides/[part]/templates/quiz/page.tsx"));
  add(
    "③ 러너 페이지: force-dynamic · 네 유형 밖 404 · 문항은 서버가 buildTemplateChoiceQuestions(범위 틀, 그 유형 틀 전부, 틀 은행 세션, 모드·onlyWrong·흐름) 한 번 · 범위는 번호(templateChoiceScopeTemplates)",
    /export const dynamic = "force-dynamic"/.test(qp) && /if \(!isToeicGuidePart\(part\)\) notFound\(\)/.test(qp) &&
      /const scoped = templateChoiceScopeTemplates\(groups, p\);/.test(qp) &&
      /buildTemplateChoiceQuestions\(scoped\.templates, templates, sessions, \{/.test(qp) &&
      /flow: flows\.find\(\(f\) => f\.part === part\) \?\? null,/.test(qp),
    "",
  );
  add("③ 러너 페이지: 화면에 문항 칸만(틀 객체·testFills 넘기지 않음)", !/testFills|templates=\{/.test(qp) && /questions=\{built\.questions\}/.test(qp), "");
  const rq = codeOnly(read("components/toeic-template-quiz.tsx"));
  const chooseAt = rq.indexOf("function choose(");
  const chooseFn = chooseAt < 0 ? "" : rq.slice(chooseAt, rq.indexOf("\n  }\n", chooseAt));
  add(
    "③ 러너: 문제는 소리 없음 — 답을 고르는 탭 안에서 동기로 영어 틀(cleanGuideEnForTts) 재생 · 정지는 큐 stop(stopSpeaking 없음) · 프리페치 1곳",
    /play\(cleanGuideEnForTts\(cur\.frameEn\)\);/.test(chooseFn) && !/await|setTimeout/.test(chooseFn) && !/stopSpeaking/.test(rq) &&
      /const stop = speakQueue\(items,/.test(rq) && (rq.match(/prefetchSpeech\(/g) ?? []).length === 1,
    "",
  );
  add(
    "③ 러너 저장: buildTemplateChoiceSessionBodies(모드마다 한 건 — 답한 문항 0인 모드 생략) → 기록 라우트 · 일부 실패면 '다시 저장'이 같은 키로 전부 · 떠날 때 keepalive(templateTestLeaveSave)·pagehide 비캐시",
    /buildTemplateChoiceSessionBodies\(\{/.test(rq) && /const SESSIONS_URL = "\/api\/toeic\/guides\/templates\/sessions";/.test(rq) &&
      /const plan = templateTestLeaveSave\(\{/.test(rq) && /keepalive: true/.test(rq) &&
      /if \(!e\.persisted\) leaveSaveRef\.current\(\);/.test(rq) &&
      /window\.dispatchEvent\(new Event\(STREAK_REFRESH_EVENT\)\)/.test(rq) &&
      /newTemplateSessionId\(\)/.test(rq),
    "",
  );
  const qt = codeOnly(read("components/toeic-template-quiz-tab.tsx"));
  add(
    "③ 탭: 시작 주소 = toeicTemplateChoiceQuizHref(번호만) · 낼 수 있는 문항 수 = buildTemplateChoiceQuestions(세션 없이 — 출제 가능 여부만) · 소리·프리페치 없음",
    /toeicTemplateChoiceQuizHref\(part, \{ modes, scope: scope\.kind, i: scope\.i \}\)/.test(qt) &&
      /buildTemplateChoiceQuestions\(scopeTemplates, templates, \[\], \{/.test(qt) && !/speak|prefetchSpeech/.test(qt.replace(/소리/g, "")),
    "",
  );
  const fv = codeOnly(read("components/toeic-guide-folder-view.tsx"));
  const fp = codeOnly(read("app/toeic/guides/[part]/page.tsx"));
  add(
    "폴더: ③ 탭 = ToeicTemplateQuizTab · 폴더 페이지가 유형 공략 세트의 시험 세션을 읽지 않는다(listToeicQuizzes는 틀 은행 하나) · 고르기 통계는 aggregateToeicTemplateChoiceStats",
    /<ToeicTemplateQuizTab/.test(fv) && (fp.match(/listToeicQuizzes\(/g) ?? []).length === 1 && /store\.listToeicQuizzes\(TOEIC_TEMPLATE_BANK_ID\)/.test(fp) &&
      /aggregateToeicTemplateChoiceStats\(bankSessions\)/.test(fp) && /toeicTemplateChoiceWrongModeCounts\(bankSessions\)/.test(fp) && !/exprBadges|aggregateToeicStatsByMode/.test(fp),
    "",
  );
  const tv = codeOnly(read("components/toeic-template-view.tsx"));
  add(
    "② 카드: 옛 '표현 시험:' 줄 대신 틀린 것만 '👀 ✕ n'(0이면 없음) · 📘 교재 틀 표현 연결 = guideRefHref(ref, 틀 key)(① 본문에 외울 틀 줄이 있을 때만)",
    !/표현 시험: |exprBadges/.test(tv) && /\{choiceWrong > 0 && \(/.test(tv) && /onNavigate\(guideRefHref\(ref, key\)\)/.test(tv) &&
      /r\.kind === "expression" && r\.part === part && !readFrames\.has\(t\.key\)/.test(tv),
    "",
  );

  // ── ④·결과·학습 보기(§12-13-3) ──
  const dv = codeOnly(read("components/toeic-drill-view.tsx"));
  add("④ 준비 접기: 단계마다 첫 틀(frames[0]) + '+n'(그 단계 틀 전부) + 소재 틀 접기", /flowFrame\(st\.frames\[0\]\)/.test(dv) && /\+\{st\.frames\.length - 1\}/.test(dv) && /소재 틀 \{fold\.banks\.length\}/.test(dv), "");
  const av = codeOnly(read("components/toeic-attempt-view.tsx"));
  add(
    "결과 화면: 모범답변 점검 줄 = answerFlowCheckLine(모범답변, 저장된 그 파트 흐름, 파트) · 미달이면 경고 · 모의고사 머리 줄 = toeicTemplateCheckSummary(연습에는 없음)",
    /answerFlowCheckLine\(v\.sampleAnswer, flowOf\(v\.part\), v\.part\)/.test(av) && /\{line\.weak && \(/.test(av) && /TOEIC_ANSWER_FLOW_WEAK_KO/.test(av) &&
      /const checkSummary = drill \? null : toeicTemplateCheckSummary\(\[\.\.\.checkResults\.values\(\)\]\);/.test(av),
    "",
  );
  const mv = codeOnly(read("components/toeic-mock-detail-view.tsx"));
  add(
    "학습 보기: 파트마다 '🧩 이 파트 답변 흐름'(저장된 흐름 — 없으면 숨김) · 모범답변마다 answerFlowCheckLine · 미달 경고가 흐름 접기를 연다 · 틀 강조는 흐름 글자 집합",
    /const flowOf = \(part: ToeicMockPart\) => mock\.answerFlows\.find\(\(f\) => f\.part === part\) \?\? null;/.test(mv) &&
      /if \(!flow \|\| !gp\) return null;/.test(mv) && /answerFlowCheckLine\(text, flowOf\(part\), part\)/.test(mv) &&
      /onClick=\{\(\) => openFlow\(part\)\}/.test(mv) && /answerFlowExpressions\(f\)\.map\(expressionKey\)/.test(mv) &&
      ["picture", "respond", "info", "opinion"].every((p) => mv.includes(`{p.${p} && flowFold("${p}")}`)) && !mv.includes('flowFold("read")'),
    "",
  );

  // ── 화면 번들 경계(새·바뀐 클라이언트 파일) ──
  for (const f of ["components/toeic-template-quiz.tsx", "components/toeic-template-quiz-tab.tsx", "components/toeic-guide-read-view.tsx", "components/toeic-guide-expr-list.tsx", "components/toeic-attempt-view.tsx", "components/toeic-mock-detail-view.tsx"]) {
    const src = read(f);
    const bad = runtimeImportPaths(src).filter((x) => /(lib\/ai|\/store|openai|zod|toeic-normalize|guide-import)/.test(x));
    add(`${f}: "use client" · lib/ai·store·openai·zod 값 import 없음 · stopSpeaking 없음`, /^"use client";/.test(src) && bad.length === 0 && !/stopSpeaking/.test(codeOnly(src)), bad.join(","));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 10. 번들 경계 — lib/toeic-template-quiz.ts (§12-13-6)
// ---------------------------------------------------------------------------

function runBundleChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "템플릿 중심 — 번들 경계");
  const allow: Record<string, readonly string[]> = {
    "lib/toeic-template-quiz.ts": ["./vocab-quiz", "./vocab-mastery", "./kst", "./toeic-text", "./toeic-quiz", "./toeic-template"],
    "lib/toeic-template.ts": ["./tts-shared", "./tts-split", "./toeic-guide", "./toeic-text", "./toeic-score", "./toeic-quiz", "./vocab-mastery", "./kst"],
    "lib/toeic-guide-view.ts": ["./toeic-guide", "./toeic-template", "./toeic-record", "./toeic-text", "./vocab-mastery"],
    "lib/toeic-drill-view.ts": ["./toeic-drill", "./toeic-guide-view", "./toeic-template", "./toeic-mock"],
  };
  for (const [file, ok] of Object.entries(allow)) {
    const src = read(file);
    const paths = runtimeImportPaths(src);
    const bad = paths.filter((p) => !ok.includes(p));
    add(`${file}: 런타임 import ⊂ 허용 목록 · lookbehind 없음`, bad.length === 0 && !/\(\?<[=!]/.test(src), bad.join(",") || paths.join(","));
  }
  for (const f of ["lib/toeic-template.ts", "lib/toeic-quiz.ts"]) {
    add(`${f}는 lib/toeic-template-quiz를 import하지 않는다(순환 금지)`, !/from\s+["'][^"']*toeic-template-quiz["']/.test(read(f)), "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 11. 실제 가져오기 파일 (data/private — 개수만)
// ---------------------------------------------------------------------------

const REAL_GUIDE_FILE = new URL("../data/private/toeic-strategy/toeic-guides.json", import.meta.url);

function runRealFileChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "템플릿 중심 — 실제 파일");
  if (!existsSync(REAL_GUIDE_FILE)) {
    results.push({ book: "템플릿 중심 — 실제 파일", check: "실제 가져오기 파일 집계", pass: true, skip: true, detail: "data/private/toeic-strategy/toeic-guides.json 없음 — 공개 저장소 기준 SKIP" });
    return results;
  }
  let file: ToeicGuideFile;
  try {
    const r = toeicGuideFileSchema.safeParse(JSON.parse(readFileSync(REAL_GUIDE_FILE, "utf-8")));
    if (!r.success) {
      add("zod 통과", false, `${r.error.issues.length}곳`);
      return results;
    }
    file = r.data;
  } catch {
    add("JSON 파싱", false, "실패");
    return results;
  }
  if (file.templates === null) {
    add("틀 은행이 있다", false, "templates null");
    return results;
  }
  const plan = planToeicGuideImport(file);
  const bankGuide = plan.find((it) => it.docId === TOEIC_TEMPLATE_BANK_ID)?.guide as Omit<ToeicTemplateBankDoc, "updatedAt"> | undefined;
  if (!bankGuide) {
    add("가져오기 계획에 틀 은행", false, "없음");
    return results;
  }
  const covered = file.templates.alignmentSkips.filter((s) => s.coveredBy !== null).length;
  add(
    "alternates = coveredBy 있는 건너뜀 수(유형별 개수)",
    bankGuide.alternates.length === covered,
    `합계 ${bankGuide.alternates.length} · ${TOEIC_GUIDE_PARTS.map((p) => `${p} ${bankGuide.alternates.filter((a) => a.part === p).length}`).join(" · ")}`,
  );
  const bank = { flows: bankGuide.flows, items: bankGuide.items, alternates: bankGuide.alternates };
  for (const g of file.guides) {
    const partTemplates = guideTemplatesForPart(bank.items, g.part).templates;
    const marks = guideReadMarks(g.sections, templateLinksForGuide(bank, g.part), templateAlternateLinks(bank, g.part), partTemplates);
    let bareFragments = 0;
    for (const key of marks.bareBlocks.keys()) {
      const [s, b] = key.split(":").map(Number);
      const blk = g.sections[s]?.blocks[b];
      if (blk && blk.kind === "lines") bareFragments += blk.lines.length;
    }
    const script = buildToeicGuideScript(g, "all", { skip: guideReadScriptSkip(marks) });
    add(
      `${g.part}: ① 외울 틀 줄·접는 줄·통째 접는 블록·머리말만 접는 블록(조각 줄)·framePicks · 읽기에 나온 틀 / 그 유형 틀 · skip 대본 불변식`,
      pieceInvariants(script),
      `${marks.frameLines.size} · ${marks.altLines.size} · ${marks.altBlocks.size} · ${marks.bareBlocks.size}(${bareFragments}) · ${marks.framePicks.size} · ${guideReadFrameKeys(marks).size}/${partTemplates.length} · 대본 ${script.length}조각`,
    );
    const flow = buildAnswerFlow(bank, TOEIC_GUIDE_PART_TO_MOCK_PART[g.part], partTemplates, { order: "flow" });
    const text = formatFlowLen(flow);
    add(
      `${g.part}: 답변 흐름 틀 수(단계/소재)·formatAnswerFlow 글자 수 — 흐름 있음·자리 { } 없음·상한 ${TOEIC_ANSWER_FLOW_FRAMES_MAX}`,
      flow !== null && text.ok,
      flow ? `${flow.steps.length}단계 ${flow.steps.reduce((n, st) => n + st.frames.length, 0)} / 소재 ${flow.banks.length} · ${text.len}자` : "흐름 없음",
    );
    const groups = templateFlowOrder({ flows: bank.flows, items: partTemplates }, g.part);
    const flat = groups.flatMap((x) => x.templates);
    const counts = TOEIC_TEMPLATE_CHOICE_MODES.map((m) => {
      const q = buildTemplateChoiceQuestions(flat, partTemplates, [], { modes: [m], max: 10_000, rng: makeRng(7), flow: bank.flows.find((f) => f.part === g.part) ?? null });
      return `${m.slice(4)} ${q.questions.length}(skip ${q.skipped})`;
    });
    add(`${g.part}: ③ 고르기 모드별 낼 수 있는 문항 수와 skipped`, true, counts.join(" · "));
  }
  return results;
}

function formatFlowLen(flow: ToeicAnswerFlow | null): { ok: boolean; len: number } {
  if (flow === null) return { ok: false, len: 0 };
  const frames = [...flow.steps.flatMap((st) => st.frames), ...flow.banks];
  // 실제 글자는 찍지 않는다 — 길이·자리 표시만
  const lines = flow.steps.map((st, i) => `${i + 1}. ${st.stepKo}: ${st.frames.map((f) => f.expression).join(" / ")}`);
  if (flow.banks.length > 0) lines.push(`소재 틀: ${flow.banks.map((f) => f.expression).join(" / ")}`);
  const text = lines.join("\n");
  return { ok: frames.length <= TOEIC_ANSWER_FLOW_FRAMES_MAX && !/[{}]/.test(text), len: text.length };
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export function runToeicTemplateCentricChecks(): GuideCheckResult[] {
  return [
    ...runAnswerFlowChecks(),
    ...runFlowCheckChecks(),
    ...runRecordChecks(),
    ...runImportAlternatesChecks(),
    ...runReadMarksChecks(),
    ...runReadScriptChecks(),
    ...runFileStoreRoundTrip(),
    ...runTemplateQuizChecks(),
    ...runTemplateQuizStatsChecks(),
    ...runTemplateCheckChecks(),
    ...runRouteSourceChecks(),
    ...runAppSourceChecks(),
    ...runBundleChecks(),
    ...runRealFileChecks(),
  ];
}

// 단독 실행은 하지 않는다 — eval-toeic.ts가 부른다(EVAL_OFFLINE_ONLY 네트워크 차단·db.json 검사가 그쪽에 있다)
void TOEIC_TEMPLATE_QUIZ_MODES;
void frameToExpression;

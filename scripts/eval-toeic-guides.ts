/**
 * scripts/eval-toeic-guides.ts — 토익스피킹 **유형별 공략**(docs/harness/toeic.md §12) 오프라인 검증 — scripts/eval-toeic.ts가 부른다.
 *
 * §12-10의 순수 층 항목: 가져오기 zod(공략 + 틀 은행) 반례·통과, 값 누출 없음, 다시 가져오기 판정, 정규화·렌더 판정, 공략 읽기 대본,
 * 틀 순수 함수, 따라 말하기 대본·예상 시간·이어 듣기, 전사 비교, 전사문 속 틀 찾기·단계 커버리지, 틀 테스트·숙련도, 연습 순수 함수,
 * 시험 출제 옵션, 세트 불변식 두 갈래, 번들 경계, 실제 가져오기 파일(있으면 — **개수만** 찍는다).
 *
 * 공개 저장소: 픽스처는 전부 **지어낸 영어·한국어**다(교재·틀 원본·강의 자막 문장을 옮기지 않는다). 실제 가져오기 파일
 * (data/private/, git 밖)은 zod 통과 여부와 개수만 보고 내용은 출력하지 않는다.
 * 실호출 0 — 이 모듈은 네트워크를 쓰지 않는다(eval-toeic.ts가 EVAL_OFFLINE_ONLY=1이면 fetch를 막는다).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  TOEIC_GUIDE_FORMAT,
  TOEIC_GUIDE_MAX_BYTES,
  TOEIC_GUIDE_SPEAK_MAX,
  TOEIC_IMPORT_FORMAT,
  TOEIC_SET_QUIZ_MAX,
  toeicGuideFileSchema,
  toeicGuideImportInvalidBody,
  toeicImportFileSchema,
  toeicTemplateSessionBodySchema,
  utf8ByteLength,
  type ToeicGuideFile,
  type ToeicGuideFileEntry,
  type ToeicPicturePart,
  type ToeicTemplate,
  type ToeicTemplateBankFile,
} from "../lib/ai/toeic/schemas";
import { decideGuideUpsert, planToeicGuideImport, toeicGuideContentHash, toeicTemplateBankContentHash } from "../lib/ai/toeic/guide-import";
import { toeicTemplateAlternatesFromSkips } from "../lib/ai/toeic/schemas";
import { pickExpressionsForDrill, pickExpressionsForMock } from "../lib/ai/toeic/mock";
import {
  TOEIC_GUIDE_PARTS,
  TOEIC_TEMPLATE_BANK_ID,
  buildToeicGuideScript,
  cleanGuideEnForTts,
  cleanGuideKoForTts,
  guideLineEn,
  shadowPauseMs,
  splitGuideEnForDisplay,
  toeicGuideLinePieces,
  toeicGuidePrefetchTexts,
  type ToeicGuideScriptPiece,
} from "../lib/toeic-guide";
import {
  TOEIC_DRILL_TEMPLATES_MAX,
  TOEIC_SHADOW_ESTIMATE,
  TOEIC_TEMPLATE_FLOW_CHECK_PARTS,
  TOEIC_TEMPLATE_REC_MAX_MS,
  TOEIC_TEMPLATE_REC_MIN_MS,
  TOEIC_TEMPLATE_SUGGEST_MIN,
  TOEIC_TEMPLATE_TEST_MAX,
  TOEIC_TEMPLATE_TEST_REVIEW_SLOTS,
  TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION,
  TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION,
  aggregateToeicTemplateStats,
  buildTemplateShadowScript,
  buildTemplateTestQuestions,
  canTranscribeAgain,
  compareTemplateAnswer,
  compareWithAlternatives,
  estimateShadowMs,
  expandContractions,
  fillFrame,
  findTemplatesInTranscript,
  flattenTemplateFlow,
  frameFixedWordRuns,
  frameToExpression,
  guideExpressionKeysInFlow,
  guideLineTemplateKeys,
  isSendableTemplateRecording,
  leadMatchesFrame,
  missingTemplateSteps,
  normalizeTemplateWords,
  pickTemplatesForDrill,
  sameTemplateWord,
  shadowResumeIndex,
  splitExampleByFills,
  splitFrameForDisplay,
  templateByExpression,
  templateFlowOrder,
  templateItemKey,
  templateLinksForGuide,
  templateStepCoverage,
  templatesCouldHaveUsed,
  toeicGuideAlignmentTargets,
  toeicTemplateBadges,
  toeicTemplateWrongKeys,
  toeicTemplateWrongKeysAnyMode,
} from "../lib/toeic-template";
import {
  TOEIC_DRILL_TOPIC_POOL,
  TOEIC_DRILL_UNITS,
  nextToeicDrillTitle,
  pickDrillTopic,
  toDrillRecordPart,
} from "../lib/toeic-drill";
import { TOEIC_PART_DIRECTIONS, TOEIC_MOCK_FORMAT, toeicPartDirections } from "../lib/toeic-mock";
import { decideAttemptScope } from "../lib/toeic-attempt-rules";
import { toeicDrillScopeLabelKo } from "../lib/toeic-attempt-contract";
import {
  TOEIC_GUIDE_CHOICE_SESSION_MAX,
  aggregateToeicStatsByMode,
  buildToeicChoiceQuestions,
  buildToeicSpeakSession,
  weaknessRank,
  type ToeicQuizSessionLike,
} from "../lib/toeic-quiz";
import { alignReadAloud, alignWordSeq, normalizeReadWords } from "../lib/toeic-score";
import { normalizeToeicQuizRecord, normalizeToeicSetRecord } from "../lib/toeic-normalize";
import {
  isRenderableToeicGuide,
  isRenderableToeicSet,
  isRenderableToeicTemplate,
  isRenderableToeicTemplateBank,
  isToeicGuidePartSet,
  isToeicGuideSet,
  isToeicTemplateBankSet,
} from "../lib/toeic-record";
import { TOEIC_TEMPLATE_SESSION_ID_RE, toeicTemplateSessionDocId } from "../lib/toeic-guide-contract";
import { toeicZodErrorKo } from "../lib/toeic-zod-ko";
import { countWords } from "../lib/toeic-text";
import { TTS_TEXT_MAX_CHARS } from "../lib/tts-shared";
import type { ToeicSetRecord } from "../lib/store";

// ---------------------------------------------------------------------------
// 결과·헬퍼 (eval-toeic.ts의 CheckResult와 같은 모양)
// ---------------------------------------------------------------------------

export interface GuideCheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
  skip?: boolean;
}

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Parsed = ReturnType<typeof toeicGuideFileSchema.safeParse>;

function parseGuide(raw: unknown): Parsed {
  return toeicGuideFileSchema.safeParse(raw, { error: toeicZodErrorKo });
}

function paths(r: Parsed): string[] {
  return r.success ? [] : r.error.issues.map((i) => i.path.map(String).join("."));
}

/** 거부되고, 거부 경로 중 하나가 prefix로 시작하는가 */
function rejectsAt(raw: unknown, prefix: string): { ok: boolean; detail: string } {
  const r = parseGuide(raw);
  if (r.success) return { ok: false, detail: "통과해 버림" };
  const ps = paths(r);
  const ok = ps.some((p) => p === prefix || p.startsWith(`${prefix}.`));
  return { ok, detail: ok ? "" : `경로: ${ps.slice(0, 4).join(" / ")}` };
}

function passes(raw: unknown): { ok: boolean; detail: string } {
  const r = parseGuide(raw);
  return { ok: r.success, detail: r.success ? "" : r.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ") };
}

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 문장(교재·틀 원본·강의 문장 아님). §12-2-2 예시 공략 + 유형마다 단계 3개·묶음마다 틀
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function line(over: Json = {}): Json {
  return { label: null, en: null, ko: null, note: null, emphasis: [], underline: [], alt: false, marked: false, example: null, ...over };
}

function guideQ34(): Json {
  return {
    presetKey: "vendor-guide-q3-4",
    part: "q3_4",
    introKo: null,
    sections: [
      {
        label: "공략 1",
        titleKo: "첫 문장은 장소",
        introKo: null,
        groupKo: "기본",
        blocks: [
          { kind: "heading", textKo: "장소를 여는 틀" },
          {
            kind: "lines",
            style: "list",
            captionKo: null,
            lead: line({ en: "The scene is set {장소}.", ko: "장면의 배경은 ~이다." }),
            lines: [
              line({ label: "예", en: "The scene is set on a crowded ferry deck.", ko: "장면의 배경은 붐비는 여객선 갑판이다.", emphasis: ["on a crowded ferry deck"], marked: true }),
              line({ en: "The scene is set on/in {장소}.", ko: "장면의 배경은 ~이다." }),
            ],
          },
          {
            kind: "lines",
            style: "completions",
            captionKo: "동작 이어 말하기",
            lead: line({ en: "Two cooks are", ko: "요리사 두 명이" }),
            lines: [
              line({ en: "slicing bread.", ko: "빵을 자르고 있다.", emphasis: ["slicing"] }),
              line({ en: "wiping the counter.", ko: "조리대를 닦고 있다.", marked: true }),
            ],
          },
          { kind: "text", label: "TIP", titleKo: null, bodyKo: "색이 여러 가지면 colorful 한 단어로 묶어 말해도 돼요.", lines: [] },
          {
            kind: "lines",
            style: "template",
            captionKo: "인물 묘사 틀",
            lead: null,
            lines: [
              line({ label: "인물", en: "A man is {동작} on the left.", ko: "왼쪽의 남자가 ~하고 있다." }),
              line({ label: "인물", en: "On the left, a woman is {동작}.", ko: "왼쪽에서 여자가 ~하고 있다.", note: "주어를 바꿔 말할 때", alt: true }),
            ],
          },
        ],
      },
    ],
    expressions: [
      { no: 1, expression: "The scene is set on ~", meaningKo: "장면의 배경은 ~이다", example: "The scene is set on a crowded ferry deck.", exampleKo: "장면의 배경은 붐비는 여객선 갑판이다." },
      { no: 2, expression: "The scene is set in ~", meaningKo: "장면의 배경은 ~이다", example: null, exampleKo: null },
    ],
    speak: [
      { no: 1, promptKo: "장면의 배경은 조용한 온실이다.", hint: null, modelAnswer: "The scene is set in a quiet greenhouse." },
      { no: 2, promptKo: "요리사 두 명이 빵을 자르고 있다.", hint: null, modelAnswer: "Two cooks are slicing bread." },
    ],
  };
}

function guideQ57(): Json {
  return {
    presetKey: "vendor-guide-q5-7",
    part: "q5_7",
    introKo: "짧게 답하고 이유를 한 문장 붙여요.",
    sections: [
      {
        label: null,
        titleKo: "습관 말하기",
        introKo: null,
        groupKo: null,
        blocks: [
          {
            kind: "lines",
            style: "completions",
            captionKo: null,
            lead: line({ en: "I usually buy snacks", ko: "나는 보통 과자를" }),
            lines: [line({ en: "at the corner store.", ko: "동네 가게에서 사요." }), line({ en: "on my way home.", ko: "집에 가는 길에 사요." })],
          },
          { kind: "text", label: null, titleKo: "공식", bodyKo: "What + do you ~?\n→ 대답 + 이유", lines: [] },
        ],
      },
    ],
    expressions: [
      { no: 1, expression: "~ helps me ~", meaningKo: "~은 ~하는 데 도움이 된다", example: "Walking helps me relax.", exampleKo: "걷기는 긴장을 푸는 데 도움이 된다." },
      { no: 2, expression: "In short", meaningKo: "요컨대", example: null, exampleKo: null },
    ],
    speak: [{ no: 1, promptKo: "나는 보통 동네 가게에서 과자를 사요.", hint: null, modelAnswer: "I usually buy snacks at the corner store." }],
  };
}

function guideQ11(): Json {
  return {
    presetKey: "vendor-guide-q11",
    part: "q11",
    introKo: null,
    sections: [
      {
        label: "STEP 1",
        titleKo: "답변 틀",
        introKo: null,
        groupKo: null,
        blocks: [
          {
            kind: "lines",
            style: "template",
            captionKo: "의견 답변 틀",
            lead: null,
            lines: [
              line({ label: "입장", en: "I support {의견}.", ko: "저는 ~을 지지해요." }),
              line({ label: "이유", en: "First, {이유}.", ko: "첫째, ~." }),
              line({ label: "정리", en: "For these reasons, I {결론}.", ko: "이런 이유로 ~." }),
            ],
          },
        ],
      },
    ],
    expressions: [
      { no: 1, expression: "I support ~", meaningKo: "~을 지지한다", example: null, exampleKo: null },
      { no: 2, expression: "I oppose ~", meaningKo: "~에 반대한다", example: null, exampleKo: null },
    ],
    speak: [],
  };
}

function tpl(key: string, groupKo: string, frameEn: string, frameKo: string, parts: string[], source: "guide" | "new", guideRefs: Json[], fills: string[][], testFills: string[][], koOf: (f: string[]) => string): Json {
  return {
    key,
    groupKo,
    frameEn,
    frameKo,
    useKo: "지어낸 틀 — 이럴 때 꺼내 써요",
    parts,
    source,
    guideRefs,
    examples: fills.map((f) => ({ en: fillFrame(frameEn, f), ko: koOf(f), fills: f })),
    testFills,
  };
}

function templateBank(): Json {
  const ko = (s: string) => () => s;
  return {
    presetKey: "vendor-guide-templates",
    flows: [
      {
        part: "q3_4",
        steps: [
          { stepKo: "장면 열기", groupsKo: ["장소 말하기"] },
          { stepKo: "눈에 띄는 것", groupsKo: ["인물 동작"] },
          { stepKo: "인상", groupsKo: ["느낌 말하기"] },
        ],
        banksKo: [],
      },
      {
        part: "q5_7",
        steps: [
          { stepKo: "습관", groupsKo: ["구매 습관"] },
          { stepKo: "이유", groupsKo: ["이유 붙이기"] },
          { stepKo: "마무리", groupsKo: ["정리하기"] },
        ],
        banksKo: ["가격 정보"],
      },
      {
        part: "q11",
        steps: [
          { stepKo: "입장", groupsKo: ["입장 밝히기"] },
          { stepKo: "이유", groupsKo: ["이유 붙이기"] },
          { stepKo: "정리", groupsKo: ["마무리"] },
        ],
        banksKo: ["여가 소재"],
      },
    ],
    items: [
      tpl("scene-set-on", "장소 말하기", "The scene is set on {장소}.", "장면의 배경은 {장소}이다.", ["q3_4"], "guide", [{ kind: "expression", part: "q3_4", expression: "The scene is set on ~" }],
        [["a rooftop garden"], ["a busy train platform"], ["a quiet riverside path"]], [["a snowy mountain trail"], ["a small fishing boat"]], ko("장면의 배경은 어느 장소이다.")),
      tpl("two-cooks-are", "인물 동작", "Two cooks are {동작}.", "요리사 두 명이 {동작} 있다.", ["q3_4"], "guide", [{ kind: "lead", part: "q3_4", leadEn: "Two cooks are" }],
        [["rolling out dough on a long table"], ["tasting a sauce from the same pot"], ["washing lettuce at the sink"]], [["plating desserts for a party"]], ko("요리사 두 명이 일하고 있다.")),
      tpl("person-on-left", "인물 동작", "A man is {동작} on the left.", "왼쪽의 남자가 {동작} 있다.", ["q3_4"], "guide", [{ kind: "template", part: "q3_4", step: "인물" }],
        [["reading a map"], ["carrying a ladder"], ["feeding pigeons"]], [["fixing a bicycle"]], ko("왼쪽의 남자가 무언가 하고 있다.")),
      tpl("looks-like", "느낌 말하기", "It looks like {장면} is going on.", "{장면}이 열리고 있는 것 같다.", ["q3_4"], "new", [],
        [["a sale"], ["a festival"], ["a meeting"]], [["a parade"]], ko("무언가 열리고 있는 것 같다.")),
      tpl("buy-usually", "구매 습관", "I usually buy {무엇} {언제}.", "나는 보통 {언제} {무엇}을 산다.", ["q5_7"], "guide", [{ kind: "lead", part: "q5_7", leadEn: "I usually buy snacks" }],
        [["snacks", "after work"], ["fruit", "on Sundays"], ["coffee", "before class"]], [["bread", "in the morning"], ["water", "at the gym"]], ko("나는 보통 무언가를 산다.")),
      tpl("helps-me", "이유 붙이기", "{활동} helps me {효과}.", "{활동}은 제가 {효과} 데 도움이 돼요.", ["q5_7", "q11"], "guide",
        [{ kind: "expression", part: "q5_7", expression: "~ helps me ~" }, { kind: "template", part: "q11", step: "이유" }],
        [["Gardening on weekends", "clear my head"], ["Online banking", "save time"], ["A short nap", "focus in the afternoon"]], [["Keeping a diary", "sleep better"], ["A standing desk", "stay alert at work"]],
        ko("그 활동은 제게 도움이 돼요.")),
      tpl("wrap-up", "정리하기", "That is why I {결론}.", "그래서 저는 {결론}.", ["q5_7"], "new", [],
        [["shop online"], ["walk to work"], ["cook at home"]], [["take the bus"]], ko("그래서 저는 그렇게 해요.")),
      tpl("costs-about", "가격 정보", "It costs about {가격} per person.", "한 사람당 약 {가격}이에요.", ["q5_7"], "new", [],
        [["$15"], ["20 dollars"], ["$8"]], [["$12"], ["30"]], ko("한 사람당 얼마예요.")),
      tpl("i-support", "입장 밝히기", "I support {의견} for two reasons.", "저는 두 가지 이유로 {의견}을 지지해요.", ["q11"], "guide",
        [{ kind: "expression", part: "q11", expression: "I support ~" }, { kind: "template", part: "q11", step: "입장" }],
        [["the new policy"], ["remote work"], ["longer breaks"]], [["free parking"]], ko("저는 그것을 지지해요.")),
      tpl("i-oppose", "입장 밝히기", "I oppose {의견} for two reasons.", "저는 두 가지 이유로 {의견}에 반대해요.", ["q11"], "guide", [{ kind: "expression", part: "q11", expression: "I oppose ~" }],
        [["the new rule"], ["later meetings"], ["higher fees"]], [["shorter lunches"]], ko("저는 그것에 반대해요.")),
      tpl("wrap-q11", "마무리", "For these reasons, I {결론}.", "이런 이유로 저는 {결론}.", ["q11"], "new", [{ kind: "template", part: "q11", step: "정리" }],
        [["prefer working from home"], ["agree with the idea"], ["support the plan"]], [["like this change"]], ko("이런 이유로 저는 그렇게 생각해요.")),
      tpl("free-time", "여가 소재", "In my free time, I enjoy {활동}.", "여가 시간에 저는 {활동}을 즐겨요.", ["q11"], "new", [],
        [["hiking"], ["baking bread"], ["playing chess"]], [["painting"]], ko("여가 시간에 저는 그것을 즐겨요.")),
    ],
    alignmentSkips: [{ part: "q3_4", kind: "expression", ref: "The scene is set in ~", reasonKo: "뜻이 같은 어휘 대안 — 대표 틀 하나로 연습한다", coveredBy: "scene-set-on" }],
  };
}

/** 기준 가져오기 픽스처(지어낸 것) — eval-toeic-template-centric.ts도 쓴다 */
export function fixtureFile(): Json {
  return { format: TOEIC_GUIDE_FORMAT, guides: [guideQ34(), guideQ57(), guideQ11()], templates: templateBank() };
}

/** 픽스처를 고쳐 쓰는 도우미 — 사본을 만들어 fn에 넘긴다 */
function variant(fn: (f: any) => void): Json {
  const f = clone(fixtureFile());
  fn(f);
  return f;
}

function itemOf(f: any, key: string): any {
  return f.templates.items.find((t: any) => t.key === key);
}

function parsedFixture(): ToeicGuideFile {
  const r = toeicGuideFileSchema.safeParse(fixtureFile());
  if (!r.success) throw new Error(`[eval-toeic-guides] 기준 픽스처가 zod를 통과하지 못함: ${r.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join(" / ")}`);
  return r.data;
}

// ---------------------------------------------------------------------------
// 1. 가져오기 zod — 공략 항목(§12-2-3)
// ---------------------------------------------------------------------------

function runGuideZodChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 가져오기 zod");
  const base = passes(fixtureFile());
  add("기준 픽스처(§12-2-2 예시 공략 + 유형 셋 + 틀 은행) 통과", base.ok, base.detail);

  // 형식·최상위
  for (const [fmt, label] of [[TOEIC_IMPORT_FORMAT, "표현집 형식"], ["toeic-guides/v1", "초안 v1"], ["toeic-guides/v3", "모르는 형식"]] as const) {
    const r = rejectsAt(variant((f) => (f.format = fmt)), "format");
    add(`format ${label} 거부(경로 format)`, r.ok, r.detail);
  }
  const v1 = parseGuide(variant((f) => (f.format = "toeic-guides/v1")));
  add("v1 파일 400 문구 = \"형식이 바뀌었어요 … 다시 만들어 주세요\"", !v1.success && toeicGuideImportInvalidBody(v1.error.issues).messageKo.includes("형식이 바뀌었어요"), "");
  {
    const r = rejectsAt(variant((f) => f.guides.push(guideQ34(), guideQ57())), "guides");
    add("guides 5개 거부", r.ok, r.detail);
  }
  {
    const r = rejectsAt({ format: TOEIC_GUIDE_FORMAT, guides: [], templates: null }, "guides");
    add("templates null + guides 0개 거부", r.ok, r.detail);
  }
  {
    const onlyNew = variant((f) => {
      f.guides = [];
      f.templates.items = f.templates.items.filter((t: any) => t.guideRefs.length === 0);
      f.templates.flows = f.templates.flows.filter((fl: any) => fl.part !== "q3_4" || true);
      f.templates.alignmentSkips = [];
      // 틀이 남은 유형·묶음만 흐름에 둔다
      const used = new Set<string>(f.templates.items.flatMap((t: any) => t.parts));
      f.templates.flows = f.templates.flows.filter((fl: any) => used.has(fl.part));
      for (const fl of f.templates.flows) {
        const groups = new Set(f.templates.items.filter((t: any) => t.parts.includes(fl.part)).map((t: any) => t.groupKo));
        fl.steps = fl.steps.map((st: any) => ({ ...st, groupsKo: st.groupsKo.filter((g: string) => groups.has(g)) }));
        fl.banksKo = fl.banksKo.filter((g: string) => groups.has(g));
      }
    });
    // 단계 3개가 유지되지 않으면(묶음이 빠진 단계) 통과할 수 없다 — 이 변형은 guideRefs 빈 틀만으로 흐름을 다시 짠다
    const f2 = clone(onlyNew) as any;
    for (const fl of f2.templates.flows) {
      const groups = [...new Set<string>(f2.templates.items.filter((t: any) => t.parts.includes(fl.part)).map((t: any) => t.groupKo))];
      fl.steps = [0, 1, 2].map((i) => ({ stepKo: `단계${i + 1}`, groupsKo: groups[i] !== undefined ? [groups[i]] : [] }));
      fl.banksKo = groups.slice(3);
    }
    // 묶음이 3개 미만인 유형은 틀을 더해 채운다(지어낸 새 틀)
    for (const fl of f2.templates.flows) {
      fl.steps.forEach((st: any, i: number) => {
        if (st.groupsKo.length > 0) return;
        const g = `보충 묶음 ${fl.part} ${i}`;
        st.groupsKo = [g];
        f2.templates.items.push(
          tpl(`extra-${fl.part.replace("_", "-")}-${i}`, g, `Extra frame ${fl.part.replace("_", " ")} number ${i} goes with {x} here.`, `보충 틀 {x}.`, [fl.part], "new", [],
            [["apples"], ["books"], ["chairs"]], [["doors"]], () => "보충 예문이에요."),
        );
      });
    }
    const r = passes(f2);
    add("templates가 있으면 guides 0개 통과(guideRefs가 빈 틀만)", r.ok, r.detail);
  }
  {
    const r = rejectsAt(variant((f) => (f.guides[0].part = "q1_2")), "guides.0.part");
    add("part q1_2 거부", r.ok, r.detail);
  }
  {
    const r = rejectsAt(variant((f) => (f.guides[1].part = "q3_4")), "guides.1.part");
    add("파일 안 part 중복 거부", r.ok, r.detail);
  }
  {
    const a = rejectsAt(variant((f) => (f.guides[0].presetKey = "Bad Key")), "guides.0.presetKey");
    const b = rejectsAt(variant((f) => (f.guides[1].presetKey = f.guides[0].presetKey)), "guides.1.presetKey");
    const c = rejectsAt(variant((f) => (f.templates.presetKey = f.guides[0].presetKey)), "templates.presetKey");
    add("presetKey 형식·파일 안 중복·틀 은행 키 = 공략 키 거부", a.ok && b.ok && c.ok, [a.detail, b.detail, c.detail].filter(Boolean).join(" / "));
  }

  // 칸 내용
  const sec = "guides.0.sections.0";
  const cases: [string, (f: any) => void, string][] = [
    ["한국어 칸(titleKo)에 한글 없음", (f) => (f.guides[0].sections[0].titleKo = "Scene first"), `${sec}.titleKo`],
    ["영어 줄에 라틴 없음", (f) => (f.guides[0].sections[0].blocks[1].lines[0].en = "123 456"), `${sec}.blocks.1.lines.0.en`],
    ["슬롯 밖 한글", (f) => (f.guides[0].sections[0].blocks[1].lines[1].en = "The scene is set 장소."), `${sec}.blocks.1.lines.1.en`],
    ["슬롯 짝 안 맞음", (f) => (f.guides[0].sections[0].blocks[1].lines[1].en = "The scene is set {장소."), `${sec}.blocks.1.lines.1.en`],
    ["중첩 슬롯", (f) => (f.guides[0].sections[0].blocks[1].lines[1].en = "The scene is {set {장소}}."), `${sec}.blocks.1.lines.1.en`],
    ["빈 슬롯", (f) => (f.guides[0].sections[0].blocks[1].lines[1].en = "The scene is set { }."), `${sec}.blocks.1.lines.1.en`],
    ["영어 줄에 대괄호", (f) => (f.guides[0].sections[0].blocks[1].lines[1].en = "I support[oppose] it."), `${sec}.blocks.1.lines.1.en`],
    ["groupKo 31자", (f) => (f.guides[0].sections[0].groupKo = "가".repeat(31)), `${sec}.groupKo`],
    ["emphasis가 en 밖", (f) => (f.guides[0].sections[0].blocks[1].lines[0].emphasis = ["on a quiet deck"]), `${sec}.blocks.1.lines.0.emphasis`],
    ["emphasis 대소문자만 다름", (f) => (f.guides[0].sections[0].blocks[1].lines[0].emphasis = ["On a crowded ferry deck"]), `${sec}.blocks.1.lines.0.emphasis`],
    ["underline이 en 밖", (f) => (f.guides[0].sections[0].blocks[1].lines[0].underline = ["river"]), `${sec}.blocks.1.lines.0.underline`],
    ["en null인데 emphasis", (f) => (f.guides[0].sections[0].blocks[1].lines[0] = line({ ko: "한국어만", emphasis: ["x"] })), `${sec}.blocks.1.lines.0.emphasis`],
    ["en null인데 underline", (f) => (f.guides[0].sections[0].blocks[1].lines[0] = line({ ko: "한국어만", underline: ["x"] })), `${sec}.blocks.1.lines.0.underline`],
    ["alt가 list 블록에", (f) => (f.guides[0].sections[0].blocks[1].lines[1].alt = true), `${sec}.blocks.1.lines.1.alt`],
    ["alt가 template 첫 줄에", (f) => (f.guides[0].sections[0].blocks[4].lines[0].alt = true), `${sec}.blocks.4.lines.0.alt`],
    ["en·ko 둘 다 null", (f) => (f.guides[0].sections[0].blocks[1].lines[0] = line()), `${sec}.blocks.1.lines.0`],
    ["빈 text 블록", (f) => (f.guides[0].sections[0].blocks[3] = { kind: "text", label: null, titleKo: null, bodyKo: null, lines: [] }), `${sec}.blocks.3`],
    ["completions lead null", (f) => (f.guides[0].sections[0].blocks[2].lead = null), `${sec}.blocks.2.lead`],
    ["completions lead.en에 ~", (f) => (f.guides[0].sections[0].blocks[2].lead.en = "Two cooks ~ are"), `${sec}.blocks.2.lead.en`],
    ["completions lead.en에 슬롯", (f) => (f.guides[0].sections[0].blocks[2].lead.en = "Two {사람} are"), `${sec}.blocks.2.lead.en`],
    ["completions 줄 en null", (f) => (f.guides[0].sections[0].blocks[2].lines[0] = line({ ko: "빵을 자르고 있다." })), `${sec}.blocks.2.lines.0.en`],
    ["completions 줄에 example", (f) => (f.guides[0].sections[0].blocks[2].lines[0].example = { en: "They slice bread.", ko: null, emphasis: [] }), `${sec}.blocks.2.lines.0.example`],
    ["completions 줄에 alt", (f) => (f.guides[0].sections[0].blocks[2].lines[1].alt = true), `${sec}.blocks.2.lines.1.alt`],
    ["completions 합성 문장 301자", (f) => (f.guides[0].sections[0].blocks[2].lines[0].en = "a".repeat(TTS_TEXT_MAX_CHARS - "Two cooks are".length)), `${sec}.blocks.2.lines.0.en`],
    ["섹션 31개", (f) => (f.guides[0].sections = Array.from({ length: 31 }, () => clone(f.guides[0].sections[0]))), "guides.0.sections"],
    ["블록 61개", (f) => (f.guides[0].sections[0].blocks = Array.from({ length: 61 }, () => ({ kind: "heading", textKo: "제목" }))), `${sec}.blocks`],
    ["줄 41개", (f) => (f.guides[0].sections[0].blocks[1].lines = Array.from({ length: 41 }, () => line({ en: "A line.", ko: "줄." }))), `${sec}.blocks.1.lines`],
    ["표현 81자", (f) => (f.guides[0].expressions[1].expression = `The scene ${"x".repeat(75)} ~`), "guides.0.expressions.1.expression"],
    ["표현 중복(대소문자·공백 차이)", (f) => (f.guides[0].expressions[1].expression = "the  scene is set ON ~"), "guides.0.expressions.1.expression"],
    ["partial 없이도 뜻 빈 값 거부", (f) => (f.guides[0].expressions[1].meaningKo = ""), "guides.0.expressions.1.meaningKo"],
    ["공략 표현에 영어 슬롯 {x}", (f) => (f.guides[0].expressions[1].expression = "The scene is set in {place}"), "guides.0.expressions.1.expression"],
    ["공략 표현에 a/b", (f) => (f.guides[0].expressions[1].expression = "The scene is set in/at ~"), "guides.0.expressions.1.expression"],
    ["공략 표현에 [x]", (f) => (f.guides[0].expressions[1].expression = "The scene is set [in] ~"), "guides.0.expressions.1.expression"],
    ["공략 예문에 a/b", (f) => (f.guides[0].expressions[0].example = "The scene is set on a crowded/busy deck."), "guides.0.expressions.0.example"],
    ["표현에 한글 자리 {장소} → 경로가 그 항목의 expression", (f) => (f.guides[0].expressions[1].expression = "The scene is set in {장소}"), "guides.0.expressions.1.expression"],
    ["speak.no null", (f) => (f.guides[0].speak[0].no = null), "guides.0.speak.0.no"],
    ["speak.no 중복", (f) => (f.guides[0].speak[1].no = 1), "guides.0.speak.1.no"],
    ["modelAnswer에 한글", (f) => (f.guides[0].speak[0].modelAnswer = "The scene is 온실."), "guides.0.speak.0.modelAnswer"],
    ["modelAnswer에 ~", (f) => (f.guides[0].speak[0].modelAnswer = "The scene is set in ~."), "guides.0.speak.0.modelAnswer"],
    ["modelAnswer에 /", (f) => (f.guides[0].speak[0].modelAnswer = "The scene is set in/at a greenhouse."), "guides.0.speak.0.modelAnswer"],
    ["promptKo 301자", (f) => (f.guides[0].speak[0].promptKo = "가".repeat(301)), "guides.0.speak.0.promptKo"],
    [`speak ${TOEIC_GUIDE_SPEAK_MAX + 1}개`, (f) => (f.guides[0].speak = Array.from({ length: TOEIC_GUIDE_SPEAK_MAX + 1 }, (_x, i) => ({ no: i + 1, promptKo: "문장이에요.", hint: null, modelAnswer: "A sentence." }))), "guides.0.speak"],
  ];
  for (const [label, fn, prefix] of cases) {
    const r = rejectsAt(variant(fn), prefix);
    add(`${label} 거부`, r.ok, r.detail);
  }

  // 크기(바이트) — 한글로 채운다: 글자 수는 30만 남짓이라 글자 기준이면 통과해 버리는 입력
  {
    const f = variant((x) => {
      x.guides[0].sections = Array.from({ length: 30 }, (_s, s) => ({
        label: null,
        titleKo: "큰 섹션",
        introKo: null,
        groupKo: null,
        blocks: Array.from({ length: 10 }, () => ({ kind: "text", label: null, titleKo: null, bodyKo: "가".repeat(1100), lines: [] })),
      }));
    });
    const chars = JSON.stringify((f as any).guides[0]).length;
    const r = rejectsAt(f, "guides.0");
    const bytesOver = utf8ByteLength(JSON.stringify((f as any).guides[0])) > TOEIC_GUIDE_MAX_BYTES;
    add("유형 항목 900,000바이트 초과 거부(글자 수로는 상한 안 — 한글 3바이트)", r.ok && bytesOver && chars < TOEIC_GUIDE_MAX_BYTES, `글자 ${chars}`);
  }

  // 통과 쪽
  {
    const r = passes(
      variant((f) => {
        f.guides[0].sections[0].blocks[3].bodyKo = "색이 여러 가지면 colorful 한 단어로 묶어 말해도 돼요. Also OK.";
        f.guides[0].sections[0].blocks[1].lines.push(line({ en: "two thousand (and) five", ko: "이천오 년" }));
        f.guides[0].sections[0].blocks[1].lines[0].underline = ["crowded ferry"];
        f.guides[0].speak = Array.from({ length: TOEIC_GUIDE_SPEAK_MAX }, (_x, i) => ({ no: i + 1, promptKo: `문장 ${i + 1}이에요.`, hint: null, modelAnswer: `Sentence number ${i + 1}.` }));
        f.guides[0].unknownKey = "버려진다";
        f.templates.memo = "버려진다";
      }),
    );
    add("통과: 한국어 칸 속 영어·슬래시 대안·띄어 쓴 괄호·형광+밑줄 겹침·speak 60개·모르는 키", r.ok, r.detail);
  }
  {
    const r = parseGuide(variant((f) => (f.guides[0].unknownKey = "x")));
    add("모르는 키는 버려진다(파싱 결과에 없다)", r.success && !("unknownKey" in (r.data.guides[0] as unknown as Record<string, unknown>)), "");
  }
  {
    // 표현집 가져오기는 표현에 /가 있어도 지금처럼 통과(공략 쪽 규칙이 새지 않았다)
    const bookFile = {
      format: TOEIC_IMPORT_FORMAT,
      sets: [
        {
          presetKey: "book-slash-1",
          titleKo: "DAY 1 지어낸 세트",
          dayNo: 1,
          topicKo: "지어낸 주제",
          entries: [{ no: 1, expression: "be placed on/in", meaningKo: "~에 놓여 있다", example: null, exampleKo: null, partial: false, confidence: "high", points: null }],
          quiz: [],
        },
      ],
    };
    const r = toeicImportFileSchema.safeParse(bookFile);
    add("checkEntryText 불변 — 표현집 가져오기는 표현의 /를 지금처럼 통과", r.success, r.success ? "" : r.error.issues[0]?.message ?? "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. 틀 은행 zod (§12-2-7)
// ---------------------------------------------------------------------------

function runTemplateBankZodChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 은행 zod");
  const P = (key: string) => {
    const idx = (templateBank() as any).items.findIndex((t: any) => t.key === key);
    return `templates.items.${idx}`;
  };
  const cases: [string, (f: any) => void, string][] = [
    // 예문 ≠ 틀 + 채움
    ["예문 한 글자 다름", (f) => (itemOf(f, "scene-set-on").examples[0].en = "The scene is set on a rooftop gardens."), `${P("scene-set-on")}.examples.0.en`],
    ["예문 대소문자만 다름(첫 자리 채움 소문자)", (f) => (itemOf(f, "helps-me").examples[1].en = "online banking helps me save time."), `${P("helps-me")}.examples.1.en`],
    ["예문 끝 마침표 빠짐", (f) => (itemOf(f, "scene-set-on").examples[0].en = "The scene is set on a rooftop garden"), `${P("scene-set-on")}.examples.0.en`],
    ["예문 공백 두 칸", (f) => (itemOf(f, "scene-set-on").examples[0].en = "The scene is set on  a rooftop garden."), `${P("scene-set-on")}.examples.0.en`],
    ["채움 수 모자람", (f) => (itemOf(f, "helps-me").examples[0].fills = ["Gardening on weekends"]), `${P("helps-me")}.examples.0.fills`],
    ["채움 수 남음", (f) => (itemOf(f, "scene-set-on").examples[0].fills = ["a rooftop garden", "extra"]), `${P("scene-set-on")}.examples.0.fills`],
    // 틀 줄
    ["자리 0개", (f) => (itemOf(f, "wrap-up").frameEn = "That is why I do it."), `${P("wrap-up")}.frameEn`],
    ["자리 5개", (f) => (itemOf(f, "wrap-up").frameEn = "{a} {b} {c} {d} {e} is why."), `${P("wrap-up")}.frameEn`],
    ["자리 이름 중복", (f) => (itemOf(f, "helps-me").frameEn = "{활동} helps me {활동}."), `${P("helps-me")}.frameEn`],
    ["자리 밖 한글", (f) => (itemOf(f, "wrap-up").frameEn = "That is why 저는 {결론}."), `${P("wrap-up")}.frameEn`],
    ["자리 밖 ~", (f) => (itemOf(f, "wrap-up").frameEn = "That is why I {결론} ~."), `${P("wrap-up")}.frameEn`],
    ["자리 밖 /", (f) => (itemOf(f, "wrap-up").frameEn = "That is/was why I {결론}."), `${P("wrap-up")}.frameEn`],
    ["자리 밖 [", (f) => (itemOf(f, "wrap-up").frameEn = "That is why I [really] {결론}."), `${P("wrap-up")}.frameEn`],
    ["낱말에 붙은 자리 {동작}ing", (f) => (itemOf(f, "two-cooks-are").frameEn = "Two cooks are {동작}ing."), `${P("two-cooks-are")}.frameEn`],
    ["낱말에 붙은 자리 {사람}'s", (f) => (itemOf(f, "wrap-up").frameEn = "That is {사람}'s choice {결론}."), `${P("wrap-up")}.frameEn`],
    ["고정 낱말 0개({가} {나}.)", (f) => (itemOf(f, "helps-me").frameEn = "{활동} {효과}."), `${P("helps-me")}.frameEn`],
    ["frameEn 121자", (f) => (itemOf(f, "wrap-up").frameEn = `That is why I {결론} ${"w".repeat(110)}.`), `${P("wrap-up")}.frameEn`],
    // 한국어 틀
    ["한국어 틀 자리 하나 빠짐", (f) => (itemOf(f, "helps-me").frameKo = "{활동}은 제게 도움이 돼요."), `${P("helps-me")}.frameKo`],
    ["한국어 틀 자리 이름 다름", (f) => (itemOf(f, "helps-me").frameKo = "{취미}은 제가 {효과} 데 도움이 돼요."), `${P("helps-me")}.frameKo`],
    ["한국어 틀 ~ 사용", (f) => (itemOf(f, "helps-me").frameKo = "{활동}은 제가 {효과} ~ 도움이 돼요."), `${P("helps-me")}.frameKo`],
    ["한국어 틀 한글 없음", (f) => (itemOf(f, "wrap-up").frameKo = "So {결론}."), `${P("wrap-up")}.frameKo`],
    // 채움
    ["채움에 한글", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = ["집에서 cook"]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("wrap-up")}.examples.0.fills.0`],
    ["채움에 {", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = ["cook {x"]; t.examples[0].en = "That is why I cook {x."; }, `${P("wrap-up")}.examples.0.fills.0`],
    ["채움에 ~", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = ["cook ~"]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("wrap-up")}.examples.0.fills.0`],
    ["채움에 /", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = ["cook/bake"]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("wrap-up")}.examples.0.fills.0`],
    ["채움 앞뒤 공백", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = [" cook at home"]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("wrap-up")}.examples.0.fills.0`],
    ["채움 81자", (f) => { const t = itemOf(f, "wrap-up"); t.examples[0].fills = ["c".repeat(81)]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("wrap-up")}.examples.0.fills.0`],
    ["라틴도 숫자도 없는 채움(기호만 $·-)", (f) => { const t = itemOf(f, "costs-about"); t.examples[0].fills = ["$-"]; t.examples[0].en = fillFrame(t.frameEn, t.examples[0].fills); }, `${P("costs-about")}.examples.0.fills.0`],
    ["예문 2개", (f) => (itemOf(f, "wrap-up").examples = itemOf(f, "wrap-up").examples.slice(0, 2)), `${P("wrap-up")}.examples`],
    ["예문 6개", (f) => { const t = itemOf(f, "wrap-up"); for (const w of ["run", "read", "rest"]) t.examples.push({ en: fillFrame(t.frameEn, [w]), ko: "지어낸 예문.", fills: [w] }); }, `${P("wrap-up")}.examples`],
    ["예문 en 중복(대소문자만 다름 — 채움도 대소문자만)", (f) => { const t = itemOf(f, "wrap-up"); t.examples[1].fills = ["Shop online"]; t.examples[1].en = fillFrame(t.frameEn, t.examples[1].fills); }, `${P("wrap-up")}.examples.1`],
    ["예문 ko에 ~", (f) => (itemOf(f, "wrap-up").examples[0].ko = "그래서 저는 ~해요."), `${P("wrap-up")}.examples.0.ko`],
    // 테스트 전용 채움
    ["testFills 0묶음", (f) => (itemOf(f, "wrap-up").testFills = []), `${P("wrap-up")}.testFills`],
    ["testFills 4묶음", (f) => (itemOf(f, "wrap-up").testFills = [["a"], ["b"], ["c"], ["d"]]), `${P("wrap-up")}.testFills`],
    ["testFills 묶음 길이 ≠ 자리 수", (f) => (itemOf(f, "helps-me").testFills = [["Keeping a diary"]]), `${P("helps-me")}.testFills.0`],
    ["testFills에 한글", (f) => (itemOf(f, "wrap-up").testFills = [["버스 타기"]]), `${P("wrap-up")}.testFills.0.0`],
    ["testFills에 /", (f) => (itemOf(f, "wrap-up").testFills = [["take/catch the bus"]]), `${P("wrap-up")}.testFills.0.0`],
    ["testFills = 예문 채움(대소문자만 다름)", (f) => (itemOf(f, "wrap-up").testFills = [["SHOP ONLINE"]]), `${P("wrap-up")}.testFills.0`],
    ["testFills 두 묶음이 같음", (f) => (itemOf(f, "wrap-up").testFills = [["take the bus"], ["Take the bus"]]), `${P("wrap-up")}.testFills.1`],
    // 키·유형
    ["key 대문자", (f) => (itemOf(f, "wrap-up").key = "Wrap-up"), `${P("wrap-up")}.key`],
    ["key 밑줄", (f) => (itemOf(f, "wrap-up").key = "wrap_up"), `${P("wrap-up")}.key`],
    ["key 41자", (f) => (itemOf(f, "wrap-up").key = "w".repeat(41)), `${P("wrap-up")}.key`],
    ["key 중복", (f) => (itemOf(f, "wrap-up").key = "costs-about"), "templates.items"],
    ["parts 빈 배열", (f) => (itemOf(f, "wrap-up").parts = []), `${P("wrap-up")}.parts`],
    ["parts q1_2", (f) => (itemOf(f, "wrap-up").parts = ["q1_2"]), `${P("wrap-up")}.parts`],
    ["parts 중복", (f) => (itemOf(f, "wrap-up").parts = ["q5_7", "q5_7"]), `${P("wrap-up")}.parts`],
    ["items 301개", (f) => { const base = itemOf(f, "wrap-up"); for (let i = 0; i < 300; i++) f.templates.items.push({ ...clone(base), key: `pad-${i}` }); }, "templates.items"],
    // 출처
    ["source guide인데 guideRefs 빈 배열", (f) => (itemOf(f, "scene-set-on").guideRefs = []), `${P("scene-set-on")}.guideRefs`],
    ["source new인데 kind expression", (f) => (itemOf(f, "wrap-up").guideRefs = [{ kind: "expression", part: "q5_7", expression: "~ helps me ~" }]), `${P("wrap-up")}.guideRefs.0.kind`],
    ["source new인데 kind lead", (f) => (itemOf(f, "wrap-up").guideRefs = [{ kind: "lead", part: "q5_7", leadEn: "I usually buy snacks" }]), `${P("wrap-up")}.guideRefs.0.kind`],
    ["guideRefs 5개", (f) => (itemOf(f, "helps-me").guideRefs = Array.from({ length: 5 }, (_x, i) => ({ kind: "template", part: "q11", step: `없는 단계 ${i}` }))), `${P("helps-me")}.guideRefs`],
    ["같은 연결 두 번", (f) => itemOf(f, "i-support").guideRefs.push({ kind: "expression", part: "q11", expression: "i  SUPPORT ~" }), `${P("i-support")}.guideRefs.2`],
    ["연결의 part ∉ parts", (f) => (itemOf(f, "i-oppose").guideRefs = [{ kind: "expression", part: "q5_7", expression: "~ helps me ~" }]), `${P("i-oppose")}.guideRefs.0.part`],
    ["가리키는 표현이 파일에 없음(글자 다름)", (f) => (itemOf(f, "i-oppose").guideRefs = [{ kind: "expression", part: "q11", expression: "I object to ~" }]), `${P("i-oppose")}.guideRefs.0.expression`],
    ["가리키는 표현이 다른 유형에 있음", (f) => { const t = itemOf(f, "i-oppose"); t.parts = ["q11", "q5_7"]; t.guideRefs = [{ kind: "expression", part: "q5_7", expression: "I oppose ~" }]; }, `${P("i-oppose")}.guideRefs.0.expression`],
    ["그 유형 항목이 파일에 없음", (f) => (f.guides = f.guides.filter((g: any) => g.part !== "q11")), "templates.items"],
    ["없는 템플릿 단계 label", (f) => (itemOf(f, "wrap-q11").guideRefs = [{ kind: "template", part: "q11", step: "결론" }]), `${P("wrap-q11")}.guideRefs.0.step`],
    ["없는 머리말", (f) => (itemOf(f, "two-cooks-are").guideRefs = [{ kind: "lead", part: "q3_4", leadEn: "Three cooks are" }]), `${P("two-cooks-are")}.guideRefs.0.leadEn`],
    // 교재 고정 부분
    ["교재 고정 부분 한 낱말 바꿈(I find ~ relaxing ↔ I find {활동} calming.)", (f) => {
      f.guides[2].expressions.push({ no: 3, expression: "I find ~ relaxing", meaningKo: "~이 편안하다고 느낀다", example: null, exampleKo: null });
      f.templates.items.push(tpl("find-calming", "마무리", "I find {활동} calming.", "저는 {활동}이 편안해요.", ["q11"], "guide", [{ kind: "expression", part: "q11", expression: "I find ~ relaxing" }],
        [["yoga"], ["long walks"], ["quiet music"]], [["gardening"]], () => "저는 그것이 편안해요."));
    }, "templates.items.12.guideRefs.0"],
    ["동사 연어 불규칙 활용 거부(pay rent ↔ She paid rent {때}.)", (f) => {
      f.guides[1].expressions.push({ no: 3, expression: "pay rent", meaningKo: "집세를 내다", example: null, exampleKo: null });
      f.templates.items.push(tpl("paid-rent", "구매 습관", "She paid rent {때}.", "그녀는 {때} 집세를 냈다.", ["q5_7"], "guide", [{ kind: "expression", part: "q5_7", expression: "pay rent" }],
        [["last month"], ["on time"], ["early"]], [["yesterday"]], () => "그녀는 집세를 냈다."));
    }, "templates.items.12.guideRefs.0"],
    // 머리말 연결
    ["머리 사례 — 맞춘 고정 낱말 1개뿐(I bake cookies ↔ I {동작} {때}.)", (f) => {
      f.guides[1].sections[0].blocks.push({ kind: "lines", style: "completions", captionKo: null, lead: line({ en: "I bake cookies", ko: "나는 과자를 굽는다" }), lines: [line({ en: "on weekends.", ko: "주말에." })] });
      itemOf(f, "buy-usually").guideRefs.push({ kind: "lead", part: "q5_7", leadEn: "I bake cookies" });
      itemOf(f, "buy-usually").frameEn = "I {동작} {때}.";
      itemOf(f, "buy-usually").frameKo = "나는 {때} {동작}.";
      const t = itemOf(f, "buy-usually");
      t.examples = t.examples.map((e: any) => ({ ...e, en: fillFrame(t.frameEn, e.fills) }));
    }, "templates.items.4.guideRefs"],
    ["머리말 낱말 하나 바뀜(Two cooks is ↔ Two cooks are {동작}.)", (f) => {
      f.guides[0].sections[0].blocks[2].lead.en = "Two cooks is";
      itemOf(f, "two-cooks-are").guideRefs = [{ kind: "lead", part: "q3_4", leadEn: "Two cooks is" }];
    }, "templates.items.1.guideRefs.0"],
    ["머리말이 틀 가운데에만 걸침(cooks are busy ↔ Two cooks are {동작}.)", (f) => {
      f.guides[0].sections[0].blocks[2].lead.en = "cooks are busy";
      itemOf(f, "two-cooks-are").guideRefs = [{ kind: "lead", part: "q3_4", leadEn: "cooks are busy" }];
    }, "templates.items.1.guideRefs.0"],
    // ~ 형태 충돌
    ["~ 형태 충돌(자리 이름만 다름)", (f) => { const t = clone(itemOf(f, "wrap-up")); t.key = "wrap-up-2"; t.frameEn = "That is why I {다른 결론}."; t.frameKo = "그래서 저는 {다른 결론}."; f.templates.items.push(t); }, "templates.items.12.frameEn"],
    // flows
    ["flows 유형 중복", (f) => f.templates.flows.push(clone(f.templates.flows[0])), "templates.flows.3.part"],
    ["쓰이는 유형의 흐름이 없음", (f) => (f.templates.flows = f.templates.flows.filter((x: any) => x.part !== "q11")), "templates.flows"],
    ["틀이 없는 유형의 흐름", (f) => f.templates.flows.push({ part: "q8_10", steps: [{ stepKo: "가", groupsKo: ["나"] }, { stepKo: "다", groupsKo: ["라"] }, { stepKo: "마", groupsKo: ["바"] }], banksKo: [] }), "templates.flows.3.part"],
    ["단계 2개", (f) => (f.templates.flows[0].steps = f.templates.flows[0].steps.slice(0, 2)), "templates.flows.0.steps"],
    ["단계 7개", (f) => { for (let i = 0; i < 4; i++) f.templates.flows[0].steps.push({ stepKo: `추가 단계 ${i}`, groupsKo: [`빈 묶음 ${i}`] }); }, "templates.flows.0.steps"],
    ["stepKo 중복", (f) => (f.templates.flows[0].steps[1].stepKo = "장면 열기"), "templates.flows.0.steps.1.stepKo"],
    ["stepKo 한글 없음", (f) => (f.templates.flows[0].steps[1].stepKo = "Step two"), "templates.flows.0.steps.1.stepKo"],
    ["단계 안 묶음 0개", (f) => (f.templates.flows[0].steps[2].groupsKo = []), "templates.flows.0.steps.2.groupsKo"],
    ["단계 안 묶음 9개", (f) => (f.templates.flows[0].steps[2].groupsKo = ["느낌 말하기", ...Array.from({ length: 8 }, (_x, i) => `빈 묶음 ${i}`)]), "templates.flows.0.steps.2.groupsKo"],
    ["소재 묶음 17개", (f) => (f.templates.flows[1].banksKo = ["가격 정보", ...Array.from({ length: 16 }, (_x, i) => `빈 소재 ${i}`)]), "templates.flows.1.banksKo"],
    ["묶음이 두 번(단계와 소재에)", (f) => f.templates.flows[1].banksKo.push("구매 습관"), "templates.flows.1.banksKo.1"],
    ["틀의 groupKo가 흐름에 없음", (f) => (itemOf(f, "wrap-up").groupKo = "흐름 밖 묶음"), `${P("wrap-up")}.groupKo`],
    ["흐름의 묶음에 그 유형 틀이 없음", (f) => f.templates.flows[1].banksKo.push("빈 소재"), "templates.flows.1.banksKo.1"],
    ["한 유형 묶음의 틀 7개(유형별 6 + 공통 틀 1)", (f) => {
      for (let i = 0; i < 6; i++) {
        f.templates.items.push(tpl(`reason-${i}`, "이유 붙이기", `Reason number ${i} is that {이유}.`, `이유 ${i}는 {이유}예요.`, ["q11"], "new", [],
          [["it is cheap"], ["it is fast"], ["it is fun"]], [["it is safe"]], () => "이유가 있어요."));
      }
    }, "templates.flows.2.steps.1.groupsKo.0"],
    // alignmentSkips
    ["건너뜀 대상이 파일에 없음", (f) => f.templates.alignmentSkips.push({ part: "q11", kind: "expression", ref: "I object to ~", reasonKo: "뜻 고르기 전용이에요", coveredBy: null }), "templates.alignmentSkips.1.ref"],
    ["어떤 틀이 연결한 대상을 건너뜀", (f) => f.templates.alignmentSkips.push({ part: "q11", kind: "expression", ref: "I support ~", reasonKo: "뜻 고르기 전용이에요", coveredBy: null }), "templates.alignmentSkips.1"],
    ["같은 건너뜀 두 번", (f) => f.templates.alignmentSkips.push(clone(f.templates.alignmentSkips[0])), "templates.alignmentSkips.1"],
    ["reasonKo 한글 없음", (f) => (f.templates.alignmentSkips[0].reasonKo = "same meaning"), "templates.alignmentSkips.0.reasonKo"],
    ["reasonKo 81자", (f) => (f.templates.alignmentSkips[0].reasonKo = "가".repeat(81)), "templates.alignmentSkips.0.reasonKo"],
    ["coveredBy 없는 key", (f) => (f.templates.alignmentSkips[0].coveredBy = "no-such-key"), "templates.alignmentSkips.0.coveredBy"],
    ["coveredBy가 그 유형을 parts에 갖지 않은 틀", (f) => (f.templates.alignmentSkips[0].coveredBy = "wrap-up"), "templates.alignmentSkips.0.coveredBy"],
    // 정렬 빠짐
    ["정렬 빠짐 — 자리 표현", (f) => (f.templates.alignmentSkips = []), "templates.alignment.q3_4.expression.1"],
    ["정렬 빠짐 — 답변 틀 단계 label", (f) => (itemOf(f, "wrap-q11").guideRefs = []), "templates.alignment.q11.template.2"],
    ["정렬 빠짐 — 머리말", (f) => { itemOf(f, "two-cooks-are").guideRefs = []; itemOf(f, "two-cooks-are").source = "new"; }, "templates.alignment.q3_4.lead.0"],
  ];
  for (const [label, fn, prefix] of cases) {
    const r = rejectsAt(variant(fn), prefix);
    add(`${label} 거부`, r.ok, r.detail);
  }
  // testFills 채운 문장 301자 — 채움 80자 상한 안에서 300자를 넘기려면 틀을 길게(120자 상한 안) + 자리 여럿
  {
    const f = variant((x) => {
      const t = itemOf(x, "helps-me");
      t.frameEn = "{활동} helps me {효과} and {덧붙임} too, {마지막}.";
      t.frameKo = "{활동}은 제가 {효과} 데 도움이 되고 {덧붙임} {마지막}.";
      t.examples = t.examples.map((e: any, i: number) => {
        const fills = [...e.fills, `extra part ${i}`, `last bit ${i}`];
        return { ...e, fills, en: fillFrame(t.frameEn, fills) };
      });
      t.testFills = [["a".repeat(78), "b".repeat(78), "c".repeat(78), "d".repeat(78)]];
    });
    const r = rejectsAt(f, `templates.items.${(templateBank() as any).items.findIndex((t: any) => t.key === "helps-me")}.testFills.0`);
    add("testFills 채운 문장 301자 거부", r.ok, r.detail);
  }
  // 정렬 빠짐 400 본문에 대상 글자가 없다
  {
    const r = parseGuide(variant((f) => (f.templates.alignmentSkips = [])));
    const body = r.success ? null : JSON.stringify(toeicGuideImportInvalidBody(r.error.issues));
    add("정렬 빠짐 400 본문에 대상 표현 글자가 없다(경로·규칙만)", body !== null && !body.includes("The scene is set in"), "");
  }

  // 통과 쪽
  {
    const r = passes(fixtureFile());
    add("통과: 공통 틀·머리 사례 연결·건너뜀·숫자 채움($15·20)·testFills", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => {
      const t = itemOf(f, "costs-about");
      t.examples[1].fills = ["20"];
      t.examples[1].en = fillFrame(t.frameEn, ["20"]);
      t.testFills = [["7:30"], ["$12"]];
    }));
    add("통과: 숫자만 있는 채움 $15·20·7:30(검토 B1)", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => {
      f.guides[2].expressions.push({ no: 3, expression: "In short", meaningKo: "요컨대", example: null, exampleKo: null });
      f.guides[2].expressions.push({ no: 4, expression: "I rank A above B", meaningKo: "A를 B보다 위로 친다", example: null, exampleKo: null });
      f.guides[2].expressions.push({ no: 5, expression: "It's ~", meaningKo: "~이다", example: null, exampleKo: null });
      f.templates.items.push(tpl("rank-above", "마무리", "I rank {하나} above {다른 하나}.", "저는 {하나}를 {다른 하나}보다 위로 쳐요.", ["q11"], "guide", [{ kind: "expression", part: "q11", expression: "I rank A above B" }],
        [["price", "size"], ["comfort", "style"], ["safety", "speed"]], [["quality", "cost"]], () => "저는 하나를 더 위로 쳐요."));
      f.templates.items.push(tpl("it-is-free", "여가 소재", "It is {무엇} for everyone.", "모두에게 {무엇}이에요.", ["q11"], "guide", [{ kind: "expression", part: "q11", expression: "It's ~" }],
        [["free"], ["open"], ["fun"]], [["easy"]], () => "모두에게 좋아요."));
    }));
    add("통과: 자리 없는 연결어는 빠져도 됨·첫 낱말 아닌 A·B 자리·축약형 차이(It's ~ ↔ It is {…})", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => {
      f.guides[1].expressions.push({ no: 3, expression: "pay rent", meaningKo: "집세를 내다", example: null, exampleKo: null });
      f.templates.items.push(tpl("pays-rent", "구매 습관", "She pays rent {때}.", "그녀는 {때} 집세를 낸다.", ["q5_7"], "guide", [{ kind: "expression", part: "q5_7", expression: "pay rent" }],
        [["every month"], ["on time"], ["early"]], [["by card"]], () => "그녀는 집세를 낸다."));
    }));
    add("통과: 소문자로 시작하는 동사 연어의 활용형(pay rent ↔ She pays rent {때}.)", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => {
      f.guides[0].sections[0].blocks[2].lead.en = "Two chefs/cooks are";
      itemOf(f, "two-cooks-are").guideRefs = [{ kind: "lead", part: "q3_4", leadEn: "Two chefs/cooks are" }];
    }));
    add("통과: 머리말의 a/b 대안 중 하나가 틀과 맞음", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => (f.guides = f.guides.filter((g: any) => g.part !== "q3_4")) && (f.templates.alignmentSkips = [], f.templates.items = f.templates.items.map((t: any) => t.parts.includes("q3_4") ? { ...t, guideRefs: [], source: "new" } : t))));
    add("통과: guides에 없는 유형은 정렬 검사하지 않는다", r.ok, r.detail);
  }
  {
    const r = passes(variant((f) => (f.templates = null)));
    add("통과: templates null이면 정렬 검사가 없다", r.ok, r.detail);
  }
  {
    // 크기 — 틀 은행 900,000바이트 초과(한글 ko로 채운다 — 글자 수 기준이면 통과해 버리는 입력)
    const big = bigBankFile(199);
    const bytes = utf8ByteLength(JSON.stringify({ flows: (big as any).templates.flows, items: (big as any).templates.items }));
    const chars = JSON.stringify({ flows: (big as any).templates.flows, items: (big as any).templates.items }).length;
    const r = parseGuide(big);
    const ps = paths(r);
    add("틀 은행 900,000바이트 초과 거부(경로 templates — 글자 수로는 상한 안)", !r.success && ps.includes("templates") && bytes > TOEIC_GUIDE_MAX_BYTES && chars < TOEIC_GUIDE_MAX_BYTES, `바이트 ${bytes} · 글자 ${chars} · ${ps.slice(0, 3).join(" / ")}`);
  }
  {
    // 유형 공략이 850,000바이트 남짓이고 틀 은행도 850,000바이트 남짓 → 통과(문서가 따로라 따로 잰다)
    let L = 199;
    let f = bigBankFile(L);
    const bankBytes = (x: any) => utf8ByteLength(JSON.stringify({ flows: x.templates.flows, items: x.templates.items }));
    while (L > 60 && bankBytes(f) > 870_000) {
      L -= 3;
      f = bigBankFile(L);
    }
    (f as any).guides[2].sections.push(
      ...Array.from({ length: 4 }, () => ({
        label: null,
        titleKo: "추가",
        introKo: null,
        groupKo: null,
        blocks: Array.from({ length: 60 }, () => ({ kind: "text", label: null, titleKo: null, bodyKo: "나".repeat(1180), lines: [] })),
      })),
    );
    const gBytes = utf8ByteLength(JSON.stringify((f as any).guides[2]));
    const bBytes = bankBytes(f);
    const r = passes(f);
    add(
      "유형 공략 ~850KB + 틀 은행 ~850KB → 통과(따로 잰다)",
      r.ok && gBytes > 800_000 && gBytes <= TOEIC_GUIDE_MAX_BYTES && bBytes > 800_000 && bBytes <= TOEIC_GUIDE_MAX_BYTES,
      `유형 ${gBytes} · 틀 은행 ${bBytes} · ${r.detail}`,
    );
  }
  return results;
}

/** 큰 틀 은행 — 패딩 틀 288개(묶음마다 6개), 예문 5개·ko 길이 koLen(한글) */
function bigBankFile(koLen: number): Json {
  return variant((f) => {
    const five = (t: any) => {
      const extra = [["reading novels"], ["swimming laps"], ["drawing maps"], ["writing notes"]];
      while (t.examples.length < 5) {
        const fills = extra[t.examples.length - 3] ?? [`extra thing ${t.examples.length}`];
        t.examples.push({ en: fillFrame(t.frameEn, fills), ko: "", fills });
      }
      t.examples = t.examples.map((e: any) => ({ ...e, ko: "가".repeat(koLen) }));
    };
    const pads: any[] = [];
    for (let i = 0; i < 288; i++) {
      const b = clone(itemOf(f, "free-time"));
      b.key = `pad-${i}`;
      b.frameEn = `Padding frame ${i} lets me enjoy {활동}.`;
      b.examples = b.examples.map((e: any) => ({ ...e, en: fillFrame(b.frameEn, e.fills) }));
      b.guideRefs = [];
      b.source = "new";
      b.groupKo = `패딩 ${Math.floor(i / 6)}`;
      five(b);
      pads.push(b);
    }
    f.templates.items.push(...pads);
    const groups = [...new Set<string>(pads.map((t) => t.groupKo))];
    const q11 = f.templates.flows.find((x: any) => x.part === "q11");
    q11.steps = [
      { stepKo: "입장", groupsKo: ["입장 밝히기", ...groups.slice(0, 7)] },
      { stepKo: "이유", groupsKo: ["이유 붙이기", ...groups.slice(7, 14)] },
      { stepKo: "정리", groupsKo: ["마무리", ...groups.slice(14, 21)] },
      { stepKo: "넷째", groupsKo: groups.slice(21, 29) },
      { stepKo: "다섯째", groupsKo: groups.slice(29, 37) },
      { stepKo: "여섯째", groupsKo: groups.slice(37, 45) },
    ];
    q11.banksKo = ["여가 소재", ...groups.slice(45)];
  });
}

// ---------------------------------------------------------------------------
// 3. 값 누출 없음 (§12-2-3·§12-10)
// ---------------------------------------------------------------------------

function runGuideLeakChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 값 누출");
  const M = (i: number) => `ZQLEAKMARK${i}`;
  const f = variant((x) => {
    x.guides[0].sections[0].titleKo = M(1); // 한글 없음
    x.guides[0].sections[0].blocks[1].lines[0].en = `${M(2)} 한글`; // 슬롯 밖 한글
    x.guides[0].sections[0].blocks[1].lines[0].emphasis = [M(3)]; // en 밖
    x.guides[0].expressions[1].expression = `${M(4)} {장소}`; // 기호·한글
    x.guides[0].speak[0].modelAnswer = `${M(5)} ~ 한글`;
    x.guides[0].presetKey = `${M(6)} BAD`;
    itemOf(x, "wrap-up").frameEn = `${M(7)} 한글 {결론}.`;
    itemOf(x, "wrap-up").examples[0].fills = [`${M(8)} 가`];
    x.templates.alignmentSkips[0].reasonKo = M(9);
    x.templates.alignmentSkips[0].ref = M(10);
  });
  const r = parseGuide(f);
  const body = r.success ? "" : JSON.stringify(toeicGuideImportInvalidBody(r.error.issues));
  const leaked = Array.from({ length: 10 }, (_x, i) => M(i + 1)).filter((m) => body.includes(m));
  add("틀린 칸마다 넣은 표식이 400 본문에 없다(toeicGuideImportInvalidBody = 라우트가 쓰는 같은 함수)", !r.success && leaked.length === 0, leaked.length > 0 ? `새어 나감 ${leaked.length}개` : "");
  add("400 본문 모양 {ok:false, error:invalid_input, messageKo, issues ≤ 20}", !r.success && body.includes('"error":"invalid_input"') && (JSON.parse(body).issues as unknown[]).length <= 20, "");
  // 형식 오류 파일의 본문 — 값이 없는지
  const r2 = parseGuide({ format: `${M(11)}`, guides: [], templates: null });
  const body2 = r2.success ? "" : JSON.stringify(toeicGuideImportInvalidBody(r2.error.issues));
  add("모르는 format 값도 본문에 싣지 않는다", !r2.success && !body2.includes(M(11)), "");
  return results;
}

// ---------------------------------------------------------------------------
// 4. 다시 가져오기 판정 decideGuideUpsert (§12-2-5)
// ---------------------------------------------------------------------------

function bookSet(id: string, presetKey: string | null): ToeicSetRecord {
  return normalizeToeicSetRecord({
    id,
    titleKo: "DAY 1 지어낸 세트",
    dayNo: 1,
    topicKo: "지어낸 주제",
    source: presetKey ? "import" : "photo",
    presetKey,
    entries: [{ no: 1, expression: "hand out flyers", meaningKo: "전단지를 나눠 주다", example: null, exampleKo: null, points: null, confidence: "high", partial: false }],
    quiz: [],
    photoCount: 0,
    enriched: false,
    model: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    sortIndex: null,
    guide: null,
  });
}

function applyWrites(db: ToeicSetRecord[], writes: { record: ToeicSetRecord }[]): ToeicSetRecord[] {
  const out = [...db];
  for (const w of writes) {
    const i = out.findIndex((r) => r.id === w.record.id);
    const rec = normalizeToeicSetRecord(w.record);
    if (i >= 0) out[i] = rec;
    else out.push(rec);
  }
  return out;
}

function runGuideUpsertChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 다시 가져오기");
  const file = parsedFixture();
  const plan = planToeicGuideImport(file);
  add(
    "계획: 유형 항목 → 틀 은행 순, 문서 id guide-{part}·guide-templates",
    eqJson(plan.map((p) => p.docId), ["guide-q3_4", "guide-q5_7", "guide-q11", TOEIC_TEMPLATE_BANK_ID]),
    plan.map((p) => p.docId).join(","),
  );
  add(
    "계획: entries(points null·confidence high·partial false)·quiz(keyExpressions [])·틀 은행 entries/quiz 빈 배열·제목",
    plan[0].entries.every((e) => e.points === null && e.confidence === "high" && !e.partial) &&
      plan[0].quiz.every((q) => q.keyExpressions.length === 0) &&
      plan[3].entries.length === 0 &&
      plan[3].quiz.length === 0 &&
      plan[0].titleKo === "Q3–4 사진 묘사" &&
      plan[3].titleKo === "템플릿 훈련",
    "",
  );
  const NOW = "2026-09-27T01:00:00.000Z";
  const d1 = decideGuideUpsert(plan, [], NOW);
  add(
    "빈 저장소 → 전부 created, enriched false(파생 — 틀 은행 entries 0), sortIndex null",
    d1.ok && d1.results.every((r) => r.outcome === "created") && d1.writes.every((w) => w.record.enriched === false && w.record.sortIndex === null && w.record.guide !== null),
    "",
  );
  let db: ToeicSetRecord[] = d1.ok ? applyWrites([bookSet("book-1", "book-key-1")], d1.writes) : [];
  const d2 = decideGuideUpsert(plan, db, "2026-09-27T02:00:00.000Z");
  add("같은 파일 두 번 → 전부 unchanged(쓰지 않는다)", d2.ok && d2.writes.length === 0 && d2.results.every((r) => r.outcome === "unchanged"), "");

  // 키 순서만 다른 입력 → zod 출력 기준이라 지문이 같다
  const reorder = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)])) : v;
  const re = toeicGuideFileSchema.safeParse(reorder(fixtureFile()));
  add(
    "키 순서만 다른 파일 → 같은 지문(unchanged)",
    re.success && eqJson(planToeicGuideImport(re.data).map((p) => p.contentHash), plan.map((p) => p.contentHash)),
    "",
  );

  // 틀 글만 고치면 틀 은행만 updated, id·createdAt·sortIndex·presetKey 그대로, 쓰는 것은 toeicSets 문서뿐
  db = db.map((r) => (r.id === TOEIC_TEMPLATE_BANK_ID ? { ...r, sortIndex: 3 } : r));
  const edited = variant((f) => {
    const t = itemOf(f, "wrap-up");
    t.examples[0].ko = "그래서 저는 온라인으로 사요.";
  });
  const pe = toeicGuideFileSchema.safeParse(edited);
  const d3 = pe.success ? decideGuideUpsert(planToeicGuideImport(pe.data), db, "2026-09-27T03:00:00.000Z") : null;
  const bankBefore = db.find((r) => r.id === TOEIC_TEMPLATE_BANK_ID)!;
  const bankW = d3 && d3.ok ? d3.writes.find((w) => w.record.id === TOEIC_TEMPLATE_BANK_ID) : undefined;
  add(
    "틀 글만 고침 → 틀 은행만 updated(id·createdAt·sortIndex·presetKey 그대로, updatedAt 새로, enriched 파생 false)",
    !!d3 && d3.ok && d3.writes.length === 1 && !!bankW && bankW.outcome === "updated" &&
      bankW.record.createdAt === bankBefore.createdAt && bankW.record.sortIndex === 3 && bankW.record.presetKey === bankBefore.presetKey &&
      (bankW.record.guide as { updatedAt: string }).updatedAt === "2026-09-27T03:00:00.000Z" && bankW.record.enriched === false,
    "",
  );
  add("판정은 세트 문서만 쓴다(틀 테스트 세션·시험 기록은 건드리지 않는다)", !!d3 && d3.ok && d3.writes.every((w) => w.record.id.startsWith("guide-")), "");
  const guideEdit = variant((f) => (f.guides[0].sections[0].titleKo = "첫 문장은 장소부터"));
  const pg = toeicGuideFileSchema.safeParse(guideEdit);
  const d4 = pg.success ? decideGuideUpsert(planToeicGuideImport(pg.data), db, NOW) : null;
  add("공략 글만 고침 → 그 유형만 updated(나머지 unchanged)", !!d4 && d4.ok && d4.results.filter((r) => r.outcome === "updated").map((r) => r.id).join() === "guide-q3_4", "");

  // 건너뜀 이유만 고친 파일은 unchanged(지문·문서에 없다)
  const skipEdit = variant((f) => (f.templates.alignmentSkips[0].reasonKo = "같은 뜻 대안이라 대표 틀로 연습"));
  const ps = toeicGuideFileSchema.safeParse(skipEdit);
  const d5 = ps.success ? decideGuideUpsert(planToeicGuideImport(ps.data), db, NOW) : null;
  add("alignmentSkips만 고친 파일 → unchanged", !!d5 && d5.ok && d5.writes.length === 0, "");

  // 충돌
  const otherKey = variant((f) => (f.guides[0].presetKey = "other-guide-q3-4"));
  const po = toeicGuideFileSchema.safeParse(otherKey);
  const d6 = po.success ? decideGuideUpsert(planToeicGuideImport(po.data), db, NOW) : null;
  add(
    "다른 presetKey로 같은 유형 → part_taken, 충돌이 하나면 파일 전체를 쓰지 않는다",
    !!d6 && !d6.ok && d6.conflicts.length === 1 && d6.conflicts[0].reason === "part_taken" && d6.conflicts[0].part === "q3_4",
    "",
  );
  const bookKey = variant((f) => (f.guides[1].presetKey = "book-key-1"));
  const pb = toeicGuideFileSchema.safeParse(bookKey);
  const d7 = pb.success ? decideGuideUpsert(planToeicGuideImport(pb.data), db, NOW) : null;
  add("같은 presetKey가 표현집 세트 → preset_key_is_book", !!d7 && !d7.ok && d7.conflicts.some((c) => c.reason === "preset_key_is_book"), "");
  const swapPart = variant((f) => {
    f.guides[0].presetKey = "vendor-guide-q5-7";
    f.guides[1].presetKey = "vendor-guide-q3-4";
  });
  const pw = toeicGuideFileSchema.safeParse(swapPart);
  const d8 = pw.success ? decideGuideUpsert(planToeicGuideImport(pw.data), db, NOW) : null;
  add("같은 presetKey의 공략 세트가 다른 part → part_mismatch", !!d8 && !d8.ok && d8.conflicts.every((c) => c.reason === "part_mismatch"), "");
  const bankKeyIsGuide = variant((f) => {
    f.templates.presetKey = "vendor-guide-q11";
    f.guides = f.guides.filter((g: any) => g.part !== "q11");
    f.templates.items = f.templates.items.map((t: any) => (t.parts.includes("q11") ? { ...t, guideRefs: t.guideRefs.filter((r: any) => r.part !== "q11"), source: t.guideRefs.some((r: any) => r.part !== "q11") ? t.source : "new" } : t));
  });
  const pk = toeicGuideFileSchema.safeParse(bankKeyIsGuide);
  const d9 = pk.success ? decideGuideUpsert(planToeicGuideImport(pk.data), db, NOW) : null;
  add(
    "틀 은행 키가 유형 공략 문서의 키 → part_mismatch(part \"templates\")",
    !!d9 && !d9.ok && d9.conflicts.some((c) => c.reason === "part_mismatch" && c.part === "templates"),
    pk.success ? "" : "픽스처 변형 실패",
  );
  const bankOtherKey = variant((f) => (f.templates.presetKey = "another-templates"));
  const pn = toeicGuideFileSchema.safeParse(bankOtherKey);
  const d10 = pn.success ? decideGuideUpsert(planToeicGuideImport(pn.data), db, NOW) : null;
  add("다른 키로 틀 은행 두 번 → part_taken(part \"templates\")", !!d10 && !d10.ok && d10.conflicts.some((c) => c.reason === "part_taken" && c.part === "templates"), "");
  // 순서대로 두 번: 같은 유형을 다른 presetKey로
  const firstOnly = variant((f) => {
    f.guides = [f.guides[0]];
    f.templates = null;
  });
  const secondOnly = variant((f) => {
    f.guides = [f.guides[0]];
    f.guides[0].presetKey = "second-guide-q3-4";
    f.templates = null;
  });
  const pf = toeicGuideFileSchema.safeParse(firstOnly);
  const psd = toeicGuideFileSchema.safeParse(secondOnly);
  let seqOk = false;
  if (pf.success && psd.success) {
    const a = decideGuideUpsert(planToeicGuideImport(pf.data), [], NOW);
    const db2 = a.ok ? applyWrites([], a.writes) : [];
    const b = decideGuideUpsert(planToeicGuideImport(psd.data), db2, NOW);
    seqOk = a.ok && !b.ok && b.conflicts[0]?.reason === "part_taken";
  }
  add("같은 유형을 다른 presetKey로 두 번(순서대로) → 둘째가 part_taken", seqOk, "");
  // templates null이면 틀 은행 자리를 읽지도 쓰지도 않는다
  const noBank = variant((f) => (f.templates = null));
  const pnb = toeicGuideFileSchema.safeParse(noBank);
  const planNb = pnb.success ? planToeicGuideImport(pnb.data) : [];
  const dnb = decideGuideUpsert(planNb, [...db, { ...db.find((r) => r.id === TOEIC_TEMPLATE_BANK_ID)!, presetKey: "someone-else" }], NOW);
  add("templates null → 틀 은행 자리를 판정·쓰지 않는다", pnb.success && planNb.every((p) => p.slot !== "templates") && dnb.ok && dnb.writes.every((w) => w.record.id !== TOEIC_TEMPLATE_BANK_ID), "");
  add(
    "지문 = SHA-256(16진 64자) — 유형·틀 은행 각각",
    /^[0-9a-f]{64}$/.test(toeicGuideContentHash(file.guides[0])) && /^[0-9a-f]{64}$/.test(toeicTemplateBankContentHash(file.templates!)),
    "",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 5. 정규화·렌더 판정·모드 넓히기 (§12-3)
// ---------------------------------------------------------------------------

function hasUndefinedDeep(v: unknown): boolean {
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.some(hasUndefinedDeep);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(hasUndefinedDeep);
  return false;
}

function runGuideNormalizeChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 정규화·렌더");
  const book = bookSet("b1", null);
  const { guide: _g, ...noGuide } = book as unknown as Record<string, unknown>;
  add("guide 키 없는 옛 문서 = null(표현집)", normalizeToeicSetRecord(noGuide).guide === null && !isToeicGuideSet(normalizeToeicSetRecord(noGuide)), "");
  const d = decideGuideUpsert(planToeicGuideImport(parsedFixture()), [], "2026-09-27T00:00:00.000Z");
  const docs = d.ok ? d.writes.map((w) => normalizeToeicSetRecord(clone(w.record))) : [];
  const partDoc = docs.find((r) => r.id === "guide-q3_4")!;
  const bank = docs.find((r) => r.id === TOEIC_TEMPLATE_BANK_ID)!;
  add("정규화가 guide를 옮긴다(유형 공략·틀 은행 — 파일 왕복)", !!partDoc && isToeicGuidePartSet(partDoc) && !!bank && isToeicTemplateBankSet(bank), "");
  add("유형 공략: isRenderableToeicSet·isRenderableToeicGuide 참", isRenderableToeicSet(partDoc) && isRenderableToeicGuide(partDoc), "");
  add(
    "틀 은행(entries 0): isRenderableToeicSet 거짓 · isRenderableToeicTemplateBank 참 · enriched 파생 false",
    !isRenderableToeicSet(bank) && isRenderableToeicTemplateBank(bank) && bank.enriched === false && !isRenderableToeicGuide(bank),
    "",
  );
  const weirdPart = normalizeToeicSetRecord({ ...clone(partDoc), guide: { ...clone(partDoc.guide), part: "q9_9" } });
  const weirdKind = normalizeToeicSetRecord({ ...clone(partDoc), guide: { ...clone(partDoc.guide), kind: "mystery" } });
  const noKind = (() => {
    const g = { ...(clone(partDoc.guide) as unknown as Record<string, unknown>) };
    delete g.kind;
    return normalizeToeicSetRecord({ ...clone(partDoc), guide: g });
  })();
  const notArr = normalizeToeicSetRecord({ ...clone(partDoc), guide: { ...clone(partDoc.guide), sections: "broken" } });
  const nonObj = normalizeToeicSetRecord({ ...clone(partDoc), guide: "broken" });
  const bankNotArr = normalizeToeicSetRecord({ ...clone(bank), guide: { ...clone(bank.guide), items: { a: 1 } } });
  add(
    "깨진 guide(part 네 값 밖·kind 두 값 밖·sections 배열 아님·객체 아님)도 null로 떨어지지 않는다(isToeicGuideSet 참·렌더 거짓 → 표현집 목록에 안 나옴)",
    [weirdPart, weirdKind, notArr, nonObj, bankNotArr].every((r) => isToeicGuideSet(r) && !isRenderableToeicGuide(r) && !isRenderableToeicTemplateBank(r)),
    "",
  );
  add("kind 없는 guide 객체는 \"part\"로 읽는다", (noKind.guide as { kind: string }).kind === "part" && isRenderableToeicGuide(noKind), "");
  add("정규화 결과에 undefined가 없다(Firestore 거부)", [partDoc, bank, weirdPart, notArr, nonObj, bankNotArr].every((r) => !hasUndefinedDeep(r)), "");
  const items = (bank.guide as { items: unknown[] }).items;
  const withBroken = [...items, { key: "broken", frameEn: 3 }];
  add(
    "깨진 틀 하나는 그 틀만 빠진다(isRenderableToeicTemplate) — 은행은 열린다",
    withBroken.filter(isRenderableToeicTemplate).length === items.length &&
      isRenderableToeicTemplateBank(normalizeToeicSetRecord({ ...clone(bank), guide: { ...clone(bank.guide), items: withBroken } })),
    "",
  );
  // 목록 가리기 순서 — 공략 계열을 먼저 빼고 열지 못한 수를 센다
  const stored = [book, ...docs, weirdPart];
  const bookList = stored.filter((r) => !isToeicGuideSet(r));
  const skipped = bookList.length - bookList.filter(isRenderableToeicSet).length;
  add("목록: 공략 계열(유형 3·틀 은행·깨진 공략)을 먼저 빼면 \"열지 못한 n개\" = 0", skipped === 0 && bookList.length === 1, "");
  // 세트 불변식 — 공략 세트는 quiz 60개를 자르지 않는다
  const big = normalizeToeicSetRecord({ ...clone(partDoc), quiz: Array.from({ length: 60 }, (_x, i) => ({ no: i + 1, promptKo: "문장이에요.", hint: null, modelAnswer: "A sentence.", keyExpressions: [] })) });
  add("quiz 60개짜리 공략 세트를 정규화·렌더 판정이 그대로 연다(자르지 않는다)", big.quiz.length === 60 && isRenderableToeicSet(big), "");
  // 틀 모드 세션 정규화·집계 무오염
  const tplRec = normalizeToeicQuizRecord({ id: "q1", setId: TOEIC_TEMPLATE_BANK_ID, mode: "tpl-swap", startedAt: "2026-09-27T00:00:00.000Z", finishedAt: null, items: [{ word: "tpl:wrap-up", correct: true, answered: true }] });
  const unknownRec = normalizeToeicQuizRecord({ id: "q2", setId: "s", mode: "tpl-mystery", startedAt: "2026-09-27T00:00:00.000Z", finishedAt: null, items: [] });
  add("normalizeToeicQuizRecord가 틀 모드를 받고 모르는 모드는 지금처럼 버린다", tplRec !== null && tplRec.mode === "tpl-swap" && unknownRec === null, "");
  const exprSessions: ToeicQuizSessionLike[] = [
    { id: "e1", setId: "s", mode: "speak", startedAt: "2026-09-20T00:00:00.000Z", finishedAt: null, items: [{ word: "hand out flyers", correct: false, answered: true }] },
  ];
  const mixed: ToeicQuizSessionLike[] = [...exprSessions, { id: "t1", setId: TOEIC_TEMPLATE_BANK_ID, mode: "tpl-recall", startedAt: "2026-09-21T00:00:00.000Z", finishedAt: null, items: [{ word: "hand out flyers", correct: true, answered: true }] }];
  add("aggregateToeicStatsByMode는 틀 세션이 섞여도 결과가 같다(TOEIC_QUIZ_MODES만 돈다)", eqJson(aggregateToeicStatsByMode(exprSessions), aggregateToeicStatsByMode(mixed)), "");
  return results;
}

// ---------------------------------------------------------------------------
// 6. 공략 읽기 대본 (§12-4)
// ---------------------------------------------------------------------------

function pieceInvariants(script: readonly { text: string; lang: string }[]): boolean {
  return script.every((p) => p.text === p.text.trim() && p.text !== "" && p.text.length <= TTS_TEXT_MAX_CHARS && (p.lang === "en-US" || p.lang === "ko-KR"));
}

function runGuideScriptChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 읽기 대본");
  const g = parsedFixture().guides[0];
  const all = buildToeicGuideScript(g, "all");
  const en = buildToeicGuideScript(g, "english-only");
  const sig = (s: ToeicGuideScriptPiece[]) => s.map((p) => `${p.lang === "en-US" ? "E" : "K"}:${p.block ?? "-"}:${p.line ?? "-"}:${p.text}`);
  const expectedAll = [
    "K:-:-:첫 문장은 장소",
    "K:0:-:장소를 여는 틀",
    "E:1:lead:The scene is set …",
    "K:1:lead:장면의 배경은 …이다.",
    "E:1:0:The scene is set on a crowded ferry deck.",
    "K:1:0:장면의 배경은 붐비는 여객선 갑판이다.",
    "E:1:1:The scene is set on, in …",
    "K:1:1:장면의 배경은 …이다.",
    "K:2:-:동작 이어 말하기",
    "K:2:lead:요리사 두 명이",
    "E:2:0:Two cooks are slicing bread.",
    "K:2:0:빵을 자르고 있다.",
    "E:2:1:Two cooks are wiping the counter.",
    "K:2:1:조리대를 닦고 있다.",
    "K:3:-:색이 여러 가지면 colorful 한 단어로 묶어 말해도 돼요.",
    "K:4:-:인물 묘사 틀",
    "E:4:0:A man is … on the left.",
    "K:4:0:왼쪽의 남자가 …하고 있다.",
    "E:4:1:On the left, a woman is …",
    "K:4:1:왼쪽에서 여자가 …하고 있다.",
  ];
  add("\"전부\" 조각 순서가 §12-4 표와 같다(섹션 제목 → 블록 → 줄: 영어 → 한국어)", eqJson(sig(all), expectedAll), sig(all).slice(0, 3).join(" | "));
  add(
    "\"영어만\": 한국어 조각 없음·머리말 단독 조각 없음(completions)·lead(list)와 줄 영어만",
    eqJson(sig(en), expectedAll.filter((x) => x.startsWith("E:"))),
    sig(en).join(" | ").slice(0, 200),
  );
  const comp = all.filter((p) => p.block === 2);
  add(
    "completions: 합성 조각 = 머리말 + \" \" + 행, 조각 수 = 행 수, lead.en 단독 조각 없음, lead.ko 한 번",
    comp.filter((p) => p.lang === "en-US").length === 2 &&
      comp.filter((p) => p.lang === "en-US").every((p) => p.text.startsWith("Two cooks are ")) &&
      !all.some((p) => p.text === "Two cooks are") &&
      comp.filter((p) => p.line === "lead").length === 1,
    "",
  );
  const blk = g.sections[0].blocks[2];
  const linePieces = toeicGuideLinePieces(all, 0, 2, 0);
  add(
    "줄 🔊 조각 = 대본을 그 줄 주소로 거른 것 = guideLineEn(block, line) 정리 글자",
    blk.kind === "lines" && linePieces[0].text === cleanGuideEnForTts(guideLineEn(blk, blk.lines[0])!) && linePieces.length === 2,
    "",
  );
  const pre = toeicGuidePrefetchTexts(all);
  add("프리페치 목록 ⊆ 영어 조각(합성 문장 같은 글자, 한국어 없음)", pre.every((t) => all.some((p) => p.lang === "en-US" && p.text === t)) && pre.includes("Two cooks are slicing bread."), "");
  add("불변식: trim·비어 있지 않음·≤300·lang 명시(전부·영어만)", pieceInvariants(all) && pieceInvariants(en), "");
  add("라틴 없는 영어 조각이 없다", [...all, ...en].filter((p) => p.lang === "en-US").every((p) => /[A-Za-z]/.test(p.text)), "");
  // 긴 bodyKo → 같은 주소로 여러 조각
  const long = clone(g);
  (long.sections[0].blocks[3] as { bodyKo: string | null }).bodyKo = Array.from({ length: 30 }, (_x, i) => `이것은 긴 설명의 ${i + 1}번째 문장이에요.`).join(" ");
  const longScript = buildToeicGuideScript(long, "all").filter((p) => p.block === 3);
  add("긴 bodyKo는 같은 주소로 여러 조각이 된다", longScript.length > 1 && longScript.every((p) => p.line === null && p.section === 0), `${longScript.length}조각`);
  // 정리 예
  add("(a) 슬래시 대안 upper/lower shelf → \"upper, lower shelf\"", cleanGuideEnForTts("It is on the upper/lower shelf.") === "It is on the upper, lower shelf.", "");
  add("(b) two thousand (and) five → 괄호를 떼고 읽는다", cleanGuideEnForTts("two thousand (and) five") === "two thousand and five", "");
  add("(c) 메모를 note로 옮긴 줄은 메모를 읽지 않는다", !all.some((p) => p.text.includes("주어를 바꿔 말할 때")), "");
  add(
    "맨몸 자리 {출발 장소}·en dash에서 온 {대상} → \"…\"",
    cleanGuideEnForTts("The tour starts from {출발 장소}.") === "The tour starts from …" && cleanGuideEnForTts("put {대상} on the rack") === "put … on the rack",
    "",
  );
  add("한국어 ~·– → \"…\"이고 뒤의 조사가 남는다", cleanGuideKoForTts("그 행사는 ~에서 열려요") === "그 행사는 …에서 열려요" && cleanGuideKoForTts("가방을 – 위에 둔다") === "가방을 … 위에 둔다", "");
  add("한국어 + → 쉼표(\"플러스\" 없음)", cleanGuideKoForTts("What + do you ~?") === "What, do you …?", "");
  add("영어 슬롯·물결·슬래시 → … · , (My pick is {선택}, mainly since {이유}.)", cleanGuideEnForTts("My pick is {선택}, mainly since {이유}.") === "My pick is … mainly since …" && cleanGuideEnForTts("It looks busy/crowded.") === "It looks busy, crowded.", "");
  add("cleanGuideKoForTts: 이름 있는 자리 {활동}은 → \"…은\"(자리 이름을 읽지 않는다)", cleanGuideKoForTts("{활동}은 제가 {효과} 데 도움이 돼요.") === "…은 제가 … 데 도움이 돼요.", "");
  // 틈
  const enOff = buildToeicGuideScript(g, "english-only");
  const enOn = buildToeicGuideScript(g, "english-only", { pause: true, pauseLevel: "long" });
  const allOn = buildToeicGuideScript(g, "all", { pause: true });
  add("\"영어만\" 틈 기본값은 끔(모든 조각 0)", enOff.every((p) => p.pauseAfterMs === 0), "");
  add("틈 켬: 영어 조각마다 shadowPauseMs(글자, 단계)", enOn.every((p) => p.pauseAfterMs === shadowPauseMs(p.text, "long")), "");
  add("\"전부\" 모드는 틈을 켜도 모든 조각 0", allOn.every((p) => p.pauseAfterMs === 0), "");
  // 표시 분할
  const segs = splitGuideEnForDisplay("The scene is set {장소} on a deck.", ["set", "on a deck", "set"], ["scene is set", "deck"]);
  add(
    "강조·밑줄 분할: 이어 붙이면 원문·자리 칩·형광+밑줄 동시 표시·중복 무시",
    segs.map((x) => x.text).join("") === "The scene is set {장소} on a deck." &&
      segs.some((x) => x.slot === "장소") &&
      segs.some((x) => x.text === "set" && x.emphasis && x.underline) &&
      segs.some((x) => x.text === "deck" && x.emphasis && x.underline),
    "",
  );
  const overlap = splitGuideEnForDisplay("I like green tea a lot.", ["tea", "tea a lot"], []);
  const tie = splitGuideEnForDisplay("I like green tea a lot.", ["tea a lot", "green tea"], []);
  add(
    "같은 배열 안 겹침: 긴 것 먼저(같은 길이면 앞에 나오는 것), 겹치면 뒤의 것 건너뜀",
    overlap.filter((x) => x.emphasis).map((x) => x.text).join("|") === "tea a lot" && tie.filter((x) => x.emphasis).map((x) => x.text).join("|") === "green tea",
    overlap.map((x) => `${x.text}${x.emphasis ? "*" : ""}`).join("|"),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 7. 틀 순수 함수 (§12-5-1·§12-5-7)
// ---------------------------------------------------------------------------

function runTemplateFnChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 순수 함수");
  add("fillFrame: 자리 순서대로·대소문자 그대로·$ 그대로", fillFrame("{활동} helps me {효과}.", ["keeping a diary", "$15"]) === "keeping a diary helps me $15.", "");
  add(
    "frameToExpression: 자리 → ~, 공백 접기, 끝 마침표 하나(?는 그대로), { } / 없음",
    frameToExpression("The scene is  set on {장소}.") === "The scene is set on ~" && frameToExpression("Why not {동작}?") === "Why not ~?" && !/[{}/]/.test(frameToExpression("{a} and {b}.")),
    "",
  );
  const F = "{활동} helps me {효과}.";
  const fills = ["Gardening on weekends", "clear my head"];
  const ex = splitExampleByFills(F, fills);
  const fr = splitFrameForDisplay(F);
  add(
    "splitFrameForDisplay·splitExampleByFills: 이어 붙이면 원문, 채움 구간 = 채움 글자",
    fr.map((x) => x.text).join("") === F && ex.map((x) => x.text).join("") === fillFrame(F, fills) && ex.filter((x) => x.slot === 1).map((x) => x.text).join() === "clear my head",
    "",
  );
  const bank = parsedFixture().templates!;
  const links34 = templateLinksForGuide(bank, "q3_4");
  const links11 = templateLinksForGuide(bank, "q11");
  add(
    "templateLinksForGuide: 표현·템플릿 단계·머리말 연결을 모두 찾는다(유형별)",
    eqJson(links34.expressions.get("the scene is set on ~"), ["scene-set-on"]) &&
      eqJson(links34.templateLabels.get("인물"), ["person-on-left"]) &&
      eqJson(links34.leads.get("Two cooks are"), ["two-cooks-are"]) &&
      eqJson(links11.templateLabels.get("이유"), ["helps-me"]) &&
      eqJson(links11.expressions.get("i support ~"), ["i-support"]) &&
      eqJson(links11.templateLabels.get("입장"), ["i-support"]),
    "",
  );
  const triple = templateLinksForGuide(
    { items: [{ key: "tri", guideRefs: [{ kind: "expression", part: "q3_4", expression: "X ~" }, { kind: "template", part: "q3_4", step: "인물" }, { kind: "lead", part: "q3_4", leadEn: "Two cooks are" }] }] },
    "q3_4",
  );
  add("한 틀이 셋 모두에 걸린 경우도 찾는다, 가리키는 틀이 없으면 비어 있다", triple.expressions.size === 1 && triple.templateLabels.size === 1 && triple.leads.size === 1 && templateLinksForGuide({ items: [] }, "q3_4").expressions.size === 0, "");
  add(
    "① 탭 줄 머리 칩: list 줄의 ~ 모양이 연결 표현과 같으면 칩, 슬래시 대안 줄은 펼친 것 중 하나면 칩",
    eqJson(guideLineTemplateKeys(links34, "The scene is set on {장소}."), ["scene-set-on"]) &&
      eqJson(guideLineTemplateKeys(links34, "The scene is set in/on {장소}."), ["scene-set-on"]) &&
      guideLineTemplateKeys(links34, "The scene is set at {장소}.").length === 0,
    "",
  );
  const order = templateFlowOrder(bank, "q11");
  add(
    "templateFlowOrder: 단계 → 단계 안 묶음 → 소재 → 파일 순서",
    eqJson(order.map((g) => `${g.kind}:${g.groupKo}`), ["step:입장 밝히기", "step:이유 붙이기", "step:마무리", "bank:여가 소재"]) &&
      eqJson(flattenTemplateFlow(order).map((t) => t.key), ["i-support", "i-oppose", "helps-me", "wrap-q11", "free-time"]),
    order.map((g) => g.groupKo).join(","),
  );
  const stray = { flows: bank.flows, items: [...bank.items, { ...bank.items[0], key: "stray", groupKo: "흐름 밖", parts: ["q11" as const] }] };
  add("흐름에 없는 묶음의 틀은 \"기타\"로 맨 뒤", templateFlowOrder(stray, "q11").slice(-1)[0].kind === "other" && templateFlowOrder(stray, "q11").slice(-1)[0].templates[0].key === "stray", "");
  add("공통 틀(Q5–7·Q11)은 두 유형 흐름 모두에 나온다", flattenTemplateFlow(templateFlowOrder(bank, "q5_7")).some((t) => t.key === "helps-me") && flattenTemplateFlow(order).some((t) => t.key === "helps-me"), "");
  return results;
}

// ---------------------------------------------------------------------------
// 8. 따라 말하기 대본·예상 시간·이어 듣기 (§12-5-2)
// ---------------------------------------------------------------------------

function runShadowChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "따라 말하기 대본");
  const bank = parsedFixture().templates!;
  const t = bank.items.find((x) => x.key === "helps-me")!;
  const s2 = buildTemplateShadowScript([t], { repeat: 2 });
  const s1 = buildTemplateShadowScript([t], { repeat: 1 });
  const s4 = buildTemplateShadowScript([t]);
  add(
    "순서: 한국어 틀 → 예문마다 ko → en × N(N=1·2·4)",
    s2[0].lang === "ko-KR" && s2[0].example === null && s2.length === 1 + 3 * 3 && s1.length === 1 + 3 * 2 && s4.length === 1 + 3 * 5 &&
      s2[1].lang === "ko-KR" && s2[1].example === 0 && s2[2].lang === "en-US" && s2[2].rep === 1 && s2[3].rep === 2,
    `${s2.length}·${s1.length}·${s4.length}`,
  );
  add("반복 조각의 글자가 같다(캐시 키 하나) = 카드 🔊 글자(trim만)", s4.filter((p) => p.example === 0 && p.lang === "en-US").every((p) => p.text === t.examples[0].en.trim()), "");
  add("한국어 틀의 {자리}가 \"…\"로 읽힌다", s2[0].text === "…은 제가 … 데 도움이 돼요.", s2[0].text);
  const noIntro = buildTemplateShadowScript([t], { intro: false });
  const introEn = buildTemplateShadowScript([t], { introEn: true });
  add("소개 끔이면 한국어 틀 조각 없음, 영어 소개 끔(기본)이면 영어 틀 조각 없음", noIntro[0].example === 0 && !s4.some((p) => p.example === null && p.lang === "en-US"), "");
  add("영어 틀 소개: 자리 \"…\"·쉼 없음·example null", introEn[1].lang === "en-US" && introEn[1].example === null && introEn[1].text === "… helps me …" && introEn[1].pauseAfterMs === 0, introEn[1]?.text ?? "");
  add(
    "쉼: 영어 예문 조각만 shadowPauseMs(단계), 틈 끔이면 전부 0",
    s4.every((p) => (p.lang === "en-US" ? p.pauseAfterMs === shadowPauseMs(p.text) : p.pauseAfterMs === 0)) &&
      buildTemplateShadowScript([t], { pause: false }).every((p) => p.pauseAfterMs === 0) &&
      buildTemplateShadowScript([t], { pauseLevel: "short" }).filter((p) => p.lang === "en-US").every((p) => p.pauseAfterMs === shadowPauseMs(p.text, "short")),
    "",
  );
  add(
    "shadowPauseMs 경계: 1낱말 1,500 · 8낱말 3,900 · 30낱말 8,000 · 8낱말 짧게 3,120 · 길게 5,850",
    shadowPauseMs("One") === 1500 && shadowPauseMs("a b c d e f g h") === 3900 && shadowPauseMs(Array(30).fill("w").join(" ")) === 8000 &&
      shadowPauseMs("a b c d e f g h", "short") === 3120 && shadowPauseMs("a b c d e f g h", "long") === 5850,
    "",
  );
  // 예상 시간 — 손으로 센 값(틀 1개·예문 3개·반복 2)
  const E = TOEIC_SHADOW_ESTIMATE;
  let hand = E.gapMs * (s2.length - 1);
  for (const p of s2) hand += (p.lang === "ko-KR" ? p.text.replace(/\s+/g, "").length * E.koPerCharMs : countWords(p.text) * E.enPerWordMs) + p.pauseAfterMs;
  add("estimateShadowMs = 손으로 센 지어낸 대본 값", estimateShadowMs(s2) === Math.round(hand), `${estimateShadowMs(s2)} vs ${Math.round(hand)}`);
  add("속도 배율로 나뉜다, 쉼 끔이면 쉼 몫 0", estimateShadowMs(s2, 2) === Math.round(hand / 2) && estimateShadowMs(buildTemplateShadowScript([t], { repeat: 2, pause: false })) === Math.round(hand - s2.reduce((n, p) => n + p.pauseAfterMs, 0)), "");
  // 이어 듣기
  const i3 = s4.findIndex((p) => p.example === 1 && p.rep === 3);
  const head1 = s4.findIndex((p) => p.example === 1);
  add("shadowResumeIndex: \"영어 3/4\"에서 멈추면 그 예문의 한국어 조각", shadowResumeIndex(s4, i3) === head1 && s4[head1].lang === "ko-KR", `${shadowResumeIndex(s4, i3)} vs ${head1}`);
  const two = buildTemplateShadowScript([bank.items[0], t], { introEn: true });
  const introIdx = two.findIndex((p) => p.key === t.key && p.example === null && p.lang === "en-US");
  const firstOfT = two.findIndex((p) => p.key === t.key);
  add("틀 소개 중이면 그 틀의 첫 조각, 첫 조각이면 0", shadowResumeIndex(two, introIdx) === firstOfT && shadowResumeIndex(two, 0) === 0, "");
  add("불변식: trim·비어 있지 않음·≤300·lang 명시", pieceInvariants(s4) && pieceInvariants(introEn), "");
  const k = 5;
  const sliced = s4.slice(k);
  add("이어 듣기 오프셋: 대본을 k부터 잘라도 조각 번호 = k + 큐 인덱스", sliced.every((p, i) => s4[k + i] === p), "");
  return results;
}

// ---------------------------------------------------------------------------
// 9. 전사 비교 (§12-5-5)
// ---------------------------------------------------------------------------

/** 옛 alignReadAloud(추출 전)의 참조 구현 — 결과가 글자까지 같은지 무작위 대조한다 */
function refAlignReadAloud(text: string, transcript: string) {
  const a = normalizeReadWords(text);
  const b = normalizeReadWords(transcript);
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
  const missing: string[] = [];
  const extra: string[] = [];
  const substituted: { expected: string; heard: string }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i--;
      j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      substituted.push({ expected: a[i - 1], heard: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      missing.push(a[i - 1]);
      i--;
    } else {
      extra.push(b[j - 1]);
      j--;
    }
  }
  missing.reverse();
  extra.reverse();
  substituted.reverse();
  const accuracy = n === 0 ? 0 : Math.max(0, 1 - (missing.length + substituted.length) / n);
  return { accuracy, missing, extra, substituted };
}

function runTemplateCompareChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 전사 비교");
  const nw = (s: string) => normalizeTemplateWords(s);
  const same = (a: string, b: string) => {
    const x = nw(a);
    const y = nw(b);
    return x.length === y.length && x.every((w, i) => sameTemplateWord(w, y[i]));
  };
  add(
    "축약형: it's↔it is · don't↔do not · can't↔can not↔cannot · won't↔will not · I'm · they're · we've · I'll · let's↔let us · 둥근 아포스트로피",
    same("it's", "it is") && same("don't", "do not") && same("can't", "can not") && same("cannot", "can not") && same("won't", "will not") &&
      same("I'm", "I am") && same("they're", "they are") && same("we've", "we have") && same("I'll", "I will") && same("let's", "let us") && same("it’s", "it is"),
    "",
  );
  add("명사 소유격 's는 풀지 않는다(아포스트로피만 지운다)", eqJson(nw("Tom's bag"), ["toms", "bag"]), nw("Tom's bag").join(" "));
  add(
    "두 뜻 축약형: It has been ↔ It's been · It's ↔ It is·It has · he'd ↔ he would·he had",
    same("It has been", "It's been") && same("It's", "It is") && same("It's", "It has") && same("he'd", "he would") && same("he'd", "he had") && !same("It's", "It was"),
    "",
  );
  add("expandContractions는 lookbehind 없이 대안 낱말을 만든다", expandContractions("That's it") === "That is|has it", expandContractions("That's it"));
  add("숫자: twenty↔20 · twenty-five↔25 · seven thirty↔7:30", same("twenty", "20") && same("twenty-five", "25") && same("seven thirty", "7:30"), "");
  const F = "{활동} helps me {효과}.";
  const fills = ["Gardening on weekends", "clear my head"];
  const c1 = compareTemplateAnswer(F, fills, "Gardening on weekends helps me to clear my mind.");
  add("표 1행: 틀 전부 맞음(to는 더한 말)·자리 채움(head→mind 참고)·○", c1.frameAccuracy === 1 && c1.extra.includes("to") && c1.slots.every((x) => x.filled) && c1.slots[1].matched === 2 && c1.suggest === "pass", "");
  const c2 = compareTemplateAnswer(F, fills, "Gardening on weekends make me clear my head.");
  add("표 2행: helps 다름 → 0.5·✕", c2.frameAccuracy === 0.5 && c2.wrongFixed.length === 1 && c2.wrongFixed[0].expected === "helps" && c2.suggest === "fail", "");
  const c3 = compareTemplateAnswer(F, fills, "Gardening on weekends me helps clear my head.");
  add("표 3행(어순): 빠짐 1 + 더함 1 → 0.5·✕", c3.frameAccuracy === 0.5 && c3.missingFixed.length === 1 && c3.extra.length === 1 && c3.suggest === "fail", `${c3.missingFixed}|${c3.extra}`);
  const c4 = compareTemplateAnswer(F, fills, "Gardening helps me the.");
  add("표 4행: 틀 전부 맞음·자리 2는 관사만 → 비었음·✕(검토 개선 9)", c4.frameAccuracy === 1 && c4.slots[0].filled && !c4.slots[1].filled && c4.suggest === "fail", "");
  const c5 = compareTemplateAnswer(F, fills, "   ");
  add("빈 전사·공백뿐 → noSpeech·✕", c5.noSpeech && c5.suggest === "fail" && compareTemplateAnswer(F, fills, "").noSpeech, "");
  add("대소문자·문장부호·쉼표 위치 차이 무시", compareTemplateAnswer(F, fills, "gardening, on weekends HELPS me clear my head").suggest === "pass", "");
  const art = compareTemplateAnswer("I took {무엇} to the office.", ["a short nap"], "I took short nap to office.");
  add("관사: 자리 안 a 빠짐 → 자리 낱말 전부 맞음 · 고정 부분 the 빠짐 → 틀 정확도가 준다", art.slots[0].matched === art.slots[0].total && art.frameAccuracy < 1 && art.missingFixed.includes("the"), `${art.frameAccuracy}`);
  const other = compareTemplateAnswer(F, fills, "Swimming in the morning helps me feel great.");
  add("틀 부분만 맞고 자리를 다른 말로 채움 → 틀 1·filled·○", other.frameAccuracy === 1 && other.slots.every((x) => x.filled) && other.suggest === "pass", "");
  const empty = compareTemplateAnswer(F, fills, "helps me");
  add("자리를 비움(고정 낱말만 말함) → filled false·✕", !empty.slots[0].filled && !empty.slots[1].filled && empty.suggest === "fail", "");
  add("더한 말(앞뒤 \"음\"·되풀이)은 점수에 들지 않는다", compareTemplateAnswer(F, fills, "um um Gardening on weekends helps me clear my head, helps me").frameAccuracy === 1, "");
  add(
    "축약형 틀: It's easy to {동작} after {때}. ↔ \"It is easy to …\" · 완전형 틀 It has been … ↔ \"It's been …\" · 채움 twenty minutes ↔ \"20 minutes\"",
    compareTemplateAnswer("It's easy to {동작} after {때}.", ["relax", "work"], "It is easy to relax after work.").frameAccuracy === 1 &&
      compareTemplateAnswer("It has been {기간} since {때}.", ["two years", "I moved"], "It's been two years since I moved.").frameAccuracy === 1 &&
      compareTemplateAnswer("It takes {시간}.", ["twenty minutes"], "It takes 20 minutes.").slots[0].matched === 2,
    "",
  );
  const seven = "One two three four five six seven {x}.";
  const six = "One two three four five six {x}.";
  const c7 = compareTemplateAnswer(seven.replace(/One|two|three|four|five|six|seven/g, (w) => ({ One: "Alpha", two: "beta", three: "gamma", four: "delta", five: "echo", six: "fox", seven: "golf" } as Record<string, string>)[w]), ["hotel"], "Alpha beta gamma delta echo fox hotel");
  const c6 = compareTemplateAnswer(six.replace(/One|two|three|four|five|six/g, (w) => ({ One: "Alpha", two: "beta", three: "gamma", four: "delta", five: "echo", six: "fox" } as Record<string, string>)[w]), ["hotel"], "Alpha beta gamma delta echo hotel");
  add(`경계: 고정 7개 중 1개 빠짐 → 0.857 → ○, 6개 중 1개 → 0.83 → ✕(기준 ${TOEIC_TEMPLATE_SUGGEST_MIN})`, Math.abs(c7.frameAccuracy - 6 / 7) < 1e-9 && c7.suggest === "pass" && Math.abs(c6.frameAccuracy - 5 / 6) < 1e-9 && c6.suggest === "fail", `${c7.frameAccuracy} ${c6.frameAccuracy}`);
  // 대안 대조
  const asked = { key: "wrap-a", frameEn: "Let me wrap up {일}.", frameKo: "{일}을 마무리할게요." };
  const alt = { key: "wrap-b", frameEn: "Let me finish {일}.", frameKo: "{일}을 마무리할게요." };
  const alt2 = { key: "wrap-c", frameEn: "Let me finish {일} {때}.", frameKo: "{일}을 마무리할게요." };
  const ca = compareWithAlternatives(asked, [alt, alt2], ["the report"], "Let me finish the report.");
  add("compareWithAlternatives: 한국어 틀이 같은 대안으로 말하면 ○와 대안 표시(기록 키는 호출측이 물은 틀로)", ca.check.suggest === "pass" && ca.viaAlternative && ca.matchedKey === "wrap-b", `${ca.matchedKey}`);
  const cb = compareWithAlternatives(asked, [alt2], ["the report"], "Let me finish the report now.");
  add("자리 수가 다른 틀은 대안으로 쓰지 않는다", !cb.viaAlternative && cb.matchedKey === "wrap-a", "");
  // alignWordSeq 추출 — alignReadAloud 결과 불변(무작위 대조)
  const rng = makeRng(7);
  const vocab = ["the", "a", "bus", "stops", "at", "seven", "7", "pm", "p.m.", "twenty-five", "25", "tour", "starts", "don't", "go", "here"];
  const rand = (n: number) => Array.from({ length: n }, () => vocab[Math.floor(rng() * vocab.length)]).join(" ");
  let diff = 0;
  for (let k = 0; k < 400; k++) {
    const a = rand(Math.floor(rng() * 12));
    const b = rand(Math.floor(rng() * 12));
    if (!eqJson(alignReadAloud(a, b), refAlignReadAloud(a, b))) diff++;
  }
  add("alignWordSeq 추출 뒤 alignReadAloud 결과가 옛 구현과 글자까지 같다(무작위 400쌍)", diff === 0, `다름 ${diff}`);
  add("alignWordSeq 기본 eq = ===, eq 인자로 대안 낱말", alignWordSeq(["is|has"], ["is"]).expected[0].status === "wrong" && alignWordSeq(["is|has"], ["is"], sameTemplateWord).expected[0].status === "ok", "");
  return results;
}

// ---------------------------------------------------------------------------
// 10. 전사문 속 틀 찾기·단계 커버리지·되짚기 (§12-5-5·§12-7-9)
// ---------------------------------------------------------------------------

function runTemplateFindChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 찾기·커버리지");
  const T = [
    { key: "because", frameEn: "That is because {이유}." },
    { key: "opinion", frameEn: "In my opinion, {의견} is better." },
    { key: "single", frameEn: "{x} also {y}." },
    { key: "two-run", frameEn: "I would say {x} makes me happy." },
  ];
  const r = findTemplatesInTranscript("Well, that's because it's cheap. In my opinion, the bus is better. I would say music makes me happy. That is because it's fun.", T);
  add(
    "두 낱말 이상 고정 조각이 순서대로 있으면 찾는다·축약형 차이(that's because)도 찾는다·첫 조각 위치 순·같은 틀 한 번",
    eqJson(r.found.map((f) => f.key), ["because", "opinion", "two-run"]),
    r.found.map((f) => `${f.key}@${f.at}`).join(","),
  );
  add("한 낱말 조각뿐인 틀은 찾지 않고 \"찾을 수 없는 틀\"로 센다", eqJson(r.unmatchable, ["single"]), "");
  const swapped = findTemplatesInTranscript("makes me happy, I would say music", T);
  const half = findTemplatesInTranscript("I would say music makes me", T);
  add("조각 순서가 바뀜·조각 하나가 반만 → 못 찾는다", !swapped.found.some((f) => f.key === "two-run") && !half.found.some((f) => f.key === "two-run"), "");
  const bank = parsedFixture().templates!;
  const cov = templateStepCoverage("q11", ["free-time", "helps-me"], bank);
  add(
    "단계 커버리지: 쓴 틀이 없는 단계가 빠진 단계, 소재 묶음 틀만 쓴 답은 단계를 채우지 않는다",
    eqJson(cov.map((c) => `${c.stepKo}:${c.used.join("+")}`), ["입장:", "이유:helps-me", "정리:"]) && eqJson(missingTemplateSteps("q11", cov), ["입장", "정리"]),
    cov.map((c) => `${c.stepKo}:${c.used.join("+")}`).join(","),
  );
  const multi = { flows: [{ part: "q3_4" as const, steps: [{ stepKo: "눈에 띄는 것", groupsKo: ["인물 동작", "사물 상태"] }], banksKo: [] }], items: [{ key: "obj", groupKo: "사물 상태", parts: ["q3_4" as const] }] };
  add("단계 안 묶음이 여럿이면 그중 하나의 틀만 써도 채워진다", templateStepCoverage("q3_4", ["obj"], multi)[0].used.length === 1, "");
  add("Q5–7·Q8–10에서는 빠진 단계를 내지 않는다", missingTemplateSteps("q5_7", templateStepCoverage("q5_7", [], bank)).length === 0 && eqJson([...TOEIC_TEMPLATE_FLOW_CHECK_PARTS], ["q3_4", "q11"]), "");
  const byExpr = templateByExpression(bank.items);
  add(
    "templateByExpression: ~ 형태·guideRefs 공략 표현 모두로 되짚는다",
    byExpr.get("i support {의견} for two reasons".replace("{의견}", "~")) === "i-support" && byExpr.get("i support ~") === "i-support" && byExpr.get("~ helps me ~") === "helps-me",
    "",
  );
  // §12-13-3 검토 B4(2026-10-02) — 옛 순서(모범답변 → tryExpressions → 빠진 단계)를 이 순서로 교체했다(인자 이름 sampleKeys)
  const sugg = templatesCouldHaveUsed({
    missingStepKeys: ["wrap-q11", "i-oppose", "free-time", "costs-about"],
    tryExpressions: ["For these reasons, I ~", "not a template"],
    sampleKeys: ["i-support", "helps-me"],
    mine: new Set(["helps-me"]),
    byExpression: byExpr,
  });
  add(
    "쓸 수 있었던 틀 = 빠진 단계 → tryExpressions → 모범답변 순(§12-13-3 B4), 최대 5, 내가 쓴 틀은 빠진다, 겹치면 앞 출처",
    eqJson(sugg.map((x) => `${x.source}:${x.key}`), ["step:wrap-q11", "step:i-oppose", "step:free-time", "step:costs-about", "sample:i-support"]),
    sugg.map((x) => `${x.source}:${x.key}`).join(","),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 11. 템플릿 테스트·숙련도 (§12-5-3·§12-5-6)
// ---------------------------------------------------------------------------

function tplSession(id: string, mode: "tpl-recall" | "tpl-swap", startedAt: string, items: [string, boolean][]): ToeicQuizSessionLike {
  return { id, setId: TOEIC_TEMPLATE_BANK_ID, mode, startedAt, finishedAt: startedAt, items: items.map(([k, c]) => ({ word: templateItemKey(k), correct: c, answered: true })) };
}

function runTemplateTestChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 테스트·숙련도");
  const bank = parsedFixture().templates!;
  // 12틀짜리 범위(흐름 순서) — 공통 틀 포함 q5_7 + q11 + q3_4를 이어 붙인다
  const range: ToeicTemplate[] = [];
  for (const p of ["q3_4", "q5_7", "q11"] as const) for (const t of flattenTemplateFlow(templateFlowOrder(bank, p))) if (!range.some((x) => x.key === t.key)) range.push(t);
  const qs = buildTemplateTestQuestions(range, [], { mode: "tpl-recall", rng: makeRng(3) });
  add("한 판 최대 10·한 틀 한 문항(같은 key 두 번 없음)", qs.length === TOEIC_TEMPLATE_TEST_MAX && new Set(qs.map((q) => q.key)).size === qs.length, `${qs.length}`);
  const pos = (k: string) => range.findIndex((t) => t.key === k);
  add("고른 뒤 흐름 순서로 늘어선다", qs.every((q, i) => i === 0 || pos(qs[i - 1].key) < pos(q.key)), "");
  // 약한 순 + 복습 칸
  const S = [
    tplSession("s1", "tpl-recall", "2026-09-10T01:00:00.000Z", [["scene-set-on", true], ["two-cooks-are", true], ["wrap-up", false]]),
    tplSession("s2", "tpl-recall", "2026-09-11T01:00:00.000Z", [["scene-set-on", true], ["two-cooks-are", true], ["costs-about", true]]),
    tplSession("s3", "tpl-recall", "2026-09-20T01:00:00.000Z", [["two-cooks-are", true], ["costs-about", true]]),
  ];
  const stats = aggregateToeicTemplateStats(S)["tpl-recall"];
  add("다른 날 ○○ → 졸업(scene-set-on·two-cooks-are·costs-about)", stats["scene-set-on"].streak === 2 && stats["costs-about"].streak === 2, "");
  const small = buildTemplateTestQuestions(range, S, { mode: "tpl-recall", max: 4, rng: makeRng(5) });
  const reviewKeys = small.filter((q) => q.review).map((q) => q.key);
  add(
    `복습 칸: 졸업 틀 중 마지막 시도가 가장 오래된 것 최대 ${TOEIC_TEMPLATE_TEST_REVIEW_SLOTS}칸(scene-set-on 먼저)`,
    reviewKeys.length === 2 && reviewKeys.includes("scene-set-on") && small.some((q) => q.key === "wrap-up"),
    small.map((q) => `${q.key}${q.review ? "*" : ""}`).join(","),
  );
  const wrongOnly = buildTemplateTestQuestions(range, S, { mode: "tpl-recall", onlyWrong: true });
  add("onlyWrong: 그 모드 틀린 틀만·복습 칸 없음", eqJson(wrongOnly.map((q) => q.key), ["wrap-up"]) && wrongOnly.every((q) => !q.review), "");
  const noGrad = buildTemplateTestQuestions(range, [S[0]], { mode: "tpl-recall", max: 3, rng: makeRng(9) });
  add("범위에 졸업 틀이 없으면 복습 칸도 약한 순", noGrad.every((q) => !q.review) && noGrad.some((q) => q.key === "wrap-up"), noGrad.map((q) => q.key).join(","));
  // 예문·채움 차례
  const t = range.find((x) => x.key === "helps-me")!;
  const tries = (n: number, mode: "tpl-recall" | "tpl-swap") =>
    Array.from({ length: n }, (_x, i) => tplSession(`r${i}`, mode, `2026-09-0${(i % 9) + 1}T0${i % 9}:00:00.000Z`, [["helps-me", i % 2 === 0]]));
  const qa0 = buildTemplateTestQuestions([t], [], { mode: "tpl-recall" })[0];
  const qa3 = buildTemplateTestQuestions([t], tries(3, "tpl-recall"), { mode: "tpl-recall" })[0];
  add("(가) 예문 a = t mod n(시도 0 → 첫 예문, 시도 3·예문 3개 → 첫 예문으로 돌아옴)", qa0.exampleIndex === 0 && qa0.answerEn === t.examples[0].en && qa3.exampleIndex === 0 && qa0.listenEn === null && qa0.answerKo === t.examples[0].ko, "");
  const qa4 = buildTemplateTestQuestions([t], tries(4, "tpl-recall"), { mode: "tpl-recall" })[0];
  add("(가) 시도 4 → 예문 1", qa4.exampleIndex === 1, "");
  const qb1 = buildTemplateTestQuestions([t], tries(1, "tpl-swap"), { mode: "tpl-swap" })[0];
  add(
    "(나) 들려줄 예문 m = t mod n, 정답 채움 testFills[t mod L], 정답 문장이 그 틀의 어떤 예문 en과도 다르다",
    qb1.exampleIndex === 1 && qb1.listenEn === t.examples[1].en && eqJson(qb1.answerFills, t.testFills[1]) && qb1.answerEn === fillFrame(t.frameEn, t.testFills[1]) && !t.examples.some((e) => e.en === qb1.answerEn) && qb1.answerKo === null,
    "",
  );
  // 소스 대조 — 순위 규칙 사본·어댑터 사본 없음
  const src = readFileSync(new URL("../lib/toeic-template.ts", import.meta.url), "utf-8");
  add("lib/toeic-template.ts에 약함 순위 사본이 없다(weaknessRank를 import해 부른다)", /import\s*\{[^}]*\bweaknessRank\b[^}]*\}\s*from\s*"\.\/toeic-quiz"/.test(src) && !/function\s+weaknessRank/.test(src), "");
  add("세션 어댑터는 toeicSessionsToVocabRecords 하나(사본 없음)", /toeicSessionsToVocabRecords/.test(src) && !/bookId\s*:/.test(src), "");
  add("weaknessRank 공개 — 틀렸고 미졸업 0 → 안 해 봄 1 → 진행 2 → 졸업 3", weaknessRank(undefined) === 1 && weaknessRank({ total: 1, wrong: 1, streak: 0 }) === 0 && weaknessRank({ total: 1, wrong: 0, streak: 1 }) === 2 && weaknessRank({ total: 2, wrong: 0, streak: 2 }) === 3, "");
  // 모드 분리·공통 틀·표현 시험과 분리
  const cross = [tplSession("x1", "tpl-recall", "2026-09-01T01:00:00.000Z", [["helps-me", false]]), tplSession("x2", "tpl-swap", "2026-09-02T01:00:00.000Z", [["helps-me", true]])];
  const cs = aggregateToeicTemplateStats(cross);
  add("두 모드가 서로의 통계에 섞이지 않는다", cs["tpl-recall"]["helps-me"].wrong === 1 && cs["tpl-swap"]["helps-me"].wrong === 0, "");
  add("공통 틀(Q5–7·Q11)은 어느 폴더에서 풀어도 통계가 하나(키 = 틀 key)", Object.keys(cs["tpl-recall"]).length === 1, "");
  const exprSess: ToeicQuizSessionLike = { id: "e", setId: "guide-q5_7", mode: "speak", startedAt: "2026-09-03T00:00:00.000Z", finishedAt: null, items: [{ word: "~ helps me ~", correct: false, answered: true }] };
  add("표현 시험 세션은 틀 통계를, 틀 세션은 표현 시험 통계를 바꾸지 않는다", eqJson(aggregateToeicTemplateStats([...cross, exprSess]), cs) && eqJson(aggregateToeicStatsByMode([exprSess, ...cross]), aggregateToeicStatsByMode([exprSess])), "");
  // 같은 날 ○ 접기
  const day = (a: string, b: string, x: boolean, y: boolean) => aggregateToeicTemplateStats([tplSession("d1", "tpl-swap", a, [["wrap-up", x]]), tplSession("d2", "tpl-swap", b, [["wrap-up", y]])])["tpl-swap"]["wrap-up"];
  const sameOO = day("2026-09-10T01:00:00.000Z", "2026-09-10T05:00:00.000Z", true, true);
  const diffOO = day("2026-09-10T01:00:00.000Z", "2026-09-11T01:00:00.000Z", true, true);
  const sameOX = day("2026-09-10T01:00:00.000Z", "2026-09-10T05:00:00.000Z", true, false);
  const sameXO = day("2026-09-10T01:00:00.000Z", "2026-09-10T05:00:00.000Z", false, true);
  const kstEdge = day("2026-09-10T14:59:00.000Z", "2026-09-10T15:01:00.000Z", true, true);
  add(
    "같은 날 ○ 접기: 같은 날 ○○ → 연속 1 · 다른 날 ○○ → 졸업 · 같은 날 ○✕ → ✕ 셈 · 같은 날 ✕○ → 연속 1 · KST 날짜 경계(UTC 15:00)를 넘으면 다른 날",
    sameOO.streak === 1 && diffOO.streak === 2 && sameOX.wrong === 1 && sameOX.streak === 0 && sameXO.streak === 1 && sameXO.wrong === 1 && kstEdge.streak === 2,
    `${sameOO.streak}/${diffOO.streak}/${sameOX.streak}/${sameXO.streak}/${kstEdge.streak}`,
  );
  const badges = toeicTemplateBadges([tplSession("b1", "tpl-swap", "2026-09-27T01:00:00.000Z", [["wrap-up", true]]), tplSession("b2", "tpl-swap", "2026-09-27T02:00:00.000Z", [["wrap-up", true], ["costs-about", false]])], "2026-09-27");
  add("배지: 같은 날 ○○ → \"오늘 ○ — 내일 한 번 더\", 마지막 ✕ → ✕", badges["tpl-swap"]["wrap-up"] === "today" && badges["tpl-swap"]["costs-about"] === "wrong", JSON.stringify(badges["tpl-swap"]));
  const wrongSessions = [tplSession("w1", "tpl-recall", "2026-09-01T01:00:00.000Z", [["wrap-up", false], ["helps-me", false]]), tplSession("w2", "tpl-recall", "2026-09-02T01:00:00.000Z", [["helps-me", true]]), tplSession("w3", "tpl-recall", "2026-09-03T01:00:00.000Z", [["helps-me", true]]), tplSession("w4", "tpl-swap", "2026-09-03T01:00:00.000Z", [["costs-about", false]])];
  add(
    "toeicTemplateWrongKeys: 틀렸고 미졸업만 · \"틀린 틀만 따라 말하기\" = 두 모드 합집합",
    eqJson([...toeicTemplateWrongKeys(wrongSessions, "tpl-recall")], ["wrap-up"]) && eqJson([...toeicTemplateWrongKeysAnyMode(wrongSessions)].sort(), ["costs-about", "wrap-up"]),
    "",
  );
  add(
    "상한: 문항당 전사 2·세션 20·녹음 20초·0.6초 미만은 보내지 않음(canTranscribeAgain)",
    TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION === 2 && TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION === 20 && TOEIC_TEMPLATE_REC_MAX_MS === 20_000 &&
      canTranscribeAgain({ perQuestion: 1, perSession: 19 }) && !canTranscribeAgain({ perQuestion: 2, perSession: 3 }) && !canTranscribeAgain({ perQuestion: 0, perSession: 20 }) &&
      !isSendableTemplateRecording(TOEIC_TEMPLATE_REC_MIN_MS - 1) && isSendableTemplateRecording(TOEIC_TEMPLATE_REC_MIN_MS),
    "",
  );
  // 기록 라우트 본문 zod(계약) — 라우트 핸들러는 부르지 않는다
  const ok = { clientSessionId: "0f8b6c2a-1d3e-4a5b-9c7d-112233445566", mode: "tpl-swap", startedAt: "2026-09-27T01:00:00.000Z", finishedAt: null, items: [{ word: "tpl:wrap-up", correct: true, answered: true }] };
  const bad = (over: Record<string, unknown>) => !toeicTemplateSessionBodySchema.safeParse({ ...ok, ...over }).success;
  add(
    "기록 본문 zod: 소문자 UUID·datetime·틀 모드 둘·word 형식·세션 안 중복·items 1~10",
    toeicTemplateSessionBodySchema.safeParse(ok).success &&
      bad({ clientSessionId: ok.clientSessionId.toUpperCase() }) && bad({ clientSessionId: "a/b/c" }) && bad({ clientSessionId: "" }) &&
      bad({ startedAt: "yesterday" }) && bad({ finishedAt: "later" }) && bad({ mode: "speak" }) &&
      bad({ items: [{ word: "wrap-up", correct: true, answered: true }] }) && bad({ items: [ok.items[0], ok.items[0]] }) && bad({ items: [] }) &&
      bad({ items: Array.from({ length: 11 }, (_x, i) => ({ word: `tpl:k${i}`, correct: true, answered: true })) }),
    "",
  );
  add("멱등 문서 id = tpl-{clientSessionId}, 형식 정규식은 계약 파일 한 곳", toeicTemplateSessionDocId(ok.clientSessionId) === `tpl-${ok.clientSessionId}` && TOEIC_TEMPLATE_SESSION_ID_RE.test(ok.clientSessionId), "");
  return results;
}

// ---------------------------------------------------------------------------
// 12. 한 문제 연습 순수 함수 (§12-7)
// ---------------------------------------------------------------------------

function runDrillChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "한 문제 연습");
  add(
    "TOEIC_DRILL_UNITS 리터럴 4행",
    eqJson(TOEIC_DRILL_UNITS, [
      { part: "q3_4", mockPart: "picture", questions: [3] },
      { part: "q5_7", mockPart: "respond", questions: [5, 6, 7] },
      { part: "q8_10", mockPart: "info", questions: [8, 9, 10] },
      { part: "q11", mockPart: "opinion", questions: [11] },
    ]),
    "",
  );
  const scene = (place: string) => ({ place, imagePrompt: "A wide photo of a quiet place with people walking around slowly in the afternoon light.", sceneKo: "조용한 곳", sampleAnswer: "This picture was taken in a quiet place.", keyPointsKo: ["장소", "사람", "느낌"], usedExpressions: [], image: { status: "ready" as const, imageId: "img" } });
  const pic: ToeicPicturePart = { items: [scene("park"), scene("station")] };
  const d0 = toDrillRecordPart("picture", pic, () => 0);
  const d1 = toDrillRecordPart("picture", pic, () => 0.99);
  add(
    "toDrillRecordPart: picture는 rng가 고른 한 장면만(rng 0 → 첫 장면, 0.99 → 둘째)·image pending, 다른 파트는 그대로",
    d0.items.length === 1 && d0.items[0].place === "park" && d1.items[0].place === "station" && d0.items[0].image.status === "pending" && d0.items[0].image.imageId === null,
    "",
  );
  const op = { kind: "agree" as const, question: "Q?", sampleAnswer: "A.", outlineKo: ["가"], tipKo: "팁", usedExpressions: [] };
  add("다른 파트는 그대로 돌려준다", toDrillRecordPart("opinion", op, () => 0.5) === op, "");
  const parts = { read: null, picture: pic, respond: {}, info: {}, opinion: op };
  const r3 = decideAttemptScope("part", ["picture"], parts, "picture");
  const r5 = decideAttemptScope("part", ["respond"], parts, "respond");
  const r8 = decideAttemptScope("part", ["info"], parts, "info");
  const r11 = decideAttemptScope("part", ["opinion"], parts, "opinion");
  add(
    "decideAttemptScope 연습 갈래: [3]·[5,6,7]·[8,9,10]·[11]",
    r3.ok && eqJson(r3.questions, [3]) && r5.ok && eqJson(r5.questions, [5, 6, 7]) && r8.ok && eqJson(r8.questions, [8, 9, 10]) && r11.ok && eqJson(r11.questions, [11]),
    "",
  );
  const bad1 = decideAttemptScope("full", ["read", "picture", "respond", "info", "opinion"], parts, "picture");
  const bad2 = decideAttemptScope("part", ["opinion"], parts, "picture");
  const plain = decideAttemptScope("part", ["picture"], parts);
  add("연습에 full·다른 파트 → scope_parts_mismatch, drillPart 없으면 기존 판정(questions = 파트 문항)", !bad1.ok && bad1.reason === "scope_parts_mismatch" && !bad2.ok && bad2.reason === "scope_parts_mismatch" && plain.ok && eqJson(plain.questions, [3, 4]), "");
  const picFmt = TOEIC_MOCK_FORMAT.find((f) => f.q === 3)!;
  const one = toeicPartDirections("picture", 1);
  add(
    "toeicPartDirections: 전체 개수면 TOEIC_PART_DIRECTIONS와 같은 글자(같은 객체), 사진 1장 문장의 숫자는 형식표 값",
    (["read", "picture", "respond", "info", "opinion"] as const).every((p) => toeicPartDirections(p, TOEIC_MOCK_FORMAT.filter((f) => f.part === p).length) === TOEIC_PART_DIRECTIONS[p]) &&
      one.en === `Describing a picture. One photo will appear. Study it for ${picFmt.prepSec} seconds, then talk about it for ${picFmt.answerSec} seconds.` &&
      one.ko === `사진 묘사. 사진 1장이 나와요. ${picFmt.prepSec}초 동안 살펴본 뒤, ${picFmt.answerSec}초 동안 묘사하세요.`,
    one.en,
  );
  add("toeicDrillScopeLabelKo: \"공략 연습 · Q3–4 사진 묘사 · Q3\", Q5–7이면 문항 표시 없음", toeicDrillScopeLabelKo("picture", [3]) === "공략 연습 · Q3–4 사진 묘사 · Q3" && toeicDrillScopeLabelKo("respond", [5, 6, 7]) === "공략 연습 · Q5–7 듣고 답하기", toeicDrillScopeLabelKo("picture", [3]));
  add("nextToeicDrillTitle: 유형별 번호(\"사진 묘사 연습 n\")", nextToeicDrillTitle("picture", []) === "사진 묘사 연습 1" && nextToeicDrillTitle("picture", ["사진 묘사 연습 4", "사진 묘사 연습 2"]) === "사진 묘사 연습 5" && nextToeicDrillTitle("opinion", ["x"]) === "의견 말하기 연습 2", "");
  add("주제 풀: 파트마다 8개 이상", Object.values(TOEIC_DRILL_TOPIC_POOL).every((p) => p.length >= 8 && new Set(p).size === p.length), "");
  const pool = TOEIC_DRILL_TOPIC_POOL.picture;
  const recent = [[pool[0]], [pool[1]], [pool[2]], [pool[3]]];
  const picks = new Set(Array.from({ length: 50 }, (_x, i) => pickDrillTopic("picture", recent, makeRng(i + 1))));
  add("pickDrillTopic: 최근 3개 주제 제외(넷째는 다시 나올 수 있다)", ![pool[0], pool[1], pool[2]].some((p) => picks.has(p)), [...picks].length.toString());
  add("다 빠지면 풀 전체에서 고른다", pool.includes(pickDrillTopic("picture", [pool.slice(0, 5), pool.slice(5)], () => 0.3)), "");
  // pickExpressionsForDrill — §12-13-3 새 모양(2026-10-02): 틀은 답변 흐름으로 갔다. 공략 표현 중 틀이 연결한 것·같은 자리 다른 표현을 뺀다
  const bank = parsedFixture().templates!;
  const bankDoc = { ...bank, alternates: toeicTemplateAlternatesFromSkips(bank.alignmentSkips) };
  const guideSet = { entries: [{ expression: "I support ~" }, { expression: "I oppose ~" }, { expression: "For these reasons, I ~" }] };
  const bookSets = [{ entries: Array.from({ length: 30 }, (_x, i) => ({ expression: `book expression ${i}` })) }];
  const q11Items = bank.items.filter((t) => t.parts.includes("q11"));
  const q11Exclude = guideExpressionKeysInFlow(bankDoc, "q11");
  const src = (exclude: ReadonlySet<string>) => ({
    guide: { set: guideSet, sessions: [] as ToeicQuizSessionLike[], exclude },
    book: { sets: bookSets, sessions: [] as ToeicQuizSessionLike[] },
  });
  const list = pickExpressionsForDrill(src(q11Exclude), { rng: makeRng(1) });
  const tplForms = new Set(q11Items.map((t) => frameToExpression(t.frameEn).toLowerCase()));
  add(
    "새 모양: 틀 ~ 형태는 넣지 않는다(흐름으로 갔다) · 틀이 연결한 공략 표현(I support ~·I oppose ~)은 빠진다 · 흐름 밖 공략 표현은 남는다 · 24 상한 · 중복 없음",
    !list.includes("I support ~") && !list.includes("I oppose ~") && list[0] === "For these reasons, I ~" && list.length === 24 &&
      new Set(list.map((e) => e.toLowerCase())).size === list.length && list.slice(1).every((e) => e.startsWith("book expression")) &&
      list.filter((e) => tplForms.has(e.toLowerCase())).length <= 1,
    list.slice(0, 4).join(" / "),
  );
  {
    const q34Exclude = guideExpressionKeysInFlow(bankDoc, "q3_4");
    const q34Guide = { entries: [{ expression: "The scene is set on ~" }, { expression: "The scene is set in ~" }, { expression: "Look at the ~ first" }] };
    const l = pickExpressionsForDrill({ guide: { set: q34Guide, sessions: [], exclude: q34Exclude }, book: { sets: [], sessions: [] } }, { rng: makeRng(3) });
    add(
      "같은 자리 다른 표현(alternates — The scene is set in ~)과 틀이 연결한 표현(…set on ~)은 빠지고 흐름 밖 공략 표현만 남는다",
      eqJson(l, ["Look at the ~ first"]) && q34Exclude.has("the scene is set in ~") && q34Exclude.has("the scene is set on ~"),
      l.join(" / "),
    );
  }
  const fiveSteps = {
    ...bank,
    flows: bank.flows.map((f) =>
      f.part === "q11"
        ? { ...f, steps: [...f.steps, { stepKo: "넷째", groupsKo: ["여가 소재"] }, { stepKo: "다섯째", groupsKo: ["보충"] }], banksKo: [] }
        : f,
    ),
    items: [...bank.items, { ...bank.items.find((t) => t.key === "free-time")!, key: "extra-5", groupKo: "보충", frameEn: "On top of that, {덧붙임}.", frameKo: "게다가 {덧붙임}." }],
  };
  const pickedSteps = pickTemplatesForDrill(fiveSteps.items, [], { part: "q11", flows: fiveSteps.flows, max: TOEIC_DRILL_TEMPLATES_MAX, rng: makeRng(4) });
  const stepOf = (k: string) => fiveSteps.flows.find((f) => f.part === "q11")!.steps.findIndex((s) => s.groupsKo.includes(fiveSteps.items.find((t) => t.key === k)!.groupKo));
  add("단계가 5개인 유형에서 단계마다 하나씩 모두 들어간다(앞 5칸이 단계 순서)", eqJson(pickedSteps.slice(0, 5).map((t) => stepOf(t.key)), [0, 1, 2, 3, 4]), pickedSteps.map((t) => t.key).join(","));
  add("다른 유형의 틀은 들어가지 않는다", pickTemplatesForDrill(bank.items, [], { part: "q11", flows: bank.flows }).every((t) => t.parts.includes("q11")), "");
  // 세션 분리 — 공략 세션만 틀린 표현은 표현집 순위를 바꾸지 않는다
  const shared = "I support ~";
  const book2 = [{ entries: [{ expression: shared }, { expression: "book a" }, { expression: "book b" }] }];
  const wrongGuide: ToeicQuizSessionLike[] = [{ id: "g", setId: "guide-q11", mode: "ko-to-expr", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, items: [{ word: shared, correct: false, answered: true }] }];
  const noBankExclude = new Set<string>();
  const bookRank = (sessions: ToeicQuizSessionLike[]) => pickExpressionsForMock(book2, sessions, { rng: makeRng(2) });
  const viaDrill = pickExpressionsForDrill({ guide: { set: null, sessions: wrongGuide, exclude: noBankExclude }, book: { sets: book2, sessions: [] } }, { rng: makeRng(2) });
  add("세션 분리: 공략 세션만 틀린 표현은 표현집 쪽 순위를 바꾸지 않는다", eqJson(viaDrill, bookRank([])), `${viaDrill.join(",")}`);
  // pickExpressionsForMock을 거친다 — 공략 쪽 순위 = pickExpressionsForMock([guide], guideSessions)
  const gSessions: ToeicQuizSessionLike[] = [{ id: "g2", setId: "guide-q11", mode: "ko-to-expr", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, items: [{ word: "I oppose ~", correct: false, answered: true }, { word: "I support ~", correct: true, answered: true }] }];
  const guideOnly = pickExpressionsForDrill({ guide: { set: guideSet, sessions: gSessions, exclude: noBankExclude }, book: { sets: [], sessions: [] } }, { rng: makeRng(8) });
  add("공략 쪽 순위가 pickExpressionsForMock([guide], guideSessions)와 같다", eqJson(guideOnly, pickExpressionsForMock([guideSet], gSessions, { rng: makeRng(8) })), guideOnly.join(","));
  const noBank = pickExpressionsForDrill({ guide: { set: null, sessions: [], exclude: noBankExclude }, book: { sets: bookSets, sessions: [] } }, { rng: makeRng(11) });
  add("틀 은행·공략이 없으면 지금과 같은 결과(= pickExpressionsForMock(표현집))", eqJson(noBank, pickExpressionsForMock(bookSets, [], { rng: makeRng(11) })), "");
  {
    // 틀 은행이 없으면 exclude가 비어 옛 함수(틀 은행 없을 때 — 틀 0개: 공략 → 표현집, 같은 rng 소비)와 같다
    const rngA = makeRng(21);
    const viaNew = pickExpressionsForDrill({ guide: { set: guideSet, sessions: [], exclude: new Set() }, book: { sets: bookSets, sessions: [] } }, { rng: rngA });
    const rngB = makeRng(21);
    const oldWay = [...pickExpressionsForMock([guideSet], [], { rng: rngB }), ...pickExpressionsForMock(bookSets, [], { rng: rngB })];
    const oldDedup: string[] = [];
    for (const e of oldWay) if (!oldDedup.some((x) => x.toLowerCase() === e.toLowerCase()) && oldDedup.length < 24) oldDedup.push(e);
    add("틀 은행이 없으면(exclude 빈 집합) 옛 함수(틀 0개)와 같은 결과 — 공략 → 표현집, 같은 rng 소비", eqJson(viaNew, oldDedup), "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 13. 시험 출제 옵션 (§12-6)
// ---------------------------------------------------------------------------

function runGuideQuizChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 표현 시험");
  const set = {
    entries: [],
    quiz: Array.from({ length: 12 }, (_x, i) => ({ no: i + 1, promptKo: `문장 ${i + 1}`, hint: null, modelAnswer: `Sentence ${i + 1}.`, keyExpressions: [] as string[] })),
  };
  const speakSessions: ToeicQuizSessionLike[] = [
    { id: "a", setId: "g", mode: "speak", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, items: [{ word: "quiz:12", correct: false, answered: true }, { word: "quiz:11", correct: true, answered: true }, { word: "quiz:1", correct: true, answered: true }] },
    { id: "b", setId: "g", mode: "speak", startedAt: "2026-09-02T00:00:00.000Z", finishedAt: null, items: [{ word: "quiz:1", correct: true, answered: true }] },
  ];
  const small = { entries: [], quiz: set.quiz.filter((q) => [1, 3, 4, 11, 12].includes(q.no!)) };
  const w = buildToeicSpeakSession(small, speakSessions, { quizOrder: "weakness", max: 4, rng: makeRng(1) });
  add(
    "quizOrder weakness: 말하기 통계로 약한 순(틀림 → 안 해 봄 → 진행 → 졸업), 앞에서 max개",
    eqJson(w.map((q) => q.key)[0], "quiz:12") && eqJson(w.map((q) => q.key).slice(1, 3).sort(), ["quiz:3", "quiz:4"]) && w[3].key === "quiz:11" && !w.some((q) => q.key === "quiz:1"),
    w.map((q) => q.key).join(","),
  );
  const w10 = buildToeicSpeakSession(set, speakSessions, { quizOrder: "weakness", rng: makeRng(1) });
  add("weakness 기본 상한 10(교재 앞 10개가 아니라 약한 10개)", w10.length === 10 && w10[0].key === "quiz:12" && !w10.some((q) => q.key === "quiz:1"), w10.map((q) => q.key).join(","));
  const polluted = [...speakSessions, { id: "c", setId: "g", mode: "ko-to-expr" as const, startedAt: "2026-09-03T00:00:00.000Z", finishedAt: null, items: [{ word: "quiz:3", correct: false, answered: true }] }];
  add("다른 모드 통계가 섞여도 순서가 같다(반례: 다른 모드에서 틀린 quiz:3)", eqJson(buildToeicSpeakSession(small, polluted, { quizOrder: "weakness", max: 4, rng: makeRng(1) }).map((q) => q.key), w.map((q) => q.key)), "");
  add("기본 book은 교재 순서 그대로(앞 10개)", eqJson(buildToeicSpeakSession(set, speakSessions).map((q) => q.key), set.quiz.slice(0, 10).map((q) => `quiz:${q.no}`)), "");
  const entries = Array.from({ length: 15 }, (_x, i) => ({ expression: `expr ${i} ~`, meaningKo: `뜻 ${i}`, example: null, exampleKo: null, points: null }));
  const sess: ToeicQuizSessionLike[] = [{ id: "s", setId: "g", mode: "ko-to-expr", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, items: [{ word: "expr 3 ~", correct: false, answered: true }] }];
  const capped = buildToeicChoiceQuestions({ entries }, { modes: ["ko-to-expr", "expr-to-ko"], max: TOEIC_GUIDE_CHOICE_SESSION_MAX, sessions: sess, rng: makeRng(4) });
  add(
    `5지선다 max ${TOEIC_GUIDE_CHOICE_SESSION_MAX}: 20에서 자르고 그 모드 통계로 약한 것이 든다`,
    capped.questions.length === 20 && capped.questions.some((q) => q.mode === "ko-to-expr" && q.key === "expr 3 ~"),
    `${capped.questions.length}`,
  );
  const r1 = buildToeicChoiceQuestions({ entries }, { rng: makeRng(9) });
  const r2 = buildToeicChoiceQuestions({ entries }, { rng: makeRng(9) });
  add("max 없으면 지금과 같은 결과(결정적 rng — 같은 값)", eqJson(r1, r2) && r1.questions.length === 30, "");
  const alt = [
    { expression: "wrap up ~", meaningKo: "~을 마무리하다", example: null, exampleKo: null, points: null },
    { expression: "finish ~", meaningKo: "~을 마무리하다", example: null, exampleKo: null, points: null },
    { expression: "on the left", meaningKo: "왼쪽에", example: null, exampleKo: null, points: null },
    { expression: "on the right", meaningKo: "오른쪽에", example: null, exampleKo: null, points: null },
    { expression: "in short", meaningKo: "요컨대", example: null, exampleKo: null, points: null },
  ];
  let sameMeaningLeak = false;
  let variantAppears = false;
  for (let k = 0; k < 20; k++) {
    const qs = buildToeicChoiceQuestions({ entries: alt }, { modes: ["ko-to-expr", "expr-to-ko"], rng: makeRng(k + 1) }).questions;
    for (const q of qs) {
      if (q.key === "wrap up ~" && q.mode === "ko-to-expr" && q.choices.includes("finish ~")) sameMeaningLeak = true;
      if (q.key === "wrap up ~" && q.mode === "expr-to-ko" && q.choices.filter((c) => c === "~을 마무리하다").length > 1) sameMeaningLeak = true;
      if (q.key === "on the left" && q.choices.includes("on the right")) variantAppears = true;
    }
  }
  add("같은 뜻 대안(뜻 글자까지 같음)은 서로의 오답 보기로 나오지 않는다(두 모드)", !sameMeaningLeak, "");
  add("뜻이 다르게 적힌 조건 변형(왼쪽/오른쪽)은 서로 보기로 나온다", variantAppears, "");
  return results;
}

// ---------------------------------------------------------------------------
// 14. 세트 불변식 — 두 갈래 (§7-1·§12-10)
// ---------------------------------------------------------------------------

function runSetInvariantChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "세트 불변식");
  const bookFile = (quizN: number) => ({
    format: TOEIC_IMPORT_FORMAT,
    sets: [
      {
        presetKey: "book-inv-1",
        titleKo: "DAY 1 지어낸 세트",
        dayNo: 1,
        topicKo: "지어낸 주제",
        entries: [{ no: 1, expression: "hand out flyers", meaningKo: "전단지를 나눠 주다", example: null, exampleKo: null, partial: false, confidence: "high", points: null }],
        quiz: Array.from({ length: quizN }, (_x, i) => ({ no: i + 1, promptKo: "문장이에요.", hint: null, modelAnswer: "A sentence.", keyExpressions: [] })),
      },
    ],
  });
  add(`표현집 가져오기 quiz ${TOEIC_SET_QUIZ_MAX + 1}개 거부(${TOEIC_SET_QUIZ_MAX}개 통과)`, !toeicImportFileSchema.safeParse(bookFile(TOEIC_SET_QUIZ_MAX + 1)).success && toeicImportFileSchema.safeParse(bookFile(TOEIC_SET_QUIZ_MAX)).success, "");
  const g = (n: number) => variant((f) => (f.guides[0].speak = Array.from({ length: n }, (_x, i) => ({ no: i + 1, promptKo: "문장이에요.", hint: null, modelAnswer: "A sentence." }))));
  add(`공략 가져오기 speak ${TOEIC_GUIDE_SPEAK_MAX}개 통과·${TOEIC_GUIDE_SPEAK_MAX + 1}개 거부`, parseGuide(g(TOEIC_GUIDE_SPEAK_MAX)).success && !parseGuide(g(TOEIC_GUIDE_SPEAK_MAX + 1)).success, "");
  const route = readFileSync(new URL("../app/api/toeic/sets/route.ts", import.meta.url), "utf-8");
  add("표현집 저장 라우트 zod의 quiz 상한은 TOEIC_SET_QUIZ_MAX 그대로(소스 대조)", /TOEIC_SET_QUIZ_MAX/.test(route), "");
  return results;
}

// ---------------------------------------------------------------------------
// 15. 번들 경계·소스 대조 (§12-10)
// ---------------------------------------------------------------------------

function runtimeImports(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => /^\s*import\s+(?!type\b)/.test(l) || /^\s*}\s*from\s+["']/.test(l) || /^\s*import\s*\{$/.test(l))
    .map((l) => l);
}

/** 파일의 런타임 import 모듈 경로들(import type 제외, 여러 줄 import 포함) */
function runtimeImportPaths(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m[1]) continue; // import type
    const clause = m[2].trim();
    // import { type A, type B } — 전부 type이면 런타임 import가 아니다
    if (/^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}

function runBoundaryChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 번들 경계");
  void runtimeImports;
  const read = (f: string) => readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf-8");
  for (const f of ["toeic-guide.ts", "toeic-template.ts", "toeic-drill.ts", "toeic-attempt-rules.ts", "toeic-guide-contract.ts"]) {
    const src = read(f);
    const bad = runtimeImportPaths(src).filter((p) => /(\/ai\/|\/store|openai|zod)/.test(p));
    const lookbehind = /\(\?<[=!]/.test(src);
    add(`lib/${f}: lib/ai·store·openai·zod 값 import 없음 + lookbehind 없음`, bad.length === 0 && !lookbehind, bad.join(" / "));
  }
  const allow = (f: string, allowed: string[]) => {
    const got = runtimeImportPaths(read(f)).map((p) => p.replace(/^\.\//, ""));
    const extra = got.filter((p) => !allowed.includes(p));
    add(`lib/${f} 런타임 import 허용 목록(${allowed.join("·")})`, extra.length === 0, extra.join(","));
  };
  allow("toeic-template.ts", ["tts-shared", "tts-split", "toeic-guide", "toeic-text", "toeic-score", "toeic-quiz", "vocab-mastery", "kst"]);
  allow("toeic-guide.ts", ["tts-shared", "tts-split", "ja-coaching-script", "toeic-text"]);
  allow("toeic-drill.ts", ["toeic-mock"]);
  allow("toeic-attempt-rules.ts", ["toeic-mock", "toeic-drill"]);
  allow("toeic-guide-contract.ts", []);
  add(
    "순환 금지: lib/toeic-guide·lib/toeic-quiz는 lib/toeic-template을 import하지 않는다",
    !/toeic-template/.test(runtimeImportPaths(read("toeic-guide.ts")).join()) && !/toeic-template/.test(runtimeImportPaths(read("toeic-quiz.ts")).join()),
    "",
  );
  const mockSrc = readFileSync(new URL("../lib/ai/toeic/mock.ts", import.meta.url), "utf-8");
  add("pickExpressionsForDrill은 lib/ai/toeic/mock.ts에 있고 lib/toeic-drill.ts에는 없다", /export function pickExpressionsForDrill/.test(mockSrc) && !/(function|const)\s+pickExpressionsForDrill/.test(read("toeic-drill.ts")), "");
  // 모드 넓히기 — 세트 단위 화면·모의고사 라우트가 표현 시험 모드로 걸러 넘긴다(소스 대조)
  for (const f of ["app/toeic/sets/[id]/quiz/page.tsx", "app/toeic/sets/[id]/wrong/page.tsx", "app/toeic/sets/[id]/history/page.tsx", "app/api/toeic/mocks/route.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
    const calls = (src.match(/listToeicQuizzes\(|listAllToeicQuizzes\(/g) ?? []).length;
    const filtered = (src.match(/isToeicQuizModeSession/g) ?? []).length - 1; // import 한 줄 제외
    add(`${f}: 세션을 isToeicQuizModeSession(= isToeicQuizMode)으로 걸러 넘긴다`, calls > 0 && filtered >= calls, `읽기 ${calls} · 거르기 ${filtered}`);
  }
  // 스펙 공백 없이 상수가 한 곳에 — 번들 안전 모듈 목록
  add("TOEIC_GUIDE_PARTS = q3_4·q5_7·q8_10·q11(q1_2 없음)", eqJson([...TOEIC_GUIDE_PARTS], ["q3_4", "q5_7", "q8_10", "q11"]), "");
  return results;
}

// ---------------------------------------------------------------------------
// 16. 실제 가져오기 파일 (data/private — 개수만)
// ---------------------------------------------------------------------------

const REAL_GUIDE_FILE = new URL("../data/private/toeic-strategy/toeic-guides.json", import.meta.url);

function runRealGuideFileChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 실제 파일");
  if (!existsSync(REAL_GUIDE_FILE)) {
    results.push({ book: "공략 실제 파일", check: "가져오기 파일 검증", pass: true, skip: true, detail: "data/private/toeic-strategy/toeic-guides.json 없음 — 공개 저장소 기준 SKIP" });
    return results;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(REAL_GUIDE_FILE, "utf-8"));
  } catch {
    add("가져오기 파일이 JSON이다", false, "JSON 파싱 실패");
    return results;
  }
  const fmt = (raw as { format?: unknown }).format;
  if (fmt === "toeic-guides/v1") {
    // 초안 형식 — 변환 단계(Claude, §12-2-7)가 v2로 다시 만들기 전. 라우트는 400이다. 내용은 보지 않는다.
    results.push({ book: "공략 실제 파일", check: "가져오기 파일 검증", pass: true, skip: true, detail: "아직 toeic-guides/v1 초안 — v2 변환(틀 은행 포함) 전이라 SKIP(변환 뒤 zod 검사가 돈다)" });
    return results;
  }
  return checkRealGuideData(raw);
}

/**
 * 실제 가져오기 파일 데이터 검사(§12-10) — zod 통과(정렬 빠짐 0 포함)·개수·대본 불변식·변환 규칙 점검·틀 점검 알림. **개수·경로·규칙만**
 * 찍는다(내용 없음). 변환 단계가 파일을 쓰기 전에 같은 검사를 메모리에서 돌릴 수 있게 따로 export한다.
 */
export function checkRealGuideData(raw: unknown): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 실제 파일");
  const r = toeicGuideFileSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!r.success) {
    // 경로·규칙만(값 없음)
    add("zod 통과(정렬 빠짐 0 포함)", false, `${r.error.issues.length}곳 — ${r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`);
    return results;
  }
  const f = r.data;
  add("zod 통과(정렬 빠짐 0 포함)", true, "");
  add("유형 4개", f.guides.length === 4, `${f.guides.length}`);
  for (const g of f.guides) {
    const bytes = utf8ByteLength(JSON.stringify({ part: g.part, introKo: g.introKo, sections: g.sections, expressions: g.expressions, speak: g.speak }));
    add(`${g.part}: 섹션·표현·말하기 수·문서 바이트`, true, `섹션 ${g.sections.length} · 표현 ${g.expressions.length} · 말하기 ${g.speak.length} · ${bytes}B`);
    const script = buildToeicGuideScript(g, "all");
    const enOnly = buildToeicGuideScript(g, "english-only", { pause: true });
    add(`${g.part}: 읽기 대본 불변식(실데이터)`, pieceInvariants(script) && pieceInvariants(enOnly), `${script.length}조각`);
    // 변환 규칙 점검(각각 0)
    let badCompletion = 0;
    let listShouldBeCompletions = 0;
    let plusOrDash = 0;
    let latinParen = 0;
    for (const sec of g.sections) {
      for (const b of sec.blocks) {
        const lines = b.kind === "heading" ? [] : [...(b.kind === "lines" && b.lead ? [b.lead] : []), ...b.lines];
        for (const ln of lines) {
          if (ln.en && /[+–]/.test(ln.en)) plusOrDash++;
          if (ln.en && /[A-Za-z]\(/.test(ln.en)) latinParen++;
        }
        if (b.kind !== "lines") continue;
        if (b.style === "completions") badCompletion += b.lines.filter((ln) => !ln.en || !/^[a-z]/.test(ln.en)).length;
        if (b.style === "list" && b.lead?.en && !/[{}~]/.test(b.lead.en) && !/[.!?]$/.test(b.lead.en.trim()) && b.lines.length > 0 && b.lines.every((ln) => !!ln.en && /^[a-z]/.test(ln.en))) listShouldBeCompletions++;
      }
    }
    add(`${g.part}: 변환 규칙 — completions 줄 소문자 시작·이어 말하기 판정에 맞는 list 없음·영어 줄 + – 자리 없음·라틴에 붙은 여는 괄호 없음`, badCompletion + listShouldBeCompletions + plusOrDash + latinParen === 0, `${badCompletion}/${listShouldBeCompletions}/${plusOrDash}/${latinParen}`);
  }
  const bank = f.templates;
  if (bank === null) {
    add("틀 은행이 있다", false, "templates null");
    return results;
  }
  const bBytes = utf8ByteLength(JSON.stringify({ flows: bank.flows, items: bank.items }));
  const per = TOEIC_GUIDE_PARTS.map((p) => `${p} ${bank.items.filter((t) => t.parts.includes(p)).length}`).join(" · ");
  add(
    "틀 은행: 틀·예문·테스트 전용 채움·공통 틀·source별·바이트",
    true,
    `틀 ${bank.items.length} · 예문 ${bank.items.reduce((n, t) => n + t.examples.length, 0)} · testFills ${bank.items.reduce((n, t) => n + t.testFills.length, 0)} · 공통 ${bank.items.filter((t) => t.parts.length > 1).length} · guide ${bank.items.filter((t) => t.source === "guide").length}/new ${bank.items.filter((t) => t.source === "new").length} · ${bBytes}B · ${per}`,
  );
  for (const fl of bank.flows) {
    const inGroups = new Map<string, number>();
    for (const t of bank.items) if (t.parts.includes(fl.part)) inGroups.set(t.groupKo, (inGroups.get(t.groupKo) ?? 0) + 1);
    add(`${fl.part}: 단계·단계 안 묶음·소재 묶음·묶음당 최대 틀`, true, `${fl.steps.length}/${fl.steps.reduce((n, s) => n + s.groupsKo.length, 0)}/${fl.banksKo.length} · 최대 ${Math.max(0, ...inGroups.values())}`);
  }
  for (const g of f.guides) {
    const tg = toeicGuideAlignmentTargets(g);
    const parts: string[] = [];
    for (const kind of ["expression", "template", "lead"] as const) {
      const linked = new Set<string>();
      const skipped = new Set<string>();
      for (const t of bank.items) for (const r of t.guideRefs) if (r.part === g.part && r.kind === kind) linked.add(kind === "expression" ? (r as { expression: string }).expression.toLowerCase().replace(/\s+/g, " ").trim() : kind === "template" ? (r as { step: string }).step.trim() : (r as { leadEn: string }).leadEn.replace(/\s+/g, " ").trim());
      for (const s of bank.alignmentSkips) if (s.part === g.part && s.kind === kind) skipped.add(kind === "expression" ? s.ref.toLowerCase().replace(/\s+/g, " ").trim() : kind === "template" ? s.ref.trim() : s.ref.replace(/\s+/g, " ").trim());
      const keyOf = (x: string) => (kind === "expression" ? x.toLowerCase().replace(/\s+/g, " ").trim() : kind === "template" ? x.trim() : x.replace(/\s+/g, " ").trim());
      const l = tg[kind].filter((x) => linked.has(keyOf(x))).length;
      const sk = tg[kind].filter((x) => !linked.has(keyOf(x)) && skipped.has(keyOf(x))).length;
      const miss = tg[kind].length - l - sk;
      parts.push(`${kind} ${l}/${sk}/${miss}`);
    }
    add(`${g.part}: 정렬 연결/건너뜀/빠짐(빠짐 0 — zod가 막는다)`, parts.every((p) => p.endsWith("/0")), parts.join(" · "));
  }
  // 대본 불변식 — 템플릿 따라 말하기(실데이터)
  const shadow = buildTemplateShadowScript(bank.items);
  add("템플릿 따라 말하기 대본 불변식(실데이터)", pieceInvariants(shadow), `${shadow.length}조각`);
  // 틀 점검(개수만 — 실패로 두지 않고 알린다)
  const noTwoWordRun = bank.items.filter((t) => frameFixedWordRuns(t.frameEn).every((r) => r.length < 2)).length;
  const newButGuide = bank.items.filter((t) => t.source === "new" && t.parts.some((p) => f.guides.find((g) => g.part === p)?.expressions.some((e) => e.expression.toLowerCase() === frameToExpression(t.frameEn).toLowerCase()))).length;
  let koTwins = 0;
  for (const p of TOEIC_GUIDE_PARTS) {
    const ko = bank.items.filter((t) => t.parts.includes(p)).map((t) => t.frameKo.trim());
    koTwins += ko.length - new Set(ko).size;
  }
  let longGroups = 0;
  for (const fl of bank.flows) for (const grp of templateFlowOrder(bank, fl.part)) if (estimateShadowMs(buildTemplateShadowScript(grp.templates)) > 20 * 60 * 1000) longGroups++;
  let templateRefFirstChunkMissing = 0;
  for (const t of bank.items) {
    for (const r of t.guideRefs) {
      if (r.kind !== "template") continue;
      const g = f.guides.find((x) => x.part === r.part);
      const lineEn = g?.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "lines" && b.style === "template" ? b.lines : [])).find((ln) => ln.label?.trim() === r.step)?.en;
      if (!lineEn) continue;
      const firstChunk = lineEn.split(/\{[^{}]*\}/)[0].split("/")[0];
      const runs = frameFixedWordRuns(t.frameEn);
      const need = normalizeTemplateWords(firstChunk);
      if (need.length > 0 && !runs.some((run) => run.join(" ").includes(need.join(" ")))) templateRefFirstChunkMissing++;
    }
  }
  // 정렬 규칙 12 — 틀 전체가 교재 표현 하나인 틀(~ 형태가 그 유형 공략 표현과 같은 글자)의 한국어 틀 ↔ 교재 뜻풀이.
  // 자리·~와 바로 뒤 조사·어미(한글 두 글자까지)·공백·문장부호를 빼고 비교한다(근사 — 알림만).
  const koCore = (s: string) => s.replace(/(\{[^{}]*\}|[~～〜])[가-힣]{0,2}/g, "").replace(/[\s.,!?·…]/g, "");
  let rule12 = 0;
  let rule12Diff = 0;
  for (const t of bank.items) {
    for (const p of t.parts) {
      const e = f.guides.find((g) => g.part === p)?.expressions.find((x) => x.expression.toLowerCase().replace(/\s+/g, " ").trim() === frameToExpression(t.frameEn).toLowerCase());
      if (!e) continue;
      rule12++;
      if (koCore(t.frameKo) !== koCore(e.meaningKo)) rule12Diff++;
      break;
    }
  }
  results.push({
    book: "공략 실제 파일",
    check: "틀 점검(알림 — 실패로 두지 않는다)",
    pass: true,
    detail: `템플릿 줄 첫 고정 조각이 틀에 없음 ${templateRefFirstChunkMissing} · 두 낱말 고정 조각 없음 ${noTwoWordRun} · new인데 공략 표현과 같은 ~ 형태 ${newButGuide} · 같은 유형 한국어 틀 같은 쌍 ${koTwins} · 규칙 12 대상 ${rule12}틀 중 자리 조사·어미 밖에서 뜻풀이와 다름(근사) ${rule12Diff} · 20분 넘는 묶음 ${longGroups}`,
  });
  return results;
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export function runToeicGuideChecks(): GuideCheckResult[] {
  return [
    ...runGuideZodChecks(),
    ...runTemplateBankZodChecks(),
    ...runGuideLeakChecks(),
    ...runGuideUpsertChecks(),
    ...runGuideNormalizeChecks(),
    ...runGuideScriptChecks(),
    ...runTemplateFnChecks(),
    ...runShadowChecks(),
    ...runTemplateCompareChecks(),
    ...runTemplateFindChecks(),
    ...runTemplateTestChecks(),
    ...runDrillChecks(),
    ...runGuideQuizChecks(),
    ...runSetInvariantChecks(),
    ...runBoundaryChecks(),
    ...runRealGuideFileChecks(),
  ];
}

/**
 * scripts/eval-toeic-guides-app.ts — 유형별 공략 **앱 층**(S1: T6 앱 층·T7 읽기 탭·T10 틀 탭) 오프라인 검증 — scripts/eval-toeic.ts가 부른다.
 *
 * - 공략 화면 순수 함수(lib/toeic-guide-view): 기본 탭·열지 못한 틀·익힘·이어서 하기·범위 여섯·지금 위치·다음/이 예문 머리·대본 서명·
 *   이어 듣기 기억·설정 기억·예상 시간 표시·교재 틀 주소·goto 블록·블록 🧩 칩·표현 찾기·자리 색.
 * - Firestore 본문 모양(lib/toeic-firestore-codec): 틀 은행의 testFills(배열 속 배열)를 Firestore가 받지 못한다 — 인코딩 뒤 배열 속 배열 0,
 *   왕복 불변, 유형 공략·표현집 문서는 그대로. 실제 가져오기 파일이 있으면 그 파일로도 본다(**개수만** 찍는다).
 * - 소스 대조: 가져오기 라우트(400 본문 = toeicGuideImportInvalidBody·AI/키/prod-guard 없음·원문 로그 없음), 스토어 upsertToeicGuides
 *   (파일 mutate 안 판정 / Firestore runTransaction·tx.create·부분 갱신 필드), 목록 가리기(공략 계열을 먼저 빼고 skippedCount),
 *   모의고사 라우트의 표현집 세션만, 허브 카드, 페이지 force-dynamic, 화면 번들 경계(lib/ai·store 없음·stopSpeaking 없음·Media Session은
 *   따라 말하기 플레이어에서만), 탭 안 동기 잠금 해제 순서, 읽기 탭 틈 기본 끔, 목차 칩 → 섹션 머리 줄(scroll-margin-top을 가진 summary).
 *
 * 공개 저장소: 픽스처는 전부 **지어낸 영어·한국어**다. 실호출 0 · 스토어 인스턴스 0(이 모듈은 lib/store를 import하지 않는다).
 */

import { existsSync, readFileSync } from "node:fs";
import { toeicGuideFileSchema, type ToeicGuideSection, type ToeicTemplate, type ToeicTemplateFlow } from "../lib/ai/toeic/schemas";
import { decideGuideUpsert, planToeicGuideImport } from "../lib/ai/toeic/guide-import";
import { TOEIC_TEMPLATE_BANK_ID } from "../lib/toeic-guide";
import { decodeToeicGuideFromFirestore, encodeToeicGuideForFirestore, hasNestedArray } from "../lib/toeic-firestore-codec";
import {
  TOEIC_GUIDE_TABS,
  TOEIC_SHADOW_RANGES,
  TOEIC_SHADOW_RESUME_MAX,
  TOEIC_SHADOW_SETTINGS_DEFAULT,
  clearShadowResume,
  countMastered,
  findGuideExpressionIndex,
  findGuideGotoBlock,
  formatShadowDurationKo,
  guideGotoAddr,
  guideBlockTemplateKeys,
  guidePartShortKo,
  guideRefHref,
  guideReadInitialOpen,
  guideRefLabelKo,
  guideTemplatesForPart,
  nextShadowGroup,
  parseShadowSettings,
  readShadowResume,
  resolveGuideTab,
  shadowHeadIndex,
  shadowNextHeadIndex,
  shadowPositionAt,
  shadowPositionLabelKo,
  shadowRangeTemplates,
  shadowRangeTitleKo,
  shadowScriptSignature,
  slotToneMap,
  templateSwapMasteredKeys,
  writeShadowResume,
} from "../lib/toeic-guide-view";
import { buildTemplateShadowScript, shadowResumeIndex, templateFlowOrder, templateLinksForGuide } from "../lib/toeic-template";
import type { ToeicQuizSessionLike } from "../lib/toeic-quiz";
import { toeicZodErrorKo } from "../lib/toeic-zod-ko";
import type { GuideCheckResult } from "./eval-toeic-guides";

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");
/** 주석을 뺀 코드(머리 주석의 설명 문장이 "없어야 할 것" 검사에 걸리지 않게) */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 것
// ---------------------------------------------------------------------------

function tpl(key: string, groupKo: string, frameEn: string, frameKo: string, parts: string[], fills: string[][], refs: ToeicTemplate["guideRefs"] = []): ToeicTemplate {
  const fillFrame = (f: string[]) => {
    let i = 0;
    return frameEn.replace(/\{[^{}]*\}/g, () => f[i++] ?? "");
  };
  return {
    key,
    groupKo,
    frameEn,
    frameKo,
    useKo: "지어낸 쓰임 설명",
    parts: parts as ToeicTemplate["parts"],
    source: refs.length > 0 ? "guide" : "new",
    guideRefs: refs,
    examples: fills.map((f) => ({ en: fillFrame(f), ko: "지어낸 해석", fills: f })),
    testFills: [["a quiet lake"], ["a crowded bus stop"]].map((x) => x.slice(0, (frameEn.match(/\{/g) ?? []).length)),
  };
}

const T_OPEN = tpl("scene-set", "장면 열기", "The picture shows {장소}.", "사진은 {장소}를 보여 준다.", ["q3_4"], [["a garden"], ["a kitchen"], ["a harbor"]], [
  { kind: "expression", part: "q3_4", expression: "The picture shows ~" },
]);
const T_PEOPLE = tpl("two-are", "인물 동작", "Three workers are {동작}.", "세 일꾼이 {동작} 있다.", ["q3_4"], [["watering plants"], ["fixing a bicycle"], ["reading maps"]], [
  { kind: "lead", part: "q3_4", leadEn: "Three workers are" },
]);
const T_WHERE = tpl("next-to", "위치", "{사물} is next to {사물2}.", "{사물}은 {사물2} 옆에 있다.", ["q3_4"], [["A lamp", "the sofa"], ["A bin", "the desk"], ["A plant", "the door"]], [
  { kind: "template", part: "q3_4", step: "위치" },
]);
const T_FOOD = tpl("food-bank", "음식 소재", "I often cook {음식}.", "나는 자주 {음식}을 요리한다.", ["q3_4", "q11"], [["rice"], ["noodles"], ["salad"]]);

const FLOW_Q34: ToeicTemplateFlow = {
  part: "q3_4",
  steps: [
    { stepKo: "장면", groupsKo: ["장면 열기"] },
    { stepKo: "사람", groupsKo: ["인물 동작"] },
    { stepKo: "주변", groupsKo: ["위치"] },
  ],
  banksKo: ["음식 소재"],
};
const TEMPLATES = [T_OPEN, T_PEOPLE, T_WHERE, T_FOOD];
const GROUPS = templateFlowOrder({ flows: [FLOW_Q34], items: TEMPLATES }, "q3_4");

const SECTIONS: ToeicGuideSection[] = [
  { label: "공략 1", titleKo: "장면 열기", introKo: null, groupKo: null, blocks: [{ kind: "heading", textKo: "지어낸 제목" }] },
  {
    label: "공략 2",
    titleKo: "틀 모음",
    introKo: null,
    groupKo: null,
    blocks: [
      { kind: "lines", style: "list", captionKo: "목록", lead: null, lines: [{ label: null, en: "The picture shows {장소}.", ko: "사진은 ~를 보여 준다.", note: null, emphasis: [], underline: [], alt: false, marked: false, example: null }] },
      {
        kind: "lines",
        style: "template",
        captionKo: "답변 틀",
        lead: null,
        lines: [{ label: "위치", en: "{사물} is next to {사물2}.", ko: "~은 ~ 옆에 있다.", note: null, emphasis: [], underline: [], alt: false, marked: false, example: null }],
      },
      {
        kind: "lines",
        style: "completions",
        captionKo: "이어 말하기",
        lead: { label: null, en: "Three  workers are", ko: "세 일꾼이", note: null, emphasis: [], underline: [], alt: false, marked: false, example: null },
        lines: [{ label: null, en: "fixing a bicycle.", ko: "자전거를 고치고 있다.", note: null, emphasis: [], underline: [], alt: false, marked: false, example: null }],
      },
    ],
  },
];

function tplSession(mode: "tpl-recall" | "tpl-swap", startedAt: string, items: [string, boolean][]): ToeicQuizSessionLike {
  return { id: `${mode}-${startedAt}`, setId: TOEIC_TEMPLATE_BANK_ID, mode, startedAt, finishedAt: startedAt, items: items.map(([k, c]) => ({ word: `tpl:${k}`, correct: c, answered: true })) };
}

// ---------------------------------------------------------------------------
// 1. 공략 화면 순수 함수
// ---------------------------------------------------------------------------

function runViewFnChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 화면 순수 함수");

  // 기본 탭(§12-8)
  const S1 = ["read", "templates", "quiz"] as const;
  add("탭 순서 = 읽기·템플릿·표현 시험·한 문제 연습", eqJson([...TOEIC_GUIDE_TABS], ["read", "templates", "quiz", "drill"]));
  add("?tab 없음 + 틀 있음 → 템플릿 훈련", resolveGuideTab(null, 3, S1) === "templates");
  add("?tab 없음 + 틀 없음 → 공략 읽기", resolveGuideTab(null, 0, S1) === "read");
  add("?tab=read는 틀이 있어도 읽기", resolveGuideTab("read", 3, S1) === "read");
  add("아직 없는 탭(drill)·모르는 값 → 기본 탭", resolveGuideTab("drill", 3, S1) === "templates" && resolveGuideTab("x", 0, S1) === "read");

  // 열지 못한 틀
  const broken = [{ ...T_OPEN, key: "b1", frameKo: 7 }, { key: "b2" }, { ...T_FOOD, key: "b3", parts: ["q11"], examples: "x" }];
  const r = guideTemplatesForPart([...TEMPLATES, ...broken], "q3_4");
  add("guideTemplatesForPart: 그 유형 렌더 가능한 틀만(파일 순서)", eqJson(r.templates.map((t) => t.key), ["scene-set", "two-are", "next-to", "food-bank"]), r.templates.map((t) => t.key).join(","));
  add("guideTemplatesForPart: 깨진 틀 수 — 이 유형(parts 포함)·parts를 못 읽는 것만 센다", r.broken === 2, `broken=${r.broken}`);
  add("guideTemplatesForPart: 다른 유형 폴더(q11)는 공통 틀만", eqJson(guideTemplatesForPart(TEMPLATES, "q11").templates.map((t) => t.key), ["food-bank"]));

  // 익힘 = 틀 바꿔 말하기 졸업(다른 날 두 번 ○)
  const sessions = [
    tplSession("tpl-swap", "2026-09-20T01:00:00.000Z", [["scene-set", true], ["two-are", true]]),
    tplSession("tpl-swap", "2026-09-20T02:00:00.000Z", [["two-are", true]]), // 같은 날 — 접힌다
    tplSession("tpl-swap", "2026-09-21T01:00:00.000Z", [["scene-set", true]]),
    tplSession("tpl-recall", "2026-09-20T01:00:00.000Z", [["next-to", true]]),
    tplSession("tpl-recall", "2026-09-21T01:00:00.000Z", [["next-to", true]]),
  ];
  const mastered = templateSwapMasteredKeys(sessions);
  add("익힘: 다른 날 두 번 ○(swap) → 졸업", mastered.has("scene-set"));
  add("익힘: 같은 날 ○○는 졸업 아님(같은 날 ○ 접기)", !mastered.has("two-are"));
  add("익힘: 예문 말하기(recall) 졸업은 익힘에 들지 않는다", !mastered.has("next-to"));
  add("countMastered", countMastered(TEMPLATES, mastered) === 1);

  // 이어서 하기
  add("이어서 하기: 첫 미졸업 묶음", nextShadowGroup(GROUPS, new Set(["scene-set"]))?.groupKo === "인물 동작");
  add("이어서 하기: 흐름 순서 첫 묶음(아무것도 안 익힘)", nextShadowGroup(GROUPS, new Set())?.groupKo === "장면 열기");
  add("이어서 하기: 다 익히면 null", nextShadowGroup(GROUPS, new Set(TEMPLATES.map((t) => t.key))) === null);

  // 범위 여섯
  const keys = (ts: readonly ToeicTemplate[]) => ts.map((t) => t.key).join(",");
  const wrong = new Set(["next-to", "food-bank"]);
  add("범위 여섯 = group·step·from·template·wrong·all", eqJson([...TOEIC_SHADOW_RANGES], ["group", "step", "from", "template", "wrong", "all"]));
  add("범위 group", keys(shadowRangeTemplates(GROUPS, "group", { groupKo: "인물 동작", templateKey: null }, wrong)) === "two-are");
  add("범위 step(단계 묶음) = 그 단계의 묶음", keys(shadowRangeTemplates(GROUPS, "step", { groupKo: "위치", templateKey: null }, wrong)) === "next-to");
  add("범위 step(소재 묶음) = 소재 묶음 전체", keys(shadowRangeTemplates(GROUPS, "step", { groupKo: "음식 소재", templateKey: null }, wrong)) === "food-bank");
  add("범위 from = 고른 묶음부터 흐름 끝까지", keys(shadowRangeTemplates(GROUPS, "from", { groupKo: "인물 동작", templateKey: null }, wrong)) === "two-are,next-to,food-bank");
  add("범위 template = 그 틀 하나", keys(shadowRangeTemplates(GROUPS, "template", { groupKo: null, templateKey: "next-to" }, wrong)) === "next-to");
  add("범위 wrong = 틀린 틀(흐름 순서)", keys(shadowRangeTemplates(GROUPS, "wrong", { groupKo: null, templateKey: null }, wrong)) === "next-to,food-bank");
  add("범위 all = 유형 전체(흐름 순서)", keys(shadowRangeTemplates(GROUPS, "all", { groupKo: null, templateKey: null }, wrong)) === "scene-set,two-are,next-to,food-bank");
  add("고른 묶음이 없으면 group·step 빈 목록, from 전체", shadowRangeTemplates(GROUPS, "group", { groupKo: "없음", templateKey: null }, wrong).length === 0 && shadowRangeTemplates(GROUPS, "from", { groupKo: "없음", templateKey: null }, wrong).length === 4);
  const titles = TOEIC_SHADOW_RANGES.map((rg) => shadowRangeTitleKo(rg, GROUPS, { groupKo: "위치", templateKey: "next-to" }));
  add("범위 이름(잠금 화면 부제)은 분류 이름뿐 — 틀·예문 글자 없음", titles.every((t) => !/next to|lamp|sofa/i.test(t)), titles.join(" | "));

  // 대본 위치·다음 예문·이 예문 머리
  const script = buildTemplateShadowScript([T_OPEN, T_PEOPLE], { repeat: 4, intro: true });
  const firstKo = script.findIndex((p) => p.key === "scene-set" && p.example === 0);
  const en3 = script.findIndex((p) => p.key === "scene-set" && p.example === 1 && p.rep === 3);
  const pos0 = shadowPositionAt(script, 0)!;
  add("위치: 틀 소개 조각 → 틀 1/2 · 틀 소개", shadowPositionLabelKo(pos0) === "틀 1/2 · 틀 소개", shadowPositionLabelKo(pos0));
  add("위치: 예문 한국어 조각 → 예문 1/3 · 한국어", shadowPositionLabelKo(shadowPositionAt(script, firstKo)!) === "틀 1/2 · 예문 1/3 · 한국어");
  add("위치: 영어 반복 → 예문 2/3 · 영어 3/4", shadowPositionLabelKo(shadowPositionAt(script, en3)!) === "틀 1/2 · 예문 2/3 · 영어 3/4");
  add("위치: 범위 밖 → null", shadowPositionAt(script, script.length) === null && shadowPositionAt(script, -1) === null);
  const ex2Head = script.findIndex((p) => p.key === "scene-set" && p.example === 2);
  add("⏭ 다음 예문 머리(영어 반복 중 → 다음 예문의 한국어)", shadowNextHeadIndex(script, en3) === ex2Head, `${shadowNextHeadIndex(script, en3)} vs ${ex2Head}`);
  const lastOfFirst = script.map((p) => p.key).lastIndexOf("scene-set");
  const secondIntro = script.findIndex((p) => p.key === "two-are");
  add("⏭ 틀의 마지막 예문 → 다음 틀의 첫 조각(소개)", shadowNextHeadIndex(script, lastOfFirst) === secondIntro);
  add("⏭ 마지막 예문이면 -1", shadowNextHeadIndex(script, script.length - 1) === -1);
  add("⏮ 이 예문 머리 = shadowResumeIndex 그대로(다시 정의하지 않음)", shadowHeadIndex === shadowResumeIndex && shadowHeadIndex(script, en3) === script.findIndex((p) => p.key === "scene-set" && p.example === 1));

  // 대본 서명·이어 듣기 기억
  const sigA = shadowScriptSignature(script, "q3_4");
  add("서명: 같은 대본 → 같은 값", sigA === shadowScriptSignature(buildTemplateShadowScript([T_OPEN, T_PEOPLE], { repeat: 4, intro: true }), "q3_4"));
  add("서명: 틈 단계가 바뀌면 달라진다", sigA !== shadowScriptSignature(buildTemplateShadowScript([T_OPEN, T_PEOPLE], { repeat: 4, intro: true, pauseLevel: "long" }), "q3_4"));
  add("서명: 반복·소개가 바뀌면 달라진다", sigA !== shadowScriptSignature(buildTemplateShadowScript([T_OPEN, T_PEOPLE], { repeat: 3, intro: true }), "q3_4") && sigA !== shadowScriptSignature(buildTemplateShadowScript([T_OPEN, T_PEOPLE], { repeat: 4, intro: false }), "q3_4"));
  let store = writeShadowResume(null, sigA, 17);
  add("이어 듣기: 쓰고 읽기", readShadowResume(store, sigA) === 17);
  store = writeShadowResume(store, sigA, 21);
  add("이어 듣기: 같은 서명은 덮는다(한 칸)", readShadowResume(store, sigA) === 21 && (JSON.parse(store) as unknown[]).length === 1);
  let many: string | null = null;
  for (let i = 0; i < TOEIC_SHADOW_RESUME_MAX + 5; i++) many = writeShadowResume(many, `sig-${i}`, i);
  add("이어 듣기: 상한 — 오래된 것부터 버린다", (JSON.parse(many!) as unknown[]).length === TOEIC_SHADOW_RESUME_MAX && readShadowResume(many, "sig-0") === null && readShadowResume(many, `sig-${TOEIC_SHADOW_RESUME_MAX + 4}`) !== null);
  add("이어 듣기: 깨진 저장값·없는 서명 → null", readShadowResume("{oops", sigA) === null && readShadowResume(null, sigA) === null);
  add("이어 듣기: 끝까지 들으면 지운다", readShadowResume(clearShadowResume(store, sigA), sigA) === null);

  // 설정 기억
  add("설정: 없음 → 기본(반복 4·틈 켬 보통·한국어 소개 켬·영어 소개 끔)", eqJson(parseShadowSettings(null), { repeat: 4, pause: true, pauseLevel: "normal", intro: true, introEn: false }) && eqJson(TOEIC_SHADOW_SETTINGS_DEFAULT, parseShadowSettings(null)));
  add("설정: 깨진 칸은 기본값·반복은 1~4로", eqJson(parseShadowSettings(JSON.stringify({ repeat: 9, pause: "yes", pauseLevel: "loud", intro: false, introEn: true })), { repeat: 4, pause: true, pauseLevel: "normal", intro: false, introEn: true }));
  add("설정: JSON이 아니면 기본값", eqJson(parseShadowSettings("not json"), TOEIC_SHADOW_SETTINGS_DEFAULT));

  // 예상 시간 표시
  add("예상 시간: 0 → 약 1분 · 90분 → 약 1시간 30분 · 120분 → 약 2시간", formatShadowDurationKo(0) === "약 1분" && formatShadowDurationKo(90 * 60_000) === "약 1시간 30분" && formatShadowDurationKo(120 * 60_000) === "약 2시간");

  // 교재 틀 주소·이름
  const hrefE = guideRefHref({ kind: "expression", part: "q3_4", expression: "The picture shows ~" });
  const hrefT = guideRefHref({ kind: "template", part: "q11", step: "이유" });
  const hrefL = guideRefHref({ kind: "lead", part: "q3_4", leadEn: "Three workers are" });
  add("📘 expression → ③ 탭 ?expr=", new URL(hrefE, "http://x").searchParams.get("expr") === "The picture shows ~" && new URL(hrefE, "http://x").searchParams.get("tab") === "quiz");
  add("📘 template → 그 유형 ① 탭 ?goto=t:", new URL(hrefT, "http://x").pathname === "/toeic/guides/q11" && new URL(hrefT, "http://x").searchParams.get("goto") === "t:이유");
  add("📘 lead → ① 탭 ?goto=l:", new URL(hrefL, "http://x").searchParams.get("goto") === "l:Three workers are");
  add("📘 주소 경로 조각에 점 없음(PIN 게이트 정적 예외)", [hrefE, hrefT, hrefL].every((h) => !new URL(h, "http://x").pathname.includes(".")));
  add("📘 다른 유형 연결 이름엔 유형 표시", guideRefLabelKo({ kind: "template", part: "q11", step: "이유" }, "q3_4").startsWith("Q11 ") && !guideRefLabelKo({ kind: "template", part: "q3_4", step: "위치" }, "q3_4").startsWith("Q"));
  add("유형 짧은 표시", guidePartShortKo("q3_4") === "Q3–4" && guidePartShortKo("q11") === "Q11");

  // goto 블록·블록 칩·표현 찾기
  add("goto t:{label} → 템플릿 블록", eqJson(findGuideGotoBlock(SECTIONS, "t:위치"), { section: 1, block: 1 }));
  add("goto l:{머리말} → completions 블록(공백 정리)", eqJson(findGuideGotoBlock(SECTIONS, "l:Three workers are"), { section: 1, block: 2 }));
  add("goto 모르는 값 → null", findGuideGotoBlock(SECTIONS, "t:없음") === null && findGuideGotoBlock(SECTIONS, "zz") === null && findGuideGotoBlock(SECTIONS, null) === null);
  // 첫 렌더 섹션 열림(QA final P2-1 — goto 목표 섹션은 첫 렌더부터 열려야 마운트 직후 스크롤이 닫힌 details를 만나지 않는다)
  add("goto 주소: 블록 → b:{섹션}:{블록} · 없음 → null", guideGotoAddr({ section: 1, block: 2 }) === "b:1:2" && guideGotoAddr(null) === null);
  add("첫 열림: goto 없음 → 첫 섹션만", eqJson(guideReadInitialOpen(SECTIONS, null), [0]) && eqJson(guideReadInitialOpen(SECTIONS, "t:없음"), [0]));
  add("첫 열림: 첫 섹션 밖 goto → 첫 섹션 + 목표 섹션", eqJson(guideReadInitialOpen(SECTIONS, "t:위치"), [0, 1]) && eqJson(guideReadInitialOpen(SECTIONS, "l:Three workers are"), [0, 1]));
  const SECTIONS_GOTO_FIRST: ToeicGuideSection[] = [SECTIONS[1], SECTIONS[0]];
  add("첫 열림: 목표가 첫 섹션이면 중복 없이 [0]", eqJson(guideReadInitialOpen(SECTIONS_GOTO_FIRST, "t:위치"), [0]));
  add("첫 열림: 섹션 없음 → 빈 목록", eqJson(guideReadInitialOpen([], "t:위치"), []));
  const links = templateLinksForGuide({ items: TEMPLATES }, "q3_4");
  const blocks = SECTIONS[1].blocks;
  add("블록 🧩: 템플릿 블록 → label이 연결된 틀", eqJson(guideBlockTemplateKeys(links, blocks[1]), ["next-to"]));
  add("블록 🧩: completions 블록 → 머리말이 연결된 틀", eqJson(guideBlockTemplateKeys(links, blocks[2]), ["two-are"]));
  add("블록 🧩: list 블록·heading은 블록 칩 없음(줄 칩)", guideBlockTemplateKeys(links, blocks[0]).length === 0 && guideBlockTemplateKeys(links, SECTIONS[0].blocks[0]).length === 0);
  add("③ ?expr= 표현 찾기 — 대소문자·공백 무시", findGuideExpressionIndex([{ expression: "a b" }, { expression: "The  Picture shows ~" }], "the picture shows ~") === 1 && findGuideExpressionIndex([], "x") === -1);

  // 자리 색
  const tones = slotToneMap(["가", "나", "다", "라", "마"]);
  add("자리 색: 순서마다 0~3, 다섯째는 다시 0", eqJson([...tones.values()], [0, 1, 2, 3, 0]));
  return results;
}

// ---------------------------------------------------------------------------
// 2. Firestore 본문 모양 — 배열 속 배열 금지
// ---------------------------------------------------------------------------

function runCodecChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 Firestore 본문");
  const bankGuide = { kind: "templates", flows: [FLOW_Q34], items: TEMPLATES, contentHash: "h", updatedAt: "2026-09-27T00:00:00.000Z" };
  const enc = encodeToeicGuideForFirestore(bankGuide);
  add("틀 은행 원본에는 배열 속 배열이 있다(testFills — Firestore가 거부하는 모양)", hasNestedArray(bankGuide));
  add("인코딩 뒤 배열 속 배열 0", !hasNestedArray(enc));
  add("왕복 불변(인코딩 → 디코딩 = 원본)", eqJson(decodeToeicGuideFromFirestore(enc), bankGuide));
  add("인코딩은 멱등(두 번 해도 같다)", eqJson(encodeToeicGuideForFirestore(enc), enc));
  const partGuide = { kind: "part", part: "q3_4", introKo: null, sections: SECTIONS, contentHash: "h", updatedAt: "x" };
  add("유형 공략·표현집(null)은 그대로(같은 참조)", encodeToeicGuideForFirestore(partGuide) === partGuide && encodeToeicGuideForFirestore(null) === null && decodeToeicGuideFromFirestore(null) === null);
  add("유형 공략 문서엔 원래 배열 속 배열이 없다", !hasNestedArray(partGuide));
  const legacy = decodeToeicGuideFromFirestore(bankGuide) as { items: ToeicTemplate[] };
  add("디코딩: 이미 배열인 원소(파일에서 옮긴 문서)는 그대로", eqJson(legacy.items.map((t) => t.testFills), TEMPLATES.map((t) => t.testFills)));
  const odd = decodeToeicGuideFromFirestore({ kind: "templates", items: [{ key: "x", testFills: [{ nope: 1 }, "s"] }, "junk"] }) as { items: unknown[] };
  add("디코딩: 모르는 모양은 던지지 않고 그대로(렌더 판정이 그 틀만 뺀다)", eqJson(odd.items, [{ key: "x", testFills: [{ nope: 1 }, "s"] }, "junk"]));

  // 실제 가져오기 파일 — 있으면 계획 → 판정(빈 저장소) → 쓸 레코드의 guide를 인코딩해 배열 속 배열 0·왕복 불변. 개수만 찍는다.
  const real = new URL("../data/private/toeic-strategy/toeic-guides.json", import.meta.url);
  if (!existsSync(real)) {
    results.push({ book: "공략 Firestore 본문", check: "실제 가져오기 파일 — 인코딩 뒤 배열 속 배열 0", pass: true, detail: "파일 없음(공개 저장소·CI)", skip: true });
    return results;
  }
  const parsed = toeicGuideFileSchema.safeParse(JSON.parse(readFileSync(real, "utf-8")), { error: toeicZodErrorKo });
  if (!parsed.success) {
    add("실제 가져오기 파일 zod 통과(인코딩 검사의 전제)", false, `문제 ${parsed.error.issues.length}곳`);
    return results;
  }
  const decision = decideGuideUpsert(planToeicGuideImport(parsed.data), [], "2026-09-27T00:00:00.000Z");
  if (!decision.ok) {
    add("실제 파일: 빈 저장소 판정이 전부 created", false, `충돌 ${decision.conflicts.length}`);
    return results;
  }
  const guides = decision.writes.map((w) => w.record.guide);
  const nestedBefore = guides.filter((g) => hasNestedArray(g)).length;
  const encoded = guides.map((g) => encodeToeicGuideForFirestore(g));
  const nestedAfter = encoded.filter((g) => hasNestedArray(g)).length;
  const roundTrip = encoded.every((g, i) => eqJson(decodeToeicGuideFromFirestore(g), guides[i]));
  add("실제 파일: 쓸 문서 전부 인코딩 뒤 배열 속 배열 0", nestedAfter === 0, `문서 ${guides.length} · 인코딩 전 ${nestedBefore} → 후 ${nestedAfter}`);
  add("실제 파일: 왕복 불변", roundTrip, `문서 ${guides.length}`);
  return results;
}

// ---------------------------------------------------------------------------
// 3. 소스 대조 — 라우트·스토어·목록·페이지·화면 번들 경계
// ---------------------------------------------------------------------------

/** 파일의 런타임 import 모듈 경로들(import type·전부 type인 named import 제외, 여러 줄 import 포함) */
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

/** 모든 import(type 포함) 경로 */
function allImportPaths(src: string): string[] {
  return [...src.matchAll(/^(?:import|export)\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** 메서드 본문(대략 — 다음 `  async ` 메서드 전까지) */
function methodBody(src: string, name: string): string {
  const at = src.indexOf(`async ${name}(`);
  if (at < 0) return "";
  const next = src.indexOf("\n  async ", at + 10);
  return src.slice(at, next < 0 ? undefined : next);
}

function runSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 앱 소스 대조");

  // 가져오기 라우트
  const route = read("app/api/toeic/guides/import/route.ts");
  add("가져오기 라우트: runtime nodejs", /export const runtime = "nodejs"/.test(route));
  add("가져오기 라우트: toeicGuideFileSchema.safeParse(raw, { error: toeicZodErrorKo })", /toeicGuideFileSchema\.safeParse\(raw, \{ error: toeicZodErrorKo \}\)/.test(route));
  add("가져오기 라우트: 400 본문 = toeicGuideImportInvalidBody 그대로", /json\(toeicGuideImportInvalidBody\(parsed\.error\.issues\), 400\)/.test(route));
  add("가져오기 라우트: planToeicGuideImport → store.upsertToeicGuides(items, nowIso)", /planToeicGuideImport\(parsed\.data\)/.test(route) && /upsertToeicGuides\(items, nowIso\)/.test(route));
  add("가져오기 라우트: 409 guide_conflict · 500 save_failed", /error: "guide_conflict"/.test(route) && /\b409,?\s*\)/.test(route) && /error: "save_failed"/.test(route));
  add("가져오기 라우트: AI·키 검사·prod-guard 없음", !/OPENAI_API_KEY|lib\/ai\/client|assertDestructiveAllowed|prod-guard/.test(codeOnly(route)));
  add("가져오기 라우트: 본문·파싱 결과·issues를 로그에 찍지 않는다", !/console\.[a-z]+\([^;]*(raw|parsed\.data|parsed\.error\.issues\)|JSON\.stringify)/.test(route));

  // 스토어
  const store = read("lib/store.ts");
  const fileBody = methodBody(store, "upsertToeicGuides");
  add("스토어 인터페이스: upsertToeicGuides(items, nowIso)", /upsertToeicGuides\(items: readonly ToeicGuideImportItem\[\], nowIso: string\): Promise<ToeicGuideUpsertDecision>;/.test(store));
  add("파일 백엔드: 판정(decideGuideUpsert)이 mutate **안에서**", /return this\.mutate\(\(db\) => \{[\s\S]*decideGuideUpsert\(items, existing, nowIso\)/.test(fileBody));
  add("파일 백엔드: 충돌이면 쓰기 전에 돌려준다", /if \(!decision\.ok\) return decision;/.test(fileBody) && fileBody.indexOf("if (!decision.ok) return decision;") < fileBody.indexOf("db.toeicSets.push"));
  const fs = read("lib/store-firestore.ts");
  const fsBody = methodBody(fs, "upsertToeicGuides");
  add("Firestore: runTransaction 안에서 모두 읽은 뒤 판정", /runTransaction\(/.test(fsBody) && fsBody.indexOf("tx.get(") < fsBody.indexOf("decideGuideUpsert(") && !/tx\.get\(/.test(fsBody.slice(fsBody.indexOf("decideGuideUpsert("))));
  add("Firestore: presetKey를 30개씩 in으로 읽는다", /where\("presetKey", "in", keys\.slice\(i, i \+ 30\)\)/.test(fsBody));
  add("Firestore: 새 문서는 tx.create, 고침은 TOEIC_GUIDE_UPDATE_FIELDS만 tx.update", /tx\.create\(ref, data\)/.test(fsBody) && /for \(const f of TOEIC_GUIDE_UPDATE_FIELDS\)/.test(fsBody) && /tx\.update\(ref, patch\)/.test(fsBody));
  add("Firestore: 세트 쓰기 본문은 guide를 인코딩(배열 속 배열 금지), 읽기는 디코딩", /encodeToeicGuideForFirestore\(data\.guide\)/.test(fs) && /decodeToeicGuideFromFirestore\(d\.guide \?\? null\)/.test(fs));
  add("Firestore: 가져오기는 prod-guard 없음(생성·수정)", !/assertDestructiveAllowed/.test(fsBody));

  // 목록 가리기 — 공략 계열을 먼저 빼고 skippedCount
  const setsPage = read("app/toeic/sets/page.tsx");
  const iGuide = setsPage.indexOf("isToeicGuideSet(s)");
  const iRender = setsPage.indexOf(".filter(isRenderableToeicSet)");
  const iSkip = setsPage.indexOf("skippedCount = stored.length - records.length");
  add("표현집 목록: 공략 계열을 먼저 빼고 → 렌더 판정 → skippedCount", iGuide > 0 && iGuide < iRender && iRender < iSkip, `${iGuide} < ${iRender} < ${iSkip}`);
  const mocksPage = read("app/toeic/mocks/page.tsx");
  add("모의고사 목록: 주제 칩·표현 수에서 공략 계열을 뺀다", /sets\.filter\(\(s\) => !isToeicGuideSet\(s\)\)\.filter\(isRenderableToeicSet\)/.test(mocksPage));
  const mocksRoute = read("app/api/toeic/mocks/route.ts");
  add(
    "모의고사 만들기: 활용할 표현 = 표현집 세트 + 표현집 세트의 시험 세션만(공략 세션 무오염)",
    /!isToeicGuideSet\(s\)/.test(mocksRoute) && /bookSetIds\.has\(q\.setId\)/.test(mocksRoute) && /pickExpressionsForMock\(bookSets, bookSessions\)/.test(mocksRoute),
  );

  // 허브·페이지
  const hub = read("app/toeic/page.tsx");
  add("허브: 세 번째 카드 🧭 유형별 공략 → /toeic/guides (sm:col-span-2)", /href="\/toeic\/guides"[^>]*sm:col-span-2/.test(hub) && /토익스피킹 유형별 공략/.test(hub));
  for (const f of ["app/toeic/guides/page.tsx", "app/toeic/guides/[part]/page.tsx"]) {
    const src = read(f);
    add(`${f}: force-dynamic`, /export const dynamic = "force-dynamic"/.test(src));
  }
  add("폴더 페이지: 네 유형 밖이면 404", /if \(!isToeicGuidePart\(part\)\) notFound\(\)/.test(read("app/toeic/guides/[part]/page.tsx")));

  // 화면 번들 경계
  const clientFiles = [
    "components/toeic-guide-folder-view.tsx",
    "components/toeic-guide-read-view.tsx",
    "components/toeic-template-view.tsx",
    "components/toeic-guide-expr-list.tsx",
    "components/toeic-guide-import-button.tsx",
    "components/use-toeic-shadow-settings.ts",
  ];
  for (const f of clientFiles) {
    const src = read(f);
    const bad = allImportPaths(src).filter((p) => /(lib\/ai|\/store|openai|zod)/.test(p));
    add(`${f}: "use client" · lib/ai·store·openai·zod import 없음 · stopSpeaking 없음`, /^"use client";/.test(src) && bad.length === 0 && !/stopSpeaking/.test(codeOnly(src)), bad.join(","));
  }
  const mediaUsers = clientFiles.filter((f) => /bindMediaSession/.test(read(f)));
  add("잠금 화면 조작(Media Session)은 따라 말하기 플레이어에서만", eqJson(mediaUsers, ["components/toeic-template-view.tsx"]), mediaUsers.join(","));
  const tv = read("components/toeic-template-view.tsx");
  const sw = tv.slice(tv.indexOf("function startWith("));
  add("따라 말하기 ▶: 탭 안에서 unlockSpeechPlayback() → prepareSpeech(준비) → 큐", sw.indexOf("unlockSpeechPlayback()") > 0 && sw.indexOf("unlockSpeechPlayback()") < sw.indexOf("prepareSpeech(") && /playQueue\(run, from\)/.test(sw));
  add("따라 말하기: 쉼 칸(pauseAfterMs)을 큐에 넘긴다", /pauseAfterMs: p\.pauseAfterMs/.test(tv));
  add("따라 말하기: Wake Lock(준비·재생 동안)", /useToeicWakeLock\(phase === "preparing" \|\| phase === "playing"\)/.test(tv));
  const rv = read("components/toeic-guide-read-view.tsx");
  add("읽기 탭: \"영어만\" 따라 말할 틈 기본 끔", /const \[pauseOn, setPauseOn\] = useState\(false\)/.test(rv) && /pause: mode === "english-only" && pauseOn/.test(rv));
  add("읽기 탭: 예문 🔊도 대본과 같은 정리 함수(cleanGuideEnForTts)", /splitForTts\(cleanGuideEnForTts\(en\), TTS_TEXT_MAX_CHARS\)/.test(rv));
  // ?goto= 스크롤은 섹션 열림 커밋 뒤에만(QA final P2-1 — 옛 "openSection → rAF 스크롤"은 rAF가 커밋보다 먼저 돌면 닫힌 details 안에서 조용히 실패)
  const rvCode = codeOnly(rv);
  const gotoAt = rvCode.indexOf("const gotoHit = useMemo(");
  const gotoSeg = gotoAt < 0 ? "" : rvCode.slice(gotoAt, rvCode.indexOf("function jumpToSection(", gotoAt));
  const scrollFn = gotoSeg.slice(gotoSeg.indexOf("const scrollPendingGoto = useCallback("), gotoSeg.indexOf("useEffect(", gotoSeg.indexOf("const scrollPendingGoto = useCallback(")));
  // 2026-10-02(§12-13-1): 판정 marks를 넘긴다 — `k:{틀 key}` 목표 섹션도 첫 렌더부터 연다(marks 없으면 t:·l:만)
  add(
    "읽기 탭 goto: 섹션 첫 열림 = guideReadInitialOpen(sections, goto, marks)(첫 렌더·서버 HTML부터 목표 섹션 열림 — k: 포함)",
    /useState<Set<number>>\(\(\) => new Set\(guideReadInitialOpen\(sections, goto, marks\)\)\)/.test(rvCode) && /findGuideGotoBlock\(sections, goto, marks\)/.test(rvCode),
  );
  add("읽기 탭 goto: 스크롤 경로에 requestAnimationFrame 없음(커밋 전 rAF 경합 금지)", gotoSeg.length > 0 && !/requestAnimationFrame/.test(gotoSeg));
  add(
    "읽기 탭 goto: 스크롤은 그 블록의 closest(\"details\")가 열렸을 때만(아니면 남겨 둔다) → scrollIntoView({ block: \"start\" }) 뒤 ref 비움",
    /const details = el\.closest\("details"\);/.test(scrollFn) &&
      /if \(details && !details\.open\) return;/.test(scrollFn) &&
      scrollFn.indexOf("!details.open") < scrollFn.indexOf("scrollIntoView(") &&
      /pendingGotoRef\.current = null;\s*el\.scrollIntoView\(\{ block: "start" \}\);/.test(scrollFn),
  );
  add("읽기 탭 goto: 열림 커밋 뒤 layout 효과가 남은 목표를 다시 본다([open, flash])", /useLayoutEffect\(\(\) => \{\s*scrollPendingGoto\(\);\s*\}, \[open, flash, scrollPendingGoto\]\);/.test(gotoSeg));
  add(
    "읽기 탭 goto: 효과는 목표를 ref에 남기고 섹션을 연 뒤 스크롤을 시도 · 키는 블록 주소(sections 새 참조로 다시 돌지 않는다)",
    /pendingGotoRef\.current = gotoAddr;\s*openSection\(gotoSection\);\s*setFlash\(gotoAddr\);\s*scrollPendingGoto\(\);/.test(gotoSeg) &&
      /\}, \[gotoAddr, gotoSection, openSection, scrollPendingGoto\]\);/.test(gotoSeg) &&
      /const gotoAddr = guideGotoAddr\(gotoHit\);/.test(gotoSeg),
  );
  // 목차 칩 → 섹션 머리 줄(QA final P3-N1) — scroll-margin-top은 summary(.sectionHead)에만 있다. <details>로 스크롤하면 머리 줄이 덮개 밑
  const jumpAt = rvCode.indexOf("function jumpToSection(");
  const jumpFn = jumpAt < 0 ? "" : rvCode.slice(jumpAt, rvCode.indexOf("\n  }\n", jumpAt));
  const readCss = read("components/toeic-guide-read-view.module.css");
  const headRule = /^\.sectionHead \{([^}]*)\}/m.exec(readCss)?.[1] ?? "";
  add(
    "읽기 탭 목차 칩: 섹션 머리 summary[data-addr=\"s:{i}\"]로 scrollIntoView({ block: \"start\" }) · .sectionHead에 scroll-margin-top(스트릭 + 듣기 바 + 8px)",
    /querySelector<HTMLElement>\(`summary\[data-addr="s:\$\{i\}"\]`\)\?\.scrollIntoView\(\{ block: "start" \}\)/.test(jumpFn) &&
      !/data-sec/.test(jumpFn) &&
      /const titleA = `s:\$\{si\}`;/.test(rvCode) &&
      /<summary data-addr=\{titleA\} className=\{`\$\{s\.sectionHead\}/.test(rvCode) &&
      /scroll-margin-top: calc\(var\(--streak-h, 0px\) \+ var\(--guide-bar-h, 96px\) \+ 8px\);/.test(headRule),
  );
  const ex = read("components/toeic-guide-expr-list.tsx");
  add("③ 표현 🔊·프리페치는 trim만(표현집·시험 러너와 같은 캐시 키 — 공략 정리 함수 안 씀)", /speak\(e\.expression\.trim\(\), "en-US"\)/.test(ex) && !/cleanGuideEnForTts/.test(ex));

  // 새 클라이언트 안전 모듈
  for (const [f, allowed] of [
    ["lib/toeic-guide-view.ts", ["./toeic-guide", "./toeic-template", "./toeic-record", "./toeic-text", "./vocab-mastery"]],
    ["lib/toeic-firestore-codec.ts", []],
  ] as const) {
    const src = read(f);
    const paths = runtimeImportPaths(src);
    const extra = paths.filter((p) => !(allowed as readonly string[]).includes(p));
    add(`${f}: 런타임 import 허용 목록 · lookbehind 없음`, extra.length === 0 && !/\(\?<[=!]/.test(src), extra.join(","));
  }
  return results;
}

export function runToeicGuideAppChecks(): GuideCheckResult[] {
  return [...runViewFnChecks(), ...runCodecChecks(), ...runSourceChecks()];
}

/**
 * scripts/eval-toeic-frame-drill.ts — 토익 유형별 공략 **소재별 틀 말하기**(docs/harness/toeic.md §20 — 2026-10-03) 오프라인 검증.
 * scripts/eval-toeic.ts가 `runToeicFrameDrillChecks()`로 부른다(오프라인 — 네트워크 0). 실호출은 `runFrameDrillLiveChecks()`이고
 * eval-toeic.ts의 게이트(EVAL_TOEIC=1) 안에서 EVAL_TOEIC_FRAME=1일 때만 돈다 — 에이전트는 실행하지 않는다.
 *
 * 영역(§20-12): spec-sync(원문 6 · JSON Schema 2 · 호출 옵션 2 · enum) · 사용자 메시지 · zod 반례(E·F·가져오기) · 순수 함수(출제·통계·
 * 보충·계획·합치기·잡기·가져오기 병합·말 끝 상태 기계·판정 합치기·AI 0 총평) · 스트릭 · 번들 경계 · calls.ts 소스 대조.
 *
 * 공개 저장소: 픽스처의 틀·문장은 전부 **지어낸 것**이다(교재·틀 원본·강의 자막 문장을 옮기지 않는다).
 */

import { readFileSync } from "node:fs";
import type { z } from "zod";
import { checkSpecSync, extractSpecBlocks, type SpecSyncTarget } from "./spec-sync";
import {
  TOEIC_FRAME_DRILL_COUNT_DEFAULT,
  TOEIC_FRAME_DRILL_COUNT_MAX,
  TOEIC_FRAME_DRILL_ITEMS_MAX,
  TOEIC_FRAME_DRILL_MAX_ANSWER_MS,
  TOEIC_FRAME_DRILL_NO_SPEECH_KO,
  TOEIC_FRAME_DRILL_SILENCE_END_MS,
  TOEIC_FRAME_DRILL_START_WAIT_MS,
  TOEIC_FRAME_DRILL_SUPPLY_STALE_MS,
  TOEIC_FRAME_DRILL_VERDICTS,
  TOEIC_FRAME_DRILL_VOICE_MIN_MS,
  TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL,
  TOEIC_FRAME_DRILL_VOICE_ON_LEVEL,
  acceptFrameDrillSupply,
  applyFrameDrillStats,
  buildFrameDrillOrder,
  clampFrameDrillCount,
  decideFrameDrillJudge,
  decideFrameDrillStatsApply,
  decideFrameDrillSupply,
  decideFrameDrillSupplyClaim,
  frameDrillAiItemId,
  frameDrillFrameText,
  frameDrillJudgeTargets,
  frameDrillNoAiReview,
  frameDrillOutcomeOf,
  frameDrillQuestionTypesForPart,
  frameDrillScopeFrameKeys,
  frameDrillScopeItems,
  frameDrillSessionCounts,
  frameDrillSupplyCount,
  frameDrillTopicsForPart,
  frameDrillWeight,
  initialFrameDrillVoice,
  mergeFrameDrillImport,
  mergeFrameDrillVerdicts,
  planFrameDrillSupply,
  seededRng,
  stepFrameDrillVoice,
  toFrameDrillSessionItem,
  type ToeicFrameDrillBank,
  type ToeicFrameDrillFile,
  type ToeicFrameDrillItem,
  type ToeicFrameDrillSessionItem,
  type ToeicFrameDrillStat,
  type ToeicFrameDrillVoiceState,
} from "../lib/toeic-frame-drill";
import {
  TOEIC_FRAME_JUDGE_CALL_OPTIONS,
  TOEIC_FRAME_JUDGE_ITEM_TEMPLATE,
  TOEIC_FRAME_JUDGE_SYSTEM_PROMPT,
  TOEIC_FRAME_JUDGE_USER_TEMPLATE,
  TOEIC_FRAME_SUPPLY_CALL_OPTIONS,
  TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE,
  TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT,
  TOEIC_FRAME_SUPPLY_USER_TEMPLATE,
  buildFrameJudgeUserMessage,
  buildFrameSupplyUserMessage,
  type ToeicFrameJudgeInput,
} from "../lib/ai/toeic/frame-drill-prompts";
import {
  TOEIC_FRAME_JUDGE_JSON_SCHEMA,
  TOEIC_FRAME_SUPPLY_JSON_SCHEMA,
  buildFrameJudgeZod,
  buildFrameSupplyZod,
  toeicFrameDrillFileSchema,
  toeicFrameDrillImportInvalidBody,
} from "../lib/ai/toeic/frame-drill-schemas";
import { toeicFrameDrillStreakLabel, toeicStreakSessions } from "../lib/toeic-streak";

export interface FrameDrillCheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
  skip?: boolean;
}

const SPEC_URL = new URL("../docs/harness/toeic.md", import.meta.url);
const SRC = "lib/ai/toeic/frame-drill-prompts.ts";
const AT = "2026-10-03T00:00:00.000Z";

function adder(results: FrameDrillCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}

const ok = (schema: z.ZodType<unknown>, v: unknown) => schema.safeParse(v).success;
const bad = (schema: z.ZodType<unknown>, v: unknown) => !schema.safeParse(v).success;

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 것
// ---------------------------------------------------------------------------

function fixtureFile(): ToeicFrameDrillFile {
  return {
    format: "toeic-frame-drill/v1",
    presetKey: "eval-frame-drill",
    topics: [
      { key: "tech", nameKo: "기술 소재" },
      { key: "work", nameKo: "직장 소재" },
      { key: "money", nameKo: "돈 소재" },
    ],
    questionTypes: [
      { key: "where", nameKo: "어디서" },
      { key: "why", nameKo: "왜" },
    ],
    frames: [
      { key: "saves-me-from", topicKey: "tech", frameEn: "{도구} saves me from {수고}.", frameKo: "{도구} 덕분에 저는 {수고}을 안 해도 돼요.", useKo: "기술의 장점을 말할 때", parts: ["q5_7", "q11"], bankKey: null, sources: ["new"], questionTypes: ["why"], fillOptions: [{ slot: "도구", en: "A smart speaker", ko: "스마트 스피커" }, { slot: "수고", en: "typing long messages", ko: "긴 메시지 입력" }] },
      { key: "lets-me-focus", topicKey: "work", frameEn: "When {조건}, I can focus more on {일}.", frameKo: "{조건} 저는 {일}에 더 집중할 수 있어요.", useKo: null, parts: ["q11"], bankKey: "lets-me-focus", sources: ["bank", "audio:PB99"], questionTypes: [], fillOptions: [] },
      { key: "costs-less", topicKey: "money", frameEn: "It costs less to {행동}.", frameKo: "{행동} 돈이 덜 들어요.", useKo: null, parts: ["q5_7"], bankKey: null, sources: ["drill"], questionTypes: ["where", "why"], fillOptions: [] },
    ],
    items: [
      { id: "saves-me-from-s1", frameKey: "saves-me-from", ko: "음성 비서 덕분에 저는 알람을 일일이 맞추지 않아도 돼요.", fills: ["A voice assistant", "setting every alarm by hand"], en: "A voice assistant saves me from setting every alarm by hand." },
      { id: "saves-me-from-s2", frameKey: "saves-me-from", ko: "식기세척기 덕분에 저는 저녁마다 설거지를 안 해도 돼요.", fills: ["A dishwasher", "washing dishes every night"], en: "A dishwasher saves me from washing dishes every night." },
      { id: "lets-me-focus-s1", frameKey: "lets-me-focus", ko: "회의가 짧으면 저는 제 일에 더 집중할 수 있어요.", fills: ["meetings are short", "my own work"], en: "When meetings are short, I can focus more on my own work." },
      { id: "costs-less-s1", frameKey: "costs-less", ko: "점심을 싸 오면 돈이 덜 들어요.", fills: ["bring lunch from home"], en: "It costs less to bring lunch from home." },
    ],
  };
}

function fixtureBank(): ToeicFrameDrillBank {
  const r = mergeFrameDrillImport(null, fixtureFile(), AT);
  return r.bank;
}

function item(id: string, frameKey: string, n: number): ToeicFrameDrillItem {
  return { id, frameKey, ko: `지어낸 문장 ${n}번이에요.`, fills: [`thing ${n}`], en: `Thing ${n} works.`, source: "seed", createdAt: AT };
}

function sItem(over: Partial<ToeicFrameDrillSessionItem>): ToeicFrameDrillSessionItem {
  return { itemId: "x", frameKey: "saves-me-from", ko: "지어낸 문장이에요.", en: "A tool saves me from work.", frame: "~ saves me from ~", outcome: "spoken", transcript: "a tool saves me from work", verdict: null, reasonKo: null, fixedEn: null, ...over };
}

function judgeInput(): ToeicFrameJudgeInput {
  return {
    items: [
      { no: 1, ko: "음성 비서 덕분에 저는 알람을 일일이 맞추지 않아도 돼요.", frameKey: "saves-me-from", frame: "~ saves me from ~", en: "A voice assistant saves me from setting every alarm by hand.", transcript: "a voice assistant saves me from setting every alarm by hand" },
      { no: 3, ko: "회의가 짧으면 저는 제 일에 더 집중할 수 있어요.", frameKey: "lets-me-focus", frame: "When ~, I can focus more on ~", en: "When meetings are short, I can focus more on my own work.", transcript: "if meeting is short i concentrate my work" },
    ],
  };
}

function judgeOut() {
  return {
    items: [
      { no: 1, verdict: "correct", reasonKo: null, fixedEn: null },
      { no: 3, verdict: "close", reasonKo: "틀 대신 다른 말로 말했어요", fixedEn: "When meetings are short, I can focus more on my work." },
    ],
    summaryKo: "두 문항 중 하나는 틀대로 말했어요. 다른 하나는 틀 글자를 바꿨어요.",
    improvements: ["When으로 시작하는 틀을 그대로 말해 보세요", "focus more on 뒤에 목적어를 붙이세요"],
    strongFrames: ["saves-me-from"],
    weakFrames: ["lets-me-focus"],
  };
}

// ---------------------------------------------------------------------------
// 1. spec-sync · JSON Schema · 호출 옵션
// ---------------------------------------------------------------------------

export const FRAME_DRILL_SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  { constName: "TOEIC_FRAME_JUDGE_SYSTEM_PROMPT", source: SRC, specLabel: "§20-5 호출 E 시스템 프롬프트", text: TOEIC_FRAME_JUDGE_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "TOEIC_FRAME_JUDGE_USER_TEMPLATE", source: SRC, specLabel: "§20-5 호출 E 사용자 메시지", text: TOEIC_FRAME_JUDGE_USER_TEMPLATE, mode: "block-exact" },
  { constName: "TOEIC_FRAME_JUDGE_ITEM_TEMPLATE", source: SRC, specLabel: "§20-5 호출 E 문항 형식", text: TOEIC_FRAME_JUDGE_ITEM_TEMPLATE, mode: "block-exact" },
  { constName: "TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT", source: SRC, specLabel: "§20-6 호출 F 시스템 프롬프트", text: TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "TOEIC_FRAME_SUPPLY_USER_TEMPLATE", source: SRC, specLabel: "§20-6 호출 F 사용자 메시지", text: TOEIC_FRAME_SUPPLY_USER_TEMPLATE, mode: "block-exact" },
  { constName: "TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE", source: SRC, specLabel: "§20-6 호출 F 틀 줄 형식", text: TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE, mode: "block-exact" },
];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function runSpecChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — 프롬프트 ↔ 스펙");
  for (const o of checkSpecSync(SPEC_URL, FRAME_DRILL_SPEC_SYNC_TARGETS)) add(`${o.constName}이 toeic.md §20 원문 그대로`, o.ok, o.ok ? o.summary : `${o.summary}\n${o.detail}`);
  add("spec-sync 원문 대상 = 6개(E 셋·F 셋)", FRAME_DRILL_SPEC_SYNC_TARGETS.length === 6, String(FRAME_DRILL_SPEC_SYNC_TARGETS.length));

  const parsed = new Map<string, unknown>();
  for (const b of extractSpecBlocks(SPEC_URL)) {
    try {
      const v = JSON.parse(b.text) as { name?: unknown };
      if (v && typeof v === "object" && typeof v.name === "string") parsed.set(v.name, v);
    } catch {
      // JSON 아닌 블록
    }
  }
  for (const [name, value] of [
    ["toeic_frame_judge", TOEIC_FRAME_JUDGE_JSON_SCHEMA],
    ["toeic_frame_supply", TOEIC_FRAME_SUPPLY_JSON_SCHEMA],
  ] as const) {
    const s = parsed.get(name);
    add(`JSON Schema ${name} ↔ 스펙 의미 동치`, s !== undefined && deepEqual(s, value), s === undefined ? "스펙 블록 없음" : "");
  }
  add("스펙의 toeic_frame_* JSON 블록 수 = 2", [...parsed.keys()].filter((k) => k.startsWith("toeic_frame_")).length === 2, [...parsed.keys()].filter((k) => k.startsWith("toeic_frame_")).join(","));
  const verdictEnum = ((TOEIC_FRAME_JUDGE_JSON_SCHEMA.schema as { properties: { items: { items: { properties: { verdict: { enum: string[] } } } } } }).properties.items.items.properties.verdict.enum);
  add("JSON Schema verdict enum == TOEIC_FRAME_DRILL_VERDICTS", verdictEnum.join(",") === TOEIC_FRAME_DRILL_VERDICTS.join(","), verdictEnum.join(","));

  // strict 모양 — 모든 객체 additionalProperties false + required = properties 키 전부, minItems/maxItems 없음
  const strictOk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return true;
    const n = node as Record<string, unknown>;
    if ("minItems" in n || "maxItems" in n) return false;
    if (n.type === "object") {
      const props = Object.keys((n.properties as Record<string, unknown>) ?? {});
      const req = (n.required as string[]) ?? [];
      if (n.additionalProperties !== false || props.length !== req.length || !props.every((p) => req.includes(p))) return false;
    }
    return Object.values(n).every(strictOk);
  };
  add("JSON Schema 둘 strict 모양(additionalProperties false · required 전부 · min/maxItems 없음)", strictOk(TOEIC_FRAME_JUDGE_JSON_SCHEMA.schema) && strictOk(TOEIC_FRAME_SUPPLY_JSON_SCHEMA.schema));

  const spec = readFileSync(SPEC_URL, "utf-8");
  const found = new Map<string, { t: number; max: number }>();
  for (const m of spec.matchAll(/temperature ([\d.]+), maxOutputTokens (\d+), call 라벨 `([^`]+)`/g)) found.set(m[3], { t: Number(m[1]), max: Number(m[2]) });
  for (const o of [TOEIC_FRAME_JUDGE_CALL_OPTIONS, TOEIC_FRAME_SUPPLY_CALL_OPTIONS]) {
    const s = found.get(o.call);
    add(`호출 옵션 == 스펙 문장: ${o.call}`, !!s && s.t === o.temperature && s.max === o.maxOutputTokens, s ? `스펙 t=${s.t} max=${s.max} · 코드 t=${o.temperature} max=${o.maxOutputTokens}` : "스펙 문장 없음");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. 사용자 메시지
// ---------------------------------------------------------------------------

function runMessageChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — 사용자 메시지");
  const msg = buildFrameJudgeUserMessage(judgeInput());
  const expected = [
    "문항 수: 2",
    "문항:",
    "[1]",
    "한국어: 음성 비서 덕분에 저는 알람을 일일이 맞추지 않아도 돼요.",
    "틀(saves-me-from): ~ saves me from ~",
    "모범 영어: A voice assistant saves me from setting every alarm by hand.",
    "수험자 답: a voice assistant saves me from setting every alarm by hand",
    "",
    "[3]",
    "한국어: 회의가 짧으면 저는 제 일에 더 집중할 수 있어요.",
    "틀(lets-me-focus): When ~, I can focus more on ~",
    "모범 영어: When meetings are short, I can focus more on my own work.",
    "수험자 답: if meeting is short i concentrate my work",
  ].join("\n");
  add("E 메시지 = 템플릿 + 문항 줄(문항 사이 빈 줄)", msg === expected, msg === expected ? "" : JSON.stringify(msg));
  const tricky = buildFrameJudgeUserMessage({ items: [{ no: 1, ko: "가  {en}  나", frameKey: "k", frame: "~ ok", en: "Fine $& {ko}.", transcript: "said {transcript}  twice" }] });
  add("E 단일 패스 — 값 안의 {ko}·{en}·$& 가 다시 치환되지 않고 공백은 접힌다", tricky.includes("한국어: 가 {en} 나") && tricky.includes("모범 영어: Fine $& {ko}.") && tricky.includes("수험자 답: said {transcript} twice"), JSON.stringify(tricky));

  const bank = fixtureBank();
  const plan = planFrameDrillSupply(bank, ["saves-me-from", "lets-me-focus"], 3);
  const sm = buildFrameSupplyUserMessage(plan);
  add(
    "F 메시지 — 틀 줄 형식(자리 이름 \", \", 개수) · 이미 있는 한국어 줄 '- '",
    sm.startsWith(
      "만들 문항 수: 3\n틀 목록:\n- saves-me-from | 소재: 기술 소재 | 질문 유형: 왜 | 틀: {도구} saves me from {수고}. | 뜻: {도구} 덕분에 저는 {수고}을 안 해도 돼요. | 자리: 도구, 수고 | 채움 후보: 도구=A smart speaker(스마트 스피커) / 수고=typing long messages(긴 메시지 입력) | ",
    ) &&
      sm.includes("\n- lets-me-focus | 소재: 직장 소재 | 질문 유형: 없음 | 틀: When {조건}, I can focus more on {일}. | 뜻: {조건} 저는 {일}에 더 집중할 수 있어요. | 자리: 조건, 일 | 채움 후보: 없음 | ") &&
      sm.includes("이미 있는 한국어 문장:\n- 회의가 짧으면") &&
      !sm.includes("점심을 싸 오면"),
    JSON.stringify(sm),
  );
  const none = buildFrameSupplyUserMessage({ count: 1, frames: plan.frames.slice(0, 1).map((x) => ({ ...x, want: 1 })), existingKo: [] });
  add("F 이미 있는 문장이 없으면 \"없음\"", none.endsWith("이미 있는 한국어 문장:\n없음"), JSON.stringify(none));
  return results;
}

// ---------------------------------------------------------------------------
// 3. zod — 호출 E·F · 가져오기
// ---------------------------------------------------------------------------

function runZodChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — zod");
  const E = buildFrameJudgeZod(judgeInput());
  add("E 정상 통과", ok(E, judgeOut()));
  const e = (f: (o: ReturnType<typeof judgeOut>) => void) => {
    const o = judgeOut();
    f(o);
    return o;
  };
  add("E 문항 빠짐 거부", bad(E, e((o) => o.items.pop())));
  add("E 같은 번호 두 번 거부", bad(E, e((o) => (o.items[1].no = 1))));
  add("E 모르는 번호 거부", bad(E, e((o) => (o.items[1].no = 2))));
  add("E correct + fixedEn 거부", bad(E, e((o) => ((o.items[0] as { fixedEn: string | null }).fixedEn = "A voice assistant saves me from setting alarms."))));
  add("E correct + 한글 reasonKo 통과", ok(E, e((o) => ((o.items[0] as { reasonKo: string | null }).reasonKo = "틀대로 잘 말했어요"))));
  add("E close + reasonKo null 거부", bad(E, e((o) => ((o.items[1] as { reasonKo: string | null }).reasonKo = null))));
  add("E close + fixedEn null 거부", bad(E, e((o) => ((o.items[1] as { fixedEn: string | null }).fixedEn = null))));
  add("E fixedEn 한글 거부", bad(E, e((o) => (o.items[1].fixedEn = "When 회의 is short, I can focus more on work."))));
  add("E fixedEn 채우지 않은 자리 ~ 거부", bad(E, e((o) => (o.items[1].fixedEn = "When ~, I can focus more on my work."))));
  add("E fixedEn {자리} 거부", bad(E, e((o) => (o.items[1].fixedEn = "When {조건}, I can focus more on my work."))));
  add("E reasonKo 영어만 거부", bad(E, e((o) => (o.items[1].reasonKo = "wrong frame"))));
  add("E improvements 1개 거부", bad(E, e((o) => o.improvements.splice(1))));
  add("E improvements 5개 거부", bad(E, e((o) => o.improvements.push("셋째 점이에요", "넷째 점이에요", "다섯째 점이에요"))));
  add("E improvements 중복 거부", bad(E, e((o) => (o.improvements[1] = o.improvements[0]))));
  add("E summaryKo 영어만 거부", bad(E, e((o) => (o.summaryKo = "Good job overall."))));
  add("E 모르는 틀 key 거부", bad(E, e((o) => (o.strongFrames = ["costs-less"]))));
  add("E strong ∩ weak 거부", bad(E, e((o) => (o.weakFrames = ["saves-me-from"]))));
  add("E strongFrames 4개 거부", bad(E, e((o) => (o.strongFrames = ["saves-me-from", "lets-me-focus", "saves-me-from", "lets-me-focus"]))));
  add("E 틀 목록 빈 배열 통과", ok(E, e((o) => ((o.strongFrames = []), (o.weakFrames = [])))));

  const bank = fixtureBank();
  const plan = planFrameDrillSupply(bank, ["saves-me-from", "costs-less"], 2);
  const F = buildFrameSupplyZod(plan);
  const fOut = () => ({
    items: [
      { frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 매일 바닥을 쓸지 않아도 돼요.", fills: ["A robot vacuum", "sweeping the floor every day"] },
      { frameKey: "costs-less", ko: "버스를 타면 돈이 덜 들어요.", fills: ["take the bus"] },
    ],
  });
  const plannedKeys = plan.frames.map((x) => `${x.frame.key}:${x.want}`).join(",");
  add("F 계획 — 문항 적은 틀부터 하나씩(saves 2문항·costs 1문항 → costs 먼저, 다음 saves)", plannedKeys === "saves-me-from:1,costs-less:1", plannedKeys);
  add("F 정상 통과", ok(F, fOut()));
  const f = (fn: (o: ReturnType<typeof fOut>) => void) => {
    const o = fOut();
    fn(o);
    return o;
  };
  add("F 개수 다름 거부", bad(F, f((o) => o.items.pop())));
  add("F 틀마다 개수 다름 거부(같은 틀 둘)", bad(F, f((o) => (o.items[1] = { frameKey: "saves-me-from", ko: "태블릿 덕분에 저는 종이를 안 사도 돼요.", fills: ["A tablet", "buying paper"] }))));
  add("F 모르는 frameKey 거부", bad(F, f((o) => (o.items[1].frameKey = "lets-me-focus"))));
  add("F fills 개수 다름 거부", bad(F, f((o) => (o.items[1].fills = ["take", "the bus"]))));
  add("F fills 한글 거부", bad(F, f((o) => (o.items[1].fills = ["버스 타기"]))));
  add("F fills 앞뒤 공백 거부", bad(F, f((o) => (o.items[1].fills = [" take the bus"]))));
  add("F 문장 첫 자리 소문자 거부", bad(F, f((o) => (o.items[0].fills = ["a robot vacuum", "sweeping the floor every day"]))));
  add("F 26단어 거부", bad(F, f((o) => (o.items[1].fills = ["take the bus " + "and walk a little ".repeat(5).trim() + " every single day of the week"]))));
  add("F ko 영어 낱말 거부", bad(F, f((o) => (o.items[1].ko = "bus를 타면 돈이 덜 들어요."))));
  add("F ko 대문자 약어는 통과", ok(F, f((o) => (o.items[1].ko = "KTX 대신 버스를 타면 돈이 덜 들어요."))));
  add("F ko 한글 없음 거부", bad(F, f((o) => (o.items[1].ko = "...."))));
  add("F 출력끼리 한국어 중복 거부", bad(buildFrameSupplyZod({ ...plan, count: 2, frames: [{ ...plan.frames[0], want: 2 }] }), {
    items: [
      { frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 바닥을 안 쓸어도 돼요.", fills: ["A robot vacuum", "sweeping"] },
      { frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 바닥을 안 쓸어도 돼요!", fills: ["A floor robot", "mopping"] },
    ],
  }));

  // 가져오기
  const S = toeicFrameDrillFileSchema;
  const file = fixtureFile();
  add("가져오기 정상 통과", ok(S, file));
  const g = (fn: (x: ToeicFrameDrillFile) => void) => {
    const x = fixtureFile();
    fn(x);
    return x;
  };
  add("가져오기 format 다름 거부(머리 메시지 = format 문구)", (() => {
    const r = S.safeParse(g((x) => ((x as { format: string }).format = "toeic-frame-drill/v0")));
    return !r.success && toeicFrameDrillImportInvalidBody(r.error.issues).messageKo.includes("toeic-frame-drill/v1");
  })());
  add("가져오기 모르는 topicKey 거부", bad(S, g((x) => (x.frames[0].topicKey = "nope"))));
  add("가져오기 틀 없는 소재 거부", bad(S, g((x) => x.topics.push({ key: "empty", nameKo: "빈 소재" }))));
  add("가져오기 문항 없는 틀 거부", bad(S, g((x) => (x.items = x.items.filter((it) => it.frameKey !== "costs-less")))));
  add("가져오기 모르는 frameKey 거부", bad(S, g((x) => (x.items[0].frameKey = "nope"))));
  add("가져오기 id ai- 시작 거부", bad(S, g((x) => (x.items[0].id = "ai-1234abcd"))));
  add("가져오기 id 중복 거부", bad(S, g((x) => (x.items[1].id = x.items[0].id))));
  add("가져오기 en ≠ fillFrame 거부(문장부호 하나)", bad(S, g((x) => (x.items[0].en = x.items[0].en.replace(/\.$/, "!")))));
  add("가져오기 fills 개수 거부", bad(S, g((x) => (x.items[0].fills = ["A voice assistant"]))));
  add("가져오기 소문자 시작 거부", bad(S, g((x) => {
    x.items[0].fills = ["a voice assistant", "setting every alarm by hand"];
    x.items[0].en = "a voice assistant saves me from setting every alarm by hand.";
  })));
  add("가져오기 영어 중복(대소문자·끝 문장부호 무시) 거부", bad(S, g((x) => {
    x.items[1].fills = [...x.items[0].fills];
    x.items[1].en = x.items[0].en;
    x.items[1].ko = "다른 한국어 문장이에요.";
  })));
  add("가져오기 한국어 중복(공백·문장부호 무시) 거부", bad(S, g((x) => (x.items[1].ko = x.items[0].ko.replace(".", "!").replace(" ", "  ")))));
  add("가져오기 틀 문법 — 자리 없음 거부(틀 은행 함수)", bad(S, g((x) => (x.frames[2].frameEn = "It costs less."))));
  add("가져오기 틀 문법 — 붙은 자리 거부(틀 은행 함수)", bad(S, g((x) => (x.frames[2].frameEn = "It costs less to {행동}ing."))));
  add("가져오기 한국어 틀 자리 이름 다름 거부(틀 은행 함수)", bad(S, g((x) => (x.frames[2].frameKo = "{동작} 돈이 덜 들어요."))));
  add("가져오기 parts q3_4 거부", bad(S, g((x) => ((x.frames[0] as { parts: string[] }).parts = ["q3_4"]))));
  add("가져오기 출처 태그: audio:PB03 통과 · 모르는 태그 거부 · 0개 거부 · 중복 거부",
    ok(S, g((x) => (x.frames[0].sources = ["drill", "audio:PB03"]))) &&
      bad(S, g((x) => (x.frames[0].sources = ["guide"]))) &&
      bad(S, g((x) => (x.frames[0].sources = []))) &&
      bad(S, g((x) => (x.frames[0].sources = ["drill", "drill"]))));
  add("가져오기 질문 유형: 모르는 key 거부 · 중복 거부 · 이름 한글 아님 거부",
    bad(S, g((x) => (x.frames[0].questionTypes = ["who"]))) &&
      bad(S, g((x) => (x.frames[0].questionTypes = ["why", "why"]))) &&
      bad(S, g((x) => (x.questionTypes[0].nameKo = "where"))));
  add("가져오기 채움 후보: 모르는 자리 거부 · 영어 한글 거부 · 뜻 영어만 거부 · 같은 자리 같은 영어 거부",
    bad(S, g((x) => (x.frames[0].fillOptions[0].slot = "장소"))) &&
      bad(S, g((x) => (x.frames[0].fillOptions[0].en = "스마트 스피커"))) &&
      bad(S, g((x) => (x.frames[0].fillOptions[0].ko = "speaker"))) &&
      bad(S, g((x) => x.frames[0].fillOptions.push({ slot: "도구", en: "a smart  speaker", ko: "다른 뜻" }))));
  add("가져오기 같은 틀(~ 형태) 두 번 거부", bad(S, g((x) => (x.frames[2].frameEn = "{도구} saves me from {수고}."))));
  const leak = S.safeParse(g((x) => (x.items[0].ko = "SECRET-장문 문장 bad {x}")));
  add(
    "가져오기 400 본문에 값 0(경로·규칙만)",
    !leak.success && !JSON.stringify(toeicFrameDrillImportInvalidBody(leak.error.issues)).includes("SECRET"),
    leak.success ? "통과해 버림" : "",
  );
  const pathOk = !leak.success && leak.error.issues.some((i) => i.path.join(".") === "items.0.ko");
  add("가져오기 issue 경로가 위치를 가리킨다(items.0.ko)", pathOk);
  const framePath = S.safeParse(g((x) => (x.frames[1].frameEn = "When {조건}, I can focus more on {일}~.")));
  add("가져오기 틀 문법 issue 경로 = frames.1.frameEn(하위 sink 접두어)", !framePath.success && framePath.error.issues.some((i) => i.path.join(".") === "frames.1.frameEn"), framePath.success ? "" : framePath.error.issues.map((i) => i.path.join(".")).join(" "));
  return results;
}

// ---------------------------------------------------------------------------
// 4. 순수 함수 — 출제·통계·보충·가져오기
// ---------------------------------------------------------------------------

function runPureChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — 순수 함수");
  const st = (attempts: number, wrong: number): ToeicFrameDrillStat => ({ attempts, wrong, lastAt: AT });

  add("가중치: 처음 3 · 한 번 틀림 5 · 다섯 번 다 맞힘 1+2/6", frameDrillWeight(undefined) === 3 && frameDrillWeight(st(1, 1)) === 5 && Math.abs(frameDrillWeight(st(5, 0)) - (1 + 2 / 6)) < 1e-12);
  add("문항 수 정리: 0→1 · 21→20 · 3.7→3 · NaN→기본", clampFrameDrillCount(0) === 1 && clampFrameDrillCount(21) === TOEIC_FRAME_DRILL_COUNT_MAX && clampFrameDrillCount(3.7) === 3 && clampFrameDrillCount(Number.NaN) === TOEIC_FRAME_DRILL_COUNT_DEFAULT);

  const pool: ToeicFrameDrillItem[] = [];
  for (let i = 0; i < 30; i++) pool.push(item(`i${i}`, `f${i % 3}`, i));
  const stats: Record<string, ToeicFrameDrillStat> = {};
  for (let i = 0; i < 30; i++) stats[`i${i}`] = i < 5 ? st(4, 4) : st(6, 0);
  const a = buildFrameDrillOrder(pool, stats, 10, seededRng(7));
  const b = buildFrameDrillOrder(pool, stats, 10, seededRng(7));
  const c = buildFrameDrillOrder(pool, stats, 10, seededRng(8));
  const ids = (o: { items: ToeicFrameDrillItem[] }) => o.items.map((x) => x.id).join(",");
  add("출제 결정성: 같은 시드 = 같은 순서", ids(a) === ids(b), ids(a));
  add("출제: 다른 시드 = 다른 순서", ids(a) !== ids(c));
  add("출제: 같은 판 중복 0 · 10개", new Set(a.items.map((x) => x.id)).size === 10 && a.shortBy === 0);
  add("출제: 같은 틀 연속 없음(다른 틀이 남아 있으면)", a.items.every((x, i) => i === 0 || a.items[i - 1].frameKey !== x.frameKey));
  // 가중 — 오답 문항(i0~i4, w=4)이 다 맞힌 문항(w≈1.29)보다 훨씬 자주 뽑힌다(시드 200개)
  let hard = 0;
  let easy = 0;
  for (let s = 0; s < 200; s++) {
    const o = buildFrameDrillOrder(pool, stats, 5, seededRng(1000 + s));
    for (const x of o.items) (Number(x.id.slice(1)) < 5 ? (hard += 1) : (easy += 1));
  }
  add("출제 가중: 오답 문항 5개의 비율이 균등(1/6)보다 크다", hard / (hard + easy) > 0.3, `${hard}/${hard + easy}`);
  const dup = buildFrameDrillOrder([pool[0], pool[0], pool[1]], {}, 5, seededRng(1));
  add("출제: 범위 문항 < 요청 → 가능한 만큼·shortBy · 입력 중복 id 접기", dup.items.length === 2 && dup.shortBy === 3);
  add("출제: 범위 0 → 빈 판 shortBy = 요청", buildFrameDrillOrder([], {}, 4, seededRng(1)).shortBy === 4);

  // 통계
  const items3: ToeicFrameDrillSessionItem[] = [
    sItem({ itemId: "a", verdict: "correct" }),
    sItem({ itemId: "b", verdict: "close" }),
    sItem({ itemId: "c", outcome: "no_speech", transcript: null }),
    sItem({ itemId: "d", outcome: "transcribe_failed", transcript: null }),
    sItem({ itemId: "e", verdict: "wrong" }),
  ];
  const before: Record<string, ToeicFrameDrillStat> = { a: st(2, 1) };
  const after = applyFrameDrillStats(before, items3, "2026-10-04T00:00:00.000Z");
  add("통계: correct +1/+0 · close·wrong·무응답 = 오답 · 전사 실패 건너뜀", after.a.attempts === 3 && after.a.wrong === 1 && after.b.wrong === 1 && after.c.wrong === 1 && after.e.wrong === 1 && after.d === undefined && after.a.lastAt === "2026-10-04T00:00:00.000Z");
  add("통계: 입력을 고치지 않는다(새 객체)", before.a.attempts === 2 && !("b" in before));
  add("통계 한 번만: review 없음 → not_judged · 이미 → already · 그 밖 apply",
    decideFrameDrillStatsApply({ review: null, statsAppliedAt: null }) === "not_judged" &&
      decideFrameDrillStatsApply({ review: frameDrillNoAiReview([], AT), statsAppliedAt: AT }) === "already" &&
      decideFrameDrillStatsApply({ review: frameDrillNoAiReview([], AT), statsAppliedAt: null }) === "apply");

  // 보충 개수·판정 경계
  const counts = [1, 10, 11, 20, 30, 95, 101, 200].map(frameDrillSupplyCount).join(",");
  add("보충 개수 ceil(10%) 1~10: 1·10·11·20·30·95·101·200 → 1,1,2,2,3,10,10,10", counts === "1,1,2,2,3,10,10,10", counts);
  add("보충 개수: 범위 0 → 0", frameDrillSupplyCount(0) === 0);
  const scope = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}` }));
  const rateStats = (wrongOf: number[]) => Object.fromEntries(scope.map((x, i) => [x.id, st(10, wrongOf[i] ?? 0)]));
  // 평균 오답률 정확히 0.2 / 0.199
  const twenty = rateStats(Array.from({ length: 20 }, () => 2));
  const under = rateStats([...Array.from({ length: 19 }, () => 2), 1.98]);
  const d20 = decideFrameDrillSupply({ bankItemCount: 20, scopeItems: scope, stats: twenty, alreadySupplied: false });
  const d199 = decideFrameDrillSupply({ bankItemCount: 20, scopeItems: scope, stats: under, alreadySupplied: false });
  add("보충 경계: 평균 20% → skip rate", d20.kind === "skip" && d20.reason === "rate", JSON.stringify(d20));
  add("보충 경계: 평균 19.9% → supply 2", d199.kind === "supply" && d199.count === 2, JSON.stringify(d199));
  const partial = Object.fromEntries(scope.slice(0, 9).map((x) => [x.id, st(3, 0)]));
  const dSample = decideFrameDrillSupply({ bankItemCount: 20, scopeItems: scope, stats: partial, alreadySupplied: false });
  add("보충: 표본 9 < 10 → skip sample", dSample.kind === "skip" && dSample.reason === "sample" && dSample.sample === 9);
  const small = scope.slice(0, 4);
  const dSmall = decideFrameDrillSupply({ bankItemCount: 4, scopeItems: small, stats: Object.fromEntries(small.map((x) => [x.id, st(1, 0)])), alreadySupplied: false });
  add("보충: 범위 4문항 모두 시도(표본 = min(10, 4)) → supply 1", dSmall.kind === "supply" && dSmall.count === 1);
  add("보충: 범위 0 → no_scope", decideFrameDrillSupply({ bankItemCount: 0, scopeItems: [], stats: {}, alreadySupplied: false }).kind === "skip");
  const dAlready = decideFrameDrillSupply({ bankItemCount: 20, scopeItems: scope, stats: under, alreadySupplied: true });
  add("보충: 이미 함 → skip already", dAlready.kind === "skip" && dAlready.reason === "already");
  const dFull = decideFrameDrillSupply({ bankItemCount: TOEIC_FRAME_DRILL_ITEMS_MAX, scopeItems: scope, stats: under, alreadySupplied: false });
  add("보충: 은행 가득 → skip full", dFull.kind === "skip" && dFull.reason === "full");
  const dRoom = decideFrameDrillSupply({ bankItemCount: TOEIC_FRAME_DRILL_ITEMS_MAX - 1, scopeItems: scope, stats: under, alreadySupplied: false });
  add("보충: 남은 자리 1 → 개수 1로 자름", dRoom.kind === "supply" && dRoom.count === 1);

  // 잡기
  const now = Date.parse(AT);
  add("잡기: 없음·failed → claim · added/skipped → already",
    decideFrameDrillSupplyClaim(null, now) === "claim" &&
      decideFrameDrillSupplyClaim({ status: "failed", reason: "ai_failed", added: 0, at: AT }, now) === "claim" &&
      decideFrameDrillSupplyClaim({ status: "added", reason: null, added: 2, at: AT }, now) === "already" &&
      decideFrameDrillSupplyClaim({ status: "skipped", reason: "rate", added: 0, at: AT }, now) === "already");
  add("잡기: running 2분 안 → running · 지나면 claim",
    decideFrameDrillSupplyClaim({ status: "running", reason: null, added: 0, at: AT }, now + TOEIC_FRAME_DRILL_SUPPLY_STALE_MS - 1) === "running" &&
      decideFrameDrillSupplyClaim({ status: "running", reason: null, added: 0, at: AT }, now + TOEIC_FRAME_DRILL_SUPPLY_STALE_MS) === "claim");

  // 합치기
  const bank = fixtureBank();
  const plan = planFrameDrillSupply(bank, ["saves-me-from", "costs-less"], 2);
  const acc = acceptFrameDrillSupply(bank, [
    { frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 매일 바닥을 쓸지 않아도 돼요.", fills: ["A robot vacuum", "sweeping the floor every day"] },
    { frameKey: "costs-less", ko: "점심을 싸 오면 돈이 덜 들어요!", fills: ["take the bus"] },
    { frameKey: "saves-me-from", ko: "완전히 다른 문장이에요.", fills: ["A dishwasher", "washing dishes every night"] },
  ], AT);
  add("합치기: en = fillFrame(코드가 만든다) · source ai · id ai-", acc.added.length === 1 && acc.added[0].en === "A robot vacuum saves me from sweeping the floor every day." && acc.added[0].source === "ai" && acc.added[0].id.startsWith("ai-"), JSON.stringify(acc.added));
  add("합치기: 은행과 한국어 키 겹침·영어 키 겹침 버림(재요청 없음)", acc.dropped === 2);
  const again = acceptFrameDrillSupply(bank, [{ frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 매일 바닥을 쓸지 않아도 돼요.", fills: ["A robot vacuum", "sweeping the floor every day"] }], AT);
  add("합치기 id 결정성: 같은 출력 = 같은 id", again.added[0]?.id === acc.added[0]?.id);
  const taken = new Set([frameDrillAiItemId("k", "Same sentence.", new Set())]);
  add("AI id 부딪침 → -2", frameDrillAiItemId("k", "same sentence", taken) === `${[...taken][0]}-2`);
  add("계획 count = 틀 want 합", plan.count === plan.frames.reduce((s, x) => s + x.want, 0) && plan.count === 2);
  const plan0 = planFrameDrillSupply(bank, ["nope"], 3);
  add("계획: 범위 틀이 은행에 없으면 count 0(호출하지 않는다)", plan0.count === 0 && plan0.frames.length === 0);

  // 범위
  const tq = frameDrillTopicsForPart(bank, "q5_7").map((t) => t.topic.key).join(",");
  const t11 = frameDrillTopicsForPart(bank, "q11").map((t) => t.topic.key).join(",");
  add("소재: 폴더 틀이 있는 소재만(Q5–7 tech·money · Q11 tech·work)", tq === "tech,money" && t11 === "tech,work", `${tq} | ${t11}`);
  const sk = frameDrillScopeFrameKeys(bank, "q11", ["tech", "work", "nope"], ["lets-me-focus"]);
  add("범위: 소재 고르면 다 켜지고 뺀 틀만 빠짐 · 모르는 key 무시", sk.join(",") === "saves-me-from", sk.join(","));
  add("범위 문항", frameDrillScopeItems(bank, sk).length === 2);
  const byQ = frameDrillScopeFrameKeys(bank, "q5_7", ["tech", "money"], [], ["where"]);
  const byQUnknown = frameDrillScopeFrameKeys(bank, "q5_7", ["tech", "money"], [], ["nope"]);
  add("범위: 질문 유형은 좁히기만(소재 AND 유형) · 모르는 유형만이면 안 좁힘", byQ.join(",") === "costs-less" && byQUnknown.join(",") === "saves-me-from,costs-less", `${byQ} | ${byQUnknown}`);
  add("폴더의 질문 유형: 그 폴더 틀에 붙은 것만(Q11 why · Q5–7 where·why)",
    frameDrillQuestionTypesForPart(bank, "q11").map((q) => q.key).join(",") === "why" && frameDrillQuestionTypesForPart(bank, "q5_7").map((q) => q.key).join(",") === "where,why");
  const pq = planFrameDrillSupply(bank, ["costs-less"], 1);
  add("계획: 질문 유형 이름을 싣는다(파일 순서)", pq.frames[0]?.questionTypeNamesKo.join(",") === "어디서,왜");
  add("틀 글자 = frameToExpression", frameDrillFrameText(bank.frames[1]) === "When ~, I can focus more on ~");
  add("한 판 문항 초기값", (() => {
    const s = toFrameDrillSessionItem(bank.items[0], bank.frames[0]);
    return s.frame === "~ saves me from ~" && s.verdict === null && s.ko === bank.items[0].ko;
  })());

  // 가져오기 병합 — id 안정성·통계 무관
  const file = fixtureFile();
  const first = mergeFrameDrillImport(null, file, AT);
  add("가져오기: 처음 → created 4", first.created === 4 && first.updated === 0 && first.removed === 0 && !first.unchanged);
  const withAi: ToeicFrameDrillBank = { ...first.bank, items: [...first.bank.items, ...acc.added] };
  const same = mergeFrameDrillImport(withAi, file, "2026-10-05T00:00:00.000Z");
  add("가져오기: 같은 파일 다시 → unchanged · updatedAt 그대로 · AI 유지", same.unchanged && same.bank.updatedAt === AT && same.aiKept === 1 && same.bank.items.length === 5);
  const edited = fixtureFile();
  edited.items[0] = { ...edited.items[0], ko: "음성 비서 덕분에 저는 알람을 하나하나 맞추지 않아도 돼요." };
  edited.items.splice(1, 1);
  edited.items.push({ id: "saves-me-from-s3", frameKey: "saves-me-from", ko: "자동 이체 덕분에 저는 요금 내는 날을 안 챙겨도 돼요.", fills: ["Automatic payment", "tracking every due date"], en: "Automatic payment saves me from tracking every due date." });
  const m2 = mergeFrameDrillImport(withAi, edited, "2026-10-05T00:00:00.000Z");
  const keptCreated = m2.bank.items.find((x) => x.id === "saves-me-from-s1")?.createdAt === AT;
  add("가져오기: 교정 updated 1(createdAt 이어받음) · 빠짐 removed 1 · 새 created 1", m2.updated === 1 && m2.removed === 1 && m2.created === 1 && keptCreated && !m2.unchanged, JSON.stringify({ u: m2.updated, r: m2.removed, c: m2.created }));
  const clash = fixtureFile();
  clash.items.push({ id: "saves-me-from-s9", frameKey: "saves-me-from", ko: "로봇 청소기 덕분에 저는 매일 바닥을 쓸지 않아도 돼요.", fills: ["A robot vacuum", "sweeping the floor every day"], en: "A robot vacuum saves me from sweeping the floor every day." });
  const m3 = mergeFrameDrillImport(withAi, clash, AT);
  add("가져오기: 시드와 겹친 AI 문항 버림(시드가 이긴다)", m3.aiDropped === 1 && m3.aiKept === 0);
  const noFrame = fixtureFile();
  noFrame.frames = noFrame.frames.filter((x) => x.key !== "saves-me-from");
  noFrame.items = noFrame.items.filter((x) => x.frameKey !== "saves-me-from");
  noFrame.topics = noFrame.topics.filter((x) => x.key !== "tech");
  const m4 = mergeFrameDrillImport(withAi, noFrame, AT);
  add("가져오기: 틀이 빠지면 그 틀 AI 문항도 버림", m4.aiDropped === 1 && m4.bank.items.every((x) => x.frameKey !== "saves-me-from"));
  add("가져오기 병합은 통계를 받지 않는다(시그니처 — 통계 문서 무관)", mergeFrameDrillImport.length === 3);
  return results;
}

// ---------------------------------------------------------------------------
// 5. 말 끝 상태 기계 · 판정 합치기 · 총평 · 스트릭
// ---------------------------------------------------------------------------

function runVoiceChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — 말 끝 판정");
  const ON = TOEIC_FRAME_DRILL_VOICE_ON_LEVEL + 0.05;
  const OFF = TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL - 0.05;
  const run = (levels: (t: number) => { level: number; reliable?: boolean } | null, until = 30_000, step = 90): ToeicFrameDrillVoiceState => {
    let s = initialFrameDrillVoice(0);
    for (let t = step; t <= until && s.ended === null; t += step) {
      const x = levels(t);
      if (x) s = stepFrameDrillVoice(s, { at: t, level: x.level, reliable: x.reliable ?? true });
    }
    return s;
  };
  add("문턱: ON > OFF > 무음 문턱", TOEIC_FRAME_DRILL_VOICE_ON_LEVEL > TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL && TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL > 0.1);
  const speak = run((t) => ({ level: t >= 1000 && t < 4000 ? ON : OFF }));
  add("말하고(1~4초) 무음 1.5초 → silence, 끝 시각 ≈ 4초 + 1.5초", speak.ended === "silence" && speak.speechAt !== null && speak.endedAt !== null && speak.endedAt >= 4000 + TOEIC_FRAME_DRILL_SILENCE_END_MS && speak.endedAt < 4000 + TOEIC_FRAME_DRILL_SILENCE_END_MS + 200, JSON.stringify(speak));
  const pause = run((t) => ({ level: (t >= 1000 && t < 3000) || (t >= 4200 && t < 6000) ? ON : OFF }));
  add("말 중간 1.2초 쉼은 끝이 아니다(1.5초 미만)", pause.ended === "silence" && (pause.endedAt ?? 0) >= 6000);
  const silent = run(() => ({ level: OFF }));
  add("말 시작 없이 10초 → no_speech", silent.ended === "no_speech" && (silent.endedAt ?? 0) >= TOEIC_FRAME_DRILL_START_WAIT_MS && (silent.endedAt ?? 0) < TOEIC_FRAME_DRILL_START_WAIT_MS + 100);
  const cough = run((t) => ({ level: t === 900 || t === 990 ? ON : OFF }));
  add(`짧은 소리(${TOEIC_FRAME_DRILL_VOICE_MIN_MS}ms 미만)는 말이 아니다 → no_speech`, cough.ended === "no_speech" && cough.speechAt === null);
  const long = run((t) => ({ level: t >= 500 ? ON : OFF }));
  add("계속 말하면 20초 상한 → max", long.ended === "max" && (long.endedAt ?? 0) >= TOEIC_FRAME_DRILL_MAX_ANSWER_MS);
  const unreliable = run((t) => (t >= 1000 && t < 3000 ? { level: ON } : { level: 0, reliable: false }));
  add("reliable false 표본은 무음으로 보지 않는다 → 끝 판정은 상한(max)", unreliable.ended === "max", JSON.stringify(unreliable));
  const done = stepFrameDrillVoice(speak, { at: 99_999, level: ON, reliable: true });
  add("끝난 상태에 표본을 넣어도 불변", done === speak);
  const hyst = run((t) => ({ level: t >= 1000 && t < 3000 ? ON : (TOEIC_FRAME_DRILL_VOICE_ON_LEVEL + TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL) / 2 }), 8000);
  add("히스테리시스: ON과 OFF 사이 레벨은 무음으로 세지 않는다(끝나지 않음)", hyst.ended === null && hyst.speechAt !== null);

  // 전사 결과
  const o1 = frameDrillOutcomeOf("  Hello   there friend ", false);
  add("전사 결과: 단어 ≥ 2 → spoken(공백 접기) · 1단어 → no_speech · 실패 → transcribe_failed",
    o1.outcome === "spoken" && o1.transcript === "Hello there friend" && frameDrillOutcomeOf("Hi", false).outcome === "no_speech" && frameDrillOutcomeOf(null, false).outcome === "no_speech" && frameDrillOutcomeOf("anything here", true).outcome === "transcribe_failed");

  // 판정
  const items = [
    sItem({ itemId: "a" }),
    sItem({ itemId: "b", outcome: "no_speech", transcript: null }),
    sItem({ itemId: "c" }),
    sItem({ itemId: "d", outcome: "transcribe_failed", transcript: null }),
  ];
  const targets = frameDrillJudgeTargets(items);
  add("E 대상 = spoken만, no는 한 판 순번(1·3)", targets.map((t) => t.no).join(",") === "1,3");
  add("판정 갈래: review 있으면 already · spoken 0 → no_ai · 그 밖 call",
    decideFrameDrillJudge({ review: null, items }) === "call" &&
      decideFrameDrillJudge({ review: null, items: [items[1], items[3]] }) === "no_ai" &&
      decideFrameDrillJudge({ review: frameDrillNoAiReview([], AT), items }) === "already");
  const merged = mergeFrameDrillVerdicts(items, [
    { no: 1, verdict: "correct", reasonKo: "좋아요", fixedEn: "should be dropped" },
    { no: 3, verdict: "close", reasonKo: "틀을 바꿨어요", fixedEn: "A tool saves me from work." },
  ]);
  add("합치기: correct면 fixedEn null · 무응답 wrong + 모범 영어 · 전사 실패 null",
    merged[0].verdict === "correct" && merged[0].fixedEn === null && merged[1].verdict === "wrong" && merged[1].reasonKo === TOEIC_FRAME_DRILL_NO_SPEECH_KO && merged[1].fixedEn === merged[1].en && merged[2].verdict === "close" && merged[3].verdict === null);
  const cnt = frameDrillSessionCounts(merged);
  add("한 판 요약: 맞음 1 · 아깝다 1 · 다시 1 · 판정 없음 1 · 말한 2", cnt.correct === 1 && cnt.close === 1 && cnt.wrong === 1 && cnt.unjudged === 1 && cnt.answered === 2, JSON.stringify(cnt));
  const nr = frameDrillNoAiReview([items[1], items[3]], AT);
  add("AI 0 총평: 한글 · 개선점 2 · model null", /[가-힣]/.test(nr.summaryKo) && nr.improvements.length === 2 && nr.model === null);

  // 스트릭
  const sessions = toeicStreakSessions([], [], [
    { startedAt: AT, items: [{ outcome: "spoken" }, { outcome: "no_speech" }] },
    { startedAt: "2026-10-02T00:00:00.000Z", items: [{ outcome: "no_speech" }] },
  ]);
  add("스트릭: 세 번째 인자 — spoken = answered, 나머지 null", sessions.length === 2 && sessions[0].items[0].answered === true && sessions[0].items[1].answered === null && sessions[1].items[0].answered === null);
  add("스트릭: 세 번째 인자 생략 = 옛 결과", toeicStreakSessions([], []).length === 0);
  add("스트릭 라벨: 틀 말하기 · {유형} / 모르면 틀 말하기",
    toeicFrameDrillStreakLabel({ part: "q11" }, (p) => (p === "q11" ? "Q11 의견 말하기" : null)) === "틀 말하기 · Q11 의견 말하기" &&
      toeicFrameDrillStreakLabel({ part: "q9" }, () => null) === "틀 말하기");
  return results;
}

// ---------------------------------------------------------------------------
// 6. 번들 경계 · 진입 함수 소스
// ---------------------------------------------------------------------------

function runBoundaryChecks(): FrameDrillCheckResult[] {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "틀 말하기 — 번들 경계");
  const src = readFileSync(new URL("../lib/toeic-frame-drill.ts", import.meta.url), "utf-8");
  const valueImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
  const badImports = valueImports.filter((p) => /\/ai\/|\/store|^openai|^zod/.test(p));
  const allowed = ["./toeic-template", "./toeic-text", "./toeic-mic-health", "./toeic-score"];
  add("lib/toeic-frame-drill.ts: lib/ai·store·openai·zod 값 import 0", badImports.length === 0, badImports.join(" "));
  add("lib/toeic-frame-drill.ts: 런타임 import는 클라이언트 안전 넷뿐", valueImports.every((p) => allowed.includes(p)), valueImports.join(" "));
  add("lib/toeic-frame-drill.ts: 정규식 lookbehind 0", !/\(\?<[=!]/.test(src));
  const calls = readFileSync(new URL("../lib/ai/toeic/calls.ts", import.meta.url), "utf-8");
  const judge = calls.slice(calls.indexOf("export async function judgeFrameDrill"));
  const supply = calls.slice(calls.indexOf("export async function supplyFrameDrillItems"));
  add("calls.ts: 두 진입 함수가 resolveToeicModel() · 원문 상수 · 팩토리 zod를 쓴다",
    /judgeFrameDrill[\s\S]*?TOEIC_FRAME_JUDGE_SYSTEM_PROMPT[\s\S]*?buildFrameJudgeZod\(input\)[\s\S]*?model: resolveToeicModel\(\)/.test(judge) &&
      /supplyFrameDrillItems[\s\S]*?TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT[\s\S]*?buildFrameSupplyZod\(plan\)[\s\S]*?model: resolveToeicModel\(\)/.test(supply));
  const client = readFileSync(new URL("../lib/ai/client.ts", import.meta.url), "utf-8");
  add("client.ts에 틀 말하기 분기·진입 함수 없음", !/frame_judge|frame_supply|FrameDrill/.test(client));
  const prompts = TOEIC_FRAME_JUDGE_SYSTEM_PROMPT + TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT + TOEIC_FRAME_JUDGE_USER_TEMPLATE + TOEIC_FRAME_SUPPLY_USER_TEMPLATE + TOEIC_FRAME_JUDGE_ITEM_TEMPLATE + TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE;
  add("프롬프트 상수에 영어 문장 예시 없음(틀·문장은 런타임 은행에서만)", !/[A-Za-z]+ [a-z]+ [a-z]+ [a-z]+/.test(prompts.replace(/TOEIC Speaking|I'm \/ I am/g, "")));
  return results;
}

/** eval-toeic.ts가 부른다 — 오프라인, 실호출 0 */
export function runToeicFrameDrillChecks(): FrameDrillCheckResult[] {
  return [...runSpecChecks(), ...runMessageChecks(), ...runZodChecks(), ...runPureChecks(), ...runVoiceChecks(), ...runBoundaryChecks()];
}

/**
 * 실호출 점검(게이트 — eval-toeic.ts runLiveChecks 안에서 EVAL_TOEIC_FRAME=1일 때만). 에이전트는 실행하지 않는다.
 * E 1회(지어낸 3문항 — 맞음·틀 바꿈·무관한 답) + F 1회(지어낸 틀 2개·2문항). 결과는 개수·판정 분포만 찍는다.
 */
export async function runFrameDrillLiveChecks(): Promise<FrameDrillCheckResult[]> {
  const results: FrameDrillCheckResult[] = [];
  const add = adder(results, "실호출(게이트) — 틀 말하기");
  const calls = await import("../lib/ai/toeic/calls");
  const input: ToeicFrameJudgeInput = {
    items: [
      ...judgeInput().items,
      { no: 4, ko: "점심을 싸 오면 돈이 덜 들어요.", frameKey: "costs-less", frame: "It costs less to ~", en: "It costs less to bring lunch from home.", transcript: "i like sunny weather in spring" },
    ],
  };
  try {
    const t0 = Date.now();
    const r = await calls.judgeFrameDrill(input);
    const dist = TOEIC_FRAME_DRILL_VERDICTS.map((v) => `${v} ${r.items.filter((x) => x.verdict === v).length}`).join(" · ");
    add("E 판정·총평(3문항)", r.items.length === 3, `${dist} · 개선점 ${r.improvements.length} · ${Date.now() - t0}ms · 기대: 1 correct · 3 close · 4 wrong`);
  } catch (e) {
    add("E 판정·총평(3문항)", false, e instanceof Error ? e.message : String(e));
  }
  try {
    const bank = fixtureBank();
    const plan = planFrameDrillSupply(bank, ["saves-me-from", "costs-less"], 2);
    const t0 = Date.now();
    const out = await calls.supplyFrameDrillItems(plan);
    const acc = acceptFrameDrillSupply(bank, out.items, new Date().toISOString());
    add("F 보충(2문항)", out.items.length === 2, `added ${acc.added.length} · dropped ${acc.dropped} · ${Date.now() - t0}ms`);
  } catch (e) {
    add("F 보충(2문항)", false, e instanceof Error ? e.message : String(e));
  }
  return results;
}

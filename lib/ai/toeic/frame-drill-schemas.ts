/**
 * lib/ai/toeic/frame-drill-schemas.ts — 소재별 틀 말하기 JSON Schema 2개(strict) + zod(호출 E·F 팩토리 · 가져오기 파일) + 상한
 * (docs/harness/toeic.md §20-3·§20-5·§20-6)
 *
 * - JSON Schema 두 상수는 스펙 JSON 코드블록을 그대로 옮겼다(scripts/eval-toeic-frame-drill.ts가 스펙을 파싱해 의미 동치로 대조).
 *   배열 개수 제약은 JSON Schema에 넣지 않는다(docs/HARNESS.md §1) — 프롬프트 + zod가 담당한다.
 * - zod는 입력을 알고 만든다 — E는 보낸 문항 번호·틀 key 집합, F는 보충 계획(틀·개수·자리 수).
 * - 틀 글자 규칙은 틀 은행 zod와 **같은 함수**(`checkTemplateFrameTexts`·`checkFill` — lib/ai/toeic/schemas.ts)를 부른다.
 * - zod 메시지에 값을 넣지 않는다(교재 글이 로그·400 본문에 새지 않게 — 경로가 위치를 알려 준다).
 *
 * ⚠️ 서버 전용(zod). 화면은 lib/toeic-frame-drill.ts의 타입·상수만 쓴다.
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";
import { collapseSpaces, countWords, hasHangul, hasLatin, matchKey } from "../../toeic-text";
import { fillFrame, frameSlotNames, frameToExpression } from "../../toeic-template";
import { TTS_TEXT_MAX_CHARS } from "../../tts-shared";
import { toToeicIssues } from "../../toeic-zod-ko";
import {
  TOEIC_FRAME_DRILL_AI_ID_PREFIX,
  TOEIC_FRAME_DRILL_FORMAT,
  TOEIC_FRAME_DRILL_FRAMES_MAX,
  TOEIC_FRAME_DRILL_ITEMS_MAX,
  TOEIC_FRAME_DRILL_ITEM_ID_RE,
  TOEIC_FRAME_DRILL_KEY_RE,
  TOEIC_FRAME_DRILL_MAX_BYTES,
  TOEIC_FRAME_DRILL_FILL_OPTIONS_MAX,
  TOEIC_FRAME_DRILL_FRAME_QUESTION_TYPES_MAX,
  TOEIC_FRAME_DRILL_QUESTION_TYPES_MAX,
  TOEIC_FRAME_DRILL_SOURCES_MAX,
  TOEIC_FRAME_DRILL_SOURCE_RE,
  TOEIC_FRAME_DRILL_PARTS,
  TOEIC_FRAME_DRILL_TOPICS_MAX,
  TOEIC_FRAME_DRILL_VERDICTS,
  frameDrillBankBytes,
  frameDrillEnKey,
  frameDrillKoKey,
  type ToeicFrameDrillFile,
  type ToeicFrameDrillJudgeItemOut,
  type ToeicFrameDrillSupplyOut,
  type ToeicFrameDrillSupplyPlan,
} from "../../toeic-frame-drill";
import { checkChars, checkCount, checkFill, checkKoText, checkPresetKey, checkTemplateFrameTexts, hasUnfilledSlot, issue, type IssueSink, type Path } from "./schemas";
import type { ToeicFrameJudgeInput } from "./frame-drill-prompts";

// ===========================================================================
// 상한 (단일 정의)
// ===========================================================================

export const TOEIC_FRAME_JUDGE_LIMITS = {
  summaryKo: [1, 400],
  improvements: [2, 4],
  improvementChars: 120,
  reasonKoChars: 120,
  /** strongFrames·weakFrames 각각 */
  framesMax: 3,
} as const;

export const TOEIC_FRAME_SUPPLY_LIMITS = {
  /** 프롬프트는 20단어 — zod는 넓게(경계에서 재요청을 태우지 않게) */
  enWordsMax: 25,
  koChars: 200,
} as const;

export const TOEIC_FRAME_DRILL_TOPIC_NAME_MAX = 30;
export const TOEIC_FRAME_DRILL_USE_KO_MAX = 120;
export const TOEIC_FRAME_DRILL_ITEM_KO_MAX = 200;
/** 자리 채움 후보의 한국어 뜻 상한 */
export const TOEIC_FRAME_DRILL_FILL_OPTION_KO_MAX = 80;
export const TOEIC_FRAME_DRILL_IMPORT_ISSUES_MAX = 20;

// ===========================================================================
// JSON Schema (strict) — §20-5·§20-6 원문 그대로
// ===========================================================================

export const TOEIC_FRAME_JUDGE_JSON_SCHEMA: StrictJsonSchema = {
  name: "toeic_frame_judge",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items", "summaryKo", "improvements", "strongFrames", "weakFrames"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["no", "verdict", "reasonKo", "fixedEn"],
          properties: {
            no: { type: "integer" },
            verdict: { type: "string", enum: ["correct", "close", "wrong"] },
            reasonKo: { type: ["string", "null"] },
            fixedEn: { type: ["string", "null"] },
          },
        },
      },
      summaryKo: { type: "string" },
      improvements: { type: "array", items: { type: "string" } },
      strongFrames: { type: "array", items: { type: "string" } },
      weakFrames: { type: "array", items: { type: "string" } },
    },
  },
};

export const TOEIC_FRAME_SUPPLY_JSON_SCHEMA: StrictJsonSchema = {
  name: "toeic_frame_supply",
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
          required: ["frameKey", "ko", "fills"],
          properties: {
            frameKey: { type: "string" },
            ko: { type: "string" },
            fills: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

// ===========================================================================
// 공통 판정
// ===========================================================================

/** 영어 문장 — 라틴 포함·한글 금지·채우지 않은 자리 금지·TTS 상한 */
function checkEnSentence(ctx: IssueSink, path: Path, s: string, label: string): void {
  checkChars(ctx, path, s, 1, TTS_TEXT_MAX_CHARS, label);
  if (!hasLatin(s)) issue(ctx, path, `${label}에는 영어(라틴 문자)가 있어야 합니다`);
  if (hasHangul(s)) issue(ctx, path, `${label}에 한글을 쓸 수 없습니다`);
  if (hasUnfilledSlot(s)) issue(ctx, path, `${label}에 채우지 않은 틀 자리(~ { })가 남아 있어요`);
}

/** 문장 첫 라틴 글자가 소문자인가(문장 첫 자리 채움을 소문자로 쓴 것) */
function startsLowercase(en: string): boolean {
  const m = /[A-Za-z]/.exec(en);
  return m !== null && m[0] >= "a" && m[0] <= "z";
}

/** 한국어 문장에 영어 낱말이 섞였나 — 대문자 약어(2~5자, 예: 지어낸 "ABC")는 허용 */
function hasEnglishWord(ko: string): boolean {
  return hasLatin(ko.replace(/\b[A-Z]{2,5}\b/g, ""));
}

/** 문항 한국어 — 1~200자·한글 포함·{ } ~ 금지 */
function checkItemKo(ctx: IssueSink, path: Path, ko: string): void {
  checkKoText(ctx, path, ko, TOEIC_FRAME_DRILL_ITEM_KO_MAX, "ko");
  if (/[{}~～〜]/.test(ko)) issue(ctx, path, "ko에는 { } ~를 쓸 수 없어요");
}

// ===========================================================================
// 호출 E zod — buildFrameJudgeZod(input)
// ===========================================================================

export interface ToeicFrameJudgeOutput {
  items: ToeicFrameDrillJudgeItemOut[];
  summaryKo: string;
  improvements: string[];
  strongFrames: string[];
  weakFrames: string[];
}

/**
 * 호출 E zod(§20-5). 입력을 알고 만든다:
 * - items: 보낸 문항 번호마다 정확히 하나(빠짐·중복·모르는 번호 거부).
 * - correct ⇒ fixedEn null, reasonKo는 null 또는 한글 한 줄. close·wrong ⇒ reasonKo(한글)·fixedEn(영어·채우지 않은 자리 금지) 필수.
 * - summaryKo 한글 1~400자, improvements 2~4(한글·중복 금지), strong/weakFrames 각 0~3 · 보낸 틀 key · 중복·겹침 금지.
 */
export function buildFrameJudgeZod(input: ToeicFrameJudgeInput): z.ZodType<ToeicFrameJudgeOutput> {
  const nos = new Set(input.items.map((it) => it.no));
  const frameKeys = new Set(input.items.map((it) => it.frameKey));
  const L = TOEIC_FRAME_JUDGE_LIMITS;
  return z
    .object({
      items: z.array(
        z.object({
          no: z.number().int(),
          verdict: z.enum(TOEIC_FRAME_DRILL_VERDICTS),
          reasonKo: z.string().nullable(),
          fixedEn: z.string().nullable(),
        }),
      ),
      summaryKo: z.string(),
      improvements: z.array(z.string()),
      strongFrames: z.array(z.string()),
      weakFrames: z.array(z.string()),
    })
    .superRefine((o, ctx) => {
      checkCount(ctx, ["items"], o.items, nos.size, nos.size, "items");
      const seen = new Set<number>();
      o.items.forEach((it, i) => {
        const p: Path = ["items", i];
        if (!nos.has(it.no)) issue(ctx, [...p, "no"], "no는 받은 문항 번호여야 해요");
        if (seen.has(it.no)) issue(ctx, [...p, "no"], "같은 문항 번호 두 번 금지");
        seen.add(it.no);
        if (it.verdict === "correct") {
          if (it.fixedEn !== null) issue(ctx, [...p, "fixedEn"], "correct면 fixedEn은 null이에요");
          if (it.reasonKo !== null) checkKoText(ctx, [...p, "reasonKo"], it.reasonKo, L.reasonKoChars, "reasonKo");
        } else {
          if (it.reasonKo === null) issue(ctx, [...p, "reasonKo"], "close·wrong이면 reasonKo가 있어야 해요");
          else checkKoText(ctx, [...p, "reasonKo"], it.reasonKo, L.reasonKoChars, "reasonKo");
          if (it.fixedEn === null) issue(ctx, [...p, "fixedEn"], "close·wrong이면 fixedEn이 있어야 해요");
          else checkEnSentence(ctx, [...p, "fixedEn"], it.fixedEn, "fixedEn");
        }
      });
      checkKoText(ctx, ["summaryKo"], o.summaryKo, L.summaryKo[1], "summaryKo");
      checkCount(ctx, ["improvements"], o.improvements, L.improvements[0], L.improvements[1], "improvements");
      const imp = new Set<string>();
      o.improvements.forEach((s, i) => {
        checkKoText(ctx, ["improvements", i], s, L.improvementChars, "improvements");
        const k = collapseSpaces(s);
        if (imp.has(k)) issue(ctx, ["improvements", i], "같은 개선점 두 번 금지");
        imp.add(k);
      });
      const frameList = (name: "strongFrames" | "weakFrames") => {
        const arr = o[name];
        checkCount(ctx, [name], arr, 0, L.framesMax, name);
        const s = new Set<string>();
        arr.forEach((k, i) => {
          if (!frameKeys.has(k)) issue(ctx, [name, i], `${name}에는 받은 틀 key만 쓸 수 있어요`);
          if (s.has(k)) issue(ctx, [name, i], `${name} 중복 금지`);
          s.add(k);
        });
        return s;
      };
      const strong = frameList("strongFrames");
      frameList("weakFrames");
      o.weakFrames.forEach((k, i) => {
        if (strong.has(k)) issue(ctx, ["weakFrames", i], "한 틀을 strongFrames와 weakFrames에 함께 넣을 수 없어요");
      });
    }) as z.ZodType<ToeicFrameJudgeOutput>;
}

// ===========================================================================
// 호출 F zod — buildFrameSupplyZod(plan)
// ===========================================================================

export interface ToeicFrameSupplyOutput {
  items: ToeicFrameDrillSupplyOut[];
}

/**
 * 호출 F zod(§20-6). 계획을 알고 만든다:
 * - items 개수 = plan.count, frameKey ∈ 계획 틀, 틀마다 개수 = want.
 * - fills 개수 = 그 틀 자리 수, 채움마다 틀 은행 채움 규칙(checkFill — 라틴·숫자 포함·한글·{ } ~ / [ ] 금지·앞뒤 공백 없음).
 * - 채운 문장(앱이 fillFrame으로 만든다): TTS 상한·25단어 이하·첫 라틴 글자 대문자.
 * - ko: 한글 1~200자·{ } ~ 금지·영어 낱말 금지(대문자 약어 허용).
 * - 출력끼리 영어 키·한국어 키 중복 금지. **은행과 겹침은 거부하지 않고** 합치기(acceptFrameDrillSupply)가 버린다.
 */
export function buildFrameSupplyZod(plan: ToeicFrameDrillSupplyPlan): z.ZodType<ToeicFrameSupplyOutput> {
  const frames = new Map(plan.frames.map((x) => [x.frame.key, x] as const));
  return z
    .object({
      items: z.array(z.object({ frameKey: z.string(), ko: z.string(), fills: z.array(z.string()) })),
    })
    .superRefine((o, ctx) => {
      checkCount(ctx, ["items"], o.items, plan.count, plan.count, "items");
      const per = new Map<string, number>();
      const enSeen = new Set<string>();
      const koSeen = new Set<string>();
      o.items.forEach((it, i) => {
        const p: Path = ["items", i];
        const x = frames.get(it.frameKey);
        if (!x) {
          issue(ctx, [...p, "frameKey"], "frameKey는 받은 틀 목록의 key여야 해요");
        } else {
          per.set(it.frameKey, (per.get(it.frameKey) ?? 0) + 1);
          const slots = frameSlotNames(x.frame.frameEn).length;
          if (it.fills.length !== slots) issue(ctx, [...p, "fills"], "fills 개수는 틀의 자리 수와 같아야 해요");
          it.fills.forEach((f, k) => checkFill(ctx, [...p, "fills", k], f));
          if (it.fills.length === slots) {
            const en = fillFrame(x.frame.frameEn, it.fills);
            checkEnSentence(ctx, [...p, "fills"], en, "채운 문장");
            if (countWords(en) > TOEIC_FRAME_SUPPLY_LIMITS.enWordsMax) issue(ctx, [...p, "fills"], `채운 문장은 ${TOEIC_FRAME_SUPPLY_LIMITS.enWordsMax}단어 이하여야 해요`);
            if (startsLowercase(en)) issue(ctx, [...p, "fills"], "문장 첫 자리 채움은 대문자로 시작해야 해요");
            const ek = frameDrillEnKey(en);
            if (enSeen.has(ek)) issue(ctx, [...p, "fills"], "같은 영어 문장 두 번 금지");
            enSeen.add(ek);
          }
        }
        checkItemKo(ctx, [...p, "ko"], it.ko);
        if (hasEnglishWord(it.ko)) issue(ctx, [...p, "ko"], "ko에 영어 낱말을 섞을 수 없어요");
        const kk = frameDrillKoKey(it.ko);
        if (koSeen.has(kk)) issue(ctx, [...p, "ko"], "같은 한국어 문장 두 번 금지");
        koSeen.add(kk);
      });
      for (const [key, x] of frames) {
        if ((per.get(key) ?? 0) !== x.want) issue(ctx, ["items"], "틀마다 적힌 개수만큼 만들어야 해요");
      }
    }) as z.ZodType<ToeicFrameSupplyOutput>;
}

// ===========================================================================
// 가져오기 파일 zod — toeicFrameDrillFileSchema (§20-3)
// ===========================================================================

const partEnum = z.enum(TOEIC_FRAME_DRILL_PARTS, { error: "parts는 q5_7·q11 중에서 골라요" });

/**
 * 가져오기 파일(`toeic-frame-drill/v1`) — 틀 글자 규칙은 틀 은행과 같은 함수, 문항은 en = fillFrame(frameEn, fills) 글자까지.
 * 교차 검사(소재·틀·문항 연결, 키 유일, 은행 크기)는 최상위 superRefine에서 한다.
 */
export const toeicFrameDrillFileSchema: z.ZodType<ToeicFrameDrillFile> = z
  .object({
    format: z.literal(TOEIC_FRAME_DRILL_FORMAT, { error: `format은 "${TOEIC_FRAME_DRILL_FORMAT}"이어야 해요` }),
    presetKey: z.string(),
    topics: z.array(z.object({ key: z.string(), nameKo: z.string() })),
    questionTypes: z.array(z.object({ key: z.string(), nameKo: z.string() })),
    frames: z.array(
      z.object({
        key: z.string(),
        topicKey: z.string(),
        frameEn: z.string(),
        frameKo: z.string(),
        useKo: z.string().nullable(),
        parts: z.array(partEnum),
        bankKey: z.string().nullable(),
        sources: z.array(z.string()),
        questionTypes: z.array(z.string()),
        fillOptions: z.array(z.object({ slot: z.string(), en: z.string(), ko: z.string() })),
      }),
    ),
    items: z.array(z.object({ id: z.string(), frameKey: z.string(), ko: z.string(), fills: z.array(z.string()), en: z.string() })),
  })
  .superRefine((f, ctx) => {
    checkPresetKey(ctx, ["presetKey"], f.presetKey);

    // 소재
    checkCount(ctx, ["topics"], f.topics, 1, TOEIC_FRAME_DRILL_TOPICS_MAX, "topics");
    const topicKeys = new Set<string>();
    f.topics.forEach((t, i) => {
      if (!TOEIC_FRAME_DRILL_KEY_RE.test(t.key)) issue(ctx, ["topics", i, "key"], "key는 소문자·숫자·하이픈(첫 글자는 소문자·숫자, 최대 40자)이어야 합니다");
      if (topicKeys.has(t.key)) issue(ctx, ["topics", i, "key"], "소재 key 중복 금지");
      topicKeys.add(t.key);
      checkKoText(ctx, ["topics", i, "nameKo"], t.nameKo, TOEIC_FRAME_DRILL_TOPIC_NAME_MAX, "nameKo");
    });

    // 질문 유형(소재와 별개 — Q5–7 의문사 등)
    checkCount(ctx, ["questionTypes"], f.questionTypes, 0, TOEIC_FRAME_DRILL_QUESTION_TYPES_MAX, "questionTypes");
    const qtypeKeys = new Set<string>();
    f.questionTypes.forEach((q, i) => {
      if (!TOEIC_FRAME_DRILL_KEY_RE.test(q.key)) issue(ctx, ["questionTypes", i, "key"], "key는 소문자·숫자·하이픈(첫 글자는 소문자·숫자, 최대 40자)이어야 합니다");
      if (qtypeKeys.has(q.key)) issue(ctx, ["questionTypes", i, "key"], "질문 유형 key 중복 금지");
      qtypeKeys.add(q.key);
      checkKoText(ctx, ["questionTypes", i, "nameKo"], q.nameKo, TOEIC_FRAME_DRILL_TOPIC_NAME_MAX, "nameKo");
    });

    // 틀 — 글자 규칙은 틀 은행과 같은 함수(checkTemplateFrameTexts)
    checkCount(ctx, ["frames"], f.frames, 1, TOEIC_FRAME_DRILL_FRAMES_MAX, "frames");
    const frameKeys = new Map<string, { frameEn: string; ok: boolean; slots: number }>();
    const exprSeen = new Set<string>();
    const topicUsed = new Set<string>();
    f.frames.forEach((fr, i) => {
      const p: Path = ["frames", i];
      if (!TOEIC_FRAME_DRILL_KEY_RE.test(fr.key)) issue(ctx, [...p, "key"], "key는 소문자·숫자·하이픈(첫 글자는 소문자·숫자, 최대 40자)이어야 합니다");
      if (frameKeys.has(fr.key)) issue(ctx, [...p, "key"], "틀 key 중복 금지");
      if (!topicKeys.has(fr.topicKey)) issue(ctx, [...p, "topicKey"], "topicKey는 topics에 있는 소재여야 해요");
      topicUsed.add(fr.topicKey);
      const sub: IssueSink = { addIssue: (x) => ctx.addIssue({ ...x, path: [...p, ...x.path] }) };
      const { frameOk, slotCount } = checkTemplateFrameTexts(sub, fr.frameEn, fr.frameKo);
      if (fr.useKo !== null) checkKoText(ctx, [...p, "useKo"], fr.useKo, TOEIC_FRAME_DRILL_USE_KO_MAX, "useKo");
      checkCount(ctx, [...p, "parts"], fr.parts, 1, TOEIC_FRAME_DRILL_PARTS.length, "parts");
      if (new Set(fr.parts).size !== fr.parts.length) issue(ctx, [...p, "parts"], "parts 중복 금지");
      if (fr.bankKey !== null && !TOEIC_FRAME_DRILL_KEY_RE.test(fr.bankKey)) issue(ctx, [...p, "bankKey"], "bankKey는 틀 은행 key 문법이어야 해요");
      checkCount(ctx, [...p, "sources"], fr.sources, 1, TOEIC_FRAME_DRILL_SOURCES_MAX, "sources");
      fr.sources.forEach((x, k) => {
        if (!TOEIC_FRAME_DRILL_SOURCE_RE.test(x)) issue(ctx, [...p, "sources", k], "출처는 bank·drill·new·audio:{파일 이름} 중 하나예요");
      });
      if (new Set(fr.sources).size !== fr.sources.length) issue(ctx, [...p, "sources"], "출처 중복 금지");
      checkCount(ctx, [...p, "questionTypes"], fr.questionTypes, 0, TOEIC_FRAME_DRILL_FRAME_QUESTION_TYPES_MAX, "questionTypes");
      fr.questionTypes.forEach((q, k) => {
        if (!qtypeKeys.has(q)) issue(ctx, [...p, "questionTypes", k], "질문 유형은 questionTypes에 있는 key여야 해요");
      });
      if (new Set(fr.questionTypes).size !== fr.questionTypes.length) issue(ctx, [...p, "questionTypes"], "질문 유형 중복 금지");
      // 자리 채움 후보 — 자리 이름은 이 틀의 자리, 영어는 틀 은행 채움 규칙(checkFill), 한국어 뜻은 한글
      checkCount(ctx, [...p, "fillOptions"], fr.fillOptions, 0, TOEIC_FRAME_DRILL_FILL_OPTIONS_MAX, "fillOptions");
      const slotNames = new Set(frameSlotNames(fr.frameEn));
      const optSeen = new Set<string>();
      fr.fillOptions.forEach((o, k) => {
        const op: Path = [...p, "fillOptions", k];
        if (frameOk && !slotNames.has(o.slot)) issue(ctx, [...op, "slot"], "slot은 이 틀의 자리 이름이어야 해요");
        checkFill(ctx, [...op, "en"], o.en);
        checkKoText(ctx, [...op, "ko"], o.ko, TOEIC_FRAME_DRILL_FILL_OPTION_KO_MAX, "ko");
        if (/[{}~～〜]/.test(o.ko)) issue(ctx, [...op, "ko"], "ko에는 { } ~를 쓸 수 없어요");
        const key = `${o.slot}\u0000${matchKey(o.en)}`;
        if (optSeen.has(key)) issue(ctx, op, "같은 자리의 같은 채움 후보 두 번 금지");
        optSeen.add(key);
      });
      if (frameOk) {
        const ek = matchKey(frameToExpression(fr.frameEn));
        if (exprSeen.has(ek)) issue(ctx, [...p, "frameEn"], "같은 틀(~ 형태가 같은 것) 두 번 금지");
        exprSeen.add(ek);
      }
      if (!frameKeys.has(fr.key)) frameKeys.set(fr.key, { frameEn: fr.frameEn, ok: frameOk, slots: slotCount });
    });
    f.topics.forEach((t, i) => {
      if (!topicUsed.has(t.key)) issue(ctx, ["topics", i], "틀이 하나도 없는 소재는 둘 수 없어요");
    });

    // 문항 — en = fillFrame(frameEn, fills) 글자까지
    checkCount(ctx, ["items"], f.items, 1, TOEIC_FRAME_DRILL_ITEMS_MAX, "items");
    const ids = new Set<string>();
    const enSeen = new Set<string>();
    const koSeen = new Set<string>();
    const frameHasItem = new Set<string>();
    f.items.forEach((it, i) => {
      const p: Path = ["items", i];
      if (!TOEIC_FRAME_DRILL_ITEM_ID_RE.test(it.id)) issue(ctx, [...p, "id"], "id는 소문자·숫자·하이픈(첫 글자는 소문자·숫자, 최대 60자)이어야 합니다");
      if (it.id.startsWith(TOEIC_FRAME_DRILL_AI_ID_PREFIX)) issue(ctx, [...p, "id"], `id는 "${TOEIC_FRAME_DRILL_AI_ID_PREFIX}"로 시작할 수 없어요(AI 문항 자리)`);
      if (ids.has(it.id)) issue(ctx, [...p, "id"], "문항 id 중복 금지");
      ids.add(it.id);
      const fr = frameKeys.get(it.frameKey);
      if (!fr) issue(ctx, [...p, "frameKey"], "frameKey는 frames에 있는 틀이어야 해요");
      else frameHasItem.add(it.frameKey);
      it.fills.forEach((x, k) => checkFill(ctx, [...p, "fills", k], x));
      checkEnSentence(ctx, [...p, "en"], it.en, "en");
      if (fr && fr.ok) {
        if (it.fills.length !== fr.slots) issue(ctx, [...p, "fills"], "채움 수는 틀의 자리 수와 같아야 해요");
        else if (it.en !== fillFrame(fr.frameEn, it.fills)) issue(ctx, [...p, "en"], "en은 틀에 채움을 넣은 결과와 글자까지(대소문자·문장부호·공백) 같아야 해요");
      }
      if (startsLowercase(it.en)) issue(ctx, [...p, "en"], "en은 대문자로 시작해야 해요(문장 첫 자리 채움)");
      checkItemKo(ctx, [...p, "ko"], it.ko);
      const ek = frameDrillEnKey(it.en);
      if (enSeen.has(ek)) issue(ctx, [...p, "en"], "같은 영어 문장 두 번 금지(대소문자·공백·끝 문장부호 무시)");
      enSeen.add(ek);
      const kk = frameDrillKoKey(it.ko);
      if (koSeen.has(kk)) issue(ctx, [...p, "ko"], "같은 한국어 문장 두 번 금지(공백·문장부호 무시)");
      koSeen.add(kk);
    });
    f.frames.forEach((fr, i) => {
      if (frameKeys.has(fr.key) && !frameHasItem.has(fr.key)) issue(ctx, ["frames", i], "문항이 하나도 없는 틀은 둘 수 없어요");
    });

    // 크기 — 은행 문서로 옮긴 모양(createdAt·source 포함)이 상한 안
    const asBank = {
      topics: f.topics,
      questionTypes: f.questionTypes,
      frames: f.frames,
      items: f.items.map((it) => ({ ...it, source: "seed" as const, createdAt: "2026-01-01T00:00:00.000Z" })),
    };
    if (frameDrillBankBytes(asBank) > TOEIC_FRAME_DRILL_MAX_BYTES) issue(ctx, [], `은행이 ${TOEIC_FRAME_DRILL_MAX_BYTES}바이트를 넘어요 — 문항을 나눠 주세요`);
  }) as z.ZodType<ToeicFrameDrillFile>;

/** 가져오기 400 본문 — 경로·규칙만(값 0). 형식이 틀리면 그 문구를 머리로 */
export function toeicFrameDrillImportInvalidBody(issues: readonly z.core.$ZodIssue[]): {
  ok: false;
  error: "invalid_input";
  messageKo: string;
  issues: { path: string; message: string }[];
} {
  const formatIssue = issues.find((i) => i.path.length === 1 && i.path[0] === "format");
  return {
    ok: false,
    error: "invalid_input",
    messageKo: formatIssue?.message ?? "틀 말하기 문제 파일을 가져올 수 없어요 — 표시된 위치를 고쳐 파일을 다시 만들어 주세요",
    issues: toToeicIssues(issues, TOEIC_FRAME_DRILL_IMPORT_ISSUES_MAX),
  };
}

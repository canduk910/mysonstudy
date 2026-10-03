/**
 * lib/ai/phrase-helper/schemas.ts — 표현 도우미 JSON Schema 2(strict) + 모드별 zod + 폭 상수 + 출력 다듬기
 * (docs/harness/phrase-helper.md §5·§6)
 *
 * - `PHRASE_HELPER_EN_JSON_SCHEMA`(toeic·english-kid 공용)·`PHRASE_HELPER_JA_JSON_SCHEMA`는 스펙 §5 코드블록과 **의미 동치**다
 *   (설명문 없이 원문 그대로 — scripts/eval-phrase-helper.ts가 스펙 블록을 JSON으로 파싱해 deep-equal로 잠근다).
 *   배열 개수 제약은 넣지 않는다(docs/HARNESS.md §1) — 프롬프트 + zod가 맡는다.
 * - zod는 모드마다 폭이 다르다(`PHRASE_HELPER_LIMITS[mode]` 한 곳 — 프롬프트 숫자보다 넓게). 스키마가 못 잡는 것:
 *   status 상호 의존(ok가 아니면 main null·빈 배열·안내 필수), 개수, 단어/글자 수, 언어(한글·라틴·가나), 자리 표시, 중복,
 *   일본어 읽기 규칙(한자·숫자·로마자·한글 금지, 가나만인 표현은 읽기 = 표현 — 가타카나를 히라가나로 바꾸지 않는다).
 * - 예문에 main이 들어 있는지는 **강제하지 않는다**(§6 — 활용형 때문에 강제하면 재요청·부자연스러운 시제). 알림은
 *   lib/phrase-helper.ts `phraseHelperExampleCoverage`.
 *
 * ⚠️ zod 런타임을 import한다 — 클라이언트 컴포넌트는 이 파일에서 값을 import하지 않는다(타입은 lib/phrase-helper.ts에 있다).
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";
import {
  PHRASE_HELPER_JA_REGISTERS,
  PHRASE_HELPER_STATUSES,
  type PhraseHelperEnOutput,
  type PhraseHelperJaOutput,
  type PhraseHelperMode,
} from "../../phrase-helper";

// ---------------------------------------------------------------------------
// JSON Schema (§5 원문과 의미 동치)
// ---------------------------------------------------------------------------

/** §5-1 — toeic·english-kid 공용 */
export const PHRASE_HELPER_EN_JSON_SCHEMA: StrictJsonSchema = {
  name: "phrase_helper_en",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "noteKo", "main", "alternatives", "examples"],
    properties: {
      status: { type: "string", enum: [...PHRASE_HELPER_STATUSES] },
      noteKo: { type: ["string", "null"] },
      main: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["expression", "usageKo"],
        properties: {
          expression: { type: "string" },
          usageKo: { type: "string" },
        },
      },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["expression", "noteKo"],
          properties: {
            expression: { type: "string" },
            noteKo: { type: "string" },
          },
        },
      },
      examples: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["en", "ko"],
          properties: {
            en: { type: "string" },
            ko: { type: "string" },
          },
        },
      },
    },
  },
};

/** §5-2 — japanese */
export const PHRASE_HELPER_JA_JSON_SCHEMA: StrictJsonSchema = {
  name: "phrase_helper_ja",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "noteKo", "main", "alternatives", "examples"],
    properties: {
      status: { type: "string", enum: [...PHRASE_HELPER_STATUSES] },
      noteKo: { type: ["string", "null"] },
      main: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["expression", "reading", "register", "usageKo"],
        properties: {
          expression: { type: "string" },
          reading: { type: "string" },
          register: { type: "string", enum: [...PHRASE_HELPER_JA_REGISTERS] },
          usageKo: { type: "string" },
        },
      },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["expression", "reading", "register", "noteKo"],
          properties: {
            expression: { type: "string" },
            reading: { type: "string" },
            register: { type: "string", enum: [...PHRASE_HELPER_JA_REGISTERS] },
            noteKo: { type: "string" },
          },
        },
      },
      examples: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ja", "reading", "ko"],
          properties: {
            ja: { type: "string" },
            reading: { type: "string" },
            ko: { type: "string" },
          },
        },
      },
    },
  },
};

/** 모드 → JSON Schema */
export const PHRASE_HELPER_JSON_SCHEMAS: Readonly<Record<PhraseHelperMode, StrictJsonSchema>> = {
  toeic: PHRASE_HELPER_EN_JSON_SCHEMA,
  japanese: PHRASE_HELPER_JA_JSON_SCHEMA,
  "english-kid": PHRASE_HELPER_EN_JSON_SCHEMA,
};

// ---------------------------------------------------------------------------
// 폭 상수 (§6 표 — 단일 정의)
// ---------------------------------------------------------------------------

export interface PhraseHelperLimits {
  /** 상위 noteKo 최대 글자 */
  noteKoMax: number;
  /** usageKo 최대 글자 */
  usageKoMax: number;
  /** 대안 noteKo 최대 글자 */
  altNoteKoMax: number;
  alternativesMax: number;
  examplesMin: number;
  examplesMax: number;
  /** main·대안 표현 길이 — 영어는 단어, 일본어는 글자 */
  expressionMax: number;
  /** 예문 길이 — 영어는 단어, 일본어는 글자(공백 뺀 코드 포인트) */
  exampleMin: number;
  exampleMax: number;
}

export const PHRASE_HELPER_LIMITS: Readonly<Record<PhraseHelperMode, PhraseHelperLimits>> = {
  toeic: { noteKoMax: 150, usageKoMax: 120, altNoteKoMax: 120, alternativesMax: 2, examplesMin: 0, examplesMax: 3, expressionMax: 40, exampleMin: 5, exampleMax: 25 },
  japanese: { noteKoMax: 150, usageKoMax: 120, altNoteKoMax: 120, alternativesMax: 2, examplesMin: 0, examplesMax: 3, expressionMax: 100, exampleMin: 4, exampleMax: 60 },
  "english-kid": { noteKoMax: 100, usageKoMax: 80, altNoteKoMax: 80, alternativesMax: 1, examplesMin: 0, examplesMax: 2, expressionMax: 20, exampleMin: 3, exampleMax: 12 },
};

// ---------------------------------------------------------------------------
// 판정 함수 (zod·eval 공용)
// ---------------------------------------------------------------------------

const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const LATIN_RE = /[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]/;
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005\u3006]/;
const KANA_RE = /[\u3041-\u3096\u30A1-\u30FA\u30FC\u309D\u309E\u30FD\u30FE\uFF66-\uFF9D]/;
const DIGIT_RE = /[0-9\uFF10-\uFF19]/;

export function phraseHasHangul(s: string): boolean {
  return HANGUL_RE.test(s);
}
export function phraseHasLatin(s: string): boolean {
  return LATIN_RE.test(s);
}
export function phraseHasHan(s: string): boolean {
  return HAN_RE.test(s);
}
export function phraseHasKana(s: string): boolean {
  return KANA_RE.test(s);
}

/** 채우지 않은 자리 표시 — `~`·`～`·`〜`·`{`·`}`, 영어는 낱말 sb·sth까지(§6) */
export function phraseHasPlaceholder(s: string, lang: "en" | "ja"): boolean {
  if (/[~～〜{}]/.test(s)) return true;
  return lang === "en" && /(^|[^A-Za-z])(sb|sth)([^A-Za-z]|$)/i.test(s);
}

/** 영어 단어 수 — 공백으로 나눈 조각 중 라틴 글자·숫자가 있는 것만 센다 */
export function phraseEnWordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** 일본어 글자 수 — 공백을 뺀 코드 포인트 수 */
export function phraseJaCharCount(s: string): number {
  return [...s.replace(/\s+/g, "")].length;
}

/** "같은 표현" 키 — 영어: 소문자·문장부호·연속 공백 무시 / 일본어: 공백·문장부호만 무시 */
export function phraseSameKey(s: string, lang: "en" | "ja"): string {
  if (lang === "en") return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();
  return s.replace(/[\s、。，．！？!?,.「」『』（）()・…‥:：;；"'“”‘’]/g, "");
}

/**
 * 일본어 읽기 판정 — 빈 값·가나 없음·한자·숫자·로마자·한글이면 문제 문구, 괜찮으면 null.
 * 표현이 가나만이면(한자·숫자·로마자 없음) 공백·문장부호를 뺀 읽기가 표현과 같아야 한다(가타카나를 히라가나로 바꾸지 않는다).
 */
export function checkJaReading(expression: string, reading: string): string | null {
  const r = reading.trim();
  if (r === "") return "읽기가 비었다";
  if (!phraseHasKana(r)) return "읽기에 가나가 없다";
  if (phraseHasHan(r)) return "읽기에 한자가 있다 — 한자는 히라가나로 바꿔 쓴다";
  if (DIGIT_RE.test(r)) return "읽기에 숫자가 있다 — 숫자도 읽는 대로 히라가나로 쓴다";
  if (phraseHasLatin(r)) return "읽기에 로마자가 있다";
  if (phraseHasHangul(r)) return "읽기에 한글이 있다";
  const kanaOnly = !phraseHasHan(expression) && !DIGIT_RE.test(expression) && !phraseHasLatin(expression);
  if (kanaOnly && phraseSameKey(r, "ja") !== phraseSameKey(expression, "ja")) {
    return "가나만인 표현의 읽기는 표현과 같아야 한다(가타카나를 히라가나로 바꾸지 않는다)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// zod (§6)
// ---------------------------------------------------------------------------

const statusSchema = z.enum(PHRASE_HELPER_STATUSES);
const registerSchema = z.enum(PHRASE_HELPER_JA_REGISTERS);

const enRawSchema = z.object({
  status: statusSchema,
  noteKo: z.string().nullable(),
  main: z.object({ expression: z.string(), usageKo: z.string() }).strict().nullable(),
  alternatives: z.array(z.object({ expression: z.string(), noteKo: z.string() }).strict()),
  examples: z.array(z.object({ en: z.string(), ko: z.string() }).strict()),
}).strict();

const jaRawSchema = z.object({
  status: statusSchema,
  noteKo: z.string().nullable(),
  main: z.object({ expression: z.string(), reading: z.string(), register: registerSchema, usageKo: z.string() }).strict().nullable(),
  alternatives: z.array(z.object({ expression: z.string(), reading: z.string(), register: registerSchema, noteKo: z.string() }).strict()),
  examples: z.array(z.object({ ja: z.string(), reading: z.string(), ko: z.string() }).strict()),
}).strict();

type Issue = (path: (string | number)[], message: string) => void;

/** 한국어 설명 칸 — 빈 값 금지·한글 포함·상한 */
function checkKo(add: Issue, path: (string | number)[], s: string, max: number): void {
  const t = s.trim();
  if (t === "") return add(path, "비었다");
  if (!phraseHasHangul(t)) add(path, "한국어(한글)로 쓴다");
  if ([...t].length > max) add(path, `${max}자 이하로 쓴다`);
}

/** status 상호 의존 + noteKo (세 모드 공통) */
function checkStatus(add: Issue, v: { status: string; noteKo: string | null; main: unknown; alternatives: unknown[]; examples: unknown[] }, lim: PhraseHelperLimits): boolean {
  if (v.status !== "ok") {
    if (v.main !== null) add(["main"], "status가 ok가 아니면 main은 null이다");
    if (v.alternatives.length > 0) add(["alternatives"], "status가 ok가 아니면 빈 배열이다");
    if (v.examples.length > 0) add(["examples"], "status가 ok가 아니면 빈 배열이다");
    if (v.noteKo === null) add(["noteKo"], "status가 ok가 아니면 noteKo에 안내 한 줄을 쓴다");
    else checkKo(add, ["noteKo"], v.noteKo, lim.noteKoMax);
    return false;
  }
  if (v.main === null) add(["main"], "status가 ok면 main이 있어야 한다");
  if (v.noteKo !== null) checkKo(add, ["noteKo"], v.noteKo, lim.noteKoMax);
  return v.main !== null;
}

function checkCounts(add: Issue, alternatives: unknown[], examples: unknown[], lim: PhraseHelperLimits): void {
  if (alternatives.length > lim.alternativesMax) add(["alternatives"], `0~${lim.alternativesMax}개`);
  if (examples.length < lim.examplesMin || examples.length > lim.examplesMax) {
    add(["examples"], lim.examplesMin === lim.examplesMax ? `정확히 ${lim.examplesMin}개` : `${lim.examplesMin}~${lim.examplesMax}개`);
  }
}

/** 영어 표현 칸(main·대안) */
function checkEnExpression(add: Issue, path: (string | number)[], s: string, lim: PhraseHelperLimits): void {
  const t = s.trim();
  if (t === "") return add(path, "비었다");
  if (!phraseHasLatin(t)) add(path, "영어로 쓴다");
  if (phraseHasHangul(t)) add(path, "한글을 섞지 않는다");
  if (phraseHasPlaceholder(t, "en")) add(path, "~·sb·sth 같은 자리 표시를 쓰지 않는다");
  if (phraseEnWordCount(t) > lim.expressionMax) add(path, `${lim.expressionMax}단어 이하`);
}

/** 일본어 표현 칸(main·대안) — 읽기 포함 */
function checkJaExpression(add: Issue, path: (string | number)[], expression: string, reading: string, lim: PhraseHelperLimits): void {
  const t = expression.trim();
  if (t === "") return add([...path, "expression"], "비었다");
  if (!phraseHasKana(t) && !phraseHasHan(t)) add([...path, "expression"], "일본어(가나·한자)로 쓴다");
  if (phraseHasHangul(t)) add([...path, "expression"], "한글을 섞지 않는다");
  if (phraseHasPlaceholder(t, "ja")) add([...path, "expression"], "～ 같은 자리 표시를 쓰지 않는다");
  if (phraseJaCharCount(t) > lim.expressionMax) add([...path, "expression"], `${lim.expressionMax}자 이하`);
  const bad = checkJaReading(t, reading);
  if (bad) add([...path, "reading"], bad);
}

/** 대안이 main과 같거나 서로 겹치는가 */
function checkDistinct(add: Issue, mainExpr: string, alts: readonly { expression: string }[], lang: "en" | "ja"): void {
  const seen = new Set([phraseSameKey(mainExpr, lang)]);
  alts.forEach((a, i) => {
    const k = phraseSameKey(a.expression, lang);
    if (seen.has(k)) add(["alternatives", i, "expression"], "main이나 앞 대안과 같은 표현이다");
    seen.add(k);
  });
}

function checkDistinctExamples(add: Issue, texts: readonly string[], lang: "en" | "ja"): void {
  const seen = new Set<string>();
  texts.forEach((t, i) => {
    const k = phraseSameKey(t, lang);
    if (seen.has(k)) add(["examples", i], "같은 예문을 되풀이했다");
    seen.add(k);
  });
}

/** 영어 두 모드(toeic·english-kid)의 zod */
export function buildPhraseHelperEnZod(mode: Exclude<PhraseHelperMode, "japanese">): z.ZodType<PhraseHelperEnOutput> {
  const lim = PHRASE_HELPER_LIMITS[mode];
  return enRawSchema.superRefine((v, ctx) => {
    const add: Issue = (path, message) => ctx.addIssue({ code: "custom", path, message });
    if (!checkStatus(add, v, lim) || v.main === null) return;
    checkCounts(add, v.alternatives, v.examples, lim);
    checkEnExpression(add, ["main", "expression"], v.main.expression, lim);
    checkKo(add, ["main", "usageKo"], v.main.usageKo, lim.usageKoMax);
    v.alternatives.forEach((a, i) => {
      checkEnExpression(add, ["alternatives", i, "expression"], a.expression, lim);
      checkKo(add, ["alternatives", i, "noteKo"], a.noteKo, lim.altNoteKoMax);
    });
    checkDistinct(add, v.main.expression, v.alternatives, "en");
    v.examples.forEach((x, i) => {
      const en = x.en.trim();
      if (en === "") add(["examples", i, "en"], "비었다");
      else {
        if (!phraseHasLatin(en)) add(["examples", i, "en"], "영어로 쓴다");
        if (phraseHasHangul(en)) add(["examples", i, "en"], "한글을 섞지 않는다");
        if (phraseHasPlaceholder(en, "en")) add(["examples", i, "en"], "자리 표시를 쓰지 않는다");
        const n = phraseEnWordCount(en);
        if (n < lim.exampleMin || n > lim.exampleMax) add(["examples", i, "en"], `${lim.exampleMin}~${lim.exampleMax}단어(지금 ${n})`);
      }
      checkKo(add, ["examples", i, "ko"], x.ko, 200);
    });
    checkDistinctExamples(add, v.examples.map((x) => x.en), "en");
  }) as unknown as z.ZodType<PhraseHelperEnOutput>;
}

/** 일본어 모드의 zod */
export function buildPhraseHelperJaZod(): z.ZodType<PhraseHelperJaOutput> {
  const lim = PHRASE_HELPER_LIMITS.japanese;
  return jaRawSchema.superRefine((v, ctx) => {
    const add: Issue = (path, message) => ctx.addIssue({ code: "custom", path, message });
    if (!checkStatus(add, v, lim) || v.main === null) return;
    checkCounts(add, v.alternatives, v.examples, lim);
    checkJaExpression(add, ["main"], v.main.expression, v.main.reading, lim);
    checkKo(add, ["main", "usageKo"], v.main.usageKo, lim.usageKoMax);
    v.alternatives.forEach((a, i) => {
      checkJaExpression(add, ["alternatives", i], a.expression, a.reading, lim);
      checkKo(add, ["alternatives", i, "noteKo"], a.noteKo, lim.altNoteKoMax);
    });
    checkDistinct(add, v.main.expression, v.alternatives, "ja");
    v.examples.forEach((x, i) => {
      const ja = x.ja.trim();
      if (ja === "") add(["examples", i, "ja"], "비었다");
      else {
        if (!phraseHasKana(ja) && !phraseHasHan(ja)) add(["examples", i, "ja"], "일본어로 쓴다");
        if (phraseHasHangul(ja)) add(["examples", i, "ja"], "한글을 섞지 않는다");
        if (phraseHasPlaceholder(ja, "ja")) add(["examples", i, "ja"], "자리 표시를 쓰지 않는다");
        const n = phraseJaCharCount(ja);
        if (n < lim.exampleMin || n > lim.exampleMax) add(["examples", i, "ja"], `${lim.exampleMin}~${lim.exampleMax}자(지금 ${n})`);
        const bad = checkJaReading(ja, x.reading);
        if (bad) add(["examples", i, "reading"], bad);
      }
      checkKo(add, ["examples", i, "ko"], x.ko, 200);
    });
    checkDistinctExamples(add, v.examples.map((x) => x.ja), "ja");
  }) as unknown as z.ZodType<PhraseHelperJaOutput>;
}

// ---------------------------------------------------------------------------
// 출력 다듬기 (§6 끝 — 재요청 없음)
// ---------------------------------------------------------------------------

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** 모든 글 칸의 앞뒤 공백을 걷고 연속 공백을 하나로. 구조·개수는 바꾸지 않는다 */
export function finalizePhraseHelperEnOutput(v: PhraseHelperEnOutput): PhraseHelperEnOutput {
  return {
    status: v.status,
    noteKo: v.noteKo === null ? null : tidy(v.noteKo),
    main: v.main === null ? null : { expression: tidy(v.main.expression), usageKo: tidy(v.main.usageKo) },
    alternatives: v.alternatives.map((a) => ({ expression: tidy(a.expression), noteKo: tidy(a.noteKo) })),
    examples: v.examples.map((x) => ({ en: tidy(x.en), ko: tidy(x.ko) })),
  };
}

export function finalizePhraseHelperJaOutput(v: PhraseHelperJaOutput): PhraseHelperJaOutput {
  return {
    status: v.status,
    noteKo: v.noteKo === null ? null : tidy(v.noteKo),
    main: v.main === null ? null : { expression: tidy(v.main.expression), reading: tidy(v.main.reading), register: v.main.register, usageKo: tidy(v.main.usageKo) },
    alternatives: v.alternatives.map((a) => ({ expression: tidy(a.expression), reading: tidy(a.reading), register: a.register, noteKo: tidy(a.noteKo) })),
    examples: v.examples.map((x) => ({ ja: tidy(x.ja), reading: tidy(x.reading), ko: tidy(x.ko) })),
  };
}

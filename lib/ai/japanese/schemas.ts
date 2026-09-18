/**
 * lib/ai/japanese/schemas.ts — 아빠의 일본어 호출 A(JLPT 단어 생성) 데이터 모델 + JSON Schema + zod
 * (docs/harness/japanese.md §2-3·§2-4·§5·§7-1)
 *
 * 이 파일이 4중 정의(프롬프트↔JSON Schema↔zod↔eval)의 뿌리다. 일본어 단어장 코드가 여기를 본다.
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 영어(은우·초등)와 달리 성인 JLPT 학습자다. "쉬운 말" 규칙이 없고, 등급 정확성이 우선이다.
 * 그 톤 차이는 prompts.ts가 지고, 이 파일은 형식(스키마·zod·후리가나 토큰)만 강제한다.
 *
 * ── 후리가나는 토큰 배열이다 (§5) ─────────────────────────────────────────────
 * 문자열 안에 루비를 끼워 넣지 않는다(`漢字(かんじ)` 금지). `JaToken{surface,reading}` 배열로 받고,
 * surface를 이어 붙이면 원문과 정확히 같아야 한다(zod 토큰 무결성). J0가 임시로 japanese-ruby-contract.ts에
 * 뒀던 JaToken을 여기로 옮겼다 — 그 파일은 이제 이 타입을 **타입 전용 재수출**한다(클라이언트 번들에 lib/ai 값이
 * 새지 않게).
 *
 * ── 전부 필수 nullable — 선택(?) 키 금지 (lib/store.ts 규약) ───────────────────
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";

// ---------------------------------------------------------------------------
// 후리가나 토큰 (§5) — 단일 정의처. ja-ruby.tsx(클라이언트)는 japanese-ruby-contract.ts를 거쳐 타입만 본다.
// ---------------------------------------------------------------------------

/** 후리가나 토큰 하나 — 표기(surface)와 그 위 독음(reading, 한자 포함 시에만). */
export interface JaToken {
  /** 원문 표기 조각(한자·가나·숫자·기호). 순서대로 이으면 원문과 같다 */
  surface: string;
  /** 히라가나 독음 — surface에 한자가 있을 때만. 없으면 null(루비를 달지 않는다) */
  reading: string | null;
}

// ---------------------------------------------------------------------------
// 유니온 상수 (as const 배열) — 스키마 enum·zod·UI가 같은 상수를 본다
// ---------------------------------------------------------------------------

/** JLPT 레벨 — 어려운 순서(N1이 최상급). 화면 버튼·태깅이 이 상수를 본다. */
export const JLPT_LEVELS = ["N1", "N2", "N3", "N4", "N5"] as const;
export type JlptLevel = (typeof JLPT_LEVELS)[number];

/** 일본어 품사 체계 (§2-3 enum 10종). 영어·한국어 품사 체계를 쓰지 않는다(§2-1 8번). */
export const JA_POS = [
  "명사", "동사(자)", "동사(타)", "い형용사", "な형용사", "부사", "조사", "접속사", "감동사", "표현",
] as const;
export type JaPos = (typeof JA_POS)[number];

/**
 * 주제 프리셋 (§0-2·§8-2) — 단어장 만들기 화면의 칩 목록. **여기 한 곳만** 둔다(화면이 제 목록을 갖지 않게).
 * 사용자는 이 외에 직접 입력도 할 수 있다(자유 문자열). 프리셋은 §8-2에 명시된 정식 목록이다.
 */
export const JA_VOCAB_TOPIC_PRESETS = ["여행(호텔)", "음식점", "취미", "상점", "가족"] as const;
export type JaVocabTopicPreset = (typeof JA_VOCAB_TOPIC_PRESETS)[number];

// ---------------------------------------------------------------------------
// 개수·길이·상한 — 생산자(zod)와 소비자(화면·라우트)의 단일 정의처.
// JSON Schema에는 개수 제약을 넣지 않는다(§1 공통 규칙, 배열 개수는 프롬프트+zod).
// ---------------------------------------------------------------------------

/** 한 레벨당 기본 단어 수 (§0-2 "레벨마다 10개"). count는 include를 포함한 전체 개수(§2-2). */
export const JA_VOCAB_DEFAULT_COUNT = 10;
/** 한 호출(레벨 1개)의 entries 상한 (§2-4 "entries 1~10"). */
export const JA_ENTRIES_MAX = 10;
/** 꼭 넣을 단어(include) 개수 상한 — 전체 개수를 넘을 수 없다(§2-2 "최대 count개"). */
export const JA_INCLUDE_MAX = JA_VOCAB_DEFAULT_COUNT;
/** include 한 단어의 길이 상한 (§2-2 "1~20자"). 라우트가 먼저 검증하지만 상수는 여기 단일 정의. */
export const JA_INCLUDE_WORD_MAX = 20;
/** 프롬프트로 넘기는 exclude 개수 상한 — 넘으면 최근 것 우선으로 자른다(§2-2). 진짜 방어선은 저장 재필터(§2-4). */
export const JA_EXCLUDE_PROMPT_MAX = 200;

/** 표제어(word) 길이 상한 */
export const JA_WORD_MAX = 30;
/** 전체 읽기(kana) 길이 상한 */
export const JA_KANA_MAX = 40;
/** 뜻 한 개(meaningsKo[])의 길이 상한 (§2-4 "각 1~60자") */
export const JA_MEANING_KO_MAX = 60;
/** 한 단어의 뜻 개수 (§2-4 "1~3개") */
export const JA_MEANINGS_MAX = 3;
/** 품사 개수 상한 (방어) */
export const JA_POS_MAX = 4;
/** 예문 일본어 길이 (§2-4 "example.ja 5~60자") */
export const JA_EXAMPLE_JA_MIN = 5;
export const JA_EXAMPLE_JA_MAX = 60;
/** 예문 한국어 번역 길이 상한 (방어) */
export const JA_EXAMPLE_KO_MAX = 120;

// ---------------------------------------------------------------------------
// TypeScript 타입 — 데이터 모델 (§7-1)
// ---------------------------------------------------------------------------

/** 예문 한 벌 — 일본어 문장 + 한국어 번역 + 후리가나 토큰. */
export interface JaExample {
  ja: string;
  ko: string;
  tokens: JaToken[];
}

/**
 * 호출 A가 단어 하나에 대해 내는 것 (모델 출력 — 레벨은 없다).
 * 레벨은 모델이 스스로 적게 하지 않고 코드가 붙인다(§2-4 4번) — 그래서 이 타입엔 level이 없다.
 */
export interface JaVocabGenEntry {
  word: string;
  kana: string;
  pos: JaPos[];
  meaningsKo: string[];
  example: JaExample;
  wordTokens: JaToken[];
}

/** 호출 A의 전체 출력 (레벨 1개분). */
export interface JaVocabGeneration {
  entries: JaVocabGenEntry[];
}

/**
 * 저장·표시에 쓰는 완성형 단어 항목 (§7-1). 후처리(applyVocabPostprocess)가 GenEntry에 level을 붙여 만든다.
 * level: 호출 A 생성분은 코드가 붙이고(§2-4 4번), 대화에서 담은 단어(collected)는 null(§7-5).
 */
export interface JaVocabEntry {
  word: string;
  kana: string;
  wordTokens: JaToken[];
  pos: JaPos[];
  meaningsKo: string[];
  example: JaExample;
  level: JlptLevel | null;
}

// ---------------------------------------------------------------------------
// 호출 A — ja_vocab_generation JSON Schema (스펙 §2-3 원문)
// 전 필드 required + additionalProperties:false. 개수 제약은 넣지 않는다(§1 공통 규칙).
// tokens는 $defs로 한 번 정의해 wordTokens·example.tokens가 $ref로 공유한다(스펙 원문 그대로).
// ---------------------------------------------------------------------------

export const JA_VOCAB_GENERATION_JSON_SCHEMA: StrictJsonSchema = {
  name: "ja_vocab_generation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["word", "kana", "pos", "meaningsKo", "example", "wordTokens"],
          properties: {
            word: { type: "string", description: "표기(한자가 있으면 한자)" },
            kana: { type: "string", description: "전체 읽기 — 히라가나만" },
            pos: {
              type: "array",
              items: {
                type: "string",
                enum: ["명사", "동사(자)", "동사(타)", "い형용사", "な형용사", "부사", "조사", "접속사", "감동사", "표현"],
              },
            },
            meaningsKo: { type: "array", items: { type: "string" } },
            example: {
              type: "object",
              additionalProperties: false,
              required: ["ja", "ko", "tokens"],
              properties: {
                ja: { type: "string" },
                ko: { type: "string" },
                tokens: { $ref: "#/$defs/tokens" },
              },
            },
            wordTokens: { $ref: "#/$defs/tokens" },
          },
        },
      },
    },
    $defs: {
      tokens: {
        type: "array",
        description: "후리가나 토큰 — surface를 이어 붙이면 원문이 된다",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["surface", "reading"],
          properties: {
            surface: { type: "string" },
            reading: { type: ["string", "null"], description: "한자일 때만 히라가나 읽기, 아니면 null" },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 문자 판정 헬퍼 (§2-4)
// ---------------------------------------------------------------------------

/** 히라가나(+장음부호 ー)만인가 — kana·reading 검증용. 외래어의 히라가나 독음(こーひー 등)을 위해 ー 허용. */
function isHiraganaOnly(s: string): boolean {
  return s.length > 0 && /^[぀-ゟー]+$/.test(s);
}

/** 한자(CJK 통합 한자·확장 A·반복부호 々)를 하나라도 포함하는가 — reading 정리의 근거. */
function hasKanji(s: string): boolean {
  return /[一-鿿㐀-䶿々]/.test(s);
}

/**
 * 토큰 전체가 한자만인가 — reading을 달 수 있는 토큰의 조건(§2-1-11·P1).
 * 오쿠리가나·활용 어미(促'す'·食べ'る')가 한자 토큰에 섞여 있으면 이 검사가 false다 → reading을 못 단다.
 */
function isAllKanji(s: string): boolean {
  return /^[一-鿿㐀-䶿々]+$/.test(s);
}

/** 한글(음절)을 하나라도 포함하는가 — 뜻·번역이 일본어만 온 경우를 거른다. */
function hasHangul(s: string): boolean {
  return /[가-힣]/.test(s);
}

// ---------------------------------------------------------------------------
// 호출 A — zod 이중 검증 (스펙 §2-4)
// JSON Schema가 못 잡는 것: 개수, 표제어 중복, 히라가나 전용, 한글 포함, 예문 길이, 토큰 무결성.
// reading 정리(한자 없는 토큰의 reading→null)는 거부가 아니라 transform으로 흡수한다.
// ---------------------------------------------------------------------------

/**
 * 후리가나 토큰 zod. reading을 단 토큰은 규칙이 셋이다(§2-1-11·§2-4·P1):
 * (a) surface가 **한자만**이어야 한다 — 오쿠리가나·활용 어미(促'す'·食べ'る')가 섞여 있으면 **거부**한다.
 *     그런 토큰은 한자 토큰과 오쿠리가나 토큰으로 갈라 내야 하고, 오쿠리가나 쪽은 reading이 null이어야 한다.
 * (b) 한자만인 토큰의 reading은 히라가나여야 한다(아니면 거부).
 * (c) 한자가 전혀 없는 토큰(가나·숫자·기호)에 reading이 붙어 있으면 null로 정리한다(거부 아님 — 의미를 해치지 않는다).
 */
const jaTokenSchema = z
  .object({
    surface: z.string().min(1),
    reading: z.string().nullable(),
  })
  .superRefine((t, ctx) => {
    if (t.reading === null) return;
    // (a) reading을 단 토큰의 surface는 한자만 — 한자+가나 혼합(오쿠리가나·활용 어미)이면 거부(P1)
    if (hasKanji(t.surface) && !isAllKanji(t.surface)) {
      ctx.addIssue({
        code: "custom",
        path: ["reading"],
        message: "reading을 단 토큰의 surface는 한자만이어야 합니다 (오쿠리가나·활용 어미는 별도 토큰으로 갈라 reading을 null로)",
      });
      return;
    }
    // (b) 한자만인 토큰의 reading은 히라가나
    if (isAllKanji(t.surface) && !isHiraganaOnly(t.reading)) {
      ctx.addIssue({ code: "custom", path: ["reading"], message: "reading은 히라가나만 (한자 토큰의 읽기)" });
    }
    // (c) 한자가 전혀 없는 토큰의 reading은 아래 transform이 null로 정리한다(거부 아님)
  })
  .transform((t): JaToken => (isAllKanji(t.surface) ? t : { surface: t.surface, reading: null }));

const jaExampleSchema = z.object({
  ja: z.string().trim().min(JA_EXAMPLE_JA_MIN).max(JA_EXAMPLE_JA_MAX),
  ko: z.string().trim().min(1).max(JA_EXAMPLE_KO_MAX),
  tokens: z.array(jaTokenSchema),
});

const jaVocabGenEntrySchema = z
  .object({
    word: z.string().trim().min(1).max(JA_WORD_MAX),
    kana: z.string().trim().min(1).max(JA_KANA_MAX),
    pos: z.array(z.enum(JA_POS)).min(1).max(JA_POS_MAX),
    meaningsKo: z.array(z.string().trim().min(1).max(JA_MEANING_KO_MAX)).min(1).max(JA_MEANINGS_MAX),
    example: jaExampleSchema,
    wordTokens: z.array(jaTokenSchema),
  })
  .superRefine((e, ctx) => {
    // kana는 히라가나만
    if (!isHiraganaOnly(e.kana)) {
      ctx.addIssue({ code: "custom", path: ["kana"], message: "kana는 히라가나만 (가타카나·한자·로마자 거부)" });
    }
    // 뜻은 한글을 포함해야 한다(일본어만 온 경우 거부)
    e.meaningsKo.forEach((m, i) => {
      if (!hasHangul(m)) {
        ctx.addIssue({ code: "custom", path: ["meaningsKo", i], message: "뜻(meaningsKo)에는 한글이 있어야 합니다" });
      }
    });
    // 번역은 한글을 포함해야 한다
    if (!hasHangul(e.example.ko)) {
      ctx.addIssue({ code: "custom", path: ["example", "ko"], message: "번역(example.ko)에는 한글이 있어야 합니다" });
    }
    // 토큰 무결성(핵심) — surface를 이어 붙이면 원문과 정확히 일치해야 한다
    if (e.wordTokens.map((t) => t.surface).join("") !== e.word) {
      ctx.addIssue({ code: "custom", path: ["wordTokens"], message: "wordTokens.surface를 이으면 word와 정확히 같아야 합니다" });
    }
    if (e.example.tokens.map((t) => t.surface).join("") !== e.example.ja) {
      ctx.addIssue({ code: "custom", path: ["example", "tokens"], message: "example.tokens.surface를 이으면 example.ja와 정확히 같아야 합니다" });
    }
  });

/**
 * 호출 A 결과의 zod 스키마 (§2-4). JSON Schema와 필드·타입이 1:1이고, 그 위에 개수·중복·무결성 검증을 얹는다.
 * 출력은 레벨이 없는 GenEntry 배열이다(레벨 태깅은 후처리 vocab.ts가 코드로 붙인다).
 */
export const jaVocabGenerationSchema = z
  .object({
    entries: z.array(jaVocabGenEntrySchema).min(1).max(JA_ENTRIES_MAX),
  })
  .superRefine((data, ctx) => {
    // 표제어(word) 중복 거부 — 같은 배치에서 같은 표기를 두 번 내면 거부
    const seen = new Set<string>();
    data.entries.forEach((e, i) => {
      const key = e.word.trim();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["entries", i, "word"], message: `표제어 중복 금지: ${e.word}` });
      }
      seen.add(key);
    });
  });

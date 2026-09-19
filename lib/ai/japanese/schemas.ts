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
/** 일일정의(definitionJa) 길이 — 짧고 쉬운 정의가 이 기능에선 더 좋은 출력이다(N5 出口→「外に出るところ」7자, 水→「のむもの」4자).
 *  하한을 15로 두면 모델이 정의를 억지로 늘려 "표제어보다 쉽게"와 충돌하고 재요청 실패로 생성 전체가 throw됐다(P0).
 *  그래서 min 4로 낮춘다. max 60은 유지. */
export const JA_DEFINITION_JA_MIN = 4;
export const JA_DEFINITION_JA_MAX = 60;

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
  /** 그 단어를 한눈에 떠올리게 하는 이모지 1개. 추상어·문법어는 null (호출 A가 함께 낸다 — 별도 보강 호출 없음) */
  imageEmoji: string | null;
  /** 일일정의 — 그 단어를 일본어로 짧게 풀이한 한 문장(평문). 표제어를 포함하지 않는다(정답 노출 금지). 쉽게 못 풀면 null. */
  definitionJa: string | null;
  /** 일일정의의 후리가나 토큰(§5). surface를 이으면 definitionJa와 같다. definitionJa가 null이면 null. 평문(definitionJa)은 TTS·시험 텍스트, 토큰은 루비 렌더용(example의 {ja,tokens} 패턴). */
  definitionTokens: JaToken[] | null;
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
  /** 그 단어를 나타내는 이모지 1개(호출 A 산출). 없으면 null → 화면은 resolveJaGlyph로 첫 글자 배지 폴백 */
  imageEmoji: string | null;
  /** 일일정의(일본어 뜻풀이 한 문장, 호출 A 산출). 표제어 미포함. 없으면 null(구 레코드도 null 폴백). def-to-word 시험 문제로 쓴다(평문). */
  definitionJa: string | null;
  /** 일일정의의 후리가나 토큰(§5). 화면이 루비로 렌더. definitionJa가 null이면 null. 구 레코드는 normalizeJaVocabEntry가 null로 채운다. */
  definitionTokens: JaToken[] | null;
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
          required: ["word", "kana", "pos", "meaningsKo", "example", "wordTokens", "imageEmoji", "definitionJa", "definitionTokens"],
          properties: {
            word: { type: "string", description: "표기(한자가 있으면 한자)" },
            kana: { type: "string", description: "전체 읽기 — 히라가나만" },
            imageEmoji: { type: ["string", "null"], description: "그 단어를 나타내는 이모지 1개. 추상어·문법어면 null" },
            definitionJa: { type: ["string", "null"], description: "일본어 뜻풀이 한 문장(표제어 미포함). 쉽게 못 풀면 null" },
            definitionTokens: {
              type: ["array", "null"],
              description: "definitionJa의 후리가나 토큰. surface를 이으면 definitionJa와 같다. definitionJa가 null이면 null",
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

/** 이모지 문자열 최대 길이 — ZWJ 시퀀스(가족 이모지 등)도 UTF-16으로는 여러 코드유닛이라 방어 상한. 실제 "1개"는 자소 검사가 담당. */
export const JA_IMAGE_EMOJI_MAX = 32;

/** 자소(grapheme) 개수 — 이모지 "1개" 판정용. Intl.Segmenter가 ZWJ 시퀀스·변형 선택자를 1로 센다. */
function graphemeCount(s: string): number {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(s)) n++;
    return n;
  } catch {
    return Array.from(s).length; // 폴백: 코드포인트 수
  }
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
 *
 * 숙어 묶기(目標→目標(もくひょう))는 **프롬프트 규칙이지 zod 규칙이 아니다** — 목標를 目(もく)+標(ひょう)로 쪼갠 것도
 * 두 토큰 다 한자만이라 형식상 유효해 코드로 막을 수 없다(§5). zod는 여기(reading은 한자 토큰에만)까지만 강제한다.
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
    imageEmoji: z.string().trim().min(1).max(JA_IMAGE_EMOJI_MAX).nullable(),
    definitionJa: z.string().trim().min(JA_DEFINITION_JA_MIN).max(JA_DEFINITION_JA_MAX).nullable(),
    definitionTokens: z.array(jaTokenSchema).nullable(),
  })
  .superRefine((e, ctx) => {
    // kana는 히라가나만
    if (!isHiraganaOnly(e.kana)) {
      ctx.addIssue({ code: "custom", path: ["kana"], message: "kana는 히라가나만 (가타카나·한자·로마자 거부)" });
    }
    // 일일정의(definitionJa)가 null이 아니면: 일본 문자 포함 + 표제어(word)를 포함하지 않음(정답 노출 금지, §작업1)
    if (e.definitionJa !== null) {
      if (!hasJapanese(e.definitionJa)) {
        ctx.addIssue({ code: "custom", path: ["definitionJa"], message: "definitionJa에는 일본 문자가 있어야 합니다" });
      }
      if (e.definitionJa.includes(e.word)) {
        ctx.addIssue({ code: "custom", path: ["definitionJa"], message: "definitionJa에 표제어(word)를 그대로 넣을 수 없습니다 (정답 노출)" });
      }
      // 정의가 있으면 후리가나 토큰도 있어야 하고, surface를 이으면 definitionJa와 정확히 같아야 한다(무결성)
      if (e.definitionTokens === null) {
        ctx.addIssue({ code: "custom", path: ["definitionTokens"], message: "definitionJa가 있으면 definitionTokens도 있어야 합니다" });
      } else if (e.definitionTokens.map((t) => t.surface).join("") !== e.definitionJa) {
        ctx.addIssue({ code: "custom", path: ["definitionTokens"], message: "definitionTokens.surface를 이으면 definitionJa와 정확히 같아야 합니다" });
      }
    } else if (e.definitionTokens !== null) {
      // 정의가 null이면 토큰도 null(고아 토큰 금지)
      ctx.addIssue({ code: "custom", path: ["definitionTokens"], message: "definitionJa가 null이면 definitionTokens도 null이어야 합니다" });
    }
    // imageEmoji가 null이 아니면 이모지 정확히 1개(그림문자)여야 한다 — 글자·여러 개 거부(§작업1)
    if (e.imageEmoji !== null) {
      if (graphemeCount(e.imageEmoji) !== 1) {
        ctx.addIssue({ code: "custom", path: ["imageEmoji"], message: "imageEmoji는 정확히 1개여야 합니다 (여러 개 이어 붙이지 마세요)" });
      }
      if (!/\p{Extended_Pictographic}/u.test(e.imageEmoji)) {
        ctx.addIssue({ code: "custom", path: ["imageEmoji"], message: "imageEmoji는 이모지(그림문자)여야 합니다 (글자·숫자·문장부호 거부)" });
      }
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

// ---------------------------------------------------------------------------
// 그림 우선순위 — resolveJaGlyph (영어 resolveVocabImage 관용구)
// 단어 그림을 고르는 곳이 여러 화면(표·시험)에 흩어지면 반드시 어긋난다. 여기 한 곳만 판정한다.
// imageEmoji가 있으면 이모지, 없으면 표기(word) 첫 글자(한자) 배지로 떨어뜨려 UI가 빈자리를 안 만든다.
// ---------------------------------------------------------------------------

export type JaGlyph =
  | { kind: "emoji"; emoji: string }
  | { kind: "letter"; letter: string };

/**
 * 단어의 그림을 우선순위대로 고른다: imageEmoji > 표기 첫 글자 배지.
 * 폴백(첫 글자)은 화면이 아니라 여기서 정한다 — 이모지 유무 판정이 화면마다 갈리지 않게(영어 resolveVocabImage와 같은 이유).
 * `imageEmoji`는 느슨하게 받는다(구 레코드는 이 필드가 undefined일 수 있다 — 저장 정규화가 늦어도 화면이 안 깨지게).
 */
export function resolveJaGlyph(entry: { imageEmoji?: string | null; word: string }): JaGlyph {
  if (entry.imageEmoji && entry.imageEmoji.trim() !== "") {
    return { kind: "emoji", emoji: entry.imageEmoji };
  }
  const letter = Array.from(entry.word.trim())[0] ?? "?";
  return { kind: "letter", letter };
}

// ===========================================================================
// 호출 D — 한자 정보 생성 (§12-2). 단어장에서 파생된 한자에 한국 한자음·음독·훈독·뜻을 채운다.
// 이미 정보가 있는 한자는 요청에 넣지 않는다(불변 규약, kanji.ts가 선별). 요청 밖 한자는 코드가 버린다.
// ===========================================================================

/** 한 번에 정보를 채우는 한자 수(§12-2 "10자씩 배치"). */
export const JA_KANJI_BATCH_SIZE = 10;
/** 음독·훈독 각 최대 개수(§12-2-3 "각 0~3개"). */
export const JA_KANJI_READINGS_MAX = 3;
/** 한자 뜻 길이 상한(§12-2-3 "1~20자"). */
export const JA_KANJI_MEANING_KO_MAX = 20;
/** 호출 D 입력에 실어 보내는 한자당 예시 단어 수 상한(맥락). */
export const JA_KANJI_SAMPLE_WORDS_MAX = 5;

/** 한 글자(코드포인트 1개)이고 한자인가 — kanji 필드 검증용. */
function isSingleKanji(s: string): boolean {
  return Array.from(s).length === 1 && isAllKanji(s);
}
/** 한 글자(코드포인트 1개)이고 한글 음절인가 — koReading 검증용. */
function isSingleHangul(s: string): boolean {
  return Array.from(s).length === 1 && /[가-힣]/.test(s);
}

/**
 * 호출 D가 한자 하나에 대해 내는 정보(= 저장 레코드 본체, §12-3의 id/model/createdAt 제외).
 * koReading: 한국 한자음 한 글자(約→약). 한국에서 안 쓰는 한자는 null. onyomi/kunyomi: 히라가나. meaningKo: 한국어 뜻.
 */
export interface JaKanjiInfo {
  kanji: string;
  koReading: string | null;
  onyomi: string[];
  kunyomi: string[];
  meaningKo: string;
}

/** 호출 D의 전체 출력(배치). */
export interface JaKanjiInfoGeneration {
  items: JaKanjiInfo[];
}

// --- 호출 D JSON Schema (§12-2-2 원문) ---
export const JA_KANJI_INFO_JSON_SCHEMA: StrictJsonSchema = {
  name: "ja_kanji_info",
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
          required: ["kanji", "koReading", "onyomi", "kunyomi", "meaningKo"],
          properties: {
            kanji: { type: "string", description: "한자 한 글자" },
            koReading: { type: ["string", "null"], description: "한국 한자음 한 글자. 없으면 null" },
            onyomi: { type: "array", items: { type: "string" }, description: "음독(히라가나)" },
            kunyomi: { type: "array", items: { type: "string" }, description: "훈독(히라가나, 사전형)" },
            meaningKo: { type: "string", description: "한국어 뜻(짧게)" },
          },
        },
      },
    },
  },
};

// --- 호출 D zod (§12-2-3) ---
const jaKanjiInfoSchema = z
  .object({
    kanji: z.string().trim(),
    koReading: z.string().trim().nullable(),
    onyomi: z.array(z.string().trim().min(1)).max(JA_KANJI_READINGS_MAX),
    kunyomi: z.array(z.string().trim().min(1)).max(JA_KANJI_READINGS_MAX),
    meaningKo: z.string().trim().min(1).max(JA_KANJI_MEANING_KO_MAX),
  })
  .superRefine((k, ctx) => {
    // kanji는 한자 한 글자
    if (!isSingleKanji(k.kanji)) {
      ctx.addIssue({ code: "custom", path: ["kanji"], message: "kanji는 한자 한 글자여야 합니다" });
    }
    // koReading은 한글 한 글자이거나 null
    if (k.koReading !== null && !isSingleHangul(k.koReading)) {
      ctx.addIssue({ code: "custom", path: ["koReading"], message: "koReading은 한글 한 글자이거나 null이어야 합니다" });
    }
    // onyomi·kunyomi는 히라가나만
    k.onyomi.forEach((o, i) => {
      if (!isHiraganaOnly(o)) ctx.addIssue({ code: "custom", path: ["onyomi", i], message: "onyomi는 히라가나만" });
    });
    k.kunyomi.forEach((o, i) => {
      if (!isHiraganaOnly(o)) ctx.addIssue({ code: "custom", path: ["kunyomi", i], message: "kunyomi는 히라가나만" });
    });
    // meaningKo는 한글 포함
    if (!hasHangul(k.meaningKo)) {
      ctx.addIssue({ code: "custom", path: ["meaningKo"], message: "meaningKo에는 한글이 있어야 합니다" });
    }
  });

/**
 * 호출 D 결과의 zod. 형식만 검증한다 — "요청한 한자만" 필터·"빠진 한자 보고"는 후처리(kanji.ts)가 한다.
 * items 상한은 방어값(배치 10이지만 모델이 dup/여분을 낼 수 있어 넉넉히; 여분은 후처리가 버린다).
 */
export const jaKanjiInfoGenerationSchema = z.object({
  items: z.array(jaKanjiInfoSchema).min(1).max(50),
});

// ===========================================================================
// 호출 B — 대화문 전사 (vision, §3) / 호출 C — 대화 학습 해설 (§4)
// 토큰 무결성(§2-4)·jaTokenSchema·jaExampleSchema를 그대로 재사용한다(같은 파일).
// ===========================================================================

/** 일본 문자(히라가나·가타카나·한자)를 하나라도 포함하는가 — 일본어 필드 검증용(§4-4). */
function hasJapanese(s: string): boolean {
  return /[぀-ゟ゠-ヿ一-鿿㐀-䶿々]/.test(s);
}
/** 토큰 surface를 이으면 원문과 같은가 — 토큰 무결성(§2-4). */
function tokensJoinEqual(tokens: readonly JaToken[], text: string): boolean {
  return tokens.map((t) => t.surface).join("") === text;
}

/** 대화 배치 크기 — 스크린샷을 이 단위로 나눠 호출한다(§3-4). */
export const JA_DIALOG_BATCH_SIZE = 4;
/** 호출 C 개수 상한(§4-4). */
export const JA_DIALOG_GOODS_MAX = 6;
export const JA_DIALOG_FIXES_MAX = 8;
export const JA_DIALOG_ITEMS_MIN = 2;
export const JA_DIALOG_ITEMS_MAX = 8;
export const JA_DIALOG_PRACTICE_MIN = 1;
export const JA_DIALOG_PRACTICE_MAX = 5;
/** 텍스트 길이 방어 상한 */
export const JA_DIALOG_TEXT_MAX = 400;

export const JA_DIALOG_SPEAKERS = ["partner", "me", "unknown"] as const;
export type JaDialogSpeaker = (typeof JA_DIALOG_SPEAKERS)[number];
export const JA_DIALOG_FEEDBACK_KINDS = ["praise", "tip"] as const;
export type JaDialogFeedbackKind = (typeof JA_DIALOG_FEEDBACK_KINDS)[number];

// --- 호출 B 타입 (§3) ---
export interface JaDialogFeedback {
  kind: JaDialogFeedbackKind;
  textKo: string;
}
export interface JaDialogTurn {
  speaker: JaDialogSpeaker;
  ja: string;
  tokens: JaToken[];
  feedback: JaDialogFeedback | null;
}
export interface JaDialogExtraction {
  focusKo: string | null;
  turns: JaDialogTurn[];
  partial: boolean;
}

// --- 호출 C 타입 (§4) ---
export interface JaDialogGood {
  quoteJa: string;
  whyKo: string;
}
export interface JaDialogFix {
  originalJa: string;
  betterJa: string;
  whyKo: string;
  grammarKo: string | null;
}
/** 해설이 뽑은 학습 어휘 — J5에서 단어장(collected)으로 담기 위해 word/kana/meaningKo/example 모양을 호출 A entry와 맞춘다(§4-4). */
export interface JaDialogItem {
  word: string;
  kana: string;
  meaningKo: string;
  usageKo: string;
  example: JaExample;
  wordTokens: JaToken[];
}
export interface JaDialogCoaching {
  summaryKo: string;
  goods: JaDialogGood[];
  fixes: JaDialogFix[];
  items: JaDialogItem[];
  practice: JaExample[];
}

// --- 호출 B JSON Schema (§3-3 원문) ---
export const JA_DIALOG_EXTRACTION_JSON_SCHEMA: StrictJsonSchema = {
  name: "ja_dialog_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["focusKo", "turns", "partial"],
    properties: {
      focusKo: { type: ["string", "null"], description: "상단 학습 요점(한국어). 없으면 null" },
      turns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["speaker", "ja", "tokens", "feedback"],
          properties: {
            speaker: { type: "string", enum: ["partner", "me", "unknown"] },
            ja: { type: "string", description: "발화 원문(일본어)" },
            tokens: { $ref: "#/$defs/tokens" },
            feedback: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["kind", "textKo"],
              properties: {
                kind: { type: "string", enum: ["praise", "tip"] },
                textKo: { type: "string", description: "듀오링고가 보여준 피드백 원문" },
              },
            },
          },
        },
      },
      partial: { type: "boolean", description: "잘려서 못 읽은 부분이 있으면 true" },
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

// --- 호출 C JSON Schema (§4-3 원문) ---
export const JA_DIALOG_COACHING_JSON_SCHEMA: StrictJsonSchema = {
  name: "ja_dialog_coaching",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summaryKo", "goods", "fixes", "items", "practice"],
    properties: {
      summaryKo: { type: "string", description: "이번 대화 총평 2~3문장(한국어)" },
      goods: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["quoteJa", "whyKo"],
          properties: { quoteJa: { type: "string" }, whyKo: { type: "string" } },
        },
      },
      fixes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["originalJa", "betterJa", "whyKo", "grammarKo"],
          properties: {
            originalJa: { type: "string" },
            betterJa: { type: "string" },
            whyKo: { type: "string" },
            grammarKo: { type: ["string", "null"], description: "관련 문법 이름. 없으면 null" },
          },
        },
      },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["word", "kana", "meaningKo", "usageKo", "example", "wordTokens"],
          properties: {
            word: { type: "string" },
            kana: { type: "string" },
            meaningKo: { type: "string" },
            usageKo: { type: "string" },
            example: { $ref: "#/$defs/example" },
            wordTokens: { $ref: "#/$defs/tokens" },
          },
        },
      },
      practice: {
        type: "array",
        items: { $ref: "#/$defs/example" },
      },
    },
    $defs: {
      example: {
        type: "object",
        additionalProperties: false,
        required: ["ja", "ko", "tokens"],
        properties: { ja: { type: "string" }, ko: { type: "string" }, tokens: { $ref: "#/$defs/tokens" } },
      },
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

// --- 호출 B zod (§3-4) ---
const jaDialogTurnSchema = z
  .object({
    speaker: z.enum(JA_DIALOG_SPEAKERS),
    ja: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX),
    tokens: z.array(jaTokenSchema),
    feedback: z
      .object({ kind: z.enum(JA_DIALOG_FEEDBACK_KINDS), textKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX) })
      .nullable(),
  })
  .superRefine((t, ctx) => {
    if (!tokensJoinEqual(t.tokens, t.ja)) {
      ctx.addIssue({ code: "custom", path: ["tokens"], message: "tokens.surface를 이으면 ja와 정확히 같아야 합니다" });
    }
  });

export const jaDialogExtractionSchema = z.object({
  focusKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).nullable(),
  turns: z.array(jaDialogTurnSchema).min(1),
  partial: z.boolean(),
});

// --- 호출 C zod (§4-4) ---
const jaDialogItemSchema = z
  .object({
    word: z.string().trim().min(1).max(JA_WORD_MAX),
    kana: z.string().trim().min(1).max(JA_KANA_MAX),
    meaningKo: z.string().trim().min(1).max(JA_MEANING_KO_MAX),
    usageKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX),
    example: jaExampleSchema,
    wordTokens: z.array(jaTokenSchema),
  })
  .superRefine((it, ctx) => {
    if (!isHiraganaOnly(it.kana)) ctx.addIssue({ code: "custom", path: ["kana"], message: "kana는 히라가나만" });
    if (!hasHangul(it.meaningKo)) ctx.addIssue({ code: "custom", path: ["meaningKo"], message: "meaningKo에는 한글이 있어야 합니다" });
    if (!hasHangul(it.usageKo)) ctx.addIssue({ code: "custom", path: ["usageKo"], message: "usageKo에는 한글이 있어야 합니다" });
    if (!hasHangul(it.example.ko)) ctx.addIssue({ code: "custom", path: ["example", "ko"], message: "example.ko에는 한글이 있어야 합니다" });
    if (!tokensJoinEqual(it.wordTokens, it.word)) ctx.addIssue({ code: "custom", path: ["wordTokens"], message: "wordTokens.surface를 이으면 word와 같아야 합니다" });
    if (!tokensJoinEqual(it.example.tokens, it.example.ja)) ctx.addIssue({ code: "custom", path: ["example", "tokens"], message: "example.tokens.surface를 이으면 example.ja와 같아야 합니다" });
  });

const jaExampleWithIntegrity = jaExampleSchema.superRefine((ex, ctx) => {
  if (!hasHangul(ex.ko)) ctx.addIssue({ code: "custom", path: ["ko"], message: "ko에는 한글이 있어야 합니다" });
  if (!tokensJoinEqual(ex.tokens, ex.ja)) ctx.addIssue({ code: "custom", path: ["tokens"], message: "tokens.surface를 이으면 ja와 같아야 합니다" });
});

export const jaDialogCoachingSchema = z.object({
  summaryKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX * 2).refine(hasHangul, { message: "summaryKo에는 한글이 있어야 합니다" }),
  goods: z
    .array(
      z.object({
        quoteJa: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).refine(hasJapanese, { message: "quoteJa에는 일본 문자가 있어야 합니다" }),
        whyKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).refine(hasHangul, { message: "whyKo에는 한글이 있어야 합니다" }),
      }),
    )
    .max(JA_DIALOG_GOODS_MAX),
  fixes: z
    .array(
      z.object({
        originalJa: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).refine(hasJapanese, { message: "originalJa에는 일본 문자가 있어야 합니다" }),
        betterJa: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).refine(hasJapanese, { message: "betterJa에는 일본 문자가 있어야 합니다" }),
        whyKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).refine(hasHangul, { message: "whyKo에는 한글이 있어야 합니다" }),
        grammarKo: z.string().trim().min(1).max(JA_DIALOG_TEXT_MAX).nullable(),
      }),
    )
    .max(JA_DIALOG_FIXES_MAX),
  items: z.array(jaDialogItemSchema).min(JA_DIALOG_ITEMS_MIN).max(JA_DIALOG_ITEMS_MAX),
  practice: z.array(jaExampleWithIntegrity).min(JA_DIALOG_PRACTICE_MIN).max(JA_DIALOG_PRACTICE_MAX),
});

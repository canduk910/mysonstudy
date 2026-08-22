/**
 * lib/ai/english/vocabbook-schemas.ts — 단어장 정복 V1 데이터 모델 + 호출 C 스키마
 * (docs/harness/english.md §7-3·§7-4)
 *
 * 이 파일이 4중 정의(프롬프트↔JSON Schema↔zod↔eval)의 뿌리다. 다른 모든 단어장 코드가 여기를 본다.
 *
 * - `VOCAB_EXTRACTION_JSON_SCHEMA`는 스펙 §7-3 원문 그대로 (Structured Outputs strict 모드용).
 *   배열 개수 제약(minItems/maxItems)은 스키마에 넣지 않는다 — 프롬프트 + zod가 담당(§1 공통 규칙).
 * - zod는 §7-4의 추가 검증(개수·길이·대괄호·번호 중복·페이지 게이트)을 superRefine으로 구현한다.
 * - `VocabItem`(호출 B 산출물, schemas.ts)과는 계약이 정반대다. 그건 AI 창작 예문이고, 이건
 *   책 원문 전사다. 두 타입을 섞지 말 것 — 그래서 파일을 따로 둔다.
 *
 * ## 세 덩이로 나눈 출처 (VocabEntry)
 * - (A) 책 전사: no·word·ipa·pos·meaningsKo·examples·related — 판독(호출 C)이 책 그대로 옮긴다. 창작 금지.
 * - (B) AI 창작: definitionEn·imageEmoji·imageSvg — 호출 D(V3)가 채운다. V1에서는 전부 null.
 * - (C) 앱 부착: photoIndex(앱이 사진 인덱스 부여) + confidence·partial(호출 C가 판독하며 매긴 판정).
 *   confidence·partial은 사진을 본 모델만 매길 수 있어 호출 C 출력에 담기지만, 최종적으로
 *   VocabEntry의 (C) 덩이로 굳는다. 이 배치 근거는 build 리포트 "스펙 공백" 참고.
 *
 * ## 전부 필수 nullable — 선택(?) 키 금지 (lib/store.ts:73 규약)
 * Firestore가 undefined를 거부하고, 근거 유실을 사람이 아니라 타입이 막게 하려는 것이다.
 * 값이 없을 수 있는 자리는 `T | null`, 항상 있는 자리(enum·배열·number)는 non-null로 둔다.
 */

import { z } from "zod";
import type { StrictJsonSchema } from "./schemas";

// ---------------------------------------------------------------------------
// 유니온 상수 (as const 배열) — 스키마 enum·zod·UI 라벨이 같은 상수를 쓴다
// ---------------------------------------------------------------------------

/** 품사 한글 약자. 호출 C가 이 중에서 고른다 (프롬프트 §7-1과 목록이 같아야 한다). */
export const PARTS_OF_SPEECH = [
  "명", "대", "동", "형", "부", "전", "접", "감", "관", "수",
] as const;
export type PartOfSpeech = (typeof PARTS_OF_SPEECH)[number];

/** 품사 약자 → 풀이 (UI 툴팁용). 문구를 따로 적지 말고 이 상수를 쓴다. */
export const PART_OF_SPEECH_LABELS_KO: Record<PartOfSpeech, string> = {
  명: "명사",
  대: "대명사",
  동: "동사",
  형: "형용사",
  부: "부사",
  전: "전치사",
  접: "접속사",
  감: "감탄사",
  관: "관사",
  수: "수사",
};

/** 관련어 종류 — 책이 함께 실은 유의어·반의어·파생어. */
export const RELATED_KINDS = ["synonym", "antonym", "derivative"] as const;
export type RelatedKind = (typeof RELATED_KINDS)[number];

/** 관련어 종류 → 한글 라벨 (UI). */
export const RELATED_KIND_LABELS_KO: Record<RelatedKind, string> = {
  synonym: "유의어",
  antonym: "반의어",
  derivative: "파생어",
};

/** 판독 신뢰도 — low면 재촬영 유도 대상 (호출 A′ SceneConfidence와 같은 3단계). */
export const VOCAB_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type VocabConfidence = (typeof VOCAB_CONFIDENCE_LEVELS)[number];

// ---------------------------------------------------------------------------
// 길이·개수 상한 — 생산자(호출 C zod)와 소비자(저장·검토 화면)의 단일 정의처.
// JSON Schema에는 넣지 않는다 (strict 모드 규약상 길이·개수는 zod 담당, §1 공통 규칙).
// 값이 두 곳에 흩어지면 반드시 어긋난다 — SIGHT_WORDS를 한 곳에만 둔 것과 같은 이유.
// ---------------------------------------------------------------------------

/** 표제어 최대 길이 — 영단어 하나 기준으로 한참 넉넉하다 */
export const VOCAB_WORD_MAX = 60;
/** 발음기호 최대 길이 */
export const VOCAB_IPA_MAX = 120;
/** 번호 최대 길이 — "0001" 수준 */
export const VOCAB_NO_MAX = 12;
/** 한글 뜻 한 개의 최대 길이 */
export const VOCAB_MEANING_KO_MAX = 200;
/** 예문 영어/한글 각각의 최대 길이 */
export const VOCAB_EXAMPLE_EN_MAX = 300;
export const VOCAB_EXAMPLE_KO_MAX = 300;
/** 관련어 단어/뜻 각각의 최대 길이 */
export const VOCAB_RELATED_WORD_MAX = 60;
export const VOCAB_RELATED_GLOSS_MAX = 200;
/** 단원 라벨(예: "DAY 01") 최대 길이 */
export const VOCAB_DAY_LABEL_MAX = 60;
/** 영영 정의(V3 호출 D 산출물) 최대 길이 — 스키마 확장을 미리 열어 둔다 */
export const VOCAB_DEFINITION_EN_MAX = 300;

/** 한 항목의 배열 필드 상한 */
export const VOCAB_POS_MAX = 6;
export const VOCAB_MEANINGS_MAX = 12;
export const VOCAB_EXAMPLES_MAX = 12;
export const VOCAB_RELATED_MAX = 20;
/** 사진 1장이 담는 항목 수 상한 — 2단 밀집 지면이라도 한 면에 이만큼 넘지 않는다 */
export const VOCAB_ENTRIES_PER_PAGE_MAX = 40;

// ---------------------------------------------------------------------------
// TypeScript 타입 — 데이터 모델(계획 §데이터 모델)
// 주의: strict JSON Schema는 "선택" 필드를 null 유니온으로 내보내므로 `?: T`가 아니라
// `T | null`로 표기해 와이어 포맷·저장 포맷과 호환되게 한다 (선택 키 금지).
// ---------------------------------------------------------------------------

/** 책 예문 한 쌍 (영어 문장 + 한글 해석). ko는 책에 없을 수 있어 빈 문자열 허용. */
export interface VocabExample {
  en: string;
  ko: string;
}

/** 책이 함께 실은 관련어 하나. */
export interface VocabRelated {
  kind: RelatedKind;
  word: string;
  glossKo: string | null;
}

/**
 * 호출 C가 사진 1장에서 뽑아낸 단어 항목 (책 전사 + 판독 판정).
 * photoIndex(어느 사진인지)와 (B) AI 창작 필드는 여기 없다 — 앱이 나중에 붙인다.
 */
export interface VocabExtractEntry {
  /** 단어 앞 번호(예: "0001"). 안 보이면 null */
  no: string | null;
  /** 표제어(영단어) */
  word: string;
  /** 발음기호 — 대괄호 [ ]는 벗겨 안쪽만 저장. 없으면 null */
  ipa: string | null;
  /** 품사 한글 약자 (여러 개 가능) */
  pos: PartOfSpeech[];
  /** 한글 뜻 (여러 개 가능) */
  meaningsKo: string[];
  /** 책 예문 */
  examples: VocabExample[];
  /** 유의어·반의어·파생어 */
  related: VocabRelated[];
  /** 사진 밖으로 잘려 일부만 보이면 true */
  partial: boolean;
  /** 판독 신뢰도 */
  confidence: VocabConfidence;
}

/** 호출 C의 페이지 단위 출력 (사진 1장). */
export interface VocabExtraction {
  /** 단어장 페이지가 맞는지 — 아니면 false + entries 빈 배열 */
  isVocabPage: boolean;
  /** 페이지에 보이는 단원 표기(예: "DAY 01"). 없으면 null */
  dayLabel: string | null;
  entries: VocabExtractEntry[];
}

/**
 * 저장·표시에 쓰는 완성형 단어 항목 (세 덩이 전부).
 * 병합(mergeVocabPages)이 VocabExtractEntry + photoIndex로 이걸 만들고 (B)는 null로 연다.
 */
export interface VocabEntry {
  // (A) 책 전사 — 창작 금지
  no: string | null;
  word: string;
  ipa: string | null;
  pos: PartOfSpeech[];
  meaningsKo: string[];
  examples: VocabExample[];
  related: VocabRelated[];
  // (B) AI 창작 — 호출 D(V3)가 채운다. V1에서는 전부 null. imageSvg는 지금 항상 null(마이그레이션 없이 SVG를 얹을 자리)
  definitionEn: string | null;
  imageEmoji: string | null;
  imageSvg: string | null;
  // (C) 앱 부착
  photoIndex: number;
  confidence: VocabConfidence;
  partial: boolean;
}

// ---------------------------------------------------------------------------
// 호출 C — vocab_extraction JSON Schema (스펙 §7-3 원문)
// 모든 필드 required + 모든 객체 additionalProperties:false (strict 모드 규약).
// 개수·길이 제약은 넣지 않는다 — zod가 담당한다.
// ---------------------------------------------------------------------------

export const VOCAB_EXTRACTION_JSON_SCHEMA: StrictJsonSchema = {
  name: "vocab_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isVocabPage: { type: "boolean", description: "단어장 페이지가 맞는지" },
      dayLabel: { type: ["string", "null"], description: '예: "DAY 01". 안 보이면 null' },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            no: { type: ["string", "null"], description: '단어 번호(예: "0001"). 안 보이면 null' },
            word: { type: "string", description: "표제어(영단어)" },
            ipa: { type: ["string", "null"], description: "발음기호 — 대괄호 벗겨 안쪽만. 없으면 null" },
            pos: {
              type: "array",
              items: { type: "string", enum: [...PARTS_OF_SPEECH] },
              description: "품사 한글 약자 (여러 개 가능)",
            },
            meaningsKo: {
              type: "array",
              items: { type: "string" },
              description: "한글 뜻 (책 순서대로, 여러 개 가능)",
            },
            examples: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  en: { type: "string" },
                  ko: { type: "string" },
                },
                required: ["en", "ko"],
              },
            },
            related: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: [...RELATED_KINDS] },
                  word: { type: "string" },
                  glossKo: { type: ["string", "null"] },
                },
                required: ["kind", "word", "glossKo"],
              },
            },
            partial: { type: "boolean", description: "사진 밖으로 잘려 일부만 보이면 true" },
            confidence: { type: "string", enum: [...VOCAB_CONFIDENCE_LEVELS] },
          },
          required: [
            "no", "word", "ipa", "pos", "meaningsKo", "examples", "related",
            "partial", "confidence",
          ],
        },
      },
    },
    required: ["isVocabPage", "dayLabel", "entries"],
  },
};

// ---------------------------------------------------------------------------
// 호출 C — zod 이중 검증 (스펙 §7-4)
// JSON Schema가 못 잡는 것: 개수 상한, 길이 상한, 대괄호 잔존, 번호 중복, 페이지 게이트.
// ---------------------------------------------------------------------------

const vocabExampleSchema = z.object({
  // en은 예문이 성립하려면 반드시 있어야 한다. ko는 책에 한글 해석이 없을 수 있어 빈 문자열 허용
  // (없는 해석을 지어내게 하지 않으려는 것 — 창작 금지 원칙).
  en: z.string().trim().min(1).max(VOCAB_EXAMPLE_EN_MAX),
  ko: z.string().trim().max(VOCAB_EXAMPLE_KO_MAX),
});

const vocabRelatedSchema = z.object({
  kind: z.enum(RELATED_KINDS),
  word: z.string().trim().min(1).max(VOCAB_RELATED_WORD_MAX),
  glossKo: z.string().trim().max(VOCAB_RELATED_GLOSS_MAX).nullable(),
});

const vocabExtractEntrySchema = z.object({
  no: z.string().trim().min(1).max(VOCAB_NO_MAX).nullable(),
  word: z.string().trim().min(1).max(VOCAB_WORD_MAX),
  ipa: z.string().trim().min(1).max(VOCAB_IPA_MAX).nullable(),
  pos: z.array(z.enum(PARTS_OF_SPEECH)).max(VOCAB_POS_MAX),
  meaningsKo: z.array(z.string().trim().min(1).max(VOCAB_MEANING_KO_MAX)).max(VOCAB_MEANINGS_MAX),
  examples: z.array(vocabExampleSchema).max(VOCAB_EXAMPLES_MAX),
  related: z.array(vocabRelatedSchema).max(VOCAB_RELATED_MAX),
  partial: z.boolean(),
  confidence: z.enum(VOCAB_CONFIDENCE_LEVELS),
});

/**
 * 호출 C 결과의 zod 스키마 (§7-4). JSON Schema와 필드·타입이 1:1이고, 그 위에 §7-4의 추가
 * 검증을 superRefine으로 얹는다.
 */
export const vocabExtractionSchema = z
  .object({
    isVocabPage: z.boolean(),
    dayLabel: z.string().trim().min(1).max(VOCAB_DAY_LABEL_MAX).nullable(),
    entries: z.array(vocabExtractEntrySchema),
  })
  .superRefine((data, ctx) => {
    // 페이지 게이트: 단어장이 아니면(false) 항목을 옮기지 않는다 (표지 판독 isBookCover와 같은 갈래)
    if (!data.isVocabPage && data.entries.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "isVocabPage=false면 entries는 빈 배열이어야 합니다",
      });
    }

    // 한 사진의 항목 수 상한 — 배치를 넘나드는 합계가 아니라 사진 1장 기준이다
    if (data.entries.length > VOCAB_ENTRIES_PER_PAGE_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: `한 사진의 단어는 최대 ${VOCAB_ENTRIES_PER_PAGE_MAX}개입니다 (현재 ${data.entries.length}개)`,
      });
    }

    // 번호 중복 금지 — 같은 사진에서 같은 번호를 두 번 읽으면 병합 조인 키가 깨진다
    const seenNo = new Set<string>();
    data.entries.forEach((entry, i) => {
      if (entry.no !== null) {
        const key = entry.no.trim();
        if (seenNo.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", i, "no"],
            message: `번호 중복 금지: ${entry.no}`,
          });
        }
        seenNo.add(key);
      }

      // 발음기호 대괄호를 벗겨 저장한다 (§7-1 지침). [ ] 가 남아 있으면 지시를 안 지킨 것 → 거부
      if (entry.ipa !== null && /[[\]]/.test(entry.ipa)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "ipa"],
          message: "발음기호의 대괄호 [ ]는 벗겨서 안쪽만 적으세요",
        });
      }
    });
  });

// ---------------------------------------------------------------------------
// 그림 우선순위 — resolveVocabImage (schemas.ts:499 resolveStorySource 관용구 복제)
// 그림을 고르는 곳이 여러 화면(표/카드/시험)에 흩어지면 반드시 어긋난다. 여기 한 곳만 판정한다.
// V1에서는 svg·emoji가 항상 null이라 늘 letter로 떨어진다 — V3에서 emoji가 채워지면 자동으로 승격.
// ---------------------------------------------------------------------------

export type VocabImage =
  | { kind: "svg"; svg: string }
  | { kind: "emoji"; emoji: string }
  | { kind: "letter"; letter: string };

/**
 * 단어 그림을 우선순위대로 고른다: imageSvg > imageEmoji > 첫 글자 배지.
 * 추상어(fix·respect)처럼 이모지가 없어도 항상 무언가(첫 글자)를 돌려주므로 UI가 빈자리를 안 만든다.
 */
export function resolveVocabImage(entry: {
  imageSvg?: string | null;
  imageEmoji?: string | null;
  word: string;
}): VocabImage {
  if (entry.imageSvg && entry.imageSvg.trim() !== "") {
    return { kind: "svg", svg: entry.imageSvg };
  }
  if (entry.imageEmoji && entry.imageEmoji.trim() !== "") {
    return { kind: "emoji", emoji: entry.imageEmoji };
  }
  const letter = (entry.word.trim()[0] ?? "?").toUpperCase();
  return { kind: "letter", letter };
}

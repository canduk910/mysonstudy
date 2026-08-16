/**
 * lib/ai/schemas.ts — 출력 JSON Schema 원문 + zod 이중 검증 (docs/HARNESS.md §2-3·§3-3·§4·§5)
 *
 * - JSON Schema는 스펙 원문 그대로 (Structured Outputs strict 모드용).
 *   배열 개수 제약(minItems/maxItems)은 스키마에 넣지 않는다 — 프롬프트 + zod가 담당 (§1 공통 규칙).
 * - zod는 §4의 추가 검증(개수·중복·금지어·isCore·픽션 분기)을 superRefine으로 구현한다.
 * - 사이트워드 차단 목록(§5)은 여기서만 정의한다 — zod 검증과 scripts/eval-cards.ts가 같은 상수를 쓴다.
 */

import { z } from "zod";

/** Structured Outputs에 전달하는 json_schema 포맷 묶음 */
export interface StrictJsonSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 호출 A — book_extraction (HARNESS §2-3 원문)
// ---------------------------------------------------------------------------

export const BOOK_EXTRACTION_JSON_SCHEMA: StrictJsonSchema = {
  name: "book_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isBookCover: { type: "boolean", description: "책 표지 사진이 맞는지" },
      title: { type: ["string", "null"] },
      author: { type: ["string", "null"] },
      series: { type: ["string", "null"] },
      arLevel: { type: ["number", "null"], description: "예: 3.3" },
      lexile: { type: ["integer", "null"], description: "예: 570" },
      wordCount: { type: ["integer", "null"] },
      arQuizNo: { type: ["string", "null"] },
      isFiction: { type: ["boolean", "null"] },
      topicGuess: { type: ["string", "null"], description: "한국어 한 줄" },
      coverEmoji: { type: ["string", "null"] },
    },
    required: [
      "isBookCover", "title", "author", "series", "arLevel", "lexile",
      "wordCount", "arQuizNo", "isFiction", "topicGuess", "coverEmoji",
    ],
  },
};

/** 호출 A 결과의 zod 스키마 (JSON Schema와 필드·타입 1:1 대응) */
export const bookExtractionSchema = z.object({
  isBookCover: z.boolean(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  series: z.string().nullable(),
  arLevel: z.number().nullable(),
  lexile: z.number().int().nullable(),
  wordCount: z.number().int().nullable(),
  arQuizNo: z.string().nullable(),
  isFiction: z.boolean().nullable(),
  topicGuess: z.string().nullable(),
  coverEmoji: z.string().nullable(),
});

export type BookExtraction = z.infer<typeof bookExtractionSchema>;

// ---------------------------------------------------------------------------
// 호출 B — learning_card (HARNESS §3-3 원문)
// ---------------------------------------------------------------------------

export const LEARNING_CARD_JSON_SCHEMA: StrictJsonSchema = {
  name: "learning_card",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      bookIntroKo: { type: "string" },
      levelNoteKo: { type: "string" },
      beforeReading: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { ko: { type: "string" } }, required: ["ko"],
        },
      },
      vocab: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            word: { type: "string" },
            pronKo: { type: "string" },
            meaningKo: { type: "string" },
            easyEn: { type: "string" },
            exampleEn: { type: "string" },
            difficulty: { type: "string", enum: ["basic", "challenge"] },
            isCore: { type: ["boolean", "null"] },
          },
          required: ["word", "pronKo", "meaningKo", "easyEn", "exampleEn",
            "difficulty", "isCore"],
        },
      },
      teachingTipKo: { type: "string" },
      whileReading: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { ko: { type: "string" } }, required: ["ko"],
        },
      },
      questions: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["사실확인", "인물", "배경", "사건", "인과", "감정",
                "예측", "결말", "비교", "상상", "내생각", "나와연결"],
            },
            en: { type: "string" },
            ko: { type: "string" },
            hintKo: { type: ["string", "null"] },
          },
          required: ["type", "en", "ko", "hintKo"],
        },
      },
      funFacts: {
        type: ["array", "null"],
        items: {
          type: "object", additionalProperties: false,
          properties: { en: { type: "string" }, ko: { type: "string" } },
          required: ["en", "ko"],
        },
      },
      activities: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { titleKo: { type: "string" }, descKo: { type: "string" } },
          required: ["titleKo", "descKo"],
        },
      },
    },
    required: ["bookIntroKo", "levelNoteKo", "beforeReading", "vocab",
      "teachingTipKo", "whileReading", "questions", "funFacts", "activities"],
  },
};

// ---------------------------------------------------------------------------
// 사이트워드 차단 목록 (HARNESS §5 — 소문자 비교)
// zod 검증과 eval 하네스가 반드시 이 상수를 공유한다. 별도 정의 금지.
// ---------------------------------------------------------------------------

export const SIGHT_WORDS: readonly string[] = [
  "the", "a", "an", "and", "or", "but", "is", "am", "are", "was", "were", "be",
  "to", "of", "in", "on", "at", "it", "he", "she", "we", "you", "they", "i",
  "my", "your", "his", "her", "this", "that", "there", "here", "go", "goes",
  "come", "see", "look", "like", "want", "can", "will", "do", "does", "did",
  "have", "has", "had", "get", "got", "make", "say", "said", "good", "big",
  "small", "one", "two", "three", "yes", "no", "not", "up", "down", "out",
  "with", "for", "from", "day", "time", "boy", "girl", "mom", "dad",
];

/** 소문자 비교용 Set (조회 편의) */
export const SIGHT_WORD_SET: ReadonlySet<string> = new Set(SIGHT_WORDS);

// ---------------------------------------------------------------------------
// 학습 카드 TypeScript 타입 (SPEC §6)
// 주의: strict 모드 JSON Schema는 "선택" 필드를 null 유니온으로 내보내므로,
// §6의 선택(?) 필드는 `?: T | null`로 표기해 와이어 포맷과 호환되게 했다.
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = [
  "사실확인", "인물", "배경", "사건", "인과", "감정",
  "예측", "결말", "비교", "상상", "내생각", "나와연결",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface VocabItem {
  word: string;
  pronKo: string; // 한글 발음 표기, 예: "팩"
  meaningKo: string; // 한글 뜻
  easyEn: string; // 아이 눈높이 영영 풀이, 예: "a wolf family"
  exampleEn: string; // 새로 창작한 간단 예문 (책 문장 아님)
  difficulty: "basic" | "challenge"; // challenge는 2~3개만
  isCore?: boolean | null; // 제목·주제의 핵심 단어 1개에 표시
}

export interface QuestionItem {
  type: QuestionType;
  en: string; // 아이에게 그대로 읽어줄 쉬운 영어 질문
  ko: string; // 자연스러운 우리말 질문 (직역 금지)
  hintKo?: string | null; // 부모용 힌트·정답·코칭 팁 (절반 정도만)
}

export interface Card {
  bookIntroKo: string; // "이 책은?" 2문장. 아이 흥미 유발형
  levelNoteKo: string; // AR 수치를 부모에게 쉽게 풀어주는 1문장
  beforeReading: { ko: string }[]; // 2개. 표지 추리 놀이 1개 포함
  vocab: VocabItem[]; // 12개 (AR<2면 10개)
  teachingTipKo: string; // 발음·문법 등 티칭 포인트 1개
  whileReading: { ko: string }[]; // 3개. 몸놀이·미션형
  questions: QuestionItem[]; // 8개 (AR<2면 6개)
  funFacts?: { en: string; ko: string }[] | null; // 논픽션만 4개. 일반 상식 수준의 사실
  activities: { titleKo: string; descKo: string }[]; // 2개. 몸으로 노는 확장 놀이
}

// ---------------------------------------------------------------------------
// 호출 B — zod 이중 검증 (HARNESS §4)
// 카드 검증은 AR 값과 픽션 여부에 의존하므로 팩토리로 만든다.
// ---------------------------------------------------------------------------

export interface CardValidationMeta {
  arLevel: number | null;
  isFiction: boolean;
}

const vocabItemSchema = z.object({
  word: z.string(),
  pronKo: z.string(),
  meaningKo: z.string(),
  easyEn: z.string(),
  exampleEn: z.string(),
  difficulty: z.enum(["basic", "challenge"]),
  isCore: z.boolean().nullable(),
});

const questionItemSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  en: z.string(),
  ko: z.string(),
  hintKo: z.string().nullable(),
});

export function makeLearningCardSchema(meta: CardValidationMeta) {
  // AR<2 → 단어 10·질문 6 / 그 외(미상 포함) → 단어 12·질문 8 (HARNESS §4)
  const isLowAr = meta.arLevel !== null && meta.arLevel < 2;
  const expectedVocabCount = isLowAr ? 10 : 12;
  const expectedQuestionCount = isLowAr ? 6 : 8;

  return z
    .object({
      bookIntroKo: z.string(),
      levelNoteKo: z.string(),
      beforeReading: z.array(z.object({ ko: z.string() })),
      vocab: z.array(vocabItemSchema),
      teachingTipKo: z.string(),
      whileReading: z.array(z.object({ ko: z.string() })),
      questions: z.array(questionItemSchema),
      funFacts: z.array(z.object({ en: z.string(), ko: z.string() })).nullable(),
      activities: z.array(z.object({ titleKo: z.string(), descKo: z.string() })),
    })
    .superRefine((card, ctx) => {
      // vocab 길이
      if (card.vocab.length !== expectedVocabCount) {
        ctx.addIssue({
          code: "custom",
          path: ["vocab"],
          message: `단어는 ${expectedVocabCount}개여야 합니다 (현재 ${card.vocab.length}개)`,
        });
      }

      // word 소문자 중복 금지 + 사이트워드 금지 (§5 목록과 대조)
      const seenWords = new Set<string>();
      card.vocab.forEach((v, i) => {
        const lower = v.word.trim().toLowerCase();
        if (seenWords.has(lower)) {
          ctx.addIssue({
            code: "custom",
            path: ["vocab", i, "word"],
            message: `중복 단어 금지: "${v.word}"`,
          });
        }
        seenWords.add(lower);
        if (SIGHT_WORD_SET.has(lower)) {
          ctx.addIssue({
            code: "custom",
            path: ["vocab", i, "word"],
            message: `기초 사이트워드는 금지: "${v.word}"`,
          });
        }
      });

      // isCore가 true인 vocab이 정확히 1개
      const coreCount = card.vocab.filter((v) => v.isCore === true).length;
      if (coreCount !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["vocab"],
          message: `isCore가 true인 단어는 정확히 1개여야 합니다 (현재 ${coreCount}개)`,
        });
      }

      // questions 길이 + type 중복 금지
      if (card.questions.length !== expectedQuestionCount) {
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: `질문은 ${expectedQuestionCount}개여야 합니다 (현재 ${card.questions.length}개)`,
        });
      }
      const seenTypes = new Set<string>();
      card.questions.forEach((q, i) => {
        if (seenTypes.has(q.type)) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", i, "type"],
            message: `질문 유형 중복 금지: "${q.type}"`,
          });
        }
        seenTypes.add(q.type);
      });

      // 픽션 → funFacts === null / 논픽션 → funFacts 4개
      if (meta.isFiction) {
        if (card.funFacts !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["funFacts"],
            message: "픽션은 funFacts가 null이어야 합니다",
          });
        }
      } else if (!card.funFacts || card.funFacts.length !== 4) {
        ctx.addIssue({
          code: "custom",
          path: ["funFacts"],
          message: `논픽션은 funFacts가 4개여야 합니다 (현재 ${card.funFacts?.length ?? "null"})`,
        });
      }

      // beforeReading 2개, whileReading 3개, activities 2개
      if (card.beforeReading.length !== 2) {
        ctx.addIssue({
          code: "custom",
          path: ["beforeReading"],
          message: `beforeReading은 2개여야 합니다 (현재 ${card.beforeReading.length}개)`,
        });
      }
      if (card.whileReading.length !== 3) {
        ctx.addIssue({
          code: "custom",
          path: ["whileReading"],
          message: `whileReading은 3개여야 합니다 (현재 ${card.whileReading.length}개)`,
        });
      }
      if (card.activities.length !== 2) {
        ctx.addIssue({
          code: "custom",
          path: ["activities"],
          message: `activities는 2개여야 합니다 (현재 ${card.activities.length}개)`,
        });
      }
    });
}

/** zod가 검증한 학습 카드 결과 타입 — Card(§6)에 그대로 대입 가능 */
export type LearningCard = z.infer<ReturnType<typeof makeLearningCardSchema>>;

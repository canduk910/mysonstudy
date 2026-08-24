/**
 * lib/ai/english/schemas.ts — 출력 JSON Schema 원문 + zod 이중 검증 (docs/harness/english.md §2-3·§3-3·§4·§5)
 *
 * - JSON Schema는 스펙 원문 그대로 (Structured Outputs strict 모드용).
 *   배열 개수 제약(minItems/maxItems)은 스키마에 넣지 않는다 — 프롬프트 + zod가 담당 (§1 공통 규칙).
 * - zod는 §4의 추가 검증(개수·중복·금지어·isCore·픽션 분기)을 superRefine으로 구현한다.
 * - 사이트워드 차단 목록(§5)은 여기서만 정의한다 — zod 검증과 scripts/eval-english.ts가 같은 상수를 쓴다.
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
      blurbText: { type: ["string", "null"], description: "뒤표지·책날개 출판사 소개글" },
    },
    required: [
      "isBookCover", "title", "author", "series", "arLevel", "lexile",
      "wordCount", "arQuizNo", "isFiction", "topicGuess", "coverEmoji", "blurbText",
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
  blurbText: z.string().nullable(),
});

export type BookExtraction = z.infer<typeof bookExtractionSchema>;

// ---------------------------------------------------------------------------
// 호출 A′ — page_digest (HARNESS §2A-3 원문)
// 본문/목차 사진 묶음 → 장면별 요약. 사진은 요약의 근거로만 쓰고 원문은 옮기지 않는다.
// ---------------------------------------------------------------------------

/** 장면 메모의 출처 — 목차 사진인지 본문 사진인지 (HARNESS §2A) */
export const SCENE_SOURCE_KINDS = ["toc", "pages"] as const;
export type SceneSourceKind = (typeof SCENE_SOURCE_KINDS)[number];

/** 장면 판독 신뢰도 — low면 재촬영 유도 대상 (HARNESS §2A-1) */
export const SCENE_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type SceneConfidence = (typeof SCENE_CONFIDENCE_LEVELS)[number];

export const PAGE_DIGEST_JSON_SCHEMA: StrictJsonSchema = {
  name: "page_digest",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sourceKind: { type: "string", enum: ["toc", "pages"] },
      scenes: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            seq: { type: "integer", description: "촬영 순서(1부터)" },
            labelKo: { type: "string", description: '예: "12~13쪽" 또는 "3장: Pooh와 꿀단지"' },
            summaryKo: { type: "string", description: "1~3문장 우리말 요약" },
            askKo: { type: ["string", "null"], description: "이 장면에서 부모가 던질 질문 1개" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            gapBefore: { type: "boolean", description: "앞 장면과 내용이 이어지지 않으면 true" },
          },
          required: ["seq", "labelKo", "summaryKo", "askKo", "confidence", "gapBefore"],
        },
      },
    },
    required: ["sourceKind", "scenes"],
  },
};

export interface SceneDigestItem {
  seq: number;
  labelKo: string; // 예: "1~2쪽" / "3장: Pooh와 꿀단지"
  summaryKo: string; // 1~3문장 우리말 요약 (원문 전사 아님)
  askKo?: string | null; // 그 장면에서 부모가 던질 질문 1개 — 이 기능의 핵심
  confidence?: SceneConfidence | null; // low면 재촬영 유도
  gapBefore?: boolean | null; // 앞 장면과 내용이 이어지지 않음(사진 누락·순서 뒤바뀜)
}

// ---------------------------------------------------------------------------
// 장면 메모 길이 상한 — 생산자(호출 A′ zod)와 소비자(/api/card 입력 zod)의 단일 정의처.
//
// 왜 여기 모으는가: 같은 값이 두 곳에 흩어지면 반드시 어긋난다. 실제로 생산자에만
// 상한이 없어서, `/api/pages`가 통과시킨 labelKo 131자를 `/api/card`가 400으로 거부했다
// (QA F12) — 사용자는 본문 16장을 다 찍고 A′ 비용까지 치른 뒤에 실패를 만난다.
// 상한을 생산 시점에 걸면 callWithSchema의 1회 재요청이 그 자리에서 교정한다.
//
// JSON Schema에는 넣지 않는다 — strict 모드 규약상 길이 검증은 zod 담당이다 (§1 공통 규칙).
// ---------------------------------------------------------------------------

/** labelKo 최대 길이 — "12~13쪽" / "3장: Pooh와 꿀단지" 수준이면 한참 못 미친다 */
export const SCENE_LABEL_KO_MAX = 120;
/** summaryKo 최대 길이 — 1~3문장 기준으로 넉넉하다 */
export const SCENE_SUMMARY_KO_MAX = 1000;
/** askKo 최대 길이 — 질문 1개 기준으로 넉넉하다 */
export const SCENE_ASK_KO_MAX = 500;
/** 한 책에 담을 장면 수 상한. pages 모드는 PAGES_MAX_IMAGES(40)에 이미 묶여 있고, 이 값은 toc 모드용이다 */
export const MAX_SCENE_DIGEST_ITEMS = 120;

const sceneDigestItemSchema = z.object({
  // seq는 병합 단계에서 촬영 순서대로 다시 매기므로(client.ts) 여기서 상한을 걸지 않는다 —
  // 어차피 덮어쓸 값 때문에 재요청을 유발할 이유가 없다. 소비자 상한(10,000) 충족은 재부여가 보장한다.
  seq: z.number().int(),
  labelKo: z.string().trim().min(1).max(SCENE_LABEL_KO_MAX),
  summaryKo: z.string().trim().min(1).max(SCENE_SUMMARY_KO_MAX),
  askKo: z.string().trim().max(SCENE_ASK_KO_MAX).nullable(),
  confidence: z.enum(SCENE_CONFIDENCE_LEVELS),
  gapBefore: z.boolean(),
});

/**
 * 영어 원문 전사 감지 한도 — 한국어 요약 안에 이 개수 이상의 영어 단어가 연속되면
 * 본문을 그대로 옮겨 적은 것으로 본다 (SPEC §1 개정 원칙: 사진은 요약의 근거로만).
 */
export const ENGLISH_RUN_LIMIT = 8;

/** 텍스트에서 연속된 영어 단어의 최대 개수. 한글이 섞인 토큰은 영어로 세지 않는다. */
export function longestEnglishRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const token of text.split(/\s+/)) {
    const cleaned = token.replace(/^[^A-Za-z가-힣0-9]+|[^A-Za-z가-힣0-9]+$/g, "");
    if (cleaned !== "" && /^[A-Za-z][A-Za-z'’-]*$/.test(cleaned)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

export interface PageDigestValidationMeta {
  sourceKind: SceneSourceKind;
  /** 이번 배치의 사진 장수 — pages 모드는 "사진 1장 = 장면 1개"를 강제한다 */
  imageCount: number;
}

/**
 * 호출 A′ zod 이중 검증 (HARNESS §2A-4).
 * JSON Schema가 못 잡는 것: 장면 수, seq 순서·중복, askKo 누락, 영어 원문 전사.
 */
export function makePageDigestSchema(meta: PageDigestValidationMeta) {
  return z
    .object({
      sourceKind: z.enum(SCENE_SOURCE_KINDS),
      scenes: z.array(sceneDigestItemSchema),
    })
    .superRefine((digest, ctx) => {
      if (digest.sourceKind !== meta.sourceKind) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceKind"],
          message: `sourceKind는 "${meta.sourceKind}"여야 합니다 (현재 "${digest.sourceKind}")`,
        });
      }

      if (digest.scenes.length === 0) {
        ctx.addIssue({ code: "custom", path: ["scenes"], message: "장면이 1개 이상이어야 합니다" });
      }

      // 소비자(/api/card)와 같은 상한. 배치 하나가 이미 넘으면 병합 결과도 반드시 넘는다 —
      // 여기서 잡아야 재요청으로 교정된다 (배치를 넘나드는 합계 초과는 client.ts가 잘라낸다)
      if (digest.scenes.length > MAX_SCENE_DIGEST_ITEMS) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes"],
          message: `장면은 최대 ${MAX_SCENE_DIGEST_ITEMS}개입니다 (현재 ${digest.scenes.length}개) — 묶어서 줄이세요`,
        });
      }

      // pages 모드: 사진 1장 = 장면 1개 (합치기·나누기 금지 → 사진 순서와 장면 순서가 어긋나지 않는다)
      if (meta.sourceKind === "pages" && digest.scenes.length !== meta.imageCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes"],
          message: `본문 모드는 사진 1장당 장면 1개입니다 — 사진 ${meta.imageCount}장에 장면 ${digest.scenes.length}개`,
        });
      }

      // seq 중복 금지 + 오름차순 (최종 번호는 병합 시 다시 매긴다)
      let prevSeq: number | null = null;
      const seenSeq = new Set<number>();
      digest.scenes.forEach((scene, i) => {
        if (seenSeq.has(scene.seq)) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "seq"],
            message: `seq 중복 금지: ${scene.seq}`,
          });
        }
        seenSeq.add(scene.seq);
        if (prevSeq !== null && scene.seq <= prevSeq) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "seq"],
            message: `seq는 오름차순이어야 합니다 (${prevSeq} 다음에 ${scene.seq})`,
          });
        }
        prevSeq = scene.seq;

        // askKo는 이 기능의 핵심 — 못 읽은 장면(confidence low)에서만 null 허용
        if (
          (scene.askKo === null || scene.askKo.trim() === "") &&
          scene.confidence !== "low"
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "askKo"],
            message: "askKo는 필수입니다 (사진을 못 읽은 confidence=low 장면만 null 허용)",
          });
        }

        // 우리말 요약이어야 한다 — 영어 원문을 그대로 옮긴 요약은 거부 (SPEC §1 개정 원칙)
        if (!/[가-힣]/.test(scene.summaryKo)) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "summaryKo"],
            message: "summaryKo는 우리말 요약이어야 합니다",
          });
        }
        if (longestEnglishRun(scene.summaryKo) >= ENGLISH_RUN_LIMIT) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "summaryKo"],
            message: `영어 원문을 그대로 옮기지 마세요 (영어 ${ENGLISH_RUN_LIMIT}단어 이상 연속). 우리말로 요약하세요`,
          });
        }
      });
    });
}

export type PageDigest = z.infer<ReturnType<typeof makePageDigestSchema>>;

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
      storyOutlineKo: { type: "string" },
      storySource: { type: "string", enum: ["metadata", "blurb", "toc", "pages", "transcript"] },
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
    required: ["bookIntroKo", "levelNoteKo", "storyOutlineKo", "storySource",
      "beforeReading", "vocab", "teachingTipKo", "whileReading",
      "questions", "funFacts", "activities"],
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
// storySource — 줄거리 미리보기의 근거 두께 (HARNESS §3-1 / SPEC §6)
// 기존 불리언 storyIsGuess를 대체한다. 근거가 두꺼울수록 분량을 늘린다.
// ---------------------------------------------------------------------------

export const STORY_SOURCES = ["metadata", "blurb", "toc", "pages", "transcript"] as const;
export type StorySource = (typeof STORY_SOURCES)[number];

/**
 * 근거의 두께 순서 — 모델은 받은 근거보다 높은 값을 주장할 수 없다 (zod가 강제).
 * 낮춰 적는 것은 허용이므로 비교는 반드시 `<=`로 한다. eval도 이 상수를 쓴다(등호 비교 금지).
 *
 * transcript(유튜브 낭독 자막 = 책 전체 텍스트)가 가장 두껍다 — pages(장면 메모, 요약)보다도
 * 원문 전체를 근거로 삼으므로 최상위 티어다.
 */
export const STORY_SOURCE_RANK: Record<StorySource, number> = {
  metadata: 0,
  blurb: 1,
  toc: 2,
  pages: 3,
  transcript: 4,
};

/** 카드 배지 문구 (SPEC §4-2). UI는 이 상수를 쓴다 — 문구를 따로 적지 말 것. */
export const STORY_SOURCE_LABELS_KO: Record<StorySource, string> = {
  metadata: "예상",
  blurb: "소개글 기반",
  toc: "목차 기반",
  pages: "본문 확인",
  transcript: "낭독 확인",
};

/**
 * 근거 단위를 셀 수 없는 출처의 고정 구간 (HARNESS §3-1).
 * metadata·blurb는 "몇 개"를 셀 대상이 없어 종류만으로 정한다.
 * transcript는 책 전체 텍스트라 셀 장면은 없지만 근거가 가장 두꺼우므로 다이얼 상한([8,10])에 둔다.
 */
export const STORY_OUTLINE_FLAT_RANGE = {
  metadata: [3, 4],
  blurb: [4, 6],
  transcript: [8, 10],
} as const satisfies Record<"metadata" | "blurb" | "transcript", readonly [number, number]>;

/** 줄거리 분량의 절대 하한 — 이보다 짧으면 카드로서 맥락이 안 잡힌다 */
export const STORY_OUTLINE_MIN_SENTENCES = 3;
/** 절대 상한 — 카드는 A4 1~2쪽 인쇄물이다 (SPEC §4-2). 장면별 메모 섹션이 따로 있다 */
export const STORY_OUTLINE_MAX_SENTENCES = 10;
/** 하한이 올라갈 수 있는 최댓값 — 장면이 아무리 많아도 8문장 이상을 강제하지는 않는다 */
export const STORY_OUTLINE_MIN_CEILING = 8;

/**
 * storyOutlineKo 문장 수 다이얼 (HARNESS §3-1). **분량은 근거의 양에 비례한다.**
 *
 * 종류(metadata/blurb/toc/pages)만 보고 구간을 정하면 설계 원칙과 모순된다 — 4장면짜리 얇은
 * 근거와 16장면짜리 두꺼운 근거가 같은 분량을 요구받기 때문이다. 근거보다 길게 쓰라는 요구는
 * 모델을 지어내기로 밀거나(절대 규칙 2 위반), 지키면 eval이 실패하는 딜레마가 된다.
 * 그래서 장면을 셀 수 있는 출처(toc·pages)는 장면 수 N에서 구간을 계산한다:
 *
 * - 하한 = ⌈N/2⌉ + 2 — 장면을 둘씩 묶어 쓰고(⌈N/2⌉) 도입·훅 각 1문장. 가장 압축해도 이만큼 나온다
 * - 상한 = N + 2     — 장면마다 한 문장씩 쓰고 도입·훅 각 1문장. 지어내지 않는 최대치
 * - 두 값을 절대 경계(3~10문장, 하한은 8까지)로 자른다
 *
 * 프롬프트↔eval이 같은 함수를 본다 — 값은 여기 한 곳만 고친다.
 * `sceneCount`는 이 호출에 실제로 넘긴 장면 수다. storySource를 낮춰 적은 카드는 낮춘 근거의
 * 구간으로 재는 것이 맞으므로, 판정할 때는 카드가 주장한 storySource를 넘긴다.
 */
export function storyOutlineSentenceRange(
  storySource: StorySource,
  sceneCount = 0,
): readonly [number, number] {
  if (storySource === "metadata" || storySource === "blurb" || storySource === "transcript") {
    return STORY_OUTLINE_FLAT_RANGE[storySource];
  }
  const scenes = Math.max(0, Math.floor(sceneCount));
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
  const min = clamp(
    Math.ceil(scenes / 2) + 2,
    STORY_OUTLINE_MIN_SENTENCES,
    STORY_OUTLINE_MIN_CEILING,
  );
  const max = clamp(scenes + 2, STORY_OUTLINE_MIN_SENTENCES + 1, STORY_OUTLINE_MAX_SENTENCES);
  return [min, max];
}

/**
 * 우리말 문장 수 세기 — storyOutlineKo 분량 다이얼 점검용(eval).
 * 마침표·물음표·느낌표·말줄임표를 문장 끝으로 보고, 끝맺음이 없는 꼬리도 1문장으로 센다.
 */
export function countKoreanSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed
    .split(/(?<=[.!?。！？…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "").length;
}

/**
 * 카드에 실제로 넘긴 근거로부터 '주장 가능한 최대 storySource'를 계산한다.
 * 받지 못한 근거를 주장하는 것만 막고, 낮춰 적는 것(근거가 실제로는 도움이 안 됐다)은 허용한다.
 *
 * `sceneKind`가 비어 있으면 **`pages`로 본다** — `buildCardUserMessage`의
 * `formatSceneDigestBlock`이 같은 조건에서 장면 메모를 "본문 촬영"으로 렌더링하기 때문이다.
 * 두 함수의 기본값이 어긋나면, 모델이 프롬프트에 보이는 장면 메모를 근거로 `pages`를 적는
 * 순간 zod가 거부해 재요청 → throw로 직행한다 (선택 필드라 호출부가 빠뜨리기 쉽다).
 * 근거를 버리는 쪽(블록을 "없음"으로 내림)이 아니라 살리는 쪽으로 맞춘 이유는, 이미 값을
 * 치르고 얻은 A′ 결과를 버리면 카드 품질이 그만큼 떨어지기 때문이다.
 */
export function resolveAllowedStorySource(evidence: {
  transcript?: string | null;
  blurbText?: string | null;
  sceneKind?: SceneSourceKind | null;
  sceneDigest?: readonly SceneDigestItem[] | null;
}): StorySource {
  // transcript(낭독 자막 = 책 전체 텍스트)는 최상위 티어. 다른 근거가 함께 와도 상한은 transcript다
  // (카드가 실제로는 자막을 덜 썼다면 낮춰 적을 수 있다 — 비교가 `<=`라 낮춰 적기는 허용된다).
  if ((evidence.transcript ?? "").trim() !== "") return "transcript";
  const hasScenes = (evidence.sceneDigest?.length ?? 0) > 0;
  if (hasScenes) return evidence.sceneKind === "toc" ? "toc" : "pages";
  if ((evidence.blurbText ?? "").trim() !== "") return "blurb";
  return "metadata";
}

/**
 * 저장된 카드에서 배지에 쓸 storySource를 얻는다 — 하위 호환 경로.
 *
 * 구(舊) 저장 카드에는 storySource가 없고 불리언 storyIsGuess만 있다:
 * - storyIsGuess === true  → "metadata"("예상" 배지). 구 UI 동작과 동일하다.
 * - storyIsGuess === false → null(배지 없음). 구 카드는 blurb·toc·pages 근거를 가진 적이
 *   없으므로 상위 값으로 승격하지 않고, 배지를 달지 않던 기존 화면을 그대로 유지한다.
 * - 두 필드 모두 없음     → null(배지 없음).
 */
export function resolveStorySource(card: {
  storySource?: StorySource | null;
  storyIsGuess?: boolean | null;
}): StorySource | null {
  if (card.storySource) return card.storySource;
  if (card.storyIsGuess === true) return "metadata";
  return null;
}

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
  storyOutlineKo?: string; // 줄거리 미리보기 (근거 두께에 따라 3~8문장, 논픽션은 내용 소개, 결말 미공개). 신규 생성엔 필수 — 기존 저장 카드에는 없어 부재 시 UI가 섹션 생략
  storySource?: StorySource; // 줄거리의 근거 두께. 배지 문구는 STORY_SOURCE_LABELS_KO
  /** @deprecated storySource로 대체됨. 구 저장 카드를 읽기 위해서만 남긴다 — 배지 판정은 resolveStorySource() 사용 */
  storyIsGuess?: boolean;
  sceneDigest?: SceneDigestItem[]; // 호출 A′의 장면별 요약. 호출 B의 출력이 아니라 라우트가 붙여 넣는다(attachSceneDigest)
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
  /**
   * 이 호출에 실제로 넘긴 근거로 주장 가능한 최대 storySource.
   * 생략하면 "metadata" — 근거를 넘기지 않은 호출은 metadata만 주장할 수 있다.
   * `resolveAllowedStorySource()`로 계산한다.
   */
  allowedStorySource?: StorySource;
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
  const allowedStorySource = meta.allowedStorySource ?? "metadata";

  return z
    .object({
      bookIntroKo: z.string(),
      levelNoteKo: z.string(),
      storyOutlineKo: z.string().min(1), // 비어있지 않은 문자열 (JSON Schema에는 minLength 금지 — zod가 담당)
      storySource: z.enum(STORY_SOURCES),
      beforeReading: z.array(z.object({ ko: z.string() })),
      vocab: z.array(vocabItemSchema),
      teachingTipKo: z.string(),
      whileReading: z.array(z.object({ ko: z.string() })),
      questions: z.array(questionItemSchema),
      funFacts: z.array(z.object({ en: z.string(), ko: z.string() })).nullable(),
      activities: z.array(z.object({ titleKo: z.string(), descKo: z.string() })),
    })
    .superRefine((card, ctx) => {
      // storySource: 받지 못한 근거를 주장할 수 없다 (낮춰 적는 것은 허용)
      if (STORY_SOURCE_RANK[card.storySource] > STORY_SOURCE_RANK[allowedStorySource]) {
        ctx.addIssue({
          code: "custom",
          path: ["storySource"],
          message: `storySource "${card.storySource}"는 이 호출에 주어지지 않은 근거입니다 — "${allowedStorySource}" 이하로 적으세요`,
        });
      }

      // 줄거리 미리보기는 우리말 요약이다 — 영어 원문 전사 금지 (SPEC §1 개정 원칙)
      if (longestEnglishRun(card.storyOutlineKo) >= ENGLISH_RUN_LIMIT) {
        ctx.addIssue({
          code: "custom",
          path: ["storyOutlineKo"],
          message: `영어 원문을 그대로 옮기지 마세요 (영어 ${ENGLISH_RUN_LIMIT}단어 이상 연속). 우리말로 요약하세요`,
        });
      }

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

/**
 * 호출 A′의 장면 메모를 카드에 붙인다 (라우트가 저장 직전에 호출).
 *
 * sceneDigest는 호출 B의 출력이 아니다 — 모델에게 되돌려 받으면 출력 토큰만 늘고
 * 요약이 변조될 위험이 있다. 호출 A′ 결과를 그대로 옮겨 담는 것이 원본 보존에 맞다.
 * 장면이 없으면 필드를 아예 만들지 않는다(구 카드와 같은 '부재' 상태 → UI가 섹션 생략).
 */
export function attachSceneDigest(
  card: LearningCard,
  scenes?: readonly SceneDigestItem[] | null,
): Card {
  if (!scenes || scenes.length === 0) return card;
  return { ...card, sceneDigest: normalizeSceneDigest(scenes) };
}

/**
 * 저장 직전 정규화 — 선택 필드의 `undefined`를 `null`로 바꾸고 그 외 키는 버린다.
 * Firestore는 `undefined` 값을 그대로 쓰면 예외를 던지므로, books·cards 어느 쪽에
 * 넣든 이 함수를 통과시킨다.
 */
export function normalizeSceneDigest(
  scenes: readonly SceneDigestItem[],
): SceneDigestItem[] {
  return scenes.map((scene) => ({
    seq: scene.seq,
    labelKo: scene.labelKo,
    summaryKo: scene.summaryKo,
    askKo: scene.askKo ?? null,
    confidence: scene.confidence ?? null,
    gapBefore: scene.gapBefore ?? false,
  }));
}

// ---------------------------------------------------------------------------
// 호출 F — 챕터화 (transcript → 목차 챕터별 EN/KO 문장, HARNESS §9)
//
// 목차 챕터 제목 + 유튜브 낭독 자막 전문을 받아, 자막을 챕터별로 나누고 각 챕터를
// "자막에 실제로 나온 영어 문장 + 그 우리말 해석"으로 만든다. 이 기능은 가족 전용이라
// 영어 원문을 그대로 실어도 된다(SPEC §1 "본문 재현 금지"를 이 호출에 한해 완화 — 카드의
// 다른 부분은 기존 규칙 유지). "자막 밖 창작 금지"는 프롬프트 지시만으로 두지 않고
// groundChapters()가 코드로 강제한다 — 자막에 없는 en 문장은 저장 전에 잘라낸다.
// ---------------------------------------------------------------------------

/**
 * 자막 truncate 상한 (문자 수) — 챕터화 단일 정의처.
 *
 * 카드(§3-2 TRANSCRIPT_MAX_CHARS=16,000)보다 낮은 이유: 카드는 8~10문장 요약만 내지만
 * 챕터화는 자막 전체를 EN(원문)+KO(해석)으로 되뽑아 출력이 입력의 ~2배가 된다. 한 호출의
 * max_output_tokens(16,000) 안에 EN+KO가 들어가려면 입력을 이 선에서 잘라야 한다. 넘으면
 * 앞부분 우선으로 자른다 — 챕터 책은 앞 챕터부터 채워지고, 잘린 뒤쪽 챕터는 자막이 닿지
 * 않아 matched:false로 돌아온다(그 자리에서 지어내지 않는다). M1의 알려진 한계다.
 */
export const CHAPTERIZE_TRANSCRIPT_MAX_CHARS = 12_000;
/** 한 책의 챕터 수 상한 — 목차가 이보다 많으면 비정상 입력이다 (가드) */
export const CHAPTERIZE_MAX_CHAPTERS = 40;
/** 한 챕터의 문장 수 상한 — 모델이 문장을 중복 생성하는 폭주를 막는 가드 */
export const CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER = 120;
/** 한 책 전체 문장 수 상한 — 자막 길이(12,000자)에 이미 묶여 있고, 이 값은 폭주 가드다 */
export const CHAPTERIZE_MAX_SENTENCES_TOTAL = 600;
/** titleEn 길이 상한 — 챕터 제목 기준으로 넉넉하다 */
export const CHAPTER_TITLE_MAX = 200;
/** 문장 en 길이 상한 — 한 문장 기준으로 넉넉하다 */
export const CHAPTER_SENTENCE_EN_MAX = 600;
/** 문장 ko 길이 상한 — 한 문장 해석 기준으로 넉넉하다 */
export const CHAPTER_SENTENCE_KO_MAX = 800;
/**
 * 목차가 없을 때 쓰는 단일 챕터 제목 (HARNESS §9). 자막만 있고 목차(chapterTitles)가 비면
 * 자막 전체를 이 제목 한 챕터에 담는다 — 낭독 원문+번역은 필수이고 목차는 선택이기 때문이다.
 */
export const WHOLE_TRANSCRIPT_TITLE = "전체";

/**
 * 실제로 모델·zod에 넘길 챕터 제목을 정한다 (HARNESS §9). 목차가 있으면 그대로,
 * 없으면(빈 배열·공백뿐) 단일 챕터 제목 하나(`WHOLE_TRANSCRIPT_TITLE`). client와 eval이 같은
 * 함수를 써야 "목차 없음 → 전체 한 챕터" 계약이 한 곳에서 정의된다.
 */
export function resolveChapterTitles(chapterTitles: readonly string[]): string[] {
  const titles = chapterTitles.map((t) => t.trim()).filter((t) => t !== "");
  return titles.length > 0 ? titles : [WHOLE_TRANSCRIPT_TITLE];
}

export const CHAPTERIZATION_JSON_SCHEMA: StrictJsonSchema = {
  name: "chapterization",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chapters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            titleEn: { type: "string", description: "받은 목차 챕터 제목을 그대로" },
            matched: { type: "boolean", description: "자막에서 이 챕터 내용을 찾았는지" },
            sentences: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  en: { type: "string", description: "자막에 실제로 나온 문장(원문 그대로)" },
                  ko: { type: "string", description: "그 문장의 우리말 해석(1:1)" },
                },
                required: ["en", "ko"],
              },
            },
          },
          required: ["titleEn", "matched", "sentences"],
        },
      },
    },
    required: ["chapters"],
  },
};

export interface ChapterSentence {
  en: string; // 자막 원문 문장 (groundChapters가 자막 부분문자열임을 보장)
  ko: string; // en의 우리말 해석 (1:1)
}

export interface Chapter {
  titleEn: string;
  matched: boolean; // 자막에서 내용을 찾았으면 true (찾으면 sentences 채움, 못 찾으면 비움)
  sentences: ChapterSentence[];
}

/** 한글 음절·자모가 하나라도 있으면 true (en은 없어야, ko는 있어야) */
export function containsHangul(text: string): boolean {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
}

/** 챕터 제목 대조용 정규화 — NFC·트림·연속 공백 1칸·소문자. 모델이 제목을 그대로 echo했는지만 본다 */
export function normalizeTitleForMatch(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const chapterSentenceSchema = z.object({
  en: z.string().trim().min(1).max(CHAPTER_SENTENCE_EN_MAX),
  ko: z.string().trim().min(1).max(CHAPTER_SENTENCE_KO_MAX),
});

const chapterSchema = z.object({
  titleEn: z.string().trim().min(1).max(CHAPTER_TITLE_MAX),
  matched: z.boolean(),
  sentences: z.array(chapterSentenceSchema),
});

export interface ChapterizationValidationMeta {
  /** 입력으로 준 목차 챕터 제목 — 모델은 이 목록 밖의 챕터를 새로 만들 수 없다 */
  chapterTitles: readonly string[];
}

/**
 * 호출 F zod 이중 검증 (HARNESS §9). JSON Schema가 못 잡는 것:
 * - 챕터/문장 수 상한 (프롬프트가 아니라 자막 길이가 실질 상한이지만 폭주 가드로 둔다)
 * - matched ⟺ sentences 채움 (없는 챕터는 matched:false·빈 sentences)
 * - en은 영어(한글 없음), ko는 우리말(한글 있음) — 자리를 바꿔 넣는 실패를 막는다
 * - titleEn은 받은 목차 제목 중 하나 (목차 밖 챕터 창작 금지) + 제목 중복 금지
 *
 * "en이 자막에 실제로 있는가"(자막 밖 창작 금지)는 zod가 아니라 groundChapters()가 본다 —
 * 자막 문자열이 필요하고, 어긋난 문장은 throw가 아니라 잘라내는 편이 사용자에게 낫기 때문이다
 * (digestPages의 부분 성공 철학과 같다).
 */
export function makeChapterizationSchema(meta: ChapterizationValidationMeta) {
  const allowedTitles = new Set(meta.chapterTitles.map(normalizeTitleForMatch));
  return z
    .object({ chapters: z.array(chapterSchema) })
    .superRefine((data, ctx) => {
      if (data.chapters.length === 0) {
        ctx.addIssue({ code: "custom", path: ["chapters"], message: "챕터가 1개 이상이어야 합니다" });
      }
      if (data.chapters.length > CHAPTERIZE_MAX_CHAPTERS) {
        ctx.addIssue({
          code: "custom",
          path: ["chapters"],
          message: `챕터는 최대 ${CHAPTERIZE_MAX_CHAPTERS}개입니다 (현재 ${data.chapters.length}개)`,
        });
      }

      const totalSentences = data.chapters.reduce((n, ch) => n + ch.sentences.length, 0);
      if (totalSentences > CHAPTERIZE_MAX_SENTENCES_TOTAL) {
        ctx.addIssue({
          code: "custom",
          path: ["chapters"],
          message: `전체 문장은 최대 ${CHAPTERIZE_MAX_SENTENCES_TOTAL}개입니다 (현재 ${totalSentences}개)`,
        });
      }

      const seenTitles = new Set<string>();
      data.chapters.forEach((ch, i) => {
        const norm = normalizeTitleForMatch(ch.titleEn);
        if (allowedTitles.size > 0 && !allowedTitles.has(norm)) {
          ctx.addIssue({
            code: "custom",
            path: ["chapters", i, "titleEn"],
            message: `titleEn "${ch.titleEn}"은 받은 목차 챕터 제목이 아닙니다 — 새 챕터를 만들지 마세요`,
          });
        }
        if (seenTitles.has(norm)) {
          ctx.addIssue({
            code: "custom",
            path: ["chapters", i, "titleEn"],
            message: `titleEn "${ch.titleEn}"이 중복됩니다`,
          });
        }
        seenTitles.add(norm);

        if (ch.sentences.length > CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER) {
          ctx.addIssue({
            code: "custom",
            path: ["chapters", i, "sentences"],
            message: `한 챕터의 문장은 최대 ${CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER}개입니다 (현재 ${ch.sentences.length}개)`,
          });
        }
        if (ch.matched && ch.sentences.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["chapters", i, "sentences"],
            message: "matched=true인데 sentences가 비어 있습니다 — 내용을 못 찾았으면 matched=false로 두세요",
          });
        }
        if (!ch.matched && ch.sentences.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["chapters", i, "matched"],
            message: "matched=false인데 sentences가 있습니다 — 내용을 찾았으면 matched=true로 두세요",
          });
        }

        ch.sentences.forEach((s, j) => {
          if (containsHangul(s.en)) {
            ctx.addIssue({
              code: "custom",
              path: ["chapters", i, "sentences", j, "en"],
              message: "en은 자막의 영어 원문이어야 합니다 (한글이 섞였습니다 — ko와 자리를 바꿨는지 확인)",
            });
          }
          if (!containsHangul(s.ko)) {
            ctx.addIssue({
              code: "custom",
              path: ["chapters", i, "sentences", j, "ko"],
              message: "ko는 우리말 해석이어야 합니다 (한글이 없습니다)",
            });
          }
        });
      });
    });
}

export type Chapterization = z.infer<ReturnType<typeof makeChapterizationSchema>>;

/**
 * 자막 앞부분 우선 truncate (HARNESS §9). 상한을 넘으면 앞에서 자른다 —
 * 앞 챕터부터 채워지고 뒤쪽은 matched:false로 돌아온다.
 */
export function truncateTranscriptForChapterize(transcript: string): {
  text: string;
  truncated: boolean;
} {
  const trimmed = transcript.trim();
  if (trimmed.length <= CHAPTERIZE_TRANSCRIPT_MAX_CHARS) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, CHAPTERIZE_TRANSCRIPT_MAX_CHARS), truncated: true };
}

/**
 * grounding 대조용 토큰화 — 소문자 영숫자 토큰만 뽑는다. 아포스트로피·따옴표·문장부호·
 * 대소문자·공백 차이를 무시하므로("don't"↔"dont", 스마트따옴표↔직선따옴표), 모델이 자막을
 * 옮기며 생긴 사소한 표기 흔들림에는 관대하되 "같은 단어가 같은 순서로 나왔는가"는 지킨다.
 */
export function tokenizeForGrounding(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/[a-z0-9]+/g) ?? [];
}

/** en의 토큰 열이 자막 토큰 열의 연속 구간으로 존재하는가 — "자막에 실제로 나온 문장"인지 판정 */
export function isGroundedInTranscript(en: string, transcriptTokens: readonly string[]): boolean {
  const needle = tokenizeForGrounding(en);
  if (needle.length === 0) return false;
  const hay = transcriptTokens;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * "자막 밖 창작 금지"의 최종 강제 (HARNESS §9). 각 챕터의 문장 중 en이 자막에 실제로 없는 것을
 * 잘라낸다. 잘라서 문장이 하나도 안 남은 챕터는 matched를 false로 내린다(비운 챕터와 같은 상태).
 * throw가 아니라 잘라내는 이유: 사용자는 이미 호출 비용을 치렀고, 몇 문장을 버리는 편이 카드
 * 전체를 실패시키는 것보다 낫다. 저장되는 en은 이 필터를 지나 전부 자막 부분문자열임이 보장된다.
 */
export function groundChapters(
  chapters: readonly Chapter[],
  transcript: string,
): { chapters: Chapter[]; droppedSentenceCount: number } {
  const transcriptTokens = tokenizeForGrounding(transcript);
  let droppedSentenceCount = 0;
  const grounded = chapters.map((ch) => {
    const kept = ch.sentences.filter((s) => {
      const ok = isGroundedInTranscript(s.en, transcriptTokens);
      if (!ok) droppedSentenceCount += 1;
      return ok;
    });
    return { titleEn: ch.titleEn, matched: kept.length > 0, sentences: kept };
  });
  return { chapters: grounded, droppedSentenceCount };
}

// ===========================================================================
// 호출 G — 단어 뜻 조회 (문맥 기반 우리말 뜻). docs/harness/english.md §10-3·§10-4.
//
// 챕터 리더에서 단어를 더블탭하면, 그 단어가 아니라 **그 단어가 속한 문장** 맥락에서의 우리말 뜻을
// 짧게 돌려주는 호출이다(다의어면 이 문맥의 뜻). 사진 없는 텍스트 호출이고 출력이 아주 작다.
// 판독(호출 C, 책 전사)·보강(호출 D, 영영정의 창작)과 달리, 여기서 만드는 것은 **한 낱말짜리
// 우리말 뜻** 하나뿐이다. 팝업·더블탭·"단어장 추가"는 앱(app-builder/M2) 몫이고, 이 파일은
// 4중 정의(프롬프트↔JSON Schema↔zod↔eval)의 스키마 뿌리만 담는다.
// ===========================================================================

/**
 * 문맥 속 우리말 뜻의 최대 길이. "한 낱말~짧은 구"라 짧다 — 초등 저학년 눈높이의 뜻 하나면
 * 넉넉하다. 길어지면 뜻이 아니라 설명·부연으로 흐른 것으로 보고 거부한다(§10-4).
 * JSON Schema에는 넣지 않는다 — 길이는 zod 담당(§1 공통 규칙).
 */
export const WORD_MEANING_KO_MAX = 40;

/** 호출 G의 출력 — 그 문맥에서의 우리말 뜻 하나. required-nullable 없음(항상 있는 값). */
export interface WordMeaning {
  meaningKo: string;
}

// ---------------------------------------------------------------------------
// 호출 G — word_meaning JSON Schema (스펙 §10-3 원문)
// 모든 필드 required + additionalProperties:false (strict 모드 규약).
// 선택 키·null 유니온 없음 — 뜻은 항상 하나 있어야 한다. 길이 제약은 zod가 담당한다.
// ---------------------------------------------------------------------------

export const WORD_MEANING_JSON_SCHEMA: StrictJsonSchema = {
  name: "word_meaning",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      meaningKo: {
        type: "string",
        description: "그 문장 맥락에서 이 단어의 우리말 뜻. 한 낱말~짧은 구, 한글만.",
      },
    },
    required: ["meaningKo"],
  },
};

// ---------------------------------------------------------------------------
// 호출 G — zod 이중 검증 (스펙 §10-4)
// JSON Schema가 못 잡는 것: 길이 상한, "한글만"(원어 echo 차단), 영어 단어 연속 금지.
// ---------------------------------------------------------------------------

/**
 * 호출 G 결과의 zod 스키마 (§10-4). JSON Schema와 필드·타입이 1:1이고, 그 위에 "짧게·한글만"
 * 규칙을 superRefine으로 얹는다. 생산 시점(callWithSchema)에 걸어야 1회 재요청이 그 자리에서
 * 교정한다.
 */
export const wordMeaningSchema = z
  .object({
    meaningKo: z.string().trim().min(1).max(WORD_MEANING_KO_MAX),
  })
  .superRefine((data, ctx) => {
    // 한글만 — 우리말 뜻이므로 한글이 한 글자도 없으면 뜻이 아니라 원어(영단어) echo다
    if (!containsHangul(data.meaningKo)) {
      ctx.addIssue({
        code: "custom",
        path: ["meaningKo"],
        message: "우리말 뜻에는 한글이 있어야 합니다 (영어 단어를 그대로 옮기지 마세요)",
      });
    }
    // 영어 단어가 2개 이상 연속되면 원문 문장·단어를 그대로 옮긴 것으로 보고 거부한다.
    // (한글에 영어 낱말 1개가 섞이는 것은 막지 않는다 — 고유명사 등.)
    if (longestEnglishRun(data.meaningKo) >= 2) {
      ctx.addIssue({
        code: "custom",
        path: ["meaningKo"],
        message: "우리말 뜻에 영어 단어를 이어 쓰지 마세요 (뜻만 한글로)",
      });
    }
  });

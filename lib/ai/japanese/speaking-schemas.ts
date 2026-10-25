/**
 * lib/ai/japanese/speaking-schemas.ts — 말하기 모의고사 호출 E(문항 생성 E1~E5)·F(답변 피드백) JSON Schema + zod + 타입
 * (docs/harness/japanese.md §15-3·§15-4)
 *
 * 4중 정의(프롬프트↔JSON Schema↔zod↔eval)의 뿌리. JSON Schema 6개는 스펙 코드블록과 **의미 동치**로 대조된다
 * (scripts/eval-japanese-speaking.ts). 후리가나 토큰 zod(`jaTokenSchema`)·무결성 판정은 schemas.ts의 것을 그대로 쓴다(§5 단일 정의).
 *
 * - 배열 개수는 JSON Schema에 넣지 않는다(minItems/maxItems 금지 — HARNESS §1). 프롬프트 + zod가 담당한다.
 * - zod 폭은 프롬프트 안내보다 넓다(lib/ja-speaking.ts의 jaSpeakingZodAnswerBand·JA_SPEAKING_ZOD_PASSAGE — 단일 정의).
 * - 전부 필수 nullable — 선택(?) 키 금지(저장 레코드가 Firestore로 간다).
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";
import { hasHangul, hasJapanese, hasKanji, isAllKanji, jaTokenSchema, tokensJoinEqual, type JaToken, type JlptLevel } from "./schemas";
import {
  JA_SPEAKING_ZOD_PASSAGE,
  countJaSpeechChars,
  jaSpeakingMaxScore,
  jaSpeakingQuestionFormat,
  jaSpeakingZodAnswerBand,
  type JaSpeakingPart,
} from "../../ja-speaking";
import { isSaidInJaTranscript } from "../../ja-speaking-score";

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 일본어 한 줄 — 원문 + 후리가나 토큰 + 한국어 뜻(펼쳐 보기) */
export interface JaLine {
  ja: string;
  tokens: JaToken[];
  ko: string;
}

export const JA_SPEAKING_READ_KINDS = ["advertisement", "announcement", "news", "introduction", "tour", "voicemail"] as const;
export type JaSpeakingReadKind = (typeof JA_SPEAKING_READ_KINDS)[number];
export const JA_SPEAKING_INFO_KINDS = ["schedule", "itinerary", "timetable", "interview", "resume"] as const;
export type JaSpeakingInfoKind = (typeof JA_SPEAKING_INFO_KINDS)[number];
export const JA_SPEAKING_OPINION_KINDS = ["agree", "choice", "proscons"] as const;
export type JaSpeakingOpinionKind = (typeof JA_SPEAKING_OPINION_KINDS)[number];
/** 호출 F의 추정 수준 — N5에도 못 미치면 below_n5 */
export const JA_SPEAKING_LEVEL_ESTIMATES = ["N1", "N2", "N3", "N4", "N5", "below_n5"] as const;
export type JaSpeakingLevelEstimate = (typeof JA_SPEAKING_LEVEL_ESTIMATES)[number];

export interface JaSpeakingReadPart {
  items: { kind: JaSpeakingReadKind; passage: JaLine; tipsKo: string[] }[];
}
export interface JaSpeakingPictureGenItem {
  place: string;
  imagePrompt: string;
  sceneKo: string;
  sampleAnswer: JaLine;
  keyPointsKo: string[];
}
export interface JaSpeakingPictureGen {
  items: JaSpeakingPictureGenItem[];
}
/** 저장용 사진 칸 — 관문 P(일본 배경)가 채운다. 토익 C2와 같은 상태 셋 */
export interface JaSpeakingImageSlot {
  status: "pending" | "ready" | "failed";
  imageId: string | null;
}
export interface JaSpeakingPicturePart {
  items: (JaSpeakingPictureGenItem & { image: JaSpeakingImageSlot })[];
}
export interface JaSpeakingQuestion {
  question: JaLine;
  sampleAnswer: JaLine;
  tipKo: string;
}
export interface JaSpeakingRespondPart {
  topicKo: string;
  intro: JaLine;
  questions: JaSpeakingQuestion[];
}
export interface JaSpeakingInfoTable {
  kind: JaSpeakingInfoKind;
  title: string;
  titleKo: string;
  meta: string[];
  rows: { left: string; right: string }[];
  notes: string[];
}
export interface JaSpeakingInfoPart {
  table: JaSpeakingInfoTable;
  callerIntro: JaLine;
  questions: JaSpeakingQuestion[];
}
export interface JaSpeakingOpinionPart {
  kind: JaSpeakingOpinionKind;
  question: JaLine;
  sampleAnswer: JaLine;
  outlineKo: string[];
  tipKo: string;
}

/** 모델 출력(파트별) */
export interface JaSpeakingPartGenMap {
  read: JaSpeakingReadPart;
  picture: JaSpeakingPictureGen;
  respond: JaSpeakingRespondPart;
  info: JaSpeakingInfoPart;
  opinion: JaSpeakingOpinionPart;
}
/** 레코드에 넣는 파트(사진만 image 칸이 붙는다) */
export interface JaSpeakingPartRecordMap {
  read: JaSpeakingReadPart;
  picture: JaSpeakingPicturePart;
  respond: JaSpeakingRespondPart;
  info: JaSpeakingInfoPart;
  opinion: JaSpeakingOpinionPart;
}

/** 호출 F 결과(§15-4-3) 그대로 저장한다 */
export interface JaSpeakingFeedback {
  score: number;
  levelEstimate: JaSpeakingLevelEstimate;
  levelReasonKo: string;
  summaryKo: string;
  strengths: string[];
  fixes: { said: string; better: string; whyKo: string }[];
  missingKo: string[];
  improvedAnswer: JaLine;
}

// ---------------------------------------------------------------------------
// JSON Schema (strict) — $defs line·tokens는 여섯 스키마가 같은 객체를 쓴다
// ---------------------------------------------------------------------------

const JA_SPEAKING_DEFS = {
  line: {
    type: "object",
    additionalProperties: false,
    required: ["ja", "tokens", "ko"],
    properties: {
      ja: { type: "string" },
      tokens: { $ref: "#/$defs/tokens" },
      ko: { type: "string" },
    },
  },
  tokens: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["surface", "reading"],
      properties: {
        surface: { type: "string" },
        reading: { type: ["string", "null"] },
      },
    },
  },
} as const;

const LINE_REF = { $ref: "#/$defs/line" } as const;
const STR = { type: "string" } as const;
const STR_ARR = { type: "array", items: { type: "string" } } as const;
const QUESTION_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["question", "sampleAnswer", "tipKo"],
  properties: { question: LINE_REF, sampleAnswer: LINE_REF, tipKo: STR },
} as const;

/** 여섯 스키마가 공유하는 $defs(eval이 같은 객체인지 본다) */
export const JA_SPEAKING_JSON_DEFS = JA_SPEAKING_DEFS;

export const JA_SPEAKING_JSON_SCHEMAS: Record<JaSpeakingPart, StrictJsonSchema> = {
  read: {
    name: "ja_speaking_read",
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
            required: ["kind", "passage", "tipsKo"],
            properties: {
              kind: { type: "string", enum: [...JA_SPEAKING_READ_KINDS] },
              passage: LINE_REF,
              tipsKo: STR_ARR,
            },
          },
        },
      },
      $defs: JA_SPEAKING_DEFS,
    },
  },
  picture: {
    name: "ja_speaking_picture",
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
            required: ["place", "imagePrompt", "sceneKo", "sampleAnswer", "keyPointsKo"],
            properties: {
              place: STR,
              imagePrompt: STR,
              sceneKo: STR,
              sampleAnswer: LINE_REF,
              keyPointsKo: STR_ARR,
            },
          },
        },
      },
      $defs: JA_SPEAKING_DEFS,
    },
  },
  respond: {
    name: "ja_speaking_respond",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["topicKo", "intro", "questions"],
      properties: {
        topicKo: STR,
        intro: LINE_REF,
        questions: { type: "array", items: QUESTION_ITEM },
      },
      $defs: JA_SPEAKING_DEFS,
    },
  },
  info: {
    name: "ja_speaking_info",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["table", "callerIntro", "questions"],
      properties: {
        table: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "titleKo", "meta", "rows", "notes"],
          properties: {
            kind: { type: "string", enum: [...JA_SPEAKING_INFO_KINDS] },
            title: STR,
            titleKo: STR,
            meta: STR_ARR,
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["left", "right"],
                properties: { left: STR, right: STR },
              },
            },
            notes: STR_ARR,
          },
        },
        callerIntro: LINE_REF,
        questions: { type: "array", items: QUESTION_ITEM },
      },
      $defs: JA_SPEAKING_DEFS,
    },
  },
  opinion: {
    name: "ja_speaking_opinion",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "question", "sampleAnswer", "outlineKo", "tipKo"],
      properties: {
        kind: { type: "string", enum: [...JA_SPEAKING_OPINION_KINDS] },
        question: LINE_REF,
        sampleAnswer: LINE_REF,
        outlineKo: STR_ARR,
        tipKo: STR,
      },
      $defs: JA_SPEAKING_DEFS,
    },
  },
};

export const JA_SPEAKING_FEEDBACK_JSON_SCHEMA: StrictJsonSchema = {
  name: "ja_speaking_feedback",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "levelEstimate", "levelReasonKo", "summaryKo", "strengths", "fixes", "missingKo", "improvedAnswer"],
    properties: {
      score: { type: "integer" },
      levelEstimate: { type: "string", enum: [...JA_SPEAKING_LEVEL_ESTIMATES] },
      levelReasonKo: STR,
      summaryKo: STR,
      strengths: STR_ARR,
      fixes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["said", "better", "whyKo"],
          properties: { said: STR, better: STR, whyKo: STR },
        },
      },
      missingKo: STR_ARR,
      improvedAnswer: LINE_REF,
    },
    $defs: JA_SPEAKING_DEFS,
  },
};

// ---------------------------------------------------------------------------
// zod 상한·폭 (단일 정의)
// ---------------------------------------------------------------------------

export const JA_SPEAKING_LIMITS = {
  /** 한 줄 일본어·한국어 최대 글자 */
  lineJaMax: 600,
  lineKoMax: 800,
  /** 한국어 설명 한 줄 최대 */
  koTextMax: 300,
  tipsKo: [2, 4],
  keyPointsKo: [3, 5],
  outlineKo: [3, 5],
  imagePromptWords: [40, 160],
  placeMax: 40,
  tableRows: [4, 10],
  tableMeta: [1, 4],
  tableNotes: [0, 3],
  tableCellMax: 80,
  strengths: [1, 3],
  fixes: [0, 5],
  missingKo: [0, 3],
  fixTextMax: 300,
  topicHintsMax: 3,
  topicHintMax: 30,
} as const;

// ---------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------

const koText = (max: number = JA_SPEAKING_LIMITS.koTextMax) =>
  z.string().trim().min(1).max(max).refine(hasHangul, { message: "한국어(한글)가 있어야 합니다" });

/** 일본어 문자열(한글 금지·일본 문자 포함) */
const jaText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(hasJapanese, { message: "일본 문자가 있어야 합니다" })
    .refine((s) => !hasHangul(s), { message: "일본어 칸에 한글이 섞이면 안 됩니다" });

/** 일본어 한 줄 — 토큰 무결성(이어 붙이면 ja)·ko 한글 */
const jaLineSchema = z
  .object({
    ja: jaText(JA_SPEAKING_LIMITS.lineJaMax),
    tokens: z.array(jaTokenSchema).min(1),
    ko: koText(JA_SPEAKING_LIMITS.lineKoMax),
  })
  .superRefine((l, ctx) => {
    if (!tokensJoinEqual(l.tokens, l.ja)) ctx.addIssue({ code: "custom", path: ["tokens"], message: "tokens.surface를 이으면 ja와 같아야 합니다" });
    // 말하기 전용 토큰 규칙(§15-3-9, QA speaking-ai 1 P2-A): 한자가 든 토큰은 한자만이고 reading이 있어야 한다.
    // Q1–2 대조(§15-5)가 지문 토큰의 읽기 갈래에 기대고, 응시 중 후리가나 토글도 이 읽기를 보인다. 단어장 공용 jaTokenSchema는 그대로다.
    const bad = jaLineKanjiTokenIssue(l.tokens);
    if (bad !== null) ctx.addIssue({ code: "custom", path: ["tokens", bad], message: "한자가 든 토큰은 한자만으로 이뤄지고 reading(히라가나)이 있어야 합니다 — 오쿠리가나·숫자는 따로 가르세요" });
  });

/** 말하기 줄 토큰 규칙 위반 위치 — 한자가 든 토큰인데 한자만이 아니거나 reading이 null이면 그 인덱스, 없으면 null */
export function jaLineKanjiTokenIssue(tokens: readonly JaToken[]): number | null {
  const i = tokens.findIndex((t) => hasKanji(t.surface) && (!isAllKanji(t.surface) || t.reading === null));
  return i >= 0 ? i : null;
}

/** 일본어 한 줄 + 발화 글자 수 폭 */
function jaLineWithin([min, max]: readonly [number, number], label: string) {
  return jaLineSchema.superRefine((l, ctx) => {
    const n = countJaSpeechChars(l.ja);
    if (n < min || n > max) ctx.addIssue({ code: "custom", path: ["ja"], message: `${label} 글자 수 ${n} — ${min}~${max}자여야 합니다` });
  });
}

const answerBandFor = (q: number) => jaSpeakingZodAnswerBand(jaSpeakingQuestionFormat(q).answerSec);

const countBetween = <T extends z.ZodTypeAny>(item: T, [min, max]: readonly [number, number]) => z.array(item).min(min).max(max);

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** 질문 ja는 か 또는 ？/?로 끝난다(뒤의 。 하나는 허용) — 듣고 답하기·정보 활용 */
export function isJaQuestionEnding(s: string): boolean {
  return /[か？?]。?$/.test(s.trim());
}

const questionLine = jaLineSchema.superRefine((l, ctx) => {
  if (!isJaQuestionEnding(l.ja)) ctx.addIssue({ code: "custom", path: ["ja"], message: "질문은 か 또는 ？로 끝나야 합니다" });
});

function questionsSchema(qs: readonly number[]) {
  return z
    .array(z.object({ question: questionLine, sampleAnswer: jaLineSchema, tipKo: koText() }))
    .length(qs.length)
    .superRefine((items, ctx) => {
      items.forEach((it, i) => {
        const [min, max] = answerBandFor(qs[i]);
        const n = countJaSpeechChars(it.sampleAnswer.ja);
        if (n < min || n > max) {
          ctx.addIssue({ code: "custom", path: [i, "sampleAnswer", "ja"], message: `Q${qs[i]} 모범답변 글자 수 ${n} — ${min}~${max}자여야 합니다` });
        }
      });
    });
}

const readZod = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(JA_SPEAKING_READ_KINDS),
        passage: jaLineWithin(JA_SPEAKING_ZOD_PASSAGE, "지문"),
        tipsKo: countBetween(koText(), JA_SPEAKING_LIMITS.tipsKo),
      }),
    )
    .length(2)
    .superRefine((items, ctx) => {
      if (items.length === 2 && items[0].kind === items[1].kind) ctx.addIssue({ code: "custom", path: [1, "kind"], message: "두 지문의 kind가 달라야 합니다" });
    }),
});

const pictureZod = z.object({
  items: z
    .array(
      z.object({
        place: z.string().trim().min(1).max(JA_SPEAKING_LIMITS.placeMax),
        imagePrompt: z
          .string()
          .trim()
          .min(1)
          .refine((s) => /[A-Za-z]/.test(s) && !hasHangul(s), { message: "imagePrompt는 영어여야 합니다(한글 금지)" })
          .refine((s) => {
            const n = wordCount(s);
            return n >= JA_SPEAKING_LIMITS.imagePromptWords[0] && n <= JA_SPEAKING_LIMITS.imagePromptWords[1];
          }, { message: `imagePrompt는 ${JA_SPEAKING_LIMITS.imagePromptWords[0]}~${JA_SPEAKING_LIMITS.imagePromptWords[1]}단어여야 합니다` }),
        sceneKo: koText(),
        sampleAnswer: jaLineWithin(answerBandFor(3), "Q3–4 모범답변"),
        keyPointsKo: countBetween(koText(), JA_SPEAKING_LIMITS.keyPointsKo),
      }),
    )
    .length(2)
    .superRefine((items, ctx) => {
      const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      if (items.length === 2 && key(items[0].place) === key(items[1].place)) ctx.addIssue({ code: "custom", path: [1, "place"], message: "두 장면의 place가 달라야 합니다" });
    }),
});

const respondZod = z.object({
  topicKo: koText(30),
  intro: jaLineSchema,
  questions: questionsSchema([5, 6, 7]),
});

const tableCell = z
  .string()
  .trim()
  .min(1)
  .max(JA_SPEAKING_LIMITS.tableCellMax)
  .refine((s) => !hasHangul(s), { message: "표 칸에 한글이 섞이면 안 됩니다" });

const infoZod = z.object({
  table: z.object({
    kind: z.enum(JA_SPEAKING_INFO_KINDS),
    title: jaText(JA_SPEAKING_LIMITS.tableCellMax),
    titleKo: koText(JA_SPEAKING_LIMITS.tableCellMax),
    meta: countBetween(tableCell, JA_SPEAKING_LIMITS.tableMeta),
    rows: countBetween(z.object({ left: tableCell, right: tableCell }), JA_SPEAKING_LIMITS.tableRows),
    notes: countBetween(tableCell, JA_SPEAKING_LIMITS.tableNotes),
  }),
  callerIntro: jaLineSchema,
  questions: questionsSchema([8, 9, 10]),
});

const opinionZod = z.object({
  kind: z.enum(JA_SPEAKING_OPINION_KINDS),
  question: jaLineSchema,
  sampleAnswer: jaLineWithin(answerBandFor(11), "Q11 모범답변"),
  outlineKo: countBetween(koText(), JA_SPEAKING_LIMITS.outlineKo),
  tipKo: koText(),
});

/** 호출 E 파트별 zod(입력과 무관 — 고정) */
export const JA_SPEAKING_ZOD: { [P in JaSpeakingPart]: z.ZodType<JaSpeakingPartGenMap[P]> } = {
  read: readZod,
  picture: pictureZod,
  respond: respondZod,
  info: infoZod,
  opinion: opinionZod,
};

/**
 * 호출 F zod — 만점(문항)·전사문을 알고 만든다(score 범위·`said` ⊂ 전사문). 환각 차단: 하지 않은 말을 고쳤다고 쓰면 거부 → 1회 재요청.
 */
export function buildJaSpeakingFeedbackZod(input: { q: number; transcript: string }) {
  const max = jaSpeakingMaxScore(input.q);
  return z.object({
    score: z.number().int().min(0).max(max),
    levelEstimate: z.enum(JA_SPEAKING_LEVEL_ESTIMATES),
    levelReasonKo: koText(),
    summaryKo: koText(),
    strengths: countBetween(koText(), JA_SPEAKING_LIMITS.strengths),
    fixes: countBetween(
      z.object({
        said: z
          .string()
          .trim()
          .min(1)
          .max(JA_SPEAKING_LIMITS.fixTextMax)
          .refine((s) => isSaidInJaTranscript(s, input.transcript), { message: "said는 전사문에 그대로 있는 구간이어야 합니다(2글자 이상)" }),
        better: jaText(JA_SPEAKING_LIMITS.fixTextMax),
        whyKo: koText(),
      }),
      JA_SPEAKING_LIMITS.fixes,
    ),
    missingKo: countBetween(koText(), JA_SPEAKING_LIMITS.missingKo),
    improvedAnswer: jaLineSchema,
  });
}

/** 만들기 요청 입력 모양(라우트 zod는 app-builder가 계약 파일과 묶는다 — 여기 값은 상한의 단일 정의) */
export interface JaSpeakingGenInput {
  level: JlptLevel;
  /** 사용자가 고른 주제(0~JA_SPEAKING_LIMITS.topicHintsMax개). 비면 "없음" */
  topicHints: readonly string[];
}

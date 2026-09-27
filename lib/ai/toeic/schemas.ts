/**
 * lib/ai/toeic/schemas.ts — 아빠의 영어(토익스피킹) 호출 A·B·C1~C5·D 데이터 모델 + JSON Schema + zod + 상한 상수
 * (docs/harness/toeic.md §2-3·§2-4·§3-3·§3-4·§4-8·§4-9·§5-3·§7·§7-6)
 *
 * 이 파일이 4중 정의(프롬프트↔JSON Schema↔zod↔eval)의 뿌리다.
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 은우 영어 단어장(vocabbook-*)의 초등 눈높이 규칙을 가져오지 않는다. 설명은 한국어, 학습 대상은 영어.
 * 은우 단어장의 `word/pos/ipa` 대신 `expression/meaningKo/points` 모양을 **새로** 둔다(§10) — 은우 코드는 고치지 않는다.
 *
 * ── JSON Schema는 스펙 원문 그대로 ───────────────────────────────────────────
 * 8개 스키마 상수는 스펙 JSON 코드블록을 그대로 옮겼다(scripts/eval-toeic.ts가 스펙을 파싱해 의미 동치로 대조).
 * 배열 개수 제약은 JSON Schema에 넣지 않는다(docs/HARNESS.md §1) — 프롬프트 + zod가 담당한다.
 *
 * ── zod 폭 (§4-9) ─────────────────────────────────────────────────────────────
 * 호출 C는 프롬프트보다 **넓은 폭**으로 건다(경계에서 재요청을 태우지 않고, 크게 벗어난 것만 거부). 폭은
 * TOEIC_MOCK_ZOD_BANDS 한 곳에만 둔다. 호출 A·B·D의 상한도 아래 상수 한 곳에만 둔다.
 *
 * ── 전부 필수 nullable — 선택(?) 키 금지 (lib/store.ts 규약, Firestore가 undefined를 거부) ─────────────
 */

import { z } from "zod";
import type { StrictJsonSchema } from "../english/schemas";
import {
  TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO,
  collapseSpaces,
  containsWordSequence,
  countWords,
  expressionKey,
  findDuplicateExpressionIndexes,
  hasHangul,
  hasLatin,
  matchKey,
} from "../../toeic-text";
import {
  TOEIC_MOCK_PARTS,
  TOEIC_TARGET_GRADES,
  type ToeicMockPart,
  type ToeicTargetGrade,
} from "../../toeic-mock";
import {
  TOEIC_GUIDE_PARTS,
  TOEIC_GUIDE_SLOT_NAME_MAX,
  TOEIC_TEMPLATE_BANK_SLOT,
  guideLineEn,
  scanSlots,
  textOutsideSlots,
  type ToeicGuidePart,
  type ToeicSlotProblem,
} from "../../toeic-guide";
import {
  TOEIC_TEMPLATE_ITEM_KEY_RE,
  TOEIC_TEMPLATE_KEY_RE,
  TOEIC_TEMPLATE_TEST_MAX,
  expressionFixedPartsInFrame,
  fillFrame,
  frameSlotNames,
  frameToExpression,
  leadMatchesFrame,
  normalizeTemplateWords,
  parseFrame,
  toeicGuideAlignmentTargets,
} from "../../toeic-template";
import { TOEIC_TEMPLATE_QUIZ_MODES, type ToeicTemplateQuizMode } from "../../toeic-quiz";
import { TTS_TEXT_MAX_CHARS } from "../../tts-shared";
import { toToeicIssues } from "../../toeic-zod-ko";
import { TOEIC_TEMPLATE_SESSION_ID_RE, type ToeicTemplateSessionRequest } from "../../toeic-guide-contract";

export { TOEIC_MOCK_PARTS, TOEIC_TARGET_GRADES, TOEIC_GUIDE_PARTS };
export type { ToeicMockPart, ToeicTargetGrade, ToeicGuidePart };

// ---------------------------------------------------------------------------
// 유니온 상수 (as const 배열) — JSON Schema enum·zod·화면이 같은 상수를 본다 (eval이 enum과 대조)
// ---------------------------------------------------------------------------

/** 발화 포인트의 문항 축(호출 B useIn.part, §3-3 enum) */
export const TOEIC_PARTS = ["q1_2", "q3_4", "q5_7", "q8_10", "q11"] as const;
export type ToeicPart = (typeof TOEIC_PARTS)[number];

/** 판독 신뢰도(§2-3 enum) */
export const TOEIC_CONFIDENCES = ["high", "medium", "low"] as const;
export type ToeicConfidence = (typeof TOEIC_CONFIDENCES)[number];

/** C1 지문 종류(§4-8 read enum) */
export const TOEIC_READ_KINDS = ["advertisement", "announcement", "news", "introduction", "tour", "voicemail"] as const;
export type ToeicReadKind = (typeof TOEIC_READ_KINDS)[number];

/** C4 표 종류(§4-8 info enum) */
export const TOEIC_INFO_KINDS = ["schedule", "itinerary", "timetable", "interview", "resume"] as const;
export type ToeicInfoKind = (typeof TOEIC_INFO_KINDS)[number];

/** C5 의견 질문 형식(§4-8 opinion enum) */
export const TOEIC_OPINION_KINDS = ["agree", "choice", "proscons"] as const;
export type ToeicOpinionKind = (typeof TOEIC_OPINION_KINDS)[number];

/** Q3–4 생성 사진 상태(§4-10·§7-2) */
export const TOEIC_IMAGE_STATUSES = ["pending", "ready", "failed"] as const;
export type ToeicImageStatus = (typeof TOEIC_IMAGE_STATUSES)[number];

// ---------------------------------------------------------------------------
// 상한·폭 상수 — 생산자(zod)와 소비자(화면·라우트·eval)의 단일 정의처
// ---------------------------------------------------------------------------

/** 한 번에 판독할 사진 수 상한(§2-0 "최대 8장") */
export const TOEIC_EXTRACT_MAX_PHOTOS = 8;
/** 호출 A — 사진당 표현 항목 0~30개(§2-4) */
export const TOEIC_EXTRACT_ENTRIES_MAX = 30;
/** 호출 A — 사진당 QUIZ 0~6개(§2-4) */
export const TOEIC_EXTRACT_QUIZ_MAX = 6;
/** 교재 번호·DAY 번호 범위 1~999(§2-4) */
export const TOEIC_NO_MIN = 1;
export const TOEIC_NO_MAX = 999;
/** expression 1~80자(§2-4) */
export const TOEIC_EXPRESSION_MAX = 80;
/** meaningKo 1~80자(§2-4) */
export const TOEIC_MEANING_KO_MAX = 80;
/** example 3~300자(§2-4) */
export const TOEIC_EXAMPLE_MIN = 3;
export const TOEIC_EXAMPLE_MAX = 300;
/** QUIZ hint null 또는 1~60자(§2-4) */
export const TOEIC_HINT_MAX = 60;

/** 세트(한 DAY) 상한(§7-1): entries 1~60, quiz 0~12, titleKo 1~120자 */
export const TOEIC_SET_ENTRIES_MIN = 1;
export const TOEIC_SET_ENTRIES_MAX = 60;
export const TOEIC_SET_QUIZ_MAX = 12;
export const TOEIC_SET_TITLE_MAX = 120;

/** 호출 B — 한 번에 넘기는 표현 수(§3-0 "7개씩 끊어 병렬 호출") */
export const TOEIC_POINTS_CHUNK_SIZE = 7;
/** 호출 B zod 상한(§3-4) — 한 곳에만 둔다 */
export const TOEIC_POINTS_LIMITS = {
  coreKo: [4, 70],
  useIn: [2, 3],
  useSentenceWords: [6, 32],
  useSentenceMaxChars: 220,
  useSentenceKoMaxChars: 160,
  frames: [1, 3],
  frameChars: [5, 90],
  variations: [2, 4],
  variationEnChars: [2, 60],
  variationKoChars: [1, 60],
  pronunciationKo: [6, 110],
  noteKo: [4, 110],
  followUpEnChars: [10, 200],
  followUpKoChars: [4, 160],
} as const;
/** 답변 틀의 빈자리 표시(§3-1 frames "___") */
export const TOEIC_FRAME_SLOT = "___";

/** 호출 C — 활용할 표현 최대 개수(§4-0 "최대 24개") */
export const TOEIC_MOCK_EXPRESSIONS_MAX = 24;
/** C2 place 길이 상한(스펙 공백 — 방어적 상한, 리포트 참고) */
export const TOEIC_PICTURE_PLACE_MAX = 60;
/**
 * 호출 C zod 폭(§4-9) — 프롬프트보다 넓게. [min, max] 단어 수 또는 개수. **여기 한 곳에만 둔다.**
 * 예: 프롬프트 "80~110단어" → zod 60~130.
 */
export const TOEIC_MOCK_ZOD_BANDS = {
  readItems: 2,
  readTextWords: [60, 130],
  readStressWords: [4, 14],
  readTips: [2, 4],
  pictureItems: 2,
  pictureImagePromptWords: [40, 160],
  pictureSampleWords: [40, 110],
  pictureKeyPoints: [3, 5],
  respondQuestions: 3,
  respondShortWords: [15, 60],
  respondLongWords: [35, 110],
  infoRows: [4, 10],
  infoMeta: [1, 4],
  infoNotes: [0, 3],
  infoQuestions: 3,
  infoShortWords: [5, 60],
  infoLongWords: [25, 110],
  opinionWords: [80, 180],
  opinionOutline: [3, 5],
} as const;

/** 호출 D zod 개수(§5-3) */
export const TOEIC_FEEDBACK_LIMITS = {
  strengths: [1, 3],
  fixes: [0, 5],
  missingKo: [0, 3],
  /** tryExpressions는 zod가 아니라 후처리가 목록 대조·상한을 건다(§5-3) */
  tryExpressionsMax: 3,
} as const;

/** 가져오기 파일 형식 식별자(§7-6) */
export const TOEIC_IMPORT_FORMAT = "toeic-sets/v1";
/** 가져오기 한 파일의 세트 수 상한(스펙 공백 — 방어적 상한) */
export const TOEIC_IMPORT_SETS_MAX = 100;
/** presetKey 형식(스펙 공백 — 소문자·숫자·하이픈 조각, 예 "vendor-core-day01") */
export const TOEIC_PRESET_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TOEIC_PRESET_KEY_MAX = 80;

// ---------------------------------------------------------------------------
// TypeScript 타입 — 모델 출력과 저장 레코드 하위 타입(§7)
// ---------------------------------------------------------------------------

/** 호출 A 표현 항목(판독 원문) */
export interface ToeicExtractEntry {
  no: number | null;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  partial: boolean;
  confidence: ToeicConfidence;
}

/** 교재 하단 QUIZ(호출 A 출력 = 저장 모양, §7-1) */
export interface ToeicBookQuiz {
  no: number | null;
  promptKo: string;
  hint: string | null;
  modelAnswer: string;
  /** 이 세트 entries[].expression 중 하나씩(후처리가 정리) */
  keyExpressions: string[];
}

/** 호출 A 출력(§2-3) */
export interface ToeicExprExtraction {
  isExpressionPage: boolean;
  dayNo: number | null;
  topicKo: string | null;
  entries: ToeicExtractEntry[];
  quiz: ToeicBookQuiz[];
}

/** 발화 포인트의 문항별 활용 문장 */
export interface ToeicUseIn {
  part: ToeicPart;
  sentence: string;
  sentenceKo: string;
}

export interface ToeicEnKo {
  en: string;
  ko: string;
}

/** 호출 B 결과 — 표현 하나의 발화 포인트(§3-0·§7-1) */
export interface ToeicSpeakingPoints {
  exampleSpan: string | null;
  coreKo: string;
  useIn: ToeicUseIn[];
  frames: string[];
  variations: ToeicEnKo[];
  pronunciationKo: string;
  pitfallKo: string | null;
  grammarKo: string | null;
  followUp: ToeicEnKo;
}

/** 호출 B 출력 항목 — 발화 포인트 + 세트 entries 배열 위치(index) */
export interface ToeicPointsItem extends ToeicSpeakingPoints {
  index: number;
}

/** 호출 B 출력(§3-3) */
export interface ToeicPointsGeneration {
  items: ToeicPointsItem[];
}

/** 호출 B 입력 한 줄(§3-2) — index는 **세트 전체 entries 배열 위치** */
export interface ToeicPointsInput {
  index: number;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
}

/** 저장 표현 항목(§7-1) */
export interface ToeicExprEntry {
  no: number | null;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  /** 없으면 null(best-effort) */
  points: ToeicSpeakingPoints | null;
  confidence: ToeicConfidence;
  partial: boolean;
}

/** 표현집 세트 출처(§7-1) */
export type ToeicSetSource = "photo" | "import";

/** 호출 C 공통 — 모범답변에 녹인 활용할 표현 */
export interface ToeicUsedExpression {
  /** 활용할 표현 목록의 문자열 그대로 */
  expression: string;
  /** 모범답변 속 실제 구간 */
  span: string;
}

/** C1 지문 하나 */
export interface ToeicReadItem {
  kind: ToeicReadKind;
  text: string;
  chunks: string[];
  stressWords: string[];
  tipsKo: string[];
}
/** C1 출력 = 저장 파트(§4-8·§7-2) */
export interface ToeicReadPart {
  items: ToeicReadItem[];
}

/** C2 장면 하나(모델 출력) */
export interface ToeicPictureItemGen {
  place: string;
  imagePrompt: string;
  sceneKo: string;
  sampleAnswer: string;
  keyPointsKo: string[];
  usedExpressions: ToeicUsedExpression[];
}
/** C2 출력 */
export interface ToeicPictureGeneration {
  items: ToeicPictureItemGen[];
}
/** Q3–4 생성 사진 참조(§4-10) — failed면 imageId null */
export interface ToeicPictureImage {
  status: ToeicImageStatus;
  imageId: string | null;
}
/** 저장 장면 = 모델 출력 + image */
export interface ToeicPictureItem extends ToeicPictureItemGen {
  image: ToeicPictureImage;
}
export interface ToeicPicturePart {
  items: ToeicPictureItem[];
}

/** C3·C4 질문 하나 */
export interface ToeicMockQuestion {
  question: string;
  sampleAnswer: string;
  tipKo: string;
  usedExpressions: ToeicUsedExpression[];
}
/** C3 출력 = 저장 파트 */
export interface ToeicRespondPart {
  topicKo: string;
  intro: string;
  questions: ToeicMockQuestion[];
}

export interface ToeicInfoRow {
  left: string;
  right: string;
}
export interface ToeicInfoTable {
  kind: ToeicInfoKind;
  title: string;
  meta: string[];
  rows: ToeicInfoRow[];
  notes: string[];
}
/** C4 출력 = 저장 파트 */
export interface ToeicInfoPart {
  table: ToeicInfoTable;
  callerIntro: string;
  questions: ToeicMockQuestion[];
}

/** C5 출력 = 저장 파트 */
export interface ToeicOpinionPart {
  kind: ToeicOpinionKind;
  question: string;
  sampleAnswer: string;
  outlineKo: string[];
  tipKo: string;
  usedExpressions: ToeicUsedExpression[];
}

/** 파트 → 모델 출력 타입 */
export interface ToeicMockPartGenMap {
  read: ToeicReadPart;
  picture: ToeicPictureGeneration;
  respond: ToeicRespondPart;
  info: ToeicInfoPart;
  opinion: ToeicOpinionPart;
}

/** 파트 → 저장 파트 타입(C2만 image가 붙는다) */
export interface ToeicMockPartRecordMap {
  read: ToeicReadPart;
  picture: ToeicPicturePart;
  respond: ToeicRespondPart;
  info: ToeicInfoPart;
  opinion: ToeicOpinionPart;
}

/** ToeicMockRecord.parts(§7-2) — 실패·미선택 파트는 null */
export type ToeicMockParts = { [P in ToeicMockPart]: ToeicMockPartRecordMap[P] | null };

/** 호출 D 결과(§5-3·§7-5) */
export interface ToeicFeedbackFix {
  said: string;
  better: string;
  whyKo: string;
}
export interface ToeicFeedback {
  score: number;
  summaryKo: string;
  strengths: string[];
  fixes: ToeicFeedbackFix[];
  missingKo: string[];
  improvedAnswer: string;
  tryExpressions: string[];
}

/** Q1–2 지문 대조 결과(§5-4·§7-5) */
export interface ToeicReadDiff {
  accuracy: number;
  missing: string[];
  extra: string[];
  substituted: { expected: string; heard: string }[];
}

/** 응시 문항 하나의 결과(§7-5) */
export interface ToeicAnswer {
  /** 1..11 */
  q: number;
  recorded: boolean;
  durationMs: number | null;
  transcript: string | null;
  readDiff: ToeicReadDiff | null;
  feedback: ToeicFeedback | null;
  score: number | null;
  scoredAt: string | null;
}

export type ToeicAttemptScope = "full" | "part";

/** 가져오기 파일의 세트 하나(§7-6) */
export interface ToeicImportSet {
  presetKey: string;
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
}
export interface ToeicImportFile {
  format: typeof TOEIC_IMPORT_FORMAT;
  sets: ToeicImportSet[];
}

// ---------------------------------------------------------------------------
// JSON Schema (strict) — 스펙 원문 그대로 8개
// ---------------------------------------------------------------------------

/** 호출 A (§2-3) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_EXPR_EXTRACTION_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_expr_extraction",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "isExpressionPage",
      "dayNo",
      "topicKo",
      "entries",
      "quiz"
    ],
    "properties": {
      "isExpressionPage": {
        "type": "boolean"
      },
      "dayNo": {
        "type": [
          "integer",
          "null"
        ]
      },
      "topicKo": {
        "type": [
          "string",
          "null"
        ]
      },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "no",
            "expression",
            "meaningKo",
            "example",
            "exampleKo",
            "partial",
            "confidence"
          ],
          "properties": {
            "no": {
              "type": [
                "integer",
                "null"
              ]
            },
            "expression": {
              "type": "string"
            },
            "meaningKo": {
              "type": "string"
            },
            "example": {
              "type": [
                "string",
                "null"
              ]
            },
            "exampleKo": {
              "type": [
                "string",
                "null"
              ]
            },
            "partial": {
              "type": "boolean"
            },
            "confidence": {
              "type": "string",
              "enum": [
                "high",
                "medium",
                "low"
              ]
            }
          }
        }
      },
      "quiz": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "no",
            "promptKo",
            "hint",
            "modelAnswer",
            "keyExpressions"
          ],
          "properties": {
            "no": {
              "type": [
                "integer",
                "null"
              ]
            },
            "promptKo": {
              "type": "string"
            },
            "hint": {
              "type": [
                "string",
                "null"
              ]
            },
            "modelAnswer": {
              "type": "string"
            },
            "keyExpressions": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 B (§3-3) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_SPEAKING_POINTS_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_speaking_points",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "index",
            "exampleSpan",
            "coreKo",
            "useIn",
            "frames",
            "variations",
            "pronunciationKo",
            "pitfallKo",
            "grammarKo",
            "followUp"
          ],
          "properties": {
            "index": {
              "type": "integer"
            },
            "exampleSpan": {
              "type": [
                "string",
                "null"
              ]
            },
            "coreKo": {
              "type": "string"
            },
            "useIn": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "part",
                  "sentence",
                  "sentenceKo"
                ],
                "properties": {
                  "part": {
                    "type": "string",
                    "enum": [
                      "q1_2",
                      "q3_4",
                      "q5_7",
                      "q8_10",
                      "q11"
                    ]
                  },
                  "sentence": {
                    "type": "string"
                  },
                  "sentenceKo": {
                    "type": "string"
                  }
                }
              }
            },
            "frames": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "variations": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "en",
                  "ko"
                ],
                "properties": {
                  "en": {
                    "type": "string"
                  },
                  "ko": {
                    "type": "string"
                  }
                }
              }
            },
            "pronunciationKo": {
              "type": "string"
            },
            "pitfallKo": {
              "type": [
                "string",
                "null"
              ]
            },
            "grammarKo": {
              "type": [
                "string",
                "null"
              ]
            },
            "followUp": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "en",
                "ko"
              ],
              "properties": {
                "en": {
                  "type": "string"
                },
                "ko": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 C1 read (§4-8) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_MOCK_READ_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_mock_read",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "text",
            "chunks",
            "stressWords",
            "tipsKo"
          ],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "advertisement",
                "announcement",
                "news",
                "introduction",
                "tour",
                "voicemail"
              ]
            },
            "text": {
              "type": "string"
            },
            "chunks": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "stressWords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tipsKo": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 C2 picture (§4-8) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_MOCK_PICTURE_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_mock_picture",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "place",
            "imagePrompt",
            "sceneKo",
            "sampleAnswer",
            "keyPointsKo",
            "usedExpressions"
          ],
          "properties": {
            "place": {
              "type": "string"
            },
            "imagePrompt": {
              "type": "string"
            },
            "sceneKo": {
              "type": "string"
            },
            "sampleAnswer": {
              "type": "string"
            },
            "keyPointsKo": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "expression",
                  "span"
                ],
                "properties": {
                  "expression": {
                    "type": "string"
                  },
                  "span": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 C3 respond (§4-8) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_MOCK_RESPOND_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_mock_respond",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "topicKo",
      "intro",
      "questions"
    ],
    "properties": {
      "topicKo": {
        "type": "string"
      },
      "intro": {
        "type": "string"
      },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "question",
            "sampleAnswer",
            "tipKo",
            "usedExpressions"
          ],
          "properties": {
            "question": {
              "type": "string"
            },
            "sampleAnswer": {
              "type": "string"
            },
            "tipKo": {
              "type": "string"
            },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "expression",
                  "span"
                ],
                "properties": {
                  "expression": {
                    "type": "string"
                  },
                  "span": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 C4 info (§4-8) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_MOCK_INFO_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_mock_info",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "table",
      "callerIntro",
      "questions"
    ],
    "properties": {
      "table": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "title",
          "meta",
          "rows",
          "notes"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "schedule",
              "itinerary",
              "timetable",
              "interview",
              "resume"
            ]
          },
          "title": {
            "type": "string"
          },
          "meta": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "rows": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "left",
                "right"
              ],
              "properties": {
                "left": {
                  "type": "string"
                },
                "right": {
                  "type": "string"
                }
              }
            }
          },
          "notes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "callerIntro": {
        "type": "string"
      },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "question",
            "sampleAnswer",
            "tipKo",
            "usedExpressions"
          ],
          "properties": {
            "question": {
              "type": "string"
            },
            "sampleAnswer": {
              "type": "string"
            },
            "tipKo": {
              "type": "string"
            },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "expression",
                  "span"
                ],
                "properties": {
                  "expression": {
                    "type": "string"
                  },
                  "span": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

/** 호출 C5 opinion (§4-8) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_MOCK_OPINION_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_mock_opinion",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind",
      "question",
      "sampleAnswer",
      "outlineKo",
      "tipKo",
      "usedExpressions"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "agree",
          "choice",
          "proscons"
        ]
      },
      "question": {
        "type": "string"
      },
      "sampleAnswer": {
        "type": "string"
      },
      "outlineKo": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "tipKo": {
        "type": "string"
      },
      "usedExpressions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "expression",
            "span"
          ],
          "properties": {
            "expression": {
              "type": "string"
            },
            "span": {
              "type": "string"
            }
          }
        }
      }
    }
  }
};

/** 호출 D (§5-3) — 스펙 JSON 코드블록 그대로(eval이 의미 동치로 대조). */
export const TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA: StrictJsonSchema = {
  "name": "toeic_answer_feedback",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "score",
      "summaryKo",
      "strengths",
      "fixes",
      "missingKo",
      "improvedAnswer",
      "tryExpressions"
    ],
    "properties": {
      "score": {
        "type": "integer"
      },
      "summaryKo": {
        "type": "string"
      },
      "strengths": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "fixes": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "said",
            "better",
            "whyKo"
          ],
          "properties": {
            "said": {
              "type": "string"
            },
            "better": {
              "type": "string"
            },
            "whyKo": {
              "type": "string"
            }
          }
        }
      },
      "missingKo": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "improvedAnswer": {
        "type": "string"
      },
      "tryExpressions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  }
};

/** 파트 → JSON Schema */
export const TOEIC_MOCK_JSON_SCHEMAS: Record<ToeicMockPart, StrictJsonSchema> = {
  read: TOEIC_MOCK_READ_JSON_SCHEMA,
  picture: TOEIC_MOCK_PICTURE_JSON_SCHEMA,
  respond: TOEIC_MOCK_RESPOND_JSON_SCHEMA,
  info: TOEIC_MOCK_INFO_JSON_SCHEMA,
  opinion: TOEIC_MOCK_OPINION_JSON_SCHEMA,
};

// ---------------------------------------------------------------------------
// zod 공통 판정 — 메시지에 값을 넣지 않는다(교재 원문이 로그·재요청에 새지 않게, 경로가 위치를 알려 준다)
// ---------------------------------------------------------------------------

type Path = (string | number)[];
interface IssueSink {
  addIssue: (issue: { code: "custom"; path: Path; message: string }) => void;
}

/**
 * issue 하나를 더한다. **path는 늘 사본으로 넘긴다** — zod v4는 부모 스키마(배열 원소·객체 키)를 거슬러 올라갈 때 issue.path 배열을
 * 제자리에서 고쳐(앞에 붙여) 쓴다. 같은 배열을 두 issue에 넘기면 접두어가 두 번 붙어 경로가 깨진다(`guides.0.0.…` — 2026-09-27 발견,
 * 한 칸에 규칙 둘이 걸리는 모든 호출 A~D·가져오기 zod에 해당). 사본이면 issue마다 경로가 따로다.
 */
function issue(ctx: IssueSink, path: Path, message: string): void {
  ctx.addIssue({ code: "custom", path: [...path], message });
}

function checkChars(ctx: IssueSink, path: Path, s: string, min: number, max: number, label: string): void {
  const n = s.trim().length;
  if (n < min || n > max) issue(ctx, path, `${label}는 ${min}~${max}자여야 합니다`);
}

function checkWords(ctx: IssueSink, path: Path, s: string, band: readonly [number, number], label: string): void {
  const n = countWords(s);
  if (n < band[0] || n > band[1]) issue(ctx, path, `${label}는 ${band[0]}~${band[1]}단어여야 합니다 (지금 ${n}단어)`);
}

function checkCount(ctx: IssueSink, path: Path, arr: readonly unknown[], min: number, max: number, label: string): void {
  if (arr.length < min || arr.length > max) {
    issue(ctx, path, min === max ? `${label}는 정확히 ${min}개여야 합니다` : `${label}는 ${min}~${max}개여야 합니다`);
  }
}

/** 영어 필드 — 라틴 포함 + 한글 금지 */
function checkEnglish(ctx: IssueSink, path: Path, s: string, label: string): void {
  if (s.trim() === "") issue(ctx, path, `${label}가 비었습니다`);
  else if (!hasLatin(s)) issue(ctx, path, `${label}에는 영어(라틴 문자)가 있어야 합니다`);
  if (hasHangul(s)) issue(ctx, path, `${label}에 한글을 쓸 수 없습니다`);
}

/** 영어 쪽 칸이지만 숫자·기호만일 수 있는 값(표의 시간·가격 칸 등) — 한글 금지만 */
function checkNoHangul(ctx: IssueSink, path: Path, s: string, label: string): void {
  if (s.trim() === "") issue(ctx, path, `${label}가 비었습니다`);
  if (hasHangul(s)) issue(ctx, path, `${label}에 한글을 쓸 수 없습니다`);
}

/** 한국어 필드 — 한글 포함 */
function checkKorean(ctx: IssueSink, path: Path, s: string, label: string): void {
  if (!hasHangul(s)) issue(ctx, path, `${label}에는 한글이 있어야 합니다`);
}

function checkNo(ctx: IssueSink, path: Path, no: number | null, label: string): void {
  if (no !== null && (no < TOEIC_NO_MIN || no > TOEIC_NO_MAX)) {
    issue(ctx, path, `${label}는 ${TOEIC_NO_MIN}~${TOEIC_NO_MAX} 정수여야 합니다`);
  }
}

// ---------------------------------------------------------------------------
// 호출 A zod (§2-4)
// ---------------------------------------------------------------------------

const extractEntryShape = z.object({
  no: z.number().int().nullable(),
  expression: z.string(),
  meaningKo: z.string(),
  example: z.string().nullable(),
  exampleKo: z.string().nullable(),
  partial: z.boolean(),
  confidence: z.enum(TOEIC_CONFIDENCES),
});

const bookQuizShape = z.object({
  no: z.number().int().nullable(),
  promptKo: z.string(),
  hint: z.string().nullable(),
  modelAnswer: z.string(),
  keyExpressions: z.array(z.string()),
});

type EntryText = Pick<ToeicExtractEntry, "no" | "expression" | "meaningKo" | "example" | "exampleKo">;

/**
 * 표현 항목 원문 규칙(§2-4) — 호출 A와 가져오기 파일(§7-6)이 같이 쓴다.
 *
 * `allowBlankMeaning`(QA P2-2): **판독**에서 사진 가장자리에서 잘린(`partial=true`) 항목은 뜻이 사진 밖일 수 있다 — 프롬프트는
 * "보이는 부분만"이라 하는데 zod가 1자 이상을 강제하면 재요청이 모델에게 사진에 없는 뜻을 지어내라고 떠민다(창작 0 원칙과 충돌).
 * 그래서 판독 zod만 partial 항목의 **빈** meaningKo를 받는다(검토 화면에서 사람이 채운다). 비어 있지 않으면 규칙은 그대로다.
 * 가져오기(저장과 같은 자리)는 false — 저장되는 세트의 뜻은 언제나 비지 않는다(저장 라우트 zod도 1자 이상).
 */
function checkEntryText(ctx: IssueSink, path: Path, e: EntryText, opts: { allowBlankMeaning: boolean }): void {
  checkNo(ctx, [...path, "no"], e.no, "no");
  checkChars(ctx, [...path, "expression"], e.expression, 1, TOEIC_EXPRESSION_MAX, "expression");
  checkEnglish(ctx, [...path, "expression"], e.expression, "expression");
  if (!(opts.allowBlankMeaning && e.meaningKo.trim() === "")) {
    checkChars(ctx, [...path, "meaningKo"], e.meaningKo, 1, TOEIC_MEANING_KO_MAX, "meaningKo");
    checkKorean(ctx, [...path, "meaningKo"], e.meaningKo, "meaningKo");
  }
  if (e.example !== null) {
    checkChars(ctx, [...path, "example"], e.example, TOEIC_EXAMPLE_MIN, TOEIC_EXAMPLE_MAX, "example");
    checkEnglish(ctx, [...path, "example"], e.example, "example");
    if (e.exampleKo !== null) checkKorean(ctx, [...path, "exampleKo"], e.exampleKo, "exampleKo");
  } else if (e.exampleKo !== null) {
    issue(ctx, [...path, "exampleKo"], "example이 null이면 exampleKo도 null이어야 합니다");
  }
}

/** 같은 묶음 안 번호 중복 금지(null은 중복으로 보지 않는다) */
function checkUniqueNos(ctx: IssueSink, path: Path, items: readonly { no: number | null }[], label: string): void {
  const seen = new Set<number>();
  items.forEach((it, i) => {
    if (it.no === null) return;
    if (seen.has(it.no)) issue(ctx, [...path, i, "no"], `${label} 번호(no) 중복 금지`);
    seen.add(it.no);
  });
}

/** QUIZ 원문 규칙(§2-4) — 호출 A와 가져오기 파일(표현집 §7-6·공략 speak §12-2-3)이 같이 쓴다 */
function checkQuizText(ctx: IssueSink, path: Path, q: Pick<ToeicBookQuiz, "no" | "promptKo" | "hint" | "modelAnswer">): void {
  checkNo(ctx, [...path, "no"], q.no, "quiz.no");
  if (q.promptKo.trim() === "") issue(ctx, [...path, "promptKo"], "promptKo가 비었습니다");
  checkKorean(ctx, [...path, "promptKo"], q.promptKo, "promptKo");
  checkEnglish(ctx, [...path, "modelAnswer"], q.modelAnswer, "modelAnswer");
  if (q.hint !== null) checkChars(ctx, [...path, "hint"], q.hint, 1, TOEIC_HINT_MAX, "hint");
}

/** 호출 A zod(§2-4) — 사진 1장 판독 */
export const toeicExprExtractionSchema: z.ZodType<ToeicExprExtraction> = z
  .object({
    isExpressionPage: z.boolean(),
    dayNo: z.number().int().nullable(),
    topicKo: z.string().nullable(),
    entries: z.array(extractEntryShape),
    quiz: z.array(bookQuizShape),
  })
  .superRefine((d, ctx) => {
    if (!d.isExpressionPage && (d.entries.length > 0 || d.quiz.length > 0)) {
      issue(ctx, ["isExpressionPage"], "isExpressionPage=false면 entries와 quiz가 비어야 합니다");
    }
    checkNo(ctx, ["dayNo"], d.dayNo, "dayNo");
    checkCount(ctx, ["entries"], d.entries, 0, TOEIC_EXTRACT_ENTRIES_MAX, "entries");
    checkCount(ctx, ["quiz"], d.quiz, 0, TOEIC_EXTRACT_QUIZ_MAX, "quiz");
    // 잘린(partial) 항목만 빈 뜻 허용(P2-2). 표현 중복은 거부하지 않는다 — 사진에 있는 그대로 옮기고, 검토 화면이
    // findDuplicateExpressionIndexes로 표시하고 저장 zod가 거부한다(§2-4·§7-1).
    d.entries.forEach((e, i) => checkEntryText(ctx, ["entries", i], e, { allowBlankMeaning: e.partial }));
    checkUniqueNos(ctx, ["entries"], d.entries, "entries");
    d.quiz.forEach((q, i) => checkQuizText(ctx, ["quiz", i], q));
  });

// ---------------------------------------------------------------------------
// 호출 B zod (§3-4) — 입력 묶음을 알고 만든다
// ---------------------------------------------------------------------------

const enKoShape = z.object({ en: z.string(), ko: z.string() });

const pointsShape = z.object({
  exampleSpan: z.string().nullable(),
  coreKo: z.string(),
  useIn: z.array(z.object({ part: z.enum(TOEIC_PARTS), sentence: z.string(), sentenceKo: z.string() })),
  frames: z.array(z.string()),
  variations: z.array(enKoShape),
  pronunciationKo: z.string(),
  pitfallKo: z.string().nullable(),
  grammarKo: z.string().nullable(),
  followUp: enKoShape,
});

/**
 * 발화 포인트 규칙(§3-4) — 호출 B와 가져오기 파일(§7-6)이 같이 쓴다. `example`은 그 표현의 교재 예문(입력).
 */
function checkPoints(ctx: IssueSink, path: Path, p: ToeicSpeakingPoints, example: string | null): void {
  const L = TOEIC_POINTS_LIMITS;
  // exampleSpan ⊂ example(대소문자 구분). 예문이 없으면 null
  if (example === null) {
    if (p.exampleSpan !== null) issue(ctx, [...path, "exampleSpan"], "예문이 null이면 exampleSpan도 null이어야 합니다");
  } else if (p.exampleSpan === null || p.exampleSpan.trim() === "") {
    issue(ctx, [...path, "exampleSpan"], "예문이 있으면 exampleSpan은 예문 속 구간이어야 합니다(null·빈 문자열 거부)");
  } else if (!example.includes(p.exampleSpan)) {
    issue(ctx, [...path, "exampleSpan"], "exampleSpan은 교재 예문(example)의 부분 문자열이어야 합니다(대소문자까지 그대로 복사)");
  }
  checkChars(ctx, [...path, "coreKo"], p.coreKo, L.coreKo[0], L.coreKo[1], "coreKo");
  checkKorean(ctx, [...path, "coreKo"], p.coreKo, "coreKo");

  checkCount(ctx, [...path, "useIn"], p.useIn, L.useIn[0], L.useIn[1], "useIn");
  const parts = new Set<string>();
  const exampleKey = example === null ? null : matchKey(example);
  p.useIn.forEach((u, i) => {
    const up = [...path, "useIn", i];
    if (parts.has(u.part)) issue(ctx, [...up, "part"], "useIn의 part는 서로 달라야 합니다");
    parts.add(u.part);
    checkWords(ctx, [...up, "sentence"], u.sentence, L.useSentenceWords, "useIn.sentence");
    if (u.sentence.trim().length > L.useSentenceMaxChars) {
      issue(ctx, [...up, "sentence"], `useIn.sentence는 ${L.useSentenceMaxChars}자 이내여야 합니다`);
    }
    checkEnglish(ctx, [...up, "sentence"], u.sentence, "useIn.sentence");
    if (exampleKey !== null && matchKey(u.sentence) === exampleKey) {
      issue(ctx, [...up, "sentence"], "useIn.sentence가 교재 예문과 같습니다(베끼지 말고 새 문장으로)");
    }
    checkChars(ctx, [...up, "sentenceKo"], u.sentenceKo, 1, L.useSentenceKoMaxChars, "useIn.sentenceKo");
    checkKorean(ctx, [...up, "sentenceKo"], u.sentenceKo, "useIn.sentenceKo");
  });

  checkCount(ctx, [...path, "frames"], p.frames, L.frames[0], L.frames[1], "frames");
  p.frames.forEach((f, i) => {
    checkChars(ctx, [...path, "frames", i], f, L.frameChars[0], L.frameChars[1], "frame");
    if (!f.includes(TOEIC_FRAME_SLOT)) issue(ctx, [...path, "frames", i], `frame에는 빈자리 "${TOEIC_FRAME_SLOT}"가 있어야 합니다`);
  });

  checkCount(ctx, [...path, "variations"], p.variations, L.variations[0], L.variations[1], "variations");
  p.variations.forEach((v, i) => {
    const vp = [...path, "variations", i];
    checkChars(ctx, [...vp, "en"], v.en, L.variationEnChars[0], L.variationEnChars[1], "variations.en");
    if (hasHangul(v.en)) issue(ctx, [...vp, "en"], "variations.en에 한글을 쓸 수 없습니다");
    checkChars(ctx, [...vp, "ko"], v.ko, L.variationKoChars[0], L.variationKoChars[1], "variations.ko");
    checkKorean(ctx, [...vp, "ko"], v.ko, "variations.ko");
  });

  checkChars(ctx, [...path, "pronunciationKo"], p.pronunciationKo, L.pronunciationKo[0], L.pronunciationKo[1], "pronunciationKo");
  if (p.pitfallKo !== null) checkChars(ctx, [...path, "pitfallKo"], p.pitfallKo, L.noteKo[0], L.noteKo[1], "pitfallKo");
  if (p.grammarKo !== null) checkChars(ctx, [...path, "grammarKo"], p.grammarKo, L.noteKo[0], L.noteKo[1], "grammarKo");

  checkChars(ctx, [...path, "followUp", "en"], p.followUp.en, L.followUpEnChars[0], L.followUpEnChars[1], "followUp.en");
  if (hasHangul(p.followUp.en)) issue(ctx, [...path, "followUp", "en"], "followUp.en에 한글을 쓸 수 없습니다");
  checkChars(ctx, [...path, "followUp", "ko"], p.followUp.ko, L.followUpKoChars[0], L.followUpKoChars[1], "followUp.ko");
  checkKorean(ctx, [...path, "followUp", "ko"], p.followUp.ko, "followUp.ko");
}

/**
 * 호출 B zod(§3-4) — `inputs`(이 묶음에 넘긴 표현들)를 알고 만든다.
 * items의 index 집합 = 입력 index 집합(누락·중복·모르는 index 거부 → callWithSchema 재요청 1회).
 */
export function buildPointsZod(inputs: readonly ToeicPointsInput[]): z.ZodType<ToeicPointsGeneration> {
  const byIndex = new Map(inputs.map((inp) => [inp.index, inp] as const));
  return z
    .object({ items: z.array(pointsShape.extend({ index: z.number().int() })) })
    .superRefine((d, ctx) => {
      const seen = new Set<number>();
      d.items.forEach((it, i) => {
        const inp = byIndex.get(it.index);
        if (!inp) {
          issue(ctx, ["items", i, "index"], "받지 않은 index입니다 — 입력 index만 쓰세요");
          return;
        }
        if (seen.has(it.index)) {
          issue(ctx, ["items", i, "index"], "같은 index가 두 번 나왔습니다 — 표현마다 정확히 하나");
          return;
        }
        seen.add(it.index);
        checkPoints(ctx, ["items", i], it, inp.example);
      });
      const missing = inputs.filter((inp) => !seen.has(inp.index)).map((inp) => inp.index);
      if (missing.length > 0) issue(ctx, ["items"], `빠진 index가 있습니다: ${missing.join(", ")}`);
    });
}

// ---------------------------------------------------------------------------
// 호출 C zod (§4-9) — 파트별 5개. 폭은 TOEIC_MOCK_ZOD_BANDS
// usedExpressions는 모양만 본다 — 목록·모범답변 대조는 후처리가 어긋난 항목을 버린다(거부 아님)
// ---------------------------------------------------------------------------

const usedExprShape = z.object({ expression: z.string(), span: z.string() });
const mockQuestionShape = z.object({
  question: z.string(),
  sampleAnswer: z.string(),
  tipKo: z.string(),
  usedExpressions: z.array(usedExprShape),
});

const B = TOEIC_MOCK_ZOD_BANDS;

/** stressWord가 지문에 단어 경계로 있는가(대소문자 무시 — 폭을 넓게) */
function hasWordAt(text: string, word: string): boolean {
  const w = word.trim();
  if (w === "") return false;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
}

export const toeicMockReadSchema: z.ZodType<ToeicReadPart> = z
  .object({
    items: z.array(
      z.object({
        kind: z.enum(TOEIC_READ_KINDS),
        text: z.string(),
        chunks: z.array(z.string()),
        stressWords: z.array(z.string()),
        tipsKo: z.array(z.string()),
      }),
    ),
  })
  .superRefine((d, ctx) => {
    checkCount(ctx, ["items"], d.items, B.readItems, B.readItems, "items");
    if (d.items.length === 2 && d.items[0].kind === d.items[1].kind) {
      issue(ctx, ["items", 1, "kind"], "두 지문의 kind는 서로 달라야 합니다");
    }
    d.items.forEach((it, i) => {
      const p = ["items", i];
      checkEnglish(ctx, [...p, "text"], it.text, "text");
      checkWords(ctx, [...p, "text"], it.text, B.readTextWords, "text");
      if (collapseSpaces(it.chunks.join(" ")) !== collapseSpaces(it.text)) {
        issue(ctx, [...p, "chunks"], "chunks를 공백 하나로 이어 붙이면 text와 정확히 같아야 합니다");
      }
      it.chunks.forEach((c, j) => checkNoHangul(ctx, [...p, "chunks", j], c, "chunk"));
      checkCount(ctx, [...p, "stressWords"], it.stressWords, B.readStressWords[0], B.readStressWords[1], "stressWords");
      it.stressWords.forEach((w, j) => {
        if (!hasWordAt(it.text, w)) issue(ctx, [...p, "stressWords", j], "stressWord는 지문에 있는 형태 그대로(단어 경계)여야 합니다");
      });
      checkCount(ctx, [...p, "tipsKo"], it.tipsKo, B.readTips[0], B.readTips[1], "tipsKo");
      it.tipsKo.forEach((t, j) => checkKorean(ctx, [...p, "tipsKo", j], t, "tipsKo"));
    });
  });

export const toeicMockPictureSchema: z.ZodType<ToeicPictureGeneration> = z
  .object({
    items: z.array(
      z.object({
        place: z.string(),
        imagePrompt: z.string(),
        sceneKo: z.string(),
        sampleAnswer: z.string(),
        keyPointsKo: z.array(z.string()),
        usedExpressions: z.array(usedExprShape),
      }),
    ),
  })
  .superRefine((d, ctx) => {
    checkCount(ctx, ["items"], d.items, B.pictureItems, B.pictureItems, "items");
    if (d.items.length === 2 && matchKey(d.items[0].place) === matchKey(d.items[1].place)) {
      issue(ctx, ["items", 1, "place"], "두 장면의 place는 서로 달라야 합니다");
    }
    d.items.forEach((it, i) => {
      const p = ["items", i];
      checkChars(ctx, [...p, "place"], it.place, 1, TOEIC_PICTURE_PLACE_MAX, "place");
      checkEnglish(ctx, [...p, "imagePrompt"], it.imagePrompt, "imagePrompt");
      checkWords(ctx, [...p, "imagePrompt"], it.imagePrompt, B.pictureImagePromptWords, "imagePrompt");
      checkKorean(ctx, [...p, "sceneKo"], it.sceneKo, "sceneKo");
      checkEnglish(ctx, [...p, "sampleAnswer"], it.sampleAnswer, "sampleAnswer");
      checkWords(ctx, [...p, "sampleAnswer"], it.sampleAnswer, B.pictureSampleWords, "sampleAnswer");
      checkCount(ctx, [...p, "keyPointsKo"], it.keyPointsKo, B.pictureKeyPoints[0], B.pictureKeyPoints[1], "keyPointsKo");
      it.keyPointsKo.forEach((k, j) => checkKorean(ctx, [...p, "keyPointsKo", j], k, "keyPointsKo"));
    });
  });

type MockQuestionLike = z.output<typeof mockQuestionShape>;

function checkMockQuestions(
  ctx: IssueSink,
  questions: readonly MockQuestionLike[],
  count: number,
  shortBand: readonly [number, number],
  longBand: readonly [number, number],
  requireQuestionMark: boolean,
): void {
  checkCount(ctx, ["questions"], questions, count, count, "questions");
  questions.forEach((q, i) => {
    const p = ["questions", i];
    checkEnglish(ctx, [...p, "question"], q.question, "question");
    if (requireQuestionMark && !q.question.trim().endsWith("?")) issue(ctx, [...p, "question"], "question은 ?로 끝나야 합니다");
    checkEnglish(ctx, [...p, "sampleAnswer"], q.sampleAnswer, "sampleAnswer");
    checkWords(ctx, [...p, "sampleAnswer"], q.sampleAnswer, i === count - 1 ? longBand : shortBand, "sampleAnswer");
    checkKorean(ctx, [...p, "tipKo"], q.tipKo, "tipKo");
  });
}

export const toeicMockRespondSchema: z.ZodType<ToeicRespondPart> = z
  .object({ topicKo: z.string(), intro: z.string(), questions: z.array(mockQuestionShape) })
  .superRefine((d, ctx) => {
    checkKorean(ctx, ["topicKo"], d.topicKo, "topicKo");
    checkEnglish(ctx, ["intro"], d.intro, "intro");
    checkMockQuestions(ctx, d.questions, B.respondQuestions, B.respondShortWords, B.respondLongWords, true);
  });

export const toeicMockInfoSchema: z.ZodType<ToeicInfoPart> = z
  .object({
    table: z.object({
      kind: z.enum(TOEIC_INFO_KINDS),
      title: z.string(),
      meta: z.array(z.string()),
      rows: z.array(z.object({ left: z.string(), right: z.string() })),
      notes: z.array(z.string()),
    }),
    callerIntro: z.string(),
    questions: z.array(mockQuestionShape),
  })
  .superRefine((d, ctx) => {
    const t = d.table;
    checkEnglish(ctx, ["table", "title"], t.title, "table.title");
    checkCount(ctx, ["table", "meta"], t.meta, B.infoMeta[0], B.infoMeta[1], "table.meta");
    t.meta.forEach((m, i) => checkNoHangul(ctx, ["table", "meta", i], m, "table.meta"));
    checkCount(ctx, ["table", "rows"], t.rows, B.infoRows[0], B.infoRows[1], "table.rows");
    t.rows.forEach((r, i) => {
      checkNoHangul(ctx, ["table", "rows", i, "left"], r.left, "rows.left");
      checkNoHangul(ctx, ["table", "rows", i, "right"], r.right, "rows.right");
    });
    checkCount(ctx, ["table", "notes"], t.notes, B.infoNotes[0], B.infoNotes[1], "table.notes");
    t.notes.forEach((n, i) => checkNoHangul(ctx, ["table", "notes", i], n, "table.notes"));
    checkEnglish(ctx, ["callerIntro"], d.callerIntro, "callerIntro");
    checkMockQuestions(ctx, d.questions, B.infoQuestions, B.infoShortWords, B.infoLongWords, false);
  });

export const toeicMockOpinionSchema: z.ZodType<ToeicOpinionPart> = z
  .object({
    kind: z.enum(TOEIC_OPINION_KINDS),
    question: z.string(),
    sampleAnswer: z.string(),
    outlineKo: z.array(z.string()),
    tipKo: z.string(),
    usedExpressions: z.array(usedExprShape),
  })
  .superRefine((d, ctx) => {
    checkEnglish(ctx, ["question"], d.question, "question");
    checkEnglish(ctx, ["sampleAnswer"], d.sampleAnswer, "sampleAnswer");
    checkWords(ctx, ["sampleAnswer"], d.sampleAnswer, B.opinionWords, "sampleAnswer");
    checkCount(ctx, ["outlineKo"], d.outlineKo, B.opinionOutline[0], B.opinionOutline[1], "outlineKo");
    d.outlineKo.forEach((o, i) => checkKorean(ctx, ["outlineKo", i], o, "outlineKo"));
    checkKorean(ctx, ["tipKo"], d.tipKo, "tipKo");
  });

/** 파트 → zod */
export const TOEIC_MOCK_ZOD: { [P in ToeicMockPart]: z.ZodType<ToeicMockPartGenMap[P]> } = {
  read: toeicMockReadSchema,
  picture: toeicMockPictureSchema,
  respond: toeicMockRespondSchema,
  info: toeicMockInfoSchema,
  opinion: toeicMockOpinionSchema,
};

// ---------------------------------------------------------------------------
// 호출 D zod (§5-3) — 만점·전사문을 알고 만든다
// ---------------------------------------------------------------------------

/**
 * `said`가 전사문에 있는 구간인지(§5-3) — 대소문자·연속 공백·**문장부호** 무시, 단어 경계, **단어 순서는 그대로**
 * (lib/toeic-text `containsWordSequence`). 전사 모델은 문장부호를 붙여 내고 LLM은 인용하며 쉼표를 자주 떨어뜨려서, 문장부호까지
 * 맞추게 하면 멀쩡한 인용이 재요청을 태우고 끝내 그 문항 채점이 실패한다(QA P2-3). 하지 않은 말(전사문에 없는 단어·순서를
 * 바꾼 인용·사이 단어를 뺀 이어 붙이기)을 고쳤다는 것은 환각이라 여전히 **거부**한다.
 */
export function isSaidInTranscript(said: string, transcript: string): boolean {
  return containsWordSequence(transcript, said);
}

export function buildFeedbackZod(args: { maxScore: number; transcript: string }): z.ZodType<ToeicFeedback> {
  const F = TOEIC_FEEDBACK_LIMITS;
  return z
    .object({
      score: z.number().int(),
      summaryKo: z.string(),
      strengths: z.array(z.string()),
      fixes: z.array(z.object({ said: z.string(), better: z.string(), whyKo: z.string() })),
      missingKo: z.array(z.string()),
      improvedAnswer: z.string(),
      tryExpressions: z.array(z.string()),
    })
    .superRefine((d, ctx) => {
      if (d.score < 0 || d.score > args.maxScore) issue(ctx, ["score"], `score는 0~${args.maxScore} 정수여야 합니다`);
      checkKorean(ctx, ["summaryKo"], d.summaryKo, "summaryKo");
      checkCount(ctx, ["strengths"], d.strengths, F.strengths[0], F.strengths[1], "strengths");
      d.strengths.forEach((s, i) => {
        if (s.trim() === "") issue(ctx, ["strengths", i], "strengths 항목이 비었습니다");
      });
      checkCount(ctx, ["fixes"], d.fixes, F.fixes[0], F.fixes[1], "fixes");
      d.fixes.forEach((f, i) => {
        if (!isSaidInTranscript(f.said, args.transcript)) {
          issue(ctx, ["fixes", i, "said"], "said는 답변 전사문에서 그대로 복사한 구간이어야 합니다(전사문에 없는 말을 고치지 마세요)");
        }
        if (f.better.trim() === "") issue(ctx, ["fixes", i, "better"], "better가 비었습니다");
        if (f.whyKo.trim() === "") issue(ctx, ["fixes", i, "whyKo"], "whyKo가 비었습니다");
      });
      checkCount(ctx, ["missingKo"], d.missingKo, F.missingKo[0], F.missingKo[1], "missingKo");
      checkEnglish(ctx, ["improvedAnswer"], d.improvedAnswer, "improvedAnswer");
    });
}

// ---------------------------------------------------------------------------
// 가져오기 파일 zod (§7-6) — entries·points·quiz에 호출 A·B와 같은 규칙
// ---------------------------------------------------------------------------

const importSetSchema = z
  .object({
    presetKey: z.string(),
    titleKo: z.string(),
    dayNo: z.number().int().nullable(),
    topicKo: z.string().nullable(),
    entries: z.array(extractEntryShape.extend({ points: pointsShape.nullable() })),
    quiz: z.array(bookQuizShape),
  })
  .superRefine((s, ctx) => {
    if (s.presetKey.length > TOEIC_PRESET_KEY_MAX || !TOEIC_PRESET_KEY_RE.test(s.presetKey)) {
      issue(ctx, ["presetKey"], `presetKey는 소문자·숫자·하이픈 조각(최대 ${TOEIC_PRESET_KEY_MAX}자)이어야 합니다`);
    }
    checkChars(ctx, ["titleKo"], s.titleKo, 1, TOEIC_SET_TITLE_MAX, "titleKo");
    checkNo(ctx, ["dayNo"], s.dayNo, "dayNo");
    checkCount(ctx, ["entries"], s.entries, TOEIC_SET_ENTRIES_MIN, TOEIC_SET_ENTRIES_MAX, "entries");
    checkCount(ctx, ["quiz"], s.quiz, 0, TOEIC_SET_QUIZ_MAX, "quiz");
    s.entries.forEach((e, i) => {
      // 가져오기는 저장과 같은 자리 — partial이어도 뜻이 비면 거부(P2-2: 빈 뜻 허용은 판독 초안에만)
      checkEntryText(ctx, ["entries", i], e, { allowBlankMeaning: false });
      if (e.points !== null) checkPoints(ctx, ["entries", i, "points"], e.points, e.example);
    });
    checkUniqueNos(ctx, ["entries"], s.entries, "entries");
    // 세트 안 표현 중복 금지(대소문자·연속 공백 무시, §7-1·§7-6) — 항목 키 = 표현이라 둘이면 숙련도가 섞인다(QA m1 P2-3)
    for (const i of findDuplicateExpressionIndexes(s.entries)) issue(ctx, ["entries", i, "expression"], TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO);
    const expressions = new Set(s.entries.map((e) => e.expression));
    s.quiz.forEach((q, i) => {
      checkQuizText(ctx, ["quiz", i], q);
      q.keyExpressions.forEach((k, j) => {
        if (!expressions.has(k)) issue(ctx, ["quiz", i, "keyExpressions", j], "keyExpressions는 이 세트 entries[].expression과 글자 그대로 같아야 합니다");
      });
    });
    checkUniqueNos(ctx, ["quiz"], s.quiz, "quiz");
  });

/** 가져오기 파일 zod(§7-6). 모르는 최상위 키(예: 출처 메모)는 버린다. */
export const toeicImportFileSchema: z.ZodType<ToeicImportFile> = z
  .object({ format: z.literal(TOEIC_IMPORT_FORMAT), sets: z.array(importSetSchema) })
  .superRefine((f, ctx) => {
    checkCount(ctx, ["sets"], f.sets, 1, TOEIC_IMPORT_SETS_MAX, "sets");
    const seen = new Set<string>();
    f.sets.forEach((s, i) => {
      if (seen.has(s.presetKey)) issue(ctx, ["sets", i, "presetKey"], "presetKey 중복 금지");
      seen.add(s.presetKey);
    });
  });

// ===========================================================================
// 유형별 공략 — 가져오기 `toeic-guides/v2` (docs/harness/toeic.md §12-2) + 틀 은행 (§12-2-7)
// 기존 가져오기 zod(§7-6)와 **같은 모듈**에 둔다 — 표현·QUIZ 원문 판정(checkEntryText·checkQuizText·checkUniqueNos·
// findDuplicateExpressionIndexes)을 복사하지 않고 그대로 부르기 위해서다. 가져오기는 저장과 같은 자리라 판독보다 엄격하다 —
// 어긋나면 버리지 않고 거부한다. 모르는 키는 버린다(zod 기본). **메시지에 값을 넣지 않는다**(경로가 위치를 알려 준다).
// ===========================================================================

/** 가져오기 파일 형식(§12-2) — v2만 받는다(초안 v1·표현집 형식은 400) */
export const TOEIC_GUIDE_FORMAT = "toeic-guides/v2";
/** 배포 전 초안 형식 — 받지 않는다. 오류 문구를 가르는 데만 쓴다 */
export const TOEIC_GUIDE_FORMAT_V1 = "toeic-guides/v1";

/** 한 파일의 유형 항목 수 상한(유형 넷) */
export const TOEIC_GUIDE_FILE_GUIDES_MAX = TOEIC_GUIDE_PARTS.length;
/** titleKo·textKo·captionKo 1~80자 */
export const TOEIC_GUIDE_TITLE_MAX = 80;
/** 섹션 groupKo 1~30자 */
export const TOEIC_GUIDE_GROUP_MAX = 30;
/** introKo 1~600자 */
export const TOEIC_GUIDE_INTRO_MAX = 600;
/** text 블록 bodyKo 1~1200자 */
export const TOEIC_GUIDE_BODY_MAX = 1200;
/** 줄·예문 ko 1~300자 — 말하기 promptKo·modelAnswer도 같은 상수 */
export const TOEIC_GUIDE_LINE_KO_MAX = 300;
/** label 1~30자 */
export const TOEIC_GUIDE_LABEL_MAX = 30;
/** note 1~120자 */
export const TOEIC_GUIDE_NOTE_MAX = 120;
/** emphasis·underline 0~6개, 각 1~120자 */
export const TOEIC_GUIDE_MARKS_MAX = 6;
export const TOEIC_GUIDE_MARK_CHARS_MAX = 120;
/** 개수: sections 1~30, 섹션당 blocks 1~60, lines 블록의 lines 1~40(text 블록 0~40) */
export const TOEIC_GUIDE_SECTIONS_MAX = 30;
export const TOEIC_GUIDE_BLOCKS_MAX = 60;
export const TOEIC_GUIDE_LINES_MAX = 40;
/** 문서 하나(유형 항목 / 틀 은행)의 UTF-8 바이트 상한 — Firestore 문서 1MiB 기준(§12-2-3). 글자 수가 아니라 바이트로 잰다 */
export const TOEIC_GUIDE_MAX_BYTES = 900_000;
/** 말하기 문항 0~60(§7-1 quiz 상한 12의 예외) */
export const TOEIC_GUIDE_SPEAK_MAX = 60;
/** 400 본문 issues 상한(§12-2-3) */
export const TOEIC_GUIDE_IMPORT_ISSUES_MAX = 20;

export const TOEIC_GUIDE_LINE_STYLES = ["list", "template", "completions"] as const;
export type ToeicGuideLineStyle = (typeof TOEIC_GUIDE_LINE_STYLES)[number];

/** 틀 은행 상한(§12-2-7) — 한 번만 정의 */
export const TOEIC_TEMPLATES_MAX = 300;
export const TOEIC_TEMPLATE_GROUP_KO_MAX = 30;
export const TOEIC_TEMPLATE_USE_KO_MAX = 120;
export const TOEIC_TEMPLATE_FRAME_MAX = 120;
export const TOEIC_TEMPLATE_SLOTS_MIN = 1;
export const TOEIC_TEMPLATE_SLOTS_MAX = 4;
export const TOEIC_TEMPLATE_FILL_MAX = 80;
export const TOEIC_TEMPLATE_EXAMPLE_KO_MAX = 200;
export const TOEIC_TEMPLATE_EXAMPLES_MIN = 3;
export const TOEIC_TEMPLATE_EXAMPLES_MAX = 5;
export const TOEIC_TEMPLATE_TEST_FILLS_MIN = 1;
export const TOEIC_TEMPLATE_TEST_FILLS_MAX = 3;
export const TOEIC_TEMPLATE_GUIDE_REFS_MAX = 4;
export const TOEIC_TEMPLATE_FLOW_STEPS_MIN = 3;
export const TOEIC_TEMPLATE_FLOW_STEPS_MAX = 6;
export const TOEIC_TEMPLATE_STEP_GROUPS_MAX = 8;
export const TOEIC_TEMPLATE_BANKS_MAX = 16;
export const TOEIC_TEMPLATE_FLOW_NAME_MAX = 30;
/** 유형 폴더마다 묶음 하나의 틀 수 상한(따라 말하기 한 묶음이 약 20분을 넘지 않게) */
export const TOEIC_TEMPLATE_GROUP_MAX = 6;
export const TOEIC_TEMPLATE_SKIPS_MAX = 100;
export const TOEIC_TEMPLATE_SKIP_REASON_MAX = 80;
export const TOEIC_TEMPLATE_SOURCES = ["guide", "new"] as const;
export const TOEIC_TEMPLATE_REF_KINDS = ["expression", "template", "lead"] as const;
export type ToeicTemplateRefKind = (typeof TOEIC_TEMPLATE_REF_KINDS)[number];

// ---------------------------------------------------------------------------
// 타입 (§12-2-2·§12-2-7·§12-3)
// ---------------------------------------------------------------------------

export interface ToeicGuideExample {
  en: string;
  ko: string | null;
  emphasis: string[];
}

export interface ToeicGuideLine {
  /** 작은 머리표 — 화면 표시만, 읽지 않는다 */
  label: string | null;
  /** 영어. 자리 표시는 {자리 이름}(한글은 이 괄호 안에서만), 대안은 슬래시, 생략 가능 단어는 띄어 쓴 괄호 */
  en: string | null;
  ko: string | null;
  /** 비고 — 화면 표시만, 읽지 않는다 */
  note: string | null;
  /** en 안의 강조 구간(부분 문자열 그대로) — 형광 */
  emphasis: string[];
  /** en 안의 밑줄 구간(질문에서 답에 되살려 쓸 말) — 화면 표시만 */
  underline: string[];
  /** template 블록에서 "바로 위 줄 대신 이것도" */
  alt: boolean;
  /** 종이 교재에 손으로 표시한 줄 */
  marked: boolean;
  example: ToeicGuideExample | null;
}

export type ToeicGuideBlock =
  | { kind: "heading"; textKo: string }
  | { kind: "text"; label: string | null; titleKo: string | null; bodyKo: string | null; lines: ToeicGuideLine[] }
  | { kind: "lines"; style: ToeicGuideLineStyle; captionKo: string | null; lead: ToeicGuideLine | null; lines: ToeicGuideLine[] };

export interface ToeicGuideSection {
  label: string | null;
  titleKo: string;
  introKo: string | null;
  /** 목차 칩 무리 이름(원본의 파트 띠) — 화면 표시만 */
  groupKo: string | null;
  blocks: ToeicGuideBlock[];
}

/** 공략 표현(→ 세트 entries, points null) */
export interface ToeicGuideExpression {
  no: number | null;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
}

/** 공략 말하기 문항(→ 세트 quiz, keyExpressions []) — no는 null 금지(항목 키 quiz:{no}) */
export interface ToeicGuideSpeak {
  no: number;
  promptKo: string;
  hint: string | null;
  modelAnswer: string;
}

/** 가져오기 파일의 유형 항목 하나 → ToeicSetRecord 하나(§12-3) */
export interface ToeicGuideFileEntry {
  presetKey: string;
  part: ToeicGuidePart;
  introKo: string | null;
  sections: ToeicGuideSection[];
  expressions: ToeicGuideExpression[];
  speak: ToeicGuideSpeak[];
}

export interface ToeicTemplateFlowStep {
  stepKo: string;
  groupsKo: string[];
}

/** 유형마다 하나 — 단계(답변 흐름, 3~6) + 소재 묶음(흐름 밖) */
export interface ToeicTemplateFlow {
  part: ToeicGuidePart;
  steps: ToeicTemplateFlowStep[];
  banksKo: string[];
}

export interface ToeicTemplateExample {
  /** = fillFrame(frameEn, fills) — 글자까지 같다 */
  en: string;
  ko: string;
  fills: string[];
}

export type ToeicTemplateGuideRef =
  | { kind: "expression"; part: ToeicGuidePart; expression: string }
  | { kind: "template"; part: ToeicGuidePart; step: string }
  | { kind: "lead"; part: ToeicGuidePart; leadEn: string };

export interface ToeicTemplate {
  /** 숙련도 키 tpl:{key}. 교정할 때 바꾸지 않는다 */
  key: string;
  groupKo: string;
  /** 고정 부분 + {자리 이름} */
  frameEn: string;
  /** 같은 자리 이름을 한국어 어순대로 */
  frameKo: string;
  useKo: string;
  parts: ToeicGuidePart[];
  source: (typeof TOEIC_TEMPLATE_SOURCES)[number];
  guideRefs: ToeicTemplateGuideRef[];
  examples: ToeicTemplateExample[];
  /** 틀 바꿔 말하기 전용 채움(자리 순서) — 대본·카드에 나오지 않는다 */
  testFills: string[][];
}

export interface ToeicTemplateAlignmentSkip {
  part: ToeicGuidePart;
  kind: ToeicTemplateRefKind;
  ref: string;
  reasonKo: string;
  coveredBy: string | null;
}

/** 가져오기 파일 최상위 templates → 틀 은행 문서 하나(id guide-templates) */
export interface ToeicTemplateBankFile {
  presetKey: string;
  flows: ToeicTemplateFlow[];
  items: ToeicTemplate[];
  /** 가져오기 검사용 — 문서에 저장하지 않고 내용 지문에도 넣지 않는다(§12-2-5) */
  alignmentSkips: ToeicTemplateAlignmentSkip[];
}

export interface ToeicGuideFile {
  format: typeof TOEIC_GUIDE_FORMAT;
  /** 0~4 — templates가 null이면 1~4 */
  guides: ToeicGuideFileEntry[];
  /** null이면 저장된 틀 은행을 건드리지 않는다 */
  templates: ToeicTemplateBankFile | null;
}

/** ToeicSetRecord.guide — 유형 공략(§12-3) */
export interface ToeicGuidePartDoc {
  kind: "part";
  part: ToeicGuidePart;
  introKo: string | null;
  sections: ToeicGuideSection[];
  contentHash: string;
  /** 내용이 마지막으로 바뀐 시각(생성 포함) */
  updatedAt: string;
}

/** ToeicSetRecord.guide — 틀 은행(§12-3). 정렬 건너뜀은 저장하지 않는다 */
export interface ToeicTemplateBankDoc {
  kind: "templates";
  flows: ToeicTemplateFlow[];
  items: ToeicTemplate[];
  contentHash: string;
  updatedAt: string;
}

/**
 * 공략 계열 문서 표시(§12-3) — null이면 표현집. 정규화(lib/toeic-normalize.ts)는 깨진 guide도 null로 떨어뜨리지 않고 옮긴다 —
 * 그래서 타입과 다른 값(모르는 kind·part, 배열이 아닌 sections·items)이 올 수 있고, 화면은 lib/toeic-record.ts 렌더 판정을 먼저 본다.
 */
export type ToeicGuideDoc = ToeicGuidePartDoc | ToeicTemplateBankDoc;

/** 멱등 판정의 "유형 자리" — 유형 넷 + 틀 은행 */
export type ToeicGuideSlot = ToeicGuidePart | typeof TOEIC_TEMPLATE_BANK_SLOT;

export type { ToeicTemplateQuizMode };

// ---------------------------------------------------------------------------
// 공략 zod 공통 판정
// ---------------------------------------------------------------------------

/** UTF-8 바이트 수 — 한글은 한 글자가 3바이트라 글자 수로 재면 세 배를 놓친다(자유대화 keepalive P2-A와 같은 함정) */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 유형 항목의 내용(지문·바이트 상한이 재는 것) — part·introKo·sections·expressions·speak(presetKey 제외, 이 키 순서) */
export function toeicGuideEntryContent(g: ToeicGuideFileEntry): Pick<ToeicGuideFileEntry, "part" | "introKo" | "sections" | "expressions" | "speak"> {
  return { part: g.part, introKo: g.introKo, sections: g.sections, expressions: g.expressions, speak: g.speak };
}

/** 틀 은행의 내용(지문·바이트 상한이 재는 것) — flows·items(alignmentSkips·presetKey 제외) */
export function toeicTemplateBankContent(b: Pick<ToeicTemplateBankFile, "flows" | "items">): Pick<ToeicTemplateBankFile, "flows" | "items"> {
  return { flows: b.flows, items: b.items };
}

const SLOT_PROBLEM_KO: Record<ToeicSlotProblem, string> = {
  unbalanced: "자리 { }의 짝이 맞지 않아요(자리 밖에는 { }를 쓸 수 없어요)",
  nested: "자리 { } 안에 다시 { }를 쓸 수 없어요",
  empty: "빈 자리 { }는 쓸 수 없어요",
  too_long: `자리 이름은 1~${TOEIC_GUIDE_SLOT_NAME_MAX}자예요`,
};

const GUIDE_EXPR_SYMBOL_KO = "공략 표현에는 { } / [ ]를 쓸 수 없어요 — 자리는 ~, 대안은 항목을 나눠요";
const TILDES = /[~～〜]/;

function hasBrace(s: string): boolean {
  return /[{}]/.test(s);
}

/** 한국어 칸 — 1~max자 + 한글 포함 */
function checkKoText(ctx: IssueSink, path: Path, s: string, max: number, label: string): void {
  checkChars(ctx, path, s, 1, max, label);
  checkKorean(ctx, path, s, label);
}
function checkOptKoText(ctx: IssueSink, path: Path, s: string | null, max: number, label: string): void {
  if (s !== null) checkKoText(ctx, path, s, max, label);
}
function checkOptChars(ctx: IssueSink, path: Path, s: string | null, max: number, label: string): void {
  if (s !== null) checkChars(ctx, path, s, 1, max, label);
}

/** 자리 문법 — 문제가 없으면 true */
function checkSlotSyntax(ctx: IssueSink, path: Path, s: string, label: string): boolean {
  const { problems } = scanSlots(s);
  for (const p of problems) issue(ctx, path, `${label}: ${SLOT_PROBLEM_KO[p]}`);
  return problems.length === 0;
}

/** 공략 영어 줄·예문(§12-2-3) — 1~300자·라틴 포함·한글은 자리 안에서만·자리 문법·대괄호 거부 */
function checkGuideEn(ctx: IssueSink, path: Path, s: string, label: string): void {
  checkChars(ctx, path, s, 1, TTS_TEXT_MAX_CHARS, label);
  if (!hasLatin(s)) issue(ctx, path, `${label}에는 영어(라틴 문자)가 있어야 합니다`);
  checkSlotSyntax(ctx, path, s, label);
  if (hasHangul(textOutsideSlots(s))) issue(ctx, path, `${label}: 한글은 자리 {…} 안에서만 쓸 수 있어요`);
  if (/[[\]]/.test(s)) issue(ctx, path, `${label}: 대괄호 [ ]는 쓸 수 없어요 — 영어 대안은 슬래시로 적어요`);
}

/** 강조·밑줄 — 0~6개, 1~120자, 그 영어의 부분 문자열(대소문자 그대로), 배열 안 중복 금지, { } 금지. 영어가 없으면 빈 배열 */
function checkMarks(ctx: IssueSink, path: Path, marks: readonly string[], en: string | null, label: string): void {
  if (en === null) {
    if (marks.length > 0) issue(ctx, path, `en이 없으면 ${label}도 비어야 합니다`);
    return;
  }
  checkCount(ctx, path, marks, 0, TOEIC_GUIDE_MARKS_MAX, label);
  const seen = new Set<string>();
  marks.forEach((m, i) => {
    if (m.length < 1 || m.length > TOEIC_GUIDE_MARK_CHARS_MAX) issue(ctx, [...path, i], `${label}는 1~${TOEIC_GUIDE_MARK_CHARS_MAX}자여야 합니다`);
    else if (!en.includes(m)) issue(ctx, [...path, i], `${label}는 그 영어의 부분 문자열(대소문자까지 그대로)이어야 합니다`);
    if (hasBrace(m)) issue(ctx, [...path, i], `${label}에 { }를 쓸 수 없어요`);
    if (seen.has(m)) issue(ctx, [...path, i], `같은 ${label} 중복 금지`);
    seen.add(m);
  });
}

function checkGuideLine(
  ctx: IssueSink,
  path: Path,
  ln: ToeicGuideLine,
  where: { style: ToeicGuideLineStyle | "text"; isLead: boolean; index: number },
): void {
  checkOptChars(ctx, [...path, "label"], ln.label, TOEIC_GUIDE_LABEL_MAX, "label");
  checkOptChars(ctx, [...path, "note"], ln.note, TOEIC_GUIDE_NOTE_MAX, "note");
  if (ln.en === null && ln.ko === null) issue(ctx, path, "줄에는 en과 ko 중 하나 이상이 있어야 합니다");
  if (ln.en !== null) checkGuideEn(ctx, [...path, "en"], ln.en, "en");
  if (ln.ko !== null) {
    checkKoText(ctx, [...path, "ko"], ln.ko, TOEIC_GUIDE_LINE_KO_MAX, "ko");
    if (hasBrace(ln.ko)) issue(ctx, [...path, "ko"], "줄 ko에는 { }를 쓸 수 없어요");
  }
  checkMarks(ctx, [...path, "emphasis"], ln.emphasis, ln.en, "emphasis");
  checkMarks(ctx, [...path, "underline"], ln.underline, ln.en, "underline");
  if (ln.alt && !(where.style === "template" && !where.isLead && where.index > 0)) {
    issue(ctx, [...path, "alt"], "alt는 template 블록의 첫 줄이 아닌 줄에서만 쓸 수 있어요");
  }
  if (ln.example !== null) {
    const ex = ln.example;
    checkGuideEn(ctx, [...path, "example", "en"], ex.en, "example.en");
    if (ex.ko !== null) {
      checkKoText(ctx, [...path, "example", "ko"], ex.ko, TOEIC_GUIDE_LINE_KO_MAX, "example.ko");
      if (hasBrace(ex.ko)) issue(ctx, [...path, "example", "ko"], "예문 ko에는 { }를 쓸 수 없어요");
    }
    checkMarks(ctx, [...path, "example", "emphasis"], ex.emphasis, ex.en, "example.emphasis");
  }
}

function checkGuideBlock(ctx: IssueSink, path: Path, b: ToeicGuideBlock): void {
  switch (b.kind) {
    case "heading":
      checkKoText(ctx, [...path, "textKo"], b.textKo, TOEIC_GUIDE_TITLE_MAX, "textKo");
      return;
    case "text":
      checkOptChars(ctx, [...path, "label"], b.label, TOEIC_GUIDE_LABEL_MAX, "label");
      checkOptKoText(ctx, [...path, "titleKo"], b.titleKo, TOEIC_GUIDE_TITLE_MAX, "titleKo");
      checkOptKoText(ctx, [...path, "bodyKo"], b.bodyKo, TOEIC_GUIDE_BODY_MAX, "bodyKo");
      checkCount(ctx, [...path, "lines"], b.lines, 0, TOEIC_GUIDE_LINES_MAX, "lines");
      if (b.titleKo === null && b.bodyKo === null && b.lines.length === 0) issue(ctx, path, "text 블록에는 titleKo·bodyKo·lines 중 하나 이상이 있어야 합니다");
      b.lines.forEach((ln, i) => checkGuideLine(ctx, [...path, "lines", i], ln, { style: "text", isLead: false, index: i }));
      return;
    case "lines": {
      checkOptKoText(ctx, [...path, "captionKo"], b.captionKo, TOEIC_GUIDE_TITLE_MAX, "captionKo");
      checkCount(ctx, [...path, "lines"], b.lines, 1, TOEIC_GUIDE_LINES_MAX, "lines");
      if (b.lead !== null) checkGuideLine(ctx, [...path, "lead"], b.lead, { style: b.style, isLead: true, index: -1 });
      b.lines.forEach((ln, i) => checkGuideLine(ctx, [...path, "lines", i], ln, { style: b.style, isLead: false, index: i }));
      if (b.style !== "completions") return;
      // 머리말 + 이어 말하기(§12-2-3) — 읽는 단위는 머리말 영어 + " " + 줄 영어(guideLineEn)
      if (b.lead === null) issue(ctx, [...path, "lead"], "completions 블록에는 머리말(lead)이 있어야 합니다");
      else {
        if (b.lead.en === null || b.lead.ko === null) issue(ctx, [...path, "lead"], "completions 머리말은 en과 ko가 모두 있어야 합니다");
        if (b.lead.en !== null && (hasBrace(b.lead.en) || TILDES.test(b.lead.en))) {
          issue(ctx, [...path, "lead", "en"], "completions 머리말 영어에는 { } ~를 쓸 수 없어요(문장 앞부분이지 틀이 아니에요)");
        }
      }
      b.lines.forEach((ln, i) => {
        const lp: Path = [...path, "lines", i];
        if (ln.en === null) issue(ctx, [...lp, "en"], "completions 줄에는 en이 있어야 합니다");
        if (ln.example !== null) issue(ctx, [...lp, "example"], "completions 줄에는 example을 쓸 수 없어요");
        const full = guideLineEn(b, ln);
        if (full !== null && full.trim().length > TTS_TEXT_MAX_CHARS) {
          issue(ctx, [...lp, "en"], `머리말과 이은 완성 문장은 ${TTS_TEXT_MAX_CHARS}자 이하여야 합니다`);
        }
      });
      return;
    }
  }
}

function checkPresetKey(ctx: IssueSink, path: Path, key: string): void {
  if (key.length > TOEIC_PRESET_KEY_MAX || !TOEIC_PRESET_KEY_RE.test(key)) {
    issue(ctx, path, `presetKey는 소문자·숫자·하이픈 조각(최대 ${TOEIC_PRESET_KEY_MAX}자)이어야 합니다`);
  }
}

// ---------------------------------------------------------------------------
// 공략 zod 모양
// ---------------------------------------------------------------------------

const guideExampleShape = z.object({ en: z.string(), ko: z.string().nullable(), emphasis: z.array(z.string()) });

const guideLineShape = z.object({
  label: z.string().nullable(),
  en: z.string().nullable(),
  ko: z.string().nullable(),
  note: z.string().nullable(),
  emphasis: z.array(z.string()),
  underline: z.array(z.string()),
  alt: z.boolean(),
  marked: z.boolean(),
  example: guideExampleShape.nullable(),
});

const guideBlockShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), textKo: z.string() }),
  z.object({
    kind: z.literal("text"),
    label: z.string().nullable(),
    titleKo: z.string().nullable(),
    bodyKo: z.string().nullable(),
    lines: z.array(guideLineShape),
  }),
  z.object({
    kind: z.literal("lines"),
    style: z.enum(TOEIC_GUIDE_LINE_STYLES),
    captionKo: z.string().nullable(),
    lead: guideLineShape.nullable(),
    lines: z.array(guideLineShape),
  }),
]);

const guideSectionShape = z.object({
  label: z.string().nullable(),
  titleKo: z.string(),
  introKo: z.string().nullable(),
  groupKo: z.string().nullable(),
  blocks: z.array(guideBlockShape),
});

const guidePartEnum = z.enum(TOEIC_GUIDE_PARTS, { error: "part는 q3_4·q5_7·q8_10·q11 중 하나예요(Q1–2는 공략 폴더가 없어요)" });

const guideEntrySchema = z
  .object({
    presetKey: z.string(),
    part: guidePartEnum,
    introKo: z.string().nullable(),
    sections: z.array(guideSectionShape),
    expressions: z.array(
      z.object({
        no: z.number().int().nullable(),
        expression: z.string(),
        meaningKo: z.string(),
        example: z.string().nullable(),
        exampleKo: z.string().nullable(),
      }),
    ),
    speak: z.array(
      z.object({
        no: z.number({ error: "speak.no는 1~999 정수예요(null 금지 — 항목 키 quiz:{no})" }).int("speak.no는 정수여야 합니다"),
        promptKo: z.string(),
        hint: z.string().nullable(),
        modelAnswer: z.string(),
      }),
    ),
  })
  .superRefine((g, ctx) => {
    checkPresetKey(ctx, ["presetKey"], g.presetKey);
    checkOptKoText(ctx, ["introKo"], g.introKo, TOEIC_GUIDE_INTRO_MAX, "introKo");
    checkCount(ctx, ["sections"], g.sections, 1, TOEIC_GUIDE_SECTIONS_MAX, "sections");
    g.sections.forEach((sec, s) => {
      const sp: Path = ["sections", s];
      checkOptChars(ctx, [...sp, "label"], sec.label, TOEIC_GUIDE_LABEL_MAX, "label");
      checkKoText(ctx, [...sp, "titleKo"], sec.titleKo, TOEIC_GUIDE_TITLE_MAX, "titleKo");
      checkOptKoText(ctx, [...sp, "introKo"], sec.introKo, TOEIC_GUIDE_INTRO_MAX, "introKo");
      checkOptKoText(ctx, [...sp, "groupKo"], sec.groupKo, TOEIC_GUIDE_GROUP_MAX, "groupKo");
      checkCount(ctx, [...sp, "blocks"], sec.blocks, 1, TOEIC_GUIDE_BLOCKS_MAX, "blocks");
      sec.blocks.forEach((b, bi) => checkGuideBlock(ctx, [...sp, "blocks", bi], b));
    });

    // 표현(§12-2-3) — checkEntryText를 그대로 부르고, 공략 쪽 기호 규칙만 더한다(표현집 판독·가져오기 동작은 그대로)
    checkCount(ctx, ["expressions"], g.expressions, TOEIC_SET_ENTRIES_MIN, TOEIC_SET_ENTRIES_MAX, "expressions");
    g.expressions.forEach((e, i) => {
      checkEntryText(ctx, ["expressions", i], e, { allowBlankMeaning: false });
      if (/[{}/[\]]/.test(e.expression)) issue(ctx, ["expressions", i, "expression"], GUIDE_EXPR_SYMBOL_KO);
      if (e.example !== null && /[{}/[\]]/.test(e.example)) issue(ctx, ["expressions", i, "example"], GUIDE_EXPR_SYMBOL_KO);
    });
    checkUniqueNos(ctx, ["expressions"], g.expressions, "expressions");
    for (const i of findDuplicateExpressionIndexes(g.expressions)) issue(ctx, ["expressions", i, "expression"], TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO);

    // 말하기(§12-2-3) — checkQuizText + 길이·완성 문장 기호
    checkCount(ctx, ["speak"], g.speak, 0, TOEIC_GUIDE_SPEAK_MAX, "speak");
    g.speak.forEach((q, i) => {
      checkQuizText(ctx, ["speak", i], q);
      checkChars(ctx, ["speak", i, "promptKo"], q.promptKo, 1, TOEIC_GUIDE_LINE_KO_MAX, "promptKo");
      checkChars(ctx, ["speak", i, "modelAnswer"], q.modelAnswer, 1, TOEIC_GUIDE_LINE_KO_MAX, "modelAnswer");
      if (TILDES.test(q.modelAnswer) || /[{}/[\]]/.test(q.modelAnswer)) {
        issue(ctx, ["speak", i, "modelAnswer"], "말하기 modelAnswer는 완성 문장이에요 — ~ { } / [ ]를 쓸 수 없어요");
      }
    });
    checkUniqueNos(ctx, ["speak"], g.speak, "speak");

    if (utf8ByteLength(JSON.stringify(toeicGuideEntryContent(g))) > TOEIC_GUIDE_MAX_BYTES) {
      issue(ctx, [], `이 유형 항목이 너무 커요(UTF-8 최대 ${TOEIC_GUIDE_MAX_BYTES}바이트)`);
    }
  });

// ---------------------------------------------------------------------------
// 틀 은행 zod (§12-2-7)
// ---------------------------------------------------------------------------

/** 틀 전용 규칙을 통과했는가(교재 고정 부분 대조·예문 대조를 돌릴 만한 틀인가) — 자리 문법만 본다 */
function isFrameSyntaxOk(frameEn: string): boolean {
  const n = frameSlotNames(frameEn).length;
  return scanSlots(frameEn).problems.length === 0 && n >= TOEIC_TEMPLATE_SLOTS_MIN && n <= TOEIC_TEMPLATE_SLOTS_MAX;
}

const OPEN_QUOTES = "\"'“‘";
const SLOT_FOLLOWERS = ".,?!;:";

/** 채움(예문·테스트 전용) — 1~80자, 라틴 또는 숫자 포함(가격·시각·연도 — 검토 B1), 한글·{ } ~ / [ ] 거부, 앞뒤 공백 없음 */
function checkFill(ctx: IssueSink, path: Path, f: string): void {
  if (f.length < 1 || f.length > TOEIC_TEMPLATE_FILL_MAX) issue(ctx, path, `채움은 1~${TOEIC_TEMPLATE_FILL_MAX}자예요`);
  if (!(hasLatin(f) || /\d/.test(f))) issue(ctx, path, "채움에는 영어(라틴 문자)나 숫자가 있어야 해요");
  if (hasHangul(f)) issue(ctx, path, "채움에 한글을 쓸 수 없어요");
  if (hasBrace(f) || TILDES.test(f) || /[/[\]]/.test(f)) issue(ctx, path, "채움에 { } ~ / [ ]를 쓸 수 없어요");
  if (f !== f.trim()) issue(ctx, path, "채움 앞뒤에 공백을 둘 수 없어요");
}

function fillsKey(fills: readonly string[]): string {
  return fills.map((x) => x.toLowerCase()).join("\u0000");
}

/** guideRefs 한 줄의 대상 키(같은 연결 판정·연결 표 공용) */
function refTargetKey(kind: ToeicTemplateRefKind, target: string): string {
  if (kind === "expression") return expressionKey(target);
  if (kind === "lead") return collapseSpaces(target);
  return target.trim();
}
function refTarget(r: ToeicTemplateGuideRef): string {
  return r.kind === "expression" ? r.expression : r.kind === "template" ? r.step : r.leadEn;
}

const templateRefShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expression"), part: guidePartEnum, expression: z.string() }),
  z.object({ kind: z.literal("template"), part: guidePartEnum, step: z.string() }),
  z.object({ kind: z.literal("lead"), part: guidePartEnum, leadEn: z.string() }),
]);

const templateSchema = z
  .object({
    key: z.string(),
    groupKo: z.string(),
    frameEn: z.string(),
    frameKo: z.string(),
    useKo: z.string(),
    parts: z.array(guidePartEnum),
    source: z.enum(TOEIC_TEMPLATE_SOURCES),
    guideRefs: z.array(templateRefShape),
    examples: z.array(z.object({ en: z.string(), ko: z.string(), fills: z.array(z.string()) })),
    testFills: z.array(z.array(z.string())),
  })
  .superRefine((t, ctx) => {
    if (!TOEIC_TEMPLATE_KEY_RE.test(t.key)) issue(ctx, ["key"], "key는 소문자·숫자·하이픈(첫 글자는 소문자·숫자, 최대 40자)이어야 합니다");
    checkKoText(ctx, ["groupKo"], t.groupKo, TOEIC_TEMPLATE_GROUP_KO_MAX, "groupKo");
    checkKoText(ctx, ["useKo"], t.useKo, TOEIC_TEMPLATE_USE_KO_MAX, "useKo");
    checkCount(ctx, ["parts"], t.parts, 1, TOEIC_GUIDE_PARTS.length, "parts");
    if (new Set(t.parts).size !== t.parts.length) issue(ctx, ["parts"], "parts 중복 금지");

    // 영어 틀
    checkChars(ctx, ["frameEn"], t.frameEn, 1, TOEIC_TEMPLATE_FRAME_MAX, "frameEn");
    if (!hasLatin(t.frameEn)) issue(ctx, ["frameEn"], "frameEn에는 영어(라틴 문자)가 있어야 합니다");
    const slotsOk = checkSlotSyntax(ctx, ["frameEn"], t.frameEn, "frameEn");
    if (hasHangul(textOutsideSlots(t.frameEn))) issue(ctx, ["frameEn"], "frameEn: 한글은 자리 {…} 안에서만 쓸 수 있어요");
    const { slots } = scanSlots(t.frameEn);
    const names = slots.map((x) => x.name);
    if (names.length < TOEIC_TEMPLATE_SLOTS_MIN || names.length > TOEIC_TEMPLATE_SLOTS_MAX) {
      issue(ctx, ["frameEn"], `틀의 자리는 ${TOEIC_TEMPLATE_SLOTS_MIN}~${TOEIC_TEMPLATE_SLOTS_MAX}개예요`);
    }
    if (new Set(names).size !== names.length) issue(ctx, ["frameEn"], "틀 안 자리 이름 중복 금지");
    for (const sl of slots) {
      const before = sl.start === 0 ? "" : t.frameEn[sl.start - 1];
      const after = sl.end >= t.frameEn.length ? "" : t.frameEn[sl.end];
      const okBefore = before === "" || /\s/.test(before) || OPEN_QUOTES.includes(before);
      const okAfter = after === "" || /\s/.test(after) || SLOT_FOLLOWERS.includes(after);
      if (!okBefore || !okAfter) {
        issue(ctx, ["frameEn"], "자리는 낱말 하나처럼 서야 해요 — 자리 앞뒤에 글자를 붙여 쓸 수 없어요(-ing·'s 등은 자리 안에)");
        break;
      }
    }
    const outside = textOutsideSlots(t.frameEn);
    if (TILDES.test(outside) || /[/[\]]/.test(outside)) issue(ctx, ["frameEn"], "틀의 자리 밖에는 ~ / [ ]를 쓸 수 없어요 — 자리는 { }, 대안은 틀을 나눠요");
    const fixedWords = parseFrame(t.frameEn)
      .filter((p) => p.kind === "fixed")
      .flatMap((p) => (p.kind === "fixed" ? normalizeTemplateWords(p.text) : []));
    if (fixedWords.length === 0) issue(ctx, ["frameEn"], "틀에는 고정 부분 낱말이 1개 이상 있어야 해요");
    const frameOk = slotsOk && isFrameSyntaxOk(t.frameEn);
    const slotCount = names.length;

    // 한국어 틀 — 같은 슬롯 규칙, 자리 이름의 모임이 영어와 같다, ~ 금지
    checkChars(ctx, ["frameKo"], t.frameKo, 1, TOEIC_TEMPLATE_FRAME_MAX, "frameKo");
    // 한글 포함 — 자리 이름 밖에서 센다(자리 이름만 한글인 "So {결론}."은 한국어 틀이 아니다)
    if (!hasHangul(textOutsideSlots(t.frameKo))) issue(ctx, ["frameKo"], "frameKo에는 자리 밖에 한글이 있어야 합니다");
    const koOk = checkSlotSyntax(ctx, ["frameKo"], t.frameKo, "frameKo");
    if (TILDES.test(t.frameKo)) issue(ctx, ["frameKo"], "한국어 틀도 이름 있는 자리 {…}로 적어요(~ 금지)");
    if (frameOk && koOk) {
      const ko = new Set(frameSlotNames(t.frameKo));
      const en = new Set(names);
      if (ko.size !== en.size || [...en].some((n) => !ko.has(n))) issue(ctx, ["frameKo"], "한국어 틀의 자리 이름 모임이 영어 틀과 같아야 해요");
    }

    // 예문
    checkCount(ctx, ["examples"], t.examples, TOEIC_TEMPLATE_EXAMPLES_MIN, TOEIC_TEMPLATE_EXAMPLES_MAX, "examples");
    const exSeen = new Set<string>();
    const fillSeen = new Set<string>();
    t.examples.forEach((ex, j) => {
      const p: Path = ["examples", j];
      if (frameOk && ex.fills.length !== slotCount) issue(ctx, [...p, "fills"], "채움 수는 틀의 자리 수와 같아야 해요");
      ex.fills.forEach((f, k) => checkFill(ctx, [...p, "fills", k], f));
      checkChars(ctx, [...p, "en"], ex.en, 1, TTS_TEXT_MAX_CHARS, "examples.en");
      if (frameOk && ex.fills.length === slotCount && ex.en !== fillFrame(t.frameEn, ex.fills)) {
        issue(ctx, [...p, "en"], "예문 en은 틀에 채움을 넣은 결과와 글자까지(대소문자·문장부호·공백) 같아야 해요");
      }
      checkKoText(ctx, [...p, "ko"], ex.ko, TOEIC_TEMPLATE_EXAMPLE_KO_MAX, "examples.ko");
      if (hasBrace(ex.ko) || TILDES.test(ex.ko)) issue(ctx, [...p, "ko"], "예문 ko에는 { } ~를 쓸 수 없어요");
      const ek = matchKey(ex.en);
      if (exSeen.has(ek)) issue(ctx, [...p, "en"], "한 틀 안 예문 중복 금지(대소문자·공백 무시)");
      exSeen.add(ek);
      const fk = fillsKey(ex.fills);
      if (fillSeen.has(fk)) issue(ctx, [...p, "fills"], "한 틀 안 채움 묶음 중복 금지(대소문자 무시)");
      fillSeen.add(fk);
    });

    // 테스트 전용 채움
    checkCount(ctx, ["testFills"], t.testFills, TOEIC_TEMPLATE_TEST_FILLS_MIN, TOEIC_TEMPLATE_TEST_FILLS_MAX, "testFills");
    const tfSeen = new Set<string>();
    t.testFills.forEach((tf, j) => {
      const p: Path = ["testFills", j];
      if (frameOk && tf.length !== slotCount) issue(ctx, p, "채움 수는 틀의 자리 수와 같아야 해요");
      tf.forEach((f, k) => checkFill(ctx, [...p, k], f));
      const k = fillsKey(tf);
      if (fillSeen.has(k)) issue(ctx, p, "테스트 전용 채움은 예문의 채움과 달라야 해요(대소문자 무시)");
      if (tfSeen.has(k)) issue(ctx, p, "테스트 전용 채움 묶음 중복 금지");
      tfSeen.add(k);
      if (frameOk && tf.length === slotCount && fillFrame(t.frameEn, tf).trim().length > TTS_TEXT_MAX_CHARS) {
        issue(ctx, p, `채운 문장은 ${TTS_TEXT_MAX_CHARS}자 이하여야 해요`);
      }
    });

    // 출처·연결(대상 존재·교재 고정 부분은 파일 전체를 보는 최상위 검사가 본다)
    checkCount(ctx, ["guideRefs"], t.guideRefs, 0, TOEIC_TEMPLATE_GUIDE_REFS_MAX, "guideRefs");
    if (t.source === "guide" && t.guideRefs.length === 0) issue(ctx, ["guideRefs"], "교재 틀(source guide)은 guideRefs가 1개 이상이어야 해요");
    const refSeen = new Set<string>();
    t.guideRefs.forEach((r, j) => {
      if (t.source === "new" && r.kind !== "template") {
        issue(ctx, ["guideRefs", j, "kind"], "새 틀(source new)은 kind template 연결만 쓸 수 있어요 — 교재 표현·머리말을 가리키면 교재 틀(guide)이에요");
      }
      if (!t.parts.includes(r.part)) issue(ctx, ["guideRefs", j, "part"], "연결의 part는 이 틀의 parts 안에 있어야 해요");
      const k = `${r.kind}\u0000${r.part}\u0000${refTargetKey(r.kind, refTarget(r))}`;
      if (refSeen.has(k)) issue(ctx, ["guideRefs", j], "같은 연결 두 번 금지");
      refSeen.add(k);
    });
  });

const templateBankSchema = z
  .object({
    presetKey: z.string(),
    flows: z.array(
      z.object({
        part: guidePartEnum,
        steps: z.array(z.object({ stepKo: z.string(), groupsKo: z.array(z.string()) })),
        banksKo: z.array(z.string()),
      }),
    ),
    items: z.array(templateSchema),
    alignmentSkips: z.array(
      z.object({
        part: guidePartEnum,
        kind: z.enum(TOEIC_TEMPLATE_REF_KINDS),
        ref: z.string(),
        reasonKo: z.string(),
        coveredBy: z.string().nullable(),
      }),
    ),
  })
  .superRefine((b, ctx) => {
    checkPresetKey(ctx, ["presetKey"], b.presetKey);
    checkCount(ctx, ["items"], b.items, 1, TOEIC_TEMPLATES_MAX, "items");
    const keys = new Set<string>();
    const forms = new Set<string>();
    b.items.forEach((t, i) => {
      if (keys.has(t.key)) issue(ctx, ["items", i, "key"], "틀 key 중복 금지");
      keys.add(t.key);
      const form = matchKey(frameToExpression(t.frameEn));
      if (form !== "" && forms.has(form)) issue(ctx, ["items", i, "frameEn"], "~ 형태(자리를 ~로 바꾼 글자)가 같은 틀이 은행에 이미 있어요 — 자리 이름만 다른 틀은 둘 수 없어요");
      forms.add(form);
    });

    // 흐름(§12-2-7) — 단계(3~6) + 소재 묶음, 한 유형 안 묶음 이름은 한 번, 틀 묶음 모임 = 흐름 묶음 모임, 묶음당 틀 ≤ 6
    const partsUsed = new Set<ToeicGuidePart>(b.items.flatMap((t) => t.parts));
    const flowParts = new Set<ToeicGuidePart>();
    b.flows.forEach((f, fi) => {
      const fp: Path = ["flows", fi];
      if (flowParts.has(f.part)) issue(ctx, [...fp, "part"], "유형마다 흐름은 하나예요(part 중복)");
      flowParts.add(f.part);
      if (!partsUsed.has(f.part)) issue(ctx, [...fp, "part"], "이 유형을 쓰는 틀이 없어요 — 흐름을 빼 주세요");
      checkCount(ctx, [...fp, "steps"], f.steps, TOEIC_TEMPLATE_FLOW_STEPS_MIN, TOEIC_TEMPLATE_FLOW_STEPS_MAX, "steps");
      checkCount(ctx, [...fp, "banksKo"], f.banksKo, 0, TOEIC_TEMPLATE_BANKS_MAX, "banksKo");
      const stepNames = new Set<string>();
      const groupSeen = new Set<string>();
      const locs = new Map<string, Path>();
      const seeGroup = (name: string, path: Path) => {
        checkChars(ctx, path, name, 1, TOEIC_TEMPLATE_FLOW_NAME_MAX, "묶음 이름");
        if (groupSeen.has(name)) issue(ctx, path, "한 유형 흐름 안에서 묶음 이름은 한 번만 나와요(단계·소재 통틀어)");
        groupSeen.add(name);
        if (!locs.has(name)) locs.set(name, path);
      };
      f.steps.forEach((st, si) => {
        const sp: Path = [...fp, "steps", si];
        checkKoText(ctx, [...sp, "stepKo"], st.stepKo, TOEIC_TEMPLATE_FLOW_NAME_MAX, "stepKo");
        if (stepNames.has(st.stepKo)) issue(ctx, [...sp, "stepKo"], "한 유형 안 단계 이름 중복 금지");
        stepNames.add(st.stepKo);
        checkCount(ctx, [...sp, "groupsKo"], st.groupsKo, 1, TOEIC_TEMPLATE_STEP_GROUPS_MAX, "groupsKo");
        st.groupsKo.forEach((g, gi) => seeGroup(g, [...sp, "groupsKo", gi]));
      });
      f.banksKo.forEach((g, gi) => seeGroup(g, [...fp, "banksKo", gi]));
      // 그 유형 틀들의 묶음 모임 = 흐름의 묶음 모임, 묶음당 틀 ≤ 6(유형마다 센다 — 공통 틀 포함)
      const count = new Map<string, number>();
      b.items.forEach((t, i) => {
        if (!t.parts.includes(f.part)) return;
        count.set(t.groupKo, (count.get(t.groupKo) ?? 0) + 1);
        if (!groupSeen.has(t.groupKo)) issue(ctx, ["items", i, "groupKo"], `이 틀의 묶음이 ${f.part} 흐름에 없어요`);
      });
      for (const [name, path] of locs) {
        const n = count.get(name) ?? 0;
        if (n === 0) issue(ctx, path, `이 묶음에 ${f.part} 유형 틀이 없어요`);
        if (n > TOEIC_TEMPLATE_GROUP_MAX) issue(ctx, path, `묶음 하나의 틀은 ${TOEIC_TEMPLATE_GROUP_MAX}개까지예요(${f.part}) — 원본에서 묶음을 나눠 주세요`);
      }
    });
    for (const p of TOEIC_GUIDE_PARTS) {
      if (partsUsed.has(p) && !flowParts.has(p)) issue(ctx, ["flows"], `틀이 쓰는 유형(${p})의 흐름이 없어요`);
    }

    // 정렬 건너뜀 — 모양·중복·coveredBy(대상 존재·연결 충돌은 최상위 검사)
    checkCount(ctx, ["alignmentSkips"], b.alignmentSkips, 0, TOEIC_TEMPLATE_SKIPS_MAX, "alignmentSkips");
    const skipSeen = new Set<string>();
    b.alignmentSkips.forEach((sk, k) => {
      const p: Path = ["alignmentSkips", k];
      checkKoText(ctx, [...p, "reasonKo"], sk.reasonKo, TOEIC_TEMPLATE_SKIP_REASON_MAX, "reasonKo");
      if (sk.coveredBy !== null && !b.items.some((t) => t.key === sk.coveredBy && t.parts.includes(sk.part))) {
        issue(ctx, [...p, "coveredBy"], "coveredBy는 이 유형을 parts에 가진 틀의 key여야 해요");
      }
      const key = `${sk.part}\u0000${sk.kind}\u0000${refTargetKey(sk.kind, sk.ref)}`;
      if (skipSeen.has(key)) issue(ctx, p, "같은 대상을 두 번 건너뛸 수 없어요");
      skipSeen.add(key);
    });

    if (utf8ByteLength(JSON.stringify(toeicTemplateBankContent(b))) > TOEIC_GUIDE_MAX_BYTES) {
      issue(ctx, [], `틀 은행이 너무 커요(UTF-8 최대 ${TOEIC_GUIDE_MAX_BYTES}바이트)`);
    }
  });

/** 한 유형 공략 항목에서 틀이 가리킬 수 있는 대상(모두 — 정렬 대상보다 넓다: 자리 없는 표현도 된다) */
function guideTargetSets(g: ToeicGuideFileEntry): Record<ToeicTemplateRefKind, Set<string>> {
  const out: Record<ToeicTemplateRefKind, Set<string>> = { expression: new Set(), template: new Set(), lead: new Set() };
  for (const e of g.expressions) out.expression.add(refTargetKey("expression", e.expression));
  for (const sec of g.sections) {
    for (const b of sec.blocks) {
      if (b.kind !== "lines") continue;
      if (b.style === "template") for (const ln of b.lines) if (ln.label !== null && ln.label.trim() !== "") out.template.add(refTargetKey("template", ln.label));
      if (b.style === "completions" && b.lead?.en) out.lead.add(refTargetKey("lead", b.lead.en));
    }
  }
  return out;
}

const REF_TARGET_FIELD: Record<ToeicTemplateRefKind, string> = { expression: "expression", template: "step", lead: "leadEn" };

/**
 * 가져오기 파일 zod(§12-2-3·§12-2-7) — 400 본문은 toeicGuideImportInvalidBody가 만든다. 파일 전체를 봐야 하는 교차 검사
 * (파일 안 part·presetKey 중복, guideRefs 대상·교재 고정 부분, alignmentSkips 대상·연결 충돌, **정렬 빠짐 0**)는 최상위 superRefine에서.
 * 라우트는 `safeParse(raw, { error: toeicZodErrorKo })`로 부른다(기본 오류 문구 한국어화).
 */
export const toeicGuideFileSchema: z.ZodType<ToeicGuideFile> = z
  .object({
    format: z.literal(TOEIC_GUIDE_FORMAT, {
      error: (iss) =>
        iss.input === TOEIC_GUIDE_FORMAT_V1
          ? "형식이 바뀌었어요(toeic-guides/v1 → v2) — 파일을 다시 만들어 주세요"
          : iss.input === TOEIC_IMPORT_FORMAT
            ? "표현집 가져오기 파일이에요 — 표현집 화면의 \"파일로 가져오기\"로 넣어 주세요"
            : `format은 "${TOEIC_GUIDE_FORMAT}"여야 해요`,
    }),
    guides: z.array(guideEntrySchema),
    templates: templateBankSchema.nullable(),
  })
  .superRefine((f, ctx) => {
    checkCount(ctx, ["guides"], f.guides, f.templates === null ? 1 : 0, TOEIC_GUIDE_FILE_GUIDES_MAX, "guides");
    const partSeen = new Set<string>();
    const keySeen = new Set<string>();
    f.guides.forEach((g, i) => {
      if (partSeen.has(g.part)) issue(ctx, ["guides", i, "part"], "한 파일에 같은 유형(part)은 하나만 넣어요");
      partSeen.add(g.part);
      if (keySeen.has(g.presetKey)) issue(ctx, ["guides", i, "presetKey"], "presetKey 중복 금지");
      keySeen.add(g.presetKey);
    });
    const bank = f.templates;
    if (bank === null) return;
    if (keySeen.has(bank.presetKey)) issue(ctx, ["templates", "presetKey"], "틀 은행 presetKey는 공략 키와 달라야 해요");

    const byPart = new Map<ToeicGuidePart, ToeicGuideFileEntry>(f.guides.map((g) => [g.part, g] as const));
    const targets = new Map<ToeicGuidePart, Record<ToeicTemplateRefKind, Set<string>>>();
    for (const g of f.guides) targets.set(g.part, guideTargetSets(g));
    /** 유형 → 종류 → 연결된 대상 키 */
    const linked = new Map<string, Set<string>>();
    const linkKey = (part: string, kind: string) => `${part}\u0000${kind}`;

    bank.items.forEach((t, i) => {
      const frameOk = isFrameSyntaxOk(t.frameEn);
      t.guideRefs.forEach((r, j) => {
        const rp: Path = ["templates", "items", i, "guideRefs", j];
        const target = refTarget(r);
        const tk = refTargetKey(r.kind, target);
        const lk = linkKey(r.part, r.kind);
        if (!linked.has(lk)) linked.set(lk, new Set());
        linked.get(lk)!.add(tk);
        const tg = targets.get(r.part);
        if (!tg) {
          issue(ctx, [...rp, "part"], "가리키는 유형의 공략이 같은 파일에 없어요");
          return;
        }
        if (!tg[r.kind].has(tk)) {
          issue(ctx, [...rp, REF_TARGET_FIELD[r.kind]], "가리키는 교재 대상이 같은 파일의 그 유형 공략에 없어요");
          return;
        }
        if (!frameOk) return;
        if (r.kind === "expression" && !expressionFixedPartsInFrame(r.expression, t.frameEn)) {
          issue(ctx, rp, "교재 표현의 고정 부분이 틀에 온전히(이어서, 순서대로) 들어 있지 않아요 — 교재 틀의 고정 부분을 글자 그대로 써 주세요");
        }
        if (r.kind === "lead" && !leadMatchesFrame(r.leadEn, t.frameEn)) {
          issue(ctx, rp, "이어 말하기 머리말이 틀에 이어지지 않아요 — 틀의 한 고정 구간에 들어 있거나(포함), 틀 머리의 자리를 채운 사례(고정 낱말 2개 이상)여야 해요");
        }
      });
    });

    const skipped = new Map<string, Set<string>>();
    bank.alignmentSkips.forEach((sk, k) => {
      const p: Path = ["templates", "alignmentSkips", k];
      const tk = refTargetKey(sk.kind, sk.ref);
      const lk = linkKey(sk.part, sk.kind);
      if (!skipped.has(lk)) skipped.set(lk, new Set());
      skipped.get(lk)!.add(tk);
      const tg = targets.get(sk.part);
      if (!tg) {
        issue(ctx, [...p, "part"], "건너뛸 대상의 유형 공략이 같은 파일에 없어요");
        return;
      }
      if (!tg[sk.kind].has(tk)) issue(ctx, [...p, "ref"], "건너뛸 교재 대상이 같은 파일의 그 유형 공략에 없어요");
      if (linked.get(lk)?.has(tk)) issue(ctx, p, "어떤 틀이 연결한 대상은 건너뛸 수 없어요");
    });

    // 정렬 빠짐 0(§12-2-7 — 사용자 지시 "기존 템플릿에 최대한 맞춰"). 경로는 위치만, 대상 글자는 싣지 않는다.
    for (const g of f.guides) {
      const tg = toeicGuideAlignmentTargets(g);
      for (const kind of TOEIC_TEMPLATE_REF_KINDS) {
        const lk = linkKey(g.part, kind);
        tg[kind].forEach((target, idx) => {
          const tk = refTargetKey(kind, target);
          if (linked.get(lk)?.has(tk) || skipped.get(lk)?.has(tk)) return;
          issue(ctx, ["templates", "alignment", g.part, kind, idx], "교재 정렬 대상이 어떤 틀에도 연결되지 않았고 건너뜀 목록(alignmentSkips)에도 없어요");
        });
      }
    }
  });

/**
 * 가져오기 400 본문(§12-2-3) — 라우트는 이 함수를 그대로 쓰고, eval도 같은 함수로 값 누출을 검사한다. issues는 경로 + 규칙 문구만
 * (toToeicIssues — 값 없음, 최대 20개). 형식 오류면 그 문구를 messageKo로 올린다.
 */
export function toeicGuideImportInvalidBody(issues: readonly z.core.$ZodIssue[]): {
  ok: false;
  error: "invalid_input";
  messageKo: string;
  issues: { path: string; message: string }[];
} {
  const formatIssue = issues.find((i) => i.path.length === 1 && i.path[0] === "format");
  return {
    ok: false,
    error: "invalid_input",
    messageKo: formatIssue?.message ?? "공략 파일을 가져올 수 없어요 — 표시된 위치를 고쳐 파일을 다시 만들어 주세요",
    issues: toToeicIssues(issues, TOEIC_GUIDE_IMPORT_ISSUES_MAX),
  };
}

// ---------------------------------------------------------------------------
// 템플릿 테스트 기록 라우트 본문 zod (§12-5-6) — 요청 타입은 lib/toeic-guide-contract.ts(라우트가 양방향으로 묶는다)
// ---------------------------------------------------------------------------

export const toeicTemplateSessionBodySchema = z
  .object({
    clientSessionId: z.string().regex(TOEIC_TEMPLATE_SESSION_ID_RE, "clientSessionId는 소문자 UUID여야 해요"),
    mode: z.enum(TOEIC_TEMPLATE_QUIZ_MODES),
    startedAt: z.string().datetime({ message: "startedAt이 올바른 시각이 아니에요" }),
    finishedAt: z.string().datetime({ message: "finishedAt이 올바른 시각이 아니에요" }).nullable(),
    items: z
      .array(
        z.object({
          word: z.string().regex(TOEIC_TEMPLATE_ITEM_KEY_RE, "항목 키는 tpl:{틀 key} 모양이어야 해요"),
          correct: z.boolean(),
          answered: z.boolean().nullable(),
        }),
      )
      .min(1, "저장할 문항이 없어요")
      .max(TOEIC_TEMPLATE_TEST_MAX, `한 판은 ${TOEIC_TEMPLATE_TEST_MAX}문항까지예요`),
  })
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.items.forEach((it, i) => {
      if (seen.has(it.word)) issue(ctx, ["items", i, "word"], "한 판에 같은 틀은 한 번만 나와요");
      seen.add(it.word);
    });
  });

/** 요청 계약(lib/toeic-guide-contract.ts)과 본문 zod 입력을 양방향으로 묶는다 — 한쪽 필드만 바꾸면 tsc가 잡는다 */
type ToeicTemplateSessionBodyInput = z.input<typeof toeicTemplateSessionBodySchema>;
const templateSessionRequestMatchesSchema: [ToeicTemplateSessionRequest, ToeicTemplateSessionBodyInput] extends [ToeicTemplateSessionBodyInput, ToeicTemplateSessionRequest]
  ? true
  : never = true;
void templateSessionRequestMatchesSchema;

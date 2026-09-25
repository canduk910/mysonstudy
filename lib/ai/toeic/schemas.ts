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

export { TOEIC_MOCK_PARTS, TOEIC_TARGET_GRADES };
export type { ToeicMockPart, ToeicTargetGrade };

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

function issue(ctx: IssueSink, path: Path, message: string): void {
  ctx.addIssue({ code: "custom", path, message });
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

/** QUIZ 원문 규칙(§2-4) — 호출 A와 가져오기 파일이 같이 쓴다 */
function checkQuizText(ctx: IssueSink, path: Path, q: ToeicBookQuiz): void {
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

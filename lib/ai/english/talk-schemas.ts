/**
 * lib/ai/english/talk-schemas.ts — 은우 자유대화의 타입·상한 + 호출 I(문장 설명) JSON Schema·zod
 * (docs/harness/english.md §12-3·§12-4, SPEC §21)
 *
 * - `TALK_SENTENCE_EXPLANATION_JSON_SCHEMA`는 스펙 §12-3 코드블록과 **의미 동치**다(설명문 없이 스펙 원문 그대로 —
 *   scripts/eval-english.ts가 스펙 블록을 JSON으로 파싱해 deep-equal로 잠근다). 배열 개수 제약은 JSON Schema에 넣지 않는다
 *   (§1 공통 규칙) — 프롬프트 + zod(`buildTalkExplainZod`)가 담당한다.
 * - zod는 **입력(누가 한 말·고른 문장)을 알고** 만든다: 선생님 문장이면 betterEn은 반드시 null, keyWords는 고른 문장 안에
 *   단어 경계로 실제로 있어야 한다(문장에 없는 단어를 짚으면 환각). 폭은 프롬프트보다 넓게 잡는다(§12-3).
 * - 저장 레코드(`TalkSessionRecord`, lib/store.ts — app-builder)가 import하는 하위 타입(TalkTopic·TalkTurn·TalkExplanation)과
 *   자유대화 상한(`TALK_LIMITS`)의 단일 정의처다. 화면이 알아야 하는 값(직접 입력 글자 상한·5분)은 클라이언트 안전 모듈
 *   lib/talk-topics.ts에 있고, 여기서는 그 값을 가져다 묶기만 한다(두 번 정의하지 않는다).
 *
 * - §12-6 화면 카드의 도구 정의 `TALK_TOOLS`(show_hints·show_picture)도 여기 둔다 — 세션 설정(서버 전용 lib/talk-session-config.ts)만
 *   쓰고, 스펙 JSON과 **의미 동치**로 eval이 잠근다. 도구 호출 검사·기본 문구·폭은 클라이언트 안전 모듈 lib/talk-cards.ts에 있다.
 *
 * ⚠️ zod 런타임을 import한다 — 클라이언트 컴포넌트는 이 파일에서 **값**을 import하지 말고 `import type`만(계약 파일 관용구).
 */

import { z } from "zod";
import type { RealtimeFunctionTool, RealtimeToolChoiceConfig } from "openai/resources/realtime/realtime";
import { containsHangul, type StrictJsonSchema } from "./schemas";
import { TALK_CUSTOM_TOPIC_MAX_CHARS, TALK_MAX_DURATION_SEC } from "../../talk-topics";
import { TALK_CARD_LIMITS, TALK_TOOL_NAMES, containsLatin } from "../../talk-cards";

// ---------------------------------------------------------------------------
// 타입 — 저장 모델(§12-4)의 하위 타입. 선택 키(`?`) 없이 전부 필수(nullable)다(Firestore가 undefined를 거부).
// ---------------------------------------------------------------------------

export const TALK_SPEAKERS = ["teacher", "child"] as const;
/** teacher = AI 선생님(Sunny), child = 은우(마이크 입력 전부 — 옆 사람 목소리도 여기로 온다, SPEC §21 한계) */
export type TalkSpeaker = (typeof TALK_SPEAKERS)[number];

export const TALK_TOPIC_KINDS = ["preset", "custom", "vocab"] as const;
export type TalkTopicKind = (typeof TALK_TOPIC_KINDS)[number];

/** 단어장 모드에서 선생님에게 실제로 넘긴 단어 한 개(스냅샷). 뜻이 없으면 ko=null(지시문에서 뜻 생략). */
export interface TalkTopicWord {
  en: string;
  ko: string | null;
}

/** 대화 주제 스냅샷 — 서버가 해석해 지시문에 넣은 **그대로** 저장한다(나중에 단어장이 바뀌어도 기록은 그대로, §12-1). */
export interface TalkTopic {
  kind: TalkTopicKind;
  /** 프리셋 키(그 밖 null) */
  key: string | null;
  /** 화면 라벨(프리셋 한국어·직접 입력 글자·단어장 이름) — 호출 I의 {topicLabel}도 이 값 */
  labelKo: string;
  /** 프리셋 영어 라벨(그 밖 null) */
  labelEn: string | null;
  vocabBookId: string | null;
  /** 단어장이면 실제로 넘긴 단어(최대 TALK_LIMITS.vocabWords), 아니면 [] */
  words: TalkTopicWord[];
}

/** 저장용 턴 — toTalkTurns(lib/talk-transcript.ts)가 실시간 줄에서 만든다 */
export interface TalkTurn {
  speaker: TalkSpeaker;
  text: string;
  /** 선생님 말이 끊겼는가(response.done cancelled). 은우 턴은 늘 false */
  interrupted: boolean;
}

export const TALK_SCRIPT_LANGS = ["ko", "en"] as const;
export type TalkScriptLang = (typeof TALK_SCRIPT_LANGS)[number];

/** 설명 대본 조각 하나(소리 내어 읽는 단위) */
export interface TalkScriptPiece {
  lang: TalkScriptLang;
  text: string;
}

/** 설명에서 짚은 단어 — en은 고른 문장 안에 실제로 있는 단어 */
export interface TalkKeyWord {
  en: string;
  ko: string;
}

/** 화면 카드 한 장(§12-6) — 그림 카드(show_picture)·도움 카드의 핵심 단어(show_hints.words)·대화 기록의 `cards` 항목 */
export interface TalkCard {
  emoji: string;
  en: string;
  ko: string;
}

/** 호출 I의 출력(모델이 만드는 부분) */
export interface TalkSentenceExplanation {
  script: TalkScriptPiece[];
  /** 은우 문장의 더 자연스러운 영어(선생님 문장·이미 잘 말한 문장은 null) */
  betterEn: string | null;
  keyWords: TalkKeyWord[];
}

/** 대화 기록에 붙는 설명 한 건(§12-4). 키 = (turnIndex, sentenceIndex) — 처음 한 번만 저장한다. */
export interface TalkExplanation {
  turnIndex: number;
  sentenceIndex: number;
  speaker: TalkSpeaker;
  sentence: string;
  script: TalkScriptPiece[];
  betterEn: string | null;
  keyWords: TalkKeyWord[];
  model: string;
  createdAt: string;
}

/** explainTalkSentence(lib/ai/client.ts)의 입력 — 라우트가 저장된 대화에서 꺼내 넘긴다(클라이언트는 번호만 보낸다) */
export interface TalkExplainInput {
  /** 주제 한국어 라벨(단어장이면 단어장 이름) = TalkTopic.labelKo */
  topicLabel: string;
  turns: readonly TalkTurn[];
  turnIndex: number;
  sentenceIndex: number;
}

/** explainTalkSentence의 반환 — createdAt만 라우트가 붙이면 TalkExplanation이 된다 */
export type TalkExplainResult = Omit<TalkExplanation, "createdAt">;

// ---------------------------------------------------------------------------
// 상한 — 한 곳에서 정의하고 라우트 zod·eval·조립 함수가 import한다(두 곳에 적으면 언젠가 어긋난다).
// ---------------------------------------------------------------------------

/** 자유대화 저장·입력 상한(§12-1·§12-4, SPEC §21-1) */
export const TALK_LIMITS = {
  /** 저장 턴 수 상한 */
  turns: 200,
  /** 턴 하나의 글자 상한 */
  turnChars: 1000,
  /** 대화 하나에 붙는 설명 수 상한 */
  explanations: 200,
  /** 단어장 모드에서 선생님에게 넘기는 단어 수 상한(책 순서) */
  vocabWords: 20,
  /** 직접 입력 주제 글자 상한 — 정의처는 lib/talk-topics.ts(화면 입력창이 같은 값을 본다) */
  customTopicChars: TALK_CUSTOM_TOPIC_MAX_CHARS,
  /** 대화 한 번의 시간 상한(초) — 정의처는 lib/talk-topics.ts */
  maxDurationSec: TALK_MAX_DURATION_SEC,
  /** 대화 기록에 남기는 그림 카드 수(§12-6 "최대 30장") — 정의처는 lib/talk-cards.ts(화면이 같은 값을 본다) */
  cards: TALK_CARD_LIMITS.savedCardsMax,
} as const;

/** 호출 I zod의 폭(§12-3 — 프롬프트보다 넓게: 조각 3~8 → 2~10, ko 60자 → 80자, en 12단어 → 16단어) */
export const TALK_EXPLAIN_LIMITS = {
  scriptMin: 2,
  scriptMax: 10,
  koPieceMaxChars: 80,
  enPieceMaxWords: 16,
  koTotalMaxChars: 400,
  betterEnMaxWords: 25,
  keyWordsMax: 3,
  keyWordKoMaxChars: 20,
} as const;

// ---------------------------------------------------------------------------
// 호출 I — talk_sentence_explanation JSON Schema (스펙 §12-3 원문, 의미 동치)
// ---------------------------------------------------------------------------

export const TALK_SENTENCE_EXPLANATION_JSON_SCHEMA: StrictJsonSchema = {
  name: "talk_sentence_explanation",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["script", "betterEn", "keyWords"],
    properties: {
      script: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lang", "text"],
          properties: {
            lang: { type: "string", enum: ["ko", "en"] },
            text: { type: "string" },
          },
        },
      },
      betterEn: { type: ["string", "null"] },
      keyWords: {
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
  strict: true,
};

// ---------------------------------------------------------------------------
// §12-6 화면 카드 — 도구 정의 (스펙 JSON과 의미 동치, 세션 설정 `tools`)
// ---------------------------------------------------------------------------

/**
 * 선생님이 화면 카드를 보내는 도구 두 개(english.md §12-6 원문 JSON). 배열 개수·글자 제약은 스키마에 넣지 않는다(스펙 원문 그대로) —
 * 도착한 인자는 lib/talk-cards.ts `parseTalkToolCall`이 항목 단위로 검사한다(모델 출력이라 믿지 않는다).
 */
export const TALK_TOOLS: readonly RealtimeFunctionTool[] = [
  {
    type: "function",
    name: TALK_TOOL_NAMES.hints,
    description:
      "Silently prepare answer help for the question you just asked. The app shows it on the child's screen only if the child gets stuck.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        answers: {
          type: "array",
          description: "2 or 3 short English answers the child could say (2 to 6 easy words each).",
          items: { type: "string" },
        },
        words: {
          type: "array",
          description: "Up to 3 key words for the answers.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              emoji: { type: "string" },
              en: { type: "string" },
              ko: { type: "string" },
            },
            required: ["emoji", "en", "ko"],
          },
        },
      },
      required: ["answers", "words"],
    },
  },
  {
    type: "function",
    name: TALK_TOOL_NAMES.picture,
    description: "Silently show a picture card on the child's screen for a thing, animal, food, color, or action you are talking about.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        emoji: { type: "string", description: "One to three emoji that show the word." },
        en: { type: "string", description: "The English word or short phrase." },
        ko: { type: "string", description: "Its easy Korean meaning." },
      },
      required: ["emoji", "en", "ko"],
    },
  },
];

/** 도구 선택(§12-6 `tool_choice: "auto"`) */
export const TALK_TOOL_CHOICE: RealtimeToolChoiceConfig = "auto";

// ---------------------------------------------------------------------------
// 글자 판정 — zod와 eval이 같은 함수를 본다
// ---------------------------------------------------------------------------

/**
 * 라틴 문자(반각·전각). 한국어 조각에 섞이면 한국어 음성이 영어를 한국어식으로 읽는다(§12-3 [script]).
 * 정의는 클라이언트 안전 모듈 lib/talk-cards.ts 한 곳(화면 카드 검사가 같은 판정을 쓴다) — 여기서는 다시 내보낸다.
 */
export { containsLatin };

/** 글자 수 — 코드 포인트 기준(이모지 한 개를 2자로 세지 않는다) */
export function countTalkChars(text: string): number {
  return Array.from(text).length;
}

/** 공백으로 나눈 단어 수 */
export function countTalkWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** 곧은/굽은 아포스트로피를 하나로(don’t = don't) */
function unifyApostrophes(text: string): string {
  return text.replace(/[’‘ʼ]/g, "'");
}

/**
 * keyWord(en)가 고른 문장 안에 **단어 경계로** 있는가(대소문자 무시). "dog"는 "dogs" 안에서 인정하지 않는다 —
 * 짚은 단어가 문장에 그대로 있어야 아이가 문장에서 그 단어를 찾을 수 있다. 여러 낱말(ice cream)이면 공백 폭은 무시한다.
 * 아포스트로피는 단어 글자로 본다("don"은 "don't" 안에서 인정하지 않는다).
 */
export function isKeyWordInSentence(word: string, sentence: string): boolean {
  const w = unifyApostrophes(word).trim().replace(/\s+/g, " ");
  if (w === "") return false;
  const s = unifyApostrophes(sentence);
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9'])${escaped}(?![A-Za-z0-9'])`, "i").test(s);
}

// ---------------------------------------------------------------------------
// 호출 I — zod (§12-3). 거부 → callWithSchema가 오류 요약을 붙여 1회 재요청(§4 규약).
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx;
function issue(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

/**
 * 호출 I zod 팩토리 — 입력(누가 한 말·고른 문장)을 알고 만든다(토익 buildFeedbackZod 관용구).
 * - script 2~10조각, ko·en 각 1개 이상. ko: 한글 포함·라틴 금지·80자 이하. en: 라틴 포함·한글 금지·16단어 이하. ko 글자 합 400자 이하.
 * - betterEn: speaker가 teacher면 반드시 null. 값이 있으면 라틴 포함·한글 금지·25단어 이하.
 * - keyWords 0~3개: en은 영어(라틴 포함·한글 금지)이고 고른 문장 안에 단어 경계로 있어야(대소문자 무시), ko는 한글 포함·20자 이하.
 */
export function buildTalkExplainZod(args: { speaker: TalkSpeaker; sentence: string }): z.ZodType<TalkSentenceExplanation> {
  const L = TALK_EXPLAIN_LIMITS;
  return z
    .object({
      script: z.array(
        z.object({
          lang: z.enum(TALK_SCRIPT_LANGS),
          text: z.string().trim(),
        }),
      ),
      betterEn: z.string().trim().nullable(),
      keyWords: z.array(
        z.object({
          en: z.string().trim(),
          ko: z.string().trim(),
        }),
      ),
    })
    .superRefine((d, ctx) => {
      // script — 조각 수·언어 구성
      if (d.script.length < L.scriptMin || d.script.length > L.scriptMax) {
        issue(ctx, ["script"], `script는 ${L.scriptMin}~${L.scriptMax}조각이어야 합니다 (지금 ${d.script.length}개)`);
      }
      if (!d.script.some((p) => p.lang === "ko")) issue(ctx, ["script"], "script에 한국어(ko) 조각이 하나 이상 있어야 합니다");
      if (!d.script.some((p) => p.lang === "en")) {
        issue(ctx, ["script"], "script에 영어(en) 조각이 하나 이상 있어야 합니다 (고른 문장·대답 예시·고친 문장 같은 것)");
      }
      let koTotal = 0;
      d.script.forEach((p, i) => {
        if (p.text === "") {
          issue(ctx, ["script", i, "text"], "빈 조각입니다");
          return;
        }
        if (p.lang === "ko") {
          koTotal += countTalkChars(p.text);
          if (!containsHangul(p.text)) issue(ctx, ["script", i, "text"], "한국어(ko) 조각에는 한글이 있어야 합니다");
          if (containsLatin(p.text)) {
            issue(ctx, ["script", i, "text"], "한국어(ko) 조각에 영어 글자를 넣지 마세요 — 영어는 따로 떼어 en 조각으로 쓰세요");
          }
          if (countTalkChars(p.text) > L.koPieceMaxChars) {
            issue(ctx, ["script", i, "text"], `한국어 조각은 ${L.koPieceMaxChars}자 이하로 짧게 쓰세요`);
          }
        } else {
          if (!containsLatin(p.text)) issue(ctx, ["script", i, "text"], "영어(en) 조각에는 영어가 있어야 합니다");
          if (containsHangul(p.text)) issue(ctx, ["script", i, "text"], "영어(en) 조각에 한글을 넣지 마세요");
          if (countTalkWords(p.text) > L.enPieceMaxWords) {
            issue(ctx, ["script", i, "text"], `영어 조각은 ${L.enPieceMaxWords}단어 이하로 쓰세요`);
          }
        }
      });
      if (koTotal > L.koTotalMaxChars) {
        issue(ctx, ["script"], `한국어 조각의 글자 합은 ${L.koTotalMaxChars}자 이하여야 합니다 (지금 ${koTotal}자) — 20초 안팎으로 짧게`);
      }

      // betterEn — 선생님 문장이면 null, 값이면 영어 한 문장
      if (d.betterEn !== null) {
        if (args.speaker === "teacher") {
          issue(ctx, ["betterEn"], "선생님(teacher)이 한 문장에는 betterEn을 null로 두세요");
        } else {
          if (!containsLatin(d.betterEn)) issue(ctx, ["betterEn"], "betterEn은 영어 문장이어야 합니다 (없으면 null)");
          if (containsHangul(d.betterEn)) issue(ctx, ["betterEn"], "betterEn에 한글을 넣지 마세요");
          if (countTalkWords(d.betterEn) > L.betterEnMaxWords) {
            issue(ctx, ["betterEn"], `betterEn은 ${L.betterEnMaxWords}단어 이하로 쓰세요`);
          }
        }
      }

      // keyWords — 0~3개, 고른 문장 안의 단어만
      if (d.keyWords.length > L.keyWordsMax) {
        issue(ctx, ["keyWords"], `keyWords는 0~${L.keyWordsMax}개여야 합니다 (지금 ${d.keyWords.length}개)`);
      }
      d.keyWords.forEach((k, i) => {
        // en은 "영어 단어"다 — 한글 단어·한글 부분 일치("강아"⊂"강아지")를 문장 안에 있다고 통과시키지 않는다(en-US로 🔊하면 한국어를 영어 음성으로 읽는다)
        if (!containsLatin(k.en) || containsHangul(k.en)) {
          issue(ctx, ["keyWords", i, "en"], "keyWords.en은 영어 단어여야 합니다 (한글을 넣지 마세요)");
        } else if (!isKeyWordInSentence(k.en, args.sentence)) {
          issue(ctx, ["keyWords", i, "en"], "keyWords.en은 고른 문장 안에 실제로 있는 영어 단어여야 합니다 (문장에 없는 단어를 짚지 마세요)");
        }
        if (!containsHangul(k.ko)) issue(ctx, ["keyWords", i, "ko"], "keyWords.ko는 쉬운 우리말 뜻이어야 합니다");
        if (countTalkChars(k.ko) > L.keyWordKoMaxChars) {
          issue(ctx, ["keyWords", i, "ko"], `keyWords.ko는 ${L.keyWordKoMaxChars}자 이하로 쓰세요`);
        }
      });
    });
}

/**
 * scripts/eval-english.ts — 카드 품질 평가 하네스 (docs/harness/english.md §5)
 *
 * 프롬프트를 고칠 때마다 돌리는 자동 점검 (프롬프트도 코드처럼 회귀 테스트).
 * 실행: npm run eval:english  — OPENAI_API_KEY 필요, 실호출 3회 발생. CI가 아니라 수동 실행용.
 *   (Wolves / Pooh / Pooh+장면 메모. EVAL_SKIP_PAGES=1이면 마지막 변형을 건너뛰어 2회)
 * 픽스처 2권(Wolves, Pooh Gets Stuck)의 값은 docs/SPEC.md §12 그대로다. 임의 변경 금지.
 * 호출 A′(page_digest)는 사진이 있어야 재현되므로 실호출 대신 zod 규칙을 고정 입력으로 검사한다.
 *
 * `EVAL_OFFLINE_ONLY=1`이면 실호출 0회로 정의 동기화만 본다. 그 안에 **프롬프트 원문 ↔ 스펙 문서
 * 대조**가 들어 있다 — `lib/ai/english/prompts.ts`의 시스템 프롬프트가 `docs/harness/english.md`의
 * 코드블록과 글자 단위로 같은지 파일을 읽어서 확인한다(`scripts/spec-sync.ts`).
 * 자유대화(§12)는 오프라인 구간에서 프롬프트 원문 13개(§12-6 3개·§12-7 차례 규칙·호출 J 2개 포함, 조립 없는 block-exact)·호출 I와
 * 호출 J JSON Schema(의미 동치)·지시문 조립(교사 + 차례 규칙)·세션 설정(도구·tool_choice 없음)·실시간 스크립트 리듀서(출처 태깅 포함)·
 * 문장 나누기·호출 I zod·호출 J(사용자 메시지·zod·후처리 근거 검사·철 지난 도움)·설명 낭독 대본·§12-6 도구 호출 검사(폐기 예정 —
 * 컨트롤러가 아직 부른다)·말문 막힘 도움 상태 기계·주제 일러스트 장면·단어장 ✓ 매칭을 본다. 호출 I 실호출은 게이트 `EVAL_TALK=1`(2회)뿐이고,
 * 호출 J는 스펙에 실호출 게이트가 없다(오프라인만).
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_TALK_CARDS_MODEL,
  buildCallRequestOptions,
  chapterizeTranscript,
  enrichVocab,
  explainTalkSentence,
  generateCard,
  lookupWordMeaning,
  isKnownTemperatureRejectingModel,
  resolveModel,
  resolveTalkCardsModel,
  talkCardsAbortSignal,
} from "../lib/ai/client";
import {
  CHAPTER_TITLE_GROUP_JOINER,
  CHAPTER_TITLE_MAX,
  CHAPTERIZE_MAX_CHAPTERS,
  CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER,
  CHAPTERIZE_MAX_SENTENCES_TOTAL,
  CHAPTERIZE_TRANSCRIPT_MAX_CHARS,
  ENGLISH_RUN_LIMIT,
  MAX_SCENE_DIGEST_ITEMS,
  SCENE_ASK_KO_MAX,
  SCENE_LABEL_KO_MAX,
  SCENE_SUMMARY_KO_MAX,
  SIGHT_WORD_SET,
  STORY_OUTLINE_MAX_SENTENCES,
  STORY_OUTLINE_MIN_SENTENCES,
  STORY_SOURCE_LABELS_KO,
  STORY_SOURCE_RANK,
  WHOLE_TRANSCRIPT_TITLE,
  WORD_MEANING_JSON_SCHEMA,
  WORD_MEANING_KO_MAX,
  cleanChapterTitles,
  containsHangul,
  countKoreanSentences,
  groundChapters,
  isGroundedInTranscript,
  longestEnglishRun,
  makeChapterizationSchema,
  makeLearningCardSchema,
  makePageDigestSchema,
  prepareChapterTitles,
  resolveAllowedStorySource,
  resolveChapterTitles,
  resolveStorySource,
  storyOutlineSentenceRange,
  stripChapterOrdinalPrefix,
  tokenizeForGrounding,
  truncateTranscriptForChapterize,
  wordMeaningSchema,
  type Chapter,
  type LearningCard,
  type SceneDigestItem,
  type WordMeaning,
} from "../lib/ai/english/schemas";
import {
  CARD_SYSTEM_PROMPT,
  CHAPTERIZE_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_USER_TEXT,
  PAGES_SYSTEM_PROMPT,
  TRANSCRIPT_MAX_CHARS,
  WORD_MEANING_SYSTEM_PROMPT,
  buildCardUserMessage,
  buildChapterizeUserMessage,
  type CardUserMessageInput,
} from "../lib/ai/english/prompts";
// 단어장 정복 V1 (§7) — 오프라인 점검 대상: 판독 프롬프트↔스펙, 병합 순수 함수, zod 제약, 그림 우선순위
import {
  RELATED_SUGGEST_SYSTEM_PROMPT,
  VOCAB_ENRICH_SYSTEM_PROMPT,
  VOCAB_ENRICH_USER_TEXT,
  VOCAB_EXTRACT_SYSTEM_PROMPT,
  VOCAB_EXTRACT_USER_TEXT,
} from "../lib/ai/english/vocabbook-prompts";
import {
  RELATED_SUGGEST_MAX_CANDIDATES,
  RELATED_SUGGESTION_JSON_SCHEMA,
  postprocessRelatedCandidates,
  relatedSuggestionSchema,
  resolveVocabImage,
  vocabEnrichmentSchema,
  vocabExtractionSchema,
  type RelatedCandidate,
  type VocabEnrichItem,
  type VocabEntry,
  type VocabExtractEntry,
  type VocabRelated,
} from "../lib/ai/english/vocabbook-schemas";
import {
  findMissingNumbers,
  mergeVocabPages,
  type VocabPageForMerge,
} from "../lib/ai/english/vocabbook-merge";
// 시험(V4) 보기 생성 순수 함수 — 오프라인 eval이 불변을 잠근다(정답 포함·전부 상이·개수·오답 같은 DAY)
// 관계 문제(V8, 유의어/반의어 연결) buildRelationQuestions — source:"user"만 대상·정답 포함·meaningKo 정확 등을 잠근다
import { buildChoices, buildRelationQuestions, type VocabQuizMode } from "../lib/vocab-quiz";
// 오답노트(V5) 집계·졸업 순수 함수 — 오프라인 eval이 불변을 잠근다(연속 2회 경계·streak 리셋·미시도·시간순)
import {
  MASTERY_STREAK,
  aggregateWordStats,
  isMastered,
  isStatMastered,
} from "../lib/vocab-mastery";
// 복습 리마인드(V6) 선택 순수 함수 — 오프라인 eval이 불변을 잠근다(단조·4+1·중복0·현재DAY제외·필터·콜드스타트)
import {
  buildReviewCandidates,
  rankReviewPools,
  selectReviewSet,
  type ReviewCandidate,
  type ReviewContext,
  type ReviewWordSource,
} from "../lib/vocab-review";
import type { VocabQuizRecord } from "../lib/store";
// 호출 D(보강) 정의 불변 순수 함수 — 오프라인 eval이 잠근다(§8-5)
import {
  buildEnrichRequestItems,
  entriesToEnrich,
  isVocabBookEnriched,
  mergeEnrichment,
} from "../lib/ai/english/vocabbook-enrich";
// 자유대화(§12) — 관문 R 지시문·세션 설정, 실시간 스크립트 리듀서, 호출 I 프롬프트·스키마·zod, 설명 낭독 대본, 스트릭 입력
import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import {
  TALK_CARDS_CALL_OPTIONS,
  TALK_CARDS_LIST_JOINER,
  TALK_CARDS_NONE,
  TALK_CARDS_SDK_MAX_RETRIES,
  TALK_CARDS_SYSTEM_PROMPT,
  TALK_CARDS_TIMEOUT_MS,
  TALK_CARDS_USER_TEMPLATE,
  TALK_CONTEXT_MARK,
  TALK_EXPLAIN_CALL_OPTIONS,
  TALK_EXPLAIN_SYSTEM_PROMPT,
  TALK_EXPLAIN_USER_TEMPLATE,
  TALK_GREETING_INSTRUCTIONS,
  TALK_LESSON_TOPIC,
  TALK_LESSON_WORDS,
  TALK_NUDGE_NOTE,
  TALK_SCENE_CUSTOM_PREFIX,
  TALK_SCENE_IMAGE_PROMPT,
  TALK_SCENE_NOTE,
  TALK_SCENE_VOCAB_WORDS,
  TALK_SCENE_WORDS_JOINER,
  TALK_SCENE_WORDS_PREFIX,
  TALK_TEACHER_INSTRUCTIONS,
  TALK_TURN_RULES,
  TALK_TURN_RULES_JOINER,
  TALK_WRAPUP_INSTRUCTIONS,
  buildTalkCardsUserMessage,
  buildTalkExplainUserMessage,
  buildTalkSceneImagePrompt,
  buildTalkSceneNote,
  fillTalkTemplate,
} from "../lib/ai/english/talk-prompts";
import {
  TALK_EXPLAIN_LIMITS,
  TALK_LIMITS,
  TALK_SAVE_TURN_TEXT_MAX,
  TALK_SCREEN_CARDS_JSON_SCHEMA,
  TALK_SCREEN_CARDS_ZOD_LIMITS,
  TALK_SENTENCE_EXPLANATION_JSON_SCHEMA,
  TALK_TURN_ORIGINS,
  buildTalkExplainZod,
  containsLatin as talkContainsLatin,
  isKeyWordInSentence,
  talkSaveTurnSchema,
  talkScreenCardsSchema,
  type TalkCard,
  type TalkSentenceExplanation,
  type TalkTopic,
  type TalkTurn,
} from "../lib/ai/english/talk-schemas";
import {
  TALK_CARDS_REQUEST_LIMITS,
  TALK_CARD_LIMITS,
  TALK_FALLBACK_HINTS,
  TALK_SCREEN_ANSWER_WORDS,
  buildTalkCardsRequest,
  containsHangulText as talkCardsContainsHangul,
  decideTalkCardsArrival,
  isTalkPictureInLine,
  matchTalkWord,
  pickTalkCardsContext,
  pickTalkCardsShown,
  sanitizeTalkCards,
  sanitizeTalkEmoji,
  sanitizeTalkScreenCards,
} from "../lib/talk-cards";
import {
  TALK_HINT_NUDGE_AFTER_MS,
  TALK_HINT_NUDGE_STREAK_MAX,
  TALK_HINT_SHOW_AFTER_MS,
  createTalkHints,
  reduceTalkHints,
  reduceTalkHintsEvents,
  talkHintEventFromServer,
  talkHintTimings,
  viewTalkHints,
  type TalkHintsEvent,
  type TalkHintsState,
} from "../lib/talk-hints";
import { TALK_IMAGE_COMPRESSION, TALK_IMAGE_COMPRESSION_RETRY, TALK_IMAGE_QUALITY, TALK_IMAGE_SIZE } from "../lib/talk-image";
import {
  TALK_SAVE_KEEPALIVE_MAX_BYTES,
  TALK_SCENE_DATA_URL_MAX,
  planTalkSaveBody,
  talkSaveBodyBytes,
  type TalkCardsRequest,
  type TalkConnectSuccess,
  type TalkSaveRequest,
} from "../lib/talk-contract";
import {
  TALK_CUSTOM_TOPIC_MAX_CHARS,
  TALK_MAX_DURATION_SEC,
  TALK_SPEEDS,
  TALK_TOPIC_PRESETS,
  isTalkSpeed,
  type TalkSpeed,
} from "../lib/talk-topics";
import {
  DEFAULT_TALK_REALTIME_MODEL,
  DEFAULT_TALK_REALTIME_VOICE,
  DEFAULT_TALK_TRANSCRIBE_MODEL,
  TALK_REALTIME_MAX_OUTPUT_TOKENS,
  TALK_SPEED_VALUES,
  TALK_TRANSCRIBE_LANGUAGE,
  buildTalkInstructions,
  buildTalkLesson,
  buildTalkSceneEn,
  buildTalkSessionConfig,
  buildTalkVocabWords,
  cleanTalkCustomTopic,
  isTalkCallId,
  parseTalkCallId,
  resolveCustomTalkTopic,
  resolvePresetTalkTopic,
  resolveVocabTalkTopic,
  type TalkVocabEntryLike,
} from "../lib/talk-session-config";
import {
  TALK_HIDDEN_ITEM_PREFIX,
  buildTalkResponseCreateEvent,
  buildTalkSystemNoteEvent,
  childTurnCount,
  createTalkTranscript,
  isVisibleTalkLine,
  pickTalkSentence,
  reduceTalkTranscript,
  reduceTalkTranscriptEvents,
  requestTalkResponseOrigin,
  splitTalkSentences,
  toTalkTurns,
  type TalkLine,
  type TalkTranscriptState,
} from "../lib/talk-transcript";
import { buildTalkExplainSpeakQueue } from "../lib/talk-explain-script";
import {
  TALK_BARGE_IN_GAP_MS,
  TALK_BARGE_IN_MARGIN_DB,
  TALK_BARGE_IN_MIN_MS,
  TALK_BARGE_IN_MIN_THRESHOLD_DB,
  TALK_BARGE_IN_RECENT_MAX,
  TALK_LEVEL_FRAME_MAX_MS,
  TALK_LEVEL_SILENCE_DB,
  createTalkBargeIn,
  reduceTalkBargeIn,
  reduceTalkBargeInEvents,
  talkBargeInThresholdDb,
  talkLevelFrames,
  talkRmsDbfs,
  updateTalkNoiseFloor,
  type TalkBargeInAction,
  type TalkBargeInState,
} from "../lib/talk-barge-in";
import { TALK_LEVEL_POLL_MS, type TalkLevelMeter } from "../lib/talk-level-meter";
import {
  TALK_AUTO_REPLY_WAIT_MS,
  TALK_TICK_MS,
  TALK_WRAPUP_WAIT_MS,
  TalkCallController,
  type TalkTransport,
  type TalkTransportHandlers,
} from "../lib/talk-realtime";
import type { MicStreamHandle } from "../lib/mic-session";
import { normalizeTalkSessionRecord, normalizeTalkTopic } from "../lib/talk-normalize";
import { isCountedTalkSession, talkStreakLabel, talkStreakSessions } from "../lib/talk-streak";
import { computeStreak } from "../lib/streak";
import { TTS_TEXT_MAX_CHARS } from "../lib/tts-shared";
import {
  checkSpecSync,
  extractSpecBlocks,
  printSpecSyncDetails,
  type SpecSyncOutcome,
  type SpecSyncTarget,
} from "./spec-sync";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다.
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
}

// 비용 게이트 — 2차 방어선(eval-math와 같은 관용구).
// EVAL_OFFLINE_ONLY=1이면 main의 이른 return이 실호출을 막지만, 그 게이트가 뚫리더라도 돈이
// 나가지 않도록 **네트워크 자체를 막는다.** (openai SDK는 전역 fetch를 쓴다 — 지연 생성이라
// 이 시점엔 클라이언트가 아직 없다.) 오프라인 점검 앞에 실호출 코드가 새로 들어오면 여기서 던진다.
if (process.env.EVAL_OFFLINE_ONLY === "1") {
  const blocked = () => {
    throw new Error(
      "EVAL_OFFLINE_ONLY=1 — 네트워크 호출이 차단됐습니다. 오프라인 점검 앞에 실호출 코드가 들어왔습니다.",
    );
  };
  globalThis.fetch = blocked as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// 픽스처 — docs/SPEC.md §12 원문 그대로
// ---------------------------------------------------------------------------

interface Fixture {
  /** 표에 찍히는 이름 — 같은 책의 근거별 변형을 구분한다 */
  label: string;
  title: string;
  author: string;
  series: string;
  isFiction: boolean;
  arLevel: number;
  lexile: number;
  wordCount: number;
  arQuizNo: string;
  topic: string;
  /** 근거 변형 (선택) — 없으면 메타데이터만으로 생성하는 기존 경로 */
  blurbText?: string | null;
  sceneKind?: "toc" | "pages" | null;
  sceneDigest?: SceneDigestItem[] | null;
  /** 유튜브 낭독 자막 근거 변형 (선택) — 있으면 storySource가 transcript(최상위)가 된다 */
  transcript?: string | null;
}

/**
 * 장면 메모 근거 변형(호출 A′ 결과 대역)용 데모 데이터.
 * 실제 사진 판독 결과가 아니라 손으로 쓴 고정 입력이다 — 내용은 §12 픽스처의 주제 한 줄
 * 수준에 머무르고, 원문 전사는 없다. eval이 매번 같은 근거로 pages 경로를 재게 해 준다.
 *
 * **장수는 14장이다.** 이 기능의 기본 시나리오가 그림책 펼침면 12~16장이기 때문이다
 * (SPEC §2 (2′)·§4-2). 예전 4장면 픽스처는 정작 검증하려던 두꺼운 근거 경로를 밟지 못했고,
 * 4장면에 6~8문장을 요구해 모델을 지어내기로 미는 실패를 냈다. 얇은 근거 회귀는
 * `POOH_SCENE_DIGEST_THIN`으로 남겨 뒀다 (EVAL_THIN_PAGES=1).
 *
 * 마지막 장면이 결말 직전에서 끊기는 것도 의도다 — 실제 파이프라인도 마지막 배치에
 * "결말을 쓰지 마라"를 넣어 호출하므로(§2A-2), 카드 호출이 받는 근거의 모양이 이렇다.
 * confidence "medium" 1개와 gapBefore 1개를 섞어 두 표시의 프롬프트 규칙도 함께 태운다.
 */
const POOH_SCENE_DIGEST: SceneDigestItem[] = [
  {
    seq: 1,
    labelKo: "1~2쪽",
    summaryKo: "곰돌이 푸가 아침에 꿀단지를 열어 보니 텅 비어 있어요. 배가 고파 어쩔 줄 몰라요.",
    askKo: "꿀단지가 비었을 때 푸는 어떤 표정일까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 2,
    labelKo: "3~4쪽",
    summaryKo: "푸가 친구 토끼네 집으로 가는 길을 나서요.",
    askKo: "푸는 지금 어디로 가는 길일까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 3,
    labelKo: "5~6쪽",
    summaryKo: "토끼네 집 앞에 도착한 푸가 문 구멍에 대고 인사를 건네요.",
    askKo: "토끼는 문 안에서 뭐라고 대답할까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 4,
    labelKo: "7~8쪽",
    summaryKo: "토끼가 푸를 안으로 들여 식탁 앞에 앉혀요.",
    askKo: "토끼는 푸에게 무엇을 내줄 것 같아?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 5,
    labelKo: "9~10쪽",
    summaryKo: "토끼가 꺼내 준 꿀을 푸가 한 단지 다 비워요.",
    askKo: "푸는 지금 기분이 어떨까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 6,
    labelKo: "11~12쪽",
    summaryKo: "푸가 한 단지만 더 달라고 부탁해요.",
    askKo: "너라면 한 그릇 더 달라고 할 때 뭐라고 말할까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 7,
    labelKo: "13~14쪽",
    summaryKo: "푸가 멈추지 못하고 단지를 계속 비워요.",
    askKo: "푸는 왜 그만 먹지 못할까?",
    confidence: "medium",
    gapBefore: false,
  },
  {
    seq: 8,
    labelKo: "15~16쪽",
    summaryKo: "토끼가 이제 남은 꿀이 없다고 말해요.",
    askKo: "토끼는 지금 어떤 마음일까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 9,
    labelKo: "17~18쪽",
    summaryKo: "배가 빵빵해진 푸가 이제 집에 가겠다며 자리에서 일어나요.",
    askKo: "푸의 배는 들어올 때와 무엇이 달라졌을까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 10,
    labelKo: "19~20쪽",
    summaryKo: "푸가 나가려고 문 구멍으로 몸을 밀어 넣어요.",
    askKo: "푸는 그 구멍으로 무사히 나갈 수 있을까?",
    confidence: "high",
    gapBefore: true,
  },
  {
    seq: 11,
    labelKo: "21~22쪽",
    summaryKo: "푸의 몸이 구멍 한가운데에서 꽉 껴 버려요.",
    askKo: "푸는 지금 앞으로도 뒤로도 못 가는데 어떤 기분일까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 12,
    labelKo: "23~24쪽",
    summaryKo: "토끼가 뒤에서 밀어 보지만 푸는 그대로예요.",
    askKo: "밀어서 안 되면 이번엔 어떻게 해 볼까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 13,
    labelKo: "25~26쪽",
    summaryKo: "토끼가 밖으로 나가 친구들을 불러 모아요.",
    askKo: "친구들이 오면 무엇부터 해 볼 것 같아?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 14,
    labelKo: "27~28쪽",
    summaryKo: "친구들이 줄지어 서서 푸를 당겨 보지만 꼼짝도 하지 않아요.",
    askKo: "너라면 푸를 어떻게 꺼내 줄 것 같아?",
    confidence: "high",
    gapBefore: false,
  },
];

/**
 * 얇은 근거 회귀 케이스 (4장면). 기본 실행에는 들어가지 않는다 — 실호출을 늘리지 않으려고
 * 3번째 호출의 장면 데이터만 바꿔 끼우는 방식이다(EVAL_THIN_PAGES=1).
 * 지키려는 것: 근거가 얇으면 분량 구간도 함께 짧아져, 모델이 부풀리지 않아도 통과한다.
 */
const POOH_SCENE_DIGEST_THIN: SceneDigestItem[] = [
  {
    seq: 1,
    labelKo: "1~2쪽",
    summaryKo: "곰돌이 푸가 배가 고파 친구 토끼네 집으로 향해요.",
    askKo: "푸는 지금 어디로 가는 길일까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 2,
    labelKo: "3~4쪽",
    summaryKo: "토끼가 꺼내 준 꿀을 푸가 멈추지 못하고 계속 먹어요.",
    askKo: "푸는 왜 그만 먹지 못할까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 3,
    labelKo: "5~6쪽",
    summaryKo: "배가 빵빵해진 푸가 집에 가려다 문 구멍에 몸이 꽉 껴요.",
    askKo: "들어올 때와 무엇이 달라졌을까?",
    confidence: "high",
    gapBefore: false,
  },
  {
    seq: 4,
    labelKo: "7~8쪽",
    summaryKo: "친구들이 모여 밀고 당겨 보지만 푸는 꼼짝도 하지 않아요.",
    askKo: "너라면 푸를 어떻게 꺼내 줄 것 같아?",
    confidence: "medium",
    gapBefore: false,
  },
];

/** EVAL_THIN_PAGES=1이면 얇은 근거(4장면)로 3번째 호출을 돌린다 — 실호출 수는 그대로 3회 */
const USE_THIN_PAGES = process.env.EVAL_THIN_PAGES === "1";
const ACTIVE_SCENE_DIGEST = USE_THIN_PAGES ? POOH_SCENE_DIGEST_THIN : POOH_SCENE_DIGEST;

const FIXTURES: Fixture[] = [
  {
    label: "Wolves",
    title: "Wolves",
    author: "Laura Marsh",
    series: "National Geographic Kids Readers, Level 2",
    isFiction: false,
    arLevel: 3.3,
    lexile: 570,
    wordCount: 864,
    arQuizNo: "148832",
    topic: "늑대 — 무리(pack) 생활, 하울링, 사냥, 새끼 키우기",
  },
  {
    label: "Pooh Gets Stuck",
    title: "Pooh Gets Stuck",
    author: "Isabel Gaines",
    series: "A Winnie the Pooh First Reader",
    isFiction: true,
    arLevel: 2.0,
    lexile: 430,
    wordCount: 551,
    arQuizNo: "41866",
    topic: "푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동",
  },
  {
    // 같은 책 + 장면 메모 근거 → storySource "pages"·장면 수에서 계산한 분량 경로를 재는 변형.
    // 실호출 1회가 추가된다 (총 3회). 비용을 아끼려면 EVAL_SKIP_PAGES=1로 건너뛴다.
    label: `Pooh (장면 ${ACTIVE_SCENE_DIGEST.length})`,
    title: "Pooh Gets Stuck",
    author: "Isabel Gaines",
    series: "A Winnie the Pooh First Reader",
    isFiction: true,
    arLevel: 2.0,
    lexile: 430,
    wordCount: 551,
    arQuizNo: "41866",
    topic: "푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동",
    sceneKind: "pages",
    sceneDigest: ACTIVE_SCENE_DIGEST,
  },
];

/**
 * 낭독 자막 근거 변형용 데모 자막 — 실제 유튜브 자막이 아니라 손으로 쓴 고정 입력이다.
 * 일부러 앞뒤에 **채널·낭독자 인트로/아웃트로 노이즈**를 넣었다: transcript grounding이
 * (a) 이 노이즈를 줄거리로 오인하지 않고 (b) 자막 본문 안에서만 단어·질문·줄거리를 뽑는지를
 * 실호출 게이트가 검사한다. 노이즈의 고유 문구는 `TRANSCRIPT_NOISE_TOKENS`로 잡는다.
 * 본문은 §12 Pooh 픽스처의 줄거리를 짧은 영어로 풀어 쓴 것으로, 원문 전사는 없다.
 */
const POOH_TRANSCRIPT = `Hello everyone, and welcome back to Storytime Land! I'm Ms. Robin, and today we are reading Pooh Gets Stuck. If you love our stories, please like and subscribe so you never miss a video. Okay, let's begin!

One sunny morning, Winnie the Pooh felt very hungry. He walked over to Rabbit's house to say hello. Rabbit was kind and gave Pooh some honey. Pooh loved honey so much that he ate and ate and ate. He ate every last pot of honey until his tummy was round and full.

When it was time to go home, Pooh tried to climb out through Rabbit's front door. But he had eaten too much! Pooh was stuck in the hole. He could not move forward, and he could not move back. "Oh bother," said Pooh.

Rabbit pushed and pushed, but Pooh would not budge. Rabbit called his friends. Christopher Robin came, and so did all the others. They decided that Pooh must wait until he grew thin again. So they waited, and they read him stories, and they kept him company.

After many days, Pooh finally became thin enough. Everyone pulled together, and out popped Pooh! He was so happy to be free at last.

And that is the end of our story. Thank you so much for watching Storytime Land! Don't forget to like and subscribe, and we'll see you next time. Bye bye, friends!`;

/** 낭독 자막의 채널·낭독자 노이즈 고유 문구 — 줄거리에 이 문구가 새어 들어가면 인트로를 줄거리로 오인한 것이다 */
const TRANSCRIPT_NOISE_TOKENS = ["Storytime Land", "Ms. Robin", "subscribe", "Bye bye"];

/**
 * 낭독 자막 실호출 게이트용 픽스처(EVAL_TRANSCRIPT=1) — Pooh 본문 + 채널 노이즈 자막.
 * 항상 도는 FIXTURES에 넣지 않는다: 실호출 3회를 늘리지 않기 위해서다(§5, 기본 3회 유지).
 */
const TRANSCRIPT_FIXTURE: Fixture = {
  label: "Pooh (낭독 자막)",
  title: "Pooh Gets Stuck",
  author: "Isabel Gaines",
  series: "A Winnie the Pooh First Reader",
  isFiction: true,
  arLevel: 2.0,
  lexile: 430,
  wordCount: 551,
  arQuizNo: "41866",
  topic: "푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동",
  transcript: POOH_TRANSCRIPT,
};

// ---------------------------------------------------------------------------
// 점검 항목 (HARNESS §5) — 5개 전부
// ---------------------------------------------------------------------------

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasHangul(text: string): boolean {
  return /[가-힣]/.test(text);
}

function runChecks(fixture: Fixture, card: LearningCard): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    results.push({ book: fixture.label, check, pass, detail });

  // 1. §4의 zod 추가 검증 전부 통과
  const allowedStorySource = resolveAllowedStorySource(fixture);
  const zodResult = makeLearningCardSchema({
    arLevel: fixture.arLevel,
    isFiction: fixture.isFiction,
    allowedStorySource,
  }).safeParse(card);
  add(
    "1. zod 추가 검증(§4) 전부 통과",
    zodResult.success,
    zodResult.success
      ? `vocab ${card.vocab.length} / questions ${card.questions.length} / funFacts ${card.funFacts?.length ?? "null"}`
      : zodResult.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; "),
  );

  // 2. 사이트워드 차단 목록에 걸리는 단어 0개 (소문자 비교, schemas.ts와 동일 상수)
  const bannedHits = card.vocab
    .map((v) => v.word)
    .filter((w) => SIGHT_WORD_SET.has(w.trim().toLowerCase()));
  add(
    "2. 사이트워드 0개",
    bannedHits.length === 0,
    bannedHits.length === 0 ? "차단 목록 위반 없음" : `위반: ${bannedHits.join(", ")}`,
  );

  // 3. 영어 질문 15단어 이하, exampleEn 8단어 이하
  const longQuestions = card.questions.filter((q) => countWords(q.en) > 15);
  const longExamples = card.vocab.filter((v) => countWords(v.exampleEn) > 8);
  add(
    "3. 질문 en ≤15단어 · exampleEn ≤8단어",
    longQuestions.length === 0 && longExamples.length === 0,
    [
      longQuestions.length > 0
        ? `초과 질문: ${longQuestions.map((q) => `"${q.en}" (${countWords(q.en)}단어)`).join(", ")}`
        : null,
      longExamples.length > 0
        ? `초과 예문: ${longExamples.map((v) => `"${v.exampleEn}" (${countWords(v.exampleEn)}단어)`).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" / ") || "전부 한도 이내",
  );

  // 4. hintKo 보유율 30~70%
  const hintCount = card.questions.filter(
    (q) => q.hintKo !== null && q.hintKo !== undefined && q.hintKo.trim() !== "",
  ).length;
  const hintRatio = card.questions.length > 0 ? hintCount / card.questions.length : 0;
  add(
    "4. hintKo 보유율 30~70%",
    hintRatio >= 0.3 && hintRatio <= 0.7,
    `${hintCount}/${card.questions.length} = ${(hintRatio * 100).toFixed(0)}%`,
  );

  // 5. 질문의 en/ko 짝이 모두 채워져 있고, ko에 영어 문장이 그대로 남아있지 않음
  const brokenPairs = card.questions.filter(
    (q) =>
      q.en.trim() === "" ||
      q.ko.trim() === "" ||
      !hasHangul(q.ko) ||
      q.ko.includes(q.en.trim()),
  );
  add(
    "5. en/ko 짝 채움 · ko에 영어 잔존 없음",
    brokenPairs.length === 0,
    brokenPairs.length === 0
      ? "전 질문 정상"
      : `문제 질문: ${brokenPairs.map((q) => `[${q.type}] en="${q.en}" ko="${q.ko}"`).join(" / ")}`,
  );

  // 6. storySource가 넘긴 근거를 넘지 않음. 낮춰 적기는 프롬프트가 명시적으로 허용하므로
  //    통과시킨다(등호 비교 금지 — zod의 랭크 규칙과 같은 기준을 써야 4중 정의가 맞는다).
  //    근거를 하나도 안 넘긴 픽스처는 상한이 "metadata"라 사실상 등호로 조여진다.
  const withinEvidence =
    STORY_SOURCE_RANK[card.storySource] <= STORY_SOURCE_RANK[allowedStorySource];
  const downgraded = STORY_SOURCE_RANK[card.storySource] < STORY_SOURCE_RANK[allowedStorySource];
  add(
    "6. storySource가 넘긴 근거 이내 (낮춰 적기 허용)",
    withinEvidence,
    withinEvidence
      ? `storySource=${card.storySource} (허용 상한 ${allowedStorySource})` +
        (downgraded ? " — 근거를 받고도 도움이 안 된다고 낮춰 적음(허용)" : "")
      : `storySource=${card.storySource} · 이 호출에 준 근거의 상한은 ${allowedStorySource} — 없는 근거를 주장했다`,
  );

  // 7. storyOutlineKo 분량이 근거의 '양'에서 계산한 구간에 맞는지.
  //    구간은 프롬프트가 [줄거리 분량] 블록에 박아 보낸 것과 같은 함수로 뽑는다 — 종류만 보는
  //    평평한 구간이면 4장면짜리 얇은 근거에도 두꺼운 근거와 같은 분량을 요구하게 된다.
  //    카드가 storySource를 낮춰 적었으면 낮춘 근거의 구간으로 잰다 (프롬프트도 그렇게 지시한다).
  const sceneCount = fixture.sceneDigest?.length ?? 0;
  const [minSentences, maxSentences] = storyOutlineSentenceRange(card.storySource, sceneCount);
  const sentenceCount = countKoreanSentences(card.storyOutlineKo);
  add(
    `7. storyOutlineKo 분량 ${minSentences}~${maxSentences}문장 (${card.storySource}, 장면 ${sceneCount})`,
    sentenceCount >= minSentences && sentenceCount <= maxSentences,
    `${sentenceCount}문장`,
  );

  // 8. storyOutlineKo가 우리말 요약인지 — 영어 원문 전사 금지 (SPEC §1 개정 원칙)
  const outlineRun = longestEnglishRun(card.storyOutlineKo);
  add(
    "8. storyOutlineKo에 영어 원문 전사 없음",
    outlineRun < ENGLISH_RUN_LIMIT && /[가-힣]/.test(card.storyOutlineKo),
    `연속 영어 최대 ${outlineRun}단어 (한도 ${ENGLISH_RUN_LIMIT})`,
  );

  // 9. 배지 해석 — 신규 카드는 storySource가 그대로 배지로 이어진다 (하위 호환 헬퍼 동작 확인)
  const badgeSource = resolveStorySource(card);
  add(
    "9. resolveStorySource가 배지값을 돌려줌",
    badgeSource === card.storySource,
    `배지 근거=${badgeSource ?? "없음"}`,
  );

  return results;
}

// ---------------------------------------------------------------------------
// 오프라인 점검 — 호출 A′(page_digest) zod 규칙. 실호출 0회.
// 실제 판독은 사진이 필요해 eval에서 재현할 수 없으므로, 스키마가 실패 모드를
// 실제로 잡아내는지를 고정 입력으로 검사한다 (지어내기·원문 전사·askKo 누락·장수 불일치).
// ---------------------------------------------------------------------------

function runPageDigestChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    results.push({ book: "호출 A′ 스키마", check, pass, detail });

  const scene = (over: Partial<SceneDigestItem> = {}): SceneDigestItem => ({
    seq: 1,
    labelKo: "1~2쪽",
    summaryKo: "푸가 토끼네 집에서 꿀을 먹고 있어요.",
    askKo: "푸는 왜 그만 먹지 못할까?",
    confidence: "high",
    gapBefore: false,
    ...over,
  });

  const cases: Array<{
    name: string;
    shouldPass: boolean;
    input: unknown;
    imageCount: number;
    /** 이 배치를 요청한 모드 — 생략하면 pages */
    mode?: "toc" | "pages";
  }> = [
    {
      name: "정상 2장 → 장면 2개",
      shouldPass: true,
      imageCount: 2,
      input: { sourceKind: "pages", scenes: [scene(), scene({ seq: 2, labelKo: "3~4쪽" })] },
    },
    {
      name: "사진 2장인데 장면 1개 → 거부",
      shouldPass: false,
      imageCount: 2,
      input: { sourceKind: "pages", scenes: [scene()] },
    },
    {
      name: "askKo 누락(confidence high) → 거부",
      shouldPass: false,
      imageCount: 1,
      input: { sourceKind: "pages", scenes: [scene({ askKo: null })] },
    },
    {
      name: "askKo 누락(confidence low) → 허용",
      shouldPass: true,
      imageCount: 1,
      input: { sourceKind: "pages", scenes: [scene({ askKo: null, confidence: "low" })] },
    },
    {
      name: "영어 원문 전사 요약(한글 없음) → 거부",
      shouldPass: false,
      imageCount: 1,
      input: {
        sourceKind: "pages",
        scenes: [
          scene({
            summaryKo: "Pooh ate too much honey and got stuck in the door of the house.",
          }),
        ],
      },
    },
    {
      // 한글이 섞여 있어 "우리말 요약" 규칙은 통과하지만, 영어 8단어 연속이라
      // ENGLISH_RUN_LIMIT 규칙이 단독으로 걸려야 한다 (규칙이 서로 가리지 않는지 확인)
      name: `한글+영어 ${ENGLISH_RUN_LIMIT}단어 연속 혼합 → 거부`,
      shouldPass: false,
      imageCount: 1,
      input: {
        sourceKind: "pages",
        scenes: [
          scene({
            summaryKo:
              "푸가 이렇게 말해요. Pooh ate too much honey and got stuck 그리고 꼼짝 못 해요.",
          }),
        ],
      },
    },
    {
      name: "seq 역순 → 거부",
      shouldPass: false,
      imageCount: 2,
      input: { sourceKind: "pages", scenes: [scene({ seq: 2 }), scene({ seq: 1 })] },
    },
    // 생산자·소비자 길이 상한 대칭 (QA F12) — 생산 시점에 걸어야 재요청으로 교정된다
    {
      name: `labelKo ${SCENE_LABEL_KO_MAX + 1}자 → 거부`,
      shouldPass: false,
      imageCount: 1,
      input: { sourceKind: "pages", scenes: [scene({ labelKo: "쪽".repeat(SCENE_LABEL_KO_MAX + 1) })] },
    },
    {
      name: `summaryKo ${SCENE_SUMMARY_KO_MAX + 1}자 → 거부`,
      shouldPass: false,
      imageCount: 1,
      input: {
        sourceKind: "pages",
        scenes: [scene({ summaryKo: "푸".repeat(SCENE_SUMMARY_KO_MAX + 1) })],
      },
    },
    {
      name: `askKo ${SCENE_ASK_KO_MAX + 1}자 → 거부`,
      shouldPass: false,
      imageCount: 1,
      input: { sourceKind: "pages", scenes: [scene({ askKo: "왜".repeat(SCENE_ASK_KO_MAX + 1) })] },
    },
    {
      name: `toc 장면 ${MAX_SCENE_DIGEST_ITEMS + 1}개 → 거부`,
      shouldPass: false,
      imageCount: 1,
      mode: "toc",
      input: {
        sourceKind: "toc",
        scenes: Array.from({ length: MAX_SCENE_DIGEST_ITEMS + 1 }, (_, i) =>
          scene({ seq: i + 1, labelKo: `${i + 1}장` }),
        ),
      },
    },
    {
      name: `toc 장면 ${MAX_SCENE_DIGEST_ITEMS}개(상한 경계) → 허용`,
      shouldPass: true,
      imageCount: 1,
      mode: "toc",
      input: {
        sourceKind: "toc",
        scenes: Array.from({ length: MAX_SCENE_DIGEST_ITEMS }, (_, i) =>
          scene({ seq: i + 1, labelKo: `${i + 1}장` }),
        ),
      },
    },
    {
      name: "sourceKind 불일치(toc 응답) → 거부",
      shouldPass: false,
      imageCount: 1,
      input: { sourceKind: "toc", scenes: [scene()] },
    },
  ];

  for (const testCase of cases) {
    const parsed = makePageDigestSchema({
      sourceKind: testCase.mode ?? "pages",
      imageCount: testCase.imageCount,
    }).safeParse(testCase.input);
    const pass = parsed.success === testCase.shouldPass;
    add(
      `A′. ${testCase.name}`,
      pass,
      parsed.success
        ? "통과"
        : parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; "),
    );
  }

  // 구(舊) 카드 하위 호환 — storyIsGuess만 가진 카드의 배지 해석
  const legacyGuess = resolveStorySource({ storyIsGuess: true });
  const legacyKnown = resolveStorySource({ storyIsGuess: false });
  add(
    "A′. 구 카드 storyIsGuess=true → metadata(예상 배지)",
    legacyGuess === "metadata",
    `결과 ${legacyGuess ?? "없음"}`,
  );
  add(
    "A′. 구 카드 storyIsGuess=false → 배지 없음(구 UI와 동일)",
    legacyKnown === null,
    `결과 ${legacyKnown ?? "없음"}`,
  );

  return results;
}

// ---------------------------------------------------------------------------
// 오프라인 점검 — 줄거리 분량 다이얼. 실호출 0회.
// 다이얼이 '근거의 양에 비례'라는 원칙을 실제로 지키는지, 그리고 프롬프트에 박혀 나가는
// 구간과 점검 7이 재는 구간이 같은 함수에서 나오는지(4중 정의 동기화)를 고정 입력으로 검사한다.
// ---------------------------------------------------------------------------

function runStoryLengthDialChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    results.push({ book: "분량 다이얼", check, pass, detail });

  // 근거 단위를 셀 수 없는 두 출처는 고정 구간을 유지한다 (이번 튜닝의 비변경 지점)
  const metadataRange = storyOutlineSentenceRange("metadata");
  const blurbRange = storyOutlineSentenceRange("blurb");
  add(
    "다이얼. metadata 3~4 · blurb 4~6 고정 유지",
    metadataRange[0] === 3 && metadataRange[1] === 4 && blurbRange[0] === 4 && blurbRange[1] === 6,
    `metadata ${metadataRange.join("~")} / blurb ${blurbRange.join("~")}`,
  );

  // 얇은 근거(4장면)가 부풀리지 않고도 통과하는가 — 이번 실패의 직접 원인
  const thin = storyOutlineSentenceRange("pages", 4);
  add(
    "다이얼. 4장면 근거의 구간이 5문장을 품는다 (실패 사례 재현)",
    thin[0] <= 5 && thin[1] >= 5,
    `4장면 → ${thin.join("~")}문장 (관측된 5문장: ${thin[0] <= 5 && thin[1] >= 5 ? "통과" : "실패"})`,
  );

  // 두꺼운 근거(기본 시나리오 12~16장면)는 예전 평평한 하한 6문장보다 길어야 한다 —
  // "맥락 파악이 어렵다"는 원래 불만이 이 구간에서 해소된다
  const thick12 = storyOutlineSentenceRange("pages", 12);
  const thick16 = storyOutlineSentenceRange("pages", 16);
  add(
    "다이얼. 12·16장면 근거의 하한이 7문장 이상",
    thick12[0] >= 7 && thick16[0] >= 7,
    `12장면 → ${thick12.join("~")} / 16장면 → ${thick16.join("~")}문장`,
  );

  // 구조적 불변식 — 장면 수를 훑으며 한 번에 검사한다
  let boundsOk = true;
  let monotonicOk = true;
  let noForcedPaddingOk = true;
  let prev = storyOutlineSentenceRange("pages", 0);
  for (let n = 0; n <= 120; n += 1) {
    const [min, max] = storyOutlineSentenceRange("pages", n);
    if (
      min < STORY_OUTLINE_MIN_SENTENCES ||
      max > STORY_OUTLINE_MAX_SENTENCES ||
      min > max
    ) {
      boundsOk = false;
    }
    if (min < prev[0] || max < prev[1]) monotonicOk = false;
    // 장면마다 한 문장 + 훅 1문장을 넘는 하한은 구조적으로 지어내기를 강요한다.
    // 절대 하한(3문장)은 메타데이터만으로도 쓸 수 있는 최소 맥락이라 예외로 둔다.
    if (min > Math.max(STORY_OUTLINE_MIN_SENTENCES, n + 1)) noForcedPaddingOk = false;
    prev = [min, max];
  }
  add(
    `다이얼. 전 구간 ${STORY_OUTLINE_MIN_SENTENCES}~${STORY_OUTLINE_MAX_SENTENCES}문장 경계 · min ≤ max`,
    boundsOk,
    boundsOk ? "장면 0~120개 전부 경계 안" : "경계를 벗어나는 장면 수가 있다",
  );
  add(
    "다이얼. 장면이 늘면 구간이 줄지 않음 (단조)",
    monotonicOk,
    monotonicOk ? "장면 0~120개 단조 증가" : "장면이 느는데 구간이 줄어드는 지점이 있다",
  );
  add(
    "다이얼. 하한이 '장면 수 + 1'을 넘지 않음 (지어내기 강요 금지)",
    noForcedPaddingOk,
    noForcedPaddingOk ? "전 구간 근거 이내" : "근거보다 많은 문장을 요구하는 장면 수가 있다",
  );

  // 4중 정의 동기화 — 프롬프트가 실제로 박아 보내는 문자열과 점검 7의 구간이 같은가.
  // 두 곳이 어긋나면 모델은 지시를 지켰는데 eval이 떨어뜨린다 (이번 실패의 일반형).
  for (const fixture of FIXTURES) {
    const message = buildCardUserMessage(toCardInput(fixture));
    const allowed = resolveAllowedStorySource(fixture);
    const [min, max] = storyOutlineSentenceRange(allowed, fixture.sceneDigest?.length ?? 0);
    const expected = `${min}~${max}문장`;
    const hasBlock = message.includes("[줄거리 분량]");
    add(
      `동기화. ${fixture.label}: 프롬프트가 "${expected}"을 지시`,
      hasBlock && message.includes(expected),
      hasBlock
        ? message.includes(expected)
          ? `[줄거리 분량] 블록에 ${expected} (근거 ${allowed})`
          : `블록에 ${expected}이 없다 — 프롬프트와 점검 7이 어긋난다`
        : "[줄거리 분량] 블록 자체가 없다",
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// 오프라인 점검 — 낭독 자막(transcript) grounding 계약. 실호출 0회.
// 자막이 최상위 근거 티어로 다뤄지는지, 분량이 다이얼 상한인지, 근거 없이 transcript를 주장하면
// 거부되는지, 배지가 "낭독 확인"인지, buildCardUserMessage가 자막을 슬롯에 넣고 상한 초과 시
// 앞부분 우선으로 자르는지를 고정 입력으로 잠근다(§5). 자막 grounding의 '자막 밖 창작 금지'는
// 모델 출력이 있어야 재현되므로 실호출 게이트(EVAL_TRANSCRIPT=1)가 별도로 본다.
// ---------------------------------------------------------------------------

function runTranscriptOfflineChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    results.push({ book: "낭독 자막", check, pass, detail });

  // 1. resolveAllowedStorySource가 자막을 최상위 티어로 잡는다 — 장면 메모가 함께 와도 transcript다
  const allowedTranscriptOnly = resolveAllowedStorySource({ transcript: POOH_TRANSCRIPT });
  const allowedWithScenes = resolveAllowedStorySource({
    transcript: POOH_TRANSCRIPT,
    sceneKind: "pages",
    sceneDigest: ACTIVE_SCENE_DIGEST,
  });
  add(
    "transcript. resolveAllowedStorySource가 자막을 transcript(최상위)로 잡음",
    allowedTranscriptOnly === "transcript" && allowedWithScenes === "transcript",
    `자막만=${allowedTranscriptOnly} / 자막+장면=${allowedWithScenes}`,
  );

  // 2. 빈/공백 자막은 티어를 올리지 않는다 (blurb·장면 등 아래 근거 규칙 유지)
  const emptyTranscript = resolveAllowedStorySource({ transcript: "   " });
  add(
    "transcript. 빈 자막은 티어를 올리지 않음",
    emptyTranscript === "metadata",
    `결과 ${emptyTranscript}`,
  );

  // 3. 분량 다이얼이 상한(8~10문장)이다 — 책 전체 텍스트라 다이얼 top (§3-1 표)
  const range = storyOutlineSentenceRange("transcript");
  add(
    "transcript. 분량 다이얼이 8~10문장(다이얼 상한)",
    range[0] === 8 && range[1] === 10,
    `${range.join("~")}문장`,
  );

  // 4. 근거 없이 transcript를 주장하면 zod가 거부한다 (랭크 초과 — 없는 근거 주장 금지)
  const overclaimCard = { ...makeTranscriptStubCard(), storySource: "transcript" as const };
  const overclaimResult = makeLearningCardSchema({
    arLevel: 2.0,
    isFiction: true,
    allowedStorySource: "metadata", // 자막을 안 넘긴 호출
  }).safeParse(overclaimCard);
  const overclaimRejected =
    !overclaimResult.success &&
    overclaimResult.error.issues.some((i) => i.path.includes("storySource"));
  add(
    "transcript. 근거 없이 transcript 주장 → zod 거부(랭크 초과)",
    overclaimRejected,
    overclaimRejected ? "거부됨" : "거부되지 않음(랭크 규칙 누락)",
  );

  // 5. 자막을 넘긴 호출은 transcript 주장을 허용한다 (랭크 이내)
  const okCard = { ...makeTranscriptStubCard(), storySource: "transcript" as const };
  const okResult = makeLearningCardSchema({
    arLevel: 2.0,
    isFiction: true,
    allowedStorySource: "transcript",
  }).safeParse(okCard);
  add(
    "transcript. 자막 넘긴 호출은 transcript 주장 허용",
    okResult.success,
    okResult.success
      ? "통과"
      : okResult.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; "),
  );

  // 6. 배지 — transcript 카드는 "낭독 확인"으로 해석된다 (실제 근거 기반, "예상" 아님)
  const badge = resolveStorySource({ storySource: "transcript" });
  add(
    "transcript. 배지 해석 = 낭독 확인",
    badge === "transcript" && STORY_SOURCE_LABELS_KO.transcript === "낭독 확인",
    `배지 근거=${badge ?? "없음"} · 문구="${STORY_SOURCE_LABELS_KO.transcript}"`,
  );

  // 7. buildCardUserMessage가 자막을 [유튜브 낭독 자막] 슬롯에 넣고 [줄거리 분량]에 8~10문장을 박는다
  const message = buildCardUserMessage(toCardInput(TRANSCRIPT_FIXTURE));
  const hasSlot = message.includes("[유튜브 낭독 자막]");
  const hasContent = message.includes("Pooh loved honey");
  const hasRange = message.includes("8~10문장");
  add(
    "transcript. 자막 슬롯 렌더 + [줄거리 분량] 8~10문장 지시",
    hasSlot && hasContent && hasRange,
    `슬롯=${hasSlot} 자막본문=${hasContent} 8~10문장=${hasRange}`,
  );

  // 8. 상한 초과 자막은 앞부분 우선으로 잘린다 (카드는 요약이라 앞부분이 중요, §3-2)
  const longHead = "A".repeat(TRANSCRIPT_MAX_CHARS);
  const longTail = "ZZZTAILMARKER end of the very long transcript.";
  const longMessage = buildCardUserMessage(
    toCardInput({ ...TRANSCRIPT_FIXTURE, transcript: `${longHead}\n${longTail}` }),
  );
  const keptHead = longMessage.includes("AAAA");
  const droppedTail = !longMessage.includes("ZZZTAILMARKER");
  const markedTruncated = longMessage.includes("앞부분까지만");
  add(
    "transcript. 상한 초과 시 앞부분 유지·뒷부분 절단·절단 표시",
    keptHead && droppedTail && markedTruncated,
    `앞부분유지=${keptHead} 뒷부분절단=${droppedTail} 절단표시=${markedTruncated}`,
  );

  return results;
}

/** 랭크 규칙만 재는 최소 스텁 카드 — 다른 zod 제약(개수 등)은 이미 통과하도록 채운다(§4) */
function makeTranscriptStubCard(): LearningCard {
  const vocab = Array.from({ length: 12 }, (_, i) => ({
    word: `word${i}`,
    pronKo: "워드",
    meaningKo: "뜻",
    easyEn: "a thing",
    exampleEn: `I see word${i} here.`,
    difficulty: "basic" as const,
    isCore: i === 0 ? true : null,
  }));
  const questionTypes = [
    "인물", "사건", "인과", "감정", "예측", "결말", "나와연결", "배경",
  ] as const;
  const questions = questionTypes.map((type, i) => ({
    type,
    en: "What happens next in the story here?",
    ko: "다음에 무슨 일이 일어날까?",
    hintKo: i < 4 ? "힌트" : null,
  }));
  return {
    bookIntroKo: "재미있는 이야기예요. 함께 읽어요.",
    levelNoteKo: "AR 2.0은 미국 2학년 수준이에요.",
    storyOutlineKo: "푸가 꿀을 많이 먹어요. 그러다 구멍에 껴요. 친구들이 도와줘요.",
    storySource: "transcript",
    beforeReading: [{ ko: "표지를 봐요" }, { ko: "배경을 떠올려요" }],
    vocab,
    teachingTipKo: "복수형을 알려줘요.",
    whileReading: [{ ko: "동작 미션1" }, { ko: "동작 미션2" }, { ko: "동작 미션3" }],
    questions,
    funFacts: null,
    activities: [
      { titleKo: "놀이1", descKo: "몸으로 놀아요. 재밌게 해요." },
      { titleKo: "놀이2", descKo: "생활에 연결해요. 함께 해요." },
    ],
  };
}

// ---------------------------------------------------------------------------
// 오프라인 점검 — 단어장 정복 V1(§7). 실호출 0회.
// 여기가 이 기능 eval 가치의 대부분이다: 실사진 판독은 사진이 있어야 재현되므로(§5·§7-6)
// eval이 커버하지 않고, 대신 병합 순수 함수·zod 제약·그림 우선순위를 고정 입력으로 잠근다.
// ---------------------------------------------------------------------------

function runVocabbookChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    results.push({ book: "단어장 §7", check, pass, detail });

  const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
    e.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");

  // 판독 항목 픽스처 — 필요한 필드만 덮어쓴다 (호출 A′ scene() 헬퍼와 같은 관용구)
  const entry = (over: Partial<VocabExtractEntry> = {}): VocabExtractEntry => ({
    no: "0001",
    word: "pack",
    ipa: "pæk",
    pos: ["명"],
    meanings: [{ no: null, ko: "무리, 떼", related: [] }],
    examples: [{ en: "A pack of wolves.", ko: "늑대 한 무리." }],
    related: [],
    partial: false,
    confidence: "high",
    ...over,
  });

  // 관련어 픽스처 — 교재 판독분(source:"book", linked* null). 세 필드가 required라 타입 채우기용 헬퍼로 짧게 쓴다.
  const rel = (kind: VocabRelated["kind"], word: string, glossKo: string | null): VocabRelated => ({
    kind,
    word,
    glossKo,
    source: "book",
    linkedNo: null,
    linkedMeaningIndex: null,
  });

  // --- 병합 1: 겹쳐 찍기(같은 번호가 두 사진에) → 한 항목·배열 합집합 ---
  {
    const merged = mergeVocabPages([
      {
        photoIndex: 0,
        entries: [entry({ meanings: [{ no: null, ko: "무리, 떼", related: [] }], examples: [{ en: "A pack of wolves.", ko: "늑대 한 무리." }] })],
      },
      {
        photoIndex: 1,
        entries: [
          entry({
            meanings: [{ no: null, ko: "꾸러미", related: [] }],
            examples: [{ en: "Pack your bag.", ko: "가방을 싸라." }],
            related: [rel("synonym", "bundle", "묶음")],
          }),
        ],
      },
    ]);
    const one = merged.entries[0];
    const ok =
      merged.entries.length === 1 &&
      merged.mergedCount === 1 &&
      one.meanings.length === 2 &&
      one.examples.length === 2 &&
      one.related.length === 1;
    add(
      "병합. 겹쳐 찍기 → 1항목·배열 합집합",
      ok,
      `entries=${merged.entries.length} merged=${merged.mergedCount} 뜻=${one?.meanings.length} 예문=${one?.examples.length} 관련=${one?.related.length}`,
    );
  }

  // --- 병합 2: 경계 걸침 — 한 사진에서 잘린 partial이 다른 사진 완전본과 합쳐지며 partial 해제 ---
  {
    const merged = mergeVocabPages([
      {
        photoIndex: 0,
        entries: [entry({ no: "0002", word: "howl", meanings: [], examples: [], partial: true, confidence: "medium" })],
      },
      {
        photoIndex: 1,
        entries: [
          entry({
            no: "0002",
            word: "howl",
            meanings: [{ no: null, ko: "울부짖다", related: [] }],
            examples: [{ en: "Wolves howl at night.", ko: "늑대는 밤에 운다." }],
            partial: false,
            confidence: "high",
          }),
        ],
      },
    ]);
    const one = merged.entries[0];
    const ok =
      merged.entries.length === 1 &&
      one.partial === false &&
      one.confidence === "high" &&
      one.meanings.length === 1;
    add(
      "병합. 경계 걸침 partial → 완전본과 합쳐 partial 해제",
      ok,
      `entries=${merged.entries.length} partial=${one?.partial} confidence=${one?.confidence}`,
    );
  }

  // --- 병합 3: 사진 한 장 통째 누락 → 번호 구멍 감지 (0003~0004 빠짐) ---
  {
    const merged = mergeVocabPages([
      { photoIndex: 0, entries: [entry({ no: "0001", word: "alpha" }), entry({ no: "0002", word: "bravo" })] },
      { photoIndex: 1, entries: [entry({ no: "0005", word: "echo" })] },
    ]);
    const ok = merged.entries.length === 3 && merged.missingNos.join(",") === "0003,0004";
    add(
      "병합. 번호 구멍(사진 누락) 감지",
      ok,
      `missingNos=[${merged.missingNos.join(", ")}] (기대 0003,0004)`,
    );
  }

  // --- 병합 4: 번호 오름차순 정렬 ---
  {
    const merged = mergeVocabPages([
      {
        photoIndex: 0,
        entries: [entry({ no: "0003", word: "c" }), entry({ no: "0001", word: "a" }), entry({ no: "0002", word: "b" })],
      },
    ]);
    const order = merged.entries.map((e) => e.no).join(",");
    add("병합. 번호 오름차순 정렬", order === "0001,0002,0003", `순서=${order}`);
  }

  // --- 병합 5: 번호가 없으면 word 소문자로 조인 (대소문자 무시) ---
  {
    const merged = mergeVocabPages([
      { photoIndex: 0, entries: [entry({ no: null, word: "Fix", meanings: [{ no: null, ko: "고치다", related: [] }], examples: [] })] },
      { photoIndex: 1, entries: [entry({ no: null, word: "fix", meanings: [{ no: null, ko: "수리하다", related: [] }], examples: [] })] },
    ]);
    const ok = merged.entries.length === 1 && merged.entries[0].meanings.length === 2;
    add(
      "병합. 번호 없으면 word 소문자로 조인",
      ok,
      `entries=${merged.entries.length} 뜻=${merged.entries[0]?.meanings.length}`,
    );
  }

  // --- 병합 6: 뜻-유의어 관계 보존 — 뜻 옆 유의어는 그 뜻(meanings[].related)에, 단어 아래 파생어는 entry.related에 ---
  //   교재 실사용 진단(2026-08-22)의 핵심: fix 뜻1의 유의어 repair가 병합 후에도 뜻1에 남아야 하고,
  //   파생어(단어 전체)는 뜻이 아니라 entry.related에 따로 남아야 한다.
  {
    const merged = mergeVocabPages([
      {
        photoIndex: 0,
        entries: [
          entry({
            word: "fix",
            meanings: [
              { no: 1, ko: "수리하다, 고치다", related: [rel("synonym", "repair", null)] },
              { no: 2, ko: "고정시키다", related: [] },
            ],
            related: [rel("derivative", "fixture", "설비")],
          }),
        ],
      },
      {
        photoIndex: 1,
        entries: [
          entry({
            word: "fix",
            meanings: [{ no: 1, ko: "수리하다, 고치다", related: [rel("antonym", "break", null)] }],
            related: [],
          }),
        ],
      },
    ]);
    const one = merged.entries[0];
    const m1 = one?.meanings.find((m) => m.no === 1);
    const m2 = one?.meanings.find((m) => m.no === 2);
    const ok =
      merged.entries.length === 1 &&
      one.meanings.length === 2 &&
      m1?.related.length === 2 && // repair(뜻1 사진0) + break(뜻1 사진1) 합집합
      m2?.related.length === 0 &&
      one.related.length === 1 && // 단어 전체 파생어는 뜻과 섞이지 않고 따로 남는다
      one.related[0].kind === "derivative";
    add(
      "병합. 뜻-유의어 관계 보존 (뜻 옆 유의어 합집합·단어 파생어 분리)",
      ok,
      `뜻=${one?.meanings.length} 뜻1유의어=${m1?.related.length} 뜻2유의어=${m2?.related.length} 단어related=${one?.related.length}`,
    );
  }

  // --- findMissingNumbers 단독: 번호가 2개 미만이면 빈 배열 ---
  {
    const out = findMissingNumbers([{ no: null }, { no: "0001" }]);
    add("findMissingNumbers. 번호<2개면 빈 배열", out.length === 0, `결과=[${out.join(", ")}]`);
  }

  // --- zod: 정상 판독 통과 ---
  {
    const good = vocabExtractionSchema.safeParse({
      isVocabPage: true,
      dayLabel: "DAY 01",
      entries: [
        {
          no: "0001", word: "fix", ipa: "fɪks", pos: ["동"],
          meanings: [
            { no: 1, ko: "수리하다, 고치다", related: [{ kind: "synonym", word: "repair", glossKo: null }] },
            { no: 2, ko: "고정시키다", related: [] },
          ],
          examples: [{ en: "Fix the car.", ko: "차를 고쳐라." }],
          related: [{ kind: "derivative", word: "fixture", glossKo: "설비" }],
          partial: false, confidence: "high",
        },
      ],
    });
    add("zod. 정상 판독 통과 (뜻 번호·뜻 옆 유의어·단어 파생어)", good.success, good.success ? "통과" : issues(good.error));
  }

  // --- zod 위반: 각각 거부되어야 한다 ---
  const validEntry = {
    no: "0001", word: "pack", ipa: "pæk", pos: ["명"],
    meanings: [{ no: null, ko: "무리, 떼", related: [] }],
    examples: [{ en: "A pack of wolves.", ko: "늑대 한 무리." }],
    related: [], partial: false, confidence: "high",
  };
  const badCases: Array<{ name: string; input: unknown }> = [
    {
      name: "ipa 대괄호 잔존",
      input: { isVocabPage: true, dayLabel: null, entries: [{ ...validEntry, ipa: "[pæk]" }] },
    },
    {
      name: "isVocabPage=false인데 entries 있음",
      input: { isVocabPage: false, dayLabel: null, entries: [validEntry] },
    },
    {
      name: "같은 사진 번호 중복",
      input: { isVocabPage: true, dayLabel: null, entries: [validEntry, { ...validEntry, word: "flock" }] },
    },
    {
      name: "meanings[].no 범위 초과(뜻 번호 아님)",
      input: { isVocabPage: true, dayLabel: null, entries: [{ ...validEntry, meanings: [{ no: 200, ko: "무리", related: [] }] }] },
    },
    {
      name: "meanings[].ko 비어 있음",
      input: { isVocabPage: true, dayLabel: null, entries: [{ ...validEntry, meanings: [{ no: null, ko: "", related: [] }] }] },
    },
  ];
  for (const bad of badCases) {
    const parsed = vocabExtractionSchema.safeParse(bad.input);
    add(
      `zod. ${bad.name} → 거부`,
      parsed.success === false,
      parsed.success ? "잘못 통과함(거부되어야 함)" : "정상 거부",
    );
  }

  // --- resolveVocabImage 우선순위: svg > emoji > 첫 글자 배지 ---
  {
    const svg = resolveVocabImage({ imageSvg: "<svg/>", imageEmoji: "🐺", word: "pack" });
    const emoji = resolveVocabImage({ imageSvg: null, imageEmoji: "🐺", word: "pack" });
    const letter = resolveVocabImage({ imageSvg: null, imageEmoji: null, word: "respect" });
    const ok =
      svg.kind === "svg" &&
      emoji.kind === "emoji" &&
      letter.kind === "letter" &&
      letter.letter === "R";
    add(
      "resolveVocabImage. svg>emoji>첫글자 우선순위",
      ok,
      `svg=${svg.kind} emoji=${emoji.kind} letter=${letter.kind}${letter.kind === "letter" ? `/${letter.letter}` : ""}`,
    );
  }

  // --- few-shot: 프롬프트 [판독 예시]의 JSON 객체가 실제 스키마와 맞는지 (본문에 박힌 예시가
  //   스키마 위반이면 모델에게 잘못된 shape을 가르친다 — 예문 누락의 근본 원인 대응이므로 특히
  //   examples가 채워진 예시여야 한다). 프롬프트에서 최상위 {..} 객체를 떼어 각각 검증한다. ---
  {
    // 문자열 내부 중괄호는 무시하고 최상위 { ... } 블록만 떼어 낸다
    const extractTopLevelJsonObjects = (text: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let start = -1;
      let inStr = false;
      let esc = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") {
          if (depth === 0) start = i;
          depth++;
        } else if (c === "}") {
          depth--;
          if (depth === 0 && start >= 0) {
            out.push(text.slice(start, i + 1));
            start = -1;
          }
        }
      }
      return out;
    };

    const marker = "[판독 예시]";
    const at = VOCAB_EXTRACT_SYSTEM_PROMPT.indexOf(marker);
    const objs = at >= 0 ? extractTopLevelJsonObjects(VOCAB_EXTRACT_SYSTEM_PROMPT.slice(at)) : [];
    let allValid = at >= 0 && objs.length >= 1;
    let allHaveExamples = objs.length >= 1;
    const failMsgs: string[] = [];
    for (const raw of objs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        allValid = false;
        failMsgs.push(`JSON.parse 실패: ${(e as Error).message}`);
        continue;
      }
      const res = vocabExtractionSchema.safeParse({ isVocabPage: true, dayLabel: null, entries: [parsed] });
      if (!res.success) {
        allValid = false;
        failMsgs.push(issues(res.error));
      }
      const ex = (parsed as { examples?: unknown }).examples;
      if (!Array.isArray(ex) || ex.length === 0) allHaveExamples = false;
    }
    add(
      "few-shot. [판독 예시] JSON이 스키마 통과 + examples 채워짐",
      allValid && allHaveExamples,
      `예시=${objs.length}개 · 마커=${at >= 0 ? "있음" : "없음"} · 스키마=${allValid ? "통과" : `위반(${failMsgs.join(" / ")})`} · examples채움=${allHaveExamples}`,
    );
  }

  // =========================================================================
  // 호출 D(보강, §8) — 정의 불변 순수 함수. 실호출 0회.
  // 시험(V4)이 저장된 정의에 매달려 **안정성이 정확성보다 우선**한다 — 이 규칙이 새면 은우가
  // 외운 정의와 시험이 어긋난다. mergeEnrichment/entriesToEnrich를 고정 입력으로 잠근다(§8-5).
  // =========================================================================

  // 저장형 VocabEntry 픽스처 — 필요한 필드만 덮어쓴다
  const ventry = (over: Partial<VocabEntry> = {}): VocabEntry => ({
    no: "0001",
    word: "apple",
    ipa: "æpl",
    pos: ["명"],
    meanings: [{ no: null, ko: "사과", related: [] }],
    examples: [],
    related: [],
    definitionEn: null,
    definitionKo: null,
    imageEmoji: null,
    imageSvg: null,
    photoIndex: 0,
    confidence: "high",
    partial: false,
    ...over,
  });

  // --- mergeEnrichment A: 정의 불변(덮어쓰기 0) + null 자리만 채움 + 세 필드 독립 + 부분 실패 + enriched 판정 ---
  {
    const entries: VocabEntry[] = [
      ventry({ no: "0001", word: "apple", definitionEn: null, definitionKo: null, imageEmoji: null }), // 셋 다 채울 대상
      ventry({ no: "0002", word: "brave", definitionEn: "Not afraid of anything.", definitionKo: "무엇도 두려워하지 않아요.", imageEmoji: "🦁" }), // 셋 다 채워짐 → 불변
      ventry({ no: "0003", word: "fix", definitionEn: null, definitionKo: null, imageEmoji: null }), // 결과에 없음 → 부분 실패로 그대로
    ];
    const result: VocabEnrichItem[] = [
      { no: "0001", word: "apple", definitionEn: "A round sweet fruit.", definitionKo: "둥글고 단 과일이에요.", imageEmoji: "🍎" },
      // brave: 세 필드 모두 덮어쓰기 시도 → 전부 무시돼야(EN·KO·이모지 각각 불변)
      { no: "0002", word: "brave", definitionEn: "OVERWRITE EN.", definitionKo: "덮어쓰기 해석.", imageEmoji: "❌" },
    ];
    const m = mergeEnrichment(entries, result);
    const [apple, brave, fix] = m.entries;
    const ok =
      apple.definitionEn === "A round sweet fruit." &&
      apple.definitionKo === "둥글고 단 과일이에요." && // KO null 자리 채움
      apple.imageEmoji === "🍎" &&
      brave.definitionEn === "Not afraid of anything." && // EN 덮어쓰기 0
      brave.definitionKo === "무엇도 두려워하지 않아요." && // KO 덮어쓰기 0
      brave.imageEmoji === "🦁" && // 이모지 덮어쓰기 0
      fix.definitionEn === null &&
      fix.definitionKo === null &&
      fix.imageEmoji === null && // 결과에 없는 단어는 그대로
      m.enriched === false; // fix가 EN null이라 미완
    add(
      "호출 D §8. mergeEnrichment: EN·KO·이모지 각각 불변·null만 채움·부분 실패·enriched=false",
      ok,
      `apple=${JSON.stringify(apple.definitionEn)}/${JSON.stringify(apple.definitionKo)}/${apple.imageEmoji} · brave=${JSON.stringify(brave.definitionEn)}/${JSON.stringify(brave.definitionKo)}/${brave.imageEmoji} · fix=${fix.definitionEn}/${fix.definitionKo}/${fix.imageEmoji} · enriched=${m.enriched}`,
    );
  }

  // --- mergeEnrichment B: 해석 백필(EN 불변) + 이모지 독립 + 전부 채워지면 enriched=true ---
  // V7 핵심 시나리오: 정의(EN)는 있고 해석(KO)만 비었을 때, EN은 손대지 않고 KO만 채운다.
  {
    const entries: VocabEntry[] = [
      ventry({ no: "0001", word: "apple", definitionEn: "A round fruit.", definitionKo: null, imageEmoji: null }), // EN O·KO X·이모지 X (해석 백필 대상)
      ventry({ no: "0002", word: "run", definitionEn: null, definitionKo: null, imageEmoji: null }), // 신규
    ];
    const result: VocabEnrichItem[] = [
      { no: "0001", word: "apple", definitionEn: "SHOULD NOT REPLACE.", definitionKo: "둥근 과일이에요.", imageEmoji: "🍎" }, // EN 불변, KO·이모지만
      { no: "0002", word: "run", definitionEn: "To move fast on your legs.", definitionKo: "다리로 빠르게 움직여요.", imageEmoji: "🏃" },
    ];
    const m = mergeEnrichment(entries, result);
    const ok =
      m.entries[0].definitionEn === "A round fruit." && // EN 불변(적대적 덮어쓰기 무시)
      m.entries[0].definitionKo === "둥근 과일이에요." && // KO 백필(독립)
      m.entries[0].imageEmoji === "🍎" && // 이모지 채움(독립)
      m.entries[1].definitionEn === "To move fast on your legs." &&
      m.entries[1].definitionKo === "다리로 빠르게 움직여요." &&
      m.entries[1].imageEmoji === "🏃" &&
      m.enriched === true; // 모든 정의(EN) non-null
    add(
      "호출 D §8. mergeEnrichment: 해석 백필(EN 불변)·이모지 독립·enriched=true",
      ok,
      `apple.def=${JSON.stringify(m.entries[0].definitionEn)} apple.ko=${JSON.stringify(m.entries[0].definitionKo)} apple.emoji=${m.entries[0].imageEmoji} · enriched=${m.enriched}`,
    );
  }

  // --- mergeEnrichment C: 번호 없는 단어는 word(대소문자 무시)로 매칭 (EN·KO 함께 채움) ---
  {
    const entries: VocabEntry[] = [ventry({ no: null, word: "Fix", definitionEn: null, definitionKo: null })];
    const result: VocabEnrichItem[] = [
      { no: null, word: "fix", definitionEn: "To make something work again.", definitionKo: "무언가를 다시 작동하게 만들어요.", imageEmoji: null },
    ];
    const m = mergeEnrichment(entries, result);
    add(
      "호출 D §8. mergeEnrichment: no 없으면 word로 매칭(EN·KO)",
      m.entries[0].definitionEn === "To make something work again." &&
        m.entries[0].definitionKo === "무언가를 다시 작동하게 만들어요.",
      `def=${JSON.stringify(m.entries[0].definitionEn)} ko=${JSON.stringify(m.entries[0].definitionKo)}`,
    );
  }

  // --- entriesToEnrich: definitionEn === null 또는 definitionKo === null인 단어를 추린다(해석 백필 포함) ---
  {
    const entries: VocabEntry[] = [
      ventry({ word: "a", definitionEn: null, definitionKo: null }), // EN 없음 → 대상
      ventry({ word: "b", definitionEn: "def", definitionKo: "해석" }), // 둘 다 참 → 제외
      ventry({ word: "c", definitionEn: null, definitionKo: null }), // EN 없음 → 대상
      ventry({ word: "d", definitionEn: "def", definitionKo: null }), // EN 있고 KO 없음 → 대상(해석 백필)
    ];
    const sub = entriesToEnrich(entries);
    const ok =
      sub.length === 3 &&
      sub.every((e) => e.definitionEn === null || e.definitionKo === null) &&
      sub.map((e) => e.word).join(",") === "a,c,d";
    add("호출 D §8. entriesToEnrich: EN null 또는 KO null 추림(백필 포함)", ok, `추린 단어=[${sub.map((e) => e.word).join(", ")}]`);
  }

  // --- buildEnrichRequestItems: 대상만·최소 shape(meaningsKo 풀이만)·definitionEn 전달(번역만 위해) ---
  {
    const entries: VocabEntry[] = [
      ventry({
        no: "0001",
        word: "apple",
        pos: ["명"],
        meanings: [
          { no: null, ko: "사과", related: [] },
          { no: null, ko: "사과나무", related: [] },
        ],
        definitionEn: null, // 신규 생성 → definitionEn: null 전달
        definitionKo: null,
      }),
      ventry({
        no: "0002",
        word: "respect",
        pos: ["동"],
        meanings: [{ no: null, ko: "존경하다", related: [] }],
        definitionEn: "To think that someone is important.", // 해석 백필 → 이 문장을 전달(번역만)
        definitionKo: null,
      }),
      ventry({ word: "b", definitionEn: "def", definitionKo: "해석" }), // 둘 다 참 → 제외
    ];
    const req = buildEnrichRequestItems(entries);
    const ok =
      req.length === 2 &&
      req[0].word === "apple" &&
      req[0].no === "0001" &&
      req[0].definitionEn === null && // 신규 생성 신호
      req[0].meaningsKo.join("|") === "사과|사과나무" &&
      req[1].word === "respect" &&
      req[1].definitionEn === "To think that someone is important."; // EN 전달(모델이 번역만)
    add("호출 D §8. buildEnrichRequestItems: 대상만·meaningsKo 풀이만·definitionEn 전달", ok, `요청=${JSON.stringify(req)}`);
  }

  // --- isVocabBookEnriched: enriched 단일 정의처(EN 기준 불변 — KO는 게이트에 넣지 않는다) ---
  {
    const ok =
      isVocabBookEnriched([]) === false &&
      isVocabBookEnriched([ventry({ definitionEn: "x", definitionKo: null })]) === true && // KO null이어도 EN 있으면 enriched
      isVocabBookEnriched([ventry({ definitionEn: "x" }), ventry({ definitionEn: null })]) === false;
    add("호출 D §8. isVocabBookEnriched: EN 기준(KO 무관)·빈배열=false·EN null 있으면 false", ok, "3케이스");
  }

  // --- 호출 D zod: 정의·이모지 품질 규칙이 실제로 거부하는지 ---
  {
    const goodEnrich = {
      items: [
        { no: "0001", word: "apple", definitionEn: "A round sweet fruit that grows on trees.", definitionKo: "나무에서 자라는 둥글고 단 과일이에요.", imageEmoji: "🍎" },
        { no: "0002", word: "respect", definitionEn: "To treat someone in a kind and polite way.", definitionKo: "누군가를 친절하고 예의 바르게 대하는 거예요.", imageEmoji: null },
        // 부분 실패: EN·KO 둘 다 null(정의를 못 만든 단어) → 규칙 검사 건너뜀 → 통과
        { no: "0003", word: "xyz", definitionEn: null, definitionKo: null, imageEmoji: null },
      ],
    };
    const goodParsed = vocabEnrichmentSchema.safeParse(goodEnrich);
    add(
      "호출 D §8. zod: 올바른 보강(해석 포함·부분 실패 허용) → 통과",
      goodParsed.success === true,
      goodParsed.success ? "정상 통과" : issues(goodParsed.error),
    );

    const badEnrich: { name: string; items: unknown[] }[] = [
      { name: "정의에 한글", items: [{ no: null, word: "apple", definitionEn: "둥근 과일이다.", definitionKo: "둥근 과일이에요.", imageEmoji: null }] },
      { name: "정의에 표제어 포함", items: [{ no: null, word: "apple", definitionEn: "An apple is a red fruit.", definitionKo: "사과는 빨간 과일이에요.", imageEmoji: null }] },
      { name: "정의 두 문장", items: [{ no: null, word: "apple", definitionEn: "It is a fruit. It is sweet.", definitionKo: "과일이고 달아요.", imageEmoji: null }] },
      { name: "해석에 한글 없음", items: [{ no: null, word: "apple", definitionEn: "A round sweet fruit.", definitionKo: "Round sweet fruit.", imageEmoji: null }] },
      { name: "정의 null인데 해석 채움(고아)", items: [{ no: null, word: "apple", definitionEn: null, definitionKo: "둥근 과일이에요.", imageEmoji: null }] },
      { name: "이모지 2개", items: [{ no: null, word: "apple", definitionEn: null, definitionKo: null, imageEmoji: "🍎🍏" }] },
      { name: "이모지 자리에 글자", items: [{ no: null, word: "apple", definitionEn: null, definitionKo: null, imageEmoji: "A" }] },
    ];
    for (const bad of badEnrich) {
      const parsed = vocabEnrichmentSchema.safeParse(bad);
      add(
        `호출 D §8. zod. ${bad.name} → 거부`,
        parsed.success === false,
        parsed.success ? "잘못 통과함(거부되어야 함)" : "정상 거부",
      );
    }
  }

  // --- few-shot: 프롬프트 [예시]의 출력 객체가 실제 스키마와 맞는지 + 이모지 유/무 둘 다 보여주는지 ---
  {
    const extractTopLevelJsonObjects = (text: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let start = -1;
      let inStr = false;
      let esc = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") {
          if (depth === 0) start = i;
          depth++;
        } else if (c === "}") {
          depth--;
          if (depth === 0 && start >= 0) {
            out.push(text.slice(start, i + 1));
            start = -1;
          }
        }
      }
      return out;
    };

    const marker = "[예시]";
    const at = VOCAB_ENRICH_SYSTEM_PROMPT.indexOf(marker);
    const objs = at >= 0 ? extractTopLevelJsonObjects(VOCAB_ENRICH_SYSTEM_PROMPT.slice(at)) : [];
    // 출력 래퍼(=items 배열을 가진 객체)만 골라 검증한다 (입력 예시 객체는 다른 shape이라 제외)
    let wrapperFound = false;
    let schemaOk = true;
    let showsEmoji = false;
    let showsNull = false;
    let showsKo = false;
    let allDefined = true;
    const failMsgs: string[] = [];
    for (const raw of objs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // 부분 조각은 무시
      }
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
        continue; // 입력 예시 등 래퍼가 아닌 객체는 건너뛴다
      }
      wrapperFound = true;
      const res = vocabEnrichmentSchema.safeParse(parsed);
      if (!res.success) {
        schemaOk = false;
        failMsgs.push(issues(res.error));
        continue;
      }
      for (const it of res.data.items) {
        if (it.imageEmoji !== null) showsEmoji = true;
        else showsNull = true;
        if (it.definitionKo !== null) showsKo = true;
        if (it.definitionEn === null) allDefined = false;
      }
    }
    add(
      "호출 D §8. few-shot: [예시] 출력이 스키마 통과 + 이모지 유/무 + 해석 시연",
      wrapperFound && schemaOk && showsEmoji && showsNull && showsKo && allDefined,
      `래퍼=${wrapperFound ? "있음" : "없음"} · 스키마=${schemaOk ? "통과" : `위반(${failMsgs.join(" / ")})`} · 이모지시연=${showsEmoji} · null시연=${showsNull} · 해석시연=${showsKo} · 정의전부=${allDefined}`,
    );
  }

  // --- 시험 보기 생성 buildChoices (V4) — 정답 포함·전부 상이·개수·오답 같은 DAY ---
  // 셔플이 랜덤이라 여러 번(200회) 돌려 불변이 매번 성립하는지 본다(랜덤 없이 불변만 검증).
  {
    const dayWords = ["fix", "pack", "respect", "burden", "flock", "gather"];
    const correct = "fix";
    const daySet = new Set(dayWords);
    let alwaysHasCorrect = true;
    let alwaysDistinct = true;
    let alwaysCount = true;
    let distractorsInDay = true; // 오답이 전부 같은 DAY의 다른 단어인가
    for (let i = 0; i < 200; i += 1) {
      const choices = buildChoices(correct, dayWords, 5);
      if (!choices.includes(correct)) alwaysHasCorrect = false;
      if (new Set(choices).size !== choices.length) alwaysDistinct = false;
      if (choices.length !== 5) alwaysCount = false;
      for (const c of choices) {
        if (c === correct) continue;
        if (!daySet.has(c)) distractorsInDay = false; // DAY 밖 단어가 오답으로 새면 실패
      }
    }
    add("buildChoices. 정답 항상 포함(200회)", alwaysHasCorrect, alwaysHasCorrect ? "매번 포함" : "누락 발생");
    add("buildChoices. 보기 전부 상이·중복 0(200회)", alwaysDistinct, alwaysDistinct ? "중복 없음" : "중복 발생");
    add("buildChoices. 정확히 5개(DAY 충분·200회)", alwaysCount, alwaysCount ? "매번 5개" : "개수 어긋남");
    add(
      "buildChoices. 오답은 같은 DAY의 다른 단어(200회)",
      distractorsInDay,
      distractorsInDay ? "DAY 밖 오답 없음" : "DAY 밖 단어가 오답으로 샘",
    );
  }
  // --- buildChoices 경계: DAY 단어가 count 미만이면 가능한 만큼(중복 없이) ---
  {
    const small = buildChoices("fix", ["fix", "pack", "respect"], 5); // 정답1 + 오답 후보 2 = 최대 3
    const ok = small.length === 3 && small.includes("fix") && new Set(small).size === 3;
    add("buildChoices. DAY<count면 가능한 만큼(3개·중복0·정답포함)", ok, `길이=${small.length} 값=[${small.join(", ")}]`);
  }
  // --- buildChoices: dayWords에 정답·중복이 섞여도 오답에 정답이 안 들어가고 중복도 없다 ---
  {
    const noisy = buildChoices("fix", ["fix", "fix", "pack", "pack", "respect", "flock"], 5);
    const distractors = noisy.filter((c) => c !== "fix");
    const ok =
      noisy.includes("fix") &&
      new Set(noisy).size === noisy.length &&
      !distractors.includes("fix");
    add("buildChoices. dayWords 정답·중복 오염에도 정답 미중복·오답 유일", ok, `값=[${noisy.join(", ")}]`);
  }

  // --- 관계 문제 시험 buildRelationQuestions (V8) — source:"user" 대상·정답 포함·meaningKo 정확·graceful ---
  // 관련어 픽스처 헬퍼 — source·kind만 다르게, 나머지는 위 rel(book)과 구분해 짧게 만든다.
  const userRel = (kind: string, word: string) => ({ kind, word, source: "user" });
  const bookRel = (kind: string, word: string) => ({ kind, word, source: "book" });
  {
    // 표제어 넉넉(≥5)한 단어장. big↔large(유의어), big↔small(반의어) 사용자 연결 + 잡음(book·derivative·user-derivative).
    const entries = [
      {
        word: "big",
        meanings: [
          { ko: "큰", related: [userRel("synonym", "large"), userRel("antonym", "small")] },
          { ko: "중요한", related: [bookRel("synonym", "major"), userRel("derivative", "bigly")] },
        ],
      },
      { word: "large", meanings: [{ ko: "큰", related: [userRel("synonym", "big")] }] },
      { word: "small", meanings: [{ ko: "작은", related: [] }] },
      { word: "major", meanings: [{ ko: "주요한", related: [] }] },
      { word: "tiny", meanings: [{ ko: "아주 작은", related: [] }] },
    ];
    const qs = buildRelationQuestions(entries, 5);

    // (b) source:"user"·synonym/antonym만 — big의 user 유의어/반의어(2) + large의 user 유의어(1) = 3.
    //     book(major)·user-derivative(bigly)는 제외된다.
    const onlyUserSynAnt = qs.every(
      (q) => (q.relationKind === "synonym" || q.relationKind === "antonym"),
    );
    const bigglyExcluded = !qs.some((q) => q.answer === "bigly" || q.answer === "major");
    add(
      "buildRelationQuestions. source:user·유의어/반의어만 대상(book·derivative 제외)",
      qs.length === 3 && onlyUserSynAnt && bigglyExcluded,
      `문항=${qs.length}(기대 3) 답=[${qs.map((q) => q.answer).join(", ")}]`,
    );

    // (a) 각 문항 정답 포함·보기 전부 상이
    const choicesOk = qs.every(
      (q) => q.choices.includes(q.answer) && new Set(q.choices).size === q.choices.length,
    );
    add(
      "buildRelationQuestions. 각 문항 정답 포함·보기 전부 상이",
      choicesOk,
      choicesOk ? "정답 포함·중복 0" : "정답 누락 또는 중복",
    );

    // (c) meaningKo가 연결이 걸린 그 뜻으로 정확 — big의 large/small 연결은 "큰" 뜻에 걸려 있다.
    const bigSyn = qs.find((q) => q.promptWord === "big" && q.answer === "large");
    const bigAnt = qs.find((q) => q.promptWord === "big" && q.answer === "small");
    add(
      "buildRelationQuestions. meaningKo가 연결된 그 뜻으로 정확",
      bigSyn?.meaningKo === "큰" && bigAnt?.meaningKo === "큰" && bigSyn?.relationKind === "synonym" && bigAnt?.relationKind === "antonym",
      `big유의어.뜻=${bigSyn?.meaningKo} big반의어.뜻=${bigAnt?.meaningKo}`,
    );

    // 판별자 — 관계 문항은 kind:"relation"으로 def-to-word와 갈린다
    add(
      "buildRelationQuestions. kind:relation 판별자",
      qs.every((q) => q.kind === "relation"),
      qs.every((q) => q.kind === "relation") ? "전부 relation" : "판별자 누락",
    );
  }

  // (d) 사용자 연결이 없으면 빈 배열 (교재 판독분만 있을 때)
  {
    const entries = [
      { word: "big", meanings: [{ ko: "큰", related: [bookRel("synonym", "large")] }] },
      { word: "large", meanings: [{ ko: "큰", related: [] }] },
    ];
    const qs = buildRelationQuestions(entries, 5);
    add("buildRelationQuestions. user 링크 없으면 빈 배열", qs.length === 0, `문항=${qs.length}(기대 0)`);
  }

  // (e) dayWords 부족(표제어 2개)해도 정답을 포함한 채 가능한 만큼(count 미만) graceful
  {
    const entries = [
      { word: "up", meanings: [{ ko: "위로", related: [userRel("antonym", "down")] }] },
      { word: "down", meanings: [{ ko: "아래로", related: [userRel("antonym", "up")] }] },
    ];
    const qs = buildRelationQuestions(entries, 5);
    const graceful = qs.length === 2 && qs.every(
      (q) => q.choices.includes(q.answer) && q.choices.length <= 2 && new Set(q.choices).size === q.choices.length,
    );
    add(
      "buildRelationQuestions. dayWords 부족 시 graceful(정답 포함·count 미만·중복0)",
      graceful,
      `문항=${qs.length} 보기수=[${qs.map((q) => q.choices.length).join(", ")}]`,
    );
  }

  // --- 오답노트 집계·졸업 aggregateWordStats·isMastered (V5) ---
  // streak는 startedAt 오름차순 입력의 **순서**에 의존한다 — 재정렬 없이 그대로 소비하는지,
  // 연속 2회 경계·중간 틀림 리셋·미시도(answered!==true) 제외·여러 세션 시간순 합산을 잠근다.
  {
    // 세션 하나를 만드는 헬퍼(startedAt이 곧 시간 축). id/finishedAt은 집계에 안 쓰이나 타입을 채운다.
    const quiz = (
      startedAt: string,
      items: { word: string; correct: boolean; answered: boolean | null }[],
    ): VocabQuizRecord => ({ id: startedAt, bookId: "b1", mode: "def-to-word", startedAt, finishedAt: startedAt, items });

    // (1) 여러 세션을 시간순으로 합산 + 중간 틀림 리셋 + 연속 2회 졸업.
    //   fix: 맞→틀→맞→맞  ⇒ total 4, wrong 1, streak 2(마지막 2연속) ⇒ 졸업
    const statsA = aggregateWordStats([
      quiz("2026-08-20T01:00:00.000Z", [{ word: "fix", correct: true, answered: true }]),
      quiz("2026-08-21T01:00:00.000Z", [{ word: "fix", correct: false, answered: true }]),
      quiz("2026-08-22T01:00:00.000Z", [{ word: "fix", correct: true, answered: true }]),
      quiz("2026-08-23T01:00:00.000Z", [{ word: "fix", correct: true, answered: true }]),
    ]);
    const a = statsA["fix"];
    add(
      "aggregate. 여러 세션 시간순 합산(total/wrong) + 연속 2회 졸업",
      a != null && a.total === 4 && a.wrong === 1 && a.streak === 2 && isStatMastered(a),
      `fix=${JSON.stringify(a)}`,
    );

    // (2) 마지막이 오답이면 streak=0(리셋) → 미졸업.  맞→맞→틀 ⇒ streak 0
    const statsB = aggregateWordStats([
      quiz("2026-08-20T01:00:00.000Z", [{ word: "gap", correct: true, answered: true }]),
      quiz("2026-08-21T01:00:00.000Z", [{ word: "gap", correct: true, answered: true }]),
      quiz("2026-08-22T01:00:00.000Z", [{ word: "gap", correct: false, answered: true }]),
    ]);
    const b = statsB["gap"];
    add(
      "aggregate. 마지막 오답이면 streak 리셋(0)·미졸업",
      b != null && b.total === 3 && b.wrong === 1 && b.streak === 0 && !isStatMastered(b),
      `gap=${JSON.stringify(b)}`,
    );

    // (3) 미응답(answered:null)·미시도는 세지 않는다. 한 번도 시도 안 된 단어는 키에 없다.
    const statsC = aggregateWordStats([
      quiz("2026-08-20T01:00:00.000Z", [
        { word: "run", correct: true, answered: true },
        { word: "skip", correct: false, answered: null }, // 그만하기 미응답 — 시도 아님
        { word: "hold", correct: false, answered: false }, // 방어: answered:false도 시도 아님
      ]),
    ]);
    add(
      "aggregate. 미응답(null)·answered:false는 시도로 안 셈, 미시도 단어는 키 없음",
      statsC["run"]?.total === 1 && statsC["skip"] === undefined && statsC["hold"] === undefined,
      `run=${JSON.stringify(statsC["run"])} skip=${statsC["skip"]} hold=${statsC["hold"]}`,
    );

    // (4) 입력 순서가 곧 streak의 뜻 — 같은 두 세션을 순서만 바꾸면 streak가 달라진다(재정렬 금지 확인).
    const older = quiz("2026-08-20T01:00:00.000Z", [{ word: "x", correct: false, answered: true }]);
    const newer = quiz("2026-08-21T01:00:00.000Z", [{ word: "x", correct: true, answered: true }]);
    const asc = aggregateWordStats([older, newer])["x"]; // 틀→맞: 마지막 맞 ⇒ streak 1
    const desc = aggregateWordStats([newer, older])["x"]; // 맞→틀: 마지막 틀 ⇒ streak 0
    add(
      "aggregate. 입력 순서가 streak를 결정한다(재정렬하지 않는다)",
      asc?.streak === 1 && desc?.streak === 0,
      `asc.streak=${asc?.streak} desc.streak=${desc?.streak}`,
    );

    // (5) isMastered 이력 직접 검증 — 마지막 MASTERY_STREAK회가 모두 정답이어야 졸업.
    const T = true;
    const F = false;
    const masteredOk =
      isMastered([]) === false &&
      isMastered([T]) === false &&
      isMastered([T, T]) === true &&
      isMastered([F, T, T]) === true &&
      isMastered([T, T, F]) === false &&
      isMastered([T, F, T]) === false; // 중간 리셋 후 꼬리 1연속뿐
    add(
      `isMastered. 마지막 ${MASTERY_STREAK}회 모두 정답일 때만 졸업(경계·리셋)`,
      masteredOk,
      masteredOk ? "6개 경계 케이스 통과" : "경계 케이스 실패",
    );
  }

  // --- 복습 리마인드 선택 buildReviewCandidates·selectReviewSet·rankReviewPools (V6) ---
  // 가중 로직은 lib/vocab-review.ts 한 곳에만 산다. 여기서는 그 **불변**만 잠근다:
  // 단조(오답률·최근·시도적음), 4+1 구성, 중복0, 현재 DAY 제외, 정의·보기수 필터, 콜드스타트 graceful.
  {
    // 후보 하나를 만드는 헬퍼(직접 필드 주입 — 단조성을 통제 변수로 검증하기 위함).
    const cand = (over: Partial<ReviewCandidate> & { word: string }): ReviewCandidate => ({
      total: 4,
      wrong: 2,
      streak: 0,
      mastered: false,
      lastWrongOrder: 5,
      lastSeenOrder: 5,
      ...over,
    });
    // 모든 후보를 자격 통과시키는 ctx(출처는 더미 — 정의·보기≥5는 시험 페이지가 보장하는 계약).
    const src = (word: string): ReviewWordSource => ({
      definitionEn: `def of ${word}`,
      sourceBookId: "src",
      sourceDayWords: [word, "a", "b", "c", "d"], // 보기 5개 확보
    });
    const ctxFor = (words: string[], over: Partial<ReviewContext> = {}): ReviewContext => ({
      totalSessions: 10,
      currentDayWords: [],
      sources: new Map(words.map((w) => [w, src(w)])),
      ...over,
    });
    // 두 후보의 틀린 풀 점수를 비교하는 헬퍼(rankReviewPools로 가중 로직을 직접 관찰).
    const scoreOf = (c: ReviewCandidate): number => {
      const ranked = rankReviewPools([c], ctxFor([c.word]));
      return ranked.wrong[0]?.score ?? -1;
    };

    // (1) 오답률 높을수록 점수↑ (같은 total, wrong만 큼).
    const lowRate = cand({ word: "lo", total: 4, wrong: 1 });
    const highRate = cand({ word: "hi", total: 4, wrong: 3 });
    add(
      "review. 오답률 높을수록 점수↑(단조)",
      scoreOf(highRate) > scoreOf(lowRate),
      `hi=${scoreOf(highRate).toFixed(4)} > lo=${scoreOf(lowRate).toFixed(4)}`,
    );

    // (2) 최근에 틀릴수록 점수↑ (lastWrongOrder만 큼).
    const older = cand({ word: "old", lastWrongOrder: 2 });
    const newer = cand({ word: "new", lastWrongOrder: 8 });
    add(
      "review. 최근에 틀릴수록 점수↑(단조)",
      scoreOf(newer) > scoreOf(older),
      `new=${scoreOf(newer).toFixed(4)} > old=${scoreOf(older).toFixed(4)}`,
    );

    // (3) 시도가 적을수록 점수↑ (같은 wrong, total만 작음).
    const fewTries = cand({ word: "few", total: 2, wrong: 2 });
    const manyTries = cand({ word: "many", total: 6, wrong: 2 });
    add(
      "review. 시도 적을수록 점수↑(단조)",
      scoreOf(fewTries) > scoreOf(manyTries),
      `few=${scoreOf(fewTries).toFixed(4)} > many=${scoreOf(manyTries).toFixed(4)}`,
    );

    // (4) 4+1 구성 + 중복 0 — 틀린 풀 6개·잘한 풀 3개면 정확히 4+1=5, 서로 다른 단어.
    {
      const wrongs = ["w1", "w2", "w3", "w4", "w5", "w6"].map((w, i) =>
        cand({ word: w, total: 4, wrong: i + 1, streak: 0 }),
      );
      const goods = ["g1", "g2", "g3"].map((w, i) =>
        cand({ word: w, total: 3, wrong: 0, streak: 1, lastSeenOrder: i + 1 }),
      );
      const all = [...wrongs, ...goods];
      const picked = selectReviewSet(all, ctxFor(all.map((c) => c.word)));
      const words = picked.map((p) => p.word);
      const goodPicked = words.filter((w) => w.startsWith("g")).length;
      const wrongPicked = words.filter((w) => w.startsWith("w")).length;
      const distinct = new Set(words).size === words.length;
      add(
        "review. 틀린 4 + 잘한 1 = 5, 중복 0",
        picked.length === 5 && wrongPicked === 4 && goodPicked === 1 && distinct,
        `n=${picked.length} wrong=${wrongPicked} good=${goodPicked} words=[${words.join(",")}]`,
      );
    }

    // (5) 현재 DAY의 단어는 복습에서 제외(중복 방지) — 점수가 높아도 안 뽑힌다.
    {
      const hot = cand({ word: "hot", total: 2, wrong: 2, streak: 0, lastWrongOrder: 10 });
      const cool = cand({ word: "cool", total: 5, wrong: 1, streak: 0, lastWrongOrder: 3 });
      const picked = selectReviewSet(
        [hot, cool],
        ctxFor(["hot", "cool"], { currentDayWords: ["hot"] }),
      );
      const words = picked.map((p) => p.word);
      add(
        "review. 현재 DAY 단어는 제외(중복 방지)",
        !words.includes("hot") && words.includes("cool"),
        `words=[${words.join(",")}]`,
      );
    }

    // (6) 정의·보기 필터 — sources에 없는 단어(정의 없음/보기 부족 DAY)는 점수가 높아도 탈락.
    {
      const eligible = cand({ word: "ok", total: 3, wrong: 1, streak: 0, lastWrongOrder: 4 });
      const ineligible = cand({ word: "nope", total: 2, wrong: 2, streak: 0, lastWrongOrder: 9 });
      // sources에 "ok"만 넣는다("nope"는 출처 없음 → 탈락해야 함).
      const picked = selectReviewSet([ineligible, eligible], ctxFor(["ok"]));
      const words = picked.map((p) => p.word);
      add(
        "review. 출처 없는 단어(정의·보기 필터)는 탈락",
        words.includes("ok") && !words.includes("nope"),
        `words=[${words.join(",")}]`,
      );
    }

    // (7) 콜드스타트 graceful — 후보 0이면 [], 틀린 풀만 있으면 잘한 1 없이 그만큼만.
    {
      const empty = selectReviewSet([], ctxFor([]));
      const onlyWrong = [
        cand({ word: "a", wrong: 2, streak: 0 }),
        cand({ word: "b", wrong: 1, streak: 0 }),
      ];
      const pickedOnlyWrong = selectReviewSet(onlyWrong, ctxFor(["a", "b"]));
      add(
        "review. 콜드스타트 graceful(후보0→[], 틀린 풀만→잘한1 없이 그만큼)",
        empty.length === 0 &&
          pickedOnlyWrong.length === 2 &&
          pickedOnlyWrong.every((p) => p.word === "a" || p.word === "b"),
        `empty=${empty.length} onlyWrong=${pickedOnlyWrong.length}`,
      );
    }

    // (8) buildReviewCandidates — total/wrong/streak는 aggregate 재사용, recency는 세션 순번.
    {
      const q = (
        startedAt: string,
        items: { word: string; correct: boolean; answered: boolean | null }[],
      ): VocabQuizRecord => ({
        id: startedAt,
        bookId: "b1",
        mode: "def-to-word",
        startedAt,
        finishedAt: startedAt,
        items,
      });
      // fix: 세션1 틀림, 세션3 맞음 → total2, wrong1, streak1, lastWrong=1, lastSeen=3.
      const cands = buildReviewCandidates([
        q("2026-08-20T01:00:00.000Z", [{ word: "fix", correct: false, answered: true }]),
        q("2026-08-21T01:00:00.000Z", [{ word: "gap", correct: true, answered: true }]),
        q("2026-08-22T01:00:00.000Z", [{ word: "fix", correct: true, answered: true }]),
      ]);
      const fix = cands.find((c) => c.word === "fix");
      const agg = aggregateWordStats([
        q("2026-08-20T01:00:00.000Z", [{ word: "fix", correct: false, answered: true }]),
        q("2026-08-21T01:00:00.000Z", [{ word: "gap", correct: true, answered: true }]),
        q("2026-08-22T01:00:00.000Z", [{ word: "fix", correct: true, answered: true }]),
      ])["fix"];
      add(
        "review. buildReviewCandidates — total/wrong/streak 재사용 + recency(세션 순번)",
        fix != null &&
          fix.total === agg.total &&
          fix.wrong === agg.wrong &&
          fix.streak === agg.streak &&
          fix.lastWrongOrder === 1 &&
          fix.lastSeenOrder === 3,
        `fix=${JSON.stringify(fix)}`,
      );
    }

    // --- 관계 무오염 회귀 가드 (V8, P2) — mode:"relation" 세션이 def→word 숙련도/오답노트/복습에 안 섞인다 ---
    // 값으로 못박는다: 가드(aggregateWordStats의 relation 제외 / buildReviewCandidates recency의 relation 제외)를
    // 지우면 total/wrong/streak·recency가 실제로 달라져 아래 두 항목이 FAIL 난다(조용히 깨지지 않게).
    {
      const qz = (
        startedAt: string,
        mode: VocabQuizMode,
        items: { word: string; correct: boolean; answered: boolean | null }[],
      ): VocabQuizRecord => ({ id: startedAt, bookId: "b1", mode, startedAt, finishedAt: startedAt, items });

      // 가드 1 — aggregateWordStats: fix는 def-to-word 2연속 정답(total2·wrong0·streak2=졸업).
      //   가장 최근 관계 세션에서 fix를 '틀림'으로 넣어도 def→word 집계에 새면 안 된다(새면 total3·wrong1·streak0).
      const aggFix = aggregateWordStats([
        qz("2026-08-20T01:00:00.000Z", "def-to-word", [{ word: "fix", correct: true, answered: true }]),
        qz("2026-08-21T01:00:00.000Z", "def-to-word", [{ word: "fix", correct: true, answered: true }]),
        qz("2026-08-22T01:00:00.000Z", "relation", [{ word: "fix", correct: false, answered: true }]),
      ])["fix"];
      add(
        "무오염 가드. aggregateWordStats가 mode:relation을 def→word 집계에서 제외(total/wrong/streak 불변)",
        aggFix != null && aggFix.total === 2 && aggFix.wrong === 0 && aggFix.streak === 2,
        `fix=${JSON.stringify(aggFix)} (기대 total2·wrong0·streak2; 관계가 새면 total3·wrong1·streak0)`,
      );

      // 가드 2 — buildReviewCandidates: cool은 def-to-word 1회 정답(order1)뿐. 관계 세션(order2)에서 cool을
      //   '틀림'으로 넣어도 stats(aggregate 재사용)·recency 어느 쪽도 오염되면 안 된다.
      //   무오염이면 total1·wrong0·streak1·lastWrongOrder0(틀린 적 없음)·lastSeenOrder1(관계 order2는 안 셈).
      const coolCand = buildReviewCandidates([
        qz("2026-08-20T01:00:00.000Z", "def-to-word", [{ word: "cool", correct: true, answered: true }]),
        qz("2026-08-21T01:00:00.000Z", "relation", [{ word: "cool", correct: false, answered: true }]),
      ]).find((c) => c.word === "cool");
      add(
        "무오염 가드. buildReviewCandidates가 mode:relation을 복습(stats·recency)에서 제외",
        coolCand != null &&
          coolCand.total === 1 &&
          coolCand.wrong === 0 &&
          coolCand.streak === 1 &&
          coolCand.lastWrongOrder === 0 &&
          coolCand.lastSeenOrder === 1,
        `cool=${JSON.stringify(coolCand)} (기대 total1·wrong0·lastWrong0·lastSeen1; 관계가 새면 wrong·recency가 변함)`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 실행: 픽스처 2권으로 실제 카드 생성 → 점검 → 항목별 pass/fail 표 → 실패 시 exit 1
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 호출 F(챕터화, §9) 오프라인 점검 — 실호출 0회.
//
// 모델 출력이 있어야 재현되는 것(노이즈 제외·실제 번역 품질)은 실호출 게이트(EVAL_CHAPTERS=1)가
// 본다. 여기서는 (a) chapters zod가 계약 위반을 거부하는지, (b) groundChapters가 자막 밖 문장을
// 잘라내고 자막 안 문장을 en/ko 1:1로 보존하는지를 고정 입력으로 검사한다.
//
// 픽스처는 낭독 자막 게이트와 같은 POOH_TRANSCRIPT(채널 인트로/아웃트로 노이즈 포함)를 재사용한다.
// ---------------------------------------------------------------------------

/** 챕터화 픽스처의 목차 챕터 제목 — 앞 4개는 자막에 내용이 있고, 마지막은 없다(matched:false 경로) */
const CHAPTERIZE_FIXTURE_TITLES = [
  "Pooh Visits Rabbit",
  "Stuck!",
  "Waiting to Get Thin",
  "Free at Last",
  "A New Adventure",
];

/** POOH_TRANSCRIPT에서 글자 그대로 가져온 문장들 — grounding을 통과해야 하는 '자막 안' 문장 */
const GROUNDED_EN = [
  "He walked over to Rabbit's house to say hello.",
  "Rabbit was kind and gave Pooh some honey.",
  "Pooh was stuck in the hole.",
  "He was so happy to be free at last.",
];

function runChapterizeChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "챕터화(§9)";
  const schema = makeChapterizationSchema({ chapterTitles: CHAPTERIZE_FIXTURE_TITLES });
  const sent = (en: string, ko: string) => ({ en, ko });

  // 정상 출력: 앞 챕터는 자막 문장으로 채우고, 마지막 챕터는 내용 없음(matched:false·빈 sentences)
  const good = {
    chapters: [
      { titleEn: "Pooh Visits Rabbit", matched: true, sentences: [sent(GROUNDED_EN[0], "그는 인사하러 토끼네 집으로 걸어갔어요."), sent(GROUNDED_EN[1], "토끼는 친절하게 푸에게 꿀을 주었어요.")] },
      { titleEn: "Stuck!", matched: true, sentences: [sent(GROUNDED_EN[2], "푸는 구멍에 끼고 말았어요.")] },
      { titleEn: "Waiting to Get Thin", matched: false, sentences: [] },
      { titleEn: "Free at Last", matched: true, sentences: [sent(GROUNDED_EN[3], "그는 마침내 자유로워져서 정말 행복했어요.")] },
      { titleEn: "A New Adventure", matched: false, sentences: [] },
    ],
  };
  results.push({
    book,
    check: "zod: 정상 출력 통과 (matched·빈챕터·en/ko 1:1)",
    pass: schema.safeParse(good).success,
    detail: schema.safeParse(good).success ? "통과" : JSON.stringify(schema.safeParse(good).error?.issues?.slice(0, 3)),
  });

  // zod 거부 케이스들 — 각각 계약 하나씩 위반
  const rejectCases: { name: string; obj: unknown }[] = [
    {
      name: "matched=true인데 sentences 비어 있음",
      obj: { chapters: [{ titleEn: "Stuck!", matched: true, sentences: [] }] },
    },
    {
      name: "matched=false인데 sentences 있음",
      obj: { chapters: [{ titleEn: "Stuck!", matched: false, sentences: [sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요.")] }] },
    },
    {
      name: "en에 한글이 섞임(en/ko 자리 바꿈)",
      obj: { chapters: [{ titleEn: "Stuck!", matched: true, sentences: [sent("푸는 구멍에 끼었어요.", "Pooh was stuck.")] }] },
    },
    {
      name: "ko에 한글이 없음",
      obj: { chapters: [{ titleEn: "Stuck!", matched: true, sentences: [sent(GROUNDED_EN[2], "Pooh was stuck.")] }] },
    },
    {
      name: "목차 밖 titleEn(챕터 창작)",
      obj: { chapters: [{ titleEn: "Chapter Nobody Asked For", matched: true, sentences: [sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요.")] }] },
    },
    {
      name: "titleEn 중복",
      obj: {
        chapters: [
          { titleEn: "Stuck!", matched: true, sentences: [sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요.")] },
          { titleEn: "Stuck!", matched: false, sentences: [] },
        ],
      },
    },
    {
      name: `챕터 수 상한(${CHAPTERIZE_MAX_CHAPTERS}) 초과`,
      obj: {
        chapters: Array.from({ length: CHAPTERIZE_MAX_CHAPTERS + 1 }, () => ({
          titleEn: "Stuck!",
          matched: false,
          sentences: [],
        })),
      },
    },
    {
      name: `챕터당 문장 상한(${CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER}) 초과`,
      obj: {
        chapters: [
          {
            titleEn: "Stuck!",
            matched: true,
            sentences: Array.from({ length: CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER + 1 }, () =>
              sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요."),
            ),
          },
        ],
      },
    },
  ];
  for (const rc of rejectCases) {
    const rejected = !schema.safeParse(rc.obj).success;
    results.push({ book, check: `zod 거부: ${rc.name}`, pass: rejected, detail: rejected ? "거부됨" : "통과되면 안 됨" });
  }

  // groundChapters — 자막 밖 창작 금지의 최종 강제
  const transcript = POOH_TRANSCRIPT;
  const FABRICATED = "Pooh flew to the moon on a silver rocket.";
  const mixed: Chapter[] = [
    {
      titleEn: "Stuck!",
      matched: true,
      sentences: [
        sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요."), // 자막 안 → 보존
        sent(FABRICATED, "푸는 은빛 로켓을 타고 달에 갔어요."), // 자막 밖 → 잘림
      ],
    },
    {
      titleEn: "A New Adventure",
      matched: true,
      sentences: [sent(FABRICATED, "푸는 은빛 로켓을 타고 달에 갔어요.")], // 전부 자막 밖 → matched:false로 내려감
    },
  ];
  const grounded = groundChapters(mixed, transcript);
  results.push({
    book,
    check: "groundChapters: 자막 밖 문장 잘라냄(창작 금지)",
    pass: grounded.droppedSentenceCount === 2 && grounded.chapters[0].sentences.length === 1,
    detail: `dropped=${grounded.droppedSentenceCount} (기대 2), 첫 챕터 남은 문장=${grounded.chapters[0].sentences.length} (기대 1)`,
  });
  results.push({
    book,
    check: "groundChapters: 자막 안 문장은 en/ko 1:1 보존",
    pass:
      grounded.chapters[0].sentences[0].en === GROUNDED_EN[2] &&
      grounded.chapters[0].sentences[0].ko === "푸는 구멍에 끼었어요.",
    detail: JSON.stringify(grounded.chapters[0].sentences[0]),
  });
  results.push({
    book,
    check: "groundChapters: 문장 전부 잘린 챕터는 matched:false",
    pass: grounded.chapters[1].matched === false && grounded.chapters[1].sentences.length === 0,
    detail: `matched=${grounded.chapters[1].matched}, sentences=${grounded.chapters[1].sentences.length}`,
  });

  // grounding은 대소문자·문장부호·아포스트로피 흔들림에 관대해야 한다(모델 전사 드리프트 흡수)
  const transcriptTokens = tokenizeForGrounding(transcript);
  results.push({
    book,
    check: "grounding: 대소문자·문장부호 흔들림 허용",
    pass: isGroundedInTranscript("pooh was STUCK in the hole", transcriptTokens),
    detail: "구두점·대소문자를 무시하고 토큰 열로 대조",
  });
  results.push({
    book,
    check: "grounding: 자막에 없는 문장은 거부",
    pass: !isGroundedInTranscript(FABRICATED, transcriptTokens),
    detail: "자막 밖 문장은 grounded=false",
  });

  // 노이즈 제외 계약의 실호출 게이트 준비 — 노이즈 문구가 자막에 실제로 있어야 게이트가 의미 있다
  results.push({
    book,
    check: "픽스처: 채널 노이즈 문구가 자막에 존재(게이트 준비)",
    pass: TRANSCRIPT_NOISE_TOKENS.every((t) => transcript.includes(t)),
    detail: `노이즈 제외 판정은 EVAL_CHAPTERS=1 실호출 게이트가 본다 (토큰: ${TRANSCRIPT_NOISE_TOKENS.join(", ")})`,
  });

  // truncate·상한 상수 정합
  const longTranscript = "word ".repeat(CHAPTERIZE_TRANSCRIPT_MAX_CHARS); // 상한보다 훨씬 긴 입력
  const trunc = truncateTranscriptForChapterize(longTranscript);
  results.push({
    book,
    check: "truncate: 상한 초과 시 앞부분 우선 절단",
    pass: trunc.truncated === true && trunc.text.length === CHAPTERIZE_TRANSCRIPT_MAX_CHARS,
    detail: `truncated=${trunc.truncated}, len=${trunc.text.length} (상한 ${CHAPTERIZE_TRANSCRIPT_MAX_CHARS})`,
  });
  results.push({
    book,
    check: "상수 정합: 전체 문장 상한 ≥ 챕터당 문장 상한 · 길이 상한 > 0",
    pass:
      CHAPTERIZE_MAX_SENTENCES_TOTAL >= CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER &&
      CHAPTERIZE_TRANSCRIPT_MAX_CHARS > 0 &&
      CHAPTER_TITLE_MAX > 0,
    detail: `total=${CHAPTERIZE_MAX_SENTENCES_TOTAL}, perChapter=${CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER}, maxChars=${CHAPTERIZE_TRANSCRIPT_MAX_CHARS}`,
  });

  // ── 목차 없음 갈래(§9): 자막만 있으면 단일 "전체" 챕터 ─────────────────────────
  results.push({
    book,
    check: `resolveChapterTitles: 빈 배열 → ["${WHOLE_TRANSCRIPT_TITLE}"]`,
    pass: JSON.stringify(resolveChapterTitles([])) === JSON.stringify([WHOLE_TRANSCRIPT_TITLE]),
    detail: JSON.stringify(resolveChapterTitles([])),
  });
  results.push({
    book,
    check: `resolveChapterTitles: 공백뿐 → ["${WHOLE_TRANSCRIPT_TITLE}"]`,
    pass: JSON.stringify(resolveChapterTitles(["  ", ""])) === JSON.stringify([WHOLE_TRANSCRIPT_TITLE]),
    detail: JSON.stringify(resolveChapterTitles(["  ", ""])),
  });
  results.push({
    book,
    check: "resolveChapterTitles: 목차 있으면 그대로(트림)",
    pass: JSON.stringify(resolveChapterTitles([" Ch 1 ", "Ch 2"])) === JSON.stringify(["Ch 1", "Ch 2"]),
    detail: JSON.stringify(resolveChapterTitles([" Ch 1 ", "Ch 2"])),
  });
  results.push({
    book,
    check: `사용자 메시지: 목차 없으면 "1. ${WHOLE_TRANSCRIPT_TITLE}" 한 줄`,
    pass: buildChapterizeUserMessage(resolveChapterTitles([]), transcript).includes(`1. ${WHOLE_TRANSCRIPT_TITLE}`),
    detail: "목차 목록이 전체 한 줄로 렌더",
  });

  // 목차 없음 zod: "전체" 단일 챕터를 통과시키고, 그 갈래에서도 목차 밖 titleEn은 거부한다(창작 금지 유지)
  const wholeSchema = makeChapterizationSchema({ chapterTitles: resolveChapterTitles([]) });
  const wholeGood = {
    chapters: [
      {
        titleEn: WHOLE_TRANSCRIPT_TITLE,
        matched: true,
        sentences: [sent(GROUNDED_EN[0], "그는 인사하러 토끼네 집으로 걸어갔어요."), sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요.")],
      },
    ],
  };
  results.push({
    book,
    check: "목차 없음 zod: 단일 '전체' 챕터 통과",
    pass: wholeSchema.safeParse(wholeGood).success,
    detail: wholeSchema.safeParse(wholeGood).success ? "통과" : JSON.stringify(wholeSchema.safeParse(wholeGood).error?.issues?.slice(0, 3)),
  });
  results.push({
    book,
    check: "목차 없음 zod: titleEn이 '전체'가 아니면 거부(창작 금지 유지)",
    pass: !wholeSchema.safeParse({ chapters: [{ titleEn: "Chapter 1", matched: true, sentences: [sent(GROUNDED_EN[2], "푸는 구멍에 끼었어요.")] }] }).success,
    detail: "목차 없음 갈래에서도 목차 밖 제목 거부",
  });

  // 목차 없음 grounding: 단일 챕터에서도 자막 밖 문장은 잘린다
  const wholeGrounded = groundChapters(
    [
      {
        titleEn: WHOLE_TRANSCRIPT_TITLE,
        matched: true,
        sentences: [sent(GROUNDED_EN[0], "그는 걸어갔어요."), sent(FABRICATED, "푸는 달에 갔어요.")],
      },
    ],
    transcript,
  );
  results.push({
    book,
    check: "목차 없음 grounding: 단일 챕터에서도 자막 밖 문장 잘라냄",
    pass: wholeGrounded.droppedSentenceCount === 1 && wholeGrounded.chapters[0].sentences.length === 1,
    detail: `dropped=${wholeGrounded.droppedSentenceCount} (기대 1), 남은 문장=${wholeGrounded.chapters[0].sentences.length} (기대 1)`,
  });

  // ── 긴 자막·목차 없음 회귀 가드(P1): "전체" 단일 챕터가 문장별로 쪼개져야 상한을 안 넘는다 ──
  // 실호출에서 모델이 문장을 안 쪼개고 거대 덩이로 뱉어 en(600)/ko(800) 상한 초과 → throw가 났다.
  // 오프라인은 모델을 못 부르므로, (a) 문장별 분할된 정상 출력이 통과하고 (b) 문단 뭉치기(상한 초과)가
  // zod에 거부되는지를 긴 픽스처로 고정 검증한다. 실제 모델 분할 여부는 team-lead의 실호출 재eval이 본다.
  const longChapters = {
    chapters: [
      {
        titleEn: WHOLE_TRANSCRIPT_TITLE,
        matched: true,
        sentences: [
          sent("One sunny morning, Winnie the Pooh felt very hungry.", "어느 화창한 아침, 위니 더 푸는 몹시 배가 고팠어요."),
          sent(GROUNDED_EN[0], "그는 인사하러 토끼네 집으로 걸어갔어요."),
          sent(GROUNDED_EN[1], "토끼는 친절하게 푸에게 꿀을 주었어요."),
          sent("Pooh loved honey so much that he ate and ate and ate.", "푸는 꿀을 너무 좋아해서 먹고 또 먹고 또 먹었어요."),
          sent(GROUNDED_EN[2], "푸는 구멍에 끼고 말았어요."),
          sent("Rabbit pushed and pushed, but Pooh would not budge.", "토끼가 밀고 또 밀었지만 푸는 꿈쩍도 하지 않았어요."),
          sent("After many days, Pooh finally became thin enough.", "여러 날이 지나 푸는 마침내 충분히 홀쭉해졌어요."),
          sent(GROUNDED_EN[3], "그는 마침내 자유로워져서 정말 행복했어요."),
        ],
      },
    ],
  };
  const longSchema = makeChapterizationSchema({ chapterTitles: resolveChapterTitles([]) });
  results.push({
    book,
    check: "긴 자막 목차없음: 문장별 분할 출력 통과(각 항목 한 문장)",
    pass: longSchema.safeParse(longChapters).success,
    detail: longSchema.safeParse(longChapters).success ? `문장 ${longChapters.chapters[0].sentences.length}개 통과` : JSON.stringify(longSchema.safeParse(longChapters).error?.issues?.slice(0, 3)),
  });
  results.push({
    book,
    check: "긴 자막 목차없음: 분할 출력의 각 en ≤ 600자·≤ 40단어(한 문장 기준)",
    pass: longChapters.chapters[0].sentences.every((s) => s.en.length <= 600 && s.en.trim().split(/\s+/).length <= 40),
    detail: `최장 en=${Math.max(...longChapters.chapters[0].sentences.map((s) => s.en.length))}자`,
  });
  // 문단 뭉치기: en이 상한(600)을 넘는 거대 덩이 → zod 거부(회귀 가드). 상한 초과가 실호출 throw의 직접 원인이었다.
  const lumpedEn = POOH_TRANSCRIPT.replace(/\s+/g, " ").trim().slice(50, 760); // 710자 영어 덩이
  results.push({
    book,
    check: "긴 자막 목차없음: 문단 뭉치기(en>600자) zod 거부(회귀 가드)",
    pass:
      lumpedEn.length > 600 &&
      !longSchema.safeParse({ chapters: [{ titleEn: WHOLE_TRANSCRIPT_TITLE, matched: true, sentences: [sent(lumpedEn, "긴 문단을 한 항목에 뭉쳐 넣은 잘못된 출력이에요.")] }] }).success,
    detail: `lumpedEn=${lumpedEn.length}자 → 거부`,
  });
  // 상한 초과 방향별 직접 가드 (en 601자 / ko 801자)
  results.push({
    book,
    check: "en 상한(600) 초과 zod 거부",
    pass: !longSchema.safeParse({ chapters: [{ titleEn: WHOLE_TRANSCRIPT_TITLE, matched: true, sentences: [sent("a".repeat(601), "짧은 해석이에요.")] }] }).success,
    detail: "en 601자 거부",
  });
  results.push({
    book,
    check: "ko 상한(800) 초과 zod 거부",
    pass: !longSchema.safeParse({ chapters: [{ titleEn: WHOLE_TRANSCRIPT_TITLE, matched: true, sentences: [sent(GROUNDED_EN[2], "가".repeat(801))] }] }).success,
    detail: "ko 801자 거부",
  });
  // 긴 자막 grounding: 문장별 분할 출력은 전부 자막 부분문자열이라 하나도 안 잘린다
  const longGrounded = groundChapters(longChapters.chapters as Chapter[], POOH_TRANSCRIPT);
  results.push({
    book,
    check: "긴 자막 목차없음: 분할 문장 전부 grounded(0개 잘림)",
    pass: longGrounded.droppedSentenceCount === 0 && longGrounded.chapters[0].sentences.length === longChapters.chapters[0].sentences.length,
    detail: `dropped=${longGrounded.droppedSentenceCount} (기대 0), 문장=${longGrounded.chapters[0].sentences.length}`,
  });

  results.push(...runChapterTitlePrepChecks());
  return results;
}

// ---------------------------------------------------------------------------
// 목차 제목 준비(§9-2) 오프라인 점검 — 실호출 0회.
//
// /api/chapterize는 A′ 목차 장면의 labelKo를 호출 F에 넘기기 전에 prepareChapterTitles를 거친다.
// 막는 경계 두 개: (1) A′는 장면을 MAX_SCENE_DIGEST_ITEMS(120)개까지 내는데 F zod는
// CHAPTERIZE_MAX_CHAPTERS(40)개까지만 받는다 — 그대로 넘기면 목차가 긴 책의 챕터화가 통째로 실패한다.
// (2) A′ 목차 labelKo는 "3장: Pooh와 꿀단지" 모양이라, 그대로 두면 챕터 리더 탭 번호(i+1)와 겹친다.
//
// 표시 일관성(QA found-defects_1 F2): 챕터 리더는 **모든** 레코드에 cleanChapterTitles(같은 정리)를 한다.
// 새 레코드는 서버가 이미 정리한 제목이라 그대로 보여야 하고(불변식 — 지울 접두어도, 겹치는 제목도 없다),
// 옛 레코드(접두어가 남은 titleEn)는 서버가 같은 목차로 지금 만들 제목과 똑같이 보여야 한다.
// 접두어 정규식 반례(F3 — 합성 수사·XL~XLIX·맨 로마 숫자·공백 없는 번호)도 여기서 잠근다.
// ---------------------------------------------------------------------------

function runChapterTitlePrepChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "목차 제목 준비(§9-2)";
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  /** 표에 넣은 입력 전부 — 멱등성·불변식 점검의 말뭉치로 다시 쓴다 */
  const stripCorpus: string[] = [];
  const table = (cases: readonly (readonly [string, string])[]) => {
    stripCorpus.push(...cases.map(([input]) => input));
    const bad = cases.filter(([input, want]) => stripChapterOrdinalPrefix(input) !== want);
    return {
      pass: bad.length === 0,
      detail:
        bad.length === 0
          ? `${cases.length}종 전부 기대대로`
          : bad.map(([input, want]) => `${JSON.stringify(input)} → ${JSON.stringify(stripChapterOrdinalPrefix(input))} (기대 ${JSON.stringify(want)})`).join(" · "),
    };
  };

  // 서수 접두어 변형 — 떼고 나머지만 남는다
  results.push({
    book,
    check: "서수 접두어 제거: 한국어(3장:·제3장·제 3 장 -·챕터 3:)·영어(Chapter 3:·Ch. 3·Chap. 4 -·Chapter IV:·Chapter One -)·번호(3.·3)·(3)·3 -)",
    ...table([
      ["3장: Pooh와 꿀단지", "Pooh와 꿀단지"],
      ["3장 꿀단지를 찾아서", "꿀단지를 찾아서"],
      ["제3장 꿀단지", "꿀단지"],
      ["제 3 장 - Honey", "Honey"],
      ["챕터 3: 꿀", "꿀"],
      ["Chapter 3: The Honey Pot", "The Honey Pot"],
      ["chapter3. Stuck", "Stuck"],
      ["CHAPTER 12 - Free at Last", "Free at Last"],
      ["Chapter 7 — Waiting", "Waiting"],
      ["Ch. 3 Pooh Visits Rabbit", "Pooh Visits Rabbit"],
      ["Ch 3: Stuck!", "Stuck!"],
      ["Chap. 4 - Rabbit", "Rabbit"],
      ["Chapter IV: Rabbit's House", "Rabbit's House"],
      ["Chapter One - Start", "Start"],
      ["3. Pooh Visits Rabbit", "Pooh Visits Rabbit"],
      ["3) Pooh", "Pooh"],
      ["(3) Pooh", "Pooh"],
      ["3 - Pooh", "Pooh"],
      ["  3장:   Stuck!  ", "Stuck!"],
      ["Chapter 3: \"The Honey Pot\"", "\"The Honey Pot\""],
    ]),
  });

  // F3-a: 하이픈·공백 합성 수사는 통째로 뗀다 — 전에는 "Twenty"만 떼서 "One: The Party"가 남았다
  results.push({
    book,
    check: "합성 수사 통째로: Chapter Twenty-One: The Party → The Party (전: One: The Party)·Thirty One·Ninety-Nine",
    ...table([
      ["Chapter Twenty-One: The Party", "The Party"],
      ["CHAPTER TWENTY-TWO - Home Again", "Home Again"],
      ["Chapter Thirty One: Snow", "Snow"],
      ["Chapter Ninety-Nine. The End", "The End"],
      ["Chapter Twenty: Owl", "Owl"],
      ["Chapter Seventeen: Eeyore", "Eeyore"],
    ]),
  });

  // F3-b: 로마 숫자 40~49(XL~XLIX)와 90~99(XC~XCIX) — 전에는 l?x{0,3} 순서라 XL을 표현하지 못했다
  results.push({
    book,
    check: "로마 숫자 XL~XLIX·XC~XCIX·LXXXIX: Chapter XLIV: Owl's House → Owl's House",
    ...table([
      ["Chapter XL: Forty Winks", "Forty Winks"],
      ["Chapter XLIV: Owl's House", "Owl's House"],
      ["Chapter XLIX. The Last Party", "The Last Party"],
      ["Chapter XC - Ninety", "Ninety"],
      ["Chapter XCIX: Almost Done", "Almost Done"],
      ["Chapter LXXXIX: Eighty-Nine", "Eighty-Nine"],
    ]),
  });

  // F3-c: "Chapter" 없이 앞에 붙은 로마 숫자 — 구분자(. : ) ]) 뒤 공백까지 있어야 뗀다("L.A. Story" 보존)
  results.push({
    book,
    check: "맨 로마 숫자: IV. Rabbit's House·XII. The Flood·XLII: Pooh Sticks·(IV) Rabbit·I. In Which…",
    ...table([
      ["IV. Rabbit's House", "Rabbit's House"],
      ["XII. The Flood", "The Flood"],
      ["XLII: Pooh Sticks", "Pooh Sticks"],
      ["(IV) Rabbit", "Rabbit"],
      ["I. In Which We Meet Pooh", "In Which We Meet Pooh"],
    ]),
  });

  // F3-d: 공백 없는 번호 — 구분자 바로 뒤가 숫자가 아니면 뗀다(1.5·3:10은 보존). 하이픈은 공백이 있어야 구분자
  results.push({
    book,
    check: "공백 없는 번호: 1.Pooh·12.Owl's House·3:Stuck·3)Pooh·7—Waiting·Chapter 7—Waiting·3장:꿀",
    ...table([
      ["1.Pooh", "Pooh"],
      ["12.Owl's House", "Owl's House"],
      ["3:Stuck", "Stuck"],
      ["3)Pooh", "Pooh"],
      ["7—Waiting", "Waiting"],
      ["Chapter 7—Waiting", "Waiting"],
      ["3장:꿀", "꿀"],
    ]),
  });

  // 겹친 접두어는 본문이 남는 동안 끝까지 뗀다 — 그래야 서버 준비값에 리더가 같은 정리를 해도 그대로다
  results.push({
    book,
    check: "겹친 접두어 끝까지: 3장: Chapter 3: The Honey Pot → The Honey Pot · 3장: Chapter 3 → Chapter 3(본문 없는 겹에서 멈춤)",
    ...table([
      ["3장: Chapter 3: The Honey Pot", "The Honey Pot"],
      ["Chapter 3: 3장: 꿀", "꿀"],
      ["1. Chapter One: Start", "Start"],
      ["3장: Chapter 3", "Chapter 3"],
    ]),
  });

  // 숫자·약어로 시작하는 진짜 제목은 건드리지 않는다 — 구분자까지 먹어야 접두어다. 못 떼는 모양은 원문 그대로
  results.push({
    book,
    check:
      "진짜 제목 보존: 1.5 Meters·3:10 to Yuma·101 Dalmatians·3 Little Pigs·3장면·Chi Chi·Chapter Ivy·Chapters·3-D·Chapter 1.5·L.A. Story·I Spy·VIP·Twenty-Something",
    ...table([
      ["1.5 Meters", "1.5 Meters"],
      ["3:10 to Yuma", "3:10 to Yuma"],
      ["101 Dalmatians", "101 Dalmatians"],
      ["3 Little Pigs", "3 Little Pigs"],
      ["3장면 이야기", "3장면 이야기"],
      ["Chi Chi's Day", "Chi Chi's Day"],
      ["Chapter Ivy Grows", "Chapter Ivy Grows"],
      ["Chapters 3 and 4", "Chapters 3 and 4"],
      ["Pooh Visits Rabbit", "Pooh Visits Rabbit"],
      ["3-D Glasses", "3-D Glasses"],
      ["Chapter 3-D Glasses", "Chapter 3-D Glasses"],
      ["Chapter 1.5: Interlude", "Chapter 1.5: Interlude"],
      ["10:30 Bedtime", "10:30 Bedtime"],
      ["L.A. Story", "L.A. Story"],
      ["I Spy Pooh", "I Spy Pooh"],
      ["VIP Party", "VIP Party"],
      ["Chapter Twenty-Something Blues", "Chapter Twenty-Something Blues"],
    ]),
  });

  // 접두어만 있는 값 — 떼면 비므로 원문을 그대로 둔다(빈 제목을 만들지 않는다)
  results.push({
    book,
    check: "접두어만 있는 값은 원문 유지: 3장·3장:·Chapter 3·Chapter IV·Chapter XL·Chapter Twenty-One·Ch. 3·3.·IV.",
    ...table([
      ["3장", "3장"],
      ["3장:", "3장:"],
      ["Chapter 3", "Chapter 3"],
      ["Chapter IV", "Chapter IV"],
      ["Chapter XL", "Chapter XL"],
      ["Chapter Twenty-One", "Chapter Twenty-One"],
      ["Ch. 3", "Ch. 3"],
      ["3.", "3."],
      ["IV.", "IV."],
    ]),
  });

  // 멱등 — 한 번 정리한 제목을 다시 정리해도 같다(리더가 새 레코드에 같은 정리를 해도 바뀌지 않는 전제)
  const notIdempotent = stripCorpus.filter((t) => {
    const once = stripChapterOrdinalPrefix(t);
    return stripChapterOrdinalPrefix(once) !== once;
  });
  results.push({
    book,
    check: `멱등: 위 표 입력 ${stripCorpus.length}종 전부 strip(strip(x)) = strip(x)`,
    pass: notIdempotent.length === 0,
    detail:
      notIdempotent.length === 0
        ? `${stripCorpus.length}종 멱등`
        : notIdempotent
            .map((t) => `${JSON.stringify(t)} → ${JSON.stringify(stripChapterOrdinalPrefix(t))} → ${JSON.stringify(stripChapterOrdinalPrefix(stripChapterOrdinalPrefix(t)))}`)
            .join(" · "),
  });

  // 빈 값·공백 → 빈 배열 → chapterizeTranscript가 "전체" 단일 챕터로 바꾼다
  const empty = prepareChapterTitles(["", "   ", "\t\n"]);
  results.push({
    book,
    check: `빈 값·공백만 → [] (→ resolveChapterTitles가 ["${WHOLE_TRANSCRIPT_TITLE}"])`,
    pass: same(empty.titles, []) && empty.groupSize === 1 && same(resolveChapterTitles(empty.titles), [WHOLE_TRANSCRIPT_TITLE]),
    detail: `titles=${JSON.stringify(empty.titles)} groupSize=${empty.groupSize}`,
  });

  // 트림·빈 값 제거·접두어 제거가 한 번에 — 접두어만 있는 값은 원문으로 남는다
  const mixed = prepareChapterTitles(["", " 1장:  Pooh   Visits Rabbit ", "  ", "2장:", "Chapter 3: Stuck!"]);
  results.push({
    book,
    check: "트림·연속 공백·빈 값 제거 + 접두어 제거(접두어만 있는 값은 원문)",
    pass: same(mixed.titles, ["Pooh Visits Rabbit", "2장:", "Stuck!"]),
    detail: JSON.stringify(mixed.titles),
  });

  // 완전 중복(같은 목차 사진을 두 번 찍음)은 버리고, 뗀 뒤에만 겹치는 제목은 " (n)"을 붙인다.
  // 전에는 접두어를 되살려("5장: 아침") 리더가 그것을 또 떼는 바람에 화면에서 겹쳤다(F2).
  const dup = prepareChapterTitles(["1장: 아침", "5장: 아침", "1장: 아침"]);
  results.push({
    book,
    check: `완전 중복 제거 · 접두어를 뗀 뒤 겹치면 " (n)" 접미사 — 접두어를 되살리지 않는다(전: ["아침","5장: 아침"])`,
    pass: same(dup.titles, ["아침", "아침 (2)"]),
    detail: JSON.stringify(dup.titles),
  });

  // F2 반례 그대로 — "1장: 아침"~"40장: 아침"이 서버에서도 화면에서도 40개 모두 다르게, 접두어 없이
  const hasOrdinal = (t: string) => /\d+\s*장\s*[:.]/u.test(t);
  const t40same = Array.from({ length: CHAPTERIZE_MAX_CHAPTERS }, (_, i) => `${i + 1}장: 아침`);
  const p40same = prepareChapterTitles(t40same);
  const want40same = Array.from({ length: CHAPTERIZE_MAX_CHAPTERS }, (_, i) => (i === 0 ? "아침" : `아침 (${i + 1})`));
  const shown40same = cleanChapterTitles(p40same.titles);
  results.push({
    book,
    check: `같은 제목 ${CHAPTERIZE_MAX_CHAPTERS}개("1장: 아침"~) → 아침·아침 (2)…아침 (40) · 화면도 40개 전부 다름(전: 전부 "아침")`,
    pass:
      same(p40same.titles, want40same) &&
      same(shown40same, want40same) &&
      new Set(shown40same).size === CHAPTERIZE_MAX_CHAPTERS &&
      !p40same.titles.some(hasOrdinal),
    detail: `서버 ${JSON.stringify(p40same.titles.slice(0, 3))}… · 화면 고유 ${new Set(shown40same).size}/${shown40same.length}`,
  });

  // 묶음에서도 같은 규칙 — "아침 / 2장: 아침"처럼 접두어가 섞이지 않는다
  const t80same = Array.from({ length: CHAPTERIZE_MAX_CHAPTERS * 2 }, (_, i) => `${i + 1}장: 아침`);
  const p80same = prepareChapterTitles(t80same);
  const J = CHAPTER_TITLE_GROUP_JOINER;
  results.push({
    book,
    check: `같은 제목 ${CHAPTERIZE_MAX_CHAPTERS * 2}개 묶음 → "아침${J}아침 (2)"·"아침 (3)${J}아침 (4)"… · 접두어 섞임 0 · 화면 그대로`,
    pass:
      p80same.groupSize === 2 &&
      p80same.titles.length === CHAPTERIZE_MAX_CHAPTERS &&
      p80same.titles[0] === `아침${J}아침 (2)` &&
      p80same.titles[1] === `아침 (3)${J}아침 (4)` &&
      p80same.titles[39] === `아침 (79)${J}아침 (80)` &&
      !p80same.titles.some(hasOrdinal) &&
      same(cleanChapterTitles(p80same.titles), p80same.titles),
    detail: `${JSON.stringify(p80same.titles.slice(0, 2))}… 끝=${JSON.stringify(p80same.titles.at(-1))}`,
  });

  // 40개 경계 — 딱 40개는 묶지 않는다
  const t40 = Array.from({ length: CHAPTERIZE_MAX_CHAPTERS }, (_, i) => `${i + 1}장: 제목${i + 1}`);
  const p40 = prepareChapterTitles(t40);
  results.push({
    book,
    check: `${CHAPTERIZE_MAX_CHAPTERS}개 = 상한: 묶지 않음(접두어만 제거)`,
    pass: p40.groupSize === 1 && p40.titles.length === CHAPTERIZE_MAX_CHAPTERS && p40.titles.every((t, i) => t === `제목${i + 1}`),
    detail: `titles=${p40.titles.length} groupSize=${p40.groupSize} 마지막=${JSON.stringify(p40.titles.at(-1))}`,
  });

  // 41개 — 2개씩 묶어 21개, 순서 보존, 마지막 하나는 홀로
  const t41 = Array.from({ length: CHAPTERIZE_MAX_CHAPTERS + 1 }, (_, i) => `Chapter ${i + 1}: T${i + 1}`);
  const p41 = prepareChapterTitles(t41);
  const flat41 = p41.titles.flatMap((t) => t.split(CHAPTER_TITLE_GROUP_JOINER));
  results.push({
    book,
    check: `${CHAPTERIZE_MAX_CHAPTERS + 1}개 → ceil(41/40)=2개씩 묶어 21개 · 순서 보존 · 유실 0`,
    pass:
      p41.groupSize === 2 &&
      p41.titles.length === 21 &&
      p41.titles[0] === `T1${CHAPTER_TITLE_GROUP_JOINER}T2` &&
      p41.titles[20] === "T41" &&
      same(flat41, Array.from({ length: 41 }, (_, i) => `T${i + 1}`)),
    detail: `titles=${p41.titles.length} groupSize=${p41.groupSize} 첫=${JSON.stringify(p41.titles[0])} 끝=${JSON.stringify(p41.titles.at(-1))}`,
  });

  // A′ 상한(120개) — 3개씩 묶어 정확히 40개, 순서 보존
  const t120 = Array.from({ length: MAX_SCENE_DIGEST_ITEMS }, (_, i) => `${i + 1}. T${i + 1}`);
  const p120 = prepareChapterTitles(t120);
  const flat120 = p120.titles.flatMap((t) => t.split(CHAPTER_TITLE_GROUP_JOINER));
  results.push({
    book,
    check: `A′ 상한 ${MAX_SCENE_DIGEST_ITEMS}개 → 3개씩 묶어 ${CHAPTERIZE_MAX_CHAPTERS}개 · 순서 보존 · 유실 0`,
    pass:
      p120.groupSize === 3 &&
      p120.titles.length === CHAPTERIZE_MAX_CHAPTERS &&
      same(flat120, Array.from({ length: MAX_SCENE_DIGEST_ITEMS }, (_, i) => `T${i + 1}`)),
    detail: `titles=${p120.titles.length} groupSize=${p120.groupSize} 첫=${JSON.stringify(p120.titles[0])}`,
  });

  // 긴 labelKo(SCENE_LABEL_KO_MAX)를 3개 묶으면 titleEn 상한을 넘는다 — 줄여서 상한·유일성을 지킨다
  const longLabels = Array.from({ length: MAX_SCENE_DIGEST_ITEMS }, (_, i) => {
    const head = `${i + 1}장: `;
    return `${head}${"가".repeat(SCENE_LABEL_KO_MAX - head.length - String(i).length)}${i}`;
  });
  const pLong = prepareChapterTitles(longLabels);
  results.push({
    book,
    check: `묶은 제목이 CHAPTER_TITLE_MAX(${CHAPTER_TITLE_MAX}) 이하 · 서로 유일 · ${CHAPTERIZE_MAX_CHAPTERS}개`,
    pass:
      longLabels.every((l) => l.length <= SCENE_LABEL_KO_MAX) &&
      pLong.titles.length === CHAPTERIZE_MAX_CHAPTERS &&
      pLong.titles.every((t) => t.length <= CHAPTER_TITLE_MAX) &&
      new Set(pLong.titles.map((t) => t.toLowerCase())).size === pLong.titles.length,
    detail: `최장=${Math.max(...pLong.titles.map((t) => t.length))}자, 유일=${new Set(pLong.titles).size}/${pLong.titles.length}`,
  });

  // 불변식 — 리더는 모든 레코드에 cleanChapterTitles를 하지만, 서버가 준비한 제목(새 레코드)은 바뀌지 않는다.
  // 접두어만 있는 제목에 " (n)"이나 " / "가 붙어도("3장 (2)", "Chapter 1 / Chapter 2") 다시 떼지 않는다.
  const invariantCorpora: readonly (readonly [string, readonly string[]])[] = [
    ["표 입력 전부(묶음)", stripCorpus],
    ["표 입력 앞 40개", stripCorpus.slice(0, CHAPTERIZE_MAX_CHAPTERS)],
    ["같은 제목 40", t40same],
    ["같은 제목 80(묶음)", t80same],
    ["접두어만+겹침", ["1장: 3장", "3장", "Chapter 3", "3장: Chapter 3", "Ch. 3"]],
    ["기호 본문+겹침", ["1장: 3장: ★", "3장: ★", "Chapter 1: …", "2. …"]],
    ["접두어만 41(묶음)", Array.from({ length: CHAPTERIZE_MAX_CHAPTERS + 1 }, (_, i) => `Chapter ${i + 1}`)],
    ["41·120·긴 labelKo", [...t41, ...t120, ...longLabels]],
  ];
  const invariantBad: string[] = [];
  for (const [label, corpus] of invariantCorpora) {
    const prepared = prepareChapterTitles(corpus).titles;
    const shown = cleanChapterTitles(prepared);
    const i = prepared.findIndex((t, k) => shown[k] !== t || stripChapterOrdinalPrefix(t) !== t);
    if (i >= 0) {
      invariantBad.push(`${label}: 서버 ${JSON.stringify(prepared[i])} → 화면 ${JSON.stringify(shown[i])} / strip ${JSON.stringify(stripChapterOrdinalPrefix(prepared[i]))}`);
    }
  }
  results.push({
    book,
    check: `불변식: 서버 준비값에 리더 정리(cleanChapterTitles)를 해도 그대로 — 말뭉치 ${invariantCorpora.length}종`,
    pass: invariantBad.length === 0,
    detail: invariantBad.length === 0 ? `${invariantCorpora.length}종 전부 화면=서버` : invariantBad.join(" · "),
  });

  // 옛 레코드(접두어가 남은 titleEn) — 리더 표시가 같은 목차로 서버가 지금 만들 제목과 같다
  const oldRecord = ["1장: 아침", "2장: 점심", "5장: 아침", "Chapter 4: Stuck!", "3장"];
  const oldShown = cleanChapterTitles(oldRecord);
  results.push({
    book,
    check: `옛 레코드 표시 = 지금 서버 준비값: ["1장: 아침","2장: 점심","5장: 아침",…] → ["아침","점심","아침 (2)",…] · "${WHOLE_TRANSCRIPT_TITLE}"는 그대로`,
    pass:
      same(oldShown, ["아침", "점심", "아침 (2)", "Stuck!", "3장"]) &&
      same(oldShown, prepareChapterTitles(oldRecord).titles) &&
      same(cleanChapterTitles([WHOLE_TRANSCRIPT_TITLE]), [WHOLE_TRANSCRIPT_TITLE]),
    detail: `화면=${JSON.stringify(oldShown)} 서버=${JSON.stringify(prepareChapterTitles(oldRecord).titles)}`,
  });

  // 직전 준비 규칙(충돌 시 접두어 되살림)으로 저장된 레코드도 화면에서 겹치지 않는다(F2 반례의 저장값)
  const revived = ["아침", ...Array.from({ length: CHAPTERIZE_MAX_CHAPTERS - 1 }, (_, i) => `${i + 2}장: 아침`)];
  const revivedShown = cleanChapterTitles(revived);
  results.push({
    book,
    check: `접두어를 되살려 저장된 ${CHAPTERIZE_MAX_CHAPTERS}개(["아침","2장: 아침",…]) → 화면 40개 전부 다름(전: 전부 "아침")`,
    pass: new Set(revivedShown).size === CHAPTERIZE_MAX_CHAPTERS && same(revivedShown, want40same),
    detail: `화면 고유 ${new Set(revivedShown).size}/${revivedShown.length} · ${JSON.stringify(revivedShown.slice(0, 3))}…`,
  });

  // 배선 — 챕터 리더가 표시 제목을 cleanChapterTitles 하나로 만든다. 제목마다 stripChapterOrdinalPrefix를 따로
  // 부르거나 titleEn을 그대로 그리면 위 불변식·옛 레코드 표시가 화면에 닿지 않는다(순수 함수 점검이 못 보는 틈).
  const readerSrc = readFileSync(new URL("../components/chapter-reader.tsx", import.meta.url), "utf-8");
  const readerWiring = {
    usesClean: /cleanChapterTitles\(/.test(readerSrc),
    noPerTitleStrip: !readerSrc.includes("stripChapterOrdinalPrefix"),
    noRawTitle: !/\{\s*\w+\.titleEn\s*\}/.test(readerSrc),
  };
  results.push({
    book,
    check: "배선: chapter-reader가 탭·헤딩 제목을 cleanChapterTitles로 만든다(제목마다 strip·titleEn 직접 렌더 없음)",
    pass: readerWiring.usesClean && readerWiring.noPerTitleStrip && readerWiring.noRawTitle,
    detail: JSON.stringify(readerWiring),
  });

  // 경계면 — 준비한 제목이면 F zod가 전부 echo를 받는다. 준비 전 120개 그대로면 zod가 거부한다(이번 결함)
  const echo = (titles: readonly string[]) => ({
    chapters: titles.map((titleEn) => ({ titleEn, matched: false, sentences: [] })),
  });
  const rawSchema = makeChapterizationSchema({ chapterTitles: t120 });
  const preparedSchema = makeChapterizationSchema({ chapterTitles: pLong.titles });
  results.push({
    book,
    check: `경계면: 준비 전 ${MAX_SCENE_DIGEST_ITEMS}개 echo는 F zod 거부 → 준비 후 ${CHAPTERIZE_MAX_CHAPTERS}개 echo는 통과`,
    pass: !rawSchema.safeParse(echo(t120)).success && preparedSchema.safeParse(echo(pLong.titles)).success,
    detail: `raw=${rawSchema.safeParse(echo(t120)).success ? "통과(기대 거부)" : "거부"}, prepared=${preparedSchema.safeParse(echo(pLong.titles)).success ? "통과" : JSON.stringify(preparedSchema.safeParse(echo(pLong.titles)).error?.issues?.slice(0, 2))}`,
  });

  return results;
}

// ---------------------------------------------------------------------------
// 호출 G(단어 뜻 조회, §10) 오프라인 점검 — 실호출 0회.
// zod 계약(짧게·한글만·영어 연속 금지)과 JSON Schema strict 형태를 고정 입력으로 검사한다.
// 실제 뜻의 정확성(맥락 반영)은 모델 출력이 있어야 재현되므로 실호출 게이트(EVAL_WORDMEANING=1)가 본다.
// ---------------------------------------------------------------------------

function runWordMeaningChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "단어뜻(§10)";

  // 정상 출력: 짧은 한글 뜻 하나 (다의어 문맥 반영 예시)
  for (const ko of ["울부짖었다", "떠났다", "왼쪽"]) {
    const ok = wordMeaningSchema.safeParse({ meaningKo: ko }).success;
    results.push({
      book,
      check: `zod: 정상 뜻 통과 ("${ko}")`,
      pass: ok,
      detail: ok ? "통과" : JSON.stringify(wordMeaningSchema.safeParse({ meaningKo: ko }).error?.issues?.slice(0, 2)),
    });
  }

  // zod 거부 케이스 — 각각 계약 하나씩 위반
  const rejectCases: { name: string; meaningKo: unknown }[] = [
    { name: "빈 문자열", meaningKo: "" },
    { name: "공백만", meaningKo: "   " },
    { name: `길이 초과(>${WORD_MEANING_KO_MAX}자)`, meaningKo: "아".repeat(WORD_MEANING_KO_MAX + 1) },
    { name: "한글 없는 영어 echo(bellowed)", meaningKo: "bellowed" },
    { name: "영어 낱말 2개 연속(he bellowed)", meaningKo: "he bellowed 울부짖었다" },
    { name: "타입 위반(문자열 아님)", meaningKo: 123 },
  ];
  for (const rc of rejectCases) {
    const rejected = !wordMeaningSchema.safeParse({ meaningKo: rc.meaningKo }).success;
    results.push({ book, check: `zod 거부: ${rc.name}`, pass: rejected, detail: rejected ? "거부됨" : "통과되면 안 됨" });
  }

  // 한글에 영어 낱말 1개가 섞이는 것은 허용 (고유명사 등) — run 2 미만은 통과해야 한다
  const oneEnglishOk = wordMeaningSchema.safeParse({ meaningKo: "TV를 봤다" }).success;
  results.push({
    book,
    check: "zod: 한글+영어 낱말 1개는 허용 (\"TV를 봤다\")",
    pass: oneEnglishOk,
    detail: oneEnglishOk ? "통과" : "허용돼야 하는데 거부됨",
  });

  // JSON Schema 형태 — strict·additionalProperties:false·required meaningKo (Structured Outputs 계약)
  const js = WORD_MEANING_JSON_SCHEMA;
  const schemaObj = js.schema as {
    additionalProperties?: unknown;
    required?: unknown;
    properties?: { meaningKo?: { type?: unknown } };
  };
  const shapeOk =
    js.name === "word_meaning" &&
    js.strict === true &&
    schemaObj.additionalProperties === false &&
    Array.isArray(schemaObj.required) &&
    (schemaObj.required as string[]).length === 1 &&
    (schemaObj.required as string[])[0] === "meaningKo" &&
    schemaObj.properties?.meaningKo?.type === "string"; // 선택키·null 유니온 없음
  results.push({
    book,
    check: "JSON Schema: strict·additionalProperties:false·required meaningKo(string, non-null)",
    pass: shapeOk,
    detail: shapeOk ? "형태 정합" : JSON.stringify(js),
  });

  return results;
}

// ---------------------------------------------------------------------------
// 호출 H(유의어·반의어 추천, §11) 오프라인 점검 — 실호출 0회.
// zod 계약(영어 낱말·한글 뜻·개수)과 JSON Schema strict 형태, 그리고 후처리(표제어 제외·중복·빈값)를
// 고정 입력으로 검사한다. kind 정확성·뜻 반영·초등 눈높이는 의미 판단이라 실호출 프로브가 본다(§11-7).
// ---------------------------------------------------------------------------

function runRelatedSuggestChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "유의어추천(§11)";

  // 정상 출력: 영어 낱말 + 한글 뜻 후보 5개 (하이픈 낱말 포함 — 낱말 형식 통과 확인)
  {
    const ok = relatedSuggestionSchema.safeParse({
      candidates: [
        { word: "glad", glossKo: "기쁜" },
        { word: "joyful", glossKo: "즐거운" },
        { word: "cheerful", glossKo: "명랑한" },
        { word: "well-known", glossKo: "잘 알려진" },
        { word: "merry", glossKo: "유쾌한" },
      ],
    }).success;
    results.push({ book, check: "zod: 정상 후보(영어 낱말·한글 뜻·하이픈 허용) 통과", pass: ok, detail: ok ? "통과" : "거부되면 안 됨" });
  }

  // zod 거부 케이스 — 각각 계약 하나씩 위반
  const rejectCases: { name: string; input: unknown }[] = [
    { name: "빈 배열(후보 0개)", input: { candidates: [] } },
    { name: "word에 공백(구·문장)", input: { candidates: [{ word: "very big", glossKo: "아주 큰" }] } },
    { name: "word에 문장부호", input: { candidates: [{ word: "large.", glossKo: "큰" }] } },
    { name: "word에 한글", input: { candidates: [{ word: "큰", glossKo: "큰" }] } },
    { name: "word에 숫자", input: { candidates: [{ word: "big2", glossKo: "큰" }] } },
    { name: "glossKo 한글 없음(영어 echo)", input: { candidates: [{ word: "large", glossKo: "big" }] } },
    { name: "glossKo 빈 문자열", input: { candidates: [{ word: "large", glossKo: "" }] } },
    {
      name: `개수 초과(>${RELATED_SUGGEST_MAX_CANDIDATES})`,
      input: { candidates: Array.from({ length: RELATED_SUGGEST_MAX_CANDIDATES + 1 }, (_, i) => ({ word: `word${"a".repeat(i + 1)}`, glossKo: "뜻" })) },
    },
  ];
  for (const rc of rejectCases) {
    const rejected = !relatedSuggestionSchema.safeParse(rc.input).success;
    results.push({ book, check: `zod 거부: ${rc.name}`, pass: rejected, detail: rejected ? "거부됨" : "통과되면 안 됨" });
  }

  // JSON Schema 형태 — strict·additionalProperties:false·required candidates + item required word/glossKo
  {
    const js = RELATED_SUGGESTION_JSON_SCHEMA;
    const s = js.schema as {
      additionalProperties?: unknown;
      required?: unknown;
      properties?: { candidates?: { type?: unknown; items?: { additionalProperties?: unknown; required?: unknown; properties?: Record<string, { type?: unknown }> } } };
    };
    const item = s.properties?.candidates?.items;
    const shapeOk =
      js.name === "related_suggestion" &&
      js.strict === true &&
      s.additionalProperties === false &&
      Array.isArray(s.required) &&
      (s.required as string[]).join(",") === "candidates" &&
      s.properties?.candidates?.type === "array" &&
      item?.additionalProperties === false &&
      Array.isArray(item?.required) &&
      (item?.required as string[]).slice().sort().join(",") === "glossKo,word" &&
      item?.properties?.word?.type === "string" &&
      item?.properties?.glossKo?.type === "string";
    results.push({
      book,
      check: "JSON Schema: strict·additionalProperties:false·required candidates/word/glossKo(개수·길이 제약 없음)",
      pass: shapeOk,
      detail: shapeOk ? "형태 정합" : JSON.stringify(js),
    });
  }

  // 후처리: 표제어 자신 제외(대소문자 무시) + 중복 제거(첫 등장 유지) + 빈값 제거
  {
    const raw: RelatedCandidate[] = [
      { word: "Big", glossKo: "큰" }, // 표제어(big)와 대소문자만 다름 → 제외
      { word: "large", glossKo: "큰" },
      { word: "large", glossKo: "다른 뜻" }, // 중복 → 첫 등장만
      { word: "  ", glossKo: "빈값" }, // 공백만 → 제외
      { word: "huge", glossKo: "아주 큰" },
    ];
    const cleaned = postprocessRelatedCandidates(raw, "big");
    const words = cleaned.map((c) => c.word);
    const ok =
      words.length === 2 &&
      words[0] === "large" &&
      words[1] === "huge" &&
      cleaned.find((c) => c.word === "large")?.glossKo === "큰"; // 첫 등장 유지
    results.push({
      book,
      check: "후처리: 표제어 자신 제외·중복 제거(첫 등장 유지)·빈값 제거",
      pass: ok,
      detail: `결과=[${words.join(", ")}] (기대 [large, huge])`,
    });
  }

  // 후처리: 통과분은 순서·내용 보존(거를 것이 없으면 그대로)
  {
    const raw: RelatedCandidate[] = [
      { word: "sad", glossKo: "슬픈" },
      { word: "unhappy", glossKo: "불행한" },
    ];
    const cleaned = postprocessRelatedCandidates(raw, "happy");
    const ok = cleaned.length === 2 && cleaned[0].word === "sad" && cleaned[1].word === "unhappy";
    results.push({ book, check: "후처리: 거를 것 없으면 순서·내용 보존", pass: ok, detail: `결과=[${cleaned.map((c) => c.word).join(", ")}]` });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 자유대화(§12) 오프라인 점검 — 실호출 0회. 픽스처는 전부 지어낸 영어·한국어다(은우의 실제 발화를 저장하지 않는다).
// - 스펙 대조: 호출 I JSON Schema 의미 동치·호출 옵션 문장·세션 설정 표의 값(프롬프트 원문 7개는 SPEC_SYNC_TARGETS가 본다)
// - 지시문 조립(프리셋·직접 입력 정리·단어장 20개 상한·뜻 없는 단어)·세션 설정(env 빈 값 폴백·속도 두 값·전사 무유도)
// - 리듀서(늦게 온 은우 전사의 자리·멱등·cancelled→interrupted·빈 전사·실패·app_ 제외·모르는 이벤트 무시)·toTalkTurns·문장 나누기
// - 호출 I zod 반례·사용자 메시지 문맥 창·설명 낭독 대본·스트릭 입력(§17-9 — 라우트 배선 점검은 eval:streak 몫)
// - §12-6 화면 카드: 장면 표·도구 호출 검사(항목 단위로 버림 — 폐기 예정, 컨트롤러가 아직 부른다)·도움 상태 기계(시계는 인자)·장면 문장·✓ 매칭
// - §12-7 호출 J: JSON Schema 의미 동치·세션에 도구 없음·지시문 = 교사 + 차례 규칙·사용자 메시지·zod(타입·폭만)·후처리(근거 없는 그림
//   카드 null·이미 보인 카드 null·한글 섞인 대답 버림·s/es 허용)·출처 태깅·철 지난 도움 버림·정적 점검(세션 설정 쪽 지금, 컨트롤러는 보류)
// ---------------------------------------------------------------------------

type TalkAdd = (check: string, pass: boolean, detail?: string) => void;
function talkAdder(results: CheckResult[], book: string): TalkAdd {
  return (check, pass, detail = "") => results.push({ book, check, pass, detail: detail || (pass ? "통과" : "실패") });
}

/** 순서 무관 깊은 동치 — JSON Schema 의미 비교용(일본어·토익 eval과 같은 관용구) */
function talkDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => talkDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && talkDeepEqual(ao[k], bo[k]));
}

/** 스펙 대조 — JSON Schema 의미 동치 + 호출 옵션 문장 + §12-1 세션 설정 표 값 */
function runTalkSpecChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 ↔ 스펙");
  // 1. talk_sentence_explanation(§12-3)·talk_screen_cards(§12-7) JSON Schema — 스펙 코드블록을 JSON으로 파싱해 deep-equal
  let specSchema: unknown;
  let specCardsSchema: unknown;
  let specText = "";
  try {
    specText = readFileSync(ENGLISH_SPEC_URL, "utf-8");
    for (const b of extractSpecBlocks(ENGLISH_SPEC_URL)) {
      try {
        const parsed = JSON.parse(b.text) as { name?: unknown };
        if (parsed && typeof parsed === "object" && parsed.name === "talk_sentence_explanation") specSchema = parsed;
        if (parsed && typeof parsed === "object" && parsed.name === "talk_screen_cards") specCardsSchema = parsed;
      } catch {
        // JSON 아닌 블록은 건너뛴다
      }
    }
  } catch (e) {
    add("스펙 읽기", false, e instanceof Error ? e.message : String(e));
    return results;
  }
  add(
    "TALK_SENTENCE_EXPLANATION_JSON_SCHEMA ↔ §12-3 의미 동치",
    specSchema !== undefined && talkDeepEqual(specSchema, TALK_SENTENCE_EXPLANATION_JSON_SCHEMA),
    specSchema === undefined ? "스펙에서 talk_sentence_explanation 블록을 찾지 못함" : "",
  );
  // strict 모양(선택 키 없음·개수 제약 없음) — 의미 동치가 이미 잠그지만 규약을 이름으로 남긴다
  const js = JSON.stringify(TALK_SENTENCE_EXPLANATION_JSON_SCHEMA);
  add("JSON Schema에 minItems·maxItems·maxLength 없음(개수·길이는 zod)", !/minItems|maxItems|maxLength|minLength/.test(js));

  // 2. 호출 옵션 — 스펙 문장 "call `talk_explain`, temperature 0.5, max_output_tokens 1500"
  const m = /TALK_EXPLAIN_CALL_OPTIONS`\)\*\*: call `([^`]+)`, temperature ([\d.]+), max_output_tokens (\d+)/.exec(specText);
  add(
    "호출 옵션 == 스펙 §12-3 (call·temperature·max_output_tokens)",
    !!m &&
      m[1] === TALK_EXPLAIN_CALL_OPTIONS.call &&
      Number(m[2]) === TALK_EXPLAIN_CALL_OPTIONS.temperature &&
      Number(m[3]) === TALK_EXPLAIN_CALL_OPTIONS.maxOutputTokens,
    m ? `스펙 ${m[1]}/${m[2]}/${m[3]} · 코드 ${TALK_EXPLAIN_CALL_OPTIONS.call}/${TALK_EXPLAIN_CALL_OPTIONS.temperature}/${TALK_EXPLAIN_CALL_OPTIONS.maxOutputTokens}` : "스펙 문장을 못 찾음",
  );

  // 3. §12-1 세션 설정 표의 값 — 스펙 문장에 코드 값이 그대로 있는가(숫자·기본값 드리프트 방지)
  const tableFacts: [string, string][] = [
    ["기본 모델", `빈 값이면 \`${DEFAULT_TALK_REALTIME_MODEL}\``],
    ["기본 음성", `빈 값이면 \`${DEFAULT_TALK_REALTIME_VOICE}\``],
    ["기본 전사 모델", `빈 값이면 ${DEFAULT_TALK_TRANSCRIBE_MODEL}`],
    ["전사 언어", `language: "${TALK_TRANSCRIBE_LANGUAGE}" }\`, **prompt·keywords 지정 없음**`],
    ["max_output_tokens", `| \`max_output_tokens\` | ${TALK_REALTIME_MAX_OUTPUT_TOKENS} |`],
    ["속도 두 값", `천천히 ${TALK_SPEED_VALUES.slow}(기본) · 보통 ${TALK_SPEED_VALUES.normal.toFixed(1)}`],
    ["턴 감지", `\`{ type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: false }\``],
    ["끼어들기 판정 700ms", `**${TALK_BARGE_IN_MIN_MS}ms**(\`TALK_BARGE_IN_MIN_MS\`)`],
    ["끼어들기 덩어리 틈 250ms", `**${TALK_BARGE_IN_GAP_MS}ms**(\`TALK_BARGE_IN_GAP_MS\`)`],
    ["끼어들기 문턱 하한", `**${TALK_BARGE_IN_MIN_THRESHOLD_DB} dBFS**(\`TALK_BARGE_IN_MIN_THRESHOLD_DB\`)`],
    ["끼어들기 문턱 여유", `**${TALK_BARGE_IN_MARGIN_DB} dB**(\`TALK_BARGE_IN_MARGIN_DB\`)`],
    ["기기 레벨 미터 간격", `**${TALK_LEVEL_POLL_MS}ms**(\`TALK_LEVEL_POLL_MS\`)`],
    ["닫힌 동안 끝난 말 응답 취소 1.5초", `**${(TALK_AUTO_REPLY_WAIT_MS / 1000).toFixed(1)}초**(\`TALK_AUTO_REPLY_WAIT_MS\``],
    ["소음 억제", `\`{ type: "far_field" }\``],
    ["저장 상한", `상한: 턴 ${TALK_LIMITS.turns}개, 턴 글자 ${TALK_LIMITS.turnChars.toLocaleString("en-US")}자, 설명 ${TALK_LIMITS.explanations}개`],
    ["단어장 상한", `**최대 ${TALK_LIMITS.vocabWords}개**`],
    ["직접 입력 상한", `1~${TALK_CUSTOM_TOPIC_MAX_CHARS}자`],
  ];
  // §12-3 zod 폭 — 스펙 문장에 코드 상수가 그대로 있는가(상수를 바꾸면 스펙과 어긋난 것이 여기서 드러난다, QA talk-ai P2-2)
  const L = TALK_EXPLAIN_LIMITS;
  tableFacts.push(
    ["zod 조각 수", `\`script\` ${L.scriptMin}~${L.scriptMax}조각`],
    ["zod ko 조각 글자", `**라틴 문자 금지**, ${L.koPieceMaxChars}자 이하`],
    ["zod en 조각 단어", `한글 금지, ${L.enPieceMaxWords}단어 이하`],
    ["zod ko 글자 합", `ko 조각 글자 합 ${L.koTotalMaxChars}자 이하`],
    ["zod betterEn 단어", `라틴 포함·한글 금지·${L.betterEnMaxWords}단어 이하`],
    ["zod keyWords 개수", `\`keyWords\` 0~${L.keyWordsMax}개`],
    ["zod keyWords.ko 글자", `\`ko\`는 한글 포함 ${L.keyWordKoMaxChars}자 이하`],
  );
  // §12-6 화면 카드 — 검사 폭·시간·보관 수·기본 문구·장면 앞머리·지시문 이음(도구·이어 말하기 문장은 §12-7이 대체 — 상수와 함께 지웠다)
  const C = TALK_CARD_LIMITS;
  tableFacts.push(
    ["카드 answers 폭", `\`answers\` ${C.answersMin}~${C.answersMax}개(각 ${C.answerMaxChars}자 이하·라틴 포함·한글 금지)`],
    ["카드 words 폭", `\`words\` 0~${C.wordsMax}개(\`emoji\` ${C.emojiMinChars}~${C.emojiMaxChars}자 비어 있지 않음, \`en\` 라틴 ${C.enMaxChars}자 이하, \`ko\` 한글 ${C.koMaxChars}자 이하)`],
    ["도움 카드 5초", `**${TALK_HINT_SHOW_AFTER_MS / 1000}초** 동안 은우 발화`],
    ["도움 요청 12초", `**${TALK_HINT_NUDGE_AFTER_MS / 1000}초** 동안 계속 조용하면`],
    ["도움 요청 연속 상한", `도움 요청(12초 자동·🙋 합산)은 **연속 ${TALK_HINT_NUDGE_STREAK_MAX}번**까지다`],
    ["기록 카드 30장", `보인 카드를 최대 ${C.savedCardsMax}장 남긴다`],
    ["저장 모델 cards 30", `\`cards: {emoji, en, ko}[]\`(최대 ${TALK_LIMITS.cards})`],
    ["칩 6장", `최근 ${C.recentChips}장까지`],
    ["기본 문구 4개", TALK_FALLBACK_HINTS.map((h) => `\`${h.en}\``).join("·")],
    ["직접 입력 장면", `\`${TALK_SCENE_CUSTOM_PREFIX}{주제}\``],
    ["단어장 장면", `\`${TALK_SCENE_WORDS_PREFIX}{앞 ${TALK_SCENE_VOCAB_WORDS}개 단어를 "${TALK_SCENE_WORDS_JOINER}"로}\``],
    ["지시문 이음(§12-7 차례 규칙)", `(\`{lesson}\` 치환) + \`${JSON.stringify(TALK_TURN_RULES_JOINER)}\` + **\`TALK_TURN_RULES\`**`],
    ["일러스트 품질", `**품질 ${TALK_IMAGE_QUALITY}**`],
    [
      "일러스트 크기·압축·재생성",
      `${TALK_IMAGE_SIZE.replace("x", "×")}, JPEG 압축 ${TALK_IMAGE_COMPRESSION}, ${TALK_SCENE_DATA_URL_MAX.toLocaleString("en-US")}자 초과 시 압축 ${TALK_IMAGE_COMPRESSION_RETRY}으로 1회 재생성`,
    ],
  );
  // §12-7 호출 J — 호출 옵션·시간 상한·zod 폭·후처리 폭·입력 개수(스펙 문장을 needle로 — 상수를 바꾸면 스펙과 함께 바꾼다)
  const J = TALK_SCREEN_CARDS_ZOD_LIMITS;
  const R = TALK_CARDS_REQUEST_LIMITS;
  tableFacts.push(
    [
      "호출 J 옵션·시간 상한",
      `call \`${TALK_CARDS_CALL_OPTIONS.call}\`, temperature ${TALK_CARDS_CALL_OPTIONS.temperature}, max_output_tokens ${TALK_CARDS_CALL_OPTIONS.maxOutputTokens}, 모델 env \`OPENAI_TALK_CARDS_MODEL\``,
    ],
    ["호출 J 서버 시간 상한", `서버 시간 상한 ${TALK_CARDS_TIMEOUT_MS / 1000}초`],
    ["호출 J zod 개수", `zod: \`answers\` 0~${J.answersMax}, \`words\` 0~${J.wordsMax}, 문자열 길이 상한`],
    ["호출 J 후처리 answers", `\`answers\`는 ${C.answersMax}개·단어 ${TALK_SCREEN_ANSWER_WORDS.min}~${TALK_SCREEN_ANSWER_WORDS.max}개로 자른다`],
    ["호출 J {words} 모양·개수", `\`apple(사과)${TALK_CARDS_LIST_JOINER}dog(강아지)…\`(최대 ${R.words}), 아니면 \`${TALK_CARDS_NONE}\``],
    ["호출 J {shown} 개수", `그림 카드 영어 목록(최근 ${R.shown}개), 없으면 \`${TALK_CARDS_NONE}\``],
    ["호출 J {context} 줄 수", `선생님 줄 앞의 최근 ${R.context}줄`],
    ["세션 설정 도구 없음", "세션 설정: `tools`·`tool_choice`를 싣지 않는다"],
    ["출처 값", "`reply`(은우 발화 뒤 자동 응답) · `greeting` · `nudge`(도움 요청) · `wrapup`"],
  );
  for (const [name, needle] of tableFacts) add(`§12 값 == 코드: ${name}`, specText.includes(needle), needle);
  add(
    "호출 J 출처 값 = TALK_TURN_ORIGINS(reply·greeting·nudge·wrapup)",
    TALK_TURN_ORIGINS.join(",") === "reply,greeting,nudge,wrapup",
    TALK_TURN_ORIGINS.join(","),
  );
  add(
    "호출 J 입력 폭 = 저장 상한 한 곳(단어 수 = TALK_LIMITS.vocabWords · 줄 글자 = TALK_LIMITS.turnChars · 보인 카드 글자 = 카드 영어 폭)",
    R.words === TALK_LIMITS.vocabWords && R.lineMaxChars === TALK_LIMITS.turnChars && R.shownMaxChars === C.enMaxChars,
    `${R.words}/${R.lineMaxChars}/${R.shownMaxChars}`,
  );
  add(
    "호출 J zod 폭은 후처리 폭 이상(zod가 먼저 거부해 재요청으로 카드를 늦추지 않게)",
    J.answersMax >= C.answersMax && J.wordsMax >= C.wordsMax && J.answerMaxChars >= C.answerMaxChars && J.emojiMaxChars >= C.emojiMaxChars * 2 && J.enMaxChars >= C.enMaxChars && J.koMaxChars >= C.koMaxChars,
  );
  add("대화 상한 5분 == TALK_MAX_DURATION_SEC", TALK_MAX_DURATION_SEC === 300 && TALK_LIMITS.maxDurationSec === TALK_MAX_DURATION_SEC, String(TALK_MAX_DURATION_SEC));
  add("기록 카드 상한은 한 곳(TALK_LIMITS.cards = TALK_CARD_LIMITS.savedCardsMax)", TALK_LIMITS.cards === TALK_CARD_LIMITS.savedCardsMax);

  // 4. §12-7 호출 J — talk_screen_cards JSON Schema 의미 동치(§12-6 도구 정의 TALK_TOOLS를 대체 — 세션에 도구가 없다)
  add(
    "TALK_SCREEN_CARDS_JSON_SCHEMA ↔ §12-7 의미 동치",
    specCardsSchema !== undefined && talkDeepEqual(specCardsSchema, TALK_SCREEN_CARDS_JSON_SCHEMA),
    specCardsSchema === undefined ? "스펙에서 talk_screen_cards 블록을 찾지 못함" : "",
  );
  const mutated = JSON.parse(JSON.stringify(TALK_SCREEN_CARDS_JSON_SCHEMA)) as { schema: { required: string[] } };
  mutated.schema.required = ["words", "answers", "picture"];
  add("호출 J 의미 동치 비교기가 실제로 작동(required 순서만 바꿔도 불일치)", specCardsSchema !== undefined && !talkDeepEqual(specCardsSchema, mutated));
  add(
    "호출 J JSON에 개수·길이 키 없음(개수·길이는 zod, 근거는 후처리)",
    !/minItems|maxItems|maxLength|minLength/.test(JSON.stringify(TALK_SCREEN_CARDS_JSON_SCHEMA)),
  );

  // spec-sync block-exact — 두 블록을 이어 붙인 상수는 조립 규칙("block")으로는 통과하지만 block-exact는 거부한다(QA talk-ai P2-4)
  const glued = `${TALK_TEACHER_INSTRUCTIONS}\n\n${TALK_TURN_RULES}`;
  const probe = (mode: SpecSyncTarget["mode"]) =>
    checkSpecSync(ENGLISH_SPEC_URL, [{ constName: "GLUED", source: "eval", specLabel: "probe", text: glued, mode }])[0]?.ok === true;
  add("spec-sync block-exact: 두 블록을 이어 붙인 상수 거부(조립 규칙 꺼짐)", probe("block") && !probe("block-exact"), `block=${probe("block")} block-exact=${probe("block-exact")}`);

  // 5. §12-6 프리셋 장면 문장 표 — 키·장면이 lib/talk-topics.ts와 같다(순서 포함)
  const sceneStart = specText.indexOf("프리셋 장면 문장(`sceneEn`");
  const sceneEnd = specText.indexOf("**저장 모델 추가**", sceneStart);
  const sceneRows =
    sceneStart < 0 || sceneEnd < 0
      ? []
      : specText
          .slice(sceneStart, sceneEnd)
          .split("\n")
          .map((line) => /^\| ([a-z]+) \| (.+?) \|$/.exec(line.trim()))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => ({ key: m[1], sceneEn: m[2] }));
  add(
    `프리셋 장면 ${TALK_TOPIC_PRESETS.length}개 = 스펙 표(키·장면·순서)`,
    sceneRows.length === TALK_TOPIC_PRESETS.length &&
      sceneRows.every((r, i) => r.key === TALK_TOPIC_PRESETS[i].key && r.sceneEn === TALK_TOPIC_PRESETS[i].sceneEn),
    `스펙 ${sceneRows.length}행: ${sceneRows.map((r) => r.key).join(",")}`,
  );
  return results;
}

/** 지시문 조립 — 프리셋·직접 입력 정리·단어장 */
function runTalkInstructionChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 지시문");
  const [before, after, ...extra] = TALK_TEACHER_INSTRUCTIONS.split("{lesson}");
  add("지시문 템플릿의 {lesson} 자리는 정확히 하나", extra.length === 0 && after !== undefined);

  // 프리셋 10개 — 스펙 목록 그대로, 키 중복 없음, 모두 해석됨
  const specLabels = ["동물", "음식", "가족", "학교와 친구", "놀이", "날씨", "색깔과 모양", "오늘 하루", "공룡", "생일"];
  add("프리셋 10개 = 스펙 목록(순서 포함)", TALK_TOPIC_PRESETS.map((p) => p.labelKo).join("|") === specLabels.join("|"), TALK_TOPIC_PRESETS.map((p) => p.labelKo).join("·"));
  add("프리셋 키 중복 없음", new Set(TALK_TOPIC_PRESETS.map((p) => p.key)).size === TALK_TOPIC_PRESETS.length);
  add("프리셋 모두 해석·영어 라벨 있음", TALK_TOPIC_PRESETS.every((p) => resolvePresetTalkTopic(p.key)?.labelEn === p.labelEn && /[A-Za-z]/.test(p.labelEn)));
  add("모르는 프리셋 키 → null(라우트 400)", resolvePresetTalkTopic("space-travel") === null && resolvePresetTalkTopic(42) === null);

  const animals = resolvePresetTalkTopic("animals");
  if (animals) {
    const lesson = buildTalkLesson(animals);
    add("프리셋 수업 블록 = TALK_LESSON_TOPIC의 {topic} ← \"Animals (동물)\"", lesson === TALK_LESSON_TOPIC.replace("{topic}", "Animals (동물)"), lesson.split("\n")[0]);
    const ins = buildTalkInstructions(animals);
    add(
      "지시문 = 템플릿 앞부분 + 수업 블록 + 뒷부분 + \"\\n\\n\" + 차례 규칙(§12-7, 치환은 {lesson} 한 자리)",
      ins === `${before}${lesson}${after}\n\n${TALK_TURN_RULES}`,
    );
    add(
      "차례 규칙은 지시문 맨 끝에 한 번, §12-6 화면 카드 덧붙임·도구 이름은 없음",
      ins.endsWith(`\n\n${TALK_TURN_RULES}`) && ins.split("# Your turns").length === 2 && !/# Screen cards|show_hints|show_picture|your tools/.test(ins),
    );
    add("지시문에 치환 자리({lesson}·{topic})가 남지 않음", !/\{lesson\}|\{topic\}|\{title\}|\{words\}/.test(ins));
    add("스냅샷: 프리셋이면 key·labelEn 있고 words []", animals.kind === "preset" && animals.key === "animals" && animals.vocabBookId === null && animals.words.length === 0);
  } else {
    add("프리셋 animals 해석", false);
  }

  // 직접 입력 정리 — 줄바꿈·제어문자·따옴표·#·백틱 제거, 1~30자
  const cleanCases: [string, unknown, string | null][] = [
    ["줄바꿈 → 공백", "우주\n여행", "우주 여행"],
    ["따옴표·#·백틱 제거", "\"우주\" #탐험 `로켓` ‘달’", "우주 탐험 로켓 달"],
    ["제어문자 제거", "바다\u0007 친구", "바다 친구"],
    ["앞뒤 공백 정리", "   무지개   ", "무지개"],
    ["빈 문자열 → null", "", null],
    ["공백만 → null", "  \n\t ", null],
    ["따옴표만 → null", "\"\"``##", null],
    ["문자열 아님 → null", 123, null],
    [`${TALK_CUSTOM_TOPIC_MAX_CHARS}자 → 통과`, "가".repeat(TALK_CUSTOM_TOPIC_MAX_CHARS), "가".repeat(TALK_CUSTOM_TOPIC_MAX_CHARS)],
    [`${TALK_CUSTOM_TOPIC_MAX_CHARS + 1}자 → null(자르지 않음)`, "가".repeat(TALK_CUSTOM_TOPIC_MAX_CHARS + 1), null],
  ];
  for (const [name, input, expected] of cleanCases) {
    const got = cleanTalkCustomTopic(input);
    add(`직접 입력 정리: ${name}`, got === expected, `결과=${JSON.stringify(got)}`);
  }
  // 넣은 값이 템플릿을 흔들지 못한다(한 번 훑기 치환 — {lesson}·$& 가 다시 해석되지 않음)
  const tricky = resolveCustomTalkTopic("{lesson} $& 우주");
  const trickyIns = tricky ? buildTalkInstructions(tricky) : "";
  add(
    "직접 입력의 {lesson}·$&는 글자 그대로(재치환 없음)",
    trickyIns.includes("Today's topic is: {lesson} $& 우주\n") && trickyIns.split("# Today's lesson").length === 2,
    tricky ? tricky.labelKo : "해석 실패",
  );
  const custom = resolveCustomTalkTopic("  바다\n동물 ");
  add(
    "직접 입력 스냅샷·수업 블록(글자 그대로)",
    custom !== null && custom.kind === "custom" && custom.labelKo === "바다 동물" && custom.labelEn === null && buildTalkLesson(custom).startsWith("Today's topic is: 바다 동물\n"),
    custom ? custom.labelKo : "null",
  );
  add("템플릿 채우기: 값이 없는 자리는 던진다(빈칸이 조용히 남지 않음)", (() => {
    try {
      fillTalkTemplate("a {b} c", {});
      return false;
    } catch {
      return true;
    }
  })());

  // 단어장 — 책 순서 최대 20개, 첫 우리말 뜻 → definitionKo → 뜻 생략, 되풀이·빈 단어 건너뜀
  const entry = (word: string, ko: string | null, definitionKo: string | null = null): TalkVocabEntryLike => ({
    word,
    meanings: ko === null ? [] : [{ ko }],
    definitionKo,
  });
  const many: TalkVocabEntryLike[] = Array.from({ length: 25 }, (_, i) => entry(`word${String.fromCharCode(97 + i)}`, `뜻${i + 1}`));
  const words25 = buildTalkVocabWords(many);
  add(`단어장 25개 → 책 순서로 ${TALK_LIMITS.vocabWords}개`, words25.length === TALK_LIMITS.vocabWords && words25[0].en === "worda" && words25[19].en === "wordt", `개수=${words25.length} 마지막=${words25[words25.length - 1]?.en}`);
  const mixed = buildTalkVocabWords([
    entry("apple", "사과"),
    entry("brave", null, "두려워하지 않는"),
    entry("gather", null, null),
    entry("  ", "빈 단어"),
    entry("Apple", "또 사과"),
    entry("rain\nbow", "무지개"),
    { word: "moon", meanings: [{ ko: "" }, { ko: "달님" }], definitionKo: "밤하늘의 달" },
  ]);
  add(
    "뜻: meanings[0].ko → definitionKo → null, 빈·되풀이 단어 건너뜀, 줄바꿈은 공백",
    JSON.stringify(mixed) ===
      JSON.stringify([
        { en: "apple", ko: "사과", emoji: null },
        { en: "brave", ko: "두려워하지 않는", emoji: null },
        { en: "gather", ko: null, emoji: null },
        { en: "rain bow", ko: "무지개", emoji: null },
        { en: "moon", ko: "밤하늘의 달", emoji: null },
      ]),
    JSON.stringify(mixed),
  );
  const book = resolveVocabTalkTopic({
    id: "vb_test",
    titleKo: "DAY \"01\"\n동물",
    entries: [entry("apple", "사과"), entry("gather", null, null)],
  });
  const wordsLesson = book ? buildTalkLesson(book) : "";
  add(
    "단어장 수업 블록 = TALK_LESSON_WORDS({title}·{words}), 뜻 없는 단어는 괄호 없이",
    book !== null &&
      book.kind === "vocab" &&
      book.vocabBookId === "vb_test" &&
      book.labelKo === "DAY 01 동물" &&
      wordsLesson === TALK_LESSON_WORDS.replace("{title}", "DAY 01 동물").replace("{words}", "- apple (사과)\n- gather"),
    wordsLesson.split("\n").slice(0, 3).join(" / "),
  );
  // "모은 단어" 단어장 모양(word·meanings[].ko만, definitionKo null)도 같은 경로
  const collected = resolveVocabTalkTopic({ id: "vb_c", titleKo: "모은 단어", entries: [{ word: "bellowed", meanings: [{ ko: "울부짖었다" }], definitionKo: null }] });
  add("'모은 단어' 모양도 해석", collected?.words[0]?.ko === "울부짖었다", JSON.stringify(collected?.words));

  // 단어장 이모지(2026-09-27) — 화면 표시용 스냅샷 필드. 카드 이모지 판정(sanitizeTalkEmoji) 한 곳을 지나고, 지시문에는 넣지 않는다
  const withEmoji = (word: string, ko: string, imageEmoji: string | null | undefined): TalkVocabEntryLike => ({
    word,
    meanings: [{ ko }],
    definitionKo: null,
    ...(imageEmoji === undefined ? {} : { imageEmoji }),
  });
  const emojiWords = buildTalkVocabWords([
    withEmoji("fix", "고치다", "🛠️"),
    withEmoji("bike", "자전거", " 🚲\n"),
    withEmoji("apple", "사과", "apple"),
    withEmoji("cat", "고양이", "고양이"),
    withEmoji("star", "별", ""),
    withEmoji("respect", "존중하다", null),
    withEmoji("dog", "개", undefined),
    withEmoji("circle", "동그라미", "●"),
    withEmoji("family", "가족", "👨‍👩‍👧‍👦"),
    withEmoji("letter", "글자", "Ⓐ"),
  ]);
  add(
    "단어장 이모지: imageEmoji → emoji(정리), 글자·한글·빈 값·없음·글자형 기호 → null, 도형 기호·ZWJ 가족 이모지는 살림",
    JSON.stringify(emojiWords.map((w) => w.emoji)) === JSON.stringify(["🛠️", "🚲", null, null, null, null, null, "●", "👨‍👩‍👧‍👦", null]),
    JSON.stringify(emojiWords.map((w) => w.emoji)),
  );
  add(
    "단어장 이모지 판정 = 카드 이모지 판정(sanitizeTalkEmoji 한 곳 — sanitizeTalkCards도 같은 값에서 살고 죽음)",
    ["🛠️", " 🚲\n", "apple", "고양이", "", "●", "👨‍👩‍👧‍👦", "Ⓐ", ":dog:", "▲A", "🐶".repeat(TALK_CARD_LIMITS.emojiMaxChars + 1)].every((e) => {
      const card = sanitizeTalkCards([{ emoji: e, en: "word", ko: "낱말" }])[0] ?? null;
      return (card?.emoji ?? null) === sanitizeTalkEmoji(e);
    }),
  );
  const emojiBook = resolveVocabTalkTopic({
    id: "vb_emoji",
    titleKo: "DAY 01",
    entries: [withEmoji("fix", "고치다", "🛠️"), withEmoji("bike", "자전거", "🚲"), withEmoji("respect", "존중하다", null)],
  });
  add(
    "단어장 이모지는 수업 블록에 넣지 않음(TALK_LESSON_WORDS {words} 줄 형식 불변)",
    emojiBook !== null &&
      buildTalkLesson(emojiBook) === TALK_LESSON_WORDS.replace("{title}", "DAY 01").replace("{words}", "- fix (고치다)\n- bike (자전거)\n- respect (존중하다)") &&
      !/🛠|🚲/u.test(buildTalkInstructions(emojiBook)),
    emojiBook ? buildTalkLesson(emojiBook).split("\n").slice(1, 4).join(" / ") : "해석 실패",
  );
  add(
    "단어장 장면 문장에도 이모지 없음(영어 단어만)",
    emojiBook !== null && buildTalkSceneEn(emojiBook) === "a cheerful scene with: fix, bike, respect",
    emojiBook ? buildTalkSceneEn(emojiBook) : "",
  );
  add("스냅샷 단어 키 = {en, ko, emoji}(필수 nullable — undefined 없음)", emojiWords.every((w) => JSON.stringify(Object.keys(w)) === '["en","ko","emoji"]' && w.emoji !== undefined));
  // 옛 스냅샷(emoji 키 없음)·빈 문자열·숫자 → null, 있는 값은 그대로(normalize는 글자를 손보지 않는다)
  const normalized = normalizeTalkTopic({
    kind: "vocab",
    key: null,
    labelKo: "옛 단어장",
    labelEn: null,
    vocabBookId: "vb_old",
    words: [{ en: "apple", ko: "사과" }, { en: "bike", ko: null, emoji: "" }, { en: "fix", ko: "고치다", emoji: "🛠️" }, { en: "cat", ko: null, emoji: 7 }],
  });
  add(
    "normalize: 옛 스냅샷(emoji 없음)·빈 문자열·문자열 아님 → null, 있는 이모지는 그대로",
    JSON.stringify(normalized.words) ===
      JSON.stringify([
        { en: "apple", ko: "사과", emoji: null },
        { en: "bike", ko: null, emoji: null },
        { en: "fix", ko: "고치다", emoji: "🛠️" },
        { en: "cat", ko: null, emoji: null },
      ]),
    JSON.stringify(normalized.words),
  );
  add("넘길 단어 0개 → null(라우트 400)", resolveVocabTalkTopic({ id: "vb_e", titleKo: "빈 책", entries: [entry(" ", "뜻")] }) === null);

  // 아이 이름은 AI에 보내지 않는다 — 어떤 지시문에도 "은우"가 없다
  const allIns = [
    ...TALK_TOPIC_PRESETS.map((p) => buildTalkInstructions(resolvePresetTalkTopic(p.key) as TalkTopic)),
    book ? buildTalkInstructions(book) : "",
    TALK_GREETING_INSTRUCTIONS,
    TALK_WRAPUP_INSTRUCTIONS,
    TALK_EXPLAIN_SYSTEM_PROMPT,
    TALK_TURN_RULES,
    TALK_NUDGE_NOTE,
    TALK_SCENE_NOTE,
    TALK_SCENE_IMAGE_PROMPT,
    TALK_CARDS_SYSTEM_PROMPT,
    TALK_CARDS_USER_TEMPLATE,
    JSON.stringify(TALK_SCREEN_CARDS_JSON_SCHEMA),
  ];
  add("지시문·차례 규칙·인사·마무리·도움 요청·장면·호출 I·호출 J 프롬프트에 아이 이름 없음", allIns.every((s) => !s.includes("은우")));
  return results;
}

/** 세션 설정 — env 빈 값 폴백·속도 두 값·필드 모양(SDK GA 타입과 같은 이름) */
function runTalkSessionConfigChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 세션설정");
  const ENV_KEYS = ["OPENAI_REALTIME_MODEL", "OPENAI_REALTIME_VOICE", "OPENAI_REALTIME_TRANSCRIBE_MODEL"] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const setEnv = (v: string | undefined) => {
    for (const k of ENV_KEYS) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const topic = resolvePresetTalkTopic("food") as TalkTopic;
  try {
    for (const [label, value] of [["미설정", undefined], ["빈 값", ""], ["공백만", "   "]] as const) {
      setEnv(value);
      const c = buildTalkSessionConfig({ topic, speed: "slow" });
      add(
        `env ${label} → 기본값(모델·음성·전사)`,
        c.model === DEFAULT_TALK_REALTIME_MODEL && c.audio?.output?.voice === DEFAULT_TALK_REALTIME_VOICE && c.audio?.input?.transcription?.model === DEFAULT_TALK_TRANSCRIBE_MODEL,
        `${c.model} / ${String(c.audio?.output?.voice)} / ${c.audio?.input?.transcription?.model}`,
      );
    }
    process.env.OPENAI_REALTIME_MODEL = " gpt-realtime-2.1-mini ";
    process.env.OPENAI_REALTIME_VOICE = " cedar ";
    process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL = " gpt-transcribe ";
    const overridden = buildTalkSessionConfig({ topic, speed: "normal" });
    add(
      "env 값은 앞뒤 공백을 걷어 그대로 씀",
      overridden.model === "gpt-realtime-2.1-mini" && overridden.audio?.output?.voice === "cedar" && overridden.audio?.input?.transcription?.model === "gpt-transcribe",
      `${overridden.model} / ${String(overridden.audio?.output?.voice)}`,
    );
    add("2 계열 모델이면 reasoning.effort low", overridden.reasoning?.effort === "low");
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
    add("비추론 모델로 바꾸면 reasoning을 싣지 않음", !("reasoning" in buildTalkSessionConfig({ topic, speed: "slow" })));

    setEnv(undefined);
    const c = buildTalkSessionConfig({ topic, speed: "slow" });
    add("type realtime · output_modalities [audio] · max_output_tokens", c.type === "realtime" && JSON.stringify(c.output_modalities) === '["audio"]' && c.max_output_tokens === TALK_REALTIME_MAX_OUTPUT_TOKENS, `max=${String(c.max_output_tokens)}`);
    add("기본 모델이면 reasoning.effort low", c.reasoning?.effort === "low");
    add("instructions = buildTalkInstructions(주제 스냅샷)", c.instructions === buildTalkInstructions(topic));
    add(
      "전사: language en · prompt 없음 — 키는 정확히 {model, language}(prompt·keywords·languages 무유도)",
      JSON.stringify(Object.keys(c.audio?.input?.transcription ?? {}).sort()) === '["language","model"]' &&
        c.audio?.input?.transcription?.language === "en" &&
        TALK_TRANSCRIBE_LANGUAGE === "en",
      JSON.stringify(c.audio?.input?.transcription),
    );
    add(
      "전사 언어는 env로 바뀌지 않음(전사 모델 env를 바꿔도 en)",
      overridden.audio?.input?.transcription?.language === "en" && !("prompt" in (overridden.audio?.input?.transcription ?? {})),
      JSON.stringify(overridden.audio?.input?.transcription),
    );
    add(
      "턴 감지: semantic_vad · eagerness low · 응답 자동 생성은 켜고 서버 끼어들기는 끔(2026-10-03 — 끼어들기는 앱이 700ms로 판정)",
      talkDeepEqual(c.audio?.input?.turn_detection, { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: false }),
      JSON.stringify(c.audio?.input?.turn_detection),
    );
    add("소음 억제 far_field", c.audio?.input?.noise_reduction?.type === "far_field");
    add("표에 없는 필드(tracing·truncation·include·prompt) 없음", !["tracing", "truncation", "include", "prompt"].some((k) => k in c), Object.keys(c).join(","));
    add(
      "최상위 키 = §12-1 표(type·model·instructions·output_modalities·max_output_tokens·audio·reasoning) — §12-7 도구 없음",
      Object.keys(c).sort().join(",") === ["audio", "instructions", "max_output_tokens", "model", "output_modalities", "reasoning", "type"].join(","),
      Object.keys(c).sort().join(","),
    );
    add("§12-7 도구 없음: tools·tool_choice 키가 없다(선생님이 도구로 응답을 끊지 않게)", !("tools" in c) && !("tool_choice" in c));
    add(
      "§12-7 지시문 덧붙임: instructions 끝이 \"\\n\\n\" + TALK_TURN_RULES(도구 안내 없음)",
      typeof c.instructions === "string" && c.instructions.endsWith(`\n\n${TALK_TURN_RULES}`) && !/# Screen cards|show_hints|show_picture/.test(c.instructions),
    );
    add(
      "주제·속도·env가 달라도 도구는 끝내 없음(프리셋·단어장·보통 속도·비추론 모델)",
      (() => {
        process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
        const vocab = resolveVocabTalkTopic({ id: "vb_t", titleKo: "DAY 1", entries: [{ word: "apple", meanings: [{ ko: "사과" }], definitionKo: null }] });
        const configs = [buildTalkSessionConfig({ topic, speed: "normal" }), ...(vocab ? [buildTalkSessionConfig({ topic: vocab, speed: "slow" })] : [])];
        delete process.env.OPENAI_REALTIME_MODEL;
        return vocab !== null && configs.every((cfg) => !("tools" in cfg) && !("tool_choice" in cfg) && cfg.instructions?.endsWith(TALK_TURN_RULES) === true);
      })(),
    );
    add("속도: 천천히 0.85 · 보통 1.0", c.audio?.output?.speed === 0.85 && buildTalkSessionConfig({ topic, speed: "normal" }).audio?.output?.speed === 1.0);
    add("속도 키는 두 개뿐(slow·normal)", TALK_SPEEDS.join(",") === "slow,normal" && isTalkSpeed("slow") && isTalkSpeed("normal") && !isTalkSpeed("fast") && !isTalkSpeed(0.85));
    add("알 수 없는 속도 → 던짐", (() => {
      try {
        buildTalkSessionConfig({ topic, speed: "fast" as TalkSpeed });
        return false;
      } catch {
        return true;
      }
    })());
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  add("callId: Location 마지막 조각", parseTalkCallId("/v1/realtime/calls/rtc_abc123") === "rtc_abc123" && parseTalkCallId("https://api.example.test/v1/realtime/calls/rtc_x9?y=1") === "rtc_x9");
  add("callId: 없거나 형식이 틀리면 null", parseTalkCallId(null) === null && parseTalkCallId("") === null && parseTalkCallId("/v1/realtime/calls/rtc a") === null);
  add("callId 형식 검사(경로 조작 차단)", isTalkCallId("rtc_ok-1") && !isTalkCallId("../x") && !isTalkCallId("rtc_a/b") && !isTalkCallId(""));
  return results;
}

// 합성 이벤트 — SDK GA 타입(RealtimeServerEvent)으로 타입 검사한다(이벤트 이름·필드를 틀리면 tsc가 잡는다). 내용은 지어낸 영어.
let talkEventSeq = 0;
const talkEid = () => `event_${++talkEventSeq}`;
const talkEv = {
  speechStarted: (item_id: string): RealtimeServerEvent => ({ type: "input_audio_buffer.speech_started", event_id: talkEid(), item_id, audio_start_ms: 0 }),
  committed: (item_id: string, previous_item_id: string | null): RealtimeServerEvent => ({ type: "input_audio_buffer.committed", event_id: talkEid(), item_id, previous_item_id }),
  itemAdded: (id: string, role: "user" | "assistant", previous_item_id: string | null): RealtimeServerEvent => ({
    type: "conversation.item.added",
    event_id: talkEid(),
    previous_item_id,
    item: role === "user" ? { type: "message", role: "user", id, content: [] } : { type: "message", role: "assistant", id, content: [] },
  }),
  itemCreated: (id: string, role: "user" | "assistant", previous_item_id: string | null): RealtimeServerEvent => ({
    type: "conversation.item.created",
    event_id: talkEid(),
    previous_item_id,
    item: role === "user" ? { type: "message", role: "user", id, content: [] } : { type: "message", role: "assistant", id, content: [] },
  }),
  itemAddedFunctionCall: (id: string, previous_item_id: string | null): RealtimeServerEvent => ({
    type: "conversation.item.added",
    event_id: talkEid(),
    previous_item_id,
    item: { type: "function_call", id, call_id: `call_${id}`, name: "show_hints", arguments: '{"answers":["Yes!"],"words":[]}' },
  }),
  itemAddedToolOutput: (id: string, previous_item_id: string | null): RealtimeServerEvent => ({
    type: "conversation.item.added",
    event_id: talkEid(),
    previous_item_id,
    item: { type: "function_call_output", id, call_id: "call_x", output: '{"shown":true}' },
  }),
  itemAddedSystem: (id: string, previous_item_id: string | null): RealtimeServerEvent => ({
    type: "conversation.item.added",
    event_id: talkEid(),
    previous_item_id,
    item: { type: "message", role: "system", id, content: [{ type: "input_text", text: "Start the call now." }] },
  }),
  inDelta: (item_id: string, delta: string): RealtimeServerEvent => ({ type: "conversation.item.input_audio_transcription.delta", event_id: talkEid(), item_id, content_index: 0, delta }),
  inCompleted: (item_id: string, transcript: string): RealtimeServerEvent => ({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: talkEid(),
    item_id,
    content_index: 0,
    transcript,
    usage: { type: "duration", seconds: 1 },
  }),
  inFailed: (item_id: string): RealtimeServerEvent => ({ type: "conversation.item.input_audio_transcription.failed", event_id: talkEid(), item_id, content_index: 0, error: { message: "fixture" } }),
  outDelta: (item_id: string, response_id: string, delta: string): RealtimeServerEvent => ({
    type: "response.output_audio_transcript.delta",
    event_id: talkEid(),
    item_id,
    response_id,
    output_index: 0,
    content_index: 0,
    delta,
  }),
  outDone: (item_id: string, response_id: string, transcript: string): RealtimeServerEvent => ({
    type: "response.output_audio_transcript.done",
    event_id: talkEid(),
    item_id,
    response_id,
    output_index: 0,
    content_index: 0,
    transcript,
  }),
  responseDone: (
    id: string,
    status: "completed" | "cancelled" | "incomplete" | "failed",
    outputIds: string[],
    reason?: "turn_detected" | "content_filter",
  ): RealtimeServerEvent => ({
    type: "response.done",
    event_id: talkEid(),
    response: {
      id,
      object: "realtime.response",
      status,
      status_details: reason ? { type: status, reason } : { type: status },
      output: outputIds.map((oid) => ({ type: "message" as const, role: "assistant" as const, id: oid, content: [] })),
    },
  }),
};

const talkLinesKey = (s: TalkTranscriptState) => s.lines.map((l) => `${l.itemId}:${l.speaker}:${l.status}:${l.text}${l.filtered ? ":filtered" : ""}`).join(" | ");
const talkOrder = (s: TalkTranscriptState) => s.lines.map((l) => l.itemId).join(",");

/** 리듀서 — 합성 이벤트로 §12-2 규칙을 잠근다 */
function runTalkTranscriptChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 리듀서");
  // 시나리오 1 — 은우 전사가 선생님 응답보다 늦게 온다
  const head: RealtimeServerEvent[] = [
    talkEv.itemAdded("item_t1", "assistant", null),
    talkEv.outDelta("item_t1", "resp_1", "Hello! I am Sunny."),
    talkEv.outDelta("item_t1", "resp_1", " Do you like dogs?"),
    talkEv.outDone("item_t1", "resp_1", "Hello! I am Sunny. Do you like dogs?"),
    talkEv.responseDone("resp_1", "completed", ["item_t1"]),
    talkEv.speechStarted("item_c1"),
  ];
  const s0 = reduceTalkTranscriptEvents(head);
  add("speech_started → 은우 줄이 맨 뒤에 listening", talkOrder(s0) === "item_t1,item_c1" && s0.lines[1].status === "listening" && s0.lines[1].speaker === "child", talkLinesKey(s0));
  const middle: RealtimeServerEvent[] = [
    talkEv.committed("item_c1", "item_t1"),
    talkEv.itemAdded("item_c1", "user", "item_t1"),
    talkEv.itemAdded("item_t2", "assistant", "item_c1"),
    talkEv.outDelta("item_t2", "resp_2", "Great! Dogs are fun."),
    talkEv.outDone("item_t2", "resp_2", "Great! Dogs are fun. What color is your dog?"),
    talkEv.responseDone("resp_2", "completed", ["item_t2"]),
  ];
  const s1 = reduceTalkTranscriptEvents(middle, s0);
  add("은우 글자가 아직 없어도 선생님 줄은 그 아래", talkOrder(s1) === "item_t1,item_c1,item_t2" && s1.lines[1].text === "" && s1.lines[2].status === "final", talkLinesKey(s1));
  const tail: RealtimeServerEvent[] = [
    talkEv.inDelta("item_c1", "Yes I"),
    talkEv.inDelta("item_c1", " like dogs"),
    talkEv.inCompleted("item_c1", "Yes, I like dogs."),
  ];
  const s1a = reduceTalkTranscriptEvents(tail.slice(0, 2), s1);
  add("은우 delta → 이어 붙임(partial)", s1a.lines[1].text === "Yes I like dogs" && s1a.lines[1].status === "partial", talkLinesKey(s1a));
  const s2 = reduceTalkTranscriptEvents(tail, s1);
  add("늦게 온 은우 전사도 자기 자리(위)에서 final로 교체", talkOrder(s2) === "item_t1,item_c1,item_t2" && s2.lines[1].text === "Yes, I like dogs." && s2.lines[1].status === "final", talkLinesKey(s2));

  // 멱등 — 이벤트마다 두 번, 그리고 전체를 한 번 더
  const all = [...head, ...middle, ...tail];
  const twiceEach = reduceTalkTranscriptEvents(all.flatMap((e) => [e, e]));
  add("같은 이벤트가 두 번씩 와도 결과가 같다(멱등)", talkLinesKey(twiceEach) === talkLinesKey(s2), talkLinesKey(twiceEach));
  const replayed = reduceTalkTranscriptEvents(all, s2);
  add("전체 이벤트를 다시 흘려도 결과가 같다", talkLinesKey(replayed) === talkLinesKey(s2), talkLinesKey(replayed));
  add("늦게 온 delta는 확정 줄을 바꾸지 않음", talkLinesKey(reduceTalkTranscript(s2, talkEv.outDelta("item_t2", "resp_2", " extra"))) === talkLinesKey(s2) && talkLinesKey(reduceTalkTranscript(s2, talkEv.inDelta("item_c1", " more"))) === talkLinesKey(s2));

  // 항목 연결이 늦게 온다 — 먼저 붙은 선생님 줄 위로 은우 줄이 들어간다
  const lateLink = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t4", "assistant", null),
    talkEv.outDone("item_t4", "resp_4", "What is it?"),
    talkEv.itemAdded("item_t5", "assistant", "item_c5"), // c5를 아직 모른다 → 맨 뒤
    talkEv.outDone("item_t5", "resp_5", "Oh, a cat!"),
    talkEv.committed("item_c5", "item_t4"),
    talkEv.inCompleted("item_c5", "It is a cat."),
  ]);
  add("모르는 앞 항목 → 맨 뒤, 나중에 온 연결로 자리를 찾음", talkOrder(lateLink) === "item_t4,item_c5,item_t5", talkOrder(lateLink));
  const legacy = reduceTalkTranscriptEvents([
    talkEv.itemCreated("item_t6", "assistant", null),
    talkEv.speechStarted("item_c6"),
    talkEv.itemCreated("item_c6", "user", "item_t6"),
    talkEv.itemCreated("item_t7", "assistant", "item_c6"),
  ]);
  add("구형 conversation.item.created도 같은 규칙", talkOrder(legacy) === "item_t6,item_c6,item_t7" && legacy.lines[2].speaker === "teacher", talkOrder(legacy));

  // 끊김 — cancelled → interrupted(글자는 남긴다), done과 순서가 바뀌어도 같다
  const cutA = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t8", "assistant", null),
    talkEv.outDelta("item_t8", "resp_8", "Let me tell you about"),
    talkEv.speechStarted("item_c8"),
    talkEv.responseDone("resp_8", "cancelled", ["item_t8"], "turn_detected"),
    talkEv.outDone("item_t8", "resp_8", "Let me tell you about"),
  ]);
  const cutB = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t8", "assistant", null),
    talkEv.outDelta("item_t8", "resp_8", "Let me tell you about"),
    talkEv.speechStarted("item_c8"),
    talkEv.outDone("item_t8", "resp_8", "Let me tell you about"),
    talkEv.responseDone("resp_8", "cancelled", ["item_t8"], "turn_detected"),
  ]);
  add("response.done cancelled → 선생님 줄 interrupted, 글자 유지", cutA.lines[0].status === "interrupted" && cutA.lines[0].text === "Let me tell you about", talkLinesKey(cutA));
  add("done ↔ cancelled 순서가 바뀌어도 interrupted", cutB.lines[0].status === "interrupted" && talkLinesKey(cutA) === talkLinesKey(cutB), talkLinesKey(cutB));
  const filtered = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t9", "assistant", null),
    talkEv.outDelta("item_t9", "resp_9", "Hmm, let us talk about"),
    talkEv.responseDone("resp_9", "incomplete", ["item_t9"], "content_filter"),
  ]);
  add("incomplete + content_filter → filtered(흐리게)", filtered.lines[0].filtered === true && filtered.lines[0].status === "final", talkLinesKey(filtered));

  // 빈 전사·실패 전사
  const empty = reduceTalkTranscriptEvents([talkEv.speechStarted("item_c10"), talkEv.committed("item_c10", null), talkEv.inCompleted("item_c10", "  ")]);
  add("빈 전사 → empty(화면에서 숨김)", empty.lines[0].status === "empty" && !isVisibleTalkLine(empty.lines[0]), talkLinesKey(empty));
  const failed = reduceTalkTranscriptEvents([talkEv.speechStarted("item_c11"), talkEv.inDelta("item_c11", "I wan"), talkEv.inFailed("item_c11")]);
  add("전사 실패 → failed", failed.lines[0].status === "failed" && isVisibleTalkLine(failed.lines[0]), talkLinesKey(failed));
  const completedThenFailed = reduceTalkTranscriptEvents([talkEv.speechStarted("item_c12"), talkEv.inCompleted("item_c12", "Blue!"), talkEv.inFailed("item_c12")]);
  add("확정 전사 뒤 failed가 와도 확정이 이긴다", completedThenFailed.lines[0].status === "final" && completedThenFailed.lines[0].text === "Blue!", talkLinesKey(completedThenFailed));

  // 앱이 넣은 숨은 항목(app_) — 줄로 만들지 않고, 그 항목을 가리키는 연결은 건너 이어 준다
  const hiddenId = `${TALK_HIDDEN_ITEM_PREFIX}nudge_1`;
  const hidden = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t13", "assistant", null),
    talkEv.speechStarted("item_c13"),
    talkEv.itemAdded(hiddenId, "user", "item_t13"),
    talkEv.outDelta(hiddenId, "resp_x", "should not show"),
    talkEv.itemAdded("item_t14", "assistant", hiddenId),
  ]);
  add("app_ 항목은 줄이 되지 않음", hidden.lines.every((l) => !l.itemId.startsWith(TALK_HIDDEN_ITEM_PREFIX)), talkOrder(hidden));
  add("app_ 항목 뒤의 항목은 그 앞 항목 뒤로 이어짐", talkOrder(hidden) === "item_t13,item_t14,item_c13", talkOrder(hidden));

  // §12-6 — 선생님의 도구 호출(function_call)·앱의 호출 결과(app_ function_call_output)·숨은 system 메시지는 줄이 아니다
  const tools = reduceTalkTranscriptEvents([
    talkEv.itemAddedSystem(`${TALK_HIDDEN_ITEM_PREFIX}greet`, null),
    talkEv.itemAdded("item_t20", "assistant", `${TALK_HIDDEN_ITEM_PREFIX}greet`),
    talkEv.outDone("item_t20", "resp_20", "Hi! I am Sunny. Do you like apples?"),
    talkEv.itemAddedFunctionCall("item_fc20", "item_t20"),
    talkEv.responseDone("resp_20", "completed", ["item_t20"]),
    talkEv.speechStarted("item_c21"),
    talkEv.committed("item_c21", "item_fc20"),
    talkEv.inCompleted("item_c21", "Yes!"),
    talkEv.itemAddedFunctionCall("item_fc22", "item_c21"), // 도구만 부른 응답
    talkEv.itemAddedToolOutput(`${TALK_HIDDEN_ITEM_PREFIX}out_22`, "item_fc22"),
    talkEv.itemAdded("item_t23", "assistant", `${TALK_HIDDEN_ITEM_PREFIX}out_22`),
    talkEv.outDone("item_t23", "resp_23", "Great! Apples are yummy."),
  ]);
  add(
    "도구 호출·호출 결과·숨은 system 메시지는 줄이 되지 않음(스크립트 = 선생님·은우 말만)",
    talkOrder(tools) === "item_t20,item_c21,item_t23" && tools.lines.every((l) => l.itemId.startsWith("item_t") || l.itemId.startsWith("item_c")),
    talkOrder(tools),
  );
  const viaTool = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t30", "assistant", null),
    talkEv.speechStarted("item_c30"),
    talkEv.itemAdded("item_t31", "assistant", "item_fc30"), // 앞 항목(도구 호출)을 아직 모른다 → 맨 뒤
    talkEv.itemAddedFunctionCall("item_fc30", "item_t30"),
    talkEv.itemAdded("item_t31", "assistant", "item_fc30"), // 같은 연결이 다시 오면 도구 호출을 건너 t30 바로 뒤로
  ]);
  add("도구 호출 항목을 가리키는 연결은 그 앞 항목 뒤로 이어짐", talkOrder(viaTool) === "item_t30,item_t31,item_c30", talkOrder(viaTool));

  // 끊김·실패 응답의 표시(QA talk-ai P2-3)
  const cutEmpty = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t40", "assistant", null),
    talkEv.speechStarted("item_c40"),
    talkEv.responseDone("resp_40", "cancelled", ["item_t40"], "turn_detected"),
  ]);
  add(
    "글자가 오기 전에 끊긴 선생님 줄은 숨김(빈 말풍선 없음), 듣는 중 줄은 보임",
    cutEmpty.lines[0].status === "interrupted" && !isVisibleTalkLine(cutEmpty.lines[0]) && isVisibleTalkLine(cutEmpty.lines[1]),
    talkLinesKey(cutEmpty),
  );
  const failedResp = reduceTalkTranscriptEvents([
    talkEv.itemAdded("item_t41", "assistant", null),
    talkEv.outDelta("item_t41", "resp_41", "Let us talk about"),
    talkEv.responseDone("resp_41", "failed", ["item_t41"]),
  ]);
  add(
    "response.done failed → 끊김(interrupted)으로 접음 — '입력 중'이 남지 않음, 글자 유지",
    failedResp.lines[0].status === "interrupted" && failedResp.lines[0].text === "Let us talk about" && isVisibleTalkLine(failedResp.lines[0]),
    talkLinesKey(failedResp),
  );
  add("진행 중 선생님 줄(글자 전)은 보임", isVisibleTalkLine({ itemId: "x", speaker: "teacher", text: "", status: "partial", filtered: false, origin: null }));

  // 재생 중 잘림(2026-10-03 — QA talk-cutoff P2-A): 생성이 끝난 뒤 재생 중에 잘리면 서버는 cleared·truncated만 보낸다 → 끊김
  const doneLine: RealtimeServerEvent[] = [
    talkEv.itemAdded("item_t50", "assistant", null),
    talkEv.outDelta("item_t50", "resp_50", "Wow, you like dogs!"),
    talkEv.outDone("item_t50", "resp_50", "Wow, you like dogs! What color is your favorite dog?"),
    talkEv.responseDone("resp_50", "completed", ["item_t50"]),
  ];
  const cleared50 = { type: "output_audio_buffer.cleared", event_id: talkEid(), response_id: "resp_50" } as RealtimeServerEvent;
  const truncated50 = { type: "conversation.item.truncated", event_id: talkEid(), item_id: "item_t50", content_index: 0, audio_end_ms: 1200 } as RealtimeServerEvent;
  const viaCleared = reduceTalkTranscriptEvents([...doneLine, cleared50]);
  add(
    "생성 뒤 재생 중 cleared(응답 id) → 그 선생님 줄 interrupted(글자 유지) · 저장 interrupted:true",
    viaCleared.lines[0].status === "interrupted" &&
      viaCleared.lines[0].text === "Wow, you like dogs! What color is your favorite dog?" &&
      toTalkTurns(viaCleared.lines)[0]?.interrupted === true,
    talkLinesKey(viaCleared),
  );
  const viaTruncated = reduceTalkTranscriptEvents([...doneLine, truncated50]);
  add("생성 뒤 재생 중 conversation.item.truncated(항목 id) → 그 선생님 줄 interrupted(글자 유지)", viaTruncated.lines[0].status === "interrupted" && viaTruncated.lines[0].text.length > 0, talkLinesKey(viaTruncated));
  const both = reduceTalkTranscriptEvents([cleared50, truncated50, cleared50, truncated50], viaCleared);
  add("cleared·truncated가 겹치거나 두 번 와도 결과가 같다(멱등 — 같은 상태 객체)", both === viaCleared, talkLinesKey(both));
  const playedFully = reduceTalkTranscriptEvents([...doneLine, { type: "output_audio_buffer.stopped", event_id: talkEid(), response_id: "resp_50" } as RealtimeServerEvent]);
  add("정상 재생 끝(stopped) → final 그대로 · 저장 interrupted:false", playedFully.lines[0].status === "final" && toTalkTurns(playedFully.lines)[0]?.interrupted === false, talkLinesKey(playedFully));
  const stoppedThenCleared = reduceTalkTranscriptEvents([cleared50], playedFully);
  add("소리가 끝까지 난 뒤(stopped 뒤) 온 cleared는 끊김으로 보지 않음", stoppedThenCleared.lines[0].status === "final", talkLinesKey(stoppedThenCleared));
  const clearedFirst = reduceTalkTranscriptEvents([
    { type: "output_audio_buffer.cleared", event_id: talkEid(), response_id: "resp_51" } as RealtimeServerEvent,
    talkEv.itemAdded("item_t51", "assistant", null),
    talkEv.outDelta("item_t51", "resp_51", "Let's"),
    talkEv.outDone("item_t51", "resp_51", "Let's count to three."),
    talkEv.responseDone("resp_51", "completed", ["item_t51"]),
  ]);
  add("cleared가 줄보다 먼저 와도 그 응답의 줄이 생기면 끊김(completed done이 와도 끊김 유지)", clearedFirst.lines[0]?.status === "interrupted", talkLinesKey(clearedFirst));
  const otherResp = reduceTalkTranscriptEvents([...doneLine, { type: "output_audio_buffer.cleared", event_id: talkEid(), response_id: "resp_other" } as RealtimeServerEvent]);
  add("다른 응답의 cleared는 이 줄을 건드리지 않음", otherResp.lines[0].status === "final", talkLinesKey(otherResp));
  const childTrunc = reduceTalkTranscriptEvents([
    talkEv.speechStarted("item_c52"),
    talkEv.inCompleted("item_c52", "Yes."),
    { type: "conversation.item.truncated", event_id: talkEid(), item_id: "item_c52", content_index: 0, audio_end_ms: 0 } as RealtimeServerEvent,
  ]);
  add("은우 항목의 truncated는 무시(선생님 줄만 끊김)", childTrunc.lines[0].status === "final", talkLinesKey(childTrunc));

  // 모르는 이벤트·모양이 틀린 이벤트 — 같은 상태 객체를 그대로
  const ignored = [
    { type: "session.created", event_id: "x1", session: {} },
    { type: "rate_limits.updated", event_id: "x2", rate_limits: [] },
    { type: "output_audio_buffer.started", event_id: "x3", response_id: "resp_1" },
    { type: "conversation.item.added" },
    { type: "input_audio_buffer.speech_started", item_id: 42 },
    null,
    "not an event",
    [1, 2, 3],
  ];
  add("모르는·틀린 이벤트는 무시(같은 상태 객체)", ignored.every((e) => reduceTalkTranscript(s2, e) === s2));
  add("빈 상태에서 시작", createTalkTranscript().lines.length === 0);

  // 저장용 변환
  const turnsState = reduceTalkTranscriptEvents([...all, ...[talkEv.speechStarted("item_c15"), talkEv.inCompleted("item_c15", "")], ...[talkEv.speechStarted("item_c16"), talkEv.inFailed("item_c16")]]);
  const turns = toTalkTurns(turnsState.lines);
  add(
    "toTalkTurns: empty·failed·글자 없는 줄 제외, {speaker,text,interrupted,origin}(청 없는 선생님 응답 = reply, 은우 = null)",
    JSON.stringify(turns) ===
      JSON.stringify([
        { speaker: "teacher", text: "Hello! I am Sunny. Do you like dogs?", interrupted: false, origin: "reply" },
        { speaker: "child", text: "Yes, I like dogs.", interrupted: false, origin: null },
        { speaker: "teacher", text: "Great! Dogs are fun. What color is your dog?", interrupted: false, origin: "reply" },
      ]),
    JSON.stringify(turns),
  );
  add("childTurnCount = 은우 턴 수", childTurnCount(turns) === 1 && childTurnCount([]) === 0);
  const cutTurns = toTalkTurns(cutA.lines);
  add("끊긴 선생님 턴은 interrupted:true로 저장, 글자 없는 listening 줄은 제외", cutTurns.length === 1 && cutTurns[0].interrupted === true, JSON.stringify(cutTurns));
  const partialLine: TalkLine = { itemId: "item_c17", speaker: "child", text: "  My dog is ", status: "partial", filtered: false, origin: null };
  add("세션이 끝날 때 partial 은우 글자는 trim해서 남긴다", toTalkTurns([partialLine])[0]?.text === "My dog is");
  return results;
}

/**
 * 반이중 마이크 + 기기 안 끼어들기 판정(2026-10-03 두 번째 수정 — §12-1, lib/talk-barge-in.ts). 선생님 재생 중에는 서버로 가는 마이크를
 * 끄고(서버가 짧은 소리에 스스로 자르지 못하게), 기기가 복제 트랙의 음량(dBFS)으로 "덩어리 안 합계 700ms"를 넘는 말만 끼어들기로 본다.
 * 음량 열 → 끼어들기 시각, 적응형 문턱(소음 바닥 + 15dB, 하한 -45), 690/710 경계, 짧은 덩어리 여러 개, 틈 250ms 경계, 잡음 바닥 변화,
 * 재생 중 꺼짐/재생 끝 켜짐 상태 기계, 늦게 온 앞 응답의 멈춤, 닫힌 동안 끝난 서버 말소리의 자동 응답 취소. 시계는 인자.
 */
function runTalkBargeInChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 끼어들기");
  const fresh = () => createTalkBargeIn({ replyWaitMs: TALK_AUTO_REPLY_WAIT_MS });
  const T0 = 10_000;
  const QUIET = -70;
  const LOUD = -25;
  const F = 10; // 판정 경계를 ms 단위로 보려고 10ms 프레임
  const play = (now: number, responseId: string | null = "r1") => ({ type: "teacher_audio_started" as const, now, responseId });
  const stopA = (now: number, responseId: string | null = "r1") => ({ type: "teacher_audio_stopped" as const, now, responseId });
  const created = (now: number, responseId: string, requestedByApp = false) => ({ type: "response_created" as const, now, responseId, requestedByApp });
  const acts = (a: readonly unknown[]) => JSON.stringify(a);
  /** 조용한 방(바닥 -70)에서 재생 시작까지 — 마지막 프레임 시각 T0 */
  const warm = (floorDb = QUIET, ms = 500) => reduceTalkBargeInEvents(talkLevelFrames(T0 - ms, [[floorDb, ms]], F), fresh()).state;
  /** 재생 시작(T0) 뒤 음량 열을 넣고, 첫 동작이 나온 프레임 시각(onset 기준 ms)을 잰다 */
  const playThen = (segments: readonly (readonly [number, number])[], opts: { responseActive?: boolean; floor?: number; start?: TalkBargeInState } = {}) => {
    let st = reduceTalkBargeIn(opts.start ?? warm(opts.floor), play(T0)).state;
    const all: TalkBargeInAction[] = [];
    let firstActAt: number | null = null;
    for (const fr of talkLevelFrames(T0, segments, F, opts.responseActive ?? false)) {
      const step = reduceTalkBargeIn(st, fr);
      st = step.state;
      if (step.actions.length > 0 && firstActAt === null) firstActAt = fr.now - T0;
      all.push(...step.actions);
    }
    return { st, all, firstActAt };
  };

  add(
    "상수: 판정 700ms · 덩어리 틈 250ms · 문턱 하한 -45 dBFS · 여유 15 dB · 최근 기록 8 · 미터 40ms(§12-1)",
    TALK_BARGE_IN_MIN_MS === 700 && TALK_BARGE_IN_GAP_MS === 250 && TALK_BARGE_IN_MIN_THRESHOLD_DB === -45 && TALK_BARGE_IN_MARGIN_DB === 15 &&
      TALK_BARGE_IN_RECENT_MAX === 8 && TALK_LEVEL_POLL_MS === 40 && fresh().config.replyWaitMs === TALK_AUTO_REPLY_WAIT_MS && fresh().micOpen,
  );

  // 1. 음량 계산(RMS dBFS)
  const sine = (amp: number, n = 4800) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;
  add(
    "talkRmsDbfs: 사인 진폭 1 = -3.01 · 진폭 0.1 = -23.01 · 직류 0.5 = -6.02 · 무음/빈 배열 = -100",
    near(talkRmsDbfs(sine(1)), -3.01) && near(talkRmsDbfs(sine(0.1)), -23.01) && near(talkRmsDbfs(new Float32Array(100).fill(0.5)), -6.02) &&
      talkRmsDbfs(new Float32Array(256)) === TALK_LEVEL_SILENCE_DB && talkRmsDbfs([]) === TALK_LEVEL_SILENCE_DB,
    `${talkRmsDbfs(sine(1)).toFixed(2)} · ${talkRmsDbfs(sine(0.1)).toFixed(2)}`,
  );

  // 2. 적응형 문턱 = max(-45, 바닥 + 15)
  add(
    "문턱: 바닥 모름 → -45 · 바닥 -70 → -45(하한) · 바닥 -50 → -35 · 바닥 -30 → -15",
    talkBargeInThresholdDb(null) === -45 && talkBargeInThresholdDb(-70) === -45 && talkBargeInThresholdDb(-50) === -35 && talkBargeInThresholdDb(-30) === -15,
  );

  // 3. 소음 바닥 추적 — 첫 값 그대로, 빨리 내려가고, 천천히 올라가고, 큰 소리(말)로는 아주 천천히
  const f1 = updateTalkNoiseFloor(null, -55, 40);
  const fFall = updateTalkNoiseFloor(-40, -70, 40);
  const fRise = updateTalkNoiseFloor(-60, -50, 40);
  const fLoud = updateTalkNoiseFloor(-60, -20, 40);
  add(
    "소음 바닥: 첫 프레임 = 그 값 · 조용해지면 프레임마다 30% 내려감 · 문턱 아래 소리는 2초 시상수 · 문턱 이상(말소리)은 20초 시상수",
    f1 === -55 && fFall !== null && near(fFall, -49, 1e-9) && fRise !== null && near(fRise, -59.8, 1e-9) && fLoud !== null && near(fLoud, -59.92, 1e-9),
    `${f1} · ${fFall} · ${fRise} · ${fLoud}`,
  );
  let zeroFloor: number | null = updateTalkNoiseFloor(null, TALK_LEVEL_SILENCE_DB, 40);
  const zeroKeep = updateTalkNoiseFloor(-70, TALK_LEVEL_SILENCE_DB, 40);
  for (let t = 0; t < 400; t += 40) zeroFloor = updateTalkNoiseFloor(zeroFloor, TALK_LEVEL_SILENCE_DB, 40);
  zeroFloor = updateTalkNoiseFloor(zeroFloor, -72, 40);
  let roomFloor: number | null = -90;
  for (let t = 0; t < 6_000; t += 40) roomFloor = updateTalkNoiseFloor(roomFloor, -70, 40);
  add(
    "디지털 무음(트랙이 막 열릴 때의 0)은 바닥에 넣지 않음 · 바닥이 방 소리보다 낮으면 문턱 아래 소리로 2초 시상수 따라 올라감(6초 뒤 -71 안쪽)",
    zeroKeep === -70 && zeroFloor === -72 && roomFloor !== null && roomFloor > -71,
    `${zeroKeep} · ${zeroFloor} · ${roomFloor}`,
  );
  let talkFloor: number | null = -65;
  for (let t = 0; t < 2_000; t += 40) talkFloor = updateTalkNoiseFloor(talkFloor, LOUD, 40);
  add(
    "선생님 말 사이 은우가 2초 말해도 소음 바닥은 4dB 안쪽으로만 오름(문턱이 은우 목소리를 따라 올라가지 않음 — 여전히 -45)",
    talkFloor !== null && talkFloor - -65 < 4 && talkBargeInThresholdDb(talkFloor) === -45,
    String(talkFloor),
  );
  let tvFloor: number | null = -65;
  for (let t = 0; t < 60_000; t += 40) tvFloor = updateTalkNoiseFloor(tvFloor, -38, 40);
  add(
    "계속되는 큰 소음(-38 dBFS, 1분 — 텔레비전)에는 바닥이 결국 따라 올라가 문턱이 소음보다 위(-38 + 여유)",
    tvFloor !== null && tvFloor > -40 && talkBargeInThresholdDb(tvFloor) > -38,
    String(tvFloor),
  );

  // 4. 반이중 상태 기계 — 재생 시작 = 마이크 끔·문턱 얼림, 재생 끝 = 켬
  const w = warm();
  const p1 = reduceTalkBargeIn(w, play(T0));
  add(
    "재생 시작 → 마이크 끔(micOpen false) · 재생 셈 1 · 문턱 -45·바닥 -70 기록(재생 직전 바닥으로 얼림)",
    w.micOpen && !p1.state.micOpen && p1.state.teacherPlaying && p1.state.stats.playbacks === 1 && p1.state.stats.thresholdDb === -45 && p1.state.stats.floorDb === -70,
    JSON.stringify({ open: p1.state.micOpen, thr: p1.state.stats.thresholdDb, floor: p1.state.stats.floorDb }),
  );
  const pDup = reduceTalkBargeIn(p1.state, play(T0 + 5));
  add("같은 응답의 started가 또 와도 그대로(같은 객체 — 재생 셈 1)", pDup.state === p1.state);
  const pStop = reduceTalkBargeIn(p1.state, stopA(T0 + 3_000));
  add("재생 끝(stopped·cleared) → 마이크 켬 · 판정 상태 비움", pStop.state.micOpen && !pStop.state.teacherPlaying && pStop.state.run === null && pStop.actions.length === 0);
  const during = reduceTalkBargeInEvents(talkLevelFrames(T0, [[-40, 2_000]], 40), p1.state).state;
  add("재생 중에는 소음 바닥을 고치지 않음(새어 든 선생님 소리가 바닥을 끌어올리지 않게)", during.floorDb === p1.state.floorDb, String(during.floorDb));

  // 5. 690/710 경계 — 덩어리 안 합계 700ms
  const b690 = playThen([[QUIET, 100], [LOUD, 690], [QUIET, 400]]);
  add(
    "690ms 소리 → 끼어들기 없음 · 짧은 소리 1 · 마이크 닫힌 채 · 기록 690ms/-25 dBFS",
    b690.all.length === 0 && b690.st.stats.shortSounds === 1 && b690.st.stats.bargeIns === 0 && !b690.st.micOpen &&
      JSON.stringify(b690.st.stats.recent) === JSON.stringify([{ voicedMs: 690, spanMs: 680, peakDb: -25, cut: false }]),
    JSON.stringify(b690.st.stats.recent),
  );
  const b710 = playThen([[QUIET, 100], [LOUD, 710], [QUIET, 400]], { responseActive: true });
  add(
    "710ms 소리 → 소리 시작 700ms 되는 프레임에 끼어들기(진행 중 응답 → cancel + clear) · 마이크 켬 · 셈 1",
    acts(b710.all) === acts([{ type: "cut_teacher", cancelResponse: true }]) && b710.firstActAt === 100 + 700 && b710.st.micOpen && b710.st.cut && b710.st.stats.bargeIns === 1,
    `동작 ${acts(b710.all)} @${b710.firstActAt}ms`,
  );
  const bDone = playThen([[QUIET, 100], [LOUD, 1_200]], { responseActive: false });
  add("생성이 끝나 소리만 남았으면 끼어들기 = clear만(cancel 없음 — 진행 중 응답 없이 cancel은 서버 오류)", acts(bDone.all) === acts([{ type: "cut_teacher", cancelResponse: false }]), acts(bDone.all));
  add("한 재생에서 끊기는 한 번(끊은 뒤 1.2초 말해도 동작 1)", bDone.all.length === 1 && bDone.st.stats.bargeIns === 1);

  // 6. 짧은 덩어리 여러 개 — 틈이 250ms를 넘으면 따로, 넘지 않으면 한 덩어리
  const chunks = playThen([[LOUD, 200], [QUIET, 300], [LOUD, 200], [QUIET, 300], [LOUD, 200], [QUIET, 300], [LOUD, 200], [QUIET, 300]]);
  add(
    "200ms 소리 넷(틈 300ms — \"음… 어… 응… 네\") → 합 800ms여도 끼어들기 없음 · 짧은 소리 4",
    chunks.all.length === 0 && chunks.st.stats.shortSounds === 4 && !chunks.st.micOpen,
    JSON.stringify(chunks.st.stats),
  );
  const joined = playThen([[LOUD, 200], [QUIET, 240], [LOUD, 200], [QUIET, 240], [LOUD, 200], [QUIET, 240], [LOUD, 200]]);
  add(
    "200ms 소리 넷(틈 240ms — 음절 사이 틈) → 한 덩어리로 합 700ms에서 끼어들기",
    acts(joined.all) === acts([{ type: "cut_teacher", cancelResponse: false }]) && joined.st.stats.shortSounds === 0 && joined.firstActAt === 3 * 440 + 100,
    `@${joined.firstActAt}`,
  );
  const gap260 = playThen([[LOUD, 400], [QUIET, 260], [LOUD, 400], [QUIET, 300]]);
  const gap250 = playThen([[LOUD, 400], [QUIET, 250], [LOUD, 400]]);
  add(
    "틈 경계: 260ms 틈이면 따로(400+400 끼어들기 없음), 250ms 틈이면 이어짐(700에서 끼어들기)",
    gap260.all.length === 0 && gap260.st.stats.shortSounds === 2 && gap250.all.length === 1,
    `${acts(gap260.all)} · ${acts(gap250.all)}`,
  );

  // 7. 잡음 바닥 변화 — 같은 -40 dBFS 1초가 조용한 방에선 끼어들기, 시끄러운 방(바닥 -35)에선 소리로 안 봄
  const quietRoom = playThen([[-40, 1_000]], { floor: -70 });
  const noisyRoom = playThen([[-40, 1_000]], { floor: -35 });
  add(
    "같은 -40 dBFS 1초: 조용한 방(문턱 -45) → 끼어들기 · 시끄러운 방(바닥 -35 → 문턱 -20) → 동작 0·덩어리 0",
    quietRoom.all.length === 1 && noisyRoom.all.length === 0 && noisyRoom.st.stats.thresholdDb === -20 && noisyRoom.st.stats.shortSounds === 0,
    `${noisyRoom.st.stats.thresholdDb}`,
  );
  add(
    "문턱 바로 아래(-46 dBFS) 소리는 아무리 길어도 끼어들기가 아님(조용한 방 — 새어 든 잔향 크기)",
    playThen([[-46, 3_000]]).all.length === 0 && playThen([[-45, 800]]).all.length === 1,
  );

  // 8. 프레임 공백 — 타이머가 멈췄다 돌아온 시간은 120ms까지만 소리로 센다
  const stall = reduceTalkBargeInEvents(
    [play(T0), { type: "level" as const, now: T0 + 10, db: LOUD, responseActive: false }, { type: "level" as const, now: T0 + 2_010, db: LOUD, responseActive: false }],
    warm(),
  );
  add("프레임 사이 2초 공백은 120ms만 셈(끼어들기 없음)", stall.actions.length === 0 && stall.state.run?.voicedMs === 10 + TALK_LEVEL_FRAME_MAX_MS, String(stall.state.run?.voicedMs));

  // 9. 재생 끝·다음 재생
  const endMid = reduceTalkBargeIn(playThen([[LOUD, 400]]).st, stopA(T0 + 500));
  add(
    "말하는 중에 선생님 소리가 먼저 끝나면 판정을 거둠(짧은 소리로 세지 않음) · 마이크 켬(이제 서버가 은우 말을 듣는다)",
    endMid.state.micOpen && endMid.state.stats.shortSounds === 0 && endMid.state.stats.bargeIns === 0 && endMid.actions.length === 0,
  );
  const quietPeak = reduceTalkBargeIn(playThen([[-52, 500], [-49, 300]]).st, stopA(T0 + 900)).state.stats.quietPeakDb;
  const cutPeak = reduceTalkBargeIn(bDone.st, stopA(T0 + 1_500)).state.stats.quietPeakDb;
  add("진단 — 끊지 않은 재생 중 최대 음량 -49 dBFS를 남김 · 끊은 재생은 남기지 않음", quietPeak === -49 && cutPeak === null, `${quietPeak} · ${cutPeak}`);
  const next = reduceTalkBargeIn(reduceTalkBargeIn(bDone.st, stopA(T0 + 1_500)).state, play(T0 + 2_000, "r2"));
  add("다음 재생은 다시 마이크를 끄고 새로 판정(끊음 표시 초기화 · 재생 셈 2)", !next.state.micOpen && !next.state.cut && next.state.stats.playbacks === 2);

  // 10. 늦게 온 앞 응답의 멈춤(QA cutoff_2 P3-B) — 지금 재생과 id가 다르면 무시
  const r2 = reduceTalkBargeIn(p1.state, play(T0 + 100, "r2"));
  const stale = reduceTalkBargeIn(r2.state, stopA(T0 + 200, "r1"));
  const fresh2 = reduceTalkBargeIn(stale.state, stopA(T0 + 300, "r2"));
  const noId = reduceTalkBargeIn(r2.state, stopA(T0 + 200, null));
  add(
    "다음 응답(r2) 재생 중 늦게 온 r1 cleared → 마이크 닫힌 채 · r2 stopped → 켬 · id 없는 멈춤은 받아들임",
    r2.state.stats.playbacks === 2 && stale.state === r2.state && !stale.state.micOpen && fresh2.state.micOpen && noId.state.micOpen,
  );

  // 11. 닫힌 동안 끝난 서버 말소리 — 그 조각의 자동 응답만 1회 취소(1.5초 안, 앱이 청하지 않은 것)
  const gated = reduceTalkBargeInEvents([{ type: "child_speech_started", now: T0 - 200 }, play(T0), { type: "child_speech_stopped", now: T0 + 400 }], warm()).state;
  add("재생 전에 듣기 시작한 말이 마이크가 닫힌 동안 끝남 → 취소 예약(말 끝 + 1.5초)", gated.suppressUntil === T0 + 400 + TALK_AUTO_REPLY_WAIT_MS, String(gated.suppressUntil));
  const gc = reduceTalkBargeIn(gated, created(T0 + 500, "resp_frag"));
  add(
    "그 뒤 1.5초 안 자동 응답 → cancel_reply(그 id) · 셈 1 · 다음 응답은 건드리지 않음",
    acts(gc.actions) === acts([{ type: "cancel_reply", responseId: "resp_frag" }]) && gc.state.stats.repliesCancelled === 1 && reduceTalkBargeIn(gc.state, created(T0 + 600, "resp_next")).actions.length === 0,
    acts(gc.actions),
  );
  add(
    "예약 만료(1.5초 넘어 온 응답)·앱이 청한 응답(인사·도움 요청·마무리)·새 말소리로 거둔 예약은 취소하지 않음 · tick이 만료를 거둠",
    reduceTalkBargeIn(gated, created(T0 + 400 + TALK_AUTO_REPLY_WAIT_MS + 1, "late")).actions.length === 0 &&
      reduceTalkBargeIn(gated, created(T0 + 500, "nudge", true)).actions.length === 0 &&
      reduceTalkBargeInEvents([{ type: "child_speech_started", now: T0 + 450 }, created(T0 + 500, "real")], gated).actions.length === 0 &&
      reduceTalkBargeIn(gated, { type: "tick", now: T0 + 400 + TALK_AUTO_REPLY_WAIT_MS + 1 }).state.suppressUntil === null,
  );
  const openStop = reduceTalkBargeInEvents([{ type: "child_speech_started", now: T0 }, { type: "child_speech_stopped", now: T0 + 900 }, created(T0 + 1_000, "reply")], warm());
  const afterCut = reduceTalkBargeInEvents([{ type: "child_speech_stopped", now: T0 + 1_400 }, created(T0 + 1_500, "reply_after_cut")], bDone.st);
  add(
    "마이크가 열린 채 끝난 말(재생 없음·끼어들어 켠 뒤)의 자동 응답은 취소하지 않음(은우 말에 대한 대답)",
    openStop.actions.length === 0 && afterCut.actions.length === 0,
    `${acts(openStop.actions)} · ${acts(afterCut.actions)}`,
  );

  // 12. 같은 객체·기록 상한
  const idle = fresh();
  add("판정 대기·예약이 없으면 tick·created·말소리 이벤트가 상태를 바꾸지 않음(같은 객체)", reduceTalkBargeIn(idle, { type: "tick", now: T0 }).state === idle && reduceTalkBargeIn(idle, created(T0, "r")).state === idle && reduceTalkBargeIn(idle, { type: "child_speech_stopped", now: T0 }).state === idle && reduceTalkBargeIn(idle, stopA(T0)).state === idle);
  let many = warm();
  for (let i = 0; i < 12; i++) {
    const base = T0 + i * 10_000;
    many = reduceTalkBargeIn(many, play(base, `m${i}`)).state;
    many = reduceTalkBargeInEvents(talkLevelFrames(base, [[LOUD, 200], [QUIET, 400]], F), many).state;
    many = reduceTalkBargeIn(many, stopA(base + 2_000, `m${i}`)).state;
  }
  add("최근 소리 덩어리 기록은 8개까지(오래된 것부터 버림)·셈은 전부", many.stats.recent.length === TALK_BARGE_IN_RECENT_MAX && many.stats.shortSounds === 12 && many.stats.playbacks === 12, JSON.stringify(many.stats).slice(0, 140));
  const lf = talkLevelFrames(100, [[-30, 30], [-60, 20]], 10, true);
  add("talkLevelFrames: 구간 길이/간격만큼 프레임 · 첫 시각 = 시작 + 간격", lf.length === 5 && lf[0].now === 110 && lf[2].db === -30 && lf[3].db === -60 && lf[4].now === 150 && lf.every((f) => f.responseActive));
  return results;
}

/**
 * 반이중 배선(§12-1) — 브라우저 API라 오프라인으로 태울 수 없는 자리를 소스로 잠근다(주석을 걷고 본다).
 * 복제 트랙으로 듣기(원본을 끄면 원본 소스는 무음), destination에 잇지 않기(되울림), 탭 안 컨텍스트(마이크 요청 뒤), enabled로 끄기.
 */
function runTalkHalfDuplexStaticChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 정적");
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const meter = read("lib/talk-level-meter.ts");
  add(
    "레벨 미터는 마이크 트랙의 복제로 듣고(track.clone → MediaStream([clone])) destination에 잇지 않으며 멈출 때 복제를 stop",
    /clone = track\.clone\(\)/.test(meter) && /createMediaStreamSource\(new MediaStream\(\[clone\]\)\)/.test(meter) && !/\.destination/.test(meter) && /clone\.stop\(\)/.test(meter),
  );
  const start = read("components/talk-start-view.tsx");
  const micAt = start.indexOf("acquireMicStream()");
  const ctxAt = start.indexOf("createTalkLevelContext()");
  add(
    "📞 탭 핸들러가 레벨 컨텍스트를 마이크 요청 뒤에 동기로 만들어 컨트롤러에 넘김(iOS — 탭 밖 컨텍스트는 suspended)",
    micAt > 0 && ctxAt > micAt && /new TalkCallController\(\{[^}]*levelContext[^}]*\}\)/.test(start) && !/await[^;]*createTalkLevelContext/.test(start),
    `mic@${micAt} ctx@${ctxAt}`,
  );
  const ctl = read("lib/talk-realtime.ts");
  add(
    "컨트롤러는 서버로 가는 트랙을 enabled로만 켜고 끔(replaceTrack 없음) · end에서 미터 멈춤과 컨텍스트 닫기",
    /t\.enabled = open/.test(ctl) && !/replaceTrack\(/.test(ctl) && /this\.stopMeter\(\);[\s\S]{0,40}closeTalkLevelContext\(this\.opts\.levelContext\)/.test(ctl),
  );
  return results;
}

/** 문장 나누기 — 결정적(설명 키 = turnIndex·sentenceIndex) */
function runTalkSentenceChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 문장");
  const cases: [string, string, string[]][] = [
    ["마침표·물음표·느낌표 뒤 공백", "Hello! I am Sunny. Do you like dogs?", ["Hello!", "I am Sunny.", "Do you like dogs?"]],
    ["숫자 속 마침표는 안 자름", "It is 3.5 meters long. Wow!", ["It is 3.5 meters long.", "Wow!"]],
    ["소수점 여러 개도 안 자름", "The score is 2.5 to 1.5 now. Good!", ["The score is 2.5 to 1.5 now.", "Good!"]],
    ["호칭 약어 뒤는 안 자름", "Mr. Bear is here. Say hi!", ["Mr. Bear is here.", "Say hi!"]],
    ["한국어 문장 끝", "사과가 좋아요. 바나나도 좋아요!", ["사과가 좋아요.", "바나나도 좋아요!"]],
    ["닫는 따옴표는 앞 문장에", "\"Wow!\" she said. Yes.", ["\"Wow!\"", "she said.", "Yes."]],
    ["연속 부호·말줄임", "Really?! Um... I like cats.", ["Really?!", "Um...", "I like cats."]],
    ["부호 없음 → 통째로 한 문장", "  my dog is big  ", ["my dog is big"]],
    ["빈 글자 → 없음", "   ", []],
  ];
  for (const [name, text, expected] of cases) {
    const got = splitTalkSentences(text);
    add(`문장 나누기: ${name}`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
  }
  const sample = "Hello! I am Sunny. It is 3.5 meters. Do you like dogs?";
  add("같은 글자는 늘 같게 나뉜다(결정적)", JSON.stringify(splitTalkSentences(sample)) === JSON.stringify(splitTalkSentences(`${sample}`)) && splitTalkSentences(sample).length === 4);
  const turns: TalkTurn[] = [
    { speaker: "teacher", text: "Hello! Do you like dogs?", interrupted: false, origin: "greeting" },
    { speaker: "child", text: "Yes.", interrupted: false, origin: null },
  ];
  const picked = pickTalkSentence(turns, 0, 1);
  add("pickTalkSentence: 범위 안", picked?.speaker === "teacher" && picked.sentence === "Do you like dogs?", JSON.stringify(picked));
  add(
    "pickTalkSentence: 범위 밖·정수 아님 → null(라우트 400)",
    pickTalkSentence(turns, 0, 2) === null && pickTalkSentence(turns, 2, 0) === null && pickTalkSentence(turns, -1, 0) === null && pickTalkSentence(turns, 0.5, 0) === null && pickTalkSentence(turns, 1, 1) === null,
  );
  return results;
}

/** 호출 I zod 반례 + 사용자 메시지 문맥 창 */
function runTalkExplainChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 호출I");
  // [말투] 예시 인용문 — 한국어 예시 속 라틴 글자는 ko 조각 라틴 금지 zod와 부딪혀 모델이 따라 쓰면 재요청이 난다
  // (QA talk-ai P2-5 → 2026-09-26 예시 교체. 원문 자체는 spec-sync가 잠그고, 여기서는 "왜 이 예시인가"를 잠근다)
  const toneStart = TALK_EXPLAIN_SYSTEM_PROMPT.indexOf("[말투]");
  const toneEnd = toneStart < 0 ? -1 : TALK_EXPLAIN_SYSTEM_PROMPT.indexOf("\n[", toneStart + 1);
  const tone = toneStart < 0 || toneEnd < 0 ? "" : TALK_EXPLAIN_SYSTEM_PROMPT.slice(toneStart, toneEnd);
  const toneQuotes = [...tone.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  add(
    "호출 I [말투] 예시 인용문에 라틴 글자 없음(ko 조각 규칙과 부딪히지 않음)",
    toneQuotes.length >= 2 && toneQuotes.every((q) => !talkContainsLatin(q)),
    toneQuotes.join(" | "),
  );
  const teacherSentence = "Do you like dogs?";
  const childSentence = "I like dog.";
  const zt = buildTalkExplainZod({ speaker: "teacher", sentence: teacherSentence });
  const zc = buildTalkExplainZod({ speaker: "child", sentence: childSentence });
  const okTeacher: TalkSentenceExplanation = {
    script: [
      { lang: "ko", text: "선생님이 이렇게 물었어요." },
      { lang: "en", text: "Do you like dogs?" },
      { lang: "ko", text: "'강아지 좋아해요?'라는 뜻이에요. 이렇게 대답해 봐요." },
      { lang: "en", text: "Yes, I do!" },
    ],
    betterEn: null,
    keyWords: [
      { en: "dogs", ko: "강아지들" },
      { en: "Like", ko: "좋아하다" },
    ],
  };
  const okChild: TalkSentenceExplanation = {
    script: [
      { lang: "ko", text: "영어로 또박또박 말했어요! 정말 멋져요." },
      { lang: "ko", text: "강아지가 여러 마리면 이렇게 말해요." },
      { lang: "en", text: "I like dogs." },
    ],
    betterEn: "I like dogs.",
    keyWords: [{ en: "dog", ko: "강아지" }],
  };
  const pass = (z: typeof zt, v: unknown) => z.safeParse(v).success;
  add("zod: 선생님 문장 정상 출력 통과(keyWords 대소문자 무시)", pass(zt, okTeacher), JSON.stringify(zt.safeParse(okTeacher).error?.issues?.slice(0, 2) ?? ""));
  add("zod: 은우 문장 정상 출력(betterEn) 통과", pass(zc, okChild), JSON.stringify(zc.safeParse(okChild).error?.issues?.slice(0, 2) ?? ""));
  add("zod: 굽은 아포스트로피도 같은 단어(don’t = don't)", pass(buildTalkExplainZod({ speaker: "teacher", sentence: "I don't know." }), { ...okTeacher, keyWords: [{ en: "don’t", ko: "안 해요" }] }));

  const withScript = (base: TalkSentenceExplanation, script: TalkSentenceExplanation["script"]) => ({ ...base, script });
  const koLong = "가".repeat(TALK_EXPLAIN_LIMITS.koPieceMaxChars + 1);
  const enLong = Array.from({ length: TALK_EXPLAIN_LIMITS.enPieceMaxWords + 1 }, () => "dog").join(" ");
  const rejects: [string, typeof zt, unknown][] = [
    ["ko 조각 속 영어 글자", zt, withScript(okTeacher, [{ lang: "ko", text: "이 단어는 like예요." }, { lang: "en", text: "Do you like dogs?" }])],
    ["ko 조각 속 전각 영어 글자", zt, withScript(okTeacher, [{ lang: "ko", text: "이 단어는 ｌｉｋｅ예요." }, { lang: "en", text: "Do you like dogs?" }])],
    ["en 조각 속 한글", zt, withScript(okTeacher, [{ lang: "ko", text: "이렇게 말해요." }, { lang: "en", text: "I like 강아지." }])],
    ["en 조각 0개", zt, withScript(okTeacher, [{ lang: "ko", text: "좋은 질문이에요." }, { lang: "ko", text: "대답해 봐요." }])],
    ["ko 조각 0개", zt, withScript(okTeacher, [{ lang: "en", text: "Do you like dogs?" }, { lang: "en", text: "Yes, I do!" }])],
    ["조각 1개", zt, withScript(okTeacher, [{ lang: "en", text: "Do you like dogs?" }])],
    [`조각 ${TALK_EXPLAIN_LIMITS.scriptMax + 1}개`, zt, withScript(okTeacher, Array.from({ length: TALK_EXPLAIN_LIMITS.scriptMax + 1 }, (_, i) => (i % 2 === 0 ? { lang: "ko" as const, text: "좋아요." } : { lang: "en" as const, text: "Yes!" })))],
    [`ko 조각 ${TALK_EXPLAIN_LIMITS.koPieceMaxChars + 1}자`, zt, withScript(okTeacher, [{ lang: "ko", text: koLong }, { lang: "en", text: "Yes!" }])],
    [`en 조각 ${TALK_EXPLAIN_LIMITS.enPieceMaxWords + 1}단어`, zt, withScript(okTeacher, [{ lang: "ko", text: "이렇게 말해요." }, { lang: "en", text: enLong }])],
    [
      `ko 글자 합 ${TALK_EXPLAIN_LIMITS.koTotalMaxChars}자 초과`,
      zt,
      withScript(okTeacher, [...Array.from({ length: 6 }, () => ({ lang: "ko" as const, text: "나".repeat(70) })), { lang: "en", text: "Yes!" }]),
    ],
    ["빈 조각", zt, withScript(okTeacher, [{ lang: "ko", text: "  " }, { lang: "en", text: "Yes!" }, { lang: "ko", text: "좋아요." }])],
    ["lang이 ko·en 밖", zt, withScript(okTeacher, [{ lang: "ja", text: "はい" } as never, { lang: "en", text: "Yes!" }, { lang: "ko", text: "좋아요." }])],
    ["선생님 문장에 betterEn", zt, { ...okTeacher, betterEn: "Do you love dogs?" }],
    ["문장에 없는 keyWords", zt, { ...okTeacher, keyWords: [{ en: "cats", ko: "고양이들" }] }],
    ["문장 속 단어의 일부(dog ⊄ dogs)", zt, { ...okTeacher, keyWords: [{ en: "dog", ko: "강아지" }] }],
    [`keyWords ${TALK_EXPLAIN_LIMITS.keyWordsMax + 1}개`, zt, { ...okTeacher, keyWords: [{ en: "Do", ko: "해요" }, { en: "you", ko: "너" }, { en: "like", ko: "좋아하다" }, { en: "dogs", ko: "강아지들" }] }],
    ["keyWords.ko 한글 없음", zt, { ...okTeacher, keyWords: [{ en: "dogs", ko: "dogs" }] }],
    [`keyWords.ko ${TALK_EXPLAIN_LIMITS.keyWordKoMaxChars + 1}자`, zt, { ...okTeacher, keyWords: [{ en: "dogs", ko: "강".repeat(TALK_EXPLAIN_LIMITS.keyWordKoMaxChars + 1) }] }],
    ["은우 문장 betterEn에 한글", zc, { ...okChild, betterEn: "I like 강아지들." }],
    ["은우 문장 betterEn 빈 문자열", zc, { ...okChild, betterEn: "" }],
    [`은우 문장 betterEn ${TALK_EXPLAIN_LIMITS.betterEnMaxWords + 1}단어`, zc, { ...okChild, betterEn: Array.from({ length: TALK_EXPLAIN_LIMITS.betterEnMaxWords + 1 }, () => "dogs").join(" ") }],
    ["필드 누락(keyWords)", zc, { script: okChild.script, betterEn: null }],
    // keyWords.en은 영어 단어 — 한글 문장 속 한글 단어·한글 부분 일치를 "문장 안에 있다"고 통과시키지 않는다(QA talk-ai P2-1)
    ["keyWords.en이 한글 단어(문장 안에 있어도)", buildTalkExplainZod({ speaker: "child", sentence: "나는 강아지 좋아." }), { ...okChild, betterEn: "I like dogs.", keyWords: [{ en: "강아지", ko: "강아지" }] }],
    ["keyWords.en이 한글 부분(강아 ⊂ 강아지)", buildTalkExplainZod({ speaker: "child", sentence: "나는 강아지 좋아." }), { ...okChild, betterEn: "I like dogs.", keyWords: [{ en: "강아", ko: "강아지" }] }],
    ["keyWords.en에 한글 섞임", buildTalkExplainZod({ speaker: "child", sentence: "I like 강아지 dogs." }), { ...okChild, betterEn: "I like dogs.", keyWords: [{ en: "like 강아지", ko: "좋아하다" }] }],
  ];
  for (const [name, z, value] of rejects) add(`zod 거부: ${name}`, !pass(z, value), pass(z, value) ? "통과되면 안 됨" : "거부됨");
  add(
    "zod 통과: 한글 섞인 은우 문장 속 영어 단어(apple)",
    pass(buildTalkExplainZod({ speaker: "child", sentence: "나는 apple 좋아." }), { ...okChild, betterEn: "I like apples.", keyWords: [{ en: "apple", ko: "사과" }] }),
  );
  // 경계값 통과 쪽 — 상한 그 값은 받는다(거부 쪽 +1과 짝, QA talk-ai P2-2)
  const L = TALK_EXPLAIN_LIMITS;
  const bounds: [string, typeof zt, unknown][] = [
    [`조각 ${L.scriptMin}개`, zt, withScript(okTeacher, [{ lang: "ko", text: "이렇게 물었어요." }, { lang: "en", text: "Do you like dogs?" }])],
    [`조각 ${L.scriptMax}개`, zt, withScript(okTeacher, Array.from({ length: L.scriptMax }, (_, i) => (i % 2 === 0 ? { lang: "ko" as const, text: "좋아요." } : { lang: "en" as const, text: "Yes!" })))],
    [`ko 조각 ${L.koPieceMaxChars}자`, zt, withScript(okTeacher, [{ lang: "ko", text: "가".repeat(L.koPieceMaxChars) }, { lang: "en", text: "Yes!" }])],
    [`en 조각 ${L.enPieceMaxWords}단어`, zt, withScript(okTeacher, [{ lang: "ko", text: "이렇게 말해요." }, { lang: "en", text: Array.from({ length: L.enPieceMaxWords }, () => "dog").join(" ") }])],
    [`ko 글자 합 ${L.koTotalMaxChars}자`, zt, withScript(okTeacher, [...Array.from({ length: L.koTotalMaxChars / 80 }, () => ({ lang: "ko" as const, text: "나".repeat(80) })), { lang: "en", text: "Yes!" }])],
    [`betterEn ${L.betterEnMaxWords}단어`, zc, { ...okChild, betterEn: Array.from({ length: L.betterEnMaxWords }, () => "dogs").join(" ") }],
    [`keyWords ${L.keyWordsMax}개`, zt, { ...okTeacher, keyWords: [{ en: "Do", ko: "해요" }, { en: "you", ko: "너" }, { en: "dogs", ko: "강아지들" }] }],
    [`keyWords.ko ${L.keyWordKoMaxChars}자`, zt, { ...okTeacher, keyWords: [{ en: "dogs", ko: "강".repeat(L.keyWordKoMaxChars) }] }],
  ];
  for (const [name, z, value] of bounds) add(`zod 경계 통과: ${name}`, pass(z, value), JSON.stringify(z.safeParse(value).error?.issues?.slice(0, 1) ?? ""));
  add("keyWord 경계 판정: 여러 낱말·대소문자", isKeyWordInSentence("ice cream", "I love Ice  Cream!") && !isKeyWordInSentence("ice", "I have dice.") && !isKeyWordInSentence("", "x"));

  // 사용자 메시지 — 문맥 창(앞 4 + 턴 + 뒤 2), ▶ 표시, 이름 없음, 템플릿 치환
  const turns: TalkTurn[] = Array.from({ length: 10 }, (_, i) => ({
    speaker: i % 2 === 0 ? ("teacher" as const) : ("child" as const),
    text: i === 5 ? "I like\ndogs. They are cute." : `line ${i}.`,
    interrupted: false,
    origin: i % 2 === 0 ? ("reply" as const) : null,
  }));
  const msg = buildTalkExplainUserMessage({ topicLabel: "동물", turns, turnIndex: 5, sentence: "I like dogs." });
  const expectedContext = [
    "아이: line 1.",
    "선생님: line 2.",
    "아이: line 3.",
    "선생님: line 4.",
    `${TALK_CONTEXT_MARK}아이: I like dogs. They are cute.`,
    "선생님: line 6.",
    "아이: line 7.",
  ].join("\n");
  add(
    "사용자 메시지 = 템플릿 치환(주제·화자·문장·앞 4줄+턴+뒤 2줄, ▶, 턴 속 줄바꿈은 공백)",
    msg === TALK_EXPLAIN_USER_TEMPLATE.replace("{topicLabel}", "동물").replace("{speaker}", "child").replace("{sentence}", "I like dogs.").replace("{context}", expectedContext),
    msg.split("\n").slice(0, 3).join(" / "),
  );
  const first = buildTalkExplainUserMessage({ topicLabel: "동물", turns, turnIndex: 0, sentence: "line 0." });
  add("첫 턴이면 앞줄 없이 ▶부터(턴 + 뒤 2줄)", first.endsWith(`앞뒤 대화:\n${TALK_CONTEXT_MARK}선생님: line 0.\n아이: line 1.\n선생님: line 2.`), first.split("\n").slice(4).join(" / "));
  const last = buildTalkExplainUserMessage({ topicLabel: "동물", turns, turnIndex: 9, sentence: "line 9." });
  add("마지막 턴이면 앞 4줄 + 턴", last.split("\n").slice(4).length === 5 && last.endsWith(`${TALK_CONTEXT_MARK}아이: line 9.`));
  add("사용자 메시지에 아이 이름·치환 자리 없음, ▶는 한 번", !msg.includes("은우") && !/\{[A-Za-z]+\}/.test(msg) && msg.split(TALK_CONTEXT_MARK).length === 2);
  add("범위 밖 턴 → 던짐", (() => {
    try {
      buildTalkExplainUserMessage({ topicLabel: "동물", turns, turnIndex: 10, sentence: "x" });
      return false;
    } catch {
      return true;
    }
  })());
  return results;
}

/** 설명 낭독 대본 — ko-KR/en-US 매핑·한국어 정리·300자 분할·조각 번호 */
function runTalkSpeakScriptChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 낭독");
  const q = buildTalkExplainSpeakQueue([
    { lang: "ko", text: "이 말은 🐶 " },
    { lang: "en", text: "  Do you like dogs? " },
    { lang: "ko", text: "'강아지 좋아해요?'라는 뜻이에요 → 대답해 봐요" },
    { lang: "ko", text: "   " },
    { lang: "en", text: "Yes, I do!" },
  ]);
  add(
    "ko → ko-KR(정리), en → en-US(trim만), 빈 조각 제외, 조각 번호 유지",
    JSON.stringify(q) ===
      JSON.stringify([
        { text: "이 말은", lang: "ko-KR", pieceIndex: 0 },
        { text: "Do you like dogs?", lang: "en-US", pieceIndex: 1 },
        { text: "'강아지 좋아해요?'라는 뜻이에요, 대답해 봐요", lang: "ko-KR", pieceIndex: 2 },
        { text: "Yes, I do!", lang: "en-US", pieceIndex: 4 },
      ]),
    JSON.stringify(q),
  );
  const longKo = Array.from({ length: 12 }, (_, i) => `${i + 1}번째로 강아지가 공원에서 신나게 뛰어놀았어요.`).join(" ");
  const split = buildTalkExplainSpeakQueue([{ lang: "ko", text: longKo }, { lang: "en", text: "Good job!" }]);
  const koParts = split.filter((p) => p.lang === "ko-KR");
  add(
    `${TTS_TEXT_MAX_CHARS}자 넘는 조각은 문장 단위로 나눔(같은 번호·내용 보존)`,
    longKo.length > TTS_TEXT_MAX_CHARS &&
      koParts.length >= 2 &&
      koParts.every((p) => p.text.length <= TTS_TEXT_MAX_CHARS && p.pieceIndex === 0) &&
      koParts.map((p) => p.text).join(" ").replace(/\s+/g, "") === longKo.replace(/\s+/g, ""),
    `조각 ${koParts.length}개`,
  );
  add("같은 대본은 늘 같은 조각(결정적)", JSON.stringify(buildTalkExplainSpeakQueue([{ lang: "ko", text: longKo }])) === JSON.stringify(buildTalkExplainSpeakQueue([{ lang: "ko", text: longKo }])));
  return results;
}

/** 스트릭 입력(SPEC §17-9) — 순수 함수만. /api/streak 배선·트랙 분리 반례는 eval:streak 몫 */
function runTalkStreakChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 스트릭");
  const today = "2026-09-26";
  const talkToday = { startedAt: "2026-09-26T01:00:00.000Z", childTurnCount: 3 };
  const talkSilent = { startedAt: "2026-09-26T02:00:00.000Z", childTurnCount: 0 };
  add("은우 발화 0 대화는 세지 않음", !isCountedTalkSession(talkSilent) && computeStreak(talkStreakSessions([talkSilent]), today).current === 0);
  add("대화만 한 날도 은우 스트릭이 는다", computeStreak(talkStreakSessions([talkToday]), today).current === 1 && computeStreak(talkStreakSessions([talkToday]), today).doneToday);
  const vocabYesterday = { startedAt: "2026-09-25T01:00:00.000Z", items: [{ answered: true }] };
  add("어제 단어장 시험 + 오늘 대화 → 2일 연속", computeStreak([vocabYesterday, ...talkStreakSessions([talkToday])], today).current === 2);
  add("KST 일자로 접는다(UTC 전날 15시 = KST 오늘 0시)", computeStreak(talkStreakSessions([{ startedAt: "2026-09-25T15:00:00.000Z", childTurnCount: 1 }]), today).doneToday);
  add("childTurnCount가 숫자가 아니면 세지 않음", !isCountedTalkSession({ startedAt: talkToday.startedAt, childTurnCount: Number.NaN }));
  add("todayLabel = 자유대화 · {주제}", talkStreakLabel({ topic: { labelKo: "동물" } }) === "자유대화 · 동물");
  return results;
}

/**
 * §12-6 카드 칸 규칙(호출 J 후처리가 재사용)·카드 보관·기본 문구·단어장 ✓ 매칭·숨은 안내 항목.
 * 2026-09-27(§12-7): §12-6 도구 호출 검사(parseTalkToolCall)·이어 말하기 판정(stepTalkContinue 등)·호출 결과 항목은 컨트롤러에서 걷어
 * 내며 함수와 반례를 지웠다. 그 반례 가운데 **호출 J 후처리가 같은 규칙으로 여전히 지키는 것**(답 글자 폭·되풀이·항목 단위 버림·
 * 값 정리·배열 아님)은 `sanitizeTalkScreenCards` 위로 옮겨 잠금을 남겼다(이모지 칸 목록은 이미 "자유대화 호출J"에 있다).
 */
function runTalkCardChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 카드");
  const C = TALK_CARD_LIMITS;
  const apple: TalkCard = { emoji: "🍎", en: "apple", ko: "사과" };
  // 호출 J 후처리 — 선생님 말에 apple·banana·dog·cat·family·three·frog·red apple이 다 있어 그림 근거 검사에 가려지지 않는다
  const line = "I like apples and a banana. My dog, cat, family, three frogs and a red apple!";
  const screen = (raw: unknown) => sanitizeTalkScreenCards(raw, { teacherLine: line, words: [], shown: [] });

  // 정상
  const ok = screen({ answers: ["I like apples.", "It is red."], words: [apple, { emoji: "🍌", en: "banana", ko: "바나나" }], picture: apple });
  add(
    "후처리 정상 → 답 2개·단어 2개·그림 그대로",
    JSON.stringify(ok) === JSON.stringify({ answers: ["I like apples.", "It is red."], words: [apple, { emoji: "🍌", en: "banana", ko: "바나나" }], picture: apple }),
    JSON.stringify(ok),
  );

  // 그 항목만 버림
  const mixed = screen({ answers: ["I like 사과.", "It is red.", "  ", 42], words: [], picture: null });
  add("한글 섞인 답·빈 답·문자열 아닌 답은 그 항목만 버림", JSON.stringify(mixed.answers) === '["It is red."]', JSON.stringify(mixed));
  const exact = `I have ${"a".repeat(C.answerMaxChars - 8)}.`;
  const tooLong = `I have ${"b".repeat(C.answerMaxChars - 7)}.`;
  const longAns = screen({ answers: [tooLong, exact], words: [], picture: null });
  add(
    `답 ${C.answerMaxChars + 1}자는 버리고 ${C.answerMaxChars}자는 남김`,
    exact.length === C.answerMaxChars && tooLong.length === C.answerMaxChars + 1 && JSON.stringify(longAns.answers) === JSON.stringify([exact]),
    JSON.stringify(longAns.answers.map((a) => a.length)),
  );
  const many = screen({ answers: ["Yes, I do.", "yes, i do.", "No, I don't.", "Maybe not.", "I do."], words: [], picture: null });
  add(`답은 같은 문장 되풀이를 하나로, 앞 ${C.answersMax}개까지`, JSON.stringify(many.answers) === '["Yes, I do.","No, I don\'t.","Maybe not."]', JSON.stringify(many.answers));
  const noLatin = screen({ answers: ["123!", "좋아요"], words: [apple], picture: null });
  add("남는 답이 없으면 핵심 단어도 [](단어만 있어도 — 답 예시가 도움 카드의 본체)", noLatin.answers.length === 0 && noLatin.words.length === 0);
  const words = screen({
    answers: ["I like apples."],
    words: [
      { emoji: "", en: "cat", ko: "고양이" }, // 빈 이모지
      { emoji: ":dog:", en: "dog", ko: "강아지" }, // 그림 문자 아님
      { emoji: "🐶".repeat(C.emojiMaxChars + 1), en: "dog", ko: "강아지" }, // 너무 긴 이모지
      { emoji: "🐱", en: "고양이", ko: "고양이" }, // en에 한글
      { emoji: "🐱", en: "c".repeat(C.enMaxChars + 1), ko: "고양이" }, // en 너무 김
      { emoji: "🐱", en: "cat", ko: "cat" }, // ko에 한글 없음
      { emoji: "🐱", en: "cat", ko: "고".repeat(C.koMaxChars + 1) }, // ko 너무 김
      { emoji: "🐱", en: "cat" }, // 칸 누락
      apple,
      { emoji: "👨‍👩‍👧", en: "family", ko: "가족" }, // ZWJ 이모지(코드 포인트 5)
      { emoji: "🍏", en: "Apple", ko: "사과" }, // 같은 영어 되풀이
      { emoji: "3️⃣", en: "three", ko: "셋" }, // 키캡
      { emoji: "🐸", en: "frog", ko: "개구리" }, // 넷째 — 앞 3개까지
    ],
    picture: null,
  });
  add(
    "잘못된 단어(빈·가짜 이모지·긴 값·한글 en·한글 없는 ko·칸 누락)는 그 항목만 버리고, 되풀이 하나로, 앞 3개",
    JSON.stringify(words.words.map((w) => w.en)) === '["apple","family","three"]',
    JSON.stringify(words.words.map((w) => w.en)),
  );
  add(
    "words가 배열이 아니거나 없어도 답만으로 통과",
    JSON.stringify(screen({ answers: ["Yes, I do."], picture: null })) === '{"answers":["Yes, I do."],"words":[],"picture":null}' &&
      screen({ answers: ["Yes, I do."], words: "x", picture: null }).words.length === 0,
  );
  add("그림 카드 빈 이모지 → null", screen({ answers: [], words: [], picture: { ...apple, emoji: " " } }).picture === null);
  add("그림 카드 긴 영어 → null", screen({ answers: [], words: [], picture: { ...apple, en: `${"a".repeat(C.enMaxChars)} apple` } }).picture === null);
  add("그림 카드 한글 영어 칸 → null", screen({ answers: [], words: [], picture: { ...apple, en: "사과" } }).picture === null);
  add(
    "값 앞뒤 공백·줄바꿈은 정리(그림 카드)",
    JSON.stringify(screen({ answers: [], words: [], picture: { emoji: " 🍎 ", en: " red\napple ", ko: " 빨간 사과 " } }).picture) ===
      JSON.stringify({ emoji: "🍎", en: "red apple", ko: "빨간 사과" }),
  );
  add("answers가 배열이 아니면 [](도움 없음)", screen({ answers: "Yes, I do.", words: [apple], picture: null }).answers.length === 0);

  // 기록 카드 — 검사·되풀이·30장
  const saved = sanitizeTalkCards([
    apple,
    { emoji: "🐶", en: "dog 강아지", ko: "강아지" }, // 섞인 영어 칸 — 버려져야 둘째가 star 0(QA talk-cards-j P3-G)
    { emoji: "🍏", en: "APPLE", ko: "사과" },
    { emoji: "", en: "cat", ko: "고양이" },
    ...Array.from({ length: C.savedCardsMax + 5 }, (_, i) => ({ emoji: "⭐", en: `star ${i}`, ko: `별 ${i}` })),
  ]);
  add(
    `기록 카드: 검사 통과·같은 영어는 처음 것·보인 순서대로 최대 ${C.savedCardsMax}장`,
    saved.length === C.savedCardsMax && saved[0].en === "apple" && saved[1].en === "star 0" && saved[C.savedCardsMax - 1].en === `star ${C.savedCardsMax - 2}`,
    `개수=${saved.length} 둘째=${saved[1]?.en}`,
  );
  add("기록 카드: 배열이 아니면 []", sanitizeTalkCards("x").length === 0 && sanitizeTalkCards(null).length === 0);

  // 기본 문구·글자 판정
  add(
    "기본 문구 4개(스펙 영어 그대로·우리말 뜻 있음)",
    TALK_FALLBACK_HINTS.map((h) => h.en).join("|") === "Yes!|No.|I don't know.|Can you say it again?" && TALK_FALLBACK_HINTS.every((h) => talkCardsContainsHangul(h.ko) && !talkContainsLatin(h.ko)),
  );
  const samples = ["사과", "apple", "ㄱ", "ㅏ", "日本", "123", "a사b", "", "Ａ"];
  add("카드 한글 판정 = containsHangul(같은 범위)", samples.every((x) => talkCardsContainsHangul(x) === containsHangul(x)));

  // 단어장 ✓ 매칭
  const today = [{ en: "dog" }, { en: "box" }, { en: "berry" }, { en: "ice cream" }, { en: "Cats" }];
  const matchCases: [string, string | null][] = [
    ["dog", "dog"],
    ["Dogs", "dog"],
    ["a dog!", "dog"],
    ["boxes", "box"],
    ["berries", "berry"],
    ["ice creams", "ice cream"],
    ["cat", "Cats"],
    ["do", null],
    ["dogss", null],
    ["hotdog", null],
    ["", null],
  ];
  for (const [card, expected] of matchCases) {
    add(`✓ 매칭: "${card}" → ${expected ?? "없음"}`, matchTalkWord(card, today) === expected, String(matchTalkWord(card, today)));
  }

  // 숨은 안내 항목 — system 메시지·response.create(인자 없음)·id 형식·되돌아와도 줄이 아님
  const noteEv = buildTalkSystemNoteEvent(`${TALK_HIDDEN_ITEM_PREFIX}nudge_1`, TALK_NUDGE_NOTE);
  add(
    "숨은 system 메시지 항목(role system·input_text·id app_)",
    noteEv.type === "conversation.item.create" && noteEv.item.type === "message" && "role" in noteEv.item && noteEv.item.role === "system" && JSON.stringify(noteEv.item.content) === JSON.stringify([{ type: "input_text", text: TALK_NUDGE_NOTE }]),
    JSON.stringify(noteEv).slice(0, 120),
  );
  add("response.create는 인자 없음(세션 지시문을 덮어쓰지 않음)", JSON.stringify(buildTalkResponseCreateEvent()) === '{"type":"response.create"}');
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  add(
    "앱 항목 id가 app_ 형식이 아니면 던짐(너무 긴 id 포함)",
    throws(() => buildTalkSystemNoteEvent("greet", "x")) && throws(() => buildTalkSystemNoteEvent("item_1", "x")) && throws(() => buildTalkSystemNoteEvent(`app_${"x".repeat(29)}`, "x")) && !throws(() => buildTalkSystemNoteEvent(`app_${"x".repeat(28)}`, "x")),
  );
  const sceneEv = buildTalkSystemNoteEvent(`${TALK_HIDDEN_ITEM_PREFIX}scene`, "A picture is now on the child's screen.");
  const echoed = reduceTalkTranscriptEvents([
    { type: "conversation.item.added", event_id: "e3", previous_item_id: null, item: noteEv.item },
    { type: "conversation.item.added", event_id: "e4", previous_item_id: noteEv.item.id, item: sceneEv.item },
  ] satisfies RealtimeServerEvent[]);
  add("앱이 보낸 항목이 서버에서 되돌아와도 줄이 되지 않음", echoed.lines.length === 0);
  return results;
}

/** §12-6 말문 막힘 도움 상태 기계 — 5초 표시·말 시작 접힘·선생님 재개 시 버림·12초 한 번만·🙋·기본 문구 */
function runTalkHintsChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 도움");
  const SHOW = TALK_HINT_SHOW_AFTER_MS;
  const NUDGE = TALK_HINT_NUDGE_AFTER_MS;
  const h1 = { answers: ["I like apples."], words: [{ emoji: "🍎", en: "apple", ko: "사과" }] };
  const h2 = { answers: ["It is red."], words: [] };
  const e = {
    tStart: (now: number): TalkHintsEvent => ({ type: "teacher_audio_started", now }),
    tStop: (now: number): TalkHintsEvent => ({ type: "teacher_audio_stopped", now }),
    cStart: (now: number): TalkHintsEvent => ({ type: "child_speech_started", now }),
    cStop: (now: number): TalkHintsEvent => ({ type: "child_speech_stopped", now }),
    hints: (now: number, hints: typeof h1): TalkHintsEvent => ({ type: "hints_received", now, hints }),
    help: (now: number): TalkHintsEvent => ({ type: "help_tapped", now }),
    wrap: (now: number): TalkHintsEvent => ({ type: "wrapup_started", now }),
    tick: (now: number): TalkHintsEvent => ({ type: "tick", now }),
    withheld: (now: number): TalkHintsEvent => ({ type: "nudge_withheld", now }),
  };
  const run = (events: TalkHintsEvent[], state?: TalkHintsState) => reduceTalkHintsEvents(events, state);

  add("시간 상수 5초·12초", SHOW === 5000 && NUDGE === 12000);
  const base = run([e.tStart(0), e.hints(500, h1), e.tStop(3000)]);
  add("선생님 소리가 멈추고 5초 전에는 안 보임", !viewTalkHints(reduceTalkHints(base, e.tick(3000 + SHOW - 1))).visible);
  const shown = reduceTalkHints(base, e.tick(3000 + SHOW));
  const v = viewTalkHints(shown);
  add("5초 조용하면 도움 카드(선생님이 준비한 답·단어)", v.visible && v.hints?.source === "teacher" && v.hints.answers[0].en === "I like apples." && v.hints.answers[0].ko === null && v.hints.words[0].en === "apple", JSON.stringify(v.hints));
  add("은우가 말을 시작하면 접힘", !viewTalkHints(reduceTalkHints(shown, e.cStart(9000))).visible);
  const whileChild = run([e.cStart(9000), e.tick(40_000)], shown);
  add("은우가 말하는 동안은 띄우지도 청하지도 않음", !whileChild.visible && !whileChild.shouldNudge && !whileChild.nudgedThisTurn);
  const afterChild = run([e.cStart(9000), e.cStop(10_000), e.tick(10_000 + SHOW)], shown);
  add("은우 말이 멈춘 뒤 5초 조용하면 같은 도움을 다시 띄움", viewTalkHints(afterChild).visible && viewTalkHints(afterChild).hints?.source === "teacher");

  const fallback = viewTalkHints(run([e.tStart(0), e.tStop(1000), e.tick(1000 + SHOW)]));
  add(
    "받은 도움이 없으면 기본 문구(영어 + 우리말 뜻)",
    fallback.visible && fallback.hints?.source === "fallback" && fallback.hints.answers.map((a) => a.en).join("|") === TALK_FALLBACK_HINTS.map((h) => h.en).join("|") && fallback.hints.answers.every((a) => a.ko !== null),
  );
  const replaced = viewTalkHints(run([e.tStart(0), e.tStop(1000), e.tick(1000 + SHOW), e.hints(7000, h2)]));
  add("기본 문구가 떠 있을 때 도움이 오면 그 도움으로 바뀜", replaced.visible && replaced.hints?.source === "teacher" && replaced.hints.answers[0].en === "It is red.");

  // 12초 — 차례 하나에 한 번만
  const q = run([e.tStart(0), e.tStop(1000)]);
  add("12초 전에는 도움 요청 없음", !reduceTalkHints(q, e.tick(1000 + NUDGE - 1)).shouldNudge);
  const n1 = reduceTalkHints(q, e.tick(1000 + NUDGE));
  add("12초 조용하면 도움 요청(이 전이에서만 true)", n1.shouldNudge && !reduceTalkHints(n1, e.tick(1000 + NUDGE + 100)).shouldNudge);
  const n1later = run([e.tick(1000 + NUDGE + 100), e.tick(60_000)], n1);
  add("같은 차례에는 다시 청하지 않음", !n1later.shouldNudge && n1later.nudgedThisTurn);
  const n2 = run([e.tStart(14_000), e.tStop(16_000), e.tick(16_000 + NUDGE)], n1);
  add("선생님이 다시 말한 새 차례에는 다시 한 번 청함", n2.shouldNudge);

  // 은우가 말하기 전 연속 상한(§12-6 "연속 2번") — 12초 자동·🙋 합산, 은우 speech_started로만 0이 된다.
  // 전이마다 shouldNudge를 세야 "어느 전이에서도 요청이 없다"를 잠근다(마지막 상태 하나로는 중간 전이의 요청을 못 본다).
  const ticks = (from: number, to: number): TalkHintsEvent[] => {
    const out: TalkHintsEvent[] = [];
    for (let t = from; t <= to; t += 250) out.push(e.tick(t));
    return out;
  };
  const fold = (events: TalkHintsEvent[], state: TalkHintsState = createTalkHints()) => {
    let st = state;
    let nudges = 0;
    for (const ev of events) {
      st = reduceTalkHints(st, ev);
      if (st.shouldNudge) nudges += 1;
    }
    return { st, nudges };
  };
  /** 선생님 차례 하나 — 말하고(1초) 멈춘 뒤 `quietMs` 동안 250ms마다 tick */
  const quietTurn = (at: number, quietMs: number): TalkHintsEvent[] => [e.tStart(at), e.tStop(at + 1000), ...ticks(at + 1000, at + 1000 + quietMs)];
  add("연속 상한 상수 = 2", TALK_HINT_NUDGE_STREAK_MAX === 2, String(TALK_HINT_NUDGE_STREAK_MAX));
  const silentTurns = (count: number) => {
    const evs: TalkHintsEvent[] = [];
    for (let i = 0; i < count; i++) evs.push(...quietTurn(i * 20_000, NUDGE + 2000));
    return evs;
  };
  const two = fold(silentTurns(2));
  add("조용한 선생님 차례 둘: 요청 2번(차례마다 한 번, 셈 1 → 2)", two.nudges === 2 && two.st.nudgeStreak === 2, `요청 ${two.nudges} · 셈 ${two.st.nudgeStreak}`);
  const four = fold(silentTurns(4));
  add(
    "은우가 말하기 전 3·4번째 차례: 요청 없음(모든 전이), 카드는 계속 뜸",
    four.nudges === 2 && four.st.nudgeStreak === 2 && viewTalkHints(four.st).visible && !four.st.nudgedThisTurn,
    `요청 ${four.nudges} · 셈 ${four.st.nudgeStreak} · visible=${four.st.visible} · nudgedThisTurn=${four.st.nudgedThisTurn}`,
  );
  const third = fold(quietTurn(40_000, NUDGE + 2000), two.st);
  add("3번째 차례 기본 문구 카드가 5초 뒤 뜸(요청만 막힘)", third.nudges === 0 && viewTalkHints(third.st).hints?.source === "fallback");
  const reset = reduceTalkHints(four.st, e.cStart(90_000));
  add("은우가 말을 시작하면(speech_started) 그 전이에서 셈이 0", reset.nudgeStreak === 0 && four.st.nudgeStreak === 2);
  const afterSpeakSameTurn = fold([e.cStart(90_000), e.cStop(91_000), ...ticks(91_000, 91_000 + NUDGE + 2000)], four.st);
  add(
    "상한 뒤 은우가 말하다 멈추면 같은 차례에서도 12초 뒤 다시 청함(한 번)",
    afterSpeakSameTurn.nudges === 1 && afterSpeakSameTurn.st.nudgeStreak === 1,
    `요청 ${afterSpeakSameTurn.nudges} · 셈 ${afterSpeakSameTurn.st.nudgeStreak}`,
  );
  const afterSpeakNewTurns = fold([e.cStart(90_000), e.cStop(91_000), ...quietTurn(92_000, NUDGE + 2000), ...quietTurn(112_000, NUDGE + 2000), ...quietTurn(132_000, NUDGE + 2000)], four.st);
  add(
    "은우 발화 뒤 다시 연속 2번까지 허용(그다음 차례는 다시 막힘)",
    afterSpeakNewTurns.nudges === 2 && afterSpeakNewTurns.st.nudgeStreak === 2,
    `요청 ${afterSpeakNewTurns.nudges} · 셈 ${afterSpeakNewTurns.st.nudgeStreak}`,
  );
  add("선생님 재개·은우 말 멈춤은 셈을 되돌리지 않음", reduceTalkHints(four.st, e.tStart(90_000)).nudgeStreak === 2 && reduceTalkHints(four.st, e.cStop(90_000)).nudgeStreak === 2);
  // 🙋도 같은 셈 — 🙋 1번 + 12초 1번이면 다음 🙋는 카드만
  const tapMix = fold([e.tStart(0), e.tStop(1000), e.help(2000), ...quietTurn(10_000, NUDGE + 2000)]);
  const tapCapped = fold([e.tStart(40_000), e.tStop(41_000), e.help(42_000), ...ticks(42_000, 41_000 + NUDGE + 2000)], tapMix.st);
  add(
    "🙋도 셈에 든다: 🙋 + 12초 = 2번 → 다음 차례 🙋는 카드만(요청 없음)",
    tapMix.nudges === 2 && tapMix.st.nudgeStreak === 2 && tapCapped.nudges === 0 && reduceTalkHints(tapMix.st, e.help(40_000)).visible,
    `앞 ${tapMix.nudges} · 뒤 ${tapCapped.nudges}`,
  );
  const tapThenSpeak = fold([e.help(80_000), e.cStart(81_000), e.cStop(82_000), ...ticks(82_000, 82_000 + NUDGE + 2000)], four.st);
  add(
    "상한에서 🙋(카드만)는 '청한 차례'가 아님 — 뒤이어 은우가 말하다 멈추면 12초 뒤 한 번 청함",
    !reduceTalkHints(four.st, e.help(80_000)).nudgedThisTurn && tapThenSpeak.nudges === 1 && tapThenSpeak.st.nudgeStreak === 1,
    `요청 ${tapThenSpeak.nudges} · 셈 ${tapThenSpeak.st.nudgeStreak}`,
  );
  const tapCappedSpeaking = reduceTalkHints(run([e.tStart(40_000)], tapMix.st), e.help(40_500));
  const tapCappedStop = reduceTalkHints(tapCappedSpeaking, e.tStop(42_000));
  add(
    "상한에서 선생님 말하는 중 🙋: 카드만, 보류 없음, 멈춰도 요청 없음",
    tapCappedSpeaking.visible && !tapCappedSpeaking.helpPending && !tapCappedSpeaking.shouldNudge && !tapCappedStop.shouldNudge,
  );
  const pendingToCap = fold([e.tStart(0), e.tStop(1000), e.tick(1000 + NUDGE), e.tStart(20_000), e.help(20_500), e.tStop(22_000), e.tStart(40_000), e.help(40_500), e.tStop(42_000)]);
  add("보류한 🙋도 셈에 든다(12초 + 보류 🙋 = 2번, 다음 보류는 안 나감)", pendingToCap.nudges === 2 && pendingToCap.st.nudgeStreak === 2, `요청 ${pendingToCap.nudges}`);
  const capIdle = fold(ticks(80_000, 82_000), four.st);
  add("상한에서 tick은 상태를 새로 만들지 않음(화면 재그림 없음)", capIdle.nudges === 0 && capIdle.st === reduceTalkHints(capIdle.st, e.tick(82_250)));

  // QA talk_4 P2-C — 위 행들은 `quietTurn`(선생님 말·멈춤·tick)만 써서 세 가지 되돌림을 못 잡았다.
  // (a) 도움 도착은 셈을 되돌리지 않는다 — 실제 대화에선 선생님 줄마다 도움이 오므로(§12-7 호출 J — 전에는 §12-6 show_hints)
  //     "도움 도착 = 셈 0"이면 상한이 사실상 꺼진다. 도움은 대개 선생님 소리가 아직 나는 중에 온다(줄 글자 확정 뒤 호출 J 응답).
  const hintedTurns = (count: number) => {
    const evs: TalkHintsEvent[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * 20_000;
      evs.push(e.tStart(at), e.hints(at + 500, i % 2 === 0 ? h1 : h2), e.tStop(at + 1000), ...ticks(at + 1000, at + 1000 + NUDGE + 2000));
    }
    return evs;
  };
  const hinted = fold(hintedTurns(4));
  add(
    "도움이 섞인 조용한 차례 4번: 요청 2번·셈 2(도움 도착은 셈을 되돌리지 않음), 4번째 카드는 그 차례의 도움",
    hinted.nudges === 2 && hinted.st.nudgeStreak === 2 && viewTalkHints(hinted.st).hints?.answers[0].en === h2.answers[0],
    `요청 ${hinted.nudges} · 셈 ${hinted.st.nudgeStreak} · 카드 ${viewTalkHints(hinted.st).hints?.answers[0].en}`,
  );
  // (b) 끼어들기(선생님 말하는 중 은우 speech_started → 선생님 소리 cleared)도 은우가 말한 것이다 — 셈 0, 말이 멈춘 뒤 12초면 다시 청함
  const bargeIn = [e.tStart(90_000), e.cStart(90_500), e.tStop(90_600), e.cStop(92_000), ...ticks(92_000, 92_000 + NUDGE + 2000)];
  const bargeAtStart = reduceTalkHints(reduceTalkHints(four.st, bargeIn[0]), bargeIn[1]);
  const barged = fold(bargeIn, four.st);
  add(
    "상한에서 끼어들기(선생님 말 중 은우 발화)도 셈을 0으로 — 말이 멈춘 뒤 12초면 한 번 청함",
    four.st.nudgeStreak === 2 && bargeAtStart.teacherSpeaking && bargeAtStart.nudgeStreak === 0 && barged.nudges === 1 && barged.st.nudgeStreak === 1,
    `끼어든 순간 셈 ${bargeAtStart.nudgeStreak} · 요청 ${barged.nudges} · 셈 ${barged.st.nudgeStreak}`,
  );
  // (c) 셈은 "보낸 요청"이지 탭 수가 아니다 — 같은 차례 두 번째 🙋(차례당 1회에 막힘)와 12초 요청 뒤 🙋는 셈에 안 든다
  const doubleTap = fold([e.tStart(0), e.tStop(1000), e.help(2000), e.help(3000)]);
  const doubleTapNext = fold(quietTurn(20_000, NUDGE + 2000), doubleTap.st);
  const autoThenTap = fold([...quietTurn(0, NUDGE + 1000), e.help(1000 + NUDGE + 1500)]);
  const autoThenTapNext = fold(quietTurn(20_000, NUDGE + 2000), autoThenTap.st);
  add(
    "같은 차례 🙋 두 번(또는 12초 요청 뒤 🙋): 요청 1번·셈 1 그대로 → 다음 차례 12초 요청이 나감",
    doubleTap.nudges === 1 && doubleTap.st.nudgeStreak === 1 && doubleTap.st.visible && doubleTapNext.nudges === 1 && doubleTapNext.st.nudgeStreak === 2 &&
      autoThenTap.nudges === 1 && autoThenTap.st.nudgeStreak === 1 && autoThenTapNext.nudges === 1 && autoThenTapNext.st.nudgeStreak === 2,
    `🙋🙋 ${doubleTap.nudges}/셈 ${doubleTap.st.nudgeStreak} → 다음 ${doubleTapNext.nudges} · 12초+🙋 ${autoThenTap.nudges}/셈 ${autoThenTap.st.nudgeStreak} → 다음 ${autoThenTapNext.nudges}`,
  );

  // (d) 셈은 **보낸** 요청이다(QA talk-cards-j full_2 P3-A) — 은우가 말하는 중 🙋는 카드만(첫 겹), 앱(lib/talk-realtime.ts)이 요청 신호를
  //     보내지 않고 버리면(말 끝 틈 — 이 상태 기계는 모른다 — ·보류 버림) `nudge_withheld`로 그 신호의 셈을 되돌린다. 되돌리지 않으면 버린 🙋가
  //     상한을 먹어 연속 2번이 1번이 되고, 자동 응답이 끝내 안 오는 차례에는 12초 요청이 영영 나가지 않았다(가상 시계 N3·N4·N4b).
  /** 앱처럼 접는다 — `withholdAt` 시각의 요청 신호는 앱이 버린 것(곧바로 nudge_withheld), 나머지는 보낸 것. 보낸 시각들을 돌려준다 */
  const foldApp = (events: TalkHintsEvent[], withholdAt: ReadonlySet<number>, state: TalkHintsState = createTalkHints()) => {
    let st = state;
    const sentAt: number[] = [];
    for (const ev of events) {
      st = reduceTalkHints(st, ev);
      if (!st.shouldNudge) continue;
      if (withholdAt.has(ev.now)) st = reduceTalkHints(st, e.withheld(ev.now));
      else sentAt.push(ev.now);
    }
    return { st, sentAt };
  };
  const tapWhileChild = reduceTalkHints(run([e.tStart(0), e.tStop(1000), e.cStart(2000)]), e.help(2500));
  add(
    "은우가 말하는 중 🙋: 카드만 — 요청 신호·보류 없음, 셈 그대로(은우 말에 대한 대답은 서버 자동 응답)",
    tapWhileChild.visible && !tapWhileChild.shouldNudge && !tapWhileChild.helpPending && !tapWhileChild.nudgedThisTurn && tapWhileChild.nudgeStreak === 0,
    JSON.stringify({ visible: tapWhileChild.visible, nudge: tapWhileChild.shouldNudge, held: tapWhileChild.helpPending, n: tapWhileChild.nudgedThisTurn, s: tapWhileChild.nudgeStreak }),
  );
  const heldThenChild = run([e.tStart(0), e.tStop(1000), e.tStart(2000), e.help(2500), e.cStart(3000)]);
  const heldChildStop = reduceTalkHints(heldThenChild, e.tStop(3100));
  add(
    "보류 🙋 뒤 은우가 말하기 시작하고(끼어들기) 선생님 소리가 멈추면 보류를 버림 — 요청 신호 없음",
    heldThenChild.helpPending && !heldChildStop.shouldNudge && !heldChildStop.helpPending && !heldChildStop.nudgedThisTurn,
    JSON.stringify({ heldBefore: heldThenChild.helpPending, nudge: heldChildStop.shouldNudge, held: heldChildStop.helpPending }),
  );
  const tapAfterChild = run([e.tStart(0), e.tStop(1000), e.cStart(2000), e.cStop(3000), e.help(3500)]);
  const withheldSt = reduceTalkHints(tapAfterChild, e.withheld(3500));
  add(
    "은우 말이 끝난 뒤 🙋는 요청(셈 1) → nudge_withheld가 그 셈을 되돌림(청하지 않은 차례·연속 셈 0) — 카드·조용함 시계 그대로, 요청 신호 없음",
    tapAfterChild.shouldNudge && tapAfterChild.nudgedThisTurn && tapAfterChild.nudgeStreak === 1 &&
      !withheldSt.shouldNudge && !withheldSt.nudgedThisTurn && withheldSt.nudgeStreak === 0 && withheldSt.visible && withheldSt.quietSince === 3000,
    JSON.stringify({ before: [tapAfterChild.nudgedThisTurn, tapAfterChild.nudgeStreak], after: [withheldSt.nudgedThisTurn, withheldSt.nudgeStreak, withheldSt.visible, withheldSt.quietSince] }),
  );
  const closedSt = run([e.tStart(0), e.tStop(1000), e.tick(1000 + NUDGE), e.wrap(20_000)]);
  add(
    "nudge_withheld는 셈을 0 아래로 내리지 않고, 마무리 뒤에는 무시(상태 그대로)",
    reduceTalkHints(createTalkHints(), e.withheld(0)).nudgeStreak === 0 && closedSt.nudgeStreak === 1 && reduceTalkHints(closedSt, e.withheld(20_001)) === closedSt,
  );
  // 자동 응답이 끝내 안 오는 드문 차례(잡음 커밋 등) — 🙋가 끼어도 은우 말이 멈춘 뒤 12초면 요청이 나간다
  /** 은우 말이 `from`에 멈춘 뒤 250ms마다 tick(12초 + 2초) */
  const tail = (from: number) => ticks(from + 250, from + NUDGE + 2000);
  const stallTalking = foldApp([e.tStart(0), e.tStop(1000), e.cStart(2000), e.help(2500), e.cStop(4000), ...tail(4000)], new Set());
  const stallGap = foldApp([e.tStart(0), e.tStop(1000), e.cStart(2000), e.cStop(3000), e.help(3200), ...tail(3000)], new Set([3200]));
  add(
    "자동 응답이 안 오는 차례: 은우 말하는 중 🙋(카드만)·말 끝 틈 🙋(앱이 버림) 뒤에도 은우 말이 멈춘 지 12초에 도움 요청 1번",
    JSON.stringify(stallTalking.sentAt) === JSON.stringify([4000 + NUDGE]) && JSON.stringify(stallGap.sentAt) === JSON.stringify([3000 + NUDGE]),
    `말하는 중 🙋 → ${JSON.stringify(stallTalking.sentAt)} · 틈 🙋 → ${JSON.stringify(stallGap.sentAt)}`,
  );
  // 버린 🙋 뒤에도 조용한 은우에게 연속 2번(보낸 요청만 센다) — 3번째 차례는 막힘
  const streakTalking = foldApp([e.tStart(0), e.tStop(1000), e.cStart(2000), e.help(2500), e.cStop(4000), ...tail(4000), ...quietTurn(20_000, NUDGE + 2000), ...quietTurn(40_000, NUDGE + 2000)], new Set());
  const streakGap = foldApp([e.tStart(0), e.tStop(1000), e.cStart(2000), e.cStop(3000), e.help(3200), ...tail(3000), ...quietTurn(20_000, NUDGE + 2000), ...quietTurn(40_000, NUDGE + 2000)], new Set([3200]));
  add(
    "은우가 말하는 중·말 끝 틈 🙋(보내지 않음) 뒤에도 조용한 은우에게 도움 요청 연속 2번 → 3번째 차례는 막힘",
    streakTalking.sentAt.length === 2 && streakTalking.st.nudgeStreak === 2 && streakGap.sentAt.length === 2 && streakGap.st.nudgeStreak === 2,
    `말하는 중 🙋 ${JSON.stringify(streakTalking.sentAt)} · 틈 🙋 ${JSON.stringify(streakGap.sentAt)}`,
  );

  // 선생님 재개 시 앞 줄의 도움을 늘 버린다(§12-7 2026-09-27 확정 — QA talk-cards-j P3-C)
  const stale = run([e.tStart(0), e.hints(500, h1), e.tStop(2000), e.cStart(3000), e.cStop(4000), e.tStart(5000)]);
  add("선생님이 다시 말하기 시작하면 카드를 접고 이전 도움을 버림", stale.hints === null && !stale.visible);
  const staleView = viewTalkHints(run([e.tStop(7000), e.tick(7000 + SHOW)], stale));
  add("버린 뒤 새 도움이 없으면 기본 문구", staleView.hints?.source === "fallback");
  // 카드가 **떠 있는 중**에 선생님이 다시 말함(QA cards P2-2) — 위 `stale`은 은우 발화로 이미 접힌 뒤라 `visible:false`를 잠그지 못한다
  const showingPre = run([e.tStart(0), e.hints(500, h1), e.tStop(2000), e.tick(2000 + SHOW)]);
  const showingResume = reduceTalkHints(showingPre, e.tStart(9000));
  add(
    "카드가 보이는 중 선생님이 다시 말하면 카드를 접고 이전 도움을 버림",
    viewTalkHints(showingPre).visible && viewTalkHints(showingPre).hints?.source === "teacher" && !showingResume.visible && showingResume.hints === null && !viewTalkHints(showingResume).visible,
    `전 visible=${showingPre.visible} 후 visible=${showingResume.visible} hints=${JSON.stringify(showingResume.hints)}`,
  );
  // 가장 흔한 흐름 — 12초 도움 요청 → 선생님이 예시 답을 말함
  const nudged = run([e.tStart(0), e.hints(500, h1), e.tStop(2000), e.tick(2000 + SHOW), e.tick(2000 + NUDGE)]);
  const nudgeResume = reduceTalkHints(nudged, e.tStart(2000 + NUDGE + 1500));
  add(
    "12초 도움 요청 뒤 선생님이 말하면 카드를 접고 이전 도움을 버림(새 차례로 셈)",
    nudged.visible && nudged.shouldNudge && !nudgeResume.visible && nudgeResume.hints === null && !nudgeResume.nudgedThisTurn && !nudgeResume.shouldNudge,
    `전 visible=${nudged.visible} nudge=${nudged.shouldNudge} 후 visible=${nudgeResume.visible} hints=${JSON.stringify(nudgeResume.hints)} nudgedThisTurn=${nudgeResume.nudgedThisTurn}`,
  );
  const nudgeFallback = run([e.tStart(0), e.tStop(2000), e.tick(2000 + NUDGE), e.tStart(2000 + NUDGE + 1500)]);
  add("기본 문구가 떠 있는 중 12초 요청 뒤 선생님이 말해도 접힘", !nudgeFallback.visible && !viewTalkHints(nudgeFallback).visible && nudgeFallback.hints === null);
  // 호출 J는 선생님 줄이 끝난 **뒤**(소리가 멈춘 뒤일 수도) 도착한다 — §12-6의 "마지막 멈춤보다 먼저 받은 도움만 버린다"(도구를 먼저
  // 부르던 순서용 epoch 규칙)를 두면 L1의 도움이 L2 동안 살아남고, L2의 호출 J가 실패하면 L2 질문 아래 L1의 답 예시가 떴다(P3-C 재현).
  const lateJ = run([e.tStart(0), e.tStop(2000), e.hints(2500, h1), e.cStart(4000), e.cStop(5000), e.tStart(6000)]);
  const lateJShown = viewTalkHints(run([e.tStop(8000), e.tick(8000 + SHOW)], lateJ));
  add(
    "소리 멈춘 뒤 도착한 L1 도움은 L2가 시작되면 버림 → L2의 호출 J가 실패하면 기본 문구(L1 답 예시가 아님)",
    lateJ.hints === null && lateJShown.visible && lateJShown.hints?.source === "fallback",
    JSON.stringify(lateJShown.hints?.answers.map((a) => a.en)),
  );
  const lateJOk = viewTalkHints(run([e.tStop(8000), e.hints(8500, h2), e.tick(8000 + SHOW)], lateJ));
  add(
    "L2의 호출 J가 도착하면 그 도움이 뜸(가장 최근 선생님 줄의 도움)",
    lateJOk.visible && lateJOk.hints?.source === "teacher" && lateJOk.hints.answers[0].en === "It is red.",
    JSON.stringify(lateJOk.hints),
  );
  // 12초 도움 요청 → 선생님 예시 답(nudge 줄)이 시작되면 앞 도움을 버리고, 그 줄의 호출 J 도움이 오면 그것이 뜬다
  const nudgeLine = run([e.tStart(2000 + NUDGE + 1500), e.tStop(2000 + NUDGE + 4000), e.hints(2000 + NUDGE + 4200, h2), e.tick(2000 + NUDGE + 4000 + SHOW)], nudged);
  add(
    "12초 요청 뒤 선생님 예시 답 줄: 시작하면 앞 도움을 버리고, 그 줄의 호출 J 도움이 5초 뒤 뜸",
    viewTalkHints(nudgeLine).visible && viewTalkHints(nudgeLine).hints?.answers[0].en === "It is red.",
    JSON.stringify(viewTalkHints(nudgeLine).hints),
  );
  const heldDuringSpeech = run([e.tStart(0), e.hints(500, h1), e.tStop(3000), e.tick(3000 + SHOW)]);
  add(
    "같은 줄이 말하는 중에 도착한 도움은 그 줄의 소리가 멈춘 뒤 그대로 뜸(버리는 것은 다음 줄이 시작될 때뿐)",
    viewTalkHints(heldDuringSpeech).hints?.source === "teacher" && viewTalkHints(heldDuringSpeech).hints?.answers[0].en === "I like apples.",
  );

  // 🙋
  const tap = reduceTalkHints(run([e.tStart(0), e.tStop(1000)]), e.help(2000));
  add("🙋: 도움 카드를 바로 띄우고 도움 요청도 바로", tap.visible && tap.shouldNudge);
  add("🙋 뒤 12초가 지나도 같은 차례에는 다시 청하지 않음", !run([e.tick(1000 + NUDGE + 1)], tap).shouldNudge);
  const tapSpeaking = reduceTalkHints(run([e.tStart(0), e.tStop(1000), e.tStart(2000)]), e.help(2500));
  add("🙋 선생님 말하는 중: 카드만 바로, 요청은 보류", tapSpeaking.visible && !tapSpeaking.shouldNudge && tapSpeaking.helpPending);
  add("보류한 요청은 선생님 소리가 멈출 때 보냄", reduceTalkHints(tapSpeaking, e.tStop(4000)).shouldNudge);
  add("보류 중 새 차례가 시작되면 보류를 버림", !run([e.tStart(3000), e.tStop(5000)], tapSpeaking).shouldNudge);
  const tapBefore = reduceTalkHints(createTalkHints(), e.help(0));
  add("🙋 선생님이 아직 말하기 전(연결 중): 카드만(청할 질문이 없음)", tapBefore.visible && !tapBefore.shouldNudge && viewTalkHints(tapBefore).hints?.source === "fallback");

  // 마무리·겹친 멈춤·연결 직후·시간 배율
  const wrapped = run([e.tStart(0), e.tStop(1000), e.wrap(2000), e.tick(60_000), e.help(61_000)]);
  add("마무리 뒤에는 카드도 요청도 없음", !wrapped.visible && !wrapped.shouldNudge && !wrapped.nudgedThisTurn);
  const dup = run([e.tStart(0), e.tStop(1000), e.tStop(4000), e.tick(1000 + SHOW)]);
  add("겹친 멈춤(stopped 뒤 cleared)이 조용함 시계를 되감지 않음", dup.visible && dup.stopCount === 1);
  add("선생님이 한 번도 말하기 전에는 시간이 가도 띄우지 않음(연결 중)", !run([e.tick(0), e.tick(60_000)]).visible);
  const fast = talkHintTimings(0.1);
  add("개발 전용 시간 배율(0.1 → 0.5초·1.2초)", fast.showAfterMs === 500 && fast.nudgeAfterMs === 1200 && talkHintTimings(0).showAfterMs === SHOW);
  const scaled = run([e.tStart(0), e.tStop(100), e.tick(600), e.tick(1300)], createTalkHints(fast));
  add("배율을 준 상태 기계는 짧은 시간에 띄우고 청함", scaled.visible && scaled.nudgedThisTurn);

  // 서버 이벤트 → 도움 이벤트
  const map = (type: string) => talkHintEventFromServer({ type, event_id: "e", response_id: "r" }, 7)?.type ?? null;
  add(
    "서버 이벤트 옮기기(started·stopped·cleared·speech_started·speech_stopped), 그 밖은 null",
    map("output_audio_buffer.started") === "teacher_audio_started" &&
      map("output_audio_buffer.stopped") === "teacher_audio_stopped" &&
      map("output_audio_buffer.cleared") === "teacher_audio_stopped" &&
      map("input_audio_buffer.speech_started") === "child_speech_started" &&
      map("input_audio_buffer.speech_stopped") === "child_speech_stopped" &&
      map("response.done") === null &&
      talkHintEventFromServer(null, 0) === null,
  );
  return results;
}

/**
 * 저장 본문 계획(`planTalkSaveBody`·`talkSaveBodyBytes`, lib/talk-contract.ts — SPEC §21-2 5) — keepalive 한도는 **UTF-8 바이트**로 잰다.
 * 글자 수(`body.length`)로 되돌리면 한글이 섞인 6만 글자 미만 본문이 64KiB를 넘어 keepalive로 나가 곧바로 거부된다(QA english_talk_2
 * P2-A). 문서가 내려가는 중(pagehide)에 한도를 넘으면 그림을 뺀 본문으로 — 그림보다 대화. QA qatalk3 unit.mts 사례를 옮겼다(QA 3 P2-B).
 */
function runTalkSaveBodyChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 저장 본문");
  const MAX = TALK_SAVE_KEEPALIVE_MAX_BYTES;
  const topic = resolvePresetTalkTopic("animals") as TalkTopic;
  const mk = (texts: string[], sceneB64: string | null): TalkSaveRequest => ({
    clientSessionId: "0b7e1a9c-2f4d-4c1e-9a55-3f0d2b8e6a11",
    topic,
    turns: texts.map((text, i) => ({ speaker: i % 2 ? "child" : "teacher", text, interrupted: false, origin: i % 2 ? null : "reply" })),
    cards: [{ emoji: "🐸", en: "frog", ko: "개구리" }],
    scene: sceneB64 === null ? null : { dataUrl: `data:image/jpeg;base64,${sceneB64}`, sceneEn: "a sunny farm" },
    startedAt: "2026-09-26T11:00:00.000+09:00",
    endedAt: "2026-09-26T11:05:00.000+09:00",
    model: "gpt-realtime",
    voice: "marin",
  });
  const ascii = (n: number) => "A".repeat(n);
  const sceneOf = (body: string) => (JSON.parse(body) as { scene: unknown }).scene;

  add("keepalive 한도 상수는 브라우저 64KiB(65,536바이트)보다 작다", MAX === 60_000 && MAX < 65_536, String(MAX));
  const samples = ["abc", "은우", "🐸", "▲●", "é", "\u{1F468}\u200D\u{1F469}"];
  const byteMiss = samples.filter((t) => talkSaveBodyBytes(t) !== Buffer.byteLength(t, "utf8"));
  add("talkSaveBodyBytes = UTF-8 바이트(ASCII·한글 3·이모지 4·ZWJ)", byteMiss.length === 0 && talkSaveBodyBytes("은우") === 6 && talkSaveBodyBytes("🐸") === 4, byteMiss.join(" "));

  // (a) 결함 구간 — 글자로는 6만 미만, 바이트로는 64KiB 초과(한글 6,000자 + 그림)
  const ko = "가나다라마바사아자차".repeat(100);
  const heavy = mk(Array.from({ length: 6 }, () => ko), ascii(48_000));
  const staying = planTalkSaveBody(heavy, { unloading: false });
  add(
    "한글 섞인 6만 글자 미만·64KiB 초과 본문 → keepalive:false(글자 수로 재면 true였던 구간), 그림 유지",
    staying.body.length < MAX && staying.bytes > 65_536 && staying.bytes === Buffer.byteLength(staying.body, "utf8") && !staying.keepalive && !staying.sceneDropped && sceneOf(staying.body) !== null,
    `글자 ${staying.body.length} · 바이트 ${staying.bytes} · keepalive=${staying.keepalive}`,
  );
  // (c) 떠나는 중 + 그림 + 한도 초과 → 그림을 뺀 본문으로 keepalive, 한글 턴·저장 키 보존
  const leaving = planTalkSaveBody(heavy, { unloading: true });
  const leftBody = JSON.parse(leaving.body) as TalkSaveRequest;
  add(
    "떠날 때(pagehide) 그림이 한도를 넘기면 그림을 빼고 keepalive — 한글 6턴·저장 키 보존",
    leaving.sceneDropped && leaving.keepalive && leaving.bytes < MAX && leftBody.scene === null && leftBody.turns.length === 6 && leftBody.turns.every((t) => t.text === ko) && leftBody.clientSessionId === heavy.clientSessionId,
    `바이트 ${leaving.bytes} · sceneDropped=${leaving.sceneDropped}`,
  );
  add("계획은 입력을 바꾸지 않음(그림 그대로)", heavy.scene !== null && heavy.scene.dataUrl.length === "data:image/jpeg;base64,".length + 48_000);

  // 경계 — 한글이 섞인 본문을 정확히 59,999 / 60,000바이트로 맞춘다
  const base = talkSaveBodyBytes(JSON.stringify(mk(["Hi", "Yes"], null)));
  const exact = (target: number) => {
    const extra = target - base;
    const k = Math.floor(extra / 3);
    return mk(["Hi", `Yes${"한".repeat(k)}${ascii(extra - k * 3)}`], null);
  };
  const under = planTalkSaveBody(exact(MAX - 1), { unloading: false });
  const at = planTalkSaveBody(exact(MAX), { unloading: false });
  add(
    "경계: 59,999바이트는 keepalive, 60,000바이트는 아님(한글 섞인 본문 — 글자 수는 둘 다 한참 아래)",
    under.bytes === MAX - 1 && under.keepalive && at.bytes === MAX && !at.keepalive && at.body.length < 30_000,
    `아래 ${under.bytes}B/${under.body.length}자 · 경계 ${at.bytes}B/${at.body.length}자`,
  );
  const asciiUnder = planTalkSaveBody(mk(["Hi", `Yes${ascii(59_000 - base)}`], null), { unloading: false });
  add("ASCII 59,000바이트 본문 → keepalive", asciiUnder.bytes === 59_000 && asciiUnder.keepalive, String(asciiUnder.bytes));
  const emojiHeavy = planTalkSaveBody(mk(["Hi", "🐸".repeat(15_000)], null), { unloading: false });
  add("이모지 1.5만 개(글자 3만·바이트 6만 초과) → keepalive 아님", !emojiHeavy.keepalive && emojiHeavy.body.length < MAX && emojiHeavy.bytes > MAX, `글자 ${emojiHeavy.body.length} · 바이트 ${emojiHeavy.bytes}`);

  // 떠날 때의 나머지 갈래
  const leaveSmall = planTalkSaveBody(mk(["Hi", "Yes"], ascii(40_000)), { unloading: true });
  add("떠날 때 한도 안의 그림은 유지(keepalive)", leaveSmall.keepalive && !leaveSmall.sceneDropped && sceneOf(leaveSmall.body) !== null);
  const leaveNoScene = planTalkSaveBody(mk(["Hi", "가".repeat(25_000)], null), { unloading: true });
  add("떠날 때 그림 없이 한도 초과(한글 2.5만 자) → keepalive 아님, 뺀 것 없음", !leaveNoScene.keepalive && !leaveNoScene.sceneDropped && leaveNoScene.body.length < MAX, `바이트 ${leaveNoScene.bytes}`);
  const leaveStillOver = planTalkSaveBody(mk(["Hi", "가".repeat(22_000)], ascii(30_000)), { unloading: true });
  add("떠날 때 그림을 빼도 넘으면 → 그림 빼고 keepalive 아님", leaveStillOver.sceneDropped && !leaveStillOver.keepalive && leaveStillOver.bytes >= MAX, `바이트 ${leaveStillOver.bytes}`);
  const stayBigScene = planTalkSaveBody(mk(["Hi", "Yes"], ascii(160_000)), { unloading: false });
  add("떠나지 않을 때는 그림이 한도를 넘겨도 빼지 않음(keepalive 아님)", !stayBigScene.keepalive && !stayBigScene.sceneDropped && sceneOf(stayBigScene.body) !== null);
  return results;
}

/** §12-6 주제 일러스트 — 장면 문장(프리셋·직접 입력·단어장 앞 4개)·사진 프롬프트·선생님 안내 치환 */
function runTalkSceneChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 장면");
  add(
    `프리셋 ${TALK_TOPIC_PRESETS.length}개 모두 장면 = talk-topics sceneEn`,
    TALK_TOPIC_PRESETS.every((p) => buildTalkSceneEn(resolvePresetTalkTopic(p.key) as TalkTopic) === p.sceneEn && /^[a-z]/.test(p.sceneEn)),
  );
  const custom = resolveCustomTalkTopic(" 우주\n여행 ");
  add("직접 입력 → a cheerful scene about: {정리한 주제}", custom !== null && buildTalkSceneEn(custom) === `${TALK_SCENE_CUSTOM_PREFIX}우주 여행`, custom ? buildTalkSceneEn(custom) : "null");
  const vocabTopic = resolveVocabTalkTopic({
    id: "vb_s",
    titleKo: "DAY 1",
    entries: ["apple", "banana", "cherry", "grape", "melon", "peach"].map((w) => ({ word: w, meanings: [{ ko: "과일" }], definitionKo: null })),
  });
  add(
    `단어장 → a cheerful scene with: 앞 ${TALK_SCENE_VOCAB_WORDS}개(", ")`,
    vocabTopic !== null && buildTalkSceneEn(vocabTopic) === `${TALK_SCENE_WORDS_PREFIX}apple, banana, cherry, grape`,
    vocabTopic ? buildTalkSceneEn(vocabTopic) : "null",
  );
  const twoWords = resolveVocabTalkTopic({ id: "vb_2", titleKo: "짧은 책", entries: [{ word: "sun", meanings: [], definitionKo: null }, { word: "moon", meanings: [], definitionKo: null }] });
  add("단어장 단어가 4개보다 적으면 있는 만큼", twoWords !== null && buildTalkSceneEn(twoWords) === `${TALK_SCENE_WORDS_PREFIX}sun, moon`);
  const farm = TALK_TOPIC_PRESETS[0].sceneEn;
  add("사진 프롬프트 = TALK_SCENE_IMAGE_PROMPT의 {scene} 치환", buildTalkSceneImagePrompt(farm) === TALK_SCENE_IMAGE_PROMPT.replace("{scene}", farm), buildTalkSceneImagePrompt(farm).slice(0, 90));
  add("선생님 안내 = TALK_SCENE_NOTE의 {scene} 치환", buildTalkSceneNote(farm) === TALK_SCENE_NOTE.replace("{scene}", farm));
  const tricky = buildTalkSceneNote("a {scene} $& party\nwith cake");
  add("장면 속 {…}·$&는 글자 그대로, 줄바꿈은 공백(안내 줄 구조 유지)", tricky.includes("It shows: a {scene} $& party with cake\n") && tricky.split("\n").length === 2, JSON.stringify(tricky.split("\n")[0]));
  add("장면·프롬프트에 치환 자리가 남지 않음", !/\{scene\}/.test(buildTalkSceneImagePrompt(farm)) && !/\{scene\}/.test(buildTalkSceneNote(farm)));
  return results;
}

/**
 * §12-7 호출 J — 사용자 메시지 조립·zod(타입·폭만)·후처리(근거 검사)·앱 배선 도우미(문맥·보인 카드·철 지난 도움)·모델 env.
 * 픽스처는 전부 지어낸 영어·한국어다. 실호출 0회 — 스펙에 호출 J 실호출 게이트가 없다.
 */
function runTalkCardsCallChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 호출J");
  const R = TALK_CARDS_REQUEST_LIMITS;
  const Z = TALK_SCREEN_CARDS_ZOD_LIMITS;

  // 1. 사용자 메시지 — 템플릿 한 번 훑기 치환, 단어 `en(ko)`·뜻 없으면 단어만, 없음, 줄 표시(선생님/아이)
  const msg = buildTalkCardsUserMessage({
    topicLabel: "동물",
    words: [{ en: "apple", ko: "사과" }, { en: "dog", ko: null }],
    shown: ["cat"],
    context: [
      { speaker: "teacher", text: "Hi! Do you like animals?" },
      { speaker: "child", text: "Yes." },
    ],
    teacherLine: "Great! Do you have a dog?",
  });
  const expected = TALK_CARDS_USER_TEMPLATE.replace("{topicLabel}", "동물")
    .replace("{words}", "apple(사과), dog")
    .replace("{shown}", "cat")
    .replace("{context}", "선생님: Hi! Do you like animals?\n아이: Yes.")
    .replace("{teacherLine}", "Great! Do you have a dog?");
  add("사용자 메시지 = 템플릿 치환(단어 en(ko)·뜻 없으면 단어만·문맥 줄 선생님/아이)", msg === expected, JSON.stringify(msg.split("\n")));
  const none = buildTalkCardsUserMessage({ topicLabel: "놀이", words: [], shown: [], context: [], teacherLine: "Hello! What do you like to play?" });
  add(
    `단어·보인 카드·문맥이 없으면 \`${TALK_CARDS_NONE}\``,
    none === `주제: 놀이\n오늘의 단어: ${TALK_CARDS_NONE}\n이미 보여 준 그림 카드: ${TALK_CARDS_NONE}\n최근 대화:\n${TALK_CARDS_NONE}\n선생님이 방금 한 말: Hello! What do you like to play?`,
    JSON.stringify(none),
  );
  const many = buildTalkCardsUserMessage({
    topicLabel: "DAY 1",
    words: Array.from({ length: R.words + 5 }, (_, i) => ({ en: `word${i}`, ko: `뜻${i}` })),
    shown: Array.from({ length: R.shown + 3 }, (_, i) => `pic${i}`),
    context: Array.from({ length: R.context + 2 }, (_, i) => ({ speaker: (i % 2 ? "child" : "teacher") as TalkTurn["speaker"], text: `line ${i}` })),
    teacherLine: "Look!",
  });
  const lineOf = (prefix: string) => many.split("\n").find((l) => l.startsWith(prefix)) ?? "";
  add(
    `단어는 책 순서 앞 ${R.words}개, 보인 카드는 최근 ${R.shown}개, 문맥은 최근 ${R.context}줄`,
    lineOf("오늘의 단어: ").split(", ").length === R.words &&
      lineOf("오늘의 단어: ").endsWith(`word${R.words - 1}(뜻${R.words - 1})`) &&
      lineOf("이미 보여 준 그림 카드: ") === `이미 보여 준 그림 카드: ${Array.from({ length: R.shown }, (_, i) => `pic${i + 3}`).join(", ")}` &&
      many.includes(`최근 대화:\n선생님: line 2\n아이: line 3\n선생님: line 4\n아이: line 5\n선생님이`) &&
      !many.includes("line 1\n"),
    `${lineOf("오늘의 단어: ").split(", ").length}개 · ${lineOf("이미 보여 준 그림 카드: ").slice(0, 40)}`,
  );
  const tricky = buildTalkCardsUserMessage({
    topicLabel: "우리\n동네",
    words: [{ en: " ", ko: "빈 단어" }, { en: "sun\nny", ko: "맑은" }],
    shown: ["", "  "],
    context: [{ speaker: "child", text: "   " }, { speaker: "child", text: "I\nlike it." }],
    teacherLine: "Say {teacherLine} $& now.\nWhat is it?",
  });
  add(
    "값은 한 줄로(줄바꿈 → 공백), 빈 항목은 건너뜀, 값 속 {…}·$&는 글자 그대로(재치환 없음)",
    tricky ===
      `주제: 우리 동네\n오늘의 단어: sun ny(맑은)\n이미 보여 준 그림 카드: ${TALK_CARDS_NONE}\n최근 대화:\n아이: I like it.\n선생님이 방금 한 말: Say {teacherLine} $& now. What is it?`,
    JSON.stringify(tricky),
  );
  const longLine = buildTalkCardsUserMessage({ topicLabel: "t", words: [], shown: [], context: [], teacherLine: "a".repeat(R.lineMaxChars + 50) });
  add(`선생님 말은 ${R.lineMaxChars}자로 자름(폭 한 곳)`, longLine.endsWith(`: ${"a".repeat(R.lineMaxChars)}`));
  add("사용자 메시지에 치환 자리가 남지 않고 아이 이름이 없음", !/\{(topicLabel|words|shown|context)\}/.test(msg) && !msg.includes("은우") && !none.includes("은우"));

  // 2. zod — 타입·폭만(근거·한글 검사는 후처리). 거부는 개수·길이·모양
  const card = (emoji: string, en: string, ko: string) => ({ emoji, en, ko });
  const good = { answers: ["I have a dog."], words: [card("🐶", "dog", "강아지")], picture: card("🐶", "dog", "강아지") };
  const zOk = (v: unknown) => talkScreenCardsSchema.safeParse(v).success;
  add("zod: 정상 출력 통과", zOk(good));
  add("zod: 빈 배열·picture null 통과(질문 없는 말)", zOk({ answers: [], words: [], picture: null }));
  add("zod: 근거 없는 그림·한글 섞인 답도 통과(타입·폭만 — 근거는 후처리가 거른다, 재요청으로 카드를 늦추지 않게)", zOk({ answers: ["나는 강아지 좋아."], words: [], picture: card("🦄", "unicorn", "유니콘") }));
  const zodRejects: [string, unknown][] = [
    [`answers ${Z.answersMax + 1}개`, { ...good, answers: Array.from({ length: Z.answersMax + 1 }, (_, i) => `Answer ${i}.`) }],
    [`words ${Z.wordsMax + 1}개`, { ...good, words: Array.from({ length: Z.wordsMax + 1 }, () => card("🐶", "dog", "강아지")) }],
    [`답 ${Z.answerMaxChars + 1}자`, { ...good, answers: ["a".repeat(Z.answerMaxChars + 1)] }],
    [`이모지 ${Z.emojiMaxChars + 1}자`, { ...good, picture: card("x".repeat(Z.emojiMaxChars + 1), "dog", "강아지") }],
    [`영어 ${Z.enMaxChars + 1}자`, { ...good, words: [card("🐶", "d".repeat(Z.enMaxChars + 1), "강아지")] }],
    [`뜻 ${Z.koMaxChars + 1}자`, { ...good, picture: card("🐶", "dog", "강".repeat(Z.koMaxChars + 1)) }],
    ["picture 키 없음", { answers: [], words: [] }],
    ["picture가 문자열", { ...good, picture: "dog" }],
    ["answers가 배열 아님", { ...good, answers: "I have a dog." }],
    ["카드 칸 누락", { ...good, words: [{ emoji: "🐶", en: "dog" }] }],
  ];
  for (const [name, value] of zodRejects) add(`zod 거부: ${name}`, !zOk(value));
  add(
    `zod 경계: 답 ${Z.answerMaxChars}자·answers ${Z.answersMax}개·words ${Z.wordsMax}개는 통과`,
    zOk({ answers: Array.from({ length: Z.answersMax }, () => "a".repeat(Z.answerMaxChars)), words: Array.from({ length: Z.wordsMax }, () => card("🐶", "dog", "강아지")), picture: null }),
  );

  // 3. 후처리 sanitizeTalkScreenCards — 항목 단위로 버린다(§12-6 규칙 재사용) + 그림 카드 근거
  const line = "Wow, you like dogs! Do you have a red ball?";
  const ctx = { teacherLine: line, words: [] as { en: string }[], shown: [] as string[] };
  const pic = (en: string, c = ctx, emoji = "🐶", ko = "강아지") => sanitizeTalkScreenCards({ answers: [], words: [], picture: card(emoji, en, ko) }, c).picture?.en ?? null;
  add("근거 없는 그림 카드(선생님 말에 없음) → null", pic("cat", ctx, "🐱", "고양이") === null);
  add("선생님 말의 복수형(dogs)에 단수 카드(dog) → 살림(끝의 s 허용)", pic("dog") === "dog");
  add("선생님 말의 단수형(dog)에 복수 카드(dogs) → 살림(끝의 s 양쪽 방향)", pic("dogs", { ...ctx, teacherLine: "Do you have a dog?" }) === "dogs");
  add("여러 낱말·관사: 'a red ball'·'the ball' → 살림(관사 무시, 단어 경계)", pic("a red ball", ctx, "🔴", "빨간 공") === "a red ball" && pic("the ball", ctx, "⚽", "공") === "the ball");
  add(
    "es 양쪽 방향: 말 boxes ↔ 카드 box, 말 box ↔ 카드 boxes → 살림",
    pic("box", { ...ctx, teacherLine: "I see two boxes." }, "📦", "상자") === "box" && pic("boxes", { ...ctx, teacherLine: "Is it a box?" }, "📦", "상자") === "boxes",
  );
  add("단어 경계: 말 'category'에 카드 'cat' → null, 말 'hotdog'에 'dog' → null", pic("cat", { ...ctx, teacherLine: "What category is it?" }, "🐱", "고양이") === null && pic("dog", { ...ctx, teacherLine: "I ate a hotdog." }) === null);
  add("대소문자 무시·소유격 인정: 말 'The Dog's ball'에 카드 'dog' → 살림", pic("dog", { ...ctx, teacherLine: "Look at The Dog's ball!" }) === "dog");
  add("선생님 말에 없어도 오늘의 단어면 살림(단어장 모드)", pic("apple", { ...ctx, words: [{ en: "apple" }] }, "🍎", "사과") === "apple");
  add("이미 보여 준 그림 카드와 같은 단어(대소문자·복수 무시) → null", pic("dog", { ...ctx, shown: ["Dogs"] }) === null && pic("dog", { ...ctx, shown: ["cat"] }) === "dog");
  add(
    "그림 카드 칸 검사(가짜 이모지·한글 영어·한글 없는 뜻) → null",
    pic("dog", ctx, ":dog:") === null && pic("강아지", ctx) === null && pic("dog", ctx, "🐶", "dog") === null &&
      // 섞인 영어 칸 — 라틴이 있어 라틴 검사를 지나고, 말에 그 구가 있어 근거 검사에도 가려지지 않는다(QA talk-cards-j P3-G)
      pic("dog 강아지", { ...ctx, teacherLine: "Say dog 강아지!" }) === null,
  );
  add("isTalkPictureInLine: 빈 카드·빈 말 → false", !isTalkPictureInLine("", line) && !isTalkPictureInLine("dog", "") && isTalkPictureInLine("Red Ball!", line));
  const ans = (answers: unknown[]) => sanitizeTalkScreenCards({ answers, words: [], picture: null }, ctx).answers;
  add("한글 섞인 대답 버림(그 항목만)", JSON.stringify(ans(["I like 강아지.", "Yes, I do."])) === '["Yes, I do."]', JSON.stringify(ans(["I like 강아지.", "Yes, I do."])));
  add(
    `대답 단어 수 ${TALK_SCREEN_ANSWER_WORDS.min}~${TALK_SCREEN_ANSWER_WORDS.max}개만(1단어·9단어 버림, 8단어 살림)`,
    JSON.stringify(ans(["Yes!", "I like red balls and blue cars very much.", "I like red balls and blue cars too.", "I have a dog."])) ===
      '["I like red balls and blue cars too.","I have a dog."]',
    JSON.stringify(ans(["Yes!", "I like red balls and blue cars very much.", "I like red balls and blue cars too.", "I have a dog."])),
  );
  add(
    `대답은 같은 문장 되풀이를 하나로, 앞 ${TALK_CARD_LIMITS.answersMax}개`,
    JSON.stringify(ans(["I like dogs.", "i like dogs.", "It is red.", "I have one.", "Yes, I do."])) === '["I like dogs.","It is red.","I have one."]',
  );
  const wordsOf = (answers: unknown[], words: unknown[]) => sanitizeTalkScreenCards({ answers, words, picture: null }, ctx).words.map((w) => w.en);
  add(
    "핵심 단어: 가짜 이모지·한글(섞인 값 포함) 영어 칸은 그 항목만 버림, 같은 영어 하나로, 앞 3개",
    JSON.stringify(
      wordsOf(["I have a dog."], [card(":dog:", "dog", "강아지"), card("🐶", "개", "강아지"), card("🐶", "dog 강아지", "강아지"), card("🐶", "dog", "강아지"), card("🐕", "Dog", "개"), card("⚽", "ball", "공"), card("🔴", "red", "빨강"), card("🏠", "house", "집")]),
    ) === '["dog","ball","red"]',
  );
  add("대답이 하나도 안 남으면 핵심 단어도 [](답 예시가 도움 카드의 본체 — 화면은 기본 문구)", wordsOf(["좋아요"], [card("🐶", "dog", "강아지")]).length === 0);

  // 이모지 칸 규칙(§12-6 "그대로" — QA cards P2-1 도형 기호, QA talk-cards-j P3-B) — 판정 한 곳 sanitizeTalkEmoji와 호출 J 후처리의
  // words·picture 양쪽에서 잠근다. 원래 폐기 예정 parseTalkToolCall 위에만 있던 목록을 옮겼다 — 그 함수와 반례를 지워도 잠금이 남게.
  const E = TALK_CARD_LIMITS;
  const emojiKept = [
    // 도형·기호 블록(▲●■◆△○□☆⬟⬢✦) — 이모지(🔺⭐★🔵🟥)와 함께
    "▲", "●", "■", "◆", "△", "○", "□", "☆", "◯", "▭", "⬟", "⬢", "✦", "▲●■", "🔺", "⭐", "★", "🔵", "🟥",
    // 그림 문자·키캡·국기·ZWJ 가족·여러 개, 16 코드 포인트 경계
    "🐶", "☀", "✈", "⬛", "1️⃣", "3️⃣", "🇰🇷", "👨‍👩‍👧", "🐶🐱🐭", "🐶".repeat(E.emojiMaxChars),
  ];
  const emojiLost = [
    // 글자형 기호(Ⓐ ① ㉠ ❶ ➓)·숫자·한자·ASCII 기호만 → 그림 아님. 도형 + 라틴/한글 → 라틴·한글 금지로 거부
    "1", "12", "0", "#", "*", "Ⓐ", "①", "㉠", "❶", "➓", "三", "▲A", "●빨강", "◆ red", "▲:circle:",
    // 단축어·글자·빈 값·공백·17 코드 포인트·전각 라틴
    ":dog:", "dog", "개", "", "   ", "🐶".repeat(E.emojiMaxChars + 1), "Ａ🐶",
  ];
  const shapeLine = { ...ctx, teacherLine: "Look at the triangle!" };
  const screenWord = (emoji: string) => sanitizeTalkScreenCards({ answers: ["It is a triangle."], words: [card(emoji, "triangle", "세모")], picture: null }, shapeLine).words[0]?.emoji ?? null;
  const screenPic = (emoji: string) => sanitizeTalkScreenCards({ answers: [], words: [], picture: card(emoji, "triangle", "세모") }, shapeLine).picture?.emoji ?? null;
  const emojiJudges: [string, (e: string) => string | null][] = [
    ["sanitizeTalkEmoji", sanitizeTalkEmoji],
    ["호출 J words", screenWord],
    ["호출 J picture", screenPic],
  ];
  for (const [where, judge] of emojiJudges) {
    const lost = emojiKept.filter((e) => judge(e) !== e);
    add(
      `이모지 칸 통과(${where}): 도형·기호 블록·이모지·키캡·국기·ZWJ·${E.emojiMaxChars} 코드 포인트`,
      lost.length === 0,
      lost.length ? `버려짐: ${lost.join(" ")}` : `${emojiKept.length}개 통과`,
    );
    const kept = emojiLost.filter((e) => judge(e) !== null);
    add(
      `이모지 칸 거부(${where}): 글자·숫자만(동그라미 숫자·글자 포함)·도형에 라틴·한글 섞임·단축어·빈 값·${E.emojiMaxChars + 1} 코드 포인트`,
      kept.length === 0,
      kept.length ? `통과해 버림: ${kept.map((e) => JSON.stringify(e)).join(" ")}` : `${emojiLost.length}개 거부`,
    );
  }
  add("객체가 아니면 빈 카드", JSON.stringify(sanitizeTalkScreenCards(null, ctx)) === '{"answers":[],"words":[],"picture":null}' && JSON.stringify(sanitizeTalkScreenCards("x", ctx)) === '{"answers":[],"words":[],"picture":null}');
  const full = sanitizeTalkScreenCards(
    { answers: ["Yes, I do.", "No, I don't.", "I have a red ball."], words: [card("⚽", "ball", "공")], picture: card("⚽", "ball", "공") },
    ctx,
  );
  add(
    "정상 출력은 그대로(답 3개·단어·선생님 말에 있는 그림)",
    JSON.stringify(full) === JSON.stringify({ answers: ["Yes, I do.", "No, I don't.", "I have a red ball."], words: [card("⚽", "ball", "공")], picture: card("⚽", "ball", "공") }),
  );

  // 4. 앱 배선 도우미 — 문맥 4줄·보인 카드 12개·철 지난 도움
  const L = (itemId: string, speaker: "teacher" | "child", text: string, status: TalkLine["status"] = "final"): TalkLine => ({
    itemId,
    speaker,
    text,
    status,
    filtered: false,
    origin: speaker === "teacher" ? "reply" : null,
  });
  const lines: TalkLine[] = [
    L("t0", "teacher", "Hi!"),
    L("t1", "teacher", "Hello! I am Sunny."),
    L("c0", "child", "", "empty"),
    L("c1", "child", "Yes."),
    L("t2", "teacher", "Do you like cats?"),
    L("c2", "child", "  No.  "),
    L("c3", "child", "", "failed"),
    L("t3", "teacher", "Oh! What animal do you like?"),
  ];
  const ctxLines = pickTalkCardsContext(lines, "t3");
  add(
    `문맥: 선생님 줄 앞 최근 ${R.context}줄(빈 전사·실패 건너뜀, 글자 다듬음)`,
    JSON.stringify(ctxLines) ===
      JSON.stringify([
        { speaker: "teacher", text: "Hello! I am Sunny." },
        { speaker: "child", text: "Yes." },
        { speaker: "teacher", text: "Do you like cats?" },
        { speaker: "child", text: "No." },
      ]),
    JSON.stringify(ctxLines),
  );
  add("문맥: 선생님 줄을 못 찾으면 [] · 첫 줄이면 []", pickTalkCardsContext(lines, "nope").length === 0 && pickTalkCardsContext(lines, "t0").length === 0);
  const shownList = pickTalkCardsShown(Array.from({ length: R.shown + 3 }, (_, i) => ({ en: `pic${i}` })));
  add(`보인 카드: 보인 순서의 최근 ${R.shown}개`, shownList.length === R.shown && shownList[0] === "pic3" && shownList[R.shown - 1] === `pic${R.shown + 2}`, shownList.join(","));
  const arrivedCards = { answers: ["I like dogs."], words: [card("🐶", "dog", "강아지")], picture: card("🐶", "dog", "강아지") };
  const onTime = decideTalkCardsArrival({ cards: arrivedCards, lines, teacherItemId: "t3", live: true });
  add("도착: 그 줄이 마지막이면 도움·그림 둘 다 씀", onTime.hints?.answers[0] === "I like dogs." && onTime.hints.words[0].en === "dog" && onTime.picture?.en === "dog");
  const childStarted = decideTalkCardsArrival({ cards: arrivedCards, lines: [...lines, L("c9", "child", "", "listening")], teacherItemId: "t3", live: true });
  add("철 지난 도움: 그 줄 뒤에 은우가 이미 말을 시작했으면(듣는 중) 도움은 버리고 그림 카드는 띄움", childStarted.hints === null && childStarted.picture?.en === "dog");
  const newerTeacher = decideTalkCardsArrival({ cards: arrivedCards, lines: [...lines, L("t9", "teacher", "Can you say: I like dogs?")], teacherItemId: "t3", live: true });
  add("철 지난 도움: 그 줄 뒤에 선생님의 새 줄이 있으면 도움은 버림(다른 질문의 도움이 아니게)", newerTeacher.hints === null && newerTeacher.picture?.en === "dog");
  const lostLine = decideTalkCardsArrival({ cards: arrivedCards, lines, teacherItemId: "gone", live: true });
  add("그 줄을 못 찾으면 도움은 버림(어느 질문의 도움인지 모름), 그림은 띄움", lostLine.hints === null && lostLine.picture?.en === "dog");
  const closing = decideTalkCardsArrival({ cards: arrivedCards, lines, teacherItemId: "t3", live: false });
  add("마무리·종료 중 도착 → 둘 다 버림", closing.hints === null && closing.picture === null);
  const noQuestion = decideTalkCardsArrival({ cards: { answers: [], words: [], picture: arrivedCards.picture }, lines, teacherItemId: "t3", live: true });
  add("답 예시가 없으면(질문 없는 말) 도움 null — 화면은 기본 문구", noQuestion.hints === null && noQuestion.picture?.en === "dog");

  // 5. 모델 env — 빈 값 폴백(`||`), 기본은 비추론 소형 모델
  const savedModel = process.env.OPENAI_TALK_CARDS_MODEL;
  try {
    const got: string[] = [];
    for (const v of [undefined, "", "   "]) {
      if (v === undefined) delete process.env.OPENAI_TALK_CARDS_MODEL;
      else process.env.OPENAI_TALK_CARDS_MODEL = v;
      got.push(resolveTalkCardsModel());
    }
    process.env.OPENAI_TALK_CARDS_MODEL = " gpt-x-cards ";
    got.push(resolveTalkCardsModel());
    add(
      "호출 J 모델: env 미설정·빈 값·공백 → 기본 모델, 값은 앞뒤 공백을 걷어 그대로",
      got.join("|") === [DEFAULT_TALK_CARDS_MODEL, DEFAULT_TALK_CARDS_MODEL, DEFAULT_TALK_CARDS_MODEL, "gpt-x-cards"].join("|"),
      got.join("|"),
    );
  } finally {
    if (savedModel === undefined) delete process.env.OPENAI_TALK_CARDS_MODEL;
    else process.env.OPENAI_TALK_CARDS_MODEL = savedModel;
  }
  // 2026-10-02 사용자 결정 — 텍스트 모델은 토익 출제·채점(gpt-6.1-sol, eval-toeic)만 빼고 모두 gpt-6-luna
  add("호출 J 기본 모델 = gpt-6-luna(2026-10-02 사용자 결정 — 메인과 같은 값, env는 OPENAI_TALK_CARDS_MODEL로 따로)", DEFAULT_TALK_CARDS_MODEL === "gpt-6-luna");
  add("메인 기본 모델 DEFAULT_OPENAI_MODEL = gpt-6-luna(2026-10-02 사용자 결정)", DEFAULT_OPENAI_MODEL === "gpt-6-luna");
  {
    const savedMain = process.env.OPENAI_MODEL;
    const savedCards = process.env.OPENAI_TALK_CARDS_MODEL;
    try {
      const got: string[] = [];
      for (const v of [undefined, "", "   "]) {
        if (v === undefined) delete process.env.OPENAI_MODEL;
        else process.env.OPENAI_MODEL = v;
        got.push(resolveModel());
      }
      process.env.OPENAI_MODEL = " gpt-x-main ";
      delete process.env.OPENAI_TALK_CARDS_MODEL;
      got.push(resolveModel(), resolveTalkCardsModel());
      add(
        "메인 모델: env 미설정·빈 값·공백 → gpt-6-luna, 값은 앞뒤 공백을 걷어 그대로 · OPENAI_MODEL을 바꿔도 호출 J는 자기 기본값(따로 둔 env)",
        got.join("|") === ["gpt-6-luna", "gpt-6-luna", "gpt-6-luna", "gpt-x-main", "gpt-6-luna"].join("|"),
        got.join("|"),
      );
    } finally {
      if (savedMain === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = savedMain;
      if (savedCards === undefined) delete process.env.OPENAI_TALK_CARDS_MODEL;
      else process.env.OPENAI_TALK_CARDS_MODEL = savedCards;
    }
  }
  {
    // temperature 사전 판정 — 알려진 추론 계열(천체 이름 계열)만 처음부터 뺀다. 목록 밖은 보내고, 거부되면 런타임 재시도·기억.
    const rows: Array<[string, boolean]> = [
      ["gpt-6-luna", true],
      ["gpt-6.1-sol", true],
      ["gpt-6.1-sol-2026-09-30", true],
      ["gpt-6-terra", true],
      ["gpt-5.6-luna", true],
      [" gpt-6-luna ", true],
      ["gpt-4.1-mini", false],
      ["gpt-5.5", false],
      ["gpt-6", false],
      ["gpt-5.4-mini", false],
      ["gpt-5-luna", false],
      ["gpt-6-lunar", false],
      ["gpt-realtime-2.1", false],
      ["", false],
    ];
    const bad = rows.filter(([m, want]) => isKnownTemperatureRejectingModel(m) !== want).map(([m]) => JSON.stringify(m));
    add(
      "temperature 사전 판정 isKnownTemperatureRejectingModel: gpt-5.6+·gpt-6.x의 luna/sol/terra(스냅샷 포함)만 참 — 기본 둘(gpt-6-luna·gpt-6.1-sol)은 첫 요청부터 temperature 없음",
      bad.length === 0 && isKnownTemperatureRejectingModel(DEFAULT_OPENAI_MODEL) && isKnownTemperatureRejectingModel(DEFAULT_TALK_CARDS_MODEL),
      bad.join(", ") || "ok",
    );
  }
  add("호출 J 옵션 = talk_cards · 0.3 · 600 · 6초", TALK_CARDS_CALL_OPTIONS.call === "talk_cards" && TALK_CARDS_CALL_OPTIONS.temperature === 0.3 && TALK_CARDS_CALL_OPTIONS.maxOutputTokens === 600 && TALK_CARDS_TIMEOUT_MS === 6000);
  return results;
}

/**
 * §12-7 앱 배선 — 요청 본문 조립(`buildTalkCardsRequest` — 라우트 zod 폭에 맞춰 자른다). 순수 함수라 동기.
 */
function runTalkCardsRequestChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 카드 요청");
  const R = TALK_CARDS_REQUEST_LIMITS;
  const L = (itemId: string, speaker: "teacher" | "child", text: string, status: TalkLine["status"] = "final"): TalkLine => ({
    itemId,
    speaker,
    text,
    status,
    filtered: false,
    origin: speaker === "teacher" ? "reply" : null,
  });
  const lines = [L("t0", "teacher", "Hi! Do you like dogs?"), L("c0", "child", "Yes."), L("t1", "teacher", "  Great! What color is your dog?  ")];
  const body = buildTalkCardsRequest({
    topicLabel: "동물",
    words: [{ en: "dog", ko: "강아지" }, { en: " ", ko: "빈 단어" }, { en: "cat", ko: "" }],
    shownCards: [{ en: "dog" }, { en: "" }],
    lines,
    teacherItemId: "t1",
  });
  add(
    "요청 본문: 그 줄 글자(앞뒤 공백 정리)·앞 줄 문맥·보인 카드·단어(빈 단어 건너뜀·빈 뜻 null)·주제 라벨",
    JSON.stringify(body) ===
      JSON.stringify({
        topic: "동물",
        words: [{ en: "dog", ko: "강아지" }, { en: "cat", ko: null }],
        shown: ["dog"],
        context: [{ speaker: "teacher", text: "Hi! Do you like dogs?" }, { speaker: "child", text: "Yes." }],
        teacherLine: "Great! What color is your dog?",
      }),
    JSON.stringify(body),
  );
  add(
    "요청하지 않음(null): 은우 줄·못 찾은 줄·글자 없는 선생님 줄",
    buildTalkCardsRequest({ topicLabel: "t", words: [], shownCards: [], lines, teacherItemId: "c0" }) === null &&
      buildTalkCardsRequest({ topicLabel: "t", words: [], shownCards: [], lines, teacherItemId: "nope" }) === null &&
      buildTalkCardsRequest({ topicLabel: "t", words: [], shownCards: [], lines: [L("t9", "teacher", "   ")], teacherItemId: "t9" }) === null,
  );
  const huge = buildTalkCardsRequest({
    topicLabel: "가".repeat(R.topicLabelMaxChars + 10),
    words: Array.from({ length: R.words + 5 }, (_, i) => ({ en: `w${i}${"x".repeat(R.wordMaxChars)}`, ko: "뜻".repeat(R.wordMaxChars + 3) })),
    shownCards: Array.from({ length: R.shown + 4 }, (_, i) => ({ en: `pic ${i} ${"y".repeat(R.shownMaxChars)}` })),
    lines: [
      ...Array.from({ length: R.context + 3 }, (_, i) => L(`x${i}`, i % 2 ? "child" : "teacher", "z".repeat(R.lineMaxChars + 20))),
      L("tt", "teacher", `${"🐶".repeat(R.lineMaxChars)}`),
    ],
    teacherItemId: "tt",
  });
  const within =
    huge !== null &&
    huge.topic.length <= R.topicLabelMaxChars &&
    huge.words.length === R.words &&
    huge.words.every((w) => w.en.length <= R.wordMaxChars && (w.ko === null || w.ko.length <= R.wordMaxChars)) &&
    huge.shown.length === R.shown &&
    huge.shown.every((x) => x.length <= R.shownMaxChars) &&
    huge.context.length === R.context &&
    huge.context.every((c) => c.text.length <= R.lineMaxChars) &&
    huge.teacherLine.length <= R.lineMaxChars &&
    !/[\uD800-\uDBFF]$/.test(huge.teacherLine);
  add(
    `폭을 넘는 입력은 라우트 zod 폭으로 자름(라벨 ${R.topicLabelMaxChars}·단어 ${R.words}×${R.wordMaxChars}·보인 카드 ${R.shown}×${R.shownMaxChars}·문맥 ${R.context}×${R.lineMaxChars}·말 ${R.lineMaxChars} — 이모지를 반으로 가르지 않음)`,
    within,
    huge ? `라벨 ${huge.topic.length} · 단어 ${huge.words.length} · 보인 ${huge.shown.length} · 문맥 ${huge.context.length} · 말 ${huge.teacherLine.length}` : "null",
  );
  add("주제 라벨이 비면 기본 라벨", buildTalkCardsRequest({ topicLabel: "  ", words: [], shownCards: [], lines, teacherItemId: "t1" })?.topic === "자유대화");
  return results;
}

/**
 * §12-7 컨트롤러 동작(lib/talk-realtime.ts `TalkCallController`) — 합성 이벤트 전송(eval 주입점 `createTransport`)과 **이 함수 안에서만**
 * 갈아 끼운 fetch 대역으로 돈다. 대역은 `/api/english/talk/scene`(501)·`/api/english/talk/cards`(손으로 응답)만 받고 그 밖의 주소는
 * 던진다 — 네트워크에 닿지 않는다(끝나면 오프라인 게이트의 차단 fetch로 되돌린다). 사용자 신고("선생님이 두 명처럼 답한다")를 잠근다:
 * 은우의 한 번 대답에 앱이 보내는 response.create는 **0**(선생님 응답은 서버 자동 응답 하나), 선생님 줄마다 카드 요청 1회, 앞 요청 끊기,
 * 철 지난 도움, 실패면 기본 문구, 마무리 중 요청 없음, 출처 청(greeting·nudge·reply)과 저장 턴의 origin.
 */
async function runTalkControllerChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 컨트롤러");
  const flush = async (n = 4) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };

  const info: TalkConnectSuccess = {
    ok: true,
    sdp: "v=0",
    callId: null,
    topic: {
      kind: "vocab",
      key: null,
      labelKo: "동물 단어",
      labelEn: null,
      vocabBookId: "book_1",
      words: [
        { en: "dog", ko: "강아지", emoji: "🐶" },
        { en: "cat", ko: "고양이", emoji: null },
      ],
    },
    model: "gpt-realtime-2.1",
    voice: "marin",
  };

  class ScriptedTransport implements TalkTransport {
    readonly kind = "fake" as const;
    handlers: TalkTransportHandlers | null = null;
    readonly sent: Record<string, unknown>[] = [];
    closed = false;
    async connect(_args: unknown, handlers: TalkTransportHandlers): Promise<TalkConnectSuccess> {
      this.handlers = handlers;
      return info;
    }
    send(event: object): void {
      if (!this.closed) this.sent.push(event as Record<string, unknown>);
    }
    close(): void {
      this.closed = true;
    }
    emit(...events: (RealtimeServerEvent | Record<string, unknown>)[]): void {
      for (const ev of events) this.handlers?.onEvent(ev);
    }
  }

  interface CardsCall {
    body: TalkCardsRequest;
    signal: AbortSignal;
    respond: (json: unknown, status?: number) => void;
  }
  const calls: CardsCall[] = [];
  const blockedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/api/english/talk/scene") {
      return new Response(JSON.stringify({ ok: false, error: "no_api_key", messageKo: "eval" }), { status: 501 });
    }
    if (url === "/api/english/talk/cards") {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? new AbortController().signal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        calls.push({
          body: JSON.parse(String(init?.body)) as TalkCardsRequest,
          signal,
          respond: (json, status = 200) => resolve(new Response(JSON.stringify(json), { status })),
        });
      });
    }
    throw new Error(`eval 컨트롤러 대역: 막힌 주소 ${url}`);
  }) as typeof fetch;

  const transport = new ScriptedTransport();
  const audio = { muted: false, srcObject: null, pause() {}, play: () => Promise.resolve() } as unknown as HTMLAudioElement;
  const mic: MicStreamHandle = { stream: { getAudioTracks: () => [] } as unknown as MediaStream, release() {} };
  const ctl = new TalkCallController({
    topic: { kind: "vocab", vocabBookId: "book_1" },
    speed: "slow",
    notes: { greeting: "GREETING NOTE", wrapup: "WRAPUP NOTE", nudge: "NUDGE NOTE" },
    micPromise: Promise.resolve(mic),
    audio,
    labelKo: "동물 단어",
    createTransport: async () => transport,
  });
  const appCreates = () => transport.sent.filter((e) => e.type === "response.create").length;
  const hintsNow = () => (ctl as unknown as { hints: TalkHintsState }).hints.hints?.value.answers ?? null;
  const lineOrigin = (id: string) => ctl.getSnapshot().lines.find((l) => l.itemId === id)?.origin ?? null;
  const created = (id: string): RealtimeServerEvent => ({ type: "response.created", event_id: talkEid(), response: { id, object: "realtime.response", status: "in_progress", output: [] } });
  const audioEv = (type: "output_audio_buffer.started" | "output_audio_buffer.stopped", response_id: string) => ({ type, event_id: talkEid(), response_id });
  const cardsOk = (answers: string[], picture: TalkCard | null, words: TalkCard[] = []) => ({ ok: true, answers, words, picture });
  const dog: TalkCard = { emoji: "🐶", en: "dog", ko: "강아지" };
  const cat: TalkCard = { emoji: "🐱", en: "cat", ko: "고양이" };
  /** 선생님 한 차례(응답 id·줄 id·앞 항목·글자) — created → 항목 → 소리 시작 → 전사 → .done → response.done(completed) */
  const teacherTurn = (rid: string, tid: string, prev: string | null, text: string, opts: { created?: boolean } = {}) => {
    if (opts.created !== false) transport.emit(created(rid));
    transport.emit(talkEv.itemAdded(tid, "assistant", prev), audioEv("output_audio_buffer.started", rid), talkEv.outDelta(tid, rid, text), talkEv.outDone(tid, rid, text), talkEv.responseDone(rid, "completed", [tid]));
  };
  const childTurn = (cid: string, prev: string, text: string) => {
    transport.emit(
      talkEv.speechStarted(cid),
      { type: "input_audio_buffer.speech_stopped", event_id: talkEid(), item_id: cid, audio_end_ms: 0 },
      talkEv.committed(cid, prev),
      talkEv.itemAdded(cid, "user", prev),
      talkEv.inCompleted(cid, text),
    );
  };

  try {
    await ctl.start();
    await flush();
    transport.handlers?.onOpen();
    add(
      "연결되면 첫 인사: 숨은 안내(app_greet) + response.create 1회",
      transport.sent.length === 2 &&
        transport.sent[0].type === "conversation.item.create" &&
        (transport.sent[0].item as { id?: string } | undefined)?.id === "app_greet" &&
        appCreates() === 1,
      JSON.stringify(transport.sent.map((e) => e.type)),
    );

    // A. 인사 줄 — 출처 greeting, 줄이 끝나면 카드 요청 1회
    teacherTurn("r1", "t1", null, "Hi! I'm Sunny. Do you like dogs?");
    await flush();
    add("인사 줄의 출처 = greeting(앱이 청한 response.create 뒤 created)", lineOrigin("t1") === "greeting", String(lineOrigin("t1")));
    add(
      "선생님 줄이 끝나면(전사 .done + response.done completed) 카드 요청 1회 — 본문 = 주제 라벨·오늘의 단어·빈 문맥·그 줄 글자",
      calls.length === 1 &&
        JSON.stringify(calls[0].body) ===
          JSON.stringify({
            topic: "동물 단어",
            words: [{ en: "dog", ko: "강아지" }, { en: "cat", ko: "고양이" }],
            shown: [],
            context: [],
            teacherLine: "Hi! I'm Sunny. Do you like dogs?",
          }),
      JSON.stringify(calls.map((c) => c.body.teacherLine)),
    );
    calls[0]?.respond(cardsOk(["I like dogs.", "Yes, I do."], dog, [dog]));
    await flush();
    add(
      "카드 도착: 도움은 상태 기계로(그 줄이 마지막), 그림 카드는 큰 카드 + 오늘의 단어 ✓",
      JSON.stringify(hintsNow()) === '["I like dogs.","Yes, I do."]' && ctl.getSnapshot().picture?.en === "dog" && ctl.getSnapshot().practiced.includes("dog"),
      `hints=${JSON.stringify(hintsNow())} picture=${ctl.getSnapshot().picture?.en}`,
    );
    transport.emit(audioEv("output_audio_buffer.stopped", "r1"));

    // B. 은우의 한 번 대답 → 선생님 응답은 서버 자동 응답 하나. 질문 없는 말로 끝나도 앱은 response.create를 보내지 않는다(§12-6 이어 말하기 없음)
    childTurn("c1", "t1", "Yes, I like dogs.");
    teacherTurn("r2", "t2", "c1", "Great job! Dogs are fun.");
    await flush();
    add(
      "은우의 한 번 대답: 앱이 보낸 response.create 0(선생님 응답은 서버 자동 응답 하나 — 질문 없는 말로 끝나도 이어 말하기 없음)",
      appCreates() === 1 && ctl.getSnapshot().lines.filter((l) => l.speaker === "teacher").length === 2,
      `app create ${appCreates()} · 선생님 줄 ${ctl.getSnapshot().lines.filter((l) => l.speaker === "teacher").length}`,
    );
    add("자동 응답 줄의 출처 = reply(청 없는 created)", lineOrigin("t2") === "reply", String(lineOrigin("t2")));
    add(
      "둘째 카드 요청 — 문맥은 그 줄 앞 줄들, 보인 카드는 이미 띄운 dog",
      calls.length === 2 &&
        JSON.stringify(calls[1].body.context) === JSON.stringify([{ speaker: "teacher", text: "Hi! I'm Sunny. Do you like dogs?" }, { speaker: "child", text: "Yes, I like dogs." }]) &&
        JSON.stringify(calls[1].body.shown) === '["dog"]',
      JSON.stringify(calls[1]?.body),
    );
    transport.emit(audioEv("output_audio_buffer.stopped", "r2"));
    add("선생님 소리가 다시 시작되면 앞 줄의 도움을 버림(카드 요청 결과가 아직 없는 줄)", hintsNow() === null, JSON.stringify(hintsNow()));

    // C. 철 지난 도움 — 응답이 오기 전에 은우가 말을 시작하면 도움은 버리고 그림 카드는 띄운다
    transport.emit(talkEv.speechStarted("c2"));
    calls[1]?.respond(cardsOk(["Yes, it is fun."], cat));
    await flush();
    add(
      "철 지난 도움: 그 줄 뒤에 은우가 이미 말하기 시작 → 도움 버림(셈 staleHints), 그림 카드(오늘의 단어 cat)는 띄움",
      hintsNow() === null && ctl.getSnapshot().picture?.en === "cat" && ctl.getSnapshot().cards.staleHints === 1,
      `hints=${JSON.stringify(hintsNow())} picture=${ctl.getSnapshot().picture?.en} stale=${ctl.getSnapshot().cards.staleHints}`,
    );

    // D. 전사 .done이 response.done보다 늦게 와도 그때 요청한다(순서 무관) · 새 줄의 요청이 앞 요청을 끊는다
    transport.emit(
      { type: "input_audio_buffer.speech_stopped", event_id: talkEid(), item_id: "c2", audio_end_ms: 0 },
      talkEv.committed("c2", "t2"),
      talkEv.itemAdded("c2", "user", "t2"),
      talkEv.inCompleted("c2", "Cats!"),
      created("r3"),
      talkEv.itemAdded("t3", "assistant", "c2"),
      audioEv("output_audio_buffer.started", "r3"),
      talkEv.outDelta("t3", "r3", "Cats are cute. What color is your cat?"),
      talkEv.responseDone("r3", "completed", ["t3"]),
    );
    await flush();
    const beforeDone = calls.length;
    transport.emit(talkEv.outDone("t3", "r3", "Cats are cute. What color is your cat?"));
    await flush();
    add(
      "response.done이 먼저 오고 전사 .done이 늦게 와도 .done에서 한 번 요청",
      beforeDone === 2 && calls.length === 3 && calls[2].body.teacherLine === "Cats are cute. What color is your cat?",
      `done 전 ${beforeDone} · 뒤 ${calls.length}`,
    );
    transport.emit(audioEv("output_audio_buffer.stopped", "r3"));
    ctl.helpTapped();
    await flush();
    const tapView = ctl.getSnapshot().hints;
    add(
      "카드가 아직 없을 때 🙋 → 기본 문구 카드 + 도움 요청(response.create — 출처 nudge 청)",
      tapView.visible && tapView.hints?.source === "fallback" && appCreates() === 2,
      `source=${tapView.hints?.source} create=${appCreates()}`,
    );
    teacherTurn("r4", "t4", "t3", "You can say: It is white. Can you say it with me?");
    await flush();
    add("도움 요청 응답 줄의 출처 = nudge", lineOrigin("t4") === "nudge", String(lineOrigin("t4")));
    add(
      "새 선생님 줄의 요청이 앞 요청을 끊음(최신 줄만 — 셈 superseded)",
      calls.length === 4 && calls[2].signal.aborted && !calls[3].signal.aborted && ctl.getSnapshot().cards.superseded === 1,
      `calls ${calls.length} · 앞 끊김 ${calls[2]?.signal.aborted} · superseded ${ctl.getSnapshot().cards.superseded}`,
    );
    // E. 실패(500) → 아무것도 하지 않는다(도움 없음 → 기본 문구, 그림 그대로)
    calls[3]?.respond({ ok: false, error: "cards_failed", messageKo: "eval" }, 500);
    await flush();
    add(
      "카드 실패(500) → 도움 없음(화면은 기본 문구)·그림 카드 그대로·셈 failed",
      hintsNow() === null && ctl.getSnapshot().picture?.en === "cat" && ctl.getSnapshot().cards.failed === 1,
      `failed=${ctl.getSnapshot().cards.failed}`,
    );
    transport.emit(audioEv("output_audio_buffer.stopped", "r4"));

    // F. 끊긴 응답(cancelled)은 카드를 청하지 않는다
    transport.emit(created("r5"), talkEv.itemAdded("t5", "assistant", "t4"), talkEv.outDelta("t5", "r5", "Oh"), talkEv.responseDone("r5", "cancelled", ["t5"], "turn_detected"));
    await flush();
    add("끊긴 선생님 응답(cancelled)은 카드를 청하지 않음", calls.length === 4, String(calls.length));

    // G. 마무리 중에는 청하지 않는다(진행 중이던 요청도 끊는다)
    teacherTurn("r6", "t6", "t5", "Do you like birds?");
    await flush();
    const inflightBeforeWrap = calls[4];
    // 대화 중에 completed로 끝났지만 전사 .done은 아직인 줄 — .done이 마무리 뒤에 와도 청하지 않아야 한다
    transport.emit(created("r6b"), talkEv.itemAdded("t6b", "assistant", "t6"), talkEv.outDelta("t6b", "r6b", "Birds can fly."), talkEv.responseDone("r6b", "completed", ["t6b"]));
    await flush();
    (ctl as unknown as { beginWrapup(now: number): void }).beginWrapup(Date.now());
    transport.emit(talkEv.outDone("t6b", "r6b", "Birds can fly. Can you fly?"));
    await flush();
    teacherTurn("r7", "t7", "t6b", "You did so well today! Goodbye!", { created: true });
    await flush();
    // 마무리 중 전사 .done이 response.done보다 늦게 와도 청하지 않는다(늦은 .done 경로도 대화 중일 때만)
    transport.emit(
      created("r8"),
      talkEv.itemAdded("t8", "assistant", "t7"),
      talkEv.outDelta("t8", "r8", "See you next time!"),
      talkEv.responseDone("r8", "completed", ["t8"]),
      talkEv.outDone("t8", "r8", "See you next time!"),
    );
    await flush();
    add(
      "마무리가 시작되면 진행 중 카드 요청을 끊고, 마무리 중 선생님 줄은 청하지 않음(대화 중 끝난 응답의 .done이 마무리 뒤에 와도)",
      calls.length === 5 && inflightBeforeWrap !== undefined && inflightBeforeWrap.signal.aborted,
      `calls ${calls.length} · 끊김 ${inflightBeforeWrap?.signal.aborted}`,
    );

    // H. 저장 턴의 출처 — 선생님 = 줄 출처, 은우 = null
    const payload = ctl.getSavePayload();
    add(
      "저장 턴의 origin: 인사 greeting · 자동 응답 reply · 도움 요청 nudge · 은우 null",
      payload !== null &&
        JSON.stringify(payload.turns.map((t) => `${t.speaker[0]}:${t.origin}`)) ===
          JSON.stringify(["t:greeting", "c:null", "t:reply", "c:null", "t:reply", "t:nudge", "t:reply", "t:reply", "t:reply", "t:reply", "t:reply"]),
      JSON.stringify(payload?.turns.map((t) => `${t.speaker[0]}:${t.origin}`)),
    );
    add("앱이 보낸 response.create는 인사·도움 요청뿐(마무리 안내는 tick이 보낸다 — 이 열에선 아직)", appCreates() === 2, String(appCreates()));
  } finally {
    ctl.end("user");
    await flush();
    globalThis.fetch = blockedFetch;
  }
  add(
    "끝내면 진행 중 카드 요청이 남지 않음(요청 수는 마무리 전 5회 그대로)",
    (ctl as unknown as { cardsInflight: unknown }).cardsInflight === null && calls.length === 5,
    String(calls.length),
  );

  // 대화 중에 끝내면(끝내기·숨김·뒤로가기) 진행 중인 카드 요청을 끊는다 — 상류 호출 J도 req.signal로 멈춘다(과금 중지)
  const transport2 = new ScriptedTransport();
  const ctl2 = new TalkCallController({
    topic: { kind: "preset", key: "animals" },
    speed: "slow",
    notes: { greeting: "GREETING NOTE", wrapup: "WRAPUP NOTE", nudge: "NUDGE NOTE" },
    micPromise: Promise.resolve(mic),
    audio,
    labelKo: "동물",
    createTransport: async () => transport2,
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/api/english/talk/scene") return new Response(JSON.stringify({ ok: false, error: "no_api_key", messageKo: "eval" }), { status: 501 });
    if (url === "/api/english/talk/cards") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? new AbortController().signal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        calls.push({ body: JSON.parse(String(init?.body)) as TalkCardsRequest, signal, respond: () => {} });
      });
    }
    throw new Error(`eval 컨트롤러 대역: 막힌 주소 ${url}`);
  }) as typeof fetch;
  try {
    await ctl2.start();
    await flush();
    transport2.handlers?.onOpen();
    transport2.emit(created("s1"), talkEv.itemAdded("u1", "assistant", null), talkEv.outDone("u1", "s1", "Hello! Do you like cats?"), talkEv.responseDone("s1", "completed", ["u1"]));
    await flush();
    const pending = calls[5];
    ctl2.end("hidden");
    await flush();
    add(
      "대화 중에 끝내면(숨김·뒤로가기) 진행 중 카드 요청을 끊음",
      calls.length === 6 && pending !== undefined && pending.signal.aborted && (ctl2 as unknown as { cardsInflight: unknown }).cardsInflight === null,
      `calls ${calls.length} · 끊김 ${pending?.signal.aborted}`,
    );
  } finally {
    ctl2.end("user");
    await flush();
    globalThis.fetch = blockedFetch;
  }

  // ── 시계를 손으로 돌리는 컨트롤러 — 은우 차례가 열려 있을 때의 response.create(QA talk-cards-j full_1 P2-A)·선생님 줄마다 한 번
  //    (P3-A)·출처 청 거두기(P3-B). Date.now를 이 블록 안에서만 가짜 시계로 바꾸고, 컨트롤러의 250ms tick 타이머는 끄고 onTick을
  //    손으로 부른다(TALK_TICK_MS 간격 — 같은 이벤트 열이면 늘 같은 결과). 카드 대역은 500(도움·그림 없음)이고 요청 본문만 센다.
  const realDateNow = Date.now;
  let clock = realDateNow();
  const timedCards: TalkCardsRequest[] = [];
  interface TimedPriv {
    tickTimer: ReturnType<typeof setInterval> | null;
    capAtMs: number | null;
    pendingNudge: boolean;
    hints: TalkHintsState;
    onTick(): void;
    requestNudge(): void;
  }
  const makeTimed = async () => {
    const tr = new ScriptedTransport();
    const c = new TalkCallController({
      topic: { kind: "preset", key: "animals" },
      speed: "slow",
      notes: { greeting: "GREETING NOTE", wrapup: "WRAPUP NOTE", nudge: "NUDGE NOTE" },
      micPromise: Promise.resolve(mic),
      audio,
      labelKo: "동물",
      createTransport: async () => tr,
    });
    await c.start();
    await flush();
    tr.handlers?.onOpen();
    const priv = c as unknown as TimedPriv;
    if (priv.tickTimer !== null) clearInterval(priv.tickTimer);
    /** 시계를 ms만큼 흘린다 — TALK_TICK_MS마다 tick(마지막 자투리도 tick) */
    const advance = (ms: number) => {
      const end = clock + ms;
      while (clock + TALK_TICK_MS <= end) {
        clock += TALK_TICK_MS;
        priv.onTick();
      }
      if (clock < end) {
        clock = end;
        priv.onTick();
      }
    };
    const creates = () => tr.sent.filter((e) => e.type === "response.create").length;
    const wrapNotes = () => tr.sent.filter((e) => e.type === "conversation.item.create" && (e.item as { id?: string } | undefined)?.id === "app_wrapup").length;
    const origin = (id: string) => c.getSnapshot().lines.find((l) => l.itemId === id)?.origin ?? null;
    /** 그 줄 뒤의 선생님 줄 출처들 */
    const teacherAfter = (itemId: string) => {
      const ls = c.getSnapshot().lines;
      return ls.slice(ls.findIndex((l) => l.itemId === itemId) + 1).filter((l) => l.speaker === "teacher").map((l) => l.origin);
    };
    /** 선생님 한 차례를 소리 멈춤까지 */
    const teacher = (rid: string, tid: string, prev: string | null, text: string) =>
      tr.emit(
        created(rid),
        talkEv.itemAdded(tid, "assistant", prev),
        audioEv("output_audio_buffer.started", rid),
        talkEv.outDelta(tid, rid, text),
        talkEv.outDone(tid, rid, text),
        talkEv.responseDone(rid, "completed", [tid]),
        audioEv("output_audio_buffer.stopped", rid),
      );
    /** 은우 말이 끝남(VAD 커밋 + 전사) — 서버 자동 응답(response.created)은 따로 흘린다 */
    const childEnds = (cid: string, prev: string, text: string) =>
      tr.emit(
        { type: "input_audio_buffer.speech_stopped", event_id: talkEid(), item_id: cid, audio_end_ms: 0 },
        talkEv.committed(cid, prev),
        talkEv.itemAdded(cid, "user", prev),
        talkEv.inCompleted(cid, text),
      );
    return { c, tr, priv, advance, creates, wrapNotes, origin, teacherAfter, teacher, childEnds };
  };
  const timed: TalkCallController[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/api/english/talk/scene") return new Response(JSON.stringify({ ok: false, error: "no_api_key", messageKo: "eval" }), { status: 501 });
    if (url === "/api/english/talk/cards") {
      timedCards.push(JSON.parse(String(init?.body)) as TalkCardsRequest);
      return new Response(JSON.stringify({ ok: false, error: "cards_failed", messageKo: "eval" }), { status: 500 });
    }
    throw new Error(`eval 컨트롤러 대역: 막힌 주소 ${url}`);
  }) as typeof fetch;
  Date.now = () => clock;
  try {
    const A = await makeTimed();
    timed.push(A.c);

    // P3-A — 같은 줄의 전사 .done·response.done이 다시 와도(재전송·중복 수신) 카드 요청은 줄마다 한 번(cardsRequested)
    const t1Text = "Hi! I'm Sunny. Do you like dogs?";
    const t1Done = talkEv.outDone("q_t1", "q_r1", t1Text);
    const r1Done = talkEv.responseDone("q_r1", "completed", ["q_t1"]);
    A.tr.emit(created("q_r1"), talkEv.itemAdded("q_t1", "assistant", null), audioEv("output_audio_buffer.started", "q_r1"), talkEv.outDelta("q_t1", "q_r1", t1Text), t1Done, r1Done);
    await flush();
    const cardsAtLineEnd = timedCards.length;
    A.tr.emit(t1Done, r1Done); // 같은 이벤트 그대로 한 번 더
    A.tr.emit(talkEv.outDone("q_t1", "q_r1", t1Text), talkEv.responseDone("q_r1", "completed", ["q_t1"])); // 새 event_id로 한 번 더
    await flush();
    add(
      "같은 선생님 줄의 전사 .done·response.done이 다시 와도 카드 요청 수 그대로(줄마다 한 번)",
      cardsAtLineEnd === 1 && timedCards.length === 1,
      `줄 끝 ${cardsAtLineEnd} · 중복 뒤 ${timedCards.length}`,
    );
    A.tr.emit(audioEv("output_audio_buffer.stopped", "q_r1"));

    // P2-A ① — 은우가 말하는 중(speech_started 뒤) 🙋: 카드는 뜨고 앱 response.create 0(보류도 없음). 은우 말이 끝나면 선생님 응답은 자동 응답 하나
    A.advance(1_000);
    A.tr.emit(talkEv.speechStarted("q_c1"));
    A.c.helpTapped();
    await flush();
    const tapTalking = { creates: A.creates(), card: A.c.getSnapshot().hints.visible, held: A.priv.pendingNudge };
    A.advance(2_000); // 아직 말하는 중("Um… I…")
    A.childEnds("q_c1", "q_t1", "Um, I like dogs.");
    A.advance(TALK_TICK_MS); // 말 끝 ~ 자동 응답 사이 tick
    A.teacher("q_r2", "q_t2", "q_c1", "Me too! What is your dog's name?");
    await flush();
    add(
      "은우가 말하는 중(speech_started 뒤) 🙋 → 카드는 뜨고 앱 response.create 0·보류 없음 → 은우 말 뒤 선생님 줄은 자동 응답 하나(reply)",
      tapTalking.creates === 1 && tapTalking.card && !tapTalking.held && A.creates() === 1 && JSON.stringify(A.teacherAfter("q_c1")) === '["reply"]',
      `🙋 때 create ${tapTalking.creates} · 카드 ${tapTalking.card} · 보류 ${tapTalking.held} · 끝 create ${A.creates()} · 은우 뒤 선생님 ${JSON.stringify(A.teacherAfter("q_c1"))}`,
    );

    // P2-A ② — 선생님 말하는 중 🙋(보류) + 은우 끼어들기, 실서버 순서(response.done cancelled → output_audio_buffer.cleared)
    A.advance(1_000);
    A.tr.emit(created("q_r3"), talkEv.itemAdded("q_t3", "assistant", "q_t2"), audioEv("output_audio_buffer.started", "q_r3"), talkEv.outDelta("q_t3", "q_r3", "Do you"));
    A.c.helpTapped();
    await flush();
    const heldCreates = A.creates();
    A.tr.emit(talkEv.speechStarted("q_c2"), talkEv.responseDone("q_r3", "cancelled", ["q_t3"], "turn_detected"), { type: "output_audio_buffer.cleared", event_id: talkEid(), response_id: "q_r3" });
    await flush();
    const bargeCreates = A.creates();
    A.advance(1_500);
    A.childEnds("q_c2", "q_t3", "Wait, I have a cat.");
    A.teacher("q_r4", "q_t4", "q_c2", "A cat! What color is your cat?");
    await flush();
    add(
      "선생님 말하는 중 🙋(보류) + 은우 끼어들기(실서버 순서 response.done → cleared) → 보류 요청이 은우 말 위로 나가지 않음 · 은우 말 뒤 선생님 줄 하나",
      heldCreates === 1 && bargeCreates === 1 && A.creates() === 1 && JSON.stringify(A.teacherAfter("q_c2")) === '["reply"]',
      `보류 ${heldCreates} · 끼어든 뒤 ${bargeCreates} · 끝 ${A.creates()} · 은우 뒤 선생님 ${JSON.stringify(A.teacherAfter("q_c2"))}`,
    );

    // P2-A ③ 둘째 겹 단독 — 상태 기계가 요청 신호를 내도(가정) 은우 차례가 열려 있으면(말하는 중·말이 막 끝나 자동 응답을 기다리는 틈) 보내지도 보류하지도 않는다
    A.advance(1_000);
    A.tr.emit(talkEv.speechStarted("q_c3"));
    A.priv.pendingNudge = true; // 앞서 보류된 요청이 남아 있었다고 가정
    A.priv.requestNudge();
    const directTalking = { creates: A.creates(), held: A.priv.pendingNudge };
    A.advance(1_000);
    A.childEnds("q_c3", "q_t4", "It is black.");
    A.advance(TALK_TICK_MS);
    A.priv.requestNudge();
    const directGap = { creates: A.creates(), held: A.priv.pendingNudge };
    A.teacher("q_r5", "q_t5", "q_c3", "Black cats are cool! Does your cat like fish?");
    await flush();
    add(
      "둘째 겹(컨트롤러 단독): 요청 신호가 와도 은우가 말하는 중·말이 막 끝나 자동 응답을 기다리는 틈이면 response.create 0 · 보류도 비움",
      directTalking.creates === 1 && !directTalking.held && directGap.creates === 1 && !directGap.held && A.creates() === 1 && JSON.stringify(A.teacherAfter("q_c3")) === '["reply"]',
      JSON.stringify({ directTalking, directGap, end: A.creates(), after: A.teacherAfter("q_c3") }),
    );

    // 틈은 짧게 묶인다 — 말이 끝나고 자동 응답이 끝내 안 오면(TALK_AUTO_REPLY_WAIT_MS 뒤) 🙋 도움 요청이 나간다
    A.advance(1_000);
    A.tr.emit(talkEv.speechStarted("q_c4"));
    A.advance(500);
    A.childEnds("q_c4", "q_t5", "Yes.");
    A.advance(TALK_AUTO_REPLY_WAIT_MS);
    A.c.helpTapped();
    await flush();
    const nudgeAfterGap = A.creates();
    // P3-B — 그 도움 요청에 response.created가 5초 안에 안 오면(거부·유실) 출처 청을 거둔다 → 다음 자동 응답 줄은 reply
    A.advance(5_000);
    A.tr.emit(talkEv.speechStarted("q_c5"));
    A.advance(500);
    A.childEnds("q_c5", "q_c4", "I like fish.");
    A.teacher("q_r6", "q_t6", "q_c5", "Fish are yummy! Do you like apples?");
    await flush();
    add(
      `말이 끝나고 자동 응답이 끝내 안 오면 틈(${TALK_AUTO_REPLY_WAIT_MS}ms) 뒤 🙋 도움 요청은 나감(틈은 짧게 묶인다)`,
      nudgeAfterGap === 2,
      `create ${nudgeAfterGap}`,
    );
    add(
      "도움 요청 response.create에 response.created가 5초 안에 안 오면 출처 청을 거둔다 → 그 뒤 자동 응답 줄의 출처 = reply(nudge로 태깅 안 됨)",
      A.creates() === 2 && A.origin("q_t6") === "reply",
      `create ${A.creates()} · 출처 ${A.origin("q_t6")}`,
    );

    // P2-A ④ 마무리 — 5분 상한에 은우가 말하는 중이면 기다린다(선생님과 같은 8초 상한): speech_stopped 전 0 · 말 끝~자동 응답 틈 0 ·
    // 자동 응답 소리 중 0 → 자동 응답(reply)이 끝난 뒤 마무리 1회
    A.advance(1_000);
    A.tr.emit(talkEv.speechStarted("q_c6"));
    A.priv.capAtMs = clock + 500;
    A.advance(1_000); // 상한에 닿음 — 은우는 말하는 중
    const atCap = { phase: A.c.getSnapshot().phase, creates: A.creates(), notes: A.wrapNotes() };
    A.advance(2_500); // 상한 + 3초 — 아직 말하는 중
    const talking = { creates: A.creates(), notes: A.wrapNotes() };
    A.childEnds("q_c6", "q_t6", "My dog likes apples too.");
    A.advance(1_000); // 말 끝 ~ 자동 응답 틈(TALK_AUTO_REPLY_WAIT_MS 안)
    const inGap = A.creates();
    A.tr.emit(created("q_r7"), talkEv.itemAdded("q_t7", "assistant", "q_c6"), audioEv("output_audio_buffer.started", "q_r7"), talkEv.outDelta("q_t7", "q_r7", "Wow, that is fun!"), talkEv.outDone("q_t7", "q_r7", "Wow, that is fun!"), talkEv.responseDone("q_r7", "completed", ["q_t7"]));
    A.advance(1_000); // 자동 응답 소리가 나는 중
    const replySpeaking = A.creates();
    A.tr.emit(audioEv("output_audio_buffer.stopped", "q_r7"));
    A.advance(TALK_TICK_MS);
    const sent = A.creates();
    const lastTwo = A.tr.sent.slice(-2).map((e) => (e.type === "conversation.item.create" ? (e.item as { id?: string } | undefined)?.id : e.type));
    A.tr.emit(created("q_r8"), talkEv.itemAdded("q_t8", "assistant", "q_t7"), talkEv.outDelta("q_t8", "q_r8", "You did so well today!"));
    await flush();
    add(
      "5분 상한에 은우가 말하는 중이면 speech_stopped 전에는 마무리 response.create 0(마무리 단계로는 들어감)",
      atCap.phase === "wrapping" && atCap.creates === 2 && atCap.notes === 0 && talking.creates === 2 && talking.notes === 0,
      JSON.stringify({ atCap, talking }),
    );
    add(
      "은우 말이 끝나고 자동 응답이 오기 전 틈·자동 응답 소리 중에도 마무리 0 → 자동 응답(reply)이 끝난 뒤 마무리 1회(숨은 안내 + create, 출처 wrapup)",
      inGap === 2 && replySpeaking === 2 && sent === 3 && JSON.stringify(lastTwo) === '["app_wrapup","response.create"]' && A.origin("q_t7") === "reply" && A.origin("q_t8") === "wrapup",
      JSON.stringify({ inGap, replySpeaking, sent, lastTwo, reply: A.origin("q_t7"), wrap: A.origin("q_t8") }),
    );

    // 8초 상한 — 은우가 계속 말하면(잡음 등) 상한에서 마무리를 보낸다(대화가 끝나지 않는 일은 없다)
    const B = await makeTimed();
    timed.push(B.c);
    B.teacher("w_r1", "w_t1", null, "Hi! I'm Sunny. Do you like dogs?");
    await flush();
    B.advance(1_000);
    B.tr.emit(talkEv.speechStarted("w_c1"));
    B.priv.capAtMs = clock + TALK_TICK_MS;
    B.advance(TALK_TICK_MS); // 상한 — 마무리 단계 시작
    B.advance(TALK_WRAPUP_WAIT_MS - TALK_TICK_MS); // 상한 + 7.75초 — 아직 말하는 중
    const before8s = B.creates();
    B.advance(TALK_TICK_MS); // 상한 + 8초
    add(
      `은우가 ${TALK_WRAPUP_WAIT_MS / 1000}초 넘게 말하면(잡음 등) 상한에서 마무리를 보낸다 — 대화가 끝나지 않는 일은 없다`,
      before8s === 1 && B.creates() === 2 && B.wrapNotes() === 1,
      `7.75초 ${before8s} · 8초 ${B.creates()}`,
    );

    // 마무리 쪽 틈도 짧게 묶인다 — 상한 뒤 은우 말이 끝났는데 자동 응답이 끝내 안 오면 틈 뒤에 마무리를 보낸다
    const C = await makeTimed();
    timed.push(C.c);
    C.teacher("v_r1", "v_t1", null, "Hi! I'm Sunny. Do you like cats?");
    await flush();
    C.advance(1_000);
    C.tr.emit(talkEv.speechStarted("v_c1"));
    C.priv.capAtMs = clock + TALK_TICK_MS;
    C.advance(500); // 상한 — 은우 말하는 중
    C.childEnds("v_c1", "v_t1", "Yes.");
    C.advance(TALK_AUTO_REPLY_WAIT_MS - TALK_TICK_MS);
    const inGrace = C.creates();
    C.advance(TALK_TICK_MS);
    add(
      `마무리: 은우 말이 끝났는데 자동 응답이 끝내 안 오면 틈(${TALK_AUTO_REPLY_WAIT_MS}ms) 뒤 마무리를 보낸다`,
      inGrace === 1 && C.creates() === 2 && C.wrapNotes() === 1,
      `틈 안 ${inGrace} · 틈 뒤 ${C.creates()}`,
    );

    // ── QA talk-cards-j full_2 P3-A — 셈은 **보낸** 요청이다. 앱이 보내지 않고 버린 도움 요청(은우 차례·보류 버림)은 도움 상태 기계의
    //    셈(차례 하나에 한 번·연속 2번)에서 되돌린다(`nudge_withheld`). 되돌리지 않으면 버린 🙋가 상한을 먹어 연속 2번이 1번이 되고,
    //    자동 응답이 끝내 안 오는 차례에는 12초 요청이 영영 나가지 않는다.
    /** 조용한 은우 — 12초 도움 요청이 나가면 그 요청의 응답(선생님 예시 답)을 흘린다. `rounds`번 되풀이하고 앱 create 수를 차례로 돌려준다 */
    const silentRounds = async (T: Awaited<ReturnType<typeof makeTimed>>, prefix: string, prev: string, rounds: number) => {
      const seen: number[] = [];
      let last = prev;
      for (let i = 0; i < rounds; i++) {
        T.advance(TALK_HINT_NUDGE_AFTER_MS + 1_000);
        seen.push(T.creates());
        const tid = `${prefix}_n${i}`;
        T.teacher(`${prefix}_nr${i}`, tid, last, "You can say: I like it. Can you say it with me?");
        await flush();
        last = tid;
      }
      return seen;
    };
    // N3 모양 — 은우가 "Um… I…" 하다 막혀 말하는 도중 🙋(카드만 — 보내지 않음) → 말을 마친 뒤 조용함
    const D = await makeTimed();
    timed.push(D.c);
    D.teacher("d_r1", "d_t1", null, "Hi! I'm Sunny. Do you like dogs?");
    await flush();
    D.advance(1_000);
    D.tr.emit(talkEv.speechStarted("d_c1"));
    D.advance(1_000);
    D.c.helpTapped();
    await flush();
    const dTap = { creates: D.creates(), card: D.c.getSnapshot().hints.visible, held: D.priv.pendingNudge };
    D.advance(1_500);
    D.childEnds("d_c1", "d_t1", "Um, I like…");
    D.advance(TALK_TICK_MS);
    D.teacher("d_r2", "d_t2", "d_c1", "Me too! What is your dog's name?");
    await flush();
    const dRounds = await silentRounds(D, "d", "d_t2", 3);
    add(
      "은우가 말하는 중 🙋(카드만 — 보내지 않음) 뒤 조용한 은우: 도움 요청 연속 2번(보낸 요청만 센다) → 3번째 차례는 막힘",
      dTap.creates === 1 && dTap.card && !dTap.held && JSON.stringify(dRounds) === "[2,3,3]" && D.origin("d_n0") === "nudge" && D.origin("d_n1") === "nudge",
      `🙋 때 create ${dTap.creates} · 카드 ${dTap.card} · 보류 ${dTap.held} · 차례별 create ${JSON.stringify(dRounds)}`,
    );

    // N4b 모양 — 자동 응답이 끝내 안 오는 드문 차례(잡음 커밋) + 말 끝 틈의 🙋(버림) → 은우 말이 멈춘 지 12초에 도움 요청
    const E = await makeTimed();
    timed.push(E.c);
    E.teacher("e_r1", "e_t1", null, "Hi! I'm Sunny. Do you like cats?");
    await flush();
    E.advance(1_000);
    E.tr.emit(talkEv.speechStarted("e_c1"));
    E.advance(800);
    E.childEnds("e_c1", "e_t1", "");
    E.advance(200); // 말 끝 ~ 자동 응답 틈(TALK_AUTO_REPLY_WAIT_MS 안)
    E.c.helpTapped();
    await flush();
    const eGap = { creates: E.creates(), card: E.c.getSnapshot().hints.visible, held: E.priv.pendingNudge };
    E.advance(TALK_HINT_NUDGE_AFTER_MS - 200 - 1); // 은우 말이 멈춘 지 12초 − 1ms
    const eBefore = E.creates();
    E.advance(1);
    add(
      "자동 응답이 끝내 안 오는 차례: 말 끝 틈의 🙋는 버리고(create 0, 카드는 뜸) 셈도 되돌림 → 은우 말이 멈춘 지 12초에 도움 요청 1번",
      eGap.creates === 1 && eGap.card && !eGap.held && eBefore === 1 && E.creates() === 2,
      `틈 🙋 create ${eGap.creates} · 12초 전 ${eBefore} · 12초 ${E.creates()}`,
    );

    // N5 모양 — 자동 응답 생성 중(created 뒤·소리 전) 🙋 → 보류 → 그 응답에 소리가 있어 버림 → 버린 요청은 셈에서도 빠진다
    const F = await makeTimed();
    timed.push(F.c);
    F.teacher("f_r1", "f_t1", null, "Hi! I'm Sunny. Do you like apples?");
    await flush();
    F.advance(1_000);
    F.tr.emit(talkEv.speechStarted("f_c1"));
    F.advance(700);
    F.childEnds("f_c1", "f_t1", "I like apples.");
    F.advance(200);
    F.tr.emit(created("f_r2"));
    F.c.helpTapped();
    await flush();
    const fHeld = { creates: F.creates(), held: F.priv.pendingNudge };
    const fText = "Apples are yummy! What color is your apple?";
    F.tr.emit(
      talkEv.itemAdded("f_t2", "assistant", "f_c1"),
      audioEv("output_audio_buffer.started", "f_r2"),
      talkEv.outDelta("f_t2", "f_r2", fText),
      talkEv.outDone("f_t2", "f_r2", fText),
      talkEv.responseDone("f_r2", "completed", ["f_t2"]),
      audioEv("output_audio_buffer.stopped", "f_r2"),
    );
    await flush();
    const fDropped = { creates: F.creates(), held: F.priv.pendingNudge };
    const fRounds = await silentRounds(F, "f", "f_t2", 3);
    add(
      "자동 응답 생성 중(소리 전) 🙋 → 보류 → 그 응답에 소리가 있어 버림(create 0) — 버린 요청은 셈에서 빠져 조용한 은우에게 도움 요청 연속 2번",
      fHeld.creates === 1 && fHeld.held && fDropped.creates === 1 && !fDropped.held && JSON.stringify(fRounds) === "[2,3,3]",
      `보류 ${JSON.stringify(fHeld)} · 버림 ${JSON.stringify(fDropped)} · 차례별 create ${JSON.stringify(fRounds)}`,
    );

    // 보류 합치기(드문 순서 — 소리가 response.done보다 먼저 멈춤): 보류가 남은 채 새 차례의 🙋 보류가 풀려 신호가 또 오면 요청은 하나로
    // 합쳐진다(많아야 하나 나감) — 합쳐진 신호의 셈은 그 자리에서 빼고, 그 보류가 버려지면 남은 셈도 뺀다(셈 = 보낸 요청 + 보류 1)
    const I = await makeTimed();
    timed.push(I.c);
    I.teacher("i_r1", "i_t1", null, "Hi! I'm Sunny. Do you like frogs?");
    await flush();
    I.advance(1_000);
    I.tr.emit(talkEv.speechStarted("i_c1"));
    I.advance(700);
    I.childEnds("i_c1", "i_t1", "Frogs jump.");
    I.advance(200);
    I.tr.emit(created("i_r2"));
    I.c.helpTapped(); // 응답 진행 중 — 컨트롤러 보류(셈 1)
    const iText = "Frogs jump so high! Can you jump?";
    I.tr.emit(talkEv.itemAdded("i_t2", "assistant", "i_c1"), audioEv("output_audio_buffer.started", "i_r2"), talkEv.outDelta("i_t2", "i_r2", iText), talkEv.outDone("i_t2", "i_r2", iText));
    I.c.helpTapped(); // 새 차례 — 선생님 말하는 중이라 상태 기계 보류
    I.tr.emit(audioEv("output_audio_buffer.stopped", "i_r2")); // 소리가 먼저 멈춤 → 상태 기계 요청 신호(셈 2) → 응답 진행 중이라 이미 있는 보류와 합침
    await flush();
    const iMerged = { creates: I.creates(), held: I.priv.pendingNudge, streak: I.priv.hints.nudgeStreak };
    I.tr.emit(talkEv.responseDone("i_r2", "completed", ["i_t2"])); // 소리 있는 응답 → 보류 버림
    await flush();
    const iRounds = await silentRounds(I, "i", "i_t2", 3);
    add(
      "보류 합치기(소리가 response.done보다 먼저 멈춘 드문 순서): 합쳐진 신호의 셈은 빼고(셈 = 보류 1) 보류를 버리면 남은 셈도 뺌 → 조용한 은우에게 도움 요청 연속 2번",
      iMerged.creates === 1 && iMerged.held && iMerged.streak === 1 && JSON.stringify(iRounds) === "[2,3,3]",
      `합친 뒤 ${JSON.stringify(iMerged)} · 차례별 create ${JSON.stringify(iRounds)}`,
    );

    // ── QA full_2 P3-B ① — 마무리의 진행 중 응답 가드(`!this.responseActive`). 틈을 닫는 것은 자동 응답의 response.created이고, 그 뒤 첫
    //    소리(output_audio_buffer.started)까지는 teacherSpeaking이 false라 이 창을 막는 것은 이 가드 하나다(지우면 작별 인사가 진행 중
    //    응답에 부딪혀 거부되고, 작별 없이 25초 상한으로 끝난다).
    const G = await makeTimed();
    timed.push(G.c);
    G.teacher("g_r1", "g_t1", null, "Hi! I'm Sunny. Do you like birds?");
    await flush();
    G.advance(1_000);
    G.tr.emit(talkEv.speechStarted("g_c1"));
    G.priv.capAtMs = clock + TALK_TICK_MS;
    G.advance(500); // 상한 — 은우 말하는 중(마무리 단계로 들어감)
    G.childEnds("g_c1", "g_t1", "Birds can sing.");
    G.advance(300); // 말 끝 ~ 자동 응답 틈
    G.tr.emit(created("g_r2")); // 자동 응답 시작 — 틈이 닫힘, 아직 소리 전
    G.advance(2_000); // created ~ 첫 소리 창에서 tick 여러 번
    const gWindow = { creates: G.creates(), notes: G.wrapNotes(), phase: G.c.getSnapshot().phase };
    const gText = "Birds sing so well!";
    G.tr.emit(
      talkEv.itemAdded("g_t2", "assistant", "g_c1"),
      audioEv("output_audio_buffer.started", "g_r2"),
      talkEv.outDelta("g_t2", "g_r2", gText),
      talkEv.outDone("g_t2", "g_r2", gText),
      talkEv.responseDone("g_r2", "completed", ["g_t2"]),
    );
    G.advance(1_000); // 자동 응답 소리 중(응답은 끝남)
    const gSpeaking = G.creates();
    G.tr.emit(audioEv("output_audio_buffer.stopped", "g_r2"));
    G.advance(TALK_TICK_MS);
    add(
      "마무리: 자동 응답이 시작돼(response.created) 첫 소리가 나기 전 창에도 작별 인사 0(진행 중 응답 가드) → 그 응답의 소리가 멈춘 뒤 1회",
      gWindow.phase === "wrapping" && gWindow.creates === 1 && gWindow.notes === 0 && gSpeaking === 1 && G.creates() === 2 && G.wrapNotes() === 1 && G.origin("g_t2") === "reply",
      JSON.stringify({ gWindow, gSpeaking, end: G.creates(), notes: G.wrapNotes(), reply: G.origin("g_t2") }),
    );

    // ── QA full_2 P3-B ② — 보류 버림 두 겹: 은우 speech_started의 보류 버림 + onResponseDone의 은우 차례 판정. 서로를 가려 하나만 지우면
    //    동등하지만 둘 다 지우면 보류 요청이 은우 말 위로 나간다. 실서버는 소리 전에 끊긴 응답을 출력 없이(output: []) 끝낸다(hadAudio false).
    const H = await makeTimed();
    timed.push(H.c);
    H.teacher("h_r1", "h_t1", null, "Hi! I'm Sunny. Do you like fish?");
    await flush();
    H.advance(1_000);
    H.tr.emit(talkEv.speechStarted("h_c1"));
    H.advance(700);
    H.childEnds("h_c1", "h_t1", "I like fish.");
    H.advance(200);
    H.tr.emit(created("h_r2")); // 자동 응답 생성 중(소리 전)
    H.c.helpTapped(); // 보류
    await flush();
    const hHeld = H.priv.pendingNudge;
    H.tr.emit(talkEv.speechStarted("h_c2"), talkEv.responseDone("h_r2", "cancelled", [], "turn_detected")); // 소리 전 끼어들기 → 출력 없는 cancelled
    await flush();
    const hAfter = { creates: H.creates(), held: H.priv.pendingNudge };
    H.advance(1_000);
    H.childEnds("h_c2", "h_c1", "And cats.");
    H.advance(TALK_TICK_MS);
    H.teacher("h_r3", "h_t3", "h_c2", "Fish and cats! Do you have a pet?");
    await flush();
    add(
      "생성 중 🙋(보류) → 소리 전 은우 끼어들기 → 출력 없는 cancelled response.done: 보류 요청이 은우 말 위로 나가지 않음(create 0) · 은우 말 뒤 선생님 줄은 자동 응답 하나",
      hHeld && hAfter.creates === 1 && !hAfter.held && H.creates() === 1 && JSON.stringify(H.teacherAfter("h_c2")) === '["reply"]',
      JSON.stringify({ hHeld, hAfter, end: H.creates(), after: H.teacherAfter("h_c2") }),
    );

    // ── 반이중 마이크 + 기기 판정 끼어들기(2026-10-03 두 번째 수정 — §12-1): 선생님 재생 중 서버로 가는 트랙을 끄고, 레벨 미터(손으로 넣는
    //    음량 열 — 40ms 프레임)가 덩어리 안 합계 700ms를 넘을 때만 cancel·clear를 보내고 트랙을 켠다. ScriptedTransport는 보낸 이벤트를
    //    쌓기만 하고, 서버 반응은 손으로 흘린다(실서버 순서 — 생성이 재생보다 먼저 끝난다).
    const biTrack = { kind: "audio", enabled: true, readyState: "live" } as unknown as MediaStreamTrack;
    const biMic: MicStreamHandle = { stream: { getAudioTracks: () => [biTrack] } as unknown as MediaStream, release() {} };
    let biFrame: ((now: number, db: number) => void) | null = null;
    let biMeterStops = 0;
    let biCtxCloses = 0;
    const biCtx = {
      state: "running",
      close() {
        biCtxCloses += 1;
        (this as { state: string }).state = "closed";
        return Promise.resolve();
      },
    } as unknown as AudioContext;
    const biMeter: TalkLevelMeter = {
      offReason: null,
      start(cb) {
        biFrame = cb;
      },
      stop() {
        biMeterStops += 1;
      },
    };
    const biTr = new ScriptedTransport();
    const biC = new TalkCallController({
      topic: { kind: "preset", key: "animals" },
      speed: "slow",
      notes: { greeting: "GREETING NOTE", wrapup: "WRAPUP NOTE", nudge: "NUDGE NOTE" },
      micPromise: Promise.resolve(biMic),
      audio,
      labelKo: "동물",
      createTransport: async () => biTr,
      levelContext: biCtx,
      createLevelMeter: () => biMeter,
    });
    timed.push(biC);
    await biC.start();
    await flush();
    const biPriv = biC as unknown as TimedPriv;
    /** 음량 db로 ms만큼 — 40ms 프레임마다 미터 콜백, TALK_TICK_MS마다 tick */
    let biTickAcc = 0;
    const biLevel = (ms: number, db: number) => {
      for (let t = 0; t < ms; t += TALK_LEVEL_POLL_MS) {
        clock += TALK_LEVEL_POLL_MS;
        biFrame?.(clock, db);
        biTickAcc += TALK_LEVEL_POLL_MS;
        if (biTickAcc >= TALK_TICK_MS) {
          biTickAcc = 0;
          biPriv.onTick();
        }
      }
    };
    const iSent = (from: number) => biTr.sent.slice(from).map((e) => `${String(e.type)}${typeof e.response_id === "string" ? `:${e.response_id}` : ""}`);
    const iSpeech = (id: string): RealtimeServerEvent => ({ type: "input_audio_buffer.speech_started", event_id: talkEid(), item_id: id, audio_start_ms: 0 });
    const iStop = (id: string): RealtimeServerEvent => ({ type: "input_audio_buffer.speech_stopped", event_id: talkEid(), item_id: id, audio_end_ms: 0 });
    const iCleared = (rid: string) => ({ type: "output_audio_buffer.cleared", event_id: talkEid(), response_id: rid }) as RealtimeServerEvent;
    const iLine = (id: string) => biC.getSnapshot().lines.find((l) => l.itemId === id) ?? null;
    // 연결 중에도 소음 바닥을 잰다(조용한 방 -70) — 문턱 -45
    biLevel(400, -70);
    biTr.handlers?.onOpen();
    if (biPriv.tickTimer !== null) clearInterval(biPriv.tickTimer);
    biLevel(200, -70);
    add(
      "반이중: 연결·인사 전에는 서버로 가는 트랙이 켜져 있음 · 미터는 마이크를 얻자마자 시작(연결 중 소음 바닥)",
      biTrack.enabled && biFrame !== null && biC.getSnapshot().bargeIn.micToServer && biC.getSnapshot().bargeIn.meterOff === null,
    );
    // ① 인사 소리 시작 → 트랙 끔(생성 중)
    biTr.emit(created("i_r1"), talkEv.itemAdded("i_t1", "assistant", null), audioEv("output_audio_buffer.started", "i_r1"), talkEv.outDelta("i_t1", "i_r1", "Hi! I'm Sunny."));
    await flush();
    const g = biC.getSnapshot().bargeIn;
    add(
      "반이중 ① 선생님 소리 시작(output_audio_buffer.started) → 서버로 가는 트랙 enabled=false · 재생 셈 1 · 문턱 -45(바닥 -70 + 15 → 하한)",
      !biTrack.enabled && !g.micToServer && g.playbacks === 1 && g.thresholdDb === -45 && g.floorDb === -70,
      JSON.stringify({ enabled: biTrack.enabled, g: { p: g.playbacks, thr: g.thresholdDb, floor: g.floorDb } }),
    );
    // ② 생성 중 짧은 소리 300ms → 보낸 것 0, 트랙 꺼진 채
    let iMark = biTr.sent.length;
    biLevel(300, -25);
    biLevel(400, -70);
    add(
      "반이중 ② 재생 중 짧은 소리 0.3초 → cancel·clear 0 · 트랙 꺼진 채(서버는 못 들음) · 선생님 줄 그대로(partial) · 짧은 소리 1",
      iSent(iMark).length === 0 && !biTrack.enabled && iLine("i_t1")?.status === "partial" && biC.getSnapshot().bargeIn.shortSounds === 1,
      JSON.stringify({ sent: iSent(iMark), en: biTrack.enabled, t1: iLine("i_t1")?.status }),
    );
    // ③ 생성이 끝난 뒤(소리만 남음) 긴 말 1.2초 → 680ms까지 0, 720ms에 clear만 + 트랙 켬
    biTr.emit(talkEv.outDone("i_t1", "i_r1", "Hi! I'm Sunny. Do you like dogs?"), talkEv.responseDone("i_r1", "completed", ["i_t1"]));
    await flush();
    iMark = biTr.sent.length;
    biLevel(680, -25);
    const before = iSent(iMark);
    const enBefore = biTrack.enabled;
    biLevel(40, -25);
    const atCut = iSent(iMark);
    add(
      "반이중 ③ 소리만 남은 재생 중 긴 말: 680ms까지 0 · 700ms를 넘는 프레임(720ms)에 output_audio_buffer.clear만(cancel 없음) · 그 순간 트랙 켬",
      before.length === 0 && !enBefore && JSON.stringify(atCut) === JSON.stringify(["output_audio_buffer.clear"]) && biTrack.enabled && biC.getSnapshot().bargeIn.micToServer,
      JSON.stringify({ before, atCut, en: biTrack.enabled }),
    );
    biLevel(480, -25);
    biTr.emit(iCleared("i_r1"));
    await flush();
    add(
      "반이중 ③ 끊은 뒤에는 같은 재생에서 더 보내지 않음 · 서버 cleared → 그 선생님 줄 끊김(글자 유지) · 트랙 켜진 채",
      iSent(iMark).length === 1 && iLine("i_t1")?.status === "interrupted" && (iLine("i_t1")?.text.length ?? 0) > 0 && biTrack.enabled,
      JSON.stringify({ sent: iSent(iMark), t1: iLine("i_t1")?.status }),
    );
    // ④ 서버가 이제 은우 말을 듣는다 → 자동 응답(취소 안 함) → 소리 시작 → 트랙 끔 → 생성 중 긴 말 → cancel 다음 clear
    iMark = biTr.sent.length;
    biTr.emit(iSpeech("i_c2"));
    biLevel(400, -25);
    biTr.emit(iStop("i_c2"), talkEv.committed("i_c2", "i_t1"), talkEv.itemAdded("i_c2", "user", "i_t1"), talkEv.inCompleted("i_c2", "dog at home."));
    biLevel(80, -70);
    biTr.emit(created("i_r2"), talkEv.itemAdded("i_t2", "assistant", "i_c2"), audioEv("output_audio_buffer.started", "i_r2"), talkEv.outDelta("i_t2", "i_r2", "You have a dog!"));
    await flush();
    const offAgain = !biTrack.enabled;
    add("반이중 ④ 끼어든 말이 끝난 뒤의 자동 응답은 취소하지 않음 · 그 응답 소리가 시작되면 트랙을 다시 끔", iSent(iMark).length === 0 && offAgain, JSON.stringify(iSent(iMark)));
    biLevel(800, -25);
    const genCut = iSent(iMark);
    add(
      "반이중 ④ 생성 중(진행 중 응답) 긴 말 → response.cancel 다음 output_audio_buffer.clear · 트랙 켬",
      JSON.stringify(genCut) === JSON.stringify(["response.cancel", "output_audio_buffer.clear"]) && biTrack.enabled,
      JSON.stringify(genCut),
    );
    biTr.emit(iCleared("i_r2"), talkEv.responseDone("i_r2", "cancelled", ["i_t2"]));
    await flush();
    biTr.emit(iSpeech("i_c3"));
    biLevel(200, -25);
    biTr.emit(iStop("i_c3"), talkEv.committed("i_c3", "i_t2"), talkEv.itemAdded("i_c3", "user", "i_t2"), talkEv.inCompleted("i_c3", "I want to say."));
    biLevel(80, -70);
    // ⑤ 보통 차례가 끝까지 재생 → 재생 끝(stopped)에 트랙 켬
    biTr.emit(created("i_r3"), talkEv.itemAdded("i_t3", "assistant", "i_c3"), audioEv("output_audio_buffer.started", "i_r3"), talkEv.outDelta("i_t3", "i_r3", "Sure! What is it?"));
    await flush();
    const off3 = !biTrack.enabled;
    biTr.emit(talkEv.outDone("i_t3", "i_r3", "Sure! What is it?"), talkEv.responseDone("i_r3", "completed", ["i_t3"]));
    biLevel(600, -52); // 새어 든 선생님 소리(문턱 아래)
    biTr.emit(audioEv("output_audio_buffer.stopped", "i_r3"));
    await flush();
    add(
      "반이중 ⑤ 재생 끝(output_audio_buffer.stopped) → 트랙 켬 · 문턱 아래 잔향(-52)은 소리 덩어리 아님 · 끊지 않은 재생 최대 음량 -52 기록",
      off3 && biTrack.enabled && iLine("i_t3")?.status === "final" && biC.getSnapshot().bargeIn.quietPeakDb === -52,
      JSON.stringify({ off3, en: biTrack.enabled, peak: biC.getSnapshot().bargeIn.quietPeakDb }),
    );
    // ⑥ 늦게 온 앞 응답의 멈춤(QA cutoff_2 P3-B) — 다음 응답 재생 중 i_r3 cleared가 와도 트랙은 꺼진 채
    biTr.emit(created("i_r4"), talkEv.itemAdded("i_t4", "assistant", "i_t3"), audioEv("output_audio_buffer.started", "i_r4"), talkEv.outDelta("i_t4", "i_r4", "Tell me more."));
    await flush();
    biTr.emit(iCleared("i_r3"));
    await flush();
    const staleOff = !biTrack.enabled && biC.getSnapshot().teacherSpeaking;
    biTr.emit(talkEv.outDone("i_t4", "i_r4", "Tell me more."), talkEv.responseDone("i_r4", "completed", ["i_t4"]), audioEv("output_audio_buffer.stopped", "i_r4"));
    await flush();
    add(
      "반이중 ⑥ 다음 응답(r4) 재생 중 늦게 온 r3 cleared → 트랙 꺼진 채·선생님 말하는 중 유지 → r4 stopped에 켬",
      staleOff && biTrack.enabled && !biC.getSnapshot().teacherSpeaking,
      JSON.stringify({ staleOff, en: biTrack.enabled }),
    );
    // ⑦ 재생 전에 듣기 시작한 말이 마이크가 닫힌 동안 끝남 → 그 조각의 자동 응답만 response.cancel{id}
    iMark = biTr.sent.length;
    biTr.emit(iSpeech("i_c5"));
    biLevel(120, -25);
    biTr.emit(created("i_r5"), talkEv.itemAdded("i_t5", "assistant", "i_t4"), audioEv("output_audio_buffer.started", "i_r5"), talkEv.outDelta("i_t5", "i_r5", "Great!"));
    await flush();
    biLevel(200, -70);
    biTr.emit(talkEv.outDone("i_t5", "i_r5", "Great! Do you like cats?"), talkEv.responseDone("i_r5", "completed", ["i_t5"]));
    biTr.emit(iStop("i_c5"), talkEv.committed("i_c5", "i_t5"), talkEv.itemAdded("i_c5", "user", "i_t5"));
    biLevel(120, -70);
    biTr.emit(created("i_r6"));
    await flush();
    add(
      "반이중 ⑦ 마이크가 닫힌 동안 끝난 서버 말소리의 자동 응답만 response.cancel{response_id} (clear 없음 — 선생님 소리 그대로) · 셈 1",
      JSON.stringify(iSent(iMark)) === JSON.stringify(["response.cancel:i_r6"]) && biC.getSnapshot().bargeIn.repliesCancelled === 1 && !biTrack.enabled,
      JSON.stringify(iSent(iMark)),
    );
    biTr.emit(talkEv.responseDone("i_r6", "cancelled", []), talkEv.inCompleted("i_c5", "Um."), audioEv("output_audio_buffer.stopped", "i_r5"));
    await flush();
    const biStats = biC.getSnapshot().bargeIn;
    add(
      "반이중 진단 셈(스냅숏 bargeIn): 재생 5(취소된 r6은 소리 없음) · 기기 판정 끼어들기 2 · 짧은 소리 1 · 응답 취소 1 · 문턱 -45 · 바닥 -70 근처(은우 말 사이에도 거의 그대로) · 최근 덩어리 3(끊은 것 2)",
      biStats.playbacks === 5 && biStats.bargeIns === 2 && biStats.shortSounds === 1 && biStats.repliesCancelled === 1 && biStats.thresholdDb === -45 &&
        biStats.floorDb !== null && biStats.floorDb <= -66 &&
        biStats.recent.length === 3 && biStats.recent.filter((r) => r.cut).length === 2,
      JSON.stringify(biStats),
    );
    const biCreates = biTr.sent.filter((e) => e.type === "response.create").length;
    add(
      "반이중은 response.create를 늘리지 않음(앱 create = 첫 인사 1 — 선생님 두 명 규칙 §12-7) · 보낸 cancel·clear = 끼어들기 2회분 + 응답 취소 1",
      biCreates === 1 && biTr.sent.filter((e) => e.type === "response.cancel" || e.type === "output_audio_buffer.clear").length === 4,
      JSON.stringify(biTr.sent.map((e) => e.type)),
    );
    // ⑧ 끝내기 기다림(finishing) — 트랙을 끈 채로 두고(재생이 끝나도 켜지 않음) 판정 동작도 없음, 미터 멈춤
    biTr.emit(created("i_r7"), talkEv.itemAdded("i_t7", "assistant", "i_c5"), audioEv("output_audio_buffer.started", "i_r7"));
    await flush();
    biTr.emit(audioEv("output_audio_buffer.stopped", "i_r7"), talkEv.responseDone("i_r7", "completed", []), iSpeech("i_c8"));
    await flush();
    biC.finish("user");
    iMark = biTr.sent.length;
    const stopsAtFinish = biMeterStops;
    biLevel(1_000, -25);
    biTr.emit(created("i_r9"), audioEv("output_audio_buffer.started", "i_r9"), audioEv("output_audio_buffer.stopped", "i_r9"));
    await flush();
    add(
      "반이중 ⑧ 끝내기 기다림 중: 트랙 꺼진 채(재생이 끝나도 켜지 않음) · 미터 멈춤 · 1초 말해도 끼어들기 동작 없음(늦은 응답 취소·소리 비우기만)",
      biC.getSnapshot().phase === "finishing" && !biTrack.enabled && stopsAtFinish >= 1 &&
        JSON.stringify(iSent(iMark)) === JSON.stringify(["response.cancel", "output_audio_buffer.clear"]),
      JSON.stringify({ phase: biC.getSnapshot().phase, en: biTrack.enabled, stops: stopsAtFinish, sent: iSent(iMark) }),
    );
    add(
      "반이중: 레벨 미터가 없으면(트랙·컨텍스트 없음) 진단에 꺼진 이유 — 마이크는 여전히 재생 중 닫힌다(끼어들기만 없음)",
      ctl.getSnapshot().bargeIn.meterOff === "마이크 트랙 없음",
      String(ctl.getSnapshot().bargeIn.meterOff),
    );
    biC.end("user");
    await flush();
    add("반이중 ⑨ 끝(end — 숨김·뒤로가기·pagehide 공통) → 미터 멈춤 · 레벨 미터 오디오 컨텍스트 닫음(한 번)", biMeterStops >= 2 && biCtxCloses === 1 && biC.getSnapshot().phase === "ended", `${biMeterStops} · ${biCtxCloses}`);
  } finally {
    Date.now = realDateNow;
    for (const c of timed) c.end("user");
    await flush();
    globalThis.fetch = blockedFetch;
  }
  return results;
}

/** §12-7 출처 태깅 — 앱이 response.create 직전에 적어 둔 출처가 다음 response.created로 간다, 그 밖은 reply(리듀서 한 곳) */
function runTalkOriginChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 출처");
  const created = (id: string): RealtimeServerEvent => ({
    type: "response.created",
    event_id: talkEid(),
    response: { id, object: "realtime.response", status: "in_progress", output: [] },
  });
  const teacherTurn = (item: string, resp: string, prev: string | null, text: string): RealtimeServerEvent[] => [
    talkEv.itemAdded(item, "assistant", prev),
    talkEv.outDelta(item, resp, text),
    talkEv.outDone(item, resp, text),
    talkEv.responseDone(resp, "completed", [item]),
  ];
  let st = createTalkTranscript();
  const events: (RealtimeServerEvent | { app: "greeting" | "nudge" | "wrapup" | null })[] = [
    { app: "greeting" },
    created("resp_g"),
    ...teacherTurn("item_g", "resp_g", null, "Hi! I am Sunny. Do you like dogs?"),
    talkEv.speechStarted("item_c1"),
    talkEv.committed("item_c1", "item_g"),
    talkEv.inCompleted("item_c1", "Yes!"),
    created("resp_r"), // 은우 발화 뒤 서버 자동 응답 — 앱이 청하지 않음
    ...teacherTurn("item_r", "resp_r", "item_c1", "Great! What color is your dog?"),
    { app: "nudge" },
    created("resp_n"),
    ...teacherTurn("item_n", "resp_n", "item_r", "You can say: My dog is brown."),
    { app: "wrapup" },
    created("resp_w"),
    ...teacherTurn("item_w", "resp_w", "item_n", "You did great today. Bye-bye!"),
  ];
  const apply = (s: TalkTranscriptState, e: (typeof events)[number]) => ("app" in e ? requestTalkResponseOrigin(s, e.app) : reduceTalkTranscript(s, e));
  for (const e of events) st = apply(st, e);
  const originKey = (s: TalkTranscriptState) => s.lines.map((l) => `${l.itemId}:${l.origin ?? "null"}`).join(",");
  add(
    "앱 response.create 뒤 created = 그 출처(greeting·nudge·wrapup), 청 없는 created = reply, 은우 줄 = null",
    originKey(st) === "item_g:greeting,item_c1:null,item_r:reply,item_n:nudge,item_w:wrapup",
    originKey(st),
  );
  add("청은 created 하나가 소비한다(끝나면 비어 있음)", st.pendingOrigin === null);
  const turns = toTalkTurns(st.lines);
  add(
    "toTalkTurns가 출처를 싣는다(선생님 = 출처, 은우 = null)",
    JSON.stringify(turns.map((t) => t.origin)) === JSON.stringify(["greeting", null, "reply", "nudge", "wrapup"]),
    JSON.stringify(turns.map((t) => t.origin)),
  );
  add("저장 턴 zod(talkSaveTurnSchema)가 toTalkTurns 결과를 그대로 받음", turns.every((t) => talkSaveTurnSchema.safeParse(t).success));
  // 멱등 — 서버 이벤트를 두 번씩 흘려도 같다(같은 created가 다시 와도 다음 청을 소비하지 않는다)
  let twice = createTalkTranscript();
  for (const e of events) twice = "app" in e ? apply(twice, e) : apply(apply(twice, e), e);
  add("같은 서버 이벤트가 두 번씩 와도 출처가 같다(멱등)", originKey(twice) === originKey(st), originKey(twice));
  const dupCreated = reduceTalkTranscript(requestTalkResponseOrigin(st, "nudge"), created("resp_g"));
  add("이미 본 created가 다시 와도 새 청을 소비하지 않음", dupCreated.pendingOrigin === "nudge" && dupCreated.originOfResponse.resp_g === "greeting");
  const withdrawn = reduceTalkTranscriptEvents(
    [created("resp_x"), ...teacherTurn("item_x", "resp_x", "item_w", "Hmm, okay.")],
    requestTalkResponseOrigin(requestTalkResponseOrigin(st, "nudge"), null),
  );
  add("청을 거두면(null — response.create 거부) 다음 응답은 reply", withdrawn.lines.find((l) => l.itemId === "item_x")?.origin === "reply");
  const late = reduceTalkTranscriptEvents(
    [talkEv.itemAdded("item_l", "assistant", null), talkEv.outDelta("item_l", "resp_l", "Bye!"), created("resp_l")],
    requestTalkResponseOrigin(createTalkTranscript(), "wrapup"),
  );
  add("created가 글자보다 늦게 와도 그 줄의 출처를 고친다(reply → wrapup)", late.lines[0]?.origin === "wrapup" && late.pendingOrigin === null);
  const s0 = createTalkTranscript();
  add("같은 청을 다시 적으면 같은 상태 객체", requestTalkResponseOrigin(requestTalkResponseOrigin(s0, "nudge"), "nudge") !== s0 && requestTalkResponseOrigin(s0, null) === s0);
  add(
    "모양이 틀린 created(response·id 없음)는 무시(같은 상태 객체)",
    reduceTalkTranscript(st, { type: "response.created", event_id: "x" }) === st && reduceTalkTranscript(st, { type: "response.created", response: {} }) === st,
  );
  add("출처를 모르는 선생님 줄(응답 id 전)은 null, 저장 턴에서는 reply", (() => {
    const pre = reduceTalkTranscript(createTalkTranscript(), talkEv.itemAdded("item_p", "assistant", null));
    const withText: TalkLine = { ...pre.lines[0], text: "Hello", status: "final" };
    return pre.lines[0].origin === null && toTalkTurns([withText])[0]?.origin === "reply";
  })());

  // 저장 계약 — 출처 수용(옛 번들이 빼고 보내면 null), 모르는 값 거부, 옛 기록 읽기 null
  const parsedOld = talkSaveTurnSchema.safeParse({ speaker: "teacher", text: "Hi!", interrupted: false });
  add("저장 턴 zod: origin 없이 보내면(옛 번들) null로 받음", parsedOld.success && parsedOld.data.origin === null);
  add(
    "저장 턴 zod: 아는 출처 4개·null 받음, 모르는 값('tool')·글자 폭 초과는 거부",
    TALK_TURN_ORIGINS.every((o) => talkSaveTurnSchema.safeParse({ speaker: "teacher", text: "Hi!", interrupted: false, origin: o }).success) &&
      talkSaveTurnSchema.safeParse({ speaker: "child", text: "Yes", interrupted: false, origin: null }).success &&
      !talkSaveTurnSchema.safeParse({ speaker: "teacher", text: "Hi!", interrupted: false, origin: "tool" }).success &&
      !talkSaveTurnSchema.safeParse({ speaker: "teacher", text: "a".repeat(TALK_SAVE_TURN_TEXT_MAX + 1), interrupted: false, origin: null }).success,
  );
  const normalized = normalizeTalkSessionRecord({
    turns: [
      { speaker: "teacher", text: "Old turn", interrupted: false },
      { speaker: "teacher", text: "Nudge", interrupted: false, origin: "nudge" },
      { speaker: "child", text: "Yes", interrupted: false, origin: "reply" },
      { speaker: "teacher", text: "Odd", interrupted: false, origin: "tool" },
    ],
  });
  add(
    "옛 기록 읽기: origin 없음·모르는 값·은우 턴 → null, 선생님의 아는 값은 그대로(키는 늘 있음)",
    JSON.stringify(normalized.turns.map((t) => t.origin)) === JSON.stringify([null, "nudge", null, null]) && normalized.turns.every((t) => "origin" in t),
    JSON.stringify(normalized.turns.map((t) => t.origin)),
  );
  return results;
}

/**
 * §12-7 "§12-6 이어 말하기 경로가 사라졌는지(정적 점검)" — 세션 설정·AI 상수·컨트롤러(lib/talk-realtime.ts, 2026-09-27 app-builder가
 * 걷어 냄 → `TALK_CONTROLLER_TOOL_PATH_REMOVED = true`)와 호출 J 라우트(`/api/english/talk/cards`)의 배선 모양을 소스로 본다.
 * 컨트롤러의 **동작**(은우 한 번 대답에 앱 response.create 0·줄마다 카드 1회·철 지난 도움·출처 청)은 "자유대화 컨트롤러"가 합성 이벤트로 본다.
 */
const TALK_CONTROLLER_TOOL_PATH_REMOVED = true;
const talkPendingNotes: string[] = [];
function runTalkToolPathStaticChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 정적");
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");
  const sessionSrc = read("lib/talk-session-config.ts");
  add(
    "세션 설정 조립에 도구·tool_choice·화면 카드 덧붙임이 없다(주석 밖 코드)",
    !/^\s*(tools|tool_choice)\s*:/m.test(sessionSrc) && !/TALK_TOOLS|TALK_TOOL_CHOICE|TALK_CARDS_INSTRUCTIONS/.test(sessionSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
  );
  const aiSrc = read("lib/ai/english/talk-schemas.ts") + read("lib/ai/english/talk-prompts.ts");
  add(
    "AI 상수에 §12-6 도구 정의·도구 사용 안내가 남지 않았다(TALK_TOOLS·TALK_CARDS_INSTRUCTIONS export 없음)",
    !/export const (TALK_TOOLS|TALK_TOOL_CHOICE|TALK_CARDS_INSTRUCTIONS)\b/.test(aiSrc),
  );
  runTalkCardsWiringStaticChecks(read, add);
  const controllerSrc = read("lib/talk-realtime.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const leftovers = ["stepTalkContinue", "parseTalkToolCall", "buildTalkToolOutputEvent", "extractTalkFunctionCalls"].filter((n) => controllerSrc.includes(n));
  if (TALK_CONTROLLER_TOOL_PATH_REMOVED) {
    add("컨트롤러에 §12-6 이어 말하기·도구 호출 처리 경로가 없다", leftovers.length === 0, leftovers.join(",") || "없음");
    add(
      "컨트롤러에 function_call_output·도구 호출 꺼내기가 없다(도구 결과를 보내지 않는다)",
      !/function_call_output|function_call\b|app_out/.test(controllerSrc),
    );
    const creates = controllerSrc.split("buildTalkResponseCreateEvent()").length - 1;
    const createCalls = [...controllerSrc.matchAll(/this\.sendResponseCreate\(("[a-z]+")?\)/g)].map((m) => m[1] ?? "(출처 없음)");
    add(
      "컨트롤러의 response.create는 한 곳(sendResponseCreate)이고, 부르는 곳은 greeting·nudge·wrapup 셋뿐(출처 청 필수)",
      creates === 1 && JSON.stringify([...createCalls].sort()) === JSON.stringify(['"greeting"', '"nudge"', '"wrapup"']) && /requestTalkResponseOrigin\(this\.transcript, origin\)/.test(controllerSrc),
      `create ${creates}곳 · 부르는 곳 ${createCalls.join(",")}`,
    );
    const routeSrc = read("app/api/english/talk/cards/route.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const keyAt = routeSrc.indexOf("if (!hasTalkApiKey())");
    const callAt = routeSrc.indexOf("await generateTalkCards(");
    add(
      "카드 라우트: zod 뒤 키 검사(501)가 generateTalkCards보다 먼저, req.signal을 넘기고, 폭은 TALK_CARDS_REQUEST_LIMITS를 import, 저장하지 않음",
      keyAt > 0 && callAt > keyAt && routeSrc.indexOf("bodySchema.safeParse") < keyAt &&
        /\{ signal: req\.signal \}/.test(routeSrc) &&
        /import \{ TALK_CARDS_REQUEST_LIMITS \} from "@\/lib\/talk-cards"/.test(routeSrc) &&
        !/getStore|@\/lib\/store/.test(routeSrc),
      `key@${keyAt} call@${callAt}`,
    );
  } else {
    talkPendingNotes.push(
      `보류(app-builder 단계): lib/talk-realtime.ts가 아직 ${leftovers.join("·") || "(없음)"}를 부른다 — 걷어 낸 뒤 scripts/eval-english.ts의 TALK_CONTROLLER_TOOL_PATH_REMOVED를 true로 바꾼다.`,
    );
  }
  return results;
}

/**
 * 호출 J 진입 함수 배선(QA talk-cards-j P2-A) — `generateTalkCards`가 부품을 **실제로 끼우는지** 소스로 잠근다.
 * 오프라인 게이트가 fetch를 막아 진입 함수를 태울 수 없고 §12-7에는 호출 J 실호출 게이트도 없어, 후처리 호출·6초 신호·모델 인자를
 * 한 줄 지워도 부품 행(조립·zod·후처리·신호 합성·모델 해석)은 전부 통과했다(변이 M12·M13·M19). 행위 점검(eval 안 루프백 스텁)은
 * 캐시된 클라이언트와 전역 fetch 차단을 흔들어 게이트의 보장을 약하게 하므로 쓰지 않는다. 주석을 걷고 공백을 한 칸으로 줄여 본다
 * (줄바꿈·들여쓰기가 바뀌어도 통과, 인자를 빼거나 바꾸면 실패).
 */
function runTalkCardsWiringStaticChecks(read: (rel: string) => string, add: TalkAdd): void {
  const flat = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, " ");
  const clientSrc = flat(read("lib/ai/client.ts"));
  const sliceFn = (head: string) => {
    const start = clientSrc.indexOf(head);
    if (start < 0) return "";
    const next = clientSrc.indexOf(" export ", start + head.length);
    return clientSrc.slice(start, next < 0 ? undefined : next);
  };
  const fn = sliceFn("export async function generateTalkCards(");
  const callAt = fn.indexOf("await callWithSchema({");
  const callEnd = callAt < 0 ? -1 : fn.indexOf("});", callAt);
  const callArgs = callAt < 0 || callEnd < 0 ? "" : fn.slice(callAt, callEnd + 3);
  const has = (needle: string) => callArgs.includes(needle);
  add("호출 J 배선: generateTalkCards 본문과 callWithSchema 인자를 찾음(못 찾으면 아래 행이 헛돈다)", fn !== "" && callArgs !== "", `본문 ${fn.length}자 · 인자 ${callArgs.length}자`);

  const outVar = /const (\w+) = await callWithSchema\(\{/.exec(fn)?.[1] ?? null;
  const ret = /return sanitizeTalkScreenCards\( ?(\w+) ?, ?\{ ?([^}]*?) ?,? ?\} ?\) ?;/.exec(fn);
  const ctxFields = ret ? ret[2].split(",").map((f) => f.trim()).filter(Boolean).sort() : [];
  add(
    "호출 J 배선: callWithSchema 결과를 후처리 sanitizeTalkScreenCards(…, {teacherLine: input.teacherLine, words: input.words, shown: input.shown})에 넘겨 반환(근거 검사 생략 금지)",
    outVar !== null && ret !== null && ret[1] === outVar &&
      JSON.stringify(ctxFields) === JSON.stringify(["shown: input.shown", "teacherLine: input.teacherLine", "words: input.words"]) &&
      !new RegExp(`return ${outVar ?? "\\u0000"} ?;`).test(fn),
    ret ? `return sanitizeTalkScreenCards(${ret[1]}, {${ctxFields.join(", ")}})` : "후처리 반환 없음",
  );
  add("호출 J 배선: 6초·요청 취소 신호 signal: talkCardsAbortSignal(options.signal)", has("signal: talkCardsAbortSignal(options.signal)"));
  add(
    `호출 J 배선: SDK 재시도 maxRetries: TALK_CARDS_SDK_MAX_RETRIES(= ${TALK_CARDS_SDK_MAX_RETRIES}) — retry-after 대기가 신호를 보지 않아 6초 상한을 뚫는다(QA P3-A)`,
    has("maxRetries: TALK_CARDS_SDK_MAX_RETRIES") && TALK_CARDS_SDK_MAX_RETRIES === 0,
  );
  add("호출 J 배선: 모델 model: resolveTalkCardsModel()(빼면 OPENAI_MODEL로 간다 — 카드 모델을 따로 바꿀 길이 사라진다)", has("model: resolveTalkCardsModel()"));
  add(
    "호출 J 배선: jsonSchema: TALK_SCREEN_CARDS_JSON_SCHEMA · zodSchema: talkScreenCardsSchema · system: TALK_CARDS_SYSTEM_PROMPT · user: buildTalkCardsUserMessage(input)",
    has("jsonSchema: TALK_SCREEN_CARDS_JSON_SCHEMA") &&
      has("zodSchema: talkScreenCardsSchema") &&
      has("system: TALK_CARDS_SYSTEM_PROMPT") &&
      has("user: [textPart(buildTalkCardsUserMessage(input))]"),
  );
  add(
    "호출 J 배선: 옵션 TALK_CARDS_CALL_OPTIONS.call · .temperature · .maxOutputTokens",
    has("call: TALK_CARDS_CALL_OPTIONS.call") &&
      has("temperature: TALK_CARDS_CALL_OPTIONS.temperature") &&
      has("maxOutputTokens: TALK_CARDS_CALL_OPTIONS.maxOutputTokens"),
  );
  const earlyAt = fn.indexOf('if (input.teacherLine.trim() === "") return { answers: [], words: [], picture: null };');
  add("호출 J 배선: 빈 선생님 말은 callWithSchema 전에 빈 카드로 return(과금 0)", earlyAt >= 0 && callAt >= 0 && earlyAt < callAt);

  // 공유 래퍼 — 두 인자가 요청 옵션까지 실제로 가는지(첫 요청·temperature 재시도 두 곳 모두 같은 옵션). 생략하면 옵션 없음(기존 동작).
  // 옵션 **조립 규칙**(0을 싣는지·둘 다 없으면 undefined인지)은 순수 함수 buildCallRequestOptions를 행동으로 본다
  // (runTalkCardsRequestOptionChecks — QA P3-E: 부분 문자열만 보던 옛 행은 `args.maxRetries ?` 참거짓 변이를 놓쳤다).
  // 여기서는 래퍼가 **그 함수의 결과**를 두 요청에 그대로 넘기는지만 본다.
  const wrapper = sliceFn("export async function callWithSchema<T>(");
  const optsAt = wrapper.indexOf("const requestOptions =");
  const opts = optsAt < 0 ? "" : wrapper.slice(optsAt, wrapper.indexOf(";", optsAt) + 1);
  add(
    "공유 래퍼: callWithSchema가 요청 옵션을 buildCallRequestOptions(args)로 만들고, 첫 요청·temperature 재시도가 같은 옵션을 넘긴다",
    opts === "const requestOptions = buildCallRequestOptions(args);" &&
      wrapper.split("responses.create(params, requestOptions)").length - 1 === 2 &&
      wrapper.split("responses.create(").length - 1 === 2,
    opts.slice(0, 160) || "requestOptions 조립 없음",
  );
  // temperature를 싣는 조건 — 이 프로세스에서 거부한 모델이 아니고(런타임 기억) 이름으로 알려진 추론 계열도 아닐 때만(2026-10-02).
  // 사전 판정을 빼면 gpt-6-luna 호출 J가 인스턴스마다 첫 카드에서 거부 400 왕복을 한 번 더 해 6초 상한을 먹는다.
  add(
    "공유 래퍼: temperature는 !modelsRejectingTemperature.has(model) && !isKnownTemperatureRejectingModel(model)일 때만 싣는다(거부 재시도 경로는 그대로)",
    wrapper.includes("if (!modelsRejectingTemperature.has(model) && !isKnownTemperatureRejectingModel(model)) params.temperature = temperature;") &&
      wrapper.includes("modelsRejectingTemperature.add(model);") &&
      wrapper.includes("delete params.temperature;"),
  );
}

/** 호출 J 시간 상한 신호(talkCardsAbortSignal) — 요청 취소·시간 초과가 호출 전체를 끊는다. 타이머를 기다려야 해서 비동기다(수십 ms). */
async function runTalkCardsSignalChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 호출J");
  const external = new AbortController();
  const composed = talkCardsAbortSignal(external.signal, 60_000);
  const before = composed.aborted;
  external.abort();
  add("요청 취소(req.signal) → 호출 신호가 곧바로 끊김", !before && composed.aborted);
  const pre = new AbortController();
  pre.abort();
  add("이미 끊긴 요청이면 호출 신호도 처음부터 끊김", talkCardsAbortSignal(pre.signal, 60_000).aborted);
  // 시간 상한 두 모양을 같은 60ms 안에서 함께 본다 — 외부 신호 없음, 그리고 **운영 모양**(라우트는 늘 req.signal을 넘긴다).
  // 운영 모양 행이 없으면 `external ?? timeout`·`AbortSignal.any([external])`처럼 외부 신호가 있을 때 상한을 버리는 변이가
  // 전 항목을 통과하고, 9초 늦는 상류가 6초가 아니라 18초(zod 재요청 2요청)에 끝난다(QA talk-cards-j P2-B, 변이 N1·N20).
  const timed = talkCardsAbortSignal(undefined, 15);
  const early = timed.aborted;
  const live = new AbortController(); // 라우트 req.signal 모양 — 끊기지 않는 외부 신호
  const both = talkCardsAbortSignal(live.signal, 15);
  const bothEarly = both.aborted;
  await new Promise((r) => setTimeout(r, 60));
  add("시간 상한이 지나면 끊김(짧은 값으로 확인 — 운영은 TALK_CARDS_TIMEOUT_MS)", !early && timed.aborted);
  add(
    "외부 신호(req.signal)가 살아 있어도 시간 상한이 지나면 끊김(운영 모양 — 6초가 외부 신호에 가려지지 않게)",
    !bothEarly && both.aborted && !live.signal.aborted,
    `만들 때 ${bothEarly ? "끊김" : "살아 있음"} · 60ms 뒤 ${both.aborted ? "끊김" : "살아 있음"} · 외부 신호 ${live.signal.aborted ? "끊김" : "살아 있음"}`,
  );
  const def = talkCardsAbortSignal(undefined);
  add("기본 상한 신호는 만들자마자 끊기지 않음", !def.aborted);
  // 운영 상한은 기본 인자에 산다 — 호출부(generateTalkCards)는 ms를 넘기지 않는다. 위 행들은 ms를 명시하므로 기본값을 60초로 바꾼
  // 변이(QA talk-cards-j P2-C, Q26·Q26b)가 전부 통과했다. AbortSignal.timeout을 잠깐 감싸 기본값이 곧 TALK_CARDS_TIMEOUT_MS인지 본다(기다림 없음).
  const origTimeout = AbortSignal.timeout;
  const seenMs: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seenMs.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    talkCardsAbortSignal(new AbortController().signal); // 라우트 모양 — 호출부처럼 ms 없이
    talkCardsAbortSignal();
  } finally {
    AbortSignal.timeout = origTimeout;
  }
  add(
    "호출 J 기본 시간 상한 = TALK_CARDS_TIMEOUT_MS(호출부는 ms를 넘기지 않는다 — 기본값이 곧 운영 상한)",
    seenMs.length === 2 && seenMs.every((ms) => ms === TALK_CARDS_TIMEOUT_MS),
    JSON.stringify(seenMs),
  );
  runTalkCardsRequestOptionChecks(add);
  return results;
}

/**
 * 공유 래퍼의 요청 옵션 조립(`buildCallRequestOptions`) — 호출 J가 넘기는 **SDK 재시도 0**이 실제 요청 옵션까지 가는지 행동으로 본다
 * (QA talk-cards-j P3-E). 조건을 참거짓(`args.maxRetries ?`)으로 "단순화"하면 0이 빠져 SDK 기본 재시도가 돌아오고,
 * 429 + `retry-after: 12`에 12초가 걸린다(P3-A 재발). 다른 과목 호출(두 인자 생략)은 옵션 없이(`undefined`) 나가야 기존 모양 그대로다.
 */
function runTalkCardsRequestOptionChecks(add: TalkAdd): void {
  const sig = new AbortController().signal;
  const show = (v: CallRequestOptionsView) => (v === undefined ? "undefined" : `{${Object.keys(v).sort().join(",")}}`);
  const zero = buildCallRequestOptions({ maxRetries: 0 });
  add(
    "공유 래퍼 요청 옵션: {maxRetries: 0} → {maxRetries: 0}(0을 빠뜨리면 SDK 기본 재시도가 돌아와 6초 상한을 뚫는다)",
    zero !== undefined && Object.keys(zero).join(",") === "maxRetries" && zero.maxRetries === 0,
    show(zero),
  );
  const none = buildCallRequestOptions({});
  add("공유 래퍼 요청 옵션: {} → undefined(다른 과목 호출은 옵션 없이 — SDK 기본 그대로)", none === undefined, show(none));
  const undef = buildCallRequestOptions({ signal: undefined, maxRetries: undefined });
  add("공유 래퍼 요청 옵션: 두 키가 undefined로 와도 → undefined", undef === undefined, show(undef));
  const onlySig = buildCallRequestOptions({ signal: sig });
  add(
    "공유 래퍼 요청 옵션: {signal} → {signal}(같은 신호, maxRetries 키 없음)",
    onlySig !== undefined && Object.keys(onlySig).join(",") === "signal" && onlySig.signal === sig,
    show(onlySig),
  );
  const talkJ = buildCallRequestOptions({ signal: sig, maxRetries: TALK_CARDS_SDK_MAX_RETRIES });
  add(
    "공유 래퍼 요청 옵션: 호출 J 모양 {signal, maxRetries: TALK_CARDS_SDK_MAX_RETRIES} → 두 키 그대로",
    talkJ !== undefined && Object.keys(talkJ).sort().join(",") === "maxRetries,signal" && talkJ.signal === sig && talkJ.maxRetries === TALK_CARDS_SDK_MAX_RETRIES,
    show(talkJ),
  );
  const two = buildCallRequestOptions({ maxRetries: 2 });
  add("공유 래퍼 요청 옵션: {maxRetries: 2} → {maxRetries: 2}", two !== undefined && Object.keys(two).join(",") === "maxRetries" && two.maxRetries === 2, show(two));
  // 래퍼는 CallWithSchemaArgs 전체를 넘긴다 — 다른 인자(call·model·temperature…)가 SDK 요청 옵션으로 새지 않아야 한다.
  const wide: Parameters<typeof buildCallRequestOptions>[0] & Record<string, unknown> = {
    call: "talk_cards",
    model: "gpt-x",
    temperature: 0.3,
    maxOutputTokens: 600,
    maxRetries: 0,
  };
  const narrowed = buildCallRequestOptions(wide);
  add("공유 래퍼 요청 옵션: 다른 인자는 옵션에 싣지 않음(signal·maxRetries만)", narrowed !== undefined && Object.keys(narrowed).join(",") === "maxRetries", show(narrowed));
}
type CallRequestOptionsView = ReturnType<typeof buildCallRequestOptions>;

function runTalkChecks(): CheckResult[] {
  return [
    ...runTalkSpecChecks(),
    ...runTalkInstructionChecks(),
    ...runTalkSessionConfigChecks(),
    ...runTalkTranscriptChecks(),
    ...runTalkSentenceChecks(),
    ...runTalkExplainChecks(),
    ...runTalkSpeakScriptChecks(),
    ...runTalkStreakChecks(),
    ...runTalkCardChecks(),
    ...runTalkHintsChecks(),
    ...runTalkBargeInChecks(),
    ...runTalkHalfDuplexStaticChecks(),
    ...runTalkSaveBodyChecks(),
    ...runTalkSceneChecks(),
    ...runTalkCardsCallChecks(),
    ...runTalkCardsRequestChecks(),
    ...runTalkOriginChecks(),
    ...runTalkToolPathStaticChecks(),
  ];
}

function toCardInput(fixture: Fixture): CardUserMessageInput {
  return {
    title: fixture.title,
    author: fixture.author,
    series: fixture.series,
    isFiction: fixture.isFiction,
    arLevel: fixture.arLevel,
    lexile: fixture.lexile,
    wordCount: fixture.wordCount,
    topic: fixture.topic,
    googleBooksDescription: null, // eval은 판독 픽스처만으로 생성한다
    blurbText: fixture.blurbText ?? null,
    sceneKind: fixture.sceneKind ?? null,
    sceneDigest: fixture.sceneDigest ?? null,
    transcript: fixture.transcript ?? null,
  };
}

// ---------------------------------------------------------------------------
// 프롬프트 원문 ↔ 스펙 문서 대조 — `docs/harness/english.md`가 진실 원천인지 코드로 확인한다
//
// 이 저장소는 "스펙이 단일 진실 원천"으로 돌아가는데, 스펙의 프롬프트 원문과 여기 실제로 쓰는
// 문자열이 같은지 **확인하는 코드가 없었다.** 근거는 사람이 그때그때 돌린 diff뿐이었다.
// 한 번만 빠뜨리면 스펙과 프롬프트가 조용히 갈라지고, 그다음부터 스펙을 읽어 고친 사람은
// 코드에 없는 문장을 고치게 된다.
//
// 매핑은 "몇 번째 코드블록"으로 못 박지 않는다. 스펙의 코드블록을 전부 뽑아 두고 **내용으로**
// 같은 블록을 찾는다 (`scripts/spec-sync.ts` 머리주석에 방식·정규화 범위가 있다).
//
// 대조에서 **뺀 것과 그 사유** — 조용히 빼지 않고 여기 남긴다:
//   - `buildPagesUserMessage` · `buildCardUserMessage`: 함수이고 런타임 값을 보간한다(`${...}`).
//     스펙 §2A-2·§3-2의 템플릿은 플레이스홀더가 든 서술이라 "원문 그대로" 대조가 성립하지 않는다.
//     이 둘이 지시하는 다이얼은 `runStoryLengthDialChecks()`가 값으로 검사한다.
// ---------------------------------------------------------------------------

const ENGLISH_SPEC_URL = new URL("../docs/harness/english.md", import.meta.url);

const SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  {
    constName: "EXTRACT_SYSTEM_PROMPT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§2-1 호출 A 시스템 프롬프트",
    text: EXTRACT_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "EXTRACT_USER_TEXT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§2-2 사용자 메시지",
    text: EXTRACT_USER_TEXT,
    // 스펙에 코드블록이 아니라 인라인 코드 한 줄로 적혀 있다 — 본문 포함 여부로 본다
    mode: "inline",
  },
  {
    constName: "PAGES_SYSTEM_PROMPT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§2A-1 호출 A′ 시스템 프롬프트",
    text: PAGES_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "CARD_SYSTEM_PROMPT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§3-1 호출 B 시스템 프롬프트",
    text: CARD_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "VOCAB_EXTRACT_SYSTEM_PROMPT",
    source: "lib/ai/english/vocabbook-prompts.ts",
    specLabel: "§7-1 호출 C 시스템 프롬프트",
    text: VOCAB_EXTRACT_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "VOCAB_EXTRACT_USER_TEXT",
    source: "lib/ai/english/vocabbook-prompts.ts",
    specLabel: "§7-2 사용자 메시지",
    text: VOCAB_EXTRACT_USER_TEXT,
    // 스펙에 코드블록이 아니라 인라인 코드 한 줄로 적혀 있다 — 본문 포함 여부로 본다
    mode: "inline",
  },
  {
    constName: "VOCAB_ENRICH_SYSTEM_PROMPT",
    source: "lib/ai/english/vocabbook-prompts.ts",
    specLabel: "§8-1 호출 D 시스템 프롬프트",
    text: VOCAB_ENRICH_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "VOCAB_ENRICH_USER_TEXT",
    source: "lib/ai/english/vocabbook-prompts.ts",
    specLabel: "§8-2 사용자 메시지",
    text: VOCAB_ENRICH_USER_TEXT,
    // 스펙에 코드블록이 아니라 인라인 코드 한 줄로 적혀 있다 — 본문 포함 여부로 본다
    mode: "inline",
  },
  {
    constName: "CHAPTERIZE_SYSTEM_PROMPT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§9-1 호출 F 시스템 프롬프트",
    text: CHAPTERIZE_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "WORD_MEANING_SYSTEM_PROMPT",
    source: "lib/ai/english/prompts.ts",
    specLabel: "§10-1 호출 G 시스템 프롬프트",
    text: WORD_MEANING_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "RELATED_SUGGEST_SYSTEM_PROMPT",
    source: "lib/ai/english/vocabbook-prompts.ts",
    specLabel: "§11-1 호출 H 시스템 프롬프트",
    text: RELATED_SUGGEST_SYSTEM_PROMPT,
    mode: "block",
  },
  // 자유대화(§12) — 관문 R 지시문·수업 블록·인사·마무리(하네스 밖이지만 원문은 대조한다) + 호출 I 프롬프트·템플릿.
  // 값을 보간하는 buildTalkExplainUserMessage·buildTalkLesson·buildTalkInstructions·buildTalkSceneNote·buildTalkSceneImagePrompt는
  // 템플릿(아래 상수)이 대조되고, 치환 결과는 runTalkInstructionChecks·runTalkExplainChecks·runTalkSceneChecks가 값으로 본다.
  // 자유대화 상수는 스펙 블록 하나에 통째로 적혀 있어 조립이 필요 없다 — "block-exact"로 조립 규칙을 끈다(두 블록을 이어 붙인
  // 상수가 조립 규칙으로 통과하던 구멍, QA talk-ai P2-4).
  {
    constName: "TALK_TEACHER_INSTRUCTIONS",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-1 관문 R 선생님 지시문",
    text: TALK_TEACHER_INSTRUCTIONS,
    mode: "block-exact",
  },
  {
    constName: "TALK_LESSON_TOPIC",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-1 수업 블록 — 주제",
    text: TALK_LESSON_TOPIC,
    mode: "block-exact",
  },
  {
    constName: "TALK_LESSON_WORDS",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-1 수업 블록 — 단어장",
    text: TALK_LESSON_WORDS,
    mode: "block-exact",
  },
  {
    constName: "TALK_GREETING_INSTRUCTIONS",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-1 첫 인사 응답 지시",
    text: TALK_GREETING_INSTRUCTIONS,
    mode: "block-exact",
  },
  {
    constName: "TALK_WRAPUP_INSTRUCTIONS",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-1 마무리 응답 지시",
    text: TALK_WRAPUP_INSTRUCTIONS,
    mode: "block-exact",
  },
  {
    constName: "TALK_EXPLAIN_SYSTEM_PROMPT",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-3 호출 I 시스템 프롬프트",
    text: TALK_EXPLAIN_SYSTEM_PROMPT,
    mode: "block-exact",
  },
  {
    constName: "TALK_EXPLAIN_USER_TEMPLATE",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-3 호출 I 사용자 메시지 템플릿",
    text: TALK_EXPLAIN_USER_TEMPLATE,
    mode: "block-exact",
  },
  // §12-7 차례 규칙 — 세션 지시문 덧붙임(§12-6 TALK_CARDS_INSTRUCTIONS를 대체, 2026-09-27)
  {
    constName: "TALK_TURN_RULES",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-7 차례 규칙(세션 지시문 덧붙임)",
    text: TALK_TURN_RULES,
    mode: "block-exact",
  },
  // §12-7 호출 J — 화면 카드 생성 시스템 프롬프트·사용자 메시지 템플릿(치환 결과는 runTalkCardsCallChecks가 값으로 본다)
  {
    constName: "TALK_CARDS_SYSTEM_PROMPT",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-7 호출 J 시스템 프롬프트",
    text: TALK_CARDS_SYSTEM_PROMPT,
    mode: "block-exact",
  },
  {
    constName: "TALK_CARDS_USER_TEMPLATE",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-7 호출 J 사용자 메시지 템플릿",
    text: TALK_CARDS_USER_TEMPLATE,
    mode: "block-exact",
  },
  // §12-6 화면 카드 — 도움 요청·일러스트 안내·사진 프롬프트
  {
    constName: "TALK_NUDGE_NOTE",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-6 말문 막힘 도움 요청",
    text: TALK_NUDGE_NOTE,
    mode: "block-exact",
  },
  {
    constName: "TALK_SCENE_NOTE",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-6 주제 일러스트 안내",
    text: TALK_SCENE_NOTE,
    mode: "block-exact",
  },
  {
    constName: "TALK_SCENE_IMAGE_PROMPT",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-6 사진 생성 프롬프트",
    text: TALK_SCENE_IMAGE_PROMPT,
    mode: "block-exact",
  },
];

/** 표 뒤에 상세 diff를 찍기 위해 남겨 둔다 (main이 읽는다) */
const specSyncOutcomes: SpecSyncOutcome[] = [];

function runSpecSyncChecks(): CheckResult[] {
  specSyncOutcomes.length = 0;
  specSyncOutcomes.push(...checkSpecSync(ENGLISH_SPEC_URL, SPEC_SYNC_TARGETS));
  return specSyncOutcomes.map((o) => ({
    book: "프롬프트 ↔ 스펙",
    check: `${o.constName}이 english.md 원문 그대로`,
    // 스펙을 못 읽거나 블록을 못 찾으면 FAIL이다. SKIP으로 삼키면 대조가 조용히 꺼진다.
    pass: o.ok,
    detail: o.summary,
  }));
}

function printTable(results: CheckResult[]): void {
  const header = `| ${"결과".padEnd(4)} | ${"책".padEnd(16)} | 점검 항목 | 상세 |`;
  console.log("");
  console.log(header);
  console.log(`|------|------------------|-----------|------|`);
  for (const r of results) {
    console.log(
      `| ${r.pass ? "PASS" : "FAIL"} | ${r.book.padEnd(16)} | ${r.check} | ${r.detail} |`,
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  const allResults: CheckResult[] = [];

  // 실호출 0회 — 호출 A′ 스키마·하위 호환 헬퍼·분량 다이얼부터 검사한다 (키 없이도 돈다)
  allResults.push(...runPageDigestChecks());
  allResults.push(...runStoryLengthDialChecks());
  // 낭독 자막(transcript) grounding 계약 — 최상위 티어·분량 상한·랭크 거부·배지·슬롯/절단 (실호출 0회)
  allResults.push(...runTranscriptOfflineChecks());
  // 챕터화(§9) — chapters zod 계약·groundChapters 자막 밖 창작 금지·truncate·상수 정합 (실호출 0회)
  allResults.push(...runChapterizeChecks());
  // 단어 뜻 조회(§10) — word_meaning zod 계약(짧게·한글만·영어 연속 금지)·JSON Schema strict (실호출 0회)
  allResults.push(...runWordMeaningChecks());
  // 유의어·반의어 추천(§11) — related_suggestion zod 계약·JSON Schema strict·후처리(표제어 제외·중복) (실호출 0회)
  allResults.push(...runRelatedSuggestChecks());
  // 단어장 정복 V1(§7) — 병합 순수 함수·zod 제약·그림 우선순위 (실호출 0회)
  allResults.push(...runVocabbookChecks());
  // 자유대화(§12) — 스펙 대조(스키마·옵션·세션 표)·지시문 조립·세션 설정·리듀서·문장 나누기·호출 I zod·낭독 대본·스트릭 입력 (실호출 0회)
  allResults.push(...runTalkChecks());
  allResults.push(...(await runTalkCardsSignalChecks()));
  // §12-7 컨트롤러 동작 — 합성 이벤트 전송 + 함수 안에서만 갈아 끼운 fetch 대역(네트워크 0)
  allResults.push(...(await runTalkControllerChecks()));
  // 프롬프트 원문이 스펙 문서와 같은지 — 파일을 읽어서 대조한다 (실호출 0회)
  allResults.push(...runSpecSyncChecks());

  // 실호출 없이 정적 검증만 하고 끝낸다 — OPENAI_API_KEY가 없거나 비용을 쓰기 전에
  // 다이얼 동기화만 확인할 때 쓴다. 통과해도 "카드 품질 통과"가 아니라 "정의 동기화 통과"다.
  if (process.env.EVAL_OFFLINE_ONLY === "1") {
    printTable(allResults);
    printSpecSyncDetails(specSyncOutcomes);
    for (const note of talkPendingNotes) console.log(`NOTE — ${note}`);
    const offlineFailed = allResults.filter((r) => !r.pass);
    console.log("EVAL_OFFLINE_ONLY=1 — 실호출 0회. 모델 출력 품질은 검증하지 않았습니다.");
    if (offlineFailed.length > 0) {
      console.error(`FAIL — 오프라인 ${offlineFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 오프라인 ${allResults.length}개 항목 통과 (실호출 미실행).`);
    return;
  }

  // 낭독 자막 grounding 실호출 게이트 — **EVAL_TRANSCRIPT=1일 때만** 실호출 1회. (오프라인 게이트가
  // 위에서 이미 return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 자막을 넣은 카드 1건이
  // (a) storySource=transcript·분량 8~10문장이고 (b) 영어 원문 전사가 없고 (c) 채널 인트로/아웃트로
  // 노이즈가 줄거리에 안 섞였는지를 본다. 자막 밖 창작 여부는 사람이 읽어야 갈리므로 줄거리를 인쇄한다.
  if (process.env.EVAL_TRANSCRIPT === "1") {
    console.log("EVAL_TRANSCRIPT=1 — 낭독 자막 grounding 실호출 1회로 카드를 점검합니다.");
    const transcriptResults: CheckResult[] = [];
    try {
      const card = await generateCard(toCardInput(TRANSCRIPT_FIXTURE));
      console.log(`storyOutlineKo (${card.storySource}):\n${card.storyOutlineKo}`);
      // (a)·(b) 등 §4/§5 공통 점검은 runChecks가 전부 본다 (storySource·분량·영어 전사 포함)
      transcriptResults.push(...runChecks(TRANSCRIPT_FIXTURE, card));
      // 자막이 최상위 근거이므로 카드는 transcript를 주장해야 정상이다 (낮춰 적으면 근거를 버린 것)
      transcriptResults.push({
        book: TRANSCRIPT_FIXTURE.label,
        check: "자막 근거를 transcript로 주장(최상위 근거 사용)",
        pass: card.storySource === "transcript",
        detail: `storySource=${card.storySource}`,
      });
      // (c) 채널·낭독자 인트로/아웃트로 고유 문구가 줄거리에 새어 들어가지 않았는지 (자동 부분 점검)
      const noiseLeak = TRANSCRIPT_NOISE_TOKENS.filter((tok) =>
        card.storyOutlineKo.toLowerCase().includes(tok.toLowerCase()),
      );
      transcriptResults.push({
        book: TRANSCRIPT_FIXTURE.label,
        check: "채널 인트로/아웃트로 노이즈가 줄거리에 안 섞임",
        pass: noiseLeak.length === 0,
        detail: noiseLeak.length === 0 ? "노이즈 문구 없음" : `새어 든 문구: ${noiseLeak.join(", ")}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcriptResults.push({
        book: TRANSCRIPT_FIXTURE.label,
        check: "낭독 자막 카드 생성 (재요청 포함 2회 실패)",
        pass: false,
        detail: message,
      });
    }
    printTable(transcriptResults);
    const transcriptFailed = transcriptResults.filter((r) => !r.pass);
    if (transcriptFailed.length > 0) {
      console.error(`FAIL — 낭독 자막 게이트 ${transcriptFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 낭독 자막 게이트 ${transcriptResults.length}개 항목 통과.`);
    return;
  }

  // 챕터화(§9) 실호출 게이트 — **EVAL_CHAPTERS=1일 때만** 실호출 1회. (오프라인 게이트가 위에서 이미
  // return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 실제 자막→챕터 1건이 (a) 모든 en이
  // 자막 부분문자열이고(grounding) (b) 채널 인트로/아웃트로 노이즈가 어느 챕터에도 안 섞였고 (c) matched
  // 챕터는 sentences가 있고 en/ko 1:1·ko가 우리말인지를 본다. 자막 밖 창작·번역 품질은 사람이 읽게 인쇄한다.
  if (process.env.EVAL_CHAPTERS === "1") {
    console.log("EVAL_CHAPTERS=1 — 챕터화 실호출 1회로 grounding·노이즈 제외를 점검합니다.");
    const chapterResults: CheckResult[] = [];
    const book = "챕터화 실호출";
    try {
      const { chapters, truncated, droppedSentenceCount } = await chapterizeTranscript(
        CHAPTERIZE_FIXTURE_TITLES,
        POOH_TRANSCRIPT,
      );
      console.log(
        `chapters (truncated=${truncated}, dropped=${droppedSentenceCount}):\n${JSON.stringify(chapters, null, 2)}`,
      );
      const transcriptTokens = tokenizeForGrounding(POOH_TRANSCRIPT);
      const allSentences = chapters.flatMap((c) => c.sentences);

      // (a) 모든 en이 자막에 실제로 있는가 — groundChapters가 이미 강제하지만 결과로 재확인한다
      const ungrounded = allSentences.filter((s) => !isGroundedInTranscript(s.en, transcriptTokens));
      chapterResults.push({
        book,
        check: "모든 en이 자막 부분문자열(자막 밖 창작 없음)",
        pass: ungrounded.length === 0,
        detail: ungrounded.length === 0 ? `문장 ${allSentences.length}개 전부 grounded` : `자막 밖 ${ungrounded.length}개: ${ungrounded.slice(0, 2).map((s) => s.en).join(" | ")}`,
      });

      // (b) 채널 인트로/아웃트로 노이즈가 어느 챕터에도 안 섞였는가
      const flat = allSentences.map((s) => `${s.en} ${s.ko}`).join(" ").toLowerCase();
      const noiseLeak = TRANSCRIPT_NOISE_TOKENS.filter((t) => flat.includes(t.toLowerCase()));
      chapterResults.push({
        book,
        check: "채널 인트로/아웃트로 노이즈가 챕터에 안 섞임",
        pass: noiseLeak.length === 0,
        detail: noiseLeak.length === 0 ? "노이즈 문구 없음" : `새어 든 문구: ${noiseLeak.join(", ")}`,
      });

      // (c) matched 챕터는 sentences가 있고 en/ko가 채워졌고 ko가 우리말인가
      const matchedBad = chapters.filter(
        (c) => c.matched && (c.sentences.length === 0 || c.sentences.some((s) => s.en.trim() === "" || !containsHangul(s.ko))),
      );
      chapterResults.push({
        book,
        check: "matched 챕터는 문장 채움·en/ko 1:1·ko 우리말",
        pass: matchedBad.length === 0,
        detail: matchedBad.length === 0 ? `matched 챕터 ${chapters.filter((c) => c.matched).length}개 정상` : `문제 챕터: ${matchedBad.map((c) => c.titleEn).join(", ")}`,
      });

      // titleEn은 목차 밖으로 벗어나지 않음
      const titleSet = new Set(CHAPTERIZE_FIXTURE_TITLES.map((t) => t.trim().toLowerCase()));
      const strayTitles = chapters.filter((c) => !titleSet.has(c.titleEn.trim().toLowerCase()));
      chapterResults.push({
        book,
        check: "titleEn이 준 목차 제목 안에 있음(챕터 창작 없음)",
        pass: strayTitles.length === 0,
        detail: strayTitles.length === 0 ? "목차 제목만 사용" : `목차 밖: ${strayTitles.map((c) => c.titleEn).join(", ")}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chapterResults.push({ book, check: "챕터화 (재요청 포함 2회 실패)", pass: false, detail: message });
    }
    printTable(chapterResults);
    const chapterFailed = chapterResults.filter((r) => !r.pass);
    if (chapterFailed.length > 0) {
      console.error(`FAIL — 챕터화 게이트 ${chapterFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 챕터화 게이트 ${chapterResults.length}개 항목 통과.`);
    return;
  }

  // 호출 D(보강) 텍스트 점검 — **EVAL_VOCAB=1일 때만** 실호출 1회. (오프라인 게이트가 위에서 이미
  // return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 정의가 한 문장인가·한글 안 섞였나·
  // 표제어를 정의에 그대로 안 썼나·이모지 0~1개인가를 실제 모델 출력으로 눈으로 확인한다(§8-4·계획 V3).
  // enrichVocab이 이미 zod로 이 규칙을 강제하므로, 여기서는 통과한 출력을 사람이 읽게 재확인·인쇄한다.
  if (process.env.EVAL_VOCAB === "1") {
    console.log("EVAL_VOCAB=1 — 호출 D(보강) 실호출 1회로 정의·해석·이모지 텍스트를 점검합니다.");
    const graphemeCount = (s: string): number => {
      try {
        let n = 0;
        for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) n++;
        return n;
      } catch {
        return Array.from(s).length;
      }
    };
    const hasHangul = (s: string): boolean => /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(s);
    const probeWord = (no: string, word: string, ko: string, definitionEn: string | null = null): VocabEntry => ({
      no,
      word,
      ipa: null,
      pos: ["명"],
      meanings: [{ no: null, ko, related: [] }],
      examples: [],
      related: [],
      definitionEn,
      definitionKo: null,
      imageEmoji: null,
      imageSvg: null,
      photoIndex: 0,
      confidence: "high",
      partial: false,
    });
    // 마지막 단어(gather)는 EN을 미리 채워 보낸다 — 해석 백필 경로: 모델은 EN을 번역만 하고 KO를 붙여야
    // 하며, EN을 바꾸면 안 된다(§8 정의 불변).
    const BACKFILL_EN = "To bring things together into one place.";
    const probeEntries: VocabEntry[] = [
      probeWord("0001", "apple", "사과"),
      probeWord("0002", "brave", "용감한"),
      probeWord("0003", "respect", "존경하다"),
      probeWord("0004", "moment", "순간"),
      probeWord("0005", "gather", "모으다", BACKFILL_EN),
    ];
    const vocabResults: CheckResult[] = [];
    try {
      const items: VocabEnrichItem[] = await enrichVocab(probeEntries);
      console.log("호출 D 출력:", JSON.stringify(items, null, 2));
      vocabResults.push({
        book: "호출 D 실호출",
        check: "요청한 단어 수만큼 정의를 돌려줌",
        pass: items.filter((it) => it.definitionEn !== null).length === probeEntries.length,
        detail: `정의 있는 항목=${items.filter((it) => it.definitionEn !== null).length}/${probeEntries.length}`,
      });
      for (const it of items) {
        const def = it.definitionEn;
        const sentences = def ? (def.match(/[.!?]+(?=\s|$)/gu) ?? []).length : 0;
        const koreanFree = def ? !hasHangul(def) : true;
        const noHeadword = def ? !new RegExp(`\\b${it.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu").test(def) : true;
        const emojiOk = it.imageEmoji === null || graphemeCount(it.imageEmoji) === 1;
        vocabResults.push({
          book: "호출 D 실호출",
          check: `${it.word}: EN 한 문장·한글 없음·표제어 미포함·이모지 0~1개`,
          pass: def !== null && sentences <= 1 && koreanFree && noHeadword && emojiOk,
          detail: `def=${JSON.stringify(def)} emoji=${it.imageEmoji} | 문장=${sentences} 한글없음=${koreanFree} 표제어미포함=${noHeadword} 이모지OK=${emojiOk}`,
        });
        // 해석(KO): 비어있지 않고·한국어이고·한 문장 정도(종결부호 2개 이하)이고·EN이 있을 때만 채워짐
        const ko = it.definitionKo;
        const koSentences = ko ? (ko.match(/[.!?]+(?=\s|$)/gu) ?? []).length : 0;
        vocabResults.push({
          book: "호출 D 실호출",
          check: `${it.word}: KO 해석 채움·한국어·한 문장`,
          pass: ko !== null && hasHangul(ko) && koSentences <= 1,
          detail: `ko=${JSON.stringify(ko)} | 한국어=${ko ? hasHangul(ko) : false} 문장=${koSentences}`,
        });
      }
      // 해석 백필: gather는 보낸 EN을 그대로 되돌리고(EN 미변경) KO만 붙여야 한다.
      const gather = items.find((it) => it.word.trim().toLowerCase() === "gather");
      vocabResults.push({
        book: "호출 D 실호출",
        check: "gather: 해석 백필 시 EN 미변경(번역만)",
        pass: gather !== undefined && gather.definitionEn === BACKFILL_EN && gather.definitionKo !== null && hasHangul(gather.definitionKo ?? ""),
        detail: `EN=${JSON.stringify(gather?.definitionEn)} (기대 ${JSON.stringify(BACKFILL_EN)}) · KO=${JSON.stringify(gather?.definitionKo)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vocabResults.push({ book: "호출 D 실호출", check: "호출 D (재요청 포함 2회 실패)", pass: false, detail: message });
    }
    printTable(vocabResults);
    const vocabFailed = vocabResults.filter((r) => !r.pass);
    if (vocabFailed.length > 0) {
      console.error(`FAIL — 호출 D ${vocabFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 호출 D 실호출 점검 ${vocabResults.length}개 항목 통과.`);
    return;
  }

  // 호출 G(단어 뜻 조회, §10) 텍스트 점검 — **EVAL_WORDMEANING=1일 때만** 실호출 1회. (오프라인
  // 게이트가 위에서 이미 return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 실제 단어·문장
  // 1건이 한글이 있고·짧고(WORD_MEANING_KO_MAX 이하)·영어 낱말이 이어지지 않는지를 모델 출력으로
  // 확인·인쇄한다. 맥락 반영(다의어 뜻 선택)은 사람이 눈으로 봐야 갈리므로 결과를 인쇄한다.
  if (process.env.EVAL_WORDMEANING === "1") {
    console.log("EVAL_WORDMEANING=1 — 호출 G(단어 뜻) 실호출 1회로 문맥 뜻을 점검합니다.");
    const wmResults: CheckResult[] = [];
    const probe = { word: "bellowed", sentence: "He bellowed in fear." };
    try {
      const out: WordMeaning = await lookupWordMeaning(probe.word, probe.sentence);
      console.log(`호출 G 출력: 단어="${probe.word}" 문장="${probe.sentence}" → ${JSON.stringify(out)}`);
      const ko = out.meaningKo;
      wmResults.push({
        book: "호출 G 실호출",
        check: `${probe.word}: 한글 있음·짧음(≤${WORD_MEANING_KO_MAX})·영어 낱말 안 이어짐`,
        pass: containsHangul(ko) && ko.trim().length <= WORD_MEANING_KO_MAX && longestEnglishRun(ko) < 2,
        detail: `meaningKo=${JSON.stringify(ko)} | 한글=${containsHangul(ko)} 길이=${ko.trim().length} 영어연속=${longestEnglishRun(ko)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      wmResults.push({ book: "호출 G 실호출", check: "호출 G (재요청 포함 2회 실패)", pass: false, detail: message });
    }
    printTable(wmResults);
    const wmFailed = wmResults.filter((r) => !r.pass);
    if (wmFailed.length > 0) {
      console.error(`FAIL — 호출 G ${wmFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 호출 G 실호출 점검 ${wmResults.length}개 항목 통과.`);
    return;
  }

  // 호출 I(자유대화 문장 설명, §12-5) 실호출 프로브 — **EVAL_TALK=1일 때만** 실호출 2회(선생님 문장 1 · 은우 문장 1).
  // (오프라인 게이트가 위에서 이미 return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 오케스트레이터가 사용자 동의 후 돌린다.
  // zod(선생님 문장 betterEn 금지·keyWords ⊂ 문장·ko/en 분리)는 explainTalkSentence가 이미 강제한다 — 여기서는 통과한 출력을
  // 사람이 읽게 인쇄하고(1학년 눈높이·다정한 말투·억지 교정 여부는 의미 판단이라 코드로 못 잡는다), 화자별 기대만 다시 확인한다.
  // 대화는 지어낸 영어다(은우의 실제 발화를 픽스처로 저장하지 않는다). 관문 R 실연결은 eval 밖(실기기·동의 후).
  if (process.env.EVAL_TALK === "1") {
    console.log("EVAL_TALK=1 — 호출 I(문장 설명) 실호출 2회로 선생님 문장·은우 문장 설명을 점검합니다.");
    const talkResults: CheckResult[] = [];
    const book = "호출 I 실호출";
    const probeTurns: TalkTurn[] = [
      { speaker: "teacher", text: "Hello! I am Sunny. Do you like animals?", interrupted: false, origin: "greeting" },
      { speaker: "child", text: "Yes. I like dog.", interrupted: false, origin: null },
      { speaker: "teacher", text: "Oh, you like dogs! Me too! What color is your favorite dog?", interrupted: false, origin: "reply" },
      { speaker: "child", text: "Brown. 갈색 강아지.", interrupted: false, origin: null },
    ];
    const probes: { turnIndex: number; sentenceIndex: number }[] = [
      { turnIndex: 2, sentenceIndex: 2 }, // 선생님: What color is your favorite dog?
      { turnIndex: 1, sentenceIndex: 1 }, // 은우: I like dog.
    ];
    for (const p of probes) {
      try {
        const out = await explainTalkSentence({ topicLabel: "동물", turns: probeTurns, ...p });
        console.log(`호출 I 출력 (${out.speaker}: "${out.sentence}"):\n${JSON.stringify(out, null, 2)}`);
        talkResults.push({
          book,
          check: `${out.speaker}: en 조각 ≥1·keyWords ⊂ 문장·${out.speaker === "teacher" ? "betterEn null" : "betterEn 영어 또는 null"}`,
          pass:
            out.script.some((s) => s.lang === "en") &&
            out.keyWords.every((k) => isKeyWordInSentence(k.en, out.sentence)) &&
            (out.speaker === "teacher" ? out.betterEn === null : out.betterEn === null || !/[가-힣]/.test(out.betterEn)),
          detail: `조각 ${out.script.length}개 · betterEn=${JSON.stringify(out.betterEn)} · keyWords=${out.keyWords.map((k) => k.en).join(",")}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        talkResults.push({ book, check: `turn ${p.turnIndex} sentence ${p.sentenceIndex} (재요청 포함 2회 실패)`, pass: false, detail: message });
      }
    }
    printTable(talkResults);
    const talkFailed = talkResults.filter((r) => !r.pass);
    if (talkFailed.length > 0) {
      console.error(`FAIL — 호출 I ${talkFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 호출 I 실호출 점검 ${talkResults.length}개 항목 통과.`);
    return;
  }

  if (USE_THIN_PAGES) {
    console.log("EVAL_THIN_PAGES=1 — 장면 메모 변형을 얇은 근거(4장면)로 돌립니다.");
  }
  const skipPages = process.env.EVAL_SKIP_PAGES === "1";
  const fixtures = skipPages ? FIXTURES.filter((f) => !f.sceneDigest) : FIXTURES;
  if (skipPages) console.log("EVAL_SKIP_PAGES=1 — 장면 메모 변형(실호출 1회)을 건너뜁니다.");

  for (const fixture of fixtures) {
    console.log(`\n=== 카드 생성: ${fixture.label} (${fixture.author}) ===`);
    try {
      const card = await generateCard(toCardInput(fixture));
      // 생성된 줄거리를 그대로 찍는다. 분량 점검은 '문장 수가 맞는지'만 볼 뿐이라,
      // 숫자를 맞춘 것과 실제로 맥락이 잡히는 글인지는 사람이 읽어야 갈린다 (부모가 볼 물건이다).
      // 이미 받아 온 응답을 출력할 뿐이라 실호출은 늘지 않는다.
      console.log(`storyOutlineKo (${card.storySource}):\n${card.storyOutlineKo}`);
      allResults.push(...runChecks(fixture, card));
    } catch (error) {
      // 생성 자체가 실패하면 해당 책의 전 항목을 실패로 기록하고 다음 책으로 진행
      const message = error instanceof Error ? error.message : String(error);
      allResults.push({
        book: fixture.label,
        check: "카드 생성 (재요청 포함 2회 실패)",
        pass: false,
        detail: message,
      });
    }
  }

  printTable(allResults);
  printSpecSyncDetails(specSyncOutcomes);

  const failed = allResults.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`FAIL — ${failed.length}개 항목 실패. 프롬프트/스키마를 점검하세요.`);
    process.exit(1);
  }
  console.log(`PASS — 전체 ${allResults.length}개 항목 통과.`);
}

main().catch((error) => {
  console.error("eval-english 실행 실패:", error);
  process.exit(1);
});

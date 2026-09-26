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
 * 자유대화(§12)는 오프라인 구간에서 프롬프트 원문 11개(§12-6 화면 카드 4개 포함, 조립 없는 block-exact)·호출 I JSON Schema와
 * §12-6 도구 정의(의미 동치)·지시문 조립·세션 설정(도구·tool_choice)·실시간 스크립트 리듀서·문장 나누기·호출 I zod·설명 낭독 대본·
 * 도구 호출 검사·말문 막힘 도움 상태 기계·주제 일러스트 장면·단어장 ✓ 매칭을 본다. 호출 I 실호출은 게이트 `EVAL_TALK=1`(2회)뿐이다.
 */

import { readFileSync } from "node:fs";
import { chapterizeTranscript, enrichVocab, explainTalkSentence, generateCard, lookupWordMeaning } from "../lib/ai/client";
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
  TALK_CARDS_INSTRUCTIONS,
  TALK_CARDS_INSTRUCTIONS_JOINER,
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
  TALK_WRAPUP_INSTRUCTIONS,
  buildTalkExplainUserMessage,
  buildTalkSceneImagePrompt,
  buildTalkSceneNote,
  fillTalkTemplate,
} from "../lib/ai/english/talk-prompts";
import {
  TALK_EXPLAIN_LIMITS,
  TALK_LIMITS,
  TALK_SENTENCE_EXPLANATION_JSON_SCHEMA,
  TALK_TOOLS,
  TALK_TOOL_CHOICE,
  buildTalkExplainZod,
  containsLatin as talkContainsLatin,
  isKeyWordInSentence,
  type TalkCard,
  type TalkSentenceExplanation,
  type TalkTopic,
  type TalkTurn,
} from "../lib/ai/english/talk-schemas";
import {
  TALK_CARD_LIMITS,
  TALK_CONTINUE_CHAIN_MAX,
  TALK_FALLBACK_HINTS,
  TALK_TOOL_NAMES,
  TALK_TOOL_OUTPUT,
  buildTalkToolOutputEvent,
  containsHangulText as talkCardsContainsHangul,
  decideTalkContinue,
  extractTalkFunctionCalls,
  matchTalkWord,
  parseTalkToolCall,
  sanitizeTalkCards,
  stepTalkContinue,
  summarizeTalkResponseDone,
  talkSpokeQuestion,
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
import {
  TALK_SAVE_KEEPALIVE_MAX_BYTES,
  planTalkSaveBody,
  talkSaveBodyBytes,
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
  splitTalkSentences,
  toTalkTurns,
  type TalkLine,
  type TalkTranscriptState,
} from "../lib/talk-transcript";
import { buildTalkExplainSpeakQueue } from "../lib/talk-explain-script";
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
// - §12-6 화면 카드: 도구 정의 의미 동치·장면 표·도구 호출 검사(항목 단위로 버림)·도움 상태 기계(시계는 인자)·장면 문장·✓ 매칭
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
  // 1. talk_sentence_explanation JSON Schema — 스펙 코드블록을 JSON으로 파싱해 deep-equal
  let specSchema: unknown;
  let specText = "";
  try {
    specText = readFileSync(ENGLISH_SPEC_URL, "utf-8");
    for (const b of extractSpecBlocks(ENGLISH_SPEC_URL)) {
      try {
        const parsed = JSON.parse(b.text) as { name?: unknown };
        if (parsed && typeof parsed === "object" && parsed.name === "talk_sentence_explanation") specSchema = parsed;
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
    ["max_output_tokens", `| \`max_output_tokens\` | ${TALK_REALTIME_MAX_OUTPUT_TOKENS} |`],
    ["속도 두 값", `천천히 ${TALK_SPEED_VALUES.slow}(기본) · 보통 ${TALK_SPEED_VALUES.normal.toFixed(1)}`],
    ["턴 감지", `\`{ type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true }\``],
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
  // §12-6 화면 카드 — 검사 폭·시간·보관 수·도구 선택·기본 문구·호출 결과·장면 앞머리·지시문 이음
  const C = TALK_CARD_LIMITS;
  tableFacts.push(
    ["카드 answers 폭", `\`answers\` ${C.answersMin}~${C.answersMax}개(각 ${C.answerMaxChars}자 이하·라틴 포함·한글 금지)`],
    ["카드 words 폭", `\`words\` 0~${C.wordsMax}개(\`emoji\` ${C.emojiMinChars}~${C.emojiMaxChars}자 비어 있지 않음, \`en\` 라틴 ${C.enMaxChars}자 이하, \`ko\` 한글 ${C.koMaxChars}자 이하)`],
    ["도움 카드 5초", `**${TALK_HINT_SHOW_AFTER_MS / 1000}초** 동안 은우 발화`],
    ["도움 요청 12초", `**${TALK_HINT_NUDGE_AFTER_MS / 1000}초** 동안 계속 조용하면`],
    ["도움 요청 연속 상한", `도움 요청(12초 자동·🙋 합산)은 **연속 ${TALK_HINT_NUDGE_STREAK_MAX}번**까지다`],
    ["이어 말하기 연속 상한", `(\`lib/talk-cards.ts\` \`TALK_CONTINUE_CHAIN_MAX\`): 이어 말하기는 **연속 ${TALK_CONTINUE_CHAIN_MAX}회**까지다`],
    ["기록 카드 30장", `보인 카드를 최대 ${C.savedCardsMax}장 남긴다`],
    ["저장 모델 cards 30", `\`cards: {emoji, en, ko}[]\`(최대 ${TALK_LIMITS.cards})`],
    ["칩 6장", `최근 ${C.recentChips}장까지`],
    ["tool_choice", `\`tool_choice: "${String(TALK_TOOL_CHOICE)}"\``],
    ["기본 문구 4개", TALK_FALLBACK_HINTS.map((h) => `\`${h.en}\``).join("·")],
    ["호출 결과 글", `output: ${JSON.stringify(TALK_TOOL_OUTPUT)}`],
    ["직접 입력 장면", `\`${TALK_SCENE_CUSTOM_PREFIX}{주제}\``],
    ["단어장 장면", `\`${TALK_SCENE_WORDS_PREFIX}{앞 ${TALK_SCENE_VOCAB_WORDS}개 단어를 "${TALK_SCENE_WORDS_JOINER}"로}\``],
    ["지시문 이음", `(\`{lesson}\` 치환) + \`${JSON.stringify(TALK_CARDS_INSTRUCTIONS_JOINER)}\` + 이 블록`],
  );
  for (const [name, needle] of tableFacts) add(`§12 값 == 코드: ${name}`, specText.includes(needle), needle);
  add("대화 상한 5분 == TALK_MAX_DURATION_SEC", TALK_MAX_DURATION_SEC === 300 && TALK_LIMITS.maxDurationSec === TALK_MAX_DURATION_SEC, String(TALK_MAX_DURATION_SEC));
  add("기록 카드 상한은 한 곳(TALK_LIMITS.cards = TALK_CARD_LIMITS.savedCardsMax)", TALK_LIMITS.cards === TALK_CARD_LIMITS.savedCardsMax);

  // 4. §12-6 도구 정의 — 스펙 JSON 배열 블록을 파싱해 의미 동치
  let specTools: unknown;
  for (const b of extractSpecBlocks(ENGLISH_SPEC_URL)) {
    try {
      const parsed: unknown = JSON.parse(b.text);
      if (Array.isArray(parsed) && parsed.some((t) => (t as { name?: unknown })?.name === TALK_TOOL_NAMES.hints)) specTools = parsed;
    } catch {
      // JSON 아닌 블록은 건너뛴다
    }
  }
  add(
    "TALK_TOOLS ↔ §12-6 도구 정의 의미 동치",
    specTools !== undefined && talkDeepEqual(specTools, TALK_TOOLS),
    specTools === undefined ? "스펙에서 도구 정의 블록을 찾지 못함" : "",
  );
  const mutated = JSON.parse(JSON.stringify(TALK_TOOLS)) as { parameters: { required: string[] } }[];
  mutated[0].parameters.required = ["words", "answers"];
  add("도구 의미 동치 비교기가 실제로 작동(required 순서만 바꿔도 불일치)", specTools !== undefined && !talkDeepEqual(specTools, mutated));
  add(
    "도구 이름 = TALK_TOOL_NAMES(show_hints·show_picture)",
    TALK_TOOLS.map((t) => t.name).join(",") === `${TALK_TOOL_NAMES.hints},${TALK_TOOL_NAMES.picture}`,
    TALK_TOOLS.map((t) => t.name).join(","),
  );
  add("도구 JSON에 개수·길이 키 없음(검사는 parseTalkToolCall)", !/minItems|maxItems|maxLength|minLength/.test(JSON.stringify(TALK_TOOLS)));

  // spec-sync block-exact — 두 블록을 이어 붙인 상수는 조립 규칙("block")으로는 통과하지만 block-exact는 거부한다(QA talk-ai P2-4)
  const glued = `${TALK_TEACHER_INSTRUCTIONS}\n\n${TALK_CARDS_INSTRUCTIONS}`;
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
      "지시문 = 템플릿 앞부분 + 수업 블록 + 뒷부분 + \"\\n\\n\" + 화면 카드 덧붙임(치환은 {lesson} 한 자리)",
      ins === `${before}${lesson}${after}\n\n${TALK_CARDS_INSTRUCTIONS}`,
    );
    add("화면 카드 덧붙임은 지시문 맨 끝에 한 번", ins.endsWith(`\n\n${TALK_CARDS_INSTRUCTIONS}`) && ins.split("# Screen cards").length === 2);
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
        { en: "apple", ko: "사과" },
        { en: "brave", ko: "두려워하지 않는" },
        { en: "gather", ko: null },
        { en: "rain bow", ko: "무지개" },
        { en: "moon", ko: "밤하늘의 달" },
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
  add("넘길 단어 0개 → null(라우트 400)", resolveVocabTalkTopic({ id: "vb_e", titleKo: "빈 책", entries: [entry(" ", "뜻")] }) === null);

  // 아이 이름은 AI에 보내지 않는다 — 어떤 지시문에도 "은우"가 없다
  const allIns = [
    ...TALK_TOPIC_PRESETS.map((p) => buildTalkInstructions(resolvePresetTalkTopic(p.key) as TalkTopic)),
    book ? buildTalkInstructions(book) : "",
    TALK_GREETING_INSTRUCTIONS,
    TALK_WRAPUP_INSTRUCTIONS,
    TALK_EXPLAIN_SYSTEM_PROMPT,
    TALK_CARDS_INSTRUCTIONS,
    TALK_NUDGE_NOTE,
    TALK_SCENE_NOTE,
    TALK_SCENE_IMAGE_PROMPT,
    JSON.stringify(TALK_TOOLS),
  ];
  add("지시문·인사·마무리·도움 요청·장면·도구·호출 I 프롬프트에 아이 이름 없음", allIns.every((s) => !s.includes("은우")));
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
      "전사: 모델만 — language·prompt 지정 없음(무유도)",
      JSON.stringify(Object.keys(c.audio?.input?.transcription ?? {})) === '["model"]',
      JSON.stringify(c.audio?.input?.transcription),
    );
    add(
      "턴 감지: semantic_vad · eagerness low · 응답 생성·끼어들기 허용",
      talkDeepEqual(c.audio?.input?.turn_detection, { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true }),
      JSON.stringify(c.audio?.input?.turn_detection),
    );
    add("소음 억제 far_field", c.audio?.input?.noise_reduction?.type === "far_field");
    add("표에 없는 필드(tracing·truncation·include·prompt) 없음", !["tracing", "truncation", "include", "prompt"].some((k) => k in c), Object.keys(c).join(","));
    add(
      "최상위 키 = §12-1 표 + §12-6 도구(type·model·instructions·output_modalities·max_output_tokens·audio·reasoning·tools·tool_choice)",
      Object.keys(c).sort().join(",") === ["audio", "instructions", "max_output_tokens", "model", "output_modalities", "reasoning", "tool_choice", "tools", "type"].join(","),
      Object.keys(c).sort().join(","),
    );
    add("§12-6 도구: tools = TALK_TOOLS(show_hints·show_picture)", talkDeepEqual(c.tools, TALK_TOOLS), (c.tools ?? []).map((t) => ("name" in t ? t.name : "?")).join(","));
    add("§12-6 도구 선택: tool_choice auto", c.tool_choice === "auto");
    add("§12-6 지시문 덧붙임: instructions 끝이 \"\\n\\n\" + TALK_CARDS_INSTRUCTIONS", typeof c.instructions === "string" && c.instructions.endsWith(`\n\n${TALK_CARDS_INSTRUCTIONS}`));
    add("세션마다 도구 배열은 새 배열(공유 상수를 내주지 않음)", c.tools !== TALK_TOOLS && buildTalkSessionConfig({ topic, speed: "slow" }).tools !== c.tools);
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
  add("진행 중 선생님 줄(글자 전)은 보임", isVisibleTalkLine({ itemId: "x", speaker: "teacher", text: "", status: "partial", filtered: false }));

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
    "toTalkTurns: empty·failed·글자 없는 줄 제외, {speaker,text,interrupted}",
    JSON.stringify(turns) ===
      JSON.stringify([
        { speaker: "teacher", text: "Hello! I am Sunny. Do you like dogs?", interrupted: false },
        { speaker: "child", text: "Yes, I like dogs.", interrupted: false },
        { speaker: "teacher", text: "Great! Dogs are fun. What color is your dog?", interrupted: false },
      ]),
    JSON.stringify(turns),
  );
  add("childTurnCount = 은우 턴 수", childTurnCount(turns) === 1 && childTurnCount([]) === 0);
  const cutTurns = toTalkTurns(cutA.lines);
  add("끊긴 선생님 턴은 interrupted:true로 저장, 글자 없는 listening 줄은 제외", cutTurns.length === 1 && cutTurns[0].interrupted === true, JSON.stringify(cutTurns));
  const partialLine: TalkLine = { itemId: "item_c17", speaker: "child", text: "  My dog is ", status: "partial", filtered: false };
  add("세션이 끝날 때 partial 은우 글자는 trim해서 남긴다", toTalkTurns([partialLine])[0]?.text === "My dog is");
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
    { speaker: "teacher", text: "Hello! Do you like dogs?", interrupted: false },
    { speaker: "child", text: "Yes.", interrupted: false },
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

/** §12-6 도구 호출 검사(parseTalkToolCall)·카드 보관·기본 문구·단어장 ✓ 매칭·이벤트 도우미 */
function runTalkCardChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = talkAdder(results, "자유대화 카드");
  const C = TALK_CARD_LIMITS;
  const H = TALK_TOOL_NAMES.hints;
  const P = TALK_TOOL_NAMES.picture;
  const apple: TalkCard = { emoji: "🍎", en: "apple", ko: "사과" };
  const hintsOf = (args: unknown) => {
    const r = parseTalkToolCall(H, JSON.stringify(args));
    return r && r.name === H ? r.hints : null;
  };

  // 정상
  const ok = hintsOf({ answers: ["I like apples.", "It is red."], words: [apple, { emoji: "🍌", en: "banana", ko: "바나나" }] });
  add("show_hints 정상 → 답 2개·단어 2개 그대로", JSON.stringify(ok) === JSON.stringify({ answers: ["I like apples.", "It is red."], words: [apple, { emoji: "🍌", en: "banana", ko: "바나나" }] }), JSON.stringify(ok));
  const pic = parseTalkToolCall(P, JSON.stringify(apple));
  add("show_picture 정상 → 카드 한 장", pic !== null && pic.name === P && JSON.stringify(pic.card) === JSON.stringify(apple), JSON.stringify(pic));

  // 그 항목만 버림
  const mixed = hintsOf({ answers: ["I like 사과.", "It is red.", "  ", 42], words: [] });
  add("한글 섞인 답·빈 답·문자열 아닌 답은 그 항목만 버림", JSON.stringify(mixed?.answers) === '["It is red."]', JSON.stringify(mixed));
  const exact = "a".repeat(C.answerMaxChars - 1) + ".";
  const longAns = hintsOf({ answers: [`${"b".repeat(C.answerMaxChars)}!`, exact], words: [] });
  add(`답 ${C.answerMaxChars + 1}자는 버리고 ${C.answerMaxChars}자는 남김`, JSON.stringify(longAns?.answers) === JSON.stringify([exact]), JSON.stringify(longAns?.answers.map((a) => a.length)));
  const many = hintsOf({ answers: ["Yes.", "yes.", "No.", "Maybe.", "I do."], words: [] });
  add(`답은 같은 문장 되풀이를 하나로, 앞 ${C.answersMax}개까지`, JSON.stringify(many?.answers) === '["Yes.","No.","Maybe."]', JSON.stringify(many?.answers));
  const noLatin = hintsOf({ answers: ["123!", "좋아요"], words: [apple] });
  add("남는 답이 없으면 null(단어만 있어도 — 답 예시가 도움 카드의 본체)", noLatin === null);
  const words = hintsOf({
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
  });
  add(
    "잘못된 단어(빈·가짜 이모지·긴 값·한글 en·한글 없는 ko·칸 누락)는 그 항목만 버리고, 되풀이 하나로, 앞 3개",
    JSON.stringify(words?.words.map((w) => w.en)) === '["apple","family","three"]',
    JSON.stringify(words?.words.map((w) => w.en)),
  );
  // 도형·기호 블록(QA cards P2-1) — "색깔과 모양"에서 모델이 텍스트 기호를 줘도 그림 카드가 살아남는다. 글자·숫자만이면 여전히 거부.
  const shapeOf = (emoji: string) => parseTalkToolCall(P, JSON.stringify({ emoji, en: "shape", ko: "모양" }));
  const shapeKept = ["▲", "●", "■", "◆", "△", "○", "□", "☆", "◯", "▭", "⬟", "⬢", "✦", "▲●■", "🔺", "⭐", "★", "🔵", "🟥"];
  const shapeLost = shapeKept.filter((s) => { const r = shapeOf(s); return !(r && r.name === P && r.card.emoji === s); });
  add("도형·기호 블록(▲●■◆△○□☆⬟⬢✦)도 이모지 칸 통과 — 이모지(🔺⭐★🔵🟥)와 함께", shapeLost.length === 0, shapeLost.length ? `버려짐: ${shapeLost.join(" ")}` : `${shapeKept.length}개 통과`);
  const shapeHints = hintsOf({ answers: ["It is a triangle."], words: [{ emoji: "▲", en: "triangle", ko: "세모" }, { emoji: "●", en: "circle", ko: "동그라미" }] });
  add("show_hints 단어의 도형 기호도 그 단어를 살림", JSON.stringify(shapeHints?.words.map((w) => w.en)) === '["triangle","circle"]', JSON.stringify(shapeHints?.words));
  // 글자형 기호(Ⓐ ① ㉠ ❶ ➓)·숫자·한자·ASCII 기호만 → 그림 아님. 도형 + 라틴/한글 → 라틴·한글 금지로 거부.
  const letterish = ["1", "12", "0", "#", "*", "Ⓐ", "①", "㉠", "❶", "➓", "三", "▲A", "●빨강", "◆ red", "▲:circle:"];
  const letterishKept = letterish.filter((s) => shapeOf(s) !== null);
  add("글자·숫자만(동그라미 숫자·글자 포함)이거나 도형에 라틴·한글이 섞인 이모지 칸은 여전히 거부", letterishKept.length === 0, letterishKept.length ? `통과해 버림: ${letterishKept.join(" ")}` : `${letterish.length}개 거부`);
  add("show_hints에 words가 없거나 배열이 아니어도 답만으로 통과",JSON.stringify(hintsOf({ answers: ["Yes!"] })) === '{"answers":["Yes!"],"words":[]}' && hintsOf({ answers: ["Yes!"], words: "x" })?.words.length === 0);
  add("show_picture 빈 이모지 → null", parseTalkToolCall(P, JSON.stringify({ ...apple, emoji: " " })) === null);
  add("show_picture 긴 영어 → null", parseTalkToolCall(P, JSON.stringify({ ...apple, en: "a".repeat(C.enMaxChars + 1) })) === null);
  add("show_picture 한글 영어 칸 → null", parseTalkToolCall(P, JSON.stringify({ ...apple, en: "사과" })) === null);
  add("값 앞뒤 공백·줄바꿈은 정리", JSON.stringify(parseTalkToolCall(P, JSON.stringify({ emoji: " 🍎 ", en: " red\napple ", ko: " 빨간 사과 " }))) === JSON.stringify({ name: P, card: { emoji: "🍎", en: "red apple", ko: "빨간 사과" } }));
  add("모르는 도구 이름 → null", parseTalkToolCall("show_video", JSON.stringify(apple)) === null && parseTalkToolCall(undefined, "{}") === null);
  add("인자가 JSON이 아니거나 객체가 아니면 null", parseTalkToolCall(P, "{not json") === null && parseTalkToolCall(H, "[1,2]") === null && parseTalkToolCall(H, null) === null);

  // 기록 카드 — 검사·되풀이·30장
  const saved = sanitizeTalkCards([
    apple,
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

  // 이벤트 도우미 — function_call 꺼내기·응답 끝 요약·호출 결과·숨은 system 메시지·response.create
  const fcItem = { type: "function_call" as const, id: "item_fc1", call_id: "call_1", name: H, arguments: '{"answers":["Yes!"],"words":[]}' };
  const outputDone: RealtimeServerEvent = { type: "response.output_item.done", event_id: "e1", response_id: "resp_1", output_index: 1, item: fcItem };
  const refs = extractTalkFunctionCalls(outputDone);
  add("response.output_item.done의 function_call → 호출 1개(callId·name·arguments·responseId)", refs.length === 1 && refs[0].callId === "call_1" && refs[0].name === H && refs[0].responseId === "resp_1" && parseTalkToolCall(refs[0].name, refs[0].argumentsJson) !== null);
  const msgItem = { type: "message" as const, role: "assistant" as const, id: "item_m1", content: [] };
  const doneWith = (status: "completed" | "cancelled", output: unknown[]): RealtimeServerEvent =>
    ({ type: "response.done", event_id: "e2", response: { id: "resp_2", object: "realtime.response", status, output } }) as RealtimeServerEvent;
  // 이어 말하기(§12-6 — 2026-09-26 실연결 정정): 도구 + 정상 완료 + **말한 글자에 질문 없음**(오디오 없음 포함) → 이어 말하기 후보.
  // 말한 글자 = response.done output의 assistant 메시지 content 오디오 전사(SDK GA RealtimeConversationItemAssistantMessage.Content.transcript)
  const spoke = (id: string, transcript: string | null, type: "output_audio" | "output_text" = "output_audio") => ({
    type: "message" as const,
    role: "assistant" as const,
    id,
    content: transcript === null ? [] : [type === "output_audio" ? { type, transcript } : { type, text: transcript }],
  });
  const toolOnlyEv = doneWith("completed", [fcItem, { ...fcItem, call_id: "call_2", name: P }]);
  const statementToolEv = doneWith("completed", [spoke("item_s1", "Nice, that is a lovely choice."), fcItem]);
  const questionToolEv = doneWith("completed", [spoke("item_q1", "Great! Do you like apples?"), fcItem]);
  const toolOnly = summarizeTalkResponseDone(toolOnlyEv);
  add("오디오 없이 도구만 부르고 끝난 응답 → 이어 말하기 후보(말한 글자 \"\")", toolOnly !== null && toolOnly.functionCalls.length === 2 && !toolOnly.hadAudio && toolOnly.spokenText === "" && toolOnly.shouldContinue);
  const statementTool = summarizeTalkResponseDone(statementToolEv);
  add(
    "질문 없는 오디오 + 도구 → 이어 말하기 후보(말만 하다 도구로 끝난 응답)",
    statementTool !== null && statementTool.hadAudio && statementTool.spokenText === "Nice, that is a lovely choice." && !statementTool.askedQuestion && statementTool.shouldContinue,
    JSON.stringify(statementTool && { spokenText: statementTool.spokenText, shouldContinue: statementTool.shouldContinue }),
  );
  const questionTool = summarizeTalkResponseDone(questionToolEv);
  add("질문 있는 오디오 + 도구 → 이어 말하지 않음(은우 차례)", questionTool !== null && questionTool.hadAudio && questionTool.askedQuestion && !questionTool.shouldContinue);
  // QA 5 P2-A — 빈 전사("")·공백은 글자가 아니다: 대체 조회(리듀서가 모은 선생님 줄)로 넘어가야 한다.
  const emptyTranscriptEv = doneWith("completed", [spoke("item_e1", ""), fcItem]);
  const viaFallback = summarizeTalkResponseDone(emptyTranscriptEv, (id) => (id === "item_e1" ? "Great! Do you like apples?" : null));
  add("빈 전사 + 대체 조회에 질문 → 이어 말하지 않음(빈 문자열을 글자로 받지 않음)", viaFallback !== null && viaFallback.askedQuestion && !viaFallback.shouldContinue, JSON.stringify(viaFallback && { spokenText: viaFallback.spokenText, shouldContinue: viaFallback.shouldContinue }));
  const blankNoFallback = summarizeTalkResponseDone(doneWith("completed", [spoke("item_e2", "   "), fcItem]));
  add("공백 전사 + 대체 조회 없음 → 말한 글자를 모름 → 이어 말하지 않음", blankNoFallback !== null && !blankNoFallback.shouldContinue, JSON.stringify(blankNoFallback && { spokenText: blankNoFallback.spokenText, shouldContinue: blankNoFallback.shouldContinue }));
  const fullWidthQ = summarizeTalkResponseDone(doneWith("completed", [spoke("item_q2", "Do you like apples？"), fcItem]));
  add("전각 물음표 ？도 질문 → 이어 말하지 않음", fullWidthQ !== null && fullWidthQ.askedQuestion && !fullWidthQ.shouldContinue);
  const twoMsgs = summarizeTalkResponseDone(doneWith("completed", [spoke("item_a", "Nice."), fcItem, spoke("item_b", "What color is it?")]));
  add("메시지가 둘이면 글자를 이어 본다(뒤 메시지의 질문도 질문)", twoMsgs !== null && twoMsgs.spokenText === "Nice. What color is it?" && twoMsgs.askedQuestion && !twoMsgs.shouldContinue, String(twoMsgs?.spokenText));
  const textMode = summarizeTalkResponseDone(doneWith("completed", [spoke("item_t", "Is it red?", "output_text"), fcItem]));
  add("글자 모드(output_text의 text)도 말한 글자로 본다", textMode !== null && textMode.spokenText === "Is it red?" && !textMode.shouldContinue);
  const noTool = summarizeTalkResponseDone(doneWith("completed", [spoke("item_s2", "Good job.")]));
  add("질문 없는 오디오라도 도구가 없으면 이어 말하지 않음(도구를 부른 응답만)", noTool !== null && !noTool.askedQuestion && !noTool.shouldContinue);
  const withAudio = summarizeTalkResponseDone(doneWith("completed", [msgItem, fcItem]));
  add("오디오는 있는데 전사가 없고 대체 조회도 없음 → 글자 모름(null) → 이어 말하지 않음(질문했을지 모른다)", withAudio !== null && withAudio.hadAudio && withAudio.spokenText === null && !withAudio.shouldContinue && withAudio.functionCalls.length === 1);
  const viaFallbackStatement = summarizeTalkResponseDone(doneWith("completed", [msgItem, fcItem]), (id) => (id === "item_m1" ? "Let's keep going." : null));
  const viaFallbackQuestion = summarizeTalkResponseDone(doneWith("completed", [msgItem, fcItem]), (id) => (id === "item_m1" ? "What do you see?" : null));
  add(
    "전사가 없으면 대체 조회(스크립트 선생님 줄)로 본다 — 질문 없음 → 이어 말하기 · 질문 → 없음",
    viaFallbackStatement?.spokenText === "Let's keep going." && viaFallbackStatement.shouldContinue === true && viaFallbackQuestion?.askedQuestion === true && viaFallbackQuestion.shouldContinue === false,
  );
  const cancelled = summarizeTalkResponseDone(doneWith("cancelled", [fcItem]));
  const cancelledStatement = summarizeTalkResponseDone(doneWith("cancelled", [spoke("item_s3", "Nice."), fcItem]));
  add("끊긴 응답 → 이어 말하게 하지 않음(오디오 유무 무관)", cancelled !== null && !cancelled.shouldContinue && cancelledStatement !== null && !cancelledStatement.shouldContinue);
  add("질문 판정: ? · ？ 만(마침표·느낌표는 질문 아님)", talkSpokeQuestion("Why?") && talkSpokeQuestion("なに？") && !talkSpokeQuestion("Let's go!") && !talkSpokeQuestion("Nice."));

  // 연속 상한 — stepTalkContinue(앱 컨트롤러가 이벤트마다 부르는 한 곳). 은우 발화(speech_started)로만 0, 오디오 응답으로는 되돌리지 않는다
  const runContinue = (events: RealtimeServerEvent[], live = true, start = 0) => {
    let chain = start;
    const sends: boolean[] = [];
    for (const ev of events) {
      const r = stepTalkContinue(chain, ev, live);
      chain = r.chain;
      if (r.summary) sends.push(r.send);
    }
    return { chain, sends: sends.map((b) => (b ? "T" : "F")).join("") };
  };
  add(`이어 말하기 연속 상한 = ${TALK_CONTINUE_CHAIN_MAX}`, TALK_CONTINUE_CHAIN_MAX === 2);
  const c1 = runContinue([statementToolEv]);
  add("step: 질문 없는 오디오 + 도구 → 보냄(셈 1)", c1.sends === "T" && c1.chain === 1, JSON.stringify(c1));
  const c2 = runContinue([questionToolEv]);
  add("step: 질문 있는 오디오 + 도구 → 보내지 않음(셈 0)", c2.sends === "F" && c2.chain === 0, JSON.stringify(c2));
  const c3 = runContinue([toolOnlyEv]);
  add("step: 오디오 없음 + 도구 → 보냄", c3.sends === "T" && c3.chain === 1, JSON.stringify(c3));
  const c4 = runContinue([statementToolEv, toolOnlyEv, statementToolEv, statementToolEv]);
  add(`step: 연속 ${TALK_CONTINUE_CHAIN_MAX}번 뒤에는 보내지 않음(질문 없는 응답이 계속돼도)`, c4.sends === "TTFF" && c4.chain === TALK_CONTINUE_CHAIN_MAX, JSON.stringify(c4));
  const c5 = runContinue([statementToolEv, statementToolEv, statementToolEv, talkEv.speechStarted("item_c9"), statementToolEv, statementToolEv, statementToolEv]);
  add("step: 은우 발화(speech_started) 뒤 다시 연속 2번까지 허용", c5.sends === "TTFTTF" && c5.chain === TALK_CONTINUE_CHAIN_MAX, JSON.stringify(c5));
  const noToolEv = doneWith("completed", [spoke("item_s4", "Good job.")]);
  const c6 = runContinue([statementToolEv, statementToolEv, questionToolEv, noToolEv, statementToolEv]);
  add("step: 오디오가 있던 응답(질문·도구 없음)으로는 셈이 0으로 돌아가지 않음 → 상한 뒤 여전히 없음", c6.sends === "TTFFF" && c6.chain === TALK_CONTINUE_CHAIN_MAX, JSON.stringify(c6));
  const c7 = runContinue([statementToolEv, toolOnlyEv], false, 1);
  add("step: 마무리 중(live 아님) → 보내지 않음·셈 그대로", c7.sends === "FF" && c7.chain === 1, JSON.stringify(c7));
  const c8 = runContinue([outputDone, { type: "response.created", event_id: "e7", response: { id: "resp_9", object: "realtime.response", status: "in_progress", output: [] } }, talkEv.speechStarted("item_c8")], true, 2);
  add("step: 그 밖의 이벤트는 셈을 바꾸지 않고, 은우 발화만 0으로", c8.chain === 0 && runContinue([outputDone], true, 2).chain === 2 && c8.sends === "");
  add(
    "decideTalkContinue: 상한 바로 아래는 보내고 상한에서는 보내지 않음",
    decideTalkContinue(TALK_CONTINUE_CHAIN_MAX - 1, statementTool!, true).send && decideTalkContinue(TALK_CONTINUE_CHAIN_MAX - 1, statementTool!, true).chain === TALK_CONTINUE_CHAIN_MAX && !decideTalkContinue(TALK_CONTINUE_CHAIN_MAX, statementTool!, true).send,
  );
  add("response.done이 아니면 요약 null, function_call 없으면 []", summarizeTalkResponseDone(outputDone) === null && extractTalkFunctionCalls({ type: "response.output_item.done", item: msgItem }).length === 0 && extractTalkFunctionCalls(null).length === 0);
  const outEv = buildTalkToolOutputEvent("call_1", `${TALK_HIDDEN_ITEM_PREFIX}out_1`);
  add(
    "호출 결과 항목 = function_call_output {shown:true}, id app_",
    JSON.stringify(outEv) === JSON.stringify({ type: "conversation.item.create", item: { id: "app_out_1", type: "function_call_output", call_id: "call_1", output: '{"shown":true}' } }),
    JSON.stringify(outEv),
  );
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
    throws(() => buildTalkSystemNoteEvent("greet", "x")) && throws(() => buildTalkToolOutputEvent("call_1", "item_1")) && throws(() => buildTalkSystemNoteEvent(`app_${"x".repeat(29)}`, "x")) && !throws(() => buildTalkSystemNoteEvent(`app_${"x".repeat(28)}`, "x")),
  );
  const echoed = reduceTalkTranscriptEvents([
    { type: "conversation.item.added", event_id: "e3", previous_item_id: null, item: noteEv.item },
    { type: "conversation.item.added", event_id: "e4", previous_item_id: noteEv.item.id, item: outEv.item },
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
  // (a) 도움 도착은 셈을 되돌리지 않는다 — 실제 대화에선 선생님이 질문마다 show_hints를 부르므로(TALK_CARDS_INSTRUCTIONS)
  //     "도움 도착 = 셈 0"이면 상한이 사실상 꺼진다. 도움은 선생님 말하는 중에 온다(질문과 같은 응답).
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

  // 선생님 재개 시 이전 도움을 버린다 / 도구만 먼저 부른 응답의 도움은 살린다
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
  // 요청 응답이 도구(show_hints)를 먼저 부르고 말하면 — 카드는 접되 그 새 도움은 살아서, 선생님이 멈추고 5초 뒤 뜬다
  const nudgeTool = run([e.hints(2000 + NUDGE + 800, h2), e.tStart(2000 + NUDGE + 1500)], nudged);
  const nudgeToolShown = viewTalkHints(run([e.tStop(2000 + NUDGE + 4000), e.tick(2000 + NUDGE + 4000 + SHOW)], nudgeTool));
  add(
    "12초 요청 응답이 도구를 먼저 부르고 말하면 카드는 접고 새 도움은 살림",
    !nudgeTool.visible && nudgeTool.hints?.value.answers[0] === "It is red." && nudgeToolShown.visible && nudgeToolShown.hints?.answers[0].en === "It is red.",
    JSON.stringify(nudgeToolShown.hints),
  );
  const toolFirst = run([e.tStart(0), e.tStop(2000), e.cStart(3000), e.cStop(4000), e.hints(4500, h2), e.tStart(5000), e.tStop(7000), e.tick(7000 + SHOW)]);
  add(
    "도구만 먼저 부르고 이어 질문한 차례의 도움은 살아남음",
    viewTalkHints(toolFirst).hints?.source === "teacher" && viewTalkHints(toolFirst).hints?.answers[0].en === "It is red.",
    JSON.stringify(viewTalkHints(toolFirst).hints),
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
    turns: texts.map((text, i) => ({ speaker: i % 2 ? "child" : "teacher", text, interrupted: false })),
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
    ...runTalkSaveBodyChecks(),
    ...runTalkSceneChecks(),
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
  // §12-6 화면 카드 — 지시문 덧붙임·도움 요청·일러스트 안내·사진 프롬프트
  {
    constName: "TALK_CARDS_INSTRUCTIONS",
    source: "lib/ai/english/talk-prompts.ts",
    specLabel: "§12-6 지시문 덧붙임(화면 카드)",
    text: TALK_CARDS_INSTRUCTIONS,
    mode: "block-exact",
  },
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
  // 프롬프트 원문이 스펙 문서와 같은지 — 파일을 읽어서 대조한다 (실호출 0회)
  allResults.push(...runSpecSyncChecks());

  // 실호출 없이 정적 검증만 하고 끝낸다 — OPENAI_API_KEY가 없거나 비용을 쓰기 전에
  // 다이얼 동기화만 확인할 때 쓴다. 통과해도 "카드 품질 통과"가 아니라 "정의 동기화 통과"다.
  if (process.env.EVAL_OFFLINE_ONLY === "1") {
    printTable(allResults);
    printSpecSyncDetails(specSyncOutcomes);
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
      { speaker: "teacher", text: "Hello! I am Sunny. Do you like animals?", interrupted: false },
      { speaker: "child", text: "Yes. I like dog.", interrupted: false },
      { speaker: "teacher", text: "Oh, you like dogs! Me too! What color is your favorite dog?", interrupted: false },
      { speaker: "child", text: "Brown. 갈색 강아지.", interrupted: false },
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

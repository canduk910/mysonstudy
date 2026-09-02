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
 */

import { chapterizeTranscript, enrichVocab, generateCard, lookupWordMeaning } from "../lib/ai/client";
import {
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
  containsHangul,
  countKoreanSentences,
  groundChapters,
  isGroundedInTranscript,
  longestEnglishRun,
  makeChapterizationSchema,
  makeLearningCardSchema,
  makePageDigestSchema,
  resolveAllowedStorySource,
  resolveChapterTitles,
  resolveStorySource,
  storyOutlineSentenceRange,
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
import {
  checkSpecSync,
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

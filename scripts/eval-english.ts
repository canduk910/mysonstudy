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

import { enrichVocab, generateCard } from "../lib/ai/client";
import {
  ENGLISH_RUN_LIMIT,
  MAX_SCENE_DIGEST_ITEMS,
  SCENE_ASK_KO_MAX,
  SCENE_LABEL_KO_MAX,
  SCENE_SUMMARY_KO_MAX,
  SIGHT_WORD_SET,
  STORY_OUTLINE_MAX_SENTENCES,
  STORY_OUTLINE_MIN_SENTENCES,
  STORY_SOURCE_RANK,
  countKoreanSentences,
  longestEnglishRun,
  makeLearningCardSchema,
  makePageDigestSchema,
  resolveAllowedStorySource,
  resolveStorySource,
  storyOutlineSentenceRange,
  type LearningCard,
  type SceneDigestItem,
} from "../lib/ai/english/schemas";
import {
  CARD_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_USER_TEXT,
  PAGES_SYSTEM_PROMPT,
  buildCardUserMessage,
  type CardUserMessageInput,
} from "../lib/ai/english/prompts";
// 단어장 정복 V1 (§7) — 오프라인 점검 대상: 판독 프롬프트↔스펙, 병합 순수 함수, zod 제약, 그림 우선순위
import {
  VOCAB_ENRICH_SYSTEM_PROMPT,
  VOCAB_ENRICH_USER_TEXT,
  VOCAB_EXTRACT_SYSTEM_PROMPT,
  VOCAB_EXTRACT_USER_TEXT,
} from "../lib/ai/english/vocabbook-prompts";
import {
  resolveVocabImage,
  vocabEnrichmentSchema,
  vocabExtractionSchema,
  type VocabEnrichItem,
  type VocabEntry,
  type VocabExtractEntry,
} from "../lib/ai/english/vocabbook-schemas";
import {
  findMissingNumbers,
  mergeVocabPages,
  type VocabPageForMerge,
} from "../lib/ai/english/vocabbook-merge";
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
            related: [{ kind: "synonym", word: "bundle", glossKo: "묶음" }],
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
              { no: 1, ko: "수리하다, 고치다", related: [{ kind: "synonym", word: "repair", glossKo: null }] },
              { no: 2, ko: "고정시키다", related: [] },
            ],
            related: [{ kind: "derivative", word: "fixture", glossKo: "설비" }],
          }),
        ],
      },
      {
        photoIndex: 1,
        entries: [
          entry({
            word: "fix",
            meanings: [{ no: 1, ko: "수리하다, 고치다", related: [{ kind: "antonym", word: "break", glossKo: null }] }],
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
    imageEmoji: null,
    imageSvg: null,
    photoIndex: 0,
    confidence: "high",
    partial: false,
    ...over,
  });

  // --- mergeEnrichment A: 정의 불변(덮어쓰기 0) + null 자리만 채움 + 부분 실패 + enriched 판정 ---
  {
    const entries: VocabEntry[] = [
      ventry({ no: "0001", word: "apple", definitionEn: null, imageEmoji: null }), // 채울 대상
      ventry({ no: "0002", word: "brave", definitionEn: "Not afraid of anything.", imageEmoji: "🦁" }), // 이미 채워짐 → 불변
      ventry({ no: "0003", word: "fix", definitionEn: null, imageEmoji: null }), // 결과에 없음 → 부분 실패로 그대로
    ];
    const result: VocabEnrichItem[] = [
      { no: "0001", word: "apple", definitionEn: "A round sweet fruit.", imageEmoji: "🍎" },
      { no: "0002", word: "brave", definitionEn: "OVERWRITE ATTEMPT.", imageEmoji: "❌" }, // 덮어쓰기 시도 → 무시돼야
    ];
    const m = mergeEnrichment(entries, result);
    const [apple, brave, fix] = m.entries;
    const ok =
      apple.definitionEn === "A round sweet fruit." &&
      apple.imageEmoji === "🍎" &&
      brave.definitionEn === "Not afraid of anything." && // 덮어쓰기 0
      brave.imageEmoji === "🦁" &&
      fix.definitionEn === null &&
      fix.imageEmoji === null && // 결과에 없는 단어는 그대로
      m.enriched === false; // fix가 null이라 미완
    add(
      "호출 D §8. mergeEnrichment: 정의 불변·null만 채움·부분 실패·enriched=false",
      ok,
      `apple=${JSON.stringify(apple.definitionEn)}/${apple.imageEmoji} · brave=${JSON.stringify(brave.definitionEn)}/${brave.imageEmoji} · fix=${fix.definitionEn}/${fix.imageEmoji} · enriched=${m.enriched}`,
    );
  }

  // --- mergeEnrichment B: 이모지 독립(정의는 불변, 이모지만 채움) + 전부 채워지면 enriched=true ---
  {
    const entries: VocabEntry[] = [
      ventry({ no: "0001", word: "apple", definitionEn: "A round fruit.", imageEmoji: null }), // 정의 O·이모지 X
      ventry({ no: "0002", word: "run", definitionEn: null, imageEmoji: null }),
    ];
    const result: VocabEnrichItem[] = [
      { no: "0001", word: "apple", definitionEn: "SHOULD NOT REPLACE.", imageEmoji: "🍎" }, // 정의 불변, 이모지만
      { no: "0002", word: "run", definitionEn: "To move fast on your legs.", imageEmoji: "🏃" },
    ];
    const m = mergeEnrichment(entries, result);
    const ok =
      m.entries[0].definitionEn === "A round fruit." && // 정의 불변
      m.entries[0].imageEmoji === "🍎" && // 이모지만 채움(독립)
      m.entries[1].definitionEn === "To move fast on your legs." &&
      m.entries[1].imageEmoji === "🏃" &&
      m.enriched === true; // 모든 정의 non-null
    add(
      "호출 D §8. mergeEnrichment: 이모지 독립 채움·enriched=true",
      ok,
      `apple.def=${JSON.stringify(m.entries[0].definitionEn)} apple.emoji=${m.entries[0].imageEmoji} · enriched=${m.enriched}`,
    );
  }

  // --- mergeEnrichment C: 번호 없는 단어는 word(대소문자 무시)로 매칭 ---
  {
    const entries: VocabEntry[] = [ventry({ no: null, word: "Fix", definitionEn: null })];
    const result: VocabEnrichItem[] = [
      { no: null, word: "fix", definitionEn: "To make something work again.", imageEmoji: null },
    ];
    const m = mergeEnrichment(entries, result);
    add(
      "호출 D §8. mergeEnrichment: no 없으면 word로 매칭",
      m.entries[0].definitionEn === "To make something work again.",
      `def=${JSON.stringify(m.entries[0].definitionEn)}`,
    );
  }

  // --- entriesToEnrich: definitionEn === null인 단어만 추린다 ---
  {
    const entries: VocabEntry[] = [
      ventry({ word: "a", definitionEn: null }),
      ventry({ word: "b", definitionEn: "Already has a definition." }),
      ventry({ word: "c", definitionEn: null }),
    ];
    const sub = entriesToEnrich(entries);
    const ok = sub.length === 2 && sub.every((e) => e.definitionEn === null) && sub.map((e) => e.word).join(",") === "a,c";
    add("호출 D §8. entriesToEnrich: null 정의만 추림", ok, `추린 단어=[${sub.map((e) => e.word).join(", ")}]`);
  }

  // --- buildEnrichRequestItems: 대상만·최소 shape(meaningsKo 풀이만) ---
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
        definitionEn: null,
      }),
      ventry({ word: "b", definitionEn: "excluded" }), // 정의 있음 → 제외
    ];
    const req = buildEnrichRequestItems(entries);
    const ok =
      req.length === 1 &&
      req[0].word === "apple" &&
      req[0].no === "0001" &&
      req[0].meaningsKo.join("|") === "사과|사과나무";
    add("호출 D §8. buildEnrichRequestItems: 대상만·meaningsKo 풀이만", ok, `요청=${JSON.stringify(req)}`);
  }

  // --- isVocabBookEnriched: enriched 단일 정의처(빈 배열 false·정의 하나라도 null이면 false) ---
  {
    const ok =
      isVocabBookEnriched([]) === false &&
      isVocabBookEnriched([ventry({ definitionEn: "x" })]) === true &&
      isVocabBookEnriched([ventry({ definitionEn: "x" }), ventry({ definitionEn: null })]) === false;
    add("호출 D §8. isVocabBookEnriched: 빈배열=false·null 있으면 false", ok, "3케이스");
  }

  // --- 호출 D zod: 정의·이모지 품질 규칙이 실제로 거부하는지 ---
  {
    const goodEnrich = {
      items: [
        { no: "0001", word: "apple", definitionEn: "A round sweet fruit that grows on trees.", imageEmoji: "🍎" },
        { no: "0002", word: "respect", definitionEn: "To treat someone in a kind and polite way.", imageEmoji: null },
      ],
    };
    const goodParsed = vocabEnrichmentSchema.safeParse(goodEnrich);
    add(
      "호출 D §8. zod: 올바른 보강 → 통과",
      goodParsed.success === true,
      goodParsed.success ? "정상 통과" : issues(goodParsed.error),
    );

    const badEnrich: { name: string; items: unknown[] }[] = [
      { name: "정의에 한글", items: [{ no: null, word: "apple", definitionEn: "둥근 과일이다.", imageEmoji: null }] },
      { name: "정의에 표제어 포함", items: [{ no: null, word: "apple", definitionEn: "An apple is a red fruit.", imageEmoji: null }] },
      { name: "정의 두 문장", items: [{ no: null, word: "apple", definitionEn: "It is a fruit. It is sweet.", imageEmoji: null }] },
      { name: "이모지 2개", items: [{ no: null, word: "apple", definitionEn: null, imageEmoji: "🍎🍏" }] },
      { name: "이모지 자리에 글자", items: [{ no: null, word: "apple", definitionEn: null, imageEmoji: "A" }] },
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
        if (it.definitionEn === null) allDefined = false;
      }
    }
    add(
      "호출 D §8. few-shot: [예시] 출력이 스키마 통과 + 이모지 유/무 둘 다 시연",
      wrapperFound && schemaOk && showsEmoji && showsNull && allDefined,
      `래퍼=${wrapperFound ? "있음" : "없음"} · 스키마=${schemaOk ? "통과" : `위반(${failMsgs.join(" / ")})`} · 이모지시연=${showsEmoji} · null시연=${showsNull} · 정의전부=${allDefined}`,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// 실행: 픽스처 2권으로 실제 카드 생성 → 점검 → 항목별 pass/fail 표 → 실패 시 exit 1
// ---------------------------------------------------------------------------

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

  // 호출 D(보강) 텍스트 점검 — **EVAL_VOCAB=1일 때만** 실호출 1회. (오프라인 게이트가 위에서 이미
  // return하므로 EVAL_OFFLINE_ONLY=1에서는 절대 도달하지 않는다.) 정의가 한 문장인가·한글 안 섞였나·
  // 표제어를 정의에 그대로 안 썼나·이모지 0~1개인가를 실제 모델 출력으로 눈으로 확인한다(§8-4·계획 V3).
  // enrichVocab이 이미 zod로 이 규칙을 강제하므로, 여기서는 통과한 출력을 사람이 읽게 재확인·인쇄한다.
  if (process.env.EVAL_VOCAB === "1") {
    console.log("EVAL_VOCAB=1 — 호출 D(보강) 실호출 1회로 정의·이모지 텍스트를 점검합니다.");
    const graphemeCount = (s: string): number => {
      try {
        let n = 0;
        for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) n++;
        return n;
      } catch {
        return Array.from(s).length;
      }
    };
    const probeWord = (no: string, word: string, ko: string): VocabEntry => ({
      no,
      word,
      ipa: null,
      pos: ["명"],
      meanings: [{ no: null, ko, related: [] }],
      examples: [],
      related: [],
      definitionEn: null,
      imageEmoji: null,
      imageSvg: null,
      photoIndex: 0,
      confidence: "high",
      partial: false,
    });
    const probeEntries: VocabEntry[] = [
      probeWord("0001", "apple", "사과"),
      probeWord("0002", "brave", "용감한"),
      probeWord("0003", "respect", "존경하다"),
      probeWord("0004", "moment", "순간"),
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
        const koreanFree = def ? !/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(def) : true;
        const noHeadword = def ? !new RegExp(`\\b${it.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu").test(def) : true;
        const emojiOk = it.imageEmoji === null || graphemeCount(it.imageEmoji) === 1;
        vocabResults.push({
          book: "호출 D 실호출",
          check: `${it.word}: 한 문장·한글 없음·표제어 미포함·이모지 0~1개`,
          pass: def !== null && sentences <= 1 && koreanFree && noHeadword && emojiOk,
          detail: `def=${JSON.stringify(def)} emoji=${it.imageEmoji} | 문장=${sentences} 한글없음=${koreanFree} 표제어미포함=${noHeadword} 이모지OK=${emojiOk}`,
        });
      }
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

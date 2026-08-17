/**
 * scripts/eval-english.ts — 카드 품질 평가 하네스 (docs/harness/english.md §5)
 *
 * 프롬프트를 고칠 때마다 돌리는 자동 점검 (프롬프트도 코드처럼 회귀 테스트).
 * 실행: npm run eval:english  — OPENAI_API_KEY 필요, 실호출 3회 발생. CI가 아니라 수동 실행용.
 *   (Wolves / Pooh / Pooh+장면 메모. EVAL_SKIP_PAGES=1이면 마지막 변형을 건너뛰어 2회)
 * 픽스처 2권(Wolves, Pooh Gets Stuck)의 값은 docs/SPEC.md §12 그대로다. 임의 변경 금지.
 * 호출 A′(page_digest)는 사진이 있어야 재현되므로 실호출 대신 zod 규칙을 고정 입력으로 검사한다.
 */

import { generateCard } from "../lib/ai/client";
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
import { buildCardUserMessage, type CardUserMessageInput } from "../lib/ai/english/prompts";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다.
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
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

  // 실호출 없이 정적 검증만 하고 끝낸다 — OPENAI_API_KEY가 없거나 비용을 쓰기 전에
  // 다이얼 동기화만 확인할 때 쓴다. 통과해도 "카드 품질 통과"가 아니라 "정의 동기화 통과"다.
  if (process.env.EVAL_OFFLINE_ONLY === "1") {
    printTable(allResults);
    const offlineFailed = allResults.filter((r) => !r.pass);
    console.log("EVAL_OFFLINE_ONLY=1 — 실호출 0회. 모델 출력 품질은 검증하지 않았습니다.");
    if (offlineFailed.length > 0) {
      console.error(`FAIL — 오프라인 ${offlineFailed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 오프라인 ${allResults.length}개 항목 통과 (실호출 미실행).`);
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

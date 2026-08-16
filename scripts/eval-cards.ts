/**
 * scripts/eval-cards.ts — 카드 품질 평가 하네스 (docs/HARNESS.md §5)
 *
 * 프롬프트를 고칠 때마다 돌리는 자동 점검 (프롬프트도 코드처럼 회귀 테스트).
 * 실행: npm run eval:cards  — OPENAI_API_KEY 필요, 실호출 2회 발생. CI가 아니라 수동 실행용.
 * 픽스처 2권(Wolves, Pooh Gets Stuck)의 값은 docs/SPEC.md §12 그대로다. 임의 변경 금지.
 */

import { generateCard } from "../lib/ai/client";
import { makeLearningCardSchema, SIGHT_WORD_SET, type LearningCard } from "../lib/ai/schemas";
import type { CardUserMessageInput } from "../lib/ai/prompts";

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
  title: string;
  author: string;
  series: string;
  isFiction: boolean;
  arLevel: number;
  lexile: number;
  wordCount: number;
  arQuizNo: string;
  topic: string;
}

const FIXTURES: Fixture[] = [
  {
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
    results.push({ book: fixture.title, check, pass, detail });

  // 1. §4의 zod 추가 검증 전부 통과
  const zodResult = makeLearningCardSchema({
    arLevel: fixture.arLevel,
    isFiction: fixture.isFiction,
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

  for (const fixture of FIXTURES) {
    console.log(`\n=== 카드 생성: ${fixture.title} (${fixture.author}) ===`);
    try {
      const card = await generateCard(toCardInput(fixture));
      allResults.push(...runChecks(fixture, card));
    } catch (error) {
      // 생성 자체가 실패하면 해당 책의 전 항목을 실패로 기록하고 다음 책으로 진행
      const message = error instanceof Error ? error.message : String(error);
      allResults.push({
        book: fixture.title,
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
  console.error("eval-cards 실행 실패:", error);
  process.exit(1);
});

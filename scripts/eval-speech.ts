/**
 * scripts/eval-speech.ts — 대화 해설 낭독(docs/SPEC.md §18) 회귀 가드. **실호출 0회.**
 *
 * 해설 낭독은 **과목 교차 기능**(공유 발음 관문 lib/speech.ts + 일본어 해설)이라 한 과목 eval에 붙이지 않고
 * 별도 진입점으로 둔다(eval-streak.ts와 같은 이유). store는 import하지 않는다.
 *
 * 대상:
 * - A. 낭독 대본(lib/ja-coaching-script.ts) — buildCoachingScript·normalizeKoForTts·coachingJaTexts (§18-1)
 * - B. 쪼개기 splitForTts — 규칙·불변식 (§18-1)
 * - C. 상수·엔진 — TTS_LANGS·지시문·기본 엔진 (§18-3)
 * - D. 연속 재생 큐 speakQueue — 가짜 window·Audio·speechSynthesis·fetch·URL을 전역에 깐 뒤 dynamic import (§18-2)
 *
 * ⚠️ 네트워크 0: fetch를 **맨 먼저** 스텁으로 갈아 끼운다. lib/tts.ts(C의 지시문 확인)는 openai 패키지를 로드하지만
 * 클라이언트는 지연 생성이라 만들지 않고, 합성 함수도 부르지 않는다. 혹시 몰라 OPENAI_API_KEY도 비운다.
 */

import {
  buildCoachingScript,
  coachingJaTexts,
  normalizeKoForTts,
  splitForTts,
  type ScriptPiece,
} from "../lib/ja-coaching-script";
import { isTtsLang, TTS_LANGS, TTS_TEXT_MAX_CHARS } from "../lib/tts-shared";
import type { TtsKvBackend } from "../lib/tts-cache";
import type { JaDialogCoaching } from "../lib/japanese-dialog-contract";

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| ${"결과".padEnd(4)} | ${"영역".padEnd(14)} | 점검 항목 | 상세 |`);
  console.log(`|------|----------------|-----------|------|`);
  for (const r of results) {
    console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.book.padEnd(14)} | ${r.check} | ${r.detail} |`);
  }
  console.log("");
}

const results: CheckResult[] = [];
const add = (book: string, check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** 고립 서로게이트(쪼개진 이모지) 검출. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const noWs = (s: string) => s.replace(/\s+/g, "");
/** 쪼개기 불변식: 모든 조각 trim·비어 있지 않음·≤max, 공백 제외 글자 보존. */
function splitInvariant(text: string, pieces: string[], max: number): string | null {
  for (const p of pieces) {
    if (p !== p.trim()) return `trim 안 됨: ${short(p, 40)}`;
    if (!p) return "빈 조각";
    if (p.length > max) return `길이 ${p.length} > ${max}`;
    if (LONE_SURROGATE.test(p)) return `고립 서로게이트: ${short(p, 40)}`;
  }
  if (noWs(pieces.join("")) !== noWs(text)) return "join 불변식 깨짐(글자 유실·추가)";
  return null;
}

// ===========================================================================
// A. 낭독 대본 (§18-1)
// ===========================================================================

const EX = { ja: "", ko: "", tokens: [] };
const FIX: JaDialogCoaching = {
  summaryKo: "  전체적으로 자연스러웠어요 → 조사만 다듬으면 돼요.  ",
  goods: [
    { quoteJa: " そうですね。 ", whyKo: "맞장구가 자연스러웠어요." },
    { quoteJa: "また明日。", whyKo: "〜ましょう 형태를 잘 썼어요 👍" },
  ],
  fixes: [
    { originalJa: "私は学生がです。", betterJa: "私は学生です。", whyKo: "「が」가 필요 없어요.", grammarKo: "AはBです" },
    { originalJa: "行きます。", betterJa: "行きました。", whyKo: "과거형으로 말해요.", grammarKo: null },
  ],
  items: [
    { word: "約束", kana: "やくそく", meaningKo: "약속", usageKo: "約束する 형태로 써요.", example: EX, wordTokens: [] },
    { word: "目標", kana: "もくひょう", meaningKo: "목표", usageKo: "", example: EX, wordTokens: [] },
  ],
  practice: [
    { ja: "明日は何をしますか。", ko: "내일은 뭐 해요?", tokens: [] },
    { ja: "一緒に行きましょう。", ko: "", tokens: [] },
  ],
};

type P = [ScriptPiece["section"], ScriptPiece["lang"], string, number | null];
const EXPECTED: P[] = [
  ["summary", "ko-KR", "총평.", null],
  ["summary", "ko-KR", "전체적으로 자연스러웠어요, 조사만 다듬으면 돼요.", 0],
  ["goods", "ko-KR", "잘한 점.", null],
  ["goods", "ja-JP", "そうですね。", 0],
  ["goods", "ko-KR", "맞장구가 자연스러웠어요.", 0],
  ["goods", "ja-JP", "また明日。", 1],
  ["goods", "ko-KR", "ましょう 형태를 잘 썼어요", 1],
  ["fixes", "ko-KR", "고칠 점.", null],
  ["fixes", "ja-JP", "私は学生がです。", 0],
  ["fixes", "ko-KR", "고치면,", 0],
  ["fixes", "ja-JP", "私は学生です。", 0],
  ["fixes", "ko-KR", "「が」가 필요 없어요.", 0],
  ["fixes", "ko-KR", "문법: AはBです", 0],
  ["fixes", "ja-JP", "行きます。", 1],
  ["fixes", "ko-KR", "고치면,", 1],
  ["fixes", "ja-JP", "行きました。", 1],
  ["fixes", "ko-KR", "과거형으로 말해요.", 1],
  ["items", "ko-KR", "어휘.", null],
  ["items", "ja-JP", "約束", 0],
  ["items", "ko-KR", "약속", 0],
  ["items", "ko-KR", "約束する 형태로 써요.", 0],
  ["items", "ja-JP", "目標", 1],
  ["items", "ko-KR", "목표", 1],
  ["practice", "ko-KR", "다음 연습.", null],
  ["practice", "ja-JP", "明日は何をしますか。", 0],
  ["practice", "ko-KR", "내일은 뭐 해요?", 0],
  ["practice", "ja-JP", "一緒に行きましょう。", 1],
];

{
  const script = buildCoachingScript(FIX);
  const got: P[] = script.map((p) => [p.section, p.lang, p.text, p.item]);
  const same = got.length === EXPECTED.length && got.every((g, i) => JSON.stringify(g) === JSON.stringify(EXPECTED[i]));
  const firstDiff = got.findIndex((g, i) => JSON.stringify(g) !== JSON.stringify(EXPECTED[i]));
  add(
    "대본",
    "픽스처 (section, lang, text, item) 순서가 §18-1 표와 정확히 같음",
    same,
    same ? `${got.length}조각` : `첫 차이 #${firstDiff}: got=${short(got[firstDiff])} want=${short(EXPECTED[firstDiff])} (got ${got.length}/want ${EXPECTED.length})`,
  );

  const langOk =
    script.every((p) => p.lang === "ko-KR" || p.lang === "ja-JP") &&
    script.filter((p) => p.item === null).every((p) => p.lang === "ko-KR");
  add("대본", "언어 표기 ko-KR/ja-JP만, 제목 조각은 ko-KR", langOk, `langs=${[...new Set(script.map((p) => p.lang))].join(",")}`);

  const titles = script.filter((p) => p.item === null).map((p) => p.text);
  const summaryBody = script.find((p) => p.section === "summary" && p.item !== null);
  add(
    "대본",
    "item: 제목 null·총평 본문 0·카드 0..n-1",
    JSON.stringify(titles) === JSON.stringify(["총평.", "잘한 점.", "고칠 점.", "어휘.", "다음 연습."]) &&
      summaryBody?.item === 0 &&
      script.filter((p) => p.section === "goods" && p.item !== null).every((p) => p.item === 0 || p.item === 1),
    `titles=${titles.join("|")} summary.item=${summaryBody?.item}`,
  );

  const allClean = script.every((p) => p.text && p.text === p.text.trim() && p.text.length <= TTS_TEXT_MAX_CHARS);
  add("대본", "빈 조각 0·모든 조각 trim·≤300", allClean, `${script.length}조각`);

  const jaSrc = [
    ...FIX.goods.map((g) => g.quoteJa),
    ...FIX.fixes.flatMap((f) => [f.originalJa, f.betterJa]),
    ...FIX.items.map((i) => i.word),
    ...FIX.practice.map((p) => p.ja),
  ].map((s) => s.trim());
  const jaPieces = script.filter((p) => p.lang === "ja-JP").map((p) => p.text);
  add(
    "대본",
    "일본어 조각 == 원문.trim()(정리하지 않음 — 🔊 캐시 키 일치)",
    JSON.stringify(jaPieces) === JSON.stringify(jaSrc),
    short(jaPieces.join(" / ")),
  );

  const jaTexts = coachingJaTexts(FIX);
  const jaSet = new Set(jaPieces);
  add(
    "대본",
    "coachingJaTexts ⊆ 일본어 조각(프리페치 키 = 재생 키)",
    jaTexts.length === jaSrc.length && jaTexts.every((t) => jaSet.has(t)),
    short(jaTexts.join(" / ")),
  );
}
{
  // 빈 goods·fixes → 제목 조각까지 없음
  const script = buildCoachingScript({ ...FIX, goods: [], fixes: [] });
  const has = (sec: string) => script.some((p) => p.section === sec);
  add(
    "대본",
    "빈 goods·fixes → 제목 조각 없음(섹션 통째로 건너뜀)",
    !has("goods") && !has("fixes") && !script.some((p) => p.text === "잘한 점." || p.text === "고칠 점."),
    script.map((p) => p.text).slice(0, 4).join("|"),
  );
}
{
  // 빈 총평 → 총평 섹션 없음
  const script = buildCoachingScript({ ...FIX, summaryKo: "   " });
  add("대본", "summaryKo 공백 → '총평.' 제목도 없음", !script.some((p) => p.section === "summary"), script[0]?.text ?? "(빈 대본)");
}
{
  // grammarKo null·""·"  " → 문법 조각 없음, usageKo·practice.ko 빈 문자열 → 조각 없음
  const fixes = [null, "", "  "].map((g) => ({ originalJa: "行く。", betterJa: "行きます。", whyKo: "정중형.", grammarKo: g }));
  const script = buildCoachingScript({ ...FIX, fixes, items: [{ ...FIX.items[1], usageKo: "   " }], practice: [{ ja: "はい。", ko: "  ", tokens: [] }] });
  const noGrammar = !script.some((p) => p.text.startsWith("문법:"));
  const itemPieces = script.filter((p) => p.section === "items" && p.item !== null).map((p) => p.text);
  const practicePieces = script.filter((p) => p.section === "practice" && p.item !== null).map((p) => p.text);
  add(
    "대본",
    "grammarKo null·''·'  ' → '문법:' 없음 / usageKo·practice.ko 공백 → 조각 없음",
    noGrammar && JSON.stringify(itemPieces) === JSON.stringify(["目標", "목표"]) && JSON.stringify(practicePieces) === JSON.stringify(["はい。"]),
    `items=${itemPieces.join("|")} practice=${practicePieces.join("|")}`,
  );
}
{
  // 400자 whyKo → 여러 조각, 같은 section·item·순서 보존
  const sentence = "조사 「は」는 주제를, 「が」는 주어를 강조할 때 써요. ";
  let longWhy = "";
  while (longWhy.length < 400) longWhy += sentence;
  longWhy = longWhy.slice(0, 400).trim();
  const script = buildCoachingScript({
    ...FIX,
    fixes: [FIX.fixes[0], { ...FIX.fixes[1], whyKo: longWhy }],
  });
  const whyPieces = script.filter((p) => p.section === "fixes" && p.item === 1 && p.lang === "ko-KR" && p.text !== "고치면,");
  const idx = script.findIndex((p) => p === whyPieces[0]);
  const contiguous = whyPieces.every((p, k) => script[idx + k] === p);
  const inv = splitInvariant(normalizeKoForTts(longWhy), whyPieces.map((p) => p.text), TTS_TEXT_MAX_CHARS);
  add(
    "대본",
    "400자 whyKo → 여러 조각, 같은 section(fixes)·item(1)·순서 보존",
    whyPieces.length >= 2 && contiguous && inv === null && script[idx - 1]?.text === "行きました。",
    `${whyPieces.length}조각 [${whyPieces.map((p) => p.text.length).join(",")}] ${inv ?? ""}`,
  );
}
{
  const cases: [string, string][] = [
    ["A → B", "A, B"],
    ["は⇒が", "は, が"],
    ["「〜ている」 형태", "「ている」 형태"],
    ["～ます형", "ます형"],
    ["잘했어요 👍", "잘했어요"],
    ["👨‍👩‍👧 가족   모두", "가족 모두"],
    ["좋아요 👍🏻 정말", "좋아요 정말"],
  ];
  const bad = cases.filter(([i, o]) => normalizeKoForTts(i) !== o).map(([i, o]) => `${i}→${JSON.stringify(normalizeKoForTts(i))}(want ${o})`);
  add("대본", "normalizeKoForTts: →·⇒ → ', ' / 〜·～ 제거 / 이모지 제거 / 공백 하나로", bad.length === 0, bad.join("; ") || `${cases.length}건`);
}
{
  // 키캡 이모지(숫자 + U+FE0F + U+20E3) — 숫자는 남기고 결합 기호는 지운다(QA F9-②: "1⃣"이 남던 문제)
  const cases: [string, string][] = [
    ["1\uFE0F\u20E3 조사를 고쳐요", "1 조사를 고쳐요"],
    ["2\u20E3 어미", "2 어미"],
    ["#\uFE0F\u20E3 태그", "# 태그"],
    ["좋아요\uFE0F 정말", "좋아요 정말"],
  ];
  const bad = cases
    .map(([i, o]) => [i, o, normalizeKoForTts(i)] as const)
    .filter(([, o, got]) => got !== o || /[\u20E3\uFE0F]/.test(got))
    .map(([i, o, got]) => `${JSON.stringify(i)}→${JSON.stringify(got)}(want ${o})`);
  add("대본", "normalizeKoForTts: 키캡 U+20E3·변형 선택자 U+FE0F 제거(숫자는 남김)", bad.length === 0, bad.join("; ") || `${cases.length}건`);
}

// ===========================================================================
// B. 쪼개기 splitForTts (§18-1)
// ===========================================================================
const MAX = TTS_TEXT_MAX_CHARS;
{
  const exact = "가".repeat(MAX);
  const r1 = splitForTts(`  ${exact}  `, MAX);
  const r2 = splitForTts("짧은 문장. 두 번째 문장.", MAX);
  add("쪼개기", "≤max(정확히 max 포함) → trim 1조각", r1.length === 1 && r1[0] === exact && r2.length === 1 && r2[0] === "짧은 문장. 두 번째 문장.", `max=${r1.length}조각, 짧음=${r2.length}조각`);
}
{
  const para = "오늘은 조사 「は」와 「が」의 차이를 배웠어요. ".repeat(40).trim();
  const pieces = splitForTts(para, MAX);
  const inv = splitInvariant(para, pieces, MAX);
  add(
    "쪼개기",
    "긴 한국어 문단 → >1조각·각 ≤max·문장 끝(.)에서",
    pieces.length > 1 && inv === null && pieces.every((p) => p.endsWith(".")),
    `${para.length}자 → ${pieces.length}조각 [${pieces.map((p) => p.length).join(",")}] ${inv ?? ""}`,
  );
  add("쪼개기", "join 불변식(공백 제외 글자 보존)", inv === null, inv ?? "OK");
}
{
  const text = "가나다라마바사아자차".repeat(70); // 700자, 구두점·공백 없음
  const pieces = splitForTts(text, MAX);
  const inv = splitInvariant(text, pieces, MAX);
  add("쪼개기", "구두점·공백 없는 700자 → 각 ≤max·불변식", pieces.length === 3 && inv === null, `[${pieces.map((p) => p.length).join(",")}] ${inv ?? ""}`);
}
{
  const comma = ("가".repeat(50) + ",").repeat(10);
  const touten = ("あ".repeat(50) + "、").repeat(10);
  const pc = splitForTts(comma, MAX);
  const pt = splitForTts(touten, MAX);
  const okC = pc.length > 1 && pc.slice(0, -1).every((p) => p.endsWith(",")) && splitInvariant(comma, pc, MAX) === null;
  const okT = pt.length > 1 && pt.slice(0, -1).every((p) => p.endsWith("、")) && splitInvariant(touten, pt, MAX) === null;
  add("쪼개기", "문장 끝 없으면 ',' '、' 폴백(조각이 쉼표로 끝남)", okC && okT, `, → [${pc.map((p) => p.length).join(",")}] 、 → [${pt.map((p) => p.length).join(",")}]`);
}
{
  const p = splitForTts("가격이 3.5배 올랐어요. 그래서 놀랐어요.", 20);
  add("쪼개기", "'3.5배'의 '.'에서 안 자름", JSON.stringify(p) === JSON.stringify(["가격이 3.5배 올랐어요.", "그래서 놀랐어요."]), JSON.stringify(p));
}
{
  const p = splitForTts("今日は晴れです。明日は雨です。", 10);
  add("쪼개기", "'。' 뒤 공백 없이도 자름", JSON.stringify(p) === JSON.stringify(["今日は晴れです。", "明日は雨です。"]), JSON.stringify(p));
}
{
  const p = splitForTts("그는 「そうです。」라고 말했어요. 그래서 좋았어요.", 12);
  add(
    "쪼개기",
    "「…。」라고 → '」'가 앞 조각에 붙음(뒤 조각 머리 아님)",
    p[0] === "그는 「そうです。」" && !p.some((x) => x.startsWith("」")) && splitInvariant("그는 「そうです。」라고 말했어요. 그래서 좋았어요.", p, 12) === null,
    JSON.stringify(p),
  );
}
{
  const text = "가".repeat(MAX - 1) + "😀" + "나".repeat(100);
  const p = splitForTts(text, MAX);
  const inv = splitInvariant(text, p, MAX);
  add("쪼개기", "이모지가 max 경계에 걸려도 고립 서로게이트 없음", inv === null && p.length === 2, `[${p.map((x) => x.length).join(",")}] ${inv ?? ""}`);
}
{
  // 번호 목록 'N.'(문자열 머리·공백 뒤 숫자 1~2자리 + 마침표 + 공백)는 문장 끝이 아니다 — 앞 조각 끝에 "2."가 붙지 않게(QA F9-①)
  const LIST_TAIL = /(^|\s)\d{1,2}\.$/;
  const list = "1. 조사 「は」를 써요. 2. 어미 「ます」로 바꿔요. 3. 과거형은 「ました」예요.";
  const p = splitForTts(list, 30);
  const want = ["1. 조사 「は」를 써요.", "2. 어미 「ます」로 바꿔요.", "3. 과거형은 「ました」예요."];
  add(
    "쪼개기",
    "번호 목록 'N.'은 문장 끝 아님 — 조각이 번호로 끝나지 않고 번호로 시작",
    JSON.stringify(p) === JSON.stringify(want) && splitInvariant(list, p, 30) === null,
    JSON.stringify(p),
  );
  // 문장 끝이 없어 강제로 자를 때도 번호 바로 뒤 공백에서 자르지 않는다
  const noEnd = "순서 1. " + "가".repeat(20) + " 2. " + "나".repeat(20);
  const q = splitForTts(noEnd, 30);
  add(
    "쪼개기",
    "강제 자르기(문장 끝 없음)도 번호 'N.' 바로 뒤에서 안 자름",
    q.length >= 2 && q.every((x) => !LIST_TAIL.test(x)) && splitInvariant(noEnd, q, 30) === null,
    JSON.stringify(q),
  );
}
{
  const a = splitForTts("", MAX);
  const b = splitForTts("   \n ", MAX);
  const c = splitForTts("a b", 0); // max<1 방어 → 1로 취급
  add("쪼개기", "빈·공백 → [] / max<1은 1로 취급", a.length === 0 && b.length === 0 && JSON.stringify(c) === JSON.stringify(["a", "b"]), `''→${a.length} 공백→${b.length} max0→${JSON.stringify(c)}`);
}

// ===========================================================================
// C·D는 전역 스텁이 필요 — async main
// ===========================================================================

type Status = number | "hang";
interface Env {
  fetchDelayMs: number;
  /** 문장별 합성 지연(ms) — 없으면 fetchDelayMs. 느린 망에서 한 조각만 늦게 오는 경우를 만든다. */
  fetchDelayFor: ((text: string) => number) | null;
  audioMs: number;
  /** 오디오가 알려 주는 길이(초). NaN이면 모름(기본) — 클라우드 재생 안전 타임아웃이 기기 추정식을 쓴다. */
  audioDuration: number;
  /** true면 클라우드 오디오의 ended가 끝내 안 온다(재생 안전 타임아웃 검증). 무음 WAV는 영향 없음. */
  audioNeverEnds: boolean;
  deviceMs: number;
  postStatus: (text: string) => Status;
  /** 지문 GET 응답 — 숫자 = 상태 코드, "hang" = 안 끝남(abort로만 끝남), "neterr" = 네트워크 실패(TypeError) */
  getStatus: number | "hang" | "neterr";
  deviceMode: "normal" | "silent" | { speakingMs: number };
  posts: string[];
  /** 우리 쪽 abort로 끊긴 합성 요청(텍스트) */
  postAborted: string[];
  gets: number;
  urlCreated: number;
  urlRevoked: number;
  silentCreated: number;
  liveUrls: Set<string>;
  audios: FakeAudio[];
  spoken: { text: string; lang: string; volume: number }[];
  cancels: number;
  log: string[];
}

/** 누적(리셋 안 함) — 마지막 "네트워크 0" 확인용. */
let totalGets = 0;
let totalFetches = 0;
/** 무음 WAV objectURL 생성 누적(리셋 안 함) — "한 번 만들고 상수처럼" 확인용. */
let silentTotal = 0;

const env: Env = {
  fetchDelayMs: 3,
  fetchDelayFor: null,
  audioMs: 5,
  audioDuration: NaN,
  audioNeverEnds: false,
  deviceMs: 5,
  postStatus: () => 200,
  getStatus: 200,
  deviceMode: "normal",
  posts: [],
  postAborted: [],
  gets: 0,
  urlCreated: 0,
  urlRevoked: 0,
  silentCreated: 0,
  liveUrls: new Set(),
  audios: [],
  spoken: [],
  cancels: 0,
  log: [],
};

function resetEnv(): void {
  env.fetchDelayMs = 3;
  env.fetchDelayFor = null;
  env.audioMs = 5;
  env.audioDuration = NaN;
  env.audioNeverEnds = false;
  env.deviceMs = 5;
  env.postStatus = () => 200;
  env.getStatus = 200;
  env.deviceMode = "normal";
  env.posts = [];
  env.postAborted = [];
  env.gets = 0;
  env.urlCreated = 0;
  env.urlRevoked = 0;
  env.silentCreated = 0;
  env.liveUrls = new Set();
  env.spoken = [];
  env.cancels = 0;
  env.log = [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(2);
  }
  return cond();
}
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** 가짜 <audio>. play()는 다음 틱에 시작해 audioMs 뒤 끝난다(끝날 때 실브라우저처럼 pause → ended). */
class FakeAudio {
  _src = "";
  paused = true;
  ended = false;
  playbackRate = 1;
  /** 메타데이터 전에는 NaN(실브라우저와 같음). play()가 시작될 때 env.audioDuration으로 채운다. */
  duration = NaN;
  pauseCalls = 0;
  playCalls = 0;
  /** src 없이 만든 요소 = 큐가 돌려 쓰는 요소(unlockPlayback의 new Audio()). speak()는 new Audio(url). */
  readonly ctorNoSrc: boolean;
  onended: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onpause: ((e?: unknown) => void) | null = null;
  private gen = 0;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(src?: string) {
    env.audios.push(this);
    this.ctorNoSrc = src === undefined;
    if (src !== undefined) this._src = src;
  }
  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this.gen++;
    clearTimeout(this.endTimer);
    const wasPlaying = !this.paused;
    this._src = v;
    this.ended = false;
    this.paused = true;
    this.duration = NaN;
    // 실브라우저보다 보수적으로: 소스 교체가 pause 이벤트를 쏴도 큐가 "외부 일시정지"로 오판하면 안 된다.
    if (wasPlaying) setTimeout(() => this.onpause?.(), 0);
  }
  get isPlayingTts(): boolean {
    return !this.paused && this._src.startsWith("blob:tts/");
  }
  play(): Promise<void> {
    this.playCalls++;
    const g = this.gen;
    this.paused = false;
    this.ended = false;
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (g !== this.gen) {
          reject(abortError()); // 소스 교체·pause로 끊긴 play()
          return;
        }
        const silent = this._src.startsWith("blob:silent/");
        if (!silent) this.duration = env.audioDuration;
        resolve();
        if (!silent && env.audioNeverEnds) return; // ended가 끝내 안 온다
        const dur = silent ? 2 : env.audioMs;
        this.endTimer = setTimeout(() => {
          if (g !== this.gen || this.paused) return;
          this.ended = true;
          this.paused = true;
          this.onpause?.();
          this.onended?.();
        }, dur);
      }, 0);
    });
  }
  pause(): void {
    this.pauseCalls++;
    if (this.paused) return;
    this.gen++;
    clearTimeout(this.endTimer);
    this.paused = true;
    setTimeout(() => this.onpause?.(), 0);
  }
}

class FakeUtterance {
  lang = "";
  rate = 1;
  volume = 1;
  voice: unknown = null;
  onend: ((e?: unknown) => void) | null = null;
  onerror: ((e?: { error?: string }) => void) | null = null;
  constructor(public text: string) {}
}

const synth = {
  _speaking: false,
  pending: false,
  /** 잠금 해제용 무음 발화(" ")가 말하는 중 — 실브라우저처럼 그동안 speaking이 true다. */
  blank: null as FakeUtterance | null,
  get speaking(): boolean {
    return this._speaking || this.blank !== null;
  },
  set speaking(v: boolean) {
    this._speaking = v;
  },
  current: null as FakeUtterance | null,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  speak(u: FakeUtterance) {
    env.spoken.push({ text: u.text, lang: u.lang, volume: u.volume });
    env.log.push(`speak:${u.text}`);
    if (!u.text.trim()) {
      // 잠금 해제용 무음 발화 — 다음 틱에 끝난다. 그 사이 speaking=true(이때 cancel하면 뒤 발화가 씹히는 게 실기기 증상).
      this.blank = u;
      setTimeout(() => {
        if (this.blank !== u) return;
        this.blank = null;
        u.onend?.({});
      }, 0);
      return;
    }
    this.current = u;
    const mode = env.deviceMode;
    if (mode === "normal") {
      this.speaking = true;
      this.timer = setTimeout(() => {
        if (this.current !== u) return;
        this.speaking = false;
        this.current = null;
        u.onend?.({});
      }, env.deviceMs);
    } else if (mode === "silent") {
      /* 무발화 — onend도 안 오고 speaking도 false */
    } else {
      this.speaking = true; // 말하는 중인데 onend가 안 온다(iOS에서 보이는 증상)
      this.timer = setTimeout(() => {
        if (this.current === u) this.speaking = false;
      }, mode.speakingMs);
    }
  },
  cancel() {
    env.cancels++;
    env.log.push("cancel");
    clearTimeout(this.timer);
    const u = this.current;
    const b = this.blank;
    this.current = null;
    this.blank = null;
    this.speaking = false;
    if (u) setTimeout(() => u.onerror?.({ error: "interrupted" }), 0);
    if (b) setTimeout(() => b.onerror?.({ error: "interrupted" }), 0);
  },
  getVoices() {
    return [];
  },
  addEventListener() {},
};

function installStubs(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const et = new EventTarget();
  g.window = globalThis;
  g.addEventListener = et.addEventListener.bind(et);
  g.removeEventListener = et.removeEventListener.bind(et);
  g.dispatchEvent = et.dispatchEvent.bind(et);
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  g.Audio = FakeAudio;
  g.SpeechSynthesisUtterance = FakeUtterance;
  g.speechSynthesis = synth;
  let seq = 0;
  URL.createObjectURL = ((b: Blob) => {
    seq++;
    if (b.type === "audio/wav") {
      env.silentCreated++;
      silentTotal++;
      return `blob:silent/${seq}`;
    }
    env.urlCreated++;
    const u = `blob:tts/${seq}`;
    env.liveUrls.add(u);
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((u: string) => {
    if (u.startsWith("blob:silent/")) return;
    env.urlRevoked++;
    env.liveUrls.delete(u);
  }) as typeof URL.revokeObjectURL;
}

/** 네트워크 0 — POST /api/tts는 가짜 mp3 Blob, GET은 지문. 그 밖은 전부 실패. */
function installFetchStub(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    totalFetches++;
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url !== "/api/tts") throw new Error(`eval: 예상 밖 fetch ${url}`);
    const signal = init?.signal ?? undefined;
    if (method === "GET") {
      env.gets++;
      totalGets++;
      const gs = env.getStatus;
      if (gs === "neterr") throw new TypeError("Failed to fetch");
      if (gs === "hang") {
        return new Promise<Response>((_, reject) => {
          if (signal?.aborted) reject(abortError());
          signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      if (gs !== 200) return new Response(JSON.stringify({ error: "x" }), { status: gs });
      return new Response(JSON.stringify({ voice: "alloy", model: "stub", instructions: 2 }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
    env.posts.push(body.text);
    const status = env.postStatus(body.text);
    if (status === "hang") {
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    await sleep(env.fetchDelayFor ? env.fetchDelayFor(body.text) : env.fetchDelayMs);
    if (signal?.aborted) {
      env.postAborted.push(body.text);
      throw abortError();
    }
    if (status !== 200) return new Response("x", { status });
    return new Response(new Blob([`mp3:${body.text}`], { type: "audio/mpeg" }), { status: 200 });
  };
}

type SpeechMod = typeof import("../lib/speech");

interface Run {
  items: number[];
  ends: string[];
  stop: () => void;
}
function startQueue(sp: SpeechMod, items: { text: string; lang: string }[], tag = "Q", throwOnItem = false): Run {
  const run: Run = { items: [], ends: [], stop: () => {} };
  run.stop = sp.speakQueue(items, {
    onItem: (i) => {
      run.items.push(i);
      env.log.push(`${tag}:item${i}`);
      if (throwOnItem) throw new Error("handler boom");
    },
    onEnd: (r) => {
      run.ends.push(r);
      env.log.push(`${tag}:end:${r}`);
    },
  });
  return run;
}
const ko = (text: string) => ({ text, lang: "ko-KR" });
const ja = (text: string) => ({ text, lang: "ja-JP" });
const deviceTexts = () => env.spoken.map((s) => s.text).filter((t) => t.trim());
const queueAudio = () => env.audios.find((a) => a.playCalls > 0 && a.src.startsWith("blob:")) ?? null;
/** 큐 요소 후보(src 없이 만든 요소) — 실행 전체에서 정확히 하나여야 한다. */
const queueEls = () => env.audios.filter((a) => a.ctorNoSrc);
const playingTts = () => env.audios.find((a) => a.isPlayingTts) ?? null;

async function settle(sp: SpeechMod): Promise<void> {
  sp.stopSpeaking();
  sp.__setQueueTiming(null);
  await sleep(15);
  sp.__clearTtsMemoryCache();
  resetEnv();
}

async function main(): Promise<void> {
  process.env.OPENAI_API_KEY = ""; // 방어 — 이 eval은 합성 함수를 부르지 않는다
  installFetchStub();

  // -------------------------------------------------------------------------
  // C. 상수·엔진 (§18-3) — window 없는 상태에서 기본 엔진
  // -------------------------------------------------------------------------
  const sp: SpeechMod = await import("../lib/speech");
  const tts = await import("../lib/tts");

  add(
    "상수·엔진",
    "isTtsLang: ko-KR·en-US·ja-JP true / 'ko'·'zh-CN' false",
    isTtsLang("ko-KR") && isTtsLang("en-US") && isTtsLang("ja-JP") && !isTtsLang("ko") && !isTtsLang("zh-CN"),
    `TTS_LANGS=${TTS_LANGS.join(",")}`,
  );
  add("상수·엔진", "TTS_INSTRUCTIONS_VERSION === 2(ko 추가로 올리지 않음 — 전 언어 캐시 보존)", tts.TTS_INSTRUCTIONS_VERSION === 2, `v=${tts.TTS_INSTRUCTIONS_VERSION}`);
  {
    const empties = TTS_LANGS.filter((l) => !(tts.ttsInstructionsFor(l) ?? "").trim());
    const koInst = tts.ttsInstructionsFor("ko-KR");
    add(
      "상수·엔진",
      "모든 TTS_LANGS의 ttsInstructionsFor 비어 있지 않음 + ko 지시에 일본어 읽기·중국어 금지",
      empties.length === 0 && /Korean/.test(koInst) && /Japanese/.test(koInst) && /Chinese/.test(koInst),
      empties.length ? `빈 지시: ${empties.join(",")}` : short(koInst, 120),
    );
  }
  add(
    "상수·엔진",
    "기본 엔진(window 없음): ko=cloud·ja=device·en=cloud",
    sp.getTtsEngine("ko-KR") === "cloud" && sp.getTtsEngine("ja-JP") === "device" && sp.getTtsEngine("en-US") === "cloud",
    `ko=${sp.getTtsEngine("ko-KR")} ja=${sp.getTtsEngine("ja-JP")} en=${sp.getTtsEngine("en-US")}`,
  );

  // -------------------------------------------------------------------------
  // D. 큐 스텁 (§18-2)
  // -------------------------------------------------------------------------
  installStubs();
  resetEnv();
  add(
    "상수·엔진",
    "기본 엔진(window 있음·저장값 없음): ko=cloud·ja=device·en=cloud",
    sp.getTtsEngine("ko-KR") === "cloud" && sp.getTtsEngine("ja-JP") === "device" && sp.getTtsEngine("en-US") === "cloud",
    `ko=${sp.getTtsEngine("ko-KR")} ja=${sp.getTtsEngine("ja-JP")}`,
  );

  // ① 전부 cloud — 순서·done 1회·POST == 고유 조각 수(짧은→긴 조각 look-ahead 중복 없음)·요소 1개 재사용
  {
    env.fetchDelayMs = 20; // 짧은 조각(5ms)이 끝날 때 다음 조각 look-ahead가 아직 진행 중이게
    const items = [ko("총평."), ko("아주 긴 해설 문장이 이어집니다. 조사를 고쳐 봅시다."), ko("고치면,"), ko("두 번째 긴 설명."), ko("고치면,"), ko("마지막.")];
    const audiosBefore = env.audios.length;
    const r = startQueue(sp, items, "A");
    const done = await waitFor(() => r.ends.length > 0);
    await sleep(30);
    const unique = new Set(items.map((i) => i.text)).size;
    const dupPost = env.posts.length !== new Set(env.posts).size;
    add(
      "큐",
      "① 전부 cloud: onItem 0..n-1 순서·onEnd('done') 1회",
      done && JSON.stringify(r.items) === JSON.stringify([0, 1, 2, 3, 4, 5]) && JSON.stringify(r.ends) === JSON.stringify(["done"]),
      `items=${r.items.join(",")} ends=${r.ends.join(",")}`,
    );
    add(
      "큐",
      "① POST 수 == 고유 조각 수(look-ahead·재생 단계 중복 합성 없음)",
      env.posts.length === unique && !dupPost,
      `POST ${env.posts.length} / 고유 ${unique} : ${env.posts.join("|")}`,
    );
    add("큐", "① 기기 음성 0(전부 클라우드로 재생)", deviceTexts().length === 0, `device=${deviceTexts().join("|")}`);
    add(
      "큐",
      "① 오디오 요소 하나 재사용(iOS 재생 잠금 — 조각마다 new Audio 안 함)",
      env.audios.length - audiosBefore <= 1 && (queueAudio()?.playCalls ?? 0) >= items.length,
      `새 요소 ${env.audios.length - audiosBefore}개, play ${queueAudio()?.playCalls ?? 0}회`,
    );
    add("큐", "⑨ 정상 종료: createObjectURL 수 == revoke 수(무음 URL 제외)", env.urlCreated === env.urlRevoked && env.urlCreated === items.length, `create ${env.urlCreated} / revoke ${env.urlRevoked}`);
    await settle(sp);
  }

  // ⑭ 잠금 해제 — cancel 뒤 볼륨 0 빈 발화, 큐 요소에 무음 WAV play. **speakQueue가 반환된 그 순간(동기)** 을 본다:
  // 큐 요소의 play()가 정확히 1회 늘고 src가 무음 WAV여야 한다(QA F1 — 누적값 단언은 늘 참이라 변이를 못 잡았다).
  {
    const pc0 = queueEls()[0]?.playCalls ?? 0;
    const r = startQueue(sp, [ko("하나.")], "U");
    const els = queueEls();
    const qa = els[0];
    const syncPlay = (qa?.playCalls ?? 0) === pc0 + 1;
    const syncSrc = qa?.src ?? "";
    const lastCancel = env.log.lastIndexOf("cancel");
    const blankIdx = env.log.indexOf("speak: ");
    const blank = env.spoken.find((s) => s.text === " ");
    add(
      "큐",
      "⑭ speakQueue가 첫 await 전에 잠금 해제(cancel → 볼륨0 빈 발화, 큐 요소 src=무음 WAV + play() 1회, 무음 URL은 실행 전체 1개)",
      blankIdx > lastCancel && lastCancel >= 0 && blank?.volume === 0 && syncPlay && syncSrc.startsWith("blob:silent/") && els.length === 1 && silentTotal === 1,
      `log=${env.log.slice(0, 4).join(",")} play+${(qa?.playCalls ?? 0) - pc0} src=${syncSrc} 큐요소=${els.length} 무음URL누적=${silentTotal}`,
    );
    await waitFor(() => r.ends.length > 0);
    await settle(sp);
  }

  // ② 중간 stop — onEnd('stopped')가 stop 안에서 동기 1회, 이후 onItem 없음, pause 호출, 두 번째 stop no-op
  {
    env.audioMs = 60;
    const r = startQueue(sp, [ko("첫째."), ko("둘째."), ko("셋째."), ko("넷째.")], "S");
    await waitFor(() => r.items.includes(1) && playingTts() !== null);
    const qa = playingTts();
    const pausesBefore = qa?.pauseCalls ?? 0;
    const itemsAtStop = r.items.length;
    r.stop();
    const syncEnds = [...r.ends];
    r.stop();
    await sleep(100);
    add(
      "큐",
      "② 중간 stop → onEnd('stopped')가 stop 안에서 동기 1회·두 번째 stop no-op",
      JSON.stringify(syncEnds) === JSON.stringify(["stopped"]) && JSON.stringify(r.ends) === JSON.stringify(["stopped"]),
      `sync=${syncEnds.join(",")} final=${r.ends.join(",")}`,
    );
    add("큐", "② stop 이후 onItem 없음·재생 중 오디오 pause 호출", r.items.length === itemsAtStop && (qa?.pauseCalls ?? 0) > pausesBefore, `items=${r.items.join(",")} pause+${(qa?.pauseCalls ?? 0) - pausesBefore}`);
    add("큐", "⑨ 중간 정지: createObjectURL 수 == revoke 수(무음 URL 제외)", env.urlCreated === env.urlRevoked && env.liveUrls.size === 0, `create ${env.urlCreated} / revoke ${env.urlRevoked}`);
    await settle(sp);
  }

  // ③ 재생 중 speak() → 옛 onEnd가 speak 반환 전에
  {
    env.audioMs = 60;
    const r = startQueue(sp, [ko("가."), ko("나."), ko("다.")], "A");
    await waitFor(() => playingTts() !== null);
    sp.speak("hello there", "en-US");
    env.log.push("speak-returned");
    const iEnd = env.log.indexOf("A:end:stopped");
    const iRet = env.log.indexOf("speak-returned");
    await sleep(120);
    add("큐", "③ 재생 중 speak() → 옛 큐 onEnd('stopped')가 speak 반환 전에(1회)", iEnd >= 0 && iEnd < iRet && JSON.stringify(r.ends) === JSON.stringify(["stopped"]), `end@${iEnd} ret@${iRet} ends=${r.ends.join(",")}`);
    await settle(sp);
  }

  // ④ 재생 중 새 큐 → 옛 onEnd가 새 onItem(0)보다 먼저, 새 큐는 done까지
  {
    env.audioMs = 40;
    const a = startQueue(sp, [ko("에이 하나."), ko("에이 둘.")], "A");
    await waitFor(() => playingTts() !== null);
    const b = startQueue(sp, [ko("비 하나."), ko("비 둘."), ko("비 셋.")], "B");
    const iA = env.log.indexOf("A:end:stopped");
    const iB = env.log.indexOf("B:item0");
    await waitFor(() => b.ends.length > 0);
    await sleep(20);
    add(
      "큐",
      "④ 재생 중 새 speakQueue → 옛 onEnd('stopped')가 새 onItem(0)보다 먼저, 새 큐 done",
      iA >= 0 && iB > iA && JSON.stringify(a.ends) === JSON.stringify(["stopped"]) && JSON.stringify(b.ends) === JSON.stringify(["done"]) && JSON.stringify(b.items) === JSON.stringify([0, 1, 2]),
      `A.end@${iA} B.item0@${iB} A=${a.ends.join(",")} B=${b.ends.join(",")}/${b.items.join(",")}`,
    );
    await settle(sp);
  }

  // ⑤ 끝난 큐의 stop을 다른 speak 재생 중에 불러도 그 재생이 안 죽음
  {
    const a = startQueue(sp, [ko("끝날 큐.")], "A");
    await waitFor(() => a.ends.length > 0);
    env.audioMs = 60;
    sp.speak("still playing", "en-US");
    await waitFor(() => playingTts() !== null);
    const b = playingTts();
    const cancels = env.cancels;
    a.stop();
    await waitFor(() => b?.ended === true, 500);
    add(
      "큐",
      "⑤ 끝난 큐의 stop → 다른 speak 재생 안 죽음(pause 0·cancel 0·끝까지 재생)",
      !!b && b.pauseCalls === 0 && env.cancels === cancels && b.ended && JSON.stringify(a.ends) === JSON.stringify(["done"]),
      `pause=${b?.pauseCalls} cancel+${env.cancels - cancels} ended=${b?.ended} A=${a.ends.join(",")}`,
    );
    await settle(sp);
  }

  // ⑤' 밀려난 큐의 stop도 새 재생을 죽이지 않음
  {
    env.audioMs = 40;
    const a = startQueue(sp, [ko("밀려날 큐."), ko("둘.")], "A");
    await waitFor(() => playingTts() !== null);
    const b = startQueue(sp, [ko("새 큐 하나."), ko("새 큐 둘.")], "B");
    a.stop();
    await waitFor(() => b.ends.length > 0);
    add("큐", "⑤' 밀려난 큐의 stop → 새 큐는 끝까지 done", JSON.stringify(b.ends) === JSON.stringify(["done"]) && JSON.stringify(b.items) === JSON.stringify([0, 1]) && JSON.stringify(a.ends) === JSON.stringify(["stopped"]), `A=${a.ends.join(",")} B=${b.ends.join(",")}/${b.items.join(",")}`);
    await settle(sp);
  }

  // ⑥ 한 조각 POST 500 → 그 조각만 기기 음성·큐 계속
  {
    env.postStatus = (t) => (t === "실패할 조각." ? 500 : 200);
    const r = startQueue(sp, [ko("앞 조각."), ko("실패할 조각."), ko("뒤 조각.")], "F");
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      "⑥ 한 조각 POST 500 → 그 조각만 기기 음성, 큐 done·그 조각 cloud 시도 1회",
      JSON.stringify(deviceTexts()) === JSON.stringify(["실패할 조각."]) && JSON.stringify(r.ends) === JSON.stringify(["done"]) && env.posts.filter((t) => t === "실패할 조각.").length === 1,
      `device=${deviceTexts().join("|")} ends=${r.ends.join(",")} posts=${env.posts.join("|")}`,
    );
    await settle(sp);
  }

  // ⑦ 501 → 이후 POST 0(cloudOff)
  {
    env.postStatus = () => 501;
    const r = startQueue(sp, [ko("하나."), ko("둘."), ko("셋.")], "K");
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      "⑦ 501(키 없음) 한 번 → 이후 조각 POST 0, 전부 기기 음성으로 done",
      env.posts.length === 1 && JSON.stringify(deviceTexts()) === JSON.stringify(["하나.", "둘.", "셋."]) && JSON.stringify(r.ends) === JSON.stringify(["done"]),
      `POST ${env.posts.length} device=${deviceTexts().join("|")}`,
    );
    await settle(sp);
  }

  // ⑧ 기기 onend 안 옴 → 안전 타임아웃으로 진행 / speaking이면 연장 / 상한
  {
    sp.__setQueueTiming({ minMs: 30, perCharMs: 0, slackMs: 0, extendMs: 20 });
    env.deviceMode = "silent";
    const t0 = Date.now();
    const r = startQueue(sp, [{ text: "un", lang: "fr-FR" }, { text: "deux", lang: "fr-FR" }], "D");
    await waitFor(() => r.ends.length > 0, 2000);
    const el = Date.now() - t0;
    add("큐", "⑧ 기기 onend 안 옴 → 안전 타임아웃으로 다음 조각·done", JSON.stringify(r.items) === JSON.stringify([0, 1]) && JSON.stringify(r.ends) === JSON.stringify(["done"]) && el >= 55, `${el}ms items=${r.items.join(",")}`);
    await settle(sp);

    sp.__setQueueTiming({ minMs: 30, perCharMs: 0, slackMs: 0, extendMs: 20 });
    env.deviceMode = { speakingMs: 75 };
    const t1 = Date.now();
    const r2 = startQueue(sp, [{ text: "trois", lang: "fr-FR" }], "E");
    await waitFor(() => r2.ends.length > 0, 2000);
    const el2 = Date.now() - t1;
    add("큐", "⑧ speaking 중이면 1틱씩 연장(추정 30ms를 넘겨 말이 끝난 뒤 진행)", el2 >= 70 && el2 < 600 && JSON.stringify(r2.ends) === JSON.stringify(["done"]), `${el2}ms`);
    await settle(sp);

    // 상한 = 추정 30 × 3 = 90ms. 연장 10ms씩이라 (80, 90] 안에서 끝나야 한다(상한을 넘겨 연장하지 않음).
    sp.__setQueueTiming({ minMs: 30, perCharMs: 0, slackMs: 0, extendMs: 10 });
    env.deviceMode = { speakingMs: 100000 };
    const t2 = Date.now();
    const cancels = env.cancels;
    const r3 = startQueue(sp, [{ text: "quatre", lang: "fr-FR" }], "G");
    await waitFor(() => r3.ends.length > 0, 2000);
    const el3 = Date.now() - t2;
    add("큐", "⑧ 연장 상한(추정×3) → cancel 후 진행", el3 >= 75 && el3 < 600 && env.cancels > cancels && JSON.stringify(r3.ends) === JSON.stringify(["done"]), `${el3}ms cancel+${env.cancels - cancels}`);
    await settle(sp);
  }

  // ⑩ ko 엔진 device → POST 0
  {
    sp.setTtsEngine("ko-KR", "device");
    const r = startQueue(sp, [ko("기기 하나."), ko("기기 둘.")], "V");
    await waitFor(() => r.ends.length > 0);
    add("큐", "⑩ ko 엔진 device → POST 0, 기기 음성으로 done", env.posts.length === 0 && JSON.stringify(deviceTexts()) === JSON.stringify(["기기 하나.", "기기 둘."]) && JSON.stringify(r.ends) === JSON.stringify(["done"]), `POST ${env.posts.length} device=${deviceTexts().join("|")}`);
    sp.setTtsEngine("ko-KR", "cloud");
    await settle(sp);
  }

  // ⑪ 빈 items → onEnd('done') 1회(microtask), 진행 중이던 speak 오디오는 안 멈춤
  {
    env.audioMs = 60;
    sp.speak("keep playing", "en-US");
    await waitFor(() => playingTts() !== null);
    const b = playingTts();
    const cancels = env.cancels;
    const r = startQueue(sp, [ko("   "), { text: "", lang: "ja-JP" }], "E");
    const syncEnds = r.ends.length;
    await sleep(5);
    add(
      "큐",
      "⑪ 빈 items → onEnd('done') microtask 1회, 진행 중 speak 오디오 pause 0·cancel 0",
      syncEnds === 0 && JSON.stringify(r.ends) === JSON.stringify(["done"]) && r.items.length === 0 && b?.pauseCalls === 0 && env.cancels === cancels,
      `sync=${syncEnds} ends=${r.ends.join(",")} pause=${b?.pauseCalls} cancel+${env.cancels - cancels}`,
    );
    await settle(sp);
  }

  // ⑫ 합성 fetch가 안 끝남 + 짧은 타임아웃 → 그 조각 기기 음성·큐 계속
  {
    sp.__setQueueTiming({ fetchMs: 40 });
    env.postStatus = (t) => (t === "매달릴 조각." ? "hang" : 200);
    const r = startQueue(sp, [ko("앞."), ko("매달릴 조각."), ko("뒤.")], "H");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "큐",
      "⑫ 합성 대기 타임아웃 → 그 조각만 기기 음성, 큐 done",
      JSON.stringify(deviceTexts()) === JSON.stringify(["매달릴 조각."]) && JSON.stringify(r.ends) === JSON.stringify(["done"]) && JSON.stringify(r.items) === JSON.stringify([0, 1, 2]),
      `device=${deviceTexts().join("|")} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }

  // ⑬ 소리를 낼 수 없음(기기 음성 미지원 + 501) 연속 3조각 → stopped
  {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.speechSynthesis;
    env.postStatus = () => 501;
    const r = startQueue(sp, [ko("일."), ko("이."), ko("삼."), ko("사."), ko("오.")], "N");
    await waitFor(() => r.ends.length > 0);
    g.speechSynthesis = synth;
    add("큐", "⑬ 연속 3조각 무음(미지원+cloud 불가) → onEnd('stopped'), 이후 조각 안 감", JSON.stringify(r.ends) === JSON.stringify(["stopped"]) && JSON.stringify(r.items) === JSON.stringify([0, 1, 2]), `items=${r.items.join(",")} ends=${r.ends.join(",")}`);
    await settle(sp);
  }

  // ⑮ 큐 요소의 외부 pause(잠금 화면 ⏸·전화) → stopped. 시작 직후(play() 미완료)·재생 도중 두 시점 모두.
  for (const [label, waitMs] of [["재생 도중", 15], ["시작 직후", 0]] as const) {
    env.audioMs = 80;
    const r = startQueue(sp, [ko("외부 정지 하나."), ko("둘."), ko("셋.")], "P");
    await waitFor(() => playingTts() !== null);
    if (waitMs) await sleep(waitMs);
    const itemsAt = r.items.length;
    const devBefore = deviceTexts().length;
    playingTts()?.pause(); // 시스템이 멈춤
    await waitFor(() => r.ends.length > 0, 500);
    await sleep(100);
    add(
      "큐",
      `⑮ 큐 요소 외부 pause(${label}) → onEnd('stopped')·이후 onItem 없음·기기 폴백 안 함`,
      JSON.stringify(r.ends) === JSON.stringify(["stopped"]) && r.items.length === itemsAt && deviceTexts().length === devBefore,
      `ends=${r.ends.join(",")} items=${r.items.join(",")} device=${deviceTexts().join("|")}`,
    );
    await settle(sp);
  }

  // ⑯ 공백 조각 인덱스 보존 + handler 예외 격리 + 재생 중 unlockSpeechPlayback이 큐를 안 끊음
  {
    env.audioMs = 30;
    const r = startQueue(sp, [ko("앞."), ko("   "), ko("뒤.")], "W", true);
    await waitFor(() => playingTts() !== null);
    const qa = playingTts();
    const srcBefore = qa?.src;
    sp.unlockSpeechPlayback();
    const srcAfter = qa?.src;
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      "⑯ 공백 조각은 건너뛰되 인덱스 보존(0,2)·onItem 예외에도 done·재생 중 unlock은 요소를 안 건드림",
      JSON.stringify(r.items) === JSON.stringify([0, 2]) && JSON.stringify(r.ends) === JSON.stringify(["done"]) && srcBefore === srcAfter,
      `items=${r.items.join(",")} ends=${r.ends.join(",")} src ${srcBefore === srcAfter ? "유지" : "바뀜"}`,
    );
    await settle(sp);
  }

  // ⑰ 기존 speak() 경로 불변 — 재생마다 new Audio
  {
    env.audioMs = 5;
    const before = env.audios.length;
    sp.speak("one", "en-US");
    await sleep(30);
    sp.speak("two", "en-US");
    await sleep(30);
    add("큐", "⑰ speak()는 지금처럼 재생마다 new Audio(큐 요소 재사용 안 함)", env.audios.length - before === 2, `new Audio ${env.audios.length - before}개`);
    await settle(sp);
  }

  // ⑱ look-ahead — 조각 0 재생 중 **다음 cloud 조각 2개**를 미리 받는다. device 조각은 세지 않고 건너뛴다(QA F2).
  // 없거나(0개) 너무 많거나(해설 전체 미리 합성 = 비용 가드 위반) device를 세면 스냅숏이 달라진다.
  {
    env.audioMs = 80;
    const items = [ko("앞 조각 영."), ja("いち。"), ko("클라우드 둘."), ja("さん。"), ko("클라우드 넷."), ko("클라우드 다섯."), ko("클라우드 여섯.")];
    const r = startQueue(sp, items, "L");
    await waitFor(() => playingTts() !== null);
    await sleep(25);
    const snap = [...env.posts];
    const itemsAt = [...r.items];
    r.stop();
    const want = ["앞 조각 영.", "클라우드 둘.", "클라우드 넷."];
    add(
      "큐",
      "⑱ look-ahead: 조각 0 재생 중 다음 cloud 2개만 미리 받음(device 조각은 세지 않음·3번째는 안 받음)",
      JSON.stringify(snap) === JSON.stringify(want) && JSON.stringify(itemsAt) === "[0]",
      `POST=${snap.join("|")} items=${itemsAt.join(",")}`,
    );
    await settle(sp);
  }

  // ⑲ 기기 cancel 규칙 — 말하는 중일 때만 cancel(조각마다 무조건 cancel 금지) + 잠금 해제 빈 발화 뒤 예외(QA F3)
  {
    const r = startQueue(sp, [ko("클라우드 하나."), ja("きかい。"), ko("클라우드 둘."), ja("もうひとつ。")], "M");
    const c0 = env.cancels; // 시작 시 cancelPlayback의 cancel까지 포함한 값
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      "⑲ ko cloud + ja device 혼합: 조각 사이 cancel 0·ja는 기기 음성·done",
      env.cancels === c0 && JSON.stringify(deviceTexts()) === JSON.stringify(["きかい。", "もうひとつ。"]) && JSON.stringify(r.ends) === JSON.stringify(["done"]),
      `cancel+${env.cancels - c0} device=${deviceTexts().join("|")} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }
  {
    sp.setTtsEngine("ko-KR", "device");
    const r = startQueue(sp, [ko("기기 첫 조각."), ko("기기 둘째.")], "B");
    const iBlank = env.log.indexOf("speak: ");
    const iFirst = env.log.indexOf("speak:기기 첫 조각.");
    const ordered = iBlank >= 0 && iFirst > iBlank;
    const between = ordered ? env.log.slice(iBlank + 1, iFirst) : [];
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      "⑲ ko device 첫 조각: 잠금 해제 빈 발화(말하는 중)를 cancel하지 않고 뒤에 이어 말함",
      ordered && !between.includes("cancel") && JSON.stringify(r.ends) === JSON.stringify(["done"]) && JSON.stringify(deviceTexts()) === JSON.stringify(["기기 첫 조각.", "기기 둘째."]),
      `순서=${ordered} 사이 로그=[${between.join(",")}] ends=${r.ends.join(",")}`,
    );
    sp.setTtsEngine("ko-KR", "cloud");
    await settle(sp);
  }

  // ⑳ playBlob started 가드 — 캐시 적중 첫 조각은 무음 WAV가 **재생 중일 때** src를 바꾼다. 그때 오는 낡은 pause를
  // 외부 정지(잠금 화면 ⏸)로 오판하면 큐가 첫 조각에서 곧바로 멈춘다(QA F4).
  {
    env.audioMs = 20;
    const a = startQueue(sp, [ko("캐시 적중 조각.")], "C1");
    await waitFor(() => a.ends.length > 0);
    const p0 = env.posts.length; // 메모리 캐시는 비우지 않는다(settle 안 함)
    const b = startQueue(sp, [ko("캐시 적중 조각."), ko("다음 조각.")], "C2");
    await waitFor(() => b.ends.length > 0);
    const newPosts = env.posts.slice(p0);
    add(
      "큐",
      "⑳ 캐시 적중 첫 조각(무음 WAV 재생 중 src 교체) → 낡은 pause 무시·done·기기 폴백 0",
      JSON.stringify(b.ends) === JSON.stringify(["done"]) && JSON.stringify(b.items) === "[0,1]" && !newPosts.includes("캐시 적중 조각.") && deviceTexts().length === 0,
      `ends=${b.ends.join(",")} items=${b.items.join(",")} 새 POST=${newPosts.join("|")}`,
    );
    await settle(sp);
  }

  // ㉑ 합성 대기 타임아웃의 기산점 = 큐가 그 조각을 **기다리기 시작한 때**(§18-2). 앞 조각을 재생하는 동안 흐른
  // look-ahead 시간은 세지 않는다 — 느린 망(매달림 아님)에서 멀쩡한 합성이 기기 음성으로 떨어지지 않게(QA F7).
  {
    sp.__setQueueTiming({ fetchMs: 60 });
    env.audioMs = 80;
    env.fetchDelayFor = (t) => (t === "느린 합성 조각." ? 100 : 3);
    const r = startQueue(sp, [ko("앞 조각이 길어요."), ko("느린 합성 조각.")], "T");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "큐",
      "㉑ 대기 타임아웃은 큐가 기다리기 시작한 때부터 — 앞 조각 재생(80ms) 중 합성 100ms·대기 상한 60ms여도 cloud로 재생",
      deviceTexts().length === 0 && JSON.stringify(r.ends) === JSON.stringify(["done"]) && env.posts.filter((t) => t === "느린 합성 조각.").length === 1,
      `device=${deviceTexts().join("|") || "(없음)"} ends=${r.ends.join(",")} POST=${env.posts.join("|")}`,
    );
    await settle(sp);
  }

  // ㉒ 대기만 타임아웃, 요청은 살려 둔다 — 늦게 끝난 합성은 캐시에 남고, 같은 문장의 뒤 조각은 재합성 없이 cloud로.
  {
    sp.__setQueueTiming({ fetchMs: 30 });
    env.fetchDelayFor = (t) => (t === "늦게 오는 조각." ? 80 : 3);
    env.deviceMs = 100; // 기기 조각이 길어 그동안 살아 있는 요청이 끝난다
    const r = startQueue(sp, [ko("늦게 오는 조각."), ja("あいだ。"), ko("늦게 오는 조각.")], "K");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "큐",
      "㉒ 대기 타임아웃이 나도 요청은 안 끊음 — 그 조각만 기기, 같은 문장 뒤 조각은 그 결과로 cloud(POST 1·abort 0)",
      JSON.stringify(deviceTexts()) === JSON.stringify(["늦게 오는 조각.", "あいだ。"]) &&
        env.posts.filter((t) => t === "늦게 오는 조각.").length === 1 &&
        env.postAborted.length === 0 &&
        JSON.stringify(r.ends) === JSON.stringify(["done"]) &&
        JSON.stringify(r.items) === "[0,1,2]",
      `device=${deviceTexts().join("|")} POST=${env.posts.join("|")} aborted=${env.postAborted.join("|") || "0"} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }

  // ㉓ 클라우드 조각 재생 안전 타임아웃(§18-2) — ended가 끝내 안 오면 duration이 유한할 때 duration×1000+여유,
  // 모르면 기기 추정식 뒤에 소리를 끊고 다음 조각으로(■ 없이는 영영 멈춰 있지 않게).
  {
    env.audioNeverEnds = true;
    env.audioDuration = 0.03;
    sp.__setQueueTiming({ minMs: 5000, perCharMs: 0, slackMs: 0, playSlackMs: 20 }); // 추정식을 쓰면 5초 — 쓰면 안 된다
    const qa = queueEls()[0];
    const pz = qa?.pauseCalls ?? 0;
    const t0 = Date.now();
    const r = startQueue(sp, [ko("끝이 안 오는 하나."), ko("끝이 안 오는 둘.")], "Z");
    await waitFor(() => r.ends.length > 0, 1500);
    const el = Date.now() - t0;
    add(
      "큐",
      "㉓ ended 안 옴 + duration 유한(30ms) → duration×1000+여유(20ms) 뒤 소리 끊고 다음 조각·done",
      JSON.stringify(r.ends) === JSON.stringify(["done"]) && JSON.stringify(r.items) === "[0,1]" && el >= 90 && el < 1500 && (qa?.pauseCalls ?? 0) - pz >= 2 && deviceTexts().length === 0 && env.liveUrls.size === 0,
      `${el}ms pause+${(qa?.pauseCalls ?? 0) - pz} ends=${r.ends.join(",")} 남은URL=${env.liveUrls.size}`,
    );
    await settle(sp);
  }
  {
    env.audioNeverEnds = true; // duration은 NaN(모름)
    sp.__setQueueTiming({ minMs: 40, perCharMs: 0, slackMs: 0, playSlackMs: 5000 });
    const qa = queueEls()[0];
    const pz = qa?.pauseCalls ?? 0;
    const t0 = Date.now();
    const r = startQueue(sp, [ko("길이 모름 하나."), ko("길이 모름 둘.")], "Y");
    await waitFor(() => r.ends.length > 0, 1500);
    const el = Date.now() - t0;
    add(
      "큐",
      "㉓ ended 안 옴 + duration 모름(NaN) → 기기 추정식(40ms) 뒤 소리 끊고 다음 조각·done",
      JSON.stringify(r.ends) === JSON.stringify(["done"]) && JSON.stringify(r.items) === "[0,1]" && el >= 75 && el < 1500 && (qa?.pauseCalls ?? 0) - pz >= 2 && env.liveUrls.size === 0,
      `${el}ms pause+${(qa?.pauseCalls ?? 0) - pz} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }

  add("안전", "네트워크 0 — 큐 검증의 fetch는 전부 스텁(GET 지문 호출 없음: IDB 없는 환경)", totalGets === 0 && totalFetches > 0, `스텁 fetch ${totalFetches}회, GET ${totalGets}`);

  // -------------------------------------------------------------------------
  // E. 지문 공급자·영속 캐시 재시도(§18-2) — 가짜 KV 백엔드를 주입한다. GET도 스텁(네트워크 0).
  // -------------------------------------------------------------------------
  const cache = await import("../lib/tts-cache");
  const blobOf = (s: string) => new Blob([s], { type: "audio/mpeg" });
  const fakeKv = (fp: string | null, entries: Record<string, Blob> = {}) => {
    const m = new Map<string, { blob: Blob; size: number; atime: number }>(Object.entries(entries).map(([k, b]) => [k, { blob: b, size: b.size, atime: 0 }]));
    const st = { fp, gets: 0, clears: 0 };
    const kv: TtsKvBackend = {
      get: async (k) => {
        st.gets++;
        return m.get(k) ?? null;
      },
      put: async (k, e) => void m.set(k, e),
      delete: async (k) => void m.delete(k),
      list: async () => [...m].map(([key, e]) => ({ key, size: e.size, atime: e.atime })),
      clear: async () => {
        st.clears++;
        m.clear();
      },
      getFingerprint: async () => st.fp,
      setFingerprint: async (v) => void (st.fp = v),
    };
    return { kv, st, m };
  };

  // E1 지문 공급자(lib/speech.ts): 200 → 지문 / 비 200 → null(서버가 명시적으로 없음) / 네트워크 실패·타임아웃 → throw(일시 실패)
  {
    const f = (sp as { __fetchTtsFingerprint?: () => Promise<string | null> }).__fetchTtsFingerprint;
    if (typeof f !== "function") {
      add("지문", "지문 공급자: 200 → 지문 / 비 200 → null / 네트워크 실패·타임아웃 → throw", false, "__fetchTtsFingerprint 없음");
    } else {
      const probe = () => f().then((v) => (v === null ? "null" : `값:${v}`), () => "THROW");
      env.getStatus = 200;
      const ok = await probe();
      env.getStatus = 503;
      const none = await probe();
      env.getStatus = "neterr";
      const net = await probe();
      env.getStatus = "hang";
      sp.__setQueueTiming({ fingerprintMs: 30 });
      const t0 = Date.now();
      const hang = await probe();
      const el = Date.now() - t0;
      sp.__setQueueTiming(null);
      add(
        "지문",
        "지문 공급자: 200 → voice|model|i2 / 비 200 → null(명시적 없음) / 네트워크 실패·타임아웃 → throw(일시 실패)",
        ok === "값:alloy|stub|i2" && none === "null" && net === "THROW" && hang === "THROW" && el >= 25 && el < 1000,
        `200=${ok} 503=${none} 네트워크=${net} 매달림=${hang}(${el}ms)`,
      );
    }
    resetEnv();
  }

  // E2 일시 실패 → 이번 조회만 메모리, 다음 접근에서 다시 조회해 IDB 적중(QA F8)
  {
    let n = 0;
    cache.setTtsFingerprintProvider(async () => {
      n++;
      if (n === 1) throw new Error("network");
      return "fp1";
    });
    const { kv, st } = fakeKv("fp1", { k1: blobOf("저장된 오디오") });
    cache.setTtsKvBackend(kv);
    const first = await cache.ttsCacheGet("k1");
    const second = await cache.ttsCacheGet("k1");
    add(
      "지문",
      "지문 조회 일시 실패 → 이번 조회만 메모리(null), 다음 접근에서 다시 조회해 IDB 적중",
      first === null && second !== null && n === 2 && st.clears === 0,
      `1차=${first ? "적중" : "null"} 2차=${second ? "적중" : "null"} 지문조회 ${n}회 clear ${st.clears}`,
    );
  }

  // E3 일시 실패가 계속되면 최대 3회까지만 — 그 뒤 세션은 메모리만
  {
    let n = 0;
    cache.setTtsFingerprintProvider(async () => {
      n++;
      throw new Error("timeout");
    });
    const { kv, st } = fakeKv("fp1", { k1: blobOf("x") });
    cache.setTtsKvBackend(kv);
    const got: (Blob | null)[] = [];
    for (let i = 0; i < 6; i++) got.push(await cache.ttsCacheGet("k1"));
    add("지문", "일시 실패가 이어지면 지문 조회는 최대 3회, 그 뒤 세션은 메모리만(IDB 조회 0)", n === 3 && got.every((g) => g === null) && st.gets === 0, `지문조회 ${n}회 IDB get ${st.gets}`);
  }

  // E4 회귀: 서버가 명시적으로 지문 없음(null) → 기존대로 세션 내내 메모리만(재조회 0)
  {
    let n = 0;
    cache.setTtsFingerprintProvider(async () => {
      n++;
      return null;
    });
    const { kv, st, m } = fakeKv("fp1", { k1: blobOf("x") });
    cache.setTtsKvBackend(kv);
    for (let i = 0; i < 4; i++) await cache.ttsCacheGet("k1");
    await cache.ttsCachePut("k2", blobOf("y"));
    add("지문", "회귀: 서버가 명시적으로 지문 없음(null) → 세션 내내 메모리만(재조회 0·IDB 접근 0)", n === 1 && st.gets === 0 && !m.has("k2"), `지문조회 ${n}회 IDB get ${st.gets} put=${m.has("k2")}`);
  }

  // E5 동시에 온 조회는 한 번의 지문 조회를 함께 기다린다(1회) — 실패하면 다음 접근에서 1회 더
  {
    let n = 0;
    cache.setTtsFingerprintProvider(async () => {
      n++;
      await sleep(10);
      if (n === 1) throw new Error("slow");
      return "fp1";
    });
    const { kv } = fakeKv("fp1", { k1: blobOf("x") });
    cache.setTtsKvBackend(kv);
    const wave = await Promise.all([cache.ttsCacheGet("k1"), cache.ttsCacheGet("k1"), cache.ttsCacheGet("k1")]);
    const nWave = n;
    const later = await cache.ttsCacheGet("k1");
    add(
      "지문",
      "동시 조회 3건은 지문 조회 1회를 함께 기다리고(전부 메모리), 실패 뒤 다음 접근에서 1회 더 → 적중",
      nWave === 1 && wave.every((g) => g === null) && later !== null && n === 2,
      `동시=${nWave}회 이후=${n}회 다음=${later ? "적중" : "null"}`,
    );
  }

  // E6 회귀: 지문이 바뀌면 store를 통째로 비우고 새 지문을 기록(옛 목소리 0)
  {
    cache.setTtsFingerprintProvider(async () => "fp-new");
    const { kv, st, m } = fakeKv("fp-old", { k1: blobOf("옛 목소리") });
    cache.setTtsKvBackend(kv);
    const got = await cache.ttsCacheGet("k1");
    await cache.ttsCachePut("k2", blobOf("새 목소리"));
    add(
      "지문",
      "회귀: 지문이 바뀌면 store 전체 비움 + 새 지문 기록, 이후 저장 정상",
      got === null && st.clears === 1 && st.fp === "fp-new" && m.has("k2") && !m.has("k1"),
      `get=${got ? "적중(옛 목소리!)" : "null"} clear ${st.clears} fp=${st.fp} k2=${m.has("k2")}`,
    );
  }

  // E7 통합(speech → 캐시): 지문 GET이 네트워크 실패한 세션에서도, 다음 재생에서 지문을 다시 받아 IDB 적중(재합성 0).
  // getAudioBlob을 쓰는 모든 화면(영어 단어장 포함) 공통 경로다.
  {
    const f = (sp as { __fetchTtsFingerprint?: () => Promise<string | null> }).__fetchTtsFingerprint;
    const text = "IDB에 있는 해설.";
    const { kv } = fakeKv("alloy|stub|i2", { [`ko-KR:1:${text}`]: blobOf(`mp3:${text}`) });
    cache.setTtsFingerprintProvider(f ?? null);
    cache.setTtsKvBackend(kv);
    env.getStatus = "neterr";
    const r1 = startQueue(sp, [ko(text)], "I1");
    await waitFor(() => r1.ends.length > 0);
    const posts1 = env.posts.length;
    sp.__clearTtsMemoryCache(); // 메모리 캐시를 비워 2차(IDB)를 보게 한다
    env.getStatus = 200;
    const r2 = startQueue(sp, [ko(text)], "I2");
    await waitFor(() => r2.ends.length > 0);
    const posts2 = env.posts.length - posts1;
    add(
      "지문",
      "통합: 지문 GET 네트워크 실패 뒤 다음 재생에서 지문을 다시 받아 IDB 적중(재합성 0) — 저장은 재조회를 일으키지 않음",
      typeof f === "function" && posts1 === 1 && posts2 === 0 && env.gets === 2 && JSON.stringify(r2.ends) === JSON.stringify(["done"]),
      `1차 POST ${posts1} 2차 POST ${posts2} GET ${env.gets} ends=${r1.ends.join(",")}/${r2.ends.join(",")}`,
    );
    await settle(sp);
  }
  cache.setTtsFingerprintProvider(null);
  cache.setTtsKvBackend(null);
}

main()
  .catch((e) => {
    add("실행", "eval 실행 중 예외", false, String((e as Error)?.stack ?? e).slice(0, 300));
  })
  .finally(() => {
    printTable(results);
    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.error(`FAIL — 해설 낭독 ${failed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 해설 낭독 ${results.length}개 항목 통과 (실호출 0회).`);
    process.exit(0);
  });

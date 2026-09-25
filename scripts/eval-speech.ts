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
 * - D. 연속 재생 큐 speakQueue — 가짜 window·Audio·speechSynthesis·fetch·URL을 전역에 깐 뒤 dynamic import (§18-2).
 *      onEnd 둘째 인자 `{ sounded }`(소리를 낸 조각 수 — 하위 호환 추가, 토익 응시 QA P2-A): 짧은 큐 전부 무음 → "done"·0,
 *      연속 3조각 무음 → 여전히 "stopped"(규칙 불변), 인자 하나짜리 기존 핸들러 그대로(S1~S5)
 * - E. 지문 공급자·영속 캐시 재시도 (§18-2)
 * - F. 단발 재생 speak() — 첫 await 전 잠금 해제·재사용 요소, speak ↔ speakQueue 상호 취소, fallbackDevice cancel 규칙,
 *      폰 진단(getTtsPlaybackDiag·TTS_DIAG_EVENT), 설정 변경 시 프리페치 재실행 (§16-5, 2026-09-25 iPhone 무음 신고),
 *      그리고 후속(같은 날 QA·사용자 관찰 "기기랑 클라우드가 꼬인 것 같다"): 늦게 온 옛 합성 토큰 가드(F7)·300자 사전 판정(F8)·
 *      프리페치 상한·배치 교체·stop abort(F9~F11)·밀려난 speak 진단(F12)·iOS paused 복구(F13)·속도 디바운스(F14)·
 *      진행 중 합성 공유와 abort 의미(F15)·매달린 요청에 새로 붙지 않음(F16)
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
  /** 이름이 있으면 클라우드 오디오의 play()가 그 이름의 DOMException으로 거부된다(iOS 'NotAllowedError' 모사). 무음 WAV는 영향 없음. */
  playRejectName: string | null;
  deviceMs: number;
  /** 잠금 해제용 빈 발화(" ")가 말하는 시간(ms). 기본 0(다음 틱). 길게 두면 "빈 발화가 아직 말하는 중"에 폴백이 오는 경우를 만든다. */
  blankMs: number;
  postStatus: (text: string) => Status;
  /** 지문 GET 응답 — 숫자 = 상태 코드, "hang" = 안 끝남(abort로만 끝남), "neterr" = 네트워크 실패(TypeError) */
  getStatus: number | "hang" | "neterr";
  deviceMode: "normal" | "silent" | { speakingMs: number };
  /** 이 문장이면 기기 발화가 곧바로 onerror("synthesis-failed") — 소리를 못 낸 조각(클라우드 불가와 겹치는 이중 실패, 토익 QA E5 조건) */
  deviceFailFor: ((text: string) => boolean) | null;
  /** true면 cancel()이 speechSynthesis를 paused로 굳힌다(iOS WebKit 버그 모사 — 이후 speak()는 resume() 전까지 조용히 무시) */
  pauseOnCancel: boolean;
  /** paused 상태에서 무시된 발화(텍스트) — 실기기에선 에러도 이벤트도 없다 */
  ignored: string[];
  resumes: number;
  posts: string[];
  /** 합성 요청의 speed(posts와 같은 순서) — 속도를 바꾸면 프리페치가 새 속도로 다시 도는지 본다 */
  postSpeeds: number[];
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
  playRejectName: null,
  deviceMs: 5,
  blankMs: 0,
  postStatus: () => 200,
  getStatus: 200,
  deviceMode: "normal",
  deviceFailFor: null,
  pauseOnCancel: false,
  ignored: [],
  resumes: 0,
  posts: [],
  postSpeeds: [],
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
  env.playRejectName = null;
  env.deviceMs = 5;
  env.blankMs = 0;
  env.postStatus = () => 200;
  env.getStatus = 200;
  env.deviceMode = "normal";
  env.deviceFailFor = null;
  env.pauseOnCancel = false;
  env.ignored = [];
  env.resumes = 0;
  synth.paused = false;
  env.posts = [];
  env.postSpeeds = [];
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
        if (!silent && env.playRejectName) {
          this.paused = true;
          reject(new DOMException("play() not allowed", env.playRejectName)); // iOS 탭 밖 재생 차단 모사
          return;
        }
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
  /** iOS WebKit: cancel() 뒤 paused로 굳으면 speak()가 조용히 무시된다(env.pauseOnCancel). resume()으로만 풀린다. */
  paused: false,
  resume() {
    env.resumes++;
    env.log.push("resume");
    this.paused = false;
  },
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
    if (this.paused) {
      // iOS 버그 모사 — 대기열에도 안 들어가고 onend/onerror도 안 온다(그래서 앱은 무음인 줄 모른다)
      env.ignored.push(u.text);
      env.log.push(`ignored:${u.text}`);
      return;
    }
    env.spoken.push({ text: u.text, lang: u.lang, volume: u.volume });
    env.log.push(`speak:${u.text}`);
    if (!u.text.trim()) {
      // 잠금 해제용 무음 발화 — 다음 틱에 끝난다. 그 사이 speaking=true(이때 cancel하면 뒤 발화가 씹히는 게 실기기 증상).
      this.blank = u;
      setTimeout(() => {
        if (this.blank !== u) return;
        this.blank = null;
        u.onend?.({});
      }, env.blankMs);
      return;
    }
    this.current = u;
    if (env.deviceFailFor?.(u.text)) {
      // 합성 실패 — 말하지 않고 곧바로 onerror(실브라우저: synthesis-failed·audio-busy 등). speaking은 false.
      setTimeout(() => {
        if (this.current !== u) return;
        this.current = null;
        u.onerror?.({ error: "synthesis-failed" });
      }, 0);
      return;
    }
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
    if (env.pauseOnCancel) this.paused = true;
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
    // 실제 fetch처럼: 이미 abort된 signal이면 보내지 않고 곧바로 AbortError(POST로 세지 않는다)
    if (signal?.aborted) throw abortError();
    const body = JSON.parse(String(init?.body ?? "{}")) as { text: string; speed?: number };
    env.posts.push(body.text);
    env.postSpeeds.push(Number(body.speed));
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
  /** onEnd 둘째 인자의 sounded(소리를 낸 조각 수) — ends와 같은 순서 */
  sounded: number[];
  stop: () => void;
}
function startQueue(sp: SpeechMod, items: { text: string; lang: string }[], tag = "Q", throwOnItem = false): Run {
  const run: Run = { items: [], ends: [], sounded: [], stop: () => {} };
  run.stop = sp.speakQueue(items, {
    onItem: (i) => {
      run.items.push(i);
      env.log.push(`${tag}:item${i}`);
      if (throwOnItem) throw new Error("handler boom");
    },
    onEnd: (r, info) => {
      run.ends.push(r);
      run.sounded.push(info.sounded);
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
    add("큐", "S1 onEnd 둘째 인자: 전부 소리 냄 → sounded == 조각 수(6)", JSON.stringify(r.sounded) === "[6]", `sounded=${r.sounded.join(",")}`);
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
    add("큐", "S1 중간 stop의 sounded = 끝까지 낸 조각만(0번 끝·1번 도중 정지 → 1)", JSON.stringify(r.sounded) === "[1]", `sounded=${r.sounded.join(",")} items=${r.items.join(",")}`);
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
    // speak()도 큐 요소를 재사용하므로(§16-5) pause 수는 누적값이 아니라 **이 시점부터의 증가분**으로 본다.
    const p0 = b?.pauseCalls ?? 0;
    const cancels = env.cancels;
    a.stop();
    await waitFor(() => b?.ended === true, 500);
    add(
      "큐",
      "⑤ 끝난 큐의 stop → 다른 speak 재생 안 죽음(pause 0·cancel 0·끝까지 재생)",
      !!b && b.pauseCalls === p0 && env.cancels === cancels && b.ended && JSON.stringify(a.ends) === JSON.stringify(["done"]),
      `pause+${(b?.pauseCalls ?? 0) - p0} cancel+${env.cancels - cancels} ended=${b?.ended} A=${a.ends.join(",")}`,
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
    add("큐", "S1 501 → 기기 음성으로 전부 냄 → sounded 3(클라우드 실패 뒤 기기 폴백도 소리 낸 조각)", JSON.stringify(r.sounded) === "[3]", `sounded=${r.sounded.join(",")}`);
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
    // 알 수 없음(오류 이벤트가 없다)은 소리 낸 것으로 본다 — 무음 판정은 명시적 실패(미지원·오류)만. 과민 일시정지를 막는 쪽으로 기운다.
    add("큐", "S1 안전 타임아웃으로 끝난 기기 조각은 소리 낸 것으로 센다(sounded 2 — 오류 이벤트가 없으면 무음이라 단정하지 않음)", JSON.stringify(r.sounded) === "[2]", `sounded=${r.sounded.join(",")}`);
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
    const p0 = b?.pauseCalls ?? 0; // 공유 요소 — 증가분으로 본다
    const cancels = env.cancels;
    const r = startQueue(sp, [ko("   "), { text: "", lang: "ja-JP" }], "E");
    const syncEnds = r.ends.length;
    await sleep(5);
    add(
      "큐",
      "⑪ 빈 items → onEnd('done') microtask 1회, 진행 중 speak 오디오 pause 0·cancel 0",
      syncEnds === 0 && JSON.stringify(r.ends) === JSON.stringify(["done"]) && r.items.length === 0 && !!b && b.pauseCalls === p0 && env.cancels === cancels,
      `sync=${syncEnds} ends=${r.ends.join(",")} pause+${(b?.pauseCalls ?? 0) - p0} cancel+${env.cancels - cancels}`,
    );
    add("큐", "S1 빈 items → onEnd('done', { sounded: 0 })", JSON.stringify(r.sounded) === "[0]", `sounded=${r.sounded.join(",")}`);
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
    add("큐", "S2 ⑬의 sounded 0", JSON.stringify(r.sounded) === "[0]", `sounded=${r.sounded.join(",")}`);
    await settle(sp);
  }

  // S3 짧은 큐(1~2조각)가 전부 무음 — 클라우드 불가(501) + 기기 음성 오류(synthesis-failed). 토익 응시 QA P2-A의 조건.
  //    "stopped" 규칙(연속 3조각)은 그대로라 "done"이지만 sounded 0으로 알린다 — 호출부(응시 질문 음성)가 다시 판정한다.
  for (const n of [1, 2]) {
    env.postStatus = () => 501;
    env.deviceFailFor = () => true;
    const items = [ko("질문 도입."), ko("질문 본문.")].slice(0, n);
    const r = startQueue(sp, items, `Z${n}`);
    await waitFor(() => r.ends.length > 0);
    add(
      "큐",
      `S3 짧은 큐 ${n}조각 전부 무음(501 + 기기 synthesis-failed) → 기기 폴백 시도 후 onEnd('done', { sounded: 0 }) — 3조각 규칙 불변, 무음은 인자로`,
      JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.sounded) === "[0]" && JSON.stringify(r.items) === JSON.stringify(items.map((_, i) => i)) && JSON.stringify(deviceTexts()) === JSON.stringify(items.map((i) => i.text)),
      `ends=${r.ends.join(",")} sounded=${r.sounded.join(",")} items=${r.items.join(",")} device=${deviceTexts().join("|")}`,
    );
    await settle(sp);
  }

  // S4 기존 3조각 규칙 유지 — 같은 이중 실패로 정확히 3조각이면 "stopped"(0), 앞에 소리 낸 조각이 있어도 연속 3이면 "stopped"(1),
  //    무음이 연속 2에서 끊기면(사이에 소리 낸 조각) 끝까지 "done"(2). 무음 조각은 기기 오류로만 만든다(클라우드 501).
  {
    const cases: { label: string; texts: string[]; fail: string[]; ends: string; sounded: number; items: number[] }[] = [
      { label: "3조각 전부 무음", texts: ["일.", "이.", "삼."], fail: ["일.", "이.", "삼."], ends: "stopped", sounded: 0, items: [0, 1, 2] },
      { label: "소리 1 + 무음 3(+뒤 1)", texts: ["소리.", "일.", "이.", "삼.", "뒤."], fail: ["일.", "이.", "삼."], ends: "stopped", sounded: 1, items: [0, 1, 2, 3] },
      { label: "무음 2 · 소리 · 무음 2 · 소리", texts: ["일.", "이.", "소리.", "삼.", "사.", "끝."], fail: ["일.", "이.", "삼.", "사."], ends: "done", sounded: 2, items: [0, 1, 2, 3, 4, 5] },
    ];
    for (const c of cases) {
      env.postStatus = () => 501;
      env.deviceFailFor = (t) => c.fail.includes(t);
      const r = startQueue(sp, c.texts.map(ko), "T");
      await waitFor(() => r.ends.length > 0);
      add(
        "큐",
        `S4 3조각 규칙 유지(${c.label}) → ${c.ends}·sounded ${c.sounded}`,
        JSON.stringify(r.ends) === JSON.stringify([c.ends]) && JSON.stringify(r.sounded) === JSON.stringify([c.sounded]) && JSON.stringify(r.items) === JSON.stringify(c.items),
        `ends=${r.ends.join(",")} sounded=${r.sounded.join(",")} items=${r.items.join(",")}`,
      );
      await settle(sp);
    }
  }

  // S5 하위 호환 — 인자 하나짜리 기존 핸들러(일본어 해설·운동 안내·토익 전체 듣기의 모양)는 그대로 동작하고,
  //    둘째 인자는 늘 넘어온다(모든 끝 경로: done·stop·빈 items).
  {
    const legacy: string[] = [];
    const argc: number[] = [];
    const stopA = sp.speakQueue([ko("하나."), ko("둘.")], {
      onEnd: (r) => {
        legacy.push(r);
      },
    });
    await waitFor(() => legacy.length > 0);
    const b = sp.speakQueue([ko("멈출 조각."), ko("안 갈 조각.")], {
      onEnd: function (...args: unknown[]) {
        argc.push(args.length);
      },
    });
    b();
    sp.speakQueue([ko("  ")], {
      onEnd: function (...args: unknown[]) {
        argc.push(args.length);
      },
    });
    await waitFor(() => argc.length >= 2);
    stopA(); // 끝난 큐의 stop — no-op
    add(
      "큐",
      "S5 하위 호환: 인자 하나짜리 onEnd는 그대로 done / 둘째 인자는 stop·빈 items 경로에도 늘 넘어온다",
      JSON.stringify(legacy) === '["done"]' && JSON.stringify(argc) === "[2,2]",
      `legacy=${legacy.join(",")} argc=${argc.join(",")}`,
    );
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

  // ⑰ speak()도 큐 요소 하나를 재사용한다(§16-5, 2026-09-25 — iOS가 합성 대기 뒤 new Audio의 play()를 막아 무음이던 사고).
  // 예전 단언("재생마다 new Audio")을 뒤집었다. 탭 안에서 풀어 둔 요소를 돌려 써야 비동기 뒤 재생이 통한다.
  {
    env.audioMs = 5;
    const before = env.audios.length;
    sp.speak("one", "en-US");
    await sleep(30);
    sp.speak("two", "en-US");
    await sleep(30);
    const qa = queueEls()[0];
    add(
      "큐",
      "⑰ speak()도 재생마다 new Audio 대신 큐 요소 하나를 재사용(§16-5) — 새 요소 0·POST 2·기기 음성 0",
      env.audios.length - before === 0 && queueEls().length === 1 && (qa?.src ?? "").startsWith("blob:") && env.posts.length === 2 && deviceTexts().length === 0,
      `new Audio ${env.audios.length - before}개 큐요소=${queueEls().length} POST=${env.posts.join("|")} device=${deviceTexts().join("|") || "0"}`,
    );
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

  // -------------------------------------------------------------------------
  // F. 단발 재생 speak() — iOS 잠금 해제·재사용 요소·폴백 cancel·폰 진단·프리페치 재실행 (§16-5, 2026-09-25 추가)
  //    사용자 신고: iPhone Safari에서 일본어 엔진을 "클라우드"로 두면 🔊가 무음(합성 대기 뒤 new Audio.play()가 막힘 →
  //    대체 기기 음성도 cancel 직후 speak라 씹힘). 여기 항목들은 그 두 고리와 진단·프리페치 공백을 잠근다.
  // -------------------------------------------------------------------------
  interface DiagLike {
    at: string;
    lang: string;
    ok: boolean;
    stage: string | null;
    reason: string | null;
    fallback: string | null;
  }
  const spx = sp as unknown as { getTtsPlaybackDiag?: (lang: string) => DiagLike | null; TTS_DIAG_EVENT?: string };
  const diagOf = (lang: string): DiagLike | null => (typeof spx.getTtsPlaybackDiag === "function" ? spx.getTtsPlaybackDiag(lang) : null);
  const diagEvents: { lang?: string }[] = [];
  if (typeof spx.TTS_DIAG_EVENT === "string") {
    (globalThis as unknown as EventTarget).addEventListener(spx.TTS_DIAG_EVENT, (e) => {
      diagEvents.push(((e as CustomEvent).detail ?? {}) as { lang?: string });
    });
  }
  const dshort = (d: DiagLike | null) => (d ? `${d.ok ? "ok" : "fail"}/${d.stage}/${d.reason}/${d.fallback}` : "(없음)");

  // F1 — speak()(cloud)이 반환되는 그 순간(동기)에 잠금 해제가 끝나 있어야 한다(⑭의 speak 판).
  {
    sp.setTtsEngine("ja-JP", "cloud");
    env.audioMs = 20;
    const qa = queueEls()[0];
    const pc0 = qa?.playCalls ?? 0;
    const audiosBefore = env.audios.length;
    sp.speak("ねこ", "ja-JP");
    const syncPlay = (qa?.playCalls ?? 0) === pc0 + 1;
    const syncSrc = qa?.src ?? "";
    const lastCancel = env.log.lastIndexOf("cancel");
    const blankIdx = env.log.indexOf("speak: ");
    const blank = env.spoken.find((s) => s.text === " ");
    const played = await waitFor(() => (qa?.src ?? "").startsWith("blob:tts/") && qa?.ended === true, 1000);
    await sleep(10);
    add(
      "단발",
      "F1 speak()(cloud)이 첫 await 전에 잠금 해제 — 반환 순간 큐 요소 src=무음 WAV + play() 1회, cancel 뒤 볼륨0 빈 발화",
      syncPlay && syncSrc.startsWith("blob:silent/") && lastCancel >= 0 && blankIdx > lastCancel && blank?.volume === 0,
      `play+${(qa?.playCalls ?? 0) - pc0} src=${syncSrc || "(없음)"} log=${env.log.slice(0, 3).join(",")}`,
    );
    add(
      "단발",
      "F1 합성 뒤 재생도 그 재사용 요소로 — new Audio 0·POST 1·기기 음성 0·URL 생성 == 회수",
      played && env.audios.length === audiosBefore && queueEls().length === 1 && env.posts.join("|") === "ねこ" && deviceTexts().length === 0 && env.urlCreated === 1 && env.urlRevoked === 1,
      `재생=${played} 새 요소 ${env.audios.length - audiosBefore} POST=${env.posts.join("|")} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated}/${env.urlRevoked}`,
    );
    await settle(sp);
  }

  // F2 — 연타: 두 번째 🔊가 첫 재생을 **동기로** 끊는다(같은 요소 — pause·URL 회수). 기기 폴백·진단 실패 0.
  {
    env.audioMs = 60;
    sp.speak("いち", "ja-JP");
    await waitFor(() => playingTts() !== null);
    const qa = playingTts();
    const firstUrl = qa?.src ?? "";
    const p0 = qa?.pauseCalls ?? 0;
    sp.speak("に", "ja-JP");
    const firstRevokedSync = firstUrl !== "" && !env.liveUrls.has(firstUrl);
    const pausedSync = (qa?.pauseCalls ?? 0) > p0;
    // 무음 WAV(잠금 해제)도 ended가 되므로 "둘째 TTS URL이 만들어지고 회수될 때까지"를 기다린다.
    const ended = await waitFor(() => env.urlCreated >= 2 && env.liveUrls.size === 0 && (qa?.src ?? "").startsWith("blob:tts/") && qa?.ended === true, 1000);
    add(
      "단발",
      "F2 연타: 두 번째 speak가 첫 재생을 반환 전에 끊음(pause·URL 회수) → 같은 요소로 둘째 재생, 기기 폴백 0·URL 2/2",
      pausedSync && firstRevokedSync && ended && deviceTexts().length === 0 && env.urlCreated === 2 && env.urlRevoked === 2 && queueEls().length === 1,
      `pause동기=${pausedSync} 첫URL회수=${firstRevokedSync} 끝=${ended} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated}/${env.urlRevoked}`,
    );
    await settle(sp);
  }

  // F3 — speak ↔ speakQueue 상호 취소·onEnd 규약: 공유 요소에서도 서로를 동기로 끊는다.
  {
    env.audioMs = 60;
    sp.speak("うた", "ja-JP");
    await waitFor(() => playingTts() !== null);
    const speakUrl = playingTts()?.src ?? "";
    const r = startQueue(sp, [ko("큐 하나."), ko("큐 둘.")], "SQ");
    const speakStoppedSync = speakUrl !== "" && !env.liveUrls.has(speakUrl);
    await waitFor(() => r.ends.length > 0, 1500);
    const r2 = startQueue(sp, [ko("둘째 큐 하나."), ko("둘째 큐 둘.")], "SQ2");
    await waitFor(() => playingTts() !== null && r2.items.length > 0);
    sp.speak("おわり", "ja-JP");
    env.log.push("speak-returned");
    const iEnd = env.log.indexOf("SQ2:end:stopped");
    const iRet = env.log.indexOf("speak-returned");
    const fin = await waitFor(() => env.posts.includes("おわり") && env.liveUrls.size === 0 && playingTts() === null, 1500);
    add(
      "단발",
      "F3 speak 재생 중 speakQueue → speak 오디오 동기 정지(URL 회수)·큐 done / 큐 재생 중 speak → 옛 onEnd('stopped') 1회가 speak 반환 전에, 기기 폴백 0",
      speakStoppedSync && JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.items) === "[0,1]" && iEnd >= 0 && iEnd < iRet && JSON.stringify(r2.ends) === '["stopped"]' && fin && deviceTexts().length === 0 && env.urlCreated === env.urlRevoked,
      `speak동기정지=${speakStoppedSync} SQ=${r.ends.join(",")}/${r.items.join(",")} SQ2.end@${iEnd} ret@${iRet} SQ2=${r2.ends.join(",")} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated}/${env.urlRevoked}`,
    );
    await settle(sp);
  }

  // F4 — fallbackDevice의 cancel 규칙(§18-2 speakDeviceAwait와 같게): 쉬고 있으면 cancel 안 함, 잠금 해제 빈 발화 뒤엔 잇고,
  //      정말로 다른 발화가 말하는 중일 때만 cancel.
  {
    sp.setTtsEngine("ja-JP", "device");
    env.log = [];
    sp.speak("いぬ", "ja-JP");
    const logDevice = [...env.log];
    await sleep(20);

    sp.setTtsEngine("ja-JP", "cloud");
    env.postStatus = () => 500;
    env.log = [];
    sp.speak("さる", "ja-JP");
    await waitFor(() => deviceTexts().includes("さる"), 500);
    const iBlank = env.log.indexOf("speak: ");
    const iText = env.log.indexOf("speak:さる");
    const between = iBlank >= 0 && iText > iBlank ? env.log.slice(iBlank + 1, iText) : ["(순서 틀림)"];
    await sleep(20);

    // 빈 발화가 **아직 말하는 중**(speaking=true)에 합성 실패가 온다 — 그래도 cancel하지 않고 뒤에 잇는다(잠금 해제 예외).
    env.blankMs = 60;
    env.log = [];
    sp.speak("くま", "ja-JP");
    await waitFor(() => deviceTexts().includes("くま"), 500);
    const iBlank2 = env.log.indexOf("speak: ");
    const iKuma = env.log.indexOf("speak:くま");
    const between2 = iBlank2 >= 0 && iKuma > iBlank2 ? env.log.slice(iBlank2 + 1, iKuma) : ["(순서 틀림)"];
    env.blankMs = 0;
    await sleep(80);

    env.deviceMs = 200;
    env.log = [];
    sp.speak("とら", "ja-JP");
    synth.speak(new FakeUtterance("다른 발화")); // 우리 것이 아닌 발화가 말하는 중
    await waitFor(() => deviceTexts().includes("とら"), 500);
    const iOther = env.log.indexOf("speak:다른 발화");
    const iTora = env.log.indexOf("speak:とら");
    const cancelBetween = iOther >= 0 && iTora > iOther && env.log.slice(iOther + 1, iTora).includes("cancel");
    add(
      "단발",
      "F4 fallbackDevice: device 직행은 cancel 1회(cancelPlayback 것)뿐·클라우드 실패 뒤엔 빈 발화를 cancel하지 않고 잇고·남의 발화가 말하는 중일 때만 cancel",
      JSON.stringify(logDevice) === JSON.stringify(["cancel", "speak:いぬ"]) &&
        !between.includes("cancel") &&
        !between.includes("(순서 틀림)") &&
        !between2.includes("cancel") &&
        !between2.includes("(순서 틀림)") &&
        cancelBetween,
      `device=[${logDevice.join(",")}] cloud500 빈발화~본문=[${between.join(",")}] 빈발화 말하는 중=[${between2.join(",")}] 남의발화중 cancel=${cancelBetween}`,
    );
    await settle(sp);
  }

  // F5 — 폰 진단(서버 로그 대신): 성공·501·재생 거부(NotAllowedError)·대기 타임아웃·대체 불가 + 이벤트 + 언어별 분리
  {
    sp.setTtsEngine("ja-JP", "cloud");
    env.audioMs = 5;
    const ev0 = diagEvents.length;
    sp.speak("はな", "ja-JP");
    await waitFor(() => diagOf("ja-JP")?.ok === true, 500);
    const dOk = diagOf("ja-JP");
    add(
      "단발",
      "F5 진단 성공: {ok, lang ja-JP, stage·reason·fallback null, at=ISO} + TTS_DIAG_EVENT(detail.lang)",
      !!dOk && dOk.ok && dOk.lang === "ja-JP" && dOk.stage === null && dOk.reason === null && dOk.fallback === null && Number.isFinite(Date.parse(dOk.at)) && diagEvents.slice(ev0).some((e) => e.lang === "ja-JP"),
      `${dshort(dOk)} 이벤트+${diagEvents.length - ev0}`,
    );
    await settle(sp);

    env.postStatus = () => 501;
    sp.speak("みず", "ja-JP");
    await waitFor(() => deviceTexts().includes("みず") && diagOf("ja-JP")?.ok === false, 500);
    const d501 = diagOf("ja-JP");
    add(
      "단발",
      "F5 진단 501: 합성 단계 'tts 501' → 기기 음성으로 대체(그리고 실제로 기기가 말함)",
      d501?.ok === false && d501.stage === "synth" && d501.reason === "tts 501" && d501.fallback === "device" && deviceTexts().includes("みず"),
      `${dshort(d501)} device=${deviceTexts().join("|")}`,
    );
    await settle(sp);

    env.playRejectName = "NotAllowedError";
    sp.speak("そら", "ja-JP");
    await waitFor(() => deviceTexts().includes("そら") && diagOf("ja-JP")?.reason === "NotAllowedError", 500);
    const dNa = diagOf("ja-JP");
    add(
      "단발",
      "F5 진단 재생 거부: 재생 단계 'NotAllowedError' → 기기 음성으로 대체, URL 회수",
      dNa?.ok === false && dNa.stage === "play" && dNa.reason === "NotAllowedError" && dNa.fallback === "device" && deviceTexts().includes("そら") && env.liveUrls.size === 0,
      `${dshort(dNa)} device=${deviceTexts().join("|")} 남은URL=${env.liveUrls.size}`,
    );
    await settle(sp);

    sp.__setQueueTiming({ fetchMs: 40 });
    env.postStatus = (t) => (t === "やま" ? "hang" : 200);
    const t0 = Date.now();
    sp.speak("やま", "ja-JP");
    await waitFor(() => deviceTexts().includes("やま"), 1000);
    const el = Date.now() - t0;
    const dTo = diagOf("ja-JP");
    add(
      "단발",
      "F5 진단 대기 타임아웃: 합성이 안 끝나면 fetchMs 뒤 'timeout' → 기기 음성(무음으로 매달리지 않음)",
      dTo?.ok === false && dTo.stage === "synth" && dTo.reason === "timeout" && dTo.fallback === "device" && deviceTexts().includes("やま") && el >= 35 && el < 1000,
      `${dshort(dTo)} ${el}ms`,
    );
    await settle(sp);

    const g = globalThis as unknown as Record<string, unknown>;
    delete g.speechSynthesis;
    env.postStatus = () => 500;
    sp.speak("かわ", "ja-JP");
    await waitFor(() => diagOf("ja-JP")?.reason === "tts 500", 500);
    g.speechSynthesis = synth;
    const dNone = diagOf("ja-JP");
    add("단발", "F5 진단 대체 불가: 기기 음성 미지원 + 'tts 500' → fallback 'none'", dNone?.ok === false && dNone.reason === "tts 500" && dNone.fallback === "none", dshort(dNone));
    await settle(sp);

    // 큐의 클라우드 조각도 같은 진단을 남기고, 언어별로 따로 둔다(ko 실패가 ja 기록을 덮지 않음).
    const jaBefore = diagOf("ja-JP");
    env.postStatus = (t) => (t === "큐 실패 조각." ? 500 : 200);
    const r = startQueue(sp, [ko("큐 실패 조각.")], "DQ");
    await waitFor(() => r.ends.length > 0);
    const dKo = diagOf("ko-KR");
    add(
      "단발",
      "F5 진단 큐 조각: ko-KR 'tts 500' → 기기 음성 기록, ja-JP 기록은 그대로(언어별)",
      dKo?.ok === false && dKo.lang === "ko-KR" && dKo.stage === "synth" && dKo.reason === "tts 500" && dKo.fallback === "device" && JSON.stringify(diagOf("ja-JP")) === JSON.stringify(jaBefore),
      `ko=${dshort(dKo)} ja=${dshort(diagOf("ja-JP"))}`,
    );
    await settle(sp);
  }

  // F6 — 설정 변경 시 프리페치 재실행(화면 코드 수정 없이 speech.ts 한 곳에서): device → cloud 전환, 속도 변경,
  //      같은 설정 재탭(진행 중 요청을 끊지 않음), device 전환(중단), 화면 이탈 뒤(재실행 없음).
  {
    const texts = ["いぬ", "ねこ", "とり"];
    sp.__setQueueTiming({ rateDebounceMs: 20 }); // 속도 재실행 디바운스(기본 600ms)를 줄인다 — 디바운스 자체는 F14가 잠근다
    sp.setTtsEngine("ja-JP", "device");
    const stop = sp.prefetchSpeech(texts, "ja-JP");
    await sleep(20);
    const postsDevice = env.posts.length;

    env.fetchDelayMs = 30;
    sp.setTtsEngine("ja-JP", "cloud");
    await sleep(5);
    sp.setTtsEngine("ja-JP", "cloud"); // 같은 설정 재탭 — 진행 중 배치를 끊고 다시 돌면 안 된다
    await waitFor(() => env.posts.length >= 3, 1000);
    await sleep(80);
    const afterCloud = [...env.posts];
    const abortedCloud = env.postAborted.length;
    const speedsCloud = [...env.postSpeeds];

    env.fetchDelayMs = 3;
    sp.setTtsRate(0.7); // 천천히 → 클라우드 0.85
    await waitFor(() => env.posts.length >= 6, 1000);
    await sleep(20);
    const speedsSlow = env.postSpeeds.slice(3);
    sp.setTtsRate(0.7); // 같은 속도 재탭
    await sleep(20);
    const postsSameRate = env.posts.length;

    env.fetchDelayMs = 40;
    sp.setTtsRate(1.1); // 빠르게 → 1.15(디바운스 뒤 재실행), 2개가 날아가는 중에
    await waitFor(() => env.posts.length >= 8, 500);
    sp.setTtsEngine("ja-JP", "device"); // device로 바꾸면 그 언어 배치 중단
    await sleep(80);
    const postsAfterDevice = env.posts.length;
    const abortedDevice = env.postAborted.length;

    stop(); // 화면 이탈
    env.fetchDelayMs = 3;
    sp.setTtsEngine("ja-JP", "cloud");
    sp.setTtsRate(0.9);
    await sleep(60); // 디바운스(20ms)가 지난 뒤에도
    const postsAfterStop = env.posts.length;

    add(
      "단발",
      "F6 device 언어의 프리페치도 기억 → 엔진을 cloud로 바꾸는 순간 새 설정으로 재실행(POST 0 → 3, speed 1.0)·같은 설정 재탭은 진행 중 요청을 안 끊음",
      postsDevice === 0 && afterCloud.length === 3 && [...afterCloud].sort().join("|") === [...texts].sort().join("|") && speedsCloud.every((v) => v === 1) && abortedCloud === 0,
      `device POST ${postsDevice} → cloud POST ${afterCloud.join("|")} speed=${speedsCloud.join(",")} abort=${abortedCloud}`,
    );
    add(
      "단발",
      "F6 속도 변경 → 마지막 프리페치를 새 클라우드 속도로 재실행(3개 @0.85)·같은 속도 재탭은 POST 0",
      speedsSlow.length === 3 && speedsSlow.every((v) => v === 0.85) && postsSameRate === 6,
      `slow speeds=${speedsSlow.join(",")} 같은속도 뒤 POST ${postsSameRate}`,
    );
    add(
      "단발",
      "F6 device로 바꾸면 그 언어 배치 즉시 중단(진행 중 2개 abort·추가 POST 없음) / 화면 이탈(stop) 뒤엔 설정을 바꿔도 재실행 없음",
      postsAfterDevice === 8 && abortedDevice === 2 && postsAfterStop === postsAfterDevice,
      `device 전환 뒤 POST ${postsAfterDevice} abort ${abortedDevice} / stop 뒤 POST ${postsAfterStop}`,
    );
    sp.setTtsEngine("ja-JP", "device");
    await settle(sp);
  }

  // F7 — 늦게 온 옛 합성이 공유 요소의 새 재생을 뺏지 못한다(playViaCloud의 **합성 뒤** 토큰 가드). speak가 큐 요소를 같이 쓰게
  //      되면서 이 가드가 핵심이 됐다 — 빠지면 합성이 느린 옛 speak가 재생 중인 새 speak의 src를 바꿔 새 재생이 끝나지 않고
  //      objectURL이 샌다(2026-09-25 QA #1, 원형 G1).
  {
    sp.setTtsEngine("ja-JP", "cloud");
    env.audioMs = 150;
    env.fetchDelayFor = (t) => (t === "おそい" ? 80 : 3);
    sp.speak("おそい", "ja-JP");
    await sleep(10);
    sp.speak("はやい", "ja-JP");
    await waitFor(() => playingTts() !== null, 500);
    const b = playingTts();
    const bSrc = b?.src ?? "";
    const p0 = b?.pauseCalls ?? 0;
    await sleep(120); // おそい 합성 도착(80ms) 뒤에도 はやい가 계속 재생 중이어야 한다
    const stillSame = bSrc !== "" && (b?.src ?? "") === bSrc && !b?.paused;
    await waitFor(() => b?.ended === true, 600);
    await sleep(20);
    add(
      "단발",
      "F7 늦게 온 옛 speak 합성이 공유 요소의 새 재생을 안 뺏음(src 유지·pause 0·끝까지·URL 1/1·남은 URL 0)",
      stillSame && b?.pauseCalls === p0 && b?.ended === true && env.urlCreated === 1 && env.urlRevoked === 1 && env.liveUrls.size === 0,
      `같은src·재생중=${stillSame} pause+${(b?.pauseCalls ?? 0) - p0} ended=${b?.ended} URL ${env.urlCreated}/${env.urlRevoked} live=${env.liveUrls.size} POST=${env.posts.join("|")}`,
    );
    await settle(sp);
  }

  // F8 — 300자 초과는 cloud 엔진이어도 speak가 **사전에** 기기로 보낸다: POST 0·잠금 해제 0(큐 요소 play·빈 발화 없음)·기기 1(§16-1, 원형 G3)
  {
    sp.setTtsEngine("en-US", "cloud");
    const long = "a ".repeat(160).trim() + " end."; // 324자
    const qa = queueEls()[0];
    const pc0 = qa?.playCalls ?? 0;
    env.log = [];
    sp.speak(long, "en-US");
    await waitFor(() => deviceTexts().includes(long), 300);
    await sleep(20);
    add(
      "단발",
      "F8 300자 초과 speak → POST 0·큐 요소 play 0·빈 발화 0·기기 음성 1(사전 판정)",
      long.length > TTS_TEXT_MAX_CHARS && env.posts.length === 0 && (qa?.playCalls ?? 0) === pc0 && !env.log.includes("speak: ") && deviceTexts().includes(long),
      `len=${long.length} POST=${env.posts.length} play+${(qa?.playCalls ?? 0) - pc0} log=${env.log.slice(0, 3).map((l) => short(l, 24)).join(",")}`,
    );
    await settle(sp);
  }

  // F9 — 프리페치 개수 상한 PREFETCH_MAX_ITEMS(비용 가드): 200개를 줘도 첫 배치 90, 속도 변경 재실행도 90(원형 G4)
  {
    sp.setTtsEngine("en-US", "cloud");
    sp.__setQueueTiming({ rateDebounceMs: 10 });
    const texts = Array.from({ length: 200 }, (_, i) => `word${i}`);
    env.fetchDelayMs = 0;
    const stop = sp.prefetchSpeech(texts, "en-US");
    await waitFor(() => env.posts.length >= sp.PREFETCH_MAX_ITEMS, 3000);
    await sleep(50);
    const n1 = env.posts.length;
    sp.setTtsRate(0.7);
    await waitFor(() => env.posts.length - n1 >= sp.PREFETCH_MAX_ITEMS, 3000);
    await sleep(50);
    const n2 = env.posts.length - n1;
    stop();
    sp.setTtsRate(0.9);
    add(
      "단발",
      "F9 프리페치 상한 PREFETCH_MAX_ITEMS: 200개 입력 → 첫 배치 POST 90·속도 변경 재실행 POST 90",
      sp.PREFETCH_MAX_ITEMS === 90 && n1 === sp.PREFETCH_MAX_ITEMS && n2 === sp.PREFETCH_MAX_ITEMS,
      `첫=${n1} 재실행=${n2} (상한 ${sp.PREFETCH_MAX_ITEMS})`,
    );
    await settle(sp);
  }

  /** 클라이언트 쪽 동시 진행 POST 수를 재는 fetch 덮개(abort되면 그 순간 닫힌 것으로 센다 — 브라우저가 요청을 버리는 시점). */
  const countInflight = () => {
    const g = globalThis as unknown as { fetch: (i: unknown, init?: RequestInit) => Promise<Response> };
    const realFetch = g.fetch;
    const m = { now: 0, max: 0, restore: () => void (g.fetch = realFetch) };
    g.fetch = async (i: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() !== "POST") return realFetch(i, init);
      m.now++;
      m.max = Math.max(m.max, m.now);
      let open = true;
      const close = () => {
        if (open) {
          open = false;
          m.now--;
        }
      };
      init?.signal?.addEventListener("abort", close, { once: true });
      try {
        return await realFetch(i, init);
      } finally {
        close();
      }
    };
    return m;
  };

  // F10 — 새 배치(다른 화면의 prefetchSpeech — 자식·부모 효과 순서처럼 앞 화면이 stop하기 전에 온다)는 직전 배치를 끊는다:
  //       끊긴 배치의 새 POST 0·진행 중 2개 abort·동시 진행 POST ≤ 2(원형 G5, 속도 경로는 F14)
  {
    sp.setTtsEngine("en-US", "cloud");
    const a = Array.from({ length: 20 }, (_, i) => `screenA${i}`);
    const b = Array.from({ length: 6 }, (_, i) => `screenB${i}`);
    const m = countInflight();
    env.fetchDelayMs = 20;
    const stopA = sp.prefetchSpeech(a, "en-US");
    await sleep(30);
    const countA = () => env.posts.filter((t) => t.startsWith("screenA")).length;
    const aBefore = countA();
    const stopB = sp.prefetchSpeech(b, "en-US");
    await waitFor(() => env.posts.filter((t) => t.startsWith("screenB")).length >= b.length, 1000);
    await sleep(40);
    const aAfter = countA() - aBefore;
    const abortedA = env.postAborted.filter((t) => t.startsWith("screenA")).length;
    m.restore();
    stopA();
    stopB();
    add(
      "단발",
      "F10 다음 화면의 프리페치가 직전 배치를 끊음 — 끊긴 배치 새 POST 0·진행 중 2개 abort·동시 진행 POST ≤ 2",
      aAfter === 0 && abortedA === 2 && m.max <= 2 && env.posts.filter((t) => t.startsWith("screenB")).length === b.length,
      `A: 전환 전 ${aBefore}·뒤 +${aAfter}·abort ${abortedA} / B ${env.posts.filter((t) => t.startsWith("screenB")).length} / 최대 동시 ${m.max}`,
    );
    await settle(sp);
  }

  // F11 — 화면 이탈(prefetch 중단 함수): 진행 중 요청 abort·이후 POST 0(원형 G6)
  {
    sp.setTtsEngine("en-US", "cloud");
    const texts = Array.from({ length: 10 }, (_, i) => `leave${i}`);
    env.fetchDelayMs = 30;
    const stop = sp.prefetchSpeech(texts, "en-US");
    await sleep(10);
    stop();
    const n0 = env.posts.length;
    await sleep(150);
    add(
      "단발",
      "F11 prefetch stop(화면 이탈) → 진행 중 2개 abort·이후 POST 0",
      n0 === 2 && env.postAborted.length === 2 && env.posts.length === n0,
      `stop 시 POST ${n0} → ${env.posts.length}, abort ${env.postAborted.length}`,
    );
    await settle(sp);
  }

  // F12 — 밀려난 speak의 대기 타임아웃이 새 재생의 진단(✓)을 덮지 않고 기기 음성도 내지 않는다(catch의 토큰 가드, 원형 G7)
  {
    sp.setTtsEngine("ja-JP", "cloud");
    sp.__setQueueTiming({ fetchMs: 40 });
    env.audioMs = 5;
    env.postStatus = (t) => (t === "まつ" ? "hang" : 200);
    sp.speak("まつ", "ja-JP");
    await sleep(5);
    sp.speak("いま", "ja-JP");
    await waitFor(() => diagOf("ja-JP")?.ok === true && env.urlRevoked >= 1, 300);
    await sleep(80); // まつ의 40ms 대기 상한이 지난 뒤
    const d = diagOf("ja-JP");
    add(
      "단발",
      "F12 밀려난 speak의 타임아웃이 진단을 덮지 않음(마지막 = ✓)·기기 음성 0",
      !!d && d.ok && deviceTexts().length === 0,
      `diag=${dshort(d)} device=${deviceTexts().join("|") || "0"}`,
    );
    await settle(sp);
  }

  // F13 — iOS WebKit 멈춤 복구: cancel() 뒤 speechSynthesis가 paused로 굳어 이후 speak()가 조용히 무시되는 버그(스텁 pauseOnCancel).
  //       기기 음성으로 **말하기 직전**마다(fallbackDevice·잠금 해제 빈 발화·speakDeviceAwait) paused면 resume()해야 들린다.
  //       사용자 관찰(2026-09-25) "기기랑 클라우드가 꼬인 것 같다. 속도를 바꾸다 보면 다시 나오기도 한다"의 기기 쪽 고리.
  {
    // (a) device 엔진 단발 — cancelPlayback의 cancel()로 굳음 → fallbackDevice가 resume 뒤 발화
    sp.setTtsEngine("ja-JP", "device");
    env.pauseOnCancel = true;
    env.log = [];
    sp.speak("しろ", "ja-JP");
    const logA = env.log.join(",");
    const aOk = deviceTexts().includes("しろ") && !env.ignored.includes("しろ");
    await sleep(20);
    // (c) cloud 실패 → 기기 대체 — 합성 대기 중 굳어도(시스템) fallbackDevice가 resume 뒤 발화
    sp.setTtsEngine("ja-JP", "cloud");
    env.postStatus = () => 500;
    env.fetchDelayMs = 20;
    env.ignored = [];
    sp.speak("あか", "ja-JP");
    synth.paused = true;
    await waitFor(() => deviceTexts().includes("あか") || env.ignored.includes("あか"), 500);
    const cOk = deviceTexts().includes("あか") && !env.ignored.includes("あか");
    await sleep(10);
    add(
      "단발",
      "F13 iOS paused 복구 — fallbackDevice: device 단발(cancel → resume → 발화)·클라우드 실패 대체(대기 중 굳어도) 모두 실제 발화(무시 0)",
      aOk && logA === "cancel,resume,speak:しろ" && cOk,
      `device 단발=${aOk} log=[${logA}] 실패 대체=${cOk} 무시=${env.ignored.join("|") || "0"}`,
    );
    await settle(sp);

    // (b) cloud 단발의 잠금 해제 빈 발화 — cancel()로 굳음 → 빈 발화가 무시되면 탭 밖 기기 대체가 안 풀린다
    sp.setTtsEngine("ja-JP", "cloud");
    env.pauseOnCancel = true;
    env.log = [];
    const urls0 = env.urlCreated;
    sp.speak("くろ", "ja-JP");
    const iCancel = env.log.lastIndexOf("cancel");
    const iResume = env.log.indexOf("resume");
    const iBlank = env.log.indexOf("speak: ");
    const bOk = iCancel >= 0 && iResume > iCancel && iBlank > iResume && !env.ignored.includes(" ");
    await waitFor(() => env.urlCreated > urls0 && env.liveUrls.size === 0, 500);
    add(
      "단발",
      "F13 iOS paused 복구 — 잠금 해제 빈 발화: cancel → resume → 볼륨0 빈 발화(무시 0)",
      bOk,
      `log=[${env.log.slice(0, 5).join(",")}] 무시=${env.ignored.map((t) => JSON.stringify(t)).join("|") || "0"}`,
    );
    await settle(sp);

    // (d) 큐의 기기 조각 — 조각 사이에 굳어도 speakDeviceAwait가 resume 뒤 발화
    sp.setTtsEngine("ko-KR", "device");
    sp.__setQueueTiming({ minMs: 30, perCharMs: 0, slackMs: 0, extendMs: 10 }); // 무시되면 안전 타임아웃으로 빨리 끝나게
    const ends: string[] = [];
    sp.speakQueue([ko("기기 조각 하나."), ko("기기 조각 둘.")], {
      onItem: (i) => {
        if (i === 1) synth.paused = true; // 앞 조각이 끝난 뒤 굳음
      },
      onEnd: (r) => void ends.push(r),
    });
    await waitFor(() => ends.length > 0, 1000);
    const dOk = deviceTexts().includes("기기 조각 둘.") && !env.ignored.includes("기기 조각 둘.");
    add(
      "단발",
      "F13 iOS paused 복구 — 큐 기기 조각(speakDeviceAwait): 조각 사이에 굳어도 resume 뒤 발화·done",
      dOk && JSON.stringify(ends) === '["done"]',
      `device=${deviceTexts().join("|")} 무시=${env.ignored.join("|") || "0"} ends=${ends.join(",")}`,
    );
    sp.setTtsEngine("ko-KR", "cloud");
    await settle(sp);
  }

  // F14 — 속도 연타 비용 가드(2026-09-25 QA #2: 5회 연타에 합성 8건이 전부 버려짐): 재실행은 마지막 조작 뒤 한 번(trailing 디바운스),
  //       연타 끝이 이미 받은 속도면 POST 0, 옛 속도 배치는 누르는 순간 멈춘다(디바운스를 기다리는 동안 옛 속도 합성을 더 쌓지 않음).
  {
    sp.setTtsEngine("en-US", "cloud");
    sp.__setQueueTiming({ rateDebounceMs: 150 });
    const texts = ["tap one", "tap two", "tap three", "tap four", "tap five", "tap six"];
    env.fetchDelayMs = 3;
    const stop = sp.prefetchSpeech(texts, "en-US"); // 보통(0.9) → 클라우드 1.0
    await waitFor(() => env.posts.length >= texts.length, 1000);
    await sleep(20);
    const n0 = env.posts.length;
    // 간격(60ms) < 디바운스(150ms) < 연타 전체(240ms) — 조작마다 타이머를 다시 걸지 않으면 중간 속도 배치가 샌다
    for (const r of [1.1, 0.7, 1.1, 0.7, 1.1]) {
      sp.setTtsRate(r);
      await sleep(60);
    }
    await sleep(40); // 마지막 조작 뒤 ~100ms — 디바운스(150ms) 전
    const duringTaps = env.posts.length - n0;
    await waitFor(() => env.posts.length - n0 >= texts.length, 1000);
    await sleep(60);
    const burst = env.postSpeeds.slice(n0);

    stop();
    sp.setTtsRate(0.9);
    await sleep(200); // 디바운스가 지나도 stop 뒤라 재실행 없음
    // 새 화면: 보통(1.0)으로 다 받은 뒤, 아직 안 받은 속도(0.85·1.15)를 거쳐 받은 속도(보통)로 돌아온다
    const texts3 = ["back one", "back two", "back three"];
    env.fetchDelayMs = 3;
    const stop3 = sp.prefetchSpeech(texts3, "en-US");
    await waitFor(() => texts3.every((t) => env.posts.includes(t)), 1000);
    await sleep(20);
    const n1 = env.posts.length;
    for (const r of [0.7, 1.1, 0.7, 0.9]) {
      sp.setTtsRate(r); // 끝은 이미 받은 속도(보통 → 1.0)
      await sleep(60);
    }
    await sleep(250);
    const backToCached = env.posts.length - n1;
    stop3();

    // 옛 속도 배치가 도는 중에 속도를 바꾼다
    const texts2 = ["slow one", "slow two", "slow three", "slow four"];
    env.fetchDelayMs = 60;
    const stop2 = sp.prefetchSpeech(texts2, "en-US"); // 1.0
    await sleep(10); // 2개 진행 중
    const n2 = env.posts.length;
    sp.setTtsRate(0.7); // → 0.85
    await sleep(80); // 진행 중 2개가 끝났을 시각, 디바운스(150ms) 전
    const abortedAtTap = env.postAborted.filter((t) => texts2.includes(t)).length;
    const oldSpeedAfterTap = env.postSpeeds.slice(n2).filter((v) => v === 1).length;
    await waitFor(() => env.postSpeeds.filter((v) => v === 0.85).length >= texts2.length, 1500);
    await sleep(20);
    const newBatch = env.posts.slice(n2).filter((_, k) => env.postSpeeds[n2 + k] === 0.85).length;
    stop2();
    sp.setTtsRate(0.9);
    add(
      "단발",
      "F14 속도 5회 연타 → 누르는 동안 POST 0, 마지막 조작 뒤 마지막 속도 배치만(6개 @1.15)",
      duringTaps === 0 && burst.length === texts.length && burst.every((v) => v === 1.15),
      `연타 중 POST ${duringTaps} → 뒤 ${burst.length}개 speed=${[...new Set(burst)].join(",")}`,
    );
    add("단발", "F14 연타 끝이 이미 받은 속도 → 재실행 POST 0", backToCached === 0, `POST +${backToCached}`);
    add(
      "단발",
      "F14 옛 속도 배치 진행 중 속도 변경 → 진행 중 2개 즉시 abort·옛 속도 새 POST 0 → 디바운스 뒤 새 속도 배치",
      abortedAtTap === 2 && oldSpeedAfterTap === 0 && newBatch === texts2.length,
      `abort ${abortedAtTap} 옛속도 POST ${oldSpeedAfterTap} 새 배치 ${newBatch}`,
    );
    await settle(sp);
  }

  // F15 — 진행 중 합성 공유(in-flight): 같은 문장을 🔊·프리페치·큐가 동시에 원하면 합성 요청은 하나(QA #2 — 속도 바꾼 직후 🔊가
  //       재실행 프리페치와 같은 문장을 두 번 합성). abort 의미: 한 소비자가 떠나도 다른 소비자가 기다리는 요청은 안 끊고,
  //       마지막 소비자가 떠나면 끊고(서버·상류까지), 끊긴 요청에는 새 소비자가 붙지 않는다(새로 보낸다).
  {
    sp.setTtsEngine("en-US", "cloud");
    env.fetchDelayMs = 40;
    env.audioMs = 5;
    const count = (t: string) => env.posts.filter((p) => p === t).length;
    const played = (n: number) => env.urlCreated >= n && env.liveUrls.size === 0 && env.urlRevoked >= n;

    sp.speak("shared first", "en-US"); // 🔊 먼저
    await sleep(5);
    const stopA = sp.prefetchSpeech(["shared first", "other a"], "en-US");
    await waitFor(() => played(1) && count("other a") === 1, 1000);
    await sleep(50);
    const a = { post: count("shared first"), device: deviceTexts().length, url: env.urlCreated };
    stopA();
    await settle(sp);

    env.fetchDelayMs = 40;
    env.audioMs = 5;
    const stopB = sp.prefetchSpeech(["shared second"], "en-US"); // 프리페치 먼저
    await sleep(5);
    sp.speak("shared second", "en-US");
    await waitFor(() => played(1), 1000);
    const b = { post: count("shared second"), device: deviceTexts().length };
    stopB();
    await settle(sp);
    add(
      "단발",
      "F15 🔊 ↔ 프리페치 같은 문장 동시 → 합성 POST 1(어느 쪽이 먼저든)·🔊는 클라우드로 재생",
      a.post === 1 && a.device === 0 && a.url === 1 && b.post === 1 && b.device === 0,
      `🔊먼저 POST ${a.post}·device ${a.device}·URL ${a.url} / 프리페치먼저 POST ${b.post}·device ${b.device}`,
    );

    env.fetchDelayMs = 40;
    env.audioMs = 5;
    const stopC = sp.prefetchSpeech(["shared third"], "en-US");
    await sleep(5);
    sp.speak("shared third", "en-US");
    await sleep(5);
    stopC(); // 화면 이탈 — 🔊가 기다리는 요청은 끊지 않는다
    await waitFor(() => played(1), 1000);
    await sleep(20);
    const c = { post: count("shared third"), aborted: env.postAborted.length, device: deviceTexts().length, url: env.urlCreated };
    await settle(sp);

    env.fetchDelayMs = 40;
    const stopD = sp.prefetchSpeech(["alone"], "en-US");
    await sleep(5);
    stopD(); // 혼자 기다리던 소비자 — 요청을 끊는다
    await sleep(70);
    const d = { aborted: env.postAborted.join("|") };
    await settle(sp);
    add(
      "단발",
      "F15 abort 의미 — 프리페치 stop은 🔊가 같이 기다리는 요청을 안 끊음(POST 1·abort 0·클라우드 재생) / 혼자면 끊음(abort 1)",
      c.post === 1 && c.aborted === 0 && c.device === 0 && c.url === 1 && d.aborted === "alone",
      `공유 POST ${c.post}·abort ${c.aborted}·device ${c.device}·URL ${c.url} / 혼자 abort=${d.aborted || "0"}`,
    );

    env.fetchDelayMs = 40;
    env.audioMs = 5;
    const r = startQueue(sp, [ko("같이 쓰는 문장.")], "IF");
    await sleep(5);
    sp.speak("같이 쓰는 문장.", "ko-KR"); // 큐 취소 → 큐 혼자 기다리던 요청 abort → 🔊는 끊긴 요청에 붙지 않고 새로
    await waitFor(() => played(1) && count("같이 쓰는 문장.") === 2, 1000);
    await sleep(60);
    const dk = diagOf("ko-KR");
    add(
      "단발",
      "F15 끊긴 요청에 새 소비자가 안 붙음 — 큐 합성 대기 중 같은 문장 🔊 → 큐 요청 abort·🔊는 새 POST로 클라우드 재생(기기 0)",
      JSON.stringify(r.ends) === '["stopped"]' && count("같이 쓰는 문장.") === 2 && env.postAborted.join("|") === "같이 쓰는 문장." && deviceTexts().length === 0 && env.urlCreated === 1 && !!dk?.ok,
      `큐=${r.ends.join(",")} POST ${count("같이 쓰는 문장.")} abort=${env.postAborted.join("|") || "0"} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated} diag=${dshort(dk)}`,
    );
    await settle(sp);
  }

  // F16 — 합성 대기 상한(fetchMs)을 넘긴 요청에는 새로 붙지 않는다: 매달린 합성으로 기기 대체된 뒤 같은 🔊를 다시 누르면
  //       새로 요청해 클라우드로 난다(진행 중 공유가 매달린 요청에 계속 묶어 두지 않게).
  {
    sp.setTtsEngine("ja-JP", "cloud");
    sp.__setQueueTiming({ fetchMs: 40 });
    env.audioMs = 5;
    let n = 0;
    env.postStatus = (t) => (t === "つる" && n++ === 0 ? "hang" : 200);
    sp.speak("つる", "ja-JP");
    await waitFor(() => deviceTexts().includes("つる"), 500);
    await sleep(15);
    sp.speak("つる", "ja-JP");
    await waitFor(() => env.urlCreated >= 1 && env.urlRevoked >= 1 && env.liveUrls.size === 0, 500);
    await sleep(20);
    const d = diagOf("ja-JP");
    add(
      "단발",
      "F16 매달린 요청(대기 상한 초과)에는 안 붙음 — 다시 누른 🔊는 새 POST로 클라우드 재생(기기 대체는 첫 번째 1회뿐)",
      env.posts.filter((t) => t === "つる").length === 2 && deviceTexts().filter((t) => t === "つる").length === 1 && env.urlCreated === 1 && !!d?.ok,
      `POST ${env.posts.filter((t) => t === "つる").length} device ${deviceTexts().filter((t) => t === "つる").length} URL ${env.urlCreated} diag=${dshort(d)}`,
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

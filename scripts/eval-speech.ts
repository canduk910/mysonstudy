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
 * - G. 영속 캐시 v2 형식·자가 치유 (§16-5, 2026-09-27 iPhone "재생 NotSupportedError") — 바이트 저장·조회 때 오디오 레코드 재기록 0·
 *      옛 Blob 이전(G1~G9, G17)·자가 치유 1회와 대상(G10~G13, G15·G16)·content-type(G14), 그리고 QA 2회차 eval 공백 보강:
 *      큐 치유의 fromCache 가드(G18)·치유 삭제는 먼저 시작된 저장 뒤(G19)·빈 옛 레코드(G5 확장·G20)
 * - H. 조각 뒤 쉼 `pauseAfterMs`(docs/harness/toeic.md §12-5-2·§12-10, 2026-09-27 — 템플릿 따라 말하기·공략 읽기 "영어만" 틈):
 *      쉼 = 같은 큐 요소의 무음 WAV 조각 1회(H1)·입력 재구성의 칸 보존과 칸 없는 큐 불변(H2)·말 속도 배율(H3)·상한·250ms 올림·
 *      길이 칸 재사용(H4)·공백 조각·마지막 조각(H5)·쉼 도중 멈춤 세 경로와 외부 pause(H6)·타이머 폴백과 stop 자기일 때만(H7)·
 *      무음 조각 안전 타임아웃(H8)·sounded·무음 연속 판정 무관(H9)·onPause 예외 격리(H10)·쉼 도중 속도 변경(H11)·
 *      그 조각이 실제로 난 경로의 배율(H3 실제 속도 — 클라우드 설정인데 기기로 폴백한 조각)
 * - I. 범위 미리 받기 `prepareSpeech` — 고유·클라우드만(제외 대상은 상한 앞)·캐시 건너뜀·90 상한·진행 단조·abort·501·프리페치와 독립·
 *      대기 상한(P1~P8)·도중 기기 엔진 전환도 진행에 셈(P9)
 * - J. 잠금 화면 조작 `lib/media-session.ts` — 기존 경로는 Media Session을 건드리지 않는다·걸고 풀기·낡은 풀기 무시·미지원(M1~M4)
 *
 * 끝까지 못 간 실행은 FAIL(exit 1)이다 — 비동기 대기가 풀리지 않아 이벤트 루프가 비면 beforeExit, 루프가 붙잡혀 있으면 워치독(파일 끝).
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
  /**
   * 못 트는 오디오(손상 표식 CORRUPT·죽은 옛 Blob)를 재생하면 WebKit처럼 실패한다 — "play": play()가 NotSupportedError로 거부,
   * "event": error 이벤트(error.code = mediaErrorCode)가 먼저 온 뒤 play()도 거부(Chrome·WebKit 모두 가능한 순서).
   */
  mediaErrorVia: "play" | "event";
  mediaErrorCode: number;
  /** 합성 응답 본문(기본 `mp3:{text}`) — "CORRUPT…"면 재생할 수 없는 오디오 */
  postBodyFor: ((text: string) => string) | null;
  /** 합성 응답 content-type(기본 audio/mpeg) — 200인데 오디오가 아닌 응답 모사 */
  postContentTypeFor: ((text: string) => string) | null;
  deviceMs: number;
  /**
   * 쉼 무음 WAV(0.1초 잠금 해제용이 아닌 것)의 가짜 재생 길이 배율 — null이면 예전처럼 2ms. 숫자면 round(WAV 길이 × 배율)ms
   * (헤더에서 읽은 길이 — 쉼 도중 멈춤을 잡을 수 있게 늘린다). duration도 그 값으로 알린다(실브라우저처럼 재생 길이 = duration).
   */
  silentScale: number | null;
  /** 이름이 있으면 쉼 무음 WAV의 play()가 그 이름의 DOMException으로 거부된다(타이머 폴백 검증). 잠금 해제용 WAV는 영향 없음. */
  silentRejectName: string | null;
  /** true면 쉼 무음 WAV의 ended가 끝내 안 온다(재생 안전 타임아웃 검증). */
  silentNeverEnds: boolean;
  /** 쉼 무음 WAV 재생 기록(시작 순) — 헤더에서 읽은 길이·재생한 요소·URL */
  silentPlays: { ms: number; el: FakeAudio; url: string }[];
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
  mediaErrorVia: "play",
  mediaErrorCode: 4,
  postBodyFor: null,
  postContentTypeFor: null,
  deviceMs: 5,
  silentScale: null,
  silentRejectName: null,
  silentNeverEnds: false,
  silentPlays: [],
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
  env.mediaErrorVia = "play";
  env.mediaErrorCode = 4;
  env.postBodyFor = null;
  env.postContentTypeFor = null;
  env.deviceMs = 5;
  env.silentScale = null;
  env.silentRejectName = null;
  env.silentNeverEnds = false;
  env.silentPlays = [];
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

// ---- Blob 모사(2026-09-27 NotSupportedError) --------------------------------------------------------------
// 재생할 수 없는 오디오를 두 갈래로 만든다: ① 손상 표식 — 첫 바이트가 "CORRUPT"인 내용(Blob 생성 시 동기로 판별),
// ② 죽은 옛 Blob — WebKit이 이전 프로세스의 IDB Blob 레코드를 다시 쓰면 꺼낸 Blob이 읽히지 않는 결함(QA F1)의 모사.
// 재생은 createObjectURL이 기억한 Blob으로 판정한다(FakeAudio).
const NodeBlob = globalThis.Blob;
const CORRUPT = "CORRUPT";
function partIsCorrupt(p: unknown): boolean {
  if (typeof p === "string") return p.startsWith(CORRUPT);
  if (p instanceof ArrayBuffer || ArrayBuffer.isView(p)) {
    const u8 = p instanceof ArrayBuffer ? new Uint8Array(p) : new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    return new TextDecoder().decode(u8.subarray(0, CORRUPT.length)) === CORRUPT;
  }
  return !!(p as { __corrupt?: boolean } | null)?.__corrupt;
}
class SniffBlob extends NodeBlob {
  __corrupt: boolean;
  constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
    super(parts, opts);
    this.__corrupt = (parts ?? []).some((p) => partIsCorrupt(p));
  }
}
/** 옛 형식(v1) IDB Blob — dead가 되면 읽기(arrayBuffer·text)가 NotFoundError, 재생은 NotSupportedError. */
class DeadableBlob extends SniffBlob {
  dead = false;
  /** 매달림 모사 — 읽기가 끝나지 않는다 */
  hang = false;
  override arrayBuffer(): Promise<ArrayBuffer> {
    if (this.hang) return new Promise<ArrayBuffer>(() => {});
    if (this.dead) return Promise.reject(new DOMException("The object can not be found here.", "NotFoundError"));
    return super.arrayBuffer();
  }
  override text(): Promise<string> {
    if (this.dead) return Promise.reject(new DOMException("The object can not be found here.", "NotFoundError"));
    return super.text();
  }
}
/**
 * 바이트 읽기가 늦게 끝나는 Blob — 저장(`ttsCachePut`)이 바이트를 읽는 동안 자가 치유의 삭제가 끼어드는 경합을 만든다(G19).
 * 실기기에선 큰 오디오·바쁜 메인 스레드에서 `arrayBuffer()`가 한참 걸릴 수 있다.
 */
class SlowReadBlob extends SniffBlob {
  delayMs = 0;
  override arrayBuffer(): Promise<ArrayBuffer> {
    const read = () => super.arrayBuffer();
    return sleep(this.delayMs).then(read);
  }
}
/**
 * 재생할 수 없는 소스 — 손상 표식·죽은 옛 Blob·**0바이트**(실브라우저에서 빈 오디오는 MEDIA_ERR_SRC_NOT_SUPPORTED다.
 * 빈 옛 레코드가 미스 판정을 빠져나오면 재생 실패 → 치유 1회로 드러나게 — G20).
 */
const isUnplayable = (b: Blob | undefined): boolean =>
  !!b && ((b as DeadableBlob).dead === true || (b as SniffBlob).__corrupt === true || b.size === 0);
/** createObjectURL이 만든 tts URL → 그 Blob(재생 판정·형식 확인용) */
const urlBlob = new Map<string, Blob>();
let lastTtsUrl = "";
/** 무음 WAV URL → 그 Blob(헤더 확인용)·길이(ms — 8kHz·8bit·mono라 (바이트 − 44) ÷ 8). 잠금 해제용 0.1초는 100. */
const silentBlobOf = new Map<string, Blob>();
const silentMsOf = new Map<string, number>();

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
  /** HTMLMediaElement.error 모사 — 못 트는 소스면 { code } */
  error: { code: number } | null = null;
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
    this.error = null;
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
        const silentMs = silent ? (silentMsOf.get(this._src) ?? 100) : 0;
        /** 쉼 무음 조각(잠금 해제용 0.1초가 아닌 무음 WAV) */
        const pauseWav = silent && silentMs > 100;
        if (pauseWav && env.silentRejectName) {
          this.paused = true;
          env.log.push(`silent-reject:${silentMs}`);
          reject(new DOMException("silent play rejected", env.silentRejectName));
          return;
        }
        if (!silent && isUnplayable(urlBlob.get(this._src))) {
          // WebKit: 읽을 수 없는 Blob → error.code 4 + play() NotSupportedError(QA 1절 d·p·q)
          this.paused = true;
          this.error = { code: env.mediaErrorCode };
          if (env.mediaErrorVia === "event") this.onerror?.();
          reject(new DOMException("The operation is not supported.", "NotSupportedError"));
          return;
        }
        if (!silent && env.playRejectName) {
          this.paused = true;
          reject(new DOMException("play() not allowed", env.playRejectName)); // iOS 탭 밖 재생 차단 모사
          return;
        }
        if (!silent) this.duration = env.audioDuration;
        const dur = silent ? (pauseWav && env.silentScale !== null ? Math.max(1, Math.round(silentMs * env.silentScale)) : 2) : env.audioMs;
        if (pauseWav) {
          this.duration = dur / 1000;
          env.silentPlays.push({ ms: silentMs, el: this, url: this._src });
          env.log.push(`silent:${silentMs}`);
        }
        resolve();
        if (!silent && env.audioNeverEnds) return; // ended가 끝내 안 온다
        if (pauseWav && env.silentNeverEnds) return; // 쉼 무음 조각의 ended가 끝내 안 온다
        this.endTimer = setTimeout(() => {
          if (g !== this.gen || this.paused) return;
          this.ended = true;
          this.paused = true;
          if (pauseWav) env.log.push(`silent-end:${silentMs}`);
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
  g.Blob = SniffBlob; // speech.ts·tts-cache.ts가 만드는 Blob도 손상 표식을 판별한다(호출 시점에 전역을 읽는다)
  let seq = 0;
  URL.createObjectURL = ((b: Blob) => {
    seq++;
    if (b.type === "audio/wav") {
      env.silentCreated++;
      silentTotal++;
      const su = `blob:silent/${seq}`;
      silentBlobOf.set(su, b);
      silentMsOf.set(su, (b.size - 44) / 8);
      return su;
    }
    env.urlCreated++;
    const u = `blob:tts/${seq}`;
    env.liveUrls.add(u);
    urlBlob.set(u, b);
    lastTtsUrl = u;
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
    const payload = env.postBodyFor ? env.postBodyFor(body.text) : `mp3:${body.text}`;
    const ct = env.postContentTypeFor ? env.postContentTypeFor(body.text) : "audio/mpeg";
    return new Response(payload, { status: 200, headers: { "content-type": ct } });
  };
}

type SpeechMod = typeof import("../lib/speech");

interface Run {
  items: number[];
  ends: string[];
  /** onEnd 둘째 인자의 sounded(소리를 낸 조각 수) — ends와 같은 순서 */
  sounded: number[];
  /** onPause(i, ms) 기록 — 쉼 칸이 없는 큐에서는 늘 비어 있다(H) */
  pauses: [number, number][];
  stop: () => void;
}
function startQueue(sp: SpeechMod, items: { text: string; lang: string; pauseAfterMs?: number }[], tag = "Q", throwOnItem = false): Run {
  const run: Run = { items: [], ends: [], sounded: [], pauses: [], stop: () => {} };
  run.stop = sp.speakQueue(items, {
    onItem: (i) => {
      run.items.push(i);
      env.log.push(`${tag}:item${i}`);
      if (throwOnItem) throw new Error("handler boom");
    },
    onPause: (i, ms) => {
      run.pauses.push([i, ms]);
      env.log.push(`${tag}:pause${i}:${ms}`);
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
  // H. 조각 뒤 쉼 pauseAfterMs (docs/harness/toeic.md §12-5-2·§12-10, 2026-09-27) — 템플릿 따라 말하기·공략 읽기 "영어만" 틈.
  //    쉼 = 같은 큐 오디오 요소로 트는 무음 WAV 조각(잠금 화면에서도 오디오 세션이 이어지게), 못 틀면 타이머. 칸이 없으면 예전 경로.
  //    예문은 전부 지어낸 것이다.
  // -------------------------------------------------------------------------
  const en = (text: string, pauseAfterMs?: number) =>
    pauseAfterMs === undefined ? { text, lang: "en-US" } : { text, lang: "en-US", pauseAfterMs };
  const kop = (text: string, pauseAfterMs: number) => ({ text, lang: "ko-KR", pauseAfterMs });
  /** WAV 헤더와 본문 — 8kHz·8bit·mono 무음이면 길이(ms)가 헤더에서 읽힌다. */
  const wavInfo = async (b: Blob | undefined) => {
    if (!b) return null;
    const buf = await b.arrayBuffer();
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") return null;
    const ch = v.getUint16(22, true);
    const rate = v.getUint32(24, true);
    const bits = v.getUint16(34, true);
    const dataBytes = v.getUint32(40, true);
    const riffOk = v.getUint32(4, true) === 36 + dataBytes && buf.byteLength === 44 + dataBytes;
    const silent = new Uint8Array(buf, 44).every((x) => x === 128);
    return { ch, rate, bits, ms: (dataBytes / (rate * ch * (bits / 8))) * 1000, riffOk, silent };
  };
  const pauseSeq = (tag: string) => env.log.filter((l) => l.startsWith(`${tag}:`) || l.startsWith("silent"));

  // H1 쉼 = 무음 조각 재생 1회 — onPause(i, ms) → 같은 큐 요소에서 ms 길이 무음 WAV 1회(헤더 8kHz·8bit·mono) → 다음 onItem.
  //    마지막 조각 뒤 쉼도 지키고 그다음 onEnd("done"). 무음 조각은 sounded에 들지 않는다.
  let h1Seq: string[] = [];
  {
    env.silentScale = 0.02;
    const r = startQueue(sp, [en("Pause one.", 1000), en("Pause two.", 500)], "H");
    await waitFor(() => r.ends.length > 0, 2000);
    const seq = pauseSeq("H");
    h1Seq = seq.map((l) => l.replace(/^H:/, ""));
    const expected = ["H:item0", "H:pause0:1000", "silent:1000", "silent-end:1000", "H:item1", "H:pause1:500", "silent:500", "silent-end:500", "H:end:done"];
    const qEl = queueEls()[0];
    const infos = await Promise.all(env.silentPlays.map((p) => wavInfo(silentBlobOf.get(p.url))));
    const hdrOk =
      infos.length === 2 &&
      infos.every((x) => !!x && x.ch === 1 && x.rate === 8000 && x.bits === 8 && x.riffOk && x.silent) &&
      infos[0]?.ms === 1000 &&
      infos[1]?.ms === 500;
    add(
      "쉼",
      "H1 쉼 = 무음 조각 1회: onItem → onPause(i, ms) → 같은 큐 요소에서 ms 무음 WAV 1회 → 다음 onItem, 마지막 조각 뒤 쉼 → onEnd('done')",
      JSON.stringify(seq) === JSON.stringify(expected) && JSON.stringify(r.pauses) === "[[0,1000],[1,500]]" &&
        queueEls().length === 1 && env.silentPlays.length === 2 && env.silentPlays.every((p) => p.el === qEl),
      `seq=${seq.join(">")} 요소=${queueEls().length} 무음재생=${env.silentPlays.map((p) => p.ms).join(",")}`,
    );
    add(
      "쉼",
      "H1 무음 WAV의 길이가 헤더에서 읽힌다 — RIFF/WAVE·PCM 8kHz·8bit·mono·본문 전부 128(무음)·1000ms/500ms",
      hdrOk,
      infos.map((x) => (x ? `${x.rate}Hz/${x.bits}bit/${x.ch}ch/${x.ms}ms/riff=${x.riffOk}/silent=${x.silent}` : "헤더 없음")).join(" · "),
    );
    add(
      "쉼",
      "H1 쉼은 소리 낸 조각이 아니다 — sounded 2(조각 수)·POST 2·기기 0·합성 URL 생성 == 회수",
      JSON.stringify(r.sounded) === "[2]" && env.posts.length === 2 && deviceTexts().length === 0 && env.urlCreated === env.urlRevoked && env.urlCreated === 2,
      `sounded=${r.sounded.join(",")} POST ${env.posts.length} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated}/${env.urlRevoked}`,
    );
    await settle(sp);
  }

  // H2 칸 보존·칸 없는 큐 불변 — 입력을 {text, lang}으로 다시 만드는 첫 줄이 pauseAfterMs를 버리면 쉼이 조용히 사라진다(검토 개선 3).
  //    칸만 다른 두 입력의 재생 기록이 달라야 하고, 칸이 없거나 0 이하·유한수가 아니면 onPause·무음 재생이 0이고 나머지 기록은 같다.
  {
    env.silentScale = 0.02;
    const plain = startQueue(sp, [en("Pause one."), en("Pause two.")], "H");
    await waitFor(() => plain.ends.length > 0, 2000);
    const plainSeq = pauseSeq("H").map((l) => l.replace(/^H:/, ""));
    const plainRec = JSON.stringify([plain.items, plain.ends, plain.sounded, env.posts]);
    const plainSilent = env.silentPlays.length;
    await settle(sp);
    const bad: string[] = [];
    const weird: [string, unknown][] = [["0", 0], ["-5", -5], ["NaN", NaN], ["Infinity", Infinity], ["문자열 '1000'", "1000"], ["null", null]];
    for (const [label, v] of weird) {
      env.silentScale = 0.02;
      const r = startQueue(sp, [{ text: "Pause one.", lang: "en-US", pauseAfterMs: v as number }, { text: "Pause two.", lang: "en-US", pauseAfterMs: v as number }], "W");
      await waitFor(() => r.ends.length > 0, 2000);
      const rec = JSON.stringify([r.items, r.ends, r.sounded, env.posts]);
      if (r.pauses.length !== 0 || env.silentPlays.length !== 0 || rec !== plainRec) bad.push(`${label}: pause ${r.pauses.length} 무음 ${env.silentPlays.length} rec=${rec}`);
      await settle(sp);
    }
    add(
      "쉼",
      "H2 칸 보존: 칸만 다른 두 입력의 재생 기록이 다르다(쉼 있음 onPause 2·무음 2 / 없음 0·0) — 재구성이 pauseAfterMs를 옮긴다",
      h1Seq.length > 0 && JSON.stringify(h1Seq) !== JSON.stringify(plainSeq) && plainSilent === 0 && !plainSeq.some((l) => l.startsWith("pause")),
      `있음=${h1Seq.join(">")} / 없음=${plainSeq.join(">")}`,
    );
    add(
      "쉼",
      "H2 칸 없음·0·음수·NaN·Infinity·비숫자·null → 쉼 경로를 타지 않음(onPause 0·무음 0) + 순서·끝·sounded·POST가 칸 없는 큐와 같음",
      bad.length === 0 && JSON.stringify(plain.ends) === '["done"]',
      bad.join(" / ") || `${weird.length}가지 모두 칸 없는 큐와 같음`,
    );
  }

  // H3 쉼 ÷ 실제 말 속도 배율 — 클라우드 cloudSpeed()(천천히 0.85·보통 1·빠르게 1.15), 기기 getTtsRate() ÷ TTS_RATE(보통 1).
  //    기본 설정에서 쉼은 공식 그대로다(getTtsRate()로 바로 나누면 0.9 때문에 11% 길다 — 검토 개선 4). WAV는 250ms 단위로 올린다.
  {
    const cases: { label: string; rate: number; engine: "cloud" | "device"; ms: number; wav: number; factor: number }[] = [
      { label: "클라우드 보통", rate: 0.9, engine: "cloud", ms: 1000, wav: 1000, factor: 1 },
      { label: "클라우드 천천히(0.85)", rate: 0.7, engine: "cloud", ms: 1176, wav: 1250, factor: 0.85 },
      { label: "클라우드 빠르게(1.15)", rate: 1.1, engine: "cloud", ms: 870, wav: 1000, factor: 1.15 },
      { label: "기기 보통(0.9÷0.9)", rate: 0.9, engine: "device", ms: 1000, wav: 1000, factor: 1 },
      { label: "기기 천천히(0.7÷0.9)", rate: 0.7, engine: "device", ms: 1286, wav: 1500, factor: 0.7 / 0.9 },
    ];
    const bad: string[] = [];
    for (const c of cases) {
      sp.__setQueueTiming({ rateDebounceMs: 1 });
      sp.setTtsRate(c.rate);
      sp.setTtsEngine("en-US", c.engine);
      env.silentScale = 0.01;
      const f = sp.getSpeechSpeedFactor("en-US");
      const r = startQueue(sp, [en("Speed check.", 1000)], "V");
      await waitFor(() => r.ends.length > 0, 2000);
      const got = `${JSON.stringify(r.pauses)} wav=${env.silentPlays.map((p) => p.ms).join(",")} f=${f.toFixed(4)} ${c.engine === "device" ? `device=${deviceTexts().length}` : `POST=${env.posts.length}`}`;
      const ok =
        JSON.stringify(r.pauses) === JSON.stringify([[0, c.ms]]) &&
        env.silentPlays.length === 1 && env.silentPlays[0].ms === c.wav &&
        Math.abs(f - c.factor) < 1e-9 &&
        JSON.stringify(r.ends) === '["done"]' &&
        (c.engine === "device" ? deviceTexts().length === 1 && env.posts.length === 0 : env.posts.length === 1);
      if (!ok) bad.push(`${c.label}: ${got}`);
      await settle(sp);
    }
    sp.__setQueueTiming({ rateDebounceMs: 1 });
    sp.setTtsRate(0.9);
    sp.setTtsEngine("en-US", "cloud");
    await sleep(10);
    sp.__setQueueTiming(null);
    add(
      "쉼",
      "H3 쉼 ÷ 말 속도 배율: 클라우드 보통 1000·천천히 1176(WAV 1250)·빠르게 870(WAV 1000), 기기 보통 1000(공식 그대로 — 0.9로 바로 나누면 1111)·천천히 1286(WAV 1500) — getSpeechSpeedFactor와 같은 배율",
      bad.length === 0,
      bad.join(" / ") || `${cases.length}가지`,
    );
  }

  // H3 (실제 속도) 쉼은 **그 조각이 실제로 난 경로**의 배율로 나눈다 — 클라우드 엔진·천천히(0.7 → 클라우드 0.85)인데 그 조각이
  //    501로 기기 음성으로 났으면 기기 배율(0.7 ÷ 0.9 → 1286, WAV 1500)이다. 쉼 시점 설정(getSpeechSpeedFactor = 0.85 → 1176)으로
  //    다시 재면 틀린다(QA speech-pause_1 O1 — 변이 L7).
  {
    sp.__setQueueTiming({ rateDebounceMs: 1 });
    sp.setTtsRate(0.7);
    sp.setTtsEngine("en-US", "cloud");
    env.postStatus = () => 501;
    env.silentScale = 0.01;
    const f = sp.getSpeechSpeedFactor("en-US");
    const r = startQueue(sp, [en("Fallback speed.", 1000)], "V");
    await waitFor(() => r.ends.length > 0, 2000);
    const wavs = env.silentPlays.map((p) => p.ms);
    const posts = env.posts.length;
    const dev = deviceTexts().length;
    sp.setTtsRate(0.9);
    await sleep(10);
    add(
      "쉼",
      "H3 실제 속도: 클라우드 엔진·천천히 0.7인데 501로 기기 폴백한 조각 → onPause 1286(기기 0.7÷0.9)·WAV 1500 — 설정 배율 0.85(1176)가 아니다",
      JSON.stringify(r.pauses) === "[[0,1286]]" && JSON.stringify(wavs) === "[1500]" && Math.abs(f - 0.85) < 1e-9 &&
        posts === 1 && dev === 1 && JSON.stringify(r.ends) === '["done"]',
      `pauses=${JSON.stringify(r.pauses)} wav=${wavs.join(",")} 설정배율=${f.toFixed(4)} POST=${posts} device=${dev} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }

  // H4 상한·올림·칸 재사용 — pauseMaxMs(15초)에서 자르고, WAV는 250ms 단위로 올린 길이(최소 250), 같은 칸은 같은 Blob(모듈에 한 번).
  {
    env.silentScale = 0.002; // 15초 WAV → 30ms
    const r = startQueue(sp, [en("Very long pause.", 40_000), en("Tiny pause.", 1), en("Just over.", 251), en("Same bucket.", 490)], "C");
    await waitFor(() => r.ends.length > 0, 3000);
    const wavs = env.silentPlays.map((p) => p.ms);
    const infos = await Promise.all(env.silentPlays.map((p) => wavInfo(silentBlobOf.get(p.url))));
    const sameBlob = env.silentPlays.length === 4 && silentBlobOf.get(env.silentPlays[2].url) === silentBlobOf.get(env.silentPlays[3].url);
    const buckets = sp.__speechPlaybackState().pauseWavBuckets;
    add(
      "쉼",
      "H4 상한 15초·250ms 올림: 40000 → onPause 15000·WAV 15000 / 1 → 1·WAV 250 / 251 → WAV 500 / 490 → WAV 500(같은 칸은 같은 Blob) · 칸 수 ≤ 60",
      JSON.stringify(r.pauses) === "[[0,15000],[1,1],[2,251],[3,490]]" && JSON.stringify(wavs) === "[15000,250,500,500]" &&
        infos[0]?.ms === 15000 && sameBlob && buckets <= 60 && JSON.stringify(r.ends) === '["done"]',
      `pauses=${JSON.stringify(r.pauses)} wav=${wavs.join(",")} 헤더0=${infos[0]?.ms} 같은Blob=${sameBlob} 칸=${buckets}`,
    );
    await settle(sp);
    sp.__setQueueTiming({ pauseMaxMs: 600 });
    env.silentScale = 0.02;
    const r2 = startQueue(sp, [en("Hook cap.", 1000)], "C");
    await waitFor(() => r2.ends.length > 0, 2000);
    add(
      "쉼",
      "H4 상한은 테스트 훅(__setQueueTiming pauseMaxMs)으로 줄어든다 — 1000 → 600·WAV 750",
      JSON.stringify(r2.pauses) === "[[0,600]]" && env.silentPlays.map((p) => p.ms).join(",") === "750",
      `pauses=${JSON.stringify(r2.pauses)} wav=${env.silentPlays.map((p) => p.ms).join(",")}`,
    );
    await settle(sp);
  }

  // H5 공백이라 건너뛴 조각의 쉼은 건너뛴다(인덱스 보존) — 쉼은 "조각이 끝난 뒤"라 공백 조각에는 끝이 없다.
  {
    env.silentScale = 0.02;
    const r = startQueue(sp, [en("Before.", 300), en("   ", 700), en("After.", 400)], "B");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "쉼",
      "H5 공백 조각의 쉼은 건너뜀 — onItem 0,2·onPause (0,300),(2,400)·무음 2회·done",
      JSON.stringify(r.items) === "[0,2]" && JSON.stringify(r.pauses) === "[[0,300],[2,400]]" && env.silentPlays.map((p) => p.ms).join(",") === "500,500" &&
        JSON.stringify(r.ends) === '["done"]',
      `items=${r.items.join(",")} pauses=${JSON.stringify(r.pauses)} wav=${env.silentPlays.map((p) => p.ms).join(",")}`,
    );
    await settle(sp);
  }

  // H6 쉼 도중 멈춤 — stop·stopSpeaking()·새 큐가 무음 조각을 **즉시** 끊고, 옛 onEnd("stopped")는 동기로(새 큐 onItem(0)보다 먼저),
  //    옛 큐는 그 뒤 onItem을 내지 않는다. 쉼 도중 외부 pause(잠금 화면 ⏸ 흉내)도 "stopped"(§18-2 그대로).
  for (const how of ["stop", "stopSpeaking", "새 큐", "외부 pause"] as const) {
    env.silentScale = 1; // 250ms 무음이 실제로 250ms — 그 사이에 멈춘다
    const r = startQueue(sp, [en("Stop during pause.", 250), en("Never reached.")], "X");
    const inPause = await waitFor(() => env.silentPlays.length === 1, 1500);
    await sleep(20);
    const el = env.silentPlays[0]?.el;
    const pz = el?.pauseCalls ?? 0;
    let syncEnd = false;
    let newRun: Run | null = null;
    if (how === "stop") {
      r.stop();
      syncEnd = r.ends.length === 1;
    } else if (how === "stopSpeaking") {
      sp.stopSpeaking();
      syncEnd = r.ends.length === 1;
    } else if (how === "새 큐") {
      newRun = startQueue(sp, [en("New queue.")], "N");
      syncEnd = r.ends.length === 1;
    } else {
      el?.pause(); // 시스템이 멈춤
      await waitFor(() => r.ends.length > 0, 500);
      syncEnd = r.ends.length === 1;
    }
    if (newRun) await waitFor(() => newRun!.ends.length > 0, 1500);
    await sleep(300); // 무음 조각이 원래 끝났을 시점을 넘긴다
    const order = newRun ? env.log.indexOf("X:end:stopped") < env.log.indexOf("N:item0") : true;
    add(
      "쉼",
      `H6 쉼 도중 ${how} → 옛 onEnd('stopped') ${how === "외부 pause" ? "" : "동기 "}1회·이후 onItem 없음·무음 요소 pause${how === "새 큐" ? "·새 큐 onItem(0)보다 먼저·새 큐 done" : ""}·기기 폴백 0`,
      inPause && syncEnd && JSON.stringify(r.ends) === '["stopped"]' && JSON.stringify(r.items) === "[0]" && (el?.pauseCalls ?? 0) > pz &&
        order && deviceTexts().length === 0 && (!newRun || JSON.stringify(newRun.ends) === '["done"]') && !env.log.includes("silent-end:250"),
      `쉼중=${inPause} ends=${r.ends.join(",")} items=${r.items.join(",")} pause+${(el?.pauseCalls ?? 0) - pz} 순서=${order}${newRun ? ` 새=${newRun.ends.join(",")}` : ""}`,
    );
    await settle(sp);
  }

  // H7 타이머 폴백 — 무음 조각 play()가 AbortError가 아닌 이유로 거부되면 ms만큼 타이머로 기다린다. 기다림은 currentPlayStop에
  //    등록돼 stop이 즉시 끊고, 끝나면 **자기일 때만** 비운다(낡은 stop이 남으면 다음 stopCloudAudio가 URL 회수를 건너뛴다).
  //    AbortError 거부는 "시작 순간의 외부 멈춤"이라 정지다(§18-2 — 타이머로 가지 않는다).
  {
    // 마지막 조각 뒤 쉼도 타이머 — 그 뒤에는 stop을 덮어쓸 재생이 없으므로 "끝난 뒤 비움"이 여기서만 드러난다.
    env.silentRejectName = "NotAllowedError";
    const r = startQueue(sp, [en("Timer one.", 120), en("Timer two.", 120)], "T");
    await waitFor(() => env.log.includes("silent-reject:250"), 1500);
    const tRej = Date.now();
    const during = sp.__speechPlaybackState();
    await waitFor(() => r.items.includes(1), 1500);
    const waited = Date.now() - tRej;
    await waitFor(() => r.ends.length > 0, 1500);
    const after = sp.__speechPlaybackState();
    add(
      "쉼",
      "H7 무음 재생 거부(NotAllowedError) → 타이머로 ms(120) 기다린 뒤 다음 조각·마지막 쉼 뒤 done, 기다리는 동안 stop 등록·끝난 뒤 비움(자기일 때만 — 낡은 stop 0)",
      JSON.stringify(r.pauses) === "[[0,120],[1,120]]" && waited >= 100 && waited < 1000 && JSON.stringify(r.items) === "[0,1]" && JSON.stringify(r.ends) === '["done"]' &&
        JSON.stringify(r.sounded) === "[2]" && during.playStop && !after.playStop && !after.audioUrl && env.liveUrls.size === 0,
      `대기 ${waited}ms 쉼중stop=${during.playStop} 끝난뒤stop=${after.playStop} url=${after.audioUrl} ends=${r.ends.join(",")} sounded=${r.sounded.join(",")}`,
    );
    await settle(sp);

    env.silentRejectName = "NotAllowedError";
    const r2 = startQueue(sp, [en("Timer stop.", 400), en("Not reached.")], "T");
    await waitFor(() => env.log.includes("silent-reject:500"), 1500);
    await sleep(20);
    r2.stop();
    const syncEnd = r2.ends.length === 1;
    const st = sp.__speechPlaybackState();
    await sleep(450);
    add(
      "쉼",
      "H7 타이머 쉼 도중 stop → onEnd('stopped') 동기·stop 비움·타이머가 끝나도 다음 조각 없음",
      syncEnd && JSON.stringify(r2.ends) === '["stopped"]' && JSON.stringify(r2.items) === "[0]" && !st.playStop,
      `동기=${syncEnd} ends=${r2.ends.join(",")} items=${r2.items.join(",")} stop=${st.playStop}`,
    );
    await settle(sp);

    env.silentRejectName = "AbortError";
    const r3 = startQueue(sp, [en("Abort start.", 300), en("Not reached.")], "T");
    await waitFor(() => r3.ends.length > 0, 1500);
    await sleep(350);
    add(
      "쉼",
      "H7 무음 재생이 AbortError로 거부(시작 순간 외부 멈춤) → 타이머가 아니라 'stopped'·다음 조각 없음·기기 폴백 0",
      JSON.stringify(r3.ends) === '["stopped"]' && JSON.stringify(r3.items) === "[0]" && deviceTexts().length === 0,
      `ends=${r3.ends.join(",")} items=${r3.items.join(",")}`,
    );
    await settle(sp);
  }

  // H8 무음 조각의 ended가 끝내 안 와도 재생 안전 타임아웃(duration×1000 + 여유)으로 다음 조각 — 큐가 쉼에서 영영 멈추지 않게.
  {
    env.silentNeverEnds = true;
    env.silentScale = 0.04; // 250ms WAV → 10ms, duration 0.01
    sp.__setQueueTiming({ playSlackMs: 20 });
    const t0 = Date.now();
    const r = startQueue(sp, [en("Hung pause.", 250), en("Next one.")], "E");
    await waitFor(() => r.ends.length > 0, 1500);
    add(
      "쉼",
      "H8 무음 조각 ended 안 옴 → 재생 안전 타임아웃 뒤 다음 조각·done(요소 pause·기기 0)",
      JSON.stringify(r.items) === "[0,1]" && JSON.stringify(r.ends) === '["done"]' && deviceTexts().length === 0 && Date.now() - t0 < 1500,
      `${Date.now() - t0}ms items=${r.items.join(",")} ends=${r.ends.join(",")}`,
    );
    await settle(sp);
  }

  // H9 쉼은 sounded·무음 연속 판정(QUEUE_SILENT_STOP)에 들지 않는다 — 소리를 못 낸 조각(501 + 기기 오류) 뒤에도 쉼은 지키고,
  //    무음 조각 셋이 이어지면(사이의 쉼은 소리가 아니다) 셋째 조각 뒤 쉼 없이 "stopped"·sounded 0.
  {
    env.postStatus = () => 501;
    env.deviceFailFor = () => true;
    env.silentScale = 0.02;
    const r = startQueue(sp, [kop("일.", 300), kop("이.", 300), kop("삼.", 300), kop("사.", 300)], "D");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "쉼",
      "H9 못 낸 조각 뒤에도 쉼(0·1)·쉼은 소리가 아니다 → 무음 3조각 연속 'stopped'·sounded 0·셋째 뒤 쉼 없음",
      JSON.stringify(r.ends) === '["stopped"]' && JSON.stringify(r.sounded) === "[0]" && JSON.stringify(r.items) === "[0,1,2]" &&
        JSON.stringify(r.pauses) === "[[0,300],[1,300]]" && env.silentPlays.length === 2,
      `ends=${r.ends.join(",")} sounded=${r.sounded.join(",")} items=${r.items.join(",")} pauses=${JSON.stringify(r.pauses)} 무음=${env.silentPlays.length}`,
    );
    await settle(sp);
  }

  // H10 onPause 핸들러 예외는 큐를 깨지 않는다(onItem과 같은 규약).
  {
    env.silentScale = 0.02;
    const ends: string[] = [];
    const items: number[] = [];
    sp.speakQueue([en("Throw here.", 300), en("Still fine.")], {
      onItem: (i) => items.push(i),
      onPause: () => {
        throw new Error("pause boom");
      },
      onEnd: (r) => ends.push(r),
    });
    await waitFor(() => ends.length > 0, 2000);
    add(
      "쉼",
      "H10 onPause 예외 격리 — 무음 조각·다음 조각·done 그대로",
      JSON.stringify(items) === "[0,1]" && JSON.stringify(ends) === '["done"]' && env.silentPlays.length === 1,
      `items=${items.join(",")} ends=${ends.join(",")} 무음=${env.silentPlays.length}`,
    );
    await settle(sp);
  }

  // H11 쉼 도중 속도를 바꾸면 **다음 쉼부터** 반영 — 지금 쉼은 이미 정한 길이, 다음 조각은 새 속도로 합성·그 뒤 쉼은 새 배율.
  {
    sp.__setQueueTiming({ rateDebounceMs: 1 });
    env.silentScale = 0.02;
    let changed = false;
    const run: Run = { items: [], ends: [], sounded: [], pauses: [], stop: () => {} };
    run.stop = sp.speakQueue([en("Rate one.", 1000), en("Rate two.", 1000)], {
      onItem: (i) => run.items.push(i),
      onPause: (i, ms) => {
        run.pauses.push([i, ms]);
        if (!changed) {
          changed = true;
          sp.setTtsRate(0.7); // 쉼이 시작된 순간(무음 조각 재생 전) — 이 쉼은 이미 1000으로 정해졌다
        }
      },
      onEnd: (r) => run.ends.push(r),
    });
    await waitFor(() => run.ends.length > 0, 2000);
    const speedOfTwo = env.postSpeeds[env.posts.lastIndexOf("Rate two.")];
    sp.setTtsRate(0.9);
    await sleep(10);
    add(
      "쉼",
      "H11 쉼 도중 속도 변경 → 이번 쉼 1000 그대로·다음 조각 speed 0.85로 합성·다음 쉼 1176",
      JSON.stringify(run.pauses) === "[[0,1000],[1,1176]]" && speedOfTwo === 0.85 && JSON.stringify(run.ends) === '["done"]',
      `pauses=${JSON.stringify(run.pauses)} 'Rate two.' speed=${speedOfTwo} ends=${run.ends.join(",")}`,
    );
    await settle(sp);
  }

  // -------------------------------------------------------------------------
  // I. 범위 미리 받기 prepareSpeech (toeic.md §12-5-2·§12-10) — ▶ 전에 기다리는 준비("준비 n/m"). 전역 프리페치와 따로 선다.
  // -------------------------------------------------------------------------
  const prepared = async (items: { text: string; lang: string }[], opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void } = {}) => {
    const prog: [number, number][] = [];
    const res = await sp.prepareSpeech(items, {
      signal: opts.signal,
      onProgress: (d, t) => {
        prog.push([d, t]);
        opts.onProgress?.(d, t);
      },
    });
    return { res, prog };
  };
  const monotone = (prog: [number, number][], total: number) =>
    prog.length > 0 && prog.every(([d, t], i) => t === total && d >= 0 && d <= total && (i === 0 || d >= prog[i - 1][0])) && prog[0][0] === 0;

  // P1 고유 글자만·지금 클라우드로 읽을 것만(ja-JP 기본 기기·300자 초과·공백 제외)·90에서 자름·진행 단조 0 → total.
  //    제외 대상(ja·301자·공백)은 **90개 상한 앞**에 둔다 — 상한 뒤에 두면 거르기에 닿기 전에 break해 아무것도 증명하지 못한다
  //    (QA speech-pause_1 F1: canUseCloud·!text 제거 변이가 살아남았다). 걸러지지 않으면 첫 POST가 'Prepare line 0.'이 아니게 된다.
  {
    env.fetchDelayMs = 1;
    const many = Array.from({ length: 100 }, (_, n) => ({ text: `Prepare line ${n}.`, lang: "en-US" }));
    const items = [
      ja("にほんご"),
      { text: "x".repeat(301), lang: "en-US" },
      { text: "   ", lang: "en-US" },
      ...many.slice(0, 5),
      ...many,
      ...many.slice(0, 5),
      ja("ねこ"),
    ];
    const { res, prog } = await prepared(items);
    const uniq = new Set(env.posts).size;
    add(
      "준비",
      "P1 고유 글자만·클라우드로 읽을 것만(상한 앞의 ja 기기·301자·공백 제외)·90에서 자름 — POST 90(중복 0)·ready 90·total 90·첫 'Prepare line 0.'",
      res.total === 90 && res.ready === 90 && env.posts.length === 90 && uniq === 90 &&
        !env.posts.some((t) => /[ぁ-ん]/.test(t) || t.length > 300 || !t.trim()) &&
        env.posts[0] === "Prepare line 0." && env.posts[89] === "Prepare line 89.",
      `total ${res.total} ready ${res.ready} POST ${env.posts.length}(고유 ${uniq}) 첫=${env.posts[0]} 끝=${env.posts[env.posts.length - 1]}`,
    );
    add(
      "준비",
      "P1 onProgress 단조 증가 — 처음 (0, 90), 조각마다 +1, 마지막 (90, 90)",
      monotone(prog, 90) && prog.length === 91 && JSON.stringify(prog[prog.length - 1]) === "[90,90]",
      `호출 ${prog.length}회 처음=${JSON.stringify(prog[0])} 끝=${JSON.stringify(prog[prog.length - 1])}`,
    );
    // P2 이미 메모리 캐시에 있으면 건너뜀 → total 0·POST 0, 그리고 준비한 조각은 큐에서 합성 0(P8)
    const postsBefore = env.posts.length;
    const again = await prepared(many.slice(0, 10));
    add(
      "준비",
      "P2 캐시에 있으면 건너뜀 — 같은 조각 다시 준비 → total 0·ready 0·POST 0·onProgress (0, 0) 한 번",
      again.res.total === 0 && again.res.ready === 0 && env.posts.length === postsBefore && JSON.stringify(again.prog) === "[[0,0]]",
      `total ${again.res.total} POST +${env.posts.length - postsBefore} prog=${JSON.stringify(again.prog)}`,
    );
    const r = startQueue(sp, many.slice(0, 3), "R");
    await waitFor(() => r.ends.length > 0, 2000);
    add(
      "준비",
      "P8 준비한 조각은 큐에서 합성 0(캐시 적중) — 전부 클라우드로 done",
      env.posts.length === postsBefore && JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.sounded) === "[3]" && deviceTexts().length === 0,
      `POST +${env.posts.length - postsBefore} ends=${r.ends.join(",")} sounded=${r.sounded.join(",")}`,
    );
    await settle(sp);
  }

  // P3 signal로 끊으면 그 뒤 요청이 없다 — 진행 중 요청은 자기 몫만 물러나고(소비자 0 → 끊김), 약속은 reject 없이 그때까지의 수로.
  {
    env.fetchDelayMs = 25;
    const ac = new AbortController();
    const items = Array.from({ length: 10 }, (_, n) => ({ text: `Abort line ${n}.`, lang: "en-US" }));
    let postsAtAbort = -1;
    let rejected = false;
    const out = await prepared(items, {
      signal: ac.signal,
      onProgress: (d) => {
        if (d === 2 && postsAtAbort < 0) {
          // 셋째 조각 요청이 나간 뒤 끊는다(다음 틱)
          setTimeout(() => {
            postsAtAbort = env.posts.length;
            ac.abort();
          }, 5);
        }
      },
    }).catch(() => {
      rejected = true;
      return null;
    });
    await sleep(80);
    add(
      "준비",
      "P3 signal abort → 그 뒤 POST 0·진행 중 요청은 끊김(소비자 0)·reject 없이 {ready 2, total 10}",
      !rejected && !!out && out.res.total === 10 && out.res.ready === 2 && postsAtAbort === 3 && env.posts.length === postsAtAbort && env.postAborted.length === 1,
      `ready=${out?.res.ready} total=${out?.res.total} abort때POST=${postsAtAbort} 지금POST=${env.posts.length} 끊긴요청=${env.postAborted.join("|") || "0"}`,
    );
    await settle(sp);
  }

  // P4 키 없음(501) → 곧바로 끝(나머지 요청 0 — 재생은 기기 음성).
  {
    env.postStatus = () => 501;
    const items = Array.from({ length: 6 }, (_, n) => ({ text: `No key ${n}.`, lang: "en-US" }));
    const t0 = Date.now();
    const { res } = await prepared(items);
    add(
      "준비",
      "P4 501 → 곧바로 끝 — POST 1·ready 0·total 6",
      env.posts.length === 1 && res.ready === 0 && res.total === 6 && Date.now() - t0 < 500,
      `POST ${env.posts.length} ready ${res.ready} total ${res.total} ${Date.now() - t0}ms`,
    );
    await settle(sp);
  }

  // P5 기존 prefetchSpeech와 서로 끊지 않는다(다른 abort) — ① 프리페치가 도는 중 준비를 시작해도 프리페치 요청이 안 끊기고
  //    ② 준비 도중 새 프리페치가 와도(전역 "최근 요청이 이긴다") 준비는 끝까지 간다. 같은 문장은 진행 중 합성을 함께 쓴다(POST 1).
  {
    env.fetchDelayMs = 10;
    const A = Array.from({ length: 6 }, (_, n) => `Prefetch A ${n}.`);
    const B = Array.from({ length: 6 }, (_, n) => ({ text: `Prepare B ${n}.`, lang: "en-US" }));
    const stopA = sp.prefetchSpeech([...A, "Shared line."], "en-US");
    const p = prepared([{ text: "Shared line.", lang: "en-US" }, ...B]);
    let stopD: (() => void) | null = null;
    const D = Array.from({ length: 3 }, (_, n) => `Prefetch D ${n}.`);
    setTimeout(() => {
      stopD = sp.prefetchSpeech(D, "en-US"); // 준비 도중 새 프리페치 — A 배치는 끊겨도(설계) 준비는 안 끊긴다
    }, 35);
    const { res } = await p;
    await waitFor(() => D.every((t) => env.posts.includes(t)), 1500);
    await sleep(30);
    const aborted = env.postAborted;
    const bAll = B.every((b) => env.posts.includes(b.text));
    const sharedPosts = env.posts.filter((t) => t === "Shared line.").length;
    add(
      "준비",
      "P5 prefetchSpeech와 독립 — 준비 7/7(새 프리페치에 안 끊김)·B 전부 POST·같은 문장 POST 1(공유)·준비 요청 중 끊긴 것 0",
      res.total === 7 && res.ready === 7 && bAll && sharedPosts === 1 && !aborted.some((t) => t.startsWith("Prepare B") || t === "Shared line."),
      `ready ${res.ready}/${res.total} B전부=${bAll} 공유POST=${sharedPosts} 끊김=${aborted.join("|") || "0"}`,
    );
    stopA();
    (stopD as (() => void) | null)?.();
    await settle(sp);
  }

  // P6 매달린 조각은 대기 상한(fetchMs) 뒤 건너뛴다(요청은 살려 둔다) — 준비가 "준비 n/m"에서 영영 멈추지 않게.
  {
    sp.__setQueueTiming({ fetchMs: 40 });
    env.postStatus = (t) => (t === "Hang line." ? "hang" : 200);
    const { res, prog } = await prepared([
      { text: "Before hang.", lang: "en-US" },
      { text: "Hang line.", lang: "en-US" },
      { text: "After hang.", lang: "en-US" },
    ]);
    add(
      "준비",
      "P6 매달린 조각 → fetchMs 뒤 건너뛰고 다음 조각·진행 3/3·ready 2·매달린 요청은 안 끊음",
      res.total === 3 && res.ready === 2 && env.posts.includes("After hang.") && JSON.stringify(prog[prog.length - 1]) === "[3,3]" && !env.postAborted.includes("Hang line."),
      `ready ${res.ready}/${res.total} prog끝=${JSON.stringify(prog[prog.length - 1])} POST=${env.posts.join("|")}`,
    );
    await settle(sp);
  }

  // P7 이미 끊긴 signal → 요청 0, 진행 (0, total)만 — 그리고 브라우저 밖이 아니어도 기기 엔진 언어만 있으면 total 0.
  {
    const ac = new AbortController();
    ac.abort();
    const a = await prepared([{ text: "Already aborted.", lang: "en-US" }], { signal: ac.signal });
    const b = await prepared([ja("いぬ"), ja("さる")]);
    add(
      "준비",
      "P7 이미 끊긴 signal → POST 0·{ready 0, total 1} / 기기 엔진 언어(ja 기본)만 → total 0·POST 0",
      env.posts.length === 0 && a.res.ready === 0 && a.res.total === 1 && b.res.total === 0,
      `POST ${env.posts.length} a=${JSON.stringify(a.res)} b=${JSON.stringify(b.res)}`,
    );
    await settle(sp);
  }

  // P9 준비 도중 그 언어를 기기 엔진으로 바꾸면 남은 조각은 받지 않되 **진행에는 센다** — "준비 n/m"이 m에 닿는다
  //    (QA speech-pause_1 O2 — 변이 P-i: 기기로 바뀐 조각을 안 세면 진행이 1/4에서 멈춘다. 약속은 그래도 풀린다).
  {
    env.fetchDelayMs = 5;
    let switched = false;
    const items = Array.from({ length: 4 }, (_, n) => ({ text: `Switch line ${n}.`, lang: "en-US" }));
    const { res, prog } = await prepared(items, {
      onProgress: (d) => {
        if (d === 1 && !switched) {
          switched = true;
          sp.setTtsEngine("en-US", "device"); // 첫 조각을 받은 직후 — 나머지 셋은 기기로 읽힌다
        }
      },
    });
    const posts = [...env.posts];
    sp.setTtsEngine("en-US", "cloud");
    add(
      "준비",
      "P9 준비 도중 기기 엔진으로 전환 → 남은 조각 POST 0·진행은 total까지 (0,4)…(4,4)·ready 1·total 4",
      switched && res.total === 4 && res.ready === 1 && JSON.stringify(posts) === '["Switch line 0."]' &&
        monotone(prog, 4) && prog.length === 5 && JSON.stringify(prog[prog.length - 1]) === "[4,4]",
      `ready ${res.ready}/${res.total} POST=${posts.join("|")} prog=${JSON.stringify(prog)}`,
    );
    await settle(sp);
  }

  // -------------------------------------------------------------------------
  // J. 잠금 화면 조작 — lib/media-session.ts. 큐·단발은 Media Session을 걸지 않는다(기존 화면의 잠금 화면 ⏸ = 정지 그대로),
  //    쓰는 플레이어만 bindMediaSession으로 켠다(toeic.md §12-5-2).
  // -------------------------------------------------------------------------
  {
    const msMod = await import("../lib/media-session");
    const g = globalThis as unknown as Record<string, unknown>;
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const handlers = new Map<string, ((d?: unknown) => void) | null>();
    const fakeMs = {
      metadata: null as unknown,
      playbackState: "none",
      setCalls: 0,
      metaSets: 0,
      setActionHandler(action: string, h: ((d?: unknown) => void) | null) {
        if (action === "stop") throw new TypeError("unsupported action"); // 지원하지 않는 동작 모사
        this.setCalls++;
        handlers.set(action, h);
      },
    };
    let meta: unknown = null;
    Object.defineProperty(fakeMs, "metadata", {
      configurable: true,
      get: () => meta,
      set: (v) => {
        fakeMs.metaSets++;
        meta = v;
      },
    });
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { mediaSession: fakeMs } });
    g.MediaMetadata = class {
      title: string;
      artist: string;
      album: string;
      constructor(init: { title?: string; artist?: string; album?: string }) {
        this.title = init.title ?? "";
        this.artist = init.artist ?? "";
        this.album = init.album ?? "";
      }
    };

    // M1 기존 경로(쉼 있는 큐·단발 speak·stop)는 Media Session을 건드리지 않는다.
    env.silentScale = 0.02;
    const r = startQueue(sp, [en("No session.", 250), en("Still none.")], "M");
    await waitFor(() => r.ends.length > 0, 2000);
    sp.speak("Single shot.");
    await sleep(40);
    sp.stopSpeaking();
    add(
      "잠금화면",
      "M1 큐(쉼 포함)·speak·stop은 navigator.mediaSession을 건드리지 않는다(핸들러 0·metadata 0) — 기존 화면의 잠금 화면 ⏸ = 정지 그대로",
      fakeMs.setCalls === 0 && fakeMs.metaSets === 0 && JSON.stringify(r.ends) === '["done"]',
      `setActionHandler ${fakeMs.setCalls} metadata ${fakeMs.metaSets}`,
    );
    await settle(sp);

    // M2 걸고 풀기 — metadata·지원하는 동작 핸들러, 핸들러 예외 삼킴, 풀면 전부 null·playbackState none.
    const calls: string[] = [];
    const unbind = msMod.bindMediaSession({
      title: "Shadowing",
      artist: "Made-up group",
      actions: {
        play: () => calls.push("play"),
        pause: () => calls.push("pause"),
        nexttrack: () => calls.push("next"),
        previoustrack: () => {
          calls.push("prev");
          throw new Error("handler boom");
        },
        stop: () => calls.push("stop"),
      },
    });
    msMod.setMediaSessionPlaybackState("playing");
    const m = meta as { title?: string; artist?: string } | null;
    let threw = false;
    try {
      for (const a of ["play", "pause", "nexttrack", "previoustrack"]) handlers.get(a)?.({ action: a });
    } catch {
      threw = true;
    }
    const boundOk = m?.title === "Shadowing" && m?.artist === "Made-up group" && ["play", "pause", "nexttrack", "previoustrack"].every((a) => typeof handlers.get(a) === "function");
    const stateWhile = fakeMs.playbackState;
    unbind();
    const cleared = ["play", "pause", "nexttrack", "previoustrack"].every((a) => handlers.get(a) === null) && meta === null && fakeMs.playbackState === "none";
    add(
      "잠금화면",
      "M2 bindMediaSession: metadata·⏯⏭⏮ 핸들러를 걸고(지원 안 하는 stop은 조용히 건너뜀)·핸들러 예외 삼킴 → 풀면 핸들러 null·metadata null·상태 none",
      boundOk && !threw && JSON.stringify(calls) === '["play","pause","next","prev"]' && stateWhile === "playing" && cleared,
      `걸림=${boundOk} 호출=${calls.join(",")} 예외전파=${threw} 상태=${stateWhile} 풀림=${cleared}`,
    );

    // M3 낡은 풀기는 뒤에 건 바인딩을 지우지 않는다.
    const unA = msMod.bindMediaSession({ title: "A", actions: { play: () => calls.push("A") } });
    const unB = msMod.bindMediaSession({ title: "B", actions: { play: () => calls.push("B") } });
    unA();
    const stillB = (meta as { title?: string } | null)?.title === "B" && typeof handlers.get("play") === "function";
    handlers.get("play")?.();
    unB();
    add(
      "잠금화면",
      "M3 앞 바인딩의 풀기 함수는 뒤에 건 바인딩을 지우지 않는다(자기일 때만) — B 유지·B 핸들러가 불림 → B 풀기로 null",
      stillB && calls[calls.length - 1] === "B" && handlers.get("play") === null && meta === null,
      `B유지=${stillB} 마지막호출=${calls[calls.length - 1]} 풀림=${handlers.get("play") === null && meta === null}`,
    );

    // M4 미지원(navigator.mediaSession 없음) → 조용히 no-op.
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {} });
    let m4Threw = false;
    let supported = true;
    try {
      supported = msMod.isMediaSessionSupported();
      const un = msMod.bindMediaSession({ title: "X", actions: { play: () => {} } });
      msMod.setMediaSessionPlaybackState("paused");
      un();
    } catch {
      m4Threw = true;
    }
    add("잠금화면", "M4 Media Session 미지원 → isMediaSessionSupported false·걸기/풀기/상태 모두 예외 없이 no-op", !m4Threw && supported === false, `예외=${m4Threw} 지원=${supported}`);

    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else delete g.navigator;
    delete g.MediaMetadata;
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
    /** 자가 치유(캐시 오디오 손상 → 새로 받음) 여부 — 2026-09-27 추가 */
    healed?: boolean;
  }
  const spx = sp as unknown as { getTtsPlaybackDiag?: (lang: string) => DiagLike | null; TTS_DIAG_EVENT?: string };
  const diagOf = (lang: string): DiagLike | null => (typeof spx.getTtsPlaybackDiag === "function" ? spx.getTtsPlaybackDiag(lang) : null);
  const diagEvents: { lang?: string }[] = [];
  if (typeof spx.TTS_DIAG_EVENT === "string") {
    (globalThis as unknown as EventTarget).addEventListener(spx.TTS_DIAG_EVENT, (e) => {
      diagEvents.push(((e as CustomEvent).detail ?? {}) as { lang?: string });
    });
  }
  const dshort = (d: DiagLike | null | undefined) => (d ? `${d.ok ? "ok" : "fail"}/${d.stage}/${d.reason}/${d.fallback}${d.healed ? "/healed" : ""}` : "(없음)");

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
  const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const textOf = (b: ArrayBuffer | null | undefined) => (b ? new TextDecoder().decode(new Uint8Array(b)) : "(없음)");
  /**
   * 가짜 KV — IndexedDB v2와 같은 계약(목록+바이트, 옛 형식 v1 Blob 레코드). `entries`는 새 형식(바이트, audio/mpeg),
   * `legacy`는 옛 형식 Blob 레코드(= 이전 프로세스가 쓴 것). `webkit`: WebKit 결함 모사(QA F1) — get이 내준 옛 Blob이 있는
   * 키를 put으로 다시 쓰면 그 Blob이 죽고, 넣은 값이 그 Blob이면 새 레코드도 죽는다(구 코드의 touch).
   * 조회 경로가 오디오 레코드를 다시 쓰는지 보려고 put·touch·delete를 전부 센다. put에 Blob이 섞여 들어오면 `blobPuts`.
   */
  type FakeRec =
    | { kind: "bytes"; bytes: ArrayBuffer | null; type: string; size: number; atime: number }
    | { kind: "legacy"; blob: Blob; size: number; atime: number };
  const fakeKv = (
    fp: string | null,
    entries: Record<string, string> = {},
    /** `putDelayMs`: 백엔드 put이 그만큼 늦게 끝난다(IDB 트랜잭션이 느린 기기 — 저장 도중 치유 삭제가 끼어드는 경합, G19) */
    opts: { legacy?: Record<string, Blob>; webkit?: boolean; putDelayMs?: number } = {},
  ) => {
    const m = new Map<string, FakeRec>();
    for (const [k, v] of Object.entries(entries)) {
      const b = bytesOf(v);
      m.set(k, { kind: "bytes", bytes: b, type: "audio/mpeg", size: b.byteLength, atime: 0 });
    }
    for (const [k, b] of Object.entries(opts.legacy ?? {})) m.set(k, { kind: "legacy", blob: b, size: b.size, atime: 0 });
    /** `ops`: 백엔드에 실제로 닿은 쓰기의 순서(`put:키`·`touch:키`·`delete:키`, 끝난 순서) — 쓰기 줄 순서 검증용(G19) */
    const st = { fp, gets: 0, clears: 0, puts: [] as string[], touches: [] as string[], deletes: [] as string[], blobPuts: 0, ops: [] as string[] };
    /** 이번 "프로세스"에서 get이 내준 옛 Blob(키별) */
    const handedOut = new Map<string, Blob[]>();
    const kv: TtsKvBackend = {
      get: async (k) => {
        st.gets++;
        const r = m.get(k);
        if (!r) return null;
        if (r.kind === "legacy") {
          handedOut.set(k, [...(handedOut.get(k) ?? []), r.blob]);
          return { ...r };
        }
        return { ...r, bytes: r.bytes ? r.bytes.slice(0) : null }; // IDB처럼 구조화 복제
      },
      put: async (k, e) => {
        st.puts.push(k);
        if (opts.putDelayMs) await sleep(opts.putDelayMs);
        st.ops.push(`put:${k}`);
        const raw = e as unknown as Record<string, unknown>;
        const blobField = Object.values(raw).find((v) => v instanceof NodeBlob) as Blob | undefined;
        if (blobField) st.blobPuts++;
        if (opts.webkit) {
          for (const hb of handedOut.get(k) ?? []) (hb as DeadableBlob).dead = true; // 옛 Blob 파일이 지워진다
          handedOut.delete(k);
        }
        if (blobField) {
          // 구 코드 모양(레코드에 Blob) — 그 Blob이 방금 죽었으면 새 레코드도 죽은 Blob을 가리킨다
          m.set(k, { kind: "legacy", blob: blobField, size: Number(raw.size) || 0, atime: Number(raw.atime) || 0 });
          return;
        }
        m.set(k, { kind: "bytes", bytes: e.bytes ? e.bytes.slice(0) : null, type: e.type, size: e.size, atime: e.atime });
      },
      touch: async (k, at) => {
        st.touches.push(k);
        st.ops.push(`touch:${k}`);
        const r = m.get(k);
        if (r && r.kind === "bytes") m.set(k, { ...r, atime: at }); // 목록 시각만 — 바이트는 그대로
      },
      delete: async (k) => {
        st.deletes.push(k);
        st.ops.push(`delete:${k}`);
        m.delete(k);
      },
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
    const { kv, st } = fakeKv("fp1", { k1: "저장된 오디오" });
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
    const { kv, st } = fakeKv("fp1", { k1: "x" });
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
    const { kv, st, m } = fakeKv("fp1", { k1: "x" });
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
    const { kv } = fakeKv("fp1", { k1: "x" });
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
    const { kv, st, m } = fakeKv("fp-old", { k1: "옛 목소리" });
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
    const { kv } = fakeKv("alloy|stub|i2", { [`ko-KR:1:${text}`]: `mp3:${text}` });
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

  // -------------------------------------------------------------------------
  // G. 영속 캐시 형식·자가 치유 (§16-5, 2026-09-27 iPhone 신고 "클라우드 실패(재생 NotSupportedError) → 기기 음성")
  //    원인(QA common_tts-notsupported_1 F1): ttsCacheGet이 IDB에서 꺼낸 Blob을 atime용으로 같은 키에 다시 put → WebKit에서
  //    이전 프로세스가 쓴 Blob 레코드를 다시 쓰면 꺼낸 Blob·레코드가 죽는다 → <audio> error 4 → play() NotSupportedError.
  //    가짜 KV의 webkit 모드가 그 결함을 모사한다 — G4가 구 알고리즘으로 모사가 실제로 죽이는지 먼저 잠근다(변이 잠금).
  //    수정: 바이트(ArrayBuffer)+형식 저장·꺼낼 때마다 새 메모리 Blob·조회 때 오디오 레코드 재기록 0(LRU는 목록만)·옛 Blob은 읽어서
  //    이전(실패면 미스+지움)·합성 응답 content-type 검사·재생 단계 미디어 소스 오류면 두 캐시에서 빼고 한 번 새로 받기(자가 치유).
  // -------------------------------------------------------------------------
  const FP = "alloy|stub|i2";
  const useKv = (b: TtsKvBackend) => {
    cache.setTtsFingerprintProvider(async () => FP);
    cache.setTtsKvBackend(b);
  };
  const flush = () => cache.__flushTtsCacheWrites();
  const isAB = (v: unknown): v is ArrayBuffer => v instanceof ArrayBuffer;
  /** ev0 이후 그 언어로 새로 기록된 진단(마지막 것) */
  const newDiag = (ev0: number, lang: string) => (diagEvents.slice(ev0).filter((e) => e.lang === lang) as DiagLike[]).pop();
  const newDiags = (ev0: number, lang: string) => diagEvents.slice(ev0).filter((e) => e.lang === lang) as DiagLike[];
  const readText = (b: Blob | null | undefined) => (b ? b.text().catch((e: Error) => `읽기 실패 ${e.name}`) : Promise.resolve("(null)"));

  // G1 저장 형식
  {
    const { kv, st, m } = fakeKv(FP);
    useKv(kv);
    await cache.ttsCacheGet("warm"); // 지문 확인(저장은 지문 조회를 새로 일으키지 않는다)
    await cache.ttsCachePut("k1", new Blob(["mp3:abc"], { type: "audio/mpeg" }));
    await cache.ttsCachePut("k2", new Blob(["mp3:def"], { type: "" }));
    await cache.ttsCachePut("k3", new Blob(["<html>portal</html>"], { type: "text/html" }));
    const r1 = m.get("k1");
    const r2 = m.get("k2");
    add(
      "영속캐시",
      "G1 저장은 바이트(ArrayBuffer)+형식 — 레코드에 Blob 없음(blobPuts 0)·형식 없는 Blob은 audio/mpeg·오디오 아닌 Blob(text/html)은 저장 안 함",
      r1?.kind === "bytes" && isAB(r1.bytes) && textOf(r1.bytes) === "mp3:abc" && r1.type === "audio/mpeg" && r1.size === 7 &&
        r2?.kind === "bytes" && r2.type === "audio/mpeg" && !m.has("k3") && st.blobPuts === 0,
      `k1=${r1?.kind}/${r1?.kind === "bytes" ? `${textOf(r1.bytes)}/${r1.type}/${r1.size}` : "-"} k2=${r2?.kind === "bytes" ? r2.type : "-"} k3=${m.has("k3")} blobPuts=${st.blobPuts}`,
    );
  }

  // G2 바이트 적중 — 새 메모리 Blob, 재기록 0, LRU는 목록 시각만
  {
    const { kv, st, m } = fakeKv(FP, { k1: "mp3:hello" });
    useKv(kv);
    const a = await cache.ttsCacheGet("k1");
    const b = await cache.ttsCacheGet("k1");
    await flush();
    const rec = m.get("k1");
    const at = await readText(a);
    add(
      "영속캐시",
      "G2 조회는 매번 새 메모리 Blob(audio/mpeg·같은 내용) — 조회 때 오디오 레코드 재기록 0(put 0), LRU는 목록 시각만(touch 2)",
      !!a && !!b && a !== b && a.type === "audio/mpeg" && at === "mp3:hello" && st.puts.length === 0 && st.touches.length === 2 &&
        rec?.kind === "bytes" && rec.atime > 0 && textOf(rec.bytes) === "mp3:hello",
      `같은객체=${a === b} type=${a?.type} 내용=${at} put ${st.puts.length} touch ${st.touches.length} atime=${rec?.atime ?? "-"}`,
    );
  }

  // G3 옛 형식(v1 Blob) — 읽어서 이전, WebKit 모사에서도 내준 Blob은 산다
  {
    const old = new DeadableBlob(["mp3:old"], { type: "audio/mpeg" });
    const { kv, st, m } = fakeKv(FP, {}, { legacy: { k1: old }, webkit: true });
    useKv(kv);
    const got = await cache.ttsCacheGet("k1");
    await flush();
    const gotText = await readText(got);
    const rec = m.get("k1");
    const again = await cache.ttsCacheGet("k1");
    await flush();
    add(
      "영속캐시",
      "G3 옛 형식(v1 Blob) 레코드: 바이트를 먼저 읽어 새 메모리 Blob으로 내주고 새 형식으로 이전 — 이전 쓰기로 옛 Blob이 죽어도(WebKit 모사) 내준 Blob은 읽힘, 다음 조회는 바이트 적중·재기록 0",
      gotText === "mp3:old" && got !== old && old.dead === true && rec?.kind === "bytes" && textOf(rec.bytes) === "mp3:old" &&
        rec.type === "audio/mpeg" && st.blobPuts === 0 && !!again && st.puts.length === 1 && st.touches.length === 1,
      `내준=${gotText} 옛Blob죽음=${old.dead} 이전=${rec?.kind} put ${st.puts.length} touch ${st.touches.length} 재조회=${again ? "적중" : "null"}`,
    );
  }

  // G4 변이 잠금 — 구 알고리즘(꺼낸 Blob을 같은 키에 다시 put)은 이 모사에서 죽는다
  {
    const old = new DeadableBlob(["mp3:old"], { type: "audio/mpeg" });
    const { kv, m } = fakeKv(FP, {}, { legacy: { k1: old }, webkit: true });
    const rec = (await kv.get("k1")) as { kind: "legacy"; blob: Blob; size: number; atime: number };
    // 2026-09-27 이전 ttsCacheGet 그대로: void b.put(key, { ...entry, atime: Date.now() }) → return entry.blob
    void kv.put("k1", { blob: rec.blob, size: rec.size, atime: Date.now() } as unknown as Parameters<TtsKvBackend["put"]>[1]);
    await sleep(1);
    const read = await rec.blob.arrayBuffer().then(() => "ok", (e: Error) => e.name);
    const again = m.get("k1");
    const readAgain = again?.kind === "legacy" ? await again.blob.arrayBuffer().then(() => "ok", (e: Error) => e.name) : "(형식 바뀜)";
    add(
      "영속캐시",
      "G4 변이 잠금 — 구 알고리즘(꺼낸 Blob을 같은 키에 다시 put)은 이 모사에서 꺼낸 Blob·레코드가 모두 죽음(NotFoundError) = G3·G8~G10이 잡는 결함이 실재",
      read === "NotFoundError" && readAgain === "NotFoundError",
      `꺼낸 Blob=${read} 레코드 재조회=${readAgain}`,
    );
  }

  // G5 쓸 수 없는 옛 레코드 → 미스+지움
  {
    const dead = new DeadableBlob(["mp3:dead"], { type: "audio/mpeg" });
    dead.dead = true;
    const html = new DeadableBlob(["<html>"], { type: "text/html" });
    const untyped = new DeadableBlob(["mp3:untyped"], { type: "" });
    const hang = new DeadableBlob(["mp3:hang"], { type: "audio/mpeg" });
    hang.hang = true;
    // 빈 옛 Blob(0바이트) — 형식이 audio/mpeg여도·빈 칸이어도 읽은 바이트가 0이면 쓸 수 없다(QA common_tts-notsupported_2 E4)
    const empty = new DeadableBlob([], { type: "audio/mpeg" });
    const emptyUntyped = new DeadableBlob([], { type: "" });
    const { kv, st, m } = fakeKv(FP, {}, { legacy: { kd: dead, kh: html, ku: untyped, kg: hang, ke: empty, kz: emptyUntyped } });
    useKv(kv);
    cache.__setLegacyReadTimeout(30);
    const t0 = Date.now();
    const [gd, gh, gu, gg, ge, gz] = await Promise.all(["kd", "kh", "ku", "kg", "ke", "kz"].map((k) => cache.ttsCacheGet(k)));
    const el = Date.now() - t0;
    await flush();
    cache.__setLegacyReadTimeout(null);
    const ut = await readText(gu);
    add(
      "영속캐시",
      "G5 쓸 수 없는 옛 레코드는 미스(null)+지움: 이미 죽음·오디오 아닌 형식(text/html)·읽기 매달림(상한 뒤)·빈 바이트(0B, 형식 있음·없음 — 빈 오디오를 새 형식으로 옮기지 않음) / 형식 없는 옛 Blob은 audio/mpeg로 살림",
      gd === null && gh === null && gg === null && ge === null && gz === null &&
        !m.has("kd") && !m.has("kh") && !m.has("kg") && !m.has("ke") && !m.has("kz") && !st.puts.includes("ke") && !st.puts.includes("kz") &&
        gu?.type === "audio/mpeg" && ut === "mp3:untyped" && el < 1000,
      `죽음=${gd} html=${gh} 매달림=${gg}(${el}ms) 빈=${ge ? `${ge.size}B` : "null"} 빈무형식=${gz ? `${gz.size}B` : "null"} 무형식=${gu?.type}/${ut} 남은키=${[...m.keys()].join(",")} put=${st.puts.join(",") || "0"}`,
    );
  }

  // G6 바이트 레코드 손상 → 미스+지움
  {
    const { kv, st, m } = fakeKv(FP);
    m.set("nobytes", { kind: "bytes", bytes: null, type: "audio/mpeg", size: 0, atime: 0 });
    m.set("empty", { kind: "bytes", bytes: new ArrayBuffer(0), type: "audio/mpeg", size: 0, atime: 0 });
    m.set("html", { kind: "bytes", bytes: bytesOf("<html>"), type: "text/html", size: 6, atime: 0 });
    m.set("notype", { kind: "bytes", bytes: bytesOf("mp3:nt"), type: "", size: 6, atime: 0 });
    useKv(kv);
    const r = await Promise.all(["nobytes", "empty", "html", "notype"].map((k) => cache.ttsCacheGet(k)));
    await flush();
    add(
      "영속캐시",
      "G6 바이트 레코드 손상(바이트 없음·빈 바이트·오디오 아닌 형식)은 미스+지움 / 형식 빈 칸은 audio/mpeg로 복원 — 재기록 0",
      r[0] === null && r[1] === null && r[2] === null && r[3]?.type === "audio/mpeg" && !m.has("nobytes") && !m.has("empty") && !m.has("html") && m.has("notype") && st.puts.length === 0,
      `결과=${r.map((x) => (x ? x.type || "(무형식)" : "null")).join(",")} 남은키=${[...m.keys()].join(",")} put ${st.puts.length}`,
    );
  }

  // ---- 앱 경로(speech.ts → tts-cache) ----
  sp.setTtsEngine("ja-JP", "cloud");
  await settle(sp);

  // G7 단발 — IDB 바이트 적중
  {
    const key = "ja-JP:1:みみ";
    const { kv, st } = fakeKv(FP, { [key]: "mp3:みみ" });
    useKv(kv);
    const ev0 = diagEvents.length;
    sp.speak("みみ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.urlCreated >= 1 && env.liveUrls.size === 0, 1000);
    await flush();
    const d = newDiag(ev0, "ja-JP");
    const played = urlBlob.get(lastTtsUrl);
    add(
      "영속캐시",
      "G7 앱 경로(단발): IDB 바이트 적중 → POST 0·클라우드 ✓·재생한 것은 새 메모리 Blob(audio/mpeg)·조회 때 오디오 재기록 0·기기 0",
      env.posts.length === 0 && d?.ok === true && !d.healed && played?.type === "audio/mpeg" && !(played instanceof DeadableBlob) && st.puts.length === 0 && deviceTexts().length === 0,
      `POST ${env.posts.length} diag=${dshort(d)} 재생 type=${played?.type} put ${st.puts.length} device=${deviceTexts().join("|") || "0"}`,
    );
    await settle(sp);
  }

  // G8 단발 — 옛 형식(WebKit 모사): 재실행 뒤 🔊 → POST 0·✓·이전 → 새로고침 뒤 🔊도 POST 0·✓
  {
    const key = "ja-JP:1:あめ";
    const old = new DeadableBlob(["mp3:あめ"], { type: "audio/mpeg" });
    const { kv, st, m } = fakeKv(FP, {}, { legacy: { [key]: old }, webkit: true });
    useKv(kv);
    let ev0 = diagEvents.length;
    sp.speak("あめ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1000);
    const d1 = newDiag(ev0, "ja-JP");
    await flush();
    const migrated = m.get(key)?.kind;
    sp.__clearTtsMemoryCache(); // 새로고침(메모리 비움) — 이번엔 바이트 레코드 적중
    ev0 = diagEvents.length;
    sp.speak("あめ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1000);
    const d2 = newDiag(ev0, "ja-JP");
    add(
      "영속캐시",
      "G8 앱 경로(단발): 옛 형식 레코드(WebKit 모사 — 이전 쓰기가 옛 Blob을 죽임) → POST 0·클라우드 ✓(치유 없이)·새 형식 이전 → 새로고침 뒤 🔊도 POST 0·✓",
      env.posts.length === 0 && d1?.ok === true && !d1.healed && d2?.ok === true && !d2.healed && migrated === "bytes" && old.dead === true && deviceTexts().length === 0 && st.puts.length === 1,
      `POST ${env.posts.length} 1차=${dshort(d1)} 2차=${dshort(d2)} 이전=${migrated} put ${st.puts.length} device=${deviceTexts().join("|") || "0"}`,
    );
    await settle(sp);
  }

  // G9 단발 — 이미 죽은 옛 레코드(배포 직후 같은 프로세스): 미스 → 지움 → 재합성 1 POST → ✓
  {
    const key = "ja-JP:1:かぜ";
    const dead = new DeadableBlob(["mp3:かぜ"], { type: "audio/mpeg" });
    dead.dead = true;
    const { kv, m } = fakeKv(FP, {}, { legacy: { [key]: dead }, webkit: true });
    useKv(kv);
    const ev0 = diagEvents.length;
    sp.speak("かぜ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1000);
    await flush();
    const d = newDiag(ev0, "ja-JP");
    const rec = m.get(key);
    add(
      "영속캐시",
      "G9 앱 경로(단발): 옛 코드가 이미 죽인 레코드 → 읽기 검증 실패 → 지우고 재합성(POST 1) → 클라우드 ✓·새 형식 저장·기기 0",
      env.posts.join("|") === "かぜ" && d?.ok === true && !d.healed && rec?.kind === "bytes" && textOf(rec.bytes) === "mp3:かぜ" && deviceTexts().length === 0,
      `POST=${env.posts.join("|")} diag=${dshort(d)} 저장=${rec?.kind}/${rec?.kind === "bytes" ? textOf(rec.bytes) : "-"} device=${deviceTexts().join("|") || "0"}`,
    );
    await settle(sp);
  }

  // G10 자가 치유 — 단발(play() NotSupportedError 경로)
  {
    const key = "ja-JP:1:くも";
    const { kv, st, m } = fakeKv(FP, { [key]: "CORRUPT:くも" });
    useKv(kv);
    const ev0 = diagEvents.length;
    sp.speak("くも", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.urlCreated >= 2 && env.liveUrls.size === 0, 1500);
    await flush();
    const d = newDiag(ev0, "ja-JP");
    const rec = m.get(key);
    add(
      "영속캐시",
      "G10 자가 치유(단발): 캐시 오디오가 재생 NotSupportedError → 두 캐시에서 빼고 새로 받아(POST 1) 같은 요소로 클라우드 ✓ — 진단 healed·IDB는 새 오디오·기기 0·URL 2/2",
      env.posts.join("|") === "くも" && d?.ok === true && d.healed === true && st.deletes.includes(key) && rec?.kind === "bytes" && textOf(rec.bytes) === "mp3:くも" &&
        deviceTexts().length === 0 && env.urlCreated === 2 && env.urlRevoked === 2 && queueEls().length === 1,
      `POST=${env.posts.join("|") || "0"} diag=${dshort(d)} 지움=${st.deletes.join(",") || "0"} IDB=${rec?.kind === "bytes" ? textOf(rec.bytes) : rec?.kind ?? "없음"} device=${deviceTexts().join("|") || "0"} URL ${env.urlCreated}/${env.urlRevoked}`,
    );
    await settle(sp);
  }

  // G11 자가 치유 — error 이벤트(code 4)가 먼저 와도 같다 / MEDIA_ERR_ABORTED(1)는 오디오 문제가 아니다(치유 안 함)
  {
    const key = "ja-JP:1:そら";
    const { kv } = fakeKv(FP, { [key]: "CORRUPT:そら" });
    useKv(kv);
    env.mediaErrorVia = "event";
    let ev0 = diagEvents.length;
    sp.speak("そら", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.urlCreated >= 2 && env.liveUrls.size === 0, 1500);
    const d4 = newDiag(ev0, "ja-JP");
    const posts4 = env.posts.length;
    await settle(sp);

    const key1 = "ja-JP:1:うみ";
    const kv1 = fakeKv(FP, { [key1]: "CORRUPT:うみ" });
    useKv(kv1.kv);
    env.mediaErrorVia = "event";
    env.mediaErrorCode = 1;
    ev0 = diagEvents.length;
    sp.speak("うみ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().includes("うみ"), 1500);
    await flush();
    const d1 = newDiag(ev0, "ja-JP");
    add(
      "영속캐시",
      "G11 error 이벤트(code 4)가 먼저 와도 치유(POST 1·✓ healed) / code 1(MEDIA_ERR_ABORTED)은 치유 안 함(POST 0·기기 음성·캐시 유지)",
      posts4 === 1 && d4?.ok === true && d4.healed === true &&
        env.posts.length === 0 && d1?.ok === false && d1.stage === "play" && d1.reason === "audio play error" && !d1.healed && d1.fallback === "device" && kv1.st.deletes.length === 0,
      `code4: POST ${posts4} ${dshort(d4)} / code1: POST ${env.posts.length} ${dshort(d1)} 지움 ${kv1.st.deletes.length}`,
    );
    await settle(sp);
  }

  // G12 자가 치유는 1회뿐 — 새로 받은 것도 못 틀면 기기 음성, 캐시에 남기지 않음, 다음 🔊도 1 POST(치유 없이)
  {
    const key = "ja-JP:1:ゆき";
    const { kv, m } = fakeKv(FP, { [key]: "CORRUPT:old" });
    useKv(kv);
    env.postBodyFor = () => "CORRUPT:new";
    let ev0 = diagEvents.length;
    sp.speak("ゆき", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().includes("ゆき"), 1500);
    await sleep(20);
    await flush();
    const d1 = newDiag(ev0, "ja-JP");
    const posts1 = env.posts.length;
    const kept = m.has(key);
    ev0 = diagEvents.length;
    sp.speak("ゆき", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().filter((t) => t === "ゆき").length >= 2, 1500);
    await sleep(20);
    await flush();
    const d2 = newDiag(ev0, "ja-JP");
    add(
      "영속캐시",
      "G12 자가 치유 1회뿐: 새로 받은 것도 재생 실패 → 기기 음성(POST 정확히 1·진단 play/NotSupportedError/device/healed)·못 트는 오디오는 두 캐시에 안 남김 → 다음 🔊도 POST 1(캐시 아님 → 치유 없이 기기)",
      posts1 === 1 && d1?.ok === false && d1.stage === "play" && d1.reason === "NotSupportedError" && d1.fallback === "device" && d1.healed === true && !kept &&
        env.posts.length === 2 && d2?.ok === false && d2.stage === "play" && !d2.healed && !m.has(key),
      `1차 POST ${posts1} ${dshort(d1)} 캐시남음=${kept} / 2차 POST 누적 ${env.posts.length} ${dshort(d2)} 캐시남음=${m.has(key)}`,
    );
    await settle(sp);
  }

  // G13 오디오 문제가 아닌 재생 실패(iOS NotAllowedError)는 치유 대상이 아니다 — POST 0·캐시 유지
  {
    const key = "ja-JP:1:ほし";
    const { kv, st } = fakeKv(FP, { [key]: "mp3:ほし" });
    useKv(kv);
    env.playRejectName = "NotAllowedError";
    let ev0 = diagEvents.length;
    sp.speak("ほし", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().includes("ほし"), 1500);
    const d1 = newDiag(ev0, "ja-JP");
    env.playRejectName = null;
    ev0 = diagEvents.length;
    sp.speak("ほし", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1500);
    await flush();
    const d2 = newDiag(ev0, "ja-JP");
    add(
      "영속캐시",
      "G13 NotAllowedError(iOS 재생 차단)는 치유 대상 아님 — POST 0·캐시 지움 0·기기 음성, 풀리면 같은 캐시로 ✓",
      env.posts.length === 0 && d1?.reason === "NotAllowedError" && !d1.healed && st.deletes.length === 0 && d2?.ok === true,
      `POST ${env.posts.length} 1차=${dshort(d1)} 2차=${dshort(d2)} 지움 ${st.deletes.length}`,
    );
    await settle(sp);
  }

  // G14 합성 응답 content-type — 200인데 오디오가 아니면 합성 단계 'tts type' → 기기, 두 캐시에 안 남음 / 매개변수 붙은 audio/mpeg는 정상
  {
    const { kv, m } = fakeKv(FP);
    useKv(kv);
    env.postContentTypeFor = () => "text/html; charset=utf-8";
    let ev0 = diagEvents.length;
    sp.speak("はれ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().includes("はれ"), 1500);
    const d1 = newDiag(ev0, "ja-JP");
    ev0 = diagEvents.length;
    sp.speak("はれ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().filter((t) => t === "はれ").length >= 2, 1500);
    await flush();
    const postsHtml = env.posts.filter((t) => t === "はれ").length;
    const keptHtml = m.has("ja-JP:1:はれ");
    env.postContentTypeFor = () => "audio/mpeg; charset=binary";
    ev0 = diagEvents.length;
    sp.speak("くもり", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1500);
    await flush();
    const d3 = newDiag(ev0, "ja-JP");
    const rec = m.get("ja-JP:1:くもり");
    add(
      "영속캐시",
      "G14 합성 200 + text/html → 합성 단계 'tts type'·기기 음성·메모리·IDB에 안 남음(다시 누르면 다시 POST, 재생 URL 0) / 'audio/mpeg; charset=binary'는 정상 재생·저장 형식 audio/mpeg",
      d1?.ok === false && d1.stage === "synth" && d1.reason === "tts type" && d1.fallback === "device" && postsHtml === 2 && !keptHtml &&
        d3?.ok === true && rec?.kind === "bytes" && rec.type === "audio/mpeg" && env.urlCreated === 1,
      `html=${dshort(d1)} POST ${postsHtml} 캐시=${keptHtml} / 매개변수=${dshort(d3)} 저장형식=${rec?.kind === "bytes" ? rec.type : "-"} URL ${env.urlCreated}`,
    );
    await settle(sp);
  }

  // G15 자가 치유 — 큐(speakQueue): 손상된 캐시 조각은 새로 받아 재생, 다음 조각은 캐시 그대로
  {
    const { kv } = fakeKv(FP, { "ko-KR:1:손상된 조각.": "CORRUPT", "ko-KR:1:정상 조각.": "mp3:정상 조각." });
    useKv(kv);
    const ev0 = diagEvents.length;
    const r = startQueue(sp, [ko("손상된 조각."), ko("정상 조각.")], "H");
    await waitFor(() => r.ends.length > 0, 2000);
    const ds = newDiags(ev0, "ko-KR");
    add(
      "영속캐시",
      "G15 자가 치유(큐): 손상된 캐시 조각 → 새로 받아(POST 1) 클라우드로 → 다음 조각은 캐시(POST 0) — done·sounded 2·기기 0·진단 [✓healed, ✓]",
      JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.sounded) === "[2]" && env.posts.join("|") === "손상된 조각." && deviceTexts().length === 0 &&
        ds.length === 2 && ds[0].ok && ds[0].healed === true && ds[1].ok && !ds[1].healed,
      `ends=${r.ends.join(",")} sounded=${r.sounded.join(",")} POST=${env.posts.join("|") || "0"} device=${deviceTexts().join("|") || "0"} diag=${ds.map((x) => dshort(x)).join(" · ")}`,
    );
    await settle(sp);
  }

  // G16 자가 치유 1회(큐): 새로 받은 조각도 못 틀면 그 조각만 기기 음성 — POST 1, done, 진단 healed 실패
  {
    const { kv } = fakeKv(FP, { "ko-KR:1:또 손상.": "CORRUPT" });
    useKv(kv);
    env.postBodyFor = (t) => (t === "또 손상." ? "CORRUPT:new" : `mp3:${t}`);
    const ev0 = diagEvents.length;
    const r = startQueue(sp, [ko("또 손상."), ko("멀쩡한 새 조각.")], "H2");
    await waitFor(() => r.ends.length > 0, 2000);
    const ds = newDiags(ev0, "ko-KR");
    add(
      "영속캐시",
      "G16 자가 치유 1회(큐): 새로 받은 것도 재생 실패 → 그 조각만 기기 음성(POST 그 조각 1)·다음 조각 클라우드·done·sounded 2·진단 [실패 healed, ✓]",
      JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.sounded) === "[2]" && env.posts.filter((t) => t === "또 손상.").length === 1 &&
        deviceTexts().join("|") === "또 손상." && ds.length === 2 && !ds[0].ok && ds[0].healed === true && ds[0].stage === "play" && ds[1].ok,
      `ends=${r.ends.join(",")} POST=${env.posts.join("|")} device=${deviceTexts().join("|") || "0"} diag=${ds.map((x) => dshort(x)).join(" · ")}`,
    );
    await settle(sp);
  }

  // G17 프리페치도 같은 관문 — 죽은 옛 레코드는 지우고 재합성(POST 1), 멀쩡한 옛 레코드는 POST 0으로 이전
  {
    const dead = new DeadableBlob(["mp3:やま"], { type: "audio/mpeg" });
    dead.dead = true;
    const alive = new DeadableBlob(["mp3:かわ"], { type: "audio/mpeg" });
    const { kv, m } = fakeKv(FP, {}, { legacy: { "ja-JP:1:やま": dead, "ja-JP:1:かわ": alive }, webkit: true });
    useKv(kv);
    const stop = sp.prefetchSpeech(["やま", "かわ"], "ja-JP");
    await waitFor(() => m.get("ja-JP:1:やま")?.kind === "bytes" && m.get("ja-JP:1:かわ")?.kind === "bytes", 1500);
    await sleep(10);
    await flush();
    stop();
    const ry = m.get("ja-JP:1:やま");
    const rk = m.get("ja-JP:1:かわ");
    add(
      "영속캐시",
      "G17 프리페치도 같은 관문: 죽은 옛 레코드는 재합성(POST 1)·멀쩡한 옛 레코드는 POST 0으로 새 형식 이전",
      env.posts.join("|") === "やま" && ry?.kind === "bytes" && textOf(ry.bytes) === "mp3:やま" && rk?.kind === "bytes" && textOf(rk.bytes) === "mp3:かわ",
      `POST=${env.posts.join("|") || "0"} やま=${ry?.kind}/${ry?.kind === "bytes" ? textOf(ry.bytes) : "-"} かわ=${rk?.kind}/${rk?.kind === "bytes" ? textOf(rk.bytes) : "-"}`,
    );
    await settle(sp);
  }

  // ---- eval 공백 보강(QA common_tts-notsupported_2 E2~E4) — 변이가 살아남던 규칙을 하나씩 잠근다 ----

  // G18 큐 치유의 fromCache 가드(E2) — **방금 네트워크로 받은** 조각이 못 틀면 치유(재합성) 없이 그 조각만 기기 음성.
  //     단발은 G12 둘째 🔊가 잠근다. 큐 쪽 `if (!fromCache) throw e`를 지우면 조각당 POST 2·진단 healed가 된다(§16-5 "방금 받은 것은 곧바로 기기").
  {
    const bad = "새로 받은 손상.";
    const next = "다음 새 조각.";
    const { kv, m } = fakeKv(FP); // 캐시 비어 있음 — 두 조각 다 네트워크에서 온다
    useKv(kv);
    env.postBodyFor = (t) => (t === bad ? "CORRUPT:new" : `mp3:${t}`);
    const ev0 = diagEvents.length;
    const r = startQueue(sp, [ko(bad), ko(next)], "H3");
    await waitFor(() => r.ends.length > 0, 2000);
    await sleep(10);
    await flush();
    const ds = newDiags(ev0, "ko-KR");
    const postsBad = env.posts.filter((t) => t === bad).length;
    const postsNext = env.posts.filter((t) => t === next).length;
    add(
      "영속캐시",
      "G18 큐 치유의 fromCache 가드: 방금 네트워크로 받은 조각이 재생 실패 → 치유 없이(그 조각 POST 정확히 1·진단 healed 아님) 그 조각만 기기 음성·못 트는 오디오는 IDB에 안 남음·다음 조각 클라우드·done·sounded 2",
      JSON.stringify(r.ends) === '["done"]' && JSON.stringify(r.sounded) === "[2]" && postsBad === 1 && postsNext === 1 && deviceTexts().join("|") === bad &&
        ds.length === 2 && !ds[0].ok && !ds[0].healed && ds[0].stage === "play" && ds[0].reason === "NotSupportedError" && ds[0].fallback === "device" &&
        ds[1].ok && !ds[1].healed && !m.has(`ko-KR:1:${bad}`) && m.has(`ko-KR:1:${next}`),
      `ends=${r.ends.join(",")} sounded=${r.sounded.join(",")} POST 손상=${postsBad} 다음=${postsNext} device=${deviceTexts().join("|") || "0"} diag=${ds.map((x) => dshort(x)).join(" · ")} IDB 손상=${m.has(`ko-KR:1:${bad}`)}`,
    );
    await settle(sp);
  }

  // G19 쓰기 줄 순서(E3) — 치유 삭제는 **먼저 시작된 저장 뒤에** 끝난다. 삭제가 줄 밖에서 먼저 끝나면 늦게 끝난 저장이 방금 지운
  //     못 트는 오디오를 IDB에 되살리고, 다음 실행의 🔊가 그걸 캐시로 받아 치유 1회(POST)를 또 낸다.
  //     ① 모듈 단위: 저장의 바이트 읽기가 늦다(SlowReadBlob) — 삭제를 줄 밖에서 돌리는 변이·저장이 바이트를 읽은 **뒤에** 줄 자리를 잡는 변이를 모두 잡는다.
  //     ② 앱 경로: 새 합성 → 저장(백엔드 put이 느림) → 재생 실패 → 치유 삭제 — QA가 적은 실제 경합 그대로.
  {
    const { kv, st, m } = fakeKv(FP);
    useKv(kv);
    await cache.ttsCacheGet("warm"); // 지문 확인(저장·삭제는 지문 조회를 새로 일으키지 않는다)
    const slow = new SlowReadBlob(["CORRUPT:late"], { type: "audio/mpeg" });
    slow.delayMs = 30;
    const pPut = cache.ttsCachePut("k-late", slow); // 저장 시작 — 바이트를 읽는 중
    const pDel = cache.ttsCacheDelete("k-late"); // 그 사이 재생 실패 → 치유 삭제
    await Promise.all([pPut, pDel]);
    await flush();
    const opsUnit = st.ops.filter((o) => o.endsWith(":k-late"));
    const unitOk = !m.has("k-late") && JSON.stringify(opsUnit) === '["put:k-late","delete:k-late"]';
    await settle(sp);

    const key = "ja-JP:1:なみ";
    const app = fakeKv(FP, {}, { putDelayMs: 40 });
    useKv(app.kv);
    env.postBodyFor = () => "CORRUPT:new";
    const ev0 = diagEvents.length;
    sp.speak("なみ", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && deviceTexts().includes("なみ"), 1500);
    await sleep(60); // 느린 put(40ms)이 끝날 시간
    await flush();
    const d = newDiag(ev0, "ja-JP");
    const opsApp = app.st.ops.filter((o) => o.endsWith(`:${key}`));
    add(
      "영속캐시",
      "G19 쓰기 줄 순서: 치유 삭제는 먼저 시작된 저장 뒤에 끝남 — ① 바이트 읽기가 늦은 저장 + 곧바로 삭제 → 순서 put→delete·키 없음 ② 앱 경로(새 합성 → 느린 저장 중 재생 실패 → 삭제) → 못 트는 오디오가 IDB에 되살아나지 않음",
      unitOk && !app.m.has(key) && JSON.stringify(opsApp) === JSON.stringify([`put:${key}`, `delete:${key}`]) &&
        env.posts.join("|") === "なみ" && d?.ok === false && d.stage === "play" && !d.healed && d.fallback === "device",
      `① ops=${opsUnit.join(">") || "0"} 남음=${m.has("k-late")} ② ops=${opsApp.join(">") || "0"} 남음=${app.m.has(key)} POST=${env.posts.join("|") || "0"} diag=${dshort(d)}`,
    );
    await settle(sp);
  }

  // G20 빈 옛 레코드의 앱 경로(E4) — 0바이트 v1 Blob은 미스 → 지움 → 재합성(POST 1) → 클라우드 ✓(치유 아님)·새 형식 저장.
  //     빈 바이트 검사가 빠지면 빈 오디오가 캐시 적중으로 나가 재생이 한 번 실패한 뒤 치유 경로로 돈다(진단 healed) —
//     POST 수는 같은 1회지만 실패한 재생과 지연이 생긴다. 이 잠금은 POST 수가 아니라 healed·put 횟수로 잡는다(QA F1).
  {
    const key = "ja-JP:1:つき";
    const empty = new DeadableBlob([], { type: "audio/mpeg" });
    const { kv, st, m } = fakeKv(FP, {}, { legacy: { [key]: empty }, webkit: true });
    useKv(kv);
    const ev0 = diagEvents.length;
    sp.speak("つき", "ja-JP");
    await waitFor(() => newDiag(ev0, "ja-JP") !== undefined && env.liveUrls.size === 0, 1500);
    await flush();
    const d = newDiag(ev0, "ja-JP");
    const rec = m.get(key);
    add(
      "영속캐시",
      "G20 앱 경로(단발): 빈 옛 레코드(0B) → 미스·지움 → 재합성(POST 1) → 클라우드 ✓(치유 아님)·새 형식 저장(내용 있음)·빈 오디오 이전 0·기기 0",
      env.posts.join("|") === "つき" && d?.ok === true && !d.healed && st.deletes.includes(key) && rec?.kind === "bytes" && textOf(rec.bytes) === "mp3:つき" &&
        st.puts.length === 1 && deviceTexts().length === 0,
      `POST=${env.posts.join("|") || "0"} diag=${dshort(d)} 지움=${st.deletes.join(",") || "0"} put ${st.puts.length} 저장=${rec?.kind}/${rec?.kind === "bytes" ? textOf(rec.bytes) : "-"} device=${deviceTexts().join("|") || "0"}`,
    );
    await settle(sp);
  }
  cache.setTtsFingerprintProvider(null);
  cache.setTtsKvBackend(null);
}

// ---------------------------------------------------------------------------
// 끝까지 가지 못한 실행을 통과로 세지 않는다(QA common_tts-notsupported_2 E1).
// main()이 풀리지 않는 약속을 기다리면(예: 옛 Blob 읽기 상한이 빠진 회귀 — G5의 매달림 케이스) 이벤트 루프가 비는 순간
// Node는 **exit 0**으로 조용히 끝난다 — 표도 PASS/FAIL 줄도 없이. exit code만 보는 게이트는 그걸 통과로 센다. 두 겹으로 막는다:
// ① beforeExit — 루프가 비었는데 finally에 닿지 못했다 → 지금까지의 표 + FAIL + exit 1(대부분의 매달림은 이쪽)
// ② 워치독 — 타이머·핸들이 루프를 붙잡아 영영 안 끝나는 경우 → 상한 뒤 같은 처리. unref라 정상 종료를 늦추지 않는다.
//    평소 실행은 ~8초다. 상한은 env `EVAL_SPEECH_WATCHDOG_MS`(기본 120초)로 바꿀 수 있다(변이 확인용).
// ---------------------------------------------------------------------------
let finished = false;
function failUnfinished(why: string): void {
  if (finished) return;
  finished = true;
  printTable(results);
  const last = results[results.length - 1];
  console.error(
    `FAIL — eval이 끝까지 가지 못했다(${why}). 기록된 항목 ${results.length}개 — 마지막 기록 ${last ? `[${last.book}] ${last.check.slice(0, 80)}` : "(없음)"} 다음 점검에서 멈췄다.`,
  );
  process.exit(1);
}
process.on("beforeExit", () => failUnfinished("풀리지 않는 비동기 대기 — 이벤트 루프가 빈 채로 멈춤"));
const WATCHDOG_MS = Number(process.env.EVAL_SPEECH_WATCHDOG_MS) > 0 ? Number(process.env.EVAL_SPEECH_WATCHDOG_MS) : 120_000;
setTimeout(() => failUnfinished(`워치독 ${WATCHDOG_MS}ms 초과`), WATCHDOG_MS).unref();

main()
  .catch((e) => {
    add("실행", "eval 실행 중 예외", false, String((e as Error)?.stack ?? e).slice(0, 300));
  })
  .finally(() => {
    finished = true;
    printTable(results);
    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.error(`FAIL — 해설 낭독 ${failed.length}개 항목 실패.`);
      process.exit(1);
    }
    console.log(`PASS — 해설 낭독 ${results.length}개 항목 통과 (실호출 0회).`);
    process.exit(0);
  });

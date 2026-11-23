/**
 * lib/ja-daily-quiz.ts — 🗓️ 오늘의 일본어 **화면용 순수 함수**(설계 §4·§5). 화면·eval 공용 — 런타임 import 0(타입만).
 *
 * - 단어 5지선다 `buildJaDailyVocabQuestions` — 오답 보기는 회차 응답의 `pool`(같은 DAY + 앞뒤 DAY)에서 **결정적으로** 고른다
 *   (`Math.random` 없음 — 같은 단어는 언제 열어도 같은 보기·같은 자리). 같은 뜻·같은 읽기 보기는 뺀다.
 *   모드: 뜻 고르기(표기 → 한국어 뜻) / 읽기 고르기(표기 → 가나 읽기). 짝수 번째 = 뜻, 홀수 번째 = 읽기(DAY 시험 25문항 → 뜻 13 + 읽기 12).
 *   표기가 가나뿐이라 읽기가 곧 표기인 단어는 읽기 문제가 거저라 뜻 고르기로 바꾼다.
 * - 따라 말하기 큐 `buildJaDailyShadowItems` — 문장마다 한국어 1번 → 일본어 N번(일본어 뒤 따라 말할 틈 `pauseAfterMs`).
 * - 밑줄 `[[ ]]` 쪼개기, 칸 이름(허브 카드·홈·회차 머리 공용).
 *
 * 일본어 조각은 trim만 한다 — 🔊 단발·큐가 같은 문자열을 써야 발음 캐시를 같이 쓴다(app-patterns §8 "낭독 대본").
 */
import type { JaDailyLine, JaDailyTipDrill, JaDailyTrackPart, JaDailyWord, JaDailyMockSectionName } from "./ja-daily-content";
import type { JaDailyContentIndex, JaDailyExamSlot, JaDailyKaiwaSlot, JaDailySession, JaDailyVocabSlot } from "./ja-daily-plan";

// ---------------------------------------------------------------------------
// 결정적 해시(FNV-1a 32bit)
// ---------------------------------------------------------------------------

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// 단어 5지선다
// ---------------------------------------------------------------------------

export type JaDailyVocabQuizMode = "meaning" | "reading";

export interface JaDailyVocabQuestion {
  wordId: string;
  mode: JaDailyVocabQuizMode;
  /** 문제로 보이는 표기(후리가나 없이 — 읽기 고르기에서 답이 보이지 않게) */
  written: string;
  /** 정답 공개 뒤 함께 보일 읽기·뜻 */
  reading: string;
  meaningKo: string;
  choices: string[];
  /** choices 안 정답 자리(0부터) */
  answerIndex: number;
}

/** 보기 수(정답 포함) */
export const JA_DAILY_VOCAB_CHOICES = 5;

const KANA_ONLY = /^[ぁ-ゖァ-ヺーゝゞヽヾ・]+$/;

/** 가타카나 → 히라가나(읽기 비교용) */
function toHiragana(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch;
  }
  return out;
}

/** 표기가 가나뿐이고 읽기와 같다 — 읽기 고르기가 거저인 단어 */
export function isJaDailyReadingTrivial(w: Pick<JaDailyWord, "written" | "reading">): boolean {
  return KANA_ONLY.test(w.written) && toHiragana(w.written) === toHiragana(w.reading);
}

/** 뜻 조각 — "높다, 비싸다" → ["높다","비싸다"]. 괄호 풀이는 뗀다 */
export function jaDailyMeaningParts(meaningKo: string): string[] {
  return meaningKo
    .replace(/\([^)]*\)|（[^）]*）/g, " ")
    .split(/[,;/·、，；]/)
    .map((p) => p.replace(/\s+/g, "").trim())
    .filter((p) => p.length > 0);
}

/** 두 뜻이 겹치는가(조각 하나라도 같으면 같은 뜻으로 본다 — 보기에 정답이 둘이 되지 않게) */
export function jaDailySameMeaning(a: string, b: string): boolean {
  const pa = new Set(jaDailyMeaningParts(a));
  if (pa.size === 0) return a.trim() === b.trim();
  return jaDailyMeaningParts(b).some((p) => pa.has(p)) || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function sameReading(a: string, b: string): boolean {
  return toHiragana(a.trim()) === toHiragana(b.trim());
}

/** 문제 한 개 — 오답 보기가 하나도 없으면 null */
export function buildJaDailyVocabQuestion(word: JaDailyWord, mode: JaDailyVocabQuizMode, pool: readonly JaDailyWord[]): JaDailyVocabQuestion | null {
  const valueOf = (w: JaDailyWord) => (mode === "meaning" ? w.meaningKo.trim() : w.reading.trim());
  const answer = valueOf(word);
  const same = (x: string) => (mode === "meaning" ? jaDailySameMeaning(x, answer) : sameReading(x, answer));
  const seen = new Set<string>();
  const cands: { v: string; h: number }[] = [];
  for (const c of pool) {
    if (c.id === word.id) continue;
    const v = valueOf(c);
    if (v === "" || same(v)) continue;
    const key = mode === "meaning" ? v.replace(/\s+/g, "") : toHiragana(v);
    if (seen.has(key)) continue;
    // 고른 오답끼리도 같은 뜻이면 하나만(정답이 아닌 보기 둘이 같은 말이면 보기 수가 줄어든 셈이다)
    if (mode === "meaning" && cands.some((x) => jaDailySameMeaning(x.v, v))) continue;
    seen.add(key);
    cands.push({ v, h: fnv(`${word.id}|${mode}|${c.id}`) });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.h - b.h || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  const wrong = cands.slice(0, JA_DAILY_VOCAB_CHOICES - 1).map((x) => x.v);
  const at = fnv(`${word.id}|${mode}|at`) % (wrong.length + 1);
  const choices = [...wrong.slice(0, at), answer, ...wrong.slice(at)];
  return { wordId: word.id, mode, written: word.written, reading: word.reading, meaningKo: word.meaningKo, choices, answerIndex: at };
}

/**
 * 문제 목록 — 단어 순서 그대로. i번째 단어는 i 짝수 = 뜻, 홀수 = 읽기(읽기가 거저면 뜻).
 * 정한 모드로 보기를 못 만들면 다른 모드로 한 번 더, 그래도 없으면 그 단어는 뺀다.
 */
export function buildJaDailyVocabQuestions(words: readonly JaDailyWord[], pool: readonly JaDailyWord[]): JaDailyVocabQuestion[] {
  const all = [...pool, ...words];
  const out: JaDailyVocabQuestion[] = [];
  words.forEach((w, i) => {
    const want: JaDailyVocabQuizMode = i % 2 === 1 && !isJaDailyReadingTrivial(w) ? "reading" : "meaning";
    const q = buildJaDailyVocabQuestion(w, want, all) ?? (want === "reading" ? buildJaDailyVocabQuestion(w, "meaning", all) : isJaDailyReadingTrivial(w) ? null : buildJaDailyVocabQuestion(w, "reading", all));
    if (q) out.push(q);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 따라 말하기 큐
// ---------------------------------------------------------------------------

export interface JaDailyShadowItem {
  text: string;
  lang: "ja-JP" | "ko-KR";
  pauseAfterMs?: number;
  /** 몇 번째 문장(0부터) — 화면 강조용 */
  line: number;
}

/** 따라 말할 틈(속도 1 기준 ms) — 글자 수에 비례, 1.5~8초 */
export function jaDailyShadowPauseMs(ja: string): number {
  const n = [...ja.replace(/[\s。、！？!?「」『』…・]/g, "")].length;
  return Math.max(1500, Math.min(8000, 1200 + n * 220));
}

/** 반복 횟수 선택지 */
export const JA_DAILY_SHADOW_REPEATS = [1, 2, 3] as const;

/** 문장마다 한국어 1번 → 일본어 N번(일본어 뒤마다 틈). from번째 문장부터 */
export function buildJaDailyShadowItems(lines: readonly Pick<JaDailyLine, "ja" | "ko">[], repeat: number, from = 0): JaDailyShadowItem[] {
  const n = Math.max(1, Math.min(5, Math.floor(repeat) || 1));
  const out: JaDailyShadowItem[] = [];
  for (let i = Math.max(0, from); i < lines.length; i++) {
    const ja = lines[i].ja.trim();
    const ko = lines[i].ko.trim();
    if (!ja) continue;
    if (ko) out.push({ text: ko, lang: "ko-KR", line: i });
    for (let k = 0; k < n; k++) out.push({ text: ja, lang: "ja-JP", pauseAfterMs: jaDailyShadowPauseMs(ja), line: i });
  }
  return out;
}

/**
 * 청해 요령 원음 대본 → 따라 말하기 한 줄 목록. 번호 묶음을 넘어 전체 문장 순서로 잇고,
 * offsets[di] = di번째 묶음 첫 문장의 전체 index(화면 강조 = offsets[di] + i — 큐의 line과 같은 기준).
 */
export function flattenJaDailyTipDrills(drills: readonly Pick<JaDailyTipDrill, "items">[]): { lines: { ja: string; ko: string }[]; offsets: number[] } {
  const lines: { ja: string; ko: string }[] = [];
  const offsets: number[] = [];
  for (const d of drills) {
    offsets.push(lines.length);
    for (const it of d.items) lines.push({ ja: it.ja, ko: it.ko });
  }
  return { lines, offsets };
}

// ---------------------------------------------------------------------------
// 회화 연습 번호 묶음(例 · 1番 · 2番 · 3番)
// ---------------------------------------------------------------------------

export interface JaDailyLineGroup {
  /** 화면 머리 — "例" · "1番" · "2番" · "3番" */
  label: string;
  /** 0부터, end는 포함하지 않음 */
  start: number;
  end: number;
}

/**
 * 교재 회화 연습(renshu)은 원음이 「例 → 1番 → 2番 → 3番」 네 묶음으로 읽힌다(대본에 표시가 남은 트랙은 모두 그렇고 묶음 크기가 같다).
 * 반입 파일에는 번호가 없으므로 **문장 수가 4로 나뉘고(8 이상) 화자가 둘 이상이며 화자 순서가 네 묶음 모두 같을 때만** 4등분한다 — 아니면 null(한 덩어리 그대로).
 */
export function jaDailyLineGroups(part: JaDailyTrackPart, lines: readonly Pick<JaDailyLine, "speaker">[]): JaDailyLineGroup[] | null {
  if (part !== "renshu1" && part !== "renshu2") return null;
  const n = lines.length;
  if (n < 8 || n % 4 !== 0) return null;
  const size = n / 4;
  // 화자가 둘 이상(null 제외)일 때만 — 화자 정보가 없으면 반복 순서를 근거로 삼을 수 없다
  if (new Set(lines.map((l) => l.speaker).filter((x): x is string => !!x)).size < 2) return null;
  for (let i = size; i < n; i++) if ((lines[i].speaker ?? "") !== (lines[i % size].speaker ?? "")) return null;
  return ["例", "1番", "2番", "3番"].map((label, g) => ({ label, start: g * size, end: (g + 1) * size }));
}

// ---------------------------------------------------------------------------
// 밑줄 [[ ]]
// ---------------------------------------------------------------------------

export function splitJaDailyUnderline(s: string): { text: string; underline: boolean }[] {
  const out: { text: string; underline: boolean }[] = [];
  const re = /\[\[([^[\]]+)\]\]/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), underline: false });
    out.push({ text: m[1], underline: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), underline: false });
  return out;
}

/** 밑줄 표시를 뗀 글(합성 음성·접근성용) */
export function stripJaDailyUnderline(s: string): string {
  return s.replace(/\[\[([^[\]]+)\]\]/g, "$1");
}

// ---------------------------------------------------------------------------
// 칸 이름
// ---------------------------------------------------------------------------

export const JA_DAILY_PART_KO: Record<JaDailyTrackPart, string> = {
  sound: "소리",
  kaiwa1: "회화 1",
  kaiwa2: "회화 2",
  renshu1: "회화 연습 1",
  renshu2: "회화 연습 2",
};

export const JA_DAILY_SECTION_KO: Record<JaDailyMockSectionName, string> = {
  moji: "문자·어휘",
  bunpou: "문법",
  dokkai: "독해",
  listening: "청해",
};

export function jaDailyExamLabel(e: JaDailyExamSlot): string {
  switch (e.type) {
    case "tip":
      return "청해 요령";
    case "litems":
      return "청해 훈련";
    case "mockItems":
      return `모의 ${e.round}회 문항`;
    case "mockSection":
      return `모의 ${e.round}회 실전 · ${e.sections.map((s) => JA_DAILY_SECTION_KO[s]).join("·")}`;
    case "mockScore":
      return `모의 ${e.round}회 채점표`;
    case "mockReview":
      return `모의 ${e.round}회 오답 다시`;
    case "weakItems":
      return "약한 문항";
    case "final":
      return "총정리";
  }
}

export function jaDailyVocabLabel(v: JaDailyVocabSlot): string {
  if (v.type === "cards") return `단어 DAY ${v.day} (${v.from}~${v.to})`;
  if (v.type === "dayTest") return `DAY ${v.day} 단어 시험`;
  return "약한 단어";
}

export function jaDailyKaiwaLabel(k: JaDailyKaiwaSlot, lessons: JaDailyContentIndex["lessons"]): string {
  if (k.type === "review") return "약한 과 다시";
  const l = lessons.find((x) => x.id === k.lessonId);
  if (!l) return "회화";
  return `회화 ${l.step}-${l.lesson}과 ${l.titleKo}`;
}

/** 허브 카드·홈 한 줄 — "Day n · 회화 … · 단어 … · 시험 … · 약 30분" */
export function jaDailySessionSummary(s: JaDailySession, lessons: JaDailyContentIndex["lessons"]): string {
  return [`Day ${s.n}`, jaDailyKaiwaLabel(s.kaiwa, lessons), jaDailyVocabLabel(s.vocab), jaDailyExamLabel(s.exam), `약 ${s.minutesHint}분`].join(" · ");
}

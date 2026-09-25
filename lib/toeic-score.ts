/**
 * lib/toeic-score.ts — Q1–2 지문 대조·참고 점수, 추정 총점·등급 **순수 함수** (docs/harness/toeic.md §5-0·§5-4·§5-5)
 *
 * **AI 없음.** 전사문으로는 발음·억양을 알 수 없으니 Q1–2는 LLM에게 점수를 지어내게 하지 않고, 전사문 ↔ 지문을
 * 단어 단위 편집거리로 정렬해 빠짐·치환만 센다(§1-1·§5-4). 화면에는 반드시 "발음·억양은 채점하지 않았어요"를 함께 적는다.
 * 추정 총점은 ETS 환산표가 비공개라 "추정(참고용)"이다(§5-5).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈뿐(lib/toeic-text·lib/toeic-mock). lib/ai는 `import type`만.
 */

import { countWords } from "./toeic-text";
import { TOEIC_QUESTION_COUNT, toeicMaxScore } from "./toeic-mock";
import type { ToeicFeedback, ToeicReadDiff } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 화면 문구 — 한 곳에만
// ---------------------------------------------------------------------------

/** Q1–2 결과에 함께 적는 문구(§5-4) */
export const TOEIC_READ_NOTICE_KO = "발음·억양은 채점하지 않았어요 — 녹음을 다시 들어 보세요";
/** 추정 총점 라벨(§5-5) */
export const TOEIC_ESTIMATE_LABEL_KO = "추정(참고용)";
/** 무응답 문구(§5-0 3) */
export const TOEIC_NO_RESPONSE_KO = "답변이 인식되지 않았어요";

// ---------------------------------------------------------------------------
// 무응답 (§5-0 3) — 전사문 단어가 2개 미만이면 호출 D 없이 0점
// ---------------------------------------------------------------------------

/** 무응답으로 보는 단어 수 기준(이 값 미만) */
export const TOEIC_MIN_TRANSCRIPT_WORDS = 2;

/** 전사문이 무응답인가(단어 2개 미만 — 호출 D를 부르지 않는다) */
export function isNoResponseTranscript(transcript: string | null): boolean {
  return transcript === null || countWords(transcript) < TOEIC_MIN_TRANSCRIPT_WORDS;
}

/**
 * Q3–11 무응답 결과 — 호출 D 없이 저장하는 0점 피드백. 모델 출력이 아니라 zod를 거치지 않는다
 * (strengths 1~3 규칙은 모델 출력에만 건다). improvedAnswer는 빈 문자열.
 */
export function noResponseFeedback(): ToeicFeedback {
  return { score: 0, summaryKo: TOEIC_NO_RESPONSE_KO, strengths: [], fixes: [], missingKo: [], improvedAnswer: "", tryExpressions: [] };
}

// ---------------------------------------------------------------------------
// Q1–2 지문 대조 (§5-4)
// ---------------------------------------------------------------------------

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES_MAP = new Map(ONES.map((w, i) => [w, i] as const));

/**
 * 대조용 단어 배열 — 소문자·문장부호 제거·숫자 표기 통일(0~100의 영어 단어 → 숫자, `%` → percent, `&` → and).
 * 하이픈·콜론 같은 문장부호는 띄어쓰기로 바꾸고(twenty-five → twenty five → 25), 아포스트로피는 지운다(don't → dont).
 * **글자 사이 마침표는 지운다**(p.m. → pm, U.S. → us — 공백으로 바꾸면 "p m" 두 토큰이 돼 "PM"과 어긋난다, QA P2-5).
 * 숫자에 붙여 쓴 am/pm은 띄운다(7pm → 7 pm). 그래서 "7 p.m."·"7 PM"·"7pm"이 모두 ["7","pm"]이다.
 * ⚠️ lookbehind 없음 — 이 모듈은 클라이언트 번들에 들어간다(구형 iOS Safari에서 lookbehind 정규식은 문법 오류로 던진다).
 */
export function normalizeReadWords(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/&/g, " and ")
    .replace(/['’‘`]/g, "")
    // 한 글자 단어 뒤 마침표 + 바로 이어지는 한 글자 단어(p.m.·a.m.·u.s.a.) → 마침표 삭제. 전방 탐색만 쓴다
    .replace(/\b([a-z])\.(?=[a-z]\b)/g, "$1")
    .replace(/(\d)(am|pm)\b/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (raw === "") return [];
  const words = raw.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // twenty five → 25, twenty → 20
    if (w in TENS) {
      const next = ONES_MAP.get(words[i + 1] ?? "");
      if (next !== undefined && next >= 1 && next <= 9) {
        out.push(String(TENS[w] + next));
        i += 1;
      } else {
        out.push(String(TENS[w]));
      }
      continue;
    }
    // one hundred / a hundred / hundred → 100 (0~100 범위만)
    if (w === "hundred") {
      const prev = out[out.length - 1];
      if (prev === "1" || prev === "a") out.pop();
      out.push("100");
      continue;
    }
    const one = ONES_MAP.get(w);
    if (one !== undefined) {
      // "one hundred"는 다음 차례에 100으로 접힌다
      out.push(String(one));
      continue;
    }
    // 숫자는 앞자리 0을 떼어 통일("05" → "5")
    out.push(/^\d+$/.test(w) ? String(Number.parseInt(w, 10)) : w);
  }
  return out;
}

/**
 * 지문(text)과 전사문(transcript)을 단어 단위 편집거리로 정렬한다(§5-4).
 * - missing: 지문에 있는데 전사문에 없는 단어(삭제)
 * - extra: 전사문에만 있는 단어(삽입)
 * - substituted: 지문 단어 자리에 다른 단어(치환)
 * - accuracy = 1 − (빠짐 + 치환) / 지문 단어 수 (0 미만은 0, 지문이 비면 0)
 * 같은 비용의 경로가 여럿이면 일치·치환 → 삭제 → 삽입 순으로 고른다(결정적).
 */
export function alignReadAloud(text: string, transcript: string): ToeicReadDiff {
  const a = normalizeReadWords(text);
  const b = normalizeReadWords(transcript);
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      d[i][j] = Math.min(sub, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const missing: string[] = [];
  const extra: string[] = [];
  const substituted: { expected: string; heard: string }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      substituted.push({ expected: a[i - 1], heard: b[j - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      missing.push(a[i - 1]);
      i -= 1;
    } else {
      extra.push(b[j - 1]);
      j -= 1;
    }
  }
  missing.reverse();
  extra.reverse();
  substituted.reverse();
  const accuracy = n === 0 ? 0 : Math.max(0, 1 - (missing.length + substituted.length) / n);
  return { accuracy, missing, extra, substituted };
}

/** Q1–2 참고 점수(§5-4): ≥0.95 → 3, ≥0.85 → 2, ≥0.6 → 1, 그 밖 0 */
export function readProxyScore(accuracy: number): 0 | 1 | 2 | 3 {
  if (accuracy >= 0.95) return 3;
  if (accuracy >= 0.85) return 2;
  if (accuracy >= 0.6) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 추정 총점 (§5-5)
// ---------------------------------------------------------------------------

/** 만점 합(Q1–10 × 3 + Q11 × 5 = 35) */
export const TOEIC_RAW_MAX = 35;
/** 환산 만점 */
export const TOEIC_SCALED_MAX = 200;

export type ToeicActflBand = "AH" | "AM" | "AL" | "IH" | "IM" | "IL" | "NH" | "NM/NL";

/** ACTFL 구간(§5-5) — 환산 점수 하한 내림차순 */
export const TOEIC_ACTFL_BANDS: readonly { band: ToeicActflBand; min: number; max: number }[] = [
  { band: "AH", min: 200, max: 200 },
  { band: "AM", min: 180, max: 190 },
  { band: "AL", min: 160, max: 170 },
  { band: "IH", min: 140, max: 150 },
  { band: "IM", min: 110, max: 130 },
  { band: "IL", min: 90, max: 100 },
  { band: "NH", min: 60, max: 80 },
  { band: "NM/NL", min: 0, max: 50 },
];

/** 10점 단위 반올림 */
export function round10(x: number): number {
  return Math.round(x / 10) * 10;
}

/** 환산 점수 → ACTFL 구간 */
export function toeicBandForScaled(scaled: number): ToeicActflBand {
  for (const b of TOEIC_ACTFL_BANDS) if (scaled >= b.min) return b.band;
  return "NM/NL";
}

export type ToeicTotalEstimate =
  | { complete: true; raw: number; scaled: number; band: ToeicActflBand; labelKo: string }
  | { complete: false; scoredCount: number; messageKo: string };

/**
 * 추정 총점(§5-5). **11문항 모두** 점수가 있을 때만 계산한다(하나라도 없으면 "n문항 채점됨").
 * raw = Σ Q1–10(0~3) + Q11(0~5) → scaled = round10(raw / 35 × 200) → ACTFL 구간.
 * 범위를 벗어난 점수(정수 아님·음수·만점 초과)와 문항 번호(정수 아님·1..11 밖)는 채점되지 않은 것으로 본다(던지지 않는다).
 */
export function estimateToeicTotal(answers: readonly { q: number; score: number | null }[]): ToeicTotalEstimate {
  const byQ = new Map<number, number>();
  for (const a of answers) {
    // q는 1..11 **정수**만(1.5 같은 값으로 toeicMaxScore가 던지면 결과 화면 전체가 깨진다 — QA P2-9)
    if (!Number.isInteger(a.q) || a.q < 1 || a.q > TOEIC_QUESTION_COUNT || a.score === null) continue;
    if (!Number.isInteger(a.score) || a.score < 0 || a.score > toeicMaxScore(a.q)) continue;
    byQ.set(a.q, a.score);
  }
  if (byQ.size < TOEIC_QUESTION_COUNT) {
    return { complete: false, scoredCount: byQ.size, messageKo: `${byQ.size}문항 채점됨` };
  }
  const raw = [...byQ.values()].reduce((s, v) => s + v, 0);
  const scaled = round10((raw / TOEIC_RAW_MAX) * TOEIC_SCALED_MAX);
  return { complete: true, raw, scaled, band: toeicBandForScaled(scaled), labelKo: TOEIC_ESTIMATE_LABEL_KO };
}

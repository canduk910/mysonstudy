/**
 * lib/ja-daily-judge.ts — 🗓️ 오늘의 일본어 🎤 핵심 문장 **판정**의 단일 정의처(설계 §4 회화). AI 없음.
 *
 * 2단계(화면)에서 `lib/ja-daily-contract.ts`에서 떼어 냈다 — 계약 파일은 zod·`ja-daily-content`(→ lib/ai/japanese/schemas)를 값으로
 * 끌어서, 화면이 판정 하나 때문에 그 사슬을 폰 번들로 받지 않게 한다. 계약 파일은 여기 것을 그대로 재수출한다(eval·라우트 import 불변).
 *
 * 글자 대조는 말하기 모의고사의 `alignJaReadAloud`를 그대로 쓴다(새 대조 없음). 런타임 import는 `./ja-speaking-score`·`./ja-romaji`(둘 다 import 0).
 * 받아쓰기가 로마자로 오면(짧은 단어만 말할 때 전사 모델이 그런다 — 2026-11-18 실기기) 대조 전에 가나로 바꾼다.
 */
import { jaRomajiToHiragana, hasLatinLetters } from "./ja-romaji";
import { alignJaReadAloud, type JaReadDiff, type JaReadToken } from "./ja-speaking-score";

export const JA_DAILY_VERDICTS = ["pass", "close", "retry", "skipped"] as const;
export type JaDailyVerdict = (typeof JA_DAILY_VERDICTS)[number];
export const JA_DAILY_VERDICT_KO: Record<JaDailyVerdict, string> = { pass: "맞음", close: "아깝다", retry: "다시", skipped: "넘어감" };

/** 맞음 문턱(글자 일치율) */
export const JA_DAILY_PASS_ACCURACY = 0.8;
/** 아깝다 문턱 */
export const JA_DAILY_CLOSE_ACCURACY = 0.5;

export function jaDailyVerdictOf(accuracy: number): Exclude<JaDailyVerdict, "skipped"> {
  if (!Number.isFinite(accuracy)) return "retry";
  if (accuracy >= JA_DAILY_PASS_ACCURACY) return "pass";
  if (accuracy >= JA_DAILY_CLOSE_ACCURACY) return "close";
  return "retry";
}

/** 문장 토큰 × 받아쓰기 → 정확도·판정·틀린 글자. 받아쓰기가 비었거나 토큰이 없으면 0 · 다시 */
export function judgeJaDailyLine(tokens: readonly JaReadToken[], transcript: string): { accuracy: number; verdict: Exclude<JaDailyVerdict, "skipped">; diff: JaReadDiff | null } {
  if (tokens.length === 0 || transcript.trim() === "") return { accuracy: 0, verdict: "retry", diff: null };
  if (hasLatinLetters(transcript)) transcript = jaRomajiToHiragana(transcript);
  const diff = alignJaReadAloud(tokens, transcript);
  const accuracy = Math.max(0, Math.min(1, diff.accuracy));
  return { accuracy, verdict: jaDailyVerdictOf(accuracy), diff };
}

/**
 * lib/toeic-attempt-rules.ts — 모의고사 **응시 기록**(§7-5) 판정 순수 함수 (docs/harness/toeic.md §5-0·§6-4·§7-5)
 *
 * 스토어 두 백엔드(파일 mutate · Firestore runTransaction)·라우트(attempts·finish·score)·화면(응시·결과)이 **같은 함수**를 본다.
 * 판정이 여러 벌이면 "라우트는 받았는데 스토어가 거부"·"화면은 채점 버튼을 보이는데 라우트가 409" 같은 어긋남이 난다.
 *
 * ── "닫힌 응시"(스펙 공백 — 여기서 정한다) ─────────────────────────────────────
 * 레코드에는 상태 필드가 없다(§7-5 — finishedAt null = 중간에 그만둠). 그래서 "아직 응시 중"과 "그만두고 닫음"이 finishedAt만으로는
 * 갈리지 않는다. 규칙: **응시 시작 때 answers는 빈 배열**이고, 끝/그만두기(finish)가 **응시 범위의 모든 문항**을 answers에 채운다
 * (녹음 안 된 문항은 recorded:false). 그래서 닫힘 = `finishedAt !== null || answers.length > 0`.
 * 채점(score)은 닫힌 응시의 녹음된 문항에만 쓰므로 answers를 늘리는 다른 경로가 없다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-mock)뿐, lib/ai는 `import type`만.
 */

import type { ToeicAttemptScope } from "./ai/toeic/schemas";
import { TOEIC_MOCK_PARTS, toeicQuestionFormat, toeicQuestionsForParts, type ToeicMockPart } from "./toeic-mock";

/** 응시 범위의 파트를 형식표 순서로(중복 제거). 모르는 값은 버린다. */
export function orderToeicParts(parts: readonly string[]): ToeicMockPart[] {
  const set = new Set(parts);
  return TOEIC_MOCK_PARTS.filter((p) => set.has(p));
}

/** 응시 범위의 문항 번호들(형식표 순서) — 실전 11개, 유형 연습은 그 파트 문항만. */
export function toeicAttemptQuestions(parts: readonly ToeicMockPart[]): number[] {
  return toeicQuestionsForParts(orderToeicParts(parts));
}

/**
 * 응시 범위 판정 — 시작 라우트가 쓴다. 실전(full)은 다섯 파트 전부 + 모의고사가 완전해야 하고, 유형 연습(part)은 파트 하나 +
 * 그 파트가 있어야 한다. 반환 parts는 형식표 순서.
 */
export function decideAttemptScope(
  scope: ToeicAttemptScope,
  parts: readonly ToeicMockPart[],
  mockParts: Record<ToeicMockPart, unknown | null>,
): { ok: true; parts: ToeicMockPart[] } | { ok: false; reason: "scope_parts_mismatch" | "incomplete_mock" | "part_missing" } {
  const ordered = orderToeicParts(parts);
  if (ordered.length !== parts.length) return { ok: false, reason: "scope_parts_mismatch" }; // 중복·모르는 파트
  if (scope === "full") {
    if (ordered.length !== TOEIC_MOCK_PARTS.length) return { ok: false, reason: "scope_parts_mismatch" };
    if (TOEIC_MOCK_PARTS.some((p) => mockParts[p] === null || mockParts[p] === undefined)) return { ok: false, reason: "incomplete_mock" };
    return { ok: true, parts: ordered };
  }
  if (ordered.length !== 1) return { ok: false, reason: "scope_parts_mismatch" };
  if (mockParts[ordered[0]] === null || mockParts[ordered[0]] === undefined) return { ok: false, reason: "part_missing" };
  return { ok: true, parts: ordered };
}

/** 닫힌 응시인가(끝났거나 그만둠 — 위 머리 주석의 규칙) */
export function isToeicAttemptClosed(a: { finishedAt: string | null; answers: readonly unknown[] }): boolean {
  return a.finishedAt !== null || a.answers.length > 0;
}

/**
 * 끝/그만두기 판정 — **한 번만** 받는다(두 번째부터는 already_closed). 다시 보내기(네트워크 재시도)나 다른 탭의 늦은 요청이
 * 이미 채점된 문항의 recorded를 뒤집거나 "끝까지"를 "중단"으로 바꾸지 못하게 한다. 화면은 already_closed를 성공으로 본다
 * (첫 요청이 이미 저장됐다는 뜻이다). 판정은 스토어의 원자 단위 **안에서** 부른다.
 */
export function decideAttemptFinish(a: { finishedAt: string | null; answers: readonly unknown[] }): "finish" | "already_closed" {
  return isToeicAttemptClosed(a) ? "already_closed" : "finish";
}

/** 녹음 길이 여유 — 답변 시간 + 녹음 시작·멈춤 지연(권한 창·인코더 flush). 이보다 긴 durationMs는 입력 오류로 본다. */
export const TOEIC_RECORDING_SLACK_MS = 15_000;

/** 그 문항 녹음 길이의 상한(ms) */
export function maxToeicRecordingMs(q: number): number {
  return toeicQuestionFormat(q).answerSec * 1000 + TOEIC_RECORDING_SLACK_MS;
}

export interface ToeicFinishAnswerInput {
  q: number;
  recorded: boolean;
  durationMs: number | null;
}

/**
 * finish 입력 → 저장할 문항 목록. 응시 범위의 **모든 문항**을 채운다(보내지 않은 문항 = recorded:false·durationMs null) —
 * 그래야 "닫힘" 판정(answers.length > 0)이 서고, 결과 화면이 "녹음 안 됨"을 문항마다 보인다. 범위 밖 문항은 버린다
 * (라우트 zod가 먼저 거부한다). q 오름차순.
 */
export function completeFinishAnswers(qs: readonly number[], given: readonly ToeicFinishAnswerInput[]): ToeicFinishAnswerInput[] {
  const byQ = new Map(given.map((a) => [a.q, a] as const));
  return [...new Set(qs)]
    .sort((a, b) => a - b)
    .map((q) => {
      const a = byQ.get(q);
      return a ? { q, recorded: a.recorded === true, durationMs: a.durationMs } : { q, recorded: false, durationMs: null };
    });
}

/** AI 채점 대상인가 — 녹음됐고 아직 점수가 없다(§5-0). 녹음이 이 기기에 있는지는 화면이 따로 본다. */
export function isScorableToeicAnswer(a: { recorded: boolean; score: number | null }): boolean {
  return a.recorded === true && a.score === null;
}

/** 녹음된 문항 수 */
export function recordedToeicCount(answers: readonly { recorded: boolean }[]): number {
  return answers.filter((a) => a.recorded === true).length;
}

/** 점수가 있는 문항 수 */
export function scoredToeicCount(answers: readonly { score: number | null }[]): number {
  return answers.filter((a) => a.score !== null).length;
}

/**
 * lib/toeic-streak.ts — 아빠 · 🎙️ 영어 트랙(토익스피킹)의 스트릭 입력을 만드는 **순수 함수** (docs/harness/toeic.md §0-2, SPEC §17-7)
 *
 * 영어 트랙이 세는 것은 두 가지다 — ① 표현 시험 세션(`toeicQuizzes`) 중 **답한 문항이 1개 이상**, ② 모의고사 응시
 * (`toeicAttempts`) 중 **끝까지 녹음된 문항이 1개 이상**. 둘을 같은 연속 판정 코어(computeStreak)에 넣기 위해 응시를
 * StreakSession 모양으로 옮긴다(녹음된 문항 = answered:true, 녹음 안 된 문항 = null — "답한 문항 0 세션 제외" 규칙이 그대로
 * "녹음 0 응시 제외"가 된다).
 *
 * **트랙 분리**: 이 함수는 토익 기록만 받는다. 은우(영어 단어 시험)·아빠 일본어(단어·한자 시험)·아빠 운동과 한 집합에 섞지
 * 않는다 — 섞으면 한쪽만 한 날도 이어져 보인다(§0-2 스트릭 결정, eval:streak "트랙 분리" 반례가 잠근다).
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import 0(타입만).
 */

import type { StreakSession } from "./streak";

/** 표현 시험 세션 최소 모양(ToeicQuizRecord가 만족) */
export interface ToeicQuizStreakLike {
  startedAt: string;
  items: readonly { answered: boolean | null }[];
}

/** 모의고사 응시 최소 모양(ToeicAttemptRecord가 만족) */
export interface ToeicAttemptStreakLike {
  startedAt: string;
  answers: readonly { recorded: boolean }[];
  /**
   * 문항 단위 다시 풀기 기록(2026-10-03, docs/harness/toeic.md §15-9) — 닫혔고 합친 문항이 1개 이상이면 **그 시작 시각의 세션**으로 센다
   * (처음 응시가 어제고 오늘 다시 풀었으면 오늘도 공부한 날). 없으면(옛 문서·픽스처) 다시 푼 적 없음.
   */
  retakes?: readonly { startedAt: string; closedAt: string | null; merged: readonly number[] }[];
}

/** 표현 시험 + 모의고사 응시 → 영어 트랙 스트릭 세션(computeStreak 입력). */
export function toeicStreakSessions(
  quizzes: readonly ToeicQuizStreakLike[],
  attempts: readonly ToeicAttemptStreakLike[],
): StreakSession[] {
  return [
    ...quizzes.map((q) => ({ startedAt: q.startedAt, items: q.items.map((it) => ({ answered: it.answered })) })),
    ...attempts.map((a) => ({
      startedAt: a.startedAt,
      items: a.answers.map((x) => ({ answered: x.recorded === true ? true : null })),
    })),
    // 다시 풀기(§15-9) — 합친 문항 = answered. 진행 중·합친 문항 0은 "답한 문항 0 세션 제외" 규칙대로 빠진다
    ...attempts.flatMap((a) =>
      (a.retakes ?? [])
        .filter((r) => r.closedAt !== null)
        .map((r) => ({ startedAt: r.startedAt, items: r.merged.map(() => ({ answered: true as boolean | null })) })),
    ),
  ];
}

/** 녹음된 문항이 1개 이상인 응시인가(영어 트랙에 세는 응시) */
export function isCountedToeicAttempt(a: ToeicAttemptStreakLike): boolean {
  return a.answers.some((x) => x.recorded === true);
}

/** 헤드라인 라벨을 만들 때 쓰는 세트 최소 모양(ToeicSetRecord가 만족) — guide는 모양을 믿지 않는다 */
export interface ToeicQuizLabelSetLike {
  titleKo: string;
  guide: unknown;
}

/** 라벨 이름표 — 호출측(라우트·eval)이 lib/toeic-quiz·lib/toeic-mock-contract의 단일 정의처에서 넘긴다(이 모듈은 런타임 import 0) */
export interface ToeicQuizLabelNames {
  /** 틀 모드 이름("예문 말하기"·"틀 바꿔 말하기") — 틀 모드가 아니면 null */
  templateModeKo: (mode: string) => string | null;
  /** 공략 유형 이름(긴 이름 — "Q3–4 사진 묘사") — 네 유형 밖이면 null */
  guidePartKo: (part: string) => string | null;
}

/**
 * 오늘 라벨 — 영어 트랙의 표현 시험 세션 하나(가장 늦게 시작한 것)와 그 세트 → 헤드라인 라벨(docs/harness/toeic.md §12-9, SPEC §17-8).
 * - 틀 모드 세션(틀 은행의 템플릿 테스트) → `템플릿 훈련 · {모드 이름}` — 틀은 여러 유형에 걸치므로 유형 이름을 붙이지 않는다.
 * - 유형 공략 세트(guide.kind "part" — kind가 없으면 "part"로 읽는다)의 시험 → `공략 표현 · {유형 이름}`.
 * - 그 밖(표현집) → `표현집 · {세트 이름}`(세트를 못 읽으면 "표현집") — 기존 라벨 그대로.
 * 계산식은 바꾸지 않는다(라벨만 가른다 — 무엇을 세는지는 toeicStreakSessions 그대로).
 */
export function toeicQuizStreakLabel(quiz: { mode: string }, set: ToeicQuizLabelSetLike | null, names: ToeicQuizLabelNames): string {
  const tplMode = names.templateModeKo(quiz.mode);
  if (tplMode !== null) return `템플릿 훈련 · ${tplMode}`;
  const g = set?.guide;
  if (g !== null && typeof g === "object") {
    const kind = (g as { kind?: unknown }).kind;
    const part = (g as { part?: unknown }).part;
    if ((kind === undefined || kind === "part") && typeof part === "string") {
      const name = names.guidePartKo(part);
      if (name !== null) return `공략 표현 · ${name}`;
    }
  }
  return set ? `표현집 · ${set.titleKo}` : "표현집";
}

/** 응시 라벨을 만들 때 쓰는 모의고사 최소 모양(ToeicMockRecord가 만족) — drillPart는 모양을 믿지 않는다 */
export interface ToeicAttemptLabelMockLike {
  titleKo: string;
  drillPart: unknown;
}

/**
 * 오늘 라벨 — 영어 트랙의 응시 하나(가장 늦게 시작한 것)와 그 모의고사 → 헤드라인 라벨(docs/harness/toeic.md §12-9, SPEC §17-8).
 * - 한 문제 연습(drillPart가 다섯 파트 중 하나) → `공략 연습 · {유형 이름}`(유형 이름 = 긴 이름 "Q3–4 사진 묘사" — 호출측이 단일 정의처
 *   lib/toeic-mock-contract toeicMockPartLabelKo로 넘긴다. 이 모듈은 런타임 import 0).
 * - 그 밖 → `모의고사 · {제목}`(문서를 못 읽으면 "모의고사") — 기존 라벨 그대로. 계산식은 바꾸지 않는다(라벨만 가른다).
 */
export function toeicAttemptStreakLabel(mock: ToeicAttemptLabelMockLike | null, drillPartKo: (part: string) => string | null): string {
  if (mock && typeof mock.drillPart === "string") {
    const name = drillPartKo(mock.drillPart);
    if (name !== null) return `공략 연습 · ${name}`;
  }
  return mock ? `모의고사 · ${mock.titleKo}` : "모의고사";
}

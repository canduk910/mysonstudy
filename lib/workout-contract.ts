/**
 * lib/workout-contract.ts — 아빠의 운동 `/api/workout/*` 요청·응답 계약(타입 전용, SPEC §19-5). 라우트(서버)와 화면(클라)이 공유한다.
 *
 * 엔진 타입은 순수 모듈 lib/workout.ts에서 `export type`으로 재수출만 한다(단일 정의처 — §19-4).
 * 클라이언트 번들에 store가 새지 않는다. 409 계열이면 화면은 messageKo를 보이고 `router.refresh()`한다.
 */

import type {
  ClosedCycleStatus,
  CyclePlanRow,
  CycleSnapshot,
  DayKind,
  DurationSource,
  DurationTotal,
  EventDuration,
  FailedAt,
  PlanRow,
  RecordedOutcome,
  RepTotals,
  SetPair,
  TodayStatus,
  Upcoming,
  UpcomingEntry,
  WorkoutCycleRecord,
  WorkoutCycleStatus,
  WorkoutEvent,
  WorkoutEventKind,
  WorkoutExercise,
  WorkoutHistoryRow,
  WorkoutLogRow,
  WorkoutRm,
  WorkoutStep,
} from "./workout";

export type {
  ClosedCycleStatus,
  CyclePlanRow,
  CycleSnapshot,
  DayKind,
  DurationSource,
  DurationTotal,
  EventDuration,
  FailedAt,
  PlanRow,
  RecordedOutcome,
  RepTotals,
  SetPair,
  TodayStatus,
  Upcoming,
  UpcomingEntry,
  WorkoutCycleRecord,
  WorkoutCycleStatus,
  WorkoutEvent,
  WorkoutEventKind,
  WorkoutExercise,
  WorkoutHistoryRow,
  WorkoutLogRow,
  WorkoutRm,
  WorkoutStep,
};

/**
 * 에러 enum과 상태 코드(§19-5):
 * `invalid_input`(400) · `not_found`(404, 사이클 없음) · `conflict`(409, rev·활성 id 불일치 — 다른 탭·연타로 이미 바뀜) ·
 * `stale_state`(409, 오늘 상태가 운동이 아니거나 day·targetDay가 다름) · `not_active`(409, 닫힌 사이클) ·
 * `empty`(409, 취소할 사건 없음) · `prod_guard`(403) · `save_failed`(500).
 */
export type WorkoutApiError =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "stale_state"
  | "not_active"
  | "empty"
  | "prod_guard"
  | "save_failed";

/** zod safeParse issues 매핑 */
export interface WorkoutIssue {
  path: string;
  message: string;
}

/** 실패 응답 공통 형태 — 라우트마다 가능한 error만 좁힌다 */
export interface WorkoutErrorBody<E extends WorkoutApiError> {
  ok: false;
  error: E;
  messageKo: string;
  issues?: WorkoutIssue[];
}

// ===========================================================================
// 사이클 시작·재측정 — `POST /api/workout/cycle`
// ===========================================================================

/**
 * 처음 시작·재측정(Day 27)·도중 재측정 공용. RM은 정수 1~150.
 * `expectedActiveCycleId` — 화면이 본 활성 사이클 id(없으면 null). 서버 활성과 다르면 409 conflict(연타·두 탭 방지).
 */
export interface WorkoutCycleRequest {
  pullupRm: number;
  pushupRm: number;
  start: "today" | "tomorrow";
  expectedActiveCycleId: string | null;
}

export type WorkoutCycleResponse =
  | {
      ok: true;
      cycleId: string;
      cycleNo: number;
      /** created = 새 사이클, replaced = 사건 0개 활성의 제자리 교체 */
      mode: "created" | "replaced";
      /** 닫은 활성 사이클 — 없으면 null */
      closed: { id: string; status: ClosedCycleStatus } | null;
    }
  | WorkoutErrorBody<"invalid_input" | "conflict" | "prod_guard" | "save_failed">;

// ===========================================================================
// 기록 — `POST /api/workout/log`
// ===========================================================================

/**
 * `kind`로 판별 — complete는 `failed: null`, fail은 실패 지점 필수(reps는 선택: 정수 0..500 | null).
 * day·targetDay는 화면이 본 오늘 상태 값(1~23 운동일) — 서버는 "화면이 낡지 않았다" 확인에만 쓰고 사건은 자기 계산값으로 만든다.
 * `durationSec`(§19-8, 두 갈래 모두 필수 nullable) — 세션이 잰 실측 소요시간(초, 정수 0 이상). 세션 없이 기록하면 null.
 * 형식(정수·0 이상) 밖은 400, 상한(WORKOUT_DURATION_MAX_SEC = 3시간) 초과는 **기록은 받고 소요시간만 null**로 저장한다.
 */
export type WorkoutLogRequest =
  | { cycleId: string; expectedRev: number; kind: "complete"; day: number; targetDay: number; failed: null; durationSec: number | null }
  | { cycleId: string; expectedRev: number; kind: "fail"; day: number; targetDay: number; failed: FailedAt; durationSec: number | null };

export type WorkoutLogResponse =
  | {
      ok: true;
      cycleId: string;
      /** 기록 뒤 rev(다음 요청의 expectedRev) */
      rev: number;
      /** 서버가 만든 사건(date·at·reps 서버 계산) */
      event: WorkoutEvent;
    }
  | WorkoutErrorBody<"invalid_input" | "not_found" | "conflict" | "stale_state" | "not_active" | "save_failed">;

// ===========================================================================
// 마지막 기록 취소 — `POST /api/workout/undo` (Firestore에서 prod-guard 대상)
// ===========================================================================

export interface WorkoutUndoRequest {
  cycleId: string;
  expectedRev: number;
}

export type WorkoutUndoResponse =
  | {
      ok: true;
      cycleId: string;
      /** 취소 뒤 rev */
      rev: number;
    }
  | WorkoutErrorBody<"invalid_input" | "not_found" | "conflict" | "not_active" | "empty" | "prod_guard" | "save_failed">;

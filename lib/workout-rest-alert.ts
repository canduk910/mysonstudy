/**
 * lib/workout-rest-alert.ts — 휴식 알림(다른 앱 쓸 때, SPEC §19-9)의 순수 판정 — 정의처 하나.
 *
 * 흐름: 휴식 중 세션 화면이 숨겨지는 순간 클라이언트가 예약(`POST /api/push/workout-rest` op "schedule")하고, 다시 보이면 취소한다.
 * 서버는 사람별 문서 하나(`workoutRestAlerts/{person}` — 지금은 appa)에 `{ token, rev, endsAt, label, setNo, cancelled }`를 두고
 * 예약·취소마다 rev를 올린다(원자 단위 안에서 `decideRestSchedule`·`decideRestCancel`). Cloud Tasks가 정해진 시각에
 * `POST /api/push/workout-rest/fire`를 부르면 `decideRestFire`가 문서의 rev·token이 태스크의 것과 같고 취소되지 않았을 때만
 * 보내게 한다 — 오래된 태스크는 지우지 않아도 무해하다.
 *
 * ⚠️ 순수 모듈: 런타임 import는 `./workout-voice`(→ `./workout`)뿐 — 클라이언트(세션 화면)·서버(라우트)·eval이 그대로 import한다.
 *    store·firebase-admin·web-push 값 import 금지. 모듈 최상위에서 브라우저 전역·Date.now()를 읽지 않는다(시각은 인자로).
 */

import { exerciseKo } from "./workout-voice";
import type { WorkoutStep } from "./workout";

/** 운동 세션은 기기 하나 — 알림 받는 사람은 아빠 고정(문서 id) */
export const WORKOUT_REST_ALERT_PERSON = "appa" as const;
/** 남은 30초 알림 */
export const REST_ALERT_PRE_MS = 30_000;
/** 남은 시간이 30초 + 이 여유 이하로 숨겨지면 30초 알림은 건너뛴다(곧 끝 알림이 온다 — 두 개가 붙어 오지 않게) */
export const REST_ALERT_PRE_SLACK_MS = 5_000;
/** 예약할 수 있는 가장 먼 휴식 끝 — 3분 휴식 + 여러 번 +30초도 넉넉히. 넘으면 400 */
export const REST_ALERT_MAX_AHEAD_MS = 15 * 60_000;
/** 라벨 길이 상한("3세트 · 풀업 7 → 푸시업 10"은 20자 안팎) */
export const REST_ALERT_LABEL_MAX = 60;
/** 태스크가 예정보다 이만큼 일찍 와도 보낸다(Cloud Tasks는 scheduleTime 전에 부르지 않지만 시계 차이 여유) */
export const REST_ALERT_EARLY_TOLERANCE_MS = 3_000;
/** 예정보다 이만큼 넘게 늦으면(큐 재시도·지연) 보내지 않는다 — 다 끝난 휴식을 알리지 않게 */
export const REST_ALERT_LATE_MAX_MS = 90_000;
/** 같은 tag라 30초 알림을 끝 알림이 덮는다(알림 센터에 하나만) */
export const REST_ALERT_TAG = "workout-rest";
/** 알림을 누르면 여는 곳 — 세션 오버레이는 /workout의 상태라 거기로(이어서 하기) */
export const REST_ALERT_URL = "/workout";
/** 30초 알림은 휴식 끝보다 이만큼 앞서서까지만 보낸다 — 재시도로 늦게 온 30초 알림이 "휴식 끝" 배너를 덮지 않게(QA 1 P3-B) */
export const REST_ALERT_PRE_END_GUARD_MS = 2_000;
/** 푸시 TTL(초) — 늦게 배달된 휴식 알림은 쓸모가 없다 */
export const REST_ALERT_TTL_SEC = 60;

export type RestAlertKind = "pre" | "end";

/** 서버 문서 — 컬렉션 `workoutRestAlerts`, 문서 id = 사람. 필수 nullable(Firestore가 undefined를 거부한다) */
export interface WorkoutRestAlertRecord {
  /** 예약마다 새로 만드는 무작위 값 — 태스크가 자기 예약인지 확인한다 */
  token: string;
  /** 예약·취소마다 1씩 오른다 */
  rev: number;
  /** 휴식 끝(ISO, 서버 시계). 취소된 문서는 마지막 값을 그대로 둔다 */
  endsAt: string | null;
  label: string;
  /** 다음 세트 번호(1..5) */
  setNo: number;
  cancelled: boolean;
  updatedAt: string;
  /**
   * 마지막으로 반영한 화면 요청의 순번(QA 1 P2-A) — 예약·취소가 거꾸로 도착하면(keepalive 숨김 요청이 보임 취소보다 늦게 등)
   * 이 값 이하인 요청을 버린다. 옛 문서는 0.
   */
  clientSeq: number;
}

/** 태스크 본문(Cloud Tasks → fire 라우트) */
export interface RestAlertTaskPayload {
  person: typeof WORKOUT_REST_ALERT_PERSON;
  token: string;
  rev: number;
  kind: RestAlertKind;
  /** 이 알림의 예정 시각(epoch ms) */
  at: number;
}

// ---------------------------------------------------------------------------
// 라벨·문구
// ---------------------------------------------------------------------------

/**
 * 다음 세트 라벨 — "3세트 · 풀업 7 → 푸시업 10". 쉬는 중이면 다음 스텝은 언제나 세트의 풀업이고(엔진 불변식) 같은 세트의 푸시업이
 * partner다. partner가 없으면(엔진 밖 상태) "3세트 · 풀업 7"만.
 */
export function restAlertLabel(next: Pick<WorkoutStep, "exercise" | "setIndex" | "reps">, partner: Pick<WorkoutStep, "exercise" | "reps"> | null): string {
  const head = `${next.setIndex + 1}세트 · ${exerciseKo(next.exercise)} ${next.reps}`;
  return (partner ? `${head} → ${exerciseKo(partner.exercise)} ${partner.reps}` : head).slice(0, REST_ALERT_LABEL_MAX);
}

/** 잠금화면 타이머(§19-9 B)의 "지금 재생 중" 글자 — 제목 "휴식 · 다음 3세트", 부제 "풀업 7 → 푸시업 10" */
export function restNowPlayingText(next: Pick<WorkoutStep, "exercise" | "setIndex" | "reps">, partner: Pick<WorkoutStep, "exercise" | "reps"> | null): { title: string; artist: string } {
  const a = `${exerciseKo(next.exercise)} ${next.reps}`;
  return { title: `휴식 · 다음 ${next.setIndex + 1}세트`, artist: partner ? `${a} → ${exerciseKo(partner.exercise)} ${partner.reps}` : a };
}

/** 알림 문구 — 30초 전: "휴식 30초 남음" / 끝: "휴식 끝 — 3세트 시작해요". 본문은 다음 세트 라벨 */
export function restAlertMessage(kind: RestAlertKind, doc: Pick<WorkoutRestAlertRecord, "label" | "setNo">): {
  title: string;
  body: string;
  url: string;
  tag: string;
  renotify: boolean;
} {
  if (kind === "pre") {
    return { title: "휴식 30초 남음", body: `다음 · ${doc.label}`, url: REST_ALERT_URL, tag: REST_ALERT_TAG, renotify: true };
  }
  return { title: `휴식 끝 — ${doc.setNo}세트 시작해요`, body: doc.label, url: REST_ALERT_URL, tag: REST_ALERT_TAG, renotify: true };
}

// ---------------------------------------------------------------------------
// 예약 계획
// ---------------------------------------------------------------------------

/**
 * 보낼 알림과 시각 — 이미 지난 시각은 없다. 휴식 끝이 지금 이전이면 빈 배열(아무것도 예약하지 않는다).
 * 30초 알림은 남은 시간이 30초 + 여유(5초)보다 길 때만.
 */
export function planRestAlerts(endsAtMs: number, nowMs: number): { kind: RestAlertKind; at: number }[] {
  if (!Number.isFinite(endsAtMs) || !Number.isFinite(nowMs) || endsAtMs <= nowMs) return [];
  const out: { kind: RestAlertKind; at: number }[] = [];
  if (endsAtMs - nowMs > REST_ALERT_PRE_MS + REST_ALERT_PRE_SLACK_MS) out.push({ kind: "pre", at: endsAtMs - REST_ALERT_PRE_MS });
  out.push({ kind: "end", at: endsAtMs });
  return out;
}

/**
 * 화면 쪽 판정(세션 화면의 visibilitychange·pagehide가 부른다) — 무엇을 보낼지.
 * - 꺼져 있으면(501) 아무것도.
 * - 보이게 됐다: 예약해 둔 게 있으면 취소.
 * - 숨겨졌다: 쉬는 중이고 아직 남았고 이 휴식 끝을 이미 예약하지 않았으면 예약(남은 ms). hidden과 pagehide가 둘 다 와도 한 번.
 */
export function restAlertVisibilityAction(s: {
  visible: boolean;
  enabled: boolean;
  restEndsAt: number | null;
  scheduledFor: number | null;
  now: number;
}): { kind: "schedule"; remainingMs: number; endsAt: number } | { kind: "cancel" } | { kind: "none" } {
  if (!s.enabled) return { kind: "none" };
  if (s.visible) return s.scheduledFor !== null ? { kind: "cancel" } : { kind: "none" };
  if (s.restEndsAt === null || s.scheduledFor === s.restEndsAt) return { kind: "none" };
  const remainingMs = s.restEndsAt - s.now;
  if (remainingMs <= 0 || remainingMs > REST_ALERT_MAX_AHEAD_MS) return { kind: "none" };
  return { kind: "schedule", remainingMs, endsAt: s.restEndsAt };
}

// ---------------------------------------------------------------------------
// 원자 단위 안의 판정(두 백엔드 공용)
// ---------------------------------------------------------------------------

/**
 * 화면 요청 순번(클라이언트) — 페이지 안에서 단조 증가하고, 새로고침 뒤에도 거꾸로 가지 않게 시각(ms) 기반:
 * max(지금, 직전 + 1). 서버는 저장된 순번 이하인 요청을 버린다.
 */
export function nextRestAlertSeq(last: number, nowMs: number): number {
  return Math.max(Math.floor(nowMs), last + 1);
}

/** 순번 허용 앞섬 — 서버 시각보다 이만큼 넘게 앞선 순번은 받지 않고(400), 이미 저장된 그런 순번은 무시한다(QA 2 P3-F — 시계가 미래였던 폰이 알림을 막지 않게) */
export const REST_ALERT_SEQ_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** 순번이 서버 시각 기준으로 받을 만한가(너무 앞서지 않았나) */
export function isRestAlertSeqPlausible(seq: number, nowMs: number): boolean {
  return seq <= nowMs + REST_ALERT_SEQ_MAX_AHEAD_MS;
}

/** 늦게 도착한 옛 요청인가 — 저장된 순번 이하. 단 저장된 순번 자체가 서버 시각보다 하루 넘게 앞서 있으면(오염) 무시하고 받는다 */
function isStaleRestSeq(cur: WorkoutRestAlertRecord | null, seq: number, nowIso: string): boolean {
  if (!cur || seq > cur.clientSeq) return false;
  const nowMs = Date.parse(nowIso);
  return !(Number.isFinite(nowMs) && !isRestAlertSeqPlausible(cur.clientSeq, nowMs));
}

/** 순번 형식 — 양의 안전한 정수 */
export function isRestAlertSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * 예약 — 새 token·rev+1·취소 해제·순번 기록. 순번이 저장된 값 이하면 null(늦게 도착한 옛 요청 — 쓰지 않는다).
 */
export function decideRestSchedule(
  cur: WorkoutRestAlertRecord | null,
  input: { endsAtMs: number; label: string; setNo: number; token: string; nowIso: string; seq: number },
): WorkoutRestAlertRecord | null {
  if (isStaleRestSeq(cur, input.seq, input.nowIso)) return null;
  return {
    token: input.token,
    rev: (cur?.rev ?? 0) + 1,
    endsAt: new Date(input.endsAtMs).toISOString(),
    label: input.label,
    setNo: input.setNo,
    cancelled: false,
    updatedAt: input.nowIso,
    clientSeq: input.seq,
  };
}

/**
 * 취소 — 순번이 저장된 값 이하면 null(옛 요청). 그 밖에는 **늘 순번을 기록한다**: 취소가 예약보다 먼저 도착해도 뒤에 온 옛 예약을
 * 막아야 하므로(QA 1 P2-A) 문서가 없으면 취소된 빈 문서를 만들고, 이미 취소된 문서면 순번만 올린다(rev 그대로). 살아 있는 예약이면
 * rev+1·cancelled.
 */
export function decideRestCancel(cur: WorkoutRestAlertRecord | null, nowIso: string, seq: number): WorkoutRestAlertRecord | null {
  if (isStaleRestSeq(cur, seq, nowIso)) return null;
  if (!cur) return { token: "", rev: 1, endsAt: null, label: "", setNo: 1, cancelled: true, updatedAt: nowIso, clientSeq: seq };
  if (cur.cancelled) return { ...cur, updatedAt: nowIso, clientSeq: seq };
  return { ...cur, rev: cur.rev + 1, cancelled: true, updatedAt: nowIso, clientSeq: seq };
}

export type RestFireDecision =
  | { send: true }
  | { send: false; reason: "no_doc" | "cancelled" | "stale" | "too_early" | "too_late" };

/**
 * 발송 판정 — 문서의 rev·token이 태스크와 같고 취소되지 않았고 예정 시각 근처일 때만. 30초 알림(pre)은 휴식 끝 2초 전까지만
 * (재시도로 늦게 와 이미 뜬 "휴식 끝"을 같은 tag로 덮지 않게 — QA 1 P3-B). 끝 알림은 +90초까지.
 */
export function decideRestFire(doc: WorkoutRestAlertRecord | null, task: Pick<RestAlertTaskPayload, "token" | "rev" | "at" | "kind">, nowMs: number): RestFireDecision {
  if (!doc) return { send: false, reason: "no_doc" };
  if (doc.rev !== task.rev || doc.token !== task.token) return { send: false, reason: "stale" };
  if (doc.cancelled) return { send: false, reason: "cancelled" };
  if (nowMs < task.at - REST_ALERT_EARLY_TOLERANCE_MS) return { send: false, reason: "too_early" };
  if (task.kind === "pre" && nowMs > task.at + REST_ALERT_PRE_MS - REST_ALERT_PRE_END_GUARD_MS) return { send: false, reason: "too_late" };
  if (nowMs > task.at + REST_ALERT_LATE_MAX_MS) return { send: false, reason: "too_late" };
  return { send: true };
}

// ---------------------------------------------------------------------------
// 입력 검증(라우트·eval 공용 — zod 없이, 클라이언트 번들에 zod를 끌어오지 않게)
// ---------------------------------------------------------------------------

export type RestAlertRequest =
  | { op: "schedule"; remainingMs: number; label: string; setNo: number; seq: number }
  | { op: "cancel"; seq: number };

/**
 * 요청 본문 검사. 시각은 **남은 ms**로 받는다(폰·서버 시계 차이와 무관 — 서버가 자기 시계로 끝 시각을 정한다).
 * remainingMs 1..15분(0 이하·넘침은 거부), label 1..60자(앞뒤 공백 제거), setNo 정수 1..5.
 */
export function parseRestAlertRequest(raw: unknown): { ok: true; value: RestAlertRequest } | { ok: false; messageKo: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, messageKo: "요청 형식이 올바르지 않아요." };
  const o = raw as Record<string, unknown>;
  if (o.op !== "cancel" && o.op !== "schedule") return { ok: false, messageKo: "요청 형식이 올바르지 않아요." };
  if (!isRestAlertSeq(o.seq)) return { ok: false, messageKo: "요청 순번이 올바르지 않아요." };
  const seq = o.seq;
  if (o.op === "cancel") return { ok: true, value: { op: "cancel", seq } };
  const { remainingMs, setNo } = o;
  if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > REST_ALERT_MAX_AHEAD_MS) {
    return { ok: false, messageKo: "휴식 시간이 올바르지 않아요." };
  }
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (label.length === 0 || label.length > REST_ALERT_LABEL_MAX) return { ok: false, messageKo: "다음 세트 정보가 올바르지 않아요." };
  if (typeof setNo !== "number" || !Number.isInteger(setNo) || setNo < 1 || setNo > 5) return { ok: false, messageKo: "세트 번호가 올바르지 않아요." };
  return { ok: true, value: { op: "schedule", remainingMs: Math.round(remainingMs), label, setNo, seq } };
}

/** 태스크 본문 검사(fire 라우트) */
export function parseRestAlertTask(raw: unknown): RestAlertTaskPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.person !== WORKOUT_REST_ALERT_PERSON) return null;
  if (typeof o.token !== "string" || o.token.length === 0 || o.token.length > 100) return null;
  if (typeof o.rev !== "number" || !Number.isInteger(o.rev) || o.rev < 1) return null;
  if (o.kind !== "pre" && o.kind !== "end") return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  return { person: WORKOUT_REST_ALERT_PERSON, token: o.token, rev: o.rev, kind: o.kind, at: o.at };
}

/** 저장 문서 정규화(두 백엔드 읽기 공용). 깨졌으면 null */
export function normalizeRestAlertRecord(v: unknown): WorkoutRestAlertRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.token !== "string" || typeof o.rev !== "number" || !Number.isInteger(o.rev)) return null;
  return {
    token: o.token,
    rev: o.rev,
    endsAt: typeof o.endsAt === "string" ? o.endsAt : null,
    label: typeof o.label === "string" ? o.label : "",
    setNo: typeof o.setNo === "number" && Number.isInteger(o.setNo) ? o.setNo : 1,
    cancelled: o.cancelled === true,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    clientSeq: typeof o.clientSeq === "number" && Number.isSafeInteger(o.clientSeq) && o.clientSeq > 0 ? o.clientSeq : 0,
  };
}

// ---------------------------------------------------------------------------
// Cloud Tasks 요청 모양(서버가 보낸다 — 모양만 여기서 정해 eval이 본다. 비밀 값은 인자로만)
// ---------------------------------------------------------------------------

/** 큐 전체 이름 형식 `projects/{p}/locations/{l}/queues/{q}` */
export const CLOUD_TASKS_QUEUE_PATTERN = /^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]{1,100}$/;

/** 기본 URL(https://호스트, 끝 슬래시 없음)로 정규화. 형식이 틀리면 null */
export function normalizeBaseUrl(v: string | undefined | null): string | null {
  const s = v?.trim().replace(/\/+$/, "");
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Cloud Tasks v2 `projects.locations.queues.tasks.create` 요청 본문. 본문은 base64(JSON). 헤더에 틱과 같은 `x-push-secret`.
 * `encodeBase64`는 호출부가 넘긴다(서버는 Buffer — 이 모듈이 node 전역에 기대지 않게).
 */
export function buildCloudTaskBody(
  args: { fireUrl: string; secret: string; payload: RestAlertTaskPayload },
  encodeBase64: (s: string) => string,
): { task: { scheduleTime: string; httpRequest: { httpMethod: "POST"; url: string; headers: Record<string, string>; body: string } } } {
  return {
    task: {
      scheduleTime: new Date(args.payload.at).toISOString(),
      httpRequest: {
        httpMethod: "POST",
        url: args.fireUrl,
        headers: { "content-type": "application/json", "x-push-secret": args.secret },
        body: encodeBase64(JSON.stringify(args.payload)),
      },
    },
  };
}

/**
 * lib/review-schedule.ts — 오늘의 복습(간격 반복) **순수 엔진** (docs/SPEC.md §23, 과목 공통). AI·저장·시계 없음.
 *
 * 원리(§23-0): 다시 읽지 말고 **가린 채 떠올린다**. 정답을 바로 보여 주지 않고 단서 → 🤔 떠올리기 → 힌트1(첫 글자) → 힌트2(뼈대) →
 * 정답 순으로 조금씩 연다(힌트 사다리). **어느 단계에서 떠올렸는지가 다음 복습 간격을 정한다** — 쥐어짜 낸 기억일수록 길게 미룬다.
 *
 * 이 모듈이 정하는 것(같은 규칙은 여기 한 곳 — 화면·라우트·저장소·eval이 같은 함수를 부른다):
 * - 간격 사다리 `REVIEW_INTERVAL_DAYS`(1 → 3 → 7 → 14 → 30일, 끝은 30일 유지)와 하루 상한 `REVIEW_DAILY_CAP`(영역당 20개)
 * - 결과 → 다음 상태(`nextReviewStep`·`decideReview`) — 같은 날 같은 항목 이중 적용은 `already_today`로 막는다
 * - 오늘 큐(`buildReviewQueue`) — 밀린 것 오래된 순, 처음 들어오는 항목(시험 기록은 있는데 일정이 없는 것)은 "오늘",
 *   틀린 기록이 있는 항목 먼저, 상한 = 20 − 오늘 이미 한 수, 같은 큐 안 중복 0
 * - 스트릭 입력(`reviewStreakSessions`)·오늘 라벨(`reviewTodayLabel`)·끝 요약(`summarizeReviewResults`)
 *
 * "오늘"(KST `YYYY-MM-DD`)과 "지금"(ISO)은 **인자로 받는다**(lib/kst 관례 — 라우트가 한 번만 읽는다, 테스트는 시계를 주입한다).
 * 날짜 계산은 lib/kst의 +9h·getUTC* 함수만 쓴다.
 *
 * 새 출처(영역·종류)를 더할 때: `REVIEW_KINDS`·`REVIEW_KIND_AREA`·`REVIEW_KIND_LABEL_KO`에 한 줄씩 + 서버 등록부
 * (lib/review-server.ts `REVIEW_SOURCES`)에 한 줄. 엔진 규칙은 종류를 모른다.
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import는 ./kst뿐.
 */

import { diffDateStrings, shiftDateString } from "./kst";

// ---------------------------------------------------------------------------
// 상수 — 한 곳에서만 정의한다(나중에 바꿀 수 있게)
// ---------------------------------------------------------------------------

/** 간격 사다리(일). 단계 index 0..4. 마지막 단계에서 더 나아가면 30일을 유지한다 */
export const REVIEW_INTERVAL_DAYS: readonly number[] = [1, 3, 7, 14, 30];
/** 마지막 단계 index */
export const REVIEW_MAX_STEP = REVIEW_INTERVAL_DAYS.length - 1;
/** 하루 상한 — 영역(은우 영어·일본어·토익)마다 하루에 끝낼 수 있는 복습 수 */
export const REVIEW_DAILY_CAP = 20;
/** 일정 문서 하나에 남기는 복습 이력 수(스트릭·디버그용) — 30일 간격이면 몇 년치다 */
export const REVIEW_HISTORY_MAX = 60;
/** 항목 키 길이 상한(종류 접두어 포함) */
export const REVIEW_ITEM_KEY_MAX = 300;

/** 영역 — 은우 영어 / 아빠 일본어 / 아빠 영어(토익) / 엄마의 생활영어(mom) */
export const REVIEW_AREAS = ["english", "japanese", "toeic", "mom"] as const;
export type ReviewArea = (typeof REVIEW_AREAS)[number];

/** 항목 종류 — 새 출처는 여기 한 줄 + REVIEW_KIND_AREA·REVIEW_KIND_LABEL_KO 한 줄 + 서버 등록부 한 줄 */
export const REVIEW_KINDS = ["en-word", "ja-word", "ja-kanji", "toeic-expr", "toeic-template", "toeic-island", "mom-sentence"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_KIND_AREA: Readonly<Record<ReviewKind, ReviewArea>> = {
  "en-word": "english",
  "ja-word": "japanese",
  "ja-kanji": "japanese",
  "toeic-expr": "toeic",
  "toeic-template": "toeic",
  "toeic-island": "toeic",
  "mom-sentence": "mom",
};

export const REVIEW_KIND_LABEL_KO: Readonly<Record<ReviewKind, string>> = {
  "en-word": "단어",
  "ja-word": "단어",
  "ja-kanji": "한자",
  "toeic-expr": "표현",
  "toeic-template": "틀",
  "toeic-island": "내 답변",
  "mom-sentence": "엄마 문장",
};

/** 영역 → 화면 경로(러너) */
export const REVIEW_AREA_PATH: Readonly<Record<ReviewArea, string>> = {
  english: "/english/review",
  japanese: "/japanese/review",
  toeic: "/toeic/review",
  mom: "/mom/review",
};

/**
 * 힌트 단계 — 정답을 보기 전에 연 힌트 수.
 * 0 = 힌트 없이 떠올림 · 1 = 힌트1(첫 글자)까지 · 2 = 힌트2(뼈대)까지 · 3 = 끝까지 못 떠올리고 정답을 봤다.
 */
export const REVIEW_HINT_LEVELS = [0, 1, 2, 3] as const;
export type ReviewHintLevel = (typeof REVIEW_HINT_LEVELS)[number];
/** 정답을 본 뒤 스스로 판정 — 맞췄어요 / 헷갈렸어요 / 몰랐어요 */
export const REVIEW_JUDGES = ["got", "unsure", "forgot"] as const;
export type ReviewJudge = (typeof REVIEW_JUDGES)[number];

export interface ReviewOutcome {
  hintLevel: ReviewHintLevel;
  judge: ReviewJudge;
}

export function isReviewArea(v: unknown): v is ReviewArea {
  return typeof v === "string" && (REVIEW_AREAS as readonly string[]).includes(v);
}
export function isReviewKind(v: unknown): v is ReviewKind {
  return typeof v === "string" && (REVIEW_KINDS as readonly string[]).includes(v);
}
export function isReviewHintLevel(v: unknown): v is ReviewHintLevel {
  return typeof v === "number" && (REVIEW_HINT_LEVELS as readonly number[]).includes(v);
}
export function isReviewJudge(v: unknown): v is ReviewJudge {
  return typeof v === "string" && (REVIEW_JUDGES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// 항목 키 — `{종류}:{원본 키}`
// ---------------------------------------------------------------------------

/** 항목 키를 만든다. 원본 키는 trim만 한다(정규화는 어댑터 책임 — 같은 항목이면 같은 원본 키) */
export function reviewItemKey(kind: ReviewKind, raw: string): string {
  return `${kind}:${raw.trim()}`;
}

/** 항목 키 → 종류·원본 키. 모양이 틀리면 null(제어 문자·빈 원본·길이 초과·모르는 종류) */
export function parseReviewItemKey(itemKey: unknown): { kind: ReviewKind; raw: string } | null {
  if (typeof itemKey !== "string" || itemKey.length === 0 || itemKey.length > REVIEW_ITEM_KEY_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(itemKey)) return null;
  const at = itemKey.indexOf(":");
  if (at <= 0) return null;
  const kind = itemKey.slice(0, at);
  const raw = itemKey.slice(at + 1);
  if (!isReviewKind(kind) || raw.trim() === "" || raw !== raw.trim()) return null;
  return { kind, raw };
}

/** 이 영역의 항목 키인가 */
export function isReviewItemKeyOfArea(itemKey: unknown, area: ReviewArea): boolean {
  const p = parseReviewItemKey(itemKey);
  return p !== null && REVIEW_KIND_AREA[p.kind] === area;
}

/** 32비트 FNV-1a(시드 다르게 두 번 → 16자 hex). 결정적·순수 */
function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 일정 문서 id = `{영역}-{종류}-{해시16}`. 원본 키에 `/`·공백·일본어가 들어가도 Firestore 문서 id로 안전하다
 * (항목 키 원문은 문서 안 `itemKey`에 그대로 둔다). 같은 항목 키 = 같은 id(멱등 갱신의 근거).
 */
export function reviewDocId(area: ReviewArea, itemKey: string): string {
  const p = parseReviewItemKey(itemKey);
  const kind = p ? p.kind : "x";
  const a = fnv1a32(itemKey, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a32(itemKey, 0x01000193 ^ 0x5bd1e995).toString(16).padStart(8, "0");
  return `${area}-${kind}-${a}${b}`;
}

// ---------------------------------------------------------------------------
// 일정 레코드 — 전부 필수(nullable) 키. Firestore undefined 거부 규약
// ---------------------------------------------------------------------------

export interface ReviewHistoryEntry {
  /** 복습한 KST 일자 */
  on: string;
  /** 복습한 시각 ISO */
  at: string;
  hintLevel: ReviewHintLevel;
  /** 실제로 적용한 판정(정답을 봤으면 forgot) */
  judge: ReviewJudge;
  /** 적용 뒤 단계 */
  step: number;
}

export interface ReviewScheduleRecord {
  /** reviewDocId(area, itemKey) */
  id: string;
  area: ReviewArea;
  kind: ReviewKind;
  /** `{종류}:{원본 키}` */
  itemKey: string;
  /** 간격 단계 0..REVIEW_MAX_STEP — 다음 복습 간격 = REVIEW_INTERVAL_DAYS[step] */
  step: number;
  /** 다음 복습 KST 일자 */
  dueOn: string;
  /** 힌트 없이 맞힌 연속 횟수(전진 폭 보너스의 근거) */
  streak: number;
  lastJudge: ReviewJudge | null;
  lastHintLevel: ReviewHintLevel | null;
  /** 마지막으로 복습한 KST 일자 — 같은 날 이중 적용 판정 */
  lastReviewedOn: string | null;
  reviewCount: number;
  history: ReviewHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && Number.isFinite(diffDateStrings(v, v));
}
function clampStep(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : 0;
  return Math.min(REVIEW_MAX_STEP, Math.max(0, v));
}
function nonNegInt(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * 저장 문서 → 레코드(두 백엔드 공유 정규화). **던지지 않는다** — 핵심(영역·종류·키·다음 복습일)이 깨졌으면 null(그 항목은 처음 들어오는
 * 항목으로 다시 계산된다 — 무해), 이력의 깨진 줄은 버린다. id는 항상 키에서 다시 계산한다.
 */
export function normalizeReviewSchedule(raw: unknown): ReviewScheduleRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = parseReviewItemKey(r.itemKey);
  if (!p || !isReviewArea(r.area) || REVIEW_KIND_AREA[p.kind] !== r.area) return null;
  if (!isDate(r.dueOn)) return null;
  const history: ReviewHistoryEntry[] = Array.isArray(r.history)
    ? (r.history as unknown[])
        .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
        .filter((h) => isDate(h.on) && typeof h.at === "string" && isReviewHintLevel(h.hintLevel) && isReviewJudge(h.judge))
        .map((h) => ({ on: h.on as string, at: h.at as string, hintLevel: h.hintLevel as ReviewHintLevel, judge: h.judge as ReviewJudge, step: clampStep(h.step) }))
        .slice(-REVIEW_HISTORY_MAX)
    : [];
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
  return {
    id: reviewDocId(r.area, r.itemKey as string),
    area: r.area,
    kind: p.kind,
    itemKey: r.itemKey as string,
    step: clampStep(r.step),
    dueOn: r.dueOn,
    streak: nonNegInt(r.streak),
    lastJudge: isReviewJudge(r.lastJudge) ? r.lastJudge : null,
    lastHintLevel: isReviewHintLevel(r.lastHintLevel) ? r.lastHintLevel : null,
    lastReviewedOn: isDate(r.lastReviewedOn) ? r.lastReviewedOn : null,
    reviewCount: nonNegInt(r.reviewCount),
    history,
    createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : createdAt,
  };
}

/** Firestore 쓰기 본문(id 뺀 것) — 쓰기 직전 정규화를 한 번 더 태운다 */
export function reviewScheduleData(rec: ReviewScheduleRecord): Omit<ReviewScheduleRecord, "id"> {
  const n = normalizeReviewSchedule(rec) ?? rec;
  const { id: _id, ...rest } = n;
  void _id;
  return rest;
}

// ---------------------------------------------------------------------------
// 판정 규칙 — 결과 → 다음 단계
// ---------------------------------------------------------------------------

/** 정답을 봤으면(힌트 단계 3) 판정과 무관하게 "몰랐어요"로 적용한다 */
export function effectiveJudge(o: ReviewOutcome): ReviewJudge {
  return o.hintLevel === 3 ? "forgot" : o.judge;
}

/**
 * 결과 → 다음 단계·연속 성공 (§23-3 표 — eval이 전수로 잠근다).
 *
 * | 결과 | 단계 | 연속 성공 |
 * |---|---|---|
 * | 맞췄어요 · 힌트 없이 | +1, 직전도 힌트 없이 맞혔으면(연속 ≥ 1) **+2** | +1 |
 * | 맞췄어요 · 힌트1 | +1 | 0 |
 * | 맞췄어요 · 힌트2 | 그대로 | 0 |
 * | 헷갈렸어요 · 힌트 없이 | +1 | 0 |
 * | 헷갈렸어요 · 힌트1·힌트2 | 그대로 | 0 |
 * | 몰랐어요 · 정답 봄(힌트 단계 3) | 0(1일) | 0 |
 *
 * 단계는 0..REVIEW_MAX_STEP로 자른다(30일에서 더 가면 30일 유지).
 */
export function nextReviewStep(prev: { step: number; streak: number }, o: ReviewOutcome): { step: number; streak: number; judge: ReviewJudge } {
  const judge = effectiveJudge(o);
  const step = clampStep(prev.step);
  const streak = nonNegInt(prev.streak);
  if (judge === "forgot") return { step: 0, streak: 0, judge };
  let delta = 0;
  let nextStreak = 0;
  if (judge === "got") {
    if (o.hintLevel === 0) {
      delta = streak >= 1 ? 2 : 1;
      nextStreak = streak + 1;
    } else if (o.hintLevel === 1) delta = 1;
    else delta = 0;
  } else {
    // unsure — 한 칸 약하게: 힌트 없이면 +1, 힌트를 봤으면 그대로
    delta = o.hintLevel === 0 ? 1 : 0;
  }
  return { step: clampStep(step + delta), streak: nextStreak, judge };
}

export interface DecideReviewInput {
  area: ReviewArea;
  itemKey: string;
  outcome: ReviewOutcome;
  /** 오늘 KST 일자 — 라우트가 한 번만 읽는다 */
  todayKst: string;
  nowIso: string;
}

export type DecideReviewResult =
  | { kind: "applied"; record: ReviewScheduleRecord }
  /** 오늘 이미 이 항목을 복습했다 — 아무것도 쓰지 않는다(이중 적용 방지) */
  | { kind: "already_today"; record: ReviewScheduleRecord };

/**
 * 복습 결과 하나를 적용한다(저장소가 원자 단위 안에서 부른다 — 파일 mutate·Firestore 트랜잭션).
 * prev가 null이면 처음 들어오는 항목(단계 0에서 출발). 영역·키가 맞지 않으면 RangeError(라우트 zod가 먼저 막는다 — 프로그래밍 오류).
 */
export function decideReview(prev: ReviewScheduleRecord | null, input: DecideReviewInput): DecideReviewResult {
  const p = parseReviewItemKey(input.itemKey);
  if (!p || REVIEW_KIND_AREA[p.kind] !== input.area) throw new RangeError(`review: 영역 ${input.area}의 항목 키가 아니에요 — ${String(input.itemKey)}`);
  if (!isDate(input.todayKst)) throw new RangeError(`review: 오늘 날짜 형식이 아니에요 — ${input.todayKst}`);
  if (!isReviewHintLevel(input.outcome.hintLevel) || !isReviewJudge(input.outcome.judge)) throw new RangeError("review: 결과 형식이 아니에요");
  // 넘겨받은 일정이 다른 항목·영역의 것이면 쓰지 않는다(새 항목으로 — QA common_review_1 F). 저장소가 같은 id로 찾았어도 키가 다르면 해시 충돌이다
  const norm = prev ? normalizeReviewSchedule(prev) : null;
  const base = norm && norm.itemKey === input.itemKey && norm.area === input.area ? norm : null;
  if (base && base.lastReviewedOn === input.todayKst) return { kind: "already_today", record: base };
  const cur = base ?? {
    id: reviewDocId(input.area, input.itemKey),
    area: input.area,
    kind: p.kind,
    itemKey: input.itemKey,
    step: 0,
    dueOn: input.todayKst,
    streak: 0,
    lastJudge: null,
    lastHintLevel: null,
    lastReviewedOn: null,
    reviewCount: 0,
    history: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
  const next = nextReviewStep(cur, input.outcome);
  const record: ReviewScheduleRecord = {
    ...cur,
    step: next.step,
    streak: next.streak,
    dueOn: shiftDateString(input.todayKst, REVIEW_INTERVAL_DAYS[next.step]),
    lastJudge: next.judge,
    lastHintLevel: input.outcome.hintLevel,
    lastReviewedOn: input.todayKst,
    reviewCount: cur.reviewCount + 1,
    history: [...cur.history, { on: input.todayKst, at: input.nowIso, hintLevel: input.outcome.hintLevel, judge: next.judge, step: next.step }].slice(-REVIEW_HISTORY_MAX),
    updatedAt: input.nowIso,
  };
  return { kind: "applied", record };
}

/** 단계 → 간격(일) */
export function reviewIntervalDays(step: number): number {
  return REVIEW_INTERVAL_DAYS[clampStep(step)];
}

// ---------------------------------------------------------------------------
// 오늘 큐
// ---------------------------------------------------------------------------

/** 큐 후보 — 어댑터가 만든 항목의 시험 기록 요약 */
export interface ReviewQueueCandidate {
  itemKey: string;
  /** 답한 문항 수(시험 기록) — 0이면 일정이 없을 때 큐에 들이지 않는다("시험 본 것"만) */
  attempts: number;
  /** 틀린 문항 수 — 처음 들어오는 항목의 우선순위 */
  wrongCount: number;
  /** 마지막으로 시험 본 시각 ISO(없으면 null) — 같은 우선순위면 오래된 것 먼저 */
  lastTestedAt: string | null;
  /**
   * 시험 기록 대신 **담은 날**로 들어오는 출처(토익 나만의 답변 섬 — §23-5)의 첫 복습일. 값이 있으면 일정이 없을 때 attempts와 무관하게
   * 이 날부터 큐에 들어온다(담은 다음 날 = 1일차). 없거나 null이면 "시험 본 것만" 규칙.
   */
  firstDueOn?: string | null;
}

export interface ReviewQueueEntry {
  itemKey: string;
  /** 처음 들어오는 항목(일정 없음)인가 */
  isNew: boolean;
  /** 이 항목이 원래 복습했어야 하는 날(처음 들어오는 항목은 오늘) */
  dueOn: string;
  /** 밀린 날 수(오늘이면 0) */
  overdueDays: number;
  /** 틀린 기록 우선 표시 */
  priority: boolean;
}

export interface ReviewQueue {
  /** 오늘 할 것(상한 적용 뒤, 순서대로) */
  entries: ReviewQueueEntry[];
  /** 상한 전 오늘 할 것의 총수 */
  dueCount: number;
  /** 오늘 이미 끝낸 수(이 영역 일정 전체 — 원본이 지워진 일정도 오늘 한 것이면 센다) */
  doneToday: number;
  cap: number;
}

/**
 * 오늘 큐(§23-4). 순서: ① 다음 복습일이 이른 것(밀린 것 오래된 순 — 처음 들어오는 항목은 오늘) ② 같은 날이면 틀린 기록이 있는 것
 * (일정이 있으면 마지막 판정이 "몰랐어요", 없으면 시험에서 틀린 적 있음) ③ 일정 있는 것이 처음 들어오는 것보다 먼저 ④ 틀린 수 많은 순
 * ⑤ 마지막 시험이 오래된 순(기록 없음은 뒤) ⑥ 항목 키 사전순(결정적).
 * - 후보에 없는 일정(원본이 지워진 고아 일정)은 큐에 넣지 않는다.
 * - 오늘 이미 복습한 항목은 넣지 않는다. 같은 항목 키는 한 번만(첫 후보).
 * - 상한 = cap − 오늘 이미 한 수(0 아래면 0).
 */
export function buildReviewQueue(input: {
  candidates: readonly ReviewQueueCandidate[];
  schedules: readonly ReviewScheduleRecord[];
  todayKst: string;
  cap?: number;
}): ReviewQueue {
  const cap = input.cap ?? REVIEW_DAILY_CAP;
  const today = input.todayKst;
  const sched = new Map<string, ReviewScheduleRecord>();
  for (const s of input.schedules) sched.set(s.itemKey, s);
  const doneToday = input.schedules.filter((s) => s.lastReviewedOn === today).length;

  type Row = ReviewQueueEntry & { hasSchedule: boolean; wrongCount: number; lastTestedAt: string | null };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const c of input.candidates) {
    if (seen.has(c.itemKey) || parseReviewItemKey(c.itemKey) === null) continue;
    seen.add(c.itemKey);
    const s = sched.get(c.itemKey);
    if (s) {
      if (s.lastReviewedOn === today) continue;
      if (s.dueOn > today) continue;
      rows.push({
        itemKey: c.itemKey,
        isNew: false,
        dueOn: s.dueOn,
        overdueDays: Math.max(0, diffDateStrings(s.dueOn, today) || 0),
        priority: s.lastJudge === "forgot",
        hasSchedule: true,
        wrongCount: nonNegInt(c.wrongCount),
        lastTestedAt: c.lastTestedAt,
      });
    } else {
      // 담은 날로 들어오는 출처: 첫 복습일이 오늘 이전이면 그날 밀린 것으로(오래된 순), 아직이면 들이지 않는다
      const first = c.firstDueOn ?? null;
      if (first !== null && isDate(first)) {
        if (first > today) continue;
      } else if (!(c.attempts > 0)) continue; // 시험 본 적 없는 항목은 들이지 않는다
      const due = first !== null && isDate(first) ? first : today;
      rows.push({
        itemKey: c.itemKey,
        isNew: true,
        dueOn: due,
        overdueDays: Math.max(0, diffDateStrings(due, today) || 0),
        priority: c.wrongCount > 0,
        hasSchedule: false,
        wrongCount: nonNegInt(c.wrongCount),
        lastTestedAt: c.lastTestedAt,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    if (a.hasSchedule !== b.hasSchedule) return a.hasSchedule ? -1 : 1;
    if (a.wrongCount !== b.wrongCount) return b.wrongCount - a.wrongCount;
    if (a.lastTestedAt !== b.lastTestedAt) {
      if (a.lastTestedAt === null) return 1;
      if (b.lastTestedAt === null) return -1;
      return a.lastTestedAt < b.lastTestedAt ? -1 : 1;
    }
    return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
  });
  const remaining = Math.max(0, cap - doneToday);
  return {
    entries: rows.slice(0, remaining).map(({ itemKey, isNew, dueOn, overdueDays, priority }) => ({ itemKey, isNew, dueOn, overdueDays, priority })),
    dueCount: rows.length,
    doneToday,
    cap,
  };
}

// ---------------------------------------------------------------------------
// 스트릭·요약
// ---------------------------------------------------------------------------

/** 복습한 KST 일자 집합(이력 기준 — 원본이 지워진 일정의 이력도 그날 공부한 사실이라 센다) */
export function reviewDays(schedules: readonly ReviewScheduleRecord[]): Set<string> {
  const days = new Set<string>();
  for (const s of schedules) for (const h of s.history) days.add(h.on);
  return days;
}

/**
 * 스트릭 입력 — 복습한 날마다 "답한 문항 1개" 세션 하나(computeStreak 모양). startedAt = 그날 KST 00:00(= 전날 15:00Z)이라
 * kstDateString이 그날로 접는다. 영역 분리는 호출측 책임(은우·일본어·토익 일정을 한 트랙에 섞지 마라).
 */
export function reviewStreakSessions(schedules: readonly ReviewScheduleRecord[]): { startedAt: string; items: { answered: boolean | null }[] }[] {
  return [...reviewDays(schedules)].sort().map((d) => ({ startedAt: `${shiftDateString(d, -1)}T15:00:00.000Z`, items: [{ answered: true }] }));
}

/** 오늘 복습한 항목 수 */
export function reviewDoneTodayCount(schedules: readonly ReviewScheduleRecord[], todayKst: string): number {
  return schedules.filter((s) => s.lastReviewedOn === todayKst).length;
}

/** 헤드라인 라벨 — 오늘 1개 이상이면 `오늘의 복습 · n개` */
export function reviewTodayLabel(schedules: readonly ReviewScheduleRecord[], todayKst: string): string | null {
  const n = reviewDoneTodayCount(schedules, todayKst);
  return n > 0 ? `오늘의 복습 · ${n}개` : null;
}

/** 다음 복습까지 날 수 → 짧은 한국어 */
export function reviewIntervalLabelKo(days: number): string {
  if (days === 1) return "내일";
  return `${days}일 뒤`;
}

export interface ReviewRunResult {
  judge: ReviewJudge;
  /** 다음 복습까지 날 수(적용되지 않았으면 null) */
  intervalDays: number | null;
}

export interface ReviewRunSummary {
  got: number;
  unsure: number;
  forgot: number;
  /** 간격(일) → 개수, 간격 오름차순 */
  byInterval: { days: number; count: number }[];
}

/** 끝 요약 — 맞힘/헷갈림/몰랐음 수와 다음 복습 분포 */
export function summarizeReviewResults(results: readonly ReviewRunResult[]): ReviewRunSummary {
  const out = { got: 0, unsure: 0, forgot: 0 };
  const by = new Map<number, number>();
  for (const r of results) {
    out[r.judge] += 1;
    if (r.intervalDays !== null) by.set(r.intervalDays, (by.get(r.intervalDays) ?? 0) + 1);
  }
  return { ...out, byInterval: [...by.entries()].sort((a, b) => a[0] - b[0]).map(([days, count]) => ({ days, count })) };
}

// ---------------------------------------------------------------------------
// 한 판 판정 — 가족 스트릭 강화 스펙 §2
// ---------------------------------------------------------------------------

/** 차례 온 기존 항목이 없는 날, 이만큼 복습하면 한 판(가족 스트릭 강화 스펙 §2-1) */
export const REVIEW_NEW_ONLY_MIN_RUN = 5;

/**
 * 복습 "한 판"을 한 KST 일자 집합(스펙 §2-1). 그날 D에 대해:
 * - 차례 온 기존 항목 = D 이전 마지막 이력 e의 (e.on + 간격[e.step]) ≤ D인 항목
 * - 한 판 = 그날 복습 ≥ 1 그리고 (그날 복습 ≥ REVIEW_DAILY_CAP, 또는 차례 온 기존 항목이 있고 전부 그날 복습, 또는 차례 온 것이 없고 그날 복습 ≥ REVIEW_NEW_ONLY_MIN_RUN)
 * 영역 분리는 호출측 책임.
 */
export function reviewFullDays(schedules: readonly ReviewScheduleRecord[]): Set<string> {
  const reviewedOn = new Map<string, Set<string>>(); // day → itemKeys
  for (const s of schedules) for (const e of s.history) {
    if (!reviewedOn.has(e.on)) reviewedOn.set(e.on, new Set());
    reviewedOn.get(e.on)!.add(s.itemKey);
  }
  const out = new Set<string>();
  for (const [day, done] of reviewedOn) {
    const dueBefore: string[] = [];
    for (const s of schedules) {
      let last: ReviewHistoryEntry | null = null;
      for (const e of s.history) if (e.on < day && (last === null || e.on >= last.on)) last = e;
      if (last === null) continue;
      const step = Math.min(REVIEW_MAX_STEP, Math.max(0, last.step));
      if (shiftDateString(last.on, REVIEW_INTERVAL_DAYS[step]) <= day) dueBefore.push(s.itemKey);
    }
    const n = done.size;
    const ok =
      n >= REVIEW_DAILY_CAP ||
      (dueBefore.length > 0 ? dueBefore.every((k) => done.has(k)) : n >= REVIEW_NEW_ONLY_MIN_RUN);
    if (n >= 1 && ok) out.add(day);
  }
  return out;
}

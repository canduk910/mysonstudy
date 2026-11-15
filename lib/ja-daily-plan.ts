/**
 * lib/ja-daily-plan.ts — 🗓️ 오늘의 일본어 **과정 엔진**(설계 §3). 순수·결정적 — `Date.now`·`Math.random` 없음, 같은 입력 = 같은 출력.
 *
 * 진도는 달력이 아니라 **끝낸 회차 수**다(엄마 선례 — 쉬어도 내용을 건너뛰지 않는다). 하루 = 한 회차 = 네 칸(🗣️ 회화 · 📚 N5 단어 · 📝 시험 대비 · 🔁 복습).
 * 배정은 **내용 수에서 계산**한다 — 반입 파일이 바뀌면 배정도 따라 바뀐다.
 *
 * - 회화 단위 큐(§3-1): Step1 → Step2 과 순서. kana 과 = 트랙 6개씩, Step1 dialog = A(会話1+練習1)·B(会話2+練習2+🎤),
 *   Step2 dialog = A·B·C(과 전체 다시 + 🎤 + 포인트). 큐가 끝난 회차의 회화 칸은 약한 과 다시 하기.
 *   **Step3는 이번 과정 큐에 넣지 않는다**(설계 §1 "90회 뒤 다음 과정" — 반입은 받는다). `buildJaDailyNextCourseUnits`가 따로 계산만 해 둔다.
 * - N5 단어: DAY d = 3회차(앞 절반 카드+퀴즈 / 뒤 절반 카드+퀴즈 / DAY 시험). 다 돌면 약한 단어 시험.
 * - 시험 대비: 청해 요령 하나씩 → 예제가 아닌 청해 문항 2개씩(문제 1→2→3→4) → 실전모의 1회 문항 연습(문자·어휘→문법→독해→청해,
 *   하루 몫 = max(3, ⌈문항 수 ÷ (80 − 청해 훈련 끝 회차)⌉), 같은 지문 문항은 한 날).
 * - 꼬리 10회(늘 맨 끝): 2회 실전(문자·어휘 / 문법·독해 / 청해) → 2회 채점표 → 1회 오답 → 2회 오답 → 총정리 ×4.
 * - 본 과정 길이 = max(80, 회화 단위 수, 단어 회차 수, 시험 대비 회차 수). 전체 = 본 과정 + 10.
 *
 * ⚠️ 런타임 import 0 — 화면·서버·eval 어디서든 쓴다(타입만 가져온다).
 */
import type { JaDailyMockSectionName, JaDailyTrackPart } from "./ja-daily-content";

// ---------------------------------------------------------------------------
// 입력 — 내용 색인(문장·뜻 없이 배정에 필요한 모양만)
// ---------------------------------------------------------------------------

export interface JaDailyLessonIndex {
  id: string;
  step: 1 | 2 | 3;
  lesson: number;
  kind: "kana" | "dialog";
  titleJa: string;
  titleKo: string;
  tracks: { audioKey: string; part: JaDailyTrackPart; lineIds: string[] }[];
  keyLineIds: string[];
}
export interface JaDailyContentIndex {
  lessons: JaDailyLessonIndex[];
  vocabDays: { day: number; wordIds: string[] }[];
  tips: { id: string; audioKey: string; titleKo: string }[];
  litems: { id: string; audioKey: string; mondai: 1 | 2 | 3 | 4; no: number; example: boolean }[];
  mocks: { round: number; sections: { section: JaDailyMockSectionName; mondai: number; points: number; items: { id: string; no: number; passageId: string | null }[] }[] }[];
}

// ---------------------------------------------------------------------------
// 출력 — 회차
// ---------------------------------------------------------------------------

export type JaDailyKaiwaSlot =
  | { type: "unit"; lessonId: string; unit: string; trackKeys: string[]; keyLineIds: string[]; withPoints: boolean }
  | { type: "review" };
export type JaDailyVocabSlot =
  | { type: "cards"; day: number; from: number; to: number }
  | { type: "dayTest"; day: number }
  | { type: "weak" };
export type JaDailyExamSlot =
  | { type: "tip"; tipId: string }
  | { type: "litems"; itemIds: string[] }
  | { type: "mockItems"; round: number; itemIds: string[] }
  | { type: "mockSection"; round: number; sections: JaDailyMockSectionName[] }
  | { type: "mockScore"; round: number }
  | { type: "mockReview"; round: number }
  | { type: "weakItems" }
  | { type: "final" };

export interface JaDailySession {
  n: number;
  /** core = 본 과정 · tail = 실전·총정리 10회 · repeat = 과정 뒤 반복 */
  phase: "core" | "tail" | "repeat";
  kaiwa: JaDailyKaiwaSlot;
  vocab: JaDailyVocabSlot;
  exam: JaDailyExamSlot;
  minutesHint: number;
}

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 본 과정 최소 길이 — 내용이 적어도 80회(+꼬리 10 = 90회) */
export const JA_DAILY_CORE_MIN = 80;
/** 꼬리(실전·총정리) 회차 수 — 늘 맨 끝 */
export const JA_DAILY_TAIL = 10;
/** kana 과 한 단위 트랙 수 */
export const JA_DAILY_KANA_TRACKS_PER_UNIT = 6;
/** 청해 훈련 하루 문항 수 */
export const JA_DAILY_LITEMS_PER_DAY = 2;
/** 모의 문항 연습 하루 몫 최소 */
export const JA_DAILY_MOCK_CHUNK_MIN = 3;
/** 약한 단어 시험 문항 상한 · 총정리 약한 문항 상한 */
export const JA_DAILY_WEAK_WORDS_MAX = 20;
export const JA_DAILY_WEAK_ITEMS_MAX = 10;
/** 칸별 어림(분) — 실전 섹션은 실제 시험 시간 */
export const JA_DAILY_MINUTES = { kaiwa: 10, vocab: 8, exam: 8, review: 4 } as const;
const MOCK_SECTION_MINUTES: Readonly<Record<JaDailyMockSectionName, number>> = { moji: 20, bunpou: 20, dokkai: 20, listening: 30 };
const SECTION_ORDER: readonly JaDailyMockSectionName[] = ["moji", "bunpou", "dokkai", "listening"];

// ---------------------------------------------------------------------------
// 결정적 비교
// ---------------------------------------------------------------------------

/** 숫자 인식 사전순(로캘 무관 — 같은 입력 = 같은 순서) */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      if (x.length !== y.length) return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function lessonOrder(a: { step: number; lesson: number; id: string }, b: { step: number; lesson: number; id: string }): number {
  return a.step - b.step || a.lesson - b.lesson || naturalCompare(a.id, b.id);
}

// ---------------------------------------------------------------------------
// 회화 단위
// ---------------------------------------------------------------------------

export type JaDailyKaiwaUnit = Extract<JaDailyKaiwaSlot, { type: "unit" }>;

/** 한 과 → 회화 단위(§3-1). 🎤(keyLineIds)는 그 과의 마지막 단위에 붙는다 */
export function jaDailyLessonUnits(l: JaDailyLessonIndex): JaDailyKaiwaUnit[] {
  const keys = (parts: readonly JaDailyTrackPart[]) => l.tracks.filter((t) => parts.includes(t.part)).map((t) => t.audioKey);
  if (l.kind === "kana") {
    const all = l.tracks.map((t) => t.audioKey);
    const units: JaDailyKaiwaUnit[] = [];
    for (let i = 0; i < all.length; i += JA_DAILY_KANA_TRACKS_PER_UNIT) {
      units.push({ type: "unit", lessonId: l.id, unit: String(units.length + 1), trackKeys: all.slice(i, i + JA_DAILY_KANA_TRACKS_PER_UNIT), keyLineIds: [], withPoints: false });
    }
    if (units.length > 0) units[units.length - 1].keyLineIds = [...l.keyLineIds];
    return units;
  }
  const a: JaDailyKaiwaUnit = { type: "unit", lessonId: l.id, unit: "A", trackKeys: keys(["kaiwa1", "renshu1"]), keyLineIds: [], withPoints: false };
  const b: JaDailyKaiwaUnit = { type: "unit", lessonId: l.id, unit: "B", trackKeys: keys(["kaiwa2", "renshu2"]), keyLineIds: [], withPoints: false };
  // 짝 파트가 없는(sound 등) 트랙은 A에 붙인다(버리지 않는다 — 빌드 리포트 daily1 #3, QA P3-c)
  const rest = l.tracks.filter((t) => !["kaiwa1", "renshu1", "kaiwa2", "renshu2"].includes(t.part)).map((t) => t.audioKey);
  a.trackKeys.push(...rest);
  if (l.step === 1) {
    b.keyLineIds = [...l.keyLineIds];
    return [a, b].filter((u) => u.trackKeys.length > 0 || u.keyLineIds.length > 0);
  }
  const c: JaDailyKaiwaUnit = { type: "unit", lessonId: l.id, unit: "C", trackKeys: l.tracks.map((t) => t.audioKey), keyLineIds: [...l.keyLineIds], withPoints: true };
  return [a, b, c].filter((u) => u.trackKeys.length > 0 || u.keyLineIds.length > 0);
}

/** 이번 과정의 회화 단위 큐 — Step1·Step2만 */
export function jaDailyKaiwaQueue(content: JaDailyContentIndex): JaDailyKaiwaUnit[] {
  return [...content.lessons]
    .filter((l) => l.step === 1 || l.step === 2)
    .sort(lessonOrder)
    .flatMap(jaDailyLessonUnits);
}

/** 다음 과정(Step3) 단위 — 화면이 "다음 과정"으로 열어 둘 때만 쓴다(이번 과정 배정에는 들어가지 않는다) */
export function buildJaDailyNextCourseUnits(content: JaDailyContentIndex): JaDailyKaiwaUnit[] {
  return [...content.lessons].filter((l) => l.step === 3).sort(lessonOrder).flatMap(jaDailyLessonUnits);
}

// ---------------------------------------------------------------------------
// 단어
// ---------------------------------------------------------------------------

function vocabSlots(content: JaDailyContentIndex): JaDailyVocabSlot[] {
  const days = [...content.vocabDays].sort((a, b) => a.day - b.day);
  const out: JaDailyVocabSlot[] = [];
  for (const d of days) {
    const n = d.wordIds.length;
    if (n === 0) continue;
    const half = Math.ceil(n / 2); // 25단어 → 13 / 12
    out.push({ type: "cards", day: d.day, from: 1, to: half });
    if (half < n) out.push({ type: "cards", day: d.day, from: half + 1, to: n });
    out.push({ type: "dayTest", day: d.day });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 시험 대비
// ---------------------------------------------------------------------------

function sortedMocks(content: JaDailyContentIndex) {
  return [...content.mocks].sort((a, b) => a.round - b.round);
}

/** 모의 회차의 문항을 섹션 순서(문자·어휘→문법→독해→청해) → 문제 번호 → 문항 번호로 */
function mockItemsInOrder(m: JaDailyContentIndex["mocks"][number]): { id: string; passageId: string | null; section: JaDailyMockSectionName }[] {
  return SECTION_ORDER.flatMap((sec) =>
    m.sections
      .filter((s) => s.section === sec)
      .sort((a, b) => a.mondai - b.mondai)
      .flatMap((s) => [...s.items].sort((a, b) => a.no - b.no || naturalCompare(a.id, b.id)).map((it) => ({ id: it.id, passageId: it.passageId, section: sec }))),
  );
}

/** 모의 문항을 하루 몫으로 — 같은 지문 문항(연속)은 한 날에 묶고, 몫을 채우면 닫는다 */
export function chunkJaDailyMockItems(items: readonly { id: string; passageId: string | null }[], chunk: number): string[][] {
  const groups: string[][] = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    const prev = last ? items.find((x) => x.id === last[last.length - 1]) : undefined;
    if (last && it.passageId !== null && prev && prev.passageId === it.passageId) last.push(it.id);
    else groups.push([it.id]);
  }
  const days: string[][] = [];
  let cur: string[] = [];
  for (const g of groups) {
    cur.push(...g);
    if (cur.length >= chunk) {
      days.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) days.push(cur);
  return days;
}

function examCoreSlots(content: JaDailyContentIndex): JaDailyExamSlot[] {
  const tips = [...content.tips].sort((a, b) => naturalCompare(a.id, b.id));
  const items = content.litems
    .filter((it) => !it.example)
    .sort((a, b) => a.mondai - b.mondai || a.no - b.no || naturalCompare(a.id, b.id));
  const out: JaDailyExamSlot[] = tips.map((t) => ({ type: "tip", tipId: t.id }));
  for (let i = 0; i < items.length; i += JA_DAILY_LITEMS_PER_DAY) out.push({ type: "litems", itemIds: items.slice(i, i + JA_DAILY_LITEMS_PER_DAY).map((x) => x.id) });
  const first = sortedMocks(content)[0];
  if (first) {
    const mItems = mockItemsInOrder(first);
    if (mItems.length > 0) {
      const slots = JA_DAILY_CORE_MIN - out.length;
      const chunk = slots > 0 ? Math.max(JA_DAILY_MOCK_CHUNK_MIN, Math.ceil(mItems.length / slots)) : JA_DAILY_MOCK_CHUNK_MIN;
      for (const ids of chunkJaDailyMockItems(mItems, chunk)) out.push({ type: "mockItems", round: first.round, itemIds: ids });
    }
  }
  return out;
}

function tailExamSlots(content: JaDailyContentIndex): JaDailyExamSlot[] {
  const mocks = sortedMocks(content);
  const r1 = mocks[0]?.round ?? null;
  const r2 = mocks[1]?.round ?? null;
  const fin: JaDailyExamSlot = { type: "final" };
  return [
    r2 !== null ? { type: "mockSection", round: r2, sections: ["moji"] } : fin,
    r2 !== null ? { type: "mockSection", round: r2, sections: ["bunpou", "dokkai"] } : fin,
    r2 !== null ? { type: "mockSection", round: r2, sections: ["listening"] } : fin,
    r2 !== null ? { type: "mockScore", round: r2 } : fin,
    r1 !== null ? { type: "mockReview", round: r1 } : fin,
    r2 !== null ? { type: "mockReview", round: r2 } : fin,
    fin,
    fin,
    fin,
    fin,
  ];
}

function examMinutes(e: JaDailyExamSlot): number {
  if (e.type === "mockSection") return e.sections.reduce((n, s) => n + MOCK_SECTION_MINUTES[s], 0);
  return JA_DAILY_MINUTES.exam;
}

function sessionOf(n: number, phase: JaDailySession["phase"], kaiwa: JaDailyKaiwaSlot, vocab: JaDailyVocabSlot, exam: JaDailyExamSlot): JaDailySession {
  return { n, phase, kaiwa, vocab, exam, minutesHint: JA_DAILY_MINUTES.kaiwa + JA_DAILY_MINUTES.vocab + examMinutes(exam) + JA_DAILY_MINUTES.review };
}

// ---------------------------------------------------------------------------
// 과정
// ---------------------------------------------------------------------------

/** 과정 전체(본 과정 + 꼬리 10). 내용이 하나도 없으면 빈 배열 */
export function buildJaDailyCourse(content: JaDailyContentIndex): JaDailySession[] {
  const kaiwa = jaDailyKaiwaQueue(content);
  const vocab = vocabSlots(content);
  const exam = examCoreSlots(content);
  const empty = kaiwa.length === 0 && vocab.length === 0 && exam.length === 0 && content.mocks.length === 0;
  if (empty) return [];
  const core = Math.max(JA_DAILY_CORE_MIN, kaiwa.length, vocab.length, exam.length);
  const out: JaDailySession[] = [];
  for (let i = 0; i < core; i++) {
    out.push(sessionOf(i + 1, "core", kaiwa[i] ?? { type: "review" }, vocab[i] ?? { type: "weak" }, exam[i] ?? { type: "weakItems" }));
  }
  tailExamSlots(content).forEach((e, j) => out.push(sessionOf(core + j + 1, "tail", { type: "review" }, { type: "weak" }, e)));
  return out;
}

/** n회차 — 과정 안이면 그 회차, 과정 뒤면 반복 모드(약한 것 섞기). n < 1이면 null */
export function jaDailySessionAt(course: readonly JaDailySession[], n: number): JaDailySession | null {
  if (!Number.isInteger(n) || n < 1) return null;
  if (n <= course.length) return course[n - 1];
  if (course.length === 0) return null;
  return sessionOf(n, "repeat", { type: "review" }, { type: "weak" }, { type: "final" });
}

/** 다음 회차 = 끝낸 회차 최댓값 + 1(기록이 중간을 건너뛰어도 최댓값 기준). replay 기록은 진도를 움직이지 않는다 */
export function nextJaDailySession(
  course: readonly JaDailySession[],
  records: readonly { n: number; replay: boolean; finishedAt: string | null }[],
): { n: number; session: JaDailySession | null; courseDone: boolean } {
  let max = 0;
  for (const r of records) if (!r.replay && r.finishedAt !== null && Number.isInteger(r.n) && r.n > max) max = r.n;
  const n = max + 1;
  return { n, session: jaDailySessionAt(course, n), courseDone: course.length > 0 && n > course.length };
}

// ---------------------------------------------------------------------------
// 약한 것 고르기 — 결정적 정렬(점수 → id)
// ---------------------------------------------------------------------------

export interface JaDailyRecordLike {
  n: number;
  startedAt: string;
  finishedAt: string | null;
  kaiwaChecks: readonly { lineId: string; accuracy: number | null; verdict: string }[];
  vocabAnswers: readonly { wordId: string; correct: boolean }[];
  examAnswers: readonly { itemId: string; correct: boolean | null }[];
}

interface Tally {
  key: string;
  right: number;
  wrong: number;
}
function rate(t: Tally): number {
  const n = t.right + t.wrong;
  return n === 0 ? 1 : t.right / n;
}
/** 틀린 적 있는 것 먼저(정답률 낮은 → 틀린 수 많은 → id), 그다음 나머지(정답률 → 답한 수 적은 → id) */
function rankTallies(ts: Tally[]): string[] {
  const wrong = ts.filter((t) => t.wrong > 0).sort((a, b) => rate(a) - rate(b) || b.wrong - a.wrong || naturalCompare(a.key, b.key));
  const rest = ts.filter((t) => t.wrong === 0).sort((a, b) => rate(a) - rate(b) || a.right + a.wrong - (b.right + b.wrong) || naturalCompare(a.key, b.key));
  return [...wrong, ...rest].map((t) => t.key);
}

/** 약한 단어(답한 적 있는 단어만) — 최대 JA_DAILY_WEAK_WORDS_MAX */
export function pickWeakWords(records: readonly JaDailyRecordLike[], max = JA_DAILY_WEAK_WORDS_MAX): string[] {
  const m = new Map<string, Tally>();
  for (const r of records) {
    if (r.finishedAt === null) continue;
    for (const a of r.vocabAnswers) {
      const t = m.get(a.wordId) ?? { key: a.wordId, right: 0, wrong: 0 };
      if (a.correct) t.right += 1;
      else t.wrong += 1;
      m.set(a.wordId, t);
    }
  }
  return rankTallies([...m.values()]).slice(0, max);
}

/** 약한 문항(채점된 답만 — 스스로 확인한 청해 문항 1·2는 correct null이라 빠진다) — 최대 JA_DAILY_WEAK_ITEMS_MAX */
export function pickWeakItems(records: readonly JaDailyRecordLike[], max = JA_DAILY_WEAK_ITEMS_MAX): string[] {
  const m = new Map<string, Tally>();
  for (const r of records) {
    if (r.finishedAt === null) continue;
    for (const a of r.examAnswers) {
      if (a.correct === null) continue;
      const t = m.get(a.itemId) ?? { key: a.itemId, right: 0, wrong: 0 };
      if (a.correct) t.right += 1;
      else t.wrong += 1;
      m.set(a.itemId, t);
    }
  }
  return rankTallies([...m.values()]).slice(0, max);
}

/**
 * 약한 과 — 🎤 정확도 평균이 낮은 과부터(같으면 과 순서). 체크 기록이 없는 과는 기록 있는 과 뒤에 과 순서로.
 * Step1·Step2 과만(이번 과정의 회화 큐와 같은 범위).
 */
export function pickWeakLessons(records: readonly JaDailyRecordLike[], lessons: readonly JaDailyLessonIndex[]): string[] {
  const inCourse = lessons.filter((l) => l.step === 1 || l.step === 2).sort(lessonOrder);
  const lineToLesson = new Map<string, string>();
  for (const l of inCourse) for (const t of l.tracks) for (const id of t.lineIds) lineToLesson.set(id, l.id);
  const sum = new Map<string, { s: number; c: number }>();
  for (const r of records) {
    if (r.finishedAt === null) continue;
    for (const k of r.kaiwaChecks) {
      const lid = lineToLesson.get(k.lineId);
      if (lid === undefined || k.accuracy === null || !Number.isFinite(k.accuracy)) continue;
      const cur = sum.get(lid) ?? { s: 0, c: 0 };
      cur.s += k.accuracy;
      cur.c += 1;
      sum.set(lid, cur);
    }
  }
  const order = new Map(inCourse.map((l, i) => [l.id, i] as const));
  const scored = inCourse.filter((l) => sum.has(l.id));
  const unscored = inCourse.filter((l) => !sum.has(l.id));
  scored.sort((a, b) => {
    const x = sum.get(a.id)!;
    const y = sum.get(b.id)!;
    return x.s / x.c - y.s / y.c || (order.get(a.id)! - order.get(b.id)!);
  });
  return [...scored, ...unscored].map((l) => l.id);
}

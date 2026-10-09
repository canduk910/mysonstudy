/**
 * lib/mom-plan.ts — 엄마의 생활영어 진도 엔진(설계 §3·§6-3). 순수·결정적 — 진도는 달력이 아니라 완료 순서.
 * 같은 입력 = 같은 출력(Date.now·Math.random 없음). 주간 테스트는 "금요일"이 아니라 그 주 레슨 4개를 다 끝낸 뒤 열린다.
 */
import { isSpeakRole, type MomBlock } from "./mom-content";
import type { MomLessonRecord, MomTestRecord } from "./mom-contract";

export const MOM_LESSONS_PER_WEEK = 4;
export const MOM_REVIEW_WEEKS: readonly number[] = [8, 16, 24, 32, 40, 48];
export const MOM_SLOWDOWN_THRESHOLD = 0.6;
export const MOM_REVIEW_LESSON_SIZE = 5;
/** 가상 복습 주(자동 감속) 번호 = 감속이 걸린 다음 주 + 이 값. 화면은 "복습 주"로 보인다. */
export const MOM_VIRTUAL_WEEK_OFFSET = 100;
type Stage = 0 | 1 | 2 | 3 | 4;

export function momStageOfWeek(week: number): Stage {
  if (week <= 4) return 0;
  if (week <= 16) return 1;
  if (week <= 32) return 2;
  if (week <= 46) return 3;
  return 4;
}
export function momTestSize(stage: Stage): number {
  return [5, 5, 8, 10, 10][stage];
}
export function momMinutesHint(stage: Stage): string {
  return ["5~7분", "8~10분", "12~15분", "15~18분", "18~20분"][stage];
}
/** 자동 감속으로 끼운 가상 복습 주인가(주 번호 > 100). */
export function isMomVirtualWeek(week: number): boolean {
  return week > MOM_VIRTUAL_WEEK_OFFSET;
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export interface MomLesson { id: string; week: number; day: 1 | 2 | 3 | 4; kind: "new" | "review"; blockId: string | null; speakIds: string[]; listenIds: string[] }
export interface MomWeekPlan { week: number; stage: Stage; kind: "new" | "review"; lessons: MomLesson[] }

function speakOf(blocks: readonly MomBlock[]): { id: string; blockId: string }[] {
  return blocks.flatMap((b) => b.sentences.filter((s) => isSpeakRole(s.role)).map((s) => ({ id: s.id, blockId: b.id })));
}

function sortBlocks(blocks: readonly MomBlock[]): MomBlock[] {
  return [...blocks].sort((a, b) => a.week - b.week || a.no - b.no || (a.id < b.id ? -1 : 1));
}

/** 복습 풀 = 기준 주 직전 8주(기준 주 제외)의 말하기 문장. */
function reviewPool(sorted: readonly MomBlock[], baseWeek: number): string[] {
  return speakOf(sorted.filter((b) => b.week < baseWeek && b.week >= baseWeek - 8)).map((s) => s.id);
}

function seededPick(ids: readonly string[], seed: number, size: number, first: readonly string[] = []): string[] {
  const head = first.filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !head.includes(id)).sort((a, b) => (hashStr(`${seed}:${a}`) - hashStr(`${seed}:${b}`)) || (a < b ? -1 : 1));
  return [...new Set([...head, ...rest])].slice(0, size);
}

function reviewLessons(weekLabel: number, idPrefix: string, pool: readonly string[]): MomLesson[] {
  const picked = seededPick(pool, weekLabel, MOM_REVIEW_LESSON_SIZE * MOM_LESSONS_PER_WEEK);
  return ([1, 2, 3, 4] as const)
    .map((day) => ({
      id: `${idPrefix}-d${day}`,
      week: weekLabel,
      day,
      kind: "review" as const,
      blockId: null,
      speakIds: picked.slice((day - 1) * MOM_REVIEW_LESSON_SIZE, day * MOM_REVIEW_LESSON_SIZE),
      listenIds: [],
    }))
    // 풀이 20문장보다 적으면 뒤쪽 레슨이 빈다 — 빈 레슨은 만들지 않는다.
    .filter((l) => l.speakIds.length > 0);
}

export function buildMomWeeks(blocks: readonly MomBlock[]): MomWeekPlan[] {
  if (blocks.length === 0) return [];
  const sorted = sortBlocks(blocks);
  const maxWeek = Math.max(...sorted.map((b) => b.week));
  const out: MomWeekPlan[] = [];
  for (let week = 1; week <= maxWeek; week++) {
    const wb = sorted.filter((b) => b.week === week);
    const stage = momStageOfWeek(week);
    if (wb.length === 0) {
      if (!MOM_REVIEW_WEEKS.includes(week)) continue;
      const lessons = reviewLessons(week, `rw${week}`, reviewPool(sorted, week));
      if (lessons.length > 0) out.push({ week, stage, kind: "review", lessons });
      continue;
    }
    const speak = speakOf(wb);
    const per = Math.ceil(speak.length / MOM_LESSONS_PER_WEEK);
    const lessons: MomLesson[] = ([1, 2, 3, 4] as const)
      .map((day) => {
        const part = speak.slice((day - 1) * per, day * per);
        const blockId = part[0]?.blockId ?? null;
        const block = wb.find((b) => b.id === blockId);
        return {
          id: `w${week}-d${day}`,
          week,
          day,
          kind: "new" as const,
          blockId,
          speakIds: part.map((p) => p.id),
          listenIds: block ? block.sentences.filter((s) => s.role === "dialog").map((s) => s.id) : [],
        };
      })
      .filter((l) => l.speakIds.length > 0);
    if (lessons.length > 0) out.push({ week, stage, kind: "new", lessons });
  }
  return out;
}

export function isFullMomLesson(rec: Pick<MomLessonRecord, "finishedAt" | "checks">, lesson: Pick<MomLesson, "speakIds">): boolean {
  if (rec.finishedAt === null) return false;
  const seen = new Set(rec.checks.map((c) => c.sentenceId));
  return lesson.speakIds.every((id) => seen.has(id));
}

export function isFullMomTest(rec: Pick<MomTestRecord, "finishedAt" | "items">): boolean {
  return rec.finishedAt !== null && rec.items.length >= 1 && rec.items.every((i) => typeof i.verdict === "string" && i.verdict.length > 0);
}

export function momTestPassRate(rec: Pick<MomTestRecord, "items">): number {
  if (rec.items.length === 0) return 0;
  return rec.items.filter((i) => i.verdict === "pass").length / rec.items.length;
}

/** 레슨 id → 주 번호(`w5-d1` → 5, `rw107-d2` → 107). 형식 밖이면 null. */
function weekOfLessonId(lessonId: string): number | null {
  const m = /^r?w(\d{1,3})-d[1-4]$/.exec(lessonId);
  return m ? Number(m[1]) : null;
}

/** 그 주의 테스트 풀 — 블록이 있는 실제 주는 그 주 말하기 문장, 복습 주(실제·가상)는 직전 8주. */
function testPool(sorted: readonly MomBlock[], week: number): string[] {
  if (isMomVirtualWeek(week)) return reviewPool(sorted, week - MOM_VIRTUAL_WEEK_OFFSET);
  const wb = sorted.filter((b) => b.week === week);
  if (wb.length > 0) return speakOf(wb).map((s) => s.id);
  return reviewPool(sorted, week);
}

/** 결정적 기록 순서 — 입력 순서와 무관하게 (lessonId, startedAt, id). */
function sortLessonRecs(lessons: readonly MomLessonRecord[]): MomLessonRecord[] {
  return [...lessons].sort((a, b) => cmp(a.lessonId, b.lessonId) || cmp(a.startedAt, b.startedAt) || cmp(a.id, b.id));
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function momPickTestItems(input: { week: number; blocks: readonly MomBlock[]; lessons: readonly MomLessonRecord[]; size: number }): string[] {
  const pool = testPool(sortBlocks(input.blocks), input.week);
  const first = sortLessonRecs(input.lessons)
    .filter((r) => weekOfLessonId(r.lessonId) === input.week)
    .flatMap((r) => r.checks.filter((c) => c.verdict === "retry" || c.verdict === "close").map((c) => c.sentenceId));
  return seededPick(pool, input.week, input.size, first);
}

export type MomTodayItem =
  | { kind: "empty" }
  | { kind: "lesson"; lesson: MomLesson; stage: Stage; minutesHint: string }
  | { kind: "test"; week: number; stage: Stage; size: number }
  | { kind: "done" };

export interface MomProgress {
  currentWeek: number;
  stage: Stage;
  doneLessons: number;
  totalLessons: number;
  weeks: { week: number; kind: "new" | "review"; status: "done" | "current" | "todo" }[];
}

type PlanInput = { blocks: readonly MomBlock[]; lessons: readonly MomLessonRecord[]; tests: readonly MomTestRecord[] };

/** 그 주의 대표 완료 테스트 — 가장 늦게 끝낸 것(동률은 id). 없으면 null. */
function latestFullTest(tests: readonly MomTestRecord[], week: number): MomTestRecord | null {
  let best: MomTestRecord | null = null;
  for (const t of tests) {
    if (t.week !== week || !isFullMomTest(t)) continue;
    if (!best || cmp(t.finishedAt as string, best.finishedAt as string) > 0 || (t.finishedAt === best.finishedAt && cmp(t.id, best.id) > 0)) best = t;
  }
  return best;
}

interface Walk {
  /** 걸은 순서대로의 주(가상 복습 주 포함) */
  seq: { plan: MomWeekPlan; virtual: boolean; complete: boolean; lessonsDone: boolean[] }[];
  today: MomTodayItem;
  currentIdx: number;
}

/**
 * 완료 순서로 걷는다. 멈춘 주(현재) 이후로는 가상 복습 주를 끼우지 않는다(아직 테스트가 없으므로).
 * 자동 감속: 새 주 N에 들어가기 직전, 걸어온 실제 새 주(복습 주 제외) 중 가장 최근 두 주의 완료 테스트가 둘 다 0.6 미만이면
 * N 앞에 가상 복습 주(N+100)를 끼운다. N마다 한 번만 판정하므로 같은 쌍으로 다시 걸리지 않는다.
 */
function walk(input: PlanInput): Walk {
  const sorted = sortBlocks(input.blocks);
  const plan = buildMomWeeks(sorted);
  const seq: Walk["seq"] = [];
  let today: MomTodayItem = { kind: "done" };
  let currentIdx = -1;
  const recentNewRates: number[] = [];

  const visit = (wp: MomWeekPlan, virtual: boolean) => {
    const lessonsDone = wp.lessons.map((l) => input.lessons.some((r) => r.lessonId === l.id && isFullMomLesson(r, l)));
    const test = latestFullTest(input.tests, wp.week);
    const complete = lessonsDone.every(Boolean) && test !== null;
    seq.push({ plan: wp, virtual, complete, lessonsDone });
    if (currentIdx === -1 && !complete) {
      currentIdx = seq.length - 1;
      const next = lessonsDone.indexOf(false);
      if (next >= 0) today = { kind: "lesson", lesson: wp.lessons[next], stage: wp.stage, minutesHint: momMinutesHint(wp.stage) };
      else today = { kind: "test", week: wp.week, stage: wp.stage, size: momTestSize(wp.stage) };
    }
    if (complete && !virtual && wp.kind === "new" && test) recentNewRates.push(momTestPassRate(test));
  };

  for (const wp of plan) {
    if (currentIdx === -1 && wp.kind === "new" && recentNewRates.length >= 2) {
      const [a, b] = recentNewRates.slice(-2);
      if (a < MOM_SLOWDOWN_THRESHOLD && b < MOM_SLOWDOWN_THRESHOLD) {
        const vw = wp.week + MOM_VIRTUAL_WEEK_OFFSET;
        const lessons = reviewLessons(vw, `rw${vw}`, reviewPool(sorted, wp.week));
        if (lessons.length > 0) visit({ week: vw, stage: momStageOfWeek(wp.week), kind: "review", lessons }, true);
      }
    }
    visit(wp, false);
  }
  return { seq, today, currentIdx };
}

export function momToday(input: PlanInput): MomTodayItem {
  if (input.blocks.length === 0) return { kind: "empty" };
  return walk(input).today;
}

export function momProgress(input: PlanInput): MomProgress {
  if (input.blocks.length === 0) return { currentWeek: 0, stage: 0, doneLessons: 0, totalLessons: 0, weeks: [] };
  const { seq, currentIdx } = walk(input);
  const cur = currentIdx >= 0 ? seq[currentIdx] : seq[seq.length - 1];
  const doneLessons = seq.reduce((n, s) => n + s.lessonsDone.filter(Boolean).length, 0);
  const totalLessons = seq.reduce((n, s) => n + s.plan.lessons.length, 0);
  const weeks = seq
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.virtual)
    .map(({ s, i }) => ({
      week: s.plan.week,
      kind: s.plan.kind,
      status: (currentIdx === -1 || i < currentIdx ? "done" : i === currentIdx ? "current" : "todo") as "done" | "current" | "todo",
    }));
  return { currentWeek: cur ? cur.plan.week : 0, stage: cur ? cur.plan.stage : 0, doneLessons, totalLessons, weeks };
}

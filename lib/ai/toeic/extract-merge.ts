/**
 * lib/ai/toeic/extract-merge.ts — 호출 A 판독 결과 후처리: 공백 정리 → DAY별 묶기 → 번호 병합 → keyExpressions 정리
 * (docs/harness/toeic.md §2-4 후처리 1~5)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 값을 만드는 곳은 여기뿐이다 — 라우트·화면은 결과를 소비만 한다.
 * 결과는 **초안**(ToeicSetDraft[])이다. 저장하지 않는다 — 사용자가 검토 화면에서 고친 뒤 저장한다(§2-4 5, §8).
 *
 * 은우 단어장 병합(english/vocabbook-merge.ts)과 같은 관용구지만, 표현 엔트리 모양이 달라 **새로** 둔다(§10 — 은우 코드 무수정).
 */

import { collapseSpaces } from "../../toeic-text";
import {
  TOEIC_SET_TITLE_MAX,
  type ToeicBookQuiz,
  type ToeicConfidence,
  type ToeicExprEntry,
  type ToeicExprExtraction,
  type ToeicExtractEntry,
} from "./schemas";

/** 사진 1장의 판독 결과 — 라우트가 사진 인덱스(0부터, 찍은 순서)를 붙여 넘긴다. 실패한 사진은 넘기지 않는다. */
export interface ToeicPhotoExtraction {
  photoIndex: number;
  extraction: ToeicExprExtraction;
}

/** DAY 하나의 초안(검토 화면이 고친 뒤 저장한다) */
export interface ToeicSetDraft {
  /** 기본 "DAY {n} {topicKo}"(defaultToeicSetTitle) */
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  /** 번호 오름차순. points는 전부 null(발화 포인트는 저장 뒤 호출 B가 채운다) */
  entries: ToeicExprEntry[];
  /** 번호 오름차순. keyExpressions는 이 초안 entries[].expression 표기로 맞춰져 있다 */
  quiz: ToeicBookQuiz[];
  /** 이 묶음에 든 사진 인덱스(오름차순) */
  photoIndexes: number[];
  /** 번호 수열의 구멍(사진 한 장 통째 누락 신호) */
  missingNos: number[];
  /** 겹쳐 찍기로 접힌 표현 항목 수 = 입력 항목 수 − 출력 항목 수 */
  mergedCount: number;
  /** 정리 단계에서 버린 keyExpressions 수(표현 항목과 대응이 안 되는 것 — 보고용) */
  droppedKeyExpressions: number;
}

export interface ToeicExtractMergeResult {
  drafts: ToeicSetDraft[];
  /** 표현 암기장 페이지가 아니라고 판독된 사진 인덱스(isExpressionPage=false) */
  notExpressionPhotoIndexes: number[];
}

/** 번호 수열의 구멍을 훑을 최대 폭 — 이보다 넓게 벌어지면(오독) 열거하지 않는다(은우 단어장과 같은 값) */
export const TOEIC_MISSING_SCAN_MAX = 200;

const CONFIDENCE_RANK: Record<ToeicConfidence, number> = { high: 2, medium: 1, low: 0 };

// ---------------------------------------------------------------------------
// 1. 공백 정리
// ---------------------------------------------------------------------------

const cleanNullable = (s: string | null): string | null => {
  if (s === null) return null;
  const v = collapseSpaces(s);
  return v === "" ? null : v;
};

/** §2-4 후처리 1 — 모든 문자열의 연속 공백을 하나로, 앞뒤 공백 제거. 비게 된 nullable 문자열은 null. */
export function cleanToeicExtraction(x: ToeicExprExtraction): ToeicExprExtraction {
  return {
    isExpressionPage: x.isExpressionPage,
    dayNo: x.dayNo,
    topicKo: cleanNullable(x.topicKo),
    entries: x.entries.map((e) => ({
      ...e,
      expression: collapseSpaces(e.expression),
      meaningKo: collapseSpaces(e.meaningKo),
      example: cleanNullable(e.example),
      exampleKo: cleanNullable(e.exampleKo),
    })),
    quiz: x.quiz.map((q) => ({
      ...q,
      promptKo: collapseSpaces(q.promptKo),
      hint: cleanNullable(q.hint),
      modelAnswer: collapseSpaces(q.modelAnswer),
      keyExpressions: q.keyExpressions.map(collapseSpaces).filter((k) => k !== ""),
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. keyExpressions 정리
// ---------------------------------------------------------------------------

/**
 * §2-4 후처리 2 — entries[].expression과 대소문자 무시로 일치하는 것만 남기고 표기를 항목 쪽으로 맞춘다.
 * 일치하지 않는 것은 **버린다**(거부 아님 — 교차 참조 실수로 재요청을 태우지 않는다). 같은 표현이 두 번이면 한 번만.
 */
export function cleanKeyExpressions(
  keyExpressions: readonly string[],
  entries: readonly { expression: string }[],
): { kept: string[]; dropped: number } {
  const byLower = new Map<string, string>();
  for (const e of entries) {
    const k = collapseSpaces(e.expression).toLowerCase();
    if (!byLower.has(k)) byLower.set(k, e.expression);
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const raw of keyExpressions) {
    const hit = byLower.get(collapseSpaces(raw).toLowerCase());
    if (hit === undefined) {
      dropped += 1;
      continue;
    }
    if (!kept.includes(hit)) kept.push(hit);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// 3~4. DAY별 묶기 + 묶음 안 병합
// ---------------------------------------------------------------------------

interface WithPhoto<T> {
  photoIndex: number;
  item: T;
}

function entryJoinKey(e: ToeicExtractEntry): string {
  return e.no !== null ? `no:${e.no}` : `expr:${e.expression.toLowerCase()}`;
}

function quizJoinKey(q: ToeicBookQuiz): string {
  return q.no !== null ? `no:${q.no}` : `prompt:${q.promptKo.toLowerCase()}`;
}

function entryContentLength(e: ToeicExtractEntry): number {
  return e.expression.length + e.meaningKo.length + (e.example?.length ?? 0) + (e.exampleKo?.length ?? 0);
}

function quizContentLength(q: ToeicBookQuiz): number {
  return q.promptKo.length + q.modelAnswer.length + (q.hint?.length ?? 0);
}

/** 조인 키로 묶는다(등장 순서 유지) */
function groupBy<T>(items: readonly WithPhoto<T>[], key: (t: T) => string): WithPhoto<T>[][] {
  const groups = new Map<string, WithPhoto<T>[]>();
  for (const it of items) {
    const k = key(it.item);
    const bucket = groups.get(k);
    if (bucket) bucket.push(it);
    else groups.set(k, [it]);
  }
  return [...groups.values()];
}

/** 대표본: 완전본(partial=false) → 내용이 긴 것 → 사진 번호가 낮은 것. confidence 최고값, partial은 전부 partial일 때만. */
function mergeEntryGroup(members: readonly WithPhoto<ToeicExtractEntry>[]): ToeicExprEntry {
  const primary = members.slice().sort((a, b) => {
    if (a.item.partial !== b.item.partial) return a.item.partial ? 1 : -1;
    const len = entryContentLength(b.item) - entryContentLength(a.item);
    if (len !== 0) return len;
    return a.photoIndex - b.photoIndex;
  })[0].item;
  const confidence = members.reduce<ToeicConfidence>(
    (best, m) => (CONFIDENCE_RANK[m.item.confidence] > CONFIDENCE_RANK[best] ? m.item.confidence : best),
    "low",
  );
  return {
    no: primary.no,
    expression: primary.expression,
    meaningKo: primary.meaningKo,
    example: primary.example,
    exampleKo: primary.exampleKo,
    points: null,
    confidence,
    partial: members.every((m) => m.item.partial),
  };
}

/** QUIZ 대표본: 내용이 긴 것 → 사진 번호가 낮은 것. keyExpressions는 멤버 합집합(뒤에서 정리). */
function mergeQuizGroup(members: readonly WithPhoto<ToeicBookQuiz>[]): ToeicBookQuiz {
  const primary = members.slice().sort((a, b) => {
    const len = quizContentLength(b.item) - quizContentLength(a.item);
    if (len !== 0) return len;
    return a.photoIndex - b.photoIndex;
  })[0].item;
  const keys: string[] = [];
  for (const m of [primary, ...members.map((x) => x.item)]) {
    for (const k of m.keyExpressions) if (!keys.includes(k)) keys.push(k);
  }
  return { ...primary, keyExpressions: keys };
}

/** 번호 오름차순 — 번호 있는 것 먼저(번호 순), 없는 것은 뒤(등장 순서 유지) */
function byNo<T extends { no: number | null }>(a: T, b: T): number {
  if (a.no !== null && b.no !== null) return a.no - b.no;
  if (a.no !== null) return -1;
  if (b.no !== null) return 1;
  return 0;
}

/** 번호 수열의 구멍(관측된 최소~최대 사이에서 빠진 번호) */
export function findMissingToeicNos(items: readonly { no: number | null }[]): number[] {
  const present = items.map((i) => i.no).filter((n): n is number => n !== null);
  if (present.length < 2) return [];
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max - min > TOEIC_MISSING_SCAN_MAX) return [];
  const have = new Set(present);
  const missing: number[] = [];
  for (let n = min + 1; n < max; n++) if (!have.has(n)) missing.push(n);
  return missing;
}

/** 세트 기본 제목(§7-1 "DAY {n} {topicKo}") — 빠진 쪽은 생략, 둘 다 없으면 "표현 모음" */
export function defaultToeicSetTitle(dayNo: number | null, topicKo: string | null): string {
  const topic = topicKo !== null ? collapseSpaces(topicKo) : "";
  const parts = [dayNo !== null ? `DAY ${dayNo}` : "", topic].filter((s) => s !== "");
  const title = parts.length > 0 ? parts.join(" ") : "표현 모음";
  return title.slice(0, TOEIC_SET_TITLE_MAX);
}

/**
 * 여러 사진의 판독을 DAY별 초안으로 만든다(§2-4 후처리 1~5).
 *
 * - `dayNo`가 같은 사진끼리 한 묶음(겹쳐 찍은 같은 페이지·두 장으로 나눠 찍은 한 페이지). `dayNo`가 null인 사진은 각자 한 묶음.
 * - 묶음 순서: DAY 번호 오름차순, DAY 없는 묶음은 뒤(사진 순서).
 * - 표현 항목 조인 키 `no`(없으면 expression 소문자), QUIZ 조인 키 `no`(없으면 promptKo 소문자).
 * - keyExpressions는 **묶음 전체**의 entries와 대조해 정리한다(스펙 §2-4의 "같은 사진"보다 넓다 — 한 페이지를 두 장으로
 *   나눠 찍으면 QUIZ와 그 표현이 서로 다른 사진에 있을 수 있어서. 같은 사진에서 일치하는 것은 당연히 묶음에서도 일치한다).
 * - 표현 항목도 QUIZ도 없는 묶음(빈 페이지로 판독된 사진)은 초안을 만들지 않는다.
 */
export function mergeToeicExtractions(pages: readonly ToeicPhotoExtraction[]): ToeicExtractMergeResult {
  const notExpressionPhotoIndexes: number[] = [];
  const cleaned: { photoIndex: number; x: ToeicExprExtraction }[] = [];
  for (const p of [...pages].sort((a, b) => a.photoIndex - b.photoIndex)) {
    if (!p.extraction.isExpressionPage) {
      notExpressionPhotoIndexes.push(p.photoIndex);
      continue;
    }
    cleaned.push({ photoIndex: p.photoIndex, x: cleanToeicExtraction(p.extraction) });
  }

  // 3. DAY별 묶기 — 같은 dayNo끼리, null은 사진마다 따로
  const groups = new Map<string, { photoIndex: number; x: ToeicExprExtraction }[]>();
  for (const c of cleaned) {
    const key = c.x.dayNo !== null ? `day:${c.x.dayNo}` : `photo:${c.photoIndex}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const drafts: ToeicSetDraft[] = [];
  for (const members of groups.values()) {
    const entriesIn = members.flatMap((m) => m.x.entries.map((item) => ({ photoIndex: m.photoIndex, item })));
    const quizIn = members.flatMap((m) => m.x.quiz.map((item) => ({ photoIndex: m.photoIndex, item })));
    if (entriesIn.length === 0 && quizIn.length === 0) continue;

    // 4. 묶음 안 병합
    const entries = groupBy(entriesIn, entryJoinKey).map(mergeEntryGroup).sort(byNo);
    let droppedKeyExpressions = 0;
    const quiz = groupBy(quizIn, quizJoinKey)
      .map(mergeQuizGroup)
      .sort(byNo)
      .map((q) => {
        // 2. keyExpressions 정리 — 이 묶음 entries 표기로 맞추고 대응 없는 것은 버린다
        const { kept, dropped } = cleanKeyExpressions(q.keyExpressions, entries);
        droppedKeyExpressions += dropped;
        return { ...q, keyExpressions: kept };
      });

    const dayNo = members[0].x.dayNo;
    // 주제: 멤버 중 가장 긴 것(잘리지 않고 읽힌 쪽), 없으면 null
    const topicKo = members.reduce<string | null>((best, m) => {
      const t = m.x.topicKo;
      if (t === null) return best;
      return best === null || t.length > best.length ? t : best;
    }, null);

    drafts.push({
      titleKo: defaultToeicSetTitle(dayNo, topicKo),
      dayNo,
      topicKo,
      entries,
      quiz,
      photoIndexes: members.map((m) => m.photoIndex),
      missingNos: findMissingToeicNos(entries),
      mergedCount: entriesIn.length - entries.length,
      droppedKeyExpressions,
    });
  }

  drafts.sort((a, b) => {
    if (a.dayNo !== null && b.dayNo !== null) return a.dayNo - b.dayNo;
    if (a.dayNo !== null) return -1;
    if (b.dayNo !== null) return 1;
    return a.photoIndexes[0] - b.photoIndexes[0];
  });

  return { drafts, notExpressionPhotoIndexes };
}

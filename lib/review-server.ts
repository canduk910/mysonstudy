/**
 * lib/review-server.ts — 오늘의 복습 **서버 등록부·진입 함수** (docs/SPEC.md §23-5·§23-6). 서버 전용(store를 읽는다).
 *
 * - `REVIEW_SOURCES` — 영역마다 출처를 **한 곳에 등록**한다. 출처 = 종류 + store에서 읽어 순수 어댑터(lib/review-sources)로 넘기는 함수.
 *   새 출처는 ① lib/review-schedule `REVIEW_KINDS` 등 세 표에 종류 한 줄,
 *   ② 어댑터 함수, ③ 여기 한 줄이면 큐·러너·스트릭이 따라온다. 은우 그림 보고 말하기는 새 종류 없이 en-word에 합쳐지고(같은 단어 한 항목),
 *   토익 나만의 답변 섬은 toeic-island(담은 날 기준 입장)로 들어온다(2026-10-03 연결 회차). 엄마의 생활영어는 mom-sentence(끝낸 레슨 기준 입장).
 * - `loadReviewQueue(area, todayKst)` — 출처 전부 → 카드 + 시험 기록 요약 → 일정과 합쳐 오늘 큐(상한 적용). 출처 하나가 실패해도
 *   나머지는 나온다(`failedSources`).
 * - `recordReview(area, itemKey, outcome)` — 외부(다른 화면·라우트)에서 복습 결과를 기록하는 공개 함수. 항목 키 모양·영역만 보고
 *   원본 존재는 확인하지 않는다(고아 일정은 큐가 무시해서 무해). 같은 날 같은 항목은 `already_today`.
 *
 * AI 호출 없음 — 비용 0.
 */

import { kstTodayString } from "./kst";
import { getStore, type StudyStore } from "./store";
import {
  REVIEW_DAILY_CAP,
  REVIEW_KIND_AREA,
  buildReviewQueue,
  isReviewItemKeyOfArea,
  reviewIntervalDays,
  type DecideReviewResult,
  type ReviewArea,
  type ReviewKind,
  type ReviewOutcome,
} from "./review-schedule";
import {
  englishWordItems,
  japaneseKanjiItems,
  japaneseWordItems,
  toeicExpressionItems,
  toeicTemplateItems,
  toeicIslandItems,
  momSentenceItems,
  type ReviewCard,
  type ReviewSourceItem,
} from "./review-sources";
import { isToeicQuizModeSession, isToeicTemplateBankMode } from "./toeic-quiz";
import { isRenderableToeicTemplate, isRenderableToeicTemplateBank, isToeicTemplateBankSet } from "./toeic-record";
import type { ToeicTemplateLike } from "./review-sources";

export interface ReviewSourceRegistration {
  kind: ReviewKind;
  /** store에서 읽어 어댑터에 넘긴다 — 시험 본 항목만 낸다 */
  collect(store: StudyStore): Promise<ReviewSourceItem[]>;
}

/** 영역별 출처 등록부 — 새 출처는 여기 한 줄 */
export const REVIEW_SOURCES: Readonly<Record<ReviewArea, readonly ReviewSourceRegistration[]>> = {
  english: [
    {
      kind: "en-word",
      collect: async (store) => {
        const [books, quizzes] = await Promise.all([store.listVocabBooks(), store.listAllVocabQuizzes()]);
        return englishWordItems(books, quizzes);
      },
    },
  ],
  japanese: [
    {
      kind: "ja-word",
      collect: async (store) => {
        const [books, quizzes] = await Promise.all([store.listJaVocabBooks(), store.listAllJaQuizzes()]);
        return japaneseWordItems(books, quizzes);
      },
    },
    {
      kind: "ja-kanji",
      collect: async (store) => {
        const [kanji, quizzes] = await Promise.all([store.listJaKanji(), store.listJaKanjiQuizzes()]);
        return japaneseKanjiItems(kanji, quizzes);
      },
    },
  ],
  toeic: [
    {
      kind: "toeic-expr",
      collect: async (store) => {
        const [sets, quizzes] = await Promise.all([store.listToeicSets(), store.listAllToeicQuizzes()]);
        const exprSets = sets.filter((s) => !isToeicTemplateBankSet(s) && Array.isArray(s.entries));
        return toeicExpressionItems(exprSets, quizzes.filter(isToeicQuizModeSession));
      },
    },
    {
      kind: "toeic-template",
      collect: async (store) => {
        const [sets, quizzes, drills, drillBank] = await Promise.all([
          store.listToeicSets(),
          store.listAllToeicQuizzes(),
          // 틀 말하기 기록·은행은 없어도(새 컬렉션) 틀 시험 기록만으로 계속 간다
          store.listToeicFrameDrillSessions().catch(() => []),
          store.getToeicFrameDrillBank().catch(() => null),
        ]);
        const bank = sets.find((s) => isToeicTemplateBankSet(s) && isRenderableToeicTemplateBank(s));
        const g = bank?.guide as { items?: unknown[] } | null | undefined;
        const templates = (Array.isArray(g?.items) ? g.items : []).filter(isRenderableToeicTemplate) as unknown as ToeicTemplateLike[];
        return toeicTemplateItems(
          templates,
          quizzes.filter((q) => isToeicTemplateBankMode(q.mode)),
          drills,
          drillBank?.frames ?? [],
        );
      },
    },
    {
      // 나만의 답변 섬(toeic.md §21) — 시험 기록이 아니라 "담음"이 입장 조건(담은 다음 날이 첫 복습일). 지운 문장은 목록에 없어 큐에서 빠진다
      kind: "toeic-island",
      collect: async (store) => {
        const [entries, drillBank, sets] = await Promise.all([
          store.listToeicIslandEntries(),
          store.getToeicFrameDrillBank().catch(() => null),
          store.listToeicSets(),
        ]);
        const bank = sets.find((s) => isToeicTemplateBankSet(s) && isRenderableToeicTemplateBank(s));
        const g = bank?.guide as { items?: unknown[] } | null | undefined;
        const bankFrames = (Array.isArray(g?.items) ? g.items : []).filter(isRenderableToeicTemplate) as unknown as { key: string; frameEn: string; frameKo: string }[];
        const frames = [...(drillBank?.frames ?? []).map((f) => ({ key: f.key, frameEn: f.frameEn, frameKo: f.frameKo })), ...bankFrames.map((t) => ({ key: `tpl:${t.key}`, frameEn: t.frameEn, frameKo: t.frameKo }))];
        return toeicIslandItems(entries, frames);
      },
    },
  ],
  mom: [
    {
      // 엄마의 생활영어 — 레슨에서 결과가 난 말하기 문장, 처음 끝낸 다음 날부터(lib/review-sources momSentenceItems)
      kind: "mom-sentence",
      collect: async (store) => {
        const [blocks, lessons, tests] = await Promise.all([store.listMomBlocks(), store.listMomLessons(), store.listMomTests()]);
        return momSentenceItems(blocks, lessons, tests);
      },
    },
  ],
};

export interface LoadedReviewQueue {
  area: ReviewArea;
  today: string;
  cap: number;
  doneToday: number;
  dueCount: number;
  cards: ReviewCard[];
  failedSources: number;
}

/** 오늘 큐 — 페이지(서버 컴포넌트)와 GET 라우트가 같이 쓴다 */
export async function loadReviewQueue(area: ReviewArea, todayKst: string = kstTodayString(), store: StudyStore = getStore()): Promise<LoadedReviewQueue> {
  const regs = REVIEW_SOURCES[area];
  const [settled, schedules] = await Promise.all([
    Promise.allSettled(regs.map((r) => r.collect(store))),
    store.listReviewSchedules(area),
  ]);
  const items: ReviewSourceItem[] = [];
  let failedSources = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      failedSources += 1;
      console.error(`[review] 출처 ${regs[i].kind}를 읽지 못했다 — 그 출처만 빼고 큐를 만든다`, r.reason);
    }
  });
  const byKey = new Map<string, ReviewCard>();
  for (const it of items) if (!byKey.has(it.card.itemKey)) byKey.set(it.card.itemKey, it.card);
  const queue = buildReviewQueue({
    candidates: items.map((it) => ({ itemKey: it.card.itemKey, ...it.stats })),
    schedules,
    todayKst,
    cap: REVIEW_DAILY_CAP,
  });
  return {
    area,
    today: todayKst,
    cap: queue.cap,
    doneToday: queue.doneToday,
    dueCount: queue.dueCount,
    cards: queue.entries.map((e) => byKey.get(e.itemKey)).filter((c): c is ReviewCard => c !== undefined),
    failedSources,
  };
}

export interface RecordReviewResult {
  decision: DecideReviewResult;
  intervalDays: number;
}

/**
 * 복습 결과 기록(공개). 항목 키가 이 영역의 것이 아니면 RangeError. "오늘"·"지금"은 여기서 한 번만 읽는다(테스트는 주입).
 */
export async function recordReview(
  area: ReviewArea,
  itemKey: string,
  outcome: ReviewOutcome,
  opts: { now?: Date; store?: StudyStore } = {},
): Promise<RecordReviewResult> {
  if (!isReviewItemKeyOfArea(itemKey, area)) throw new RangeError(`review: ${area} 영역의 항목 키가 아니에요`);
  const now = opts.now ?? new Date();
  const store = opts.store ?? getStore();
  const decision = await store.applyReviewOutcome({ area, itemKey, outcome, todayKst: kstTodayString(now), nowIso: now.toISOString() });
  return { decision, intervalDays: reviewIntervalDays(decision.record.step) };
}

/** 종류 → 영역(라우트·화면 보조) */
export function reviewAreaOfKind(kind: ReviewKind): ReviewArea {
  return REVIEW_KIND_AREA[kind];
}

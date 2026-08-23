/**
 * lib/vocab-review.ts — 복습 리마인드 선택 순수 함수 (단어장 정복 V6, 계획 §V6)
 *
 * 사용자 요청: "매 시험마다 지난 시험 단어 중 **틀렸던 것 4개 + 맞았던 것 1개**를, 단어의
 * 중요도·난이도로 가중해 5개쯤 섞어 달라." 이 파일은 **AI 0·실호출 0**으로 그 5개를 고른다 —
 * 전부 시험 기록(`VocabQuizRecord`)에서 계산하는 순수 함수다. 부수효과·외부 의존이 없어
 * 서버(시험 페이지가 풀을 계산)에서 안전하고, `scripts/eval-english.ts`가 실호출 없이 불변을 잠근다.
 *
 * ── 두 함수 ─────────────────────────────────────────────────────────────────
 * 1. `buildReviewCandidates(allQuizzes)` — 모든 DAY의 세션(전역 startedAt 오름차순)을 단어별 전역
 *    통계 `{ total, wrong, streak, mastered, lastWrongOrder, lastSeenOrder }`로 접는다. total/wrong/streak는
 *    `aggregateWordStats`(V5)를 **재사용**한다(중복 구현 금지) — recency(마지막으로 틀린/보인 세션
 *    순번)만 여기서 더한다.
 * 2. `selectReviewSet(candidates, ctx, opts, rng?)` — **틀린 풀 상위 4 + 잘한 풀 상위 1**(총 ≤5)을
 *    가중 점수로 고른다. 가중 로직(난이도·중요도·점수)은 **이 파일 한 곳에만** 산다.
 *
 * ── 복습 범위 = 모든 DAY 누적 (사용자 확정) ─────────────────────────────────
 * 후보는 한 DAY가 아니라 **전 DAY의 시험 이력**에서 나온다(`listAllVocabQuizzes`). 각 후보는
 * 자기 source DAY(bookId)의 정의·보기 후보를 달고 나온다 — 시험 페이지가 그 DAY 단어로 5지선다를
 * 만든다(buildChoices 같은-DAY 계약 유지, cross-DAY 오답 금지).
 *
 * ── 가중치 상수는 파일 상단(튜닝 지점) ──────────────────────────────────────
 * 정확한 값은 판단이지만 **불변은 eval로 잠근다**: 오답률 높을수록·최근 틀릴수록·시도 적을수록
 * 점수↑(단조), 4+1 구성, 중복 0, 현재 DAY 단어 미포함, 정의·보기수 필터 준수, 콜드스타트 graceful.
 */

import { aggregateWordStats, isStatMastered } from "./vocab-mastery";
import type { Rng } from "./vocab-quiz";
import type { VocabQuizRecord } from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// 가중치 상수 — 튜닝 지점. 값을 바꿔도 eval의 단조성 불변은 유지되어야 한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 틀린 풀에서 뽑을 최대 개수 (사용자 요청: 틀렸던 것 4개) */
export const REVIEW_WRONG_COUNT = 4;
/** 잘한 풀에서 뽑을 최대 개수 (사용자 요청: 맞았던 것 1개) */
export const REVIEW_GOOD_COUNT = 1;
/** 복습 문제 최대 개수 = 4 + 1 = 5 ("5개쯤 섞어 달라") */
export const REVIEW_MAX = REVIEW_WRONG_COUNT + REVIEW_GOOD_COUNT;

/**
 * 난이도(오답률) streak 가중 — streak가 낮을수록(불안정할수록) 난이도를 크게 본다.
 * 틀린 풀은 미졸업(streak < 2)이므로 사실상 streak ∈ {0, 1}만 곱해진다.
 */
const STREAK0_BOOST = 1.6; // 최근 연속정답 0 — 가장 불안정 → 크게 올림
const STREAK1_BOOST = 1.2; // 한 번 맞음 — 소폭 올림
const STREAK_STABLE = 1.0; // streak ≥ 2(졸업권) — 가중 없음

/** 중요도 항 가중 (틀린 풀): 틀린횟수(정규화) + 최근성 + 시도적음 */
const W_WRONGCOUNT = 1.0; // 많이 틀린 단어일수록↑
const W_RECENCY = 1.0; // 최근에 틀린 단어일수록↑ (마지막 오답 세션 순번)
const W_FEWATTEMPTS = 1.0; // 시도가 적은 단어일수록↑ (1/total)

/** 잘한 풀 중요도 (난이도≈0이라 중요도만으로 1개 선택): 최근성 + 시도적음 */
const W_GOOD_RECENCY = 1.0; // 최근에 본 단어일수록↑ (마지막 시도 세션 순번)
const W_GOOD_FEWATTEMPTS = 1.0; // 시도가 적은 단어일수록↑

/**
 * 동점 흔들기 진폭 — 점수 간격보다 훨씬 작아 **비동점 순서는 절대 바꾸지 않는다**.
 * rng가 주어졌을 때만 더해, 정확히 같은 점수의 단어들 사이 순서를 결정적으로 흔든다.
 */
const TIE_JITTER = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────────

/** 단어 하나의 전역 복습 통계 — 저장하지 않고 읽을 때 계산한다. */
export interface ReviewCandidate {
  word: string;
  /** 시도 수(answered===true, 여러 세션·DAY 합산) — aggregateWordStats 재사용 */
  total: number;
  /** 오답 수(answered===true && correct===false) */
  wrong: number;
  /** 가장 최근부터 연속 정답 수(시간순 이력의 꼬리에서) */
  streak: number;
  /** streak ≥ MASTERY_STREAK(2)면 졸업 */
  mastered: boolean;
  /** 마지막으로 **틀린** 세션 순번(전역 오름차순 1-based). 틀린 적 없으면 0 */
  lastWrongOrder: number;
  /** 마지막으로 **시도한** 세션 순번(전역 오름차순 1-based). 시도가 있으면 ≥ 1 */
  lastSeenOrder: number;
}

/** 복습 단어 하나를 문제로 만들 때 필요한 출처 — 시험 페이지가 ctx로 주입한다. */
export interface ReviewWordSource {
  /** 문제로 보여줄 영영 정의(그 단어의 source DAY 저장값) */
  definitionEn: string;
  /** 그 단어가 속한 DAY(VocabBookRecord.id) */
  sourceBookId: string;
  /** source DAY의 모든 단어 — buildChoices 오답 후보(같은-DAY 계약) */
  sourceDayWords: string[];
}

/**
 * 복습 선택에 주입하는 문맥(필터의 진실 원천).
 *
 * `sources`에 있는 단어만 복습 대상이 된다 — 시험 페이지가 **정의 있음 + source DAY의 정의 단어 ≥5
 * (5지선다 보기 확보) + 현재 DAY 아님**을 만족하는 단어만 넣는다. `currentDayWords`는 이번 시험에서
 * 새로 낼 단어라 복습에서 뺀다(중복 방지).
 */
export interface ReviewContext {
  /** 전역 세션 수(최근성 정규화 분모). listAllVocabQuizzes().length */
  totalSessions: number;
  /** 이번에 시험 볼 DAY의 단어들 — 복습에서 제외(중복 방지) */
  currentDayWords: readonly string[];
  /** 복습 가능한 단어 → 출처. 여기 없는 단어(정의 없음·보기 부족·현재 DAY)는 후보에서 탈락 */
  sources: ReadonlyMap<string, ReviewWordSource>;
}

/** 고른 복습 문제 하나 — 시험 페이지·화면이 문제·보기 생성에 쓰는 최소 정보. */
export interface ReviewQuestion {
  word: string;
  definitionEn: string;
  sourceBookId: string;
  sourceDayWords: string[];
}

/** 점수와 함께 정렬된 복습 후보 — eval이 단조성을 직접 검증하는 창(가중 로직은 여전히 이 파일에만). */
export interface ReviewScored {
  question: ReviewQuestion;
  candidate: ReviewCandidate;
  score: number;
}

/** 4+1을 뽑기 위한 두 풀(각각 점수 내림차순). */
export interface RankedReviewPools {
  /** 틀린 풀 = attempted & 미졸업 & wrong>0 (점수 내림차순) */
  wrong: ReviewScored[];
  /** 잘한 풀 = attempted & (졸업 or wrong===0) (점수 내림차순) */
  good: ReviewScored[];
}

/** 뽑을 개수 조정(기본 4+1). eval·튜닝이 개수를 흔들 때만 쓴다. */
export interface ReviewSelectOptions {
  wrongCount?: number;
  goodCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 후보 만들기 — 전역 통계 + recency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 모든 DAY의 시험 세션을 단어별 복습 통계로 접는다(계획 §V6).
 *
 * **`allQuizzes`는 전역 startedAt 오름차순이어야 한다**(listAllVocabQuizzes 계약). total/wrong/streak는
 * `aggregateWordStats`를 그대로 재사용한다(streak의 순서 의존성·시도 정의를 한 곳에서만 관리).
 * recency는 오름차순 세션을 걸으며 각 단어가 **마지막으로 시도/틀린 세션 순번**(1-based)을 기록한다.
 *
 * @param allQuizzes 전역 startedAt 오름차순 세션 목록
 * @returns 시도된 단어들의 복습 후보(한 번도 시도 안 된 단어는 없음 — aggregateWordStats와 같은 키 집합)
 */
export function buildReviewCandidates(
  allQuizzes: readonly VocabQuizRecord[],
): ReviewCandidate[] {
  // total/wrong/streak — V5 순수 함수 재사용(중복 구현 금지). 시도·streak 정의가 한 곳에 산다.
  const stats = aggregateWordStats(allQuizzes);

  // recency — 전역 오름차순에서 각 단어가 마지막으로 시도/틀린 세션 순번(1-based).
  const lastSeen = new Map<string, number>();
  const lastWrong = new Map<string, number>();
  allQuizzes.forEach((quiz, i) => {
    const order = i + 1; // 세션 순번(전역 오름차순) — 뒤일수록 최근
    for (const item of quiz.items) {
      if (item.answered !== true) continue; // 시도 = answered===true인 문항만(aggregate와 같은 규약)
      lastSeen.set(item.word, order);
      if (item.correct !== true) lastWrong.set(item.word, order);
    }
  });

  const out: ReviewCandidate[] = [];
  for (const [word, st] of Object.entries(stats)) {
    out.push({
      word,
      total: st.total,
      wrong: st.wrong,
      streak: st.streak,
      mastered: isStatMastered(st),
      lastWrongOrder: lastWrong.get(word) ?? 0,
      lastSeenOrder: lastSeen.get(word) ?? 0,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 가중 점수 — 난이도 × 중요도 (이 파일에만 존재)
// ─────────────────────────────────────────────────────────────────────────────

/** streak가 낮을수록 난이도 가중↑ (미졸업 풀은 streak ∈ {0,1}). */
function streakBoost(streak: number): number {
  if (streak <= 0) return STREAK0_BOOST;
  if (streak === 1) return STREAK1_BOOST;
  return STREAK_STABLE;
}

/** 난이도 = 오답률(wrong/max(1,total)) × streak 가중. 틀린 풀은 wrong>0이라 항상 양수. */
function difficulty(c: ReviewCandidate): number {
  const wrongRate = c.wrong / Math.max(1, c.total);
  return wrongRate * streakBoost(c.streak);
}

/**
 * 두 풀을 각각 점수 내림차순으로 정렬한다(가중 로직의 단일 정의처).
 *
 * 자격 필터(ctx 주입): `sources`에 있고(정의·보기≥5·현재 book 아님) & `currentDayWords`에 없는 단어만.
 * - 틀린 풀 = 미졸업 & wrong>0. 점수 = **난이도 × 중요도**(중요도 = 틀린횟수 정규화 + 최근성 + 시도적음).
 * - 잘한 풀 = 졸업 or wrong===0. 난이도≈0이라 **중요도(최근성 + 시도적음)만으로** 정렬해 1개 고른다.
 * - 동점은 rng가 있을 때만 아주 작게 흔든다(비동점 순서는 불변).
 */
export function rankReviewPools(
  candidates: readonly ReviewCandidate[],
  ctx: ReviewContext,
  rng?: Rng,
): RankedReviewPools {
  const currentDay = new Set(ctx.currentDayWords);
  // 자격: 출처가 있고(정의+보기≥5+현재 book 아님) 현재 DAY의 단어가 아님.
  const eligible = candidates.filter(
    (c) => ctx.sources.has(c.word) && !currentDay.has(c.word),
  );

  const wrongCands = eligible.filter((c) => !c.mastered && c.wrong > 0);
  const goodCands = eligible.filter((c) => c.mastered || c.wrong === 0);

  // 정규화 분모(풀·문맥 의존, 후보 간 공통이라 순서에 영향 없음).
  const maxWrong = Math.max(1, ...wrongCands.map((c) => c.wrong));
  const sessions = Math.max(1, ctx.totalSessions);

  const jitter = (): number => (rng ? (rng() - 0.5) * TIE_JITTER : 0);

  const scoreWrong = (c: ReviewCandidate): number => {
    const importance =
      W_WRONGCOUNT * (c.wrong / maxWrong) + // 틀린횟수(정규화)
      W_RECENCY * (c.lastWrongOrder / sessions) + // 최근성(최근 틀릴수록↑)
      W_FEWATTEMPTS * (1 / Math.max(1, c.total)); // 시도적음(total 작을수록↑)
    return difficulty(c) * importance;
  };
  const scoreGood = (c: ReviewCandidate): number =>
    W_GOOD_RECENCY * (c.lastSeenOrder / sessions) + // 최근에 본 단어일수록↑
    W_GOOD_FEWATTEMPTS * (1 / Math.max(1, c.total)); // 시도적음↑

  const toScored = (c: ReviewCandidate, score: number): ReviewScored => {
    // 자격 필터를 통과한 단어라 sources에 반드시 있다.
    const src = ctx.sources.get(c.word) as ReviewWordSource;
    return {
      candidate: c,
      score,
      question: {
        word: c.word,
        definitionEn: src.definitionEn,
        sourceBookId: src.sourceBookId,
        sourceDayWords: src.sourceDayWords,
      },
    };
  };

  const rank = (cands: ReviewCandidate[], score: (c: ReviewCandidate) => number): ReviewScored[] =>
    cands
      .map((c) => {
        const s = score(c);
        return { scored: toScored(c, s), key: s + jitter() }; // 동점만 rng로 흔듦
      })
      .sort((a, b) => b.key - a.key)
      .map((x) => x.scored);

  return { wrong: rank(wrongCands, scoreWrong), good: rank(goodCands, scoreGood) };
}

/**
 * 복습 세트를 고른다 — **틀린 풀 상위 4 + 잘한 풀 상위 1**(총 ≤5, 계획 §V6).
 *
 * 후보가 부족한 콜드 스타트는 graceful: 틀린 풀이 4 미만이면 있는 만큼, 잘한 풀이 비면 0개, 둘 다
 * 없으면 빈 배열(복습 없이 그 DAY 시험만). 반환은 각 복습 단어의 문제·보기 생성에 필요한 최소 정보다.
 *
 * @param candidates buildReviewCandidates 결과(전 DAY 누적)
 * @param ctx        필터·정규화 문맥(시험 페이지가 주입)
 * @param opts       뽑을 개수(기본 4+1)
 * @param rng        동점 흔들기용(선택) — 없으면 안정 정렬(결정적)
 */
export function selectReviewSet(
  candidates: readonly ReviewCandidate[],
  ctx: ReviewContext,
  opts: ReviewSelectOptions = {},
  rng?: Rng,
): ReviewQuestion[] {
  const wrongCount = Math.max(0, opts.wrongCount ?? REVIEW_WRONG_COUNT);
  const goodCount = Math.max(0, opts.goodCount ?? REVIEW_GOOD_COUNT);
  const { wrong, good } = rankReviewPools(candidates, ctx, rng);
  const picked = [...wrong.slice(0, wrongCount), ...good.slice(0, goodCount)];
  return picked.map((s) => s.question);
}

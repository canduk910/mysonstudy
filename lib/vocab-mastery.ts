/**
 * lib/vocab-mastery.ts — 오답노트 집계·졸업 순수 함수 (단어장 정복 V5, 계획 §V5)
 *
 * 시험 세션(V4, `VocabQuizRecord`)들을 **읽을 때** 단어별로 접어 "몇 번 풀었고(total) 몇 번
 * 틀렸고(wrong) 지금 몇 연속 맞혔나(streak)"를 만든다. 집계는 저장하지 않는다 — 세션이 늘 때마다
 * 다시 계산한다(계획 §V5). 이 파일은 그 계산을 **순수 함수만으로** 담아, 클라이언트(오답노트
 * 화면)·서버(재시험 풀 계산) 양쪽에서 안전하고 `scripts/eval-english.ts`가 실호출 없이 불변을 잠근다.
 *
 * ── 왜 입력 순서가 곧 streak의 뜻인가 ───────────────────────────────────────
 * streak(연속 정답)은 **시간 축**이 있어야 뜻이 선다. `listVocabQuizzes(bookId)`는 startedAt
 * **오름차순(오래된 순)**으로 세션을 준다(V4 계약). 이 함수는 그 순서를 **그대로 소비**한다 —
 * 재정렬하지 않는다. 세션을 순서대로 걸으며 각 단어의 시도를 이어 붙이면, 그 단어의 시도 이력이
 * 자연히 시간순이 된다. 그 이력의 **꼬리(가장 최근)부터** 연속으로 맞은 개수가 streak다.
 * 입력이 뒤섞이면 streak가 거짓이 되므로, 호출측은 반드시 startedAt 오름차순을 넘겨야 한다.
 *
 * ── 시도의 정의 ─────────────────────────────────────────────────────────────
 * "시도" = `answered === true`인 문항만이다. "그만하기"로 답하지 못한 문항(`answered: null`)은
 * 세션 레코드에는 남지만 시도가 아니다 — total·wrong·streak 어디에도 세지 않는다(V4 `VocabQuizItem`
 * JSDoc과 같은 규약). `correct`는 answered===true일 때만 뜻이 있다.
 */

import type { VocabQuizRecord } from "./store";

/**
 * 졸업 문턱 — **마지막 2회 연속 정답**이면 그 단어를 졸업(mastered)으로 본다(계획 §V5).
 * "연속 2회"라는 규칙이 두 곳(streak 계산·isMastered 판정)에 흩어지지 않도록 여기 한 곳에 둔다.
 */
export const MASTERY_STREAK = 2;

/** 단어 하나의 시험 집계 — 저장하지 않고 읽을 때 계산한다(계획 §V5). */
export interface WordStat {
  /** 시도 수 = answered===true인 문항 수(여러 세션 합산) */
  total: number;
  /** 오답 수 = answered===true && correct===false인 문항 수 */
  wrong: number;
  /** 가장 최근부터 연속 정답 수(시간순 이력의 꼬리에서). streak >= MASTERY_STREAK면 졸업 */
  streak: number;
}

/**
 * 시간순 정답 이력의 **꼬리에서** 연속 정답 수를 센다. 중간에 하나라도 틀리면 그 지점에서 멈춘다
 * (틀리면 streak가 0으로 리셋되는 뜻). streak 계산과 isMastered가 **같은 로직**을 보게 하는 단일 정의처.
 */
function trailingStreak(history: readonly boolean[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]) n += 1;
    else break;
  }
  return n;
}

/**
 * 그 단어의 **시도 이력**(시간순, answered===true인 문항의 정답 여부만)으로 졸업 여부를 판정한다.
 * 마지막 `MASTERY_STREAK`(2)회가 모두 정답이면 졸업. 시도가 2회 미만이면 아직 졸업 아님.
 *
 * 순수 함수·eval 대상. `WordStat.streak >= MASTERY_STREAK`와 **구성상 동치**다(둘 다 trailingStreak을
 * 본다) — 뷰는 집계된 streak로 판정하고(`isStatMastered`), eval은 이 함수로 이력을 직접 검증한다.
 *
 * @param history 시도별 정답 여부(true=맞힘). 시간순, answered===true인 문항만.
 */
export function isMastered(history: readonly boolean[]): boolean {
  return trailingStreak(history) >= MASTERY_STREAK;
}

/** 집계된 통계(streak)로 졸업 여부를 본다 — 뷰가 쓰는 얇은 서술자(isMastered와 동치). */
export function isStatMastered(stat: { streak: number }): boolean {
  return stat.streak >= MASTERY_STREAK;
}

/**
 * 시험 세션들을 단어별 통계로 접는다(계획 §V5의 핵심 순수 함수).
 *
 * **`quizzes`는 startedAt 오름차순이어야 한다**(listVocabQuizzes 계약). 이 함수는 순서를 바꾸지
 * 않고 그대로 걸으며 각 단어의 시도를 시간순으로 잇는다 — 그 순서가 streak의 뜻이기 때문이다.
 * 일반 시험이든 오답복습(mode)이든 **모드를 가리지 않고** 함께 센다(재시험이 streak를 밀어 올려
 * 졸업하는 경로가 성립해야 하므로). **단, `mode:"relation"`(관계 문제, V8) 세션은 제외한다** — 관계
 * 문항은 정의→단어와 다른 축이라 그 답을 def→word 숙련도로 세면 안 된다(P2 무오염).
 *
 * @param quizzes startedAt 오름차순 세션 목록(한 단어장 또는 여러 단어장 무관 — 호출측이 범위를 정한다)
 * @returns 단어 → { total, wrong, streak }. 한 번도 시도 안 된 단어는 키에 없다(호출측이 total===0로 채운다).
 */
export function aggregateWordStats(
  quizzes: readonly VocabQuizRecord[],
): Record<string, WordStat> {
  // 단어별 정답 이력을 **시간순으로** 쌓는다(세션 순서 = startedAt 오름차순을 그대로 소비).
  const histories = new Map<string, boolean[]>();
  for (const quiz of quizzes) {
    // 관계 문제(V8) 세션은 def→word 숙련도의 **다른 축**이라 제외한다 — 관계 문항의 답(연결된 상대
    // 단어)이 그 단어의 정의→단어 통계로 새어 들면 안 된다(P2 무오염). def-to-word·wrong-review만 센다.
    if (quiz.mode === "relation") continue;
    for (const item of quiz.items) {
      if (item.answered !== true) continue; // 시도 = answered===true인 문항만
      let h = histories.get(item.word);
      if (!h) {
        h = [];
        histories.set(item.word, h);
      }
      h.push(item.correct === true);
    }
  }

  const out: Record<string, WordStat> = {};
  for (const [word, history] of histories) {
    out[word] = {
      total: history.length,
      wrong: history.reduce((n, correct) => (correct ? n : n + 1), 0),
      streak: trailingStreak(history),
    };
  }
  return out;
}

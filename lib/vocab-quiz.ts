/**
 * lib/vocab-quiz.ts — 단어장 시험(V4) 순수 함수 + 상수 (계획 §V4)
 *
 * 시험은 **영영 정의(definitionEn)를 문제로 보여주고 영단어 5지선다**로 고른다. 오답 4개는
 * 같은 DAY의 다른 단어에서 뽑는다. 이 파일은 그 보기·문항을 만드는 **순수 함수만** 담는다 —
 * 부수효과·외부 의존이 없어 클라이언트(시험 화면)와 서버(게이트 판정) 양쪽에서 안전하고,
 * `scripts/eval-english.ts`가 실호출 없이 불변을 잠근다(§검증).
 *
 * ── 왜 rng 주입인가 ─────────────────────────────────────────────────────────
 * 셔플·랜덤을 `Math.random`에 직접 묶으면 테스트가 결과를 못 고정한다. 그래서 `rng`를 주입
 * 가능하게 열어, eval은 랜덤 없이(또는 결정적 rng로) **정답 포함·전부 상이·개수**만 검증한다.
 * 실행 시에는 기본값 `Math.random`이 그대로 쓰인다.
 *
 * ── 정의 불변과의 관계 ──────────────────────────────────────────────────────
 * 문제(definitionEn)는 저장된 값을 그대로 쓴다. 정의를 여기서 만들거나 바꾸지 않는다 —
 * 은우가 외운 정의와 시험 문제가 어긋나지 않도록(계획 §V3 정의 불변) 시험은 **소비만** 한다.
 */

/** 한 문항의 보기 수 — 정답 1 + 오답 4 = 5지선다 */
export const DEFAULT_CHOICE_COUNT = 5;

/**
 * 시험을 낼 수 있는 최소 단어 수(= 영영 정의가 있는 단어 수).
 * 5지선다라 정답 1 + 오답 4가 필요하고, 오답은 같은 DAY의 다른 단어라 최소 5개는 있어야
 * 문항 하나가 온전히 선다. 이보다 적으면 화면이 "먼저 정의를 만들어 주세요"로 막는다(§V4 게이트).
 */
export const MIN_QUIZ_WORDS = 5;

/**
 * 시험 모드 — 지금은 "영영 정의 → 영단어" 하나뿐이다(계획 §V4). 나중에 반대 방향(단어→정의)이
 * 생겨도 저장 레코드가 어느 모드였는지 남기도록 유니온으로 연다. 저장·요청·검증이 같은 상수를 본다.
 */
export const VOCAB_QUIZ_MODES = ["def-to-word"] as const;
export type VocabQuizMode = (typeof VOCAB_QUIZ_MODES)[number];

/** 랜덤 주입 시그니처 — `Math.random`과 같은 [0,1) 실수 생성기. 테스트가 결정적 rng를 넣는다. */
export type Rng = () => number;

/** 시험 문항 하나 (세션 시작 시 1회 조립). 정답 word·문제 definitionEn·셔플된 5지선다. */
export interface QuizQuestion {
  /** 정답 영단어(표제어) — 사용자가 골라야 하는 답 */
  word: string;
  /** 문제로 보여줄 영영 정의(저장값 그대로) */
  definitionEn: string;
  /** 5지선다(정답 포함, 셔플됨). DAY 단어가 부족하면 5개 미만일 수 있다 */
  choices: string[];
}

/** 시험 대상 단어 하나 — 정의가 있는(definitionEn !== null) 단어만 문제가 된다. */
export interface QuizPoolItem {
  word: string;
  definitionEn: string;
}

/**
 * Fisher-Yates 셔플 — rng 주입으로 테스트 결정성을 확보한다. 입력을 복제해 **순수하게** 반환한다.
 */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 한 문항의 5지선다를 만든다 — **정답 1 + 같은 DAY 오답 (count-1)개**, 전체 셔플.
 *
 * 불변(eval이 잠근다):
 * - (a) 정답은 **항상 포함**된다.
 * - (b) 보기는 **전부 서로 다르다**(중복 0) — 정답과 겹치는 오답, 오답끼리 겹침을 제거한다.
 * - (c) 정확히 `count`개. **단** 같은 DAY의 서로 다른 단어가 부족하면 가능한 만큼만(count 미만).
 *
 * @param correctWord 정답 영단어
 * @param dayWords    같은 DAY의 단어 목록(오답 후보. 정답·중복은 내부에서 걸러진다)
 * @param count       보기 수(기본 5)
 * @param rng         랜덤 주입(기본 Math.random)
 */
export function buildChoices(
  correctWord: string,
  dayWords: readonly string[],
  count = DEFAULT_CHOICE_COUNT,
  rng: Rng = Math.random,
): string[] {
  // 오답 후보 = 같은 DAY의 **다른** 단어. 정답과 중복 단어를 한 번에 걸러 (b)중복 0을 보장한다.
  const seen = new Set<string>([correctWord]);
  const distractorPool: string[] = [];
  for (const w of dayWords) {
    if (seen.has(w)) continue;
    seen.add(w);
    distractorPool.push(w);
  }
  // 셔플 후 앞에서 (count-1)개 — 후보가 부족하면 있는 만큼(=(c)의 예외).
  const distractors = shuffle(distractorPool, rng).slice(0, Math.max(0, count - 1));
  // 정답을 넣고 전체를 다시 섞어 정답 위치를 감춘다 — (a)정답은 항상 이 배열 안에 있다.
  return shuffle([correctWord, ...distractors], rng);
}

/**
 * 세션 문항 전체를 **1회** 조립한다(계획 §V4 "셔플은 세션 시작 1회").
 * 문제 순서도 셔플하고, 각 문항의 보기도 buildChoices로 만든다. 클라이언트는 이 결과를
 * 세션 내내 고정해 다시 섞지 않는다(틀린 문항 같은 세션 재출제 없음).
 */
export function buildQuizQuestions(
  pool: readonly QuizPoolItem[],
  dayWords: readonly string[],
  count = DEFAULT_CHOICE_COUNT,
  rng: Rng = Math.random,
): QuizQuestion[] {
  return shuffle(pool, rng).map((item) => ({
    word: item.word,
    definitionEn: item.definitionEn,
    choices: buildChoices(item.word, dayWords, count, rng),
  }));
}

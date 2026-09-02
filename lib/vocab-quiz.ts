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
 * 시험 모드 — 저장 레코드가 **어떤 판이었는지** 남기는 태그다. 방향은 지금 "영영 정의 → 영단어"
 * 하나뿐이라, 이 값은 사실상 **목적 축**을 구분한다(계획 §V4·§V5, V4 리포트가 예고한 용도):
 * - `"def-to-word"`  : 일반 시험(단어장 상세의 "시험 보기"). DAY의 정의 있는 단어 전체가 대상.
 * - `"wrong-review"` : 오답복습 재시험(오답노트의 "오답 다시 풀기"). 그 DAY의 틀린·미졸업 단어만 대상.
 * - `"relation"`     : **관계 문제**(유의어/반의어 연결, V8). 정의→단어와 **다른 축**이라 별도 세션 레코드로
 *                      저장한다 — 한 번 시험을 보면 정의→단어 문항은 def-to-word/wrong-review 레코드로,
 *                      관계 문항은 relation 레코드로 **갈라** 저장된다(같은 시각, 두 레코드).
 *
 * 집계(aggregateWordStats)는 def-to-word·wrong-review는 **모드를 가리지 않고** 함께 세지만(재시험이
 * streak를 밀어 올려 졸업하는 경로가 성립해야 하므로), **relation 레코드는 def→word 숙련도에서 제외**한다
 * — 관계 문항의 답(연결된 상대 단어)이 그 단어의 정의→단어 통계로 새어 들면 안 되기 때문이다(P2 무오염).
 * 저장·요청 zod·읽기 폴백이 모두 이 상수 하나를 본다(추가는 여기 배열 한 줄이면 세 곳에 함께 반영된다).
 */
export const VOCAB_QUIZ_MODES = ["def-to-word", "wrong-review", "relation"] as const;
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
  /**
   * 복습 리마인드(V6)로 다른 DAY에서 끼워 넣은 문항이면 true — 화면이 "복습" 배지를 붙인다.
   * 일반 시험 문항(buildQuizQuestions)은 이 필드를 두지 않는다(falsy). 채점·저장은 동일하다.
   */
  isReview?: boolean;
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

// ===========================================================================
// 관계 문제 시험 (유의어/반의어 연결) — buildRelationQuestions (V8, 관계 문제 신설)
//
// def-to-word 시험이 "정의 → 단어"라면, 관계 문제는 **"이 단어의 유의어(또는 반의어)는?"**을 묻고
// 같은 단어장 표제어 중에서 5지선다로 고른다. 대상은 **사용자가 직접 이은 관계(source:"user")뿐**이다
// — 교재 판독분(source:"book")·파생어(derivative)는 문제로 내지 않는다(연결 학습의 확인이 목적).
//
// 이 파일은 AI 스키마(lib/ai/*)에 의존하지 않는다(클라이언트·서버 공용, 무의존 규약 유지). 그래서
// 입력을 VocabEntry가 아니라 **구조적 최소 타입**(RelationSourceEntry)으로 받는다 — VocabEntry가
// 이 shape을 구조적으로 만족하므로 호출측은 그대로 entries를 넘긴다.
// ===========================================================================

/** 관계 문제로 낼 수 있는 관계 종류 — 유의어·반의어만(파생어 제외). */
export const RELATION_QUIZ_KINDS = ["synonym", "antonym"] as const;
export type RelationQuizKind = (typeof RELATION_QUIZ_KINDS)[number];

/** buildRelationQuestions가 읽는 관련어 최소 shape (VocabRelated가 구조적으로 만족). */
export interface RelationSourceRelated {
  kind: string;
  word: string;
  /** 연결 출처 — 관계 문제는 "user"만 대상 */
  source: string;
}

/** buildRelationQuestions가 읽는 뜻 최소 shape. */
export interface RelationSourceMeaning {
  ko: string;
  related: readonly RelationSourceRelated[];
}

/** buildRelationQuestions가 읽는 단어 최소 shape (VocabEntry가 구조적으로 만족). */
export interface RelationSourceEntry {
  word: string;
  meanings: readonly RelationSourceMeaning[];
}

/**
 * 관계 문제 한 문항. `kind:"relation"` 판별자로 def-to-word(QuizQuestion)와 구분된다.
 * - promptWord: 문제로 보여줄 표제어(이 단어의 유의어/반의어를 고른다)
 * - relationKind: 유의어(synonym)인지 반의어(antonym)인지 — 화면이 발문("~의 유의어는?")을 정한다
 * - meaningKo: 연결이 걸린 그 뜻의 한글 풀이(뜻이 여러 개일 때 어느 뜻 기준인지 문항에 보여준다)
 * - answer: 정답 영단어(= 연결된 상대 단어)
 * - choices: 5지선다(정답 포함·셔플). 같은 단어장 표제어에서 오답을 뽑는다
 */
export interface RelationQuizQuestion {
  kind: "relation";
  promptWord: string;
  relationKind: RelationQuizKind;
  meaningKo: string;
  answer: string;
  choices: string[];
  /** 복습 리마인드로 끼워 넣은 문항이면 true(QuizQuestion과 같은 관용구). 일반 문항은 falsy */
  isReview?: boolean;
}

/**
 * 세션 문항의 합집합 타입. 화면(세션 조립)이 def-to-word와 관계 문제를 한 배열로 섞어 낸다.
 * 순수 함수는 각 목록만 반환하고, **섞는 것은 뷰의 몫**이다(기존 buildQuizQuestions 시그니처 불변).
 */
export type SessionQuizQuestion = QuizQuestion | RelationQuizQuestion;

/** 세션 문항이 관계 문제인지 판별한다(QuizQuestion엔 kind가 없으므로 이 검사로 안전히 갈린다). */
export function isRelationQuestion(q: SessionQuizQuestion): q is RelationQuizQuestion {
  return (q as RelationQuizQuestion).kind === "relation";
}

/** kind가 관계 문제 대상(synonym/antonym)인지 — derivative를 제외하는 게이트. */
function isRelationQuizKind(kind: string): kind is RelationQuizKind {
  return kind === "synonym" || kind === "antonym";
}

/**
 * 사용자가 이은 유의어/반의어 연결마다 관계 문제 문항을 만든다.
 *
 * 각 entry의 각 meaning의 related 중 **source:"user"이고 kind가 synonym/antonym**인 것만 대상:
 *   promptWord=entry.word · relationKind=related.kind · meaningKo=meaning.ko · answer=related.word ·
 *   choices=buildChoices(related.word, dayWords, count) — dayWords는 이 단어장의 표제어들(entries.map(word)).
 *
 * 불변(eval이 잠근다):
 * - (a) 각 문항의 choices는 정답(answer)을 항상 포함하고 보기가 전부 서로 다르다.
 * - (b) source:"user"·synonym/antonym만 대상 — book·derivative는 제외된다.
 * - (c) meaningKo는 연결이 걸린 바로 그 뜻의 ko다.
 * - (d) 사용자 연결이 없으면 빈 배열.
 * - (e) dayWords가 부족하면 choices는 가능한 만큼(count 미만)이라도 정답을 포함한다(graceful).
 *
 * 상호 저장(양쪽 뜻에 기록)이라 A→B, B→A 두 문항이 자연히 나온다(양방향 연습 — 유지). 완전히 동일한
 * (promptWord, relationKind, answer) 문항만 중복 제거한다(meaningKo는 키에 넣지 않는다 — 명세대로).
 *
 * 문항 순서는 traversal 순서(결정적)로 두고, 섞는 것은 뷰가 한다(choices만 rng로 셔플).
 */
export function buildRelationQuestions(
  entries: readonly RelationSourceEntry[],
  count = DEFAULT_CHOICE_COUNT,
  rng: Rng = Math.random,
): RelationQuizQuestion[] {
  // 오답 후보 풀 = 이 단어장의 표제어들. 정답(연결 상대)도 표제어이므로 buildChoices가 정답을 자연히 다룬다.
  const dayWords = entries.map((e) => e.word);

  const out: RelationQuizQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const meaning of entry.meanings) {
      for (const rel of meaning.related) {
        // (b) 사용자가 이은 유의어/반의어만 — 교재 판독분·파생어는 건너뛴다
        if (rel.source !== "user") continue;
        if (!isRelationQuizKind(rel.kind)) continue;

        // 동일 (promptWord, relationKind, answer) 중복 제거 — 같은 상대를 두 뜻에서 이어도 문항 하나
        const dedupeKey = `${entry.word} ${rel.kind} ${rel.word}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        out.push({
          kind: "relation",
          promptWord: entry.word,
          relationKind: rel.kind,
          meaningKo: meaning.ko,
          answer: rel.word,
          choices: buildChoices(rel.word, dayWords, count, rng),
        });
      }
    }
  }
  return out;
}

/**
 * lib/ai/japanese/prompts.ts — 아빠의 일본어 호출 A(JLPT 단어 생성) 프롬프트 + 사용자 메시지 + 호출 옵션
 * (docs/harness/japanese.md §2-1·§2-2·§1-1)
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 영어 프롬프트의 "초등 눈높이·쉬운 말" 문구를 절대 베끼지 않는다. 성인 JLPT 학습자 기준으로,
 * 레벨이 요구하는 어휘·문법을 그 수준 그대로 쓴다(쉽게 풀어 등급을 낮추면 학습 목적이 깨진다).
 *
 * ── spec-sync ─────────────────────────────────────────────────────────────────
 * `JA_VOCAB_SYSTEM_PROMPT`·`JA_VOCAB_USER_TEMPLATE`는 docs/harness/japanese.md §2-1·§2-2 코드블록과
 * 바이트 단위로 일치해야 한다(scripts/eval-japanese.ts의 SPEC_SYNC_TARGETS가 대조). 문구를 고치면 스펙도 같이 고친다.
 */

import { JA_EXCLUDE_PROMPT_MAX, type JlptLevel } from "./schemas";

/** 호출 A 시스템 프롬프트 (§2-1 원문 그대로). §2-1의 요구사항 12개를 모두 만족한다. */
export const JA_VOCAB_SYSTEM_PROMPT = `너는 성인 한국인 JLPT 학습자를 돕는 일본어 교사다. 받은 JLPT 레벨의 실제 출제 어휘 수준에 맞는 단어를 골라 표기·읽기·품사·한국어 뜻·예문을 만든다. 학습자는 성인이다 — 아이 눈높이로 쉽게 낮추지 않는다.

[레벨]
- 받은 레벨(N1~N5)의 실제 출제 어휘 수준을 지킨다. N5에 N1 어휘를 넣거나 N1에 초급 어휘를 넣지 않는다.
- 주제에 맞는 어휘가 그 레벨에 부족하면 주제를 넓게 해석하되(예: 호텔 → 여행·숙박 전반) 레벨을 올려서 채우지 않는다.

[꼭 넣을 단어]
- 받은 '꼭 넣을 단어' 목록의 단어는 빠짐없이 결과에 넣는다. 표기만 받았어도 읽기·품사·뜻·예문·후리가나를 네가 채운다.
- 꼭 넣을 단어는 제외 목록('이미 가지고 있는 단어')보다 우선한다 — 제외에 있어도 꼭 넣을 단어에 있으면 넣는다.
- 받은 표기를 고치지 않는다(오타처럼 보여도 그대로 쓴다). 다만 명백한 활용형이면 사전형으로 정리하고 원래 형태를 예문에 자연스럽게 녹인다.

[개수]
- 전체 개수만큼 채운다. 꼭 넣을 단어가 N개면 새로 고르는 것은 (전체 개수 − N)개다. 꼭 넣을 단어만으로 개수가 차면 새로 고르지 않는다.

[주제]
- 주제를 받았으면 그 상황에서 실제로 쓰는 어휘로 고르고, 예문도 그 상황의 문장으로 쓴다.
- 주제를 못 받았으면(없음) 그 레벨 전반에서 고르게 고른다.

[제외 목록]
- '이미 가지고 있는 단어' 목록에 있는 단어는 표기가 같든 읽기가 같든 내지 않는다(꼭 넣을 단어에 있는 것은 예외).
- 활용형·파생형으로 우회하지 않는다(예: 제외에 約束가 있으면 約束する도 내지 않는다).

[고르는 법]
- 의미가 겹치는 유의어를 여러 개 채우지 않는다. 서로 다른 단어로 고른다.
- 품사가 한쪽으로 쏠리지 않게 고루 섞는다.

[표기 2축]
- word는 표기다 — 한자가 있으면 한자로 쓴다. kana는 전체 읽기다 — 히라가나만 쓴다. 가나로만 쓰는 단어는 word와 kana가 같다.
- 가타카나 외래어는 word에 가타카나, kana에 그 가타카나의 읽기(히라가나)를 쓴다.

[품사]
- 일본어 품사 체계로 고른다: 명사·동사(자)·동사(타)·い형용사·な형용사·부사·조사·접속사·감동사·표현. 영어나 한국어 품사 체계를 쓰지 않는다.

[뜻(한국어)]
- 그 단어가 실제로 쓰이는 핵심 뜻을 1~3개 한국어로 쓴다. 사전을 그대로 나열하지 말고 JLPT에서 요구되는 뜻 위주로 쓴다.

[예문]
- 각 단어마다 일본어 예문 1개와 그 한국어 번역 1개를 만든다.
- 예문은 그 레벨 학습자가 읽을 수 있는 길이(15~30자 정도)로 쓰고, 표제어를 자연스럽게 포함한다.
- 그 레벨보다 훨씬 어려운 문법을 예문에 넣지 않는다.

[후리가나]
- 표기(word)와 예문(example.ja)의 모든 한자에 읽기를 붙인다. 후리가나는 문자열 안에 끼워 넣지 말고 토큰 배열로 낸다.
- 각 토큰은 surface(표기 조각)와 reading(히라가나 읽기)을 갖는다. surface를 순서대로 이어 붙이면 원문과 정확히 같아야 한다.
- reading은 그 토큰의 surface가 한자만으로 이뤄졌을 때만 히라가나로 채운다. 가나·숫자·기호가 섞인 토큰에는 reading을 붙이지 않는다(null).
- 오쿠리가나와 활용 어미는 한자 토큰과 분리해 별도 토큰으로 내고 그 토큰의 reading은 null로 둔다. 한 단어를 통째로 묶어 전체 읽기를 달지 않는다. 예: 促す → 促(うなが) + す(null), 食べる → 食(た) + べる(null), 大きい → 大(おお) + きい(null).

[이모지]
- 각 단어에 그 뜻을 한눈에 떠올리게 하는 이모지 하나(imageEmoji)를 고른다. 이모지는 딱 1개다 — 여러 개를 이어 붙이지 않는다.
- 눈에 보이는 사물·동작이면 어울리는 이모지를 고른다. 추상어나 문법어(조사·접속사 등)처럼 어울리는 이모지가 없으면 null로 둔다. 억지로 고르지 않는다.

[금지]
- 사전 원문을 복사했다고 주장하거나 출처를 표기하지 않는다. 설명 문장이나 마크다운을 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.`;

/**
 * 호출 A 사용자 메시지 템플릿 (§2-2 원문 그대로). 플레이스홀더를 buildJaVocabUserMessage가 채운다.
 * 상수로 두어 spec-sync가 스펙 §2-2 코드블록과 바이트 대조한다(템플릿째로 잠근다).
 */
export const JA_VOCAB_USER_TEMPLATE = `레벨: {N1|N2|N3|N4|N5}
주제: {topic ?? "없음(레벨 전반)"}
개수: {count}
꼭 넣을 단어(표기 그대로, 읽기·뜻·예문은 네가 채운다): {include를 쉼표로, 없으면 "없음"}
이미 가지고 있는 단어(내지 말 것): {exclude를 쉼표로, 표기(읽기) 형태}`;

/** 제외 항목 한 쌍 — 표기(word)와 읽기(kana). 프롬프트에는 "표기(읽기)"로 적힌다. */
export interface JaExcludeItem {
  word: string;
  kana: string;
}

export interface JaVocabUserMessageInput {
  level: JlptLevel;
  /** 주제. 없으면 null(레벨 전반) */
  topic: string | null;
  /** 이 레벨 호출의 전체 개수(include 포함) */
  count: number;
  /** 꼭 넣을 단어(표기 목록). 이 레벨 호출에 배분된 것 */
  include: readonly string[];
  /** 누적 제외 목록. 오래된 것 → 최근 것 순으로 넘긴다(상한 초과 시 최근 것 우선으로 자른다) */
  exclude: readonly JaExcludeItem[];
}

/**
 * §2-2 사용자 메시지를 조립한다. 템플릿 상수의 플레이스홀더를 split/join으로 안전히 치환한다
 * (값에 `$`가 있어도 안전 — String.replace의 특수치환을 피한다).
 */
export function buildJaVocabUserMessage(input: JaVocabUserMessageInput): string {
  const topic = input.topic && input.topic.trim() !== "" ? input.topic.trim() : "없음(레벨 전반)";
  const includeText = input.include.length > 0 ? input.include.join(", ") : "없음";
  // 상한 초과 시 최근 것 우선(뒤쪽이 최근) — 저장 단계 재필터가 진짜 방어선이므로 프롬프트는 상한만 건다(§2-2).
  const capped = input.exclude.slice(-JA_EXCLUDE_PROMPT_MAX);
  const excludeText = capped.length > 0 ? capped.map((e) => `${e.word}(${e.kana})`).join(", ") : "없음";

  return JA_VOCAB_USER_TEMPLATE.split("{N1|N2|N3|N4|N5}").join(input.level)
    .split('{topic ?? "없음(레벨 전반)"}').join(topic)
    .split("{count}").join(String(input.count))
    .split('{include를 쉼표로, 없으면 "없음"}').join(includeText)
    .split("{exclude를 쉼표로, 표기(읽기) 형태}").join(excludeText);
}

/**
 * 호출 A 파라미터 (§1-1).
 * temperature 0.4 — 어휘 선정은 창작이되 등급 정확성이 우선이라 낮게 둔다. 추론형 모델은 callWithSchema가 temp를 자동 생략.
 * maxOutputTokens 8,000 — 10개 × (표기·읽기·품사·뜻 + 예문 + 후리가나 토큰 배열 2개)로 토큰이 붙는다.
 * 후리가나 토큰이 한자마다 늘어 판독보다 길어질 수 있어 카드(6,000)보다 여유를 준다.
 */
export const JA_VOCAB_CALL_OPTIONS = {
  call: "ja-vocab",
  temperature: 0.4,
  maxOutputTokens: 8_000,
} as const;

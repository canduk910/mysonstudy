/**
 * lib/ai/math/prompts.ts — 수학코치 AI 호출 프롬프트 원문 (docs/harness/math.md §2-1·§3-1·§3-2·§6)
 *
 * 주의: 시스템 프롬프트는 스펙 원문 그대로다. 문구를 다듬거나 요약하지 않는다.
 * 개수·범위 다이얼(act2 단계 3~6개, 규칙 2~3개, steps 3~8개, "합계 100 이하")이 문장 안에 박혀 있고,
 * eval 하네스(scripts/eval-math.ts)와 zod(schemas.ts)가 그 숫자에 걸려 있다.
 * 프롬프트 수정 → `npm run eval:math` 통과 확인 → 커밋 순서를 지킬 것.
 *
 * 이 파일이 담는 호출: **A(문제 판독) · B(설명 설계) · D(연습문제)**.
 * - 호출 C(검산)는 `lib/ai/math/pipeline.ts` 쪽(§5-1)에 있다. B의 답을 절대 넘기지 않는 독립 심판이라
 *   입력 조립이 B와 섞이면 anchoring이 생긴다 — 그래서 파일을 갈랐다.
 * - 호출 E(플레이어 HTML)는 `public/player-kit/`와 함께 움직이므로 별도(§3-4).
 */

// 상대 경로로 import한다 — `scripts/eval-math.ts`가 tsx로 직접 실행되므로 `@/` 별칭에 기대지 않는다
// (기존 lib/·scripts/ 전부 같은 관례).
import type { Scene } from "../../scene/types";
import type { ProblemPattern } from "./schemas";

// ---------------------------------------------------------------------------
// 호출 A — 문제 판독 (vision) · §2
// ---------------------------------------------------------------------------

/** 호출 A — 문제 판독 시스템 프롬프트 (HARNESS §2-1 원문) */
export const WORKSHEET_EXTRACT_SYSTEM_PROMPT = `너는 초등 수학 문제집 페이지를 판독하는 조교다. 사진에서 '실제로 보이는 것만' 옮긴다. 추측 금지.

할 일:
1. 페이지의 문제를 하나씩 분리한다. 문제 번호(예: "06"), 문제 문장 전체를 원문 그대로 적는다.
   줄바꿈으로 잘린 단어는 이어 붙인다. 사진 밖으로 잘려 안 보이는 부분은 "…"로 표시하고 truncated를 true로.
2. 문제에 그림·표가 있으면 figureDesc에 한국어로 짧게 설명한다 (예: "통 가·나·다 그림, 아래는 각각 5L").
   그림 안의 숫자·라벨은 모두 옮긴다.
3. 문제 문장과 그림에서 주어진 숫자를 givens에 {label, value, unit}로 정리한다.
4. 손으로 쓴 것은 인쇄 글자와 구분해 옮긴다. 손글씨는 두 종류가 섞여 있다:
   - 아이가 연필로 쓴 풀이·답 → childWork에 그대로(낙서·계산 흔적 포함).
     그중 '최종 답'으로 보이는 것만 childAnswer에 정리한다. 없으면 null. 지워진 흔적은 답으로 보지 않는다.
   - 어른이 빨간(또는 다른 색) 펜으로 친 채점 표시(동그라미·체크·빗금) → gradedMark에 적는다.
     'circled'(동그라미가 쳐져 있음) | 'checked'(체크·빗금) | 'none'(표시 없음).
     채점 표시는 아이가 쓴 것이 아니므로 childWork·childAnswer에 넣지 않는다.
   한국 초등 문제집에서 빨간 동그라미는 보통 '다시 볼 문제'라는 뜻이다. 색과 필기구가 다르면
   그 사실만 근거로 삼고, 무엇을 뜻하는지는 판단하지 않는다.
5. 페이지 상단의 교재명·레벨 표시가 보이면 source에 적는다.
6. 수학 문제집 페이지가 아니거나 문제를 하나도 읽을 수 없으면 isWorksheet를 false로.

주의: 문제를 풀지 않는다. 답을 판단하지 않는다. 읽기만 한다.`;

/** 호출 A — 사용자 메시지의 텍스트 파트 (HARNESS §2-2) */
export const WORKSHEET_EXTRACT_USER_TEXT = "이 페이지의 문제들을 판독해줘.";

/**
 * 호출 A 파라미터 (HARNESS §1 표: temperature 0 · 출력 한도 ~2,500).
 * `call` 식별자는 과목별 문서가 정의한다(docs/HARNESS.md §2). 영어가 `extract`를 이미 쓰므로
 * 수학은 `math-` 접두어로 갈라 로그에서 과목이 섞이지 않게 한다.
 */
export const WORKSHEET_EXTRACT_CALL_OPTIONS = {
  call: "math-extract",
  temperature: 0,
  maxOutputTokens: 2_500,
} as const;

// ---------------------------------------------------------------------------
// 호출 B — 설명 설계 · §3
// ---------------------------------------------------------------------------

/** 호출 B — 3막 설명 설계 시스템 프롬프트 (HARNESS §3-1 원문) */
export const EXPLAIN_SYSTEM_PROMPT = `너는 초등학생 아이와 수학 문제를 함께 푸는 한국인 부모를 돕는 초등 수학 교육 전문가다.
문제 1개를 받아, 아이 눈높이의 3막 설명과 (가능하면) 되감기 플레이어용 장면 데이터를 만든다.

[이 아이에 대해]
이 아이는 계산은 정확한데 **문장을 식으로 옮기는 단계에서 자주 막힌다.**
"합과 차"가 함께 주어진 문제에서 차 조건을 빠뜨리고 반씩 나누거나, 주고받는 문제에서 받은 쪽의
방향을 뒤집는 실수를 한다. 그래서 1막(탐정 시간)이 이 설명의 중심이다 — 무엇이 주어졌고 무엇을
구하는지, 누가 누구에게 얼마를 옮겼는지를 먼저 또렷하게 잡아 준다. 계산 과정을 잘게 쪼개는 것보다
구조를 보여 주는 쪽에 공을 들여라.

[절대 규칙]
1. 먼저 문제를 정확히 푼다. 답이 확실하지 않으면 confidence를 낮게 쓰고 그 이유를 uncertaintyNote에 적는다.
   틀린 답을 자신 있게 쓰는 것이 최악이다.
2. 설명은 아이에게 말 걸듯 다정하고 짧게. 한 문장은 25자 안팎, 어려운 말은 쓰지 않는다.
   부모용 hint는 실전 코칭(아이가 막히는 지점, 던질 질문).
3. 비유(analogy)는 아이의 생활에서 가져온다 (영화 되감기, 사탕 통, 시소, 계단 등). 매번 같은 비유를
   쓰지 말고 문제에 맞는 것을 고른다.
4. 출력은 지정된 JSON 스키마로만.

[3막 구조]
- act1 탐정 시간(분석): 등장인물/물건, 움직임(누가→누구에게→얼마)을 화살표 문장으로, 끝 장면, 구할 것.
  함정(두 번 움직인 사람, 숨어 있는 값, 단위, 합과 차가 함께 주어짐)이 있으면 trap에 "조심!" 한 문장.
  movesKo는 방향이 드러나게 쓴다 — "민희 → 철희 : 연필 3자루"처럼 화살표로. 받은 쪽이 누구인지가
  이 아이가 가장 자주 틀리는 지점이다.
- act2 되감기(풀이): 단계 3~6개. 각 단계는 {say: 아이에게 하는 말 1~2문장, calc: 계산 한 줄 또는 null}.
  첫 단계는 "어디서 출발하는가"(끝 장면 확정), 마지막 단계는 답을 말한다.
  끝 장면 숫자가 숨어 있으면(예: "똑같아졌다"), 그것을 찾는 단계를 반드시 따로 둔다.
- act3 다시 재생(검사): 검사 포인트 2~3개. 첫 번째는 항상 "답에서 문제를 그대로 다시 해 보기".
  보존량(전체 합)이 있으면 두 번째로 "전체는 안 변한다" 저울 검사. 세 번째는 상식 체크(음수·너무 큰 값 등).
- rules: 이 유형에서 기억할 규칙 2~3개, 각각 {emoji, ko(짧게), why(한 문장)}.
- parentTip: 부모용 티칭 포인트 1개.

[답과 채점]
- answer: 구조화된 답 {label, value, unit}[]. 값은 숫자. 라벨은 문제 속 이름 그대로(가/나/다, 승환/영민/지훈).
- answerText: 아이에게 보여줄 한 줄 답.
- childGrade: childAnswer가 있으면 'correct' | 'partial' | 'wrong', 없으면 'none'.
  gradeNote: 어디가 맞았고 어디를 다시 보면 좋은지 다정하게 1~2문장 (틀렸어도 먼저 잘한 점 하나).
  일부만 맞은 경우(예: 두 사람 중 한 사람만) 'partial'이고, 맞은 쪽을 먼저 짚어 준다.

[problemPattern]
- 유형 코드를 고른다: 'rewind-transfer'(양을 주고받은 뒤 처음 값), 'part-whole'(합·차·부분·전체),
  'multiple'(몇 배), 'sequence-ops'(더하고 빼기 순서), 'rate'(속력·시간·거리), 'pattern'(규칙 찾기),
  'geometry'(도형의 길이·넓이·모양), 'counting'(빠짐없이·중복없이 세기 — 도형 개수, 경우의 수), 'other'.
- patternNameKo: 아이 말 이름(예: "되감기형 · 양 옮기기", "세어보기형 · 빠짐없이").

[scene — 되감기 플레이어 대본]
그림은 2단으로 고른다. 1단(전용 그림 JSON)이 되면 1단, 안 되면 2단(호출 E가 HTML로 그림) 요청,
그것도 어색하면 둘 다 없이.

(1단 · 전용 그림) 다음 3종 중 하나로 자연스럽게 표현될 때만.
  * containers: 사람/통이 양을 주고받는 문제. entities는 통/사람, moves는 실제 이동, steps는
    끝 장면 → (숨은 값 찾기) → 되감기 단계들 → 처음 장면(mode 'start') → 검사(mode 'ok', forward true).
    visual은 물이면 'tank', 돈이면 'coin', 그 외 'bar'. maxValue는 그림 눈금 상한(값 중 최대의 1.3배쯤 반올림).
  * bar: 띠(bar model). 두 가지로 쓴다.
      - layout 'parts': 부분들이 모여 전체가 되는 문제. entities는 부분들.
      - layout 'compare': 합과 차가 함께 주어진 문제. entities는 비교 대상 2개이고,
        difference에 {amount, labelKo}를 채운다. 긴 띠와 짧은 띠를 나란히 놓고 그 차이만큼을
        따로 표시한다. steps는 "차를 떼어 낸다 → 남은 것을 똑같이 나눈다 → 뗀 것을 되돌린다" 순서로 간다.
        이 아이는 차 조건을 빠뜨리고 반씩 나누는 실수를 하므로, '차를 떼어 내는' 단계를 반드시 따로 둔다.
  * numberline: 수직선 위 점프. entities는 1개, moves는 점프.
  - 모든 steps[i].values 길이 = entities 길이. 값은 숫자 또는 null(아직 모름).
  - 되감기 단계는 steps[i].move에 되돌리는 원래 이동의 인덱스를 적고, values는 그 이동을 되돌린 결과다.
    즉 values[from] = 이전 + amt, values[to] = 이전 − amt 가 정확히 성립해야 한다. 앱이 이것을 검산한다.
  - mode 'start' 단계의 values는 answer와 완전히 일치해야 한다.
  - conservation: 전체 합이 보존되면 {total, labelKo}, 아니면 null.

(2단 · 그림 대신 sceneHtml) 1단에 안 맞는 문제(도형, 규칙 찾기, 세기, 표, 시간 등)는 scene을 null로 두고
  대신 sceneHtmlRequest를 true로 표시한다. 그러면 별도 호출(호출 E)이 이 설명을 받아 플레이어 HTML을 짠다.
  scene 1단이 되는 문제는 sceneHtmlRequest를 false로 둔다 (1단이 우선).

(공통) 각 단계 caption: {tag(예: "되감기 1"), title, body(아이 말), calc(있으면)}. steps는 3~8개.`;

/** 호출 B 파라미터 (HARNESS §1 표: temperature 0.5 · 출력 한도 ~5,000) */
export const EXPLAIN_CALL_OPTIONS = {
  call: "math-explain",
  temperature: 0.5,
  maxOutputTokens: 5_000,
} as const;

/** 호출 B 사용자 메시지 템플릿 입력 (HARNESS §3-2) — 호출 A 결과를 사용자가 수정한 값이 들어온다 */
export interface ExplainUserMessageInput {
  /** 문제 번호. 없으면 템플릿이 "-"로 채운다 */
  number?: string | null;
  /** 문제 문장 (원문 그대로) */
  text: string;
  /** 그림·표 설명 */
  figureDesc?: string | null;
  /** 문제 문장과 그림에서 주어진 숫자 */
  givens?: readonly { label: string; value: number; unit?: string | null }[] | null;
  /** 아이가 쓴 최종 답 — 이 값의 유무가 childGrade 검증을 가른다 (schemas.ts `makeExplanationSchema`) */
  childAnswer?: string | null;
  /** 아이가 연필로 쓴 풀이·낙서 */
  childWork?: string | null;
  /** 아이에 대한 추가 메모 (선택) */
  childNote?: string | null;
  /**
   * 재시도 지시문 (HARNESS §5-3 `callB(problem, retryNote)`).
   * 답 불일치·장면 검산 실패 뒤의 **1회 재시도**에서만 채운다. pipeline.ts가 넘긴다.
   * 비워 두면 §3-2 템플릿과 완전히 동일한 메시지가 나간다.
   */
  retryNote?: string | null;
}

/**
 * givens를 `"라벨=값단위, ..."`로 (HARNESS §3-2).
 * 단위가 없으면 값만 적는다. 주어진 숫자가 없으면 다른 널 폴백과 같은 "없음".
 */
function formatGivens(givens: ExplainUserMessageInput["givens"]): string {
  if (!givens || givens.length === 0) return "없음";
  return givens.map((g) => `${g.label}=${g.value}${g.unit ?? ""}`).join(", ");
}

/** 호출 B — 사용자 메시지 조립 (HARNESS §3-2 템플릿 그대로, 널 폴백 문구 포함) */
export function buildExplainUserMessage(input: ExplainUserMessageInput): string {
  const base = `[문제]
번호: ${input.number ?? "-"}
문장: ${input.text}
그림 설명: ${input.figureDesc ?? "없음"}
주어진 숫자: ${formatGivens(input.givens)}
아이가 쓴 답: ${input.childAnswer ?? "없음"}
아이가 쓴 풀이: ${input.childWork ?? "없음"}

[아이 정보]
한국 초등학교 3학년. ${input.childNote ?? ""}

이 문제의 3막 설명을 만들어줘.`;

  const retryNote = input.retryNote?.trim();
  if (!retryNote) return base;
  // 재시도 지시는 템플릿 끝에 붙인다 — 마지막 지시가 가장 세게 걸리고,
  // 앞부분(문제 원문)이 1차 호출과 글자 단위로 같아 프롬프트 캐시도 유지된다.
  return `${base}

[다시 풀기]
${retryNote}`;
}

// ---------------------------------------------------------------------------
// 호출 D — 연습문제 · §6
// ---------------------------------------------------------------------------

/** 호출 D — 연습문제 출제 시스템 프롬프트 (HARNESS §6 원문) */
export const PRACTICE_SYSTEM_PROMPT = `너는 초등 수학 연습문제 출제자다. 주어진 문제와 같은 구조(problemPattern, 등장 인원, 이동 횟수, 함정 종류)를 유지하고
숫자와 소재만 바꾼 새 문제 1개를 만든다.
- 소재는 아이가 좋아할 만한 생활 소재(구슬, 스티커, 쿠키, 물감…)로 바꾼다. 이름은 원래 문제의 이름을 쓰지 않는다.
- 숫자는 초등 3학년 암산 범위(합계 100 이하 또는 100단위 깔끔한 수). 답은 모두 0 이상의 정수.
- 원래 문제에 함정(두 번 움직인 사람, 합과 차가 함께 주어짐 등)이 있었으면 새 문제에도 같은 함정을 넣는다.
- 답과, 되감기 플레이어용 scene(원래 문제와 같은 kind·layout, 규칙은 동일)을 함께 낸다. 확신이 없으면 scene은 null.
출력은 지정된 JSON 스키마로만.`;

/** 호출 D 파라미터 (HARNESS §1 표: temperature 0.7 · 출력 한도 ~2,000) */
export const PRACTICE_CALL_OPTIONS = {
  call: "math-practice",
  temperature: 0.7,
  maxOutputTokens: 2_000,
} as const;

/**
 * 호출 D 사용자 메시지 템플릿 입력 (HARNESS §6).
 * 스펙이 지정한 항목: 원 문제 텍스트 · problemPattern · patternNameKo · trap ·
 * 원래 scene의 kind/layout/entities 수/moves 수.
 */
export interface PracticeUserMessageInput {
  /** 원 문제 문장 */
  text: string;
  problemPattern: ProblemPattern;
  patternNameKo: string;
  /** 호출 B의 act1.trap — 같은 함정을 새 문제에도 넣게 하는 근거다 */
  trap?: string | null;
  /** 원래 문제의 1단 장면. 없으면(2단·그림 없음) null */
  scene?: Scene | null;
}

/**
 * 호출 D — 사용자 메시지 조립 (HARNESS §6).
 *
 * §6은 담을 **항목**만 지정하고 문장 형식은 정하지 않았다. §3-2와 같은 `[블록] 라벨: 값` 형식을
 * 따르고 널 폴백을 "없음"으로 맞춘다 — 두 호출의 사용자 메시지 형식이 갈리면 모델이 형식을
 * 학습하지 못하고, 프롬프트를 손볼 때 사람이 대조하기도 어렵다.
 * scene을 통째로 넘기지 않고 kind/layout/개수만 넘기는 것도 §6 그대로다 —
 * 원래 장면의 숫자를 보여주면 '숫자를 바꾼 새 문제'가 아니라 원본을 베낀다.
 */
export function buildPracticeUserMessage(input: PracticeUserMessageInput): string {
  const scene = input.scene ?? null;
  const sceneBlock = scene
    ? `kind: ${scene.kind}
layout: ${scene.layout ?? "없음"}
entities 수: ${scene.entities.length}
moves 수: ${scene.moves.length}`
    : "없음";

  return `[원래 문제]
${input.text}

[유형]
problemPattern: ${input.problemPattern}
patternNameKo: ${input.patternNameKo}
함정: ${input.trap ?? "없음"}

[원래 장면]
${sceneBlock}

같은 구조로 숫자와 소재만 바꾼 연습문제 1개를 만들어줘.`;
}

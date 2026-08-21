/**
 * lib/ai/math/prompts.ts — 수학코치 AI 호출 프롬프트 원문 (docs/harness/math.md §2-1·§3-1·§3-2·§6)
 *
 * 주의: 시스템 프롬프트는 스펙 원문 그대로다. 문구를 다듬거나 요약하지 않는다.
 * 개수·범위 다이얼(act2 단계 3~6개, 규칙 2~3개, steps 3~8개, insight 2~3단계, "합계 100 이하")이 문장 안에 박혀 있고,
 * eval 하네스(scripts/eval-math.ts)와 zod(schemas.ts)가 그 숫자에 걸려 있다.
 * 프롬프트 수정 → `npm run eval:math` 통과 확인 → 커밋 순서를 지킬 것.
 *
 * 이 파일이 담는 호출: **A(문제 판독) · B(설명 설계) · D(연습문제) · E(플레이어 HTML)**.
 * - 호출 C(검산)는 `lib/ai/math/pipeline.ts` 쪽(§5-1)에 있다. B의 답을 절대 넘기지 않는 독립 심판이라
 *   입력 조립이 B와 섞이면 anchoring이 생긴다 — 그래서 파일을 갈랐다.
 * - 호출 E(플레이어 HTML)는 §1 파일 배치대로 여기 둔다(few-shot HTML 포함). 실행은
 *   `lib/ai/math/player.ts`, 결과 검사·iframe 조립은 `lib/scene/html.ts`다.
 *   **E 프롬프트 [내용] 절의 Kit 함수 이름과 `public/player-kit/kit.js`는 같은 커밋에서 움직인다.**
 */

// 상대 경로로 import한다 — `scripts/eval-math.ts`가 tsx로 직접 실행되므로 `@/` 별칭에 기대지 않는다
// (기존 lib/·scripts/ 전부 같은 관례).
import { imagePart, textPart, type UserContentPart } from "../client";
import type { Scene } from "../../scene/types";
import { IMAGE_DATA_URL_PATTERN } from "../../upload-limits";
import type { Explanation, ProblemPattern } from "./schemas";

// ---------------------------------------------------------------------------
// 문제 사진 파트 — 호출 A·B·C가 공유한다 (§12)
//
// [M6] 사진을 보는 것이 호출 A 하나뿐이던 시절에는 이 코드가 `extract.ts` 안에만 있었다.
// 이제 B·C도 같은 사진을 받으므로(§12-2) **판정처를 하나로 모은다** — 형식 검사가 호출마다
// 따로 살면 "A는 통과했는데 B에서 400"처럼 갈라진다.
// ---------------------------------------------------------------------------

/**
 * 영어 `/api/extract` 라우트의 zod 검사와 같은 형식 — base64 data URL만 받는다.
 *
 * **정의는 `lib/upload-limits.ts`에 있다**(QA P3-1). 이 모듈은 `../client`를 통해 `openai` SDK를
 * 끌어오므로, 클라이언트가 프리플라이트 형식 검사를 하려고 여기를 import하면 SDK가 번들에 딸려 온다.
 * 길이 상한(`MAX_IMAGE_DATA_URL_CHARS`)과 같은 파일에 두어 사진 검사 두 축을 한 곳에서 본다.
 *
 * 이 이름은 **별칭으로 남긴다** — 수학 두 라우트(`/api/math/extract`·`/api/math/explain`)가
 * 이 이름으로 import하고 있고, 라우트 파일은 app-builder 소관이다. 그쪽이 `lib/upload-limits.ts`를
 * 직접 보게 바뀌면 이 재수출은 지워도 된다.
 */
export { IMAGE_DATA_URL_PATTERN as MATH_IMAGE_DATA_URL_PATTERN } from "../../upload-limits";

/**
 * data URL 형식 검사. **vision 호출이라 이미지 토큰이 붙으므로 호출 전에 막는다** —
 * 형식이 틀리면 어차피 API가 400을 내고, 그 전에 여기서 이유가 분명한 오류를 던지는 편이 낫다.
 */
export function assertImageDataUrl(dataUrl: string, call: string): void {
  if (!IMAGE_DATA_URL_PATTERN.test(dataUrl)) {
    throw new Error(`[ai:${call}] imageDataUrl은 "data:image/…;base64,…" 형식이어야 합니다.`);
  }
}

/**
 * 사용자 메시지의 **사진 파트** (없으면 빈 배열).
 *
 * 사진은 선택이다(§12-4) — `/math/new`(직접 입력)와 저장된 기록의 "다시 만들기"에는 사진이 없고,
 * 그 경로는 지금까지와 똑같이 텍스트만으로 돈다. 그래서 널이면 **파트를 아예 만들지 않는다**:
 * 빈 이미지 파트를 끼우면 사진 없는 요청의 메시지가 예전과 달라진다.
 *
 * **형식이 틀린 값은 조용히 버리지 않고 던진다.** 사진을 버리면 호출 C만 눈이 멀 수 있고
 * (B는 통과, C는 실패), 그러면 §12-2가 막으려던 "근거가 달라서 지는 검산"이 그대로 재현된다.
 * 없는 것과 잘못된 것은 다른 사건이다.
 */
export function problemImageParts(
  imageDataUrl: string | null | undefined,
  call: string,
): UserContentPart[] {
  const dataUrl = imageDataUrl?.trim();
  if (!dataUrl) return [];
  assertImageDataUrl(dataUrl, call);
  // `imagePart()`가 붙이는 `detail: "high"`가 여기서도 그대로 필요하다 — 읽어야 하는 것이
  // 점판의 점, 보조선, 각도 표시처럼 작은 그림 요소다(§12-1).
  return [imagePart(dataUrl)];
}

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

[문제 사진]
사진이 함께 오면 **그것이 그림의 진짜 근거다.** 그림 설명 한 줄보다 사진을 우선한다.
도형·표·점판·보조선·색칠된 부분·각도 표시는 사진에서 직접 읽는다.
다만 [문제]의 문장·숫자는 사람이 고쳤을 수 있다. 문장의 숫자·조건은 문장을 따르고,
사진은 그림을 읽는 데 쓴다.
사진에 여러 문제가 있으면 [문제]의 번호에 해당하는 것만 본다. 번호가 "-"이면
[문제]의 문장과 같은 문제를 찾아본다. 다른 문제를 섞지 마라.
사진이 없으면 그림 설명만으로 푼다.

[절대 규칙]
1. 먼저 문제를 정확히 푼다. 답이 확실하지 않으면 confidence를 낮게 쓰고 그 이유를 uncertaintyNote에 적는다.
   틀린 답을 자신 있게 쓰는 것이 최악이다.
2. 설명은 아이에게 말 걸듯 다정하고 짧게. 한 문장은 25자 안팎, 어려운 말은 쓰지 않는다.
   부모용 hint는 실전 코칭(아이가 막히는 지점, 던질 질문).
   글 안에서 보호자를 부를 때는 "엄빠"라고 쓴다. "아빠"나 "엄마"로 한쪽만 부르지 않는다.
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

[다른 방법 — insight]
정석(3막)과 **다른 길**로도 풀리는 문제라면, 그 방법을 insight에 담는다.
- 통찰은 "왜 그렇게 되는지 한 번에 보이는" 방법이다. 대칭, 전체에서 빼기, 짝지어 더하기,
  차를 먼저 떼어 내기, 거꾸로 세기 같은 것이다.
- **stepsKo는 2~3단계이고 act2보다 반드시 짧아야 한다.** 길면 그것은 통찰이 아니라 또 다른 정석이다.
- **한 단계는 60자를 넘기지 마라.** 넘으면 단계를 늘리지 말고 문장을 줄인다.
- **억지로 만들지 마라.** 정석이 곧 가장 빠른 길인 문제가 많다. 그럴 때는 insight를 null로 둔다.
  없는 지름길을 지어내면 아이가 그 억지 논리를 그대로 배운다.
- insight.answer에는 이 방법으로 나온 답을 적는다. 3막의 answer와 같아야 한다.
  다르면 둘 중 하나가 틀린 것이니, 그때는 문제를 다시 풀어 두 답을 맞춘다.
- parentNoteKo에는 이 방법이 언제 통하고 언제 안 통하는지를 부모에게 한두 문장으로 적는다.

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

/**
 * 호출 B 파라미터 (HARNESS §1 표: temperature 0.5 · 출력 한도 ~6,500).
 * [M5] 한도를 5,000 → 6,500으로 올렸다 — 두 번째 풀이(`insight`)가 같은 호출에 함께 실린다(§10-3).
 * 한도를 되돌리면 `insight`가 붙는 응답이 `incomplete`로 잘려 재요청 1회를 태우고, 그래도 잘리면 throw다.
 */
export const EXPLAIN_CALL_OPTIONS = {
  call: "math-explain",
  temperature: 0.5,
  maxOutputTokens: 6_500,
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
   * 문제집 페이지 사진 (base64 data URL · 선택 · §12).
   *
   * **호출 A가 판독할 때 쓴 사진을 그대로 넘긴다.** 문제 영역만 잘라 보내지 않는 이유는
   * §12-3이다 — 크롭 좌표가 조금만 어긋나면 도형의 일부가 잘려 나가는데, 그림이 필요해서
   * 넣는 기능이 그림을 훼손하게 된다. 페이지 전체를 보내고 템플릿의 `번호:` 필드가 어느
   * 문제인지 지목한다(프롬프트 `[문제 사진]` 절이 "번호에 해당하는 것만 본다"고 못 박는다).
   * `number`가 널이면 그 필드는 `번호: -`가 되므로 지목이 풀린다 — 그래서 같은 절이
   * "번호가 `-`이면 [문제]의 문장과 같은 문제를 찾아본다"는 폴백을 함께 준다(§12-3).
   *
   * 없으면 null — 직접 입력(`/math/new`)과 저장된 기록의 "다시 만들기"가 그 경로다.
   * 사진은 저장하지 않으므로(§9-1) 기록에서 되살린 문제에는 사진이 없다.
   *
   * **이 값은 텍스트 메시지에 한 글자도 나타나지 않는다** — `buildExplainUserMessage()`의
   * 출력은 사진 유무와 무관하게 같고, 사진은 `buildExplainUserParts()`가 별도 파트로 싣는다.
   */
  imageDataUrl?: string | null;
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

/**
 * 호출 B — 사용자 메시지 **파트 배열** (사진 + 텍스트 · §12-5).
 *
 * 호출 A(`extract.ts`)·영어 표지 판독(`extractBook`)과 **같은 관례**다: 이미지 파트를 먼저,
 * 지시 텍스트를 나중에 싣는다. 새 방식을 만들지 않았다 — 세 호출이 같은 모양이어야
 * "사진을 어떻게 싣더라"를 매번 다시 정하지 않는다.
 *
 * **사진이 없으면 결과는 `[textPart(buildExplainUserMessage(input))]` 한 개다** —
 * 지금까지 나가던 메시지와 **글자 단위로 같다**(§12-4). 기존 픽스처가 그대로 통과하는 것이
 * 그 증거이고, eval O10이 두 갈래를 스텁으로 실증한다.
 */
export function buildExplainUserParts(input: ExplainUserMessageInput): UserContentPart[] {
  return [
    ...problemImageParts(input.imageDataUrl, EXPLAIN_CALL_OPTIONS.call),
    textPart(buildExplainUserMessage(input)),
  ];
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

// ---------------------------------------------------------------------------
// 호출 E — 플레이어 HTML 생성 (2단) · §3-4
//
// 이 호출만 **출력이 JSON이 아니라 HTML 문자열**이다(Structured Outputs로 {html, stepCount}에 감싸 받는다).
// 그리고 이 앱에서 유일하게 **AI가 짠 코드를 실제로 실행**한다. 그래서 두 겹으로 막는다:
//   1차 — iframe 격리(sandbox에 allow-same-origin 없음 + CSP default-src 'none')
//   2차 — 정적 검사 금지 문자열 + 답 태그 대조 (lib/scene/html.ts)
// **순서를 뒤집지 마라.** 프롬프트와 금지 목록은 "명백한 것을 일찍 걸러 재생성 기회를 주는" 그물이지
// 안전을 보증하는 물건이 아니다.
// ---------------------------------------------------------------------------

/**
 * 호출 E — 플레이어 HTML 생성 시스템 프롬프트 (HARNESS §3-4 원문 그대로).
 *
 * 이 문장들이 강제하는 것과 이유:
 * - `<html><head><body>` 금지 → srcdoc으로 조립하므로 문서 뼈대는 앱이 만든다.
 * - 외부 자원 전면 금지 → 격리를 뚫는 통로를 애초에 없앤다(CSP가 어차피 막지만, 막힌 채 죽는
 *   플레이어를 보여주느니 재생성하는 편이 낫다).
 * - 색은 CSS 변수만 → 이걸 풀면 문제마다 색이 달라져 "우리 집 스타일"이 깨진다.
 * - `Kit.mount(steps)` + 각 step의 `render()` → 되돌아가기가 동작하려면 상태를 렌더 함수로
 *   다시 만들 수 있어야 한다.
 * - 답을 `<script type="application/json" id="answer">`로 → 앱이 대조할 **유일한 접점**이다.
 *
 * [내용] 절이 이름으로 부르는 Kit 함수(shape · grid · tank · coins · bar · numberline · scale ·
 * tween · fly · countUp · mount · done)는 `public/player-kit/kit.js`에 **전부 있어야 한다.**
 * 한쪽만 고치면 AI가 없는 함수를 부르고, 그 실패는 런타임에만 드러난다.
 */
export const PLAYER_HTML_SYSTEM_PROMPT = `너는 초등 수학 설명 플레이어를 만드는 프론트엔드 개발자다. 아래 3막 설명을 아이가 버튼을 눌러가며
한 단계씩 보는 '움직이는 그림'으로 옮긴다.

[환경 — 반드시 지킬 것]
- 출력은 <body> 안에 들어갈 HTML 조각 하나. <html><head><body> 태그, 외부 링크, <link>, CDN, fetch, XMLHttpRequest,
  WebSocket, localStorage, cookie, eval, new Function, document.write 금지. 인라인 <style>과 <script>는 허용.
- 인라인 SVG에 xmlns 속성을 쓰지 마라(HTML5에서 불필요하다). 주소 문자열(http:// https://)이 하나라도 들어가면 거부된다.
- 이미 로드된 전역 Kit와 kit.css의 CSS 변수를 사용한다. 색은 var(--ink) var(--water) var(--coin) var(--rewind)
  var(--ok) var(--sub) var(--line) 같은 변수만 쓴다. 임의 hex 색 금지.
- 폰트·아이콘은 시스템 것과 이모지만.
- 단계 배열을 만들고 Kit.mount(steps)로 VCR 바를 붙인다. 각 step은 {tag, title, body, calc, render()}이고
  render()에서 SVG/DOM 상태를 갱신한다(Kit.tween/Kit.fly/Kit.countUp 사용). 되돌아가기(이전)도 동작해야 한다.
- 3~8단계. 첫 단계는 문제 상황, 마지막 단계는 답이 보이는 검사 장면. 되감기형이면 마지막에서 '다시 재생'.
- 마지막에 Kit.done()을 호출한다.
- 최종 답을 <script type="application/json" id="answer">[{"label":"…","value":24,"unit":"㎠"}]</script> 로
  본문에 넣는다. 앱이 이 값을 대조한다. 정확히 주어진 answer와 같아야 한다.
- 폭 360px 모바일에서 깨지지 않게. 애니메이션은 0.6~0.9초, 과하지 않게. 글은 짧고 다정하게(아이 말).

[내용]
- 주어진 3막의 act2 단계를 그림 단계로 옮긴다. 도형은 Kit.shape, 수열·표는 Kit.grid나 상자 나열,
  양은 Kit.tank/coins/bar, 수직선은 Kit.numberline. 없는 것은 인라인 SVG로 직접 그린다.
- 세기(counting) 문제는 '무엇을 세는지'를 먼저 보이고, 센 것을 하나씩 색으로 채워 나간다.
  이미 센 것과 아직 안 센 것이 늘 구분돼야 한다 — 빠짐없이·중복없이가 이 유형의 전부다.
- 검사 장면에서 보존량이 있으면 Kit.scale(저울)을 쓴다.
- 새 내용을 지어내지 않는다. 숫자·답은 주어진 것만.`;

/**
 * 호출 E few-shot — 완성된 플레이어 HTML 1개 (도형 넓이 문제).
 *
 * **few-shot은 프롬프트 문장보다 강하게 작동한다.** 스타일·구조를 바꾸고 싶으면 문장보다 이 예시를
 * 먼저 고쳐라. 여기서 가르치는 것:
 *   - `kit-` 접두 클래스와 `.kit-wrap` / `.kit-card` / `.kit-stage` 뼈대 (프롬프트에는 없는 정보다)
 *   - `Kit.shape`의 안쪽 SVG를 문자열로 넘기는 법, `kit-part` 강조 상태('on'|'now'|'dim')
 *   - 각 step의 `render()`가 **상태를 통째로 다시 세우는** 모양 — 그래야 '이전'이 동작한다
 *   - `Kit.countUp` / `Kit.tween` 사용, 마지막 단계에서 `Kit.done()`
 *   - 답 태그를 본문에 두는 위치와 형식
 */
export const PLAYER_HTML_FEWSHOT = `<div class="kit-wrap">
  <div class="kit-card">
    <p class="kit-problem">가로 <b>8cm</b>, 세로 <b>6cm</b>인 색종이의 오른쪽 아래에서 가로 <b>3cm</b>, 세로 <b>2cm</b>를 잘라냈어요. 남은 ㄱ자 모양의 넓이는 몇 ㎠일까요?</p>
    <div class="kit-stage" id="stage"></div>
    <p class="kit-count" id="area">?<small>㎠</small></p>
  </div>

  <div class="kit-card">
    <div class="kit-rules">
      <div class="kit-rule"><span class="kit-big">✂️</span><b>잘라낸 건 빼기</b><span>통째로 세고 자른 만큼 덜어요</span></div>
      <div class="kit-rule"><span class="kit-big">🧩</span><b>둘로 나눠 더하기</b><span>어느 길로 가도 답은 같아요</span></div>
    </div>
  </div>
</div>

<script type="application/json" id="answer">[{"label":"넓이","value":42,"unit":"㎠"}]</script>

<script>
var S = Kit.shape("#stage", {
  viewBox: "0 0 230 165",
  svg:
    '<rect id="pa" class="kit-part" x="30" y="15" width="160" height="80"/>' +
    '<rect id="pb" class="kit-part" x="30" y="95" width="100" height="40"/>' +
    '<rect id="pcut" class="kit-part kit-dim" x="130" y="95" width="60" height="40" stroke-dasharray="6 5"/>' +
    '<text class="kit-len" x="110" y="9" text-anchor="middle">8cm</text>' +
    '<text class="kit-len" x="208" y="60">6cm</text>' +
    '<text class="kit-len-sub" x="160" y="152" text-anchor="middle">자른 3cm x 2cm</text>'
});

var areaEl = document.getElementById("area");
function showArea(v) { areaEl.innerHTML = (v == null ? "?" : v) + "<small>㎠</small>"; }

var steps = [
  {
    tag: "문제", mode: "end",
    title: "ㄱ자 색종이가 남았어요",
    body: "오른쪽 아래를 <b>싹둑</b> 잘라냈어요. 남은 넓이를 구해 볼까요?",
    calc: null,
    render: function () {
      S.reset();
      S.highlight("pcut", "dim");
      showArea(null);
    }
  },
  {
    tag: "1단계", mode: "rewind",
    title: "먼저 통째로 세어 봐요",
    body: "자르기 전에는 <b>가로 8, 세로 6</b>인 직사각형이었어요.",
    calc: "8 × 6 = 48",
    render: function () {
      S.highlight("pa", "now");
      S.highlight("pb", "now");
      S.highlight("pcut", "now");
      return Kit.countUp(areaEl, 0, 48, 800, "㎠");
    }
  },
  {
    tag: "2단계", mode: "rewind",
    title: "잘라낸 조각은 얼마일까요",
    body: "자른 곳은 <b>가로 3, 세로 2</b>인 작은 직사각형이에요.",
    calc: "3 × 2 = 6",
    render: function () {
      S.highlight("pa", "on");
      S.highlight("pb", "on");
      S.highlight("pcut", "now");
      showArea(48);
      return Kit.tween(S.part("pcut"), { opacity: 0.35 }, 700);
    }
  },
  {
    tag: "3단계", mode: "rewind",
    title: "통째에서 자른 만큼 빼요",
    body: "48에서 6을 덜어 내면 남은 넓이가 나와요.",
    calc: "48 − 6 = 42",
    render: function () {
      S.highlight("pa", "on");
      S.highlight("pb", "on");
      S.highlight("pcut", "dim");
      Kit.tween(S.part("pcut"), { opacity: 1 }, 300);
      return Kit.countUp(areaEl, 48, 42, 800, "㎠");
    }
  },
  {
    tag: "검사", mode: "ok",
    title: "둘로 나눠서 다시 세어 봐요",
    body: "위 조각 <b>8 × 4</b>, 아래 조각 <b>5 × 2</b>. 더하면 똑같이 42예요!",
    calc: "32 + 10 = 42",
    render: function () {
      S.highlight("pa", "on");
      S.highlight("pb", "now");
      S.highlight("pcut", "dim");
      showArea(42);
      Kit.done();
    }
  }
];

Kit.mount(steps);
</script>`;

/**
 * 호출 E 파라미터 (HARNESS §1 표: temperature 0.4 · 출력 한도 ~8,000).
 *
 * **이 하네스에서 가장 비싼 호출이다.** §8이 말한 비용 구조가 여기 있다 — 1단으로 되는 문제가
 * E로 새지 않게 하는 것보다, E 호출 수와 출력 토큰을 **로그로 보고 자주 나오는 유형을 1단 렌더러로
 * 승격**하는 쪽이 실제로 돈을 줄인다. `call` 라벨이 로그의 집계 키다.
 */
export const PLAYER_HTML_CALL_OPTIONS = {
  call: "math-player",
  temperature: 0.4,
  maxOutputTokens: 8_000,
} as const;

/**
 * 실제로 전송하는 시스템 메시지 = 원문 프롬프트 + few-shot.
 *
 * 원문(`PLAYER_HTML_SYSTEM_PROMPT`)을 상수로 따로 둔 이유는 **스펙과 글자 단위로 대조할 수 있게**
 * 하기 위해서다. few-shot을 원문 안에 섞어 넣으면 "원문 그대로"인지 아무도 확인할 수 없게 된다.
 */
export const PLAYER_HTML_SYSTEM_MESSAGE = `${PLAYER_HTML_SYSTEM_PROMPT}

[예시 — 이런 모양으로 낸다]
${PLAYER_HTML_FEWSHOT}`;

/** 호출 E 사용자 메시지 입력 (§3-4: 호출 B의 결과 + 문제 문장) */
export interface PlayerHtmlUserMessageInput {
  /** 문제 번호 */
  number?: string | null;
  /** 문제 문장 (원문 그대로) */
  text: string;
  /** 그림·표 설명 */
  figureDesc?: string | null;
  /** 호출 B의 3막 설명 전체 */
  explanation: Explanation;
  /**
   * 재생성 지시문. 정적 검사·답 태그 대조에 걸렸을 때만 채운다(`lib/scene/html.ts`가 넘긴다).
   * 비워 두면 1차 호출과 글자 단위로 같은 메시지가 나간다.
   */
  retryNote?: string | null;
}

/**
 * 호출 E — 사용자 메시지 조립.
 *
 * §3-4는 담을 **항목**(3막 텍스트 · answer · problemPattern · 문제 문장)만 지정하고 형식은 정하지
 * 않았다. §3-2 · §6과 같은 `[블록] 라벨: 값` 형식을 따른다 — 세 호출의 사용자 메시지 형식이 갈리면
 * 프롬프트를 손볼 때 사람이 대조하기 어렵다.
 *
 * `answer`를 **JSON 한 줄로도 함께 실어 준다.** 답 태그 대조(§3-4 2번)에서 걸리는 가장 흔한 원인이
 * "AI가 라벨을 제 마음대로 다시 쓰는 것"인데, 그대로 복사할 문자열을 주면 그 실패가 거의 사라진다.
 * 재생성 1회는 토큰이 8,000짜리라 **막을 수 있는 재생성은 프롬프트에서 막는 편이 싸다.**
 */
export function buildPlayerHtmlUserMessage(input: PlayerHtmlUserMessageInput): string {
  const e = input.explanation;
  const act2 = e.act2.steps
    .map((s, i) => `${i + 1}. ${s.say}${s.calc ? ` (${s.calc})` : ""}`)
    .join("\n");
  const act3 = e.act3.checks.map((c) => `- ${c.titleKo}: ${c.bodyKo}`).join("\n");
  const rules = e.rules.map((r) => `- ${r.emoji} ${r.ko} — ${r.why}`).join("\n");

  const base = `[문제]
번호: ${input.number ?? "-"}
문장: ${input.text}
그림 설명: ${input.figureDesc ?? "없음"}

[유형]
problemPattern: ${e.problemPattern}
patternNameKo: ${e.patternNameKo}

[비유]
${e.analogy.titleKo}: ${e.analogy.bodyKo}

[1막 탐정 시간]
등장: ${e.act1.castKo.join(", ")}
움직임: ${e.act1.movesKo.join(" / ")}
끝 장면: ${e.act1.endSceneKo}
구할 것: ${e.act1.goalKo}
함정: ${e.act1.trap ?? "없음"}

[2막 되감기]
${act2}

[3막 다시 재생]
${act3}

[규칙]
${rules}

[답]
${e.answerText}
아래 JSON을 <script type="application/json" id="answer"> 안에 **그대로** 넣어라:
${JSON.stringify(e.answer)}

이 설명을 되감기 플레이어 HTML로 만들어줘.`;

  const retryNote = input.retryNote?.trim();
  if (!retryNote) return base;
  // 재생성 지시는 끝에 붙인다 — 마지막 지시가 가장 세게 걸리고, 앞부분이 1차 호출과 같아
  // 프롬프트 캐시도 유지된다(§3-2 retryNote와 같은 관례).
  return `${base}

[다시 만들기]
${retryNote}`;
}

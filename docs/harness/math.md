# AI 하네스 명세 — 은우 수학코치 (OpenAI)

**은우학습 프로젝트 · 2026-08-17 · 과목 공통 규약은 `docs/HARNESS.md`, 영어는 `docs/harness/english.md`**

> **하네스**는 LLM 호출을 감싸는 뼈대 — 프롬프트·출력 스키마·검증·재시도·로깅 한 세트다.
> 북카드(영어)와 다른 점이 하나 있다. **수학은 정답이 있는 세계**라 이 하네스에는 **심판이 둘** 붙는다.
> 심판 1: 답을 독립적으로 다시 푸는 두 번째 AI 호출. 심판 2: 장면 JSON의 숫자를 앱이 직접 더하고 빼 보는 코드 검산.
> 시험지 채점을 두 선생님이 따로 하고, 계산은 계산기로 한 번 더 확인하는 식이다.

> **이 문서는 원안의 개정판이다.** 은우가 실제로 푸는 교재(Math Master 개념+유형 3-1, 소마 사고력수학 Premier 초급4)의
> 실물 페이지와 오답을 보고 원안의 공백 넷을 메웠다. 개정 지점은 본문에 **[개정]**으로 표시했다.
> 개정 근거는 §0에 모아 두었다 — 다이얼을 되돌리려는 사람이 이유를 먼저 읽게 하기 위해서다.

## 0. 개정 근거 — 은우의 오답이 알려준 것

실제 답안에서 읽은 것:

| 문제 | 은우 답 | 정답 | 무엇이 무너졌나 |
|---|---|---|---|
| 900원, 자가 지우개보다 300원 비쌈 | 자 450 · 지우개 150 | **600 · 300** | 900÷2로 반씩 나눔 — **차 조건을 안 씀** |
| 연필 3자루 주니 각각 10자루 | 민희 13 · 철희 **11** | 13 · **7** | 준 쪽은 맞고 **받은 쪽 방향을 뒤집음** |
| 1m 막대, 20cm 차 | 100−20=80, 80÷2=40 → **60cm** ✅ | 60cm | **계산은 정확** |

세 번째를 정확히 푼 것이 결정적이다 — **연산 능력 문제가 아니다.** 문장을 식으로 옮기는 단계에서 무너진다.
그래서 이 하네스는 **1막(탐정 시간)에 무게를 싣는다.** 풀이 단계를 잘게 쪼개는 것보다 "무엇이 주어졌고 무엇을 구하는가"를
그림으로 잡아 주는 쪽이 이 아이에게 값어치가 크다.

개정 넷:

1. **`bar` 렌더러에 '차' 표현 추가** — 오답 3건 중 2건이 합·차 구조인데 원안의 `bar`는 "부분과 전체"만 다뤘다. 띠 두 개의 길이 차를 보여주는 규칙이 없어, **가장 자주 틀리는 유형이 1단으로 갈 수 없었다.**
2. **호출 A가 채점 표시를 구분** — 실물 사진에는 빨간 채점 동그라미와 연필 답이 섞여 있다. 원안은 "아이가 쓴 것"만 말해 채점 표시를 아이 필기로 오독할 위험이 있었다. 게다가 **빨간 표시 자체가 "틀렸다"는 정보**라 적극 활용할 값이다.
3. **`problemPattern`에 `counting` 추가** — 소마의 도형 문제는 넓이가 아니라 **빠짐없이·중복없이 세기**다(삼각형 개수 규칙, 점판 직사각형, 정사각형 5개 속 직사각형). 설명 구조가 `geometry`와 완전히 달라 유형을 갈랐다.
4. **2단(호출 E)이 예외가 아니라 기본 경로** — 원안 §8은 "1단이 되는 문제가 E로 새지 않게"를 걱정했다. 실제 교재는 반대다. 소마의 규칙 찾기·숫자 카드·도형 세기는 1단 3종 어디에도 안 맞는다. 비용 관리의 초점을 "E를 막는 것"에서 "E를 싸게 쓰고 자주 나오는 유형을 1단으로 승격하는 것"으로 옮겼다.

## 1. 구성 개요

| 호출 | 목적 | 성격 | temperature | 출력 한도 |
|---|---|---|---|---|
| **A. 문제 판독** | 사진 → 문제 목록(+아이 필기·채점 표시) | 정확성 (보이는 것만) | 0 | ~2,500 |
| **B. 설명 설계** | 문제 1개 → 3막 설명 + (있으면) 두 번째 풀이 + 답 + 장면 JSON + 채점 | 창작 품질 + 정확성 | 0.5 | ~6,500 |
| **C. 검산** | 문제 문장만 → 답 재계산 | 정확성, 독립성 | 0 | ~800 |
| **D. 연습문제** | 문제 패턴 → 숫자 바꾼 새 문제 | 창작 | 0.7 | ~2,000 |
| **E. 플레이어 HTML** | 3막 설명 → 키트 위 HTML(2단 그림) | 창작 | 0.4 | ~8,000 |

공통 규칙은 `docs/HARNESS.md`를 따른다(서버 전용 호출 · Structured Outputs + zod 이중 검증 · 1회 재요청 · 호출 로깅 · 모델 ID는 env). 수학 고유 규칙만 여기 적는다:

- C는 `OPENAI_MODEL_VERIFY`(없으면 `OPENAI_MODEL`). **심판만 더 강한 모델로 올릴 여지**를 남긴 것이다.
- 배열 개수·범위 제약은 JSON Schema가 아니라 프롬프트 + zod에서 강제한다(strict 모드 제약).

파일 배치:

```
lib/ai/client.ts           # callWithSchema() — 과목 공유
lib/ai/math/prompts.ts     # A·B·C·D·E 프롬프트 원문 (+E few-shot HTML)
lib/ai/math/schemas.ts     # JSON Schema + zod
lib/ai/math/pipeline.ts    # B → C → 장면 검산 → 재시도 → 보류 판정 (§5)
lib/scene/types.ts         # Scene 타입
lib/scene/verify.ts        # 1단 장면 숫자 검산 (§4)
lib/scene/html.ts          # 2단 HTML 정적 검사·답 대조·iframe 조립 (§3-4)
public/player-kit/         # kit.css, kit.js (iframe 키트)
scripts/eval-math.ts       # 평가 하네스 (§7)
```

## 2. 호출 A — 문제 판독 (vision)

### 2-1. 시스템 프롬프트 (원문 그대로)

```
너는 초등 수학 문제집 페이지를 판독하는 조교다. 사진에서 '실제로 보이는 것만' 옮긴다. 추측 금지.

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

주의: 문제를 풀지 않는다. 답을 판단하지 않는다. 읽기만 한다.
```

> **[개정 2]** 4번 항목을 아이 필기 / 어른 채점 표시로 갈랐다. 실물 사진에서 둘이 늘 섞여 있는데,
> 채점 동그라미를 `childWork`로 읽으면 채점 로직이 오작동한다. 반대로 `gradedMark`는 "부모가 이미 틀렸다고
> 표시한 문제"라는 강한 신호라 설명 만들 문제를 고르는 화면에서 우선순위로 쓸 수 있다.
> 프롬프트가 **뜻을 판단하지 말라**고 못 박은 이유는, 교재·가정마다 표시 관례가 달라 AI가 추측하면
> 틀린 채점이 나오기 때문이다. 해석은 앱과 사람의 몫이다.

### 2-2. 사용자 메시지

이미지 1장(`input_image`) + `"이 페이지의 문제들을 판독해줘."`

### 2-3. 출력 JSON Schema — `worksheet_extraction` (strict)

```json
{
  "name": "worksheet_extraction", "strict": true,
  "schema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "isWorksheet": {"type": "boolean"},
      "source": {"type": ["string","null"]},
      "problems": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "number": {"type": ["string","null"]},
            "text": {"type": "string"},
            "truncated": {"type": "boolean"},
            "figureDesc": {"type": ["string","null"]},
            "givens": {"type": "array", "items": {
              "type": "object", "additionalProperties": false,
              "properties": {"label":{"type":"string"},"value":{"type":"number"},"unit":{"type":["string","null"]}},
              "required": ["label","value","unit"]}},
            "childWork": {"type": ["string","null"]},
            "childAnswer": {"type": ["string","null"]},
            "gradedMark": {"type": "string", "enum": ["circled","checked","none"]}
          },
          "required": ["number","text","truncated","figureDesc","givens","childWork","childAnswer","gradedMark"]
        }
      }
    },
    "required": ["isWorksheet","source","problems"]
  }
}
```

### 2-4. 후처리

- `isWorksheet=false` 또는 `problems` 비어 있음 → "다시 찍어주세요" + 직접 입력 폴백.
- 판독 결과는 확인 화면에서 사용자가 수정 가능. **수정본**이 B의 입력이 된다.
- **[개정 2]** `gradedMark !== 'none'`인 문제를 확인 화면에서 **먼저·기본 선택**으로 올린다. 페이지에 문제가 12개인
  교재(Math Master)에서 전부 설명을 만들면 비용이 감당 안 된다 — 틀린 표시가 있는 문제가 곧 설명이 필요한 문제다.

## 3. 호출 B — 설명 설계

### 3-1. 시스템 프롬프트 (원문 그대로)

```
너는 초등학생 아이와 수학 문제를 함께 푸는 한국인 부모를 돕는 초등 수학 교육 전문가다.
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

(공통) 각 단계 caption: {tag(예: "되감기 1"), title, body(아이 말), calc(있으면)}. steps는 3~8개.
```

> **[개정 1]** `bar`에 `layout: 'parts' | 'compare'`와 `difference`를 넣었다. 합·차 문제가 1단으로 갈 수 있게 된 것이
> 이 개정의 핵심이다. 단계 순서("차를 떼어 낸다 → 똑같이 나눈다 → 되돌린다")를 프롬프트에 못 박은 이유는,
> 그 순서 자체가 이 아이의 오답(반씩 나누기)을 정면으로 교정하기 때문이다.
>
> **[개정 3]** `problemPattern`에 `counting`을 추가하고 `geometry`의 범위를 "길이·넓이·모양"으로 좁혔다.
>
> **[개정, 1막 비중]** `[이 아이에 대해]` 절과 act1의 `movesKo` 방향 규칙을 추가했다. 원안은 act2에 무게가 있었는데,
> 실측된 약점이 "문장 → 식" 단계라 1막을 두껍게 가져간다.

### 3-2. 사용자 메시지 템플릿

```
[문제]
번호: {number ?? "-"}
문장: {text}
그림 설명: {figureDesc ?? "없음"}
주어진 숫자: {givens를 "라벨=값단위, ..." 로}
아이가 쓴 답: {childAnswer ?? "없음"}
아이가 쓴 풀이: {childWork ?? "없음"}

[아이 정보]
한국 초등학교 3학년. {childNote ?? ""}

이 문제의 3막 설명을 만들어줘.
```

### 3-3. 출력 타입 (TypeScript · zod로 구현, JSON Schema는 이 타입에서 생성)

```ts
type ProblemPattern =
  | 'rewind-transfer' | 'part-whole' | 'multiple' | 'sequence-ops'
  | 'rate' | 'pattern' | 'geometry' | 'counting' | 'other';

interface Explanation {
  problemPattern: ProblemPattern;
  patternNameKo: string;
  analogy: { titleKo: string; bodyKo: string };
  act1: { castKo: string[]; movesKo: string[]; endSceneKo: string; goalKo: string; trap: string|null };
  act2: { steps: { say: string; calc: string|null }[] };        // 3~6개
  act3: { checks: { titleKo: string; bodyKo: string }[] };      // 2~3개
  rules: { emoji: string; ko: string; why: string }[];          // 2~3개
  parentTip: string;
  answer: { label: string; value: number; unit: string|null }[];
  answerText: string;
  confidence: 'high'|'medium'|'low';
  uncertaintyNote: string|null;
  childGrade: 'correct'|'partial'|'wrong'|'none';
  gradeNote: string|null;
  scene: Scene|null;
  sceneHtmlRequest: boolean;
}

// ── 1단: 전용 렌더러 (엄격 검산 가능) ──
interface Scene {
  kind: 'containers'|'bar'|'numberline';
  visual: 'tank'|'coin'|'bar'|null;              // containers 전용
  layout: 'parts'|'compare'|null;                // bar 전용 [개정 1]
  difference: { amount: number; labelKo: string } | null;  // bar layout='compare' 전용 [개정 1]
  unit: string;
  maxValue: number;
  entities: { id: string; labelKo: string }[];
  moves: { from: number; to: number; amt: number; labelKo: string }[];
  conservation: { total: number; labelKo: string } | null;
  steps: {
    mode: 'end'|'find'|'rewind'|'split'|'start'|'ok';   // 'split' 추가 [개정 1]
    values: (number|null)[];
    move: number|null;
    forward: boolean;
    caption: Caption;
  }[];
}
interface Caption { tag: string; title: string; body: string; calc: string|null }
```

JSON Schema는 위 타입을 strict 규칙(모든 필드 required, nullable은 `["type","null"]`, `additionalProperties:false`)으로
옮겨 `schemas.ts`에 둔다. 배열 개수(steps 3~8, checks 2~3, rules 2~3)는 zod에서 검사.

> `mode: 'split'`은 `bar layout='compare'`의 "차를 떼어 내고 남은 것을 똑같이 나눈다" 단계다. 되감기(`rewind`)와
> 달리 이동을 되돌리는 것이 아니라 **전체를 두 몫으로 가르는** 단계라 검산 규칙이 다르다(§4-9).

### 3-4. 호출 E — 플레이어 HTML 생성 (2단)

`sceneHtmlRequest === true`일 때만 호출. 입력은 호출 B의 결과(3막 텍스트, answer, problemPattern)와 문제 문장.
**출력은 JSON이 아니라 HTML 문자열 하나**(Structured Outputs로 `{ html: string, stepCount: number }`로 감싸 받는다).
temperature 0.4, 출력 한도 ~8,000.

**iframe 키트** — 앱이 iframe에 미리 주입한다(`public/player-kit/`). AI는 이 위에서만 짠다.

| 파일 | 내용 | 출처 |
|---|---|---|
| `kit.css` | 디자인 토큰 CSS 변수(`--ink --water --coin --rewind --ok …`), 카드·캡션·VCR 바·규칙 카드 스타일, `prefers-reduced-motion` | `design/되감기-샘플.html`의 `<style>` |
| `kit.js` | 전역 `Kit`: `mount(steps)` · `tween` · `fly` · `tank/coins/bar/numberline/scale/grid/shape` · `countUp` · `done` | 샘플의 `<script>`에서 추출·일반화 |
| 보고 채널 | `parent.postMessage({type:'ready'|'error'|'step', height?}, …)` | 신규 |

**호출 E 시스템 프롬프트 (원문 그대로)**

```
너는 초등 수학 설명 플레이어를 만드는 프론트엔드 개발자다. 아래 3막 설명을 아이가 버튼을 눌러가며
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
- 새 내용을 지어내지 않는다. 숫자·답은 주어진 것만.
```

> **[개정 3]** `[내용]`에 세기(counting) 렌더 지침을 추가했다. 소마 도형 문제가 이 유형이고, "이미 센 것/안 센 것 구분"이
> 없으면 그림이 있으나 마나다.

**앱 측 처리(`lib/scene/html.ts`)**

```
1. 정적 검사: 금지 문자열(<link, <iframe, fetch(, XMLHttpRequest, WebSocket, localStorage, document.cookie,
   eval(, new Function, document.write, http://, https://) → 걸리면 재생성 1회
2. answer 태그 파싱 → B의 answer와 값 비교(라벨 정규화) → 불일치 → 재생성 1회
3. iframe srcdoc = kit.css + kit.js + html.  sandbox="allow-scripts" (allow-same-origin 없음),
   CSP meta: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
4. 3초 안에 'ready'가 없거나 'error'가 오면 플레이어 숨기고 텍스트 3막만(사유 로그)
5. 성공한 html은 explanations.sceneHtml에 저장(재생성 시 덮어쓰지 않고 새 문서)
```

**격리(iframe+CSP)가 1차 방어, 정적 검사가 2차다.** 차단 목록은 통과했다고 안전을 보증하지 않는다 —
목록에 없는 수법은 늘 있다. 순서를 뒤집지 마라. `allow-same-origin`을 함께 주면 샌드박스가 사실상 해제된다.

답 태그 대조는 "그림이 틀린 답을 보여주는 것"을 막는 마지막 그물이다. 라벨 정규화는 §5의 `compare()`와
**같은 구현을 쓴다** — 두 곳에 따로 만들면 어긋난다.

## 4. 장면 숫자 검산 — `lib/scene/verify.ts`

AI가 쓴 대본을 앱이 계산기로 다시 두드려 본다. 전부 순수 함수, 실패 사유 배열을 돌려준다.

```
verifyScene(scene, answer): string[]   // 빈 배열이면 통과

1. entities.length ≥ 1, 모든 steps[i].values.length === entities.length
2. moves의 from/to는 entities 인덱스 범위, from ≠ to, amt > 0
3. steps 순서: 첫 mode ∈ {end}, 마지막 mode === 'ok', 'start'가 정확히 1개, 'ok' 바로 앞은 'start'
4. rewind 단계: prev = 직전 단계 values (null 아닌 값 기준), m = moves[step.move]
     values[m.from] === prev[m.from] + m.amt
     values[m.to]   === prev[m.to]   − m.amt
     나머지 인덱스는 변화 없음
5. 'start' 단계 values ↔ answer: 라벨 매칭 후 값 동일
6. 'ok' 단계 values === 첫 'end' 단계 values (end에 null이 있으면 'find' 단계 값과 비교)
7. conservation이 있으면 null이 없는 모든 단계에서 sum(values) === total
   **단 'split' 단계는 제외한다.** split은 정의상 차를 떼어 낸 뒤의 상태라 합이
   total − difference.amount다. 이 예외가 없으면 정상 합·차 대본이 100% 오탐된다.
   구멍이 생기지 않는 이유: split의 합은 §4-9가 더 엄격하게(prevSum 또는 conservation
   유도값으로) 고정하므로, 검산이 느슨해지는 것이 아니라 담당이 옮겨갈 뿐이다.
8. 모든 값 ≤ maxValue, ≥ 0 (numberline은 음수 허용)
9. [개정 1] kind==='bar' 추가 규칙
   - layout이 null이 아니어야 한다
   - layout==='compare'면 entities.length === 2 이고 difference가 null이 아니다
   - difference.amount > 0
   - 'start' 단계에서 |values[0] − values[1]| === difference.amount
   - conservation이 있으면 그 total이 'start'의 두 값의 합과 같다
   - 'split' 단계: 직전 단계에서 차를 떼어 낸 뒤의 값이어야 한다.
       prevSum = 직전 단계 values 합
       values의 두 값이 서로 같고, 그 합이 prevSum과 같다
     (즉 "남은 것을 똑같이 둘로 나눈" 상태다. 이 규칙이 '반씩 나누기' 오답과
      '차를 떼고 나누기' 정답을 구분한다)
   - layout==='parts'면 difference는 null이고 'split'을 쓰지 않는다
```

실패 사유는 **어느 단계·어느 인덱스·기대값·실제값**을 담는다(`"rewind step 3: values[1] expected 12, got 15"`).
재시도 프롬프트에 그대로 실리므로, 사유가 모호하면 재시도가 같은 실수를 반복한다.

2단(HTML) 검사는 §3-4대로 정적 검사 + 답 태그 대조 + 실행 오류 감시만 한다. **그림이 맞는지까지는 못 본다.**

## 5. 호출 C — 검산, 그리고 파이프라인

### 5-1. C 시스템 프롬프트 (원문 그대로)

```
너는 초등 수학 문제 검산 담당이다. 문제 문장만 보고 스스로 푼 뒤 답만 낸다.
설명·비유는 쓰지 않는다. 라벨은 문제 속 이름 그대로 쓴다. 답을 확정할 수 없으면 solvable을 false로.
```

사용자 메시지: `[문제]\n{text}\n그림 설명: {figureDesc}\n\n답을 계산해줘.`
— **B의 답은 절대 넘기지 않는다.** 심판이 선수 답안지를 먼저 보면 그 답에 끌려간다(anchoring).
두 번째 의견이 첫 번째의 복사본이 되면 심판이 둘이 아니라 하나다. C의 입력을 조립하는 코드에 이 주석을 남겨라 —
"컨텍스트를 더 주면 정확해지지 않나?"라는 선의의 수정이 반드시 들어온다.

출력 스키마 `answer_check`: `{ solvable: boolean, answer: {label, value, unit|null}[] }` (strict).

### 5-2. 답 비교 정규화

- 라벨: 공백·조사(은/는/이/가/의) 제거 후 비교. `"가 통"`≡`"가통"`, `"승환이"`≡`"승환"`.
- 값: 소수는 `1e-6` 허용 오차.
- 개수가 다르거나 라벨이 하나라도 매칭 안 되면 불일치.

**정규화를 너무 관대하게 만들지 마라.** 서로 다른 대상을 같다고 판정하면 심판이 무력해진다. 애매하면 불일치로
두고 `held`로 보내는 편이 안전하다.

### 5-3. 파이프라인 — `explainProblem()`

```
b = callB(problem);  c = callC(problem)
answerMatch = compare(b.answer, c.answer)
sceneErrors = b.scene ? verifyScene(b.scene, b.answer) : []

if (!answerMatch || sceneErrors.length):        # 재시도는 1회만
    b = callB(problem, retryNote = "이전 답 {b.answer}가 독립 검산 {c.answer}와 다르거나
                                    장면 검산 오류가 있었다: {sceneErrors}. 문제를 처음부터 다시 풀어라.")
    c2 = callC(problem)                         # 검산도 새로 (같은 답을 두 번 확인)
    answerMatch = compare(b.answer, c2.answer) && compare(c.answer, c2.answer)
    sceneErrors = verifyScene(...)

status = answerMatch ? 'ok' : 'held'
if (sceneErrors.length) b.scene = null          # 장면만 버리고 텍스트는 살린다
if (b.confidence === 'low') status = 'held'     # AI 스스로 자신 없으면 보류

sceneHtml = null
if (status === 'ok' && !b.scene && b.sceneHtmlRequest):
    sceneHtml = callE(problem, b)               # §3-4 처리 포함, 실패 시 null
sceneTier = b.scene ? 'typed' : sceneHtml ? 'html' : 'none'
return { content: b, sceneHtml, sceneTier, verify: { status, answerMatch, sceneCheck: !sceneErrors.length, attempts } }
```

**재시도는 1회.** 실호출 비용이 곱으로 늘고, 두 번 실패한 문제는 세 번째도 대개 실패한다.
재시도 시 검산도 새로 하는 이유는 "같은 답을 두 번 독립 확인"이다.

**`held`는 실패가 아니라 정직한 보류다.** 화면에는 "엄빠가 한 번 확인해 주세요" 배지와 텍스트 설명을 보여주고
답은 접어 둔다. 보류율이 올라가는 것보다 틀린 답이 통과하는 것이 훨씬 나쁘다.
**`held`를 줄이려고 검산을 느슨하게 만들자는 요청이 오면, 그 완화가 어떤 틀린 답을 통과시키는지 먼저 따져 답하라.**

## 6. 호출 D — 연습문제

```
너는 초등 수학 연습문제 출제자다. 주어진 문제와 같은 구조(problemPattern, 등장 인원, 이동 횟수, 함정 종류)를 유지하고
숫자와 소재만 바꾼 새 문제 1개를 만든다.
- 소재는 아이가 좋아할 만한 생활 소재(구슬, 스티커, 쿠키, 물감…)로 바꾼다. 이름은 원래 문제의 이름을 쓰지 않는다.
- 숫자는 초등 3학년 암산 범위(합계 100 이하 또는 100단위 깔끔한 수). 답은 모두 0 이상의 정수.
- 원래 문제에 함정(두 번 움직인 사람, 합과 차가 함께 주어짐 등)이 있었으면 새 문제에도 같은 함정을 넣는다.
- 답과, 되감기 플레이어용 scene(원래 문제와 같은 kind·layout, 규칙은 동일)을 함께 낸다. 확신이 없으면 scene은 null.
출력은 지정된 JSON 스키마로만.
```

사용자 메시지: 원 문제 텍스트 + `problemPattern` + `patternNameKo` + `trap` + 원래 scene의 kind/layout/entities 수/moves 수.
출력 `practice`: `{ text, answer, answerText, hintKo, scene|null }`.
**생성 후 반드시 호출 C로 검산**, 불일치 시 1회 재생성, 그래도 실패면 "지금은 만들 수 없어요" 표시.

## 7. 평가 하네스 — `scripts/eval-math.ts`

프롬프트를 고칠 때마다 돌리는 회귀 테스트. **픽스처는 은우가 실제로 푸는 교재에서 뽑는다** — 합성 문제로는
이 아이의 오답 패턴을 재현할 수 없다.

| id | 출처 | 유형 | 이 픽스처가 지키는 것 |
|---|---|---|---|
| `pencil-transfer` | 소마 Premier 초급4 L1-05 | `rewind-transfer` | 1단 `containers` · 되감기 검산 · **은우 오답(철희 11)으로 `partial` 채점** |
| `ruler-eraser` | 소마 Premier 초급4 L1-03 | `part-whole` | **1단 `bar` layout='compare' · `split` 검산**(개정 1) · 은우 오답(450/150) |
| `ribbon-hairpin` | Math Master 3-1 p.55-12 | `multiple` | 서술형 · `childAnswer` null 경로 · 나눗셈 |
| `rect-count` | 소마 Premier 초급4 L2-04 | **`counting`**(개정 3) | 2단 HTML · `sceneHtmlRequest=true` · 세기 렌더 지침 |

| # | 점검 | 기준 |
|---|---|---|
| 1 | 답 정확도 | B와 C의 답이 fixture.expectedAnswer와 모두 일치 |
| 2 | 장면 검산 | `verifyScene` 오류 0, `scene.kind`·`layout`이 기대와 일치 |
| 3 | 유형 분류 | `problemPattern === expectedPattern` |
| 4 | 함정 감지 | expectedTrap이 있으면 `act1.trap`이 null 아니고 핵심어 포함 |
| 5 | 채점 | `pencil-transfer` → 'partial'(한 사람만 맞음), `ruler-eraser` → 'wrong', `ribbon-hairpin` → 'none' |
| 6 | 말투 길이 | act2 각 `say` ≤ 60자, **[M5] `insight.stepsKo` 각 단계 ≤ 60자**, act1 각 항목 ≤ 40자, 영어 문장 없음 |
| 7 | 구조 개수 | steps 3~6, checks 2~3, rules 2~3, act3 첫 check 제목에 "다시" 포함 |
| 8 | 보류율 | 픽스처 전체에서 'held' 0건 |
| 9 | 2단 그림 | `rect-count`에서 `sceneHtmlRequest=true`, E 결과가 정적 검사·답 대조 통과, headless iframe 3초 내 'ready', 단계 3~8. 1단 픽스처에서는 `sceneHtmlRequest=false` |
| 10 | **[개정 1] 방향·차 표현** | `pencil-transfer`의 `act1.movesKo`에 화살표(→)와 두 이름이 모두 포함 · `ruler-eraser`의 scene에 `difference.amount === 300`이고 `split` 단계 존재 |

출력: 항목별 pass/fail 표, 실패 시 exit 1. `"eval:math": "tsx scripts/eval-math.ts"`.
**문제당 호출 2~4회** — 4문제면 8~16회(+2단은 E 추가). 영어(3회)보다 훨씬 비싸다.
오프라인으로 확인 가능한 것(순수 함수 검산, 정적 검사, 루프백 스텁)은 전부 오프라인에서 끝내고 실호출은 마지막 1회.

## 8. 운영 메모

- 문제 1개 = B + C (재시도 시 ×2) ≈ 호출 2~4회. Math Master는 **페이지당 문제가 12개**라 전부 만들면 최대 48회다.
  판독 확인 화면에서 **설명 만들 문제를 고르게** 한 것이 비용 안전장치다. `gradedMark`가 있는 문제를 기본
  선택으로 올려(개정 2) 사용자가 매번 고르는 수고도 줄인다. **페이지 전체를 자동 처리하는 경로를 만들지 마라.**
- **[개정 4] 2단(호출 E)은 예외가 아니라 기본 경로다.** 소마 사고력수학의 규칙 찾기·숫자 카드 배치·도형 세기는
  1단 3종 어디에도 안 맞는다. 원안이 걱정한 "1단 가능 문제가 E로 새는 것"보다, **E가 대부분을 처리하면서
  토큰이 커지는 것**이 실제 비용 구조다. 그래서:
  - `sceneTier`를 유형별로 집계해 서재에 보여준다. **HTML로 자주 그려지는 유형이 곧 다음에 만들 전용 렌더러다.**
  - E 호출 수와 출력 토큰을 로깅한다. 1단 승격이 비용을 얼마나 줄였는지 재기 위해서다.
- `held` 비율을 유형별로 남긴다(`{problemPattern, status, attempts}`). 특정 유형에서 잦으면 그 유형 프롬프트를
  손볼 신호다 — 검산을 느슨하게 할 신호가 아니다.
- 아이 반응 보고 조정할 다이얼: 비유의 종류, act2 단계 수, 규칙 카드 개수, 연습문제 숫자 범위, insight 단계 수(§10).
  전부 프롬프트 숫자만 바꾸면 되고, 바꾼 뒤 `npm run eval:math`.
- Kit 함수를 늘리면(`Kit.clock`, `Kit.pie` 등) E 프롬프트의 `[내용]` 절에 한 줄 추가하고 few-shot을 갱신한다.
  **키트와 프롬프트가 어긋나면 AI가 없는 함수를 부른다.**
- 새 전용 렌더러를 추가할 때: ① 픽스처 1문제 추가 → ② 렌더러 kind + 검산 규칙 추가 → ③ B 프롬프트의 1단 목록에
  그 kind 규칙 몇 줄 추가 → ④ eval 통과. 픽스처가 먼저 있어야 승격이 실제로 나아졌는지 잴 수 있다.

## 9. 저장·기록 — `explanations` (M4)

M1은 저장이 없다. 만든 설명이 새로고침과 함께 사라진다. §3-4와 §8이 `explanations` 컬렉션을
전제하면서도 그 모양을 정의한 적이 없어, 이 절이 그 빈자리를 메운다.

### 9-1. 무엇을 남기는가

**설명 1건 = 문서 1개.** 목록·통계용 요약 인덱스를 따로 두지 않는다 — 필요한 값
(`problemPattern` · `childGrade` · `verify.status`)이 전부 이 문서 안에 있고, 가족용 규모
(수백 건)에서는 전문을 읽어도 무겁지 않다. 영어의 `CardRecord`가 `content: Card`를 통째로
안는 것과 같은 규약이다.

```ts
/** 호출 B에 넣은 입력 그대로 (= MathExplainRequest의 정규화된 형태) */
export interface MathProblemInput {
  number: string | null;
  text: string;
  figureDesc: string | null;
  givens: { label: string; value: number; unit: string | null }[] | null;
  childAnswer: string | null;
  childWork: string | null;
  childNote: string | null;
}

export interface ExplanationRecord {
  id: string;
  problem: MathProblemInput;
  content: Explanation;        // 3막 설명 전문. 장면 검산이 실패했으면 content.scene은 null
  sceneHtml: string | null;    // 호출 E 결과 — M4 시점에는 항상 null (M2.5에서 채워진다)
  sceneTier: SceneTier;
  verify: ExplainVerifyReport; // status·answerMatch·sceneCheck·attempts·heldReasons·checkAnswer
  model: string;               // 설명을 만든 모델 ID
  createdAt: string;           // ISO 8601
}

export type NewExplanation = Omit<ExplanationRecord, "id" | "createdAt">;
```

**`problem`을 통째로 남기는 이유**: 다시 보기 화면이 "무엇을 물었는지"를 보여줘야 하고,
재생성과 연습문제(호출 D)가 같은 입력을 다시 쓴다. `content`만 남기면 질문이 사라진다.

**`verify`를 남기는 이유**: §8이 요구하는 `{problemPattern, status, attempts}` 집계의 원천이다.
보류가 잦은 유형을 찾는 신호가 여기서 나온다 — 검산을 느슨하게 할 신호가 아니라 그 유형
프롬프트를 손볼 신호다.

### 9-2. Store 확장

백엔드가 하나이므로 인터페이스를 쪼개지 않고 `BookCardStore`에 네 메서드를 더한다.
이름이 영어 전용으로 읽히므로 **`StudyStore`를 새 이름으로 두고 `BookCardStore`는 그 별칭으로
남긴다** — 기존 import를 하나도 깨지 않는다.

```ts
createExplanation(input: NewExplanation): Promise<ExplanationRecord>;
getExplanation(id: string): Promise<ExplanationRecord | null>;
/** 최신순. 가족용 규모라 전체 조회로 충분하다 */
listExplanations(limit?: number): Promise<ExplanationRecord[]>;
/** 지웠으면 true, 없는 id였으면 false — deleteCard와 같은 규약 */
deleteExplanation(id: string): Promise<boolean>;
```

`DbShape`에 `explanations: ExplanationRecord[]`를 더하고, 읽을 때 `parsed.explanations ?? []`로
**기존 `db.json`이 그대로 열리게** 한다(마이그레이션 없음). Firestore 컬렉션명은 `explanations`.

### 9-3. 저장 시점 — 자동, 그러나 best-effort

`POST /api/math/explain`이 파이프라인 성공 직후 저장한다.

- **`held`도 저장한다.** 보류율 집계가 §8의 목적이고, 접어 둔 답도 부모가 나중에 확인할 근거다.
- **저장 실패가 설명을 죽이면 안 된다.** try/catch로 감싸고, 실패하면 로그만 남긴 뒤 `id: null`로
  응답한다. 설명은 이미 만들어졌고 사용자에게는 그것이 본체다.
- 응답 계약 `MathExplainSuccess`에 `id: string | null`을 더한다.

라우트의 "결과를 그대로 내려준다" 원칙은 그대로다 — 저장은 결과를 바꾸지 않는다.
**금지된 것은 답을 손보거나 `held`를 뒤집는 일이지 기록을 남기는 일이 아니다.**

### 9-4. 화면

```
/math/library        목록 + 유형별 통계
/math/problem/[id]   저장된 설명 보기
```

둘 다 **서버 컴포넌트에서 `getStore()`를 직접 읽는다**(영어 `/library`와 같은 규약,
`export const dynamic = "force-dynamic"`). 목록 조회용 API 라우트를 만들지 않는다.

`/math/problem/[id]`는 레코드를 `MathExplainSuccess` 모양으로 되살려 **기존
`<MathExplanationView>`에 그대로 넘긴다.** 새 뷰를 만들지 마라 — 두 벌이 되면 어긋난다.

목록 필터 셋:

| 필터 | 조건 |
|---|---|
| 전체 | — |
| 틀린 문제 | `content.childGrade`가 `wrong` 또는 `partial` |
| 보류 | `verify.status === 'held'` |

통계는 `problemPattern`별 **건수 · 정답률 · 보류율**. 정답률 분모에서 `childGrade === 'none'`은
뺀다 — 아이가 답을 쓰지 않아 채점할 것이 없었던 문제다. 분모가 0이면 비율 대신 "—"를 보인다.

`/math` 홈에 "지난 문제 보기" 진입을 더한다.

### 9-5. 삭제

`DELETE /api/math/explanations/[id]`. 연쇄 삭제는 없다(딸린 것이 없다).
`lib/prod-guard.ts`를 통과시키고 `isProdGuardError`를 영어 라우트(`app/api/cards/[id]`)와
**같은 방식으로** 처리한다.

## 10. 두 번째 풀이 — `insight` (M5)

같은 문제를 **정석**과 **통찰** 두 갈래로 보여 준다. 정석은 이미 3막이 맡고 있으므로,
이 절은 그 뒤에 붙는 두 번째 갈래만 규정한다.

### 10-1. 3막을 건드리지 않는다

`act1`·`act2`·`act3`는 그대로다. `insight`는 **별도 최상위 필드**로 붙는다.

§0이 실측으로 정한 것 — 이 아이는 계산이 아니라 **문장을 식으로 옮기는 단계**에서 무너진다.
방법을 둘 동시에 던지면 "어느 걸 써야 하지?"가 새 장벽이 된다. 그래서:

- 화면에서 **정석이 먼저**고 통찰은 **접힌 카드**다(기본 닫힘, §10-4).
- 통찰은 **보너스**다. 본체가 아니다. 없어도 설명은 온전하다.

**지름길을 먼저 가르치지 마라.** 구조를 잡기 전에 요령부터 배우면 "그냥 외우면 되네"로 굳는다.

### 10-2. 없으면 만들지 않는다

**초등 문제 상당수는 정석이 곧 최단이다.** 없는 통찰을 억지로 만들면 AI가 억지 논리를
지어내고, 아이는 그것을 그대로 배운다 — 이 앱에서 가장 위험한 실패 모습이다.

그래서 `insight`는 **nullable**이고, 프롬프트가 이를 명시적으로 허락한다.
eval은 "통찰이 없어야 할 문제에서 null이 나오는 것"도 **통과 조건**으로 센다(§10-5).

### 10-3. 타입과 검산

```ts
export interface Insight {
  titleKo: string;       // 방법 이름, 아이 말 (예: "차를 먼저 떼어 내기")
  hookKo: string;        // 왜 빠른지 한 줄 (25자 안팎)
  stepsKo: string[];     // 2~3단계. **act2.steps보다 반드시 짧다**
  answer: AnswerItem[];  // 이 방법으로 나온 답 — 대조용 (§10-3 삼자 대조)
  parentNoteKo: string;  // 부모용: 이 방법이 언제 통하고 언제 안 통하는지
}
```

`Explanation`에 `insight: Insight | null`을 더한다. 호출 B가 **한 번에** 만든다 —
이미 문제를 푼 모델이 두 번째 방법을 내는 것이 자연스럽고 싸다. 별도 호출을 만들지 마라
(§8의 비용 구조가 호출 수에 곧바로 걸린다). 출력 한도만 ~6,500으로 올린다(§1).

**`stepsKo.length < act2.steps.length`는 zod가 강제한다.** 통찰이 정석보다 길면 통찰이 아니다.
strict JSON Schema는 배열 길이 제약을 걸 수 없으므로 프롬프트 + zod 두 곳에서 잡는다(§1 규약).

#### 삼자 대조 — 새로 생기는 안전 그물

호출 C(독립 검산)에 더해 `insight.answer`가 **세 번째 눈**이 된다. `compare()`는 §5-2를 그대로 쓴다.

| B.answer | C.answer | insight.answer | 처리 |
|---|---|---|---|
| 같음 | 같음 | 같음 | `ok` — 세 경로가 같은 답 |
| 같음 | 같음 | **다름** | **`insight`만 버린다**(null). 설명 본체는 살린다 |
| **다름** | — | — | 기존 §5-3 그대로 — 재시도 1회 → `held` |

**`insight` 불일치로 `held`를 만들지 않는다.** 통찰은 부가물이고, 다수결(B·C 일치)이 이미
답을 뒷받침한다. 버리는 정책은 장면 검산 실패 시 `scene`만 버리는 것(§5-3)과 같다 —
**부가물의 오류가 본체를 죽이지 않는다.** 버렸으면 `verify.insightDropped`를 true로 남긴다
(유형별로 집계하면 어느 유형에서 통찰이 자주 어긋나는지 보인다).

### 10-4. 화면

3막 뒤, 규칙 카드 앞에 **접힌 카드** 하나. 기본은 닫힘.

```
🔍 1막 탐정 시간
⏪ 2막 되감기          ← 정석
▶️ 3막 다시 재생
💡 다른 방법도 있어요  ▾  ← insight (접힘, 기본 닫힘)
📝 규칙 카드
👨‍👩‍👦 엄빠 티칭 포인트
```

- `insight`가 null이면 **카드 자체를 그리지 않는다.** 빈 카드가 "안 나왔네?"로 읽히면 안 된다.
- 펼치면 `titleKo` → `hookKo` → `stepsKo` → `parentNoteKo` 순. `parentNoteKo`는 부모용
  글자 크기(작게)로 구분한다(DESIGN §4 — 위계는 색이 아니라 크기).
- `<details>`/`<summary>`를 쓴다. JS 없이 접힘이 동작하고, 인쇄하면 펼쳐진다.
- 새 CSS를 만들지 않는다 — `u-card`·`t-*` 재사용.

### 10-5. eval

`scripts/eval-math.ts` 픽스처에 두 갈래를 **모두** 둔다.

| 픽스처 | 기대 |
|---|---|
| 통찰이 있는 문제 (합·차 → "차를 먼저 떼기") | `insight != null` · `insight.answer == answer` · `stepsKo.length < act2.steps.length` |
| 정석이 최단인 문제 | `insight == null` **이면 통과** — 억지 생성을 실패로 센다 |

`insight`가 붙어도 기존 체크(답 일치·장면 검산·3막 분량)는 그대로 통과해야 한다.
**두 번째 풀이를 넣느라 첫 번째가 얇아지면 회귀다.**

> **[2026-08-19 실호출 관찰]** (b) 갈래에 배정했던 `ribbon-hairpin`을 `unpinned`로 되돌렸다.
> 모델이 낸 "머리핀 한 개분(24cm)으로 묶어 나눗셈 한 번" 풀이가 계산 횟수는 정석과 같지만
> 억지 논리가 아니었기 때문이다. **그 결과 지금 `absent` 갈래를 밟는 픽스처가 하나도 없다** —
> 판정 코드는 살아 있으나 억지 생성 감시는 당분간 실사용 관찰이 맡는다.
> "정석이 곧 최단"이 분명한 문제를 만나면 그 픽스처를 `absent`로 배정하라.

### 10-6. 프롬프트에 더할 절

호출 B 시스템 프롬프트(§3-1)의 `[3막 구조]` 뒤에 넣는다:

```
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
```

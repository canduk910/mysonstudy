# AI 하네스 명세 — 은우 북카드 (OpenAI)

**은우학습 프로젝트 · 2026-08-15 · 저장소에는 `docs/HARNESS.md`로 저장**

> **하네스란?** LLM 호출을 감싸는 뼈대입니다 — 프롬프트, 출력 스키마, 검증, 재시도, 로깅을 한 세트로 묶은 것.
> 말과 마차를 잇는 마구(harness)처럼, 모델의 힘이 정확한 방향으로만 나가게 잡아주는 장치예요.
> 이 문서의 프롬프트와 스키마는 **완성본**입니다. 클로드코드에게 "docs/HARNESS.md 명세대로 `lib/ai/`를 구현해"라고 전달하면 그대로 코드가 됩니다.

## 1. 구성 개요

앱의 AI 호출은 딱 2종입니다.

| 호출 | 목적 | 성격 | temperature | 출력 한도 |
|---|---|---|---|---|
| **A. 표지 판독** | 사진 → 책 메타데이터 | 정확성 우선 (보이는 것만) | 0 | ~1,000 토큰 |
| **B. 카드 생성** | 메타데이터 → 학습 카드 | 창작 품질 우선 | 0.7 | ~6,000 토큰 |

공통 규칙:

- 모든 호출은 **서버(route handler)에서만**. API 키 클라이언트 노출 금지.
- OpenAI **Responses API** + **Structured Outputs**(`json_schema`, `strict: true`).
- 응답은 **zod로 이중 검증**. 실패 시 검증 오류 메시지를 첨부해 **1회만 재요청**, 그래도 실패면 throw.
- 배열 개수 제약(단어 12개, 질문 8개 등)은 스키마가 아니라 **프롬프트 + zod**에서 강제한다. (strict 모드의 `minItems`/`maxItems` 지원 여부는 모델·버전에 따라 다르니 스키마에는 넣지 않는다)
- 호출마다 `{call, model, inputTokens, outputTokens, ms}`를 서버 로그로 남긴다 (비용 추적).
- 모델 ID는 env `OPENAI_MODEL`. 하드코딩 금지.

파일 배치:

```
lib/ai/client.ts       # OpenAI 클라이언트 + callWithSchema() 공통 래퍼 (§4)
lib/ai/prompts.ts      # §2·§3의 프롬프트 원문 (상수로)
lib/ai/schemas.ts      # §2·§3의 JSON Schema + 대응하는 zod 스키마
scripts/eval-cards.ts  # §5 평가 하네스
```

## 2. 호출 A — 표지 판독 (vision)

### 2-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 어린이 영어 원서의 표지와 정보 스티커를 판독하는 사서다.
사진에서 '실제로 보이는 것만' 추출한다. 보이지 않는 값은 null로 둔다. 추측 금지.

읽을 것:
- 표지: 제목, 저자, 시리즈명 (예: "National Geographic Kids Readers",
  "A Winnie the Pooh First Reader")
- 한국 원서몰·영어도서관 정보 스티커(있는 경우): AR(예: "AR : 3.3"),
  Lexile(예: "570L"), Word Count(단어 수), AR Quiz No(퀴즈 번호),
  Fiction / NonFiction 구분

규칙:
- Lexile은 숫자만 추출한다 (570L → 570). AR은 소수(3.3), Word Count는 정수.
- 스티커에 Fiction/NonFiction 표기가 없으면 표지·시리즈로 판단하되 확신이 없으면 null.
- topicGuess에는 표지 그림과 제목으로 파악한 책 주제를 한국어 한 줄로 쓴다.
- coverEmoji에는 책 주제와 어울리는 이모지 1개를 고른다.
- 책 표지 사진이 아니거나 제목조차 읽을 수 없으면 isBookCover를 false로 한다.
```

### 2-2. 사용자 메시지

이미지 1~2장(base64 data URL, `input_image`) + 텍스트 `"이 책을 판독해줘."`

### 2-3. 출력 JSON Schema — `book_extraction` (strict)

```json
{
  "name": "book_extraction",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "isBookCover": { "type": "boolean", "description": "책 표지 사진이 맞는지" },
      "title":      { "type": ["string", "null"] },
      "author":     { "type": ["string", "null"] },
      "series":     { "type": ["string", "null"] },
      "arLevel":    { "type": ["number", "null"], "description": "예: 3.3" },
      "lexile":     { "type": ["integer", "null"], "description": "예: 570" },
      "wordCount":  { "type": ["integer", "null"] },
      "arQuizNo":   { "type": ["string", "null"] },
      "isFiction":  { "type": ["boolean", "null"] },
      "topicGuess": { "type": ["string", "null"], "description": "한국어 한 줄" },
      "coverEmoji": { "type": ["string", "null"] }
    },
    "required": ["isBookCover", "title", "author", "series", "arLevel", "lexile",
                 "wordCount", "arQuizNo", "isFiction", "topicGuess", "coverEmoji"]
  }
}
```

### 2-4. 후처리

- `isBookCover=false` 또는 `title=null` → 사용자에게 "다시 찍어주세요" + 수동 입력 폼 폴백.
- 판독 결과는 Google Books 식별 단계(개발 프롬프트 §3-(2))의 검색어로 사용.

## 3. 호출 B — 카드 생성

### 3-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 초등학생 아이와 영어 원서를 함께 읽는 한국인 부모를 돕는 아동 독서 교육 전문가다.
주어진 책 메타데이터(제목·저자·시리즈·난이도·주제·공개 소개글)만 근거로 학습 카드 1장을 만든다.

[절대 규칙]
1. 책의 실제 본문 문장을 인용·복원·추측 재현하지 않는다. 단어 예문은 전부 새로 창작한다.
2. 책 내용을 확실히 알지 못하면 줄거리를 단정하는 질문 대신 제목·주제·표지 기반 질문으로
   구성한다. 아는 책이라도 세부 서술을 옮기지 말고 일반적인 수준으로만 다룬다.
3. 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[대상과 말투]
- 아이: 한국 초등학생, 영어 학습 중. 부모: 한국어 사용자, 카드를 보고 아이를 이끌 사람.
- 영어는 짧고 쉽게(질문은 15단어 이하). 한국어는 아이에게 말 걸듯 다정하게.
- hintKo는 부모용 실전 코칭이다: 정답, 칭찬 멘트, 후속 질문 요령.

[bookIntroKo / levelNoteKo]
- bookIntroKo: 2문장. 아이가 "읽고 싶다"는 마음이 들게.
- levelNoteKo: AR 수치의 의미를 부모에게 1문장으로 풀어준다
  (예: "AR 3.3은 미국 3학년 세 번째 달 수준이라는 뜻이에요").
  레벨이 미상이면 추정 근거를 밝히고 '추정'임을 명시한다.

[vocab — 단어 선정]
- 개수: AR<2 → 10개 / AR 2~3.5 → 12개 / AR>3.5 → 12개(challenge 3개 포함) / 미상 → 12개.
- the, and, is 같은 기초 사이트워드와 초등 기초 어휘(교육부 800 수준)는 제외한다.
  이 책의 주제·레벨에서 '새로 배울' 단어만 고른다.
- 주제 어휘 중심으로 고른다 (늑대 논픽션이면 pack, howl, den, prey 같은 단어).
- 제목의 핵심 단어는 반드시 포함하고 isCore를 true로 표시한다 (1개만).
- difficulty: challenge는 2~3개, 나머지는 basic.
- pronKo는 한글 발음 표기(예: "팩"), easyEn은 아이 눈높이 영영 풀이(예: "a wolf family"),
  exampleEn은 4~8단어의 창작 예문으로 대상 단어를 그대로 포함한다.
- 불규칙 복수형(wolf→wolves), 유사 발음 쌍(pull/full) 같은 가르칠 거리가 보이면
  teachingTipKo에서 하나만 골라 깊게 다룬다.

[questions — FairytaleQA 유형 체계]
- 8개(AR<2는 6개), 유형 중복 없이.
- 픽션: 인물, 사건, 인과, 감정, 예측, 결말, 나와연결을 반드시 포함.
- 논픽션: 사실확인 2개와 인과, 비교, 상상, 내생각, 나와연결을 포함.
- 순서: 쉬운 확인 질문 → 생각을 여는 질문 → 마지막은 반드시 아이의 일상과 연결(나와연결).
- 정답이 있는 질문은 hintKo에 정답과 칭찬 멘트를, 열린 질문은 후속 질문 팁을 담는다.
  hintKo는 전체의 절반 정도에만 단다.

[funFacts — 논픽션 전용]
- 논픽션이면 4개, 픽션이면 null.
- 널리 알려진 일반 상식 수준의 사실만 쓴다. 특정 책의 서술을 옮기지 않는다.
- en은 한 문장, ko는 자연스러운 우리말.

[beforeReading / whileReading / activities]
- beforeReading 2개: 표지 추리 놀이 1개 + 배경지식 깨우기 1개.
- whileReading 3개: 특정 단어가 나오면 동작하기처럼 몸으로 하는 미션형.
  책의 특정 문장·페이지에 의존하지 않는 활동으로 만든다.
- activities 2개: 읽은 뒤의 몸놀이·생활 연계 놀이. titleKo와 2~3문장의 descKo.
```

### 3-2. 사용자 메시지 템플릿

```
[책 정보]
제목: {title}
저자: {author}
시리즈: {series ?? "정보 없음"}
구분: {isFiction ? "픽션" : "논픽션"}
AR: {arLevel ?? "미상(레벨 추정 필요)"} / Lexile: {lexile ?? "미상"} / 단어 수: {wordCount ?? "미상"}
주제: {topic}
공개 소개글: {googleBooksDescription ?? "없음"}

[아이 정보]
한국 초등학생, 한국어가 모국어. {childNote ?? ""}

이 책의 학습 카드를 만들어줘.
```

### 3-3. 출력 JSON Schema — `learning_card` (strict)

```json
{
  "name": "learning_card",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "bookIntroKo": { "type": "string" },
      "levelNoteKo": { "type": "string" },
      "beforeReading": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": { "ko": { "type": "string" } }, "required": ["ko"]
        }
      },
      "vocab": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "word":       { "type": "string" },
            "pronKo":     { "type": "string" },
            "meaningKo":  { "type": "string" },
            "easyEn":     { "type": "string" },
            "exampleEn":  { "type": "string" },
            "difficulty": { "type": "string", "enum": ["basic", "challenge"] },
            "isCore":     { "type": ["boolean", "null"] }
          },
          "required": ["word", "pronKo", "meaningKo", "easyEn", "exampleEn",
                       "difficulty", "isCore"]
        }
      },
      "teachingTipKo": { "type": "string" },
      "whileReading": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": { "ko": { "type": "string" } }, "required": ["ko"]
        }
      },
      "questions": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "type": { "type": "string",
              "enum": ["사실확인", "인물", "배경", "사건", "인과", "감정",
                       "예측", "결말", "비교", "상상", "내생각", "나와연결"] },
            "en":     { "type": "string" },
            "ko":     { "type": "string" },
            "hintKo": { "type": ["string", "null"] }
          },
          "required": ["type", "en", "ko", "hintKo"]
        }
      },
      "funFacts": {
        "type": ["array", "null"],
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": { "en": { "type": "string" }, "ko": { "type": "string" } },
          "required": ["en", "ko"]
        }
      },
      "activities": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": { "titleKo": { "type": "string" }, "descKo": { "type": "string" } },
          "required": ["titleKo", "descKo"]
        }
      }
    },
    "required": ["bookIntroKo", "levelNoteKo", "beforeReading", "vocab",
                 "teachingTipKo", "whileReading", "questions", "funFacts", "activities"]
  }
}
```

## 4. 공통 래퍼 명세 — `callWithSchema()`

```
입력: { call: 'extract' | 'card',
        system: string,
        user: (텍스트 | 이미지) 배열,
        jsonSchema, zodSchema,
        temperature, maxOutputTokens }

동작:
1. OpenAI Responses API 호출 (response_format: json_schema, strict)
2. JSON 파싱 → zodSchema.safeParse()
3. 실패 시: 원래 메시지 + "다음 검증 오류를 고쳐 다시 출력해: {오류}"로 1회 재요청
4. 재요청도 실패하면 throw (라우트에서 사용자에게 재시도 버튼 노출)
5. 성공/실패 무관 로깅: { call, model, inputTokens, outputTokens, ms }

zod 추가 검증(스키마가 못 잡는 것):
- vocab 길이: AR<2 → 10, 그 외 → 12. word 소문자 중복 금지
- vocab 금지어: 내장 사이트워드 목록(§5)과 대조
- questions 길이: AR<2 → 6, 그 외 → 8. type 중복 금지
- 픽션 → funFacts === null, 논픽션 → funFacts 4개
- beforeReading 2개, whileReading 3개, activities 2개
- isCore가 true인 vocab이 정확히 1개
```

## 5. 평가 하네스 — `scripts/eval-cards.ts`

프롬프트를 고칠 때마다 돌리는 자동 점검입니다 (프롬프트도 코드처럼 회귀 테스트).

- 입력: 개발 프롬프트 §12의 픽스처 2권(Wolves, Pooh Gets Stuck)으로 실제 카드 생성
- 점검 항목:
  1. §4의 zod 추가 검증 전부 통과
  2. 사이트워드 차단 목록에 걸리는 단어 0개 — 목록(소문자 비교): `the, a, an, and, or, but, is, am, are, was, were, be, to, of, in, on, at, it, he, she, we, you, they, i, my, your, his, her, this, that, there, here, go, goes, come, see, look, like, want, can, will, do, does, did, have, has, had, get, got, make, say, said, good, big, small, one, two, three, yes, no, not, up, down, out, with, for, from, day, time, boy, girl, mom, dad`
  3. 영어 질문 15단어 이하, exampleEn 8단어 이하
  4. hintKo 보유율 30~70%
  5. 질문의 en/ko 짝이 모두 채워져 있고 ko에 영어 문장이 그대로 남아있지 않음
- 출력: 항목별 pass/fail 표. 하나라도 실패하면 exit code 1
- `package.json`에 `"eval:cards": "tsx scripts/eval-cards.ts"` 등록. 실행에는 `OPENAI_API_KEY` 필요(실호출 2회 발생) — CI가 아니라 수동 실행용

## 6. 운영 메모

- 카드 1장 = AI 호출 2회(사진 입력 시) + Google Books 1회. 토큰 로그로 월 비용을 추정할 것.
- 프롬프트 수정 → `npm run eval:cards` → 통과 확인 → 커밋. 이 순서를 README에 명시.
- 아이 반응을 보고 조정할 만한 다이얼: 단어 개수, challenge 비율, 질문의 열림/닫힘 비율, hintKo 밀도. 전부 §3-1 프롬프트의 숫자만 바꾸면 된다.

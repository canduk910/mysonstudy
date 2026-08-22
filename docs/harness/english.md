# AI 하네스 명세 — 은우 북카드 (OpenAI)

**은우학습 프로젝트 · 2026-08-15 · 저장소에는 `docs/harness/english.md`로 저장**

> **하네스란?** LLM 호출을 감싸는 뼈대입니다 — 프롬프트, 출력 스키마, 검증, 재시도, 로깅을 한 세트로 묶은 것.
> 말과 마차를 잇는 마구(harness)처럼, 모델의 힘이 정확한 방향으로만 나가게 잡아주는 장치예요.
> 이 문서의 프롬프트와 스키마는 **완성본**입니다. 클로드코드에게 "docs/harness/english.md 명세대로 `lib/ai/english/`를 구현해"라고 전달하면 그대로 코드가 됩니다.

> **과목 공통 규약은 `docs/HARNESS.md`에 있습니다.** 서버 전용 호출·Structured Outputs·zod 이중 검증·1회 재요청·
> 호출 로깅 shape·모델 ID env화·배열 개수 제약의 위치 — 영어와 수학이 똑같이 지키는 규칙들입니다.
> 아래 §1의 "공통 규칙"은 그 규약을 영어 맥락에서 다시 적은 것으로, 두 문서는 같은 내용을 말합니다.

## 1. 구성 개요

앱의 AI 호출은 4종입니다.

| 호출 | 목적 | 성격 | temperature | 출력 한도 |
|---|---|---|---|---|
| **A. 표지 판독** | 표지·스티커 사진 → 책 메타데이터 + 뒤표지 블러브 | 정확성 우선 (보이는 것만) | 0 | ~2,000 토큰 |
| **A′. 본문·목차 판독** | 본문/목차 사진 N장 → 장면별 요약 | 판독 정확성 + 질문 창작 | 0.3 | ~4,000 토큰 / 배치 |
| **B. 카드 생성** | 메타데이터 + 근거 → 학습 카드 | 창작 품질 우선 | 0.7 | ~6,000 토큰 |
| **C. 단어장 판독** | 단어장 페이지 사진 → 책 그대로 전사한 단어 목록 | 전사 정확성 (책 원문 보존, 창작 금지) | 0 | ~6,000 토큰 / 사진 |

호출 C는 **단어장 정복** 기능(§7)의 판독 호출로, A→A′→B 카드 파이프라인과는 별개의 경로입니다.
사진 1장 = 판독 1회이고, DAY 하나가 사진 여러 장이면 병렬 호출 후 앱이 번호로 병합합니다(§7-5).

호출 A′는 사진 6장씩 배치로 나눠 **병렬 호출**합니다 (§2A-5). 카드 1장에 대한 호출 수는
`1(A) + ceil(N/6)(A′) + 1(B)`입니다.

파이프라인:

```
표지·스티커·뒤표지 1~3장 ──▶ 호출 A  ──▶ 메타데이터 + blurbText
본문/목차 사진 N장 ──▶ 호출 A′ ──▶ 장면별 요약(sceneDigest)
메타데이터 + 공개 소개글 + blurbText + sceneDigest ──▶ 호출 B ──▶ 학습 카드
```

본문 사진을 호출 B에 그대로 붙이지 않고 A′로 분리한 이유: 이미지 토큰이 한 호출에 몰리지
않고, 실패가 배치 안에 갇히고, 무엇보다 **"다시 생성"이 사진 재업로드 없이 저장된 요약만으로
된다**. 원본 사진은 저장하지 않는다 — 요약 텍스트만 남기면 권당 수 KB다.

공통 규칙:

- 모든 호출은 **서버(route handler)에서만**. API 키 클라이언트 노출 금지.
- OpenAI **Responses API** + **Structured Outputs**(`json_schema`, `strict: true`).
- 응답은 **zod로 이중 검증**. 실패 시 검증 오류 메시지를 첨부해 **1회만 재요청**, 그래도 실패면 throw.
- 배열 개수 제약(단어 12개, 질문 8개 등)은 스키마가 아니라 **프롬프트 + zod**에서 강제한다. (strict 모드의 `minItems`/`maxItems` 지원 여부는 모델·버전에 따라 다르니 스키마에는 넣지 않는다)
- 호출마다 `{call, model, inputTokens, outputTokens, ms}`를 서버 로그로 남긴다 (비용 추적).
- 모델 ID는 env `OPENAI_MODEL`. 하드코딩 금지.

파일 배치:

```
lib/ai/client.ts             # OpenAI 클라이언트 + callWithSchema() 공통 래퍼 (§4) — 과목 공유
lib/ai/english/prompts.ts    # §2·§3의 프롬프트 원문 (상수로)
lib/ai/english/schemas.ts    # §2·§3의 JSON Schema + 대응하는 zod 스키마
scripts/eval-english.ts      # §5 평가 하네스
```

`lib/ai/client.ts`는 수학코치와 함께 쓰는 모듈이다. 과목별 분기는 client가 아니라 호출부에 둔다.

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
- 뒤표지·책날개의 출판사 소개글(블러브): 사진에 보이면 blurbText에 옮긴다.

규칙:
- Lexile은 숫자만 추출한다 (570L → 570). AR은 소수(3.3), Word Count는 정수.
- 스티커에 Fiction/NonFiction 표기가 없으면 표지·시리즈로 판단하되 확신이 없으면 null.
- blurbText는 출판사가 책을 소개하려고 쓴 홍보 문구다. 보이는 만큼만 옮기고 줄바꿈은 공백으로 합친다.
  이야기 본문·차례·서평 인용·바코드 주변 정보는 넣지 않는다. 소개글이 안 보이면 null.
- topicGuess에는 표지 그림과 제목으로 파악한 책 주제를 한국어 한 줄로 쓴다.
- coverEmoji에는 책 주제와 어울리는 이모지 1개를 고른다.
- 책 표지 사진이 아니거나 제목조차 읽을 수 없으면 isBookCover를 false로 한다.
```

### 2-2. 사용자 메시지

이미지 1~3장(표지 / 정보 스티커 / 뒤표지, base64 data URL, `input_image`) + 텍스트 `"이 책을 판독해줘."`

상한이 3장인 이유는 SPEC §4-1 참조 — 뒤표지 소개글(blurbText)이 줄거리의 실질 근거인데
2장이면 정보 스티커와 뒤표지 중 하나를 포기해야 한다.

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
      "coverEmoji": { "type": ["string", "null"] },
      "blurbText":  { "type": ["string", "null"], "description": "뒤표지·책날개 출판사 소개글" }
    },
    "required": ["isBookCover", "title", "author", "series", "arLevel", "lexile",
                 "wordCount", "arQuizNo", "isFiction", "topicGuess", "coverEmoji",
                 "blurbText"]
  }
}
```

### 2-4. 후처리

- `isBookCover=false` 또는 `title=null` → 사용자에게 "다시 찍어주세요" + 수동 입력 폼 폴백.
- 판독 결과는 Google Books 식별 단계(개발 프롬프트 §3-(2))의 검색어로 사용.
- `blurbText`는 호출 B의 `뒤표지·책날개 소개글` 슬롯(§3-2)으로 전달하고, books 레코드에 보관한다
  — "다시 생성" 시 사진 재업로드 없이 같은 근거를 다시 쓸 수 있어야 한다.

## 2A. 호출 A′ — 본문·목차 판독 (vision)

본문/목차 사진 N장을 받아 **장면별 요약(sceneDigest)** 을 만드는 호출입니다. 결과는 호출 B의
줄거리 근거가 되고, 카드에 그대로 실려 부모가 장면마다 질문을 던질 수 있게 합니다.

> 절대 원칙(SPEC §1): 본문 이미지는 **요약 생성의 근거로만** 쓰고 **원문을 그대로 옮겨 적지
> 않는다.** 저작권이 아니라 제품 품질 때문이다 — 부모가 원하는 건 아이를 이끌 한국어 맥락이지
> 영어 원문이 아니다. 원문은 이미 책으로 손에 들고 있다.

### 2A-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 아이와 영어 그림책·챕터북을 함께 읽는 한국인 부모를 돕는 독서 교육 전문가다.
부모가 순서대로 찍어 보낸 책 사진을 보고, 읽기 전에 훑어볼 '장면 메모'를 우리말로 만든다.

[이 메모의 목적]
- 부모가 원하는 것은 아이를 이끌 한국어 맥락이지 영어 원문이 아니다. 원문은 이미 책으로 손에 들고 있다.
- 그러니 사진의 글을 받아쓰지 말고, 그 장면에서 무슨 일이 일어나는지를 우리말로 요약한다.
  영어 문장을 그대로 옮겨 적은 메모는 실패한 메모다.

[모드]
- 본문(pages): 사진 1장이 장면 1개다. 사진 순서 그대로 장면을 만들고, 합치거나 나누지 않는다.
  글이 거의 없는 그림 위주 면이면 그림에서 읽히는 상황을 요약한다.
- 목차(toc): 목차 사진에서 챕터를 순서대로 읽어 챕터 1개 = 장면 1개로 만든다.
  챕터 제목은 본문이 아니라 구조 정보이므로 labelKo에 그대로 옮겨도 된다.
  summaryKo에는 제목에서 짐작되는 흐름을 우리말로 쓰되, 짐작임이 드러나게 쓴다.

[필드]
- labelKo: 어디인지 부모가 바로 알아볼 짧은 이름. 쪽번호가 보이면 "12~13쪽",
  안 보이면 "여섯 번째 사진", 목차 모드면 "3장: Pooh와 꿀단지"처럼 쓴다.
- summaryKo: 1~3문장. 누가 무엇을 했고 무엇이 달라졌는지. 그림에만 있는 정보도 함께 담는다.
- askKo: 그 자리에서 부모가 아이에게 던질 질문 1개를 우리말로 쓴다. 이 메모의 핵심이다.
  책 전체가 아니라 '지금 이 장면'에 대한 질문이어야 한다.
  예/아니오로 끝나는 질문은 피하고, 아이가 그림을 다시 보게 하거나 다음을 예상하게 하는 질문으로 쓴다.
  사진이 흐려 내용을 읽지 못한 장면(confidence: low)에서만 null로 둔다.
- confidence: 선명하고 내용이 분명하면 high, 일부만 읽히면 medium,
  흐리거나 빛 반사로 거의 못 읽으면 low. 못 읽은 것을 읽은 척하지 않는다.
- gapBefore: 앞 장면에서 이야기가 건너뛴 느낌이면 true. 촬영 순서가 뒤바뀌었거나 사진이 빠진 것이다.
  빠진 부분을 상상해서 메우지 말고 true로 표시만 한다. 자연스럽게 이어지면 false.

[결말]
- 마지막 구간이라고 알려준 묶음에서는 결말을 직접 쓰지 않는다.
  어떻게 끝나는지는 아이가 책에서 확인하게 남겨 두고, 궁금해지는 선에서 닫는다.

[금지]
- 사진에 없는 내용을 지어내지 않는다. 못 읽었으면 confidence를 낮추고 읽은 만큼만 쓴다.
- 영어 원문을 그대로 옮겨 적지 않는다 (제목·챕터 제목·등장인물 이름은 예외).
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.
```

### 2A-2. 사용자 메시지 템플릿

배치의 이미지(base64 data URL, `input_image`) 다음에 아래 텍스트를 붙입니다.

```
[책 정보]
제목: {title ?? "미상"}
저자: {author ?? "미상"}
구분: {isFiction === null ? "미상" : isFiction ? "픽션" : "논픽션"}
주제: {topic ?? "미상"}

[이번 사진 묶음]
모드: {sourceKind === "toc" ? "목차" : "본문"}
사진 {imageCount}장 (전체 {totalImageCount}장 중 {fromImageIndex}~{toImageIndex}번째)
시작 장면 번호(seq): {startSeq}
{isFinalBatch ? "이 묶음은 책의 마지막 구간이다. 결말을 직접 쓰지 마라."
              : "이 묶음은 책의 마지막 구간이 아니다."}

사진 순서대로 장면 메모를 만들어줘.
```

`isFinalBatch`는 배치 인덱스로 앱이 판단한다 — 모델은 자기 배치가 책의 어디쯤인지 모르므로,
결말 노출 방지를 모델의 짐작에 맡기지 않는다.

### 2A-3. 출력 JSON Schema — `page_digest` (strict)

```json
{
  "name": "page_digest",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "sourceKind": { "type": "string", "enum": ["toc", "pages"] },
      "scenes": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "seq":        { "type": "integer", "description": "촬영 순서(1부터)" },
            "labelKo":    { "type": "string", "description": "예: \"12~13쪽\" 또는 \"3장: Pooh와 꿀단지\"" },
            "summaryKo":  { "type": "string", "description": "1~3문장 우리말 요약" },
            "askKo":      { "type": ["string", "null"], "description": "이 장면에서 부모가 던질 질문 1개" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
            "gapBefore":  { "type": "boolean", "description": "앞 장면과 내용이 이어지지 않으면 true" }
          },
          "required": ["seq", "labelKo", "summaryKo", "askKo", "confidence", "gapBefore"]
        }
      }
    },
    "required": ["sourceKind", "scenes"]
  }
}
```

### 2A-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- sourceKind가 요청한 모드와 일치
- scenes 1개 이상. pages 모드는 scenes 길이 == 이 배치의 사진 장수
  ("사진 1장 = 장면 1개" — 합치기·나누기를 막아야 사진 순서와 장면 순서가 어긋나지 않는다)
- seq 중복 금지 + 오름차순 (최종 번호는 병합 단계에서 다시 매긴다)
- askKo는 필수. confidence === "low"인 장면에서만 null 허용
- summaryKo에 한글이 있어야 하고, 영어 단어가 8개 이상 연속되면 거부 (원문 전사 차단)
- 길이 상한 (소비자 /api/card 입력 zod와 **같은 값**, 상수는 schemas.ts 단일 정의처):
  labelKo 120자 · summaryKo 1,000자 · askKo 500자 · 장면 수 120개
  생산 시점에 걸어야 1회 재요청이 그 자리에서 교정한다. 소비자에만 있으면 사용자가
  본문을 다 찍고 A′ 값을 치른 뒤에야 카드 생성이 400으로 죽는다
- seq는 병합 단계에서 다시 매기므로 상한을 걸지 않는다 (덮어쓸 값으로 재요청을 유발하지 않는다)
```

### 2A-5. 배치 분할과 병합

```
- 사진을 6장(PAGES_BATCH_SIZE)씩 나눠 Promise.allSettled로 병렬 호출한다
- 한 배치가 실패하면 그 배치의 사진만 잃는다 — 나머지 장면은 살려서 반환하고,
  실패한 배치 수를 함께 돌려준다 (부분 실패 안내용). 전 배치 실패면 throw
- 실패한 배치 뒤에 오는 첫 장면은 gapBefore=true로 강제한다.
  앱이 스스로 만든 누락이라 확실히 아는 구멍인데, 번호만 이어 붙이면 호출 B가
  매끄러운 목록으로 보고 빈 구간을 상상으로 메운다 (§2A-6 · SPEC §7-1′이 금지한 실패 모드)
  단, 마지막 배치가 실패한 경우의 '뒤쪽 누락'은 표시를 붙일 장면이 없다 —
  failedBatchCount로만 알리고 앱이 재촬영을 유도한다
- 모델이 돌려준 seq는 배치 안에서만 의미가 있다. 병합 시 촬영 순서대로 seq를 다시 매긴다
- 사진은 한 번에 최대 40장(PAGES_MAX_IMAGES)
- 병합 결과가 장면 수 상한(MAX_SCENE_DIGEST_ITEMS=120)을 넘으면 뒤쪽을 잘라내고
  truncatedSceneCount로 보고한다. 배치별 zod는 배치 하나의 초과만 잡을 수 있어,
  배치를 넘나드는 합계 초과(toc 3배치 × 60장면)는 여기서만 막힌다.
  통째로 실패시키지 않는 이유는 사용자가 이미 A′ 값을 치렀기 때문이다 — 120장면이면
  실사용에 차고 넘치므로, 뒤쪽을 버리더라도 카드를 만들어 내는 쪽이 낫다
- throw는 종류를 구분할 수 있어야 한다 (라우트가 상태코드를 고른다):
  invalid_input(사진 0장·상한 초과) → 400 / ai_failed(전 배치 실패) → 500
```

### 2A-6. 후처리

- 결과 `sceneDigest`는 (a) 호출 B의 `[본문 장면 메모]` 슬롯(§3-2)에 넣고, (b) 카드에 그대로
  붙여 저장한다(`attachSceneDigest`). **호출 B에게 되돌려 받지 않는다** — 출력 토큰만 늘고
  요약이 변조될 위험이 있다.
- `confidence: "low"`가 섞여 있으면 해당 장면의 재촬영을 유도한다.
- `gapBefore: true`는 촬영 순서 뒤바뀜·사진 누락 신호다. 앱은 사실만 알리고, 빠진 내용을
  채우려 하지 않는다.
- **원본 사진은 저장하지 않는다** (SPEC §5). 요약 텍스트만 books/cards에 남긴다.

## 3. 호출 B — 카드 생성

### 3-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 초등학생 아이와 영어 원서를 함께 읽는 한국인 부모를 돕는 아동 독서 교육 전문가다.
주어진 책 메타데이터(제목·저자·시리즈·난이도·주제·공개 소개글)와, 부모가 찍어 보내 준
뒤표지 소개글·본문 장면 메모를 근거로 학습 카드 1장을 만든다.

[절대 규칙]
1. 근거로 받은 글은 요약의 재료로만 쓰고, 책의 영어 원문을 그대로 옮겨 적지 않는다.
   부모가 원하는 것은 아이를 이끌 한국어 맥락이지 영어 원문이 아니다 — 원문은 이미 책으로 손에 들고 있다.
   단어 예문은 전부 새로 창작한다.
2. 받은 근거를 넘어서는 내용을 지어내지 않는다. 근거가 얇으면 줄거리를 단정하는 질문 대신
   제목·주제·표지 기반 질문으로 구성한다. 아는 책이라도 세부 서술을 옮기지 말고 큰 흐름만 다룬다.
3. 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[대상과 말투]
- 아이: 한국 초등학생, 영어 학습 중. 부모: 한국어 사용자, 카드를 보고 아이를 이끌 사람.
- 영어는 짧고 쉽게(질문은 15단어 이하). 한국어는 아이에게 말 걸듯 다정하게.
- hintKo는 부모용 실전 코칭이다: 정답, 칭찬 멘트, 후속 질문 요령.
- 글 안에서 보호자를 부를 때는 "엄빠"라고 쓴다. "아빠"나 "엄마"로 한쪽만 부르지 않는다.

[bookIntroKo / levelNoteKo]
- bookIntroKo: 2문장. 아이가 "읽고 싶다"는 마음이 들게.
- levelNoteKo: AR 수치의 의미를 부모에게 1문장으로 풀어준다
  (예: "AR 3.3은 미국 3학년 세 번째 달 수준이라는 뜻이에요").
  레벨이 미상이면 추정 근거를 밝히고 '추정'임을 명시한다.

[storyOutlineKo / storySource — 줄거리 미리보기]
- storyOutlineKo: 아이가 읽기 전에 이야기 흐름을 알고 따라갈 수 있게 우리말로 쉽게 쓴다.
- 분량은 [줄거리 분량] 블록이 지정한 문장 수를 따른다. 그 구간은 이번에 받은 근거의 '양'에서
  계산한 값이다 — 근거가 얇으면 구간도 짧아진다. 그러니 구간을 채우려고 지어낼 일이 없어야 한다.
  거꾸로 근거가 두꺼운데 짧게 끝내도 안 된다. 부모가 맥락을 잡지 못하면 이 미리보기는 쓸모가 없다.
  받은 근거를 구간 안에서 최대한 살려 쓴다.
- storySource에는 실제로 근거로 삼은 것 중 가장 두꺼운 것을 적는다:
  metadata(제목·주제·표지·공개 소개글) / blurb(뒤표지·책날개 소개글) / toc(목차) / pages(본문 장면 메모).
  받지 못한 근거는 적을 수 없다. 받았더라도 실제로 도움이 되지 않았다면 낮춰 적는다.
- 본문 장면 메모가 있으면 그 순서대로 흐름을 이어 쓴다. 메모에 없는 사건을 채워 넣지 않는다.
  메모에 '앞 장면과 이어지지 않음' 표시가 있으면 그 사이를 상상해서 메우지 말고,
  두 장면을 억지로 잇지 않은 채 큰 흐름만 이어 쓴다.
- 결말은 직접 말하지 않는다. 마지막 문장은 결말이 궁금해지게 닫는다.
  본문 장면 메모까지 본 경우에는 결말을 이미 알고 있으므로 특히 조심한다.
- 논픽션이면 줄거리 대신 책이 다루는 내용을 아이 눈높이로 순서대로 소개한다.
- [절대 규칙] 1·2는 여기에도 그대로 적용된다: 영어 원문을 옮기지 말고, 세부 서술이 아니라 큰 흐름만 쓴다.

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
- 논픽션: 사실확인, 인과, 비교, 상상, 내생각, 나와연결을 포함.
- 순서: 쉬운 확인 질문 → 생각을 여는 질문 → 마지막은 반드시 아이의 일상과 연결(나와연결).
- 정답이 있는 질문은 hintKo에 정답과 칭찬 멘트를, 열린 질문은 후속 질문 팁을 담는다.
  hintKo는 전체의 절반에만 단다 — 8개면 4개, 6개면 3개. 나머지 질문은 hintKo를 null로 둔다.

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
뒤표지·책날개 소개글: {blurbText ?? "없음"}

[본문 장면 메모]
{sceneDigest 블록 ?? "없음"}

[줄거리 분량]
{줄거리 분량 블록}

[아이 정보]
한국 초등학생, 한국어가 모국어. {childNote ?? ""}

이 책의 학습 카드를 만들어줘.
```

`sceneDigest 블록`은 호출 A′ 결과를 아래 형태로 편다 (장면이 없으면 통째로 `"없음"`):

```
출처: {sceneKind === "toc" ? "목차 판독" : "본문 촬영"}
{seq}. [{labelKo}] {summaryKo}{ (앞 장면과 이어지지 않음 · 판독 불확실) }
...
```

괄호 표시는 해당하는 것만 붙인다 — `gapBefore=true`면 "앞 장면과 이어지지 않음",
`confidence="low"`면 "판독 불확실". 둘 다 없으면 괄호 자체를 붙이지 않는다.

**`sceneDigest`가 있는데 `sceneKind`가 비어 있으면 `pages`로 본다.** 이 블록의 렌더링과
storySource 근거 게이트(§3-1·§4)가 **반드시 같은 기본값**을 써야 한다 — 어긋나면 프롬프트는
장면 메모를 보여주는데 zod는 그 근거의 주장을 금지해, 모델이 지시를 지킬수록 검증에서
떨어지고 재요청 후 throw로 직행한다. `sceneKind`는 선택 필드라 호출부가 빠뜨리기 쉽다.

`줄거리 분량 블록`은 **이번 호출의 근거 양에서 계산한 문장 수 구간**을 그대로 문장으로 박는다.
`storyOutlineSentenceRange(resolveAllowedStorySource(input), sceneDigest.length)`의 결과다
(`buildCardUserMessage` → `formatStoryLengthBlock`).

**분량 다이얼은 근거의 종류가 아니라 양에 비례한다.** 장면을 셀 수 없는 출처는 고정 구간을 쓰고,
셀 수 있는 출처(`toc`·`pages`)는 장면 수 N에서 계산한다:

| 근거 | 구간 |
|------|------|
| `metadata` | 3~4문장 (고정) |
| `blurb` | 4~6문장 (고정) |
| `toc` · `pages` | 하한 `⌈N/2⌉+2`, 상한 `N+2` — 절대 경계 3~10문장, 하한은 8까지만 올라간다 |

계산 근거: 하한은 장면을 둘씩 묶어 쓰고(⌈N/2⌉) 도입·훅 각 1문장 — 가장 압축해도 이만큼 나온다.
상한은 장면마다 한 문장씩(N) 쓰고 도입·훅 각 1문장 — 지어내지 않는 최대치. 절대 상한 10문장은
카드가 A4 1~2쪽 인쇄물이라는 제약(SPEC §4-2)에서, 절대 하한 3문장은 메타데이터만으로도
써야 하는 최소 맥락에서 온다. 결과: 4장면 → 4~6문장, 기본 시나리오인 12~16장면 → 8~10문장.

**종류만 보는 평평한 구간(예전 `pages` 일괄 6~8문장)으로 되돌리지 말 것.** 4장면짜리 얇은 근거와
16장면짜리 두꺼운 근거가 같은 분량을 요구받게 되고, 얇은 쪽에서는 모델이 근거를 넘어 부풀리거나
(절대 규칙 2 위반) 규칙을 지키고 eval에서 떨어지거나 둘 중 하나가 된다. 실제로 4장면 픽스처가
이 실패를 냈다(5문장 산출 → 6~8 요구 미달). 다이얼이 근거 양을 보게 고쳐서 해결했다 —
모델을 더 조여서 해결하지 않았다.

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
      "storyOutlineKo": { "type": "string" },
      "storySource": { "type": "string",
        "enum": ["metadata", "blurb", "toc", "pages"] },
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
    "required": ["bookIntroKo", "levelNoteKo", "storyOutlineKo", "storySource",
                 "beforeReading", "vocab", "teachingTipKo", "whileReading",
                 "questions", "funFacts", "activities"]
  }
}
```

`sceneDigest`는 이 스키마에 없다 — 호출 A′의 결과를 앱이 카드에 붙여 저장한다(§2A-6).
모델에게 되돌려 받으면 출력 토큰만 늘고 요약이 변조될 위험이 있다.

### 3-4. storySource와 하위 호환

`storySource`는 기존 불리언 `storyIsGuess`를 대체한다. 카드 배지 문구는
`metadata → "예상" / blurb → "소개글 기반" / toc → "목차 기반" / pages → "본문 확인"`.

기존에 저장된 카드에는 `storySource`가 없고 `storyIsGuess`만 있다. 배지 판정은 반드시
`resolveStorySource(card)`를 거친다:

| 저장된 값 | 배지 |
|---|---|
| `storySource` 있음 | 그 값의 배지 |
| `storySource` 없음 + `storyIsGuess === true` | `metadata` → "예상" (구 UI와 동일) |
| `storySource` 없음 + `storyIsGuess === false` | 배지 없음 (구 UI와 동일) |
| 둘 다 없음 (더 오래된 카드) | 배지 없음 — 미리보기 섹션 자체를 생략 |

## 4. 공통 래퍼 명세 — `callWithSchema()`

```
입력: { call: 'extract' | 'pages' | 'card',
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
- storySource가 이 호출에 실제로 넘긴 근거를 넘지 않음
  (근거 순서 metadata < blurb < toc < pages. 낮춰 적는 것은 허용, 없는 근거를 주장하면 거부.
   비교는 반드시 랭크 `<=` — 등호로 조이면 프롬프트가 허용한 '낮춰 적기'를 거부하게 된다)
- 근거 판정 기준: sceneDigest가 있으면 sceneKind가 toc일 때만 toc, 그 외에는 pages.
  §3-2의 장면 메모 블록 렌더링과 같은 기본값이어야 한다
- storyOutlineKo에 영어 단어가 8개 이상 연속되면 거부 (원문 전사 차단)

호출 A′의 zod 추가 검증은 §2A-4.
```

## 5. 평가 하네스 — `scripts/eval-english.ts`

프롬프트를 고칠 때마다 돌리는 자동 점검입니다 (프롬프트도 코드처럼 회귀 테스트).

- 입력: 개발 프롬프트 §12의 픽스처 2권(Wolves, Pooh Gets Stuck)으로 실제 카드 생성.
  여기에 **Pooh + 장면 메모 14장면** 변형 1건을 더해 pages 경로(storySource·분량 8~10문장)를 잰다
  — 장면 메모는 사진 판독 결과가 아니라 스크립트에 고정된 데모 입력이다.
  **14장면인 이유**: 이 기능의 기본 시나리오가 그림책 펼침면 12~16장이다(SPEC §2 (2′)).
  얇은 근거(4장면) 회귀는 `EVAL_THIN_PAGES=1`로 같은 3번째 호출에 끼워 돌린다 — 실호출은 그대로 3회
- 점검 항목:
  1. §4의 zod 추가 검증 전부 통과
  2. 사이트워드 차단 목록에 걸리는 단어 0개 — 목록(소문자 비교): `the, a, an, and, or, but, is, am, are, was, were, be, to, of, in, on, at, it, he, she, we, you, they, i, my, your, his, her, this, that, there, here, go, goes, come, see, look, like, want, can, will, do, does, did, have, has, had, get, got, make, say, said, good, big, small, one, two, three, yes, no, not, up, down, out, with, for, from, day, time, boy, girl, mom, dad`
  3. 영어 질문 15단어 이하, exampleEn 8단어 이하
  4. hintKo 보유율 30~70%
  5. 질문의 en/ko 짝이 모두 채워져 있고 ko에 영어 문장이 그대로 남아있지 않음
  6. storySource가 넘긴 근거를 넘지 않음 — **랭크 `<=` 비교(낮춰 적기 허용, 등호 금지)**.
     근거를 안 준 픽스처는 상한이 `metadata`라 사실상 등호로 조여진다
  7. storyOutlineKo 문장 수가 `storyOutlineSentenceRange(카드가 적은 storySource, 넘긴 장면 수)`
     구간 안 — **프롬프트에 박아 보낸 것과 같은 함수로 잰다**(§3-2 표). 카드가 storySource를
     낮춰 적었으면 낮춘 근거의 구간으로 잰다 (프롬프트도 그렇게 지시한다)
  8. storyOutlineKo에 영어 원문 전사 없음 (연속 영어 8단어 미만 + 한글 포함)
  9. `resolveStorySource()`가 신규 카드의 storySource를 그대로 배지값으로 돌려줌
- 오프라인 점검(실호출 0회): 호출 A′의 zod 규칙을 고정 입력으로 검사한다 — 사진 장수와 장면
  수 불일치, askKo 누락, 영어 원문 전사, seq 역순, sourceKind 불일치가 실제로 거부되는지.
  구 카드(`storyIsGuess`만 있는 카드)의 배지 해석 2케이스도 함께 본다.
  영어 전사는 한글이 없는 경우와 **한글+영어 8단어 혼합** 두 케이스를 모두 본다
  (혼합 케이스가 없으면 "한글 없음" 규칙에 먼저 걸려 길이 규칙이 검증되지 않는다).
  실제 사진 판독은 사진이 있어야 재현되므로 eval이 실호출로 커버하지 않는다
- 출력: 항목별 pass/fail 표. 하나라도 실패하면 exit code 1
- `package.json`에 `"eval:english": "tsx scripts/eval-english.ts"` 등록. 실행에는 `OPENAI_API_KEY` 필요(실호출 3회 발생, `EVAL_SKIP_PAGES=1`이면 2회) — CI가 아니라 수동 실행용

## 6. 운영 메모

- 카드 1장 = AI 호출 `1(A) + ceil(N/6)(A′) + 1(B)`회 + Google Books 1회. 본문 사진 16장이면
  A′만 3회다 — 토큰 로그(`{call: "pages", ...}`)로 월 비용을 추정할 것.
- 프롬프트 수정 → `npm run eval:english` → 통과 확인 → 커밋. 이 순서를 README에 명시.
- 아이 반응을 보고 조정할 만한 다이얼: 단어 개수, challenge 비율, 질문의 열림/닫힘 비율, hintKo 밀도. 전부 §3-1 프롬프트의 숫자만 바꾸면 된다.
- 줄거리 분량 다이얼은 `storyOutlineSentenceRange()`(schemas.ts) **한 곳**에만 숫자가 있다.
  프롬프트는 이 함수의 결과를 [줄거리 분량] 블록에 계산해 박고(§3-2), eval 점검 7도 같은 함수로
  잰다 — 이 다이얼에 한해 "프롬프트 안의 숫자를 사람이 맞춰야 하는" 위험이 없다.
  다른 다이얼(단어 12개·질문 8개·hintKo 절반·15단어/8단어)은 여전히 §3-1 프롬프트 문장 안에
  숫자가 박혀 있어 상수와 사람이 맞춰야 한다.
- 분량 다이얼은 zod에서 **의도적으로 강제하지 않는다**(§4에 검증이 없는 이유). 문장 수는 품질
  다이얼이지 정합성 제약이 아니라서, zod로 막으면 조금 짧은 카드가 재요청 1회 후 throw가 되어
  부모에게 생성 실패로 보인다. 회귀는 eval 점검 7이 잡는다.

## 7. 호출 C — 단어장 판독 (vision, 단어장 정복 기능)

단어장 페이지 사진 1장을 받아 **책을 그대로 전사한 단어 목록**을 만드는 호출입니다. 결과는
앱이 번호로 병합해 DAY 하나의 단어 표가 됩니다.

> **절대 원칙(이 기능의 축):** 판독은 **책을 그대로 옮기는 일**이다. 예문·뜻·발음은 책 원문을
> 보존한다 — AI가 창작하는 것(영영정의·이모지)은 §8 호출 D(V3)의 몫이다. 호출 A′(§2A)가 본문을
> "요약"하는 것과 정반대다. 단어장 예문은 학습 목적 단문이고 DAY 화면 밖으로 공유·게시하지 않는
> 선을 지키므로, 여기서는 100% 전사한다(계획 §확정된 결정). 그래서 temperature 0.

세 덩이로 나눈 출처(구현 `VocabEntry`):
- **(A) 책 전사** — `no`·`word`·`ipa`·`pos`·`meaningsKo`·`examples`·`related`. 호출 C가 책 그대로 옮긴다.
- **(B) AI 창작** — `definitionEn`·`imageEmoji`·`imageSvg`. §8 호출 D가 채운다. V1에서는 전부 null.
  `imageSvg`는 지금 항상 null이다 — 마이그레이션 없이 나중에 SVG를 얹을 자리만 열어 둔다.
- **(C) 앱 부착** — `photoIndex`(앱이 사진 인덱스 부여) + `confidence`·`partial`(호출 C가 판독하며 매긴 판정).

### 7-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 초등학생용 영어 단어장 페이지를 판독하는 조교다.
사진에서 '실제로 보이는 것만' 책 그대로 옮긴다. 창작 금지 — 예문·뜻·발음을 지어내지 않는다.

[판독 원칙]
- 이 페이지에 실제로 인쇄된 단어만 옮긴다. 사진에 없는 단어를 채워 넣지 않는다.
- 예문·뜻·발음기호는 책에 적힌 그대로 옮긴다. 다듬거나 바꾸지 않는다.
- 이미지 1장에 대해 그 페이지의 단어만 판독한다. 다른 페이지를 상상하지 않는다.

[항목 필드]
- no: 단어 앞의 번호를 그대로 읽는다 (예: "0001"). 번호가 안 보이면 null.
- word: 표제어(영단어) 하나.
- ipa: 발음기호를 옮기되 대괄호 [ ]는 벗겨서 안쪽만 적는다 (예: [pʌk] → pʌk). 발음기호가 없으면 null.
- pos: 품사를 한글 약자로 적는다. 명·대·동·형·부·전·접·감·관·수 중에서 고른다. 한 단어에 여러 품사면 모두 담는다.
- meaningsKo: 한글 뜻을 책에 적힌 순서대로 배열로 담는다. 뜻이 여러 개면 모두 담는다.
- examples: 책의 예문을 영어 문장과 그 한글 해석을 짝지어 담는다. 예문이 없으면 빈 배열.
- related: 유의어·반의어·파생어가 보이면 담는다. kind는 synonym(유의어)·antonym(반의어)·derivative(파생어) 중 하나, word는 그 단어, glossKo는 뜻이 함께 적혀 있으면 그 뜻(없으면 null). 없으면 빈 배열.

[판독 표시]
- partial: 단어 항목이 사진 밖으로 잘려 뜻·예문 일부가 안 보이면 true. 온전히 다 보이면 false.
- confidence: 글자가 선명하면 high, 일부만 읽히면 medium, 흐리거나 빛 반사로 거의 못 읽으면 low. 못 읽은 것을 읽은 척하지 않는다.

[페이지 정보]
- dayLabel: 페이지에 "DAY 01" 같은 단원 표기가 보이면 그대로 옮긴다. 안 보이면 null.
- isVocabPage: 단어장 페이지가 맞으면 true. 단어장이 아니거나 표제어를 하나도 읽을 수 없으면 false로 두고 entries를 빈 배열로 둔다.

[금지]
- 책에 없는 뜻·예문·발음을 지어내지 않는다. 안 보이면 null이나 빈 배열로 둔다.
- 영영 정의나 이모지는 이 단계에서 만들지 않는다 (다른 단계에서 만든다).
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.
```

### 7-2. 사용자 메시지

이미지 1장(단어장 페이지, base64 data URL, `input_image`, `detail: "high"`) + 텍스트
`"이 페이지의 단어들을 판독해줘."` — 이미지 먼저, 텍스트 나중(호출 A·수학 호출 A와 같은 순서).

사진 1장이 판독 1회다. DAY 하나가 사진 여러 장이면 각 사진을 **병렬로** 따로 호출하고, 결과를
번호로 병합한다(§7-5). 호출 A′처럼 한 호출에 여러 장을 싣지 않는다 — 단어장은 사진 간 겹침을
번호로 접어야 해서, "사진 1장 = 판독 1회"가 병합의 전제다.

### 7-3. 출력 JSON Schema — `vocab_extraction` (strict)

```json
{
  "name": "vocab_extraction",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "isVocabPage": { "type": "boolean", "description": "단어장 페이지가 맞는지" },
      "dayLabel":    { "type": ["string", "null"], "description": "예: \"DAY 01\". 안 보이면 null" },
      "entries": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "no":         { "type": ["string", "null"], "description": "단어 번호(예: \"0001\"). 안 보이면 null" },
            "word":       { "type": "string", "description": "표제어(영단어)" },
            "ipa":        { "type": ["string", "null"], "description": "발음기호 — 대괄호 벗겨 안쪽만. 없으면 null" },
            "pos":        { "type": "array", "items": { "type": "string",
                            "enum": ["명", "대", "동", "형", "부", "전", "접", "감", "관", "수"] } },
            "meaningsKo": { "type": "array", "items": { "type": "string" } },
            "examples": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "properties": { "en": { "type": "string" }, "ko": { "type": "string" } },
                "required": ["en", "ko"]
              }
            },
            "related": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                  "kind":    { "type": "string", "enum": ["synonym", "antonym", "derivative"] },
                  "word":    { "type": "string" },
                  "glossKo": { "type": ["string", "null"] }
                },
                "required": ["kind", "word", "glossKo"]
              }
            },
            "partial":    { "type": "boolean", "description": "사진 밖으로 잘려 일부만 보이면 true" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
          },
          "required": ["no", "word", "ipa", "pos", "meaningsKo", "examples", "related",
                       "partial", "confidence"]
        }
      }
    },
    "required": ["isVocabPage", "dayLabel", "entries"]
  }
}
```

배열 개수 제약(항목 수·뜻 개수 등)은 스키마에 넣지 않는다 — strict 모드의 `minItems`/`maxItems`
지원이 모델·버전마다 다르므로 zod가 담당한다(§1 공통 규칙, §2A-4와 같은 규약).

### 7-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- isVocabPage === false면 entries는 빈 배열 (단어장이 아니면 옮기지 않는다 — 표지 판독 isBookCover와 같은 게이트)
- 한 사진의 항목 수는 VOCAB_ENTRIES_PER_PAGE_MAX(40) 이하. 2단 밀집 지면이라도 한 면이 이를 넘지 않는다
- 번호 중복 금지: 같은 사진에서 같은 no를 두 번 읽으면 병합 조인 키가 깨진다
- 발음기호(ipa)에 대괄호 [ ]가 남아 있으면 거부 — §7-1의 "대괄호를 벗겨 저장" 지시를 강제한다
  (생산 시점에 걸어야 callWithSchema의 1회 재요청이 그 자리에서 교정한다)
- 길이 상한(schemas 단일 정의처, 저장·검토 화면이 같은 값을 쓴다):
  word 60 · ipa 120 · no 12 · 뜻 각 200 · 예문 en/ko 각 300 · 관련어 word 60·gloss 200 · dayLabel 60
- examples.en은 필수(빈 예문은 예문이 아니다). examples.ko는 빈 문자열 허용 —
  책에 한글 해석이 없을 수 있고, 없는 해석을 지어내게 하면 창작 금지 원칙에 어긋난다
```

### 7-5. 배치·병합 규칙

```
- 사진 1장 = 판독 1회. DAY 하나의 사진 N장을 Promise.allSettled로 병렬 호출한다(호출 A′와 같은 관용구).
  한 사진이 실패하면 그 사진의 단어만 잃고, 나머지는 살려 병합한다
- 병합(mergeVocabPages, 순수 함수)의 조인 키: 번호(no)가 있으면 번호, 없으면 word.toLowerCase().
  겹쳐 찍기(같은 단어가 두 사진에 잡힘)를 정상 처리한다:
  · examples·meaningsKo·related → 합집합(중복 제거)
  · 스칼라(word·ipa·no) → 내용이 더 많은 '대표본'의 값. 대표본은 완전본(partial=false) 우선,
    그다음 내용(뜻+예문+관련어) 많은 순, 그다음 사진 인덱스 낮은 순으로 고른다
  · partial → 완전본이 하나라도 있으면 해제(= 모든 멤버가 partial일 때만 partial)
  · confidence → 가장 높은 것(선명하게 읽힌 쪽)
  · photoIndex → 대표본의 사진 인덱스
- 정렬: 번호 오름차순(숫자 번호가 있는 것 먼저), 번호 없는 항목은 뒤에 표제어 순
- mergeVocabPages 반환: { entries, mergedCount(접힌 항목 수 = 입력−출력), missingNos }
- findMissingNumbers(entries): 관측 번호의 최소~최대 사이에서 빠진 번호를 관측 자릿수에 맞춰 0채움
  으로 돌려준다(예: "0011"). 사진 한 장이 통째로 빠지면 연속 구간이 비어 여기서 잡힌다.
  벌어짐이 VOCAB_MISSING_SCAN_MAX(200)를 넘으면 오독으로 보고 열거하지 않는다
```

### 7-6. 후처리 (retake 조건)

- `isVocabPage === false`(또는 판독된 entries가 0개) → 사용자에게 "단어장 페이지를 다시 찍어주세요"
  + 수동 입력 폴백. **판독 실패는 예외가 아니라 정상 흐름**이다(표지 판독 `isBookCover=false`,
  수학 `isWorksheet=false`와 같은 갈래) — 라우트는 200 + `{ ok: false, reason: "retake" }`로 내린다.
- `confidence: "low"`가 섞인 항목이 있으면 그 항목의 재촬영을 유도한다(호출 A′와 같은 규약).
- `partial: true` 항목은 "사진 밖으로 잘림"으로 표시하고, 겹쳐 찍은 다른 사진의 완전본이 병합으로
  이를 해제한다. 병합 후에도 partial이 남으면 그 항목만 다시 찍게 안내한다.
- `findMissingNumbers`가 구멍을 보고하면 "○○번 사진이 빠진 것 같아요"로 알린다 — 빠진 내용을
  상상해 채우지 않는다(호출 A′ `gapBefore`와 같은 원칙).
- **원본 사진은 저장하지 않는다**(SPEC §5). 병합된 `VocabEntry[]`만 `VocabBookRecord`로 남긴다.

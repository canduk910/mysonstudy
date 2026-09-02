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
| **C. 단어장 판독** | 단어장 페이지 사진 → 책 그대로 전사한 단어 목록 | 전사 정확성 (책 원문 보존, 창작 금지) | 0 | ~16,000 토큰 / 사진 |

호출 C는 **단어장 정복** 기능(§7)의 판독 호출로, A→A′→B 카드 파이프라인과는 별개의 경로입니다.
사진 1장 = 판독 1회이고, DAY 하나가 사진 여러 장이면 병렬 호출 후 앱이 번호로 병합합니다(§7-5).

호출 A′는 사진 6장씩 배치로 나눠 **병렬 호출**합니다 (§2A-5). 카드 1장에 대한 호출 수는
`1(A) + ceil(N/6)(A′) + 1(B)`입니다.

파이프라인:

```
표지·스티커·뒤표지 1~3장 ──▶ 호출 A  ──▶ 메타데이터 + blurbText
본문/목차 사진 N장 ──▶ 호출 A′ ──▶ 장면별 요약(sceneDigest)
(선택) 유튜브 낭독 자막 전문 ──▶ transcript
메타데이터 + 공개 소개글 + blurbText + sceneDigest + transcript ──▶ 호출 B ──▶ 학습 카드
```

본문 사진을 호출 B에 그대로 붙이지 않고 A′로 분리한 이유: 이미지 토큰이 한 호출에 몰리지
않고, 실패가 배치 안에 갇히고, 무엇보다 **"다시 생성"이 사진 재업로드 없이 저장된 요약만으로
된다**. 원본 사진은 저장하지 않는다 — 요약 텍스트만 남기면 권당 수 KB다.

`transcript`(유튜브 낭독 영상 자막 전문)는 부모가 넣는 **가장 강한 근거 티어**다 — 책 전체 텍스트라
카드가 자막 밖을 지어내지 못하게 하는 grounding이다(환각 방지). 자막 fetch(Supadata)·정리·라우트
배선은 앱(app-builder)이 하고, 호출 B는 정리된 자막 문자열을 `transcript` 입력으로 받는다(§3-2).

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
뒤표지 소개글·본문 장면 메모·유튜브 낭독 자막을 근거로 학습 카드 1장을 만든다.

[절대 규칙]
1. 근거로 받은 글은 요약의 재료로만 쓰고, 책의 영어 원문을 그대로 옮겨 적지 않는다.
   부모가 원하는 것은 아이를 이끌 한국어 맥락이지 영어 원문이 아니다 — 원문은 이미 책으로 손에 들고 있다.
   단어 예문은 전부 새로 창작한다.
2. 받은 근거를 넘어서는 내용을 지어내지 않는다. 근거가 얇으면 줄거리를 단정하는 질문 대신
   제목·주제·표지 기반 질문으로 구성한다. 아는 책이라도 세부 서술을 옮기지 말고 큰 흐름만 다룬다.
3. 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[유튜브 낭독 자막 — 있으면 최우선 근거]
- 사용자 메시지의 [유튜브 낭독 자막]이 "없음"이 아니면, 그것은 이 책을 처음부터 끝까지 소리 내어
  읽은 낭독 영상의 자막 전문이다. 책 전체 텍스트이므로 이번 근거 중 가장 두껍고 강하다 —
  단어·질문·줄거리를 모두 이 자막에 실제로 나온 내용에서 뽑는다.
- 자막에 없는 사건·인물·단어를 지어내지 않는다. 절대 규칙 2를 자막에도 그대로 적용한다 —
  아는 책이라도 자막에 없는 세부는 채워 넣지 않는다.
- 자막 앞뒤의 채널·낭독자 멘트는 이야기가 아니다. 근거에서 제외한다.
  ("Welcome to ○○ Storytime, I'm Ms. △△" 같은 인사, 구독·좋아요·후원 안내, 시작·작별 멘트는
   책 내용이 아니므로 줄거리·단어·질문의 근거로 쓰지 않는다.)
- 자막은 영어 원문이다. 절대 규칙 1대로 그대로 옮겨 적지 않는다 — 줄거리는 우리말로 요약하고,
  단어 예문은 자막에 기대되 새로 창작한다.
- 자막이 있으면 storySource는 transcript다. 분량은 [줄거리 분량] 블록의 상한까지 채운다
  (근거가 책 전체라 짧게 끝낼 이유가 없다).

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
  metadata(제목·주제·표지·공개 소개글) / blurb(뒤표지·책날개 소개글) / toc(목차) / pages(본문 장면 메모) / transcript(유튜브 낭독 자막 = 책 전체 텍스트).
  transcript가 가장 두껍다. 받지 못한 근거는 적을 수 없다. 받았더라도 실제로 도움이 되지 않았다면 낮춰 적는다.
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
- [유튜브 낭독 자막]이 있으면 자막에 실제로 나온 단어에서 고른다. 자막에 없는 단어를 지어내지 않는다.
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
- [유튜브 낭독 자막]이 있으면 자막에 실제로 나온 사건·인물에 근거해 질문을 만든다.
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

[유튜브 낭독 자막]
{transcript 블록 ?? "없음"}

[줄거리 분량]
{줄거리 분량 블록}

[아이 정보]
한국 초등학생, 한국어가 모국어. {childNote ?? ""}

이 책의 학습 카드를 만들어줘.
```

`transcript 블록`은 부모가 넣은 유튜브 낭독 영상 자막 전문이다 (없으면 통째로 `"없음"`). 책 한 권
분량(~2000단어)이라 길 수 있으므로, 상한(`TRANSCRIPT_MAX_CHARS` = 16,000자)을 넘으면 앞부분 우선으로
자르고 잘렸음을 표시한다 (`buildCardUserMessage` → `formatTranscriptBlock`). 카드는 요약이라 앞부분
(설정·도입·초반 전개)이 가장 중요하고 결말은 어차피 드러내지 않으므로, 뒷부분을 버리는 truncate가
품질을 크게 해치지 않는다. 자막 정리(타임스탬프·`[Music]` 제거)는 라우트의 fetch 유틸이 하고,
프롬프트도 채널 인트로/아웃트로 노이즈에 관대하게 대응한다(§3-1 `[유튜브 낭독 자막]` 블록).

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
| `transcript` | 8~10문장 (고정) — 책 전체 텍스트라 셀 장면은 없지만 근거가 가장 두꺼워 다이얼 상한에 둔다 |

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
        "enum": ["metadata", "blurb", "toc", "pages", "transcript"] },
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
`metadata → "예상" / blurb → "소개글 기반" / toc → "목차 기반" / pages → "본문 확인" / transcript → "낭독 확인"`.
`transcript`는 유튜브 낭독 자막(책 전체 텍스트)을 근거로 삼은 것이라 "예상"이 아닌 **실제 근거 기반**
(구 `storyIsGuess === false` 성격)임을 나타낸다.

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
  (근거 순서 metadata < blurb < toc < pages < transcript. 낮춰 적는 것은 허용, 없는 근거를 주장하면 거부.
   비교는 반드시 랭크 `<=` — 등호로 조이면 프롬프트가 허용한 '낮춰 적기'를 거부하게 된다)
- 근거 판정 기준: transcript(낭독 자막)가 있으면 transcript(최상위). 없으면 sceneDigest가 있을 때
  sceneKind가 toc일 때만 toc, 그 외에는 pages. §3-2의 장면 메모 블록 렌더링과 같은 기본값이어야 한다
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
- 낭독 자막(transcript) 오프라인 점검(실호출 0회): `resolveAllowedStorySource`가 자막을 최상위
  티어(`transcript`)로 잡는지(장면 메모가 함께 와도), `storyOutlineSentenceRange("transcript")`가
  다이얼 상한(8~10문장)인지, 근거 없이 `transcript`를 주장하면 zod가 거부하는지(랭크 초과), 자막
  카드의 배지가 "낭독 확인"으로 나오는지, `buildCardUserMessage`가 자막을 `[유튜브 낭독 자막]`
  슬롯에 넣고 상한 초과 시 앞부분 우선으로 자르는지를 고정 입력으로 검사한다.
- 낭독 자막 실호출 게이트(`EVAL_TRANSCRIPT=1`일 때만 실호출 1회 — 기본은 돌지 않는다): 자막을 넣은
  카드 1건이 (a) storySource=transcript·분량 8~10문장이고 (b) storyOutlineKo에 영어 원문 전사가 없고
  (c) 자막 앞뒤 채널 인트로/아웃트로의 고유 문구(채널명·낭독자 이름·구독 안내)가 줄거리에 섞이지
  않았는지를 검사한다. 오프라인 게이트(`EVAL_OFFLINE_ONLY=1`)에서는 절대 도달하지 않는다.
- 출력: 항목별 pass/fail 표. 하나라도 실패하면 exit code 1
- `package.json`에 `"eval:english": "tsx scripts/eval-english.ts"` 등록. 실행에는 `OPENAI_API_KEY` 필요(실호출 3회 발생, `EVAL_SKIP_PAGES=1`이면 2회, `EVAL_TRANSCRIPT=1`이면 자막 카드 1회 추가) — CI가 아니라 수동 실행용

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
- **(A) 책 전사** — `no`·`word`·`ipa`·`pos`·`meanings`·`examples`·`related`. 호출 C가 책 그대로 옮긴다.
  뜻은 `meanings[]`로 담고(뜻 번호·유의어 포함), 예문은 단어 레벨(`examples`)에 묶는다.
- **(B) AI 창작** — `definitionEn`·`definitionKo`·`imageEmoji`·`imageSvg`. §8 호출 D가 채운다. V1에서는 전부 null.
  `definitionKo`(V7)는 `definitionEn`을 우리말로 옮긴 해석이다 — 책의 한글 뜻(`meanings`)과 별개이고,
  EN을 바꾸지 않고(시험 앵커) 그 문장만 번역해 채운다. `imageSvg`는 지금 항상 null이다 — 마이그레이션
  없이 나중에 SVG를 얹을 자리만 열어 둔다.
- **(C) 앱 부착** — `photoIndex`(앱이 사진 인덱스 부여) + `confidence`·`partial`(호출 C가 판독하며 매긴 판정).

### 7-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 초등학생용 영어 단어장 페이지를 판독하는 조교다.
사진에서 '실제로 보이는 것만' 책 그대로 옮긴다. 창작 금지 — 예문·뜻·발음을 지어내지 않는다.

[가장 중요 — 예문을 절대 빠뜨리지 마라]
이 단어장은 거의 모든 단어 바로 아래에 영어 예문 문장과 그 한글 해석이 한 줄씩 인쇄돼 있다.
각 단어를 옮길 때 그 단어 아래의 예문(영어 + 한글)을 반드시 그 단어의 examples에 담는다.
페이지에 단어가 8개·16개로 많아도 **한 단어도 빠짐없이, 각 단어의 예문을 모두** 옮긴다.
단어가 많다고 예문을 건너뛰거나 examples를 빈 배열로 두는 것은 판독 실패다.
출력하기 전에 스스로 점검한다: 예문이 인쇄돼 있는데 examples가 빈 단어가 하나라도 있으면, 그 예문을 채워 다시 완성한다.

[판독 원칙]
- 이 페이지에 실제로 인쇄된 단어만 옮긴다. 사진에 없는 단어를 채워 넣지 않는다.
- 예문·뜻·발음기호는 책에 적힌 그대로 옮긴다. 다듬거나 바꾸지 않는다.
- 이미지 1장에 대해 그 페이지의 단어만 판독한다. 다른 페이지를 상상하지 않는다.

[항목 필드]
- no: 단어 앞의 번호를 그대로 읽는다 (예: "0001"). 번호가 안 보이면 null.
- word: 표제어(영단어) 하나.
- ipa: 발음기호를 옮기되 대괄호 [ ]는 벗겨서 안쪽만 적는다 (예: [pʌk] → pʌk). 발음기호가 없으면 null.
- pos: 품사를 한글 약자로 적는다. 명·대·동·형·부·전·접·감·관·수 중에서 고른다. 한 단어에 여러 품사면 모두 담는다.
- meanings: 한글 뜻을 책에 적힌 순서대로 담는다. 뜻 하나는 no·ko·related로 나눈다.
  · no: 뜻 앞에 번호(1·2·3)가 붙어 있으면 그 번호를 숫자로 적는다. 번호가 없으면 null.
  · ko: 그 뜻의 한글 풀이. 한 뜻 안에 여러 표현이 함께 적혀 있으면 책 그대로 이어 적는다 (예: "수리하다, 고치다").
  · related: 유의어·반의어가 그 뜻 옆에 붙어 있으면 이 뜻에 담는다. kind·word·glossKo는 아래 related와 같은 형식. 없으면 빈 배열.
- examples: 그 단어 아래에 인쇄된 예문(영어 문장 + 한글 해석)을 짝지어 **반드시** 담는다. 위 [가장 중요]대로 빠뜨리지 않는다. 정말로 그 단어에 예문이 인쇄돼 있지 않을 때만 빈 배열.
- related: 특정 뜻이 아니라 단어 전체 아래에 딸린 관련어(파생어 등)만 담는다. kind는 synonym(유의어)·antonym(반의어)·derivative(파생어) 중 하나, word는 그 단어, glossKo는 뜻이 함께 적혀 있으면 그 뜻(없으면 null). 없으면 빈 배열.

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

[판독 예시]
사진 한 항목이 이렇게 인쇄돼 있으면:
  0009 oven [ʌvən] 명 오븐
  I baked some cookies in the oven. 나는 오븐에 쿠키를 좀 구웠다.
아래처럼 examples를 반드시 채워 판독한다(예문을 절대 빠뜨리지 않는다):
  { "no":"0009", "word":"oven", "ipa":"ʌvən", "pos":["명"],
    "meanings":[{"no":null,"ko":"오븐","related":[]}],
    "examples":[{"en":"I baked some cookies in the oven.","ko":"나는 오븐에 쿠키를 좀 구웠다."}],
    "related":[], "partial":false, "confidence":"high" }
뜻이 여러 개이고 뜻 옆에 유의어·파생어가 붙어 있으면:
  0012 fix [fɪks] 동
  1 수리하다, 고치다 (유의어 repair)  2 고정시키다
  He fixed my bike. 그가 내 자전거를 고쳐 줬다.
  [파생] fixture 설비
뜻마다 no·ko를 나누고, 뜻 옆 유의어는 그 뜻의 related에, 단어 전체 파생어는 항목의 related에 담는다:
  { "no":"0012", "word":"fix", "ipa":"fɪks", "pos":["동"],
    "meanings":[{"no":1,"ko":"수리하다, 고치다","related":[{"kind":"synonym","word":"repair","glossKo":null}]},
                {"no":2,"ko":"고정시키다","related":[]}],
    "examples":[{"en":"He fixed my bike.","ko":"그가 내 자전거를 고쳐 줬다."}],
    "related":[{"kind":"derivative","word":"fixture","glossKo":"설비"}], "partial":false, "confidence":"high" }
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
            "meanings": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                  "no":      { "type": ["integer", "null"], "description": "교재 뜻 번호(1·2·3). 없으면 null" },
                  "ko":      { "type": "string", "description": "그 뜻의 한글 풀이" },
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
                  }
                },
                "required": ["no", "ko", "related"]
              }
            },
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
          "required": ["no", "word", "ipa", "pos", "meanings", "examples", "related",
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
- meanings[].no는 정수(교재 뜻 번호 1·2·3) 또는 null. 1~VOCAB_MEANING_NO_MAX(99) 범위를 벗어나면 거부
  (뜻 번호가 아니라 오독으로 본다). meanings[].ko는 필수(빈 뜻은 뜻이 아니다)
- 길이·개수 상한(schemas 단일 정의처, 저장·검토 화면이 같은 값을 쓴다):
  word 60 · ipa 120 · no 12 · 뜻 각(meanings[].ko) 200 · 예문 en/ko 각 300 · 관련어 word 60·gloss 200 · dayLabel 60
  · 뜻 개수(meanings) 12 · 뜻 하나의 related 20 · 단어 전체 related 20
- examples.en은 필수(빈 예문은 예문이 아니다). examples.ko는 빈 문자열 허용 —
  책에 한글 해석이 없을 수 있고, 없는 해석을 지어내게 하면 창작 금지 원칙에 어긋난다
```

### 7-5. 배치·병합 규칙

```
- 사진 1장 = 판독 1회. DAY 하나의 사진 N장을 Promise.allSettled로 병렬 호출한다(호출 A′와 같은 관용구).
  한 사진이 실패하면 그 사진의 단어만 잃고, 나머지는 살려 병합한다
- 병합(mergeVocabPages, 순수 함수)의 조인 키: 번호(no)가 있으면 번호, 없으면 word.toLowerCase().
  겹쳐 찍기(같은 단어가 두 사진에 잡힘)를 정상 처리한다:
  · examples → 합집합(중복 제거)
  · meanings → 뜻 번호(no) 기준 합집합. 번호가 없으면 ko 소문자 기준. 같은 뜻으로 묶이면 그 뜻의 related도 합집합
  · related(단어 전체) → 합집합(중복 제거)
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


## 8. 호출 D — 단어장 보강 (영영 정의 + 우리말 해석 + 이모지, 단어장 정복 기능)

단어장 판독(호출 C)이 만든 (A) 책 전사에, **AI 창작인 (B) definitionEn·definitionKo·imageEmoji**를 더하는
호출입니다. 사진 없이 판독 결과(단어·뜻)만으로 도는 텍스트 호출이라, 사진 없이도 재생성됩니다.

> **정의 불변(이 기능의 축):** 시험(V4)이 저장된 영영 정의에 매달린다. 재생성 때마다 문구가 바뀌면
> 은우가 외운 정의와 시험이 어긋난다. 그래서 definitionEn은 **어떤 경로로도 덮어쓰지 않는다**(§8-5).
> 해석(definitionKo, V7)은 EN을 바꾸지 않고 그 문장을 우리말로 옮겨 채운다 — 입력에 EN이 있으면 모델은
> 번역만 한다. 호출 D는 **definitionEn 또는 definitionKo가 null인 단어**를 대상으로 삼는다(해석 백필).
> 그래서 판독(temp 0)과 달리 temperature 0.7이다.

세 덩이(§7)로 나눈 출처 중 이 호출이 채우는 것은 **(B) AI 창작**뿐이다:
- **definitionEn** — 초등 저학년도 읽을 영어 한 문장. 표제어를 그대로 쓰지 않고, 한글을 섞지 않는다.
  입력에 이미 있으면 그 문장을 그대로 되돌린다(EN 재생성 금지 — 시험 앵커).
- **definitionKo** — definitionEn을 우리말로 옮긴 해석 한 문장(초등 저학년 눈높이). 책의 한글 뜻과 별개다.
  definitionEn이 null이면 definitionKo도 null.
- **imageEmoji** — 그 단어를 나타내는 이모지 1개. 추상어(fix·respect)라 어울리는 게 없으면 null.
- **imageSvg**는 여기서 만들지 않는다(§7과 같이 항상 null — 나중에 SVG를 얹을 자리).

### 8-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 초등학생용 영어 단어에 '영영 정의'와 '그 정의의 우리말 해석'과 '이모지'를 붙이는 조교다.
받은 단어마다 쉬운 영어 뜻풀이 한 문장과, 그 뜻풀이를 우리말로 옮긴 해석 한 문장과, 그 단어를 나타내는 이모지 하나를 만든다.
판독(다른 단계)이 책을 그대로 옮기는 일이라면, 이 단계는 아이가 뜻을 스스로 떠올리게 돕는 창작이다.

[definitionEn — 영영 정의]
- 정확히 영어 한 문장으로 쓴다. 마침표로 끝낸다. 두 문장으로 나누지 않는다.
- 초등학교 저학년도 읽을 수 있는 아주 쉬운 낱말만 쓴다.
- 표제어(word)를 정의 문장 안에 그대로 쓰지 않는다. 그 단어를 모르는 아이가 뜻을 짐작할 수 있게 풀어 쓴다.
- 한글은 한 글자도 쓰지 않는다. 영어로만 쓴다.
- 받은 뜻(meaningsKo)에 맞는 의미로 정의한다. 뜻이 여러 개면 가장 먼저 온 뜻을 기준으로 한 문장에 담는다.
- 입력에 definitionEn이 이미 있으면 그 문장을 새로 짓지 말고 그대로 돌려준다. 없으면(null) 위 규칙대로 새로 만든다.

[definitionKo — 영영 정의의 우리말 해석]
- definitionEn 문장을 초등 저학년이 이해할 수 있게 우리말로 옮긴 해석 한 문장으로 쓴다.
- 책의 한글 뜻이 아니라, 방금 만들었거나 받은 영영 정의(definitionEn) 문장을 우리말로 푸는 것이다.
- 뜻이 definitionEn과 어긋나지 않게 한다. definitionEn이 null이면 definitionKo도 null로 둔다.

[imageEmoji — 이모지]
- 그 단어를 가장 잘 나타내는 이모지 하나만 고른다. 이모지는 딱 1개다 — 여러 개를 이어 붙이지 않는다.
- 눈에 보이는 사물·동작이면 어울리는 이모지를 고른다.
- 눈에 안 보이는 추상적인 말(fix·respect처럼)이라 어울리는 이모지가 없으면 null로 둔다. 억지로 고르지 않는다.

[매칭]
- 받은 단어에 대해서만 만든다. 받지 않은 단어를 새로 지어내지 않는다.
- 각 항목에 받은 no·word를 그대로 담아 어느 단어의 것인지 알 수 있게 한다.

[금지]
- 표제어를 정의에 그대로 쓰지 않는다. 정의에 한글을 쓰지 않는다. 이모지를 2개 이상 붙이지 않는다.
- 입력에 있던 definitionEn을 바꾸지 않는다 — 해석(definitionKo)만 새로 붙인다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[예시]
받은 단어가 이렇게 오면(apple은 정의가 아직 없고, respect는 정의가 이미 있다):
  [{"no":"0009","word":"apple","pos":["명"],"meaningsKo":["사과"],"definitionEn":null},
   {"no":"0021","word":"respect","pos":["동","명"],"meaningsKo":["존경하다","존경"],"definitionEn":"To think that someone is important and to treat them in a kind way."}]
이렇게 만든다(apple은 정의·해석·이모지를 새로 만들고, respect는 받은 정의를 그대로 두고 해석만 붙이며 추상적이라 이모지는 null이다):
  {"items":[
    {"no":"0009","word":"apple","definitionEn":"A round fruit that grows on a tree and is red, green, or yellow.","definitionKo":"나무에서 자라고 빨갛거나 초록이거나 노란 둥근 과일이에요.","imageEmoji":"🍎"},
    {"no":"0021","word":"respect","definitionEn":"To think that someone is important and to treat them in a kind way.","definitionKo":"누군가를 소중하게 여기고 친절하게 대하는 거예요.","imageEmoji":null}
  ]}
```

### 8-2. 사용자 메시지

텍스트 `"다음 단어들에 영영 정의와 그 우리말 해석, 이모지를 만들어줘."` **뒤에** 보강 대상 단어
목록(JSON 배열)을 붙인다. 이미지가 없는 텍스트 호출이다(판독의 이미지-먼저 순서와 다르다).

목록의 각 단어는 정의에 필요한 최소 shape으로 내린다(`buildEnrichRequestItems`, §8-5):

```json
[{ "no": "0009", "word": "apple", "pos": ["명"], "meaningsKo": ["사과"], "definitionEn": null }]
```

- `meaningsKo`는 뜻 풀이 문자열만(뜻 번호·관련어는 정의에 불필요) — 어느 의미로 정의할지 가르는 단서.
- `definitionEn`은 그 단어에 이미 저장된 영영 정의(없으면 null) — 있으면 모델이 새로 짓지 않고 그 문장을
  번역만 해 `definitionKo`를 만든다(EN 불변). 없으면 EN·KO·이모지를 신규 생성한다.
- **definitionEn 또는 definitionKo가 null인 단어만** 목록에 들어간다(§8-5 entriesToEnrich). 정의·해석이
  둘 다 차 있으면 빠진다.

### 8-3. 출력 JSON Schema — `vocab_enrichment` (strict)

```json
{
  "name": "vocab_enrichment",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "items": {
        "type": "array",
        "description": "받은 단어별 보강 결과",
        "items": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "no":           { "type": ["string", "null"], "description": "단어 번호(예: \"0009\"). 입력의 no를 그대로. 없으면 null" },
            "word":         { "type": "string", "description": "표제어(영단어) — 입력의 word를 그대로" },
            "definitionEn": { "type": ["string", "null"], "description": "영어 한 문장 정의(표제어 미포함·한글 금지). 입력에 있으면 그대로. 만들지 못하면 null" },
            "definitionKo": { "type": ["string", "null"], "description": "definitionEn을 우리말로 옮긴 해석 한 문장. definitionEn이 null이면 null" },
            "imageEmoji":   { "type": ["string", "null"], "description": "단어를 나타내는 이모지 1개. 어울리는 게 없으면 null" }
          },
          "required": ["no", "word", "definitionEn", "definitionKo", "imageEmoji"]
        }
      }
    },
    "required": ["items"]
  }
}
```

출력은 object 루트로 감싼다(`items` 배열) — Responses API strict json_schema의 루트가 object여야
하기 때문이다. 개수·길이·문장·이모지 제약은 스키마에 넣지 않는다(§1 공통 규칙, §7-3과 같은 규약).

### 8-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- definitionEn (null이 아닐 때만):
  · 한글 금지 — 영영 정의는 영어로만 (한 글자라도 있으면 거부)
  · 표제어 미포함 — 대소문자 무시 + 단어 경계(\b…\b). 그 단어를 정의에 그대로 쓰면 아이가 못 짐작한다
  · 영어 한 문장 — 문장 종결부호(.!?)가 2개 이상이면 여러 문장으로 보고 거부. 0개(마침표 누락)는
    한 문장일 뿐이라 허용한다(좋은 정의를 재요청으로 잃지 않으려는 것)
  · definitionEn === null은 부분 실패로 본다 — 그 단어는 채우지 않고 넘긴다(규칙 검사 건너뜀)
- definitionKo (null이 아닐 때만):
  · 한국어 — 한글이 한 글자도 없으면 해석이 아니다 (거부). 영어 단어가 섞이는 것은 막지 않는다
  · 정의에 매달림 — definitionEn === null이면 definitionKo도 null이어야 한다(고아 해석 금지). EN이 없으면
    앵커할 정의가 없으므로 KO도 비운다. definitionKo === null은 부분 실패로 본다(규칙 검사 건너뜀)
  · 한 문장 규칙은 zod로 강제하지 않는다 — 한국어 종결(다/요/.)이 불규칙해 오탐이 크다. 실호출 게이트에서
    사람이 눈으로 확인한다(스펙 공백: 보수적으로 한글 유무만 자동 검사)
- imageEmoji (null이 아닐 때만):
  · 자소(grapheme) 1개 — 여러 이모지를 이어 붙이면 거부(Intl.Segmenter로 센다)
  · 실제 이모지(Extended_Pictographic)여야 한다 — 글자를 이모지 자리에 넣으면 거부
- 길이 상한(schemas 단일 정의처): definitionEn VOCAB_DEFINITION_EN_MAX(300) ·
  definitionKo VOCAB_DEFINITION_KO_MAX(300) · imageEmoji VOCAB_IMAGE_EMOJI_MAX(32) · word 60 · no 12 (§7-4와 같은 상수)
```

### 8-5. 정의 불변 규칙 · 병합 (`vocabbook-enrich.ts` 순수 함수)

정의 불변(계획 V3)이 이 절의 핵심이다. 시험(V4)이 저장된 definitionEn에 매달리므로 **안정성이
정확성보다 우선**한다 — 이 규칙이 새면 은우가 외운 정의와 시험이 어긋난다. 규칙은 한 곳에만 산다.
세 필드(정의 EN·해석 KO·이모지)는 병합에서 **각각 독립적으로** 같은 규칙("null 자리에만 채움")을 따른다.

```
- entriesToEnrich(entries): definitionEn === null 또는 definitionKo === null인 단어를 추린다(해석 백필).
  정의·해석이 둘 다 차 있으면 뺀다. imageEmoji는 게이트에 넣지 않는다 — 추상어의 null 이모지가 영구
  재보강 루프를 돌게 만들기 때문(스펙 공백: emoji를 게이트에서 제외한다).
- buildEnrichRequestItems(entries): 보강 대상을 { no, word, pos, meaningsKo, definitionEn }로 내려 보낸다(§8-2).
  definitionEn을 함께 보내 EN이 이미 있는 단어는 모델이 그 문장을 번역만 하게 한다(EN 불변).
- mergeEnrichment(entries, result) → { entries, enriched }:
  · definitionEn === null인 자리에만, 결과 정의가 non-null일 때만 채운다. 이미 채워진 정의는 절대 덮어쓰지 않는다.
    result가 EN을 다르게 줘도 무시하고 기존 EN을 유지한다(적대적 덮어쓰기 방어).
  · definitionKo도 독립적으로 같은 규칙 — definitionKo === null인 자리에만 결과 해석이 non-null일 때만 채운다.
    정의는 있고 해석만 null인 구 레코드가 이 경로로 KO를 얻는다(EN은 손대지 않는다).
  · imageEmoji도 독립적으로 같은 규칙 — 정의는 있고 이모지만 null이면 이모지만 채운다.
  · result에 없는 단어는 그대로 둔다(부분 실패 허용). 매칭키: no 우선, 없으면 word 소문자.
  · enriched = 모든 entry의 definitionEn !== null(빈 배열은 false). **해석(KO)·이모지 null은 판정에서 제외** —
    시험 게이트는 EN 하나에만 매달리므로 KO는 additive다(게이트를 바꾸지 않는다).
- isVocabBookEnriched(entries): enriched의 단일 정의처(definitionEn 기준) — mergeEnrichment도 이걸 쓴다.
- 문구를 바꾸려면 오직 사람이 "고치기"로 수동 수정한다(자동 생성은 절대 손대지 않음).
```

### 8-6. 호출 옵션 · 후처리

- **파라미터:** temperature 0.7(판독 temp 0과 분리 — 창작이라 정의 문장에 다양성이 필요),
  max_output_tokens 8,000(DAY 20~40단어 × 항목당 정의 EN + 해석 KO + 이모지 ~150토큰 ≈ 6,000, 여유 —
  해석 백필이 40단어에 몰릴 수 있어 6,000에서 V7에 올렸다). 로그 라벨 `"vocab-enrich"`.
- **비치명적 실패:** callWithSchema 1회 재요청까지 실패하면 라우트가 그 호출을 삼키고 정의·해석·이모지를
  null로 남긴다("다시 만들기" 버튼으로 재시도). 판독 결과(카드·표 보기)는 그대로 뜬다.
- **재생성:** 사진 없는 텍스트 호출이라 "다시 만들기"가 판독 없이 된다. 대상은 늘 definitionEn 또는
  definitionKo가 null인 단어(해석 백필 포함).
- imageEmoji가 null인 단어는 `resolveVocabImage`(§7)가 첫 글자 배지로 떨어뜨린다 — 빈자리를 안 만든다.

## 9. 호출 F — 챕터화 (transcript → 목차 챕터별 EN/KO 문장, 챕터 리더 기능)

목차 챕터 제목 목록과 유튜브 낭독 자막 전문을 받아, 자막을 챕터별로 나누고 **각 챕터를
자막에 실제로 나온 영어 원문 문장 + 그 우리말 해석(문장 1:1)** 으로 만드는 호출입니다.
결과는 book/card 레코드에 저장되어 **챕터 리더 UI**의 근거가 됩니다.

호출 F는 A→A′→B 카드 파이프라인과 별개 경로입니다. 목차(TOC) 사진은 호출 A′(toc 모드)로
챕터 제목을 읽고, 그 제목 목록 + 자막을 이 호출에 넘깁니다. 카드의 다른 부분(호출 B)은 여전히
자막을 우리말 요약으로만 쓰지만, 이 챕터 리더는 다릅니다.

> **이 호출에 한해 "본문 재현 금지"(SPEC §1)를 완화한다.** 은우 북카드는 가족 전용 앱이라,
> 낭독 자막(부모가 직접 넣은 공개 영상 자막)을 챕터 리더로 **영어 원문 그대로 표시·저장**하는 것을
> 사용자가 확정했다. 완화는 **이 챕터화 결과에만** 적용된다 — 호출 A′의 장면 메모, 호출 B의 줄거리·
> 예문 등 카드의 다른 부분은 기존 "원문 전사 금지" 규칙을 그대로 지킨다.

> **grounding — "자막 밖 창작 금지"는 프롬프트 지시로 끝내지 않는다.** 프롬프트가 "en은 자막에서
> 복사"라고 지시하고, 그 위에 `groundChapters()`(schemas.ts)가 **각 en 문장이 자막의 토큰 열에
> 연속 구간으로 실제 존재하는지 코드로 검사해**, 없는 문장을 저장 전에 잘라낸다. 저장되는 모든 en은
> 자막 부분문자열임이 보장된다. throw가 아니라 잘라내는 이유는 §9-5.

### 9-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 아이와 영어 원서를 함께 읽는 한국인 가족을 위해, 유튜브 낭독 자막을 목차의 챕터별로 나누는 편집자다.
목차에서 읽은 챕터 제목 목록과, 그 책을 처음부터 끝까지 소리 내어 읽은 낭독 영상의 자막 전문을 받는다.
자막을 각 챕터에 배정하고, 챕터마다 영어 원문 문장과 그 우리말 해석을 1:1로 만든다.

[이 기능은 영어 원문을 그대로 실어도 된다]
- 이 결과물은 가족만 보는 챕터 리더다. 다른 호출과 달리 영어 원문을 요약하지 말고 자막에 나온 그대로 옮긴다.
- en에는 자막에 실제로 나온 문장을 글자 그대로 복사한다. 고쳐 쓰거나 다듬거나 요약하지 않는다.
- ko에는 그 en 문장의 자연스러운 우리말 해석을 쓴다. 문장 하나에 해석 하나(1:1)다.

[챕터 배정]
- 자막의 내용과 순서를 보고 각 문장이 어느 챕터에 속하는지 정한다. 챕터는 목차에 준 제목과 순서를 따른다.
- titleEn에는 받은 챕터 제목을 그대로 쓴다. 목차에 없는 챕터를 새로 만들지 않는다.
- 자막에서 그 챕터에 해당하는 내용을 찾으면 matched를 true로 하고 sentences를 채운다.
- 자막에 그 챕터의 내용이 없으면(자막이 거기까지 닿지 않았거나 그 챕터를 읽지 않았으면)
  matched를 false로 하고 sentences를 비운다. 없는 내용을 지어내 채우지 않는다.

[목차가 없을 때]
- 목차 챕터 제목이 "전체" 하나뿐이면, 챕터는 그 하나만 만든다. titleEn은 "전체", matched는 true.
- 챕터가 하나라고 해서 문장을 뭉치지 마라. sentences는 **반드시 한 문장씩 쪼갠다** — 목차가 있을 때와 똑같다.
  sentences 배열의 각 항목은 정확히 **한 문장**이다(마침표·물음표·느낌표 하나로 끝나는 단위, en 대략 40단어 이내).
  여러 문장이나 문단을 한 항목에 뭉쳐 넣으면 안 된다. en은 그 한 문장, ko는 그 한 문장의 번역이다.
- 책을 소리 내어 읽은 부분의 문장을 처음부터 끝까지 순서대로 하나씩 담는다.

[제외할 것 — 채널 인트로/아웃트로]
- 자막 앞뒤의 낭독자·채널 멘트는 책 내용이 아니다. 어느 챕터에도 넣지 않는다.
  ("Welcome to ○○ Storytime, I'm Ms. △△" 같은 인사, 구독·좋아요·후원 안내, 시작·작별 멘트 등)
- 책을 읽기 시작하기 전과 다 읽은 뒤의 잡담은 버린다. 챕터의 문장은 책을 소리 내어 읽은 부분에서만 뽑는다.

[금지]
- 자막에 없는 문장을 en에 지어내지 않는다. en은 반드시 자막에서 복사한 것이어야 한다.
- 한 문장을 여러 챕터에 중복해서 넣지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.
```

### 9-2. 사용자 메시지 템플릿

목차 챕터 제목을 번호로 나열하고 자막을 붙인다 (`buildChapterizeUserMessage`).

```
[목차 챕터 제목]
1. {chapterTitles[0]}
2. {chapterTitles[1]}
...

[유튜브 낭독 자막]
{transcript (앞부분 우선 truncate 후)}

각 챕터에 해당하는 자막 문장을 배정하고, 문장마다 영어 원문(en)과 우리말 해석(ko)을 만들어줘.
```

`chapterTitles`는 목차 사진을 호출 A′(toc 모드)로 읽어 얻은 영어 챕터 제목 배열이다(app-builder가 넘긴다).
**목차가 없으면(빈 배열)** `resolveChapterTitles`가 단일 제목 `WHOLE_TRANSCRIPT_TITLE`("전체") 하나로
치환하므로, 사용자 메시지의 목차 목록은 `1. 전체` 한 줄이 되고 프롬프트 [목차가 없을 때] 규칙에 따라
자막 전체가 그 한 챕터에 담긴다. **자막(transcript)만 필수**이고 목차는 선택이다.
`transcript`는 `truncateTranscriptForChapterize`로 `CHAPTERIZE_TRANSCRIPT_MAX_CHARS`(12,000자)까지 앞부분
우선으로 자른 자막이다 — 넘으면 앞 챕터부터 채워지고 뒤쪽 챕터는 자막이 닿지 않아 `matched:false`로 온다.

### 9-3. 출력 JSON Schema — `chapterization` (strict)

```json
{
  "name": "chapterization",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "chapters": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "titleEn":  { "type": "string", "description": "받은 목차 챕터 제목을 그대로" },
            "matched":  { "type": "boolean", "description": "자막에서 이 챕터 내용을 찾았는지" },
            "sentences": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                  "en": { "type": "string", "description": "자막에 실제로 나온 문장(원문 그대로)" },
                  "ko": { "type": "string", "description": "그 문장의 우리말 해석(1:1)" }
                },
                "required": ["en", "ko"]
              }
            }
          },
          "required": ["titleEn", "matched", "sentences"]
        }
      }
    },
    "required": ["chapters"]
  }
}
```

모든 필드는 required이고 선택키는 없다(store 규약). "없는 챕터"는 필드를 빼는 게 아니라
`matched:false` + 빈 `sentences`([])로 표현한다. 배열 개수 제약(minItems/maxItems)은 스키마에
넣지 않는다 — 상한은 프롬프트 밖의 자막 길이가 실질적으로 정하고, 폭주 가드는 zod가 담당한다(§1 공통 규칙).

### 9-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- 챕터 1개 이상, 최대 CHAPTERIZE_MAX_CHAPTERS(40)개
- 전체 문장 최대 CHAPTERIZE_MAX_SENTENCES_TOTAL(600)개, 챕터당 최대 CHAPTERIZE_MAX_SENTENCES_PER_CHAPTER(120)개
  (자막 길이가 실질 상한이고, 이 값들은 모델이 문장을 중복 생성하는 폭주를 막는 가드다)
- matched ⟺ sentences 채움: matched=true인데 빈 sentences거나, matched=false인데 sentences가 있으면 거부
- en은 영어(한글 없음), ko는 우리말(한글 있음) — en/ko 자리를 바꿔 넣는 실패를 막는다
- titleEn은 받은 목차 제목 중 하나여야 한다(정규화 비교: NFC·트림·연속공백1칸·소문자) — 목차 밖 챕터 창작 금지
- titleEn 중복 금지
- 길이 상한: titleEn 200자 · en 600자 · ko 800자 (상수는 schemas.ts 단일 정의처)
```

"en이 자막에 실제로 있는가"(자막 밖 창작 금지)는 zod가 아니라 `groundChapters()`가 본다 — 자막
문자열이 필요하고, 어긋난 문장은 throw가 아니라 잘라내는 편이 낫기 때문이다(§9-5).

### 9-5. grounding 후처리 (`groundChapters` — 자막 밖 창작 금지의 최종 강제)

```
- 자막과 각 en을 소문자 영숫자 토큰으로 쪼갠다(tokenizeForGrounding): 아포스트로피·따옴표·문장부호·
  대소문자·공백 차이를 무시한다("don't"↔"dont", 스마트따옴표↔직선따옴표). 모델이 자막을 옮기며 생긴
  사소한 표기 흔들림엔 관대하되 "같은 단어가 같은 순서로 나왔는가"는 지킨다
- 각 문장의 en 토큰 열이 자막 토큰 열의 '연속 구간'으로 존재하지 않으면 그 문장을 잘라낸다
  (isGroundedInTranscript). 잘라내 문장이 하나도 안 남은 챕터는 matched를 false로 내린다
- 잘라낸 문장 수를 droppedSentenceCount로 반환한다 (0이 정상, 크면 프롬프트 이탈 신호 → 로그 경고)
- throw가 아니라 잘라내는 이유: 사용자는 이미 호출 비용을 치렀다. 몇 문장을 버리는 편이 카드 전체를
  실패시키는 것보다 낫다(호출 A′ 배치 부분 성공과 같은 철학, §2A-5). 저장되는 en은 이 필터를 지나
  전부 자막 부분문자열임이 보장된다
```

### 9-6. 호출 옵션 · 경계면 · 후처리

- **호출 옵션(`CHAPTERIZE_CALL_OPTIONS`)**: temperature 0 (전사+번역이라 같은 자막은 같은 결과),
  max_output_tokens 16,000 (자막 전체를 EN+KO로 되뽑아 출력이 크다 — 입력을 12,000자로 잘라 균형).
  단일 호출이다. 출력 한도 도달(`status: incomplete`)은 callWithSchema의 재요청 경로가 받는다(§4).
- **경계면(app-builder)**: `chapterizeTranscript(chapterTitles: string[], transcript: string)` →
  `{ chapters, truncated, droppedSentenceCount }`. app-builder가 /api에서 호출하고, `chapters`를
  book/card 레코드에 저장한 뒤 챕터 리더 UI를 그린다.
  - **목차 없음 갈래**: `chapterTitles`에 빈 배열을 넘기면(목차 사진이 없거나 판독 실패) 정상 처리되어
    단일 "전체" 챕터 하나로 온다(`chapters.length === 1`, `titleEn === "전체"`, `matched === true`).
    app-builder는 목차가 없을 때 빈 배열을 넘기면 된다 — throw하지 않는다.
  - 저장 shape: `chapters: { titleEn: string, matched: boolean, sentences: { en: string, ko: string }[] }[]`.
    선택키·undefined 없음(store 규약) — matched=false 챕터는 `sentences: []`.
  - `truncated`(자막이 잘렸는지)·`droppedSentenceCount`(잘라낸 문장 수)는 부분 처리 안내 메타다(저장 필수 아님).
  - 실패 구분: `ChapterizeError("invalid_input")` → 400(**자막이 비었음** — 낭독 원문+번역이 필수 입력) /
    callWithSchema throw(재요청 2회 실패) → 500(재시도 가치 있음). **목차 없음은 실패가 아니다.**
- **M1 스코프**: 챕터화 호출 + 스키마 + 저장 shape + eval까지다. 단어 뜻(더블탭)·단어장 추가는 M2다.

### 9-7. 평가 하네스 점검 (`scripts/eval-english.ts` — 실호출 0회 + 게이트)

- 오프라인(실호출 0회): chapters zod가 (a) 정상 입력을 통과시키고 (b) matched/빈 sentences 모순,
  en에 한글, ko에 한글 없음, 목차 밖 titleEn, 제목 중복, 챕터/문장 수 상한 초과를 각각 거부하는지.
  `groundChapters`가 자막에 없는 문장을 잘라내고(자막 밖 창작 금지) 자막에 있는 문장은 en/ko 1:1로
  보존하는지(droppedSentenceCount 포함). 상한 상수가 서로 어긋나지 않는지. 프롬프트↔스펙 spec-sync.
  픽스처는 TOC 제목 + 짧은 자막(채널 인트로/아웃트로 노이즈 포함)이다.
- 실호출 게이트(`EVAL_CHAPTERS=1`일 때만 실호출 1회 — 기본은 돌지 않는다): 실제 자막→챕터 1건이
  (a) 모든 en이 자막 부분문자열이고(grounding) (b) 채널 인트로/아웃트로 노이즈가 어느 챕터에도
  안 섞였고 (c) matched 챕터는 sentences가 있고 en/ko가 1:1이고 ko가 우리말인지를 검사한다.
  오프라인 게이트(`EVAL_OFFLINE_ONLY=1`)에서는 절대 도달하지 않는다.

## 10. 호출 G — 단어 뜻 조회 (문맥 기반 우리말 뜻, 챕터 리더 더블탭 기능)

호출 G는 A→A′→B 카드 파이프라인과 별개 경로입니다. 챕터 리더(§9)에서 아이가 영어 문장의 단어를
더블탭하면, 그 단어가 아니라 **그 단어가 속한 문장 맥락**에서의 우리말 뜻을 짧게 돌려줍니다.

> 판독(호출 C)이 책을 그대로 옮기고, 보강(호출 D)이 영영 정의를 창작한다면, 호출 G는 "이 문장에서
> 이 단어가 무슨 뜻인지"를 초등 저학년 눈높이로 한 낱말~짧은 구로 짚어 줍니다. 다의어(left = 왼쪽/떠나다)는
> 문장 맥락으로 뜻을 좁힙니다. 사진 없는 텍스트 단일 호출이고, 출력이 아주 작습니다.

파이프라인:

```
챕터 리더의 영어 문장 + 더블탭한 단어 ──▶ 호출 G ──▶ { meaningKo }(그 문맥의 우리말 뜻)
```

**M2 스코프 경계**: 이 명세는 호출 G(프롬프트 + 스키마 + zod + eval)까지입니다. 더블탭 감지·뜻 팝업·
"모은 단어" 단어장 추가(V8 append 재사용)는 앱(app-builder/M2) 몫입니다.

### 10-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 아이와 영어 문장을 함께 읽다가 모르는 단어를 만난 한국인 부모를 돕는 조교다.
영어 단어 하나와 그 단어가 들어 있는 영어 문장을 받아, 그 문장에서 이 단어가 뜻하는 바를 우리말로 알려준다.

[meaningKo — 문맥 속 우리말 뜻]
- 그 문장에서 이 단어가 쓰인 뜻만 우리말로 짧게 적는다. 한 낱말이나 짧은 구로 쓴다.
- 뜻이 여러 개인 단어(다의어)면 사전의 첫 번째 뜻이 아니라 이 문장에 맞는 뜻을 고른다.
- 문장에서 쓰인 모습 그대로 옮긴다. 과거형으로 쓰였으면 과거형으로, 복수면 복수로 적는다.
- 초등학교 저학년 아이도 알아들을 쉬운 말로 적는다. 어려운 한자어나 긴 설명을 붙이지 않는다.
- 한글로만 적는다. 영어 단어를 그대로 옮겨 적지 않는다.
- 뜻만 적는다. 품사·발음·예문·부연 설명을 붙이지 않는다.

[금지]
- 이 문맥과 상관없는 다른 뜻을 나열하지 않는다. 문장에 맞는 뜻 하나만 적는다.
- 영어를 그대로 남기거나 뜻에 영어 단어를 이어 쓰지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[예시]
문장: "He bellowed in fear." · 단어: "bellowed"
  → {"meaningKo":"울부짖었다"}
문장: "She left the party early." · 단어: "left"
  → {"meaningKo":"떠났다"}
문장: "Turn left at the corner." · 단어: "left"
  → {"meaningKo":"왼쪽"}
```

### 10-2. 사용자 메시지 템플릿

플레이스홀더(`{sentence}`·`{word}`)가 든 서술이라 고정 문자열이 아닙니다(호출 F·B 템플릿과 같이
`SPEC_SYNC_TARGETS` 대상이 아닙니다). `buildWordMeaningUserMessage(word, sentence)`가 조립합니다.

```
아래 영어 문장에서 지정한 단어가 이 문맥에서 무슨 뜻인지 알려줘.

문장: {sentence}
단어: {word}
```

### 10-3. 출력 JSON Schema — `word_meaning` (strict)

모든 필드 required + `additionalProperties: false`. 선택 키·null 유니온 없음 — 뜻은 항상 하나
있어야 합니다. 길이 제약(`minItems`/`maxItems`·`maxLength`)은 스키마에 넣지 않고 zod가 담당합니다(§1 공통 규칙).

```json
{
  "name": "word_meaning",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "meaningKo": {
        "type": "string",
        "description": "그 문장 맥락에서 이 단어의 우리말 뜻. 한 낱말~짧은 구, 한글만."
      }
    },
    "required": ["meaningKo"]
  }
}
```

### 10-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- meaningKo 길이: trim 후 1자 이상 WORD_MEANING_KO_MAX(40)자 이하. 길면 뜻이 아니라 설명으로 흐른 것으로 보고 거부
- 한글만: meaningKo에 한글이 한 글자도 없으면 거부 (원어(영단어)를 그대로 옮긴 echo 차단)
- 영어 단어 연속 금지: 영어 낱말이 2개 이상 이어지면 거부 (원문 문장·단어를 그대로 옮긴 것). 한글에 영어 낱말 1개가 섞이는 것은 허용
```

### 10-5. 호출 옵션 · 경계면 · 후처리

- **호출 옵션(`WORD_MEANING_CALL_OPTIONS`)**: temperature 0 (같은 단어·문장은 같은 뜻),
  max_output_tokens 600 (출력이 `{"meaningKo":"…"}` 한 줄로 아주 작다 — 카드 6,000·판독 16,000보다
  한참 작게 두되 추론형 모델의 내부 토큰까지 감안해 여유를 남긴다). 단일 호출. 출력 한도 도달
  (`status: incomplete`)은 callWithSchema의 재요청 경로가 받는다(§4).
- **경계면(app-builder)**: `lookupWordMeaning(word: string, sentence: string)` → `{ meaningKo: string }`.
  app-builder가 `POST /api/word-meaning`로 감싸 챕터 리더 더블탭 팝업에 붙이고, "단어장 추가"는
  V8 append를 재사용한다(대상은 "모은 단어" 단어장). 실패는 전부 throw다:
  - 단어·문장이 비면 throw → 500 (입력 오류지만 별도 에러 타입을 두지 않는 작은 호출).
  - `OPENAI_API_KEY` 미설정 → getOpenAIClient throw → 501 (키 없음).
  - callWithSchema throw(재요청 2회 실패) → 500 (재시도 가치 있음).

### 10-6. 평가 하네스 점검 (`scripts/eval-english.ts` — 실호출 0회 + 게이트)

- 오프라인(실호출 0회): word_meaning zod가 (a) 정상 입력(짧은 한글 뜻)을 통과시키고 (b) 빈 문자열,
  40자 초과, 한글 없는 영어 echo("bellowed"), 영어 낱말 2개 연속("he bellowed …")을 각각 거부하는지.
  JSON Schema가 strict·additionalProperties:false·required meaningKo인지. 프롬프트↔스펙 spec-sync.
- 실호출 게이트(`EVAL_WORDMEANING=1`일 때만 실호출 1회 — 기본은 돌지 않는다): 실제 단어·문장 1건이
  (a) 한글이 있고 (b) WORD_MEANING_KO_MAX 이하로 짧고 (c) 영어 낱말이 이어지지 않는지를 검사한다.
  오프라인 게이트(`EVAL_OFFLINE_ONLY=1`)에서는 절대 도달하지 않는다.

## 11. 호출 H — 유의어·반의어 추천 (단어장 연결 후보 제시)

호출 H는 A→A′→B 카드 파이프라인과 별개 경로입니다. 유의어/반의어 연결(V8)은 원래 **이미 단어장에
있는 단어**끼리만 이을 수 있어, 그 관계어가 단어장에 없으면 아예 고르지 못했습니다. 호출 H는 그 단어의
**그 뜻(meaningKo)에 맞는** 실제 영어 유의어·반의어 후보를 **은우(초등) 눈높이**로 제시합니다. 아이가
고르면 앱이 그 단어를 단어장에 **신규 추가(+호출 D 보강)** 하며 연결합니다.

> 판독(호출 C)이 책을 옮기고 보강(호출 D)이 영영 정의를 창작한다면, 호출 H는 "이 뜻의 유의어(반의어)로
> 뭐가 있지?"를 초등 눈높이로 5~6개 제시합니다. 다의어는 받은 뜻으로 관계를 좁힙니다(big=큰의 유의어 large,
> big=중요한의 유의어 major는 섞지 않습니다). 사진 없는 텍스트 단일 호출이고, 출력이 작습니다.

**스코프 경계**: 이 명세는 호출 H(프롬프트 + 스키마 + zod + 후처리 + eval)까지입니다. 후보 선택/직접입력 →
신규 단어 추가(V8 `appendVocabEntry` 재사용) → 자동 보강(호출 D) → 연결(`applyVocabLink`)로 잇는 배선은
앱(app-builder) 몫입니다.

### 11-1. 시스템 프롬프트 (원문 그대로 사용)

```
너는 아이(초등학생)의 영어 단어장을 돕는 조교다.
영어 단어 하나와 그 단어의 우리말 뜻 하나, 그리고 찾을 관계(유의어 또는 반의어)를 받아, 그 뜻에 맞는 영어 유의어(또는 반의어) 후보를 5~6개 만든다.

[candidates — 유의어/반의어 후보]
- 받은 뜻(meaningKo)에 맞는 관계만 낸다. 한 단어는 여러 뜻을 가질 수 있으니, 받은 뜻이 아닌 다른 뜻의 유의어·반의어는 넣지 않는다.
- 받은 관계가 '유의어'면 뜻이 비슷한 단어만, '반의어'면 뜻이 반대인 단어만 낸다. 둘을 섞지 않는다.
- 일상에서 가장 많이 쓰이는(고빈도) 흔한 단어를 우선해 고르고, 후보는 흔한 순서대로(가장 흔한 것부터) 배열한다. 시험이나 격식체에서만 쓰는 드문 단어는 넣지 않는다.
- 후보는 영어 낱말 하나여야 한다. 구·문장·설명을 넣지 않는다. 마침표·쉼표 같은 문장부호를 붙이지 않는다.
- 받은 단어(word) 자신은 후보에 넣지 않는다. 같은 단어를 두 번 넣지 않는다.
- 후보는 서로 다른 기본형(base form) 낱말이어야 한다. 이미 낸 후보나 표제어의 비교급·최상급·굴절형(예: heavier·heaviest·running·happier)은 내지 않는다. 서로 뜻이 겹치지 않는 별개 단어로 고른다.

[glossKo — 후보의 우리말 뜻]
- 각 후보 단어의 뜻을 초등학생도 알아들을 쉬운 우리말로 짧게 적는다. 한 낱말이나 짧은 구로 쓴다.
- 한글로 적는다. 뜻만 적고 품사·발음·예문을 붙이지 않는다.

[금지]
- 유의어를 물었는데 반의어를, 반의어를 물었는데 유의어를 넣지 않는다.
- 받은 뜻과 상관없는 다른 뜻의 관계어를 넣지 않는다.
- 후보에 표제어 자신·중복·구·문장·문장부호를 넣지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[예시]
단어: "happy" · 뜻: "기쁜" · 관계: 유의어
  → {"candidates":[{"word":"glad","glossKo":"기쁜"},{"word":"joyful","glossKo":"즐거운"},{"word":"cheerful","glossKo":"명랑한"},{"word":"merry","glossKo":"유쾌한"},{"word":"pleased","glossKo":"기뻐하는"}]}
단어: "happy" · 뜻: "기쁜" · 관계: 반의어
  → {"candidates":[{"word":"sad","glossKo":"슬픈"},{"word":"unhappy","glossKo":"불행한"},{"word":"upset","glossKo":"속상한"},{"word":"gloomy","glossKo":"우울한"},{"word":"miserable","glossKo":"비참한"}]}
```

### 11-2. 사용자 메시지 템플릿

플레이스홀더(`{word}`·`{meaningKo}`·`{관계}`)가 든 서술이라 고정 문자열이 아닙니다(§10-2 word-meaning 템플릿과
같이 `SPEC_SYNC_TARGETS` 대상이 아닙니다). `buildRelatedSuggestUserMessage(word, meaningKo, kind)`가 조립합니다
(kind: `"synonym"`→`유의어`, `"antonym"`→`반의어`).

```
아래 단어의 '{meaningKo}' 뜻에 맞는 {관계}를 초등학생 눈높이로 5~6개 알려줘.

단어: {word}
뜻: {meaningKo}
관계: {관계}
```

### 11-3. 출력 JSON Schema — `related_suggestion` (strict)

모든 필드 required + `additionalProperties: false`. 선택 키·null 유니온 없음. 개수·길이·낱말 형식
제약(`minItems`/`maxItems`·`maxLength`)은 스키마에 넣지 않고 zod가 담당합니다(§1 공통 규칙).

```json
{
  "name": "related_suggestion",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "candidates": {
        "type": "array",
        "description": "그 뜻에 맞는 유의어(또는 반의어) 후보들",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "word": { "type": "string", "description": "영어 유의어/반의어 낱말 하나(구·문장 금지)" },
            "glossKo": { "type": "string", "description": "그 후보의 짧은 우리말 뜻(한글)" }
          },
          "required": ["word", "glossKo"]
        }
      }
    },
    "required": ["candidates"]
  }
}
```

### 11-4. zod 추가 검증 (스키마가 못 잡는 것)

```
- candidates 개수: 1개 이상 RELATED_SUGGEST_MAX_CANDIDATES(12)개 이하. 0개는 쓸모없어 거부(재요청). 5~6개는 프롬프트 다이얼
- word: trim 후 1자 이상 VOCAB_RELATED_WORD_MAX(60)자 이하. 영문자로 시작해 영문자·하이픈만(정규식 /^[A-Za-z][A-Za-z-]*$/) —
  구·문장·문장부호·숫자·한글이 섞이면 거부(실제 영어 낱말 하나만)
- glossKo: trim 후 1자 이상 VOCAB_RELATED_GLOSS_MAX(200)자 이하. 한글이 한 글자도 없으면 거부(영단어 echo 차단)
- kind 정확성(유의어 자리에 반의어를 넣지 않음)은 코드가 검증할 수 없다 — 프롬프트가 강제하고 실호출 프로브가 확인한다(스펙 공백)
```

### 11-5. 후처리 (`postprocessRelatedCandidates` — 표제어 제외·중복 제거)

```
- 순수 함수 postprocessRelatedCandidates(candidates, headword)가 화면에 올리기 전 청소한다(거부가 아니라 거른다):
  · 빈 낱말(공백만) 제거
  · 표제어(headword) 자신 제거 — 대소문자 무시(word.toLowerCase() 비교)
  · 같은 낱말 중복 제거 — 첫 등장만 유지(소문자 기준)
- 거부가 아니라 거르는 이유: 모델이 표제어·중복을 섞어도 재요청 루프 대신 조용히 청소해 후보 UX가 끊기지 않게 한다.
- 이 후처리는 client.ts의 suggestRelatedWords가 반환 직전에 적용한다(값 판정은 한 곳에만).
```

### 11-6. 호출 옵션 · 경계면 · 후처리

- **호출 옵션(`RELATED_SUGGEST_CALL_OPTIONS`)**: temperature 0.3 (정확성 우선이라 낮게 두되, 0이면 후보
  5~6개가 서로 겹쳐 다양성이 죽어 살짝 준다 — 판독·뜻조회의 temp 0 전사와 달리 '여러 후보'를 내는
  창작이다. 추론형 모델은 §4대로 temperature를 자동 생략), max_output_tokens 800 (후보 5~6개 ×
  `{word,glossKo}`로 작다 — 추론형 모델 내부 토큰까지 감안한 여유). 단일 호출.
- **경계면(app-builder)**: `suggestRelatedWords({ word, meaningKo, kind })` → `{ candidates: { word, glossKo }[] }`.
  app-builder가 `POST /api/english/vocab/[id]/suggest-related`(또는 유사) 로 감싸 연결 UI(유의어/반의어 고르기)에
  붙인다. 후보 선택/직접입력 → V8 `appendVocabEntry`로 신규 단어 추가 → 호출 D 보강 → `applyVocabLink`로 연결.
  실패는 전부 throw다:
  - word·meaningKo가 비면 throw → 500 (입력 오류지만 별도 에러 타입을 두지 않는 작은 호출).
  - `OPENAI_API_KEY` 미설정 → getOpenAIClient throw → 501 (키 없음).
  - callWithSchema throw(재요청 2회 실패) → 500 (재시도 가치 있음).

### 11-7. 평가 하네스 점검 (`scripts/eval-english.ts` — 실호출 0회 + 게이트)

- 오프라인(실호출 0회): related_suggestion zod가 (a) 정상 후보(영어 낱말 + 한글 뜻)를 통과시키고 (b) 빈 배열,
  구·문장·문장부호가 섞인 word, 한글 없는 glossKo, 개수 초과를 각각 거부하는지. JSON Schema가 strict·
  additionalProperties:false·required candidates/word/glossKo인지. postprocessRelatedCandidates가 표제어 자신·중복·
  빈값을 거르는지. 프롬프트↔스펙 spec-sync(§11-1).
- 실호출 프로브(오케스트레이터가 동의 하에 별도로 돌린다 — 기본 eval에는 넣지 않는다): 실제 단어·뜻·kind 1건이
  (a) kind에 맞는 관계인지(유의어 자리에 반의어가 안 섞였는지), (b) 받은 뜻에 맞는 후보인지, (c) 초등 눈높이인지.
  이 셋은 의미 판단이라 코드로 못 잡는다. 오프라인 게이트(`EVAL_OFFLINE_ONLY=1`)에서는 절대 도달하지 않는다.

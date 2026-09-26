# AI 하네스 명세 — 은우 북카드 (OpenAI)

**은우학습 프로젝트 · 2026-08-15 · 저장소에는 `docs/harness/english.md`로 저장**

> **하네스란?** LLM 호출을 감싸는 뼈대입니다 — 프롬프트, 출력 스키마, 검증, 재시도, 로깅을 한 세트로 묶은 것.
> 말과 마차를 잇는 마구(harness)처럼, 모델의 힘이 정확한 방향으로만 나가게 잡아주는 장치예요.
> 이 문서의 프롬프트와 스키마는 **완성본**입니다. 클로드코드에게 "docs/harness/english.md 명세대로 `lib/ai/english/`를 구현해"라고 전달하면 그대로 코드가 됩니다.

> **과목 공통 규약은 `docs/HARNESS.md`에 있습니다.** 서버 전용 호출·Structured Outputs·zod 이중 검증·1회 재요청·
> 호출 로깅 shape·모델 ID env화·배열 개수 제약의 위치 — 영어와 수학이 똑같이 지키는 규칙들입니다.
> 아래 §1의 "공통 규칙"은 그 규약을 영어 맥락에서 다시 적은 것으로, 두 문서는 같은 내용을 말합니다.

## 1. 구성 개요

앱의 AI 호출은 9종입니다(A·A′·B·C·D·F·G·H·I — E는 결번). 여기에 Structured Outputs 밖의 **관문 R**(자유대화 실시간 음성, §12)이 하나 있습니다. 아래 temperature·출력 한도는 코드의 호출 옵션
상수와 같은 값이고, 각 값을 고른 근거는 표의 "상세" 절에 있습니다.

| 호출 | 목적 | 성격 | temperature | 출력 한도 (max_output_tokens) | 옵션 상수 (파일) | 상세 |
|---|---|---|---|---|---|---|
| **A. 표지 판독** | 표지·스티커 사진 → 책 메타데이터 + 뒤표지 블러브 | 정확성 우선 (보이는 것만) | 0 | 2,000 | `EXTRACT_CALL_OPTIONS` (`lib/ai/client.ts`) | §2 |
| **A′. 본문·목차 판독** | 본문/목차 사진 N장 → 장면별 요약 | 판독 정확성 + 질문 창작 | 0.3 | 4,000 / 배치 | `PAGES_CALL_OPTIONS` (`lib/ai/client.ts`) | §2A |
| **B. 카드 생성** | 메타데이터 + 근거 → 학습 카드 | 창작 품질 우선 | 0.7 | 6,000 | `CARD_CALL_OPTIONS` (`lib/ai/client.ts`) | §3 |
| **C. 단어장 판독** | 단어장 페이지 사진 → 책 그대로 전사한 단어 목록 | 전사 정확성 (책 원문 보존, 창작 금지) | 0 | 16,000 / 사진 | `VOCAB_EXTRACT_CALL_OPTIONS` (`lib/ai/english/vocabbook-prompts.ts`) | §7 |
| **D. 단어장 보강** | 판독된 단어·뜻 → 영영 정의 + 우리말 해석 + 이모지 | 창작 (정의 불변 — 채운 정의는 덮어쓰지 않음) | 0.7 | 8,000 | `VOCAB_ENRICH_CALL_OPTIONS` (`lib/ai/english/vocabbook-prompts.ts`) | §8-6 |
| **F. 챕터화** | 목차 챕터 제목 + 낭독 자막 → 챕터별 영어 원문·우리말 해석 문장 | 전사 + 번역 (자막 밖 창작 금지) | 0 | 16,000 | `CHAPTERIZE_CALL_OPTIONS` (`lib/ai/client.ts`) | §9-6 |
| **G. 단어 뜻 조회** | 단어 + 그 문장 → 그 문맥의 우리말 뜻 한 낱말 | 정확성 우선 (같은 입력은 같은 뜻) | 0 | 600 | `WORD_MEANING_CALL_OPTIONS` (`lib/ai/english/prompts.ts`) | §10-5 |
| **H. 유의어·반의어 추천** | 단어 + 뜻 + 관계 종류 → 초등 눈높이 후보 5~6개 | 정확성 우선 + 후보 다양성 | 0.3 | 800 | `RELATED_SUGGEST_CALL_OPTIONS` (`lib/ai/english/vocabbook-prompts.ts`) | §11-6 |
| **I. 자유대화 문장 설명** | 대화 스크립트의 문장 하나 + 앞뒤 대화 → 1학년 눈높이 선생님 말투 설명 대본(한/영 조각) | 창작(설명) + 환각 차단(짚은 단어 ⊂ 문장) | 0.5 | 1,500 | `TALK_EXPLAIN_CALL_OPTIONS` (`lib/ai/english/talk-prompts.ts`) | §12-3 |

호출 C는 **단어장 정복** 기능(§7)의 판독 호출로, A→A′→B 카드 파이프라인과는 별개의 경로입니다.
사진 1장 = 판독 1회이고, DAY 하나가 사진 여러 장이면 병렬 호출 후 앱이 번호로 병합합니다(§7-5).
호출 D·H도 단어장 쪽 호출(보강·연결 후보)이고, F·G는 챕터 리더(낭독 자막 → 챕터별 원문·해석,
단어 더블탭 뜻)의 호출입니다. 넷 다 카드 파이프라인과 별개 경로라 실패해도 카드를 막지 않습니다.
호출 I는 **자유대화**(§12 — 은우가 AI 전화영어 선생님과 5분 음성 대화, 제품 흐름은 `docs/SPEC.md` §21)가 끝난 뒤
문장 하나를 탭했을 때만 도는 설명 호출이고, 대화 자체는 표에 없는 **관문 R**(OpenAI Realtime — 브라우저 ↔ OpenAI
WebRTC 음성 ↔ 음성)이 맡습니다. 관문 R은 Structured Outputs가 아니라 `callWithSchema`·zod·재요청을 거치지 않고
키 규약만 공유합니다(클라우드 TTS·토익 관문 P/T와 같은 부류 — `docs/HARNESS.md` §0). 대화 중 주제 일러스트는
토익 관문 P와 같은 사진 생성 공용 코어(`lib/image-gen.ts`)로 만듭니다(§12-6).
옵션 값을 바꾸면 이 표와 해당 "상세" 절을 함께 고칩니다. 추론형 모델은 temperature 파라미터를 400으로
거부하므로, `callWithSchema`(`lib/ai/client.ts`)가 그 모델에 한해 파라미터를 빼고 다시 부릅니다 — 그 동안은
표의 temperature가 적용되지 않습니다.

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
위 블록은 카드 파이프라인의 최소 배치다. 단어장·챕터 리더 호출의 프롬프트는 `lib/ai/english/vocabbook-prompts.ts`
·`prompts.ts`(표의 "옵션 상수" 열), 자유대화(관문 R + 호출 I)는 `lib/ai/english/talk-prompts.ts`·`talk-schemas.ts`와
`lib/talk-*.ts` 여러 파일로 나뉜다 — 전체 목록은 §12-0이다.

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
- 픽션: 인물, 사건, 인과, 감정, 예측, 결말, 나와연결을 반드시 포함. 단 AR<2는 6개라 인과를 빼고 인물, 사건, 감정, 예측, 결말, 나와연결을 포함.
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
- 낭독 자막 실호출 게이트(`EVAL_TRANSCRIPT=1`일 때만 실호출 1회 — 기본은 돌지 않고, 켜면 기본 카드
  3건 **대신** 이것만 돈다): 자막을 넣은
  카드 1건이 (a) storySource=transcript·분량 8~10문장이고 (b) storyOutlineKo에 영어 원문 전사가 없고
  (c) 자막 앞뒤 채널 인트로/아웃트로의 고유 문구(채널명·낭독자 이름·구독 안내)가 줄거리에 섞이지
  않았는지를 검사한다. 오프라인 게이트(`EVAL_OFFLINE_ONLY=1`)에서는 절대 도달하지 않는다.
- 출력: 항목별 pass/fail 표. 하나라도 실패하면 exit code 1
- `package.json`에 `"eval:english": "tsx scripts/eval-english.ts"` 등록. CI가 아니라 수동 실행용이고, 실호출에는
  `OPENAI_API_KEY`가 필요하다. 실호출 수는 `scripts/eval-english.ts`의 `main` 기준으로 이렇다:
  - 기본 실행은 카드 3회(Wolves / Pooh / Pooh+장면 메모). `EVAL_SKIP_PAGES=1`이면 2회, `EVAL_THIN_PAGES=1`은
    3번째 입력만 얇은 근거로 바꿀 뿐 3회 그대로다.
  - 실호출 게이트 `EVAL_TRANSCRIPT=1`(자막 카드, 위)·`EVAL_CHAPTERS=1`(챕터화, §9-7)·`EVAL_VOCAB=1`(호출 D 보강
    텍스트)·`EVAL_WORDMEANING=1`(단어 뜻, §10-6)·`EVAL_TALK=1`(자유대화 호출 I, §12-5)은 **서로 배타적**이다.
    `main`이 이 순서로 확인해 처음 켜진 하나만 돌리고 return하므로(앞의 넷은 실호출 1회, `EVAL_TALK`만 선생님 문장 1 ·
    은우 문장 1로 2회), 게이트는 기본 카드 3회에 **더해지는 것이 아니라 그것을 대체한다.** 둘 이상 켜면 앞의 것만 돈다.
    호출 H(유의어·반의어 추천)의 실호출 프로브는 게이트가 아니라 오케스트레이터가 따로 돌린다(§11-7).
  - 게이트 실행에서는 앞서 돈 오프라인 점검의 결과를 표에 찍지도, 판정(exit code)에 넣지도 않는다 — 그 실행의
    PASS/FAIL은 게이트 항목만의 판정이다. 기본 실행(게이트 없음)은 오프라인 점검과 카드 점검을 함께 판정한다.
    오프라인만 보려면 `EVAL_OFFLINE_ONLY=1`(실호출 0회)을 쓴다.
  - "1회"는 `callWithSchema` 1회다. zod 검증이 실패해 재요청하면 API 요청은 2번 나간다.

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

`chapterTitles`는 목차 사진을 호출 A′(toc 모드)로 읽어 얻은 장면들의 `labelKo`를 아래 "목차 제목 준비"로
다듬은 배열이다(app-builder가 `/api/chapterize`에서 넘긴다). `labelKo`는 영어 챕터 제목 그 자체가 아니라
부모가 알아볼 이름이라 서수가 붙어 온다(§2A-1 — 목차 모드면 "3장: Pooh와 꿀단지"처럼).
**목차가 없으면(빈 배열)** `resolveChapterTitles`가 단일 제목 `WHOLE_TRANSCRIPT_TITLE`("전체") 하나로
치환하므로, 사용자 메시지의 목차 목록은 `1. 전체` 한 줄이 되고 프롬프트 [목차가 없을 때] 규칙에 따라
자막 전체가 그 한 챕터에 담긴다. **자막(transcript)만 필수**이고 목차는 선택이다.
`transcript`는 `truncateTranscriptForChapterize`로 `CHAPTERIZE_TRANSCRIPT_MAX_CHARS`(12,000자)까지 앞부분
우선으로 자른 자막이다 — 넘으면 앞 챕터부터 채워지고 뒤쪽 챕터는 자막이 닿지 않아 `matched:false`로 온다.

**목차 제목 준비 (`prepareChapterTitles`, schemas.ts — 순수 함수).** `/api/chapterize`는 A′ 목차 장면의
`labelKo`를 호출 F에 넘기기 전에 이 함수를 거친다. 막는 경계는 둘이다. 하나는 개수다 — A′는 장면을
`MAX_SCENE_DIGEST_ITEMS`(120)개까지 내는데 F의 zod는 챕터를 `CHAPTERIZE_MAX_CHAPTERS`(40)개까지만 받는다
(§9-4). 목차 제목을 그대로 넘기면 모델이 제목을 다 echo하는 순간 zod가 거부하고, 재요청 뒤 throw라
목차가 40개를 넘는 책은 챕터화가 통째로 실패한다. 다른 하나는 모양이다 — F는 받은 제목을 `titleEn`에
그대로 쓰고 챕터 리더는 탭에 번호를 따로 붙이므로, "3장: …"을 그대로 두면 번호가 두 번 보인다. 규칙은 이 순서다:

1. 트림하고 연속 공백을 한 칸으로 줄이고, 빈 값은 버린다.
2. 완전히 같은 제목(정규화 비교 — §9-4의 NFC·트림·공백·소문자)이 다시 오면 뒤의 것을 버린다. 같은 목차
   사진을 두 번 찍은 경우다.
3. 앞의 서수 접두어를 뗀다(`stripChapterOrdinalPrefix`) — "3장:"·"3장:꿀"·"제3장"·"챕터 3:"·"Chapter 3:"·
   "Chapter 7—Waiting"·"Chapter XLIV:"·"Chapter Twenty-One:"·"Ch. 3"·"Chap. 4 -"·"IV."·"(IV)"·"3."·"1.Pooh"·
   "3)"·"(3)"·"3 -". 지원 범위는 숫자 1~3자리, 로마 숫자 1~99(I~XCIX — "Chapter" 없이 앞에 붙은 로마 숫자는
   대문자이고 구분자 뒤에 공백이 있을 때만), 영어 수사 1~99(합성 수사 "Twenty-One"은 통째로)다. 접두어는
   **구분자까지** 있어야 접두어로 본다. 콜론·마침표·괄호 바로 뒤가 숫자면 구분자가 아니고, 하이픈은 앞이나
   뒤에 공백이 있어야 구분자다(붙은 하이픈은 합성어). 그래서 "1.5 Meters"·"3:10 to Yuma"·"101 Dalmatians"·
   "3장면"·"3-D Glasses"·"Chapter 1.5"·"L.A. Story"·"Chapter Twenty-Something"은 건드리지 않는다 — 못 떼는
   모양은 원문 그대로다. 겹친 접두어는 본문이 남는 동안 끝까지 뗀다("3장: Chapter 3: The Honey Pot" →
   "The Honey Pot"). 떼고 남은 것이 본문(글자·숫자, 또는 여는 따옴표 뒤 글자·숫자)으로 시작하지 않으면 그
   겹에서 멈춘다 — "Chapter 3"·"3장:"처럼 번호뿐인 제목은 원문으로 남고, "3장: Chapter 3"은 "Chapter 3"이 된다.
   떼고 나서 앞 제목과 겹치면("1장: 아침"·"5장: 아침") **" (n)"을 붙인다** → "아침"·"아침 (2)". F의 zod가
   `titleEn` 중복을 거부하기 때문이다. 접두어를 되살리지 않는 이유는 아래 표시 규칙이다 — 되살린
   "5장: 아침"은 챕터 리더가 표시할 때 다시 떼서 화면에서 "아침"끼리 겹친다.
4. 40개를 넘으면 **인접 제목을 순서대로 묶는다.** `ceil(n/40)`개씩 `" / "`로 이어 40개 이하로 만든다
   (41개 → 2개씩 21개, 120개 → 3개씩 40개). 뒤를 잘라 내지 않는 이유: 잘린 챕터의 자막이 앞 챕터에
   섞이거나 챕터 리더에서 통째로 사라진다. 묶이는 제목은 3단계를 지난 것이라 접두어가 섞이지 않는다
   ("아침 / 아침 (2)"). 묶은 제목이 `CHAPTER_TITLE_MAX`(200자)를 넘으면 뒤를 "…"로 줄이고, 줄여서 겹치면
   같은 " (n)"을 붙인다.
5. 결과가 비면 빈 배열을 넘긴다 → 위의 목차 없음 갈래("전체" 단일 챕터)로 간다.

챕터 번호는 챕터 리더 탭이 한 곳에서만 보여 준다. 챕터 리더는 저장된 `titleEn`을 표시할 때 3단계와 같은
정리(`cleanChapterTitles` — 접두어 떼기 + 겹침 " (n)")를 **모든 레코드에** 한다. 저장 shape에 "언제 만든
레코드인가" 표식이 없기 때문이다. 새 레코드에는 지울 접두어도 겹치는 제목도 없어서 이 정리가 아무것도
바꾸지 않는다 — 준비한 제목은 이 정리의 고정점이다. 접두어 떼기는 멱등이고, " (n)"·" / "가 붙은 제목은
떼고 남은 것이 "("·"/"로 시작해 다시 벗기지 않는다("3장 (2)"는 "(2)"가 되지 않는다). 이 규칙이 생기기 전에
접두어가 붙은 채 저장된 옛 레코드만 모양이 바뀌어, 서버가 같은 목차로 지금 만들 제목과 같게 보인다
("1장: 아침"·"5장: 아침" → "아침"·"아침 (2)"). 저장값은 "다시 나누기" 전까지 그대로다. 묶음이 생기면
라우트가 `{ call:"chapterize", bookId, tocTitleCount, groupSize, chapterTitleCount }`를 경고 로그로 남긴다.
응답 shape은 바뀌지 않는다.

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
- 목차 제목 준비(§9-2, 오프라인·실호출 0회): `stripChapterOrdinalPrefix`가 한국어·영어·번호 접두어 변형을
  떼는지, 그리고 반례 — 합성 수사("Chapter Twenty-One: The Party" → "The Party", 앞 낱말만 떼 "One: The Party"가
  되면 실패), 로마 숫자 XL~XLIX·XC~XCIX, 앞에 붙은 로마 숫자("IV. Rabbit's House"·"(IV) Rabbit"), 공백 없는
  번호("1.Pooh"·"3:Stuck"·"7—Waiting"), 겹친 접두어("3장: Chapter 3: The Honey Pot" → "The Honey Pot").
  숫자·약어로 시작하는 진짜 제목("1.5 Meters"·"3:10 to Yuma"·"101 Dalmatians"·"3장면"·"3-D Glasses"·
  "Chapter 1.5: Interlude"·"L.A. Story"·"I Spy Pooh"·"Chapter Twenty-Something Blues" 등)은 두고, 접두어만 있는
  값("3장"·"Chapter 3"·"Chapter Twenty-One"·"3."·"IV.")은 원문으로 두는지. 표 입력 전부에서 멱등인지.
  `prepareChapterTitles`가 빈 값·공백만인 입력을 빈 배열로 만들고, 완전 중복을 버리고, 접두어를 뗀 뒤 겹치는
  제목에 " (n)"을 붙이는지(접두어를 되살리지 않는다 — "1장: 아침"~"40장: 아침"이 "아침"·"아침 (2)"…"아침 (40)",
  80개 묶음이 "아침 / 아침 (2)"…). 묶기 경계 — 40개는 묶지 않고, 41개는 2개씩 21개, A′ 상한 120개는 3개씩
  40개이며 순서가 보존되고 유실이 없는지. 긴 `labelKo`(120자) 120개를 묶어도 제목이 200자 이하·유일한지.
  표시 일관성 — 서버가 준비한 제목에 챕터 리더의 정리(`cleanChapterTitles`)를 해도 그대로인지(말뭉치 8종:
  접두어만 있는 제목의 겹침 "3장 (2)"·묶음 "Chapter 1 / Chapter 2"·기호 본문 "3장: ★ (2)" 포함), 옛 레코드
  (접두어가 남은 `titleEn`, 전 규칙이 되살린 "2장: 아침" 포함)는 서버가 같은 목차로 지금 만들 제목과 같게
  보이는지. 배선 — `components/chapter-reader.tsx`가 탭·헤딩 제목을 `cleanChapterTitles`로 만들고, 제목마다
  `stripChapterOrdinalPrefix`를 부르거나 `titleEn`을 그대로 그리지 않는지(소스 정적 점검). 그리고 경계면 자체 —
  준비 전 120개 제목을 echo한 출력은 F zod가 거부하고, 준비한 40개를 echo한 출력은 통과하는지.
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


---

## 12. 자유대화 — 관문 R(실시간 음성) + 호출 I(문장 설명)

은우(초등 1학년)가 **AI 전화영어 선생님**과 짧게 영어로 이야기하는 기능이다(제품 흐름·결정·비용은 `docs/SPEC.md` §21). 카드·단어장 파이프라인과 별개 경로다. 두 부분으로 나뉜다.

- **관문 R — 실시간 음성 대화.** OpenAI Realtime(`gpt-realtime-2.1`, 음성 ↔ 음성). Structured Outputs가 아니라 **하네스 밖 관문**이다(클라우드 TTS·토익 관문 P/T와 같은 부류 — `callWithSchema`·zod·재요청을 거치지 않고 키 규약만 공유). 여기서 스펙이 못박는 것은 **선생님 지시문 원문**(spec-sync 대상), 세션 설정, 이벤트 → 스크립트 규칙이다.
- **호출 I — 문장 설명.** 대화가 끝난 뒤 스크립트의 문장 하나를 탭하면, 그 문장과 앞뒤 대화로 **선생님 말투의 설명 대본**(한국어·영어 조각)을 만든다. 하네스 안(`callWithSchema`)이다.

**눈높이**: 이 절의 모든 문구는 **초등학교 1학년**(약 7세, 영어 초급) 기준이다. 기존 은우 프롬프트("초등학생·저학년")보다 한 단계 구체적이다 — 기존 문구는 이번에 바꾸지 않는다. **아이 이름은 AI에 보내지 않는다**(화면의 "은우" 라벨은 로컬 표시일 뿐이다).

**스코프 경계**: 이 절은 지시문·세션 설정·리듀서 규칙·호출 I(프롬프트·스키마·zod·옵션·eval)까지다. WebRTC 연결·마이크(`lib/mic-session.ts` 단일 관문)·화면·저장·라우트 배선은 앱(app-builder) 몫이다.

### 12-0. 파일 배치

```
lib/ai/english/talk-prompts.ts    # §12-1 지시문·수업 블록·인사·마무리 문구, §12-3 호출 I 프롬프트·옵션 (원문 상수)
lib/ai/english/talk-schemas.ts    # §12-3 JSON Schema + buildTalkExplainZod + 타입
lib/talk-topics.ts                # 주제 프리셋 단일 정의(클라이언트 안전, 런타임 import 0)
lib/talk-session-config.ts        # 서버 전용: 주제/단어 → 지시문 조립 + Realtime 세션 설정(관문 R, 모델·음성 env 해석)
lib/talk-transcript.ts            # §12-2 이벤트 → 스크립트 순수 리듀서 + 저장용 턴 변환 + 문장 나누기
lib/talk-explain-script.ts        # 설명 대본 → speakQueue 조각(ko-KR/en-US, splitForTts)
lib/talk-streak.ts                # SPEC §17-9 대화 → StreakSession
```

위 블록은 스펙을 쓸 때 정한 AI·순수 모듈이다. 구현(2026-09-26)이 더한 파일은 아래와 같다 — 화면 카드(§12-6)의 순수 모듈 둘과 앱(라우트·저장·실시간 클라이언트·화면) 쪽이다. **클라이언트 번들 경계**가 파일을 가르는 기준이다: 화면이 값으로 import하는 모듈(`talk-transcript`·`talk-topics`·`talk-cards`·`talk-hints`·`talk-streak`·`talk-contract`·`talk-realtime`)은 런타임 import가 서로와 `mic-session`뿐이고 `lib/ai`·openai·zod는 `import type`만 한다 — 선생님 지시문·호출 I 프롬프트·키가 폰 번들로 새지 않게.

| 파일 | 경계 | 맡은 일 |
|---|---|---|
| `lib/talk-cards.ts` | 클라이언트 안전 | §12-6 도구 호출 검사 `parseTalkToolCall`·카드 정리 `sanitizeTalkCard(s)`·기본 문구 `TALK_FALLBACK_HINTS`·단어장 ✓ `matchTalkWord`·폭 `TALK_CARD_LIMITS`, 응답에서 function_call 꺼내기·응답 끝 요약·호출 결과 항목 |
| `lib/talk-hints.ts` | 클라이언트 안전 | §12-6 말문 막힘 도움 **순수 상태 기계**(시계는 인자) + 서버 이벤트 옮기기 `talkHintEventFromServer` + 화면 뷰 `viewTalkHints` |
| `lib/talk-realtime.ts` | 클라이언트 전용 | 실시간 클라이언트 — 대화 한 번의 컨트롤러 `TalkCallController`(useSyncExternalStore용)와 WebRTC 전송(마이크 트랙·원격 `<audio>`·데이터 채널 `oai-events`). 안내 넣기·도구 호출 처리·응답 진행 중 보류·5분 마무리·끝내기(hangup `sendBeacon`)·저장 본문 |
| `lib/talk-fake-transport.ts` | 개발 빌드 전용 | 합성 이벤트 가짜 전송(e2e 대역, 동적 import — production 번들에 없다) |
| `lib/talk-contract.ts` | 클라이언트 안전 | 라우트 ↔ 화면 요청·응답 계약, 상한 상수(일러스트 900,000자·제목 60자·저장 키 형식·keepalive 한도), 저장 키 `newTalkSaveId`, 주소 함수 |
| `lib/talk-gateway.ts` | 서버 전용 | 관문 R 네트워크 — `POST {OPENAI_BASE_URL \|\| https://api.openai.com/v1}/realtime/calls`(multipart `sdp`+`session`, 상한 20초)·hangup(상한 8초). 실패는 결과 값 |
| `lib/talk-topic-request.ts` | 서버 전용 | connect·scene 공용 주제 요청 zod + 해석(단어장은 스토어에서 읽어 404를 가린다, 계약 ↔ zod 양방향 묶음) |
| `lib/talk-record.ts` | 서버(페이지·라우트) | 렌더 판정 `isRenderableTalkSession`, 기본 제목 `defaultTalkTitle`("{주제} 대화"), 목록 줄 `toTalkHistoryItem`·정렬 |
| `lib/talk-normalize.ts` | 서버 전용 | 두 백엔드 공용 정규화(`normalizeTalkSessionRecord`·`normalizeTalkImageRecord`)와 설명 추가 판정 `decideTalkExplanation` |
| `lib/talk-image.ts` | 서버 전용 | 주제 일러스트 `generateTalkSceneImage`(low·1024×1024·압축 60→40·태그 `talk_scene`) — 공용 코어를 대화 설정으로 부른다 |
| `lib/image-gen.ts` | 서버 전용 | **사진 생성 공용 코어**(토익 관문 P와 공유) — 모델 env·키 규약·JPEG data URL·크기 초과 시 다음 압축으로 1회 재생성·로그 모양. 과목을 모른다 |
| `lib/mic-session.ts` `acquireMicStream` | 클라이언트 | 대화 내내 열린 마이크(녹음기 없이 스트림만) — play-and-record → getUserMedia(대기 상한 15초) → `release()`(트랙 stop → playback). 토익 녹음과 같은 단일 관문 |
| `app/api/english/talk/**` | 라우트 9개 | `connect`·`scene`·`hangup`·저장(`route.ts`)·`reorder`·`[id]`(DELETE)·`[id]/explain`·`[id]/rename`·`images/[id]`(GET) — 전부 `runtime = "nodejs"`, 상태코드는 계약 파일 |
| `app/english/talk/page.tsx`·`[id]/page.tsx` | 서버 컴포넌트 | 시작 화면(단어장 줄 정보·지난 대화·안내 글 props)·대화 보기 |
| `components/talk-*.tsx`·`talk.module.css` | 화면 | 시작(`talk-start-view`)·대화 오버레이(`talk-call-overlay`)·지난 대화 목록(`talk-history-list`)·대화 보기와 설명 시트(`talk-review-view`)·제목 편집(`talk-title-editor`) |

### 12-1. 관문 R — 선생님 지시문과 세션 설정

지시문은 영어로 쓴다(선생님이 영어로 말하고, Realtime 모델의 지시 준수가 영어에서 가장 안정적이다). 한국어 사용 규칙은 지시문 안에 둔다.

**선생님 지시문 (원문 그대로 사용 — `TALK_TEACHER_INSTRUCTIONS`).** `{lesson}` 자리에 아래 수업 블록 하나를 끼운다(치환은 이 한 자리뿐).

```
You are Sunny, a warm and cheerful English tutor talking with a Korean child on a short phone call. The child is in the first grade of elementary school (about 7 years old) and is a beginner in English. A parent is nearby.

# Your manner
- Talk like a kind home tutor who loves kids: gentle, playful, and encouraging.
- Speak slowly and clearly. Pause briefly between sentences.

# How you talk
- Use very easy English that a first-grade beginner can understand.
- Say only one or two short sentences, then ask one easy question. Ask only one question at a time.
- Prefer questions the child can answer with a word or two: yes/no questions, choices ("Is it red or blue?"), or "What is it?".
- Be patient. The child may pause for a long time, say "um", or answer with one word. That is fine.
- If the child is stuck or quiet, help: give two choices, give the first word, or say a short model answer and invite the child to say it with you ("Can you say: I like apples?").
- Praise often and specifically ("Great job!", "Wow, you said it!").
- Never say "wrong" or "No, that's not right." When the child makes a mistake, happily say the correct sentence back and keep going. For example, the child says "I like dog." and you say "Oh, you like dogs! Me too!"
- Keep your turns short so the child can talk a lot.

# Korean
- Speak English almost all the time.
- If the child speaks Korean or doesn't understand, you may say one very short Korean phrase to help (for example, "사과는 apple이야!"). Then go back to English right away and invite the child to try in English.
- Never give long explanations in Korean.

# Today's lesson
{lesson}

# Staying on track
- Keep the talk on today's lesson. If the child talks about something else, answer kindly in one short sentence and gently come back to the lesson.
- If the child's words are unclear, ask again with a short, friendly phrase such as "Can you say that again?"

# Safety
- Never ask for personal information: the child's full name, school name, address, phone number, passwords, photos, or where the child is right now. If the child says such things, do not repeat them.
- If the child shares something scary or sad, respond gently, say it is a good idea to tell mom or dad, and return to the lesson.
- If asked, say honestly that you are an AI English teacher.
- Keep everything kind, safe, and right for a young child.
```

**수업 블록 — 주제 (`TALK_LESSON_TOPIC`).** `{topic}` = 프리셋이면 `"{labelEn} ({labelKo})"`, 직접 입력이면 입력한 글자(정리 후).

```
Today's topic is: {topic}
Talk about this topic with easy words and simple questions. If the topic is written in Korean, understand it and talk about it in English.
```

**수업 블록 — 단어장 (`TALK_LESSON_WORDS`).** `{title}` = 단어장 표시 이름, `{words}` = 줄마다 `- {word} ({우리말 뜻})`.

```
Today's words come from the child's word book "{title}":
{words}
Use these words naturally in the conversation and practice about 4 to 6 of them. For each word you practice, say it clearly, use it in a very short sentence, and invite the child to say it or use it. Do not read the list out loud; weave the words into the talk.
```

**첫 인사 (`TALK_GREETING_INSTRUCTIONS`).** 데이터 채널이 열리면 앱이 이 문구를 **숨은 system 메시지 항목**(`conversation.item.create`, id 접두사 `app_`)으로 넣고 `response.create`(인자 없음)를 보낸다 — 선생님이 먼저 말한다. 응답 단위 `instructions`로 보내지 않는다: 그 값은 세션 지시문을 **덮어써** 그 응답에서 선생님 성격·안전 규칙이 빠질 수 있다(2026-09-26 정정 — 앱이 넣는 안내는 전부 이 방식이다, §12-6).

```
Start the call now: say hello warmly, say that your name is Sunny, and ask one easy warm-up question about today's lesson. Use no more than two short sentences and one question.
```

**마무리 (`TALK_WRAPUP_INSTRUCTIONS`).** 5분 상한에 닿으면 앱이 같은 방식(숨은 system 메시지 + `response.create`)으로 보낸다.

```
Our time is almost up. Finish the call now: praise one thing the child did well today in one short sentence, then say a warm goodbye. Do not ask any more questions.
```

**입력 정리(서버, 순수 함수 — 지시문에 넣기 전에 끝낸다):**
- 주제 프리셋 키는 `lib/talk-topics.ts`에 있는 것만 받는다(프리셋 10개: 동물·음식·가족·학교와 친구·놀이·날씨·색깔과 모양·오늘 하루·공룡·생일 — 키·한국어·영어 라벨·이모지를 한 곳에).
- 직접 입력 주제: 줄바꿈·제어문자 제거, 앞뒤 공백 정리, 1~30자. 지시문 주입을 막으려고 따옴표·`#`·백틱을 걷어 낸다.
- 단어장: 서버가 `getVocabBook(id)`로 읽고(클라이언트는 id만 보낸다) 렌더 판정(`isRenderableVocabBook`)으로 404를 가린다. 단어는 책 순서로 **최대 20개**, 각각 `word`와 첫 우리말 뜻(`meanings[0].ko`, 없으면 `definitionKo`, 둘 다 없으면 뜻 생략). "모은 단어" 단어장도 같은 방식이다(`word`·`meanings[].ko`만 있다).
- 저장 레코드에는 **실제로 넘긴 주제·단어를 스냅샷**으로 남긴다(나중에 단어장이 바뀌어도 대화 기록은 그대로).
- 구현이 정한 세부(`lib/talk-session-config.ts` — 전부 결정적): 직접 입력이 30자를 넘으면 **자르지 않고** 거부한다(null → 400 — 조용히 잘린 주제가 저장되지 않게, 글자 수는 코드 포인트). 굽은 따옴표·전각 `＃`도 걷는다. 단어장 단어는 빈 단어·같은 단어(대소문자 무시) 되풀이를 건너뛰고(20자리 낭비 방지), 첫 뜻이 빈 문자열이면 `definitionKo`로 간다. 단어장 제목은 지시문에서 큰따옴표 안에 들어가므로 줄바꿈·제어문자·큰따옴표·백틱을 걷고, 비면 "단어장"이다. 넘길 단어가 0개면 400이다.

**세션 설정(통합 인터페이스 — 서버가 `POST {OPENAI_BASE_URL}/realtime/calls`에 multipart `sdp` + `session`으로 보낸다. 필드 이름은 설치된 SDK의 GA 타입과 맞춘다):**

| 필드 | 값 | 근거 |
|---|---|---|
| `type` | `"realtime"` | GA 필수 |
| `model` | env `OPENAI_REALTIME_MODEL`(빈 값이면 `gpt-realtime-2.1`) | 사용자 결정 |
| `instructions` | `TALK_TEACHER_INSTRUCTIONS`의 `{lesson}` 치환 결과 | 위 |
| `output_modalities` | `["audio"]` | 오디오 + 발화 전사가 같이 온다 |
| `reasoning.effort` | `"low"` (SDK가 지원할 때 — 구현은 모델 이름이 `gpt-realtime-2` 계열일 때만 싣는다, `supportsRealtimeReasoning`) | 음성 대화 지연 — 공식 권장 출발점. env로 비추론 모델(mini 등)로 바꿨을 때 이 필드 때문에 연결이 거부되지 않게 |
| `max_output_tokens` | 1200 | 선생님 차례를 짧게(오디오 1초 ≈ 20토큰). 짧게 말하기는 지시문이 1차로 강제한다 |
| `audio.input.transcription` | `{ model: env OPENAI_REALTIME_TRANSCRIBE_MODEL(빈 값이면 gpt-4o-mini-transcribe) }`, **language·prompt 지정 없음** | 은우가 한국어를 섞는다(영어 고정 시 억지 전사). 단어장 단어를 prompt로 주지 않는다 — 하지 않은 말이 맞게 적히는 위험(토익 관문 T와 같은 원칙) |
| `audio.input.turn_detection` | `{ type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true }` | 아이의 긴 쉼·"음…"에서 끊지 않게(최대 대기 약 8초) |
| `audio.input.noise_reduction` | `{ type: "far_field" }` | 폰을 들고 스피커로 말하는 상황 |
| `audio.output.voice` | env `OPENAI_REALTIME_VOICE`(빈 값이면 `marin`) | 공식 권장 음성 |
| `audio.output.speed` | 천천히 0.85(기본) · 보통 1.0 | 화면에서 고른 값(서버가 두 값만 받는다) |

- 연결 응답의 `Location` 헤더 마지막 조각이 `callId`다. 라우트는 SDP answer와 `callId`, 그리고 **해석한 주제 스냅샷**(`TalkTopic`)을 돌려준다. 키가 없으면 OpenAI를 부르지 않고 501.
  구현(`POST /api/english/talk/connect` → `lib/talk-gateway.ts`): 응답에는 저장 레코드용 `model`·`voice`(세션 설정에 넣은 값과 같은 해석 함수)도 실린다. `rtc_…` 모양은 추정이라 callId는 접두사를 강제하지 않고 `[A-Za-z0-9_-]{1,200}`만 받는다(hangup 경로 조작 차단이 목적). `Location`을 못 읽으면 연결은 살리고 `callId: null`로 준다(서버 hangup 이중 장치만 빠진다 — 경고 로그). 상류 오류·시간 초과(20초)·answer가 SDP 모양이 아니면 500 `connect_failed`, 모르는 프리셋·30자 초과·단어 없는 단어장은 400, 없는 단어장은 404.
- 서버 로그에는 SDP·지시문·전사를 남기지 않는다(모델·상태·ms만).
- 끝낼 때 `POST /v1/realtime/calls/{callId}/hangup`(서버). 실패해도 무시한다(이미 끊겼을 수 있다). 브라우저는 앱 라우트 `POST /api/english/talk/hangup`에 `sendBeacon`(본문은 `text/plain` JSON — content-type에 기대지 않고 글자를 읽는다, 안 되면 `fetch` keepalive)으로 부르고, 라우트는 상류가 실패해도 200 `{hungUp:false}`다.
- **끝내기 전 전사 기다림**(구현 `lib/talk-realtime.ts` `finish`, 2026-09-26 확정 — 제품 흐름은 SPEC §21-2 4). "끝내기" 버튼과 5분 마무리 뒤 종료는 아직 전사 중인 은우 줄(§12-2의 `listening`·`partial`)이 있으면 바로 닫지 않고, 그 줄의 전사가 끝나기(`completed`·`failed`)를 **최대 2.5초**(`TALK_FINISH_TRANSCRIPT_WAIT_MS`) 기다린 뒤 닫는다 — 은우가 말을 마치자마자(또는 말하는 도중에) 끝내기를 눌러도 마지막 말이 저장에서 빠지지 않게. 기다리는 동안(`finishing` — 화면은 "은우 말을 받아 적는 중…", 끝내기 버튼 잠김, 도움 카드 숨김) 클라이언트는 대화 중인 세션에 이벤트를 넷까지 보낸다. 먼저 `session.update`로 턴 감지를 끈다(`audio.input.turn_detection: null`만 싣는 부분 갱신 — 새 은우 차례도 자동 응답도 생기지 않는다). 은우가 말하는 중이었으면 `input_audio_buffer.commit`으로 그때까지의 소리를 넘긴다 — 턴 감지를 끄면 서버가 스스로 커밋하지 않기 때문이고, 말하는 중이 아니면 보내지 않는다(침묵을 커밋하면 전사 모델이 하지 않은 말을 지어낼 수 있다). 진행 중 응답이 있으면 `response.cancel`, 선생님 소리가 나는 중이면 `output_audio_buffer.clear`를 보낸다. 마이크 트랙은 끄고(무음 프레임 — 트랙을 멈추는 것은 끝낼 때의 release다) 선생님 소리는 음소거한다. 턴 감지 끄기가 늦게 먹어 응답이 새로 시작되면(`response.created`) 그 자리에서 다시 취소하고, 새로 나는 소리도 비운다(두 겹). 기다리는 동안에는 도움 요청·일러스트 안내·도구 결과가 나가지 않는다(대화 중일 때만 보내므로). 기다릴 줄이 없거나 아직 연결 중이면 곧바로 끝낸다. **화면 숨김·뒤로가기(언마운트)·`pagehide`·연결 끊김은 기다리지 않는다** — 기다리는 중이어도 즉시 닫는다(과금 중지가 먼저다). 2.5초 안에 오지 않은 전사는 저장에서 빠진다. 대화가 끝난 시각(`endedAt`)은 끝내기를 누른 때다(기다린 시간은 대화가 아니다). 2.5초는 개발 전용 시간 배율을 곱하지 않는 벽시계 값이다. 네 이벤트의 모양은 설치된 SDK GA 타입(`SessionUpdateEvent`·`InputAudioBufferCommitEvent`·`ResponseCancelEvent`·`OutputAudioBufferClearEvent`)에 `satisfies`로 묶여 tsc가 검사한다. 이 흐름은 오프라인 eval 밖이고 가짜 전송 e2e로 확인했다(QA 4회차). 실제 연결에서 대화 도중의 턴 감지 끄기와 수동 커밋이 받아들여지는지는 실연결·실기기로 본다(SPEC §21-5 11).

### 12-2. 이벤트 → 실시간 스크립트 (순수 리듀서 `lib/talk-transcript.ts`)

화면은 이벤트를 직접 그리지 않고, 리듀서가 접은 `lines`만 그린다. 줄 모양: `{ itemId, speaker: "teacher" | "child", text, status: "listening" | "partial" | "final" | "interrupted" | "failed" | "empty" }`.

1. **자리는 글자 도착 순서가 아니라 항목 연결로 정한다.** 은우 전사는 별도 음성 인식이 비동기로 만들어 선생님 응답보다 늦게 올 수 있다.
   - `input_audio_buffer.speech_started{item_id}` → 은우 줄을 **맨 뒤에** 만든다(`listening`, "듣는 중…").
   - `conversation.item.added`(구형 `conversation.item.created`)·`input_audio_buffer.committed`의 `previous_item_id` → 그 항목을 `previous_item_id` **바로 뒤로** 옮긴다(모르면 맨 뒤). 선생님 항목은 은우 항목이 커밋된 뒤 생기므로, 은우 글자가 아직 비어 있어도 선생님 줄이 그 아래에 선다.
2. 은우 글자: `conversation.item.input_audio_transcription.delta` → 이어 붙임(`partial`), `.completed` → 최종 글자로 **교체**(`final`). 빈 문자열(잡음·무응답 커밋)이면 `empty`(화면에서 숨김), `.failed`면 `failed`("잘 안 들렸어요").
3. 선생님 글자: `response.output_audio_transcript.delta` → 이어 붙임, `.done` → 교체(`final`).
4. `response.done`의 status가 `cancelled`(은우가 끼어듦 등)면 그 선생님 줄을 `interrupted`로 둔다(글자는 남긴다). `incomplete` + `content_filter`면 줄을 흐리게 표시한다.
5. 앱이 넣은 숨은 항목(아이디 접두사 `app_`)은 줄로 만들지 않는다.
6. 같은 이벤트가 두 번 와도 결과가 같아야 한다(멱등). 모르는 이벤트는 무시한다.
7. 저장용 변환 `toTalkTurns(lines)`: `empty`·`failed`·글자 없는 줄을 빼고 `{speaker, text, interrupted}`로. `childTurnCount` = 은우 턴 수.
8. **문장 나누기** `splitTalkSentences(text)`: `.`·`?`·`!`(와 한국어 문장 끝) 뒤 공백에서 자른다. 숫자 속 마침표("3.5")는 자르지 않는다. 설명의 키는 `(turnIndex, sentenceIndex)`이므로 **같은 글자는 늘 같게 나뉘어야 한다**(결정적).

구현이 정한 세부(2026-09-26 — 위 규칙을 좁히거나 넓히지 않고, 규칙이 말하지 않은 자리를 채웠다):
- 줄 모양에 불리언 `filtered`가 하나 더 있다 — 4의 "흐리게"를 status를 바꾸지 않고 표시하려고. 화면은 말풍선을 **`isVisibleTalkLine`으로만** 거른다: `empty`와 **글자 없이 끝난 `interrupted`/`final` 줄**(글자가 오기 전에 끊긴 응답)은 숨기고, `listening`과 진행 중 `partial`은 보인다.
- 4의 끊김에는 `response.done` status `failed`도 든다(`cancelled`처럼 `interrupted`, 글자는 남긴다). `completed`/`incomplete`면 남은 `partial`을 `final`로 접는다(전사 `.done`이 빠져도 "입력 중"이 남지 않게). 확정 전사가 먼저 와 있으면 늦은 `failed`가 이기지 않는다.
- 1의 "모르면 맨 뒤"는 **새 줄**에만 적용한다 — 이미 있는 줄은 앞 항목을 모르면 제자리다(먼저 받은 더 나은 연결 정보를 깨지 않게). 한 번 적용한 연결은 다시 적용하지 않아 이벤트 재생·중복에도 멱등이고, delta는 `event_id`로 한 번만 붙인다(개발용 가짜 전송도 이벤트마다 고유 `event_id`를 넣는다). `previous_item_id: null`도 "모름"이다.
- 5를 연결까지 넓혔다: `app_` 항목, **선생님의 도구 호출 항목(`function_call`, §12-6)**, 앱이 아닌 system 메시지 같은 "말이 아닌 항목"은 줄을 만들지 않되 연결은 기억해, 그 항목을 `previous_item_id`로 가리키는 줄은 숨은 항목의 앞 항목 뒤에 선다 — 도구 호출이 선생님 말 앞뒤에 끼어도 스크립트 순서가 흔들리지 않는다. 앱 항목 id는 `app_` + 영문·숫자·`_`·`-` 1~28자(32자 이하, 형식이 틀리면 빌더가 던진다).
- 8의 끝 부호에 말줄임 `…`과 전각 `。？！`를 더하고, 닫는 따옴표·괄호는 앞 문장에 붙이며, 호칭 약어(Mr·Mrs·Ms·Dr) 뒤 마침표는 자르지 않는다. 설명 라우트는 과금 전에 같은 함수(`pickTalkSentence`)로 범위 밖 번호를 400으로 가른다.
- 이벤트 이름은 설치된 SDK(openai 7.4.0)의 GA 타입 `RealtimeServerEvent["type"]`으로 tsc가 검사한다 — 이름을 틀리면 빌드가 막힌다.

### 12-3. 호출 I — 문장 설명

**시스템 프롬프트 (원문 그대로 사용 — `TALK_EXPLAIN_SYSTEM_PROMPT`):**

```
너는 초등학교 1학년 아이의 영어 가정교사다. 아이가 방금 AI 영어 선생님과 짧은 영어 전화 대화를 했다. 대화 스크립트에서 아이가 고른 문장 하나를, 전화영어 선생님이 옆에서 다정하게 말로 설명해 주듯 풀어 준다.

[누가 한 말인가]
- speaker가 teacher면 선생님(AI)이 한 영어 문장이다. 아이가 이 문장을 알아듣고 대답도 해 볼 수 있게 돕는다: 우리말 뜻을 쉽게 알려 주고, 중요한 단어 한두 개를 짚고, 아이가 이렇게 대답할 수 있다는 아주 짧은 영어 대답 예시를 하나 보여 준다.
- speaker가 child면 아이가 한 말이다. 먼저 잘한 점을 구체적으로 칭찬한다. 틀린 곳이 있으면 "이렇게 말하면 더 멋져요"처럼 더 자연스러운 영어 문장을 보여 주고, 왜 그런지 아주 쉽게 한 줄로 말한다. 아이가 한국어로 말했으면 그 말을 영어로 어떻게 하는지 알려 준다. 이미 잘 말했으면 억지로 고치지 않는다.
- 아이의 말은 음성 인식으로 옮긴 글이라 틀리게 적혔을 수 있다. 인식 실수로 보이는 것은 고치지 말고, 뜻이 통하는 쪽으로 너그럽게 읽는다.

[말투]
- 1학년 아이에게 말하듯 아주 쉽고 짧게, 다정한 해요체로 쓴다. 예: "이 말은 '나는 강아지를 좋아해요'라는 뜻이에요!"
- 어려운 문법 용어(주어·동사·복수형 같은 말)를 쓰지 않는다. 예: "주어" 대신 "누가", "동사" 대신 "무엇을 해요"처럼 쉬운 말로 풀어요.
- 아이 이름을 부르지 않는다.

[script — 소리 내어 읽을 설명 대본]
- 설명을 짧은 조각 3~8개로 나눈다. 조각마다 lang(ko 또는 en)과 text를 쓴다.
- 한국어 조각(ko)에는 영어 글자를 넣지 않는다. 영어 단어나 문장은 반드시 따로 떼어 en 조각으로 쓴다. 예: [ko "이 단어는", en "like", ko "'좋아해요'라는 뜻이에요."]
- 영어 조각 바로 뒤의 한국어 조각은 조사(는·를·가·이 같은 말)로 시작하지 않게 문장을 짠다.
- 영어 조각(en)은 영어만 쓰고, 한 조각에 12단어를 넘기지 않는다.
- 한국어 조각 하나는 60자 이내로 쓴다. 전체를 소리 내어 읽어서 20초 안팎이 되게 짧게 쓴다.
- en 조각을 하나 이상 넣는다(고른 문장, 대답 예시, 고친 문장 같은 것).

[betterEn — 더 멋진 문장]
- speaker가 child이고 더 자연스러운 영어 문장이 있으면 그 문장 하나를 쓴다. 이미 잘 말했거나 speaker가 teacher면 null로 둔다.

[keyWords — 짚어 준 단어]
- 고른 문장 안에 실제로 있는 영어 단어 가운데 설명에서 짚은 것 0~3개와 그 쉬운 우리말 뜻을 쓴다. 문장에 없는 단어는 넣지 않는다.

[금지]
- 대화 스크립트에 없는 말을 아이나 선생님이 했다고 하지 않는다.
- 무섭거나 어른스러운 내용을 쓰지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.
```

**사용자 메시지 템플릿 (`TALK_EXPLAIN_USER_TEMPLATE` — `{…}` 자리만 치환):**

```
주제: {topicLabel}
누가 한 말: {speaker}
고른 문장: {sentence}
앞뒤 대화:
{context}
```

- `{speaker}` = `teacher` 또는 `child`. `{topicLabel}` = 주제 한국어 라벨(단어장이면 단어장 이름).
- `{context}` = 고른 문장이 속한 턴의 앞 4줄 + 그 턴 + 뒤 2줄, 줄마다 `선생님: …` / `아이: …`, 고른 턴 앞에 `▶ ` 표시. 아이 이름은 넣지 않는다.

**출력 JSON Schema (strict):**

```json
{
  "name": "talk_sentence_explanation",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["script", "betterEn", "keyWords"],
    "properties": {
      "script": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["lang", "text"],
          "properties": {
            "lang": { "type": "string", "enum": ["ko", "en"] },
            "text": { "type": "string" }
          }
        }
      },
      "betterEn": { "type": ["string", "null"] },
      "keyWords": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["en", "ko"],
          "properties": {
            "en": { "type": "string" },
            "ko": { "type": "string" }
          }
        }
      }
    }
  },
  "strict": true
}
```

**zod (`buildTalkExplainZod({ speaker, sentence })` — 입력을 알고 만든다; 폭은 프롬프트보다 넓게):**
- `script` 2~10조각, ko·en 각 1개 이상. ko 조각: 한글 포함, **라틴 문자 금지**, 80자 이하. en 조각: 라틴 포함, 한글 금지, 16단어 이하. ko 조각 글자 합 400자 이하.
- `betterEn`: speaker가 `teacher`면 **반드시 null**. 값이 있으면 라틴 포함·한글 금지·25단어 이하.
- `keyWords` 0~3개, `en`은 **라틴 포함·한글 금지**이고(2026-09-26 QA가 찾은 구멍 — 은우 문장 "나는 강아지 좋아."에서 `{en:"강아지"}`나 부분 글자 "강아"가 경계 판정을 통과했다) **고른 문장 안에 단어 경계로 있어야** 한다(대소문자 무시 — 문장에 없는 단어를 짚었다면 환각이다), `ko`는 한글 포함 20자 이하. 거부 → 재요청 1회(§4 규약).

**호출 옵션 (`TALK_EXPLAIN_CALL_OPTIONS`)**: call `talk_explain`, temperature 0.5, max_output_tokens 1500. 추론형 모델이면 §4대로 temperature 자동 생략.

**경계면(app-builder)**: 진입 함수는 `lib/ai/client.ts`에 편의 함수로(예: `explainTalkSentence(input)` — 과목 분기 없이 `callWithSchema`만 부른다, 기존 `lookupWordMeaning`·`suggestRelatedWords` 관용구). 라우트 `POST /api/english/talk/[id]/explain {turnIndex, sentenceIndex}`는 저장된 대화에서 문장·문맥을 서버가 꺼내 부르고(클라이언트가 문장을 보내지 않는다), 결과를 대화 기록의 `explanations`에 **처음 한 번만** 저장한다(같은 키가 이미 있으면 그것을 돌려준다 — 두 번 탭해도 한 번 과금). 키 없음 501, 없는 대화·범위 밖 번호 404/400, 실패 500.
구현(`lib/ai/client.ts` `explainTalkSentence` — `callWithSchema`만 부른다, 로그 라벨 `talk_explain`, 모델 `resolveModel()`을 결과 `model`에 남긴다): 라우트는 **저장된 설명이 있으면 키 검사보다 먼저** 돌려준다(`cached: true` — 키가 없는 환경에서도 이미 들은 설명은 다시 볼 수 있다). 범위 밖 번호는 과금 전에 400 `sentence_not_found`. 설명 상한(200개)에 닿았으면 저장하지 않고 보여만 주고(`saved: false`), 저장이 실패해도 이미 과금한 설명은 보여 준다. 동시에 두 번 탭하면 AI는 두 번 불릴 수 있지만 저장은 한 건이다(스토어의 "같은 키가 없을 때만 append").

**설명 낭독**: `script` → `speakQueue` 조각(ko → `ko-KR`, en → `en-US`, 300자 넘으면 `splitForTts`, 한국어는 `normalizeKoForTts`). 결과가 fetch 뒤에 오므로 **문장 탭 핸들러 안에서 동기로 `unlockSpeechPlayback()`**을 먼저 부른다(탭 밖 재생 잠금 — 운동·토익 응시 관용구).

### 12-4. 저장 모델 — `TalkSessionRecord` (컬렉션 `talkSessions`)

`lib/store.ts` 새 레코드 12항목 체크리스트를 전부 밟는다(선택 키 `?` 금지 — 전부 필수 nullable).

```ts
interface TalkTopic {
  kind: "preset" | "custom" | "vocab";
  key: string | null;            // 프리셋 키(그 밖 null)
  labelKo: string;               // 화면 라벨(프리셋 한국어·직접 입력 글자·단어장 이름)
  labelEn: string | null;        // 프리셋 영어 라벨
  vocabBookId: string | null;
  words: { en: string; ko: string | null }[];  // 단어장이면 실제로 넘긴 단어 스냅샷(최대 20), 아니면 []
}
interface TalkTurn { speaker: "teacher" | "child"; text: string; interrupted: boolean }
interface TalkExplanation {
  turnIndex: number; sentenceIndex: number;
  speaker: "teacher" | "child"; sentence: string;
  script: { lang: "ko" | "en"; text: string }[];
  betterEn: string | null;
  keyWords: { en: string; ko: string }[];
  model: string; createdAt: string;
}
interface TalkSessionRecord {
  id: string;
  titleKo: string;               // 기본 "{주제 라벨} 대화"
  topic: TalkTopic;
  turns: TalkTurn[];
  explanations: TalkExplanation[];
  startedAt: string; endedAt: string;
  durationSec: number;
  childTurnCount: number;        // 은우 턴 수(스트릭 §17-9, 저장 조건 ≥ 1)
  model: string; voice: string;
  createdAt: string;
  sortIndex: number | null;
}
```

- 저장 조건: `childTurnCount ≥ 1`(은우가 한마디도 안 했으면 400 — 화면은 저장을 부르지 않는다). 상한: 턴 200개, 턴 글자 1,000자, 설명 200개.
- 삭제는 `DestructiveOp`에 `deleteTalkSession`(Firestore 가드, 라우트 403 `prod_guard`). 설명 추가는 파일 `mutate`·Firestore `runTransaction` 안에서 "같은 키가 없을 때만 append".

구현이 정한 저장 규칙(`POST /api/english/talk`, 2026-09-26 — AI를 부르지 않아 키 검사가 없다):
- **상한을 넘으면 거부하지 않고 앞에서부터 잘라 저장한다**(`trimmed: true`) — 5분 대화 전체를 400으로 잃지 않게. 설명 키가 앞 턴부터라 앞쪽을 남기면 번호가 보존된다. zod는 넉넉한 방어선(2,000턴·20,000자)만 둔다.
- **멱등 — 저장 키가 문서 id다.** 요청의 `clientSessionId`(소문자 UUID, 대화 한 번에 화면이 하나 만든다)를 스토어가 대화 문서 id로, 그리고 주제 일러스트 문서 id로도 쓴다. 같은 키가 이미 있고 `startedAt`이 같으면 새로 만들지 않고 그 대화를 돌려준다(200, 같은 id — 응답 유실 뒤 다시 저장·화면 복귀 재시도·뒤로가기 정리가 겹쳐도 하나). 같은 키에 시작 시각이 다르면(충돌) 남의 문서를 덮지 않고 새 UUID로 만든다(새 오류 코드를 만들지 않는다). 파일 백엔드는 `mutate` 하나 안에서 찾고 만들고, Firestore는 `batch.create`(대화 + 그림)가 ALREADY_EXISTS면 배치 전체가 거부되므로 그때 읽어서 판정한다. 별도 필드 + 조회 방식은 Firestore 쿼리 트랜잭션·인덱스가 필요해 택하지 않았다.
- 주제 스냅샷: connect가 돌려준 값을 받되, 프리셋·직접 입력은 서버 해석 함수로 **다시 만든 값**을 저장하고(모르는 키면 400), 단어장은 모양·상한만 본다(그 사이 단어장이 바뀌어도 "실제로 넘긴 단어"가 기록이다).
- 시각은 시간대가 있는 ISO만 받고, `durationSec`은 서버가 두 시각에서 계산한다(0~3600초, 끝이 시작보다 앞이면 0). 모델·음성은 이름 형식만 본다. 은우 발화 수는 서버가 turns에서 다시 센다.
- 화면 이름(`titleKo`)은 60자까지(`POST /api/english/talk/[id]/rename`), 목록 순서는 범용 재배치 계약(`POST /api/english/talk/reorder`, `sortIndex`).

### 12-5. eval (`scripts/eval-english.ts` — 실호출 0회 + 게이트)

- **spec-sync**: `TALK_TEACHER_INSTRUCTIONS`·`TALK_LESSON_TOPIC`·`TALK_LESSON_WORDS`·`TALK_GREETING_INSTRUCTIONS`·`TALK_WRAPUP_INSTRUCTIONS`·`TALK_EXPLAIN_SYSTEM_PROMPT`·`TALK_EXPLAIN_USER_TEMPLATE`(block), `talk_sentence_explanation` JSON Schema 의미 동치.
  구현(2026-09-26): 자유대화 원문 11개(위 7개 + §12-6의 4개)는 전부 **`block-exact`** 모드로 대조한다 — `scripts/spec-sync.ts`에 더한 모드로, 호출 B용 조립 규칙(3줄·40자 이상 블록 떼어 내기)을 끄고 **블록 하나와 정확히** 일치해야 통과한다. 기존 `block` 모드로는 교사 지시문 상수에 수업 블록 원문을 통째로 이어 붙여도 통과했다(QA 실측). eval이 "이어 붙인 상수는 `block`에서 통과, `block-exact`에서 거부"를 직접 확인한다. 영어 `SPEC_SYNC_TARGETS`는 이로써 22개다.
  **이 절(§12)의 숫자 문장 일부는 eval이 스펙 문장 그대로 찾는다**(`runTalkSpecChecks` — 호출 옵션 문장, §12-1 표의 기본값·`max_output_tokens`·속도·턴 감지·소음 억제, 저장 상한, zod 폭 7개, §12-6의 카드 폭·5초·12초·도움 요청 연속 2번·30장·6장·`tool_choice`·기본 문구·호출 결과 글·장면 앞머리·지시문 이음, 프리셋 장면 표의 키·장면·순서). 상수를 바꾸면 스펙 문장과 함께 바꿔야 하고, 문서만 고칠 때도 이 문장들의 모양을 바꾸면 `eval:english`가 깨진다.
- **오프라인**: 지시문 조립(프리셋 → 라벨, 직접 입력 정리 — 줄바꿈·따옴표·30자, 단어장 20개 상한·뜻 없는 단어), 세션 설정 값(모델·음성 env 빈 값 폴백, 속도 두 값), 리듀서(합성 이벤트 — 은우 전사가 선생님 응답보다 늦게 와도 은우 줄이 위, 중복 이벤트 멱등, cancelled → interrupted, 빈 전사 empty, 실패 failed, `app_` 항목 제외, 모르는 이벤트 무시), `toTalkTurns`·`childTurnCount`, 문장 나누기 결정성(숫자 속 마침표), 호출 I zod 반례(ko 조각 속 영어 글자, en 조각 속 한글, 선생님 문장의 betterEn, 문장에 없는 keyWords, en 조각 0개), 설명 낭독 대본(ko-KR/en-US 매핑·300자 분할).
- **실호출 프로브**(오케스트레이터가 동의 후 별도로): 호출 I 1회(선생님 문장·아이 문장 각 1). 관문 R 실연결은 eval 밖 — 실기기·동의 후.
  구현: 게이트 `EVAL_TALK=1`이 호출 I를 **2회**(지어낸 대화의 선생님 문장 1 · 은우 문장 1) 부르고 출력과 화자별 기대(선생님 문장 betterEn null, keyWords ⊂ 문장, en 조각 ≥ 1)를 찍는다. §5의 다섯째 배타 게이트이고 `EVAL_OFFLINE_ONLY=1`에서는 도달하지 않는다.
- **수치(2026-09-26 기준)**: 오프라인 505항목(자유대화 이전 176 + 자유대화 329). 자유대화 329 = spec-sync 11 + 스펙 대조 43 · 카드 62(이어 말하기 판정 포함) · 도움 47 · 호출 I 44 · 지시문 29 · 리듀서 28 · 세션 설정 24 · 문장 12 · 저장 본문 12 · 장면 8 · 스트릭 6 · 낭독 3. 합성 서버 이벤트와 앱이 보내는 이벤트는 SDK GA 타입(`RealtimeServerEvent`·`ConversationItemCreateEvent`·`ResponseCreateEvent`)으로 만들어 이름·필드를 틀리면 tsc가 막는다. 픽스처 대화는 전부 지어낸 영어·한국어다.
- **eval 밖에 남은 것**: `TALK_FALLBACK_HINTS`의 한국어 뜻 4개(스펙이 뜻 글자를 정하지 않아 한글 포함·라틴 금지만 본다). 화면 흐름(WebRTC 배선·저장 멱등·뒤로가기·작은 폰)은 오프라인 eval이 아니라 개발 빌드 전용 가짜 전송 e2e로 본다(SPEC §21-6). "도움 카드가 **떠 있는 상태에서** 선생님이 다시 말하면 접힌다"는 처음엔 은우 발화로 이미 접힌 뒤 재개하는 열뿐이라 잠기지 않았는데(QA 변이가 통과), 2026-09-26 선행 조건(재개 직전 카드가 떠 있음)을 함께 단언하는 열 4개로 잠갔다 — 카드 표시 중 재개, 12초 요청 뒤 재개(새 차례로 셈), 기본 문구 표시 중 재개, 요청 응답이 도구를 먼저 부르고 말하는 순서.


### 12-6. 화면 카드 — 말문 막힘 도움 · 그림 카드 · 주제 일러스트 (2026-09-26 추가)

사용자 요청: "은우가 말문이 막히면 화면에 표현이나 단어를 표시해서 자연스러운 발화를 유도하자. 대화하는 동안 관련 내용을 설명하는 그림이나 사진, 문서 등을 화면에 띄우자." 사용자 확정: **그림 카드(이모지) + 주제 일러스트 1장**, 도움 카드는 **5초 조용하면 자동 + 🙋 버튼**.

**원리.** 선생님(Realtime 모델)이 **도구 호출**(function calling)로 화면 카드를 보낸다 — 카드는 조용하다(말로 "카드를 보여 줄게"라고 하지 않는다). 앱은 카드를 그리기만 하고 **소리를 내지 않는다**: 대화 중에는 마이크가 계속 열려 있어, 앱이 따로 소리를 내면 모델이 그 소리를 은우 발화로 들을 수 있다(카드의 🔊 없음).

**지시문 덧붙임 (원문 그대로 — `TALK_CARDS_INSTRUCTIONS`).** 세션 지시문 = `TALK_TEACHER_INSTRUCTIONS`(`{lesson}` 치환) + `"\n\n"` + 이 블록.

```
# Screen cards
The child also sees a screen during the call. You can put helpful cards on it with your tools. Cards are silent: keep talking as usual, and never say that you are showing a card.
- Speak your whole turn first, including your question, and call your tools only after you have finished speaking. Never talk about thinking or preparing, and never say things like "let me think".
- Every time you ask the child a question, also call show_hints with 2 or 3 short answers the child could say (2 to 6 easy words each, like "I like apples." or "It is red.") and up to 3 key words with an emoji and the Korean meaning. The app shows them only if the child gets stuck.
- When you talk about a new thing, animal, food, color, or action, call show_picture with one to three emoji that show it, the English word, and its easy Korean meaning.
- If a message says that a picture is on the child's screen, you may ask one easy question about it, like "What do you see in the picture?"
```

**도구 정의 (세션 설정 `tools`, `tool_choice: "auto"` — 의미 동치로 spec-sync):**

```json
[
  {
    "type": "function",
    "name": "show_hints",
    "description": "Silently prepare answer help for the question you just asked. The app shows it on the child's screen only if the child gets stuck.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "answers": {
          "type": "array",
          "description": "2 or 3 short English answers the child could say (2 to 6 easy words each).",
          "items": { "type": "string" }
        },
        "words": {
          "type": "array",
          "description": "Up to 3 key words for the answers.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "emoji": { "type": "string" },
              "en": { "type": "string" },
              "ko": { "type": "string" }
            },
            "required": ["emoji", "en", "ko"]
          }
        }
      },
      "required": ["answers", "words"]
    }
  },
  {
    "type": "function",
    "name": "show_picture",
    "description": "Silently show a picture card on the child's screen for a thing, animal, food, color, or action you are talking about.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "emoji": { "type": "string", "description": "One to three emoji that show the word." },
        "en": { "type": "string", "description": "The English word or short phrase." },
        "ko": { "type": "string", "description": "Its easy Korean meaning." }
      },
      "required": ["emoji", "en", "ko"]
    }
  }
]
```

**도구 호출 처리(앱, 클라이언트).**
- 응답의 `function_call` 항목(`response.output_item.done` 또는 `response.done`의 output)에서 `name`·`call_id`·`arguments`를 꺼내 **순수 함수 `parseTalkToolCall(name, argumentsJson)`**(`lib/talk-cards.ts`)로 검사한다. 모델 출력이라 믿지 않는다 — `answers` 1~3개(각 60자 이하·라틴 포함·한글 금지), `words` 0~3개(`emoji` 1~16자 비어 있지 않음, `en` 라틴 30자 이하, `ko` 한글 20자 이하), `show_picture`도 같은 폭. **잘못된 항목만 버리고**, 남는 게 없으면 null(무시). 모르는 도구 이름도 무시.
  - 구현이 정한 세부(`lib/talk-cards.ts`): 같은 호출이 `response.output_item.done`과 `response.done`에 다 나오므로 **`call_id`로 한 번만** 처리한다. `show_hints`는 검사를 통과한 답이 **하나도 없으면 null**이다(단어만 남아도 버린다 — 답 예시가 도움 카드의 본체다. 화면은 기본 문구를 보인다). 개수가 넘치면 앞에서부터 자르고, 같은 영어(대소문자·공백 무시)는 처음 것 하나만 둔다. 값의 줄바꿈·제어문자는 공백으로 바꾸고 앞뒤를 다듬는다(이모지 결합 ZWJ·이체 선택자는 건드리지 않는다). 글자 수는 코드 포인트로 센다(가족 이모지는 5, 키캡은 3).
  - **이모지 칸 규칙**(2026-09-26 확정 — 위 문장의 "비어 있지 않음"을 이 규칙으로 좁힌다): 1~16자에 더해 **그림 문자가 하나는 있어야** 한다. 그림 문자는 이모지(`\p{Extended_Pictographic}`)·국기(`\p{Regional_Indicator}`)·키캡(U+20E3), 그리고 **도형·기호 블록**(Geometric Shapes U+25A0–25FF·Misc Symbols U+2600–26FF·Dingbats U+2700–27BF·Misc Symbols and Arrows U+2B00–2BFF·Geometric Shapes Extended U+1F780–1F7FF — 단 그 블록 안의 글자·숫자 `\p{L}`·`\p{N}`, 예: ❶~➓는 제외)이다. **라틴(반각·전각)·한글은 한 글자도 안 된다** — 모델이 `:dog:`·`dog`·`개` 같은 글자를 넣으면 그림 자리에 글자가 뜨기 때문이다(`▲A`·`●빨강`처럼 그림 옆에 글자가 붙어도 버린다). **Ⓐ·①·㉠ 같은 글자형 기호는 그림이 아니다** — 도형·기호 블록 밖의 기호(`\p{So}`)는 열지 않는다. 도형·기호 블록은 "색깔과 모양" 주제에서 모델이 ▲ ● ■ ◆ 같은 텍스트 기호를 주면 카드가 조용히 사라지던 것을 막으려고 넣었다. 판정은 `lib/talk-cards.ts` 한 곳(`containsPictograph` + 라틴·한글 금지)이고 `show_picture`·`show_hints`의 `words`·저장 요청 카드(`sanitizeTalkCards`)가 모두 같은 판정을 지난다 — 단어장·일본어 이모지 검사(`\p{Extended_Pictographic}`만)보다 도형·기호 블록만큼 넓다. 카드의 `en`도 한글을 금지한다(위 문장의 "라틴 30자"를 좁힌 것). `ko`에 라틴을 허용한 것은 카드가 소리를 내지 않기 때문이다.
- 호출마다 `conversation.item.create {type: "function_call_output", call_id, output: "{\"shown\":true}"}`를 보낸다(id 접두사 `app_`). **검사에 떨어져 버린 호출에도 같은 값을 보낸다** — `shown:false`를 받으면 모델이 같은 도구를 되풀이해, 도구만 부르는 응답과 `response.create`가 반복될 수 있다(카드는 조용하므로 대화에는 차이가 없다). 호출 결과는 응답이 진행 중일 때 끼우지 않고 그 응답의 `response.done`에서 한꺼번에 넣는다(`app_out_<n>`).
- 도구를 부르고 정상 완료(`completed`)한 응답에서 **선생님이 말한 글자에 질문이 없으면**(`?`·`？` 없음 — 오디오가 없던 응답, 즉 도구만 부르고 끝난 응답 포함) `response.create`를 보내 선생님이 이어 말하게 한다. 질문이 있었으면 보내지 않는다(은우 차례를 빼앗지 않는다). 마무리 중에는 도구 호출을 무시한다(표시·호출 결과·이어 말하기 모두 없음). (2026-09-26 정정 — 전에는 "오디오가 없었으면"이었다. 실연결에서 선생님이 "Nice, that's a lovely choice. Let me think of a small next question for you."처럼 한두 마디 하다 도구를 부르고 응답을 끝냈는데, 오디오가 있어 이어 말하기가 막혀 은우가 질문을 못 듣고 기다렸다. 지시문 첫 항목 "말을 다 한 뒤에 도구"가 첫째 겹, 이 판정이 둘째 겹이다.)
  - 말한 글자는 그 응답 `response.done`의 `output` 가운데 assistant 메시지 항목의 `content[].transcript`(오디오 전사 — 글자 모드면 `text`)를 이은 것이다. 거기에 전사가 없으면 스크립트 리듀서(§12-2)가 `response.output_audio_transcript.*`로 모은 그 항목의 선생님 줄로 대신 보고, 그래도 모르면 **보내지 않는다**(질문했을지 모른다 — 은우 차례를 빼앗지 않는다). 판정은 `lib/talk-cards.ts`의 `summarizeTalkResponseDone`(`shouldContinue`)·`stepTalkContinue` 한 곳이다.
  - 상한(`lib/talk-cards.ts` `TALK_CONTINUE_CHAIN_MAX`): 이어 말하기는 **연속 2회**까지다 — 넘으면 더 보내지 않고 도움 카드·12초 도움 요청 경로에 맡긴다(매 응답이 대화 전체를 다시 입력으로 과금한다). 셈은 **은우 발화(`input_audio_buffer.speech_started`)에서만** 0으로 돌아간다 — 소리 있는 응답으로는 되돌리지 않는다(말만 하고 질문 없이 도구로 끝나는 응답이 이어 말하기를 끝없이 부르지 않게).
- **응답이 진행 중일 때는 `response.create`를 보내지 않는다**(구현 — SDK 주석 "한 번에 한 응답만 대화에 쓸 수 있다"). 컨트롤러가 `response.created` → 진행 중, `response.done` → 끝으로 따라가고, 우리가 보낸 `response.create`에 5초 안에 `response.created`가 안 오면 거부된 것으로 보고 풀어 준다. 진행 중에 생긴 도움 요청(12초·🙋)은 **보류**했다가 그 응답이 **오디오 없이** 끝나면 보내고, 오디오가 있었으면(선생님이 방금 새 차례를 말했다) 버리며, 은우가 말을 시작해도 버린다. 마무리 안내도 진행 중 응답을 기다린다 — 선생님이 말하는 중이면 최대 8초(`TALK_WRAPUP_WAIT_MS`) 기다리고, 그 뒤에도 응답이 진행 중이면 `response.cancel`로 끊은 다음 tick에 보낸다(24초가 지나도 끝나지 않으면 안내 없이 끝낸다). 안내를 보낸 뒤에는 그 응답의 소리가 멈추면(`response_id` 일치) 또는 오디오 없이 끝나면, 늦어도 25초(`TALK_WRAPUP_END_MS`) 안에 끝낸다. 일러스트 안내(`TALK_SCENE_NOTE`)도 진행 중이면 `response.done`까지 미룬다.
- 리듀서(§12-2)는 `function_call` 항목·`app_` 항목을 줄로 만들지 않는다(스크립트에 안 보인다).

**말문 막힘 도움 (순수 상태 기계 `lib/talk-hints.ts` — 시계는 인자로 받는다).**
- 최신 `show_hints`를 "지금 질문의 도움"으로 둔다. 선생님이 다시 말하기 시작하면(`output_audio_buffer.started`) 도움 카드를 접고 이전 도움을 버린다.
- 선생님 소리가 멈춘 뒤(`output_audio_buffer.stopped`) **5초** 동안 은우 발화(`input_audio_buffer.speech_started`)가 없으면 도움 카드를 **살짝 띄운다**("이렇게 말해 볼까요?" — 답 예시 큰 글씨 + 단어 이모지·영어·뜻). 은우가 말을 시작하면 접는다.
- 받은 도움이 없으면 기본 문구(`TALK_FALLBACK_HINTS` — `Yes!`·`No.`·`I don't know.`·`Can you say it again?`, 각 한국어 뜻)를 보인다.
- **12초** 동안 계속 조용하면 앱이 선생님에게 도움을 한 번 청한다: 숨은 system 메시지 `TALK_NUDGE_NOTE` + `response.create`. **선생님 차례 하나에 한 번만.** semantic VAD는 아이가 아무 말도 안 하면 차례를 넘기지 않아 선생님이 끝없이 기다리기 때문이다.
- 은우가 말하기 전까지 도움 요청(12초 자동·🙋 합산)은 **연속 2번**까지다(`TALK_HINT_NUDGE_STREAK_MAX`, 2026-09-26 확정). 은우가 말을 시작하면(`input_audio_buffer.speech_started`) 다시 0부터 센다. 상한에 닿으면 도움 카드는 그대로 띄우되(5초·🙋) 요청은 보내지 않는다 — 은우가 계속 조용할 때 선생님 차례마다 요청이 되풀이되며 매번 대화 전체를 다시 입력으로 과금하지 않게.
- **🙋 도와줘요** 버튼: 누르면 도움 카드를 바로 띄우고, 선생님이 말하는 중이 아니며 이 차례에 아직 청하지 않았고 연속 상한 아래면 같은 도움 요청을 바로 보낸다.
- 5·12초는 개발 전용 시간 배율의 적용을 받는다(e2e).

구현이 정한 동작(2026-09-26 — 스펙 문장이 말하지 않은 자리, QA가 독립 참조 모델과 대조해 스펙 의도에 맞다고 본 결정):
- **선생님이 말하는 중에 🙋를 누르면** 카드는 바로 띄우고, 요청은 **그 선생님 소리가 멈춘 뒤** 보낸다(보류). 새 차례가 먼저 시작되면 보류를 버린다 — 같은 차례 안에서만 유효하다.
- **선생님이 아직 한 번도 말하지 않았으면**(연결 중, 첫 인사 전) 🙋는 **카드만** 띄운다 — 청할 질문이 없고, 인사 응답과 요청이 부딪치지 않게.
- **은우가 말을 멈추면**(`input_audio_buffer.speech_stopped` → `child_speech_stopped`) 조용함 시계를 **다시 시작한다** — "음…" 하고 말하다 막힌 경우에도 5초 뒤 카드가 뜨고 12초 뒤 요청이 나간다(스펙 문장은 선생님 소리가 멈춘 때만 센다).
- `output_audio_buffer.cleared`(은우가 끼어들어 선생님 소리가 끊김)도 "멈춤"으로 옮긴다. 시작 없이 온 멈춤이나 `stopped` 뒤의 `cleared`처럼 **겹친 멈춤**은 도는 조용함 시계를 되감지 않고 멈춘 횟수도 늘리지 않는다.
- "이전 도움"은 **선생님 소리가 마지막으로 멈춘 것보다 먼저 받은 도움**이다(받을 때의 멈춘 횟수 `epoch`와 비교) — 선생님이 도구만 먼저 부르고(오디오 없는 응답) 이어서 질문을 말하는 순서에서도 그 질문의 도움이 재개 순간에 버려지지 않는다.
- "선생님 차례 하나에 한 번"의 차례는 `output_audio_buffer.started`마다 새로 센다. 그래서 도움 요청 응답(선생님의 예시 답) 뒤에도 12초 조용하면 한 번 더 청할 수 있다(선생님이 끝없이 기다리지 않게라는 목적에 맞춘 것). 되풀이는 위의 **연속 2번** 상한이 끊는다 — 차례마다 새로 세는 "차례 하나에 한 번"과 달리 이 수는 선생님 차례로는 되돌아가지 않고 은우 발화로만 0이 된다. 상한에 닿은 차례는 "청한 차례"로 치지 않아서, 그 차례 안에서 은우가 "음…" 하고 말하다 멈추면 12초 뒤 다시 청할 수 있다. 🙋가 선생님 말하는 중에 눌려 보류된 요청도 소리가 멈출 때 상한을 다시 본다. 상한에 이미 닿았으면 선생님 말하는 중의 🙋는 보류를 만들지 않는다(카드만 띄운다).
- 5분 마무리가 시작되면(`wrapup_started`) 카드도 요청도 없다 — 작별 인사 뒤에 선생님을 다시 부르지 않는다.
- 상태 기계 이벤트는 `teacher_audio_started`·`teacher_audio_stopped`·`child_speech_started`·`child_speech_stopped`·`hints_received`·`help_tapped`·`wrapup_started`·`tick`(250ms) 여덟 가지이고, 서버 이벤트 옮기기는 `talkHintEventFromServer` 한 곳이다. `shouldNudge`는 **그 전이에서만** 참이라 화면은 전이 직후 요청을 한 번 보낸다.

`TALK_NUDGE_NOTE` (원문 그대로):

```
The child seems stuck and has been quiet. Help gently now: say one very short model answer to your last question and invite the child to say it with you. Use one or two short sentences.
```

**그림 카드.** `show_picture`가 오면 화면 위쪽에 큰 카드(이모지 + 영어 + 뜻)로 띄우고, 지난 카드는 작은 칩으로 최근 6장까지 남긴다. 단어장 모드에서는 카드의 `en`이 오늘의 단어와 같으면(대소문자 무시, 끝의 s 허용) **"오늘의 단어" 목록**(접이식 패널 — 단어·뜻, 연습하면 ✓)에 표시한다. 대화 기록에는 보인 카드를 최대 30장 남긴다(대화 보기 "오늘 본 그림 카드").
✓ 매칭(`matchTalkWord`)은 스펙("끝의 s 허용")보다 조금 넓다 — `es`(box ↔ boxes)와 `y ↔ ies`(berry ↔ berries)도 같은 단어로 보고, 앞 관사(a/an/the)와 앞뒤 문장부호를 무시한다. 맞으면 목록에 적힌 `en` 그대로 ✓를 단다. do/dog·hotdog/dog·dogss/dog는 거부한다(eval). 오판정의 대가는 ✓ 표시 하나뿐이라 넓게 잡았다 — 짧은 낱말에서 거짓 양성이 날 수 있다(카드 `his` → 목록 `hi`, `news` → `new`, QA 관찰). 도움 카드가 뜨면 "오늘의 단어" 목록을 자동으로 접는다(작은 폰에서 스크립트·끝내기를 밀어내지 않게 — 다시 펼치는 것은 사용자).

**주제 일러스트 1장.**
- 대화를 시작할 때 연결과 **병렬로** `POST /api/english/talk/scene {topic}`을 부른다(연결을 기다리게 하지 않는다). 구현은 **마이크를 얻은 뒤에** 연결과 함께 보낸다 — 마이크 거부·대화 전 끝내기에는 생성 요청이 나가지 않는다(QA가 "마이크를 기다리기 전에 요청이 상류에 닿는다"를 잡아 옮겼다). 대화가 그림보다 먼저 끝나면 요청을 끊고(라우트가 `req.signal`을 상류로 넘긴다 — 서버 쪽 상한 55초와 함께) 그림 없이 저장한다. 서버는 주제를 연결과 같은 함수로 해석해 장면 문장 `sceneEn`을 만들고, 아래 프롬프트로 사진 생성 관문을 부른다 → `{dataUrl, sceneEn}`.
  - 프리셋은 장면 문장을 `lib/talk-topics.ts`에 함께 둔다(아래 표). 직접 입력은 `a cheerful scene about: {주제}`, 단어장은 `a cheerful scene with: {앞 4개 단어를 ", "로}`.
  - 관문: 토익 관문 P(`lib/toeic-image.ts`)의 모델·크기 제한 규약을 공용 코어로 옮겨 함께 쓴다(토익 동작 불변 — `eval:toeic` 통과). 대화용 설정은 모델 `OPENAI_IMAGE_MODEL`(빈 값이면 `gpt-image-2`), **품질 low**(빠르게), 1024×1024, JPEG 압축 60, 900,000자 초과 시 압축 40으로 1회 재생성. 키가 없으면 501, 실패하면 500 — **대화는 그림 없이 그대로 간다**.
  - 구현: 공용 코어는 `lib/image-gen.ts`(`generateJpegImage` — 모델 env·키 규약·JPEG data URL·다음 압축으로 1회 재생성·`too_large`·실패는 결과 값·재시도 1회 독립 클라이언트, 과목을 모른다), 대화 설정은 `lib/talk-image.ts`(`generateTalkSceneImage`, 로그 태그 `talk_scene`, 품질은 env를 보지 않는 low 고정 — 토익 품질 env와 섞이지 않게). 토익은 `lib/toeic-image.ts`가 같은 코어에 자기 설정(medium·1536×1024·70→50·접미사·태그 `toeic_scene`)만 넘긴다 — QA가 HEAD 원본과 같은 스텁에서 요청·결과가 같음을 확인했다. 장면 라우트 응답은 `{dataUrl, sceneEn, note, model}`이다 — `note`는 서버가 조립한 `TALK_SCENE_NOTE` 치환 결과라 화면이 프롬프트 원문·치환 규칙을 따로 갖지 않는다. 장면 라우트는 아무것도 저장하지 않는다.
- 그림이 도착하면(대화 중이고 마무리 전이면) 화면 위 그림 칸에 띄우고, 숨은 system 메시지 `TALK_SCENE_NOTE`(`{scene}` = `sceneEn`)를 넣는다 — `response.create`는 보내지 않는다(선생님이 다음 차례에 자연스럽게 쓴다).
  구현: "대화 중"에는 연결 중도 든다(도착 전엔 "그림을 그리는 중…" 자리 표시). **마무리 중에 도착한 그림은 띄우지도 알리지도 않고 저장 본문에만 싣는다**(스냅숏 `scene.shown: false`) — 마무리가 시작될 때 아직 그리는 중이면 자리 표시도 거둔다. 이미 끝났으면 결과를 버린다. 안내는 응답이 진행 중이면 `response.done`까지 미룬다(`app_scene`). 실패면 칸을 숨긴다.
- 저장: 대화 저장 요청에 `scene: {dataUrl, sceneEn} | null`을 함께 보내면 서버가 새 컬렉션 `talkImages`(한 장 = 문서 하나)에 넣고 대화 기록에 `sceneImageId`·`sceneEn`을 단다. 대화를 지우면 그림도 지운다(연쇄). 대화 보기에서 그림을 보인다(`GET /api/english/talk/images/[id]`, PIN 게이트 안, `cache-control: private`). 저장하지 않는 대화(은우 발화 0)의 그림은 서버에 남지 않는다.
  구현: 저장 라우트는 그림의 data URL 모양(JPEG base64만)과 크기(≤ 900,000자)를 검사해 **떨어지면 그림만 빼고** 대화는 저장한다(`sceneSaved: false` — 대화가 우선). `sceneEn`은 클라이언트 값을 쓰지 않고 저장된 주제 스냅샷에서 `buildTalkSceneEn(topic)`으로 다시 만들고, 그림 `model`은 저장 시점의 사진 모델이다. 그림 문서 id는 대화 id(= 저장 키, §12-4)와 같다. 이미지 GET은 id 모양(`[A-Za-z0-9_-]{1,64}`)을 먼저 봐 `x.png` 같은 요청은 스토어를 읽지 않고 404이며, 응답은 `image/jpeg` 바이트에 `cache-control: private, max-age=31536000, immutable`이다. 카드 목록도 서버가 `sanitizeTalkCards`로 다시 검사한다(같은 영어 1장, 보인 순서대로 30장).

`TALK_SCENE_NOTE` (원문 그대로):

```
A picture is now on the child's screen. It shows: {scene}
When it fits the talk, you may ask the child one easy question about the picture.
```

`TALK_SCENE_IMAGE_PROMPT` (원문 그대로 — 사진 생성 프롬프트):

```
A bright, friendly children's picture-book illustration of {scene}. Simple shapes, cheerful colors, and a cute, gentle style for a 7-year-old. No text, no letters, no logos.
```

프리셋 장면 문장(`sceneEn`, `lib/talk-topics.ts`):

| 키 | 장면 |
|---|---|
| animals | a sunny farm with a dog, a cat, a cow, and a duck |
| food | a picnic blanket with apples, bananas, sandwiches, and juice |
| family | a happy family of four eating dinner together at home |
| school | a bright classroom with desks, books, crayons, and a smiling teacher |
| play | a playroom with blocks, a ball, a teddy bear, and a toy car |
| weather | a park with a rainbow, a few clouds, trees, and puddles |
| colors | red, blue, yellow, and green balloons and blocks |
| myday | a cozy morning with a bed, an alarm clock, and breakfast on the table |
| dinosaurs | friendly cartoon dinosaurs in a green jungle with a volcano far away |
| birthday | a birthday party with a cake, candles, balloons, and presents |

**저장 모델 추가**(§12-4에 더한다 — 12항목 체크리스트): `TalkSessionRecord`에 `cards: {emoji, en, ko}[]`(최대 30)·`sceneImageId: string | null`·`sceneEn: string | null`. 새 컬렉션 `talkImages` — `{id, dataUrl, sceneEn, model, createdAt}`(대화 저장 때 함께 생성, 대화 삭제 때 연쇄 삭제, prod-guard는 `deleteTalkSession` 하나로).

**eval 추가**(§12-5에 더한다): spec-sync `TALK_CARDS_INSTRUCTIONS`·`TALK_NUDGE_NOTE`·`TALK_SCENE_NOTE`·`TALK_SCENE_IMAGE_PROMPT`(block), 도구 정의 의미 동치, 세션 설정에 도구·`tool_choice`·지시문 덧붙임, 프리셋 장면 10개, `parseTalkToolCall` 반례(한글 섞인 answers·빈 이모지·너무 긴 값은 그 항목만 버림, 모르는 도구 null), 도움 상태 기계(5초 표시·말 시작 접힘·선생님 재개 시 버림·12초 한 번만 요청·🙋 즉시·도움 없음 → 기본 문구·은우 발화 전 연속 2번 상한과 은우 발화 뒤 초기화), 단어장 ✓ 매칭(복수 s).

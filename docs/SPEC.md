# 개발 명세 — 은우 북카드 (영어책 학습 카드 생성 웹앱)

> 이 문서가 앱 전체의 개발 명세다. AI 호출의 상세 구현 원본은 `docs/harness/english.md`(AI 하네스 명세).
> 명세에 없는 결정은 "가족용 소규모 앱, 단순함 우선" 원칙으로 판단하고, 판단 내용을 README에 남긴다.

## 0. 제품 한 줄 요약

초등학생 아이가 읽을 영어책의 표지 사진을 올리거나 제목을 입력하면, 그 책에 맞는 학습 카드(필수 단어장 + 한/영 대화 질문 + 읽기 전/중/후 활동)를 생성하고, 만든 카드를 '서재'에 쌓아 아이의 읽기 이력을 관리하는 가족용 웹앱.

## 1. 배경과 절대 원칙

- 사용자: 엄빠(관리자)와 초등학생 아이 '은우'. UI 언어는 한국어.
- **본문 취급 원칙 (최우선):**
  - **본문 이미지는 요약 생성의 근거로만 쓰고, 원문을 그대로 옮겨 적지 않는다.** 부모가 손에 든 책을 찍어 올리는 것은 허용하되, 카드에 남는 것은 우리말 요약·질문뿐이다.
    - 이 규칙을 남기는 이유는 저작권이 아니라 **제품 품질**이다 — 부모가 원하는 건 아이를 이끌 한국어 맥락이지 영어 원문이 아니다. 원문은 이미 책으로 손에 들고 있다. 카드에 영어 본문을 그대로 박으면 카드만 두꺼워지고 실사용 가치가 없다.
    - 예외: 제목·챕터 제목·등장인물 이름은 구조 정보이므로 그대로 써도 된다.
  - **업로드된 원본 사진은 저장하지 않는다.** 판독·요약 후 버린다 (개인정보 최소화이자 비용·구조 문제 — 30장×200KB면 권당 6MB, Firestore 문서 상한 1MB. 요약 텍스트만 남기면 권당 수 KB다).
  - 학습 카드는 메타데이터(제목, 저자, AR/Lexile 지수, 단어 수, 주제, 공개된 소개글), 뒤표지·책날개 소개글, 본문/목차 사진의 우리말 요약을 근거로 **새로 창작한다.**
  - AI 생성 프롬프트에 "영어 원문을 그대로 옮겨 적지 말 것"·"받은 근거를 넘어서는 내용을 지어내지 말 것" 가드레일을 반드시 포함한다. zod에서도 영어 원문 전사를 실제로 거부한다(연속 영어 8단어).
  - 외부 사이트의 본문·데이터 스크래핑 코드를 작성하지 않는다 (AR BookFinder 등 크롤링 금지 — 스티커 판독과 수동 입력으로 해결).
- 가족용 개인 도구다. 로그인 없음(비공개 URL 운영). 과설계 금지.

## 2. 기술 스택 (확정)

- Next.js (App Router, TypeScript), 모바일 우선 반응형 — 엄빠가 폰으로 표지를 찍어 올리는 것이 기본 시나리오
- 스타일: Tailwind CSS (참고 디자인 재현이 더 쉬우면 CSS Modules 병용 가능)
- AI: OpenAI API — 표지 판독(vision)과 카드 생성 모두. Responses API(현행 표준) 사용, 출력은 Structured Outputs(json_schema, strict: true)로 강제. 모델 ID는 하드코딩하지 말고 env `OPENAI_MODEL`로 받되, 기본값은 OpenAI 공식 문서에서 확인한 비전(이미지 입력)과 Structured Outputs를 모두 지원하는 최신 모델로 설정
- 책 식별: Google Books API(기본) + Open Library API(폴백)
- DB: Firestore (Native mode)
- 배포: GCP Cloud Run (region: asia-northeast3 서울). 소스 배포(`gcloud run deploy --source .`) 기준으로 README 작성
- 비밀값: Cloud Run 환경변수 또는 Secret Manager. API 키를 클라이언트 번들에 절대 노출하지 않는다. 모든 외부 API 호출은 서버(route handler)에서만. `.env.example` 제공, 실제 키 커밋 금지

## 3. 핵심 플로우

```
[입력] 표지 사진 1~3장 (표지 / 정보 스티커 / 뒤표지)  또는  제목(+저자) 텍스트
   ↓
(1) 판독 — OpenAI vision (호출 A)
    사진에서 추출: 제목, 저자, 시리즈, AR 지수, Lexile, 단어 수,
    AR 퀴즈번호, 픽션/논픽션 (한국 원서몰 스티커에 이 정보가 인쇄되어 있음)
    + 뒤표지·책날개 소개글(blurbText) — 출판사가 쓴 실제 줄거리라 카드 품질에 직결
   ↓
(2) 식별 — Google Books API (제목+저자 검색)
    확보: ISBN, 소개글(description), 카테고리, 썸네일 URL
    실패 시 Open Library 폴백, 둘 다 실패 시 판독값만으로 진행
   ↓
(2′) [선택] 본문·목차 촬영 — OpenAI vision (호출 A′)
    본문 사진 N장(그림책 펼침면 12~16장) 또는 목차 사진 1~2장 → 장면별 우리말 요약
    사진 6장씩 배치로 나눠 병렬 호출. 사진은 저장하지 않고 요약만 남긴다
    건너뛰면 (3)이 메타데이터·소개글만으로 진행한다 — 이 단계는 카드 생성의 전제가 아니다
   ↓
(3) 생성 — OpenAI API (호출 B)
    §6 스키마의 학습 카드 JSON 생성 (§7 프롬프트 명세)
    근거: 메타데이터 + 공개 소개글 + blurbText + 장면 요약
   ↓
(4) 렌더링·저장 — 카드 화면 표시, Firestore 저장, 인쇄 지원
```

- 진행 UI: "표지 읽는 중 → 책 확인 중 → (본문 읽는 중) → 카드 만드는 중" 상태 표시
- 근거가 두꺼울수록 줄거리를 길게 쓴다(3~4 → 8~10문장). 근거가 얇은데 늘리면 환각이 늘어나므로 근거의 **양**(장면 수)에서 구간을 계산해 조건부로만 늘린다 (docs/harness/english.md §3-2)
- 제목만 입력한 경우: (1) 생략, (2)부터 시작. AR/Lexile을 얻지 못하면 소개글·대상 연령으로 레벨을 추정하고 카드에 "레벨 추정" 배지를 표시한다

## 4. 화면 명세 (3페이지)

### 4-1. 홈 `/`

- 큰 버튼 2개: "표지 사진으로 만들기"(`<input type="file" accept="image/*" capture="environment" multiple>` **최대 3장 — 표지 / 정보 스티커 / 뒤표지**), "책 이름으로 만들기"(제목 필수, 저자 선택)
  - 상한이 3장인 이유: 뒤표지 소개글(blurbText)이 줄거리의 실질 근거인데, 2장이면 사용자가 정보 스티커를 포기해야만 뒤표지를 찍을 수 있다. 세 면은 서로 대체 불가한 정보를 담는다
  - 무엇을 찍어야 하는지 UI에 안내한다. 3장을 다 찍을 필요는 없다 — 있는 것만 찍어도 된다
- 최근 만든 카드 3개 미리보기 (표지 썸네일 + 제목 + AR 칩)

### 4-2. 카드 `/card/[id]`

§8 디자인 그대로. 구성 순서:

1. 북헤더: 이모지 커버, 제목, 저자·시리즈, 메타 칩(AR / Lexile / 단어 수 / 픽션·논픽션)
2. 이 책은? (2문장 소개 + 레벨 설명 1문장)
3. 줄거리 미리보기 (storyOutlineKo 3~10문장, 결말 미공개 — 논픽션은 "내용 미리보기" 제목. 근거 배지는 storySource로 판정: 예상 / 소개글 기반 / 목차 기반 / 본문 확인. 필드가 없는 기존 카드는 섹션 생략)
4. [sceneDigest가 있을 때만] 장면별 메모 — 라벨(예 "1~2쪽" / "3장: Pooh와 꿀단지") + 우리말 요약 + 그 자리에서 던질 질문(askKo). `confidence: "low"`는 재촬영 안내, `gapBefore: true`는 "사진이 빠졌을 수 있어요" 표시
   - **기본 접힘(`<details>`), 인쇄에서는 제외한다.** 버그가 아니라 의도된 결정이니 되돌리지 말 것:
     - 카드는 A4 **1~2쪽 인쇄물**이다(아래 인쇄 항목). 그림책 펼침면 16장이면 장면도 16개라, 장면마다 요약 + 질문을 카드 본문에 펼치면 그것만으로 목표 분량을 넘긴다. 그러면 카드가 아니라 책이 된다
     - 인쇄물에는 확장된 `storyOutlineKo`(최대 10문장)가 이미 들어간다 — 줄거리 맥락은 종이에도 남는다. 이 10문장이 분량 다이얼의 절대 상한인 이유가 여기다(A4 1~2쪽)
     - 장면 메모는 **책장을 넘기며 그 자리에서 보는** 물건이라(askKo가 핵심) 손에 든 화면 쪽이 실사용에 맞다. 종이로 뽑아 두면 지금 몇 쪽인지 눈으로 찾아야 한다
   - 누락 안내에 **개수를 쓰지 않는다** ("한 장면이 빠졌어요" ✗ / "이 사이가 비어 있어요" ○). `gapBefore`는 불리언이라 연속 누락도 마커가 1개이고, 마지막 배치가 실패하면 마커 자체가 없다(docs/harness/english.md §2A-5). 정확한 범위는 촬영 직후 검토 화면에서 `failedBatchCount`와 배치 범위로 따로 알린다
5. STEP 1 읽기 전 워밍업 (2개)
6. STEP 2 필수 단어장 (12개, 표: 단어·한글발음 / 뜻 / 쉬운 영어 풀이 / 예문) + 엄빠 티칭 포인트 박스
7. STEP 3 읽으면서 미션 (3개)
8. STEP 4 읽고 나서 대화 (8개, 유형 태그 + 영어 질문 + 한국어 질문 + 부모용 힌트)
9. [논픽션만] 엄빠 찬스: 재미있는 사실 (4개, 영/한)
10. 확장 놀이 (2개)

- 단어마다 스피커 버튼: Web Speech API(speechSynthesis, en-US)로 발음 재생 — 외부 API·비용 없음
- "읽어주기 영상 찾기": 원래는 `https://www.youtube.com/results?search_query={제목 저자 read aloud}` 검색 결과를 새 탭으로 여는 링크였다(API 불필요). **지금은 이 자리가 카드 생성 중 낭독 영상 자동 검색·선택 → 자막 grounding → 챕터 리더로 확장됐다 — §14-1 참조.**
- 인쇄 버튼: A4 세로, 책당 1~2쪽 목표의 인쇄 CSS
- "다시 생성" 버튼: 같은 책으로 새 카드 생성(기존 카드 유지)

### 4-3. 서재 `/library`

- 카드 목록: 표지 썸네일, 제목, AR, 만든 날짜. 제목 검색
- 상단 요약: 총 권수, 최근 30일 권수, AR 레벨 추이 미니 차트 (읽은 날짜 x AR 지수 — 간단한 인라인 SVG로 충분, 차트 라이브러리 금지)
- 읽음 기록: 카드 화면의 "오늘 읽었어요" 체크 → readings에 기록, 별점(1~5) 선택

## 5. 데이터 모델 (Firestore)

```
books/{bookId}
  title, author, series?, isbn?, arLevel?: number, lexile?: number,
  wordCount?: number, arQuizNo?: string, isFiction: boolean,
  topic: string, coverUrl?, googleBooksId?, levelEstimated: boolean, createdAt,
  blurbText?: string,              // 호출 A가 뒤표지·책날개에서 읽은 소개글
  sceneKind?: 'toc' | 'pages',     // 아래 sceneDigest의 출처
  sceneDigest?: SceneDigestItem[]  // 호출 A′의 장면별 요약 (§6)

cards/{cardId}
  bookId, content: Card(§6 JSON), model: string, createdAt

readings/{readingId}
  bookId, readAt, rating?: number, noteKo?: string
```

- 업로드된 사진 원본은 판독 후 저장하지 않는다(§1). 표지 이미지는 Google Books 썸네일 URL을 사용
- `blurbText`·`sceneDigest`를 **books에 보관하는 이유**: "다시 생성"이 사진 재업로드 없이 같은 근거로 돌아야 한다. 사진을 저장하지 않으므로 요약이 유일한 사본이다
- `sceneDigest`는 카드에도 복사해 저장한다(`cards.content.sceneDigest`) — 카드는 만든 시점의 근거를 그대로 담은 스냅샷이어야 나중에 book이 갱신돼도 카드 내용과 어긋나지 않는다
- Firestore 접근은 서버에서만(Admin SDK + Cloud Run 서비스 계정 ADC). 클라이언트 직접 접근 없음 → 보안 규칙은 전체 차단으로 단순화

## 6. 학습 카드 콘텐츠 JSON 스키마

TypeScript 타입으로 그대로 구현하고, zod로 런타임 검증하라.

```ts
interface Card {
  bookIntroKo: string;          // "이 책은?" 2문장. 아이 흥미 유발형
  levelNoteKo: string;          // AR 수치를 부모에게 쉽게 풀어주는 1문장
  storyOutlineKo?: string;      // 줄거리 미리보기 (논픽션은 내용 소개, 결말 미공개). 분량은 근거의 양에서 계산한다 — metadata 3~4 / blurb 4~6 / toc·pages는 장면 수 N에서 ⌈N/2⌉+2 ~ N+2 (3~10문장 경계, harness/english.md §3-2). 신규 생성엔 필수 — 기존 저장 카드에는 없음
  storySource?: StorySource;    // 줄거리의 근거 두께. 배지: 예상 / 소개글 기반 / 목차 기반 / 본문 확인
  /** @deprecated storySource로 대체. 구 저장 카드를 읽기 위해서만 남긴다 — 배지 판정은 resolveStorySource() */
  storyIsGuess?: boolean;
  sceneDigest?: SceneDigestItem[];  // 호출 A′의 장면별 요약. 호출 B의 출력이 아니라 라우트가 붙여 넣는다
  beforeReading: { ko: string }[];   // 2개. 표지 추리 놀이 1개 포함
  vocab: VocabItem[];                // 12개 (AR<2면 10개)
  teachingTipKo: string;             // 발음·문법 등 티칭 포인트 1개
  whileReading: { ko: string }[];    // 3개. 몸놀이·미션형
  questions: QuestionItem[];         // 8개 (AR<2면 6개)
  funFacts?: { en: string; ko: string }[]; // 논픽션만 4개. 일반 상식 수준의 사실
  activities: { titleKo: string; descKo: string }[]; // 2개. 몸으로 노는 확장 놀이
}

interface VocabItem {
  word: string;
  pronKo: string;               // 한글 발음 표기, 예: "팩"
  meaningKo: string;            // 한글 뜻
  easyEn: string;               // 아이 눈높이 영영 풀이, 예: "a wolf family"
  exampleEn: string;            // 새로 창작한 간단 예문 (책 문장 아님)
  difficulty: 'basic' | 'challenge';  // challenge는 2~3개만
  isCore?: boolean;             // 제목·주제의 핵심 단어 1개에 표시
}

interface QuestionItem {
  type: '사실확인'|'인물'|'배경'|'사건'|'인과'|'감정'|'예측'|'결말'|'비교'|'상상'|'내생각'|'나와연결';
  en: string;                   // 아이에게 그대로 읽어줄 쉬운 영어 질문
  ko: string;                   // 자연스러운 우리말 질문 (직역 금지)
  hintKo?: string;              // 부모용 힌트·정답·코칭 팁 (절반 정도만)
}

type StorySource = 'metadata' | 'blurb' | 'toc' | 'pages';  // 근거의 두께 (얇은 → 두꺼운 순)

interface SceneDigestItem {
  seq: number;                  // 촬영 순서 (1부터, 병합 시 다시 매김)
  labelKo: string;              // "1~2쪽" 또는 "3장: Pooh와 꿀단지"
  summaryKo: string;            // 1~3문장 우리말 요약 (영어 원문 전사 아님)
  askKo?: string | null;        // 그 장면에서 부모가 던질 질문 1개 — 이 기능의 핵심 가치
  confidence?: 'high'|'medium'|'low' | null;  // low면 재촬영 유도
  gapBefore?: boolean | null;   // 앞 장면과 이어지지 않음 (사진 누락·순서 뒤바뀜). 메우려 지어내지 않는다
}
```

- 질문 8개는 책 전체 기준이라 부모가 "언제 던질지"를 판단해야 한다. `askKo`는 장면에 붙어 그 부담을 없앤다 — 이 필드가 본문 촬영 기능의 핵심 가치다

## 7. AI 호출 명세

**구현 원본은 저장소의 `docs/harness/english.md`(AI 하네스 명세)다. 그 문서의 시스템 프롬프트·JSON Schema·공통 래퍼 규칙을 그대로 코드로 옮겨라(`lib/ai/` 모듈).** 아래는 요약이다.

### 7-1. 표지 판독 (vision, 호출 A)

- 입력: 이미지 1~3장 (표지 / 정보 스티커 / 뒤표지, base64 data URL). 출력: books 필드 형태의 JSON — Structured Outputs(json_schema, strict: true)로 강제
- 판독 대상: 표지의 제목·저자·시리즈 + 정보 스티커의 AR 지수, Lexile, 단어 수(Word Count), AR 퀴즈번호, Fiction/NonFiction 표기 (한국 원서몰 스티커에 이 항목들이 인쇄되어 있음)
- 뒤표지·책날개 소개글(blurbText)도 함께 판독한다 — 출판사가 쓴 실제 줄거리라 카드 품질에 직결된다. 표지 사진은 지금까지 메타데이터만 뽑고 버려졌다. 이 판독을 살리려면 상한이 3장이어야 한다(§4-1)
- 스티커가 없으면 있는 정보만 채우고 나머지는 null

### 7-1′. 본문·목차 판독 (vision, 호출 A′)

- 입력: 본문/목차 사진 N장. 출력: 장면별 요약 배열(`SceneDigestItem[]`) — 사진 6장씩 배치로 나눠 병렬 호출
- 상세는 docs/harness/english.md §2A. 배치 실패는 그 배치의 사진만 잃고 나머지 장면은 살린다
- 프롬프트 필수 요건: 영어 원문 전사 금지(§1), 못 읽은 장면은 confidence를 낮출 것, 페이지 누락(gapBefore)을 지어내 메우지 말 것, 마지막 구간은 결말을 흐릴 것
- 본문 사진을 호출 B에 그대로 붙이지 않은 이유: 이미지 토큰이 한 호출에 몰리고 모델이 뒷장을 소홀히 보며 실패 시 전량 재시도가 된다. 2단계로 나누면 "다시 생성"이 사진 재업로드 없이 저장된 요약만으로 된다

### 7-2. 카드 생성

시스템 프롬프트 완성본은 docs/harness/english.md에 있다. 아래 템플릿은 핵심 요건 요약이니, 구현 후 빠진 요건이 없는지 대조용으로 써라:

```
너는 초등학생 아이와 영어 그림책을 함께 읽는 한국인 부모를 돕는 독서 교육 전문가다.
주어진 책의 메타데이터(제목·저자·난이도·주제·소개글)만 근거로 학습 카드를 만든다.

[절대 규칙]
- 근거로 받은 글은 요약의 재료로만 쓰고, 책의 영어 원문을 그대로 옮겨 적지 않는다. 모든 예문은 새로 창작한다.
- 받은 근거를 넘어서는 내용을 지어내지 않는다.
- 모든 콘텐츠는 초등 아이와 부모가 함께 쓴다. 영어는 짧고 쉽게,
  한국어는 아이에게 말 걸듯 다정하게, 부모 힌트는 실전 코칭이 되게.

[줄거리 미리보기]
- storyOutlineKo는 결말 미공개(논픽션은 내용 소개). 분량은 근거의 **양**에 비례한다 —
  메타데이터뿐 3~4문장 / 뒤표지 소개글까지 4~6 / 목차·본문 장면 메모는 장면 수 N에서 계산
  (⌈N/2⌉+2 ~ N+2, 3~10문장 경계). 4장면이면 4~6문장, 12~16장면이면 8~10문장.
  종류만 보고 일괄 분량을 요구하면 얇은 근거에서 모델이 지어내게 된다 (harness/english.md §3-2).
- storySource에 실제로 근거로 삼은 것 중 가장 두꺼운 것을 적는다(metadata/blurb/toc/pages). 받지 못한 근거는 적을 수 없다.

[단어 선정]
- the, and, is 같은 기초 사이트워드와 초등 기초 어휘(교육부 800 수준)는 제외하고,
  이 책의 주제·레벨에서 '새로 배울' 단어만 고른다.
- 주제 어휘 중심으로 고른다 (예: 늑대 논픽션이면 pack, howl, den, prey...).
- 제목의 핵심 단어는 반드시 포함하고 isCore를 표시한다.
- AR 레벨 적응: AR<2 → 10개·더 쉬운 풀이 / AR 2~3.5 → 12개 / AR>3.5 → 12개 + challenge 3개.
- 규칙 변화가 있는 단어(불규칙 복수형, 유사 발음 쌍 등)가 있으면 teachingTipKo에서 다룬다.

[질문 작성 — FairytaleQA 유형 체계 준용]
- 8개를 서로 다른 유형으로 다양하게 구성한다.
- 픽션: 인물, 사건, 인과, 감정, 예측, 결말, 나와연결을 반드시 포함.
- 논픽션: 사실확인, 인과, 비교, 상상, 내생각, 나와연결을 포함.
- 정답이 있는 질문은 hintKo에 정답+칭찬 멘트를, 열린 질문은 후속 질문 팁을 담는다.
- 마지막 질문은 책을 아이의 일상과 연결하는 질문으로 마무리한다.

[논픽션 전용]
- funFacts 4개는 널리 알려진 일반 상식 수준의 사실만 쓴다 (특정 책의 서술을 옮기지 않는다).

출력은 지정된 JSON 스키마로만 한다.
```

- 사용자 메시지에는 책 메타데이터(제목, 저자, 시리즈, AR, Lexile, 단어 수, 픽션 여부, 주제, Google Books 소개글)를 구조화해 전달
- Structured Outputs(json_schema, strict: true)로 §6 스키마 강제 — 배열 개수 제약(12개·8개 등)은 스키마가 아니라 프롬프트+zod로 검증. 실패 시 검증 오류를 첨부해 1회 재생성
- 출력 토큰 한도 여유 있게(6,000 수준). 호출당 사용 토큰을 서버 로그에 남겨 비용을 추적

## 8. 디자인 명세

- **저장소의 `design/영어책_학습카드_샘플.html`이 디자인 원본이다. 이 룩앤필을 React 컴포넌트로 옮겨라.** 파일이 없으면 아래 토큰으로 재현:
  - 배경 `#faf7f0`, 카드 `#ffffff`, 잉크 `#20242b`, 보조 텍스트 `#5b6472`, 라인 `#e6e2d8`
  - 포인트 색: 논픽션 = 파랑 `#3b6ea5`, 픽션 = 꿀색 `#c8871f` (카드 상단 컬러바, STEP 배지, 칩, 질문 태그에 일관 적용)
- 구조: 상단 컬러바 → 북헤더(이모지 커버 + 제목 + 메타 칩) → STEP 배지가 달린 섹션들 → 단어장 표 → 질문 카드 리스트(유형 태그) → 색 배경 팁 박스
- 폰트: 시스템 폰트 스택(한글 포함). 외부 폰트·외부 CDN 로딩 금지 (오프라인 인쇄 대비)
- 커버 이모지: 책 주제에 맞게 생성 시 함께 정한다 (늑대 🐺, 꿀 🍯 식). 썸네일이 있으면 썸네일 우선
- 인쇄: `@media print`, 책당 1~2쪽, `print-color-adjust: exact`로 배경색 유지

## 9. 예외 처리

- 판독 실패(책 표지가 아님·흐림): "다시 찍어주세요" 안내 + 수동 입력 폼 폴백
- 식별 실패: 판독값만으로 진행, 커버는 이모지로
- 동일 책 재등록(제목+저자 일치): 기존 카드로 이동시키고 "그래도 새로 만들기" 선택지 제공
- AI 오류·타임아웃: 재시도 버튼 제공, 불완전 데이터는 저장하지 않음
- JSON 검증 실패: 1회 자동 재생성, 그래도 실패하면 친절한 에러 화면

## 10. 개발 순서 (마일스톤별로 작동 상태 유지하며 커밋)

- **M1 카드 코어**: 수동 메타데이터 입력 폼 → 생성 API(docs/harness/english.md 구현 포함) → 카드 렌더링. §12 픽스처 2권으로 검증
- **M2 입력 완성**: 사진 판독(vision) + Google Books 식별 연결
- **M3 저장·서재**: Firestore 연동, 서재 페이지, 읽음 기록과 AR 추이 차트
- **M4 마감·배포**: 인쇄 CSS, 모바일 다듬기, Cloud Run 배포(gcloud 명령을 README에)

각 마일스톤 완료 시 README의 실행 방법 갱신. 로컬 데모용 시드 데이터 포함

## 11. 환경 변수

```
OPENAI_API_KEY=      # 필수. 서버 전용
OPENAI_MODEL=        # 기본값: 비전+Structured Outputs 지원 최신 모델 (OpenAI 문서에서 확인)
GOOGLE_BOOKS_API_KEY= # 선택. 없으면 무키 호출(저볼륨 가능)
GOOGLE_APPLICATION_CREDENTIALS= # 로컬 개발용. Cloud Run에서는 서비스 계정 ADC 사용
SUPADATA_API_KEY=    # 선택(낭독 자막 grounding 시). 서버 전용. 유튜브 자막 fetch(Supadata) — §14-1
YOUTUBE_API_KEY=     # 선택(낭독 영상 자동 검색 시). 서버 전용. YouTube Data API v3 search — §14-1
```

## 12. 테스트 픽스처 (실물 검증 데이터)

```json
[
  {
    "title": "Wolves", "author": "Laura Marsh",
    "series": "National Geographic Kids Readers, Level 2",
    "isFiction": false, "arLevel": 3.3, "lexile": 570,
    "wordCount": 864, "arQuizNo": "148832",
    "topic": "늑대 — 무리(pack) 생활, 하울링, 사냥, 새끼 키우기"
  },
  {
    "title": "Pooh Gets Stuck", "author": "Isabel Gaines",
    "series": "A Winnie the Pooh First Reader",
    "isFiction": true, "arLevel": 2.0, "lexile": 430,
    "wordCount": 551, "arQuizNo": "41866",
    "topic": "푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동"
  }
]
```

- 기대 결과: 단어 12개(핵심 단어 포함, 기초 사이트워드 없음), 유형이 겹치지 않는 질문 8개, 본문 인용 0건, 논픽션에만 funFacts 존재
- 테스트는 생성 API 유닛 테스트 + zod 스키마 검증 정도면 충분 (E2E 자동화는 과함)

## 13. 하지 말 것

- 책 본문의 **영어 원문**을 카드에 옮겨 적기 (짧은 발췌 포함). 사진은 우리말 요약의 근거로만 쓴다 (§1)
- 업로드된 원본 사진 저장 (Cloud Storage 연동 포함)
- 외부 사이트 크롤링·스크래핑
- 로그인·회원 시스템, 다국어 UI, 상태관리·차트 라이브러리 추가
- 모델 ID 하드코딩, 클라이언트에서 직접 AI 호출, API 키 노출

## 14. 확장 기능 (2026-08 — §1~13 기본 흐름 위에 얹힌 것)

> AI 호출·프롬프트·JSON Schema·zod·grounding 규칙의 상세는 모두 `docs/harness/english.md`에 있다(호출 F 챕터화·호출 G 단어 뜻·단어장 판독/정의 등). 여기서는 제품 수준의 흐름과 경계만 적는다.

### 14-1. 유튜브 낭독 자막 grounding + 챕터 리더

표지·소개글만으로 줄거리를 **예측**하던 카드가 조악했던 문제(환각)를 실제 본문에 붙여 해결한다.

- **낭독 영상 자동 검색**: 판독으로 제목·저자가 정해지면 그 값으로 낭독 영상을 검색(`lib/youtube-search.ts`, YouTube Data API v3)해 **상위 3개 후보**를 보여주고 사용자가 하나를 탭한다. 첫 결과를 자동 채택하지 않는 것은 **엉뚱한 책에 grounding되는 것을 막기 위함**(사람이 표지를 보고 고른다). 후보 메타는 영상시간 · 게시자 순으로 표시. 건너뛰기 가능(그러면 §3 기본 경로).
- **자막 fetch**: 고른 영상의 자막을 **Supadata**(`lib/youtube-transcript.ts`, 서버 전용)로 가져온다. 클라우드 IP 차단·Whisper 폴백을 호스팅 API가 처리한다 — **우리가 직접 유튜브를 스크래핑하지 않는다**(§13의 "크롤링·스크래핑 금지"와 무관, 유료 API 호출이다).
- **grounding**: 자막이 있으면 storySource 등급에서 transcript가 **최상위**가 되어 카드 줄거리·질문이 실제 본문에 붙는다("낭독 확인" 배지).
- **챕터 리더**(자막이 있으면 **항상** 생성): 목차가 있으면 챕터별로, 없으면 "전체" 한 블록으로, **영어 원문(문장 단위) + 한글 해석**을 보여준다. 코드가 각 챕터 문장이 자막의 부분 문자열인지 검사(`groundChapters`)해 프롬프트 밖 환각을 막는다. 카드 생성 직후 클라이언트가 `/api/chapterize`를 best-effort로 자동 호출(실패해도 카드는 남는다).
- **단어 더블탭**: 챕터 리더의 영어 단어를 두 번 탭하면 **그 문장 맥락의 한글 뜻**(호출 G)·발음(TTS)·"**모은 단어**" 단어장 담기. 모은 단어장은 get-or-create(멱등)로 하나만 두고 단어장 정복의 시험·오답노트에 편입된다.
- **라우트**: `/api/youtube-search`(후보 검색) · `/api/card`(youtubeUrl 선택 — 있으면 자막 fetch 후 grounding, 없으면 §3과 바이트 동일) · `/api/chapterize`(bookId → chapters) · `/api/word-meaning`(호출 G) · `/api/english/vocab/collected/add-word`(모은 단어). 데이터 모델은 `BookRecord`에 `transcript`·`youtubeUrl`·`chapters`(nullable) 추가.

### 14-2. 영어단어장 정복

교재(예: 능률 VOCA류, DAY 20개)를 앱으로 옮겨 **판독 → 시험 → 오답노트**까지 돌리는 별도 기능. 축은 "**판독 = 책 원문 전사 / AI 창작 = 영영 정의·이모지만**"이다 — 예문·뜻은 책 원문을 보존한다.

- **판독**(`/api/english/vocab/extract`, vision): DAY 사진 2~4장을 판독해 단어·발음기호·품사·뜻(번호 보존)·예문(영/한)·유의어를 **원문 그대로 전사**한다. 밀집·2단 조판 정확도가 성패라 few-shot으로 예문 누락을 막았다.
- **영영 정의 + 이모지**(호출 D, `/api/english/vocab/[id]/enrich`): 판독 직후 자동 생성. **정의는 시험이 매달리므로 한 번 생성되면 불변**(재생성은 `definitionEn === null`인 단어만 채운다). 이모지 없으면 첫 글자 배지.
- **뷰·TTS**: 표/카드 토글, 단어·예문 읽어주기(`lib/speech.ts`).
- **시험**(`/api/english/vocab/[id]/quiz`): **영영 정의 제시 → 영단어 5지선다**(정답1 + 같은 DAY 오답4, 셔플). 즉시 피드백·발음. 세션은 별도 컬렉션에 저장(전사본 불변).
- **오답노트**: DAY 안(`[id]/wrong`)과 DAY 넘어(`/english/vocab/wrong`) 두 층. **연속 2회 정답이면 졸업**(`lib/vocab-mastery.ts`).
- **라우트**: `/api/english/vocab/*`(extract·route·[id]·enrich·quiz·rename·add-word·collected) · 화면 `/english/vocab/*`(목록·상세·quiz·wrong·new). 순수 함수(병합·보기 생성·졸업·복습)는 `lib/vocab-*.ts`에 두고 오프라인 eval로 잠근다.
- **경로 규약**: 수학 접두사 규약을 따라 `/english/vocab/*` · `/api/english/vocab/*`.

## 15. 확장 기능 (2026-09 — §14 위에 더 얹은 것)

> 세 기능 모두 **AI 무관·클라이언트+스토어 중심**. AI 호출·프롬프트는 안 늘었다.

### 15-1. 목록 순서변경 (서재·단어장·수학 공통)

기록 목록의 **관리 모드**에 삭제만 있던 것에 **드래그 순서변경**을 더했다.

- **게이트 = 관리 모드 재사용**: 관리 모드에서만 각 줄에 **드래그 핸들(≡) + ↑/↓ 버튼**(+키보드)이 나타난다. 평소엔 스크롤·열기만 — 모바일 세로 스크롤↔드래그 충돌을 관리 모드 게이트로 피한다.
- **저장**: 각 레코드에 `sortIndex: number | null`(필수 nullable). 재배치하면 그 목록 전체를 0..n으로 재색인해 저장. 정렬은 `sortIndex` null 먼저(`createdAt` 역순=**새 항목이 맨 위**) → 나머지 오름차순. 생성부는 sortIndex를 안 매긴다(스토어가 매김) — 하위호환.
- **공유 프리미티브**: `components/use-reorder.ts`(포인터 드래그+자동스크롤+키보드+낙관적 되돌림) · `lib/reorder-contract.ts`(범용 `{orderedIds}`) 하나로 세 목록을 굴린다. 라우트 `/api/library/reorder` · `/api/english/vocab/reorder` · `/api/math/reorder`. 라이브러리 추가 없음.
- **수학 필터 게이트**: 수학 목록은 필터(전체/틀린 문제/보류)가 있어, **'전체'가 아닐 때는 재배치 비활성**(부분 목록만 재색인하면 인덱스가 충돌). 삭제는 어느 필터에서도 유지. 서재는 검색 중 비활성, 단어장은 필터가 없어 게이트가 관리 모드 하나뿐.

### 15-2. 읽어주기(TTS) 속도 조절

읽어주기 속도를 **천천히(0.7)·보통(0.9, 기본)·빠르게(1.1)** 3단 분절 버튼으로 고른다.

- 슬라이더가 아니라 버튼: 아이+폰 맥락이라 큰 탭 타깃이 낫고, 세로 스크롤 목록 안 가로 슬라이더는 스크롤과 충돌한다. 속도는 3~4단이면 충분.
- **전역 값 하나**(`lib/speech.ts` `getTtsRate`/`setTtsRate`, localStorage 영속) — 6개 읽어주기 화면(카드·챕터리더·단어장·시험·오답)이 공유한다(같은 단어가 화면마다 다른 목소리로 들리면 안 된다는 원칙). 컨트롤은 `components/tts-speed-control.tsx`, 챕터 리더·단어장 상단에 배선. 기본 0.9라 안 건드리면 기존과 동일.

### 15-3. 단어장 유의어·반의어 연결 + 관계 문제 시험

단어장 안의 다른 **(단어+뜻)**을 골라 특정 단어의 **특정 뜻**에 유의어/반의어로 연결하고, 그 관계를 시험 문제로 낸다(§14-2 단어장 정복 확장).

- **의미별 연결**: 모델이 이미 뜻을 `meanings[].related`로 담으므로(교재 판독분), 여기에 **사용자 연결**을 더한다. `VocabRelated`에 `source:"book"|"user"` + `linkedNo`·`linkedMeaningIndex`(필수 nullable) 추가. **AI 추출 JSON Schema·프롬프트는 무변경** — 판독분은 코드 정규화가 `source:"book"`으로 채운다(spec-sync 무영향).
- **양쪽 상호 기록**: `linkVocabRelated`/`unlinkVocabRelated`(공용 순수함수 `applyVocabLink`, 양 백엔드)가 두 뜻의 related에 대칭 기록·멱등. 라우트 `/api/english/vocab/[id]/link`(POST·DELETE). 엔트리 식별은 배열 인덱스(교재 번호 `no`는 손입력 null·중복 가능이라 유일 식별 불가), 저장 매칭은 `word`+`meaningIndex`.
- **연결 UI**: 각 뜻 옆 "＋연결" → 단어장 내 (단어·뜻) 피커(자기·기존 연결 제외). 사용자 연결분만 표식+해제(교재 판독 유의어는 표시만).
- **관계 문제 시험**: `buildRelationQuestions`로 **"X의 유의어는?/반대말은?"** 5지선다(정답=연결어, 오답=같은 DAY 단어, `buildChoices` 재사용). **내가 연결한 것만**(`source:"user"`) 출제. 관계 결과는 `VocabQuizRecord{mode:"relation"}` 별도 저장 → def→word 숙련도·오답노트·졸업에 **무오염**(오프라인 eval이 반례로 잠금).

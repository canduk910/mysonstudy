# 개발 명세 — 은우 북카드 (영어책 학습 카드 생성 웹앱)

> 이 문서가 앱 전체의 개발 명세다. AI 호출의 상세 구현 원본은 `docs/HARNESS.md`(AI 하네스 명세).
> 명세에 없는 결정은 "가족용 소규모 앱, 단순함 우선" 원칙으로 판단하고, 판단 내용을 README에 남긴다.

## 0. 제품 한 줄 요약

초등학생 아이가 읽을 영어책의 표지 사진을 올리거나 제목을 입력하면, 그 책에 맞는 학습 카드(필수 단어장 + 한/영 대화 질문 + 읽기 전/중/후 활동)를 생성하고, 만든 카드를 '서재'에 쌓아 아이의 읽기 이력을 관리하는 가족용 웹앱.

## 1. 배경과 절대 원칙

- 사용자: 아빠(관리자)와 초등학생 아이 '은우'. UI 언어는 한국어.
- **저작권 절대 원칙 (최우선):**
  - 책의 본문 텍스트를 수집·저장·표시·복원하는 기능을 어떤 형태로도 만들지 않는다. 부분 발췌도 금지.
  - 학습 카드는 메타데이터(제목, 저자, AR/Lexile 지수, 단어 수, 주제, 공개된 소개글)만 근거로 새로 창작한다.
  - AI 생성 프롬프트에 "책의 실제 문장을 인용·복원·추측 재현하지 말 것" 가드레일을 반드시 포함한다.
  - 외부 사이트의 본문·데이터 스크래핑 코드를 작성하지 않는다 (AR BookFinder 등 크롤링 금지 — 스티커 판독과 수동 입력으로 해결).
- 가족용 개인 도구다. 로그인 없음(비공개 URL 운영). 과설계 금지.

## 2. 기술 스택 (확정)

- Next.js (App Router, TypeScript), 모바일 우선 반응형 — 아빠가 폰으로 표지를 찍어 올리는 것이 기본 시나리오
- 스타일: Tailwind CSS (참고 디자인 재현이 더 쉬우면 CSS Modules 병용 가능)
- AI: OpenAI API — 표지 판독(vision)과 카드 생성 모두. Responses API(현행 표준) 사용, 출력은 Structured Outputs(json_schema, strict: true)로 강제. 모델 ID는 하드코딩하지 말고 env `OPENAI_MODEL`로 받되, 기본값은 OpenAI 공식 문서에서 확인한 비전(이미지 입력)과 Structured Outputs를 모두 지원하는 최신 모델로 설정
- 책 식별: Google Books API(기본) + Open Library API(폴백)
- DB: Firestore (Native mode)
- 배포: GCP Cloud Run (region: asia-northeast3 서울). 소스 배포(`gcloud run deploy --source .`) 기준으로 README 작성
- 비밀값: Cloud Run 환경변수 또는 Secret Manager. API 키를 클라이언트 번들에 절대 노출하지 않는다. 모든 외부 API 호출은 서버(route handler)에서만. `.env.example` 제공, 실제 키 커밋 금지

## 3. 핵심 플로우

```
[입력] 표지 사진 1~2장 (표지 / 정보 스티커)  또는  제목(+저자) 텍스트
   ↓
(1) 판독 — OpenAI vision
    사진에서 추출: 제목, 저자, 시리즈, AR 지수, Lexile, 단어 수,
    AR 퀴즈번호, 픽션/논픽션 (한국 원서몰 스티커에 이 정보가 인쇄되어 있음)
   ↓
(2) 식별 — Google Books API (제목+저자 검색)
    확보: ISBN, 소개글(description), 카테고리, 썸네일 URL
    실패 시 Open Library 폴백, 둘 다 실패 시 판독값만으로 진행
   ↓
(3) 생성 — OpenAI API
    §6 스키마의 학습 카드 JSON 생성 (§7 프롬프트 명세)
   ↓
(4) 렌더링·저장 — 카드 화면 표시, Firestore 저장, 인쇄 지원
```

- 진행 UI: "표지 읽는 중 → 책 확인 중 → 카드 만드는 중" 3단계 상태 표시
- 제목만 입력한 경우: (1) 생략, (2)부터 시작. AR/Lexile을 얻지 못하면 소개글·대상 연령으로 레벨을 추정하고 카드에 "레벨 추정" 배지를 표시한다

## 4. 화면 명세 (3페이지)

### 4-1. 홈 `/`

- 큰 버튼 2개: "표지 사진으로 만들기"(`<input type="file" accept="image/*" capture="environment" multiple>` 최대 2장), "책 이름으로 만들기"(제목 필수, 저자 선택)
- 최근 만든 카드 3개 미리보기 (표지 썸네일 + 제목 + AR 칩)

### 4-2. 카드 `/card/[id]`

§8 디자인 그대로. 구성 순서:

1. 북헤더: 이모지 커버, 제목, 저자·시리즈, 메타 칩(AR / Lexile / 단어 수 / 픽션·논픽션)
2. 이 책은? (2문장 소개 + 레벨 설명 1문장)
3. STEP 1 읽기 전 워밍업 (2개)
4. STEP 2 필수 단어장 (12개, 표: 단어·한글발음 / 뜻 / 쉬운 영어 풀이 / 예문) + 아빠 티칭 포인트 박스
5. STEP 3 읽으면서 미션 (3개)
6. STEP 4 읽고 나서 대화 (8개, 유형 태그 + 영어 질문 + 한국어 질문 + 부모용 힌트)
7. [논픽션만] 아빠 찬스: 재미있는 사실 (4개, 영/한)
8. 확장 놀이 (2개)

- 단어마다 스피커 버튼: Web Speech API(speechSynthesis, en-US)로 발음 재생 — 외부 API·비용 없음
- "읽어주기 영상 찾기" 버튼: `https://www.youtube.com/results?search_query={제목 저자 read aloud}` 새 탭 링크 (API 불필요, 링크 제공은 저작권 문제 없음)
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
  topic: string, coverUrl?, googleBooksId?, levelEstimated: boolean, createdAt

cards/{cardId}
  bookId, content: Card(§6 JSON), model: string, createdAt

readings/{readingId}
  bookId, readAt, rating?: number, noteKo?: string
```

- 업로드된 사진 원본은 판독 후 저장하지 않는다(개인정보 최소화). 표지 이미지는 Google Books 썸네일 URL을 사용
- Firestore 접근은 서버에서만(Admin SDK + Cloud Run 서비스 계정 ADC). 클라이언트 직접 접근 없음 → 보안 규칙은 전체 차단으로 단순화

## 6. 학습 카드 콘텐츠 JSON 스키마

TypeScript 타입으로 그대로 구현하고, zod로 런타임 검증하라.

```ts
interface Card {
  bookIntroKo: string;          // "이 책은?" 2문장. 아이 흥미 유발형
  levelNoteKo: string;          // AR 수치를 부모에게 쉽게 풀어주는 1문장
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
```

## 7. AI 호출 명세

**구현 원본은 저장소의 `docs/HARNESS.md`(AI 하네스 명세)다. 그 문서의 시스템 프롬프트·JSON Schema·공통 래퍼 규칙을 그대로 코드로 옮겨라(`lib/ai/` 모듈).** 아래는 요약이다.

### 7-1. 표지 판독 (vision)

- 입력: 이미지 1~2장 (base64 data URL). 출력: books 필드 형태의 JSON — Structured Outputs(json_schema, strict: true)로 강제
- 판독 대상: 표지의 제목·저자·시리즈 + 정보 스티커의 AR 지수, Lexile, 단어 수(Word Count), AR 퀴즈번호, Fiction/NonFiction 표기 (한국 원서몰 스티커에 이 항목들이 인쇄되어 있음)
- 스티커가 없으면 있는 정보만 채우고 나머지는 null

### 7-2. 카드 생성

시스템 프롬프트 완성본은 docs/HARNESS.md에 있다. 아래 템플릿은 핵심 요건 요약이니, 구현 후 빠진 요건이 없는지 대조용으로 써라:

```
너는 초등학생 아이와 영어 그림책을 함께 읽는 한국인 부모를 돕는 독서 교육 전문가다.
주어진 책의 메타데이터(제목·저자·난이도·주제·소개글)만 근거로 학습 카드를 만든다.

[절대 규칙]
- 책의 실제 본문 문장을 인용·복원·추측 재현하지 않는다. 모든 예문은 새로 창작한다.
- 모든 콘텐츠는 초등 아이와 부모가 함께 쓴다. 영어는 짧고 쉽게,
  한국어는 아이에게 말 걸듯 다정하게, 부모 힌트는 실전 코칭이 되게.

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

- **M1 카드 코어**: 수동 메타데이터 입력 폼 → 생성 API(docs/HARNESS.md 구현 포함) → 카드 렌더링. §12 픽스처 2권으로 검증
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

- 책 본문 수집·저장·표시 (짧은 발췌 포함)
- 외부 사이트 크롤링·스크래핑
- 로그인·회원 시스템, 다국어 UI, 상태관리·차트 라이브러리 추가
- 모델 ID 하드코딩, 클라이언트에서 직접 AI 호출, API 키 노출

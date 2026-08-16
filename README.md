# 은우 북카드 📚

초등학생 아이가 읽을 영어책의 **표지 사진을 올리거나 제목을 입력하면**, 그 책에 맞는 학습 카드(필수 단어장 + 한/영 대화 질문 + 읽기 전/중/후 활동)를 AI로 생성하고, 만든 카드를 '서재'에 쌓아 아이의 읽기 이력을 관리하는 가족용 웹앱입니다.

> 🖼️ *스크린샷 자리 — 홈(사진 업로드) / 학습 카드 / 서재 화면*
> <!-- ![홈 화면](docs/img/screenshot-home.png) ![학습 카드](docs/img/screenshot-card.png) ![서재](docs/img/screenshot-library.png) -->

- 카드 내용은 책의 **메타데이터(제목·저자·AR 지수·주제·공개 소개글)만 근거로 새로 창작**합니다. 책 본문은 수집·저장·표시하지 않습니다(저작권 절대 원칙, `docs/SPEC.md` §1).
- 스택: Next.js(App Router, TS) · Tailwind CSS · OpenAI Responses API(Structured Outputs) · Google Books/Open Library · Firestore · Cloud Run

## 1. 로컬 실행

```bash
npm install
npm run seed   # 데모 데이터 주입 (파일 스토어 data/db.json)
npm run dev    # http://localhost:3100 (다른 로컬 프로젝트와의 포트 충돌을 피해 3100 고정)
```

**API 키 없이도 데모가 됩니다.** GCP 자격증명이 없으면 자동으로 **파일 스토어**(`data/db.json`)로 동작하고, `npm run seed`가 픽스처 2권(Wolves, Pooh Gets Stuck)의 데모 카드와 읽음 기록을 넣어 줍니다 — 홈·카드(`/card/seed-card-wolves`, `/card/seed-card-pooh`)·서재(`/library`)를 바로 볼 수 있습니다. 실제 카드 생성(사진 판독·카드 생성)에만 `OPENAI_API_KEY`가 필요합니다(키가 없으면 API가 501로 친절히 안내).

## 2. 환경 변수

`.env.example`을 `.env.local`로 복사해 채웁니다. **실제 키는 커밋 금지.**

| 변수 | 필수 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | AI 생성 시 필수 | 서버 전용. 표지 판독(vision)·카드 생성에 사용. 없으면 시드 데모만 가능 |
| `OPENAI_MODEL` | 선택 | 기본값 `gpt-5.5` — 비전 입력 + Structured Outputs + Responses API를 모두 지원하는 최신 모델(OpenAI 공식 문서 2026-08 확인). 스냅샷 고정이 필요하면 `gpt-5.5-2026-04-23` 지정 |
| `GOOGLE_BOOKS_API_KEY` | 선택 | 책 식별(ISBN·소개글·썸네일)용. 없으면 무키 호출(쿼터 낮음) — 실패 시 Open Library로 자동 폴백 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 선택 | 로컬에서 Firestore를 쓸 때 서비스 계정 키 파일 경로. Cloud Run에서는 불필요(서비스 계정 ADC) |
| `STORE_BACKEND` | 선택 | `firestore` \| `file`. 미설정 시 자동 감지 — GCP 신호(`GOOGLE_APPLICATION_CREDENTIALS`/`K_SERVICE`/`GOOGLE_CLOUD_PROJECT`)가 있으면 firestore, 없으면 file |

## 3. Cloud Run 배포 (서울, 소스 배포)

Dockerfile 없이 `gcloud run deploy --source .` 기준입니다(Buildpacks가 `npm run build` → `npm start`를 수행하고, `next start`는 Cloud Run의 `PORT`를 자동 인식).

```bash
# 0) 사전 준비 (1회)
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

# 1) Firestore 데이터베이스 생성 — 반드시 Native mode (1회)
gcloud firestore databases create --location=asia-northeast3

# 2) OpenAI 키를 Secret Manager에 저장 (권장 — env 평문 대신)
printf '%s' 'sk-...' | gcloud secrets create openai-api-key --data-file=-

# 3) 배포
gcloud run deploy eunwoo-bookcard \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --set-env-vars OPENAI_MODEL=gpt-5.5
# GOOGLE_BOOKS_API_KEY를 쓰려면 --set-env-vars에 추가(또는 Secret으로)

# 4) 런타임 서비스 계정에 Firestore 권한 (기본 컴퓨트 SA를 쓰는 경우)
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
  --role roles/datastore.user
```

- Cloud Run에서는 `STORE_BACKEND`를 설정하지 않아도 됩니다 — `K_SERVICE` 감지로 자동으로 Firestore(ADC)를 씁니다.
- 배포에서 제외할 파일은 `.gcloudignore`가 관리합니다(문서·하네스·로컬 데이터 제외).
- Node 버전을 고정하고 싶으면 `package.json`에 `"engines": { "node": "22.x" }`를 추가하세요.

### 비공개 URL 운영

이 앱은 **로그인이 없습니다**(가족용, `docs/SPEC.md` §1). `--allow-unauthenticated`로 배포하되 **무작위 Cloud Run URL을 가족에게만 공유**하는 방식으로 운영합니다 — 검색엔진·외부에 URL을 노출하지 마세요. 더 강하게 잠그려면 `--no-allow-unauthenticated` + IAM 호출 권한(또는 Load Balancer + IAP)을 쓸 수 있지만, 브라우저 접근에 인증 프록시가 필요해 가족용으로는 과합니다.

## 4. 프롬프트 수정 워크플로 (필수 순서)

프롬프트도 코드처럼 회귀 테스트를 거칩니다(`docs/HARNESS.md` §5·§6).

1. `lib/ai/prompts.ts`(또는 `lib/ai/schemas.ts`)를 수정한다
2. `npm run eval:cards` 실행 — 픽스처 2권으로 실제 카드를 생성해 자동 점검 (`OPENAI_API_KEY` 필요, 실호출 2회 발생)
3. **항목별 pass/fail 표가 전부 통과(exit 0)하는지 확인**한다
4. 통과했을 때만 커밋한다

단어 개수·challenge 비율·질문 열림/닫힘 비율·힌트 밀도 같은 품질 다이얼은 전부 `lib/ai/prompts.ts`의 시스템 프롬프트 숫자만 바꾸면 됩니다.

## 5. 명세에 없던 판단 기록

`docs/SPEC.md`에 명시되지 않아 "가족용 소규모 앱, 단순함 우선" 원칙으로 결정한 사항들입니다(SPEC 서문의 기록 의무).

### 저장·데이터

| 판단 | 내용과 근거 |
|---|---|
| 저장 계층 이원화 | `BookCardStore` 인터페이스 아래 파일 스토어(`data/db.json`)와 Firestore 구현을 두고 `STORE_BACKEND` 또는 자동 감지로 선택 — 키 없는 로컬은 설정 없이 데모, Cloud Run은 설정 없이 Firestore가 되게 |
| 시드 데모 카드 | `npm run seed`가 넣는 카드 2장은 AI가 아니라 직접 창작한 콘텐츠(본문 인용 0건, zod 검증 통과). `model: "seed-demo"`로 AI 생성물과 구분. 파일 스토어 전용 |
| `books`에 필드 2개 추가 | `coverEmoji`(판독 결과 이모지의 저장처), `description`("다시 생성" 때 소개글 재사용) — SPEC §5에 없지만 Firestore로 그대로 이관 가능 |
| 읽음 기록은 하루 1건(멱등) | 같은 책+같은 날짜 재기록 시 삽입하지 않고 기존 기록 반환. 별점 수정 API는 두지 않음(과설계 금지). `readAt`은 사용자 로컬 달력 날짜(YYYY-MM-DD) |
| Firestore 복합 인덱스 회피 | where 필터만 쿼리하고 정렬·정규화 비교는 메모리에서 — 수십 권 규모라 인덱스 배포 마찰을 없애는 쪽이 단순 |

### AI·모델

| 판단 | 내용과 근거 |
|---|---|
| `OPENAI_MODEL` 기본값 `gpt-5.5` | OpenAI 공식 모델 문서(2026-08 확인) 기준 비전 입력·`structured_outputs`·Responses API를 모두 지원하는 현행 최신 세대. 날짜 미고정 별칭이라 스냅샷 갱신을 자동 수용 |
| strict 스키마 ↔ 선택 필드 | Structured Outputs strict 모드는 선택 필드를 null 유니온 필수로 요구 — SPEC §6 타입을 `?: T \| null`로 표기해 zod 출력이 그대로 대입되게 함 |
| 판독 수치의 범위 밖 값은 "미상" 강등 | 오독(예: Lexile "BR40L" → -40)이 400 오류 루프가 되지 않게 클라이언트에서 서버 zod 경계 밖 수치를 null로 정리 → 레벨 추정 경로가 흡수 |
| 키 없음(501)을 어떤 검증보다 먼저 | 키 없는 로컬 데모에서 어떤 입력이든 동일한 안내를 받게 |

### 흐름·UX

| 판단 | 내용과 근거 |
|---|---|
| 동일 책 중복 판정 | 제목+저자 **정규화 일치**로 감지(SPEC §9) → "기존 카드 보기 / 그래도 새로 만들기(force)" 선택지. 재생성(`bookId`) 경로는 의도된 새 카드라 검사 없음 |
| 저자 미입력 → `"미상"` | 저자는 선택 입력인데 프롬프트 템플릿의 author는 필수 슬롯 — 빈 값을 "미상"으로 통일 |
| `levelEstimated` = AR 부재 기준 | 프롬프트의 레벨 미상 판정이 AR 기준이므로, AR을 얻지 못하면 "레벨 추정" 배지 |
| topic 폴백 체인 | 사진 흐름: 판독 topicGuess → 식별 카테고리 → 제목 순. 최악의 경우에도 카드 생성이 가능하게 |
| isFiction 미상 시 추정 | 식별 카테고리 문자열로 추정(nonfiction/fiction 포함 여부), 그래도 미상이면 픽션 기본(아동서 다수) |
| 사진은 저장하지 않음 | 판독 후 요청 메모리에서만 사용(SPEC §5 개인정보 최소화). 업로드 전 클라이언트에서 긴 변 ~1500px 리사이즈(토큰 절약) |
| Open Library 폴백은 소개글 없음 | search API에 소개글 필드가 없어 works 추가 호출 없이 "없음"으로 진행 — 단순함 우선 |
| 서재 "권수"는 책 기준, 차트는 AR 있는 책만 | 책장 은유라 카드 수가 아닌 책 수. AR이 없는 책의 읽음 기록은 y값이 없어 차트에서 제외 |
| 썸네일은 `<img>` (next/image 아님) | 외부 썸네일 1장에 원격 도메인 설정+최적화 파이프라인은 과설계. 인쇄에도 원본 URL이 단순 |
| 인쇄 페이지 브레이크는 행 단위 회피 | 큰 섹션(단어장 12행·질문 8개)에 통째 break-inside: avoid를 걸면 큰 공백이 생겨, 행·질문 카드·팁 박스 단위로만 회피 — 책당 1~2쪽 목표 유지 |

## 6. 개발 하네스

이 저장소는 클로드 코드 하네스로 개발됩니다 — AI 호출 명세(프롬프트·스키마·검증·eval)는 `docs/HARNESS.md`, 앱 전체 명세는 `docs/SPEC.md`, 에이전트·스킬 구성은 `.claude/`를 참조하세요.

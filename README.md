# 은우 북카드 📚

초등학생 아이가 읽을 영어책의 **표지 사진을 올리거나 제목을 입력하면**, 그 책에 맞는 학습 카드(필수 단어장 + 한/영 대화 질문 + 읽기 전/중/후 활동)를 AI로 생성하고, 만든 카드를 '서재'에 쌓아 아이의 읽기 이력을 관리하는 가족용 웹앱입니다.

> 🖼️ *스크린샷 자리 — 홈(사진 업로드) / 학습 카드 / 서재 화면*
> <!-- ![홈 화면](docs/img/screenshot-home.png) ![학습 카드](docs/img/screenshot-card.png) ![서재](docs/img/screenshot-library.png) -->

- 카드 내용은 **새로 창작**합니다. 근거는 책의 메타데이터(제목·저자·AR 지수·주제·공개 소개글), 뒤표지·책날개 소개글, 그리고 **직접 찍어 올린 본문·목차 사진의 우리말 요약**입니다.
- **본문 사진을 올리는 것은 선택**입니다. 안 올리면 표지·소개글만으로 카드가 만들어지고, 올리면 줄거리가 길어지고 장면마다 던질 질문이 붙습니다.
- **업로드한 사진 원본은 어디에도 저장하지 않습니다** — 판독 직후 버리고, 남는 것은 우리말 요약 텍스트뿐입니다. **영어 원문을 그대로 옮겨 적지 않습니다**(제목·챕터 제목·인물 이름은 예외). 이 원칙은 `docs/SPEC.md` §1에 있고, zod가 연속 영어 8단어를 실제로 거부해 강제합니다.
- **유튜브 낭독 자막으로 카드를 뒷받침**할 수 있습니다 — 책 제목으로 낭독 영상을 자동 검색해 고르면, 그 자막으로 줄거리를 실제 본문에 grounding하고 챕터별 **영어 원문+한글 해석 리더**(단어 더블탭 뜻·발음·"모은 단어" 담기)를 붙입니다. 자막은 우리가 스크래핑하지 않고 Supadata API로 가져옵니다.
- 별도로 **영어단어장 정복**(교재 사진 판독 → 영영 정의·이모지 → 영단어 5지선다 시험 → 오답노트)이 있습니다. 상세는 `docs/SPEC.md` §14.
- 그 밖에 **목록 순서변경**(서재·단어장·수학을 관리 모드에서 드래그로 재배치), **읽어주기 속도 조절**(천천히·보통·빠르게), **단어장 유의어·반의어 연결**(AI 추천 후보에서 골라 단어장에 새로 추가·연결하고 관계 문제로 시험)이 있습니다. 상세는 `docs/SPEC.md` §15.
- 은우 쪽 두 번째 과목 **수학코치** — 문제집 사진(또는 직접 입력)을 넣으면 '왜 그렇게 푸는지'를 3막(탐정 시간·되감기·다시 재생)으로 설명하고, 답은 독립 검산과 맞을 때만 펼치며 어긋나면 접어 둔 채 '보류'로 표시하고, 되감기 플레이어로 장면을 그려 줍니다. 상세는 `docs/harness/math.md`.
- **아빠 영역**(학습자가 아이가 아니라 아빠) — **아빠의 일본어**: JLPT 단어장(레벨·주제로 AI 생성, 후리가나·시험 5모드(뜻→표기·한자→읽기·표기→뜻·빈칸·일일정의→표기)·오답노트, 한자 시험 2모드), 듀오링고 대화 스크린샷 → 전사·학습 해설(해설을 한국어 설명까지 이어 읽는 **해설 듣기**), 한자 학습(한국 한자음을 다리로). 상세는 `docs/harness/japanese.md`·`docs/SPEC.md` §18. **아빠의 영어**(토익스피킹): 표현 암기장 사진을 판독하거나 준비한 파일로 가져와 표현마다 **발화 포인트**(문항별 활용 문장·답변 틀·바꿔 쓰기·발음·이어 말하기)를 붙인 카드·전체 듣기·시험 4모드(뜻→표현·표현→뜻·빈칸·소리 내어 말하기)·오답노트, 그리고 AI가 새로 만든 11문항 **모의고사**(Q3–4 사진은 AI 생성) → 실전 형식 응시(질문 음성·타이머·녹음 — 녹음은 기기에만) → 버튼을 눌러야 도는 **AI 채점**(음성 전사 + 피드백, Q1–2는 지문 대조)·추정 등급. 교재 내용은 공개 저장소에 넣지 않고 앱의 "파일로 가져오기"로만 넣습니다. 상세는 `docs/harness/toeic.md`·`docs/SPEC.md` §20. **아빠의 운동**: 러시안 파이터 풀업·푸시업 사다리 — RM을 넣으면 27일 사이클을 계산하고, 오늘 세트·슈퍼세트 세션(휴식 타이머·음성 안내)·실패하면 회복 휴식 하루 뒤 직전에 성공한 Day 목표로 한 번 → 성공하면 실패한 Day 재도전·Day 27 재측정 → 새 사이클 자동 계산. 계산은 **LLM을 쓰지 않는** 순수 엔진입니다(세션 음성 안내만 발음 엔진을 거친다). 상세는 `docs/SPEC.md` §19.
- 화면 공통: **언어별 발음 엔진**(기본은 영어·한국어 OpenAI TTS, 일본어 기기 음성 — 사용자가 언어별로 바꿀 수 있고, 클라우드가 실패하면 기기 음성으로 조용히 폴백 — §16)과 모든 화면 상단의 **학습 스트릭**(은우 · 아빠 일본어 · 아빠 영어 · 아빠 운동의 연속일을 나란히 — §17).
- 스택: Next.js(App Router, TS) · Tailwind CSS · OpenAI Responses API(Structured Outputs) · OpenAI TTS(`gpt-4o-mini-tts`) · OpenAI 이미지 생성(`gpt-image-2`)·음성 전사(`gpt-4o-mini-transcribe`) · Google Books/Open Library · Firestore · Cloud Run · Supadata(자막)·YouTube Data API v3(낭독 영상 검색)

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
| `OPENAI_MODEL_VERIFY` | 선택 | 수학 검산(호출 C) 전용 모델. 비어 있거나 없으면 `OPENAI_MODEL` — 답을 독립적으로 다시 푸는 심판만 더 강한 모델로 올릴 여지(`docs/harness/math.md` §1) |
| `OPENAI_TTS_MODEL` | 선택 | 클라우드 발음(§16)용 TTS 모델. 기본값 `gpt-4o-mini-tts` — 기기 음성보다 자연스러운 최신 TTS. 스냅샷 고정은 `gpt-4o-mini-tts-2025-12-15`. 미설정이어도 기본값으로 동작(별도 설정 불필요) |
| `OPENAI_TTS_VOICE` | 선택 | 발음 음성. 기본값 `alloy`(en-US·ja-JP·ko-KR 한 음성 공용 — ko-KR은 일본어 해설 듣기(§18)와 운동 세션 음성 안내(§19-6)용). 더 따뜻한 톤은 `nova`·`coral`·`sage` 등으로 교체. `OPENAI_API_KEY`가 없으면 자동으로 기기 음성으로 폴백 |
| `OPENAI_IMAGE_MODEL` | 선택 | 아빠의 영어 모의고사 Q3–4 사진 생성(관문 P, `lib/toeic-image.ts`). 기본값 `gpt-image-2`. 사진은 1536×1024 JPEG로 만들어 `toeicImages` 문서 하나에 담는다(data URL 900,000자 상한) |
| `OPENAI_IMAGE_QUALITY` | 선택 | 사진 품질 `low`·`medium`·`high`·`auto`. 기본값 `medium` — 모르는 값도 `medium`으로 되돌린다(그대로 보내면 400이라 사진이 조용히 사라진다) |
| `OPENAI_TRANSCRIBE_MODEL` | 선택 | 아빠의 영어 모의고사 답변 음성 전사(관문 T, `lib/toeic-transcribe.ts`). 기본값 `gpt-4o-mini-transcribe`. AI 채점 버튼을 누를 때만 쓰인다 |
| `GOOGLE_BOOKS_API_KEY` | 선택 | 책 식별(ISBN·소개글·썸네일)용. 없으면 무키 호출(쿼터 낮음) — 실패 시 Open Library로 자동 폴백 |
| `SUPADATA_API_KEY` | 선택 | 서버 전용. 고른 유튜브 낭독 영상의 자막을 가져와 카드·챕터 리더의 근거로 사용(없으면 자막 grounding만 비활성, 기본 카드 생성은 정상) |
| `YOUTUBE_API_KEY` | 선택 | 서버 전용. 책 제목·저자로 낭독 영상 후보를 검색(YouTube Data API v3). 없으면 낭독 영상 자동 검색만 비활성 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 선택 | 로컬에서 Firestore를 쓸 때 서비스 계정 키 파일 경로. Cloud Run에서는 불필요(서비스 계정 ADC) |
| `STORE_BACKEND` | 선택 | `firestore` \| `file`. 미설정 시 자동 감지 — GCP 신호(`GOOGLE_APPLICATION_CREDENTIALS`/`K_SERVICE`/`GOOGLE_CLOUD_PROJECT`)가 있으면 firestore, 없으면 file |
| `APP_PIN` | **배포 시 필수** | 접속 잠금 PIN(숫자 **6~8자리 권장**, 최소 4자리 — 4자리는 경우의 수가 1만뿐이라 짧습니다). 서버 전용. 도메인이 공개돼도 가족 외 접속과 AI 비용 유출을 막습니다. **프로덕션에서 미설정이면 전 요청을 503으로 차단**(fail-closed), 로컬 개발에서 미설정이면 잠금 없이 통과 |

> 선택 변수(`OPENAI_MODEL`·`OPENAI_MODEL_VERIFY`·`OPENAI_TTS_MODEL`·`OPENAI_TTS_VOICE`·`OPENAI_IMAGE_MODEL`·`OPENAI_IMAGE_QUALITY`·`OPENAI_TRANSCRIBE_MODEL`)는 **비워 두거나(`X=`) 빼면 기본값**이 쓰입니다 — 빈 값·공백도 미설정으로 봅니다(`lib/ai/client.ts` `resolveModel`·`resolveVerifyModel`, `lib/tts.ts`, `lib/toeic-image.ts`, `lib/toeic-transcribe.ts`). 2026-09-24 전에는 `??` 폴백이라 `.env.example`을 그대로 복사하면 빈 문자열이 모델 ID로 새어 호출이 실패하거나 발음이 조용히 기기 음성으로만 났습니다.

## 3. Cloud Run 배포 (서울, 소스 배포)

> **현재 배포 상태 (2026-08-16)**: 프로젝트 `eunwoo-bookcard` · 서비스 `eunwoo-bookcard` · 서울(asia-northeast3)
> 서비스 URL은 비공개(가족 전용)라 저장소에 적지 않는다 — `gcloud run services describe eunwoo-bookcard --region asia-northeast3 --format='value(status.url)'`로 확인.
> OpenAI 키는 Secret Manager `openai-api-key`, Firestore는 Native mode. 재배포는 main 푸시(GitHub Actions) 또는 아래 3) 명령.

Dockerfile 없이 `gcloud run deploy --source .` 기준입니다(Buildpacks가 `npm run build` → `npm start`를 수행하고, `next start`는 Cloud Run의 `PORT`를 자동 인식).

```bash
# 0) 사전 준비 (1회)
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

# 1) Firestore 데이터베이스 생성 — 반드시 Native mode (1회)
gcloud firestore databases create --location=asia-northeast3

# 2) OpenAI 키와 접속 PIN을 Secret Manager에 저장 (권장 — env 평문 대신)
printf '%s' 'sk-...' | gcloud secrets create openai-api-key --data-file=-
printf '%s' '246813' | gcloud secrets create app-pin --data-file=-   # 숫자 6~8자리 권장

# 3) 배포
gcloud run deploy eunwoo-bookcard \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest,APP_PIN=app-pin:latest \
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

### 비공개 URL + PIN 잠금 운영

이 앱은 **로그인이 없습니다**(가족용, `docs/SPEC.md` §1). 대신 **PIN 잠금** 한 겹만 둡니다 — 커스텀 도메인(eunwoo.site)을 공개하면 URL을 아는 외부인이 들어와 AI 호출 비용을 쓸 수 있기 때문입니다.

- 첫 방문 시 `/unlock` 화면에서 `APP_PIN`을 입력하면 서명 쿠키(`__session`, httpOnly, 180일)가 발급되고, 그 뒤로는 묻지 않습니다.
- 쿠키 이름이 `__session`인 것은 **Firebase Hosting 제약**입니다 — 커스텀 도메인(eunwoo.site)은 Hosting → Cloud Run 리라이트를 거치는데, Hosting은 백엔드로 요청을 넘기기 전에 `__session`을 뺀 모든 쿠키를 제거합니다. 다른 이름을 쓰면 Cloud Run URL에서만 열리고 커스텀 도메인에서는 `/unlock` 무한 루프가 됩니다.
- 페이지뿐 아니라 **API(`/api/card`·`/api/extract` 등)도 같은 게이트로 보호**합니다(잠기지 않은 API가 하나라도 있으면 비용 차단이 무의미).
- 시도 제한은 2겹입니다 — ① **전역 백스톱**: 10분 안에 오답이 30회를 넘으면 그 창이 끝날 때까지 모든 PIN 시도를 429로 막습니다(헤더를 보지 않으므로 우회 불가). ② **키별(≈IP) 잠금**: 10회 틀리면 10분. 키는 `x-forwarded-for`의 **마지막** 항목(프런트엔드가 덧붙인 값)입니다 — 첫 값은 클라이언트가 위조할 수 있어 쓰지 않습니다.
- 두 카운터 모두 인스턴스 메모리 기준입니다(Cloud Run 재시작 시 초기화, 가족용 규모에는 충분). 공격이 계속되면 전역 백스톱 때문에 가족도 잠깐(최대 10분) 못 들어올 수 있는데, 정상 사용은 기기당 180일에 1회 PIN 입력이라 실제 불편은 거의 없습니다.
- `--allow-unauthenticated`로 배포하고 URL은 가족에게만 공유합니다. `--no-allow-unauthenticated` + IAM/IAP는 브라우저 접근에 인증 프록시가 필요해 가족용으로는 과합니다.

> ⚠️ **이미 배포된 서비스라면 PIN을 먼저 붙이세요.** GitHub Actions 배포(`.github/workflows/deploy.yml`)는 env·secret을 다시 지정하지 않으므로, `APP_PIN` 없이 재배포되면 fail-closed 규칙에 따라 **사이트 전체가 503**이 됩니다.
>
> ```bash
> printf '%s' '246813' | gcloud secrets create app-pin --data-file=-
> gcloud run services update eunwoo-bookcard --region asia-northeast3 \
>   --update-secrets APP_PIN=app-pin:latest
> # 런타임 서비스 계정에 시크릿 읽기 권한 (openai-api-key와 같은 SA를 쓰면 이미 있을 수 있음)
> gcloud secrets add-iam-policy-binding app-pin \
>   --member serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
>   --role roles/secretmanager.secretAccessor
> ```

**PIN 변경 방법** — Secret Manager에 새 버전을 넣고 재배포하면 끝입니다(기존 쿠키는 서명 키가 바뀌어 자동 무효화 → 전 기기가 다시 묻습니다).

```bash
printf '%s' '135790' | gcloud secrets versions add app-pin --data-file=- && \
gcloud run deploy eunwoo-bookcard --source . --region asia-northeast3
```

## 4. 프롬프트 수정 워크플로 (필수 순서)

프롬프트도 코드처럼 회귀 테스트를 거칩니다(`docs/harness/english.md` §5·§6).

1. `lib/ai/english/prompts.ts`(또는 `lib/ai/english/schemas.ts`)를 수정한다
2. `npm run eval:english` 실행 — 픽스처로 실제 카드를 생성해 자동 점검 (`OPENAI_API_KEY` 필요, **실호출 3회** 발생. 본문 근거 경로를 빼고 2회만 돌리려면 `EVAL_SKIP_PAGES=1`)
3. **항목별 pass/fail 표가 전부 통과(exit 0)하는지 확인**한다
4. 통과했을 때만 커밋한다

단어 개수·challenge 비율·질문 열림/닫힘 비율·힌트 밀도 같은 품질 다이얼은 전부 `lib/ai/english/prompts.ts`의 시스템 프롬프트 숫자만 바꾸면 됩니다.

다른 과목도 순서는 같습니다 — 프롬프트는 `lib/ai/<과목>/prompts.ts`, 스펙은 `docs/harness/<과목>.md`, 회귀는 `npm run eval:<과목>`. **아빠의 영어(토익스피킹)**는 `npm run eval:toeic`이며 기본이 **오프라인(무비용)**입니다 — zod 반례·후처리·시험 출제·모드별 숙련도 분리·형식표·Q1–2 대조·추정 총점·스트릭 트랙 분리, 그리고 프롬프트·JSON Schema가 `docs/harness/toeic.md`와 같은지(spec-sync). 실호출은 `EVAL_TOEIC=1`일 때만 호출 A(사진 경로 `EVAL_TOEIC_PHOTO`가 있을 때)·B·C(파트 하나, `EVAL_TOEIC_PART` 기본 opinion)·D를 한 번씩 부르고, `EVAL_OFFLINE_ONLY=1`이면 게이트를 켜도 건너뜁니다. 교재 가져오기 파일 검증은 `data/private/`에 파일이 있을 때만 돌고 없으면 SKIP입니다(공개 저장소·CI 기준).

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
| `books`의 근거 3필드는 **필수 nullable** | `blurbText`·`sceneKind`·`sceneDigest`를 선택(`?`)이 아니라 필수 nullable로 뒀다 — book을 만드는 곳에서 빠뜨리면 컴파일이 깨져야 근거 유실("다시 생성"이 줄거리를 3~4문장으로 퇴화시키는 사고)을 타입이 막는다 |
| `updateBookEvidence`만 부분 갱신 | 범용 `updateBook`을 만들지 않고 근거 3필드 전용 패치 메서드만 뒀다 — `/api/pages`가 필요로 하는 유일한 갱신이고, 넘긴 키만 덮어써 빈 값이 기존 근거를 지우지 않는다 |
| 운동은 사건만 저장, 상태는 재생 | `workoutCycles` 문서에 기록(완료·실패) 사건 배열만 두고 "현재 Day·실패 플래그·누적 볼륨"은 읽을 때 재생으로 계산(SPEC §19-2) — 스트릭과 같은 규약, 저장하면 두 진실이 갈린다. 휴식은 달력이 채우고 운동은 기록이 채운다(운동일은 며칠이 지나도 기다리고, 휴식일은 날짜가 지나면 쉰 것으로 친다) |
| 저장소 첫 Firestore 트랜잭션 + `rev` | 기록·취소·사이클 시작은 판정 순수 함수(`decide*`)를 파일 스토어는 `mutate` 안, Firestore는 `runTransaction` 안에서 호출해 검증과 쓰기를 한 원자 단위로(§19-4). 동시성 토큰은 사건 개수가 아니라 변경마다 +1되는 `rev` — 개수는 "다른 탭에서 취소 후 재기록"하면 같아져 낡은 탭의 취소가 엉뚱한 사건을 지운다(ABA). 기록 취소·사건 있는 사이클 닫기는 prod-guard 대상(Firestore 백엔드에서만 — 파일 스토어는 가드하지 않는 기존 관용구) |
| 교재 전사본은 저장소 밖 + "파일로 가져오기" | 저장소가 공개라 교재 사진·전사를 커밋하면 출판물이 공개된다. 아빠의 영어 교재 10쪽 전사본(+발화 포인트)은 `data/private/`(`.gitignore` — `.gcloudignore`가 물려받아 배포 업로드에서도 빠짐)에만 두고, 앱의 파일 가져오기(`presetKey` 멱등 — 두 번 눌러도 한 번)로 넣는다. `public/*.json`은 PIN 게이트의 정적 확장자 예외라 더 나쁘다. 프로덕션 반입은 가족이 앱에서 파일을 고르는 행동이다 — 로컬 스크립트가 프로덕션 DB에 쓰지 않게(SPEC §20-6) |
| 토익은 은우 기록과 컬렉션부터 분리 | 은우 단어장(`vocabBooks`·`vocabQuizzes`)을 같이 쓰면 은우 스트릭·오답노트가 오염된다 — 컬렉션 5개(`toeicSets`·`toeicQuizzes`·`toeicMocks`·`toeicImages`·`toeicAttempts`)·경로 `/toeic`·스트릭 트랙을 따로 둔다. 표현 모양도 달라(`word`/`pos` 대신 `expression`/`meaningKo`/발화 포인트) 스키마를 나눠 쓸 수 없다 |
| 모의고사 녹음은 기기에만, AI 사진은 문서 한 장씩 | 녹음은 IndexedDB(최근 응시 5회분)에만 두고 서버엔 전사문·점수·피드백만 — 원본 미저장 원칙·Firestore 문서 1MB·버킷 없음(대가: 응시한 기기에서만 채점). 반대로 AI가 만든 Q3–4 사진은 사용자가 올린 원본이 아니라 저장한다 — `toeicImages` 한 장 = 문서 하나(900,000자 상한), 사진 문서 생성과 모의고사 칸 갱신을 한 원자 단위로 해 동시 요청에도 한 장만 남고 고아 문서가 생기지 않는다 |

### AI·모델

| 판단 | 내용 |
|------|------|
| temperature 자동 생략 | 추론 계열 모델(예: gpt-5.6-luna)은 temperature 파라미터를 400으로 거부한다. callWithSchema가 첫 거부 시 파라미터를 빼고 재시도하며 모델별로 기억한다 — HARNESS §1의 temperature 다이얼은 이런 모델에는 적용되지 않는다 |
| 질문 유형: 사실확인 1개 확정 | HARNESS §3-1의 "논픽션 사실확인 2개"와 §4 zod의 "유형 중복 금지"가 모순이었음 — 사용자 결정(2026-08-16)으로 사실확인 1개·유형 중복 금지로 통일, HARNESS·SPEC·prompts.ts 동기 수정 |

| 판단 | 내용과 근거 |
|---|---|
| `OPENAI_MODEL` 기본값 `gpt-5.5` | OpenAI 공식 모델 문서(2026-08 확인) 기준 비전 입력·`structured_outputs`·Responses API를 모두 지원하는 현행 최신 세대. 날짜 미고정 별칭이라 스냅샷 갱신을 자동 수용 |
| strict 스키마 ↔ 선택 필드 | Structured Outputs strict 모드는 선택 필드를 null 유니온 필수로 요구 — SPEC §6 타입을 `?: T \| null`로 표기해 zod 출력이 그대로 대입되게 함 |
| 판독 수치의 범위 밖 값은 "미상" 강등 | 오독(예: Lexile "BR40L" → -40)이 400 오류 루프가 되지 않게 클라이언트에서 서버 zod 경계 밖 수치를 null로 정리 → 레벨 추정 경로가 흡수 |
| 키 없음(501)을 어떤 검증보다 먼저 | 키 없는 로컬 데모에서 어떤 입력이든 동일한 안내를 받게 |
| 발음 엔진은 언어별 선택, 일본어는 기기 기본 | 청취 비교에서 영어는 클라우드가, 일본어는 기기 음성(Kyoko)이 피치 액센트가 살아 더 자연스러웠다 — 추측하지 않고 언어별로 사용자가 고르게 두고(`lib/speech.ts` `DEFAULT_ENGINE`, SPEC §16-5), 한국어(해설 듣기·운동 음성 안내)는 기기 음성이 해설 속 「は」 같은 일본어 인용을 한국어식으로 읽어 클라우드 기본(§18-3) |
| 낭독 지시 버전을 올리지 않고 ko-KR 추가 | `TTS_INSTRUCTIONS_VERSION`은 영속 캐시 지문 전체에 걸려, 올리면 이미 캐시된 영어·일본어 오디오가 통째로 비워져 재합성 요금이 난다 — 새 언어 추가는 기존 키와 겹치지 않아 2 유지. 대신 ko 지시를 튜닝하는 날엔 전 언어 캐시 폐기 비용을 감수해야 한다 |
| 운동 엔진에 AI를 쓰지 않음 | 원안에는 LLM 코치 프롬프트가 있었지만 Day 계산·실패 롤백·재측정은 전부 결정적 규칙 — 같은 입력이면 같은 답이 나와야 하는 상태 기계를 LLM에 맡기면 비용과 오답 위험만 는다. 브리핑·주의사항 문구도 코드가 만든다(§19-0) |
| 사진 생성·음성 전사는 하네스 밖 관문 | 토익 관문 P(`lib/toeic-image.ts`)·T(`lib/toeic-transcribe.ts`)는 Structured Outputs가 아니라 바이트를 주고받는 호출이라 `callWithSchema`에 넣지 않고 TTS처럼 독립 클라이언트를 쥔다 — 키 규약만 공유(키가 없으면 네트워크 호출 없이 501), `lib/ai/client.ts`에 과목 분기 0 |
| 전사에 기대 문장을 주지 않고, Q1–2는 LLM이 채점하지 않음 | 지문·모범답변을 전사 `prompt`로 넣으면 전사가 그쪽으로 끌려가 점수가 부풀려진다 — 함수에 prompt 인자 자체가 없고 eval이 소스를 정적으로 본다. 전사문으로는 발음·억양을 알 수 없으니 지문 읽기(Q1–2)는 LLM에게 점수를 지어내게 하지 않고 전사문↔지문 단어 정렬(순수 함수)로 참고 점수만 낸다 |
| 모의고사 문항은 AI 신작 | 기출·ETS 공식 샘플은 저작권이 ETS에 있어 넣지 않는다 — 형식·시간만 맞추고, 파트 지시문도 이 앱의 문장이다 |

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
| 본문 촬영은 **별도 진입점** | 표지 버튼은 예전 그대로 한 번에 카드까지 간다. 본문·목차 촬영은 그 아래 작은 링크로 뺐다 — 선택 기능 때문에 기본 경로에 단계가 늘면 매일 쓰는 흐름이 무거워진다 |
| 장면 메모는 접힘 + 인쇄 제외 | 펼침면 16장이면 장면도 16개라 카드 본문에 펼치면 A4 1~2쪽 목표(SPEC §4-2)를 혼자 넘긴다. 카드에는 확장된 줄거리만 두고, 장면별 요약·질문은 접히는 "읽기 가이드"로 — 부모가 책장을 넘기며 폰으로 보는 물건이라 화면 쪽이 실사용에 맞다 |
| 본문 판독 진행은 **경과 시간** 표시 | 서버가 배치별 진행을 스트리밍하지 않는다. 지어낸 퍼센트 대신 사진 장수·묶음 수·경과 초를 사실 그대로 보여준다 — 40장이면 1~2분이 걸려 아무 표시가 없으면 멈춘 줄 알고 새로고침한다(이미 쓴 비용이 날아간다) |
| 누락 안내에 **개수를 쓰지 않음** | `gapBefore`는 불리언이라 연속 누락도 마커 1개이고 마지막 배치 실패는 마커 자체가 없다. "한 장면이 빠졌어요" 대신 "이 사이가 비어 있어요"로 쓰고, 정확한 범위는 `failedBatchCount`+배치 범위로 따로 안내 |
| 상한 숫자의 단일 정의처 | 표지 3장은 `lib/upload-limits.ts`(라우트·UI 공용, 순수 모듈), 본문 40장·배치 6장은 `lib/ai/client.ts`가 정의하고 서버 컴포넌트가 props로 내려준다 — `lib/ai/client.ts`는 `openai`와 키를 건드려 클라이언트에서 import할 수 없다 |
| `/api/pages` 요청 총량 24MB | 이미지당 상한(8MB)만 두면 40장 × 8MB = 320MB 본문이 가능하다. Cloud Run 요청 상한이 32MiB이고 1500px JPEG 40장이 대략 12~20MB라 24MB면 정상 사용은 넉넉히 통과하고 사고성 대용량만 막힌다 |
| PIN 미설정 시 프로덕션은 fail-closed | `APP_PIN`이 없으면 프로덕션에서는 전 요청을 503으로 막는다(로컬 개발은 통과) — 설정 실수로 **열린 채 방치**되어 외부인이 AI 비용을 쓰는 사고가, 잠긴 채 막혀 바로 알아채는 것보다 훨씬 나쁘다 |
| 잠금은 쿠키 서명(HMAC) 1겹, 세션 저장소 없음 | 쿠키 값 `<exp>.<HMAC-SHA256(APP_PIN, "unlock:<exp>")>` — PIN이 곧 서명 키라 PIN을 바꾸면 기존 쿠키가 자동 무효화된다. 사용자·세션 테이블을 두지 않아 로그인 없는 가족용 규모에 맞다 |
| 시도 제한은 전역 백스톱 + IP 잠금 2겹 | IP 키의 원천인 `x-forwarded-for`는 **첫 값이 클라이언트 위조 가능**이라(GCP 프런트엔드는 받은 값을 버리지 않고 뒤에 덧붙인다) 마지막 항목으로 키잉하고, 그래도 인덱스 판단이 틀릴 수 있어 헤더를 보지 않는 전역 카운터(10분 30회)를 함께 둔다. 로그인 없는 앱에서 PIN 무차별 대입을 막는 유일한 방어라 우회 불가능한 겹이 하나는 있어야 한다 |
| 게이트 파일은 `proxy.ts` | Next.js 16에서 `middleware.ts`는 deprecated이고 `proxy.ts`(export `proxy`)로 이름이 바뀌었다 — 새 규약을 따랐다(`node_modules/next/dist/docs/.../proxy.md`) |
| 목록 순서변경은 `sortIndex` 하나 + 새 항목은 맨 위 | 서재·단어장·수학이 관리 모드 드래그+↑↓로 재배치(SPEC §15-1). 각 레코드 `sortIndex: number\|null`(필수 nullable), 재배치 시 목록 전체를 0..n 재색인. 정렬은 null 먼저(`createdAt` 역순=새 항목 위) → 오름차순이라 수동 정렬 뒤에도 새로 만든 게 눈에 띈다. 공유 프리미티브 `use-reorder`(포인터 드래그+자동스크롤+키보드) 하나로 세 목록. 수학은 필터가 '전체'가 아니면 재배치 비활성(부분 재색인 인덱스 충돌 회피) |
| 읽어주기 속도는 전역 값 하나 | `lib/speech.ts`의 rate를 화면마다 두면 같은 단어가 다른 목소리로 들린다 — `getTtsRate`/`setTtsRate`(localStorage 영속) 하나를 6개 화면이 공유. 컨트롤은 슬라이더가 아니라 3단 분절 버튼(아이+폰 탭 타깃, 세로 스크롤과 드래그 충돌 회피). 기본 0.9라 안 건드리면 기존 동작 그대로 |
| 유의어 연결은 엔트리 인덱스로 식별, 관계 시험은 별도 mode | 교재 번호 `no`는 손입력 null·중복 가능이라 유일 식별 불가 → 배열 인덱스로 (단어+뜻)을 잇고 저장 매칭은 `word`+`meaningIndex`. 관계 시험 결과는 `VocabQuizRecord{mode:"relation"}` 별도 저장이라 def→word 숙련도·오답노트·졸업에 안 섞인다(오프라인 eval이 반례로 잠금). `VocabRelated.source`로 사용자 연결분만 시험·해제 대상 |
| 유의어·반의어는 AI 추천에서 골라 신규 추가 | 처음엔 "단어장에 이미 있는 단어"만 연결하게 만들었는데, 그러면 그 유의어·반의어가 단어장에 없으면 고를 수조차 없었다. 그래서 호출 H(추천, harness §11)로 그 뜻에 맞는 실제 후보를 제시하고, 고르면 `/api/english/vocab/[id]/add-related`가 없는 단어면 `appendVocabEntry`→호출 D 자동 보강→연결, 있으면 연결만(중복 0). 보강 실패해도 단어·연결은 유지(연결은 AI 무관). 직접 입력도 병행 |
| 스트릭은 시험만, KST 고정 | "오늘 읽었어요"·생성 행위는 누르기만 하면 돼 기준이 느슨해진다 — 한 문항이라도 답한 시험 세션만 센다(§17-1). 하루의 경계는 기기 시간대가 아니라 KST(`+9h → getUTC*`, `lib/kst.ts` 단일 정의) — 서버·SSR·클라이언트가 항상 같은 날짜를 낸다 |
| 운동 스트릭은 "루틴을 지킨 날" | 운동한 날만 세면 계획된 휴식일마다 끊긴다 — 기록일(실패 포함) + 엔진이 정한 휴식·회복·마무리 휴식일 + 재측정한 날을 세고, 운동일을 건너뛰면 끊는다(§17-7). 일본어와 한 스트릭으로 합치지 않는다(운동만 한 날에 일본어가 이어져 보인다). 폰(<640px)에선 `이모지 (사람 이름) 🔥N일`만 — 트랙 이름·"오늘 아직"·라벨은 스크린리더 문구로만 남긴다(흐림이 신호) — 다 펼치면 530~700px라 390px 폰에서 운동 트랙이 화면 밖으로 밀렸다 |
| 해설 듣기는 탭 안에서 동기 시작 + 재사용 오디오 요소 | iOS Safari는 탭 밖에서 새 `Audio`를 재생하면 막는다 — 이어 읽기 큐는 오디오 요소 하나를 탭 안에서 무음으로 풀어 재사용하고, 다른 🔊를 누르면 옛 큐의 종료 통지가 새 재생보다 먼저 **동기적으로** 온다(UI가 멈춤/재생 상태를 헷갈리지 않게, §18-2). 잠금 화면 연속 재생은 보장하지 않는다 |
| 토익 AI 채점은 버튼, 요청은 60초 안으로 쪼갬 | 비용이 드는 경로를 자동으로 태우지 않는다 — 응시가 끝나도 채점은 결과 화면 버튼을 눌러야 돈다(문항당 전사 1 + 피드백 1, 피드백이 실패하면 전사문을 먼저 저장해 재시도 때 전사 비용을 두 번 내지 않는다). 프로덕션은 Hosting → Cloud Run 리라이트라 요청 시간 상한이 있어, 판독은 사진마다·발화 포인트는 7개씩·모의고사는 파트마다(최대 5) 호출을 나눠 **한 요청 안에서 병렬로** 부르고(요청 시간 ≈ 가장 느린 호출 하나), 사진은 한 장씩·채점은 문항마다 아예 **별개 요청**으로 보낸다 — 한 묶음이 실패해도 나머지는 산다 |
| 토익 스트릭은 별 트랙 + 폰 추가 압축 | 표현 시험(답한 문항 ≥1)·모의고사 응시(녹음된 문항 ≥1)만 세는 🎙️ 영어 트랙을 일본어·운동 사이에 둔다. 트랙이 셋이 되자 360px에서 넘쳐 폰에서는 🔥 뒤 "일"을 빼고(스크린리더엔 "N일 연속"), 세 자리 연속일부터는 사람 이모지 🧒·🧑를 숨긴다 — 이름은 남긴다(SPEC §17-8) |

## 6. 개발 하네스

이 저장소는 클로드 코드 하네스로 개발됩니다 — AI 호출 명세(프롬프트·스키마·검증·eval)는 과목별로 `docs/harness/english.md`(영어 북카드)·`docs/harness/math.md`(수학코치)·`docs/harness/japanese.md`(아빠의 일본어)·`docs/harness/toeic.md`(아빠의 영어 — 토익스피킹)에 있고(AI를 쓰지 않는 아빠의 운동은 `docs/SPEC.md` §19) 과목 공통 규약은 `docs/HARNESS.md`, 앱 전체 명세는 `docs/SPEC.md`, 에이전트·스킬 구성은 `.claude/`를 참조하세요.

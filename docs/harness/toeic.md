# AI 하네스 명세 — 아빠의 영어 (토익스피킹: 표현집 + 모의고사)

> 과목 공통 규약은 `docs/HARNESS.md`. 앱 전체 명세는 `docs/SPEC.md`(제품 수준 흐름은 §20). 이 문서는 **토익스피킹 과목의 AI 호출·데이터·저장·검증 명세**다.
> 영어 북카드(`docs/harness/english.md`)와 **언어는 같지만 학습자가 다르다** — 은우(초등학생)가 아니라 아빠(성인, 토익스피킹 수험자)다. 눈높이 규칙은 일본어(`docs/harness/japanese.md` §0-1)와 같은 쪽이다.

---

## 0. 배경과 설계 결정

### 0-1. 학습자는 아빠, 목표는 "말로 꺼내 쓰기"

- **성인 수험자 기준**이다. 영어 북카드·은우 단어장 프롬프트의 "초등학생·쉬운 말" 규칙을 가져오지 않는다. 목표 등급(IM3·IH·AL)에 맞는 문장을 그 수준 그대로 쓴다.
- **설명은 한국어, 학습 대상은 영어.** 뜻·해설·피드백은 한국어, 표현·예문·답변은 영어(해석을 나란히 붙인다).
- **단어 뜻을 아는 것이 목표가 아니라 시험 답변으로 말하는 것이 목표다.** 그래서 은우 단어장의 "영영 정의 + 이모지" 대신, 표현마다 **발화 포인트**(문항별 활용 문장·답변 틀·바꿔 쓰기·발음 팁·이어 말하기)를 붙인다(호출 B). 사용자 요구 원문: "단순 영영의미보다는 발화로 이어질 수 있는 포인트들을 카드에 많이 실어주면 좋겠어."
- **은우 화면과 섞지 않는다.** 경로·컬렉션·집계가 전부 분리된다(§7). 은우 영어 단어장(`vocabBooks`·`vocabQuizzes`)을 같이 쓰면 은우 스트릭·오답노트·기록이 오염된다(`app/api/streak/route.ts`, `app/english/vocab/wrong/page.tsx`).

### 0-2. 설계 결정 (2026-09-25)

사용자가 명시한 요구는 세 가지다 — ① 토익스피킹 문제 유형을 분석한 **모의시험** ② 표현모음집 **사진 업로드 → 은우 단어장과 같은 낭독·시험** ③ 교재 10쪽을 **미리 넣기**. 아래 표에서 "요구"는 사용자 원문에서 온 것이고, "기본값"은 사용자 확인 전에 정한 것이다. 기본값은 사용자가 바꾸면 이 표부터 고친다.

| 항목 | 결정 | 출처 | 근거 |
|---|---|---|---|
| 표현집 입력 | 교재 페이지 사진 → 판독(원문 전사) → 발화 포인트 보강 | 요구 | 은우 단어장의 사진 판독 관용구(`english.md` §7)를 성인·표현 구조로 새로 쓴다 |
| 카드 내용 | 교재 원문(표현·뜻·예문·해석) + **발화 포인트** | 요구 | 위 §0-1 |
| 낭독·시험 | 은우 단어장과 같은 축 — 🔊 낭독·속도·엔진 + 5지선다 시험·오답노트·기록. 여기에 **전체 듣기**와 **말하기(한→영) 시험**을 더한다 | 요구 + 기본값 | 표현집의 목적이 발화라 "보고 고르기"만으로는 부족하다 |
| **교재 내용의 저장소 반입** | **하지 않는다.** 교재 10쪽 전사본은 git 밖(`data/private/`, gitignore)에 두고 앱의 **"파일로 가져오기"**로 넣는다 | 기본값 | 이 저장소는 **PUBLIC**이다. 교재 사진·전사를 커밋하면 출판물이 공개된다. `public/*.json`은 PIN 게이트를 우회해 더 나쁘다(`proxy.ts` 정적 확장자 예외) |
| 모의고사 문항 | **AI가 새로 만든다**(호출 C). 기출·ETS 샘플 문항은 넣지 않는다 | 기본값 | 기출 저작권은 ETS에 있다(YBM 고지). 형식·시간만 맞춘다 |
| Q3–4 사진 | AI 이미지 생성(관문 P). 실패하면 장면 설명(`sceneKo`)으로 대신하고 "사진 다시 만들기" | 기본값 | 실제 시험은 사진을 보고 말한다. 텍스트만으로는 연습이 되지 않는다 |
| 녹음 | 모의고사·한 문제 연습 응시 녹음은 **서버(비공개 GCS 버킷)에 원본 그대로, 기간 제한 없이** 보관하고 결과 화면에서 비교한다(2026-10-03 사용자 결정 — §13). 기기 IndexedDB 사본은 업로드 대기열 + 빠른 재생 캐시다. 문서(Firestore)에는 녹음 메타만 | 요구 | Firestore 문서 1MiB라 오디오는 버킷에. 처음 설계(2026-09)는 "기기에만"이었다(원본 미저장 원칙 SPEC §13) — 학습자가 성인 본인이고 비교가 목적이라 이 녹음에 한해 바꿨다. 틀 테스트·마이크 점검 녹음은 여전히 보관하지 않는다 |
| AI 채점 | 응시 후 **버튼을 눌러야** 돈다(문항당 전사 1회 + 피드백 1회) | 기본값 | 비용이 드는 경로를 자동으로 태우지 않는다 |
| 목표 등급 | 모의고사를 만들 때 IM3 / **IH(기본)** / AL 중 고른다 — 모범답변의 길이·수준이 달라진다 | 기본값 | 모범답변이 너무 어렵거나 쉬우면 따라 말하기가 안 된다 |
| 스트릭 | 아빠 줄에 **"영어" 트랙**을 따로 둔다(표현 시험·모의고사 응시) | 기본값 | 트랙을 합치면 한쪽만 한 날도 이어져 보인다(SPEC §17-7 원칙) |

### 0-3. 이름·경로

앱에서는 **"아빠의 영어"**(부제 "토익스피킹"). 코드·경로는 `toeic`(`english`는 은우 북카드가 쓰고 있다). `/toeic`, `app/api/toeic/**`, `lib/ai/toeic/`, `scripts/eval-toeic.ts`. harness 절 참조 `HARNESS §N`이 `lib/ai/toeic/`·`app/api/toeic/`에 있으면 이 문서를 가리킨다.

### 0-4. 두 기능은 서로 독립이다

**표현집**과 **모의고사**는 한 과목 아래 나란히 선 별개 기능이다(일본어 §0-4와 같은 관계). 한쪽이 비어도 다른 쪽은 온전히 동작한다. 둘이 만나는 곳은 두 군데뿐이다.

1. 모의고사를 만들 때 표현집의 표현 일부를 **"활용할 표현"**으로 넘겨 모범답변에 녹인다(§4-0). 표현집이 비었으면 넘기지 않는다.
2. AI 피드백이 그 목록에서 "넣었으면 좋았을 표현"을 고른다(§5).

(2026-10-02 덧붙임) 모의고사는 유형별 공략(§12)의 **틀 은행**과도 만난다 — 파트마다 그 유형의 **답변 흐름**(단계마다 외울 틀)을 넘겨 모범답변을 틀로 조립하고, 피드백도 그 틀로 고쳐 준다(§12-13-3). 틀 은행이 없으면 넘기지 않고 지금처럼 만든다 — 한쪽이 비어도 다른 쪽이 온전히 도는 원칙은 그대로다.

---

## 1. 구성 개요

### 1-1. AI 호출

| 호출 | 이름 | 입력 | 출력 | temperature | 성격 |
|---|---|---|---|---|---|
| **A** | 표현집 판독 (vision) | 교재 페이지 사진 1장 | DAY·주제·표현 항목·QUIZ 원문 전사 | 0 | 판독 — 사진에 있는 것만, 창작 0 |
| **B** | 발화 포인트 | 표현 최대 7개(원문) | 표현마다 문항별 활용 문장·틀·바꿔 쓰기·발음·함정·문법·이어 말하기 | 0.5 | 창작(설명) |
| **C** | 모의고사 문항 생성 | 목표 등급 + 주제 힌트 + 활용할 표현 | 파트별 문항·모범답변 — 5개 파트 호출(C1~C5) | 0.8 | 창작(출제) |
| **D** | 답변 피드백 | 문항 자료 + 답변 전사문 | 점수·잘한 점·고칠 문장·빠진 내용·개선 답변 | 0.2 | 평가 |

**모델(2026-10-02 사용자 결정 — "토익스피킹 출제·채점만 `gpt-6.1-sol`, 나머지는 모두 `gpt-6-luna`")**: 출제·채점인 **C**(모의고사 문항 — 실전 모의고사·파트 다시 만들기·한 문제 연습이 모두 `generateMockPart`를 지난다)와 **D**(답변 피드백)는 env `OPENAI_TOEIC_MODEL`(빈 값·공백이면 `gpt-6.1-sol` — `lib/ai/toeic/model.ts` `resolveToeicModel`, `OPENAI_MODEL`로 폴백하지 않는다)이고, **A**(판독)·**B**(발화 포인트)는 메인 `OPENAI_MODEL`(빈 값이면 `gpt-6-luna`)이다. 모의고사 레코드의 `model`에는 출제 모델(`resolveToeicModel()`)을 남긴다. 두 기본 모델은 추론 계열로 보아 공유 래퍼가 첫 요청부터 표의 온도 값을 싣지 않는다(`docs/HARNESS.md` §1) — 그래서 이 모델들에는 위 표의 온도 다이얼이 적용되지 않는다.

**하네스 밖 관문 두 개**(Structured Outputs가 아니다 — TTS `lib/tts.ts`와 같은 부류. `callWithSchema`·zod·재요청을 거치지 않고 키 규약만 공유한다):

| 관문 | 이름 | 모듈 | 모델 env (빈 값이면 기본값) |
|---|---|---|---|
| **P** | Q3–4 사진 생성 | `lib/toeic-image.ts` (서버) | `OPENAI_IMAGE_MODEL` = `gpt-image-2`, `OPENAI_IMAGE_QUALITY` = `medium` |
| **T** | 답변 음성 전사 | `lib/toeic-transcribe.ts` (서버) | `OPENAI_TRANSCRIBE_MODEL` = `gpt-4o-mini-transcribe` |

- **시험(표현집)은 AI를 부르지 않는다**(§6). Q1–2(지문 읽기)의 채점도 AI가 아니라 **전사문 ↔ 지문 대조 순수 함수**다(§5-4) — 전사문으로는 발음·억양을 알 수 없으니 LLM에게 점수를 지어내게 하지 않는다.
- **요청 하나가 60초를 넘지 않게 쪼갠다.** 프로덕션은 Firebase Hosting → Cloud Run 리라이트라 요청 시간 상한이 있다. 그래서 호출 A는 사진마다, B는 7개씩, C는 파트마다(5개 병렬), P는 사진마다, 채점(T+D)은 문항마다 **별개 호출**이다. 한 묶음이 실패해도 나머지는 산다(부분 성공).
- **유형별 공략(§12, 2026-09-27)은 새 AI 호출이 없다.** 한 문제 연습은 호출 C 파트 하나(Q3–4는 관문 P 1장)를 입력만 바꿔 부르고(§12-7-7), 템플릿 테스트는 관문 T만 쓴다(문항마다 녹음만 보낸다 — 기대 문장은 보내지 않는다, §12-5-4). 공략·틀 은행 가져오기는 AI 0이다.
- **2026-10-02 — 호출 C·D가 "답변 흐름"을 받는다**(§12-13-3). 호출 수·JSON Schema·호출 옵션은 그대로이고, 원문 셋(§4-7 사용자 메시지 형식·§5-1 D 시스템 프롬프트·§5-2 D 사용자 메시지 형식)이 바뀌고 원문 하나(§4-1 둘째 블록 `TOEIC_MOCK_FLOW_RULES` — 흐름을 받은 파트만 과제 절 뒤에 붙는다)가 더해졌다(검토 반영 — 처음 안은 §4-1 머리말을 바꿨다). zod는 채우지 않은 틀 자리(`~`·`{`·`}`)만 새로 거부한다(§4-9·§5-3). 늘어나는 것은 입력 길이뿐이다. 같은 날 구현(T13~T15)과 통합 QA(P1·P2 0)를 마쳤다 — 구현이 정한 동작과 남은 틈은 §12-13-7. 틀 은행 쪽 화면(① 읽기 정렬·③ 👀 틀 시험)은 AI 0이다(발음만).

### 1-2. 파일 배치

```
docs/harness/toeic.md             ← 이 문서 (프롬프트·스키마 원문의 단일 정의처)
lib/ai/toeic/
  prompts.ts                      ← 호출 A·B·C1~C5·D 시스템/사용자 프롬프트 + 호출 옵션 + 사진 프롬프트 접미사
  schemas.ts                      ← JSON Schema(strict) + zod + 타입 + 상한 상수(단일 정의)
  extract-merge.ts                ← 판독 결과 DAY별 묶기·번호 병합 순수 함수
  points.ts                       ← 발화 포인트 병합("빈 자리만" / 강제 다시 만들기) 순수 함수
  guide-import.ts                 ← 유형별 공략 가져오기 계획·내용 지문·제자리 갱신 판정(서버 전용 — §12-2-5)
lib/toeic-quiz.ts                 ← 표현 시험 출제·보기·빈칸(순수, lib/ai 밖 — 클라이언트 import 가능)
lib/toeic-mock.ts                 ← 모의고사 형식표·단계 전이·지시문(순수)
lib/toeic-score.ts                ← Q1–2 대조·추정 점수·등급(순수)
lib/toeic-guide.ts                ← 유형별 공략 읽기 대본·TTS 정리·강조 분할(순수, 클라이언트 import 가능 — §12)
lib/toeic-drill.ts                ← 한 문제 연습 단위표·연습 파트 후처리·지시문 변형·연습 제목(순수 — §12)
lib/toeic-template.ts             ← 틀 채우기·표시 분할·따라 말하기 대본·전사 비교·틀 숙련도·연습 틀 고르기·답변 흐름(순수, 클라이언트 import 가능 — §12-5·§12-13)
lib/toeic-template-quiz.ts        ← ③ 틀 시험 출제·빈칸·고르기 통계(순수, 클라이언트 import 가능 — §12-13-2, 2026-10-02)
lib/toeic-guide-view.ts           ← 공략 폴더·읽기·템플릿 탭 화면 판단(순수 — §12-4·§12-5-1·§12-5-2)
lib/toeic-template-test-view.ts   ← 🧩 틀 테스트 화면 판단(순수 — §12-5-3)
lib/toeic-drill-view.ts           ← 한 문제 연습 탭·응시/결과 "뒤로"·🧩 틀 점검 자료(순수 — §12-7)
lib/toeic-firestore-codec.ts      ← 틀 은행 testFills(배열 속 배열)를 Firestore 본문에서 감싸고 푼다(import 0 — §12-3)
lib/media-session.ts              ← 잠금 화면 조작 관문(클라이언트, import 0 — 따라 말하기 플레이어만, §12-5-2)
lib/toeic-image.ts                ← 관문 P (서버 전용)
lib/toeic-transcribe.ts           ← 관문 T (서버 전용)
lib/toeic-*-contract.ts           ← 라우트↔화면 경계 타입(클라이언트 import 안전)
lib/toeic-record.ts               ← 렌더 가능 판정 단일 정의처
lib/mic-session.ts                ← 녹음(클라이언트 전용): 오디오 세션 전환·MediaRecorder·WAV 정규화
lib/toeic-rec-store.ts            ← 녹음 IndexedDB 보관 = 업로드 대기열 + 재생 캐시(클라이언트 전용, §13-3)
lib/toeic-rec-rules.ts            ← 녹음 서버 보관 판정 순수 함수(객체 키·바이트 판정·교체 판정·정규화·대기열 판정 — 클라이언트 import 안전, §13)
lib/toeic-rec-blob.ts             ← 녹음 보관소 두 벌(GCS 버킷 / 로컬 data/recordings — 서버 전용, 백엔드는 lib/store-backend 판정 하나)
lib/toeic-rec-upload.ts           ← 업로드 대기열 비우기(클라이언트 전용, 동시 1개·재시도 2·10·30초)
lib/toeic-compare.ts              ← 결과 화면 🎧 비교 판정 순수 함수(대상·다시 풀기 기록·점수 변화)
lib/store-backend.ts              ← 저장 백엔드 판정 단일 정의처(lib/store가 resolveStoreBackend로 다시 내보낸다)
app/toeic/**                      ← 화면
app/api/toeic/**                  ← 라우트
scripts/eval-toeic.ts             ← 오프라인 검증 + spec-sync + (게이트) 실호출 점검
scripts/eval-toeic-guides*.ts     ← 유형별 공략 eval 조각 넷(순수 층·앱 층·S2·S3 — eval-toeic.ts가 불러 한 번에 돈다, §12-10)
scripts/eval-toeic-recordings.ts  ← 내 녹음 서버 보관 + 비교 eval 12묶음(오프라인, GCS 0 — eval-toeic.ts가 runToeicRecordingChecks()로 부른다, §13-10)
scripts/eval-toeic-template-centric.ts ← 템플릿 중심 재정렬 eval(순수 층·레코드·가져오기·파일 저장소 왕복·라우트/앱 소스 대조·번들 경계·실제 파일 개수 — eval-toeic.ts가 runToeicTemplateCentricChecks()로 부른다, §12-13-5, 2026-10-02)
```

---

## 2. 호출 A — 표현집 판독 (vision)

### 2-0. 무엇을 판독하는가

토익스피킹 표현 암기장 한 페이지(예: 해커스 "토익스피킹 핵심 표현 암기장" — DAY 번호·주제, 번호 붙은 표현 14개, 하단 QUIZ 2문항). 표현 항목은 **영어 표현(형광펜) · 한국어 뜻 · 영어 예문 · 예문 해석**, QUIZ는 **우리말 문장 · 괄호 힌트 · 모범답변(표현 굵게)**이다. 다른 책은 예문이 없을 수 있으므로 예문·해석은 nullable이다.

- **사진 1장 = 호출 1회**, 여러 장이면 `Promise.allSettled`로 병렬(영어 단어장 판독 관용구). 전부 실패할 때만 500, 결과가 0개면 200 `{ok:false, reason:"retake"}`.
- 이미지 전달·크기는 은우 단어장과 같다 — 클라이언트 자르기·리사이즈(`lib/image-resize.ts`) → base64 data URL(`lib/upload-limits.ts`), 최대 8장.
- **원문 전사는 SPEC §1 "원문 전사 금지"의 예외**다(SPEC §14-2 단어장과 같은 근거 — 가족이 가진 교재를 학습용으로 옮긴다). 사진 원본은 저장하지 않는다.

### 2-1. 시스템 프롬프트 (원문 그대로 사용)

> 구현 시 `lib/ai/toeic/prompts.ts`의 `TOEIC_EXTRACT_SYSTEM_PROMPT`와 **바이트 단위로 일치**해야 한다(`scripts/eval-toeic.ts`의 `SPEC_SYNC_TARGETS`가 대조).

```
너는 토익스피킹 표현 암기장 페이지를 판독하는 조교다. 사진에 보이는 글자를 그대로 옮겨 적는다 — 고치거나 지어내지 않는다.

[페이지 구조]
- 한 페이지에는 보통 DAY 번호와 주제(예: "DAY 5 쇼핑"), 번호가 붙은 표현 항목들, 하단의 QUIZ(우리말을 영어로 말하기 + 모범답변)가 있다.
- 표현 항목 하나는 번호(01, 02 …), 영어 표현(형광펜으로 강조된 부분), 한국어 뜻, 영어 예문, 예문의 한국어 해석으로 이뤄진다.
- 책마다 구성이 조금 다를 수 있다. 예문이나 해석이 없는 항목은 그 필드를 null로 둔다.

[판독 규칙]
- 사진에 있는 글자만 옮긴다. 철자·문법이 틀려 보여도 고치지 않는다. 문장부호·대소문자·아포스트로피도 보이는 그대로 쓴다.
- expression에는 강조된 영어 표현 부분만 쓴다. meaningKo에는 표현 바로 옆의 한국어 뜻을 괄호 설명까지 그대로 쓴다(예: "(짐, 상자 등을) ~에 싣다").
- example에는 영어 예문 전체를, exampleKo에는 그 아래 한국어 해석 전체를 쓴다. 줄바꿈으로 끊긴 문장은 공백 하나로 이어 쓴다(줄 끝 하이픈으로 끊긴 단어는 하이픈 없이 잇는다).
- no에는 항목 앞 번호를 정수로 쓴다(01 → 1). 번호가 없으면 null.
- 사진 가장자리에서 잘린 항목은 보이는 부분만 쓰고 partial을 true로 둔다. 읽기 어려운 글자가 있으면 confidence를 낮춘다(high / medium / low).
- 종이 뒷면이 비쳐 보이는 흐린 글자는 판독하지 않는다. 이 페이지에 인쇄된 글자만 옮긴다.

[QUIZ]
- 하단 QUIZ의 각 문항마다 우리말 문장(promptKo), 괄호 속 힌트(hint — 괄호는 빼고 안의 내용만, 예: "분수대: fountain", 없으면 null), 그 문항의 모범답변 영어 문장(modelAnswer)을 짝지어 쓴다.
- keyExpressions에는 모범답변에서 굵게 강조된 표현이 이 페이지의 어느 표현 항목인지, 그 항목의 expression 문자열을 그대로 적는다. 없으면 빈 배열.
- QUIZ가 없으면 quiz는 빈 배열이다.

[페이지 정보]
- dayNo에는 DAY 번호를 정수로 쓴다(없으면 null). topicKo에는 DAY 옆 주제 글자를 그대로 쓴다(없으면 null).
- 표현 암기장 페이지가 아니면(다른 종류의 페이지나 사진) isExpressionPage를 false로 두고 entries와 quiz를 빈 배열로 둔다.

[금지]
- 사진에 없는 표현·예문·해석을 만들지 않는다. 뜻을 풀어 쓰거나 요약하지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 2-2. 사용자 메시지

사진마다 `[imagePart(dataUrl), textPart(아래 문장)]` 순서(이미지 먼저 — 영어 단어장 관용구).

```
이 페이지의 표현 항목과 QUIZ를 판독해줘.
```

호출 옵션: temperature 0, maxOutputTokens 12000, call 라벨 `toeic_extract`.

### 2-3. JSON Schema (strict)

HARNESS §1 규약: 전 필드 `required`, 모든 객체 `additionalProperties: false`, 선택 필드는 `["type","null"]`. **배열 개수 제약은 JSON Schema에 넣지 않는다**(프롬프트 + zod).

```json
{
  "name": "toeic_expr_extraction",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["isExpressionPage", "dayNo", "topicKo", "entries", "quiz"],
    "properties": {
      "isExpressionPage": { "type": "boolean" },
      "dayNo": { "type": ["integer", "null"] },
      "topicKo": { "type": ["string", "null"] },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["no", "expression", "meaningKo", "example", "exampleKo", "partial", "confidence"],
          "properties": {
            "no": { "type": ["integer", "null"] },
            "expression": { "type": "string" },
            "meaningKo": { "type": "string" },
            "example": { "type": ["string", "null"] },
            "exampleKo": { "type": ["string", "null"] },
            "partial": { "type": "boolean" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
          }
        }
      },
      "quiz": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["no", "promptKo", "hint", "modelAnswer", "keyExpressions"],
          "properties": {
            "no": { "type": ["integer", "null"] },
            "promptKo": { "type": "string" },
            "hint": { "type": ["string", "null"] },
            "modelAnswer": { "type": "string" },
            "keyExpressions": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  },
  "strict": true
}
```

### 2-4. zod + 병합 후처리

zod가 잡을 것(상한 상수는 `schemas.ts`에 한 번만 정의):

- `isExpressionPage=false`면 `entries`·`quiz`가 비어야 한다.
- `entries` 사진당 0~30개, 같은 사진 안에서 `no` 중복 금지(null은 중복으로 보지 않는다), `no`·`dayNo`는 1~999.
- `expression` 1~80자, 라틴 문자 포함, **한글 금지**. `meaningKo` 1~80자, **한글 포함** — 단 **`partial=true`(잘린) 항목은 빈 `meaningKo`를 받는다**. 뜻이 사진 밖에 있을 수 있는데 1자 이상을 강제하면 재요청이 모델에게 사진에 없는 뜻을 지어내라고 떠민다(§2-1 "보이는 부분만"과 충돌). 빈 뜻은 초안에 빈칸으로 남고 검토 화면에서 사람이 채운다. 비어 있지 않으면 규칙은 같다.
- `example`이 있으면 3~300자, 라틴 문자 포함, 한글 금지. `exampleKo`가 있으면 한글 포함. **`example`이 null이면 `exampleKo`도 null**.
- `quiz` 0~6개. `promptKo` 한글 포함, `modelAnswer` 라틴 포함·한글 금지, `hint`는 null 또는 1~60자.
- **판독 zod와 저장 zod는 다르다.** 판독은 사진에 있는 그대로를 받는 자리라 위 두 가지를 거부하지 않는다 — 잘린 항목의 빈 뜻, 같은 사진 안 표현 중복(검토 화면이 `findDuplicateExpressionIndexes`로 표시한다). 저장(`POST /api/toeic/sets`)과 가져오기(§7-6)는 뜻이 비었거나 세트 안에 같은 표현이 있으면 거부한다(§7-1).

코드 후처리(순수 함수, `lib/ai/toeic/extract-merge.ts`):

1. **공백 정리**: 모든 문자열의 연속 공백을 하나로, 앞뒤 공백 제거(판독이 줄바꿈을 흘린 경우 흡수).
2. **keyExpressions 정리**: 같은 **DAY 묶음**(후처리 3)의 병합된 `entries[].expression`과 대소문자·연속 공백 무시로 일치하는 것만 남기고 표기를 항목 쪽으로 맞춘다. 같은 표현이 두 번이면 한 번만 남긴다. 일치하지 않는 것은 **버린다**(거부 아님 — 교차 참조 실수로 재요청을 태우지 않는다). 대조 범위를 사진이 아니라 묶음으로 잡는 이유: 한 페이지를 두 장으로 나눠 찍으면 QUIZ와 그 표현이 서로 다른 사진에 있을 수 있다. 같은 사진에서 일치하는 것은 묶음에서도 일치하므로, 사진 단위 대조보다 버리는 것만 줄어든다. 저장 라우트도 같은 함수(`cleanKeyExpressions`)로 저장할 세트의 표현과 대조한다.
3. **DAY별 묶기**: `dayNo`가 같은 사진끼리 한 묶음(겹쳐 찍은 같은 페이지·두 장으로 나눠 찍은 한 페이지). `dayNo`가 null인 사진은 각자 한 묶음.
4. **묶음 안 병합**: 조인 키는 `no`, 없으면 `expression.toLowerCase()`. 대표본은 완전본(`partial=false`) → 내용이 긴 것 → 사진 번호가 낮은 것. `confidence`는 최고값, `partial`은 모든 멤버가 partial일 때만 true. `no` 오름차순 정렬, 빠진 번호(`missingNos`)를 보고한다. QUIZ도 같은 방식(키 `no`, 없으면 `promptKo`).
5. 결과는 **초안**(`ToeicSetDraft[]`)이다. 저장하지 않는다 — 사용자가 검토 화면에서 고친 뒤 저장한다(§8).

---

## 3. 호출 B — 발화 포인트

### 3-0. 무엇을 만드는가

표현마다 "이 표현을 시험 답변에서 어떻게 꺼내 쓰는가"를 카드에 싣는다. 필드와 쓰임:

| 필드 | 내용 | 화면·시험에서 |
|---|---|---|
| `exampleSpan` | 교재 예문 속 표현의 실제 구간(활용형 그대로) | 예문 하이라이트, **빈칸 시험**(§6)의 정답 |
| `coreKo` | 시험 어느 장면에서 점수가 되는지 한 줄 | 카드 머리말 |
| `useIn[]` | 문항(part)별 바로 말할 수 있는 영어 문장 + 해석, 2~3개 | 카드 본문·🔊, **말하기 시험**(§6)의 문제 |
| `frames[]` | `___` 자리가 있는 답변 틀 1~3개 | 카드 |
| `variations[]` | 바꿔 쓸 콜로케이션·확장형 2~4개 | 카드·🔊 |
| `pronunciationKo` | 연음·강세 팁 | 카드 |
| `pitfallKo` / `grammarKo` | 흔한 실수 / 문법 포인트(없으면 null) | 카드 |
| `followUp` | 답변 시간을 채우는 이어 말하기 한 문장 | 카드·🔊 |

- **7개씩 끊어 병렬 호출**한다(14개 한 번이면 출력이 길어 60초 상한에 가깝다). 한 묶음이 실패해도 나머지는 저장된다.
- **발화 포인트는 부수 효과다.** 판독 원문이 본체이고, 포인트가 비어 있어도(`points: null`) 카드·시험(뜻·표현 모드)은 동작한다. 저장 직후 자동으로 한 번 부르고(best-effort), 상세 화면에 "발화 포인트 만들기/다시 만들기"를 둔다.

### 3-1. 시스템 프롬프트 (원문 그대로 사용)

> 구현 시 `TOEIC_POINTS_SYSTEM_PROMPT`와 바이트 일치.

```
너는 한국인 성인 학습자의 TOEIC Speaking 고득점(IH~AL)을 돕는 전문 강사다. 표현 암기장의 표현마다, 그 표현을 실제 시험 답변으로 바로 꺼내 쓸 수 있게 해 주는 "발화 포인트"를 만든다. 학습자는 성인이다 — 아이 눈높이로 낮추지 않는다. 설명은 한국어로 짧고 실용적으로 쓰고, 영어는 시험 답변으로 그대로 말할 수 있는 자연스러운 구어체로 쓴다(과한 관용구나 속어는 쓰지 않는다).

[입력]
- 표현마다 index(목록 안의 위치), 영어 표현(expression), 한국어 뜻(meaningKo), 교재 예문(example)과 해석(exampleKo)을 받는다. 예문이 없으면 null이다.
- 받은 표현마다 정확히 하나의 결과를 같은 index로 낸다. 교재 원문은 고치지 않는다.

[TOEIC Speaking 문항]
- q1_2 지문 읽기: 광고·안내방송 지문을 소리 내어 읽는다.
- q3_4 사진 묘사(30초): 장소 → 중심 인물의 동작(현재진행형) → 주변 사람과 사물(There is ~, 상태를 나타내는 수동태) → 느낌 순서로 말한다. 위치 표현(On the left side of the picture, In the background 등)을 곁들인다.
- q5_7 듣고 답하기(15·15·30초): 지인 통화나 전화 설문에 1인칭으로 빈도·장소·동행·선호와 이유를 말한다.
- q8_10 정보 활용(15·15·30초): 일정표나 안내문을 보고 담당자로서 정보를 전달한다. 표의 표기를 사람이 주어인 문장으로 바꿔 말한다("You will ~", "We offer ~", "According to the schedule, ~", "I'm sorry, but ~").
- q11 의견 말하기(60초): 입장을 밝히고 이유와 경험 예시로 뒷받침한다("I think ~ because ~", "I agree that ~").

[표현마다 만들 것]
- exampleSpan: 교재 예문 안에서 이 표현이 실제로 쓰인 가장 짧은 연속 구간을 예문에서 그대로 복사한다(활용형과 사이에 낀 단어 포함). 예: 표현 "hang a poster", 예문 "A woman is hanging a poster on the wall, and ..." → "hanging a poster" / 표현 "covered with snow", 예문 "The roof of the cabin is covered with fresh snow." → "covered with fresh snow". 대소문자와 아포스트로피도 예문과 똑같이 쓴다. 예문이 null이면 null.
- coreKo: 이 표현이 시험의 어느 장면에서 점수가 되는지 한 줄(한국어, 70자 이내).
- useIn: 이 표현이 실제로 자연스럽게 쓰이는 문항 2~3개를 자주 쓰이는 순서로 고르고, 문항마다 그 답변에 그대로 말할 수 있는 영어 문장 하나(sentence, 6~32단어)와 자연스러운 해석(sentenceKo)을 쓴다. 문항(part)은 서로 달라야 한다. 문장에는 이 표현을 활용형으로 넣고, 교재 예문을 그대로 베끼지 않는다. 어울리지 않는 문항에 억지로 넣지 않는다(예: 사물 명사를 q11에 넣지 않는다). q1_2는 광고·안내방송 문체가 자연스러울 때만 고른다.
- frames: 이 표현을 끼워 넣는 재사용 가능한 답변 틀 1~3개. 표현이 들어갈 자리를 "___"로 표시한다(90자 이내). 예: "The man in the middle is ___.", "I think ___ because ___."
- variations: 바꿔 쓸 수 있는 콜로케이션·확장형·유사 표현 2~4개(en)와 그 뜻(ko).
- pronunciationKo: 연음·강세·발음 팁 한 줄(한국어, 110자 이내). 틀린 연음이나 강세를 지어내지 않는다.
- pitfallKo: 한국인이 이 표현에서 자주 틀리는 점(관사·전치사·시제·단복수·자동사와 타동사 등)이 실제로 있으면 한 줄(110자 이내), 없으면 null.
- grammarKo: 알아 두면 좋은 문법 포인트가 있으면 한 줄(110자 이내), 없으면 null.
- followUp: 이 표현으로 한 문장 말한 뒤 답변 시간을 채우는 이어 말하기 영어 문장 하나(en)와 해석(ko).

[금지]
- 교재의 표현과 예문을 고치거나 바꿔 쓰지 않는다. 받지 않은 표현을 추가하지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 3-2. 사용자 메시지

```
주제: {topicKo ?? "없음"}
표현 목록(JSON):
{JSON.stringify(chunk.map(e => ({ index, expression, meaningKo, example, exampleKo })))}
```

- `index`는 **세트 전체의 entries 배열 위치**다(묶음 안 위치가 아니다). 교재 번호(`no`)는 null일 수 있어 조인 키로 쓰지 않는다.
- 호출 옵션: temperature 0.5, maxOutputTokens 9000, call 라벨 `toeic_points`.

### 3-3. JSON Schema (strict)

```json
{
  "name": "toeic_speaking_points",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["index", "exampleSpan", "coreKo", "useIn", "frames", "variations", "pronunciationKo", "pitfallKo", "grammarKo", "followUp"],
          "properties": {
            "index": { "type": "integer" },
            "exampleSpan": { "type": ["string", "null"] },
            "coreKo": { "type": "string" },
            "useIn": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["part", "sentence", "sentenceKo"],
                "properties": {
                  "part": { "type": "string", "enum": ["q1_2", "q3_4", "q5_7", "q8_10", "q11"] },
                  "sentence": { "type": "string" },
                  "sentenceKo": { "type": "string" }
                }
              }
            },
            "frames": { "type": "array", "items": { "type": "string" } },
            "variations": {
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
            },
            "pronunciationKo": { "type": "string" },
            "pitfallKo": { "type": ["string", "null"] },
            "grammarKo": { "type": ["string", "null"] },
            "followUp": {
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
      }
    }
  },
  "strict": true
}
```

### 3-4. zod + 후처리

zod는 **입력 묶음을 알고 만든다**(`buildPointsZod(inputs)` — exampleSpan·index 대조에 입력이 필요하다):

- `items`의 `index` 집합이 입력 index 집합과 **정확히 같다**(누락·중복·모르는 index 거부 → 재요청 1회).
- `exampleSpan`: 입력 `example`이 null이면 null이어야 하고, 아니면 **`example`의 부분 문자열**(대소문자 구분)이어야 한다.
- `coreKo` 4~70자 한글 포함. `useIn` 2~3개, `part` 중복 금지, `sentence` 6~32단어·220자 이내·라틴 포함·한글 금지, 입력 `example`과 같으면 거부(대소문자·연속 공백 무시 — 대소문자만 바꾼 복사도 막는다), `sentenceKo` 한글 포함·160자 이내.
- `frames` 1~3개, 각 5~90자, **`___` 포함**. `variations` 2~4개, `en` 2~60자 한글 금지, `ko` 1~60자 한글 포함.
- `pronunciationKo` 6~110자. `pitfallKo`·`grammarKo`는 null 또는 4~110자. `followUp.en` 10~200자 한글 금지, `followUp.ko` 4~160자 한글 포함.

후처리(`lib/ai/toeic/points.ts`, 순수):

- **기본은 빈 자리만 채운다** — `points`가 null인 항목에만 넣는다. 사용자가 "다시 만들기"(`force`)를 누른 경우만 덮어쓴다. 포인트는 시험 채점 기준이 아니지만(숙련도는 `expression` 키로 센다, §6-2), 사용자가 보던 문장이 말없이 바뀌지 않게 한다.
- 묶음 호출이 재요청 뒤에도 실패하면 그 묶음의 항목은 null로 남기고 `remaining`으로 보고한다(부분 성공).
- `enriched = entries.every(e => e.points !== null)`.

---

## 4. 호출 C — 모의고사 문항 생성 (C1~C5)

### 4-0. 무엇을 만드는가

현행 TOEIC Speaking(2022-06 개정 이후) 11문항 한 세트를 **파트 5개 호출**로 나눠 만든다. 형식·시간은 §6-4 형식표가 단일 정의다.

| 호출 | 파트 | 문항 | 만드는 것 |
|---|---|---|---|
| C1 | `read` | Q1–2 지문 읽기 | 지문 2개 + 끊어 읽기 단위 + 강세 단어 + 발음 팁 |
| C2 | `picture` | Q3–4 사진 묘사 | 장면 2개(사진 생성 프롬프트·장면 설명) + 모범답변 + 묘사 포인트 |
| C3 | `respond` | Q5–7 듣고 답하기 | 상황 소개 + 질문 3개 + 모범답변·요령 |
| C4 | `info` | Q8–10 정보 활용 | 표(일정표 등) + 전화 건 사람 도입 + 질문 3개 + 모범답변·요령 |
| C5 | `opinion` | Q11 의견 말하기 | 질문 + 모범답변 + 답변 뼈대 |

- 5개를 `Promise.allSettled`로 **병렬** 호출한다. 실패한 파트는 null로 저장하고 "이 파트 다시 만들기"로 채운다(부분 성공). 사용자가 파트를 골라 만들 수도 있다(유형 연습).
- **입력 네 가지**(사용자 메시지): 목표 등급(IM3·IH·AL), 주제 힌트(표현집 세트의 `topicKo`들 + 사용자가 고른 주제), **활용할 표현**(표현집에서 최대 24개 — 숙련도가 낮은 것 우선, 없으면 무작위. 표현집이 비었으면 "없음"), **답변 흐름**(2026-10-02 — 그 파트 유형의 단계마다 외울 틀, `~` 표기. 틀 은행이 없거나 C1 `read`면 "없음" — 모양·만드는 법은 §12-13-3).
- **기출 금지**: 실제 기출·ETS 공식 샘플을 베끼지 않는다(저작권, §0-2). 형식과 난이도만 맞춘다.
- 공통 시스템 프롬프트 머리말(`TOEIC_MOCK_COMMON`)에 파트별 과제 절을 이어 붙여 **파트마다 완결된 시스템 프롬프트 5개**를 만든다. spec-sync 대상은 이어 붙인 결과가 아니라 **아래 코드블록 6개 각각**(머리말 1 + 파트 5)이고, 구현은 `TOEIC_MOCK_COMMON + "\n\n" + TOEIC_MOCK_<PART>_TASK`로 조립한다.
  - 2026-10-02(검토 반영): **답변 흐름을 받은 파트만** 과제 절 **뒤에** `"\n\n" + TOEIC_MOCK_FLOW_RULES`(§4-1 둘째 블록)를 더 붙인다 — `buildMockSystemPrompt(part, hasFlow)`. 흐름이 없으면(틀 은행 없음·C1 `read`·옛 문서의 다시 만들기) 붙이지 않으므로 시스템 프롬프트가 옛것과 **바이트까지 같다**. 흐름 규칙이 과제 절 뒤에 와야 과제 절의 따옴표 예시(§4-3 시작 문장·§4-5 연결어 등)보다 흐름의 틀이 앞선다는 것을 마지막 말로 둘 수 있다. spec-sync 대상 블록은 7개(머리말 1 + 파트 5 + 흐름 규칙 1)다.
- 호출 옵션: temperature 0.8, maxOutputTokens 6000, call 라벨 `toeic_mock_<part>`.

### 4-1. 공통 머리말 (원문 그대로 사용 — `TOEIC_MOCK_COMMON`)

```
너는 TOEIC Speaking 시험 형식을 잘 아는 문항 출제자다. 한국인 성인 수험자가 실전처럼 연습할 모의 문항을 새로 만든다.

[공통 규칙]
- 실제 기출 문항이나 ETS 공식 샘플 문항을 베끼거나 옮기지 않는다. 형식과 난이도만 맞추고 소재와 문장은 새로 쓴다.
- 영어는 북미 표준의 자연스러운 문장으로 쓴다. 회사·사람·장소 이름은 지어낸 것을 쓴다(실존 기업이나 유명인을 쓰지 않는다).
- 모범답변(sampleAnswer)은 받은 목표 등급(IM3 / IH / AL)의 수험자가 제한 시간 안에 실제로 말할 수 있는 길이와 수준으로 쓴다. 목표 등급이 높을수록 문장 연결과 어휘를 다양하게 한다.
- '활용할 표현' 목록을 받으면 모범답변에 그중 자연스럽게 어울리는 것만 쓴다(억지로 넣지 않는다). 쓴 표현은 usedExpressions에 원래 표현(expression — 목록의 문자열 그대로)과 모범답변 속 실제 구간(span — 모범답변에서 그대로 복사한 연속 구간)으로 적는다. 쓰지 않았으면 빈 배열이다.
- 한국어 설명은 짧고 실용적으로 쓴다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

- 2026-10-02 검토 반영으로 이 블록은 **옛 글자 그대로**다. 처음 개정안은 이 머리말 안에 `[답변 흐름 — 받았을 때만]` 절을 넣었는데, 머리말은 과제 절 **앞**에 붙으므로 과제 절의 따옴표 영어(§4-3 "This picture was taken ~", §4-5 "first, then, after that"·"You have to pay ~", §4-6 "For these reasons, ~")가 뒤에서 구체적으로 다른 글자를 시켜 흐름의 틀과 부딪혔다(모범답변의 첫 문장부터 "두 벌"이 될 위험). 그래서 그 절을 아래 둘째 블록으로 떼어 **과제 절 뒤에, 흐름이 있을 때만** 붙인다(§4-0). 이 머리말의 "목표 등급이 높을수록 … 다양하게"·"'활용할 표현' … 자연스럽게 어울리는 것만"은 흐름이 없을 때의 규칙이고, 흐름이 있으면 둘째 블록의 등급·활용할 표현 줄이 뒤에서 범위를 좁힌다.

**흐름 규칙 — 답변 흐름을 받은 파트만, 과제 절 뒤에 (원문 그대로 사용 — `TOEIC_MOCK_FLOW_RULES`)**

```
[답변 흐름]
- 사용자 메시지의 '답변 흐름'은 수험자가 미리 외워 둔 답변 틀이다. 번호 붙은 줄이 답변 순서의 단계이고, 단계마다 그 단계에서 쓰는 틀이 " / "로 적혀 있다. 틀의 ~는 바꿔 끼울 자리다. '소재 틀' 줄의 틀은 단계와 상관없이 내용이 맞을 때 쓴다.
- 모범답변은 이 틀로 조립한다. 단계 순서대로 말하고, 단계마다 그 단계의 틀 중 이 문항에 맞는 것을 골라 쓴다. 틀의 ~ 밖 글자는 한 글자도 바꾸지 않고 그대로 쓰고, ~ 자리만 장면·질문에 맞는 말로 채운다. ~를 채우지 않은 채 남기지 않는다.
- 맞는 틀이 없는 내용에서만 자유 문장을 쓴다. 틀과 같은 역할의 문장을 다른 말로 바꿔 쓰지 않는다.
- 이 문항에 필요 없는 단계는 건너뛴다(다른 문항 번호가 붙은 단계, 짧은 답에 필요 없는 단계).
- 위 과제 절의 답변 순서와 따옴표 친 영어(시작 문장·연결어·바꿔 말하기 예)는 답변 흐름이 없을 때의 예시다. 답변 순서는 흐름의 단계를 따르고, 흐름에 그 역할의 틀이 있으면 그 틀을 쓰며 예시 글자로 바꾸거나 섞지 않는다. 과제 절의 길이·문장 수 규칙과 그 밖의 내용 규칙은 그대로 지킨다.
- 목표 등급의 차이는 ~ 자리의 채움, 자유 문장, 문장 사이의 연결로 낸다. 틀의 ~ 밖 글자는 등급과 상관없이 그대로다.
- '활용할 표현'은 틀의 ~ 자리나 자유 문장 안에서만 쓴다. 틀이 있는 자리를 활용할 표현으로 바꾸지 않는다.
- 쓴 틀도 usedExpressions에 적는다 — expression은 답변 흐름에 적힌 틀 글자 그대로, span은 모범답변에서 그 틀로 말한 연속 구간이다.
```

- **2026-10-02 새 블록**(§12-13-3, 사용자 확정: "한 문제 연습과 모의고사는 가능한 템플릿 기반으로 답변하도록"). 조립: `buildMockSystemPrompt(part, hasFlow)` = `TOEIC_MOCK_COMMON + "\n\n" + TOEIC_MOCK_TASKS[part] + (hasFlow ? "\n\n" + TOEIC_MOCK_FLOW_RULES : "")`, `hasFlow` = 그 파트에 넘긴 `answerFlow !== null`(`generateMockPart`가 정한다 — `read`는 흐름이 늘 null). 바꾼 까닭:
  - 옛 경로(§12-7-9)는 틀을 "활용할 표현" 목록 앞에 섞어 넣고 "자연스럽게 어울리는 것만 쓴다(억지로 넣지 않는다)"에 맡겼다. 단계 구조가 입력에 없어 모범답변이 답변 흐름 순서를 따르는지, 단계마다 외운 틀을 쓰는지를 정할 수 없었다.
  - 틀은 "~ 밖 글자 그대로"여야 학습자가 외운 글자와 모범답변의 글자가 같아진다. 동의어 바꿔 쓰기를 막는 문장은 그래서 넣었다. "~를 채우지 않은 채 남기지 않는다"는 "글자 그대로"를 강하게 시키면 `~`까지 베낀 출력이 나올 수 있어서다 — zod도 거부한다(§4-9).
  - 과제 절 다섯 개(§4-2~§4-6 — 각자의 답변 순서·예시 표현이 있다)는 바꾸지 않았다(파트 블록 다섯을 고치면 spec-sync 대상이 다섯 더 흔들린다). 대신 이 블록이 과제 절 **뒤에** 와서 "따옴표 예시는 흐름이 없을 때의 예시"라고 마지막 말로 정한다. 흐름에 그 역할의 틀이 **없는** 자리(지어낸 예: 흐름에 "있다" 틀이 없으면 `There is ~`)는 예시를 그대로 참고한다 — 예시 낱말을 통째로 금지하지 않는다.
  - 등급 줄: 머리말의 "등급이 높을수록 어휘를 다양하게"가 AL에서 틀 글자를 바꾸는 근거가 되지 않게, 등급 차이를 낼 곳(자리 채움·자유 문장·연결)을 못 박았다.
  - 활용할 표현 줄: 실전 모의고사의 활용할 표현은 표현집 24개 그대로라, 표현집 표현이 문장 머리 틀 자리를 차지할 수 있었다. 흐름의 틀이 있는 자리에서는 틀이 이긴다.
  - 흐름이 없으면 이 블록이 붙지 않아 옛 동작과 같다(사용자 메시지의 `답변 흐름:` 줄은 `없음` — §4-7).
- 구현은 `lib/ai/toeic/prompts.ts`에 상수 `TOEIC_MOCK_FLOW_RULES`를 이 블록과 **같은 문자열**로 두고 `scripts/eval-toeic.ts`의 `SPEC_SYNC_TARGETS`에 등록한다(T15 — 원문 14 → 15). 등록 전에는 대조 대상이 아니라 FAIL이 생기지 않는다. 머리말 블록은 옛 글자라 지금 코드와 이미 같다.

### 4-2. C1 `read` — Q1–2 지문 읽기 (`TOEIC_MOCK_READ_TASK`)

```
[과제: Q1–2 지문 읽기]
- 소리 내어 읽을 지문 정확히 2개를 만든다. 두 지문은 종류(kind)가 달라야 한다 — advertisement(광고), announcement(공공장소 안내방송), news(라디오·뉴스 소식), introduction(행사·인물 소개), tour(투어 안내), voicemail(자동 응답 메시지) 중에서 고른다.
- 지문 하나는 80~110단어, 문장 4~7개로 쓴다. 실제 시험처럼 고유명사 1~2개, 숫자·시각·가격 중 하나 이상, 세 항목 이상의 나열(A, B, and C) 하나를 넣는다.
- chunks: 지문을 끊어 읽을 의미 단위(thought group)로 나눈 배열이다. chunks를 공백 하나로 이어 붙이면 text와 정확히 같아야 한다.
- stressWords: 강하게 읽어야 할 내용어 6~12개를 지문에 있는 형태 그대로 쓴다.
- tipsKo: 이 지문에서 주의할 발음·억양 팁 2~4개(한국어). 나열 억양(앞 항목은 올리고 마지막은 내린다), 고유명사와 숫자 읽기, 까다로운 단어의 발음 같은 것을 짚는다.
- 지문 읽기에는 모범답변과 활용할 표현을 쓰지 않는다.
```

### 4-3. C2 `picture` — Q3–4 사진 묘사 (`TOEIC_MOCK_PICTURE_TASK`)

```
[과제: Q3–4 사진 묘사]
- 묘사할 사진 장면 정확히 2개를 설계한다. 두 장면은 장소(place)가 달라야 한다(거리, 공원, 상점, 식당, 카페, 사무실, 회의실, 공항, 기차역, 호숫가 등). 주제 힌트를 받으면 그와 어울리는 장소를 먼저 고른다.
- 장면마다 성인이 2~5명 있고, 사람마다 동작과 옷차림이 분명하며, 배경과 주변 사물이 3개 이상 있다. 30초 동안 장소·인물·사물·느낌을 말할 거리가 충분해야 한다.
- imagePrompt: 이 장면을 사진으로 생성하기 위한 영어 프롬프트(60~120단어). 사람 수와 위치(왼쪽·가운데·오른쪽·배경), 각자의 동작과 옷 색, 주변 사물, 날씨와 빛을 구체적으로 적는다. 글자·간판 문구·로고·유명인·어린이는 넣지 않는다.
- sceneKo: 사진을 보여 줄 수 없을 때 대신 보여 줄 장면 설명(한국어 2~3문장).
- sampleAnswer: 30초 답변 모범답안(영어 5~7문장, 60~90단어). "This picture was taken ~"으로 장소를 말하고 → 중심 인물의 동작(현재진행형) → 주변 사람과 사물(위치 표현, There is ~, 상태를 나타내는 수동태) → 느낌이나 추측 순서로 말한다. imagePrompt에 적은 장면과 어긋나는 내용을 말하지 않는다.
- keyPointsKo: 이 사진에서 놓치지 말아야 할 묘사 포인트 3~5개(한국어).
```

### 4-4. C3 `respond` — Q5–7 듣고 답하기 (`TOEIC_MOCK_RESPOND_TASK`)

```
[과제: Q5–7 듣고 답하기]
- 상황 하나를 만든다: 마케팅 회사의 전화 설문에 응하는 상황, 또는 지인과 전화로 이야기하는 상황이다. 주제는 일상생활(쇼핑, 음식, 여가, 여행, 교통, 주거, 운동, 공부, 일 등)에서 고르고, 주제 힌트를 받으면 그중에서 고른다.
- topicKo: 이 상황의 주제를 한국어 한두 단어로 쓴다.
- intro: 상황 소개 영어 1~2문장이다("Imagine that ~" 형식, 문장은 새로 쓴다).
- questions: 정확히 3개. 첫째와 둘째(각 15초)는 빈도·시간·장소·동행 같은 사실형 질문이고, 둘 중 하나 이상은 두 부분짜리 질문(~, and ~?)이다. 셋째(30초)는 이유를 요구하는 선택·의견·묘사형 질문이다. 세 질문은 같은 주제로 이어진다.
- 질문마다 sampleAnswer: 첫째·둘째는 2~3문장(25~45단어), 셋째는 4~6문장(55~85단어). 질문의 시제를 따르고, 직답을 먼저 한 뒤 이유나 부연을 붙인다.
- 질문마다 tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-5. C4 `info` — Q8–10 정보 활용 (`TOEIC_MOCK_INFO_TASK`)

```
[과제: Q8–10 제공된 정보로 답하기]
- 표 하나를 만든다. 종류(kind)는 schedule(행사·컨퍼런스 일정), itinerary(출장·여행 일정), timetable(수업·워크숍 시간표), interview(면접 일정), resume(이력서) 중 하나다.
- 표는 제목(title), 날짜·장소·가격 같은 머리 정보(meta, 1~4줄), 행(rows, 5~9개 — left에는 시간·기간·항목, right에는 내용), 각주(notes, 0~2줄, 예: "* Lunch is not included.")로 구성한다.
- callerIntro: 이 표에 대해 전화를 건 사람의 도입 발화다(영어 1~2문장, 이름과 용건).
- questions: 정확히 3개, 전화 건 사람이 묻는 질문이다. 첫째(15초)는 시간·장소·가격 같은 세부 정보, 둘째(15초)는 전화 건 사람이 잘못 알고 있는 정보를 확인하고 정정하게 하는 질문, 셋째(30초)는 조건에 맞는 항목 둘 이상을 모두 말하게 하는 질문이다. 답은 반드시 표 안에서 찾을 수 있어야 한다.
- 질문마다 sampleAnswer: 담당자로서 표의 표기를 사람이 주어인 문장으로 바꿔 말한다(예: "Fee: $10" → "You have to pay 10 dollars."). 첫째·둘째는 1~3문장, 셋째는 시간 순서 연결어(first, then, after that)로 3~5문장이다.
- 질문마다 tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-6. C5 `opinion` — Q11 의견 말하기 (`TOEIC_MOCK_OPINION_TASK`)

```
[과제: Q11 의견 말하기]
- 의견 질문 하나를 만든다. 형식(kind)은 agree(찬반 — Do you agree or disagree with the following statement?), choice(둘 중 선택), proscons(장단점) 중 하나다. 직장, 교육, 기술, 생활 방식처럼 성인이 경험으로 답할 수 있는 주제로 쓰고, 끝에 이유와 예를 들어 답하라는 요구 문장을 붙인다.
- sampleAnswer: 60초 답변 모범답안(영어 110~150단어). 입장 → 첫째 이유와 개인 경험 예시 → 둘째 이유 → "For these reasons, ~" 마무리 순서다. 처음부터 끝까지 한 입장을 유지한다.
- outlineKo: 답변 뼈대(한국어) 3~5줄 — 입장, 이유 1, 예시, 이유 2, 마무리.
- tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-7. 사용자 메시지 (C1~C5 공통)

```
목표 등급: {IM3|IH|AL}
주제 힌트: {topicHints를 ", "로, 없으면 "없음"}
활용할 표현: {expressions를 " / "로, 없으면 "없음"}
답변 흐름:
{answerFlow를 단계마다 한 줄로, 없으면 "없음"}
```

- **2026-10-02 변경 — 마지막 두 줄(`답변 흐름:` + 자리)을 더했다**(§12-13-3). 앞 세 줄은 그대로다. 흐름은 여러 줄이라 호출 D의 `수험자가 본 자료:` 줄(§5-2)처럼 머리 줄 아래에 둔다. 구현은 `TOEIC_MOCK_USER_TEMPLATE`을 같은 문자열로 바꾸고, 플레이스홀더 표 `TOEIC_MOCK_PLACEHOLDERS`에 `answerFlow`(위 자리 글자 그대로)를 더한다(T15 — 그 전까지 spec-sync FAIL).
- 자리 값은 순수 함수 `formatAnswerFlow(flow)`(`lib/ai/toeic/prompts.ts`)가 만든다 — 호출 D(§5-2)도 같은 함수를 쓴다. 흐름이 `없음`이면 시스템 프롬프트에 흐름 규칙 블록이 붙지 않으므로(§4-0, 검토 반영) 옛 요청과 다른 곳은 이 사용자 메시지의 끝 두 줄(`답변 흐름:` / `없음`)뿐이다.
  - 흐름이 null이거나 단계·소재 틀이 모두 비었으면 `없음`.
  - 단계마다 한 줄 `{번호}. {단계 이름}: {틀} / {틀} …`. 틀이 없는 단계는 줄을 내지 않고, 번호는 낸 줄끼리 1부터 잇는다(흐름에서 빈 단계는 `buildAnswerFlow`가 이미 뺀다 — §12-13-3). 틀 글자는 `frameToExpression`의 `~` 형태(§12-5-7)이고 `/`가 없다(틀 zod — 자리 밖 `/` 거부)라 `" / "` 경계가 흐리지 않다.
  - 소재 틀이 있으면 마지막 줄 `소재 틀: {틀} / …`.
  - 줄은 `\n`으로 잇는다. 지어낸 예(모양만 — 실제 값은 런타임에 틀 은행에서 읽는다):

```text
1. 장면 열기: The scene is set on ~
2. 눈에 띄는 것: Two cooks are ~ / ~ is placed next to ~
3. 인상: It looks like ~
소재 틀: ~ helps me ~
```

### 4-8. JSON Schema (strict) — 파트별 5개

usedExpressions 항목 모양은 파트 공통이다: `{ "expression": string, "span": string }`.

```json
{
  "name": "toeic_mock_read",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "text", "chunks", "stressWords", "tipsKo"],
          "properties": {
            "kind": { "type": "string", "enum": ["advertisement", "announcement", "news", "introduction", "tour", "voicemail"] },
            "text": { "type": "string" },
            "chunks": { "type": "array", "items": { "type": "string" } },
            "stressWords": { "type": "array", "items": { "type": "string" } },
            "tipsKo": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_picture",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["place", "imagePrompt", "sceneKo", "sampleAnswer", "keyPointsKo", "usedExpressions"],
          "properties": {
            "place": { "type": "string" },
            "imagePrompt": { "type": "string" },
            "sceneKo": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "keyPointsKo": { "type": "array", "items": { "type": "string" } },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_respond",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["topicKo", "intro", "questions"],
    "properties": {
      "topicKo": { "type": "string" },
      "intro": { "type": "string" },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["question", "sampleAnswer", "tipKo", "usedExpressions"],
          "properties": {
            "question": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "tipKo": { "type": "string" },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_info",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["table", "callerIntro", "questions"],
    "properties": {
      "table": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "title", "meta", "rows", "notes"],
        "properties": {
          "kind": { "type": "string", "enum": ["schedule", "itinerary", "timetable", "interview", "resume"] },
          "title": { "type": "string" },
          "meta": { "type": "array", "items": { "type": "string" } },
          "rows": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["left", "right"],
              "properties": {
                "left": { "type": "string" },
                "right": { "type": "string" }
              }
            }
          },
          "notes": { "type": "array", "items": { "type": "string" } }
        }
      },
      "callerIntro": { "type": "string" },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["question", "sampleAnswer", "tipKo", "usedExpressions"],
          "properties": {
            "question": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "tipKo": { "type": "string" },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_opinion",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "question", "sampleAnswer", "outlineKo", "tipKo", "usedExpressions"],
    "properties": {
      "kind": { "type": "string", "enum": ["agree", "choice", "proscons"] },
      "question": { "type": "string" },
      "sampleAnswer": { "type": "string" },
      "outlineKo": { "type": "array", "items": { "type": "string" } },
      "tipKo": { "type": "string" },
      "usedExpressions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["expression", "span"],
          "properties": {
            "expression": { "type": "string" },
            "span": { "type": "string" }
          }
        }
      }
    }
  },
  "strict": true
}
```

### 4-9. zod + 후처리

zod는 **프롬프트보다 넓은 폭**으로 건다(프롬프트 "80~110단어"를 zod가 60~130으로 받는 식 — 경계에서 재요청을 태우지 않되, 크게 벗어난 것만 거부). 폭은 `schemas.ts`에 상수로 한 번만 정의한다.

- 공통: 영어 필드는 라틴 포함·한글 금지, `…Ko` 필드는 한글 포함. `usedExpressions`: `expression`이 입력 목록에 대소문자 무시로 있어야 하고, `span`이 그 `sampleAnswer`의 부분 문자열(대소문자 무시)이어야 한다 — **어긋난 항목은 후처리에서 버린다**(거부 아님). 2026-10-02부터 "입력 목록"은 활용할 표현 **∪ 그 파트에 보낸 답변 흐름의 틀 글자**다(`toMockRecordPart`의 셋째 인자 — §12-13-3). 모범답변이 틀을 몇 개·어떤 순서로 썼는지는 zod로 거부하지 않는다(재요청 없음 — 측정만, §12-13-3). 다만 **채우지 않은 틀 자리는 거부한다**(2026-10-02 검토 반영): C2~C5의 `sampleAnswer`에 `~`·`～`·`〜`·`{`·`}` 중 하나라도 있으면 거부(기존 1회 재요청 — 위반일 때만 비용). 틀 조립 준수(몇 개·어느 단계)와 달리 이것은 말할 수 없는 깨진 출력이고, "~ 밖 글자 그대로"를 강하게 시키면 `~`까지 베낄 수 있다. 판정 함수 `hasUnfilledSlot(text)`(`lib/ai/toeic/schemas.ts`)를 호출 D(§5-3)와 함께 쓴다. C1 `read`의 `text`·`chunks`는 걸지 않는다(흐름이 없고 지문 글이다).
- C1: `items` 정확히 2, `kind` 서로 다름, `text` 60~130단어, **`chunks.join(" ")` = `text`**(연속 공백을 하나로 접은 뒤 비교 — 어긋나면 거부), `stressWords` 4~14개·각각 `text`에 단어 경계로 존재(대소문자 무시 — 문장 첫머리 대문자 형태도 같은 단어), `tipsKo` 2~4.
- C2: `items` 정확히 2, `place` 서로 다름(대소문자·연속 공백 무시)·1~60자(언어는 정하지 않는다 — 프롬프트 예시가 한국어라 영어를 강제하지 않는다), `imagePrompt` 40~160단어, `sceneKo` 한글, `sampleAnswer` 40~110단어, `keyPointsKo` 3~5.
- C3: `questions` 정확히 3, 첫째·둘째 `sampleAnswer` 15~60단어, 셋째 35~110단어, 질문은 `?`로 끝남.
- C4: `rows` 4~10, `meta` 1~4, `notes` 0~3, `questions` 정확히 3, 첫째·둘째 `sampleAnswer` 5~60단어, 셋째 25~110단어. **표 칸(`meta`·`rows.left`·`rows.right`·`notes`)은 "비어 있지 않음 + 한글 금지"만 본다** — 시간(`9:00 – 9:30`)·가격(`$45`) 칸에는 라틴 글자가 없을 수 있어서, 공통 규칙("라틴 포함")을 걸면 정상 출력이 재요청을 태운다. `title`·`callerIntro`·질문·모범답변은 공통 규칙 그대로다.
- C5: `sampleAnswer` 80~180단어, `outlineKo` 3~5.
- 후처리: `usedExpressions` 정리(위) → 파트 결과를 `ToeicMockRecord.parts.<part>`로 옮긴다. C2는 `items[i].image = { status: "pending", imageId: null }`를 붙여 저장한다(관문 P가 채운다, §4-10).

### 4-10. 관문 P — Q3–4 사진 생성 (하네스 밖)

- `POST /api/toeic/mocks/[id]/image {slot: 0|1}` → `lib/toeic-image.ts`의 `generateSceneImage(prompt, signal)`. **사진 한 장 = 요청 하나**(60초 상한).
- 프롬프트 = C2 `imagePrompt`(앞뒤 공백 제거) + 공백 하나 + 아래 고정 접미사를 한 문단으로(`buildSceneImagePrompt` — 원문 그대로 `TOEIC_IMAGE_PROMPT_SUFFIX`, spec-sync 대상):

```
A realistic candid photograph for an English speaking test picture-description task. Natural colors and lighting, everyday adults, clear actions. No text, no signs with words, no logos, no watermarks, no children.
```

- 파라미터: 모델 `OPENAI_IMAGE_MODEL`(빈 값이면 `gpt-image-2`), 크기 1536×1024(가로), 품질 `OPENAI_IMAGE_QUALITY`(빈 값이면 `medium`), 출력 JPEG 압축 70. 결과 data URL이 **900,000자를 넘으면** 압축 50으로 1회 재생성, 그래도 넘으면 실패로 본다(Firestore 문서 1MB).
- 저장: `toeicImages` 컬렉션에 한 장 = 문서 하나(§7-4), 모의고사의 `picture.items[slot].image = {status:"ready", imageId}`. 실패하면 `{status:"failed"}` — 화면은 `sceneKo`를 대신 보여 주고 "사진 다시 만들기"를 띄운다.
- 응답을 못 받고 끊겨도(상한 초과) 서버는 끝까지 저장한다. 화면은 실패를 받으면 **한 번 새로 읽어 이미 저장됐는지 확인**한 뒤에만 실패로 표시한다.
- 키가 없으면 501. 사진은 `GET /api/toeic/images/[id]`로 내려준다(PIN 게이트 안, `cache-control: private`).

---

## 5. 호출 D — 답변 피드백 (+ 관문 T 전사, Q1–2 대조)

### 5-0. 흐름

응시가 끝나면 녹음은 기기(IndexedDB)와 서버(GCS 비공개 버킷 — 응시 중 문항마다 올린다, §13)에 있다. 다른 기기에서는 서버 사본을 내려받아 같은 정규화를 거쳐 채점한다(채점 라우트 계약은 그대로다 — §13-8). 사용자가 **"AI 채점 받기"**를 누르면 문항마다(동시 2개):

1. 클라이언트가 녹음을 **16kHz mono 16-bit WAV로 정규화**(`lib/mic-session.ts`) — iOS Safari의 `audio/mp4`가 전사 API에서 형식 오류·잘림을 내는 보고가 반복돼, 서버에 ffmpeg가 없는 이 배포에서는 클라이언트 정규화가 안전하다. 디코드에 실패하면 원본을 그대로 올린다.
2. `POST /api/toeic/attempts/[id]/score` (multipart: `q`, `audio`) → 관문 T 전사(`language: "en"`, **기대 문장을 prompt로 넣지 않는다** — 전사가 모범답변 쪽으로 끌려가 점수가 부풀려진다).
3. 전사문 단어가 2개 미만이면 **호출 D 없이** 0점 "답변이 인식되지 않았어요"로 저장(무응답 기준 — 비용 절약).
4. Q1–2 → §5-4 대조(순수 함수). Q3–11 → 호출 D.
5. 결과를 응시 기록의 그 문항에 저장하고 돌려준다.

- 호출 D가 재요청 뒤에도 실패하면 **전사문은 먼저 저장**하고(점수 null) 실패를 알린다. 다시 누르면 전사 없이 저장된 전사문으로 호출 D만 한다 — 응시가 끝난 뒤 녹음은 바뀌지 않으므로 이미 낸 전사 비용을 두 번 내지 않는다. 이미 점수가 있는 문항은 AI를 부르지 않고 저장된 답을 돌려준다.

### 5-1. 시스템 프롬프트 (원문 그대로 사용 — `TOEIC_FEEDBACK_SYSTEM_PROMPT`)

```
너는 ETS TOEIC Speaking 채점 기준을 잘 아는 채점관 겸 코치다. 한국인 성인 수험자의 답변 전사문을 받아 공식 기준에 맞춰 점수를 매기고, 다음 답변을 더 잘하게 만드는 피드백을 한국어로 준다.

[입력]
- 문항 번호와 유형, 만점, 답변 시간, 수험자가 본 자료(질문·표·사진 설명), 참고용 모범답변, 활용할 표현 목록, 답변 흐름, 그리고 음성 인식으로 얻은 답변 전사문을 받는다.
- 전사문은 음성 인식 결과라 발음과 억양을 알 수 없고 인식 오류가 섞여 있을 수 있다. 발음과 억양은 평가하지 않는다. 인식 오류로 보이는 단어는 감점하지 말고 문맥으로 해석한다.
- 모범답변은 참고용이다. 모범답변과 다르다는 이유로 감점하지 않는다.
- 답변 흐름은 수험자가 미리 외워 둔 답변 틀이다. 번호 붙은 줄이 단계이고, 단계마다 틀이 " / "로 적혀 있으며 ~는 바꿔 끼울 자리다. '소재 틀'은 내용이 맞을 때 쓰는 틀이다. "없음"이면 이 입력은 없다. 답변 흐름은 피드백에만 쓴다 — 틀을 쓰지 않았다는 이유로 감점하지 않는다.

[채점]
- Q3–4(0~3): 사진의 주요 특징을 묘사했는가, 어휘와 문장 구조가 적절하고 생각이 이어지는가.
- Q5–7(0~3): 질문에 맞는 완전하고 적절한 답인가(관련성·완성도), 그리고 문법·어휘·일관성.
- Q8–10(0~3): 위 기준에 더해 표의 정보를 정확히 전달했는가, 표의 표기를 말하는 문장으로 바꿔 말했는가.
- Q11(0~5): 입장이 분명한가, 이유·세부·예시로 뒷받침했는가, 생각 사이의 관계가 분명한가, 그리고 문법·어휘. 이유 하나에 부연이 거의 없으면 3점 수준, 질문을 되읽거나 단어만 나열하면 1점 수준이다.
- 무응답이거나 영어가 아니거나 과제와 무관하면 0점이다.
- 제한 시간에 비해 답이 너무 짧으면 완성도에서 깎는다.

[피드백]
- summaryKo: 총평 1~2문장(한국어).
- strengths: 잘한 점 1~3개(한국어, 구체적으로).
- fixes: 고칠 문장 0~5개. said에는 전사문에서 그대로 복사한 구간을, better에는 같은 뜻의 올바르고 자연스러운 영어를, whyKo에는 이유 한 줄(문법·어휘·어색함·내용)을 쓴다. 인식 오류로 보이는 것은 고치지 않는다. 답변 흐름을 받았고 said가 어떤 틀과 같은 역할의 문장이면, better는 그 틀의 ~ 밖 글자를 그대로 쓰고 ~ 자리만 수험자의 내용으로 채운 문장으로 쓰고, whyKo에 외운 틀로 말하라는 뜻을 적는다.
- missingKo: 내용상 빠진 것 0~3개(한국어, 예: "정정 정보(시작 시간 변경)를 말하지 않음").
- improvedAnswer: 수험자의 답변 내용을 살려 제한 시간 안에 말할 수 있게 고쳐 쓴 더 나은 답변(영어). 모범답변을 베끼지 않는다. 답변 흐름을 받았으면 이 문항에 필요한 단계만 단계 순서대로 쓴다(다른 문항 번호가 붙은 단계와 이 답변 시간에 필요 없는 단계는 건너뛴다). 쓰는 단계마다 맞는 틀을 ~ 밖 글자 그대로 쓰고 ~ 자리만 수험자의 답이나 수험자가 본 자료에 있는 내용으로 채워 조립한다. 채울 내용이 없는 틀은 쓰지 않는다(~를 그대로 남기지 않는다). 맞는 틀이 없는 내용에서만 자유 문장을 쓴다.
- tryExpressions: 받은 활용할 표현 목록과, 답변 흐름의 틀 중 이 문항의 단계에 맞는 것에서 이 답변에 넣었으면 좋았을 것 0~3개(적힌 문자열 그대로).

[금지]
- 전사문에 없는 말을 수험자가 했다고 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

- **2026-10-02 변경**(§12-13-3, 사용자 확정: "AI 피드백도 틀로 고쳐 주는 쪽") — 네 곳을 바꿨다. ① `[입력]` 첫 줄에 "답변 흐름"을 넣고 ② 답변 흐름을 설명하는 줄을 더했다(감점 근거가 아니라는 문장 포함) ③ `fixes`·`improvedAnswer`에 "답변 흐름을 받았으면 틀로" 문장을 더했다 ④ `tryExpressions`의 고르는 곳을 "활용할 표현 목록과 답변 흐름의 틀"로, 끝 괄호를 "적힌 문자열 그대로"로 바꿨다. `[채점]`·`[금지]`와 나머지 글자는 그대로다. 바꾼 까닭:
  - 옛 피드백은 개선 답변을 "수험자의 내용을 살려" 자유롭게 고쳐 썼다 — 외운 틀과 다른 문장을 새로 외우게 만든다. 학습 목표가 "연습한 틀대로 망설임 없이"라 고쳐 주는 문장도 그 틀이어야 한다.
  - 채점은 ETS 기준 그대로여야 한다. 그래서 "틀을 쓰지 않았다는 이유로 감점하지 않는다"를 입력 절에 못 박았다(점수가 틀 사용률이 되면 추정 등급이 거짓이 된다).
  - `said`는 여전히 전사문 단어열 안이어야 한다(zod `buildFeedbackZod` 그대로 — 환각 차단). 틀로 고치라는 지시가 하지 않은 말을 고친 것처럼 만들지 않게.
- **2026-10-02 검토 반영 — `improvedAnswer`·`tryExpressions`에 단계 건너뛰기를 더했다**(같은 날, T15가 spec-sync로 굳히기 전). D는 문항 **하나**를 채점하지만 받는 흐름은 **파트 전체**다(`buildFeedbackInput` — Q5–7·Q8–10은 세 문항이 같은 흐름). 실제 흐름에서 Q8–10은 4단계 중 3단계, Q11은 5단계 중 2단계의 이름에 문항 번호가 들어 있다(2026-10-02 원본, 개수만). 옛 문장("단계 순서대로, 단계마다 맞는 틀을 … 조립")대로면 Q8(15초) 개선 답변이 Q9·Q10 단계 틀까지 끌어오고, Q5(15초) 개선 답변이 네 단계를 다 밟아 시간을 넘긴다 — 학습자는 15초 안에 말할 수 없는 틀 조합을 외우게 된다. 호출 C(§4-1 흐름 규칙)에는 처음부터 있던 건너뛰기 문장을 D에도 같은 뜻으로 넣었다.
  - `~` 채움의 출처를 "수험자의 답이나 수험자가 본 자료"로 못 박고 "채울 내용이 없는 틀은 쓰지 않는다"를 더했다 — 다른 문항 단계의 틀을 끌어오면 채울 내용이 없어 `~`가 남거나 지어낸 내용이 들어간다. zod도 `~`·`{`·`}`를 거부한다(§5-3).
  - 검토 하나는 "수험자 답에 내용이 없는 단계는 건너뛴다 · 수험자가 하지 않은 내용을 지어내지 않는다"도 권했다. **넣지 않았다** — Q8–10의 정정·나열 문항은 수험자가 빠뜨린 표의 정보를 개선 답변에 넣는 것이 고쳐 주기의 본체인데, 그 문장은 그것까지 막는다. 대신 채움의 출처를 "답 또는 본 자료"로 좁혀 지어내기를 막는다(prompt-tuner 확인 대상 — §12-12 25와 함께 실호출 점검에서 본다).
- 구현(`TOEIC_FEEDBACK_SYSTEM_PROMPT`)은 같은 문자열로 함께 바꾼다(T15 — 그 전까지 spec-sync FAIL).

### 5-2. 사용자 메시지

```
문항: Q{n} ({유형 이름}) · 답변 시간 {초}초 · 만점 {3|5}
수험자가 본 자료:
{material}
모범답변(참고용):
{sampleAnswer}
활용할 표현: {목록을 " / "로, 없으면 "없음"}
답변 흐름:
{answerFlow를 단계마다 한 줄로, 없으면 "없음"}
답변 전사문:
{transcript}
```

- **2026-10-02 변경 — `답변 흐름:` 두 줄을 `활용할 표현` 줄과 `답변 전사문:` 줄 사이에 더했다**(§12-13-3). 나머지는 그대로다. 자리 값은 호출 C와 같은 `formatAnswerFlow`(§4-7)가 만들고, 흐름은 **그 문항 파트로 모의고사를 만들 때 보낸 것**(레코드 `answerFlows` — §7-2)이다. 옛 문서·틀 은행이 없던 문서·C1은 `없음`이다. 구현은 `TOEIC_FEEDBACK_USER_TEMPLATE`을 같은 문자열로, `TOEIC_FEEDBACK_PLACEHOLDERS`에 `answerFlow`를 더한다(T15).

`material`은 파트별로 코드가 만든다(순수 함수 `buildFeedbackMaterial`): Q3–4 = `sceneKo` + `keyPointsKo`, Q5–7 = `intro` + 그 질문, Q8–10 = 표 텍스트(제목·meta·rows "left — right"·notes) + `callerIntro` + 그 질문, Q11 = 질문. 호출 옵션: temperature 0.2, maxOutputTokens 2500, call 라벨 `toeic_feedback`.

- `material` 서식: 줄마다 한 가지를 쓰고 줄바꿈으로 잇는다. 라벨은 한국어다.
  - Q3–4: `사진 설명: {sceneKo}` → `묘사 포인트:` → 포인트마다 `- {keyPointsKo}`
  - Q5–7: `상황: {intro}` → `질문: {그 질문}`
  - Q8–10: `표: {title}` → meta 한 줄씩 → rows 한 줄씩 `{left} — {right}` → notes 한 줄씩 → `전화 건 사람: {callerIntro}` → `질문: {그 질문}`
  - Q11: `질문: {question}`
- Q1–2이거나 그 파트·문항이 레코드에 없으면 `material`은 null이고 호출 D를 부르지 않는다(Q1–2는 §5-4 대조). 모범답변은 그 문항의 `sampleAnswer`, 활용할 표현은 레코드의 `expressionsUsed` 그대로다(`buildFeedbackInput`). 답변 흐름은 레코드 `answerFlows`에서 그 문항 파트의 것(없으면 null — 2026-10-02, §12-13-3)이다.

### 5-3. JSON Schema (strict)

```json
{
  "name": "toeic_answer_feedback",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["score", "summaryKo", "strengths", "fixes", "missingKo", "improvedAnswer", "tryExpressions"],
    "properties": {
      "score": { "type": "integer" },
      "summaryKo": { "type": "string" },
      "strengths": { "type": "array", "items": { "type": "string" } },
      "fixes": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["said", "better", "whyKo"],
          "properties": {
            "said": { "type": "string" },
            "better": { "type": "string" },
            "whyKo": { "type": "string" }
          }
        }
      },
      "missingKo": { "type": "array", "items": { "type": "string" } },
      "improvedAnswer": { "type": "string" },
      "tryExpressions": { "type": "array", "items": { "type": "string" } }
    }
  },
  "strict": true
}
```

zod(`buildFeedbackZod({maxScore, transcript})`): `score` 정수 0~만점(Q11=5, 나머지 3), `summaryKo` 한글, `strengths` 1~3(빈 항목 거부), `fixes` 0~5·**`said`가 전사문에 있는 구간**(아래)·`better`·`whyKo` 빈 값 거부, `missingKo` 0~3, `improvedAnswer` 라틴·한글 금지, `tryExpressions`는 후처리에서 입력 목록에 있는 것만 남긴다. 2026-10-02(검토 반영): `improvedAnswer`와 `fixes[].better`에 채우지 않은 틀 자리(`hasUnfilledSlot` — `~`·`～`·`〜`·`{`·`}`)가 있으면 거부한다(§4-9와 같은 함수, 기존 1회 재요청). `said`에는 걸지 않는다(전사문 그대로의 구간이다).

- **`said` 대조**(`isSaidInTranscript` → `lib/toeic-text.ts` `containsWordSequence`): 양쪽을 소문자로 바꾸고, 문자·숫자·아포스트로피 밖의 글자(문장부호·하이픈·기호)를 공백으로 바꾸고, 연속 공백을 접는다. 그다음 said의 단어열이 전사문 단어열 안에 **연속으로, 같은 순서로, 단어 경계에서** 있어야 한다.
  - 무시하는 것: 대소문자·연속 공백·문장부호. 전사 모델은 문장부호를 붙여 내고 LLM은 인용하며 쉼표를 자주 떨어뜨린다. 문장부호까지 맞추게 하면 멀쩡한 인용이 재요청을 태우고, 끝내 그 문항 채점이 실패한다.
  - 그대로 보는 것: 단어와 그 순서. 전사문에 없는 단어, 순서를 바꾼 인용, 사이 단어를 뺀 이어 붙이기, 단어 조각으로 시작하는 인용은 **거부**한다 — 하지 않은 말을 고쳤다는 것은 환각이다.
  - 아포스트로피는 단어 안에서는 남긴다(`can't` ≠ `cant`, 둥근 따옴표 `’`는 `'`로 통일). 단어 앞뒤에 붙은 따옴표는 뗀다.
- **`tryExpressions` 후처리**(`postprocessFeedback`): 입력 목록에 대소문자·연속 공백 무시로 있는 것만 남기고 표기는 목록 쪽으로 맞춘다. 중복을 없애고 최대 3개로 자른다(프롬프트 "0~3개"). zod 거부가 아니라 후처리라 재요청을 태우지 않는다. 2026-10-02부터 "입력 목록"은 활용할 표현 ∪ 그 문항에 보낸 답변 흐름의 틀 글자다(§12-13-3).

### 5-4. Q1–2 지문 대조 (AI 없음 — `lib/toeic-score.ts`)

- `alignReadAloud(text, transcript)`: 둘 다 소문자·문장부호 제거·숫자 표기 통일(0~100의 영어 단어 ↔ 숫자, `%`↔percent, `&`↔and) 뒤 단어 단위 편집거리 정렬 → `{accuracy, missing[], extra[], substituted[{expected, heard}]}`. `accuracy = 1 − (빠짐 + 치환)/지문 단어 수`(0 미만은 0).
- 문장부호 처리(`normalizeReadWords`)는 다음과 같다.
  - 대부분의 문장부호(하이픈·콜론 포함)는 띄어쓰기로 바꾼다(twenty-five → twenty five → 25). 아포스트로피는 지운다(don't → dont).
  - **글자 사이 마침표는 지운다**(p.m. → pm, a.m. → am, U.S. → us). 공백으로 바꾸면 "p m" 두 토큰이 돼 전사문의 "PM"과 어긋나고, 90단어 지문에서 한 단어가 깎여 3점이 2점이 될 수 있다(시각은 C1이 지문에 넣으라고 요구하는 요소다).
  - 숫자에 붙여 쓴 am·pm은 띄운다(7pm → 7 pm). 그래서 "7 p.m."·"7 PM"·"7pm"은 같은 단어열이 된다.
  - 문장 끝 마침표 뒤에 띄어 쓴 한 글자("Plan A. B")는 붙이지 않는다.
  - 이 모듈은 클라이언트 번들에 들어가므로 정규식 lookbehind를 쓰지 않는다.
- 참고 점수 `readProxyScore(accuracy)`: ≥0.95 → 3, ≥0.85 → 2, ≥0.6 → 1, 그 밖 0. 화면에 **"발음·억양은 채점하지 않았어요 — 녹음을 다시 들어 보세요"**를 함께 적는다.

### 5-5. 추정 총점 (`lib/toeic-score.ts`)

- 11문항 모두 점수가 있을 때만 계산한다(하나라도 없으면 null + "n문항 채점됨"). 문항 번호가 1~11 정수가 아니거나 점수가 정수 0~만점 밖이면 그 답은 채점되지 않은 것으로 센다 — 결과 화면이 예외로 깨지지 않게 던지지 않는다.
- `raw = Σ Q1–10(0~3) + Q11(0~5)`(만점 35) → `scaled = round10(raw / 35 × 200)` → ACTFL 구간(AH 200 · AM 180–190 · AL 160–170 · IH 140–150 · IM 110–130 · IL 90–100 · NH 60–80 · NM/NL 0–50).
- ETS 환산표는 비공개다. 화면에 **"추정(참고용)"**을 붙이고 구 Level 표기는 쓰지 않는다.
- raw 0~35 전 구간의 환산 점수·구간은 eval이 리터럴 표로 잠근다(반올림을 내림으로 바꾸면 raw 24가 IH 140 → IM 130으로 틀어지는데, 경계값 몇 개만 보면 이를 놓친다).

---

## 6. 표현 시험 · 모의고사 형식 (AI 없음)

### 6-1. 표현 시험 — 네 가지 모드

| 모드 | 문제 | 정답 | 오답 보기 | 출제 조건 |
|---|---|---|---|---|
| `ko-to-expr` | 한국어 뜻 | 표현 | 같은 세트의 다른 표현(**뜻이 같은 표현은 뺀다**) | — |
| `expr-to-ko` | 표현 | 한국어 뜻 | 같은 세트의 다른 뜻(정답과 같은 뜻은 뺀다) | — |
| `cloze` | 교재 예문의 `exampleSpan`을 `_____`로 가린 문장 + **예문 해석** | `exampleSpan` | 같은 세트의 다른 `exampleSpan`(없으면 표현, **뜻이 같은 항목은 뺀다**) | 예문과 `exampleSpan`이 있을 때 |
| `speak` | 우리말 문장 → **소리 내어 영어로 말하기** | 모범 문장(보기 없음) | — | 교재 QUIZ + 발화 포인트 `useIn` |

- 5지선다 세 모드는 `lib/vocab-quiz.ts`의 `buildChoices`를 **그대로 재사용**한다(언어 중립). 순수 출제 함수는 `lib/toeic-quiz.ts`(lib/ai 밖 — 클라이언트 조립 가능).
- **오답 보기 거르기** — 맞는 답이 오답 보기로 나와 틀린 것으로 채점되고 숙련도에 오답으로 쌓이는 경로를 막는다. `buildChoices`는 은우 공유 함수라 고치지 않고(§10), 넘기기 전에 `lib/toeic-quiz.ts`가 후보를 거른다.
  - 같은 표현(대소문자·연속 공백 무시)인 다른 항목은 어느 모드에서도 오답 후보가 아니다. 같은 항목이기 때문이다.
  - `ko-to-expr`·`cloze`에서는 정답과 **뜻이 같은**(연속 공백·대소문자 무시) 항목의 표현·구간을 뺀다. 같은 뜻을 보여 주고 둘 중 하나를 고르라면 정답이 둘이다. `cloze`도 예문 해석이 정답을 정하므로, 뜻이 같은 구간은 똑같이 들어맞는다.
  - `expr-to-ko`에서는 정답과 같은 뜻을 보기에서 뺀다.
  - 보기는 같은 정규화 키로 중복을 접는다. 대소문자만 다른 `exampleSpan` 두 개가 "같아 보이는 보기 둘"로 나오지 않게 한다.
  - 보기는 최대 5개이고, 후보가 모자라면 있는 만큼 낸다. 거른 뒤 보기가 **2개 미만**(정답 하나뿐)이면 그 문항은 출제하지 않는다(`skipped`). 보기가 정답 하나뿐인 문항은 무조건 맞아서 "연속 2회 정답 졸업"을 거짓으로 채운다. 이 판정은 rng와 무관하다 — 모드 고르기 화면이 미리 센 문항 수가 실제 세션과 같다.
- `cloze`는 해석을 함께 보여 준다 — 같은 세트의 다른 구간도 문법적으로 들어맞을 수 있어서(예: "A woman is ___ on the wall"에 "fixing a clock"도 맞는다), 해석이 정답을 하나로 정한다.
- `speak`는 **자기 채점**이다: 문제(한국어) → 사용자가 말한다 → "정답 보기" → 모범 문장 표시·🔊 → "말했어요 ⭕ / 못 했어요 ❌". 한 세션 최대 10문항 — 교재 QUIZ 먼저, 그다음 숙련도 낮은 표현의 `useIn`. 항목 키는 표현(`useIn`)이거나 QUIZ의 첫 `keyExpressions`(없으면 `quiz:{no}`).
- `speak` 세션 조립(`buildToeicSpeakSession`)의 세부는 다음과 같다.
  - QUIZ 항목 키: 첫 `keyExpressions` → 없으면 `quiz:{no}` → 번호도 없으면 `quiz:{promptKo}`.
  - 한 세션 안에서 같은 키는 한 번만 낸다. QUIZ가 이미 어떤 표현 키를 썼으면 그 표현의 `useIn`은 건너뛴다.
  - `useIn` 문항은 `useIn`이 있는 표현마다 하나씩, 그 표현의 `useIn` 중 하나를 무작위로 고른다. 발화 포인트가 없는 표현은 나오지 않는다.
  - `useIn` 순서는 **말하기 모드 통계만** 보고 정한다(다른 모드 통계는 섞지 않는다, §6-2). 말하기에서 틀렸고 아직 졸업 전 → 안 해 봄 → 틀린 적 없이 진행 중 → 졸업 순이다. 같은 순위 안에서는 오답이 많은 것이 먼저고, 그래도 같으면 무작위다.
- **소리**: 문제를 소리로 읽지 않는다(표현을 읽으면 정답이 샌다 — 일본어 러너 관용구). 답을 고른 뒤 표현(또는 `speak` 모범 문장)을 en-US로 읽는다. 한국어를 영어 음성으로 읽는 실수를 막기 위해 lang을 항상 명시한다.
- 세션: 모드 고르기 화면(기본 5지선다 3모드 혼합) + `speak`는 따로. `?wrong=<mode>` 오답 재시험, `?t=` 다시 풀기 논스(일본어 관용구).

### 6-2. 기록·숙련도

- 세션 레코드는 일본어와 같은 모양, **컬렉션 `toeicQuizzes`로 분리**(§7-3). 혼합 세션은 모드별로 나눠 모드마다 POST 1건(모드별 무오염).
- 모드별 POST 중 일부만 실패하면 "다시 저장"은 **아직 저장되지 않은 모드만** 보낸다(끝난 시각도 첫 시도 값 그대로). 성공한 모드를 다시 보내면 같은 세션이 두 벌 쌓이고, 한 번 맞힌 것이 "연속 2회 정답"으로 세어져 거짓 졸업이 난다.
- 집계는 `aggregateWordStats`·`isStatMastered`(연속 2회 정답 졸업)를 어댑터로 **재사용**하고 **모드별로** 낸다 — 뜻은 아는데 말로 못 꺼내는 상태가 흔하다. `speak` 통계가 `ko-to-expr`를 오염시키면 "안다"는 판정이 거짓이 된다.
- 오답노트(모드 탭)·시험 기록 화면은 일본어 골격(`ja-quiz-wrong-view`·`ja-quiz-history-view`)을 따른다.

### 6-3. 전체 듣기 (낭독)

- 대본은 순수 함수 `buildToeicListenScript(set, mode)` → `{text, lang, entryIndex}[]`, 재생은 `speakQueue`(SPEC §18 관용구 — 탭 안에서 동기 호출, `onItem`으로 지금 읽는 카드 강조·스크롤, 큐가 돌려준 stop만 쓴다).
- 모드: ① **표현·뜻·예문**(기본: 표현 en → 뜻 ko → 예문 en) ② **활용 문장까지**(①에 `useIn` 문장 en 추가) ③ **영어만**(표현·예문·`useIn`·`followUp` — 따라 말하기용).
- 300자를 넘는 조각은 문장 단위로 나눈다 — `splitForTts`를 공용 모듈(`lib/tts-split.ts`)로 옮기고 `lib/ja-coaching-script.ts`는 재수출한다(동작 변화 0, `eval:speech` 통과 유지).
- 속도(`TtsSpeedControl`)·엔진(`TtsEngineControl lang="en-US"`)은 은우와 **전역 설정을 공유**한다(언어 베이스 단위 — 기존 규약).

### 6-4. 모의고사 형식표 (단일 정의 — `lib/toeic-mock.ts`)

| Q | 파트 | 화면 | 소리 | 표 읽기 | 준비 | 답변 | 질문 재생 |
|---|---|---|---|---|---|---|---|
| 1–2 | `read` | 지시문 + 지문 | 파트 지시문 | — | 45초 | 45초 | — |
| 3–4 | `picture` | 지시문 + 사진 | 파트 지시문 | — | 45초 | 30초 | — |
| 5–7 | `respond` | 상황 소개 + 질문 텍스트 | 지시문·소개·질문 | — | 3초 | 15 / 15 / 30초 | 1회 |
| 8–10 | `info` | **표만**(질문 텍스트는 숨김) | 지시문·도입·질문 | 45초(Q8 전 1회) | 3초 | 15 / 15 / 30초 | Q8·Q9 1회, **Q10 2회** |
| 11 | `opinion` | 질문 텍스트 | 지시문·질문 | — | 45초 | 60초 | 1회 |

- 문항 하나의 단계: `directions`(파트 첫 문항만) → `reading`(Q8 앞만) → `question`(음성) → `prep` → `beep` → `answer`(녹음) → 다음 문항. 전이·남은 시간 계산은 순수 함수(`nextPhase`)로, 종료 시각(epoch ms) 기반이다(운동 세션 타이머 관용구).
- **지시문은 이 앱의 문장**이다(ETS 원문을 옮기지 않는다). 각 파트 지시문은 `lib/toeic-mock.ts`에 상수로 한 번만 둔다.
  - 모양은 `TOEIC_PART_DIRECTIONS[part] = {en, ko}`다. 실제 시험처럼 **영어(`en`)를 en-US로 읽고**, 같은 뜻의 **한국어(`ko`)는 화면 캡션**으로 함께 보인다. 한국어를 소리로 읽지 않으며, 읽을 때는 lang을 항상 명시한다(`TOEIC_DIRECTIONS_LANG`).
  - 지시문 속 숫자(지문·사진·질문 수, 준비·답변·표 읽기 초, Q10 재생 횟수)는 형식표에서 계산해 넣는다. 그래서 형식표를 바꾸면 지시문이 따라 바뀌고, 숫자가 두 벌로 어긋나지 않는다.
- 질문 음성이 끝내 재생되지 않으면 그 문항을 멈추고 **"다시 듣기"·"질문 보기"** 버튼을 띄운다(Q8–10은 평소 텍스트를 숨긴다). 판정은 `speakQueue`의 끝 사유만으로 하지 않는다 — 1~2조각 큐는 전부 무음이어도 `"done"`으로 끝나기 때문에, `onEnd`의 둘째 인자 `{ sounded }`(소리를 낸 조각 수)로 순수 함수 `toeicSpeechOutcome`(`lib/toeic-mock.ts`)이 다시 판정한다. 질문은 조각 하나라도 무음이면 멈추고, 지시문은 전부 무음일 때만 멈춘다.
- 마이크 대기에는 상한이 있다(`lib/mic-session.ts`의 `MIC_*_TIMEOUT_MS` — 답변 녹음의 `getUserMedia` 8초, 시작 전 마이크 점검 15초, 녹음기 start 5초, stop 3초). 상한을 넘기면 캡처 계수를 되돌리고 오디오 세션을 `"playback"`으로 되돌린다. 늦게 도착한 스트림은 즉시 트랙을 멈춘다 — 응답 없는 권한 요청 하나 때문에 세션이 시험 내내 `play-and-record`에 갇히지 않게 한다.
- 녹음 규칙(`lib/mic-session.ts`): **재생과 마이크 캡처를 시간상 겹치지 않는다** — 질문 음성·비프가 끝난 뒤 `navigator.audioSession.type = "play-and-record"`(지원 시) → `getUserMedia` → `MediaRecorder.start()` → 답변 타이머는 녹음 `start` 이벤트에서 시작 → 끝나면 `stop()` → 트랙 `stop()` → **그다음에** `"playback"`(녹음 중에 바꾸면 트랙이 끊긴다). 녹음 중 화면이 숨겨지면 즉시 멈추고 "중단됨"으로 표시한다. 시작 탭에서 동기로 오디오 컨텍스트·재생 잠금 해제·질문 음성 프리페치·마이크 점검을 한다.
- **마이크 유지(전략 B, 2026-10-03 — SPEC §20-4)**: 응시·틀 테스트 화면은 세션마다 `createMicKeeper()`(`lib/mic-session.ts`) 하나를 쥐고 녹음을 `keeper.startRecording()`으로 연다. 정책은 순수 함수 `micKeepPolicyFor({ appleWebKit, audioSession, perAnswerPref })` 하나가 정한다.
  - `"keep"`(Apple WebKit **이고** `navigator.audioSession`이 있을 때 — iOS·iPadOS·Mac Safari 16.4+, 그리고 기기 설정 "문항마다 마이크 다시 열기"(localStorage `toeic-mic-per-answer`)가 꺼져 있을 때): 첫 녹음(마이크 점검 또는 그 화면의 첫 🎤)에서 `play-and-record` → `getUserMedia` **한 번** → 스트림을 세션 끝까지 쥔다. 녹음마다 트랙 `enabled = true` → 새 `MediaRecorder` → 끝나면 `recorder.stop()` → 트랙 `enabled = false`(stop하지 않는다). 쥔 동안 `activeCaptures`가 1이라 `setAudioSessionPlayback()`은 아무것도 하지 않고 세션은 `play-and-record`에 머문다 — `playback`으로 바꾸면 W3C Audio Session 규칙대로 마이크 트랙이 끝나기 때문이다. WebKit(`AudioSessionIOS.mm`)은 PlayAndRecord에 `DefaultToSpeaker`(수화기 선호가 아니면)·모드 VideoChat을 걸므로 재생은 큰 스피커가 기대값이고, 음량 저하(WebKit 218012)는 실기기 확인 항목이다(SPEC §20-8 1).
  - `"per-answer"`(그 밖 — 구형 iOS·Chrome·Firefox·Android, 또는 기기 설정): 바로 위 녹음 규칙 그대로(녹음마다 획득·해제 — 전략 A). 구형 iOS는 세션 API가 없어 쥔 채 재생 경로를 고를 수 없으므로 소리를 지키고 권한 재요청을 감수한다.
  - **놓는 때**(`keeper.release()` — 멱등, 트랙 stop → `activeCaptures--` → **그다음** `playback`): 세션 끝·그만두기·언마운트·`pagehide`·`visibilitychange` hidden. 놓은 뒤의 녹음은 다시 얻는다(그때만 권한 창). 탭으로 여는 길("시작"·"이 문항 다시")은 `keeper.prime()`으로 탭 안에서 먼저 연다. 트랙이 `ended`(권한 철회·장치 분리·세션 전환)되면 쥔 스트림을 버리고 다음 녹음이 다시 얻는다. `muted`는 재획득 근거로 쓰지 않는다(입력을 꺼 둔 트랙을 WebKit이 muted로 보일 수 있어 문항마다 다시 묻게 된다). (2026-10-03 §15-10에서 바뀜 — 입력을 **켠 뒤**에도 muted면 한 번 다시 연다.)
  - 대기 상한(gUM 8초·점검 15초·start 5초·stop 3초)·늦은 스트림 즉시 stop·`started` 거부 시 스스로 버림은 두 정책이 같다. 진행 중인 획득에 다음 녹음이 합류한다(두 번 열지 않는다). 녹음 중 숨김은 지금처럼 그 녹음을 버리고 "중단됨"이다.
  - 진단 줄에 `마이크 유지 · 열기 n회` / `마이크 문항마다 · 열기 n회`(`getMicDiag().keep`). e2e는 `getUserMedia` 호출 수로 잠근다 — keep이면 응시 전체 1회, per-answer면 점검 1 + 녹음 문항 수.
- 녹음은 먼저 기기(IndexedDB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`)에 두고 문항마다 백그라운드로 서버에 올린다(§13-3). 기기 사본은 풀마다 **최근 응시 5회분**만 남기되 아직 못 올린(pending) 녹음이 있는 응시는 지우지 않는다. 다른 기기·브라우저는 서버 사본으로 듣고 채점한다(§13-8). 서버에도 없으면 "이 녹음은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요".
- 유형 연습: 파트 하나만 같은 형식으로 응시한다(`scope: "part"`).

---

## 7. 저장 모델

`lib/store.ts` 새 레코드 추가 체크리스트 12항목(인터페이스·`New*`·`StudyStore` 메서드·`DbShape`·`emptyDb`·`readDb` 하위호환 방어·`normalize*` 단일 정의처·파일 구현·Firestore `to*` 변환기·`assertDestructiveAllowed`+`DestructiveOp`·렌더 판정 모듈·`mergeDbForSeed`)를 **전부** 밟는다. 선택 키(`?`) 금지 — 전부 필수 nullable. 컬렉션 5개 — `toeicSets`·`toeicQuizzes`·`toeicMocks`·`toeicImages`·`toeicAttempts` — 은우·일본어 컬렉션과 섞지 않는다.

### 7-1. `ToeicSetRecord` — 표현집 한 DAY

```ts
type ToeicPart = "q1_2" | "q3_4" | "q5_7" | "q8_10" | "q11";

interface ToeicSpeakingPoints {        // 호출 B (§3)
  exampleSpan: string | null;
  coreKo: string;
  useIn: { part: ToeicPart; sentence: string; sentenceKo: string }[];
  frames: string[];
  variations: { en: string; ko: string }[];
  pronunciationKo: string;
  pitfallKo: string | null;
  grammarKo: string | null;
  followUp: { en: string; ko: string };
}

interface ToeicExprEntry {
  no: number | null;                   // 교재 번호
  expression: string;                  // 교재 원문
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  points: ToeicSpeakingPoints | null;  // 없으면 null(best-effort)
  confidence: "high" | "medium" | "low";
  partial: boolean;
}

interface ToeicBookQuiz {              // 교재 하단 QUIZ
  no: number | null;
  promptKo: string;
  hint: string | null;
  modelAnswer: string;
  keyExpressions: string[];            // 이 세트 entries[].expression 중 하나씩
}

interface ToeicSetRecord {
  id: string;
  titleKo: string;                     // 기본 "DAY {n} {topicKo}"
  dayNo: number | null;
  topicKo: string | null;
  source: "photo" | "import";
  presetKey: string | null;            // 가져오기 멱등 키(§7-6). 사진이면 null
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
  photoCount: number;                  // 판독에 쓴 사진 수(원본은 저장하지 않음). 가져오기면 0
  enriched: boolean;                   // entries 전부 points !== null
  model: string | null;                // 판독 모델. 가져오기면 null
  createdAt: string;
  sortIndex: number | null;
}
```

- 상한(`schemas.ts` 단일 정의): 세트당 entries 1~60, quiz 0~12, `titleKo` 1~120자.
  - **공략 세트는 예외**(2026-09-27, §12-3): `guide` ≠ null인 세트는 quiz 0~`TOEIC_GUIDE_SPEAK_MAX`(60)이다. 공략 가져오기 zod(`toeicGuideFileSchema`, §12-2-3)가 이 상한을 건다. `TOEIC_SET_QUIZ_MAX`(12)는 **표현집 경로**의 상한이다. 사진 판독 저장 라우트(`POST /api/toeic/sets`)와 표현집 가져오기 zod(`toeicImportFileSchema`)가 이 값을 쓴다. 공략 세트는 이 두 경로를 지나지 않는다(이름 바꾸기·발화 포인트도 409 — §12-3).
  - 읽기 쪽(`normalizeToeicSetRecord`·`isRenderableToeicSet`·시험 출제)에는 **개수 상한을 걸지 않는다**. 걸면 공략 세트가 열리지 않는다.
- **세트 안 표현은 서로 달라야 한다**(대소문자·연속 공백 무시 — `lib/toeic-text.ts` `expressionKey`). 항목 키가 곧 표현이라(§6-1) 같은 표현이 두 항목이면 두 항목이 숙련도 통계를 나눠 쓴다. 그러면 한 세션에서 두 문항을 맞힌 것이 "연속 2회 정답"이 되고, 오답노트는 뒤 항목의 뜻만 보여 준다. 판정은 `findDuplicateExpressionIndexes`(첫 등장은 빼고 두 번째부터의 위치) 하나를 저장 라우트·가져오기 zod(§7-6)·검토 화면이 같이 쓴다. 오류는 두 번째 항목의 `expression` 경로에 건다. 판독 zod는 거부하지 않는다(§2-4).
- 저장되는 `meaningKo`는 언제나 비지 않는다 — 판독 초안의 빈 뜻(잘린 항목, §2-4)은 사람이 채워야 저장된다.

### 7-2. `ToeicMockRecord` — 모의고사 한 세트

```ts
type ToeicTargetGrade = "IM3" | "IH" | "AL";
type ToeicMockPart = "read" | "picture" | "respond" | "info" | "opinion";

interface ToeicMockRecord {
  id: string;
  titleKo: string;                     // 기본 "모의고사 {n}" 또는 사용자 수정
  targetGrade: ToeicTargetGrade;
  expressionsUsed: string[];           // 호출 C에 넘긴 활용할 표현(재현·피드백 입력)
  topicHints: string[];                // 호출 C에 넘긴 주제 힌트(파트 다시 만들기가 같은 입력을 쓴다)
  answerFlows: ToeicAnswerFlow[];      // 2026-10-02 — 만들 때 만든 답변 흐름(0~4, 파트 중복 없음, read 없음 — 고르지 않은 파트도). 옛 문서 = [] (§12-13-3)
  parts: {
    read: ToeicReadPart | null;        // C1 결과(실패·미선택이면 null)
    picture: ToeicPicturePart | null;  // C2 + items[i].image {status: "pending"|"ready"|"failed", imageId: string|null}
    respond: ToeicRespondPart | null;  // C3
    info: ToeicInfoPart | null;        // C4
    opinion: ToeicOpinionPart | null;  // C5
  };
  model: string;
  createdAt: string;
  sortIndex: number | null;
}
```

파트 타입은 §4-8 스키마 결과 그대로(+ C2의 `image`). 완전한 11문항 세트 = 다섯 파트가 모두 non-null.

- **빈 파트만 채운다.** "이 파트 다시 만들기"(`[id]/regenerate?part=`)는 null인 파트만 채우고, 이미 있는 파트는 덮지 않는다(409). 보던 모범답변과 응시 기록이 가리키는 문항이 말없이 바뀌지 않게 하려는 것이다. 입력은 처음과 같다(`targetGrade`·`topicHints`·`expressionsUsed`, 그리고 `answerFlows`의 그 파트 흐름 — 없으면 null). `topicHints`·`answerFlows`가 없는 이전 문서는 빈 배열로 읽는다.
- **`answerFlows`(2026-10-02)** — 만든 흐름 = 저장한 흐름. 실전 모의고사는 만들 때 **고른 파트와 상관없이** read를 뺀 네 파트 중 흐름이 나오는 것(틀이 있는 유형) **전부**를 저장하고, 호출 C에는 그중 고른 파트의 것만 넘긴다(검토 반영 — 처음 안은 고른 파트만이었다). 그래야 "이 파트 다시 만들기"(실패한 파트)와 **"이 파트 만들기"(만들 때 고르지 않은 파트 — 같은 regenerate 라우트)**가 모두 같은 흐름을 받고, 그 파트의 채점(호출 D)도 흐름을 받는다. 고른 파트만 저장하면 나중에 채운 파트는 틀 은행을 다시 읽지 않는 규칙 때문에 영영 흐름이 없다. 한 문제 연습은 그 파트 하나뿐이다(연습에는 다른 파트를 만들지 않는다 — 409 `is_drill`). 크기는 흐름 넷을 합쳐 수 KB다(§12-13-4). 정규화는 모르는 키를 버리므로 `normalizeToeicMockRecord`가 명시적으로 옮긴다 — 배열이 아니면 [], 항목 모양이 깨진 흐름은 그 항목만 버린다. 배열 안 객체 안 배열이라 Firestore 배열 속 배열 제약(§12-3)에 걸리지 않는다.
- **사진은 먼저 준비된 것이 이긴다.** `picture.items[slot].image`가 `ready`면 다른 `ready`로도 `failed`로도 바꾸지 않는다. 사진 문서 생성과 칸 갱신은 한 원자 단위다(파일 `mutate`, Firestore `runTransaction`). 그래서 두 요청이 같은 칸을 동시에 만들어도 한 장만 남고, 쓰지 않은 사진 문서(고아)가 생기지 않는다.

### 7-3. `ToeicQuizRecord` — 표현 시험 세션

```ts
type ToeicQuizMode = "ko-to-expr" | "expr-to-ko" | "cloze" | "speak";
interface ToeicQuizRecord {
  id: string; setId: string;
  mode: ToeicQuizMode | ToeicTemplateBankMode;   // 틀 은행 세션 모드 다섯 — §12-3·§12-13-2
  startedAt: string; finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];  // word = 항목 키(§6-1)
}
```

append 전용(수정·삭제 API 없음). 세트를 지우면 그 세트의 세션도 지운다.

### 7-4. `ToeicImageRecord` — Q3–4 생성 사진

```ts
interface ToeicImageRecord {
  id: string; mockId: string; slot: 0 | 1;
  dataUrl: string;                     // image/jpeg base64, ≤ 900,000자
  model: string; createdAt: string;
}
```

AI가 만든 사진이라 "원본 사진 미저장"(SPEC §13, 사용자가 올린 사진) 규칙의 대상이 아니다. 모의고사를 지우면 함께 지운다.

### 7-5. `ToeicAttemptRecord` — 모의고사 응시

```ts
interface ToeicFeedback {              // 호출 D 결과(§5-3) 그대로
  score: number; summaryKo: string; strengths: string[];
  fixes: { said: string; better: string; whyKo: string }[];
  missingKo: string[]; improvedAnswer: string; tryExpressions: string[];
}
interface ToeicReadDiff {              // §5-4
  accuracy: number; missing: string[]; extra: string[];
  substituted: { expected: string; heard: string }[];
}
interface ToeicAnswer {
  q: number;                           // 1..11
  recorded: boolean;                   // 녹음이 끝까지 됐는가
  durationMs: number | null;
  transcript: string | null;           // 관문 T
  readDiff: ToeicReadDiff | null;      // Q1–2만
  feedback: ToeicFeedback | null;      // Q3–11만
  score: number | null;                // Q1–2 = readProxyScore, Q3–11 = feedback.score
  scoredAt: string | null;
}
interface ToeicAttemptRecord {
  id: string; mockId: string;
  scope: "full" | "part";
  parts: ToeicMockPart[];
  startedAt: string; finishedAt: string | null;   // null = 중간에 그만둠
  answers: ToeicAnswer[];
}
```

- 응시 시작에 레코드를 만들고(녹음 IndexedDB 키로 id가 필요하다), 끝나거나 그만둘 때 `answers`의 `recorded`·`durationMs`를 채운다. 채점은 문항별로 그 문항만 갱신한다(파일: `mutate`, Firestore: 문서 읽기 → 그 문항만 바꿔 쓰기 — 같은 응시의 두 문항이 동시에 채점돼도 서로 덮지 않게 `runTransaction`).
- 시작할 때 `answers`는 빈 배열이고, 끝/그만두기가 **응시 범위의 모든 문항**을 채운다(녹음 안 된 문항은 `recorded:false`). 그래서 "닫힌 응시" = `finishedAt !== null || answers.length > 0`이다(`lib/toeic-attempt-rules.ts`). 끝/그만두기는 **한 번만** 받는다 — 이미 닫힌 응시에 다시 오면 409(`already_finished`)로 거절하고 쓰지 않는다(판정은 원자 단위 안). 재시도·다른 탭의 늦은 요청이 "끝까지"를 "중단"으로 바꾸거나 채점된 문항의 `recorded`를 뒤집지 못하게 하려는 것이고, 화면은 409를 성공으로 본다. 채점은 닫힌 응시의 녹음된 문항에만 한다(아니면 409). (2026-10-03 §15: 문항 단위 다시 풀기는 이 끝내기를 다시 쓰지 않고 자기 끝 라우트로 그 문항 자리만 바꿔 끼운다 — answers 길이·닫힘 판정 불변.)
- 모의고사를 지우면 응시 기록도 지운다.
- **2026-10-03(§13-5)**: 응시 기록에 `recordings: ToeicStoredRecording[]`(서버에 보관한 녹음의 메타 — q마다 하나)를 더한다. `answers`가 아니라 따로 두는 것은 응시 중 업로드가 "닫힌 응시" 판정(`answers.length > 0`)을 뒤집지 않게 하려는 것이다. 모의고사를 지우면 녹음 객체도 먼저 지운다(§13-7).

### 7-6. 교재 10쪽 미리 넣기 — "파일로 가져오기"

- 전사본: `data/private/toeic-hackers-day1-10.raw.json`(Claude가 사진을 직접 판독 — OpenAI 호출 없음), 발화 포인트: `data/private/toeic-points/day{N}.json`(호출 B 규칙대로 저작·교차 검증), 둘을 합친 가져오기 파일: `data/private/toeic-preset-hackers-core.json`. **모두 git 밖**(`data/`는 gitignore, `.gcloudignore`도 제외).
- 파일 형식 `{ "format": "toeic-sets/v1", "sets": [ { presetKey, titleKo, dayNo, topicKo, entries, quiz } ] }` — entries·quiz는 §7-1 모양(points 포함), zod로 호출 B·A와 **같은 규칙**을 적용해 검증한다(exampleSpan ⊂ example 등).
- 가져오기 zod(`toeicImportFileSchema`)가 호출 A·B 규칙에 더해 거는 것은 다음과 같다. 가져오기는 저장과 같은 자리라 판독보다 엄격하다.
  - `presetKey`: 소문자·숫자 조각을 하이픈 하나로 잇는 형식(`^[a-z0-9]+(-[a-z0-9]+)*$`, 예 `vendor-core-day01`), 최대 80자, 파일 안에서 중복 금지.
  - `sets` 1~100개. 모르는 최상위 키(출처 메모 등)는 버린다.
  - QUIZ `no` 중복 금지(null은 중복으로 보지 않는다).
  - **`keyExpressions`는 그 세트 `entries[].expression`과 글자 그대로 같아야 한다 — 어긋나면 거부**한다(판독의 "버림"과 다르다). 가져오기에는 사람이 고칠 검토 화면도 후처리도 없으므로, 저장 불변식(§7-1 `keyExpressions` 주석)을 입구에서 지킨다.
  - 세트 안 표현 중복 거부(§7-1).
  - `partial=true`여도 `meaningKo`가 비면 거부한다(빈 뜻 허용은 판독 초안에만, §2-4).
  - 400 응답의 `issues`에는 경로와 규칙 문구만 싣는다. 값은 싣지 않는다(교재 원문이 응답·로그에 새지 않게).
- `POST /api/toeic/sets/import` — 같은 `presetKey`가 이미 있으면 건너뛴다(**멱등**). 응답 `{created, skipped}`. 목록 화면의 "파일로 가져오기"가 부른다. 프로덕션에 넣는 것은 사용자가 앱에서 파일을 고르는 행동이다 — 로컬에서 프로덕션 DB로 쓰지 않는다(CLAUDE.md 서문).

---

## 8. 화면·경로

```
/toeic                          아빠의 영어 허브 (표현집 / 모의고사)
/toeic/sets                     표현집 목록 (관리모드 삭제·순서변경, 사진으로 추가, 파일로 가져오기)
/toeic/sets/new                 사진 N장 → 판독 → DAY별 검토·수정 → 저장 → 발화 포인트(best-effort)
/toeic/sets/[id]                표현 카드(원문 + 발화 포인트) · 전체 듣기 · 교재 QUIZ · 시험 버튼
/toeic/sets/[id]/quiz           시험 (5지선다 3모드 혼합 / 말하기)
/toeic/sets/[id]/wrong          오답노트 (모드 탭)
/toeic/sets/[id]/history        시험 기록
/toeic/mocks                    모의고사 목록 + 새로 만들기(목표 등급·파트·주제)
/toeic/mocks/[id]               모의고사 학습 보기(자료·모범답변·🔊) + 응시(실전 11문항 / 유형 연습) + 응시 기록
/toeic/mocks/[id]/take          응시 화면(전면 오버레이 — 타이머·질문 음성·녹음)
/toeic/attempts/[id]            응시 결과(내 녹음 ▶(이 기기 → 서버 사본) · 🗄️ 서버 보관 n/m · 전사 · 점수 · 피드백 · 모범답변 · AI 채점 받기 · 추정 등급 · 🎧 비교 — §13-8·§13-9)
/toeic/guides                   유형별 공략 — 유형 폴더 4개 + 📂 파일로 가져오기(2026-09-27 — 폴더 탭·틀 테스트·👀 틀 시험 러너 `/toeic/guides/[part]/templates/quiz`(2026-10-02)는 §12-8)

/api/toeic/sets/extract         호출 A (사진별 병렬, 저장 없음)
/api/toeic/sets                 POST 저장 · import · reorder · [id] DELETE/rename · [id]/points(호출 B) · [id]/quiz
/api/toeic/mocks                POST 생성(호출 C 파트별 병렬 — 2026-10-02부터 파트마다 답변 흐름, 문서에 네 파트 흐름 저장) · reorder · [id] DELETE/rename · [id]/regenerate?part= · [id]/image(관문 P) · [id]/attempts
/api/toeic/images/[id]          GET 생성 사진
/api/toeic/attempts/[id]        finish · score(관문 T + 호출 D / Q1–2 대조) · recordings/[q] PUT·GET(내 녹음 서버 보관 — PIN 게이트 뒤 프록시, §13-4)
/api/toeic/guides               import · templates/transcribe(관문 T) · templates/sessions(2026-10-02: 모드 다섯 — 말하기 둘 + 👀 고르기·빈칸 셋) · [part]/drills(호출 C) — §12-8
```

- 셸은 일본어 방식이다 — 공통 레이아웃 없이 페이지마다 `u-navbtn` "← 상위" 헤더(`/toeic`은 "← 과목 선택"). `EnglishNav`(은우 셸)를 쓰지 않는다.
- 홈(`app/page.tsx`)의 아빠 줄에 **"아빠의 영어"**를 추가한다 — 아빠 줄은 일본어·영어 한 줄 + 운동 한 줄(`sm:col-span-2`).
- 목록·상세·시험·오답·기록은 일본어 골격(`ja-vocab-library-view`·`ja-quiz-runner`·`ja-quiz-picker`·`ja-quiz-wrong-view`·`ja-quiz-history-view`)을 따르되 **토익 전용 컴포넌트로 새로 둔다**(은우 `vocab-quiz-view`는 URL·문구·TTS 언어가 박혀 있어 재사용하면 오염된다).
- 표현 카드: 표현(🔊) · 뜻 · 예문(🔊, `exampleSpan` 하이라이트) · 해석 · [발화 포인트: `coreKo` · 문항 배지 달린 `useIn`(🔊) · 틀 · 바꿔 쓰기(🔊) · 발음 · 함정 · 문법 · 이어 말하기(🔊)]. 포인트가 없으면 "발화 포인트 만들기" 버튼.
- 사진 판독 검토 화면: DAY별 묶음, 표현·뜻·예문·해석·QUIZ를 **고칠 수 있다**(판독 오류를 사람이 잡는 자리), 잘림·흐림 칩, 빠진 번호, 실패한 사진 수를 사실대로 알린다.
  - 저장 라우트가 거부할 것을 **저장 전에** 짚는다 — 세트 안 같은 표현(§7-1, `findDuplicateExpressionIndexes`로 앞 항목 번호까지)과 잘린 항목의 빈 뜻(§2-4, 고치기 칸을 처음부터 연다). 고칠 곳이 남은 묶음은 저장 대상에서 빠지고 그 사실을 버튼 아래에 알린다.
  - 저장 응답의 `droppedKeyExpressions`(검토에서 표현을 고치거나 빼서 QUIZ가 가리킬 표현을 잃은 수)가 있으면 곧장 넘어가지 않고 완료 화면에서 묶음별로 알린다. QUIZ 문장은 남는다. 표현 연결이 모두 풀린 QUIZ의 말하기 항목 키는 QUIZ 번호가 된다(§6-1).
  - "다시 읽기"는 다시 눌러 나아질 때만 보인다 — 네트워크 예외, `retriable:true` 500, 본문이 JSON이 아닌 5xx(게이트웨이). 키 없음(501)·입력 오류(400)는 이유만 알린다.
- 응시 화면: 문항 번호·파트·단계·남은 시간을 크게, 준비 중에는 메모장(선택), 녹음 중에는 레벨 미터. 마이크 거부·미지원이면 **"녹음 없이 연습"**(타이머만)으로 계속할 수 있다.
- 응시 결과: 추정 등급은 "추정(참고용)", Q1–2는 "발음·억양은 채점하지 않았어요". 녹음이 이 기기에도 서버에도 없으면 AI 채점 버튼을 막고 이유를 말한다(§13-8).
- 진단 캡션(선택 표시): 마지막 녹음의 mimeType·길이·크기·정규화 여부·전사 상태(SPEC §16-5의 TTS 진단 관용구) — 서버 로그를 못 보는 폰에서 판정하려고.

---

## 9. eval (`scripts/eval-toeic.ts`)

- **오프라인(기본, 무비용)**: zod 반례(exampleSpan이 예문 밖·index 누락/중복·useIn part 중복·frames에 `___` 없음·chunks 불일치·stressWords가 지문에 없음·feedback `said`가 전사문 밖·순서 바꿈·사이 단어 뺌·단어 조각(쉼표 하나 빠진 인용은 통과)·점수 범위·잘린 항목의 빈 뜻은 판독만 통과·세트 안 표현 중복은 가져오기에서 거부), 후처리(keyExpressions 정리·DAY 묶기·번호 병합·usedExpressions 정리·빈 자리만 채우기), 시험 출제(모드별 조건·보기 5개 상이·정답 포함·뜻이 같은 표현과 대소문자만 다른 보기 제외·보기 2개 미만이면 출제 불가·`cloze` 가림·`speak` 항목 키), **모드별 숙련도 분리**(반례로 잠금), 형식표·단계 전이(Q10 2회 재생·Q8 앞 표 읽기 45초·파트 첫 문항만 지시문), Q1–2 대조(숫자 표기 통일·약어 마침표 p.m. = PM·빠짐/치환 계산), 추정 총점(raw 0~35 전 구간 리터럴 표·정수 아닌 문항 번호 방어)·등급 구간, 스트릭 트랙 분리(은우·일본어·운동·영어가 서로 섞이지 않음), **가져오기 파일 검증**(`data/private/toeic-preset-hackers-core.json`이 있으면 zod 통과·10세트·140표현·20 QUIZ, 없으면 SKIP — 공개 저장소에 없으므로 CI 기준은 SKIP).
- **spec-sync**: 호출 A·B·C(머리말 + 파트 5)·D의 시스템 프롬프트·사용자 메시지 형식·사진 프롬프트 접미사를 이 문서와 **바이트 대조**, JSON Schema 8개는 **의미 동치**(JSON.parse → deepEqual, 일본어 관용구). 2026-10-02: 원문 대상이 14 → 15(새 `TOEIC_MOCK_FLOW_RULES` — 라벨 "§4-1 호출 C 흐름 규칙")이고 JSON 8은 그대로, 값 셋(§4-7·§5-1·§5-2)이 바뀌었다(§4-1 머리말은 검토 반영으로 옛 글자 그대로). 스펙이 먼저 바뀐 동안 그 셋이 FAIL이었고, 같은 날 T15 구현이 `prompts.ts`를 같은 문자열로 맞춰 **15/15 PASS**다 — 스펙과 코드는 한 커밋으로 묶는다(문서만 먼저 나가면 main의 eval이 붉다). 템플릿 중심 재정렬의 새 항목은 §12-13-5.
- **실호출 점검(게이트)**: `EVAL_TOEIC=1`일 때만 — 호출 A(사진 1장)·B(7개)·C(파트 1개)·D(픽스처 전사문 1개). 비용이 드는 검증은 **사용자 동의 후 오케스트레이터가 실행**한다.
- **유형별 공략(§12-10)** 항목은 `scripts/eval-toeic-guides.ts`(순수 층 — `runToeicGuideChecks`)·`eval-toeic-guides-app.ts`(S1 앱 층)·`eval-toeic-guides-s2.ts`(틀 테스트·표현 시험)·`eval-toeic-guides-s3.ts`(한 문제 연습)에 있고 `eval-toeic.ts`가 불러 한 번에 돈다. 2026-09-28 기준 오프라인 **985항목**(표현집·모의고사 357 + 유형별 공략 628)이었고, 2026-10-02 템플릿 중심 재정렬 뒤 **1167항목**이다(새 eval 조각 `scripts/eval-toeic-template-centric.ts`와 `eval-toeic.ts`의 "템플릿 중심 — 호출 C·D 흐름" — §12-13-5·§12-13-7) — 두 가져오기 파일(`data/private/toeic-preset-hackers-core.json`·`data/private/toeic-strategy/toeic-guides.json`)이 있는 로컬 기준이고, 없으면 각 묶음이 SKIP 1건으로 바뀐다(공개 저장소·CI 기준). 게이트는 새로 두지 않았다(§12-10 끝). 2026-10-03 내 녹음 서버 보관 + 비교(§13-10 — `scripts/eval-toeic-recordings.ts` 12묶음, GCS 0) 뒤 **1308항목**이다. 같은 날 마이크 유지(§6-4 전략 B — `eval-toeic.ts` "마이크 유지" K1~K22: 정책 표·획득 1회/녹음 n회·녹음 사이 입력 끔·놓기에서만 stop·ended 재획득·per-answer·거부/무응답/놓는 사이 도착·화면 배선 소스 대조) 뒤 **1332항목**이다. 같은 날 녹음 관리·고칠 문장 다시 녹음(§14-10 — `scripts/eval-toeic-rec-manage.ts` 11묶음, 마이크 유지 K23·K24 동시 호출) 뒤 **1436항목**이다(같은 날 0ec640c의 K0 기본값 행 1개 포함 — 1333 → 1436).

---

## 10. 재사용과 분기 경계

**그대로 재사용(수정 0):** `buildChoices`(`lib/vocab-quiz.ts`), `aggregateWordStats`·`isStatMastered`(`lib/vocab-mastery.ts`, 어댑터 경유), `callWithSchema`·`imagePart`·`textPart`(과목 분기 금지), 사진 파이프(`ImageCropper`·`lib/image-crop.ts`·`lib/image-resize.ts`·`lib/upload-limits.ts`), `useReorder`·`lib/reorder-contract.ts`, `speak`·`speakQueue`·`prefetchSpeech`·`unlockSpeechPlayback`·`TtsSpeedControl`·`TtsEngineControl`, `prod-guard`, `lib/kst.ts`, `STREAK_REFRESH_EVENT`·`computeStreak`.

**옮겨서 공유(동작 변화 0):** `splitForTts` → `lib/tts-split.ts`(`lib/ja-coaching-script.ts`는 재수출).

**새로 두는 것(은우·일본어를 고치지 않는다):** 프롬프트 전량(은우 쪽은 초등 눈높이가 하드코딩), 표현 엔트리 모양(`word`/`pos`/`ipa` 대신 `expression`/`meaningKo`/`points`), 시험 모드·러너·오답·기록 화면, 컬렉션 5개, 녹음 모듈(`lib/mic-session.ts` — 저장소 첫 녹음 경로), 모의고사 타이머(운동 세션의 종료 시각 타이머·예약 비프·Wake Lock **관용구를 따라 새로** 쓴다 — 운동 코드는 이번에 건드리지 않는다: 실기기 검증이 끝난 경로라 회귀 위험을 지지 않는다).

**알려진 한계:** 클라우드 TTS의 en-US 지시문이 "young learner" 톤이라 시험 음성이 실제보다 느리고 또박또박하다. 지시문을 바꾸면 `TTS_INSTRUCTIONS_VERSION`이 올라가 **전 언어 캐시가 비워진다**(SPEC §16-5) — 이번 범위에서는 바꾸지 않고, 필요하면 속도 조절(1.15)로 보완한다.

---

## 11. 로드맵

| 단계 | 내용 | AI 호출 | 비고 |
|---|---|---|---|
| **T0** | 스캐폴딩 — 홈 진입, `/toeic` 허브, 컬렉션 5개, 스트릭 "영어" 트랙, `splitForTts` 공용화 | 0 | 기존 화면 회귀 0 |
| **T1** | 표현집 — 호출 A·B + 사진 판독 흐름 + 파일 가져오기 + 목록·상세(카드·전체 듣기·QUIZ) | A·B | 교재 10쪽은 가져오기 파일로 |
| **T2** | 표현 시험 4모드 + 오답노트 + 기록 | 0 | 순수 함수 재사용, 모드별 숙련도 분리 |
| **T3** | 모의고사 만들기 — 호출 C(파트 5 병렬) + 관문 P(사진) + 목록·학습 보기 | C·P | 파트별 부분 성공 |
| **T4** | 모의고사 응시 — 형식표 엔진·타이머·질문 음성·녹음·IndexedDB·응시 기록 | 0 | 실기기(iPhone) 확인 필수 |
| **T5** | AI 채점 — 관문 T + 호출 D + Q1–2 대조 + 추정 등급 + 결과 화면 | T·D | 버튼을 눌러야 비용 발생 |

T1·T2(표현집)와 T3~T5(모의고사)는 서로 독립이다(§0-4). 실제 의존은 T0 → 나머지, T3 → T4 → T5뿐이다. 각 단계는 오프라인 eval을 먼저 통과하고, 실호출 검증은 동의 후 1회로 묶는다.

---

## 12. 유형별 공략 (2026-09-27)

> 제품 수준의 흐름·경계·비용·실기기 확인은 SPEC §20-10. 이 절은 **가져오기 형식·zod·저장·템플릿(틀) 훈련·연습 단위·읽기 대본·eval**의 단일 정의처다. 이 절의 예시 문장은 전부 지어낸 것이다 — 교재 문장도, 참고한 강의 자막의 문장도 옮기지 않는다(§0-2 "교재 내용의 저장소 반입", SPEC §20-6).
>
> 2026-09-27 검토 반영: 코드 대조 리뷰와 내용·경험 리뷰가 있었다. 괄호·자리 표시의 뜻, 머리말 + 이어 말하기 표(`completions`), 표현 목록 규칙, 사진 연습 상태코드, `pickExpressionsForDrill`의 자리, 공략 세트의 quiz 상한(§7-1 예외), 연습 결과 화면을 고쳤다.
>
> 2026-09-27 업그레이드 — **템플릿(틀) 훈련**(§12-5)을 폴더의 중심 기능으로 더했다. 참고 자료(토익스피킹 강의 "만능 문장" 자막 — `design/toeicspeaking/drill.md`, 작업 폴더에는 있지만 `.gitignore`의 `design/toeicspeaking/`로 git 밖이다(2026-09-28 코드 기준 정정 — 옛 문장 "저장소에는 있지만"). 문장은 이 스펙에 옮기지 않는다)에서 가져온 것은 **방법과 분류**뿐이다 — 한국어 1번 → 영어 4번 따라 말하기, 한국어만 보고 말한 뒤 정답과 비교하고 틀린 것을 표시해 다시, 외운 틀을 처음 보는 문제에 꺼내 쓰기. 학습 단위는 문장이 아니라 **틀**(바꿔 끼울 자리가 있는 문장 뼈대)이고, 틀마다 주제가 다른 예문을 돌려 같은 틀을 되풀이한다. 틀은 **교재 틀에 맞춘다** — 같은 기능의 틀이 교재에 있으면 교재 틀의 고정 부분을 글자 그대로 쓴다(§12-2-7). 절 번호는 학습 흐름(① 읽기 → ② 템플릿 훈련 → ③ 표현 시험 → ④ 한 문제 연습)으로 다시 매겼다 — 옛 §12-5(연습)는 §12-7, 옛 §12-7~§12-11은 §12-8~§12-12다.
>
> 2026-09-27 업그레이드 검토 반영 — 코드 대조 리뷰와 학습 경험 리뷰가 한 번 더 있었다. 고친 것은 열 가지다. ① 틀 채움 규칙이 숫자·가격을 받는다. ② 흐름을 **단계**(교재 답변 순서, 3~6개)와 **소재 묶음**(흐름 밖) 두 층으로 나눴고, 묶음은 폴더마다 틀 6개 이하다. ③ 교재 연결을 `guideRefs` 배열로 바꿨다. 교재의 자리 표현·답변 틀 단계·이어 말하기 머리말은 하나하나 **연결되거나 이유와 함께 건너뛰어야** 가져오기가 통과한다(빠짐 0). ④ 틀 원본을 `core/templates.json` 한 파일(`toeic-core-raw/v3`)로 정했다. ⑤ 틀 바꿔 말하기는 영어 글자를 가리고 **대본에 없는 채움**(`testFills`)으로 새 문장을 만들게 했다. ⑥ ○/✕는 **정답을 보기 전 첫 유효 시도**로 정한다. ⑦ 따라 말하기의 쉼을 **무음 소리 조각**으로 재생해 잠금 화면·주머니에서도 이어지게 했다. ⑧ 기록 라우트는 멱등 키 형식과 시각을 검사한다. ⑨ 표현 시험 모듈의 약함 순위와 세션 어댑터를 공개해 한 벌로 쓴다. ⑩ 제안 판정을 다듬었다(축약형 두 뜻·관사만 들린 자리·같은 뜻 교재 틀). 개선 제안의 반영 여부와 근거는 `_workspace/spec_toeic_strategy_upgrade_report.md` "검토 반영" 절에 있다.
>
> 2026-09-28 구현 동기화 — T6~T12와 공용 `speakQueue` 쉼이 구현되고 통합 QA(`qa_report_toeic_guides-final_3.md` — P1·P2 0)를 지났다. 구현이 스펙과 달라진 곳·스펙이 비워 둔 곳을 **코드 기준으로** 이 절 안에 맞췄다(절 번호는 그대로). 주요한 것: "영어만" 틈 기본값은 **끔**(§12-12 8의 옛 "기본 켬"을 고쳤다), 틀 비교의 치환 비용 2(§12-5-5), 두 뜻 축약형 범위(`'d`는 모든 낱말), 첫 유효 시도의 정의(`!noSpeech` 포함)·전사 라우트의 `application/octet-stream`·"녹음 없이 하기"·테스트 화면의 라틴 가림·화면 이탈 저장(§12-5-3·§12-5-4·§12-5-6), Firestore 본문의 `testFills` 감싸기(§12-3), 잠금 화면 ⏸ 뒤 바인딩 유지·Wake Lock 범위·긴 범위 이어서 준비(§12-5-2), 연습 비용 캡션·다시 연 pending의 "사진 없이 시작"(§12-7-2·§12-7-3), 새 파일·함수 이름(§12-5-9), eval 항목 수(§12-10).
>
> 2026-10-02 **템플릿 중심 재정렬**(§12-13 — 같은 날 스펙 → T15 → T13·T14 구현 → 통합 QA(P1·P2 0)까지 마쳤다. 구현이 정한 동작·남은 틈은 §12-13-7). 사용자 목표: "시험장에서 1초의 망설임도 없이 연습한 템플릿대로". 같은 날 틀 은행을 **같은 자리 중복 정리**(152 → 108틀 — 자리마다 앱 순서 맨 위 틀 하나, 지운 틀의 교재 연결은 `coveredBy`가 있는 건너뜀으로)한 뒤, 폴더의 나머지 셋을 템플릿 훈련에 맞춘다. ① 공략 읽기 — 외울 틀 줄을 강조하고 같은 자리의 다른 표현은 접어 읽기·듣기에서 뺀다(§12-13-1). ③ 표현 시험 → **틀 시험**(한→영·영→뜻 5지선다, 고정 낱말 빈칸 — §12-13-2). ④ 한 문제 연습 + **실전 모의고사** — 모범답변을 답변 흐름의 단계마다 틀로 조립하고, AI 피드백도 틀로 고쳐 주며, "🧩 틀 점검"을 모의고사에도 보인다(§12-13-3). 이 재정렬이 옛 문장을 대체하는 곳(§12-0·§12-1·§12-6·§12-7-2·§12-7-7·§12-7-9 등)에는 그 자리에 "2026-10-02 대체" 표시를 남겼다 — 옛 문장은 지우지 않고 무엇이 바뀌었는지 남긴다.

### 12-0. 배경과 결정

사용자 요구(2026-09-27): 토익스피킹 교재의 **질문 유형별 공략 쪽**(사진 30장 — Q3–4 · Q5–7 · Q8–10 · Q11, Q1–2는 단순 읽기라 없음)으로 "유형별로 나눠 공부할 수 있게", 특정 유형만 **한 문제씩 모의 연습**, 교재 내용을 **읽어 주는** 기능. 같은 날 추가 요구: "문장을 새로 만들 거면 최대한 다양하게 활용 가능한 템플릿으로 문장들을 만들어서 템플릿에 익숙해지게", "템플릿을 반복 사용하는 게 핵심", "강의 자료의 템플릿과 우리 기존 템플릿이 다르면 우리 기존 템플릿에 최대한 맞춰". 아래 표에서 "사용자 확정"은 오케스트레이터가 사용자에게 확인한 것, "기본값"은 이 스펙이 정한 것이다(바꾸면 이 표부터 고친다 — 사용자에게 올릴 것은 §12-12).

| 항목 | 결정 | 출처 | 근거 |
|---|---|---|---|
| 자리 | 허브 **"🎙️ 아빠의 영어"(`/toeic`)는 그대로**, 그 안에 세 번째 기능 **"토익스피킹 유형별 공략"**(`/toeic/guides`)과 유형 폴더 4개 | 사용자 확정 | 표현집·모의고사와 나란히 선 독립 기능(§0-4와 같은 관계) |
| 폴더 안 기능 | 폴더마다 넷 — ① **공략 읽기 + 🔊** ② **템플릿 훈련**(따라 말하기 · 테스트) ③ **표현 말하기 시험** ④ **한 문제 연습**. 순서는 학습 흐름(읽고 → 틀을 입에 붙이고 → 표현을 확인하고 → 실전에 조합)이고, 폴더를 열면 틀이 있는 유형은 ② 탭이 먼저 열린다(§12-8). 2026-10-02: 네 기능이 모두 틀 은행을 중심으로 돈다 — ① 외울 틀 강조·대안 접기, ③ **틀 시험**, ④ 답변 흐름 조립(§12-13) | 사용자 확정(①③④) + 업그레이드(②, 순서) | ②가 "템플릿 반복이 핵심"의 자리다. ①③④는 원래 셋 |
| 학습 단위 | **틀**(바꿔 끼울 `{자리}`가 있는 문장 뼈대). 틀마다 **주제가 다른 예문 3~5개** — 예문 = 틀에 채움(`fills`)을 넣은 결과와 글자까지 같다(zod). 숙련도·"틀린 것만 다시"도 **틀 단위**로 센다(§12-5-6) | 사용자 요구 | 문장 하나를 외우면 그 문장만 나온다. 같은 뼈대를 주제만 바꿔 여러 번 말해야 새 질문에 뼈대가 먼저 나온다 |
| 틀의 출처와 정렬 | 같은 기능의 틀이 교재(표현 목록의 `~` 틀 · 템플릿 블록의 단계 · 이어 말하기 머리말)에 있으면 **교재 틀의 고정 부분을 글자 그대로** 쓰고 `~`만 `{자리 이름}`으로 바꾼다(`source:"guide"` + `guideRefs`, zod가 고정 부분 포함을 확인). 교재에 없는 기능만 새 틀(`source:"new"`)로 채우고 교재 문체를 따른다. **교재 쪽 정렬 대상(자리 표현·답변 틀 단계·이어 말하기 머리말)은 하나하나 틀에 연결되거나, 건너뜀 목록에 이유와 함께 올라야 한다** — 빠짐이 하나라도 있으면 가져오기가 400이다(§12-2-7). 표시 순서는 교재가 가르치는 **답변 흐름의 단계**와 그 밖의 **소재 묶음**(§12-2-7 `flows`) | 사용자 확정 + 검토 반영(빠짐 0) | 강의 틀과 교재 틀이 다르면 교재에 맞춘다(사용자). "교재에서 배운 틀 = 앱에서 훈련하는 틀"이 화면에 보여야 한다 — 연결을 알림 eval로만 세면 빠진 채로 들어간다(검토: 연결 0인 머리말이 있었다). 교재에서 옮기는 것은 짧은 틀 부분뿐이고 예문은 새로 쓴다 — 교재 예문·모범답변·해석은 옮기지 않는다 |
| 틀 저장 | 여러 유형에 걸친 틀은 **한 벌만** — 틀 은행 문서 하나(`toeicSets` id `guide-templates`, `guide.kind:"templates"`)에 모두 두고, 각 유형 폴더는 틀의 `parts`로 골라 보인다. 숙련도도 한 벌이다(§12-3) | 기본값 | 유형마다 복사하면 같은 틀의 숙련도가 폴더마다 따로 쌓이고, 교정이 한쪽에만 들어간다 |
| 따라 말하기 | 예문마다 **한국어 1번 → 영어 N번**(기본 4, 1~4) + 영어마다 **따라 말할 틈**(문장 길이에 비례). 틀 하나의 예문을 이어서 — 같은 틀이 주제만 바뀌며 되풀이된다. 공용 `speakQueue`에 조각 뒤 쉼(`pauseAfterMs`)을 더한다(§12-5-2) | 사용자 요구(참고 자료의 방법) | §12-12 8(옛 번호 §12-11 8) "쉼을 두지 않는다"를 뒤집는다 — 이 기능은 쉼 없이는 성립하지 않는다 |
| 잠금 화면·주머니 재생 | 따라 말하기는 **화면을 끄거나 잠가도 이어지는 것을 목표로 한다**. 쉼은 JS 타이머가 아니라 **같은 큐 오디오 요소로 트는 무음 조각**이다. ▶ 전에 고른 범위의 조각을 미리 받아 두고(`prepareSpeech` — "준비 n/m"), 잠금 화면 ⏯·⏭·⏮는 이 플레이어에서만 Media Session으로 받는다(§12-5-2) | 검토 반영 — 선택지 (가) | 폴더 하나가 2~3시간이고 가장 자연스러운 쓰임은 이어폰을 낀 출퇴근이다. iOS는 화면이 잠기면 JS 타이머를 멈춘다(SPEC §18-2). 무음 조각이면 오디오 세션이 끊기지 않고 `ended` 사슬로 이어진다. 기기 음성 폴백 조각에서는 멈출 수 있다(알려진 한계). 실기기에서 (가)가 성립하지 않으면 (나) "화면 켠 채 + 주머니 모드"로 간다(§12-12 23) |
| 테스트 | 두 종류 — (가) **예문 말하기**(한국어 뜻만 보고 외운 예문을) (나) **틀 바꿔 말하기**(영어 글자 없이 — 다른 예문을 소리로만 듣고, 한국어 틀 + **대본에 없던 영어 채움**으로 새 문장을). 말하기 → 녹음(기기) → **받아쓰기**(관문 T) → 정답과 **단어 단위 자동 비교**(틀 고정 부분과 자리를 따로) → **최종 ○/✕는 아빠가 정한다**. 판정은 **정답을 보기 전의 첫 유효 시도**로 한다. 문장당 전사 1회(전사가 실패·빈 전사일 때만 다시 말하기 1회까지) | 사용자 확정 + 검토 반영((나)·첫 시도) | 자기 채점만으로는 "대충 비슷하게 말했다"를 맞았다고 넘기기 쉽다. 전사는 발음이 서툴면 다른 단어로 적히므로 자동 판정을 최종으로 두지 않는다. 틀을 보여 주거나 정답을 들려준 뒤의 말하기는 테스트가 아니라 읽기·따라 말하기다 — 그 결과로 졸업하면 "익힘" 숫자가 거꾸로 선다 |
| 실전 적용 | 한 문제 연습(④)의 **기존 입력 경로**로 틀을 넘긴다 — `pickExpressionsForDrill`이 그 유형 틀을 `~` 형태로 바꿔 "활용할 표현" 앞쪽에 둔다(호출 C·D 프롬프트 변경 0). 결과 화면에 "내 답에서 쓴 틀 / 쓸 수 있었던 틀"(AI 없음 — 전사문에서 틀 고정 부분을 찾는 순수 함수). **2026-10-02 대체**: 틀은 "활용할 표현"이 아니라 새 입력 **답변 흐름**(단계마다 외울 틀)으로 넘기고, 모범답변은 그 흐름으로 조립한다. 실전 모의고사에도 넘기고 호출 C·D 프롬프트를 바꾼다(§12-13-3) | 사용자 요구 + 기본값(방법) → 2026-10-02 사용자 확정 | 외운 틀을 처음 보는 문제에 꺼내 쓰는 연습. 호출 C의 "활용할 표현을 자연스러우면 모범답변에 녹인다"와 호출 D의 `tryExpressions`가 이미 있다(§4-1·§5-1) |
| 교재 반입 | Claude가 사진을 전사해 `data/private/`(git 밖)에 두고 **앱의 "파일로 가져오기"**로만 넣는다. 앱에서 사진을 올려 AI가 판독하는 경로는 **만들지 않는다** | 사용자 확정 | OpenAI 비용 0, 공개 저장소 원칙(§7-6과 같은 방식). 공략 쪽은 표·틀·팁이 섞인 자유 구조라 호출 A(표현 암기장 판독)로 읽을 수 없다 |
| 연습 문제 | **AI가 매번 새로 만든다.** 교재 예시 문제를 쓰지 않는다 | 사용자 확정 | 같은 문제를 반복하면 답을 외운다. 기출 저작권(§0-2) |
| 연습 생성기 | **호출 C 파트 생성기를 그대로** 부른다(프롬프트·스키마 변경 0). 2026-10-02: 생성기는 그대로 하나이고, 그 프롬프트(머리말·사용자 메시지 형식)에 답변 흐름이 더해졌다 — 연습과 모의고사가 같은 원문을 쓴다(§12-13-3) | 기본값 | C는 이미 파트 하나 = 호출 하나다(§4-0). 새 프롬프트를 만들면 spec-sync·zod·eval이 두 벌이 된다 |
| 연습 단위 | Q3–4 **사진 1장**, Q5–7 **세 문항 한 묶음**, Q8–10 **표 + 세 문항**, Q11 **한 문항**(§12-7-1) | 사용자 확정 + 기본값(근거) | "한 문제씩"을 따르되, 앞 문항의 상황·표를 뒤 문항이 이어받는 유형은 실전 묶음을 쪼개지 않는다 |
| 저장 | **새 컬렉션 없음.** 공략 = `toeicSets` 문서(필드 `guide`), 틀 은행 = `toeicSets` 문서 하나(같은 필드 `guide`의 다른 종류), 템플릿 테스트 기록 = `toeicQuizzes`(틀 모드 둘), 연습 = `toeicMocks` 문서(필드 `drillPart`) | 기본값 | 표현 시험·응시·채점·스트릭 코드가 이 컬렉션들에 매달려 있다 — 재사용하면 채점 라우트·스트릭 계산식 변경이 0이다(§12-3) |
| 공략 표현 시험 | 파일이 **표현 목록(`expressions`)과 말하기 문항(`speak`)을 명시적으로** 준다. 읽기 본문에서 자동으로 뽑지 않는다. 표현은 답변에 꺼내 쓸 **틀**(`~` 자리)이고, 머리말 + 이어 말하기 조각은 합성한 완성 문장으로 **말하기**에 간다(§12-2-1). **2026-10-02 대체**: 유형 폴더의 표현 시험(5지선다·교재 문장 말하기) 화면을 닫고 ③을 **틀 시험**으로 바꾼다(§12-13-2). 파일의 `expressions`·`speak`는 그대로 받는다 — 교재 연결·정렬 대상·연습의 활용할 표현이 쓴다 | 기본값(검토 반영) → 2026-10-02 사용자 확정 | 공략 줄에는 슬래시 대안·`~` 자리·긴 예문이 섞여 있어 5지선다 보기나 80자 표현 규칙(§2-4)에 그대로 맞지 않는다. 그래서 사람이 고른 목록만 시험에 쓴다. 표현 문자열이 숙련도 키라 **첫 가져오기 전에** 정한다 |
| 연습 뒤 복습 | 연습 결과 화면이 묘사 포인트(Q3–4 `keyPointsKo`)·답변 뼈대(Q11 `outlineKo`)를 모범답변 접기 안에 보인다. 연습에서는 "학습 보기로" 버튼을 숨긴다. 학습 보기 리다이렉트는 무조건 그대로다(§12-7-5) | 기본값(검토 반영 — 선택지 (나)) | 리다이렉트를 "응시 전"으로 좁히면(선택지 가) 연습 문서가 모의고사 학습 보기에 열린다. 그러면 다른 파트 "자료 없음"·다시 만들기 버튼(409)이 섞여 보인다. 두 필드는 이미 결과 화면 자료(`ToeicQuestionView`)에 실려 있어 새 데이터 경로가 없다 |

### 12-1. 구성 한눈에

| 기능 | 무엇을 쓰는가 | AI | 새로 두는 것 |
|---|---|---|---|
| 가져오기 | 새 형식 `toeic-guides/v2`(유형 공략 + 틀 은행) → 새 라우트 `POST /api/toeic/guides/import` | 0 | zod(`lib/ai/toeic/schemas.ts` 안 — 틀 zod 포함), 스토어 메서드 `upsertToeicGuides`(틀 은행도 같은 원자 단위), 멱등·교정 판정 순수 함수(`lib/ai/toeic/guide-import.ts` — `planToeicGuideImport`·`decideGuideUpsert`), Firestore 본문 코덱 `lib/toeic-firestore-codec.ts`(§12-3) |
| ① 공략 읽기 + 🔊 | `speakQueue`·`speak`·`prefetchSpeech`·`splitForTts`·`normalizeKoForTts`(SPEC §18 관용구) | 0 (발음만) | `lib/toeic-guide.ts`(클라이언트 안전): 대본 순수 함수 `buildToeicGuideScript`, 줄의 읽을 영어 `guideLineEn`(이어 말하기 합성), TTS 정리 함수 둘, 강조·밑줄 분할 함수. "영어만"의 따라 말할 틈(§12-4)과 틀로 가는 🧩 칩. **2026-10-02**: "🧩 외울 틀" 줄 강조와 "같은 자리 다른 표현" 접기(`guideReadMarks`, 대본 옵션 `skip`), 틀 은행 문서의 `alternates`(§12-13-1) |
| ② 템플릿 훈련 | 틀 은행(§12-3) · `speakQueue`(쉼 추가) · `prefetchSpeech` · 녹음 `lib/mic-session.ts` · WAV 변환 `toWav16kMono` · 관문 T `transcribeAnswer` · 숙련도 `aggregateWordStats`(표현 시험의 약함 순위·세션 어댑터를 공개해 그대로 — `lib/toeic-quiz.ts`) · Wake Lock `useToeicWakeLock` | 전사만(테스트 문항당 1회, 버튼 흐름 안) — 호출 A~D 0 | `lib/toeic-template.ts`(클라이언트 안전 — 틀 채우기·`~` 형태·따라 말하기 대본·쉼 계산·예상 시간·테스트 문항 고르기·전사 비교·전사문 속 틀 찾기·단계 커버리지·숙련도 어댑터), 라우트 둘(`…/templates/transcribe` 전사만 · `…/templates/sessions` 기록 저장), 테스트 페이지, 공용 `lib/speech.ts`에 넷(`speakQueue`의 `pauseAfterMs`·`onPause` — 무음 조각으로 재생, 범위 미리 받기 `prepareSpeech`, 무음 WAV 생성기 `makeSilentWav(ms)` — 옛 0.1초 생성기에 길이 인자, 실제 말 속도 배율 `getSpeechSpeedFactor` — 예상 시간과 큐가 같은 배율을 쓴다), 단어 정렬 코어 `alignWordSeq`(`lib/toeic-score.ts`에서 뽑는다 — `alignReadAloud` 결과 불변, 틀 비교만 선택 인자 `substitutionCost` 2 — §12-5-5), 잠금 화면 조작 관문 `lib/media-session.ts`(따라 말하기 플레이어에서만), 화면 판단 순수 모듈 `lib/toeic-guide-view.ts`·`lib/toeic-template-test-view.ts` |
| ③ 표현 말하기 시험 | 시험 러너·오답노트·기록 화면, `toeicQuizzes` | 0 | 말하기 세션의 문항 순서 옵션(`quizOrder`), 5지선다 한 판 상한 옵션(`max`), 틀로 가는 🧩 칩. **2026-10-02 대체 → ③ 틀 시험**(§12-13-2): 새 모드 셋(`toeicQuizzes`, 틀 은행 세션), 새 순수 모듈 `lib/toeic-template-quiz.ts`, 새 페이지 `/toeic/guides/[part]/templates/quiz`, 기록 라우트는 기존 `…/templates/sessions` 그대로(모드 넓히기) |
| ④ 한 문제 연습 | 호출 C(파트 하나) · 관문 P(사진 1장) · 응시 화면 · 녹음 · 관문 T · 호출 D · 결과 화면 | C·P(만들기), T·D(채점 버튼) | 라우트 `POST /api/toeic/guides/[part]/drills`. 응시 기록 필드 `questions`. 새 함수는 세 곳에 나뉜다(§12-7-1) — `lib/toeic-drill.ts`(클라이언트 안전: 단위표·`toDrillRecordPart`·`nextToeicDrillTitle`·주제 풀), `lib/toeic-mock.ts`(지시문 변형 `toeicPartDirections`), `lib/ai/toeic/mock.ts`(**서버 전용**: `pickExpressionsForDrill` — 틀을 앞에 둔다, §12-7-9). 결과 화면의 "🧩 틀 점검"(§12-7-9). 연습 탭·"뒤로"·틀 점검 자료의 화면 판단은 `lib/toeic-drill-view.ts`(클라이언트 안전). **2026-10-02**: 답변 흐름(`buildAnswerFlow`·`formatAnswerFlow`)·모범답변 점검(`checkAnswerAgainstFlow`)·레코드 `answerFlows`, 실전 모의고사에도 같은 입력·틀 점검(§12-13-3) |

### 12-2. 교재 반입 — "파일로 가져오기" (`toeic-guides/v2`)

> 형식 이름: 초안의 `toeic-guides/v1`(배포 전 — 받는 코드가 없었다)에 최상위 `templates`(틀 은행, §12-2-7)를 더한 것이 **`toeic-guides/v2`**다. 가져오기 라우트는 v2만 받는다(v1 파일은 400 — "형식이 바뀌었어요, 파일을 다시 만들어 주세요"). `data/private`의 v1 파일은 변환 때 v2로 다시 만든다(유형 공략 부분은 그대로, `format`만 바꾸고 `templates`를 더한다).

#### 12-2-1. 파일이 사는 곳과 만드는 법

- 전사 원본: `data/private/toeic-strategy/raw/{q3-4,q5-7,q8-10,q11}.json`(형식 `toeic-strategy-raw/v1` — Claude가 사진을 직접 판독, OpenAI 0). 유형별 정리본: `data/private/toeic-strategy/parts/{…}.json`(원본을 아래 규칙으로 옮긴 유형 하나씩 — 가져오기 항목 모양). **틀 원본**: `data/private/toeic-strategy/core/templates.json` **한 파일**(형식 `toeic-core-raw/v3` — Claude가 새로 쓴 틀·예문·흐름·정렬 건너뜀, §12-2-7). 같은 폴더의 `core/{q3-4,q5-7,q8-10,q11}.json`(옛 형식 `toeic-core-raw/v2`)은 처음 틀을 쓸 때의 **작업 파일**이다 — 변환 입력이 아니고, 고치지도 읽지도 않는다. 가져오기 파일: `data/private/toeic-strategy/toeic-guides.json`(아래 형식 — 유형 4개와 틀 은행을 한 파일에). **모두 git 밖**이다(`data/`는 gitignore, `.gcloudignore`도 제외). `public/`에 두지 않는다(정적 확장자는 PIN 게이트 예외).
- 원본 → 가져오기 파일 변환은 Claude가 한다(스크립트를 저장소에 두지 않는다 — 변환 규칙만 여기 적는다).
- 원본의 모양(2026-09-27 실측 — 개수만, 검토 두 건의 재집계 반영). 이 숫자는 eval에 리터럴로 잠그지 않는다(전사를 고치면 바뀐다).

| 항목 | 개수 |
|---|---|
| 쪽·사진 | 29쪽 · 사진 30장 |
| 블록 | `section` 14 · `subheading` 35 · `table` 52 · `other` 14 · `steps` 8 · `template` 3 · `tip` 5 · `question` 11 · `sample` 3 · `translation` 1 |
| 표 형식 | 틀+예문 12표(머리말에 `~`) · **머리말+이어 말하기 20표·93행**(Q3–4 12표·65행 — 원본에 `form`이 있다, Q5–7 8표·28행 — `form`이 없다. 머리말과 이으면 69자 이하) · 문장 목록. 표 행은 모두 185개 |
| 영어 줄 길이 | 최장 168자 · 80자 초과 5줄(행·머리말 기준, 예문까지 11줄) · 300자 초과 0 |
| 자리 표시 | 영어 `~` 34줄(행·머리말 — Q3–4 13 · Q5–7 9 · Q11 12) · 한국어 `~` 62줄(56줄은 바로 뒤에 조사) · en dash `–` 목적어 자리 영어 4줄·한국어 4줄(Q3–4) · 공식 표기 `+` 영어 2줄·한국어 1줄(Q5–7) |
| 영어 줄 안의 한국어 | 18줄 — **괄호 없는 맨몸 자리 이름 16줄**(Q8–10 5 · Q11 11) · 괄호 속 자리 이름 1줄 · 괄호 속 한국어 메모 1줄(Q8–10). 그 밖에 Q11 예시 답변의 열 머리 1개 |
| 괄호 속 영어 | **대안** 10줄(Q3–4 단어에 붙은 소괄호 8 · Q11 대괄호 2) · **생략 가능 단어** 12줄(Q8–10 숫자·날짜 읽기, 띄어 쓴 소괄호) |
| 슬래시 대안 | 18줄. 뜻이 같은 문법 변형, 조건에 따라 갈리는 변형, 어휘 대안이 섞여 있다 |
| 강조 | `signals` 138 · 질문 밑줄 `underline` 8 · 템플릿 단수 `signal` 11(전부 그 줄 영어의 부분 문자열) |
| 손 표시 | Q3–4만. 줄 단위 82(표 행 65 · 머리말 12 · 템플릿 행 4 · steps 행 1) · 블록 단위 5(steps 항목 4 · 섹션 1) |

- 변환 규칙 — 블록:

| 원본 | 가져오기 파일 |
|---|---|
| `section`(번호·제목·소개) | 섹션 `{label, titleKo, introKo, groupKo}` |
| 파트 띠(`section`의 `level: "banner"` — Q3–4 2개, 이름만 있다) | 섹션을 만들지 않는다. 띠 이름은 그 띠 뒤 섹션들의 `groupKo`가 된다(목차 칩을 무리로 나눈다). 둘째 띠 바로 뒤의 라벨 달린 `other`는 다음 섹션의 첫 블록으로 옮긴다 |
| 유형 제목 `other`(Q5–7·Q8–10·Q11의 첫 블록 — 폴더 이름과 같다) | 버린다. 파일의 유형 소개 `introKo`는 원본에 유형 전체를 소개하는 문장이 있을 때만 쓰고, 없으면 null |
| `subheading` | `heading` 블록(한글이 없는 영어 제목이면 줄 하나짜리 `lines` 블록) |
| `table` — 틀+예문(`form: "pattern+examples"`, 머리말에 `~`) | `lines` 블록 `style: "list"` — 캡션 → `captionKo`, 머리말 → `lead`, 행 → 줄, 행에 딸린 예문 → 줄의 `example` |
| `table` — 머리말+이어 말하기(`form: "lead+completions"`, 또는 `form`이 없고 아래 판정에 맞는 표) | `lines` 블록 **`style: "completions"`** — 머리말 → `lead`(en·ko 둘 다), 행 → 조각 줄(en·ko). 조각을 머리말 뒤에 붙인 **완성 문장**이 읽기·🔊·따라 말하기의 단위다(§12-4) |
| `table` — 문장 목록 | `lines` 블록 `style: "list"`(`lead` 없음) |
| 이어지는 표(`continued: true`) | 앞 쪽의 같은 표 블록에 줄을 이어 붙인다(블록 하나) |
| `template` | `lines` 블록 `style: "template"`. 행 라벨 → `label`. 단수 `signal` → `emphasis: [signal]`. 자리 이름(`slot`) → 그 줄 `en` 끝의 `{slot}` — 영어에 이미 자리가 보이면 넣지 않고, `note`에 같은 글을 다시 적지 않는다. 비고·조건(`note`·`condition`) → `note`(" · "로 잇는다). "또는"(`or: true`)과 같은 `no`의 두 번째 행 → `alt: true`. 열 머리(`columns` — Q11 예시 답변의 메모 열·답변 열)는 옮기지 않는다. 메모 열 글이 있는 줄은 `note` 앞에 "메모: "를 붙인다 |
| `tip`·`other`·`steps`의 항목 | `text` 블록 — 라벨 → `label`, 항목 제목 → `titleKo`, 한국어 설명 → `bodyKo`, 딸린 행 → `lines`. 공식 두 줄 `other`(Q5–7, `+` 표기)는 `bodyKo` 한 칸에 줄바꿈을 지켜 넣는다(화면은 `white-space: pre-line`) |
| `translation`(Q11 예시 답변 해석 한 덩어리) | 문장 대응이 분명하면 예시 답변 줄들의 `ko`로 나눈다(줄마다 영어 → 한국어로 이어 읽힌다). 분명하지 않으면 `text` 블록 `bodyKo`로 둔다 |
| `question`·`sample`(교재 예시 문항) | `lines` 블록의 줄(`label`에 문항 표시) — 의문사 강조(`signals`) → `emphasis`, 되받아 쓸 구간(`underline`) → 줄의 **`underline`**. **읽기 자료로만** 쓴다 — 한 문제 연습에는 쓰지 않는다(§12-0) |
| 강조 `signals` | 줄·예문의 `emphasis`(부분 문자열 그대로) |
| 손으로 표시한 줄(행·머리말·템플릿 행·steps 행의 `handMarked`) | 줄(머리말이면 `lead`)의 `marked: true`. 글자는 옮기지 않는다 — 손글씨 메모는 교재 원문도 아니고 전사하지 않는다. **블록·섹션 단위 표시**(steps 항목 4 · 섹션 1)는 버린다. ✎는 줄 머리 표시라 담을 칸이 없고, 시험·대본에도 영향이 없다 |
| MP3 트랙 번호·쪽 번호·사진 출처·행의 `line`(쪽 위 줄 번호) | 버린다(앱은 교재 음원을 쓰지 않는다) |
| 판독 불확실(`uncertain`)·앞이 잘린 글(`truncatedStart`) | 사진을 다시 보고 확정한 것만 넣는다. 확정하지 못한 **칸만** 뺀다. 섹션·블록을 통째로 빼지 않는다 — 섹션 머리가 불확실하다고 섹션을 빼면 뒤따르는 표가 전부 사라진다. 필수 칸(섹션 `titleKo`)이 끝내 불확실하면 지어낸 일반 제목(예 "공략 2")으로 둔다. 내용이 잘린 안내 `other`는 뺀다. 가져오기 형식에는 불확실 표시가 없다(앱에 사람이 고칠 검토 화면이 없다) |

- **머리말+이어 말하기 판정**(원본에 `form`이 없을 때 — Q5–7). 다음을 모두 만족하면 `completions`, 아니면 `list`다.
  - 머리말이 있다.
  - 머리말 영어에 `~`·자리 이름이 없다.
  - 머리말 영어가 문장부호로 끝나지 않는다.
  - 모든 행 영어가 소문자로 시작한다.

  원본 20표가 모두 이 판정으로 갈린다(2026-09-27 확인). 틀+예문 12표는 머리말에 `~`가 있고 행이 대문자로 시작한다.
- 변환 규칙 — **읽기 본문** 영어 줄(`en`) 안의 괄호·자리 표시(표현·예문·말하기는 아래 별도 규칙):

| 원본 표기(지어낸 예) | 뜻 | 가져오기 파일 | 소리(§12-4) |
|---|---|---|---|
| 단어에 붙은 소괄호 `upper(lower) shelf` · 대괄호 `I support[oppose] ~` | (a) **영어 대안** | 슬래시 대안 `upper/lower shelf` · `I support/oppose ~`. 대괄호는 남기지 않는다(zod가 거부) | "upper, lower shelf" — 나열 |
| 띄어 쓴 소괄호 `two thousand (and) five` | (b) **생략 가능 단어** | 그대로 둔다 | 괄호를 떼고 안의 말을 읽는다 |
| 괄호 속 한국어 설명(자리 이름이 아닌 것 — "또는 …" 같은 메모) | (c) **한국어 메모** | `en`에서 빼서 그 줄 `note`로 | 읽지 않는다(`note`) |
| 괄호 속 한국어 자리 이름 | 자리 | `{자리 이름}`(괄호를 뗀다) | "…" 쉼 |
| 괄호 없이 영어 줄에 섞인 한국어 자리 이름 `The tour starts from 출발 장소` — 대부분이 이 모양이다 | 자리 | `The tour starts from {출발 장소}` | "…" 쉼 |
| en dash `–` 목적어 자리 `put – on the rack` | 자리 | 영어 줄은 `put {대상} on the rack`(들어갈 것이 분명하면 그 이름 — 예 `{물건}`), 한국어 줄은 `~` | "…" 쉼 |
| 공식 표기 `+` — `What + do you ~?` | 짜임 공식 | 영어 줄(`en`)에 두지 않는다. 공식 블록은 `text` 블록 `bodyKo`로 옮긴다(위 표) | 한국어 정리가 `+`를 쉼표로 읽는다("플러스"로 읽지 않게) |
| 슬래시 `/`(읽기 본문) | 대안 | 그대로 | 나열 |

- **표현 목록(`expressions`)은 사람이 고른다 — 답변에 꺼내 쓸 "틀"이다.** 표현 문자열이 숙련도 키라서(§6-1) 교정하면 기록이 새로 시작한다(§12-2-5). 그래서 아래 규칙은 **첫 가져오기 전에** 정한다.
  - **고르는 곳**: 틀+예문 표의 머리말(`~` 자리 틀), 템플릿 줄, 틀로 쓸 수 있는 목록 줄. **머리말+이어 말하기 조각은 표현에 넣지 않는다.** 조각만 넣으면 5지선다가 장소·동작 단어 뜻 맞히기로 떨어지고, 머리말만 넣으면 너무 넓다(주어 + be동사). 조각은 합성 문장으로 말하기에 간다(아래). 그러면 연습의 "활용할 표현"(§12-7-2)도 새 장면에 쓸 수 있는 틀 목록이 된다. 호출 C의 모범답변과 호출 D의 `tryExpressions`가 장면과 무관한 교재 문장을 권하지 않는다.
  - **자리 표시는 `~` 하나로 적는다.** 표현·예문에는 `{…}` 슬롯·en dash를 남기지 않는다. 한글 자리 이름이 남으면 `checkEntryText`의 한글 금지(§2-4)에 걸려 **파일 전체가 400**이다. 영어 슬롯(`{place}`)은 한글 검사는 통과한다. 하지만 5지선다 보기와 🔊와 호출 C 입력에 중괄호가 그대로 나가므로 zod가 거부한다(§12-2-3).
  - **대안(슬래시·괄호 대안)은 뜻으로 가르고, 표현·예문에는 `/`·`[`·`]`를 쓰지 않는다.** 이유는 셋이다.
    - 호출 C·D 사용자 메시지가 표현 목록을 `" / "`로 잇는다(§4-7·§5-2, `buildMockUserMessage`). 표현 안의 `/`는 목록 경계를 흐린다.
    - 모델이 반쪽만 되돌려 주면 `cleanUsedExpressions`·`postprocessFeedback`이 그것을 목록 밖으로 보고 버린다.
    - 5지선다 보기와 🔊에도 기호가 그대로 나온다.

    대안은 세 가지로 가른다.

    | 대안의 종류(지어낸 예) | 표현 항목 |
    |---|---|
    | 뜻이 같은 문법 변형 — 단수/복수 동사 `A box is/are placed ~` | 항목 **하나**, 대표형 하나로 적는다(교재가 먼저 적은 쪽). 변형은 읽기 본문에 남는다 |
    | 조건에 따라 뜻이 갈리는 변형 — 왼쪽/오른쪽, 정보 종류마다 다른 전치사 `at ~`(시각) / `on ~`(요일) | 항목을 나누고 `meaningKo`에 그 차이를 적는다. 서로 오답 보기로 나와도 맞다 — 고르는 것이 요점이다 |
    | 바꿔 써도 되는 어휘 대안 — `wrap up ~` / `finish ~` | 항목을 나누고, 서로의 `meaningKo`를 **글자까지 같게** 적는다. 출제가 같은 뜻(`matchKey`)을 오답 보기에서 빼므로(`buildOne`: 뜻 → 표현은 같은 뜻 항목의 표현을, 표현 → 뜻은 같은 뜻을 뺀다) 맞게 고른 답이 틀린 것으로 채점되지 않는다 |
  - 표현은 80자 이하이고 한국어 뜻을 붙인다. 예문이 딸린 줄이면 `example`/`exampleKo`를 함께 쓴다. 예문도 대안 없이 한 가지로, `{…}`·`/` 없이 적는다.
  - **60개(`TOEIC_SET_ENTRIES_MAX`)를 넘으면** 템플릿·틀 → 손 표시(`marked`) 줄 → 나머지(문서 순서) 순서로 고른다.
- **말하기 문항(`speak`)도 사람이 고른다.** 출처는 셋이다.
  1. 교재의 "영어 문장 + 한국어 해석" 짝(틀+예문 표의 예문 줄, 문장 목록, 예시 답변 줄): 해석이 문장을 그대로 옮긴 것만 쓴다. `promptKo`(해석) → `modelAnswer`(영어 문장).
  2. **머리말+이어 말하기(`completions`)의 줄**:
     - `modelAnswer` = 머리말 영어 + " " + 조각 영어. §12-4 `guideLineEn`과 같은 합성이다.
     - `promptKo` = 머리말 한국어 + " " + 조각 한국어. 기계적으로 이어 **자연스러운 한국어 문장이 될 때만** 넣는다(지어낸 예: "요리사 두 명이" + "빵을 자르고 있다." → "요리사 두 명이 빵을 자르고 있다."). "그대로 옮긴 해석만" 규칙은 이 경우에만 완화한다. 어순이 맞지 않으면 넣지 않는다 — 해석을 새로 짓지 않는다.
  3. (선택) **Q8–10 숫자·날짜·시각 읽기**:
     - `promptKo` = 표기 + 무엇인지(지어낸 예: "오후 4:15 (시각) 읽기").
     - `modelAnswer` = 읽는 법 한 가지. 괄호 속 생략 가능 단어는 넣지 않는다(지어낸 예: "four fifteen p.m.").
     - 숫자 읽기는 이 유형의 핵심이다. 그런데 연습할 것이 뜻이 아니라 소리라서 5지선다(뜻 ↔ 표현)로는 연습이 되지 않는다. 그래서 말하기로 연습한다. zod 변경은 없다 — `promptKo`에 한글이 있고 `modelAnswer`가 라틴 문자뿐이면 지금 규칙을 통과한다.
  - `modelAnswer`는 완성 문장이다. `~`·`{`·`}`·`/`·`[`·`]`를 쓰지 않는다(zod — §12-2-3).
  - 60개(`TOEIC_GUIDE_SPEAK_MAX`)를 넘으면 손 표시 줄 → 나머지(문서 순서) 순서로 고른다.
  - `no`는 1부터 매기고, **교정할 때 번호를 다시 매기지 않는다**(말하기 숙련도의 항목 키가 `quiz:{no}`다 — §12-6).

#### 12-2-2. 파일 모양

```ts
type ToeicGuidePart = "q3_4" | "q5_7" | "q8_10" | "q11";        // ToeicPart에서 q1_2를 뺀 것

interface ToeicGuideLine {
  label: string | null;          // 작은 머리표(예: "예", "①", "장소") — 화면 표시만, 읽지 않는다
  en: string | null;             // 영어. 자리 표시는 {자리 이름}(한글은 이 괄호 안에서만), 대안은 슬래시, 생략 가능 단어는 띄어 쓴 괄호(§12-2-1)
  ko: string | null;             // 한국어(해석·설명)
  note: string | null;           // 비고(조건·자리 설명·메모 등) — 화면 표시만, 읽지 않는다
  emphasis: string[];            // en 안의 강조 구간(부분 문자열 그대로) — 형광
  underline: string[];           // en 안의 밑줄 구간(질문에서 답에 되살려 쓸 말 — 부분 문자열 그대로). 화면 표시만, 대본 영향 없음
  alt: boolean;                  // 템플릿에서 "바로 위 줄 대신 이것도" (style "template"에서만)
  marked: boolean;               // 종이 교재에 손으로 표시한 줄
  example: { en: string; ko: string | null; emphasis: string[] } | null;   // 딸린 예문
}

type ToeicGuideBlock =
  | { kind: "heading"; textKo: string }
  | { kind: "text"; label: string | null; titleKo: string | null; bodyKo: string | null; lines: ToeicGuideLine[] }
  | { kind: "lines"; style: "list" | "template" | "completions"; captionKo: string | null; lead: ToeicGuideLine | null; lines: ToeicGuideLine[] };
  // completions: 줄은 lead 뒤에 붙는 조각이다 — 읽는 단위는 lead.en + " " + 줄 en(§12-4 guideLineEn)

interface ToeicGuideSection {
  label: string | null;          // 예: "공략 1", "STEP 2"
  titleKo: string;
  introKo: string | null;
  groupKo: string | null;        // 목차 칩 무리 이름(원본의 파트 띠) — 화면 표시만
  blocks: ToeicGuideBlock[];
}

interface ToeicGuideFileEntry {  // → ToeicSetRecord 하나(§12-3)
  presetKey: string;             // 멱등 키(§12-2-5)
  part: ToeicGuidePart;
  introKo: string | null;
  sections: ToeicGuideSection[];
  expressions: { no: number | null; expression: string; meaningKo: string; example: string | null; exampleKo: string | null }[];
  speak: { no: number; promptKo: string; hint: string | null; modelAnswer: string }[];
}

interface ToeicGuideFile {
  format: "toeic-guides/v2";
  guides: ToeicGuideFileEntry[];            // 0~4 — templates가 null이면 1~4
  templates: ToeicTemplateBankFile | null;  // 틀 은행(§12-2-7). null이면 저장된 틀 은행을 건드리지 않는다
}
```

예시(지어낸 문장 — 모양만 보인다. 틀 은행 `templates`의 예시는 §12-2-7):

```json
{
  "format": "toeic-guides/v2",
  "guides": [
    {
      "presetKey": "vendor-guide-q3-4",
      "part": "q3_4",
      "introKo": null,
      "sections": [
        {
          "label": "공략 1",
          "titleKo": "첫 문장은 장소",
          "introKo": null,
          "groupKo": "기본",
          "blocks": [
            { "kind": "heading", "textKo": "장소를 여는 틀" },
            {
              "kind": "lines", "style": "list", "captionKo": null,
              "lead": { "label": null, "en": "The scene is set {장소}.", "ko": "장면의 배경은 ~이다.", "note": null, "emphasis": [], "underline": [], "alt": false, "marked": false, "example": null },
              "lines": [
                { "label": "예", "en": "The scene is set on a crowded ferry deck.", "ko": "장면의 배경은 붐비는 여객선 갑판이다.", "note": null, "emphasis": ["on a crowded ferry deck"], "underline": [], "alt": false, "marked": true, "example": null }
              ]
            },
            {
              "kind": "lines", "style": "completions", "captionKo": "동작 이어 말하기",
              "lead": { "label": null, "en": "Two cooks are", "ko": "요리사 두 명이", "note": null, "emphasis": [], "underline": [], "alt": false, "marked": false, "example": null },
              "lines": [
                { "label": null, "en": "slicing bread.", "ko": "빵을 자르고 있다.", "note": null, "emphasis": ["slicing"], "underline": [], "alt": false, "marked": false, "example": null },
                { "label": null, "en": "wiping the counter.", "ko": "조리대를 닦고 있다.", "note": null, "emphasis": [], "underline": [], "alt": false, "marked": true, "example": null }
              ]
            },
            { "kind": "text", "label": "TIP", "titleKo": null, "bodyKo": "색이 여러 가지면 colorful 한 단어로 묶어 말해도 돼요.", "lines": [] },
            {
              "kind": "lines", "style": "template", "captionKo": "인물 묘사 틀", "lead": null,
              "lines": [
                { "label": "인물", "en": "A man is {동작} on the left.", "ko": "왼쪽의 남자가 ~하고 있다.", "note": null, "emphasis": [], "underline": [], "alt": false, "marked": false, "example": null },
                { "label": "인물", "en": "On the left, a woman is {동작}.", "ko": "왼쪽에서 여자가 ~하고 있다.", "note": "주어를 바꿔 말할 때", "emphasis": [], "underline": [], "alt": true, "marked": false, "example": null }
              ]
            }
          ]
        }
      ],
      "expressions": [
        { "no": 1, "expression": "The scene is set on ~", "meaningKo": "장면의 배경은 ~이다", "example": "The scene is set on a crowded ferry deck.", "exampleKo": "장면의 배경은 붐비는 여객선 갑판이다." }
      ],
      "speak": [
        { "no": 1, "promptKo": "장면의 배경은 조용한 온실이다.", "hint": null, "modelAnswer": "The scene is set in a quiet greenhouse." },
        { "no": 2, "promptKo": "요리사 두 명이 빵을 자르고 있다.", "hint": null, "modelAnswer": "Two cooks are slicing bread." }
      ]
    }
  ]
}
```

#### 12-2-3. zod 규칙 (`toeicGuideFileSchema` — `lib/ai/toeic/schemas.ts`)

기존 가져오기 zod(§7-6)와 **같은 모듈**에 둔다 — 표현·QUIZ 원문 판정(`checkEntryText`·`checkQuizText`·`checkUniqueNos`·`findDuplicateExpressionIndexes`)을 복사하지 않고 그대로 부르기 위해서다(규칙이 두 벌이면 어긋난다). 상한은 `TOEIC_GUIDE_*` 상수로 한 번만 정의한다. 가져오기는 저장과 같은 자리라 **판독보다 엄격하다** — 어긋나면 버리지 않고 거부한다. 모르는 키는 버린다(최상위·안쪽 모두 — zod 기본 동작).

- 최상위: `format`은 문자열 `"toeic-guides/v2"` 그대로(`toeic-sets/v1` 파일을 이 라우트에 넣으면 400, 반대도 400, 초안 형식 `toeic-guides/v1`도 400). `guides` 0~4개 — `templates`가 null이면 1~4개(빈 파일 금지). 파일 안에서 `part` 중복 금지, `presetKey` 형식·길이는 §7-6과 같은 상수(`TOEIC_PRESET_KEY_RE`·`TOEIC_PRESET_KEY_MAX`)이고 파일 안에서 중복 금지(틀 은행의 `presetKey`까지 한 집합으로 센다). `templates`의 규칙은 §12-2-7.
- `part`: `q3_4`·`q5_7`·`q8_10`·`q11`만(`q1_2`는 거부 — 이 기능에 Q1–2 폴더가 없다).
- 한국어 칸(`introKo`·`titleKo`·`textKo`·`captionKo`·`bodyKo`·`groupKo`, 줄의 `ko`, 예문의 `ko`): 비어 있지 않고 **한글 포함**(영어 단어가 섞여도 된다 — 팁 문장). 길이: `titleKo`·`textKo`·`captionKo` 1~80자, `groupKo` 1~30자 또는 null, `introKo` 1~600자, `bodyKo` 1~1200자, 줄·예문의 `ko` 1~300자. 줄의 `ko`에는 `{`·`}`를 쓰지 않는다.
- 영어 칸(줄의 `en`, 예문의 `en`)
  - 1~`TTS_TEXT_MAX_CHARS`자(`lib/tts-shared.ts`의 **같은 상수**를 import한다 — 숫자를 다시 적지 않는다. 줄 하나의 🔊가 한 조각이 되게 한다). **라틴 문자 포함**.
  - **한글은 `{…}` 슬롯 안에서만** 쓸 수 있다. 슬롯은 짝이 맞고 겹치지 않으며(`{a{b}}` 거부), 안이 1~20자다. 슬롯 밖의 `{`·`}`는 거부한다.
  - **대괄호 `[`·`]` 거부** — 영어 대안은 슬래시로 적는다(§12-2-1 괄호 표).
- `label`(섹션·`text`·줄) 1~30자 또는 null, `note` 1~120자 또는 null — 언어는 정하지 않는다(화면 표시만).
- 줄
  - `en`과 `ko` 중 하나 이상이 있어야 한다.
  - `emphasis`·`underline`: 각각 0~6개, 1~120자, **그 줄 `en`의 부분 문자열**(대소문자까지 그대로), 같은 배열 안 중복 금지, `{`·`}`를 포함하지 않는다. 두 배열이 겹치는 것은 된다(형광과 밑줄은 다른 표시다). `en`이 null이면 둘 다 빈 배열이다.
  - `alt: true`는 `style: "template"` 블록의 **첫 줄이 아닌** 줄에서만.
  - 예문(`example`)의 `en`은 줄 `en`과 같은 규칙이고, `emphasis`는 예문 `en`의 부분 문자열이다.
- **`style: "completions"` 블록**
  - `lead`가 있고 `lead.en`·`lead.ko`가 모두 있어야 한다.
  - `lead.en`에는 `{`·`}`·`~`가 없다(문장 앞부분이지 틀이 아니다).
  - 줄마다 `en`이 있어야 하고, `example`은 null, `alt`는 false다.
  - 합성 문장 `guideLineEn`(머리말 영어 + " " + 줄 영어, §12-4)이 `TTS_TEXT_MAX_CHARS` 이하다.
  - `list`·`template` 블록의 `lead`는 지금처럼 선택이다.
- 개수: `sections` 1~30, 섹션당 `blocks` 1~60, `lines` 블록의 `lines` 1~40, `text` 블록의 `lines` 0~40. `text` 블록은 `titleKo`·`bodyKo`·`lines` 중 하나 이상이 있어야 한다.
- 크기(**바이트**): 한 유형 항목 전체(파싱 결과 — `part`·`introKo`·`sections`·`expressions`·`speak`)를 `JSON.stringify`한 뒤의 **UTF-8 바이트 수**(`new TextEncoder().encode(…).length`)가 **900,000 이하**(`TOEIC_GUIDE_MAX_BYTES`)여야 한다.
  - 기준은 Firestore 문서 1MiB다. 이 한도는 글자 수가 아니라 UTF-8 바이트로 잰다. 한글은 한 글자가 3바이트라 글자 수로 재면 세 배를 놓친다(자유대화 keepalive P2-A와 같은 함정).
  - `sections`만이 아니라 `entries`·`quiz`가 될 두 목록까지 잰다. 원본 한 유형이 14~24KB라 여유는 충분하다.
  - 틀 은행은 **따로** 잰다(문서가 따로다 — §12-2-7). 파일 전체 크기를 한 번에 재지 않는다.
- `expressions` 1~60개(`TOEIC_SET_ENTRIES_MIN`·`MAX` — 세트 불변식과 같은 값)
  - 항목마다 `checkEntryText(…, {allowBlankMeaning: false})`를 **그대로** 부른다(표현 1~80자·라틴 포함·한글 금지, 뜻 1~80자·한글 포함, 예문 3~300자·라틴 포함·한글 금지, 예문이 null이면 해석도 null). `no`는 1~999 또는 null이고 중복 금지다. **세트 안 표현 중복은 거부한다**(`findDuplicateExpressionIndexes`).
  - 공략 쪽 superRefine만 더 건다: **`expression`·`example`에 `{`·`}`·`/`·`[`·`]` 거부**. 자리는 `~`, 대안은 항목으로 가른다(§12-2-1). `checkEntryText` 자체는 바꾸지 않는다 — 표현집 판독·가져오기 동작이 그대로다. 문구는 값 없이 "공략 표현에는 { } / [ ]를 쓸 수 없어요 — 자리는 ~, 대안은 항목을 나눠요" 같은 규칙만 쓴다.
- `speak` 0~60개(`TOEIC_GUIDE_SPEAK_MAX`)
  - `checkQuizText`(`promptKo` 한글 포함, `modelAnswer` 라틴 포함·한글 금지, `hint` 1~60자 또는 null)를 부른다.
  - 추가 규칙: **`no`는 null 금지**(1~999 정수)·중복 금지. `promptKo` 1~300자(줄 `ko`와 같은 상수). `modelAnswer` 1~300자, **`~`·`{`·`}`·`/`·`[`·`]` 거부**(완성 문장이다).
  - 파일에는 `keyExpressions`가 없고, 저장할 때 빈 배열로 둔다(§12-6).
  - 하한은 0 그대로다. 말하기 후보가 없는 유형도 가져올 수 있어야 한다 — 빈 상태 문구는 §12-6.
- **메시지에 값을 넣지 않는다**(§7-6·`schemas.ts` "zod 공통 판정" 규약 — 경로가 위치를 알려 준다). 400 본문은 순수 함수 `toeicGuideImportInvalidBody(issues)`(`lib/ai/toeic/schemas.ts`)가 만든다: `{ok:false, error:"invalid_input", messageKo, issues: toToeicIssues(issues, 20)}`(경로 + 규칙 문구만). 라우트는 이 함수를 그대로 쓰고, eval도 같은 함수로 누출을 검사한다(eval은 라우트 핸들러를 부르지 않는다).

#### 12-2-4. 표현 시험 목록을 가르는 법

읽기 본문(`sections`)과 시험 자료(`expressions`·`speak`)는 **파일에서 따로 적는다.** 시험은 `expressions`·`speak`만 보고, 본문의 어떤 줄도 시험에 자동으로 들어가지 않는다. 같은 글이 양쪽에 있어도 된다(본문 줄 하나와 표현 항목 하나). 이유는 §12-0 — 본문 줄은 보기로 쓰기에 길거나 대안이 묶여 있다. 그리고 자동 추출 규칙은 교재가 바뀌면 조용히 틀린다. 무엇을 어느 쪽에 적는지는 §12-2-1의 두 규칙(표현 = 틀, 말하기 = 완성 문장 — 이어 말하기 합성 포함)을 따른다.

#### 12-2-5. 멱등 키와 다시 가져오기(내용 교정)

전사는 나중에 틀린 곳이 발견된다. 교정하려고 지웠다 다시 넣으면 그 세트의 시험 기록이 연쇄 삭제되고(§7-3) 스트릭 과거가 사라진다. 그래서 공략은 표현집(§7-6 "있으면 건너뛴다")과 달리 **제자리 갱신**한다.

- 키는 `presetKey`다. `toeicSets` 전체가 한 네임스페이스이므로 표현집 키와 겹치지 않는 접두어를 쓴다(예 `vendor-guide-q3-4`). 유형 하나에 공략 세트는 **하나**다.
- **공략 세트의 문서 id는 결정적이다** — `guide-{part}`(예 `guide-q3_4`, 점 없음 — §12-8). "유형 하나에 하나"를 쿼리 잠금이 아니라 **문서 하나**로 보장한다. 같은 유형을 다른 `presetKey`로 동시에 가져와도, 문서 읽기 잠금과 생성 충돌(파일 `mutate`의 직렬화 / Firestore `tx.create` 실패 → 트랜잭션 재시도)이 한쪽을 `part_taken`으로 만든다. 쿼리 후 쓰기 관용구는 아직 없는 새 문서(phantom)를 막지 못할 수 있다. 표현집 세트 id는 지금처럼 무작위라 이 모양과 겹치지 않는다.
- 내용 지문 `contentHash` = 파싱된 항목(`part`·`introKo`·`sections`·`expressions`·`speak`)의 `JSON.stringify`(zod 출력 — 키 순서가 스키마 순서로 고정된다)에 대한 SHA-256(16진). 라우트가 계산하고, 판정은 순수 함수 `decideGuideUpsert`가 원자 단위 **안에서** 한다.

| 저장소 상태 | 결과 |
|---|---|
| 같은 `presetKey`가 없고, 그 `part`를 가진 공략 세트도 없다 | **created** — 새 세트 |
| 같은 `presetKey`의 공략 세트가 같은 `part`이고 `contentHash`가 같다 | **unchanged** — 쓰지 않는다(두 번 눌러도 한 번) |
| 같은 `presetKey`의 공략 세트가 같은 `part`이고 `contentHash`가 다르다 | **updated** — `guide`·`entries`·`quiz`·`titleKo`와 파생값 `enriched`(공략은 늘 false)를 함께 쓴다. `enriched`를 빼면 Firestore 부분 갱신에서 파생값이 저장값과 어긋날 수 있다(발화 포인트 병합 `mergeToeicSetPoints`와 같은 관용구). `id`·`createdAt`·`sortIndex`·`presetKey`는 그대로 두고, 시험 기록(`toeicQuizzes`)은 건드리지 않는다 |
| 같은 `presetKey`가 **표현집** 세트다 | 충돌 `preset_key_is_book` |
| 같은 `presetKey`의 공략 세트가 **다른 `part`**다 | 충돌 `part_mismatch` |
| 다른 `presetKey`의 공략 세트가 이미 그 `part`를 가졌다 | 충돌 `part_taken` |

- **틀 은행도 같은 표로 판정한다** — 틀 은행을 "유형 자리 하나"(`part` 자리의 값 `"templates"`, 문서 id `guide-templates`)로 보고 위 여섯 갈래를 그대로 쓴다. 같은 `presetKey`가 유형 공략 문서면 `part_mismatch`, 다른 `presetKey`가 이미 틀 은행이면 `part_taken`이다. 내용 지문은 파싱된 `flows`·`items`의 `JSON.stringify`에 대한 SHA-256이다. `alignmentSkips`(정렬 건너뜀 — §12-2-7)는 가져오기 검사에만 쓰므로 문서에 저장하지 않고 지문에도 넣지 않는다(건너뜀 이유만 고친 파일은 unchanged다). **2026-10-02 바뀜**(§12-13-1): 건너뜀 중 `coveredBy`가 있는 것을 `alternates`(`part`·`kind`·`ref`·`coveredBy` — 이유 글 없음)로 문서에 저장하고, 지문은 `flows`·`items`·`alternates`로 잰다. 그래서 코드 배포 뒤 **같은 파일을 한 번 다시 가져오면 틀 은행이 updated**(접기 자료가 처음 들어간다)이고 그다음부터 unchanged다. 이유 글만 고친 파일은 여전히 unchanged다. updated는 `guide`(틀 은행 전체)와 파생값만 쓰고, 틀 테스트 기록(`toeicQuizzes`의 틀 모드)은 건드리지 않는다. `templates`가 null이면 틀 은행 자리는 판정하지도 쓰지도 않는다.
- **충돌이 하나라도 있으면 파일 전체를 쓰지 않는다**(409). 일부만 들어간 공략은 사람이 알아채기 어렵다.
- 교정의 대가: 표현 문자열을 고치면 그 표현의 숙련도는 새로 시작한다(항목 키 = 표현, §6-1 — 옛 기록은 남지만 가리키는 항목이 없다). 말하기 문항은 키가 `quiz:{no}`라 문장을 고쳐도 기록이 이어진다(그래서 번호를 다시 매기지 않는다 — §12-2-1). 틀은 키가 `tpl:{key}`라 틀·예문 글을 고쳐도 기록이 이어진다 — **틀 `key`를 바꾸지 않는다**(§12-2-7). 틀을 파일에서 빼면 그 기록은 남지만 가리키는 틀이 없다(화면에 나오지 않는다).
- 확인과 쓰기는 한 원자 단위다(파일 `mutate` / Firestore `runTransaction`). 트랜잭션 안에서 **모두 읽은 뒤** 쓴다.
  - 파일에 든 유형들의 `guide-{part}` 문서와(틀 은행이 있으면) `guide-templates` 문서를 id로 읽는다 → `part_taken`·updated·unchanged 판정.
  - `presetKey`를 30개씩 `in`으로 읽는다 → `preset_key_is_book`·`part_mismatch` 판정.
  - 새 문서는 `tx.create`로 만든다(이미 있으면 실패 → 재시도 때 읽기가 그 문서를 본다).
  - 결정적 id라서 "문서 id를 트랜잭션 밖에서 미리 정한다"(§7-6 관용구)는 저절로 지켜진다.
- 지우는 경로를 새로 두지 않는다(교정은 다시 가져오기로 한다). 기존 `DELETE /api/toeic/sets/[id]`는 공략 세트에도 그대로 돈다(연쇄·prod-guard) — 화면에는 두지 않는다.

#### 12-2-6. 라우트와 원문 누출 방지

`POST /api/toeic/guides/import` — 본문 = 파일 JSON 그대로(화면의 `file.text()` → fetch 관용구, `components/toeic-set-library-view.tsx`와 같다). AI·키 검사·prod-guard 없음(생성·수정이다). 응답 shape 단일 정의처는 새 계약 파일 `lib/toeic-guide-contract.ts`.

- 200 `{ ok:true, created, updated, unchanged }` — 각각 `presetKey` 배열(파일 순서)
- 400 `{ ok:false, error:"invalid_input", messageKo, issues }` — `issues`는 경로 + 규칙 문구만(값 없음). 본문은 `toeicGuideImportInvalidBody`가 만든다(§12-2-3)
- 409 `{ ok:false, error:"guide_conflict", messageKo, conflicts: {presetKey, part, reason}[] }` — 키와 유형만 싣는다(교재 글이 아니다). 틀 은행 충돌이면 `part`가 `"templates"`다
- 500 `{ ok:false, error:"save_failed", messageKo }`

교재 원문이 새지 않게: 라우트는 본문·파싱 결과를 로그에 찍지 않는다(개수와 오류 이름만). 응답에는 키·유형·개수만 싣는다. eval은 가져오기 파일이 있으면 **개수만** 찍는다. 공략 글이 저장소 밖으로 나가는 곳은 세 군데뿐이다 — 🔊 합성(`/api/tts` → OpenAI, 기존 표현 카드와 같은 경로), 연습을 만들 때 "활용할 표현"으로 넘기는 **공략 표현 문자열**(`expressions[].expression` — 표현집 표현과 같은 선례, §4-0), 그리고 같은 자리로 넘기는 **틀의 `~` 형태**(`frameToExpression` — 교재 틀이면 고정 부분이 교재 글이다. 길이는 표현 한 줄과 같다, §12-7-9). (2026-10-02) 셋째는 자리가 **답변 흐름**으로 옮겨 연습과 실전 모의고사의 호출 C, 그리고 그 문서를 채점하는 호출 D에 나간다 — 틀의 `~` 형태와 **흐름 단계 이름**(`stepKo` — 교재 답변 틀의 단계 이름일 수 있다)뿐이다(§12-13-3). 예문·테스트 전용 채움·공략 본문은 여전히 넣지 않는다. **공략 본문(`sections`)과 틀 예문·테스트 전용 채움은 호출 C·D 입력에 넣지 않는다**(넣으려면 사용자 메시지 템플릿 §4-7·§5-2를 바꿔야 하고, 교재 문장이 출제·채점 요청마다 나간다). 템플릿 테스트의 전사 요청(관문 T)에는 **녹음만** 보낸다 — 정답 예문을 `prompt`로 넣지 않는다(§12-5-4).

#### 12-2-7. 틀 은행 — `templates` (틀 원본 `core/templates.json` · `toeic-core-raw/v3` → 가져오기)

틀과 예문은 **Claude가 새로 쓴다.** 교재에서 가져오는 것은 같은 기능의 교재 틀이 있을 때 그 **고정 부분**(짧은 뼈대)뿐이고, 예문과 테스트 전용 채움은 전부 새로 쓴다. 틀 원본은 `data/private/toeic-strategy/core/templates.json` **한 파일**(형식 `toeic-core-raw/v3`, git 밖)이다. 파일이 하나라 같은 틀이 두 번 나올 수 없고, 여러 유형에 걸친 틀을 어느 파일에 둘지 정할 일도 없다. 변환은 이 파일을 가져오기 파일의 최상위 `templates`로 옮긴다(아래 표). 옛 유형별 네 파일(`core/{q3-4,q5-7,q8-10,q11}.json`, `toeic-core-raw/v2`)은 처음 틀을 쓸 때의 작업 파일이고 변환 입력이 아니다(검토 반영 — 두 원본이 갈라져 있었고, 네 파일로 변환하면 합친 뒤에 고친 것이 되돌아갔다).

```ts
interface ToeicTemplateBankFile {         // 가져오기 파일 최상위 templates → 틀 은행 문서 하나(§12-3, id guide-templates)
  presetKey: string;                      // 멱등 키(§12-2-5) — 공략 키와 같은 접두어 + "-templates"
  flows: ToeicTemplateFlow[];             // 유형마다 하나 — 단계(답변 흐름) + 소재 묶음
  items: ToeicTemplate[];                 // 파일 순서 = 같은 묶음 안의 표시 순서
  alignmentSkips: ToeicTemplateAlignmentSkip[];  // 틀에 잇지 않는 교재 정렬 대상과 그 이유 — 가져오기 검사용(문서에 저장하지 않는다)
}

interface ToeicTemplateFlow {
  part: ToeicGuidePart;
  steps: { stepKo: string; groupsKo: string[] }[];  // 3~6 — 교재가 가르치는 답변 순서. 단계마다 그 단계의 묶음들(흐름 순서)
  banksKo: string[];                                // 0~16 — 흐름 밖 소재 묶음(주제별 틀·정보 종류). 표시는 단계 뒤
}

interface ToeicTemplate {
  key: string;                            // 숙련도 키 tpl:{key}(§12-5-6). 교정할 때 바꾸지 않는다
  groupKo: string;                        // 묶음 — 한 기능의 틀 모음(예 "빈도 말하기"). 어느 단계·소재 자리인지는 유형마다 flows가 정한다
  frameEn: string;                        // 고정 부분 + {자리 이름}
  frameKo: string;                        // 같은 자리 이름을 한국어 어순대로
  useKo: string;                          // 언제 꺼내 쓰나
  parts: ToeicGuidePart[];                // 이 틀을 보이는 유형 폴더(1~4) — 여러 유형에 걸쳐도 틀은 하나
  source: "guide" | "new";                // 교재 틀을 옮겼나 / 교재에 없는 기능을 새로 썼나
  guideRefs: ToeicTemplateGuideRef[];     // 0~4 — 교재 틀과의 연결(한 틀이 교재 표현·머리말·단계에 함께 걸릴 수 있다)
  examples: { en: string; ko: string; fills: string[] }[];   // 3~5 — en = fillFrame(frameEn, fills). 따라 말하기·카드·예문 말하기 테스트
  testFills: string[][];                  // 1~3 — 틀 바꿔 말하기 전용 채움(자리 순서의 배열). 대본·카드에 나오지 않는다(§12-5-3)
}

type ToeicTemplateGuideRef =
  | { kind: "expression"; part: ToeicGuidePart; expression: string } // 그 유형 expressions[].expression(표현 틀)
  | { kind: "template"; part: ToeicGuidePart; step: string }         // 그 유형 style "template" 블록 줄의 label(답변 틀 단계)
  | { kind: "lead"; part: ToeicGuidePart; leadEn: string };          // 그 유형 style "completions" 블록의 lead.en(이어 말하기 머리말)

interface ToeicTemplateAlignmentSkip {
  part: ToeicGuidePart;
  kind: "expression" | "template" | "lead";   // 가리키는 방법은 ToeicTemplateGuideRef와 같다
  ref: string;                                 // 그 표현·단계 label·머리말 글자
  reasonKo: string;                            // 1~80자, 한글 포함 — 왜 틀로 잇지 않는가(정렬 규칙 5)
  coveredBy: string | null;                    // 그 기능을 대신 되풀이하는 틀 key(없으면 null)
}
```

예시(지어낸 문장 — **발췌**다. 흐름에 적힌 묶음마다 그 유형 틀이 있어야 zod를 통과하므로 이 발췌 그대로는 통과하지 않는다. 통과하는 최소 픽스처는 eval이 만든다 — §12-10. `guideRefs`가 가리키는 표현·머리말은 §12-2-2 예시의 지어낸 것이고, 건너뜀이 가리키는 표현은 그 예시의 `expressions`에 한 줄 더 있다고 친 것이다):

```json
{
  "presetKey": "vendor-guide-templates",
  "flows": [
    {
      "part": "q3_4",
      "steps": [
        { "stepKo": "장면 열기", "groupsKo": ["장소 말하기"] },
        { "stepKo": "눈에 띄는 것", "groupsKo": ["인물 동작", "사물 상태"] },
        { "stepKo": "주변", "groupsKo": ["위치 말하기"] },
        { "stepKo": "인상", "groupsKo": ["느낌 말하기"] }
      ],
      "banksKo": []
    },
    {
      "part": "q11",
      "steps": [
        { "stepKo": "입장", "groupsKo": ["입장 밝히기"] },
        { "stepKo": "이유", "groupsKo": ["이유 붙이기"] },
        { "stepKo": "정리", "groupsKo": ["마무리"] }
      ],
      "banksKo": ["여가 소재", "직장 소재"]
    }
  ],
  "items": [
    {
      "key": "scene-set-on",
      "groupKo": "장소 말하기",
      "frameEn": "The scene is set on {장소}.",
      "frameKo": "장면의 배경은 {장소}이다.",
      "useKo": "사진 묘사 첫 문장 — 장소부터 말할 때",
      "parts": ["q3_4"],
      "source": "guide",
      "guideRefs": [{ "kind": "expression", "part": "q3_4", "expression": "The scene is set on ~" }],
      "examples": [
        { "en": "The scene is set on a rooftop garden.", "ko": "장면의 배경은 옥상 정원이다.", "fills": ["a rooftop garden"] },
        { "en": "The scene is set on a busy train platform.", "ko": "장면의 배경은 붐비는 기차 승강장이다.", "fills": ["a busy train platform"] },
        { "en": "The scene is set on a quiet riverside path.", "ko": "장면의 배경은 조용한 강변 산책로이다.", "fills": ["a quiet riverside path"] }
      ],
      "testFills": [["a snowy mountain trail"], ["a small fishing boat"]]
    },
    {
      "key": "two-cooks-are",
      "groupKo": "인물 동작",
      "frameEn": "Two cooks are {동작}.",
      "frameKo": "요리사 두 명이 {동작} 있다.",
      "useKo": "두 사람이 함께 일하는 장면을 말할 때",
      "parts": ["q3_4"],
      "source": "guide",
      "guideRefs": [{ "kind": "lead", "part": "q3_4", "leadEn": "Two cooks are" }],
      "examples": [
        { "en": "Two cooks are rolling out dough on a long table.", "ko": "요리사 두 명이 긴 탁자에서 반죽을 밀고 있다.", "fills": ["rolling out dough on a long table"] },
        { "en": "Two cooks are tasting a sauce from the same pot.", "ko": "요리사 두 명이 같은 냄비의 소스를 맛보고 있다.", "fills": ["tasting a sauce from the same pot"] },
        { "en": "Two cooks are washing lettuce at the sink.", "ko": "요리사 두 명이 개수대에서 상추를 씻고 있다.", "fills": ["washing lettuce at the sink"] }
      ],
      "testFills": [["plating desserts for a party"], ["cleaning the grill after lunch"]]
    },
    {
      "key": "helps-me",
      "groupKo": "이유 붙이기",
      "frameEn": "{활동} helps me {효과}.",
      "frameKo": "{활동}은 제가 {효과} 데 도움이 돼요.",
      "useKo": "좋아하는 이유·장점을 한 문장으로 붙일 때",
      "parts": ["q5_7", "q11"],
      "source": "new",
      "guideRefs": [],
      "examples": [
        { "en": "Gardening on weekends helps me clear my head.", "ko": "주말에 텃밭을 가꾸는 것은 제가 머리를 맑게 하는 데 도움이 돼요.", "fills": ["Gardening on weekends", "clear my head"] },
        { "en": "Online banking helps me save time.", "ko": "인터넷 뱅킹은 제가 시간을 아끼는 데 도움이 돼요.", "fills": ["Online banking", "save time"] },
        { "en": "A short nap helps me focus in the afternoon.", "ko": "짧은 낮잠은 제가 오후에 집중하는 데 도움이 돼요.", "fills": ["A short nap", "focus in the afternoon"] }
      ],
      "testFills": [["Keeping a diary", "sleep better"], ["A standing desk", "stay alert at work"]]
    }
  ],
  "alignmentSkips": [
    { "part": "q3_4", "kind": "expression", "ref": "The scene is set in ~", "reasonKo": "뜻이 같은 어휘 대안 — 대표 틀 하나로 연습한다", "coveredBy": "scene-set-on" }
  ]
}
```

**만드는 법 — 교재 틀에 맞춘다(정렬 규칙, 사용자 확정 2026-09-27 · 검토 반영)**

1. **정렬 대상 목록을 먼저 만든다** — 그 유형 공략 항목의 (a) **자리 있는 표현 틀**: `expressions` 중 `~`나 첫 낱말이 아닌 대문자 `A`·`B` 자리가 있는 것, (b) **답변 틀 단계**: `style:"template"` 블록 줄의 `label`(같은 이름은 하나로), (c) **이어 말하기 머리말**: `style:"completions"` 블록의 `lead.en`(같은 글자는 하나로). 자리 없는 연결어·낱말 표현(지어낸 예 "In short")은 대상이 아니다 — 쓰는 틀이 있으면 이어도 된다.
2. 쓰려는 틀과 **같은 기능의 교재 틀이 있으면 교재 틀의 고정 부분을 글자 그대로** 쓴다. 바꾸는 것은 자리 표시(`~`, 교재가 자리로 쓴 대문자 `A`·`B`) → `{자리 이름}` 하나뿐이다. `source:"guide"`로 적고 `guideRefs`로 그 교재 틀을 가리킨다 — zod가 고정 부분이 온전히 들어 있는지 본다(아래).
   - 교재 틀의 슬래시 대안이 뜻이 같으면 교재가 먼저 적은 쪽 하나로 쓴다(§12-2-1 "대표형"과 같다). **뜻이 갈리는 변형**(왼쪽/오른쪽, 찬성/반대, 장점/단점 같은 것)은 **틀을 나눈다** — 자리로 두지 않는다. 자리로 두면 교재의 고정 낱말이 자리 안으로 들어가 연결 검사를 통과하지 못하고, 뜻을 고르는 연습이 채우기로 바뀐다.
   - 참고한 강의 자료의 틀과 교재 틀이 같은 기능인데 모양이 다르면 **교재 쪽**을 쓴다.
3. **머리말은 두 방법으로 잇는다.** (a) **포함** — 머리말 낱말이 틀의 한 고정 구간 안에 이어서 있다(지어낸 예: 머리말 `Two cooks are` ↔ 틀 `Two cooks are {동작}.`). (b) **머리 사례** — 머리말이 틀 머리의 자리를 채운 한 사례다. 틀의 고정 낱말은 글자 그대로 맞고 자리는 머리말 낱말 1개 이상을 받으며, 맞춘 고정 낱말이 2개 이상이다(지어낸 예: 머리말 `I water the plants` ↔ 틀 `I water {무엇} {얼마나 자주}.`). 교재 머리말이 한 소재에 묶여 있으면(특정 물건을 사는 문장 같은 것) (b)로 소재 낱말만 자리로 넓혀 여러 질문에 쓰이게 한다 — 교재의 고정 낱말은 그대로 남는다.
4. 교재에 **없는 기능만** 새 틀(`source:"new"`)로 채운다. 문체는 교재 틀을 따른다 — 1인칭·현재형 위주, 고정 부분 12낱말 이하, 쉬운 낱말, 교재가 쓰는 연결어. 강의 자료에만 있는 기능이면 방법만 빌리고 문장은 우리가 새로 쓴다. 교재 표현·머리말을 가리키게 된 틀은 교재 틀이다(`"guide"`로 적는다).
5. **정렬 대상은 빠짐이 없어야 한다.** 대상마다 어떤 틀의 `guideRefs`가 가리키거나, `alignmentSkips`에 이유와 함께 올린다. 건너뛰는 이유는 셋 중 하나로 쓴다.
   - ① **어휘 대안** — 같은 뜻의 다른 동사·같은 전치사(`coveredBy`에 대표 틀).
   - ② **문법 변형·생략형** — 연결어 생략, 동명사/부정사 같은 것(대표 틀).
   - ③ **틀로 쓰지 않는 표현** — 뜻 고르기 전용, 숫자 읽기(`coveredBy` null).

   같은 대상을 잇고 건너뛰기를 함께 하지 않는다. 변환과 zod가 빠짐을 거부한다(아래) — 알림 eval이 아니다. 어휘 대안이라도 교재가 뜻이 갈리는 짝으로 가르치면(시각 at · 날짜 on · 장소 in 같은 전치사) 짝마다 대표 틀을 하나씩 둔다.
6. 틀 하나가 여러 유형에 쓰이면(예: 이유 붙이기가 Q5–7과 Q11) **한 번만** 두고 `parts`에 유형을 모두 적는다. 두 유형 공략에 같은 교재 틀이 있으면 `guideRefs`로 둘 다 가리킨다.
7. **흐름은 두 층이다.**
   - **단계**(`steps`, 유형마다 3~6개): 교재가 가르치는 답변 순서다. 교재에 답변 틀 블록이 있으면 그 단계 이름을 그대로 쓴다. 단계는 그 단계의 묶음들을 흐름 순서로 담는다.
   - **소재 묶음**(`banksKo`): 흐름 밖의 주제별 틀·정보 종류(지어낸 예 "여행 소재", "비용 정보")다. 단계 뒤에 보인다. "빠진 단계"·연습 틀 고르기의 단계 몫에 들지 않는다(§12-5-5·§12-7-9).
   - **묶음**(`groupKo`)은 한 기능의 틀 모음이다. **유형 폴더마다 틀 6개 이하**(`TOEIC_TEMPLATE_GROUP_MAX`) — 넘으면 원본에서 묶음을 나눈다(따라 말하기 한 묶음이 약 20분을 넘지 않게).
   - 여러 유형에 걸친 틀의 묶음은 유형마다 그 유형 흐름이 원하는 자리(단계 또는 소재)에 넣는다. 틀에 박힌 묶음 이름 하나가 두 유형의 단계를 정하지 않는다. 그래서 묶음 이름은 두 유형 모두에서 뜻이 통하는 기능 이름으로 짓는다.
8. **예문은 틀마다 3~5개, 주제가 서로 다르게** — 일상·직장·여가·쇼핑·교통·건강·기술·교육처럼 토익스피킹에 자주 나오는 주제에서 고르고, 한 틀 안에서 주제가 겹치지 않게 한다. 채움은 **여러 질문에 두루 쓰이는 말**(시간을 아낀다, 머리를 식힌다, 돈이 덜 든다 같은 것)을 먼저 고른다 — 한 번 익힌 채움이 다른 질문에서도 그대로 나오게. 문장 길이는 IM3~IH 눈높이(15낱말 안팎)다. 규칙 3 (b)로 넓힌 틀은 소재가 좁을 수 있지만, 그래도 채움은 서로 다른 상황으로 쓴다.
9. **테스트 전용 채움 `testFills`는 틀마다 1~3묶음**(원본은 2묶음을 쓴다). 예문 채움과 다른 채움으로, 틀 바꿔 말하기 문항이 대본에 없던 새 문장이 되게 한다(§12-5-3). 한 묶음 안의 자리끼리 뜻이 맞아야 한다(시작 시각 < 끝 시각, 예전 모습 ↔ 요즘 모습 같은 짝). 그래서 예문 채움을 엇갈려 섞지 않고 새로 쓴다.
10. 예문과 테스트 전용 채움은 새로 쓴다 — 교재 예문·모범답변·해석과 강의 문장을 옮기지 않는다(흔한 틀이라 우연히 같은 문장이 되는 것은 괜찮다).
11. 문장 첫 자리(두 번째 문장의 첫 자리 포함)의 채움은 대문자로 시작하게 적는다 — 예문은 틀에 채움을 넣은 결과와 **글자까지** 같아야 한다(`fillFrame`은 대소문자를 고치지 않는다).
12. **한국어 틀은 교재 뜻풀이를 따른다.** 틀 전체가 교재 표현 하나인 틀(`frameToExpression` 글자가 그 교재 표현과 같은 모양)이면 `frameKo`는 그 표현의 교재 뜻풀이(`meaningKo`)에서 `~`를 자리 이름으로 바꿔 만들고, 자리 앞뒤 조사·어미만 자리에 맞춘다. 교재 표현보다 긴 틀(동사 연어를 넣은 문장 틀)은 뜻풀이를 참고해 새로 쓴다. ③ 표현 시험에서 보는 뜻과 ② 틀 카드·테스트 단서의 뜻이 어긋나지 않게 하려는 것이다.

**변환 규칙 — `toeic-core-raw/v3` → `templates`**

| 원본(`core/templates.json`) | 가져오기 | 규칙 |
|---|---|---|
| 최상위 `format`·`flows`·`skips`·`templates` | `templates` 객체 하나 | `format`이 `toeic-core-raw/v3`가 아니면 변환 실패 |
| `templates[]`의 `key`·`groupKo`·`frameEn`·`frameKo`·`useKo`·`source`·`examples`·`testFills` | `items[]`의 같은 이름 | 그대로(파일 순서 유지, `examples[].fills`·`testFills[]`는 자리 순서의 배열). 같은 `key`가 두 번이면 변환 실패 |
| `parts`(`"q3-4"` 표기) | `parts`(`"q3_4"` 표기) | 표기만 바꾼다 |
| `guideRefs[]` — `{part, expression}` · `{part, templateStep}` · `{part, lead}` | `{kind:"expression", part, expression}` · `{kind:"template", part, step}` · `{kind:"lead", part, leadEn}` | `part` 표기만 바꾸고 순서를 지킨다 |
| `flows[]` — `{part, steps, banksKo}` | `flows[]` 같은 모양 | `part` 표기만 바꾼다 |
| `skips[]` — `{part, kind, ref, reasonKo, coveredBy}` | `alignmentSkips[]` 같은 모양 | `part` 표기만 바꾼다 |
| — | `presetKey` | 공략 키 접두어 + `-templates` |

- 변환은 파일을 쓰기 전에 가져오기 zod(아래)를 오프라인으로 돌리고, 통과한 것만 둔다. 특히 **정렬 빠짐 0**이 여기서 걸린다(eval의 "실제 가져오기 파일" 검사 — §12-10). 고칠 곳이 나오면 **원본을 고친다** — 가져오기 파일을 손으로 고치면 다음 변환이 되돌린다.
- 원본 실측(2026-09-27 검토 반영 뒤, 개수만 — eval에 리터럴로 잠그지 않는다)

  | 항목 | 개수 |
  |---|---|
  | 틀 · 예문 · 테스트 전용 채움 | 152 · 650 · 304묶음(틀마다 2) |
  | 폴더별 틀(`parts` 기준) | Q3–4 37 · Q5–7 51 · Q8–10 38 · Q11 60. 두 유형에 쓰이는 틀 34(모두 Q5–7 + Q11) |
  | `source` | guide 99 · new 53 |
  | 흐름 — 단계 / 단계 안 묶음 / 소재 묶음 | Q3–4 4/11/0 · Q5–7 4/11/8 · Q8–10 4/9/6 · Q11 5/9/12. 묶음당 틀 최대 6 |
  | 정렬 — 연결/건너뜀/빠짐 | Q3–4 표현 25/0/0 · 단계 4/0/0 · 머리말 11/0/0 — Q5–7 표현 11/0/0 · 머리말 8/0/0 — Q8–10 표현 15/3/0 — Q11 표현 18/5/0 · 단계 5/0/0. 머리말 연결은 포함 10 · 머리 사례 9 |
  | 따라 말하기 예상 시간(반복 4·틈 보통·속도 보통 — `estimateShadowMs`) | 폴더 전체 약 2~3.2시간, 묶음 하나 약 3~20분, 틀 하나 중앙 약 3.2분 |
  | 알릴 것(zod는 통과) | 고정 낱말이 한 개뿐인 틀 1, 두 낱말 이상 이어진 고정 구간이 없는 틀 4(전사문 매칭 제외 — §12-5-5), 고정 낱말 7개 미만 106(한 낱말만 어긋나도 제안 ✕ — §12-5-5), 같은 유형 안 한국어 틀이 글자까지 같은 쌍 2(어휘 대안 — §12-5-5 대안 대조) |
  | 한국어 틀 ↔ 교재 뜻풀이(규칙 12 대상 23틀) | 글자까지 같음 16 · 자리 조사·어미만 다름 7. eval의 알림(§12-10 틀 점검)은 "같은 모양"을 `frameToExpression` 글자가 그 유형 공략 표현과 대소문자·공백 무시로 같은 틀로 세어 대상이 36틀이고, 그중 조사·어미 밖에서 다른 것을 근사로 알린다(실패가 아니다) |

- **2026-10-02 같은 자리 중복 정리 뒤**(개수만 — `_workspace/data_toeic_template_dedupe_report.md`, eval에 리터럴로 잠그지 않는다). 규칙: 같은 자리에 바꿔 넣을 수 있는 틀이 겹치면 앱 표시 순서(`templateFlowOrder`)로 맨 위 틀 하나만 남긴다. 지운 틀이 잇던 교재 대상은 남은 틀로 옮기거나(모양 검사를 통과할 때), 건너뜀(이유 "같은 자리 중복", `coveredBy` = 남긴 틀)으로 올린다.

  | 항목 | 개수 |
  |---|---|
  | 틀 · 예문 · 테스트 전용 채움 | 108 · 462 · 216묶음 |
  | 폴더별 틀 | Q3–4 21 · Q5–7 39 · Q8–10 27 · Q11 39. 두 유형에 쓰이는 틀 18 |
  | `source` | guide 60 · new 48 |
  | 흐름 — 단계 / 단계 안 묶음 / 소재 묶음 | Q3–4 4/9/0 · Q5–7 4/11/8 · Q8–10 4/9/6 · Q11 5/6/12. 빈 단계 0 |
  | 정렬 — 연결/건너뜀/빠짐(정렬 대상만) | Q3–4 표현 13/12/0 · 단계 4/0/0 · 머리말 9/2/0 — Q5–7 표현 8/3/0 · 머리말 3/5/0 — Q8–10 표현 8/10/0 — Q11 표현 13/10/0 · 단계 5/0/0 |
  | 건너뜀 전체 | 55건(정렬 대상 아닌 자리 없는 표현의 기록용 13 포함) — **모두 `coveredBy`가 있다**(같은 자리 중복 47 · 어휘 대안 등 8). 이것이 ① 공략 읽기의 "같은 자리 다른 표현" 접기 자료다(§12-13-1) |
  | 틀 은행 바이트 | 156,463 |

**zod 규칙**(`toeicGuideFileSchema`의 한 부분 — `lib/ai/toeic/schemas.ts`. `guideRefs`·`alignmentSkips` 대조와 정렬 빠짐 검사가 같은 파일의 `guides`를 봐야 해서 최상위 superRefine에서 교차 검사한다. 상한은 `TOEIC_TEMPLATE_*` 상수로 한 번만):

- `presetKey`: §12-2-3 최상위 규칙과 같다(파일 안 공략 키와도 달라야 한다).
- `items` 1~300개(`TOEIC_TEMPLATES_MAX`). `key`는 `^[a-z0-9][a-z0-9-]{0,39}$`이고 파일 안에서 유일하다.
- `groupKo` 1~30자·한글 포함, `useKo` 1~120자·한글 포함. `parts` 1~4개, 네 값 중(`q1_2` 거부), 중복 금지.
- `frameEn`: 1~120자, 라틴 포함. 슬롯 규칙은 공략 영어 줄(§12-2-3)과 같다 — 한글은 `{…}` 안에서만, 짝·중첩·빈 슬롯 금지, 안은 1~20자. 틀 전용 규칙을 더한다.
  - 자리 1~4개, 자리 이름 중복 금지.
  - 자리는 **낱말 하나처럼** 선다 — `{` 앞은 문장 처음·공백·여는 따옴표, `}` 뒤는 문장 끝·공백·`.`·`,`·`?`·`!`·`;`·`:`. `{동작}ing`·`{사람}'s` 같은 것은 거부한다(전사 비교가 자리 경계에서 낱말을 자르지 않게 — §12-5-5).
  - 자리 밖에 `~`·`/`·`[`·`]` 거부(자리는 `{}`, 대안은 틀을 나눈다).
  - 고정 부분 낱말(`normalizeTemplateWords` 기준 — §12-5-5)이 1개 이상이다.
  - **`matchKey(frameToExpression(frameEn))`가 은행 안에서 유일하다**(검토 개선 9 — 되짚는 표 `templateByExpression`이 Map 하나라 겹치면 한 틀이 조용히 가려진다).
- `frameKo`: 1~120자, 한글 포함(**자리 `{…}` 밖에서** 센다 — 지어낸 예 `{다음 일}.`처럼 자리 이름에만 한글이 있는 한국어 틀은 거부), 같은 슬롯 규칙. **자리 이름의 모임이 `frameEn`과 같다**(순서는 한국어 어순대로 달라도 된다). `~` 거부 — 한국어 틀도 이름 있는 자리로 적는다(화면이 영어·한국어의 같은 자리를 같은 색으로 잇는다 — §12-5-1).
- `examples` 3~5개(`TOEIC_TEMPLATE_EXAMPLES_MIN`·`MAX`)
  - `fills` 길이 = 자리 수. 채움마다 1~80자, **라틴 문자 또는 숫자 포함**(`hasLatin(x) || /\d/.test(x)` — 가격·시각·연도 채움이 된다. 검토 B1: 라틴만 요구하면 숫자·가격 채움 14개 때문에 가져오기 파일 전체가 400이었다), 한글·`{`·`}`·`~`·`/`·`[`·`]` 거부, 앞뒤 공백 없음.
  - **`en` === `fillFrame(frameEn, fills)`** — 글자까지(대소문자·문장부호·공백) 같다. `fillFrame`은 i번째 `{…}`를 `fills[i]`로 바꿀 뿐이다.
  - `en` 1~`TTS_TEXT_MAX_CHARS`자(같은 상수). `ko` 1~200자, 한글 포함, `{`·`}`·`~` 거부.
  - 한 틀 안에서 예문 `en`(대소문자·연속 공백 무시)과 `fills` 묶음(대소문자 무시)이 서로 달라야 한다.
- `testFills` 1~3묶음(`TOEIC_TEMPLATE_TEST_FILLS_MIN`·`MAX`): 묶음마다 길이 = 자리 수, 채움 규칙은 예문 채움과 같다. 예문의 채움 묶음과도, 다른 `testFills` 묶음과도 달라야 한다(대소문자 무시). `fillFrame(frameEn, 묶음)`이 `TTS_TEXT_MAX_CHARS` 이하.
- `source`·`guideRefs`
  - `guideRefs` 0~4개(`TOEIC_TEMPLATE_GUIDE_REFS_MAX`), 같은 연결 두 번 금지. `source:"guide"`면 1개 이상. `source:"new"`면 `kind:"template"`만 — 새 틀이 교재 답변 틀의 어느 단계를 채우는지는 적을 수 있지만, 교재 표현·머리말을 가리키면 그것은 교재 틀이다("guide"로 적는다).
  - 연결마다 `part` ∈ 그 틀의 `parts`.
  - **대상이 같은 가져오기 파일 안에 실제로 있어야 한다.** 파일의 `guides`에 그 유형 항목이 있고, `expression`은 그 유형 `expressions[]` 중 `expressionKey`가 같은 항목, `template`은 그 유형 `style:"template"` 블록 줄 중 `label`이 `step`과 같은 줄, `lead`는 그 유형 `style:"completions"` 블록 중 `lead.en`이 `leadEn`과 같은(공백 정리 후 글자 그대로) 블록이다.
  - **교재 틀의 고정 부분이 온전히 들어 있어야 한다.**
    - `expression`: 교재 틀을 `~`와 **첫 낱말이 아닌** 대문자 한 글자 `A`·`B`에서 끊은 조각마다, 그 조각의 낱말이 틀의 한 고정 구간 안에 **이어서, 순서대로** 있어야 한다(`normalizeTemplateWords` 기준 — 대소문자·문장부호·축약형 차이는 같게 본다). 교재 표현이 **소문자로 시작하는 동사 연어**면(지어낸 예 `pay rent`) 첫 조각의 첫 낱말은 `-s`·`-es`·`-ed`·`-d` 꼴도 같게 본다 — 틀 문장에서 동사가 활용된다.
    - `lead`: 정렬 규칙 3의 (a) 포함 또는 (b) 머리 사례(맞춘 고정 낱말 2개 이상). 판정은 순수 함수 `leadMatchesFrame(leadEn, frameEn)`(`lib/toeic-template.ts` — 같은 정규화)가 한다. 머리말 안의 `a/b` 낱말 대안은 둘 중 하나와 맞으면 된다.
    - `template`: 대상이 있는지만 본다 — 템플릿 줄에는 여러 낱말에 걸친 슬래시 대안이 섞여 있어 기계 대조가 믿을 만하지 않다(실제 파일 eval이 첫 고정 조각이 틀에 없는 수를 알린다).
- `flows`
  - 유형 중복 금지. 어떤 틀의 `parts`에 든 유형이면 그 유형의 흐름이 있어야 하고, 틀이 없는 유형의 흐름은 거부한다.
  - `steps` 3~6개(`TOEIC_TEMPLATE_FLOW_STEPS_MIN`·`MAX`). `stepKo` 1~30자·한글 포함·그 유형 안에서 유일. 단계마다 `groupsKo` 1~8개. `banksKo` 0~16개. 이름마다 1~30자.
  - 한 유형 안에서 묶음 이름은 단계·소재를 통틀어 **한 번만** 나온다. 그 유형 틀들의 `groupKo` 모임 = 그 흐름에 적힌 묶음 모임이다(흐름에 빠진 묶음도, 틀이 없는 묶음도 거부).
  - 유형마다 묶음 하나의 틀 수 ≤ 6(`TOEIC_TEMPLATE_GROUP_MAX`).
- `alignmentSkips` 0~100개
  - 대상이 같은 파일의 그 유형 공략 항목에 있어야 한다(가리키는 방법은 `guideRefs`와 같다 — 표현은 자리 없는 것도 된다). `reasonKo` 1~80자·한글 포함. `coveredBy`는 null이거나 그 유형을 `parts`에 가진 틀의 `key`.
  - 같은 대상 두 번 금지. **어떤 틀이 연결한 대상을 건너뛰기에 올리면 거부**한다.
  - (2026-10-02 — 뜻 확정, zod 변경 없음) `coveredBy`가 곧 구조화된 표시다. **`coveredBy`가 있는 건너뜀 = "같은 자리 다른 표현"**(정렬 규칙 5의 ① 어휘 대안·② 문법 변형, 그리고 같은 자리 중복 정리) — 그 기능은 `coveredBy` 틀이 대신 되풀이한다. `coveredBy`가 null인 건너뜀(③ 틀로 쓰지 않는 표현)은 대안이 아니다. 이유 글(`reasonKo`)은 사람이 읽는 메모라 판정에 쓰지 않는다. 그래서 가져오기 형식은 그대로다(새 칸 없음 — 지금 파일이 그대로 들어간다). 쓰는 곳은 §12-13-1.
- **정렬 빠짐 0**(검토 반영 — 사용자 지시 "기존 템플릿에 최대한 맞춰"): 파일의 `guides`에 있는 유형마다, 정렬 대상(규칙 1 — 자리 표현·답변 틀 단계·머리말) 하나하나가 어떤 틀의 `guideRefs`로 연결되거나 `alignmentSkips`에 있어야 한다. 빠짐이 있으면 400이다. 경로는 `templates.alignment.{유형}.{kind}.{대상 순번}`이고 문구는 규칙만 적는다 — 대상 글자는 싣지 않는다. `guides`에 없는 유형은 보지 않는다(`templates: null`이면 이 검사도 없다).
- 크기: 파싱된 `flows`·`items`를 `JSON.stringify`한 UTF-8 바이트가 `TOEIC_GUIDE_MAX_BYTES`(900,000 — 같은 상수) 이하. 문서가 따로라 유형 공략과 따로 잰다. 원본 152틀이 약 218KB다(2026-09-27 변환 실측 217,740바이트).
- 메시지에 값을 넣지 않는다 — 400 본문은 §12-2-3의 `toeicGuideImportInvalidBody` 그대로다(경로가 `templates.items.{i}.examples.{j}.en`처럼 위치를 알려 준다).

### 12-3. 저장 모델 — 새 컬렉션 없이 필드 셋

| 레코드 | 새 필드(필수, nullable) | 옛 문서 정규화 | 뜻 |
|---|---|---|---|
| `ToeicSetRecord`(`toeicSets`) | `guide: ToeicGuideDoc \| null` | `null`(표현집) | null이 아니면 **공략 계열 문서**다 — 종류가 둘이다(`guide.kind`). **유형 공략**(`"part"`)은 이렇게 채운다. `id` = `guide-{part}`(§12-2-5). `entries` = 파일 `expressions`(`points: null`·`confidence:"high"`·`partial:false`). `quiz` = 파일 `speak`(`keyExpressions: []` — 0~60개, §7-1 예외). `titleKo` = 유형 이름(`toeicMockPartLabelKo` — 예 "Q3–4 사진 묘사"). `source:"import"`, `photoCount 0`, `enriched false`, `model null`, `dayNo·topicKo null`. **틀 은행**(`"templates"`)은 문서 하나다 — `id` = `guide-templates`, `entries: []`·`quiz: []`(§7-1 상한의 두 번째 예외 — 표현이 0개인 세트 문서는 틀 은행뿐이다), `titleKo` "템플릿 훈련", `enriched`는 파생값 그대로 — `entries`가 비어 있으면 **false**다(`lib/toeic-normalize.ts`의 파생식이 `entries.length > 0 && …` — 검토 개선 2. 쓰는 곳은 없다), 나머지는 유형 공략과 같다 |
| `ToeicQuizRecord`(`toeicQuizzes`) | 필드 추가 없음 — `mode`의 값 둘을 더한다: `"tpl-recall"`(예문 말하기)·`"tpl-swap"`(틀 바꿔 말하기) | 그대로(`normalizeToeicQuizRecord`가 두 목록 중 하나면 받는다) | 템플릿 테스트 세션(§12-5-6). `setId` = `guide-templates`, 항목 키 = `tpl:{key}`. **§7-3의 `ToeicQuizMode`(네 값)는 바꾸지 않는다** — 새 타입 `ToeicTemplateQuizMode`를 두고 레코드의 `mode`만 `ToeicQuizMode \| ToeicTemplateQuizMode`로 넓힌다(표현 시험 화면·통계·오답 탭이 도는 `TOEIC_QUIZ_MODES`에 틀 모드가 섞이지 않게). 타입이 넓어지면서 따라 바뀌는 곳은 아래 "모드 타입 넓히기" |
| `ToeicMockRecord`(`toeicMocks`) | `drillPart: ToeicMockPart \| null` | `null`(모의고사) | null이 아니면 한 문제 연습. 그 파트만 non-null |
| `ToeicAttemptRecord`(`toeicAttempts`) | `questions: number[]` | `toeicAttemptQuestions(parts)` | 응시 범위의 문항 번호(오름차순). 연습의 사진 묘사는 `[3]`(§12-7-4) |

```ts
type ToeicGuideDoc = ToeicGuidePartDoc | ToeicTemplateBankDoc;

interface ToeicGuidePartDoc {
  kind: "part";
  part: ToeicGuidePart;
  introKo: string | null;
  sections: ToeicGuideSection[];     // §12-2-2 그대로
  contentHash: string;               // §12-2-5
  updatedAt: string;                 // 내용이 마지막으로 바뀐 시각(생성 포함)
}

interface ToeicTemplateBankDoc {
  kind: "templates";
  flows: ToeicTemplateFlow[];        // §12-2-7 그대로(단계 + 소재 묶음)
  items: ToeicTemplate[];            // §12-2-7 그대로(한 벌 — 유형 폴더는 parts로 고른다)
  alternates: ToeicTemplateAlternate[];  // 2026-10-02 — 같은 자리 다른 표현(alignmentSkips 중 coveredBy가 있는 것). 옛 문서 = [] (§12-13-1)
  contentHash: string;               // §12-2-5(flows·items·alternates — 2026-10-02부터)
  updatedAt: string;
}

interface ToeicTemplateAlternate {   // 2026-10-02 (§12-13-1)
  part: ToeicGuidePart;
  kind: "expression" | "template" | "lead";   // 가리키는 방법은 ToeicTemplateGuideRef와 같다
  ref: string;                                 // 그 표현·단계 label·머리말 글자(alignmentSkips[].ref 그대로)
  coveredBy: string;                           // 그 자리에서 외울 틀 key
}

type ToeicTemplateQuizMode = "tpl-recall" | "tpl-swap";                       // ② 틀 테스트(말하기)
type ToeicTemplateChoiceMode = "tpl-ko-frame" | "tpl-frame-ko" | "tpl-cloze"; // ③ 틀 시험(2026-10-02, §12-13-2)
type ToeicTemplateBankMode = ToeicTemplateQuizMode | ToeicTemplateChoiceMode; // 틀 은행 세션(setId guide-templates)이 갖는 모드 다섯
```

- **2026-10-02 바뀐 것 요약**(상세는 §12-13): 틀 은행 문서에 `alternates`, `toeicQuizzes`의 모드에 ③ 틀 시험 셋(`ToeicTemplateChoiceMode` — 레코드 `mode`는 `ToeicQuizMode | ToeicTemplateBankMode`), `ToeicMockRecord`에 `answerFlows`(§7-2). 셋 다 옛 문서는 빈 값으로 읽고(`[]`·그대로), 새 컬렉션은 없다.

- **틀 은행을 문서 하나로 두는 이유** — 틀이 여러 유형에 걸친다(원본 152틀 중 34개가 Q5–7과 Q11 둘 다). 유형 공략 문서에 나눠 담으면 걸친 틀이 두 벌이 되거나 "본적 유형"을 정해야 하고, 테스트 기록이 `setId`로 갈라져 한 틀의 숙련도가 폴더마다 따로 쌓인다. 문서 하나면 세션의 `setId`가 하나(`guide-templates`)라 **틀 하나 = 숙련도 하나**가 저절로 성립한다. 크기는 원본 기준 약 218KB로 1MiB의 4분의 1이 안 된다(§12-2-7 바이트 상한 900,000). 정렬 건너뜀(`alignmentSkips`)은 저장하지 않는다(§12-2-5).
- **Firestore 본문에서는 `testFills`를 감싼다**(구현 반영 2026-09-27). Firestore는 배열의 원소가 곧 배열인 값을 쓰지 못한다(INVALID_ARGUMENT — 파일 백엔드는 받으므로 로컬·eval에서는 드러나지 않고 프로덕션 가져오기만 500이 된다). 틀마다 있는 `testFills: string[][]`가 그 모양이라, Firestore 쓰기 헬퍼가 `{ fills: string[] }[]`로 감싸 쓰고 읽기 변환이 다시 푼다 — 순수 함수 `encodeToeicGuideForFirestore`·`decodeToeicGuideFromFirestore`(`lib/toeic-firestore-codec.ts`, import 0). 읽기는 두 모양(감싼 것·배열)을 모두 받는다. 앱 레코드 타입·파일 백엔드·정규화·내용 지문(zod 출력에서 계산한 문자열)은 그대로다. eval "공략 Firestore 본문"이 실제 가져오기 파일의 쓸 문서 전부에서 "인코딩 뒤 배열 속 배열 0 · 왕복 불변"을 잠근다. 새 필드에 배열 속 배열이 생기면 같은 자리에서 감싼다.
- **`guide`의 한 종류로 두는 이유** — 기존 목록에서 가리는 판정 `isToeicGuideSet`(`guide !== null`)이 틀 은행도 그대로 뺀다. 가리는 자리를 하나도 더하지 않는다(아래 표). 필드를 따로 두면(`templates: … | null`) 목록마다 판정이 둘이 된다.
- **테스트 기록을 `toeicQuizzes`에 두는 이유** — 스트릭이 이 컬렉션을 모드와 상관없이 센다(`toeicStreakSessions` — 답한 문항 ≥ 1). 새 컬렉션이면 스트릭 배선(`eval:streak` ⑥이 정규식으로 잠갔다)과 §7 체크리스트를 다시 밟는다. 표현 시험과 섞이지 않는 것은 `setId`(틀 은행 하나)와 모드(틀 모드 둘)가 가른다 — 표현 시험의 숙련도 함수(`aggregateToeicStatsByMode`)는 `TOEIC_QUIZ_MODES`만 돌므로 틀 세션이 들어와도 읽지 않는다.
- **모드 타입 넓히기 — 따라 바뀌는 곳**(검토 B3). 레코드 `mode`만 넓히면 `ToeicQuizSessionLike.mode: ToeicQuizMode`(`lib/toeic-quiz.ts`)에 레코드를 넘기는 곳(`app/api/toeic/mocks/route.ts`, 표현 시험·오답·기록 페이지)과 `TOEIC_QUIZ_MODE_LABELS_KO[mode]` 색인 세 곳(기록·오답·모드 고르기 화면)이 tsc에서 깨진다. 그래서 이렇게 한다.
  - 틀 모드의 타입·목록·판정·라벨은 **`lib/toeic-quiz.ts`에 둔다** — `ToeicTemplateQuizMode`·`TOEIC_TEMPLATE_QUIZ_MODES`·`isToeicTemplateQuizMode`·`TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO`. 모드 목록이 한 모듈에 모이고, `lib/toeic-template.ts`가 이 모듈을 import한다(반대 방향 import 없음 — 순환 없음).
  - `ToeicQuizSessionLike.mode`를 `ToeicQuizMode | ToeicTemplateQuizMode`로 넓힌다. 런타임 집계는 이미 모드 등호로 거른다(`aggregateToeicStatsByMode`가 `TOEIC_QUIZ_MODES`를 돌며 `s.mode === mode`) — 결과는 그대로다.
  - **세트 단위 화면**(표현 시험·오답노트·기록 페이지)과 모의고사 라우트의 활용할 표현 고르기는 세션을 `isToeicQuizMode(s.mode)`로 걸러 넘긴다. 라벨 색인은 거른 뒤에만 한다. 틀 은행 id는 이 페이지들에 오지 않지만(리다이렉트·404 — 아래 표), 타입이 이 경계를 강제하게 한다.
  - (2026-10-02) 한 번 더 넓힌다 — 틀 은행 세션 모드가 다섯(말하기 둘 + ③ 틀 시험 셋)이 된다. `ToeicQuizSessionLike.mode`·레코드 `mode`는 `ToeicQuizMode | ToeicTemplateBankMode`. 말하기 두 모드만 보는 곳(배지·익힘·틀린 틀·연습 약함·최근 테스트·라벨 색인 `TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO[mode]`)은 지금처럼 `TOEIC_TEMPLATE_QUIZ_MODES`를 돌거나 `isToeicTemplateQuizMode`로 거른 뒤에만 색인한다 — 고르기 세션이 섞여 들어와도 결과가 같아야 한다(§12-13-2).

- **왜 새 컬렉션이 아닌가** — 기존 코드가 두 컬렉션에 매달려 있다.
  - 채점 라우트는 `attempt.mockId → getToeicMock`으로 문항 자료를 읽는다(§5-2 `buildFeedbackInput`).
  - 시험 저장·오답노트·기록은 `toeicSets`의 `setId`에 매달린다.
  - 스트릭은 `toeicQuizzes`·`toeicAttempts` 두 컬렉션을 센다(`eval:streak` ⑥이 그 배선을 정규식으로 잠갔다).

  연습·공략을 새 컬렉션에 두면 이 전부를 고쳐야 하고, §7 머리의 새 컬렉션 체크리스트 12항목(+ `DestructiveOp`·시드 병합)을 밟는다. 필드 추가는 그보다 훨씬 좁다. 밟는 순서: 레코드 타입 → `New*`(필수 필드라 tsc가 생성부 전부를 잡는다) → `lib/toeic-normalize.ts` 기본값 → Firestore `to*`/쓰기 헬퍼(같은 normalize를 탄다) → 렌더 판정(`lib/toeic-record.ts`, 아래) → 생성부 전부 명시 → eval "옛 문서 = 기본값".
- 공략 본문을 세트 문서 안에 두는 이유 — 공략 읽기와 공략 표현 시험이 한 가져오기로 함께 생기고 함께 교정된다. 두 문서(공략 문서 + 세트)로 나누면 두 컬렉션을 한 원자 단위로 쓰는 메서드가 필요하고, 둘 중 하나만 교정된 상태가 생길 수 있다. 문서 크기는 유형당 수십 KB다.
- **정규화 깊이**: `normalizeToeicSetRecord`는 모르는 키를 **버린다**(`lib/toeic-normalize.ts`). 그래서 `guide`를 명시적으로 옮겨야 한다 — 빠뜨리면 생성·이름 바꾸기·병합 경로에서 공략이 조용히 표현집으로 둔갑한다.
  - `guide` 키가 없거나 null → null(옛 문서 = 표현집).
  - 객체 → `kind`를 보고 옮긴다. `"part"`면 `part`·`introKo`·`contentHash`·`updatedAt`은 형식을 보고 옮기고, `sections`는 배열이면 **통째로** 옮긴다(모의고사 파트와 같은 판단 — 안쪽 모양은 렌더 판정이 본다). `"templates"`면 `flows`·`items`를 배열이면 통째로, 나머지는 형식을 보고 옮긴다. `alternates`(2026-10-02)는 배열이면 항목마다 모양(`part` 네 값·`kind` 세 값·`ref`·`coveredBy` 비지 않은 문자열)을 보고 맞는 것만, 배열이 아니거나 없으면 `[]`다 — 접기 자료가 깨져도 틀 은행은 연다(접기만 빠진다, 렌더 판정에 넣지 않는다). `kind`가 없으면 `"part"`로 읽는다(방어 — 배포된 옛 문서는 없다).
  - `kind`가 두 값 밖이거나, `part`가 네 값 밖이거나, `sections`·`items`가 배열이 아니어도 `guide`를 **null로 떨어뜨리지 않는다**. 떨어뜨리면 깨진 공략이 표현집 목록에 섞인다. 이런 문서는 렌더 판정에서 떨어져 폴더에도 표현집에도 나오지 않고, 목록의 "열지 못한 n개"로 센다.
- **렌더 판정**
  - `isRenderableToeicSet`은 그대로 쓴다(유형 공략도 표현이 1개 이상이다 — zod가 보장한다). quiz 개수는 보지 않는다(§7-1). **틀 은행은 이 판정을 통과하지 못한다**(`entries` 0) — 그래서 틀 은행을 여는 곳은 전부 아래 전용 판정을 쓴다.
  - 유형 공략이면 `isRenderableToeicGuide`(kind "part"·part·섹션·블록·줄 배열과 문자열 자리)를 더 본다. 이 판정은 **📖 읽기 탭과 폴더 카드의 "가져옴" 표시만** 막는다. 시험 페이지(`/toeic/sets/[id]/quiz|wrong|history`)는 `isRenderableToeicSet`만 본다 — 시험은 `entries`·`quiz`만 쓰므로 본문이 깨져도 시험은 된다.
  - 틀 은행이면 `isRenderableToeicTemplateBank`(kind "templates"·`flows`·`items` 배열, 흐름마다 `steps` 배열·`banksKo` 배열, 틀마다 `key`·`frameEn`·`frameKo`·`groupKo`·`parts`·`guideRefs`·`testFills` 문자열·배열, `examples` 배열의 `en`·`ko`·`fills`)를 본다. 판정은 **틀 하나 단위로도** 한다(`isRenderableToeicTemplate`) — 모양이 깨진 틀은 그 틀만 빠지고 나머지는 보인다(② 탭 머리의 "열지 못한 틀 n개" — §12-5-1).
  - 연습 문서는 `isRenderableToeicMock` 그대로다. 파트 배열의 길이는 보지 않으므로 사진 1장짜리 파트도 통과한다.
- 형식표·지시문·채점 규칙은 새로 두지 않는다. 바뀌는 순수 규칙은 §12-7의 연습 단위표와 지시문 변형 하나다.

**기존 목록에서 가리는 곳** — 판정 함수 `isToeicGuideSet(s) = s.guide !== null`(유형 공략과 틀 은행 둘 다), `isToeicDrill(m) = m.drillPart !== null` 하나만 쓴다. 종류를 가를 때만 `isToeicGuidePartSet`·`isToeicTemplateBankSet`(`guide.kind`)을 쓴다. **두 목록 모두 공략 계열·연습을 먼저 빼고 그다음에 `skippedCount`("형식이 맞지 않아 열지 못한 n개")를 센다.** 지금은 `stored.length − 렌더 가능 수`로 센다(`app/toeic/sets/page.tsx`·`app/toeic/mocks/page.tsx`). 순서가 반대면 공략 세트 4개·틀 은행·연습 전부가 "깨진 문서"로 보고된다.

| 자리 | 지금 | 바꾸는 것 |
|---|---|---|
| 표현집 목록 `/toeic/sets` | 전체 세트 | 공략 세트를 뺀다(먼저 빼고 `skippedCount`) |
| 모의고사 만들기 — 주제 칩·표현 수(`/toeic/mocks`), 활용할 표현(`POST /api/toeic/mocks`) | 전체 세트 · 전체 시험 세션 | 공략 세트를 뺀다. **숙련도를 매기는 시험 세션도 표현집 세트(`setId ∈ 표현집 세트`)의 것만** 넘긴다. 통계 키가 표현 문자열이라(`pickExpressionsForMock`), 공략 시험 세션을 섞으면 같은 글자의 표현집 표현 순위가 바뀐다. 실전 모의고사의 입력은 지금과 같게 둔다(§12-12 1) |
| 모의고사 목록·제목 번호(`nextToeicMockTitle`) | 전체 모의고사 | 연습을 뺀다(먼저 빼고 `skippedCount`). 목록은 개수 상한 없이 읽어 메모리에서 거른다. 상한 500으로 자른 뒤 거르면 연습이 많아질 때 오래된 모의고사가 빠진다. Firestore `where`로 거르면 필드가 없는 옛 문서가 빠지고, `orderBy`와 섞으면 복합 색인이 필요하다 |
| 모의고사 학습 보기 `/toeic/mocks/[id]` | 모든 문서 | 연습이면 **무조건** 그 유형 폴더(`/toeic/guides/{part}?tab=drill`)로 보낸다(응시 전 모범답변 노출 방지). 응시 뒤의 복습 자료는 결과 화면이 보인다(§12-7-5) |
| 파트 다시 만들기 `…/regenerate?part=` | 빈 파트를 채움 | 연습이면 409 `is_drill`(연습에 다른 파트가 생기지 않게 — 계약 유니온에 추가) |
| 사진 `POST …/[id]/image {slot}` | slot 0\|1 | **변경 없음** — 문서의 `picture.items[slot]`이 없으면 기존 **404 `picture_not_found`**가 AI 호출 전에 막는다. 연습 사진 묘사는 칸이 하나라 slot 1이 비용 0으로 거절된다(eval로 잠근다 — 계약을 바꾸지 않는다) |
| 표현집 상세 `/toeic/sets/[id]` | 모든 세트 | 유형 공략이면 그 유형 폴더(`?tab=quiz`)로, **틀 은행이면 `/toeic/guides`**(폴더 목록)로 보낸다 |
| 표현 시험 페이지 `/toeic/sets/[id]/quiz\|wrong\|history`, 저장 `POST /api/toeic/sets/[id]/quiz` | 렌더 가능한 세트 | 틀 은행이면 페이지는 `/toeic/guides`로 보내고, 저장 라우트는 지금처럼 404 `set_not_found`다(`isRenderableToeicSet`이 막는다 — 틀 모드는 이 라우트의 `mode` enum에도 없다). 틀 테스트는 전용 라우트로만 저장한다(§12-5-6). **2026-10-02**: 유형 공략 세트(`guide-{part}`)이면 세 페이지 모두 그 유형 폴더 `?tab=quiz`(③ 틀 시험)로 보낸다 — 유형 폴더의 교재 표현 시험을 닫는다(§12-13-2). 저장 라우트는 바꾸지 않는다(옛 탭에서 끝난 판이 버려지지 않게) |
| 세트 이름 바꾸기·발화 포인트(`…/rename`·`…/points`) | 모든 세트 | 공략 계열(유형 공략·틀 은행)이면 409 `is_guide`(이름은 고정, 발화 포인트는 이번 범위 밖 — §12-6) |
| "뒤로"·이동 링크 | `/toeic/sets/[id]`·`/toeic/mocks/[id]` 하드코딩(문구 "표현집으로"·"학습 보기") | 서버 페이지가 `guide`·`drillPart`를 보고 "뒤로"를 내려준다(공략 폴더로 — 구현은 순수 함수 `toeicSetBackLink`(`lib/toeic-guide-view.ts` — 그 유형 폴더 ③ 탭)·`toeicMockBackLink`(`lib/toeic-drill-view.ts` — ④ 탭)이고, 문구는 헤더 "← Q3–4 공략", 끝 화면·빈 카드 버튼 "🧭 Q3–4 공략으로"처럼 유형 짧은 표기를 붙인다. 폴더 헤더의 "← 유형별 공략"은 폴더 목록으로 가므로 목적지가 다른 같은 문구를 피했다. 표현집·모의고사는 기존 문구 그대로). 바꿀 곳 전부: 시험 페이지 `app/toeic/sets/[id]/quiz/page.tsx`(헤더 링크·말하기 0문항 카드의 "📒 표현집으로"), 오답노트 `…/wrong/page.tsx`, 기록 `…/history/page.tsx`(두 곳), 시험 러너 `components/toeic-quiz-runner.tsx`(끝 화면 링크 — 페이지가 넘긴 `backHref`를 쓴다), 응시 페이지 `app/toeic/mocks/[id]/take/page.tsx`(오류 분기의 링크), 응시 화면 `components/toeic-take-view.tsx`(세 곳), 결과 페이지 `app/toeic/attempts/[id]/page.tsx`, 결과 화면 `components/toeic-attempt-view.tsx`(끝 버튼 줄 — §12-7-5). 학습 보기·표현집 상세 리다이렉트가 받쳐 주긴 하지만, 한 번 더 튀고 문구가 틀린다 |
| 스트릭 라벨(`/api/streak`) | `표현집 · …` / `모의고사 · …` | §12-9 |

### 12-4. ① 공략 읽기 + 🔊

> 2026-10-02 — 이 절 위에 **외울 틀 강조와 같은 자리 다른 표현 접기**가 얹힌다(§12-13-1): 대본에 옵션 `skip`(접은 줄·블록을 섹션 ▶·처음부터·프리페치에서 뺀다), 줄 머리 🧩 칩이 "🧩 외울 틀" 강조가 되고, `?goto=k:{틀 key}`가 더해진다. 아래 규칙(정리 함수·조각 순서·캐시 키·듣기 바)은 그대로다.

**대본 — 순수 함수** `buildToeicGuideScript(guide, mode, { pause?, pauseLevel? })` → `{ text, lang, section, block, line, pauseAfterMs }[]` (`lib/toeic-guide.ts` — `pauseAfterMs`는 "영어만" + `pause: true`일 때 영어 조각에만 싣고, 그 밖에는 0이다. 조각이 나뉘면 마지막 조각에만, 클라이언트 번들 안전 — 런타임 import는 `tts-shared`·`tts-split`·`ja-coaching-script`의 `normalizeKoForTts`·`toeic-text`의 `countWords`(쉼 계산 `shadowPauseMs` — 검토 개선 6)뿐, 정규식 lookbehind 금지). `block`이 null이면 섹션 제목·소개 조각, `line`이 null이면 블록 단위 조각(제목·본문·캡션), `line: "lead"`는 머리말 줄이다. 화면은 판단하지 않고 소비만 한다(§6-3·§18-1 관용구).

| 자리 | 모드 `all`(기본, 화면 "전부") | 모드 `english-only`(화면 "영어만") |
|---|---|---|
| 섹션 | `titleKo`(ko) → `introKo`(ko) → 블록들 | 블록들 |
| `heading` | `textKo`(ko) | — |
| `text` | `titleKo`(ko) → `bodyKo`(ko) → 줄들 | 줄들 |
| `lines`(`list`·`template`) | `captionKo`(ko) → `lead` → 줄들 | `lead` → 줄들 |
| `lines`(`completions`) | `captionKo`(ko) → `lead.ko`(ko) → 줄들. **`lead.en`은 따로 읽지 않는다** — 줄마다 들어 있다 | 줄들 |
| 줄 | `guideLineEn`(en-US) → `ko`(ko-KR) → `example.en`(en-US) → `example.ko`(ko-KR) | `guideLineEn` → `example.en` |

- **줄의 읽을 영어** `guideLineEn(block, line)`(순수, 같은 파일): `completions` 블록이면 `` `${lead.en.trimEnd()} ${line.en.trimStart()}` ``(머리말 + 조각 = 완성 문장), 그 밖에는 `line.en`. 대본·줄 🔊·프리페치·말하기 문항 합성 규칙(§12-2-1)이 모두 이 함수 하나를 거친다. 그래서 "영어만"에서 따라 할 완성 문장이 나오고, 셋의 글자가 같아 캐시가 맞는다. 지어낸 예: 머리말 `Two cooks are` + 줄 `slicing bread.` → `Two cooks are slicing bread.`

- `label`·`note`·`marked`는 읽지 않는다(화면 표시만). 유형 소개(`introKo`)는 화면 맨 위에만 있고 대본에 넣지 않는다.
- **영어 정리** `cleanGuideEnForTts`: `{…}` 슬롯과 `~`·`～`·`〜`는 말줄임표 `…`로(말줄임표 바로 뒤의 쉼표·마침표는 뗀다), `/`는 `, `로(대안을 나열해 읽는다), 소괄호 `()`는 떼고 안의 글은 남긴다(생략 가능 단어 — §12-2-1 괄호 표의 (b). 영어 대안 (a)는 가져오기 파일에서 이미 슬래시로 바뀌었고 대괄호는 zod가 막는다), 문장부호 앞 공백 제거·연속 공백 접기·trim. 라틴 문자가 남지 않으면 조각을 만들지 않는다. 예(지어낸 것): `My pick is {선택}, mainly since {이유}.` → `My pick is … mainly since …`, `It looks busy/crowded.` → `It looks busy, crowded.`
- **한국어 정리** `cleanGuideKoForTts`: **먼저** 자리 표시 `~`·`～`·`〜`·en dash `–`와 **이름 있는 자리 `{…}`**(한국어 틀 `frameKo` — §12-5-2의 틀 소개가 이 함수를 쓴다, 검토 개선 1)를 말줄임표 `…`(쉼)로 바꾸고(자리 이름은 읽지 않는다 — "{활동}은"은 "…은". 영어 틀의 자리 "…"와 같은 소리다), 공식 표기 `+`와 `/`를 `, `로 바꾼 뒤, `normalizeKoForTts`(화살표·이모지 — SPEC §18-1)를 부르고 공백을 접는다. 순서가 중요하다 — `normalizeKoForTts`는 전각 물결을 **지운다**. 공략의 `~`는 문장 가운데에 있고 바로 뒤에 조사가 붙는다(원본 한국어 `~` 62줄 중 56줄). 그래서 지우면 조사만 남는다(지어낸 예: "그 행사는 ~에서 열려요" → 지우면 "그 행사는 에서 열려요", 바꾸면 "그 행사는 …에서 열려요"). 표현집 전체 듣기(`cleanKoForListen`)는 `~`를 지운다. 거기서는 `~`가 뜻 머리에 있어 문제가 작았다 — 그 함수는 바꾸지 않는다. 지시문(`lib/tts.ts`의 ko-KR)을 고치지 않는다 — 한국어 문장 속 영어 단어(팁)는 ko-KR 클라우드 음성이 그대로 읽는다. 지시문을 고치면 `TTS_INSTRUCTIONS_VERSION`이 올라 **전 언어 영속 캐시가 비워진다**(§10 알려진 한계, SPEC §18-3).
- 모든 조각은 정리 **뒤** `splitForTts(…, TTS_TEXT_MAX_CHARS)`를 거친다(영어 줄은 300자 이하지만 `/` → `, `가 글자를 늘릴 수 있다). 불변식(eval): trim·비어 있지 않음·≤300·lang 명시·조각 순서가 위 표와 같음.
- **줄의 🔊와 섹션 재생과 프리페치는 같은 함수(`guideLineEn` → 정리 함수)를 거친 같은 글자**다 — 캐시 키(`${lang}:${speed}:${text}`)가 글자까지 같아야 맞는다(`lib/toeic-listen.ts` 머리 주석과 같은 규칙).

**화면**(`components/toeic-guide-read-view.tsx` — SPEC §18-4 관용구 그대로):

- 줄 렌더링: `label` 칩 · `en` · 🔊 / 그 아래 `ko` · `note`(작은 글씨) · `example`(들여 쓴 "예" + 🔊) · `marked`면 줄 머리에 작은 ✎ 표시. 모든 글은 텍스트로만 넣는다(HTML 해석 없음).
  - `en` 분할은 순수 함수 `splitGuideEnForDisplay(en, emphasis, underline)`가 한다. 슬롯 `{…}`는 자리 이름 칩, `emphasis`는 형광, `underline`은 밑줄로 보인다. 글자마다 표시(슬롯·형광·밑줄)를 매긴 뒤 같은 표시가 이어지는 구간으로 묶는다. 조각을 이어 붙이면 원문과 같다. 구간 위치는 그 글자의 첫 등장이고, 같은 배열 안에서는 긴 것 먼저(같은 길이면 글에서 앞에 나오는 것 → 배열 순서)로 잡으며, 겹치면 뒤의 것을 건너뛴다. 형광과 밑줄은 서로 겹쳐도 둘 다 보인다.
- 블록 모양
  - `style: "template"`은 라벨 열 + 문장 열 카드로 보이고, `alt` 줄은 앞 줄과 "또는"으로 잇는다.
  - **`style: "completions"`**는 머리말(`lead` — en·ko)을 블록 머리에 한 번 보인다. 줄마다 머리말 영어를 흐린 글씨로 앞에 붙이고 조각을 이어 보인다(완성 문장이 눈에 보이게). 강조는 조각 쪽에만 있다. 머리말 줄에는 🔊를 두지 않는다 — 줄 🔊가 이미 완성 문장을 읽는다.
  - `text` 블록의 `bodyKo`는 줄바꿈을 지켜 보인다(`white-space: pre-line` — 공식 두 줄 등).
- 섹션은 접을 수 있다(`<details>`, 첫 섹션만 열림). 맨 위에 섹션 목차 칩 — `groupKo`가 있으면 칩을 그 이름으로 무리 지어 보인다(대본에는 넣지 않는다).
  - **`?goto=`로 열리면**(§12-5-7) 첫 렌더부터 첫 섹션과 목표 섹션을 연다(`guideReadInitialOpen(sections, goto)` — 서버 HTML부터 `<details open>`). 스크롤은 **열림이 커밋된 뒤에만** 한다 — 목표 블록의 `<details>`가 아직 닫혀 있으면 목표를 남겨 두고, `useLayoutEffect`가 커밋마다 남은 목표를 다시 본다(`requestAnimationFrame`으로 스크롤하지 않는다). 닫힌 `<details>` 안의 블록은 상자가 없어 `scrollIntoView`가 헛돈다 — 앱 안 이동·새로 불러오기·다른 폴더가 모두 뷰를 새로 마운트하는 경로라 엔진마다 갈리던 경합이었다(QA final P2-1). 같은 목표면 `router.refresh`로 데이터가 새로 와도 다시 끌어내리지 않는다(효과 키가 블록 주소 문자열).
  - **목차 칩**은 그 섹션의 `<summary>`로 스크롤한다(`summary[data-addr="s:{i}"]`). `scroll-margin-top`(스트릭 + 듣기 바 + 8px)이 summary에만 있어, `<details>`로 스크롤하면 섹션 머리가 sticky 헤드라인·듣기 바 밑에 가린다.
  - `?goto=` 값은 `t:{템플릿 줄 label}`·`l:{머리말 영어}`(`guideRefHref`)라 주소에 교재 조각이 실린다 — dev 서버 로그에 남으므로 검증 뒤 그 로그를 지운다(번호 주소로 바꿀지는 열린 문제 — QA 판단 요청).
- **🔊 세 층**: 줄 🔊 = 그 줄의 조각(현재 모드), `text` 블록 🔊 = 그 블록의 조각, 섹션 ▶ = 그 섹션 첫 조각부터 끝까지 이어 듣기(절대 인덱스 오프셋, §18-4). 전부 `speakQueue`를 **탭 핸들러 안에서 동기로** 부른다. 멈출 때는 큐가 돌려준 stop을 쓴다(`stopSpeaking` 금지). 재생이 접힌 섹션에 닿으면 그 섹션을 연다.
- **듣기 바**(sticky, `top: var(--streak-h, 0)`): "▶ 처음부터"·`■ 멈추기` + 진행 `{i+1} / {n}`(조각 기준, `aria-live="polite"`), 모드 전환("전부 / 영어만" — 바꾸면 재생을 멈춘다: 대본 내용 키가 바뀐다), **"영어만"일 때 "따라 말할 틈" 토글**(기본 **끔** — 검토 반영: 읽기 탭은 듣기가 목적인 경우가 많고, 켜면 길이가 두 배가 된다. 켜면 영어 조각마다 `pauseAfterMs = shadowPauseMs(text, level)`를 싣는다. 쉼 규칙·계산·틈 길이 세 단계는 템플릿 따라 말하기와 **같은 함수·같은 기기 설정**이다 — §12-5-2. 토글과 단계도 대본 내용 키에 든다. 토글 자체는 기기에 기억하지 않는다 — 탭을 열 때마다 끔이다. 단계만 따라 말하기 설정 `toeic-shadow-settings:v1`을 함께 쓴다), `<details>` "⚙️ 소리 설정" 안에 `TtsSpeedControl`·`TtsEngineControl lang="en-US"`·`TtsEngineControl lang="ko-KR"`(속도·엔진은 전역 설정 공유 — SPEC §15-2·§16-5). 지금 읽는 줄(없으면 블록, 섹션 제목) 강조·`scrollIntoView({block:"nearest"})`·`scroll-margin-top`은 §18-4 그대로.
- 정지 조건: 언마운트, 대본 내용 키(`lang|text` 줄들) 변경, 탭 전환.
- **프리페치**: 열린 섹션들의 **영어 조각만** 문서 순서로 `prefetchSpeech(texts, "en-US")`(상한 `PREFETCH_MAX_ITEMS` 90은 함수가 자른다), 의존성은 문자열 키. 한국어는 미리 받지 않는다(큐의 look-ahead 2조각에 맡긴다 — 안 들을 수도 있다, §18-5 비용 가드).
- 비용·캐시: AI 0, 클라우드 TTS만(유형 하나 전부 들으면 영어·한국어 조각 수백 개 — "무시할 만한" 규모, §16-0). 영속 캐시(1000개·50MB LRU)를 전 과목이 함께 쓰므로 네 유형을 모두 들으면 오래된 조각(은우 단어 오디오 포함)이 밀려날 수 있다 — 한국어를 통째로 미리 받지 않는 것으로 줄인다(알려진 한계).
- **틀로 가는 🧩 칩** — 두 자리에 붙는다(검토 B5 — 블록에만 붙이면 연결된 교재 표현이 목록 줄에 있을 때 칩이 하나도 안 보인다).
  - **블록 머리**: 틀 은행의 어떤 틀이 `guideRefs`로 가리키는 블록 — `kind:"template"`이면 그 `label`의 템플릿 줄이 든 블록, `kind:"lead"`면 그 머리말의 이어 말하기 블록 — 머리에 "🧩 템플릿 훈련 n" 칩.
  - **줄 머리**: `list` 블록의 머리말(`lead`)·줄 중, 그 영어(`en`)를 `~` 모양으로 바꾼 글자(`{…}` → `~`, 공백 접기, 끝 마침표 하나 떼기 — `frameToExpression`과 같은 규칙)의 `matchKey`가 어떤 틀이 연결한 **교재 표현**의 `matchKey`와 같은 것 → 그 줄 머리에 "🧩" 칩. 슬래시 대안이 든 줄은 대안을 펼친 글자 중 하나가 맞으면 된다.
  - 누르면 ② 탭의 그 틀(여럿이면 첫 틀)로 간다(`?tab=templates&tpl={key}`). 판정은 순수 함수 `templateLinksForGuide(bank, part)` → `{ templateLabels: Map<label, key[]>, leads: Map<leadEn, key[]>, expressions: Map<expressionKey, key[]> }` 하나가 한다(`guideRefs` 배열을 모두 본다 — ③ 표현 시험 탭도 같은 함수, §12-6). 줄 머리 판정은 이 함수의 `expressions` 맵을 그대로 쓴다. 가리키는 틀이 없으면 칩도 없다.

### 12-5. ② 템플릿 훈련 — 틀을 되풀이해 입에 붙인다

학습 단위는 **틀**이다(§12-0). 틀 하나에 주제가 다른 예문 3~5개가 있고, 따라 말하기는 그 예문들을 이어서 들려준다 — 귀에는 같은 뼈대가 주제만 바뀌며 되풀이된다. 테스트는 틀을 말로 꺼내게 하고, 받아쓰기로 틀 부분이 맞았는지 먼저 보여 준 뒤 아빠가 ○/✕를 정한다. 틀린 틀만 다시 따라 말하고 다시 테스트하는 것이 한 바퀴다. 외운 틀을 실제 문제에 조합하는 연습은 ④ 한 문제 연습이 받는다(§12-7-9).

#### 12-5-0. 한 바퀴

1. **틀 보기** — 폴더의 ② 탭. 답변 흐름의 **단계** 순서로 묶음이 늘어서고, 그 뒤에 **소재 묶음**이 온다(§12-2-7 `flows`). 틀마다 카드 하나(§12-5-1).
2. **따라 말하기** — 묶음 하나(기본)를 골라 ▶. 예문마다 한국어 1번 → 영어 N번(기본 4) + 따라 말할 틈(§12-5-2). 화면을 끄거나 잠가도 이어지는 것을 목표로 한다(best-effort — 클라우드 음성일 때).
3. **테스트("🧩 틀 테스트")** — 같은 묶음으로 (가) 예문 말하기 또는 (나) 틀 바꿔 말하기(§12-5-3). 문항마다 녹음 → 받아쓰기 → 틀 비교 → 아빠 ○/✕. 판정은 정답을 보기 전의 첫 유효 시도로 한다.
4. **틀린 틀만 다시** — 끝 화면의 "틀린 틀만 따라 말하기" → "틀린 틀만 다시 테스트". ✕ 배지가 남아 있는 동안 되풀이한다.
5. **졸업** — 한 모드에서 **서로 다른 날** 두 번 잇달아 ○면 🎓(§12-5-6). 다음 묶음으로 간다.
6. **실전 적용** — ④ 탭에서 한 문제를 풀면, 모범답변이 이 유형 틀을 쓰고 결과 화면이 "내 답에서 쓴 틀 / 빠진 단계 / 쓸 수 있었던 틀"을 보인다(§12-7-9).

화면은 각 단계 끝에 다음 단계로 가는 버튼을 둔다(따라 말하기 끝 → "이 묶음 틀 테스트", 테스트 끝 → "틀린 틀만 따라 말하기"). 따라 말하기와 테스트를 번갈아 하는 것이 참고 자료가 권한 방법이다.

#### 12-5-1. 틀 탭과 틀 카드 (`components/toeic-template-view.tsx`)

- **데이터**: 서버 페이지가 틀 은행 문서(`guide-templates`)와 그 세션(`toeicQuizzes`, `setId = guide-templates`), 그리고 그 유형 공략 세트의 세션(표현 시험 배지용)을 읽는다. 그 유형 틀 = `parts`에 그 유형이 든 틀 중 렌더 가능한 것(§12-3).
- **흐름 순서** — 한 곳에서 정한다(`templateFlowOrder(bank, part)` — 순수, 목록·대본·테스트 재정렬·연습 틀 고르기가 같이 쓴다): 그 유형 `flows`의 단계 순서 → 단계 안 묶음 순서 → 소재 묶음 순서 → 묶음 안은 파일 순서. 흐름에 없는 묶음의 틀은 맨 뒤 "기타"로 모은다(zod가 막지만 정규화된 옛 문서를 위한 방어).
- **머리**
  - **"이어서 하기" 카드**(검토 S10): 흐름 순서로 첫 **미졸업 묶음**(그 묶음 틀 중 틀 바꿔 말하기에서 졸업하지 않은 틀이 있는 첫 묶음)을 골라 한 줄로 보인다 — "{묶음} · ▶ 따라 말하기(약 n분) · 🧩 틀 테스트". 모두 졸업이면 "다 익혔어요 — 🧩 틀 테스트로 복습"(복습 칸이 오래된 졸업 틀을 올린다 — §12-5-3). 첫 방문에 카드 수십 장 앞에서 어디서 시작할지 막막하지 않게.
  - **단계 칩 줄**(단계마다 "{단계} · 틀 n · 익힘 m" — 익힘은 폴더 카드와 같은 정의(틀 바꿔 말하기 졸업, §12-5-6), 누르면 그 단계로 스크롤)과, 소재 묶음이 있으면 **소재 칩 줄**. 줄마다 가로로 민다(칩 줄 안의 가로 스크롤 — 페이지 가로 스크롤은 없다).
- **목록**: 단계 제목(단계 이름 · 틀 수) → 묶음 소제목(묶음 이름 · 예상 시간 · "▶ 이 묶음" · "🧩 테스트") → 틀 카드. 소재 묶음은 단계 뒤 "소재별 틀" 제목 아래에 같은 모양으로.
- **틀 카드**
  - **틀 줄**: `frameEn`을 순수 함수 `splitFrameForDisplay(frameEn)`로 고정 조각과 자리로 나눈다. 고정 부분은 굵게, 자리는 **자리 칩**(자리 이름 — 자리 순서마다 다른 색, 기존 CSS 변수만)으로 보인다 — 틀이 눈에 보이게. 틀 줄 자체는 소리로 읽지 않는다(예문이 읽는다. 영어 틀 소개를 켜면 대본이 읽는다 — §12-5-2).
  - **한국어 틀**: `frameKo`를 같은 함수로 나눠 같은 자리 이름을 같은 색 칩으로 보인다 — 영어와 한국어의 어느 자리가 짝인지 보인다.
  - `useKo`(작은 글씨), 출처 칩(`source:"guide"`면 "📘 교재 틀" — §12-5-7, `"new"`면 "새 틀"), `parts`가 둘 이상이면 "Q5–7 · Q11 공통" 칩.
  - **예문 목록**: 줄마다 `en` · 🔊(en-US) / 그 아래 `ko`. `en` 안의 채움 구간을 그 자리 색 밑줄로 보인다 — 순수 함수 `splitExampleByFills(frameEn, fills)`가 틀 고정 조각과 채움 i 구간을 돌려준다(예문이 틀 + 채움과 글자까지 같으므로 위치가 결정적이다).
  - 테스트 전용 채움(`testFills`)은 카드에 보이지 않는다(틀 바꿔 말하기에서 처음 본다 — §12-5-3).
  - **배지**: 두 테스트 모드마다 상태(§12-5-6), 그리고 `guideRefs`에 공략 표현이 있으면 그 표현의 표현 시험 상태(읽기만 — 따로 센다. 뜻→표현·표현→뜻 두 모드 중 **시도가 있는 모드만** 보인다 — 카드마다 "안 해 봄" 줄이 늘지 않게, 그 유형 공략 세트의 세션만 읽는다). **2026-10-02 대체**: 표현 시험 상태 줄을 **③ 틀 시험 상태 줄**로 바꾼다 — 그 틀 자신의 고르기 세 모드 배지(틀 은행 세션, 시도가 있는 모드만, 배지 규칙은 §12-5-6과 같다 — §12-13-2). 폴더 페이지는 유형 공략 세트의 시험 세션을 더 읽지 않는다.
  - 카드 ▶: 그 틀의 예문 전부를 지금 따라 말하기 설정으로(§12-5-2 범위 "이 틀").
- `?tpl={key}`로 열리면 그 카드로 스크롤·강조한다(다른 탭의 🧩 칩이 여기로 온다).
- **빈 상태**: 틀 은행이 없거나 그 유형 틀이 0개면 "아직 틀이 없어요" + "📂 파일로 가져오기". 모양이 깨진 틀은 빠지고 **② 탭 머리**에 "형식이 맞지 않아 열지 못한 틀이 n개 있어요"를 보인다(그 유형 틀이 모두 깨졌으면 빈 상태 문구에 그 수를 덧붙인다 — `guideTemplatesForPart`가 렌더 가능한 틀과 깨진 수를 함께 돌려준다). 폴더 목록 카드에는 틀 은행 전체가 열리지 않을 때만 안내가 뜬다.
- 모든 글은 텍스트로만 넣는다(HTML 해석 없음).

#### 12-5-2. 따라 말하기 — 한국어 1번 → 영어 N번 + 틈

**대본 — 순수 함수** `buildTemplateShadowScript(templates, opts)` → `{ text, lang, pauseAfterMs, key, example, rep }[]` (`lib/toeic-template.ts`). 화면은 판단하지 않고 소비만 한다(§12-4와 같은 관용구).

- `opts`
  - `repeat` 1~4(기본 4 — `TOEIC_SHADOW_REPEAT_DEFAULT`).
  - `pause`(따라 말할 틈, 기본 켬)와 `pauseLevel`(`"short" | "normal" | "long"`, 기본 `"normal"` — 배율 0.8·1·1.5, `TOEIC_SHADOW_PAUSE_LEVELS`. 검토 S2: 성인 학습자는 원어민의 1.3~1.5배 걸린다 — 켬/끔만 두면 긴 문장에서 다음 반복과 겹친다).
  - `intro`(한국어 틀 소개, 기본 켬), `introEn`(영어 틀 소개, 기본 끔 — 검토 S16: 소리만 들을 때 뼈대가 따로 들리게).
- 틀마다: (`intro`면) 한국어 틀 `frameKo`를 한 조각(ko-KR — `cleanGuideKoForTts`가 자리 `{…}`를 "…"로, `example: null`·`rep: 0`) → (`introEn`면) 영어 틀 `frameEn`을 `cleanGuideEnForTts`로(자리 "…") 한 조각(en-US, 쉼 없음, `example: null`·`rep: 0`) → 예문마다 `ko` 한 조각(ko-KR, 쉼 없음, `rep: 0`) → `en`을 `repeat`번(en-US, 조각마다 `pauseAfterMs = pause ? shadowPauseMs(en, pauseLevel) : 0`, `rep` 1..N). 그다음 예문, 그다음 틀.
- 예문 `en`은 **trim만** 한다 — 카드의 🔊·테스트의 정답 🔊와 캐시 키가 글자까지 같아야 한다. N번 반복하는 영어 조각은 글자가 같아 합성은 한 번이고 나머지는 캐시다. 한국어(`ko`·틀 소개)는 `cleanGuideKoForTts`(§12-4 — 자리 "…" 규칙 포함)를 거친다.
- 모든 조각은 `splitForTts(…, TTS_TEXT_MAX_CHARS)`를 거친다(zod 상한 안이라 대개 한 조각). 나뉘면 쉼은 마지막 조각에만 싣는다. 불변식(eval): trim·비어 있지 않음·≤300·lang 명시·순서가 위와 같음·반복 조각의 글자가 같음.

**쉼** `shadowPauseMs(text, level = "normal")`(`lib/toeic-guide.ts` — 공략 읽기 "영어만"의 틈도 같은 함수, §12-4): 속도 1 기준 `clamp(700 + 400 × 낱말 수, 1500, 8000) × 단계 배율`ms(`TOEIC_SHADOW_PAUSE = { baseMs: 700, perWordMs: 400, minMs: 1500, maxMs: 8000 }`, 낱말 수는 `countWords`). 지어낸 예: 8낱말 문장이면 보통 3,900ms, 길게 5,850ms. 문장이 길면 따라 말할 시간도 길다. 재생할 때 큐가 실제 말 속도로 나눈다(아래) — 느리게 들으면 틈도 길어진다.

**예상 시간** `estimateShadowMs(script, speedFactor = 1)`(`lib/toeic-template.ts`, 검토 S3): 조각마다 말 길이 추정(영어 낱말 × 380ms, 한국어 글자(공백 뺌) × 180ms, 조각 사이 300ms — `TOEIC_SHADOW_ESTIMATE`) + 쉼을 더하고 `speedFactor`로 나눈다. 범위 옆 "약 n분"과 eval이 **같은 함수**를 쓴다. 원본 기준(반복 4·틈 보통·속도 보통): 폴더 전체 약 2~3.2시간, 묶음 하나 약 3~20분, 틀 하나 중앙 약 3.2분(§12-2-7 실측). 그래서 묶음이 기본 단위다.

**`speakQueue` 쉼 — 공용 모듈 변경(`lib/speech.ts`, 하위 호환 추가)**

- `SpeakQueueItem`에 선택 칸 `pauseAfterMs?: number`, 핸들러에 `onPause?(index, ms)`를 더한다(함수 입력이라 선택 칸을 쓴다 — 저장 레코드의 "선택 키 금지"와 무관하다).
- 큐는 입력을 `{ text, lang }`으로 **다시 만든다**(`speakQueue` 첫 줄의 `list = items.map(…)`). 여기서 `pauseAfterMs`도 함께 옮긴다 — 빠뜨리면 쉼이 조용히 사라지고 기존 eval은 모두 통과한다(검토 개선 3).
- 조각 i가 끝난 뒤(소리를 냈든 못 냈든 — 공백이라 건너뛴 조각은 빼고) 큐가 살아 있고 `pauseAfterMs`가 유한한 양수면
  - `ms = min(pauseAfterMs ÷ speedFactor(그 조각의 lang), queueTiming.pauseMaxMs)`. `speedFactor`는 그 조각의 **실제 말 속도 배율**이다 — 클라우드 엔진이면 `cloudSpeed()`(보통 1 · 천천히 0.85 · 빠르게 1.15), 기기 음성이면 `getTtsRate() ÷ TTS_RATE`(보통 1). 기본 설정에서 쉼은 공식 그대로다(검토 개선 4 — `getTtsRate()`로 바로 나누면 기본값 0.9 때문에 쉼이 11% 길고, 쉼과 소리가 다른 비율로 늘어난다). `pauseMaxMs` 15,000(테스트 훅 `__setQueueTiming`으로 줄인다).
  - `onPause(i, ms)`를 부르고, **쉼을 무음 조각으로 재생한다**(검토 B1 (가)). 큐 오디오 요소(`queueAudio` — 탭 안에서 풀어 둔 요소 하나)로 `ms` 길이의 무음 WAV를 클라우드 조각과 **같은 재생 경로**(`playBlob` — `ended` 사슬·`currentPlayStop`·재생 안전 타임아웃·외부 pause 판정)로 튼다. 오디오 세션이 끊기지 않으므로 화면이 잠겨도 다음 조각으로 이어질 수 있다. JS 타이머로 기다리면 iOS가 화면 잠금과 함께 멈춘다(SPEC §18-2).
  - 무음 WAV는 지금의 0.1초 잠금 해제용 생성기에 길이 인자를 더한 `makeSilentWav(ms)`가 만든다 — 8kHz·8bit·mono, 250ms 단위로 올린 길이마다 한 번 만들어 모듈 안에 둔다(15초가 약 120KB, 최대 60개). 0.1초는 예전과 같은 844바이트다.
  - (구현 반영) `onPause`의 `ms`는 정수다(나눗셈 → 반올림 → 상한, 최소 1). 실제 무음은 250ms로 올린 길이라 `ms`보다 최대 249ms 길고, 엔진이 조각마다 붙이는 여유(헤드리스 실측 Chromium 약 0.07~0.32초 · WebKit 약 0.33~0.46초)도 더해진다 — 화면의 "약 n분"은 과소 추정 쪽이다. 기기 음성으로 난 조각 뒤에도 큐 요소가 있으면 무음 WAV를 튼다(타이머는 아래 경우만). 배율은 그 조각이 **실제로 난 경로**의 것이다 — 클라우드로 났으면 그 조각을 합성한 speed, 기기 음성으로 떨어졌으면 발화 직전의 `getTtsRate() ÷ TTS_RATE`. 설정 기준 배율은 공개 함수 `getSpeechSpeedFactor(lang)`이고, 화면의 예상 시간(`estimateShadowMs(script, getSpeechSpeedFactor("en-US"))`)이 이것을 쓴다.
  - 무음 조각을 틀 수 없으면(오디오 요소가 없는 환경, `play()`가 AbortError가 아닌 이유로 거부) 타이머로 기다린다. AbortError 거부는 시작 순간의 외부 멈춤이라 타이머로 가지 않고 `"stopped"`로 끝난다(§18-2 외부 pause와 같은 규칙). 이 기다림도 `currentPlayStop`에 등록하고, 끝날 때는 **자기일 때만** 비운다(`if (currentPlayStop === stop) currentPlayStop = null` — `speakDeviceAwait`의 `finish` 관용구. 낡은 stop이 남으면 다음 `stopCloudAudio`가 URL 회수 분기를 건너뛴다 — 검토 개선 3).
- `cancelPlayback()`·새 큐·`stopSpeaking()`이 쉼을 **즉시** 끊는다(무음 재생이든 타이머든). 옛 큐의 `onEnd("stopped")`는 지금처럼 동기로, 새 큐의 `onItem(0)`보다 먼저 온다.
- 칸이 없거나 0 이하·유한수가 아니면 **쉼 경로를 아예 타지 않는다**(await가 하나 늘면 마이크로태스크 순서가 바뀐다 — 기존 호출부 전부가 이 경로다).
- 마지막 조각 뒤의 쉼도 지킨다(마지막 문장도 따라 말할 틈이 있어야 한다) — 그다음 `onEnd("done")`.
- 쉼은 `sounded`와 무음 연속 판정(`QUEUE_SILENT_STOP`)에 들지 않는다(무음 조각은 "소리를 낸 조각"이 아니다). look-ahead는 조각 재생을 시작할 때 이미 나가므로 쉼 동안 다음 조각이 준비된다.
- 잠금 화면 ⏸(우리가 일으키지 않은 pause)는 쉼 중에도 지금처럼 **정지**다(§18-2 — 호출부 공통). 이어 듣기는 이 플레이어만 Media Session으로 붙인다(아래).
- 기기 음성 폴백 조각은 화면이 잠기면 iOS가 멈춘다(speechSynthesis — SPEC §18-2). 그래서 잠금 화면 연속 재생은 **클라우드 음성일 때만** 기대한다. 아래 준비(`prepareSpeech`)가 폴백을 줄인다.
- **회귀 범위**: `eval:speech` 전체 — 기존 항목이 전부 그대로 통과하고 쉼 항목을 더한다(§12-10). 기존 호출부(표현집 전체 듣기·해설 낭독·응시 질문 음성·자유대화 설명 낭독·운동 안내)는 칸을 쓰지 않으므로 동작이 같아야 한다. 공유 모듈 규칙대로 `eval:toeic`·`eval:japanese`·`eval:english`·`eval:workout` 오프라인도 돌린다.
- 이것으로 옛 열린 결정 "공략 읽기 '영어만'에 따라 말할 틈을 두지 않는다"(§12-12 8)를 닫는다. 근거: 틈은 따라 말하기 방법의 본체다(틈이 없으면 듣기만 된다). 칸 하나를 더하는 변경이고 칸이 없으면 기존 경로를 그대로 타므로 네 과목 회귀를 오프라인 eval로 잠글 수 있다. 표현집 전체 듣기(§6-3)의 "영어만"에 같은 토글을 붙이는 것은 이번 범위 밖이다(§12-12 13).

**범위 미리 받기** `prepareSpeech(items, { signal, onProgress })`(`lib/speech.ts` 새 export — 검토 B1 (가))

- 조각 목록(`{ text, lang }`)의 고유 글자 중 **지금 클라우드 엔진으로 읽을 것**을 지금 속도로 합성해 캐시에 둔다(이미 캐시에 있으면 건너뛴다). 한 번에 하나씩, `PREFETCH_MAX_ITEMS`(90)에서 자른다. 진행은 `onProgress(done, total)`, 끊기는 `signal`. 반환 `Promise<{ ready, total }>`. 키가 없으면(501) 곧바로 끝낸다(기기 음성).
- (구현 반영) `total` = 고유(언어 + 글자) · 지금 클라우드 엔진 · `canUseCloud`(화이트리스트·300자) · **메모리 캐시에 없는** 조각을 문서 순서로 세어 90에서 자른 수다(IndexedDB 적중은 total에 들고 합성 없이 끝난다). 처음에 `onProgress(0, total)`, 그 뒤 조각마다 한 칸 — 성공·실패·대기 상한 모두 센다. **조각마다 대기 상한 `fetchMs`(8초)**를 둬 "준비 n/m"이 영영 멈추지 않게 하고, 넘은 요청은 끊지 않아 늦게라도 캐시에 남는다(큐와 같은 규칙). 도중에 그 언어 엔진을 기기로 바꾸면 남은 조각은 받지 않고 센다. 501이면 진행을 total까지 채우지 않고 `{ ready: 0, total }`. `signal`로 끊으면 reject하지 않고 그때까지의 수로 resolve한다(이어서 재생할지는 호출부가 자기 signal로 정한다). 같은 문장이 진행 중이면 그 합성을 함께 기다린다(POST 1회).
- 기존 `prefetchSpeech`(최근 요청이 이긴다 — 전역 abort)와 따로 둔다. 준비는 플레이어가 **기다리는** 요청이라 다른 화면의 프리페치에 끊기면 안 된다.
- 플레이어는 ▶ 탭 안에서 `unlockSpeechPlayback()`을 불러 큐 요소를 풀어 두고 "준비 n/m"을 보인다. 준비가 끝나면(또는 "바로 시작" 탭) 큐를 시작한다. 준비 뒤 시작은 탭 밖이지만 큐 요소가 이미 풀려 있다 — 운동 안내가 같은 방식으로 탭 밖 재생을 한다(§19). 백그라운드에서는 합성 요청이 늦어질 수 있어, 범위 조각을 미리 받아 두는 것이 잠금 화면 연속 재생의 전제다.
- 비용: 어차피 재생할 조각이라 같다. 한국어 조각을 미리 받는 곳은 이 준비뿐이다(▶를 눌렀을 때만).

**잠금 화면 조작 — Media Session**(따라 말하기 플레이어에서만)

- 재생을 시작하면 `navigator.mediaSession.metadata`(제목 "틀 따라 말하기", 부제 = 유형 이름 · 범위 이름)와 동작 핸들러를 건다 — `pause` = 멈추고 이어 듣기 위치 저장, `play` = 이어 듣기, `nexttrack` = 다음 예문 머리, `previoustrack` = 지금 예문 머리. 지원하지 않으면 조용히 넘어간다(best-effort).
- (구현 반영) 관문은 `lib/speech.ts` 밖의 **`lib/media-session.ts`**(`bindMediaSession({title, artist, actions})` → 풀기 함수, `setMediaSessionPlaybackState`, `isMediaSessionSupported` — 런타임 import 0)다. 풀기 함수는 **자기 바인딩일 때만** 푼다(낡은 정리가 뒤의 바인딩을 지우지 않게), 지원하지 않는 동작은 건너뛰고, 핸들러 예외는 삼킨다. 핸들러는 재생 시작 때 한 번 걸고 최신 상태는 ref로 본다.
- (구현 반영) **언제 푸는가**: 앱의 ■·화면 이탈(언마운트·탭 전환)·끝까지 들음, 그리고 외부 멈춤(`"stopped"` — 핸들러가 없는 브라우저)이면 푼다. **잠금 화면 ⏸(pause 핸들러)는 풀지 않는다** — 멈추고 위치를 기억한 채 `playbackState = "paused"`로 두어야 잠금 화면 ▶(play)로 이어 들을 수 있다. 외부 멈춤으로 풀린 뒤에는 앱의 "↻ 이어 듣기"로 잇는다.
- 다른 호출부(표현집 듣기·해설 낭독·응시·운동)는 Media Session을 쓰지 않는다 — 잠금 화면 ⏸ = 정지(§18-2)가 그대로다.

**플레이어** — 틀 탭 아래 sticky 바(`top: var(--streak-h, 0)` — 공략 읽기 듣기 바와 같은 관용구):

- **범위**: "이 묶음"(기본 — 고른 묶음) · "이 단계"(고른 묶음이 소재·기타 묶음이면 "소재 묶음 전체"로 잡고 칩 이름도 그렇게 바뀐다 — 소재 묶음에는 단계가 없다) · "여기부터 끝까지"(고른 묶음부터 흐름 순서로 폴더 끝까지 — 출퇴근 30~60분을 탭 없이 흘려 듣게, 검토 S3) · "이 틀"(카드 ▶) · "틀린 틀만"(두 테스트 모드 중 하나라도 틀렸고 미졸업 — §12-5-6) · "유형 전체". 범위마다 예상 시간(`estimateShadowMs`)을 보인다.
- **컨트롤**: ▶ 처음부터 · ■ 멈추기 · **이어 듣기** · 반복 1~4 · 틈 끔/짧게/보통/길게 · 한국어 틀 소개 켬/끔 · 영어 틀 소개 켬/끔 · `<details>` "⚙️ 소리 설정"(`TtsSpeedControl`·`TtsEngineControl` en-US·ko-KR — 전역 설정 공유, SPEC §15-2·§16-5). 반복·틈·소개는 기기에 기억한다(`localStorage` `toeic-shadow-settings:v1`, try/catch, 마운트 뒤 읽기 — 없으면 기본값. 공략 읽기의 틈 단계도 이 설정을 쓴다).
- **바에 지금 틀을 띄운다**(검토 S1): 바 안에 지금 틀 줄(`splitFrameForDisplay` — 고정 부분 굵게·자리 칩)과 지금 예문(`splitExampleByFills` — 채움 밑줄)을 한 줄씩 보인다. 카드가 길어 예문 줄로 스크롤하면 폰에서 틀 줄이 화면 밖으로 나간다 — 틀이 가장 보여야 할 순간에 보이게.
- **진행**: "틀 3/12 · 예문 2/4 · 영어 3/4" + 지금 틀 카드와 예문 줄 강조·`scrollIntoView({block:"nearest"})`. 쉼 동안(`onPause`) "🗣️ 따라 말해 보세요" 표시가 켜진다.
- **이어 듣기**: 마지막으로 시작한 조각 번호를 **대본 내용 키**(범위·반복·틈·소개와 조각 글자들 — 구현은 `shadowScriptSignature`: 조각 글자·lang·쉼 ms 전부의 FNV-1a + 조각 수)마다 기기 `localStorage`(`toeic-shadow-resume:v1`, 최근 30개 — `TOEIC_SHADOW_RESUME_MAX`)에 기억한다(try/catch — 없으면 처음부터). `onItem`마다 쓰고, 끝까지 들으면 지운다. 다시 시작은 **그 예문의 머리부터**다(검토 S4 — 멈춘 조각이 "영어 3/4"여도 그 예문의 한국어 조각부터, 틀 소개 중이었으면 그 틀의 첫 조각부터. 순수 함수 `shadowResumeIndex(script, index)`). 대본이 바뀌면(틀 교정·설정 변경) 이어 듣기를 끈다. `speakQueue`는 시작 위치를 받지 않으므로 대본을 그 번호부터 잘라 넘기고 번호에 오프셋을 더한다(§18-4 절대 인덱스 관용구).
- 전부 `speakQueue`를 **탭 핸들러 안에서 동기로** 부르고(준비를 거친 시작은 위 예외), 멈출 때는 큐가 돌려준 stop을 쓴다(`stopSpeaking` 금지). 정지 조건: 언마운트, 대본 내용 키 변경, 탭 전환, 테스트 시작.
- **Wake Lock**: 준비·재생 동안만 화면 꺼짐을 막는다(`useToeicWakeLock(phase === "preparing" || phase === "playing")`, best-effort — 틀 탭을 훑어보기만 할 때는 막지 않는다). 잠금·주머니 재생은 위의 무음 쉼·준비·Media Session이 받는다.
- **긴 범위 이어서 준비**(구현 반영 — 스펙 공백을 채운 선택): ▶ 때 준비는 90조각까지라 "여기부터 끝까지"·"유형 전체"(수백~수천 조각)는 다 받지 못한다. 그래서 재생 위치가 100조각(`ROLL_STEP`)을 지날 때마다 그 앞 조각을 같은 `prepareSpeech`로 이어서 받는다(백그라운드, 실패 무시, 멈추면 끊는다). 어차피 재생할 조각이라 비용이 같고, 잠금 화면에서 합성 요청이 늦어져도 이어지게 하려는 것이다.
- **프리페치**(준비와 별개): 범위가 정해지면(탭을 열 때의 기본 묶음 포함) 그 범위의 **영어 예문(고유 글자)**을 문서 순서로 `prefetchSpeech(texts, "en-US")`(상한 `PREFETCH_MAX_ITEMS` 90은 함수가 자른다 — 한 묶음은 대개 30개 안팎이다). 한국어·틀 소개는 ▶ 때의 준비가 받는다.
- 스트릭에 세지 않는다(듣기 — §12-9).

#### 12-5-3. 테스트 "🧩 틀 테스트" — (가) 예문 말하기 · (나) 틀 바꿔 말하기

경로 `/toeic/guides/[part]/templates/test?mode=recall|swap&scope=group|step|wrong|all&group={groupKo}&step={stepKo}` — 전면 화면(`components/toeic-template-test.tsx`), Wake Lock을 켠다. ② 탭 버튼과 이 화면 제목은 "🧩 틀 테스트"다 — ③ 표현 시험의 말하기와 이름으로 가른다(§12-6, 검토 S11).

- (구현 반영) 주소에 `mode`가 없거나 모르는 값이면 (가) 예문 말하기다. 입구 — 이어서 하기 카드·묶음 소제목의 "🧩 테스트"는 (가), "다 익혔어요 — 복습"은 (나)·유형 전체(익힘 = 틀 바꿔 말하기 졸업이라), 모드마다 "틀린 틀만 테스트"(그 모드의 틀린 틀이 있을 때). 시작 화면에 모드 전환 칩 둘이 있다(주소를 바꿔 서버가 다시 조립한다).
- (구현 반영) 문항은 서버 페이지(`app/toeic/guides/[part]/templates/test/page.tsx`)가 `buildTemplateTestQuestions`로 **한 번 조립**하고, 화면에는 문항 칸만 내린다 — 틀 객체·다른 예문·다른 `testFills`는 내리지 않는다(정답 채움이 페이로드로 새지 않게. ② 탭 페이로드에도 `testFills`가 없다). 화면 판단 순수 함수는 `lib/toeic-template-test-view.ts`다.

**문항 고르기 — 순수 함수** `buildTemplateTestQuestions(templates, sessions, opts)`(`lib/toeic-template.ts`):

- 입력: 범위의 틀(흐름 순서 — §12-5-1 `templateFlowOrder`), 틀 세션, `mode`, `onlyWrong`, `max`(`TOEIC_TEMPLATE_TEST_MAX` 10), `rng`.
- 후보 = 범위의 틀(`onlyWrong`이면 그 모드의 틀린 틀만 — §12-5-6). 그 모드 통계로 **약함 순위**를 매긴다 — 표현 시험의 `weaknessRank`를 **그대로** 쓴다(`lib/toeic-quiz.ts`에서 공개 — 검토 B3. 틀렸고 미졸업 → 안 해 봄 → 진행 중 → 졸업, 같은 순위는 오답 많은 순 → 무작위).
- **복습 칸**(검토 S9): `onlyWrong`이 아니면 한 판 10칸 중 최대 2칸(`TOEIC_TEMPLATE_TEST_REVIEW_SLOTS`)을 그 모드에서 **졸업한 틀 중 마지막 시도가 가장 오래된 것**에 먼저 준다(범위에 졸업한 틀이 있을 때만). 약함 순위만으로는 졸업한 틀이 다시 나오지 않는다. 나머지 칸은 약한 순.
- 고른 뒤 **흐름 순서로 다시 늘어놓는다**(답변을 짜는 순서대로 말해 보게).
- **한 판에 한 틀 한 문항.** 한 세션에 같은 틀이 두 번 나오면 한 판 안에서 "연속 2회 ○"가 되어 졸업이 거짓이 된다(§7-1 세트 안 중복 표현과 같은 함정).
- **예문·채움 고르기(결정적)**: 그 모드에서 그 틀의 시도 수 `t`(없으면 0), 예문 수 `n`, 테스트 전용 채움 수 `L`.
  - (가) 정답 예문 `a = t mod n`.
  - (나) 먼저 들려줄 예문 `m = t mod n`, 정답 채움 = `testFills[t mod L]`, 정답 문장 = `fillFrame(frameEn, 그 채움)` — 대본·카드에 없던 새 문장이다.
  - 판마다 다른 예문·채움이 차례로 나온다.
- 후보가 0개면 빈 상태("이 범위에 틀린 틀이 없어요" / "틀이 없어요").

**시작 탭**(검토 개선 7): 화면이 열리면 "시작" 버튼과 비용 안내 한 줄(아래)이 먼저 있다. 그 탭 안에서 `unlockSpeechPlayback()`·Wake Lock·첫 문항 소리를 시작한다 — 페이지가 열린 직후에는 소리 잠금을 푼 탭이 없어 iOS가 첫 소리를 막는다. 녹음 중 화면이 숨겨졌다 돌아오면 그 문항도 탭("이 문항 다시")으로 연다.

**한 문항의 흐름**(탭마다 한 걸음 — 소리는 그 탭 핸들러 안에서 시작한다):

- **(가) 예문 말하기**: 화면에는 정답 예문의 `ko`와, 그 아래 작은 글씨로 묶음 이름·`useKo` 한 줄이 있다(어느 틀을 묻는지 — 검토 S6). 틀과 영어는 가린다 — **묶음 이름·`useKo`에 든 라틴 글자도 "…"로 가린다**(구현 반영 — `templateTestPromptMeta`·`maskLatinForTestKo`. `useKo`는 zod가 한글 포함만 요구해 틀의 영어 고정 낱말을 담을 수 있다. 가리고 나서 글자가 남지 않으면 그 칸을 숨긴다). 한국어만 보고 외운 예문을 말한다 — 참고 자료의 테스트 방식 그대로다.
- **(나) 틀 바꿔 말하기**(검토 B2 — 틀 적용을 재게): **영어 글자는 하나도 보이지 않는다**(영어 틀도, 예문 m의 영어도).
  - 화면의 단서 = 한국어 틀 `frameKo`의 자리마다 이번 문항의 **영어 채움 칩**을 끼운 것(지어낸 예: `{활동}은 제가 {효과} 데 도움이 돼요` + 칩 "Keeping a diary"·"sleep better")과 묶음 이름·`useKo` 한 줄. 칩이 아닌 조각(한국어 틀의 고정 글·못 찾은 자리 이름)과 묶음 이름·`useKo`의 라틴은 "…"로 가린다(`templateSwapClue` — 화면의 영어 글자는 채움 칩뿐이다).
  - 문항을 여는 탭에서 예문 m의 영어를 **소리로만** 한 번 읽고, 🔊 다시 듣기를 둔다("같은 틀에 이 채움을 넣어 말해 보세요").
  - 아빠가 스스로 꺼내야 하는 것은 영어 고정 부분뿐이다 — 그래서 틀 정확도가 곧 "틀을 꺼냈나"를 잰다. 틀을 화면에서 읽거나 외운 예문을 되풀이해서는 맞힐 수 없다.
- **🎤 말하기** 탭 → **큐 멈춤 → `unlockSpeechPlayback()` → `startRecording()`** 순서로 부른다(검토 개선 7 — 0.1초 무음 재생과 캡처 시작이 겹치지 않게. 선례 `components/talk-start-view.tsx`). 녹음 규칙은 응시와 같다(`lib/mic-session.ts` — 재생과 캡처를 겹치지 않는다, 마이크 대기 상한 8초, 그 화면의 첫 녹음은 권한 창에 답할 시간 15초 `MIC_CHECK_GUM_TIMEOUT_MS`). **마이크 유지**(§6-4 전략 B, 2026-10-03)도 같다 — 첫 🎤에서 연 마이크를 테스트 끝·그만두기·화면 이탈·숨김까지 쥐고 🎤마다 녹음기만 새로 만든다. 마이크를 다시 열어야 할 때(첫 🎤, 놓은 뒤)만 15초 상한을 준다. 마이크 실패로 "녹음 없이"가 되면 놓는다.
- **"다 말했어요"** 탭 또는 20초(`TOEIC_TEMPLATE_REC_MAX_MS`)에 멈춘다 → 오디오 세션을 재생 쪽으로 돌린다(`setAudioSessionPlayback`) → `toWav16kMono`(실패하면 원본) → 전사 라우트(§12-5-4).
- **유효 시도**: 전사가 돌아왔고 전사문 낱말이 1개 이상(`words ≥ 1`)이며 비교할 낱말이 있으면(`!noSpeech` — `"..."`처럼 정규화 뒤 낱말이 남지 않는 전사는 `words`가 1이어도 무효) 유효하다(구현 반영 — `isValidTemplateAttempt(res, check)`). 유효하지 않으면(전사 실패·시간 초과·빈 전사·0.6초 미만 녹음) **정답을 공개하지 않은 채** "잘 안 들렸어요" + "🎤 다시 말하기"(문항당 전사 2회 상한 안) 또는 "받아쓰기 없이 판정".
- **결과(첫 유효 시도)**: 정답(원래 글자 — 틀 고정 부분 굵게·채움 색 밑줄), 내가 한 말(전사문), **비교**(§12-5-5 — 틀 고정 낱말은 맞음/빠짐/다름, 자리는 채움/비었음, 더한 말은 흐리게), 제안("틀 맞음 ○" / "틀 다름 ✕"), 🔊 정답(한 번 자동 재생 — 들어 보기), ▶ 내 녹음(이 기기 메모리에만 — 세션이 끝나면 버린다). 화면 배치는 정답 → 내가 한 말 → 제안 → ○/✕ → 비교 칩 → 내 녹음 → 🗣️ 한 번 더 순이고, 정답이 열리면 문제 카드를 줄이고 정답 상자로 스크롤한다(구현 반영 — 폰 390×844에서 ○/✕가 한 화면에 든다).
- **판정은 첫 유효 시도로 한다**(검토 B4). 정답을 공개한 뒤에는 "다시 말하기"가 없다. 대신 **"🗣️ 한 번 더 따라 말하기"** — 정답을 한 번 더 들려주고 따라 말할 틈을 준다(녹음·전사 없음, 제안·판정을 바꾸지 않는다, 비용 0). 정답을 들은 뒤의 말하기는 테스트가 아니라 따라 말하기다.
- **최종 ○/✕는 아빠가 정한다** — "○ 맞았어요" / "✕ 다시 연습". 제안과 달라도 된다. ✕면 그 틀에 ✕ 배지가 남고, 끝 화면의 "틀린 틀만 따라 말하기 / 틀린 틀만 다시 테스트"에 들어간다. **이 판정 탭이 다음 문항을 연다**(검토 S5 — 문항을 여는 탭을 따로 두지 않는다. (나)는 그 탭 안에서 다음 문항의 예문 소리를 시작하므로 iOS 탭 안 재생 규칙도 지켜진다). 마지막 문항이면 끝 화면으로 간다.
- **"받아쓰기 없이 판정"**: 전사를 기다리지 않고 정답을 공개 → 자동 재생 → ○/✕(제안 없음). 받아쓰는 동안에도 "기다리지 않고 판정하기"로 같은 길을 간다(구현 반영).
- **"녹음 없이 하기(스스로 판정)"**(구현 반영 — 스펙에 없던 선택): 시작 화면에서 고르면 그 세션은 처음부터 자기 판정이다(`getUserMedia` 0·전사 0 — 조용해야 하는 곳, 비용 0). 문항 모양은 아래 "녹음 없이"와 같다.
- **받아쓰기를 못 쓰면 자기 판정으로 넘어간다**(문항이 막히지 않게):
  - 마이크 거부·미지원·녹음 실패 → 그 세션은 "녹음 없이" — 말한 뒤 "정답 보기" → 정답 자동 재생 → ○/✕(표현 말하기 시험과 같은 모양).
  - 키 없음(501) → 그 세션은 전사를 끄고 자기 판정("받아쓰기를 쓸 수 없어 스스로 판정해요").
  - 상한에 닿음 → 그 뒤 문항은 자기 판정("받아쓰기 한도에 닿아 스스로 판정해요").
- 녹음 중(마이크 여는 중·녹음 마무리 중 포함) 화면이 숨겨지면 그 녹음은 버리고 그 문항을 처음부터 다시 한다(녹음이 잘렸다 — 응시의 "중단됨"과 같은 판단). 다시 여는 것은 탭("↻ 이 문항 다시")이다(위 시작 탭). 받아쓰기를 기다리는 중의 숨김은 요청을 그대로 둔다.
- **비용 표시**(검토 S12): 시작 화면과 테스트 머리에 "받아쓰기 n/20 · 이 판 최대 약 1센트"(`templateTestCostLabelKo`). 자기 판정으로 바뀌면 그 이유를 한 줄로 알린다(위 셋 중 하나). n은 **실제로 보낸 요청 수**다(구현 반영) — 0.6초 미만·1 MiB 초과·받지 않는 형식·WAV 변환 중 끊음(보내지 않았다)과 501(전사가 일어나지 않았다)은 세지 않고, 보낸 뒤의 실패·빈 전사·시간 초과·끊음은 센다.
- **목표 시간**(검토 S5): 한 문항 15~20초(말하기 3~6초 + 받아쓰기 2~5초 + 정답 3~5초 + 판정), 10문항 한 판 3~4분. 받아쓰기 대기는 실기기에서 p90 5초 이하를 기준으로 본다(SPEC §20-10). 말이 끝나면 저절로 멈추는 무음 감지는 두지 않는다(§12-12 22).
- **끝·그만두기** → 세션 저장(§12-5-6). 그만두면 판정한 문항만 `answered: true`, 나머지는 `null`이다. 끝 화면: ○ n / 전체, **제안과 다르게 판정한 문항 수**(첫 유효 시도의 제안 기준 — 제안 기준을 고칠 근거, §12-12 15), 틀린 틀 목록(카드로 가는 링크), "틀린 틀만 따라 말하기"·"틀린 틀만 다시 테스트"·"폴더로".

#### 12-5-4. 전사 라우트 — `POST /api/toeic/guides/templates/transcribe`

녹음을 글자로만 바꾼다. **저장하지 않는다.**

- 본문: multipart `audio` 하나. 정답·틀·표현은 보내지 않는다 — 서버는 무엇을 말해야 했는지 모른다. 기대 문장을 전사 `prompt`로 넣지 않는 원칙(§5-0 2 — 전사가 기대 문장 쪽으로 끌려가면 비교가 뜻을 잃는다)을 구조로 지킨다.
- 검사 순서: **키 먼저 501**(`hasToeicTranscribeApiKey` — 본문을 읽기 전에) → **413 먼저 한 번**(`content-length`가 `TOEIC_TEMPLATE_AUDIO_MAX_BYTES` + multipart 여유 16KiB를 넘으면 본문을 읽지 않고 413 — 검토 개선 8) → 400(multipart 아님·`audio` 없음·받지 않는 형식 — `isAcceptedToeicAudioType` 그대로·빈 파일) → 413(파일 크기 `TOEIC_TEMPLATE_AUDIO_MAX_BYTES` 1 MiB — 20초 16kHz mono WAV가 약 640KB, 원본 mp4는 더 작다) → 관문 T `transcribeAnswer({bytes, fileName, type}, req.signal)`(모델·`language:"en"`·30초 상한·재시도 1회 전부 그대로).
- **파일 이름·형식**(검토 개선 8): 화면은 채점 업로드와 같은 도우미로 보낸다 — `toeicAudioBaseType`·`toeicAudioFileName`(형식에 맞는 확장자 파일 이름). 라우트는 파일 타입이 비었거나 `application/octet-stream`이면 `toeicAudioTypeFromName`으로 채운다(모두 `lib/toeic-attempt-contract.ts`. 구현 반영 — 브라우저·undici는 타입 없는 Blob을 `application/octet-stream`으로 보내 "빈 타입" 갈래가 실제로는 타지 않았다. 채점 라우트 `…/score`는 이 규칙을 더하지 않았다 — 화면이 늘 타입을 붙여 보내 실사용 영향은 없다). `transcribeAnswer`는 확장자 붙은 `fileName`을 요구한다.
- 응답(단일 정의처 `lib/toeic-guide-contract.ts`): 200 `{ ok:true, text, words }` / 400 `invalid_input` / 413 `audio_too_large` / 501 `no_api_key` / 499 `client_closed` / 500 `transcribe_failed`(`retriable:true`). `words` = 전사문 낱말 수(`countWords(text)`) — 0이면 화면이 비교 없이 "잘 안 들렸어요"(유효하지 않은 시도)로 간다. `words`가 1 이상이어도 비교 결과가 `noSpeech`면 무효다(§12-5-3 유효 시도). 비교는 화면이 `text`로 한다.
- 스토어를 import하지 않는다(eval이 소스로 본다). 로그는 바이트·ms·낱말 수만 남긴다(전사문·오디오 없음 — `transcribeAnswer`의 규칙 그대로).
- **화면 쪽 시간 상한**(검토 개선 8): `transcribeAnswer`는 30초 × 재시도 1회라 최악이면 60초를 넘겨 Hosting이 요청을 끊는다. 화면은 요청마다 45초(`TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS`) `AbortController` 타임아웃을 두고, 넘으면 "잘 안 들렸어요"(유효하지 않은 시도)로 넘긴다.
- **비용 가드** — 이 라우트에는 세션 상태가 없다(가족 전용 PIN 게이트가 바깥 울타리다). 상한은 화면이 지킨다.
  - 한 번에 하나 — 전사 요청이 떠 있는 동안 "말하기"·"다시 말하기"를 잠근다(연타 방지).
  - 문항당 최대 2회(`TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION` — 처음 + 유효하지 않은 시도 뒤 다시 말하기 1회), 세션당 최대 20회(`TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION` = 10문항 × 2). 넘으면 그 뒤로는 자기 판정만 한다.
  - 0.6초(`TOEIC_TEMPLATE_REC_MIN_MS`) 미만의 녹음은 보내지 않는다("잘 안 들렸어요").
  - 상한 판정은 순수 함수 `canTranscribeAgain({ perQuestion, perSession })` 하나가 한다(버튼 잠금·"다시 말하기" 표시·자기 판정 전환·머리의 "받아쓰기 n/20"이 같은 함수를 본다).
  - 화면을 떠나거나 그만두면 `AbortController`로 끊는다 → 서버가 `req.signal`로 상류 전사를 멈춘다(499).
  - 전사 1회는 녹음 10초 안팎이다(분당 약 $0.003 — `gpt-4o-mini-transcribe`, SPEC §21-4와 같은 요율). 10문항 한 판(최대 20회)이 1센트 안팎이다.

#### 12-5-5. 비교 순수 함수 — 틀 고정 부분과 자리를 따로 (`lib/toeic-template.ts`)

**정규화** `normalizeTemplateWords(text)` → 낱말 배열 = 축약형 풀기 `expandContractions` → `normalizeReadWords`(§5-4 — 소문자·문장부호 제거·0~100 숫자 통일·`p.m.` 접기·아포스트로피 삭제).

- 축약형은 아포스트로피가 지워지기 **전에** 푼다(`it's`가 `its`가 되면 `it is`와 영영 어긋난다). 곧은·둥근 아포스트로피 둘 다.
  - `n't` → ` not`(`can't` → `can not`, `won't` → `will not`, `shan't` → `shall not`), 낱말 `cannot` → `can not`
  - `'m` → ` am`, `'re` → ` are`, `'ve` → ` have`, `'ll` → ` will`
  - **두 뜻 축약형은 대안 낱말 하나로 푼다**(검토 개선 5): 대명사·지시어·의문사(`it`·`that`·`there`·`here`·`what`·`who`·`where`·`he`·`she`·`how`·`when`·`why`) + `'s` → `is|has`, 그리고 `'d`는 **모든 낱말**에서 `would|had`(구현 반영 — `'d`에는 소유격 뜻이 없어 넓혀도 잃을 것이 없고, 대명사 목록으로 좁히면 틀 `I'd like …`가 전사 "I would like …"와 영영 어긋난다. `'s`는 소유격이 있어 목록으로 좁힌 채 소유격이 없는 `how`·`when`·`why`만 더했다). 대안 낱말은 둘 중 하나와 맞으면 같은 낱말이다(양쪽 모두 대안이면 겹치면 같다 — `sameTemplateWord(a, b)`). 그래서 완전형 틀 `It has been {…}`에 전사 "It's been …"도, 축약형 틀 `It's {…}`에 전사 "It is …"도 맞는다. 정답과 전사문을 같은 규칙으로 한쪽 뜻으로만 풀면 한쪽만 축약일 때 어긋난다(검토 — 고정 부분에 대명사 + `has`가 있는 틀 1개, `'s`·`'d` 축약형이 있는 틀 5개).
  - `let's` → `let us`
  - 명사 소유격 `'s`는 풀지 않는다(아포스트로피만 지워진다).
- 숫자는 `normalizeReadWords` 그대로다 — `twenty`·`20`, `twenty-five`·`25`, `seven thirty`·`7:30`이 같다. `$`는 떼어진다(`$15` → `15`). 100을 넘는 수(연도 등)는 낱말 그대로 남는다(알려진 한계 — 숫자는 대개 자리 안이라 너그럽게 본다).
- 정규식 lookbehind 금지(클라이언트 번들).

**정렬 코어** `alignWordSeq(expected, heard, eq?, { substitutionCost? })` — `lib/toeic-score.ts`의 `alignReadAloud` 안에 있는 편집거리·되짚기를 그대로 뽑아낸 순수 함수다. 선택 인자 `eq`는 낱말 같음 판정이다(기본 `===`). 틀 비교는 대안 낱말을 아는 `sameTemplateWord`와 **`{ substitutionCost: 2 }`**(치환 = 삭제 + 삽입 — 맞은 낱말 수를 최대화)를 넘긴다(구현 반영: 치환 비용 1로는 고정 낱말 둘의 어순이 바뀐 답이 "다름 2 → 0"으로 나와 아래 표 3행 "빠짐 1 + 더함 1 → 0.5"와 어긋난다. 표 1·2·4행과 7개 중 1 빠짐 ○ / 6개 중 1 ✕ 경계는 그대로다). `alignReadAloud`는 `eq`·옵션 없이 이 코어를 불러 **결과가 글자까지 같다**(기존 eval의 Q1–2 대조 항목이 그대로 통과해야 한다 — 같은 비용이면 일치·치환 → 삭제 → 삽입 순. eval이 옛 구현과 무작위 400쌍을 대조한다). 결과 = 기대 낱말마다 `{ status: "ok" | "missing" | "wrong", heard }`와 더한 낱말 `extra`(들은 위치).

**비교** `compareTemplateAnswer(frameEn, fills, transcript)` → `TemplateAnswerCheck`

1. 기대 낱말열: `frameEn`을 자리로 끊어, 고정 조각은 `normalizeTemplateWords`로 **고정 낱말**(role `fixed`)을, 자리 i는 `fills[i]`를 같은 함수로 **자리 낱말**(role `slot`, slot i)을 만든다. 자리 낱말에서는 관사 `a`·`an`·`the`를 뺀다 — 자리 안의 관사는 채점하지 않는다. 고정 부분의 관사는 그대로 본다.
2. 들은 낱말열: `normalizeTemplateWords(transcript)`.
3. `alignWordSeq(…, sameTemplateWord)`로 정렬한다.
4. **틀 정확도** `frameAccuracy` = 맞은 고정 낱말 ÷ 고정 낱말 수(zod가 1개 이상을 보장한다). 빠진·다른 고정 낱말 목록을 함께 준다. **이것이 핵심 지표다.**
5. **자리**(너그럽게): 자리마다 `filled`와 참고용 `matched / total`(자리 낱말 중 그대로 들은 수). `filled`는 그 자리 앞뒤의 맞은 고정 낱말 사이에 들은 낱말 중 **관사(`a`·`an`·`the`)가 아닌 낱말이 하나라도 있는가**다 — 뜻이 같은 다른 말로 채워도 채움이지만, 관사만 들린 자리(지어낸 예 "set on the.")는 비었다(검토 개선 9). 자리 바로 앞뒤 고정 낱말이 빠졌으면 경계는 가장 가까운 맞은 고정 낱말로 잡는다(없으면 문장 처음·끝). 자리가 붙어 있으면(`{가} {나}`) 두 자리가 같은 구간을 본다.
6. 더한 말(`extra`)은 표시만 하고 점수에 넣지 않는다("음…", 같은 말 되풀이).
7. 들은 낱말이 0개면 `noSpeech: true`.
8. **제안** `suggest` = `!noSpeech && frameAccuracy >= 0.85`(`TOEIC_TEMPLATE_SUGGEST_MIN`) `&& 모든 자리 filled`면 `"pass"`, 아니면 `"fail"`. 고정 낱말이 7개 미만이면 0.85는 "전부 맞음"과 같다 — 짧은 틀은 한 낱말만 빠져도 틀 다름이다(의도 — 원본 152틀 중 106개. 그래서 축약형 두 뜻을 대안으로 받는다). **제안일 뿐이다** — 전사는 발음이 서툴면 다른 낱말로 적히므로 최종 ○/✕는 아빠가 정한다(§12-5-3). 반대 방향의 오류도 있다(알려진 한계, 검토 S13): 전사 모델은 흔한 구절 쪽으로 매끄럽게 적는 경향이 있어, 흔한 틀일수록 한 낱말 틀리게 말한 것이 맞게 적힐 수 있다(○ 제안이 부푼다). 기대 문장을 보내지 않는 원칙으로는 막히지 않는다 — 실기기 확인에 "일부러 한 낱말 바꿔 말하기"를 둔다(SPEC §20-10).

**같은 뜻 교재 틀 대조**(검토 S6) `compareWithAlternatives(asked, alternatives, fills, transcript)` — (가) 예문 말하기에서만 쓴다.

- 대안 = 같은 유형 안에서 한국어 틀(`frameKo`, trim)이 **글자까지 같고** 자리 수가 같은 다른 틀(교재가 같은 뜻으로 가르친 어휘 대안 짝 — 원본 2쌍). 한국어만 보고는 어느 쪽을 묻는지 알 수 없다.
- 물은 틀과 대안마다 같은 채움으로 `compareTemplateAnswer`를 돌려 틀 정확도가 가장 높은 결과를 쓴다. 대안으로 맞으면 제안은 ○이고 "같은 뜻의 다른 교재 틀로 말했어요"와 그 틀 줄을 함께 보인다. 기록 키는 물은 틀이다.
- (나)는 예문 소리로 틀을 이미 들었으므로 대안 대조를 하지 않는다.

지어낸 예(틀 `{활동} helps me {효과}.`, 정답 "Gardening on weekends helps me clear my head."):

| 전사문 | 틀(고정 `helps me`) | 자리 | 제안 |
|---|---|---|---|
| "Gardening on weekends helps me to clear my mind." | 전부 맞음(`to`는 더한 말) | 둘 다 채움(자리 2는 `head` → `mind` 다름 — 참고 표시) | ○ |
| "Gardening on weekends make me clear my head." | `helps` 다름 → 0.5 | 채움 | ✕ |
| "Gardening on weekends me helps clear my head." | 어순이 바뀌어 한 낱말이 빠지고 하나가 더해짐 → 0.5 | 채움 | ✕ |
| "Gardening helps me the." | 전부 맞음 | 자리 2는 관사만 → 비었음 | ✕ |
| "" | — | — | ✕(안 들렸어요) |

- 축약형: 틀 `It's easy to {동작} after {때}.`에 전사 "It is easy to …" → 고정 낱말이 같다. 완전형 틀 `It has been {기간} since {때}.`에 전사 "It's been …" → 같다. 숫자: 채움 `twenty minutes`에 전사 "20 minutes" → 같다. 관사: 채움 `a short nap`에 전사 "short nap" → 자리 낱말 전부 맞음. 고정 부분의 `the`가 빠지면 → 다름.
- **화면 표시**: 정답 예문(원래 글자 — §12-5-1 표시)과 그 아래 비교 칩(정규화된 낱말 — 고정 낱말은 맞음/빠짐/다름 색, 자리 낱말은 자리 색, 더한 말은 회색). 정규화된 낱말(`20`·`it is`)을 원문 글자에 되짚어 칠하지 않는다(되짚는 대응이 결정적이지 않다).

**전사문에서 틀 찾기**(실전 적용 — §12-7-9) `findTemplatesInTranscript(transcript, templates)`

- 틀마다 고정 조각(자리로 끊은 구간)을 `normalizeTemplateWords`로 바꾸고 **두 낱말 이상인 조각만** 찾는다. 그런 조각이 모두 전사문 낱말열에 **이어서, 순서대로**(겹치지 않게, 앞 조각 뒤에 — 낱말 같음은 `sameTemplateWord`) 있으면 "쓴 틀"이다. 한 낱말 조각(`first`·`also` 같은 것)은 우연히 겹치므로 요구하지 않는다.
- 두 낱말 이상인 조각이 하나도 없는 틀은 매칭하지 않는다(원본 실측 4틀 — §12-2-7). 결과에 "찾을 수 없는 틀"로 따로 센다.
- 반환: `{ key, at }[]`(첫 조각 위치 순), 같은 틀은 한 번.
- `templateStepCoverage(part, foundKeys, bank)` → 그 유형 흐름의 **단계**마다 `{ stepKo, used: key[] }`(단계 안 묶음들의 틀 중 찾은 것). `used`가 빈 단계가 "이 답변에서 빠진 단계"다. **소재 묶음은 세지 않는다**(검토 B2 — 묶음 단위로 세면 60초 답변에도 빠진 것이 15개 안팎 뜬다. 단계는 3~6개라 답 하나가 지나갈 수 있다).

#### 12-5-6. 기록·숙련도 — 틀 단위

- **저장** `POST /api/toeic/guides/templates/sessions` — 본문 `{ clientSessionId, mode, startedAt, finishedAt, items: { word, correct, answered }[] }` → `toeicQuizzes`에 `setId: "guide-templates"`로 한 건. AI·키 검사·prod-guard 없음(생성이다).
  - 200 `{ ok:true, id, reused }` / 404 `bank_not_found`(틀 은행이 없거나 렌더 불가) / 500 `save_failed`. 계약은 `lib/toeic-guide-contract.ts`.
  - **400 `invalid_input`**(검토 B4 — 문서 id가 사용자 값에서 오므로 형식부터 막는다):
    - `clientSessionId`가 **소문자 UUID**가 아님 — `TOEIC_TEMPLATE_SESSION_ID_RE`(`lib/toeic-guide-contract.ts`, 자유대화 `TALK_SAVE_ID_RE`와 같은 모양). 문서 id가 `tpl-{clientSessionId}`라 `/`가 들어가면 Firestore `doc()`이 하위 경로를 가리킨다.
    - `startedAt`이 ISO datetime이 아님, `finishedAt`이 ISO datetime도 null도 아님(`z.string().datetime()` — 표현 시험 저장 라우트와 같다).
    - `mode`가 `tpl-recall`·`tpl-swap`이 아님, `word`가 `^tpl:[a-z0-9][a-z0-9-]{0,39}$` 아님, 세션 안 `word` 중복(한 판 한 틀), `items` 1~10 밖.
  - 틀 은행에 지금 없는 키도 받는다 — 교정하다 빠진 틀의 기록을 버리지 않는다(표현 시험 라우트도 키가 세트에 있는지 보지 않는다).
  - **멱등**: 문서 id = `tpl-{clientSessionId}`(화면이 세션을 시작할 때 만든 UUID). 스토어 `addToeicQuizWithId(id, input)`(판정은 순수 함수 `decideToeicQuizWithId(existing, input)` → `create`·`reuse`·`create_new_id`. 파일은 `mutate` 한 번 안에서, Firestore는 트랜잭션이 아니라 단일 문서 `ref.create()`(원자) — `ALREADY_EXISTS`면 읽어서 판정한다. 트랜잭션이 필요한 다른 읽기가 없어 자유대화 저장과 같은 모양으로 구현했다):
    - 같은 id가 없으면 만든다 → `reused:false`.
    - 있고 `mode`·`startedAt`이 같으면 새로 쓰지 않고 그 문서를 돌려준다 → `reused:true`("다시 저장"이 같은 판을 두 벌 쌓아 거짓 졸업을 만드는 경로를 막는다).
    - 있는데 `mode`나 `startedAt`이 다르면 **덮지 않고 자동 id로 새 문서를 쓴다** → `reused:false`(자유대화 저장 관용구 `lib/store-firestore.ts` — 키 충돌이 남의 기록을 지우지 않게).
  - 표현 시험 라우트는 바꾸지 않는다.
  - **화면 이탈 저장**(구현 반영 — 스펙 공백): 판정한 문항이 있는데 저장되지 않은 채 화면을 떠나면(언마운트·`pagehide`의 `persisted=false`) 같은 멱등 키로 keepalive 저장한다 — 진행 중이면 그만두기 모양(`finishedAt: null`), 끝 화면 저장이 실패한 채면 그 판 본문 그대로(`templateTestLeaveSave`, `lib/toeic-template-test-view.ts`). bfcache로 되살아날 수 있는 이탈(`persisted=true`)은 저장하지 않는다 — 되살아나 이어 풀면 같은 판이 `reused`로 버려져 뒤 결과를 잃는다. 판정 0이면 저장하지 않는다(끝·그만두기도 같다 — 표현 시험 러너 관용구). 저장 중에 전체 이동·탭 닫기가 겹치는 짧은 창은 건너뛸 수 있다(알려진 한계 — QA 이월 P3).
- **숙련도** `aggregateToeicTemplateStats(sessions)` → `Record<ToeicTemplateQuizMode, Record<string, WordStat>>`. 모드로 가른 뒤 **같은 날 잇단 ○를 접고** `aggregateWordStats`(은우 순수 함수)를 부른다. 세션을 `VocabQuizRecord` 모양으로 옮기는 것은 표현 시험의 어댑터를 **공개해 그대로** 쓴다 — 지금 `lib/toeic-quiz.ts`의 비공개 `toVocabQuizRecords`를 `toeicSessionsToVocabRecords`로 export한다(검토 B3 — 복사하면 두 벌이 된다). 세션은 `startedAt` 오름차순(§6-2 계약).
  - **두 모드는 따로 센다**(§6-2 모드 분리) — 예문을 기억해 말하는 힘과 틀을 새 채움에 쓰는 힘은 다르다. 졸업은 그 모드에서 연속 2회 ○다.
  - **같은 날 잇단 ○는 하나로 센다**(검토 S8). 한 틀의 시도를 시간순으로 걸을 때, ○ 바로 앞 시도도 ○이고 두 세션의 날짜(KST, `startedAt` 기준)가 같으면 뒤의 ○를 세지 않는다 — 그 항목을 뺀 세션 사본을 `aggregateWordStats`에 넘긴다(은우 함수는 바꾸지 않는다). ✕는 언제나 센다. 그래서 졸업에는 **서로 다른 날** 두 번의 ○가 필요하다 — "틀린 틀만 다시 테스트"를 연달아 해서 몇 분 만에 졸업하지 않게(단기 기억). 날짜는 스트릭과 같은 하루 기준 `kstDateString`(`lib/kst.ts` — 런타임 의존성 없는 순수 함수, SPEC §17-2)으로 가른다. 배지의 "오늘"은 화면이 같은 함수로 지금 시각에서 구한다.
  - 틀 은행이 하나라 **한 틀의 숙련도는 폴더와 상관없이 하나**다 — Q5–7 폴더에서 맞힌 공통 틀은 Q11 폴더에서도 맞힌 것으로 보인다.
  - **표현 시험과는 따로다.** 틀이 `guideRefs`로 가리키는 공략 표현의 통계(유형 공략 세트의 세션 — 키는 표현 문자열·`quiz:{no}`)와 틀 통계(틀 은행 세션 — 키는 `tpl:{key}`)는 서로 읽지 않는다. 화면이 둘을 나란히 보일 뿐이다(§12-5-7).
- **틀린 틀** `toeicTemplateWrongKeys(sessions, mode)` = 그 모드에서 틀린 적 있고 아직 졸업하지 않은 틀. "틀린 틀만 다시 테스트"는 그 모드의 목록을, "틀린 틀만 따라 말하기"는 두 모드의 합집합을 쓴다. 틀 카드의 ✕ 배지와 이 두 범위가 오답노트다 — 따로 오답노트 페이지를 두지 않는다.
- **배지**(모드마다): 안 해 봄(시도 0) · 진행 중(마지막이 ○, 연속 1) · **오늘 ○ — 내일 한 번 더**(마지막 시도가 오늘 ○이고 연속 1 — 같은 날 ○를 더해도 이 상태다) · ✕(마지막이 ✕) · 🎓(졸업).
- **최근 테스트**: 틀 탭 아래에 그 유형 틀이 든 세션 최신 10개(날짜·모드·○ n / 전체 — 전체는 세션 전체의 판정 문항 수다. 공통 틀은 여러 폴더에서 풀므로 세션을 쪼개지 않는다. 판정 0인 세션은 빼고, 그만둔 판은 "그만둠"을 붙인다 — `recentTemplateTests`). 이 목록은 말하기 두 모드만이다(이미 `TOEIC_TEMPLATE_QUIZ_MODES`로 거른다) — ③ 틀 시험 세션은 ③ 탭의 "최근 틀 시험"에 보인다(2026-10-02, §12-13-2).
- **폴더 카드**(§12-8): "틀 n · 익힘 m" — m은 그 유형 틀 중 **틀 바꿔 말하기**(`tpl-swap`)에서 졸업한 수다. 이 모드는 영어 글자 없이 대본에 없던 채움으로 말하므로 두 모드 중 더 어렵다(검토 B2 — 틀을 보여 주던 옛 설계에서는 이 말이 거꾸로였다). 틀 세션은 `setId`가 하나라 폴더 목록이 한 번 읽어 네 폴더에 나눠 쓴다. 같은 세션으로 "익힘" 옆에 **시험 응시 배지**(2026-10-03 — ② 틀 테스트·③ 틀 시험 중 그 유형 틀을 답한 마지막 판, `templateSessionsForPart` → `lib/test-status.ts`, SPEC §15-4)를 보인다.
- 스트릭: 테스트 세션은 `toeicQuizzes`라 지금 규칙(답한 문항 ≥ 1) 그대로 센다(§12-9).

#### 12-5-7. 교재 틀과 오가기 — 같은 틀임을 보인다

- 틀 카드의 "📘 교재 틀" 칩은 연결된 교재 쪽으로 간다. 연결이 하나면 바로, 여럿이면(`guideRefs` 최대 4) 칩을 눌러 연결마다 한 줄인 작은 목록에서 고른다. `expression` 연결이면 ③ 탭의 그 표현(`?tab=quiz&expr={표현}` — 표현 목록이 그 줄로 스크롤), `template`·`lead` 연결이면 ① 탭의 그 블록(섹션을 열고 스크롤). 다른 유형 공략의 연결이면 그 유형 폴더로 간다. **2026-10-02 바뀜**: ③의 표현 목록이 없어지므로 `expression` 연결은 ① 탭의 그 틀이 강조된 줄로 간다(`?tab=read&goto=k:{틀 key}` — 주소에 교재 글 대신 앱이 만든 틀 key가 실린다, §12-13-1). ① 본문에 그 표현과 같은 줄이 없으면 그 연결 줄은 목록에서 뺀다(갈 곳이 없다).
- 반대 방향은 🧩 칩이다 — ① 탭의 블록·줄(§12-4), ③ 탭의 표현 목록(§12-6). 판정은 순수 함수 하나 `templateLinksForGuide(bank, part)`가 한다(`guideRefs` 배열 전부).
- 표현 시험(뜻 ↔ 표현 5지선다·말하기)과 템플릿 훈련(틀 말하기)은 모드가 달라 숙련도가 따로다(§12-5-6). 대신 틀 카드에 연결된 표현의 표현 시험 상태를 함께 보이고("표현 시험: 뜻→표현 🎓 · 표현→뜻 ✕"), 표현 목록의 🧩 칩 옆에 그 틀의 테스트 상태를 보인다. **2026-10-02 대체**: ③이 틀 시험이 되어 표현 목록·표현 시험 상태가 화면에서 빠진다 — 틀 카드에는 그 틀의 ③ 틀 시험 배지가 붙는다(§12-13-2). 반대 방향 🧩 칩은 ① 탭만 남는다.
- **자리 표기 맞추기**: 틀은 이름 있는 자리 `{이름}`으로 저장하고 보인다(영어·한국어가 같은 이름 — 색으로 잇는다). 교재 쪽 표기 `~`는 **파생**이다 — `frameToExpression(frameEn)`이 자리마다 `~`로 바꾸고, 공백을 접고, 끝의 마침표 하나를 뗀다(지어낸 예: `The scene is set on {장소}.` → `The scene is set on ~`). 이 파생 글자는 세 곳에 쓴다 — ④ 한 문제 연습의 "활용할 표현"(§12-7-9), 호출 C·D가 돌려준 `usedExpressions`·`tryExpressions`를 틀로 되짚는 표(§12-7-9), ① 탭 줄 머리 🧩 칩 판정(§12-4). 한국어 틀은 파생하지 않는다. (2026-10-02) 첫째 쓰임은 **답변 흐름**의 틀 글자로 옮기고(§12-13-3), ③ 틀 시험의 보기·문제 글자(영어 틀 `~` 형태, 한국어 틀은 `koFrameToTilde` — §12-13-2)가 더해진다.

#### 12-5-8. 비용 — 템플릿 훈련

| 행동 | 드는 것 | 언제 |
|---|---|---|
| 틀 탭 보기 · 카드 🔊 | 클라우드 TTS(예문 en-US) — 고른 범위의 영어 최대 90개 자동 프리페치 | 탭 열기·범위 고르기 / 🔊 탭 |
| 따라 말하기 | TTS만 — ▶ 때 고른 범위의 고유 조각(영어·한국어) 최대 90개를 준비(`prepareSpeech` — 어차피 재생할 조각). 영어 N번 반복은 캐시, 무음 쉼은 합성 0 | ▶ 탭 |
| 테스트 | 문항당 전사 1회(유효하지 않은 시도 뒤 다시 말하기 1회까지 — 최대 2), 세션 최대 20회. 정답·예문 소리 en-US — 틀 바꿔 말하기의 정답은 대본에 없던 새 문장이라 문항마다 짧은 합성 1회 | 🎤 멈춤(문항마다 — 버튼 흐름 안) |
| 기록 저장 | 0 | 끝·그만두기 |

- 호출 A~D는 0이다. 키가 없으면 틀 탭·따라 말하기는 기기 음성으로(잠금 화면 연속 재생은 기대하지 않는다), 테스트는 자기 판정으로 전부 돈다.
- 화면의 비용 안내: 테스트 시작·머리 "받아쓰기 n/20 · 이 판 최대 약 1센트"(§12-5-3).

#### 12-5-9. 함수·상수가 사는 곳

| 곳 | 무엇 | 경계 |
|---|---|---|
| `lib/toeic-template.ts` | `fillFrame`·`frameToExpression`·`splitFrameForDisplay`·`splitExampleByFills`·`templateLinksForGuide`·`templateFlowOrder`·`leadMatchesFrame`, `buildTemplateShadowScript`·`estimateShadowMs`·`shadowResumeIndex`, `expandContractions`·`normalizeTemplateWords`·`sameTemplateWord`·`compareTemplateAnswer`·`compareWithAlternatives`, `findTemplatesInTranscript`·`templateStepCoverage`·`templateByExpression`, `buildTemplateTestQuestions`·`aggregateToeicTemplateStats`·`toeicTemplateWrongKeys`·`pickTemplatesForDrill`, 화면 상한 판정 `canTranscribeAgain({ perQuestion, perSession })`, 상수 `TOEIC_SHADOW_REPEAT_DEFAULT`(4)·`TOEIC_SHADOW_ESTIMATE`·`TOEIC_TEMPLATE_TEST_MAX`(10)·`TOEIC_TEMPLATE_TEST_REVIEW_SLOTS`(2)·`TOEIC_TEMPLATE_SUGGEST_MIN`(0.85)·`TOEIC_TEMPLATE_REC_MAX_MS`(20,000)·`TOEIC_TEMPLATE_REC_MIN_MS`(600)·`TOEIC_TEMPLATE_TRANSCRIBE_PER_QUESTION`(2)·`TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION`(20)·`TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS`(45,000)·`TOEIC_DRILL_TEMPLATES_MAX`(10)·`TOEIC_TEMPLATE_FLOW_CHECK_PARTS`·`TOEIC_TEMPLATE_SUGGESTIONS_MAX`(5), 그리고 `lib/toeic-guide.ts`의 `TOEIC_SHADOW_PAUSE`·`TOEIC_SHADOW_PAUSE_LEVELS`·`shadowPauseMs`를 **재수출**(구현 반영 — 정의는 `lib/toeic-guide.ts`. 그 값을 쓰는 `shadowPauseMs`가 거기 살고, `lib/toeic-guide`는 이 모듈을 import하지 않는다 — 순환 금지) | 클라이언트 안전(번들 경계 목록 — §12-10). 런타임 import는 `lib/toeic-guide`·`lib/toeic-text`·`lib/toeic-score`·`lib/toeic-quiz`·`lib/vocab-mastery`·`lib/kst`·`lib/tts-split`·`lib/tts-shared`뿐(`lib/toeic-quiz`는 검토 B3로, `lib/kst`는 같은 날 ○ 접기로 더했다 — 둘 다 클라이언트 안전 모듈이고 `lib/toeic-quiz`는 이미 번들 경계 목록에 있다). `lib/ai`는 `import type`만 |
| `lib/toeic-quiz.ts` | 새 export: `weaknessRank`(지금 비공개 — 그대로 공개), `toeicSessionsToVocabRecords`(지금 비공개 `toVocabQuizRecords`를 이 이름으로 공개), 틀 모드 `ToeicTemplateQuizMode`·`TOEIC_TEMPLATE_QUIZ_MODES`·`isToeicTemplateQuizMode`·`TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO`. `ToeicQuizSessionLike.mode`를 두 모드 유니온으로 넓힌다(§12-3 "모드 타입 넓히기") | 기존 경계 그대로(`lib/toeic-template`을 import하지 않는다 — 순환 금지) |
| `lib/toeic-guide.ts` | `shadowPauseMs`·`TOEIC_SHADOW_PAUSE`·`TOEIC_SHADOW_PAUSE_LEVELS`(0.8·1·1.5 — 정의처, 공략 읽기와 템플릿이 함께 쓴다), `cleanGuideKoForTts`(자리 `{…}` 포함), 유형 이름표·결정적 id(`TOEIC_GUIDE_PARTS`·`toeicGuideSetId`·`TOEIC_TEMPLATE_BANK_ID`) | 런타임 import에 `lib/toeic-text`(`countWords`)를 더한다(검토 개선 6). `lib/toeic-template`을 import하지 않는다(순환 금지) |
| `lib/toeic-score.ts` | `alignWordSeq(expected, heard, eq?, { substitutionCost? })`(추출 — `alignReadAloud`는 `eq`·옵션 없이 부르고 결과 불변, 틀 비교만 치환 비용 2) | 기존 경계 그대로 |
| `lib/ai/toeic/schemas.ts` | 가져오기 zod의 틀 은행 부분·`TOEIC_TEMPLATES_MAX`(300)·`TOEIC_TEMPLATE_EXAMPLES_MIN`(3)·`MAX`(5)·`TOEIC_TEMPLATE_TEST_FILLS_MIN`(1)·`MAX`(3)·`TOEIC_TEMPLATE_GUIDE_REFS_MAX`(4)·`TOEIC_TEMPLATE_FLOW_STEPS_MIN`(3)·`MAX`(6)·`TOEIC_TEMPLATE_GROUP_MAX`(6), 정렬 빠짐 검사 | 서버·eval(`leadMatchesFrame`·`normalizeTemplateWords`는 `lib/toeic-template`에서 값 import — `lib/ai` → `lib` 방향이라 경계 안) |
| `lib/ai/toeic/mock.ts` | `pickExpressionsForDrill`(틀 인자 추가 — `pickTemplatesForDrill`을 부른다) | 서버 전용 |
| `lib/toeic-guide-contract.ts` | 전사·기록 라우트 요청·응답 타입, `TOEIC_TEMPLATE_AUDIO_MAX_BYTES`(1 MiB — 화면이 올리기 전에 보고 라우트가 413으로 본다), `TOEIC_TEMPLATE_SESSION_ID_RE`(소문자 UUID) | 계약 파일(값은 자기 상수뿐 — `lib/ai`는 `import type`만) |
| `lib/speech.ts` | `SpeakQueueItem.pauseAfterMs`·`onPause`·`queueTiming.pauseMaxMs`, 무음 조각 쉼(`makeSilentWav(ms)`), `prepareSpeech`(`PrepareSpeechOptions`·`PrepareSpeechResult`), `getSpeechSpeedFactor(lang)`, 테스트 훅 `__speechPlaybackState()` | 공용(네 과목) |
| `lib/media-session.ts` | `bindMediaSession`·`setMediaSessionPlaybackState`·`isMediaSessionSupported`(§12-5-2) | 클라이언트, 런타임 import 0 — 따라 말하기 플레이어만 부른다 |
| `lib/toeic-guide-view.ts` · `lib/toeic-template-test-view.ts` · `lib/toeic-drill-view.ts` | 화면 판단 순수 함수 — 폴더 탭·범위 여섯·이어 듣기 서명·설정 파싱·goto(`guideReadInitialOpen`)·"뒤로"(`toeicSetBackLink`) / 테스트 주소·유효 시도·비용 문구·라틴 가림·이탈 저장·최근 테스트 / 연습 상태·폴더 카드·비용 캡션·단계마다 틀·틀 점검 자료·"뒤로"(`toeicMockBackLink`) | 클라이언트 안전(번들 경계 목록) |
| `lib/toeic-firestore-codec.ts` | `encodeToeicGuideForFirestore`·`decodeToeicGuideFromFirestore`·`hasNestedArray`(§12-3) | 순수, import 0 — Firestore 쓰기·읽기 헬퍼와 eval |
| `lib/ai/toeic/guide-import.ts` | `planToeicGuideImport`·`decideGuideUpsert`·`TOEIC_GUIDE_UPDATE_FIELDS`·내용 지문 함수(§12-2-5) | 서버 전용(`node:crypto`) |
| `components/use-toeic-shadow-settings.ts` · `components/toeic-template-lines.tsx` | 따라 말하기 설정 기기 기억(`toeic-shadow-settings:v1`) / 틀 줄·예문 줄 조각(② 탭과 테스트가 한 벌) | 클라이언트 |
| `lib/store.ts`·`lib/store-firestore.ts` | `upsertToeicGuides`(가져오기 — 원자 단위), `addToeicQuizWithId`(같은 판이면 reused, 다른 판이면 새 id — 판정 `decideToeicQuizWithId`), `listToeicDrills(mockPart)`(§12-8), `ToeicQuizRecord.mode` 넓히기, `ToeicSetRecord.guide`의 두 종류, `ToeicMockRecord.drillPart`·`ToeicAttemptRecord.questions` | `lib/toeic-normalize.ts`가 정규화 단일 정의처 |

### 12-6. ③ 표현 말하기 시험 — 기존 네 모드 중 셋

> **2026-10-02 대체 — 유형 폴더의 ③은 틀 시험이다(§12-13-2).** 이 절은 T8로 구현된 옛 동작의 기록이다. 폴더 화면에서 표현 목록·5지선다·"📝 교재 문장 말하기"·오답노트·기록 버튼을 빼고, 공략 세트의 시험 페이지 세 곳은 폴더 ③으로 보낸다. 저장된 공략 표현 시험 기록은 지우지 않는다(스트릭 과거·연습의 활용할 표현 순위가 그대로 읽는다). 이 절의 순수 옵션(`quizOrder:"weakness"`, 5지선다 `max`)은 쓰는 화면이 사라지지만 코드·eval은 그대로 둔다 — 표현집 기본 동작 불변을 잠그는 항목이다.

| 모드 | 공략 세트에서 | 출처 |
|---|---|---|
| `ko-to-expr` 뜻 → 표현 | **나온다** | `expressions` |
| `expr-to-ko` 표현 → 뜻 | **나온다** | `expressions` |
| `cloze` 빈칸 | 나오지 않는다(모드 고르기 화면에 0문항으로 비활성 — 기존 동작) | 발화 포인트(`points.exampleSpan`)가 없다 |
| `speak` 말하기 | **나온다** — 이 폴더의 주 시험 | `speak` → 세트 `quiz`(키 `quiz:{no}`) |

- 화면·저장은 기존 그대로다 — `/toeic/sets/{공략 세트 id}/quiz`(모드 고르기·5지선다·말하기 자기 채점), `…/wrong`(모드 탭), `…/history`, `POST /api/toeic/sets/[id]/quiz`(모드마다 1건), `toeicQuizzes`. 폴더의 "📝 표현 시험" 탭은 표현 목록(🔊)과 이 화면들로 가는 버튼을 보인다. 달라지는 것은 일곱 가지다 — "뒤로" 링크(§12-3 표), 말하기 문항 순서, 5지선다 한 판 상한, 공략용 안내 문구, 📝 탭의 프리페치(아래), 틀로 가는 🧩 칩(아래), 말하기 버튼 이름(아래).
- **말하기 버튼 이름**(검토 S11): 공략 세트의 말하기 모드는 버튼·화면 제목을 "📝 교재 문장 말하기"로 적는다(표현집 문구는 그대로). ② 탭의 "🧩 틀 테스트"(§12-5-3)와 둘 다 "한국어 보고 영어로 말하기"라 이름으로 가른다 — 여기는 교재 문장을 자기 채점하고, 틀 테스트는 새 예문·채움을 받아쓰기로 비교한다. 여기에도 받아쓰기 비교를 붙일지는 §12-12 21.
- **틀로 가는 🧩 칩**: 표현 목록에서 틀 은행의 어떤 틀이 `guideRefs`(`kind:"expression"`)로 가리키는 표현 옆에 "🧩 틀" 칩과 그 틀의 테스트 상태(§12-5-6 배지)를 둔다. 누르면 ② 탭의 그 틀로 간다. `?expr={표현}`으로 열리면 그 줄로 스크롤한다(틀 카드의 "📘 교재 틀" 칩이 여기로 온다 — §12-5-7). 판정은 `templateLinksForGuide`(§12-4) 하나다. 숙련도는 섞지 않는다 — 표현 시험은 표현 시험 세션만, 칩의 상태는 틀 세션만 읽는다.
- **📝 탭의 🔊·프리페치**: 탭을 열 때 표현 영어(`expressions[].expression`, 최대 60 — `PREFETCH_MAX_ITEMS` 90 안)를 `prefetchSpeech(…, "en-US")`로 미리 받는다. 표현집 상세와 같은 관용구다. 글자는 **trim만** 한다. 표현집 카드·시험 러너의 🔊와 캐시 키가 같아야 하므로 공략 읽기의 정리 함수(`cleanGuideEnForTts`)를 여기에는 쓰지 않는다(`~`도 표현집과 같이 그대로 둔다). 폴더를 여는 것만으로는 받지 않는다 — 탭을 열 때만.
- **말하기 문항 순서**: 지금 `buildToeicSpeakSession`은 교재 QUIZ를 **파일 순서대로** 앞에 놓고 10문항에서 자른다(교재 QUIZ는 세트당 2문항이라 문제가 없었다). 공략 `speak`는 수십 개라 이대로면 매번 앞 10개만 나온다. 그래서 옵션 `quizOrder: "book" | "weakness"`를 둔다 — 기본 `"book"`(표현집 동작·기존 eval 불변), 공략 세트는 `"weakness"`: QUIZ 항목도 **말하기 모드 통계만으로** 약함 순위(틀렸고 미졸업 → 안 해 봄 → 진행 중 → 졸업, 같은 순위는 오답 많은 순 → 무작위 — `weaknessRank` 그대로)를 매겨 앞에서 10개.
- **5지선다 한 판 상한**: `buildToeicChoiceQuestions`에는 상한이 없다. 공략 표현이 40개면 두 모드로 80문항이 한 판이 된다(폰에서 한 번에 풀기엔 길다). 그래서 옵션 `max`와 `sessions`를 둔다.
  - 기본은 상한 없음이다(표현집 동작·기존 eval 불변).
  - 공략 세트는 `max: TOEIC_GUIDE_CHOICE_SESSION_MAX`(20)이다. 모드 고르기 화면은 "시작 (n문항)"에 `min(선택한 모드 합, 20)`을 보이고, 모드별 칸에는 낼 수 있는 전체 수를 둔다(구현 반영). (항목, 모드) 문항마다 **그 모드의** 통계로 약함 순위(`weaknessRank` 그대로)를 매기고, 같은 순위는 오답 많은 순 → 무작위로 둔다. 앞에서 20개를 고른 뒤 한 번 섞는다.
  - 오답 재시험(`onlyKeys`)에도 같은 상한이 걸린다.
  - 한 판에 다 못 푼 표현은 다음 판에 약한 순으로 올라온다.
- **공략용 안내 문구**(시험 페이지가 `guide`를 보고 고른다). 지금 문구는 공략에서 막힌 길을 가리킨다 — 공략은 `…/points`가 409이고, 표현집 상세는 폴더로 리다이렉트된다.
  - 말하기 0문항: "공략 파일에 말하기 문항(speak)이 없어요. 파일에 넣어 다시 가져오세요" + 폴더로 가는 링크. 지금은 "표현집 화면에서 발화 포인트를 먼저 만들어 주세요" + "📒 표현집으로"다.
  - 빈칸 0문항 사유: "공략에는 빈칸 시험이 없어요". 지금은 "예문과 발화 포인트가 있어야".
  - `speak` 하한은 0 그대로 둔다(§12-2-3). 말하기 후보가 없는 유형도 가져올 수 있어야 한다.
- **공략 오답노트에는 빈칸 탭이 없다**(구현 반영 — 공략에는 빈칸 시험이 없어 늘 "안 봤어요"만 보이는 탭이 된다). 표현집 오답노트는 네 모드 그대로다.
- **숙련도·오답노트는 표현집과 자동으로 갈린다** — 시험 세션이 `setId`에 매달리고 집계가 세트 단위다(§6-2). 같은 표현이 표현집과 공략에 둘 다 있어도 통계가 섞이지 않는다. 모드별 분리(말하기가 뜻 모드를 오염시키지 않음)도 그대로다. 표현 문자열로 세트를 가로질러 모으는 곳은 활용할 표현 고르기(`pickExpressionsForMock`·`pickExpressionsForDrill`)뿐이다. 이 두 함수도 세션을 `setId`로 갈라 받는다 — 공략 세션은 공략 표현만, 표현집 세션은 표현집 표현만 매긴다(§12-3 표·§12-7-2).
- 발화 포인트(호출 B)는 공략 세트에 만들지 않는다(`…/points`가 409 `is_guide`). 만들면 빈칸 모드가 열리지만, 공략 표현은 `~` 자리가 있는 틀이라 B의 "교재 예문 속 구간" 규칙에 잘 맞지 않고, 다시 가져오기가 포인트를 지우지 않게 병합 규칙을 더해야 한다(§12-12 4).
- 문제를 소리로 읽지 않고 답한 뒤 en-US로 읽는다(§6-1 소리 규칙 그대로).

### 12-7. ④ 한 문제 연습

#### 12-7-1. 연습 단위 — 확정

순수 단위표 `TOEIC_DRILL_UNITS`(`lib/toeic-drill.ts` — 단일 정의, eval이 리터럴로 잠근다):

| 유형 | 모의고사 파트 | 응시 문항 | 만드는 것 | 근거 |
|---|---|---|---|---|
| `q3_4` | `picture` | **Q3 하나** | C2 1회 → 두 장면 중 **하나만**(무작위) 남김 + 사진 1장 | 사진은 서로 독립이라 한 장이 곧 "한 문제"다. 사진(관문 P)이 가장 비싼 단위라 반으로 준다. 실전 시간(준비 45·답변 30초)은 그대로 |
| `q5_7` | `respond` | Q5·Q6·Q7 | C3 1회 | Q5가 상황 소개를 읽고 Q6·Q7이 같은 주제를 이어받는다(§4-4) — 한 문항만 떼면 실전과 다른 문제가 된다 |
| `q8_10` | `info` | Q8·Q9·Q10 | C4 1회 | 표 읽기 45초가 Q8 앞에 한 번이고 세 질문이 같은 표를 쓴다(§6-4) — 표 하나에 질문 셋이 한 단위다 |
| `q11` | `opinion` | Q11 | C5 1회 | 원래 한 문항 |

- Q3–4를 사진 1장으로 하되 **C2 프롬프트는 바꾸지 않는다**(§4-3 "정확히 2개"는 spec-sync 대상). 두 장면을 받아 **하나만** 저장한다.
  - 고르는 장면은 `rng`로 정한다(`items[0]`·`items[1]` 중 하나). 늘 첫 장면만 쓰면, C2가 장소 목록 앞쪽에서 여는 버릇이 있을 경우 그 버릇이 연습마다 되풀이된다(검토 지적 — 실호출로 확인하지는 않았다. 무작위로 고르는 비용은 0이다).
  - 저장된 문서에는 그 장면이 `items[0]`이다(Q3 = slot 0).
  - 텍스트 호출이 장면 하나만큼 더 쓰지만 사진은 1장이다.
  - 나머지 장면은 저장하지 않으므로, 어떤 화면도 slot 1 사진을 자동으로 요청할 수 없다. 요청해도 기존 404가 막는다(§12-3).
- **함수가 사는 곳** — 클라이언트 번들 경계(`scripts/eval-toeic.ts`의 "번들 경계" 검사는 `/ai/`·`/store`·`openai`·`zod` 값 import를 금지한다) 때문에 셋으로 나눈다.
  - `lib/toeic-drill.ts`(클라이언트 안전, 번들 경계 목록에 등록). 런타임 import는 `lib/toeic-mock`뿐이고, `lib/ai`는 `import type`만 한다. 여기에 둔다:
    - `TOEIC_DRILL_UNITS`와 조회 함수(`toeicDrillUnit(part)`)
    - `toDrillRecordPart(mockPart, recordPart, rng)` — `toMockRecordPart`(서버, `lib/ai/toeic/mock.ts`)가 사진 칸을 `pending`으로 붙인 **레코드 파트**를 받아 사진이면 한 장면만 남긴다(`attachPendingImages`를 다시 쓰지 않는다 — 값 import를 피한다)
    - `nextToeicDrillTitle`, 주제 풀 `TOEIC_DRILL_TOPIC_POOL`·`pickDrillTopic`(§12-7-2)
  - `lib/toeic-mock.ts`: 지시문 변형 `toeicPartDirections`(§12-7-4). 템플릿·`COUNT_EN`·형식표가 이미 여기 있다.
  - `lib/ai/toeic/mock.ts`(**서버 전용**): `pickExpressionsForDrill`(§12-7-2). 재사용할 `pickExpressionsForMock`이 여기 있고, 이 모듈은 `./schemas`(zod)를 끌어온다. 연습 모듈에 두면 번들 경계 eval이 실패하거나 순위 규칙이 두 벌이 된다.
  - `lib/toeic-attempt-rules.ts`는 `decideAttemptScope`가 단위표를 쓰려고 `lib/toeic-drill`을 런타임 import한다. 머리 주석의 "런타임 import는 순수 모듈(lib/toeic-mock)뿐"을 "lib/toeic-mock·lib/toeic-drill뿐"으로 고치고, 이 파일도 번들 경계 목록에 등록한다.
- 응시 범위가 파트의 일부(Q3만)가 되므로 응시 기록에 `questions`를 둔다(§12-3). 연습의 범위는 **서버가 단위표에서 정한다** — 요청 본문(`{scope, parts}`)은 그대로이고, 클라이언트가 문항 부분집합을 고를 길은 없다.

#### 12-7-2. 만들기 — `POST /api/toeic/guides/[part]/drills`

- **키 검사를 맨 먼저**(501, §1-1 관용구). `[part]`가 `q3_4|q5_7|q8_10|q11`이 아니면 404 `part_not_found`. 본문 `{ targetGrade }`(IM3·IH·AL — 화면 기본 IH, 마지막 선택은 기기 `localStorage` `toeic-drill-grade:v1`에 기억).
- **주제 힌트 하나**: `pickDrillTopic(mockPart, 최근 연습들의 topicHints, rng)`(`lib/toeic-drill.ts`, 순수)가 주제 풀에서 하나를 무작위로 고른다.
  - 주제 풀 `TOEIC_DRILL_TOPIC_POOL[mockPart]`: 파트마다 8개 이상의 일상 주제 낱말(한국어 — 표현집 `topicKo`와 같은 모양). 이 앱이 정한 일반 낱말이다(교재 글이 아니다). 지어낸 예: picture "시장"·"기차역", respond "주말 취미", info "행사 일정", opinion "재택근무".
  - 그 유형 **최근 연습 3개**가 쓴 주제는 뺀다(다 빠지면 풀 전체에서 고른다).
  - 고른 주제는 `topicHints: [주제]`로 호출 C에 넘기고, 문서에도 그대로 저장한다.
  - 힌트는 기존 입력(§4-7 "주제 힌트")이라 프롬프트 변경은 0이다. C2는 "주제 힌트를 받으면 그와 어울리는 장소를 먼저 고른다"(§4-3).
  - 힌트가 없으면 temperature 0.8만으로 소재가 갈리는데, 연습을 거듭하면 같은 장소·주제가 되풀이되기 쉽다(검토 지적 — 실호출로 확인한 것은 아니다).
- **2026-10-02 바뀜(§12-13-3)** — 아래 "활용할 표현"의 **틀 앞자리는 없어진다**. 틀은 새 입력 **답변 흐름**(그 유형 단계마다 외울 틀 — 단계 안은 약한 틀 먼저)으로 넘기고, 활용할 표현은 **흐름 밖** 공략 표현(틀이 연결한 표현·같은 자리 다른 표현을 뺀 것) → 표현집 순서로 최대 24개다. 문서에는 보낸 흐름을 `answerFlows`로 저장한다. 아래 문장은 옛 동작 기록이다.
- **활용할 표현** `pickExpressionsForDrill(templates, guide, book, opts)`(**`lib/ai/toeic/mock.ts`**, 서버 전용 — §12-7-1):
  - 인자: `templates = {items: 그 유형 틀(틀 은행에서 parts로 고른 것) | [], sessions: 틀 세션}`, `guide = {set: 공략 세트 | null, sessions: 그 세트의 시험 세션}`, `book = {sets: 표현집 세트들, sessions: setId ∈ 표현집 세트인 세션}`. 세션을 `setId`로 갈라 넘긴다. 통계 키가 표현 문자열이라, 섞으면 공략 시험 기록이 같은 글자의 표현집 표현 순위를 움직인다(반대도 같다).
  - **틀을 맨 앞에** 둔다 — `pickTemplatesForDrill`(`lib/toeic-template.ts`, 순수)이 **단계마다 하나씩**(단계 순서, 그 단계 묶음들의 틀 중 틀 테스트 약함 순위가 가장 약한 것) 먼저 고르고, 남은 칸을 단계·소재 묶음을 통틀어 약한 순으로 채워 최대 10개(`TOEIC_DRILL_TEMPLATES_MAX`)를 고른다. 각 틀은 `frameToExpression`(§12-5-7)으로 `~` 형태가 되어 들어간다. 단계마다 하나씩 먼저 고르는 까닭은 모범답변이 답변 흐름의 단계를 고루 쓰게 하려는 것이다(단계는 3~6개라 10칸 안에 모두 든다 — 검토 B2: 묶음 단위로 고르면 묶음이 15~20개인 유형에서 흐름 앞쪽만 들어갔다). 자세한 것은 §12-7-9.
  - 그다음은 규칙을 새로 쓰지 않는다. **`pickExpressionsForMock`을 두 번** 부른다 — 공략 세트 하나로 한 번(그 유형 공략 표현, 숙련도 낮은 것 우선), 표현집 세트들로 한 번(나머지 칸).
  - 틀 → 공략 → 표현집 순으로 두고 대소문자 무시로 중복을 접어(교재 틀을 옮긴 틀의 `~` 형태는 흔히 그 공략 표현과 같은 글자다 — 한 번만 남는다) 최대 24개(`TOEIC_MOCK_EXPRESSIONS_MAX`)로 자른다.
  - 이 목록을 `normalizeMockExpressions`로 정리해 호출 C에 넘기고, **같은 목록을** `expressionsUsed`로 저장한다(보낸 목록 = 저장 목록 — 호출 D의 `tryExpressions`가 여기서 고른다, §5-1).
  - 틀 은행·공략이 아직 없으면 있는 것만, 셋 다 없으면 "없음"이다.
  - 공략 표현과 틀의 `~` 형태는 `~` 자리를 남긴 틀이고 `/`·`{}`가 없다(§12-2-1·§12-2-3·§12-2-7). 그래서 `" / "`로 이은 목록 경계와 `cleanUsedExpressions`의 대조가 그대로 맞는다.
- 호출: `generateMockPart(mockPart, { targetGrade, topicHints: [주제], expressions })`(`lib/ai/toeic/calls.ts` — 프롬프트·스키마·zod·호출 옵션 전부 §4 그대로) → `toMockRecordPart` → `toDrillRecordPart(mockPart, recordPart, rng)` → `createToeicMock({ drillPart, parts: {그 파트만}, topicHints, expressionsUsed, titleKo, … })`.
- 제목: `nextToeicDrillTitle(mockPart, 같은 유형 연습 제목들)` → "{유형 짧은 이름} 연습 {n}"(유형 짧은 이름 = `TOEIC_MOCK_PART_NAME_KO` — 예 "사진 묘사 연습 3"). 번호 규칙은 `nextToeicMockTitle`과 같은 관용구이고, 연습끼리·유형별로 센다.
- 응답(`lib/toeic-guide-contract.ts`): 200 `{ ok:true, id, titleKo, mockPart, expressionsCount }` / 404 / 400 `invalid_input` / 501 `no_api_key` / 500 `ai_failed`(`retriable:true`, 저장 안 함 — 파트가 하나라 부분 성공이 없다) / 500 `save_failed`.
- 요청이 도중에 끊기면(60초 상한) 서버는 저장까지 마칠 수 있다 — 화면은 목록을 다시 읽어 누른 뒤 생긴 연습이 있으면 그것을 쓰고 "서버에서 만들어졌을 수 있어요"를 알린다(버튼 이름 "그래도 새로 만들기" — SPEC §20-3 관용구).
- **버튼 옆 비용 캡션**: "새 문제 만들기" 옆에 "AI 문제 만들기 1회 — 폴더를 보거나 공략을 듣는 건 AI 0"을 적고, **Q3–4 폴더에서만** "1회(사진 1장 포함)"으로 적는다(구현 반영 — 폴더 안에서 "Q3–4는"이 어색해 폴더마다 맞게 줄였다. `toeicDrillCostCaptionKo(part)`, `lib/toeic-drill-view.ts`). 그 유형에 **응시 전 연습**이 있으면 버튼 위에 "응시 전 연습 n개 — 먼저 풀어 보세요"와 가장 최근 것으로 가는 링크를 보인다(새로 만들기를 막지는 않는다).

#### 12-7-3. 사진 (Q3–4만)

- 만들기가 성공하면 **같은 버튼 흐름 안에서** `POST /api/toeic/mocks/[id]/image {slot:0}` 한 번을 부르고 기다린다(관문 P §4-10 그대로 — 압축 재시도·먼저 준비된 사진이 이긴다·끊겨도 서버가 끝까지 저장·실패를 받으면 한 번 다시 읽어 확인). 화면을 다시 열었는데 아직 `pending`이면 **자동으로 부르지 않고** "사진 만들기" 버튼을 보인다(비용이 드는 요청은 명시적 흐름으로만). 그 옆에 "사진 없이 시작"도 둔다(구현 반영 — 키가 없거나 비용을 쓰지 않으려는 경우. 실패 때와 같은 버튼이다).
- 실패하면 "사진 다시 만들기" / "사진 없이 시작"(응시 화면이 장면 설명 `sceneKo`를 대신 보인다 — 기존 동작).
- 준비 중에도 사진을 보여 주지 않는다 — 응시 화면의 준비 45초보다 먼저 사진을 보면 실전이 아니다. 상태("사진 준비 중 / 준비됨 / 실패")만 보인다.

#### 12-7-4. 응시 — 기존 응시 화면 그대로

- 경로는 기존 `/toeic/mocks/[id]/take?scope=part&part={mockPart}`. 시작 라우트(`POST …/attempts`)와 응시 페이지가 같은 판정을 쓴다 — `decideAttemptScope(scope, parts, mock.parts, mock.drillPart)`가 `{ok, parts, questions}`를 돌려준다. 연습이면 `scope`는 `"part"`, `parts`는 `[drillPart]`여야 하고(아니면 판정 사유 `scope_parts_mismatch` → 400 `invalid_input`, 기존 관용구), `questions`는 단위표에서 온다. 모의고사는 지금과 같다(`questions = toeicAttemptQuestions(parts)`).
- `attempt.questions`를 읽는 자리로 바꾼다 — 지금 `toeicAttemptQuestions(attempt.parts)`를 부르는 다섯 곳(응시 페이지·결과 페이지·시작 라우트 응답·끝내기 라우트의 범위 검사와 `completeFinishAnswers`·채점 라우트의 문항 범위). **라우트가 바꾸는 것은 범위의 원천(`attempt.parts` → `attempt.questions`)뿐이고 상태코드·오류 이름은 기존 계약 그대로다.** 그래서 사진 연습(`questions = [3]`)에서는:
  - 끝내기는 Q3만 채운다. 끝내기 본문에 Q4가 있으면 **400 `invalid_input`**(`answers.{i}.q` — "이 응시 범위에 없는 문항", 기존 관용구)이다.
  - Q4 **채점** 요청은 **404 `question_not_found`**(`lib/toeic-attempt-contract.ts`의 채점 오류 유니온 — 기존 계약)이다.
  - 400으로 바꾸지 않는다. 결과 화면의 채점 오류 분기와 기존 eval이 404를 전제한다.
- 형식표(§6-4)는 그대로다 — 준비·답변 시간, Q8 앞 표 읽기 45초, Q10 두 번 재생, 질문 음성·무음 안전망·녹음 규칙·마이크 상한까지 실전과 같다.
- **지시문 변형 하나**: 지시문은 파트 첫 문항에서 읽고 숫자는 형식표에서 계산한다(§6-4). 사진 1장 응시에서 "사진 2장이 한 장씩 나와요"를 읽으면 틀리므로 순수 함수 `toeicPartDirections(part, count)`를 둔다 — `count`가 그 파트 문항 수와 같으면 `TOEIC_PART_DIRECTIONS[part]`와 **글자까지 같고**, `picture`의 `count = 1`이면 한 장짜리 문장(형식표에서 계산 — en "Describing a picture. One photo will appear. Study it for {prep} seconds, then talk about it for {answer} seconds." / ko "사진 묘사. 사진 1장이 나와요. {prep}초 동안 살펴본 뒤, {answer}초 동안 묘사하세요."). 이 앱의 문장이다(ETS 원문 아님).
  - 함수는 `lib/toeic-mock.ts`에 둔다(템플릿·`COUNT_EN`·형식표가 이미 거기 있다). `count`가 파트 문항 수와 같으면 `TOEIC_PART_DIRECTIONS[part]`를 **그대로** 돌려준다.
  - 응시 화면(`components/toeic-take-view.tsx`)은 `TOEIC_PART_DIRECTIONS[part]`를 쓰는 **세 곳을 모두** 이 함수로 바꾼다 — 지시문 읽기, 지시문 프리페치, 화면 글. 셋이 같은 글자여야 프리페치 캐시가 맞는다(하나만 바꾸면 사진 한 장 연습에서 "사진 2장"이 화면이나 소리 한쪽에 남는다).
- **응시 범위 라벨**: 연습이면 `toeicScopeLabelKo` 대신 `toeicDrillScopeLabelKo(part, questions)`를 쓴다(`lib/toeic-attempt-contract.ts`, 순수).
  - 결과는 "공략 연습 · {toeicMockPartLabelKo}"이고, 문항이 파트의 일부면 " · Q3"처럼 문항을 덧붙인다.
  - 기존 라벨 "유형 연습 · Q3–4 사진 묘사"는 두 문항을 푸는 것처럼 읽혀 쓰지 않는다.
  - 응시 페이지·결과 페이지가 문서의 `drillPart`로 고른다.
- 연습에 `scope:"full"`이나 다른 파트를 보내면 400 `invalid_input`이다. 문구는 "공략 연습은 그 유형 하나로만 응시해요." — 기존 "실전 응시는 다섯 파트를…" 문구를 연습에 내지 않는다.

#### 12-7-5. 채점·결과 — 기존 그대로

- 결과 화면 `/toeic/attempts/[id]`와 "AI 채점 받기" 버튼(문항마다 관문 T 1회 + 호출 D 1회, 동시 2)을 그대로 쓴다. **자동 채점하지 않는다**(§0-2 비용 원칙 — 연습이 끝나면 결과 화면이 곧바로 열리고 버튼이 맨 위에 있다).
- `buildFeedbackInput`은 `attempt.mockId → 연습 문서`로 그대로 돈다(`picture.items[0]`이 Q3). 추정 총점은 11문항이 모두 있을 때만이라 연습에는 나오지 않고, 결과 화면의 "유형 연습은 문항 점수만" 안내가 그대로 뜬다.
- 결과 화면의 "뒤로"는 그 유형 폴더(`?tab=drill`)다. 끝 버튼 줄은 연습이면 "같은 문제 다시"(같은 연습 응시 — 기존 "↻ 다시 응시")와 "새 문제"(폴더의 만들기로) 두 개이고, **"학습 보기로"는 숨긴다**. 학습 보기는 연습이면 무조건 폴더로 보내므로(§12-3), 버튼을 두면 폴더로 튄다.
- **응시 뒤 복습 자료를 결과 화면에 보인다**(검토 반영 — 선택지 (나), §12-0). 모범답변 접기(`<details>` "모범답변(참고용) 보기") 안의 `tipKo` 아래에 둘을 더한다.
  - Q3–4는 **묘사 포인트** `keyPointsKo`(목록).
  - Q11은 **답변 뼈대** `outlineKo`(번호 목록).
  - 두 필드는 이미 문항 화면 자료 `ToeicQuestionView`(`buildToeicQuestionView`)에 실려 있다. 데이터 경로는 새로 없고 화면만 그린다.
  - 규칙은 하나다 — "비어 있지 않으면 보인다". 그래서 실전 모의고사의 결과 화면에도 똑같이 보인다(무해한 추가 — 학습 보기에 이미 있는 자료다).
  - 교재 공략(묘사 순서·의견 답변 틀)과 짝을 이루는 자료라, 응시가 끝난 뒤 공략 읽기로 돌아가기 전에 여기서 확인한다.
- 문항별 채점 버튼(묶음 3문항 중 하나만 채점)은 이번에 두지 않는다. 결과 화면은 실전과 공용이고, 실패한 문항의 "↻ 다시 채점"은 이미 문항별이다 — §12-12 7.
- 연습이면 문항마다 **"🧩 틀 점검"**을 더 보인다(§12-7-9 — AI 없음).

#### 12-7-6. 녹음 보관 — 연습이 실전 녹음을 밀어내지 않게

`lib/toeic-rec-store.ts`는 지금 **전체 최근 응시 5회분**만 남긴다(`pickAttemptsToEvict`는 종류를 모른다). 실전 응시 뒤 채점 전에 연습을 다섯 번 하면 실전 녹음이 기기에서 지워지고, 그 응시는 영영 채점할 수 없다. 그래서 녹음 메타에 `pool: "mock" | "drill"`(옛 메타는 `"mock"` — `toeicRecPoolOf`)을 두고 **풀마다 따로** 최근 5회분(`TOEIC_REC_KEEP_ATTEMPTS`, 같은 값)을 남긴다 — 같은 `pickAttemptsToEvict`를 풀별로 거른 목록에 부른다(`pickAttemptsToEvictByPool`). 응시 화면은 문서의 `drillPart`로 풀을 안다. IndexedDB 버전·store 이름은 그대로다(업그레이드 없음).

#### 12-7-7. 새 프롬프트 — 없다

> **2026-10-02 뒤집힘**(사용자 확정 — "가능한 템플릿 기반으로 답변"): 새 호출은 여전히 없지만 **원문 셋이 바뀌고 하나가 더해진다** — §4-1 둘째 블록 `TOEIC_MOCK_FLOW_RULES`(새 원문 — 흐름을 받은 파트만 과제 절 뒤에 붙는다. 검토 반영으로 머리말 안에서 떼어 냈다), §4-7 사용자 메시지 형식(`답변 흐름:` 줄), §5-1 D 시스템 프롬프트(흐름 입력·틀로 고치기·필요 없는 단계 건너뛰기), §5-2 D 사용자 메시지 형식(`답변 흐름:` 줄). §4-1 머리말·과제 절 다섯·관문 P 접미사·JSON Schema 8개·호출 옵션은 그대로다. 바꾼 까닭과 범위는 §12-13-3. 아래 문단은 옛 결정의 기록이다.

호출 C(머리말 + 파트 과제 5)·D·관문 P 접미사·JSON Schema 8개를 한 글자도 바꾸지 않는다. spec-sync 대상(원문 14 + JSON 8 + 호출 옵션 문장)도 그대로다. 연습에서 달라지는 것은 입력(활용할 표현 목록의 내용·순서 — 틀의 `~` 형태가 앞에 온다, 주제 힌트 하나)과 후처리(두 장면 중 하나만)뿐이고, 공략 본문과 틀 예문은 프롬프트에 들어가지 않는다(§12-2-6). 템플릿 훈련(§12-5)도 새 프롬프트가 없다 — 전사는 관문 T 그대로다.

#### 12-7-8. 비용 — 연습 한 번

| 유형 | 만들기(버튼) | 사진(버튼 흐름 안) | 채점(버튼) | 발음 |
|---|---|---|---|---|
| Q3–4 | 호출 C 1회(재요청 시 2) | 관문 P **1장**(크기 초과면 한 번 더 압축해 1장 더) | T 1 + D 1 | 지시문·결과 모범답변/개선 답변 en-US |
| Q5–7 | 호출 C 1회(≤2) | 0 | T 3 + D 3(재요청 시 D 최대 6) | 지시문·소개·질문 3 + 결과 |
| Q8–10 | 호출 C 1회(≤2) | 0 | T 3 + D 3(≤6) | 지시문·도입·질문 3(Q10 두 번 재생은 캐시) + 결과 |
| Q11 | 호출 C 1회(≤2) | 0 | T 1 + D 1(≤2) | 지시문·질문 + 결과 |

- 폴더를 열거나 목록을 보는 것만으로는 AI가 돌지 않는다. 무응답(전사 2단어 미만)은 호출 D 없이 0점(§5-0). 이미 채점된 문항은 0.
- 틀을 잇는 것(§12-7-9)은 비용을 늘리지 않는다 — "활용할 표현" 목록의 내용만 바뀌고(24개 상한 그대로), 틀 점검은 이미 만든 전사문·저장된 출력만 쓴다. (2026-10-02) 답변 흐름도 호출 수를 바꾸지 않는다 — 호출 C·D의 입력이 흐름 한 블록만큼 길어진다(§12-13-4).

#### 12-7-9. 실전 적용 — 틀을 연습에 잇는다

외운 틀을 처음 보는 문제에 꺼내 쓰는 연습이다(참고 자료가 권한 세 번째 단계). 새 AI 호출·새 프롬프트 없이 **기존 입력 경로**로 잇는다.

> **2026-10-02 대체(§12-13-3)** — 입력 경로가 "활용할 표현" 칸에서 새 **답변 흐름** 칸으로 옮겨 가고(호출 C·D 원문 셋이 바뀌고 흐름 규칙 블록 하나가 더해진다), 모범답변은 흐름의 단계마다 틀로 조립한다. 실전 모의고사도 같은 입력을 받는다. "🧩 틀 점검"은 모의고사 결과에도 붙고(문항마다 접기), 준비 화면 접기는 단계마다 첫 틀 하나 + "+n"(펼치면 **그 단계의 틀 전부** — 모범답변이 고르는 목록과 같은 것)이다. "쓸 수 있었던 틀"은 **빠진 단계 → 피드백 → 모범답변** 순으로 바뀐다(검토 반영 — 모범답변이 틀로 조립되면 옛 순서로는 모범답변 틀이 다섯 칸을 채워 빠진 단계가 잘린다). 아래 문장 중 "기존 입력 경로"·"연습 문서일 때만"·"단계마다 틀 하나"·"쓸 수 있었던 틀"의 순서는 옛 동작 기록이다.

- **입력 경로 — 코드로 확인한 것**: 호출 C 사용자 메시지의 "활용할 표현" 칸(§4-7 — `buildMockUserMessage`가 `normalizeMockExpressions`로 정리해 `" / "`로 잇는다), 호출 C 머리말의 "활용할 표현 목록을 받으면 모범답변에 자연스럽게 어울리는 것만 쓰고 `usedExpressions`에 원래 표현과 실제 구간으로 적는다"(§4-1), 호출 D의 `tryExpressions`(받은 목록 중 0~3개 — §5-1), 후처리 `cleanUsedExpressions`·`postprocessFeedback`(목록 밖은 버린다, 대소문자 무시 대조). 틀을 `~` 형태로 이 목록에 넣으면 C·D의 프롬프트·스키마·zod를 바꾸지 않고도 **모범답변이 틀을 쓰고**, 피드백이 **넣었으면 좋았을 틀**을 짚는다. 그래서 입력 칸을 새로 만들지 않는다.
- **고르기** `pickTemplatesForDrill(items, sessions, opts)`(`lib/toeic-template.ts`, 순수 — `pickExpressionsForDrill`이 부른다, §12-7-2)
  - 대상: 그 유형 틀(`parts`에 그 유형이 든 것).
  - 약함은 두 테스트 모드를 합쳐 본다 — 어느 모드든 틀렸고 미졸업 → 둘 다 안 해 봄 → 진행 중 → 두 모드 다 졸업. 같은 순위는 오답 많은 순 → 무작위(`rng`).
  - **단계마다** 가장 약한 틀 하나를 단계 순서로 먼저 고르고(그 단계의 묶음들 안에서), 남은 칸을 단계·소재 묶음을 통틀어 약한 순으로 채워 최대 10개(`TOEIC_DRILL_TEMPLATES_MAX`)를 고른다. 연습 문제의 주제 힌트(`pickDrillTopic`)에 맞는 소재 묶음을 따로 고르지는 않는다 — 주제 풀은 코드 상수이고 소재 묶음은 원본이라 둘을 잇는 표를 두면 두 곳이 어긋난다. 약한 순 채우기가 소재 묶음의 틀도 올린다(§12-12 20).
  - `frameToExpression`으로 바꾼 글자가 목록에 들어가고, 그 목록이 그대로 `expressionsUsed`에 저장된다(보낸 목록 = 저장 목록 — 채점 때 D가 같은 목록을 받는다).
- **결과 화면의 "🧩 틀 점검"** — 연습 문서일 때만, 문항마다(결과 화면은 실전과 공용이라 `drillPart`로 가른다). AI를 부르지 않는다 — 채점 때 이미 만든 전사문과 저장된 C·D 출력만 쓴다. 결과 페이지(서버)가 연습이면 틀 은행을 읽어 그 유형 틀을 넘긴다(클라이언트에는 타입만).
  - **내 답에서 쓴 틀**: `findTemplatesInTranscript(그 문항 전사문, 그 유형 틀)`(§12-5-5) — 틀 줄(자리 칩)과 단계·묶음 이름.
  - **빠진 단계**(Q3–4·Q11만 — `TOEIC_TEMPLATE_FLOW_CHECK_PARTS`): `templateStepCoverage`에서 쓴 틀이 없는 **단계**(소재 묶음은 세지 않는다). 한 답이 흐름 전체를 지나야 하는 유형만 보인다 — Q5–7·Q8–10은 질문마다 짧게 답해 흐름 전부를 요구하지 않는다. 원본 흐름으로 Q3–4는 단계 4개, Q11은 5개라, 60초 답이 흐름을 따랐다면 빠진 단계는 0~1개다.
  - **쓸 수 있었던 틀**(합쳐 최대 5개, 겹치지 않게 이 순서로): ① 모범답변이 쓴 틀 — 문항의 `usedExpressions`를 틀로 되짚은 것 중 내가 안 쓴 것 ② AI 피드백의 `tryExpressions` 중 틀로 되짚히는 것 ③ (Q3–4·Q11) 빠진 단계마다 그 단계의 가장 약한 틀 하나.
  - 되짚는 표 `templateByExpression(items)`: `matchKey(frameToExpression(frameEn))` → 틀 `key`(zod가 은행 안 유일을 보장한다), 그리고 `guideRefs`의 공략 표현마다 그 표현의 `matchKey` → 틀 `key`(교재 표현 글자와 `~` 형태가 다를 때. 여러 틀이 같은 표현을 가리키면 파일 순서로 첫 틀).
  - 보이는 틀마다 "이 틀 연습하기" → ② 탭의 그 카드(`?tab=templates&tpl={key}`).
  - 채점 전(전사문 없음)에는 ①만 보인다("모범답변이 쓴 틀"). 무응답(전사 2낱말 미만 — 0점 처리된 문항)도 전사문이 있는 것으로 본다 — 쓴 틀 0, (Q3–4·Q11) 빠진 단계 전부.
  - 결과 페이지가 넘기는 틀 자료(`toeicDrillCheckData`)에서 예문·`testFills`를 뺀다 — 틀 점검은 틀 줄만 쓰고, 틀 바꿔 말하기의 정답 채움이 다른 화면 소스에 실리지 않게(구현 반영).
  - 전사문 매칭의 한계: 한 낱말 조각뿐인 틀은 찾지 않고, 발음 때문에 전사가 다른 낱말로 적히면 쓴 틀도 못 찾는다 — 그래서 "쓴 틀"은 참고이고 점수가 아니다.
- **준비 화면 — 옛 열린 결정 §12-12 9를 닫는다**: ④ 탭의 "새 문제 만들기"·"시작" 위에 접힌 "🧩 이 유형 답변 흐름"을 둔다 — 흐름의 **단계**마다 단계 이름과 틀 하나(가장 약한 것)의 틀 줄(자리 칩)과 "이 틀 연습하기"(② 탭의 그 카드). 이 접기와 틀 점검의 "빠진 단계의 가장 약한 틀"은 `drillStepPicks`(`lib/toeic-drill-view.ts`)가 `pickTemplatesForDrill`을 **무작위 없이**(같은 약함이면 파일 순서) 불러 고른다 — 화면을 새로 읽을 때마다 바뀌지 않게. 연습 **입력**의 틀 고르기는 무작위 동률 깨기 그대로라, 약함이 같은 틀이 많으면 접기에 보인 틀과 모범답변에 넣은 틀이 다를 수 있다(알려진 차이 — QA 이월 P3). **응시 화면(준비 45초) 안에는 두지 않는다** — 응시 화면은 실전과 공용이고, 준비 시간에 틀을 보면 실전 조건이 흐려진다. 시작 전에 보는 것은 자료를 보고 시험장에 들어가는 것과 같다.

### 12-8. 화면·경로

```
/toeic                              허브 — 카드 셋: 📒 표현집 · 🧑‍💼 모의고사 · 🧭 토익스피킹 유형별 공략(sm:col-span-2)
/toeic/guides                       유형 폴더 4개(Q3–4 사진 묘사 · Q5–7 듣고 답하기 · Q8–10 정보 활용 · Q11 의견 말하기) + 📂 파일로 가져오기
/toeic/guides/[part]                part ∈ q3_4 | q5_7 | q8_10 | q11 — 탭 넷(?tab=read|templates|quiz|drill)
                                      📖 공략 읽기(섹션·줄 🔊·섹션 ▶·듣기 바·"영어만" 틈·🧩 칩)
                                      🧩 템플릿 훈련(이어서 하기·단계/소재 칩·틀 카드·예문 🔊·따라 말하기 바·🧩 틀 테스트·최근 테스트 — ?tpl= 로 카드)
                                      👀 틀 시험(2026-10-02 — 옛 📝 표현 시험 대체: 모드·범위 고르기 + 틀린 틀(모드 탭) + 최근 틀 시험 — §12-13-2. 옛 표현 목록은 ① 끝 읽기 전용 접기로)
                                      🎤 한 문제 연습(🧩 답변 흐름 접기 + 목표 등급 + "새 문제 만들기" → 사진 준비(Q3–4) → "시작" → 응시 화면, 최근 연습 목록)
/toeic/guides/[part]/templates/test 🧩 틀 테스트(?mode=recall|swap&scope=group|step|wrong|all&group=&step=) — 전면 화면·시작 탭·녹음·받아쓰기·○/✕
/toeic/guides/[part]/templates/quiz 👀 틀 시험(?modes=&scope=all|step|group|wrong&i=&wrong= — i는 단계·묶음 번호) — 5지선다·빈칸, 모드별 묶음, 끝에 모드마다 저장(2026-10-02)
/toeic/mocks/[id]/take              (기존) 연습도 여기서 응시 — "뒤로"는 유형 폴더
/toeic/attempts/[id]                (기존) 연습 결과·AI 채점·🧩 틀 점검(연습만) — "뒤로"는 유형 폴더
/toeic/sets/[id]/quiz|wrong|history (기존) 공략 표현 시험 — "뒤로"는 유형 폴더. 틀 은행 id면 /toeic/guides로. 2026-10-02: 유형 공략 id면 그 폴더 ?tab=quiz로

/api/toeic/guides/import                 POST toeic-guides/v2 (AI 없음, 제자리 갱신·멱등 — 틀 은행 포함)
/api/toeic/guides/templates/transcribe   POST 녹음 → 글자(키 검사 먼저 → 관문 T 1회, 저장 없음)
/api/toeic/guides/templates/sessions     POST 템플릿 테스트·틀 시험 기록(AI 없음, 멱등 — 문서 id tpl-{clientSessionId}, 2026-10-02 모드 다섯)
/api/toeic/guides/[part]/drills          POST 연습 만들기(키 검사 먼저 → 호출 C 1회 — 2026-10-02: 답변 흐름을 넘긴다)
```

- 셸은 토익 관용구 그대로 — `u-navbtn` "← 아빠의 영어"(폴더 목록)·"← 유형별 공략"(폴더), 공통 레이아웃·`EnglishNav` 없음, 새 전역 CSS·토큰 없음(화면별 CSS 모듈에 기존 변수만). store를 읽는 페이지는 `force-dynamic`. 경로 조각에 점을 쓰지 않는다(정적 확장자 예외가 PIN 게이트를 우회한다).
- **유형 이름은 두 상수 중 어느 쪽인지 칸마다 정해 쓴다.**
  - 긴 이름 `toeicMockPartLabelKo`("Q3–4 사진 묘사"): 폴더 이름·폴더 머리, 공략 세트 `titleKo`(§12-3), 스트릭 라벨(§12-9), 응시 범위 라벨(`toeicDrillScopeLabelKo` — §12-7-4).
  - 짧은 이름 `TOEIC_MOCK_PART_NAME_KO`("사진 묘사"): 연습 제목 "사진 묘사 연습 3"(§12-7-2).
  - 파일이 없어도 네 폴더가 보인다. 폴더 카드에는 가져왔는지(섹션 n · 표현 n · 말하기 n — 2026-10-02부터 "섹션 n"만: 표현·말하기 수는 쓰는 화면이 없어진다), **틀 n · 익힘 m**(§12-5-6), 최근 연습 수·마지막 점수를 보인다(구현 반영 — "연습 n · 마지막 a/b": n은 그 유형 연습 문서 수, 점수는 최신순으로 처음 만나는 **다 채점한** 연습의 점수 합/만점, `toeicDrillFolderCard`).
- 탭 순서는 학습 흐름(① 읽기 ② 템플릿 훈련 ③ 표현 시험 ④ 한 문제 연습)이고, 주소가 탭을 기억한다(`?tab=` — 같은 폴더 안 탭·칩 이동은 `history.pushState`로 서버 왕복 없이, 다른 폴더는 `router.push`). 폰에서 탭 넷이 줄을 넘치면 고른 탭이 보이도록 **탭 줄만** 가로로 민다(페이지 가로 스크롤 없음 — 구현 반영). **`?tab`이 없으면 그 유형 틀이 1개 이상일 때 ② 템플릿 훈련을, 없으면 ① 읽기를 연다**(템플릿 반복이 핵심 — 폴더를 여는 대부분의 이유다). 기기에 마지막 탭을 기억해 바로 여는 기능은 두지 않는다(§12-12 10).
- **빈 상태**: 공략을 아직 가져오지 않은 폴더에서 📖·📝 탭은 "아직 공략 자료가 없어요" + "📂 파일로 가져오기" 버튼, 🧩 탭은 틀 은행이 없거나 그 유형 틀이 없으면 "아직 틀이 없어요" + 같은 버튼(2026-10-02: ③ 👀 틀 시험도 틀 은행에 기대므로 🧩 탭과 같은 빈 상태다 — 공략 세트가 없어도 틀만 있으면 된다). **🎤 한 문제 연습은 공략 없이도 된다**(AI가 새로 만들므로 — §0-4 독립 원칙과 같은 모양, 활용할 표현만 있는 곳에서 온다). 가져오기 결과는 "추가 n · 고침 n · 그대로 n"(틀 은행도 한 칸으로 센다)으로, 409는 충돌 키와 이유로 알린다.
- 새 화면 파일: `components/toeic-template-view.tsx`(② 탭 — 틀 카드·따라 말하기 바), `components/toeic-template-test.tsx`(테스트 전면 화면), `app/toeic/guides/[part]/templates/test/page.tsx`(서버 — 틀 은행·틀 세션을 읽어 넘긴다, `force-dynamic`). 계약은 `lib/toeic-guide-contract.ts` 하나에 더한다(전사·기록 라우트 응답, 클라이언트는 타입만). 구현이 더한 것: 서버 페이지 `app/toeic/guides/page.tsx`(폴더 목록)·`app/toeic/guides/[part]/page.tsx`(폴더 — 네 값 밖은 404), `components/toeic-guide-folder-view.tsx`(탭 셸)·`toeic-guide-read-view.tsx`(①)·`toeic-guide-expr-list.tsx`(③의 표현 목록·🧩 칩)·`toeic-drill-view.tsx`(④)·`toeic-guide-import-button.tsx`(📂 — 목록·빈 상태 공용)·`toeic-template-lines.tsx`(틀 줄·예문 줄 — ② 탭과 테스트가 한 벌)·`use-toeic-shadow-settings.ts`(따라 말하기 설정 기억).
- 최근 연습 목록: 그 유형 연습 최신 10개(`TOEIC_DRILL_RECENT_MAX`) — 제목·날짜·목표 등급·상태(사진 준비 중 / 응시 전 / 녹음 n · 채점 m / 점수 합·만점). 구현이 정한 뜻(`toeicDrillStatusKo`): 응시 기록이 0이면 "응시 전"이고, 그중 사진 칸이 아직 `pending`이면 "사진 준비 중"이다(만드는 요청이 진행 중인지는 서버가 모른다 — 다시 연 pending도 이 이름). 시작만 하고 떠난 응시도 "응시함"으로 센다. 응시가 있으면 가장 늦은 응시로 "녹음 n · 채점 m", 녹음된 문항을 다 채점했으면 "점수 합 / 만점"(만점 = 응시 범위 문항 만점의 합). "응시 전 연습 n개" 안내도 같은 판정(`pendingToeicDrills`)이다.
  - 읽기는 스토어 메서드 `listToeicDrills(mockPart)`로 한다. Firestore는 `where("drillPart", "==", mockPart)` **등호 하나**로 읽고, `orderBy`를 섞지 않는다(복합 색인이 필요 없다). 메모리에서 최신순으로 정렬해 10개를 자르고, 파일 백엔드는 메모리에서 거른다.
  - 필드가 없는 옛 문서가 빠지는 것은 맞는 결과다 — 옛 문서는 연습이 아니다.
  - 모의고사 목록 쪽(`drillPart == null`)은 §12-3대로 메모리에서 거른다. 등호 null 쿼리는 필드가 없는 옛 문서를 빠뜨린다.
  - 응시 기록은 응시 컬렉션을 읽어 메모리에서 모은다(가족 규모). 삭제·자동 정리는 두지 않는다 — 연습을 지우면 딸린 응시가 연쇄 삭제되고 스트릭 과거가 사라진다(SPEC §20-6).

### 12-9. 스트릭 §17-8 영향

계산식 변경 **0** — 공략 표현 시험과 **템플릿 테스트**는 `toeicQuizzes`에, 연습 응시는 `toeicAttempts`에 저장되어 기존 규칙(답한 문항 ≥ 1 / 녹음된 문항 ≥ 1)으로 그대로 센다. `toeicStreakSessions`는 모드를 보지 않으므로 틀 모드 세션도 들어간다. 템플릿 테스트에서 "답한 문항"은 아빠가 ○/✕를 정한 문항이다(받아쓰기를 못 써 자기 판정한 문항도 — 녹음 없이 한 테스트도 센다. 표현 말하기 시험의 자기 채점과 같은 근거다). `eval:streak` ⑥의 배선 정규식도 그대로 통과해야 한다(회귀 확인용으로 돌린다).

- 세지 않는 것: 공략 읽기·🔊·섹션 듣기(읽기·듣기 — §17-8 "전체 듣기·학습 보기"와 같은 근거), **템플릿 따라 말하기**(듣고 따라 하는 것 — 기록이 남지 않아 확인할 수 없다. 같은 근거), 가져오기·연습 만들기·사진(준비), AI 채점(응시한 날을 이미 셌다). "녹음 없이 연습"한 연습 응시도 세지 않는다(기존 규칙).
- 라벨만 가른다(`/api/streak`, 가장 늦게 시작한 것 규칙 그대로): 공략 세트의 시험이면 `공략 표현 · {유형 이름}`, **틀 은행의 테스트면 `템플릿 훈련 · {모드 이름}`**(모드 이름 = `TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO` — "예문 말하기"·"틀 바꿔 말하기". 틀은 여러 유형에 걸치므로 유형 이름을 붙이지 않는다. **2026-10-02**: ③ 틀 시험 세션도 틀 은행 세션이라 같은 모양이다 — 이름표를 다섯 모드의 `TOEIC_TEMPLATE_BANK_MODE_LABELS_KO`로 넓혀 "한→영 고르기"·"영→뜻 고르기"·"빈칸 채우기"가 나온다. 계산식은 그대로 — 답한 문항 ≥ 1, §12-13-2), 연습 응시면 `공략 연습 · {유형 이름}`(유형 이름 = `toeicMockPartLabelKo`), 그 밖은 기존 `표현집 · …`/`모의고사 · …`.
- SPEC §17-8에 한 줄을 덧붙였다(2026-09-28 — append, 표와 §번호 그대로). 라벨은 순수 함수 `toeicQuizStreakLabel`·`toeicAttemptStreakLabel`(`lib/toeic-streak.ts` — 런타임 import 0, 이름표는 라우트가 단일 정의처 `lib/toeic-quiz`·`lib/toeic-mock-contract`에서 넘긴다)이 만들고, `eval:streak` "영어 트랙" ⑦·⑧이 잠근다.

### 12-10. eval (`scripts/eval-toeic.ts` — 오프라인, 실호출 0)

> 구현 반영(2026-09-28): 아래 항목은 `scripts/eval-toeic-guides.ts`(순수 층 — 가져오기·틀 은행 zod·대본·비교·테스트·연습 순수 함수·실제 파일)·`eval-toeic-guides-app.ts`(S1 — 화면 순수 함수·Firestore 본문·가져오기·읽기·템플릿 탭 소스 대조)·`eval-toeic-guides-s2.ts`(S2 — 틀 테스트 화면·표현 시험·전사/기록 라우트 소스 대조·`addToeicQuizWithId` 파일 백엔드 실행)·`eval-toeic-guides-s3.ts`(S3 — 연습 레코드·녹음 풀·연습 화면·상태코드 소스 대조)에 나뉘어 있고 `eval-toeic.ts`가 한 번에 부른다. 합계 **985항목**(2026-09-28 — 2026-10-02 템플릿 중심 재정렬 뒤 1167, §12-13-7. 유형별 공략 628 — 큰 영역은 틀 은행 zod 99·공략 화면 순수 함수 64·공략 가져오기 zod 57·소스 대조 S1 43/S2 53/S3 33·공략 실제 파일 25), 0 SKIP(두 가져오기 파일이 있는 로컬 기준). 파일 백엔드를 실제로 도는 항목은 **임시 폴더를 cwd로 둔 자식 프로세스**에서 `getStore()`를 만든다 — eval 프로세스는 이미 `lib/store`를 불러 저장소 `data/db.json`을 가리키므로 여기서 스토어를 만들지 않는다(전후 sha 검사 포함). 공용 발음 모듈은 `eval:speech` **168항목**(쉼 21·준비 10·잠금화면 4 포함), 스트릭 라벨은 `eval:streak` **56항목**("영어 트랙" 9 — ⑦ 틀 테스트·공략 표현 라벨, ⑧ 연습 라벨)이 잠근다.

- **가져오기 zod 반례**(모든 문장은 지어낸 것)
  - 형식·최상위: 형식 문자열 다름(`toeic-sets/v1`, 초안 `toeic-guides/v1`), `guides` 5개, `templates`가 null인데 `guides` 0개(통과 쪽: `templates`가 있으면 0개도 된다 — 단 `guideRefs`가 빈 틀만), `part` `q1_2`, 파일 안 `part` 중복, `presetKey` 형식/중복(틀 은행 키가 공략 키와 같은 것 포함).
  - 칸 내용: 한국어 칸에 한글 없음, 영어 줄에 라틴 없음, **슬롯 밖 한글**, 슬롯 짝 안 맞음, 중첩 슬롯, 빈 슬롯, **영어 줄에 대괄호**, `groupKo` 31자.
  - 강조·밑줄: `emphasis`·`underline`이 `en` 밖(대소문자만 다른 것도 거부), `en`이 null인데 `emphasis`/`underline` 있음.
  - 블록: `alt`가 list 블록이나 첫 줄에, `en`·`ko` 둘 다 null, 빈 `text` 블록.
  - **completions**: `lead` null, `lead.en`에 `~`·슬롯, 줄 `en` null, 줄에 `example`·`alt`, 합성 문장 301자.
  - 개수·크기: 개수 상한(섹션 31·블록 61·줄 41). **크기 900,000바이트 초과**는 한글로 채운다 — 글자 수는 300,000 남짓이라 글자 기준이면 통과해 버리는 입력이다.
  - 표현: 81자, 중복(대소문자·공백 차이), `partial` 없이도 뜻 빈 값 거부. **공략 표현·예문에 `{x}`·`a/b`·`[x]`** — 영어 슬롯도 거부. **표현에 한글 자리 `{장소}`**가 들어오면 거부 경로가 그 항목의 `expression`이다(파일 전체 400이 어디서 났는지 경로로 보인다).
  - 말하기: `speak.no` null/중복, `modelAnswer`에 한글·`~`·`/`, `promptKo` 301자, `speak` 61개.
  - 통과 쪽: 지어낸 예시 파일(§12-2-2 — completions 블록 포함), 한국어 칸 속 영어 단어, 영어 줄의 슬래시 대안·띄어 쓴 괄호(읽기 본문에서는 된다), 형광과 밑줄이 겹침, `speak` 60개, 모르는 키(버려짐).
  - 기존 `checkEntryText` 불변: 표현집 가져오기(`toeicImportFileSchema`)는 표현에 `/`가 있어도 **지금처럼 통과**한다(공략 쪽 규칙이 새지 않았다).
- **틀 은행 zod 반례**(§12-2-7 — 모든 문장은 지어낸 것. 각 반례의 거부 경로가 그 칸을 가리키는지도 본다)
  - **예문 ≠ 틀 + 채움**: 한 글자 다름, **대소문자만 다름**(문장 첫 자리 채움을 소문자로), 끝 마침표 빠짐, 공백 두 칸. 채움 수 ≠ 자리 수(모자람·남음).
  - 틀 줄: 자리 0개·5개, 자리 이름 중복, 자리 밖 한글, 자리 밖 `~`·`/`·`[`, 낱말에 붙은 자리(`{동작}ing`·`{사람}'s`), 고정 낱말 0개(`{가} {나}.`), 121자.
  - 한국어 틀: 자리 이름 모임이 영어와 다름(하나 빠짐·이름 다름), `~` 사용, 한글 없음.
  - 채움: 한글, `{`, `~`, `/`, 앞뒤 공백, 81자, **라틴도 숫자도 없는 채움**(기호만 — `$`·`-`). 통과 쪽(검토 B1): **`$15`·`20`·`7:30`**처럼 숫자만 있는 채움. 예문 2개·6개, 예문 `en` 중복(대소문자만 다름), `fills` 묶음 중복, 예문 `ko`에 `~`.
  - **테스트 전용 채움** `testFills`: 0묶음·4묶음, 묶음 길이 ≠ 자리 수, 채움 규칙 위반(한글·`/`), 예문 채움 묶음과 같음(대소문자만 다른 것 포함), 두 묶음이 같음, 채운 문장 301자.
  - 키·유형: `key` 형식(대문자·밑줄·41자)·중복, `parts` 빈 배열·`q1_2`·중복, `items` 301개.
  - 출처: `source:"guide"`인데 `guideRefs` 빈 배열, `source:"new"`인데 `kind:"expression"`·`kind:"lead"`, `guideRefs` 5개, 같은 연결 두 번, 연결의 `part` ∉ `parts`, **가리키는 표현이 파일에 없음**(글자 다름·다른 유형에 있음·그 유형 항목이 파일에 없음), 없는 템플릿 단계 `label`, 없는 머리말. 통과 쪽: 한 틀이 두 유형 공략의 표현과 단계에 함께 걸린 것.
  - **교재 고정 부분이 온전하지 않음**: 교재 표현 `I find ~ relaxing`(지어낸 것)을 가리키면서 틀이 `I find {활동} calming.`(한 낱말 바꿈) → 거부. 통과 쪽: 대소문자·축약형만 다른 것(`It's ~` ↔ `It is {…}`), 교재 조각이 자리를 사이에 두고 순서대로 있는 것, 첫 낱말이 아닌 `A`·`B` 자리(`I rank A above B` ↔ `I rank {하나} above {다른 하나}.`), 머리말의 `a/b` 대안 중 하나, **소문자로 시작하는 동사 연어**의 활용형(`pay rent` ↔ `She pays rent {때}.` — 불규칙 활용은 거부).
  - **머리말 연결**(`leadMatchesFrame`): 통과 — 포함(`Two cooks are` ↔ `Two cooks are {동작}.`), 머리 사례(`I water the plants` ↔ `I water {무엇} {얼마나 자주}.` — 맞춘 고정 낱말 2개). 거부 — 맞춘 고정 낱말이 1개뿐인 머리 사례(`I bake cookies` ↔ `I {동작} {때}.`), 머리말 낱말 하나가 바뀜, 머리말이 틀 머리가 아닌 가운데에만 걸침(포함도 아닌 것).
  - **`~` 형태 충돌**: 두 틀의 `frameToExpression` 글자가 같음(자리 이름만 다름) → 거부.
  - `flows`: 유형 중복, 쓰이는 유형의 흐름이 없음, 틀이 없는 유형의 흐름, 단계 2개·7개, `stepKo` 중복·한글 없음, 단계 안 묶음 0개·9개, 소재 17개, 묶음이 두 번(단계와 소재에), 틀의 `groupKo`가 흐름에 없음, 흐름의 묶음에 그 유형 틀이 없음, **한 유형 묶음의 틀 7개**(유형별 틀 6개 + 다른 유형 원본의 공통 틀 1개로 7이 되는 것 포함 — 유형마다 센다).
  - **`alignmentSkips`**: 대상이 파일에 없음, **어떤 틀이 연결한 대상을 건너뜀**, 같은 대상 두 번, `reasonKo` 한글 없음·81자, `coveredBy`가 없는 key·그 유형을 `parts`에 갖지 않은 틀.
  - **정렬 빠짐**(검토 B5): 자리 표현 하나를 연결도 건너뜀도 안 함 → 400, 경로 `templates.alignment.{유형}.expression.{i}`이고 본문에 그 표현 글자가 없다(값 누출 검사와 같은 표식). 답변 틀 단계 `label`·머리말도 같게. 통과 쪽: 자리 없는 연결어 표현은 빠져도 된다, `guides`에 없는 유형은 보지 않는다, `templates: null`이면 검사하지 않는다.
  - 크기: 틀 은행 900,000바이트 초과(한글 `ko`로 채운다 — 글자 수 기준이면 통과해 버리는 입력). 유형 공략과 따로 잰다 — 유형 공략이 850,000바이트이고 틀 은행이 850,000바이트여도 통과.
  - 통과 쪽: **eval이 만든 최소 픽스처**(§12-2-2 예시 공략 + 유형마다 단계 3개·묶음마다 틀 하나 — 공통 틀·머리 사례 연결·건너뜀·숫자 채움·`testFills` 포함. §12-2-7의 JSON은 발췌라 그대로는 통과하지 않는다), 첫 자리 채움이 대문자인 예문, 틀이 없는 유형(흐름 없음).
- **틀 순수 함수**
  - `fillFrame`: 자리 순서대로 채우고 대소문자를 고치지 않는다. `frameToExpression`: 자리 → `~`, 공백 접기, 끝 마침표 하나 떼기(`?`는 그대로), 결과에 `{`·`}`·`/`가 없다.
  - `splitFrameForDisplay`·`splitExampleByFills`: 이어 붙이면 원문, 채움 구간이 채움 글자와 같다.
  - `templateLinksForGuide`: `guideRefs` 배열의 표현·템플릿 단계·머리말 연결을 모두 찾고(한 틀이 셋 모두에 걸린 경우 포함), 가리키는 틀이 없으면 비어 있다. ① 탭 줄 머리 칩 판정: `list` 줄 `en`의 `~` 모양이 연결된 표현과 같으면 칩, 슬래시 대안 줄은 펼친 것 중 하나가 같으면 칩.
  - `templateFlowOrder`: 단계 → 단계 안 묶음 → 소재 → 파일 순서, 흐름에 없는 묶음은 "기타"로 맨 뒤.
- **세트 불변식 — 두 갈래**(§7-1)
  - 표현집 가져오기 `quiz` 13개 거부 — 지금은 이 반례가 없다. 기존 불변식 잠금을 새로 둔다.
  - 공략 가져오기 `speak` 60개 통과·61개 거부.
  - `normalizeToeicSetRecord`·`isRenderableToeicSet`이 quiz 60개짜리 공략 세트를 그대로 열고 자르지 않는다.
  - 표현집 저장 라우트 zod의 quiz 상한은 `TOEIC_SET_QUIZ_MAX` 그대로다(소스 대조).
- **값 누출 없음**: 틀린 칸마다 지어낸 표식 문자열을 넣고, `JSON.stringify(toeicGuideImportInvalidBody(issues))`에 그 표식이 없는지 본다. 이 함수는 라우트가 400 본문을 만드는 **같은 함수**다(§12-2-3). 라우트 핸들러를 부르지 않는다 — eval은 라우트를 소스 읽기로만 본다. 라우트 소스가 이 함수를 쓰는지도 소스 대조로 확인한다.
- **다시 가져오기 판정** `decideGuideUpsert`
  - 표 여섯 갈래 전부. 같은 내용이면 unchanged다 — 키 순서만 다른 입력도 zod 출력 기준이라 지문이 같다.
  - 갱신이 `id`·`createdAt`·`sortIndex`를 지키고 `enriched`를 파생값으로 쓴다(유형 공략 false). 충돌이 하나면 파일 전체를 쓰지 않는다.
  - 새 공략 세트의 id는 `guide-{part}`다. 같은 유형을 다른 `presetKey`로 두 번(순서대로) 가져오면 둘째가 `part_taken`이다.
  - **틀 은행**: 새 문서 id `guide-templates`, 같은 내용 unchanged, 틀 글만 고치면 updated이고 틀 테스트 세션은 그대로, 다른 키로 두 번이면 `part_taken`(`part: "templates"`), 같은 키가 유형 공략이면 `part_mismatch`, `templates: null`이면 틀 은행 자리를 읽지도 쓰지도 않는다.
- **정규화·목록**
  - `guide` 없는 문서 = null. `guide`가 객체인데 `part`가 네 값 밖이거나 `kind`가 두 값 밖이면 null로 떨어지지 않는다(`isToeicGuideSet` true, 렌더 판정 false). 그래서 표현집 목록에 나오지 않는다. `kind`가 없는 객체는 `"part"`로 읽는다.
  - 틀 은행(`entries` 0)은 `isRenderableToeicSet` false, `isRenderableToeicTemplateBank` true, `enriched` false(파생값 — 검토 개선 2). 깨진 틀 하나는 그 틀만 빠진다(`isRenderableToeicTemplate`).
  - 목록이 공략 계열·연습을 **먼저** 빼고 `skippedCount`를 센다 — 공략 세트 4개·틀 은행·연습 3개가 있을 때 "열지 못한 n개" = 0.
  - `normalizeToeicQuizRecord`가 틀 모드 세션을 받고, 모르는 모드는 지금처럼 버린다. `aggregateToeicStatsByMode`는 틀 모드 세션이 섞여 들어와도 결과가 같다(`TOEIC_QUIZ_MODES`만 돈다 — `ToeicQuizSessionLike.mode`가 넓어져 이 입력이 타입상 된다, 검토 B3).
  - 세트 단위 화면(표현 시험·오답·기록 페이지)과 모의고사 라우트가 세션을 `isToeicQuizMode`로 거른 뒤 넘기는지(소스 대조).
  - 표현집 상세·시험 페이지의 틀 은행 리다이렉트, 표현 시험 저장 라우트가 틀 은행 id에 404인 것(소스 대조·순수 판정).
- **대본**
  - 블록 종류마다 조각 순서가 §12-4 표와 같다. 영어만 모드도 본다.
  - **completions**: 합성 조각 = 머리말 + " " + 행, 조각 수 = 행 수. `all`에서 `lead.en` 단독 조각이 없고 `lead.ko`가 한 번 있다. 영어만 모드에 머리말 단독 조각이 없다. 줄 🔊 조각·프리페치 목록에 합성 문장이 같은 글자로 있다.
  - **괄호·자리 정리 예**(지어낸 문장):
    - (a) 슬래시 대안 `upper/lower shelf` → "upper, lower shelf"
    - (b) `two thousand (and) five` → "two thousand and five"
    - (c) 메모를 `note`로 옮긴 줄은 메모를 읽지 않는다
    - 맨몸 자리 `{출발 장소}`와 en dash에서 온 `{대상}` → "…"
    - 한국어 `~`·`–` → "…"이고 뒤의 조사가 남는다("…에서")
    - 한국어 `+` → 쉼표("플러스"가 나오지 않는다)
    - 영어 슬롯·물결·슬래시
  - 라틴 없는 영어 조각이 없다. 긴 `bodyKo`는 같은 주소로 여러 조각이 된다.
  - 불변식: trim·비어 있지 않음·≤300·lang 명시. 줄 🔊 조각 = 대본에서 그 줄 주소로 거른 것. 프리페치 목록 ⊆ 영어 조각.
  - 강조·밑줄 분할: 이어 붙이면 원문, 겹침 처리, 형광+밑줄 동시 표시.
  - "영어만"의 틈 기본값은 끔이다(모든 조각 `pauseAfterMs` 0 — 큐의 쉼 경로를 타지 않는다). 켬: 영어 조각마다 `pauseAfterMs = shadowPauseMs(글자, 단계)`, 한국어 조각은 0. "전부" 모드는 모든 조각 0. 화면 토글의 초기값이 끔인 것은 앱 소스 대조가 본다.
  - `cleanGuideKoForTts`: 이름 있는 자리 `{활동}은` → "…은"(자리 이름을 읽지 않는다 — 검토 개선 1).
- **템플릿 따라 말하기 대본** `buildTemplateShadowScript`
  - 순서: (소개) 한국어 틀 → (영어 소개) 영어 틀 → 예문마다 `ko` → `en` × N. N = 1·4에서 영어 조각 수. 반복 조각의 글자가 같다(캐시 키 하나). 소개 끔이면 한국어 틀 조각이, 영어 소개 끔(기본)이면 영어 틀 조각이 없다. 영어 틀 조각은 자리가 "…"이고 쉼이 없다.
  - 쉼: 영어 예문 조각만 `shadowPauseMs`, 틈 끔이면 전부 0. 한국어 틀의 `{자리}`가 "…"로 읽힌다.
  - `shadowPauseMs`: 경계(1낱말 → 1,500 하한, 8낱말 → 3,900, 30낱말 → 8,000 상한), 낱말 수는 `countWords`. 단계 배율: 8낱말 짧게 3,120 · 길게 5,850.
  - `estimateShadowMs`: 조각 글자에서 계산한 값이 손으로 센 지어낸 대본(틀 1개·예문 3개·반복 2)과 같다, 속도 배율로 나뉜다, 쉼 끔이면 쉼 몫이 0.
  - `shadowResumeIndex`: "영어 3/4"에서 멈추면 그 예문의 한국어 조각 번호, 틀 소개 중이면 그 틀의 첫 조각 번호, 첫 조각이면 0.
  - 불변식: trim·비어 있지 않음·≤300·lang 명시. 예문 `en` 조각의 글자 = 카드 🔊 글자(trim만).
  - 이어 듣기 오프셋: 대본을 k부터 잘라도 조각 번호 = k + 큐 인덱스.
- **`speakQueue` 쉼**(`eval:speech` — 가짜 window·Audio·speechSynthesis 위에서, 기존 항목은 전부 그대로)
  - 칸 없음·0·음수·NaN: 이벤트 순서(`onItem`·`onEnd`·재생 호출 순서)가 칸을 넣기 전과 **같다**(같은 입력 두 벌의 기록을 비교).
  - **칸이 옮겨진다**: 입력을 다시 만드는 첫 줄이 `pauseAfterMs`를 버리지 않는다 — 칸만 다른 두 입력의 재생 기록이 달라야 한다(검토 개선 3 — 빠뜨리면 다른 항목이 모두 통과해도 쉼이 사라진다).
  - **쉼 = 무음 조각 재생 1회**(검토 B1 (가)): 조각 i가 끝나면 `onPause(i, ms)`가 한 번 오고, **같은 큐 오디오 요소**에서 길이 `ms`(250ms 단위로 올림)의 무음 WAV가 한 번 재생된 뒤 다음 `onItem`이 온다. 무음 WAV의 길이가 WAV 헤더에서 읽힌다(8kHz·8bit·mono). `ms = pauseAfterMs ÷ speedFactor` — 클라우드 엔진 보통 1(공식 그대로)·천천히 0.85(쉼이 길어진다)·빠르게 1.15, 기기 음성은 `getTtsRate() ÷ TTS_RATE`(검토 개선 4). `pauseMaxMs`(15초)에서 자른다. 쉼 도중 속도를 바꾸면 다음 쉼부터 반영된다.
  - 오디오 요소가 없거나 무음 재생이 거부되면 타이머로 기다리고, 끝나면 `currentPlayStop`을 **자기일 때만** 비운다(다음 `stopCloudAudio`가 URL을 회수하는지로 본다).
  - 쉼 도중 멈춤: stop·`stopSpeaking()`·새 큐 → 옛 `onEnd("stopped")`가 **동기로**, 새 큐 `onItem(0)`보다 먼저. 옛 큐는 그 뒤 `onItem`을 내지 않는다. 쉼 도중 외부 pause(잠금 화면 ⏸ 흉내)도 `"stopped"`다(§18-2 그대로).
  - 마지막 조각 뒤 쉼이 끝난 다음 `onEnd("done")`. 공백 조각의 쉼은 건너뛴다. `sounded`·무음 연속 판정은 쉼과 무관하다(무음 조각은 `sounded`에 들지 않는다. 기기 음성까지 실패한 조각 뒤에도 쉼은 지킨다).
  - **`prepareSpeech`**: 고유 글자만·클라우드로 읽을 것만 합성(상한 앞에 둔 ja 기기·301자·공백 조각을 거른다), 캐시에 있으면 건너뜀, 90에서 자름, `onProgress`가 단조 증가로 `total`까지, `signal`로 끊으면 그 뒤 요청이 없고 reject하지 않는다, 501이면 곧바로 끝, 기존 `prefetchSpeech`의 진행을 끊지 않는다(서로 다른 abort), 매달린 조각은 `fetchMs` 뒤 건너뜀, 준비 도중 기기 엔진으로 바꾸면 남은 조각 POST 0, 준비한 조각은 큐에서 합성 0(P1~P9).
  - **잠금 화면 관문**(M1~M4): 큐(쉼 포함)·`speak`·stop은 `navigator.mediaSession`을 건드리지 않는다(기존 호출부의 잠금 화면 ⏸ = 정지 그대로), 걸고 풀기, 낡은 풀기는 무시, 미지원이면 no-op.
- **전사 비교** `compareTemplateAnswer`·`normalizeTemplateWords`(지어낸 문장)
  - 축약형: `it's`↔`it is`, `don't`↔`do not`, `can't`↔`can not`↔`cannot`, `won't`↔`will not`, `I'm`↔`I am`, `they're`, `we've`, `I'll`, `let's`↔`let us`, 둥근 아포스트로피(’). 명사 소유격 `'s`는 풀지 않는다.
  - **두 뜻 축약형**(검토 개선 5): 완전형 틀 `It has been {…}` ↔ 전사 "It's been …" → 같다. 축약형 틀 `It's {…}` ↔ "It is …"·"It has …" → 같다. `he'd` ↔ "he would"·"he had" → 같다. `alignReadAloud`는 `eq` 없이 불러 결과가 그대로다.
  - 숫자: `twenty`↔`20`, `twenty-five`↔`25`, `seven thirty`↔`7:30`.
  - 대소문자·문장부호·쉼표 위치 차이는 무시.
  - 관사: 자리 안 `a`·`the` 빠짐 → 자리 낱말 전부 맞음. 고정 부분 `the` 빠짐 → 틀 정확도가 준다.
  - 어순: 고정 낱말 둘이 바뀜 → 빠짐 1 + 더함 1 → 제안 ✕.
  - 빈 전사·공백뿐 → `noSpeech`·제안 ✕.
  - **틀 부분만 맞고 자리가 다름**(자리를 다른 말로 채움) → 틀 정확도 1·자리 `filled`·제안 ○. **자리를 비움**(고정 낱말만 말함) → 그 자리 `filled:false` → ✕. **자리에 관사만 들림**("… set on the.") → `filled:false` → ✕(검토 개선 9).
  - `compareWithAlternatives`: 한국어 틀이 같은 대안 틀로 말하면 제안 ○와 대안 표시, 기록 키는 물은 틀. 자리 수가 다른 틀은 대안으로 쓰지 않는다. (나)에는 대안 대조가 없다.
  - 더한 말(앞뒤 "음", 문장 되풀이)은 점수에 들지 않는다.
  - 경계: 고정 낱말 7개 중 1개 빠짐 → 0.857 → ○, 6개 중 1개 → 0.83 → ✕.
  - `alignWordSeq` 추출 뒤 `alignReadAloud`의 기존 Q1–2 항목 전부 그대로(결과 글자까지).
- **전사문 속 틀 찾기** `findTemplatesInTranscript`·`templateStepCoverage`
  - 두 낱말 이상 고정 조각이 순서대로 있으면 찾는다. 조각 순서가 바뀜·조각 하나가 반만 있음 → 못 찾는다. 축약형 차이(`that is because` ↔ `that's because`)는 찾는다.
  - 한 낱말 조각뿐인 틀은 찾지 않고 "찾을 수 없는 틀"로 센다. 같은 틀이 두 번 나와도 한 번.
  - **단계 커버리지**(검토 B2): 쓴 틀이 없는 **단계**가 빠진 단계로 나온다. 소재 묶음의 틀만 쓴 답은 단계를 채우지 않는다. 단계 안 묶음이 여럿이면 그중 하나의 틀만 써도 그 단계는 채워진다. Q5–7·Q8–10에서는 빠진 단계를 내지 않는다(`TOEIC_TEMPLATE_FLOW_CHECK_PARTS`).
  - `templateByExpression`: `~` 형태·`guideRefs`의 공략 표현 모두로 되짚는다. "쓸 수 있었던 틀" = 모범답변 사용 → `tryExpressions` → 빠진 단계 순, 최대 5개, 내가 쓴 틀은 빠진다.
- **템플릿 테스트**
  - `buildTemplateTestQuestions`: 한 판 한 틀(같은 `key` 두 번 없음), 최대 10개, 약한 순으로 고른 뒤 흐름 순서로 늘어섬, `onlyWrong`은 그 모드 틀린 틀만. **복습 칸**: 졸업한 틀이 있으면 최대 2칸이 마지막 시도가 가장 오래된 졸업 틀이다(`onlyWrong`이면 없다, 범위에 졸업 틀이 없으면 그 칸도 약한 순). (가) 예문 `a = t mod n`(시도 0 → 첫 예문, 시도 4·예문 4개 → 첫 예문으로 돌아옴). (나) 들려줄 예문 `m = t mod n`, 정답 채움 `testFills[t mod L]` — 정답 문장이 그 틀의 어떤 예문 `en`과도 다르다.
  - 약함 순위는 `lib/toeic-quiz.ts`에서 공개한 `weaknessRank`를 부른다 — `lib/toeic-template.ts` 소스에 순위 규칙 사본이 없다(소스 대조, 검토 B3). 세션 어댑터도 공개한 `toeicSessionsToVocabRecords` 하나다.
  - `aggregateToeicTemplateStats`: 두 모드가 서로의 통계에 섞이지 않는다. **공통 틀**(Q5–7·Q11)은 어느 폴더에서 풀어도 통계가 하나다. 표현 시험 세션(유형 공략 세트)은 틀 통계를 바꾸지 않고, 틀 세션은 표현 시험 통계(`aggregateToeicStatsByMode`)를 바꾸지 않는다.
  - **같은 날 ○ 접기**(검토 S8): 같은 KST 날 두 세션 ○○ → 연속 1(졸업 아님, 배지 "오늘 ○ — 내일 한 번 더"), 다른 날 ○○ → 졸업, 같은 날 ○✕ → ✕가 세진다, 같은 날 ✕○ → 연속 1. KST 날짜 경계(UTC 15:00 전후)를 넘는 두 세션은 다른 날이다.
  - `toeicTemplateWrongKeys`: 틀렸고 미졸업만. "틀린 틀만 따라 말하기" = 두 모드 합집합.
  - 상한 상수: 문항당 전사 2·세션 20·녹음 20초·0.6초 미만은 보내지 않음(화면 순수 판정 `canTranscribeAgain(counts)`).
- **템플릿 라우트**(소스 대조 — eval은 라우트 핸들러를 부르지 않는다)
  - 전사 라우트: 키 검사가 `formData()` 읽기보다 앞선다, `content-length` 413이 `formData()`보다 앞선다, 413 상한 상수 1 MiB, 파일 이름·형식 도우미(`toeicAudioFileName`·`toeicAudioTypeFromName`)를 쓴다, `transcribeAnswer`에 prompt 인자가 없다(기존 정적 검사 그대로), 스토어 import가 없다, `req.signal`을 넘긴다.
  - 기록 라우트: `mode` enum이 틀 모드 둘뿐, `word` 형식 정규식, 세션 안 중복 거부, **`clientSessionId`가 `TOEIC_TEMPLATE_SESSION_ID_RE`**(대문자 UUID·`/` 든 값·빈 값 거부 — 검토 B4), **`startedAt`·`finishedAt`이 `z.string().datetime()`**, `setId`가 `guide-templates`로 고정(본문 값을 믿지 않는다), 멱등 저장 메서드를 쓴다.
  - 스토어 `addToeicQuizWithId`(파일 백엔드 — 가짜 DB로 실행): 같은 id·같은 판(`mode`·`startedAt` 같음) 두 번 → 한 건·둘째 `reused:true`. 같은 id·다른 판 → 원 문서는 그대로이고 새 id로 한 건 더(`reused:false`).
- **연습**
  - `TOEIC_DRILL_UNITS` 리터럴 4행.
  - `toDrillRecordPart`: picture는 rng가 고른 한 장면만 남기고 image는 pending이다(rng 0 → 첫 장면, rng 0.99 → 둘째 장면). 다른 파트는 그대로다.
  - `decideAttemptScope`의 연습 갈래: `[3]`·`[5,6,7]`·`[8,9,10]`·`[11]`. 연습에 `full`·다른 파트를 보내면 거부한다.
  - **사진 연습 상태코드**
    - 끝내기에 Q4가 있으면 범위 밖 400이다(범위 판정 순수 함수 + 라우트가 `attempt.questions`로 범위를 잡는지 소스 대조).
    - Q4 채점은 **404 `question_not_found`**다. 채점 라우트가 범위를 `attempt.questions`에서 읽고 이 오류 이름을 그대로 쓰는지 소스 대조한다.
    - 사진 slot 1은 **404 `picture_not_found`**이고, 이 판정이 키 검사·관문 P 호출보다 앞선다(소스 대조 — 계약 잠금).
  - 옛 응시 문서 `questions` = 파트 문항.
  - `toeicPartDirections`: 전체 개수면 `TOEIC_PART_DIRECTIONS`와 글자까지 같다. 사진 1장 문장의 숫자는 형식표 값이다. 응시 화면 소스에 `TOEIC_PART_DIRECTIONS[` 직접 참조가 남지 않았다(세 곳 모두 함수).
  - `toeicDrillScopeLabelKo`: "공략 연습 · Q3–4 사진 묘사 · Q3", Q5–7이면 문항 표시가 없다.
  - `pickExpressionsForDrill`
    - **틀 먼저**(단계마다 하나 → 단계·소재를 통틀어 약한 순, 최대 10, `~` 형태 — `{`·`}` 없음 — 단계가 5개인 유형에서 단계마다 하나씩 모두 들어간다), 공략 다음, 표현집으로 채움, 24 상한, 중복 없음(교재 틀을 옮긴 틀의 `~` 형태와 같은 글자의 공략 표현은 한 번), 보낸 목록 = 저장 목록. 틀 은행이 없으면 지금과 같은 결과다.
    - 다른 유형의 틀은 들어가지 않는다(`parts`로 거른다).
    - **세션 분리**: 공략 세션만 틀린 표현은 표현집 쪽 순위를 바꾸지 않는다(반대도 같다).
    - `pickExpressionsForMock`을 거친다 — 같은 입력이면 공략 쪽 순위가 `pickExpressionsForMock([guide], guideSessions)`와 같다.
  - `pickDrillTopic`: 최근 3개 주제 제외, 다 빠지면 풀 전체, 풀 파트마다 8개 이상.
  - 모의고사 목록·`nextToeicMockTitle`이 연습을 무시한다. `POST /api/toeic/mocks`가 표현집 세트의 세션만 넘긴다(소스 대조 또는 순수 도우미). `nextToeicDrillTitle`은 유형별 번호를 매긴다.
  - 녹음 보관 풀: 연습 6회가 채점 전 실전 녹음을 지우지 않는다. 옛 메타는 mock 풀이다.
- **시험 출제**
  - `quizOrder:"weakness"`가 말하기 통계만으로 QUIZ를 약한 순으로 낸다. 다른 모드 통계를 섞으면 순서가 달라지는 반례로 잠근다. 기본 `"book"`은 지금과 같은 결과다(기존 항목 그대로 통과).
  - `buildToeicChoiceQuestions`의 `max`: 20에서 자르고 그 모드 통계로 약한 순이다. `max` 없으면 지금과 같은 결과다.
  - **같은 뜻 대안**: 어휘 대안 두 항목의 `meaningKo`가 글자까지 같으면 서로의 오답 보기로 나오지 않는다(두 모드). 뜻이 다르게 적힌 조건 변형(왼쪽/오른쪽)은 서로 보기로 나온다.
- **번들 경계**
  - `lib/toeic-guide.ts`·`lib/toeic-template.ts`·`lib/toeic-drill.ts`·`lib/toeic-attempt-rules.ts`를 기존 "번들 경계" 목록에 등록한다(`/ai/`·`/store`·`openai`·`zod` 값 import 금지·lookbehind 금지). `lib/toeic-template.ts`의 런타임 import는 `lib/toeic-guide`·`lib/toeic-text`·`lib/toeic-score`·`lib/toeic-quiz`·`lib/vocab-mastery`·`lib/kst`·`lib/tts-split`·`lib/tts-shared`뿐이다(`lib/toeic-quiz`·`lib/kst`는 검토 반영으로 더했다). `lib/toeic-guide.ts`는 `lib/tts-shared`·`lib/tts-split`·`lib/ja-coaching-script`·`lib/toeic-text`뿐이다. `lib/toeic-guide`와 `lib/toeic-quiz`는 `lib/toeic-template`을 import하지 않는다 — 순환 금지.
  - `lib/toeic-guide-contract.ts`는 계약 파일 검사 목록(`toeic-mock-contract.ts`와 같은 줄)에 등록한다.
  - `pickExpressionsForDrill`이 `lib/ai/toeic/mock.ts`에 있고 `lib/toeic-drill.ts`에는 없다.
- **실제 가져오기 파일**: `data/private/toeic-strategy/toeic-guides.json`이 있으면 검사하고, 없으면 SKIP이다(공개 저장소·CI 기준). **개수만** 출력하고 내용은 찍지 않는다. 기존 표현집 파일 검사(10세트·140표현·20 QUIZ)와 **섞지 않는다**.
  - zod 통과(**정렬 빠짐 0 포함** — 빠짐이 있으면 zod가 거부하므로 FAIL이다), 유형 4개, 유형별 섹션·표현·말하기 수, 문서 바이트. 틀 은행: 틀 수, 유형별 틀 수(`parts` 기준), 공통 틀 수, `source`별 수, 예문 수, 테스트 전용 채움 수, 유형별 단계·묶음·소재 수와 묶음당 최대 틀 수, **유형별 정렬 "연결 n / 건너뜀 n / 빠짐 0"**(대상 종류마다), 문서 바이트.
  - 대본 불변식을 실제 데이터로 한 번 더(공략 읽기·템플릿 따라 말하기 둘 다).
  - 변환 규칙 점검(각각 개수 = 0):
    - `completions` 블록 줄 중 소문자로 시작하지 않는 줄
    - `list` 블록 중 이어 말하기 판정(§12-2-1)에 맞는데 `list`로 남은 블록
    - 영어 줄의 `+`·en dash 자리
    - 라틴 글자에 바로 붙은 여는 소괄호(영어 대안이 남은 것)
  - 틀 점검(개수만 — 0이 아니어도 실패로 두지 않고 알린다. 내용 판단이 섞여 있다):
    - `guideRefs`에 `template` 연결이 있는 틀 중 그 템플릿 줄의 첫 고정 조각(슬래시 대안 중 하나)이 틀에 없는 것
    - 두 낱말 이상 이어진 고정 조각이 없는 틀(전사문 매칭 제외 — §12-5-5)
    - `source:"new"`인데 `frameToExpression` 글자가 그 유형 공략 표현과 같은 틀(교재 틀인데 "new"로 적힌 것)
    - 같은 유형 안에서 한국어 틀이 글자까지 같은 쌍(어휘 대안 — (가) 대안 대조가 받는다)
    - 정렬 규칙 12 대상 틀 중 한국어 틀이 교재 뜻풀이와 자리 조사·어미 밖에서 다른 것
    - 따라 말하기 예상 시간이 20분을 넘는 묶음(`estimateShadowMs` — 반복 4·틈 보통)
- **spec-sync**: 대상 변경 없음(§12-7-7). 이 절의 JSON 예시(§12-2-2·§12-2-7)는 최상위 `name`이 없어 JSON Schema 블록 수(8) 검사에 걸리지 않는다. 호출 옵션 문장 정규식(temperature·maxOutputTokens·call 라벨이 한 문장에 나오는 형식)에 걸리는 문장을 이 절에 쓰지 않는다. **2026-10-02**: 원문 대상이 하나 늘고(`TOEIC_MOCK_FLOW_RULES` — 14 → 15) 값 셋(§4-7·§5-1·§5-2)이 바뀐다 — 템플릿 중심 재정렬의 eval 항목은 §12-13-5.
- 스트릭 라벨은 `eval:streak`에서 본다(⑥ 배선 정규식 불변 확인과 함께 — 틀 모드 세션이 영어 트랙에 들고, 라벨이 `템플릿 훈련 · {모드}`). `speakQueue` 쉼은 `eval:speech`가 본다(위). `lib/speech.ts`는 네 과목이 쓰므로 `eval:toeic`·`eval:japanese`·`eval:english`·`eval:workout` 오프라인도 함께 돌린다. `normalizeKoForTts`를 공용 모듈로 옮기면 `eval:speech`도 돌린다.
- **실호출 게이트는 새로 두지 않는다** — 연습은 기존 호출 C·D·관문 P·T를 입력만 바꿔 부른다(`EVAL_TOEIC=1`의 C 파트 1개·D 1개가 같은 경로다). 템플릿 테스트의 전사는 관문 T 그대로라 실기기(사용자 동의 후)에서 본다 — 오디오 픽스처를 저장소에 두지 않는다.

### 12-11. 로드맵

| 단계 | 내용 | AI 호출 | 의존 |
|---|---|---|---|
| **T6** | 가져오기 — `toeic-guides/v2` zod(completions·밑줄·`groupKo`·공략 표현 기호 거부·바이트 상한 + **틀 은행 zod**: 예문 = 틀 + 채움(채움은 라틴 또는 숫자)·`testFills`·자리 규칙·한국어 틀 자리 모임·`~` 형태 유일·`guideRefs` 대상과 교재 고정 부분(머리말 포함·머리 사례·동사 연어 활용)·`flows` 단계/소재·묶음 6개 상한·`alignmentSkips`·**정렬 빠짐 0**)·`toeicGuideImportInvalidBody`·`decideGuideUpsert`(틀 은행 자리 포함)·스토어 `upsertToeicGuides`(결정적 id `guide-{part}`·`guide-templates`, 두 백엔드 원자 단위)·라우트·`ToeicSetRecord.guide` 필드(두 종류)와 정규화 깊이·목록 가리기(`skippedCount` 순서)·허브 카드·`/toeic/guides` 폴더 목록과 빈 상태. 원본 → 가져오기 파일 변환(Claude, `data/private` — §12-2-1·§12-2-7 규칙, 틀 원본은 `core/templates.json`(`toeic-core-raw/v3`) 한 파일 — 흐름·건너뜀도 원본에 있다) | 0 | — |
| **T7** | 공략 읽기 + 🔊 — 대본(`guideLineEn` 이어 말하기 합성 포함)·정리(한국어 `~` → "…")·강조·밑줄 분할 순수 함수, 읽기 탭, 듣기 바·섹션 ▶·줄 🔊·프리페치 | 0(발음만) | T6 |
| **T8** | 표현 말하기 시험 — 시험 탭(표현 프리페치), 공략 세트 "뒤로" 링크·상세 리다이렉트·rename/points 409·공략용 안내 문구, `quizOrder:"weakness"`, 5지선다 `max` 20, 스트릭 라벨(표현) | 0 | T6 |
| **T9** | 한 문제 연습 — `drillPart`·`questions` 필드, 단위표·`toDrillRecordPart`(장면 무작위)·주제 풀·지시문 변형(세 곳)·범위 라벨, `pickExpressionsForDrill`(서버, 세션 분리)과 실전 모의고사 세션 거르기, 연습 라우트·연습 탭(비용 캡션·응시 전 연습 안내)·사진 준비, 응시·결과 "뒤로"·결과 화면 묘사 포인트/답변 뼈대·"학습 보기로" 숨김, 모의고사 목록·제목·학습 보기·regenerate 409, 사진 slot 404 잠금(변경 없음), 녹음 보관 풀, 스트릭 라벨(연습) | C·P(만들기), T·D(채점 버튼) | T0~T5. **T6 없이도 된다**(공략 표현만 빠진다) |
| **T10** | 템플릿 읽기·따라 말하기 — 틀 순수 함수(`fillFrame`·`frameToExpression`·표시 분할·`templateFlowOrder`·`templateLinksForGuide`), ② 탭(이어서 하기·단계/소재 칩·틀 카드·예문 🔊·배지 자리·빈 상태·`?tpl=`), 폴더 기본 탭·폴더 카드 "틀 n", **`speakQueue` `pauseAfterMs` — 무음 조각 쉼·`prepareSpeech`**(공용 — `eval:speech` 전체 + 네 과목 오프라인 회귀), `shadowPauseMs`(세 단계)·`buildTemplateShadowScript`(영어 틀 소개)·`estimateShadowMs`·`shadowResumeIndex`, 따라 말하기 바(범위 여섯·반복·틈 단계·소개·지금 틀 띄우기·이어 듣기(예문 머리)·준비 n/m·Media Session·Wake Lock·프리페치), 공략 읽기 "영어만" 틈 토글(기본 끔), ①(블록·줄)·③ 탭의 🧩 칩과 틀 카드의 "📘 교재 틀" 칩 | 0(발음만) | T6 |
| **T11** | 템플릿 테스트·전사 비교 — `expandContractions`(두 뜻 대안)·`normalizeTemplateWords`·`sameTemplateWord`·`alignWordSeq` 추출(`eq` 인자 — `alignReadAloud` 불변)·`compareTemplateAnswer`(관사만 들린 자리)·`compareWithAlternatives`, `lib/toeic-quiz.ts`의 공개(`weaknessRank`·`toeicSessionsToVocabRecords`·틀 모드 타입)와 `ToeicQuizSessionLike.mode` 넓히기·세트 화면 거르기, `buildTemplateTestQuestions`(복습 칸·`testFills`)·`aggregateToeicTemplateStats`(같은 날 ○ 접기)·`toeicTemplateWrongKeys`, `ToeicQuizRecord.mode` 넓히기·정규화, 전사 라우트(키 먼저·`content-length` 413·파일 이름 도우미·1 MiB·저장 없음)·기록 라우트(`clientSessionId` 형식·datetime·멱등 `addToeicQuizWithId` 세 갈래), 테스트 페이지(시작 탭·(나) 영어 없는 단서·녹음·WAV·전사(45초 상한)·첫 유효 시도 판정·한 번 더 따라 말하기·판정 탭이 다음 문항·자기 판정 폴백·상한·비용 표시), 배지(오늘 ○)·"틀린 틀만"·최근 테스트·폴더 "익힘 m", 스트릭 라벨(템플릿) | 전사(테스트 문항마다 — 버튼 흐름 안) | T10 |
| **T12** | 실전 적용 — `pickTemplatesForDrill`(단계마다 하나)과 `pickExpressionsForDrill`의 틀 앞자리, `findTemplatesInTranscript`·`templateStepCoverage`·`templateByExpression`, 결과 화면 "🧩 틀 점검"(연습만 — 빠진 단계), 연습 탭 "🧩 이 유형 답변 흐름" 접기(단계마다) | 0(연습 만들기·채점은 T9 그대로) | T9 + T10(T11 없이도 된다 — 약함 순위가 "안 해 봄"으로 모인다) |
| **T13** (2026-10-02) | ① 읽기 정렬 — 틀 은행 `alternates`(가져오기가 `coveredBy` 있는 건너뜀에서 만든다·지문·바이트·정규화), `templateAlternateLinks`·`guideReadMarks`(검토 반영 — 슬래시 대안 줄의 `framePicks`, 이어 말하기 머리말만 접는 `bareBlocks`·`frameEndsWithSlot`), 대본 옵션 `skip`(`blocks`·`lines`·`bareLeads`·`picks` — 섹션 ▶·처음부터·프리페치·줄 🔊·`text` 블록 🔊가 같은 대본, 접은 줄 🔊는 접기 없는 대본, 접힌 이어 말하기 머리말은 `toeicGuideLeadPieces`), "🧩 외울 틀" 강조·틀 줄(칩·탭 🔊)·머리 두 줄(외울 틀 n·m, 범례 또는 다시 가져오기 안내), "같은 자리 다른 표현" 접기, ① 끝 "📘 교재 표현 목록"(읽기 전용 — 표현 목록 컴포넌트를 옮겨 줄인다), `?goto=k:{틀 key}`(선택 인자 `marks`)와 📘 칩의 표현 연결 갈 곳, `alternates` 파일 저장소 왕복 eval — §12-13-1. **배포 뒤 같은 가져오기 파일을 한 번 다시 넣는다**(틀 은행 updated) | 0(발음만) | T6·T7·T10 |
| **T14** (2026-10-02) | ③ 틀 시험 — 모드 셋(`lib/toeic-quiz.ts` 타입·목록·라벨, 레코드·세션 모양 넓히기·정규화), `lib/toeic-template-quiz.ts`(문항 조립·오답 보기 층·빈칸 낱말·보기 대소문자·통계·틀린 틀·배지), 틀 시험 페이지·러너·③ 탭(모드·범위·틀린 틀·최근 틀 시험), 기록 라우트 모드 다섯·상한 갈래(`TOEIC_TEMPLATE_CHOICE_MAX`), 모드별 묶음·자리 수 같은 보기 먼저·빈칸 한 번 나오는 낱말·대소문자는 `before` 기준·모드별 0문항 저장 생략·러너 주소 번호 `i`·묶음 범위, ② 카드 칩 "👀 ✕ n", 공략 표현 시험 화면 닫기(세 페이지 리다이렉트·③에서 표현 목록 제거), 스트릭 라벨과 `eval:streak` ⑦ — §12-13-2 | 0(발음만) | T10·T11 |
| **T15** (2026-10-02) | ④ 답변 흐름 조립 — 바뀐 원문 셋(`TOEIC_MOCK_USER_TEMPLATE`·`TOEIC_FEEDBACK_SYSTEM_PROMPT`·`TOEIC_FEEDBACK_USER_TEMPLATE`)과 새 원문 `TOEIC_MOCK_FLOW_RULES`(`SPEC_SYNC_TARGETS` 등록·`buildMockSystemPrompt(part, hasFlow)` — `TOEIC_MOCK_COMMON`은 그대로), 플레이스홀더 `answerFlow`, `hasUnfilledSlot` zod(C2~C5·D), `calls.ts` 허용 목록(흐름 앞·정규화 뒤 합치기), 모의고사 라우트 네 파트 흐름 저장(`buildMockAnswerFlows` — 틀 은행은 `listToeicSets` 결과에서), "쓸 수 있었던 틀" 새 순서·모범답변 점검 미달 경고·모의고사 결과 머리 줄·준비 접기 "+n", `ToeicAnswerFlow`·`buildAnswerFlow`·`formatAnswerFlow`·`answerFlowExpressions`·`checkAnswerAgainstFlow`, `ToeicMockRecord.answerFlows`(정규화·생성부), `generateMockPart` 입력·`toMockRecordPart`·`buildFeedbackInput`·`postprocessFeedback` 허용 목록, 모의고사·연습·다시 만들기 라우트, `pickExpressionsForDrill` 새 모양, 모범답변 점검 표시·학습 보기 흐름 접기, "🧩 틀 점검" 모의고사에도·모범답변 틀은 글에서 찾기 — §12-13-3 | C·D(입력만 길어짐 — 호출 수 0 변화) | T9·T12. 실호출 확인은 사용자 동의 뒤 |

- **권하는 순서**: T6 → **T10 → T11** → T7 → T8 → T9 → T12. 템플릿 반복이 이 기능의 핵심이라(사용자 요구) 틀을 먼저 쓸 수 있게 한다. T7·T8은 T10과 겹치는 칩 자리만 서로 기다린다(칩은 어느 쪽이 먼저 들어가도 된다 — 대상이 없으면 칩이 없다).
- 각 단계는 오프라인 eval을 먼저 통과한다. T9·T11의 실기기 확인(SPEC §20-10)은 배포본에서 한다. 실호출 첫 확인은 사용자 동의 후 연습 한 번(유형 하나)과 템플릿 테스트 한 판(전사 몇 번)으로 묶는다.
- 틀 원본(`core/templates.json`) 작성·교정은 코드 단계와 별개로 Claude가 한다. 변환한 가져오기 파일이 zod를 통과해야 T10 화면 확인을 실데이터로 할 수 있다(T6 eval의 "실제 가져오기 파일" 검사).
- **T13~T15 권하는 순서: T15 → T13 → T14.** 이 스펙이 원문 셋(§4-7·§5-1·§5-2)을 이미 새 문자열로 갈았으므로 T15가 들어오기 전까지 `eval:toeic` spec-sync 3건이 FAIL이다(검토 반영으로 §4-1 머리말은 옛 글자로 돌아가 PASS — 새 원문 `TOEIC_MOCK_FLOW_RULES`는 T15가 등록하기 전까지 대조 대상이 아니다) — 첫 구현 단계를 T15로 두어 붉은 구간을 가장 짧게 한다. **이 스펙 변경은 T15 코드와 같은 커밋으로 묶는다**(문서만 먼저 커밋하면 main의 eval이 붉다). T13·T14는 서로 독립이다(③은 ① 데이터를 쓰지 않는다). 사용자 강조도 ④(괄호 안 "가능한 템플릿 기반으로")다. **결과(2026-10-02)**: 이 순서대로 같은 날 T15(AI 층) → T13·T14(화면·라우트 층)를 구현했고 붉은 구간은 닫혔다(spec-sync 15/15, `eval:toeic` 1167 PASS). 스펙·AI 층·앱 층은 여전히 한 커밋으로 묶는다.

### 12-12. 열린 결정 — 스펙에는 기본값을 썼다

상태: **닫힘**(사용자 확정이거나 이 스펙이 근거를 들어 정했다 — 다시 열려면 §12-0 표부터 고친다) / **열림**(기본값으로 구현하고 실사용 뒤 사용자에게 올린다). 번호는 옛 목록(1~10)을 그대로 두고 뒤에 더했다.

1. **실전 모의고사에 공략 표현·틀을 넣을지** — **닫힘(2026-10-02, 사용자 확정)**. 틀은 넣는다 — 파트마다 그 유형 **답변 흐름**을 새 입력 칸으로 넘겨 모범답변을 틀로 조립한다(§12-13-3). "활용할 표현" 칸은 지금처럼 표현집만이다 — 흐름이 칸을 따로 가지므로 24개 비중을 나눌 일이 없다. 공략 표현(교재 표현 목록)은 넣지 않는다(외울 틀은 흐름에 이미 있고, 같은 자리 다른 표현은 넣으면 안 된다). 옛 기본값 "넣지 않는다"를 뒤집었다.
2. **Q3–4 연습을 사진 2장(실전 파트 그대로)으로 할지** — 열림. 기본: 1장(§12-7-1). 2장이면 응시 기록 `questions`·지시문 변형이 필요 없어지지만 사진 비용·시간이 두 배다.
3. **연습 채점 자동화** — 열림. 기본: 버튼(§0-2 비용 원칙). 연습은 채점까지가 한 흐름이라 끝나면 자동으로 채점하는 선택지도 있다(문항당 T 1 + D 1).
4. **공략 세트의 발화 포인트(빈칸 모드)** — 열림. 기본: 만들지 않는다(§12-6). (2026-10-02 — 대상이 사라졌다: 유형 폴더의 표현 시험을 닫았고, 틀의 빈칸은 ③ 틀 시험 `tpl-cloze`가 맡는다. 다시 열 일이 없으면 다음 정리 때 닫는다.)
5. **연습 삭제·정리** — 열림. 기본: 화면에 두지 않는다(자동 정리는 가족 기록을 되돌릴 수 없게 지운다).
6. **손으로 표시한 줄(✎) 표시** — 열림. 기본: 작은 표시만. "표시한 줄만 듣기" 같은 기능은 두지 않는다. 손 표시는 Q3–4에만 있고 표 행의 대부분에 걸려 있어 필터로는 잘 갈리지 않는다. 표현·말하기 60개 상한을 넘을 때 고르는 순서에만 쓴다(§12-2-1).
7. **연습 채점을 문항별로** — 열림. 기본: 지금처럼 "AI 채점 받기"가 녹음된 문항을 한 번에 채점한다(Q5–7·Q8–10은 3문항 — 비용 3배). 결과 화면은 실전과 공용이고, 문항별 버튼은 실패한 문항의 "↻ 다시 채점"에만 있다. 문항마다 "이 문항만 채점"을 두는 것은 실사용 뒤에 정한다.
8. **"영어만"에 따라 말할 틈** — **닫힘(2026-09-27 업그레이드)**. 옛 기본값 "두지 않는다"를 뒤집었다 — 공용 `speakQueue`에 조각 뒤 쉼(`pauseAfterMs`)을 더하고(칸이 없으면 기존 경로 그대로), 템플릿 따라 말하기와 공략 읽기 "영어만"(토글, **기본 끔** — §12-4 검토 반영. 이 줄의 옛 "기본 켬"은 2026-09-28 코드 기준으로 고쳤다 — 구현·§12-4·§12-10·§12-11 T10이 모두 끔이다)이 같은 쉼 함수를 쓴다(§12-4·§12-5-2). 근거: 틈은 따라 말하기 방법의 본체이고, 칸 하나를 더하는 하위 호환 변경이라 `eval:speech` 전체와 네 과목 오프라인으로 회귀를 잠근다. 표현집 전체 듣기(§6-3)는 13으로 따로 남긴다.
9. **연습 준비 화면의 "공략 틀 보기"** — **닫힘(부분)**. 응시 화면(준비 45초) 안에는 두지 않는다(실전 조건·공용 화면). 대신 ④ 탭의 "시작" 전 자리에 접힌 "🧩 이 유형 답변 흐름"(단계마다 틀 하나)을 둔다(§12-7-9). 시작 전에 보는 것은 자료를 보고 시험장에 들어가는 것과 같다.
10. **탭 기억·폴더 진도** — **닫힘(부분)**. 탭은 주소(`?tab=`)로만 기억하고, `?tab`이 없으면 틀이 있는 유형은 ② 템플릿 훈련을 연다(§12-8). 폴더 카드에 "틀 n · 익힘 m"을 더했다 — 틀 세션은 `setId`가 하나라 폴더 목록이 한 번만 읽으면 된다(§12-5-6). "표현 졸업 n/m"은 여전히 뒤로 미룬다(폴더 목록이 네 공략 세트의 시험 세션을 모두 읽어야 한다). (2026-10-02 — "표현 졸업"은 대상이 사라졌다: 유형 폴더의 표현 시험을 닫았다. 폴더 카드의 진도는 "틀 n · 익힘 m" 하나다.)
11. **따라 말하기를 스트릭에 셀지** — 열림. 기본: 세지 않는다(§12-9 — 듣기와 같고, 기록이 남지 않아 확인할 수 없다). 세려면 따라 말하기 완료를 기록하는 저장 경로가 새로 필요하다. 검토 반영으로 따라 말하기가 잠금 화면·주머니에서 이어지면(§12-5-2) 출퇴근 듣기가 주된 쓰임이 되고, 따라 말하기만 한 날은 스트릭에 잡히지 않는다 — 동기가 약해질 수 있다. 붙인다면 큐의 `onEnd("done")` 때 "틀 n개 끝까지 들음"을 남기는 길이다(올릴 때 이 쓰임을 함께 적는다).
12. **테스트 두 모드의 숙련도를 합칠지** — 열림. 기본: 따로 센다(§6-2 모드 분리 — §12-5-6). 폴더 카드의 "익힘"은 더 어려운 틀 바꿔 말하기로 센다.
13. **표현집 전체 듣기(§6-3) "영어만"에도 따라 말할 틈** — 열림. 기본: 이번에는 붙이지 않는다(이미 배포된 기능이라 따로 바꾼다). `speakQueue` 쉼이 생겼으므로 그 화면 대본에 칸만 실으면 된다.
14. **내 녹음 보관** — 열림. 기본: 템플릿 테스트의 녹음은 그 세션 동안 기기 메모리에만 두고 끝나면 버린다(서버·IndexedDB에 두지 않는다 — 응시 녹음과 달리 다시 채점할 일이 없다). 지난 판의 내 목소리를 다시 듣고 싶다는 요구가 생기면 정한다.
15. **자동 ○/✕ 제안의 기준** — 열림. 기본: 틀 정확도 0.85 이상이고 모든 자리가 채워지면 ○ 제안(§12-5-5). 최종은 아빠가 정하므로 실사용에서 제안과 최종이 자주 어긋나면 기준을 고친다(제안·최종이 어긋난 수를 세션 끝 화면에 보인다).
16. **틀·예문의 양** — 열림. 기본: 원본 기준 폴더당 37~60틀(공통 틀 포함 — 검토 반영 뒤 152틀), 틀마다 예문 4~5개·테스트 전용 채움 2묶음. 묶음은 폴더마다 틀 6개 이하(zod)라 따라 말하기 한 묶음이 약 3~20분이다(§12-2-7 실측 — 옛 "10분 안팎" 가정은 실제와 맞지 않았다). 폴더 전체를 영어 4번으로 들으면 약 2~3.2시간이다. 너무 많으면 틀을 줄이고 예문을 늘리는 쪽이 "틀 반복"에 맞다.
17. **"🧩 틀 점검"을 실전 모의고사 결과에도** — **닫힘(2026-10-02, 사용자 확정)**. 붙인다 — Q3–11 문항마다 닫힌 접기 "🧩 틀 점검 · 쓴 틀 n(· 빠진 단계 m)"로(§12-13-3). 옛 기본값의 두 근거가 풀렸다 — 모의고사도 답변 흐름을 받아 모범답변이 틀을 쓰고(1 닫힘), 길이 문제는 문항마다 접어서 푼다.
18. **서버 쪽 전사 상한** — 열림. 기본: 전사 라우트에는 세션 상태가 없고 상한은 화면이 지킨다(§12-5-4 — 가족 전용 PIN 게이트가 바깥 울타리). 비용이 튀는 신호가 보이면 서버에 하루 상한(스토어 카운터)을 둔다.
19. **폴더를 열면 템플릿 훈련 탭부터** — 열림. 기본: 틀이 있는 유형은 ② 탭(§12-8). 읽기부터 보고 싶다는 피드백이 오면 되돌린다(주소 `?tab=read`는 그대로 된다).

20. **소재 묶음과 연습 주제 잇기** — 열림. 기본: 잇지 않는다. 검토는 소재 묶음마다 주제 태그를 두고 `pickTemplatesForDrill`이 연습 주제 힌트에 맞는 소재 묶음 틀 하나를 넣자고 했다. 연습 주제 풀(`TOEIC_DRILL_TOPIC_POOL`)은 코드 상수이고 소재 묶음은 원본이라, 둘을 잇는 태그 표를 두면 두 곳이 어긋난다(주제 풀을 고칠 때 원본도 고쳐야 한다). 지금은 단계마다 하나를 넣고 남은 칸을 약한 순으로 채우면 소재 묶음 틀도 올라온다(§12-7-9). 모범답변이 소재와 동떨어진 틀을 권하는 일이 잦으면 연다.
21. **③ "교재 문장 말하기"에도 받아쓰기 비교** — 열림. 기본: 지금처럼 자기 채점(전사 0). ② 틀 테스트와 이름으로 갈랐다(§12-6). `compareTemplateAnswer`에 자리 0개 틀처럼 넘기면 붙일 수 있지만, 문항당 전사 비용이 표현 시험에도 생긴다. (2026-10-02 — 대상이 사라졌다: 교재 문장 말하기를 화면에서 뺀다 — 28. 말하기 시험은 ② 🧩 틀 테스트 하나다.)
22. **말이 끝나면 저절로 녹음 멈추기** — 열림. 기본: 두지 않는다("다 말했어요" 탭 또는 20초). 검토는 말한 뒤 1.2초 조용하면 멈추는 선택지를 권했다. 응시 화면의 레벨 미터가 있어 만들 수는 있다. 하지만 출퇴근길 소음에서는 조용함 판정이 흔들리고, 말 가운데 멈칫한 것을 끝으로 보면 녹음이 잘린다(잘린 녹음은 그 문항을 처음부터 다시 한다). 실기기에서 탭이 번거롭다는 피드백이 오면 기본 끔인 선택지로 연다.
23. **잠금 화면 재생 (가)가 실기기에서 안 되면** — 열림. 기본: (가) 무음 조각 쉼·준비·Media Session(§12-5-2). 실기기 확인(SPEC §20-10 실기기 4)에서 화면이 잠긴 뒤 다음 조각이 이어지지 않으면 (나)로 간다 — "화면 켠 채로 들어요"를 플레이어와 SPEC에 적고, **주머니 모드**(검은 전면 화면, 길게 눌러야 풀린다 — 켜진 화면이 주머니에서 눌리지 않게)를 둔다. 무음 조각 쉼은 (나)에서도 해가 없으므로 남긴다.
24. **테스트 전용 채움의 양** — 열림. 기본: 틀마다 2묶음(zod 1~3). 틀 바꿔 말하기에서 졸업(다른 날 두 번 ○)까지 서로 다른 두 문장이 나오고, 세 번째 시도부터 같은 문장이 되풀이된다. 되풀이가 외우기로 흐르면 원본에 셋째 묶음을 더한다(코드 변경 없음).

2026-10-02 템플릿 중심 재정렬(§12-13)에서 더한 것:

25. **모범답변의 틀 조립을 강제할지(재요청)** — 열림. 기본: **강제하지 않는다 — 측정만**(§12-13-3). 프롬프트가 "단계마다 틀 그대로"를 시키고, 결과는 `checkAnswerAgainstFlow`로 재서 화면("🧩 모범답변의 틀 n개 · 단계 a/b")과 실호출 점검에 보인다. zod로 거부하면 1회 재요청 뒤에도 미달일 때 그 파트(연습이면 연습 전체)가 실패하고, 재요청은 비용이 최대 두 배다. 실호출 점검·실사용에서 단계 커버리지가 낮으면 먼저 프롬프트를 고치고(prompt-tuner), 그래도 낮으면 "미달이면 한 번만 다시 만들고 더 나은 쪽을 쓴다"(실패 없음, 미달일 때만 +1회)를 올린다. (2026-10-02 검토 반영) 채우지 않은 틀 자리(`~`·`{`·`}`가 남은 답)는 이 결정과 다른 종류 — 말할 수 없는 깨진 출력 — 라 zod가 거부한다(§4-9·§5-3). 화면은 미달이면 경고한다(`isWeakFlowCheck` — §12-13-3).
26. **③ 빈칸 답하는 방식** — 열림. 기본: 낱말 5지선다(한 손·탭만 — 출퇴근길). 직접 쓰기(낱말 하나 입력 → `sameTemplateWord`로 채점)가 기억에서 꺼내는 연습으로는 더 강하지만 폰 자판·자동 수정이 방해한다. 5지선다의 알려진 틈: 다른 틀 고정 낱말에서 고른 오답이 그 자리에 실제로도 들어맞을 수 있다(§12-13-2 — 은행 안 다른 틀이 되는 보기만 거른다).
27. **③ 이름** — 열림(**사용자 확인 대상** — 검토 반영으로 올렸다). 기본: 탭 "👀 틀 시험"(사용자 표현 그대로). ② "🧩 틀 테스트"(말하기)와 낱말이 비슷하다 — 학습 경험 검토는 "시험"·"테스트"가 한국어로 동의어라 탭과 버튼이 같은 이름처럼 읽힌다며 지금 "👀 틀 고르기"로 바꾸자고 했다(사용자 문구 "틀 시험으로 교체"는 무엇으로 바꿀지를 말한 것이지 라벨 지정이 아니라는 근거). 사용자가 쓴 낱말을 이 스펙이 혼자 바꾸지 않으므로 기본값은 그대로 두고 사용자에게 묻는다. 바꾸는 비용은 상수 하나(`TOEIC_GUIDE_TAB_LABELS_KO.quiz`)와 화면 문구다(주소 `?tab=quiz`는 그대로).
28. **공략 "교재 문장 말하기"(`speak`)도 화면에서 뺄지** — 열림(사용자 확인 대상). 기본: **뺀다**. 사용자 지시는 "유형 폴더의 교재 표현 목록 시험은 없앤다"이고, 교재 문장 말하기는 같은 ③ 탭의 다른 버튼이었다. 뺀 근거: 말하기 시험은 ② 🧩 틀 테스트(받아쓰기 비교 포함)가 틀 단위로 맡고, 교재 문장은 틀이 아니라 "틀대로 망설임 없이"라는 목표와 겹치지 않는다. 기록·가져오기 형식(`speak`)은 그대로라 되살리는 비용은 작다(버튼 하나·리다이렉트 하나). 2026-10-02 학습 경험 검토는 "교재 문장은 틀이 아니어서 목표와 겹치지 않고 말하기는 ②가 틀 단위로(받아쓰기 비교 포함) 맡는다 — 반대 근거 없음"이라 닫자고 했다. 사용자 지시 범위("표현 목록 시험")를 넘는 결정이라 확인 대상으로 남긴다.
29. **이어 말하기 블록의 통째 접기** — **닫힘(2026-10-02 검토 반영 — 사용자 결정 ①에서 끌어냈다)**. 머리말이 같은 자리 다른 표현이고 대표 틀이 **자리로 끝나면 머리말 줄만** 접고, 조각 줄은 머리말 없이 교재 글자 그대로 남겨 보이고 읽는다("→ 🧩 {대표 틀}의 끝 자리에 넣어 말해 보세요" — §12-13-1 규칙 4). 대표 틀이 자리로 끝나지 않으면 지금처럼 블록 통째. 근거: 사용자 결정은 "같은 자리의 **다른 표현만** 접는다, 교재 내용은 그대로"이고, 조각(1~6낱말 채움 구)은 대안이 아니라 남긴 틀의 끝 자리에 그대로 들어가는 재료다 — 통째로 접으면 Q3–4 11줄·Q5–7 15줄의 채움 재료가 듣기에서 사라진다(2026-10-02 원본, 개수만). 옛 걱정("교재 글을 바꾸지 않는 원칙과 부딪힌다")은 머리말을 **바꿔 붙이지 않고 떼기만** 하면 생기지 않는다.
30. **연습 흐름에 약한 틀 표시** — 열림. 기본: 표시하지 않는다 — 단계 안의 틀 순서만 약한 틀을 앞에 둔다(모델은 앞쪽의 맞는 틀을 먼저 고르기 쉽다. 강제는 아니다). "★ 연습할 틀" 같은 표시를 넣으면 프롬프트에 규칙이 하나 더 생기고 모범답변이 장면보다 표시를 따라 어색해질 수 있다.
31. **답변 흐름에 소재 틀을 넣을지·상한** — 열림. 기본: 넣는다(마지막 줄 "소재 틀"), 흐름 전체 60틀 상한(넘으면 소재 틀부터 자른다). 2026-10-02 원본 기준 파트당 21~39틀이라 상한에 닿지 않는다. 소재 틀이 모범답변을 억지스럽게 만든다는 피드백이 오면 소재 틀을 빼거나 주제 힌트로 고른 일부만 넣는다(20과 같은 이유로 지금은 잇지 않는다).
32. **③ 틀 시험 오답을 ② "틀린 틀만 따라 말하기"에 넣을지** — 열림. 기본: 넣지 않는다(② 범위는 말하기 두 모드만 — §12-5-6). ③에서 틀린 틀은 ③의 "틀린 틀" 목록에서 카드로 가서 카드 ▶로 따라 말한다. 고르기와 말하기는 다른 힘이라 섞으면 ②의 "틀린 틀" 수가 부푼다.
33. **템플릿 줄(label 연결)의 대안 줄** — 열림. 기본: 접지 않는다. 템플릿 줄 연결은 단계 label 단위라 같은 label의 줄 중 어느 것이 외울 틀인지 기계로 가릴 수 없다(템플릿 줄은 슬래시 대안·조건 메모가 섞여 첫 고정 조각이 틀에 없는 경우가 있다 — §12-10 틀 점검 알림). 대신 그 줄 아래에 연결된 틀 줄을 보여 외울 글자를 알린다(§12-13-1). 원본이 template 종류 건너뜀(`coveredBy` 있음)을 쓰면 그 label 줄은 접힌다.

2026-10-02 적대 검토(코드·학습 경험)를 반영하며 더한 것:

34. **① 끝 "📘 교재 표현 목록"(읽기 전용)** — 열림(**사용자 확인 대상**). 기본: **둔다**(§12-13-1). 사용자 지시는 "유형 폴더의 교재 표현 목록 **시험**은 없앤다"였고, 처음 안은 시험과 함께 목록 컴포넌트까지 지웠다. 코드 검토가 ① 본문 줄에 없는 교재 표현이 유형별 8·3·6·6개이고 그 뜻·교재 예문은 옛 ③ 목록에서만 보였다고 쟀다 — 지우면 교재 내용이 화면에서 사라져 "교재 내용은 그대로"와 어긋난다. 그래서 시험 없이 읽기 전용 접기로 ① 끝에 남긴다(듣기 대본·프리페치에는 넣지 않는다). 필요 없다고 하면 접기 하나를 빼면 된다(기록·가져오기 형식과 무관).
35. **호출 D가 쓰는 흐름 — 저장한 흐름 vs 채점 시점의 틀 은행** — 열림. 기본: **저장한 흐름**(§12-13-3 — 모범답변과 같은 흐름, 재현성). 알려진 틈: 만들기와 채점 사이에 틀 은행이 바뀌면(정리·다시 가져오기) 개선 답변이 지금은 외우지 않는 틀을 쓸 수 있고, 틀 점검의 피드백 권장 틀이 지금 은행에서 되짚히지 않아 조용히 빠진다. 틀 은행을 바꾸는 일이 드물고(사용자가 직접 다시 가져올 때뿐), 바꾸려면 채점 라우트가 틀 은행을 읽고 쓴 흐름을 응시 기록에 따로 남겨야 한다. 실사용에서 "피드백이 옛 틀을 권한다"가 보이면 연다(최소안: 되짚지 못한 권장 틀을 "옛 틀" 표시로 남기기).
36. **③ 오답 → ② 따라 말하기 다리** — 열림. 기본: 두지 않는다 — 끝 화면의 틀린 틀은 틀마다 "🧩 카드로"(카드 ▶로 따라 말한다). 학습 경험 검토는 끝 화면에 "틀린 틀 따라 말하기"(범위만 key 목록으로 넘기고 ②의 "틀린 틀" 수에는 넣지 않는다 — 32의 통계 분리 유지)를 권했다. ② 따라 말하기 바에 "고른 틀들" 범위를 새로 두어야 해서(주소로 key 목록 — 앱 key라 교재 글은 없다) 이번 개정(①③④ 정렬) 밖으로 미룬다.
37. **① 끝 "🧩 교재 밖 외울 틀" 접기** — 열림. 기본: 두지 않는다 — 대신 ① 머리 줄이 "외울 틀 n개 · 이 읽기에 나온 것 m개 — 나머지는 🧩 템플릿 훈련에서"로 알린다(§12-13-1). 학습 경험 검토는 ① 끝에 ① 본문에 이어지지 않은 틀(유형별 2·26·18·21개 — 2026-10-02 구현 기준 정정, 아래 §12-13-1)을 흐름 순서로 모은 접기(틀 줄 + 탭 🔊)도 권했다. ② 탭과 같은 내용이 두 곳에 생기므로 머리 줄의 반응을 보고 정한다.
38. **데이터 정합 — 사용자 판단**(코드 아님, 원본 `data/private/toeic-strategy/` 쪽) — 열림. 학습 경험 검토가 정리 리포트(`_workspace/data_toeic_template_dedupe_report.md` §7-3)의 두 가지를 다시 짚었다: ① 남긴 틀 둘의 `useKo`가 아직 "같은 자리 다른 문구"를 권한다(② 카드·② 테스트 단서에 보인다) ② Q11 대안 하나의 `coveredBy`가 그 묶음에서 남긴 틀과 다른 틀을 가리킨다 — ① 접기의 "외울 틀: …" 가리킴이 아빠가 그 자리에서 실제로 외우는 틀인지 확인이 필요하다. 원본을 고치면 같은 파일 다시 가져오기로 들어간다(코드 변경 없음).

### 12-13. 템플릿 중심 재정렬 (2026-10-02)

> 제품 수준의 흐름·비용·실기기 확인은 SPEC §20-10. 이 절은 **① 읽기 정렬 · ③ 틀 시험 · ④ 답변 흐름 조립**의 단일 정의처다. 이 절의 예시 문장·틀은 전부 지어낸 것이다(§12 머리 원칙 — 교재 글·강의 자막을 옮기지 않는다). 틀 글자는 런타임에 틀 은행 문서에서 읽어 넘긴다 — 프롬프트 상수에 틀을 박지 않는다.

사용자 요구(2026-10-02, 원문): "템플릿 훈련 뿐만 아니라 공략읽기 쪽도 템플릿훈련과 맞춰줘. 표현연습과 한문제연습, 모의고사도 템플릿 훈련 기반으로 수정해줘. (한문제연습과 모의고사는 가능한 템플릿 기반으로 답변하도록 해줘)". 목표: **시험장에서 1초의 망설임도 없이 연습한 틀대로 말한다.** 같은 날 틀 은행을 같은 자리 중복 정리했다(152 → 108틀 — §12-2-7 끝 표). 이제 폴더의 네 기능이 그 틀 은행 하나를 중심으로 돈다.

#### 12-13-0. 결정

| 항목 | 결정 | 출처 | 근거 |
|---|---|---|---|
| 틀 은행 | 같은 자리에 바꿔 넣을 수 있는 틀은 앱 순서 맨 위 하나만 남긴다(108틀). 지운 틀이 잇던 교재 대상은 `coveredBy`가 있는 건너뜀이 된다 | 사용자 확정(데이터 작업 완료) | 자리마다 외울 것이 하나여야 망설이지 않는다 |
| ① 공략 읽기 | **외울 틀 강조 + 대안 접기** — 교재 내용은 그대로 두고, 남긴 틀과 이어진 줄은 "🧩 외울 틀"로 강조한다. 같은 자리의 다른 표현은 "같은 자리 다른 표현"으로 접고 읽기·듣기(대본·프리페치)에서 뺀다. 접는 범위는 **같은 자리 다른 표현 글자만**이다(검토 반영) — 외울 틀 줄 안의 슬래시 대안 중 지운 대안은 듣기에서 빼고, 이어 말하기의 채움 조각은 머리말이 대안이어도 남긴다(§12-13-1 규칙 1·4) | 사용자 확정 | 교재를 고치지 않으면서 무엇을 외울지가 보이게 |
| 같은 자리 다른 표현의 판정 | `alignmentSkips[].coveredBy`가 있는 건너뜀 = 같은 자리 다른 표현. 가져오기 형식은 그대로이고, 틀 은행 문서에 `alternates`로 저장한다 | 기본값(§12-13-1) | 정렬 규칙 5가 이미 대안(①②)에는 대표 틀을, 틀이 아닌 것(③)에는 null을 요구한다. 2026-10-02 원본 55건이 모두 `coveredBy`를 가진다. 새 칸을 만들면 같은 사실이 두 곳에 산다 |
| ③ 표현 연습 | **틀 시험으로 교체** — 한국어 틀 → 영어 틀 5지선다, 영어 틀 → 뜻 5지선다, 틀 고정 낱말 빈칸. ② 틀 테스트(말하기)를 보완하는 "보는 눈·손" 연습 | 사용자 확정 | 표현 목록은 같은 자리 대안이 섞인 교재 목록이다. 시험 단위를 외울 틀로 맞춘다 |
| 유형 폴더의 교재 표현 시험 | 없앤다 — 화면 경로를 닫고 기록은 지우지 않는다(화면에서만 안 보인다). 표현집 세트의 표현 시험은 그대로. 시험이 아닌 **표현 목록 자체**(교재 표현·뜻·예문)는 ① 끝의 읽기 전용 접기 "📘 교재 표현 목록"으로 옮긴다(검토 반영 — §12-13-1) | 사용자 확정(목록 자리는 기본값 — §12-12 34) | 기록을 지우면 스트릭 과거가 사라진다. 목록을 지우면 ① 본문에 없는 교재 표현의 뜻·예문이 어디에도 안 보인다("교재 내용은 그대로") |
| ③의 "교재 문장 말하기" | 함께 화면에서 뺀다 | 기본값 — §12-12 28(사용자 확인 대상) | 말하기 시험은 ② 🧩 틀 테스트가 틀 단위로 맡는다 |
| ④ 한 문제 연습 + 실전 모의고사 | **답변 흐름 단계마다 틀로 조립** — 모범답변을 그 유형 답변 흐름 순서로, 단계마다 그 단계의 틀(자리마다 하나)을 그대로 쓰고 자리만 채운다. 틀이 없는 자리만 자유 문장. 모의고사에도 넣는다(§12-12 1 닫음). "🧩 틀 점검"을 모의고사에도(§12-12 17 닫음). AI 피드백(호출 D)도 개선 답변·고칠 점을 틀로 | 사용자 확정 | 모범답변이 외운 틀과 다른 문장이면 시험장에서 꺼낼 문장이 두 벌이 된다 |
| 프롬프트 | 원문 셋(§4-7·§5-1·§5-2)을 바꾸고 새 원문 하나(§4-1 둘째 블록 `TOEIC_MOCK_FLOW_RULES` — 흐름을 받은 파트만 **과제 절 뒤에** 붙인다)를 더한다. §4-1 머리말·과제 절 다섯·JSON Schema 8·호출 옵션·관문 P 접미사는 그대로. zod는 채우지 않은 틀 자리만 새로 거부 | 기본값(§12-13-3) — 검토 반영으로 머리말 안 절을 떼어 냈다 | 입력 칸 하나와 그 칸을 읽는 규칙만 더한다. 흐름 규칙이 과제 절 뒤에 와야 과제 절의 따옴표 예시보다 앞선다는 것이 마지막 말이 되고, 흐름이 없으면 시스템 프롬프트가 바이트까지 옛것이다 |
| 모범답변 검증 | 재요청하지 않는다 — 순수 함수로 재서 보이고, 크게 덜 따랐으면 화면이 경고한다. 채우지 않은 틀 자리(`~`·`{`·`}`)만은 깨진 출력이라 zod가 거부한다(검토 반영) | 기본값 — §12-12 25 | 거부하면 파트가 통째로 실패할 수 있고 비용이 최대 두 배 |
| 비용 | 호출 수 변화 0 — 입력 길이만 는다 | 기본값(§12-13-4) | — |
| 옛 기록·문서 | 그대로 — 저장된 모의고사·연습·시험 기록은 바꾸지 않고, 새로 만든 것부터 적용 | 작업 지시 | 응시 기록이 가리키는 문항이 말없이 바뀌지 않게(§7-2) |

#### 12-13-1. ① 공략 읽기 — 외울 틀 강조 · 같은 자리 다른 표현 접기

**판정 자료 둘**

- **외울 틀** = 틀 은행의 어떤 틀이 `guideRefs`로 가리키는 교재 대상(표현·템플릿 줄 label·이어 말하기 머리말). 판정은 지금의 `templateLinksForGuide(bank, part)` 그대로다(§12-4 🧩 칩과 같은 표).
- **같은 자리 다른 표현** = 틀 은행 문서의 새 필드 `alternates`(§12-3 타입).
  - 가져오기가 만든다 — 파일의 `templates.alignmentSkips` 중 `coveredBy`가 있는 것을 파일 순서대로 `{part, kind, ref, coveredBy}`로 옮긴다(이유 글 `reasonKo`는 버린다). `coveredBy`가 null인 건너뜀(정렬 규칙 5 ③ — 틀로 쓰지 않는 표현)은 대안이 아니라서 옮기지 않는다.
  - 가져오기 형식·zod는 바뀌지 않는다(§12-2-7 끝 — `coveredBy`의 뜻만 확정했다). 지금 `data/private`의 가져오기 파일이 그대로 들어간다.
  - 내용 지문·바이트 상한은 `flows`·`items`·`alternates`를 함께 잰다(§12-2-5). 그래서 **배포 뒤 같은 파일을 한 번 다시 가져와야 접기 자료가 들어간다**(틀 은행 updated — 틀 key·틀 테스트 기록은 그대로). 그 전에는 `alternates`가 `[]`라 접기가 없고 지금 화면과 같다(화면이 다시 가져오기를 안내한다 — 아래 "화면").
  - **정규화**: 두 저장소가 쓰기 직전에 `normalizeToeicGuideDoc`를 거치고, 틀 은행 쪽은 `as unknown as` 캐스트라 `alternates`를 빠뜨려도 tsc가 잡지 못한다(검토 S3). 빠뜨리면 `alternates`만 지워지고 `contentHash`(alternates 포함)는 저장돼 같은 파일을 다시 넣어도 unchanged — 접기 자료가 **영영** 안 들어간다. 그래서 정규화가 `alternates`를 명시적으로 옮기고(배열이 아니면 `[]`, 모양이 깨진 항목만 버림), eval이 파일 저장소 왕복으로 잠근다(§12-13-5).
  - `templateAlternateLinks(bank, part)`(`lib/toeic-template.ts`, 순수) → `ToeicTemplateGuideLinks`와 **같은 모양**(템플릿 줄 label → key들, 머리말(공백 정리) → key들, 표현(`expressionKey`) → key들 — 값은 `coveredBy`). 키를 만드는 정규화가 `templateLinksForGuide`와 같아야 두 표를 같은 줄에 대 볼 수 있다.

**줄 표시 판정 — 순수 함수** `guideReadMarks(sections, links, alternateLinks, partTemplates)` → `ToeicGuideReadMarks`(`lib/toeic-guide-view.ts`, 클라이언트 안전). `partTemplates` = 그 유형 렌더 가능한 틀(`key`·`frameEn`만 — 규칙 4가 대표 틀의 끝을 본다).

```ts
interface ToeicGuideReadMarks {
  frameLines: Map<string, string[]>;  // 줄 주소 "s:b:l" 또는 "s:b:lead" → 외울 틀 key들(파일 순서)
  altLines: Map<string, string[]>;    // 줄 주소 → coveredBy key들(같은 자리 다른 표현 — 줄 단위 접기. bareBlocks의 머리말 줄도 여기)
  altBlocks: Map<string, string[]>;   // 블록 주소 "s:b" → coveredBy key들(블록 통째 접기)
  bareBlocks: Map<string, string[]>;  // 블록 주소 → coveredBy key들(이어 말하기 — 머리말 줄만 접고 조각은 머리말 없이 남긴다, 규칙 4)
  framePicks: Map<string, string>;    // 줄 주소 → 듣기에 쓸 영어(외울 틀 줄 중 슬래시 대안의 다른 쪽이 같은 자리 다른 표현인 줄만, 규칙 1)
}
```

판정 규칙(위에서부터 먼저 맞는 것):

1. **외울 틀이 이긴다** — 한 줄이 두 표에 다 걸리면 `frameLines`다(슬래시 대안 줄의 한 대안은 외울 틀, 다른 대안은 같은 자리 다른 표현인 경우). 이때 그 줄의 **듣기 글자**를 `framePicks`에 둔다(검토 반영 — 줄을 통째로 읽으면 `cleanGuideEnForTts`가 `/`를 `, `로 바꿔 지운 대안까지 소리로 난다): 줄 영어를 `expandSlashAlternatives`로 펼친 글자 중 `links.expressions`에 맞은 첫 글자. 펼친 글자 중 하나라도 `alternateLinks.expressions`에 맞을 때**만** 둔다 — `is/are` 같은 일치 변형만 있는 슬래시 줄(대안이 어느 쪽도 `alternates`에 걸리지 않는다)은 지금처럼 줄 전체를 읽는다. 화면 글자는 교재 그대로이고, 줄 아래 틀 줄이 외울 글자를 보인다(2026-10-02 원본: 외울 틀 줄 중 슬래시 줄 6, 그중 `framePicks` 대상 1 — 개수만).
2. `list` 블록의 머리말·줄과 `text` 블록의 줄: 영어(`en`)의 `~` 모양(`guideLineTemplateKeys`와 같은 규칙 — `{…}` → `~`·공백 접기·끝 마침표 하나 떼기, 슬래시 대안은 펼친 것 중 하나)의 표현 키가 `links.expressions`에 있으면 외울 틀, 아니면 `alternateLinks.expressions`에 있으면 같은 자리 다른 표현.
3. `template` 블록의 줄: `label`(trim)이 `links.templateLabels`에 있으면 그 label의 줄 전부가 외울 틀, 아니면 `alternateLinks.templateLabels`에 있으면 그 줄들이 같은 자리 다른 표현.
4. `completions` 블록: 머리말 영어(공백 정리)가 `links.leads`에 있으면 머리말 줄(`"s:b:lead"`)이 외울 틀. 아니면 `alternateLinks.leads`에 있으면 대표 틀(`coveredBy` 첫 key)을 본다(검토 반영 — §12-12 29를 닫았다):
   - 대표 틀이 `partTemplates`에 있고 **끝이 자리**면(`frameEndsWithSlot(frameEn)` — 끝의 공백·`.`·`?`·`!`·따옴표를 떼면 `}`로 끝난다, `lib/toeic-template.ts`) **머리말 줄만** 접는다 — 머리말 줄 주소를 `altLines`에, 블록 주소를 `bareBlocks`에 둔다. 조각 줄은 접지 않는다. 조각은 1~6낱말짜리 채움 구라 남긴 틀의 끝 자리에 그대로 들어가는 재료이지 같은 자리의 다른 표현이 아니다("1초"는 틀만으로 안 되고 자리를 바로 채울 낱말이 있어야 한다). 2026-10-02 원본에서 이런 블록은 Q3–4 2개(조각 11줄)·Q5–7 5개(조각 15줄)이고 대표 틀 7개가 모두 끝이 자리다(개수만).
   - 그 밖(대표 틀이 렌더 불가·다른 유형·끝이 자리가 아님)이면 **블록 통째**가 같은 자리 다른 표현이다(조각이 그 머리말 문장의 가운데 일부라 떼면 뜻이 없다).
5. `list` 블록의 머리말이 같은 자리 다른 표현이면 블록 통째로 올린다(줄은 그 머리말 틀의 예다).
6. 한 블록의 판정 대상 줄(머리말 포함)이 모두 같은 자리 다른 표현이면 블록 통째로 올린다(접기 하나로 묶는다). `bareBlocks`의 조각 줄은 대안이 아니므로 이 규칙에 걸리지 않는다.
7. `heading`, `text`의 제목·본문, 캡션은 판정하지 않는다(교재 설명·팁은 그대로 — 연결이 없다).

**대본·소리**

- `buildToeicGuideScript(guide, mode, { pause, pauseLevel, skip })` — 새 선택 칸 `skip`(함수 입력이라 선택 칸이다 — 저장 레코드의 "선택 키 금지"와 무관). **`skip`이 없으면 지금과 글자까지 같은 대본**이다(eval).

```ts
interface ToeicGuideScriptSkip {
  blocks: ReadonlySet<string>;          // 블록 주소 — 그 블록의 조각 전부(캡션·머리말·줄)를 내지 않는다(altBlocks)
  lines: ReadonlySet<string>;           // 줄 주소 — 그 줄의 조각을 내지 않는다(altLines — bareBlocks의 머리말 줄 포함)
  bareLeads: ReadonlySet<string>;       // 블록 주소 — 이어 말하기 줄의 읽을 영어를 머리말 없이 줄 en 그대로(guideLineEn 대신)
  picks: ReadonlyMap<string, string>;   // 줄 주소 → 그 줄 영어 대신 읽을 글자(framePicks — 정리 함수·쪼개기는 그대로 거친다)
}
```

- 화면은 `skip = { blocks: altBlocks의 키, lines: altLines의 키, bareLeads: bareBlocks의 키, picks: framePicks }`로 부른다. 섹션 ▶·"▶ 처음부터"·진행 `{i+1} / {n}`·프리페치(`toeicGuidePrefetchTexts`)·**접히지 않은 줄의 🔊**·`text` 블록 🔊(`toeicGuideBlockPieces` — 검토 S13)가 모두 이 대본을 쓴다 — 접은 것은 듣지도 미리 받지도 않고, `framePicks` 줄은 외울 틀 쪽 대안만, `bareBlocks`의 조각은 머리말 없이 조각만 읽는다(지운 대안 머리말 글자가 소리로 나지 않는다).
- **접기 안의 줄 🔊**는 `skip` 없는 대본에서 그 줄 주소로 거른 조각(`toeicGuideLinePieces(fullScript, …)`)을 탭할 때만 재생한다. 미리 받지 않는다(안 들을 가능성이 높다 — §18-5 비용 가드). 정리 함수가 같으므로 캐시 키 규칙(§12-4)은 그대로다.
  - 예외 — `bareBlocks`의 접힌 머리말: 이어 말하기 머리말 영어는 원래 대본에서 줄마다 합성 문장 안에만 있어(따로 읽지 않는다 — §12-4) 그 주소의 조각이 영어로는 없다. 그래서 `toeicGuideLeadPieces(block, s, b, mode)`(`lib/toeic-guide.ts`, 순수 — `lead.en` 한 조각 en-US + "전부"면 `lead.ko` 한 조각 ko-KR, 같은 정리 함수·쪼개기)를 탭할 때만 재생한다.
- 대본 내용 키(정지 조건)는 `skip` 적용 대본의 `lang|text`다 — 다시 가져오기로 접기가 바뀌면 재생을 멈춘다.

**화면**(`components/toeic-guide-read-view.tsx`)

- **머리 두 줄**(검토 반영 — 틀 은행이 있을 때만)
  - "🧩 이 유형 외울 틀 n개 · 이 읽기에 나온 것 m개 — 나머지는 🧩 템플릿 훈련에서"(누르면 ② 탭). n = 그 유형 렌더 가능한 틀 수, m = `guideReadFrameKeys(marks)`(`frameLines` 값의 합집합 — 템플릿 label·머리말 연결 포함) 크기. 2026-10-02 원본에서 ① 본문 줄에 이어지지 않는 틀이 유형별로 2·26·18·21개라(n·m = 21·19 / 39·13 / 27·9 / 39·18 — Q3–4·Q5–7·Q8–10·Q11, 구현·e2e 실측), 읽기만 보고 "외울 것은 이것뿐"으로 읽히지 않게 한다. (2026-10-02 구현 기준 정정 — 처음 적은 "2·25·15·21"은 `guideRefs`로 이어진 틀 전부(19·14·12·18)로 센 값이었다. 차이는 본문 줄이 아니라 ① 끝 "📘 교재 표현 목록"에만 있는 표현에 이어진 틀이다. 화면 m은 위 정의(`frameLines` 합집합)대로다.)
  - 범례: "🧩 외울 틀 · 보통 줄 = 예·참고 · ↳ 접힘 = 같은 자리 다른 표현(안 외워도 돼요)".
  - `alternates`가 `[]`이면 범례 자리에 "접힌 '같은 자리 다른 표현'이 아직 없어요 — 공략 파일을 이번 업데이트 뒤 한 번 다시 가져오면 생겨요(📂)". 저장 문서가 다시 가져오기 전인지 파일에 대안이 정말 없는지는 정규화 뒤에 가를 수 없으므로 두 경우를 함께 말하는 문구다.
- **외울 틀 줄**: 줄 왼쪽 강조 띠(기존 CSS 변수만). 줄 아래에 그 틀의 **틀 줄**(`splitFrameForDisplay` — 고정 부분 굵게·자리 칩, ② 카드와 같은 조각 `components/toeic-template-lines.tsx`)을 보이고, "🧩 외울 틀" 칩(누르면 ② 탭의 그 틀 카드 — 여럿이면 첫 틀. 옛 줄 머리 "🧩" 칩 자리다. 구현은 한 줄에 외울 틀이 여럿이면 **틀마다 틀 줄 한 행**을 두어 칩마다 자기 카드로 간다 — §12-13-7)은 **틀 줄 머리**에 둔다(검토 반영 — 교재 줄이 틀의 조각뿐인 경우가 많아, 칩이 교재 줄에 붙으면 조각을 외울 글자로 읽는다). 틀 줄에는 **탭 🔊**(`cleanGuideEnForTts(frameEn)` en-US — ② 카드의 영어 틀 소개와 같은 글자라 캐시를 같이 쓴다, 미리 받지 않는다). 줄 영어의 `~` 모양 표현 키가 그 틀의 `frameToExpression` 표현 키와 같으면 틀 줄을 생략하고 칩을 교재 줄 머리에 둔다(같은 글이 두 번 보이지 않게).
- **템플릿 블록**(label 연결): 블록 머리 "🧩 템플릿 훈련 n" 칩은 그대로. 연결된 label의 줄마다 강조 띠를 두고, 그 label의 **첫 줄 아래**에 연결된 틀 줄 목록을 보인다(틀 줄마다 위와 같은 칩·탭 🔊) — 템플릿 줄에는 슬래시 대안·조건 메모가 섞여 있어(§12-10 틀 점검 알림) 외울 글자를 따로 보여야 한다. 같은 label의 대안 줄(`alt`)은 접지 않는다(§12-12 33).
- **이어 말하기 블록**(머리말 연결): 머리말에 강조 띠와 틀 줄(칩·탭 🔊). 조각 줄은 그대로.
- **이어 말하기 블록 — 머리말만 접힘**(`bareBlocks`): 머리말 자리에 닫힌 `<details>` "↳ 같은 자리 다른 표현 — 머리말"(열면 머리말 영어·한국어와 탭 🔊 — `toeicGuideLeadPieces`), 바로 아래 안내 줄 "→ 🧩 {대표 틀의 `~` 형태}의 끝 자리에 넣어 말해 보세요"(대표 틀 칩 → ② 카드), 그 아래 조각 줄을 **머리말 없이** 교재 글자 그대로(줄 🔊도 조각만). 교재 글을 바꿔 붙이지 않고 머리말을 떼기만 한다.
- **같은 자리 다른 표현**
  - 블록 통째: 블록 자리에 닫힌 `<details>` 하나. 요약은 "↳ 같은 자리 다른 표현" + 캡션(있으면) + "외울 틀: {대표 틀의 `~` 형태}"(대표 틀 = `coveredBy` 첫 key의 틀 — 누르면 ② 카드). 열면 블록이 지금 모양 그대로 보이고 줄 🔊는 탭으로만 난다.
  - 줄 단위: 한 블록 안의 접힌 줄들을 **블록 끝**의 닫힌 `<details>` 하나로 모은다 — 요약 "↳ 같은 자리 다른 표현 n줄". 줄마다 아래에 "→ 🧩 {대표 틀}". (`bareBlocks`의 머리말은 위처럼 머리말 자리에 둔다.)
  - 대표 틀이 렌더 불가이거나 그 유형 틀이 아니면 "외울 틀" 표시만 빼고 접기는 한다.
  - 섹션 재생은 접기를 열지 않는다(재생이 지나가지 않는다). 지금 읽는 줄 강조·스크롤 규칙(§12-4)은 그대로다.
- **① 끝 — "📘 교재 표현 목록"**(검토 반영 — 옛 ③ 탭의 표현 목록을 읽기 전용으로 옮긴다): 공략 세트의 교재 표현(`entries` — 표현·뜻·교재 예문)을 닫힌 `<details>` 하나에 둔다. 틀이 연결한 표현에는 "🧩 외울 틀" 칩(→ ② 카드), `alternateLinks.expressions`에 든 표현은 목록 끝의 안쪽 접기 "↳ 같은 자리 다른 표현 n"에 모으고 줄마다 "→ 🧩 {대표 틀}". 시험 버튼·오답노트·기록·`?expr=` 처리·말하기 상태는 없다. 🔊는 탭할 때만(표현 영어 trim만 — 옛 목록과 같은 캐시 키), 섹션 ▶·처음부터 대본에 들지 않고 미리 받지 않는다. 근거: ① 본문 줄에 없는 교재 표현이 유형별로 8·3·6·6개이고, 그 뜻·교재 예문은 옛 ③ 목록에서만 보였다 — 목록을 지우면 교재 내용이 화면에서 사라진다("교재 내용은 그대로"와 어긋남, 검토 S8). 컴포넌트는 `components/toeic-guide-expr-list.tsx`를 읽기 전용 모드로 줄여 쓴다(파일을 지우지 않는다 — 기존 eval이 이 파일을 읽는다, 검토 S1). 이 목록을 둘지는 사용자 확인 대상이다(§12-12 34).
- `label`·`note`·`marked`·섹션 목차 칩·`groupKo`·듣기 바·"영어만" 틈은 그대로다.
- **`?goto=k:{틀 key}`**(새 값 — §12-5-7 📘 칩의 표현 연결이 갈 곳): `findGuideGotoBlock(sections, goto, marks?)`가 그 key가 `frameLines`에 든 첫 줄(문서 순서)의 블록을, 없으면 그 key가 블록 머리 칩(`guideBlockTemplateKeys`)에 든 첫 블록을 돌려준다. `marks`는 **선택 인자**다(검토 S13) — 없으면 `k:`는 null이고 `t:`·`l:`은 지금과 같다(기존 호출·eval 그대로). `guideReadInitialOpen(sections, goto, marks?)`도 같은 함수를 거쳐 서버 첫 렌더부터 그 섹션을 연다(§12-4 QA final P2-1 규칙 그대로). 주소에는 앱이 만든 틀 key만 실린다(`t:`·`l:`과 달리 교재 글이 없다). `guideRefHref(ref, templateKey)`가 `expression` 연결에 이 값을 쓴다.
  - ② 탭의 "📘 교재 틀" 목록에서 `expression` 연결 줄은 ① 본문에 그 틀의 외울 틀 줄이 있을 때만 보인다 — 폴더 페이지(서버)가 `guideReadFrameKeys(guideReadMarks(…))`로 "① 본문에 줄이 있는 틀 key 집합"을 만들어 ② 탭에 넘긴다.
- **옛 상태**: 틀 은행이 없으면 강조·접기·머리 두 줄 모두 없다. 틀 은행이 있고 `alternates`가 `[]`(다시 가져오기 전)이면 강조만 있고 접기는 없다(머리에 다시 가져오기 안내).
- 비용: AI 0. 프리페치 조각이 접은 만큼 줄어든다. 틀 줄·교재 표현 목록의 🔊는 탭할 때만 합성한다.

#### 12-13-2. ③ 틀 시험 — 보고 고르기 · 빈칸

유형 폴더의 ③ 탭은 **"👀 틀 시험"**이다(탭 id `quiz` 그대로 — 주소 호환, 이름은 §12-12 27 — 사용자 표현 그대로이고, ② "🧩 틀 테스트"와 낱말이 비슷하다는 검토 의견이 있어 사용자 확인 대상으로 올렸다). 탭 머리 한 줄: "보고 고르고 빈칸을 채워요 — 소리 내어 말하는 시험은 🧩 틀 테스트". 시험 단위는 **틀**이고(그 유형 틀 — 틀 은행에서 `parts`로 고른 렌더 가능한 틀), 기록은 틀 은행 세션(`toeicQuizzes`, `setId = guide-templates`, 항목 키 `tpl:{key}`)이다.

**모드 셋** — `toeicQuizzes`의 `mode` 새 값(§12-3 타입 `ToeicTemplateChoiceMode`). ② 틀 테스트의 두 모드(`tpl-recall`·`tpl-swap`)와 **별개**다(§6-2 모드 분리 — 뜻을 고르는 힘·고정 낱말을 알아보는 힘·말로 꺼내는 힘은 다르다).

| mode | 화면 이름 | 문제 | 보기 | 정답 |
|---|---|---|---|---|
| `tpl-ko-frame` | 한→영 고르기 | 한국어 틀(`koFrameToTilde(frameKo)` — 자리는 `~`) + 작은 글씨로 묶음 이름 | 영어 틀 `~` 형태(`frameToExpression`) 2~5개 | 그 틀의 `~` 형태 |
| `tpl-frame-ko` | 영→뜻 고르기 | 영어 틀 `~` 형태 + 묶음 이름 | 한국어 틀 `~` 형태 2~5개 | 그 틀의 한국어 `~` 형태 |
| `tpl-cloze` | 빈칸 채우기 | 영어 틀(자리는 이름 칩 그대로)에서 고정 낱말 하나를 `_____`(`TOEIC_CLOZE_BLANK`)로 + 그 아래 한국어 틀 `~` 형태(뜻 단서) | 낱말 2~5개 | 가린 낱말 |

- **고르기 두 모드는 자리 이름을 `~`로 가린다.** 영어 틀과 한국어 틀은 자리 이름 모임이 같다(틀 zod) — 이름을 보이면 이름만 맞춰 정답을 고를 수 있다. `koFrameToTilde(frameKo)` = `{…}`마다 `~`, 공백 접기(`lib/toeic-template-quiz.ts`). 빈칸 모드는 자리 이름이 빈칸 낱말을 고르는 단서(지어낸 예: `{날짜}` 앞이면 `on`)라 이름을 보인다.
- 문제를 소리로 읽지 않는다(영어를 읽으면 정답이 샌다 — §6-1 소리 규칙). 답을 고르면 정답·오답 색을 보이고 **영어 틀을 en-US로 읽는다**(`cleanGuideEnForTts(frameEn)` — 자리는 "…", 탭 핸들러 안에서 동기로). 그 아래 그 틀의 예문 한 줄(`examples[t mod n]` — t는 그 모드 시도 수)과 🔊를 보인 뒤 "다음".

**문항 조립 — 순수 함수** `buildTemplateChoiceQuestions(scope, partTemplates, sessions, opts)` → `{ questions: ToeicTemplateChoiceQuestion[]; skipped: number }`(새 모듈 `lib/toeic-template-quiz.ts` — 클라이언트 안전, 번들 경계 목록에 등록)

```ts
interface ToeicTemplateChoiceQuestion {
  mode: ToeicTemplateChoiceMode;
  key: string;                          // 틀 key — 기록 항목 키는 templateItemKey(key)
  prompt: string;                       // ko-frame: 한국어 틀 ~ 형태 / frame-ko: 영어 틀 ~ 형태 / cloze: 한국어 틀 ~ 형태(뜻 단서)
  cloze: { before: string; after: string } | null;  // cloze만 — frameEn을 가린 낱말 앞·뒤로 자른 글(자리 {…}는 화면이 칩으로)
  groupKo: string;                      // 문제 아래 작은 글씨
  choices: string[];                    // 2~5개, 섞인 순서
  answer: string;                       // choices 안의 한 글자열
  frameEn: string;                      // 답한 뒤 틀 줄·🔊
  example: { en: string; ko: string } | null;  // 답한 뒤 한 줄
}
```

- 입력: `scope` = 범위의 틀(흐름 순서 — `templateFlowOrder`), `partTemplates` = 그 유형 렌더 가능한 틀 전부(오답 보기 풀 — 범위가 묶음 하나여도 보기는 유형 전체에서 고른다), `sessions` = 틀 은행 세션(startedAt 오름차순), `opts = { modes(기본 셋), onlyWrong?: ToeicTemplateChoiceMode, max(기본 TOEIC_TEMPLATE_CHOICE_MAX 20), rng }`. 상수 이름은 `…_CHOICE_MAX`다(검토 S12 — 기존 `TOEIC_TEMPLATE_QUIZ_MODES`는 ② 말하기 두 모드라, `QUIZ_MAX`로 두면 라우트 상한 갈래에서 "QUIZ_MODES ↔ QUIZ_MAX"로 바꿔 쓰기 쉽다).
- 후보: 범위의 틀. `onlyWrong`이면 그 모드의 틀린 틀만이고 모드도 그 하나다.
- (틀, 모드)마다 문항을 만들어 본다(못 만들면 `skipped` + 1). 순위는 **그 모드의** 통계로 `weaknessRank`(§12-5-3과 같은 함수 — 틀렸고 미졸업 → 안 해 봄 → 진행 중 → 졸업) → 오답 많은 순 → 무작위.
- **한 판에 한 틀 한 문항** — 틀마다 순위가 가장 앞선 모드 하나만 남긴다. 같은 틀이 두 모드로 나오면 한쪽 문제의 보기가 다른 쪽 정답을 보여 준다. 남은 문항을 같은 순위로 늘어놓아 앞에서 `max`개 → **모드별로 묶어**(한→영 → 영→뜻 → 빈칸 순) 묶음 안에서 한 번씩 섞는다(흐름 순서로 늘어놓으면 이웃 문항이 답을 흘린다 — ② 틀 테스트와 다르다). 모드를 묶는 까닭(검토 반영): 문항마다 모드가 바뀌면 매번 "무엇을 묻나"를 다시 읽느라 판정이 느려진다. 이웃 누설은 한 판 한 틀 규칙이 이미 막는다. 화면은 문항 머리에 모드 칩("한→영"·"영→뜻"·"빈칸")을 보인다.
- **오답 보기(고르기 두 모드)**: 층 순서로 후보를 늘어놓고(층 안은 rng로 섞는다) 앞에서 4개를 골라 `buildChoices`(`lib/vocab-quiz.ts` 그대로)에 넘긴다.
  - 층: ① 같은 묶음(`groupKo`) ② 같은 단계(그 유형 흐름의 같은 단계에 든 다른 묶음) ③ 그 유형의 나머지 틀.
  - **자리 수가 정답과 같은 후보를 층을 넘어 먼저** 둔다 — 자리 수가 같은 후보를 층 순서(①②③, 층 안은 rng)로 늘어놓고, 모자라면 자리 수가 다른 후보를 다시 층 순서로 채운다(검토 S6). 같은 묶음의 자리 수 다른 틀보다 다른 층의 자리 수 같은 틀이 앞선다(2026-10-02 구현 기준 정정 — 처음 적은 "층 안에서는"은 §12-13-5의 반례와 맞지 않았다. 구현 `layeredOthers`와 eval 반례가 이 뜻이다). 빈칸 모드의 낱말 보기에는 자리 수 우선이 없다. 자리 이름은 `~`로 가려도 `~` **개수**가 보여, 개수가 다른 보기는 읽지 않고 지울 수 있다(2026-10-02 원본: 같은 묶음 보기가 있는 틀 102개 중 61개가 묶음 안에 자리 수가 다른 틀을 둔다 — 개수만).
  - **극성 쌍은 서로 좋은 오답**이다 — 뜻이 갈리는 변형은 틀을 나눴고(정렬 규칙 2) 대개 같은 묶음이라 ① 층에서 먼저 나온다(지어낸 예: `The upside here is ~` ↔ `The downside here is ~`, `Toward the front, ~` ↔ `Toward the back, ~`).
  - **같은 뜻은 뺀다**: 한→영 고르기에서 정답과 한국어 틀 `~` 형태가 같은 틀(둘 다 정답이 된다 — 같은 자리 정리 뒤 0쌍이지만 방어), 영→뜻 고르기에서 정답과 한국어 `~` 형태가 같은 보기. 두 모드 모두 보기 글자는 `matchKey`로 중복을 접는다.
  - 거른 뒤 보기가 2개 미만(`TOEIC_CHOICE_MIN`)이면 출제하지 않는다(`skipped`).
- **빈칸 낱말 — 결정적** `templateClozeTarget(frameEn, attempts)` → `{ word, before, after } | null`
  - 고정 조각을 공백으로 나눠 낱말을 만든다. 낱말 앞뒤의 문장부호는 낱말에 넣지 않는다(빈칸 밖에 남는다 — 지어낸 예: `…set on {장소}.`에서 `on`을 가리면 `…set _____ {장소}.`).
  - 후보 = 라틴 글자가 있는 고정 낱말 중 관사(`a`·`an`·`the`)와 주어 대명사(`I`·`you`·`he`·`she`·`we`·`they`·`it`)를 뺀 것(대소문자 무시 — `TOEIC_TEMPLATE_CLOZE_SKIP_WORDS`). 축약형(`It's`)·전치사·be동사는 후보다 — 전치사 하나가 틀의 핵심인 경우가 많다. 또 **그 틀의 고정 부분에 한 번만 나오는 낱말**만 후보다(검토 S7 — 두 번 나오는 낱말을 한 자리만 가리면 다른 자리에 정답이 보인다. 2026-10-02 원본에 그런 틀 7개). 같은 낱말 판정은 원문 낱말을 `normalizeTemplateWords`로 편 뒤 `sameTemplateWord`로 한다(축약형·대소문자 — `sameTemplateWord`는 편 낱말끼리 쓰는 함수다). 후보가 없으면 관사만 뺀 고정 낱말(같은 한 번 규칙), 그래도 없으면 출제하지 않는다.
  - 가릴 낱말 = 후보[`t mod 후보 수`](t = 그 틀의 `tpl-cloze` 시도 수 — 같은 날 ○ 접기 전 원래 수, §12-5-3 `rawAttemptCounts`와 같은 정의). 판마다 다음 고정 낱말이 비어 시도를 거듭하면 틀 전체를 돈다.
- **빈칸 오답 보기**: 같은 층 순서(같은 묶음 → 같은 단계 → 나머지)의 다른 틀들에서 같은 규칙으로 뽑은 고정 낱말. 거르는 것은 셋이다 — 정답과 같은 낱말(`sameTemplateWord` — 축약형·대소문자), 이 틀의 고정 부분에 이미 있는 낱말, **그 낱말을 빈칸에 넣은 글이 은행 안 다른 틀의 `~` 형태와 같아지는 낱말**(그 보기도 맞는 틀이다). 오답 낱말 비교도 위와 같이 `normalizeTemplateWords`로 편 뒤 `sameTemplateWord`로 한다. 보기 글자는 빈칸 자리에 맞춰 대소문자를 맞춘다 — 빈칸 앞 글(`before`)이 비었거나 여는 따옴표뿐일 때만(틀이 자리로 시작하면 첫 고정 낱말은 문장 첫머리가 아니다 — 2026-10-02 원본에 자리로 시작하는 틀 25개, 검토 S7) 모두 첫 글자를 대문자로, 아니면 모두 소문자로(두 글자 이상 모두 대문자인 약어와 `I`는 그대로). 알려진 틈: 다른 틀의 고정 낱말이 이 자리에 실제로 들어맞는 뜻일 수 있다(§12-12 26).

**한 판(러너)** — 경로 `/toeic/guides/[part]/templates/quiz?modes={모드,…}&scope=all|step|group|wrong&i={번호}&wrong={mode}`(전면 화면, `components/toeic-template-quiz.tsx`). `i`는 `scope=step`이면 그 유형 흐름의 단계 번호(0부터), `scope=group`이면 `templateFlowOrder`의 묶음 번호(0부터)다 — **주소에 교재 단계·묶음 이름을 싣지 않는다**(검토 S13 — `k:` 도입 근거와 같다. ② 틀 테스트의 옛 주소 `step={stepKo}`·`group={groupKo}`는 이번에 바꾸지 않는다). 번호가 범위 밖이면 "유형 전체"로 읽는다.

- 서버 페이지(`app/toeic/guides/[part]/templates/quiz/page.tsx`, `force-dynamic`)가 틀 은행·틀 은행 세션을 읽어 `buildTemplateChoiceQuestions`로 **한 번 조립**하고 문항만 내린다(5지선다라 정답은 화면이 채점한다). `testFills`는 내리지 않는다. 그 유형 틀이 0이면 ② 빈 상태와 같은 문구 + 📂.
- 문항을 열 때 소리를 내지 않으므로 "시작" 탭이 따로 필요 없다 — 답을 고르는 탭이 소리를 시작한다.
- 프리페치: 페이지가 열리면 이 판 문항의 영어 틀 정리 글(최대 20)과 예문 영어(최대 20)를 `prefetchSpeech(…, "en-US")`(합 40 — 상한 90 안).
- 끝 화면: ○ n / 전체(모드마다 한 줄), 틀린 틀 목록(틀 줄 + 한국어 틀 + "🧩 카드로" — `?tab=templates&tpl={key}`), 모드마다 "틀린 틀만 다시 · {모드 이름} n", "폴더로". 그만두기도 같은 끝 화면(판정한 문항만).
- **저장 — 모드마다 한 건**: 기존 라우트 `POST /api/toeic/guides/templates/sessions`(§12-5-6)에 모드별로 보낸다. `clientSessionId`는 시작할 때 모드마다 UUID 하나씩 만들고, `startedAt`은 모두 같다. 일부가 실패하면 "다시 저장"이 같은 키로 **전부** 다시 보낸다 — 이미 저장된 모드는 `reused:true`로 접힌다(표현 시험의 "저장 안 된 모드만" 규칙보다 단순하고 거짓 졸업을 같은 방식으로 막는다). 항목은 답한 문항 `answered:true`, 그만둬서 못 본 문항은 싣지 않는다. **모드 문서마다** 답한 문항이 0이면 그 모드는 보내지 않는다(검토 S7 — 빈 `items`는 본문 zod `.min(1)`이 400으로 막아 "다시 저장"이 계속 실패한다). 판 전체에서 답한 문항이 0이면 아무것도 저장하지 않는다. 화면 이탈 저장은 틀 테스트와 같은 keepalive 관용구다(`persisted=false`일 때만, §12-5-6).
- **라우트 변경**(`toeicTemplateSessionBodySchema`): `mode` enum = 다섯 모드(`TOEIC_TEMPLATE_BANK_MODES`). `items` 상한은 모드로 가른다 — 말하기 두 모드 10(`TOEIC_TEMPLATE_TEST_MAX` 그대로), 틀 시험 셋 20(`TOEIC_TEMPLATE_CHOICE_MAX`). `word` 형식·세션 안 중복 거부·멱등 세 갈래·404 `bank_not_found`·계약 파일은 그대로다(계약 타입의 `mode`만 넓힌다).

**숙련도·오답노트·기록**

- `aggregateToeicTemplateChoiceStats(sessions)` → `Record<ToeicTemplateChoiceMode, Record<틀 key, WordStat>>` — 말하기 쪽 `aggregateToeicTemplateStats`와 같은 길(모드로 가른다 → **같은 날 잇단 ○ 접기** → `toeicSessionsToVocabRecords` → `aggregateWordStats` → `tpl:` 떼기)을 모드 목록만 바꿔 탄다. 그래서 `lib/toeic-template.ts`의 내부 도우미를 모드 목록 인자로 일반화해 공개한다 — `aggregateTemplateStatsByModes(sessions, modes)`·`templateBadgesByModes(sessions, todayKst, modes)`·`templateAttemptCounts(sessions, mode)`(지금의 비공개 `rawAttemptCounts`). `aggregateToeicTemplateStats`·`toeicTemplateBadges`는 말하기 두 모드로 이것을 부르는 얇은 함수가 되고 결과는 글자까지 그대로다(복사하면 같은 날 접기 규칙이 두 벌이 된다). 졸업 = 그 모드에서 **서로 다른 날** 연속 2회 ○(② 틀 테스트와 같은 기준·같은 근거 — "틀린 것만 다시"를 연달아 해서 몇 분 만에 졸업하지 않게, §12-5-6).
- **서로 읽지 않는다**: 고르기 세 모드 통계는 ② 배지·"익힘"(틀 바꿔 말하기 졸업)·"틀린 틀만 따라 말하기"·연습의 틀 약함(`combinedWeakness` — 말하기 두 모드)에 들지 않고, 말하기 세션은 고르기 통계에 들지 않는다(반례로 잠근다).
- `toeicTemplateChoiceWrongKeys(sessions, mode)` = 그 모드에서 틀렸고 미졸업. `toeicTemplateChoiceBadges(sessions, todayKst)` = §12-5-6 배지 규칙 그대로(오늘 ○ 포함), 모드만 셋.
- **③ 탭 화면**(`components/toeic-template-quiz-tab.tsx`)
  - 머리: 모드 칩 셋(기본 셋 다 켬 — 칩마다 낼 수 있는 문항 수), 범위 칩("유형 전체" 기본 · 단계마다 · **묶음마다** — 검토 반영: ②가 묶음 단위로 따라 말하므로 "방금 따라 말한 묶음을 바로 고르기로 확인"이 되게), "시작 (n문항)"(n = min(낼 수 있는 틀 수, 20)).
  - **틀린 틀**(오답노트 — 따로 페이지를 두지 않는다): 모드 탭 셋 — 줄마다 틀 줄·한국어 틀·오답 수·배지·"🧩 카드로", 탭 머리 "틀린 틀만 다시 시험 · n".
  - **최근 틀 시험**: 그 유형 틀이 든 고르기 세션 최신 10판 — 같은 `startedAt`의 모드 문서를 한 줄로 묶는다(날짜 · 모드들 · ○ n / 전체 · 그만둠). `recentTemplateChoiceTests`.
- **② 틀 카드 배지 줄 교체**(§12-5-1): 옛 "표현 시험: 뜻→표현 · 표현→뜻" 줄 자리에 **틀린 것만** 칩 하나 "👀 ✕ n"(n = 고르기 세 모드 중 그 틀이 `toeicTemplateChoiceWrongKeys`에 든 모드 수, 누르면 ③ 탭의 틀린 틀 목록). 0이면 칩이 없다. 고르기 🎓·진행 중은 카드에 보이지 않는다(검토 반영 — 카드에 말하기 배지 둘과 고르기 배지 셋이 함께 서면 고르기 🎓(알아보기 졸업)가 말하기 숙련처럼 보인다. 목표는 말로 꺼내기다). 폴더 페이지는 유형 공략 세트의 시험 세션을 읽지 않는다.

**교재 표현 시험 닫기 — 기록은 남긴다**

- ③ 탭에서 표현 목록·"👀 5지선다 시험"·"📝 교재 문장 말하기"·오답노트·기록 버튼과 `?expr=` 처리(`findGuideExpressionIndex`)를 뺀다. 표현 목록 자체는 **① 끝의 읽기 전용 접기 "📘 교재 표현 목록"으로 옮긴다**(검토 반영 — §12-13-1, §12-12 34). `components/toeic-guide-expr-list.tsx`는 지우지 않고 읽기 전용 모드로 줄여 ①에서 쓴다(시험 버튼·`?expr=`·프리페치 제거 — 기존 eval이 이 파일을 최상위에서 읽어 지우면 `eval:toeic`이 0항목으로 죽는다, 검토 S1).
- `/toeic/sets/guide-{part}/quiz|wrong|history`는 그 유형 폴더 `?tab=quiz`로 보낸다(틀 은행 리다이렉트와 같은 자리 — 서버 페이지가 `isToeicGuidePartSet`으로 가른다). 저장 라우트 `POST /api/toeic/sets/[id]/quiz`는 바꾸지 않는다 — 옛 탭에서 끝난 판이 버려지지 않게.
- 저장된 공략 표현 시험 세션(`setId = guide-{part}`)은 **지우지 않는다**. 스트릭은 지금 규칙 그대로 과거를 세고(계산식 변경 0), 연습의 활용할 표현 순위(공략 표현 — §12-13-3)가 계속 읽는다. 화면에서만 보이지 않는다.
- 가져오기 파일의 `expressions`·`speak`, 세트의 `entries`·`quiz`는 그대로 받고 저장한다 — 정렬 대상·교재 연결·연습의 활용할 표현이 쓴다.
- `quizOrder:"weakness"`·5지선다 `max` 옵션(§12-6)은 쓰는 화면이 사라지지만 지우지 않는다 — 표현집 기본 동작 불변을 잠그는 eval 항목이 그대로 돈다.

**스트릭**: 틀 시험 세션도 `toeicQuizzes`라 지금 규칙(답한 문항 ≥ 1)으로 센다. 라벨은 `템플릿 훈련 · {모드 이름}` — `/api/streak`가 넘기는 이름표를 다섯 모드(`TOEIC_TEMPLATE_BANK_MODE_LABELS_KO`)로 넓힌다(§12-9).

**모드 타입**(`lib/toeic-quiz.ts` — 모드 목록이 한 모듈에 모이는 규칙 그대로)

- 새로: `TOEIC_TEMPLATE_CHOICE_MODES = ["tpl-ko-frame", "tpl-frame-ko", "tpl-cloze"]`·`ToeicTemplateChoiceMode`·`TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO`("한→영 고르기"·"영→뜻 고르기"·"빈칸 채우기")·`isToeicTemplateChoiceMode`, 합친 목록 `TOEIC_TEMPLATE_BANK_MODES`·`ToeicTemplateBankMode`·`TOEIC_TEMPLATE_BANK_MODE_LABELS_KO`·`isToeicTemplateBankMode`.
- 그대로: `TOEIC_TEMPLATE_QUIZ_MODES`·`ToeicTemplateQuizMode`(말하기 둘 — 이름을 바꾸지 않는다. 말하기만 보는 곳이 전부 이것을 돈다).
- 넓히기: `ToeicQuizSessionLike.mode`·레코드 `mode` = `ToeicQuizMode | ToeicTemplateBankMode`, `normalizeToeicQuizRecord`는 다섯 모드를 받는다(모르는 모드는 지금처럼 버린다). 말하기 라벨 색인(`TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO[mode]`)은 `isToeicTemplateQuizMode`로 거른 뒤에만 한다(§12-3).

**비용**: AI 0 — 발음만(답한 뒤 영어 틀·예문 en-US, 프리페치 최대 40).

#### 12-13-3. ④ 한 문제 연습 + 실전 모의고사 — 답변 흐름으로 조립

**답변 흐름 — 호출 C·D의 새 입력**(타입은 `lib/ai/toeic/schemas.ts`, 화면은 계약 파일의 `export type`)

```ts
interface ToeicAnswerFlowFrame {
  key: string;          // 틀 key — 화면이 ② 카드로 잇는다
  expression: string;   // frameToExpression(frameEn) — 보낸 글자 그대로("~" 자리, "/" 없음)
}
interface ToeicAnswerFlow {
  part: ToeicMockPart;                                        // picture | respond | info | opinion (read는 흐름이 없다)
  steps: { stepKo: string; frames: ToeicAnswerFlowFrame[] }[];  // 그 유형 흐름의 단계 순서 — 틀이 없는 단계는 뺀다
  banks: ToeicAnswerFlowFrame[];                                // 소재 틀(소재 묶음·기타 묶음, 흐름 순서) — 없으면 []
}
```

- **만드는 법** `buildAnswerFlow(bank, mockPart, templates, opts)` → `ToeicAnswerFlow | null`(`lib/toeic-template.ts`, 순수)
  - 유형 = `toeicGuidePartOfMockPart(mockPart)`(`lib/toeic-guide.ts`, `TOEIC_GUIDE_PART_TO_MOCK_PART`의 역 — `read`면 null → 흐름 없음).
  - `templates` = 그 유형 **렌더 가능한** 틀(호출측이 `guideTemplatesForPart`로 거른다 — 깨진 틀은 넣지 않는다).
  - 순서는 `templateFlowOrder` 하나 — 단계 묶음의 틀은 그 단계로, 소재·기타 묶음의 틀은 `banks`로. 한 단계 = 그 단계 묶음들의 틀 전부(자리마다 하나 — 중복 정리 뒤 은행).
  - `opts.order`: `"flow"`(실전 모의고사 — 흐름 순서 그대로) / `"weakness"`(한 문제 연습 — 단계 안·소재 안 틀을 `templatesByWeakness`(말하기 두 모드 합친 약함, `rng`) 순으로. 모델은 앞쪽의 맞는 틀을 먼저 고르기 쉽다 — 강제는 아니다, §12-12 30).
  - 상한 `TOEIC_ANSWER_FLOW_FRAMES_MAX` 60: 넘으면 소재 틀을 뒤에서 자르고, 단계 틀만으로 넘으면 단계마다 앞에서 ⌊60 ÷ 단계 수⌋개만 남긴다. 2026-10-02 원본은 파트당 21~39틀이라 닿지 않는다(§12-12 31).
  - 틀이 하나도 없으면 null.
- **사용자 메시지 글** `formatAnswerFlow(flow)` — §4-7(단계마다 한 줄 `n. 단계: 틀 / 틀`, 마지막 줄 `소재 틀: …`, 없으면 `없음`). 호출 C·D가 같은 함수를 쓴다.
- `answerFlowExpressions(flow)` = 흐름의 틀 글자 전부(단계 → 소재 순, 중복 없음) — 후처리 허용 목록에 더한다.

**프롬프트 — 바뀐 원문 셋 + 새 원문 하나**(전문은 각 절, 구현은 같은 문자열로)

| 블록 | 바뀐 것 |
|---|---|
| §4-1 둘째 블록 `TOEIC_MOCK_FLOW_RULES`(새) | `[답변 흐름]` 절: 흐름 읽는 법 · 단계 순서대로 단계마다 맞는 틀을 `~` 밖 글자 그대로 쓰고 `~`만 채운다(`~`를 남기지 않는다) · 맞는 틀이 없는 내용만 자유 문장 · 틀과 같은 역할을 다른 말로 바꿔 쓰지 않는다 · 필요 없는 단계는 건너뛴다 · **과제 절의 답변 순서·따옴표 예시는 흐름이 없을 때의 예시**(흐름에 그 역할의 틀이 있으면 그 틀) · **등급 차이는 `~` 채움·자유 문장·연결로** · **활용할 표현은 `~` 자리·자유 문장 안에서만** · 쓴 틀도 `usedExpressions`에. 흐름을 받은 파트만 **과제 절 뒤에** 붙인다(§4-0) |
| §4-1 `TOEIC_MOCK_COMMON` | **바뀌지 않는다**(검토 반영 — 처음 안의 머리말 안 절을 위 블록으로 떼어 냈다) |
| §4-7 `TOEIC_MOCK_USER_TEMPLATE` | `답변 흐름:` + 자리 두 줄 |
| §5-1 `TOEIC_FEEDBACK_SYSTEM_PROMPT` | `[입력]`에 흐름과 "틀을 쓰지 않았다는 이유로 감점하지 않는다", `fixes.better`·`improvedAnswer`를 틀로(**이 문항에 필요한 단계만** — 다른 문항 번호·답변 시간에 필요 없는 단계 건너뛰기, `~`는 답·본 자료의 내용으로만 채우고 채울 것이 없는 틀은 쓰지 않는다), `tryExpressions`가 **이 문항의 단계에 맞는** 흐름 틀도 고른다 |
| §5-2 `TOEIC_FEEDBACK_USER_TEMPLATE` | `답변 흐름:` + 자리 두 줄 |

§4-1 머리말·과제 절 다섯(§4-2~§4-6)·JSON Schema 8·호출 옵션·관문 P 접미사는 그대로다. zod는 채우지 않은 틀 자리만 새로 거부한다 — `hasUnfilledSlot`(`~`·`～`·`〜`·`{`·`}`)을 C2~C5 `sampleAnswer`(§4-9)와 D `improvedAnswer`·`fixes[].better`(§5-3)에 건다(기존 1회 재요청, 위반일 때만 비용 — 틀 조립 준수는 여전히 거부하지 않는다, §12-12 25). 플레이스홀더 표 둘(`TOEIC_MOCK_PLACEHOLDERS`·`TOEIC_FEEDBACK_PLACEHOLDERS`)에 `answerFlow`를 더한다 — 템플릿에 없는 키를 넘기면 `fillTemplate`이 throw하므로 두 템플릿이 함께 바뀌어야 한다.

**호출 C — 입력·후처리·저장**

- `ToeicMockUserMessageInput`에 필수 칸 `answerFlow: ToeicAnswerFlow | null`(null이면 "없음"). `generateMockPart`(`lib/ai/toeic/calls.ts`)는 시스템 프롬프트를 `buildMockSystemPrompt(part, input.answerFlow !== null)`로 만들고, 이 칸을 `buildMockUserMessage`에 넘기고, `toMockRecordPart(part, raw, 허용 목록)`의 허용 목록을 넓힌다(모범답변이 쓴 틀을 `usedExpressions`에서 버리지 않게). 허용 목록은 **`calls.ts`에서** 이렇게 만든다(검토 S4):
  - `[...answerFlowExpressions(answerFlow), ...normalizeMockExpressions(expressions)]` — **흐름 틀을 앞에** 둔다. 두 후처리는 같은 키면 먼저 나온 표기를 쓰므로(`mock.ts`) 앞에 두어야 표기가 흐름 쪽이 된다.
  - 합친 목록을 다시 `normalizeMockExpressions`에 넣지 않는다 — 그 함수는 24개에서 자르므로, 표현집이 24개 이상이면 흐름 틀이 전부 잘려 모범답변의 틀 `usedExpressions`가 조용히 다 버려진다. 정규화는 활용할 표현에만, 합치기는 그 **뒤에**.
- **실전 모의고사** `POST /api/toeic/mocks`: 틀 은행(`guide-templates`)은 **이미 읽는 `store.listToeicSets()` 결과에서** id `TOEIC_TEMPLATE_BANK_ID` 문서를 찾아 `isRenderableToeicTemplateBank`로 본다 — 읽기를 하나 더하지 않는다(검토 S10. 지금 라우트가 `isToeicGuideSet`으로 빼는 그 문서다). 틀 세션은 읽지 않는다. **read를 뺀 네 파트 전부**(고른 파트와 상관없이 — 검토 반영 B1) `buildAnswerFlow(bank, part, 그 유형 렌더 가능한 틀, { order: "flow" })`를 만들고(순수 도우미 `buildMockAnswerFlows(bank, templatesByPart)` → 형식표 순서의 흐름 배열 — 라우트는 이것을 부르기만 해서 eval이 라우트 없이 잠근다), 호출 C에는 그중 **고른 파트의 흐름만** 넘긴다. **파트마다 입력이 달라진다** — 지금의 공통 `input` 하나를 파트별 입력으로 바꾼다(목표 등급·주제 힌트·활용할 표현은 같고 흐름만 다르다). 활용할 표현은 지금 그대로(표현집 — §12-3 표). 틀 은행이 없거나 렌더 불가면 모든 흐름이 null → 지금과 같은 요청이다. 흐름 만들기(순수)가 던지면 그 파트 흐름만 null로 두고 계속한다(§0-4 "한쪽이 비어도 다른 쪽이 온전히" — 흐름 때문에 모의고사를 실패시키지 않는다, 로그는 개수·예외 이름만). 문서에 `answerFlows`(**네 파트 중 흐름이 나온 것 전부** — 고르지 않은 파트·실패한 파트 포함)를 저장한다. 그래야 나중의 "이 파트 만들기"(고르지 않은 파트)와 그 채점도 흐름을 받는다(§7-2).
- **한 문제 연습** `POST /api/toeic/guides/[part]/drills`: 흐름 = `buildAnswerFlow(bank, mockPart, 그 유형 틀, { order: "weakness", sessions: 틀 세션, rng })`. 활용할 표현은 **새 모양의** `pickExpressionsForDrill`(아래). 문서에 `answerFlows: [흐름]`(흐름이 null이면 `[]`).
- **다시 만들기** `POST /api/toeic/mocks/[id]/regenerate?part=`: "이 파트 다시 만들기"(실패한 파트)와 "이 파트 만들기"(만들 때 고르지 않은 파트) 모두 문서 `answerFlows`의 그 파트 흐름을 그대로 넘긴다(없으면 null — 옛 문서와 틀 은행이 없던 때 만든 문서는 지금과 같다). 지금의 틀 은행을 다시 읽지 않는다(입력은 처음과 같다 — §7-2). 만들 때 네 파트 흐름을 모두 저장하므로 재정렬 뒤에 만든 문서는 어느 파트를 나중에 채워도 흐름이 있다.
- **`pickExpressionsForDrill` 새 모양**(`lib/ai/toeic/mock.ts`, 서버 전용): 틀 칸(`templates`)이 없어지고 `guide = { set, sessions, exclude }`가 된다. `exclude` = `guideExpressionKeysInFlow(bank, part)`(`lib/toeic-template.ts`, 순수 — 틀이 `guideRefs`로 연결한 표현 키 ∪ `alternates`의 표현 키). 공략 표현 중 이 키에 든 것을 빼고 `pickExpressionsForMock([공략 세트], 그 세트 세션)` → 표현집 `pickExpressionsForMock` → 대소문자 무시 중복 접기 → 최대 24개.
  - 왜 빼나: 외울 틀은 흐름에 이미 있고(두 칸에 같은 틀이 있으면 모델이 어느 칸 글자로 적을지 갈린다), 같은 자리 다른 표현은 넣으면 모범답변이 외우지 않을 대안을 쓴다.
  - 틀 은행이 없으면 `exclude`가 비어 결과가 옛 함수(틀 은행 없을 때)와 같다.
  - 옛 순수 함수 `pickTemplatesForDrill`은 연습 입력에서 빠지고 화면(`drillStepPicks` — 틀 점검의 "빠진 단계의 가장 약한 틀")에만 남는다.

**호출 D — 입력·후처리**

- `buildFeedbackInput(mock, q, transcript)`가 `answerFlow` = `mock.answerFlows`에서 그 문항 파트의 흐름(없으면 null)을 싣는다. `buildFeedbackUserMessage`가 그 칸을 채운다.
- `postprocessFeedback(fb, 허용 목록)`의 허용 목록 = `[...answerFlowExpressions(흐름), ...expressionsUsed]` — `tryExpressions`가 틀을 골라도 남는다(최대 3 그대로). 합치는 곳은 `generateFeedback`(`lib/ai/toeic/calls.ts`)이고 흐름 틀이 **앞**이다(표기가 흐름 쪽 — 검토 S4). 흐름 틀을 `ToeicFeedbackInput.expressions`에 섞지 않는다 — 섞으면 D 사용자 메시지의 `활용할 표현:` 줄에도 찍힌다. 흐름은 `answerFlow` 칸으로 따로 싣고 허용 목록만 합친다.
- zod는 그대로다 — `said` ⊂ 전사문 단어열(환각 차단), 점수 범위, 빈 값 거부. "틀로 고쳐라"는 `better`·`improvedAnswer`의 글을 바꾸지 `said`를 바꾸지 않는다. 더하는 것은 `improvedAnswer`·`fixes[].better`의 채우지 않은 틀 자리 거부 하나다(§5-3).
- D가 쓰는 흐름은 **만들 때 저장한 흐름**이다(재현성 — 모범답변과 같은 흐름). 만들기와 채점 사이에 틀 은행이 바뀌면(정리·다시 가져오기) 개선 답변이 지금은 외우지 않는 틀을 쓸 수 있고, 틀 점검의 피드백 권장 틀이 지금 은행에서 되짚히지 않아 빠진다 — 알려진 틈, §12-12 35.

**모범답변 점검 — 재요청하지 않는다(측정만)**

- `checkAnswerAgainstFlow(answer, flow)` → `ToeicAnswerFlowCheck`(`lib/toeic-template.ts`, 순수)

```ts
interface ToeicAnswerFlowCheck {
  used: { key: string; step: number | null }[];  // 쓴 틀(첫 위치 순). step = 단계 번호(0부터), 소재 틀이면 null
  stepsUsed: number;    // 쓴 틀이 하나라도 있는 단계 수
  stepsTotal: number;   // 흐름의 단계 수
  inOrder: boolean;     // 쓴 단계들의 첫 위치가 단계 순서대로 늘어섰는가(쓴 단계가 1개 이하면 true)
  unmatchable: number;  // 두 낱말 이상 고정 조각이 없어 찾을 수 없는 흐름 틀 수
}
```

  - 찾기는 `findTemplatesInTranscript`(§12-5-5 — 두 낱말 이상 고정 조각이 순서대로, `sameTemplateWord`) 그대로다. 흐름 틀 글자의 `~`를 자리 `{_}`로 바꿔 넘긴다(`answerFlowMatchFrames`). **저장된 흐름**으로 재므로 틀 은행이 나중에 바뀌어도 결과가 같다.
- **왜 재요청하지 않나**: ① zod로 거부하면 `callWithSchema`의 1회 재요청 뒤에도 미달일 때 그 파트가 통째로 실패한다 — 연습 하나·모의고사 파트 하나를 문체 기준 때문에 잃는다. ② 재요청은 비용이 최대 두 배다(목표는 호출 수 변화 0). ③ 판정 자체가 근사다(한 낱말 조각뿐인 틀은 못 찾는다). 그래서 프롬프트로 시키고, 결과를 재서 보이고, 실호출 점검(§12-13-5)이 낮게 재면 프롬프트를 고친다(§12-12 25).
- 화면(AI 0): 모범답변이 보이는 두 곳 — 모의고사 **학습 보기**의 모범답변, **결과 화면**의 모범답변 접기(연습·모의고사) — 에 한 줄 "🧩 모범답변의 틀 n개 · 단계 a/b"(Q3–4·Q11 — `TOEIC_TEMPLATE_FLOW_CHECK_PARTS`. Q5–7·Q8–10은 "틀 n개"만 — 질문마다 짧게 답한다), 순서가 어긋났으면 "(순서 다름)". 흐름이 없는 문서(옛 문서)는 줄이 없다. 모범답변 속 강조(활용한 표현 — SPEC §20-3)는 틀 글자에서 온 구간을 🧩 색으로 따로 보인다(`expression`이 흐름 글자 집합에 드는가로 가른다).
  - **미달 경고**(검토 반영, AI 0): `isWeakFlowCheck(check, mockPart)`(`lib/toeic-template.ts`, 순수)가 참이면 그 줄 아래에 "🧩 이 모범답변은 틀을 덜 따랐어요 — 외울 것은 '이 파트 답변 흐름'"(학습 보기는 그 접기를 열어 준다, 결과 화면은 ② 탭 링크). 기준은 실호출 점검과 같은 상수 `TOEIC_ANSWER_FLOW_STEP_MIN_RATIO` 0.75 — Q3–4·Q11은 `stepsUsed / stepsTotal` < 0.75, Q5–7·Q8–10은 쓴 틀 0. 기준 이상이면 "단계 3/4"여도 결핍 색을 쓰지 않는다(필요 없는 단계를 정상으로 건너뛴 경우가 있다). 까닭: 모의고사의 "다시 만들기"는 빈 파트만 채우므로 틀을 덜 따른 모범답변을 바꿀 길이 없다 — 경고가 없으면 그 답을 그대로 외운다.
- 학습 보기(모의고사)에는 파트마다 접힌 "🧩 이 파트 답변 흐름"(저장된 흐름 — 단계마다 틀 줄, 틀마다 ② 카드 링크)을 둔다. 흐름이 없으면 숨긴다.

**🧩 틀 점검 — 모의고사에도**(§12-12 17 닫음)

- 결과 페이지(서버)는 `drillPart`와 상관없이 응시 범위의 파트마다(read 제외) 그 유형 점검 자료를 만든다 — `toeicDrillCheckData`를 `toeicTemplateCheckData`로 이름을 넓혀 파트마다 부른다(틀 줄만 — 예문·`testFills`는 넘기지 않는다, §12-7-9). 틀 은행이 없거나 그 유형 틀이 0이면 그 파트는 점검이 없다.
- 화면: 연습은 지금처럼 문항마다 펼쳐서, 실전 모의고사는 문항마다 **닫힌 접기** "🧩 틀 점검 · 쓴 틀 n(· 빠진 단계 m)" — 11문항 결과 화면이 길어지지 않게. 채점 전 문항의 접기 요약은 "🧩 모범답변의 틀 n · 채점 뒤 내 틀"이다("쓴 틀 0"처럼 읽히지 않게).
- **모의고사 결과 머리 한 줄**(검토 반영, AI 0): "🧩 틀을 쓴 문항 n/m · 빠진 단계 k"(m = 채점된 Q3–11 문항 수, n = 그중 내 답에서 쓴 틀이 1개 이상인 문항 수, k = Q3–4·Q11의 빠진 단계 합). 채점된 문항이 없으면 줄이 없다. 접기 9개를 열지 않고 "틀대로 달렸나"를 본다 — `toeicTemplateCheckSummary(results)`(`lib/toeic-drill-view.ts`). 연습 결과에는 두지 않는다(문항이 1~3개이고 펼쳐서 보인다).
- **"쓸 수 있었던 틀" — 단계 기준으로 순서를 바꾼다**(검토 반영). 합쳐 최대 5개(`TOEIC_TEMPLATE_SUGGESTIONS_MAX` 그대로), 겹치지 않게, 내가 쓴 틀은 뺀다. 채우는 순서:
  1. (Q3–4·Q11) **빠진 단계마다 하나**(단계 순서) — 그 단계에서 모범답변이 쓴 틀(아래 3의 목록 중 그 단계 묶음에 든 첫 틀 — 이 문제에서 어떻게 쓰는지 모범답변에서 바로 보인다), 없으면 그 단계의 가장 약한 틀(`drillStepPicks`). 출처 `step`.
  2. 피드백 `tryExpressions` 중 지금 틀 은행에서 틀로 되짚히는 것. 출처 `feedback`.
  3. 남은 모범답변 틀 — `findTemplatesInTranscript(그 문항 sampleAnswer, 그 유형 틀)`의 순서를 먼저, 그다음 `usedExpressions` 되짚기(앞에 없는 것). 모델이 적은 목록보다 글에서 찾은 것이 믿을 만하고, 옛 문서도 같은 규칙으로 돈다. 출처 `sample`.
  - 왜 바꾸나: 옛 순서(모범답변 → 피드백 → 빠진 단계)는 그대로 두면, 모범답변이 단계마다 틀로 조립된 뒤(Q3–4 4단계·Q11 5단계 + 소재 틀) 모범답변 틀 5~8개 대 내 틀 0~2개에서 모범답변 틀만으로 5칸이 찬다 — "내가 어느 단계를 건너뛰었나"(가장 행동할 만한 신호)와 내 답에 맞춘 피드백 틀이 늘 잘리고, 모의고사에서는 9문항에 되풀이된다.
  - 함수: `templatesCouldHaveUsed({ missingStepKeys, tryExpressions, sampleKeys, mine, byExpression, max? })`(`lib/toeic-template.ts`) — 인자 `sampleUsedExpressions`(표현 글자)를 `sampleKeys`(이미 틀 key로 되짚은 모범답변 틀, 위 3의 순서)로 바꾸고, 채우는 순서를 `step` → `feedback` → `sample`로 바꾼다. 빠진 단계의 key 고르기(모범답변 틀 우선, 없으면 가장 약한 틀)는 단계 ↔ 묶음 표를 가진 호출측 `drillTemplateCheck`(`lib/toeic-drill-view.ts`)가 한다. 출처 라벨 `TOEIC_DRILL_SUGGESTION_SOURCE_KO`는 그대로다.
  - 채점 전(전사문 null)에는 빠진 단계·피드백이 없으므로 모범답변 틀만이다(지금과 같은 결과). 빠진 단계가 없는 문항(Q5–10, 또는 단계를 다 밟은 답)은 피드백 → 모범답변 순이 된다 — 옛 순서와 **다르다**(검토 의견은 "빠진 단계 0이면 결과 그대로"였지만, 피드백을 모범답변 앞에 두는 것이 같은 근거 — 내 답 맞춤 신호를 먼저 — 라 그 경우도 순서를 바꾼다).
- 점검의 "내 답에서 쓴 틀"은 지금처럼 **지금의 틀 은행**으로 찾는다(학습자가 지금 외우는 틀 기준 — 모범답변 점검이 저장된 흐름을 쓰는 것과 다르다).

**준비 화면 접기 — 단계마다 첫 틀 + "+n"**(§12-7-9 갱신, 검토 반영): ④ 탭의 "🧩 이 유형 답변 흐름"은 단계마다 **첫 틀 하나**(흐름 순서)와 "+n"(누르면 **그 단계의 틀 전부** — `buildAnswerFlow(…, { order: "flow" })`, 모범답변이 고르는 목록과 같다)이고, 끝에 접힌 "소재 틀"이다. 틀마다 "이 틀 연습하기". 시작 직전에 훑을 것은 "단계마다 무엇을 말하나"이지 메뉴 전체가 아니다(Q3–4 한 단계에 틀 10개도 있다). 응시 화면(준비 45초) 안에는 여전히 두지 않는다.

**공개 저장소** — 호출 C·D로 나가는 틀 은행 글은 틀의 `~` 형태와 단계 이름(`stepKo`)뿐이다(§12-2-6 갱신). 예문·테스트 전용 채움·공략 본문·교재 표현 목록 전체는 넣지 않는다. 라우트 로그는 지금처럼 개수만 찍는다("흐름 단계 n · 틀 m").

**옛 문서**: `answerFlows`가 없는 모의고사·연습은 `[]`로 읽고 — 다시 만들기·채점 모두 "없음" → 옛 동작 그대로. 저장된 모범답변·응시 기록은 바꾸지 않는다.

#### 12-13-4. 비용

| 행동 | 바뀌는 것 | 호출 수 |
|---|---|---|
| ① 공략 읽기 | 접은 줄은 미리 받지 않는다(프리페치가 준다). 접힌 줄 🔊·틀 줄 🔊·📘 교재 표현 목록 🔊는 탭할 때만 합성 | AI 0 |
| ③ 틀 시험 | 발음만 — 답한 뒤 영어 틀·예문 en-US(한 판 최대 40조각 프리페치) | AI 0 |
| 한 문제 연습 만들기 | 호출 C 입력에 답변 흐름 한 블록(2026-10-02 원본 기준 파트당 틀 21~39개 — 줄당 수십 글자, 상한 60틀) | C 1회(재요청 시 2) 그대로 |
| 실전 모의고사 만들기 | 고른 파트(read 제외)의 입력에 각자 흐름 한 블록 + 흐름 규칙 블록(시스템 프롬프트). 문서에 흐름 넷을 저장(고르지 않은 파트 포함 — 합쳐 수 KB, 흐름 글 한 벌 약 0.7~1.5KB) | C 5회 병렬 그대로 |
| AI 채점 | 호출 D 입력에 그 문항 파트의 흐름 한 블록 | T 1 + D 1 그대로 |
| 🧩 틀 점검 · 모범답변 점검 | 저장된 전사문·모범답변·흐름만 쓴다 | AI 0 |

- 출력 상한(호출 C 6,000 · D 2,500)은 그대로다. 개선 답변이 틀로 조립되며 조금 길어질 수 있지만 "제한 시간 안에" 규칙이 그대로이고, D는 이 문항에 필요한 단계만 쓴다(§5-1).
- 재요청이 새로 생기는 경우는 하나 — 모범답변·개선 답변·고칠 문장에 채우지 않은 틀 자리(`~`·`{`·`}`)가 남았을 때뿐이다(위반일 때만 +1회). 틀 조립 준수로는 재요청하지 않는다(§12-12 25).
- 사진(관문 P)·전사(관문 T)는 바뀌지 않는다.

#### 12-13-5. eval (`scripts/eval-toeic*.ts` — 오프라인, 실호출 0. 모든 문장·틀은 지어낸 것)

- **spec-sync**: 원문 대상이 14 → **15**(`TOEIC_MOCK_FLOW_RULES`를 `SPEC_SYNC_TARGETS`에 등록 — 라벨 "§4-1 호출 C 흐름 규칙"), JSON 8·호출 옵션 문장은 그대로. 값 셋(§4-7·§5-1·§5-2)과 새 블록이 이 스펙과 바이트로 같고, §4-1 머리말은 옛 글자 그대로 같다. 플레이스홀더 표 둘에 `answerFlow`가 있고 그 글자가 두 템플릿 안에 있다. 이 절에 호출 옵션 문장 정규식에 걸리는 문장을 쓰지 않는다.
- **시스템 프롬프트 조립**(기존 항목 "호출 C 조립 = `TOEIC_MOCK_COMMON` + `\n\n` + 파트 과제 절(5개)"을 교체): `buildMockSystemPrompt(p, false)` = `TOEIC_MOCK_COMMON + "\n\n" + TOEIC_MOCK_TASKS[p]`(다섯 파트 — 옛 바이트 그대로), `buildMockSystemPrompt(p, true)` = 그 뒤에 `"\n\n" + TOEIC_MOCK_FLOW_RULES`(흐름 규칙이 **맨 끝** — 과제 절보다 뒤), 과제 절 다섯이 서로 다름. 소스 대조: `generateMockPart`가 `hasFlow`를 `input.answerFlow !== null`로 넘긴다.
- **입력 조립 스냅숏**(지어낸 틀): `formatAnswerFlow` — 단계 셋 + 소재 둘의 글자 그대로, 소재 없음(마지막 줄 없음), 빈 단계는 줄이 없고 번호가 이어짐, null·빈 흐름 → `없음`, 틀 글자에 `{`·`}`·`/` 없음. `buildMockUserMessage` — 흐름 있음·없음 두 스냅숏(없음이면 마지막 두 줄이 `답변 흐름:` / `없음`). `buildFeedbackUserMessage` — 같은 두 스냅숏, 흐름 틀 글자가 `활용할 표현:` 줄에 **없다**(흐름은 `답변 흐름:` 아래에만 — 검토 S4).
- **채우지 않은 틀 자리 zod**(`hasUnfilledSlot`): C2~C5 `sampleAnswer`에 `~`·`～`·`{…}` → 거부(파트마다 한 건), 같은 글에서 그 글자를 뺀 것 → 통과, C1 `text`의 `~`는 판정하지 않음(read는 대상 밖). D `improvedAnswer`의 `{`·`fixes[].better`의 `～` → 거부, `said`에 `~`가 있어도 이 규칙으로는 거부하지 않음(전사문 구간). 판정 함수가 하나(`schemas.ts`)이고 C·D가 같은 것을 부른다(소스 대조).
- **`buildAnswerFlow`**: `read` → null, 단계 순서 = `templateFlowOrder`, 소재·기타 묶음 → `banks`, 렌더 불가 틀은 호출측이 거른 뒤라 들어오지 않음, `"weakness"`는 단계 안에서 약한 틀이 앞(같은 rng면 결정적), `"flow"`는 rng를 쓰지 않음, 60틀 상한(소재 먼저 자름 · 단계만으로 넘치면 단계마다 같은 수), 틀 0 → null.
- **후처리 허용 목록**(검토 S4): `toMockRecordPart` — 흐름 틀을 쓴 `usedExpressions`는 남고, 목록·흐름 어디에도 없는 표현은 버림. **활용할 표현 25개 + 흐름 틀 3개**(지어낸)일 때도 흐름 틀 `usedExpressions`가 남음(합친 목록을 24에서 자르지 않는다). 같은 키가 활용할 표현과 흐름에 다른 표기로 있으면 저장 표기는 흐름 쪽. `postprocessFeedback` — 흐름 틀 `tryExpressions`는 남고 표기는 흐름 쪽으로, 최대 3. 소스 대조: `calls.ts`의 두 진입 함수가 `answerFlowExpressions(…)`를 **앞에** 두고 합치며, 합친 목록을 `normalizeMockExpressions`에 다시 넣지 않는다.
- **`buildFeedbackInput`**: 그 문항 파트의 저장된 흐름이 실림(Q5–7 세 문항 같은 흐름), 옛 문서(`answerFlows` 없음) → null, **만들 때 고르지 않았던 파트**(흐름은 저장, 파트는 나중에 채움)의 문항 → 저장된 그 흐름(검토 B1).
- **`checkAnswerAgainstFlow` 반례**: 단계 넷을 순서대로 다 쓴 답 → 4/4·inOrder, 한 단계를 뺀 답 → 3/4, 단계 순서를 바꾼 답 → inOrder false, 고정 낱말 하나를 바꾼 틀 → 쓴 틀이 아님, 축약형만 다른 틀(`It is` ↔ `It's`) → 쓴 틀, 소재 틀만 쓴 답 → 단계 0, 한 낱말 조각뿐인 틀 → `unmatchable`.
- **`isWeakFlowCheck`**(검토 반영): Q3–4·Q11 단계 3/4 → false, 2/4 → true(0.75 경계 — `TOEIC_ANSWER_FLOW_STEP_MIN_RATIO`), Q5–7·Q8–10 쓴 틀 0 → true·1 → false, 흐름 없음 → false. 실호출 점검이 같은 상수를 쓴다(소스 대조).
- **레코드**: `normalizeToeicMockRecord` — `answerFlows` 없음·배열 아님 → `[]`, 깨진 항목만 버림, 옛 문서 = 기본값. Firestore 본문에 배열 속 배열 0(`hasNestedArray`). 연습·모의고사 생성부가 `answerFlows`를 명시(소스 대조 — `New*` 필수 필드라 tsc도 잡는다).
- **라우트 소스 대조**(라우트 핸들러를 부르지 않는다)
  - 모의고사 라우트: 틀 은행을 **이미 읽는 `listToeicSets()` 결과에서** `TOEIC_TEMPLATE_BANK_ID`로 찾고 `isRenderableToeicTemplateBank`를 본다(스토어 읽기 추가 0 — 검토 S10), read를 뺀 **네 파트 전부**의 흐름을 만들고(고른 파트 목록으로 거르지 않는다 — 검토 B1), 호출에는 고른 파트의 흐름만 파트마다 다르게 넘기며, `answerFlows`에 네 파트 흐름을 저장, read에는 흐름 null, 흐름 만들기 예외는 그 파트 흐름 null(500으로 가지 않는다).
  - 연습 라우트: `order:"weakness"`·새 `pickExpressionsForDrill`.
  - 다시 만들기 라우트: 문서의 그 파트 흐름을 넘기고 틀 은행을 읽지 않음(실패 파트·고르지 않은 파트가 같은 갈래).
  - 세 라우트 모두 키 검사가 AI 호출보다 앞(기존 잠금 유지).
- **흐름 저장 순수 단위**(검토 B1 — 라우트 밖으로 뺀 도우미 `buildMockAnswerFlows(bank, templatesByPart)` → `ToeicAnswerFlow[]`, `lib/toeic-template.ts`): 파트 고르기와 무관하게 네 파트(틀이 있는 유형) 흐름을 형식표 순서로 돌려준다, 틀 은행 없음 → `[]`, 틀이 없는 유형은 빠진다. 고르지 않은 파트의 흐름이 결과에 있고, 그 문서로 `regenerate`가 넘길 흐름(`answerFlows.find(part)`)이 null이 아님.
- **`pickExpressionsForDrill` 새 모양**: 결과에 틀 `~` 형태가 없다(흐름으로 갔다), 틀이 연결한 공략 표현·같은 자리 다른 표현이 빠진다, 흐름 밖 공략 표현은 남는다, 틀 은행이 없으면 옛 함수(틀 은행 없을 때)와 같은 결과, 세션 분리(공략·표현집) 그대로, 24 상한·중복 접기.
- **① 읽기 정렬**
  - 가져오기: `alternates` = `coveredBy` 있는 건너뜀만(파일 순서, 이유 글 없음), `coveredBy` null은 빠짐. 지문이 `alternates`를 넣어 바뀜 — 옛 지문의 저장 문서 + 같은 파일 → updated 한 번 → 다시 넣으면 unchanged. 이유 글만 고친 파일 → unchanged. 바이트 상한이 `alternates`까지 잼. 틀 key·틀 테스트 세션 그대로.
  - 정규화: `alternates` 없음 → `[]`, 모양이 깨진 항목만 버림, 깨져도 `isRenderableToeicTemplateBank` true.
  - **파일 저장소 왕복**(검토 S3 — 기존 s2·s3의 자식 프로세스 임시 cwd 관용구, `STORE_BACKEND=file`): 지어낸 가져오기 파일을 넣고 → 틀 은행을 다시 읽어 `alternates` 개수 = 계획 개수, 같은 파일을 한 번 더 → unchanged이고 개수 그대로. 정규화가 캐스트라 tsc가 못 잡는 누락을 이것이 잡는다.
  - `templateAlternateLinks`: 세 종류 키가 `templateLinksForGuide`와 같은 정규화.
  - `guideReadMarks`: 연결된 표현 줄 → 외울 틀, 같은 자리 표현 줄 → 줄 접기, 같은 자리 머리말의 list → 블록 통째, 모든 줄이 같은 자리 → 블록 통째, 템플릿 label 연결 → 그 label 줄 전부 외울 틀(alt 줄 포함 — 접지 않음), heading·text 본문은 판정 없음, 틀 은행 없음 → 빈 판정. 그리고 검토 B3의 두 갈래:
    - **슬래시 대안**(규칙 1): 지어낸 줄 `{사람} is sitting near/by {장소}`에서 `~ is sitting near ~`이 외울 틀, `~ is sitting by ~`이 같은 자리 다른 표현 → `frameLines`이고 `framePicks` = `{사람} is sitting near {장소}`. 지어낸 일치 변형 줄 `{물건} is/are placed on the shelf`(한쪽만 외울 틀, 다른 쪽은 어느 표에도 없음) → `framePicks` 없음(지금처럼 통째로 읽음).
    - **이어 말하기 머리말만 접기**(규칙 4): 지어낸 머리말 `Whenever I get a spare hour, I`(같은 자리 다른 표현, 대표 틀 `Most Saturdays, I like to {활동}.` — 끝이 자리) + 조각 `fix old bikes`·`bake bread` → 머리말 주소만 `altLines`, 블록은 `bareBlocks`, 조각 줄은 어느 접기에도 없음. 대표 틀이 자리로 끝나지 않으면(지어낸 `Most Saturdays, I like to {활동} near my place.`) → `altBlocks`(통째). 대표 틀이 렌더 불가 → `altBlocks`. `frameEndsWithSlot`: 끝 `.`·`?`·`!`·따옴표·공백 무시, 가운데 자리만 있는 틀 → false.
  - 대본: `skip` 없음·빈 `skip` → 기존 대본 항목이 그대로 통과하고 두 결과가 글자까지 같음, `skip` 적용 → 접은 주소의 조각 0, 프리페치 목록에 접은 줄 글자 없음, 접힌 줄 🔊 조각 = 접기 없는 대본의 그 주소 조각, 불변식(trim·≤300·lang) 그대로. 그리고:
    - `picks` → 그 줄 영어 조각이 고른 글자의 정리 결과이고 지운 대안 낱말(`by`)이 대본·프리페치 어디에도 없음, 같은 줄의 한국어·예문 조각은 그대로.
    - `bareLeads` → 조각 줄의 영어 조각이 조각 글자만(머리말 글자 0 — 대본·프리페치 전체에서 지운 머리말 글자가 없음), 조각 줄 🔊 = 그 조각만. `toeicGuideLeadPieces` → "전부"면 en·ko 두 조각, "영어만"이면 en 한 조각.
    - `text` 블록 🔊(`toeicGuideBlockPieces`)가 `skip` 적용 대본을 쓴다(소스 대조 — 검토 S13).
  - `guideReadFrameKeys`: `frameLines` 값의 합집합(템플릿 label·머리말 연결 포함), 틀 은행 없음 → 빈 집합.
  - `findGuideGotoBlock`·`guideReadInitialOpen`: `marks`를 주면 `k:{key}` → 그 key의 첫 외울 틀 줄 블록 → 없으면 블록 칩 → 없으면 null. `marks`가 없으면 `k:`는 null이고 `t:`·`l:` 결과는 기존 eval 그대로(검토 S13). `guideRefHref(expression 연결, key)` = `?tab=read&goto=k:{key}`.
  - ① 끝 교재 표현 목록(소스 대조): 읽기 전용 모드에 시험 버튼·`?expr=`·`prefetchSpeech`가 없고, 같은 자리 다른 표현은 안쪽 접기, 섹션 대본에 표현 목록 글자가 들지 않음.
- **③ 틀 시험**
  - `koFrameToTilde`: 자리마다 `~`, 공백 접기, `{`·`}` 없음.
  - `buildTemplateChoiceQuestions`: 한 판 한 틀(같은 key 두 번 없음), 최대 20(`TOEIC_TEMPLATE_CHOICE_MAX`), 모드 부분집합, `onlyWrong`은 그 모드 틀린 틀만·모드 하나, 같은 rng면 결정적, 보기 2~5·정답 포함·중복 없음, 보기 2개 미만이면 `skipped`, 문항에 `testFills` 글자가 없음(직렬화 대조). **모드별 묶음**: 결과의 모드 열이 한→영 → 영→뜻 → 빈칸 순으로 끊기지 않고 이어짐(검토 반영).
  - 오답 보기 층: 같은 묶음 틀이 있으면 첫 보기들이 같은 묶음에서 나옴, 극성 쌍(지어낸 `The upside here is ~` / `The downside here is ~`)이 서로의 보기로 나옴, 한국어 틀 `~` 형태가 같은 틀은 한→영 보기에서 빠짐, 고르기 두 모드의 문제·보기에 자리 이름이 없음. **자리 수**(검토 S6): 같은 묶음에 자리 1개 틀 셋·자리 2개 틀 둘이 있고 정답이 자리 1개면 같은 묶음 보기가 모두 자리 1개, 같은 자리 수 후보가 모자라면 다른 자리 수로 채움.
  - 빈칸: 관사·주어 대명사는 비우지 않음, 전치사·be동사·축약형은 비움, 시도 수 t가 늘면 다음 고정 낱말(후보 수로 돎), 낱말 뒤 문장부호는 빈칸 밖, 후보 없음 → 출제 안 함, 오답 보기에서 정답과 같은 낱말(`normalizeTemplateWords` 뒤 `sameTemplateWord` — 대소문자·축약형 차이)·이 틀의 고정 낱말·넣으면 다른 틀이 되는 낱말이 빠짐. 검토 S7: 고정 부분에 **두 번** 나오는 낱말은 후보가 아님(지어낸 `{사람} said yes, then said {대답}.` — `said` 제외), 보기 대소문자는 `before`가 비었을 때(여는 따옴표뿐 포함)만 대문자 머리이고 **자리로 시작하는 틀**의 첫 고정 낱말은 소문자.
  - 통계: 고르기 세 모드가 서로 섞이지 않음, 같은 날 ○○ → 연속 1(오늘 ○ 배지), 다른 날 ○○ → 졸업, 말하기 세션이 고르기 통계를 바꾸지 않고 고르기 세션이 말하기 통계·`templatesByWeakness`·익힘·`toeicTemplateWrongKeysAnyMode`·`recentTemplateTests`를 바꾸지 않음(양방향 반례).
  - ② 카드 칩: 고르기 세 모드 중 틀린 모드 수 = 칩 숫자, 0이면 칩 없음, 고르기 졸업만 있는 틀 → 칩 없음(검토 반영).
  - 기록 라우트: `mode` enum 다섯, 고르기 모드 `items` 20 통과·21 거부, 말하기 모드 11 거부(기존), 멱등 세 갈래 그대로. 러너 저장 본문 만들기: 답한 문항이 0인 모드는 본문을 만들지 않음, 판 전체 0 → 본문 0(검토 S7).
  - 러너 주소: `scope=step|group`의 `i`가 번호 → 범위, 범위 밖 번호 → 유형 전체, 주소 만들기 함수가 단계·묶음 이름을 싣지 않음(검토 S13).
  - 정규화·스트릭: `normalizeToeicQuizRecord`가 다섯 모드를 받고 모르는 모드는 버림. **`eval:streak` ⑦을 고친다**(검토 S2 — 그대로 두면 깨진다): 라벨 배선 정규식(`labelWired`)을 `isToeicTemplateBankMode(mode) ? TOEIC_TEMPLATE_BANK_MODE_LABELS_KO[mode]` 형으로, eval 이름표(`names.templateModeKo`)를 다섯 모드로 넓히고, "영어 트랙"에 고르기 세션 라벨 `템플릿 훈련 · 한→영 고르기` 한 줄을 더한다(⑥ 배선 정규식은 그대로).
  - 화면 닫기(소스 대조): 공략 세트의 시험 세 페이지가 폴더 `?tab=quiz`로 보냄, ③ 탭이 표현 목록 컴포넌트를 쓰지 않음(①이 읽기 전용으로 씀), ② 카드가 유형 공략 세트 세션을 읽지 않음, 표현 시험 저장 라우트 불변.
  - 번들 경계: `lib/toeic-template-quiz.ts`를 목록에 등록(`/ai/`·`/store`·`openai`·`zod` 값 import 금지·lookbehind 금지 — 런타임 import는 `lib/toeic-template`·`lib/toeic-quiz`·`lib/toeic-text`·`lib/vocab-quiz`·`lib/vocab-mastery`·`lib/kst`뿐).
- **🧩 틀 점검**(검토 B4)
  - `templatesCouldHaveUsed` 반례: 모범답변 틀 6개·내 틀 0·빠진 단계 4·피드백 2 → 결과 앞 4개가 `step`(단계 순서), 다섯째가 `feedback` 첫째, `sample`은 잘림. 빠진 단계의 key는 그 단계에서 모범답변이 쓴 틀이 있으면 그것, 없으면 가장 약한 틀(`drillTemplateCheck` 단위 — 지어낸 은행·흐름). 빠진 단계 0·피드백 1·모범답변 2 → `feedback` → `sample` 순. 채점 전 → `sample`만(옛 결과와 같음). 내 틀은 어느 출처에서도 빠짐. 최대 5 그대로.
  - 기존 항목 "쓸 수 있었던 틀 = 모범답변 사용 → `tryExpressions` → 빠진 단계 순"(§12-10, `eval-toeic-guides.ts`)은 **이 순서로 교체**한다(인자 이름 `sampleKeys`).
  - `toeicTemplateCheckSummary`: 채점 3문항(틀 쓴 문항 2) + Q3–4 빠진 단계 1 + Q11 빠진 단계 2 → "2/3 · 3", 채점 0 → null.
- **퇴역·교체할 기존 항목**(검토 S1 — 그대로 두면 깨지거나 옛 동작을 잠근다. 파일은 지우지 않으므로 `readFileSync`가 ENOENT로 eval 전체를 죽이는 일은 없다):
  - `eval-toeic-guides-app.ts`: `clientFiles` 목록의 표현 목록 컴포넌트(남는다 — 읽기 전용으로 바뀐 내용에 맞춰 대조 문장만 고친다), "③ 표현 🔊"(→ "① 교재 표현 목록 🔊 탭만·프리페치 없음"), "📘 expression → ③ 탭 `?expr=`"(→ `?tab=read&goto=k:{key}`), `findGuideExpressionIndex` 항목(함수를 지우면 퇴역).
  - `eval-toeic-guides-s2.ts`: 시험 페이지 공략 갈래 3건(상한 20·말하기 weakness·공략 안내 문구 — 페이지가 폴더 `?tab=quiz`로 보내므로 리다이렉트 대조로 교체), "③ 탭 버튼"(→ 틀 시험 탭 대조).
  - 옛 `pickExpressionsForDrill` 모양 항목(`eval-toeic-guides.ts` 7곳·`eval-toeic-guides-s3.ts` 2곳) → 위 새 모양 항목으로.
  - `eval-toeic.ts` "호출 C 조립" 항목 → 위 "시스템 프롬프트 조립"으로.
- **실제 가져오기 파일**(있으면 — 개수만): 유형별 `alternates` 수, ① 외울 틀 줄 수·접는 줄 수·통째 접는 블록 수·**`bareBlocks` 수와 그 조각 줄 수·`framePicks` 줄 수**, 유형별 답변 흐름 틀 수(단계/소재)와 `formatAnswerFlow` 글자 수(최대), 고르기 모드별 낼 수 있는 문항 수와 `skipped`, `guideReadFrameKeys` 크기 대 그 유형 틀 수. 내용은 찍지 않는다.
- **실호출 점검(게이트 `EVAL_TOEIC=1` — 사용자 동의 뒤 오케스트레이터)**: 새 게이트를 두지 않는다. 기존 C 파트 1회(기본 opinion)와 D 1회(Q11 픽스처)에 **지어낸 흐름**(단계 다섯·소재 둘 — 지어낸 틀)을 넣어 같은 횟수로 부른다. 지어낸 흐름의 시작·마무리 틀은 **과제 절의 따옴표 예시와 다른 글자**로 만든다(지어낸 예: 시작 `Personally, I side with ~`, 마무리 `To wrap up, I ~` — §4-6의 `For these reasons, ~`와 다르게. 검토 반영 — 같은 글자면 과제 절과 흐름의 충돌이 시험되지 않는다).
  - C 보고(FAIL 아님 — 알림): zod 통과(기존) + `checkAnswerAgainstFlow`(단계 a/b·순서 — 기준 `TOEIC_ANSWER_FLOW_STEP_MIN_RATIO`: Q3–4·Q11 단계 75% 이상, 그 밖 틀 1개 이상), **과제 절 예시 글자(§4-3·§4-5·§4-6의 따옴표 영어) 출현 여부**, 단어 수 대 과제 절 범위, 단계당 쓴 틀 수, 소재 틀 수.
  - D 보고: 점수 범위(기존) + 개선 답변의 `checkAnswerAgainstFlow`·단어 수.
  - 두 호출 모두 `ms`와 입력·출력 토큰을 함께 찍어 옛 실측과 비교한다(검토 S11 — 60초 여유는 실측으로만 안다. 재요청 여부는 토큰 합으로 추정). 호출 수는 늘리지 않는다.
  - 15·30초 문항에서 한 단계에 틀을 여럿 늘어놓는 경향이 보이면 흐름 규칙에 "짧은 답은 단계마다 틀 하나가 기본"을 더하는 것을 prompt-tuner가 검토한다(지금은 넣지 않았다 — 실측 전).
- 공용 모듈을 고치지 않으므로 `eval:speech`는 회귀 확인만, `eval:streak`은 위 ⑦ 수정과 한 줄. `lib/vocab-quiz.ts`의 `buildChoices`는 재사용만 한다(고치지 않는다).

#### 12-13-6. 함수·상수가 사는 곳

| 곳 | 무엇 | 경계 |
|---|---|---|
| `lib/toeic-template.ts` | `templateAlternateLinks`·`guideExpressionKeysInFlow`·`frameEndsWithSlot`, `buildAnswerFlow`·`buildMockAnswerFlows`(네 파트 흐름 — 검토 B1)·`answerFlowExpressions`·`answerFlowMatchFrames`·`checkAnswerAgainstFlow`·`isWeakFlowCheck`, 상수 `TOEIC_ANSWER_FLOW_FRAMES_MAX`(60)·`TOEIC_ANSWER_FLOW_STEP_MIN_RATIO`(0.75 — 화면 경고와 실호출 점검이 같은 값). `templatesCouldHaveUsed` 새 순서(step → feedback → sample, 인자 `sampleKeys`). 통계 도우미 공개 `aggregateTemplateStatsByModes`·`templateBadgesByModes`·`templateAttemptCounts`(말하기 함수 결과 불변) | 클라이언트 안전 — 경계 그대로 |
| `lib/toeic-template-quiz.ts`(새) | `koFrameToTilde`·`templateClozeTarget`·`buildTemplateChoiceQuestions`·`aggregateToeicTemplateChoiceStats`·`toeicTemplateChoiceWrongKeys`·`toeicTemplateChoiceBadges`·`recentTemplateChoiceTests`, 상수 `TOEIC_TEMPLATE_CHOICE_MAX`(20 — 검토 S12로 이름을 바꿨다)·`TOEIC_TEMPLATE_CLOZE_SKIP_WORDS` | 클라이언트 안전(번들 경계 목록에 등록). `lib/toeic-template`·`lib/toeic-quiz`를 import하고, 둘은 이 모듈을 import하지 않는다(순환 금지) |
| `lib/toeic-quiz.ts` | 고르기 모드 목록·타입·라벨·판정, 합친 다섯 모드 목록·타입·라벨·판정, `ToeicQuizSessionLike.mode` 넓히기 | 기존 경계 그대로 |
| `lib/toeic-guide.ts` | `toeicGuidePartOfMockPart`, 대본 옵션 타입 `ToeicGuideScriptSkip`(`blocks`·`lines`·`bareLeads`·`picks`), `toeicGuideLeadPieces` | 기존 경계 그대로 |
| `lib/toeic-guide-view.ts` | `guideReadMarks`(`bareBlocks`·`framePicks` 포함)·`guideReadFrameKeys`, `findGuideGotoBlock`·`guideReadInitialOpen`의 `k:` 갈래(선택 인자 `marks`), `guideRefHref(ref, key)`, 상수 `TOEIC_GUIDE_GOTO_KEY_PREFIX`("k:"), 탭 이름 `TOEIC_GUIDE_TAB_LABELS_KO.quiz` = "👀 틀 시험", ③ 러너 주소 만들기(번호 `i`) | 클라이언트 안전 |
| `lib/toeic-drill-view.ts` | `toeicDrillCheckData` → `toeicTemplateCheckData`(파트마다), `drillTemplateCheck`의 빠진 단계 key 고르기(모범답변 틀 우선), `toeicTemplateCheckSummary`(모의고사 결과 머리 줄), 준비 접기 자료(단계마다 첫 틀 + 전부), 모범답변 점검 문구·미달 경고 | 클라이언트 안전 |
| `lib/ai/toeic/prompts.ts` | 바뀐 원문 셋(§4-7·§5-1·§5-2)과 새 원문 `TOEIC_MOCK_FLOW_RULES`(§4-1 둘째 블록), `buildMockSystemPrompt(part, hasFlow)`, 플레이스홀더 `answerFlow` 둘, `formatAnswerFlow`, `ToeicMockUserMessageInput.answerFlow` | 서버·eval |
| `lib/ai/toeic/mock.ts` | `buildFeedbackInput`의 흐름, `pickExpressionsForDrill` 새 모양(`toMockRecordPart`·`postprocessFeedback`는 받은 허용 목록을 쓴다 — 시그니처 그대로) | 서버 전용 |
| `lib/ai/toeic/calls.ts` | `generateMockPart`(시스템 프롬프트 `hasFlow`, 허용 목록 = 흐름 틀 앞 + 정규화한 활용할 표현), `generateFeedback`(허용 목록 = 흐름 틀 앞 + `expressions`, 흐름은 `expressions`에 섞지 않는다) — 검토 S4 | 서버 전용 |
| `lib/ai/toeic/schemas.ts` | `ToeicAnswerFlow`·`ToeicAnswerFlowFrame`·`ToeicTemplateAlternate` 타입, 틀 은행 내용(`toeicTemplateBankContent` — `alternates` 포함), 기록 본문 zod의 모드 다섯·`items` 상한 갈래, `hasUnfilledSlot`(C2~C5 `sampleAnswer`·D `improvedAnswer`·`fixes[].better` zod) | 서버·eval |
| `lib/ai/toeic/guide-import.ts` | `planToeicGuideImport`가 `alternates`를 만들고 지문에 넣는다 | 서버 전용 |
| `lib/toeic-normalize.ts` | 틀 은행 `alternates`, 모의고사 `answerFlows`, 시험 세션 모드 다섯 | 정규화 단일 정의처 |
| `lib/toeic-guide-contract.ts` | 기록 요청 `mode` 넓히기, `ToeicAnswerFlow` 타입 재수출 | 계약 파일(타입만) |
| `components/toeic-template-quiz-tab.tsx`·`toeic-template-quiz.tsx`(새), `app/toeic/guides/[part]/templates/quiz/page.tsx`(새) | ③ 탭·러너·서버 페이지 | 클라이언트 / 서버(`force-dynamic`) |
| `components/toeic-guide-expr-list.tsx` | ③ 탭에서 ① 끝 "📘 교재 표현 목록"으로 옮겨 **읽기 전용**(시험 버튼·`?expr=`·프리페치 제거). 지우지 않는다 | 클라이언트 |
| `components/toeic-guide-read-view.tsx`·`toeic-template-view.tsx`·`toeic-guide-folder-view.tsx`·`toeic-drill-view.tsx`·`toeic-attempt-view.tsx`·`toeic-mock-detail-view.tsx`, `app/toeic/guides/[part]/page.tsx`·`app/toeic/attempts/[id]/page.tsx`·`app/toeic/sets/[id]/{quiz,wrong,history}/page.tsx`, `app/api/toeic/{mocks,mocks/[id]/regenerate,guides/[part]/drills,guides/templates/sessions}`·`app/api/streak/route.ts` | 화면·라우트 배선(위 각 절) | 기존 경계 그대로 |

#### 12-13-7. 구현 동기화 (2026-10-02 — T13~T15 구현 · 통합 QA 반영)

같은 날 ai-engineer(T15 + 순수 층·zod·정규화·가져오기·eval) → app-builder(화면·라우트·스토어 배선) → qa-inspector 통합 QA 순으로 끝났다. 근거는 `_workspace/build_ai-engineer_toeic-template-centric_report.md`·`build_app-builder_toeic-template-centric_report.md`·`qa_report_toeic_template-centric-ai_1.md`·`qa_report_toeic_template-centric-full_1.md`이고, 이 절은 그중 **코드로 확인한 것**만 옮긴다. 스펙이 비워 둔 곳은 구현이 정했고, 그 결정을 여기 적어 다음 작업이 옛 문장대로 되돌리지 않게 한다(§번호는 그대로 — 위 절의 정정은 그 자리에 "구현 기준 정정"으로 남겼다).

**검증(무비용)**

- `eval:toeic` 오프라인 **1167 PASS · 0 SKIP**(재정렬 전 985). spec-sync 원문 15/15, JSON Schema 8 의미 동치, 호출 옵션 문장 대조 그대로. 새 영역은 `scripts/eval-toeic-template-centric.ts`(① 읽기 정렬·③ 틀 시험·답변 흐름·모범답변 점검·🧩 틀 점검 새 순서·레코드 정규화·가져오기·파일 저장소 왕복·라우트/앱 소스 대조 26·번들 경계·실제 파일 개수)와 `eval-toeic.ts`의 "템플릿 중심 — 호출 C·D 흐름". 퇴역 대상(§12-13-5)은 같은 자리에서 교체했다.
- 회귀(오프라인): `eval:streak` 56(⑦ 라벨 배선이 다섯 모드) · `eval:speech` 168 · `eval:english` 639 · `eval:japanese` 220 · `eval:math` 51(+1 SKIP) · `eval:workout` 189.
- `npm run build` 통과 — 새 경로 `ƒ /toeic/guides/[part]/templates/quiz`. 클라이언트 번들에 흐름 규칙 원문·`hasUnfilledSlot`·`toeicGuideFileSchema`·`pickExpressionsForDrill`·`buildMockAnswerFlows`·`node:crypto`가 없다.
- 통합 QA: P1·P2 0, P3 6(아래). 루프백 스텁(`sk-stub`)과 실제 가져오기 파일을 넣은 로컬 파일 DB로 네 유형 × Chromium·WebKit(폰 390×844 · iPad 가로 1180×820)을 돌렸고, 스텁이 받은 요청 본문을 라이브러리 함수로 다시 만들어 대조했다 — 호출 C 44건·D 43건의 "답변 흐름" 칸이 폴더의 틀과 같은 집합이고 저장 흐름과 글자까지 같다. 흐름 틀은 `활용할 표현:` 줄에 0이다.

**구현이 정한 것(스펙 공백 — 코드 기준)**

1. **오답 보기 자리 수 우선은 층을 넘는다**(§12-13-2 정정). 빈칸의 낱말 보기에는 자리 수 우선이 없다.
2. **① 통째 접기 범위** — list 머리말이 대안이어도 같은 블록에 외울 틀 줄이 섞이면 통째로 올리지 않고 줄 단위로 접는다(외울 틀을 접기 안에 숨기지 않는다). `text` 블록은 제목·본문이 없을 때만 통째로 올린다(규칙 7 "교재 설명·팁은 그대로"와 맞춘다).
3. **① 머리 줄 m** = `guideReadFrameKeys(marks)`(본문 외울 틀 줄의 합집합). 실측 n·m = 21·19 / 39·13 / 27·9 / 39·18. 끝 "📘 교재 표현 목록"에만 이어진 틀은 세지 않는다(§12-13-1 정정).
4. **① 한 줄에 외울 틀이 여럿이면** 틀마다 틀 줄 한 행(각자 칩·탭 🔊)이다. 블록 통째 접기 요약 안의 "외울 틀: …" 칩은 누르면 ② 카드로 가고 접기는 여닫지 않는다. 템플릿 블록에서 줄을 접어 뺄 때 "또는"은 앞에 보인 줄이 있을 때만 보인다.
5. **③ 출제 함수의 선택 칸 `flow`** — `buildTemplateChoiceQuestions(scope, partTemplates, sessions, { modes, onlyWrong, max, rng, flow })`. "같은 단계" 층은 흐름이 있어야 가를 수 있다(없으면 ① 같은 묶음 → ③ 나머지). 서버 페이지가 그 유형 흐름을 넘겨 **한 번** 조립하고 문항 칸만 내린다.
6. **③ 빈칸 오답**은 다른 틀의 빈칸 후보 전부에서 고른다(그 틀의 t번째 하나만이 아니다 — 보기가 모자라지 않게). 보기 대소문자는 자리 앞 글이 비면 첫 글자 대문자, 아니면 낱말 전체 소문자(약어·`I`는 그대로)이고 정답에도 같은 변환을 건다. 알려진 틈: 문장 가운데 고유명사도 소문자가 된다.
7. **③ 탭·러너** — 모드·범위·틀린 틀 전환은 `role="tab"`이 아니라 `aria-pressed` 버튼이다(폴더 탭과 섞이지 않게). 모드 칩의 "낼 수 있는 문항 수"는 클라이언트가 세션 없이 고정 rng로 센다(서버 왕복 0 — 출제 가능 여부는 세션과 무관). 저장 본문은 `buildTemplateChoiceSessionBodies`(모드마다 한 건, 답한 문항이 0인 모드는 생략, 같은 `startedAt`), "다시 저장"은 같은 멱등 키로 모드 전부를 다시 보내고 이미 저장된 모드는 서버가 `reused:true`로 접는다. ② 카드 칩 "👀 ✕ n"의 n은 `toeicTemplateChoiceWrongModeCounts`(틀린 모드 수 — 0이면 칩 없음).
8. **호출 C의 read 방어** — `generateMockPart`는 read 파트에 흐름을 넘겨도 null로 본다(흐름 규칙·흐름 블록이 붙지 않는다).
9. **흐름 실패 격리** — `buildMockAnswerFlows(bank, templatesByPart, onError?)`의 셋째 인자가 한 파트 예외를 그 파트만 빼고 알린다. 모의고사 라우트(`mockAnswerFlowsFrom` — 이미 읽은 `listToeicSets()` 결과에서 틀 은행을 찾는다, 읽기 추가 0)는 그 밖의 예외도 흐름 없이 계속한다(500이 아니다). 로그는 예외 이름과 "흐름 단계 n · 틀 m" 개수만이다.
10. **학습 보기 "🧩 이 파트 답변 흐름"** 접기는 저장된 흐름의 `~` 형태를 그대로 보인다(틀 은행을 다시 읽지 않는다 — 재현성). 틀마다 ② 카드 링크가 붙고, 흐름이 없는 옛 문서에서는 접기가 없다. 모범답변 점검 줄은 `answerFlowCheckLine`, 미달 경고 문구는 `TOEIC_ANSWER_FLOW_WEAK_KO`, ④ 준비 접기는 `drillPrepFlowFold`다(모두 `lib/toeic-drill-view.ts`).
11. **모의고사 만들기 칸 안내** — 틀 은행이 있을 때만 "🧩 유형별 공략의 외울 틀 n개로 Q3–11 모범답변을 단계마다 조립해요 …"(같은 세트 목록에서 센다 — 읽기 추가 0). 응답 shape는 바뀌지 않았다(라우트 계약 그대로).
12. **옛 이름·옛 갈래** — `toeicDrillCheckData`·`ToeicDrillCheckData`는 `toeicTemplateCheckData`의 별칭으로 남는다. 표현 시험 세 페이지의 유형 공략 갈래(상한 20·말하기 weakness·교재 문장 말하기)는 리다이렉트 뒤에 닿지 않아 지웠다 — `lib/toeic-quiz.ts`의 `quizOrder`·`max` 옵션은 그대로 남는다. 유형 공략 세트의 옛 시험 세션은 지우지 않았다(스트릭 과거가 그대로).

**저장·배포**

- 실전 모의고사는 일부 파트만 골라도 read를 뺀 **네 파트 흐름**을 `answerFlows`에 저장한다(e2e 실측 4). 연습은 `[그 파트 흐름]`이다. 옛 문서는 정규화가 `[]`로 읽어 옛 동작 그대로다.
- 배포 뒤 아빠가 **같은 공략 가져오기 파일을 한 번 다시 넣어야** ① 접기가 생긴다(틀 은행만 "고침 1", 유형 넷은 그대로, 틀 key·틀 테스트 기록 불변). 그 전에는 ① 머리 범례 자리에 다시 가져오기 안내가 뜬다. QA가 이 전환을 로컬에서 재현했다(안내·접기 0 → 다시 가져오기 → `alternates` 55·접기 생김 → 한 번 더 넣으면 전부 그대로).
- 스펙·AI 층·앱 층은 한 커밋으로 묶는다(문서만 먼저 나가면 spec-sync가 붉다).

**남은 틈 — QA P3(배포를 막지 않는다, 열림)**

| # | 무엇 | 지금 영향 | 담당 |
|---|---|---|---|
| P3-A | ③ 러너 끝 화면이 저장 중에도 "틀린 틀만 다시"·"다시 풀기"를 누를 수 있다(② 끝 화면은 저장 중 링크를 막는다). 저장이 늦으면 새 판이 저장 전 세션으로 조립돼 "다시 볼 틀린 틀이 없어요"가 뜬다. 버튼의 n은 이번 판에서 틀린 수이고 새 판은 그 모드에서 틀린 미졸업 틀 전부라 숫자가 다를 수 있다 | 저장·통계는 오염되지 않는다 | app-builder |
| P3-B | 채점 전 결과 접기 요약 "모범답변의 틀 n"(제안 수 — 상한 5, 지금 틀 은행 되짚기)과 모범답변 점검 줄 "틀 n개"(저장 흐름 기준)가 같은 문항에서 다를 수 있다(소재 틀이 많은 Q11에서 흔하다) | 표시만 | app-builder |
| P3-C | ① list·text 블록 통째 접기 판정이 어디에도 연결 없는 보통 줄을 판정에서 빼서, 보통 줄이 섞인 블록도 통째로 접힐 수 있다 | 실데이터 0건 | ai-engineer |
| P3-D | ③ 빈칸 후보에 자리에 붙은 조각이 들어갈 수 있다 | 실데이터 0건 | ai-engineer |
| P3-E | 단계·소재가 모두 빈 흐름이 정규화를 통과해, 다시 만들기의 흐름 규칙 유무와 사용자 메시지 `없음`이 어긋날 수 있다 | 손상 문서 한정 | ai-engineer |
| P3-F | 스펙 산문 두 곳(오답 보기 자리 수 우선 범위·① 머리 줄 숫자)이 구현과 달랐다 | 이 개정에서 고쳤다(§12-13-1·§12-13-2·§12-12 37) | 문서 |

**관찰(결함 아님)**

- 공통 틀은 폴더를 넘어 통계가 하나다(§12-5-6) — Q5–7 ③에서 틀린 공통 틀이 Q11 ③ 틀린 틀과 ② "👀 ✕" 칩에도 보인다.
- 모범답변 점검은 근사다(두 낱말 이상 고정 조각 일치) — 틀을 쓰지 않은 답도 흔한 조각이 우연히 맞으면 "틀 1개"로 잡힌다. 화면 경고는 이 측정과 정확히 같다.

**미검증(이유와 함께)**

- 실호출 품질 — `EVAL_TOEIC=1`(사용자 동의 뒤, SPEC §20-10 확인 15): 모범답변·개선 답변이 흐름 단계·틀 글자를 실제로 따르는가, Q5·Q8 개선 답변 길이, 과제 절 예시 글자 대신 외운 틀로 시작하는가, 채우지 않은 자리 재요청 빈도, 입력이 늘어난 뒤의 지연·토큰. 스텁은 흐름 첫 틀을 일부러 넣으므로 이것을 대신하지 못한다.
- 실제 Firestore — `answerFlows`·`alternates`·틀 시험 세션의 코덱(정규화 경로는 코드로, 배열 속 배열 0은 eval로 확인). 배포 뒤 첫 "같은 파일 다시 가져오기"가 프로덕션의 첫 확인이다.
- iPhone 실기기(SPEC §20-10 실기기 13~16)와 실제 소리(헤드리스는 음소거 — 재생 이벤트·요청 글로만 판정).

---

## 13. 내 녹음 서버 보관 + 비교 (2026-10-03)

> 제품 흐름·비용·실기기 확인은 SPEC §20-11에 있다. 이 절은 **저장 위치·업로드 계약·레코드 필드·기기 대기열·삭제·비교 화면 판단·eval**을 정한다. 새 AI 호출과 새 프롬프트는 없다. spec-sync 대상(원문 15 + JSON 8 + 호출 옵션 문장)도 그대로다. 이 절의 문장 예시는 모두 지어낸 것이다.
>
> **구현 반영(2026-10-03, R1~R5)** — 이 절이 바꾼 옛 문장(§0-2 "녹음" 줄, §7-5, §5-0, `lib/toeic-rec-store.ts` 머리 주석, SPEC §1·§13·§20-4~§20-6)은 같은 작업에서 고쳤다. 구현이 정한 스펙 공백은 §13-14에 있다. 인프라(§13-11 I1~I5)는 오케스트레이터 몫이다 — 버킷이 없으면 프로덕션 업로드는 500 `storage_failed`로 끝나고 녹음은 기기 대기열에 남는다(잃지 않는다).

### 13-0. 결정 (사용자 확정 2026-10-03)

사용자 원문: "토익스피킹 모의고사는 내 음성도 저장해서 비교해볼 수 있게 하자."

| 항목 | 결정 | 출처 | 근거 |
|---|---|---|---|
| 무엇을 보관하나 | **아빠의 모의고사 응시와 한 문제 연습 응시**의 답변 녹음(같은 `toeicAttempts`) | 요구 | 비교의 재료다. 틀 테스트(§12-5)·마이크 점검 녹음은 넣지 않는다 — 틀 테스트는 응시 기록이 없고 전사만 하고 버리는 연습이다 |
| 어디에 | **서버** — Google Cloud Storage 비공개 버킷. 어느 기기에서나 들을 수 있다 | 요구 | Firestore 문서는 1MiB가 상한이라 오디오를 담을 수 없다 |
| 얼마나 | **기간 제한 없이 모두**. 수명 주기 규칙을 두지 않는다 | 요구 | — |
| 원칙 변경 범위 | "녹음은 서버에 두지 않는다"(§0-2·§7-5, SPEC §1·§13·§20-4·§20-6)를 **아빠 모의고사·한 문제 연습 녹음에 한해** 바꾼다. 은우 쪽은 그대로다 — 자유대화 음성은 계속 저장하지 않는다(SPEC §21) | 요구 | 학습자가 성인 본인이고, 비교가 목적이다 |
| 비교 | ① 내 답 → 개선 답변(없으면 모범답변) 이어 듣기 ② 글자 나란히(내 전사문 ↔ 모범답변, 내가 쓴 틀·빠진 단계 표시 — 🧩 틀 점검 함수 재사용) ③ 같은 문제 다시 풀기 기록 비교(같은 `mockId`·같은 `q` — 지난 녹음 ↔ 이번 녹음, 점수 변화) | 요구 | — |
| 기기 녹음(IndexedDB) | 지우지 않는다. **업로드 대기열 + 빠른 재생 캐시**로 역할이 바뀐다 | 기본값 | 응시 중 네트워크가 끊겨도 녹음을 잃지 않으려면 기기에 먼저 있어야 한다 |
| 업로드 시점 | **문항 녹음이 끝날 때마다 백그라운드로** 올린다(응시 중). 실패한 것은 기기 대기열에 남겨 다음 기회에 다시 올린다 | 기본값 | §13-3 |
| 저장 형식 | **녹음한 원본 그대로**(iPhone `audio/mp4` AAC, 그 밖 webm/ogg opus). 채점용 WAV는 저장하지 않는다 | 기본값 | §13-2 |
| 재생 경로 | PIN 게이트 뒤 **프록시 라우트**(`GET …/recordings/[q]`). 서명 URL·공개 URL은 쓰지 않는다 | 기본값 | §13-4 |
| 기존 기기 녹음 이행 | 이미 기기에 있는 녹음(풀마다 최근 5회분)도 **올린다** | 기본값 | 그 기기에만 있는 유일한 사본이다 — §13-6 |

### 13-1. 저장 위치 — 버킷·경로·백엔드

- **버킷**: `gs://eunwoo-bookcard-toeic-rec`. 위치 `asia-northeast3`(Cloud Run과 같은 리전 — 리전 간 전송이 없다), 클래스 Standard, **균일한 버킷 수준 접근**(객체 ACL 없음), **공개 접근 방지 강제**, 객체 버전 관리 끔, 수명 주기 규칙 없음, 소프트 삭제는 GCS 기본값(7일)을 그대로 둔다(잘못 지운 녹음을 7일 안에 되살릴 수 있다 — 2026-08-17 사고의 교훈). 생성·IAM은 오케스트레이터가 gcloud로 한다(§13-11).
- **버킷 이름 env** `TOEIC_REC_BUCKET` — 빈 값·공백이면 기본값 `eunwoo-bookcard-toeic-rec`(SPEC §11 빈 값 폴백 관용구 `?.trim() ||`). 비밀이 아니지만 env로 두는 이유는 이름이 이미 쓰이고 있어 다른 이름으로 만들 경우 코드를 고치지 않으려는 것이다.
- **백엔드 선택은 스토어와 하나다.** 녹음 보관소는 `lib/store.ts`의 백엔드 판정(`resolveStoreBackend` — 이번에 export해 한 곳에서 쓴다)을 그대로 따른다. `firestore`이면 GCS, `file`이면 로컬 디렉터리다. 따로 판정하면 "문서는 파일, 녹음은 프로덕션 버킷" 같은 섞인 상태가 생긴다.
  - 로컬 디렉터리: env `TOEIC_REC_DIR`(빈 값이면 `data/recordings`). `data/`는 `.gitignore`·`.gcloudignore`(물려받음) 대상이라 커밋·배포 업로드에 섞이지 않는다. eval은 이 env를 스크래치 디렉터리로 돌린다.
  - 개발 환경인데 GCS(=프로덕션 버킷)를 잡으면 `getStore()`와 같은 경고를 찍는다. 생성·덮어쓰기는 막지 않고(스토어와 같다), 지우기는 prod-guard가 막는다(§13-7).
- **SDK**: `firebase-admin/storage`(`getStorage(app).bucket(name)`). Firestore가 이미 쓰는 같은 앱(ADC — Cloud Run 런타임 서비스 계정)을 쓰므로 **새 의존성이 0**이다. `@google-cloud/storage`는 `firebase-admin`의 전이 의존성으로만 있으니 직접 import하지 않는다.
- **객체 키**(순수 함수 `toeicRecObjectKey(attemptId, q, recordedAtMs)`, `lib/toeic-rec-rules.ts`):

  ```
  attempts/{attemptId}/{q}/{recordedAtMs}
  ```

  - `attemptId`는 `^[A-Za-z0-9_-]{1,64}$`(스토어가 만든 UUID가 통과한다)여야 하고, `q`는 1~11 정수, `recordedAtMs`는 양의 정수다. 어긋나면 키를 만들지 않는다(던진다 — 라우트는 그 앞에서 400). 파일 백엔드에서 경로 밖으로 나가는 키(`..`·`/`)를 이 검사가 막는다.
  - **확장자를 붙이지 않는다.** 형식은 객체 메타데이터(`contentType`)와 응시 기록(§13-5)에 있다.
  - **한 녹음 = 한 객체, 객체는 바꾸지 않는다.** 같은 문항을 "이 문항 다시"로 새로 녹음하면 `recordedAtMs`가 다른 새 객체가 생기고, 응시 기록의 메타가 새 객체를 가리킨다. 같은 경로를 덮어쓰면 늦게 도착한 옛 업로드가 새 녹음을 덮는 경합(객체는 옛것, 메타는 새것)이 생긴다. 키를 녹음마다 다르게 하면 "어느 것이 지금 녹음인가"는 메타 트랜잭션 하나가 정한다.
  - 대체된 옛 객체는 **업로드 라우트가 지우지 않는다** — 업로드 경로에 지우는 동작을 두지 않기 위해서다. 응시가 지워질 때 접두사째 지워진다(§13-7). 다시 녹음은 드물어 비용이 거의 없다.

### 13-2. 형식 · 크기

- **원본을 그대로 보관한다**(녹음기 `recorder.mimeType` — `lib/mic-session.ts`가 고른 것). 근거:
  - 크기 — 원본(AAC·Opus)은 60초에 1MB 안팎이고, 16kHz mono 16-bit WAV는 60초 1.92MB다. 실전 한 회(답변 시간 합 330초)면 원본 약 5MB, WAV 약 10.6MB다.
  - 응시 중 CPU를 쓰지 않는다 — WAV 정규화(`toWav16kMono`)는 디코드·리샘플이라 응시 중(다음 질문 음성·비프 타이밍)에 돌리면 iPhone에서 소리가 밀릴 수 있다. 원본은 이미 Blob으로 있다.
  - 재생 호환 — 가족이 녹음하는 기기는 대부분 iPhone이고 `audio/mp4`(AAC)는 iPhone·iPad·Android·데스크톱 어디서나 재생된다. Chrome·Android가 만든 webm/opus는 iPhone Safari의 재생 지원이 버전마다 달라 **실기기 확인 항목**이다(SPEC §20-11 실기기). 재생에 실패하면 화면이 "이 기기에서 재생할 수 없는 형식(webm)이에요"를 보인다(§13-8).
  - 손실 없음 — 원본에서 WAV는 언제든 다시 만들 수 있지만 반대는 안 된다.
- **채점용 WAV는 저장하지 않는다.** 채점은 지금처럼 클라이언트가 원본을 WAV로 정규화해 `score` 라우트에 올린다(§5-0 1). 다른 기기에서 채점할 때는 서버 사본을 내려받아 같은 정규화를 거친다(§13-8).
- **받는 형식**(`TOEIC_REC_STORE_TYPES`, `lib/toeic-attempt-contract.ts` — 기본 타입, 파라미터 무시): `audio/mp4`·`audio/m4a`·`audio/x-m4a`·`audio/webm`·`audio/ogg`·`audio/wav`(WAV는 장래 대비 — 지금 녹음기는 내지 않는다). 채점 업로드의 `TOEIC_SCORE_AUDIO_TYPES`에는 ogg가 없다(Firefox 녹음은 WAV 정규화를 거쳐 채점된다) — 보관 목록은 별도 상수다.
- **바이트로 형식을 확인한다**(순수 함수 `sniffToeicAudioType(bytes)`): 앞 12바이트로 `mp4`(4~8바이트 `ftyp`) · `webm`(`1A 45 DF A3`) · `ogg`(`OggS`) · `wav`(`RIFF`…`WAVE`)를 가른다. 선언한 타입의 계열과 다르거나 넷 다 아니면 400이다. 저장하는 `contentType`은 **바이트로 판정한 계열의 대표 타입**(`audio/mp4`·`audio/webm`·`audio/ogg`·`audio/wav`)이다 — 클라이언트가 붙인 타입을 그대로 믿어 내려주지 않는다(오디오라고 올린 HTML이 같은 출처에서 열리는 길을 막는다).
- **크기 상한**: 한 파일 `TOEIC_SCORE_AUDIO_MAX_BYTES`(4MB)를 **그대로** 쓴다(새 숫자를 두지 않는다 — 계약 파일의 단일 정의). 가장 긴 Q11(60초 + 녹음 여유 15초 = 75초)이 128kbps라도 1.2MB다. 빈 파일은 400.
- **길이**: 클라이언트가 보낸 `durationMs`는 정수 1 ~ `maxToeicRecordingMs(q)`(`lib/toeic-attempt-rules.ts` — 끝내기 라우트와 같은 상한)여야 한다.

### 13-3. 업로드 시점 — 응시 중 문항마다, 기기를 대기열로

- **문항 녹음이 끝나 IndexedDB에 저장된 직후**(`saveToeicRecording`이 끝난 뒤) 그 녹음을 대기열에 올리고 백그라운드로 보낸다. 근거:
  - 끝낼 때 한꺼번에 보내면 화면이 숨겨지는 순간(pagehide)이 마지막 기회가 되는데, 오디오는 keepalive 본문 한도(진행 중인 keepalive 합 64KiB — app-patterns §16)를 넘어 **보낼 수 없다**. 문항마다 보내면 응시 도중 폰이 꺼져도 끝난 문항은 이미 서버에 있다.
  - 11개를 끝에 몰아 보내면 결과 화면을 여는 순간 대역폭이 몰린다. 문항마다 0.2~1MB씩 나눠 보내면 응시 흐름과 겹쳐도 가볍다. 질문 음성은 시작 탭에서 미리 받아 두므로(SPEC §20-4) 업로드와 다투지 않는다.
  - 업로드는 바이트를 바꾸지 않으므로(정규화 없음) 응시 중 CPU 부담이 없다.
- **기기 대기열 = 녹음 메타의 상태**(`lib/toeic-rec-store.ts` 메타에 필드 둘을 더한다 — IndexedDB 버전·store 이름은 그대로, 업그레이드 없음):

  ```ts
  type ToeicRecUploadState = "pending" | "done" | "gone";
  interface ToeicRecordingMeta {
    // …지금 필드(attemptId·pool·q·mimeType·durationMs·size·createdAt) 그대로
    upload: ToeicRecUploadState;   // 옛 메타(필드 없음) = "pending" — §13-6 이행
    uploadedAt: number | null;     // 서버가 받은 시각(epoch ms). pending·gone이면 null
  }
  ```

  - `"pending"`: 아직 서버에 없다(또는 모른다). `"done"`: 서버가 받았거나(`stored`·`reused`) 더 새 녹음이 이미 있다(`superseded`). `"gone"`: 다시 보내도 받지 않는다(응시·문항이 없음·잠김·형식 거부) — 대기열에서 빠지고, 기기 사본은 캐시로만 남는다.
  - 판정은 순수 함수 `toeicRecUploadStateOf(meta)`(옛 메타 → "pending")와 `nextToeicRecUploadAction(result)`(§13-4 응답 → done·gone·retry)이 한다.
- **대기열 비우기** `drainToeicRecUploads()`(`lib/toeic-rec-upload.ts`, 클라이언트 전용):
  - 모듈 안 진행 중 약속 하나로 **한 번에 하나만** 돈다(중복 호출은 합류). 동시 업로드는 1개다 — 응시 중 질문 음성·녹음과 대역폭을 다투지 않게.
  - `"pending"` 메타를 오래된 순으로 하나씩 읽어 바이트를 꺼내 `PUT`한다. 재시도할 실패(네트워크 예외·5xx·`retriable:true`·401 `locked`)는 한 번의 비우기 안에서 2초·10초·30초 뒤 최대 3번 다시 하고, 그래도 안 되면 그 항목을 남긴 채 멈춘다(다음 계기에 다시).
  - **계기**: ① 응시 화면의 녹음 저장 직후 ② 응시 결과 화면·모의고사 학습 보기·한 문제 연습 폴더(④ 탭)가 열릴 때 ③ 그 화면들이 열려 있는 동안 `online` 이벤트와 `visibilitychange`(보임). 토익 밖 화면에서는 돌지 않는다.
  - **keepalive를 쓰지 않는다**(본문이 한도를 넘는다). pagehide에 남은 항목은 기기에 남아 다음 계기에 간다.
  - IndexedDB를 못 쓰는 환경(프라이빗 모드)은 지금처럼 메모리 폴백이다 — 메모리 사본도 같은 함수로 올리고, 올리기 전에 탭을 닫으면 그 녹음은 사라진다(지금과 같은 한계, 화면이 사실대로 알린다).
- **기기 보관 정리(eviction)가 올리지 않은 녹음을 지우지 않게 한다.** 지금 정리는 풀마다 최근 5회분만 남긴다(§12-7-6). 서버에 없는 녹음을 지우면 영영 잃는다. 그래서 **`"pending"` 녹음이 하나라도 있는 응시는 정리 대상에서 뺀다** — 순수 함수 `toeicRecPinnedAttempts(metas)`(pending이 있는 응시 id 집합)를 구해, 그 응시들을 `pickAttemptsToEvictByPool`에 넘기는 목록에서 먼저 빼고, 나머지에서 지금 규칙(풀마다 최근 5회분 + 지금 응시)을 그대로 적용한다. 고정된 응시는 순위 칸을 차지하지 않는다. 오래 오프라인이면 기기 보관이 5회분을 넘어 늘 수 있다 — 잃는 것보다 낫다.
- **응시 화면 표시**: 진단 캡션에 문항마다 "서버 ✓ / 올리는 중 / 대기"를 더하고, 끝 화면에 "녹음 n개 중 m개를 서버에 보관했어요"(남으면 "나머지는 결과 화면에서 이어서 올려요")를 적는다. 업로드 실패가 응시 흐름을 멈추게 하지 않는다.

### 13-4. 라우트 — 업로드 `PUT` · 재생 `GET`

경로 `/api/toeic/attempts/[id]/recordings/[q]` — `q`는 `^\d{1,2}$`(1~11). **경로 조각에 점을 쓰지 않는다** — `proxy.ts`의 정적 확장자 예외(`STATIC_FILE`)가 PIN 게이트를 건너뛰게 할 수 있다(§12-8 관용구). 지금 그 정규식에는 오디오 확장자가 없지만, 누가 더하더라도 녹음 경로는 확장자가 없으니 열리지 않는다(eval이 둘 다 잠근다 — §13-10). PIN 게이트(`/api/*` 401 `locked`)가 두 라우트 모두에 걸린다. AI를 부르지 않으므로 키 검사가 없다.

**`PUT` — 한 문항 녹음 올리기** (multipart: `audio` 파일, `durationMs`, `recordedAt` — 기기에서 녹음이 끝난 시각 epoch ms 정수. 필드 이름은 계약 상수)

검사 순서: 400(형식 — multipart·q·필드·받는 타입·바이트 판정·빈 파일) · 413(크기) → 404(`attempt_not_found` · `question_not_found` — `attempt.questions`에 없는 q, §12-7-4의 기존 관용구) → 판정(아래) → 객체 쓰기 → 메타 저장(원자 단위).

- **판정** 순수 함수 `decideToeicRecordingUpload(attempt, q, incoming: {sha256, recordedAtMs})`(`lib/toeic-rec-rules.ts`) — 지금 그 문항 메타(`attempt.recordings`의 q 항목)와 그 문항 답(`attempt.answers`)을 보고:

  | 지금 | 들어온 것 | 결과 |
  |---|---|---|
  | 메타 없음 | 무엇이든 | `store` — 닫힌 응시여도 받는다(늦게 온 대기열·이행분) |
  | 메타 있음, 같은 `sha256` | — | `reused` — 쓰지 않고 200(재시도·연타) |
  | 메타 있음, 들어온 `recordedAtMs`가 더 이르거나 같음 | 다른 바이트 | `superseded` — 쓰지 않고 200(이미 더 새 녹음이 있다 — 늦게 도착한 옛 업로드) |
  | 메타 있음, 더 새 녹음, **그 문항이 아직 전사되지 않음**(`transcript === null`) | 다른 바이트 | `store` — 메타를 새 객체로 바꾼다("이 문항 다시") |
  | 메타 있음, 더 새 녹음, **그 문항이 이미 전사됨** | 다른 바이트 | `locked` — 409 `recording_locked`(채점된 녹음과 보관된 녹음이 어긋나지 않게. §5-0 "응시가 끝난 뒤 녹음은 바뀌지 않는다"를 서버가 지킨다) |

  - 열린 응시인지 닫힌 응시인지는 판정에 넣지 않는다 — 다시 녹음은 응시 중에만 생기고, 그 업로드가 끝내기보다 늦게 도착해도 받아야 한다. 잠그는 기준은 "전사됐는가" 하나다.
  - `answers`의 `recorded`가 false인 문항(끝내기가 녹음 없음으로 적은 문항)의 녹음도 받는다 — 목소리를 잃지 않는 쪽이다. 채점 조건(`recorded`)은 바꾸지 않는다.
- 라우트는 판정을 **두 번** 한다 — 객체를 쓰기 전에 한 번(쓸 필요 없는 `reused`·`superseded`·`locked`면 쓰지 않는다), 메타를 쓰는 원자 단위 안에서 한 번 더(두 요청이 동시에 와도 메타를 쓰는 쪽이 하나다). 원자 단위는 스토어 메서드 `setToeicAttemptRecording(id, recording)`이다(파일 `mutate`, Firestore `runTransaction` — §7-5의 채점 저장과 같은 관용구). 판정은 그 안에서 같은 순수 함수를 부른다.
- **순서는 객체 먼저, 메타 나중.** 객체만 쓰이고 메타 저장이 실패하면 대기열 재시도가 같은 키로 다시 쓴다(같은 키 = 같은 바이트, 멱등). 메타가 객체보다 먼저 생기면 "있는 줄 알았는데 없는" 녹음이 생긴다.
- `sha256`은 서버가 바이트로 계산한다(클라이언트 값을 받지 않는다).
- 로그에는 응시 id·q·바이트 수·결과·ms만 남긴다. 바이트·파일 이름은 남기지 않는다.
- 응답(`ToeicRecordingPutResponse`, `lib/toeic-attempt-contract.ts` 단일 정의):
  - 200 `{ ok:true, q, outcome:"stored"|"reused"|"superseded", recording: ToeicStoredRecording }` — `superseded`면 `recording`은 서버에 있는 더 새 녹음의 메타다
  - 400 `{ ok:false, error:"invalid_input", messageKo }`
  - 413 `{ ok:false, error:"audio_too_large", messageKo }`
  - 404 `{ ok:false, error:"attempt_not_found"|"question_not_found", messageKo }`
  - 409 `{ ok:false, error:"recording_locked", messageKo }`
  - 500 `{ ok:false, error:"storage_failed"|"save_failed", messageKo, retriable:true }`
- 기기 대기열의 응답 해석(`nextToeicRecUploadAction`): 200 → done · 404·409·400·413 → gone · 401·500·네트워크 예외·JSON 아닌 5xx(게이트웨이) → retry.

**`GET` — 한 문항 녹음 내려받기**

- 응시(404 `attempt_not_found`) → 그 문항 메타(없으면 404 `recording_not_found`) → 객체(없으면 404 `recording_missing` — 메타는 있는데 객체가 없다. 화면은 "서버 사본이 없어요"로 보이고, 기기에 사본이 있으면 대기열에 다시 올린다) → 200 본문 전체.
- 헤더: `content-type` = 메타의 `mimeType`(바이트로 판정한 것), `content-length`, **`cache-control: private, no-store`**(Firebase Hosting CDN이 PIN 게이트 뒤 응답을 공유 캐시에 담지 않게 — `GET /api/toeic/images/[id]`보다 한 걸음 더 막는다), `x-content-type-options: nosniff`, `content-disposition: inline`. Range는 받지 않는다(늘 200 전체 — 4MB 이하).
- 500 `{ ok:false, error:"storage_failed", messageKo, retriable:true }`.
- **화면은 이 주소를 `<audio src>`에 직접 넣지 않는다.** `fetch` → `Blob` → `URL.createObjectURL`로 재생한다(지금 IndexedDB 녹음을 재생하는 방식과 같다). iOS Safari의 미디어 요소는 Range(206) 응답을 기대하고, 탭 안 `play()` 전에 내려받기가 끝나 있어야 하므로(§13-8) 화면이 미리 받는 편이 단순하다.

**프록시를 고른 이유(서명 URL을 쓰지 않는다)**

- **PIN 게이트가 그대로 걸린다.** 서명 URL은 유효 시간 동안 누구나 여는 링크라 PIN 게이트를 건너뛴다(대화·로그·기록에 남으면 그대로 열린다).
- **권한이 하나 줄어든다.** Cloud Run에는 서비스 계정 키 파일이 없어, 서명하려면 런타임 서비스 계정에 자기 자신에 대한 `roles/iam.serviceAccountTokenCreator`(signBlob)를 더 줘야 한다. 프록시는 버킷 객체 권한 하나면 된다.
- **CORS 설정이 필요 없다.** `fetch`로 Blob을 받으려면 `storage.googleapis.com`에 버킷 CORS를 열어야 한다. 프록시는 같은 출처다.
- **비용·시간 차이가 없다.** 한 파일 0.2~1.2MB라 Cloud Run을 거쳐도 60초 상한과 무관하고, 인터넷 전송 요금은 GCS 직송이든 Cloud Run이든 같은 부류다(§13-9).

### 13-5. 응시 기록에 메타 — `ToeicAttemptRecord.recordings`

```ts
interface ToeicStoredRecording {
  q: number;                 // 1..11 — attempt.questions 안
  objectKey: string;         // §13-1 "attempts/{attemptId}/{q}/{recordedAtMs}"
  mimeType: string;          // 바이트로 판정한 대표 타입(audio/mp4 | audio/webm | audio/ogg | audio/wav)
  size: number;              // 바이트, 1..TOEIC_SCORE_AUDIO_MAX_BYTES
  sha256: string;            // 소문자 hex 64자(서버 계산)
  durationMs: number;        // 기기가 잰 녹음 길이(1..maxToeicRecordingMs(q))
  recordedAt: string;        // 기기 녹음 끝 시각(ISO — 버전 비교에만 쓴다)
  uploadedAt: string;        // 서버가 받은 시각(ISO)
}

interface ToeicAttemptRecord {
  // …§7-5·§12-3 필드 그대로
  recordings: ToeicStoredRecording[];   // 2026-10-03 — q 오름차순, q마다 하나(지금 녹음). 옛 문서 = []
}
```

- **`answers`에 넣지 않고 따로 둔다.** 응시 중에는 `answers`가 빈 배열이고, "닫힌 응시" 판정이 `finishedAt !== null || answers.length > 0`이다(§7-5). 응시 중 업로드가 `answers`에 항목을 만들면 응시가 닫힌 것으로 바뀌어 끝내기가 409로 거절된다. 끝내기(`applyAttemptFinish`)와 채점(`applyAttemptAnswer`)도 `recordings`를 건드리지 않는다.
- 크기: 한 항목 약 250바이트, 11개여도 3KB 안팎이라 문서 1MiB와 무관하다. 배열 속 배열이 없어 Firestore 코덱(§12-3)이 필요 없다.
- 정규화(`normalizeToeicAttemptRecord`, `lib/toeic-normalize.ts`)는 모르는 키를 버리므로 `recordings`를 명시적으로 옮긴다 — 배열이 아니면 `[]`, 항목 모양(q 정수·문자열·숫자 자리)이 깨진 것은 그 항목만 버리고, 같은 q가 둘이면 `recordedAt`이 늦은 것 하나만 남긴다. 생성(`createToeicAttempt` — `New*`가 필수 필드라 tsc가 생성부를 잡는다)은 `[]`로 시작한다.
- **"녹음 서버 보관" 판정은 메타가 있는가 하나다** — `toeicStoredRecordingOf(attempt, q)`. 화면 문구·채점 버튼 자격·비교 버튼이 모두 이 함수를 쓴다.

### 13-6. 기존 기기 녹음의 이행

- 배포 뒤 아빠 iPhone에 남아 있는 녹음(풀마다 최근 5회분 — 모의고사·연습)은 옛 메타라 `upload` 필드가 없다 → `"pending"`으로 읽혀 **처음 토익 화면(§13-3 계기 ②)을 여는 순간부터 대기열로 올라간다.** 별도 버튼·스크립트가 없다.
- 이 녹음들의 응시는 이미 닫혔고 채점된 문항도 있다. 서버에 메타가 없으므로 판정은 `store`다(§13-4 표 첫 줄) — 채점된 문항이어도 처음 한 번은 받는다. 기기의 녹음은 응시 뒤 바뀌지 않았으므로(§5-0) 채점에 쓴 그 녹음이다.
- 응시를 이미 지운 녹음(모의고사 삭제)은 404 → `"gone"` → 정리 대상으로 돌아간다.
- 응시한 기기에서만 일어난다 — 다른 기기에는 옛 녹음이 없다. 그 기기를 열지 않으면 이행되지 않는다(SPEC §20-11에서 아빠에게 안내).
- 프라이빗 모드 메모리 사본은 이미 없다(탭을 닫으면 사라졌다).

### 13-7. 삭제 — 모의고사 삭제의 연쇄에 녹음을 더한다

- 녹음을 따로 지우는 화면·라우트는 두지 않는다(**2026-10-03 §14에서 바뀜** — 결과 화면·"내 녹음" 목록에서 답변 녹음 하나·고칠 문장 녹음 하나·응시 녹음 통째를 지운다. 이 절의 모의고사 삭제 연쇄는 그대로다). 지금처럼 **모의고사(연습 문서 포함)를 지우면** 생성 사진·응시 기록과 함께 그 응시들의 녹음이 지워진다(§7-5·§20-6 연쇄). 응시 하나만 지우는 기능은 지금도 없다(스트릭 과거가 사라진다 — §12-8).
- **순서 — 딸린 것 먼저**: `deleteToeicMock`(두 백엔드)이 그 모의고사의 응시 id를 모은 뒤 ① 응시마다 녹음 접두사 `attempts/{attemptId}/`를 지우고(대체된 옛 객체까지 — §13-1) ② 그다음 사진·응시·모의고사 문서를 지금 순서대로 지운다. ①이 하나라도 실패하면 **문서를 지우지 않고** 던진다 → 라우트 500 `delete_failed`(다시 누르면 접두사 지우기부터 다시 — 이미 지운 것은 0건이라 멱등). 반대 순서면 문서는 사라지고 녹음만 남아, 가리키는 문서 없는 목소리가 버킷에 영영 남는다.
- **prod-guard**: 녹음 보관소의 지우기 함수(`deleteAttemptRecordings(attemptId)`)는 GCS 백엔드일 때 스스로 `assertDestructiveAllowed("deleteToeicRecordings")`를 부른다(새 `DestructiveOp` — 지금 10개 → 11개). `deleteToeicMock`이 이미 먼저 막지만, 녹음 지우기가 다른 자리에서 불려도 막히게 한 겹 더 둔다. 파일 백엔드는 가드가 없다(지금 규칙과 같다).
- 소프트 삭제(7일)로 버킷에서 잘못 지운 녹음을 되살릴 수 있다 — 되살린 녹음을 가리킬 응시 문서는 Firestore 쪽 복구가 따로 필요하다(PITR 꺼짐 — CLAUDE.md 서문).
- **알려진 틈(고아 객체)**: 업로드가 객체를 쓴 직후 같은 응시가 지워지면 메타 저장이 404로 끝나 객체 하나가 남을 수 있다. 업로드 라우트는 지우지 않으므로(§13-1) 남은 객체는 다음 정리 도구 몫이다 — 이번 범위에 정리 도구는 두지 않는다(가족 규모에서 드물고, 크기는 1MB 안팎).

### 13-8. 결과 화면 — 서버 사본 재생 · 다른 기기 채점

- **소리 출처의 우선순위**: 이 기기 IndexedDB 사본 → 서버 사본(`recordings` 메타가 있을 때). 같은 녹음이면 기기 사본이 즉시 재생되고 데이터를 쓰지 않는다.
- **서버 사본은 미리 받는다.** 결과 화면이 열리면 기기 사본이 없고 서버 사본이 있는 문항을 동시 2개로 내려받아 페이지 메모리에 Blob URL로 둔다(언마운트에 `revokeObjectURL`). 받는 동안 ▶는 "불러오는 중…"으로 막는다 — iOS에서 탭 안 `play()` 전에 `await fetch`를 하면 사용자 동작 맥락을 잃어 재생이 거부된다. 실전 한 회 서버 사본은 약 5MB다.
- 형식 재생 실패(`<audio>` `error` — 예: iPhone에서 webm)면 그 문항에 "이 기기에서 재생할 수 없는 형식(webm)이에요 — 녹음한 기기에서 들어 보세요"를 보인다. 채점(WAV 정규화)도 같은 디코더라 실패하면 지금처럼 원본을 올린다(§5-0 1).
- **"AI 채점 받기" 대상**이 넓어진다 — 녹음됐고(`recorded`), 아직 점수가 없고, **기기 사본 또는 서버 사본**이 있는 문항. 서버 사본뿐이면 내려받은 Blob → `toWav16kMono` → `POST …/score`(계약 그대로 — multipart `q`·`audio`). 채점 라우트는 바뀌지 않는다.
  - 채점 라우트가 서버 사본을 직접 읽어 전사하는 길("저장본 채점 모드")은 두지 않는다. 서버에 ffmpeg가 없어 iPhone `audio/mp4`를 그대로 전사에 보내야 하는데, 그 경로가 형식 오류·잘림을 내는 보고 때문에 WAV 정규화를 클라이언트에 둔 것이다(§5-0 1). 내려받기 한 번(0.2~1.2MB)이 그 위험보다 싸다.
- **문구가 바뀌는 곳**: "녹음은 응시한 기기에만 있어요" 계열 셋(머리의 채점 불가 안내, 문항 카드의 "녹음은 응시한 기기에만 있어요.", "녹음 n문항은 이 기기에 없어요") → 서버 사본이 있으면 사라지고, 없을 때만 "이 녹음은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요"로 바꾼다.
- 머리에 한 줄 "🗄️ 녹음 서버 보관 n/m"(m = 녹음된 문항 수). 이 기기에 `"pending"` 녹음이 있으면 "지금 올리기"(대기열 비우기 — §13-3).
- 진단 줄에 "서버 ✓ 312KB · audio/mp4" / "서버 없음"을 더한다(§8 진단 캡션 관용구).

### 13-9. 비교 화면 — 결과 화면의 문항 카드에 셋

새 화면·새 경로는 없다. 결과 화면(`/toeic/attempts/[id]`, `components/toeic-attempt-view.tsx`)의 문항 카드에 접기 하나 **"🎧 비교"**를 두고 그 안에 ①②③을 둔다. 실전 11문항 결과가 길어지지 않게 닫힌 접기다(틀 점검 접기와 같은 관용구 — 연습 결과도 닫힌 채로 시작한다).

**① 이어 듣기 — "▶ 내 답 → 개선 답변"**

- 비교 대상(`pickToeicCompareTarget(question, answer)`, `lib/toeic-compare.ts`, 순수): Q3–11은 AI 피드백의 `improvedAnswer`가 있으면 그것(내 답을 고친 문장이라 차이가 잘 들린다), 없으면 모범답변. Q1–2는 **지문**(내 읽기 → 지문 낭독). 접기 안 칩 "비교 대상: 개선 답변 / 모범답변"으로 바꿀 수 있고, 마지막 선택은 기기 `localStorage` `toeic-compare-target:v1`에 기억한다(try/catch — 실패하면 기본값).
- **iOS 탭 규칙**: 탭 핸들러 안에서 동기로 ① 지금 재생을 모두 멈추고 ② `unlockSpeechPlayback()`(§18-2 — 뒤이은 탭 밖 `speakQueue`가 소리 나게) ③ 화면 하나뿐인 공용 `<audio>` 요소에 내 녹음 Blob URL을 넣고 `play()`. `ended`에서 600ms 쉬고 `speakQueue(enPieces(대상), { … })`(en-US — 결과 화면이 모범답변·개선 답변을 이미 프리페치한다(SPEC §20-5). Q1–2 지문은 그 프리페치 목록에 더한다). ■ 하나가 둘 다 멈춘다(`runRef` 세대 관용구 — 늦게 온 `ended`가 멈춘 뒤 다음 단계를 시작하지 않게).
- 녹음이 아직 내려받는 중이면 버튼을 막는다(위 §13-8 — 탭 안 `await` 금지). 녹음이 어디에도 없으면 버튼을 숨기고 대상만 🔊로 둔다.
- 오디오 세션: 결과 화면은 녹음하지 않으므로 세션을 건드리지 않는다(`lib/mic-session.ts` 밖에서 `audioSession`을 바꾸지 않는 규칙 그대로).

**② 글자 나란히 — 내 전사문 ↔ 비교 대상**

- 왼쪽(폰은 위) "내 답(들린 대로)" = 전사문, 오른쪽(폰은 아래) = ①과 같은 비교 대상. 배치는 CSS 격자 하나 — 768px 미만은 한 열(위아래), 768px 이상(iPad 세로·가로)은 두 열. 페이지 가로 스크롤 없음, 칸 안에서 줄바꿈.
- **틀 표시**(AI 0 — 🧩 틀 점검 함수 재사용):
  - 내 답에서 쓴 틀: `findTemplatesInTranscript`(§12-5-5)와 **같은 일치 규칙**으로 고정 조각의 글자 범위를 돌려주는 새 순수 함수 `templateRunSpans(text, templates)`(`lib/toeic-template.ts` — 같은 모듈 안 `normalizeTemplateWords`·`sameTemplateWord`·조각 찾기를 공유한다)로 칩 색 밑줄.
  - 비교 대상에서 쓴 틀: 같은 함수로 대상 문장의 틀 조각 — **내가 쓰지 않은 틀**은 다른 표시("이 틀을 쓸 수 있었어요")로 구분한다.
  - 빠진 단계(Q3–4·Q11): `drillTemplateCheck`(§12-7-9) 결과의 `missingSteps`를 한 줄로("빠진 단계: 마무리"). "쓸 수 있었던 틀" 목록은 바로 아래 "🧩 틀 점검" 접기에 이미 있으므로 되풀이하지 않고 그쪽으로 링크한다.
  - 틀 은행이 없거나 그 유형 틀이 0이면 표시 없이 글자만 나란히 둔다(틀 점검과 같은 조건).
- Q1–2: 왼쪽 = 전사문, 오른쪽 = 지문, 표시는 지금의 `readDiff`(빠진 단어·바뀐 단어)를 지문 쪽에 입힌다(새 계산 없음).
- 채점 전(전사문 없음): 왼쪽에 "AI 채점을 받으면 내 답이 글자로 나와요"와 오른쪽 대상만. 전사만 따로 하는 버튼은 두지 않는다(비용 원칙 — 전사는 채점 버튼으로만).

**③ 다시 풀기 기록 — 같은 모의고사·같은 문항**

- 대상: 같은 `mockId`의 **다른 응시** 중 닫혔고(§7-5) 그 문항을 녹음한(`recorded`) 것. 실전 응시·유형 연습(파트 응시)·한 문제 연습("같은 문제 다시" — 같은 연습 문서)이 모두 같은 `mockId`를 쓰므로 그대로 모인다.
- 결과 페이지(서버)가 `listToeicAttemptsByMock(mockId)`로 읽어 **줄인 자료**만 넘긴다 — 응시마다 `{id, startedAt, finishedAt, scope, answers:[{q, recorded, score, transcript}], recordings}`(피드백 본문은 넘기지 않는다). 최신 20회까지만 본다(`TOEIC_COMPARE_ATTEMPTS_MAX`).
- 순수 함수 `toeicQuestionHistory(attempts, currentId, q, { max })`(`lib/toeic-compare.ts`): 이번 응시를 포함해 그 문항의 기록을 **시간순**(오래된 → 최신)으로, 최근 `max` = 5개(`TOEIC_COMPARE_HISTORY_MAX` — 이번 응시는 늘 포함). 행마다 `{attemptId, startedAt, isCurrent, score, maxScore, transcript, hasRecording}`. `hasRecording` = 서버 메타가 있거나 이 기기에 사본이 있음(화면이 기기 쪽을 합친다).
- **점수 변화** `toeicScoreDelta(history)`: 이번 점수 − **이번보다 앞선 가장 가까운 채점된** 행의 점수. 어느 쪽이든 점수가 없으면 null. 문항 카드 머리 칩 "▲1 (지난번 2)" / "▼1" / "＝" — null이면 칩 없음. 이번보다 **뒤**의 응시(옛 결과를 다시 연 경우)는 목록에는 보이지만 변화 계산에 쓰지 않는다.
- 접기 안 타임라인: 행마다 "10월 1일 · 2/3 · ▶ · 글자" (이번 행은 "이번"). "글자"는 그 응시 전사문(채점됐을 때만)을 펼친다. 이전 행마다 **"▶ 그때 → 이번"**: 그 응시 녹음 다음 이번 녹음을 이어 튼다 — **같은 공용 `<audio>` 요소**의 `src`를 `ended`에서 바꿔 `play()`한다(iOS는 탭으로 한 번 재생한 요소의 다음 `play()`를 탭 밖에서도 허락한다. 새 요소를 탭 밖에서 만들면 거부된다). 두 녹음은 접기를 여는 탭에서 미리 받는다(§13-8 규칙 — 서버 사본, 기기 사본이 있으면 그것).
- **응시 전체 변화**(결과 머리 한 줄, `toeicAttemptDelta(current, previous)`): 실전 응시는 같은 모의고사의 바로 앞 실전 응시와 **둘 다 추정 총점이 있을 때만** "추정 140 → 150 (+10)". 그 밖(유형 연습·한 문제 연습, 또는 어느 한쪽이 덜 채점됨)은 **둘 다 채점된 같은 문항들의 합**으로 "같은 문항 3개 합 5 → 7"(겹치는 채점 문항이 없으면 줄 없음). 추정 총점은 지금처럼 "추정(참고용)"을 붙인다.

### 13-10. eval (오프라인 — `scripts/eval-toeic-recordings.ts`, `eval-toeic.ts`가 불러 한 번에 돈다, 실호출 0)

모든 바이트 픽스처는 손으로 만든 머리 바이트(+ 0 채움)이고, 문장 픽스처는 지어낸 영어다. 네트워크·GCS를 부르지 않는다 — 파일 백엔드를 `TOEIC_REC_DIR`=스크래치 디렉터리로 돌린다(`STORE_BACKEND=file` 고정).

1. **업로드 계약 zod·바이트 판정**: 받는 타입·빈 파일·4MB 경계(4MB 통과, +1바이트 413)·`durationMs` 경계(0 거부, `maxToeicRecordingMs(q)` 통과, +1 거부)·`recordedAt` 정수 아님 거부·q 0/12/"3.5"/"03a" 거부. `sniffToeicAudioType` — mp4·webm·ogg·wav 머리 각각 통과, 선언 `audio/mp4`인데 webm 바이트 거부, HTML 바이트(`<!doctype`) 거부, 저장 `contentType`이 선언이 아니라 판정 계열(예: 선언 `audio/x-m4a` → `audio/mp4`).
2. **객체 키**: `toeicRecObjectKey` 형식 리터럴, `attemptId`에 `..`·`/`·`.`·빈 값·65자 → 던짐, q 범위, `recordedAtMs` 0·음수·소수 → 던짐. 결과에 점이 없다.
3. **경로·게이트**: 녹음 라우트 파일 경로(`app/api/toeic/attempts/[id]/recordings/[q]/route.ts`)와 화면이 만드는 주소(`toeicRecordingHref`)의 마지막 조각에 점이 없다. `proxy.ts`의 `STATIC_FILE` 정규식이 `/api/toeic/attempts/x/recordings/3`에 맞지 않고, 오디오 확장자(`m4a|mp4|webm|wav|ogg`)를 포함하지 않는다(소스 대조 — 누가 더하면 실패).
4. **판정 표**(`decideToeicRecordingUpload`): §13-4 표 다섯 줄 각각 + 범위 밖 q · 열린/닫힌 응시가 결과를 바꾸지 않음 · `recorded:false` 문항도 `store`.
5. **레코드**: 옛 응시 문서(`recordings` 없음) → `[]`, 깨진 항목만 버림, 같은 q 둘 → 늦은 `recordedAt` 하나. `applyAttemptFinish`·`applyAttemptAnswer`가 `recordings`를 그대로 둔다. 응시 중 `setToeicAttemptRecording`이 `answers`를 만들지 않는다 → 닫힘 판정이 false로 남는다(반례로 잠금 — `answers`에 넣는 구현이면 실패).
6. **파일 백엔드 왕복**: 쓰기 → 읽기 같은 바이트·타입, 없는 키 null, 접두사 지우기가 그 응시만(옆 응시는 남음), 경로 밖 쓰기 시도 거부. 동시 두 업로드(같은 q, 옛 녹음이 늦게 도착) → 메타가 새 녹음을 가리킨다.
7. **삭제 연쇄**: 파일 백엔드 `deleteToeicMock` → 그 모의고사 응시들의 녹음 디렉터리가 사라지고 다른 모의고사의 것은 남는다. 녹음 지우기를 실패하게 한 주입에서 문서가 그대로다(순서 반례). 새 `DestructiveOp` `deleteToeicRecordings`가 유니온에 있고 GCS 지우기 함수 소스가 그것을 부른다(소스 대조).
8. **기기 대기열 순수 함수**: `toeicRecUploadStateOf`(옛 메타 → pending), `nextToeicRecUploadAction`(상태코드·오류 이름 표 전부), `toeicRecPinnedAttempts` + 정리 — pending이 있는 응시는 6번째 이후여도 남고 순위 칸을 차지하지 않는다, done만 있는 응시는 지금 규칙(풀마다 5) 그대로, 풀 분리(§12-7-6) 회귀 없음.
9. **비교 순수 함수**: `pickToeicCompareTarget`(개선 답변 우선·없으면 모범답변·Q1–2 지문), `toeicQuestionHistory`(시간순·최근 5·이번 포함·열린 응시와 녹음 안 된 문항 제외), `toeicScoreDelta`(앞선 가장 가까운 채점 행, 뒤 응시 무시, null 경우), `toeicAttemptDelta`(실전 둘 다 총점 → 총점 차, 아니면 겹치는 채점 문항 합, 겹침 0 → null).
10. **틀 범위**: `templateRunSpans`가 찾은 틀 key 집합 == `findTemplatesInTranscript`의 key 집합(픽스처 여럿), 범위가 글자 안·겹치지 않음·범위의 낱말이 고정 조각과 `sameTemplateWord`로 같음.
11. **소스 대조**: `GET` 라우트가 `private, no-store`와 `nosniff`를 싣는다. 결과 화면 소스에 녹음 API 주소를 `src=`로 넣는 곳이 없다. 업로드 모듈이 `keepalive`를 쓰지 않는다. 클라이언트 번들 경계 — `lib/toeic-rec-rules.ts`·`lib/toeic-compare.ts`·`lib/toeic-rec-upload.ts`는 `firebase-admin`·`lib/store`·`/ai/` 값 import가 없다(기존 "번들 경계" 목록에 등록). 녹음 보관소 모듈(`lib/toeic-rec-blob.ts`)은 백엔드를 `resolveStoreBackend`로만 고른다(판정 함수 두 벌 금지).
12. **회귀**: `eval:streak`(업로드는 스트릭과 무관 — 배선 정규식 그대로), 지금 `eval:toeic` 전 항목.

### 13-11. 인프라 작업 (오케스트레이터가 gcloud로 — 사용자 확인 뒤)

| # | 작업 | 확인 |
|---|---|---|
| I1 | 버킷 생성 — `asia-northeast3`, Standard, 균일 접근, 공개 접근 방지, 버전 관리 끔, 수명 주기 없음 | `buckets describe`에 `uniform_bucket_level_access: true`·`public_access_prevention: enforced`·`location: ASIA-NORTHEAST3`·`lifecycle` 없음 |
| I2 | 소프트 삭제 정책 확인(기본 7일 유지) | `soft_delete_policy.retentionDurationSeconds` = 604800 |
| I3 | Cloud Run 런타임 서비스 계정 확인(비어 있으면 기본 Compute SA) | `services describe … serviceAccountName` |
| I4 | 그 서비스 계정에 **버킷 범위** `roles/storage.objectAdmin`(프로젝트 범위가 아니다) | `buckets get-iam-policy`에 그 한 줄. `allUsers`·`allAuthenticatedUsers` 없음 |
| I5 | (이름이 기본값과 다를 때만) 서비스 env `TOEIC_REC_BUCKET` | 새 리비전 env |
| I6 | 배포 뒤 연기 확인 — 앱에서 짧은 유형 연습 1회 → 결과 화면 "🗄️ 녹음 서버 보관 n/n" → 다른 기기에서 ▶ | 버킷에 `attempts/{id}/…` 객체 |

`github-deployer`(CI) 서비스 계정에는 버킷 권한이 필요 없다(배포는 코드만 올린다). 명령 초안은 빌드 리포트에 있다.

### 13-12. 로드맵

| 단계 | 내용 | AI 호출 | 비고 |
|---|---|---|---|
| **R0** | 인프라 I1~I5 | 0 | 오케스트레이터(gcloud), 사용자 확인 뒤 |
| **R1** | 서버 보관 — 녹음 보관소 두 벌(GCS·파일)·`resolveStoreBackend` export·`recordings` 필드(타입·정규화·생성부)·`setToeicAttemptRecording`·`PUT`/`GET` 라우트·계약·삭제 연쇄·`DestructiveOp`·eval 1~7·11 | 0 | ai-engineer(순수 규칙·eval) + app-builder(라우트·스토어) |
| **R2** | 기기 대기열 — 메타 필드 둘·`drainToeicRecUploads`·계기·정리 고정·이행·응시 화면 표시·eval 8 | 0 | R1 뒤. 실기기: 응시 중 업로드가 소리·타이머를 흔들지 않는가 |
| **R3** | 결과 화면 서버 사본 — 미리 받기·재생·다른 기기 채점·문구·진단 | T·D(채점 버튼 — 지금과 같음) | R2 뒤 |
| **R4** | 비교 ①② — 이어 듣기·글자 나란히·`templateRunSpans`·eval 9(일부)·10 | 0 | R3 뒤 |
| **R5** | 비교 ③ — 다시 풀기 기록·점수 변화·응시 전체 변화·eval 9 | 0 | R3 뒤(R4와 독립) |

R1~R2는 한 커밋으로 묶어도 되지만 R1만 먼저 나가도 해가 없다(라우트만 있고 아무도 올리지 않는다). 스펙(이 절)의 옛 문장 정리(§13 머리말)는 R2와 같은 커밋에서 한다 — 그때부터 "녹음은 기기에만"이 사실이 아니게 된다.

### 13-13. 열린 결정 — 스펙에는 기본값을 썼다

1. **응시 중 업로드**(기본) vs 끝낸 뒤 결과 화면에서 한꺼번에 — 응시 중 소리가 흔들리면(실기기) 끝낸 뒤로 미룬다(대기열 계기 ①만 빼면 된다).
2. **원본만 보관**(기본) vs 채점 때 만든 WAV도 보관 — webm 녹음을 iPhone에서 들어야 할 일이 잦으면 WAV 사본을 더한다(크기 약 2배).
3. **기존 기기 녹음 이행**(기본: 올린다) vs 새 응시부터.
4. **대체된 다시 녹음 객체**(기본: 모의고사를 지울 때까지 남김) vs 메타가 바뀔 때 지움(업로드 경로에 지우기가 생긴다).
5. **이어 듣기 순서**(기본: 내 답 → 대상) — "대상 → 내 답" 버튼을 더할지.
6. **다시 풀기 기록 수**(기본: 문항마다 최근 5, 응시 20회까지 읽음).
7. **서버 사본 재생 방식**(기본: 미리 받아 Blob) vs `<audio src>` + Range(206) 스트리밍 — 셀룰러에서 미리 받기(실전 한 회 약 5MB)가 부담이면 Range를 구현한다.
8. **녹음 비트레이트**(기본: 녹음기 기본값 그대로 — 실기기 검증이 끝난 `lib/mic-session.ts`를 건드리지 않는다) vs `audioBitsPerSecond` 64kbps로 크기 절반.
9. **전용 런타임 서비스 계정**(기본: 지금 서비스 계정에 버킷 범위 권한만) — 기본 Compute SA가 프로젝트 범위 Editor를 쥐고 있으면 그것을 좁히는 일은 이번 범위 밖이다.
10. **고아 객체 정리 도구**(기본: 없음 — §13-7 알려진 틈).

### 13-14. 구현이 정한 것 (2026-10-03)

- **백엔드 판정 위치**: `resolveStoreBackend`는 `lib/store-backend.ts`에 두고 `lib/store.ts`가 다시 내보낸다. 스토어의 삭제 연쇄(`deleteToeicMock`)가 녹음 보관소를 부르므로, 보관소가 `lib/store.ts`를 import하면 순환이 된다. 판정 함수는 여전히 한 벌이다(eval ⑪이 보관소 소스에 env 직접 판정이 없음을 잠근다).
- **계기에 허브 추가**: §13-3 계기 ②(결과·학습 보기·연습 폴더 ④)에 **아빠의 영어 허브 `/toeic`**을 더했다(`components/toeic-rec-upload-drain.tsx`). SPEC §20-11의 이행 안내("응시한 iPhone에서 아빠의 영어를 한 번 열면")와 맞추려는 것이다. 토익 밖 화면에서는 여전히 돌지 않는다.
- **재시도 대기 깨우기**: 비우기가 2·10·30초 대기 중일 때 다시 불리면(지금 올리기·online·보임) 새 비우기를 만들지 않고 **대기를 깨워 바로 다시 해 본다**. 대기열은 여전히 한 번에 하나다.
- **같은 녹음만 상태를 바꾼다**: 기기 메타의 대기열 상태는 메타의 `createdAt`이 올린 녹음과 같을 때만 바꾼다(올리는 사이 "이 문항 다시"로 들어온 새 녹음을 done으로 덮지 않는다). 한 번의 비우기 안에서 같은 녹음은 한 번만 다룬다(IndexedDB 쓰기가 조용히 실패해도 끝없이 다시 올리지 않게).
- **바이트가 없는 메타는 gone**: 대기열 메타는 있는데 바이트가 없으면(정리·교체) 그 메타를 "gone"으로 바꾸고 넘어간다.
- **`recording_missing` 재대기열은 두지 않았다**: 화면은 이 기기 사본이 있으면 서버 사본을 받지 않으므로(§13-8 우선순위) "기기에 사본이 있는데 서버 객체가 없다"를 화면이 알 길이 없다. 그 경우는 고아 정리 도구와 함께 다룬다(열린 결정 10).
- **응시 id 모양이 아닌 경로**(`[id]`가 `^[A-Za-z0-9_-]{1,64}$` 밖)는 PUT·GET 모두 404 `attempt_not_found`(그런 응시는 만들어지지 않는다). 삭제 연쇄도 모양이 아닌 응시 id는 녹음 지우기를 건너뛴다.
- **화면 문구**: 응시 화면 진단 줄 "· 서버 Q5 ✓ · Q6 올리는 중 · Q7 대기", 끝 화면 "🗄️ 녹음 n개 중 m개를 서버에 보관했어요(— 나머지는 결과 화면에서 이어서 올려요)", 결과 머리 "🗄️ 녹음 서버 보관 n/m" + "⬆️ 지금 올리기 (k)", 응시 전체 변화 "📈 지난 실전보다 추정 a → b (±d) · 추정(참고용)" / "📈 지난번과 같은 문항 n개 합 a → b (±d)". 앞선 응시는 같은 범위(scope)끼리 고른다(`toeicPreviousAttempt`).
- **eval**: `scripts/eval-toeic-recordings.ts` 12묶음 → `eval:toeic` 오프라인 **1308항목**(1170 → 1308). 파일 백엔드 묶음은 자식 프로세스(임시 cwd, `TOEIC_REC_DIR`=임시 폴더)에서 돌고 저장소 `data/db.json`·`data/recordings` 무접촉을 확인한다.

## 14. 녹음 관리 + 고칠 문장 다시 녹음 (2026-10-03)

> 제품 흐름·경계·비용·실기기 확인은 SPEC §20-12. 이 절은 **레코드 필드·지운 자리·지우기 순서·고칠 문장 녹음 라우트·교체 시점·화면·eval**을 정한다. **새 AI 호출·새 프롬프트는 없다**(받아쓰기 비교도 하지 않는다). spec-sync 대상(원문 15 + JSON 8 + 호출 옵션 문장)은 그대로다. 문장 예시는 모두 지어낸 것이다.
> §13의 원칙은 그대로 따른다 — 백엔드 판정 한 벌(`resolveStoreBackend`), PIN 게이트 뒤 프록시(서명 URL 없음), 경로 조각에 점 없음, 바이트 형식 판정, 4MB 상한(`TOEIC_SCORE_AUDIO_MAX_BYTES`), sha256 서버 계산, 객체 먼저 → 메타(원자 단위 안에서 같은 판정을 다시), "딸린 것(객체) 먼저" 지우기. 바뀐 것은 §13-7의 "녹음을 따로 지우는 화면·라우트는 두지 않는다" 한 줄이다.

### 14-0. 결정 (사용자 확정 2026-10-03)

사용자 원문: "녹음내용을 보고 지울 수도 있게 하자. 그리고 모의고사 결과에서 첨삭을 할 때 고칠문장 단위로 다시 녹음해서 내 목소리를 들어보는 기능을 추가하자."

| 항목 | 결정 | 출처 |
|---|---|---|
| 지우는 곳 | ① 결과 화면 문항마다 "🗑 녹음 지우기" ② 아빠의 영어 허브의 **"🎙️ 내 녹음"** 목록(`/toeic/recordings` — 응시별 묶음: 날짜·모의고사/연습 이름·문항·길이·점수, ▶ 듣기, 하나씩·응시 통째 지우기) | 요구 |
| 지우면 | 서버(GCS 또는 파일 백엔드)와 이 기기(IndexedDB·업로드 대기열) **모두**에서 사라진다. **점수·전사·피드백은 남는다** — 그 문항은 소리가 없어 다시 채점할 수 없다고 보인다. 확인 창(되돌릴 수 없음) | 요구 |
| 순서 | **서버 먼저**(보관소 객체 → 메타 정리) → 성공한 뒤 이 기기 사본. 실패하면 아무것도 바꾸지 않는다 | 요구 |
| 대기열 | 기기 대기열에 pending인 녹음을 지우면 업로드도 취소된다(바이트·메타가 함께 지워진다) | 요구 |
| 고칠 문장 다시 녹음 | 결과 화면 피드백의 "고칠 문장"(`feedback.fixes[i]`: said → better)마다 🔊 고친 문장(TTS) · 🎤 내가 다시 말하기 · ▶ 내 목소리 · ⇄ 내 목소리 → 고친 문장 이어 듣기 | 요구 |
| 보관 | **서버**(같은 버킷, 응시 아래 별도 경로), 고칠 문장마다 **최신 하나**, 다른 기기에서도 재생, "내 녹음"에 함께 보이고 함께 지워진다 | 요구 |
| AI | **0** — 받아쓰기 비교는 하지 않는다 | 요구 |
| 마이크 | `createMicKeeper`(§6-4 마이크 유지)로 **결과 화면 세션 동안** 하나 — 권한을 다시 묻지 않게. 정책은 응시 화면과 같은 기기 설정을 따른다(2026-10-03 §15-13에서 바뀜 — 설정과 상관없이 keep)(0ec640c부터 기본 "문항마다 마이크 다시 열기" 켬 — 그 기기는 🎤마다 연다. 끈 기기만 keep) | 요구 + 0ec640c |
| 같은 화면 손질 | QA mic-keep P3-1(`startRecording` 동시 호출 경합)·P3-2(점검 녹음이 버려졌는데 "✓") | 요구 |

### 14-1. 레코드 — `ToeicAttemptRecord`에 필드 둘

```ts
interface ToeicStoredFixRecording {      // lib/toeic-rec-rules.ts
  q: number;                 // 1..11 — 그 문항 feedback.fixes가 있는 문항
  fixIndex: number;          // feedback.fixes의 자리(0..)
  better: string;            // 녹음할 때의 고친 문장 — 서버가 피드백에서 옮긴다("내 녹음" 목록이 피드백 없이 보이게)
  objectKey: string;         // "attempts/{attemptId}/fixes/{q}/{fixIndex}/{recordedAtMs}"
  mimeType: string; size: number; sha256: string; durationMs: number; recordedAt: string; uploadedAt: string; // §13-5와 같은 뜻
}
interface ToeicRecordingDeletion {       // 지운 자리(tombstone)
  q: number | null;          // null = 응시 통째
  fixIndex: number | null;   // null = 그 문항의 답변 녹음
  deletedAt: string;         // 서버가 지운 시각(ISO)
}
interface ToeicAttemptRecord {
  // …§7-5·§12-3·§13-5 필드 그대로
  fixRecordings: ToeicStoredFixRecording[];      // (q, fixIndex) 오름차순, 자리마다 하나. 옛 문서 = []
  recordingDeletions: ToeicRecordingDeletion[];  // 같은 자리는 늦은 시각 하나. 옛 문서 = []
}
```

- 둘 다 **answers 밖**이다(§13-5와 같은 이유 — 닫힘 판정 불변). 끝내기·채점은 건드리지 않는다. 쓰는 곳은 `setToeicAttemptFixRecording`·`deleteToeicAttemptRecordingMeta`(+ 답변 메타는 지금처럼 `setToeicAttemptRecording`) 셋.
- 정규화(`normalizeToeicAttemptRecord`)가 명시적으로 옮긴다 — 깨진 항목만 버리고, 같은 자리 둘이면 늦은 것 하나(`normalizeToeicStoredFixRecordings`·`normalizeToeicRecordingDeletions`). 생성부(`createToeicAttempt` 호출)는 `[]`로 시작한다(`New*` 필수 필드 — tsc가 잡는다).
- 크기: 고칠 문장 녹음 메타 한 줄 약 300바이트, 응시 하나에 최대 11 × 5 = 55개여도 20KB 안팎. 지운 자리는 자리마다 하나라 늘지 않는다(응시 통째 지운 자리는 그보다 이른 자리 줄을 정리한다 — `addToeicRecordingDeletion`).

### 14-2. 객체 키 · 지우기 접두사

- 고칠 문장 녹음 키 `toeicFixRecObjectKey(attemptId, q, fixIndex, recordedAtMs)` → `attempts/{attemptId}/fixes/{q}/{fixIndex}/{recordedAtMs}`. **응시 접두사 아래**라 모의고사 삭제 연쇄(§13-7 접두사 지우기)가 함께 지운다. 확장자·점 없음. `fixIndex`의 구조 상한 `TOEIC_FIX_REC_INDEX_MAX`(9 — 호출 D zod fixes 상한 5 이상이면 된다, eval이 잠근다), 실제 범위는 그 문항 `feedback.fixes` 길이(판정이 본다).
- 보관소가 받는 키 = 답변 키(`TOEIC_REC_OBJECT_KEY_RE`) **또는** 고칠 문장 키(`TOEIC_REC_FIX_OBJECT_KEY_RE`) — `isToeicRecObjectKey`. 두 정규식은 서로의 키를 받지 않는다.
- 지우기 접두사(`toeicRecDeletionPrefixes(attemptId, target)`, 모양 `TOEIC_REC_PREFIX_RE`): 답변 한 문항 `attempts/{id}/{q}/`(대체된 옛 답변 객체까지) · 고칠 문장 하나 `attempts/{id}/fixes/{q}/{i}/` · 응시 통째 `attempts/{id}/`. 끝 슬래시가 있어 Q1 접두사가 Q11을, 답변 접두사가 `fixes/`를 덮지 않는다.
- 보관소 인터페이스에 둘을 더한다 — `deletePrefix(prefix)`(지운 수, 이미 없으면 0 — 멱등)·`deleteKey(key)`(지웠으면 true, 없으면 false). GCS 구현은 둘 다 **먼저** `assertDestructiveAllowed("deleteToeicRecordings")`(새 `DestructiveOp`는 두지 않고 §13-7의 op를 넓혔다 — 지금 11개 그대로). 파일 백엔드는 가드가 없다.

### 14-3. 지운 자리 — 지운 녹음이 되살아나지 않게

- 문제: 아빠가 iPad에서 Q5 녹음을 지웠는데 iPhone 대기열에 그 녹음이 pending으로 남아 있으면, iPhone이 다음에 열릴 때 그 녹음을 다시 올린다. 메타가 없으니 §13-4 판정은 `store` — 지운 녹음이 되살아난다. 이 기기에서 지울 때도 같다(지우는 사이 업로드가 진행 중이던 경우).
- 그래서 지우면 메타를 빼면서 **지운 자리**를 남긴다. 판정(`isToeicRecordingTombstoned(deletions, q, fixIndex, recordedAtMs)`): 그 자리(응시 통째 자리는 모든 자리)를 덮는 지운 자리가 있고 **녹음 시각 ≤ 지운 시각**이면 거부한다.
  - 답변 녹음 판정 `decideToeicRecordingUpload`가 `question_not_found` 다음, 메타 비교 앞에서 본다 → 새 결과 `"deleted"` → 라우트 409 `recording_deleted`.
  - 고칠 문장 녹음 판정 `decideToeicFixRecordingUpload`도 같다.
  - 지운 **뒤에 새로** 녹음한 것(녹음 시각 > 지운 시각 — 고칠 문장 다시 말하기)은 받는다. 답변 녹음은 응시 중에만 생기므로 실제로는 지운 뒤 새 답변이 오지 않는다.
- 시각은 기기 녹음 시각(`recordedAt`)과 서버 지운 시각을 비교한다 — 기기 시계가 서버보다 크게 늦으면 지운 직후 새로 말한 고칠 문장이 거부될 수 있다(§14-9 알려진 틈 — 폰은 망 시계를 쓴다).
- 기기 쪽: 대기열 응답 해석(`nextToeicRecUploadAction`)에 `"purge"`를 더했다 — 409이고 `error: "recording_deleted"`면 purge, 비우기(`drainToeicRecUploads`)는 같은 녹음일 때(createdAt 대조) 이 기기 사본을 지운다. 409 `recording_locked`는 지금처럼 gone.
- 결과 화면·"내 녹음" 목록은 열 때 그 응시의 지운 자리가 덮는 이 기기 사본을 지운다(다른 기기에서 지운 녹음을 이 기기가 계속 들려주지 않게). 결과 화면은 다시 풀기 기록(③)의 다른 응시 사본에도 같은 규칙을 쓴다(비교 자료 `ToeicCompareAttempt.recordingDeletions` — 선택 필드).

### 14-4. 지우기 — 라우트 셋, 순서 한 벌

| 경로 | 대상 | 남는 것 |
|---|---|---|
| `DELETE /api/toeic/attempts/[id]/recordings/[q]` | 그 문항 **답변 녹음**(대체된 옛 객체까지) | 그 문항 고칠 문장 녹음 · 점수·전사·피드백 |
| `DELETE /api/toeic/attempts/[id]/recordings/[q]/fixes/[i]` | 그 고칠 문장 녹음 하나 | 나머지 전부 |
| `DELETE /api/toeic/attempts/[id]/recordings` | 응시의 녹음 통째(답변·고칠 문장 — 응시 접두사) | **응시 기록·점수·전사·피드백**(응시 기록을 지우는 기능은 여전히 없다 — 스트릭 과거가 사라진다, §12-8) |

- 세 라우트가 **한 벌**(`lib/toeic-rec-delete.ts` `deleteToeicRecordingTarget`)을 부른다:
  1. 응시(404 `attempt_not_found` — 모양이 아닌 id 포함)·문항 범위(404 `question_not_found`, 통째는 검사 없음). 경로 조각 모양이 깨지면 라우트가 400 `invalid_input`.
  2. **보관소 먼저** — 자리 접두사를 지운다. 실패하면 메타를 건드리지 않고 500 `delete_failed`(retriable). prod-guard(개발 환경 GCS)면 403 `prod_guard`.
  3. **메타 정리** — 스토어 원자 단위(파일 `mutate`, Firestore `runTransaction` + 먼저 prod-guard) 안에서 순수 함수 `applyToeicRecordingDeletion(attempt, target, now)`: 대상 메타를 빼고 지운 자리를 더한다. **answers·finishedAt은 그대로**. 실패하면 500 `delete_failed` — 객체는 이미 없으니 GET은 `recording_missing`, 다시 누르면 2(0건)·3이 다시 돈다(멱등).
- 반대 순서(메타 먼저)면 가리키는 메타 없는 객체가 버킷에 영영 남는다 — §13-7과 같은 이유다.
- 응답(`ToeicRecordingDeleteResponse`, `lib/toeic-attempt-contract.ts` 단일 정의): 200 `{ ok:true, outcome:"deleted"|"absent", removedObjects, recordings, fixRecordings, recordingDeletions }`(absent = 서버 메타가 없었다 — 이 기기에만 있던 녹음. 지운 자리는 남긴다) · 400 `invalid_input` · 404 `attempt_not_found`|`question_not_found` · 403 `prod_guard` · 500 `delete_failed`(retriable). 화면은 응답의 세 필드로 상태를 바꾼다.
- **이 기기 사본**: 서버가 성공한 **뒤에** `deleteToeicRecordingsLocal(attemptId, qs | "all")`(`lib/toeic-rec-store.ts`)가 메모리·바이트(`rec`)·메타(`meta`)를 함께 지운다 — 대기열 메타가 사라지므로 업로드도 취소된다(비우기는 매 차례 대기열을 새로 읽는다). 이미 올리던 중이면 그 PUT은 지운 자리에 걸려 409 → purge(이미 없음 — 아무 일 없음).
- 서버가 404 `attempt_not_found`로 답하면(모의고사를 이미 지웠다) 목록은 이 기기 사본만 지운다. 그 밖 실패는 아무것도 지우지 않는다(상태 일관).
- 로그에는 응시 id·대상·지운 수·결과·ms만 남긴다.

### 14-5. 고칠 문장 다시 녹음 — 라우트 · 판정 · 교체 시점

경로 `/api/toeic/attempts/[id]/recordings/[q]/fixes/[i]` — `i`는 `^\d$`. PUT·GET·DELETE. PIN 게이트 뒤, AI를 부르지 않으므로 키 검사 없음. multipart 필드 이름은 답변 녹음과 같다(`TOEIC_REC_FIELD_*`).

- **PUT 검사 순서**: 400(형식 — `checkToeicFixRecordingUpload`: 답변 녹음과 같은 받는 타입·바이트 판정·빈 파일·시각, 자리 조각, 길이 1 ~ `TOEIC_FIX_REC_MAX_MS` = 35초) · 413(4MB) → 404(`attempt_not_found` · `question_not_found` · `fix_not_found`) → 판정 → 객체 쓰기 → 메타(원자 단위) → **커밋 뒤** 옛 객체 지우기.
- **판정** `decideToeicFixRecordingUpload(attempt, q, fixIndex, {sha256, recordedAtMs})`:

  | 지금 | 들어온 것 | 결과 |
  |---|---|---|
  | 문항이 응시 범위 밖 | — | `question_not_found` → 404 |
  | 그 문항에 피드백이 없거나 `fixIndex ≥ fixes.length` | — | `fix_not_found` → 404 |
  | 지운 자리가 덮는다(녹음 시각 ≤ 지운 시각) | — | `deleted` → 409 `recording_deleted` |
  | 메타 없음 | 무엇이든 | `store` |
  | 같은 sha | — | `reused` → 200(쓰지 않음) |
  | 들어온 녹음이 더 이르거나 같음 | 다른 바이트 | `superseded` → 200(서버의 더 새 메타) |
  | 더 새 녹음 | 다른 바이트 | `store` — **잠그지 않는다**(채점과 무관한 연습이라 몇 번이고 다시 말해 최신으로 바꾼다. 답변 녹음의 `locked`와 다르다) |

- 메타의 `better`는 서버가 응시 기록의 피드백에서 옮긴다(`toeicFixBetterOf` — 클라이언트 값을 받지 않는다). 피드백은 점수가 생긴 뒤 바뀌지 않으므로(채점 대상 = 점수 없는 문항) 자리 번호가 다른 문장을 가리키게 되지 않는다.
- **옛 객체 지우기 시점 — 메타 커밋 뒤**(스토어가 `replaced`로 바뀌기 전 메타를 돌려준다). 근거:
  - 메타보다 먼저 지우면 메타 저장이 실패했을 때 지금 녹음을 잃는다(새 객체는 메타가 없어 아무도 가리키지 않고, 옛 객체는 지워졌다).
  - 연습은 자주 다시 하므로 답변 녹음처럼 옛 객체를 모의고사 삭제 때까지 남기면(§13-1) 버킷에 쌓인다. 고칠 문장 하나에 열 번 다시 말하면 열 개가 남는다.
  - 지우기가 실패하면(GCS 오류·개발 환경 prod-guard) 응답을 바꾸지 않고 로그만 남긴다 — 남은 옛 객체는 그 자리·응시·모의고사를 지울 때 접두사째 사라진다.
  - 판정에서 자리를 얻지 못한 방금 쓴 객체(동시 업로드 경합·지운 자리)는 지금 메타가 가리키는 것이 아니면 같은 방식으로 지운다. **답변 녹음 PUT은 바꾸지 않는다** — 지금처럼 업로드 본문에 지우기가 없다(eval이 PUT 본문을 잠근다).
- **GET**: 답변 녹음 GET과 같은 헤더(`private, no-store`·`nosniff`·`inline`·content-type = 메타 mimeType), 404 `attempt_not_found`|`recording_not_found`|`recording_missing`, 500 `storage_failed`.
- 응답(`ToeicFixRecordingPutResponse`): 200 `{ ok:true, q, fixIndex, outcome:"stored"|"reused"|"superseded", recording }` · 400 · 413 · 404 · 409 `recording_deleted` · 500 `storage_failed`|`save_failed`(retriable).
- **기기 보관소에 넣지 않는다.** 결과 화면이 녹음을 **메모리**(Blob URL)에 두고 곧바로 PUT한다. 근거: 응시 녹음 대기열의 보관·정리 규칙(풀마다 최근 5회분·pending 고정 — §13-3·§12-7-6)은 응시 답변을 기준으로 만들어져, 연습 녹음이 들어오면 정리 순위·고정이 흔들린다. 결과 화면은 녹음 직후 네트워크가 있는 자리다. 재시도할 실패는 대기열과 같은 2·10·30초 뒤 최대 3번, 그래도 안 되면 "⬆️ 다시 올리기" 버튼과 "화면을 떠나면 이 녹음은 사라져요" 안내.

### 14-6. "🎙️ 내 녹음" 목록 (`/toeic/recordings`)

- 서버 페이지가 전 응시를 읽어 **줄인 요약**(`ToeicRecAttemptSummary` — 제목·범위 라벨·시작 시각·문항·`{q, recorded, score}`·세 녹음 필드, 피드백 본문·전사문 없음)만 넘긴다. 모의고사가 없는 응시는 넣지 않는다(연쇄로 이미 지워졌다).
- 클라이언트가 이 기기 메타(`listAllToeicRecordingMetas` — 바이트 없이)와 합친다 — 순수 함수 `buildToeicRecManageView(summaries, localMetas)`(`lib/toeic-rec-manage.ts`):
  - 묶음 = 녹음 항목이 하나라도 있는 응시, **최신 응시 먼저**. 머리: 날짜(KST) · 제목 · 범위 칩 · "녹음 n개 · 고칠 문장 m개 · 합계 길이" · "결과 보기 →" · "🗑 이 응시 녹음 모두 지우기".
  - 항목 = 답변 녹음(서버 메타 또는 이 기기 사본 — "서버 ✓" / "이 기기에만(올리는 중)") + 고칠 문장 녹음(서버 메타 — 고친 문장 글자를 함께). 문항 순, 같은 문항은 답변 → 고칠 문장(자리 순). 답변 항목은 점수 "2 / 3점"·"채점 전".
  - 지운 자리가 덮는 이 기기 사본은 항목에서 빼고 `purgeLocal`로 돌려준다 — 화면이 지운다.
  - 응시 기록이 없는 이 기기 사본은 `orphans`("응시 기록이 없는 이 기기 녹음" — "🗑 이 기기에서 지우기", 서버 호출 없음).
- **▶ 듣기**: 이 기기 사본 → 서버 사본(`fetch` → Blob → objectURL — `<audio src>`에 API 주소를 넣지 않는다). 받은 뒤 재생기(`<audio controls>`)를 보인다 — iOS는 탭 안 `await` 뒤의 `play()`를 막으므로 재생기의 ▶를 한 번 더 누른다(목록 전체를 미리 받으면 수십 MB라 미리 받지 않는다).
- 이 화면도 업로드 대기열 계기다(§13-3 — 토익 화면).
- 허브 `/toeic`에 넷째 카드 "🎙️ 내 녹음"(`sm:col-span-2`). 결과 화면 머리 "🗄️ 녹음 서버 보관" 줄에 "🎙️ 내 녹음 모아보기 →".

### 14-7. 결과 화면 (`components/toeic-attempt-view.tsx`)

- **내 녹음 블록**: 소리(이 기기 또는 서버)가 있으면 "🗑 녹음 지우기". 지운 뒤(지운 자리가 있고 소리가 없음)는 "🗑 녹음을 지웠어요 — 점수·전사·피드백은 남아 있어요. 이 문항은 다시 채점할 수 없어요." AI 채점 대상(`scorable`)은 소리가 있어야 하므로 저절로 빠진다. 채점 안내의 "아직 서버에 올라가지 않았어요" 셈에서 지운 문항을 뺀다.
- **고칠 문장 줄마다**: 🔊 고친 문장(`speakQueue` en-US — 결과 화면이 고친 문장을 프리페치에 더한다) · 🎤 내가 말하기/다시 말하기 · (녹음이 있으면) ▶ 내 목소리 · ⇄ 내 목소리 → 고친 문장 · 🗑. 상태 줄 "서버 ✓ 3.2초 · 96KB" / "서버에 올리는 중…" / "서버에 올리지 못했어요 + ⬆️ 다시 올리기".
  - ▶·⇄는 화면 하나뿐인 공용 플레이어 이어 듣기(§13-9 ①의 `playChain` — 탭 안 동기로 멈춤 → `unlockSpeechPlayback` → `play()`, `ended`에서 600ms 뒤 `speakQueue`)를 그대로 쓴다.
  - 소리 출처: 이 화면에서 방금 한 녹음(메모리) → 서버 사본(화면이 열릴 때 동시 2개로 **미리 받는다** — iOS 탭 규칙, §13-8).
- **마이크** (`components/use-toeic-fix-recorder.ts`) (2026-10-03 §15-13에서 바뀜 — 기기 설정과 상관없이 Apple WebKit + 오디오 세션 API면 keep): `createMicKeeper()` 하나를 결과 화면 세션 동안 쥔다. 정책은 응시 화면과 **같은 기기 설정·같은 판정**(`micKeepPolicyFor`)이다 — keep(Apple WebKit + 오디오 세션 API + "문항마다 마이크 다시 열기"를 끈 기기)이면 첫 🎤에서만 권한 창, 이후 고칠 문장마다 같은 스트림에 새 녹음기(녹음 사이 입력 끔). per-answer(0ec640c부터의 기본값 — 설정 켬, 그리고 Chrome·Android 등)는 녹음마다 열고 닫는다. 결과 화면 "⚙️ 소리 설정"에 같은 토글(`ToeicMicKeepToggle`)을 두고, 바꾸면 쥔 마이크를 놓고(`resetMic`) 다음 🎤부터 새 정책이다. 🎤는 **탭 안에서 동기로** `startRecording`을 부르고(권한 창이 탭 맥락에), 그 전에 모든 재생을 멈춘다(재생과 캡처를 겹치지 않는다). 녹음 중 🔊·▶를 누르면 녹음을 먼저 멈춘다. 한 번에 하나(다른 🎤는 막힌다), 30초(`TOEIC_FIX_REC_LIMIT_MS`)면 저절로 멈춘다. **놓는 때**: 언마운트·pagehide·숨김(돌던 녹음은 버린다). 오디오 세션은 mic-session 밖에서 건드리지 않는다(§13-9의 "결과 화면은 녹음하지 않으므로 세션을 건드리지 않는다"는 이제 "녹음은 keeper로만"으로 읽는다).
- 마이크 거부·미지원이면 그 줄에 "… — 고친 문장 🔊 듣기는 그대로 할 수 있어요."(멈추지 않는다).

### 14-8. 같은 화면 손질 — QA mic-keep P3-1·P3-2

- **P3-1** `createMicKeeper().startRecording` 동시 호출: 호출 순번(`callSeq`)을 두고, 획득을 기다린 뒤 순번이 바뀌었으면 녹음기를 만들지 않고 `MicError("failed", "superseded")`로 끝낸다. 녹음기를 만들기 **직전에** 앞 녹음을 한 번 더 버린다. per-answer도 같다(기다린 뒤 뒤 호출이 왔으면 이 녹음을 버린다). 같은 스트림에 녹음기가 둘 달려 뒤 녹음이 끝날 때 앞 녹음의 입력이 꺼지는(무음으로 도는) 경합이 없어진다. eval K23·K24.
- **P3-2** 마이크 점검 2초 도중 숨김·설정 바꿈으로 점검 녹음이 버려지면(`stop()`이 null) "✓ 소리가 잘 들어와요" 대신 새 단계 `stopped` — "점검이 멈췄어요(화면이 가려졌거나 설정이 바뀌었어요) — 🎙️ 다시 점검해 주세요." 시작 버튼은 지금처럼 `done`일 때만 녹음 응시를 연다.

### 14-9. 알려진 틈

- **기기 시계**: 지운 자리 판정은 기기 녹음 시각 ↔ 서버 지운 시각 비교다. 기기 시계가 서버보다 늦으면 지운 직후 새로 말한 고칠 문장이 409로 거부될 수 있다(화면은 "지운 녹음이라 다시 올리지 않았어요"를 보이고 다시 말하면 된다).
- **답변 PUT의 경합 고아**: 쓰기 전 판정과 메타 저장 사이에 그 문항을 지우면 방금 쓴 답변 객체가 메타 없이 남는다(답변 PUT에는 지우기를 두지 않는다 — §13-1). 그 자리를 다시 지우거나 응시·모의고사를 지울 때 접두사째 사라진다.
- **올리지 못한 고칠 문장 녹음**은 기기 보관소에 없으므로 화면을 떠나면 사라진다(화면이 알린다).
- **다른 기기의 캐시**: 다른 기기의 이 기기 사본은 그 기기가 그 응시 결과·내 녹음 목록을 열거나 대기열이 409를 받을 때 지워진다 — 그 전까지는 그 기기 IndexedDB에 남는다(서버·이 기기에서는 즉시 사라진다).

### 14-10. eval (오프라인 — `scripts/eval-toeic-rec-manage.ts`, `eval-toeic.ts`가 불러 한 번에 돈다, 실호출 0·GCS 0)

① 키·경로(고칠 문장 키 형식·점 없음·두 정규식 분리·접두사 세 모양·Q1/Q11·답변/고칠 문장 접두사 분리·자리 상한 ≥ zod·주소·라우트 파일·proxy 게이트) ② 업로드 계약(자리 조각·길이 상한·바이트 판정·4MB) ③ 고칠 문장 판정 표(위 일곱 줄 + 잠그지 않음 + 응시 통째 지운 자리) ④ 답변 판정 + 지운 자리(deleted·다른 문항·고칠 문장 자리 무관·경계 시각) ⑤ 지우기 적용(답변만·고칠 문장만·통째, **answers 깊은 같음**, 멱등·자리 병합) ⑥ 정규화(옛 문서·깨진 항목·왕복) ⑦ 기기 대기열(purge·기기 지우기가 바이트·메타 함께) ⑧ 파일 백엔드 자식 프로세스(고칠 문장 저장·교체·superseded·자리 밖, deleteKey 멱등, **실패 주입 → 메타·객체 그대로**, 답변 지우기가 그 문항만·점수 남음, 지운 뒤 늦은 업로드 deleted, absent 멱등, 고칠 문장 지우기·지운 뒤 새로 말하기, 통째 → 응시 기록 남음, 모의고사 연쇄) ⑨ 목록 묶음(순서·pending·purgeLocal·orphans·합계·지운 뒤) ⑩ 소스 대조(지우기 순서·prod-guard·세 라우트 한 벌·PUT 순서·better 서버 값·GET 헤더·AI 0·번들 경계·src 금지·결과 화면/목록 지우기 순서·녹음기 마이크 관문·놓는 때·IndexedDB 안 씀·허브 카드·요약만 넘김·답변 PUT 본문 지우기 없음) ⑪ 마이크 점검 거짓 ✓ 회귀. `eval-toeic.ts` 마이크 유지에 K23(keep 동시 호출)·K24(per-answer 동시 호출). §13-10 ⑦의 "업로드 라우트에 지우기 동작이 없다"는 같은 파일에 DELETE 핸들러가 생겨 **PUT 본문**을 보도록 좁혔다. → `eval:toeic` 오프라인 **1436항목**(0ec640c 뒤 1333 → 1436).

### 14-11. 구현이 정한 것 · 열린 결정

- 새 `DestructiveOp`를 두지 않고 `deleteToeicRecordings`를 넓혔다(보관소 접두사·객체 지우기, Firestore 메타 정리). 유니온 11개 그대로.
- 지운 자리는 **지운 시각** 하나로 판정한다(녹음 sha 목록을 남기지 않는다) — 문서가 늘지 않고, 지운 뒤 새로 말하기를 막지 않는다.
- 답변 녹음을 지워도 그 문항 고칠 문장 녹음은 남는다(목록에서 따로 보이고 따로 지운다). 응시 통째는 둘 다.
- 목록 ▶는 받은 뒤 재생기를 보이는 두 번 탭이다(열린 결정: 목록에서도 미리 받기 — 데이터 비용 대신 한 번 탭).
- 고칠 문장 녹음의 "⇄" 순서는 내 목소리 → 고친 문장 하나(§13-13 5와 같은 기본값).
- 열린 결정: ① 올리지 못한 고칠 문장 녹음을 기기 보관소에 넣을지(지금은 메모리 — §14-5 근거) ② 응시 기록 자체 지우기(지금은 없음 — 스트릭) ③ 다른 기기 캐시를 즉시 비울 방법(지금은 열 때·409 때).

## 15. 문항 단위 다시 풀기 + 마이크 유지 대책(F1~F3) + 결과 화면 녹음 마이크 고정 (2026-10-03)

> 제품 흐름·경계·비용·실기기 확인은 SPEC §20-13. 이 절은 **레코드 필드·다시 풀기 계약(시작·끝·업로드 세대)·합치기 규칙·채점 경합·지우기 계획·무음 판정·문항별 진단·탭 안 재획득 상태 기계·eval**을 정한다. **새 AI 호출·새 프롬프트는 없다.** spec-sync 대상(원문 15 + JSON 8 + 호출 옵션 문장)은 그대로다. 문장 예시는 모두 지어낸 것이다.
> §13·§14의 원칙은 그대로 따른다 — 백엔드 판정 한 벌, PIN 게이트 뒤 프록시, 경로 조각에 점 없음, 바이트 판정·4MB·sha256 서버 계산, 객체 먼저 → 메타(원자 단위 안에서 같은 판정을 다시), "딸린 것 먼저" 지우기. 바뀐 옛 문장은 그 자리에 "(2026-10-03 §15에서 바뀜)" 괄호만 붙였다.

### 15-0. 결정 (사용자·오케스트레이터 확정 2026-10-03)

사용자 원문: "가끔 오류가 나서 모의고사에서 특정 문제들을 다시 풀어야 하는 경우가 발생하는 것 같아. 이럴 때 처음부터 다시하기보다 문제단위로도 다시 풀 수 있게 하면 좋을듯 해."

| 항목 | 결정 | 출처 |
|---|---|---|
| 다시 푼 답 | **원래 응시 결과에 합친다** — 그 문항 자리를 새 답(녹음·전사·점수)으로 채우고 추정 총점·등급을 다시 계산한다 | 사용자 |
| 진입 | 결과 화면 문항 카드마다 "↻ 이 문항 다시 풀기" + 오류 문항(녹음 없음·녹음 실패·중단됨·소리 없음·채점 실패·녹음 지움)이 있으면 위에 "↻ 오류 문항 n개 다시 풀기" | 사용자 |
| 형식 | 실전처럼 — 그 문항의 지시문(파트 첫 문항일 때)·질문 음성·준비·답변 시간 그대로(형식표 `lib/toeic-mock.ts`). 묶음 문항(Q5–7·Q8–10)은 앞 문항 자료(상황 소개·표)를 그대로 보인다 | 사용자 |
| 예전 답 | 응시 기록 안 **이력**(`answerHistory`)으로 남겨 결과 화면 ③ "다시 풀기 기록"에서 비교. 예전 녹음은 객체 그대로(새 녹음은 새 객체), "내 녹음" 목록에서 따로 지울 수 있다 | 사용자 |
| F1 무음 감지 · F2 문항별 진단 · F3 탭 안 재획득 | QA `qa_report_toeic_q34-norec_1.md` 대책 그대로 | 오케스트레이터 |
| 마이크 기본값 | 응시 화면은 지금 그대로(0ec640c — 설정이 없으면 "문항마다 열기"). F1~F3 뒤 "마이크 유지"를 다시 기본으로 할지는 **열린 결정**(§15-15) | 오케스트레이터 |
| 결과 화면 고칠 문장 녹음 | 기기 설정과 상관없이 Apple WebKit + 오디오 세션 API면 **keep**, 그 밖 per-answer | 오케스트레이터 |

### 15-1. 레코드 — `ToeicAttemptRecord`에 필드 셋

```ts
interface ToeicRetakeSession {           // lib/toeic-retake.ts — 다시 풀기 한 번
  id: string;                  // ^[A-Za-z0-9_-]{1,64}$ (서버가 만든다)
  questions: number[];         // 다시 푸는 문항(오름차순, attempt.questions 안, 1개 이상)
  startedAt: string;           // 서버 시각(ISO)
  closedAt: string | null;     // null = 진행 중
  finishedAt: string | null;   // 끝까지 = 시각 · 그만둠·닫힘(교체·만료) = null
  merged: number[];            // 닫을 때 원래 결과에 합친 문항
  recordings: ToeicStoredRecording[]; // 진행 중에 올라온 녹음(합치기 전 대기 자리 — 합치면 비운다)
  diags: ToeicAnswerDiag[];    // 이 다시 풀기의 문항별 진단(§15-11)
}
interface ToeicAnswerHistoryEntry {      // 다시 풀기로 밀려난 예전 답
  q: number;
  replacedBy: string;          // 이 답을 밀어낸 다시 풀기 id
  replacedAt: string;          // 밀려난 시각(그 다시 풀기를 닫은 서버 시각)
  answer: ToeicAnswer;         // 밀려난 답 그대로(녹음 여부·길이·전사·대조·피드백·점수)
  recording: ToeicStoredRecording | null;    // 밀려난 녹음 메타(객체는 그대로 — 같은 키)
  fixRecordings: ToeicStoredFixRecording[];  // 밀려난 답의 고칠 문장 녹음(자리 번호가 그 답 피드백 기준이라 함께 옮긴다)
  diag: ToeicAnswerDiag | null;
  recordingDeletedAt: string | null;         // 예전 답의 녹음을 지운 시각(지우면 recording·fixRecordings 비움, 답은 남김)
}
interface ToeicAttemptRecord {
  // …§7-5·§12-3·§13-5·§14-1 필드 그대로
  retakes: ToeicRetakeSession[];         // startedAt 오름차순. 옛 문서 = []
  answerHistory: ToeicAnswerHistoryEntry[]; // q 오름차순 · 같은 q는 replacedAt 오름차순. 옛 문서 = []
  answerDiags: ToeicAnswerDiag[];        // 지금 답의 문항별 진단(q마다 하나, §15-11). 옛 문서 = []
}
```

- **셋 다 answers 밖이다.** "닫힌 응시" 판정(`finishedAt !== null || answers.length > 0`, §7-5)과 끝내기 한 번만(409 `already_finished`)은 그대로다 — 다시 풀기는 **닫힌 응시에만** 시작하고(§15-2), 끝내기 라우트를 다시 쓰지 않으며(자기 끝 라우트가 따로 있다 — §15-5), 합칠 때 answers의 **길이를 바꾸지 않고** 그 q 항목만 바꿔 끼운다(닫힘 판정이 뒤집힐 일이 없다). 이력을 `answers[q].history`처럼 answers 안에 두지 않은 이유: `ToeicAnswer`는 호출 D·채점 라우트·스트릭·비교가 함께 쓰는 모양이라 거기에 배열을 넣으면 그 모두가 이력까지 들고 다닌다.
- **지금 답의 세대**(`toeicAnswerSourceOf(attempt, q)`, 순수): 그 q 이력의 마지막 줄 `replacedBy`(= 지금 답을 만든 다시 풀기 id), 이력이 없으면 `null`(처음 응시). 업로드 판정·채점 경합·이 기기 사본의 쓰임새가 모두 이 값 하나를 본다. 이력 줄의 세대는 바로 앞 줄의 `replacedBy`(첫 줄은 `null`) — `toeicHistoryGenerationOf`.
- **상한**: 같은 q의 이력은 `TOEIC_RETAKE_HISTORY_MAX` = 10줄. 넘으면 다시 풀기를 시작하지 않는다(409 `history_full` — 자동으로 오래된 줄을 버리지 않는다. 녹음은 "기간 제한 없이 모두 보관"이 사용자 결정이라 조용히 잃지 않는다). 문서 크기는 이력 한 줄 3KB 안팎 × 11 × 10 = 330KB 안팎으로 1MiB 안이다. 다시 풀기 기록은 이력이 가리키지 않는 닫힌 기록을 최근 `TOEIC_RETAKE_SESSIONS_KEEP` = 30개만 남긴다(이력이 가리키는 기록은 늘 남긴다).
- 정규화(`normalizeToeicAttemptRecord`)가 셋을 명시적으로 옮긴다 — 깨진 항목만 버린다(`normalizeToeicRetakes`·`normalizeToeicAnswerHistory`·`normalizeToeicAnswerDiags`). 이력의 `answer`는 `normalizeToeicAnswer`를 지난다. 생성부는 `[]`로 시작한다(`New*` 필수 필드 — tsc가 잡는다). Firestore: 배열 속에 배열을 **바로** 넣지 않는다(객체 속 배열은 된다 — 코덱 불필요).

### 15-2. 다시 풀기 시작 — `POST /api/toeic/attempts/[id]/retakes`

본문 `{ questions: number[], replaceOpen?: string | null }`. AI를 부르지 않는다(키 검사 없음). 판정 `decideToeicRetakeStart(attempt, questions, nowMs, replaceOpen)`(순수, `lib/toeic-retake.ts`) — 스토어 원자 단위(파일 `mutate`, Firestore `runTransaction`) **안에서** 다시 부른다.

| 지금 | 결과 |
|---|---|
| 문항이 비었거나 중복·정수 아님 | 400 `invalid_input` |
| 응시 범위(`attempt.questions`) 밖 문항 | 404 `question_not_found` |
| 아직 닫히지 않은 응시 | 409 `not_finished` |
| 진행 중인 다시 풀기가 있고 `TOEIC_RETAKE_STALE_MS`(2시간) 안이며 `replaceOpen`이 그 id가 아님 | 409 `retake_in_progress` + `openRetake {id, startedAt, questions}` |
| 그 문항 이력이 이미 10줄 | 409 `history_full` + `questions`(가득 찬 문항) |
| 그 밖 | 시작 — 진행 중이던 다시 풀기(오래됐거나 `replaceOpen`으로 고른 것)는 **먼저 닫는다**(§15-5 합치기 규칙 — 대기 자리에 녹음이 올라온 문항은 그 녹음 길이로 합친다) → 새 기록을 더한다 |

- **동시 다시 풀기 방지**: 응시 하나에 진행 중 기록은 하나다. 다른 탭·기기에서 이미 열었으면 409 — 화면은 "다른 곳에서 다시 풀기가 진행 중이에요" + "그 다시 풀기를 닫고 새로 시작"(탭 → 같은 페이지에 `replace=<id>`를 붙여 다시 연다 — 시작 탭이 마이크 권한을 탭 안에서 얻어야 하므로 자동으로 다시 보내지 않는다). 두 시작 요청이 동시에 와도 원자 단위 안의 판정이 하나만 통과시킨다.
- 응답(`ToeicRetakeStartResponse`, `lib/toeic-attempt-contract.ts`): 200 `{ ok:true, retakeId, questions, startedAt }` · 400 · 404 `attempt_not_found`|`question_not_found` · 409 `not_finished`|`retake_in_progress`|`history_full` · 500 `save_failed`(retriable).

### 15-3. 다시 풀기 응시 화면 — `/toeic/attempts/[id]/retake?q=3,4`

- 서버 페이지가 응시·모의고사를 읽고 `q`(쉼표로 이은 문항 — `parseToeicRetakeQuestions`)를 응시 범위와 대조해 응시 화면(`ToeicTakeView`)을 **그대로** 띄운다(prop `retake: {attemptId, replaceOpen}`). 범위가 어긋나거나 닫히지 않은 응시는 이유와 "← 결과" 링크만. 녹음 보관 풀은 원래 응시와 같다(모의고사 `mock`, 한 문제 연습 `drill`).
- **형식은 실전 그대로**: 문항 목록이 `[3,4]`면 단계 엔진(`firstPhase`·`nextPhase` — 같은 함수)이 Q3 지시문(파트 첫 문항) → 준비 45초 → 비프 → 답변 30초 → Q4 준비…를 만든다. Q4만 고르면 지시문이 없다(파트 첫 문항이 아니다). Q9만 고르면 표 읽기(Q8 앞 45초)는 없고 표는 질문·준비·답변 동안 보인다. Q10은 질문을 두 번 듣는다. 지시문 글은 고른 문항 수로(`toeicPartDirections(part, count)` — 사진 1장이면 한 장짜리 문장, 읽기·프리페치·화면 세 곳이 같은 함수).
- 시작 탭: 지금 응시 화면과 같다(마이크 점검 → 탭 안 오디오 잠금 해제 → 프리페치 → 첫 단계). 응시 기록을 만드는 대신 `POST …/retakes`로 다시 풀기 id를 받는다. 409 `retake_in_progress`면 위 안내 화면, `history_full`이면 "이 문항은 다시 풀기 기록이 10개예요 — 🎙️ 내 녹음에서 예전 답 녹음을 지워도 기록은 남으니, 새 응시로 풀어 주세요".
- 녹음: 문항마다 지금처럼 기기(IndexedDB, 키 `{attemptId}:{q}` — 같은 키라 그 기기의 예전 답 사본을 새 녹음으로 바꾼다) → 백그라운드 업로드. 기기 메타에 `retakeId`를 더하고(옛 메타 = null) 업로드 multipart에 `retakeId` 필드를 싣는다(§15-4). 시작 화면은 고른 문항의 예전 녹음이 이 기기에서 아직 서버에 없으면(pending) "예전 녹음을 먼저 올릴게요"와 함께 대기열을 비우고, 그래도 남으면 "다시 풀면 이 기기의 예전 녹음은 새 녹음으로 바뀌어요"를 보인다(시작은 막지 않는다).
- 끝/그만두기·화면을 떠남(pagehide 비콘·언마운트 keepalive)은 `POST …/retakes/[rid]/finish`로 보낸다(본문 모양은 끝내기와 같다 — §15-5). 끝 화면: "다시 푼 Q3·Q4를 원래 결과에 합쳤어요" + "📊 결과 보기 · AI 채점"(원래 결과 화면).

### 15-4. 업로드 판정 — 녹음의 세대

답변 녹음 `PUT …/recordings/[q]`에 선택 필드 `retakeId`(없으면 처음 응시의 녹음 — 옛 클라이언트·옛 대기열 그대로)를 더한다. 판정 `decideToeicAnswerUpload(attempt, q, gen, incoming)`(`lib/toeic-retake.ts` — 이력이 없고 `gen`이 null이면 §13-4 표 `decideToeicRecordingUpload`와 **같은 결과**):

| 순서 | 조건 | 결과 |
|---|---|---|
| 1 | q가 응시 범위 밖 | `question_not_found` → 404 |
| 2 | `gen`이 있는데 그 다시 풀기가 없음 / q가 그 다시 풀기 문항이 아님 | `retake_not_found` → 404 · `question_not_found` → 404 |
| 3 | 지운 자리가 덮음(§14-3) | `deleted` → 409 `recording_deleted` |
| 4 | 그 다시 풀기가 **진행 중** | 대기 자리(`retake.recordings`) 표 — 없음 → `store_staged` · 같은 sha → `reused` · 이르거나 같음 → `superseded` · 더 새것 → `store_staged`(잠그지 않는다 — 아직 채점 전) |
| 5 | 닫혔는데 q를 합치지 않았다 | `retaken` → 200(저장 안 함 — 기기는 done) |
| 6 | `gen` = 지금 답의 세대 | §13-4 표 그대로(지금 메타 `recordings`·지금 답 `answers`) — `store`·`reused`·`superseded`·`locked` |
| 7 | `gen`이 이력 줄의 세대 | 그 줄 녹음이 없고(지운 적도 없고) 그 답이 `recorded` → `store_history`(다른 기기에서 늦게 온 예전 녹음을 이력에 붙인다) · 같은 sha → `reused` · 그 밖 → `retaken` |
| 8 | 그 밖 | `retaken` → 200 |

- 응답 `ToeicRecordingPutResponse` 200에 `slot: "current" | "staged" | "history" | null`을 더한다(`retaken`이면 `recording: null`·`slot: null`). 기기 대기열은 200이면 지금처럼 done이고, 결과 화면의 실시간 메타 합치기는 `slot === "current"`일 때만 쓴다(예전·대기 녹음이 지금 녹음 자리에 끼지 않게).
- 객체 키는 §13-1 그대로(`attempts/{id}/{q}/{recordedAtMs}`) — 세대를 키에 넣지 않는다. 한 녹음 = 한 객체라 세대가 달라도 키가 겹치지 않는다(녹음 시각이 다르다).
- 라우트는 지금처럼 판정을 **두 번**(쓰기 전·원자 단위 안) 한다. PUT 본문에 지우기 동작은 여전히 없다.

### 15-5. 다시 풀기 끝 — `POST /api/toeic/attempts/[id]/retakes/[rid]/finish` · 합치기 규칙

본문 `{ finishedAt: ISO | null, answers: [{ q, recorded, durationMs, diag? }] }`(끝내기와 같은 모양 + §15-11 진단). 범위는 그 다시 풀기 문항. **한 번만** 받는다 — 이미 닫힌 다시 풀기는 409 `already_finished`(+ `merged`·`recordedCount` — 저장 실패가 아니라 "이미 닫혔다"이므로 화면은 오류로 멈추지 않는다, 비콘·재시도·다른 탭 방어). **다만 409는 이 기기 녹음이 합쳐졌다는 뜻이 아니다** — 끝 화면 문구는 로컬 녹음 수가 아니라 응답(200·409)의 `merged`로 정한다(`toeicRetakeFinishOutcome(이 기기에서 녹음한 문항, merged)` → `{merged, notMerged}`, QA rec-retake P2-2). merged의 문항은 "다시 푼 Q3를 원래 결과에 합쳤어요", 이 기기에서 녹음했는데 merged에 없는 문항(다른 기기·탭이 다시 풀기를 새로 시작해 이 기록을 먼저 닫았다 — §15-2 교체·만료)은 "Q11는 다른 기기(또는 탭)에서 다시 풀기를 새로 시작해 … 원래 결과에 합치지 못했어요 — 이 녹음은 저장되지 않았어요(이 기기 사본도 지웠어요). 원래 답은 그대로예요"로 정직하게 보인다. 그 녹음은 들어갈 자리가 다시 생기지 않으므로(§15-4 5번 `retaken` · 결과 화면도 세대가 맞지 않아 쓰지 않는다 — `toeicLocalCopyRole` stale) 화면이 **그 다시 풀기 세대의 사본만** 지운다(`deleteToeicRecordingsLocal(aid, notMerged, { onlyGeneration: retakeId })` — 대기열에서도 빠진다, 다른 세대 사본은 건드리지 않는다). 업로드 요약·문항 행의 "서버 ✓"는 대기열 이벤트의 `slot`이 있을 때만 센다(200 `retaken`은 `slot: null` — 저장하지 않았으니 ✓가 아니다). 판정·합치기는 원자 단위 안에서 `applyToeicRetakeFinish(attempt, retakeId, input, nowIso)`(순수).

합치기(문항마다):

1. 이번에 녹음됐거나(`recorded` + 길이) **대기 자리에 녹음이 올라왔으면** 합친다. 녹음이 없는 문항(실패·중단·녹음 없이)은 **원래 답을 그대로 둔다** — 다시 풀다 또 실패해도 예전 답을 잃지 않는다.
2. 합치는 문항: 지금 답·지금 녹음 메타(`recordings[q]`)·그 답의 고칠 문장 녹음(`fixRecordings`의 q)·지금 진단(`answerDiags[q]`)을 이력 한 줄로 옮기고(`replacedBy` = 이 다시 풀기, `replacedAt` = 지금), 그 자리를 새 답 `{q, recorded:true, durationMs, transcript:null, readDiff:null, feedback:null, score:null, scoredAt:null}` · 대기 자리의 녹음 메타(아직 안 올라왔으면 없음 — 늦게 오면 §15-4 6번이 지금 자리에 넣는다) · 이번 진단으로 바꾼다. answers의 길이·순서는 그대로다.
3. 기록을 닫는다 — `closedAt` = 지금, `finishedAt` = 입력, `merged` = 합친 문항, `recordings` = [](옮겼다), `diags` = 이번 진단.
- **추정 총점·등급은 다시 계산된다** — 결과 화면이 `estimateToeicTotal(answers)`로 읽으므로 합친 문항이 채점되기 전에는 "11문항을 모두 채점하면"이 되고, AI 채점 받기 대상에 합친 문항이 든다. 머리에 "↻ 다시 푼 Q3·Q4를 채점하면 추정 등급을 다시 계산해요"와, 다시 풀기 전 답으로 계산한 추정이 있으면 "다시 풀기 전 추정 140 → 지금 150 (+10)"(`toeicRetakeEstimates` — 이력의 **첫** 줄 답을 다시 풀기 전 답으로 본다).
- 응답(`ToeicRetakeFinishResponse`): 200 `{ ok:true, retakeId, merged, recordedCount, answers }` · 400 · 404 `attempt_not_found`|`retake_not_found` · 409 `already_finished`(+ `merged`·`recordedCount`) · 500 `save_failed`. `merged`가 1개 이상이면 화면이 스트릭 갱신 신호를 쏜다(§15-9).

### 15-6. 채점·고칠 문장 녹음과의 경합

- **채점**(`POST …/score`): 라우트가 읽을 때의 세대(`toeicAnswerSourceOf`)를 기억하고, 저장(`updateToeicAttemptAnswer(id, q, patch, expectSource)`) 원자 단위 안에서 세대가 바뀌었으면 쓰지 않고 `ToeicAnswerChangedError` → 409 `answer_changed`("이 문항을 다시 풀어 답이 바뀌었어요 — 화면을 새로 고쳐 주세요"). 전사·피드백이 끝나기 전에 다시 풀기가 합쳐지면 예전 녹음의 전사·점수가 새 답에 붙던 경합을 막는다. 화면은 이 409를 받으면 새로 고친다.
- **고칠 문장 녹음**(`PUT …/fixes/[i]`): 화면이 그 답의 세대를 multipart `answerSource`(처음 응시는 빈 문자열)로 싣는다. 있고 지금 세대와 다르면 409 `answer_changed`(예전 피드백 자리 번호의 녹음이 새 피드백의 같은 번호에 붙지 않게). 없으면(옛 화면) 검사하지 않는다.
- **결과 화면의 이 기기 사본**: 사본의 `retakeId`(옛 메타 = null)가 지금 세대와 같을 때만 "지금 녹음"으로 쓴다(재생·채점). 이력 줄의 세대와 같으면 그 줄의 재생에 쓰고, 어느 쪽도 아니면 쓰지 않는다(`toeicLocalCopyRole`). 다른 기기에서 다시 풀어 세대가 바뀐 뒤 이 기기의 예전 사본으로 새 답을 채점하던 길을 막는다.

### 15-7. 결과 화면 (`components/toeic-attempt-view.tsx`)

- 닫힌 응시면 문항 카드 머리에 "↻ 이 문항 다시 풀기"(→ `/toeic/attempts/[id]/retake?q=N`). AI 채점 상자 위에 오류 문항이 있으면 "↻ 오류 문항 n개 다시 풀기"(→ `?q=…`)와 문항별 사유("Q3 소리 없음(무음) · Q4 녹음 실패").
- **오류 문항**(`toeicErrorQuestions`, 순수): 녹음 없음(`recorded:false` — 진단의 상태로 "녹음 실패"·"중단됨"·"소리 없음"·"녹음 없이"를 가른다) · 소리 없음(무음 — 진단 `silent`) · 녹음 지움(녹음됐는데 소리가 없고, 지운 자리의 가장 늦은 시각이 **지금 답 세대의 시작보다 늦다** — `toeicAnswerRecordingDeleted`. 지운 뒤 다시 풀어 합친 새 답이 아직 안 올라왔으면 "지움"이 아니라 "아직 서버에 올라가지 않았어요" 갈래다 — QA rec-retake P2-1) · 채점 실패(전사문은 있는데 점수가 없다, 또는 이 화면의 채점이 실패했다).
- **문항 카드 진단 줄**(F2): "마이크 유지 · 열기 1회 · 최고 레벨 0 · 18KB · 30.1초 · 소리 없음(무음)" / "녹음 실패 · 마이크 응답 없음(8초) · 열기 3회". 무음이면 머리 칩 "소리 없음(무음)".
- **③ 다시 풀기 기록**에 이 응시의 이력 줄이 들어간다(행 이름 "다시 풀기 전"·날짜 — 그 세대의 시작 시각: 처음 응시면 응시 시작, 다시 풀기면 그 시작). 시간순으로 다른 응시 행과 섞이고, 점수 변화(`toeicScoreDelta`)는 지금 답 − 앞선 가장 가까운 채점 행(이력 줄 포함). ▶는 이 기기 사본(그 세대) → 서버 사본(`GET …/recordings/[q]/history/[rid]` — 미리 받기 규칙 §13-8 그대로).
- 다시 풀기 기록이 진행 중이면 머리에 "↻ 다시 풀기 진행 중(Q3·Q4)" 한 줄(다른 탭에서 열었을 때 알아채게).

### 15-8. 지우기 — 지울 계획 · 예전 답 녹음

- 지울 대상에 `{kind:"history", q, replacedBy}`(예전 답 하나의 답변 녹음 + 그 답의 고칠 문장 녹음)를 더한다 — 라우트 `DELETE /api/toeic/attempts/[id]/recordings/[q]/history/[rid]`(같은 경로 `GET`은 그 녹음 바이트, 헤더는 §13-4 GET과 같다). 지우면 그 줄의 `recording`·`fixRecordings`를 비우고 `recordingDeletedAt`을 남긴다 — **답(점수·전사·피드백)은 남는다.**
- **지울 계획**(`toeicRecDeletionPlan(attempt, target)` → `{prefixes, keys}`): 이력이 없으면 지금처럼 접두사(§14-2 — 대체된 옛 객체까지). **그 q에 이력이 있으면** 지금 답·고칠 문장 지우기는 접두사 대신 **그 메타의 객체 키만** 지운다 — 세대가 같은 접두사(`attempts/{id}/{q}/`)를 쓰므로 접두사로 지우면 예전 답 녹음까지 지워진다. 예전 답 지우기는 늘 그 줄의 키들만. 응시 통째는 지금처럼 접두사(이력 녹음·대기 자리까지 메타도 함께 비운다).
- 대체된 옛 객체(같은 세대 안 "이 문항 다시")가 이력이 있는 q에서는 키 지우기로 남는다 — 응시 통째·모의고사를 지울 때 접두사째 사라진다(알려진 틈 §15-15).
- "🎙️ 내 녹음" 목록: 이력 녹음이 항목 `kind:"history"`("Q3 · 다시 풀기 전 답 · 날짜")로 보이고 하나씩 지운다. 목록 서버 요약에 이력 줄(녹음 메타·세대 시작·점수·`recordingDeletedAt`만)이 실린다. 예전 답의 "이 기기" 표시는 키 `${q}:${replacedBy}`로 가른다(결과 화면과 같다 — QA rec-retake P2-3).
- **다른 기기 사본**: 예전 답 지우기는 지운 자리를 남기지 않으므로(위) 지운 자리만 보는 정리로는 다른 기기의 그 세대 사본이 남는다. 결과 화면과 목록이 열릴 때 이 기기 사본 중 쓰임새가 이력 줄이고 그 줄의 `recordingDeletedAt`이 있는 것을 지운다(`toeicDeletedHistoryLocalCopies` → `deleteToeicRecordingsLocal(id, [q], { keepGeneration: 지금 세대 })` — 지금 답 사본은 남긴다, QA rec-retake P2-4). 목록은 `purgeLocalHistory`로 넘긴다.

### 15-9. 스트릭 — 다시 풀기도 센다

- 닫혔고 합친 문항이 1개 이상인 다시 풀기 기록은 **그 시작 시각(KST 날짜)의 영어 트랙 세션**으로 센다(`toeicStreakSessions` — 합친 문항 = answered). 처음 응시가 어제고 오늘 다시 풀었으면 오늘도 공부한 날이다. 원래 응시의 세션은 그대로다(합쳐도 그 응시의 녹음된 문항 수는 줄지 않는다).

### 15-10. F1 — 무음 감지 (`lib/toeic-mic-health.ts` 순수 + `lib/mic-session.ts` + 응시 화면)

- **레벨 표본**: 응시 화면이 녹음 중 90ms마다 `rec.level()`을 읽는다. 표본은 `rec.levelReliable()`(분석기가 있고 오디오 컨텍스트가 `running`)일 때만 센다 — 컨텍스트가 멈추면 분석기가 0을 내어 무음으로 잘못 판정하기 때문이다. `stepLevelTrack(state, {at, level, reliable})`가 최고 레벨·표본 수·조용해진 시각을 모은다.
- **판정**(`toeicSilenceVerdict`): 믿을 표본이 `TOEIC_SILENCE_MIN_SAMPLES`(10 ≈ 0.9초) 미만이면 `unknown`(판정하지 않는다), 최고 레벨이 `TOEIC_SILENT_PEAK_LEVEL`(= 마이크 점검 문턱 `TOEIC_MIC_CHECK_OK_LEVEL` 0.35의 1/3 ≈ -53dB) 미만이면 `silent`, 아니면 `sound`. 문턱 상수는 이 모듈 한 곳이다(응시 화면의 점검 ✓도 같은 상수를 import한다).
- **무음이면**: 그 문항을 "소리 없음(무음)"(상태 `silent`)으로 표시하고 녹음은 **버리지 않는다**(기기 저장·서버 보관·`recorded:true` — 거짓 양성이어도 목소리를 잃지 않고, 결과 화면에서 들어 보고 다시 풀거나 채점할 수 있다). 안내 "Q3에 소리가 들어오지 않았어요 — 마이크를 다시 열어요" 뒤 **마이크를 놓아**(`releaseMic`) 다음 답변이 새로 연다(F3가 탭으로 다시 켜게 한다).
- **녹음을 켠 뒤 트랙이 muted면 다시 연다**(`lib/mic-session.ts` keep): 입력을 켠 뒤 트랙이 `muted`면 `MIC_UNMUTE_WAIT_MS`(300ms) 동안 `unmute`를 기다리고, 그래도 muted면 쥔 스트림을 버리고 한 번 다시 얻는다(같은 대기 상한). 다시 얻은 트랙도 muted면 그대로 녹음한다(무음 판정이 잡는다). 꺼 둔 동안의 muted는 여전히 근거로 쓰지 않는다 — **켠 뒤에만** 본다(§6-4 "`muted`는 재획득 근거로 쓰지 않는다"는 이 한 곳에서 바뀐다). 다시 연 횟수는 녹음의 `remuted`로 진단에 남는다.
- **같은 응시에서 두 번**(무음 판정 + muted 다시 열기의 합 `TOEIC_MIC_TROUBLE_MAX` = 2)이면 그 응시는 남은 문항을 문항마다 열기로 바꾼다(`toeicMicTroubleAction` — keeper를 per-answer로 다시 만든다. 기기 설정은 바꾸지 않는다). 진단 줄 "마이크 문항마다(이번 응시만 — 소리 문제 2회)".
- **실시간 알림**: 녹음 중 레벨이 문턱 아래로 `TOEIC_SILENCE_ALERT_MS`(3초) 넘게 이어지면 녹음 카드에 "🔇 소리가 안 들어와요 — 마이크를 가리지 않았는지 확인해 주세요"(소리가 다시 들어오면 사라진다). 녹음은 멈추지 않는다.

### 15-11. F2 — 문항별 진단 (`ToeicAnswerDiag`)

```ts
interface ToeicAnswerDiag {
  q: number;
  status: "recorded" | "silent" | "interrupted" | "failed" | "empty" | "nomic" | "none";
  policy: "keep" | "per-answer" | null;  // 이 문항을 녹음할 때의 마이크 정책
  opens: number;                          // 이 문항 동안 getUserMedia 호출 수(0..20)
  remuted: number;                        // 켠 뒤 muted라 다시 연 횟수(0..5)
  error: string | null;                   // 마지막 오류(≤120자)
  peak: number | null;                    // 최고 레벨 0..1(소수 둘째 자리) — 잴 수 없었으면 null
  size: number | null;                    // 녹음 바이트
  durationMs: number | null;
  silent: boolean;                        // F1 무음 판정
}
```

- 응시 화면이 문항마다 모아 **끝내기 본문**(`answers[].diag`, 선택 — 옛 화면은 없다)과 다시 풀기 끝 본문에 싣는다. 서버는 zod로 범위만 확인하고(정책 열거·정수 범위·문자열 길이) `answerDiags`(지금 답)·다시 풀기 기록의 `diags`에 둔다. 판정에는 쓰지 않는다(표시·오류 문항 사유용) — 화면이 보낸 값을 믿어도 해가 없는 자리다.
- 응시 화면 끝 화면 행에도 같은 진단을 한 줄로("녹음됨 · 30.1초 · 18KB · 최고 레벨 85 · 열기 1회").
- 비콘·keepalive 끝내기 본문은 진단을 실어도 2KB 안팎이라 한도(64KiB)와 무관하다.

### 15-12. F3 — 탭 안 재획득 (`toeicMicPromptReducer` 순수 상태 기계 + 응시 화면)

- **언제 멈추나**: ① 마이크를 놓은 상태(keep인데 쥔 스트림이 없고 여는 중도 아님 — 숨김·무음 판정·트랙 ended)로 **준비 단계에 들어갈 때**와 **답변을 열 때**(`toeicMicGate` → `ask_tap`) ② 답변 녹음 시작이 8초 감시에 걸리거나 `timeout`·`failed`·`busy`·`no_device`로 실패했을 때(`toeicMicFailureAction` — `denied`·`unsupported`는 지금처럼 시간만 잰다). 시계는 멈춘다(그 단계의 종료 시각을 비운다).
- **화면**: "🎙️ 마이크를 다시 켜 주세요"와 버튼 "🎙️ 마이크 다시 켜기"(탭 안에서 동기로 — 준비 앞이면 `keeper.prime()`, 답변이면 그 답변 녹음을 **탭 안에서** 다시 시작해 권한 창이 탭 맥락에서 뜬다. 대기 상한은 점검과 같은 15초) / "시간만 재고 계속"(지금의 녹음 없이 진행). 탭 안 재획득도 실패하면 이유를 보이고 같은 두 버튼.
- 상태 기계: `idle` →(need)→ `ask` →(tap)→ `opening` →(opened)→ `idle` / →(fail)→ `failed` →(tap)→ `opening` · 어디서든 (skip) → `idle`. eval이 전이표를 잠근다.
- **같이 손질**(QA mic-keep P3-3~P3-6): 시작 탭은 `ensureToeicAudio`·`unlockSpeechPlayback`·`setAudioSessionPlayback` **뒤에** `prime`(P3-3). 숨김 뒤 재개 탭("다시 듣기"·"질문 보기"·"다음 문항으로"·지시문 "계속")도 keep이고 놓였으면 탭 안에서 `prime`(P3-4). per-answer `startRecording`도 기다리는 사이 놓였으면 "released"로 버린다(P3-5). 진단의 열기 횟수는 실제 getUserMedia를 부를 때만 센다(P3-6).

### 15-13. 결과 화면 고칠 문장 녹음은 마이크 유지로 고정

- `components/use-toeic-fix-recorder.ts`는 `createMicKeeper({ policy: toeicFixRecMicPolicy(detectMicKeepEnv()) })` — **기기 설정과 상관없이** Apple WebKit + `navigator.audioSession`이면 keep, 그 밖 per-answer(`lib/mic-session.ts` 순수 함수, eval이 잠근다). 근거: 결과 화면의 녹음은 모두 사용자의 🎤 탭으로 시작하고 끝나면 바로 ▶로 들을 수 있어 무음을 사람이 곧 알아챈다 — 응시 화면처럼 타이머가 탭 없이 이어 가는 자리가 아니다. 그래서 권한을 한 번만 묻는 이득이 위험보다 크다(§14-7의 "같은 기기 설정을 따른다"는 이 절로 바뀐다).
- 결과 화면 "⚙️ 소리 설정"의 "문항마다 마이크 다시 열기"는 **응시·다시 풀기 화면용 설정**으로 남기고 문구를 "응시·다시 풀기 화면에만 적용돼요(이 화면의 고칠 문장 녹음은 마이크를 화면 동안 하나로 유지해요)"로 바꾼다. 바꿔도 결과 화면의 쥔 마이크는 놓지 않는다.

### 15-14. eval (오프라인 — `scripts/eval-toeic-retake.ts`, `eval-toeic.ts`가 불러 한 번에 돈다, 실호출 0·GCS 0)

① 시작 판정 표(위 여섯 줄 + 오래된 진행 기록 자동 닫기 + replaceOpen + 동시 두 시작 — 원자 단위 하나만) ② 합치기(녹음된 문항만·녹음 없으면 원래 답 그대로·answers 길이 불변·닫힘 판정 불변·이력 줄 모양·지금 메타/고칠 문장/진단 이동·대기 자리 비움·한 번만 409) ③ 세대 판정 표(§15-4 여덟 줄 — 이력 없음 + gen null이면 §13-4 표와 같음을 무작위 대조) ④ 채점 경합(세대 바뀜 → answer_changed, 같으면 저장) ⑤ 추정 재계산(합친 뒤 미완 → 채점 뒤 완성 · 다시 풀기 전 추정) ⑥ 지울 계획(이력 없음 → 접두사 · 이력 있음 → 키 · 예전 답 → 그 줄 키 · 통째 → 접두사 + 이력 메타 비움) ⑦ 정규화(옛 문서 · 깨진 항목) ⑧ 비교 행(이력 줄 시간순·점수 변화·세대 시작 시각) ⑨ 이 기기 사본 쓰임새 ⑩ 오류 문항 사유 ⑪ 스트릭(다시 풀기 날짜) ⑫ 파일 백엔드 자식 프로세스(시작 → 업로드 대기 → 끝 → 합침 → 늦은 업로드 지금 자리 → 예전 녹음 GET → 예전 답 지우기 → 통째 지우기 · 실패 주입 일관성) ⑬ F1 무음 판정·실시간 알림·문제 횟수 ⑭ F2 진단 zod 경계·저장 ⑮ F3 상태 기계 전이표·게이트·실패 분기 ⑯ 고칠 문장 녹음 정책(설정 무시) ⑰ 소스 대조(라우트 순서·원자 단위·PUT 본문 지우기 없음·키 검사 없음·번들 경계·화면 배선). `eval-toeic.ts`의 마이크 유지 K22는 "muted를 켠 뒤에만 본다"로 좁히고, K25(켠 뒤 muted → 다시 얻음·`remuted` 1)·K25b/c(기다리는 사이 unmute → 다시 열지 않음)·K26(per-answer 기다리는 사이 놓기 → released, 열기 횟수 = 실제 getUserMedia)·K27(`opening()`)을 더했다. 소스 대조 셋(끝내기 범위 검사 한 벌·PUT 세대 판정·고칠 문장 녹음기 정책)은 새 모양으로 좁혔다. → `eval:toeic` 오프라인 **1576항목**(1436 → 1576, 줄어든 항목 없음). 수정 루프 1(QA rec-retake P2-1~P2-4)에서 ⑱ 반례 묶음(지운 자리 vs 세대 시작·끝 화면 merged·목록 키·지운 예전 답 사본 + 이 기기 보관소 keepGeneration/onlyGeneration 메모리 실행)을 더해 **1606항목**.

### 15-15. 열린 결정 · 알려진 틈

- **열린 결정 — 응시 화면 마이크 기본값**: F1~F3가 들어간 뒤 "마이크 유지"(keep)를 다시 기본으로 할지는 실기기 확인(SPEC §20-13) 뒤 오케스트레이터가 정한다. 지금은 0ec640c 그대로(설정이 없으면 문항마다 열기).
- 열린 결정: 이력 상한 10(넘으면 시작 거부) · 진행 중 기록 만료 2시간 · 무음 문턱(-53dB)·알림 3초·문제 횟수 2 · 채점 실패도 오류 문항에 넣기.
- 알려진 틈: ① 같은 기기에서 예전 답 녹음이 아직 서버에 없을 때 다시 풀면 기기 사본이 새 녹음으로 바뀐다(시작 화면이 먼저 올리고 남으면 알린다). ② 이력이 있는 문항의 대체된 옛 객체(같은 세대 안 다시 녹음)는 키 지우기로 남는다(통째·모의고사 삭제 때 사라진다). ③ 고칠 문장 녹음의 세대 검사는 새 화면부터(옛 화면은 `answerSource`가 없다). ④ 진단은 화면이 보낸 값이다(판정에 쓰지 않는다).

## 16. 결과(첨삭) 화면 인쇄 · PDF 저장 (2026-10-03)

> 사용자 요청(2026-10-03): "시험결과 첨삭화면에 인쇄(PDF출력)기능을 추가해줄래?" — **서버·AI·저장소 변경 0**. 브라우저 인쇄(`window.print()`) + 결과 화면 모듈 CSS의 `@media print`다. 인쇄 창에서 "PDF로 저장"을 고르면 PDF가 된다(iPhone Safari는 인쇄 화면의 공유 버튼 → 파일에 저장). 선례는 북카드 인쇄(`components/card-view.tsx`의 `window.print()`·`card-view.module.css`의 `@media print`·`app/globals.css` §9 `@page`·`.print-hide`).

### 16-0. 결정 (오케스트레이터 확정 2026-10-03)

- 버튼 하나 "🖨️ 인쇄 · PDF 저장" — 결과 머리(제목·칩 줄 아래)에, 안내 한 줄과 함께. PDF를 서버에서 만들지 않는다(브라우저 인쇄 = PDF 저장).
- 인쇄 대상 접기(표 보기·모범답변)는 **펼쳐서** 싣는다. 학습 화면 전용 장치(재생·녹음·비교·틀 점검·다시 풀기·설정·진단)는 뺀다.
- 다크 모드 여부와 상관없이 흰 바탕·검은 글자. 흑백 인쇄에서도 강조가 보이게 한다.

### 16-1. 파일

| 파일 | 하는 일 |
|---|---|
| `components/use-print-expand.ts` | `usePrintExpand(rootRef)` → `{ printNow, preparing }`. `details[data-print-expand]` 중 **닫혀 있던 것만** 열어 "훅이 연 것"으로 기억하고(사용자가 열어 둔 접기는 건드리지 않는다), `afterprint`에서 기억한 것만 닫는다. 루트에서 `toggle`을 잡아 사용자가 여닫은 접기는 기억에서 뺀다(16-4). 루트 안 `loading="lazy"` 사진은 eager로 바꾼다. `beforeprint`(Cmd+P·브라우저 메뉴)와 버튼(`printNow`) 두 경로가 같은 `expand`를 부른다 |
| `components/toeic-attempt-view.tsx` | 버튼·인쇄 전용 머리 줄·`data-print-expand` 두 곳(표 보기·모범답변)·`recBlock`/`printHide` 표시·Q8–10 표 한 번만·받지 못한 사진 → 장면 설명 줄(`brokenImgs`)·인쇄 전용 "↻ 다시 푼 답이에요"·Q1–2 안내 뒤 구절 분리 |
| `components/toeic-attempt-view.module.css` | `.printBar`·`.printOnly` + `@media print` 한 덩어리 |
| `app/toeic/attempts/[id]/page.tsx` | 페이지 머리(← 뒤로·날짜)에 전역 `print-hide` — 날짜는 결과 화면의 인쇄 전용 줄이 다시 적는다 |

전역 CSS(`app/globals.css`)는 건드리지 않았다. 학습 스트릭 헤드라인·새 배포 줄은 원래 `print-hide`라 이 화면 인쇄에서도 빠지고, 다른 화면(북카드) 인쇄는 그대로다.

### 16-2. 인쇄에 들어가는 것

- **머리**: 범위 kicker(실전 응시·파트 연습·공략 연습 · …)·모의고사 제목·칩(끝까지/중단·녹음 n/m문항)·**인쇄 전용 줄** "응시 {KST 날짜 시각} · 채점 n / m문항(· 추정 s / 200 · 등급)"·틀 점검 요약 줄·응시 변화(📈)·다시 풀기 전 추정 → 지금 줄·추정 총점 상자(완성이면 점수·등급, 아니면 안내 문장). "↻ 다시 푼 Qn를 채점하면 추정 등급을 다시 계산해요"는 화면 조작을 권하는 문장이라 뺀다.
- **문항마다**: Q 배지·파트 이름·점수 칩(·점수 변화 칩·무음 칩), 다시 푼 답이면 인쇄 전용 줄 "↻ 다시 푼 답이에요"(화면의 "이 문항 다시 풀기" 줄은 조작 줄이라 빠지므로 표시만 따로), 사진(Q3–4 — 사진이 없거나 **받지 못했으면**(404·네트워크 — `<img onError>`, 하이드레이션 전에 실패한 사진은 마운트 때 `complete && naturalWidth === 0`로 다시 잰다) 장면 한 줄 "📷 {sceneKo}" — 화면·인쇄 공통), 지문 intro, **표**(접기를 펼쳐서 — Q8–10은 같은 표라 범위 안 첫 문항에만 싣고 나머지는 "표는 Qn과 같아요." 한 줄. 화면은 그대로 문항마다 "표 보기"), 질문, 내가 말한 것(전사)·무응답 문구, Q1–2 지문 대조(정확도·취소선·밑줄·범례·"🔈 발음·억양은 채점하지 않았어요" — 같은 문장의 뒤 구절 " — 녹음을 다시 들어 보세요"는 화면 조작 안내라 인쇄에서 뺀다), 피드백 전부(요약·👍 잘한 점·✏️ 고칠 문장 말한 것 → 이렇게 · 이유·🧩 빠진 내용·🌱 개선 답변·📒 넣었으면 좋았을 표현), **모범답변 접기 속 전부**(모범답변(활용 표현 강조)·모범답변 점검 줄·미달 경고 문장·💡 팁·📌 묘사 포인트·🗂 답변 뼈대).
- 내 답변 전사문은 화면에서도 강조가 없다(틀 강조는 🎧 비교 ② 안에만 있다) — 인쇄도 강조 없이 싣는다. 활용 표현 강조는 모범답변 속 `<mark>`다.

### 16-3. 인쇄에서 빠지는 것

모든 버튼과 링크 — 🖨️ 버튼 줄·🔊 듣기·`<audio>`(내 녹음 플레이어·공용 이어 듣기 플레이어)·**내 녹음 블록 통째**(서버 줄·🗑 녹음 지우기·F2 녹음 진단·"불러오는 중" 문구)·고칠 문장 줄의 🎤/▶/⇄/🗑·녹음 상태 줄·🔴 듣는 중·🎧 비교 접기·🧩 틀 점검(모의고사의 닫힌 접기와 연습의 펼친 섹션 둘 다)·"↻ 이 문항 다시 풀기" 줄·오류 문항 상자·AI 채점 상자(⚙️ 소리 설정 포함)·채점 진행 줄·문항 진단 줄·마지막 녹음 진단 캡션·🗄️ 녹음 서버 보관 줄(지금 올리기·내 녹음 모아보기)·닫히지 않은 응시 경고 상자·"다시 풀기 진행 중" 줄·"다시 푼 Qn를 채점하면…" 줄·Q1–2 안내 뒤 구절 "— 녹음을 다시 들어 보세요"·오류 문구(`.error`)·"🧩 템플릿 훈련 →" 같은 링크 화살표·끝 버튼 줄(다시 응시·학습 보기로 / 같은 문제 다시·새 문제)·접기 머리(`summary` — "모범답변(참고용) 보기"·"표 보기")·페이지 머리(← 뒤로).

### 16-4. 접기 펼치기 · 사진

- 닫힌 `<details>`는 CSS만으로 내용이 인쇄되지 않는 브라우저가 있어 JS가 연다. 두 경로가 같다 — `beforeprint`(Cmd+P·메뉴 인쇄)와 버튼 핸들러. 버튼은 재생·고칠 문장 녹음을 먼저 멈추고(`stopAllPlayback` — 인쇄 창이 떠 있는 동안 소리가 이어지지 않게) 연 뒤 `window.print()`.
- **기억 규칙**(QA print 1 F2에서 정함): 훅이 연 접기만 기억(Set)했다가 `afterprint`에서 닫는다. 같은 접기를 두 경로가 두 번 열어도 한 번만 기억한다. 훅은 여닫기 전에 기대 상태를 적어 두고, 루트에서 캡처로 받은 `toggle`이 그 기대와 다르면(= 사용자 탭) 그 접기를 기억에서 뺀다 — **사용자가 한 번이라도 여닫은 접기는 사용자 것**이라 훅이 닫지 않는다. 그래서 `afterprint`가 오지 않는 브라우저(iOS Safari 등)에서:
  - 훅이 연 채 남은 접기를 사용자가 손대지 않았으면 → 다음 인쇄의 `afterprint`가 닫는다(여전히 훅이 연 것).
  - 사용자가 닫았으면 → 기억에서 빠지고, 다음 인쇄가 닫힌 것을 새로 열어 다시 기억한다.
  - 사용자가 닫았다가 일부러 다시 열었으면 → 사용자 것이라 열린 채 둔다.
  `afterprint`가 끝내 오지 않는 회차 바로 뒤에는 펼친 접기가 화면에 남는다(닫으면 된다).
- **사진·print 시점**: 사진은 `loading="lazy"`라 아직 안 받았을 수 있다. 버튼 경로는 eager로 바꾸고, 기다릴 사진이 없으면 **클릭 핸들러 안에서 동기로** `window.print()`를 부른다(iOS Safari·홈 화면 앱은 사용자 제스처 밖 print를 막을 수 있다). 안 받은 사진이 있을 때만 최대 4초(`PRINT_IMAGE_WAIT_MS`) 기다린 뒤 부른다(그동안 버튼 "사진 불러오는 중…") — 그사이 화면을 떠났으면(언마운트 플래그·`rootRef.current` null) 부르지 않는다(QA print 1 F3 — 다른 화면에서 인쇄 창이 뜨지 않게). 받기에 실패한 사진(404)은 `complete`라 기다리지 않는다. `beforeprint` 경로는 기다릴 수 없어 eager로 바꾸기만 한다.

### 16-5. 쪽 · 색

- A4 세로·여백 12mm·글자 토큰 약 90%는 `app/globals.css` §9 그대로(북카드와 같은 `@page`).
- 문항 카드째 쪽 나눔을 막지 않는다(긴 카드는 큰 공백만 만든다). 인쇄에서 카드는 상자 대신 **위 굵은 선**(쪽이 나뉠 때 빈 상자 테두리가 쪽 끝에 남지 않게)이고, 문항 머리·소제목(`.label`·`.labelRow`) 뒤에서 끊지 않으며 고칠 문장 한 개·질문·사진·요약·목록 한 줄·점검 줄·**표**(짧다 — 쪽보다 길어지지 않는다)는 쪼개지 않는다. 표는 앞의 문항 머리·상황 소개와도 떨어지지 않게 `break-before: avoid`·상황 소개 `break-after: avoid`(QA print 1 F1 — 쪽 끝에 머리와 표 제목만 남던 것). 사진은 쪽 폭의 60%까지.
- 색: 결과 화면 루트 안에서만 토큰을 밝은 값으로 다시 정한다(`--bg` 흰색·`--ink` 검정·`--ink-2/3`은 화면보다 진하게 — 회색 캡션이 종이에서 흐려지지 않게, `color-scheme: light`). 흑백에서도 보이게 모범답변 활용 표현은 **굵게 + 밑줄**(틀 글자에서 온 구간은 이중 밑줄), 고친 문장은 굵게, 말한 것은 취소선.

### 16-6. 같은 컴포넌트를 쓰는 화면

결과 화면 컴포넌트는 `/toeic/attempts/[id]` 한 곳이고 실전 응시·파트 연습·유형별 공략 한 문제 연습(`drill`)·문항 다시 풀기를 합친 결과가 모두 이 화면이다 — 모두 같은 버튼·같은 인쇄를 받는다(연습의 펼친 🧩 틀 점검 섹션도 뺀다). 🎙️ 내 녹음 목록(`/toeic/recordings`)·모의고사 학습 보기는 다른 컴포넌트라 이번 범위 밖이다(같은 훅으로 붙일 수 있다).

### 16-7. 검증

- eval: 새 항목 없음. 결과 화면 소스 대조 하나(`scripts/eval-toeic-guides-s3.ts` — 모범답변 접기 안 묘사 포인트·답변 뼈대 순서)가 여는 태그를 `<details className={s.model}>` 전체 문자열로 찾던 것을 속성이 붙어도 찾게 앞부분(`<details className={s.model}`)으로 넓혔다. `eval:toeic` 오프라인 1610항목 통과.
- 헤드리스(Chromium 데스크톱 라이트·폰 390 다크 — 키 없음·file 스토어·무음, 지어낸 11문항 응시. WebKit 폰 다크는 버튼 경로·인쇄 미디어 글자만 — 수정 1의 회귀는 16-9): 버튼 순간 인쇄 대상 접기 12/12 열림·사진 로드 완료·lazy 0, `afterprint` 뒤 사용자가 연 접기 하나만 열림, `beforeprint`/`afterprint` 왕복, 인쇄 미디어에서 보이는 버튼·오디오·링크 0, 필수 글자 22종 있음·버튼 글자 17종 없음, 흰 바탕·검은 제목, 활용 표현 굵게 + 밑줄, 가로 넘침 0, 표 한 번, `page.pdf()`(접기를 닫아 둔 채 — Chromium 인쇄 경로가 `beforeprint`를 쏘아 모범답변까지 실리고 뒤에 다시 닫힘) A4 9쪽.

### 16-8. 알려진 틈 · 실기기

- `beforeprint` 경로(키보드·메뉴 인쇄)는 아직 안 받은 lazy 사진을 기다릴 수 없다 — 사진이 빠지면 버튼으로 인쇄한다(버튼은 기다린다).
- iOS Safari에서 `afterprint`가 오지 않으면 그 회차 뒤 표·모범답변 접기가 열린 채로 남는다(닫으면 된다 — 사용자가 손댄 접기는 이후 훅이 닫지 않는다, 16-4).
- 사진을 기다린 경우(4초 안)의 `window.print()`는 클릭 제스처 밖이다 — iOS가 막거나 확인 창을 띄울 수 있다(사진이 이미 있으면 제스처 안). 실기기 확인 항목.
- 실기기 확인은 SPEC §20-14 목록.

### 16-9. 수정 1 (QA `qa_report_toeic_print_1.md` P3 6건, 2026-10-03)

F1 표 `break-inside`/`break-before: avoid`·상황 소개 `break-after: avoid`(16-5) · F2 기억 규칙 — 사용자 `toggle`은 기억에서 뺀다(16-4) · F3 기다리는 사이 언마운트면 print 안 함 + 기다릴 사진이 없으면 클릭 안 동기 print(16-4) · F4 받지 못한 사진 → 장면 설명 줄, 화면·인쇄 공통(16-2) · F5 조작 안내("— 녹음을 다시 들어 보세요"·"다시 푼 Qn를 채점하면…") 인쇄에서 뺌, "↻ 다시 푼 답이에요"는 인쇄 전용 줄로 남김(16-2·16-3) · F6 이 절과 SPEC §20-14를 코드에 맞춤. 검증: 회귀 e2e 26/26(동기 print = `window.event.type === "click"`, 묵은 기억·다시 연 접기·닫은 접기·인쇄 전 연 접기, PDF에서 표 제목·마지막 행·각주·Q8 머리가 한 쪽, 404 사진 → 장면 줄 화면·인쇄, 멈춘 사진 대기 중 이동 → print 0·머무르면 4초 뒤 1), 기존 e2e 132/132·WebKit, QA e2e 재실행 162/166(나머지 4는 탐침 "OLD answer."(🎧 비교 ③ 안 — 인쇄에 없는 것이 맞다)과 F5로 의도해 남긴 "다시 푼 답이에요"), `eval:toeic` 1610, tsc·build 0.

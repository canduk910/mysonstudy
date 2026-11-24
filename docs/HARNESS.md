# AI 하네스 공통 규약 — 은우학습

**은우학습 프로젝트 · 과목 공통 문서**

> **하네스란?** LLM 호출을 감싸는 뼈대입니다 — 프롬프트, 출력 스키마, 검증, 재시도, 로깅을 한 세트로 묶은 것.
> 말과 마차를 잇는 마구(harness)처럼, 모델의 힘이 정확한 방향으로만 나가게 잡아주는 장치예요.

이 저장소는 AI를 쓰는 과목 넷을 기릅니다 — **영어(북카드)**, **수학(수학코치)**, **일본어(아빠의 일본어)**, **토익스피킹(아빠의 영어)**. 과목마다 프롬프트도 스키마도
다르지만 **호출을 감싸는 방식은 같습니다.** 이 문서는 그 공통분모만 담습니다. 프롬프트 원문·출력
스키마·평가 항목처럼 과목마다 갈리는 것은 전부 과목별 문서에 있습니다.


> **절 번호 표기 규칙.** 코드 주석·리포트에 `HARNESS §N`처럼 문서명 없이 적힌 참조는
> **그 코드가 속한 과목의 스펙**을 가리킨다 — `lib/ai/english/`·`app/api/` 영어 경로면
> `docs/harness/english.md`, 수학 경로면 `docs/harness/math.md`, 일본어 경로(`lib/ai/japanese/`·`app/api/japanese/`)면 `docs/harness/japanese.md`, 토익 경로(`lib/ai/toeic/`·`app/api/toeic/`)면 `docs/harness/toeic.md`다. 이 공통 문서를 가리킬
> 때는 반드시 `docs/HARNESS.md §N`처럼 파일명을 함께 적는다. 과목 분리(2026-08-17) 이전에
> 쓰인 참조가 40곳 이상이라 관례를 유지하는 쪽을 택했다.

## 0. 과목별 문서

| 과목 | 스펙 | 프롬프트·스키마 | eval | npm 스크립트 |
|---|---|---|---|---|
| **영어 (북카드)** | [`docs/harness/english.md`](./harness/english.md) | `lib/ai/english/` | `scripts/eval-english.ts` | `npm run eval:english` |
| **수학 (수학코치)** | [`docs/harness/math.md`](./harness/math.md) | `lib/ai/math/` | `scripts/eval-math.ts` | `npm run eval:math` |
| **일본어 (아빠의 일본어)** | [`docs/harness/japanese.md`](./harness/japanese.md) | `lib/ai/japanese/` | `scripts/eval-japanese.ts` | `npm run eval:japanese` |
| **토익스피킹 (아빠의 영어)** | [`docs/harness/toeic.md`](./harness/toeic.md) | `lib/ai/toeic/` | `scripts/eval-toeic.ts` | `npm run eval:toeic` |
| **엄마의 생활영어 (2026-10-09)** | [`docs/harness/mom.md`](./harness/mom.md) | `lib/ai/mom/` | `scripts/eval-mom.ts` | `npm run eval:mom` |
| **표현 도우미 (과목 공통 — 아빠의 영어·아빠의 일본어·은우 영어)** | [`docs/harness/phrase-helper.md`](./harness/phrase-helper.md) | `lib/ai/phrase-helper/` | `scripts/eval-phrase-helper.ts` | `npm run eval:phrase` |

표현 도우미(2026-10-03)는 과목이 아니라 세 영역이 **호출 하나를 모드 셋**(`toeic`·`japanese`·`english-kid`)으로 나눠 쓰는 공통 기능이라 스펙·코드·eval을 과목 중립 한 곳에 둡니다 — 진입 함수는 `lib/ai/phrase-helper/calls.ts`(토익처럼 과목 폴더, `lib/ai/client.ts`에 넣지 않는다), 모델은 전용 env `OPENAI_PHRASE_HELPER_MODEL`(빈 값이면 `gpt-6-luna`). 과목 문서에는 포인터 한 줄만 있습니다.

앱 전체 명세는 [`docs/SPEC.md`](./SPEC.md), 디자인 원본은 `design/`에 있습니다.

**하네스(이 문서의 `callWithSchema()` 규약) 밖에 있는 것 두 종류:**
- **LLM을 쓰지 않는 기능** — **아빠의 운동**(러시안 파이터 루틴, SPEC §19)은 규칙이 전부 결정적이라 순수 함수 엔진(`lib/workout.ts`)이 하고, 회귀 가드는 오프라인 `npm run eval:workout`입니다. **학습 스트릭**(SPEC §17, `eval:streak`)도 AI가 없습니다. 토익스피킹 안에서도 표현 시험 출제·모의고사 형식표·Q1–2 지문 대조·추정 총점은 LLM이 아닌 순수 함수입니다(`docs/harness/toeic.md` §5-4·§5-5·§6). **유형별 공략**(2026-09-27, `toeic.md` §12)도 새 AI 호출이 없습니다 — 공략·틀 은행은 파일로 가져오고(AI 0), 따라 말하기 대본·틀 테스트의 받아쓰기 비교(전사문 ↔ 틀 고정 부분)·전사문 속 틀 찾기는 순수 함수(`lib/toeic-template.ts`)이며, 한 문제 연습은 호출 C를 입력만 바꿔 부르고 템플릿 테스트는 관문 T만 씁니다(기대 문장을 보내지 않는 규칙 그대로).
- **AI를 쓰지만 Structured Outputs 하네스 밖인 호출** — **클라우드 발음**(SPEC §16·§16-5, `lib/tts.ts`)은 OpenAI 유료 호출이지만 스키마 없는 오디오 호출이라 `callWithSchema()`·zod·재요청·토큰 로그를 거치지 않고, 키 규약(`OPENAI_API_KEY`, 없으면 501 → 기기 음성)만 공유합니다. 대화 해설 **낭독**(SPEC §18)은 일본어 해설 화면의 기능이고, 그 연속 재생 엔진(`speakQueue`)은 과목 공용이며 `eval:speech`가 잠급니다. 운동 세션의 음성 안내도 이 발음 경로를 거칩니다.
  토익스피킹의 **관문 P**(모의고사 Q3–4 사진 생성, `lib/toeic-image.ts`)와 **관문 T**(답변 음성 전사, `lib/toeic-transcribe.ts`)도 같은 부류입니다 — 이미지·오디오 바이트를 주고받는 호출이라 `callWithSchema()`·zod·재요청을 거치지 않고, 각자 **독립 OpenAI 클라이언트**를 쥐고(`lib/ai/client.ts`에 과목 분기를 넣지 않는다) 키 규약만 공유합니다(키가 없으면 네트워크 호출 없이 `no_api_key` → 라우트 501). 모델은 `OPENAI_IMAGE_MODEL`·`OPENAI_IMAGE_QUALITY`·`OPENAI_TRANSCRIBE_MODEL`(빈 값이면 기본값 — SPEC §11). 로그에는 모델·크기·ms 같은 숫자만 남기고 프롬프트·사진·전사문·오디오는 남기지 않습니다. 전사에는 기대 문장을 `prompt`로 넣지 않습니다(`docs/harness/toeic.md` §5-0).
  아빠의 일본어 **말하기 모의고사**(2026-10-25, `docs/harness/japanese.md` §15, SPEC §26)는 토익 모의고사 모양을 일본어로 옮기면서 하네스 밖 관문 둘을 따로 둡니다 — 관문 **P**(일본 배경 사진, `lib/ja-speaking-image.ts` — 아래 사진 공용 코어를 부른다)와 관문 **T-ja**(일본어 답변 전사, `lib/ja-speaking-transcribe.ts` — `language: "ja"` 고정, `prompt` 인자 없음, 관문 T와 같은 원칙). 출제(호출 E1~E5)·피드백(호출 F)은 하네스 **안**이고 진입 함수는 일본어 관례대로 `lib/ai/client.ts`(`generateJaSpeakingPart`·`generateJaSpeakingFeedback`), 모델은 메인 기본(`resolveModel()` — 토익 출제·채점 모델 env를 쓰지 않는다). Q1–2 지문 읽기 대조는 AI가 아니라 순수 함수(`lib/ja-speaking-score.ts` `alignJaReadAloud` — 지문 토큰의 표기·후리가나 읽기 두 갈래를 전사문과 편집거리로 맞춘다)입니다.
  아빠의 일본어 **🗓️ 오늘의 일본어**(2026-11-15, SPEC §27, `docs/harness/japanese.md` §16)는 **새 LLM 호출이 없는** 일일 학습 루틴입니다 — 🎤 핵심 문장 체크의 받아쓰기는 위 관문 **T-ja**를 그대로 부르고(`POST /api/japanese/daily/transcribe` → `transcribeJaSpeakingAnswer`, 기대 문장 미전송), 판정은 같은 순수 함수 `alignJaReadAloud`의 정확도(`lib/ja-daily-judge.ts` — 0.8·0.5)입니다. 과정 엔진(`lib/ja-daily-plan.ts`)·5지선다 보기(`lib/ja-daily-quiz.ts`)·원음 묶음 파서(`lib/ja-audio-pack.ts`)는 AI 없는 순수 함수이고, 교재 원음은 서버에 가지 않고 아빠 기기 IndexedDB에만 들어갑니다(`lib/ja-audio-store.ts`). 회귀 가드는 오프라인 `npm run eval:ja-daily`(실호출 0).
  표현 도우미 마이크 모드의 **관문 K**(한국어 음성 전사, `lib/phrase-helper-transcribe.ts`, 2026-10-03 — SPEC §22-2, `docs/harness/phrase-helper.md` §13)도 같은 부류입니다. 관문 T는 손대지 않고 모양만 따라 새로 썼습니다 — 같은 모델 env `OPENAI_TRANSCRIBE_MODEL`(관문 T의 해석 함수를 그대로 부른다), `language: "ko"` 고정, `prompt` 인자 없음(자유 입력이라 유도할 기대 문장이 없다), 20초 상한·SDK 재시도 0(사람이 기다리는 호출 — 실패는 🎤를 다시 누른다), `req.signal`로 끊으면 상류도 멈춤(499). 녹음·전사문은 저장하지 않고, 화면은 돌려받은 글을 입력 칸에 **채우기만** 합니다(자동 전송 없음 — 사람이 고친 뒤 보낸다).
  **사진 생성 공용 코어**(`lib/image-gen.ts`, 2026-09-26): 관문 P의 모델 env 해석·키 규약·JPEG data URL 조립·크기 상한을 넘으면 다음 압축으로 1회 다시 만들기·로그 모양을 코어로 옮겼고, 토익 사진(`lib/toeic-image.ts` — medium·1536×1024·압축 70→50)과 은우 자유대화 주제 일러스트(`lib/talk-image.ts` — medium 고정·1024×1024·60→40)가 **자기 설정만 인자로 넘겨** 같은 코어를 씁니다. 코어는 과목을 모릅니다(`lib/ai/client.ts`에 과목 분기를 두지 않는 것과 같은 원칙). 토익 동작은 불변입니다(`eval:toeic`, QA가 HEAD 원본과 같은 스텁에서 요청·결과 동일을 확인).
  은우 자유대화의 **관문 R**(OpenAI Realtime — 음성 ↔ 음성 실시간 대화, `docs/harness/english.md` §12, SPEC §21)도 하네스 밖입니다. 브라우저가 OpenAI와 **WebRTC**로 직접 음성을 주고받고, 앱 서버는 연결(SDP 교환 — 통합 인터페이스 `POST /v1/realtime/calls`, `lib/talk-gateway.ts`)과 끊기(hangup)만 표준 키로 중계합니다 — 브라우저에는 키가 가지 않습니다. 모델 출력이 JSON이 아니라 음성·전사 이벤트라 `callWithSchema()`·zod·재요청·토큰 로그를 거치지 않고 **키 규약만 공유**합니다(키가 없으면 연결 라우트가 OpenAI를 부르지 않고 501). 대신 정확성 장치가 다른 자리에 있습니다: 선생님 지시문 원문은 spec-sync(`block-exact`)로, 세션 설정은 SDK GA 타입으로 tsc가, 이벤트 → 스크립트는 순수 리듀서(`lib/talk-transcript.ts`)가 잡습니다. 대화 중 화면 카드(도움·그림 카드)는 2026-09-27부터 음성 모델이 아니라 하네스 **안**의 호출 J(`callWithSchema` — 선생님 줄마다, `docs/harness/english.md` §12-7)가 만들고, 순수 후처리(`lib/talk-cards.ts` `sanitizeTalkScreenCards` — 모델 출력을 믿지 않고 잘못된 항목·선생님 말에 없는 그림 카드를 버린다)가 거릅니다. 그 전에는 선생님이 도구 호출로 카드를 보냈는데, 도구 응답 뒤 앱의 이어 말하기가 새 응답을 만들어 선생님이 두 명처럼 답해 세션에서 도구를 뺐습니다. 모델은 `OPENAI_REALTIME_MODEL`(기본 `gpt-realtime-2.1`)·`OPENAI_REALTIME_VOICE`(`marin`)·`OPENAI_REALTIME_TRANSCRIBE_MODEL`(`gpt-4o-mini-transcribe`), 빈 값이면 기본값(SPEC §11). 서버 로그에는 SDP·지시문·전사를 남기지 않고(상태·ms만), 은우 발화 전사는 언어를 영어로 고정하고(`language: "en"` — 자동 감지가 아이 영어를 다른 언어로 적었다, 2026-09-27) `prompt`·`keywords`는 주지 않습니다(관문 T와 같은 원칙 — 하지 않은 말이 맞게 적히는 위험). 대화가 끝난 뒤의 문장 설명(호출 I)과 대화 중 화면 카드(호출 J — 모델은 `OPENAI_TALK_CARDS_MODEL`, 빈 값이면 `gpt-6-luna`)는 하네스 **안**(`callWithSchema`)입니다.

**작업할 때는 해당 과목의 문서만 읽으세요.** 여러 과목을 함께 읽으면 컨텍스트만 늘고 프롬프트가 섞입니다.

## 1. 공통 규약

모든 과목의 모든 AI 호출이 예외 없이 지키는 규칙입니다.

- **모든 호출은 서버(route handler·스크립트)에서만.** API 키를 클라이언트에 노출하지 않는다.
  `lib/ai/client.ts`는 `openai`와 키를 건드리므로 클라이언트 컴포넌트에서 import할 수 없다.
- **OpenAI Responses API + Structured Outputs**(`json_schema`, `strict: true`)를 쓴다.
  strict 모드의 필수 조건: 모든 필드가 `required`, 모든 객체에 `additionalProperties: false`.
  "선택" 필드는 빼는 게 아니라 null 유니온(`["string", "null"]`)으로 표현한다.
- **응답은 zod로 이중 검증한다.** JSON Schema가 타입을 잡고, zod가 스키마로 표현할 수 없는
  제약(개수·중복·금지어·상호 의존)을 잡는다. 두 겹을 다 통과해야 성공이다.
- **검증 실패 시 오류 메시지를 첨부해 1회만 재요청**하고, 그래도 실패하면 throw한다.
  재요청은 원래 입력 뒤에 assistant 턴(이전 출력 원문)과 user 턴("다음 검증 오류를 고쳐 다시
  출력해: {오류}")을 덧붙여 다시 호출한다. 무한 재시도는 비용만 태운다.
- **호출마다 `{ call, model, inputTokens, outputTokens, ms }`를 서버 로그로 남긴다** (비용 추적).
  성공·실패와 무관하게 남기고, 재요청이 발생하면 두 호출의 토큰을 합산해 기록한다.
- **모델 ID는 env `OPENAI_MODEL`, 키는 env `OPENAI_API_KEY`. 하드코딩 금지.**
  기본값(env가 비었을 때)은 코드 상수 한 곳 — 2026-10-02 사용자 결정으로 텍스트 호출은 **토익 출제·채점만 `gpt-6.1-sol`**(env `OPENAI_TOEIC_MODEL`, `lib/ai/toeic/model.ts` `resolveToeicModel`), **나머지는 모두 `gpt-6-luna`**(`OPENAI_MODEL` `DEFAULT_OPENAI_MODEL`, 화면 카드 `OPENAI_TALK_CARDS_MODEL`, 표현 도우미 `OPENAI_PHRASE_HELPER_MODEL` — 2026-10-03, 수학 검산 `OPENAI_MODEL_VERIFY`는 비면 메인)다. 호출별로 다른 모델은 `callWithSchema`의 `model` 인자로 호출부가 넘긴다(§2).
  temperature: 이름으로 추론 계열이라 알려진 모델(`gpt-5.6`+·`gpt-6.x`의 `-luna`·`-sol`·`-terra` — `isKnownTemperatureRejectingModel`)은 첫 요청부터 temperature를 싣지 않는다. 그 밖의 모델은 싣고, 400으로 거부되면 빼고 1회 재시도한 뒤 그 모델을 프로세스 안에서 기억한다. 그런 모델에는 이 문서와 과목 스펙의 temperature 다이얼이 적용되지 않는다.
- **배열 개수 제약은 JSON Schema가 아니라 프롬프트 + zod에서 강제한다.**
  strict 모드의 `minItems`/`maxItems` 지원 여부가 모델·버전마다 달라서, 스키마에 넣으면
  조용히 무시되거나 호출 자체가 거부된다. 개수는 프롬프트 문장으로 지시하고 zod로 확인한다.

## 2. 공통 래퍼 — `callWithSchema()`

`lib/ai/client.ts`에 있는 **과목 공유** 모듈입니다. 모든 과목이 같은 래퍼를 지나갑니다.

```
입력: { call, system, user, jsonSchema, zodSchema, temperature, maxOutputTokens }

동작:
1. Responses API 호출 (Structured Outputs, strict)
2. JSON 파싱 → zodSchema.safeParse()
3. 실패 시: 검증 오류를 붙여 1회 재요청
4. 재요청도 실패하면 throw (라우트가 사용자에게 재시도 버튼을 노출한다)
5. 성공/실패 무관 로깅: { call, model, inputTokens, outputTokens, ms }
```

- `call` 식별자는 과목별 문서가 정의한다 (영어: `extract`·`pages`·`card`).
- 출력 한도 도달(`status === "incomplete"`)은 JSON 파싱 실패와 같은 재요청 경로로 보낸다.
- 선택 인자 셋 — `model`(이 호출에만 쓸 모델 — 생략하면 `OPENAI_MODEL`, 예: 수학 검산 `resolveVerifyModel()`·자유대화 호출 J `resolveTalkCardsModel()`·토익 출제·채점 C·D `resolveToeicModel()`), `signal`(요청 취소·시간 상한), `maxRetries`(이 호출의 SDK 자동 재시도 횟수). `signal`·`maxRetries`는 2026-09-27 영어 자유대화 호출 J(서버 6초 상한·재시도 0 — `docs/harness/english.md` §12-7)가 쓰려고 더했다. 둘 다 과목 분기가 아닌 일반 인자이고, 넘기지 않으면 요청 옵션 없이 기존 모양 그대로 나간다(`buildCallRequestOptions` — `!== undefined`로 판정해 `maxRetries: 0`도 빠지지 않는다). SDK는 429·503의 `retry-after`를 끊는 신호 없이 기다리므로, 시간 상한이 있는 호출은 `maxRetries: 0`을 넘겨야 상한이 지켜진다.
- **과목별 분기를 이 파일에 넣지 않는다.** 분기가 필요하면 호출부에 둔다 —
  client를 고치면 모든 과목이 함께 영향받는다.

## 3. 파일 배치

```
lib/ai/client.ts          # 공통 래퍼 + OpenAI 클라이언트 — 과목 공유
lib/ai/english/           # 영어 전용 프롬프트·스키마
lib/ai/math/              # 수학 전용 프롬프트·스키마·검산 파이프라인
lib/ai/japanese/          # 일본어 전용 프롬프트·스키마
lib/ai/toeic/             # 토익스피킹 전용 프롬프트·스키마·후처리(호출 A~D) + 유형별 공략 가져오기 판정(guide-import.ts)
lib/ai/mom/               # 엄마의 생활영어 호출 M1(주간 테스트 총평) 프롬프트·스키마·진입 함수(calls.ts, 서버 전용) — 받아쓰기는 토익 관문 T 재사용
lib/ai/phrase-helper/     # 표현 도우미(과목 공통 — 모드 셋) 프롬프트·스키마·모델·진입 함수(calls.ts, 서버 전용)
lib/phrase-helper.ts      # 표현 도우미 입력 정리·로컬 판정·결과 타입(클라이언트 안전, 런타임 import 0)
lib/image-gen.ts          # 사진 생성 공용 코어(관문 P·자유대화 일러스트 공유) — 하네스 밖(서버 전용)
lib/toeic-image.ts        # 토익 관문 P(사진 생성) — 공용 코어에 토익 설정만 넘긴다(서버 전용)
lib/talk-image.ts         # 자유대화 주제 일러스트 — 공용 코어에 대화 설정만 넘긴다(서버 전용)
lib/toeic-transcribe.ts   # 토익 관문 T(음성 전사) — 하네스 밖(서버 전용)
lib/phrase-helper-transcribe.ts # 표현 도우미 관문 K(한국어 음성 전사 — 마이크 모드) — 하네스 밖(서버 전용)
lib/phrase-helper-scope.ts # 표현 도우미 경로→모드·시험 화면 판정·블록 카운터(클라이언트 안전, 런타임 import 0)
lib/talk-session-config.ts # 자유대화 관문 R 세션 설정·지시문 조립(서버 전용, 네트워크 없음)
lib/talk-gateway.ts       # 자유대화 관문 R 네트워크(연결·hangup) — 하네스 밖(서버 전용)
scripts/eval-english.ts   # 영어 평가 하네스
scripts/eval-math.ts      # 수학 평가 하네스
scripts/eval-japanese.ts  # 일본어 평가 하네스
scripts/eval-toeic.ts     # 토익스피킹 평가 하네스
scripts/eval-mom.ts       # 엄마의 생활영어 평가 하네스(오프라인 + 게이트 EVAL_MOM=1)
scripts/eval-phrase-helper.ts # 표현 도우미 평가 하네스(오프라인 + 게이트 EVAL_PHRASE=1)
scripts/eval-toeic-guides*.ts # 토익 유형별 공략 eval 조각 넷(eval-toeic.ts가 불러 한 번에 돈다)
docs/harness/english.md   # 영어 스펙 (단일 진실 원천)
docs/harness/math.md      # 수학 스펙
docs/harness/japanese.md  # 일본어 스펙
docs/harness/toeic.md     # 토익스피킹 스펙
docs/harness/mom.md       # 엄마의 생활영어 스펙
docs/harness/phrase-helper.md # 표현 도우미 스펙(과목 공통)
```

## 4. 운영 규칙

- **프롬프트 원문과 JSON Schema는 스펙 문서에서 원문 그대로 옮긴다.** 요약·재해석·"개선" 금지.
  개수·비율 다이얼이 프롬프트 문장 안에 박혀 있고 eval이 그 숫자에 걸려 있어서, 문구 하나가
  품질과 eval 통과 여부를 좌우한다.
- **같은 제약이 여러 곳에 중복 정의된다** — 프롬프트 문구 · JSON Schema · zod · eval 점검.
  한 곳만 고치면 "eval은 통과하는데 런타임 검증이 실패"하거나 그 반대가 된다. 다이얼을 바꿀
  때는 정의된 모든 위치를 함께 맞춘다.
- **프롬프트 수정 → 해당 과목 eval 실행 → 통과 확인 → 커밋.** 이 순서를 지킨다.
  **영어·수학 eval의 실호출 경로**는 실제 OpenAI 호출이 발생하므로 CI가 아니라 수동 실행이고, 비용 승인 없이 반복하지 않는다.
  반대로 **오프라인 구간**(`EVAL_OFFLINE_ONLY=1`)은 CI(`.github/workflows/deploy.yml`의 ci 잡, 배포 전)가 키·GCP 신호·PIN을 빈 값으로, `STORE_BACKEND=file`로 고정하고 11개 eval(`workout`·`streak`·`review`·`speech`·`ja-daily`·`japanese`·`english`·`math`·`toeic`·`mom`·`phrase`)을 돌린다(2026-11-25). 새 eval을 만들면 키 없이·`data/private` 없이 통과하는지 확인하고 그 목록에 더한다.
  오프라인 항목(`EVAL_OFFLINE_ONLY=1`)·일본어 eval(현재 오프라인 전용 — 실호출 게이트 `EVAL_JAPANESE`는 자리만)·
  `eval:speech`·`eval:workout`·`eval:streak`는 실호출이 없어 언제든 돌려도 된다.
  **표현 도우미 eval(`eval:phrase`)도 기본이 오프라인**(무비용 — 입력 정리·로컬 판정·모드별 zod 반례·spec-sync 원문 4·JSON Schema 2 의미 동치)이고, 실호출은 `EVAL_PHRASE=1`일 때만 모드마다 지어낸 입력 1개(3회, `EVAL_PHRASE_MODE`로 하나만)다 — 동의 후 오케스트레이터가 실행한다.
  **엄마의 생활영어 eval(`eval:mom`)도 기본이 오프라인**(무비용 — 진도 엔진·발화 판정·가져오기 zod·라우트 배선·토익 녹음 보호·spec-sync 원문 1·JSON Schema 1 의미 동치)이고, 실호출은 `EVAL_MOM=1`일 때만 호출 M1 1회(지어낸 5문항)다 — `EVAL_OFFLINE_ONLY=1`이면 건너뛴다. 동의 후 오케스트레이터가 실행한다. 진도·판정은 AI가 없는 순수 함수(`lib/mom-plan.ts`·`lib/mom-judge.ts`)다.
  **토익스피킹 eval(`eval:toeic`)은 기본이 오프라인**(무비용 — zod 반례·후처리·시험 출제·형식표·Q1–2 대조·추정 총점·스트릭 트랙 분리·
  spec-sync 바이트 대조와 JSON Schema 8개 의미 동치)이라 언제든 돌려도 된다. 실호출은 **`EVAL_TOEIC=1`일 때만** 호출 A(사진 경로
  `EVAL_TOEIC_PHOTO`가 있을 때만)·B(표현 7개)·C(파트 하나, `EVAL_TOEIC_PART` 기본 opinion)·D(픽스처 전사문 하나)를 한 번씩 부르고,
  `EVAL_OFFLINE_ONLY=1`이면 게이트를 켜도 건너뛴다(네트워크 자체를 막는 2차 방어선). 관문 P·T는 실호출 점검 대상이 아니다 —
  오프라인에서 env 빈 값 폴백·키 없음(`no_api_key`)·전사 `prompt` 부재 같은 계약을 잠근다. 자유대화 관문 R도 같다 — `eval:english`
  오프라인이 지시문 spec-sync·세션 설정(env 빈 값 폴백·도구 없음·전사는 `language: "en"`·`prompt` 없음)·리듀서·호출 J 후처리·도움 상태 기계와
  (2026-09-27부터) 합성 이벤트 전송 위의 실시간 컨트롤러를 잠그고, 실제 연결(WebRTC·음성)은 eval 밖이다(개발 빌드 전용 가짜 전송 e2e + 사용자 동의 후 실기기).
  호출 I는 영어 게이트 `EVAL_TALK=1`(2회). 호출 J는 게이트가 없다 — 진입 함수 배선은 오프라인 정적 점검이 소스로 잠근다. 교재 가져오기 파일 검증(표현집 파일과 유형별 공략 파일 `data/private/toeic-strategy/toeic-guides.json` 둘)은 `data/private/`에 파일이 있을 때만 돌고
  없으면 SKIP이다(공개 저장소·CI 기준). 게이트 실호출도 비용이 드는 검증이라 **사용자 동의 후 오케스트레이터가** 실행한다.

## 5. 공급자 층 — Anthropic(Claude) 메인 + OpenAI 백업 (2026-11-25)

`callWithSchema()`(§2)를 지나는 텍스트·이미지 판독 호출은 공급자를 **env 하나로** 바꿀 수 있습니다. 1단계 기본값은 지금과 같은 **OpenAI**라 배포만으로는 동작이 바뀌지 않습니다(프로덕션에 `ANTHROPIC_API_KEY`가 없다 — 백업 길도 열리지 않는다). 비LLM OpenAI 기능(TTS `lib/tts.ts`·전사 관문 넷·자유대화 Realtime `lib/talk-gateway.ts`·사진 `lib/image-gen.ts`)은 Anthropic 대체가 없어 이 층 밖이고 그대로 OpenAI 전용입니다.

| env | 값 | 뜻 |
|---|---|---|
| `AI_PROVIDER` | `openai`(빈 값·모르는 값 포함) · `anthropic` | 메인 공급자 |
| `AI_FALLBACK` | `on`(기본) · `off`(`0`·`false`·`no`도 끔) | 메인이 가용성 실패면 다른 공급자로 같은 흐름 한 번 더 — **백업 키가 있을 때만** |
| `ANTHROPIC_API_KEY` | 서버 전용 비밀 | Claude 키(빈 값 = 없음) |
| `ANTHROPIC_MODEL` | 빈 값이면 `claude-opus-5-5` | Claude 모델(호출별 OpenAI 모델 env는 Claude 경로에 쓰지 않는다) |

- **코드 자리.** 공급자 선택·키 판정은 순수 함수 `lib/ai/provider.ts`(`resolveProviderPlan`·`hasLlmKey`, import 0), Claude 요청·응답 변환은 순수 함수 `lib/ai/provider-anthropic.ts`(SDK는 `import type`만), 백업 판정은 `lib/ai/provider-errors.ts`(`decideFallback` — 두 SDK의 typed 오류 클래스로만, 문자열 매칭 없음), 네트워크는 `lib/ai/client.ts`(`getAnthropicClient` — 지연 생성). 래퍼는 여전히 라벨(`call`)로 분기하지 않는다.
- **같은 계약, 다른 전송.** Claude 경로도 §1·§2 그대로 — Structured Outputs(`output_config.format: json_schema`) → JSON.parse → zod → 1회 재요청 → 재실패 throw → 로깅. 차이: ① 보낼 스키마 **사본**에서 Claude가 받지 않는 키(`minLength`·`maxLength`·`minimum`·`maximum`·`multipleOf`·`maxItems`·2 이상 `minItems`·`pattern`·모르는 `format` 등)를 떼고 모든 객체에 `additionalProperties: false`를 강제한다(스펙 원문 상수는 그대로 — 뗀 제약은 zod가 본다. 현재 스펙 스키마 39개는 뗄 것이 0개). ② `temperature`·`thinking`을 싣지 않는다(`claude-opus-5-5`는 temperature를 400으로 거부하고 thinking을 끌 수 없다 — 이 문서와 과목 스펙의 temperature 다이얼은 Claude에 적용되지 않는다). 깊이는 `output_config.effort`. ③ `max_tokens = maxOutputTokens`. ④ 이미지 data URL은 base64 image 블록(jpeg·png·gif·webp, 이미지가 텍스트보다 먼저인 순서 유지). ⑤ 서버 측 거절 폴백(beta `server-side-fallback-2026-07-01` + `fallbacks: "default"`)을 기본으로 싣는다. ⑥ `stop_reason: "refusal"`은 재요청 없이 곧바로 백업 경로, `max_tokens`는 OpenAI `incomplete`와 같은 zod 재요청 경로.
- **effort.** 호출부가 `CallWithSchemaArgs.effort`로 넘길 수 있고(라벨로 고르지 않는다), 생략하면 `medium`. 2026-11-25 사용자 결정("대부분 호출은 sonnet medium")으로 호출부의 `low`/`high` 덮어쓰기를 모두 지워 **모든 Claude 호출이 `medium`**이다(eval:provider가 덮어쓰기 재등장을 잡는다). **OpenAI 경로에는 싣지 않는다**(기존 요청 모양 불변). 과목 스펙의 호출 옵션 상수·문장(temperature·maxOutputTokens·call 라벨)은 바꾸지 않았다(spec-sync 대상).
- **백업 흐름.** 메인으로 "1회 + zod 재요청 1회". 메인이 **가용성 실패** — 529 overloaded·5xx·429(SDK 재시도 소진 후)·408·연결 오류·타임아웃·거절·재요청까지 검증 실패·Claude가 받지 않는 입력 — 이고 `AI_FALLBACK`이 켜져 있고 백업 키가 있으면 백업 공급자로 같은 흐름을 한 번. 400·401·403·404·422 같은 요청/설정 오류와 그 밖의 예외는 숨기지 않고 던진다. **사용자 취소(`signal` abort)는 어떤 경우에도 백업으로 넘기지 않는다.** 메인 키가 없고 백업 키만 있으면 처음부터 백업을 부른다(로그 `fallback.reason = "primary_no_key"`). 백업 OpenAI는 호출부가 넘긴 `model`(또는 `OPENAI_MODEL`)을 그대로 쓴다.
- **호출부 고정.** `CallWithSchemaArgs.provider`를 넘기면 그 공급자 하나만, 백업 없음. 영어 자유대화 호출 J(화면 카드, 6초 상한)가 `"openai"`로 고정한다(Claude 지연 위험) — 그래서 그 라우트의 키 검사도 OpenAI 키(`hasTalkApiKey`) 그대로다. 수학 설명(호출 B)과 검산(호출 C)도 2026-11-25부터 `"openai"` 고정이다 — 설명 스키마는 Claude 스모크에서 "compiled grammar is too large"(400)로 거부됐고(400은 백업으로 넘기지 않는다), 검산은 사용자 결정으로 OpenAI 심판(`OPENAI_MODEL_VERIFY` = 프로덕션 `gpt-6.1-sol`)만 쓴다.
- **클라이언트 상한.** 두 SDK 클라이언트 모두 `timeout` 120초·자동 재시도 1회(`LLM_CLIENT_TIMEOUT_MS`·`LLM_CLIENT_MAX_RETRIES` — 전에는 OpenAI SDK 기본 10분·2회라 화면이 접은 뒤에도 서버가 기다리며 과금됐다). 호출별 `signal`·`maxRetries`(호출 J 6초·0회)는 요청 옵션으로 그대로 덮는다.
- **로그.** `{ call, model, inputTokens, outputTokens, ms, provider, fallback }` — `model`·`provider`는 실제로 답한 쪽(Claude 서버 측 폴백이 돌면 응답의 대체 모델 이름), `fallback`은 `null` 또는 `{ from, reason }`. 토큰은 메인·백업·재요청을 모두 합산한다(Claude 입력은 캐시 쓰기·읽기 포함).
- **라우트 키 검사.** LLM만 부르는 라우트 28개는 `hasLlmKey()`(실제로 부를 공급자의 키가 있는지 — 메인 키, 또는 백업이 켜져 있으면 백업 키)로 501 `no_api_key`를 낸다. OpenAI 전용 기능(TTS·사진) 라우트는 `OPENAI_API_KEY` 그대로, 채점 라우트 둘(토익·일본어 말하기 — 전사 + 피드백)은 AI 앞 `hasLlmKey()` + 전사 관문이 자기 키 검사의 `no_api_key`를 501로. 토익 섬 해석(호출 G, 후처리 서버 모듈)도 `hasLlmKey()`. 목록은 `scripts/eval-provider.ts`의 `LLM_KEY_ROUTES`·`OPENAI_ONLY_KEY_ROUTES`가 단일 정의처이고 `app/api` 전수 점검이 미분류 라우트를 실패로 잡는다 — 새 AI 라우트를 만들면 여기에 한 줄.
- **회귀 가드.** 오프라인 `npm run eval:provider`(실호출 0) — 스키마 정리·파트 변환·요청 조립·응답 해석·공급자 선택 표·백업 판정 표(실제 SDK 오류 클래스)·**루프백 스텁 위의 실제 흐름**(529 → 백업, 400 → 던짐, 거절 → 백업, 취소 → 백업 0, 기본은 OpenAI만, 고정, zod 재요청 — 전역 fetch를 감싸 127.0.0.1 밖 요청은 던진다)·정적 점검·라우트 키 분류. 안전 접두어에 `ANTHROPIC_API_KEY=`를 더한다.
- **Claude 켜는 절차(사람 몫).** ① Secret Manager에 `ANTHROPIC_API_KEY` 비밀을 만들고 Cloud Run 서비스에 env로 연결 ② (선택) `ANTHROPIC_MODEL` ③ `AI_PROVIDER=anthropic` — 이때부터 OpenAI는 백업(`AI_FALLBACK` 기본 on, OpenAI 키는 TTS·전사·실시간 음성·사진 때문에 어차피 필요). 되돌리기는 `AI_PROVIDER`를 비우는 것 하나. 키만 넣고 `AI_PROVIDER`를 비워 두면 OpenAI 메인 + Claude 백업이다.
- **QA 후속(2026-11-25, `qa_report_common_provider_1`).**
  - **max_tokens 하한**: Claude 요청만 `max(maxOutputTokens, CLAUDE_MIN_MAX_TOKENS = 8,000)`. thinking을 끌 수 없어 짧은 호출(엄마 총평 400·단어 뜻 600·유의어 추천 800·문장 설명 1,500)이 thinking만으로 잘려 재요청 → 백업으로 번지는 것을 막는다. max_tokens는 상한이라 비용은 늘지 않는다. OpenAI 요청과 과목 옵션 상수는 불변이다. (effort는 위 항목대로 전부 `medium`.)
  - **이미지 한도**: base64 길이로 장당 5MB·요청 합계 30MB를 넘으면 요청 전에 `ClaudeInputError`(백업 대상)로 판정한다. 400·413 왕복이 없다. 413(`ContentTooLargeError`, OpenAI 413)도 백업 대상이다(다른 공급자는 받을 수 있는 크기 한도).
  - **로그 토큰 분리**: 맨 위 `inputTokens`·`outputTokens`·`model`·`provider`는 답한(마지막) 공급자 몫이다. 백업이 돌았으면 메인 몫은 `fallback.{model, inputTokens, outputTokens, error}`에 따로 남는다. 합산하지 않는다.
  - **백업도 실패**: 백업 오류를 클래스 그대로 던진다(라우트 instanceof 보존). 메인 오류는 `primaryError`(+ 비어 있으면 `cause`)로 붙는다.
  - **Claude 호출별 모델**: `CallWithSchemaArgs.anthropicModel`(OpenAI `model`의 짝)이다. 토익 출제·채점 4곳은 `resolveAnthropicToeicModel()`(env `ANTHROPIC_TOEIC_MODEL`)이고, 비면 `ANTHROPIC_MODEL`이다(`resolveAnthropicVerifyModel()`은 남아 있지만 검산이 OpenAI 고정이라 지금은 쓰이지 않는다). 토익 레코드의 `model` 칸은 여전히 OpenAI 모델 이름을 남긴다(2단계 과제).
  - **클라이언트 상한 값**(120초·재시도 1회)은 eval이 값과 스텁 요청 횟수로 잠근다.
  - **스모크 게이트** `scripts/smoke-anthropic-schemas.ts`: 스키마 39개를 Claude에 1회씩(effort low) 보낸다. `SMOKE_ANTHROPIC=1` + `ANTHROPIC_API_KEY`가 없으면 네트워크 전에 종료하고, npm 스크립트로 등록하지 않는다. **비용이 드는 실호출이라 사용자 동의 후 오케스트레이터가 `AI_PROVIDER=anthropic` 전환 전에 돌린다.** 오프라인 짝은 eval:provider의 `validateClaudeSchema` 점검이다(정리 뒤 지원 안 하는 키 0·additionalProperties:false·재귀 없음 — 현재 39개 통과).
- **2단계 준비(2026-11-25).**
  - **레코드 `model` = 실제 답한 모델**: `callWithSchema`는 성공하면 `{call, provider, model, fallback}` 메타(`LlmCallMeta`, `lib/ai/provider.ts`)를 알린다. 반환 타입은 그대로이고, 직접 호출은 `onMeta` 콜백으로 받는다. 진입 함수를 거치는 라우트는 `captureLlmMeta(fn)`(AsyncLocalStorage — 병렬 호출도 한 배열에 모인다)으로 모은다. 저장값은 `answeredModel(calls, 설정상 모델)`이다(중복 없이 `+`로 잇고, 답이 없으면 설정상 모델).
    - 배선한 곳: 토익 판독·모의고사·한 문제 연습·틀 판정, 영어 카드, 일본어 단어 생성·대화 전사·한자, 일본어 말하기 출제, 수학 설명(호출 B 메타만 — 라벨 필터는 라우트에 둔다), 자유대화 문장 설명(`onMeta`).
    - 판독과 저장이 다른 요청인 영어 단어장은 `plannedModel(resolveModel())`(계획의 메인이 Claude면 Claude 이름)을 쓴다.
    - OpenAI가 답하면 기존과 같이 요청한 모델 이름이고, Claude가 답하면 응답의 모델 이름(서버 측 폴백이면 대체 모델)이다.
    - 저장 스키마에 provider 칸은 더하지 않았다. 모델 이름이 공급자를 드러내고(`claude-`·`gpt-`), 레코드 정규화 함수 여러 곳을 넓히지 않기 위해서다.
    - 표현 도우미 결과의 `model`은 저장되지 않는 표시값이라 설정상 모델 그대로다.
  - **실호출 eval 게이트**(english 기본·math·`EVAL_TOEIC`·`EVAL_PHRASE`·`EVAL_MOM`, `EVAL_TALK`·`EVAL_TRANSCRIPT`는 english 게이트 뒤)는 `hasLlmKey()`(공급자 설정의 키)로 판정한다. 시작할 때 `describeProviderPlan()` 한 줄(메인·백업 공급자와 모델, 키 값 없음)을 찍는다.
  - **LLM 라우트의 키 없음(501) 문구**는 공급자 중립("AI API 키가 …", 로컬 안내는 `OPENAI_API_KEY 또는 ANTHROPIC_API_KEY`)으로 바꿨다. TTS·전사·사진·실시간 음성 문구는 "OpenAI API 키" 그대로다.

### Anthropic 켜기 체크리스트 (운영 — 사람·오케스트레이터 몫)

모든 gcloud 명령에 `--project eunwoo-bookcard`를 붙인다(로컬 기본 프로젝트가 다르다). 키 값은 어디에도 출력하거나 기록하지 않는다.

1. **비밀 등록**(값은 표준 입력으로만):
   ```bash
   printf '%s' "$ANTHROPIC_KEY_VALUE" | gcloud secrets create anthropic-api-key --data-file=- --replication-policy=automatic --project eunwoo-bookcard
   gcloud secrets add-iam-policy-binding anthropic-api-key --member="serviceAccount:273068330044-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --project eunwoo-bookcard
   ```
2. **서비스에 연결**(한 번이면 재배포 뒤에도 유지 — `.github/workflows/deploy.yml`의 `gcloud run deploy --source`는 env·secret을 건드리지 않으므로 워크플로는 고칠 것이 없다. CI 오프라인 eval 단계는 이미 `ANTHROPIC_API_KEY: ""`):
   ```bash
   gcloud run services update eunwoo-bookcard --region asia-northeast3 --project eunwoo-bookcard --update-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest
   ```
   이 시점은 `AI_PROVIDER`가 비어 있어 **OpenAI 메인 + Claude 백업**이다(OpenAI 장애 때만 Claude가 답한다).
3. **스키마 스모크**(사용자 동의 후, 로컬에서 키를 명시해 1회):
   ```bash
   SMOKE_ANTHROPIC=1 ANTHROPIC_API_KEY=<키> OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= APP_PIN= npx tsx scripts/smoke-anthropic-schemas.ts
   ```
   예상 비용(claude-opus-5-5 $4/MTok 입력·$20/MTok 출력): 스키마 39개 × 1요청에 입력 약 0.5~1.5k토큰(지시문 + 스키마), 출력 약 0.5~2k토큰(effort low thinking 포함)이다. 합계 입력 약 60k·출력 약 80k 토큰으로 **약 $2(넉넉히 잡아 $4 이하)**다. FAIL 스키마가 있으면 전환하지 않는다. 400(스키마 거부)은 백업으로 넘기지 않으므로 그 기능이 Anthropic 모드에서 통째로 깨진다.
4. **과목별 단계 검증**(로컬, 사용자 동의 후 — `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<키>`와 안전 접두(`STORE_BACKEND=file` 등)를 함께 준다). 각 리포트 첫 줄의 "실호출 공급자"가 `메인 anthropic(…)`인지 먼저 본다. 순서와 게이트:

   | 순서 | 과목 | 게이트 | 대략의 호출 수 |
   |---|---|---|---|
   | 1 | 엄마 | `EVAL_MOM=1 npm run eval:mom` | M1 1회 |
   | 2 | 표현 도우미 | `EVAL_PHRASE=1 npm run eval:phrase` | 모드 3개 × 1(되묻기 시 +1) |
   | 3 | 일본어 | 실호출 게이트가 아직 없다(`EVAL_JAPANESE`는 자리만) | dev 서버(`STORE_BACKEND=file`)에서 단어 생성·대화 전사·해설·한자·말하기 출제를 1회씩 손으로 확인 |
   | 4 | 토익 | `EVAL_TOEIC=1 npm run eval:toeic`(사진은 `EVAL_TOEIC_PHOTO`) | B·C·D 각 1(+ A 1) |
   | 5 | 영어 | `npm run eval:english`(기본 3회) → `EVAL_TALK=1`(2회) → `EVAL_TRANSCRIPT=1`(1회) | 3~6 |
   | 6 | 수학 | `npm run eval:math` | B·C 픽스처 8~16회 + 호출 E 1~2 |

   `AI_PROVIDER`는 **전역 스위치**다. 과목별 단계 적용은 위 순서로 로컬 검증을 쌓은 뒤 프로덕션을 한 번에 바꾸는 방식이다. 프로덕션에서 과목별로 따로 켜려면 호출부(과목 진입 함수)가 과목 env를 읽어 `provider`를 넘기는 배선이 필요한데, 아직 없다.
5. **전환**: `gcloud run services update eunwoo-bookcard --region asia-northeast3 --project eunwoo-bookcard --update-env-vars AI_PROVIDER=anthropic`(선택: `ANTHROPIC_MODEL`·`ANTHROPIC_MODEL_VERIFY`·`ANTHROPIC_TOEIC_MODEL`). 이때부터 OpenAI는 백업이다. 로그에서 `"provider":"anthropic"`, `fallback`의 빈도, `ms`(Opus 지연)를 지켜본다.
6. **되돌리기**: `--update-env-vars AI_PROVIDER=` 하나로 OpenAI 메인이 된다(키는 남겨 두면 Claude 백업). Claude를 완전히 끄려면 `--remove-secrets ANTHROPIC_API_KEY`.

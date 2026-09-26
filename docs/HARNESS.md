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

앱 전체 명세는 [`docs/SPEC.md`](./SPEC.md), 디자인 원본은 `design/`에 있습니다.

**하네스(이 문서의 `callWithSchema()` 규약) 밖에 있는 것 두 종류:**
- **LLM을 쓰지 않는 기능** — **아빠의 운동**(러시안 파이터 루틴, SPEC §19)은 규칙이 전부 결정적이라 순수 함수 엔진(`lib/workout.ts`)이 하고, 회귀 가드는 오프라인 `npm run eval:workout`입니다. **학습 스트릭**(SPEC §17, `eval:streak`)도 AI가 없습니다. 토익스피킹 안에서도 표현 시험 출제·모의고사 형식표·Q1–2 지문 대조·추정 총점은 LLM이 아닌 순수 함수입니다(`docs/harness/toeic.md` §5-4·§5-5·§6).
- **AI를 쓰지만 Structured Outputs 하네스 밖인 호출** — **클라우드 발음**(SPEC §16·§16-5, `lib/tts.ts`)은 OpenAI 유료 호출이지만 스키마 없는 오디오 호출이라 `callWithSchema()`·zod·재요청·토큰 로그를 거치지 않고, 키 규약(`OPENAI_API_KEY`, 없으면 501 → 기기 음성)만 공유합니다. 대화 해설 **낭독**(SPEC §18)은 일본어 해설 화면의 기능이고, 그 연속 재생 엔진(`speakQueue`)은 과목 공용이며 `eval:speech`가 잠급니다. 운동 세션의 음성 안내도 이 발음 경로를 거칩니다.
  토익스피킹의 **관문 P**(모의고사 Q3–4 사진 생성, `lib/toeic-image.ts`)와 **관문 T**(답변 음성 전사, `lib/toeic-transcribe.ts`)도 같은 부류입니다 — 이미지·오디오 바이트를 주고받는 호출이라 `callWithSchema()`·zod·재요청을 거치지 않고, 각자 **독립 OpenAI 클라이언트**를 쥐고(`lib/ai/client.ts`에 과목 분기를 넣지 않는다) 키 규약만 공유합니다(키가 없으면 네트워크 호출 없이 `no_api_key` → 라우트 501). 모델은 `OPENAI_IMAGE_MODEL`·`OPENAI_IMAGE_QUALITY`·`OPENAI_TRANSCRIBE_MODEL`(빈 값이면 기본값 — SPEC §11). 로그에는 모델·크기·ms 같은 숫자만 남기고 프롬프트·사진·전사문·오디오는 남기지 않습니다. 전사에는 기대 문장을 `prompt`로 넣지 않습니다(`docs/harness/toeic.md` §5-0).
  **사진 생성 공용 코어**(`lib/image-gen.ts`, 2026-09-26): 관문 P의 모델 env 해석·키 규약·JPEG data URL 조립·크기 상한을 넘으면 다음 압축으로 1회 다시 만들기·로그 모양을 코어로 옮겼고, 토익 사진(`lib/toeic-image.ts` — medium·1536×1024·압축 70→50)과 은우 자유대화 주제 일러스트(`lib/talk-image.ts` — low 고정·1024×1024·60→40)가 **자기 설정만 인자로 넘겨** 같은 코어를 씁니다. 코어는 과목을 모릅니다(`lib/ai/client.ts`에 과목 분기를 두지 않는 것과 같은 원칙). 토익 동작은 불변입니다(`eval:toeic`, QA가 HEAD 원본과 같은 스텁에서 요청·결과 동일을 확인).
  은우 자유대화의 **관문 R**(OpenAI Realtime — 음성 ↔ 음성 실시간 대화, `docs/harness/english.md` §12, SPEC §21)도 하네스 밖입니다. 브라우저가 OpenAI와 **WebRTC**로 직접 음성을 주고받고, 앱 서버는 연결(SDP 교환 — 통합 인터페이스 `POST /v1/realtime/calls`, `lib/talk-gateway.ts`)과 끊기(hangup)만 표준 키로 중계합니다 — 브라우저에는 키가 가지 않습니다. 모델 출력이 JSON이 아니라 음성·전사·도구 호출 이벤트라 `callWithSchema()`·zod·재요청·토큰 로그를 거치지 않고 **키 규약만 공유**합니다(키가 없으면 연결 라우트가 OpenAI를 부르지 않고 501). 대신 정확성 장치가 다른 자리에 있습니다: 선생님 지시문 원문은 spec-sync(`block-exact`)로, 세션 설정은 SDK GA 타입으로 tsc가, 이벤트 → 스크립트는 순수 리듀서(`lib/talk-transcript.ts`)가, 도구 호출 인자는 순수 검사 함수(`lib/talk-cards.ts` — 모델 출력을 믿지 않고 잘못된 항목만 버린다)가 잡습니다. 모델은 `OPENAI_REALTIME_MODEL`(기본 `gpt-realtime-2.1`)·`OPENAI_REALTIME_VOICE`(`marin`)·`OPENAI_REALTIME_TRANSCRIBE_MODEL`(`gpt-4o-mini-transcribe`), 빈 값이면 기본값(SPEC §11). 서버 로그에는 SDP·지시문·전사를 남기지 않고(상태·ms만), 은우 발화 전사에는 `language`·`prompt`를 주지 않습니다(관문 T와 같은 원칙 — 하지 않은 말이 맞게 적히는 위험). 대화가 끝난 뒤의 문장 설명(호출 I)은 하네스 **안**(`callWithSchema`)입니다.

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
- **과목별 분기를 이 파일에 넣지 않는다.** 분기가 필요하면 호출부에 둔다 —
  client를 고치면 모든 과목이 함께 영향받는다.

## 3. 파일 배치

```
lib/ai/client.ts          # 공통 래퍼 + OpenAI 클라이언트 — 과목 공유
lib/ai/english/           # 영어 전용 프롬프트·스키마
lib/ai/math/              # 수학 전용 프롬프트·스키마·검산 파이프라인
lib/ai/japanese/          # 일본어 전용 프롬프트·스키마
lib/ai/toeic/             # 토익스피킹 전용 프롬프트·스키마·후처리(호출 A~D)
lib/image-gen.ts          # 사진 생성 공용 코어(관문 P·자유대화 일러스트 공유) — 하네스 밖(서버 전용)
lib/toeic-image.ts        # 토익 관문 P(사진 생성) — 공용 코어에 토익 설정만 넘긴다(서버 전용)
lib/talk-image.ts         # 자유대화 주제 일러스트 — 공용 코어에 대화 설정만 넘긴다(서버 전용)
lib/toeic-transcribe.ts   # 토익 관문 T(음성 전사) — 하네스 밖(서버 전용)
lib/talk-session-config.ts # 자유대화 관문 R 세션 설정·지시문 조립(서버 전용, 네트워크 없음)
lib/talk-gateway.ts       # 자유대화 관문 R 네트워크(연결·hangup) — 하네스 밖(서버 전용)
scripts/eval-english.ts   # 영어 평가 하네스
scripts/eval-math.ts      # 수학 평가 하네스
scripts/eval-japanese.ts  # 일본어 평가 하네스
scripts/eval-toeic.ts     # 토익스피킹 평가 하네스
docs/harness/english.md   # 영어 스펙 (단일 진실 원천)
docs/harness/math.md      # 수학 스펙
docs/harness/japanese.md  # 일본어 스펙
docs/harness/toeic.md     # 토익스피킹 스펙
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
  오프라인 항목(`EVAL_OFFLINE_ONLY=1`)·일본어 eval(현재 오프라인 전용 — 실호출 게이트 `EVAL_JAPANESE`는 자리만)·
  `eval:speech`·`eval:workout`·`eval:streak`는 실호출이 없어 언제든 돌려도 된다.
  **토익스피킹 eval(`eval:toeic`)은 기본이 오프라인**(무비용 — zod 반례·후처리·시험 출제·형식표·Q1–2 대조·추정 총점·스트릭 트랙 분리·
  spec-sync 바이트 대조와 JSON Schema 8개 의미 동치)이라 언제든 돌려도 된다. 실호출은 **`EVAL_TOEIC=1`일 때만** 호출 A(사진 경로
  `EVAL_TOEIC_PHOTO`가 있을 때만)·B(표현 7개)·C(파트 하나, `EVAL_TOEIC_PART` 기본 opinion)·D(픽스처 전사문 하나)를 한 번씩 부르고,
  `EVAL_OFFLINE_ONLY=1`이면 게이트를 켜도 건너뛴다(네트워크 자체를 막는 2차 방어선). 관문 P·T는 실호출 점검 대상이 아니다 —
  오프라인에서 env 빈 값 폴백·키 없음(`no_api_key`)·전사 `prompt` 부재 같은 계약을 잠근다. 자유대화 관문 R도 같다 — `eval:english`
  오프라인이 지시문 spec-sync·세션 설정(env 빈 값 폴백·도구·전사에 `language`·`prompt` 없음)·리듀서·도구 호출 검사·도움 상태 기계를
  잠그고, 실제 연결(WebRTC·음성)은 eval 밖이다(개발 빌드 전용 가짜 전송 e2e + 사용자 동의 후 실기기). 호출 I는 영어 게이트 `EVAL_TALK=1`(2회). 교재 가져오기 파일 검증은 `data/private/`에 파일이 있을 때만 돌고
  없으면 SKIP이다(공개 저장소·CI 기준). 게이트 실호출도 비용이 드는 검증이라 **사용자 동의 후 오케스트레이터가** 실행한다.

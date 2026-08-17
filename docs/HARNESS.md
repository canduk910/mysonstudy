# AI 하네스 공통 규약 — 은우학습

**은우학습 프로젝트 · 과목 공통 문서**

> **하네스란?** LLM 호출을 감싸는 뼈대입니다 — 프롬프트, 출력 스키마, 검증, 재시도, 로깅을 한 세트로 묶은 것.
> 말과 마차를 잇는 마구(harness)처럼, 모델의 힘이 정확한 방향으로만 나가게 잡아주는 장치예요.

이 저장소는 과목 둘을 기릅니다 — **영어(북카드)** 와 **수학(수학코치)**. 두 과목은 프롬프트도 스키마도
다르지만 **호출을 감싸는 방식은 같습니다.** 이 문서는 그 공통분모만 담습니다. 프롬프트 원문·출력
스키마·평가 항목처럼 과목마다 갈리는 것은 전부 과목별 문서에 있습니다.


> **절 번호 표기 규칙.** 코드 주석·리포트에 `HARNESS §N`처럼 문서명 없이 적힌 참조는
> **그 코드가 속한 과목의 스펙**을 가리킨다 — `lib/ai/english/`·`app/api/` 영어 경로면
> `docs/harness/english.md`, 수학 경로면 `docs/harness/math.md`다. 이 공통 문서를 가리킬
> 때는 반드시 `docs/HARNESS.md §N`처럼 파일명을 함께 적는다. 과목 분리(2026-08-17) 이전에
> 쓰인 참조가 40곳 이상이라 관례를 유지하는 쪽을 택했다.

## 0. 과목별 문서

| 과목 | 스펙 | 프롬프트·스키마 | eval | npm 스크립트 |
|---|---|---|---|---|
| **영어 (북카드)** | [`docs/harness/english.md`](./harness/english.md) | `lib/ai/english/` | `scripts/eval-english.ts` | `npm run eval:english` |
| **수학 (수학코치)** | `docs/harness/math.md` | `lib/ai/math/` *(구현 중)* | `scripts/eval-math.ts` *(구현 중)* | `eval:math` *(구현 중)* |

앱 전체 명세는 [`docs/SPEC.md`](./SPEC.md), 디자인 원본은 `design/`에 있습니다.

**작업할 때는 해당 과목의 문서만 읽으세요.** 둘 다 읽으면 컨텍스트만 늘고 프롬프트가 섞입니다.

## 1. 공통 규약

두 과목의 모든 AI 호출이 예외 없이 지키는 규칙입니다.

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

`lib/ai/client.ts`에 있는 **과목 공유** 모듈입니다. 두 과목이 같은 래퍼를 지나갑니다.

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
  client를 고치면 두 과목이 함께 영향받는다.

## 3. 파일 배치

```
lib/ai/client.ts          # 공통 래퍼 + OpenAI 클라이언트 — 과목 공유
lib/ai/english/           # 영어 전용 프롬프트·스키마
lib/ai/math/              # 수학 전용 프롬프트·스키마 (예정)
scripts/eval-english.ts   # 영어 평가 하네스
scripts/eval-math.ts      # 수학 평가 하네스 (예정)
docs/harness/english.md   # 영어 스펙 (단일 진실 원천)
docs/harness/math.md      # 수학 스펙
```

## 4. 운영 규칙

- **프롬프트 원문과 JSON Schema는 스펙 문서에서 원문 그대로 옮긴다.** 요약·재해석·"개선" 금지.
  개수·비율 다이얼이 프롬프트 문장 안에 박혀 있고 eval이 그 숫자에 걸려 있어서, 문구 하나가
  품질과 eval 통과 여부를 좌우한다.
- **같은 제약이 여러 곳에 중복 정의된다** — 프롬프트 문구 · JSON Schema · zod · eval 점검.
  한 곳만 고치면 "eval은 통과하는데 런타임 검증이 실패"하거나 그 반대가 된다. 다이얼을 바꿀
  때는 정의된 모든 위치를 함께 맞춘다.
- **프롬프트 수정 → 해당 과목 eval 실행 → 통과 확인 → 커밋.** 이 순서를 지킨다.
  eval은 실제 OpenAI 호출이 발생하므로 CI가 아니라 수동 실행이고, 비용 승인 없이 반복하지 않는다.

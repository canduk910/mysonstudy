---
name: ai-harness-impl
description: "ai-engineer·app-builder 에이전트가 구현 작업을 수행할 때 로드하는 스킬(과목 공통). lib/ai/client.ts(공유 래퍼) 작성 규칙, OpenAI Responses API + Structured Outputs 호출, callWithSchema 래퍼, zod 이중 검증, 라우트 연결 지침을 담는다. 과목별 프롬프트·스키마는 lib/ai/{english,math}/에 두고 스펙은 docs/harness/{english,math}.md를 따른다. 사용자의 구현·수정 요청 진입점은 study-orchestrator 스킬이다."
---

# AI Harness Impl — 스펙 기반 구현 가이드

AI 호출은 해당 과목 스펙(`docs/harness/english.md` · `docs/harness/math.md`)과 **과목 공통 규약 `docs/HARNESS.md`**, 앱 전체는 `docs/SPEC.md`가 진실 원천이다. 공유 래퍼(`lib/ai/client.ts`)를 만질 때는 공통 규약을 먼저 읽는다. 구현 전 반드시 둘 다 읽는다. 이 스킬은 스펙을 재서술하지 않는다 — 스펙이 그대로 코드가 되게 하는 실무 규칙과, 스펙이 말하지 않는 SDK 세부만 담는다.

## 과목 라우팅 — 먼저 읽을 것

이 저장소는 과목 둘을 기른다. **작업 과목의 스펙만** 정독한다(둘 다 읽으면 컨텍스트만 늘고 프롬프트가 섞인다).

| 과목 | 스펙 | 프롬프트·스키마 | eval |
|---|---|---|---|
| 영어 (북카드) | `docs/harness/english.md` | `lib/ai/english/` | `scripts/eval-english.ts` |
| 수학 (수학코치) | `docs/harness/math.md` | `lib/ai/math/` | `scripts/eval-math.ts` |

`lib/ai/client.ts`는 **과목 공유**다. 여기를 고치면 두 과목이 함께 영향받으므로, 과목별 분기는 client가 아니라 호출부에 둔다.

수학에는 이 스킬이 다루지 않는 영역이 둘 있다 — **호출 C·검산 파이프라인은 math-verifier(`math-pipeline` 스킬)**, **호출 E·플레이어 키트는 player-builder(`player-kit` 스킬)** 소관이다. 그쪽 파일을 건드리지 말고 필요하면 오케스트레이터에게 위임을 요청하라.

## 절대 규칙

- 프롬프트(§2-1, §3-1)와 JSON Schema(§2-3, §3-3)는 **원문 그대로** 상수로 옮긴다. 문구를 다듬거나 요약하지 않는다. 이유: 개수·비율 다이얼이 문장 안에 있고, eval이 그 숫자에 걸려 있다. 원문과 다르면 QA에서 문자 단위 diff로 걸린다.
- 배열 개수 제약을 JSON Schema에 넣지 않는다 (`minItems`/`maxItems` 금지) — 프롬프트 + zod가 담당한다. strict 모드의 지원 여부가 모델·버전마다 다르기 때문 (스펙 §1 공통 규칙).
- strict 모드 필수 조건: 모든 필드 `required` + 모든 객체에 `additionalProperties: false`. "선택" 필드는 null 유니온(`["string", "null"]`)으로 표현한다.
- 모델 ID는 `process.env.OPENAI_MODEL`, 키는 `process.env.OPENAI_API_KEY`. 호출 코드는 서버 전용 — 클라이언트 번들에 들어갈 파일에서 lib/ai/client.ts를 import하지 않는다.

## Responses API 호출 형태

스펙 §4의 `response_format` 표기는 의도 서술이다. Responses API에서는 `text.format`으로 전달한다:

```ts
const res = await openai.responses.create({
  model: process.env.OPENAI_MODEL!,
  input: [
    { role: "system", content: [{ type: "input_text", text: system }] },
    { role: "user", content: userParts }, // input_text | input_image 혼합 배열
  ],
  text: { format: { type: "json_schema", name, strict: true, schema } },
  temperature,
  max_output_tokens: maxOutputTokens,
});
const raw = res.output_text; // SDK 편의 getter
// 토큰: res.usage?.input_tokens, res.usage?.output_tokens
```

- 이미지 파트: `{ type: "input_image", image_url: dataUrl, detail: "high" }` (base64 data URL). 스티커의 작은 글씨(AR·Lexile)를 읽어야 하므로 detail은 high. 업로드 전 긴 변 ~1500px 리사이즈를 권장 — 판독 품질을 유지하면서 토큰을 아낀다.
- `res.status === "incomplete"`(출력 한도 도달)는 JSON 파싱 실패와 동일하게 재요청 1회 경로로 보낸다.

## callWithSchema 골격

스펙 §4 그대로: 호출 → `JSON.parse` → `zodSchema.safeParse` → 실패 시 1회 재요청 → 재실패 throw → 성공/실패 무관 로깅.

- 재요청 구성: 원래 `input` 뒤에 assistant 턴(이전 출력 원문)과 user 턴(`"다음 검증 오류를 고쳐 다시 출력해: {오류 요약}"`)을 덧붙여 다시 호출한다. 오류 요약은 zod error의 path + message만 뽑아 짧게.
- 로깅은 `finally`에서: `console.log(JSON.stringify({ call, model, inputTokens, outputTokens, ms }))`. 재요청이 발생하면 두 호출의 토큰을 합산해 기록한다.

## zod 스키마 작성

- JSON Schema와 별개로 zod를 손으로 작성하되, 필드·타입이 1:1 대응하는지 스스로 대조한다 (자동 변환 라이브러리로 JSON Schema를 생성하지 않는다 — 스펙의 스키마 원문이 기준).
- 스펙 §4의 추가 검증(개수·중복·금지어·isCore 1개·픽션/논픽션 분기)은 `.superRefine()`으로 구현한다.
- 카드 검증은 AR 값과 픽션 여부에 의존하므로, 카드 zod 스키마는 `makeLearningCardSchema(meta: { arLevel: number | null; isFiction: boolean })` 같은 팩토리로 만든다.
- **사이트워드 차단 목록(§5)은 english/schemas.ts에서 상수로 export하고, zod 검증과 eval-english.ts가 같은 상수를 import한다.** 목록이 두 곳에 살면 반드시 어긋난다 — QA가 별도 정의를 실패로 판정한다.

## 라우트 연결 (app-builder용)

- `/api/extract`: 이미지 수신 → `callWithSchema('extract')` → `isBookCover=false` 또는 `title=null`이면 **200 + `{ ok: false, reason: "retake" }`** 류의 명시적 폴백 신호를 반환한다 (클라이언트: "다시 찍어주세요" + 수동 입력 폼, §2-4). 판독 실패는 정상 흐름이다. 500은 재시도 소진 throw에만 쓴다 (클라이언트: 재시도 버튼).
- 식별 단계: 판독된 title(+author)로 Google Books `https://www.googleapis.com/books/v1/volumes?q=intitle:"{title}"+inauthor:"{author}"` 검색(`GOOGLE_BOOKS_API_KEY` 있으면 `key` 파라미터 추가), 최상위 결과에서 ISBN·`volumeInfo.description`·카테고리·썸네일 URL을 확보한다. 실패 시 Open Library `https://openlibrary.org/search.json?title=…&author=…` 폴백, 둘 다 실패하면 판독값만으로 진행(커버는 이모지) — 카드 생성을 막지 않는다 (docs/SPEC.md §3·§9). description은 카드 생성 입력의 `googleBooksDescription`으로 쓴다.
- `/api/card`: 메타데이터 수신 → §3-2 템플릿 그대로 user 메시지 조립(널 폴백 문구 포함) → `callWithSchema('card')`.
- 응답 shape은 빌드 리포트에 명시한다 — qa-inspector가 프론트 기대 타입과 교차 검증한다.

## eval-english.ts 픽스처

픽스처 2권(Wolves, Pooh Gets Stuck)의 값은 `docs/SPEC.md` §12를 그대로 사용한다 (`.claude/skills/prompt-eval/SKILL.md`의 픽스처 표와 동일). 임의 값으로 만들면 bookcard-qa가 "픽스처가 §12 정의와 불일치"로 실패 판정한다.

## 완료 기준

- [ ] `tsc` 통과 (strict)
- [ ] study-qa 스킬의 정합성 매트릭스 + 스펙 준수 체크리스트 통과
- [ ] `package.json`에 `"eval:english": "tsx scripts/eval-english.ts"` 등록
- [ ] 임의 판단(스펙 공백)이 전부 빌드 리포트에 목록화됨

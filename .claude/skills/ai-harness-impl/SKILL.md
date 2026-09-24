---
name: ai-harness-impl
description: "ai-engineer·app-builder 에이전트가 구현 작업을 수행할 때 로드하는 스킬(과목 공통 — 영어·수학·일본어 + 앱 공통 기능). lib/ai/client.ts(공유 래퍼) 작성 규칙, OpenAI Responses API + Structured Outputs 호출, callWithSchema 래퍼, zod 이중 검증, 라우트 상태코드·계약 파일(lib/*-contract.ts) 연결 규약, 로컬 실행 안전 명령을 담는다. 과목별 상세는 references/english-routes.md(영어 호출 A~H·라우트 전체)·japanese.md(일본어 호출 A~D·후리가나·저장), AI가 없는 기능(아빠의 운동)과 과목 공통 기능(클라우드 발음·학습 스트릭·해설 낭독·순서변경)은 references/app-patterns.md, 수학은 본문에 있다. 스펙은 docs/harness/{english,math,japanese}.md와 docs/SPEC.md를 따른다. 사용자의 구현·수정 요청 진입점은 study-orchestrator 스킬이다."
---

# AI Harness Impl — 스펙 기반 구현 가이드

AI 호출은 해당 과목 스펙(`docs/harness/english.md` · `math.md` · `japanese.md`)과 **과목 공통 규약 `docs/HARNESS.md`**, 앱 동작은 `docs/SPEC.md`가 진실 원천이다. 이 스킬은 스펙을 재서술하지 않는다 — 스펙이 그대로 코드가 되게 하는 실무 규칙과, 스펙이 말하지 않는 SDK·저장소 세부만 담는다. 공유 래퍼(`lib/ai/client.ts`)를 만질 때는 `docs/HARNESS.md`를 먼저 읽는다.

## 과목 라우팅 — 먼저 읽을 것

이 저장소는 AI 과목 셋과, AI가 없거나 하네스 밖인 공통 기능을 함께 기른다. **작업 대상의 줄만** 따라간다. 여러 과목을 함께 읽으면 컨텍스트만 늘고 프롬프트 문구·관용구가 섞인다.

| 대상 | 스펙 | 프롬프트·스키마 | 진입 함수가 사는 곳 | eval (npm) | 이 스킬에서 읽을 것 |
|---|---|---|---|---|---|
| 영어 (북카드·단어장·챕터 리더) | `docs/harness/english.md` — 호출 A·A′·B·C·D·F·G·H (E는 없다) | `lib/ai/english/` | `lib/ai/client.ts` (`extractBook`·`digestPages`·`generateCard`·`enrichVocab`·`chapterizeTranscript`·`lookupWordMeaning`·`suggestRelatedWords`). 호출 C만 라우트가 `callWithSchema`를 직접 부른다 | `scripts/eval-english.ts` (`eval:english`) | `references/english-routes.md` |
| 수학 (수학코치) | `docs/harness/math.md` | `lib/ai/math/` | `lib/ai/math/extract.ts`·`pipeline.ts`·`player.ts` (client.ts에 수학 진입 함수는 없다) | `scripts/eval-math.ts` (`eval:math`) | 이 본문 "수학" 절 |
| 일본어 (아빠의 일본어) | `docs/harness/japanese.md` — 호출 A·B·C·D | `lib/ai/japanese/` | `lib/ai/client.ts` (`generateJapaneseVocab`·`extractJaDialog`·`coachJaDialog`·`generateKanjiInfo`) | `scripts/eval-japanese.ts` (`eval:japanese`) | `references/japanese.md` |
| 앱 공통 기능·운동 | `docs/SPEC.md` §15(순서변경·읽기 속도)·§16(클라우드 발음)·§17(학습 스트릭)·§18(해설 낭독)·§19(아빠의 운동) | — (운동·스트릭은 AI 없음, 발음은 스키마 없는 오디오 호출) | `lib/speech.ts`·`lib/tts.ts`·`lib/streak.ts`·`lib/ja-coaching-script.ts`·`lib/workout.ts` | `eval:speech`·`eval:streak`·`eval:workout` (전부 실호출 0) | `references/app-patterns.md` |

`lib/ai/client.ts`는 **과목 공유**다. 여기를 고치면 세 과목이 함께 영향받으므로, 과목별 차이는 client가 아니라 호출부에서 파라미터(`system`·`jsonSchema`·`zodSchema`·`temperature`·`model`)로 넘긴다. `callWithSchema`의 `call` 인자는 로그 라벨일 뿐 분기 근거가 아니다 — `if (call === "…")` 같은 분기를 만드는 순간 공유 래퍼가 과목을 아는 물건이 된다(`CallWithSchemaArgs.call` 주석). 영어·일본어 진입 함수가 client.ts에 얇게 export돼 있는 것은 라우트와 eval이 같은 배선을 공유하려는 것이지 분기를 허락하는 것이 아니다.

`lib/tts.ts`(클라우드 발음)는 OpenAI를 부르지만 스키마 없는 오디오 호출이라 `callWithSchema()`·zod·재요청·토큰 로그를 지나지 않는다(`docs/HARNESS.md` §0). 두 관문을 합치지 마라 — 성격이 달라 한쪽 규칙이 다른 쪽을 오염시킨다.

## 절대 규칙

- 프롬프트와 JSON Schema는 스펙의 **원문 그대로** 상수로 옮긴다. 문구를 다듬거나 요약하지 않는다. 이유: 개수·비율 다이얼이 문장 안에 있고, eval과 spec-sync가 그 문자열에 걸려 있다. 다만 **자동 대조가 덮는 범위는 과목마다 다르다.** 어디까지가 사람 몫인지 알고 고쳐야 "eval 통과"를 "스펙과 일치"로 오해하지 않는다.
  - **시스템 프롬프트와 고정 사용자 텍스트**는 세 과목 모두 각 eval의 오프라인 구간이 `scripts/spec-sync.ts`로 스펙 코드블록과 바이트 대조한다(각 eval의 `SPEC_SYNC_TARGETS`). **새 프롬프트 상수를 만들면 그 과목 eval의 `SPEC_SYNC_TARGETS`에 등록해야 끝이다**(`scripts/eval-english.ts`·`eval-math.ts`·`eval-japanese.ts`).
  - **JSON Schema를 스펙과 대조하는 것은 일본어뿐이다.** `eval-japanese.ts`의 `runJsonSchemaSyncChecks`가 스펙의 스키마 코드블록 4개를 파싱해 의미 동치로 본다. 영어·수학 eval은 JSON Schema를 스펙과 대조하지 않는다. 영어는 `WORD_MEANING_JSON_SCHEMA`·`RELATED_SUGGESTION_JSON_SCHEMA`의 strict 모양만 스스로 점검하고, 수학 eval에는 스키마 점검이 없다.
  - **값을 보간하는 사용자 메시지 빌더는 spec-sync 대상이 아니다.** 영어 `buildPagesUserMessage`·`buildCardUserMessage`·`buildChapterizeUserMessage`·`buildWordMeaningUserMessage`·`buildRelatedSuggestUserMessage`, 수학 `buildExplainUserMessage`·`buildVerifyUserMessage`·`buildPracticeUserMessage`·`buildPlayerHtmlUserMessage`, 일본어 `buildJaKanjiUserMessage`·`buildJaDialogCoachUserMessage`가 여기 든다(일본어 `buildJaVocabUserMessage`는 템플릿 `JA_VOCAB_USER_TEMPLATE`이 대조되고 치환도 eval이 본다).
  - 그래서 **영어·수학 JSON Schema나 등록되지 않은 사용자 메시지 템플릿을 고쳤으면 스펙과 눈으로 diff하고 그 결과를 빌드 리포트에 적는다.** 이 부분의 드리프트는 eval이 통과해도 잡히지 않는다.
- 레퍼런스·리포트에 스펙의 프롬프트 원문을 복사하지 않는다. 원문은 스펙 한 곳에만 살고, 다른 곳에는 §번호 포인터만 둔다.
- 배열 개수 제약을 JSON Schema에 넣지 않는다(`minItems`/`maxItems` 금지) — 프롬프트 + zod가 담당한다. strict 모드의 지원 여부가 모델·버전마다 달라 조용히 무시되거나 호출이 거부된다(`docs/HARNESS.md` §1).
- strict 모드 필수 조건: 모든 필드 `required` + 모든 객체에 `additionalProperties: false`. "선택" 필드는 빼지 말고 null 유니온(`["string", "null"]`)으로 표현한다. 저장 레코드도 같은 이유로 선택 키(`?`)를 두지 않고 필수 nullable로 둔다(Firestore가 `undefined`를 거부한다).
- 모델은 `resolveModel()`(수학 검산은 `resolveVerifyModel()`)로만 고른다 — env `OPENAI_MODEL`을 읽고 비면 `DEFAULT_OPENAI_MODEL`로 떨어진다. 호출부에 모델 문자열을 적지 않는다. 키는 `process.env.OPENAI_API_KEY`.
- 호출 코드는 서버 전용이다. 클라이언트 번들에 들어갈 파일에서 `lib/ai/client.ts`를 import하지 않는다. 화면이 타입을 필요로 하면 `lib/*-contract.ts`가 `export type`으로 재수출한다(아래 "라우트 연결 공통 규약").

## Responses API 호출 형태

스펙의 `response_format` 표기는 의도 서술이다. Responses API에서는 `text.format`으로 전달한다(`callWithSchema` 안의 `requestOnce`):

```ts
const res = await openai.responses.create({
  model,
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

- 이미지 파트는 `imagePart(dataUrl)`(`{ type: "input_image", image_url, detail: "high" }`)을 쓴다. 작은 글씨(AR·Lexile 스티커, 교재 번호, 후리가나)를 읽어야 해서 detail은 high다. 이미지는 **텍스트 파트보다 먼저** 넣는다(영어 §2A 관용구 — 일본어 호출 B도 따른다).
- 업로드 전 리사이즈는 클라이언트가 한다 — 긴 변 `MAX_IMAGE_EDGE`(1500px), JPEG `JPEG_QUALITY`(0.85), 한 장 길이 상한 `MAX_IMAGE_DATA_URL_CHARS`, 형식 `IMAGE_DATA_URL_PATTERN`이 전부 `lib/upload-limits.ts` 한 곳에 산다. 라우트는 숫자를 다시 적지 말고 import한다.
- `res.status === "incomplete"`(출력 한도 도달)는 JSON 파싱 실패와 같은 재요청 경로로 보낸다(`validateResponse`).
- 추론 계열 모델은 `temperature` 파라미터를 400으로 거부한다. `callWithSchema`는 이 오류를 한 번 받으면 파라미터를 빼고 재호출하고, 그 모델을 `modelsRejectingTemperature`에 기억해 다음부터 처음부터 뺀다. 스펙의 temperature 다이얼이 그 모델에는 적용 불가라서 빼는 것이 스펙 의도를 지키는 최소 변형이다 — 호출부에서 따로 처리하지 마라.

## callWithSchema 골격

`docs/HARNESS.md` §2 그대로: 호출 → `JSON.parse` → `zodSchema.safeParse` → 실패 시 1회 재요청 → 재실패 throw → 성공/실패 무관 로깅.

- 재요청은 원래 `input` 뒤에 assistant 턴(이전 출력 원문)과 user 턴(`다음 검증 오류를 고쳐 다시 출력해: {오류 요약}`)을 덧붙여 다시 호출한다. 오류 요약은 zod issue의 path + message를 최대 8개만 짧게(`summarizeZodError`).
- 로깅은 `finally`에서 `{ call, model, inputTokens, outputTokens, ms }` 한 줄. 재요청이 나면 두 호출의 토큰을 합산한다. `model`은 실제로 쓴 모델이다 — 검산만 다른 모델로 돌릴 때 비용을 호출 단위로 가르기 위해서다.
- 재실패 throw는 라우트가 받아 상태코드로 바꾼다. 래퍼 안에서 삼키지 않는다.

## zod 스키마 작성

- JSON Schema와 별개로 zod를 손으로 작성하되, 필드·타입이 1:1 대응하는지 스스로 대조한다. 자동 변환 라이브러리로 JSON Schema를 생성하지 않는다 — 스펙의 스키마 원문이 기준이다(일본어 eval은 스펙의 JSON Schema 코드블록을 파싱해 코드 상수와 의미 동치로 대조한다).
- 스펙의 "zod 추가 검증"(개수·중복·금지어·상호 의존·토큰 무결성)은 `.superRefine()`으로 구현한다. 생산 시점(`callWithSchema`)에 걸어야 1회 재요청이 그 자리에서 교정한다.
- 입력에 따라 규칙이 갈리면 스키마를 팩토리로 만든다: `makeLearningCardSchema(meta)`(AR·픽션 여부·허용 storySource), `makePageDigestSchema(meta)`, `makeChapterizationSchema(meta)`(목차 제목), 수학 `makeExplanationSchema(meta)`.
- **같은 제약 값은 한 곳에서 export하고 zod·eval·라우트가 import한다.** 예: 영어 사이트워드 차단 목록 `SIGHT_WORD_SET`(`lib/ai/english/schemas.ts`), 장면 메모 상한 `SCENE_*_MAX`(`/api/pages`가 내준 것을 `/api/card`가 거부하는 구멍이 상한 이중 정의로 실제로 났다 — QA F12), 수학 `STEP_SAY_MAX_CHARS`, 일본어 `JA_*` 상수(`lib/ai/japanese/schemas.ts`). 두 곳에 사는 목록은 반드시 언젠가 어긋나고, QA는 값이 지금 같아도 별도 정의를 실패로 판정한다.
- **숫자는 가능하면 계산해 프롬프트에 주입한다.** 영어 줄거리 분량(`storyOutlineSentenceRange`)과 일본어 개수(`buildJaVocabUserMessage`의 `count`)가 이 방식이다 — 프롬프트와 eval이 같은 함수를 보면 손으로 맞추던 드리프트가 사라진다.

## 프롬프트 밖의 정확성 장치 — 코드로 강제한다

프롬프트 지시로 끝내지 않은 가드가 과목마다 있다. 프롬프트를 고치다 이 가드를 느슨하게 만들면 틀린 결과가 에러 없이 통과한다.

- 영어: `groundChapters()`(자막에 없는 문장 잘라내기), `resolveAllowedStorySource()`(실제로 넘긴 근거보다 높은 storySource 거부), `mergeEnrichment()`(이미 채운 정의는 어떤 재생성도 덮어쓰지 않음). → `references/english-routes.md`
- 수학: 호출 C 독립 검산·`verifyScene`·`held` 판정. math-verifier 소관이다.
- 일본어: 토큰 무결성 zod(토큰을 이어 붙이면 원문과 같다), `applyVocabPostprocess()`(제외 재적용·레벨 태깅), `applyKanjiPostprocess()`(요청 밖 한자 버리기). → `references/japanese.md`

## 라우트 연결 공통 규약 (app-builder)

과목별 라우트 표는 레퍼런스에 있다. 여기는 모든 AI 라우트가 공유하는 모양이다.

- **키 검사는 AI 호출 앞에서 한다.** `if (!process.env.OPENAI_API_KEY)` → **501** `{ ok:false, error:"no_api_key", messageKo }`. 로컬에서 키를 비우면 실호출이 구조적으로 불가능해지는 것이 이 줄 덕분이다. AI가 필요 없는 라우트(저장·rename·reorder·시험 세션 저장)에는 키 검사를 두지 않는다 — 키가 없어도 저장은 되어야 한다.
- **판독 실패는 정상 흐름이다.** 사진이 대상이 아니거나 읽을 것이 없으면 **200** `{ ok:false, reason:"retake", messageKo }`(영어 표지 `isBookCover=false`/`title=null`, 영어 단어장 0단어, 수학 `isWorksheet=false`). 500은 재요청까지 소진한 throw에만 쓴다 — 둘을 같은 코드로 내리면 "사진이 틀림"과 "AI가 죽음"이 화면에서 구분되지 않는다.
- 나머지 관용구: **400** `invalid_input`(+ `issues: {path,message}[]`), **404** `not_found`·`*_not_found`, **500** `ai_failed` 또는 `*_failed`(재시도 가치가 있다는 뜻 — 판독·생성 라우트인 영어 `/api/extract`·`/api/pages`·`/api/card`·`/api/chapterize`·단어장 `/extract`·`/enrich`와 수학 `/extract`·`/explain`은 `retriable:true`를 함께 싣고, 일본어·뜻 조회·추천 라우트는 싣지 않는다), **403** `prod_guard`(개발 환경에서 실데이터 삭제 차단 — `isProdGuardError`로 판별). PIN 게이트는 `proxy.ts`가 `/api/*` 앞에서(예외는 `/api/unlock`) **401** `locked` / **503** `not_configured`로 처리하므로 라우트에 인증 코드를 두지 않는다.
- **여러 장·여러 레벨은 병렬 + 부분 실패 격리.** `Promise.allSettled`로 나눠 부르고, 한 배치가 실패해도 나머지를 살려 200으로 내린다(`failedBatchCount`·`failedPhotoCount`·`partial`·`perLevel[].failed`로 사실대로 알린다). **전부 실패일 때만 500.**
- **부수 효과는 best-effort.** 본체(전사·단어·설명)가 성공했는데 부수 효과(해설·보강·저장 기록)가 실패하면 본체를 살린다 — 일본어 해설 `coaching:null`, 영어 단어 담기의 `enrichSkipped`, 수학 설명 자동 저장 실패 시 `id:null`.
- **응답 shape은 `lib/*-contract.ts`가 단일 정의처다.** 라우트는 응답 헬퍼의 인자 타입으로 그 타입을 걸고(예: `/api/english/vocab/extract`의 `function json(body: VocabExtractResponse, status)`), 화면은 같은 타입으로 받는다. 계약 파일은 클라이언트가 import하므로, 새 계약 파일은 `lib/ai/*`에서 `import type`/`export type`만 한다 — 값을 import하면 zod 등 런타임이 번들에 샌다(`lib/vocab-create-contract.ts`가 상한 상수를 값으로 끌어오는 선례가 있지만 따라 하지 않는다). 영어 북카드 초기 라우트(`/api/extract`·`/api/pages`·`/api/card` 등)는 계약 파일 없이 **라우트 머리 주석**이 shape 정의처다.
- 사진은 요청 메모리에서만 쓰고 저장·로깅하지 않는다(SPEC §1·§5). 남는 것은 텍스트뿐이다.
- 응답 shape(상태코드별)은 빌드 리포트에 적는다 — qa-inspector가 프론트 기대 타입과 교차 검증한다.

라우트 골격의 세부(요청 계약 ↔ zod 양방향 타입 묶기, 409 규약, 시각을 한 번만 읽기)와 저장소 이원화·원자적 쓰기·prod-guard·PIN 게이트는 `references/app-patterns.md` §2~§7에 있다.

## 수학 — 이 본문이 레퍼런스다

수학은 호출 C·검산 파이프라인이 **math-verifier(`math-pipeline` 스킬)**, 호출 E·플레이어 키트가 **player-builder(`player-kit` 스킬)** 소관이다. 그쪽 파일(`lib/ai/math/pipeline.ts`의 검산 흐름, `lib/scene/`, `lib/ai/math/player.ts`, `public/player-kit/`)을 건드리지 말고 필요하면 오케스트레이터에게 위임을 요청하라.

| 라우트 | 진입 함수 | 계약 | 비고 |
|---|---|---|---|
| `POST /api/math/extract` | `callWorksheetExtract`(`lib/ai/math/extract.ts`, 호출 A) | `lib/math-extract-contract.ts` | 사진 1장. `isWorksheet=false`·빈 `problems`는 200 retake |
| `POST /api/math/explain` | `explainProblem`(`pipeline.ts`) + 2단 렌더러 `renderSceneHtml`(`player.ts`) 주입 | `lib/math-explain-contract.ts` | 성공 직후 `explanations`에 best-effort 자동 저장. `held`도 저장한다 |
| `DELETE /api/math/explanations/[id]` | — | 라우트 머리 주석 | 연쇄 삭제 없음, prod-guard |
| `POST /api/math/reorder` | — | `lib/reorder-contract.ts` | 공통 순서변경 |

- **라우트에서 답을 손보거나 `held`를 뒤집지 않는다.** 검산 두 겹이 하는 일이 없어진다. `held`면 2단 그림도 만들지 않는다(파이프라인이 막는다).
- **비용**: 판독(`/extract`)은 판독만 한다. 문제 1개 설명이 호출 2~4회(B·C, 재시도 시 ×2)이고 2단 그림이면 호출 E가 1~2회(`SCENE_HTML_MAX_ATTEMPTS`) 더 붙는다(math.md §7 비용 줄·§8 운영 메모). 그래서 페이지 전체를 자동으로 설명까지 만드는 경로를 만들지 않는다 — 사용자가 확인 화면에서 고른 문제만 `/explain`이 한 건씩 처리한다.
- 렌더 판정은 `lib/math-record.ts`의 `isRenderableExplanation`, 저장 레코드 → 화면 응답 변환은 `toExplainSuccess`가 단일 정의처다.
- 호출 D(연습문제)는 프롬프트·스키마(`PRACTICE_SYSTEM_PROMPT`·`PRACTICE_JSON_SCHEMA`)와 spec-sync 대상만 있고 이를 부르는 라우트는 아직 없다. 배선하려면 스펙 확인부터 한다.

## 완료 기준

- [ ] `npm run typecheck`(`tsc --noEmit`, strict) 통과
- [ ] **작업 과목의 eval 오프라인 구간 통과** — `EVAL_OFFLINE_ONLY=1 npm run eval:{english|math|japanese}`(아래 안전 접두어와 함께). 공통 기능이면 `eval:speech`·`eval:streak`·`eval:workout`. 실호출 구간은 오케스트레이터가 사용자 동의 후 돌린다 — 에이전트는 돌리지 않는다
- [ ] 여러 과목이 공유하는 코드(`lib/ai/client.ts`, `lib/vocab-quiz.ts`·`vocab-mastery.ts`·`vocab-review.ts`, `lib/speech.ts`)를 고쳤으면 영향받는 과목 eval 오프라인을 **전부** 돌렸다
- [ ] 새 프롬프트 상수는 그 과목 eval의 `SPEC_SYNC_TARGETS`에, 새 eval 스크립트는 `package.json` `scripts`에 등록했다
- [ ] spec-sync가 덮지 않는 것(영어·수학 JSON Schema, 보간형 사용자 메시지 빌더)을 고쳤으면 스펙과 눈으로 대조한 결과를 리포트에 적었다
- [ ] study-qa 스킬의 해당 subject 매트릭스(`references/{english,math,japanese,common}.md`)와 맞물린다
- [ ] 응답 shape(상태코드별)·저장 레코드 변경·임의 판단(스펙 공백)이 전부 빌드 리포트에 목록화됐다

## 실호출·프로덕션 DB를 금지받았다면 — 지시가 아니라 명령으로 막아라

`.env`에 실제 `OPENAI_API_KEY`가 있고, 스토어는 GCP 신호(`GOOGLE_APPLICATION_CREDENTIALS`·`GOOGLE_CLOUD_PROJECT`·`K_SERVICE`) 하나만 있어도 프로덕션 Firestore를 잡는다(CLAUDE.md 서문). **"실호출 금지"라고 들어도 로컬 서버를 그냥 띄우면 실호출이 난다.** 2026-08-17 하루에 두 번 이 사고가 났다(에이전트가 dev/prod 서버를 띄우다 각각 3회·4회).

**모든 로컬 실행 명령 앞에 이 접두어를 붙여라:**

```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm run dev
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:japanese
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npx tsx scripts/....ts
```

- 빈 값으로 미리 설정한 변수는 `.env` 자동 로드가 덮어쓰지 않는다 — eval 스크립트의 `process.loadEnvFile`도, Next의 env 로더(`@next/env`, 이미 정의된 키는 건너뜀)도 그렇다. 그래서 키가 빈 채로 남고, AI 라우트와 `/api/tts`가 501로 거절한다. 화면은 열자마자 `prefetchSpeech()`가 `/api/tts` 합성을 미리 보내므로 **화면 확인용 dev 서버도 키를 비운다.**
- `STORE_BACKEND=file`을 명시하라. `lib/prod-guard.ts`는 **삭제만** 막고 생성·수정은 통과시킨다 — Firestore에 붙은 채 카드를 만들면 실데이터가 늘어난다.
- AI 응답 자체가 필요하면 루프백 스텁을 쓴다 — openai SDK가 env `OPENAI_BASE_URL`을 읽는다: `OPENAI_BASE_URL=http://127.0.0.1:<포트> STORE_BACKEND=file … npx tsx <스크립트>`.
- **"키 없는 드라이런"을 눈으로 확인했다고 믿지 마라** — `.env`가 자동 로드돼 조용히 실호출이 난 전례가 있다. 게이트(`EVAL_OFFLINE_ONLY=1` 등)를 새로 쓸 때는 그 게이트가 네트워크 호출부보다 앞서 return하는지 코드로 먼저 확인하라. 영어·일본어·수학 eval은 이 게이트에서 `globalThis.fetch`까지 막아 두 겹으로 방어한다.
- git commit·push는 하지 않는다. main 푸시가 곧 프로덕션 배포다.

## 코드를 grep으로 확인할 때의 함정

Claude Code 셸의 `grep`은 바이너리로 판정한 파일을 **조용히 건너뛴다**(`-I`로 감싼 ugrep). 이 저장소에는 템플릿 문자열 안에 NUL 문자를 구분자로 넣은 파일이 있어 바이너리로 판정된다 — `lib/vocab-quiz.ts`, `components/use-reorder.ts`, `app/api/japanese/vocab/generate/route.ts`. 예를 들어 "키 검사가 있는 라우트"를 `grep -rl OPENAI_API_KEY app/api`로 세면 일본어 생성 라우트가 빠진다. 전수 확인이 필요한 검색은 `grep -a`로 한다.

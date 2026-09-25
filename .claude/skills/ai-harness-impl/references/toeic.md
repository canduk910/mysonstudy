# 토익(아빠의 영어 · 토익스피킹) — 구현 규칙

> `ai-harness-impl` 스킬에서 토익 작업 시 읽는다. 은우 영어는 `english-routes.md`, 일본어는 `japanese.md`, 발음·스트릭·순서변경 같은 공통 기능은 `app-patterns.md`.
> 원문 스펙: `docs/harness/toeic.md` — 호출 A(§2)·B(§3)·C1~C5(§4)·관문 P(§4-10)·D + 관문 T(§5), 시험·형식표 §6, 저장 §7, 화면·경로 §8, eval §9, 재사용 경계 §10, 로드맵 §11.
> 프롬프트·JSON Schema 원문은 여기 옮기지 않는다. 스펙이 단일 정의처이고 `scripts/eval-toeic.ts`의 spec-sync가 대조한다.
> 이 문서의 값은 2026-09-26에 코드를 열어 확인한 것이다. 작업할 때는 다시 열어 대조하라.

목차: 1. 먼저 알 것 · 2. 호출 → 진입 함수(`calls.ts`) · 3. 하네스 밖 관문 P·T · 4. 파일 역할 · 5. 60초 상한 — 한 요청은 한 단위 · 6. 부분 성공·best-effort 관용구 · 7. 라우트 목록 · 8. 계약 파일과 번들 경계 · 9. 재사용 경계 · 10. 저장 레코드 · 11. eval-toeic.ts와 spec-sync 대상 · 12. 새 export 목록 · 13. 알려진 틈

## 1. 먼저 알 것

- **은우 영어와 다른 과목이다.** 언어는 같지만 학습자가 아빠(성인 토익스피킹 수험자)다(§0-1). 은우 북카드·단어장 프롬프트의 "초등 눈높이·쉬운 말"은 하드코딩돼 있어 가져올 수 없고, 은우 단어장 코드(`vocabBooks`·`vocabQuizzes`·`vocab-quiz-view`)를 같이 쓰면 은우의 스트릭·오답노트·기록이 오염된다. 경로(`/toeic`·`app/api/toeic/**`)·코드(`lib/ai/toeic/`)·컬렉션(5개)·스트릭 트랙이 전부 따로다. 코드 이름이 `english`가 아니라 `toeic`인 것도 그래서다(§0-3).
- **두 기능은 서로 독립이다**(§0-4). 표현집(호출 A·B + AI 없는 시험)과 모의고사(호출 C·D + 관문 P·T + 응시)는 한쪽이 비어도 다른 쪽이 돈다. 만나는 곳은 두 군데뿐이다 — 모의고사를 만들 때 표현집 표현 일부를 "활용할 표현"으로 넘기는 것(`pickExpressionsForMock`), 피드백 D가 그 목록에서 `tryExpressions`를 고르는 것.
- **이 저장소는 PUBLIC이다.** 교재 사진·전사·발화 포인트 원문은 저장소 어디에도 넣지 않는다 — 스펙·프롬프트·픽스처·리포트·로그 모두. 교재 10쪽은 git 밖 `data/private/`(gitignore)에 있고 앱의 "파일로 가져오기"로만 들어간다(§0-2·§7-6). `public/*.json`은 PIN 게이트를 우회하므로 더 나쁘다(`proxy.ts` 정적 확장자 예외). 픽스처는 전부 지어낸 영어로 쓴다(`scripts/eval-toeic.ts` 머리 주석). 라우트 로그에도 판독 내용을 남기지 않는다(`/api/toeic/sets/extract`는 검증 오류 메시지 300자만 찍는다).
- **은우·일본어·운동 코드를 고치지 않는다**(§10). 필요한 차이는 토익 쪽에 새로 두고, 언어 중립으로 확인된 자산은 수정 없이 재사용한다(9절). 운동의 타이머·비프·Wake Lock은 **import하지 않고 관용구만 따라 새로** 썼다(`lib/toeic-audio-cue.ts`·`components/use-toeic-wake-lock.ts`) — 실기기 검증이 끝난 경로에 회귀 위험을 지우지 않으려는 것이다.

## 2. 호출 → 진입 함수 (`lib/ai/toeic/calls.ts`)

**영어·일본어와 다른 점:** 토익 진입 함수는 `lib/ai/client.ts`가 아니라 **`lib/ai/toeic/calls.ts`**에 산다(서버 전용). `calls.ts`는 공유 래퍼 `callWithSchema`·`imagePart`·`textPart`·`resolveModel`을 그대로 부를 뿐, client.ts에는 토익 진입 함수도 과목 분기도 없다. 새 호출을 더해도 client.ts를 건드리지 않는다.

| 호출 | 진입 함수 | 한 번에 만드는 것 | 로그 라벨 · 옵션 상수(`prompts.ts`) | 라우트가 앞뒤로 붙이는 순수 함수 |
|---|---|---|---|---|
| A 표현집 판독 (vision) | `extractToeicPage(dataUrl)` — 이미지 파트를 텍스트보다 먼저 | **사진 1장** | `toeic_extract` · `TOEIC_EXTRACT_CALL_OPTIONS`(temp 0, 12,000) | 뒤 `mergeToeicExtractions`(`extract-merge.ts` — 공백 정리·keyExpressions 정리·DAY 묶기·번호 병합 → 초안) |
| B 발화 포인트 | `generatePointsChunk(topicKo, chunk)` | **표현 7개 묶음 1개** | `toeic_points` · `TOEIC_POINTS_CALL_OPTIONS`(0.5, 9,000) | 앞 `planPointsChunks(entries, {force})` → 뒤 스토어 `mergeToeicSetPoints`(안에서 `applyPointsResults`) |
| C1~C5 모의고사 문항 | `generateMockPart(part, input)` | **파트 1개** | `toeic_mock_<part>`(`toeicMockCallLabel`) · `TOEIC_MOCK_CALL_OPTIONS`(0.8, 6,000) | 앞 `pickExpressionsForMock`·`normalizeMockExpressions` → 안에서 `toMockRecordPart`(usedExpressions 정리 + C2 image pending) |
| D 답변 피드백 | `generateFeedback(input)` — Q1–2면 throw | **문항 1개** | `toeic_feedback` · `TOEIC_FEEDBACK_CALL_OPTIONS`(0.2, 2,500) | 앞 `buildFeedbackInput(mock, q, transcript)`(`mock.ts`) → 안에서 `postprocessFeedback`(tryExpressions 정리) |

- **zod는 입력을 알고 만든다.** B는 `buildPointsZod(chunk)`(index 집합·exampleSpan ⊂ example 대조에 입력이 필요하다), D는 `buildFeedbackZod({maxScore, transcript})`(점수 범위와 `said` ⊂ 전사문). 입력마다 규칙이 갈리는 팩토리라는 점은 영어 `makeLearningCardSchema`와 같다. C는 파트별 고정 zod 5개(`TOEIC_MOCK_ZOD[part]`), A는 `toeicExprExtractionSchema` 하나다.
- **호출 C 시스템 프롬프트는 조립한다** — `buildMockSystemPrompt(part)` = `TOEIC_MOCK_COMMON + "\n\n" + TOEIC_MOCK_TASKS[part]`(§4-0). spec-sync 대상은 조립 결과가 아니라 코드블록 6개(머리말 1 + 파트 5) 각각이고, 조립 규칙 자체는 eval의 "호출 C 조립" 항목이 따로 본다.
- **사용자 메시지는 템플릿 상수 + 단일 패스 치환**이다(`fillTemplate`, `prompts.ts`). 템플릿(`TOEIC_POINTS_USER_TEMPLATE`·`TOEIC_MOCK_USER_TEMPLATE`·`TOEIC_FEEDBACK_USER_TEMPLATE`)이 spec-sync 대상이라 형식 드리프트가 eval에서 잡힌다 — 영어·일본어의 보간형 빌더와 달리 **토익 사용자 메시지는 모두 대조된다.** 값 안에 플레이스홀더 모양 글자가 있어도 다시 치환하지 않고, 템플릿에 없는 키를 넘기면 throw한다. 새 사용자 메시지도 이 방식으로 만든다.
- **숫자는 형식표에서 읽는다.** D 사용자 메시지의 유형 이름·답변 시간·만점은 `toeicQuestionFormat(q)`(`lib/toeic-mock.ts`)에서 채운다. 파트 지시문(`TOEIC_PART_DIRECTIONS`) 속 숫자도 형식표에서 계산한다(§6-4). 초·문항 수를 문자열에 새로 적지 마라.
- **"보낸 목록 = 저장 목록."** 모의고사 라우트는 `normalizeMockExpressions(pickExpressionsForMock(...))` 결과를 호출 C에 넘기고 **같은 배열을** `expressionsUsed`로 저장한다. 이 배열이 호출 D의 활용할 표현이 되고, "파트 다시 만들기"도 같은 `targetGrade`·`topicHints`·`expressionsUsed`를 다시 쓴다(§7-2). 한쪽에서만 다시 고르면 피드백이 모범답변에 없던 표현을 권한다.

## 3. 하네스 밖 관문 P·T — `callWithSchema`와 합치지 않는다

TTS(`lib/tts.ts`)와 같은 부류다. Structured Outputs가 아니라 이미지·오디오 바이트를 주고받는 호출이라 zod·재요청·토큰 로그를 거치지 않는다(`docs/HARNESS.md` §0). 두 모듈 모두 **독립 OpenAI 클라이언트**를 쥐고, 키 규약(없으면 네트워크 없이 `no_api_key`)만 공유한다. throw하지 않고 결과 값(`{ok:true,…} | {ok:false, error,…}`)을 돌려준다.

| 관문 | 모듈 · 함수 | 모델 env (비었거나 공백이면 기본값 — `?.trim() ||`) | 규칙 |
|---|---|---|---|
| **P** Q3–4 사진 | `lib/toeic-image.ts` · `generateSceneImage(imagePrompt, signal?)` | `OPENAI_IMAGE_MODEL` → `gpt-image-2`, `OPENAI_IMAGE_QUALITY` → `medium`(모르는 값도 medium) | 프롬프트는 `buildSceneImagePrompt`(C2 `imagePrompt` trim + 공백 + `TOEIC_IMAGE_PROMPT_SUFFIX`, spec-sync 대상). 1536×1024 JPEG 압축 70 → data URL이 `TOEIC_IMAGE_DATA_URL_MAX`(900,000자)를 넘으면 압축 50으로 **1회** 더, 그래도 넘으면 `too_large`(Firestore 문서 1MB). 프롬프트·바이트는 로그에 남기지 않는다 |
| **T** 답변 전사 | `lib/toeic-transcribe.ts` · `transcribeAnswer({bytes, fileName, type}, signal)` | `OPENAI_TRANSCRIBE_MODEL` → `gpt-4o-mini-transcribe` | `language: "en"`, `response_format: "json"`, `maxRetries: 1`, timeout 30초(`TOEIC_TRANSCRIBE_TIMEOUT_MS`). **기대 문장(지문·모범답변·질문)을 `prompt`로 넣지 않는다** — 전사가 기대 문장 쪽으로 끌려가 점수가 부풀려진다. 그래서 함수에 prompt 인자 자체가 없고, eval이 소스에 prompt 필드가 없는지 정적으로 본다. 로그에는 모델·바이트·형식·단어 수·ms만 |

- **신호(signal) 처리가 둘이 반대다.** 전사는 라우트가 `req.signal`을 넘긴다 — 클라이언트가 끊으면 상류 전사도 멈추고 499 `client_closed`로 끝난다(`/api/tts`와 같은 비용 가드). 사진은 `req.signal`을 **넘기지 않는다** — 응답이 60초 상한에 끊겨도 서버가 끝까지 만들어 저장해야 하므로 서버 쪽 상한(`IMAGE_JOB_TIMEOUT_MS` 170초, `AbortSignal.timeout`)만 건다(§4-10). 화면은 실패를 받으면 `GET /api/toeic/mocks/[id]`로 한 번 새로 읽어 이미 저장됐는지 확인한 뒤에만 실패로 보인다.
- 두 관문과 `lib/tts.ts`를 한 래퍼로 합치지 마라. 성격(스키마 유무·재요청·신호)이 달라 한쪽 규칙이 다른 쪽을 오염시킨다. client.ts에 오디오·이미지 분기를 넣는 것도 같은 이유로 금지다.

## 4. 파일 역할

| 파일 | 담는 것 | 서버/클라이언트 | 누가 쓰나 |
|---|---|---|---|
| `lib/ai/toeic/prompts.ts` | 시스템 프롬프트 A·B·C 머리말+파트 5·D, 사용자 메시지 템플릿 3 + 빌더, `TOEIC_IMAGE_PROMPT_SUFFIX`·`buildSceneImagePrompt`, 호출 옵션 | 서버 | calls·관문 P·eval |
| `lib/ai/toeic/schemas.ts` | JSON Schema 8개(strict) + zod(A·B 팩토리·C 5·D 팩토리·가져오기 파일) + 타입 + **상한·폭 상수의 단일 정의**(`TOEIC_POINTS_LIMITS`·`TOEIC_MOCK_ZOD_BANDS`·`TOEIC_FEEDBACK_LIMITS`·`TOEIC_SET_*`·`TOEIC_EXTRACT_*` …) | 서버 | 전부 |
| `lib/ai/toeic/extract-merge.ts` | §2-4 후처리 1~5 | 순수 | 판독·저장 라우트, eval |
| `lib/ai/toeic/points.ts` | 7개 묶음 계획, 빈 자리만/force 병합, `isToeicSetEnriched` | 순수 | 포인트 라우트, 스토어(`mergeToeicSetPoints`), 정규화, eval |
| `lib/ai/toeic/mock.ts` | usedExpressions 정리·C2 pending, 피드백 자료·입력·후처리, 활용할 표현 고르기 | 순수 | 모의고사·채점 라우트, eval |
| `lib/ai/toeic/calls.ts` | 진입 함수 4개(2절) | **서버 전용** | 라우트, eval 게이트 |
| `lib/toeic-quiz.ts` · `lib/toeic-mock.ts` · `lib/toeic-score.ts` · `lib/toeic-listen.ts` · `lib/toeic-text.ts` · `lib/tts-split.ts` | 시험 출제·보기·집계 / 형식표·단계 전이·지시문 / Q1–2 대조·추정 총점 / 전체 듣기 대본 / 텍스트 판정·표현 키·단어열 대조 / TTS 쪼개기 | **클라이언트 안전**(lib/ai 밖, 런타임 import에 lib/ai·store·openai·zod 없음 — eval "번들 경계"가 잠근다) | 화면·서버 페이지·zod·eval |
| `lib/toeic-image.ts` · `lib/toeic-transcribe.ts` | 관문 P·T | 서버 전용 | 사진·채점 라우트 |
| `lib/mic-session.ts` · `lib/toeic-rec-store.ts` · `lib/toeic-audio-cue.ts` | 녹음 단일 관문 / 녹음 IndexedDB(`eunwoo-toeic-rec`, 최근 5회분) / AudioContext 싱글턴·비프 | 클라이언트 전용(모듈 최상위에서 window·navigator를 읽지 않는다 — SSR·eval import 안전) | 응시·결과 화면 |
| `lib/toeic-*-contract.ts` 4개 · `lib/toeic-record.ts` · `lib/toeic-normalize.ts` · `lib/toeic-mock-apply.ts` · `lib/toeic-attempt-rules.ts` · `lib/toeic-streak.ts` · `lib/toeic-read-marks.ts` · `lib/toeic-zod-ko.ts` | 경계 타입 / 렌더 판정 / 정규화 단일 정의 / 사진·파트 판정 / 응시 범위·닫힘 판정 / 영어 트랙 입력 / Q1–2 지문 표시 / 토익 라우트 한국어 zod 오류 맵 | 대부분 순수 | app-builder 영역 |

ai-engineer가 만든 것은 `lib/ai/toeic/**`·위 클라이언트 안전 순수 모듈 6개·`scripts/eval-toeic.ts`까지다. 저장소·라우트·화면·관문 P/T·녹음·스트릭 트랙은 app-builder 영역이다(`_workspace/build_ai-engineer_toeic-ai_report.md` 범위 절). 순수 함수 파일은 **값을 만드는 유일한 곳**이다 — 라우트·화면·스토어가 같은 판정을 한 벌 더 가지면 반드시 어긋난다. 그리고 순수라서 eval이 픽스처로 전부 잠근다. 후처리 규칙을 바꾸면 eval 점검도 함께 바꿔야 오프라인이 통과한다.

## 5. 60초 상한 — 한 요청은 한 단위

프로덕션은 Firebase Hosting → Cloud Run 리라이트라 요청 하나에 60초 상한이 있다(§1-1). 그래서 **AI 한 단위 = 요청 하나 또는 병렬 호출 하나**로 쪼갰다. 새 경로도 이 모양을 지킨다.

| 경로 | 쪼갠 단위 | 한 요청 안에서 |
|---|---|---|
| 판독 `/sets/extract` | 사진마다 호출 A 1회 | `Promise.allSettled`로 최대 `TOEIC_EXTRACT_MAX_PHOTOS`(8)장 병렬 |
| 발화 포인트 `/sets/[id]/points` | 7개 묶음(`TOEIC_POINTS_CHUNK_SIZE`)마다 호출 B 1회 | 묶음 병렬. 14개를 한 번에 부르면 출력이 길어 상한에 가깝다 |
| 모의고사 만들기 `/mocks` | 파트마다 호출 C 1회 | 고른 파트(최대 5) 병렬 |
| 사진 `/mocks/[id]/image` | **사진 한 장 = 요청 하나**(`{slot: 0|1}`) | 화면이 두 장을 따로 병렬 요청한다. 상한에 끊겨도 서버는 끝까지 저장(3절) |
| 채점 `/attempts/[id]/score` | **문항 하나 = 요청 하나**(전사 T + 호출 D) | 결과 화면이 동시 `TOEIC_SCORE_CONCURRENCY`(2)개로 돌린다. 전사 30초 × 재시도 1 + D가 최악이면 상한을 넘을 수 있다(QA m2_1 관찰 O4) — 끊겨도 다시 누르면 저장된 전사문으로 회복한다(6절) |

## 6. 부분 성공·best-effort 관용구

- **나눠 부르고, 성공분만 살리고, 실패는 사실대로, 전부 실패일 때만 500.** 판독은 `failedPhotoCount`·`pages[]`, 포인트는 `failedChunks`·`remaining`, 모의고사는 `failedParts`로 알린다. 모의고사는 고른 파트가 전부 실패하면 **저장하지 않는다**(빈 모의고사를 남기지 않는다). 판독은 표현이 하나도 없으면 200 `{ok:false, reason:"retake"}`다(오류가 아니라 정상 흐름).
- **판독은 저장하지 않는다.** 결과는 DAY별 **초안**(`ToeicSetDraft[]`)이고, 사람이 검토 화면에서 고친 뒤 `POST /api/toeic/sets`가 저장한다. 판독 zod는 사진에 있는 그대로를 받는 자리라 **잘린 항목의 빈 뜻·같은 사진 안 표현 중복을 거부하지 않는다.** 저장(`POST /sets`)과 가져오기(`/sets/import`)는 둘 다 거부한다(§2-4·§7-1) — 판독이 받은 것을 저장이 막는 비대칭이 의도다. 판독 zod에서 빈 뜻을 1자 이상으로 강제하면 재요청이 모델에게 사진에 없는 뜻을 지어내라고 떠민다.
- **발화 포인트는 부수 효과다.** 저장 직후 화면(`components/toeic-set-new-flow.tsx`)이 세트마다 포인트 라우트를 한 번 부르고(best-effort), 실패해도 카드·시험(뜻·표현 모드)은 돈다. **기본은 빈 자리만 채운다**(`force=false`) — 병합은 스토어 `mergeToeicSetPoints`가 원자 단위 안에서 **최신 entries 위에** 한다. 저장 직후 자동 호출과 "만들기" 버튼이 겹쳐도 먼저 채운 포인트를 뒤 호출이 덮지 않는다. `force=true`("다시 만들기")만 갈아 끼운다. 채울 것이 없으면 호출 없이 200 `nothingToFill`(키가 없어도).
- **빈 파트만 채운다.** "이 파트 다시 만들기"(`/mocks/[id]/regenerate?part=`)는 null 파트만 채우고 이미 있으면 409 `part_exists`다. 만든 뒤 저장 직전에 그사이 채워졌어도 같은 409로 버린다(`decideFillPart`를 원자 단위 안에서). 보던 모범답변·응시 기록이 가리키는 문항이 말없이 바뀌지 않게 하려는 것이다.
- **사진은 먼저 준비된 것이 이긴다.** `decidePictureImage`(`lib/toeic-mock-apply.ts`)가 `apply | kept | stale | missing`을 정하고, 사진 문서 생성과 칸 갱신을 한 원자 단위로 쓴다. ready는 다른 ready로도 failed로도 안 바뀐다. 장면(`imagePrompt`)이 그사이 바뀌면 `stale` → 409 `scene_changed`. 쓰지 않은 경우 사진 문서도 만들지 않는다(고아 0). 같은 인스턴스 안의 같은 칸 요청은 `IN_FLIGHT`로 합류하고, 이미 ready면 `reused:true`(비용 0).
- **채점은 전사를 먼저 저장한다.** 호출 D가 재요청 뒤에도 실패하면 전사문을 저장하고(점수 null) 500 `ai_failed`에 `answer`를 싣는다. 다시 누르면 전사 없이 저장된 전사문으로 D만 한다(`transcriptSource:"stored"`). 이미 점수가 있으면 AI 없이 저장된 답(`reused`). 전사문 단어가 `TOEIC_MIN_TRANSCRIPT_WORDS`(2) 미만이면 D 없이 0점 "답변이 인식되지 않았어요"(`noResponse`). Q1–2는 D가 아니라 `alignReadAloud`+`readProxyScore`다.
- **키 검사 위치.** 판독(`/sets/extract`)·모의고사 만들기(`/mocks`)는 **맨 먼저**(본문 파싱 전)다. 포인트·재생성·사진·채점은 "AI 없이 답할 수 있는가"(nothingToFill·part_exists·reused·형식 400·413·404·409)를 먼저 보고 **AI 호출 직전**에 501을 낸다. 어느 쪽이든 키가 없으면 AI·관문 호출이 0이라는 성질은 같다. 새 라우트는 둘 중 하나를 골라 머리 주석에 순서를 적는다(채점 라우트의 "검사 순서" 줄이 견본).

## 7. 라우트 목록 (`app/api/toeic/**`)

표의 경로는 `/api/toeic` 접두어를 뺐다. 응답 shape의 정의처는 계약 파일이고 각 라우트 머리 주석에 상태코드별로 적혀 있다. 전부 `runtime = "nodejs"`, 400 `issues`는 `toToeicIssues`(`lib/toeic-zod-ko.ts` — 값은 싣지 않고 경로·규칙 문구만, 교재 원문이 응답·로그로 새지 않게)다.

| 라우트 | 역할 | AI | 상태코드 | 계약 |
|---|---|---|---|---|
| `POST /sets/extract` | 사진 N장 → 병렬 판독 + 병합. 저장 안 함 | A | 200 `{drafts, photoCount, failedPhotoCount, notExpressionPhotoCount, pages, model}` · 200 `{ok:false, reason:"retake"}` · 400 · 501 · 500 `ai_failed`(retriable) | `toeic-set-contract.ts` |
| `POST /sets` | 검토한 초안 저장(세트 안 표현 중복·빈 뜻 거부, keyExpressions는 `cleanKeyExpressions`로 대조) | 없음 | 200 `{id, droppedKeyExpressions}` · 400 · 500 | 〃 |
| `POST /sets/import` | 파일로 가져오기 — `toeicImportFileSchema`, presetKey 멱등 | 없음 | 200 `{created, skipped, createdIds}` · 400 · 500 | 〃 |
| `DELETE /sets/[id]` | 세트 + 그 시험 세션 연쇄 | 없음 | 200 · 404 · 403 `prod_guard` · 500 `delete_failed` | 〃 |
| `POST /sets/[id]/rename` · `POST /sets/reorder` | 제목 · 목록 순서 | 없음 | 200 · 400 · 404 · 500 | 〃 · `reorder-contract.ts` |
| `POST /sets/[id]/points` | 발화 포인트(빈 자리만 / `force`) | B | 200 `{filled, remaining, enriched, failedChunks, totalChunks, nothingToFill}` · 400 · 404 · 501 · 500 `points_failed`·`save_failed` | `toeic-set-contract.ts` |
| `POST /sets/[id]/quiz` | 시험 세션 저장 — **한 레코드 = 한 모드** | 없음 | 200 `{id}` · 400 · 404 · 500 | `toeic-quiz-contract.ts` |
| `POST /mocks` | 모의고사 만들기(파트 병렬) | C | 200 `{id, titleKo, createdParts, failedParts, expressionsCount}` · 400 · 501 · 500 `ai_failed`(retriable)·`save_failed` | `toeic-mock-contract.ts` |
| `GET /mocks/[id]` · `DELETE /mocks/[id]` | 레코드 새로 읽기(사진 실패 재확인용) · 모의고사 + 사진 + 응시 연쇄 삭제 | 없음 | 200 · 404 · 403 · 500 | 〃 |
| `POST /mocks/[id]/rename` · `POST /mocks/reorder` | 제목 · 목록 순서 | 없음 | 200 · 400 · 404 · 500 | 〃 · `reorder-contract.ts` |
| `POST /mocks/[id]/regenerate?part=` | 빈 파트 하나 | C | 200 · 400 · 404 · 409 `part_exists` · 501 · 500 | `toeic-mock-contract.ts` |
| `POST /mocks/[id]/image` | 사진 한 장 `{slot}` | 관문 P | 200 `{slot, image, reused}` · 400 · 404 · 409 `scene_changed` · 501 · 500 `image_failed`(retriable)·`save_failed` | 〃 |
| `GET /images/[id]` | 생성 사진 바이트(`cache-control: private`) | 없음 | 200 image/jpeg · 404 · 500 `image_unreadable` | 〃 |
| `POST /mocks/[id]/attempts` | 응시 시작(범위 판정 `decideAttemptScope`) | 없음 | 200 `{attemptId, scope, parts, questions, startedAt}` · 400 · 404 · 409 `incomplete_mock`·`part_missing` · 500 | `toeic-attempt-contract.ts` |
| `POST /attempts/[id]/finish` | 끝/그만두기 — **한 번만** | 없음 | 200 `{finishedAt, recordedCount, answers}` · 400 · 404 · 409 `already_finished`(+`recordedCount`) · 500 | 〃 |
| `POST /attempts/[id]/score` | 문항 하나 채점(multipart `q`·`audio`) | 관문 T + D | 200 `{q, answer, reused, transcriptSource, noResponse}` · 400 · 413 `audio_too_large`(`TOEIC_SCORE_AUDIO_MAX_BYTES` 4MB) · 404 · 409 `not_finished`·`not_recorded` · 501 · 499 `client_closed` · 500 `transcribe_failed`·`ai_failed`(+answer)·`save_failed` | 〃 |

- 응시 화면은 `pagehide`에서 `navigator.sendBeacon`으로 finish를 보낸다. 그래서 끝/그만두기가 두 번 오는 것이 정상 경로이고, 409 `already_finished`는 화면이 **성공으로 본다**(`recordedCount`를 함께 받는다).
- 화면 경로는 스펙 §8 목록 그대로다(`/toeic` 허브 → `/toeic/sets`·`/toeic/mocks` …, 응시는 `/toeic/mocks/[id]/take` 전면 오버레이, 결과는 `/toeic/attempts/[id]`). store를 읽는 토익 페이지는 전부 `force-dynamic`이다.

## 8. 계약 파일과 번들 경계

- **계약 파일 4개**: `lib/toeic-set-contract.ts`(판독·저장·가져오기·포인트·삭제·rename + 400 issues 한국어 위치 `toeicIssueLineKo`), `lib/toeic-quiz-contract.ts`(시험 저장·항목 키 라벨), `lib/toeic-mock-contract.ts`(생성·재생성·사진·GET + `toeicImageUrl`·표시 도우미), `lib/toeic-attempt-contract.ts`(응시 시작·finish·score + 업로드 형식·상한·동시 채점 수·`TOEIC_DEBUG_TIMESCALE_KEY`). `lib/ai/toeic/*`와 `lib/store`는 `import type`으로만 참조하고, 값은 클라이언트 안전 순수 모듈(`lib/toeic-mock.ts` 등)에서만 가져온다.
- 2026-09-26 현재 `"use client"` 컴포넌트 중 `@/lib/ai/toeic`를 import하는 곳은 없다. 확인: `grep -arl '"use client"' components app | xargs grep -an 'from "@/lib/ai/toeic'` — 결과가 0이어야 한다(`-a`는 SKILL.md "grep 함정").
- 화면이 lib/ai의 **값**(`TOEIC_SET_TITLE_MAX`·`TOEIC_MOCK_EXPRESSIONS_MAX`·편집 상한)을 필요로 하면 서버 페이지(`app/toeic/**/page.tsx`)가 import해 props로 내린다(일본어 관용구). 시험 문항 조립(`lib/toeic-quiz.ts`)·형식표(`lib/toeic-mock.ts`)처럼 클라이언트가 직접 계산해야 하는 것은 처음부터 lib/ai 밖에 둔다.
- 클라이언트 안전 모듈은 **정규식 lookbehind를 쓰지 않는다**(구형 iOS Safari에서 문법 오류로 던진다 — `lib/toeic-score.ts`·`lib/toeic-quiz.ts` `maskCloze` 주석). eval이 `lib/mic-session.ts`·`toeic-rec-store`·`toeic-audio-cue`·`toeic-read-marks`·`toeic-attempt-rules`·`toeic-attempt-contract`에 대해 "값 import 없음 + lookbehind 없음"을 잠근다.

## 9. 재사용 경계 (§10)

**수정 없이 재사용한다** — `buildChoices`(`lib/vocab-quiz.ts`), `aggregateWordStats`·`isStatMastered`(`lib/vocab-mastery.ts`, 어댑터 `toVocabQuizRecords` 경유), `callWithSchema`·`imagePart`·`textPart`·`resolveModel`, 사진 파이프(`ImageCropper`·`lib/image-crop.ts`·`lib/image-resize.ts`·`lib/upload-limits.ts`), `useReorder`·`lib/reorder-contract.ts`, `speak`·`speakQueue`·`prefetchSpeech`·`unlockSpeechPlayback`·`TtsSpeedControl`·`TtsEngineControl`, `prod-guard`, `lib/kst.ts`, `STREAK_REFRESH_EVENT`·`computeStreak`.

**옮겨서 공유(동작 변화 0)** — `splitForTts`를 `lib/tts-split.ts`로 옮기고 `lib/ja-coaching-script.ts`가 재수출한다. eval-toeic이 두 경로의 결과가 같은지, `eval:speech`가 해설 낭독 쪼개기를 계속 잠근다. 쪼개기를 고치면 **`eval:speech`와 `eval:toeic`을 둘 다** 돌린다.

**토익 쪽에 새로 둔다** — 프롬프트 전량, 표현 엔트리 모양(`expression`·`meaningKo`·`points`), 시험 모드 enum(`TOEIC_QUIZ_MODES` 4종)·러너·오답·기록 화면(은우 `vocab-quiz-view`는 URL·문구·TTS 언어가 박혀 있어 재사용하면 오염된다), 컬렉션 5개, 녹음 모듈, 모의고사 타이머·비프·Wake Lock.

**오답 보기는 넘기기 전에 거른다.** `buildChoices`는 은우 공유 함수라 고치지 않는다. 같은 표현·같은 뜻 항목을 오답 후보에서 빼고 정규화 키로 중복을 접는 일은 `lib/toeic-quiz.ts`(`distinctDistractors`·`matchKey`)가 `buildChoices`를 부르기 **전에** 한다. 거른 뒤 보기가 `TOEIC_CHOICE_MIN`(2) 미만이면 그 문항을 내지 않는다(`skipped`) — 정답 하나뿐인 문항은 무조건 맞아 "연속 2회 정답 졸업"을 거짓으로 채운다.

재사용 대상이 모자라 보이면 은우 파일을 고치기 전에 멈춘다. 공유 순수 함수를 고치면 은우·일본어 시험도 함께 바뀌므로, 정말 고쳐야 한다면 오케스트레이터에 올리고 `eval:english`·`eval:japanese`·`eval:toeic` 오프라인을 모두 통과시킨다.

## 10. 저장 레코드 (`lib/store.ts`)

| 레코드 | 컬렉션 | 핵심 규칙 |
|---|---|---|
| `ToeicSetRecord` | `toeicSets` | `source: "photo" \| "import"`, `presetKey`(가져오기 멱등 키, 사진이면 null), `entries`(1~60, 세트 안 표현 중복 금지 — `findDuplicateExpressionIndexes`), `quiz`(0~12), `enriched`(모든 entry의 points ≠ null), `photoCount`(원본은 저장 안 함) |
| `ToeicQuizRecord` | `toeicQuizzes` | `setId`, `mode`(4종), `items: {word, correct, answered}[]` — `word`는 항목 키(표현, 또는 QUIZ의 첫 keyExpression → `quiz:{no}` → `quiz:{promptKo}`). append 전용. 은우 `vocabQuizzes`·일본어 `jaQuizzes`와 분리 |
| `ToeicMockRecord` | `toeicMocks` | `targetGrade`, `expressionsUsed`(보낸 목록 = 저장 목록), `topicHints`, `parts.{read,picture,respond,info,opinion}`(실패·미선택은 null), C2 `items[i].image {status, imageId}` |
| `ToeicImageRecord` | `toeicImages` | 사진 한 장 = 문서 하나, `dataUrl` ≤ 900,000자. AI가 만든 사진이라 "원본 사진 미저장"(SPEC §13) 대상이 아니다 |
| `ToeicAttemptRecord` | `toeicAttempts` | 시작에 만든다(IndexedDB 키로 id가 필요). `answers`는 시작 때 빈 배열이고 끝/그만두기가 응시 범위의 **모든 문항**을 채운다. "닫힌 응시" = `finishedAt !== null \|\| answers.length > 0`(`isToeicAttemptClosed`) |

- 새 컬렉션 12항목 체크리스트(`app-patterns.md` §4)를 전부 밟았다 — `DbShape` 필수 필드 5개, `emptyDb`, `readDb`의 `(parsed.x ?? []).map(normalize*)`, `mergeDbForSeed`의 `mergeById`, `scripts/seed.ts`의 빈 배열(교재 내용을 시드에 넣지 않는다), Firestore 컬렉션 접근자·`to*`. 정규화는 `lib/toeic-normalize.ts` 한 곳이고 두 백엔드가 같이 쓴다.
- **원자 단위가 필요한 변경은 7개다.** 파일은 `mutate`, Firestore는 `runTransaction` — `importToeicSets`(확인+생성, 멱등), `mergeToeicSetPoints`(최신 entries 위 병합), `fillToeicMockPart`(빈 파트만), `saveToeicPictureImage`·`markToeicPictureImageFailed`(먼저 준비된 사진이 이긴다), `finishToeicAttempt`(한 번만), `updateToeicAttemptAnswer`(**그 문항만** — 동시 채점 2개가 서로 덮지 않게). 판정은 순수 함수(`decideFillPart`·`decidePictureImage`·`decideAttemptFinish`·`applyAttemptAnswer`)를 원자 단위 **안에서** 부른다(`app-patterns.md` §5 관용구).
- **삭제 가드.** Firestore 구현의 `deleteToeicSet`·`deleteToeicMock`이 첫 줄에서 `assertDestructiveAllowed("deleteToeicSet" | "deleteToeicMock")`을 부른다. 딸린 문서(시험 세션 / 사진·응시)를 먼저, 본 문서를 마지막에 지운다. 파일 백엔드는 한 `mutate`에서 함께 지운다.
- **migrate-to-firestore에 넣지 않는다.** 교재 데이터는 사용자가 프로덕션 앱에서 파일을 골라 넣는 것이고, 로컬 데이터를 프로덕션으로 옮기는 경로를 만들지 않는다(§7-6, CLAUDE.md 서문).

## 11. eval-toeic.ts와 spec-sync 대상

- 명령: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:toeic`. 2026-09-26 기준 **20개 영역 357항목**이다(`data/private/toeic-preset-hackers-core.json`이 있는 로컬 기준. 없으면 교재 파일 3항목이 SKIP 1건으로 바뀐다 — 공개 저장소·CI 기준은 SKIP). 스크립트가 `.env`를 스스로 읽으므로(`process.loadEnvFile`) 접두어가 유일한 차단선이다. `EVAL_OFFLINE_ONLY=1`은 모듈 최상단에서 `globalThis.fetch`를 막는다.
- eval-toeic은 공통 eval 3종과 달리 **`lib/store`를 import한다**(순수 함수 `applyAttemptAnswer`·`applyAttemptFinish`). 스토어 인스턴스를 만들지는 않지만, 이 import에 부수 효과가 생기면 어느 DB를 향할지 모르는 스크립트가 된다 — store 모듈 최상위에 I/O를 넣지 마라.
- **spec-sync 대상**(`SPEC_SYNC_TARGETS`, 바이트 대조 14개): `TOEIC_EXTRACT_SYSTEM_PROMPT`(§2-1)·`TOEIC_EXTRACT_USER_TEXT`(§2-2)·`TOEIC_POINTS_SYSTEM_PROMPT`(§3-1)·`TOEIC_POINTS_USER_TEMPLATE`(§3-2)·`TOEIC_MOCK_COMMON`(§4-1)·`TOEIC_MOCK_{READ,PICTURE,RESPOND,INFO,OPINION}_TASK`(§4-2~§4-6)·`TOEIC_MOCK_USER_TEMPLATE`(§4-7)·`TOEIC_IMAGE_PROMPT_SUFFIX`(§4-10)·`TOEIC_FEEDBACK_SYSTEM_PROMPT`(§5-1)·`TOEIC_FEEDBACK_USER_TEMPLATE`(§5-2).
- **JSON Schema 의미 동치 8개**(`runJsonSchemaSyncChecks`): 스펙 코드블록을 `JSON.parse`해 `name`으로 찾아 deepEqual — `toeic_expr_extraction`(§2-3)·`toeic_speaking_points`(§3-3)·`toeic_mock_{read,picture,respond,info,opinion}`(§4-8)·`toeic_answer_feedback`(§5-3). 스펙의 `toeic_*` JSON 블록 수가 정확히 8이어야 한다.
- **호출 옵션도 스펙 문장에서 읽는다.** `runConstantChecks`가 스펙의 "temperature X, maxOutputTokens Y, call 라벨 `Z`" 문장을 정규식으로 찾아 `*_CALL_OPTIONS`와 대조한다. 옵션을 바꾸면 스펙 문장과 코드를 같이 바꾸고, 스펙 문장의 **모양**은 유지한다. JSON Schema enum ↔ 상수(`TOEIC_PARTS`·`TOEIC_CONFIDENCES`·`TOEIC_*_KINDS`)도 같은 영역이 본다.
- 새 프롬프트·템플릿 상수는 `SPEC_SYNC_TARGETS`에, 새 JSON Schema는 `runJsonSchemaSyncChecks` 대상 목록과 스펙 블록 수 단언에 등록해야 끝이다. 새 클라이언트 안전 모듈은 "번들 경계" 목록에 넣는다.
- **실호출 게이트 `EVAL_TOEIC=1`**(오프라인 전부 통과 뒤, `EVAL_OFFLINE_ONLY`가 없을 때만): B 1회(지어낸 표현 7개) + C 1회(`EVAL_TOEIC_PART`, 기본 `opinion`) + D 1회(Q11 픽스처 전사문) = 3회, `EVAL_TOEIC_PHOTO=<사진 경로>`를 주면 A 1회 더(결과는 개수만 찍는다 — 교재 원문이 로그에 남지 않게). 재요청이 나면 호출마다 +1. **관문 P·T는 게이트에 없다.** 게이트 실행은 동의를 받은 오케스트레이터 몫이다.

## 12. 새 export 목록 — app-builder가 소비하는 것

시그니처는 코드가 진실이다. 바꾸면 빌드 리포트에 breaking change로 적는다.

| 모듈 | export | 쓰는 곳 |
|---|---|---|
| `lib/ai/toeic/calls.ts` (서버) | `extractToeicPage(dataUrl)` · `generatePointsChunk(topicKo, chunk)` · `generateMockPart(part, input)` · `generateFeedback(input)` | 판독·포인트·모의고사·재생성·채점 라우트, eval 게이트 |
| `lib/ai/toeic/extract-merge.ts` | `mergeToeicExtractions(pages)` → `{drafts, notExpressionPhotoIndexes}` · `cleanKeyExpressions(keys, entries)` → `{kept, dropped}` · `cleanToeicExtraction` · `findMissingToeicNos` · `defaultToeicSetTitle(dayNo, topicKo)` · 타입 `ToeicSetDraft` | 판독·저장 라우트, 검토 화면(타입) |
| `lib/ai/toeic/points.ts` | `planPointsChunks(entries, {force})` · `applyPointsResults(entries, items, {force})` · `pointsTargetIndexes` · `toPointsInput` · `isToeicSetEnriched` | 포인트 라우트, 스토어, 정규화 |
| `lib/ai/toeic/mock.ts` | `pickExpressionsForMock(sets, sessions, {max?, rng?})` · `buildFeedbackInput(mock, q, transcript)` · `buildFeedbackMaterial` · `sampleAnswerFor` · `postprocessFeedback` · `toMockRecordPart` · `cleanUsedExpressions` · `attachPendingImages` · `toeicQuestionPartNameKo` | 모의고사·채점 라우트 |
| `lib/ai/toeic/prompts.ts` | `normalizeMockExpressions(list)`(라우트가 `expressionsUsed` 저장에 쓴다) · `buildSceneImagePrompt(imagePrompt)`(관문 P) | 모의고사 라우트, `lib/toeic-image.ts` |
| `lib/ai/toeic/schemas.ts` | `toeicImportFileSchema` · 상한 상수(`TOEIC_EXTRACT_MAX_PHOTOS` 8·`TOEIC_SET_ENTRIES_MAX` 60·`TOEIC_SET_QUIZ_MAX` 12·`TOEIC_SET_TITLE_MAX` 120·`TOEIC_MOCK_EXPRESSIONS_MAX` 24 …) · 타입 전부 | 저장·가져오기 라우트, 서버 페이지 |
| `lib/toeic-text.ts` (클라이언트 안전) | `expressionKey` · `findDuplicateExpressionIndexes` · `TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO` · `matchKey` · `collapseSpaces` · `countWords` · `containsWordSequence` · `hasLatin`·`hasHangul` | 저장 라우트·가져오기 zod·검토 화면(같은 판정 하나), 채점 |
| `lib/toeic-quiz.ts` | `buildToeicChoiceQuestions` · `buildToeicSpeakSession` · `maskCloze` · `speakKeyForBookQuiz` · `aggregateToeicStatsByMode` · `buildToeicReviewCandidatesByMode` · `toeicWrongKeys` · `splitToeicItemsByMode` · `TOEIC_QUIZ_MODES`·`TOEIC_CHOICE_MIN`·`TOEIC_SPEAK_SESSION_MAX` | 시험·오답·기록 화면, 시험 저장 라우트, 모의고사 라우트(표현 고르기) |
| `lib/toeic-mock.ts` | `TOEIC_MOCK_FORMAT` · `toeicQuestionFormat` · `toeicMaxScore` · `firstPhase`·`nextPhase`·`beginAnswer`·`remainingMs` · `toeicSpeechOutcome(kind, reason, sounded, pieceCount)`(질문·지시문 음성 뒤 진행/일시정지 판정) · `TOEIC_PART_DIRECTIONS`·`TOEIC_DIRECTIONS_LANG` · `TOEIC_MOCK_PARTS`·`TOEIC_TARGET_GRADES` | 응시 화면, 호출 D 메시지, 라우트 |
| `lib/toeic-score.ts` | `alignReadAloud` · `readProxyScore` · `estimateToeicTotal` · `isNoResponseTranscript`·`noResponseFeedback` · 안내 문구 상수 | 채점 라우트, 결과·학습 보기 화면 |
| `lib/toeic-listen.ts` · `lib/tts-split.ts` | `buildToeicListenScript(set, mode)`(3모드) · `splitForTts` | 표현 카드 전체 듣기, 모범답변 🔊 |

## 13. 알려진 틈 (2026-09-26 코드 기준)

고치라는 목록이 아니라, 이 근처를 작업할 때 모르고 밟지 않게 적어 둔 사실이다. 회차마다 아직 남았는지 다시 확인한다.

- **무음 질문 안전망은 `speakQueue`의 `"done"`만으로 판정하지 않는다**(QA m2_1 P2-A → `_workspace/build_app-builder_toeic-m2-p2fix_report.md`에서 수정, 2026-09-26 기준 QA 재검증 전). `speakQueue`는 조각이 연속 3개(`QUEUE_SILENT_STOP`) 무음이어야 `"stopped"`를 내므로, 1~2조각인 토익 질문 큐는 전부 무음이어도 `"done"`이다. 그래서 `onEnd`의 둘째 인자 `SpeakQueueEndInfo.sounded`(끝까지 소리를 냈다고 본 조각 수 — 하위 호환 추가, `lib/speech.ts`)를 받아 순수 판정 `toeicSpeechOutcome`(`lib/toeic-mock.ts`)이 정한다 — 질문은 `sounded < 조각 수`면, 지시문은 `sounded === 0`이면 일시정지("다시 듣기"/"질문 보기"). 이 판정을 화면에 인라인으로 되돌리지 마라(eval-toeic "형식표·단계"와 eval-speech S1~S5가 잠근다). 소리가 반드시 나야 하는 다른 화면도 같은 둘째 인자를 쓴다.
- **`getUserMedia` 대기에는 모듈 안에 상한이 있다**(QA m2_1 P2-B → 같은 리포트에서 수정, QA 재검증 전). 상한이 없으면 권한 창이 탭 밖에서 멈췄을 때 `activeCaptures`가 새어 이후 세션이 `play-and-record`에 갇힌다. 지금은 `getUserMediaWithin`이 답변 `MIC_GUM_TIMEOUT_MS`(8초)·마이크 점검 `MIC_CHECK_GUM_TIMEOUT_MS`(15초 — 첫 권한 창에 사람이 답할 시간)를 넘기면 카운트를 되돌리고 `playback`으로 복귀한 뒤 `MicError("timeout")`을 던지고, 늦게 온 스트림은 트랙을 즉시 놓는다. `started`가 거부되면 모듈이 스스로 녹음을 버린다(`abort`와 같은 멱등 함수). 응시 화면의 감시 타이머는 `MIC_START_WATCHDOG_MS = MIC_GUM_TIMEOUT_MS`로 **숫자를 import**한다 — 상한 상수 4종(`MIC_GUM_TIMEOUT_MS`·`MIC_CHECK_GUM_TIMEOUT_MS`·`MIC_START_TIMEOUT_MS`·`MIC_STOP_TIMEOUT_MS`)은 `lib/mic-session.ts` 한 절에만 둔다. eval-toeic "녹음 세션 상한"이 가짜 navigator 위에서 실제 `startRecording`을 돌려 잠근다.
- **같은 문항을 두 탭에서 동시에 채점하면 전사·D가 두 번 든다**(QA m2_1 관찰 O1). 한 탭 안은 `runningRef`로 막히고, 저장은 나중 쓰기가 이긴다. 사진 라우트의 `IN_FLIGHT` 같은 서버 합류는 채점 라우트에 없다.
- **호출 D zod는 일부 필드의 언어를 보지 않는다.** `summaryKo`는 한글 포함, `improvedAnswer`는 라틴 포함·한글 금지를 보지만, `strengths`·`fixes[].whyKo`·`fixes[].better`는 빈 값만, `missingKo`는 개수만 본다(`buildFeedbackZod`). 스펙 §5-3이 요구한 범위와는 맞다 — 더 조이려면 스펙부터 바꾼다.
- **호출 C zod 폭은 목표 등급과 무관하다.** `TOEIC_MOCK_ZOD_BANDS`는 IM3·IH·AL에 같은 폭을 건다(예: Q11 모범답변 80~180단어). 등급별 길이를 프롬프트로 벌리려면 폭 안에서 움직인다(`prompt-eval/references/toeic-dials.md`).

# 토익(아빠의 영어 · 토익스피킹) 정합성 매트릭스·체크리스트

> `study-qa` 스킬에서 subject가 `toeic`일 때 읽는다. 은우 영어는 `english.md`, 일본어는 `japanese.md`, 발음 관문·스트릭 코어 같은 과목 공통 기능은 `common.md`가 맡는다.
> 원문 스펙은 `docs/harness/toeic.md`다. 구현 규칙은 `.claude/skills/ai-harness-impl/references/toeic.md`에 있다. 이 문서의 값은 2026-09-26에 코드를 열어 확인한 것이다. 검증할 때는 다시 열어 대조하라.
> 선례 리포트: `_workspace/qa_report_toeic_ai_{1,2}.md`(AI 모듈), `qa_report_toeic_m1_{1,2}.md`(표현집·시험), `qa_report_toeic_m2_1.md`(모의고사·응시·채점 — e2e·실기기 목록의 출처). 그 P2 두 건의 수정은 `build_app-builder_toeic-m2-p2fix_report.md`(2026-09-26)다.

## 목차

1. 검증의 무게중심
2. 4중 정의 매트릭스 — 호출 A~D
3. 정확성 장치 반례 목록
4. 저장·원자성 — 누가 먼저 쓰는가
5. 응시 화면 — 소리·녹음·시계
6. 비용 가드
7. 공개 저장소 오염 스캔
8. 경계면 체크리스트 — 라우트 ↔ 화면
9. e2e 요령 — 가짜 마이크·시간 배율·스텁 4종
10. iPhone 실기기 체크리스트
11. 리포트 형식과 열린 항목

## 1. 검증의 무게중심

영어는 구조 개수, 수학은 답의 정확성, 일본어는 축 분리였다. 토익은 셋이 겹친다.

- **축 분리.** 은우 영어 ↔ 아빠 영어(컬렉션·스트릭 트랙), 시험 모드 ↔ 시험 모드(숙련도), 판독 초안 ↔ 저장본(허용 폭이 다르다). 섞이면 에러 없이 거짓 통계가 난다.
- **환각 차단.** 모델이 교재 예문 밖 구간(`exampleSpan`), 받지 않은 index, 전사문에 없는 말(`said`)을 지어내면 zod가 거부해야 한다. 전사는 기대 문장 쪽으로 끌려가지 않아야 한다(prompt 없음). 지문 읽기(Q1–2)는 LLM이 점수를 지어내지 않는다(순수 대조).
- **실기기에서만 드러나는 것.** 녹음·오디오 세션·비프·Wake Lock은 iOS WebKit 동작이다. 헤드리스로 순서까지만 확인하고 나머지는 "실기기 미검증"으로 넘긴다(10절).
- **비용과 공개 저장소.** 비용이 드는 경로(판독·포인트·문항·사진·전사·피드백·TTS)가 버튼·키 없이는 돌지 않는지, 교재 원문이 저장소 어느 파일에도 없는지(7절)가 매 회차 검증 항목이다.

모든 항목은 **반례를 넣어 실제로 거부되는지**로 확인한다. 규칙이 코드에 있다는 것만으로는 통과가 아니다.

## 2. 4중 정의 매트릭스 — 호출 A~D

셀 규칙: "—"는 그 위치에 정의가 **없어야 정상**이다. JSON Schema에 `minItems`/`maxItems`/`minLength`가 있으면 그 자체로 위반이다. 프롬프트 열은 `lib/ai/toeic/prompts.ts`, zod 열은 `lib/ai/toeic/schemas.ts`의 상수다. 스펙 코드블록과 바이트가 같은지는 spec-sync가 본다(14개 + JSON Schema 8개 — `ai-harness-impl/references/toeic.md` 11절).

### 호출 A — 표현집 판독 (§2, temperature 0 · 12,000 · `toeic_extract`)

| 제약 | 프롬프트 | JSON Schema | zod | eval |
|---|---|---|---|---|
| 비표현 페이지 | `isExpressionPage=false`면 빈 배열 | boolean | false면 entries·quiz 비어야 함 | 호출 A zod 영역 |
| entries 개수 | — | — | 사진당 0~`TOEIC_EXTRACT_ENTRIES_MAX` 30, 같은 사진 안 `no` 중복 금지(null 제외), `no`·`dayNo` 1~999 | 〃 |
| expression | "강조된 영어 표현 부분만" | string | 1~80자, 라틴 포함, **한글 금지** | 〃 |
| meaningKo | 괄호 설명까지 그대로 | string | 1~80자, 한글 포함 — **`partial=true`면 빈 값 허용** | "잘린 항목의 빈 뜻은 판독만 통과" |
| example / exampleKo | 없으면 null | nullable | example 3~300자·라틴·한글 금지, exampleKo 한글, **example null이면 exampleKo도 null** | 〃 |
| quiz | 없으면 빈 배열 | — | 0~`TOEIC_EXTRACT_QUIZ_MAX` 6, promptKo 한글, modelAnswer 라틴·한글 금지, hint null 또는 1~60자 | 〃 |
| keyExpressions | 항목 expression 그대로 | string[] | **zod 아님** — 후처리 `cleanKeyExpressions`가 DAY 묶음 안에서 대조해 **버린다** | 판독 후처리 영역 |

### 호출 B — 발화 포인트 (§3, 0.5 · 9,000 · `toeic_points`)

**B는 zod 폭이 프롬프트 폭과 같다**(C·일본어와 다르다 — 여유 폭이 없다). 프롬프트를 지킨 출력은 통과하고, 벗어나면 재요청이다.

| 제약 | 프롬프트 | zod (`buildPointsZod(chunk)`, `TOEIC_POINTS_LIMITS`) |
|---|---|---|
| index 집합 | "같은 index로 정확히 하나" | 입력 index 집합과 **정확히 같다**(누락·중복·모르는 index 거부) |
| exampleSpan | 예문에서 그대로 복사, 예문 null이면 null | 입력 example의 **부분 문자열(대소문자 구분)**, example null이면 null |
| coreKo | 70자 이내 | 4~70자, 한글 |
| useIn | 2~3개, part 서로 다름, 6~32단어, 예문 베끼기 금지 | 2~3, part 중복 금지, 6~32단어·220자·라틴·한글 금지, 입력 example과 같으면 거부(대소문자·연속 공백 무시), sentenceKo 한글·160자 |
| frames | 1~3, 90자 이내, `___` | 1~3, 5~90자, **`___` 포함** |
| variations | 2~4 | 2~4, en 2~60자 한글 금지, ko 1~60자 한글 |
| pronunciationKo · pitfallKo · grammarKo | 110자 이내(뒤 둘은 없으면 null) | 6~110 / null 또는 4~110 |
| followUp | en + ko | en 10~200자 한글 금지, ko 4~160자 한글 |

### 호출 C1~C5 — 모의고사 문항 (§4, 0.8 · 6,000 · `toeic_mock_<part>`)

**zod는 프롬프트보다 넓다**(§4-9 — `TOEIC_MOCK_ZOD_BANDS` 한 곳). 넓은 칸은 결함이 아니다. zod가 프롬프트보다 **좁은** 칸이 결함이다(프롬프트를 지킨 출력이 재요청 뒤 throw가 되어 파트가 빈다).

| 파트 | 프롬프트 | zod |
|---|---|---|
| C1 read | 지문 정확히 2·kind 다름, 80~110단어·문장 4~7, stressWords 6~12, tipsKo 2~4 | items 2·kind 다름, text 60~130단어, **`chunks.join(" ")` = text**(연속 공백 접은 뒤), stressWords 4~14·각각 text에 단어 경계로 존재(대소문자 무시), tips 2~4. 문장 수는 보지 않는다 |
| C2 picture | 장면 2·place 다름, imagePrompt 60~120단어, sample 60~90단어·5~7문장, keyPoints 3~5 | items 2·place 다름(대소문자·공백 무시)·1~60자, imagePrompt 40~160, sample 40~110, keyPoints 3~5. 인원 수·문장 수는 보지 않는다 |
| C3 respond | 질문 3, 답 25~45 / 25~45 / 55~85단어 | questions 3·`?`로 끝남, 15~60 / 15~60 / 35~110 |
| C4 info | rows 5~9·meta 1~4·notes 0~2, 답 1~3문장 / 3~5문장(단어 수 없음) | rows 4~10·meta 1~4·notes 0~3, 5~60 / 5~60 / 25~110단어, **표 칸은 "비어 있지 않음 + 한글 금지"만**(`9:00 – 9:30`·`$45`에는 라틴이 없다) |
| C5 opinion | sample 110~150단어, outline 3~5 | 80~180, outline 3~5 |
| 공통 usedExpressions | 목록 문자열 그대로 + 모범답변 속 구간 | **zod 아님** — `cleanUsedExpressions`가 입력 목록(대소문자 무시)·모범답변 부분 문자열로 대조해 **버린다** |

### 호출 D — 답변 피드백 (§5, 0.2 · 2,500 · `toeic_feedback`)

| 제약 | 프롬프트 | zod (`buildFeedbackZod({maxScore, transcript})`) | eval |
|---|---|---|---|
| score | Q3–10 0~3, Q11 0~5 | 정수 0~`toeicMaxScore(q)` | 범위 밖 거부 |
| strengths / fixes / missingKo | 1~3 / 0~5 / 0~3 | 같은 개수(`TOEIC_FEEDBACK_LIMITS`), strengths 빈 항목 거부 | 〃 |
| fixes[].said | "전사문에서 그대로 복사한 구간" | `isSaidInTranscript` → `containsWordSequence`(3절) | 순서 바꿈·사이 단어 뺌·단어 조각 거부, 쉼표 빠진 인용 통과 |
| summaryKo · improvedAnswer | 한국어 · 영어 | 한글 포함 · 라틴 포함·한글 금지 | — |
| tryExpressions | 목록 중 0~3 | **zod 아님** — `postprocessFeedback`가 목록에 있는 것만·중복 제거·최대 3 | 후처리 |

`strengths`·`missingKo`·`fixes[].whyKo`·`fixes[].better`는 빈 값만 보고 언어는 보지 않는다(스펙 §5-3 범위와 같다). 모델이 영어로 whyKo를 내도 통과한다는 사실은 "미검증(품질)"로 남긴다.

## 3. 정확성 장치 반례 목록

각 장치에 **통과 1 + 반례 1**을 넣는다. 전부 순수 함수·zod라 무비용이다. 대부분 eval에 이미 있으므로, 가드를 무력화하는 변이를 넣어 eval이 FAIL하는지(변이 테스트)까지 본다 — 변이는 scratchpad 복사본에 넣고 원본은 건드리지 않는다.

| 장치 | 위치 | 통과 | 반례(거부·배제되어야 함) |
|---|---|---|---|
| exampleSpan ⊂ 예문 | `buildPointsZod` | 활용형·사이에 낀 단어를 포함한 구간(스펙 §3-1 예시 모양) | 예문에 없는 활용형, 대소문자만 바꾼 구간, 예문 null인데 구간 있음 |
| cloze 가림 | `maskCloze` | 구간의 **모든** 등장·문장 첫머리 대문자까지 가림 | 단어 조각만 걸리는 구간(`cart` ⊂ `cartoon`) → null → 출제 안 함. 가린 문제에 정답 글자가 남으면 결함(eval이 실제 교재 파일로도 "정답 잔존 0"을 본다 — 내용은 찍지 않는다) |
| index 집합 | `buildPointsZod` | 입력과 같은 집합 | 누락 1, 중복 1, 모르는 index 1 — 셋 다 거부 |
| chunks 조인 | C1 zod | `chunks.join(" ")` = text(연속 공백 접기) | chunk 하나에서 단어 하나 빠짐, 문장부호 하나 다름 |
| stressWords | C1 zod | 문장 첫머리 대문자 형태 | 지문에 없는 단어, 단어 조각 |
| said 순서 가드 | `containsWordSequence`(`lib/toeic-text.ts`) | 쉼표·마침표 빠진 인용, 대소문자 차이, 둥근 따옴표 `’` | 순서 바꿈, **사이 단어를 뺀 이어 붙이기**, 단어 조각으로 시작, 전사문에 없는 단어, 문장부호뿐, `can't` → `cant`(아포스트로피는 단어 안에서 남긴다) |
| Q1–2 비AI 채점 | `alignReadAloud`·`readProxyScore` | `7 p.m.` = `7 PM` = `7pm` = `seven p.m.`, `twenty-five` = `25`, `%` = `percent` → accuracy 1 | `Plan A. Buy`처럼 문장 끝 한 글자는 붙이지 않음. 호출 D를 Q1–2로 부르면 `generateFeedback`이 throw |
| 추정 총점 | `estimateToeicTotal` | raw 0~35 전 구간 리터럴 표(round10) | round를 floor로 바꾼 변이(raw 24가 IH 140 → IM 130), 정수 아닌 문항 번호·만점 초과 점수 → 미채점으로 셈(던지지 않음) |
| 모드별 숙련도 분리 | `aggregateToeicStatsByMode` | 같은 표현을 `ko-to-expr`에서 맞히고 `speak`에서 틀림 → 두 버킷이 따로 | 버킷 키를 상수로 바꾸거나 mode 필터를 지운 변이 → eval FAIL. `speak` 세션 순서도 말하기 통계만 본다 |
| 같은 뜻 보기 제외 | `lib/toeic-quiz.ts`(`distinctDistractors`·`matchKey`) | 뜻이 다른 표현 5개 → 보기 5개, 정답 포함 | 같은 뜻 쌍이 `ko-to-expr`·`cloze` 오답으로 나옴, 같은 표현(대소문자만 다름)이 보기 둘로 나옴, 거른 뒤 보기 < `TOEIC_CHOICE_MIN`(2)인데 출제됨(정답 하나뿐 = 거짓 졸업) |
| 세트 안 표현 중복 | `findDuplicateExpressionIndexes` | 서로 다른 표현 | 대소문자·공백만 다른 표현 → 저장 400·가져오기 거부, 오류 경로가 **두 번째 항목**의 `expression`, 판독 zod는 통과(초안에 표시) |
| 잘린 항목의 빈 뜻 | 판독 zod ↔ 저장·가져오기 | 판독: `partial=true` + 빈 뜻 통과 | 저장·가져오기: 같은 항목 거부 |
| keyExpressions | 판독 `cleanKeyExpressions`(버림) ↔ 가져오기 zod(거부) | 판독: 어긋난 키는 조용히 빠지고 `droppedKeyExpressions`로 셈 | 가져오기: 글자 하나 다른 키 → 거부 |
| usedExpressions · tryExpressions | `cleanUsedExpressions` · `postprocessFeedback` | 목록에 있는 표현, 모범답변 속 구간 | 목록 밖 표현·모범답변 밖 구간 → 버림(거부 아님), tryExpressions 4개 → 3개 |
| 전사 prompt 없음 | `lib/toeic-transcribe.ts` | — | 소스·스텁 요청 어디에도 `prompt` 필드가 있으면 결함(eval 정적 점검 + 스텁 multipart 필드 기록) |

## 4. 저장·원자성 — 누가 먼저 쓰는가

판정 함수는 순수하고, 두 백엔드가 같은 함수를 원자 단위 **안에서** 부른다. 파일 백엔드는 실측하고, Firestore는 에뮬레이터가 없고 프로덕션 접속이 금지이므로 **코드 사본을 낙관적 트랜잭션 가짜 DB에 붙여** 확인한다(선례: `qa_report_toeic_m2_1.md`의 `fs/run.ts` + `fs/fake-optimistic.ts` — 음성 대조군 포함).

- **컬렉션 분리·스트릭 무오염.** 토익은 `toeicSets`·`toeicQuizzes`·`toeicMocks`·`toeicImages`·`toeicAttempts` 다섯만 쓴다. 검증 전후로 은우·일본어·운동 컬렉션 개수가 그대로인지 센다. 스트릭은 아빠 칸의 **"🎙️ 영어" 트랙**(`appaEnglish`)으로 따로 계산된다(`lib/toeic-streak.ts` → `computeStreak`). 반례: 토익 시험만 한 날에 은우·일본어 트랙이 이어지거나, 녹음 0개 응시가 영어 트랙을 잇거나, 답한 문항 0개 표현 시험이 세지면 결함이다. 주 잠금은 `eval:streak` "영어 트랙"이고 `eval:toeic` "스트릭 트랙"이 한 번 더 본다. 토익 컬렉션 읽기가 실패해도 영어 트랙만 중립값이 되고 헤드라인 전체는 살아야 한다(`app/api/streak/route.ts`).
- **응시 재완료 409.** 끝/그만두기는 한 번만이다(`decideAttemptFinish`). 같은 응시에 두 번째 finish(재시도·`pagehide` 비콘·다른 탭) → 409 `already_finished` + `recordedCount`, 기록 불변. "끝까지"가 "중단"으로 바뀌거나 채점된 문항의 `recorded`가 뒤집히면 결함이다. 화면은 409를 성공으로 보고 스트릭 갱신 이벤트를 쏜다.
- **채점은 닫힌 응시의 녹음된 문항에만.** 열린 응시 → 409 `not_finished`, 녹음 안 된 문항 → 409 `not_recorded`, 범위 밖 q → 404 `question_not_found`.
- **동시 채점 트랜잭션.** 같은 응시의 두 문항을 동시에 채점하면(결과 화면 동시 2개) 둘 다 남아야 한다 — `updateToeicAttemptAnswer`는 **그 문항만** 바꾼다. 파일 백엔드는 두 요청을 겹쳐 보내 실측하고, Firestore는 가짜 DB에서 경합 재시도를 일으켜 본다. 대조군: 트랜잭션을 get → set으로 바꾼 사본에서는 한쪽이 사라져야 한다(가짜가 경합을 실제로 만든다는 증거).
- **빈 파트만 채우기.** 이미 있는 파트 재생성 → 409 `part_exists`, 만든 결과는 버린다. 두 요청이 같은 빈 파트를 동시에 채우면 한쪽만 쓴다.
- **사진은 먼저 준비된 것이 이긴다.** ready → ready·failed로 안 바뀜, 장면이 바뀌면 `scene_changed`(409), 쓰지 않은 경우 `toeicImages`에 고아 문서 0. 900,000자 초과 → 압축 50으로 1회 더 → 그래도 넘으면 failed·문서 0.
- **발화 포인트 빈 자리만.** 저장 직후 자동 호출과 "만들기"를 겹쳐 보내도 먼저 채운 포인트가 남는다(`force=false`). `force=true`만 갈아 끼운다.
- **가져오기 멱등.** 같은 파일을 두 번(동시에도) 보내면 두 번째는 전부 `skipped`, 세트 수 불변. `presetKey`는 확인과 생성이 한 원자 단위다.
- **혼합 시험 세션은 모드마다 한 레코드.** 일부 모드만 저장 실패 → "다시 저장"은 **아직 저장 안 된 모드만** 보내고 `finishedAt`은 첫 시도 값 그대로다. 성공한 모드를 다시 보내면 같은 세션이 두 벌이 되어 거짓 졸업이 난다(`qa_report_toeic_m1_2.md` P2-1 재발 여부).
- **삭제 가드.** Firestore 구현의 `deleteToeicSet`·`deleteToeicMock`이 `assertDestructiveAllowed`를 부르는지, 라우트가 403 `prod_guard`로 옮기는지, 연쇄 삭제가 딸린 것 먼저인지 코드로 본다.

## 5. 응시 화면 — 소리·녹음·시계

`components/toeic-take-view.tsx`는 발음 관문(`lib/speech.ts`)·Web Audio 비프(`lib/toeic-audio-cue.ts`)·녹음 관문(`lib/mic-session.ts`) 셋을 한 화면에서 엮는다. 소리 문제는 먼저 어느 경로인지 가른다.

- **오디오 세션 전환 순서.** 녹음마다 `session=play-and-record` → `getUserMedia` → `recorder.start()` → `onstart` → (답변) → `recorder.stop()` → `onstop` → `track.stop()` → **그다음** `session=playback`이어야 한다. 녹음 중 세션 변경은 0이어야 한다(바꾸면 트랙이 끊긴다). `navigator.audioSession`을 만지는 코드는 `lib/mic-session.ts` 한 곳뿐인지 grep한다(`grep -arn audioSession app components lib`). 같은 모듈에 은우 자유대화용 `acquireMicStream`(재생·캡처가 겹치는 전이중 입구)이 더해졌다 — 토익 녹음 `startRecording`은 그대로여야 하고(`git diff`로 추가만인지), 이 모듈을 건드린 변경이면 `eval:toeic`을 다시 돈다. 답변 타이머는 recorder `start` 이벤트에서 시작한다.
- **재생과 캡처를 겹치지 않는다.** 질문 음성(`speakQueue`, en-US)과 비프(`TOEIC_BEEP_SEC` + 여유)가 끝난 뒤 녹음이 열리는지 타임라인으로 본다.
- **무음 질문 안전망.** 질문 음성이 끝내 안 나면 일시정지 + "다시 듣기"/"📝 질문 보기"가 떠야 한다(Q8–10은 평소 질문 글을 숨긴다). `speakQueue`는 연속 3조각(`QUEUE_SILENT_STOP`) 무음이어야 `"stopped"`라, 1~2조각인 질문 큐는 전부 무음이어도 `"done"`이다 — 이것이 QA m2_1 P2-A였다. 수정 뒤에는 `onEnd` 둘째 인자 `sounded`를 받아 `toeicSpeechOutcome`(`lib/toeic-mock.ts`)이 판정한다(질문 `sounded < 조각 수` → 일시정지, 지시문 `sounded === 0` → 일시정지). 반례: 기기 음성 엔진 + `speechSynthesis`가 `synthesis-failed`를 내게 하고 Q8–10 유형 연습을 돈다 → Q8 질문에서 멈춰야 한다. "도입만 들리고 질문은 무음"(Q5·Q8의 2조각 큐, `sounded` 1)도 멈춰야 한다. 인자 하나짜리 기존 `onEnd` 호출부(해설 낭독·운동·토익 학습 보기)가 그대로 도는지(eval-speech S5)도 본다. 외부 pause(잠금 화면 ⏸)는 `"stopped"`로 잡힌다.
- **gUM 상한.** `getUserMedia`가 답하지 않을 때(가짜 마이크 `hang` 모드) 화면은 8초(`MIC_START_WATCHDOG_MS` = `MIC_GUM_TIMEOUT_MS`) 뒤 "시간만 재요"로 넘어가고, **모듈도 스스로 카운트를 되돌리고 세션을 `playback`으로 복귀해야 한다** — 그 뒤 녹음이 정상 종료될 때 세션이 `playback`이어야 한다. 이것이 QA m2_1 P2-B였다(상한 없는 gUM 대기 → `activeCaptures` 누수 → 세션이 `play-and-record`에 갇힘). 수정 뒤 확인할 반례: 답변 중 무응답(8초), 마이크 점검 중 무응답(`MIC_CHECK_GUM_TIMEOUT_MS` 15초 — 점검 버튼이 "듣는 중…"에 영원히 머물지 않는가), 상한 뒤 늦게 도착한 스트림(트랙이 즉시 stop되는가 — 다시 점검하면 곧바로 되는가), `started` 거부(start 이벤트 5초 초과 — 모듈이 스스로 녹음을 버리는가), 점검 중 "녹음 없이 시작"·언마운트(점검 녹음이 abort되는가). eval-toeic "녹음 세션 상한"(가짜 navigator·audioSession·MediaRecorder 위 실제 `startRecording`)이 잠그는 범위와 e2e로 본 범위를 나눠 적는다.
- **숨김 중단.** 녹음 중 `visibilitychange → hidden`이면 녹음을 버리고 그 문항 "중단됨" → 돌아오면 "이 문항 다시"/"다음 문항으로". `pagehide`면 비콘 finish.
- **시계.** 종료 시각(epoch ms) 기반 250ms 틱이고 렌더 중 `Date.now()`를 읽지 않는다. 형식표대로 가는지 본다 — 지시문은 파트 첫 문항만, Q8 앞 표 읽기 45초 1회, Q10 질문 두 번, 준비·답변 초.
- **녹음 없이 연습.** 마이크 거부·미지원이면 "녹음 없이" 경로로 끝까지 가고, 결과 화면은 "녹음 없음" + AI 채점 버튼 비활성 + 이유를 보여야 한다. 이때 `getUserMedia` 호출은 점검 1회뿐이어야 한다.
- **기기 보관.** IndexedDB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`, 최근 5회분(`pickAttemptsToEvict` — 지금 응시는 늘 남긴다). 프라이빗 모드면 메모리 폴백. 다른 기기에서 결과를 열면 "녹음은 응시한 기기에만 있어요"와 채점 버튼 막힘.

## 6. 비용 가드

키를 비운 서버에서 아래가 전부 **501이고 스텁 요청 0**이어야 한다. 루프백 스텁을 걸어 둔 채 키만 비우면 새는 요청을 스텁 로그로 잡을 수 있다(`OPENAI_BASE_URL`을 스텁으로).

| 경로 | 비용 | 확인 |
|---|---|---|
| 판독 `/sets/extract` | 사진당 호출 A 1 | 501이면 "다시 읽기" 버튼 0, 키 안내만 |
| 발화 포인트 `/sets/[id]/points` | 7개 묶음당 호출 B 1 — **저장 직후 자동** | 채울 게 없으면 키 없이도 200 `nothingToFill`(호출 0) |
| 파일로 가져오기 `/sets/import` | 0 | AI 없음 — 키 없이 돌아야 한다 |
| 모의고사 만들기 `/mocks` · 재생성 | 파트당 호출 C 1 | 501, 저장 0 |
| 사진 `/mocks/[id]/image` | 장당 관문 P 1(초과 시 +1) — **학습 보기가 열리면 pending 칸 두 장을 자동 요청** | 501이면 칸 상태 불변. `failed` 칸은 자동으로 다시 요청하지 않아야 한다(버튼만) |
| 채점 `/attempts/[id]/score` | 문항당 관문 T 1 + 호출 D 1(Q1–2·무응답은 전사만) | **버튼을 누르기 전에는 0.** 이미 점수 있는 문항은 `reused`(호출 0). D 실패 뒤 재시도는 `transcriptSource:"stored"`(전사 0) |
| 발음 `/api/tts` en-US | 표현 카드·시험 러너·학습 보기·결과 화면 마운트 시 프리페치(≤90), 응시 시작 탭에서 지시문·질문 약 20~25조각 | 501 → 기기 음성 폴백(에러 UI 없음) |

- 키 검사가 AI·관문 호출보다 **앞**인지 라우트마다 본다(판독·만들기는 맨 앞, 나머지는 "AI 없이 답할 수 있는가"를 본 뒤 AI 직전 — eval "채점 라우트: 키 검사(501)가 전사·호출 D보다 먼저"가 채점을 잠근다).
- 전사 요청 multipart에 `prompt` 필드가 0인지 스텁에서 센다(선례: 40건 전부 0).
- 업로드 상한 `TOEIC_SCORE_AUDIO_MAX_BYTES`(4MB): 초과 → 413. 결과 화면이 같은 상수로 먼저 거른다(한 곳 정의). 매우 큰 본문은 proxy 버퍼 한도로 400이 날 수 있다(관찰 O8).

## 7. 공개 저장소 오염 스캔

저장소는 PUBLIC이다. 교재 원문(표현·뜻·예문·해석·QUIZ·힌트)이 변경·새 파일 어디에도 없어야 한다. **리포트에도 원문을 옮기지 않는다** — 적중은 `파일:줄`과 분류로만 적고, 예시는 지어낸 영어로 든다.

- 대조 기준은 `data/private/`의 전사본이다(**읽기 전용**). 대상은 git이 보는 변경·새 파일 전부(`_workspace` 포함, 이미지·`design/` 제외).
- 방법(선례는 세션 scratchpad의 `tqm2/leak-scan.cjs` — 세션 전용이라 새로 쓴다): 정확 일치(2단어 이상 표현, 5자 이상 뜻, 예문, 해석, QUIZ, 힌트) + 영어 n-gram(6-gram 선례) + 한국어 12자 창. 스캔 스크립트는 **위치만 출력**한다.
- 적중은 사람이 판정한다. 흔한 콜로케이션·위치 표현(지어낸 스텁 문장과 우연히 겹친 것)은 오염이 아니다. 문장·해석·QUIZ 복사는 P1이다(이전 회차 P1-1 — 스펙·`prompts.ts`에 교재 문장이 들어갔던 전례가 있다).
- `scripts/eval-toeic.ts`는 교재 파일이 있으면 zod·개수만 확인하고 내용은 찍지 않는다. eval 출력에 교재 문장이 보이면 결함이다. 가져오기 400 `issues`에도 값이 실리지 않아야 한다(경로·규칙 문구만).
- `git status --short`가 시작 때와 같은지, `design/*.jpeg` 스테이징이 그대로인지 본다.

## 8. 경계면 체크리스트 — 라우트 ↔ 화면

경계 타입의 단일 정의처는 `lib/toeic-set-contract.ts`·`lib/toeic-quiz-contract.ts`·`lib/toeic-mock-contract.ts`·`lib/toeic-attempt-contract.ts`다. 라우트 머리 주석의 상태코드 목록과 화면의 fetch 분기를 **같이 열어** 비교한다.

- [ ] **요청 계약 ↔ zod 양방향 묶기**(`requestMatchesSchema`)가 라우트마다 있는가.
- [ ] 판독 화면(`components/toeic-set-new-flow.tsx`)의 "다시 읽기"는 `retriable:true` 500·본문이 JSON이 아닌 5xx·fetch 예외에서만 보이고, 501·400에서는 이유만 보이는가.
- [ ] 검토 화면이 저장 라우트가 거부할 것(세트 안 같은 표현 — 앞 항목 번호까지, 잘린 항목의 빈 뜻)을 **저장 전에** 짚고, 고칠 곳이 남은 묶음을 저장에서 빼며 그 사실을 알리는가. 저장 200의 `droppedKeyExpressions > 0`이면 완료 화면에서 묶음별로 알리는가.
- [ ] 저장 400 `issues`가 한국어 위치(`toeicIssueLineKo` — "세트 1 › 표현 3 › 영어 표현")로 보이고 점 표기 경로·영어 필드명이 노출되지 않는가.
- [ ] 시험 모드 고르기 화면이 미리 센 문항 수와 실제 세션 문항 수가 같은가(출제 불가 판정은 rng와 무관해야 한다). 0문항 모드의 이유 문구가 서버가 정한 조건(`TOEIC_CHOICE_MIN`, 예문·구간 유무)과 같은가.
- [ ] 문제를 소리로 읽지 않는가(정답이 샌다). 답을 고른 뒤 표현·모범 문장을 **lang을 명시해** en-US로 읽는가.
- [ ] 학습 보기의 사진 요청 실패 → `GET /mocks/[id]`로 한 번 새로 읽은 뒤에만 실패 표시하는가(504를 주입해 확인). `failed` 칸 자동 재요청 0.
- [ ] 응시 시작 409(`incomplete_mock`·`part_missing`)와 "실전 응시" 버튼 노출 조건(다섯 파트 모두 non-null)이 맞는가.
- [ ] 결과 화면: 추정 등급은 11문항이 다 채점됐을 때만 "추정(참고용)"과 함께, 아니면 "n문항 채점됨". Q1–2는 "발음·억양은 채점하지 않았어요". 녹음이 이 기기에 없으면 채점 버튼 막힘 + 이유.
- [ ] 스트릭 갱신 이벤트: 시험 저장 성공(새로 저장된 모드가 하나라도), finish 성공 또는 409이며 녹음 ≥ 1일 때 쏘는가.
- [ ] 클라이언트 번들: `"use client"` 컴포넌트가 `@/lib/ai/toeic`를 값으로 import하지 않는가(`grep -arl '"use client"' components app | xargs grep -an 'from "@/lib/ai/toeic'` 0줄). `npm run build` 뒤 `.next/static`에 키·프롬프트 첫 문장·스키마 이름(`toeic_expr_extraction`)이 0건인가.
- [ ] 폰 폭: `/toeic` 화면들과 스트릭 헤드라인(아빠 트랙 셋 — 🗾·🎙️·💪)이 360·390px에서 문서 가로 넘침 0인가. 세 자리 연속일이면 `compact`가 사람 이모지를 숨기는가(`common.md` §7 방법).

## 9. e2e 요령 — 가짜 마이크·시간 배율·스텁 4종

선례 스크립트는 2026-09-26 세션 scratchpad의 `tqm2/`(`e2e.cjs`·`init.js`·`stub.cjs`·`e2e-session.cjs`)에 있었다 — 세션 전용 경로라 다음 세션에는 없을 수 있으니 방법은 이 절과 `qa_report_toeic_m2_1.md`를 기준으로 삼는다. **빌더 스크립트를 재사용하지 말고 새로 쓴다** — 검증의 독립성이 깨진다. 스텁 응답 데이터(지어낸 영어)만 읽기 전용으로 빌려도 된다.

- **실행.** dev 서버는 `OPENAI_API_KEY=sk-stub OPENAI_BASE_URL=http://127.0.0.1:<스텁 포트>/v1 STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= APP_PIN= npx next dev -p <포트>`. 키 없는 서버 쪽 검증도 `OPENAI_BASE_URL`을 스텁으로 걸어 새는 요청을 잡는다. 데이터를 쓰기 전에 `[store] backend=file (STORE_BACKEND 명시)` 로그를 확인하고, `data/db.json`을 shasum과 함께 백업·복원한다. 관문 P·T도 SDK가 env `OPENAI_BASE_URL`을 읽으므로 같은 스텁으로 간다.
- **스텁 엔드포인트 4종.** `/v1/responses`(호출 A·B·C1~C5·D — 요청의 `text.format.name`으로 갈라 응답), `/v1/images/generations`(관문 P — 작은 JPEG, 초과·실패·지연 모드), `/v1/audio/transcriptions`(관문 T — multipart를 파싱해 필드·WAV 헤더를 기록, 무응답·환각 said용 전사문 모드), `/v1/audio/speech`(`/api/tts` — 무음 MP3). 모드는 `/__control`로 바꾸고 `/__log`로 요청 기록을 읽는 식으로 둔다. 응답은 전부 지어낸 영어다.
- **가짜 마이크 스트림.** 이 Mac에서는 Chromium의 `--use-fake-device-for-media-stream`(+ fake UI·`permissions:["microphone"]`)이 `getUserMedia`를 6초 넘게 답하지 않게 만든다(TCC 추정, 재현 3회). 그래서 init script(`page.addInitScript`)가 `navigator.mediaDevices.getUserMedia`를 **Web Audio `MediaStreamDestination`의 진짜 MediaStream**(오실레이터 + LFO)으로 바꾼다. MediaRecorder·AnalyserNode·`decodeAudioData`·WAV 인코딩·업로드는 앱 코드 그대로 돈다. localStorage 스위치로 `deny`(NotAllowedError)·`hang`(영원히 대기 — P2-B 재현)을 고른다. 트랙 `stop`을 감싸 이벤트를 기록한다.
- **가짜 오디오 세션·이벤트 로그.** `navigator.audioSession`을 getter/setter로 흉내 내 세션 변경을 기록하고(녹음 중 변경이면 표시), `MediaRecorder.prototype.start/stop`과 `onstart/onstop`을 감싸 5절의 순서를 타임라인으로 뽑는다.
- **가짜 speechSynthesis(선택).** 성공/`synthesis-failed` 모드. 무음 질문 안전망(P2-A)을 재현할 때 쓴다. 외부 pause 주입은 빌더의 `forcePauseHook` 방식을 참고해 새로 쓴다.
- **시간 배율 훅.** localStorage `toeic-debug-timescale`(`TOEIC_DEBUG_TIMESCALE_KEY`, 0.01~1, 예 `"0.05"`)로 단계 종료 시각을 줄인다. **개발 빌드 전용**이다 — `readDebugTimescale`이 `NODE_ENV === "production"`이면 localStorage를 읽기 전에 1을 돌려준다(eval이 잠근다). production 빌드에서 배율이 먹으면 결함이다.
- **Playwright.** `require('/Users/koscom/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core')`, `executablePath`는 `chrome-headless-shell-mac-arm64/chrome-headless-shell`(`~/Library/Caches/ms-playwright/chromium_headless_shell-1217/…`). 390×844 모바일 에뮬레이션, 판정은 DOM 실측과 네트워크·이벤트 로그로 한다. fetch·`sendBeacon`을 init script에서 감싸 요청을 기록한다.
- **흐름 묶음 예**(선례 E1~E5·S1~S3): 실전 11문항 끝까지 → 채점, 유형 연습 한 파트, 마이크 거부 → 녹음 없이, 녹음 중 숨김 → 중단됨, 음성 실패(P2-A), 세션 순서, 점검 중 무응답, 답변 중 무응답(P2-B). 동시 채점·재완료·환각 said·전사 실패·D 실패 재시도는 API 스크립트로 라우트를 직접 친다.
- 끝나면 dev·스텁·브라우저를 전부 끄고 해당 포트 LISTEN 0, `data/db.json` shasum 복원, `db.json.tmp` 없음, `git status --short` 불변을 확인한다.

## 10. iPhone 실기기 체크리스트

헤드리스는 음소거이고 스텁 MP3는 무음이며, iOS WebKit의 세션·잠금 동작은 재현되지 않는다. 아래는 **"실기기 미검증"으로 남기고 아빠 iPhone 확인 목록으로 넘긴다**(출처: `_workspace/build_app-builder_toeic-m2b_report.md` §6, QA m2_1 미검증 1). 배포본이나 `next dev --experimental-https`에서만 된다 — LAN http에서는 마이크가 열리지 않는다.

1. 녹음 직후 다음 질문 음성(cloud en-US, 타이머 콜백에서 시작)이 **스피커에서 정상 볼륨**으로 나는가(수화기로 가거나 작아지지 않는가 — play-and-record → playback 전환 뒤, WebKit 218012).
2. **무음 스위치 ON**에서 비프가 나는가(시작 탭에서 세션을 playback으로 건다). 운동 비프와 비교한다.
3. 답변마다 `getUserMedia`를 다시 부를 때 권한 창이 다시 뜨는가, 탭 밖(타이머 콜백) 호출이 허용되는가. 안 되면 8초 감시가 "시간만 재기"로 넘어간다 — 진단 캡션·"녹음 실패"로 판정하고 P2-B 발생 빈도로 적는다.
4. `recorder.mimeType` 실제 값(`audio/mp4` 기대)과 mp4 `decodeAudioData` 성공 여부, 디코드 길이 ≈ 녹음 길이(결과 화면 진단 "→ WAV" / "원본 그대로(이유)").
5. WAV 업로드 전사가 **끝까지** 나오는가(1~3단어 잘림 없음). 필요하면 원본 mp4 업로드와 비교한다.
6. 녹음 중 세션 변경이 트랙을 끊지 않는가(구현은 녹음 중 변경을 막는다 — 회귀 확인).
7. Wake Lock 20분 유지(Safari 탭 / 홈 화면 앱).
8. 녹음 중 화면 잠금·앱 전환 → "중단됨" → "이 문항 다시"와 시계 보정.
9. 시작 탭의 `unlockSpeechPlayback` 뒤, **녹음을 거친 다음에도** 큐 오디오 요소가 탭 밖 재생을 계속 허용하는가.
10. AirPods 연결 시 입력·출력 경로.
11. 결과 화면 `<audio>`로 mp4 녹음 다시 듣기, IndexedDB 보관(프라이빗 모드는 메모리 폴백 — 새로고침하면 사라짐).
12. 클라우드 en-US 지시문이 "young learner" 톤이라 시험 음성이 실제보다 느린 것은 알려진 한계다(§10) — 속도 1.15로 보완되는지만 듣는다.

실제 OpenAI 호출(C·D 출력이 zod 폭 안에 드는가, `gpt-image-2` 크기·지연·거부율, 전사 품질·60초 상한 안 지연)과 실제 Firestore 트랜잭션(사진 ~0.9MB 커밋 크기 포함), Cloud Run에서 60초 절단 뒤 사진 작업이 끝까지 도는지도 미검증으로 남긴다 — 사용자 동의 없이는 확인하지 않는다.

## 11. 리포트 형식과 열린 항목

`_workspace/qa_report_toeic_{tag}_{n}.md`(기존 tag: `ai`·`m1`·`m2`). SKILL.md 공통 형식에 아래 절을 더한다.

```
## 안전 — 실행 접두어·스텁 포트·store 백엔드 로그·db.json shasum(전/후)·git status 전후·data/private 읽기 전용·원문 미기재
## 호출 A~D 매트릭스 — 위치별 실제 값(프롬프트 / zod 상수 / eval 항목), B는 여유 폭 없음·C는 넓은 폭 표시
## 정확성 장치 — 3절 반례별 통과/거부 + 변이 테스트 결과
## 저장·원자성 — 파일 실측 / Firestore 가짜 DB(대조군 포함)
## 응시 화면 — 세션 순서 타임라인 · 안전망 · gUM · 숨김 · 시계
## 비용 가드 — 키 없는 서버 경로별 501 · 스텁 요청 수 · 전사 prompt 필드 0
## 공개 저장소 오염 — 대조 기준 개수 · 적중 위치(파일:줄)·판정
## 미검증 — iPhone 목록 · 실호출 · 실제 Firestore · 실제 소리
```

회차마다 아래 항목의 상태를 먼저 다시 확인한다(2026-09-26 기준).

| 항목 | 위치 | 요지 | 상태·담당 |
|---|---|---|---|
| P2-A 무음 질문 안전망 | `lib/speech.ts` `speakQueue` `onEnd(reason, {sounded})` ↔ `lib/toeic-mock.ts` `toeicSpeechOutcome` ↔ `toeic-take-view.tsx` `playSpeech` | 1~2조각 질문이 전부 무음이어도 `"done"`이던 것 | 수정됨(`build_app-builder_toeic-m2-p2fix_report.md`) · QA 재검증 통과(`qa_report_toeic_m2_2.md`) — 이후엔 5절 반례를 회귀 가드로 쓴다 |
| P2-B gUM 상한 | `lib/mic-session.ts` `getUserMediaWithin`·상한 상수 4종, `toeic-take-view.tsx` `checkMic` | gUM 무응답 → `activeCaptures` 누수 → 세션이 play-and-record에 갇히던 것 | 수정됨(같은 리포트) · QA 재검증 통과(같은 QA 리포트) |
| 공유 모듈 변경의 파급 | `lib/speech.ts`(`SpeakQueueEndInfo` 추가) | 토익 수정이 공통 발음 모듈을 건드렸다 | `common` 검증을 함께 건다(`eval:speech` + 해설 낭독·운동 음성 안내 경로) |
| O1 두 탭 동시 채점 | 채점 라우트 | 전사·D 두 번 과금, 나중 쓰기가 이김 | 관찰 · 비용 민감하면 서버 합류 |
| O4 채점 60초 | 전사 30초 × 재시도 1 + D | 상한 초과 가능, 재시도로 회복 | 관찰 · 실호출 때 지연 분포 |

실패 한 건은 이 형식으로 적는다.

`- {제약} | 위치별 값 | {파일:함수} | 반례와 관측 | 수정 방법 | 담당: ai-engineer|app-builder|prompt-tuner | P1/P2`

틀린 점수·통계가 사용자에게 가는 경로(거짓 졸업, 지어낸 said, 오염된 스트릭)와 교재 원문 노출은 P1이다. 드문 이중 실패·실기기 조건에서만 나는 것은 P2로 두고 조건을 함께 적는다.

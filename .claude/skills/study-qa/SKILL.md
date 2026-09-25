---
name: study-qa
description: "qa-inspector 에이전트가 검증 작업을 수행할 때 로드하는 스킬(과목 공통 — english·math·japanese·common). 구현이 스펙과 일치하는지, 프롬프트↔JSON Schema↔zod↔eval 4중 정의와 프롬프트↔스펙(spec-sync)이 어긋나지 않는지, API↔프론트 경계면이 맞물리는지, 과목별 정확성 장치(영어 grounding 가드·수학 검산·일본어 토큰 무결성과 모드 분리)와 과목 공통 기능(클라우드 발음 폴백·학습 스트릭·해설 낭독·아빠의 운동 엔진)이 반례를 실제로 거부하는지 교차 검증하는 방법론·체크리스트·리포트 형식을 담는다. subject별 정합성 매트릭스는 references/english.md·math.md·japanese.md·common.md에 있다. 사용자의 검증·QA 요청 진입점은 study-orchestrator 스킬이다."
---

# Study QA — 통합 정합성 검증 (과목 공통)

**"존재 확인"이 아니라 "경계면 교차 비교"가 이 일의 본질이다.** 각 파일을 따로 보면 전부 올바른데 연결 지점에서 어긋나는 결함이 이 프로젝트에서 반복적으로 나왔다.

## 어느 references를 읽을 것인가

오케스트레이터가 지시한 subject의 파일 **하나만** 읽는다.

| subject | references | 핵심 검증 축 |
|---|---|---|
| `english` (북카드·단어장·챕터 리더) | `references/english.md` | 4중 정의 매트릭스, 카드 구조 개수·비율, grounding 가드, 단어장 병합·보강 |
| `math` (수학코치) | `references/math.md` | 답 정확성(심판 2겹), 장면 검산, iframe 격리 |
| `japanese` (아빠의 일본어) | `references/japanese.md` | 후리가나 토큰 무결성, 제외·포함·레벨 후처리, 시험 모드별 숙련도 분리, 대화 병합 |
| `common` (과목 공통 기능·아빠의 운동) | `references/common.md` | 발음 폴백·캐시 지문, 스트릭 KST·사람/트랙 분리, 해설 낭독 대본·큐, 운동 엔진·원자적 저장·`rev` |

아빠의 운동은 AI를 쓰지 않아 과목 하네스 밖이다(`docs/HARNESS.md` §0) — `common`으로 검증한다.

## 왜 4중 정의가 위험한가

같은 값이 **프롬프트 ↔ JSON Schema ↔ zod ↔ eval** 네 곳에 각각 산다. 한 곳만 고치면 나머지가 조용히 어긋나고, 그 어긋남은 대개 실호출을 해야 드러난다. 그래서 값 하나를 네 곳에서 동시에 대조하는 매트릭스를 만든다.

프롬프트 원문 ↔ 스펙 코드블록은 `scripts/spec-sync.ts`가 각 과목 eval의 오프라인 구간에서 바이트 단위로 대조한다(일본어는 JSON Schema까지 의미 동치로). **spec-sync가 통과했다고 4중 정의가 맞는 것은 아니다** — spec-sync는 문자열이 스펙과 같은지를 보고, 매트릭스는 그 문자열 안의 숫자가 zod·eval과 같은지를 본다. 둘 다 본다.

## 실측을 이겨라 — 이 프로젝트에서 실제로 나온 결함들

주장이 아니라 **실행**으로 확인하라. 아래는 정적 검사로는 안 잡혔던 것들이다.

| 결함 | 왜 정적으로 안 잡혔나 |
|---|---|
| 두 함수가 같은 입력에 다른 판단 → 호출이 확정 실패 | 각각은 타입이 맞았다. 두 함수를 같은 입력으로 **함께 실행**해야 드러난다 |
| 신규 데이터에서 배지가 사라짐(`===` 비교가 항상 false) | `tsc` 통과. 구·신 데이터를 **실제로 렌더**해야 보인다 |
| 상한이 API·UI 두 곳에 흩어져 UI가 먼저 잘라냄 | 두 숫자가 각각 유효했다. **관통 경로**를 따라가야 보인다 |
| `capture` 속성이 `multiple`을 무력화 | 브라우저·OS 동작이라 코드에 흔적이 없다. **실기기**에서만 드러난다 |
| 배치 병렬 호출 간 표기 불일치 | 스텁은 늘 같은 응답을 준다. **실물 산출물**을 사람이 읽어야 보인다 |
| 클라우드 TTS가 한자만인 일본어(`約束`·`学`)를 중국어로 읽음 | "모델이 텍스트로 언어를 판별한다"는 가정이 코드에 숨어 있었다. **실제로 들어야** 드러났다(`lib/tts.ts`의 언어 지시로 수정) |
| 폰 폭에서 스트릭 헤드라인의 💪 운동 트랙이 첫 화면 밖으로 밀림 | 데스크톱 폭에서는 멀쩡했다. **390px 실측**에서만 보였다(SPEC §17-7) |

여기서 나오는 원칙: **"규칙이 존재한다"가 아니라 "틀린 입력을 실제로 거부한다"를 확인하라.**

## 정확성 장치 — 반례를 넣어 확인한다

과목마다 "틀린 것이 사용자에게 가는 경로"가 다르다. 각 장치에 통과 케이스 1 + 반례 1을 넣는다. 전부 순수 함수·zod라 무비용이다.

| subject | 장치 | 넣어 볼 반례 |
|---|---|---|
| english | `groundChapters`·`isGroundedInTranscript` | 자막에 없는 en 문장 → 잘려 나가고 `droppedSentenceCount`가 오르는가 |
| english | `resolveAllowedStorySource` + 카드 zod | 근거를 안 줬는데 `storySource: "transcript"`를 주장 → 거부되는가 |
| math | 호출 C 독립성·`verifyScene`·`held` | 답 불일치 스텁, 한 칸 틀린 되감기 등식(상세는 `references/math.md`) |
| japanese | 토큰 무결성 zod | `surface`를 이으면 원문과 한 글자 다른 토큰 배열 → 거부되는가 |
| japanese | `applyVocabPostprocess` | 제외 목록 단어가 섞인 결과 → 걸러지는가, 단 include 단어는 남는가 |
| japanese | 모드별 집계(`aggregateJaStatsByMode`) | `kanji-to-kana` 오답이 `ko-to-word` 통계를 오염시키는가 |
| common | 스트릭 사람·트랙 분리 | 운동 날짜가 일본어 트랙에 섞이면 연속이 거짓으로 이어지는가 |
| common | 운동 `decideLog`·`decideUndo` | `expectedRev`가 낡은 요청 → `conflict`가 나는가 |

## 무비용 회귀 가드

| 명령 | 실호출 |
|---|---|
| `EVAL_OFFLINE_ONLY=1 npm run eval:english` / `eval:math` / `eval:japanese` | 0회 (게이트가 `globalThis.fetch`까지 막는다) |
| `npm run eval:speech` / `eval:streak` / `eval:workout` | 0회 (순수 함수만, store를 import하지 않는다) |

**eval 실호출 구간은 돌리지 않는다.** 오케스트레이터가 사용자 동의를 받아 실행한다.

## 경계면 체크리스트

- API 응답 shape ↔ 프론트가 읽는 필드 — 이름·타입·nullable을 **동시에 열어 비교**. 경계 타입은 `lib/*-contract.ts`에 있다
- 에러 code ↔ 상태코드 ↔ 프론트 분기 — 중간에서 끊기면 사용자는 무슨 일인지 모른다(키 없음 501, 판독 실패 200+폴백 신호, 운동 409)
- 상수의 정의처가 하나인가 — 같은 숫자가 두 곳에 있으면 그 자체가 결함
- 폴백 경로가 실제로 실행되는가 — 실패를 인위적으로 만들어 확인(키를 비운 dev 서버에서 🔊가 기기 음성으로 우는지)
- 하위 호환 — 기존 저장 데이터가 새 코드에서 정상 렌더되는가(정규화 헬퍼·`lib/*-record.ts` 판정)
- 키 노출 — `.next/static` grep으로 실제 키·프롬프트 원문 0건 확인

## 비용·안전 (이 프로젝트 특유)

- **OpenAI 실호출 금지.** 무비용 검증(`tsc`·`build`·`seed`·오프라인 eval·루프백 스텁·키 비운 dev 서버 렌더)만 한다.
- **화면 렌더도 비용이 난다.** 엔진이 클라우드인 언어의 화면은 마운트 시 `prefetchSpeech()`가 `/api/tts` 합성을 최대 `PREFETCH_MAX_ITEMS`(90)개 보낸다. 기본 엔진은 `lib/speech.ts` `DEFAULT_ENGINE`이 정한다 — 영어(en-US: 카드·챕터 리더·단어장·시험·오답노트)와 한국어(ko-KR: 해설 낭독의 해설 조각, 운동 세션 음성 안내)가 클라우드다. 운동은 `▶ 운동 시작` 탭에서 휴식 뒤 안내 문구 4개(휴식은 세트 사이에만 — 2~5세트 풀업)를 프리페치하고, 휴식이 끝날 때마다 `speakQueue`로 한 문장을 읽는다. 일본어(ja-JP)는 기본이 기기 음성이라 `prefetchSpeech`가 아무것도 보내지 않고, 사용자가 일본어 엔진을 클라우드로 바꿨을 때만 `/api/tts`를 부른다. 키를 비우면 501 → 기기 음성으로 떨어져 0원이 된다.
- **로컬 실행은 `STORE_BACKEND=file`을 명시한다.** 이 저장소는 로컬 실행이 프로덕션 Firestore를 향할 수 있었고, 실제로 그 경로로 데이터가 지워진 적이 있다(CLAUDE.md 서문). 삭제는 `lib/prod-guard.ts`가 막지만 **생성·수정은 여전히 통한다.** 운동 기록(append)도 prod-guard 대상이 아니다.
- 검증에 쓴 임시 데이터는 **원상 복구하고 잔존 0건을 확인**한다. 접두사 기반 정리는 UUID를 쓴 잔존물을 놓친다 — 개수로도 대조하라.
- **코드를 고치지 마라.** 검증·보고만 한다. 수정은 담당 에이전트가 한다.

## 리포트 형식

`_workspace/qa_report_{subject}_{tag}_{n}.md` — subject는 `english|math|japanese|common`, tag는 기능 이름(없으면 생략), n은 회차.

```
# QA 리포트 {n} — {subject} · {검증 범위}
## 요약: 통과 X / 실패 Y / 미검증 Z
## 정합성 매트릭스 (subject별 references 기준)
## 항목별 pass/fail 표 — 각 실패에 담당(에이전트: ai-engineer·app-builder·prompt-tuner(프롬프트 준수)·math-verifier·player-builder)과 P1/P2
## 실측 방법 — 무엇을 어떻게 실행해 확인했나
## 미검증 항목과 그 이유
## 배포 가부 (가능/보류) + 근거 한 줄
```

**실패마다 담당과 우선순위를 명시한다.** 오케스트레이터가 그것으로 수정 루프를 돌린다. 배포 가부는 마지막에 한 줄로 못 박는다 — "P1이 하나라도 있으면 보류"가 기본이다.

**검증하지 않은 것을 검증했다고 쓰지 마라.** 발음·재생·폰 레이아웃처럼 실기기에서만 드러나는 것은 "실기기 미검증"으로 남기는 편이 훨씬 낫다.

## 실호출을 금지받았다면 — 지시가 아니라 명령으로 막아라

`.env`에 실제 `OPENAI_API_KEY`가 있다. **"실호출 금지"라고 들어도 로컬 서버를 그냥 띄우면 실호출이 난다.**
2026-08-17 하루에 두 번 이 사고가 났다(에이전트가 dev/prod 서버를 띄우다 각각 3회·4회).

**모든 로컬 실행 명령 앞에 키와 GCP 신호를 비워라:**

```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm run dev
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npx tsx scripts/eval-japanese.ts
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm start
```

키가 비면 AI 라우트와 `/api/tts`가 501로 명시적으로 거절하므로 **실호출이 구조적으로 불가능**해진다. `STORE_BACKEND=file`을 명시하면 스토어 자동 감지가 꺼지고, GCP 자격증명 신호까지 비우면 설정이 어긋나도 프로덕션 Firestore를 잡을 단서가 없다.
AI 응답 자체가 필요하면 루프백 스텁을 쓴다:

```bash
OPENAI_BASE_URL=http://127.0.0.1:<포트> STORE_BACKEND=file npx tsx <스크립트>
```

**"키 없는 드라이런"을 눈으로 확인했다고 믿지 마라** — `.env`가 자동 로드돼 조용히 실호출이 난 전례가 있다.
게이트(`EVAL_OFFLINE_ONLY=1` 등)를 쓸 때는 **그 게이트가 네트워크 호출부보다 앞서 return하는지 코드로 먼저 확인**하라.

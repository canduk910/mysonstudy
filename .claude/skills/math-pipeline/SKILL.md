---
name: math-pipeline
description: "math-verifier 에이전트가 수학 정확성 파이프라인을 구현·수정할 때 로드하는 스킬. 호출 C(독립 검산) 프롬프트·스키마, lib/scene/verify.ts의 장면 숫자 검산 8규칙, lib/ai/math/pipeline.ts의 explainProblem 흐름(B→C→검산→1회 재시도→ok/held 판정), 답 비교 정규화 규칙을 담는다. 사용자의 수학 기능 요청 진입점은 study-orchestrator 스킬이다."
---

# 수학 정확성 파이프라인 — 심판 둘을 붙이는 법

수학은 정답이 있는 세계라, **틀린 답을 자신 있게 보여주는 것이 최악의 실패**다. 아이가 그걸 그대로 배운다. 그래서 심판을 둘 둔다.

| 심판 | 정체 | 무엇을 잡나 |
|---|---|---|
| **1. 호출 C** | 문제를 독립적으로 다시 푸는 AI | 답 자체가 틀린 경우 |
| **2. `verifyScene`** | 장면 JSON의 숫자를 앱이 더하고 빼 보는 순수 함수 | 답은 맞는데 그림 대본이 어긋난 경우 |

원문 스펙은 `docs/harness/math.md` §4·§5다. 이 스킬은 **왜 그렇게 설계됐는지**와 흔한 함정을 담는다.

## 호출 C — 심판에게 답안지를 보여주지 마라

C의 사용자 메시지는 문제 문장과 그림 설명뿐이다. **B의 답은 절대 넘기지 않는다.**

이유가 전부다: 심판이 선수 답안지를 먼저 보면 그 답에 끌려간다(anchoring). 두 번째 의견이 첫 번째의 복사본이 되면 심판이 둘이 아니라 하나다. 코드에서 C의 입력을 조립하는 지점에 이 이유를 주석으로 남겨라 — 나중에 "컨텍스트를 더 주면 정확해지지 않나?"라는 선의의 수정이 들어온다.

C는 `temperature: 0`, 출력 한도 ~800, 모델은 `OPENAI_MODEL_VERIFY`(없으면 `OPENAI_MODEL`). 별도 env를 둔 이유는 **심판만 더 강한 모델로 올릴 여지**를 남기기 위해서다.

## 답 비교 — 정규화 규칙

`compare(a, b)`는 라벨을 정규화한 뒤 값을 비교한다.

- 라벨: 공백·조사(은/는/이/가/의) 제거 후 비교. `"가 통"`과 `"가통"`, `"승환이"`와 `"승환"`이 같아야 한다.
- 값: 소수는 `1e-6` 허용 오차. 정수 비교에 부동소수 함정이 끼지 않게 한다.
- 개수가 다르면 불일치. 라벨이 하나라도 매칭되지 않으면 불일치.

**정규화를 너무 관대하게 만들지 마라.** 서로 다른 대상을 같다고 판정하면 심판이 무력해진다. 애매하면 불일치로 두고 `held`로 보내는 편이 안전하다.

## `verifyScene` — 계산기로 다시 두드리기

`verifyScene(scene, answer): string[]` — 빈 배열이면 통과, 아니면 실패 사유 문자열들.

8규칙의 전문은 `docs/harness/math.md` §4에 있다. 구현에서 지킬 것:

- **순수 함수로 유지한다.** AI 호출·네트워크·파일 접근 금지. 코드 검산이 불확실해지면 심판이 하나로 준다.
- **되감기 검산이 핵심이다**(규칙 4). `values[from] === prev[from] + amt`, `values[to] === prev[to] − amt`, 나머지는 불변. 이 등식이 AI가 지어낸 대본을 실제로 걸러낸다.
- **`start` 단계는 `answer`와 완전히 일치**해야 한다(규칙 5). 되감기의 종착점이 곧 답이므로, 여기가 어긋나면 그림과 답이 다른 이야기를 한다.
- 실패 사유는 **사람이 읽고 고칠 수 있게** 쓴다. `"rewind step 3: values[1] expected 12, got 15"`처럼 어느 단계·어느 인덱스·기대값·실제값을 담는다. 재시도 프롬프트에 그대로 실린다.

## 파이프라인 — `explainProblem()`

```
b = callB(problem);  c = callC(problem)
answerMatch = compare(b.answer, c.answer)
sceneErrors = b.scene ? verifyScene(b.scene, b.answer) : []

불일치거나 장면 오류면 → 1회만 재시도
  b = callB(problem, retryNote = 불일치 내용 + sceneErrors)
  c2 = callC(problem)                       # 검산도 새로
  answerMatch = compare(b.answer, c2.answer) && compare(c.answer, c2.answer)

status = answerMatch ? 'ok' : 'held'
if (sceneErrors.length) b.scene = null      # 장면만 버리고 텍스트는 살린다
if (b.confidence === 'low') status = 'held' # AI 스스로 자신 없으면 보류
```

설계 의도 셋:

**재시도는 1회.** 실호출 비용이 곱으로 늘고, 두 번 실패한 문제는 세 번째도 대개 실패한다. 재시도 시 검산도 새로 하는 이유는 "같은 답을 두 번 독립적으로 확인"하기 위해서다 — `compare(c.answer, c2.answer)`가 조건에 들어간 것이 그 뜻이다.

**장면 실패는 장면만 버린다.** 그림이 틀렸다고 3막 설명까지 잃을 이유가 없다. 텍스트는 그대로 보여주고 그림 자리만 비운다.

**`held`는 실패가 아니라 정직한 보류다.** 화면에는 "엄빠가 한 번 확인해 주세요" 배지와 텍스트 설명을 보여주고 답은 접어 둔다. 보류율이 올라가는 것보다 틀린 답이 통과하는 것이 훨씬 나쁘다. `held`를 줄이려고 검산을 느슨하게 만들자는 요청이 오면, 그 완화가 **어떤 틀린 답을 통과시키는지** 먼저 따져 답하라.

## 비용

문제 1개 = B + C, 재시도 시 ×2 → **호출 2~4회**. 페이지에 문제 6개면 최대 24회다. 판독 확인 화면에서 사용자가 **설명 만들 문제를 고르게** 한 것이 비용 안전장치이므로, 그 화면을 우회해 전체 문제를 자동 처리하는 흐름을 만들지 마라.

## 로깅

`held` 비율을 남긴다. **특정 유형에서 `held`가 잦으면 그 유형 프롬프트를 손볼 신호**다 — 파이프라인이 품질 계측기 역할을 겸한다. `{problemPattern, status, attempts}`를 함께 기록해야 이 분석이 가능하다.

## 작업 규칙

- **OpenAI 실호출은 오케스트레이터 승인 후에만.** 무비용 검증은 순수 함수 단위 테스트와 루프백 스텁(`OPENAI_BASE_URL`을 로컬 서버로 고정)으로 한다.
- 로컬 실행 시 `STORE_BACKEND=file`을 명시한다 — 이 저장소는 로컬 실행이 프로덕션 Firestore를 향할 수 있다(CLAUDE.md 서문).
- `Scene` 타입은 ai-engineer·player-builder와 공유한다. 바꾸면 통보한다.
- git commit·push는 사용자 승인 후 오케스트레이터가 한다.

## 실호출을 금지받았다면 — 지시가 아니라 명령으로 막아라

`.env`에 실제 `OPENAI_API_KEY`가 있다. **"실호출 금지"라고 들어도 로컬 서버를 그냥 띄우면 실호출이 난다.**
2026-08-17 하루에 두 번 이 사고가 났다(에이전트가 dev/prod 서버를 띄우다 각각 3회·4회).

**모든 로컬 실행 명령 앞에 키를 비워라:**

```bash
OPENAI_API_KEY= STORE_BACKEND=file npm run dev
OPENAI_API_KEY= STORE_BACKEND=file npx tsx scripts/....ts
OPENAI_API_KEY= STORE_BACKEND=file npm start
```

키가 비면 라우트가 501로 명시적으로 거절하므로 **실호출이 구조적으로 불가능**해진다.
AI 응답 자체가 필요하면 루프백 스텁을 쓴다:

```bash
OPENAI_BASE_URL=http://127.0.0.1:<포트> STORE_BACKEND=file npx tsx <스크립트>
```

**"키 없는 드라이런"을 눈으로 확인했다고 믿지 마라** — `.env`가 자동 로드돼 조용히 실호출이 난 전례가 있다.
게이트(`EVAL_OFFLINE_ONLY=1` 등)를 쓸 때는 **그 게이트가 네트워크 호출부보다 앞서 return하는지 코드로 먼저 확인**하라.

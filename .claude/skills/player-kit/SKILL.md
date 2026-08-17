---
name: player-kit
description: "player-builder 에이전트가 되감기 플레이어(2단 그림)를 구현·수정할 때 로드하는 스킬. public/player-kit의 kit.css·kit.js 계약, 호출 E(플레이어 HTML 생성) 프롬프트와 few-shot, lib/scene/html.ts의 정적 검사·답 태그 대조·iframe 격리(sandbox·CSP)·ready 타임아웃 폴백을 담는다. 사용자의 수학 기능 요청 진입점은 study-orchestrator 스킬이다."
---

# 되감기 플레이어 · iframe 키트 — AI가 짠 HTML을 안전하게 재생하기

그림은 3단으로 떨어진다.

| 단 | 방식 | 검산 | 언제 |
|---|---|---|---|
| **1단** | 전용 그림 JSON (`Scene`) | 앱이 숫자를 직접 검산 (엄격) | containers·bar·numberline로 자연스러운 문제 |
| **2단** | AI가 짠 HTML, 키트 위에서 | 정적 검사 + 답 태그 대조 (느슨) | 도형·규칙 찾기·표·시간 |
| **3단** | 텍스트 3막만 | — | 위 둘 다 실패 |

이 스킬은 **2단**을 다룬다.

## 왜 키트를 두는가

2단은 **우리 집 부엌을 빌려주고 요리사만 부르는 것**이다. 부엌·칼·접시(`kit.css`·`kit.js`)는 우리 것이라 결과물이 늘 우리 집 스타일이고, 요리사(AI)는 매번 새 요리(장면 로직)만 한다.

여기서 나오는 운영 원칙 하나: **키트가 두꺼울수록 AI가 지어낼 여지가 줄고 결과가 안정된다.** HTML로 자주 그려지는 유형이 보이면 그 유형의 전용 렌더러(1단)를 추가하는 것이 최종 목표다 — 검산이 엄격해지고 빨라진다. 처음부터 다 만들지 말고 은우 문제집이 알려주는 대로 키운다.

## 키트 계약 — `public/player-kit/`

| 파일 | 담는 것 |
|---|---|
| `kit.css` | 디자인 토큰 CSS 변수(`--ink --water --coin --rewind --ok --sub --line`), 카드·캡션·VCR 바·규칙 카드 스타일, `prefers-reduced-motion` |
| `kit.js` | 전역 `Kit` — `mount(steps)` · `tween(el, attrs, ms)` · `fly(fromEl, toEl, label, cls)` · `tank/coins/bar/numberline/scale/grid/shape` · `countUp(el, from, to)` · `done()` |
| 보고 채널 | `parent.postMessage({type:'ready'|'error'|'step', ...})` |

**키트 API를 바꾸면 E 프롬프트의 [내용] 절과 few-shot HTML을 같은 커밋에서 함께 고친다.** 하나만 고치면 AI가 없는 함수를 부르고, 그 실패는 런타임에만 드러난다. 또한 이미 저장된 `sceneHtml`이 옛 API를 부르고 있을 수 있으므로 **키트 변경은 breaking change로 취급**한다.

## 호출 E — 무엇을 강제하는가

원문 프롬프트는 `docs/harness/math.md` §3-4. 프롬프트가 강제하는 것과 그 이유:

- **`<html><head><body>` 태그 금지, `<body>` 안 조각만** — `srcdoc`으로 조립하므로 문서 뼈대는 우리가 만든다.
- **외부 자원 전면 금지**(`<link>`·CDN·`fetch`·`XHR`·WebSocket) — 격리를 뚫는 통로를 애초에 없앤다.
- **색은 CSS 변수만, 임의 hex 금지** — 이걸 풀면 카드마다 색이 달라져 "우리 집 스타일"이 깨진다.
- **`Kit.mount(steps)` + 각 step의 `render()`** — 되돌아가기(이전)가 동작해야 하므로 상태를 렌더 함수로 재구성 가능하게 만든다.
- **답을 `<script type="application/json" id="answer">`로 본문에 넣기** — 앱이 대조할 유일한 접점이다.
- **3~8단계, 폭 360px, 애니메이션 0.6~0.9초** — 모바일에서 아이가 보는 물건이다.

few-shot 예시 1개(도형 넓이 문제의 완성 HTML)를 `lib/ai/math/prompts.ts`에 상수로 둔다. **few-shot은 프롬프트 문장보다 강하게 작동한다** — 스타일을 바꾸고 싶으면 문장보다 예시를 먼저 고쳐라.

## 앱 측 처리 — `lib/scene/html.ts`

```
1. 정적 검사 → 걸리면 재생성 1회
2. answer 태그 파싱 → B의 answer와 값 비교(라벨 정규화) → 불일치면 재생성 1회
3. iframe srcdoc = kit.css + kit.js + html
   sandbox="allow-scripts"        ← allow-same-origin 금지
   CSP meta: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
4. 3초 안에 'ready' 없거나 'error' → 플레이어 숨기고 텍스트 3막만 (사유 로그)
5. 성공한 html은 저장. 재생성 시 덮어쓰지 않고 새 문서
```

### 순서를 뒤집지 마라

**격리(iframe+CSP)가 1차 방어, 정적 검사는 2차다.** 정적 검사는 차단 목록이라 통과했다고 안전한 HTML이 되는 것이 아니다 — 목록에 없는 새로운 수법은 늘 있다. 격리가 진짜 방어선이고, 목록은 "명백한 것을 일찍 걸러 재생성 기회를 주는" 역할이다.

`sandbox="allow-scripts"`에서 **`allow-same-origin`을 빼는 것이 핵심**이다. 둘을 같이 주면 샌드박스가 사실상 해제되어 부모 문서에 접근할 수 있다. 이 조합을 바꾸라는 요청은 근거를 따져 묻는다.

### 답 태그 대조가 마지막 그물이다

정적 검사는 "그림이 맞는지"까지 보지 못한다. 답의 정확성은 심판 1(호출 C)이 보증하고, **그림이 그 답과 다른 이야기를 하는 것**을 막는 최소 안전선이 답 태그 대조다. 라벨 정규화 규칙은 `math-pipeline` 스킬의 `compare()`와 같은 것을 쓴다 — 두 곳에 따로 만들면 어긋난다.

### 깨진 그림보다 없는 편이 낫다

3초 타임아웃에 걸리면 조용히 텍스트로 떨어뜨린다. 아이에게 반쯤 그려진 화면을 보여주는 것보다 낫고, 사유 로그가 남으므로 나중에 그 유형을 1단 렌더러로 승격할 근거가 된다.

## 비용

E는 출력 한도 ~8,000이라 **문제당 토큰이 크다.** 1단이 되는 문제는 절대 E로 가지 않게 B 프롬프트의 '1단 우선' 규칙을 지키고, **E 호출 수를 로그로 본다.** E 비율이 오르면 1단 렌더러를 추가할 신호다.

## 새 전용 렌더러를 추가할 때 (1단 승격)

① 픽스처 1문제 추가 → ② 렌더러 `kind` + 검산 규칙 추가(math-verifier와 함께) → ③ B 프롬프트의 1단 목록에 그 kind 규칙 몇 줄 추가 → ④ `npm run eval:math` 통과.

이 순서를 지키는 이유: 픽스처가 먼저 있어야 승격이 실제로 나아졌는지 잴 수 있다.

## 작업 규칙

- **OpenAI 실호출은 오케스트레이터 승인 후에만.** 무비용 검증은 저장된 HTML 샘플로 정적 검사·답 대조·iframe 로딩을 확인한다.
- headless 검증(playwright)이 환경에 없으면 그 사실을 리포트에 명시한다. **검증하지 않은 것을 검증했다고 쓰지 않는다.**
- 로컬 실행 시 `STORE_BACKEND=file`을 명시한다(CLAUDE.md 서문).
- git commit·push는 사용자 승인 후 오케스트레이터가 한다.

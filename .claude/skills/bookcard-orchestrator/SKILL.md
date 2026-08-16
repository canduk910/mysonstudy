---
name: bookcard-orchestrator
description: "은우 북카드(영어 원서 학습 카드 앱) 개발 에이전트 팀 오케스트레이터. 앱·기능 구현, AI 모듈(lib/ai) 구축, API 라우트·UI 작업, 프롬프트 튜닝, 카드 품질 조정, eval 실행, QA·정합성 검증 요청 시 반드시 이 스킬을 사용. 표지 판독·사진 인식·업로드 등 동작 문제와 버그 신고('책 찍었는데 안 읽혀', '카드가 안 나와', '에러 난다'), 아이 반응·품질 피드백('은우가 어려워해', '카드가 너무 어려워/쉬워', '카드가 좀 별로야'), 후속 작업(다시 실행, 재실행, 업데이트, 수정, 보완, 부분만 다시, 이전 결과 개선)도 모두 이 스킬로 처리한다. docs/HARNESS.md 내용에 대한 단순 질문은 직접 응답 가능."
---

# Bookcard Orchestrator

은우 북카드 개발 에이전트 팀을 조율하는 오케스트레이터. `docs/HARNESS.md`가 모든 AI 관련 구현의 단일 진실 원천이다.

## 실행 모드: 하이브리드

| 워크플로우 | 모드 | 이유 |
|-----------|------|------|
| A. 빌드 | 서브 에이전트 파이프라인 + SendMessage 피드백 | 단계 간 순차 의존이 강함. QA↔구현자 피드백은 SendMessage로 충분 |
| B. 튜닝 | 서브 에이전트 단독 | card-tuner 1명이면 충분 |
| C. QA | 서브 에이전트 단독 | 독립 검증이 목적 |

> TeamCreate를 지원하는 환경이라면 빌드를 에이전트 팀(ai-engineer·app-builder·qa-inspector + 공유 작업 목록)으로 구성해도 된다. 지원하지 않는 환경에서는 아래 파이프라인이 기본이다.

## 에이전트 구성

| 에이전트 | subagent_type | model | 역할 | 스킬 | 출력 |
|---------|--------------|-------|------|------|------|
| ai-engineer | ai-engineer | opus | lib/ai/ 3파일 + eval 스크립트 구현 | ai-harness-impl | `_workspace/build_ai-engineer_report.md` |
| app-builder | app-builder | opus | 라우트·Google Books·UI | ai-harness-impl (라우트 연결) | `_workspace/build_app-builder_report.md` |
| qa-inspector | qa-inspector | opus | 통합 정합성 검증 | bookcard-qa | `_workspace/qa_report_{n}.md` |
| card-tuner | card-tuner | opus | 프롬프트 다이얼 튜닝 + eval | card-eval | `_workspace/tune_report_{n}.md` |

모든 Agent 호출에 `model: "opus"`를 명시한다.

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `docs/HARNESS.md`(AI 스펙)·`docs/SPEC.md`(앱 스펙) 존재 확인. 없으면 **작업을 중단**하고 사용자에게 스펙 문서를 요청한다. 스펙 없이 임의 구현하지 않는다.
2. `_workspace/` 존재 여부로 실행 모드 결정:
   - 미존재 → **초기 실행**: `_workspace/` 생성 후 진행
   - 존재 + 부분 수정 요청 → **부분 재실행**: 해당 에이전트만 재호출. 프롬프트에 이전 산출물·QA 리포트 경로를 포함해 기존 결과를 읽고 개선하게 한다
   - 존재 + 새 입력/전면 재작업 → **새 실행**: 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 초기 실행
3. 요청 분류:

| 요청 유형 | 예 | 진입 |
|----------|----|------|
| 빌드 | "스펙대로 구현해줘", "카드 API 만들어줘", "UI 붙여줘" | A |
| 튜닝 | "단어 10개로 줄여", "질문 더 쉽게", "hintKo 늘려", "eval 돌려" | B |
| QA | "검증해줘", "정합성 점검", "스펙대로 됐는지 확인" | C |
| 혼합 | "구현하고 검증까지" | A (QA 포함) |

### 워크플로우 A: 빌드 (파이프라인 + incremental QA)

**실행 모드:** 서브 에이전트 파이프라인

1. **ai-engineer** 호출 (`subagent_type: "ai-engineer"`, `model: "opus"`) — 지시: "package.json이 없으면 먼저 Next.js(TypeScript) 프로젝트를 스캐폴딩하고 openai·zod·tsx를 설치하라. 그 다음 docs/HARNESS.md 스펙대로 lib/ai/client.ts·prompts.ts·schemas.ts와 scripts/eval-cards.ts를 구현하라. 완료 후 `_workspace/build_ai-engineer_report.md` 작성."
2. **qa-inspector** 호출 — lib/ai/ 완성 **직후 즉시** 검증(incremental QA). 정합성 매트릭스 + 스펙 준수 체크리스트만 수행.
3. QA 실패 항목이 있으면 수정 루프:
   - ai-engineer가 아직 응답 가능하면 SendMessage로 수정 요청 전달, 아니면 새로 호출하되 QA 리포트 경로를 프롬프트에 포함.
   - 수정 → qa-inspector 재검증. **루프는 최대 2회.** 초과 시 남은 이슈를 최종 보고에 명시하고 진행.
4. **app-builder** 호출 — 지시: "lib/ai/의 export를 사용해 /api/extract·/api/card 라우트, Google Books(+Open Library 폴백) 연동, 업로드→판독 확인→카드 UI를 docs/SPEC.md §4·§8·§9대로 구현하라 (디자인 원본 design/영어책_학습카드_샘플.html). `_workspace/build_app-builder_report.md` 작성."
5. **qa-inspector** 재호출 — 경계면 체크리스트(API↔프론트, 폴백 관통, 키 노출)까지 전체 수행. 실패 시 QA 리포트의 담당 표기에 따라 해당 에이전트(ai-engineer 또는 app-builder)에게 3과 같은 방식으로 수정 루프 (최대 2회).
6. eval 실행 판단: `OPENAI_API_KEY`가 있으면 사용자에게 실호출 2회 비용을 알리고 동의 받은 뒤 **오케스트레이터가 직접 Bash로** `npm run eval:cards` 실행. 실패 시 에러 핸들링 표의 "eval 반복 실패" 항목대로 처리. 키가 없으면 건너뛰고 보고서에 "eval 미실행(키 없음)" 명시.
7. 최종 보고: 산출 파일 목록 / QA 결과 요약 / 각 리포트의 "스펙 공백" 취합 / eval 결과.

### 워크플로우 B: 튜닝

**실행 모드:** 서브 에이전트 단독

0. `lib/ai/prompts.ts`가 없으면 튜닝 불가 — 빌드(워크플로우 A) 선행이 필요함을 사용자에게 안내하고 중단한다.
1. **card-tuner** 호출 (`model: "opus"`) — 프롬프트에 사용자 피드백 **원문**과 이전 `_workspace/tune_report_*.md` 경로를 포함.
2. card-tuner는 card-eval 스킬의 다이얼 동기화 표대로 prompts.ts·zod·eval을 함께 수정하고, 키가 있으면 eval 실행 후 리포트 작성.
3. eval 실패 시 card-tuner가 1회 재조정. 재실패 시 실패 사례·분석을 사용자에게 보고하고 판단을 기다린다.

### 워크플로우 C: QA 단독

**실행 모드:** 서브 에이전트 단독

1. **qa-inspector** 호출 — bookcard-qa 체크리스트 전체 수행, `_workspace/qa_report_{n}.md` 작성.
2. 발견 이슈는 보고만 한다. 수정은 사용자 확인 후 워크플로우 A 부분 재실행으로.

## 데이터 전달

- 산출물은 파일 기반: 빌드 리포트 `_workspace/build_{agent}_report.md`, QA 리포트 `_workspace/qa_report_{n}.md`, 튜닝 리포트 `_workspace/tune_report_{n}.md`. 중간 산출물은 삭제하지 않는다 (사후 검증·감사 추적용).
- 에이전트 반환값: 리포트 파일 경로 + 3줄 요약.
- 실시간 피드백: SendMessage (QA 수정 요청 등).
- Phase 간 의존: A-4는 A-1의 lib/ai/ export에, A-5는 A-4의 응답 shape 정의(빌드 리포트)에 의존한다.

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 에이전트 1명 실패 | 1회 재시도. 재실패 시 분기: 후속 단계가 의존하는 산출물(예: ai-engineer의 lib/ai/)이면 워크플로우를 중단하고 사용자에게 보고, 하류 의존이 없는 산출물이면 누락을 최종 보고에 명시하고 진행 |
| QA 수정 루프 2회 초과 | 루프 중단, 남은 이슈를 사용자에게 보고 |
| OPENAI_API_KEY 없음 | eval·실호출 단계 건너뛰고 정적 검증만. 보고서에 명시 |
| eval 반복 실패 | 실패 항목·사례·원인 분석을 보고하고 사용자 판단 대기 (실호출 비용 — 무한 재시도 금지) |
| docs/HARNESS.md 부재·내부 모순 | 작업 중단, 사용자 질의 (임의 해석 금지) |

## 테스트 시나리오

### 정상 흐름 (빌드)
1. 사용자: "docs/HARNESS.md대로 AI 모듈 구현해줘"
2. Phase 0: 스펙 존재 확인, `_workspace/` 없음 → 초기 실행, 분류=빌드
3. ai-engineer가 lib/ai/ 3파일 + eval 스크립트 구현 → 리포트 작성
4. qa-inspector가 정합성 매트릭스 검증 → 통과
5. 키 없음 → eval 건너뜀
6. 최종 보고: 파일 목록 + QA 통과 + "eval 미실행(키 없음)"

### 에러 흐름 (QA 실패 루프)
1. qa-inspector가 "zod 사이트워드 목록과 eval 목록이 별도 정의됨" 발견 (실패 판정)
2. ai-engineer 재호출(QA 리포트 경로 첨부) → schemas.ts 공유 상수로 수정
3. qa-inspector 재검증 → 통과 → 다음 단계 진행
4. 만약 2회 루프에도 실패했다면: 루프 중단, 최종 보고에 미해결 이슈와 원인 분석 명시

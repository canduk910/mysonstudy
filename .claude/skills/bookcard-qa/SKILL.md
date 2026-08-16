---
name: bookcard-qa
description: "qa-inspector 에이전트가 검증 작업을 수행할 때 로드하는 스킬. 구현이 docs/HARNESS.md 스펙과 일치하는지, 프롬프트↔JSON Schema↔zod↔eval 4중 정의가 어긋나지 않는지, API↔프론트 경계면이 맞물리는지 교차 검증하는 정합성 매트릭스·체크리스트·리포트 형식을 담는다. 사용자의 검증·QA 요청 진입점은 bookcard-orchestrator 스킬이다."
---

# Bookcard QA — 통합 정합성 검증

존재 확인이 아니라 **교차 비교**가 QA다. 각 파일이 따로 보면 전부 올바른데 연결 지점에서 어긋나는 결함이 이 프로젝트의 주 위험이다. 경계면 검증은 반드시 양쪽 코드를 동시에 열어 비교한다.

## 왜 4중 정의가 위험한가

같은 제약이 최대 4곳에 중복 정의된다: 프롬프트 문구(prompts.ts) · JSON Schema(schemas.ts) · zod 검증(schemas.ts) · eval 체크(eval-cards.ts). 한 곳만 수정되면 "eval은 통과하는데 런타임 검증이 실패"하거나 그 반대가 된다. 아래 매트릭스의 각 행에 대해 정의된 모든 위치의 **값**을 대조한다.

## 정합성 매트릭스

"✔"는 그 위치에 정의가 있어야 하고 값이 일치해야 한다는 뜻. "—"는 그 위치에 정의가 **없어야 정상**이라는 뜻이다 — 특히 JSON Schema에 minItems/maxItems가 들어가 있으면 그 자체로 스펙 위반(§1 공통 규칙).

| 제약 | 프롬프트 | JSON Schema | zod | eval |
|------|---------|-------------|-----|------|
| vocab 개수 (AR<2→10, 그 외→12) | ✔ §3-1 | — | ✔ | ✔ |
| vocab word 소문자 중복 금지 | (서술 없음) | — | ✔ | ✔ (zod 경유) |
| 사이트워드 차단 목록 | 서술만 | — | ✔ 공유 상수 | ✔ **같은 상수** |
| challenge 2~3개 | ✔ §3-1 | enum만 | (선택) | (선택) |
| isCore true 정확히 1개 | ✔ §3-1 | nullable bool | ✔ | ✔ |
| questions 개수 (AR<2→6, 그 외→8) | ✔ §3-1 | — | ✔ | ✔ |
| 질문 유형 중복 금지 / enum 12종 | ✔ §3-1 | ✔ enum | ✔ | ✔ |
| 픽션→funFacts null, 논픽션→4개 | ✔ §3-1 | nullable array | ✔ | ✔ |
| beforeReading 2 / whileReading 3 / activities 2 | ✔ §3-1 | — | ✔ | ✔ |
| 질문 en 15단어 이하 | ✔ §3-1 | — | — | ✔ |
| exampleEn 4~8단어 | ✔ §3-1 | — | — | ✔ (8단어 이하) |
| hintKo 보유율 30~70% | ✔ "절반 정도" | — | — | ✔ |

**사이트워드 특칙:** zod와 eval이 각자 목록 리터럴을 갖고 있으면 값이 지금 같더라도 **실패로 판정**한다. 반드시 schemas.ts 한 곳에서 export하고 양쪽이 import해야 한다. 이유: 두 목록은 반드시 언젠가 어긋난다.

## 스펙 준수 체크리스트

- [ ] 프롬프트 원문이 docs/HARNESS.md §2-1·§3-1과 문자 단위로 일치 — 눈으로 보지 말고 스펙에서 추출해 diff로 확인
- [ ] JSON Schema가 §2-3·§3-3과 일치: 전 필드 required, 모든 객체 additionalProperties:false, minItems/maxItems 부재
- [ ] temperature·출력 한도가 §1 표와 일치 (A: 0/~1,000 · B: 0.7/~6,000)
- [ ] 모델 ID가 env `OPENAI_MODEL`에서만 옴 — `grep -r "gpt-" lib/ scripts/ app/`로 하드코딩 검출
- [ ] 재시도 정확히 1회, 재실패 시 throw (§4)
- [ ] 로깅 shape `{ call, model, inputTokens, outputTokens, ms }`, 성공/실패 무관 기록
- [ ] eval-cards.ts: 픽스처가 card-eval 스킬 정의와 일치, 항목별 pass/fail 표 출력, 실패 시 exit code 1
- [ ] package.json에 `"eval:cards": "tsx scripts/eval-cards.ts"`

## 경계면 체크리스트 (앱 연결 후)

- [ ] API 응답 shape ↔ 프론트 호출부 기대 타입 — route.ts의 `NextResponse.json()` 인자와 프론트 fetch 소비 코드를 **같이 열어** 필드명·래핑 여부 비교
- [ ] 판독 실패 폴백이 관통하는가: `isBookCover=false`/`title=null` → 라우트 폴백 신호 → UI "다시 찍어주세요" + 수동 입력 폼 (§2-4)
- [ ] AI 호출이 서버 밖에 없음 — 클라이언트 번들 대상 코드에서 `openai` import·`OPENAI_API_KEY` 참조 grep
- [ ] 판독 결과 → Google Books 검색어 → 카드 생성 입력(§3-2)의 필드 매핑이 일관 (topicGuess→topic 등 이름 변환 지점 주의)
- [ ] href/router.push 경로가 실제 page 파일과 매칭 (route group의 URL 접두사 주의)

## 리포트 형식

`_workspace/qa_report_{n}.md` (n은 회차):

```
# QA 리포트 {n} — {검증 범위}
## 요약: 통과 X / 실패 Y / 미검증 Z
## 실패 항목
- {제약} | 위치별 값: prompts=…, zod=…, eval=… | {파일:라인} | 수정 방법: … | 담당: ai-engineer|app-builder
## 미검증 항목과 사유
```

- 발견 이슈는 직접 수정하지 않는다. 파일:라인 + 수정 방법 + 담당자를 리포트에 담아 반환한다.
- 검증 불가 항목(파일 미존재, 키 없음)은 실패가 아니라 "미검증 + 사유"로 분류한다. 검증 못 한 것을 통과로 표기하지 않는다.

## 실행 시점

전체 완성 후 1회가 아니라 **각 모듈 완성 직후** 실행한다 (incremental QA). lib/ai/ 직후에는 매트릭스 + 스펙 준수 체크리스트만, 앱 연결 후에는 경계면 체크리스트까지 전체.

# mysonstudy — 은우 북카드

아이(은우)와 영어 원서를 함께 읽는 부모를 위한 학습 카드 생성 앱. 표지 사진 → AI 판독 → Google Books 보강 → 학습 카드 → 서재. 앱 전체 명세는 `docs/SPEC.md`, AI 호출 상세는 `docs/HARNESS.md`, 디자인 원본은 `design/영어책_학습카드_샘플.html`.

## 하네스: 은우 북카드 개발팀

**목표:** docs/HARNESS.md 스펙대로 앱을 구현하고, 카드 품질(프롬프트)을 eval 기반으로 안전하게 튜닝한다.

**트리거:** 북카드 앱 구현·수정, AI 모듈(lib/ai), 프롬프트 튜닝, eval 실행, QA·정합성 검증 등 이 프로젝트의 개발 작업 요청 시 `bookcard-orchestrator` 스킬을 사용하라. 스펙 내용에 대한 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-08-16 | 초기 구성 (에이전트 4 + 스킬 4) | 전체 | - |
| 2026-08-16 | 검증 피드백 반영: worker 스킬 3종 description을 에이전트 스코프로 재작성(트리거 경합 해소), 오케스트레이터에 스캐폴딩 단계·튜닝 가드·에러 폴백 분기·eval 실행 주체·픽스처 출처 명시 | skills 4종 | Phase 6 검증(구조·충실도·트리거·드라이런) 결과 10건 수정 |
| 2026-08-16 | 개발 명세 원본 확보(docs/SPEC.md 저장): 픽스처를 §12 실측값으로 갱신(Pooh AR 2.0 — AR<2 경로 미커버 명시), Open Library 폴백·디자인 원본 파일 반영 | docs/SPEC.md, card-eval, ai-harness-impl, orchestrator | 사용자가 개발 프롬프트 전문 제공 |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

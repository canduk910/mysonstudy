# mysonstudy — 은우 북카드

아이(은우)와 영어 원서를 함께 읽는 부모를 위한 학습 카드 생성 앱. **기본 흐름**은 표지 사진(또는 제목) → AI 판독 → Google Books 보강 → 학습 카드 → 서재. 여기에 두 확장이 얹혀 있다 — ① **유튜브 낭독 자막 grounding**: 책 제목으로 낭독 영상을 자동 검색·선택해 그 자막으로 카드를 실제 본문에 붙이고, 챕터별 **영어 원문+한글 해석 리더**(단어 더블탭 뜻·발음·"모은 단어" 담기)를 만든다. ② **영어단어장 정복**: 교재 사진을 판독(원문 전사) → 영영 정의·이모지 → 영단어 5지선다 시험 → 오답노트. 앱 전체 명세는 `docs/SPEC.md`(확장은 §14), AI 호출 상세는 `docs/harness/english.md`(과목 공통 규약은 `docs/HARNESS.md`), 디자인 원본은 `design/영어책_학습카드_샘플.html`.

## ⚠️ 로컬 실행이 프로덕션 DB를 향할 수 있다 (2026-08-17 사고)

**이 저장소에서 앱이나 스크립트를 돌리기 전에 스토어 백엔드가 무엇인지 확인하라.**

`lib/store.ts`는 `STORE_BACKEND`가 없으면 자동 감지한다 — `GOOGLE_APPLICATION_CREDENTIALS`·`K_SERVICE`·`GOOGLE_CLOUD_PROJECT` 중 **하나만 있어도 Firestore**(=가족이 실제로 쓰는 프로덕션 DB)를 잡는다. 2026-08-17에 `.env`의 `STORE_BACKEND=firestore` 때문에 로컬 삭제 테스트가 실데이터를 지웠다 — 책 4권·카드 8장·읽음 기록 6건. PITR이 꺼져 있어 1시간 버전 보존 창이 닫히기 직전에 겨우 복구했다.

지금은 세 겹으로 막혀 있다:
- `.env`에서 두 줄을 주석 처리 → 로컬 자동 감지 결과가 `file`
- `lib/prod-guard.ts` → 프로덕션이 아닌데 Firestore를 지우려 하면 **던진다**(`ALLOW_PROD_DESTRUCTIVE=1`로만 해제)
- `getStore()` → 개발 환경에서 Firestore를 잡으면 경고를 찍는다

**그래도 규칙은 이것이다:**
- 앱·스크립트를 로컬에서 돌릴 때는 **`STORE_BACKEND=file`을 명시**하라. 자동 감지에 기대지 마라.
- 가드는 **삭제만** 막는다. 생성·수정은 그대로 통하므로, Firestore에 붙은 채 카드를 만들면 실데이터가 늘어난다.
- 서브 에이전트에게 검증을 시킬 때 이 사실을 프롬프트에 함께 넘겨라. 2026-08-17 사고의 직접 원인은 "무비용 검증만"은 지시하면서 **어느 DB를 향하는지는 확인하지 않은 것**이었다.

## 하네스: 은우학습 개발팀 (영어 + 수학)

**목표:** 과목별 스펙(`docs/harness/english.md` · `docs/harness/math.md`)대로 앱을 구현하고, 품질(프롬프트)을 eval 기반으로 안전하게 튜닝한다.

**트리거:** 앱 구현·수정, AI 모듈(lib/ai), 프롬프트 튜닝, eval 실행, QA·정합성 검증 등 이 프로젝트의 개발 작업 요청 시 `study-orchestrator` 스킬을 사용하라. 영어(북카드)든 수학(수학코치)든 진입점은 하나다. 스펙 내용에 대한 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-08-16 | 초기 구성 (에이전트 4 + 스킬 4) | 전체 | - |
| 2026-08-17 | 서문에 "로컬 실행이 프로덕션 DB를 향할 수 있다" 경고 추가 | CLAUDE.md | 로컬 삭제 테스트가 프로덕션 Firestore를 지운 사고 — 에이전트에게 검증을 시킬 때 DB 대상 확인이 누락됐다 |
| 2026-08-17 | **과목 확장(영어 → 영어+수학)**: 에이전트 6명(재사용 4 + 신규 `math-verifier`·`player-builder`), 스킬 6종. `card-tuner`→`prompt-tuner`, `bookcard-qa`→`study-qa`, `card-eval`→`prompt-eval`, `bookcard-orchestrator`→`study-orchestrator`로 과목 중립화. 도메인 지식은 스킬 references로 분리 | agents 6, skills 6, CLAUDE.md | 수학코치 하네스 명세 반영. 에이전트를 과목별로 복제하면 역할이 중복되고 조율 비용만 커지므로, 에이전트는 재사용하고 references만 가르는 구조를 택했다 |
| 2026-08-16 | 검증 피드백 반영: worker 스킬 3종 description을 에이전트 스코프로 재작성(트리거 경합 해소), 오케스트레이터에 스캐폴딩 단계·튜닝 가드·에러 폴백 분기·eval 실행 주체·픽스처 출처 명시 | skills 4종 | Phase 6 검증(구조·충실도·트리거·드라이런) 결과 10건 수정 |
| 2026-08-16 | 개발 명세 원본 확보(docs/SPEC.md 저장): 픽스처를 §12 실측값으로 갱신(Pooh AR 2.0 — AR<2 경로 미커버 명시), Open Library 폴백·디자인 원본 파일 반영 | docs/SPEC.md, card-eval, ai-harness-impl, orchestrator | 사용자가 개발 프롬프트 전문 제공 |
| 2026-08-25 | `doc-commit` 스킬 신설 — 메모리·git 이력·코드 실체를 근거로 `.md` 문서를 최신화·커밋. 저장소 함정(spec-sync 프롬프트 블록 불가침·§번호 안정성·변경이력 append·next.js 자동블록)을 규칙으로 못박음 | skills(doc-commit), CLAUDE.md | 앱 기능이 문서보다 앞서 나가 서문·플로우가 실제와 어긋나기 시작 — 문서 동기화를 반복 가능한 절차로 |
| 2026-08-25 | 2026-08-16 이후 앱 확장을 문서에 반영: 서문 앱 흐름에 낭독 자막 grounding·챕터 리더·단어탭·영어단어장 정복 추가, SPEC에 §14(확장 기능)·환경변수 2종(`SUPADATA_API_KEY`·`YOUTUBE_API_KEY`) append, README 소개·환경변수 갱신. 반영 마지막 커밋 `4cabb21` | CLAUDE.md, docs/SPEC.md, README.md | 자막 grounding·단어장 정복 아크가 harness/english.md에만 있고 제품 문서엔 없었다 |
| 2026-09-02 | 2026-08-25 이후 앱 확장 3종을 문서에 반영: **목록 순서변경**(서재·단어장·수학, 관리모드 드래그+↑↓, 공유 프리미티브 `use-reorder`)·**읽어주기 속도 조절**(전역·localStorage 영속)·**단어장 유의어·반의어 연결 + 관계 문제 시험**을 SPEC §15에 추가, README §5 판단 기록 갱신. 반영 마지막 커밋 `fd3863d` | CLAUDE.md, docs/SPEC.md, README.md | 세 기능이 코드·git에만 있고 제품 문서엔 없었다 — doc-commit 스킬로 동기화 |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

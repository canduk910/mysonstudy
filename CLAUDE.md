# mysonstudy — 은우 북카드

아이(은우)와 영어 원서를 함께 읽는 부모를 위한 학습 카드 생성 앱. **기본 흐름**은 표지 사진(또는 제목) → AI 판독 → Google Books 보강 → 학습 카드 → 서재. 여기에 세 확장이 얹혀 있다 — ① **유튜브 낭독 자막 grounding**: 책 제목으로 낭독 영상을 자동 검색·선택해 그 자막으로 카드를 실제 본문에 붙이고, 챕터별 **영어 원문+한글 해석 리더**(단어 더블탭 뜻·발음·"모은 단어" 담기)를 만든다. ② **영어단어장 정복**: 교재 사진을 판독(원문 전사) → 영영 정의·이모지 → 영단어 5지선다 시험 → 오답노트. ③ **은우 자유대화**: Sunny 선생님(OpenAI Realtime 실시간 음성 — 관문 R)과 주제·단어장을 골라 5분 전화영어, 화자별 실시간 스크립트 + 말문 막힘 도움 카드·이모지 그림 카드(선생님 줄마다 앱이 따로 만든다 — 호출 J, 선생님 음성 모델에는 도구가 없다)·주제 일러스트, 끝나면 문장을 탭해 선생님 말투 설명(호출 I)을 듣는다 — 음성은 저장하지 않고 글자 스크립트만(SPEC §21, `docs/harness/english.md` §12). 앱 전체 명세는 `docs/SPEC.md`(확장은 §14), AI 호출 상세는 `docs/harness/english.md`(과목 공통 규약은 `docs/HARNESS.md`), 디자인 원본은 `design/영어책_학습카드_샘플.html`.

저장소는 북카드 말고도 과목·영역을 더 기른다. 은우 쪽 **수학코치**(문제집 사진·직접 입력 → 3막 설명 + 검산 + 되감기 플레이어 — `docs/harness/math.md`), 그리고 학습자가 아이가 아니라 아빠인 **아빠 영역** 셋 — **아빠의 일본어**(JLPT 단어장 — 꼭 넣을 단어는 일본어 표기나 한국어 뜻으로 · 듀오링고 대화 복습·한자, 해설을 한국어까지 이어 읽는 낭독, 그리고 토익스피킹 11문항 5파트를 일본어로 보는 **🎙️ 말하기 모의고사**(JLPT N5~N1 출제·녹음은 기기에만·버튼 AI 채점·Q1–2는 AI 없이 표기/읽기 대조·응시 화면은 토익 것을 시험 프로필로 재사용), 그리고 교재(다이나믹일본어 회화 음원·JLPT 한끝 N5)로 도는 **🗓️ 오늘의 일본어**(하루 30분 · 90회 완료 순서 과정 — 회화(원음은 기기에만·따라 말하기·🎤 체크)·N5 단어·청해/모의고사·복습, 새 AI 호출 없음 — SPEC §27) — `docs/harness/japanese.md`(말하기 §15·오늘의 일본어 §16), SPEC §18·§26·§27), **아빠의 영어**(토익스피킹, 코드·경로 `toeic`. 표현 암기장 사진 판독·파일 가져오기 → 발화 포인트 카드·전체 듣기·시험 4모드, AI가 새로 만든 11문항 모의고사 → 응시 녹음(기기에만)·버튼으로 도는 AI 채점·추정 등급, 그리고 **유형별 공략**(Q3–4·Q5–7·Q8–10·Q11 폴더 — 틀 은행 하나(같은 자리 틀은 하나만)를 중심으로 네 탭이 돈다: 공략 읽기+🔊(외울 틀 강조·같은 자리 다른 표현은 접어 듣기에서 뺀다)·중심인 **템플릿(틀) 훈련**(한국어 1번 → 영어 N번 따라 말하기, 틈은 무음 소리 조각·🧩 틀 테스트는 받아쓰기 비교 뒤 아빠가 ○/✕)·**👀 틀 시험**(한→영·영→뜻 고르기·빈칸 — 교재 표현 시험을 대신한다)·AI가 새로 만든 한 문제 연습. 한 문제 연습과 **실전 모의고사**는 그 유형의 **답변 흐름**을 받아 모범답변·AI 피드백을 단계마다 외운 틀로 조립한다(2026-10-02 템플릿 중심 개정 — 새 AI 호출·새 컬렉션 없음, 호출 C·D 입력 칸 하나) — harness §12·§12-13, SPEC §20-10) — `docs/harness/toeic.md`, SPEC §20. **교재 사진·전사본은 공개 저장소에 넣지 않는다** — `data/private/`(gitignore)에 두고 앱의 "파일로 가져오기"로만 넣는다)와 **아빠의 운동**(러시안 파이터 풀업·푸시업 사다리 추적. 계산은 **LLM 호출이 없는** 순수 엔진이라 하네스가 아니라 SPEC §19가 명세다 — 세션 음성 안내만 발음 엔진(클라우드 TTS)을 거친다. 총 운동 소요시간은 세션이 잰 실측, 세션 없이 한 기록·지난 기록은 엔진이 읽을 때 계산하는 근사치 — SPEC §19-8). 그리고 학습자가 엄마인 **엄마의 생활영어**(코드·경로 `mom` — 소리 블록 방식 1년 과정: 완료 순서로 도는 하루 레슨(틀·끊어 듣기·따라 말하기·🎤 발화 체크)·그 주 레슨 뒤 주간 테스트(녹음은 기기에만·AI 총평 M1)·복습 주와 자동 감속·오늘의 복습. 교재는 `data/private/` 가져오기 파일로만 앱에 넣는다 — `docs/harness/mom.md`, SPEC §24). 화면 공통으로 **언어별 발음 엔진**(기본은 영어·한국어 OpenAI TTS, 일본어 기기 음성 — 클라우드가 실패하면 기기 음성, SPEC §16·§16-5)과 모든 화면 상단의 **학습 스트릭**(은우 · 아빠 일본어 · 아빠 영어 · 아빠 운동 · 엄마를 나란히 — 은우 트랙은 단어장 시험에 자유대화를 더해 센다, SPEC §17)이 있다.

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

## 하네스: 은우학습 개발팀 (영어 + 수학 + 일본어 + 토익스피킹)

**목표:** 과목별 스펙(`docs/harness/english.md` · `docs/harness/math.md` · `docs/harness/japanese.md` · `docs/harness/toeic.md`)대로 앱을 구현하고, 품질(프롬프트)을 eval 기반으로 안전하게 튜닝한다.

**트리거:** 앱 구현·수정, AI 모듈(lib/ai), 프롬프트 튜닝, eval 실행, QA·정합성 검증 등 이 프로젝트의 개발 작업 요청 시 `study-orchestrator` 스킬을 사용하라. 영어(북카드)든 수학(수학코치)든 일본어(아빠의 일본어)든 토익스피킹(아빠의 영어 — `toeic`)이든 운동(아빠의 운동 — AI 없음, SPEC §19)이든 진입점은 하나다. 스펙 내용에 대한 단순 질문은 직접 응답 가능.

**변경 이력:** `docs/HARNESS-CHANGELOG.md` (하네스·문서 동기화 기록 — 현재 규칙은 위 서문·SPEC·harness 문서가 기준이다)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

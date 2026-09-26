---
name: study-orchestrator
description: "은우학습(영어 북카드 + 수학코치 + 아빠의 일본어·아빠의 영어(토익스피킹)·아빠의 운동) 개발 에이전트 팀 오케스트레이터. 앱·기능 구현, AI 모듈(lib/ai) 구축, API 라우트·UI 작업, 프롬프트 튜닝, 카드·설명 품질 조정, eval 실행, QA·정합성 검증 요청 시 반드시 이 스킬을 사용. 영어 쪽(표지 판독·학습 카드·서재·낭독 자막·챕터 리더·단어 뜻·영어 단어장 판독·영영 정의·시험·오답노트·자유대화 — AI 전화영어 선생님·도움 카드·주제 일러스트·문장 설명), 수학 쪽(문제집 판독·3막 설명·검산·되감기 플레이어), 아빠 쪽(JLPT N1~N5 단어장·대화 복습·해설·한자 카드·시험, 토익스피킹 표현집 사진 판독·파일로 가져오기·발화 포인트·표현 시험·모의고사 생성·Q3–4 사진·응시 녹음·AI 채점·추정 등급, 러시안 파이터 운동 루틴·휴식 타이머·운동 소요시간), 과목 공통(상단 스트릭·발음·읽기 속도·해설 듣기 재생·목록 순서변경) 모두 여기서 분기한다. 동작 문제·버그 신고('책 찍었는데 안 읽혀', '카드가 안 나와', '문제 판독이 이상해', '답이 틀렸어', '플레이어가 안 떠', '해설 듣기가 멈춰', '소리가 안 나', '녹음이 안 돼', '채점이 안 돼', '선생님 목소리가 안 들려', '기록 취소가 안 돼', '에러 난다'), 아이 반응·품질 피드백('은우가 어려워해', '설명이 너무 길어', '카드가 별로야', 'N3 단어가 너무 쉬워', '해설이 너무 짧아', '모범답변이 너무 어려워', '발화 포인트가 어색해'), 후속 작업(다시 실행, 재실행, 업데이트, 수정, 보완, 부분만 다시, 이전 결과 개선)도 모두 이 스킬로 처리한다. 스펙 내용에 대한 단순 질문은 직접 응답 가능. 문서(.md)만 고치는 요청(문서 최신화·README·CLAUDE.md 변경이력·SPEC에 이미 구현된 기능의 절 추가)은 doc-commit, 하네스(에이전트·스킬 정의) 점검·보정은 harness 스킬이다."
---

# Study Orchestrator — 은우학습 개발팀 조율

과목·영역을 한 저장소에서 기른다. **영어(북카드)**는 표지 사진 → 학습 카드(+ 은우 **자유대화** — AI 전화영어 선생님과 실시간 음성 대화 → 문장 설명), **수학(수학코치)**은 문제집 사진 → 3막 설명 + 되감기 플레이어, **일본어(아빠의 일본어)**는 JLPT 단어장·듀오링고 대화 복습·한자, **토익(아빠의 영어 · 토익스피킹)**은 표현집(사진 판독·파일로 가져오기 → 발화 포인트 → 표현 시험)과 모의고사(AI 출제·Q3–4 사진 → 응시·녹음 → AI 채점), **운동(아빠의 운동)**은 러시안 파이터 풀업·푸시업 루틴 추적(**AI 생성 호출 없음** — 단 세션 음성 안내는 `/api/tts` 발음 경로를 탄다).

단일 진실 원천은 과목별 스펙이다 — `docs/harness/english.md`(자유대화는 §12, 제품 흐름은 SPEC §21), `docs/harness/math.md`, `docs/harness/japanese.md`, `docs/harness/toeic.md`. AI가 없는 운동과 과목 공통 기능(클라우드 발음 §16·학습 스트릭 §17·해설 낭독 §18)은 `docs/SPEC.md`(운동은 §19, 소요시간 §19-8). 공통 규약은 `docs/HARNESS.md`.

## 실행 모드: 하이브리드

| 워크플로우 | 모드 | 이유 |
|---|---|---|
| A. 빌드 | 서브 에이전트 파이프라인 + SendMessage | 단계 간 순차 의존이 강하다. QA↔구현자 피드백은 SendMessage로 충분 |
| B. 튜닝 | 서브 에이전트 단독 | prompt-tuner 1명이면 된다 |
| C. QA | 서브 에이전트 단독 | 독립 검증이 목적 |

모든 Agent 호출에 `model: "opus"`를 명시한다.

## 에이전트 구성

| 에이전트 | 과목 | 역할 | 스킬 → 과목별 references |
|---|---|---|---|
| ai-engineer | 공통 | `lib/ai/client.ts`(공유) + `lib/ai/{english,math,japanese,toeic}/`(프롬프트·스키마·순수 후처리, 토익은 진입 함수 `calls.ts`까지) + 토익 클라이언트 안전 순수 모듈(`lib/toeic-{quiz,mock,score,listen,text}.ts`) + 자유대화 순수 모듈·세션 설정 조립(`lib/talk-{transcript,cards,hints,topics,session-config,explain-script,streak}.ts`) + `scripts/eval-{english,math,japanese,toeic}.ts` | `ai-harness-impl` → `references/english-routes.md` · `japanese.md` · `toeic.md` (수학은 본문) |
| app-builder | 공통 | 라우트·외부 API 연동·화면·저장소 + 하네스 밖 관문(토익 사진 P·전사 T, 자유대화 관문 R `lib/talk-gateway.ts`·사진 공용 코어 `lib/image-gen.ts`)·녹음·전이중 마이크(`lib/mic-session.ts`)·자유대화 실시간 컨트롤러(`lib/talk-realtime.ts`) + AI 없는 공통 기능(발음·스트릭·해설 낭독·순서변경)·아빠의 운동 | `ai-harness-impl` → `references/english-routes.md` · `japanese.md` · `toeic.md` · `app-patterns.md` |
| qa-inspector | 공통 | 통합 정합성 + 정확성 장치 반례 검증 | `study-qa` → `references/english.md` · `math.md` · `japanese.md` · `toeic.md` · `common.md` |
| prompt-tuner | 공통 | 프롬프트 다이얼 + eval 회귀 | `prompt-eval` → `references/english-dials.md` · `math-dials.md` · `japanese-dials.md` · `toeic-dials.md` |
| **math-verifier** | 수학 | 호출 C·`verifyScene`·`held` 판정 파이프라인 | `math-pipeline` |
| **player-builder** | 수학 | 호출 E·`player-kit`·iframe 격리 | `player-kit` |

에이전트는 과목 중립이고 **도메인 지식은 스킬의 references가 가른다.** 과목이 늘어도 에이전트를 복제하지 않는다 — 조율 비용만 커진다. 일본어(2026-09-18 도입)도 이 원칙대로 references만 늘렸다(2026-09-24 과목별 분리). 토익(아빠의 영어, 2026-09-26 편입)도 같다 — 에이전트는 그대로이고 references `toeic.md`·`toeic-dials.md`만 더했다. 에이전트는 지시에 적힌 **subject 값**으로 어느 references를 읽을지 정한다.

## Phase 0: 컨텍스트 확인

1. **과목 판별.** 요청이 어느 과목인지 정한다. 단서: 카드·표지·AR·Lexile·단어장·서재 → 영어 / 문제·문제집·풀이·답·검산·플레이어·되감기 → 수학 / JLPT·N1~N5·한자·후리가나·히라가나·듀오링고·대화 복습·해설 내용·품질 → 일본어 / 토익·토익스피킹·스피킹·모의고사·모의시험·표현집·표현 암기장·표현 시험·발화 포인트·모범답변·녹음·AI 채점·응시·추정 등급·목표 등급(IM3·IH·AL)·Q1~Q11 → 토익 / 해설 듣기 재생·멈춤·소리, 발음, 스트릭, 순서변경 → 과목 공통(`common`) / 운동·풀업·푸시업·RM·세트·러시안 파이터·휴식 타이머 → 운동. **"단어장"은 영어(은우)와 일본어(아빠) 양쪽에 있다** — JLPT·일본어 단서가 없으면 영어로 본다. 토익은 같은 자리를 **"표현집"**이라 부른다(단어장이 아니다) — "토익 단어장"처럼 섞어 말하면 표현집으로 보되, 확신이 없으면 묻는다. **"영어"만으로는 은우 영어(북카드·단어장)와 아빠의 영어(토익)가 갈리지 않는다** — 카드·표지·AR·서재·챕터·은우 쪽 단서가 있으면 영어, 토익·스피킹·모의고사·표현집·녹음 단서가 있으면 토익, 둘 다 없거나 둘 다 있으면(예: "은우 카드에도 녹음을 붙여 줘" — 새 기능이 어느 과목 화면에 붙는지가 갈린다) 묻는다. **"아빠"는 일본어·토익·운동 세 곳에 있다** — "아빠"만으로 정하지 말고 위 단서로 가른다. "시험"도 은우 단어 시험·일본어 시험·토익 표현 시험에 다 있다. **토익 단서 중 셋은 다른 과목에도 있다** — ① "스피킹"·"발화": 일본어 대화 복습이 듀오링고 *스피킹* 세션 스크린샷이고 해설이 *내 발화*를 평가한다. 듀오링고·대화 복습·해설 단서가 있으면 일본어다. ② "채점": 수학도 문제집 사진의 빨간 채점 표시(`gradedMark`)를 판독하고 은우가 쓴 답을 맞음·부분·틀림으로 채점한다. 문제집·풀이·검산 단서가 있으면 수학이고, 녹음 답변의 AI 채점·추정 등급만 토익이다. ③ "답"·"문제": 수학 단서지만 토익은 "답변·모범답변·문항"을 쓴다. 모의고사·Q번호·녹음과 함께 오면 토익이다. 스트릭(상단 🔥)은 과목 공통(SPEC §17)이다. **은우 자유대화**(2026-09-26)도 영어다 — 자유대화·전화영어·실시간 대화·선생님(Sunny)·도움 카드·🙋 도와줘요·그림 카드·주제 일러스트·오늘의 단어·문장 설명·대화 보기 → `english`. 이 기능은 다른 과목과 낱말이 겹친다. ① **'대화'**: 일본어 **'대화 복습'**은 아빠가 듀오링고 대화 스크린샷을 올려 해설을 받는 것이고(`japanese`), 자유대화는 은우가 선생님과 **소리로** 말하는 것이다 — 듀오링고·스크린샷·해설·일본어 단서면 일본어, 선생님·전화·은우·실시간 단서면 자유대화. ② **'마이크'·'말하기'·'녹음'**: 토익 **'녹음'**은 아빠가 모의고사 답변을 녹음해 AI 채점을 받는 것이고(`toeic`), 자유대화는 녹음하지 않는다(음성은 저장하지 않고 글자 스크립트만 남긴다) — 녹음·채점·모의고사·응시·등급이면 토익, 대화 중 마이크·선생님이 못 알아들음이면 자유대화. **'영어로 말하기'만으로는 못 가른다** — 토익스피킹이 곧 영어로 말하기이고, 토익 표현 시험에도 '소리 내어 말하기' 모드(마이크 없이 스스로 말해 보고 정답 확인)가 있다. 은우·선생님·대화 단서가 없으면 묻는다. ③ **'전사'**는 네 곳에 있다 — 영어 단어장 교재 원문 전사(호출 C)·일본어 듀오링고 대화 전사(호출 B)·토익 답변 전사(관문 T)·자유대화 은우 발화 전사(관문 R 세션의 전사 모델). 은우·대화 중이면 자유대화, 모의고사·채점이면 토익, 스크린샷·듀오링고면 일본어, 교재 사진이면 영어 단어장이다. **'선생님'은 자유대화에만 있다.** 운동에는 **소요시간**(SPEC §19-8)이 더해졌다 — 운동 시간·소요시간·경과 시계·📒 운동 기록·실측/근사 → 운동(`common`). **모호하면 물어본다** — 잘못 고르면 엉뚱한 스펙으로 작업한다.
   판별 결과를 **subject 값**으로 정해 모든 에이전트 지시에 넣는다 — `english` · `math` · `japanese` · `toeic` · `common`. 운동과 과목 공통 기능(클라우드 발음·스트릭·순서변경·해설 낭독의 재생 파이프라인)은 `common`이다. 해설 낭독은 대본이 일본어 호출 C 스키마에 묶여 있어(`lib/ja-coaching-script.ts`), 스키마를 건드리는 작업이면 `japanese` 검증도 함께 건다. 같은 이유로 스트릭의 🎙️ 영어 트랙(`lib/toeic-streak.ts`)이나 공유 쪼개기(`lib/tts-split.ts`)·재생 큐(`speakQueue`)를 건드리는 토익 작업이면 `common` 검증(`eval:streak`·`eval:speech`)을 함께 건다. 자유대화도 공유 파일에 닿는다 — 은우 스트릭(`/api/streak`·`lib/talk-streak.ts`)을 건드리면 `common`(`eval:streak`), 토익과 함께 쓰는 마이크 관문(`lib/mic-session.ts`)·사진 공용 코어(`lib/image-gen.ts`)를 건드리면 토익 회귀(`eval:toeic` — 관문 P 동작 불변)를 함께 건다.
2. **스펙 확인.** 해당 과목 스펙 문서가 있는지 본다. 없으면 **중단하고 사용자에게 요청**한다. 스펙 없이 임의 구현하지 않는다.
3. **실행 모드 결정** — `_workspace/` 상태로:
   - 미존재 → 초기 실행
   - 존재 + 부분 수정 요청 → **부분 재실행**(해당 에이전트만 재호출, 프롬프트에 이전 산출물·QA 리포트 경로 포함)
   - 존재 + 전면 재작업 → 기존을 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 초기 실행
   - **증분 기능 추가는 아카이빙하지 않는다** — 기존 리포트가 그 작업에 필요한 컨텍스트다
4. **요청 분류** → 워크플로우 A(빌드) / B(튜닝) / C(QA). 혼합이면 A(QA 포함).
   - **버그 신고는 먼저 C(qa-inspector)로 원인을 좁힌다.** 재현 단서(실패한 화면·데이터·시각, 가능하면 서버 로그의 `callWithSchema` 줄 — `call` 라벨과 zod 오류 요약)를 사용자에게 받아 넘긴다. 스텁은 늘 같은 응답을 주므로 간헐 실패는 스텁으로 재현되지 않는다. QA가 원인과 담당을 정하면 **사용자 확인을 받고** A 부분 재실행으로 고친다(워크플로우 C 규칙과 같다). 담당은 원인으로 정한다: zod·스키마·후처리·client 배선(토익은 `lib/ai/toeic/calls.ts`) → ai-engineer / 라우트·화면·저장, 토익 관문 P·T·녹음(`lib/mic-session.ts`)·응시 화면 → app-builder / 특정 규칙에서 재요청 소진 throw가 반복되는 **프롬프트 준수 문제** → B(prompt-tuner) / 수학 답·장면 검산 → math-verifier / 플레이어 → player-builder. 자유대화는 순수 모듈(스크립트 리듀서·도구 호출 검사·도움 상태 기계·세션 설정 조립 — `lib/talk-{transcript,cards,hints,session-config}.ts`)과 호출 I(`talk-prompts.ts`·`talk-schemas.ts`) → ai-engineer, 실시간 컨트롤러(`lib/talk-realtime.ts`)·관문 R 네트워크(`lib/talk-gateway.ts`)·저장·화면·마이크·사진 코어 → app-builder, 선생님 말투(차례 길이·질문 수·한국어 사용량) → B. 단 선생님 음성은 eval 게이트가 없어 효과 확인에 실연결 동의가 필요하다.
   - **소리 신고는 경로부터 가른다** — 운동 세션이면 비프(Web Audio, 발음 관문 밖 — `components/workout-session.tsx` `ensureWorkoutAudio`·`scheduleBeep`)인지 음성 안내(`speakQueue` ko-KR)인지, 발음·해설 듣기면 그 언어의 엔진(`getTtsEngine`)이 cloud인지 device인지부터 본다. **토익 응시 화면**(`components/toeic-take-view.tsx`)은 세 경로가 한 화면에 있다 — ① 지시문·질문 음성은 `speakQueue`(en-US, 기본 엔진 cloud — 끝내 안 나면 일시정지 + "질문 보기"가 떠야 한다), ② 답변 시작 비프는 Web Audio(`lib/toeic-audio-cue.ts` `scheduleToeicBeep` — 발음 관문 밖, 무음 스위치는 시작 탭의 세션 `playback`이 막는다), ③ 녹음은 `lib/mic-session.ts`(세션 `play-and-record` ↔ `playback` 전환 — **녹음 뒤 질문 소리가 작거나 수화기로 나면** 세션이 `play-and-record`에 남은 것부터 의심한다). 결과 화면의 "내 녹음 ▶"는 기기 IndexedDB의 녹음을 `<audio>`로 재생한다 — 다른 기기에는 녹음이 없다. **은우 자유대화**도 세 경로가 서로 다르다 — ① **선생님 목소리**는 합성 발음이 아니라 WebRTC 원격 트랙(`<audio autoplay playsinline>`, `lib/talk-realtime.ts`)이라 **`lib/speech.ts` 밖**이다(엔진·속도·캐시·`getTtsEngine`이 무관 — 거기서 원인을 찾지 마라). 안 들리면 연결 상태, 📞 탭 안의 `audio.play()` 준비, 그리고 재생과 캡처가 대화 내내 겹쳐 iOS가 소리를 **수화기**로 보내거나 줄이는지(이어폰과 비교)를 본다. ② **대화 뒤 문장 설명 낭독**은 `speakQueue`(ko-KR/en-US, 기본 cloud) — 문장 탭 안에서 `unlockSpeechPlayback()`을 불렀는지, 대화가 끝난 뒤 오디오 세션이 `playback`으로 돌아왔는지. ③ **마이크**는 `acquireMicStream`(`lib/mic-session.ts` — 세션 `play-and-record`, 권한 대기 15초, 끝내면 트랙 stop → `playback`). 그림 카드·도움 카드에 🔊가 없는 것은 정상이다(마이크가 열려 있어 앱이 소리를 내지 않는다).

## 워크플로우 A: 빌드

과목에 따라 참여 에이전트가 다르다.

**영어**: ai-engineer → qa-inspector(증분) → app-builder → qa-inspector(전체)

**영어 — 자유대화**(`english.md` §12, SPEC §21): 같은 골격이다. ai-engineer는 원문·스키마·호출 I(`talk-prompts.ts`·`talk-schemas.ts`·`explainTalkSentence`)와 클라이언트 안전 순수 모듈·세션 설정 조립까지, app-builder는 관문 R 네트워크·실시간 컨트롤러·개발 전용 가짜 전송·저장(`talkSessions`·`talkImages`)·화면·전이중 마이크(`acquireMicStream`)·사진 공용 코어(토익 관문 P를 옮긴 것 — `eval:toeic` 무변경 통과가 조건)·`/api/streak` 은우 트랙을 맡는다(`english-routes.md` §7). QA는 순수 모듈 직후와 앱 통합 뒤 두 번 이상 건다(선례 `talk-ai` → `talk-cards` → `talk` 1·2). **iPhone 실기기가 필수다** — 재생과 캡처가 대화 내내 겹치는 유일한 경로라 스피커/수화기·자기 목소리 끼어들기·가장자리 스와이프 백·잠금 중 저장은 헤드리스로 판정할 수 없다. 배포 후 보호자 폰에서 `study-qa/references/english.md` §8-10 목록 확인을 요청한다. 선생님 품질·도구 호출 빈도는 사용자 동의 뒤 실연결로만 본다.

**수학**: ai-engineer(A·B·D 프롬프트·스키마) → **math-verifier**(C·검산·파이프라인) → qa-inspector(증분) → app-builder(라우트·판독 확인 화면) + **player-builder**(E·키트·iframe) → qa-inspector(전체)

**일본어**: 영어와 같은 구성 — ai-engineer(호출 A~D 프롬프트·스키마) → qa-inspector(증분) → app-builder → qa-inspector(전체). 스펙은 `docs/harness/japanese.md`.

**토익**: 일본어와 같은 골격 — ai-engineer(호출 A·B·C1~C5·D 프롬프트·스키마·후처리 순수 함수·`calls.ts` + 클라이언트 안전 순수 모듈 `lib/toeic-{quiz,mock,score,listen,text}.ts` + `scripts/eval-toeic.ts`) → qa-inspector(증분, subject=`toeic`) → app-builder(컬렉션 5개·라우트·화면 + 관문 P `lib/toeic-image.ts`·T `lib/toeic-transcribe.ts` + 녹음 `lib/mic-session.ts`·기기 보관 + 스트릭 🎙️ 영어 트랙) → qa-inspector(전체). 스펙은 `docs/harness/toeic.md`(로드맵 T0~T5 §11 — 표현집 T1·T2와 모의고사 T3~T5는 서로 독립). **녹음·사진·전사가 있어 iPhone 실기기 확인이 필수다** — 헤드리스 e2e(가짜 마이크 스트림·시간 배율 훅·루프백 스텁 4종)는 순서까지만 잠그고, 스피커/수화기 경로·무음 스위치 비프·답변마다 권한 창·mp4 디코드·전사 잘림·Wake Lock은 배포 후 아빠 폰에서 `study-qa/references/toeic.md` 10절 목록으로 확인을 요청한다. **저장소가 PUBLIC이다** — 교재 원문을 어떤 파일에도 옮기지 말고 `data/private/`는 읽기 전용이라고 모든 지시에 넣는다.

**운동**: AI가 없어 ai-engineer·prompt-tuner가 빠진다 — app-builder(순수 엔진 `lib/workout.ts` → 저장소·라우트 → 화면) → qa-inspector. 엔진은 **스펙만 보고 만든 독립 참조 모델과의 무작위 차분 테스트**로 검증하고(참조 모델·시뮬레이터는 저장소에 없다 — qa-inspector가 **구현을 읽기 전에** SPEC §19만 보고 scratch에 새로 쓰고, `decide*`로 수천 개 무작위 사용자 시나리오를 돌려 날마다 `todayStatus`·볼륨·진행률을 대조한다. 코드로 남기면 구현과 같이 틀려 독립성이 사라진다), 오프라인 `npm run eval:workout`이 회귀 가드다(eval 자체는 실호출 0). 저장은 원자적(`decide*`를 `mutate`/`runTransaction` 안에서)·`rev` 토큰 규약을 깨지 마라(SPEC §19-4). **소요시간**(§19-8)처럼 사건에 필드를 더하는 변경은 정규화 함수(`normalizeWorkoutEvent`)에 같은 검사를 넣었는지가 첫 확인이다 — 빠지면 쓰기 직전 정규화가 값을 조용히 지운다(`app-patterns.md` §14). QA는 참조 모델 차분을 새 값까지 넓힌다(`study-qa/references/common.md` §4-1). **단 운동 화면은 무비용이 아니다** — 세션 음성 안내(기본 켬)가 `ko-KR`로 `/api/tts`를 거치고, 한국어는 기본 엔진이 클라우드다(`lib/speech.ts` `DEFAULT_ENGINE`). `▶ 운동 시작` 탭에서 `openSession()`이 휴식 뒤 안내 문구 4개(휴식은 풀업+푸시업 한 세트 뒤에만 있다)를 `prefetchSpeech(…, "ko-KR")`로 미리 받고, 휴식이 끝날 때마다 `speakQueue`가 다음 안내 문장을 클라우드로 읽는다(캐시에 없으면 그때 합성, SPEC §19-6). 그래서 운동 UI 확인은 반드시 키를 비운 dev 서버에서 한다.

**과목 공통 기능**(클라우드 발음 §16·스트릭 §17·해설 낭독 §18·순서변경 §15-1): 운동과 같은 구성 — app-builder → qa-inspector(subject=`common`). 회귀 가드는 오프라인 `npm run eval:speech`·`eval:streak`(실호출 0). 단 발음은 AI 하네스 밖이어도 **`/api/tts`가 OpenAI 실호출 경로**다 — 키를 비우지 않은 dev 서버에서는 엔진이 클라우드인 언어의 화면에 들어서기만 해도 프리페치 합성이 나간다(기본값: 영어·한국어 클라우드, 일본어 기기 음성).

1. 담당 에이전트 호출. 지시에 **subject 값을 반드시 명시**한다 — 에이전트가 어느 references를 읽을지 이것으로 정한다.
2. 모듈 완성 **직후 즉시** qa-inspector 증분 검증. 전체 완성 후 1회가 아니다.
3. QA 실패 시 수정 루프: 살아 있는 에이전트면 SendMessage, 아니면 새로 호출하되 QA 리포트 경로를 프롬프트에 포함. **루프는 최대 2회**, 초과 시 남은 이슈를 최종 보고에 명시하고 진행.
4. eval 실행 판단(§비용) → 최종 보고: 산출 파일 / QA 결과 / 스펙 공백 취합 / eval 결과.

## 워크플로우 B: 튜닝

0. 해당 과목 `prompts.ts`가 없으면 빌드 선행이 필요함을 알리고 중단.
1. prompt-tuner 호출 — **사용자 피드백 원문**과 **subject**를 프롬프트에 포함하고, "실호출 eval 금지(오프라인까지)"를 명시한다.
2. 오프라인 eval·spec-sync가 통과하면, 튜너가 리포트에 적은 실호출 검증(게이트·횟수)을 사용자에게 보여 주고 동의를 받아 오케스트레이터가 실행한다.
3. eval 실패 시 1회 재조정. 재실패면 실패 사례·분석을 사용자에게 보고하고 판단을 기다린다.

**수학 튜닝 시**: `held` 비율을 낮추려는 조정은 math-verifier와 합의하도록 지시한다. 검산을 느슨하게 하면 틀린 답이 아이에게 간다.

**영어 튜닝 시**: grounding 가드(`groundChapters` — 자막 밖 문장 잘라내기, `resolveAllowedStorySource` — 넘긴 근거보다 높은 storySource 거부)와 판독 호출(A·A′·C)은 다이얼이 아니다. "줄거리가 빈약해"를 근거 밖 창작 허용으로 풀지 않게 지시한다. **자유대화 선생님(관문 R)은 zod·eval 밖이다** — 지시문 다이얼(차례 길이·질문 수·한국어 사용량·도움 카드 답 예시 수)은 오프라인 eval로 원문 일치만 확인되고, 효과는 사용자 동의 뒤 실연결 대화 1회(5분 대략 $0.3~2 + 일러스트 1장)로만 본다. 문장 설명(호출 I)은 `EVAL_TALK=1` 2회. 지시문 `# Safety` 블록·전사에 단어장 prompt 금지·keyWords ⊂ 문장·1학년 눈높이는 튜닝 대상이 아니라고 지시한다(`english-dials.md` §10-4).

**일본어 튜닝 시**: 학습자는 아빠(성인)다 — **눈높이 규칙이 영어와 반대**다(`japanese.md` §0-1). "어려워"를 레벨 낮추기로 번역하지 말라고 지시하라. 레벨은 사용자가 화면에서 고르고, 주제와 레벨이 부딪히면 레벨이 이긴다. 정확성 장치 — 호출 B 전사 프롬프트, 토큰 무결성 zod, `applyVocabPostprocess`(제외 재적용·레벨 태깅), 시험 모드별 숙련도 분리 — 는 튜닝 대상이 아니다. 일본어 eval에는 **아직 실호출 점검이 없다**(`EVAL_JAPANESE=1`은 자리만 있다). 품질을 실물로 봐야 하면 동의를 받아 **호출별로** 1회 돌려 산출물을 사람이 읽거나, 게이트 구현을 ai-engineer에게 먼저 맡긴다 — 호출 A(단어 생성)는 레벨 1개로 1회. 호출 C(대화 해설)는 로컬에 입력 대화가 없으므로(seed의 일본어 컬렉션은 비어 있고, 프로덕션 조회는 금지) **사용자에게 전사 텍스트를 받아**, 저장하지 않는 `POST /api/japanese/dialog/coach {focusKo, turns}` 모드나 `coachJaDialog`(`lib/ai/client.ts`)를 부르는 scratch 스크립트로 1회(재요청 시 2회) 돌린다. 키를 넣은 dev 서버에서는 다른 화면을 열지 않는다(발음 프리페치가 따라 돈다).

**토익 튜닝 시**: 학습자는 아빠(성인 토익스피킹 수험자)다 — 은우 영어와 언어는 같아도 **눈높이는 일본어 쪽**이다(`toeic.md` §0-1). "모범답변이 어려워"는 먼저 모의고사를 만들 때 고른 목표 등급(IM3·IH·AL)을 확인하고, 등급은 다이얼이 아니라 사용자 선택이라고 지시한다. 정확성 장치 — 호출 A 판독(원문 전사), zod 가드(`exampleSpan` ⊂ 예문·index 집합·`chunks` 조인·`said` ⊂ 전사문), 전사에 기대 문장을 넣지 않음(관문 T), Q1–2 비AI 채점, 기출·교재 저작권 — 은 튜닝 대상이 아니다. 발화 포인트(B)·피드백(D) 개수는 zod가 프롬프트와 같은 폭이라 프롬프트만 바꾸면 즉시 거부가 난다(`toeic-dials.md`). 실호출 확인은 `EVAL_TOEIC=1` 게이트(B·C·D 각 1회, 파트는 `EVAL_TOEIC_PART`)를 동의 후 1회 돌리고 산출물을 사람이 읽는다. 튜닝 예시·리포트에 교재 원문을 넣지 말라고 지시한다.

## 워크플로우 C: QA 단독

qa-inspector 호출 → 리포트 작성. 발견 이슈는 **보고만** 한다. 수정은 사용자 확인 후 워크플로우 A 부분 재실행으로.

## 데이터 전달

파일 기반이 기본이다. `{subject}`는 `english` · `math` · `japanese` · `toeic` · `common` 중 하나다.

| 산출물 | 파일명 | 예 |
|---|---|---|
| 빌드 리포트 | `_workspace/build_{agent}_{tag}_report.md` — tag는 subject로 시작 | `build_app-builder_common-tts_report.md` |
| QA 리포트 | `_workspace/qa_report_{subject}_{tag}_{n}.md` — tag 없으면 생략 | `qa_report_japanese_jk_1.md`, `qa_report_toeic_m2_1.md` |
| 튜닝 리포트 | `_workspace/tune_report_{subject}_{n}.md` — common은 튜닝 대상이 없다 | `tune_report_japanese_1.md` |

**중간 산출물은 지우지 않는다**(사후 검증·감사 추적). 에이전트 반환값은 리포트 경로 + 3줄 요약. 실시간 수정 요청은 SendMessage.

## 비용 — 이 프로젝트에서 가장 자주 사고가 나는 지점

- **영어·수학·토익 eval의 실호출 경로는 실호출이다**(일본어 eval은 현재 오프라인 전용 — `EVAL_JAPANESE` 게이트는 자리만, 토익 eval은 `EVAL_TOEIC=1`일 때만 실호출, `eval:speech`·`eval:workout`·`eval:streak`와 `EVAL_OFFLINE_ONLY=1` 항목은 무비용). 실호출 경로는 **사용자 동의를 받고 오케스트레이터가 직접 실행**한다. 에이전트에게는 "eval 실행 금지(`EVAL_OFFLINE_ONLY=1`까지)"를 명시하라 — 지시가 없으면 스스로 돌린다. 재요청이 나면 호출마다 +1회다.

  | 과목 | 실호출 |
  |---|---|
  | 영어 `eval:english` | 기본 카드 3회(`EVAL_SKIP_PAGES=1`이면 2회). 게이트는 한 번에 하나만 돌고 끝난다 — `EVAL_TRANSCRIPT=1`(자막 카드)·`EVAL_CHAPTERS=1`(호출 F)·`EVAL_VOCAB=1`(호출 D)·`EVAL_WORDMEANING=1`(호출 G) 각 1회, `EVAL_TALK=1`(자유대화 호출 I) **2회**(선생님 문장 1·은우 문장 1, 재요청까지 최악 4). 호출 H는 eval 밖 별도 프로브. 오프라인은 484항목(2026-09-26). **자유대화 선생님(관문 R)은 어떤 게이트에도 없다** |
  | 수학 `eval:math` | 픽스처 4문제 × 2~4회 = 8~16회 + 2단 픽스처(`rect-count`) 호출 E 1~2회. `EVAL_ONLY=id`·`EVAL_SKIP_2DAN=1`로 좁힌다 |
  | 일본어 `eval:japanese` | 현재 0회 — `EVAL_JAPANESE=1`은 자리만 있다 |
  | 토익 `eval:toeic` | 기본 0회(오프라인 357항목). `EVAL_TOEIC=1`(+ `EVAL_OFFLINE_ONLY` 없이)이면 B 1(지어낸 표현 7개) + C 1(`EVAL_TOEIC_PART`, 기본 `opinion`) + D 1(Q11 픽스처 전사문) = **3회**, `EVAL_TOEIC_PHOTO=<사진 경로>`를 주면 A 1회 더 = 4회. 관문 P(사진)·T(전사)는 게이트에 없다. 재요청 시 호출마다 +1 |
  | 공통 `eval:speech`·`eval:streak`·`eval:workout` | 항상 0회(순수 함수) |

- **eval 밖의 실호출 경로도 있다** — 키를 넣은 dev 서버에서 화면을 여는 것(`/api/tts` 프리페치), 사진 판독·생성 버튼을 누르는 것. 전부 키를 비우면 501로 막힌다.
  - 프리페치는 **엔진이 클라우드인 언어**에서만 나간다(`prefetchSpeech`가 `getTtsEngine(lang) !== "cloud"`면 아무것도 안 보낸다). 기본값은 `lib/speech.ts` `DEFAULT_ENGINE` — 영어 `en`·한국어 `ko`는 클라우드, 일본어 `ja`는 기기 음성. 그래서 영어 카드·챕터 리더·단어장·시험·오답노트는 마운트만으로 최대 `PREFETCH_MAX_ITEMS`(90)개를 보내고, 일본어 화면은 사용자가 일본어 엔진을 클라우드로 바꿨을 때만 보낸다.
  - **토익 화면 경로의 실호출**(키를 넣은 서버에서): 표현집 사진 판독은 사진 1장당 호출 A 1회(최대 8장). 저장 직후 **자동으로** 발화 포인트가 7개 묶음당 호출 B 1회(14표현 → 2회) — "만들기/다시 만들기" 버튼도 같다. 파일로 가져오기는 0회. 모의고사 만들기는 고른 파트당 호출 C 1회(최대 5) + **학습 보기가 열리자마자 pending 사진 두 장을 자동 생성**(관문 P 장당 1회, 900,000자 초과면 압축 50으로 1회 더). "이 파트 다시 만들기"·"사진 다시 만들기"는 버튼당 1회(failed 사진은 자동 재요청 안 함). AI 채점은 **버튼을 눌러야** 돌고 문항당 전사(관문 T) 1 + 호출 D 1(Q1–2·무응답은 전사만, 이미 점수가 있으면 0, D 실패 뒤 재시도는 저장된 전사로 D만) — 실전 11문항이면 전사 11 + D 최대 9. 발음 프리페치는 en-US(기본 cloud)라 표현 카드·시험 러너·학습 보기·응시 결과가 마운트만으로 최대 90개, 응시 시작 탭이 지시문·질문 약 20~25조각을 보낸다.
  - **자유대화 화면 경로의 실호출**(키를 넣은 서버에서): 📞 한 번 = Realtime 통화 하나(음성 ↔ 음성, **분 단위 과금** — 5분 대화 대략 $0.3~2, 응답마다 대화 전체를 다시 입력으로 과금해 뒤 턴일수록 비싸다, 은우 전사 분당 약 $0.003, SPEC §21-4). 12초 도움 요청(은우가 말하기 전까지 연속 2번 — 🙋 합산)과 도구를 부르고 질문 없이 끝난 응답 뒤 이어 말하기(은우가 말하기 전까지 연속 2까지)도 각각 응답 하나라 같은 식으로 과금된다. 주제 일러스트는 📞마다 1장(마이크를 얻은 뒤 연결과 병렬, 품질 low 약 1센트 — 900,000자를 넘으면 압축 40으로 1장 더). 문장 설명은 **처음 탭한 문장당** 호출 I 1회(+재요청 1), 저장된 설명 재탭은 0회. 설명 낭독은 `speakQueue` 합성(ko-KR/en-US cloud, 대화 보기에 프리페치 없음). 저장·목록·이름·삭제·순서는 AI 0. **개발 전용 가짜 전송도 `/connect`·`/scene`을 실제로 부른다** — 실제 키가 있는 dev 서버에서 켜면 통화 생성 1회(미디어 없음)와 일러스트 1장이 과금된다.
  - **AI가 없는 운동도 이 경로를 탄다.** 세션 음성 안내가 `ko-KR`(기본 클라우드)이라 `▶ 운동 시작` 탭 한 번에 안내 문구 4개를 프리페치하고, 휴식이 끝날 때마다 `speakQueue`가 안내 문장 하나를 클라우드로 읽는다(캐시에 없으면 그때 합성). 해설 낭독의 한국어 해설 조각도 재생할 때 같은 경로로 합성된다.
- 프롬프트·스키마 수정이 남아 있으면 eval을 **나중에 한 번만** 돌린다. 먼저 돌리면 수정 후 다시 돌려야 해서 비용이 배가 된다.
- 무비용 검증 수단을 에이전트에게 알려라: `tsc`·`build`·`seed`·순수 함수 테스트·**루프백 스텁**(`OPENAI_BASE_URL`을 로컬 서버로 고정).

## 안전 — 반드시 모든 에이전트 프롬프트에 넣을 것

- **모든 로컬 실행 명령을 `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= ...` 형태로 쓰라고 지시하라**(eval이면 `EVAL_OFFLINE_ONLY=1`까지).
  "실호출 금지"라는 말만으로는 안 막힌다 — `.env`에 실제 키가 있어 서버를 띄우는 순간 경로가 열린다.
  2026-08-17 하루에 두 번 이 사고가 났다. 키를 비우면 501로 거절되어 **구조적으로 불가능**해진다.
- **`STORE_BACKEND=file`을 명시하고 작업하라.** 이 저장소는 로컬 실행이 프로덕션 Firestore를 향할 수 있었다. `lib/prod-guard.ts`가 개발 환경 삭제를 막지만 **생성·수정은 여전히 통한다.**
- **git commit·push 금지.** main 푸시는 곧 프로덕션 배포다. 커밋은 사용자 승인 후 오케스트레이터가 한다.
- 검증용 임시 데이터는 원상 복구하고 개수로 대조하라(쓰기 전 `data/db.json` 백업 + shasum, 끝나면 복원·대조).
- **자유대화 작업이면** e2e를 루프백 스텁에 묶으라고 넣는다 — 가짜 전송이 `/connect`·`/scene`을 실제로 부르므로 키를 비우면 501에서 멈추고, 실제 키면 과금된다. `OPENAI_API_KEY=sk-stub OPENAI_BASE_URL=http://127.0.0.1:<포트>/v1`를 **함께**(관문 R·사진 코어·호출 I·`/api/tts`가 같은 env를 읽는다) + `APP_PIN=`, 브라우저는 `http://localhost:<포트>`로 연다. 스텁 대사·픽스처는 지어낸 영어이고 은우의 실제 발화를 저장하지 않는다.
- **토익 작업이면 두 줄을 더 넣는다.** ① 저장소는 PUBLIC이다 — 교재 원문(표현·뜻·예문·해석·QUIZ)을 코드·스펙·픽스처·리포트·로그 어디에도 옮기지 말고, `data/private/`는 읽기 전용이다(교재는 사용자가 앱의 "파일로 가져오기"로만 넣는다). ② AI 응답이 필요한 e2e는 키를 비우는 대신 루프백 스텁에 묶는다 — `OPENAI_API_KEY=sk-stub OPENAI_BASE_URL=http://127.0.0.1:<포트>/v1`를 **반드시 함께**(관문 P·T·`/api/tts`도 같은 env를 읽는다), dev 서버면 `APP_PIN=`까지.

## 에러 핸들링

| 상황 | 전략 |
|---|---|
| 에이전트 1명 실패 | 1회 재시도. 재실패 시 하류 의존이 있으면 중단·보고, 없으면 누락을 명시하고 진행 |
| QA 수정 루프 2회 초과 | 루프 중단, 남은 이슈 보고 |
| `OPENAI_API_KEY` 없음 | eval·실호출 건너뛰고 정적 검증만. 보고서에 명시 |
| eval 반복 실패 | 실패 항목·사례·원인 분석 보고 후 사용자 판단 대기 (무한 재시도 금지) |
| 스펙 부재·내부 모순 | 중단하고 질의 (임의 해석 금지) |
| 과목 판별 실패 | 사용자에게 질문 (추측 금지 — 엉뚱한 스펙으로 작업하게 된다) |

## 테스트 시나리오

**정상 흐름 (수학 빌드)**
1. "수학 문제집 사진에서 설명 만드는 기능 구현해줘"
2. Phase 0: 과목=수학, `docs/harness/math.md` 확인, `_workspace/` 존재 → 증분 빌드
3. ai-engineer가 A·B·D 구현 → math-verifier가 C·`verifyScene`·파이프라인 구현
4. qa-inspector 증분 검증 → 통과 → app-builder + player-builder
5. qa-inspector 전체 검증 → 사용자 동의 후 `npm run eval:math` → 최종 보고

**에러 흐름 (QA 실패 루프)**
1. qa-inspector가 "`verifyScene` 규칙 4가 반례를 거부하지 못함" 발견 (P1)
2. math-verifier 재호출(QA 리포트 경로 첨부) → 등식 수정
3. qa-inspector 재검증 → 통과 → 진행
4. 2회 루프에도 실패했다면: 루프 중단, 미해결 이슈와 원인 분석을 최종 보고에 명시하고 **배포 보류**

**튜닝 흐름 (일본어)**
1. "일본어 단어장 예문이 너무 길어서 외우기 힘들어"
2. Phase 0: "단어장"은 양쪽에 있지만 "일본어"라는 단서가 있다 → subject=`japanese`, `lib/ai/japanese/prompts.ts` 존재 확인 → 워크플로우 B
3. prompt-tuner 호출(피드백 원문 + subject + "실호출 eval 금지") → `japanese-dials.md`를 읽고 예문 길이 다이얼(호출 A 프롬프트의 예문 길이 문구)을 스펙 §2-1 코드블록과 **같은 문자열로 함께** 고친다. zod 폭(`JA_EXAMPLE_JA_MIN/MAX`)을 같이 조일지는 리포트에 근거와 함께 적는다
4. `EVAL_OFFLINE_ONLY=1 npm run eval:japanese`로 spec-sync·zod 반례 통과 확인 → 일본어 eval엔 실호출 점검이 없으므로, 사용자 동의 후 레벨 1개로 1회 생성해 예문을 사람이 읽는다
5. 만약 피드백이 "단어가 어려워"였다면: 레벨을 낮추는 다이얼은 없다고 사용자에게 답하고(레벨은 화면에서 고른다), 해설·뜻의 친절함 쪽으로만 조정을 제안한다

**버그 흐름 (토익 — 녹음)**
1. "모의고사 볼 때 녹음하고 나면 다음 질문 소리가 작아"
2. Phase 0: 모의고사·녹음 → subject=`toeic`(소리지만 응시 화면이라 토익이다). 워크플로우 C로 원인부터 좁힌다
3. qa-inspector(subject=`toeic`): 먼저 경로를 가른다 — 질문 음성(`speakQueue` en-US)인지, 녹음 뒤 오디오 세션이 `playback`으로 돌아왔는지(`lib/mic-session.ts`). 헤드리스 e2e에 가짜 `navigator.audioSession`과 MediaRecorder 이벤트 로그를 붙여 세션 전환 순서를 타임라인으로 뽑고, gUM 무응답(`hang`) 반례로 세션이 `play-and-record`에 갇히는지 본다. 스피커/수화기 라우팅 자체는 헤드리스로 판정할 수 없으므로 "실기기 미검증"으로 남긴다
4. 원인이 코드면 **사용자 확인 후** app-builder 재호출 → qa-inspector 재검증 → 배포 후 아빠 iPhone에서 `study-qa/references/toeic.md` 10절 1·3번 항목 확인을 요청한다

**버그 흐름 (과목 공통 — 발음)**
1. "일본어 단어장에서 🔊를 눌러도 소리가 안 나"
2. Phase 0: 발음 → subject=`common`(SPEC §16·§18). 먼저 워크플로우 C로 원인을 좁힌다
3. qa-inspector(subject=`common`): **먼저 `getTtsEngine("ja-JP")`가 무엇을 돌려주는지 본다.** 일본어 기본 엔진은 기기 음성(`lib/speech.ts` `DEFAULT_ENGINE`의 `ja: "device"`)이라, 설정을 바꾸지 않았다면 `speak()`가 `/api/tts`를 아예 부르지 않고 기기 음성으로 직행한다 — 이때 원인은 서버가 아니라 기기 쪽(`ja-JP`가 언어 인자로 넘어가는지, `resolveVoice`가 일본어 음성을 찾는지, 저장된 음성 URI가 이 기기에 있는지)이다. 사용자가 일본어를 클라우드로 바꿔 둔 경우(`localStorage`의 `tts-engine-ja`)에만 키를 비운 dev 서버에서 `/api/tts`가 501을 내고 **기기 음성으로 폴백하는지**, 캐시 지문(GET `/api/tts`)을 본다. 어느 쪽이든 `npm run eval:speech`를 돌린다. **재현하려고 키를 넣고 서버를 띄우지 않는다** — 일본어 화면이 기기 음성이어도 같은 서버에서 영어 화면을 열면 프리페치 합성이 나간다
4. 원인이 코드면 **사용자 확인 후** app-builder 재호출(QA 리포트 경로 첨부) → qa-inspector 재검증. 브라우저 자동재생 정책처럼 기기에서만 드러나는 부분은 "실기기 미검증"으로 보고하고, 배포 후 사용자 폰에서 확인을 요청한다

**버그 흐름 (영어 — 자유대화 소리)**
1. "은우랑 자유대화 하는데 선생님 목소리가 너무 작아. 끝나고 설명 들을 때는 괜찮아"
2. Phase 0: 선생님·자유대화 → subject=`english`(소리지만 발음 관문이 아니다 — 선생님 목소리는 WebRTC 원격 트랙이다). 설명 낭독이 괜찮다는 것은 `speakQueue`·클라우드 발음 경로가 멀쩡하다는 뜻이다. 워크플로우 C로 원인부터 좁힌다
3. qa-inspector(subject=`english`, `study-qa/references/english.md` §8): 가짜 전송 e2e에 가짜 `navigator.audioSession`을 붙여 📞 탭 → `play-and-record` → getUserMedia → … → 끝 → `playback` 순서를 타임라인으로 뽑고, 원격 `<audio>`에 탭 안 `play()`가 걸렸는지 본다. 대화 내내 재생과 캡처가 겹치는 것은 설계다(전이중 — `app-patterns.md` §16) — 그래서 iOS가 소리를 수화기로 보내는지는 헤드리스로 판정할 수 없고 "실기기 미검증"으로 남긴다. **키를 넣고 실연결로 재현하지 않는다**(분 단위 과금 — 사용자 동의가 먼저다)
4. 코드 결함이 없으면 사용자에게 실기기 확인을 요청한다(§8-10 1·2번 — 이어폰과 스피커 비교, 스피커 최대 음량에서 선생님이 스스로 끼어드는지). 코드 결함이면 **사용자 확인 후** app-builder 재호출 → qa-inspector 재검증

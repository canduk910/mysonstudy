# AI 하네스 명세 — 아빠의 영어 (토익스피킹: 표현집 + 모의고사)

> 과목 공통 규약은 `docs/HARNESS.md`. 앱 전체 명세는 `docs/SPEC.md`(제품 수준 흐름은 §20). 이 문서는 **토익스피킹 과목의 AI 호출·데이터·저장·검증 명세**다.
> 영어 북카드(`docs/harness/english.md`)와 **언어는 같지만 학습자가 다르다** — 은우(초등학생)가 아니라 아빠(성인, 토익스피킹 수험자)다. 눈높이 규칙은 일본어(`docs/harness/japanese.md` §0-1)와 같은 쪽이다.

---

## 0. 배경과 설계 결정

### 0-1. 학습자는 아빠, 목표는 "말로 꺼내 쓰기"

- **성인 수험자 기준**이다. 영어 북카드·은우 단어장 프롬프트의 "초등학생·쉬운 말" 규칙을 가져오지 않는다. 목표 등급(IM3·IH·AL)에 맞는 문장을 그 수준 그대로 쓴다.
- **설명은 한국어, 학습 대상은 영어.** 뜻·해설·피드백은 한국어, 표현·예문·답변은 영어(해석을 나란히 붙인다).
- **단어 뜻을 아는 것이 목표가 아니라 시험 답변으로 말하는 것이 목표다.** 그래서 은우 단어장의 "영영 정의 + 이모지" 대신, 표현마다 **발화 포인트**(문항별 활용 문장·답변 틀·바꿔 쓰기·발음 팁·이어 말하기)를 붙인다(호출 B). 사용자 요구 원문: "단순 영영의미보다는 발화로 이어질 수 있는 포인트들을 카드에 많이 실어주면 좋겠어."
- **은우 화면과 섞지 않는다.** 경로·컬렉션·집계가 전부 분리된다(§7). 은우 영어 단어장(`vocabBooks`·`vocabQuizzes`)을 같이 쓰면 은우 스트릭·오답노트·기록이 오염된다(`app/api/streak/route.ts`, `app/english/vocab/wrong/page.tsx`).

### 0-2. 설계 결정 (2026-09-25)

사용자가 명시한 요구는 세 가지다 — ① 토익스피킹 문제 유형을 분석한 **모의시험** ② 표현모음집 **사진 업로드 → 은우 단어장과 같은 낭독·시험** ③ 교재 10쪽을 **미리 넣기**. 아래 표에서 "요구"는 사용자 원문에서 온 것이고, "기본값"은 사용자 확인 전에 정한 것이다. 기본값은 사용자가 바꾸면 이 표부터 고친다.

| 항목 | 결정 | 출처 | 근거 |
|---|---|---|---|
| 표현집 입력 | 교재 페이지 사진 → 판독(원문 전사) → 발화 포인트 보강 | 요구 | 은우 단어장의 사진 판독 관용구(`english.md` §7)를 성인·표현 구조로 새로 쓴다 |
| 카드 내용 | 교재 원문(표현·뜻·예문·해석) + **발화 포인트** | 요구 | 위 §0-1 |
| 낭독·시험 | 은우 단어장과 같은 축 — 🔊 낭독·속도·엔진 + 5지선다 시험·오답노트·기록. 여기에 **전체 듣기**와 **말하기(한→영) 시험**을 더한다 | 요구 + 기본값 | 표현집의 목적이 발화라 "보고 고르기"만으로는 부족하다 |
| **교재 내용의 저장소 반입** | **하지 않는다.** 교재 10쪽 전사본은 git 밖(`data/private/`, gitignore)에 두고 앱의 **"파일로 가져오기"**로 넣는다 | 기본값 | 이 저장소는 **PUBLIC**이다. 교재 사진·전사를 커밋하면 출판물이 공개된다. `public/*.json`은 PIN 게이트를 우회해 더 나쁘다(`proxy.ts` 정적 확장자 예외) |
| 모의고사 문항 | **AI가 새로 만든다**(호출 C). 기출·ETS 샘플 문항은 넣지 않는다 | 기본값 | 기출 저작권은 ETS에 있다(YBM 고지). 형식·시간만 맞춘다 |
| Q3–4 사진 | AI 이미지 생성(관문 P). 실패하면 장면 설명(`sceneKo`)으로 대신하고 "사진 다시 만들기" | 기본값 | 실제 시험은 사진을 보고 말한다. 텍스트만으로는 연습이 되지 않는다 |
| 녹음 | **기기에만** 둔다(IndexedDB). 서버에는 전사문·점수·피드백만 | 기본값 | 원본 미저장 원칙(SPEC §13), Firestore 문서 1MB, 버킷 없음 |
| AI 채점 | 응시 후 **버튼을 눌러야** 돈다(문항당 전사 1회 + 피드백 1회) | 기본값 | 비용이 드는 경로를 자동으로 태우지 않는다 |
| 목표 등급 | 모의고사를 만들 때 IM3 / **IH(기본)** / AL 중 고른다 — 모범답변의 길이·수준이 달라진다 | 기본값 | 모범답변이 너무 어렵거나 쉬우면 따라 말하기가 안 된다 |
| 스트릭 | 아빠 줄에 **"영어" 트랙**을 따로 둔다(표현 시험·모의고사 응시) | 기본값 | 트랙을 합치면 한쪽만 한 날도 이어져 보인다(SPEC §17-7 원칙) |

### 0-3. 이름·경로

앱에서는 **"아빠의 영어"**(부제 "토익스피킹"). 코드·경로는 `toeic`(`english`는 은우 북카드가 쓰고 있다). `/toeic`, `app/api/toeic/**`, `lib/ai/toeic/`, `scripts/eval-toeic.ts`. harness 절 참조 `HARNESS §N`이 `lib/ai/toeic/`·`app/api/toeic/`에 있으면 이 문서를 가리킨다.

### 0-4. 두 기능은 서로 독립이다

**표현집**과 **모의고사**는 한 과목 아래 나란히 선 별개 기능이다(일본어 §0-4와 같은 관계). 한쪽이 비어도 다른 쪽은 온전히 동작한다. 둘이 만나는 곳은 두 군데뿐이다.

1. 모의고사를 만들 때 표현집의 표현 일부를 **"활용할 표현"**으로 넘겨 모범답변에 녹인다(§4-0). 표현집이 비었으면 넘기지 않는다.
2. AI 피드백이 그 목록에서 "넣었으면 좋았을 표현"을 고른다(§5).

---

## 1. 구성 개요

### 1-1. AI 호출

| 호출 | 이름 | 입력 | 출력 | temperature | 성격 |
|---|---|---|---|---|---|
| **A** | 표현집 판독 (vision) | 교재 페이지 사진 1장 | DAY·주제·표현 항목·QUIZ 원문 전사 | 0 | 판독 — 사진에 있는 것만, 창작 0 |
| **B** | 발화 포인트 | 표현 최대 7개(원문) | 표현마다 문항별 활용 문장·틀·바꿔 쓰기·발음·함정·문법·이어 말하기 | 0.5 | 창작(설명) |
| **C** | 모의고사 문항 생성 | 목표 등급 + 주제 힌트 + 활용할 표현 | 파트별 문항·모범답변 — 5개 파트 호출(C1~C5) | 0.8 | 창작(출제) |
| **D** | 답변 피드백 | 문항 자료 + 답변 전사문 | 점수·잘한 점·고칠 문장·빠진 내용·개선 답변 | 0.2 | 평가 |

**하네스 밖 관문 두 개**(Structured Outputs가 아니다 — TTS `lib/tts.ts`와 같은 부류. `callWithSchema`·zod·재요청을 거치지 않고 키 규약만 공유한다):

| 관문 | 이름 | 모듈 | 모델 env (빈 값이면 기본값) |
|---|---|---|---|
| **P** | Q3–4 사진 생성 | `lib/toeic-image.ts` (서버) | `OPENAI_IMAGE_MODEL` = `gpt-image-2`, `OPENAI_IMAGE_QUALITY` = `medium` |
| **T** | 답변 음성 전사 | `lib/toeic-transcribe.ts` (서버) | `OPENAI_TRANSCRIBE_MODEL` = `gpt-4o-mini-transcribe` |

- **시험(표현집)은 AI를 부르지 않는다**(§6). Q1–2(지문 읽기)의 채점도 AI가 아니라 **전사문 ↔ 지문 대조 순수 함수**다(§5-4) — 전사문으로는 발음·억양을 알 수 없으니 LLM에게 점수를 지어내게 하지 않는다.
- **요청 하나가 60초를 넘지 않게 쪼갠다.** 프로덕션은 Firebase Hosting → Cloud Run 리라이트라 요청 시간 상한이 있다. 그래서 호출 A는 사진마다, B는 7개씩, C는 파트마다(5개 병렬), P는 사진마다, 채점(T+D)은 문항마다 **별개 호출**이다. 한 묶음이 실패해도 나머지는 산다(부분 성공).

### 1-2. 파일 배치

```
docs/harness/toeic.md             ← 이 문서 (프롬프트·스키마 원문의 단일 정의처)
lib/ai/toeic/
  prompts.ts                      ← 호출 A·B·C1~C5·D 시스템/사용자 프롬프트 + 호출 옵션 + 사진 프롬프트 접미사
  schemas.ts                      ← JSON Schema(strict) + zod + 타입 + 상한 상수(단일 정의)
  extract-merge.ts                ← 판독 결과 DAY별 묶기·번호 병합 순수 함수
  points.ts                       ← 발화 포인트 병합("빈 자리만" / 강제 다시 만들기) 순수 함수
lib/toeic-quiz.ts                 ← 표현 시험 출제·보기·빈칸(순수, lib/ai 밖 — 클라이언트 import 가능)
lib/toeic-mock.ts                 ← 모의고사 형식표·단계 전이·지시문(순수)
lib/toeic-score.ts                ← Q1–2 대조·추정 점수·등급(순수)
lib/toeic-image.ts                ← 관문 P (서버 전용)
lib/toeic-transcribe.ts           ← 관문 T (서버 전용)
lib/toeic-*-contract.ts           ← 라우트↔화면 경계 타입(클라이언트 import 안전)
lib/toeic-record.ts               ← 렌더 가능 판정 단일 정의처
lib/mic-session.ts                ← 녹음(클라이언트 전용): 오디오 세션 전환·MediaRecorder·WAV 정규화
lib/toeic-rec-store.ts            ← 녹음 IndexedDB 보관(클라이언트 전용)
app/toeic/**                      ← 화면
app/api/toeic/**                  ← 라우트
scripts/eval-toeic.ts             ← 오프라인 검증 + spec-sync + (게이트) 실호출 점검
```

---

## 2. 호출 A — 표현집 판독 (vision)

### 2-0. 무엇을 판독하는가

토익스피킹 표현 암기장 한 페이지(예: 해커스 "토익스피킹 핵심 표현 암기장" — DAY 번호·주제, 번호 붙은 표현 14개, 하단 QUIZ 2문항). 표현 항목은 **영어 표현(형광펜) · 한국어 뜻 · 영어 예문 · 예문 해석**, QUIZ는 **우리말 문장 · 괄호 힌트 · 모범답변(표현 굵게)**이다. 다른 책은 예문이 없을 수 있으므로 예문·해석은 nullable이다.

- **사진 1장 = 호출 1회**, 여러 장이면 `Promise.allSettled`로 병렬(영어 단어장 판독 관용구). 전부 실패할 때만 500, 결과가 0개면 200 `{ok:false, reason:"retake"}`.
- 이미지 전달·크기는 은우 단어장과 같다 — 클라이언트 자르기·리사이즈(`lib/image-resize.ts`) → base64 data URL(`lib/upload-limits.ts`), 최대 8장.
- **원문 전사는 SPEC §1 "원문 전사 금지"의 예외**다(SPEC §14-2 단어장과 같은 근거 — 가족이 가진 교재를 학습용으로 옮긴다). 사진 원본은 저장하지 않는다.

### 2-1. 시스템 프롬프트 (원문 그대로 사용)

> 구현 시 `lib/ai/toeic/prompts.ts`의 `TOEIC_EXTRACT_SYSTEM_PROMPT`와 **바이트 단위로 일치**해야 한다(`scripts/eval-toeic.ts`의 `SPEC_SYNC_TARGETS`가 대조).

```
너는 토익스피킹 표현 암기장 페이지를 판독하는 조교다. 사진에 보이는 글자를 그대로 옮겨 적는다 — 고치거나 지어내지 않는다.

[페이지 구조]
- 한 페이지에는 보통 DAY 번호와 주제(예: "DAY 5 쇼핑"), 번호가 붙은 표현 항목들, 하단의 QUIZ(우리말을 영어로 말하기 + 모범답변)가 있다.
- 표현 항목 하나는 번호(01, 02 …), 영어 표현(형광펜으로 강조된 부분), 한국어 뜻, 영어 예문, 예문의 한국어 해석으로 이뤄진다.
- 책마다 구성이 조금 다를 수 있다. 예문이나 해석이 없는 항목은 그 필드를 null로 둔다.

[판독 규칙]
- 사진에 있는 글자만 옮긴다. 철자·문법이 틀려 보여도 고치지 않는다. 문장부호·대소문자·아포스트로피도 보이는 그대로 쓴다.
- expression에는 강조된 영어 표현 부분만 쓴다. meaningKo에는 표현 바로 옆의 한국어 뜻을 괄호 설명까지 그대로 쓴다(예: "(짐, 상자 등을) ~에 싣다").
- example에는 영어 예문 전체를, exampleKo에는 그 아래 한국어 해석 전체를 쓴다. 줄바꿈으로 끊긴 문장은 공백 하나로 이어 쓴다(줄 끝 하이픈으로 끊긴 단어는 하이픈 없이 잇는다).
- no에는 항목 앞 번호를 정수로 쓴다(01 → 1). 번호가 없으면 null.
- 사진 가장자리에서 잘린 항목은 보이는 부분만 쓰고 partial을 true로 둔다. 읽기 어려운 글자가 있으면 confidence를 낮춘다(high / medium / low).
- 종이 뒷면이 비쳐 보이는 흐린 글자는 판독하지 않는다. 이 페이지에 인쇄된 글자만 옮긴다.

[QUIZ]
- 하단 QUIZ의 각 문항마다 우리말 문장(promptKo), 괄호 속 힌트(hint — 괄호는 빼고 안의 내용만, 예: "분수대: fountain", 없으면 null), 그 문항의 모범답변 영어 문장(modelAnswer)을 짝지어 쓴다.
- keyExpressions에는 모범답변에서 굵게 강조된 표현이 이 페이지의 어느 표현 항목인지, 그 항목의 expression 문자열을 그대로 적는다. 없으면 빈 배열.
- QUIZ가 없으면 quiz는 빈 배열이다.

[페이지 정보]
- dayNo에는 DAY 번호를 정수로 쓴다(없으면 null). topicKo에는 DAY 옆 주제 글자를 그대로 쓴다(없으면 null).
- 표현 암기장 페이지가 아니면(다른 종류의 페이지나 사진) isExpressionPage를 false로 두고 entries와 quiz를 빈 배열로 둔다.

[금지]
- 사진에 없는 표현·예문·해석을 만들지 않는다. 뜻을 풀어 쓰거나 요약하지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 2-2. 사용자 메시지

사진마다 `[imagePart(dataUrl), textPart(아래 문장)]` 순서(이미지 먼저 — 영어 단어장 관용구).

```
이 페이지의 표현 항목과 QUIZ를 판독해줘.
```

호출 옵션: temperature 0, maxOutputTokens 12000, call 라벨 `toeic_extract`.

### 2-3. JSON Schema (strict)

HARNESS §1 규약: 전 필드 `required`, 모든 객체 `additionalProperties: false`, 선택 필드는 `["type","null"]`. **배열 개수 제약은 JSON Schema에 넣지 않는다**(프롬프트 + zod).

```json
{
  "name": "toeic_expr_extraction",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["isExpressionPage", "dayNo", "topicKo", "entries", "quiz"],
    "properties": {
      "isExpressionPage": { "type": "boolean" },
      "dayNo": { "type": ["integer", "null"] },
      "topicKo": { "type": ["string", "null"] },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["no", "expression", "meaningKo", "example", "exampleKo", "partial", "confidence"],
          "properties": {
            "no": { "type": ["integer", "null"] },
            "expression": { "type": "string" },
            "meaningKo": { "type": "string" },
            "example": { "type": ["string", "null"] },
            "exampleKo": { "type": ["string", "null"] },
            "partial": { "type": "boolean" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
          }
        }
      },
      "quiz": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["no", "promptKo", "hint", "modelAnswer", "keyExpressions"],
          "properties": {
            "no": { "type": ["integer", "null"] },
            "promptKo": { "type": "string" },
            "hint": { "type": ["string", "null"] },
            "modelAnswer": { "type": "string" },
            "keyExpressions": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  },
  "strict": true
}
```

### 2-4. zod + 병합 후처리

zod가 잡을 것(상한 상수는 `schemas.ts`에 한 번만 정의):

- `isExpressionPage=false`면 `entries`·`quiz`가 비어야 한다.
- `entries` 사진당 0~30개, 같은 사진 안에서 `no` 중복 금지(null은 중복으로 보지 않는다), `no`·`dayNo`는 1~999.
- `expression` 1~80자, 라틴 문자 포함, **한글 금지**. `meaningKo` 1~80자, **한글 포함** — 단 **`partial=true`(잘린) 항목은 빈 `meaningKo`를 받는다**. 뜻이 사진 밖에 있을 수 있는데 1자 이상을 강제하면 재요청이 모델에게 사진에 없는 뜻을 지어내라고 떠민다(§2-1 "보이는 부분만"과 충돌). 빈 뜻은 초안에 빈칸으로 남고 검토 화면에서 사람이 채운다. 비어 있지 않으면 규칙은 같다.
- `example`이 있으면 3~300자, 라틴 문자 포함, 한글 금지. `exampleKo`가 있으면 한글 포함. **`example`이 null이면 `exampleKo`도 null**.
- `quiz` 0~6개. `promptKo` 한글 포함, `modelAnswer` 라틴 포함·한글 금지, `hint`는 null 또는 1~60자.
- **판독 zod와 저장 zod는 다르다.** 판독은 사진에 있는 그대로를 받는 자리라 위 두 가지를 거부하지 않는다 — 잘린 항목의 빈 뜻, 같은 사진 안 표현 중복(검토 화면이 `findDuplicateExpressionIndexes`로 표시한다). 저장(`POST /api/toeic/sets`)과 가져오기(§7-6)는 뜻이 비었거나 세트 안에 같은 표현이 있으면 거부한다(§7-1).

코드 후처리(순수 함수, `lib/ai/toeic/extract-merge.ts`):

1. **공백 정리**: 모든 문자열의 연속 공백을 하나로, 앞뒤 공백 제거(판독이 줄바꿈을 흘린 경우 흡수).
2. **keyExpressions 정리**: 같은 **DAY 묶음**(후처리 3)의 병합된 `entries[].expression`과 대소문자·연속 공백 무시로 일치하는 것만 남기고 표기를 항목 쪽으로 맞춘다. 같은 표현이 두 번이면 한 번만 남긴다. 일치하지 않는 것은 **버린다**(거부 아님 — 교차 참조 실수로 재요청을 태우지 않는다). 대조 범위를 사진이 아니라 묶음으로 잡는 이유: 한 페이지를 두 장으로 나눠 찍으면 QUIZ와 그 표현이 서로 다른 사진에 있을 수 있다. 같은 사진에서 일치하는 것은 묶음에서도 일치하므로, 사진 단위 대조보다 버리는 것만 줄어든다. 저장 라우트도 같은 함수(`cleanKeyExpressions`)로 저장할 세트의 표현과 대조한다.
3. **DAY별 묶기**: `dayNo`가 같은 사진끼리 한 묶음(겹쳐 찍은 같은 페이지·두 장으로 나눠 찍은 한 페이지). `dayNo`가 null인 사진은 각자 한 묶음.
4. **묶음 안 병합**: 조인 키는 `no`, 없으면 `expression.toLowerCase()`. 대표본은 완전본(`partial=false`) → 내용이 긴 것 → 사진 번호가 낮은 것. `confidence`는 최고값, `partial`은 모든 멤버가 partial일 때만 true. `no` 오름차순 정렬, 빠진 번호(`missingNos`)를 보고한다. QUIZ도 같은 방식(키 `no`, 없으면 `promptKo`).
5. 결과는 **초안**(`ToeicSetDraft[]`)이다. 저장하지 않는다 — 사용자가 검토 화면에서 고친 뒤 저장한다(§8).

---

## 3. 호출 B — 발화 포인트

### 3-0. 무엇을 만드는가

표현마다 "이 표현을 시험 답변에서 어떻게 꺼내 쓰는가"를 카드에 싣는다. 필드와 쓰임:

| 필드 | 내용 | 화면·시험에서 |
|---|---|---|
| `exampleSpan` | 교재 예문 속 표현의 실제 구간(활용형 그대로) | 예문 하이라이트, **빈칸 시험**(§6)의 정답 |
| `coreKo` | 시험 어느 장면에서 점수가 되는지 한 줄 | 카드 머리말 |
| `useIn[]` | 문항(part)별 바로 말할 수 있는 영어 문장 + 해석, 2~3개 | 카드 본문·🔊, **말하기 시험**(§6)의 문제 |
| `frames[]` | `___` 자리가 있는 답변 틀 1~3개 | 카드 |
| `variations[]` | 바꿔 쓸 콜로케이션·확장형 2~4개 | 카드·🔊 |
| `pronunciationKo` | 연음·강세 팁 | 카드 |
| `pitfallKo` / `grammarKo` | 흔한 실수 / 문법 포인트(없으면 null) | 카드 |
| `followUp` | 답변 시간을 채우는 이어 말하기 한 문장 | 카드·🔊 |

- **7개씩 끊어 병렬 호출**한다(14개 한 번이면 출력이 길어 60초 상한에 가깝다). 한 묶음이 실패해도 나머지는 저장된다.
- **발화 포인트는 부수 효과다.** 판독 원문이 본체이고, 포인트가 비어 있어도(`points: null`) 카드·시험(뜻·표현 모드)은 동작한다. 저장 직후 자동으로 한 번 부르고(best-effort), 상세 화면에 "발화 포인트 만들기/다시 만들기"를 둔다.

### 3-1. 시스템 프롬프트 (원문 그대로 사용)

> 구현 시 `TOEIC_POINTS_SYSTEM_PROMPT`와 바이트 일치.

```
너는 한국인 성인 학습자의 TOEIC Speaking 고득점(IH~AL)을 돕는 전문 강사다. 표현 암기장의 표현마다, 그 표현을 실제 시험 답변으로 바로 꺼내 쓸 수 있게 해 주는 "발화 포인트"를 만든다. 학습자는 성인이다 — 아이 눈높이로 낮추지 않는다. 설명은 한국어로 짧고 실용적으로 쓰고, 영어는 시험 답변으로 그대로 말할 수 있는 자연스러운 구어체로 쓴다(과한 관용구나 속어는 쓰지 않는다).

[입력]
- 표현마다 index(목록 안의 위치), 영어 표현(expression), 한국어 뜻(meaningKo), 교재 예문(example)과 해석(exampleKo)을 받는다. 예문이 없으면 null이다.
- 받은 표현마다 정확히 하나의 결과를 같은 index로 낸다. 교재 원문은 고치지 않는다.

[TOEIC Speaking 문항]
- q1_2 지문 읽기: 광고·안내방송 지문을 소리 내어 읽는다.
- q3_4 사진 묘사(30초): 장소 → 중심 인물의 동작(현재진행형) → 주변 사람과 사물(There is ~, 상태를 나타내는 수동태) → 느낌 순서로 말한다. 위치 표현(On the left side of the picture, In the background 등)을 곁들인다.
- q5_7 듣고 답하기(15·15·30초): 지인 통화나 전화 설문에 1인칭으로 빈도·장소·동행·선호와 이유를 말한다.
- q8_10 정보 활용(15·15·30초): 일정표나 안내문을 보고 담당자로서 정보를 전달한다. 표의 표기를 사람이 주어인 문장으로 바꿔 말한다("You will ~", "We offer ~", "According to the schedule, ~", "I'm sorry, but ~").
- q11 의견 말하기(60초): 입장을 밝히고 이유와 경험 예시로 뒷받침한다("I think ~ because ~", "I agree that ~").

[표현마다 만들 것]
- exampleSpan: 교재 예문 안에서 이 표현이 실제로 쓰인 가장 짧은 연속 구간을 예문에서 그대로 복사한다(활용형과 사이에 낀 단어 포함). 예: 표현 "hang a poster", 예문 "A woman is hanging a poster on the wall, and ..." → "hanging a poster" / 표현 "covered with snow", 예문 "The roof of the cabin is covered with fresh snow." → "covered with fresh snow". 대소문자와 아포스트로피도 예문과 똑같이 쓴다. 예문이 null이면 null.
- coreKo: 이 표현이 시험의 어느 장면에서 점수가 되는지 한 줄(한국어, 70자 이내).
- useIn: 이 표현이 실제로 자연스럽게 쓰이는 문항 2~3개를 자주 쓰이는 순서로 고르고, 문항마다 그 답변에 그대로 말할 수 있는 영어 문장 하나(sentence, 6~32단어)와 자연스러운 해석(sentenceKo)을 쓴다. 문항(part)은 서로 달라야 한다. 문장에는 이 표현을 활용형으로 넣고, 교재 예문을 그대로 베끼지 않는다. 어울리지 않는 문항에 억지로 넣지 않는다(예: 사물 명사를 q11에 넣지 않는다). q1_2는 광고·안내방송 문체가 자연스러울 때만 고른다.
- frames: 이 표현을 끼워 넣는 재사용 가능한 답변 틀 1~3개. 표현이 들어갈 자리를 "___"로 표시한다(90자 이내). 예: "The man in the middle is ___.", "I think ___ because ___."
- variations: 바꿔 쓸 수 있는 콜로케이션·확장형·유사 표현 2~4개(en)와 그 뜻(ko).
- pronunciationKo: 연음·강세·발음 팁 한 줄(한국어, 110자 이내). 틀린 연음이나 강세를 지어내지 않는다.
- pitfallKo: 한국인이 이 표현에서 자주 틀리는 점(관사·전치사·시제·단복수·자동사와 타동사 등)이 실제로 있으면 한 줄(110자 이내), 없으면 null.
- grammarKo: 알아 두면 좋은 문법 포인트가 있으면 한 줄(110자 이내), 없으면 null.
- followUp: 이 표현으로 한 문장 말한 뒤 답변 시간을 채우는 이어 말하기 영어 문장 하나(en)와 해석(ko).

[금지]
- 교재의 표현과 예문을 고치거나 바꿔 쓰지 않는다. 받지 않은 표현을 추가하지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 3-2. 사용자 메시지

```
주제: {topicKo ?? "없음"}
표현 목록(JSON):
{JSON.stringify(chunk.map(e => ({ index, expression, meaningKo, example, exampleKo })))}
```

- `index`는 **세트 전체의 entries 배열 위치**다(묶음 안 위치가 아니다). 교재 번호(`no`)는 null일 수 있어 조인 키로 쓰지 않는다.
- 호출 옵션: temperature 0.5, maxOutputTokens 9000, call 라벨 `toeic_points`.

### 3-3. JSON Schema (strict)

```json
{
  "name": "toeic_speaking_points",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["index", "exampleSpan", "coreKo", "useIn", "frames", "variations", "pronunciationKo", "pitfallKo", "grammarKo", "followUp"],
          "properties": {
            "index": { "type": "integer" },
            "exampleSpan": { "type": ["string", "null"] },
            "coreKo": { "type": "string" },
            "useIn": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["part", "sentence", "sentenceKo"],
                "properties": {
                  "part": { "type": "string", "enum": ["q1_2", "q3_4", "q5_7", "q8_10", "q11"] },
                  "sentence": { "type": "string" },
                  "sentenceKo": { "type": "string" }
                }
              }
            },
            "frames": { "type": "array", "items": { "type": "string" } },
            "variations": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["en", "ko"],
                "properties": {
                  "en": { "type": "string" },
                  "ko": { "type": "string" }
                }
              }
            },
            "pronunciationKo": { "type": "string" },
            "pitfallKo": { "type": ["string", "null"] },
            "grammarKo": { "type": ["string", "null"] },
            "followUp": {
              "type": "object",
              "additionalProperties": false,
              "required": ["en", "ko"],
              "properties": {
                "en": { "type": "string" },
                "ko": { "type": "string" }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

### 3-4. zod + 후처리

zod는 **입력 묶음을 알고 만든다**(`buildPointsZod(inputs)` — exampleSpan·index 대조에 입력이 필요하다):

- `items`의 `index` 집합이 입력 index 집합과 **정확히 같다**(누락·중복·모르는 index 거부 → 재요청 1회).
- `exampleSpan`: 입력 `example`이 null이면 null이어야 하고, 아니면 **`example`의 부분 문자열**(대소문자 구분)이어야 한다.
- `coreKo` 4~70자 한글 포함. `useIn` 2~3개, `part` 중복 금지, `sentence` 6~32단어·220자 이내·라틴 포함·한글 금지, 입력 `example`과 같으면 거부(대소문자·연속 공백 무시 — 대소문자만 바꾼 복사도 막는다), `sentenceKo` 한글 포함·160자 이내.
- `frames` 1~3개, 각 5~90자, **`___` 포함**. `variations` 2~4개, `en` 2~60자 한글 금지, `ko` 1~60자 한글 포함.
- `pronunciationKo` 6~110자. `pitfallKo`·`grammarKo`는 null 또는 4~110자. `followUp.en` 10~200자 한글 금지, `followUp.ko` 4~160자 한글 포함.

후처리(`lib/ai/toeic/points.ts`, 순수):

- **기본은 빈 자리만 채운다** — `points`가 null인 항목에만 넣는다. 사용자가 "다시 만들기"(`force`)를 누른 경우만 덮어쓴다. 포인트는 시험 채점 기준이 아니지만(숙련도는 `expression` 키로 센다, §6-2), 사용자가 보던 문장이 말없이 바뀌지 않게 한다.
- 묶음 호출이 재요청 뒤에도 실패하면 그 묶음의 항목은 null로 남기고 `remaining`으로 보고한다(부분 성공).
- `enriched = entries.every(e => e.points !== null)`.

---

## 4. 호출 C — 모의고사 문항 생성 (C1~C5)

### 4-0. 무엇을 만드는가

현행 TOEIC Speaking(2022-06 개정 이후) 11문항 한 세트를 **파트 5개 호출**로 나눠 만든다. 형식·시간은 §6-4 형식표가 단일 정의다.

| 호출 | 파트 | 문항 | 만드는 것 |
|---|---|---|---|
| C1 | `read` | Q1–2 지문 읽기 | 지문 2개 + 끊어 읽기 단위 + 강세 단어 + 발음 팁 |
| C2 | `picture` | Q3–4 사진 묘사 | 장면 2개(사진 생성 프롬프트·장면 설명) + 모범답변 + 묘사 포인트 |
| C3 | `respond` | Q5–7 듣고 답하기 | 상황 소개 + 질문 3개 + 모범답변·요령 |
| C4 | `info` | Q8–10 정보 활용 | 표(일정표 등) + 전화 건 사람 도입 + 질문 3개 + 모범답변·요령 |
| C5 | `opinion` | Q11 의견 말하기 | 질문 + 모범답변 + 답변 뼈대 |

- 5개를 `Promise.allSettled`로 **병렬** 호출한다. 실패한 파트는 null로 저장하고 "이 파트 다시 만들기"로 채운다(부분 성공). 사용자가 파트를 골라 만들 수도 있다(유형 연습).
- **입력 세 가지**(사용자 메시지): 목표 등급(IM3·IH·AL), 주제 힌트(표현집 세트의 `topicKo`들 + 사용자가 고른 주제), **활용할 표현**(표현집에서 최대 24개 — 숙련도가 낮은 것 우선, 없으면 무작위). 표현집이 비었으면 "없음".
- **기출 금지**: 실제 기출·ETS 공식 샘플을 베끼지 않는다(저작권, §0-2). 형식과 난이도만 맞춘다.
- 공통 시스템 프롬프트 머리말(`TOEIC_MOCK_COMMON`)에 파트별 과제 절을 이어 붙여 **파트마다 완결된 시스템 프롬프트 5개**를 만든다. spec-sync 대상은 이어 붙인 결과가 아니라 **아래 코드블록 6개 각각**(머리말 1 + 파트 5)이고, 구현은 `TOEIC_MOCK_COMMON + "\n\n" + TOEIC_MOCK_<PART>_TASK`로 조립한다.
- 호출 옵션: temperature 0.8, maxOutputTokens 6000, call 라벨 `toeic_mock_<part>`.

### 4-1. 공통 머리말 (원문 그대로 사용 — `TOEIC_MOCK_COMMON`)

```
너는 TOEIC Speaking 시험 형식을 잘 아는 문항 출제자다. 한국인 성인 수험자가 실전처럼 연습할 모의 문항을 새로 만든다.

[공통 규칙]
- 실제 기출 문항이나 ETS 공식 샘플 문항을 베끼거나 옮기지 않는다. 형식과 난이도만 맞추고 소재와 문장은 새로 쓴다.
- 영어는 북미 표준의 자연스러운 문장으로 쓴다. 회사·사람·장소 이름은 지어낸 것을 쓴다(실존 기업이나 유명인을 쓰지 않는다).
- 모범답변(sampleAnswer)은 받은 목표 등급(IM3 / IH / AL)의 수험자가 제한 시간 안에 실제로 말할 수 있는 길이와 수준으로 쓴다. 목표 등급이 높을수록 문장 연결과 어휘를 다양하게 한다.
- '활용할 표현' 목록을 받으면 모범답변에 그중 자연스럽게 어울리는 것만 쓴다(억지로 넣지 않는다). 쓴 표현은 usedExpressions에 원래 표현(expression — 목록의 문자열 그대로)과 모범답변 속 실제 구간(span — 모범답변에서 그대로 복사한 연속 구간)으로 적는다. 쓰지 않았으면 빈 배열이다.
- 한국어 설명은 짧고 실용적으로 쓴다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 4-2. C1 `read` — Q1–2 지문 읽기 (`TOEIC_MOCK_READ_TASK`)

```
[과제: Q1–2 지문 읽기]
- 소리 내어 읽을 지문 정확히 2개를 만든다. 두 지문은 종류(kind)가 달라야 한다 — advertisement(광고), announcement(공공장소 안내방송), news(라디오·뉴스 소식), introduction(행사·인물 소개), tour(투어 안내), voicemail(자동 응답 메시지) 중에서 고른다.
- 지문 하나는 80~110단어, 문장 4~7개로 쓴다. 실제 시험처럼 고유명사 1~2개, 숫자·시각·가격 중 하나 이상, 세 항목 이상의 나열(A, B, and C) 하나를 넣는다.
- chunks: 지문을 끊어 읽을 의미 단위(thought group)로 나눈 배열이다. chunks를 공백 하나로 이어 붙이면 text와 정확히 같아야 한다.
- stressWords: 강하게 읽어야 할 내용어 6~12개를 지문에 있는 형태 그대로 쓴다.
- tipsKo: 이 지문에서 주의할 발음·억양 팁 2~4개(한국어). 나열 억양(앞 항목은 올리고 마지막은 내린다), 고유명사와 숫자 읽기, 까다로운 단어의 발음 같은 것을 짚는다.
- 지문 읽기에는 모범답변과 활용할 표현을 쓰지 않는다.
```

### 4-3. C2 `picture` — Q3–4 사진 묘사 (`TOEIC_MOCK_PICTURE_TASK`)

```
[과제: Q3–4 사진 묘사]
- 묘사할 사진 장면 정확히 2개를 설계한다. 두 장면은 장소(place)가 달라야 한다(거리, 공원, 상점, 식당, 카페, 사무실, 회의실, 공항, 기차역, 호숫가 등). 주제 힌트를 받으면 그와 어울리는 장소를 먼저 고른다.
- 장면마다 성인이 2~5명 있고, 사람마다 동작과 옷차림이 분명하며, 배경과 주변 사물이 3개 이상 있다. 30초 동안 장소·인물·사물·느낌을 말할 거리가 충분해야 한다.
- imagePrompt: 이 장면을 사진으로 생성하기 위한 영어 프롬프트(60~120단어). 사람 수와 위치(왼쪽·가운데·오른쪽·배경), 각자의 동작과 옷 색, 주변 사물, 날씨와 빛을 구체적으로 적는다. 글자·간판 문구·로고·유명인·어린이는 넣지 않는다.
- sceneKo: 사진을 보여 줄 수 없을 때 대신 보여 줄 장면 설명(한국어 2~3문장).
- sampleAnswer: 30초 답변 모범답안(영어 5~7문장, 60~90단어). "This picture was taken ~"으로 장소를 말하고 → 중심 인물의 동작(현재진행형) → 주변 사람과 사물(위치 표현, There is ~, 상태를 나타내는 수동태) → 느낌이나 추측 순서로 말한다. imagePrompt에 적은 장면과 어긋나는 내용을 말하지 않는다.
- keyPointsKo: 이 사진에서 놓치지 말아야 할 묘사 포인트 3~5개(한국어).
```

### 4-4. C3 `respond` — Q5–7 듣고 답하기 (`TOEIC_MOCK_RESPOND_TASK`)

```
[과제: Q5–7 듣고 답하기]
- 상황 하나를 만든다: 마케팅 회사의 전화 설문에 응하는 상황, 또는 지인과 전화로 이야기하는 상황이다. 주제는 일상생활(쇼핑, 음식, 여가, 여행, 교통, 주거, 운동, 공부, 일 등)에서 고르고, 주제 힌트를 받으면 그중에서 고른다.
- topicKo: 이 상황의 주제를 한국어 한두 단어로 쓴다.
- intro: 상황 소개 영어 1~2문장이다("Imagine that ~" 형식, 문장은 새로 쓴다).
- questions: 정확히 3개. 첫째와 둘째(각 15초)는 빈도·시간·장소·동행 같은 사실형 질문이고, 둘 중 하나 이상은 두 부분짜리 질문(~, and ~?)이다. 셋째(30초)는 이유를 요구하는 선택·의견·묘사형 질문이다. 세 질문은 같은 주제로 이어진다.
- 질문마다 sampleAnswer: 첫째·둘째는 2~3문장(25~45단어), 셋째는 4~6문장(55~85단어). 질문의 시제를 따르고, 직답을 먼저 한 뒤 이유나 부연을 붙인다.
- 질문마다 tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-5. C4 `info` — Q8–10 정보 활용 (`TOEIC_MOCK_INFO_TASK`)

```
[과제: Q8–10 제공된 정보로 답하기]
- 표 하나를 만든다. 종류(kind)는 schedule(행사·컨퍼런스 일정), itinerary(출장·여행 일정), timetable(수업·워크숍 시간표), interview(면접 일정), resume(이력서) 중 하나다.
- 표는 제목(title), 날짜·장소·가격 같은 머리 정보(meta, 1~4줄), 행(rows, 5~9개 — left에는 시간·기간·항목, right에는 내용), 각주(notes, 0~2줄, 예: "* Lunch is not included.")로 구성한다.
- callerIntro: 이 표에 대해 전화를 건 사람의 도입 발화다(영어 1~2문장, 이름과 용건).
- questions: 정확히 3개, 전화 건 사람이 묻는 질문이다. 첫째(15초)는 시간·장소·가격 같은 세부 정보, 둘째(15초)는 전화 건 사람이 잘못 알고 있는 정보를 확인하고 정정하게 하는 질문, 셋째(30초)는 조건에 맞는 항목 둘 이상을 모두 말하게 하는 질문이다. 답은 반드시 표 안에서 찾을 수 있어야 한다.
- 질문마다 sampleAnswer: 담당자로서 표의 표기를 사람이 주어인 문장으로 바꿔 말한다(예: "Fee: $10" → "You have to pay 10 dollars."). 첫째·둘째는 1~3문장, 셋째는 시간 순서 연결어(first, then, after that)로 3~5문장이다.
- 질문마다 tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-6. C5 `opinion` — Q11 의견 말하기 (`TOEIC_MOCK_OPINION_TASK`)

```
[과제: Q11 의견 말하기]
- 의견 질문 하나를 만든다. 형식(kind)은 agree(찬반 — Do you agree or disagree with the following statement?), choice(둘 중 선택), proscons(장단점) 중 하나다. 직장, 교육, 기술, 생활 방식처럼 성인이 경험으로 답할 수 있는 주제로 쓰고, 끝에 이유와 예를 들어 답하라는 요구 문장을 붙인다.
- sampleAnswer: 60초 답변 모범답안(영어 110~150단어). 입장 → 첫째 이유와 개인 경험 예시 → 둘째 이유 → "For these reasons, ~" 마무리 순서다. 처음부터 끝까지 한 입장을 유지한다.
- outlineKo: 답변 뼈대(한국어) 3~5줄 — 입장, 이유 1, 예시, 이유 2, 마무리.
- tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).
```

### 4-7. 사용자 메시지 (C1~C5 공통)

```
목표 등급: {IM3|IH|AL}
주제 힌트: {topicHints를 ", "로, 없으면 "없음"}
활용할 표현: {expressions를 " / "로, 없으면 "없음"}
```

### 4-8. JSON Schema (strict) — 파트별 5개

usedExpressions 항목 모양은 파트 공통이다: `{ "expression": string, "span": string }`.

```json
{
  "name": "toeic_mock_read",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "text", "chunks", "stressWords", "tipsKo"],
          "properties": {
            "kind": { "type": "string", "enum": ["advertisement", "announcement", "news", "introduction", "tour", "voicemail"] },
            "text": { "type": "string" },
            "chunks": { "type": "array", "items": { "type": "string" } },
            "stressWords": { "type": "array", "items": { "type": "string" } },
            "tipsKo": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_picture",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["place", "imagePrompt", "sceneKo", "sampleAnswer", "keyPointsKo", "usedExpressions"],
          "properties": {
            "place": { "type": "string" },
            "imagePrompt": { "type": "string" },
            "sceneKo": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "keyPointsKo": { "type": "array", "items": { "type": "string" } },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_respond",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["topicKo", "intro", "questions"],
    "properties": {
      "topicKo": { "type": "string" },
      "intro": { "type": "string" },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["question", "sampleAnswer", "tipKo", "usedExpressions"],
          "properties": {
            "question": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "tipKo": { "type": "string" },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_info",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["table", "callerIntro", "questions"],
    "properties": {
      "table": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "title", "meta", "rows", "notes"],
        "properties": {
          "kind": { "type": "string", "enum": ["schedule", "itinerary", "timetable", "interview", "resume"] },
          "title": { "type": "string" },
          "meta": { "type": "array", "items": { "type": "string" } },
          "rows": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["left", "right"],
              "properties": {
                "left": { "type": "string" },
                "right": { "type": "string" }
              }
            }
          },
          "notes": { "type": "array", "items": { "type": "string" } }
        }
      },
      "callerIntro": { "type": "string" },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["question", "sampleAnswer", "tipKo", "usedExpressions"],
          "properties": {
            "question": { "type": "string" },
            "sampleAnswer": { "type": "string" },
            "tipKo": { "type": "string" },
            "usedExpressions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression", "span"],
                "properties": {
                  "expression": { "type": "string" },
                  "span": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "strict": true
}
```

```json
{
  "name": "toeic_mock_opinion",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "question", "sampleAnswer", "outlineKo", "tipKo", "usedExpressions"],
    "properties": {
      "kind": { "type": "string", "enum": ["agree", "choice", "proscons"] },
      "question": { "type": "string" },
      "sampleAnswer": { "type": "string" },
      "outlineKo": { "type": "array", "items": { "type": "string" } },
      "tipKo": { "type": "string" },
      "usedExpressions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["expression", "span"],
          "properties": {
            "expression": { "type": "string" },
            "span": { "type": "string" }
          }
        }
      }
    }
  },
  "strict": true
}
```

### 4-9. zod + 후처리

zod는 **프롬프트보다 넓은 폭**으로 건다(프롬프트 "80~110단어"를 zod가 60~130으로 받는 식 — 경계에서 재요청을 태우지 않되, 크게 벗어난 것만 거부). 폭은 `schemas.ts`에 상수로 한 번만 정의한다.

- 공통: 영어 필드는 라틴 포함·한글 금지, `…Ko` 필드는 한글 포함. `usedExpressions`: `expression`이 입력 목록에 대소문자 무시로 있어야 하고, `span`이 그 `sampleAnswer`의 부분 문자열(대소문자 무시)이어야 한다 — **어긋난 항목은 후처리에서 버린다**(거부 아님).
- C1: `items` 정확히 2, `kind` 서로 다름, `text` 60~130단어, **`chunks.join(" ")` = `text`**(연속 공백을 하나로 접은 뒤 비교 — 어긋나면 거부), `stressWords` 4~14개·각각 `text`에 단어 경계로 존재(대소문자 무시 — 문장 첫머리 대문자 형태도 같은 단어), `tipsKo` 2~4.
- C2: `items` 정확히 2, `place` 서로 다름(대소문자·연속 공백 무시)·1~60자(언어는 정하지 않는다 — 프롬프트 예시가 한국어라 영어를 강제하지 않는다), `imagePrompt` 40~160단어, `sceneKo` 한글, `sampleAnswer` 40~110단어, `keyPointsKo` 3~5.
- C3: `questions` 정확히 3, 첫째·둘째 `sampleAnswer` 15~60단어, 셋째 35~110단어, 질문은 `?`로 끝남.
- C4: `rows` 4~10, `meta` 1~4, `notes` 0~3, `questions` 정확히 3, 첫째·둘째 `sampleAnswer` 5~60단어, 셋째 25~110단어. **표 칸(`meta`·`rows.left`·`rows.right`·`notes`)은 "비어 있지 않음 + 한글 금지"만 본다** — 시간(`9:00 – 9:30`)·가격(`$45`) 칸에는 라틴 글자가 없을 수 있어서, 공통 규칙("라틴 포함")을 걸면 정상 출력이 재요청을 태운다. `title`·`callerIntro`·질문·모범답변은 공통 규칙 그대로다.
- C5: `sampleAnswer` 80~180단어, `outlineKo` 3~5.
- 후처리: `usedExpressions` 정리(위) → 파트 결과를 `ToeicMockRecord.parts.<part>`로 옮긴다. C2는 `items[i].image = { status: "pending", imageId: null }`를 붙여 저장한다(관문 P가 채운다, §4-10).

### 4-10. 관문 P — Q3–4 사진 생성 (하네스 밖)

- `POST /api/toeic/mocks/[id]/image {slot: 0|1}` → `lib/toeic-image.ts`의 `generateSceneImage(prompt, signal)`. **사진 한 장 = 요청 하나**(60초 상한).
- 프롬프트 = C2 `imagePrompt`(앞뒤 공백 제거) + 공백 하나 + 아래 고정 접미사를 한 문단으로(`buildSceneImagePrompt` — 원문 그대로 `TOEIC_IMAGE_PROMPT_SUFFIX`, spec-sync 대상):

```
A realistic candid photograph for an English speaking test picture-description task. Natural colors and lighting, everyday adults, clear actions. No text, no signs with words, no logos, no watermarks, no children.
```

- 파라미터: 모델 `OPENAI_IMAGE_MODEL`(빈 값이면 `gpt-image-2`), 크기 1536×1024(가로), 품질 `OPENAI_IMAGE_QUALITY`(빈 값이면 `medium`), 출력 JPEG 압축 70. 결과 data URL이 **900,000자를 넘으면** 압축 50으로 1회 재생성, 그래도 넘으면 실패로 본다(Firestore 문서 1MB).
- 저장: `toeicImages` 컬렉션에 한 장 = 문서 하나(§7-4), 모의고사의 `picture.items[slot].image = {status:"ready", imageId}`. 실패하면 `{status:"failed"}` — 화면은 `sceneKo`를 대신 보여 주고 "사진 다시 만들기"를 띄운다.
- 응답을 못 받고 끊겨도(상한 초과) 서버는 끝까지 저장한다. 화면은 실패를 받으면 **한 번 새로 읽어 이미 저장됐는지 확인**한 뒤에만 실패로 표시한다.
- 키가 없으면 501. 사진은 `GET /api/toeic/images/[id]`로 내려준다(PIN 게이트 안, `cache-control: private`).

---

## 5. 호출 D — 답변 피드백 (+ 관문 T 전사, Q1–2 대조)

### 5-0. 흐름

응시가 끝나면 녹음은 기기(IndexedDB)에 남는다. 사용자가 **"AI 채점 받기"**를 누르면 문항마다(동시 2개):

1. 클라이언트가 녹음을 **16kHz mono 16-bit WAV로 정규화**(`lib/mic-session.ts`) — iOS Safari의 `audio/mp4`가 전사 API에서 형식 오류·잘림을 내는 보고가 반복돼, 서버에 ffmpeg가 없는 이 배포에서는 클라이언트 정규화가 안전하다. 디코드에 실패하면 원본을 그대로 올린다.
2. `POST /api/toeic/attempts/[id]/score` (multipart: `q`, `audio`) → 관문 T 전사(`language: "en"`, **기대 문장을 prompt로 넣지 않는다** — 전사가 모범답변 쪽으로 끌려가 점수가 부풀려진다).
3. 전사문 단어가 2개 미만이면 **호출 D 없이** 0점 "답변이 인식되지 않았어요"로 저장(무응답 기준 — 비용 절약).
4. Q1–2 → §5-4 대조(순수 함수). Q3–11 → 호출 D.
5. 결과를 응시 기록의 그 문항에 저장하고 돌려준다.

- 호출 D가 재요청 뒤에도 실패하면 **전사문은 먼저 저장**하고(점수 null) 실패를 알린다. 다시 누르면 전사 없이 저장된 전사문으로 호출 D만 한다 — 응시가 끝난 뒤 녹음은 바뀌지 않으므로 이미 낸 전사 비용을 두 번 내지 않는다. 이미 점수가 있는 문항은 AI를 부르지 않고 저장된 답을 돌려준다.

### 5-1. 시스템 프롬프트 (원문 그대로 사용 — `TOEIC_FEEDBACK_SYSTEM_PROMPT`)

```
너는 ETS TOEIC Speaking 채점 기준을 잘 아는 채점관 겸 코치다. 한국인 성인 수험자의 답변 전사문을 받아 공식 기준에 맞춰 점수를 매기고, 다음 답변을 더 잘하게 만드는 피드백을 한국어로 준다.

[입력]
- 문항 번호와 유형, 만점, 답변 시간, 수험자가 본 자료(질문·표·사진 설명), 참고용 모범답변, 활용할 표현 목록, 그리고 음성 인식으로 얻은 답변 전사문을 받는다.
- 전사문은 음성 인식 결과라 발음과 억양을 알 수 없고 인식 오류가 섞여 있을 수 있다. 발음과 억양은 평가하지 않는다. 인식 오류로 보이는 단어는 감점하지 말고 문맥으로 해석한다.
- 모범답변은 참고용이다. 모범답변과 다르다는 이유로 감점하지 않는다.

[채점]
- Q3–4(0~3): 사진의 주요 특징을 묘사했는가, 어휘와 문장 구조가 적절하고 생각이 이어지는가.
- Q5–7(0~3): 질문에 맞는 완전하고 적절한 답인가(관련성·완성도), 그리고 문법·어휘·일관성.
- Q8–10(0~3): 위 기준에 더해 표의 정보를 정확히 전달했는가, 표의 표기를 말하는 문장으로 바꿔 말했는가.
- Q11(0~5): 입장이 분명한가, 이유·세부·예시로 뒷받침했는가, 생각 사이의 관계가 분명한가, 그리고 문법·어휘. 이유 하나에 부연이 거의 없으면 3점 수준, 질문을 되읽거나 단어만 나열하면 1점 수준이다.
- 무응답이거나 영어가 아니거나 과제와 무관하면 0점이다.
- 제한 시간에 비해 답이 너무 짧으면 완성도에서 깎는다.

[피드백]
- summaryKo: 총평 1~2문장(한국어).
- strengths: 잘한 점 1~3개(한국어, 구체적으로).
- fixes: 고칠 문장 0~5개. said에는 전사문에서 그대로 복사한 구간을, better에는 같은 뜻의 올바르고 자연스러운 영어를, whyKo에는 이유 한 줄(문법·어휘·어색함·내용)을 쓴다. 인식 오류로 보이는 것은 고치지 않는다.
- missingKo: 내용상 빠진 것 0~3개(한국어, 예: "정정 정보(시작 시간 변경)를 말하지 않음").
- improvedAnswer: 수험자의 답변 내용을 살려 제한 시간 안에 말할 수 있게 고쳐 쓴 더 나은 답변(영어). 모범답변을 베끼지 않는다.
- tryExpressions: 받은 활용할 표현 목록 중 이 답변에 넣었으면 좋았을 표현 0~3개(목록의 문자열 그대로).

[금지]
- 전사문에 없는 말을 수험자가 했다고 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.
```

### 5-2. 사용자 메시지

```
문항: Q{n} ({유형 이름}) · 답변 시간 {초}초 · 만점 {3|5}
수험자가 본 자료:
{material}
모범답변(참고용):
{sampleAnswer}
활용할 표현: {목록을 " / "로, 없으면 "없음"}
답변 전사문:
{transcript}
```

`material`은 파트별로 코드가 만든다(순수 함수 `buildFeedbackMaterial`): Q3–4 = `sceneKo` + `keyPointsKo`, Q5–7 = `intro` + 그 질문, Q8–10 = 표 텍스트(제목·meta·rows "left — right"·notes) + `callerIntro` + 그 질문, Q11 = 질문. 호출 옵션: temperature 0.2, maxOutputTokens 2500, call 라벨 `toeic_feedback`.

- `material` 서식: 줄마다 한 가지를 쓰고 줄바꿈으로 잇는다. 라벨은 한국어다.
  - Q3–4: `사진 설명: {sceneKo}` → `묘사 포인트:` → 포인트마다 `- {keyPointsKo}`
  - Q5–7: `상황: {intro}` → `질문: {그 질문}`
  - Q8–10: `표: {title}` → meta 한 줄씩 → rows 한 줄씩 `{left} — {right}` → notes 한 줄씩 → `전화 건 사람: {callerIntro}` → `질문: {그 질문}`
  - Q11: `질문: {question}`
- Q1–2이거나 그 파트·문항이 레코드에 없으면 `material`은 null이고 호출 D를 부르지 않는다(Q1–2는 §5-4 대조). 모범답변은 그 문항의 `sampleAnswer`, 활용할 표현은 레코드의 `expressionsUsed` 그대로다(`buildFeedbackInput`).

### 5-3. JSON Schema (strict)

```json
{
  "name": "toeic_answer_feedback",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["score", "summaryKo", "strengths", "fixes", "missingKo", "improvedAnswer", "tryExpressions"],
    "properties": {
      "score": { "type": "integer" },
      "summaryKo": { "type": "string" },
      "strengths": { "type": "array", "items": { "type": "string" } },
      "fixes": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["said", "better", "whyKo"],
          "properties": {
            "said": { "type": "string" },
            "better": { "type": "string" },
            "whyKo": { "type": "string" }
          }
        }
      },
      "missingKo": { "type": "array", "items": { "type": "string" } },
      "improvedAnswer": { "type": "string" },
      "tryExpressions": { "type": "array", "items": { "type": "string" } }
    }
  },
  "strict": true
}
```

zod(`buildFeedbackZod({maxScore, transcript})`): `score` 정수 0~만점(Q11=5, 나머지 3), `summaryKo` 한글, `strengths` 1~3(빈 항목 거부), `fixes` 0~5·**`said`가 전사문에 있는 구간**(아래)·`better`·`whyKo` 빈 값 거부, `missingKo` 0~3, `improvedAnswer` 라틴·한글 금지, `tryExpressions`는 후처리에서 입력 목록에 있는 것만 남긴다.

- **`said` 대조**(`isSaidInTranscript` → `lib/toeic-text.ts` `containsWordSequence`): 양쪽을 소문자로 바꾸고, 문자·숫자·아포스트로피 밖의 글자(문장부호·하이픈·기호)를 공백으로 바꾸고, 연속 공백을 접는다. 그다음 said의 단어열이 전사문 단어열 안에 **연속으로, 같은 순서로, 단어 경계에서** 있어야 한다.
  - 무시하는 것: 대소문자·연속 공백·문장부호. 전사 모델은 문장부호를 붙여 내고 LLM은 인용하며 쉼표를 자주 떨어뜨린다. 문장부호까지 맞추게 하면 멀쩡한 인용이 재요청을 태우고, 끝내 그 문항 채점이 실패한다.
  - 그대로 보는 것: 단어와 그 순서. 전사문에 없는 단어, 순서를 바꾼 인용, 사이 단어를 뺀 이어 붙이기, 단어 조각으로 시작하는 인용은 **거부**한다 — 하지 않은 말을 고쳤다는 것은 환각이다.
  - 아포스트로피는 단어 안에서는 남긴다(`can't` ≠ `cant`, 둥근 따옴표 `’`는 `'`로 통일). 단어 앞뒤에 붙은 따옴표는 뗀다.
- **`tryExpressions` 후처리**(`postprocessFeedback`): 입력 목록에 대소문자·연속 공백 무시로 있는 것만 남기고 표기는 목록 쪽으로 맞춘다. 중복을 없애고 최대 3개로 자른다(프롬프트 "0~3개"). zod 거부가 아니라 후처리라 재요청을 태우지 않는다.

### 5-4. Q1–2 지문 대조 (AI 없음 — `lib/toeic-score.ts`)

- `alignReadAloud(text, transcript)`: 둘 다 소문자·문장부호 제거·숫자 표기 통일(0~100의 영어 단어 ↔ 숫자, `%`↔percent, `&`↔and) 뒤 단어 단위 편집거리 정렬 → `{accuracy, missing[], extra[], substituted[{expected, heard}]}`. `accuracy = 1 − (빠짐 + 치환)/지문 단어 수`(0 미만은 0).
- 문장부호 처리(`normalizeReadWords`)는 다음과 같다.
  - 대부분의 문장부호(하이픈·콜론 포함)는 띄어쓰기로 바꾼다(twenty-five → twenty five → 25). 아포스트로피는 지운다(don't → dont).
  - **글자 사이 마침표는 지운다**(p.m. → pm, a.m. → am, U.S. → us). 공백으로 바꾸면 "p m" 두 토큰이 돼 전사문의 "PM"과 어긋나고, 90단어 지문에서 한 단어가 깎여 3점이 2점이 될 수 있다(시각은 C1이 지문에 넣으라고 요구하는 요소다).
  - 숫자에 붙여 쓴 am·pm은 띄운다(7pm → 7 pm). 그래서 "7 p.m."·"7 PM"·"7pm"은 같은 단어열이 된다.
  - 문장 끝 마침표 뒤에 띄어 쓴 한 글자("Plan A. B")는 붙이지 않는다.
  - 이 모듈은 클라이언트 번들에 들어가므로 정규식 lookbehind를 쓰지 않는다.
- 참고 점수 `readProxyScore(accuracy)`: ≥0.95 → 3, ≥0.85 → 2, ≥0.6 → 1, 그 밖 0. 화면에 **"발음·억양은 채점하지 않았어요 — 녹음을 다시 들어 보세요"**를 함께 적는다.

### 5-5. 추정 총점 (`lib/toeic-score.ts`)

- 11문항 모두 점수가 있을 때만 계산한다(하나라도 없으면 null + "n문항 채점됨"). 문항 번호가 1~11 정수가 아니거나 점수가 정수 0~만점 밖이면 그 답은 채점되지 않은 것으로 센다 — 결과 화면이 예외로 깨지지 않게 던지지 않는다.
- `raw = Σ Q1–10(0~3) + Q11(0~5)`(만점 35) → `scaled = round10(raw / 35 × 200)` → ACTFL 구간(AH 200 · AM 180–190 · AL 160–170 · IH 140–150 · IM 110–130 · IL 90–100 · NH 60–80 · NM/NL 0–50).
- ETS 환산표는 비공개다. 화면에 **"추정(참고용)"**을 붙이고 구 Level 표기는 쓰지 않는다.
- raw 0~35 전 구간의 환산 점수·구간은 eval이 리터럴 표로 잠근다(반올림을 내림으로 바꾸면 raw 24가 IH 140 → IM 130으로 틀어지는데, 경계값 몇 개만 보면 이를 놓친다).

---

## 6. 표현 시험 · 모의고사 형식 (AI 없음)

### 6-1. 표현 시험 — 네 가지 모드

| 모드 | 문제 | 정답 | 오답 보기 | 출제 조건 |
|---|---|---|---|---|
| `ko-to-expr` | 한국어 뜻 | 표현 | 같은 세트의 다른 표현(**뜻이 같은 표현은 뺀다**) | — |
| `expr-to-ko` | 표현 | 한국어 뜻 | 같은 세트의 다른 뜻(정답과 같은 뜻은 뺀다) | — |
| `cloze` | 교재 예문의 `exampleSpan`을 `_____`로 가린 문장 + **예문 해석** | `exampleSpan` | 같은 세트의 다른 `exampleSpan`(없으면 표현, **뜻이 같은 항목은 뺀다**) | 예문과 `exampleSpan`이 있을 때 |
| `speak` | 우리말 문장 → **소리 내어 영어로 말하기** | 모범 문장(보기 없음) | — | 교재 QUIZ + 발화 포인트 `useIn` |

- 5지선다 세 모드는 `lib/vocab-quiz.ts`의 `buildChoices`를 **그대로 재사용**한다(언어 중립). 순수 출제 함수는 `lib/toeic-quiz.ts`(lib/ai 밖 — 클라이언트 조립 가능).
- **오답 보기 거르기** — 맞는 답이 오답 보기로 나와 틀린 것으로 채점되고 숙련도에 오답으로 쌓이는 경로를 막는다. `buildChoices`는 은우 공유 함수라 고치지 않고(§10), 넘기기 전에 `lib/toeic-quiz.ts`가 후보를 거른다.
  - 같은 표현(대소문자·연속 공백 무시)인 다른 항목은 어느 모드에서도 오답 후보가 아니다. 같은 항목이기 때문이다.
  - `ko-to-expr`·`cloze`에서는 정답과 **뜻이 같은**(연속 공백·대소문자 무시) 항목의 표현·구간을 뺀다. 같은 뜻을 보여 주고 둘 중 하나를 고르라면 정답이 둘이다. `cloze`도 예문 해석이 정답을 정하므로, 뜻이 같은 구간은 똑같이 들어맞는다.
  - `expr-to-ko`에서는 정답과 같은 뜻을 보기에서 뺀다.
  - 보기는 같은 정규화 키로 중복을 접는다. 대소문자만 다른 `exampleSpan` 두 개가 "같아 보이는 보기 둘"로 나오지 않게 한다.
  - 보기는 최대 5개이고, 후보가 모자라면 있는 만큼 낸다. 거른 뒤 보기가 **2개 미만**(정답 하나뿐)이면 그 문항은 출제하지 않는다(`skipped`). 보기가 정답 하나뿐인 문항은 무조건 맞아서 "연속 2회 정답 졸업"을 거짓으로 채운다. 이 판정은 rng와 무관하다 — 모드 고르기 화면이 미리 센 문항 수가 실제 세션과 같다.
- `cloze`는 해석을 함께 보여 준다 — 같은 세트의 다른 구간도 문법적으로 들어맞을 수 있어서(예: "A woman is ___ on the wall"에 "fixing a clock"도 맞는다), 해석이 정답을 하나로 정한다.
- `speak`는 **자기 채점**이다: 문제(한국어) → 사용자가 말한다 → "정답 보기" → 모범 문장 표시·🔊 → "말했어요 ⭕ / 못 했어요 ❌". 한 세션 최대 10문항 — 교재 QUIZ 먼저, 그다음 숙련도 낮은 표현의 `useIn`. 항목 키는 표현(`useIn`)이거나 QUIZ의 첫 `keyExpressions`(없으면 `quiz:{no}`).
- `speak` 세션 조립(`buildToeicSpeakSession`)의 세부는 다음과 같다.
  - QUIZ 항목 키: 첫 `keyExpressions` → 없으면 `quiz:{no}` → 번호도 없으면 `quiz:{promptKo}`.
  - 한 세션 안에서 같은 키는 한 번만 낸다. QUIZ가 이미 어떤 표현 키를 썼으면 그 표현의 `useIn`은 건너뛴다.
  - `useIn` 문항은 `useIn`이 있는 표현마다 하나씩, 그 표현의 `useIn` 중 하나를 무작위로 고른다. 발화 포인트가 없는 표현은 나오지 않는다.
  - `useIn` 순서는 **말하기 모드 통계만** 보고 정한다(다른 모드 통계는 섞지 않는다, §6-2). 말하기에서 틀렸고 아직 졸업 전 → 안 해 봄 → 틀린 적 없이 진행 중 → 졸업 순이다. 같은 순위 안에서는 오답이 많은 것이 먼저고, 그래도 같으면 무작위다.
- **소리**: 문제를 소리로 읽지 않는다(표현을 읽으면 정답이 샌다 — 일본어 러너 관용구). 답을 고른 뒤 표현(또는 `speak` 모범 문장)을 en-US로 읽는다. 한국어를 영어 음성으로 읽는 실수를 막기 위해 lang을 항상 명시한다.
- 세션: 모드 고르기 화면(기본 5지선다 3모드 혼합) + `speak`는 따로. `?wrong=<mode>` 오답 재시험, `?t=` 다시 풀기 논스(일본어 관용구).

### 6-2. 기록·숙련도

- 세션 레코드는 일본어와 같은 모양, **컬렉션 `toeicQuizzes`로 분리**(§7-3). 혼합 세션은 모드별로 나눠 모드마다 POST 1건(모드별 무오염).
- 모드별 POST 중 일부만 실패하면 "다시 저장"은 **아직 저장되지 않은 모드만** 보낸다(끝난 시각도 첫 시도 값 그대로). 성공한 모드를 다시 보내면 같은 세션이 두 벌 쌓이고, 한 번 맞힌 것이 "연속 2회 정답"으로 세어져 거짓 졸업이 난다.
- 집계는 `aggregateWordStats`·`isStatMastered`(연속 2회 정답 졸업)를 어댑터로 **재사용**하고 **모드별로** 낸다 — 뜻은 아는데 말로 못 꺼내는 상태가 흔하다. `speak` 통계가 `ko-to-expr`를 오염시키면 "안다"는 판정이 거짓이 된다.
- 오답노트(모드 탭)·시험 기록 화면은 일본어 골격(`ja-quiz-wrong-view`·`ja-quiz-history-view`)을 따른다.

### 6-3. 전체 듣기 (낭독)

- 대본은 순수 함수 `buildToeicListenScript(set, mode)` → `{text, lang, entryIndex}[]`, 재생은 `speakQueue`(SPEC §18 관용구 — 탭 안에서 동기 호출, `onItem`으로 지금 읽는 카드 강조·스크롤, 큐가 돌려준 stop만 쓴다).
- 모드: ① **표현·뜻·예문**(기본: 표현 en → 뜻 ko → 예문 en) ② **활용 문장까지**(①에 `useIn` 문장 en 추가) ③ **영어만**(표현·예문·`useIn`·`followUp` — 따라 말하기용).
- 300자를 넘는 조각은 문장 단위로 나눈다 — `splitForTts`를 공용 모듈(`lib/tts-split.ts`)로 옮기고 `lib/ja-coaching-script.ts`는 재수출한다(동작 변화 0, `eval:speech` 통과 유지).
- 속도(`TtsSpeedControl`)·엔진(`TtsEngineControl lang="en-US"`)은 은우와 **전역 설정을 공유**한다(언어 베이스 단위 — 기존 규약).

### 6-4. 모의고사 형식표 (단일 정의 — `lib/toeic-mock.ts`)

| Q | 파트 | 화면 | 소리 | 표 읽기 | 준비 | 답변 | 질문 재생 |
|---|---|---|---|---|---|---|---|
| 1–2 | `read` | 지시문 + 지문 | 파트 지시문 | — | 45초 | 45초 | — |
| 3–4 | `picture` | 지시문 + 사진 | 파트 지시문 | — | 45초 | 30초 | — |
| 5–7 | `respond` | 상황 소개 + 질문 텍스트 | 지시문·소개·질문 | — | 3초 | 15 / 15 / 30초 | 1회 |
| 8–10 | `info` | **표만**(질문 텍스트는 숨김) | 지시문·도입·질문 | 45초(Q8 전 1회) | 3초 | 15 / 15 / 30초 | Q8·Q9 1회, **Q10 2회** |
| 11 | `opinion` | 질문 텍스트 | 지시문·질문 | — | 45초 | 60초 | 1회 |

- 문항 하나의 단계: `directions`(파트 첫 문항만) → `reading`(Q8 앞만) → `question`(음성) → `prep` → `beep` → `answer`(녹음) → 다음 문항. 전이·남은 시간 계산은 순수 함수(`nextPhase`)로, 종료 시각(epoch ms) 기반이다(운동 세션 타이머 관용구).
- **지시문은 이 앱의 문장**이다(ETS 원문을 옮기지 않는다). 각 파트 지시문은 `lib/toeic-mock.ts`에 상수로 한 번만 둔다.
  - 모양은 `TOEIC_PART_DIRECTIONS[part] = {en, ko}`다. 실제 시험처럼 **영어(`en`)를 en-US로 읽고**, 같은 뜻의 **한국어(`ko`)는 화면 캡션**으로 함께 보인다. 한국어를 소리로 읽지 않으며, 읽을 때는 lang을 항상 명시한다(`TOEIC_DIRECTIONS_LANG`).
  - 지시문 속 숫자(지문·사진·질문 수, 준비·답변·표 읽기 초, Q10 재생 횟수)는 형식표에서 계산해 넣는다. 그래서 형식표를 바꾸면 지시문이 따라 바뀌고, 숫자가 두 벌로 어긋나지 않는다.
- 질문 음성이 끝내 재생되지 않으면 그 문항을 멈추고 **"다시 듣기"·"질문 보기"** 버튼을 띄운다(Q8–10은 평소 텍스트를 숨긴다). 판정은 `speakQueue`의 끝 사유만으로 하지 않는다 — 1~2조각 큐는 전부 무음이어도 `"done"`으로 끝나기 때문에, `onEnd`의 둘째 인자 `{ sounded }`(소리를 낸 조각 수)로 순수 함수 `toeicSpeechOutcome`(`lib/toeic-mock.ts`)이 다시 판정한다. 질문은 조각 하나라도 무음이면 멈추고, 지시문은 전부 무음일 때만 멈춘다.
- 마이크 대기에는 상한이 있다(`lib/mic-session.ts`의 `MIC_*_TIMEOUT_MS` — 답변 녹음의 `getUserMedia` 8초, 시작 전 마이크 점검 15초, 녹음기 start 5초, stop 3초). 상한을 넘기면 캡처 계수를 되돌리고 오디오 세션을 `"playback"`으로 되돌린다. 늦게 도착한 스트림은 즉시 트랙을 멈춘다 — 응답 없는 권한 요청 하나 때문에 세션이 시험 내내 `play-and-record`에 갇히지 않게 한다.
- 녹음 규칙(`lib/mic-session.ts`): **재생과 마이크 캡처를 시간상 겹치지 않는다** — 질문 음성·비프가 끝난 뒤 `navigator.audioSession.type = "play-and-record"`(지원 시) → `getUserMedia` → `MediaRecorder.start()` → 답변 타이머는 녹음 `start` 이벤트에서 시작 → 끝나면 `stop()` → 트랙 `stop()` → **그다음에** `"playback"`(녹음 중에 바꾸면 트랙이 끊긴다). 녹음 중 화면이 숨겨지면 즉시 멈추고 "중단됨"으로 표시한다. 시작 탭에서 동기로 오디오 컨텍스트·재생 잠금 해제·질문 음성 프리페치·마이크 점검을 한다.
- 녹음은 기기(IndexedDB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`)에만 두고 **최근 응시 5회분**만 남긴다. 다른 기기·브라우저에서는 "녹음은 응시한 기기에만 있어요"로 안내한다.
- 유형 연습: 파트 하나만 같은 형식으로 응시한다(`scope: "part"`).

---

## 7. 저장 모델

`lib/store.ts` 새 레코드 추가 체크리스트 12항목(인터페이스·`New*`·`StudyStore` 메서드·`DbShape`·`emptyDb`·`readDb` 하위호환 방어·`normalize*` 단일 정의처·파일 구현·Firestore `to*` 변환기·`assertDestructiveAllowed`+`DestructiveOp`·렌더 판정 모듈·`mergeDbForSeed`)를 **전부** 밟는다. 선택 키(`?`) 금지 — 전부 필수 nullable. 컬렉션 5개 — `toeicSets`·`toeicQuizzes`·`toeicMocks`·`toeicImages`·`toeicAttempts` — 은우·일본어 컬렉션과 섞지 않는다.

### 7-1. `ToeicSetRecord` — 표현집 한 DAY

```ts
type ToeicPart = "q1_2" | "q3_4" | "q5_7" | "q8_10" | "q11";

interface ToeicSpeakingPoints {        // 호출 B (§3)
  exampleSpan: string | null;
  coreKo: string;
  useIn: { part: ToeicPart; sentence: string; sentenceKo: string }[];
  frames: string[];
  variations: { en: string; ko: string }[];
  pronunciationKo: string;
  pitfallKo: string | null;
  grammarKo: string | null;
  followUp: { en: string; ko: string };
}

interface ToeicExprEntry {
  no: number | null;                   // 교재 번호
  expression: string;                  // 교재 원문
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  points: ToeicSpeakingPoints | null;  // 없으면 null(best-effort)
  confidence: "high" | "medium" | "low";
  partial: boolean;
}

interface ToeicBookQuiz {              // 교재 하단 QUIZ
  no: number | null;
  promptKo: string;
  hint: string | null;
  modelAnswer: string;
  keyExpressions: string[];            // 이 세트 entries[].expression 중 하나씩
}

interface ToeicSetRecord {
  id: string;
  titleKo: string;                     // 기본 "DAY {n} {topicKo}"
  dayNo: number | null;
  topicKo: string | null;
  source: "photo" | "import";
  presetKey: string | null;            // 가져오기 멱등 키(§7-6). 사진이면 null
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
  photoCount: number;                  // 판독에 쓴 사진 수(원본은 저장하지 않음). 가져오기면 0
  enriched: boolean;                   // entries 전부 points !== null
  model: string | null;                // 판독 모델. 가져오기면 null
  createdAt: string;
  sortIndex: number | null;
}
```

- 상한(`schemas.ts` 단일 정의): 세트당 entries 1~60, quiz 0~12, `titleKo` 1~120자.
- **세트 안 표현은 서로 달라야 한다**(대소문자·연속 공백 무시 — `lib/toeic-text.ts` `expressionKey`). 항목 키가 곧 표현이라(§6-1) 같은 표현이 두 항목이면 두 항목이 숙련도 통계를 나눠 쓴다. 그러면 한 세션에서 두 문항을 맞힌 것이 "연속 2회 정답"이 되고, 오답노트는 뒤 항목의 뜻만 보여 준다. 판정은 `findDuplicateExpressionIndexes`(첫 등장은 빼고 두 번째부터의 위치) 하나를 저장 라우트·가져오기 zod(§7-6)·검토 화면이 같이 쓴다. 오류는 두 번째 항목의 `expression` 경로에 건다. 판독 zod는 거부하지 않는다(§2-4).
- 저장되는 `meaningKo`는 언제나 비지 않는다 — 판독 초안의 빈 뜻(잘린 항목, §2-4)은 사람이 채워야 저장된다.

### 7-2. `ToeicMockRecord` — 모의고사 한 세트

```ts
type ToeicTargetGrade = "IM3" | "IH" | "AL";
type ToeicMockPart = "read" | "picture" | "respond" | "info" | "opinion";

interface ToeicMockRecord {
  id: string;
  titleKo: string;                     // 기본 "모의고사 {n}" 또는 사용자 수정
  targetGrade: ToeicTargetGrade;
  expressionsUsed: string[];           // 호출 C에 넘긴 활용할 표현(재현·피드백 입력)
  topicHints: string[];                // 호출 C에 넘긴 주제 힌트(파트 다시 만들기가 같은 입력을 쓴다)
  parts: {
    read: ToeicReadPart | null;        // C1 결과(실패·미선택이면 null)
    picture: ToeicPicturePart | null;  // C2 + items[i].image {status: "pending"|"ready"|"failed", imageId: string|null}
    respond: ToeicRespondPart | null;  // C3
    info: ToeicInfoPart | null;        // C4
    opinion: ToeicOpinionPart | null;  // C5
  };
  model: string;
  createdAt: string;
  sortIndex: number | null;
}
```

파트 타입은 §4-8 스키마 결과 그대로(+ C2의 `image`). 완전한 11문항 세트 = 다섯 파트가 모두 non-null.

- **빈 파트만 채운다.** "이 파트 다시 만들기"(`[id]/regenerate?part=`)는 null인 파트만 채우고, 이미 있는 파트는 덮지 않는다(409). 보던 모범답변과 응시 기록이 가리키는 문항이 말없이 바뀌지 않게 하려는 것이다. 입력은 처음과 같다(`targetGrade`·`topicHints`·`expressionsUsed`). `topicHints`가 없는 이전 문서는 빈 배열로 읽는다.
- **사진은 먼저 준비된 것이 이긴다.** `picture.items[slot].image`가 `ready`면 다른 `ready`로도 `failed`로도 바꾸지 않는다. 사진 문서 생성과 칸 갱신은 한 원자 단위다(파일 `mutate`, Firestore `runTransaction`). 그래서 두 요청이 같은 칸을 동시에 만들어도 한 장만 남고, 쓰지 않은 사진 문서(고아)가 생기지 않는다.

### 7-3. `ToeicQuizRecord` — 표현 시험 세션

```ts
type ToeicQuizMode = "ko-to-expr" | "expr-to-ko" | "cloze" | "speak";
interface ToeicQuizRecord {
  id: string; setId: string;
  mode: ToeicQuizMode;
  startedAt: string; finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];  // word = 항목 키(§6-1)
}
```

append 전용(수정·삭제 API 없음). 세트를 지우면 그 세트의 세션도 지운다.

### 7-4. `ToeicImageRecord` — Q3–4 생성 사진

```ts
interface ToeicImageRecord {
  id: string; mockId: string; slot: 0 | 1;
  dataUrl: string;                     // image/jpeg base64, ≤ 900,000자
  model: string; createdAt: string;
}
```

AI가 만든 사진이라 "원본 사진 미저장"(SPEC §13, 사용자가 올린 사진) 규칙의 대상이 아니다. 모의고사를 지우면 함께 지운다.

### 7-5. `ToeicAttemptRecord` — 모의고사 응시

```ts
interface ToeicFeedback {              // 호출 D 결과(§5-3) 그대로
  score: number; summaryKo: string; strengths: string[];
  fixes: { said: string; better: string; whyKo: string }[];
  missingKo: string[]; improvedAnswer: string; tryExpressions: string[];
}
interface ToeicReadDiff {              // §5-4
  accuracy: number; missing: string[]; extra: string[];
  substituted: { expected: string; heard: string }[];
}
interface ToeicAnswer {
  q: number;                           // 1..11
  recorded: boolean;                   // 녹음이 끝까지 됐는가
  durationMs: number | null;
  transcript: string | null;           // 관문 T
  readDiff: ToeicReadDiff | null;      // Q1–2만
  feedback: ToeicFeedback | null;      // Q3–11만
  score: number | null;                // Q1–2 = readProxyScore, Q3–11 = feedback.score
  scoredAt: string | null;
}
interface ToeicAttemptRecord {
  id: string; mockId: string;
  scope: "full" | "part";
  parts: ToeicMockPart[];
  startedAt: string; finishedAt: string | null;   // null = 중간에 그만둠
  answers: ToeicAnswer[];
}
```

- 응시 시작에 레코드를 만들고(녹음 IndexedDB 키로 id가 필요하다), 끝나거나 그만둘 때 `answers`의 `recorded`·`durationMs`를 채운다. 채점은 문항별로 그 문항만 갱신한다(파일: `mutate`, Firestore: 문서 읽기 → 그 문항만 바꿔 쓰기 — 같은 응시의 두 문항이 동시에 채점돼도 서로 덮지 않게 `runTransaction`).
- 시작할 때 `answers`는 빈 배열이고, 끝/그만두기가 **응시 범위의 모든 문항**을 채운다(녹음 안 된 문항은 `recorded:false`). 그래서 "닫힌 응시" = `finishedAt !== null || answers.length > 0`이다(`lib/toeic-attempt-rules.ts`). 끝/그만두기는 **한 번만** 받는다 — 이미 닫힌 응시에 다시 오면 409(`already_finished`)로 거절하고 쓰지 않는다(판정은 원자 단위 안). 재시도·다른 탭의 늦은 요청이 "끝까지"를 "중단"으로 바꾸거나 채점된 문항의 `recorded`를 뒤집지 못하게 하려는 것이고, 화면은 409를 성공으로 본다. 채점은 닫힌 응시의 녹음된 문항에만 한다(아니면 409).
- 모의고사를 지우면 응시 기록도 지운다.

### 7-6. 교재 10쪽 미리 넣기 — "파일로 가져오기"

- 전사본: `data/private/toeic-hackers-day1-10.raw.json`(Claude가 사진을 직접 판독 — OpenAI 호출 없음), 발화 포인트: `data/private/toeic-points/day{N}.json`(호출 B 규칙대로 저작·교차 검증), 둘을 합친 가져오기 파일: `data/private/toeic-preset-hackers-core.json`. **모두 git 밖**(`data/`는 gitignore, `.gcloudignore`도 제외).
- 파일 형식 `{ "format": "toeic-sets/v1", "sets": [ { presetKey, titleKo, dayNo, topicKo, entries, quiz } ] }` — entries·quiz는 §7-1 모양(points 포함), zod로 호출 B·A와 **같은 규칙**을 적용해 검증한다(exampleSpan ⊂ example 등).
- 가져오기 zod(`toeicImportFileSchema`)가 호출 A·B 규칙에 더해 거는 것은 다음과 같다. 가져오기는 저장과 같은 자리라 판독보다 엄격하다.
  - `presetKey`: 소문자·숫자 조각을 하이픈 하나로 잇는 형식(`^[a-z0-9]+(-[a-z0-9]+)*$`, 예 `vendor-core-day01`), 최대 80자, 파일 안에서 중복 금지.
  - `sets` 1~100개. 모르는 최상위 키(출처 메모 등)는 버린다.
  - QUIZ `no` 중복 금지(null은 중복으로 보지 않는다).
  - **`keyExpressions`는 그 세트 `entries[].expression`과 글자 그대로 같아야 한다 — 어긋나면 거부**한다(판독의 "버림"과 다르다). 가져오기에는 사람이 고칠 검토 화면도 후처리도 없으므로, 저장 불변식(§7-1 `keyExpressions` 주석)을 입구에서 지킨다.
  - 세트 안 표현 중복 거부(§7-1).
  - `partial=true`여도 `meaningKo`가 비면 거부한다(빈 뜻 허용은 판독 초안에만, §2-4).
  - 400 응답의 `issues`에는 경로와 규칙 문구만 싣는다. 값은 싣지 않는다(교재 원문이 응답·로그에 새지 않게).
- `POST /api/toeic/sets/import` — 같은 `presetKey`가 이미 있으면 건너뛴다(**멱등**). 응답 `{created, skipped}`. 목록 화면의 "파일로 가져오기"가 부른다. 프로덕션에 넣는 것은 사용자가 앱에서 파일을 고르는 행동이다 — 로컬에서 프로덕션 DB로 쓰지 않는다(CLAUDE.md 서문).

---

## 8. 화면·경로

```
/toeic                          아빠의 영어 허브 (표현집 / 모의고사)
/toeic/sets                     표현집 목록 (관리모드 삭제·순서변경, 사진으로 추가, 파일로 가져오기)
/toeic/sets/new                 사진 N장 → 판독 → DAY별 검토·수정 → 저장 → 발화 포인트(best-effort)
/toeic/sets/[id]                표현 카드(원문 + 발화 포인트) · 전체 듣기 · 교재 QUIZ · 시험 버튼
/toeic/sets/[id]/quiz           시험 (5지선다 3모드 혼합 / 말하기)
/toeic/sets/[id]/wrong          오답노트 (모드 탭)
/toeic/sets/[id]/history        시험 기록
/toeic/mocks                    모의고사 목록 + 새로 만들기(목표 등급·파트·주제)
/toeic/mocks/[id]               모의고사 학습 보기(자료·모범답변·🔊) + 응시(실전 11문항 / 유형 연습) + 응시 기록
/toeic/mocks/[id]/take          응시 화면(전면 오버레이 — 타이머·질문 음성·녹음)
/toeic/attempts/[id]            응시 결과(내 녹음 ▶ · 전사 · 점수 · 피드백 · 모범답변 · AI 채점 받기 · 추정 등급)

/api/toeic/sets/extract         호출 A (사진별 병렬, 저장 없음)
/api/toeic/sets                 POST 저장 · import · reorder · [id] DELETE/rename · [id]/points(호출 B) · [id]/quiz
/api/toeic/mocks                POST 생성(호출 C 파트별 병렬) · reorder · [id] DELETE/rename · [id]/regenerate?part= · [id]/image(관문 P) · [id]/attempts
/api/toeic/images/[id]          GET 생성 사진
/api/toeic/attempts/[id]        finish · score(관문 T + 호출 D / Q1–2 대조)
```

- 셸은 일본어 방식이다 — 공통 레이아웃 없이 페이지마다 `u-navbtn` "← 상위" 헤더(`/toeic`은 "← 과목 선택"). `EnglishNav`(은우 셸)를 쓰지 않는다.
- 홈(`app/page.tsx`)의 아빠 줄에 **"아빠의 영어"**를 추가한다 — 아빠 줄은 일본어·영어 한 줄 + 운동 한 줄(`sm:col-span-2`).
- 목록·상세·시험·오답·기록은 일본어 골격(`ja-vocab-library-view`·`ja-quiz-runner`·`ja-quiz-picker`·`ja-quiz-wrong-view`·`ja-quiz-history-view`)을 따르되 **토익 전용 컴포넌트로 새로 둔다**(은우 `vocab-quiz-view`는 URL·문구·TTS 언어가 박혀 있어 재사용하면 오염된다).
- 표현 카드: 표현(🔊) · 뜻 · 예문(🔊, `exampleSpan` 하이라이트) · 해석 · [발화 포인트: `coreKo` · 문항 배지 달린 `useIn`(🔊) · 틀 · 바꿔 쓰기(🔊) · 발음 · 함정 · 문법 · 이어 말하기(🔊)]. 포인트가 없으면 "발화 포인트 만들기" 버튼.
- 사진 판독 검토 화면: DAY별 묶음, 표현·뜻·예문·해석·QUIZ를 **고칠 수 있다**(판독 오류를 사람이 잡는 자리), 잘림·흐림 칩, 빠진 번호, 실패한 사진 수를 사실대로 알린다.
  - 저장 라우트가 거부할 것을 **저장 전에** 짚는다 — 세트 안 같은 표현(§7-1, `findDuplicateExpressionIndexes`로 앞 항목 번호까지)과 잘린 항목의 빈 뜻(§2-4, 고치기 칸을 처음부터 연다). 고칠 곳이 남은 묶음은 저장 대상에서 빠지고 그 사실을 버튼 아래에 알린다.
  - 저장 응답의 `droppedKeyExpressions`(검토에서 표현을 고치거나 빼서 QUIZ가 가리킬 표현을 잃은 수)가 있으면 곧장 넘어가지 않고 완료 화면에서 묶음별로 알린다. QUIZ 문장은 남는다. 표현 연결이 모두 풀린 QUIZ의 말하기 항목 키는 QUIZ 번호가 된다(§6-1).
  - "다시 읽기"는 다시 눌러 나아질 때만 보인다 — 네트워크 예외, `retriable:true` 500, 본문이 JSON이 아닌 5xx(게이트웨이). 키 없음(501)·입력 오류(400)는 이유만 알린다.
- 응시 화면: 문항 번호·파트·단계·남은 시간을 크게, 준비 중에는 메모장(선택), 녹음 중에는 레벨 미터. 마이크 거부·미지원이면 **"녹음 없이 연습"**(타이머만)으로 계속할 수 있다.
- 응시 결과: 추정 등급은 "추정(참고용)", Q1–2는 "발음·억양은 채점하지 않았어요". 녹음이 이 기기에 없으면 AI 채점 버튼을 막고 이유를 말한다.
- 진단 캡션(선택 표시): 마지막 녹음의 mimeType·길이·크기·정규화 여부·전사 상태(SPEC §16-5의 TTS 진단 관용구) — 서버 로그를 못 보는 폰에서 판정하려고.

---

## 9. eval (`scripts/eval-toeic.ts`)

- **오프라인(기본, 무비용)**: zod 반례(exampleSpan이 예문 밖·index 누락/중복·useIn part 중복·frames에 `___` 없음·chunks 불일치·stressWords가 지문에 없음·feedback `said`가 전사문 밖·순서 바꿈·사이 단어 뺌·단어 조각(쉼표 하나 빠진 인용은 통과)·점수 범위·잘린 항목의 빈 뜻은 판독만 통과·세트 안 표현 중복은 가져오기에서 거부), 후처리(keyExpressions 정리·DAY 묶기·번호 병합·usedExpressions 정리·빈 자리만 채우기), 시험 출제(모드별 조건·보기 5개 상이·정답 포함·뜻이 같은 표현과 대소문자만 다른 보기 제외·보기 2개 미만이면 출제 불가·`cloze` 가림·`speak` 항목 키), **모드별 숙련도 분리**(반례로 잠금), 형식표·단계 전이(Q10 2회 재생·Q8 앞 표 읽기 45초·파트 첫 문항만 지시문), Q1–2 대조(숫자 표기 통일·약어 마침표 p.m. = PM·빠짐/치환 계산), 추정 총점(raw 0~35 전 구간 리터럴 표·정수 아닌 문항 번호 방어)·등급 구간, 스트릭 트랙 분리(은우·일본어·운동·영어가 서로 섞이지 않음), **가져오기 파일 검증**(`data/private/toeic-preset-hackers-core.json`이 있으면 zod 통과·10세트·140표현·20 QUIZ, 없으면 SKIP — 공개 저장소에 없으므로 CI 기준은 SKIP).
- **spec-sync**: 호출 A·B·C(머리말 + 파트 5)·D의 시스템 프롬프트·사용자 메시지 형식·사진 프롬프트 접미사를 이 문서와 **바이트 대조**, JSON Schema 8개는 **의미 동치**(JSON.parse → deepEqual, 일본어 관용구).
- **실호출 점검(게이트)**: `EVAL_TOEIC=1`일 때만 — 호출 A(사진 1장)·B(7개)·C(파트 1개)·D(픽스처 전사문 1개). 비용이 드는 검증은 **사용자 동의 후 오케스트레이터가 실행**한다.

---

## 10. 재사용과 분기 경계

**그대로 재사용(수정 0):** `buildChoices`(`lib/vocab-quiz.ts`), `aggregateWordStats`·`isStatMastered`(`lib/vocab-mastery.ts`, 어댑터 경유), `callWithSchema`·`imagePart`·`textPart`(과목 분기 금지), 사진 파이프(`ImageCropper`·`lib/image-crop.ts`·`lib/image-resize.ts`·`lib/upload-limits.ts`), `useReorder`·`lib/reorder-contract.ts`, `speak`·`speakQueue`·`prefetchSpeech`·`unlockSpeechPlayback`·`TtsSpeedControl`·`TtsEngineControl`, `prod-guard`, `lib/kst.ts`, `STREAK_REFRESH_EVENT`·`computeStreak`.

**옮겨서 공유(동작 변화 0):** `splitForTts` → `lib/tts-split.ts`(`lib/ja-coaching-script.ts`는 재수출).

**새로 두는 것(은우·일본어를 고치지 않는다):** 프롬프트 전량(은우 쪽은 초등 눈높이가 하드코딩), 표현 엔트리 모양(`word`/`pos`/`ipa` 대신 `expression`/`meaningKo`/`points`), 시험 모드·러너·오답·기록 화면, 컬렉션 5개, 녹음 모듈(`lib/mic-session.ts` — 저장소 첫 녹음 경로), 모의고사 타이머(운동 세션의 종료 시각 타이머·예약 비프·Wake Lock **관용구를 따라 새로** 쓴다 — 운동 코드는 이번에 건드리지 않는다: 실기기 검증이 끝난 경로라 회귀 위험을 지지 않는다).

**알려진 한계:** 클라우드 TTS의 en-US 지시문이 "young learner" 톤이라 시험 음성이 실제보다 느리고 또박또박하다. 지시문을 바꾸면 `TTS_INSTRUCTIONS_VERSION`이 올라가 **전 언어 캐시가 비워진다**(SPEC §16-5) — 이번 범위에서는 바꾸지 않고, 필요하면 속도 조절(1.15)로 보완한다.

---

## 11. 로드맵

| 단계 | 내용 | AI 호출 | 비고 |
|---|---|---|---|
| **T0** | 스캐폴딩 — 홈 진입, `/toeic` 허브, 컬렉션 5개, 스트릭 "영어" 트랙, `splitForTts` 공용화 | 0 | 기존 화면 회귀 0 |
| **T1** | 표현집 — 호출 A·B + 사진 판독 흐름 + 파일 가져오기 + 목록·상세(카드·전체 듣기·QUIZ) | A·B | 교재 10쪽은 가져오기 파일로 |
| **T2** | 표현 시험 4모드 + 오답노트 + 기록 | 0 | 순수 함수 재사용, 모드별 숙련도 분리 |
| **T3** | 모의고사 만들기 — 호출 C(파트 5 병렬) + 관문 P(사진) + 목록·학습 보기 | C·P | 파트별 부분 성공 |
| **T4** | 모의고사 응시 — 형식표 엔진·타이머·질문 음성·녹음·IndexedDB·응시 기록 | 0 | 실기기(iPhone) 확인 필수 |
| **T5** | AI 채점 — 관문 T + 호출 D + Q1–2 대조 + 추정 등급 + 결과 화면 | T·D | 버튼을 눌러야 비용 발생 |

T1·T2(표현집)와 T3~T5(모의고사)는 서로 독립이다(§0-4). 실제 의존은 T0 → 나머지, T3 → T4 → T5뿐이다. 각 단계는 오프라인 eval을 먼저 통과하고, 실호출 검증은 동의 후 1회로 묶는다.

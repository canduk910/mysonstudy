# 일본어(아빠의 일본어) — 구현 규칙

> `ai-harness-impl` 스킬에서 일본어 작업 시 읽는다. 영어는 `english-routes.md`, 발음·해설 낭독 같은 공통 기능은 `app-patterns.md`.
> 원문 스펙: `docs/harness/japanese.md` — 호출 A(§2)·B(§3)·C(§4)·D(§12-2), 후리가나 §5, 시험 §6, 저장 §7, 화면·경로 §8, eval §9, 재사용 경계 §10, 해설 낭독 §13.
> 프롬프트 원문은 여기 옮기지 않는다. 스펙이 단일 정의처이고 `scripts/eval-japanese.ts`의 spec-sync가 바이트 대조한다.

목차: 1. 먼저 알 것 · 2. 호출 → client.ts 함수 · 3. 파일 역할과 eval의 관계 · 4. 후리가나 토큰 · 5. kana 조인키 · 6. 병렬·부분 성공·best-effort · 7. 라우트 목록 · 8. 계약 파일과 번들 경계 · 9. 재사용 경계 · 10. 저장 레코드 · 11. eval-japanese.ts · 12. 알려진 틈

## 1. 먼저 알 것

- **학습자가 아이가 아니라 아빠(성인)다**(§0-1). 영어 프롬프트의 "초등 눈높이·쉬운 말"은 하드코딩돼 있어 재사용할 수 없다 — 쉽게 풀면 JLPT 등급이 무너진다. 설명은 한국어, 학습 대상은 일본어 원문 그대로 둔다.
- **두 기능은 서로 독립이다**(§0-4). JLPT 단어장(A)과 대화 복습(B·C)은 진입·저장·레코드가 전부 갈리고, 만나는 자리는 대화 어휘를 "대화에서 모은 단어"에 담는 것(§7-5) 하나뿐이다. 한자(D)는 단어장에서 **파생**되지만 화면·컬렉션은 독립이다(§12).
- **영어 코드를 고치지 않는다**(§10). 일본어에 필요한 차이는 일본어 쪽에 새로 두고, 언어 중립으로 확인된 영어 자산은 수정 없이 재사용한다(9절).

## 2. 호출 → client.ts 함수

네 호출 모두 `lib/ai/client.ts`에 얇은 진입 함수가 있고, 프롬프트·스키마·옵션은 `lib/ai/japanese/`에서 import한다. **client에는 과목·레벨·배치 분기가 없다** — 나누고 병합하는 일은 라우트가 순수 함수로 한다.

| 호출 | 진입 함수 | 한 번에 만드는 것 | 로그 라벨 · 옵션 상수(`prompts.ts`) | 라우트가 앞뒤로 붙이는 순수 함수 |
|---|---|---|---|---|
| A JLPT 단어 생성 | `generateJapaneseVocab({level, topic, include, exclude, count})` | **레벨 1개분** | `ja-vocab` · `JA_VOCAB_CALL_OPTIONS`(temp 0.4, 8,000) | 앞 `planIncludeDistribution` → 뒤 `applyVocabPostprocess`(`vocab.ts`) |
| B 대화문 전사 (vision) | `extractJaDialog({images})` — 이미지 파트를 텍스트보다 먼저 | **배치 1개분** | `ja-dialog-extract` · `JA_DIALOG_EXTRACT_CALL_OPTIONS`(0, 8,000) | 앞 `planJaDialogBatches` → 뒤 `mergeJaDialogBatches`(`dialog.ts`) |
| C 대화 학습 해설 | `coachJaDialog({focusKo, turns})` | 대화 1개 | `ja-dialog-coach` · `JA_DIALOG_COACH_CALL_OPTIONS`(0.5, 8,000) | 없음(실패해도 전사는 남는다) |
| D 한자 정보 생성 | `generateKanjiInfo({items})` | **10자 배치 1개분** | `ja-kanji` · `JA_KANJI_CALL_OPTIONS`(0.2, 3,000) | 앞 `collectKanjiFromBooks`·`selectKanjiToEnrich` → 뒤 `applyKanjiPostprocess`(`kanji.ts`) |

진입 함수의 반환은 **zod를 통과한 모델 출력**이다. 레벨 태깅·제외 재필터·요청 밖 한자 버리기처럼 "호출 인자를 알아야 하는" 일은 진입 함수가 아니라 그 뒤의 순수 함수가 한다 — 그 단계가 include·exclude·요청 목록을 안다.

## 3. 파일 역할과 eval의 관계

| 파일 | 담는 것 | 누가 쓰나 |
|---|---|---|
| `lib/ai/japanese/prompts.ts` | 호출 A~D 시스템 프롬프트(§2-1·§3-1·§4-1·§12-2-1 원문), 사용자 메시지 빌더(`buildJaVocabUserMessage`·`buildJaDialogCoachUserMessage`·`buildJaKanjiUserMessage`), 호출 옵션 | client.ts, eval |
| `lib/ai/japanese/schemas.ts` | JSON Schema(strict) 4종 + zod + 타입(`JaToken`·`JaVocabEntry`·`JaDialogTurn`…) + 상수(`JLPT_LEVELS`·`JA_VOCAB_TOPIC_PRESETS`·`JA_*_MAX`·`JA_DIALOG_BATCH_SIZE`(4)·`JA_KANJI_BATCH_SIZE`(10)·`JA_EXCLUDE_PROMPT_MAX`(200)) — 4중 정의의 뿌리 | 전부 |
| `lib/ai/japanese/vocab.ts` | `normalizeJaWord`·`planIncludeDistribution`·`applyVocabPostprocess`·`normalizeJaVocabEntry` | 생성 라우트, 저장소, 만들기 페이지, eval |
| `lib/ai/japanese/dialog.ts` | `planJaDialogBatches`·`mergeJaDialogBatches` | 전사 라우트, eval |
| `lib/ai/japanese/kanji.ts` | `collectKanjiFromBooks`·`selectKanjiToEnrich`·`applyKanjiPostprocess` | 한자 라우트·페이지, eval |
| `lib/ai/japanese/quiz.ts` | 시험 문항·보기 생성(`buildJaQuizQuestions`·`buildJaKanjiQuizQuestions`), 모드 상수(`JA_QUIZ_CONTENT_MODES` 5종·`JA_QUIZ_MODES`(+`wrong-review`)·`JA_KANJI_QUIZ_MODES` 2종), 모드별 집계(`aggregateJaStatsByMode`·`buildJaReviewCandidatesByMode`) — **AI 0** | 서버 페이지, 시험 라우트, eval |

순수 함수 파일은 **값을 만드는 유일한 곳**이다. 규칙이 라우트나 화면에 한 벌 더 생기면 반드시 어긋나므로, 라우트는 결과를 소비만 한다. 그리고 순수 함수라서 eval이 실호출 없이 픽스처로 전부 잠근다 — 후처리 규칙을 바꾸면 eval 점검도 함께 바꿔야 오프라인이 통과한다.

## 4. 후리가나 토큰 (§5)

- 문자열 안에 루비를 끼워 넣지 않는다(`漢字(かんじ)` 금지 — 검색·TTS·비교를 전부 망친다). **`JaToken { surface, reading }` 배열**로 받는다. 단어 표기(`wordTokens`), 예문(`JaExample.tokens` — 단어장 예문·해설 `items[].example`·`practice`), 일일정의(`definitionTokens`), 대화 발화(`turns[].tokens`), 해설 어휘(`items[].wordTokens`)가 이 모양이다. 해설의 `goods[].quoteJa`·`fixes[].originalJa`/`betterJa`는 토큰 없는 평문이다.
- **토큰 무결성이 핵심 가드다.** `tokens.map(t => t.surface).join("")`이 원문과 정확히 같아야 한다 — zod가 강제하므로 어긋나면 `callWithSchema`의 1회 재요청이 그 자리에서 교정한다.
- **토큰 zod(`jaTokenSchema`, `schemas.ts`) 규칙 셋**: reading을 단 토큰의 surface에 한자와 가나가 섞이면 **거부**(오쿠리가나 분리 `食(た)`+`べる`를 zod가 강제), 한자만인 토큰의 reading은 히라가나만, 한자가 없는 토큰의 reading은 거부하지 않고 null로 정리(transform).
- **숙어 묶기(`目標`를 한 토큰으로)만 프롬프트 규칙이다.** 目+標로 쪼갠 것도 두 토큰 다 한자만이라 형식상 유효해 코드로 막을 수 없다. 오쿠리가나 거부 반례는 eval의 `runOkuriganaChecks`·`runZodChecks`가 잠근다.
- 렌더는 **`components/ja-ruby.tsx` 한 곳**이다(`reading !== null`이면 `<ruby>`). 훅·브라우저 전역이 없어 서버·클라이언트 양쪽에서 쓰고, 타입은 타입 전용 모듈 `lib/japanese-ruby-contract.ts`에서 받는다. 화면마다 복사하지 마라.
- **발음은 surface 원문을 읽는다** — `speak(text, "ja-JP")`, 미리 받기는 `prefetchSpeech(texts, "ja-JP")`. 루비(reading)를 읽히면 안 된다. 발음 파이프라인 자체는 `app-patterns.md`.

## 5. kana 조인키 (§10)

영어의 `toLowerCase()` 조인키를 그대로 쓰면 표기 흔들림(같은 단어의 한자/가나 표기, 활용형)을 못 잡는다. 일본어는 **표기(word)+읽기(kana) 2축**이고 같은 단어 판정은 kana가 기준이다.

- 비교 전 정규화는 `normalizeJaWord`(`vocab.ts` — NFKC로 전각/반각 통일 + 공백 전부 제거)를 쓴다. 새 비교 코드도 이 함수를 쓴다.
- `applyVocabPostprocess`: 누적 제외는 **word 또는 kana**가 같으면 버리고(단 include는 예외), 같은 배치 안 중복은 **kana로 접으며** include 쪽을 남긴다. 포함 이행 확인은 word 일치, 없으면 kana 일치로 한 번 더 본다.
- 누적 제외 목록 조립(`/api/japanese/vocab/generate`): 저장된 모든 단어장의 `{word, kana}`를 최신 단어장부터 모아 `JA_EXCLUDE_PROMPT_MAX`(200)개에서 끊고, 프롬프트에는 오래된 것 → 최근 것 순으로 뒤집어 넣는다. 프롬프트로 넘기는 개수에는 상한이 있으므로 **저장 전 코드 재필터가 진짜 방어선**이다(§7-4).
- "대화에서 모은 단어" 담기 중복 판정은 스토어 `appendJaVocabEntry`가 kana로 한다(파일·Firestore 두 백엔드 모두 `kana.trim()` 비교 — 12절 참고).

## 6. 병렬·부분 성공·best-effort

세 판독/생성 라우트가 같은 모양이다: 입력을 나눠 `Promise.allSettled`로 병렬 호출 → 성공분만 모아 후처리 → **실패분은 사실대로 보고** → **전부 실패일 때만 500**.

- **레벨 병렬 (호출 A).** `planIncludeDistribution(levels, include, JA_VOCAB_DEFAULT_COUNT)`가 레벨마다 계획을 만든다 — include는 **첫 레벨에만** 싣고 그 레벨의 새 단어 수를 그만큼 줄인다(레벨마다 쪼개 넣으면 같은 단어가 여러 번 나온다). 레벨 태깅은 모델이 아니라 코드가 호출 인자로 붙인다(검증할 수 없는 값을 모델에 맡기지 않는다). 응답 `perLevel[]`이 레벨별 `{filteredCount, missingIncludes, failed}`를 알린다. 10개보다 적게 남아도, 못 넣은 include가 있어도 성공이다 — 검토 화면이 "이 단어는 못 넣었어요"를 사실대로 보여준다.
- **배치 병렬 (호출 B).** `planJaDialogBatches(imageCount)`가 `JA_DIALOG_BATCH_SIZE`(4)장씩 묶고, `mergeJaDialogBatches`가 경계에서 **표기(ja) 완전 일치·연속**인 발화만 하나로 접는다(유사도로 서로 다른 발화를 삼키지 않는다). 모델이 잘림을 보고했거나 배치가 하나라도 실패하면 `partial:true`로 정직하게 알린다. 장수 상한(20장)·전체 크기 상한은 이 라우트의 정책이고, 한 장의 형식·길이는 `lib/upload-limits.ts`를 import한다.
- **배치 병렬 (호출 D).** 수집(`collectKanjiFromBooks`) → 정보 없는 한자만 선별(`selectKanjiToEnrich`) → `JA_KANJI_BATCH_SIZE`(10)자씩 병렬 → `applyKanjiPostprocess`(요청 밖·중복 버림, 빠진 한자 보고) → `store.saveJaKanji`는 **kanji 기준 insert-only**(이미 있는 한자는 덮어쓰지 않고, 실제로 새로 채운 수만 `filled`로 돌려준다). 채울 것이 없으면 호출 없이 `nothingToFill:true`.
- **정보 불변.** 이미 채운 한자는 어떤 재생성 경로도 덮어쓰지 않는다 — 시험이 그 값에 매달린다(영어 "정의 불변"과 같은 자리). 선별(1차)과 insert-only 저장(2차, 동시 요청까지 막음) 두 겹이다.
- **해설은 best-effort (호출 C).** 전사가 본체, 해설은 부수 효과다(§7-2). `/api/japanese/dialog/coach`는 두 모드다 — `{id}`면 저장된 대화의 해설을 다시 만들어 `updateJaDialogCoaching`으로 갈아끼우고, `{focusKo, turns}`면 생성만 해서 돌려준다(검토 화면이 저장으로 넘긴다). 실패하면 `coaching:null`로 저장하고 "해설 다시 만들기"로 채운다.
- 단어 생성(`/vocab/generate`)·대화 전사(`/dialog/extract`)는 **저장하지 않는다.** 결과를 검토 화면에 돌려주고, 사용자가 확정하면 저장 라우트(`POST /vocab`·`POST /dialog`)가 저장한다(AI 없음, 키 검사 없음). 사람이 보기 전에 AI 결과가 서재에 들어가지 않게 하려는 것이다. 예외는 두 AI 라우트다. `/kanji/enrich`(호출 D)는 검토 화면 없이 `store.saveJaKanji`로 바로 저장하되 insert-only다. `/dialog/coach`는 `{id}` 모드일 때 `store.updateJaDialogCoaching`으로 저장된 해설을 갈아끼운다(`{focusKo, turns}` 모드는 저장하지 않는다).

## 7. 라우트 목록 (`app/api/japanese/**`)

표의 경로는 `/api/japanese` 접두어를 뺐다. 스펙 §8·§12-5의 경로 목록에 없는 라우트(`dialog/[id]/add-word` — §7-5 J5)도 있다. 응답 shape의 정의처는 전부 계약 파일(`lib/` 아래)이다.

| 라우트 | 역할 | AI | 상태코드 | 계약 | 소비 화면 |
|---|---|---|---|---|---|
| `POST /vocab/generate` | 레벨별 병렬 생성 + 후처리. 저장 안 함 | A | 200 `{entries, perLevel, model}` · 400 · 501 · 500 `generate_failed` | `japanese-vocab-contract.ts` | `ja-vocab-new-flow.tsx` |
| `POST /vocab` | 검토한 단어장 저장. `kind:"jlpt"`는 서버가 붙인다 | 없음 | 200 `{id}` · 400 · 500 `save_failed` | 〃 | `ja-vocab-new-flow.tsx` |
| `DELETE /vocab/[id]` | 단어장 삭제(그 단어장의 시험 세션 연쇄) | 없음 | 200 · 404 `vocabbook_not_found` · 403 `prod_guard` · 500 | 〃 | `ja-vocab-library-view.tsx` |
| `POST /vocab/[id]/rename` | `titleKo`만 | 없음 | 200 · 400 · 404 · 500 | 〃 | `ja-vocab-detail-view.tsx` |
| `POST /vocab/[id]/quiz` | 시험 세션 저장 — **한 레코드 = 한 콘텐츠 모드**(혼합 세션은 화면이 모드별로 갈라 여러 번 보낸다) | 없음 | 200 · 400 · 404 · 500 | 〃 | `ja-quiz-runner.tsx` |
| `POST /vocab/reorder` | 목록 순서 | 없음 | 200 `{count}` · 400 · 500 | `reorder-contract.ts` | `ja-vocab-library-view.tsx` |
| `POST /dialog/extract` | 스크린샷 N장 → 배치 병렬 전사 + 병합. 저장 안 함 | B | 200 `{focusKo, turns, partial, mergedCount, allUnknown, model}` · 400 · 501 · 500 `extract_failed` | `japanese-dialog-contract.ts` | `ja-dialog-new-flow.tsx` |
| `POST /dialog/coach` | 해설 생성(전사) · 재생성(`{id}`) | C | 200 `{coaching}` · 400 · 404 `not_found` · 501 · 500 `coach_failed` | 〃 | `ja-dialog-new-flow.tsx`·`ja-dialog-detail-view.tsx` |
| `POST /dialog` | 대화 저장(`coaching`은 null 허용) | 없음 | 200 `{id}` · 400 · 500 | 〃 | `ja-dialog-new-flow.tsx` |
| `DELETE /dialog/[id]` | 대화 삭제(딸린 것 없음) | 없음 | 200 · 404 · 403 · 500 | 〃 | `ja-dialog-library-view.tsx` |
| `POST /dialog/[id]/rename` | `titleKo`만 | 없음 | 200 · 400 · 404 · 500 | 〃 | `ja-dialog-detail-view.tsx` |
| `POST /dialog/[id]/add-word` | 해설 `items[itemIndex]`를 collected 단어장에 담기 | 없음 | 200 `{added, bookId, word}` · 400 · 404 · 500 | 〃 | `ja-dialog-coaching-view.tsx` |
| `POST /dialog/reorder` | 목록 순서 | 없음 | 200 · 400 · 500 | `reorder-contract.ts` | `ja-dialog-library-view.tsx` |
| `POST /kanji/enrich` | 수집 → 정보 없는 한자만 배치 채움. 본문 없음 | D | 200 `{filled, missingKanji, droppedCount, batches, nothingToFill}` · 501 · 500 `enrich_failed` | `japanese-kanji-contract.ts` | `ja-kanji-list-view.tsx` |
| `POST /kanji/quiz` | 한자 시험 세션 저장(`scope:"kanji"`는 서버가 붙인다) | 없음 | 200 · 400 · 500 | 〃 | `ja-kanji-quiz-runner.tsx` |

키 검사(501)는 AI 라우트 넷(generate·extract·coach·kanji/enrich)에만 있고 **호출 앞**에 있다. 나머지는 키가 없어도 동작해야 한다.

## 8. 계약 파일과 번들 경계 (§10)

`lib/ai/japanese/*`는 zod 런타임을 싣고 있어 클라이언트 번들에 들어가면 안 된다. 이 경계는 영어보다 엄격하게 지켜져 있다 — 현재 `"use client"` 컴포넌트 중 `lib/ai/japanese`를 import하는 곳은 없다.

- **계약 파일 4개**: `lib/japanese-vocab-contract.ts`(생성·저장·rename·삭제·시험 저장 + `JA_QUIZ_MODE_LABELS_KO`), `lib/japanese-dialog-contract.ts`(전사·해설·저장·rename·삭제·담기), `lib/japanese-kanji-contract.ts`(enrich·한자 시험 + 목록/카드 화면 데이터 + `JA_KANJI_QUIZ_MODE_LABELS_KO`), `lib/japanese-ruby-contract.ts`(`JaToken` 타입 재수출만).
- 계약 파일은 `lib/ai/japanese/*`에서 **`import type` / `export type`만** 한다. `isolatedModules`로 컴파일 시 완전히 지워져 런타임 import가 없다. 계약 파일에 값(`JA_TITLE_MAX`·`JA_DIALOG_TITLE_MAX`·모드 라벨)을 둘 수는 있지만 lib/ai 값에 기대면 안 된다.
- 화면이 lib/ai의 **값**(`JLPT_LEVELS`·`JA_VOCAB_TOPIC_PRESETS`·개수 상한, 시험 문항)을 필요로 하면 **서버 컴포넌트(`app/japanese/**/page.tsx`)가 import해 계산하고 props로 내린다.** 예: 만들기 페이지가 프리셋·상한·기존 표제어를 내리고, 시험 페이지가 `buildJaQuizQuestions`로 세션을 조립해 `ja-quiz-runner.tsx`에 넘기고, 오답노트 페이지가 `aggregateJaStatsByMode`로 집계한다.
- 확인: `grep -arl '"use client"' components app | xargs grep -an 'from "@/lib/ai/japanese'` — 지금은 결과가 없다. 결과가 나오면 그 import가 타입 전용인지 본다. 값 import면 경계가 깨진 것이다(`-a`는 SKILL.md "grep 함정" 참고).

## 9. 재사용 경계 (§10)

**수정 없이 재사용한다** — `lib/vocab-quiz.ts`의 `buildChoices`(문자열 동일성만 씀), `lib/vocab-mastery.ts`(`aggregateWordStats`·`isMastered`·`isStatMastered`), `lib/vocab-review.ts`(복습 후보), `lib/ai/client.ts`의 `callWithSchema`·`imagePart`, 사진 파이프(`lib/image-crop.ts`·`lib/image-resize.ts`·`lib/upload-limits.ts`), 순서변경(`components/use-reorder.ts`·`lib/reorder-contract.ts`), `lib/prod-guard.ts`, 발음 관문 `lib/speech.ts`(`speak(text, lang)`의 언어 인자).

**일본어 쪽에 새로 둔다** — 품사 enum(`JA_POS`: い/な형용사·자동사/타동사 축), 후리가나 토큰(영어 `ipa`와 의미가 다른 필드), word+kana 2축과 kana 조인키, 프롬프트 전량, 시험 모드 enum, 시험·한자·대화 컬렉션.

재사용 대상이 모자라 보이면 영어 파일을 고치기 전에 멈춘다. 공유 순수 함수를 고치면 영어 시험도 함께 바뀌므로, 정말 고쳐야 한다면 오케스트레이터에 올리고 `eval:english`·`eval:japanese` 오프라인을 둘 다 통과시킨다.

**모드 무오염**(§6-2): 뜻은 아는데 독음을 모르는 상태가 흔하다. 모드가 다른 결과를 한 통계에 섞으면 "안다" 판정이 거짓이 된다. 시험 세션 레코드의 `mode`로 가르고 집계는 `aggregateJaStatsByMode`로 모드별로 낸다. 한자 시험은 컬렉션부터 따로다(`jaKanjiQuizzes`, 문항의 `word` 자리에 한자 문자).

## 10. 저장 레코드 (`lib/store.ts`)

| 레코드 | 컬렉션 | 핵심 규칙 |
|---|---|---|
| `JaVocabBookRecord` | `jaVocabBooks` | `kind: "jlpt" \| "collected"`, `levels`(collected면 빈 배열), `topic`, `entries: JaVocabEntry[]`, `sortIndex`. 단어의 출처는 엔트리가 아니라 단어장(`kind`)이 안다 |
| `JaQuizRecord` | `jaQuizzes` | `bookId`, `mode: JaQuizMode`, `items: {word, correct, answered}[]`. append 전용. 영어 `vocabQuizzes`와 컬렉션 분리 |
| `JaKanjiRecord` | `jaKanji` | `kanji`(조회·중복 키), `koReading`·`onyomi`·`kunyomi`·`meaningKo`. 삭제 메서드 없음(수집 파생물). 한자가 든 단어 목록은 저장하지 않고 읽을 때 계산 |
| `JaKanjiQuizRecord` | `jaKanjiQuizzes` | `scope: "kanji"`, `mode: JaKanjiQuizMode`. append 전용 |
| `JaDialogRecord` | `jaDialogs` | `turns`(본체), `coaching \| null`(부수 효과), `photoCount`, `partial`, `sortIndex`. 사진 원본은 저장하지 않는다 |

- **선택 키(`?`) 금지, 전부 필수 nullable.** Firestore가 `undefined`를 거부한다. 새 레코드는 §7의 12항목 체크리스트(인터페이스·`New*`·`StudyStore` 메서드·`DbShape`·`emptyDb`·`readDb` 하위호환·`normalize*`·파일 구현·Firestore 변환기·`assertDestructiveAllowed`·렌더 판정·`mergeDbForSeed`)를 전부 밟는다.
- **정규화는 한 곳씩.** 단어 항목은 `normalizeJaVocabEntry`(`lib/ai/japanese/vocab.ts`가 단일 정의처 — store가 import한다; 구 레코드의 `imageEmoji`·`definitionJa`·`definitionTokens`를 null로 채움), 단어장 `normalizeJaVocabBook`(`kind`는 `"collected"`만 명시 인정, 그 밖은 `"jlpt"`), 시험 문항 `normalizeJaQuizItem`, 한자 `normalizeJaKanji`, 대화 `normalizeJaDialogRecord`(store.ts). `readDb`는 옛 `db.json`에 키가 없어도 빈 배열로 받는다.
- **렌더 판정은 `lib/japanese-record.ts`의 `isRenderableJaVocabBook` 하나다.** 목록(`/japanese/vocab`, 그 줄만 건너뜀)·상세·시험·오답노트·기록 페이지와 rename·quiz 라우트가 같은 함수로 404를 가른다. 단어가 0개인 단어장은 열지 않는다. 대화에는 별도 판정 함수가 없다(`getJaDialog`가 null이면 404).
- **"대화에서 모은 단어"**: `getOrCreateJaCollectedVocabBook()`이 `kind:"collected"` 단일 단어장(제목 `JA_COLLECTED_VOCAB_TITLE_KO`)을 멱등으로 얻거나 만든다. 담기 라우트는 대상 id를 받지 않으므로 JLPT 단어장에 섞일 여지가 없다. 담는 항목은 `level:null`·`pos:[]`·`imageEmoji:null` — 대화 어휘에 레벨을 추정시키지 않는다.
- **삭제 가드.** Firestore 구현은 단어장·대화 삭제 모두 `assertDestructiveAllowed("deleteJaVocabBook")`을 부른다(대화 전용 op 이름은 없다). 단어장 삭제는 두 백엔드 모두 그 단어장의 `jaQuizzes`를 함께 지운다. rename·reorder·coaching 갱신·append는 수정이라 가드 대상이 아니다.

## 11. eval-japanese.ts

- **사실상 오프라인 전용이다.** `EVAL_JAPANESE=1` 게이트는 안내만 찍고 실호출하지 않는다(자리만 있다). 그래서 언제 돌려도 비용이 없지만, 안전 접두어는 그대로 붙인다: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:japanese` (`EVAL_OFFLINE_ONLY=1`이면 `globalThis.fetch`도 막는다).
- 점검 묶음(`main`): 상수 정합 · zod 거부 케이스(토큰 무결성 포함) · 오쿠리가나 분리 · 이모지 · 후처리(제외·include 우선·포함 보고·중복 접기·레벨 태깅) · include 배분 계획 · 호출 A 사용자 메시지 치환 · 시험 문항 · **모드 분리** · 한자(수집·선별·후처리·시험 2모드) · 대화(배치 계획·병합) · spec-sync · JSON Schema 의미 동치.
- **spec-sync 대상**(`SPEC_SYNC_TARGETS`): `JA_VOCAB_SYSTEM_PROMPT`·`JA_VOCAB_USER_TEMPLATE`·`JA_KANJI_SYSTEM_PROMPT`·`JA_DIALOG_EXTRACT_SYSTEM_PROMPT`·`JA_DIALOG_EXTRACT_USER_TEXT`·`JA_DIALOG_COACH_SYSTEM_PROMPT` 바이트 대조, 그리고 JSON Schema 4종(`JA_VOCAB_GENERATION_JSON_SCHEMA`·`JA_KANJI_INFO_JSON_SCHEMA`·`JA_DIALOG_EXTRACTION_JSON_SCHEMA`·`JA_DIALOG_COACHING_JSON_SCHEMA`)을 스펙 코드블록을 파싱해 의미 동치로 대조한다. 새 프롬프트·스키마 상수를 만들면 여기에 등록해야 끝이다.
- 해설 낭독 대본(`lib/ja-coaching-script.ts`의 `buildCoachingScript`)은 호출 C 스키마(§4-3) 필드를 섹션 순서대로 읽는다. 해설 스키마를 바꾸면 이 함수와 `scripts/eval-speech.ts`를 함께 맞춘다(§13) — 그 점검은 `eval:speech`에 있다.

## 12. 알려진 틈 (2026-09-24 코드 기준)

고치라는 목록이 아니라, 이 근처를 작업할 때 모르고 밟지 않게 적어 둔 사실이다.

- **호출 C·D의 사용자 메시지는 eval이 보지 않는다.** 스펙 §9는 "호출 A·B·C의 사용자 메시지"를 spec-sync한다고 적지만, `buildJaDialogCoachUserMessage`(§4-2)·`buildJaKanjiUserMessage`는 spec-sync 대상도 치환 점검 대상도 아니다. 이 두 빌더를 고치면 스펙과 눈으로 대조하고 리포트에 남긴다.
- **한자 수집 규칙이 세 곳에 흩어져 있고 어디에도 kind 필터가 없다.** 스펙 §12-1은 "JLPT 단어장 전체"라고 쓰지만 세 곳 모두 collected 단어장까지 넘긴다.
  - `collectKanjiFromBooks`를 부르는 곳은 **둘**이다. 목록 페이지 `app/japanese/kanji/page.tsx`는 `listJaVocabBooks(LIST_LIMIT)`(500)를, `/api/japanese/kanji/enrich`는 **상한 없는** `listJaVocabBooks()`를 넘긴다(limit이 없으면 두 백엔드 모두 전부 읽는다). 단어장이 500개를 넘으면 목록에 안 보이는 한자를 enrich가 채울 수 있다.
  - 한자 카드 페이지 `app/japanese/kanji/[kanji]/page.tsx`는 `collectKanjiFromBooks`를 쓰지 않는다. 자체 `collectWordsFor(kanji)`가 `listJaVocabBooks(500)` 위에서 `entry.word.includes(kanji)`로 **수집 규칙을 한 번 더** 구현한다.
  - 그래서 범위(kind 필터·개수 상한)를 바꾸려면 세 곳을 함께 고친다. `collectKanjiFromBooks`만 고치면 카드 페이지의 "이 한자가 든 단어들"에는 반영되지 않는다.
- **kana 비교 강도가 두 가지다.** 후처리는 `normalizeJaWord`(NFKC+공백 제거), 스토어의 담기 중복 판정은 `kana.trim()`이다. 반각 가나가 섞인 입력이면 둘의 판정이 갈릴 수 있다.

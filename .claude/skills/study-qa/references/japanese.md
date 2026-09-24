# 일본어(아빠의 일본어) 정합성 매트릭스·체크리스트

> `study-qa` 스킬에서 subject가 `japanese`일 때 읽는다. 영어는 `english.md`, 수학은 `math.md`를 본다. 클라우드 발음·재생 큐·스트릭 같은 과목 공통 기능은 `common.md`가 맡는다.
> 원문 스펙은 `docs/harness/japanese.md`다. 이 문서의 값은 2026-09-24에 코드를 열어 확인한 것이다. 검증할 때는 다시 열어 대조하라.

## 목차

1. 4중 정의 매트릭스 — 호출 A~D
2. 토큰 무결성·조인키
3. 모드별 숙련도 분리
4. 대화 병합
5. 경계면 체크리스트 — 라우트 ↔ 화면
6. 재사용 경계(§10)
7. 검증 시 지킬 것
8. 리포트 형식

과목마다 검증의 무게중심이 다르다. 영어는 구조 개수, 수학은 답의 정확성이다. 일본어는 **축이 섞이지 않는가**다. 이 과목은 따로 굴러야 할 축을 여럿 가진다.

- 표기 ↔ 읽기(토큰 무결성, kana 조인키)
- 시험 모드 ↔ 시험 모드(숙련도)
- JLPT 단어장 ↔ 대화에서 모은 단어(`kind`)
- 단어 시험 ↔ 한자 시험(컬렉션)
- 영어 자산 ↔ 일본어 자산(§10)

어느 하나가 섞이면 에러 없이 조용히 거짓 판정이 나온다. "안다"는 통계가 거짓이 되거나, 후리가나가 본문을 바꾸거나, JLPT 단어장이 N2 10개가 아니게 된다. 모든 항목은 **반례를 넣어 실제로 거부되는지**로 확인한다.

## 1. 4중 정의 매트릭스 — 호출 A~D

셀 표기 규칙:
- "—"는 그 위치에 정의가 **없어야 정상**이라는 뜻이다. JSON Schema에 `minItems`/`maxItems`/`minLength`가 있으면 그 자체로 위반이다.
- 프롬프트 열의 값은 `lib/ai/japanese/prompts.ts` 기준이다. 스펙 코드블록과 바이트가 같은지는 spec-sync가 본다.

### 호출 A — JLPT 단어 생성 (§2)

| 제약 | 프롬프트 | JSON Schema | zod (`schemas.ts`) | eval |
|---|---|---|---|---|
| entries 개수 | `{count}` 주입(`buildJaVocabUserMessage`), 기본 `JA_VOCAB_DEFAULT_COUNT` 10 | — | 1~`JA_ENTRIES_MAX` 10 | 0개·11개 거부 |
| 표제어 중복 | "서로 다른 단어" | — | 같은 `word` 거부 | 거부 1건 |
| kana 히라가나 전용 | `[표기 2축]` | description만 | `isHiraganaOnly`(`ー` 허용) | 가타카나·로마자 거부 |
| pos enum 10종 | `[품사]` 목록 | `enum`(리터럴) | `z.enum(JA_POS)` 1~`JA_POS_MAX` 4 | enum 밖 거부, `JA_POS` == 스키마 `enum` |
| 뜻 1~3개, 각 ≤60자, 한글 | `[뜻(한국어)]` "1~3개" | — | `JA_MEANINGS_MAX` 3, `JA_MEANING_KO_MAX` 60 | 0·4개, 한글 없음 거부 |
| 예문 길이 | "15~30자 정도" | — | `JA_EXAMPLE_JA_MIN` 5 ~ `MAX` 60 | 5자 미만 거부 |
| 번역 한글 | `[예문]` | — | `example.ko` 한글 필수 | 한글 없음 거부 |
| 일일정의 | "길어도 60자", 표제어 금지, 없으면 null | `["string","null"]` | 4~60자, 일본 문자 필수, 표제어 포함 거부 | 4·7자 통과, 2자·표제어·비일본어 거부 |
| definitionTokens 짝 | "definitionJa가 null이면 null" | `["array","null"]` | 정의 있으면 토큰 필수·무결성, 정의 null이면 토큰 null | 무결성·고아·누락 거부 |
| 이모지 1개 | `[이모지]` | `["string","null"]` | 자소 1 + 그림문자, `JA_IMAGE_EMOJI_MAX` 32 | 3 통과, 4 거부 |
| 레벨 | `[레벨]` 서술 | **필드 없음** | **필드 없음** | 레벨 태깅(코드가 붙임) |

zod 밖에서 정의되는 값도 있다.
- 호출 옵션: temperature 0.4, max 8,000(`JA_VOCAB_CALL_OPTIONS`). 스펙 §1-1 표의 temperature와 대조한다.
- 제외 상한: `JA_EXCLUDE_PROMPT_MAX` 200.
- include 상한: `JA_INCLUDE_MAX` = `JA_VOCAB_DEFAULT_COUNT`, `JA_INCLUDE_WORD_MAX` 20.

스펙과 코드가 어긋난 칸이 두 개 있다. 어느 쪽을 고칠지는 판정하지 말고 양쪽 위치만 적어 올린다.
- **일일정의 하한(§2-1 13번 ↔ `JA_DEFINITION_JA_MIN`).** 스펙은 "짧을수록 좋다 — 하한을 두지 않는다"고 적었다. 코드는 `JA_DEFINITION_JA_MIN` 4이고, `scripts/eval-japanese.ts`는 `みず`(2자)를 "3자 이하(너무 짧음)" 거부 케이스로 잠갔다. 하한을 올리는 변경은 P0 재발이라 어느 쪽으로 정리하든 막아야 한다.
- **cloze 출제 조건(§6-1 ↔ `quiz.ts`).** 스펙은 "예문에 표제어가 실제로 포함될 때만 출제(zod가 보장하지만 코드에서도 확인)"라고 적었다. 그런데 `schemas.ts`에는 `example.ja.includes(word)` refine이 없다. `lib/ai/japanese/quiz.ts`의 `buildOne`에 있는 `if (!entry.example.ja.includes(entry.word)) return null;` 한 곳만 거른다. 반례로 확인하라. 활용형 예문(`食べた`)을 가진 `食べる` entry가 호출 A zod를 통과하고, cloze에서는 조용히 빠져야 한다.

### 호출 B — 대화 전사 (§3)

| 제약 | 프롬프트 | JSON Schema | zod | eval |
|---|---|---|---|---|
| turns ≥1 | — | — | `.min(1)` | 0개 거부 |
| speaker 3종 | `[화자 구분]` | `enum` 리터럴 | `JA_DIALOG_SPEAKERS` | enum 밖 거부 |
| feedback 2종 / null | `[피드백 전사]` | `["object","null"]` | `JA_DIALOG_FEEDBACK_KINDS` | kind 밖 거부 |
| 발화·피드백 길이 | — | — | ≤`JA_DIALOG_TEXT_MAX` 400 | — |
| 토큰 무결성 | `[후리가나]` | `$defs.tokens` | `tokensJoinEqual` | 거부 1건 |

- 호출 옵션: temperature 0, max 8,000.
- 배치: `JA_DIALOG_BATCH_SIZE` 4.
- **상수 흩어짐(P2 후보):** speaker와 feedback enum이 JSON Schema 리터럴, zod 상수 말고도 두 곳에 더 적혀 있다. coach 라우트와 dialog 저장 라우트의 `turnSchema`가 `z.enum(["partner","me","unknown"])` 리터럴을 쓴다. `JA_POS`와 달리 eval에 "스키마 enum == 상수" 대조도 없다.

### 호출 C — 대화 해설 (§4)

| 제약 | 프롬프트 | JSON Schema | zod | eval |
|---|---|---|---|---|
| goods | 개수 없음 | — | ≤`JA_DIALOG_GOODS_MAX` 6 | 7개 거부 |
| fixes | "없으면 빈 배열" | — | ≤`JA_DIALOG_FIXES_MAX` 8 | **개수 반례 없음** |
| items | "3~6개" | — | `JA_DIALOG_ITEMS_MIN` 2 ~ `MAX` 8 | 1개 거부(상한 반례 없음) |
| practice | "2~3개" | — | `JA_DIALOG_PRACTICE_MIN` 1 ~ `MAX` 5 | 0개 거부(상한 반례 없음) |
| summaryKo | 본문에 없음. description "2~3문장" | description | 한글 필수, ≤800 | 한글 없음 거부 |
| 한국어 필드 한글 | `[언어]` | — | `hasHangul`: `summaryKo`, `goods[].whyKo`, `fixes[].whyKo`, `items[].meaningKo`·`usageKo`·`example.ko`, `practice[].ko`. **`fixes[].grammarKo`는 검사 없음** | summaryKo 한글 없음 거부 1건 |
| 일본어 필드 일본 문자 | `[언어]` | — | `hasJapanese`: `goods[].quoteJa`, `fixes[].originalJa`·`betterJa`뿐. **`items[].word`·`items[].example.ja`·`practice[].ja`는 검사 없음**(`items[].kana`는 히라가나 전용 검사가 대신한다) | originalJa 거부 1건 |
| items·practice 토큰 무결성 | `[어휘·표현]` | `$defs` | `tokensJoinEqual` | wordTokens 거부 1건 |

- 호출 옵션: temperature 0.5, max 8,000.
- **§4-4 언어 검증 누락(스펙 ↔ 코드 불일치).** §4-4는 "한국어 필드는 한글 포함 검증, 일본어 필드는 일본 문자 포함 검증"이라고 적었다. 코드는 위 표처럼 일부 필드만 본다. 반례는 이렇다. `items`의 `word` `hello`·`example.ja` `hello world`, `practice[].ja` `hello there`, `grammarKo` `particle only`를 넣어도 `jaDialogCoachingSchema.safeParse`가 success다(2026-09-24, 7절 스크래치 방식으로 확인). 담기(J5)가 `items[].word`를 그대로 collected 단어장에 넣으므로, 일본 문자가 없는 표제어가 단어장에 들어갈 수 있다. 확인하고 ai-engineer 담당으로 올린다.
- **여유 폭은 결함이 아니다.** 프롬프트가 zod보다 좁은 칸(items 3~6 vs 2~8, practice 2~3 vs 1~5)은 스펙 §4-4가 정한 설계다. 볼 것은 두 가지다. zod 폭이 §4-4와 같은가. zod가 프롬프트보다 **좁은** 칸이 있는가. 후자가 결함이다. 프롬프트를 지킨 출력이 거부되어 재요청 뒤 throw가 난다.

### 호출 D — 한자 정보 (§12)

| 제약 | 프롬프트 | JSON Schema | zod | eval |
|---|---|---|---|---|
| kanji 한 글자 | "받은 한자마다" | description | `isSingleKanji` | 2글자·가나 거부 |
| koReading 한글 1자 / null | `[koReading]` | `["string","null"]` | `isSingleHangul` | 2글자·비한글 거부 |
| 음독 | "1~3개", 히라가나 | — | 0~`JA_KANJI_READINGS_MAX` 3, 히라가나 | 가타카나·4개 거부 |
| 훈독 | "없으면 빈 배열" | — | 0~3, 히라가나 | — |
| 뜻 1~20자 | `[meaningKo]` | — | `JA_KANJI_MEANING_KO_MAX` 20, 한글 | 한글 없음·21자 거부 |
| items 개수 | — | — | 1~50(방어값, 요청 밖 한자는 후처리가 버림) | — |

- 호출 옵션: temperature 0.2, max 3,000.
- 배치: `JA_KANJI_BATCH_SIZE` 10.

### spec-sync

eval의 "프롬프트 ↔ 스펙" 영역은 10건이다. 문자열 6건은 A 시스템, A 사용자 템플릿, B 시스템, B 사용자 텍스트, C 시스템, D 시스템을 바이트로 대조한다. JSON Schema 4건은 스펙 코드블록과 의미 동치로 대조한다. **C와 D의 사용자 메시지 빌더는 대조 대상이 아니다.** 스펙 §4-2와 `buildJaDialogCoachUserMessage`의 형식은 눈으로 대조하라. 코드는 화자를 나·상대·?로 적고 피드백을 `[좋아요: …]`·`[팁: …]`로 붙인다.

판정이 no-op가 아닌지도 한 번 확인한다. 스펙 코드블록 한 글자를 바꿔 FAIL을 보고 byte-identical로 되돌린다. J1 QA가 이렇게 확인했다(`_workspace/qa_report_japanese_j1_1.md`).

## 2. 토큰 무결성·조인키

**반례로 확인할 것.** 전부 eval에 있으니 변이 테스트로 가드가 살아 있는지 본다. 가드를 지우면 eval이 FAIL하고, 되돌리면 복원된다.

- `wordTokens`, `example.tokens`, `definitionTokens`, 발화 `tokens`의 surface를 이은 값이 원문과 한 글자 다르면 거부되는가
- 오쿠리가나를 묶은 토큰(促す(うながす), 食べる(たべる), 활용형 広がった)이 거부되는가. `jaTokenSchema` 규칙 (a)다
- 한자 토큰의 reading이 가타카나면 거부되는가(규칙 (b))
- 가나 토큰에 붙은 reading이 **거부가 아니라** null로 정리되는가(규칙 (c)의 transform)

**zod가 원리적으로 못 보는 것**은 "미검증"으로 남긴다.
- 숙어를 글자별로 쪼갠 것(目(もく)+標(ひょう)). 두 토큰 모두 한자만이라 형식상 유효하다.
- reading의 사실 여부.
- **kana와 토큰 reading 합의 일치.** 이 둘을 대조하는 코드가 없다.

**조인키는 kana다.** 영어의 `toLowerCase()` 조인키가 일본어 코드에 들어왔는지 grep하라. kana 비교는 세 곳에 있고 정규화가 서로 다르다.

- `applyVocabPostprocess`(`lib/ai/japanese/vocab.ts`): `normalizeJaWord`(NFKC + 공백 제거)로 제외 재적용, 중복 접기, 포함 이행을 판정한다.
- `appendJaVocabEntry`(`lib/store.ts`·`lib/store-firestore.ts`): `kana.trim()` 완전 일치로 collected 담기 중복을 판정한다.
- generate 라우트의 exclude 조립: `${word} ${kana}` 원문 키로 중복을 뺀다.

kana는 zod가 히라가나 전용으로 막으므로 지금은 차이가 드러날 입력이 좁다. 그래도 정규화가 세 벌이라는 것 자체가 "정의처가 하나인가" 점검 대상이다(P2 후보).

**포함 이행 판정의 한계(스펙 ↔ 코드 불일치).** §2-4 2번은 "모델이 활용형을 사전형으로 바꿔 냈으면 그것도 이행으로 본다"고 적었다. 코드는 정규화한 word나 kana의 완전 일치만 본다. 반례는 이렇다. include `食べた`가 결과 `食べる`/`たべる`로 오면 `missingIncludes`에 남는다. `食べる`가 제외 목록에 있으면 include 예외도 못 받아 버려진다. 확인하고 ai-engineer 담당으로 올린다.

**제외 재필터 범위(스펙 ↔ 코드 불일치).** §2-2는 "상한을 넘겨 잘린 경우에도 저장 단계에서 코드가 다시 걸러낸다"고 적었다. generate 라우트는 최근 200개로 자른 **같은** `exclude`를 프롬프트와 `applyVocabPostprocess` 양쪽에 넘긴다. 반례로 확인하라. 201번째로 오래된 단어는 프롬프트에도 재필터에도 없다.

## 3. 모드별 숙련도 분리

뜻은 알고 독음은 모르는 상태가 흔하다. 모드가 섞이면 "안다"가 거짓이 된다(§6-2). 세 층을 따로 확인한다.

1. **저장 층.** 러너가 문항을 콘텐츠 모드별로 갈라 모드마다 레코드 하나를 저장하는가.
   - `components/ja-quiz-runner.tsx`는 `byMode`로 갈라 `/api/japanese/vocab/[id]/quiz`를 모드 수만큼 부른다.
   - `components/ja-kanji-quiz-runner.tsx`도 같은 방식으로 `/api/japanese/kanji/quiz`를 부른다.
   - 라우트는 `mode`를 `z.enum(JA_QUIZ_MODES)`·`z.enum(JA_KANJI_QUIZ_MODES)`로 받는다. `bookId`는 본문이 아니라 URL에서 온다.
2. **컬렉션 층.** 영어 `vocabQuizzes`, 일본어 단어 `jaQuizzes`(`bookId`), 한자 `jaKanjiQuizzes`(`scope: "kanji"`, 서버가 붙인다)가 물리적으로 분리되어 있는가.
3. **집계 층.**
   - `aggregateJaStatsByMode`는 mode 문자열로 버킷을 나눈다. `buildJaReviewCandidatesByMode`는 mode로 필터한다.
   - `toVocabQuizRecords`가 mode를 `"def-to-word"`로 고정한다. 그래도 안전한 이유는 이렇다. `aggregateWordStats`는 `"relation"`만 제외하고, 호출 전에 이미 한 모드로 걸러진 그룹만 받는다.

**반례.**
- 本을 `ko-to-word`에서 맞히고 `kanji-to-kana`에서 틀린다. 두 버킷이 각각 {total 1, wrong 0, streak 1}과 {total 1, wrong 1, streak 0}이어야 한다.
- `kanji-to-on` 오답이 `ko-to-word` 통계에 섞이지 않아야 한다.
- 변이 테스트: 버킷 키를 상수로 바꾸거나 mode 필터를 지우면 eval이 FAIL해야 한다. J2·JK QA에서 실제로 FAIL을 확인했다.

**오답복습 경로.** `?wrong=<mode>`는 그 모드의 통계로 "틀렸고 미졸업"인 단어를 고르고 같은 모드로 출제한다. 저장도 **그 콘텐츠 모드 이름으로** 한다. 그래야 streak가 올라 졸업한다(`MASTERY_STREAK` 2). `JA_QUIZ_MODES`의 `"wrong-review"`는 라벨에만 있고 일본어 화면은 이 값으로 저장하지 않는다. 누군가 `wrong-review`로 저장하기 시작하면 별도 버킷이 생겨 원래 모드의 졸업이 영영 안 된다. 경로를 바꾼 변경이 있으면 이 반례를 돌려라.

혼합 세션은 저장 요청이 모드 수만큼 병렬로 나간다(`Promise.all`). 일부 모드만 저장에 실패했을 때 화면이 무엇을 말하는지 확인한다. 조용히 "저장됨"이면 결함이다.

## 4. 대화 병합

`mergeJaDialogBatches`(`lib/ai/japanese/dialog.ts`)가 실제로 하는 일은 다음과 같다.
- 직전에 채택한 발화와 `ja`가 **완전 일치하면** 접는다. 비교하는 것은 `prev.ja === turn.ja` 하나다. **화자는 보지 않고**, 배치 경계뿐 아니라 **한 배치 안에서도** 접는다.
- 직전 발화의 피드백이 null이고 접히는 쪽에 피드백이 있으면, 그 피드백을 직전 발화로 옮긴다.
- `focusKo`는 처음 나온 non-null을 쓴다.
- `partial`은 배치 중 하나라도 true면 true다.
- 전부 `unknown` 화자면 `allUnknown`을 켠다.

extract 라우트는 여기에 두 가지를 더한다. `Promise.allSettled`로 실패 배치를 빼고 `partial = merged.partial || anyFailed`로 알린다. 배치가 전부 실패하면 500이다.

**반례.**
- 한 글자 다른 발화(はい。 / はい!)는 접히지 않아야 한다. eval에 있다.
- 같은 발화가 **비연속**(A, B, A)이면 접히지 않아야 한다. eval에 없으니 직접 넣어 본다.
- 가운데 배치가 실패해도 나머지 순서가 보존되고 `partial`이 true인가. `allSettled`가 입력 순서를 지키는지 스텁으로 본다.
- **연속된 다른 화자의 같은 발화**가 접혀 내 발화와 피드백이 사라지는가. 2026-09-24에 오프라인으로 확인했더니 실제로 접혔다. 배치 하나 `[partner はい。, me はい。(피드백 praise), partner では。]`를 넣으면 결과가 `[partner はい。(praise), partner では。]`, `mergedCount` 1이다. 내 발화가 사라지고, 내 피드백이 상대 발화에 붙는다. 호출 C는 me 발화만 평가하므로 해설에서도 그 발화가 빠진다.
- **한 배치 안의 연속 반복**도 접히는가. 위 반례가 배치 하나라서 이미 이것을 보여준다. 사진 4장 이하(배치 1개)에서도 일어난다.

**병합 범위와 화자(스펙 ↔ 코드 불일치).** 스펙 §3-4는 "배치 결과를 순서대로 잇되 **경계에서** 같은 발화(`ja` 동일, 연속)가 반복되면 하나로 접는다"고 적었다. 코드는 배치 경계를 구분하지 않고 화자도 보지 않는다. eval의 병합 항목은 같은 화자의 경계 겹침과 한 글자 차이만 본다. 그래서 이 반례는 FAIL로 드러나지 않는다. 확인하고 ai-engineer 담당으로 올린다. 사용자 데이터(내 발화)가 조용히 사라지므로 P1이다.

**스텁으로 못 보는 것:** 병렬 배치가 같은 말풍선을 서로 다르게 전사하면 완전 일치 병합이 접지 못해 한 줄이 두 번 나온다. 실물 스크린샷으로만 드러나므로 "미검증"으로 남긴다.

## 5. 경계면 체크리스트 — 라우트 ↔ 화면

경계 타입의 단일 정의처는 `lib/japanese-vocab-contract.ts`, `lib/japanese-dialog-contract.ts`, `lib/japanese-kanji-contract.ts`, `lib/japanese-ruby-contract.ts`다. 마지막 것은 값 export가 0인 타입 전용 모듈이다. `lib/ai/japanese/schemas.ts`의 `JaToken`을 `export type`으로 재수출할 뿐이다. 클라이언트 컴포넌트 `components/ja-ruby.tsx`는 이 통로로만 `JaToken`을 받는다. 그래서 여기에 값 export가 하나라도 생기면 zod와 프롬프트가 클라 번들로 샌다. 순서변경 라우트는 과목 중립 계약 `lib/reorder-contract.ts`(`reorderRequestSchema`·`ReorderResponse`)를 쓴다. 라우트의 `NextResponse.json()` 인자와 화면의 fetch 소비 코드를 **같이 열어** 비교한다.

**단어장**
- [ ] **저장 라우트가 `JaVocabEntry`의 모든 필드를 선언하는가.** zod 4의 `z.object`는 모르는 키를 조용히 버린다. 2026-09-24에 확인한 사실이 있다. `POST /api/japanese/vocab`의 `jaEntrySchema`에 `imageEmoji`·`definitionJa`·`definitionTokens`가 없다. 그래서 생성 응답에 있던 세 값이 저장본에서 null이 된다(`normalizeJaVocabEntry` 폴백). 확인 방법은 7절의 스크래치 cwd 방식이다. 결과는 두 가지다. 새로 저장한 단어장에서 `def-to-word`가 출제되지 않고, 이모지가 첫 글자 배지로 떨어진다. `as JaVocabEntry[]` 캐스팅 때문에 tsc가 못 잡는다. **스키마에 필드가 늘 때마다 이 라우트를 같이 본다.** 회귀 테스트는 이렇다. 세 필드가 채워진 entry를 저장하고, `getJaVocabBook`으로 읽어 값이 남았는지 본다.
- [ ] generate 응답의 `perLevel[]`(`failed`·`missingIncludes`·`filteredCount`)가 검토 화면(`components/ja-vocab-new-flow.tsx`)에 사실대로 표시되는가. 지어낸 성공을 보여주지 않아야 한다(§8).
- [ ] 레벨 간 중복. generate 라우트는 레벨별 후처리 결과를 이어 붙이기만 한다. N2와 N3가 같은 단어를 내면 검토 화면과 저장본에 둘 다 들어간다. 의도인지 확인한다.
- [ ] 키 검사(501 `no_api_key`)가 store 조회·AI 호출보다 앞에 있는가(generate·extract·coach·enrich).
- [ ] 화면 상수(`JLPT_LEVELS`·`JA_VOCAB_TOPIC_PRESETS`·`JA_VOCAB_DEFAULT_COUNT`·`JA_INCLUDE_MAX`)는 서버 페이지(`app/japanese/vocab/new/page.tsx`)가 props로 내려주는가. 화면이 자기 목록을 따로 가지면 결함이다.
- [ ] 렌더 판정은 `isRenderableJaVocabBook`(`lib/japanese-record.ts`) 하나로 하는가. 목록은 그 줄을 건너뛰고, 상세·시험·오답·기록은 notFound를 낸다. quiz·rename 라우트는 404를 낸다. 대화 상세는 turns가 0이면 notFound다.
- [ ] 삭제는 prod-guard를 거치는가. 단어장 삭제는 `assertDestructiveAllowed("deleteJaVocabBook")`을 쓴다. 대화 삭제도 **같은 op 이름**을 쓴다(`lib/store-firestore.ts`).
- [ ] 순서변경 경계. `components/ja-vocab-library-view.tsx`의 `useReorder` `onPersist`가 `/api/japanese/vocab/reorder`에 `{ orderedIds }`를 보내는가. 라우트는 `reorderRequestSchema`로 받아(빈 배열·중복 거부) `reorderJaVocabBooks`를 부르고 200 `{ok, count}` / 400 / 500을 낸다. 확인할 것은 세 가지다. 실패하면 훅이 직전 순서로 되돌리고 화면이 오류 문구를 띄우는가. 성공 뒤 `router.refresh()`로 받은 순서가 서버 페이지(`app/japanese/vocab/page.tsx`)의 정렬(sortIndex null 먼저·최신 위 → sortIndex 오름차순)과 맞는가. collected 단어장도 같은 목록에서 함께 움직이는가. collected는 단어가 1개 이상일 때만 목록에 나온다(`isRenderableJaVocabBook`). 수정이라 prod-guard와 무관하다.

**대화**
- [ ] 순서변경 경계. `components/ja-dialog-library-view.tsx`의 `useReorder`가 `/api/japanese/dialog/reorder`를 부르고, 라우트는 같은 계약으로 `reorderJaDialogs`를 부르는가. 목록 정렬은 `app/japanese/dialog/page.tsx`가 단어장과 같은 규칙으로 한다. 실패 시 되돌림과 오류 문구는 단어장과 같게 확인한다.
- [ ] extract의 한도가 맞는가: 최대 20장, 총 `MAX_TOTAL_CHARS` 40,000,000자, 형식은 `lib/upload-limits.ts`. 사진 원본은 저장 요청에 실리지 않아야 한다(SPEC §1).
- [ ] coach 라우트의 두 모드. `{id}`는 재생성하고 `updateJaDialogCoaching`으로 저장한다. `{focusKo, turns}`는 생성만 해서 돌려준다. 해설이 실패해도 전사를 저장할 수 있다는 문구가 화면에 있는가(best-effort, §7-2).
- [ ] dialog 저장 라우트는 coaching의 top-level 모양만 본다(`goods`·`items` 등은 `z.unknown()`). 깊은 검증은 coach 라우트의 zod에 기댄다. coach를 거치지 않은 coaching이 저장될 경로가 없는지 본다.
- [ ] **담기(J5) 대상이 collected뿐인가.** add-word 라우트는 `getOrCreateJaCollectedVocabBook()`이 돌려준 단어장에만 append한다. JLPT id를 받을 입력이 없다. 이 성질이 깨지지 않았는지 본다.
  - 멱등: 같은 kana면 `added: false`.
  - 매핑: `pos: []`, `level: null`. 이모지와 정의는 null이다(`normalizeJaVocabEntry`).
- [ ] **담기는 인덱스 기반이다**(`{itemIndex}`). `components/ja-dialog-coaching-view.tsx`의 `addStates`가 인덱스를 키로 쓴다. 상세에서 "해설 다시 만들기" 뒤에는 `router.refresh()`만 하고 컴포넌트를 다시 마운트하지 않는다. 이전 해설의 "담았어요" 표시가 새 해설의 같은 번호 단어에 남는지 반례로 확인한다(P2 후보). 저장 전 검토 화면에는 `dialogId`가 없어 담기 버튼이 없어야 한다.
- [ ] 해설 뷰의 🔊와 🎧 해설 듣기.
  - 대본은 `buildCoachingScript` 순서(summary → goods → fixes → items → practice)를 따르고, 빈 섹션은 제목까지 뺀다.
  - 일본어 조각은 trim만 한다. 그래야 🔊 `speak(…, "ja-JP")`와 프리페치(`coachingJaTexts`)의 캐시 키가 같다.
  - 상세 화면은 말풍선과 해설 문장을 **한 번에** 프리페치한다. 해설 뷰는 `prefetch={false}`다.
  - 재생 엔진과 폴백 자체는 `common.md`에서 본다.

**한자**
- [ ] enrich는 `listJaVocabBooks()` 전체에서 한자를 모은다. `kind`를 가리지 않아 collected 단어의 한자도 들어간다. 스펙 §12-1은 "저장한 JLPT 단어장"이라고 적었다. 의도인지 확인하고, 어느 쪽이 맞든 스펙과 코드를 맞추라고 올린다.
- [ ] 불변 규약. 정보가 이미 있는 한자는 요청하지 않고, 저장은 insert-only다. 응답의 `filled`는 새로 채운 수만 세고, 채울 게 없으면 `nothingToFill`을 켠다. 배치가 전부 실패하면 500이다.
- [ ] 한자 시험 저장에 `scope: "kanji"`가 서버에서 붙는가. `jaQuizzes`에 섞이지 않아야 한다.

**공통**
- [ ] 클라 번들 경계. `"use client"`인 `components/ja-*.tsx`가 `@/lib/ai`를 값으로 import하지 않는가. 타입은 contract의 `export type` 통로로만 받는다. `.next/static`에 프롬프트 원문이 0건이어야 한다.
- [ ] 후리가나 렌더는 `components/ja-ruby.tsx` 한 곳에서만 하는가. TTS는 reading이 아니라 surface 원문을 읽는가.

## 6. 재사용 경계(§10) — 영어를 고치지 않았는가

**그대로 재사용하는 것**(수정 0이어야 한다):
- `lib/vocab-quiz.ts`의 `buildChoices`
- `lib/vocab-mastery.ts`의 `aggregateWordStats`·`isMastered`·`MASTERY_STREAK`
- `lib/vocab-review.ts`의 `buildReviewCandidates`
- `lib/ai/client.ts`의 `callWithSchema`·`imagePart`
- 사진 파이프, `components/use-reorder.ts`, `lib/prod-guard.ts`

client.ts에는 일본어 호출 함수만 **추가**됐다: `generateJapaneseVocab`, `extractJaDialog`, `coachJaDialog`, `generateKanjiInfo`. 래퍼 안에 과목 분기(`if japanese`)가 생기면 결함이다.

**일본어 쪽에 새로 둔 것:**
- 품사 enum `JA_POS`
- 후리가나 토큰(영어의 `ipa` 대신)
- `word`+`kana` 2축과 kana 조인키
- 프롬프트 전량(`lib/ai/japanese/prompts.ts`)
- 시험 모드 enum과 `jaQuizzes` 컬렉션
- `lib/speech.ts`의 `speak(text, lang)` 인자. 기본값 `TTS_LANG`은 `"en-US"`로 유지한다

`lib/ai/japanese/schemas.ts`가 영어 쪽에서 가져오는 것은 `StrictJsonSchema` **타입** 하나뿐이어야 한다.

확인 방법:
- 일본어 작업 커밋의 diff에 위 영어 파일이 있는지 본다(`git log -p -- lib/vocab-quiz.ts lib/vocab-mastery.ts …`).
- 있다면 `eval:english`를 오프라인으로 돌리고 영어 화면을 렌더해 회귀를 본다.
- 매 회차 eval 3종(english·math·japanese)을 오프라인으로 돌려 회귀 0을 확인한다.

## 7. 검증 시 지킬 것

- **이 과목은 eval에도 실호출이 없다.** `EVAL_JAPANESE=1`도 안내만 찍는다. 오프라인 eval은 2026-09-24 기준 112항목이다. 항목 수가 줄었으면 가드가 지워진 것인지부터 본다.
- 모든 명령에 SKILL.md의 접두어(키·GCP 신호 비우기, `STORE_BACKEND=file`)를 붙인다.
- **라우트 왕복을 저장소 데이터 없이 확인하는 법.** 파일 스토어는 `process.cwd()/data/db.json`에 쓴다(`lib/store.ts`의 `DB_DIR`). 절차는 이렇다.
  1. 스크래치 디렉터리를 cwd로 둔다.
  2. 라우트 모듈의 `POST`를 절대경로로 import하는 `.mts` 스크립트를 쓴다.
  3. `npx --prefix <저장소> tsx --tsconfig <저장소>/tsconfig.json <스크립트>`로 실행한다(`@/` 별칭 해석용).

  이러면 저장소의 `data/db.json`은 건드리지 않는다. AI를 부르는 라우트는 키가 비어 501로 끝난다. AI가 없는 저장·담기·시험 라우트는 끝까지 돈다. 저장소 cwd에서 돌렸다면 db.json의 sha를 복원하고 확인한다.
- 변이 테스트(가드를 무력화해 FAIL을 보는 것)를 했으면 byte-identical로 복원하고 md5로 확인한다.
- 코드를 고치지 않는다. 스펙과 코드의 불일치도 **어느 쪽이 맞는지 판정하지 말고** 양쪽 위치를 적어 올린다.

## 8. 리포트 형식

`_workspace/qa_report_japanese_{tag}_{n}.md`. SKILL.md의 공통 형식을 따른다. 기존 회차로 `j1`·`j2`·`jk`·`final`이 있다. 일본어 회차에는 아래 절을 더한다.

```
## 호출 A~D 매트릭스 — 위치별 실제 값(프롬프트 / zod 상수 / eval 항목), 여유 폭 칸 표시
## 축 분리 — 토큰 무결성 · 모드 버킷 · kind(jlpt/collected) · 컬렉션 · 영어 자산 diff
## 경계면 — 라우트 ↔ contract ↔ 화면 (필드 누락·strip 여부 포함)
## 스펙 ↔ 코드 불일치 — §번호 / 코드 위치 / 어느 쪽을 고칠지 결정 필요
## 미검증 — 레벨 정확성 · 읽기 정확성 · vision 전사 · 병렬 배치 표기차 · 실기기 발음
```

"스펙 ↔ 코드 불일치" 절에는 2026-09-24 현재 알려진 아래 건을 먼저 옮기고, 회차마다 아직 남았는지 다시 확인한다. 상세는 괄호 안 절에 있다.

| 스펙 | 코드 위치 | 요지 |
|---|---|---|
| §2-1 13번 | `JA_DEFINITION_JA_MIN`, eval `みず` 거부 | 스펙은 하한 없음, 코드는 min 4 (1절 호출 A) |
| §2-2 | generate 라우트 exclude 조립 | 재필터도 최근 200개만 본다 (2절) |
| §2-4 2번 | `applyVocabPostprocess` 포함 이행 | 활용형→사전형을 이행으로 안 본다 (2절) |
| §3-4 | `mergeJaDialogBatches` | 경계뿐 아니라 배치 안에서도, 화자 무시로 접는다. P1 (4절) |
| §4-4 | `jaDialogCoachingSchema` | 한글·일본 문자 검사가 일부 필드에만 있다 (1절 호출 C) |
| §6-1 | `quiz.ts` `buildOne` | "zod가 보장"이라 했지만 zod에 없다 (1절 호출 A) |
| §7-1 | `POST /api/japanese/vocab` `jaEntrySchema` | 이모지·일일정의·정의 토큰을 저장에서 버린다. P1 (5절 단어장) |
| §12-1 | enrich 라우트 `listJaVocabBooks()` | collected 단어의 한자도 모은다 (5절 한자) |

실패 한 건은 이 형식으로 적는다.

`- {제약} | 위치별 값 | {파일:함수} | 반례와 관측 | 수정 방법 | 담당: ai-engineer|app-builder | P1/P2`

사용자 데이터가 조용히 사라지는 결함은 P1이다. 저장 라우트의 필드 strip이 여기에 해당한다. 표시만 어긋나는 것은 P2다.

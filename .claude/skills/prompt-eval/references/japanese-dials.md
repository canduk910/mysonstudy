# 일본어(아빠의 일본어) 다이얼과 픽스처

> `prompt-eval` 스킬에서 일본어 과목을 튜닝할 때 읽는다. 영어는 `english-dials.md`, 수학은 `math-dials.md`.
> 원문 스펙은 `docs/harness/japanese.md`다. 호출 A(JLPT 단어 생성)는 §2, 호출 B(대화 전사)는 §3, 호출 C(대화 해설)는 §4, 후리가나 토큰 규약은 §5, 시험은 §6, eval은 §9, 호출 D(한자 정보)는 §12에 있다.
> 코드는 `lib/ai/japanese/`에 있다. `prompts.ts`에 프롬프트와 호출 옵션, `schemas.ts`에 JSON Schema·zod·상수, `vocab.ts`·`dialog.ts`·`kanji.ts`·`quiz.ts`에 후처리 순수 함수가 산다. eval은 `scripts/eval-japanese.ts`다.

## 먼저 알 것 — 학습자는 성인이고, 실호출 eval은 없다

**눈높이 방향이 영어와 반대다.** 은우용 프롬프트는 "쉬운 말"을 강하게 건다. 일본어 프롬프트는 JLPT 등급이 요구하는 어휘·문법을 그 수준 그대로 쓴다(§0-1). 그래서 아빠가 "어려워"라고 하면 먼저 무엇이 어려운지 가른다.

- 레벨 자체가 어렵다면 다이얼이 아니다. 레벨은 아빠가 화면에서 고른다.
- 예문 문법이 그 레벨을 넘는다면 `[예문]` 규칙을 손본다.
- 해설 설명이 불친절하다면 호출 C의 `whyKo`·`usageKo` 깊이를 손본다.

영어 프롬프트 문구("쉬운 단어로", "초등 눈높이")는 옮겨 오지 마라. 일본어에서는 반대로 작동한다.

**`EVAL_JAPANESE=1`은 실호출을 하지 않는다.** `scripts/eval-japanese.ts`의 `main`은 이 게이트에서 안내 문구만 찍는다. 일본어 eval은 사실상 오프라인 전용이고, 그래서 이 문서가 다루는 품질 다이얼(레벨 정확성·해설 깊이)은 **eval로 확인되지 않는다.** eval이 지키는 것은 형식과 동기화뿐이다. 품질 판단 근거는 아빠의 피드백과 실제 산출물이다. 실제 산출물을 보려면 사용자 동의를 받아 앱에서 1회 생성해야 한다.

## 다섯 번째 동기화 지점 — 스펙 코드블록

일본어는 프롬프트와 JSON Schema를 **둘 다** 스펙과 대조한다. 대조 대상은 `SPEC_SYNC_TARGETS`에 있다.

- **문자열 바이트 대조 6건**: `JA_VOCAB_SYSTEM_PROMPT`(§2-1), `JA_VOCAB_USER_TEMPLATE`(§2-2), `JA_DIALOG_EXTRACT_SYSTEM_PROMPT`(§3-1), `JA_DIALOG_EXTRACT_USER_TEXT`(§3-2), `JA_DIALOG_COACH_SYSTEM_PROMPT`(§4-1), `JA_KANJI_SYSTEM_PROMPT`(§12-2-1).
- **JSON Schema 의미 동치 4건**: `runJsonSchemaSyncChecks`가 스펙 코드블록을 JSON으로 파싱해 deep-equal한다. 대상은 §2-3(`ja_vocab_generation`), §3-3, §4-3, §12-2-2다. §3-3·§4-3은 `$defs.tokens`를 `"…§2-3과 동일"` 자리표시자로 바꾼 뒤 구조만 비교한다.
- **대조하지 않는 것**: `buildJaDialogCoachUserMessage`(호출 C 사용자 메시지)와 `buildJaKanjiUserMessage`(호출 D). 둘 다 파라미터가 든 서술이라 대조 대상에서 빠졌다. 이 둘은 고쳐도 eval이 모른다.

프롬프트 한 줄을 바꾸면 `prompts.ts`와 `docs/harness/japanese.md`의 해당 코드블록을 같은 문자열로 함께 바꾼다. JSON Schema의 `description`도 같다. 호출 C의 총평 분량("이번 대화 총평 2~3문장")은 시스템 프롬프트 본문이 아니라 `summaryKo`의 JSON Schema `description`에만 있다.

## 다이얼 → 동기화 지점

한 행을 바꾸면 그 행의 모든 위치를 함께 바꾼다. "—"는 그 위치에 정의가 없다는 뜻이다.

### 호출 A — JLPT 단어 생성 (`call: "ja-vocab"`, temperature 0.4, maxOutputTokens 8,000)

| 다이얼 | 프롬프트 (§2-1·§2-2) | schemas.ts (zod·상수) | eval-japanese.ts | 그 밖의 소비처 |
|---|---|---|---|---|
| 레벨당 개수 10 | 시스템 프롬프트엔 숫자가 없다. `buildJaVocabUserMessage`가 `{count}`를 채운다 | `JA_VOCAB_DEFAULT_COUNT` 10. zod entries 1~`JA_ENTRIES_MAX`(10, **별도 상수**) | "entries 11개(초과)" 거부. 배분 계획 3건(10을 인자로 넘김) | `planIncludeDistribution`, generate 라우트, 저장 라우트 `ENTRIES_SAVE_MAX = JA_ENTRIES_MAX × 레벨 5`, 화면 `perLevelCount` props |
| 꼭 넣을 단어 상한 | `[꼭 넣을 단어]` | `JA_INCLUDE_MAX = JA_VOCAB_DEFAULT_COUNT`, `JA_INCLUDE_WORD_MAX` 20 | include 우선·포함 이행 보고·배분 계획 | generate 라우트 zod + 라우트 로컬 `JA_CHAR_PATTERN`(일본 문자만) |
| 누적 제외 상한 | 사용자 메시지 `이미 가지고 있는 단어` 줄 | `JA_EXCLUDE_PROMPT_MAX` 200 | 사용자 메시지 치환 2건. 상한 자체는 검사하지 않는다 | generate 라우트가 최근 것부터 200개를 모아 뒤집어 넘긴다. 빌더도 `slice(-200)` |
| 뜻 개수·길이 | `[뜻(한국어)]` "1~3개" | `JA_MEANINGS_MAX` 3, min 1, `JA_MEANING_KO_MAX` 60, 한글 포함 | 0개·4개·한글 없음 거부 | 호출 C `items[].meaningKo`(`jaDialogItemSchema`)도 같은 `JA_MEANING_KO_MAX`를 쓴다. 길이 상한을 바꾸면 해설 어휘의 뜻도 함께 바뀐다 |
| 표제어·kana 길이 | — | `JA_WORD_MAX` 30 / `JA_KANA_MAX` 40 | 길이 반례 없음 | 호출 C `items[].word`·`kana`와 저장 라우트 `jaEntrySchema`(`app/api/japanese/vocab/route.ts`)가 같은 상수를 쓴다. `JA_WORD_MAX`는 시험 저장 라우트(`vocab/[id]/quiz`·`kanji/quiz`)의 문항 `word`에도 걸린다. 상수를 내리면 이미 저장된 긴 표제어의 시험 결과가 400으로 저장되지 않는다. 바꿀 때는 모든 소비처를 함께 본다 |
| 예문 길이 | `[예문]` "15~30자 정도" | `JA_EXAMPLE_JA_MIN` 5 / `JA_EXAMPLE_JA_MAX` 60 | "5자 미만" 거부만 | 호출 C의 items·practice 예문도 같은 `jaExampleSchema`를 쓴다 |
| 일일정의 길이 | `[일일정의]` "길어도 60자", "짧아도 좋다" | `JA_DEFINITION_JA_MIN` 4 / `JA_DEFINITION_JA_MAX` 60. 표제어 포함 금지, 일본 문자 필수 | 4자·7자 통과, 2자(`みず`) 거부, 표제어 포함 거부, 일본 문자 없음 거부 | `def-to-word` 시험(§6-1). **스펙 §2-1 13번은 "하한을 두지 않는다"고 적어 min 4와 어긋난다**(아래 여유 폭 절) |
| 이모지 | `[이모지]` "딱 1개, 없으면 null" | 자소 1개 + `\p{Extended_Pictographic}`, `JA_IMAGE_EMOJI_MAX` 32 | 통과 3·거부 4 + `resolveJaGlyph` 우선순위 | 화면 글리프(`resolveJaGlyph` 한 곳) |
| 품사 체계 10종 | `[품사]` 목록 | `JA_POS` + JSON Schema `enum`(리터럴 배열), zod 1~`JA_POS_MAX` 4 | "JSON Schema pos enum == JA_POS", "JA_POS 10종", "enum 밖" 거부 | cloze 오답 '같은 품사 우선' |
| 주제 프리셋 5종 | 목록 없음. 사용자 메시지 `주제:` 줄만 | `JA_VOCAB_TOPIC_PRESETS` | 상수 정합(리터럴 문자열 비교) | 화면 `topicPresets` props, 라우트 `TOPIC_MAX` 40 |
| 레벨 준수·유의어 금지·품사 고루 | 서술만 | — | — | 정성 판단. 사람이 본다 |

**레벨당 10개는 사용자 확정 결정이다**(§0-2). 튜닝으로 바꾸지 않는다. 사용자가 바꾸기로 하면 `JA_VOCAB_DEFAULT_COUNT`와 `JA_ENTRIES_MAX`를 **함께** 올린다. `JA_ENTRIES_MAX`는 기본 개수에서 파생되지 않는다. 하나만 올리면 모델이 요청대로 12개를 냈을 때 zod가 거부한다. 재요청까지 실패하면 그 레벨 생성이 통째로 사라진다.

### 호출 C — 대화 학습 해설 (`call: "ja-dialog-coach"`, temperature 0.5, maxOutputTokens 8,000)

"설명이 길어/짧아" 같은 피드백은 대부분 이 호출의 다이얼이다.

| 다이얼 | 프롬프트 (§4-1) | zod (`schemas.ts`) | eval-japanese.ts |
|---|---|---|---|
| 잘한 점 개수 | 개수 없음 | 0~`JA_DIALOG_GOODS_MAX` 6 | 7개 거부 |
| 고칠 점 개수 | "없으면 빈 배열" | 0~`JA_DIALOG_FIXES_MAX` 8 | 개수 반례 없음 |
| 어휘·표현 개수 | "3~6개" | `JA_DIALOG_ITEMS_MIN` 2 ~ `JA_DIALOG_ITEMS_MAX` 8 | 1개 거부(상한 반례 없음) |
| 다음 연습 개수 | "2~3개" | `JA_DIALOG_PRACTICE_MIN` 1 ~ `JA_DIALOG_PRACTICE_MAX` 5 | 0개 거부(상한 반례 없음) |
| 총평 분량 | JSON Schema `description` "2~3문장" | 한글 필수, 최대 `JA_DIALOG_TEXT_MAX × 2`(800) | 한글 없음 거부 |
| 설명 깊이(`whyKo`·`usageKo`) | `[잘한 점]`·`[고칠 점]`·`[어휘·표현]` 서술 | `goods[].whyKo`·`fixes[].whyKo`·`items[].usageKo` 각 최대 `JA_DIALOG_TEXT_MAX` 400, 한글 필수 | 깊이 반례 없음 |
| 문법 이름(`grammarKo`) | `[고칠 점]` 서술 | nullable, 최대 400, **한글 검사 없음** | — |

`grammarKo`는 스펙 §4-4("한국어 필드는 한글 포함 검증")와 어긋난다. 모델이 문법 이름을 영어로 내도 zod가 통과시킨다. 일본어 쪽도 `hasJapanese`는 `quoteJa`·`originalJa`·`betterJa`에만 걸린다. `items[].word`·`items[].example.ja`·`practice[].ja`는 일본 문자를 검사하지 않는다. 어느 쪽을 맞출지는 튜닝이 아니라 스펙 결정이다. 프롬프트로 덮지 말고 ai-engineer로 올린다. 반례는 `study-qa/references/japanese.md` 1절에 있다.

호출 C 출력은 낭독 대본의 재료이기도 하다. `buildCoachingScript`(`lib/ja-coaching-script.ts`)가 summary → goods → fixes → items → practice 순서로 필드를 읽는다. 개수를 늘리면 "🎧 해설 전체 듣기" 길이도 늘어난다. 필드 이름이나 모양이 바뀌면 이 함수와 `coachingJaTexts`, `scripts/eval-speech.ts`를 함께 맞춘다(§13).

### 호출 B·D — 개수 다이얼은 적다

| 호출 | 다이얼 | 위치 | eval |
|---|---|---|---|
| B (`ja-dialog-extract`, temperature 0, 8,000) | 배치 크기 4장 | `JA_DIALOG_BATCH_SIZE` → `planJaDialogBatches`. extract 라우트 상한 `MAX_DIALOG_IMAGES` 20장 | `planJaDialogBatches` 1건 |
| D (`ja-kanji`, temperature 0.2, 3,000) | 음독 개수 | 프롬프트 "1~3개", zod 0~`JA_KANJI_READINGS_MAX` 3(훈독도 같은 상수) | 음독 4개 거부 |
| D | 뜻 길이 | 프롬프트 "1~20자", zod `JA_KANJI_MEANING_KO_MAX` 20 | 21자 거부 |
| D | 배치 크기·맥락 단어 수 | `JA_KANJI_BATCH_SIZE` 10(enrich 라우트), `JA_KANJI_SAMPLE_WORDS_MAX` 5(`selectKanjiToEnrich`) | 선별 1건 |

B의 temperature 0은 다이얼이 아니다(아래 정확성 장치). 배치 크기에는 대가가 따른다. 키우면 호출 수는 줄지만 한 응답이 길어진다. 줄이면 장 경계가 늘어 겹침 병합에 더 기댄다.

## 여유 폭 — 프롬프트가 zod보다 좁은 것은 의도다

호출 C의 어휘는 프롬프트가 3~6개를 겨냥하지만 zod는 2~8개를 받는다. 예문도 프롬프트는 15~30자를, zod는 5~60자를 받는다. 이 차이는 결함이 아니다. zod가 실패하면 `callWithSchema`가 1회 재요청하고, 그것도 실패하면 throw한다. 호출 A라면 그 레벨이 사라진다. 호출 C는 경로마다 다르다. 새 대화 저장 흐름(`components/ja-dialog-new-flow.tsx`)에서는 해설 없이 전사만 `coaching: null`로 저장된다. 저장된 대화에서 "해설 다시 만들기"(`/api/japanese/dialog/coach`의 `{id}` 모드)가 실패하면 500 `coach_failed`가 나고 기존 해설이 그대로 남는다. **조금 벗어난 출력으로 생성 전체가 날아가지 않게 zod를 넓게 둔다.**

실제 사고가 있었다. 일일정의 하한을 15자로 걸었더니 모델이 "표제어보다 쉽게"를 지키려고 짧은 정의(水 →「のむもの」)를 냈다. 그 정의가 거부되자 N5 생성이 통째로 throw했다(P0). 그래서 하한을 `JA_DEFINITION_JA_MIN` 4로 낮췄고, eval에 "짧은 정의 통과" 회귀 가드 두 건을 두었다.

이 하한도 스펙과 완전히 맞지는 않는다. 스펙 §2-1 13번은 "짧을수록 좋다 — 하한을 두지 않는다"고 적었다. 코드는 min 4이고, eval은 `みず`(2자)를 "너무 짧음"으로 거부하게 잠갔다. 어느 쪽을 맞출지는 튜닝이 아니다. 다만 하한을 올리는 쪽으로는 움직이지 않는다. 올리면 P0가 재발한다.

규칙은 두 가지다.
- 프롬프트 개수를 움직일 때는 zod 폭 안에서 움직인다. 폭을 넘어야 하면 zod 상수와 스펙 §4-4(또는 §2-4)를 같은 변경에서 함께 넓힌다.
- "일관성"을 이유로 zod를 프롬프트 폭으로 좁히지 마라.

zod 오류 문구는 재요청 프롬프트로 쓰인다. `callWithSchema`는 재요청할 때 "다음 검증 오류를 고쳐 다시 출력해: …"에 `summarizeZodError` 결과를 붙인다. 그래서 `schemas.ts`의 `message`를 모호하게 고치면 재요청 성공률이 떨어진다.

## 건드리지 않는 것 — 정확성 장치

품질 다이얼이 아니다. 필요해 보이면 ai-engineer에게 반환한다.

- **토큰 무결성.** `surface`를 이으면 원문(`word`·`example.ja`·`definitionJa`·발화 `ja`·해설 예문)과 정확히 같아야 한다. 호출 A~C의 zod `superRefine`이 모두 이것을 검사한다. 어긋나면 후리가나가 본문을 왜곡한 것이고, 검색·TTS·시험 비교가 전부 틀어진다.
- **reading 규칙**(`jaTokenSchema`).
  - (a) reading을 단 토큰의 surface가 한자+가나 혼합이면 거부한다. 오쿠리가나를 묶은 경우다.
  - (b) 한자만 든 토큰의 reading은 히라가나만 받는다.
  - (c) 한자가 없는 토큰에 붙은 reading은 거부하지 않고 null로 정리한다.
- **kana는 히라가나 전용**이다(`isHiraganaOnly`, 장음 `ー`만 허용). kana가 조인키이기 때문이다.
- **kana 조인키.** `applyVocabPostprocess`가 제외 재적용·중복 접기·포함 이행을 `normalizeJaWord`(NFKC + 공백 제거) 기준으로 한다. 영어의 `toLowerCase()` 조인키를 들여오지 마라(§10).
- **레벨 태깅은 코드가 한다.** `JaVocabGenEntry`와 JSON Schema에는 `level` 필드가 없다. `applyVocabPostprocess`가 호출 인자의 레벨을 붙인다. 모델에게 레벨을 적게 하는 필드를 더하면 검증할 수 없는 값을 모델에 맡기게 된다.
- **누적 제외 재필터**(`applyVocabPostprocess` 1단계)와 include 우선 예외. 프롬프트가 제외를 어겨도 저장에는 안 들어간다. 제외 위반이 보여도 이 필터를 건드릴 이유는 없다. 증상은 "10개보다 적게 나온다"(`filteredCount`)로 나타난다.
- **호출 B 전사 프롬프트 전체.** 판독만 하고 창작하지 않는다. temperature 0, 애매한 화자는 `unknown`, 잘리면 `partial`, 피드백은 원문 그대로다. "매끄럽게" 쪽으로 다듬으면 지어낸 발화가 섞인다.
- **겹침 병합은 완전 일치만 접는다**(`mergeJaDialogBatches`). 유사도 판정을 넣으면 서로 다른 발화를 삼킨다. 다만 지금 코드는 이미 너무 많이 접는다. 직전 발화와 `ja`가 같으면 **화자를 보지 않고**, 배치 경계뿐 아니라 **한 배치 안에서도** 접는다. 스펙 §3-4는 "경계에서"만 접으라고 했다. 상대의 はい。 바로 뒤에 내가 はい。라고 하면 내 발화가 사라진다. 상대 발화에 피드백이 없었으면 내 발화의 피드백이 상대 발화로 옮겨 붙는다. 코드 결함 후보다. 튜닝으로 병합을 느슨하게도, 엄격하게도 바꾸지 말고 ai-engineer로 올린다.
- **`definitionJa`에 표제어 포함 금지.** `def-to-word`가 문제를 소리로 읽어도 정답이 새지 않는다는 근거다.
- **호출 D 불변 규약.** 정보가 이미 있는 한자는 요청하지 않는다(`selectKanjiToEnrich`). 저장은 insert-only다. 요청하지 않은 한자는 `applyKanjiPostprocess`가 버린다.

포함 단어 누락이 잦다고 후처리의 일치 판정을 느슨하게 하지 마라. 수학의 `held`를 줄이려고 검산을 풀면 안 되는 것과 같다. 느슨한 일치는 다른 단어를 "넣었다"고 보고한다.

## eval 실행 — 무비용, 오프라인 112항목

```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npx tsx scripts/eval-japanese.ts
```

`npm run eval:japanese`와 같은 스크립트다. 항목 하나라도 실패하면 exit 1이다. 2026-09-24 기준 12개 영역 112항목이다.

| 영역 | 항목 수 | 무엇을 잠그나 |
|---|---|---|
| 상수 정합 | 4 | `JLPT_LEVELS`, `JA_POS` 10종, 주제 프리셋, 스키마 enum과 `JA_POS` 일치 |
| 호출 A zod(§2-4) | 28 | 정상·reading 정리·거부 14종·일일정의·definitionTokens |
| 오쿠리가나(§2-1-11) | 5 | 올바른 분리 통과, 묶음 거부 3건, 숙어 묶기 통과 |
| 이모지(호출 A) | 8 | zod 통과·거부, `resolveJaGlyph` |
| 후처리(§2-4) | 10 | 제외 재적용(word·kana), include 우선, 포함 이행, 중복 접기, 레벨 태깅, 부분 성공, 하위호환 |
| 배분 계획(§2-0) | 3 | include는 첫 레벨에만, 정규화 |
| 사용자 메시지(§2-2) | 2 | 치환과 "없음" 폴백 |
| 시험 4모드(§6-1) | 8 | 5모드 보기, `kanji-to-kana` 가나 단어 제외, cloze 치환·같은 품사, `def-to-word` |
| 모드 분리(§6-2) | 2 | 뜻/독음 통계, 복습 후보가 섞이지 않음 |
| 한자(§12) | 15 | 수집·선별·후처리·zod·2모드·모드 무오염 |
| 대화(§3·§4) | 17 | 병합, 배치 계획, zod B·C |
| 프롬프트 ↔ 스펙 | 10 | 문자열 6건 + JSON Schema 4건 |

- 영역 이름 "시험 4모드"는 옛 이름이다. 실제로는 `def-to-word`까지 5모드를 본다.
- `EVAL_OFFLINE_ONLY=1`은 모듈 최상단에서 `main`보다 먼저 `globalThis.fetch`를 차단 함수로 바꾼다.
- 스크립트가 `.env`를 스스로 읽는다(`process.loadEnvFile`). 지금은 네트워크 코드가 없어도, 앞으로 실호출 구간이 생기면 이 접두어가 유일한 차단선이다. 늘 접두어를 붙여라.

실호출 검증이 필요하면 리포트에 몇 회인지 적는다. 모든 호출은 zod 실패 시 1회 재요청하므로 아래 수에 최대 ×2가 붙는다.

- **A**: 고른 레벨 수만큼 병렬 호출한다(1~5회).
- **B**: `ceil(장수 / 4)`회다. 최대 20장이면 5회다.
- **C**: 1회다.
- **D**: `ceil(정보 없는 한자 수 / 10)`회다. 상한이 없어 수집된 한자 수에 비례한다.


**호출 C(대화 해설)를 실물로 보려면** — 로컬에는 해설에 넣을 대화가 없다(seed의 일본어 컬렉션은 비어 있고, 사진 픽스처가 없고, 프로덕션 조회는 안전 규칙상 금지). 동의를 받은 뒤 **사용자에게 전사 텍스트를 받아** `POST /api/japanese/dialog/coach`의 저장하지 않는 모드(`{ focusKo, turns }` — 생성만 하고 반환)나 `coachJaDialog`를 부르는 scratch 스크립트로 1회(재요청 시 2회) 돌리고, 산출물(`goods`·`fixes`·`items`·`practice`)을 사람이 읽는다. 해설 개수를 바꿨다면 해설 듣기 대본 길이(`buildCoachingScript`)도 같이 늘어난다는 점을 함께 본다.
## 픽스처

**일본어 픽스처는 전부 `scripts/eval-japanese.ts` 안에 인라인으로 있다.** 스펙에 적힌 원본값이 아니다(영어 SPEC §12의 Wolves·Pooh와 다르다). 모양 반례를 만드는 헬퍼와 데이터다.

- `genEntry`: 기본값은 本/ほん이다. `definitionTokens`는 `definitionJa`에서 자동 파생한다.
- `quizEntries`: 명사 5개 + 동사 見る + 가나 단어 すし.
- 오쿠리가나 단어: 促す·食べる·一日·広がった·目標·気持ち.
- 대화: `WATASHI`(私は学生です。)와 자기소개 배치 2개, `goodCoaching`.
- 한자: 本·水·火·木·金·畑(음독 없음).

통과 케이스를 모델 출력에 맞춰 고치거나 거부 케이스를 지우면 가드가 무력화된다. 특히 지키는 반례는 세 가지다.
- "짧은 정의 통과"(P0 회귀 가드)
- 오쿠리가나 묶음 거부
- 모드 분리 반례(本: `ko-to-word` 정답, `kanji-to-kana` 오답)

**호출 B의 사진 픽스처는 없다.** 사진은 저장하지 않으므로(SPEC §1) vision 품질은 아빠가 찍은 실제 스크린샷으로만 확인할 수 있다. `scripts/seed.ts`도 일본어 컬렉션을 빈 배열로 둔다.

## 결과 해석 — eval이 FAIL일 때

| 실패 영역 | 먼저 볼 것 | 통상 원인 · 조치 |
|---|---|---|
| 프롬프트 ↔ 스펙 (문자열) | 출력 끝의 spec-sync 상세. 첫 불일치 줄이 프롬프트 쪽과 스펙 파일 쪽 양쪽으로 찍힌다 | `prompts.ts`만 고치고 `docs/harness/japanese.md` 코드블록을 안 고쳤다(또는 그 반대). 두 곳을 같은 문자열로 맞춘다 |
| JSON Schema 의미 동치 | 어느 스키마인지(§2-3·§3-3·§4-3·§12-2-2) | `description` 한 글자까지 본다. 구조 변경이면 튜닝이 아니다. ai-engineer로 반환 |
| 호출 A zod "통과되면 안 됨" | 어느 거부 케이스인지 | zod를 느슨하게 만들었다. 의도한 완화라면 스펙 §2-4와 거부 케이스를 같이 고친다 |
| "짧은 정의 통과" 실패 | `JA_DEFINITION_JA_MIN` | 하한을 올렸다. P0 재발이다. 되돌린다 |
| 오쿠리가나 | `jaTokenSchema` | reading 규칙 (a)~(c)가 바뀌었다. 정확성 장치라 되돌린다 |
| 상수 정합 | `JA_POS`·프리셋·스키마 `enum` | 한 곳만 고쳤다. `JA_POS`와 스키마 `enum`은 따로 적힌 리터럴이다 |
| 시험·모드 분리·한자 | `quiz.ts`·`kanji.ts` | 튜닝 범위 밖이다. 이 파일을 건드렸다면 되돌리고 ai-engineer로 반환 |

## 증상 → 다이얼 — 아빠의 피드백을 옮기는 표

실호출 eval이 없으므로 이 표가 품질 튜닝의 출발점이다. 각 항목에 코드로 확인한 사실을 달았다.

| 증상 | 먼저 볼 것 | 판단 |
|---|---|---|
| "N3인데 단어가 너무 쉬워/어려워" | `[레벨]` 규칙, 주제 해석 규칙 | 프롬프트 다이얼이다. 주제가 좁아 레벨 밖으로 새면 "주제를 넓게 해석" 쪽을 강조한다. 레벨 태깅은 건드리지 않는다 |
| "이미 있는 단어가 또 나와" | 같은 kana인가, 활용형·파생형 우회인가, 오래된 단어인가 | 같은 kana면 후처리가 이미 거른다. 우회라면 `[제외 목록]` 둘째 줄을 강화한다. 오래된 단어면 제외 상한 200을 넘은 것이다. 저장 재필터도 프롬프트에 실린 200개만 보고 걸러내기 때문이다. 또 generate 라우트는 레벨별 후처리 결과를 이어 붙일 뿐 **레벨 간 중복을 접지 않는다**. 한 번에 N2·N3을 만들 때 겹치면 그대로 나온다. 코드 문제라 ai-engineer·app-builder 몫이다 |
| "꼭 넣은 단어가 못 들어갔대" | 응답 `perLevel[].missingIncludes` | 포함 이행 판정은 정규화한 word나 kana의 **완전 일치뿐**이다. 프롬프트 규칙대로 모델이 활용형(食べた)을 사전형(食べる)으로 정리하면 missing으로 보고된다. 그 사전형이 제외 목록에 있으면 include 예외도 못 받고 걸러진다. 스펙 §2-4 2번은 "활용형→사전형도 이행으로 본다"고 적었지만 코드는 그렇게 하지 않는다. 튜닝이 아니다. ai-engineer로 반환 |
| "빈칸 문제가 적어" | 예문에 표제어가 그대로 들어 있는가 | cloze는 `example.ja.includes(word)`일 때만 출제된다(`quiz.ts`의 `buildOne`). **zod는 이것을 검사하지 않는다.** 스펙 §6-1은 "zod가 보장"이라고 적었는데 코드와 어긋난다. 동사를 활용형으로 쓴 예문은 조용히 빠진다. `[예문]`의 "표제어를 자연스럽게 포함"을 사전형 포함으로 조일지는 문장 자연스러움과 부딪히므로 사용자와 논의한다 |
| "후리가나가 글자마다 쪼개져" | wordTokens·example.tokens | 숙어 묶기(目標 → 目標(もくひょう))는 프롬프트 규칙뿐이다. zod가 쪼갠 것을 막을 수 없고 eval도 통과 케이스만 있다. `[후리가나]` 예시를 늘린다 |
| "읽기가 틀렸어" | 해당 토큰 | zod는 reading이 히라가나인지만 본다. **kana와 토큰 reading 합이 같은지 대조하는 코드가 없다.** 프롬프트로는 확률만 올릴 수 있다. 검증 장치가 필요하면 ai-engineer와 논의한다 |
| "일일정의·이모지가 안 보여" / "뜻풀이 문제(`def-to-word`)가 안 나와" | generate 응답의 `entries[].definitionJa`·`imageEmoji` ↔ 저장본 | **먼저 코드 결함을 배제한다.** 검토 화면(`components/ja-vocab-new-flow.tsx`)은 이 두 필드를 그리지 않는다. 그러니 generate 응답 JSON과 저장 뒤 값(상세 화면, `getJaVocabBook`)을 비교한다. 응답에는 있는데 저장 뒤 null이면 `POST /api/japanese/vocab`의 `jaEntrySchema`가 선언하지 않은 필드를 버린 것이다. zod `z.object`는 모르는 키를 지운다. 2026-09-24 현재 `imageEmoji`·`definitionJa`·`definitionTokens`가 모두 빠져 있어서, 새로 저장하는 모든 단어장이 이렇게 된다. 튜닝 대상이 아니다. app-builder로 반환한다 |
| "일일정의가 없는 단어가 많아" | 위 행으로 저장 결함을 배제한 뒤, 레벨 | N5·N4는 null이 많아도 정상이다(§2-1 13번). 그만큼 `def-to-word` 문항이 줄 뿐이다. 하한을 올리지 마라(P0). 스펙은 하한 자체를 두지 말라고 했는데 코드는 min 4다. 이 불일치는 여유 폭 절에 적었다 |
| "해설이 너무 길어/짧아" | 호출 C 개수·깊이 | 여유 폭 안에서 프롬프트를 움직인다. 낭독 길이도 같이 변한다 |
| "해설이 듀오링고 말만 되풀이해" | `[고칠 점]` 둘째 줄 | "더 깊이 설명", "넘어간 어색함도 짚는다"를 강화한다. 억지 흠 만들기(`[없으면 없다]`)와 균형을 맞춘다 |
| "대화 한 줄이 두 번 나와" | 배치 경계 | 병렬 배치는 서로를 모른다. 같은 말풍선을 다르게 전사하면 완전 일치 병합이 접지 못한다. 병합을 느슨하게 하지 말고 배치 크기나 촬영 장수를 조정한다 |
| "내 발화가 사라졌어" / "피드백이 상대 말에 붙어 있어" | 사라진 발화 바로 앞 줄 | 앞 줄이 같은 문장(はい。 등)이면 병합 결함이다. `mergeJaDialogBatches`는 화자를 보지 않고, 배치 안에서도 연속된 같은 `ja`를 접는다. 사진 4장 이하, 즉 배치 하나에서도 일어난다. 프롬프트 문제가 아니다. ai-engineer로 반환한다(위 정확성 장치 절) |

## eval이 못 잡는 것

아래 항목은 리포트에 **미검증**으로 남긴다.

- 단어가 정말 그 JLPT 등급인지(호출 A 레벨 정확성)
- 후리가나 읽기가 맞는지, 숙어를 묶었는지
- 호출 B가 스크린샷의 순서·화자·피드백을 옳게 옮겼는지. 사진 픽스처가 없다
- 호출 C의 고칠 점이 실제 오류를 짚는지
- 병렬 호출 간 표기 불일치(레벨 병렬, 스크린샷 배치, 한자 배치). 스텁은 늘 같은 응답을 준다
- 한국 한자음(`koReading`)과 음독이 사실인지. zod는 한글 1자와 히라가나 여부만 본다

## 하지 말 것

- 스키마 구조 변경(필드 추가·삭제·타입 변경)은 튜닝이 아니다. ai-engineer로 반환한다.
- 사용자 확정 결정(§0-2)을 튜닝으로 바꾸지 않는다. 레벨마다 10개, 누적 제외, include가 exclude보다 우선, 전 문장 후리가나가 여기에 해당한다.
- 이 문서만 보고 실호출 eval을 새로 짜서 돌리지 않는다. `EVAL_JAPANESE=1` 구간 구현과 실행은 동의를 받은 오케스트레이터 몫이다.
- 호출 B 프롬프트는 정확성 영역이다. 품질 피드백이 B를 가리키면 먼저 사진 문제(잘림·겹침)인지 가른다.

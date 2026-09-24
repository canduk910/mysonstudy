# 영어 다이얼과 픽스처 — 호출 A~H 튜닝 지도

> `prompt-eval` 스킬에서 영어(북카드·단어장·챕터 리더) 튜닝 시 읽는다. 수학은 `math-dials.md`, 일본어는 `japanese-dials.md`.
> 원문 스펙: `docs/harness/english.md` 전체 — §2 A · §2A A′ · §3 B · §7 C · §8 D · §9 F · §10 G · §11 H (호출 E는 없다).
> 프롬프트 원문은 여기 옮기지 않는다. 스펙이 단일 진실 원천이고 spec-sync가 코드와 글자 단위로 대조한다(§5).

## 목차

1. 호출 지도 — 무엇이 어디에 사는가
2. 호출 B(카드) 다이얼 — 튜닝의 본무대
3. 호출 D·G·H 다이얼
4. 건드리지 않는 정확성 장치
5. 동기화 지점 — 4중 정의와 spec-sync
6. eval 실행 — 게이트별로 무엇이 켜지고 몇 번 부르나
7. 픽스처
8. 결과 해석 가이드
9. 하지 말 것

## 1. 호출 지도

| 호출 | 스펙 | 성격 | 프롬프트 상수 | JSON Schema · zod | temp / 출력 한도 — 상수(파일) | 로그 `call` |
|---|---|---|---|---|---|---|
| A 표지 판독 | §2 | 정확성 | `EXTRACT_SYSTEM_PROMPT`·`EXTRACT_USER_TEXT` (english/prompts.ts) | `BOOK_EXTRACTION_JSON_SCHEMA`·`bookExtractionSchema` (english/schemas.ts) | 0 / 2,000 — `EXTRACT_CALL_OPTIONS` (lib/ai/client.ts) | `extract` |
| A′ 본문·목차 판독 | §2A | 판독 + 장면 질문 | `PAGES_SYSTEM_PROMPT`·`buildPagesUserMessage` (prompts.ts) | `PAGE_DIGEST_JSON_SCHEMA`·`makePageDigestSchema` (schemas.ts) | 0.3 / 4,000 per 배치 — `PAGES_CALL_OPTIONS` (client.ts) | `pages` |
| B 카드 생성 | §3 | 창작 | `CARD_SYSTEM_PROMPT`·`buildCardUserMessage` (prompts.ts) | `LEARNING_CARD_JSON_SCHEMA`·`makeLearningCardSchema` (schemas.ts) | 0.7 / 6,000 — `CARD_CALL_OPTIONS` (client.ts) | `card` |
| C 단어장 판독 | §7 | 원문 전사 | `VOCAB_EXTRACT_SYSTEM_PROMPT`·`VOCAB_EXTRACT_USER_TEXT` (english/vocabbook-prompts.ts) | `VOCAB_EXTRACTION_JSON_SCHEMA`·`vocabExtractionSchema` (english/vocabbook-schemas.ts) | 0 / 16,000 per 사진 — `VOCAB_EXTRACT_CALL_OPTIONS` (vocabbook-prompts.ts) | `vocab-extract` |
| D 단어장 보강 | §8 | 창작(정의 불변) | `VOCAB_ENRICH_SYSTEM_PROMPT`·`VOCAB_ENRICH_USER_TEXT` (vocabbook-prompts.ts) | `VOCAB_ENRICHMENT_JSON_SCHEMA`·`vocabEnrichmentSchema` (vocabbook-schemas.ts) | 0.7 / 8,000 — `VOCAB_ENRICH_CALL_OPTIONS` (vocabbook-prompts.ts) | `vocab-enrich` |
| F 챕터화 | §9 | 자막 전사 + 번역 | `CHAPTERIZE_SYSTEM_PROMPT`·`buildChapterizeUserMessage` (prompts.ts) | `CHAPTERIZATION_JSON_SCHEMA`·`makeChapterizationSchema` + `groundChapters` (schemas.ts) | 0 / 16,000 — `CHAPTERIZE_CALL_OPTIONS` (client.ts) | `chapterize` |
| G 단어 뜻 | §10 | 문맥 뜻 | `WORD_MEANING_SYSTEM_PROMPT`·`buildWordMeaningUserMessage` (prompts.ts) | `WORD_MEANING_JSON_SCHEMA`·`wordMeaningSchema` (schemas.ts) | 0 / 600 — `WORD_MEANING_CALL_OPTIONS` (prompts.ts) | `word-meaning` |
| H 유의어·반의어 추천 | §11 | 후보 창작 | `RELATED_SUGGEST_SYSTEM_PROMPT`·`buildRelatedSuggestUserMessage` (vocabbook-prompts.ts) | `RELATED_SUGGESTION_JSON_SCHEMA`·`relatedSuggestionSchema` + `postprocessRelatedCandidates` (vocabbook-schemas.ts) | 0.3 / 800 — `RELATED_SUGGEST_CALL_OPTIONS` (vocabbook-prompts.ts) | `related-suggest` |

튜닝 대상은 B·D·G·H다. A·A′·C·F는 §4의 정확성 장치다.

호출 옵션이 세 파일에 흩어져 있다 — A·A′·B·F는 `lib/ai/client.ts`, C·D·H는 `vocabbook-prompts.ts`, G는 `prompts.ts`. 옵션을 바꾸면 스펙도 함께 고친다. 스펙 §1 표가 8개 호출 전부의 값과 옵션 상수를 싣는다(**해소 2026-09-25** — 전에는 A·A′·B·C만 실었다). 값을 고른 근거는 D §8-6, F §9-6, G §10-5, H §11-6에 있으니 옵션을 바꾸면 §1 표와 그 절을 함께 고친다.

**temperature 다이얼이 먹지 않을 수 있다.** `callWithSchema`는 모델이 temperature 파라미터를 400으로 거부하면 그 모델을 `modelsRejectingTemperature`에 기억해 두고, 파라미터를 뺀 채 다시 부른다. 추론형 모델을 쓰는 동안에는 temperature를 올려도 내려도 출력이 그대로다. 다양성이나 안정성을 temperature로 잡기 전에 지금 `OPENAI_MODEL`이 temperature를 받는 모델인지부터 확인하라. 받지 않는다면 그 조정은 프롬프트 문구로 해야 한다.

## 2. 호출 B(카드) 다이얼 — 튜닝의 본무대

"은우가 어려워해", "질문이 너무 많아" 같은 아이 반응 피드백은 대부분 여기로 온다. 표의 "없음"은 그 위치에 검사가 없다는 뜻이다. 자동 검증이 없는 다이얼은 값을 바꿔도 eval이 잡아 주지 않는다.

| 다이얼 | 현재 값 | 프롬프트 (§3-1) | zod (`makeLearningCardSchema`) | eval (`runChecks`) | 주의 |
|---|---|---|---|---|---|
| 단어 개수 | AR<2 → 10, 그 외(미상 포함) → 12 | `[vocab — 단어 선정]` 개수 줄 | `isLowAr ? 10 : 12` | 점검 1 (zod 경유) | 프롬프트는 AR 구간을 넷(<2 / 2~3.5 / >3.5 / 미상)으로 말하고, zod는 `arLevel !== null && < 2` 한 갈래로만 가른다. 12개 구간을 더 쪼개려면 zod도 같이 고친다 |
| challenge 비율 | 2~3개 (AR>3.5면 3개 포함) | `difficulty` 줄 | **없음** | **없음** | 산출물을 사람이 센다. zod로 강제하는 것은 구조 변경이라 ai-engineer 몫이다 |
| 사이트워드 차단 | `SIGHT_WORDS` 73개 (schemas.ts) | 서술만 | `SIGHT_WORD_SET` | 점검 2 — **같은 상수를 import** | 목록은 schemas.ts와 스펙 §5 본문 두 곳에 있다. spec-sync는 이 목록을 대조하지 않으므로 둘을 손으로 맞춘다 |
| 핵심 단어 | isCore true 정확히 1개 | `[vocab]` | `coreCount === 1` | 점검 1 | |
| 질문 개수 | AR<2 → 6, 그 외 → 8, 유형 중복 금지 | `[questions]` 첫 줄 | `isLowAr ? 6 : 8` + 유형 중복 | 점검 1 | |
| 필수 유형·순서 | 픽션 7종(AR<2는 인과를 뺀 6종)·논픽션 6종 필수, 마지막은 나와연결 | `[questions]` | **없음** | **없음** | AR<2 픽션은 질문이 6개라 필수 7종을 다 넣을 수 없던 모순을 2026-09-25 사용자 결정으로 해소했다 — **AR<2 픽션은 인과를 뺀 6종**. 필수 유형은 zod·eval에 없어 프롬프트 준수에만 기대므로, 개수·유형 다이얼을 바꾸면 필수 종 수 ≤ 질문 수인지 같이 확인하라. 픽스처(Pooh AR 2.0)가 AR<2 경로를 밟지 않는다 |
| 질문 길이 | en 15단어 이하 | `[대상과 말투]` | 없음 | 점검 3 | |
| 예문 길이 | exampleEn 4~8단어 | `[vocab]` | 없음 | 점검 3 — **상한 8만** 본다 | 하한 4는 자동 검증 밖이다 |
| hintKo 밀도 | 절반에만 (8개 → 4, 6개 → 3), 나머지 null | `[questions]` | 없음 | 점검 4 — 30~70% | 프롬프트는 이미 숫자로 못 박혀 있고, eval은 폭을 둔다. 폭을 좁히면 모델 편차만으로 흔들린다 |
| 줄거리 분량 | metadata 3~4 · blurb 4~6 · toc/pages ⌈N/2⌉+2 ~ N+2 (절대 3~10, 하한 최대 8) · transcript 8~10 | 시스템 프롬프트에 숫자가 없다. `formatStoryLengthBlock`이 `[줄거리 분량]`에 계산해 넣는다 | **의도적으로 없음** | 점검 7 + 오프라인 "분량 다이얼" 9항목 | 숫자는 schemas.ts 한 곳에만 있다: `STORY_OUTLINE_FLAT_RANGE`·`STORY_OUTLINE_MIN_SENTENCES`(3)·`STORY_OUTLINE_MAX_SENTENCES`(10)·`STORY_OUTLINE_MIN_CEILING`(8)·`storyOutlineSentenceRange()` |
| 자막 절단 | `TRANSCRIPT_MAX_CHARS` 16,000자, 앞부분 우선 + 절단 표시 | `formatTranscriptBlock` (prompts.ts) | — | 오프라인 "낭독 자막" 점검 | 카드는 요약이라 앞부분이 중요하고 결말은 어차피 쓰지 않는다 |
| 온도·출력 | 0.7 / 6,000 | — | — | — | `CARD_CALL_OPTIONS` |
| 정성 다이얼 | bookIntroKo 2문장 · levelNoteKo 1문장 · activities descKo 2~3문장 · whileReading 몸 미션 | §3-1 각 블록 | 없음 | 없음 | 사람이 읽는다 |

**분량은 근거의 양에 비례한다.** 근거 종류만 보는 평평한 구간으로 되돌리지 마라(스펙 §3-2). 4장면짜리 얇은 근거에 두꺼운 근거와 같은 분량을 요구하면, 모델은 지어내거나 규칙을 지키고 eval에서 떨어진다. 실제로 그 실패가 났고, 모델을 조이지 않고 다이얼을 고쳐서 해결했다.

**분량을 zod로 강제하지 마라**(스펙 §6). 문장 수는 품질 다이얼이다. zod로 막으면 조금 짧은 카드가 재요청 뒤 throw가 되고, 부모에게는 "카드 생성 실패"로 보인다. 회귀는 점검 7이 잡는다.

## 3. 호출 D·G·H 다이얼

### D — 영영 정의·해석·이모지 (§8)

- **프롬프트 다이얼** — 정의 문장의 난이도("저학년도 읽을 낱말"), 추상어에서 이모지를 null로 두는 기준. zod가 강제하는 것은 형식뿐이다: 정의 한 문장(종결부호 2개 이상이면 거부), 표제어 미포함(`\b…\b`, 대소문자 무시), 정의에 한글 금지, 해석에 한글 필수, 정의가 null이면 해석도 null, 이모지 자소 1개 + `Extended_Pictographic`.
- **온도·출력** — 0.7 / 8,000. 8,000은 해석 백필이 40단어에 몰릴 때를 위해 6,000에서 올린 값이다. 내리지 마라.
- **튜닝 효과는 새 단어에만 나타난다.** `mergeEnrichment`(vocabbook-enrich.ts)는 `definitionEn`이 null인 자리에만 값을 채운다. 프롬프트를 고쳐도 이미 저장된 정의는 그대로다. 은우가 외운 정의와 시험 문제가 어긋나지 않게 하려는 설계다. 그러니 "기존 정의를 다시 뽑아 비교"하는 식으로 튜닝하지 마라. 검증은 `EVAL_VOCAB=1` 프로브(5단어)로 한다.
- 해석(`definitionKo`)이 한 문장인지는 zod가 보지 않는다. 한국어 종결 표현이 불규칙해 오탐이 크기 때문이다(§8-4). 게이트 출력을 사람이 확인한다.

### G — 문맥 속 우리말 뜻 (§10)

- `WORD_MEANING_KO_MAX` 40자(schemas.ts), 한글 필수, 영어 낱말 2개 연속 거부(`longestEnglishRun >= 2`). 0 / 600.
- 다의어를 맥락에 맞게 골랐는지는 코드가 판단하지 못한다. `EVAL_WORDMEANING=1` 출력("bellowed")을 사람이 읽는다.
- 프롬프트 `[예시]`의 세 뜻(울부짖었다·떠났다·왼쪽)은 오프라인 zod 정상 케이스와 같은 값이다. 예시를 바꾸면 `runWordMeaningChecks`의 정상 케이스도 함께 본다.

### H — 유의어·반의어 후보 (§11)

- **후보 수 5~6은 두 곳에 박혀 있다** — 시스템 프롬프트(§11-1)와 사용자 메시지 템플릿 `buildRelatedSuggestUserMessage`(§11-2). 둘 다 고친다. 템플릿은 spec-sync 대상이 아니라 아무도 대신 대조해 주지 않는다.
- zod 상한 `RELATED_SUGGEST_MAX_CANDIDATES` 12는 폭주 방어선이지 다이얼이 아니다. 0개는 거부된다.
- 고빈도 우선·기본형만·굴절형 금지는 프롬프트 다이얼이다. 0.3 / 800 — 0으로 내리면 후보끼리 겹쳐 다양성이 죽는다(§11-6).
- **실호출 eval 게이트가 없다.** 관계 종류가 맞는지, 받은 뜻에 맞는지, 초등 눈높이인지는 오케스트레이터가 사용자 동의를 받아 별도 프로브로 본다(§11-7). 오프라인 12항목은 형식만 보므로, H 튜닝을 "eval 통과"로 보고하지 마라.

## 4. 건드리지 않는 정확성 장치

품질 다이얼이 아니다. 느슨하게 하면 품질이 오르는 게 아니라 틀린 내용이 조용히 저장된다. 손봐야 할 것 같으면 ai-engineer와 합의하고 사용자 논의로 올린다.

- **A 표지 판독** — 보이는 것만 옮기고 추측하지 않는다(§2-1). `isBookCover=false` 또는 `title=null`이면 `/api/extract`가 200 + `reason:"retake"`로 수동 입력 폼에 넘긴다. 카드가 약하다고 A에 "추정해서 채워라"를 넣으면, 틀린 메타가 Google Books 식별과 카드 전체를 오염시킨다.
- **A′ 본문·목차 판독** — 장면 요약과 confidence·gapBefore·결말 규칙은 판독 규칙이다. 유일하게 창작인 askKo도 실호출 eval이 없어(사진 필요) 회귀를 잴 수 없다. askKo 품질 피드백이 와도 튜닝 대상으로 받지 말고 사용자 논의로 올린다. 배치 크기 `PAGES_BATCH_SIZE`(6)·상한 `PAGES_MAX_IMAGES`(40)는 비용 구조다. 카드 1장은 `1(A) + ceil(N/6)(A′) + 1(B) [+ 1(F)]`회다. F는 낭독 영상을 골랐고 자막을 받아 왔을 때만 붙는다. 카드가 만들어지면 `components/home-create.tsx`가 `/api/chapterize`를 best-effort로 자동 호출하기 때문이다(단계 id `"chapterize"`, SPEC §14-1). F의 출력 한도는 16,000으로, 호출 하나의 한도로는 이 중 가장 크다. 자막을 받지 못했으면(`transcriptNotice`) 붙지 않는다. 길이 상한 `SCENE_LABEL_KO_MAX`(120)·`SCENE_SUMMARY_KO_MAX`(1,000)·`SCENE_ASK_KO_MAX`(500)·`MAX_SCENE_DIGEST_ITEMS`(120)는 A′ zod와 `/api/card` 입력 zod가 같은 상수를 import한다.
- **C 단어장 판독** — 책을 그대로 옮긴다(§7-1). temp 0, 창작 금지, ipa 대괄호 벗기기, `isVocabPage` 게이트, 같은 사진 번호 중복 금지, 뜻 번호 1~99. 프롬프트의 `[판독 예시]` JSON은 eval이 떼어 내 zod로 검사한다("few-shot. [판독 예시]…" 점검) — 예시를 고치면 스키마를 통과하고 examples가 채워져 있어야 한다. 출력 한도 16,000은 2026-08-22 예문 누락 사고의 대응이다. 줄이지 마라.
- **SPEC §1 원문 전사 금지** — 연속 영어 8단어 이상이면 거부한다(`ENGLISH_RUN_LIMIT` 8, `longestEnglishRun`, schemas.ts). A′ summaryKo와 B storyOutlineKo에 걸린다. 한도를 올리면 책 본문이 카드로 샌다. 예외는 F 하나뿐이다(§9 — 챕터 리더에 한해 원문 표시를 허용했고, 카드의 다른 부분은 그대로다).
- **F grounding** — `groundChapters` → `tokenizeForGrounding` + `isGroundedInTranscript`. en의 토큰 열이 자막 토큰 열 안에 연속 구간으로 있어야 남는다. 목차 밖 titleEn 금지(`normalizeTitleForMatch`), matched ⟺ sentences, temp 0. **`droppedSentenceCount`가 크다고 grounding을 느슨하게 하지 마라.** 그 숫자는 프롬프트 이탈 신호다. 느슨하게 하면 자막에 없는 영어 문장이 "원문"으로 챕터 리더에 저장된다. 고칠 곳은 F 프롬프트다.
- **F 입력·출력 균형** — `CHAPTERIZE_TRANSCRIPT_MAX_CHARS` 12,000 ↔ 출력 16,000. EN과 KO를 함께 되뽑아 출력이 입력의 약 2배다. 입력만 올리면 출력 한도에 걸린다.
- **storySource 랭크** — `STORY_SOURCE_RANK` + `<=` 비교(zod와 eval 점검 6이 같은 상수를 쓴다). 등호로 조이면 프롬프트가 허용한 "낮춰 적기"를 거부하게 된다. `resolveAllowedStorySource`는 sceneKind가 없으면 pages로 본다. 이 기본값은 `formatSceneDigestBlock`("본문 촬영")과 `/api/card`의 `sceneKind ?? "pages"`와 같아야 한다. eval 픽스처는 전부 sceneKind를 명시하므로 이 기본값 경로는 어느 점검도 밟지 않는다. 셋 중 하나를 고쳤다면 QA 반례(study-qa english.md §5)로 확인한다.
- **D 정의 불변** — `entriesToEnrich`·`buildEnrichRequestItems`·`mergeEnrichment`·`isVocabBookEnriched` (vocabbook-enrich.ts).
- **G·H 형식 방어** — G의 한글 필수·영어 연속 금지는 원어를 그대로 돌려주는 echo를 막는다. H의 낱말 정규식 `/^[A-Za-z][A-Za-z-]*$/`와 `postprocessRelatedCandidates`(표제어·중복·빈값을 거부하지 않고 거른다)도 마찬가지다.
- **낭독 영상은 사람이 고른다** — 프롬프트가 아니라 흐름에 있는 장치다. 후보 3개를 보여 주고 부모가 탭한다(SPEC §14-1, `components/home-create.tsx`의 `fireReadaloudSearch`). 첫 결과를 자동으로 채택하면 엉뚱한 책의 자막이 B와 F 전체를 조용히 오염시킨다.

## 5. 동기화 지점 — 4중 정의와 spec-sync

### 5-1. 무엇을 바꾸면 어디를 같이 바꾸나

| 바꾸는 것 | 함께 바꿀 곳 |
|---|---|
| 프롬프트 문구 | 스펙 해당 코드블록 **먼저**, 그다음 코드 상수에 글자 그대로. 순서를 뒤집으면 spec-sync가 FAIL을 낸다 |
| 개수·비율 숫자 | 스펙 프롬프트 블록 + 스펙 zod 목록(B는 §4, 나머지는 §x-4) + 프롬프트 상수 + zod + 해당 eval 점검 |
| 길이·개수 상한 상수 | schemas 단일 정의처 한 곳 + 스펙 zod 절. 소비자(라우트·화면)는 import만 한다 |
| 호출 옵션 | 옵션 상수(§1 표의 파일) + 스펙 해당 절 |
| 사이트워드 | `SIGHT_WORDS` + 스펙 §5 목록 |
| H 후보 수 | 시스템 프롬프트 + `buildRelatedSuggestUserMessage` + 스펙 §11-1·§11-2 |

### 5-2. spec-sync가 보는 것과 안 보는 것

- 대조 엔진은 `scripts/spec-sync.ts`의 `checkSpecSync`다. 스펙의 코드블록을 전부 후보로 두고 **내용으로** 같은 블록을 찾는다. 절 번호는 판정에 쓰지 않는다. 정규화는 NFC·CRLF·줄끝 공백·앞뒤 빈 줄 네 가지뿐이라, 줄 안쪽 공백과 빈 줄 개수까지 같아야 한다.
- 대상 목록 `SPEC_SYNC_TARGETS`는 spec-sync.ts가 아니라 **`scripts/eval-english.ts`**에 있다. 현재 11개다. block 8개(`EXTRACT_SYSTEM_PROMPT`·`PAGES_SYSTEM_PROMPT`·`CARD_SYSTEM_PROMPT`·`VOCAB_EXTRACT_SYSTEM_PROMPT`·`VOCAB_ENRICH_SYSTEM_PROMPT`·`CHAPTERIZE_SYSTEM_PROMPT`·`WORD_MEANING_SYSTEM_PROMPT`·`RELATED_SUGGEST_SYSTEM_PROMPT`)는 스펙 코드블록과 같아야 하고, inline 3개(`EXTRACT_USER_TEXT`·`VOCAB_EXTRACT_USER_TEXT`·`VOCAB_ENRICH_USER_TEXT`)는 스펙 본문 어딘가에 그대로 있어야 한다.
- **대조 밖에 있는 것** — 사용자 메시지 빌더 5개(`buildPagesUserMessage`·`buildCardUserMessage`·`buildChapterizeUserMessage`·`buildWordMeaningUserMessage`·`buildRelatedSuggestUserMessage`). 플레이스홀더가 든 서술이라 원문 대조가 성립하지 않는다. 오프라인 eval이 부분 점검하는 것은 세 가지뿐이다. (1) 카드 분량 값: `runStoryLengthDialChecks`의 "동기화." 3항목. (2) 자막 슬롯과 절단: `runTranscriptOfflineChecks`의 "transcript. 자막 슬롯 렌더…"·"transcript. 상한 초과 시…" 2항목. `buildCardUserMessage`를 거쳐 `formatTranscriptBlock`을 본다. (3) 목차가 없을 때의 한 줄: `runChapterizeChecks`의 "사용자 메시지: 목차 없으면 "1. 전체" 한 줄"이 `buildChapterizeUserMessage`를 본다. 그 밖의 문구, 그리고 A′·G·H 빌더(`buildPagesUserMessage`·`buildWordMeaningUserMessage`·`buildRelatedSuggestUserMessage`)의 템플릿은 아무도 대조하지 않는다. JSON Schema 원문도 대조 밖이다 — G·H만 구조 점검(strict·additionalProperties·required)이 있고, 나머지 6개는 스펙 §x-3과 손으로 비교한다. `SIGHT_WORDS` 목록도 마찬가지다.
- 새 프롬프트 상수를 만들면 `SPEC_SYNC_TARGETS`에 등록하라. 등록하지 않은 상수는 대조에서 조용히 빠진다.

## 6. eval 실행 — 게이트별로 무엇이 켜지고 몇 번 부르나

| 설정 | 켜지는 것 | 실호출 (`callWithSchema` 수) | 끝나는 방식 |
|---|---|---|---|
| `EVAL_OFFLINE_ONLY=1` | 오프라인 점검 전부. 2026-09-25 기준 176항목: 호출 A′ 스키마 15 · 분량 다이얼 9 · 낭독 자막 8 · 챕터화 30 · 목차 제목 준비(§9-2) 23 · 단어뜻 11 · 유의어추천 12 · 단어장 §7 57(병합·zod·보강·시험 보기·관계 문제·오답 집계·복습) · 프롬프트↔스펙 11 | 0 — `globalThis.fetch`까지 막는다 | 표 + spec-sync 상세 출력 후 return |
| (게이트 없음) | 오프라인 전부 + 카드 3건(Wolves · Pooh · Pooh 장면 14)의 점검 1~9 | 3 | 전체 표. 하나라도 FAIL이면 exit 1 |
| `EVAL_SKIP_PAGES=1` | 장면 변형을 뺀 카드 2건 | 2 | 위와 같다 |
| `EVAL_THIN_PAGES=1` | 3번째 카드를 4장면(`POOH_SCENE_DIGEST_THIN`)으로 | 3 (그대로) | 위와 같다. `EVAL_SKIP_PAGES=1`과 함께 켜면 효과가 없다 |
| `EVAL_TRANSCRIPT=1` | 자막 카드 1건(`TRANSCRIPT_FIXTURE`): 점검 1~9 + transcript 주장 + 채널 노이즈 누출 | 1 | 게이트 표만 찍고 return. **기본 카드 3건은 돌지 않는다** |
| `EVAL_CHAPTERS=1` | 챕터화 1건: 전 en grounding · 노이즈 누출 · matched 챕터 en/ko 1:1 · 목차 밖 제목 | 1 | 위와 같다 |
| `EVAL_VOCAB=1` | 호출 D 1건: 5단어. gather는 EN을 미리 채워 해석 백필 경로(EN 불변)를 본다 | 1 | 위와 같다 |
| `EVAL_WORDMEANING=1` | 호출 G 1건: "bellowed" / "He bellowed in fear." | 1 | 위와 같다 |

- **게이트는 서로 배타적이다.** `main`이 TRANSCRIPT → CHAPTERS → VOCAB → WORDMEANING 순서로 확인해 처음 켜진 것 하나만 돌리고 return한다. 둘을 함께 켜도 앞의 것만 돈다.
- **게이트 실행은 오프라인 결과를 판정에 넣지 않는다.** 오프라인 점검을 계산은 하지만 표에도 exit code에도 반영하지 않는다. 게이트를 돌리기 전에 `EVAL_OFFLINE_ONLY=1`을 따로 돌려라.
- **"실호출 1회"는 `callWithSchema` 1회다.** zod 검증에 실패하면 재요청으로 API 요청이 2번 나간다. 모델이 temperature를 거부하면 그 프로세스의 첫 요청이 한 번 더 나간다. `callWithSchema` 기준으로 기본 실행(3건, `main`이 순차 await)은 최악 7요청이다(3×2 + 1). 이와 별개로 OpenAI SDK의 자동 재시도가 살아 있다. `getOpenAIClient`가 `new OpenAI({ apiKey })`만 넘기므로 기본 `maxRetries` 2가 적용되고, 408·409·429·5xx·타임아웃·연결 오류가 나면 SDK가 같은 요청을 더 보낸다. 그래서 네트워크나 서버 오류가 나면 7을 넘을 수 있다. 비용 승인은 `callWithSchema` 최악값으로 받되, 이 여지를 함께 알린다.
- **스펙 §5가 코드와 같다(해소 2026-09-25).** 전에는 스펙이 `EVAL_TRANSCRIPT=1`을 "자막 카드 1회 추가"라고 썼다. 지금 §5는 게이트가 서로 배타적이고 기본 카드 3회를 대체하며, 게이트 실행은 오프라인 결과를 판정에 넣지 않는다고 적는다. 비용은 여전히 코드(`main`) 기준으로 계산하고, 게이트를 더하거나 순서를 바꾸면 §5도 함께 고치도록 리포트에 남긴다.
- A·A′·C는 실호출 게이트가 없다(사진이 있어야 재현된다). H도 없다(§3).
- **eval은 `.env`·`.env.local`을 `process.loadEnvFile`로 자동 로드한다.** 이미 설정된 변수가 우선하므로, 접두어 `OPENAI_API_KEY=`가 파일의 실제 키를 가린다. 접두어 없이 돌리면 .env의 키로 실호출이 난다.

```bash
# 무비용 — 튜닝 중 몇 번이든
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npx tsx scripts/eval-english.ts
# 실호출 — 사용자 비용 승인 뒤 오케스트레이터가 필요한 것 하나만
STORE_BACKEND=file npm run eval:english                      # 카드 3건
STORE_BACKEND=file EVAL_SKIP_PAGES=1 npm run eval:english    # 카드 2건
STORE_BACKEND=file EVAL_CHAPTERS=1 npm run eval:english      # 챕터화 1건
```

## 7. 픽스처

### 7-1. 카드 픽스처 (docs/SPEC.md §12 원본 값 — 임의 변경 금지)

| 필드 | Wolves | Pooh Gets Stuck |
|------|--------|-----------------|
| title | Wolves | Pooh Gets Stuck |
| author | Laura Marsh | Isabel Gaines |
| series | National Geographic Kids Readers, Level 2 | A Winnie the Pooh First Reader |
| isFiction | false | true |
| arLevel | 3.3 | 2.0 |
| lexile | 570 | 430 |
| wordCount | 864 | 551 |
| arQuizNo | "148832" | "41866" |
| topic | 늑대 — 무리(pack) 생활, 하울링, 사냥, 새끼 키우기 | 푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동 |

분기 커버리지: 두 권 모두 AR≥2라 단어 12·질문 8 경로다. 픽션/논픽션 분기(funFacts null vs 4개)는 두 권이 나눠 맡는다. **AR<2 경로(단어 10·질문 6)는 픽스처가 커버하지 않는다.** 이 경로의 필수 유형 규칙(AR<2 픽션은 인과를 뺀 6종, 2026-09-25)도 픽스처로는 검증되지 않는다. AR<2 다이얼을 바꿀 때는 AR 1점대 임시 메타로 수동 스팟 체크를 1회 하고(실호출 1회, 비용 승인 필요) 결과를 리포트에 남긴다.

### 7-2. eval 안의 데모 입력 (scripts/eval-english.ts 고정값)

스펙 §12 밖의 손으로 쓴 입력이다. 결과를 맞추려고 고치지 마라 — 고치는 순간 점검이 공허해진다.

- `POOH_SCENE_DIGEST` 14장면 — 기본 시나리오가 그림책 펼침면 12~16장이라서다(SPEC §3 (2′)). docs/harness/english.md §5와 eval의 `POOH_SCENE_DIGEST` 위 주석은 이것을 "SPEC §2 (2′)"로 잘못 적고 있다(§2는 기술 스택이다). 튜닝 리포트에 남겨 스펙 갱신을 요청한다. confidence medium 1개와 gapBefore 1개가 섞여 있고, 마지막 장면은 결말 직전에서 끊긴다.
- `POOH_SCENE_DIGEST_THIN` 4장면 — 얇은 근거 회귀용.
- `POOH_TRANSCRIPT` — Pooh 줄거리를 짧은 영어로 풀어 쓴 본문 + 앞뒤 채널 인트로/아웃트로. `TRANSCRIPT_NOISE_TOKENS` 4개(Storytime Land · Ms. Robin · subscribe · Bye bye)가 자막에 실제로 들어 있는지를 오프라인 점검이 잠근다. 토큰을 지우면 노이즈 누출 검사가 아무것도 검사하지 않게 된다.
- `CHAPTERIZE_FIXTURE_TITLES` 5개 — 마지막 "A New Adventure"는 자막에 내용이 없어 matched:false 경로를 탄다. `GROUNDED_EN` 4문장은 자막에서 글자 그대로 가져온 것이다.
- D 프로브 5단어(apple · brave · respect · moment · gather). gather는 `BACKFILL_EN`을 미리 채워 보낸다.
- G 프로브 "bellowed".

## 8. 결과 해석 가이드

| 실패 항목 | 먼저 볼 것 | 통상 원인 · 조치 |
|-----------|-----------|-----------------|
| 1. zod 추가 검증 | detail의 zod 경로·메시지 | 동기화 누락부터 의심한다. 값이 맞는데 실패하면 모델이 규칙을 놓친 것이다 → 그 규칙을 해당 블록 첫 줄로 올린다 |
| 2. 사이트워드 | 걸린 단어 | 제외 규칙에 그 계열 예시를 추가한다. 목록 자체를 줄이는 것은 스펙 §5 변경이다 |
| 3. 15단어 / 8단어 초과 | 초과 문장 | 길이 규칙을 예시와 함께 강조한다 |
| 4. hintKo 비율 | 실제 비율 | 숫자는 이미 프롬프트에 있다. 여전히 벗어나면 `[questions]` 안에서 문장 위치·강조를 조정한다 |
| 5. ko에 영어 잔존 | 해당 질문 쌍 | ko는 번역이 아니라 우리말로 다시 말하는 것임을 프롬프트에 분명히 한다 |
| 6. storySource 초과 | 넘긴 근거 vs 주장 | 근거보다 높게 주장했다. 프롬프트의 storySource 규칙을 본다. sceneKind 기본값이 세 곳에서 어긋났을 수도 있다 |
| 7. 분량 | eval이 찍은 줄거리 원문 · storySource | 먼저 원문을 읽는다. 근거보다 많은 문장을 요구하는 다이얼이면 모델이 옳다(4장면 사례). `countKoreanSentences`는 종결부호로 문장을 센다 |
| 8. 원문 전사 | 연속 영어 단어 수 · 한글 유무 | 절대 규칙 1을 강화한다. 자막 근거일 때 특히 잘 샌다. 한도를 올리지 마라 |
| 9. 배지 | `resolveStorySource` 결과 | 코드 결함이다 → ai-engineer |
| 프롬프트 ↔ 스펙 | 출력된 첫 불일치 줄(양쪽) | 한쪽만 고쳤다. 스펙 기준으로 맞춘다 |
| 분량 "동기화." | `[줄거리 분량]` 블록 | `formatStoryLengthBlock`과 `storyOutlineSentenceRange`가 어긋났다 → ai-engineer |
| 자막 게이트: transcript 미주장 | storySource | 자막을 받고도 낮춰 적었다. zod는 허용하지만 게이트는 실패로 본다. 프롬프트의 자막 블록을 강조한다 |
| 자막·챕터 게이트: 노이즈 누출 | 새어 든 문구 | `[제외할 것]`류 블록을 강화한다. 픽스처에서 노이즈를 지우는 것은 답이 아니다 |
| 챕터 게이트: 자막 밖 en | 남은 문장 | `groundChapters`를 지난 뒤라 0이어야 한다. 0이 아니면 grounding 코드 결함(P1) → ai-engineer |
| D 게이트: gather EN 변경 | 보낸 EN vs 받은 EN | 모델이 EN을 새로 지었다. 병합이 막아 주지만 프롬프트 `[금지]`를 강화한다 |
| G 게이트 | meaningKo | 길면 뜻이 아니라 설명으로 흐른 것이다. 영어가 이어지면 echo다 |
| "…(재요청 포함 2회 실패)" | detail의 zod 메시지 | 재요청에서도 같은 위반이 났다. 다이얼이 비현실적이거나 동기화가 빠졌다 |

같은 항목이 2회 연속 실패하면 프롬프트를 더 조이지 마라. 실패 사례를 리포트에 담아, 다이얼 자체(개수·비율·분량)가 현실적인지 사용자와 논의한다. 프롬프트가 길어질수록 다른 규칙의 준수율이 떨어진다.

## 9. 하지 말 것

- 스키마 구조 변경(필드 추가·삭제·타입 변경)은 튜닝이 아니다 → ai-engineer. 자동 검증이 없는 다이얼(challenge 비율·필수 유형·exampleEn 하한)을 zod로 강제하는 것도 구조 변경이다.
- §4의 정확성 장치를 품질을 이유로 완화하지 마라.
- 프롬프트만 고치고 스펙 코드블록을 그대로 두지 마라(그 반대도 마찬가지다).
- 픽스처와 데모 입력을 결과에 맞춰 고치지 마라.
- eval을 CI에 넣지 마라. 실호출 비용이 든다. 스펙이 수동 실행용으로 정해 두었다(docs/harness/english.md §5 — "CI가 아니라 수동 실행용").

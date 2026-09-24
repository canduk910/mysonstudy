# 영어 정합성 매트릭스·체크리스트 (subject=english)

> `study-qa` 스킬에서 영어(북카드·단어장·챕터 리더)를 검증할 때 읽는다. 수학은 `math.md`, 일본어는 `japanese.md`, 과목 공통 기능은 `common.md`.
> 원문 스펙: `docs/harness/english.md`(호출 A·A′·B·C·D·F·G·H — E는 없다) + `docs/SPEC.md` §1·§12·§14·§15.

## 목차

1. 영어의 무게중심
2. 정합성 매트릭스 — 호출별 4중 정의
3. 스펙 준수 체크리스트
4. 경계면 체크리스트 — 라우트 ↔ 화면
5. 정확성 장치 반례 확인법
6. 리포트 형식
7. 실행 시점

## 1. 영어의 무게중심

영어의 위험은 두 갈래다. 하나는 **구조 정합성**이다. 같은 제약이 프롬프트·JSON Schema·zod·eval 네 곳에 흩어져 있어서, 한 곳만 고치면 "eval은 통과하는데 런타임 검증이 실패"하거나 그 반대가 된다. 다른 하나는 **근거 밖으로 새는 것**이다. 원문 전사 금지(연속 영어 8단어), 자막 밖 창작 금지(`groundChapters`), 정의 불변(`mergeEnrichment`)이 이것을 막는다. 둘 다 "규칙이 있다"가 아니라 "틀린 입력을 실제로 거부한다"로 확인한다.

파일 지도:

| 층 | 카드·챕터 리더 (A·A′·B·F·G) | 단어장 (C·D·H) |
|---|---|---|
| 프롬프트 | `lib/ai/english/prompts.ts` | `lib/ai/english/vocabbook-prompts.ts` |
| JSON Schema + zod | `lib/ai/english/schemas.ts` | `lib/ai/english/vocabbook-schemas.ts` |
| 순수 후처리 | `groundChapters`·`attachSceneDigest` (schemas.ts) | `mergeVocabPages`(vocabbook-merge.ts) · `mergeEnrichment`(vocabbook-enrich.ts) · `postprocessRelatedCandidates`(vocabbook-schemas.ts) |
| 호출 배선 | `lib/ai/client.ts` — `extractBook`·`digestPages`·`generateCard`·`chapterizeTranscript`·`lookupWordMeaning`·`enrichVocab`·`suggestRelatedWords` | C만 예외 — `app/api/english/vocab/extract/route.ts`가 `callWithSchema`를 직접 부른다 |
| eval | `scripts/eval-english.ts` (오프라인 점검 + `SPEC_SYNC_TARGETS`) | 같은 파일 |

## 2. 정합성 매트릭스 — 호출별 4중 정의

"✔"는 정의가 있어야 하고 값이 일치해야 한다는 뜻이다. "—"는 정의가 **없어야 정상**이라는 뜻이다. 특히 JSON Schema에 `minItems`/`maxItems`/`minLength`/`maxLength`가 있으면 그 자체로 스펙 위반이다(§1 공통 규칙). "⚠"는 스펙이 요구하는데 자동 검사가 없는 칸이다. 결함으로 올리지 말고 "미강제"로 표기하되, 그 칸이 바뀐 변경을 검증할 때는 산출물을 직접 확인한다.

### A — 표지 판독 `book_extraction` (§2)

| 제약 | 프롬프트 §2-1 | JSON Schema §2-3 | zod `bookExtractionSchema` | eval |
|---|---|---|---|---|
| 12필드 전부 required, isBookCover 외 nullable | — | ✔ | ✔ 1:1, refine 없음 | — |
| lexile·wordCount 정수 | ✔ | integer | `.int()` | — |
| 판독 실패 = isBookCover false 또는 title null | ✔ | boolean | —(정상 흐름이라 거부하지 않는다) | — |
| 이미지 1~3장 | §2-2 | — | 라우트 zod `COVER_MAX_IMAGES` 3 (lib/upload-limits.ts) | — |
| 프롬프트 원문 | ✔ | | | spec-sync: `EXTRACT_SYSTEM_PROMPT`(block) · `EXTRACT_USER_TEXT`(inline) |

### A′ — 본문·목차 판독 `page_digest` (§2A)

| 제약 | 프롬프트 §2A-1 | JSON Schema §2A-3 | zod `makePageDigestSchema` | eval (오프라인 "호출 A′ 스키마") |
|---|---|---|---|---|
| sourceKind = 요청 모드 | ✔ | enum toc/pages | ✔ | "sourceKind 불일치" |
| pages: 장면 수 = 배치 사진 장수 | ✔ | — | ✔ `imageCount` | "사진 2장인데 장면 1개" |
| 장면 1개 이상 | — | — | ✔ | — |
| seq 중복 금지·오름차순 | — | integer | ✔ | "seq 역순" |
| askKo 필수(confidence low만 null) | ✔ | string\|null | ✔ | 필수·허용 2건 |
| summaryKo 한글 포함 | ✔ | — | ✔ | "한글 없음" |
| summaryKo 연속 영어 8단어 미만 | ✔ | — | ✔ `ENGLISH_RUN_LIMIT` | "한글+영어 8단어 혼합" |
| 길이 labelKo 120 · summaryKo 1,000 · askKo 500 | — | — | ✔ `SCENE_*` | 3건 |
| 배치당 장면 ≤ 120 | — | — | ✔ `MAX_SCENE_DIGEST_ITEMS` | 121 거부 · 120 허용 |
| 병합 합계 > 120이면 뒤쪽 절단 | — | — | `digestPages`의 `truncatedSceneCount` (client.ts) | — |
| 배치 6장 · 최대 40장 | — | — | `PAGES_BATCH_SIZE` · `PAGES_MAX_IMAGES` (client.ts) | — |
| 실패 배치 다음 장면 gapBefore 강제 | — | — | `digestPages`의 `pendingGap` | — |

### B — 카드 `learning_card` (§3)

| 제약 | 프롬프트 §3-1 | JSON Schema §3-3 | zod `makeLearningCardSchema` | eval |
|---|---|---|---|---|
| vocab 개수 AR<2 → 10, 그 외 → 12 | ✔ (4구간으로 서술) | — | ✔ `isLowAr` | 점검 1 |
| vocab word 소문자 중복 금지 | (서술 없음) | — | ✔ | 점검 1 |
| 사이트워드 차단 | 서술만 | — | ✔ `SIGHT_WORD_SET` | 점검 2 — **같은 상수** |
| challenge 2~3개 | ✔ | enum만 | ⚠ 없음 | ⚠ 없음 |
| isCore true 정확히 1개 | ✔ | boolean\|null | ✔ | 점검 1 |
| questions AR<2 → 6, 그 외 → 8 | ✔ | — | ✔ | 점검 1 |
| 유형 enum 12종 · 중복 금지 | ✔ | ✔ enum | ✔ `QUESTION_TYPES` | 점검 1 |
| 필수 유형(픽션 7·논픽션 6) · 마지막 나와연결 | ✔ | — | ⚠ 없음 | ⚠ 없음 |
| funFacts 픽션 null / 논픽션 4 | ✔ | array\|null | ✔ | 점검 1 |
| beforeReading 2 · whileReading 3 · activities 2 | ✔ | — | ✔ | 점검 1 |
| 질문 en ≤ 15단어 | ✔ | — | — | 점검 3 |
| exampleEn 4~8단어 | ✔ | — | — | 점검 3 (≤8만 · 하한 ⚠) |
| hintKo 절반(8 → 4, 6 → 3) | ✔ | string\|null | — | 점검 4 (30~70%) |
| ko 우리말 · en 잔존 없음 | ✔ | — | — | 점검 5 |
| storySource enum 5종 | ✔ | ✔ enum | ✔ `STORY_SOURCES` | — |
| storySource ≤ 넘긴 근거 (랭크 `<=`) | ✔ | — | ✔ `STORY_SOURCE_RANK` | 점검 6 (같은 상수) + 오프라인 "낭독 자막" 거부·허용 |
| storyOutlineKo 비어 있지 않음 | — | — | ✔ `min(1)` | — |
| storyOutlineKo 연속 영어 8단어 미만 | ✔ 절대 규칙 1 | — | ✔ | 점검 8 |
| storyOutlineKo 한글 포함 | (함의) | — | ⚠ 없음 | 점검 8 (`/[가-힣]/`) |
| 분량 구간 | 주입 (`formatStoryLengthBlock`) | — | —(의도, 스펙 §6) | 점검 7 + 오프라인 "분량 다이얼" |
| 자막 16,000자 앞부분 절단 | 주입 (`formatTranscriptBlock`) | — | — | 오프라인 "낭독 자막" |
| sceneDigest는 출력에 없다 | — | —(정상) | — | 라우트가 `attachSceneDigest`로 붙인다 |

**사이트워드 특칙.** zod와 eval이 각자 목록 리터럴을 갖고 있으면, 값이 지금 같더라도 실패로 판정한다. 두 목록은 반드시 언젠가 어긋난다. 정상 상태는 `SIGHT_WORDS`(73개)가 schemas.ts 한 곳에서 export되고 eval이 `SIGHT_WORD_SET`을 import하는 것이다. 스펙 §5의 목록과는 손으로 대조한다(spec-sync 대상이 아니다).

**AR<2 픽션 필수 유형(2026-09-25 해소).** 질문이 6개라 필수 7종을 다 넣을 수 없던 모순을, 사용자 결정으로 **AR<2 픽션은 인과를 빼고 6종**(인물·사건·감정·예측·결말·나와연결)으로 풀었다(§3-1 `[questions]`, `CARD_SYSTEM_PROMPT` 바이트 일치). 필수 유형은 여전히 프롬프트에만 있고 zod·eval에는 없다 — 픽스처가 이 경로를 커버하지 않으므로, AR<2나 질문 유형이 바뀐 변경을 검증할 때는 AR 1점대 픽션 임시 메타데이터로 1회 스팟 체크를 확인 항목에 넣는다.

### C — 단어장 판독 `vocab_extraction` (§7)

| 제약 | 프롬프트 §7-1 | JSON Schema §7-3 | zod `vocabExtractionSchema` | eval (오프라인 "단어장 §7") |
|---|---|---|---|---|
| isVocabPage false → entries [] | ✔ | boolean | ✔ | zod 거부 |
| 사진당 항목 ≤ 40 | — | — | ✔ `VOCAB_ENTRIES_PER_PAGE_MAX` | ⚠ 반례 없음 |
| 같은 사진 번호 중복 금지 | — | — | ✔ | zod 거부 |
| ipa 대괄호 금지 | ✔ | — | ✔ | zod 거부 |
| pos 10종 enum | ✔ | ✔ enum | ✔ `PARTS_OF_SPEECH` | — |
| meanings[].no 1~99 또는 null | ✔ | integer\|null | ✔ `VOCAB_MEANING_NO_MAX` | 200 거부 |
| meanings[].ko 필수 | ✔ | string | ✔ `min(1)` | 빈 문자열 거부 |
| examples.en 필수 · ko 빈 문자열 허용 | ✔ | | ✔ | — |
| related kind 3종 | ✔ | enum | ✔ `RELATED_KINDS` | — |
| related의 source·linkedNo·linkedMeaningIndex | — | —(정상: 모델 출력 아님) | zod `default`("book"·null·null) | — |
| 길이 word 60 · ipa 120 · no 12 · 뜻 200 · 예문 en/ko 300 · 관련어 word 60 / gloss 200 · dayLabel 60 | — | — | ✔ `VOCAB_*_MAX` | — |
| 배열 pos 6 · meanings 12 · examples 12 · related 20 | — | — | ✔ (pos·examples 상한은 코드에만 있고 스펙 §7-4에 없다) | — |
| few-shot 예시가 스키마 통과 + examples 채움 | ✔ `[판독 예시]` | | ✔ | "few-shot. [판독 예시]" |
| 병합: 조인 키·합집합·대표본·정렬·번호 구멍 | — | — | `mergeVocabPages` · `findMissingNumbers` (`VOCAB_MISSING_SCAN_MAX` 200) | 병합 6건 + findMissingNumbers |

### D — 단어장 보강 `vocab_enrichment` (§8)

| 제약 | 프롬프트 §8-1 | JSON Schema §8-3 | zod `vocabEnrichmentSchema` | eval |
|---|---|---|---|---|
| definitionEn 한 문장 | ✔ | — | ✔ 종결부호 2개 이상 거부 | 오프라인 "정의 두 문장" · `EVAL_VOCAB` |
| 표제어 미포함 | ✔ | — | ✔ `\b…\b`, iu | 오프라인 |
| 정의에 한글 금지 | ✔ | — | ✔ | 오프라인 |
| definitionKo 한글 필수 | ✔ | — | ✔ | 오프라인 |
| EN null → KO null (고아 해석 금지) | ✔ | — | ✔ | 오프라인 |
| KO 한 문장 | ✔ | — | —(의도, 오탐) | `EVAL_VOCAB`에서만 |
| 이모지 자소 1개 · 그림문자 | ✔ | — | ✔ `Intl.Segmenter` · `Extended_Pictographic` | 오프라인 2건 |
| 길이 EN 300 · KO 300 · emoji 32 · word 60 · no 12 | — | — | ✔ | — |
| EN 불변 (null 자리만 채움) | ✔ `[금지]` | — | `mergeEnrichment` | 오프라인 3건 · `EVAL_VOCAB` gather |
| 대상 = EN null 또는 KO null | — | — | `entriesToEnrich` | 오프라인 |
| enriched = 모든 entry EN non-null (빈 배열 false) | — | — | `isVocabBookEnriched` | 오프라인 |
| few-shot `[예시]` 스키마 통과 | ✔ | | ✔ | 오프라인 "few-shot" |

### F — 챕터화 `chapterization` (§9)

| 제약 | 프롬프트 §9-1 | JSON Schema §9-3 | zod `makeChapterizationSchema` / 후처리 | eval |
|---|---|---|---|---|
| 챕터 1~40 | — | — | ✔ `CHAPTERIZE_MAX_CHAPTERS` · 입력 쪽은 `prepareChapterTitles`가 40개 이하로 묶는다(§9-2) | 41 거부 · 준비 전 120개 echo 거부 / 준비 후 40개 echo 통과 · 40·41·120 묶기 경계 · 같은 제목 40·80개의 " (n)" · 리더 정리 불변식 |
| 챕터당 문장 ≤ 120 · 전체 ≤ 600 | — | — | ✔ | 챕터당 초과 거부 · 전체 초과 ⚠ 반례 없음 |
| matched ⟺ sentences 채움 | ✔ | — | ✔ | 2건 |
| en 한글 없음 · ko 한글 있음 | ✔ | — | ✔ | 2건 |
| titleEn ∈ 받은 목차(NFC·트림·공백·소문자 정규화) · 중복 금지 | ✔ | — | ✔ `normalizeTitleForMatch` | 오프라인 + `EVAL_CHAPTERS` |
| 길이 titleEn 200 · en 600 · ko 800 | — | — | ✔ | en·ko 초과 거부 |
| **en ⊂ 자막 (grounding)** | ✔ | — | zod가 아니라 `groundChapters` | 오프라인 7건(groundChapters 3 · grounding 2 · 목차 없음 grounding 1 · 긴 자막 분할 전부 grounded 1 — 뒤의 둘은 아래 행과 겹친다) + `EVAL_CHAPTERS` |
| 목차 없음 → "전체" 단일 챕터 | ✔ | — | `resolveChapterTitles` · `WHOLE_TRANSCRIPT_TITLE` | 오프라인 7건 (+ 긴 자막 문장 분할 회귀 가드) |
| 자막 12,000자 앞부분 절단 | — | — | `truncateTranscriptForChapterize` | 오프라인 |

### G — 단어 뜻 `word_meaning` (§10)

| 제약 | 프롬프트 §10-1 | JSON Schema §10-3 | zod `wordMeaningSchema` | eval (오프라인 "단어뜻(§10)") |
|---|---|---|---|---|
| meaningKo trim 1~40자 | ✔ | string | ✔ `WORD_MEANING_KO_MAX` | 빈 · 공백 · 초과 |
| 한글 필수 | ✔ | — | ✔ | "bellowed" echo |
| 영어 낱말 2개 연속 금지 (1개는 허용) | ✔ | — | ✔ `longestEnglishRun >= 2` | 거부 1 · 허용("TV를 봤다") 1 |
| strict · required · non-null | — | ✔ | — | 구조 점검 |

### H — 유의어·반의어 추천 `related_suggestion` (§11)

| 제약 | 프롬프트 §11-1 · 템플릿 §11-2 | JSON Schema §11-3 | zod `relatedSuggestionSchema` / 후처리 | eval (오프라인 "유의어추천(§11)") |
|---|---|---|---|---|
| 후보 5~6 (zod는 1~12) | ✔ 두 곳 모두 | — | ✔ `min(1)` · `RELATED_SUGGEST_MAX_CANDIDATES` 12 | 빈 배열 · 13개 거부 |
| word = 영어 낱말 하나 | ✔ | — | ✔ `/^[A-Za-z][A-Za-z-]*$/` | 공백·문장부호·한글·숫자 거부 + 하이픈 허용 |
| 길이 word 60 · gloss 200 | — | — | ✔ | — |
| glossKo 한글 | ✔ | — | ✔ | 2건 |
| 표제어·중복·빈값 제외 | ✔ | — | 거부 아님 → `postprocessRelatedCandidates` (`suggestRelatedWords` 반환 직전) | 2건 |
| 관계 종류·뜻 맞춤 | ✔ | — | 코드로 불가 | — (오케스트레이터 프로브만) |
| strict 구조 | — | ✔ | — | 구조 점검 |

## 3. 스펙 준수 체크리스트

- [ ] 오프라인 eval이 전부 PASS — `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npx tsx scripts/eval-english.ts`. 2026-09-25 기준 176항목이다(목차 제목 준비 §9-2 23항목 — 처음 11항목에 접두어 정규식 반례·멱등·겹침 " (n)"·표시 불변식·리더 배선 12항목 추가). 항목이 줄었으면 그것도 보고한다(점검이 조용히 빠진 것일 수 있다).
- [ ] spec-sync 11개(block 8 + inline 3)가 PASS. `lib/ai/english/`의 모든 `*_SYSTEM_PROMPT`·`*_USER_TEXT` 상수가 `scripts/eval-english.ts`의 `SPEC_SYNC_TARGETS`에 등록돼 있는지도 대조한다. 등록되지 않은 상수는 대조에서 조용히 빠진다.
- [ ] JSON Schema 8개를 스펙 §2-3·§2A-3·§3-3·§7-3·§8-3·§9-3·§10-3·§11-3과 **손으로** diff한다(spec-sync 대상이 아니다). 전 필드 required, 모든 객체 `additionalProperties:false`, 개수·길이 키 부재. `grep -n "minItems\|maxItems\|minLength\|maxLength" lib/ai/english/*.ts`의 결과가 전부 주석이어야 한다(2026-09-24 기준 3줄 — 두 파일의 머리주석과 schemas.ts `storyOutlineKo` 옆 주석).
- [ ] 호출 옵션이 스펙과 같다. 스펙 §1 표가 8개 호출(A·A′·B·C·D·F·G·H) 전부의 temperature·출력 한도·옵션 상수를 싣는다 — **해소(2026-09-25)**: 전에는 A·A′·B·C만 싣고 머리말이 "4종"이었다. D·F·G·H는 §1 표와 각 절(§8-6·§9-6·§10-5·§11-6) 둘 다와 대조한다.

| 호출 | 스펙 | 코드 상수 (파일) | 값 |
|---|---|---|---|
| A | §1 | `EXTRACT_CALL_OPTIONS` (client.ts) | 0 / 2,000 |
| A′ | §1 | `PAGES_CALL_OPTIONS` (client.ts) | 0.3 / 4,000 |
| B | §1 | `CARD_CALL_OPTIONS` (client.ts) | 0.7 / 6,000 |
| C | §1 | `VOCAB_EXTRACT_CALL_OPTIONS` (vocabbook-prompts.ts) | 0 / 16,000 |
| D | §1 · §8-6 | `VOCAB_ENRICH_CALL_OPTIONS` (vocabbook-prompts.ts) | 0.7 / 8,000 |
| F | §1 · §9-6 | `CHAPTERIZE_CALL_OPTIONS` (client.ts) | 0 / 16,000 |
| G | §1 · §10-5 | `WORD_MEANING_CALL_OPTIONS` (prompts.ts) | 0 / 600 |
| H | §1 · §11-6 | `RELATED_SUGGEST_CALL_OPTIONS` (vocabbook-prompts.ts) | 0.3 / 800 |

- [ ] 모델 ID가 env에서 온다. `grep -rn '"gpt-' lib app scripts components`는 정확히 2곳이어야 한다 — `DEFAULT_OPENAI_MODEL`(client.ts, SPEC §2가 허용한 `OPENAI_MODEL` 미설정 시 기본값)과 `DEFAULT_TTS_MODEL`(lib/tts.ts, SPEC §11). 그 밖의 출현은 하드코딩 결함이다.
- [ ] `callWithSchema`: 재요청 정확히 1회(원래 메시지 + assistant 원문 + "다음 검증 오류를 고쳐 다시 출력해: …") → 재실패 시 throw. 로그 `{ call, model, inputTokens, outputTokens, ms }`가 `finally`에서 성공·실패 무관하게 찍히고, 재요청 토큰이 합산된다. 로그 라벨은 8종이다: extract·pages·card·vocab-extract·vocab-enrich·chapterize·word-meaning·related-suggest.
- [ ] temperature 거부 폴백: 400 + param temperature면 모델을 `modelsRejectingTemperature`에 기억하고 파라미터 없이 재호출한다. 이 폴백이 zod 재요청 횟수에 섞이지 않는지 본다.
- [ ] eval 픽스처가 SPEC §12와 같다(Wolves·Pooh 9필드). `package.json`에 `"eval:english": "tsx scripts/eval-english.ts"`.
- [ ] 스펙 §5의 실호출 수 서술이 코드 `main`과 같다 — **해소(2026-09-25)**: 전에는 `EVAL_TRANSCRIPT=1`을 "자막 카드 1회 추가"라고 썼다. 지금 스펙은 게이트 4종(`EVAL_TRANSCRIPT`→`EVAL_CHAPTERS`→`EVAL_VOCAB`→`EVAL_WORDMEANING` 순, 처음 켜진 하나)이 서로 배타적이고 기본 카드 3회를 **대체**하며, 게이트 실행은 오프라인 결과를 판정에 넣지 않는다고 적는다. 게이트를 더하거나 순서를 바꾼 변경이면 §5와 다시 대조하고, 어긋나면 결함이 아니라 문서 갱신 요청으로 올린다.

## 4. 경계면 체크리스트 — 라우트 ↔ 화면

양쪽 코드를 **동시에 열어** 비교한다. 응답 shape의 단일 정의처는 라우트 머리주석 또는 `lib/*-contract.ts`다.

### 4-1. 카드 — 표지 → 식별 → 낭독 후보 → 카드 (`components/home-create.tsx`)

- [ ] `/api/extract`: `isBookCover=false` 또는 `title=null` → **200** `{ ok:false, reason:"retake", messageKo, extraction }` → 화면이 "다시 찍어주세요" + 수동 입력 폼. 400 / 501 no_api_key / 500 ai_failed(retriable)가 각각 다른 분기로 가는지 본다. `COVER_MAX_IMAGES`를 라우트와 화면이 같이 import한다.
- [ ] `/api/identify`(Google Books, `lib/identify.ts`)는 실패해도 카드 생성을 막지 않는다(`found:false`).
- [ ] `/api/card` 신규 경로: 근거 필드 `blurbText`·`sceneKind`·`sceneDigest`와 `youtubeUrl`이 실린다. 장면 입력 zod가 `SCENE_*`·`MAX_SCENE_DIGEST_ITEMS`를 schemas.ts에서 import한다(숫자 리터럴이면 QA F12 재발). `sceneDigest`가 있고 `sceneKind`가 비면 `"pages"`로 채운다 — `resolveAllowedStorySource`·`formatSceneDigestBlock`과 같은 기본값인지 세 곳을 함께 본다.
- [ ] `/api/card` 재생성 경로(`{ bookId }`): `bookToMeta`가 blurbText·sceneKind·sceneDigest·**transcript**를 모두 넘긴다. 하나라도 빠지면 "다시 생성"이 조용히 metadata로 퇴화한다. 재생성은 Supadata를 다시 부르지 않는다.
- [ ] 200 `reason:"duplicate"`(동일 제목+저자) → 기존 카드 안내 + `force`. 500은 `retriable:true`.
- [ ] 카드 배지: 화면은 `STORY_SOURCE_LABELS_KO`만 쓰고(문구 리터럴 금지), `app/card/[id]/page.tsx`가 `resolveStorySource`로 구 카드(`storyIsGuess`만 있는 것)를 해석한다. 구·신 카드를 실제로 렌더해 본다.

### 4-2. 본문 판독 (`/api/pages` ↔ home-create)

- [ ] 부분 실패: 200 + `failedBatchCount>0` + messageKo. 전 배치 실패만 500. 404 book_not_found.
- [ ] `/api/pages`가 200으로 내린 장면을 `/api/card`가 400으로 거절하면 → 재시도 버튼이 아니라 "본문 없이 카드 만들기" 출구로 간다(`createCardWithScenes`의 `onInvalidInput`).
- [ ] `PAGES_BATCH_SIZE`·`PAGES_MAX_IMAGES`는 client.ts가 정의처이고 `app/english/books/page.tsx`(서버 페이지)가 import한다.

### 4-3. 낭독 자막 grounding (Supadata · YouTube)

- [ ] `/api/youtube-search`(`lib/youtube-search.ts`, `YOUTUBE_API_KEY`): 후보 최대 3개(`TOP_N`). 키 없음·결과 0·오류·타임아웃은 200 `{ ok:false, error, messageKo }`(비치명).
- [ ] **사람이 고르는가.** `fireReadaloudSearch`는 후보가 1개 이상이면 멈춰서 부모의 탭을 기다리고, 0개·오류일 때만 1.2초 뒤 `resolveReadaloud(null)`로 표지 기준 진행한다. 첫 후보를 자동으로 넘기는 코드가 생겼다면 P1이다(SPEC §14-1 — 엉뚱한 책 grounding은 카드와 챕터를 조용히 전부 오염시킨다).
- [ ] 자막 fetch는 `/api/card` 안에서만 한다(`fetchYoutubeTranscript`, `SUPADATA_API_KEY`, 서버 전용). throw하지 않고 `{ ok:false, reason }`(no_key·invalid_url·no_transcript·api_error·timeout·network·empty)을 돌려준다. 실패하면 카드는 표지 기준으로 만들어지고 `transcriptNotice`가 화면에 뜬다. `lib/youtube-transcript.ts` 머리주석이 호출처를 `app/api/card/route.ts` 하나로 적는다 — **해소(2026-09-25)**: 전에는 존재하지 않는 `app/api/transcript/route.ts`를 가리켰다.
- [ ] 자막은 `BookRecord.transcript`에 내부 근거로 저장되고 화면에는 보이지 않는다. 로그에 자막 본문이 찍히지 않는다.

### 4-4. 챕터 리더 (`/api/chapterize` ↔ `components/chapter-reader.tsx`, home-create의 best-effort 호출)

- [ ] 버튼 노출과 라우트가 같은 판정 `canChapterizeBook`(lib/store.ts, 자막 존재)을 쓴다. 자막 없음 → 400 `not_chapterizable`(재시도 버튼이 아니다). 재요청 소진 → 500 ai_failed.
- [ ] 목차 제목은 `sceneKind === "toc"`일 때 `sceneDigest[].labelKo`에서 와서 **`prepareChapterTitles`(schemas.ts, 스펙 §9-2 "목차 제목 준비")를 거쳐** F로 간다. 두 경계는 **해소(2026-09-25)**됐다. (1) A′ 목차 labelKo("3장: Pooh와 꿀단지")의 서수 접두어를 떼서 넘기고, 번호는 챕터 리더 탭(`i + 1`) 한 곳에서만 보인다. 떼고 나서 겹치면 접두어를 되살리지 않고 " (n)"을 붙인다("1장: 아침"·"5장: 아침" → "아침"·"아침 (2)"). chapter-reader는 **모든** 레코드에 같은 정리(`cleanChapterTitles` — 접두어 떼기 + 겹침 " (n)")를 해서 표시하지만, 새 레코드엔 지울 접두어도 겹침도 없어 그대로 보인다(준비한 제목은 이 정리의 고정점). 모양이 바뀌는 것은 접두어가 붙은 채 저장된 옛 레코드뿐이고, 서버가 같은 목차로 지금 만들 제목과 같게 보인다. 회귀 신호: 리더가 `stripChapterOrdinalPrefix`를 제목마다 따로 부르거나, 서버가 충돌 때 원문(접두어)을 되살리면 "1장: 아침"~"40장: 아침" 목차의 탭 40개가 전부 "아침"으로 뜬다(QA found-defects_1 F2). 접두어 정규식의 지원 범위(숫자 1~3자리·로마 숫자 1~99·영어 수사 1~99, 겹친 접두어는 끝까지, 못 떼는 모양은 원문)는 스펙 §9-2 3단계가 정의처다. (2) 목차가 40개를 넘으면 인접 제목을 `ceil(n/40)`개씩 `" / "`로 묶어 40개 이하로 넘긴다(41→21, 120→40, 자르지 않음). 확인할 것: 라우트가 labelKo를 `prepareChapterTitles` 없이 F에 넘기면 회귀다(P1 — 목차 41개 이상인 책의 챕터화가 통째로 실패한다). eval "목차 제목 준비(§9-2)" 23항목(불변식·옛 레코드 표시·리더 배선 포함)이 PASS인지, 묶음이 생기면 라우트가 `{ call:"chapterize", bookId, tocTitleCount, groupSize, chapterTitleCount }` 경고를 남기는지 본다. **남은 공백(프롬프트 소관)**: A′ labelKo의 제목 부분이 영어 원제가 아니라 우리말 번역이나 혼용("Pooh와 꿀단지")일 수 있어서, 접두어를 떼도 탭 제목이 한국어로 뜰 수 있다. F는 받은 제목을 echo할 뿐이라 원제로 되돌리지 못한다.
- [ ] `droppedSentenceCount > 0`이면 라우트가 `{ call:"chapterize", bookId, droppedSentenceCount, truncated }`를 경고로 남긴다. 챕터는 `updateBookEvidence`로 book에만 얹는다(카드는 건드리지 않는다).
- [ ] 목차 없음 → `WHOLE_TRANSCRIPT_TITLE`("전체") 한 블록. chapter-reader가 같은 상수로 분기한다.

### 4-5. 단어 뜻·모은 단어 (chapter-reader)

- [ ] `/api/word-meaning`: 응답 타입은 `lib/word-meaning-contract.ts`. 라우트 zod가 빈 단어·문장을 **400**으로 먼저 거른다(스펙 §10-5의 "빈 입력 → 500"은 `lookupWordMeaning`을 직접 부를 때의 이야기다). 501 no_api_key는 호출 전에 구조적으로 거절한다. 단어 길이 상한은 `VOCAB_WORD_MAX`, 문장은 2,000자.
- [ ] `/api/english/vocab/collected/add-word`(`lib/collected-vocab-contract.ts`): 호출 G로 이미 받은 뜻을 담는다. 호출 D를 부르지 않는다. 대소문자 무시 중복이면 `added:false`.

### 4-6. 단어장 정복 (`components/vocabbook-photo-flow.tsx`·`vocabbook-view.tsx`·`vocab-quiz-view.tsx`)

- [ ] `/api/english/vocab/extract`(`lib/vocab-extract-contract.ts`): 사진 장수 상한은 `VOCAB_LIMITS.photos`(8, `lib/vocab-create-contract.ts`)다. 사진마다 병렬 호출하고, 한 장이라도 성공하면 병합해 200을 준다(`failedPhotoCount`). 병합 결과 0개면 200 `reason:"retake"`. 전 사진 실패만 500. 사진은 저장·로깅하지 않는다.
- [ ] `/api/english/vocab/[id]/enrich`(`lib/vocab-enrich-contract.ts`): `entriesToEnrich` → `enrichVocab` → `mergeEnrichment` 순서다. 부분 실패는 오류가 아니다(`remainingDefinitions`·`remainingGlosses`). 호출 D 전체 실패만 500 `enrich_failed`.
- [ ] `/api/english/vocab/[id]/add-word`(`lib/vocab-add-word-contract.ts`): 키가 없으면 단어를 뜻 null로 저장하고 **501 + `added:true`**. 호출 D가 실패하면 200 + `enrichSkipped:"enrich_failed"`. 화면이 이 두 갈래를 구분하는지 본다.
- [ ] `/api/english/vocab/[id]/quiz`(`lib/vocab-quiz-contract.ts`) ↔ vocab-quiz-view. 보기 생성 `buildChoices`, 관계 문제 `buildRelationQuestions`(source:"user" 유의어·반의어만), 졸업 `MASTERY_STREAK`는 오프라인 eval이 잠근다.

### 4-7. 유의어·반의어 연결 (vocabbook-view)

- [ ] `/api/english/vocab/[id]/suggest-related`(호출 H, `lib/vocab-link-contract.ts`): 200 `{ ok:true, candidates }` / 404 vocabbook_not_found / 501 no_api_key / 500 **`suggest_failed`**(ai_failed가 아니다). 화면이 이 코드명으로 분기하는지 본다.
- [ ] `/api/english/vocab/[id]/add-related`: 이미 있는 단어(대소문자 무시)면 연결만 하고, 없으면 `appendVocabEntry` → `enrichVocab` + `mergeEnrichment`(best-effort) → `linkVocabRelated`(`applyVocabLink`, 상호 기록·멱등). 응답 `{ added, linked, enrichSkipped }`.
- [ ] `/api/english/vocab/[id]/link` POST/DELETE: 자기 자신 연결·인덱스 밖은 400.

### 4-8. 서버 전용 경계

- [ ] `"use client"` 파일은 `lib/ai/english/schemas.ts`·`vocabbook-schemas.ts`(zod·상수·순수 함수)와 타입만 import할 수 있다. `lib/ai/client.ts`(openai)·`lib/youtube-transcript.ts`·`lib/youtube-search.ts`의 값 import가 클라이언트에 있으면 결함이다. 빌드 후 `.next/static`에서 키·프롬프트 원문 0건을 확인한다.

### 4-9. 삭제·저장·보조 라우트 (AI 없음)

AI를 부르지 않는다고 가볍게 보지 마라. 2026-08-17 사고(CLAUDE.md)는 로컬 삭제 테스트가 프로덕션 Firestore의 책·카드·읽음 기록을 지운 일이었다 — 바로 이 절의 라우트들이다. 라우트별 상태코드·계약 파일 전체는 `ai-harness-impl/references/english-routes.md` §3·§4에 있다. 여기서는 QA가 대조할 것만 적는다.

- [ ] **실행 전 백엔드 확인.** 삭제를 실제로 돌려 보는 검증은 `STORE_BACKEND=file`을 **명시한** 명령으로만 한다. 자동 감지(`lib/store.ts`)는 `GOOGLE_APPLICATION_CREDENTIALS`·`K_SERVICE`·`GOOGLE_CLOUD_PROJECT` 중 하나만 있어도 Firestore를 잡는다. 가드는 삭제만 막고, 생성·수정은 그대로 실데이터에 쓴다.
- [ ] `DELETE /api/books/[id]` ↔ `components/library-view.tsx`: 404 `book_not_found`이면 화면이 목록에서 빼고 "이미 지워져 있었어요"를 띄운다. 200 `{ deleted:{ cards, readings } }` — 그 책의 카드와 읽음 기록을 연쇄 삭제한다(파일 백엔드는 한 `mutate` 안에서, Firestore는 batch로 지우고 책 문서를 마지막에 지운다).
- [ ] `DELETE /api/cards/[id]` ↔ `components/card-view.tsx`(카드 히스토리): 마지막 한 장이면 **409 `last_card` + `bookId`**. 화면이 `lastCardBookId`를 세워 "서재에서 책 지우기 →" 링크(`/library`)로 안내하는지 본다. 조용히 책까지 지우는 쪽으로 바뀌었다면 요청하지 않은 연쇄 삭제다(P1). 200이면 `latestCardId`로 이동하고(지금 보던 카드를 지운 경우), 404면 refresh한다.
- [ ] `DELETE /api/english/vocab/[id]` ↔ `components/vocab-library-view.tsx`: 404 `vocabbook_not_found`. 이 라우트는 존재만 확인하고 `isRenderableVocabBook`은 쓰지 않는다. 라우트 머리주석은 "V1은 연쇄 삭제가 없다"고 쓰지만, 두 백엔드의 `deleteVocabBook`은 그 단어장의 시험 세션(`vocabQuizzes`)까지 지운다. 낡은 주석이다(P2).
- [ ] **prod-guard 대조.** 위 세 라우트는 `store.delete*`를 try로 감싸고, `isProdGuardError(e)`이면 **403 `{ error:"prod_guard", messageKo }`**를 준다. 화면은 기본 분기에서 이 messageKo를 보여 준다. 가드 호출은 `lib/store-firestore.ts`의 `deleteBook`·`deleteCard`·`deleteVocabBook`의 **첫 문장**(사고 경위 주석 바로 아래) `assertDestructiveAllowed(...)`에 있고, 파일 백엔드(`lib/store.ts`)에는 없어야 정상이다. 라우트에서 403 분기가 빠지면 가드가 던진 오류가 미가공 500으로 나간다. 스토어에서 가드 줄이 빠지면 실데이터가 지워진다(P1). Firestore에 붙여 실행하지 말고 코드 대조로 끝낸 뒤 "미검증(코드 대조만)"으로 적는다. 무비용으로 할 수 있는 것은 하나다. 스크래치에서 `assertDestructiveAllowed("deleteBook")`를 `NODE_ENV`와 `ALLOW_PROD_DESTRUCTIVE` 없이 직접 불러 던지는지, 그 오류를 `isProdGuardError`가 알아보는지 확인한다. 순수 함수라 스토어를 건드리지 않는다.
- [ ] `POST /api/english/vocab`(`lib/vocab-create-contract.ts`) ↔ `components/vocabbook-photo-flow.tsx`: §4-6의 extract와 enrich 사이 단계다. AI를 부르지 않고 키 검사도 없다(키가 없어도 저장은 돼야 한다). 항상 `enriched:false`로 저장한다. 저장에 성공하면 화면이 곧바로 `/api/english/vocab/[id]/enrich`를 best-effort로 부르고, 실패는 무시한 채 상세로 이동한다. 400 `invalid_input`(issues)·500 `save_failed`. 입력 zod의 길이 상한은 `VOCAB_LIMITS`에서 가져와야 한다. 이 객체는 vocabbook-schemas의 `VOCAB_*_MAX`를 묶고, 책 단위 값(`titleKo` 120·`entriesPerBook` 400·`photos` 8)만 새로 정한다. enum(`PARTS_OF_SPEECH`·`RELATED_KINDS` 등)은 vocabbook-schemas에서 직접 가져온다. 라우트에 숫자 리터럴이 있으면 판독 zod와 어긋날 수 있다.
- [ ] `POST /api/english/vocab/[id]/rename`(`lib/vocab-rename-contract.ts`) ↔ `components/vocab-title-editor.tsx`: titleKo는 trim한 뒤 1~`VOCAB_LIMITS.titleKo`자여야 한다. 404는 `isRenderableVocabBook`으로 가른다. 수정이라 가드 대상이 아니다.
- [ ] 순서변경 `POST /api/library/reorder`(library-view)·`POST /api/english/vocab/reorder`(vocab-library-view): 둘 다 `reorderRequestSchema`(`lib/reorder-contract.ts`)를 쓴다 — 빈 배열·중복 id·`REORDER_MAX_IDS`(1000) 초과는 400이다. 없는 id는 스토어가 건너뛴다. 응답은 `{ count }`뿐이고, 화면은 낙관적으로 먼저 옮긴 뒤 `router.refresh()`로 확정한다. 공통 골격(`components/use-reorder.ts`, `sortIndex` 규약)은 `ai-harness-impl/references/app-patterns.md`에 있다.
- [ ] `POST /api/readings` ↔ card-view: 같은 책·같은 날짜면 새로 넣지 않고 **200 `duplicate:true` + 기존 기록**을 돌려준다. `readAt`은 클라이언트가 `deviceDateString()`(lib/kst.ts)으로 만든 YYYY-MM-DD이고, 빠지면 서버의 UTC 날짜로 폴백한다. 화면은 duplicate 여부와 무관하게 기록을 병합해 완료 패널을 띄운다.
- [ ] **렌더 판정 단일 함수.** `isRenderableVocabBook`(`lib/vocabbook-record.ts`)을 화면(목록·상세·퀴즈·히스토리·오답 페이지)과 라우트(enrich·add-word·add-related·suggest-related·link·quiz·rename)가 함께 쓴다. `grep -rln isRenderableVocabBook app`과 `grep -rln "getVocabBook(" app`을 대조해, 존재만 보고 넘어가는 곳이 있는지 찾는다. `getVocabBook`을 부르면서 이 판정을 쓰지 않는 정상 예외는 둘이다. DELETE(위)는 열 수 없는 레코드도 지울 수 있어야 한다. `/api/streak`은 라벨만 읽고, 없으면 기본 라벨로 떨어진다(common.md 영역). `collected/add-word`는 애초에 `getVocabBook`을 부르지 않는다. "모은 단어" 단어장을 `store.getOrCreateCollectedVocabBook()`으로 얻는다. 판정이 갈리면 "목록엔 보이는데 눌렀더니 500"이 된다.

## 5. 정확성 장치 반례 확인법

전부 순수 함수와 zod라 무비용이다. 먼저 오프라인 eval을 돌리고, 아래 항목의 이름으로 결과를 찾는다. eval에 반례가 없는 칸은 QA가 직접 넣는다. 스크래치 파일에서 해당 함수를 import해 `npx tsx`로 돌린다. 접두어는 `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT=`처럼 키와 GCP 신호를 비운 것을 쓴다. 예외는 "재요청·throw·로그" 행 하나이며, 그 행에 따로 적었다.

| 장치 | eval이 이미 넣는 반례 | QA가 직접 넣을 반례 · 2026-09-24 실측값 |
|---|---|---|
| **grounding** `isGroundedInTranscript` | "grounding: 자막에 없는 문장은 거부", "groundChapters: 자막 밖 문장 잘라냄"(dropped 2), "문장 전부 잘린 챕터는 matched:false" | 어순 바꿈 → false · 한 단어 치환 → false · 문장부호만 → false · 한글 → false. **통과하는 것도 확인한다**: 자막 한 문장의 일부 구간("he ate and ate") → true, 문장 경계를 넘는 구간("ate. He ate every") → true. grounding이 보장하는 것은 "자막의 연속 토큰 부분열"뿐이다. 문장 경계·챕터 배정·번역은 보장 밖이므로 `EVAL_CHAPTERS` 출력과 실물을 사람이 읽는다 |
| **원문 전사 8단어** `longestEnglishRun` | A′: "한글 없음", "한글+영어 8단어 혼합" | **B에는 오프라인 반례가 없다.** `makeLearningCardSchema`에 스텁 카드(eval의 `makeTranscriptStubCard` 모양)를 넣어 본다: 8단어 혼합 → storyOutlineKo 거부, 7단어 → 통과. 한글 없는 짧은 영어("Pooh eats. Pooh is stuck.") → **zod 통과**(한글 검사는 eval 점검 8에만 있다). 숫자 토큰이나 한글이 붙은 토큰에서 run이 0으로 돌아간다 — "Pooh ate 3 pots of honey and got stuck in the hole"은 9 |
| storySource 랭크 | "근거 없이 transcript 주장 → zod 거부", "자막 넘긴 호출은 transcript 주장 허용" | 낮춰 적기(pages 근거 + metadata 주장)가 통과하는지 — 등호로 조이면 여기서 깨진다 |
| sceneKind 기본값 3곳 | — (eval에 없음: 픽스처가 전부 sceneKind를 명시한다 — 장면 픽스처 "Pooh (장면 14)"와 자막 점검의 장면 입력이 모두 `sceneKind:"pages"`다. "동기화." 항목은 이 경로를 밟지 않는다) | `sceneKind` 없이 장면만 넘긴 입력으로 `resolveAllowedStorySource`·`buildCardUserMessage`("본문 촬영")·`/api/card`(`?? "pages"`)가 같은 판단을 내리는지 **함께 실행**한다. 이 기본값 경로는 QA가 직접 넣을 때만 검증된다 |
| D 정의 불변 `mergeEnrichment` | "EN·KO·이모지 각각 불변…", "해석 백필(EN 불변)…", "no 없으면 word로 매칭" | 결과에 다른 EN을 준 적대적 입력 → 기존 EN 유지. 결과에 없는 단어 → 그대로 |
| C 판독 zod | ipa 대괄호, 페이지 게이트, 번호 중복, 뜻 번호 200, 빈 뜻 | 사진 1장에 항목 41개 → 거부(eval에 없음) |
| F 상한 | 챕터 41개, 챕터당 121문장, en 601자, ko 801자 | 전체 문장 601개(챕터당은 상한 이내) → 거부(eval에 없음) |
| H 형식·후처리 | 공백·문장부호·한글·숫자·빈 gloss·영어 gloss·13개 / 표제어·중복·빈값 거르기 | — |
| G 형식 | 빈·공백·41자·echo·영어 2연속 / "TV를 봤다" 허용 | — |
| 재요청·throw·로그 | — | 루프백 스텁으로 첫 응답은 zod 위반, 둘째는 정상 → 요청 2회·성공. 둘 다 위반 → throw. 두 경우 모두 로그 한 줄에 토큰이 합산되는지. **이 행만 접두어가 다르다** — `getOpenAIClient`(lib/ai/client.ts)가 빈 키면 요청 전에 throw하므로 위의 빈 키 접두어로는 재요청 경로에 닿지 않는다: `OPENAI_API_KEY=stub-not-a-key OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT=`. 클라이언트가 `new OpenAI({ apiKey })`만 넘기므로 SDK가 `OPENAI_BASE_URL`을 env에서 읽는다. `OPENAI_BASE_URL` 없이 가짜 키만 두지 마라 — 요청이 api.openai.com으로 나간다. 스텁은 `POST /v1/responses`에 200으로 `{ object:"response", status:"completed", output:[{ type:"message", content:[{ type:"output_text", text }] }], usage }`를 준다(SDK가 여기서 `output_text`를 조립한다). SDK 기본 `maxRetries` 2 때문에 스텁이 408·409·429·5xx를 주거나 연결이 끊기면 요청 수가 늘어 "2회" 판정이 틀어진다 |
| 사이트워드 단일 정의처 | 점검 2가 같은 상수를 import | `grep -rln '"goes"' lib scripts app components` → `lib/ai/english/schemas.ts` 한 곳만 나와야 한다 |

반례가 **거부되지 않으면** 그 장치는 없는 것과 같다. P1로 올리고 담당을 ai-engineer로 적는다.

## 6. 리포트 형식

`_workspace/qa_report_english_{tag}_{n}.md` — tag는 기능 이름(예: `chapters`, `vocab-link`; 전체 점검이면 생략), n은 회차.

```
# QA 리포트 {n} — english · {검증 범위}
## 요약: 통과 X / 실패 Y / 미검증 Z
## 정합성 매트릭스 — 호출별(A·A′·B·C·D·F·G·H 중 범위 안의 것) 위치별 실제 값
## 항목별 pass/fail 표
- {제약} | 위치별 값: prompt=…, schema=…, zod=…, eval=… | {파일:심볼} | 수정 방법: … | 담당: ai-engineer|app-builder|prompt-tuner | P1|P2
## 실측 방법 — 오프라인 eval 결과(항목 수/통과 수), 직접 넣은 반례와 결과, 스텁·렌더 확인
## 미검증 항목과 그 이유
## 배포 가부 (가능/보류) + 근거 한 줄
```

- 우선순위 기준: grounding·원문 전사·정의 불변·낭독 영상 사람 선택이 뚫리면 **P1**(틀린 내용이 조용히 저장된다). 상태코드 분기 누락이나 상수 이중 정의처럼 사용자가 막히는 결함도 P1이다. 삭제 경로의 prod-guard가 빠진 것(스토어의 `assertDestructiveAllowed` 줄이나 라우트의 403 분기), 마지막 카드 409가 조용한 연쇄 삭제로 바뀐 것도 P1이다(2026-08-17 사고의 재발 경로다). 문서·주석 낡음, ⚠ 미강제 칸은 P2다.
- 발견 이슈는 직접 고치지 않는다. 파일·심볼 + 수정 방법 + 담당을 적어 반환한다. 줄 번호는 금방 낡으니 심볼 이름을 함께 쓴다.
- 검증하지 못한 것(키 없음, 실기기 필요, 실사진 필요)은 실패가 아니라 "미검증 + 사유"로 둔다. 실사진 판독(A·A′·C)과 H의 의미 판단은 무비용 수단으로는 끝까지 미검증이다.

## 7. 실행 시점

전체가 완성된 뒤 한 번이 아니라 **모듈이 끝날 때마다** 돌린다(incremental QA). `lib/ai/english/` 변경 직후에는 §2 매트릭스 + §3 체크리스트 + §5 반례까지, 라우트·화면이 연결된 뒤에는 §4 경계면까지 전부 본다. 스토어(`lib/store.ts`·`lib/store-firestore.ts`)나 삭제·저장 라우트를 건드린 변경은 AI와 무관해 보여도 §4-9를 빼지 않는다.

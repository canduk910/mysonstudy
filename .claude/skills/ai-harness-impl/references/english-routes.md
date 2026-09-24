# 영어 — 호출 배선과 라우트 전체

> `ai-harness-impl` 스킬에서 영어(북카드·영어 단어장·챕터 리더) 작업 시 읽는다. 일본어는 `japanese.md`, 공통 기능은 `app-patterns.md`.
> 원문 스펙: `docs/harness/english.md`(호출 A·A′·B·C·D·F·G·H — E는 없다), 앱 흐름 `docs/SPEC.md` §3·§9·§14·§15.
> 프롬프트 원문은 여기 옮기지 않는다. 스펙이 단일 정의처이고 `scripts/eval-english.ts`의 spec-sync가 대조한다.

목차: 1. 호출 → 진입 함수 · 2. 북카드 라우트(라우트 연결) · 3. 영어 단어장 라우트 · 4. AI 없는 영어 라우트 · 5. 경계면 규칙과 알려진 틈 · 6. eval-english.ts 픽스처와 게이트

영어는 카드 한 장에서 시작해 기능이 세 줄기로 자랐다. 줄기마다 **실패의 무게가 다르다** — 카드 생성은 실패하면 저장하지 않고, 자막·챕터·단어 뜻은 실패해도 카드를 막지 않으며, 단어 담기는 뜻이 실패해도 단어를 잃지 않는다. 라우트를 새로 만들거나 고칠 때는 먼저 그 라우트가 어느 무게에 속하는지 정한다.

## 1. 호출 → 진입 함수

| 호출 | 스펙 | 진입 함수 | 로그 라벨(`call`) | 호출 옵션 상수 | 부르는 라우트 |
|---|---|---|---|---|---|
| A 표지 판독 (vision) | §2 | `extractBook(imageDataUrls)` — `lib/ai/client.ts` | `extract` | `EXTRACT_CALL_OPTIONS` (client.ts) | `/api/extract` |
| A′ 본문·목차 판독 (vision) | §2A | `digestPages({images, sourceKind, book, startSeq})` — client.ts | `pages` | `PAGES_CALL_OPTIONS`·`PAGES_BATCH_SIZE`(6)·`PAGES_MAX_IMAGES`(40) (client.ts) | `/api/pages` |
| B 카드 생성 | §3 | `generateCard(input)` — client.ts | `card` | `CARD_CALL_OPTIONS` (client.ts) | `/api/card` |
| C 단어장 판독 (vision) | §7 | **없음** — 라우트가 `callWithSchema`를 사진 1장당 직접 부른다 | `vocab-extract` | `VOCAB_EXTRACT_CALL_OPTIONS` (`vocabbook-prompts.ts`) | `/api/english/vocab/extract` |
| D 단어장 보강 | §8 | `enrichVocab(entries)` — client.ts | `vocab-enrich` | `VOCAB_ENRICH_CALL_OPTIONS` (`vocabbook-prompts.ts`) | `/enrich`·`/add-word`·`/add-related` |
| F 챕터화 | §9 | `chapterizeTranscript(chapterTitles, transcript)` — client.ts | `chapterize` | `CHAPTERIZE_CALL_OPTIONS` (client.ts) | `/api/chapterize` |
| G 단어 뜻 조회 | §10 | `lookupWordMeaning(word, sentence)` — client.ts | `word-meaning` | `WORD_MEANING_CALL_OPTIONS` (`prompts.ts`) | `/api/word-meaning` |
| H 유의어·반의어 추천 | §11 | `suggestRelatedWords({word, meaningKo, kind})` — client.ts | `related-suggest` | `RELATED_SUGGEST_CALL_OPTIONS` (`vocabbook-prompts.ts`) | `/suggest-related` |

- 파일: 카드 쪽은 `lib/ai/english/prompts.ts`·`schemas.ts`, 단어장 쪽은 `vocabbook-prompts.ts`·`vocabbook-schemas.ts`와 순수 함수 `vocabbook-merge.ts`(사진별 판독 병합 `mergeVocabPages`·구멍 찾기 `findMissingNumbers`)·`vocabbook-enrich.ts`(보강 대상 선별·정의 불변 병합).
- 호출 옵션 상수가 두 곳에 산다(A·A′·B·F는 client.ts, C·D·G·H는 프롬프트 파일). 지금 상태를 그대로 따르되, 새 호출은 뒤쪽 관용구(프롬프트 파일에 `{call, temperature, maxOutputTokens}`)를 쓴다. 숫자는 스펙 각 호출의 "호출 옵션" 절이 원본이다.
- 호출 C만 진입 함수가 없는 이유: 사진 N장을 1장씩 병렬 판독하고 `mergeVocabPages`로 번호 병합하는 흐름이 라우트에 있다. 진입 함수를 새로 만들면 라우트와 eval이 같은 배선을 보게 할 수 있지만, 그때도 프롬프트·스키마는 `vocabbook-*`에서 import만 한다.

## 2. 북카드 라우트 (라우트 연결)

신규 카드 흐름은 화면 `components/home-create.tsx` 하나가 부른다: `/api/extract`(또는 제목 직접 입력) → `/api/identify` → 낭독 후보 `/api/youtube-search`·본문 사진 `/api/pages`(둘 다 선택) → `/api/card` → 자막이 있으면 `/api/chapterize`(`runChapterizeBestEffort` — 응답을 검사하지 않고 throw도 삼킨다. 실패하면 상세 화면의 "챕터로 읽기 만들기"가 폴백). 카드 화면 `components/card-view.tsx`는 "다시 생성"으로 `/api/card`를, 챕터 리더 `components/chapter-reader.tsx`는 `/api/chapterize`·`/api/word-meaning`을 부른다.

이 줄기의 라우트는 계약 파일이 없다 — **라우트 머리 주석의 "응답 shape"이 정의처**다. 고칠 때는 주석과 소비 화면을 같이 연다.

| 라우트 | 역할 | AI | 폴백 신호 · 상태코드 | 소비 화면 |
|---|---|---|---|---|
| `POST /api/extract` | 표지·스티커·뒤표지 1~`COVER_MAX_IMAGES`(3)장 판독 | A | 200 ok · **200 `reason:"retake"`**(`isBookCover=false` 또는 `title=null` — 부분 판독값 `extraction`을 수동 폼 프리필용으로 함께) · 400 · 501 · 500 `ai_failed` | home-create |
| `POST /api/identify` | 제목(+저자) → Google Books → Open Library 폴백 | 없음 | 200 `{found, result}` — 둘 다 실패해도 200 + null 필드(카드 생성을 막지 않는다) · 400 | home-create |
| `GET /api/youtube-search` | 낭독 영상 후보 **최대 3개** | 없음 | 200 `{results}` · **200 `{ok:false, error}`**(`no_key`·`no_results`·`api_error`·`timeout`·`network` — 비치명, 표지 기준으로 폴백) · 400 | home-create |
| `POST /api/pages` | 본문·목차 사진 N장 → 장면 요약(`sceneDigest`) | A′ | 200(부분 실패면 `failedBatchCount>0`+`messageKo`) · 400 · 404 `book_not_found`(bookId를 준 경우) · 501 · 500 `ai_failed`(전 배치 실패) | home-create |
| `POST /api/card` | 카드 생성 — 신규(메타 전체) 또는 재생성(`{bookId}`) | B | 200 `{bookId, cardId, transcriptNotice}` · **200 `reason:"duplicate"`**(같은 제목·저자 — `force:true`면 기존 책에 새 카드) · 400 · 404 · 501 · 500 `ai_failed` | home-create, card-view |
| `POST /api/chapterize` | 저장된 자막 → 챕터별 EN/KO 문장, `book.chapters`에 저장 | F | 200 `{chapterCount, matchedCount, truncated, droppedSentenceCount}` · 400 `not_chapterizable`(자막 없음) · 404 · 501 · 500 | home-create, chapter-reader |
| `POST /api/word-meaning` | 더블탭 단어 + 그 문장 → 문맥 뜻 | G | 200 `{word, meaningKo}` · 400 · 501 · 500 — 계약 `lib/word-meaning-contract.ts` | chapter-reader |

라우트별로 지킬 것:

- **`/api/extract`** — 판독 실패는 예외가 아니라 정상 흐름이다. 클라이언트는 retake면 "다시 찍어주세요" + 수동 입력 폼을 띄운다(§2-4). 500은 재요청 소진 throw에만.
- **식별**(`lib/identify.ts`의 `identifyBook`) — Google Books `volumes?q=intitle:"{title}" inauthor:"{author}"`(env `GOOGLE_BOOKS_API_KEY`가 있으면 `key` 추가) → 실패·무결과면 Open Library `search.json` → 둘 다 실패면 전 필드 null. **어떤 경우에도 throw하지 않는다.** 두 공식 API 외에 크롤링·스크래핑은 하지 않는다(SPEC §1 저작권). `description`은 카드 입력의 `googleBooksDescription`이 된다.
- **낭독 영상은 사람이 고른다.** `lib/youtube-search.ts`(env `YOUTUBE_API_KEY`, 서버 전용)가 후보 3개를 주고 부모가 탭해 고른 URL만 `/api/card`의 `youtubeUrl`로 간다. 엉뚱한 책 영상에 grounding되면 카드·챕터·번역이 에러 없이 그럴듯하게 틀리므로, 첫 결과 자동 채택으로 되돌리지 마라.
- **`/api/pages`** — 배치 분할·병렬·부분 실패 격리·seq 재부여·장면 수 상한 절단은 전부 `digestPages`가 한다. 라우트는 입력 검증과 상태코드 매핑만 한다. `bookId`를 주면 결과를 `store.updateBookEvidence`로 그 책에 저장한다. 오류 구분은 `isPagesError(err)` 후 `err.code`(`invalid_input`→400, `ai_failed`→500).
- **`/api/card`** — AI 생성이 성공한 **뒤에만** book+card를 저장한다(SPEC §9 불완전 데이터 저장 금지). `youtubeUrl`이 있으면 서버가 `fetchYoutubeTranscript`(Supadata, env `SUPADATA_API_KEY`)로 자막을 받아 호출 B의 최상위 근거 `transcript`로 싣고 book에 보관한다. 자막 실패는 비치명 — 카드는 표지 기준으로 만들고 사유를 `transcriptNotice`로 내린다(`fetchYoutubeTranscript`는 throw하지 않는다).
- **재생성은 근거를 잃으면 안 된다.** `bookToMeta`가 저장된 `blurbText`·`sceneKind`·`sceneDigest`·`transcript`를 **전부** 호출 B 입력에 다시 싣는다. 하나라도 빠지면 storySource가 metadata로 떨어져 줄거리가 3~4문장으로 조용히 퇴화하고, `sceneKind`가 빠지면 목차 근거가 "본문 확인"으로 오표기된다. 재생성은 Supadata를 다시 부르지 않는다(영상 삭제·비공개에도 안전).
- **`/api/chapterize`** — 카드와 별개 경로라 실패가 비치명이다(책·카드는 손대지 않는다). 가능 여부는 `canChapterizeBook`(`lib/store.ts`, 자막이 비어 있지 않은가) 한 곳이 판정한다. 챕터 제목은 `sceneKind === "toc"`일 때 `sceneDigest`의 `labelKo`들이고, 목차가 없으면 빈 배열을 넘긴다 — `resolveChapterTitles`가 단일 "전체" 챕터(`WHOLE_TRANSCRIPT_TITLE`)로 바꾼다. 목차 없음은 실패가 아니다. 오류 구분은 `isChapterizeError`(400) / throw(500).
- **`/api/word-meaning`** — 뜻 실패는 화면이 비치명 안내로 받는다. 단어 담기는 별개 동작이라 뜻 실패로 막히지 않는다.

## 3. 영어 단어장 라우트

단어장(교재 DAY 사진 → 판독 → 보강 → 시험)은 카드와 별개 경로다. 화면은 `components/vocabbook-photo-flow.tsx`(판독·저장·저장 직후 보강), `vocabbook-view.tsx`(보강·담기·유의어 추천·연결 해제), `vocab-quiz-view.tsx`(시험 저장), `vocab-title-editor.tsx`(이름), `vocab-library-view.tsx`(삭제·순서).

| 라우트 | 역할 | AI | 폴백 신호 · 상태코드 | 계약 |
|---|---|---|---|---|
| `POST /api/english/vocab/extract` | 사진 1~`VOCAB_LIMITS.photos`장 → 장별 병렬 판독 → `mergeVocabPages` 병합. 저장 안 함 | C | 200 ok(`failedPhotoCount`·`missingNos`·`pages`) · **200 `reason:"retake"`**(병합 결과 0단어) · 400 · 501 · 500 `ai_failed`(전 사진 throw) | `lib/vocab-extract-contract.ts` |
| `POST /api/english/vocab` | 검토한 `VocabEntry[]` 저장(`enriched:false`) | 없음 | 200 `{id}` · 400 · 500 `save_failed` — 키 검사 없음 | `lib/vocab-create-contract.ts` |
| `POST /api/english/vocab/[id]/enrich` | 비어 있는 영영 정의·우리말 해석·이모지만 채움("다시 만들기" 겸용) | D | 200(`remainingDefinitions>0`이면 부분 성공) · 404 · 501 · 500 `enrich_failed` | `lib/vocab-enrich-contract.ts` |
| `POST /api/english/vocab/[id]/add-word` | 모르는 단어를 그 DAY에 담고 즉시 보강 | D (best-effort) | 200 `added:true/false` + `enrichSkipped` · 400 `invalid_word` · 404 · **501 + `added:true`**(키 없어도 단어는 저장) | `lib/vocab-add-word-contract.ts` |
| `POST /api/english/vocab/[id]/suggest-related` | 한 뜻에 맞는 유의어/반의어 후보. 스토어 무변경 | H | 200 `{candidates}` · 400 · 404 · 501 · 500 `suggest_failed` | `lib/vocab-link-contract.ts` |
| `POST /api/english/vocab/[id]/add-related` | 고른 후보를 잇기 — 있으면 연결만, 없으면 추가 → 자동 보강 → 상호 연결 | D (best-effort) | 200 `{added, linked, enrichSkipped}`(키가 없어도 200, `enrichSkipped:"no_api_key"`) · 400 · 404 · 500 | `lib/vocab-link-contract.ts` |
| `POST·DELETE /api/english/vocab/[id]/link` | 인덱스 기반 연결·해제(대칭 기록) | 없음 | 200 · 400 · 404 · 500 — 현재 화면은 **DELETE(해제)만** 부른다. 연결은 add-related가 스토어로 직접 한다 | `lib/vocab-link-contract.ts` |
| `POST /api/english/vocab/[id]/quiz` | 시험 세션 1회 저장(완료·중단 시) | 없음 | 200 · 400 · 404 · 500 | `lib/vocab-quiz-contract.ts` |
| `POST /api/english/vocab/[id]/rename` | `titleKo`만 수정 | 없음 | 200 · 400 · 404 · 500 | `lib/vocab-rename-contract.ts` |
| `DELETE /api/english/vocab/[id]` | 단어장 1개 삭제 | 없음 | 200 · 404 · 403 `prod_guard` | 라우트 머리 주석 |
| `POST /api/english/vocab/reorder` | 목록 순서 저장 | 없음 | 200 `{count}` · 400 · 500 | `lib/reorder-contract.ts` |
| `POST /api/english/vocab/collected/add-word` | 챕터 리더에서 담은 단어를 "모은 단어" 단어장에 | **없음**(뜻은 화면이 호출 G로 이미 받았다) | 200 `added:true/false` · 400 · 500 `store_failed` | `lib/collected-vocab-contract.ts` |

단어장에서 지킬 것:

- **정의 불변(계획 §V3).** 시험이 저장된 정의에 매달리므로 안정성이 정확성보다 우선이다. 보강 경로 셋(enrich·add-word·add-related)은 모두 `enrichVocab` → `mergeEnrichment`(`lib/ai/english/vocabbook-enrich.ts`)를 거친다. `entriesToEnrich`가 이미 채운 단어를 요청에서 빼고(1차), `mergeEnrichment`가 null 자리에만 채운다(2차). 라우트에서 정의를 직접 손대지 마라 — 대상이 0개면 `enrichVocab`은 호출 없이 `[]`를 돌려준다.
- **단어 유실 금지.** add-word·add-related의 주목적은 단어를 담는 것이다. 보강이 실패하거나 키가 없어도 단어와 연결은 저장하고 `enrichSkipped`로 알린다. 반대로 suggest-related는 AI가 필수라 키가 없으면 501이다.
- **중복은 대소문자 무시 word 비교.** 1차는 라우트(호출 D 낭비 방지), 최종은 `store.appendVocabEntry`가 원자적으로 다시 본다. 둘 다 `added:false`로 알린다.
- **존재·렌더 판정은 한 함수.** 상세·보강·담기·rename·link·quiz가 모두 `isRenderableVocabBook`(`lib/vocabbook-record.ts`)으로 404를 가른다. 따로 판정하면 "목록엔 보이는데 눌렀더니 500"이 된다.
- **"모은 단어" 단어장은 앱에 하나다.** `dayLabel === COLLECTED_VOCAB_DAY_LABEL`("모은 단어", `lib/collected-vocab-contract.ts`)로 식별하고 rename에 불변이다. 없으면 첫 담기에서 만든다.
- 사진은 저장하지 않는다 — 병합된 `VocabEntry[]`만 `VocabBookRecord`로 남는다(§7-6). 이미지 없는 단어는 `resolveVocabImage`가 첫 글자 배지로 떨어뜨린다.
- 시험은 전부 클라이언트에서 돈다. 라우트는 끝·중단 시 1회 받아 `vocabQuizzes`에 append만 한다(수정·삭제 없음). 관계 문제(유의어·반의어)는 정의→단어와 다른 축이라 `mode:"relation"`(`VOCAB_QUIZ_MODES`, `lib/vocab-quiz.ts`) 세션으로 따로 쌓아 숙련도를 섞지 않는다 — 일본어가 같은 규약을 모드별로 확장했다.

## 4. AI 없는 영어 라우트

| 라우트 | 역할 | 상태코드 | 소비 화면 |
|---|---|---|---|
| `DELETE /api/books/[id]` | 책 삭제 + 그 책의 카드·읽음 기록 연쇄 삭제 | 200 `{deleted}` · 404 · 403 | `components/library-view.tsx` |
| `DELETE /api/cards/[id]` | 카드 **1장만** 삭제(보이는 단위 = 지우는 단위). **마지막 카드는 409 `last_card`**로 거부하고 책 삭제로 안내 | 200 · 404 · 409 · 403 | card-view |
| `POST·GET /api/readings` | "오늘 읽었어요" — 같은 책·같은 날짜는 중복 삽입 없이 기존 기록 반환(`duplicate:true`). 날짜는 클라이언트 로컬 날짜 | 200 · 400 · 404 | card-view |
| `POST /api/library/reorder` | 서재 순서 저장 | 200 · 400 · 500 | library-view |

삭제는 모두 `lib/prod-guard.ts`를 지난다(`deleteBook`·`deleteCard`·`deleteVocabBook`). 순서변경·rename은 수정이라 가드 대상이 아니다. 순서변경의 공통 골격은 `app-patterns.md`.

## 5. 경계면 규칙과 알려진 틈

- **클라이언트 번들 경계가 일본어보다 느슨하다.** 일부 클라이언트 컴포넌트가 `lib/ai/english/schemas`·`vocabbook-schemas`에서 **값**을 import한다(`chapter-reader.tsx`의 `WHOLE_TRANSCRIPT_TITLE`, `card-view.tsx`·`vocabbook-view.tsx`·`vocabbook-photo-flow.tsx`). client.ts가 아니라 키는 새지 않지만 zod 런타임이 번들에 들어간다. 이미 있는 것은 두되, 새 영어 화면 코드는 일본어 방식(계약 파일이 `export type`으로 재수출, 값은 서버 컴포넌트가 props로)을 따른다. `lib/ai/client.ts`는 어떤 클라이언트 파일에서도 import하지 않는다.
- **북카드 두 사진 라우트가 공유 상수를 다 쓰지 않는다.** 단어장·일본어 전사 라우트는 `lib/upload-limits.ts`의 `IMAGE_DATA_URL_PATTERN`을, 수학은 그 재수출 `MATH_IMAGE_DATA_URL_PATTERN`을 import하지만 북카드 쪽은 아니다.
  - `/api/pages`는 한 장 상한 `MAX_IMAGE_CHARS`(8,000,000)와 data URL 정규식을 **둘 다** 라우트에 직접 적었다.
  - `/api/extract`는 `COVER_MAX_IMAGES`·`MAX_IMAGE_DATA_URL_CHARS`는 import하지만 **정규식만** 인라인으로 적었다.
  - 값은 지금 공유 상수와 같다. 그래서 `IMAGE_DATA_URL_PATTERN`이나 한 장 상한만 고치면 이 두 라우트가 조용히 옛 값에 남는다. 형식·상한을 바꿀 때는 두 라우트도 함께 바꾸거나 import로 통일한다. `/api/pages`의 전체 본문 상한 `MAX_TOTAL_CHARS`(24MB, Cloud Run 요청 상한 32MiB 대비)는 이 라우트의 정책이다.
- **장면 메모 상한은 생산자와 소비자가 같은 상수를 본다.** `/api/card`의 입력 스키마가 `SCENE_LABEL_KO_MAX`·`SCENE_SUMMARY_KO_MAX`·`SCENE_ASK_KO_MAX`·`MAX_SCENE_DIGEST_ITEMS`를 `lib/ai/english/schemas.ts`에서 import한다. 숫자를 라우트에 적으면 `/api/pages`가 200으로 준 장면을 `/api/card`가 400으로 거부한다.
- **배치를 넘는 합계 초과는 `digestPages`가 자른다**(`truncatedSceneCount`). 소비자가 통째로 400을 내면 사용자가 A′ 비용을 치르고도 카드를 못 얻기 때문이다. 앞 배치가 실패하면 다음 장면에 `gapBefore:true`를 달아 호출 B가 빈 구간을 상상으로 메우지 않게 한다.
- 챕터 문장은 `groundChapters()`가 자막 부분문자열만 남긴다. `droppedSentenceCount`가 크면 프롬프트 이탈 신호다 — 가드를 느슨하게 할 신호가 아니다.

## 6. eval-english.ts 픽스처와 게이트

- **픽스처**는 2권(Wolves, Pooh Gets Stuck), 값은 `docs/SPEC.md` §12 그대로다(`prompt-eval/references/english-dials.md`의 픽스처 표와 같다). 임의 값으로 바꾸면 study-qa가 "픽스처가 §12 정의와 불일치"로 실패 판정한다. 답이 안 맞으면 프롬프트를 의심하지 픽스처를 의심하지 않는다.
- **오프라인 구간**(`EVAL_OFFLINE_ONLY=1`, 실호출 0): 호출 A′ 스키마 · 분량 다이얼 · 낭독 자막 계약 · 챕터화(§9) · 단어 뜻(§10) · 유의어 추천(§11) · 단어장(§7 병합·zod·그림 우선순위·보강 불변·복습 선택) · 프롬프트↔스펙 spec-sync. 영어 코드를 고치면 최소 이 구간은 통과시키고 끝낸다. 이 게이트는 `main`의 이른 return과 `globalThis.fetch` 차단 두 겹이다.
- **spec-sync 대상**은 `SPEC_SYNC_TARGETS`(eval-english.ts)에 상수 이름으로 등록돼 있다(A·A′·B·C·D·F·G·H의 시스템 프롬프트와 A·C·D의 사용자 텍스트, 11개). 새 프롬프트 상수를 만들면 여기에 추가한다.
- **spec-sync가 덮지 않는 것(알려진 틈).** 일본어 eval은 JSON Schema까지 스펙과 대조하지만 영어는 그렇지 않다. 아래를 고치면 eval이 통과해도 스펙과의 어긋남이 잡히지 않으므로, 스펙과 눈으로 diff하고 리포트에 남긴다.
  - **JSON Schema 8종**: `BOOK_EXTRACTION`·`PAGE_DIGEST`·`LEARNING_CARD`·`CHAPTERIZATION`·`WORD_MEANING`(`schemas.ts`), `VOCAB_EXTRACTION`·`VOCAB_ENRICHMENT`·`RELATED_SUGGESTION`(`vocabbook-schemas.ts`)의 `*_JSON_SCHEMA`. 어느 것도 english.md와 대조되지 않는다. `WORD_MEANING`·`RELATED_SUGGESTION`은 strict 모양(`required`·`additionalProperties:false`)만 스스로 점검한다.
  - **사용자 메시지 템플릿 5개**: A′ `buildPagesUserMessage`(§2A-2), B `buildCardUserMessage`(§3-2), F `buildChapterizeUserMessage`(§9-2), G `buildWordMeaningUserMessage`(§10-2), H `buildRelatedSuggestUserMessage`(§11-2). A′·B는 값을 보간해 원문 대조가 성립하지 않는다는 사유가 `SPEC_SYNC_TARGETS` 위 주석에 남아 있고, 그 다이얼은 `runStoryLengthDialChecks`가 값으로 본다. F·G·H 빌더는 주석에도 언급이 없이 빠져 있다.
- **실호출 구간**(오케스트레이터가 동의 후 실행): 기본은 카드 3회(Wolves / Pooh / Pooh+장면 메모), `EVAL_SKIP_PAGES=1`이면 2회, `EVAL_THIN_PAGES=1`은 3번째를 얇은 근거로 바꿀 뿐 횟수는 같다. 게이트 `EVAL_TRANSCRIPT=1`·`EVAL_CHAPTERS=1`·`EVAL_VOCAB=1`·`EVAL_WORDMEANING=1`은 **각각 1회만 돌고 return한다**(기본 3회를 대신한다). 호출 A·A′·C는 사진이 있어야 재현돼 실호출 구간이 없고, 호출 H도 없다(의미 판단이라 오케스트레이터가 별도 프로브).
- 실행: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:english` — 통과하면 "정의 동기화 통과"이지 "카드 품질 통과"가 아니다.

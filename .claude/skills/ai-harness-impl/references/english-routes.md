# 영어 — 호출 배선과 라우트 전체

> `ai-harness-impl` 스킬에서 영어(북카드·영어 단어장·챕터 리더·자유대화) 작업 시 읽는다. 일본어는 `japanese.md`, 공통 기능은 `app-patterns.md`.
> 원문 스펙: `docs/harness/english.md`(호출 A·A′·B·C·D·F·G·H·I·J + 하네스 밖 관문 R — E는 없다), 앱 흐름 `docs/SPEC.md` §3·§9·§14·§15·§21(자유대화)·§17-9(은우 스트릭에 대화 포함).
> 프롬프트 원문은 여기 옮기지 않는다. 스펙이 단일 정의처이고 `scripts/eval-english.ts`의 spec-sync가 대조한다.

목차: 1. 호출 → 진입 함수 · 2. 북카드 라우트(라우트 연결) · 3. 영어 단어장 라우트 · 4. AI 없는 영어 라우트 · 5. 경계면 규칙과 알려진 틈 · 6. eval-english.ts 픽스처와 게이트 · 7. 자유대화 — 관문 R·호출 I·라우트 전체

영어는 카드 한 장에서 시작해 기능이 네 줄기로 자랐다. 줄기마다 **실패의 무게가 다르다** — 카드 생성은 실패하면 저장하지 않고, 자막·챕터·단어 뜻은 실패해도 카드를 막지 않으며, 단어 담기는 뜻이 실패해도 단어를 잃지 않는다. 네 번째 줄기인 자유대화(2026-09-26)는 **대화가 모든 것에 앞선다** — 주제 일러스트·화면 카드(호출 J)·설명이 실패해도 대화는 계속되고, 저장할 때 그림이 걸리면 그림만 뺀다(§7). 라우트를 새로 만들거나 고칠 때는 먼저 그 라우트가 어느 무게에 속하는지 정한다.

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
| I 자유대화 문장 설명 | §12-3 | `explainTalkSentence({topicLabel, turns, turnIndex, sentenceIndex})` — client.ts. 문장은 함수 안에서 `pickTalkSentence`가 꺼낸다(범위 밖이면 호출 없이 throw) | `talk_explain` | `TALK_EXPLAIN_CALL_OPTIONS` (`talk-prompts.ts`) — 0.5 / 1,500 | `/api/english/talk/[id]/explain` |
| J 자유대화 화면 카드 | §12-7 | `generateTalkCards(input, {signal})` — client.ts. 반환은 **후처리(`sanitizeTalkScreenCards`)까지 끝난 값**. 호출 전체(재요청 포함) 6초 상한 `talkCardsAbortSignal` — 라우트의 `req.signal`과 합친다. SDK 자동 재시도는 0(`TALK_CARDS_SDK_MAX_RETRIES` → `callWithSchema`의 선택 인자 `maxRetries` → 순수 함수 `buildCallRequestOptions`가 요청 옵션으로 조립 — 0을 `!== undefined`로 판정) — SDK의 `retry-after` 대기는 신호를 보지 않아 켜 두면 상한이 뚫린다(QA talk-cards-j P3-A, 스텁 12초 실측). 선생님 말이 비면 호출 없이 빈 카드. 이 배선은 eval "자유대화 정적"이 소스로 잠그고(P2-A), 신호 합성의 운영 모양(외부 신호가 살아 있어도 상한이 끊는다 — P2-B)과 요청 옵션 조립(0이 빠지지 않는다 — P3-E)은 "자유대화 호출J"가 행동으로 잠근다 | `talk_cards` | `TALK_CARDS_CALL_OPTIONS`·`TALK_CARDS_TIMEOUT_MS` (`talk-prompts.ts`) — 0.3 / 600 / 6초, 모델 `resolveTalkCardsModel()`(env `OPENAI_TALK_CARDS_MODEL`, 빈 값이면 `DEFAULT_TALK_CARDS_MODEL` `gpt-6-luna` — client.ts) | `/api/english/talk/cards`(app-builder) |
| (관문 R 실시간 음성) | §12-1·§12-7 | **하네스 밖** — `callWithSchema`를 지나지 않는다. 세션 설정 조립 `buildTalkSessionConfig`(`lib/talk-session-config.ts`), 네트워크 `connectTalkCall`·`hangupTalkCall`(`lib/talk-gateway.ts`) | 로그 `[talk] connect/hangup`(상태·ms만) | 표 값은 english.md §12-1 | `/api/english/talk/connect`·`/hangup` |

- 파일: 카드 쪽은 `lib/ai/english/prompts.ts`·`schemas.ts`, 단어장 쪽은 `vocabbook-prompts.ts`·`vocabbook-schemas.ts`와 순수 함수 `vocabbook-merge.ts`(사진별 판독 병합 `mergeVocabPages`·구멍 찾기 `findMissingNumbers`)·`vocabbook-enrich.ts`(보강 대상 선별·정의 불변 병합). 자유대화는 `talk-prompts.ts`·`talk-schemas.ts`와 `lib/ai` 밖 순수 모듈 묶음(`lib/talk-*.ts`)이다(§7-1).
- 호출 옵션 상수가 두 곳에 산다(A·A′·B·F는 client.ts, C·D·G·H·I·J는 프롬프트 파일 — J의 모델 해석만 client.ts `resolveTalkCardsModel`). 지금 상태를 그대로 따르되, 새 호출은 뒤쪽 관용구(프롬프트 파일에 `{call, temperature, maxOutputTokens}`)를 쓴다. 숫자는 스펙 각 호출의 "호출 옵션" 절이 원본이다.
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
- **`/api/chapterize`** — 카드와 별개 경로라 실패가 비치명이다(책·카드는 손대지 않는다). 가능 여부는 `canChapterizeBook`(`lib/store.ts`, 자막이 비어 있지 않은가) 한 곳이 판정한다. 챕터 제목은 `sceneKind === "toc"`일 때 `sceneDigest`의 `labelKo`들을 **`prepareChapterTitles`(schemas.ts, 스펙 §9-2 "목차 제목 준비")로 다듬어** 넘긴다 — 서수 접두어("3장:"·"Chapter 3:" 등)를 떼고(번호는 챕터 리더 탭이 따로 붙인다), 완전 중복을 거르고, 떼고 나서 겹치면 " (n)"을 붙이고(접두어를 되살리지 않는다), 40개(`CHAPTERIZE_MAX_CHAPTERS`)를 넘으면 인접 제목을 순서대로 묶는다. 챕터 리더는 모든 레코드의 `titleEn`에 같은 정리(`cleanChapterTitles`)를 해서 표시한다 — 새 레코드엔 지울 접두어도 겹침도 없어 그대로고, 접두어가 남은 옛 레코드만 바뀐다. 그래서 준비한 제목이 이 정리의 고정점이어야 하고(eval 불변식 항목), 리더에서 제목마다 `stripChapterOrdinalPrefix`를 따로 부르면 겹침 " (n)"이 빠져 표시가 다시 겹친다. **해소(2026-09-25)**: 전에는 labelKo를 그대로 넘겨 목차 41개 이상인 책의 챕터화가 통째로 실패하고(A′는 120개까지 낸다), 탭에 번호가 두 번 떴다. labelKo를 이 함수 없이 F에 넘기지 마라. 목차가 없으면 빈 배열을 넘긴다 — `resolveChapterTitles`가 단일 "전체" 챕터(`WHOLE_TRANSCRIPT_TITLE`)로 바꾼다. 목차 없음은 실패가 아니다. 오류 구분은 `isChapterizeError`(400) / throw(500).
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
- **오프라인 구간**(`EVAL_OFFLINE_ONLY=1`, 실호출 0): 호출 A′ 스키마 · 분량 다이얼 · 낭독 자막 계약 · 챕터화(§9)·목차 제목 준비(§9-2) · 단어 뜻(§10) · 유의어 추천(§11) · 단어장(§7 병합·zod·그림 우선순위·보강 불변·복습 선택) · **자유대화 17묶음**(스펙 대조 54·지시문 35·세션설정 24·리듀서 28·문장 12·호출I 44·낭독 3·스트릭 6·카드 31·도움 55·장면 8·저장 본문 12·호출J 69·출처 14·정적 15·카드 요청 4·컨트롤러 36) · 프롬프트↔스펙 spec-sync 24. 2026-09-27 실측 **639항목**(자유대화 전 176 + 자유대화 463 — 오프라인 450 + spec-sync 13). 컨트롤러 정적 점검은 켜져 있다(`TALK_CONTROLLER_TOOL_PATH_REMOVED = true` — 출력 끝의 `NOTE — 보류`는 이제 나오지 않는다. 다시 나오면 도구 경로가 되살아난 것이다). "자유대화 컨트롤러"는 합성 이벤트 전송(`TalkCallOptions.createTransport` 주입점)과 가짜 시계(블록 안에서만 `Date.now`를 바꾸고 tick 타이머를 끈 채 `onTick`을 250ms 간격으로 부른다) 위에서 진짜 `TalkCallController`를 돌린다 — fetch 대역은 `/scene`·`/cards`만 받고 그 밖의 주소는 던지며, 끝나면 차단 fetch와 `Date.now`를 되돌린다. 영어 코드를 고치면 최소 이 구간은 통과시키고 끝낸다. 이 게이트는 `main`의 이른 return과 `globalThis.fetch` 차단 두 겹이다.
- **spec-sync 대상**은 `SPEC_SYNC_TARGETS`(eval-english.ts)에 상수 이름으로 등록돼 있다 — A·A′·B·C·D·F·G·H의 시스템 프롬프트와 A·C·D의 사용자 텍스트 11개(block 8 + inline 3)에, 자유대화 원문 13개(`TALK_TEACHER_INSTRUCTIONS`·`TALK_LESSON_TOPIC`·`TALK_LESSON_WORDS`·`TALK_GREETING_INSTRUCTIONS`·`TALK_WRAPUP_INSTRUCTIONS`·`TALK_EXPLAIN_SYSTEM_PROMPT`·`TALK_EXPLAIN_USER_TEMPLATE`·`TALK_TURN_RULES`·`TALK_CARDS_SYSTEM_PROMPT`·`TALK_CARDS_USER_TEMPLATE`·`TALK_NUDGE_NOTE`·`TALK_SCENE_NOTE`·`TALK_SCENE_IMAGE_PROMPT`)가 **`block-exact`** 모드로 더해져 24개다(2026-09-27 §12-7 — §12-6 `TALK_CARDS_INSTRUCTIONS`는 차례 규칙으로 대체돼 빠졌다). `block-exact`는 호출 B용 조립 규칙(3줄·40자 이상 블록을 떼어 맞추기)을 끄고 블록 하나와 통째로 같아야 통과한다 — 교사 지시문에 수업 블록을 이어 붙인 상수가 `block`에서는 통과해 버린 구멍(QA talk-ai P2-4)을 막으려고 `scripts/spec-sync.ts`에 추가한 모드다. 새 프롬프트 상수를 만들면 여기에 추가하고, 조립이 필요 없는 원문이면 `block-exact`를 쓴다.
- **자유대화는 JSON도 스펙과 대조한다.** `TALK_SENTENCE_EXPLANATION_JSON_SCHEMA`(§12-3)와 호출 J `TALK_SCREEN_CARDS_JSON_SCHEMA`(§12-7)는 스펙 JSON 블록과 **의미 동치**로 비교되고(required 순서까지 — §12-6 도구 정의 `TALK_TOOLS`는 세션에서 빠지며 지웠다), 세션 설정 표·zod 폭·카드 폭·5초/12초·30장/6장·기본 문구·장면 표·도움 요청 연속 상한·호출 J 옵션·6초·zod 개수·후처리 폭·입력 개수·"세션 설정 도구 없음"·출처 값은 스펙 **산문 문장을 needle로** 읽어 코드 상수와 맞춘다("자유대화 ↔ 스펙" 54항목 — §12-6 이어 말하기 상한·호출 결과 글 needle은 2026-09-27 상수와 함께 지웠다). 그래서 english.md §12의 숫자 문장을 문서만 고쳐도, 코드 상수만 고쳐도 eval이 FAIL한다 — 둘을 같이 바꾼다.
- **spec-sync가 덮지 않는 것(알려진 틈).** 일본어 eval은 JSON Schema까지 스펙과 대조하지만 영어는 자유대화 두 JSON을 뺀 나머지가 그렇지 않다. 아래를 고치면 eval이 통과해도 스펙과의 어긋남이 잡히지 않으므로, 스펙과 눈으로 diff하고 리포트에 남긴다.
  - **JSON Schema 8종**: `BOOK_EXTRACTION`·`PAGE_DIGEST`·`LEARNING_CARD`·`CHAPTERIZATION`·`WORD_MEANING`(`schemas.ts`), `VOCAB_EXTRACTION`·`VOCAB_ENRICHMENT`·`RELATED_SUGGESTION`(`vocabbook-schemas.ts`)의 `*_JSON_SCHEMA`. 어느 것도 english.md와 대조되지 않는다. `WORD_MEANING`·`RELATED_SUGGESTION`은 strict 모양(`required`·`additionalProperties:false`)만 스스로 점검한다.
  - **사용자 메시지 템플릿 5개**: A′ `buildPagesUserMessage`(§2A-2), B `buildCardUserMessage`(§3-2), F `buildChapterizeUserMessage`(§9-2), G `buildWordMeaningUserMessage`(§10-2), H `buildRelatedSuggestUserMessage`(§11-2). A′·B는 값을 보간해 원문 대조가 성립하지 않는다는 사유가 `SPEC_SYNC_TARGETS` 위 주석에 남아 있고, 그 다이얼은 `runStoryLengthDialChecks`가 값으로 본다. F·G·H 빌더는 주석에도 언급이 없이 빠져 있다.
- **실호출 구간**(오케스트레이터가 동의 후 실행): 기본은 카드 3회(Wolves / Pooh / Pooh+장면 메모), `EVAL_SKIP_PAGES=1`이면 2회, `EVAL_THIN_PAGES=1`은 3번째를 얇은 근거로 바꿀 뿐 횟수는 같다. 게이트 `EVAL_TRANSCRIPT=1`·`EVAL_CHAPTERS=1`·`EVAL_VOCAB=1`·`EVAL_WORDMEANING=1`은 **각각 1회만 돌고 return한다**(기본 3회를 대신한다). 다섯 번째 게이트 **`EVAL_TALK=1`은 호출 I 2회**(지어낸 대화의 선생님 문장 1 · 은우 문장 1, 재요청까지 최악 4요청)이고, 확인 순서는 TRANSCRIPT → CHAPTERS → VOCAB → WORDMEANING → TALK다(처음 켜진 하나만). 호출 A·A′·C는 사진이 있어야 재현돼 실호출 구간이 없고, 호출 H도 없다(의미 판단이라 오케스트레이터가 별도 프로브). **관문 R(실시간 음성)은 eval에 실호출 구간이 없다** — 선생님 말투·길이·차례 규칙 준수(§12-7 "한 차례를 한 번에")는 사용자 동의 뒤 실연결·실기기로만 본다. **호출 J도 스펙에 실호출 게이트가 없다** — 카드 품질·지연은 실연결에서 본다(오프라인은 조립·zod·후처리·도착 판정까지, 진입 함수 `generateTalkCards`의 배선은 "자유대화 정적"이 소스로 잠근다 — 오프라인 게이트가 fetch를 막아 태울 수 없다).
- 실행: `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:english` — 통과하면 "정의 동기화 통과"이지 "카드 품질 통과"가 아니다.

## 7. 자유대화 — 관문 R·호출 I·라우트 전체

은우(초등 1학년)가 AI 전화영어 선생님 Sunny와 5분 안쪽으로 영어로 이야기하는 기능이다(스펙 `docs/harness/english.md` §12, 제품 흐름·비용·실기기 `docs/SPEC.md` §21). 두 부분이 성격이 전혀 다르다. **관문 R**(OpenAI Realtime, 음성 ↔ 음성)은 Structured Outputs가 아닌 **하네스 밖 관문**이라 `callWithSchema`·zod·재요청을 지나지 않고 키 규약만 공유한다(`lib/tts.ts`·토익 관문 P/T와 같은 부류). **호출 I**(끝난 대화의 문장 설명)와 **호출 J**(대화 중 선생님 줄마다 화면 카드, 2026-09-27 §12-7 — §12-6의 도구 호출 방식을 대체)는 하네스 안이다. 그래서 선생님이 실제로 무엇을 말하는지는 eval이 잴 수 없고(사용자 동의 뒤 실연결·실기기로만 본다), eval이 잠그는 것은 원문·세션 설정(도구 없음)·리듀서(출처 태깅)·카드 후처리·도착 판정·상태 기계·호출 I·J zod, 그리고 합성 이벤트 전송 위에서 돌리는 실시간 컨트롤러(앱이 언제 `response.create`·카드 요청을 보내는가 — 2026-09-27)까지다.

### 7-1. 파일과 소유 — 누가 무엇을 고치나

| 담당 | 파일 | 성격 |
|---|---|---|
| ai-engineer | `lib/ai/english/talk-prompts.ts` | §12 원문 상수 13개(교사 지시문·수업 블록 2·인사·마무리·**차례 규칙 `TALK_TURN_RULES`**·도움 요청·일러스트 안내·사진 프롬프트·호출 I 프롬프트·사용자 템플릿·**호출 J 프롬프트·사용자 템플릿**) + `TALK_EXPLAIN_CALL_OPTIONS`·`TALK_CARDS_CALL_OPTIONS`·`TALK_CARDS_TIMEOUT_MS`·`TALK_CARDS_SDK_MAX_RETRIES`(0) + 한 번 훑기 치환 빌더(`buildTalkCardsUserMessage` 포함). 런타임 import는 클라이언트 안전 `lib/talk-cards.ts`의 입력 폭 하나뿐 |
| ai-engineer | `lib/ai/english/talk-schemas.ts` | `TALK_SENTENCE_EXPLANATION_JSON_SCHEMA`·`buildTalkExplainZod`·**`TALK_SCREEN_CARDS_JSON_SCHEMA`·`talkScreenCardsSchema`·`TALK_SCREEN_CARDS_ZOD_LIMITS`·`TalkCardsInput`**·**`TALK_TURN_ORIGINS`·`talkSaveTurnSchema`**·`TALK_LIMITS`·`TALK_EXPLAIN_LIMITS`(§12-6 `TALK_TOOLS`·`TALK_TOOL_CHOICE`는 2026-09-27 삭제). zod 런타임이라 서버·eval 전용(화면은 `import type`만) |
| ai-engineer | `lib/talk-topics.ts`·`lib/talk-transcript.ts`·`lib/talk-cards.ts`·`lib/talk-hints.ts`·`lib/talk-explain-script.ts`·`lib/talk-streak.ts` | **클라이언트 안전 순수 모듈** — 프리셋 10·30자·빠르기·5분 / 이벤트 → 스크립트 리듀서(선생님 줄 **출처 태깅** `requestTalkResponseOrigin`)·문장 나누기·숨은 항목 이벤트 빌더 / **호출 J 후처리 `sanitizeTalkScreenCards`·입력 폭 `TALK_CARDS_REQUEST_LIMITS`·요청 본문 `buildTalkCardsRequest`·앱 도우미 `pickTalkCardsContext`·`pickTalkCardsShown`·`decideTalkCardsArrival`**·카드 정리·✓ 매칭(§12-6 도구 검사 함수들은 2026-09-27 지웠다) / 말문 막힘 도움 상태 기계(선생님 재개 시 앞 줄 도움 버림·`nudge_withheld`) / 설명 대본 → `speakQueue` 조각 / 대화 → 스트릭 세션. 번들 입력에 zod·openai 0(esbuild로 확인하는 것이 QA 관용구) |
| ai-engineer | `lib/talk-session-config.ts` | **서버 전용** — 입력 정리 → `TalkTopic` 스냅샷, 지시문 조립, 세션 설정, env 해석, callId 파싱, 장면 문장 `buildTalkSceneEn`. 네트워크 호출 없음 |
| ai-engineer | `lib/ai/client.ts` `explainTalkSentence`·`generateTalkCards`·`resolveTalkCardsModel`·`talkCardsAbortSignal`·`buildCallRequestOptions`(+ `callWithSchema`의 선택 인자 `signal`·`maxRetries`) · `scripts/eval-english.ts` 자유대화 절 · `scripts/spec-sync.ts` `block-exact` | 진입 함수는 `callWithSchema`만 부른다(과목 분기 없음). `signal`·`maxRetries`는 일반 인자 — 둘 다 안 넘기면 요청 옵션 없이 기존 동작(`buildCallRequestOptions` → `undefined`) |
| app-builder | `lib/talk-realtime.ts` · `lib/talk-fake-transport.ts`(개발 전용) | 대화 한 번의 컨트롤러(`TalkCallController` — `useSyncExternalStore`용 스냅숏), WebRTC 전송, 5분 상한·마무리·도움 요청·**호출 J 요청·도착 배선과 출처 청**(§7-5)·**은우 차례 가드**(§7-4), 끝내기(`end` — 멱등). §12-6 도구 처리 배선은 2026-09-27 걷어 냈다 — 가짜 전송도 도구 호출을 내지 않고 카드 흉내 `setCards`와 선택 메서드 `TalkTransport.fetchCards`만 둔다 |
| app-builder | `lib/talk-gateway.ts` · `lib/talk-topic-request.ts` | 관문 R 네트워크(연결·hangup — 결과 값, 던지지 않음) / connect·scene 공용 주제 해석 zod |
| app-builder | `lib/talk-contract.ts` · `lib/talk-record.ts` · `lib/talk-normalize.ts` | 계약(런타임 import 0 — 상수·주소 함수·저장 본문 계획까지) / 렌더 판정 `isRenderableTalkSession`·기본 제목·목록 행 / 정규화·설명 append 판정 `decideTalkExplanation` |
| app-builder | `lib/talk-image.ts` + `lib/image-gen.ts` · `lib/mic-session.ts` `acquireMicStream` | 주제 일러스트(사진 공용 코어 — 토익 관문 P와 공유) / 대화 내내 열린 마이크(app-patterns §16) |
| app-builder | 스토어 `talkSessions`·`talkImages`, `lib/prod-guard.ts` `deleteTalkSession`, `app/api/english/talk/**` 10개(§12-7 `cards` 포함), `app/english/talk/page.tsx`·`[id]/page.tsx`, `components/talk-*.tsx`, `/api/streak` 은우 트랙, `scripts/eval-streak.ts` 자유대화 절 | 화면·라우트·저장·스트릭 |

**클라이언트 번들 경계 — 프롬프트 원문은 폰에 내려가지 않는다.** `talk-prompts.ts`는 런타임 import가 0이라 화면이 import해도 zod는 안 새지만, 원문 상수를 값으로 쓰면 원문 자체가 번들에 들어간다. 그래서 화면이 선생님에게 넣어야 하는 글(첫 인사·마무리·도움 요청)은 서버 컴포넌트(`app/english/talk/page.tsx`)가 `TalkAppNotes` props로 내리고, 일러스트 안내는 장면 라우트가 조립해 `note`로 준다. 교사 지시문·차례 규칙·수업 블록·사진 프롬프트·호출 I·J 프롬프트는 서버에만 있다(빌드 산출물 grep 0건이 QA 기준 — study-qa `english.md` §8-6).

### 7-2. 관문 R — 서버가 잇고, 미디어는 직통

1. 📞 탭 → 브라우저가 `RTCPeerConnection` offer를 만든다 → `POST /api/english/talk/connect {sdp, topic, speed}`.
2. 서버: zod(400) → **키 검사(501 — 스토어·OpenAI보다 먼저)** → 주제 해석 `resolveTalkTopicRequest`(단어장은 `getVocabBook` + `isRenderableVocabBook` → 404) → `buildTalkSessionConfig({topic, speed})` → `connectTalkCall`: `POST {OPENAI_BASE_URL || https://api.openai.com/v1}/realtime/calls`에 multipart `sdp` + `session`(JSON), `Authorization: Bearer <서버 키>`. SDK 7.4.0에 WebRTC 통화 생성이 없어 fetch로 직접 부른다.
3. 응답 본문 = answer SDP(`v=0`으로 시작하지 않으면 실패), `Location` 마지막 조각 = callId(`isTalkCallId` — `[A-Za-z0-9_-]{1,200}`만, 경로 조작 차단). 브라우저에는 `{sdp, callId, topic, model, voice}`만 간다. Location을 못 읽으면 `callId:null`로 연결은 살리고(서버 hangup만 빠진다) 경고 로그를 남긴다.
4. 그 뒤 음성과 JSON 이벤트는 **브라우저 ↔ OpenAI 직통**이다 — 원격 트랙은 `<audio autoplay playsinline>`, 이벤트는 데이터 채널 `oai-events`.
5. 끝낼 때(끝내기·5분·숨김·뒤로가기·끊김) 컨트롤러가 채널·피어 close → 마이크 release → `POST /api/english/talk/hangup`을 `navigator.sendBeacon`(text/plain, 실패하면 fetch keepalive)으로 — 탭이 닫혀도 가는 과금 이중 안전장치다. hangup 라우트는 content-type에 기대지 않고 본문 글자를 JSON으로 읽고(2,000자 상한), 상류 실패도 200 `{hungUp:false}`다.

- **키 노출 0 원칙.** 키는 서버 env에만 있다. 임시 클라이언트 키(ephemeral secret)를 브라우저에 주는 방식을 쓰지 않고 통합 인터페이스로 서버가 대신 잇는다. 지시문·세션 설정도 서버가 조립한다 — 클라이언트가 보내는 것은 프리셋 키·직접 입력 글자·단어장 id·빠르기뿐이다. connect 응답에 `instructions`가 없고 `cache-control: no-store`다. 로그에는 SDP·지시문·전사를 남기지 않는다(모델·상태·ms만). 사용량은 서버 로그 대신 응답마다 오는 `response.done.usage`를 컨트롤러가 누적해 결과 패널 "진단"에 보인다(폰에서 비용을 가늠하는 유일한 창).
- **60초 요청 상한과 무관하다(미디어 직통).** 프로덕션의 60초 상한(app-patterns §15)은 우리 서버를 지나는 HTTP 요청 하나에 걸린다. 대화는 최대 5분이지만 음성이 우리 서버를 지나지 않으므로 상한에 걸리지 않는다. 우리 서버를 지나는 것은 SDP 교환(서버 `TALK_CONNECT_TIMEOUT_MS` 20초 + `req.signal`, 클라이언트 `TALK_CONNECT_CLIENT_TIMEOUT_MS` 25초)·hangup(`TALK_HANGUP_TIMEOUT_MS` 8초)·주제 일러스트(`SCENE_TIMEOUT_MS` 55초 + `req.signal`)·저장·설명뿐이고 전부 한 요청 한 단위다. 그 대신 **5분 상한은 서버가 아니라 컨트롤러가 센다**(`TALK_MAX_DURATION_SEC` 300 → 선생님이 말하는 중이면 최대 `TALK_WRAPUP_WAIT_MS` 8초 기다려 마무리 안내 → 그 응답의 소리가 멈추거나 `TALK_WRAPUP_END_MS` 25초에 종료). 화면이 사라진 채 컨트롤러가 살아 있으면 과금이 이어진다 — 그래서 언마운트 정리가 P1이었다(app-patterns §16).
- **세션 설정**(원본은 english.md §12-1 표): `const config: RealtimeSessionCreateRequest` 리터럴로 조립해 GA 필드 이름을 tsc가 검사하게 한다(베타 이벤트 이름·필드 오타를 음성 대조군으로 거부시킨 것이 QA 관용구). env 3종 `OPENAI_REALTIME_MODEL`·`OPENAI_REALTIME_VOICE`·`OPENAI_REALTIME_TRANSCRIBE_MODEL`은 `?.trim() ||` 기본값(`gpt-realtime-2.1`·`marin`·`gpt-4o-mini-transcribe`). `reasoning.effort:"low"`는 `supportsRealtimeReasoning(model)`일 때만 싣는다(env로 비추론 모델을 쓰면 연결이 거부될 수 있어서). **전사 설정은 `{model, language: "en"}` 둘뿐** — 영어 고정(`TALK_TRANSCRIBE_LANGUAGE`, 2026-09-27 — 자동 감지가 짧은 아이 영어를 다른 언어로 적었다. 한국어로 말하면 영어 글자로 적히지만 선생님은 음성을 직접 들어 대화에는 영향 없음), `prompt`·`keywords`는 없다(단어장 단어를 주면 하지 않은 말이 맞게 적힌다 — 토익 관문 T와 같은 원칙, eval이 키 목록으로 잠근다). 지시문 = `TALK_TEACHER_INSTRUCTIONS`(`{lesson}` 한 자리) + `"\n\n"` + `TALK_TURN_RULES`(§12-7 차례 규칙 — 한 차례를 한 번에, 질문으로 끝낸다). **`tools`·`tool_choice`는 싣지 않는다**(2026-09-27 — 도구 호출로 응답이 끊기면 "질문 없는 도구 응답 → 이어 말하기"가 새 응답을 만들어 선생님이 두 명처럼 답했다. 화면 카드는 호출 J). 표에 없는 키(`tracing`·`truncation`·`include`·`tools`·`tool_choice`)는 싣지 않는다 — eval이 최상위 키 목록과 부재를 본다.
- **입력 정리는 지시문 주입 방어다.** 직접 입력은 줄바꿈·제어문자·곧은/굽은 따옴표·`#`·`＃`·백틱·zero-width를 걷어 한 줄로 만들고, 코드 포인트 1~30자를 넘으면 **자르지 않고 null**(400 — 조용히 잘린 주제가 저장되지 않게). 단어장은 서버가 id로 읽어 책 순서로 최대 20개(대소문자 무시 중복·빈 단어 건너뜀, 뜻은 `meanings[0].ko` → `definitionKo` → 없음). 아이 이름은 지시문에도 호출 I에도 넣지 않는다(화면의 "은우" 라벨은 로컬 표시일 뿐).

### 7-3. 라우트 전체 (`app/api/english/talk/**`, 전부 `runtime = "nodejs"`, 계약 `lib/talk-contract.ts`)

| 라우트 | 역할 | AI·관문 | 상태코드 |
|---|---|---|---|
| `POST /connect` | SDP offer + 주제 + 빠르기 → 통화 | 관문 R | 200 `{ok, sdp, callId\|null, topic, model, voice}` · 400 `invalid_input`(모르는 프리셋·31자·정리 뒤 빈 글자·모르는 빠르기) · 404 `vocab_not_found` · 501 `no_api_key` · 500 `connect_failed`(상류 실패·SDP 아닌 answer) |
| `POST /scene` | 주제 → 장면 문장 → 주제 일러스트 1장. **저장하지 않는다** | 사진 코어 | 200 `{ok, dataUrl, sceneEn, note, model}` · 400 · 404 · 501 · 500 `image_failed` — 화면은 칸을 숨기고 대화는 계속 |
| `POST /hangup` | 서버 hangup(sendBeacon 본문) | 관문 R | 200 `{ok, hungUp}` · 400 · 501 |
| `POST /cards`(§12-7) | 선생님 줄 하나 → 화면 카드(도움 답 예시·핵심 단어·그림 카드). **저장하지 않는다**. 본문 `{topic(주제 라벨 문자열), words, shown, context, teacherLine}` | 호출 J | 200 `{ok, answers, words, picture}`(= `generateTalkCards` 반환 그대로 — 이미 후처리됨) · 400 `invalid_input`(JSON·글자 상한 zod — 폭은 `TALK_CARDS_REQUEST_LIMITS`를 import, 넘으면 자르지 않고 거부. **키 검사보다 먼저**) · 501 `no_api_key` · 500 `cards_failed`(실패·6초 초과·요청 취소·상류 429/5xx — `retriable` 없음, 화면은 기본 문구·그림 없음). 전부 `no-store`, 로그는 실패 종류·ms만 |
| `POST /api/english/talk` | 대화 저장(은우 발화 ≥ 1) + 그림 | 없음(키 검사 없음) | 200 `{ok, id, childTurnCount, sceneSaved, trimmed}` — 같은 `clientSessionId`면 같은 id의 200 · 400 `invalid_input`·`no_child_turn` · 500 `save_failed` |
| `POST /[id]/explain` | 문장 설명 | 호출 I | 200 `{ok, explanation, cached, saved}` · 400 `invalid_input`·`sentence_not_found`(과금 전) · 404 `talk_not_found` · 501(저장된 설명이 없을 때만) · 500 `explain_failed` |
| `POST /[id]/rename` | 이름(`TALK_TITLE_MAX_CHARS` 60) | 없음 | 200 · 400 · 404 · 500 |
| `DELETE /[id]` | 대화 + 그림 연쇄(그림 먼저, 대화 마지막) | 없음 | 200 · 404 · 403 `prod_guard` · 500 `delete_failed` |
| `POST /reorder` | 지난 대화 순서(범용 `reorderRequestSchema`) | 없음 | 200 `{count}` · 400 · 500 |
| `GET /images/[id]` | 그림 바이트 | 없음 | 200 image/jpeg `cache-control: private, max-age=31536000, immutable` · 404 `image_not_found`(id 모양 검사 먼저 — `x.png`류는 스토어를 읽지 않는다. 확장자를 붙이면 PIN 게이트 정적 예외를 탄다) · 500 `image_unreadable` |

502는 쓰지 않는다(스펙이 실패를 500으로 정했다). 페이지 둘(`/english/talk`·`/english/talk/[id]`)은 `force-dynamic`이고, 지난 대화를 못 읽어도 시작 화면은 빈 목록으로 뜬다.

### 7-4. 앱이 선생님에게 넣는 안내 — 숨은 system 메시지 + 인자 없는 `response.create`

- 첫 인사(`app_greet`, 채널이 열리면)·마무리(`app_wrapup`, 5분)·도움 요청(`app_nudge_N`, 12초·🙋 — 선생님 차례 하나에 한 번, 은우가 말하기 전까지 **연속 2번**(`TALK_HINT_NUDGE_STREAK_MAX`, 🙋 합산), 상한이면 카드만 띄우고 요청은 보내지 않는다 — english.md §12-6)은 `buildTalkSystemNoteEvent(id, text)`(`conversation.item.create`, role system) → `buildTalkResponseCreateEvent()`(`{type:"response.create"}` — 키가 `type` 하나). 주제 일러스트 안내(`app_scene`)는 system 메시지**만** 넣고 response.create는 보내지 않는다(선생님이 다음 차례에 자연스럽게 쓴다).
- **응답 단위 `instructions`를 쓰지 않는다.** response.create의 `instructions`는 세션 지시문을 **덮어써** 그 응답에서 선생님 성격·안전 규칙이 빠진다. 처음 설계가 이 방식이었다가 2026-09-26 §12-1에서 정정됐다. 앱이 넣는 안내는 전부 system 메시지 방식이다. 클라이언트 모듈에서 `instructions`가 나오는 곳은 0이어야 하고, 코드 전체에서도 `talk-session-config.ts`의 세션 설정 한 곳뿐이어야 한다.
- 숨은 항목 id는 `app_` + `[A-Za-z0-9_-]{1,28}`(32자 이하, 빌더가 형식을 어기면 던진다). 리듀서는 `app_` 항목과 도구 호출 항목을 줄로 만들지 않고 연결만 이어 준다.
- **출처(§12-7)**: response.create를 보내는 곳은 컨트롤러의 `sendResponseCreate(origin)` 한 곳이고, 보내기 **직전에** `requestTalkResponseOrigin(transcript, "greeting"|"nudge"|"wrapup")`로 청을 적는다 — 다음 `response.created`가 그 출처를 소비하고, 청 없는 created(은우 발화 뒤 자동 응답)는 `reply`다. 우리 create가 5초 안에 created를 못 받아 거부로 볼 때는 `requestTalkResponseOrigin(transcript, null)`로 청을 거둔다(다음 자동 응답이 잘못 태깅되지 않게). 줄의 출처는 `TalkLine.origin` → `toTalkTurns`가 저장 턴에 싣는다(선생님 = 출처, 모르면 reply, 은우 = null). 대화 보기는 `?debug=1`일 때만 칩으로 보인다.
- **응답이 진행 중이면 response.create를 보내지 않는다**(SDK: 한 번에 한 응답만 대화에 쓴다). `response.created` → 진행 중, `response.done` → 끝으로 따라간다. 진행 중에 생긴 도움 요청은 보류했다가 그 응답이 **오디오 없이** 끝나면 보내고, 오디오가 있었으면(새 선생님 차례) 버리고, 은우가 말을 시작하면 버린다. 우리가 보낸 create에 `response.created`가 5초 안에 오지 않으면 거부된 것으로 본다. 마무리는 진행 중 응답이 끝나기를 기다리고(오래 끌면 `response.cancel` 뒤) 보낸다.
- **은우 차례에도 보내지 않는다**(2026-09-27 — QA talk-cards-j full_1 P2-A). 은우가 말하는 중(`speech_started`~`speech_stopped`)이거나 막 말을 마쳐 서버 자동 응답을 기다리는 틈(`TALK_AUTO_REPLY_WAIT_MS` 1,500ms — `speech_stopped`에 시각을 적고 `speech_started`·`response.created`에서 비운다, 배율을 곱하지 않는 벽시계 값)이면 `childTurnOpen(now)`이 참이다. 판정은 두 겹이다 — 도움 상태 기계가 은우 말하는 중 🙋를 카드만으로 처리하는 것이 첫째 겹, 컨트롤러 `requestNudge()` 첫 줄의 `childTurnOpen` 가드(🙋·12초·보류 해제가 모두 지난다)가 둘째 겹이고, `onResponseDone`의 보류 해제도 같은 판정을 한 번 더 본다. 마무리는 선생님과 같은 8초 시계(기준은 상한에 닿은 시각) 안에서 은우 말이 끝나고 자동 응답이 끝나기를 기다린다 — 조건은 `teacherDone && childDone && !autoReplyPending && !responseActive`. 새 `response.create` 경로를 만들면 이 가드를 지나게 하라 — 그렇지 않으면 은우 말 위로 선생님 응답이 하나 더 나가 "선생님 두 명"이 된다.
- **셈은 보낸 요청이다**(2026-09-27 — QA full_2 P3-A). 도움 상태 기계는 요청 신호(`shouldNudge`)를 내는 순간 셈에 넣으므로, 컨트롤러가 그 신호를 보내지 않고 버리는 모든 곳(은우 차례로 버림·`speech_started`의 보류 버림·소리 있는 응답으로 보류 버림·보류 합치기)에서 `withholdNudge()`/`dropPendingNudge()`로 리듀서에 `nudge_withheld`를 넣어 셈을 되돌린다(불변식: 셈 = 은우가 마지막으로 말을 시작한 뒤 보낸 요청 + 보류 1). 끝내기 기다림(`phase !== "live"`)·마무리 시작에서는 되돌리지 않는다(셈이 더 쓰이지 않는다). 보내지 않고 버리는 새 경로를 만들면 반드시 되돌린다 — 안 그러면 "연속 2번"이 1번이 되고, 자동 응답이 끝내 오지 않는 차례에는 12초 요청이 영영 나가지 않는다.
- **끝내기 전 전사 기다림**(`finish` — 끝내기 버튼·5분 마무리 뒤 종료만, english.md §12-1): 아직 전사 중인 은우 줄이 있으면 최대 `TALK_FINISH_TRANSCRIPT_WAIT_MS` 2.5초(배율 없는 벽시계) 기다렸다 `end()`한다. 그동안 보내는 것은 안내가 아니라 세션 조작 넷이다 — `session.update {audio.input.turn_detection: null}`(부분 갱신), 은우가 말하는 중일 때만 `input_audio_buffer.commit`, 진행 중 응답이면 `response.cancel`, 선생님 소리가 나면 `output_audio_buffer.clear`(모두 SDK GA 타입에 `satisfies`). 늦게 시작된 응답은 `response.created`에서 다시 취소한다. 숨김·언마운트·pagehide·끊김은 `end()`를 바로 불러 기다리지 않는다 — 과금 중지가 먼저다. 새 종료 경로를 만들면 "기다려도 되는 사용자 종료"인지 "즉시 닫아야 하는 이탈"인지부터 가른다.

### 7-5. 화면 카드 — 호출 J (english.md §12-7, 2026-09-27 — §12-6 도구 호출 방식 대체)

**왜 바꿨나.** §12-6은 선생님(Realtime 모델)이 도구 호출로 카드를 보냈다. 모델이 질문 없는 연결 멘트를 하고 도구를 부르면 Realtime은 응답을 거기서 끝내고, 질문 누락을 막으려던 "질문 없는 도구 응답 → 이어 말하기"가 **새 응답**을 만들어 은우 말에 처음부터 다시 답했다 — 보호자 iPhone에서 "선생님이 두 명처럼" 들렸다. 지시문("말을 다 한 뒤 도구")은 확률적으로만 지켜진다. 그래서 음성 모델에서 도구를 없애고(§7-2 세션 설정), 선생님은 한 차례를 한 번에 말하며(차례 규칙), 카드는 앱이 선생님 줄마다 따로 만든다.

- **요청**(컨트롤러): 선생님 줄마다 한 번 — 그 줄 글자가 `response.output_audio_transcript.done`으로 확정되고 `response.done`이 completed일 때(**순서 무관** — `.done`이 늦으면 `completedResponses`에 적어 두었다가 `.done`에서 청한다. cancelled·incomplete 응답과 글자가 빈 줄에는 청하지 않고, `cardsRequested`로 줄마다 한 번). 본문은 `buildTalkCardsRequest` 한 곳이 만든다 — `{topic(라벨), words(단어장 스냅샷 {en, ko}), shown: pickTalkCardsShown(보인 그림 카드), context: pickTalkCardsContext(lines, 그 줄 itemId), teacherLine}`을 라우트 zod와 같은 폭으로 미리 자른다(UTF-16, 서로게이트 쌍을 가르지 않는다 — 은우의 긴 전사 한 줄이 정상 경로에서 400을 내던 것을 막았다). 앞선 카드 요청이 진행 중이면 `AbortController`로 끊고 새로(최신 줄만, 셈 `superseded`). 마무리·끝내기 기다림·끝내기(숨김·뒤로가기 포함)가 시작되면 진행 중 요청도 끊는다(`abortCards`). 클라이언트 상한 `TALK_CARDS_CLIENT_TIMEOUT_MS` 9초(배율 없음 — 서버 6초가 먼저 끊으므로 연결이 멈춘 경우의 방어선, 9초에 끊기면 실패로 센다).
- **서버**: 라우트 zod(폭 `TALK_CARDS_REQUEST_LIMITS` — 단어 20·보인 카드 12·문맥 4줄·줄 1,000자·라벨 200자를 **import**, 숫자를 다시 적지 않는다) → 키 검사 501 → `generateTalkCards(input, {signal: req.signal})` → 200 그대로. 6초 상한·후처리는 함수 안이다(라우트가 다시 할 일이 없다). `input.topicLabel`은 호출 I와 같은 `TalkTopic.labelKo`. 진입 함수는 `callWithSchema`에 `signal: talkCardsAbortSignal(options.signal)`(6초 `AbortSignal.timeout`과 요청 취소를 `AbortSignal.any`로 — 외부 신호가 살아 있어도 6초가 끊는다. SDK 요청 단위 `timeout`은 시도마다 다시 재서 "호출 전체 6초"가 안 된다)·`maxRetries: TALK_CARDS_SDK_MAX_RETRIES`(0 — SDK가 429·503의 `retry-after`를 신호 없이 기다려 6초가 12초로 뚫렸다)·`model: resolveTalkCardsModel()`을 넘기고, 빈 선생님 말이면 부르기 전에 빈 카드를 돌려준다. 이 배선은 eval "자유대화 정적"이 소스로 잠근다 — 한 줄이라도 지우면 FAIL이어야 한다.
- **도착**(컨트롤러): 먼저 같은 `sanitizeTalkScreenCards`로 한 번 더 거른다(멱등 — 스텁·배포 과도기의 옛 서버 대비). 그다음 `decideTalkCardsArrival({cards, lines, teacherItemId, live})` 한 곳 — `hints`가 있으면 도움 상태 기계에 `hints_received`, `picture`가 있으면 그림 카드(✓ 매칭·칩 6·기록 30 기존 규칙). 그 줄 뒤에 **어떤 줄이든**(은우의 듣는 중 줄·선생님의 새 줄) 이미 있거나 그 줄을 못 찾으면 **도움만 버리고 그림은 띄운다**(철 지난 도움, 셈 `staleHints`), 대화 중(live)이 아니면 둘 다 버린다. 실패·501·시간 초과는 아무것도 하지 않는다 — 도움 카드는 기본 문구(`TALK_FALLBACK_HINTS`), 그림 카드는 없음(셈 `failed`). 선생님 소리가 다시 시작되면 상태 기계가 앞 줄의 도움을 늘 버린다(§12-7 P3-C — `teacher_audio_started` → `hints: null`, `epoch`는 지웠다).
- **진단 셈**: 스냅숏 `cards: TalkCardsStats`(보냄·받음·실패·새 줄로 끊음·철 지난 도움)가 결과 패널 "진단"에 한 줄로 나온다 — 실기기에서 "카드가 안 떴다"가 실패인지 끊김인지 철 지남인지 가른다.
- **비용**: 선생님 줄마다 소형 텍스트 호출 1회(대화 1회 약 1센트 안팎). 대신 Realtime 세션의 도구 정의·호출 토큰과 이어 말하기 응답(매번 대화 전체 재입력)이 사라진다.
- **걷어 낸 것(2026-09-27 — `build_app-builder_english-talk-cards-wire_report.md`)**: `parseTalkToolCall`·`extractTalkFunctionCalls`·`summarizeTalkResponseDone`·`decideTalkContinue`·`stepTalkContinue`·`TALK_CONTINUE_CHAIN_MAX`·`talkSpokeQuestion`·`buildTalkToolOutputEvent`·`TALK_TOOL_OUTPUT`·`TALK_TOOL_NAMES`와 그 타입(`lib/talk-cards.ts`), 컨트롤러의 이어 말하기·호출 결과(`app_out_n`) 보내기, 가짜 전송의 도구 호출·`noQuestionReplies`. 남길 규칙(답·단어 목록 정리, 이모지 칸 목록)은 `sanitizeTalkScreenCards` 반례로 옮겼고, `TALK_CONTROLLER_TOOL_PATH_REMOVED = true`로 "자유대화 정적"의 컨트롤러 점검이 켜져 있다(컨트롤러에 도구 경로·`function_call_output` 없음, `response.create`는 한 곳에서 셋만). 이 함수들을 되살리지 마라 — 되살리면 "선생님 두 명"이 재발한다.
- 카드는 **소리를 내지 않는다**(🔊 없음) — 마이크가 대화 내내 열려 있어, 앱이 낸 소리를 선생님이 은우 말로 듣는다. 단어장 모드 ✓는 `matchTalkWord`, 칩 6장·기록 30장은 `TALK_CARD_LIMITS`(`TALK_LIMITS.cards`가 같은 값을 가리킨다).

### 7-6. 저장 — 대화가 우선, 몇 번을 보내도 하나

- 은우 발화 0이면 화면이 저장을 부르지 않는다(`getSavePayload()` null → "다음엔 한마디 해 볼까요?" — 선생님이 한마디도 하기 전에 끝났으면(연결 중 끝내기·첫 인사 전 끊김) "연결되기 전에 끝났어요 — 다시 시작해 볼까요?", 2026-09-26 확정). 서버도 turns에서 다시 세어 400 `no_child_turn`.
- **멱등 키 `clientSessionId`**(`TALK_SAVE_ID_RE` 소문자 UUID — 컨트롤러가 만들 때 `newTalkSaveId()`로 하나) = 대화 문서 id = 그림 문서 id. 스토어 `createTalkSession(input, scene, saveId)`가 `{record, created}`를 돌려준다. 같은 id에 같은 `startedAt`이면 기존 대화를 돌려주고(200, 같은 id), 시작 시각이 다르면(충돌) 새 UUID로 만들어 남의 문서를 덮지 않는다. 확인과 생성은 파일 `mutate` 한 번, Firestore `batch.create`(ALREADY_EXISTS면 배치 전체가 거부 — 원자적) 한 번이다(app-patterns §16).
- **거부 대신 자른다.** 턴 200·턴 글자 1,000(`TALK_LIMITS`)을 넘으면 앞에서부터 잘라 저장하고 `trimmed:true` — 5분 대화 전체를 400으로 잃지 않게, 설명 키가 앞 턴부터라 번호도 보존된다. zod는 2,000턴·20,000자 넉넉한 방어선이다.
- **턴의 출처 `origin`(§12-7)**: 저장 요청 턴에 선생님 턴의 출처가 실린다. 받는 zod는 `talkSaveTurnSchema`(lib/ai/english/talk-schemas.ts — 옛 번들이 빼고 보내면 null, 모르는 값 400)를 쓰고, 은우 턴은 null로 되돌린다. `TalkTurn.origin`은 **필수 nullable**이다(2026-09-27 앱 배선에서 과도기 선택 키를 올렸다 — 선택 키 금지 규약). 선생님 턴의 null은 "출처를 모름"(배포 직후 옛 번들)이라 `reply`로 바꿔 적지 않는다. 옛 기록은 normalize가 null로 읽는다.
- **클라이언트 값을 믿지 않는다.** 프리셋·직접 입력 주제는 서버 해석 함수로 **다시 만든 값**을 저장하고(모르는 키면 400), 단어장은 모양·상한만 본다(그 사이 단어장이 바뀌어도 "실제로 넘긴 단어"가 기록이다). 카드는 `sanitizeTalkCards`로 다시, `sceneEn`은 `buildTalkSceneEn(topic)`으로 다시 계산, 그림 모델은 저장 시점 `resolveTalkImageModel()`, `durationSec`은 서버가 두 시각에서(0~3600초), 은우 턴의 `interrupted`는 false로 강제한다.
- **그림 검사에 떨어지면 그림만 뺀다**(`sceneSaved:false` — JPEG base64·`TALK_SCENE_DATA_URL_MAX` 900,000자). 저장하지 않는 대화(은우 발화 0)의 그림은 서버에 남지 않는다 — 장면 라우트가 저장하지 않고, 대화 저장이 함께 가져가기 때문이다.
- 전송 방식(keepalive 바이트 판정·pagehide 때 그림 빼기·언마운트 재시도)은 app-patterns §16. 저장에 처음 성공했을 때만 `STREAK_REFRESH_EVENT`(§17-9).
- 삭제는 `DestructiveOp` `deleteTalkSession` 하나가 대화와 그림 연쇄를 함께 막는다(Firestore 첫 줄 가드 → 라우트 403).

### 7-7. 호출 I — 문장 설명

- 클라이언트는 `{turnIndex, sentenceIndex}`만 보낸다. 서버가 저장된 대화에서 문장(`pickTalkSentence`)과 문맥(`buildTalkExplainContext` — 앞 `TALK_EXPLAIN_CONTEXT_BEFORE` 4줄 + 그 턴 + 뒤 2줄, 고른 턴 앞 `▶ `, "선생님:/아이:", 이름 없음)을 꺼낸다. 문장 번호는 서버와 화면이 같은 `splitTalkSentences`로 나눈다 — 결정적이어야 설명 키 `(turnIndex, sentenceIndex)`가 안 흔들린다.
- **라우트 순서는 과금을 막는 쪽이 먼저다**: 본문·id 400/404 → 렌더 판정 404 → 범위 밖 번호 400(**과금 전**) → 저장된 설명이 있으면 `cached:true`(**AI 0회, 키가 없어도 된다**) → 키 없음 501 → 호출(재요청 1회는 `callWithSchema`) 실패 500 → 저장은 "같은 키가 없을 때만 append"(파일 `mutate`·Firestore `runTransaction` 안에서 `decideTalkExplanation`) — 다른 탭이 먼저 저장했으면 그 설명을, 설명 상한(200)이면 저장 없이 이번 설명만(`saved:false`), 저장 실패여도 이미 과금한 설명은 돌려준다.
- 같은 문장 동시 두 요청은 AI 2회·저장 1건이다(관찰 — 화면에서는 첫 탭이 시트를 띄워 겹치기 어렵다).
- 설명 낭독: `buildTalkExplainSpeakQueue(script)` → `speakQueue`(ko → ko-KR·`normalizeKoForTts`, en → en-US·trim만 — 둘 다 300자(`TTS_TEXT_MAX_CHARS`)를 넘으면 `splitForTts`로 나눈다). 결과가 fetch 뒤에 오므로 **문장 탭 핸들러 안에서 동기로 `unlockSpeechPlayback()`**을 먼저 부른다. 대화 보기에는 발음 프리페치가 없다(자동 비용 0).

### 7-8. 개발 전용 가짜 전송·시간 배율

- localStorage `talk-debug-fake`="1"(`TALK_DEBUG_FAKE_KEY`)·`talk-debug-timescale` 0.01~1(`TALK_DEBUG_TIMESCALE_KEY` — 5분·8초·25초·도움 5초·12초를 곱한다). `readTalkDebugFake`·`readTalkDebugTimescale`는 `process.env.NODE_ENV === "production"`이면 localStorage를 **읽기 전에** false·1이고, 가짜 전송 모듈은 그 분기 안의 **동적 import**라 production 번들에 실리지 않는다. 확인은 빌드 산출물 grep — `talk-fake-transport:dev-only`(`TALK_FAKE_TRANSPORT_MARK`)·`__talkFake`·`talk-debug-fake`·`talk-debug-timescale`·`createFakeTalkTransport` 0건. 새 배율·가짜 스위치를 만들면 같은 가드를 쓴다(토익 `toeic-debug-timescale` 관용구).
- ⚠️ **가짜 전송도 `/connect`·`/scene`을 실제로 부른다**(주제 스냅샷·단어장 단어를 서버가 해석하게). 실제 키가 있는 dev 서버에서 켜면 통화 생성 1회(미디어·응답 없음, 끝낼 때 hangup)와 일러스트 1장이 과금된다. 로컬 e2e는 반드시 루프백 스텁 — `OPENAI_API_KEY=sk-stub OPENAI_BASE_URL=http://127.0.0.1:<포트>/v1`을 **함께**(관문 R `talkRealtimeBaseUrl`·사진 코어·호출 I·`/api/tts`가 모두 같은 env를 읽는다), dev 서버면 `APP_PIN=`까지. 스텁은 `/v1/realtime/calls`(가짜 SDP + `Location`)·`/hangup`·`/images/generations`·`/responses`·`/audio/speech`를 흉내 낸다(선례 scratchpad `qatalk2/stub.cjs`).
- 합성 이벤트는 이벤트마다 **고유 `event_id`**를 넣는다 — 리듀서의 delta 멱등이 event_id에 기댄다. 조종 손잡이는 `window.__talkFake`(`childSays(text, {late, lateMs, fail, durationMs, commitNewId})`·`drop()`·`setCards(route|local|slow|fail)`·`sent`·`emitted`·`cardsCalls`·`state()` — `state()`에 `appResponseCreates`(인사·도움 요청·마무리뿐이어야 한다)·`autoReplies`·`childSpeaking`·`cardsMode`). 가짜 전송은 **도구 호출을 내지 않는다**(2026-09-27) — 선생님 응답은 한 차례를 한 번에 말하고 순서는 전사 `.done` → `response.done` → 소리 멈춤이다. 카드 흉내 기본값은 `route`(가로채지 않고 실제 `/cards` 라우트 — 키가 없으면 501 → 기본 문구, 루프백 스텁이면 스텁 결과), `local`·`slow`(2.5초)·`fail`은 스텁 없이 흐름을 볼 때 쓴다. 가로채기는 선택 메서드 `TalkTransport.fetchCards?` 한 곳이고 실제 WebRTC 전송에는 없다. 대사는 전부 지어낸 영어다(은우의 실제 발화를 픽스처로 저장하지 않는다).
- ⚠️ 카드 흉내 기본값이 `route`라 **실제 키가 있는 dev 서버**에서는 가짜 선생님 줄마다 호출 J 1회가 과금된다(`/connect`·`/scene`과 같은 이유) — e2e는 루프백 스텁으로.
- tsc는 `npx tsc --noEmit --incremental false`로 돌린다 — 이 작업에서 incremental tsc가 `scripts/seed.ts` 누락을 놓친 거짓 음성이 있었다.

### 7-9. 알려진 틈 (2026-09-26 — QA `qa_report_english_talk_2.md` 기준, 3·4회차 재검증 반영)

| 항목 | 상태 | 담당 |
|---|---|---|
| 저장 keepalive를 **글자 수**로 판정했다(한도는 64KiB **바이트**) — 한글이 많은 6만 자 미만 본문이 keepalive로 나가 곧바로 거부되고, 같은 판정을 되풀이하는 재시도가 모두 실패해 그 대화를 영영 저장하지 못한다(QA 2 P2-A) | **수정됨 · QA 재검증 통과**(`qa_report_english_talk_3.md`) — 계약 `TALK_SAVE_KEEPALIVE_MAX_BYTES`·`talkSaveBodyBytes`·`planTalkSaveBody`(옛 `TALK_SAVE_KEEPALIVE_MAX_CHARS`는 삭제), 오버레이의 모든 저장 경로가 `planTalkSaveBody` 한 곳을 지나고, keepalive가 `TypeError`로 거부되면 떠나는 중이 아닐 때 일반 요청으로 1회 다시 보낸다(`build_app-builder_english-talk-p2a_report.md`, app-patterns §16). 단위 반례는 eval "자유대화 저장 본문" 12행(`runTalkSaveBodyChecks`)이 잠근다 — 바이트 판정을 글자 수로 되돌리거나 pagehide 그림 빼기를 지우면 FAIL(QA 3 P2-B → QA 4에서 해소) | app-builder |
| 도형 기호 이모지(▲●■◆)를 그림 문자가 아니라고 카드째 버렸다 — "색깔과 모양" 주제에서 카드가 조용히 사라질 수 있었다(cards P2-1) | **수정됨 · QA 재검증 통과**(`qa_report_english_talk_3.md`) — `containsPictograph`가 도형·기호 블록(U+25A0–27BF·U+2B00–2BFF·U+1F780–1F7FF, 글자·숫자 제외)을 그림으로 인정. `\p{So}` 전체는 열지 않는다(Ⓐ·㉠ 같은 글자 기호가 통과하므로). 규칙은 2026-09-26 확정돼 english.md §12-6 "이모지 칸 규칙"에 적혔다 — 그림 문자(이모지·국기·키캡·도형 기호 블록) 필수, 라틴·한글 금지(QA 4가 산문의 블록 목록 = 정규식 범위를 전수 대조) | ai-engineer |
| eval이 "카드가 **떠 있는** 상태에서 선생님이 다시 말하면 접힌다"를 잠그지 않았다(cards P2-2) | **수정됨 · QA 재검증 통과**(`qa_report_english_talk_3.md` — QA 독립 변이 17개 전부 FAIL로 잡힘) — "자유대화 도움"에 4행(카드 떠 있음·12초 요청 뒤·기본 문구·도구 먼저)을 선행 조건과 함께 추가, 변이 H1~H5를 모두 잡는다(`build_ai-engineer_english-talk-p2_report.md`) | ai-engineer |
| 호출 I [말투] 예시 문장 속 라틴 글자 ↔ ko 조각 라틴 금지 zod — 모델이 예시를 따라 쓰면 재요청(talk-ai P2-5) | **해소**(2026-09-26 확정 — QA 4 재검증) — 예시를 라틴 글자 없는 "이 말은 '나는 강아지를 좋아해요'라는 뜻이에요!"로 교체(스펙 §12-3 블록·상수 바이트 일치). eval "호출 I [말투] 예시 인용문에 라틴 글자 없음"이 잠근다(인용문 `"…"` 안만 본다) | — |
| 은우가 계속 조용하면 12초 도움 요청이 선생님 차례마다 되풀이됐다(요청마다 대화 전체 재입력 과금) | **해소**(2026-09-26 확정 — QA 4 재검증) — 은우가 말하기 전까지 **연속 2번**(12초 자동·🙋 합산, `TALK_HINT_NUDGE_STREAK_MAX`), 은우 `speech_started`로 0. 상한이면 카드만 띄우고, 선생님 말하는 중 🙋는 보류도 만들지 않는다(english.md §12-6). e2e(배율 0.2) 60초 요청 12 → 5. 도움 도착·끼어들기·같은 차례 두 번째 🙋를 섞은 열도 eval "자유대화 도움" 상한 묶음이 잠근다(QA 4 P2-C → `build_ai-engineer_english-talk-p2c_report.md`, 변이 N1~N10 전부 FAIL) | — |
| 선생님이 두 명처럼 연달아 답했다 — §12-6 "질문 없는 도구 응답 → 이어 말하기"가 앞말을 잇지 않는 새 응답을 만들었다(2026-09-27 보호자 iPhone) | **해소 · QA 재검증 통과**(`qa_report_english_talk-cards-j_full_3.md`, P1·P2 0) — AI 쪽(세션에 도구 없음·차례 규칙·호출 J·출처 태깅·저장 턴 zod — `build_ai-engineer_english-talk-cards-j_report.md`·fix1·fix2)과 앱 배선(`/cards` 라우트·컨트롤러 도구 경로 제거·출처 청·대화 보기 칩 — `build_app-builder_english-talk-cards-wire_report.md`), 같은 증상의 다른 길(은우가 말하는 중·말 끝 틈에 앱이 도움 요청·작별을 보냄 — full_1 P2-A)도 은우 차례 가드로 닫았다(`…-cards-full-fix1_report.md`). 실제 모델의 차례 규칙 준수는 실연결 몫이다(저장 턴 `origin`으로 가른다) | — |
| 호출 J 도움이 선생님 소리가 **멈춘 뒤** 도착하고(`epoch` = 멈춘 횟수) 은우가 말한 뒤 다음 선생님 차례가 시작되면, 상태 기계의 "마지막 멈춤보다 먼저 받은 도움만 버린다" 규칙(§12-6 도구 먼저 부르던 순서를 위한 것) 때문에 **앞 질문의 도움이 살아남는다** — 새 줄의 호출 J가 실패·6초 초과면 5초 뒤 앞 질문의 답 예시가 뜬다(스펙은 "실패면 기본 문구") | **해소**(2026-09-27 확정 — QA P3-C, english.md §12-7) — `teacher_audio_started`에서 도움을 늘 버린다(`hints: null`, `epoch` 삭제). eval "자유대화 도움"이 재현 행으로 잠근다(이 줄을 지우는 변이가 9행 FAIL) | — |
| 버린 도움 요청이 셈을 먹었다 — 상태 기계는 신호를 낸 순간 세는데 컨트롤러가 은우 차례·보류 버림으로 보내지 않아 "연속 2번"이 1번이 되고, 자동 응답이 끝내 오지 않는 차례에는 12초 요청이 영영 나가지 않았다(QA full_2 P3-A) | **해소**(`build_app-builder_english-talk-polish2_report.md`, QA full_3 재검증 — 컨트롤러 수준 독립 참조 360회 차이 0) — `nudge_withheld`로 되돌림(§7-4) | — |
| 드문 순서(선생님 소리가 `response.done`보다 먼저 멈춤)에서 선생님 말하는 중 🙋의 보류가 소리 있는 응답으로 버려진다 — 곧바로 나가지 않고 12초 요청이 대신 나간다(스펙 글자 "오디오가 있었으면 버린다"와는 맞다) | 관찰(QA full_3 §4-1) — 바꾸려면 대화 규칙 결정(예: 보류가 소리 멈춤에서 생겼으면 소리 있는 done이어도 보냄). 실서버 빈도는 실연결로 | 사용자 결정 |
| 마무리 8초가 선생님·은우 공유 시계라 은우가 상한 즈음 말하고 선생님 대답이 길면 작별 안내가 대답의 질문 바로 뒤에 붙을 수 있다 · `teacher_audio_started`가 상태 기계의 `childSpeaking`을 false로 되돌리는 줄(그 신호는 컨트롤러가 버리고 셈에서도 빼 동작 영향 0) | 관찰 — 대안 (가) 은우 쪽 8초를 `speech_stopped`부터 따로 셈 (나) 마무리 때 `session.update`로 `create_response: false`. 스펙 변경이라 두지 않았다 | 사용자 결정 |
| 연결 응답과 끝내기가 엇갈리는 좁은 창에서 받은 callId로 hangup을 보내지 않는다(미디어 없는 통화) | 선택 사항 | app-builder |
| 끝낼 때 아직 전사 중인 은우 발화는 저장에서 빠진다 · 연결 전 끝내기 문구가 "한마디 해 볼까요?" | **해소**(2026-09-26 확정 — QA 4 재검증) — 끝내기 버튼·5분 마무리 뒤 종료는 그 전사를 최대 2.5초 기다린다(§7-4, 숨김·뒤로가기·pagehide는 즉시), 연결 전에 끝나면 "연결되기 전에 끝났어요 — 다시 시작해 볼까요?". 남은 것: 2.5초 안에 오지 않은 전사와 즉시 끝난 대화의 전사 중 발화는 빠진다, 실연결에서 턴 감지 끄기·수동 커밋이 먹는지는 실기기(SPEC §21-5 11) | — |
| Firestore `batch.create` 멱등·설명 `runTransaction`·1MB 문서 한도 | 코드 대조만(실행 미검증 — 프로덕션 DB 금지) | — |

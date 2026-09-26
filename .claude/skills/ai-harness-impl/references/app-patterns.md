# 앱 공통 패턴 — 과목과 무관하게 app-builder가 따르는 관용구

> `ai-harness-impl` 스킬에서 **페이지·라우트·저장소·화면**을 만들거나 고칠 때 읽는다. AI 호출 규칙은 SKILL.md 본문에, 과목별 라우트는 `english-routes.md`·`japanese.md`·`toeic.md`에 있다.
> 원문: `docs/SPEC.md` §15~§19(과목 공통 기능 — 운동 소요시간 §19-8, 스트릭 은우 트랙의 자유대화 §17-9 포함), `docs/DESIGN.md`(디자인), CLAUDE.md 서문(2026-08-17 프로덕션 DB 사고).

여기 적힌 관용구는 대부분 **한 번 사고가 난 자리**에서 나왔다. 규칙만 옮기지 말고 이유도 같이 읽어라. 새 기능이 관용구에서 벗어날 때 무엇을 잃는지는 이유를 봐야 안다.

**목차** — 1 페이지와 `force-dynamic` · 2 라우트 관용구 · 3 계약 파일과 번들 경계 · 4 저장소 이원화 · 5 원자적 쓰기 · 6 prod-guard · 7 PIN 게이트 · 8 발음 관문·낭독 대본 · 9 KST 날짜(해소된 부채 포함) · 10 스트릭 갱신 이벤트 · 11 층·디자인 토큰 · 12 목록 순서변경 · 13 로컬 검증 안전 규칙 · 14 운동 세션 알림(+ 총 운동 소요시간) · 15 토익이 더한 공통 패턴(녹음·기기 전용 보관·파일로 가져오기·60초 상한·하네스 밖 관문) · 16 자유대화가 더한 공통 패턴(전이중 마이크·사진 공용 코어·저장 멱등·keepalive 바이트·언마운트 정리·실시간 관문과 60초)

## 1. 페이지 — 서버 컴포넌트가 store를 읽는다

- **`getStore()`를 부르는 `page.tsx`에는 반드시 `export const dynamic = "force-dynamic"`을 둔다.** 이게 빠지면 빌드할 때 빈 DB를 읽어 정적 페이지로 굳어 버린다. `/workout`이라면 "처음 시작" 화면이 영구히 박힌다(`app/workout/page.tsx` 주석, SPEC §19-5). 지금 store를 읽는 페이지 35개(2026-09-26, 토익·자유대화 포함)는 전부 이 선언을 갖고 있다. 대조 방법은 `grep -rla getStore app --include=page.tsx`의 결과가 `grep -rla force-dynamic app --include=page.tsx`의 결과에 포함되는지 보는 것이다. 이 문서의 전수 확인 grep에는 전부 `-a`를 붙인다. NUL 문자가 든 파일을 셸 grep이 조용히 건너뛰기 때문이다(SKILL.md "코드를 grep으로 확인할 때의 함정").
- GET으로 store를 읽는 라우트도 같다. `/api/streak`은 `dynamic = "force-dynamic"`과 `cache-control: no-store`를 함께 쓴다.
- **Next 16 주의:** `cacheComponents`를 켜면 `dynamic` export 자체가 사라진다(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md`의 버전 표). 이 저장소의 `next.config.ts`는 이 설정을 켜지 않았다. 켜려면 store를 읽는 모든 페이지가 정적으로 굳지 않게 막는 수단을 먼저 다른 것으로 옮겨야 한다.
- 서버 컴포넌트가 클라이언트 뷰에 넘기는 props는 **직렬화 가능한 값만** 쓴다. Date 객체를 넣지 말고, undefined 대신 null을 쓴다. "오늘"은 서버가 `kstTodayString()`으로 계산해 props로 넘긴다. 클라이언트가 **렌더 중에** `new Date()`나 localStorage를 읽으면 SSR 결과와 달라져 hydration이 깨진다. localStorage는 마운트 뒤 effect에서만 읽는다(`components/workout-session.tsx`의 `workout-session:v1`).
- 변경이 성공하면 `router.refresh()`로 서버 컴포넌트를 다시 읽게 한다. 라우트 응답에 갱신된 목록을 싣지 않는다(`lib/reorder-contract.ts` 주석).

## 2. 라우트 관용구

`app/api/workout/log/route.ts`가 가장 완전한 견본이다.

| 조각 | 형태 | 왜 |
|---|---|---|
| 런타임 | `export const runtime = "nodejs"` | store(node:fs·firebase-admin)와 openai SDK는 Node가 필요하다. Edge는 Next 16에서 deprecated다. 지금 route.ts 76개(2026-09-26, 토익 18개·자유대화 9개 포함)가 전부 이 선언을 갖고 있다. 전수 확인은 `grep -a`로 한다. `app/api/japanese/vocab/generate/route.ts`에는 NUL 문자가 있어서 `-a` 없는 grep은 이 파일을 건너뛰고 "선언 없음"으로 잘못 센다(SKILL.md "grep 함정") |
| 본문 파싱 | `req.json()`을 try/catch로 감싸고, 실패하면 400 `invalid_input` | 깨진 JSON이 500이 되면 원인을 알 수 없다 |
| 검증 | `bodySchema.safeParse(raw)`. 실패하면 400, 필요하면 `issues: parsed.error.issues.map(i => ({ path: i.path.map(String).join("."), message: i.message }))`를 싣는다 | 화면이 어느 필드가 틀렸는지 보여 줄 수 있다 |
| 응답 헬퍼 | `function json(body: XxxResponse, status = 200)`. 계약 타입을 인자로 받는다 | 응답 shape이 계약에서 벗어나면 tsc가 잡는다 |
| 요청 계약 ↔ zod | `const requestMatchesSchema: [Req, BodyInput] extends [BodyInput, Req] ? true : never = true;` | 화면은 계약 타입으로 보내고 라우트는 zod로 받는다. 한쪽 필드명만 바꾸면 런타임에 400이 난다. 컴파일할 때 양방향으로 묶어 둔다 |
| 선택 값 | 저장까지 흘러가는 필드는 zod `.nullable()`로 받는다(운동 라우트). `/api/card`처럼 `.nullish()`·`.optional()`로 받았다면 저장하기 전에 null로 정규화한다 | undefined가 Firestore까지 새면 쓰기가 거부된다(§4) |
| 시각 | 라우트가 `new Date()`를 한 번만 읽어 `nowIso`와 `todayKst`를 같은 순간에서 뽑고 스토어에 넘긴다 | 자정 경계에서 두 값이 어긋나지 않는다. 트랜잭션을 재시도해도 같은 값이다(§5) |
| AI 키 | AI를 부르는 라우트는 `if (!process.env.OPENAI_API_KEY)`이면 501 `no_api_key`를 **AI 호출보다 먼저** 돌려준다 | 키를 비우면 실호출이 구조적으로 0이 된다. 로컬 검증은 이 성질에 기댄다 |

**상태 코드의 뜻**을 과목마다 다르게 쓰지 않는다. 화면의 분기가 여기에 묶여 있다.

| 코드 | 뜻 | 화면 | 예 |
|---|---|---|---|
| 400 `invalid_input` | 요청 형식 위반 | `messageKo` 표시 | 모든 라우트 |
| 403 `prod_guard` | 개발 환경이 프로덕션 실데이터를 되돌릴 수 없게 바꾸려 했다(§6) | 메시지 표시 | 삭제 라우트, `/api/workout/cycle`·`/undo` |
| 404 `not_found` | 대상이 없다 | 메시지 표시 | |
| 409 | 요청이 **지금 서버 상태**와 충돌한다. 다른 탭이나 연타로 상태가 이미 바뀌었거나(`conflict`·`stale_state`·`not_active`·`empty`), 이 상태에서는 허용되지 않는다(카드 마지막 1장 삭제 `last_card`) | 메시지를 보이고 `router.refresh()` | 운동 3라우트, `/api/cards/[id]`, 토익(`already_finished`·`part_exists`·`scene_changed`·`not_finished`·`not_recorded` — 재완료 409는 화면이 성공으로 본다, `toeic.md` 7절) |
| 501 `no_api_key` | 키가 없다 | 발음은 조용히 기기 음성으로 간다. 생성 기능은 안내를 띄운다 | AI 라우트, `/api/tts` |
| 499 `client_closed` | 클라이언트가 먼저 끊었다(프리페치 배치 교체·화면 이탈·큐 종료). 라우트가 `req.signal`로 상류 호출도 끊었다 | 없음(받는 쪽이 없다). 에러 로그를 남기지 않는다 | `/api/tts`, `/api/toeic/attempts/[id]/score`(전사) |
| 500 | 저장이나 호출 실패 | 재시도 안내 | |

판독 실패는 예외가 아니다. 200과 명시적 폴백 신호로 돌려준다(과목별 문서).

## 3. 계약 파일(`lib/*-contract.ts`)과 클라이언트 번들 경계

- 계약 파일은 라우트(서버)와 화면(클라이언트)이 함께 보는 요청·응답 shape의 **단일 정의처**다. qa-inspector가 경계면을 교차 검증할 때 이 파일을 본다. 새 라우트를 만들면 계약 파일부터 만든다.
- **클라이언트 번들에 절대 들어가면 안 되는 것**은 `lib/ai/client.ts`, `openai`, `lib/store*.ts`, `lib/tts.ts`, 프롬프트 원문, 키다. 화면이 타입만 필요하면 계약 파일이 `export type`으로 재수출한다(`lib/workout-contract.ts`, `lib/japanese-vocab-contract.ts` 헤더). `isolatedModules`에서는 컴파일 때 지워지므로 런타임 import가 남지 않는다.
- 화면이 **값**(상수)을 필요로 하면 두 길이 있다. (a) 런타임 import가 없거나, 있어도 순수 모듈(`./kst`)뿐인 모듈에 둔다. import가 없는 쪽은 `lib/tts-shared.ts`(`TTS_LANGS`·`TTS_TEXT_MAX_CHARS`)와 `lib/kst.ts`다. `./kst`만 가져오는 쪽은 `lib/streak.ts`(`STREAK_REFRESH_EVENT`)와 `lib/workout.ts`다. 그런 모듈은 `openai`, `lib/ai/*`, `lib/store*.ts`, `lib/tts.ts`, `node:*`, `firebase-admin`을 **값으로** import하지 않는다. 한 단계 건너서 import해도 같다. 이 중 하나라도 딸려 오면 화면이 그 상수 하나를 import할 때 서버 코드가 폰 번들로 따라 내려간다. 타입이 필요하면 `import type`을 쓴다(컴파일 때 지워진다). (b) 서버 컴포넌트가 계산해서 props로 내린다(`lib/japanese-vocab-contract.ts` 헤더의 방침).
- zod를 클라이언트에 허용할지는 선례가 갈린다. `lib/vocab-create-contract.ts`는 판독 zod 모듈의 상한 상수를 끌어와 화면이 값으로 import한다(openai는 새지 않으므로 허용). 반면 일본어 계약은 `lib/ai/*` 값 import를 막는다. **새 코드는 타입 재수출과 props 방식을 기본으로 한다.** `lib/reorder-contract.ts`처럼 zod를 담은 계약은 zod 값을 라우트에서만 쓰고, 화면은 타입만 가져간다.
- 상한 같은 숫자는 **한 곳에서 정의하고 양쪽이 가져간다.** 화면의 `maxLength`와 라우트 zod 상한이 따로 있으면 사용자는 이유 없는 400을 보게 된다(`VOCAB_LIMITS`, `TTS_TEXT_MAX_CHARS`).

## 4. 저장소 이원화 — 새 컬렉션을 넣을 때

라우트와 페이지는 `getStore()`가 돌려주는 `StudyStore` 인터페이스만 쓴다. 구현은 `lib/store.ts`의 `JsonFileStore`(data/db.json)와 `lib/store-firestore.ts`의 `FirestoreStore` 두 가지다. 어느 쪽을 쓸지는 `resolveStoreBackend`가 정한다. `STORE_BACKEND=firestore|file`을 명시하면 그대로 따르고, 없으면 자동 감지한다. 자동 감지는 `GOOGLE_APPLICATION_CREDENTIALS`·`K_SERVICE`·`GOOGLE_CLOUD_PROJECT` 가운데 **하나만 있어도 firestore**를 고르고, 아무것도 없으면 file을 고른다. 개발 환경에서 firestore가 잡히면 `getStore()`가 경고를 찍는다.

- 파일 백엔드: `writeDb`는 `.tmp`에 쓴 뒤 rename으로 원자적으로 교체한다. `JsonFileStore.mutate`는 쓰기를 직렬화하는 큐다(읽기 → fn → 쓰기).
- Firestore: 날짜는 ISO 문자열로 저장한다. ISO 문자열은 사전순이 곧 시간순이라 `orderBy("createdAt")`가 그대로 동작한다. 읽을 때는 `toX(id, d)` 변환(`toNullable`·`toIso`)으로 방어한다.
- **쿼리 규칙**(`lib/store-firestore.ts` 헤더): `where`와 **다른 필드의** `orderBy`를 한 쿼리에 같이 쓰지 않는다. 그 조합에는 복합 인덱스가 필요하다. 필터가 있으면 `where`만 Firestore에 맡기고 정렬은 메모리에서 한다(`listCardsForBook`·`listVocabQuizzes`, 가족 규모라 충분하다). 필터 없는 단일 필드 `orderBy("createdAt", "desc")`는 쓴다(책·설명·단어장 목록).
- 단 **단일 필드 `orderBy`는 그 필드가 없는 문서를 결과에서 뺀다.** 필드가 빠진 문서가 생길 수 있는 컬렉션이라면 전체를 읽어 메모리에서 정렬한다. `listWorkoutCycles`가 그렇게 한다. `orderBy`로 읽으면 페이지가 고른 활성 사이클과 트랜잭션이 컬렉션 전체에서 고른 활성 사이클이 달라져, 요청이 영영 conflict가 될 수 있기 때문이다(메서드 위 주석).

**새 컬렉션 체크리스트** — 하나라도 빠지면 옛 데이터가 깨지거나 시드가 기록을 지운다.

1. 레코드 타입의 선택 값은 **필수 nullable**(`T | null`)로 둔다. optional(`?`)은 쓰지 않는다. 타입의 단일 정의처가 순수 엔진이면 store는 `import type`으로 가져와 재수출한다(운동: `lib/workout.ts` → `lib/store.ts`). 방향은 store → 엔진 한쪽뿐이다. 엔진이 store를 import하면 node:fs가 클라이언트와 eval로 샌다.
2. `StudyStore`에 메서드를 추가하고 두 구현 모두에 넣는다(tsc가 강제한다).
3. `DbShape`에 **필수 필드**로 추가한다. 그러면 네 곳이 tsc에 걸려 빠뜨릴 수 없다.
   - `emptyDb()`
   - `readDb()`: `(parsed.x ?? []).map(normalizeX)` — 옛 db.json에는 이 키가 없다
   - `mergeDbForSeed()`: **`mergeById(cur.x, seed.x)`**. `seed.x`를 그대로 넣으면 `npm run seed` 한 번에 그 컬렉션이 지워진다(시드가 전체 덮어쓰기였을 때 실사용 카드가 지워졌고, 그 뒤 upsert로 바뀌었다)
   - `scripts/seed.ts`: `x: []`
4. Firestore 쪽은 컬렉션 접근자(`private x(): CollectionReference`), 읽기 변환 `toX`, 쓰기 본문 헬퍼를 둔다. 쓰기 헬퍼는 `workoutCycleData`처럼 normalize를 한 번 더 태우고 id를 뺀다.
5. `scripts/migrate-to-firestore.ts`에 넣을지 **판단한다.** 이 스크립트는 1회성 이관이고, 지금 목록은 `books`·`cards`·`readings`·`explanations`·`vocabBooks` 다섯뿐이다. 로컬에서 만든 데이터를 프로덕션으로 옮겨야 할 때만 넣는다. 프로덕션에서만 생기는 기록은 넣지 않는다. `workoutCycles`를 넣으면 로컬 테스트 사이클이 프로덕션에 활성으로 올라가 활성 사이클이 2개가 된다(SPEC §19-4). 이 스크립트는 `.env`·`.env.local`을 스스로 읽고 Firestore에 쓰므로, 검증 목적으로 실행하지 않는다.

**normalize 관용구**

- 두 백엔드가 **같은 정규화 함수**를 쓴다. 파일 백엔드는 `readDb`에서, Firestore는 `toX`(읽기)와 쓰기 직전에 부른다. 예로 `normalizeWorkoutCycle`(`lib/workout.ts`), `normalizeJaDialogRecord`·`normalizeJaVocabBook`·`normalizeVocabEntry`(`lib/store.ts`), `normalizeJaVocabEntry`(`lib/ai/japanese/vocab.ts`)가 있다. 정의처는 하나뿐이다. 순수 함수라면 store가 값으로 import해도 AI 모듈에 묶이지 않는다.
- 정규화는 **던지지 않는다.** 없는 키는 null이나 기본값으로 채우고, 깨진 부분은 버린 뒤 `console.warn`한다(`normalizeWorkoutCycle`이 깨진 사건을 버린다). 읽기가 던지면 페이지가 500이 된다.
- **Firestore는 undefined를 거부한다.** `getDb()`는 `getFirestore(app)`만 부르고 `ignoreUndefinedProperties`를 켜지 않는다. 그래서 선택 값은 반드시 null로 쓰고, 저장 계층이 마지막 관문이 되어 쓰기 직전에 normalize를 한 번 더 태운다.

## 5. 원자적 쓰기 — 순수 판정 + mutate/트랜잭션 + `rev`

기존 수정 메서드는 대부분 `get → 메모리에서 판정 → update` 순서를 따른다. 두 요청이 겹치면(연타, 폰과 PC, Cloud Run 인스턴스 여럿) 뒤 쓰기가 앞 쓰기를 덮는다. 이름 바꾸기 같은 편집이라면 괜찮다. **"지금 상태를 보고 허락할지 정하는" 변경**(상태 기계·중복 생성 방지)은 원자 단위가 필요하다. 견본은 운동(SPEC §19-4)이다.

1. 판정은 **순수 함수** `decide*`가 한다(`lib/workout.ts`의 `decideLog`·`decideUndo`·`decideStart`). 입력은 현재 레코드, 요청, `todayKst`·`nowIso`·`newId`이고, 같은 입력이면 같은 결과를 낸다. 형식 오류는 RangeError로 던진다. 라우트 zod가 먼저 막으므로 이건 프로그래밍 오류다.
2. "오늘"·"지금"·새 id는 **원자 단위 밖에서 한 번만** 정한다. 날짜는 라우트가 계산하고, id는 파일 백엔드가 `randomUUID()`로, Firestore가 `col.doc().id`로 만든다. Firestore 트랜잭션은 경합하면 콜백을 다시 돌리므로 이렇게 해야 재시도해도 같은 답이 나온다.
3. 파일 백엔드는 `decide*`를 `this.mutate(db => …)` 콜백 **안에서** 부른다. 밖에서 판정하면 큐에서 먼저 처리된 요청이 쓴 뒤의 상태를 못 본다. Firestore는 `getDb().runTransaction` 안에서 `tx.get`을 **모두 끝낸 뒤** 쓴다. 콜백이 던지면(RangeError, ProdGuardError) 아무것도 쓰지 않고 롤백된다.
4. **동시성 토큰은 `rev`다.** 변경마다 +1하고, 클라이언트는 자기가 본 `expectedRev`를 보낸다. 사건 **개수**로 대조하지 않는다. 취소한 뒤 다시 기록하면 개수가 같아져서(ABA) 낡은 탭의 취소가 엉뚱한 사건을 지운다. 생성 요청은 `expectedActiveCycleId`로 연타나 두 탭에서 두 번 만들어지는 것을 막는다.
5. 서버는 **자기가 계산한 값으로** 기록한다. 요청의 `day`·`targetDay`는 "화면이 낡지 않았다"는 대조에만 쓴다.
6. **사건만 저장하고, 파생 상태(현재 Day·진행률·스트릭)는 읽을 때 계산한다.** 파생 상태까지 저장하면 진실이 두 개가 되어 갈린다.
7. 결과를 상태 코드로 옮긴다. ok는 200, not_found는 404, conflict·stale_state·not_active·empty는 409다.

저장소 전체에서 Firestore 트랜잭션은 운동이 처음이다. 토익이 7개를 더했다(가져오기 멱등·발화 포인트 병합·빈 파트 채우기·사진 저장/실패 기록·응시 끝·문항별 채점 — `toeic.md` 10절). 자유대화는 설명 append 하나를 더했다(`addTalkExplanation` — `decideTalkExplanation`으로 "같은 키가 없을 때만"). 반대로 **확인과 생성만 원자적이면 되는 멱등 생성은 트랜잭션 대신 `batch.create`**로 한다 — 문서가 이미 있으면 배치 전체가 ALREADY_EXISTS로 거부되기 때문이다(자유대화 저장, §16). 새로 트랜잭션을 쓰면 이유를 주석으로 남긴다(`lib/store-firestore.ts` 운동 절·토익 절 주석이 견본이다).

## 6. prod-guard (`lib/prod-guard.ts`)

- `assertDestructiveAllowed(op)`은 `NODE_ENV === "production"`이거나 `ALLOW_PROD_DESTRUCTIVE === "1"`일 때만 통과시키고, 그 밖에는 `ProdGuardError`(code `"prod_guard"`)를 던진다. 라우트는 `isProdGuardError(e)`로 판별해 403 `prod_guard`를 준다.
- 가드를 부르는 곳은 **Firestore 구현(`lib/store-firestore.ts`)뿐이다.** 파일 백엔드는 로컬 데이터라 가드하지 않는 것이 관용구다.
- `DestructiveOp`는 10종이다. `deleteBook`·`deleteCard`·`deleteExplanation`·`deleteVocabBook`·`deleteJaVocabBook`(대화 삭제 `deleteJaDialog`도 이 이름으로 막는다)·`undoWorkoutEvent`·`closeWorkoutCycle`·`deleteToeicSet`(세트 + 그 시험 세션)·`deleteToeicMock`(모의고사 + 생성 사진 + 응시 기록)·`deleteTalkSession`(은우 자유대화 기록 + 딸린 주제 일러스트 `talkImages` — 연쇄 삭제를 이 op 하나로 막는다).
- 대상을 가르는 기준은 "삭제 API냐"가 아니라 **"가족 기록을 되돌릴 수 없게 잃느냐"**다. 그래서 운동 기록 취소(`undoWorkoutEvent`, 첫 줄에서 가드)와 사건 있는 활성 사이클 닫기(`startWorkoutCycle` 트랜잭션 안, `tx.set` 전에 `closedHadEvents`일 때)가 대상이다. 최초 생성, 사건 0개 사이클의 제자리 교체, 기록(append), 편집(이름·재정렬·해설 재생성)은 대상이 아니다.
- **가드는 삭제만 막는다.** 생성과 수정은 Firestore에 붙은 채로 그대로 실데이터가 된다. 가드는 마지막 방어선일 뿐이고, 로컬 실행을 안전하게 만드는 것은 §13이다.
- 새 파괴적 작업을 만들면 세 가지를 한다. `DestructiveOp`에 이름을 추가하고, Firestore 메서드에서 쓰기 전에 가드를 부르고, 라우트에 403 분기를 둔다.

## 7. PIN 게이트 (`proxy.ts`)

- Next 16에서는 `middleware.ts`가 deprecated되고 이름이 `proxy.ts`로 바뀌었다(export 함수도 `proxy`). 규칙은 `lib/auth.ts`에 있다.
- **허용목록 밖은 전부 게이트 안이다.** 새 페이지나 라우트는 아무 설정 없이 보호된다. 예외는 `/unlock`, `/api/unlock`, `/_next/*`, `/__next*`, 정적 확장자(`STATIC_FILE`)뿐이다. 비용이 나는 라우트(`/api/tts` 포함)는 `PUBLIC_PATHS`에 넣지 않는다.
- 잠긴 상태에서 페이지 요청은 `/unlock?next=…`로 리다이렉트하고, API 요청은 401 JSON `{ ok:false, error:"locked", messageKo }`을 받는다. API에 리다이렉트를 주면 fetch가 HTML을 받아 깨지기 때문이다.
- `gateMode()`는 세 가지다. `APP_PIN`이 있으면 enforce, 없는데 production이면 misconfigured(전부 503으로 막는다), 없는데 개발이면 open이다. 로컬 `.env`에는 APP_PIN이 있어서 dev 서버도 잠긴다. 로컬 e2e는 `APP_PIN=` 접두어로 연다(QA 선례).

## 8. 발음 관문 — 화면은 `lib/speech.ts`만 부른다

화면은 `speechSynthesis`로 직접 말하지 않고, `new Audio`로 음성을 재생하지 않고, `fetch("/api/tts")`를 직접 부르지 않는다. 속도(`getTtsRate`), 언어별 엔진(`getTtsEngine`), 두 겹 캐시, 폴백, 재생 취소 토큰이 전부 이 모듈에 모여 있다. 화면 하나가 우회하면 같은 단어가 화면마다 다른 목소리로 들리고, 연타할 때 소리가 겹치고, 폴백이 깨진다. 지금 `app`·`components`에서 직접 호출은 0건이다. 비프 같은 효과음은 발음이 아니다. `components/workout-session.tsx`는 `AudioContext`를 직접 쓴다. **은우 자유대화의 선생님 목소리도 이 관문 밖이다** — 합성 음성이 아니라 WebRTC 원격 트랙(`<audio autoplay playsinline>`, `lib/talk-realtime.ts`)이라 속도·엔진·캐시·폴백 설정이 전부 무관하고, 목소리도 앱 공통(alloy)이 아니라 Realtime 음성(env `OPENAI_REALTIME_VOICE`, 기본 marin)이다(SPEC §21-3 알려진 한계). 대화가 끝난 뒤 문장 설명 낭독만 `speakQueue`를 탄다(english-routes §7-7).

| API | 쓸 때 | 규약 |
|---|---|---|
| `speak(text, lang?)` | 🔊 한 번 재생 | lang을 생략하면 `en-US`다. 이전 재생(단발·큐)을 취소하고 시작한다. 시그니처는 바꾸지 않는다(§16-1). **onClick 안에서 그대로 부른다** — 클라우드 경로는 첫 await 전에 동기로 iOS 재생 잠금을 풀고, 합성 뒤 재생도 큐와 같은 재사용 요소(`queueAudio`)로 한다(§16-5). 합성 대기 상한은 큐와 같은 `fetchMs`(8초)다. 탭 밖(effect의 자동 낭독)에서 불러도 예전보다 나빠지지 않는다 |
| `speakSequence(words, lang?)` | 단어 배열을 한 문장처럼 읽기 | `join(" ")`한 뒤 `speak`를 1회 부른다. 단어마다 쪼개면 로봇처럼 들린다 |
| `stopSpeaking()` | 화면 이탈, 다음 문제로 넘어갈 때 | 단발 재생과 큐를 모두 멈춘다 |
| `prefetchSpeech(texts, lang)` | 화면에 보이는 문장을 미리 합성 | 반환값은 중단 함수다. `useEffect(() => prefetchSpeech(…), [key])`로 쓴다. 새 배치가 오면 직전 배치를 끊는다. 한 화면에서 부모와 자식이 따로 부르면 자식 쪽 효과가 먼저 돌아서 끊긴다. 그러니 한 곳에서 합쳐 부르고, 의존성은 배열 참조가 아니라 문자열 키로 준다(`components/ja-dialog-detail-view.tsx`). device 엔진 언어면 네트워크 0이지만 요청은 "마지막 프리페치"로 기억한다 — 그 언어 엔진을 cloud로 바꾸면 즉시, 속도를 바꾸면 옛 속도 배치를 누르는 순간 멈추고 마지막 조작 `RATE_PREFETCH_DEBOUNCE_MS`(600ms) 뒤 한 번, 화면 코드 없이 새 설정으로 다시 돈다(§16-5 — 연타마다 배치를 쏘면 상류 합성이 쌓인다). 그러니 화면이 설정 변경에 맞춰 프리페치를 다시 부르지 않는다. 한 번에 최대 `PREFETCH_MAX_ITEMS`(90)개다 |
| `speakQueue(items, { onItem, onEnd })` | 여러 조각 이어 읽기 | **탭 핸들러 안에서 동기로** 부른다. 첫 await 전에 iOS 재생 잠금을 풀기 때문이다. 반환값은 멈추기 함수다. 정지할 때는 `stopSpeaking`이 아니라 이 함수를 써야 다른 🔊를 죽이지 않는다. `onEnd`는 정확히 한 번 온다. 핸들러 안에서 `speak`/`speakQueue`를 다시 부르면 안 된다(재진입 금지). `onEnd(reason, info)`의 둘째 인자 `info.sounded`(`SpeakQueueEndInfo`, 2026-09-26 하위 호환 추가)는 끝까지 소리를 냈다고 본 조각 수다 — 무음 조각이 연속 `QUEUE_SILENT_STOP`(3)개여야 `"stopped"`이므로 **짧은 큐는 전부 무음이어도 `"done"`**이다. 소리가 반드시 나야 하는 화면(토익 응시 질문 음성)은 `sounded`로 다시 판정한다(`toeicSpeechOutcome`) |
| `unlockSpeechPlayback()` | 탭 밖(타이머 콜백 등)에서 나중에 소리 낼 화면 | 탭 핸들러 안에서 동기로 부른다. 지금 나고 있는 소리는 끊지 않는다(`components/workout-session.tsx`의 ✓ 탭) |

- 공유 상수는 `lib/tts-shared.ts`(런타임 의존 0)에만 둔다. `lib/speech.ts`가 `lib/tts.ts`를 import하면 openai가 폰 번들에 내려간다.
- 새 발음 언어는 `TTS_LANGS`에 추가하면 라우트 zod enum이 따라온다. `lib/tts.ts`의 `TTS_INSTRUCTIONS_VERSION`(지금 2)은 영속 캐시 지문 전체에 걸려 있다. 올리면 **전 언어의 캐시가 비워져** 재합성 비용이 난다. 지시문을 고칠 때만, 그 비용을 감수하고 올린다.
- 폴백이 핵심이다. 키가 없으면(501) 실패하거나 300자를 넘기면 에러 UI 없이 기기 음성으로 간다. 키를 비운 로컬에서 🔊가 기기 음성으로 나는 것이 정상이다. 속도는 전역값 하나를 localStorage에 보존한다(`components/tts-speed-control.tsx`). 엔진 선택 UI는 `components/tts-engine-control.tsx`다.
- 기기 음성으로 말하는 곳(`fallbackDevice`·`speakDeviceAwait`)의 cancel 규칙은 하나다 — **말하는 중·대기 중일 때만** `cancel()`하고, 잠금 해제용 빈 발화만 남았으면 끊지 않고 뒤에 잇는다. 쉬고 있을 때 `cancel()` 직후 `speak()`하면 iOS·Chrome에서 새 발화가 씹힌다(2026-09-25 무음 신고의 두 번째 고리).
- 그리고 **말하기 직전에 `speechSynthesis.paused`면 `resume()`한다**(`resumeIfPaused` — `fallbackDevice`·`speakDeviceAwait`·잠금 해제 빈 발화 세 곳). iOS WebKit은 `cancel()` 뒤 paused로 굳어 이후 `speak()`를 에러·이벤트 없이 무시한다 — "기기랑 클라우드가 꼬인 것 같다, 속도를 바꾸다 보면 다시 나온다"(2026-09-25 관찰)의 기기 쪽 고리다. 앱은 `pause()`를 쓰지 않으므로 풀어도 잃을 것이 없다. 기기 음성으로 말하는 곳을 새로 만들면 cancel 규칙과 이 줄을 함께 쓴다(eval "단발" F13이 세 곳을 따로 잠근다).
- **같은 문장의 합성 요청은 하나다**(`getAudioBlob`의 진행 중 공유, 캐시 키 단위). 🔊·프리페치·큐 look-ahead가 동시에 원하면 요청 하나를 함께 기다린다. 소비자는 자기 `signal`로 **자기만** 물러나고(AbortError), 기다리는 소비자가 0이 될 때만 요청을 끊고 곧바로 표에서 뺀다 — 뒤에 온 소비자는 끊긴 요청에 붙지 않고 새로 보낸다. 대기 상한(`fetchMs`)을 넘긴 요청에도 새로 붙지 않는다(매달린 요청에 묶여 다시 눌러도 클라우드를 못 쓰는 일 방지). `/api/tts`는 `req.signal`을 `synthesizeSpeech(input, signal)` → openai `RequestOptions.signal`로 넘겨, 끊긴 요청은 상류 합성도 멈추고 499 `client_closed`(에러 로그 없음)로 끝난다.
- 폰 진단: 마지막 클라우드 재생 결과(성공 / 캐시·합성·재생 단계와 이유 / 기기 음성 대체 여부)를 `getTtsPlaybackDiag(lang)`·`TTS_DIAG_EVENT`로 읽는다. 화면은 `TtsEngineControl`의 캡션 한 줄로만 보이고, 마운트 후에 읽는다(hydration). 실기기 신고를 받으면 먼저 이 캡션 문구를 물어본다.

**낭독 대본 — `speakQueue`에 넘길 조각은 순수 함수가 만든다** (`lib/ja-coaching-script.ts`, SPEC §18-1)

해설을 "무엇을, 어느 언어로, 어떤 순서로 읽을지"로 바꾸는 일은 화면이 하지 않는다. 화면은 `buildCoachingScript(c)`가 돌려준 `ScriptPiece[]`를 `speakQueue`에 넘기고, `onItem` 인덱스로 카드를 강조할 뿐이다. 순수 함수여야 오프라인 eval(`eval:speech`의 "대본"·"쪼개기" 영역)로 잠글 수 있다. 여러 조각을 이어 읽는 새 기능이 생기면 같은 모양을 따른다.

- **일본어 조각은 정리하지 않는다.** `trim`만 한다. 🔊 단발 재생(`speak(ja, "ja-JP")`), 프리페치, 대본 재생이 글자까지 같은 문자열을 써야 두 겹 캐시가 한 번 합성한 소리를 다시 쓴다. 프리페치 키, 재생 키, 캐시 키가 모두 같은 값이다. 그래서 일본어 원문이 상한 이하면 조각은 `원문.trim()` 그대로 하나다.
- **`coachingJaTexts(c)`는 대본의 일본어 조각과 같은 출처, 같은 정리(`trim`, 빈 것 제외)를 쓴다.** 그래서 대본의 일본어 조각의 부분집합이 된다. 프리페치할 목록을 화면이 따로 모으면 한 글자만 달라도 프리페치가 헛돈다.
- **`normalizeKoForTts`는 한국어 조각에만, 쪼개기 전에 적용한다.** 화살표는 쉼표로 바꾸고 물결과 이모지는 지운다. TTS가 기호를 "화살표"·"물결"로 읽지 않게 하려는 것이다. 이 정리를 일본어에 걸면 위의 캐시 키가 어긋난다.
- **쪼개기(`splitForTts`)의 상한은 `TTS_TEXT_MAX_CHARS`를 import해 쓴다.** 숫자를 새로 적지 않는다. 길이는 서버 zod와 같은 `String.length`(UTF-16)로 잰다. 모든 조각이 상한 이하이므로 `/api/tts`가 400을 줄 일이 없다. 불변식은 조각이 trim돼 있고 비어 있지 않으며 상한 이하라는 것, 그리고 공백을 빼고 이어 붙이면 원문과 같다는 것(글자 유실·추가 없음)이다.
- **번들 경계:** `lib/ja-coaching-script.ts`의 런타임 import는 `./tts-shared`뿐이고, 해설 타입은 `lib/japanese-dialog-contract.ts`에서 `import type`으로 가져온다. 계약 파일도 `lib/ai/japanese/schemas`를 `import type`으로만 참조한다. 그래서 이 사슬 어디에도 zod나 프롬프트가 런타임으로 걸리지 않는다. 대본 모듈은 클라이언트(`components/ja-dialog-coaching-view.tsx`·`components/ja-dialog-detail-view.tsx`)가 값으로 import하므로, 대본 모듈에 값 import를 하나 더할 때는 그 모듈의 전이 의존까지 확인한다(§3 (a)의 금지 목록).

## 9. KST 날짜 — `lib/kst.ts` 단일 정의

- 함수는 `kstDateString(iso)`, `formatKst(iso)`, `formatKstDate(iso)`, `isZonedIsoTimestamp(value)`, `kstTodayString(now?)`, `shiftDateString(date, n)`, `diffDateStrings(from, to)`(형식 밖이면 NaN), `deviceDateString(d?)`다.
- **"시간대가 명시된 ISO 시각인가"는 `isZonedIsoTimestamp` 한 곳이 정한다**(2026-09-25 단일화). 날짜만(`YYYY-MM-DD`) 또는 `THH:MM[:SS[.s{1,3}]]` + `Z`·`±HH:MM`이고, 날짜가 달력에 있고 `Date.parse`가 성공해야 한다. 시간대 없는 시각, 소수 4자리 이상, `24:00`, 달력 밖 날짜, 비문자열은 거절한다. 모두 엔진이나 실행 TZ에 따라 해석이 갈리는 값이다. `formatKstDate`(표시)와 `lib/workout.ts`(createdAt 정규화·endedAt 닫힌 날)가 이 함수를 같이 쓴다. 예전에는 운동에만 별도 정규식(소수 1~9자리, 24:00 허용)이 있어서 `…T15:00:00.123456Z`를 운동은 유효로, 표시는 폴백으로 봤다. 저장 값(`toISOString()`)은 양쪽 모두 통과하므로 실데이터에는 영향이 없었다. ISO 판정이 필요하면 정규식을 새로 쓰지 말고 이 함수를 import한다.
- 계산은 **+9시간 후 `getUTC*`** 방식만 쓴다. `toLocaleString`·`Intl`·시간대 DB는 쓰지 않는다. 그래야 서버(Cloud Run UTC), SSR, 클라이언트가 항상 같은 값을 낸다.
- 시각은 ISO UTC로 저장하고, "하루"는 KST 일자로 파생한다. ISO 시각에 `.slice(0, 10)`을 하면 UTC 일자가 나온다. KST 00:00~08:59에 만든 기록은 전날로 찍히므로 쓰지 않는다. 표시용 날짜는 `formatKstDate(iso)`(`YYYY.MM.DD`, 시각까지면 `formatKst`)로 만든다.
- **해소된 부채(2026-09-25) — "만든 날짜" UTC 날짜부 자르기.** 상세 페이지 4곳(`app/{english/vocab,math/problem,japanese/vocab,japanese/dialog}/[id]/page.tsx`), 목록 뷰 5곳(`components/{library,math-library,vocab-library,ja-vocab-library,ja-dialog-library}-view.tsx`의 로컬 `formatDate` 헬퍼는 지웠다), `components/card-view.tsx`의 카드 이력이 `createdAt.slice(0, 10)`으로 UTC 일자를 보이던 것을 전부 `formatKstDate(iso)`로 바꿨다. 예전 주석의 "타임존 계산 없이 SSR/클라 동일 출력"은 자를 이유가 못 됐다 — `formatKstDate`도 +9h와 `getUTC*`만 써서 SSR과 클라이언트가 같은 값을 낸다. `isZonedIsoTimestamp`가 거절하는 값(시간대 없는 시각 `2026-09-25T10:00:00`, 달력에 없는 날, `24:00`, 소수 4자리 이상)은 엔진마다 해석이 갈린다(로컬 시각, V8 굴림). 그대로 환산하면 hydration이 깨지므로 환산하지 않고 예전처럼 원문 앞 10자를 보인다. 경계는 `eval:streak`("KST 환산")이 잠근다. 판정을 값으로 단언하고, formatKstDate 경계표를 TZ Asia/Seoul·UTC·America/Los_Angeles로 바꿔 다시 돌린다. KST 기기에서만 돌리면 "시간대 없는 시각" 가드가 잠기지 않기 때문이다. 새 화면에서 `createdAt`을 날짜로 보일 때도 이 함수만 쓴다. 반면 읽음 기록의 `readAt.slice(0, 10)`은 부채가 아니다. `readAt`은 기기 날짜 문자열(`deviceDateString`)이다(아래 예외).
- "오늘"은 서버가 필요한 순간에 한 번만 읽는다. 순수 함수는 `todayKst`를 인자로 받아 결정적으로 동작한다.
- 예외가 하나 있다. `deviceDateString`은 "오늘 읽었어요"(읽음 기록) 전용이고 기기 로컬 달력을 따른다. 스트릭(KST)과 일부러 합치지 않는다.
- 새 날짜 규칙이 필요하면 이 파일에 추가한다(운동 때 `diffDateStrings`를 추가한 선례). 컴포넌트에 +9h 계산을 복사하지 않는다. 예전에 세 곳에 복사돼 있던 것을 모아서 이 파일이 생겼다.

## 10. 스트릭 갱신 이벤트

- `STREAK_REFRESH_EVENT`(`lib/streak.ts`, 값 `"eunwoo:streak-refresh"`)는 `window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT))`로 쏜다. 헤드라인(`components/streak-headline.tsx`)이 이 이벤트를 받아 `/api/streak`를 다시 읽는다. 재조회가 겹치면 마지막 요청의 응답만 반영한다.
- **스트릭에 세는 기록을 저장한 직후에 쏜다.** 영어 단어 시험(`vocab-quiz-view.tsx`), 일본어 시험(`ja-quiz-runner.tsx`), 한자 시험(`ja-kanji-quiz-runner.tsx`)은 저장에 성공했을 때 쏜다. 토익 표현 시험(`toeic-quiz-runner.tsx`)은 새로 저장된 모드가 하나라도 있으면, 모의고사 응시(`toeic-take-view.tsx`)는 finish가 성공하거나 409 `already_finished`이고 녹음된 문항이 1개 이상이면 쏜다. 은우 자유대화(`talk-call-overlay.tsx`)는 대화 저장에 **처음** 성공했을 때 한 번 쏜다(멱등 재저장·겹친 요청은 다시 쏘지 않는다 — 언마운트 뒤에 성공해도 다음 화면의 헤드라인이 받는다). 운동은 기록·취소·사이클 시작이 성공했을 때와 **409일 때 둘 다** 쏜다(`workout-view.tsx`의 `mutate`·`onSessionResult`). 409는 서버 상태가 이미 바뀌었다는 뜻이라 다시 읽는 것이 맞다. 이 분기가 빠져 있던 것이 과거 QA의 P2였다.
- 무엇을 세는지는 SPEC §17-1이 정한다. 시험(답한 문항 1개 이상)과 운동 "지킨 날"만 센다. 아빠의 🎙️ 영어 트랙은 토익 표현 시험(답한 문항 ≥ 1)과 모의고사 응시(녹음된 문항 ≥ 1)를 센다(`lib/toeic-streak.ts`, `toeic.md` §0-2) — 일본어·운동 트랙과 합치지 않고, 토익 컬렉션 읽기가 실패하면 이 트랙만 중립값으로 보낸다. 은우 트랙은 §17-1의 예외로 **자유대화**(은우 발화 ≥ 1, `lib/talk-streak.ts`)도 센다(SPEC §17-9) — 대화는 "은우 발화 = 답한 문항"으로 옮겨 같은 코어(`computeStreak`)에 단어장 시험과 함께 넣고, 대화 컬렉션을 못 읽으면 은우 트랙은 단어장 시험만으로 계산한다(`listAllTalkSessions().catch(→ null)`). 수학, 읽음, 일본어 대화 복습, 생성은 세지 않는다. 새로 "세는 기록"을 만들면 `app/api/streak/route.ts`와 이벤트를 쏘는 곳을 **같이** 바꾼다. 스트릭 값은 저장하지 않고 읽을 때 계산한다.

## 11. 층·디자인 토큰

- 디자인의 진실 원천은 `docs/DESIGN.md`다. 값은 `app/globals.css` 한 곳에서 정의한다(`:root` 변수를 `@theme inline`으로 Tailwind에 연결한다). 컴포넌트는 값을 하드코딩하지 않고, CSS 변수나 토큰에 연결된 Tailwind 유틸, 역할 클래스를 쓴다.
- 역할 클래스는 두 종류다. 타이포는 `.t-*`(`t-book-title`·`t-lead`·`t-section-title`·`t-caption`…), 공통 형태는 `.u-*`(`u-btn`·`u-btn-primary`·`u-btn-secondary`·`u-card`·`u-box`·`u-chip`·`u-entry*`·`u-navbtn`·`u-input`·`u-label`·`u-table`…)다. 새 화면은 이 조합으로 만든다.
- **새 색조를 도입하지 않는다.** 흰색, 뉴트럴 그레이, 파랑(`--accent`) 하나만 쓴다. 노랑·초록·빨강은 쓰지 않고, `--danger`는 삭제나 파괴를 확인하는 곳에만 쓴다. 완료·실패 같은 상태는 accent와 ink-3의 명도 차이에 글리프(✓ ✗)를 더해 구분한다(SPEC §19-6). 버튼 최소 높이는 `--tap-min`이다.
- 층: 스트릭 헤드라인은 `sticky top-0` `z-[15]`이고 높이는 `--streak-h`(40px)다. 다른 sticky 요소는 `top: var(--streak-h, 0)`로 그 아래에 붙인다(`english-nav.module.css`, `ja-dialog-coaching-view.module.css`). 몰입하는 전면 오버레이는 z-index 20에 `lockBodyScroll()`(`lib/scroll-lock.ts`, 참조 카운트라 중첩해도 안전)을 쓴다. 오버레이가 헤드라인을 가리는 것은 의도다. 인쇄에서 뺄 UI에는 `print-hide`를 붙인다.
- 최종 검증 기기는 폰이다. 390px과 360px에서 문서 전체에 가로 스크롤이 생기지 않는지 본다.

## 12. 목록 순서변경 (SPEC §15-1)

새 목록에 순서변경을 붙일 때는 이미 있는 프리미티브를 그대로 쓴다. 라이브러리는 추가하지 않는다.

- 화면은 `components/use-reorder.ts`를 쓴다. 이 훅은 id 순서만 알고, 포인터 드래그·자동 스크롤·↑/↓·키보드·낙관적 반영과 실패 시 되돌리기를 처리한다. **관리 모드일 때만** 켠다(`enabled`). 평소에 드래그 핸들이 있으면 모바일 세로 스크롤과 충돌한다.
- 요청 계약은 `lib/reorder-contract.ts`의 범용 `{ orderedIds }` 하나다. zod 값(`reorderRequestSchema`)은 라우트에서만 쓴다. 빈 배열·중복·`REORDER_MAX_IDS` 초과를 거절하고, Firestore 문서 id 규칙(`isFirestoreDocId`: `/` 없음, `.`·`..` 아님, `__.*__` 아님, 올바른 UTF-8, 1,500바이트 이하)을 어기는 id도 400으로 막는다(2026-09-25). Firestore `col.doc("a/")`는 문서 `a`를 가리키므로, 막지 않으면 같은 요청에 두 백엔드 결과가 갈린다. 실제 저장 id(randomUUID, 자동 id 20자)는 전부 통과한다. 지금 라우트는 `/api/library/reorder`·`/api/math/reorder`·`/api/english/vocab/reorder`·`/api/japanese/vocab/reorder`·`/api/japanese/dialog/reorder`·`/api/toeic/sets/reorder`·`/api/toeic/mocks/reorder`·`/api/english/talk/reorder` 여덟이다.
- 저장: 레코드마다 `sortIndex: number | null`(필수 nullable)을 둔다. 생성 입력 타입(`New*`)에서는 `sortIndex`를 `Omit`한다. 스토어가 null로 태어나게 하므로 새 항목은 맨 위에 뜬다. `reorder<X>(orderedIds)`는 넘어온 id들을 0..n으로 재색인하고 **목록에 없는 항목은 건드리지 않는다.** Firestore는 여덟 `reorder<X>`가 전부 공유 본체 `reorderBySortIndex(db, col, orderedIds)`(`lib/store-firestore.ts`)를 부른다. **없는 id는 두 백엔드 모두 조용히 건너뛴다**(계약 주석 "존재하지 않는 id는 스토어가 조용히 건너뛴다"). 파일 백엔드는 `rank.get(id)`가 있는 레코드만 바꾸고, Firestore는 `getAll(...refs, { fieldMask: ["sortIndex"] })`로 존재하는 문서만 걸러 batch update한다(`BATCH_LIMIT` 단위 청크). `isFirestoreDocId`를 통과하지 못한 id는 `doc()`에 넘기지 않고 건너뛴다(계약과 같은 판정이라 스토어를 단독으로 불러도 파일 백엔드와 같다). **해소된 부채(2026-09-25):** 예전 Firestore 구현은 넘어온 id마다 `WriteBatch.update`를 걸어, 다른 탭에서 지운 id 하나가 배치 전체를 NOT_FOUND로 거부시켜 라우트가 500 `save_failed`를 줬다. 인덱스는 파일 백엔드와 같은 규칙이다 — 넘어온 **위치** 그대로(없는 id 자리는 당기지 않고 비운다), 중복이면 마지막 위치가 이긴다. 확인과 커밋 사이에 지워지면(NOT_FOUND, code 5) 한 번만 다시 걸러 쓴다(값이 고정이라 멱등). 에뮬레이터가 없어 이 함수는 db를 주입받는다 — 가짜 db로 검증한다. 새 목록을 붙이면 Firestore 쪽도 이 함수를 부르고 `batch.update`를 직접 걸지 않는다. 정렬은 페이지나 뷰가 한다. null이 먼저 오고(createdAt 역순), 그 뒤 sortIndex 오름차순이다.
- **부분 목록에서는 재배치를 끈다.** 필터나 검색으로 일부만 보일 때 재색인하면 숨은 항목과 인덱스가 겹친다. 수학 목록은 '전체'가 아니면 끄고, 서재는 검색 중에 끈다. 삭제는 필터와 무관하게 유지한다.
- 순서 변경은 수정이라 prod-guard 대상이 아니다. 성공하면 `router.refresh()`로 서버 순서를 확정한다.

## 13. 로컬 검증 안전 규칙

- **모든 로컬 실행에 접두어를 붙인다:** `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT=` (e2e라면 `APP_PIN=`도). `STORE_BACKEND=file`은 자동 감지에 기대지 않으려고 명시한다. 키를 비우면 AI 라우트와 `/api/tts`가 501로 거절해서 실호출이 0이 된다. GCP 변수까지 비우면 쉘에 남은 자격증명 신호도 끊긴다.
- 서버를 띄웠으면 **데이터를 쓰기 전에** 로그에 `[store] backend=file (STORE_BACKEND 명시)`가 찍혔는지 확인한다.
- **db.json 백업과 복원:** 쓰기가 있는 검증을 하기 전에 `data/db.json`을 scratchpad로 복사하고 `shasum`을 기록한다. 끝나면 되돌린 뒤 shasum이 같은지, `data/db.json.tmp`가 남지 않았는지 확인한다(`_workspace/qa_report_streak-workout_e2e_1.md`의 "복원" 절이 선례다). `data/`는 gitignore 대상이다.
- `npm run seed`는 파일 전용이다. `mergeDbForSeed`가 `readDb`·`writeDb`를 직접 쓰므로 Firestore는 건드리지 않는다. 다만 db.json에 시드 레코드를 upsert한다.
- 공통 기능을 고쳤으면 오프라인 eval(`eval:streak`·`eval:speech`·`eval:workout`)부터 돌린다. 셋 다 store를 import하지 않는다.
- 타입 검사는 `npx tsc --noEmit --incremental false`로 전수 확인한다. 자유대화 작업에서 incremental tsc가 `scripts/seed.ts`의 새 컬렉션 누락을 놓친 거짓 음성이 있었다(`_workspace/build_app-builder_english-talk-app_report.md` §5).
- **하지 않는다:** `migrate-to-firestore` 실행, `ALLOW_PROD_DESTRUCTIVE=1`, `.env`의 `STORE_BACKEND`나 GCP 자격증명 줄 채우기, 서브 에이전트에게 어느 DB를 향하는지 알리지 않고 검증 맡기기(2026-08-17 사고의 직접 원인).

## 14. 운동 세션 알림 — 비프·진동·음성·Wake Lock (SPEC §19-6)

휴식 타이머 종료 알림은 **전부 best-effort**이고 기준은 시각 타이머(종료 시각 epoch ms)다. 규칙의 진실 원천은 `components/workout-session.tsx` 머리 주석과 SPEC §19-6이다. 알림을 고치거나 새 세션 화면을 만들 때 아래를 지킨다 — iOS는 **탭 밖 재생**을 막아서, 탭 안에서 해 둘 일을 빼먹으면 소리가 조용히 안 난다.

- **휴식은 세트(라운드) 사이에만 있다**(§19-1 슈퍼세트, 2026-09-25 사용자 정정). 풀업+푸시업이 한 세트다 — 풀업 `✓`는 타이머 없이 곧바로 같은 세트의 푸시업으로, 푸시업 `✓`가 휴식을 시작하고(비프 예약도 여기서), 마지막 `✓`는 곧바로 완료 기록이다. 규칙의 정의처는 엔진 `lib/workout.ts`의 `restFollowsStep`/`stepFollowsRest`(+ 음성 안내 대상 `stepsAfterRest`) 하나다 — onDone·음성 안내 대상·복원 정규화·목록의 휴식 줄이 같이 보고, eval:workout "스텝·휴식"이 [1,3,5,7]·[2,4,6,8]·대상 정확히 4개로 잠근다(화면 파일에 두면 eval이 import하지 못해 옛 규칙으로 되돌려도 통과했다 — 2026-09-25 QA F3). 풀업 `✓` 직후 같은 자리에 푸시업 `✓`가 뜨므로 연타 가드(`CHAIN_TAP_GUARD_MS`)를 둔다. 옛 저장값의 "푸시업 앞 휴식"(홀수 스텝 + `restEndsAt`)은 복원할 때 휴식만 버린다.
- **비프는 발음 관문 밖이다**(§8) — `AudioContext`를 직접 쓴다. 컨텍스트는 모듈 싱글턴(iOS는 컨텍스트 개수에 제한이 있다). `▶ 운동 시작`·`✓` 탭 핸들러 안에서 **동기로** `ensureWorkoutAudio()`(만들거나 `resume()`)를 부르고(휴식을 시작하지 않는 풀업 `✓`에서도 — 멱등이라 무해), 휴식 종료 시각에 `scheduleBeep`로 **미리 예약**한다(탭 밖에서 새로 재생하지 않으려고).
- 휴식 길이를 바꾸거나 `+30초` 하면 예약을 다시 건다(`rescheduleBeep`). `finishRest`(타이머 콜백)는 예약분이 아직 안 울렸으면(컨텍스트가 멈춰 있었다 등) 그 자리에서 울리고 예약분은 취소한다 — 단 컨텍스트가 `running`일 때만이다(`interrupted`·`suspended`면 비프는 생략되고 진동·음성만 간다).
- 새로고침 뒤 진행 복원(`workout-session:v1`)에서는 컨텍스트가 `running`일 때만 남은 시간에 비프를 재예약한다.
- **음성 안내**(토글 `workout-voice:v1`, 기본 켬)는 발음 관문을 탄다 — `✓` 탭에서 `unlockSpeechPlayback()`, 휴식 끝에 `speakQueue([{ text, lang: "ko-KR" }])`. 세션 시작 탭에서 휴식 뒤 안내 4개(2~5세트 풀업 — 첫 스텝과 푸시업 스텝 안내는 휴식 뒤에 안 나오므로 뺀다, 대상 고르기는 엔진 `stepsAfterRest`, 문구 조립은 `sessionPhrases` 한 곳)를 `prefetchSpeech(…, "ko-KR")`로 미리 받는다. ko 기본 엔진이 cloud라 **키를 넣은 dev 서버에서는 실호출**이다.
- 진동은 `navigator.vibrate?.(…)`(iOS는 지원하지 않아 무시되는 것이 정상), 화면 꺼짐 방지는 Wake Lock 요청 + visible 복귀 때 재요청(지원 안 하면 조용히 넘어간다).
- **세트 목록 순서·완료 축하는 표시일 뿐이다**(§19-6, 2026-09-25 사용자 요청). 순서(지금 할 세트 맨 위 → 남은 세트 → 완료 세트 맨 아래)는 `roundDisplayOrder(step, held)`로 **현재 스텝에서 파생**하고 따로 저장하지 않는다 — 그래서 복원·재진입은 애니메이션 없이 최종 순서다. 푸시업 `✓`는 휴식·비프 예약·저장을 **먼저** 끝낸 뒤 `celebrateRound`가 끝낸 세트를 약 1초(`CELEBRATE_MS`) 맨 위에 붙잡아 축하(체크 팝·이모지 버스트·"🎉 n세트 완료!"·`vibrate(40)`)하고, 타이머가 위치를 재(`measureFlip`) 붙잡기를 풀면 다음 커밋의 `useLayoutEffect`가 FLIP(`el.animate` transform → 0)을 재생한다. 붙잡기는 표시 상태(`celebrating`)일 뿐이라 축하 중에도 조작은 상태 기준이다. 행은 세트 번호로 key를 걸고 한 줄 배열(`flatMap`)로 그려야 DOM이 재사용돼 같은 요소가 움직인다. `prefers-reduced-motion`이면 붙잡지 않고(즉시 재배치) CSS도 팝·버스트를 끈다. 스크린리더는 `role="status"` 알림("n세트 완료!")과 행마다 숨은 상태 글자(지금 할 세트·남은 세트·완료)로 순서 변화를 따라간다. 마지막 `✓`는 축하 없이 곧바로 완료 기록이다.
- **세트 완료 축하·목록 순서**(SPEC §19-6): 목록 순서는 엔진 `roundDisplayOrder(step, held)`에서만 파생한다(화면에 규칙을 두지 않는다 — eval:workout이 잠근다). 축하는 1초(`CELEBRATE_MS`) 동안 완료 행을 제자리에 잡아 두고(`held`) 끝나면 FLIP으로 아래로 옮긴다. 축하 문구는 휴식 영역 캡션 자리에도 띄운다(작은 화면에서는 목록이 첫 화면 아래라서). 휴식 시작 직후 `CHAIN_TAP_GUARD_MS` 동안은 휴식 버튼을 무시한다(`restStartedAtRef` — 이중 탭이 같은 자리의 "3분"에 떨어지는 문제). `prefers-reduced-motion`이면 애니메이션 없이 즉시 재배치한다.

**총 운동 소요시간** (SPEC §19-8, 2026-09-26 — 실측은 세션이 재고, 없으면 엔진이 읽을 때 근사한다)

- **실측 = 그날 세션을 처음 연 순간부터 기록 요청을 처음 보낸 순간까지**(휴식 포함, 같은 기기 시계의 두 시각 차라 폰·서버 시계 차이와 무관). 시작은 진행 보존값 `workout-session:v1`에 `startedAt`(epoch ms)으로 둔다(키는 그대로, 옛 값은 null → 그 세션은 근사). **0스텝·휴식 없음이어도 저장한다** — 첫 ✓ 전에 새로고침해도 시작이 남게. 부수 효과로 세션을 한 번 열면 오늘 카드가 "이어서 하기 · 풀업 1세트부터"가 된다(시계가 이미 돈다는 뜻). QA 관찰 O1("열어 보기만 해도 시계가 시작")은 2026-09-26 사용자가 **"처음 연 순간"으로 확정**했다 — 첫 ✓를 시작점으로 바꾸지 않는다(SPEC §19-8). 끝 시각은 **처음 보낸 순간을 ref(`endAtRef`)에 고정**한다 — 네트워크 오류 뒤 다시 눌러도 값이 늘지 않는다. 실패 입력 패널에서 "돌아가기"를 누르면 그 끝 시각을 버린다(운동을 이어 가면 그건 끝이 아니다). `durationSec = round((끝 − 시작)/1000)`, 음수이거나 시작을 모르면 null. 렌더는 state(`clockNow`·`endAt`·`startedAt`)만 읽고 `Date.now()`는 effect·핸들러·타이머 콜백 안에서만 부른다(hydration). 머리의 "⏱ 경과" 시계는 `role="timer"`·`aria-live="off"`.
- **정규화 함정 — 새 필드는 정규화 함수에도 넣는다.** `WorkoutEvent.durationSec: number | null`(필수 nullable). `normalizeWorkoutEvent`가 이 필드를 모르면 두 백엔드가 쓰기 직전에 태우는 정규화(`normalizeWorkoutCycle`, §4)가 값을 **조용히 지운다** — 에러도 없이 실측이 전부 근사로 보인다. 사건에 필드를 더할 때마다 정규화에 같은 검사로 넣고, eval에 "쓰기 경계 정규화 뒤에도 보존"을 단언한다(eval:workout "소요시간"이 잠근다). 옛 사건(필드 없음)은 null이 되고, 활성 사이클에 기록을 한 번 쓰면 그 사이클의 옛 사건 전부에 `durationSec: null` 키가 생긴다(의미는 같다 — undefined가 Firestore로 새지 않는 것이 요점).
- **zod는 형식만, 상한은 엔진이 본다.** 라우트는 `z.number().int().min(0).nullable().default(null)`이다. `.nullish()`가 아니라 `.default(null)`인 이유는 배포 스큐다 — version-watch가 자동 새로고침을 하지 않아 며칠 열린 폰 화면(옛 번들)이 필드 없이 보낸 기록이 400으로 날아가지 않게 null로 채운다. 출력 타입이 `number | null`(필수)이라 양방향 계약 검사(§2)도 그대로 묶인다. 3시간 상한(`WORKOUT_DURATION_MAX_SEC` 10800)은 zod에 두지 않는다 — 두면 닫아 둔 채 몇 시간 뒤 끝낸 기록 **전체**가 400이 된다. `decideLog`가 `isValidDurationSec`(정수 0..10800)으로 보고 넘으면 **기록은 받고 소요시간만 null**. 판정·정규화·표시(`eventDuration`)가 이 한 함수를 쓴다. 이것은 §5 "서버는 자기가 계산한 값으로 기록한다"의 유일한 예외(클라이언트 보고값)라 서버는 형식·범위만 검증한다.
- **근사는 저장하지 않는다.** `estimateEventSec`(Σ풀업 reps×3 + Σ푸시업 reps×2 + 수행 스텝×10 + 쉰 휴식×`DEFAULT_REST_SEC` — 계수 `DURATION_ESTIMATE_SEC`)는 읽을 때 엔진이 계산하고 백필로 프로덕션 DB를 고치지 않는다(§5 6 "사건만 저장"). 기본 휴식 2분은 세션 컴포넌트도 `DEFAULT_REST_SEC`을 import한다(정의처 하나 — 옛 `120_000` 리터럴 금지). 화면 문자열("14분 12초"·"약 13분"·섞인 합계 "약 …")의 정의처는 `components/workout-shared.tsx`의 순수 포맷 함수라, eval:workout이 예외적으로 이 화면 파일을 import한다(`lib/kst`·`lib/workout`만 끌어와 store 전이가 없다 — study-qa common.md §0). undo하면 소요시간도 사건과 함께 빠진다.

## 15. 토익이 더한 공통 패턴 — 녹음·기기 전용 보관·파일로 가져오기·60초 상한·하네스 밖 관문

아빠의 영어(토익스피킹, `docs/harness/toeic.md`)가 저장소에 처음 들여온 경로들이다. 토익 전용 규칙은 `toeic.md`에 있고, 여기에는 **다음 기능이 같은 일을 할 때 따를 모양**만 적는다. 운동(§14)처럼 전부 iOS 실기기에서만 끝까지 확인된다.

**녹음 — `lib/mic-session.ts` 한 곳** (저장소 첫 녹음 경로, 클라이언트 전용)

- 오디오 세션 전환·`getUserMedia`·`MediaRecorder`·레벨 미터·WAV 정규화를 이 모듈 한 곳에 둔다. **`navigator.audioSession.type`을 바꾸는 코드는 이 모듈 밖에 두지 않는다** — 순서를 어기면 녹음이 끊긴다.
- 순서: 녹음 직전 `play-and-record` → `getUserMedia` → `recorder.start()`(timeslice 없음 — 단일 Blob이 표준 mp4라 디코드에 유리) → 답변 타이머는 recorder `start` 이벤트에서 → 끝나면 `recorder.stop()` → 트랙 `stop()` → **그다음** `playback`. 녹음 중(`activeCaptures > 0`)에는 `setAudioSessionPlayback()`이 아무것도 하지 않는다(바꾸면 트랙이 끝난다). 녹음하지 않는 구간은 `playback`이어야 비프가 무음 스위치에 묻히지 않고 재생이 수화기로 가지 않는다. API가 없는 브라우저(Safari 16.4 미만 등)는 조용히 넘어간다.
- **재생과 캡처를 시간상 겹치지 않는다.** 질문 음성·비프가 끝난 뒤 녹음을 연다. 답변마다 마이크를 새로 잡고 끝나면 놓는다(전략 A). 유일한 예외가 은우 자유대화다 — 실시간 대화는 마이크를 대화 내내 연다(`acquireMicStream`, §16).
- **`getUserMedia` 대기에는 모듈 안에 상한을 둔다.** 상한 없이 기다리면 권한 창이 탭 밖에서 멈췄을 때 `activeCaptures`가 새어 이후 세션이 `play-and-record`에 갇힌다(QA `qa_report_toeic_m2_1.md` P2-B). 화면 쪽 감시만으로는 모듈 상태를 되돌리지 못한다. 지금은 `getUserMediaWithin`이 답변 `MIC_GUM_TIMEOUT_MS`(8초)·마이크 점검 `MIC_CHECK_GUM_TIMEOUT_MS`(15초)를 넘기면 카운트를 되돌리고 `playback`으로 복귀한 뒤 `MicError("timeout")`을 던지고, 늦게 도착한 스트림은 트랙을 즉시 stop한다. `started`가 거부되면 모듈이 스스로 녹음을 버린다(호출부가 `abort()`를 잊어도 새지 않게). 기다림 상한 4종(gUM·점검 gUM·start·stop)은 이 모듈 한 절에만 두고, 화면의 감시 타이머는 그 숫자를 import한다(`MIC_START_WATCHDOG_MS = MIC_GUM_TIMEOUT_MS`).
- 첫 권한 창은 **탭 안**(마이크 점검 버튼)에서 띄운다. 거부·미지원이면 "녹음 없이 연습"(타이머만)으로 계속 갈 수 있게 한다.
- 형식: Apple WebKit은 `audio/mp4` 우선, 그 밖은 webm/opus(`pickMimeTypeFrom` — 순수, eval이 잠근다). 요청과 실제가 다를 수 있으니 **`recorder.mimeType`을 기록**한다. 서버에 ffmpeg가 없으므로 업로드 전 클라이언트가 16kHz mono 16-bit WAV로 정규화하고(`toWav16kMono`), 디코드가 실패하면 원본을 올린다.
- 모듈 최상위에서 `window`·`navigator`를 읽지 않는다(SSR·eval import 안전). 순수 함수(`mixToMono`·`resampleLinear`·`encodeWavPcm16`·`pickMimeTypeFrom`)는 브라우저 전역 없이 돌아 eval이 잠근다. 서버 로그를 못 보는 폰을 위해 진단(`getMicDiag` — mimeType·길이·크기·정규화 여부)을 화면 캡션으로 보인다(§8의 TTS 진단 관용구).

**기기 전용 보관 — 원본은 서버에 올리지 않는다**

- 녹음 원본은 기기 IndexedDB(`lib/toeic-rec-store.ts`, DB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`)에만 두고, 서버에는 전사문·점수·피드백만 저장한다(원본 미저장 SPEC §13, Firestore 문서 1MB, 버킷 없음). 채점할 때만 한 문항씩 업로드하고 서버는 저장하지 않는다.
- 보관량에 상한을 둔다(최근 `TOEIC_REC_KEEP_ATTEMPTS` 5회분, 지금 응시는 늘 남김 — 순수 판정 `pickAttemptsToEvict`). IndexedDB를 못 쓰면(프라이빗 모드) 이 탭의 메모리로 폴백하고 사실대로 알린다. 다른 기기에서 기록을 열면 "녹음은 응시한 기기에만 있어요"로 안내하고, 녹음이 필요한 동작(AI 채점)을 막는다. 저장 함수는 던지지 않는다.

**몰입 세션 화면 — 운동 관용구를 import하지 않고 따라 새로 쓴다**

- 토익 응시 화면은 운동 세션(§14)의 종료 시각(epoch ms) 타이머·예약 비프·Wake Lock 재요청·전면 오버레이(z 20 + `lockBodyScroll`) 관용구를 **복사해 새로** 썼다(`lib/toeic-audio-cue.ts`·`components/use-toeic-wake-lock.ts`). 실기기 검증이 끝난 운동 코드를 공유 모듈로 뽑아 회귀 위험을 지우지 않으려는 선택이다(`toeic.md` §10). 다음 세션 화면도 공유를 시도하기 전에 이 선택을 따른다.
- 시작 탭 안에서 **동기로** 할 일을 한 번에 한다 — AudioContext 생성/resume, `unlockSpeechPlayback()`, 세션 `playback`, 질문·지시문 프리페치, 첫 음성 `speakQueue`. 그 뒤의 음성은 타이머 콜백(탭 밖)에서 난다.
- 녹음 중 화면이 숨겨지면 즉시 버리고 "중단됨"으로 표시한다. `pagehide`에는 `navigator.sendBeacon`으로 종료를 보낸다 — 그래서 **종료 라우트는 한 번만 받고 두 번째는 409**로 거절하며(판정은 원자 단위 안), 화면은 그 409를 성공으로 본다.
- **개발 전용 시간 배율 훅.** 20분짜리 세션을 e2e로 돌리려고 localStorage `toeic-debug-timescale`(0.01~1)로 단계 종료 시각을 줄인다. `NODE_ENV === "production"`이면 localStorage를 **읽기 전에** 1을 돌려준다(컴파일 때 접힌다 — eval이 소스로 잠근다). 배율 훅을 새로 만들면 같은 가드를 쓴다.

**파일로 가져오기 — 멱등, 저장과 같은 규칙** (`POST /api/toeic/sets/import`)

- 공개 저장소에 둘 수 없는 데이터(출판물 전사본)는 git 밖(`data/private/`, gitignore·`.gcloudignore` 제외)에 두고, **사용자가 앱에서 파일을 골라** 넣는다. 로컬에서 프로덕션 DB로 쓰는 스크립트를 만들지 않고, `migrate-to-firestore`에도 넣지 않는다(CLAUDE.md 서문). `public/`에 두면 PIN 게이트를 우회한다(§7 정적 확장자 예외).
- 파일 형식에 버전 문자열(`toeic-sets/v1`)을 두고, 항목마다 멱등 키(`presetKey` — 소문자·숫자·하이픈 조각)를 둔다. 스토어의 **확인과 생성이 한 원자 단위**(파일 `mutate`, Firestore 트랜잭션)라 두 번 눌러도 같은 키가 두 번 생기지 않는다. 응답은 `{created, skipped}`로 사실대로. 파일 순서가 목록 위→아래가 되도록 `createdAt`을 1ms씩 내린다.
- 가져오기 zod는 **저장과 같은 자리라 판독보다 엄격하다**(사람이 고칠 검토 화면도 후처리도 없다) — 판독에서는 버리는 교차 참조 실수도 여기서는 거부한다. 모르는 최상위 키(출처 메모)는 버린다.
- 400 `issues`에는 경로와 규칙 문구만 싣고 **값은 싣지 않는다**(원문이 응답·로그로 새지 않게). 화면은 경로를 한국어 위치로 바꿔 보인다(`toeicIssueLineKo`).
- 가져오기는 생성이라 prod-guard 대상이 아니다. 반대로 지우는 쪽은 새 `DestructiveOp`(`deleteToeicSet`·`deleteToeicMock`, §6)로 막는다 — 딸린 문서(시험 세션 / 생성 사진·응시 기록)를 먼저, 본 문서를 마지막에 지운다.

**60초 상한 — 한 요청은 한 단위**

- 프로덕션은 Firebase Hosting → Cloud Run 리라이트라 요청 하나에 60초 상한이 있다. 오래 걸리는 AI 작업은 **사진 한 장·묶음 하나·파트 하나·문항 하나 = 요청 하나(또는 한 요청 안의 병렬 호출 하나)**로 쪼개고, 화면이 여러 요청을 병렬로 보낸다(동시 수 상한은 계약 상수 — 채점 `TOEIC_SCORE_CONCURRENCY` 2).
- 한 단위가 그래도 상한을 넘을 수 있고 결과를 잃으면 안 되는 작업(사진 생성)은 **`req.signal`을 넘기지 않고** 서버 쪽 상한만 걸어 끝까지 저장한다. 화면은 실패를 받으면 한 번 새로 읽어 이미 저장됐는지 확인한 뒤에만 실패로 보인다. 같은 인스턴스 안의 같은 작업은 진행 중 약속에 합류시켜(`IN_FLIGHT`) 두 번 과금하지 않는다.
- 반대로 끊기면 멈춰야 하는 작업(전사)은 `req.signal`을 상류까지 넘기고 499 `client_closed`로 끝낸다(§2, `/api/tts`와 같은 비용 가드).

**하네스 밖 관문의 공통 모양** (`lib/tts.ts`·`lib/toeic-image.ts`·`lib/toeic-transcribe.ts` + 자유대화의 `lib/image-gen.ts`·`lib/talk-gateway.ts`)

- Structured Outputs가 아닌 OpenAI 호출(오디오·이미지)은 `callWithSchema`를 지나지 않고 **독립 클라이언트**를 쥔다. 공유하는 것은 키 규약 하나다 — 키가 없으면 네트워크 없이 `no_api_key`, 라우트는 501.
- 모델·품질 env는 `process.env.X?.trim() || 기본값`으로 읽는다(빈 값이 `""`로 새면 400으로 조용히 실패한다, SPEC §11 빈 값 폴백). 모르는 값도 기본값으로 떨어뜨린다.
- 토익 관문 둘(과 뒤에 생긴 사진 공용 코어·관문 R 네트워크)은 throw하지 않고 결과 값(`{ok:true,…} | {ok:false, error, detail}`)을 돌려준다 — 라우트가 사진 칸을 `failed`로 적거나 전사 실패를 `transcribe_failed`로 옮기는 등 상태를 사실대로 기록하게. `lib/tts.ts`는 먼저 생긴 관문이라 throw하고 라우트가 500으로 잡는다(클라이언트는 기기 음성으로 폴백). 새 관문은 결과 값 쪽을 따른다. 로그에는 모델·크기·ms만 남기고 프롬프트·바이트·전사문은 남기지 않는다.

**라우트 입력 오류의 한국어화는 per-parse로만** — 토익 라우트는 `safeParse(raw, { error: toeicZodErrorKo })`(`lib/toeic-zod-ko.ts`)로 zod 기본 문구만 한국어로 바꾼다. 전역 `z.config`나 로캘을 바꾸면 `callWithSchema`가 모델에게 돌려주는 재요청 문구(네 과목)까지 바뀐다.

## 16. 은우 자유대화가 더한 공통 패턴 — 전이중 마이크·사진 공용 코어·저장 멱등·keepalive 바이트·언마운트 정리·실시간 관문과 60초

은우 자유대화(SPEC §21, `docs/harness/english.md` §12, 라우트·관문 R·호출 I는 `english-routes.md` §7)가 들여온 경로다. 여기에는 **다음 기능이 같은 일을 할 때 따를 모양**만 적는다. §15처럼 끝까지는 iOS 실기기에서만 확인된다.

**전이중 마이크 — `acquireMicStream`** (`lib/mic-session.ts`, 녹음기 없이 스트림만)

- 토익 녹음(`startRecording`)은 재생과 캡처를 겹치지 않는다(§15 전략 A). 실시간 대화는 그럴 수 없다 — WebRTC가 마이크 트랙을 **대화 내내** 보내고 선생님 목소리가 그 사이에 나온다. 그래서 같은 모듈에 두 번째 입구를 두었다: `acquireMicStream(opts?) → { stream, release() }`. 녹음기·WAV 정규화는 없고, 세션 전환과 대기 상한과 놓는 순서는 §15 규약 그대로다 — `activeCaptures += 1` → `play-and-record`(캡처 **전**) → `getUserMediaWithin`(기본 `MIC_CHECK_GUM_TIMEOUT_MS` 15초 — 대화 시작 탭이 처음 권한 창을 띄울 수 있어서 토익 마이크 점검과 같은 값) → 실패하면 카운트를 되돌리고 `playback` 복귀 후 `MicError` throw.
- `release()`는 **멱등**이고 순서가 정해져 있다: 트랙 stop → `activeCaptures -= 1` → **그다음** `playback`. 대화 중 다른 화면 코드가 `setAudioSessionPlayback()`을 불러도 `activeCaptures > 0`이라 무시돼 트랙이 끊기지 않는다. WebRTC 쪽(`lib/talk-realtime.ts`)은 `getUserMedia`·`navigator.audioSession`을 직접 부르지 않는다 — 오디오 세션을 바꾸는 코드는 여전히 이 모듈 한 곳이다.
- **탭 핸들러 안에서 동기로** 부른다(async 함수 본문은 첫 await까지 동기로 돌아 getUserMedia 요청이 탭 안에서 나간다). 📞 탭의 동기 구간 순서(`components/talk-start-view.tsx`): `stopSpeaking()` → `unlockSpeechPlayback()`(대화 뒤 설명 낭독이 탭 밖에서도 나게) → 원격 `<audio>` 요소 `play()`(소스는 연결 뒤에 붙는다 — iOS 탭 밖 재생 잠금 해제) → `acquireMicStream()` → 컨트롤러 생성. **주제 일러스트 요청은 마이크를 얻은 뒤** 연결과 병렬로 보낸다 — 마이크 거부·대화 전 끝내기에는 이미지 생성 요청이 0이어야 한다(QA english_talk_1 P2-4, "자동으로 도는 비용은 없다" SPEC §21-4).
- 위험은 실기기에서만 보인다: 재생·캡처가 겹치면 iOS가 소리를 **수화기**로 보내거나 음량을 낮출 수 있고, 스피커 소리가 마이크로 되들어가 선생님이 스스로 끼어들 수 있다(SPEC §21-5 1·2 — 안 되면 이어폰). 전이중이 필요한 다음 기능도 이 입구를 쓰고 같은 실기기 항목을 넘긴다.

**사진 생성 공용 코어 — `lib/image-gen.ts`** (토익 관문 P와 자유대화 주제 일러스트가 공유)

- `generateJpegImage({tag, prompt, model, quality, size, compressions, maxDataUrlChars, signal})` 하나에 모델 env 해석(`resolveImageModel` — `OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2"`)·키 규약(`hasImageApiKey` — 없으면 네트워크 없이 `no_api_key`)·JPEG data URL 조립·**크기 초과 시 다음 압축값으로 1회 재생성**(마지막 값도 넘으면 `too_large`)·로그 모양(태그·모델·품질·압축·크기·ms — 프롬프트·바이트 없음)이 산다. 독립 OpenAI 클라이언트(`maxRetries: 1` — 한 장이 오래 걸려 기본 3회면 너무 길다)를 두 과목이 함께 쓴다.
- 코어는 과목을 모른다 — 차이는 호출부 인자다(`lib/ai/client.ts`에 과목 분기를 두지 않는 것과 같은 원칙). 토익(`lib/toeic-image.ts`): medium·1536×1024·압축 70→50·프롬프트 접미사·태그 `toeic_scene`. 자유대화(`lib/talk-image.ts`): **low**·1024×1024·압축 60→40·상한 `TALK_SCENE_DATA_URL_MAX` 900,000자(계약 파일 정의 — 저장 라우트가 같은 값으로 검사)·태그 `talk_scene`. 자유대화 품질은 env로 바꾸지 않는다(토익 품질 env와 섞이지 않게).
- **코어를 고치면 토익이 함께 움직인다.** 옮길 때 기준은 "토익 동작 불변"이었고, QA가 HEAD의 옛 `toeic-image.ts`와 새 코어판을 같은 루프백 스텁에 돌려 요청(모델·크기·품질·압축·프롬프트 접미사)과 결과(오류 문구 포함)가 바이트 단위로 같은지 봤다. 코어를 바꾸면 `eval:toeic` 오프라인과 이 대조를 다시 한다.
- 실패는 결과 값이다 — 자유대화 장면 라우트는 501/500으로 옮기고 **대화는 그림 없이 그대로 간다**. 저장하지 않는다(대화를 저장할 때 화면이 그림을 함께 보내야 `talkImages`에 들어간다 — 저장하지 않는 대화의 그림이 서버에 남지 않게).

**저장 멱등 — 멱등 키 = 문서 id** (`POST /api/english/talk`)

- 화면 쪽 재시도 경로가 많다(끝남·화면 숨김·"다시 저장"·화면 복귀 자동 재시도·언마운트 정리·pagehide). 응답만 유실돼도 재시도가 새 대화를 만들면 대화·그림이 두 벌 생긴다(QA english_talk_1 P2-1 — 실제로 재현됐다). 그래서 **대화 한 번에 컨트롤러가 멱등 키 하나**(`newTalkSaveId()` — `crypto.randomUUID`, 없으면 `getRandomValues`로 v4)를 만들어 모든 저장 본문에 `clientSessionId`로 싣는다.
- 스토어는 그 키를 **문서 id로** 쓴다(그림 문서도 같은 id). 별도 필드 + 조회는 Firestore에서 쿼리 트랜잭션과 인덱스가 필요하지만, 문서 id면 확인과 생성이 한 원자 단위다: 파일은 `mutate` 한 번, Firestore는 `batch.create`(대화 + 그림) — 문서가 이미 있으면 ALREADY_EXISTS(gRPC code 6, `GRPC_ALREADY_EXISTS`)로 배치 전체가 거부돼 아무것도 써지지 않는다. 그때 대화를 읽어 **같은 `startedAt`이면 기존 대화를 200으로 돌려주고**(`{record, created:false}`), 다르면(키 충돌 — 비정상 클라이언트·난수 충돌) 새 UUID로 만든다. 남의 대화를 돌려주거나 덮지 않고, 409 같은 새 오류 코드도 만들지 않는다(화면 분기가 늘지 않게). 같은 id의 고아 그림만 있어도 새 id로 만든다.
- 멱등 키 형식은 계약 상수 하나(`TALK_SAVE_ID_RE` — 소문자 UUID, Firestore 문서 id 규칙도 만족)를 라우트 zod가 쓴다. 이미지 GET·보기·설명·이름·삭제의 id 판정(`isFirestoreDocId`·`/^[A-Za-z0-9_-]{1,64}$/`)이 모두 통과하는지 확인했다.
- 알려진 끝: 대화를 지운 뒤 같은 키의 늦은 저장이 도착하면 대화가 되살아난다(재시도는 대화 화면에서만 나가 현실 경로는 거의 없다 — QA 2 관찰).

**keepalive는 바이트로 잰다**

- 화면이 숨겨지는 중·문서가 내려가는 중에도 저장이 끝까지 가려면 `fetch(…, {keepalive:true})`가 필요한데, 브라우저 keepalive 본문 한도는 **64KiB = 65,536바이트**이고 **진행 중인 keepalive 요청들의 합**에 걸린다(Chromium 실측 — 40KB 두 개를 동시에 보내면 두 번째가, 64,000바이트를 붙잡은 채 3,000바이트를 보내도 거부된다. 그래서 본문이 작아도 거부될 수 있다). **글자 수(`String.length`, UTF-16)로 재면 틀린다** — 한글 한 글자는 UTF-8 3바이트라 6만 자 미만 본문도 한도를 넘고, 그러면 keepalive fetch가 곧바로 `TypeError`로 거부된다. 모든 재시도가 같은 판정을 되풀이하므로 그 대화는 **영영 저장되지 않는다**(QA english_talk_2 P2-A — Chromium 실측: 한글 6,000자 섞인 56,000글자 = 68,000바이트 → 거부).
- 규칙: 본문 바이트는 `new TextEncoder().encode(body).byteLength`로 잰다(계약 `talkSaveBodyBytes`), 상한 상수는 바이트 의미로 둔다(`TALK_SAVE_KEEPALIVE_MAX_BYTES` 60,000 — 한도보다 조금 작게), 저장 경로는 전부 한 계획 함수를 지난다(`planTalkSaveBody(payload, {unloading})` → `{body, bytes, keepalive, sceneDropped}`). 바이트가 상한 미만이면 keepalive, 넘으면 일반 요청. **pagehide(unloading)이고 그림이 실려 넘으면 그림을 뺀 본문으로 다시 잰다** — 그림보다 대화가 남아야 한다(이 경로로 저장된 대화에는 그림이 없고, bfcache에서 돌아와 전체 본문으로 다시 보내도 멱등이라 그림 없는 대화가 돌아온다 — 감수한 비용). 그림을 빼도 넘으면(아주 긴 전사) keepalive 없이 보낸다.
- **거부되면 한 번은 일반 요청으로 다시 보낸다.** keepalive 요청이 `TypeError`로 거부되면(한도 초과·합산 초과·연결 끊김은 JS에서 구별되지 않는다) 문서가 내려가는 중이 **아닐 때만** keepalive 없이 1회 다시 보낸다 — 같은 본문·같은 멱등 키라 응답만 유실된 경우에도 대화는 하나다. "내려가는 중"은 두 신호로 본다: pagehide 경로가 보낸 저장(`unloading`)과 `unloadingRef`(pagehide에서 켜고 `pageshow` — bfcache 복귀 — 에서 끈다). 내려가는 중에 일반 요청을 보내면 어차피 끊기므로 보내지 않는다. 일반 요청까지 실패해야 "저장하지 못했어요"가 뜬다. 새로 keepalive를 쓰는 기능도 이 모양(바이트 판정 한 곳 + 거부 시 1회 일반 요청)을 따른다. `planTalkSaveBody`의 단위 반례(바이트 경계 59,999/60,000·이모지 4바이트·그림 빼기)는 eval-english 오프라인 "자유대화 저장 본문" 12행(`runTalkSaveBodyChecks`)이 잠근다 — 글자 수로 되돌리거나 pagehide 그림 빼기를 지우면 FAIL이다(QA 3 P2-B → QA 4에서 해소).

**화면이 사라지면 끝낸다 — 언마운트 정리·숨김·pagehide** (`components/talk-call-overlay.tsx`)

- 대화 화면이 사라져도 컨트롤러(타이머·WebRTC·마이크)는 컴포넌트 밖에 산다. 대화 중 뒤로가기(iPhone 가장자리 스와이프·안드로이드 뒤로)로 오버레이만 언마운트되면 아이 마이크가 화면 없이 계속 OpenAI로 흐르고 과금·도움 요청이 이어졌다(QA english_talk_1 **P1-1**). 그래서 세 겹으로 끝낸다.
  - **언마운트 정리**: `controller.end("user")`(전송 close → 마이크 release → hangup 비콘) + 저장이 아직이거나 실패했으면 저장 1회. 개발 StrictMode는 마운트 직후 "정리 → 재실행"을 흉내 내므로 정리를 `setTimeout(0)`으로 한 틱 미루고, 같은 컨트롤러로 재실행되면 취소한다 — 그러지 않으면 dev에서 대화가 마운트 직후 끝난다.
  - **visibilitychange hidden**: 즉시 끝내고 저장을 바로 시작한다(다음 렌더의 효과를 기다리지 않는다 — 숨겨진 뒤 렌더가 늦어도 요청이 먼저 나가게).
  - **pagehide**: 끝내고 `unloading` 저장(진행 중 저장이 있어도 keepalive로 한 번 더 — 진행 중 요청은 끊긴다).
- **이탈은 즉시, 사용자 종료만 기다린다**(2026-09-26 확정). "끝내기" 버튼과 5분 마무리 뒤 종료는 `controller.finish()`로 아직 전사 중인 은우 말을 최대 2.5초 기다린다(그동안 "은우 말을 받아 적는 중…", 버튼 "끝내는 중…"으로 잠김, 도움 카드 숨김 — english-routes §7-4). 위 세 겹(언마운트·숨김·pagehide)과 끊김은 `end()`를 바로 불러 기다리는 중이어도 즉시 닫는다 — 이탈 경로에 기다림을 넣으면 화면 없이 과금·마이크가 2.5초 더 산다. 결과 패널은 선생님이 한마디도 하기 전에 끝난 대화(연결 중 끝내기·첫 인사 전 끊김)에 "다음엔 한마디 해 볼까요?" 대신 "연결되기 전에 끝났어요 — 다시 시작해 볼까요?"를 보인다(판정은 스크립트에 선생님 턴이 있는가).
- 겹친 저장 요청은 수를 세고, 하나라도 성공하면 "저장됨"이 이긴다. 실패 표시는 다른 요청이 진행 중이 아닐 때만. 저장이 실패한 채 숨겨졌으면 화면이 돌아올 때 한 번 더(멱등 키라 첫 요청이 사실 저장됐어도 하나로 남는다).
- `history.pushState`로 뒤로가기를 가로채 결과 패널을 보이는 방식은 **넣지 않았다** — Next 라우터의 popstate 처리, 정상 종료 뒤 중복 항목 정리, `router.refresh()`와 얽혀 위험이 크다. 언마운트 정리와 pagehide만으로 과금·마이크·hangup·저장이 모두 닫힌다(QA 2가 대화 중·연결 중·마무리 중 세 시점과 실제 문서 이탈로 확인).
- 전면 오버레이 관용구는 운동·토익과 같다 — z 20 + `lockBodyScroll`, Wake Lock은 토익 응시 훅 `useToeicWakeLock`(`components/use-toeic-wake-lock.ts`)을 그대로 import한다(대화가 끝나면 푼다).

**실시간 관문과 60초 상한 — 미디어는 우리 서버를 지나지 않는다**

- §15의 "한 요청은 한 단위(60초)"는 여전히 지킨다. 다만 실시간 음성은 브라우저 ↔ OpenAI WebRTC 직통이라 대화 길이(최대 5분)가 요청 상한과 무관하다. 우리 서버를 지나는 것은 SDP 교환(서버 20초 + `req.signal`)·hangup(8초)·장면 그림(55초 + `req.signal` — 화면이 요청을 버리면 상류 생성도 멈춘다)·저장·설명뿐이다.
- 그 대신 **시간 상한과 과금 중지는 클라이언트의 몫**이 된다 — 5분 상한은 컨트롤러가 세고(개발 전용 배율 `talk-debug-timescale`이 곱해진다, production은 1), 끝낼 때마다 서버 hangup을 `sendBeacon`으로 한 번 더 부른다(탭이 닫혀도 간다). 서버는 통화 길이를 강제하지 않는다. 그래서 "화면이 사라졌는데 컨트롤러가 산다"가 곧 과금 사고다(위 언마운트 정리).
- 키 노출 0: 브라우저가 OpenAI와 직접 미디어를 주고받아도 키는 브라우저에 가지 않는다 — 서버가 표준 키로 `/v1/realtime/calls`에 SDP를 대신 넘기고(통합 인터페이스) answer·callId만 돌려준다. 다음 실시간 기능도 임시 클라이언트 키를 브라우저에 주지 않고 이 모양을 따른다(`english-routes.md` §7-2).

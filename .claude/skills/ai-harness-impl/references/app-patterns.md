# 앱 공통 패턴 — 과목과 무관하게 app-builder가 따르는 관용구

> `ai-harness-impl` 스킬에서 **페이지·라우트·저장소·화면**을 만들거나 고칠 때 읽는다. AI 호출 규칙은 SKILL.md 본문에, 과목별 라우트는 `english-routes.md`·`japanese.md`에 있다.
> 원문: `docs/SPEC.md` §15~§19(과목 공통 기능), `docs/DESIGN.md`(디자인), CLAUDE.md 서문(2026-08-17 프로덕션 DB 사고).

여기 적힌 관용구는 대부분 **한 번 사고가 난 자리**에서 나왔다. 규칙만 옮기지 말고 이유도 같이 읽어라. 새 기능이 관용구에서 벗어날 때 무엇을 잃는지는 이유를 봐야 안다.

**목차** — 1 페이지와 `force-dynamic` · 2 라우트 관용구 · 3 계약 파일과 번들 경계 · 4 저장소 이원화 · 5 원자적 쓰기 · 6 prod-guard · 7 PIN 게이트 · 8 발음 관문·낭독 대본 · 9 KST 날짜(해소된 부채 포함) · 10 스트릭 갱신 이벤트 · 11 층·디자인 토큰 · 12 목록 순서변경 · 13 로컬 검증 안전 규칙

## 1. 페이지 — 서버 컴포넌트가 store를 읽는다

- **`getStore()`를 부르는 `page.tsx`에는 반드시 `export const dynamic = "force-dynamic"`을 둔다.** 이게 빠지면 빌드할 때 빈 DB를 읽어 정적 페이지로 굳어 버린다. `/workout`이라면 "처음 시작" 화면이 영구히 박힌다(`app/workout/page.tsx` 주석, SPEC §19-5). 지금 store를 읽는 페이지 24개는 전부 이 선언을 갖고 있다. 대조 방법은 `grep -rla getStore app --include=page.tsx`의 결과가 `grep -rla force-dynamic app --include=page.tsx`의 결과에 포함되는지 보는 것이다. 이 문서의 전수 확인 grep에는 전부 `-a`를 붙인다. NUL 문자가 든 파일을 셸 grep이 조용히 건너뛰기 때문이다(SKILL.md "코드를 grep으로 확인할 때의 함정").
- GET으로 store를 읽는 라우트도 같다. `/api/streak`은 `dynamic = "force-dynamic"`과 `cache-control: no-store`를 함께 쓴다.
- **Next 16 주의:** `cacheComponents`를 켜면 `dynamic` export 자체가 사라진다(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md`의 버전 표). 이 저장소의 `next.config.ts`는 이 설정을 켜지 않았다. 켜려면 store를 읽는 모든 페이지가 정적으로 굳지 않게 막는 수단을 먼저 다른 것으로 옮겨야 한다.
- 서버 컴포넌트가 클라이언트 뷰에 넘기는 props는 **직렬화 가능한 값만** 쓴다. Date 객체를 넣지 말고, undefined 대신 null을 쓴다. "오늘"은 서버가 `kstTodayString()`으로 계산해 props로 넘긴다. 클라이언트가 **렌더 중에** `new Date()`나 localStorage를 읽으면 SSR 결과와 달라져 hydration이 깨진다. localStorage는 마운트 뒤 effect에서만 읽는다(`components/workout-session.tsx`의 `workout-session:v1`).
- 변경이 성공하면 `router.refresh()`로 서버 컴포넌트를 다시 읽게 한다. 라우트 응답에 갱신된 목록을 싣지 않는다(`lib/reorder-contract.ts` 주석).

## 2. 라우트 관용구

`app/api/workout/log/route.ts`가 가장 완전한 견본이다.

| 조각 | 형태 | 왜 |
|---|---|---|
| 런타임 | `export const runtime = "nodejs"` | store(node:fs·firebase-admin)와 openai SDK는 Node가 필요하다. Edge는 Next 16에서 deprecated다. 지금 route.ts 49개가 전부 이 선언을 갖고 있다. 전수 확인은 `grep -a`로 한다. `app/api/japanese/vocab/generate/route.ts`에는 NUL 문자가 있어서 `-a` 없는 grep은 이 파일을 건너뛰고 "선언 없음"으로 잘못 센다(SKILL.md "grep 함정") |
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
| 409 | 요청이 **지금 서버 상태**와 충돌한다. 다른 탭이나 연타로 상태가 이미 바뀌었거나(`conflict`·`stale_state`·`not_active`·`empty`), 이 상태에서는 허용되지 않는다(카드 마지막 1장 삭제 `last_card`) | 메시지를 보이고 `router.refresh()` | 운동 3라우트, `/api/cards/[id]` |
| 501 `no_api_key` | 키가 없다 | 발음은 조용히 기기 음성으로 간다. 생성 기능은 안내를 띄운다 | AI 라우트, `/api/tts` |
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

저장소 전체에서 Firestore 트랜잭션은 운동이 처음이다. 새로 트랜잭션을 쓰면 이유를 주석으로 남긴다(`lib/store-firestore.ts` 운동 절 주석이 견본이다).

## 6. prod-guard (`lib/prod-guard.ts`)

- `assertDestructiveAllowed(op)`은 `NODE_ENV === "production"`이거나 `ALLOW_PROD_DESTRUCTIVE === "1"`일 때만 통과시키고, 그 밖에는 `ProdGuardError`(code `"prod_guard"`)를 던진다. 라우트는 `isProdGuardError(e)`로 판별해 403 `prod_guard`를 준다.
- 가드를 부르는 곳은 **Firestore 구현(`lib/store-firestore.ts`)뿐이다.** 파일 백엔드는 로컬 데이터라 가드하지 않는 것이 관용구다.
- `DestructiveOp`는 7종이다. `deleteBook`·`deleteCard`·`deleteExplanation`·`deleteVocabBook`·`deleteJaVocabBook`(대화 삭제 `deleteJaDialog`도 이 이름으로 막는다)·`undoWorkoutEvent`·`closeWorkoutCycle`.
- 대상을 가르는 기준은 "삭제 API냐"가 아니라 **"가족 기록을 되돌릴 수 없게 잃느냐"**다. 그래서 운동 기록 취소(`undoWorkoutEvent`, 첫 줄에서 가드)와 사건 있는 활성 사이클 닫기(`startWorkoutCycle` 트랜잭션 안, `tx.set` 전에 `closedHadEvents`일 때)가 대상이다. 최초 생성, 사건 0개 사이클의 제자리 교체, 기록(append), 편집(이름·재정렬·해설 재생성)은 대상이 아니다.
- **가드는 삭제만 막는다.** 생성과 수정은 Firestore에 붙은 채로 그대로 실데이터가 된다. 가드는 마지막 방어선일 뿐이고, 로컬 실행을 안전하게 만드는 것은 §13이다.
- 새 파괴적 작업을 만들면 세 가지를 한다. `DestructiveOp`에 이름을 추가하고, Firestore 메서드에서 쓰기 전에 가드를 부르고, 라우트에 403 분기를 둔다.

## 7. PIN 게이트 (`proxy.ts`)

- Next 16에서는 `middleware.ts`가 deprecated되고 이름이 `proxy.ts`로 바뀌었다(export 함수도 `proxy`). 규칙은 `lib/auth.ts`에 있다.
- **허용목록 밖은 전부 게이트 안이다.** 새 페이지나 라우트는 아무 설정 없이 보호된다. 예외는 `/unlock`, `/api/unlock`, `/_next/*`, `/__next*`, 정적 확장자(`STATIC_FILE`)뿐이다. 비용이 나는 라우트(`/api/tts` 포함)는 `PUBLIC_PATHS`에 넣지 않는다.
- 잠긴 상태에서 페이지 요청은 `/unlock?next=…`로 리다이렉트하고, API 요청은 401 JSON `{ ok:false, error:"locked", messageKo }`을 받는다. API에 리다이렉트를 주면 fetch가 HTML을 받아 깨지기 때문이다.
- `gateMode()`는 세 가지다. `APP_PIN`이 있으면 enforce, 없는데 production이면 misconfigured(전부 503으로 막는다), 없는데 개발이면 open이다. 로컬 `.env`에는 APP_PIN이 있어서 dev 서버도 잠긴다. 로컬 e2e는 `APP_PIN=` 접두어로 연다(QA 선례).

## 8. 발음 관문 — 화면은 `lib/speech.ts`만 부른다

화면은 `speechSynthesis`로 직접 말하지 않고, `new Audio`로 음성을 재생하지 않고, `fetch("/api/tts")`를 직접 부르지 않는다. 속도(`getTtsRate`), 언어별 엔진(`getTtsEngine`), 두 겹 캐시, 폴백, 재생 취소 토큰이 전부 이 모듈에 모여 있다. 화면 하나가 우회하면 같은 단어가 화면마다 다른 목소리로 들리고, 연타할 때 소리가 겹치고, 폴백이 깨진다. 지금 `app`·`components`에서 직접 호출은 0건이다. 비프 같은 효과음은 발음이 아니다. `components/workout-session.tsx`는 `AudioContext`를 직접 쓴다.

| API | 쓸 때 | 규약 |
|---|---|---|
| `speak(text, lang?)` | 🔊 한 번 재생 | lang을 생략하면 `en-US`다. 이전 재생을 취소하고 시작한다. 시그니처는 바꾸지 않는다(§16-1) |
| `speakSequence(words, lang?)` | 단어 배열을 한 문장처럼 읽기 | `join(" ")`한 뒤 `speak`를 1회 부른다. 단어마다 쪼개면 로봇처럼 들린다 |
| `stopSpeaking()` | 화면 이탈, 다음 문제로 넘어갈 때 | 단발 재생과 큐를 모두 멈춘다 |
| `prefetchSpeech(texts, lang)` | 화면에 보이는 문장을 미리 합성 | 반환값은 중단 함수다. `useEffect(() => prefetchSpeech(…), [key])`로 쓴다. 새 배치가 오면 직전 배치를 끊는다. 한 화면에서 부모와 자식이 따로 부르면 자식 쪽 효과가 먼저 돌아서 끊긴다. 그러니 한 곳에서 합쳐 부르고, 의존성은 배열 참조가 아니라 문자열 키로 준다(`components/ja-dialog-detail-view.tsx`). device 엔진 언어면 아무것도 하지 않는다. 한 번에 최대 `PREFETCH_MAX_ITEMS`(90)개다 |
| `speakQueue(items, { onItem, onEnd })` | 여러 조각 이어 읽기 | **탭 핸들러 안에서 동기로** 부른다. 첫 await 전에 iOS 재생 잠금을 풀기 때문이다. 반환값은 멈추기 함수다. 정지할 때는 `stopSpeaking`이 아니라 이 함수를 써야 다른 🔊를 죽이지 않는다. `onEnd`는 정확히 한 번 온다. 핸들러 안에서 `speak`/`speakQueue`를 다시 부르면 안 된다(재진입 금지) |
| `unlockSpeechPlayback()` | 탭 밖(타이머 콜백 등)에서 나중에 소리 낼 화면 | 탭 핸들러 안에서 동기로 부른다. 지금 나고 있는 소리는 끊지 않는다(`components/workout-session.tsx`의 ✓ 탭) |

- 공유 상수는 `lib/tts-shared.ts`(런타임 의존 0)에만 둔다. `lib/speech.ts`가 `lib/tts.ts`를 import하면 openai가 폰 번들에 내려간다.
- 새 발음 언어는 `TTS_LANGS`에 추가하면 라우트 zod enum이 따라온다. `lib/tts.ts`의 `TTS_INSTRUCTIONS_VERSION`(지금 2)은 영속 캐시 지문 전체에 걸려 있다. 올리면 **전 언어의 캐시가 비워져** 재합성 비용이 난다. 지시문을 고칠 때만, 그 비용을 감수하고 올린다.
- 폴백이 핵심이다. 키가 없으면(501) 실패하거나 300자를 넘기면 에러 UI 없이 기기 음성으로 간다. 키를 비운 로컬에서 🔊가 기기 음성으로 나는 것이 정상이다. 속도는 전역값 하나를 localStorage에 보존한다(`components/tts-speed-control.tsx`). 엔진 선택 UI는 `components/tts-engine-control.tsx`다.

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
- **스트릭에 세는 기록을 저장한 직후에 쏜다.** 영어 단어 시험(`vocab-quiz-view.tsx`), 일본어 시험(`ja-quiz-runner.tsx`), 한자 시험(`ja-kanji-quiz-runner.tsx`)은 저장에 성공했을 때 쏜다. 운동은 기록·취소·사이클 시작이 성공했을 때와 **409일 때 둘 다** 쏜다(`workout-view.tsx`의 `mutate`·`onSessionResult`). 409는 서버 상태가 이미 바뀌었다는 뜻이라 다시 읽는 것이 맞다. 이 분기가 빠져 있던 것이 과거 QA의 P2였다.
- 무엇을 세는지는 SPEC §17-1이 정한다. 시험(답한 문항 1개 이상)과 운동 "지킨 날"만 센다. 수학, 읽음, 대화 복습, 생성은 세지 않는다. 새로 "세는 기록"을 만들면 `app/api/streak/route.ts`와 이벤트를 쏘는 곳을 **같이** 바꾼다. 스트릭 값은 저장하지 않고 읽을 때 계산한다.

## 11. 층·디자인 토큰

- 디자인의 진실 원천은 `docs/DESIGN.md`다. 값은 `app/globals.css` 한 곳에서 정의한다(`:root` 변수를 `@theme inline`으로 Tailwind에 연결한다). 컴포넌트는 값을 하드코딩하지 않고, CSS 변수나 토큰에 연결된 Tailwind 유틸, 역할 클래스를 쓴다.
- 역할 클래스는 두 종류다. 타이포는 `.t-*`(`t-book-title`·`t-lead`·`t-section-title`·`t-caption`…), 공통 형태는 `.u-*`(`u-btn`·`u-btn-primary`·`u-btn-secondary`·`u-card`·`u-box`·`u-chip`·`u-entry*`·`u-navbtn`·`u-input`·`u-label`·`u-table`…)다. 새 화면은 이 조합으로 만든다.
- **새 색조를 도입하지 않는다.** 흰색, 뉴트럴 그레이, 파랑(`--accent`) 하나만 쓴다. 노랑·초록·빨강은 쓰지 않고, `--danger`는 삭제나 파괴를 확인하는 곳에만 쓴다. 완료·실패 같은 상태는 accent와 ink-3의 명도 차이에 글리프(✓ ✗)를 더해 구분한다(SPEC §19-6). 버튼 최소 높이는 `--tap-min`이다.
- 층: 스트릭 헤드라인은 `sticky top-0` `z-[15]`이고 높이는 `--streak-h`(40px)다. 다른 sticky 요소는 `top: var(--streak-h, 0)`로 그 아래에 붙인다(`english-nav.module.css`, `ja-dialog-coaching-view.module.css`). 몰입하는 전면 오버레이는 z-index 20에 `lockBodyScroll()`(`lib/scroll-lock.ts`, 참조 카운트라 중첩해도 안전)을 쓴다. 오버레이가 헤드라인을 가리는 것은 의도다. 인쇄에서 뺄 UI에는 `print-hide`를 붙인다.
- 최종 검증 기기는 폰이다. 390px과 360px에서 문서 전체에 가로 스크롤이 생기지 않는지 본다.

## 12. 목록 순서변경 (SPEC §15-1)

새 목록에 순서변경을 붙일 때는 이미 있는 프리미티브를 그대로 쓴다. 라이브러리는 추가하지 않는다.

- 화면은 `components/use-reorder.ts`를 쓴다. 이 훅은 id 순서만 알고, 포인터 드래그·자동 스크롤·↑/↓·키보드·낙관적 반영과 실패 시 되돌리기를 처리한다. **관리 모드일 때만** 켠다(`enabled`). 평소에 드래그 핸들이 있으면 모바일 세로 스크롤과 충돌한다.
- 요청 계약은 `lib/reorder-contract.ts`의 범용 `{ orderedIds }` 하나다. zod 값(`reorderRequestSchema`)은 라우트에서만 쓴다. 빈 배열·중복·`REORDER_MAX_IDS` 초과를 거절하고, Firestore 문서 id 규칙(`isFirestoreDocId`: `/` 없음, `.`·`..` 아님, `__.*__` 아님, 올바른 UTF-8, 1,500바이트 이하)을 어기는 id도 400으로 막는다(2026-09-25). Firestore `col.doc("a/")`는 문서 `a`를 가리키므로, 막지 않으면 같은 요청에 두 백엔드 결과가 갈린다. 실제 저장 id(randomUUID, 자동 id 20자)는 전부 통과한다. 지금 라우트는 `/api/library/reorder`·`/api/math/reorder`·`/api/english/vocab/reorder`·`/api/japanese/vocab/reorder`·`/api/japanese/dialog/reorder` 다섯이다.
- 저장: 레코드마다 `sortIndex: number | null`(필수 nullable)을 둔다. 생성 입력 타입(`New*`)에서는 `sortIndex`를 `Omit`한다. 스토어가 null로 태어나게 하므로 새 항목은 맨 위에 뜬다. `reorder<X>(orderedIds)`는 넘어온 id들을 0..n으로 재색인하고 **목록에 없는 항목은 건드리지 않는다.** Firestore는 다섯 `reorder<X>`가 공유 본체 `reorderBySortIndex(db, col, orderedIds)`(`lib/store-firestore.ts`)를 부른다. **없는 id는 두 백엔드 모두 조용히 건너뛴다**(계약 주석 "존재하지 않는 id는 스토어가 조용히 건너뛴다"). 파일 백엔드는 `rank.get(id)`가 있는 레코드만 바꾸고, Firestore는 `getAll(...refs, { fieldMask: ["sortIndex"] })`로 존재하는 문서만 걸러 batch update한다(`BATCH_LIMIT` 단위 청크). `isFirestoreDocId`를 통과하지 못한 id는 `doc()`에 넘기지 않고 건너뛴다(계약과 같은 판정이라 스토어를 단독으로 불러도 파일 백엔드와 같다). **해소된 부채(2026-09-25):** 예전 Firestore 구현은 넘어온 id마다 `WriteBatch.update`를 걸어, 다른 탭에서 지운 id 하나가 배치 전체를 NOT_FOUND로 거부시켜 라우트가 500 `save_failed`를 줬다. 인덱스는 파일 백엔드와 같은 규칙이다 — 넘어온 **위치** 그대로(없는 id 자리는 당기지 않고 비운다), 중복이면 마지막 위치가 이긴다. 확인과 커밋 사이에 지워지면(NOT_FOUND, code 5) 한 번만 다시 걸러 쓴다(값이 고정이라 멱등). 에뮬레이터가 없어 이 함수는 db를 주입받는다 — 가짜 db로 검증한다. 새 목록을 붙이면 Firestore 쪽도 이 함수를 부르고 `batch.update`를 직접 걸지 않는다. 정렬은 페이지나 뷰가 한다. null이 먼저 오고(createdAt 역순), 그 뒤 sortIndex 오름차순이다.
- **부분 목록에서는 재배치를 끈다.** 필터나 검색으로 일부만 보일 때 재색인하면 숨은 항목과 인덱스가 겹친다. 수학 목록은 '전체'가 아니면 끄고, 서재는 검색 중에 끈다. 삭제는 필터와 무관하게 유지한다.
- 순서 변경은 수정이라 prod-guard 대상이 아니다. 성공하면 `router.refresh()`로 서버 순서를 확정한다.

## 13. 로컬 검증 안전 규칙

- **모든 로컬 실행에 접두어를 붙인다:** `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT=` (e2e라면 `APP_PIN=`도). `STORE_BACKEND=file`은 자동 감지에 기대지 않으려고 명시한다. 키를 비우면 AI 라우트와 `/api/tts`가 501로 거절해서 실호출이 0이 된다. GCP 변수까지 비우면 쉘에 남은 자격증명 신호도 끊긴다.
- 서버를 띄웠으면 **데이터를 쓰기 전에** 로그에 `[store] backend=file (STORE_BACKEND 명시)`가 찍혔는지 확인한다.
- **db.json 백업과 복원:** 쓰기가 있는 검증을 하기 전에 `data/db.json`을 scratchpad로 복사하고 `shasum`을 기록한다. 끝나면 되돌린 뒤 shasum이 같은지, `data/db.json.tmp`가 남지 않았는지 확인한다(`_workspace/qa_report_streak-workout_e2e_1.md`의 "복원" 절이 선례다). `data/`는 gitignore 대상이다.
- `npm run seed`는 파일 전용이다. `mergeDbForSeed`가 `readDb`·`writeDb`를 직접 쓰므로 Firestore는 건드리지 않는다. 다만 db.json에 시드 레코드를 upsert한다.
- 공통 기능을 고쳤으면 오프라인 eval(`eval:streak`·`eval:speech`·`eval:workout`)부터 돌린다. 셋 다 store를 import하지 않는다.
- **하지 않는다:** `migrate-to-firestore` 실행, `ALLOW_PROD_DESTRUCTIVE=1`, `.env`의 `STORE_BACKEND`나 GCP 자격증명 줄 채우기, 서브 에이전트에게 어느 DB를 향하는지 알리지 않고 검증 맡기기(2026-08-17 사고의 직접 원인).

## 14. 운동 세션 알림 — 비프·진동·음성·Wake Lock (SPEC §19-6)

휴식 타이머 종료 알림은 **전부 best-effort**이고 기준은 시각 타이머(종료 시각 epoch ms)다. 규칙의 진실 원천은 `components/workout-session.tsx` 머리 주석과 SPEC §19-6이다. 알림을 고치거나 새 세션 화면을 만들 때 아래를 지킨다 — iOS는 **탭 밖 재생**을 막아서, 탭 안에서 해 둘 일을 빼먹으면 소리가 조용히 안 난다.

- **비프는 발음 관문 밖이다**(§8) — `AudioContext`를 직접 쓴다. 컨텍스트는 모듈 싱글턴(iOS는 컨텍스트 개수에 제한이 있다). `▶ 운동 시작`·`✓` 탭 핸들러 안에서 **동기로** `ensureWorkoutAudio()`(만들거나 `resume()`)를 부르고, 휴식 종료 시각에 `scheduleBeep`로 **미리 예약**한다(탭 밖에서 새로 재생하지 않으려고).
- 휴식 길이를 바꾸거나 `+30초` 하면 예약을 다시 건다(`rescheduleBeep`). `finishRest`(타이머 콜백)는 예약분이 아직 안 울렸으면(컨텍스트가 멈춰 있었다 등) 그 자리에서 울리고 예약분은 취소한다 — 단 컨텍스트가 `running`일 때만이다(`interrupted`·`suspended`면 비프는 생략되고 진동·음성만 간다).
- 새로고침 뒤 진행 복원(`workout-session:v1`)에서는 컨텍스트가 `running`일 때만 남은 시간에 비프를 재예약한다.
- **음성 안내**(토글 `workout-voice:v1`, 기본 켬)는 발음 관문을 탄다 — `✓` 탭에서 `unlockSpeechPlayback()`, 휴식 끝에 `speakQueue([{ text, lang: "ko-KR" }])`. 세션 시작 탭에서 휴식 뒤 안내 9개를 `prefetchSpeech(…, "ko-KR")`로 미리 받는다(첫 스텝 안내는 휴식 뒤에 안 나오므로 뺀다). ko 기본 엔진이 cloud라 **키를 넣은 dev 서버에서는 실호출**이다.
- 진동은 `navigator.vibrate?.(…)`(iOS는 지원하지 않아 무시되는 것이 정상), 화면 꺼짐 방지는 Wake Lock 요청 + visible 복귀 때 재요청(지원 안 하면 조용히 넘어간다).


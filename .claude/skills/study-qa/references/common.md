# 과목 공통 기능 검증 — 순서변경·읽기 속도·발음·해설 낭독·스트릭·아빠의 운동 (subject = `common`)

> `study-qa` 스킬에서 subject가 `common`일 때 읽는다. 과목별 검증은 `english.md`·`math.md`·`japanese.md`에 있다.
> 원문 스펙: `docs/SPEC.md` §15-1(목록 순서변경), §15-2(읽기 속도), §16(클라우드 발음, §16-5 보강), §17(학습 스트릭, §17-7 운동 트랙), §18(해설 낭독), §19(아빠의 운동). §15-3(단어장 유의어·반의어 연결)은 영어 단어장 기능이라 `english.md`에서 검증한다. 구현 관용구는 `.claude/skills/ai-harness-impl/references/app-patterns.md`에 있다.

> **grep 주의** — 이 문서의 grep 명령에는 전부 `-a`가 붙어 있다. 빼지 마라. Claude Code 셸의 `grep`은 `-I`로 감싼 ugrep이라, NUL 문자가 든 파일을 바이너리로 판정하고 **조용히 건너뛴다.** 지금 그런 파일은 `components/use-reorder.ts`, `lib/vocab-quiz.ts`, `app/api/japanese/vocab/generate/route.ts` 셋이다. `-a` 없이 얻은 "0건"은 판정 근거가 되지 않는다. 이 세 파일에 위반이 생겨도 0건이 나오기 때문이다.

공통 기능에는 4중 정의 매트릭스가 없다. AI를 쓰지 않거나(순서변경·속도·스트릭·운동), 쓰더라도 Structured Outputs가 아닌 관문이기 때문이다(발음). 그래서 검증의 무게중심이 다르다.

1. **순수 함수와 상태 기계가 틀린 입력을 실제로 거부하는가.** 오프라인 eval을 돌리고 반례를 넣어 본다. eval이 통과했다는 사실만으로는 규약이 잠겼다고 볼 수 없다. 변이 테스트로 eval의 힘을 잰다(§6).
2. **여러 화면이 관문 하나를 공유하는가.** 화면 하나가 우회하면 규약 전체가 조용히 깨진다(속도·엔진·폴백·스트릭 갱신·순서변경 계약).
3. **실기기에서만 드러나는 것을 미검증으로 정직하게 남기는가.** iOS 오디오와 폰 폭 레이아웃이 여기에 해당한다(§7·§8).

## 0. 오프라인 eval 3종 — 먼저 돌린다

셋 다 실호출 0회다. `CheckResult`·`add`·`printTable` 관용구를 쓰고, 실패하면 exit 1로 끝난다. `.env`를 읽지 않는다(`loadEnvFile` 호출 없음). 그래도 접두어는 붙인다.

```bash
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm run eval:speech
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm run eval:streak
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npm run eval:workout
```

| 스크립트 | 대상 | import 경계 | 출력 영역 (항목 수는 2026-09-24 실측) |
|---|---|---|---|
| `scripts/eval-speech.ts` | `lib/ja-coaching-script.ts` 대본·쪼개기, `lib/speech.ts` 큐, `lib/tts-shared.ts`·`lib/tts.ts` 상수, `lib/tts-cache.ts` 지문 | store 금지. `lib/speech`·`lib/tts`·`lib/tts-cache`는 fetch 스텁을 깔고 키를 비운 **뒤에** dynamic import한다 | 대본·쪼개기·상수·엔진·큐·지문·안전 (71) |
| `scripts/eval-streak.ts` | `lib/streak.ts`의 `computeStreak`·`computeStreakFromDays`, `lib/kst.ts` | `../lib/streak`·`../lib/kst`만 | KST 환산·연속 판정·0문항 제외·사람 분리·날짜 코어 (20) |
| `scripts/eval-workout.ts` | `lib/workout.ts` 전체, `diffDateStrings` | `../lib/workout`·`../lib/kst`·`../lib/streak`만 | 베이스·계획·스텝·횟수·상태·판정(`decideLog`·`decideUndo`·`decideStart`·`closingStatus`)·활성 선택·격리·정규화·날짜 방어·진행·볼륨·일정·스냅샷·지난 사이클·운동 스트릭 (122) |

- **import 경계 자체가 검증 항목이다.** eval이 store를 import하면 어느 DB를 향할지 모르는 스크립트가 된다. 판정은 두 단계로 한다.
  - `grep -an 'lib/store' scripts/eval-speech.ts scripts/eval-streak.ts scripts/eval-workout.ts`가 **0줄**이어야 한다.
  - `grep -anE 'from "\.\./lib/|import\("\.\./lib/' scripts/eval-speech.ts scripts/eval-streak.ts scripts/eval-workout.ts`로 eval이 닿는 lib 모듈을 전부 뽑는다. 그 모듈들의 import에도 같은 grep을 한 단계 더 돌려 store가 전이로 딸려 오지 않는지 본다.
  - `^import`로 줄 머리만 잡으면 안 된다. `eval-speech.ts`·`eval-workout.ts`는 `import {`로 시작해 몇 줄 아래에서 `} from "../lib/…"`로 끝나는 여러 줄 import를 쓴다. `^import` 방식은 모듈 경로가 적힌 줄을 놓치고, 그 자리에 store가 들어와도 보이지 않는다.
- 항목 수가 줄었으면 그 자체가 회귀 신호다. 반대로 항목 수가 늘었다고 eval이 강해졌다는 뜻은 아니다. 해설 낭독 QA에서 eval이 53/53을 통과했는데, iOS의 핵심 가드(무음 WAV `play()`)를 지운 변이가 살아남은 전례가 있다(`_workspace/qa_report_ja-coaching-tts_1.md` F1, 그 뒤 ⑭로 보강).

## 1. 클라우드 발음 (§16) — 관문 하나로 모이는가

| 검증 | 방법 | 실패의 의미 |
|---|---|---|
| 화면이 관문을 우회하지 않는다 | `grep -rna "speechSynthesis\|SpeechSynthesisUtterance\|/api/tts\|new Audio" app components` 결과에서 `app/api/tts` 밖은 주석뿐이어야 한다. 효과음용 `AudioContext`(`components/workout-session.tsx`)는 발음이 아니라 대상 밖이다 | 속도·엔진·폴백·취소가 화면마다 갈린다 |
| `speak()` 회귀 | `speak(text, lang = TTS_LANG)` 시그니처가 그대로인지 본다. eval ⑰은 `speak()`가 재생마다 `new Audio`를 쓰고 큐 요소를 재사용하지 않는지 확인한다 | 영어 6화면·일본어 화면 전부 회귀 |
| 폴백은 조용해야 한다 | eval ⑥(POST 500이면 그 조각만 기기 음성), ⑦(501을 한 번 받으면 이후 POST 0). 키를 비운 dev에서 🔊를 눌러 `/api/tts` 501 → 기기 음성으로 가고 에러 UI가 뜨지 않는지 본다 | 앱이 조용해진다(§16-2) |
| 상한의 정의처는 하나다 | `TTS_TEXT_MAX_CHARS`(300)는 `lib/tts-shared.ts`에서 정의하고, 라우트 zod·`lib/speech.ts`·`lib/ja-coaching-script.ts`가 import한다 | 클라이언트는 보내는데 서버는 400을 준다 |
| 라우트 | `app/api/tts/route.ts` POST는 키 검사(501)를 파싱보다 **먼저** 한다. zod는 text(trim 1~300)·lang(`TTS_LANGS` enum)·speed(0.25~4)다. GET은 OpenAI를 부르지 않고 `{voice, model, instructions}`만 준다 | |
| 번들 경계 | `lib/speech.ts`의 값 import가 `./tts-shared`·`./tts-cache`뿐인지, `lib/ja-coaching-script.ts`는 `./tts-shared`와 `import type`뿐인지 본다. build 뒤 `.next/static`을 `grep -rla`해 openai SDK의 흔적(기본 주소 `api.openai.com`)과 키가 0건인지 확인한다 | openai가 폰 번들로 내려간다 |
| 캐시 지문 | eval에서 `TTS_INSTRUCTIONS_VERSION === 2`를 확인한다. 값이 올라갔으면 이유를 묻는다. 올리면 전 언어의 영속 캐시가 비워지는 비용이 난다(§18-3) | 재합성 요금 |
| 기본 엔진 | `DEFAULT_ENGINE`은 ko=cloud·ja=device·en=cloud여야 한다(eval "상수·엔진") | 해설의 일본어 인용을 한국어식으로 읽는다 |

## 2. 해설 낭독 (§18) — `speakQueue` 계약

`eval:speech`는 가짜 `window`·`Audio`·`speechSynthesis`·`fetch`·`URL`을 전역에 깐 뒤 큐를 돌린다. 계약별로 무엇이 잠겨 있는지 대조한다(번호는 eval 출력의 점검 번호다).

| 계약 | 잠그는 점검 |
|---|---|
| **정지는 동기로 일어난다** — `onEnd("stopped")`는 stop, `speak()`, 새 `speakQueue()`가 **반환되기 전에** 온다 | ② 중간 stop(동기 1회, 두 번째 stop은 no-op), ③ 재생 중 `speak()`, ④ 새 큐(옛 onEnd가 새 `onItem(0)`보다 먼저 옴) |
| 밀려난 큐의 stop이 뒤에 시작한 재생을 죽이지 않는다 | ⑤·⑤′ |
| `onEnd`는 정확히 1회 온다 | ①, ②, ⑪(빈 items는 microtask로 `"done"` 1회, 진행 중인 `speak` 오디오를 멈추지 않는다) |
| 폴백은 조각 단위로 한 방향이다 | ⑥, ⑦, ⑩(ko 엔진이 device면 POST 0), ⑫(합성 대기 타임아웃이면 그 조각만 기기 음성), ⑬(연속 3조각이 무음이면 `"stopped"`), ㉑(대기 기산점은 큐가 기다리기 시작한 때), ㉒(타임아웃이 나도 요청은 유지) |
| look-ahead는 중복 합성이 없고 2개에서 멈춘다 | ①(POST 수 == 고유 조각 수), ⑱(다음 cloud 조각 2개만 받고 device 조각은 세지 않는다) |
| objectURL을 회수한다 | ⑨(정상 종료와 중간 정지 모두 create 수 == revoke 수, 무음 URL은 제외), ㉓(남은 URL 0) |
| iOS 재생 잠금 | ①(오디오 요소 하나 재사용), ⑭(첫 await 전 잠금 해제: 큐 요소 src=무음 WAV + `play()`), ⑮(외부 pause가 오면 `"stopped"`), ⑲(말하는 중일 때만 cancel), ⑳(무음 재생 중 src를 바꿀 때 오는 낡은 pause는 무시), ㉓(재생 안전 타임아웃) |
| 지문 재시도 | "지문" 영역 — 일시 실패하면 이번 조회만 메모리로, 세션당 3회 상한, 동시 조회는 1회로 합치고, put은 조회를 일으키지 않는다 |
| 대본 | "대본" 영역 — (section, lang, text, item) 순서가 §18-1 표와 같다. 일본어 조각 == 원문.trim()(캐시 키 일치). `coachingJaTexts` ⊆ 일본어 조각. `normalizeKoForTts`는 한국어에만 적용 |
| 쪼개기 | "쪼개기" 영역 — 모든 조각 ≤ max, join 불변식, `3.5배`는 안 자름, `。` 뒤는 자름, `」`는 앞 조각에 붙임, 번호 목록 머리, 서로게이트 보존 |

**eval이 잠그지 못하는 것은 코드로 읽는다.** 저장소에 jsdom도 eslint 설정도 없어서 React 런타임은 코드 리뷰나 dev 렌더(§7)로 확인한다.

- `components/ja-dialog-coaching-view.tsx`의 `startFrom`이 onClick 안에서 `speakQueue`를 **동기로** 부르는지 본다. 사이에 await나 setTimeout이 있으면 안 된다. 실행 번호(`runRef`)로 옛 `onItem`/`onEnd`를 무시하는지 본다. 정지할 때 `stopSpeaking()`이 아니라 **큐가 돌려준 stop**을 쓰는지 본다. 언마운트와 대본 내용 키 변경에는 멈추고, `router.refresh()`("단어장에 담기")에는 멈추지 않아야 한다.
- 프리페치: 상세 화면(`components/ja-dialog-detail-view.tsx`)은 전사와 `coachingJaTexts`를 **한 번에** 부르고, 의존성은 문자열 키(`join("\u0001")`)여야 한다. 해설 뷰에는 `prefetch={false}`를 넘긴다. 따로 부르면 자식 쪽 배치가 부모 쪽에 항상 끊긴다(§18-5).

## 3. 학습 스트릭 (§17)

| 검증 | 방법 |
|---|---|
| KST 정의처가 하나인가 | `grep -rna -e "9 \* 60 \* 60" -e "Asia/Seoul" -e "toLocaleDateString" app components lib`의 결과가 `lib/kst.ts` 밖에서는 0건이어야 한다. `toLocaleString`은 숫자 서식에만 쓰였는지 확인한다 |
| UTC 날짜부 자르기 | 위 grep은 ISO 시각을 잘라 UTC 일자를 얻는 패턴을 잡지 못한다. `grep -rnaE '\.slice\(0, *10\)' app components lib`를 따로 돌려 결과를 셋으로 나눈다. ① 읽음 기록의 `readAt.slice(0, 10)`은 정상이다. `readAt`이 기기 날짜 문자열(`deviceDateString`)이기 때문이다. 날짜가 아닌 배열 자르기도 정상이다. ② "만든 날짜" 표시에서 `createdAt.slice(0, 10)`이나 `formatDate(iso)` 안의 `iso.slice(0, 10)`을 쓰는 곳은 **기존 부채**다. 목록은 app-patterns §9에 있다(상세 페이지 4곳, 목록 뷰 5곳, `card-view.tsx`). 이번 변경과 무관하면 "기존 부채"로 따로 적고 P2로 둔다. ③ 그 목록에 없는 **새** 위치는 이번 변경의 결함이다 |
| 자정 경계 | eval "KST 환산": 15:00Z는 다음 날, 14:59Z는 같은 날 |
| 시험만 세고, 답한 문항이 1개 이상이어야 한다 | eval "0문항 제외"(answered null·false). `app/api/streak/route.ts`가 스트릭을 **세는 데** 쓰는 컬렉션이 `listAllVocabQuizzes`·`listAllJaQuizzes`·`listJaKanjiQuizzes`·`listWorkoutCycles` 넷뿐인지 본다. 오늘 라벨(`todayLabel`)을 만들려고 `getVocabBook`·`getJaVocabBook`으로 단어장 이름을 읽는 것은 허용한다. 수학·읽음·대화 컬렉션이 끼면 실패다 |
| 사람·트랙 분리 | eval "사람 분리"와 "날짜 코어"에는 섞으면 값이 달라지는 반례가 있다. 라우트에서 eunwoo=vocab, appa=jaVocab+jaKanji, appaWorkout=`workoutKeptDays`가 한 집합에 섞이지 않는지 코드로 확인한다 |
| 코어 분리 회귀 | eval "날짜 코어": `computeStreak` == 세션 → 일자 집합 → `computeStreakFromDays`(5/5) |
| 운동 트랙 폴백 | `listWorkoutCycles`가 실패하거나 계산이 throw하면 `appaWorkout`만 `NEUTRAL_STREAK`가 되고 은우·일본어는 살아야 한다. 파일 백엔드에서는 운동만 실패시킬 수 없으므로 코드로 확인하고 e2e는 미검증으로 남긴다(선례) |
| 응답 계약 | `StreakResponse {ok, today, eunwoo, appa, appaWorkout}`(`lib/streak-contract.ts`)와 `components/streak-headline.tsx`가 읽는 필드를 함께 열어 본다. `appa`는 이름만 호환용이고 실제로는 일본어 트랙이다 |
| 즉시 갱신 | `STREAK_REFRESH_EVENT`를 쏘는 곳: `vocab-quiz-view.tsx`·`ja-quiz-runner.tsx`·`ja-kanji-quiz-runner.tsx`(저장 성공), `workout-view.tsx`(ok **와 409**, `mutate`·`onSessionResult`). 409 분기가 빠져 있던 것이 과거 P2였다. 전수는 `grep -rla STREAK_REFRESH_EVENT components app`로 본다 |
| 헤드라인 | 초기 렌더는 중립(`🔥··일`)이다가 마운트 후 채워진다(SSR HTML로 확인). `/unlock`에서는 숨긴다. `z-[15]`로 오버레이(20)보다 아래다. 겹친 재조회는 마지막 것만 반영한다(`seq`). `print-hide` |

**운동 트랙의 "지킨 날"**(§17-7)은 eval:workout의 "운동 스트릭" 영역이 잠근다. 휴식일이 끊지 않는지, 실패일·회복 휴식을 포함하는지, 운동일을 건너뛰면 끊기는지, 마무리 휴식을 하루씩 세는지, 재측정 대기일은 빼고 재측정을 끝낸 날(도중 abandoned 포함, 사건 0개 사이클 제외)은 넣는지, 미래 휴식과 시작 전은 빼는지, 슬롯을 닫힌 날과 다음 사건 전날에서 자르는지, 오늘이 휴식이면 doneToday인지를 본다. 70일 시뮬레이션도 포함돼 있다.

**API 시나리오 e2e 방법**(`_workspace/qa_report_streak-workout_e2e_1.md`): db.json의 `workoutCycles`를 스펙대로 직접 구성한 뒤 `curl /api/streak`를 부르고, 스펙으로 **손계산한** 기대값과 JSON으로 대조한다. 기대값을 계산할 때 구현 코드를 import하지 않는다. 구현으로 기대값을 만들면 같은 버그를 두 번 쓰는 셈이다. 시나리오마다 은우·일본어 시험을 섞어 한 번 더 돌려 트랙이 오염되지 않는지 본다.

## 4. 아빠의 운동 (§19)

eval:workout이 잠그는 것은 이렇다. **원안 오라클**: 원안 Python 생성기를 JS로 옮겨 20개 운동일과 RM 1~150 전 범위를 대조하고, §19-1 표 10행과 합계 590·890을 본다. **재생 상태 기계**: 휴식은 달력이 채우고 운동일은 기다린다. 실패 → 회복 → 재부여 → 재도전, Day 7 실패 시 Day 5 목표로 가고 휴식을 다시 넣지 않는다, retestHint 루프, 월 경계를 본다. **판정**: `decide*`의 stale_state·conflict·not_active·empty, rev ABA, 결정성, 서버 계산값. **방어**: 깨진 사건 버리기, `snapshot`이 던지지 않는지.

**eval이 잠그지 않는 것은 코드로 대조한다.**

| 검증 | 방법 |
|---|---|
| prod-guard | `lib/store-firestore.ts`에서 `undoWorkoutEvent` 첫 줄이 `assertDestructiveAllowed("undoWorkoutEvent")`인지 본다. `startWorkoutCycle`은 트랜잭션 안에서 `tx.set` **전에** `if (r.closedHadEvents) assertDestructiveAllowed("closeWorkoutCycle")`을 불러야 한다. `logWorkoutEvent`와 파일 백엔드에는 가드가 **없어야 정상**이다. `/cycle`·`/undo` 라우트는 `isProdGuardError`이면 403을 준다. Firestore 실행은 안전 규칙상 하지 않으므로 코드 대조까지만 하고, 그 결과는 미검증으로 표기한다 |
| force-dynamic | `app/workout/page.tsx`에 `export const dynamic = "force-dynamic"`이 있는지 본다. 빠지면 빌드할 때 "처음 시작" 화면으로 굳는다. 전 페이지도 대조한다. `grep -rla getStore app --include=page.tsx`의 결과가 `grep -rla force-dynamic app --include=page.tsx`의 결과에 포함되어야 한다 |
| 원자성 | 파일 백엔드는 `decide*`를 `mutate` 콜백 **안에서** 부르고, Firestore는 `runTransaction` 안에서 읽기를 먼저 끝낸다. 새 id(`randomUUID()`·`col.doc().id`)와 `todayKst`·`nowIso`는 원자 단위 밖에서 한 번만 정한다 |
| 계약 양방향 | 라우트 3개(`app/api/workout/{cycle,log,undo}/route.ts`)의 `requestMatchesSchema` 한 줄과 `tsc --noEmit` |
| zod | 코드에 `.nullish()`가 없어야 한다(`log` 라우트에는 금지 이유를 적은 주석 한 줄이 있다. 그건 정상이다). RM 경계는 `RM_MIN`/`RM_MAX` 상수를, log의 day는 `LAST_WORKOUT_DAY`·`isWorkoutDay`를 쓰는지 본다 |
| DbShape 네 곳 | `emptyDb`·`readDb`·`mergeDbForSeed`(`mergeById`)·`scripts/seed.ts`. `npm run seed` 전후로 `workoutCycles` 개수가 같은지 본다(백업한 db.json으로) |
| 이관 제외 | `scripts/migrate-to-firestore.ts`의 목록에 `workoutCycles`가 없어야 한다 |
| 화면 | 409면 `messageKo` 표시, `router.refresh()`, 스트릭 이벤트가 따라오는지. 세션 진행(`workout-session:v1`)을 마운트 후 effect에서만 읽는지, cycleId·rev·day·targetDay·dateKst가 전부 같을 때만 복원하는지 본다 |

**409 재현**: `/workout`을 열어 둔 채 db.json에 사건 하나를 추가하고 rev를 +1해 "다른 탭이 이미 기록함"을 흉내 낸다. 그다음 `✓ 전부 해냈어요`를 누른다.

**"세션 소리가 안 나" 신고는 먼저 가른다** — 비프(Web Audio, 발음 관문 밖)인지 음성 안내(`speakQueue` ko-KR)인지. 코드로 대조할 것(`components/workout-session.tsx`, `ai-harness-impl/references/app-patterns.md` §14): `▶`·`✓` 탭 핸들러 안에서 **동기로** `ensureWorkoutAudio()`를 부르는지, 휴식 시작 때 `scheduleBeep`로 종료 시각에 미리 예약하는지, 길이 변경·`+30초`에서 `rescheduleBeep`가 도는지, `finishRest`가 예약분 미재생 시 즉시 울리고(컨텍스트 `running`일 때만) 예약분을 취소하는지, 복원 시 `running`일 때만 재예약하는지, `✓` 탭에서 `unlockSpeechPlayback()`을 부르는지, 음성 토글(`workout-voice:v1`)이 새로고침 뒤에도 유지되는지. 음성 쪽은 §1·§2의 발음 경로 검증을 그대로 쓴다(ko 엔진이 cloud인지 device인지부터).

## 5. 목록 순서변경·읽기 속도 (§15-1·§15-2)

두 기능 모두 AI가 없고 오프라인 eval도 없다. 그래서 반례를 직접 넣고 코드를 가로로 대조한다. 목록 하나하나의 경계(일본어 단어장·대화의 `onPersist`와 서버 정렬)는 `japanese.md`에 있다. 여기서는 **다섯 목록이 같은 계약을 지키는지**를 본다. 순서변경은 목록마다 복사해 붙인 코드라서, 한 곳만 어긋나도 그 목록에서만 순서가 조용히 꼬인다.

**순서변경** — 공유 프리미티브는 `components/use-reorder.ts`(화면)와 `lib/reorder-contract.ts`(계약)다.

| 검증 | 방법 | 실패의 의미 |
|---|---|---|
| zod가 반례를 거부한다 | `reorderRequestSchema.safeParse`에 네 반례를 넣어 전부 실패하는지 본다. 빈 배열 `{orderedIds: []}`, 중복 `["a","a"]`, `REORDER_MAX_IDS`(1000)+1개, 빈 문자열 id `[""]`다. 경계인 정확히 1000개는 통과해야 한다. 스크래치 스크립트는 `lib/reorder-contract.ts`만 import한다. zod만 쓰는 모듈이라 store에 닿지 않는다. 접두어를 붙여 `tsx`로 돌린다. dev 서버를 띄웠다면 같은 본문을 라우트에 POST해 400 `invalid_input`과 `issues`가 오는지 본다 | 재색인이 꼬이거나 무의미한 쓰기가 난다 |
| 다섯 라우트가 같은 계약 | `app/api/{library,math,english/vocab,japanese/vocab,japanese/dialog}/reorder/route.ts`를 본다. 모두 `reorderRequestSchema`와 `ReorderResponse`를 import하는지, 스토어의 `reorderBooks`·`reorderExplanations`·`reorderVocabBooks`·`reorderJaVocabBooks`·`reorderJaDialogs`를 하나씩 부르는지, 저장 실패를 500 `save_failed`로 내리는지 확인한다. SPEC §15-1에는 앞의 세 라우트만 적혀 있다. 일본어 두 목록은 뒤에 붙었다 | 목록마다 에러 분기가 갈린다 |
| 목록 밖 항목은 건드리지 않는다 | 파일 백엔드의 `reorder<X>`가 `rank.get(id)`가 있는 레코드만 바꾸는지 코드로 읽는다. db.json을 백업한 뒤 일부 id만 보내 보고, 나머지 레코드의 `sortIndex`가 그대로인지 본다 | 부분 재배치가 숨은 항목의 순서를 깬다 |
| 없는 id — 두 백엔드 차이 | 계약 주석은 "존재하지 않는 id는 스토어가 조용히 건너뛴다"고 한다. 파일 백엔드는 그렇게 동작한다. Firestore 구현은 `batch.update`를 쓰는데, 문서가 없으면 배치 전체가 거부된다(SDK 타입 주석). 결과는 500 `save_failed`이고, 훅이 되돌린 뒤 오류 문구를 띄운다. 다른 탭에서 지운 항목이 남은 화면에서 재배치하면 이 차이가 드러난다. Firestore는 실행하지 않으므로 코드 대조로 판정하고, 발견 사항(두 백엔드 동작 불일치)으로 적는다 | 로컬에서는 되는데 프로덕션에서는 저장이 실패한다 |
| 생성은 sortIndex를 모른다 | `lib/store.ts`의 `NewBook`·`NewExplanation`·`NewVocabBook`·`NewJaVocabBook`·`NewJaDialog`가 `Omit<…, "id" \| "createdAt" \| "sortIndex">`인지, 두 백엔드의 생성 메서드가 `sortIndex: null`로 쓰는지 본다 | 새 항목이 맨 위에 뜨지 않는다 |
| 정렬 규칙이 하나다 | `app/{library,math/library,english/vocab,japanese/vocab,japanese/dialog}/page.tsx`의 비교 함수가 모두 같은지 본다. null이 먼저 오고(그 안은 `createdAt` 역순), 그 뒤 `sortIndex` 오름차순이어야 한다 | 목록마다 새 항목의 위치가 다르다 |
| 부분 목록에서 끈다 | `components/library-view.tsx`는 `reorderEnabled = manageMode && !q`(검색 중 비활성)이고, `components/math-library-view.tsx`는 `manageMode && filter === "all"`이다. 나머지 셋(`vocab-library-view`·`ja-vocab-library-view`·`ja-dialog-library-view`)은 필터가 없어서 `enabled: manageMode`다. 새로 필터나 검색이 붙은 목록이 있으면 이 게이트도 함께 생겼는지 본다. 삭제는 필터와 무관하게 유지돼야 한다 | 보이는 일부만 재색인해 숨은 항목과 인덱스가 겹친다 |
| 관리 모드 게이트와 확정 | `useReorder`의 `enabled`가 관리 모드일 때만 참인지 본다(평소 드래그는 모바일 세로 스크롤과 충돌한다). `onPersist`가 `!res.ok`이면 throw해서 훅이 직전 순서로 되돌리는지, 성공하면 `router.refresh()`로 서버 순서를 확정하는지 본다. 순서변경은 수정이라 prod-guard 대상이 아니다 | 실패가 화면에 남거나 낙관적 순서가 서버와 갈린다 |

**읽기 속도**

| 검증 | 방법 | 실패의 의미 |
|---|---|---|
| 전역 값 하나 | 속도의 정의처는 `lib/speech.ts`의 `getTtsRate`/`setTtsRate`뿐이다. localStorage 키는 `eunwoo-tts-rate`, 기본값은 `TTS_RATE`(0.9), 프리셋은 `TTS_RATE_PRESETS`(0.7·0.9·1.1)다. `grep -rnaE "\.rate *=" app components`가 0건이어야 하고, 화면이 속도를 따로 저장하지 않아야 한다 | 같은 단어가 화면마다 다른 빠르기로 들린다 |
| 컨트롤 동기화와 hydration | `components/tts-speed-control.tsx`는 초기 렌더에 `TTS_RATE`를 쓰고, 마운트 후 effect에서 `getTtsRate()`를 읽어야 한다. 또 `TTS_RATE_EVENT`(`"eunwoo:tts-rate"`)를 들어 같은 페이지의 다른 컨트롤이 따라와야 한다. 배선된 곳은 `chapter-reader`·`vocabbook-view`·`ja-dialog-coaching-view`·`ja-vocab-detail-view`다 | hydration 경고가 나거나 두 컨트롤 값이 갈린다 |
| 재생 시점에 읽는다 | 기기 음성은 `utterance.rate = getTtsRate()`로 읽는다. 클라우드는 `cloudSpeed()`가 프리셋 인덱스를 `TTS_CLOUD_SPEEDS`(0.85·1.0·1.15)로 옮기고, 프리셋과 맞지 않는 값이면 1.0을 쓴다. 속도 변경이 다음 조각부터 반영되는지는 실기기에서 본다(§8) | 바꾼 속도가 클라우드 음성에 안 먹는다 |

## 6. 차분 테스트·변이 테스트 — eval의 힘을 잰다

eval을 통과한 엔진에서 규칙 위반을 더 찾거나, eval이 무엇을 놓치는지 잴 때 쓴다. 선례는 `_workspace/qa_report_workout-engine_1.md`다(시나리오 2,500개에서 불일치 0, eval의 변이 검출 18/23 → P2 보강 5건).

1. **참조 모델을 먼저 쓴다.** `lib/workout.ts`를 열기 전에 SPEC §19-1~§19-3만 보고 작성한다. 공식을 옮기지 말고 다른 경로로 계산한다(Day 종류는 표로, 다음 운동일은 루프로). 자기검사로 §19-1 표 10행, 590/890, 원안 오라클, 실패 당일 upcoming 예시 `[회복, (X,X−1), (X,X)]`가 전부 맞은 **뒤에야** 구현을 연다.
2. **무작위 사용자 시뮬레이션.** 시드를 고정하고 사이클 하나를 60~90일 굴린다. 매일 무작위로 행동한다. 아무것도 안 함, complete, fail(횟수 음수·목표 초과·null), undo 연속, 같은 날 두 번째 기록, 틀린 rev, 낡은 day·targetDay, 비운동일 기록, 닫힌 사이클에 기록·취소, 도중 재시작과 틀린 expected를 섞는다.
3. **매일 대조한다.** `todayStatus`(깊은 동등, `next`·`tomorrow` 포함), `replay` 전 필드, `snapshot`, `upcoming`, `closingStatus`, 그리고 `decideLog`가 만든 사건(date·at·day·targetDay·클램프된 failed·reps)을 본다.
4. **불변식을 검사한다.** 하루 사건 ≤ 1, 사건 날짜 엄격 증가, rev 단조 증가, 결과 직렬화 가능(undefined·NaN·Date 없음, JSON 왕복 동일), `decide*` 결정성, 입력 불변(tsx가 non-strict로 도므로 동결이 아니라 호출 전후 JSON 비교로 판정), 활성 사이클 ≤ 1.
5. **변이 테스트.** scratchpad의 복사본 lib에 변이를 하나씩 넣고 eval과 시뮬레이션을 둘 다 돌린다. eval에서 살아남은 변이는 "eval 공백"(P2, 담당 app-builder)으로 보고한다. 같은 방법을 speech 큐에도 썼다(`_workspace/qa_report_ja-coaching-tts_1.md`, 변이 20종).

모든 스크래치 파일은 scratchpad에 둔다. 끝나면 `git diff --stat`으로 저장소 원본이 그대로인지 확인한다.

## 7. 폰 폭 UI 확인 — 390·360px

최종 검증 기기는 폰이다. 데스크톱 폭에서 멀쩡하던 것이 폰에서 깨진 전례가 있다. 💪 운동 트랙이 첫 화면 밖으로 밀렸던 일이다(§17-7 폰 표시 규칙이 그 결과다).

- 실행: `OPENAI_API_KEY= STORE_BACKEND=file APP_PIN= GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npx next dev -p <포트>`. 데이터를 쓰기 전에 로그에서 `[store] backend=file (STORE_BACKEND 명시)`를 확인한다. db.json은 shasum과 함께 백업하고, 끝나면 복원한 뒤 shasum이 같은지 확인한다.
- Playwright 모바일 에뮬레이션(390×844, isMobile·hasTouch)을 쓰고 360px에서도 본다. 판정은 스크린샷을 눈으로 보는 것이 아니라 **DOM 실측**(`getBoundingClientRect`·`scrollWidth`·computed style)으로 한다.

| 항목 | 기대 |
|---|---|
| 헤드라인 폰 표시 | `🧒 은우 🔥N일 \| 🧑 아빠 🗾 🔥N일 💪 🔥N일`. 💪 트랙의 `right`가 뷰포트 폭 이내여야 한다. 트랙 이름·"오늘 아직"·라벨은 `max-sm:sr-only`라 화면에는 없고 DOM에는 있어야 한다. 아직 안 한 쪽은 흐림(opacity)으로 신호한다 |
| 헤드라인 높이 | 모든 상태에서 `--streak-h`(40px) 한 줄. 긴 라벨은 말줄임이고 전문은 `title`에 있다 |
| 가로 스크롤 | 문서 전체 가로 스크롤이 없어야 한다(`documentElement.scrollWidth` == 뷰포트 폭). 바 안쪽 스크롤바는 숨긴다. 클래식 스크롤바를 쓰는 데스크톱 Chromium에서도 글자가 잘리지 않는지 본다(과거 P2) |
| 층 | 세션 오버레이(z 20)가 헤드라인을 덮는다(`elementFromPoint`). 해설 듣기 바는 헤드라인 아래에 sticky로 붙고, 자동 스크롤된 카드는 두 바 밑에 가려지지 않는다(`scroll-margin-top`) |
| `/workout` | 390px에서 27일 계획표와 확인 패널 버튼이 어떻게 줄바꿈되는지 본다 |
| 순서변경 | 관리 모드에서 드래그 핸들(≡)과 ↑/↓ 버튼이 줄 폭을 넘기지 않는지 본다. 관리 모드를 끄면 핸들이 사라져 세로 스크롤만 남는지 본다 |

## 8. 실기기로만 확인되는 것 — "실기기 미검증"으로 남긴다

에뮬레이션과 스텁으로는 판정할 수 없다. 리포트에 아빠 iPhone Safari 확인 목록으로 넘긴다.

- **iOS 탭 밖 재생 잠금**: `🎧 해설 전체 듣기`의 첫 조각이 합성 대기(~1초) 뒤 정상으로 나는지, 한국어(클라우드)와 일본어(기기 Kyoko) 조각이 끊김 없이 이어지는지 본다. 무음 WAV와 볼륨 0 빈 발화로 잠금이 실제로 풀리는지가 핵심이다.
- **자연 종료 판정**: 조각을 끝까지 재생했을 때 `pause`가 오는 시점에 `audio.ended === true`인지 본다. 아니면 조각마다 큐가 멈춘다.
- **잠금 화면 ⏸·전화 수신**: 큐가 `"stopped"`로 끝나고 저절로 다시 재생되지 않는지 본다. 화면을 끈 채 이어 듣기는 보장하지 않는다(§18-0). "일본어도 클라우드" 설정에서 이어지는지는 관찰만 한다.
- **실제 합성 품질**: 한국어 해설 속 「は」「が」를 일본어로 읽는지(소리 설정의 ▶ 미리듣기) 확인한다. 한자만 있는 일본어를 중국어로 읽은 전례가 있어서 **사람이 들어야** 한다. 이건 실호출이라 QA가 하지 않는다.
- 속도 변경이 **다음 조각부터** 반영되는지 본다.
- **순서변경 터치 드래그**: 폰에서 핸들을 끌 때 페이지가 같이 스크롤되지 않는지, 화면 끝에서 자동 스크롤이 도는지 본다. 에뮬레이션의 합성 포인터 이벤트로는 실제 터치 제스처 판정을 재현할 수 없다.
- **운동 세션**: 휴식 종료 비프(종료 시각에 예약해 둔 재생, 백그라운드에서 복귀했을 때), 탭 밖에서 부른 `speakQueue`(ko-KR cloud)의 안내 음성, Wake Lock을 본다. `navigator.vibrate`는 iOS가 지원하지 않아 무시되는 것이 정상이다. **iOS 무음 스위치를 켠 상태**에서 비프가 나는지(Web Audio가 무음 모드를 따르는 것으로 알려져 있다), 백그라운드 복귀 뒤 컨텍스트가 `interrupted`·`suspended`면 `finishRest`의 `running` 조건 때문에 비프가 생략되는지도 본다.
- 폰트 폭: 에뮬레이션은 Chromium이라 실제 폰과 몇 px 다를 수 있다.

## 9. 리포트 형식

`_workspace/qa_report_common_{tag}_{n}.md`(tag 예: `speech`·`streak`·`workout`·`reorder`). 절 구성은 SKILL.md의 리포트 형식을 따르고, 공통 기능에서는 다음을 더한다.

- **실측 방법**에 eval 3종의 결과(PASS 수/전체)와 실행 접두어를 적는다. dev 서버를 띄웠다면 store 백엔드 로그를 확인한 줄과 db.json 백업·복원 shasum도 적는다. grep 판정은 `-a`를 붙여 돌렸다고 명시한다.
- **미검증**에는 §8 목록 가운데 해당하는 것과 Firestore 경로(안전 규칙상 접속하지 않음)를 **이유와 함께** 적는다. 실기기 항목은 아빠 iPhone 확인 목록으로 넘긴다.
- **기존 부채**(이번 변경 전부터 있던 위반, 예: §3의 UTC 날짜부 표시)는 이번 변경의 결함과 섞지 말고 따로 적는다.
- eval 공백(변이가 살아남음)은 P2로 둔다. 담당은 app-builder이고, 어떤 변이가 살아남았는지와 추가할 단언을 함께 적는다.
- 폰 폭에서 사용자가 요청한 요소가 첫 화면에 보이지 않으면 P1이다. 스펙 문언을 어기지 않았더라도 요청 목적을 달성하지 못한 것이기 때문이다.

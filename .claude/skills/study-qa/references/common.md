# 과목 공통 기능 검증 — 순서변경·읽기 속도·발음·해설 낭독·스트릭·아빠의 운동 (subject = `common`)

> `study-qa` 스킬에서 subject가 `common`일 때 읽는다. 과목별 검증은 `english.md`·`math.md`·`japanese.md`에 있다.
> 원문 스펙: `docs/SPEC.md` §15-1(목록 순서변경), §15-2(읽기 속도), §16(클라우드 발음, §16-5 보강), §17(학습 스트릭, §17-7 운동 트랙, §17-8 아빠 영어 트랙, §17-9 은우 트랙의 자유대화), §18(해설 낭독), §19(아빠의 운동, §19-8 총 운동 소요시간). 자유대화 자체(관문 R·호출 I·화면)는 `english.md` §8에서 검증하고, 여기서는 그 기능이 공통 기능(스트릭·마이크 관문·사진 코어)에 닿는 자리만 본다. §15-3(단어장 유의어·반의어 연결)은 영어 단어장 기능이라 `english.md`에서 검증한다. 구현 관용구는 `.claude/skills/ai-harness-impl/references/app-patterns.md`에 있다.

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

| 스크립트 | 대상 | import 경계 | 출력 영역 (항목 수는 2026-09-26 실측) |
|---|---|---|---|
| `scripts/eval-speech.ts` | `lib/ja-coaching-script.ts` 대본·쪼개기, `lib/speech.ts` 큐, `lib/tts-shared.ts`·`lib/tts.ts` 상수, `lib/tts-cache.ts` 지문 | store 금지. `lib/speech`·`lib/tts`·`lib/tts-cache`는 fetch 스텁을 깔고 키를 비운 **뒤에** dynamic import한다 | 대본(12)·쪼개기(12)·상수·엔진(5)·큐(46 — 2026-09-26 `onEnd` 둘째 인자 S1~S5 12개 추가)·단발(30)·지문(7)·안전(1) — 합계 (113) |
| `scripts/eval-streak.ts` | `lib/streak.ts`의 `computeStreak`·`computeStreakFromDays`, `lib/kst.ts`(`formatKstDate`·`isZonedIsoTimestamp` 포함), `lib/toeic-streak.ts`(아빠 🎙️ 영어 트랙 입력), `lib/talk-streak.ts`(은우 자유대화 입력) | `../lib/streak`·`../lib/kst`·`../lib/toeic-streak`·`../lib/talk-streak`만(뒤의 둘은 런타임 import 0 — 타입만) | KST 환산 26(formatKstDate 경계표를 TZ Asia/Seoul·UTC·America/Los_Angeles로 다시 돌림 — 실행 기기 TZ 무관)·연속 판정 5·0문항 제외 3·사람 분리 2·날짜 코어 5·영어 트랙 6(표현 시험 답한 문항≥1·응시 녹음된 문항≥1, 다른 트랙과 섞지 않음)·**자유대화 6**(2026-09-26 — 발화 0 제외·대화만 한 날·startedAt KST·아빠 트랙 무오염·라벨·라우트 배선) (53) |
| `scripts/eval-workout.ts` | `lib/workout.ts` 전체, `diffDateStrings`, `components/workout-shared.tsx`의 순수 포맷 함수(소요시간 문자열) | `../lib/workout`·`../lib/kst`·`../lib/streak` + **예외 하나** `../components/workout-shared`(2026-09-26 — 문자열의 정의처가 이 화면 파일이라서다. 이 파일의 import는 `@/lib/kst`·`@/lib/workout`뿐이라 store 전이가 없다. 이 파일에 import를 더하면 이 판정을 다시 한다) | 베이스·계획·스텝·휴식(세트 사이 [1,3,5,7]·휴식 뒤 [2,4,6,8]·음성 안내 대상 4개)·세트 목록 순서(`roundDisplayOrder` — 스텝 0~9 × 축하 유무의 순서·완료 구역 시작 위치, 푸시업 ✓ 탭 순간·풀업 ✓ 무재배치, 무효 held 무시)·횟수·상태·판정(`decideLog`·`decideUndo`·`decideStart`·`closingStatus`)·활성 선택·격리·정규화(createdAt ISO 경계 = `isZonedIsoTimestamp`)·날짜 방어·진행·볼륨·일정·스냅샷·지난 사이클·운동 스트릭(endedAt ISO 경계 포함)·**소요시간 24**(2026-09-26 §19-8 — 상수·`isValidDurationSec` 경계·옛 사건 정규화·decideLog 싣기와 쓰기 경계 보존·범위 밖 null·근사식 오라클·eventDuration·스냅샷 합계·undo·workoutLog 정렬·문자열 17건) (158) |

- **import 경계 자체가 검증 항목이다.** eval이 store를 import하면 어느 DB를 향할지 모르는 스크립트가 된다. 판정은 두 단계로 한다.
  - `grep -an 'lib/store' scripts/eval-speech.ts scripts/eval-streak.ts scripts/eval-workout.ts`가 **0줄**이어야 한다.
  - `grep -anE 'from "\.\./(lib|components)/|import\("\.\./lib/' scripts/eval-speech.ts scripts/eval-streak.ts scripts/eval-workout.ts`로 eval이 닿는 모듈을 전부 뽑는다(`components/`도 — eval-workout이 `workout-shared`를 연다). 그 모듈들의 import에도 같은 grep을 한 단계 더 돌려 store가 전이로 딸려 오지 않는지 본다.
  - `^import`로 줄 머리만 잡으면 안 된다. `eval-speech.ts`·`eval-workout.ts`는 `import {`로 시작해 몇 줄 아래에서 `} from "../lib/…"`로 끝나는 여러 줄 import를 쓴다. `^import` 방식은 모듈 경로가 적힌 줄을 놓치고, 그 자리에 store가 들어와도 보이지 않는다.
- 항목 수가 줄었으면 그 자체가 회귀 신호다. 반대로 항목 수가 늘었다고 eval이 강해졌다는 뜻은 아니다. 해설 낭독 QA에서 eval이 53/53을 통과했는데, iOS의 핵심 가드(무음 WAV `play()`)를 지운 변이가 살아남은 전례가 있다(`_workspace/qa_report_ja-coaching-tts_1.md` F1, 그 뒤 ⑭로 보강).

## 1. 클라우드 발음 (§16) — 관문 하나로 모이는가

| 검증 | 방법 | 실패의 의미 |
|---|---|---|
| 화면이 관문을 우회하지 않는다 | `grep -rna "speechSynthesis\|SpeechSynthesisUtterance\|/api/tts\|new Audio" app components` 결과에서 `app/api/tts` 밖은 주석뿐이어야 한다. 효과음용 `AudioContext`(`components/workout-session.tsx`)는 발음이 아니라 대상 밖이다. 은우 자유대화의 선생님 목소리(WebRTC 원격 트랙을 받는 `<audio autoplay playsinline>` — `components/talk-start-view.tsx`가 두고 `lib/talk-realtime.ts`가 `srcObject`를 붙인다)도 합성 발음이 아니라 대상 밖이다 — 대화 뒤 설명 낭독만 `speakQueue`를 탄다(`english.md` §8) | 속도·엔진·폴백·취소가 화면마다 갈린다 |
| `speak()` 회귀 | `speak(text, lang = TTS_LANG)` 시그니처가 그대로인지 본다. 2026-09-25부터 `speak()`도 큐 요소 하나를 재사용한다(§16-5) — eval ⑰은 재생마다 `new Audio`를 **만들지 않는지**, "단발" F1은 `speak()`가 반환되는 그 순간(동기) 큐 요소 src=무음 WAV + `play()` 1회·cancel 뒤 볼륨 0 빈 발화가 끝나 있는지, F2·F3은 연타와 `speak` ↔ `speakQueue` 상호 취소(동기 정지·onEnd 1회·URL 회수)를 본다. F7은 합성이 늦게 온 옛 speak가 공유 요소에서 재생 중인 새 speak를 뺏지 못하는지(`playViaCloud`의 합성 뒤 토큰 가드), F8은 300자 초과가 cloud 엔진이어도 POST 0·잠금 해제 0으로 기기 직행하는지(사전 판정), F12는 밀려난 speak의 대기 타임아웃이 진단 ✓를 덮지 않는지 본다 | 영어 6화면·일본어 화면 전부 회귀. 잠금 해제가 await 뒤로 밀리면 iOS에서 클라우드 🔊가 무음이 된다. 토큰 가드가 빠지면 새 🔊가 끝나지 않고 objectURL이 샌다 |
| 기기 음성 폴백의 cancel | F4 — device 직행은 cancel 1회(`cancelPlayback` 것)뿐, 클라우드 실패 뒤엔 빈 발화(말하는 중이어도)를 끊지 않고 잇고, 남의 발화가 말하는 중일 때만 cancel | 대체 재생까지 씹혀 앱이 조용해진다 |
| iOS paused 복구 | F13 — 스텁 `pauseOnCancel`(cancel() 뒤 paused로 굳고 이후 speak()는 이벤트 없이 무시)에서 `fallbackDevice`(device 단발 로그가 정확히 `cancel,resume,speak:…`·클라우드 실패 대체)·잠금 해제 빈 발화(`cancel → resume → 빈 발화`)·`speakDeviceAwait`(조각 사이에 굳어도) 세 곳 모두 실제로 발화되는지 본다. 세 곳의 `resumeIfPaused`를 하나씩 지우는 변이가 각각 잡혀야 한다 | 기기 음성이 한동안 무음이다가 설정을 만지면 다시 난다 — 2026-09-25 사용자 관찰("기기랑 클라우드가 꼬인 것 같다") |
| 설정 변경 시 프리페치 재실행 | F6 — device로 연 화면에서 cloud로 바꾸면 POST 0 → n, 속도를 바꾸면 새 speed로 n, 같은 설정 재탭은 진행 중 요청을 abort하지 않음, device로 바꾸면 중단, 화면 stop 뒤엔 재실행 없음(F6은 디바운스를 20ms로 줄여 돈다). F9 상한 `PREFETCH_MAX_ITEMS`(200개 → 90·재실행 90), F10 다음 화면의 배치가 직전 배치를 끊음(새 POST 0·abort 2·동시 ≤ 2), F11 화면 이탈 stop이 진행 중 요청을 abort | 첫 🔊마다 합성 대기 — iOS 차단 여지와 지연. 상한·abort가 빠지면 비용이 샌다 |
| 속도 연타 비용 | F14 — 속도 재실행은 trailing 디바운스(`RATE_PREFETCH_DEBOUNCE_MS` 600ms, eval은 `rateDebounceMs` 150ms): 간격 60ms로 5회 연타하는 동안 POST 0 → 마지막 속도 배치만, 연타 끝이 이미 받은 속도면 POST 0, 옛 속도 배치가 도는 중에 바꾸면 진행 중 요청을 누르는 순간 abort하고 옛 속도 새 POST 0. 엔진 cloud 전환은 디바운스 없이 즉시(F6) | 연타마다 배치를 쏘고 버려 상류 합성이 쌓인다(QA 실측 5회 연타 = 8건 전부 버려짐) |
| 진행 중 합성 공유 | F15 — 같은 캐시 키를 🔊·프리페치(어느 쪽이 먼저든)가 동시에 원하면 POST 1. 프리페치 stop은 🔊가 같이 기다리는 요청을 끊지 않고(abort 0·클라우드 재생), 혼자면 끊는다(abort 1). 큐 합성 대기 중 같은 문장 🔊 → 큐 요청은 abort되고 🔊는 끊긴 요청에 붙지 않고 새로 보낸다(기기 0). F16 — 대기 상한(`fetchMs`)을 넘긴 요청에는 새로 붙지 않는다(매달린 합성 뒤 다시 누른 🔊가 새 POST로 클라우드). 끊긴 요청 거르기는 두 겹(표에서 빼기 + aborted 확인)이라 한쪽만 지우는 변이는 살아남는다 — 둘 다 지우면 잡힌다 | 같은 문장을 두 번 합성(요금)하거나, 한 소비자의 abort가 남의 🔊를 기기 음성으로 떨어뜨린다 |
| 폰 진단 | F5 — 성공 `{ok}`·501 `synth/tts 501/device`·재생 거부 `play/NotAllowedError/device`·대기 상한 `synth/timeout/device`·기기 음성 미지원 `fallback none`·큐 조각 기록과 언어별 분리. 화면은 `TtsEngineControl`이 마운트 후에만 읽는다(렌더 중 `getTtsPlaybackDiag` 금지) | 실기기 신고를 서버 로그 없이 가를 방법이 없다 |
| 폴백은 조용해야 한다 | eval ⑥(POST 500이면 그 조각만 기기 음성), ⑦(501을 한 번 받으면 이후 POST 0). 키를 비운 dev에서 🔊를 눌러 `/api/tts` 501 → 기기 음성으로 가고 에러 UI가 뜨지 않는지 본다 | 앱이 조용해진다(§16-2) |
| 상한의 정의처는 하나다 | `TTS_TEXT_MAX_CHARS`(300)는 `lib/tts-shared.ts`에서 정의하고, 라우트 zod·`lib/speech.ts`·`lib/ja-coaching-script.ts`가 import한다 | 클라이언트는 보내는데 서버는 400을 준다 |
| 라우트 | `app/api/tts/route.ts` POST는 키 검사(501)를 파싱보다 **먼저** 한다. zod는 text(trim 1~300)·lang(`TTS_LANGS` enum)·speed(0.25~4)다. GET은 OpenAI를 부르지 않고 `{voice, model, instructions}`만 준다. POST는 `req.signal`을 `synthesizeSpeech(input, signal)` → openai `RequestOptions.signal`로 넘겨, 클라이언트가 끊으면 상류 합성도 끊고 499 `client_closed`(에러 로그 없음)로 끝난다. 오프라인 eval로는 못 잡으므로 루프백 스텁으로 "클라이언트 abort → 스텁이 연결 종료를 봄"을 확인한다 | 버려진 프리페치·큐 요청이 상류에서 끝까지 합성돼 요금이 난다 |
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
| `onEnd(reason, { sounded })` — 둘째 인자는 끝까지 소리를 냈다고 본 조각 수다(2026-09-26 하위 호환 추가, 토익 QA m2_1 P2-A). 3조각 규칙은 그대로라 **짧은 큐는 전부 무음이어도 `"done"`·`sounded 0`** 이고, 소리가 꼭 나야 하는 호출부(토익 응시 `toeicSpeechOutcome`)가 이 값으로 다시 판정한다 | S1(전부 소리·중간 stop·501 뒤 기기 폴백·안전 타임아웃은 소리로 셈·빈 items 0), S2(⑬의 sounded 0), S3(1·2조각 전부 무음 → `"done"`·0), S4(3조각 규칙 불변), S5(인자 하나짜리 기존 onEnd 하위 호환 — 해설 낭독·운동·토익 학습 보기 호출부) |
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
| KST 정의처가 하나인가 | `grep -rna -e "9 \* 60 \* 60" -e "Asia/Seoul" -e "toLocaleDateString" app components lib`의 결과가 `lib/kst.ts` 밖에서는 0건이어야 한다. `toLocaleString`은 숫자 서식에만 쓰였는지 확인한다. "시간대가 명시된 ISO 시각" 판정도 `lib/kst.ts`의 `isZonedIsoTimestamp` 하나다(`formatKstDate`와 `lib/workout.ts`의 createdAt·endedAt 판정이 같이 쓴다, 2026-09-25 단일화). `grep -rnaF -e '[+-]\d{2}:' -e '[+-](?:' lib app components`로 시간대 오프셋을 받는 정규식을 찾는다. `lib/kst.ts` 밖에서 나오면 두 번째 정의(결함)다(예전 `lib/workout.ts`의 `ISO_RE`가 이 grep에 걸렸다) |
| UTC 날짜부 자르기 | 위 grep은 ISO 시각을 잘라 UTC 일자를 얻는 패턴을 잡지 못한다. `grep -rnaE '\.slice\(0, *10\)' app components lib`를 따로 돌려 결과를 셋으로 나눈다. ① 읽음 기록의 `readAt.slice(0, 10)`은 정상이다. `readAt`이 기기 날짜 문자열(`deviceDateString`)이기 때문이다. 날짜가 아닌 배열 자르기도 정상이다. `lib/kst.ts` 안의 `raw.slice(0, 10)`(`formatKstDate`가 환산할 수 없는 값을 예전처럼 보이는 폴백)도 정상이다. ② "만든 날짜" 표시(상세 페이지 4곳, 목록 뷰 5곳, `card-view.tsx` 카드 이력)의 UTC 날짜부 자르기는 **2026-09-25에 해소됐다** — 전부 `formatKstDate(iso)`를 쓴다(app-patterns §9). 그래서 `createdAt.slice(0, 10)`이나 표시용 `iso.slice(0, 10)`이 다시 나오면 위치와 무관하게 **회귀(결함)** 다. `grep -rna "formatKstDate" app components`가 10곳(상세 4·목록 5·카드 이력 1)인지도 본다. 경계값은 `eval:streak`의 "KST 환산" formatKstDate 줄(15:00Z→다음날, 14:59:59Z→같은날, 깨진 입력·시간대 없는 시각·달력에 없는 날·24:00·소수 4자리+는 환산 안 함)이 잠근다. 이 표는 KST 기기에서만 돌리면 "시간대 없는 시각" 가드가 잠기지 않는다(로컬 KST로 읽고 +9h를 해도 같은 날). 그래서 eval이 판정(`isZonedIsoTimestamp`)을 값으로 단언하고 표를 TZ 3곳으로 바꿔 다시 돌린다. TZ 전환이 먹었는지(로컬 생성자 → UTC)도 같은 줄이 확인한다 |
| 자정 경계 | eval "KST 환산": 15:00Z는 다음 날, 14:59Z는 같은 날 |
| 시험만 세고, 답한 문항이 1개 이상이어야 한다 | eval "0문항 제외"(answered null·false). `app/api/streak/route.ts`가 스트릭을 **세는 데** 쓰는 컬렉션이 `listAllVocabQuizzes`·`listAllJaQuizzes`·`listJaKanjiQuizzes`·`listWorkoutCycles`·`listAllToeicQuizzes`·`listAllToeicAttempts`·`listAllTalkSessions` 일곱뿐인지 본다(뒤의 셋은 §17-8·§17-9가 더했다). 오늘 라벨(`todayLabel`)을 만들려고 단어장·세트·모의고사 이름을 읽는 것은 허용한다. 수학·읽음·**일본어 대화 복습** 컬렉션이 끼면 실패다(은우 **자유대화**는 §17-9 예외라 센다 — 아래 행) |
| 사람·트랙 분리 | eval "사람 분리"와 "날짜 코어"에는 섞으면 값이 달라지는 반례가 있다. 라우트에서 eunwoo=vocab + `talkStreakSessions(talks)`, appa=jaVocab+jaKanji, appaWorkout=`workoutKeptDays`, appaEnglish=`toeicStreakSessions`(토익 2컬렉션)가 한 집합에 섞이지 않는지 코드로 확인한다 |
| **은우 트랙 — 자유대화(§17-9)** | §17-1 "시험만 센다"의 **은우 트랙 한정 예외**다(아이가 직접 말한 날). 확인: ① `lib/talk-streak.ts`가 `childTurnCount ≥ 1`인 대화만 "답한 문항 1개"로 옮긴다(발화 수만큼 복제하지 않는다 — 코어는 "답한 문항 ≥ 1"만 본다, 0·NaN·음수·문자열은 세지 않는다) ② 날짜는 대화 `startedAt`의 KST 일자(15:30Z → 다음 날) ③ 라우트가 `computeStreak([...vocab, ...talkStreakSessions(talks)], today)` 한 번으로 계산한다(따로 계산해 합치지 않는다) ④ `todayLabel`은 오늘 한 것 중 **가장 늦게 시작한 것**(같은 시각이면 단어장 시험), 대화면 `talkStreakLabel` "자유대화 · {주제}", 발화 0 대화가 더 늦어도 라벨은 센 대화 ⑤ `listAllTalkSessions().catch(→ null)` → `talks = []`로 **은우 트랙은 단어장 시험만** — 대화 컬렉션 읽기 실패가 은우 트랙 전체를 죽이지 않는다(운동·영어 트랙의 중립값 규약과 같은 방향, 다만 여기는 중립값이 아니라 단어장만) ⑥ 대화가 아빠 세 트랙에 섞이지 않고, 일본어 시험이 은우에 섞이지 않는다. eval "자유대화" 6항목 + **라우트 in-process 반례**(스토어 대역을 주입해 `GET`을 직접 부른다 — 선례 scratchpad `qatalk2/streak.mts`, 11/11). 대화 읽기 실패처럼 파일 백엔드로 흉내 내기 어려운 경로는 이 대역으로 본다 |
| 코어 분리 회귀 | eval "날짜 코어": `computeStreak` == 세션 → 일자 집합 → `computeStreakFromDays`(5/5) |
| 운동 트랙 폴백 | `listWorkoutCycles`가 실패하거나 계산이 throw하면 `appaWorkout`만 `NEUTRAL_STREAK`가 되고 은우·일본어는 살아야 한다. 파일 백엔드에서는 운동만 실패시킬 수 없으므로 코드로 확인하고 e2e는 미검증으로 남긴다(선례) |
| 응답 계약 | `StreakResponse {ok, today, eunwoo, appa, appaWorkout, appaEnglish}`(`lib/streak-contract.ts`)와 `components/streak-headline.tsx`가 읽는 필드를 함께 열어 본다. `appa`는 이름만 호환용이고 실제로는 일본어 트랙이다. `eunwoo` 주석이 자유대화 포함(§17-9)을 적는지 본다 |
| 즉시 갱신 | `STREAK_REFRESH_EVENT`를 쏘는 곳: `vocab-quiz-view.tsx`·`ja-quiz-runner.tsx`·`ja-kanji-quiz-runner.tsx`(저장 성공), `workout-view.tsx`(ok **와 409**, `mutate`·`onSessionResult`), `toeic-quiz-runner.tsx`·`toeic-take-view.tsx`(토익 — `toeic.md`), `talk-call-overlay.tsx`(자유대화 저장에 **처음** 성공했을 때 한 번 — 멱등 재저장·겹친 요청에서 다시 쏘지 않는다). 409 분기가 빠져 있던 것이 과거 P2였다. 전수는 `grep -rla STREAK_REFRESH_EVENT components app`로 본다(`streak-headline.tsx`는 받는 쪽) |
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
| 화면 | 409면 `messageKo` 표시, `router.refresh()`, 스트릭 이벤트가 따라오는지. 세션 진행(`workout-session:v1`)을 마운트 후 effect에서만 읽는지, cycleId·rev·day·targetDay·dateKst가 전부 같을 때만 복원하는지 본다. 휴식은 세트(풀업+푸시업) 사이에만 — 풀업 ✓ 뒤 타이머 없음·푸시업 ✓ 뒤 휴식·마지막 ✓ 곧바로 완료, 프리페치 `/api/tts` POST가 4건(2~5세트 풀업 문구)인지, 옛 저장값(홀수 스텝 + `restEndsAt`)을 복원하면 휴식만 버리는지 본다(§19-1·§19-6). **목록 순서**(2026-09-25): 지금 할 세트 맨 위 → 남은 세트 → 완료 세트 맨 아래인지, 푸시업 ✓ 뒤 약 1초 축하("🎉 n세트 완료!")가 뜨고 그 행이 맨 아래로 FLIP 이동하는지, 풀업 ✓는 체크 팝만(재배치 없음)인지, 축하 중에도 휴식 타이머·비프 예약·저장이 탭 즉시 됐는지(애니메이션이 상태를 붙잡지 않는지), 새로고침 복원은 애니메이션 없이 최종 순서인지, `prefers-reduced-motion` 에뮬레이션에서 즉시 재배치되는지, 320/360/390에서 칸 넘침이 없는지, DOM 클래스에 `undefined`가 없는지 본다. 작은 폰(375×548·320×568 — 목록이 첫 화면 밖)에서도 휴식 무대의 캡션 자리에 "🎉 n세트 완료!"가 약 1초 보이는지(움직임 줄이기에서도 움직임 없이, 알림은 숨은 `role="status"` 한 곳), 푸시업 ✓를 60ms 간격으로 두 번 탭해 두 번째 탭이 `3분`에 떨어져도 휴식·비프 예약이 그대로인지(`CHAIN_TAP_GUARD_MS` 뒤엔 정상 동작) 본다 |

**409 재현**: `/workout`을 열어 둔 채 db.json에 사건 하나를 추가하고 rev를 +1해 "다른 탭이 이미 기록함"을 흉내 낸다. 그다음 `✓ 전부 해냈어요`를 누른다.

**"세션 소리가 안 나" 신고는 먼저 가른다** — 비프(Web Audio, 발음 관문 밖)인지 음성 안내(`speakQueue` ko-KR)인지. 코드로 대조할 것(`components/workout-session.tsx`, `ai-harness-impl/references/app-patterns.md` §14): `▶`·`✓` 탭 핸들러 안에서 **동기로** `ensureWorkoutAudio()`를 부르는지(휴식을 시작하지 않는 풀업 `✓` 포함), 휴식 시작(푸시업 `✓`) 때 `scheduleBeep`로 종료 시각에 미리 예약하는지, 길이 변경·`+30초`에서 `rescheduleBeep`가 도는지, `finishRest`가 예약분 미재생 시 즉시 울리고(컨텍스트 `running`일 때만) 예약분을 취소하는지, 복원 시 `running`일 때만 재예약하는지, `✓` 탭에서 `unlockSpeechPlayback()`을 부르는지, 음성 토글(`workout-voice:v1`)이 새로고침 뒤에도 유지되는지. 음성 쪽은 §1·§2의 발음 경로 검증을 그대로 쓴다(ko 엔진이 cloud인지 device인지부터).

### 4-1. 총 운동 소요시간 (§19-8) — 독립 참조 모델 대조

소요시간은 값 하나(`durationSec`)가 여섯 곳을 지난다 — 세션(클라이언트가 잰다) → 요청 계약 → 라우트 zod → `decideLog` → 쓰기 직전 정규화 → 읽을 때 엔진(`eventDuration`·합계·기록 목록) → 화면 문자열. 한 곳만 어긋나도 **에러 없이** 실측이 근사로, 근사가 엉뚱한 값으로 보인다. 그래서 §6의 차분 테스트를 이 기능에 맞춰 돌린다(선례 `_workspace/qa_report_common_workout-duration_1.md` — 78,475건 불일치 0, 변이 24종).

**정합성 매트릭스 — 값이 사는 곳**

| 제약 | 스펙 §19-8 | 엔진 `lib/workout.ts` | 계약 `lib/workout-contract.ts` | 라우트 zod | 세션 | eval:workout |
|---|---|---|---|---|---|---|
| 필드 | `durationSec: number \| null` 필수 nullable | `WorkoutEvent.durationSec`·`DecideLogInput.durationSec` | 두 갈래(complete·fail) 모두 | `z.number().int().min(0).nullable().default(null)` | 완료·실패 둘 다 싣는다 | 옛 사건 → null |
| 형식 | 정수·0 이상 | `isValidDurationSec`(정수 0..상한) — 판정·정규화·표시가 이 한 함수 | 주석 | int·min(0) → 400 | `Math.round`, 음수·시작 모름 → null | 경계 |
| 상한 3시간 | 넘으면 **기록은 받고 소요시간만 null** | `WORKOUT_DURATION_MAX_SEC` 10800, `decideLog`가 null로 | — | **막지 않는다**(막으면 기록 전체가 400) | 보지 않는다 | 0·10800 보존, 10801 → null |
| 정규화 | 새 필드를 넣어야 한다(함정) | `normalizeWorkoutEvent`에 같은 검사 | — | — | — | 쓰기 경계 정규화 뒤에도 보존 |
| 근사 계수 | 3·2·10초 + 휴식 120 | `DURATION_ESTIMATE_SEC`·`DEFAULT_REST_SEC`(정의처 하나) | — | — | `DEFAULT_REST_MS = DEFAULT_REST_SEC * 1000` | 상수 항목 |
| 표시 | 실측 "14분 12초", 근사 "약 13분", 섞인 합계 "약 …" | `EventDuration`·`DurationTotal` | 타입 재수출 | — | — | 문자열 17건 |

**방법 — 구현을 열기 전에 참조 모델부터**

1. §19-8·§19-1만 보고 scratch에 참조 모델을 쓴다(스텝 → 실패 지점은 표로, 휴식은 `[1,3,5,7]` 표로 — 엔진의 공식을 옮기지 않는다). **자기검사**로 스펙 예시를 모두 맞힌 뒤에야 `lib/workout.ts`를 연다: Day 1 완주 710초 → "약 12분", Day 23 완주 805초 → "약 13분", 푸시업 3세트(스텝 5) 4회 실패 = 387초. 두 예시를 동시에 만족하는 반올림은 `round`뿐이다(floor면 Day 1이 11, ceil이면 Day 23이 14) — 표시 규칙의 오라클이 된다.
2. 무작위 사용자 시뮬레이션(시드 고정, 400사이클 × 20~90일): 실패가 스텝 0~9를 전부 덮게 하고, 보고값 분포에 유효값·0·10800·10801·음수·소수·NaN·Infinity·문자열 `"600"`·undefined·1e9·99999를 섞는다.
3. 대조 대상: `decideLog`가 싣는 값, **JSON 왕복 + `normalizeWorkoutCycle`(쓰기 경계) 뒤 보존**, `eventDuration`·`estimateEventSec`, `cycleDuration`, `snapshot.duration`·`lastEventDuration`, `workoutHistory[].duration`, `workoutLog`(행 수·key 유일·최신 먼저·입력 순서 무관·행 합 = 사이클 합).
4. 원시 사건 수천 개(reps 길이 0~7·음수·소수·문자열·null·NaN, failed 손상, durationSec 유무·범위 밖)를 `normalizeWorkoutEvent`에 넣는다 — 필드 없음 → null, 유효 → 보존, 나머지 → null, undefined 필드 없음. 손상 fail 사건은 결정성만 본다.
5. 표시 함수(`formatDurationExact`·`formatDurationApprox`·`formatElapsedClock`)를 참조 포맷터와 0~54,000초 대조한다. 근사가 30초 미만이면 "약 1분"(최소 1분) — 스펙에 없는 구현 선택이라 결함이 아니다.
6. **변이 테스트**(§6-5): 선례에서 eval이 24종 중 23종을 잡았다. 살아남은 하나는 `eventDuration`의 조건을 `isValidDurationSec(d) && d > 0`으로 바꾼 것(**실측 0초가 근사로 바뀐다**)이다 — `eval:workout`에 `eventDuration({…, durationSec: 0})` → `{sec:0, source:"measured"}` 단언이 들어갔는지 본다(2026-09-26 현재 없음 — P2 열림, 담당 app-builder). 차분 테스트가 놓친 6종(표시 문자열·깨진 사건 합계·범위 밖 저장값)은 정규화·표시층이라 eval이 잡아야 한다.

**코드·API·세션 대조**

| 검증 | 방법 |
|---|---|
| 정규화 함정 | 변이 두 개가 둘 다 잡히는지: 정규화가 durationSec을 null로 버림 / 검증 없이 보존. Firestore는 코드 대조 — `logWorkoutEvent`·`undoWorkoutEvent`가 `toWorkoutCycle`(→ normalize) → `decide*` → `normalizeWorkoutCycle(r.next)` → `tx.update` 순서인지, `startWorkoutCycle`이 `workoutCycleData`(normalize)로 쓰는지. 파일 백엔드는 옛 모양 사건(필드 없음·99999·12.5)을 db.json에 심고 세션으로 기록해 저장값이 `[null,null,null,<실측>]`인지 본다 |
| 계약 ↔ zod | `requestMatchesSchema`가 남아 있고 tsc 통과. zod 프로브로 `{}`·`{durationSec: undefined}` → `{durationSec: null}`(키 존재 — undefined가 새지 않는다). `.nullish()` 0건(`grep -rna`) |
| API(dev, 접두어 + `APP_PIN=`) | -5·12.5·"abc"·1e20 → 400 `invalid_input`, `issues[].path = "durationSec"`, 기록 없음 / 99999·10801·필드 없음·null → 200, `event.durationSec`과 저장값 null / 10800·0 보존(0은 화면 "0초" 실측) / 낡은 rev·day에 실으면 409 `conflict`·`stale_state` 그대로 |
| 세션 | ▶ 직후 0스텝이어도 `startedAt` 저장, 첫 ✓ 전 새로고침 → "이어서 하기 · 풀업 1세트부터"·startedAt 동일 / 복원 조건(rev·dateKst 불일치)이면 시작도 버린다 / **끝 시각 고정**: 마지막 ✓ 전송을 route `abort('failed')`로 끊고 다시 눌러도 두 요청의 durationSec이 같다, 오류 뒤 경과 시계가 멈춘다 / 실패 전송이 끊긴 뒤 "돌아가기" → 다시 실패 기록이면 새 끝 시각 / 옛 저장값(startedAt 없음) → 경과 시계 숨김·`durationSec: null` / 경과 시계 1초 틱·`role="timer"`·`aria-live="off"` / 기록 성공 → 보존값 삭제, undo → 사건과 소요시간이 함께 빠진다 |
| 렌더 중 시계 금지 | `grep -na "Date.now()\|new Date(" components/workout-session.tsx`의 결과가 전부 effect·핸들러·타이머 콜백 안인지. e2e 콘솔 hydration 경고 0 |
| 화면(360·390·320) | ① 오늘 기록 카드 "… · 14분 19초"(실측) / "✓ 전부 해냈어요" → "· 약 12분" + 어림 안내 ② 이번 사이클 누적 "총 운동 시간 약 30분 · 근사 3회"(사건 0이면 줄 없음) ③ 지난 사이클 "총 약 26분" ④ 📒 운동 기록(모든 사이클, 최신 먼저, 사이클 머리글, "HH:MM 끝냄"은 `at`의 KST — `lib/kst` `formatKst` 재사용) ⑤ 세션 머리 "⏱ 경과 m:ss"가 뷰포트 안. 가로 넘침 0. `textContent`는 `ml-*` 여백을 공백으로 옮기지 않으니 기대 문자열을 공백 없이 비교하거나 스크린샷으로 확인한다 |
| 정의처 하나 | `DEFAULT_REST_SEC`만 120을 정의(세션의 옛 `120_000` 없음), KST 정의(`Asia/Seoul`·`9 * 60 * 60`)가 운동 파일에 0건 |
| 문서 동기화 | §19-8은 들어갔지만 §19-2 사건 코드블록·§19-5 zod 줄·§19-6 진행 보존 값 모양(`startedAt`·0스텝 저장)·§19-7 eval import 예외가 같은 사실을 담는지 본다 — 어긋나면 결함이 아니라 doc-commit 요청(P2) |

**관찰로 남길 것**: 실측 시작점이 "그날 세션을 **처음 연** 순간"이고 0스텝도 저장하므로, 세션을 잠깐 열어 보기만 해도 시계가 시작된다(18:00에 열어 보고 19:30~19:45에 운동 → 1시간 45분, 3시간 상한 안이라 걸러지지 않는다). 스펙대로라 결함이 아니지만 사용자 확인 거리다. 마지막 ✓ 전송이 실패한 뒤 세션을 **닫았다가 다시 열면** 끝 시각 ref가 초기화되는 것도 알려진 한계다.

## 5. 목록 순서변경·읽기 속도 (§15-1·§15-2)

두 기능 모두 AI가 없고 오프라인 eval도 없다. 그래서 반례를 직접 넣고 코드를 가로로 대조한다. 목록 하나하나의 경계(일본어 단어장·대화의 `onPersist`와 서버 정렬)는 `japanese.md`에 있다. 여기서는 **다섯 목록이 같은 계약을 지키는지**를 본다. 순서변경은 목록마다 복사해 붙인 코드라서, 한 곳만 어긋나도 그 목록에서만 순서가 조용히 꼬인다.

**순서변경** — 공유 프리미티브는 `components/use-reorder.ts`(화면)와 `lib/reorder-contract.ts`(계약)다.

| 검증 | 방법 | 실패의 의미 |
|---|---|---|
| zod가 반례를 거부한다 | `reorderRequestSchema.safeParse`에 반례를 넣어 전부 실패하는지 본다. 빈 배열 `{orderedIds: []}`, 중복 `["a","a"]`, `REORDER_MAX_IDS`(1000)+1개, 빈 문자열 id `[""]`, 그리고 **Firestore 문서 id 규칙 위반**(`isFirestoreDocId`, 2026-09-25): `"a/"`·`"/a"`·`"a/b"`·`"."`·`".."`·`"__x__"`·짝 없는 서로게이트·UTF-8 1,501바이트다. 경계인 정확히 1000개와 정상 id(randomUUID 36자, Firestore 자동 id 20자 영숫자, `data/db.json`의 seed id, `...`·`__`·1,500바이트 정확히)는 통과해야 한다. 스크래치 스크립트는 `lib/reorder-contract.ts`만 import한다. zod만 쓰는 모듈이라 store에 닿지 않는다. 접두어를 붙여 `tsx`로 돌린다. dev 서버를 띄웠다면 같은 본문을 라우트에 POST해 400 `invalid_input`과 `issues`가 오는지 본다 | 재색인이 꼬이거나 무의미한 쓰기가 난다 |
| 다섯 라우트가 같은 계약 | `app/api/{library,math,english/vocab,japanese/vocab,japanese/dialog}/reorder/route.ts`를 본다. 모두 `reorderRequestSchema`와 `ReorderResponse`를 import하는지, 스토어의 `reorderBooks`·`reorderExplanations`·`reorderVocabBooks`·`reorderJaVocabBooks`·`reorderJaDialogs`를 하나씩 부르는지, 저장 실패를 500 `save_failed`로 내리는지 확인한다. SPEC §15-1에는 앞의 세 라우트만 적혀 있다. 일본어 두 목록은 뒤에 붙었다 | 목록마다 에러 분기가 갈린다 |
| 목록 밖 항목은 건드리지 않는다 | 파일 백엔드의 `reorder<X>`가 `rank.get(id)`가 있는 레코드만 바꾸는지 코드로 읽는다. db.json을 백업한 뒤 일부 id만 보내 보고, 나머지 레코드의 `sortIndex`가 그대로인지 본다 | 부분 재배치가 숨은 항목의 순서를 깬다 |
| 없는 id — 두 백엔드가 같다 | 계약 주석은 "존재하지 않는 id는 스토어가 조용히 건너뛴다"고 한다. 경로 문자가 든 id(`"a/"`는 Firestore에서 문서 `a`가 된다)는 라우트 zod가 400으로 먼저 막고, `reorderBySortIndex`도 같은 판정(`isFirestoreDocId`)으로 `doc()` 전에 건너뛴다 — 스토어 단독 호출에서도 파일 백엔드와 같다. 파일 백엔드는 `rank.get(id)`가 있는 레코드만 바꾼다. Firestore는 **2026-09-25에 맞췄다**(해소) — 다섯 `reorder<X>`가 공유 본체 `reorderBySortIndex`(`lib/store-firestore.ts`)를 부르고, 그 함수가 `getAll(...refs, { fieldMask: ["sortIndex"] })`로 존재하는 문서만 걸러 batch update한다. 코드로 본다: `grep -na "batch.update" lib/store-firestore.ts`에서 sortIndex를 쓰는 줄이 그 함수 안 하나뿐인지, 다섯 메서드 본문이 `reorderBySortIndex(getDb(), this.<col>(), orderedIds)` 한 줄인지. 인덱스 규칙이 파일 백엔드와 같은지(넘어온 **위치** 그대로 — 없는 id 자리를 당기지 않는다, 중복이면 마지막 위치)도 대조한다. Firestore는 실행하지 않으므로, 이 함수는 db를 주입받는다 — 가짜 db(존재/비존재 섞기·전부 없음·중복·청크 >450·확인~커밋 사이 삭제)로 파일 백엔드 규칙과 같은 결과인지 스크래치로 돌리고, 실제 SDK 동작은 미검증으로 적는다 | 로컬에서는 되는데 프로덕션에서는 다른 탭에서 지운 항목 하나 때문에 저장이 500으로 실패한다 |
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

eval을 통과한 엔진에서 규칙 위반을 더 찾거나, eval이 무엇을 놓치는지 잴 때 쓴다. 선례는 `_workspace/qa_report_workout-engine_1.md`다(시나리오 2,500개에서 불일치 0, eval의 변이 검출 18/23 → P2 보강 5건). 소요시간(§4-1)도 같은 방법이었다(`qa_report_common_workout-duration_1.md` — 78,475건 불일치 0, eval 변이 검출 23/24).

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
- **단발 🔊(클라우드) — 2026-09-25 무음 신고의 재확인**: 일본어 단어장에서 엔진을 "클라우드"로 바꾸고 속도를 "빠르게"로 바꾼 **직후** 🔊를 눌러 소리가 나는지, 소리 설정 옆 캡션이 `마지막 재생: 클라우드 ✓`인지 본다. 실패 캡션이면 문구(단계·이유)를 그대로 받아 적는다 — `재생 NotAllowedError`면 잠금 해제가, `합성 tts 5xx`·`timeout`이면 서버·망이 원인이다. 스텁과 Chromium의 sticky activation으로는 iOS의 요소별 잠금을 재현할 수 없어 흉내(init script)까지만 한다.
- **기기 음성 멈춤(iOS paused) 복구**: 일본어 엔진 "기기"에서 🔊를 빠르게 여러 번, 이어서 다른 단어 🔊 → 매번 Kyoko가 나는지, "클라우드"로 두고 비행기 모드에서 ▶ 미리듣기(대체 기기 음성)가 나는지 본다. 예전에는 한동안 무음이다가 속도를 만지면 다시 났다(2026-09-25 관찰). 스텁은 버그를 흉내만 낸다.
- **자연 종료 판정**: 조각을 끝까지 재생했을 때 `pause`가 오는 시점에 `audio.ended === true`인지 본다. 아니면 조각마다 큐가 멈춘다.
- **잠금 화면 ⏸·전화 수신**: 큐가 `"stopped"`로 끝나고 저절로 다시 재생되지 않는지 본다. 화면을 끈 채 이어 듣기는 보장하지 않는다(§18-0). "일본어도 클라우드" 설정에서 이어지는지는 관찰만 한다.
- **실제 합성 품질**: 한국어 해설 속 「は」「が」를 일본어로 읽는지(소리 설정의 ▶ 미리듣기) 확인한다. 한자만 있는 일본어를 중국어로 읽은 전례가 있어서 **사람이 들어야** 한다. 이건 실호출이라 QA가 하지 않는다.
- 속도 변경이 **다음 조각부터** 반영되는지 본다.
- **순서변경 터치 드래그**: 폰에서 핸들을 끌 때 페이지가 같이 스크롤되지 않는지, 화면 끝에서 자동 스크롤이 도는지 본다. 에뮬레이션의 합성 포인터 이벤트로는 실제 터치 제스처 판정을 재현할 수 없다.
- **운동 세션**: 휴식 종료 비프(종료 시각에 예약해 둔 재생, 백그라운드에서 복귀했을 때), 탭 밖에서 부른 `speakQueue`(ko-KR cloud)의 안내 음성, Wake Lock을 본다. **소요시간**(§19-8): 화면을 끄거나 앱을 전환했다 돌아온 뒤 경과 시계와 기록된 실측값이 벽시계와 맞는지(타이머가 아니라 두 시각 차라 맞아야 한다), Safari 탭과 홈 화면 앱 각각에서 `workout-session:v1`의 `startedAt`이 유지되는지. `navigator.vibrate`는 iOS가 지원하지 않아 무시되는 것이 정상이다. **iOS 무음 스위치를 켠 상태**에서 비프가 나는지(Web Audio가 무음 모드를 따르는 것으로 알려져 있다), 백그라운드 복귀 뒤 컨텍스트가 `interrupted`·`suspended`면 `finishRest`의 `running` 조건 때문에 비프가 생략되는지도 본다.
- 폰트 폭: 에뮬레이션은 Chromium이라 실제 폰과 몇 px 다를 수 있다.

## 9. 리포트 형식

`_workspace/qa_report_common_{tag}_{n}.md`(tag 예: `speech`·`streak`·`workout`·`reorder`). 절 구성은 SKILL.md의 리포트 형식을 따르고, 공통 기능에서는 다음을 더한다.

- **실측 방법**에 eval 3종의 결과(PASS 수/전체)와 실행 접두어를 적는다. dev 서버를 띄웠다면 store 백엔드 로그를 확인한 줄과 db.json 백업·복원 shasum도 적는다. grep 판정은 `-a`를 붙여 돌렸다고 명시한다.
- **미검증**에는 §8 목록 가운데 해당하는 것과 Firestore 경로(안전 규칙상 접속하지 않음)를 **이유와 함께** 적는다. 실기기 항목은 아빠 iPhone 확인 목록으로 넘긴다.
- **기존 부채**(이번 변경 전부터 있던 위반)는 이번 변경의 결함과 섞지 말고 따로 적는다. §3의 UTC 날짜부 표시는 2026-09-25에 해소돼 이제 부채가 아니라 회귀로 판정한다.
- eval 공백(변이가 살아남음)은 P2로 둔다. 담당은 app-builder이고, 어떤 변이가 살아남았는지와 추가할 단언을 함께 적는다.
- 폰 폭에서 사용자가 요청한 요소가 첫 화면에 보이지 않으면 P1이다. 스펙 문언을 어기지 않았더라도 요청 목적을 달성하지 못한 것이기 때문이다.

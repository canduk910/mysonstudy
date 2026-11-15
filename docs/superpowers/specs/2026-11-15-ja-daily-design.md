# 아빠의 일본어 — 🗓️ 오늘의 일본어 (일일 학습 루틴) 설계

> 2026-11-15. 사용자 요청: "`design/japanesse`의 일본어 학습자료로 회화 공부와 JLPT N5 시험 대비를 하려고 한다. 아빠의 일본어에 신규 메뉴를 추가하고 일일 일본어 학습 루틴을 만들어 줘."
> 사용자 결정(같은 날): ① 회화 음원은 **전사해 대본으로 쓰고, 원음은 아빠 폰에 "파일로 가져오기"로 넣어 기기에서만 재생**(서버·저장소에 음원 없음) ② 하루 **30분** ③ 시험일은 정하지 않음 → **90회 과정** ④ 본책(종이책) 없음 → 이 폴더 자료만으로 구성.
> subject `japanese`. **새 LLM 호출 없음** — 받아쓰기는 일본어 말하기 모의고사의 관문 T-ja(`lib/ja-speaking-transcribe.ts`)를 재사용, 따라 말하기 판정은 `alignJaReadAloud`(`lib/ja-speaking-score.ts`, AI 없음)를 재사용한다.
> **저작권**: 교재 문장·단어·문제·음원은 저장소에 넣지 않는다. 이 문서·코드·eval·리포트의 예시는 지어낸 것이다. 원자료 `design/japanesse/`·반입 파일 `data/private/ja-daily-*.json`·음원 묶음 `data/private/ja-daily-audio.jpack`(모두 gitignore).

## 1. 자료

| 자료 | 형태 | 앱에서의 쓰임 |
|---|---|---|
| 다이나믹일본어 Step1(16과)·Step2(16과) | mp3 140트랙(약 2시간) → 기계 전사 → 과별 대본(문장·후리가나 토큰·한국어 해석·핵심 문장) | 🗣️ 회화 |
| 다이나믹일본어 Step3(16과) | mp3 275트랙 전사본만 있음 | 90회 뒤 "다음 과정"(이번 범위 밖 — 반입 형식은 받는다) |
| JLPT 한끝 N5 단어연습장 | 스캔 PDF → 18일 × 25단어 = 450단어 | 📚 N5 단어 |
| JLPT 한끝 N5 청해 유형 연습 음원 | mp3 → 전사 → 청해 4유형 문항(문제3·4는 소리 보기 3개라 문제로 풀린다, 문제1·2는 듣고 대본·해석 확인) + 청해 요령 | 📝 시험 대비(청해 훈련) |
| JLPT 한끝 N5 온라인 실전모의테스트 2회 + 해설 + 청해 음원 | 스캔 PDF → 회차·섹션별 문항(보기·정답·해설·해석) + 청해 원음 | 📝 시험 대비(문항 연습·실전 모의) |
| 90일 학습계획표 | 본책 쪽수 기준 | 쓰지 않는다(본책 없음) — 영역 배분 순서(문자·어휘 → 문법 → 독해·청해 → 실전 → 총정리)만 참고 |

## 2. 반입 — 내용 파일과 음원 묶음

두 파일을 따로 넣는다. 둘 다 `/japanese/daily`의 "파일로 가져오기"에서 고른다.

### 2-1. 내용 파일 `ja-daily/v1` (`data/private/ja-daily-v1.json`, 서버 저장)

```ts
interface JaDailyImportFile {
  format: "ja-daily/v1";
  presetKey: string;                 // 멱등 키
  lessons: JaDailyLesson[];          // 회화 과
  vocabDays: JaDailyVocabDay[];      // N5 단어 날
  listening: { tips: JaDailyListeningTip[]; items: JaDailyListeningItem[] };
  mocks: JaDailyMock[];              // 실전모의 회차
}
interface JaToken { surface: string; reading: string | null }   // 기존 §5 규약 그대로
interface JaDailyLesson {
  id: string;                        // "s1-l03"
  step: 1 | 2 | 3; lesson: number; kind: "kana" | "dialog";
  titleJa: string; titleKo: string; pointsKo: string[];
  tracks: { audioKey: string; part: "sound" | "kaiwa1" | "kaiwa2" | "renshu1" | "renshu2";
            lines: { id: string; speaker: string | null; ja: string; tokens: JaToken[]; ko: string }[] }[];
  keyLineIds: string[];              // 🎤 따라 말하기 체크 문장
}
interface JaDailyVocabDay { day: number; words: { id: string; written: string; reading: string; meaningKo: string }[] }
interface JaDailyListeningTip { id: string; audioKey: string; titleKo: string; pointsKo: string[] }
interface JaDailyListeningItem {
  id: string; audioKey: string; mondai: 1 | 2 | 3 | 4; no: number; example?: boolean;
  situationJa: string | null; questionJa: string | null;
  script: { speaker: string | null; ja: string; ko: string }[];
  choices: { ja: string; ko: string }[] | null; answer: number | null;   // 1부터
  answerKo?: string; explanationKo?: string;
}
interface JaDailyMock {
  round: number;
  sections: { section: "moji" | "bunpou" | "dokkai" | "listening"; mondai: number; points: number;
              instructionJa?: string; instructionKo?: string;
              passages?: { id: string; ja: string; ko?: string }[];
              items: { id: string; no: number; passageId?: string; audioKey?: string;
                       stemJa: string; choices: string[]; answer: number; needsImage?: boolean;
                       script?: { speaker: string | null; ja: string }[];
                       translationKo?: string; explanationKo?: string }[] }[];
}
```

- zod(`lib/ja-daily-content.ts` — 클라이언트·서버 공용 순수 모듈): `.strict()`, id 형식 `^[a-z0-9][a-z0-9-]{0,63}$`, id 파일 전체 유일, 토큰 무결성(surface 합 = ja, reading은 surface가 한자만일 때만·히라가나만 — 기존 §5와 같은 검사), `keyLineIds` ⊂ 그 과 line id, `answer`는 1..보기 수, 글자 상한. 문장 밑줄 표시는 `[[ ]]`.
- 라우트 `POST /api/japanese/daily/import`(AI 0, 6MB 상한): 블록 단위 upsert — 내용 해시가 같으면 그대로, 바뀐 것만 갱신, **파일에 없는 것은 지우지 않는다**(진도·기록 유지 — 엄마 `momContent` 선례). 응답: 종류별 `{added, updated, unchanged}`.
- 저장: 컬렉션 `jaDailyContent` — 문서 id `{kind}:{id}`(kind `lesson`·`vocab`·`tip`·`litem`·`mock`), 필드 `{kind, id, data, hash, importedAt}`. 과 하나·날 하나·모의 회차 하나가 각각 한 문서(Firestore 1MiB 안).
- 반입 파일은 Claude가 `data/private/` 원자료(전사·PDF 판독)로 만든다. 변환 스크립트는 저장소에 두지 않는다(토익 선례).

### 2-2. 음원 묶음 `jpack/1` (`data/private/ja-daily-audio.jpack`, 기기 저장)

```
offset 0  : ASCII "JPAK1\n"            (6 bytes)
offset 6  : uint32 LE  indexLength
offset 10 : UTF-8 JSON index  [{ "key": "Step1_21", "type": "audio/mp4", "offset": <blob 시작 — 파일 처음 기준>, "length": <bytes> }]
이후      : blob들(AAC 48kbps 모노 .m4a)
```

- 쓰는 트랙만 묶는다(Step1·2 140 + N5 청해 연습·요령·온라인 모의 청해 약 160). 약 70~80MB.
- 화면 "원음 가져오기"(`lib/ja-audio-store.ts`): 파일을 **`File.slice`로 조각조각** 읽어(150MB를 한 번에 메모리에 올리지 않는다) IndexedDB `eunwoo-ja-audio`(store `tracks`, key = audioKey, 값 `{key, type, blob, bytes, savedAt}`)에 넣는다. 진행률 표시, 이미 있는 키는 덮어쓴다(멱등), 중간에 끊겨도 들어간 것은 남는다. **서버로 보내지 않는다.**
- `navigator.storage.persist()`를 가져오기 탭 안에서 한 번 요청(iOS가 지우지 않게 — 결과는 안내만).
- 재생: 트랙 blob → `URL.createObjectURL` → `<audio>`(언마운트 때 revoke). 원음이 없으면(다른 기기·안 넣음) **그 트랙 문장을 합성 음성(`speakQueue`, ja-JP)으로 이어 읽는다** — 화면에 "원음 없음 · 합성 음성" 칩. 학습은 원음 없이도 끝까지 된다.

## 3. 90회 과정 — 완료 순서 (`lib/ja-daily-plan.ts`, 순수·결정적)

진도는 달력이 아니라 **끝낸 회차 수**다(엄마 선례 — 쉬어도 내용을 건너뛰지 않는다). 하루 = 한 회차 = 약 30분, 네 칸:

| 칸 | 어림 | 내용 |
|---|---|---|
| 🗣️ 회화 | 10분 | 그날의 회화 단위 — 원음 듣기 → 문장별 듣기·해석 → 따라 말하기(한국어 1번 → 일본어 N번) → 🎤 핵심 문장 체크 |
| 📚 N5 단어 | 8분 | 새 단어 카드 → 5지선다(뜻 고르기·읽기 고르기) / 셋째 날은 그 DAY 25단어 시험 |
| 📝 시험 대비 | 8분 | 청해 훈련 또는 실전모의 문항 |
| 🔁 복습 | 4분 | 오늘의 복습(간격 반복, §23)에서 일본어 영역의 N5 단어·회화 문장 몫 |

### 3-1. 칸별 배정 (내용 수에서 계산 — 수가 바뀌면 배정도 따라 바뀐다)

- **회화 단위 큐**: 과 순서(Step1 → Step2). `kana` 과는 트랙 6개씩 한 단위(Step1 1과 11트랙 → 2단위, 2과 9트랙 → 2단위). Step1 `dialog` 과는 2단위(A = 会話1 + 会話練習1, B = 会話2 + 会話練習2 + 🎤), Step2 `dialog` 과는 3단위(A, B, C = 과 전체 다시 듣기 + 🎤 + pointsKo). 지금 자료로 4 + 28 + 48 = **80단위** → 1~80회. 큐가 끝난 회차(81~90)의 회화 칸은 **약한 과 다시 하기**(🎤 결과가 가장 낮은 과부터, 같으면 과 순서).
- **N5 단어**: DAY d는 3회차 — (3d−2) 1~13번 카드 + 퀴즈, (3d−1) 14~25번 카드 + 퀴즈, (3d) DAY d 25단어 시험. 18 DAY → **1~54회**. 55회부터 단어 칸은 **약한 단어 시험**(틀린 적 있는 단어 우선, 최대 20문항). 각 DAY 단어는 처음 배운 다음 날부터 오늘의 복습에 들어간다.
- **시험 대비**:
  - 청해 훈련: 요령(tip) 하나씩 먼저, 그다음 예제가 아닌 문항 2개씩(문제 1 → 2 → 3 → 4 순). 회차 수 = tip 수 + ⌈문항/2⌉.
  - 그 뒤 **실전모의 1회 문항 연습**: 섹션 순서 문자·어휘 → 문법 → 독해 → 청해로 하루 몫씩 — 하루 몫 = ⌈1회 문항 수 ÷ (80 − 청해 훈련 끝 회차)⌉(최소 3, 독해 지문 문항은 같은 날로 묶는다). 80회 안에 끝나게.
  - **81~84회: 실전모의 2회 실전** — 81 문자·어휘, 82 문법·독해, 83 청해, 84 채점표 점수(언어지식·독해 ÷79×120, 청해 ÷54×60, 합격 기준 안내: 종합 80/180·과목별 기준점 38/120·19/60) + 오답 보기.
  - 85 = 1회 오답 다시 풀기, 86 = 2회 오답 다시 풀기, 87~90 = 총정리(약한 단어 20 + 약한 문항 10 + 약한 과 회화).
  - 내용이 많아 80회 안에 안 들어가면 과정이 90회를 넘어 늘어난다(실전·총정리 10회는 늘 맨 끝).
- **90회 뒤**: "과정 완료" 화면 + 반복 모드(약한 것 섞기). Step3 과가 반입되어 있으면 회화 큐가 Step3로 이어진다(다음 과정 — 이번에는 화면만 열어 둔다).

### 3-2. 순수 함수 (eval이 잠근다)

- `buildJaDailyCourse(content: JaDailyContentIndex): JaDailySession[]` — 회차별 `{ n, kaiwa: {lessonId, unit, trackKeys, keyLineIds} | {review: true}, vocab: {day, range} | {dayTest} | {weak}, exam: {tip} | {litems} | {mockItems, round} | {mockSection} | {mockReview} | {final}, minutesHint }`. 같은 입력 = 같은 출력(`Date.now`·`Math.random` 없음).
- `nextJaDailySession(course, records)` — 다음 회차 = 끝낸 회차 최댓값 + 1(기록이 중간을 건너뛰어도 최댓값 기준).
- `pickWeakLessons`·`pickWeakWords`·`pickWeakItems(records)` — 결정적 정렬(점수 → id).

## 4. 회차 화면 (`/japanese/daily/[n]`)

- 위: "Day n / 90" + 네 칸 진행 점(✓). 칸은 순서대로 열되 **건너뛰기 가능**(그 칸은 "건너뜀"으로 기록). 끝까지 가면 저장.
- 🗣️ **회화**: 트랙마다 원음 ▶(전체) · 문장 목록(후리가나 토큰 `components/ja-ruby.tsx`, 한국어 해석 접기/펴기, 문장 탭 = 그 문장 합성 음성) · **따라 말하기 ▶**(`speakQueue` — 한국어 1번 → 일본어 N번, 조각 뒤 쉼 `pauseAfterMs`, 전역 속도, 잠금 화면 Media Session 재사용) · **🎤 핵심 문장 체크**(keyLineIds가 있는 단위만 — 문장마다 녹음 → `POST /api/japanese/daily/transcribe` → `alignJaReadAloud(tokens, transcript)` 정확도 → ✓ 맞음(≥0.8) / 아깝다(≥0.5) / 다시, 틀린 글자 강조, 넘어가기 가능. 녹음은 저장하지 않는다).
- 📚 **단어**: 카드(표기 + 읽기 + 뜻 + 🔊 ja-JP) → 5지선다(오답 보기는 같은 DAY·인접 DAY에서 결정적으로, 같은 뜻 보기 제외) → 결과. DAY 시험은 25문항(뜻 고르기 13 + 읽기 고르기 12). 가타카나 외래어는 표기 칸을 가타카나로 정규화(반입 파일 단계).
- 📝 **시험 대비**: 청해 문항 = 원음 ▶(없으면 대본 합성 음성) → 문제3·4는 보기 3개(보기도 소리로 — 보기 글자는 답한 뒤 공개) / 문제1·2는 "들었어요 → 대본·해석 보기" 자기 확인 → 해설. 모의 문항 = 문제 문장(`[[ ]]` 밑줄) + 보기 4 → 정답·해석·해설. 청해 모의 문항은 원음(`audioKey`) ▶. `needsImage` 문항은 "그림 문항 — 교재 그림 없이 소리·대본으로" 안내 후 보기 번호만.
- 🔁 **복습**: 일본어 영역 오늘의 복습 링크(`/japanese/review`) + 남은 수. 0이면 자동 ✓.
- 끝: `POST /api/japanese/daily/sessions`(클라이언트 id 멱등) → 🔥 + 복습 등록 → "내일 할 것" 미리보기.
- **지난 회차 다시 하기**: 과정표에서 끝낸 회차를 열면 다시 할 수 있다 — 기록은 남지만 진도는 그대로(`replay: true`).

## 5. 홈·과정표

- `/japanese` 허브 맨 위에 **🗓️ 오늘의 일본어** 큰 카드(primary) — "Day n · 회화 {과 제목} · 단어 DAY d · {시험 칸 이름} · 약 30분", 오늘 끝냈으면 "오늘 완료 ✓ — 내일 Day n+1".
- `/japanese/daily`: 오늘 회차 시작 버튼 · 진행률(n/90, 회화 과·단어 DAY·모의 진행) · 과정표(90칸 — 끝냄/오늘/앞으로, 끝낸 칸 탭 = 다시 하기) · 원음 상태("원음 300/302 트랙 · 이 기기") · 가져오기 두 개(내용 파일 / 원음 묶음) · 모의고사 성적(84회 점수).
- 내용이 하나도 없으면 가져오기 안내만.

## 6. 저장

| 컬렉션 | 내용 |
|---|---|
| `jaDailyContent` | §2-1 |
| `jaDailySessions` | `{id(클라이언트), n, replay, startedAt, finishedAt, steps: {kaiwa, vocab, exam, review: "done"|"skipped"}, kaiwaChecks: [{lineId, accuracy, verdict, transcript}], vocabAnswers: [{wordId, mode, correct}], examAnswers: [{itemId, choice, correct}]}` |
| `reviewSchedules` | 기존(§23) — 영역 `japanese`, 새 종류 `ja-n5-word`(단서 = 한국어 뜻, 힌트1 = 읽기 첫 글자, 힌트2 = 읽기 뼈대 — 기존 `ja-word`와 같은 사다리) |

- 저장은 **끝까지 했을 때만**(칸 건너뜀 포함). 같은 id 재전송은 그대로 200.
- `n`은 `nextJaDailySession` 이하만 받는다(앞질러 저장 거부 400) — replay는 끝낸 n만.

## 7. 스트릭·알림

- 아빠 📚 어학(§17-10·§25-5) 일본어 쪽 한 판에 **끝낸 회차(replay 포함, steps 중 done ≥ 1)** 를 더한다(`lib/streak-v2-sources.ts`). 라벨 `오늘의 일본어 · Day n`.
- 알림·가족 보드는 아빠 한 칸을 그대로 읽으므로 변경 없음.

## 8. 비용

- 내용·원음 가져오기·진도·퀴즈·채점: AI 0.
- 🎤 핵심 문장 체크: 문장당 받아쓰기(관문 T-ja) 1회(다시 말하면 +1) — 회차당 최대 3문장 ≈ 1센트 미만.
- 발음: 일본어 기본 엔진은 **기기 음성**(`lib/speech.ts` `DEFAULT_ENGINE.ja = "device"`)이라 따라 말하기·단어 🔊는 기본 0원. 한국어 해석 조각(따라 말하기의 한국어 1번)은 ko-KR 클라우드 합성(캐시).
- 자료 준비(1회, 개발 때): 음원 전사 약 $2(gpt-4o-transcribe 회화 + gpt-4o-mini-transcribe 청해).

## 9. eval (`npm run eval:ja-daily`, 오프라인 전용)

가져오기 계약 반례(토큰 무결성·id 중복·keyLineIds·answer 범위·strict), 과정 엔진(80단위·54회·청해/모의 배정·81~90 고정·내용 수 변화에 따른 늘어남·결정성·다음 회차), jpack 파서(헤더·인덱스·조각 경계·손상 파일 거부), 판정 경계(0.8·0.5), 저장 계약(멱등·앞질러 저장 400·replay), 스트릭 소스(끝낸 회차 → 아빠 일본어 한 판), 복습 종류 `ja-n5-word` 사다리. 픽스처는 지어낸 일본어. `eval:japanese`·`eval:streak`·`eval:review` 회귀 함께.

## 10. 실기기(아빠 iPhone)

원음 묶음 가져오기(약 80MB — 진행률·끊긴 뒤 다시) · 원음 ▶와 합성 음성 대체 · 따라 말하기 잠금 화면 · 🎤 마이크 권한·체크 · Day 1 끝 → 🔥.

## 11. 구현 동기화 (1단계, 2026-11-15)

구현(`_workspace/build_app-builder_japanese-daily1_report.md` §4)과 QA(`qa_report_japanese_daily1_1.md`)가 정한 것 — 위 절과 다르면 이 절이 맞다.

- **Step3는 90회 큐에 넣지 않는다**(넣으면 138회). `buildJaDailyNextCourseUnits`가 다음 과정 단위만 따로 계산한다.
- **kana 과의 🎤**(keyLineIds)는 그 과 마지막 단위에 붙인다. 짝 파트가 없는 트랙은 A 단위에, 트랙도 🎤도 없는 단위는 뺀다.
- **청해 예제**(`example: true`)는 배정하지 않고 같은 음원의 요령(tip) 화면에 `examples`로 싣는다. 요령은 id 숫자 인식 사전순(`naturalCompare`), 청해 문항은 문제 → no → id.
- 시험 칸 union에 **`weakItems`**(꼬리 전에 남는 칸 — 지금 자료로 76~80회)와 **`mockScore`**(84회)를 더했다. 모의가 2회보다 적으면 꼬리의 해당 칸은 `final`. 회차에 `phase`(`core`·`tail`·`repeat`).
- 모의 문항 연습 하루 몫: 청해 훈련이 80회 이상까지 가면 최소 3. 독해 지문 문항은 같은 날로 묶는다.
- 채점표 환산 분모는 79·54를 박지 않고 **반입 파일의 실제 배점 합**. 합격 기준 80/180·38/120·19/60은 상수.
- **N5 단어 복습 입장은 단어 단위** — 첫 복습일 = 그 단어를 처음 답한 끝낸 회차의 KST 날짜 + 1(DAY 앞·뒤 절반이 이틀에 나뉘어 들어온다). 뜻·읽기 모드 합산, 단어장 `ja-word`와 키가 달라 따로 센다.
- 약한 과 = 🎤 정확도 평균이 낮은 과부터(기록 없는 과는 뒤, 과 순서), 다시 하기 회차는 순위를 돌아가며. 약한 단어·문항 = 틀린 적 있는 것 먼저(정답률 → 틀린 수 → id). 청해 문제1·2 자기 확인(`correct: null`)은 빠진다. `mockReview` = 최신 답이 틀린 문항.
- 저장: 진도 회차는 `n ≤ 다음 회차`(지난 n 진도 재저장 허용), replay는 진도로 끝낸 n만. 저장 문서 필드에 `contentId`·`presetKey`.
- **스트릭 날짜 기준은 `startedAt`**(KST), 한 판 = steps 중 done ≥ 1(`isFullJaDailySession`). 홈·허브의 "오늘 완료"도 같은 판정을 쓴다(QA P2-A). replay 회차도 한 판이다(설계 §7 그대로 — 다시 하기 한 번이 만회 "어학 두 판"의 한 판이 된다).
- 원음은 조각을 ArrayBuffer로 읽어 **새 Blob**으로 저장한다(고른 File과의 연결을 끊는다 — iOS). IndexedDB를 못 쓰면 `no_storage`.
- 반입 데이터 정리(반입 파일 단계): 음원 키는 ASCII(`n5-tip-01`·`n5-lt-{문제}-{번호}`·`n5-mock{회}-{문제}-{번호}`·`Step1_21`), 단어 읽기의 `〜`·공백 제거·`・`로 둘 이상이면 첫 읽기, 외래어 표기는 가타카나.

## 12. 구현 동기화 (2단계·통합 QA, 2026-11-15)

- 화면: 허브 카드 `components/ja-daily-hub-card.tsx`, 홈 `/japanese/daily`(`ja-daily-home`), 회차 `/japanese/daily/[n]`(`ja-daily-session-view` + 칸별 `ja-daily-{kaiwa,line-check,vocab,exam,media}`). 판정은 `lib/ja-daily-judge.ts`(계약 파일은 재수출), 단어 5지선다 보기는 `lib/ja-daily-quiz.ts`(결정적·같은 뜻/같은 읽기 오답 제외).
- 실전(mockSection) 중에는 화면 안 블록이 상단 스트릭·표현 도우미를 숨긴다(`lib/exam-screen.ts`는 그대로).
- 원음은 IndexedDB에 **바이트**로 저장한다(WebKit Blob 보관 결함 대비 — §11의 "새 Blob"을 대신한다).
- 받아쓰기가 안 되면(키 없음·실패·마이크 거부) 🎤 체크는 **스스로 판정**으로 이어진다(정확도 null).
- 실전 점수 = 81~83회 진도 기록(replay 제외)의 답만으로 계산 — 오답 다시 풀기·총정리·다시 하기가 점수를 바꾸지 않는다(통합 QA P2-A).
- **알려진 한계(고치지 않음)**: ① DAY 시험의 "읽기 고르기"는 표기에 한자가 있는 단어만 되므로, 가나 표기 단어가 많은 날은 12문항보다 적고 나머지는 뜻 고르기다. ② 짧은 문장(몇 글자)은 한 낱말이 바뀌어도 정확도 0.8 이상(맞음)이 될 수 있다 — 글자 정렬 판정의 성질. 실제 녹음으로 문턱을 본 뒤 조정한다.

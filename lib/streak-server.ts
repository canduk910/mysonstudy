/**
 * lib/streak-server.ts — /api/streak 응답 계산(라우트 GET 본문을 옮겼다 — 알림 틱도 같은 사람 상태를 쓴다, 가족 스트릭 강화 스펙 §6).
 * GET /api/streak — 학습 스트릭 (SPEC §17). 읽기 전용·AI 없음. 서버가 KST "오늘"을 계산해 사람별 StreakInfo를 낸다.
 *
 * 세는 것(§17-1): 은우=영어 단어 시험(VocabQuizRecord) + 자유대화(TalkSessionRecord, 은우 발화≥1 — §17-9 은우 트랙 한정 예외) /
 * 아빠·일본어=일본어 단어 시험(JaQuizRecord)+한자 시험(JaKanjiQuizRecord) /
 * 아빠·운동=러시안 파이터 루틴을 지킨 날(WorkoutCycleRecord — 운동·실패 기록일 + 계획된 휴식일 + 재측정 끝낸 날, §17-7) /
 * 아빠·영어=토익스피킹 표현 시험(ToeicQuizRecord, 답한 문항≥1) + 모의고사 응시(ToeicAttemptRecord, 녹음된 문항≥1) — toeic.md §0-2
 *   + 소재별 틀 말하기 한 판(toeicFrameDrills, 말한 문항≥1 — toeic.md §20-9, 못 읽으면 이 기록만 빼고 계산).
 * 세 트랙(은우·일본어·영어)은 **오늘의 복습**(reviewSchedules — 복습 1개 이상 끝낸 날, SPEC §23-9)도 각자 센다(영역 = 트랙, 못 읽으면 복습만 빼고).
 * 일본어·운동·영어는 각자 계산하고(`appa`·`appaEnglish` — 호환·라벨용으로 그대로 낸다), 헤드라인은 2026-10-08부터 일본어+영어를
 *   **하나의 📚 어학 트랙**(`appaLanguage` — 두 트랙의 날짜를 합집합으로, 둘 중 하나만 해도 그날이 켜진다, SPEC §17-10)으로 보인다.
 *   운동은 여전히 따로다. 수학·읽음·대화·생성·발화 포인트는 제외.
 * 새 레코드 없이 기존 기록에서 파생(§17-5) — 전체를 읽어 메모리에서 접는다(복합 인덱스 회피).
 * 캐시 헤더·PIN 게이트는 라우트(app/api/streak/route.ts) 몫.
 */

import "server-only";
import { kstDateString } from "@/lib/kst";
import { computeStreak, computeStreakFromDays, streakDays, type StreakSession } from "@/lib/streak";
import type { PersonStreak, StreakResponse } from "@/lib/streak-contract";
import type {
  StudyStore,
  TalkSessionRecord,
  ToeicAttemptRecord,
  ToeicFrameDrillSessionRecord,
  ToeicQuizRecord,
  WorkoutCycleRecord,
} from "@/lib/store";
import type { MomLessonRecord, MomTestRecord } from "@/lib/mom-contract";
import { isFullMomTest, momStreakWeekKo } from "@/lib/mom-plan";
import { isCountedTalkSession, talkStreakLabel, talkStreakSessions } from "@/lib/talk-streak";
import { TOEIC_GUIDE_PART_TO_MOCK_PART, isToeicGuidePart } from "@/lib/toeic-guide";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, type ToeicMockPart } from "@/lib/toeic-mock";
import { TOEIC_TEMPLATE_BANK_MODE_LABELS_KO, isToeicTemplateBankMode } from "@/lib/toeic-quiz";
import {
  isCountedToeicAttempt,
  toeicAttemptStreakLabel,
  toeicFrameDrillStreakLabel,
  toeicQuizStreakLabel,
  toeicStreakSessions,
  type ToeicQuizLabelNames,
} from "@/lib/toeic-streak";
import { workoutKeptDays, workoutStreakTodayLabel } from "@/lib/workout";
import { reviewFullDays, reviewStreakSessions, reviewTodayLabel, type ReviewArea, type ReviewScheduleRecord } from "@/lib/review-schedule";
import { STREAK_V2_FROM, badgesOf, kstWeekDays, weekCells, type WeekCell } from "@/lib/streak-v2";
import { addDays, addRuns, isFullAttempt, isFullFrameDrill, isFullMomLessonRecord, isFullQuiz, isFullTalk } from "@/lib/streak-v2-sources";
import { familyV2, personV2, trackV2, type TrackInput } from "@/lib/streak-v2-assemble";

/** 오늘(KST) 실제로 답한 세션만, 최신 먼저. */
function todaysAnswered<T extends StreakSession>(sessions: T[], today: string): T[] {
  return sessions
    .filter((s) => kstDateString(s.startedAt) === today && s.items.some((i) => i.answered === true))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** 연습 응시 라벨의 유형 이름(긴 이름 — toeicMockPartLabelKo 단일 정의처). 다섯 파트 밖이면 null(→ 모의고사 라벨) */
const TOEIC_DRILL_PART_KO = (part: string): string | null =>
  (TOEIC_MOCK_PARTS as readonly string[]).includes(part) ? toeicMockPartLabelKo(part as ToeicMockPart) : null;

/**
 * 영어 트랙 라벨 이름표(docs/harness/toeic.md §12-9) — 틀 모드 이름·공략 유형 이름(긴 이름)은 단일 정의처(lib/toeic-quiz·
 * lib/toeic-mock-contract)에서 가져온다. 틀 테스트·틀 시험(2026-10-02 — 틀 모드 다섯, §12-13-2)은 `템플릿 훈련 · {모드}`, 공략 표현 시험은
 * `공략 표현 · {유형}`(그 시험 화면은 닫았지만 지난 기록이 가장 늦은 세션일 수 있어 라벨은 그대로 둔다).
 */
const TOEIC_LABEL_NAMES: ToeicQuizLabelNames = {
  templateModeKo: (mode) => (isToeicTemplateBankMode(mode) ? TOEIC_TEMPLATE_BANK_MODE_LABELS_KO[mode] : null),
  guidePartKo: (part) => (isToeicGuidePart(part) ? toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]) : null),
};

/** 운동·영어 트랙 중립값 — 그 트랙 계산이 실패해도 헤드라인 전체(은우·일본어)는 살린다 */
const NEUTRAL_STREAK: PersonStreak = { info: { current: 0, doneToday: false, lastDate: null, best: 0 }, todayLabel: null };

export async function computeStreakResponse(store: StudyStore, today: string): Promise<StreakResponse> {

  const [vocab, jaVocab, jaKanji, workoutCycles, toeicQuizzes, toeicAttempts, talkSessions, toeicFrameDrills, reviewSchedules, momHasContent, momLessons, momTests] = await Promise.all([
    store.listAllVocabQuizzes(),
    store.listAllJaQuizzes(),
    store.listJaKanjiQuizzes(),
    // 운동 기록을 못 읽어도 시험 스트릭은 보여야 한다 — 실패는 null로 받아 아래에서 운동 트랙만 중립값으로
    store.listWorkoutCycles().catch((err: unknown): WorkoutCycleRecord[] | null => {
      console.error("[streak] 운동 사이클을 읽지 못했다 — 운동 트랙만 중립값으로 보낸다", err);
      return null;
    }),
    // 영어(토익) 트랙도 같은 규약 — 못 읽으면 이 트랙만 중립값(새 컬렉션이라 권한·색인 문제가 다른 트랙을 죽이지 않게)
    store.listAllToeicQuizzes().catch((err: unknown): ToeicQuizRecord[] | null => {
      console.error("[streak] 토익 표현 시험을 읽지 못했다 — 영어 트랙만 중립값으로 보낸다", err);
      return null;
    }),
    store.listAllToeicAttempts().catch((err: unknown): ToeicAttemptRecord[] | null => {
      console.error("[streak] 토익 모의고사 응시를 읽지 못했다 — 영어 트랙만 중립값으로 보낸다", err);
      return null;
    }),
    // 은우 자유대화(§17-9) — 못 읽으면 은우 트랙은 **단어장 시험만으로** 계산한다(새 컬렉션의 읽기 실패가 은우 트랙 전체를 죽이지 않게)
    store.listAllTalkSessions().catch((err: unknown): TalkSessionRecord[] | null => {
      console.error("[streak] 자유대화 기록을 읽지 못했다 — 은우 트랙은 단어장 시험만으로 계산한다", err);
      return null;
    }),
    // 소재별 틀 말하기(toeic.md §20-9) — 못 읽으면 영어 트랙은 표현 시험·응시만으로(새 컬렉션의 읽기 실패가 트랙 전체를 죽이지 않게)
    store.listToeicFrameDrillSessions().catch((err: unknown): ToeicFrameDrillSessionRecord[] | null => {
      console.error("[streak] 틀 말하기 기록을 읽지 못했다 — 영어 트랙은 표현 시험·응시만으로 계산한다", err);
      return null;
    }),
    // 📅 오늘의 복습(SPEC §23-9) — 복습 1개 이상 끝낸 날을 각 영역 트랙에 센다. 못 읽으면 복습만 빼고 계산한다
    store.listReviewSchedules().catch((err: unknown): ReviewScheduleRecord[] | null => {
      console.error("[streak] 복습 일정을 읽지 못했다 — 복습만 빼고 계산한다", err);
      return null;
    }),
    // 👩 엄마의 생활영어(엄마 설계 §7) — 셋 중 하나라도 못 읽으면 엄마만 null(다른 사람·라우트는 그대로 200)
    // 영역을 열었는지만 본다(블록 전체를 읽지 않는다 — /api/streak은 모든 화면 머리·가족 보드·30분 알림 틱마다 돈다)
    store.hasMomContent().catch((err: unknown): boolean | null => {
      console.error("[streak] 엄마 자료 존재를 확인하지 못했다 — 엄마 트랙만 뺀다", err);
      return null;
    }),
    store.listMomLessons().catch((err: unknown): MomLessonRecord[] | null => {
      console.error("[streak] 엄마 레슨 기록을 읽지 못했다 — 엄마 트랙만 뺀다", err);
      return null;
    }),
    store.listMomTests().catch((err: unknown): MomTestRecord[] | null => {
      console.error("[streak] 엄마 주간 테스트를 읽지 못했다 — 엄마 트랙만 뺀다", err);
      return null;
    }),
  ]);
  // 영역별로 가른다(트랙 분리 — 은우 영어 복습은 은우 트랙, 일본어 복습은 일본어 트랙, 토익 복습은 영어 트랙)
  const reviewsOf = (area: ReviewArea) => (reviewSchedules ?? []).filter((r) => r.area === area);

  // ── 은우: 영어 단어 시험 + 자유대화(은우 발화 ≥ 1 = 답한 문항, 같은 연속 판정 코어 — §17-9) ──
  // 아빠 트랙(일본어·영어·운동) 기록은 여기 섞지 않는다. 대화를 못 읽었으면 talks = [](단어장 시험만).
  const talks = talkSessions ?? [];
  const eunwoo: PersonStreak = { info: computeStreak([...vocab, ...talkStreakSessions(talks), ...reviewStreakSessions(reviewsOf("english"))], today), todayLabel: null };
  // todayLabel = 오늘 한 것 중 **가장 늦게 시작한 것**(같은 시각이면 단어장 시험)
  const eToday = todaysAnswered(vocab, today)[0];
  const tToday = talks
    .filter((t) => kstDateString(t.startedAt) === today && isCountedTalkSession(t))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
  if (tToday && (!eToday || tToday.startedAt > eToday.startedAt)) {
    eunwoo.todayLabel = talkStreakLabel(tToday);
  } else if (eToday) {
    const book = await store.getVocabBook(eToday.bookId);
    const label = book?.dayLabel ?? book?.titleKo ?? null;
    eunwoo.todayLabel = label ? `영어 단어장 · ${label}` : "영어 단어장";
  }

  // ── 아빠 · 일본어: 일본어 단어 시험 + 한자 시험(두 컬렉션을 한 스트릭으로 접는다) ──
  // 라벨은 짧게 — 헤드라인이 "🗾 일본어"를 앞에 붙인다(§17-7).
  const jaSessions: StreakSession[] = [...jaVocab, ...jaKanji, ...reviewStreakSessions(reviewsOf("japanese"))];
  const appa: PersonStreak = { info: computeStreak(jaSessions, today), todayLabel: null };
  const aVocab = todaysAnswered(jaVocab, today)[0];
  const aKanji = todaysAnswered(jaKanji, today)[0];
  if (aVocab && (!aKanji || aVocab.startedAt >= aKanji.startedAt)) {
    const book = await store.getJaVocabBook(aVocab.bookId);
    appa.todayLabel = book ? `단어장 · ${book.titleKo}` : "단어장";
  } else if (aKanji) {
    appa.todayLabel = "한자 시험";
  }
  /** 오늘 일본어 기록 중 가장 늦게 시작한 시각(어학 트랙 라벨 고르기용 — 복습만 했으면 null) */
  const jaLatestToday = [aVocab?.startedAt, aKanji?.startedAt].filter((t): t is string => !!t).sort().pop() ?? null;

  // ── 아빠 · 운동: 루틴을 지킨 날(엔진이 휴식 슬롯까지 접는다) → 시험과 같은 연속 판정 코어 ──
  let appaWorkout: PersonStreak = NEUTRAL_STREAK;
  if (workoutCycles) {
    try {
      appaWorkout = {
        info: computeStreakFromDays(workoutKeptDays(workoutCycles, today), today),
        todayLabel: workoutStreakTodayLabel(workoutCycles, today),
      };
    } catch (err) {
      console.error("[streak] 운동 스트릭 계산 실패 — 운동 트랙만 중립값으로 보낸다", err);
    }
  }

  // ── 아빠 · 영어(토익스피킹): 표현 시험(답한 문항≥1) + 모의고사 응시(녹음된 문항≥1) → 같은 연속 판정 코어 ──
  // 은우 영어(vocabQuizzes)와 컬렉션부터 다르다(§0-1) — 은우 트랙에 섞이지 않는다. 라벨은 짧게(헤드라인이 "🎙️ 영어"를 붙인다).
  let appaEnglish: PersonStreak = NEUTRAL_STREAK;
  /** 영어 트랙의 세션(어학 트랙 합집합용). 토익 기록을 못 읽으면 토익 복습만 남긴다(복습 일정은 따로 읽었다) */
  let enSessions: StreakSession[] = reviewStreakSessions(reviewsOf("toeic"));
  let enLatestToday: string | null = null;
  if (toeicQuizzes && toeicAttempts) {
    try {
      const frameDrills = toeicFrameDrills ?? [];
      const toeicSessions: StreakSession[] = [...toeicStreakSessions(toeicQuizzes, toeicAttempts, frameDrills), ...reviewStreakSessions(reviewsOf("toeic"))];
      appaEnglish = { info: computeStreak(toeicSessions, today), todayLabel: null };
      enSessions = toeicSessions;
      const tQuiz = todaysAnswered(toeicQuizzes, today)[0];
      const tAttempt = toeicAttempts
        .filter((a) => kstDateString(a.startedAt) === today && isCountedToeicAttempt(a))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
      // 틀 말하기 한 판(말한 문항 ≥ 1) — 셋 중 가장 늦게 시작한 것이 라벨(같은 시각이면 표현 시험·응시 먼저)
      const tFrame = frameDrills
        .filter((d) => kstDateString(d.startedAt) === today && d.items.some((it) => it.outcome === "spoken"))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
      enLatestToday = [tQuiz?.startedAt, tAttempt?.startedAt, tFrame?.startedAt].filter((t): t is string => !!t).sort().pop() ?? null;
      if (tFrame && (!tQuiz || tFrame.startedAt > tQuiz.startedAt) && (!tAttempt || tFrame.startedAt > tAttempt.startedAt)) {
        appaEnglish.todayLabel = toeicFrameDrillStreakLabel(tFrame, TOEIC_LABEL_NAMES.guidePartKo);
      } else if (tQuiz && (!tAttempt || tQuiz.startedAt >= tAttempt.startedAt)) {
        // 라벨만 가른다(§12-9) — 틀 테스트 `템플릿 훈련 · {모드}` / 공략 표현 시험 `공략 표현 · {유형}` / 그 밖 `표현집 · {세트}`
        const set = await store.getToeicSet(tQuiz.setId);
        appaEnglish.todayLabel = toeicQuizStreakLabel(tQuiz, set, TOEIC_LABEL_NAMES);
      } else if (tAttempt) {
        // 한 문제 연습이면 `공략 연습 · {유형}`, 모의고사면 `모의고사 · {제목}`(§12-9)
        const mock = await store.getToeicMock(tAttempt.mockId);
        appaEnglish.todayLabel = toeicAttemptStreakLabel(mock, TOEIC_DRILL_PART_KO);
      }
    } catch (err) {
      console.error("[streak] 영어 스트릭 계산 실패 — 영어 트랙만 중립값으로 보낸다", err);
      appaEnglish = NEUTRAL_STREAK;
      enSessions = reviewStreakSessions(reviewsOf("toeic"));
      enLatestToday = null;
    }
  }

  // 오늘의 복습 라벨(§23-9) — 그 트랙에 오늘 다른 기록이 없을 때만 `오늘의 복습 · n개`(다른 기록이 있으면 그 라벨이 먼저)
  if (eunwoo.todayLabel === null) eunwoo.todayLabel = reviewTodayLabel(reviewsOf("english"), today);
  if (appa.todayLabel === null) appa.todayLabel = reviewTodayLabel(reviewsOf("japanese"), today);
  if (appaEnglish !== NEUTRAL_STREAK && appaEnglish.todayLabel === null) appaEnglish.todayLabel = reviewTodayLabel(reviewsOf("toeic"), today);

  // ── 아빠 · 📚 어학(SPEC §17-10, 2026-10-08): 일본어 + 영어 날짜의 합집합 → 둘 중 하나만 해도 그날이 켜진다 ──
  // 라벨 = 오늘 한 것 중 가장 늦게 시작한 쪽에 "일본어 · "/"영어 · "를 붙인다(시각을 모르는 복습뿐이면 기록 있는 쪽 → 일본어 먼저).
  const appaLanguage: PersonStreak = {
    info: computeStreakFromDays(new Set([...streakDays(jaSessions), ...streakDays(enSessions)]), today),
    todayLabel: null,
  };
  const jaLabel = appa.todayLabel ? `일본어 · ${appa.todayLabel}` : null;
  const enLabel = appaEnglish.todayLabel ? `영어 · ${appaEnglish.todayLabel}` : null;
  if (jaLabel && enLabel) {
    const enLater = enLatestToday !== null && (jaLatestToday === null || enLatestToday > jaLatestToday);
    appaLanguage.todayLabel = enLater ? enLabel : jaLabel;
  } else {
    appaLanguage.todayLabel = jaLabel ?? enLabel;
  }

  // ── 👩 엄마(엄마 설계 §7): legacy 없음(새 영역), runs = 완료 레슨 + 완료 테스트 + mom 복습 한 판 ──
  // 블록이 하나도 없으면(영역을 아직 안 열었음) 엄마는 null — 헤드라인·보드에서 칸이 나타나지 않는다.
  // 레슨 한 판 = 끝냈고 체크 ≥ 1(isFullMomLessonRecord) — 지금 계획과 대조하지 않는다(내용을 다시 가져와도 지난 🔥가 소급해 바뀌지 않게).
  let momT: TrackInput | null = null;
  let momLabel: string | null = null;
  if (momHasContent === true && momLessons && momTests) {
    try {
      const doneLessons = momLessons.filter(isFullMomLessonRecord);
      const doneTests = momTests.filter(isFullMomTest);
      const runs = new Map<string, number>();
      addRuns(runs, doneLessons.map((l) => l.startedAt));
      addRuns(runs, doneTests.map((t) => t.startedAt));
      addDays(runs, reviewFullDays(reviewsOf("mom")));
      momT = { legacyDays: new Set<string>(), runs };
      // 라벨 = 오늘 끝낸 레슨·테스트 중 가장 늦게 시작한 것(같은 시각이면 레슨), 둘 다 없으면 오늘의 복습
      const weekKo = momStreakWeekKo; // 실제 복습 주(8·16·…)·가상 복습 주 → "복습 주"
      const lessonWeek = (rec: MomLessonRecord): number | null => {
        const m = /^r?w(\d{1,3})-d[1-4]$/.exec(rec.lessonId);
        return m ? Number(m[1]) : null;
      };
      const latest = <T extends { startedAt: string }>(xs: T[]): T | undefined =>
        xs.filter((x) => kstDateString(x.startedAt) === today).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
      const lToday = latest(doneLessons);
      const tToday = latest(doneTests);
      if (lToday && (!tToday || lToday.startedAt >= tToday.startedAt)) {
        const w = lessonWeek(lToday);
        momLabel = w === null ? "레슨" : `레슨 · ${weekKo(w)}`;
      } else if (tToday) {
        momLabel = `주간 테스트 · ${weekKo(tToday.week)}`;
      } else {
        momLabel = reviewTodayLabel(reviewsOf("mom"), today);
      }
    } catch (err) {
      console.error("[streak] 엄마 트랙 계산 실패 — 엄마만 뺀다", err);
      momT = null;
      momLabel = null;
    }
  }

  // ── 스트릭 v2(가족 스트릭 강화 스펙) — legacy = 기존 세션 배열의 날짜, runs = 적용일부터의 "한 판" 수 ──
  // 카드·만회는 사람 단위로 한 번 정하고(아빠 = 어학 ∪ 운동) 트랙 연속에 그대로 적용한다. 헤드라인 info를 v2로 덮는다.
  // `appa`·`appaEnglish`(호환 필드)는 legacy 계산 그대로 둔다 — 헤드라인은 더 이상 읽지 않는다.
  const buildV2 = () => {
    const runs = (fill: (m: Map<string, number>) => void) => {
      const m = new Map<string, number>();
      fill(m);
      return m;
    };
    const eunwooT: TrackInput = {
      legacyDays: streakDays([...vocab, ...talkStreakSessions(talks), ...reviewStreakSessions(reviewsOf("english"))]),
      runs: runs((m) => {
        addRuns(m, vocab.filter(isFullQuiz).map((q) => q.startedAt));
        addRuns(m, talks.filter(isFullTalk).map((t) => t.startedAt));
        addDays(m, reviewFullDays(reviewsOf("english")));
      }),
    };
    const langT: TrackInput = {
      legacyDays: new Set([...streakDays(jaSessions), ...streakDays(enSessions)]),
      runs: runs((m) => {
        addRuns(m, [...jaVocab, ...jaKanji].filter(isFullQuiz).map((q) => q.startedAt));
        addDays(m, reviewFullDays(reviewsOf("japanese")));
        addDays(m, reviewFullDays(reviewsOf("toeic")));
        // 토익 기록 하나가 이상해도 라우트 전체가 500이 되지 않게 — 토익 한 판만 빼고 계산한다(읽기 실패와 같은 원칙)
        try {
          if (toeicQuizzes) addRuns(m, toeicQuizzes.filter(isFullQuiz).map((q) => q.startedAt));
          if (toeicAttempts) addRuns(m, toeicAttempts.filter(isFullAttempt).map((a) => a.startedAt));
          if (toeicFrameDrills) addRuns(m, toeicFrameDrills.filter(isFullFrameDrill).map((d) => d.startedAt));
        } catch (err) {
          console.error("[streak] v2 토익 판정 실패 — 토익 한 판만 빼고 계산한다", err);
        }
      }),
    };
    let gymDays: string[] = [];
    try {
      if (workoutCycles) gymDays = workoutKeptDays(workoutCycles, today);
    } catch {
      gymDays = [];
    }
    const gymT: TrackInput = { legacyDays: new Set(gymDays), runs: runs((m) => addDays(m, gymDays)) };

    const eunwooP = personV2([eunwooT], today);
    const appaP = personV2([langT, gymT], today);
    const momP = momT ? personV2([momT], today) : null;
    const fam = familyV2([eunwooP, appaP, momP], today);
    const week = kstWeekDays(today);
    const langInfo = trackV2(langT, appaP, today);
    const gymInfo = trackV2(gymT, appaP, today);
    return {
      eunwoo: eunwooP.info,
      appaLanguage: langInfo,
      appaWorkout: gymInfo,
      family: fam.info,
      week: {
        days: week,
        rows: {
          eunwoo: weekCells({ info: eunwooP.info, litDays: eunwooP.litDays, weekDays: week, today, startDay: eunwooP.startDay }),
          appa: weekCells({ info: appaP.info, litDays: appaP.litDays, weekDays: week, today, startDay: appaP.startDay }),
          mom: momP ? weekCells({ info: momP.info, litDays: momP.litDays, weekDays: week, today, startDay: momP.startDay }) : null,
        },
      },
      badges: [
        { key: "eunwoo" as const, ...badgesOf(eunwooP.info) },
        { key: "appaLanguage" as const, ...badgesOf(langInfo) },
        { key: "appaWorkout" as const, ...badgesOf(gymInfo) },
        ...(momP ? [{ key: "mom" as const, ...badgesOf(momP.info) }] : []),
        { key: "family" as const, ...badgesOf(fam.info) },
      ],
      appaPerson: appaP.info,
      mom: momP ? momP.info : null,
    };
  };
  // v2 계산이 던져도 /api/streak(모든 화면의 헤드라인)가 500이 되지 않게 — 옛 규칙 info 그대로, 가족 중립·주간 빈칸·배지 없음
  let v2: ReturnType<typeof buildV2> | null = null;
  try {
    v2 = buildV2();
  } catch (err) {
    console.error("[streak] v2 계산 실패 — 옛 규칙으로 보낸다", err);
  }
  type V2Body = Pick<StreakResponse, "mom" | "family" | "week" | "badges" | "v2From" | "appaPerson">;
  let v2Body: V2Body;
  if (v2) {
    eunwoo.info = v2.eunwoo;
    appaLanguage.info = v2.appaLanguage;
    if (appaWorkout !== NEUTRAL_STREAK) appaWorkout = { ...appaWorkout, info: v2.appaWorkout };
    v2Body = { mom: v2.mom ? { info: v2.mom, todayLabel: momLabel } : null, family: { info: v2.family, todayLabel: null }, week: v2.week, badges: v2.badges, v2From: STREAK_V2_FROM, appaPerson: { info: v2.appaPerson, todayLabel: null } };
  } else {
    let days: string[] = [];
    try {
      days = kstWeekDays(today);
    } catch {
      days = [];
    }
    const none = days.map((): WeekCell => "none");
    v2Body = {
      mom: null,
      family: { info: { current: 0, doneToday: false, lastDate: null, best: 0 }, todayLabel: null },
      week: { days, rows: { eunwoo: none, appa: [...none], mom: null } },
      badges: [],
      v2From: STREAK_V2_FROM,
    };
  }
  const body: StreakResponse = { ok: true, today, ...v2Body, eunwoo, appa, appaWorkout, appaEnglish, appaLanguage };
  return body;
}

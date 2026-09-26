/**
 * GET /api/streak — 학습 스트릭 (SPEC §17). 읽기 전용·AI 없음. 서버가 KST "오늘"을 계산해 사람별 StreakInfo를 낸다.
 *
 * 세는 것(§17-1): 은우=영어 단어 시험(VocabQuizRecord) + 자유대화(TalkSessionRecord, 은우 발화≥1 — §17-9 은우 트랙 한정 예외) /
 * 아빠·일본어=일본어 단어 시험(JaQuizRecord)+한자 시험(JaKanjiQuizRecord) /
 * 아빠·운동=러시안 파이터 루틴을 지킨 날(WorkoutCycleRecord — 운동·실패 기록일 + 계획된 휴식일 + 재측정 끝낸 날, §17-7) /
 * 아빠·영어=토익스피킹 표현 시험(ToeicQuizRecord, 답한 문항≥1) + 모의고사 응시(ToeicAttemptRecord, 녹음된 문항≥1) — toeic.md §0-2.
 * 일본어·운동·영어는 **각자의 트랙**이다(합치지 않는다). 수학·읽음·대화·생성·발화 포인트는 제외.
 * 새 레코드 없이 기존 기록에서 파생(§17-5) — 전체를 읽어 메모리에서 접는다(복합 인덱스 회피).
 * 캐시 없음(no-store). PIN 게이트는 proxy가 자동.
 */

import { NextResponse } from "next/server";
import { kstDateString, kstTodayString } from "@/lib/kst";
import { computeStreak, computeStreakFromDays, type StreakSession } from "@/lib/streak";
import type { PersonStreak, StreakResponse } from "@/lib/streak-contract";
import { getStore, type TalkSessionRecord, type ToeicAttemptRecord, type ToeicQuizRecord, type WorkoutCycleRecord } from "@/lib/store";
import { isCountedTalkSession, talkStreakLabel, talkStreakSessions } from "@/lib/talk-streak";
import { isCountedToeicAttempt, toeicStreakSessions } from "@/lib/toeic-streak";
import { workoutKeptDays, workoutStreakTodayLabel } from "@/lib/workout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 오늘(KST) 실제로 답한 세션만, 최신 먼저. */
function todaysAnswered<T extends StreakSession>(sessions: T[], today: string): T[] {
  return sessions
    .filter((s) => kstDateString(s.startedAt) === today && s.items.some((i) => i.answered === true))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** 운동·영어 트랙 중립값 — 그 트랙 계산이 실패해도 헤드라인 전체(은우·일본어)는 살린다 */
const NEUTRAL_STREAK: PersonStreak = { info: { current: 0, doneToday: false, lastDate: null, best: 0 }, todayLabel: null };

export async function GET() {
  const store = getStore();
  const today = kstTodayString();

  const [vocab, jaVocab, jaKanji, workoutCycles, toeicQuizzes, toeicAttempts, talkSessions] = await Promise.all([
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
  ]);

  // ── 은우: 영어 단어 시험 + 자유대화(은우 발화 ≥ 1 = 답한 문항, 같은 연속 판정 코어 — §17-9) ──
  // 아빠 트랙(일본어·영어·운동) 기록은 여기 섞지 않는다. 대화를 못 읽었으면 talks = [](단어장 시험만).
  const talks = talkSessions ?? [];
  const eunwoo: PersonStreak = { info: computeStreak([...vocab, ...talkStreakSessions(talks)], today), todayLabel: null };
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
  const appa: PersonStreak = { info: computeStreak([...jaVocab, ...jaKanji], today), todayLabel: null };
  const aVocab = todaysAnswered(jaVocab, today)[0];
  const aKanji = todaysAnswered(jaKanji, today)[0];
  if (aVocab && (!aKanji || aVocab.startedAt >= aKanji.startedAt)) {
    const book = await store.getJaVocabBook(aVocab.bookId);
    appa.todayLabel = book ? `단어장 · ${book.titleKo}` : "단어장";
  } else if (aKanji) {
    appa.todayLabel = "한자 시험";
  }

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
  if (toeicQuizzes && toeicAttempts) {
    try {
      appaEnglish = { info: computeStreak(toeicStreakSessions(toeicQuizzes, toeicAttempts), today), todayLabel: null };
      const tQuiz = todaysAnswered(toeicQuizzes, today)[0];
      const tAttempt = toeicAttempts
        .filter((a) => kstDateString(a.startedAt) === today && isCountedToeicAttempt(a))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
      if (tQuiz && (!tAttempt || tQuiz.startedAt >= tAttempt.startedAt)) {
        const set = await store.getToeicSet(tQuiz.setId);
        appaEnglish.todayLabel = set ? `표현집 · ${set.titleKo}` : "표현집";
      } else if (tAttempt) {
        const mock = await store.getToeicMock(tAttempt.mockId);
        appaEnglish.todayLabel = mock ? `모의고사 · ${mock.titleKo}` : "모의고사";
      }
    } catch (err) {
      console.error("[streak] 영어 스트릭 계산 실패 — 영어 트랙만 중립값으로 보낸다", err);
      appaEnglish = NEUTRAL_STREAK;
    }
  }

  const body: StreakResponse = { ok: true, today, eunwoo, appa, appaWorkout, appaEnglish };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

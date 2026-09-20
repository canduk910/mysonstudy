/**
 * GET /api/streak — 학습 스트릭 (SPEC §17). 읽기 전용·AI 없음. 서버가 KST "오늘"을 계산해 사람별 StreakInfo를 낸다.
 *
 * 세는 것(§17-1): 은우=영어 단어 시험(VocabQuizRecord) / 아빠=일본어 단어 시험(JaQuizRecord)+한자 시험(JaKanjiQuizRecord).
 * 수학·읽음·대화·생성은 제외. 새 레코드 없이 기존 세션에서 파생(§17-5) — 전체를 읽어 메모리에서 접는다(복합 인덱스 회피).
 * 캐시 없음(no-store). PIN 게이트는 proxy가 자동.
 */

import { NextResponse } from "next/server";
import { kstDateString, kstTodayString } from "@/lib/kst";
import { computeStreak, type StreakSession } from "@/lib/streak";
import type { PersonStreak, StreakResponse } from "@/lib/streak-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 오늘(KST) 실제로 답한 세션만, 최신 먼저. */
function todaysAnswered<T extends StreakSession>(sessions: T[], today: string): T[] {
  return sessions
    .filter((s) => kstDateString(s.startedAt) === today && s.items.some((i) => i.answered === true))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

export async function GET() {
  const store = getStore();
  const today = kstTodayString();

  const [vocab, jaVocab, jaKanji] = await Promise.all([
    store.listAllVocabQuizzes(),
    store.listAllJaQuizzes(),
    store.listJaKanjiQuizzes(),
  ]);

  // ── 은우: 영어 단어 시험 ──
  const eunwoo: PersonStreak = { info: computeStreak(vocab, today), todayLabel: null };
  const eToday = todaysAnswered(vocab, today)[0];
  if (eToday) {
    const book = await store.getVocabBook(eToday.bookId);
    const label = book?.dayLabel ?? book?.titleKo ?? null;
    eunwoo.todayLabel = label ? `영어 단어장 · ${label}` : "영어 단어장";
  }

  // ── 아빠: 일본어 단어 시험 + 한자 시험(두 컬렉션을 한 스트릭으로 접는다) ──
  const appa: PersonStreak = { info: computeStreak([...jaVocab, ...jaKanji], today), todayLabel: null };
  const aVocab = todaysAnswered(jaVocab, today)[0];
  const aKanji = todaysAnswered(jaKanji, today)[0];
  if (aVocab && (!aKanji || aVocab.startedAt >= aKanji.startedAt)) {
    const book = await store.getJaVocabBook(aVocab.bookId);
    appa.todayLabel = book ? `일본어 단어장 · ${book.titleKo}` : "일본어 단어장";
  } else if (aKanji) {
    appa.todayLabel = "한자 시험";
  }

  const body: StreakResponse = { ok: true, today, eunwoo, appa };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

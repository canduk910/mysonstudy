"use client";

/**
 * 단어 시험 응시기록 뷰 (V8) — 클라이언트 컴포넌트. **표시만** 한다(AI·저장·집계 변경 0).
 *
 * 서버(`[id]/history/page.tsx`·`history/page.tsx`)가 저장된 `VocabQuizRecord`를 최근순으로 넘기면
 * 여기서 요약(응시 횟수·평균 점수·최근 응시)과 세션 목록(종류 배지·점수·중단 표시)을 그리고, 각 세션을
 * `<details>`로 펼치면 문항별 O/X를 보여준다. 집계는 **저장하지 않고 이 자리에서 계산**한다(오답노트와 같은 규약).
 *
 * 화면 A(이 단어장)와 B(전체)가 같은 컴포넌트를 쓴다 — B는 `scope="all"`이라 각 줄에 단어장 라벨을 덧붙인다.
 */

import { formatKst } from "@/lib/kst";
import { VOCAB_QUIZ_MODE_LABELS_KO, type VocabQuizMode } from "@/lib/vocab-quiz";
import s from "./vocab-quiz-history-view.module.css";

/** 세션 문항 하나 — 저장된 `VocabQuizItem`과 같은 shape(표시용 최소치). */
export interface QuizHistoryItem {
  word: string;
  correct: boolean;
  answered: boolean | null;
}

/** 응시기록 한 세션 — 서버가 최근순(startedAt 내림차순)으로 넘긴다. */
export interface QuizHistorySession {
  id: string;
  mode: VocabQuizMode;
  /** ISO 8601(UTC). 화면은 아래 formatKst로 KST 벽시계로 바꿔 보여준다 */
  startedAt: string;
  /** 끝까지 풀면 ISO, "그만하기"로 중단이면 null */
  finishedAt: string | null;
  items: QuizHistoryItem[];
  /** 화면 B(전체)에서만 — 어느 단어장인지. null=삭제된 단어장. 화면 A는 undefined(안 그림) */
  bookLabel?: string | null;
}

interface VocabQuizHistoryViewProps {
  sessions: QuizHistorySession[];
  scope: "book" | "all";
}

// KST 날짜·시각 표시는 lib/kst.ts의 단일 정의처를 쓴다(§17-2 — 스트릭과 같은 날짜 규칙).

/** 세션 점수 계산 — answered===true만 채점 대상(미응답은 분모에서 뺀다). correct는 그때만 뜻이 있다. */
function scoreOf(items: QuizHistoryItem[]): { correct: number; answered: number } {
  let correct = 0;
  let answered = 0;
  for (const it of items) {
    if (it.answered === true) {
      answered += 1;
      if (it.correct === true) correct += 1;
    }
  }
  return { correct, answered };
}

const MODE_BADGE_CLASS: Record<VocabQuizMode, string> = {
  "def-to-word": s.badgeDef,
  "wrong-review": s.badgeReview,
  relation: s.badgeRelation,
};

export default function VocabQuizHistoryView({ sessions, scope }: VocabQuizHistoryViewProps) {
  // 요약(읽을 때 계산) — 응시 횟수·평균 점수(맞은 문항 합/답한 문항 합)·최근 응시 시각.
  let totalCorrect = 0;
  let totalAnswered = 0;
  for (const sn of sessions) {
    const sc = scoreOf(sn.items);
    totalCorrect += sc.correct;
    totalAnswered += sc.answered;
  }
  const avgPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : null;
  const recent = sessions[0] ? formatKst(sessions[0].startedAt) : "–"; // 서버가 최근순으로 넘긴다

  return (
    <div className={s.wrap}>
      {/* 요약 */}
      <section className={s.summary} aria-label="응시 요약">
        <div className={s.summaryItem}>
          <span className={s.summaryNum}>{sessions.length}</span>
          <span className={s.summaryLabel}>응시 횟수</span>
        </div>
        <div className={s.summaryItem}>
          <span className={s.summaryNum}>{avgPct === null ? "–" : `${avgPct}%`}</span>
          <span className={s.summaryLabel}>평균 점수</span>
        </div>
        <div className={s.summaryItem}>
          <span className={s.summaryNumSm}>{recent}</span>
          <span className={s.summaryLabel}>최근 응시</span>
        </div>
      </section>

      {/* 세션 목록 (최근순) */}
      <ul className={s.list}>
        {sessions.map((sn) => {
          const { correct, answered } = scoreOf(sn.items);
          const incomplete = sn.finishedAt === null;
          return (
            <li key={sn.id}>
              <details className={s.session}>
                <summary className={s.sessionHead}>
                  <span className={s.when}>{formatKst(sn.startedAt)}</span>
                  <span className={`${s.badge} ${MODE_BADGE_CLASS[sn.mode]}`}>
                    {VOCAB_QUIZ_MODE_LABELS_KO[sn.mode]}
                  </span>
                  {scope === "all" ? (
                    <span className={`${s.book} ${sn.bookLabel == null ? s.bookGone : ""}`}>
                      {sn.bookLabel ?? "(삭제된 단어장)"}
                    </span>
                  ) : null}
                  {incomplete ? <span className={s.incomplete}>중단</span> : null}
                  <span className={s.score}>
                    <b>{correct}</b> / {answered}
                  </span>
                </summary>
                {/* 문항별 결과 — O(정답)·X(오답)·–(미응답, 그만하기로 못 푼 문항) */}
                <div className={s.items}>
                  {sn.items.map((it, i) => {
                    const state =
                      it.answered !== true ? "skip" : it.correct === true ? "ok" : "no";
                    return (
                      <span
                        key={i}
                        /* 정오를 색·기호로만 두면 색각이상·스크린리더에서 못 읽는다 —
                           "뭘 틀렸나"가 이 화면의 핵심 정보라 라벨로도 전달한다. */
                        aria-label={`${it.word} ${
                          state === "ok" ? "정답" : state === "no" ? "오답" : "미응답"
                        }`}
                        className={`${s.itemChip} ${
                          state === "ok" ? s.itemOk : state === "no" ? s.itemNo : s.itemSkip
                        }`}
                      >
                        <span aria-hidden className={s.itemWord} lang="en">
                          {it.word}
                        </span>
                        <span aria-hidden className={s.itemMark}>
                          {state === "ok" ? "O" : state === "no" ? "X" : "–"}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

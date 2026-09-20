"use client";

/**
 * 일본어 시험 응시기록 뷰 (아빠의 일본어 J2, §6-2) — 클라이언트. 영어 vocab-quiz-history-view 골격을 따른다:
 * 요약(응시 횟수·평균 점수·최근) + 세션 목록(모드 배지·점수·중단·문항별 O/X). 표시만(집계는 읽을 때 계산).
 */

import { formatKst } from "@/lib/kst";
import { JA_QUIZ_MODE_LABELS_KO, type JaQuizMode } from "@/lib/japanese-vocab-contract";
import s from "./ja-quiz-history-view.module.css";

export interface JaHistorySession {
  id: string;
  mode: JaQuizMode;
  startedAt: string; // ISO(UTC)
  finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];
}

// KST 날짜·시각 표시는 lib/kst.ts의 단일 정의처를 쓴다(§17-2 — 스트릭과 같은 날짜 규칙).

function scoreOf(items: JaHistorySession["items"]): { correct: number; answered: number } {
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

export default function JaQuizHistoryView({ sessions }: { sessions: JaHistorySession[] }) {
  let totalCorrect = 0;
  let totalAnswered = 0;
  for (const sn of sessions) {
    const sc = scoreOf(sn.items);
    totalCorrect += sc.correct;
    totalAnswered += sc.answered;
  }
  const avgPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : null;
  const recent = sessions[0] ? formatKst(sessions[0].startedAt) : "–";

  return (
    <div className={s.wrap}>
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

      <ul className={s.list}>
        {sessions.map((sn) => {
          const { correct, answered } = scoreOf(sn.items);
          const incomplete = sn.finishedAt === null;
          return (
            <li key={sn.id}>
              <details className={s.session}>
                <summary className={s.sessionHead}>
                  <span className={s.when}>{formatKst(sn.startedAt)}</span>
                  <span className={s.badge}>{JA_QUIZ_MODE_LABELS_KO[sn.mode]}</span>
                  {incomplete ? <span className={s.incomplete}>중단</span> : null}
                  <span className={s.score}>
                    <b>{correct}</b> / {answered}
                  </span>
                </summary>
                <div className={s.items}>
                  {sn.items.map((it, i) => {
                    const state = it.answered !== true ? "skip" : it.correct === true ? "ok" : "no";
                    return (
                      <span
                        key={i}
                        className={`${s.itemChip} ${state === "ok" ? s.itemOk : state === "no" ? s.itemNo : s.itemSkip}`}
                      >
                        <span className={s.itemWord} lang="ja">
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

"use client";

/**
 * 표현 시험 기록 뷰 (아빠의 영어 T2, docs/harness/toeic.md §6-2) — 클라이언트. 일본어 ja-quiz-history-view 골격:
 * 요약(응시 횟수·평균 점수·최근) + 세션 목록(모드 배지·점수·중단·문항별 O/X). 표시만 한다. 시각은 KST(lib/kst 단일 정의).
 */

import { formatKst } from "@/lib/kst";
import { TOEIC_QUIZ_MODE_LABELS_KO, type ToeicQuizMode } from "@/lib/toeic-quiz";
import s from "./toeic-quiz-history-view.module.css";

export interface ToeicHistorySession {
  id: string;
  mode: ToeicQuizMode;
  startedAt: string;
  finishedAt: string | null;
  /** label = 항목 키 표시(표현, 또는 "교재 QUIZ n") */
  items: { label: string; correct: boolean; answered: boolean | null }[];
}

function scoreOf(items: ToeicHistorySession["items"]): { correct: number; answered: number } {
  let correct = 0;
  let answered = 0;
  for (const it of items) {
    if (it.answered === true) {
      answered += 1;
      if (it.correct) correct += 1;
    }
  }
  return { correct, answered };
}

export default function ToeicQuizHistoryView({ sessions }: { sessions: ToeicHistorySession[] }) {
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
          return (
            <li key={sn.id}>
              <details className={s.session}>
                <summary className={s.sessionHead}>
                  <span className={s.when}>{formatKst(sn.startedAt)}</span>
                  <span className={s.badge}>{TOEIC_QUIZ_MODE_LABELS_KO[sn.mode]}</span>
                  {sn.finishedAt === null ? <span className={s.incomplete}>중단</span> : null}
                  <span className={s.score}>
                    <b>{correct}</b> / {answered}
                  </span>
                </summary>
                <div className={s.items}>
                  {sn.items.map((it, i) => {
                    const state = it.answered !== true ? "skip" : it.correct ? "ok" : "no";
                    return (
                      <span key={i} className={`${s.itemChip} ${state === "ok" ? s.itemOk : state === "no" ? s.itemNo : s.itemSkip}`}>
                        <span className={s.itemWord}>{it.label}</span>
                        <span aria-hidden className={s.itemMark}>
                          {state === "ok" ? "O" : state === "no" ? "X" : "–"}
                        </span>
                        <span className="sr-only">{state === "ok" ? "맞힘" : state === "no" ? "틀림" : "못 품"}</span>
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

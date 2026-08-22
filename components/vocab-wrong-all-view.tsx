"use client";

/**
 * 오답노트 — DAY를 넘어 통합 (단어장 정복 V5 층2) — 클라이언트 컴포넌트.
 *
 * 서버(`app/english/vocab/wrong/page.tsx`)가 **모든 단어장**의 시험 세션을 bookId별로 갈라
 * `aggregateWordStats`로 접어, DAY별 오답(미졸업) 단어 + 정복률을 만들어 넘긴다. 이 화면은 그것을
 * DAY 그룹으로 묶어 보여주고, 각 DAY로 **오답 재시험**(mode=wrong) 진입을 준다. AI 호출·비용 0.
 *
 * ── 왜 재시험이 DAY 단위인가 ────────────────────────────────────────────────
 * 오답 4개는 **같은 DAY**에서만 뽑아야 한다(buildChoices 계약 — cross-DAY 금지). 저장 레코드도
 * bookId(=DAY) 단위다. 그래서 통합 뷰는 "한 덱"으로 **보여주되**, 재시험은 각 DAY로 들어가
 * 그 DAY의 틀린 단어만 다시 푼다(`/english/vocab/[id]/quiz?mode=wrong`). 졸업 경로는 그대로 성립한다
 * (재시험 시도가 streak를 밀어 올린다 — 집계는 모드를 가리지 않는다).
 */

import Link from "next/link";
import { speak } from "@/lib/speech";
import { MASTERY_STREAK } from "@/lib/vocab-mastery";
import s from "./vocab-wrong-all-view.module.css";

/** 통합 오답노트의 한 단어(미졸업 오답만) */
export interface WrongDeckWord {
  word: string;
  definitionEn: string;
  wrong: number;
  streak: number;
}

/** DAY 하나 = 그룹 하나. 정복률 바(시도 중 졸업 비율) + 미졸업 오답 목록 */
export interface WrongDayGroup {
  id: string;
  titleKo: string;
  dayLabel: string | null;
  /** 시험에 나오는(정의 있는) 단어 수 */
  definedTotal: number;
  /** 한 번이라도 시도된 단어 수(정복률 분모) */
  attempted: number;
  /** 졸업한 단어 수(정복률 분자) */
  mastered: number;
  /** 아직 안 끝난 오답들(wrong>0 && 미졸업) */
  words: WrongDeckWord[];
}

interface VocabWrongAllViewProps {
  groups: WrongDayGroup[];
  /** 전체 남은 오답 수(모든 DAY 합) */
  totalOpen: number;
}

export default function VocabWrongAllView({ groups, totalOpen }: VocabWrongAllViewProps) {
  return (
    <div className={s.wrap}>
      <div className={s.summary}>
        <p className={s.summaryLead}>
          {totalOpen > 0 ? (
            <>
              모든 DAY를 통틀어 <b className={s.emph}>{totalOpen}개</b>가 남았어요.{" "}
              <span className={s.rule}>{MASTERY_STREAK}번 연속 맞히면 졸업!</span>
            </>
          ) : (
            <>틀린 단어를 모두 졸업했어요! 🎉 정말 대단해요.</>
          )}
        </p>
      </div>

      {groups.map((g) => {
        const ratio = g.attempted > 0 ? Math.round((g.mastered / g.attempted) * 100) : 0;
        const openCount = g.words.length;
        return (
          <section key={g.id} className={s.group} aria-label={`${g.titleKo} 오답`}>
            <div className={s.groupHead}>
              <div className={s.groupTitleBlock}>
                <Link href={`/english/vocab/${g.id}/wrong`} className={s.groupTitle}>
                  📕 {g.titleKo}
                </Link>
                {g.dayLabel && g.dayLabel !== g.titleKo ? (
                  <span className={s.dayLabel}>{g.dayLabel}</span>
                ) : null}
              </div>
              <span className={s.groupCount}>남은 오답 {openCount}개</span>
            </div>

            {/* 정복률 바 — 시도한 단어 중 졸업 비율 */}
            <div className={s.masteryRow}>
              <div className={s.bar} aria-hidden>
                <div className={s.barFill} style={{ width: `${ratio}%` }} />
              </div>
              <span className={s.masteryText}>
                정복 {ratio}% <span className={s.masterySub}>(시도 {g.attempted} · 졸업 {g.mastered})</span>
              </span>
            </div>

            {/* 미졸업 오답 목록 */}
            {openCount > 0 ? (
              <ul className={s.list}>
                {g.words.map((w) => (
                  <li key={w.word} className={s.row}>
                    <div className={s.rowMain}>
                      <div className={s.wordLine}>
                        <span className={s.word}>{w.word}</span>
                        <button
                          type="button"
                          className={s.speaker}
                          onClick={() => speak(w.word)}
                          aria-label={`${w.word} 발음 듣기`}
                        >
                          🔊
                        </button>
                      </div>
                      <p className={s.def}>{w.definitionEn}</p>
                    </div>
                    <span className={s.progress}>
                      연속 {w.streak}/{MASTERY_STREAK}
                      {w.wrong > 0 ? ` · 틀림 ${w.wrong}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : g.mastered === g.attempted ? (
              <p className={s.groupDone}>이 DAY는 다 졸업했어요! 🎓</p>
            ) : (
              <p className={s.groupDone}>다시 풀 오답은 없어요.</p>
            )}

            {openCount > 0 ? (
              <Link href={`/english/vocab/${g.id}/quiz?mode=wrong`} className={`u-btn u-btn-primary ${s.reviewBtn}`}>
                <span aria-hidden>🔁</span> 이 DAY 오답 {openCount}개 다시 풀기
              </Link>
            ) : null}
          </section>
        );
      })}

      <div className={s.footer}>
        <Link href="/english/vocab" className="u-btn u-btn-secondary">
          <span aria-hidden>📓</span> 단어장 목록
        </Link>
      </div>
    </div>
  );
}

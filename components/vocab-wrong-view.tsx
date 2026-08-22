"use client";

/**
 * 오답노트 — DAY 안 (단어장 정복 V5 층1) — 클라이언트 컴포넌트.
 *
 * 서버(`app/english/vocab/[id]/wrong/page.tsx`)가 그 DAY의 시험 세션을 `aggregateWordStats`로 접어
 * 단어별 {total, wrong, streak, mastered}를 만들어 넘긴다. 이 화면은 그 줄들을 **필터 3종**으로
 * 걸러 보여준다 — 진행·집계는 서버 계산이라 여기선 표시·필터·발음만 한다. **AI 호출·비용 0.**
 *
 * ── 필터 3종 (계획 §V5) ─────────────────────────────────────────────────────
 * - 전체:  정의가 있는(시험에 나오는) 단어 전부
 * - 틀린:  wrong>0 && 미졸업 — 틀린 적 있고 아직 졸업 못 한 단어(**졸업하면 내려간다**)
 * - 안 본: total===0 — 아직 한 번도 시험에서 만나지 못한 단어
 *
 * FILTERS 배열·aria-pressed·활성 하이라이트는 `components/math-library-view.tsx`의 관용구를
 * 이 문맥에 맞게 **복제**한 것이다(공유하지 않음 — 문맥별 라벨·필터 규칙이 다르다).
 *
 * ── 졸업 규칙 ───────────────────────────────────────────────────────────────
 * **2번 연속 맞히면 졸업**(streak >= 2, `isMastered`). 서버가 mastered를 계산해 주므로 여기선 배지만
 * 그린다 — 졸업 단어는 🎓 표기 + "틀린" 필터에서 빠진다. 재시험 경로는 "오답 다시 풀기"(mode=wrong).
 */

import Link from "next/link";
import { useState } from "react";
import { speak, stopSpeaking } from "@/lib/speech";
import { MASTERY_STREAK } from "@/lib/vocab-mastery";
import s from "./vocab-wrong-view.module.css";

/** 오답노트 한 줄 — 서버가 정의 있는 단어마다 집계를 붙여 넘긴다 */
export interface WrongWordRow {
  word: string;
  /** 영영 정의(발음·복습 힌트로 보여준다) */
  definitionEn: string;
  /** 시도 수(answered===true) */
  total: number;
  /** 오답 수 */
  wrong: number;
  /** 현재 연속 정답 수 */
  streak: number;
  /** 졸업 여부(streak >= 2) */
  mastered: boolean;
}

type FilterKey = "all" | "wrong" | "unseen";

const FILTERS: { key: FilterKey; labelKo: string }[] = [
  { key: "all", labelKo: "전체" },
  { key: "wrong", labelKo: "틀린 단어" },
  { key: "unseen", labelKo: "안 본 단어" },
];

/** 틀린 필터: 틀린 적 있고 아직 졸업 못 한 단어(졸업하면 내려간다) */
function isWrongOpen(r: WrongWordRow): boolean {
  return r.wrong > 0 && !r.mastered;
}
/** 안 본 필터: 시험에서 한 번도 만나지 못한 단어 */
function isUnseen(r: WrongWordRow): boolean {
  return r.total === 0;
}

interface VocabWrongViewProps {
  id: string;
  titleKo: string;
  dayLabel: string | null;
  rows: WrongWordRow[];
  /** 이 DAY에서 시험을 한 번이라도 봤는가(전체 세션 수 > 0) — 빈 상태 안내 분기 */
  hasQuizzes: boolean;
}

export default function VocabWrongView({ id, titleKo, dayLabel, rows, hasQuizzes }: VocabWrongViewProps) {
  const [filter, setFilter] = useState<FilterKey>(hasQuizzes ? "wrong" : "all");

  const wrongOpenCount = rows.filter(isWrongOpen).length;
  const unseenCount = rows.filter(isUnseen).length;
  const masteredCount = rows.filter((r) => r.mastered).length;

  const filtered =
    filter === "wrong" ? rows.filter(isWrongOpen) : filter === "unseen" ? rows.filter(isUnseen) : rows;

  // 시험을 한 번도 안 봤으면 오답노트가 성립하지 않는다 — 시험으로 안내한다.
  if (!hasQuizzes) {
    return (
      <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
        <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
          📝✨
        </p>
        <h2 className="t-section-title mt-2">아직 시험을 본 적이 없어요</h2>
        <p className="t-lead mt-2">
          시험을 한 번 보면, 여기에 <b>틀린 단어</b>가 모여요. {MASTERY_STREAK}번 연속 맞히면 졸업이에요!
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href={`/english/vocab/${id}/quiz`} className="u-btn u-btn-primary">
            <span aria-hidden>📝</span> 시험 보러 가기
          </Link>
          <Link href={`/english/vocab/${id}`} className="u-btn u-btn-secondary">
            <span aria-hidden>📖</span> 단어장으로
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className={s.wrap}>
      {/* 요약 배너 — 남은 오답·졸업 수를 한눈에 */}
      <div className={s.summary}>
        <p className={s.summaryLead}>
          {wrongOpenCount > 0 ? (
            <>
              아직 <b className={s.emph}>{wrongOpenCount}개</b> 남았어요.{" "}
              <span className={s.rule}>{MASTERY_STREAK}번 연속 맞히면 졸업!</span>
            </>
          ) : (
            <>
              틀린 단어를 모두 졸업했어요! 🎉 <span className={s.rule}>정말 잘했어요.</span>
            </>
          )}
        </p>
        {masteredCount > 0 ? (
          <p className="t-caption">
            🎓 졸업한 단어 {masteredCount}개 · 시험에 나오는 단어 {rows.length}개
          </p>
        ) : null}
      </div>

      {/* 필터 3종 (math-library-view 관용구 복제) */}
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div role="group" aria-label="오답노트 거르기" className="flex min-w-0 flex-1 gap-2">
          {FILTERS.map((f) => {
            const count = f.key === "wrong" ? wrongOpenCount : f.key === "unseen" ? unseenCount : rows.length;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`u-btn min-w-0 flex-1 ${filter === f.key ? "u-btn-primary" : "u-btn-secondary"}`}
              >
                {f.labelKo}
                <span className={s.filterCount}> {count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 재시험 진입 — 틀린·미졸업 단어가 있을 때만 */}
      {wrongOpenCount > 0 ? (
        <Link href={`/english/vocab/${id}/quiz?mode=wrong`} className={`u-btn u-btn-primary ${s.reviewBtn}`}>
          <span aria-hidden>🔁</span> 틀린 단어 {wrongOpenCount}개 다시 풀기
        </Link>
      ) : null}

      {/* 단어 줄 목록 */}
      {filtered.length === 0 ? (
        <p className={s.emptyList}>
          {filter === "wrong"
            ? "틀린 단어가 없어요. 잘하고 있어요! 🎉"
            : filter === "unseen"
              ? "안 본 단어가 없어요 — 모든 단어를 한 번씩은 만났어요."
              : "보여줄 단어가 없어요."}
        </p>
      ) : (
        <ul className={s.list}>
          {filtered.map((r) => (
            <li key={r.word} className={`${s.row} ${r.mastered ? s.rowMastered : ""}`}>
              <div className={s.rowMain}>
                <div className={s.wordLine}>
                  <span className={s.word}>{r.word}</span>
                  <button
                    type="button"
                    className={s.speaker}
                    onClick={() => speak(r.word)}
                    aria-label={`${r.word} 발음 듣기`}
                  >
                    🔊
                  </button>
                </div>
                <p className={s.def}>{r.definitionEn}</p>
              </div>
              <div className={s.rowSide}>{renderBadge(r)}</div>
            </li>
          ))}
        </ul>
      )}

      <div className={s.footer}>
        <Link href={`/english/vocab/${id}`} className="u-btn u-btn-secondary" onClick={() => stopSpeaking()}>
          <span aria-hidden>📖</span> 단어장으로
        </Link>
        <Link href={`/english/vocab/${id}/quiz`} className="u-btn u-btn-secondary">
          <span aria-hidden>📝</span> 전체 시험 보기
        </Link>
      </div>
    </div>
  );
}

/** 단어 줄 오른쪽 배지 — 졸업 / 진행(연속 n회) / 안 봄 */
function renderBadge(r: WrongWordRow) {
  if (r.mastered) {
    return <span className={s.badgeMastered}>🎓 졸업</span>;
  }
  if (r.total === 0) {
    return <span className={s.badgeUnseen}>아직 안 봤어요</span>;
  }
  // 진행 중 — 연속 정답을 점으로(졸업까지 MASTERY_STREAK개), 오답 수도 함께
  return (
    <span className={s.badgeProgress}>
      <span className={s.dots} aria-hidden>
        {Array.from({ length: MASTERY_STREAK }, (_, i) => (
          <span key={i} className={i < r.streak ? s.dotOn : s.dotOff}>
            ●
          </span>
        ))}
      </span>
      <span className={s.progressText}>
        연속 {r.streak}/{MASTERY_STREAK}
        {r.wrong > 0 ? ` · 틀림 ${r.wrong}` : ""}
      </span>
    </span>
  );
}

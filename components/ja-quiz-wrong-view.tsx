"use client";

/**
 * 일본어 오답노트 (아빠의 일본어 J2, §6-2) — 클라이언트. **모드별 탭**으로 숙련도 분리를 눈에 보이게 한다
 * (뜻은 아는데 독음을 모르는 상태가 드러나는 게 핵심). 탭마다 그 모드에서 틀리고 미졸업인 단어 + "다시 풀기".
 */

import Link from "next/link";
import { useState } from "react";
import JaRuby from "@/components/ja-ruby";
import { JA_QUIZ_MODE_LABELS_KO, type JaQuizContentMode, type JaToken } from "@/lib/japanese-vocab-contract";
import s from "./ja-quiz-wrong-view.module.css";

export interface JaWrongWord {
  word: string;
  wordTokens: JaToken[];
  kana: string;
  meaningsKo: string[];
  wrong: number;
}
export interface JaWrongModeGroup {
  mode: JaQuizContentMode;
  /** 그 모드에서 시도된 단어 수 */
  attempted: number;
  /** 그 모드 졸업(연속 2회 정답) 단어 수 */
  mastered: number;
  /** 틀리고 아직 미졸업인 단어들 */
  words: JaWrongWord[];
}

export default function JaQuizWrongView({ id, groups }: { id: string; groups: JaWrongModeGroup[] }) {
  // 기본 탭 = 틀린 단어가 있는 첫 모드, 없으면 첫 모드.
  const firstWithWords = groups.find((g) => g.words.length > 0) ?? groups[0];
  const [active, setActive] = useState<JaQuizContentMode>(firstWithWords?.mode ?? groups[0]?.mode);
  const group = groups.find((g) => g.mode === active) ?? groups[0];

  return (
    <div className={s.wrap}>
      {/* 모드 탭 — 각 탭에 미졸업 오답 수 배지 */}
      <div role="tablist" aria-label="시험 방식" className={s.tabs}>
        {groups.map((g) => (
          <button
            key={g.mode}
            type="button"
            role="tab"
            aria-selected={g.mode === active}
            onClick={() => setActive(g.mode)}
            className={`${s.tab} ${g.mode === active ? s.tabOn : ""}`}
          >
            {JA_QUIZ_MODE_LABELS_KO[g.mode]}
            {g.words.length > 0 && <span className={s.tabCount}>{g.words.length}</span>}
          </button>
        ))}
      </div>

      {group && (
        <section className={s.panel} aria-live="polite">
          <p className="t-caption">
            {JA_QUIZ_MODE_LABELS_KO[group.mode]} — 시도 {group.attempted}개 · 졸업 {group.mastered}개 · 남은 오답{" "}
            {group.words.length}개
          </p>

          {group.words.length === 0 ? (
            <p className={s.empty}>
              {group.attempted === 0
                ? "이 방식으로는 아직 시험을 안 봤어요."
                : "이 방식에서 틀린 단어를 모두 졸업했어요! 🎉"}
            </p>
          ) : (
            <>
              <div className={s.actions}>
                <Link href={`/japanese/vocab/${id}/quiz?wrong=${group.mode}`} className="u-btn u-btn-primary">
                  <span aria-hidden>🔁</span> 이 방식 오답 다시 풀기
                </Link>
              </div>
              <ul className={s.list}>
                {group.words.map((w) => (
                  <li key={w.word} className={s.row}>
                    <JaRuby
                      tokens={w.wordTokens.length > 0 ? w.wordTokens : [{ surface: w.word, reading: null }]}
                      className={s.word}
                    />
                    {w.kana && w.kana !== w.word && (
                      <span className={s.kana} lang="ja">
                        {w.kana}
                      </span>
                    )}
                    <span className={s.meaning}>{w.meaningsKo.join(", ")}</span>
                    <span className={s.wrongChip}>{w.wrong}번 틀림</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

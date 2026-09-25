"use client";

/**
 * 표현 시험 오답노트 (아빠의 영어 T2, docs/harness/toeic.md §6-2) — 클라이언트. **모드별 탭**으로 숙련도 분리를 눈에 보이게 한다.
 * 탭마다 그 모드에서 틀리고 미졸업인 항목 + "이 방식 오답 다시 풀기" + 졸업한 항목(🎓). 일본어 ja-quiz-wrong-view 골격.
 */

import Link from "next/link";
import { useState } from "react";
import { speak } from "@/lib/speech";
import { TOEIC_QUIZ_MODE_LABELS_KO, type ToeicQuizMode } from "@/lib/toeic-quiz";
import s from "./toeic-quiz-wrong-view.module.css";

export interface ToeicWrongModeGroup {
  mode: ToeicQuizMode;
  /** 그 모드에서 시도한 항목 수 */
  attempted: number;
  /** 틀리고 아직 미졸업 */
  wrong: { key: string; title: string; sub: string | null; wrongCount: number }[];
  /** 졸업(연속 2회 정답) */
  mastered: { key: string; title: string; sub: string | null }[];
}

export default function ToeicQuizWrongView({ id, groups }: { id: string; groups: ToeicWrongModeGroup[] }) {
  const firstWithWrong = groups.find((g) => g.wrong.length > 0) ?? groups.find((g) => g.attempted > 0) ?? groups[0];
  const [active, setActive] = useState<ToeicQuizMode>(firstWithWrong.mode);
  const group = groups.find((g) => g.mode === active) ?? groups[0];

  return (
    <div className={s.wrap}>
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
            {TOEIC_QUIZ_MODE_LABELS_KO[g.mode]}
            {g.wrong.length > 0 && <span className={s.tabCount}>{g.wrong.length}</span>}
          </button>
        ))}
      </div>

      <section className={s.panel} aria-live="polite">
        <p className="t-caption">
          {TOEIC_QUIZ_MODE_LABELS_KO[group.mode]} — 시도 {group.attempted}개 · 졸업 {group.mastered.length}개 · 남은 오답 {group.wrong.length}개
        </p>

        {group.wrong.length === 0 ? (
          <p className={s.empty}>
            {group.attempted === 0 ? "이 방식으로는 아직 시험을 안 봤어요." : "이 방식에서 틀린 항목을 모두 졸업했어요! 🎉"}
          </p>
        ) : (
          <>
            <div className={s.actions}>
              <Link href={`/toeic/sets/${id}/quiz?wrong=${group.mode}`} className="u-btn u-btn-primary">
                <span aria-hidden>🔁</span> 이 방식 오답 다시 풀기
              </Link>
            </div>
            <ul className={s.list}>
              {group.wrong.map((w) => (
                <li key={w.key} className={s.row}>
                  <span className={s.title} lang="en">
                    {w.title}
                  </span>
                  {/* 세트에서 찾은 항목(영어 표현·모범답변)만 🔊 — 사라진 키의 한국어 라벨을 영어 음성으로 읽지 않게 */}
                  {w.sub !== null && (
                    <button type="button" className={s.speak} onClick={() => speak(w.title.trim(), "en-US")} aria-label={`${w.title} 듣기`}>
                      🔊
                    </button>
                  )}
                  {w.sub && <span className={s.sub}>{w.sub}</span>}
                  <span className={s.wrongChip}>{w.wrongCount}번 틀림</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {group.mastered.length > 0 && (
          <details className={s.mastered}>
            <summary>🎓 졸업한 항목 {group.mastered.length}개</summary>
            <ul className={s.masteredList}>
              {group.mastered.map((m) => (
                <li key={m.key} className={s.masteredItem} lang="en">
                  🎓 {m.title}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

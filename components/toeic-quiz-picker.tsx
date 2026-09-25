"use client";

/**
 * 표현 시험 모드 고르기 (아빠의 영어 T2, docs/harness/toeic.md §6-1) — 클라이언트.
 *
 * 5지선다 세 모드(뜻 → 표현 · 표현 → 뜻 · 빈칸)는 **기본 전부 혼합**, 말하기(한 → 영, 자기 채점)는 **따로** 시작한다(§6-1
 * "기본 5지선다 3모드 혼합 + speak는 따로"). 고르면 `?modes=a,b,c`(또는 `?modes=speak`)로 이동 → 서버가 세션을 조립한다.
 * 모드 목록·낼 수 있는 문항 수는 서버가 props로 내린다(0이면 그 모드는 고를 수 없다 — 이유도 서버가 정해 내린다: 빈칸은 예문과
 * 발화 포인트, 세 방식 공통으로 보기 2개 이상 = 뜻이 다른 표현 2개 이상, §6-1).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOEIC_QUIZ_MODE_LABELS_KO, type ToeicChoiceQuizMode } from "@/lib/toeic-quiz";
import s from "./toeic-quiz.module.css";

const MODE_HINT_KO: Record<ToeicChoiceQuizMode, string> = {
  "ko-to-expr": "한국어 뜻을 보고 영어 표현 고르기",
  "expr-to-ko": "영어 표현을 보고 뜻 고르기",
  cloze: "교재 예문의 빈칸에 들어갈 구간 고르기(해석 함께)",
};

export default function ToeicQuizPicker({
  id,
  choiceModes,
  choiceCounts,
  choiceZeroReasonsKo,
  speakCount,
}: {
  id: string;
  choiceModes: ToeicChoiceQuizMode[];
  /** 모드마다 낼 수 있는 문항 수(서버 계산) */
  choiceCounts: Record<ToeicChoiceQuizMode, number>;
  /** 0문항일 때 보일 이유(서버 계산) */
  choiceZeroReasonsKo: Record<ToeicChoiceQuizMode, string>;
  /** 말하기 세션 문항 수(최대 10) */
  speakCount: number;
}) {
  const router = useRouter();
  const available = choiceModes.filter((m) => (choiceCounts[m] ?? 0) > 0);
  const [selected, setSelected] = useState<ToeicChoiceQuizMode[]>(available); // 기본: 낼 수 있는 모드 전부 혼합
  const total = selected.reduce((n, m) => n + (choiceCounts[m] ?? 0), 0);

  function toggle(m: ToeicChoiceQuizMode) {
    setSelected((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  }

  function startChoice() {
    if (selected.length === 0) return;
    const ordered = choiceModes.filter((m) => selected.includes(m)); // URL 안정화(선택 순서 무관)
    router.push(`/toeic/sets/${id}/quiz?modes=${ordered.join(",")}`);
  }

  return (
    <div className={s.wrap}>
      <section className={s.pickSection} aria-label="보고 고르기">
        <p className="t-section-title">👀 보고 고르기 (5지선다)</p>
        <p className="t-caption">여러 방식을 고르면 섞어서 내요. 답을 고르면 표현을 영어로 읽어 줘요.</p>
        <div className={s.choices} role="group" aria-label="시험 방식">
          {choiceModes.map((m) => {
            const count = choiceCounts[m] ?? 0;
            const on = selected.includes(m);
            return (
              <button
                key={m}
                type="button"
                onClick={() => toggle(m)}
                disabled={count === 0}
                aria-pressed={on}
                className={`${s.choice} ${on ? s.choiceCorrect : ""}`}
              >
                <span className={s.choiceText}>
                  <b>{TOEIC_QUIZ_MODE_LABELS_KO[m]}</b>
                  <span className={s.pickHint}>
                    {count === 0 ? choiceZeroReasonsKo[m] : `${MODE_HINT_KO[m]} · ${count}문항`}
                  </span>
                </span>
                {on ? (
                  <span aria-hidden className={s.mark}>
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className={s.actions}>
          <button type="button" className="u-btn u-btn-primary" onClick={startChoice} disabled={selected.length === 0}>
            <span aria-hidden>📝</span> 시작 ({total}문항)
          </button>
        </div>
      </section>

      <section className={s.pickSection} aria-label="말하기">
        <p className="t-section-title">🎙️ 말하기 (한 → 영)</p>
        <p className="t-caption">
          우리말 문장을 보고 소리 내어 영어로 말한 뒤, 정답을 보고 스스로 채점해요. 교재 QUIZ 먼저, 그다음 아직 약한 표현의 활용 문장이
          나와요(최대 10문항).
        </p>
        <div className={s.actions}>
          <button
            type="button"
            className="u-btn u-btn-primary"
            onClick={() => router.push(`/toeic/sets/${id}/quiz?modes=speak`)}
            disabled={speakCount === 0}
          >
            <span aria-hidden>🎙️</span> 말하기 시작 ({speakCount}문항)
          </button>
        </div>
        {speakCount === 0 && <p className="t-caption">교재 QUIZ나 발화 포인트가 있어야 말하기 문제를 낼 수 있어요.</p>}
      </section>
    </div>
  );
}

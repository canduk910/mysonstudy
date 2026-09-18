"use client";

/**
 * 일본어 시험 모드 선택 (아빠의 일본어 J2, §6-1) — 클라이언트. 콘텐츠 4모드 중 고른다(기본 전부 = 혼합).
 * 고르면 `?modes=a,b,c`로 이동 → 서버가 그 모드로 세션을 조립한다. 모드 상수(값)는 서버가 props로 내려준다.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JA_QUIZ_MODE_LABELS_KO, type JaQuizContentMode } from "@/lib/japanese-vocab-contract";
import s from "./ja-quiz-runner.module.css";

export default function JaQuizPicker({
  id,
  contentModes,
}: {
  id: string;
  contentModes: JaQuizContentMode[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<JaQuizContentMode[]>(contentModes); // 기본 전 모드 혼합

  function toggle(m: JaQuizContentMode) {
    setSelected((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  }

  function start() {
    if (selected.length === 0) return;
    // contentModes 순서를 유지해 URL을 안정화(선택 순서 무관)
    const ordered = contentModes.filter((m) => selected.includes(m));
    router.push(`/japanese/vocab/${id}/quiz?modes=${ordered.join(",")}`);
  }

  return (
    <div className={s.wrap}>
      <p className="t-lead">어떤 방식으로 볼까요? 여러 개 고르면 섞어서 내요.</p>
      <div className={s.choices} role="group" aria-label="시험 모드">
        {contentModes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => toggle(m)}
            aria-pressed={selected.includes(m)}
            className={`${s.choice} ${selected.includes(m) ? s.choiceCorrect : ""}`}
          >
            <span className={s.choiceText}>{JA_QUIZ_MODE_LABELS_KO[m]}</span>
            {selected.includes(m) ? <span aria-hidden className={s.mark}>✓</span> : null}
          </button>
        ))}
      </div>
      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={start} disabled={selected.length === 0}>
          <span aria-hidden>📝</span> 시험 시작 ({selected.length}가지)
        </button>
      </div>
    </div>
  );
}

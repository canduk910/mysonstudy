"use client";

/**
 * "문항마다 마이크 다시 열기" — 마이크 유지(전략 B, SPEC §20-4 · docs/harness/toeic.md §6-4)의 기기별 탈출구.
 * 마이크를 쥔 채(play-and-record)라 질문 소리가 작거나 수화기로 나는 기기에서 켜면 이 기기는 예전처럼 녹음마다 마이크를 연다.
 * 유지가 가능한 브라우저(Apple WebKit + navigator.audioSession)에서만 보인다 — 그 밖은 원래 녹음마다 연다.
 * 응시 화면·틀 테스트 시작 화면이 같이 쓴다(규칙 한 곳). 기기 설정은 lib/mic-session(localStorage `toeic-mic-per-answer`).
 */

import { useEffect, useState } from "react";
import { detectMicKeepEnv, micKeepPolicyFor, writeMicPerAnswerPref } from "@/lib/mic-session";
import s from "./toeic-mic-keep-toggle.module.css";

export default function ToeicMicKeepToggle({ onChange }: { onChange: (perAnswer: boolean) => void }) {
  // 렌더 중 navigator·localStorage를 읽지 않는다(hydration) — 마운트 뒤에 본다
  const [state, setState] = useState<{ canKeep: boolean; perAnswer: boolean } | null>(null);
  useEffect(() => {
    const env = detectMicKeepEnv();
    setState({ canKeep: micKeepPolicyFor({ ...env, perAnswerPref: false }) === "keep", perAnswer: env.perAnswerPref });
  }, []);
  if (!state || !state.canKeep) return null;
  return (
    <label className={s.toggle}>
      <input
        type="checkbox"
        checked={state.perAnswer}
        data-testid="mic-per-answer"
        onChange={(e) => {
          const on = e.target.checked;
          writeMicPerAnswerPref(on);
          setState({ canKeep: true, perAnswer: on });
          onChange(on);
        }}
      />
      <span>
        문항마다 마이크 다시 열기
        <span className={s.sub}>질문 소리가 작거나 수화기로 날 때만 켜요 — 이 기기에 기억하고, 녹음할 때마다 권한을 다시 물을 수 있어요.</span>
      </span>
    </label>
  );
}

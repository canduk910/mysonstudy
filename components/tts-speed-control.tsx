"use client";

/**
 * 읽어주기(TTS) 속도 컨트롤 — 3단 분절 버튼(천천히·보통·빠르게).
 *
 * 슬라이더가 아니라 버튼인 이유: 아이+폰 맥락이라 큰 탭 타깃이 낫고, 챕터리더·단어장은
 * 세로 스크롤 목록이라 가로 슬라이더 드래그가 스크롤과 충돌한다(이 앱이 이미 겪은 문제).
 * 재생 속도는 3~4단이면 충분하고, "천천히"가 켜진 게 눈에 보이는 편이 "0.9×"보다 아이에게 낫다.
 *
 * 값은 lib/speech.ts의 **전역 하나**(getTtsRate/setTtsRate, localStorage 영속)를 읽고 쓴다 —
 * 화면마다 갈리면 같은 단어가 다른 목소리로 들린다(speech.ts 서두의 "값 하나" 원칙). 그래서 이
 * 컨트롤이 여러 화면(챕터리더·단어장)에 놓여도 모두 같은 값을 가리키고, 한 곳에서 바꾸면
 * 커스텀 이벤트로 같은 페이지의 다른 컨트롤이 즉시 따라온다. 자동낭독(시험 등)도 전역값을 자동 반영한다.
 *
 * ⚠️ hydration: 초기 렌더는 항상 기본값(TTS_RATE=보통)을 강조한다(SSR=첫 클라 렌더 일치).
 * 저장값 반영은 마운트 후 useEffect에서 한다 — 첫 렌더에서 localStorage를 읽으면 mismatch가 난다
 * (vocabbook-view의 표/카드 토글과 같은 규약).
 */

import { useEffect, useState } from "react";
import { getTtsRate, setTtsRate, TTS_RATE, TTS_RATE_EVENT, TTS_RATE_PRESETS } from "@/lib/speech";

export default function TtsSpeedControl() {
  // 초기 렌더는 기본값(SSR과 일치). 저장값은 마운트 후 반영한다.
  const [rate, setRate] = useState(TTS_RATE);

  useEffect(() => {
    setRate(getTtsRate());
    // 같은 페이지의 다른 속도 컨트롤이 바꾸면 따라온다.
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number") setRate(detail);
    };
    window.addEventListener(TTS_RATE_EVENT, onChange);
    return () => window.removeEventListener(TTS_RATE_EVENT, onChange);
  }, []);

  return (
    <div role="group" aria-label="읽기 속도" className="flex flex-wrap items-center gap-1">
      <span className="t-caption mr-1 shrink-0" aria-hidden>
        🔊 속도
      </span>
      {TTS_RATE_PRESETS.map((p) => {
        const active = Math.abs(rate - p.rate) < 0.001;
        return (
          <button
            key={p.rate}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setTtsRate(p.rate);
              setRate(p.rate);
            }}
            className={`t-caption min-h-[var(--tap-min)] rounded-[var(--radius-box)] border px-3 ${
              active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-bg text-ink"
            }`}
          >
            {p.labelKo}
          </button>
        );
      })}
    </div>
  );
}

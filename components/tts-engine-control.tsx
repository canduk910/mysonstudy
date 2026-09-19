"use client";

/**
 * 발음 엔진 선택 — 언어별 **클라우드 / 기기** 토글 + 미리듣기 (SPEC §16).
 *
 * 사용자 실청취 피드백: 영어는 클라우드가 자연스럽고, 일본어는 기기 음성(Kyoko)이 피치 액센트가 살아 더 낫다.
 * 그래서 추측하지 않고 **언어별로 고르게** 한다. 값은 lib/speech.ts의 전역(getTtsEngine/setTtsEngine, localStorage
 * 언어별 영속)을 읽고 쓴다 — TtsSpeedControl과 같은 규약(한 곳에서 바꾸면 이벤트로 같은 페이지가 따라오고,
 * 자동낭독·프리페치도 전역값을 자동 반영).
 *
 * ⚠️ hydration: 초기 렌더는 SSR과 같게 기본값을 그린 뒤, 마운트 후 useEffect에서 저장값을 반영한다
 * (TtsSpeedControl과 같은 규약 — 첫 렌더에서 localStorage를 읽으면 mismatch).
 *
 * `lang`은 이 컨트롤이 다룰 언어(en-US=영어 화면, ja-JP=일본어 화면). 클라우드 대상 언어가 아니면 아무것도 그리지 않는다.
 */

import { useEffect, useState } from "react";
import { getTtsEngine, setTtsEngine, speak, TTS_ENGINE_EVENT, type TtsEngine } from "@/lib/speech";
import { isTtsLang } from "@/lib/tts-shared";

/** 미리듣기 샘플 — 현재 엔진·속도로 그 언어 한 문장을 읽어 준다. */
const SAMPLE: Record<string, string> = {
  "en-US": "The quick brown fox jumps over the lazy dog.",
  "ja-JP": "こんにちは。今日はいい天気ですね。",
};
const ENGINE_LABEL: Record<TtsEngine, string> = { cloud: "클라우드", device: "기기" };

export default function TtsEngineControl({ lang }: { lang: string }) {
  // 초기 렌더는 SSR과 일치하도록 기기(가장 보수적)로 그리고, 마운트 후 실제값을 반영한다.
  const [engine, setEngine] = useState<TtsEngine>("device");

  useEffect(() => {
    setEngine(getTtsEngine(lang));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ lang: string; engine: TtsEngine }>).detail;
      if (detail && detail.lang === lang) setEngine(detail.engine);
    };
    window.addEventListener(TTS_ENGINE_EVENT, onChange);
    return () => window.removeEventListener(TTS_ENGINE_EVENT, onChange);
  }, [lang]);

  if (!isTtsLang(lang)) return null; // 클라우드 대상(en·ja)만 — 그 밖 언어는 늘 기기라 선택지가 없다

  const langLabel = lang === "ja-JP" ? "일본어" : "영어";

  return (
    <div role="group" aria-label={`${langLabel} 발음 엔진`} className="flex flex-wrap items-center gap-1">
      <span className="t-caption mr-1 shrink-0" aria-hidden>
        🗣️ {langLabel} 발음
      </span>
      {(["cloud", "device"] as TtsEngine[]).map((eng) => {
        const active = engine === eng;
        return (
          <button
            key={eng}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setTtsEngine(lang, eng);
              setEngine(eng);
            }}
            className={`t-caption min-h-[var(--tap-min)] rounded-[var(--radius-box)] border px-3 ${
              active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-bg text-ink"
            }`}
          >
            {ENGINE_LABEL[eng]}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => speak(SAMPLE[lang] ?? "", lang)}
        aria-label={`${langLabel} 발음 미리듣기`}
        title="지금 설정으로 미리듣기"
        className="t-caption min-h-[var(--tap-min)] rounded-[var(--radius-box)] border border-line bg-bg px-3 text-ink"
      >
        ▶ 미리듣기
      </button>
    </div>
  );
}

"use client";

/**
 * 발음 엔진 선택 + 기기 음성 고르기/진단 (SPEC §16) — 언어별.
 *
 * - **엔진 토글**(클라우드/기기): 영어는 클라우드가 자연스럽고 일본어는 기기(Kyoko)가 나을 수 있어 언어별로 고른다.
 * - **기기 음성(device일 때만)**: 지금 쓰는 음성과 품질을 보여주고(진단), 직접 고르게 하고, 고품질 받는 법을 안내한다.
 *   브라우저가 기본으로 저품질(compact)을 고르는 문제를 해결한다 — lib/speech.ts가 품질 순으로 자동 선택하되
 *   사용자가 덮어쓸 수 있다. 클라우드 언어엔 이 UI가 의미 없어 감춘다.
 *
 * 값은 lib/speech.ts 전역(언어별 localStorage 영속)을 읽고 쓴다. 화면은 판단하지 않는다(순위·해석은 speech.ts).
 *
 * ⚠️ hydration: 음성 목록·저장값은 **마운트 후** useEffect에서만 읽는다(렌더 중 getVoices/localStorage 금지).
 * voiceschanged로 목록이 늦게 채워지면 TTS_VOICES_EVENT로 다시 그린다.
 */

import { useEffect, useState } from "react";
import {
  getCurrentVoiceInfo,
  getSelectedVoiceURI,
  getTtsEngine,
  listVoicesForLang,
  setSelectedVoice,
  setTtsEngine,
  speak,
  TTS_ENGINE_EVENT,
  TTS_VOICES_EVENT,
  type TtsEngine,
  type VoiceOption,
} from "@/lib/speech";
import { isTtsLang } from "@/lib/tts-shared";

const SAMPLE: Record<string, string> = {
  "en-US": "The quick brown fox jumps over the lazy dog.",
  "ja-JP": "こんにちは。今日はいい天気ですね。",
};
const ENGINE_LABEL: Record<TtsEngine, string> = { cloud: "클라우드", device: "기기" };

const btn = (active: boolean) =>
  `t-caption min-h-[var(--tap-min)] rounded-[var(--radius-box)] border px-3 ${
    active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-bg text-ink"
  }`;

export default function TtsEngineControl({ lang }: { lang: string }) {
  const [engine, setEngine] = useState<TtsEngine>("device");
  const [voiceInfo, setVoiceInfo] = useState<VoiceOption | null>(null);
  const [voiceList, setVoiceList] = useState<VoiceOption[]>([]);
  const [selectedURI, setSelectedURI] = useState<string>(""); // ""=자동(추천)

  useEffect(() => {
    const refresh = () => {
      const eng = getTtsEngine(lang);
      setEngine(eng);
      if (eng === "device") {
        setVoiceInfo(getCurrentVoiceInfo(lang));
        setVoiceList(listVoicesForLang(lang));
        setSelectedURI(getSelectedVoiceURI(lang) ?? "");
      }
    };
    refresh();
    const onEngine = (e: Event) => {
      const d = (e as CustomEvent<{ lang: string; engine: TtsEngine }>).detail;
      if (d && d.lang === lang) refresh();
    };
    const onVoices = () => refresh(); // voiceschanged(늦게 채워짐) · 음성 선택 변경
    window.addEventListener(TTS_ENGINE_EVENT, onEngine);
    window.addEventListener(TTS_VOICES_EVENT, onVoices);
    return () => {
      window.removeEventListener(TTS_ENGINE_EVENT, onEngine);
      window.removeEventListener(TTS_VOICES_EVENT, onVoices);
    };
  }, [lang]);

  if (!isTtsLang(lang)) return null; // 클라우드 대상(en·ja)만

  const langLabel = lang === "ja-JP" ? "일본어" : "영어";

  return (
    <div role="group" aria-label={`${langLabel} 발음 설정`} className="flex flex-col gap-1">
      {/* 엔진 토글 + 미리듣기 */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="t-caption mr-1 shrink-0" aria-hidden>
          🗣️ {langLabel} 발음
        </span>
        {(["cloud", "device"] as TtsEngine[]).map((eng) => (
          <button
            key={eng}
            type="button"
            aria-pressed={engine === eng}
            onClick={() => {
              setTtsEngine(lang, eng);
              setEngine(eng);
            }}
            className={btn(engine === eng)}
          >
            {ENGINE_LABEL[eng]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => speak(SAMPLE[lang] ?? "", lang)}
          aria-label={`${langLabel} 발음 미리듣기`}
          title="지금 설정으로 미리듣기"
          className={btn(false)}
        >
          ▶ 미리듣기
        </button>
      </div>

      {/* 기기 음성 진단·선택 (device일 때만) */}
      {engine === "device" ? (
        <div className="flex flex-col gap-1">
          <span className="t-caption" aria-live="polite">
            현재: {voiceInfo ? `${voiceInfo.name} (${voiceInfo.quality})` : "기기 음성을 찾는 중…"}
          </span>
          {voiceList.length > 0 && (
            <label className="t-caption flex flex-wrap items-center gap-1">
              <span className="shrink-0">음성</span>
              <select
                value={selectedURI}
                onChange={(e) => {
                  const uri = e.target.value;
                  setSelectedURI(uri);
                  setSelectedVoice(lang, uri || null); // ""→자동
                }}
                className="t-caption min-h-[var(--tap-min)] max-w-full rounded-[var(--radius-box)] border border-line bg-bg px-2 text-ink"
              >
                <option value="">자동(추천)</option>
                {voiceList.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.quality})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="t-caption text-ink-3">
            더 자연스러운 음성 받기 — iOS: 설정 → 손쉬운 사용 → 음성 콘텐츠 → 음성 → {langLabel} → 고품질 다운로드 ·
            Android: 설정 → 접근성/언어 → 텍스트 음성 변환 → 엔진·음성 데이터
          </p>
        </div>
      ) : (
        <span className="t-caption text-ink-3">클라우드 음성이라 기기 음성 선택은 필요 없어요.</span>
      )}
    </div>
  );
}

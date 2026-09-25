"use client";

/**
 * 발음 엔진 선택 + 기기 음성 고르기/진단 (SPEC §16) — 언어별.
 *
 * - **엔진 토글**(클라우드/기기): 영어는 클라우드가 자연스럽고 일본어는 기기(Kyoko)가 나을 수 있어 언어별로 고른다.
 * - **기기 음성(device일 때만)**: 지금 쓰는 음성과 품질을 보여주고(진단), 직접 고르게 하고, 고품질 받는 법을 안내한다.
 *   브라우저가 기본으로 저품질(compact)을 고르는 문제를 해결한다 — lib/speech.ts가 품질 순으로 자동 선택하되
 *   사용자가 덮어쓸 수 있다. 클라우드 언어엔 이 UI가 의미 없어 감춘다.
 *
 * - **폰 진단 캡션**(§16-5): 그 언어의 마지막 클라우드 재생 결과를 한 줄로 — 서버 로그를 볼 수 없는 폰에서
 *   "클라우드가 왜 안 나는지"(키 없음 501·합성 500·대기 상한·iOS 재생 차단 NotAllowedError…)와 기기 음성 대체 여부를 본다.
 *
 * 값은 lib/speech.ts 전역(언어별 localStorage 영속)을 읽고 쓴다. 화면은 판단하지 않는다(순위·해석은 speech.ts).
 *
 * ⚠️ hydration: 음성 목록·저장값·진단은 **마운트 후** useEffect에서만 읽는다(렌더 중 getVoices/localStorage 금지).
 * voiceschanged로 목록이 늦게 채워지면 TTS_VOICES_EVENT로, 재생 결과가 바뀌면 TTS_DIAG_EVENT로 다시 그린다.
 */

import { useEffect, useState } from "react";
import {
  getCurrentVoiceInfo,
  getSelectedVoiceURI,
  getTtsEngine,
  getTtsPlaybackDiag,
  listVoicesForLang,
  setSelectedVoice,
  setTtsEngine,
  speak,
  TTS_DIAG_EVENT,
  TTS_ENGINE_EVENT,
  TTS_VOICES_EVENT,
  type TtsEngine,
  type TtsPlaybackDiag,
  type TtsPlaybackStage,
  type VoiceOption,
} from "@/lib/speech";
import { formatKst } from "@/lib/kst";
import { isTtsLang } from "@/lib/tts-shared";

const SAMPLE: Record<string, string> = {
  "en-US": "The quick brown fox jumps over the lazy dog.",
  "ja-JP": "こんにちは。今日はいい天気ですね。",
  // 해설 낭독(§18) — 일본어 인용이 섞인 문장이라 "일본어는 일본어로" 혼합 낭독 지시가 먹는지 들어 볼 수 있다.
  "ko-KR": "안녕하세요. 오늘은 「は」와 「が」의 차이를 알아볼게요.",
};
/** 언어 라벨 — 삼항(ja ? 일본어 : 영어)이면 새 언어(ko-KR)가 "영어"로 뜬다(§18-3). */
const LANG_LABEL: Record<string, string> = { "en-US": "영어", "ja-JP": "일본어", "ko-KR": "한국어" };
const ENGINE_LABEL: Record<TtsEngine, string> = { cloud: "클라우드", device: "기기" };
const STAGE_LABEL: Record<TtsPlaybackStage, string> = { cache: "캐시", synth: "합성", play: "재생" };

/** 진단 캡션 한 줄. 예: "마지막 재생: 클라우드 ✓ · 14:40" / "마지막 재생: 클라우드 실패(재생 NotAllowedError) → 기기 음성 · 14:40" */
function diagCaption(d: TtsPlaybackDiag): string {
  const hhmm = formatKst(d.at).slice(-5); // KST HH:MM(lib/kst 단일 정의)
  if (d.ok) return `마지막 재생: 클라우드 ✓ · ${hhmm}`;
  const why = [d.stage ? STAGE_LABEL[d.stage] : null, d.reason].filter(Boolean).join(" ");
  const then = d.fallback === "device" ? " → 기기 음성" : d.fallback === "none" ? " → 소리 없음" : "";
  return `마지막 재생: 클라우드 실패(${why || "알 수 없음"})${then} · ${hhmm}`;
}

const btn = (active: boolean) =>
  `t-caption min-h-[var(--tap-min)] rounded-[var(--radius-box)] border px-3 ${
    active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-bg text-ink"
  }`;

export default function TtsEngineControl({ lang }: { lang: string }) {
  const [engine, setEngine] = useState<TtsEngine>("device");
  const [voiceInfo, setVoiceInfo] = useState<VoiceOption | null>(null);
  const [voiceList, setVoiceList] = useState<VoiceOption[]>([]);
  const [selectedURI, setSelectedURI] = useState<string>(""); // ""=자동(추천)
  const [diag, setDiag] = useState<TtsPlaybackDiag | null>(null); // 마운트 후에만 채운다(SSR·첫 렌더는 캡션 없음)

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
    // 폰 진단: 이 언어(베이스)의 마지막 클라우드 재생 결과. 다른 언어 기록은 speech.ts가 따로 둔다.
    setDiag(getTtsPlaybackDiag(lang));
    const onDiag = () => setDiag(getTtsPlaybackDiag(lang));
    window.addEventListener(TTS_ENGINE_EVENT, onEngine);
    window.addEventListener(TTS_VOICES_EVENT, onVoices);
    window.addEventListener(TTS_DIAG_EVENT, onDiag);
    return () => {
      window.removeEventListener(TTS_ENGINE_EVENT, onEngine);
      window.removeEventListener(TTS_VOICES_EVENT, onVoices);
      window.removeEventListener(TTS_DIAG_EVENT, onDiag);
    };
  }, [lang]);

  if (!isTtsLang(lang)) return null; // 클라우드 대상(TTS_LANGS: en·ja·ko)만

  const langLabel = LANG_LABEL[lang] ?? lang;

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

      {/* 폰 진단(§16-5) — 마지막 클라우드 재생 결과 한 줄. 기록이 없으면(아직 클라우드로 안 들음) 그리지 않는다.
          자르지 않는다(truncate 금지): 카드 모드 머리처럼 좁은 칸에서 실패 이유·"→ 기기 음성"이 잘리면 진단의 뜻이 없다 — 좁으면 줄바꿈. */}
      {diag && (
        <span className="t-caption block max-w-full break-words text-ink-3" data-tts-diag={diag.ok ? "ok" : "fail"}>
          {diagCaption(diag)}
        </span>
      )}

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

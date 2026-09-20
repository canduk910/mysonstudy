/**
 * lib/speech.ts — 발음 재생(영어·일본어)의 **단일 관문**
 *
 * 왜 별도 모듈인가: `rate`·`lang` 같은 다이얼이 화면마다 복사되면 반드시 갈린다.
 * 카드 화면에서 0.9로 읽던 단어가 단어장에서는 1.0으로 읽히면, 같은 단어인데 다른
 * 목소리처럼 들린다 — 아이 입장에서는 앱이 두 개인 셈이다. 그래서 함수도 상수도
 * 여기 한 곳에만 둔다.
 *
 * 발음 소스(SPEC §16): **① 클라우드 TTS(`/api/tts`, 자연스러운 발음) → 실패하면 ② 기기 음성
 * (`speechSynthesis`)** 로 조용히 폴백한다. `speak(text, lang)`·`speakSequence(words, lang)`의
 * **시그니처는 그대로** — 6개 영어 화면과 일본어 화면은 한 줄도 안 바뀐다(§16-4). 클라우드 실패·키 없음·
 * 상한 초과는 에러를 띄우지 않고 기기 음성으로 이어 간다(§16-2, "앱이 조용해지면 안 된다").
 *
 * ⚠️ 이 파일은 **클라이언트 번들에 들어간다.** 그래서 서버 전용 `lib/tts.ts`(openai 클라이언트)를
 * import하지 않는다 — 공유 상수는 런타임 의존성 0인 `lib/tts-shared.ts`에서만 가져온다(번들 유입 방지).
 */

import { isTtsLang, TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { setTtsFingerprintProvider, ttsCacheGet, ttsCachePut } from "./tts-cache";

// 영속 캐시(IndexedDB)가 옛 목소리를 내지 않도록, 현재 voice|model을 **지문**으로 공급한다.
// GET /api/tts는 env만 읽어(OpenAI 안 부름·키 불필요) 지문을 준다. 여기선 공급자만 꽂고, 실제 호출은 캐시가 지연 실행.
if (typeof window !== "undefined") {
  setTtsFingerprintProvider(async () => {
    try {
      const res = await fetch("/api/tts", { method: "GET" });
      if (!res.ok) return null;
      const cfg = (await res.json()) as { voice?: string; model?: string; instructions?: number };
      // 지시 버전까지 지문에 넣는다 — 낭독 지시(언어·억양)가 바뀌면 옛 오디오를 비워야 한다.
      // 안 그러면 중국어로 합성돼 캐시된 단어가 계속 중국어로 들린다(실사용에서 발견).
      return cfg.voice && cfg.model ? `${cfg.voice}|${cfg.model}|i${cfg.instructions ?? 0}` : null;
    } catch {
      return null;
    }
  });
}

/** 발음 언어 **기본값** — 영어 원서용이라 미국식. `speak(text, lang)`으로 화면이 다른 언어를 넘길 수 있다
 *  (일본어=`ja-JP`, J1에서 사용). 인자를 생략하면 이 값이라 기존 영어 화면은 동작이 100% 그대로다. */
export const TTS_LANG = "en-US";

/** 재생 속도 **기본값** — 1.0은 아이가 따라 하기에 빠르다. 0.9가 카드 화면에서 쓰던 값이다.
 *  이제 사용자가 "읽기 속도"로 바꿀 수 있고, 지금 값은 getTtsRate()가 돌려준다. */
export const TTS_RATE = 0.9;

/** 읽기 속도 프리셋 — 분절 버튼(TtsSpeedControl)에서 쓴다. 아이+폰 맥락이라 3단이면 충분(슬라이더 대신). */
export const TTS_RATE_PRESETS: { labelKo: string; rate: number }[] = [
  { labelKo: "천천히", rate: 0.7 },
  { labelKo: "보통", rate: 0.9 },
  { labelKo: "빠르게", rate: 1.1 },
];

/** localStorage 키 — 읽기 속도는 화면을 넘어 하나로 기억된다(위 "값 하나" 원칙). */
const TTS_RATE_KEY = "eunwoo-tts-rate";
/** 같은 페이지의 여러 속도 컨트롤을 즉시 동기화하는 커스텀 이벤트 이름. */
export const TTS_RATE_EVENT = "eunwoo:tts-rate";

/** 현재 전역 재생 속도. 기본은 TTS_RATE(0.9). 클라이언트에서 한 번 localStorage 값을 끌어온다. */
let currentRate = TTS_RATE;
let rateHydrated = false;

/**
 * 지금 쓸 재생 속도. 클라이언트 첫 호출 때 저장된 값을 끌어온다.
 * SSR(window 없음)에서는 기본값을 돌려준다 — 렌더가 아니라 **재생 시점**에만 부르므로 안전하다.
 */
export function getTtsRate(): number {
  if (!rateHydrated && typeof window !== "undefined") {
    rateHydrated = true;
    try {
      const saved = window.localStorage.getItem(TTS_RATE_KEY);
      const n = saved != null ? Number(saved) : NaN;
      if (Number.isFinite(n) && n > 0) currentRate = n;
    } catch {
      /* 프라이빗 모드 등 localStorage 접근 불가 — 기본값 유지 */
    }
  }
  return currentRate;
}

/**
 * 전역 재생 속도를 바꾼다. localStorage에 저장하고, 같은 페이지의 다른 속도 컨트롤이
 * 즉시 따라오도록 커스텀 이벤트를 쏜다. 다음 speak()부터 이 값으로 읽는다.
 */
export function setTtsRate(rate: number): void {
  currentRate = rate;
  rateHydrated = true;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TTS_RATE_KEY, String(rate));
  } catch {
    /* 저장 실패는 비치명 — 이번 세션 동안은 currentRate로 동작 */
  }
  window.dispatchEvent(new CustomEvent(TTS_RATE_EVENT, { detail: rate }));
}

// ───────────────────────── 발음 엔진 (언어별 cloud/device 선택) ─────────────────────────
//
// 사용자 실청취 피드백(§16): 영어는 클라우드가 자연스럽고, 일본어는 기기 음성(Kyoko)이 피치 액센트가 살아
// 더 낫다. 그래서 **언어별로** 엔진을 고른다 — 추측하지 않고 사용자가 고르게 한다.

export type TtsEngine = "cloud" | "device";
/** 언어별 엔진이 바뀌면 같은 페이지의 설정 UI가 즉시 따라오도록 쏘는 이벤트. detail: {lang, engine} */
export const TTS_ENGINE_EVENT = "eunwoo:tts-engine";
/** localStorage 키 접두어 — 언어 베이스별(예: `tts-engine-en`·`tts-engine-ja`). */
const TTS_ENGINE_KEY_PREFIX = "tts-engine-";
/** 기본 엔진(청취 근거): 영어=클라우드, 일본어=기기(Kyoko). 그 밖 언어는 기기. */
const DEFAULT_ENGINE: Record<string, TtsEngine> = { en: "cloud", ja: "device" };

/** "en-US" → "en". 엔진 설정·기본값은 언어 베이스 단위(지역 변형과 무관). */
function langBase(lang: string): string {
  return lang.split("-")[0];
}

/** 언어 베이스 → 엔진(세션 캐시, localStorage 하이드레이트). getTtsRate와 같은 규약(재생 시점에만 부른다). */
const engineCache = new Map<string, TtsEngine>();

/** 이 언어에 쓸 엔진. 저장값 없으면 언어별 기본값. */
export function getTtsEngine(lang: string): TtsEngine {
  const base = langBase(lang);
  const cached = engineCache.get(base);
  if (cached) return cached;
  let engine: TtsEngine = DEFAULT_ENGINE[base] ?? "device";
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(TTS_ENGINE_KEY_PREFIX + base);
      if (saved === "cloud" || saved === "device") engine = saved;
    } catch {
      /* 프라이빗 모드 등 — 기본값 유지 */
    }
    engineCache.set(base, engine); // 클라이언트에서만 캐시(SSR은 매번 기본값)
  }
  return engine;
}

/** 이 언어의 엔진을 바꾼다. localStorage 영속 + 같은 페이지의 설정 UI가 따라오도록 이벤트를 쏜다. */
export function setTtsEngine(lang: string, engine: TtsEngine): void {
  const base = langBase(lang);
  engineCache.set(base, engine);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TTS_ENGINE_KEY_PREFIX + base, engine);
  } catch {
    /* 저장 실패는 비치명 — 이번 세션은 engineCache로 동작 */
  }
  window.dispatchEvent(new CustomEvent(TTS_ENGINE_EVENT, { detail: { lang, engine } }));
  // device로 바꾸면 그 언어로 진행 중이던 프리페치를 즉시 중단한다(클라우드 호출 0 보장).
  if (engine === "device") stopPrefetchForLang(lang);
}

/**
 * 클라우드 속도 프리셋 — `TTS_RATE_PRESETS`와 **같은 순서**(천천히·보통·빠르게). 기기 음성과 기준이 달라
 * 따로 둔다: OpenAI는 1.0 자체가 또박또박이라 기기용 0.9를 그대로 쓰면 늘어진다(사용자 피드백, §16).
 * **클라우드 속도는 여기 한 곳만 고치면 바뀐다.** 값은 사용자가 샘플을 들으며 조정 중.
 */
const TTS_CLOUD_SPEEDS = [0.85, 1.0, 1.15];

/** 지금 속도 프리셋에 대응하는 클라우드 speed. 프리셋과 안 맞으면 보통(1.0). */
function cloudSpeed(): number {
  const idx = TTS_RATE_PRESETS.findIndex((p) => Math.abs(p.rate - getTtsRate()) < 0.001);
  return TTS_CLOUD_SPEEDS[idx] ?? 1.0;
}

// ───────────────────────── 기기 음성 품질 선택 (device 엔진) ─────────────────────────
//
// 문제(§16): 지금까지 utterance.lang만 정하고 voice를 안 정해 브라우저가 기본(대개 compact 저품질)을 골랐다.
// 기기에 더 좋은 음성이 있어도 안 쓰였다. 그래서 그 언어 음성을 **품질 순으로 정렬해 가장 좋은 것**을 지정한다.
// 순위 규칙은 여기 한 곳에만 둔다(화면이 제 판단을 하지 않게).

/** 이벤트 — voiceschanged로 음성 목록이 채워지거나 사용자가 음성을 고르면 설정 UI가 다시 그리도록 쏜다. */
export const TTS_VOICES_EVENT = "eunwoo:tts-voices";
/** 수동 선택 음성 localStorage 키 접두어(언어 베이스별): `tts-voice-en`·`tts-voice-ja`. 값은 voiceURI. */
const TTS_VOICE_KEY_PREFIX = "tts-voice-";

/** 순위·표시에 필요한 최소 음성 형태(SpeechSynthesisVoice가 이를 만족). 순수 함수 테스트용으로 분리. */
export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService?: boolean;
}

/** 효과음·참신성 음성(en-US에 잔뜩) — 후보에서 제외. Apple eloquence(URI)·클래식 노벨티(이름). */
const NOVELTY_VOICE_NAMES = new Set(
  [
    "bad news", "good news", "bells", "bubbles", "boing", "trinoids", "whisper", "wobble",
    "zarvox", "jester", "organ", "pipe organ", "cellos", "superstar", "bahh", "deranged", "hysterical",
  ].map((n) => n.toLowerCase()),
);

function isNoveltyVoice(v: VoiceLike): boolean {
  const uri = (v.voiceURI ?? "").toLowerCase();
  if (uri.includes("eloquence")) return true; // com.apple.eloquence.* (Eddy·Flo·Grandma…)
  return NOVELTY_VOICE_NAMES.has((v.name ?? "").trim().toLowerCase());
}

/** voiceURI·name에서 품질 토큰을 뽑는다(대소문자 무시). 없으면 null. */
function voiceTokenTier(v: VoiceLike): "premium" | "enhanced" | "network" | "compact" | "local" | null {
  const s = `${v.voiceURI ?? ""} ${v.name ?? ""}`.toLowerCase();
  if (s.includes("premium")) return "premium"; // Apple 최상
  if (s.includes("enhanced")) return "enhanced"; // Apple 고품질
  if (s.includes("network")) return "network"; // Google/Android 서버 합성
  if (s.includes("compact")) return "compact"; // Apple 저품질
  if (s.includes("local")) return "local"; // Android 온디바이스
  return null;
}

const VOICE_TIER_SCORE: Record<string, number> = { premium: 100, enhanced: 90, network: 80, local: 40, compact: 20 };

/** 품질 점수(높을수록 좋음). 토큰 없으면 서버합성(localService=false)을 약간 우대. */
function voiceScore(v: VoiceLike): number {
  const tier = voiceTokenTier(v);
  if (tier) return VOICE_TIER_SCORE[tier];
  return v.localService === false ? 55 : 50;
}

/** 화면 표시용 품질 라벨(예: "enhanced"·"compact"·"기본"). */
export function voiceQualityLabel(v: VoiceLike): string {
  return voiceTokenTier(v) ?? "기본";
}

/**
 * 그 언어 음성만 골라 **품질 순으로 정렬**(효과음 제외). 순수 함수 — DOM 없이 테스트 가능.
 * 동점은 원래 목록 순서 유지(안정 정렬).
 */
export function rankVoicesForLang<T extends VoiceLike>(voices: readonly T[], lang: string): T[] {
  const base = langBase(lang).toLowerCase();
  return voices
    .filter((v) => (v.lang ?? "").toLowerCase().replace("_", "-").startsWith(base))
    .filter((v) => !isNoveltyVoice(v))
    .map((v, i) => ({ v, i, score: voiceScore(v) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.v);
}

// ── 음성 목록 캐시 + voiceschanged (Chrome·Android는 처음에 빈 배열을 준다) ──
let voicesCache: SpeechSynthesisVoice[] = [];
let voicesListenerAttached = false;

function ensureVoicesLoaded(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const now = window.speechSynthesis.getVoices();
  if (now && now.length > 0) voicesCache = now;
  if (!voicesListenerAttached && typeof window.speechSynthesis.addEventListener === "function") {
    voicesListenerAttached = true;
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      const v = window.speechSynthesis.getVoices();
      if (v && v.length > 0) voicesCache = v;
      try {
        window.dispatchEvent(new CustomEvent(TTS_VOICES_EVENT)); // 설정 UI가 다시 그린다
      } catch {
        /* noop */
      }
    });
  }
  return voicesCache;
}

function candidatesForLang(lang: string): SpeechSynthesisVoice[] {
  return rankVoicesForLang(ensureVoicesLoaded(), lang);
}

/** 사용자가 고른 음성 voiceURI(없으면 null=자동). */
export function getSelectedVoiceURI(lang: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TTS_VOICE_KEY_PREFIX + langBase(lang));
  } catch {
    return null;
  }
}

/** 음성을 고른다. null이면 자동(추천)으로 되돌린다. 설정 UI가 다시 그리도록 이벤트를 쏜다. */
export function setSelectedVoice(lang: string, voiceURI: string | null): void {
  if (typeof window === "undefined") return;
  const key = TTS_VOICE_KEY_PREFIX + langBase(lang);
  try {
    if (voiceURI) window.localStorage.setItem(key, voiceURI);
    else window.localStorage.removeItem?.(key);
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent(TTS_VOICES_EVENT));
  } catch {
    /* noop */
  }
}

/**
 * 이 언어에 실제로 쓸 음성. 저장된 선택이 이 기기에 있으면 그걸, 없으면(기기 교체 등) **조용히 자동(최상위)**으로.
 * 후보가 없으면 null → 브라우저 기본에 맡긴다(폴백, 에러 없음).
 */
function resolveVoice(lang: string): SpeechSynthesisVoice | null {
  const ranked = candidatesForLang(lang);
  if (ranked.length === 0) return null;
  const savedURI = getSelectedVoiceURI(lang);
  if (savedURI) {
    const match = ranked.find((v) => v.voiceURI === savedURI);
    if (match) return match;
    // 저장돼 있지만 이 기기엔 없음 → 자동으로 폴백(아래)
  }
  return ranked[0];
}

/** 설정 UI용 음성 옵션. */
export interface VoiceOption {
  voiceURI: string;
  name: string;
  quality: string;
}

/** 그 언어의 음성 목록(품질 순, 효과음 제외) — 설정 드롭다운용. */
export function listVoicesForLang(lang: string): VoiceOption[] {
  return candidatesForLang(lang).map((v) => ({ voiceURI: v.voiceURI, name: v.name, quality: voiceQualityLabel(v) }));
}

/** 지금 이 언어가 실제로 쓸 음성의 이름·품질(진단 표시 "현재: Kyoko (compact)"). 없으면 null. */
export function getCurrentVoiceInfo(lang: string): VoiceOption | null {
  const v = resolveVoice(lang);
  return v ? { voiceURI: v.voiceURI, name: v.name, quality: voiceQualityLabel(v) } : null;
}

/**
 * 이 브라우저가 **기기 음성(폴백)**을 지원하는가. 클라우드 TTS는 이것과 무관하게 `<audio>`로 재생된다.
 * SSR(window 없음)에서도 안전하게 false를 돌려준다.
 *
 * ⚠️ **렌더 중에 직접 호출하지 마라.** 서버는 false, 클라이언트는 true를 돌려주므로
 * `{isSpeechSupported() && <button/>}` 같은 조건부 렌더는 hydration mismatch를 낸다
 * (이 모듈을 만들며 실측 확인). 버튼을 감추려면 `useEffect`로 마운트 후 state에
 * 담아 쓸 것. 카드 화면처럼 onClick에서만 부르는 경우는 무관하다 —
 * `speak()`가 내부에서 이 가드를 통과시키므로 버튼을 항상 그려도 안전하다.
 */
export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// ───────────────────────── 클라우드 TTS 재생 (내부) ─────────────────────────

/** 합성 오디오 캐시 — `${lang}:${speed}:${text}` → Blob(세션 내). 연타·재청취에 재합성하지 않는다(§16-1). */
const cloudCache = new Map<string, Blob>();
/** 캐시 상한(항목 수). 넘으면 가장 오래된 것부터 버린다 — Blob은 GC 대상(objectURL을 담지 않으므로 revoke 불필요). */
const CLOUD_CACHE_MAX = 200;

/** 현재 재생 중인 오디오와 그 objectURL(취소·정지·수명관리용). */
let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
/** 현재 재생을 "정상 정지"로 끝내는 콜백(취소 시 대기 중 Promise를 매달지 않고 풀어 준다). */
let currentPlayStop: (() => void) | null = null;
/**
 * 재생 세대 토큰. speak()/취소 때마다 증가한다. 비동기(합성·재생) 도중 새 speak가 오면 옛 작업은
 * 자기 토큰이 낡은 걸 보고 스스로 물러난다 — 오디오 겹침·엉뚱한 폴백을 막는다(§16-3 연타 방지).
 */
let playToken = 0;

/** 재생 중인 클라우드 오디오를 멈추고 objectURL을 회수한다(누수 금지). */
function stopCloudAudio(): void {
  const stop = currentPlayStop;
  currentPlayStop = null;
  if (stop) {
    stop(); // 대기 중 Promise를 resolve로 풀고 handler 해제·revoke까지 수행
    return;
  }
  // 재생 중인 게 없더라도 방어적으로 참조를 비운다.
  if (currentAudioUrl) {
    try {
      URL.revokeObjectURL(currentAudioUrl);
    } catch {
      /* noop */
    }
  }
  currentAudio = null;
  currentAudioUrl = null;
}

/** 클라우드·기기 재생을 모두 취소하고 세대 토큰을 올린다(연타·화면 이탈 규약). */
function cancelPlayback(): void {
  playToken++;
  stopCloudAudio();
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
  }
}

/** 이 환경·입력이 클라우드 TTS를 쓸 수 있는가. 아니면 기기 음성으로 간다(§16-2). */
function canUseCloud(lang: string, text: string): boolean {
  if (typeof window === "undefined") return false; // SSR 방어(재생은 클릭 시점이라 실제로는 안 걸린다)
  if (typeof fetch === "undefined" || typeof Audio === "undefined") return false;
  if (!isTtsLang(lang)) return false; // 화이트리스트 밖 언어 → 기기 음성
  if (text.length > TTS_TEXT_MAX_CHARS) return false; // 상한 초과 → 기기 음성(§16-1)
  return true;
}

/**
 * 캐시 확인 → 없으면 `/api/tts` 합성 후 캐시에 넣는다. 200이 아니면(501·400·500) throw → 호출부가
 * 기기 음성으로 폴백(재생)하거나 조용히 무시(프리페치). `signal`은 프리페치가 화면 이탈 시 중단하는 용도.
 */
async function getAudioBlob(text: string, lang: string, speed: number, signal?: AbortSignal): Promise<Blob> {
  const key = `${lang}:${speed}:${text}`;
  const cached = cloudCache.get(key);
  if (cached) return cached; // 1차(메모리) 히트: 네트워크 0

  // 2차(IndexedDB) 히트: 앱을 닫았다 열어도 산다 → 재합성·재요금 없음. IDB 불가면 null(조용히 통과).
  const persisted = await ttsCacheGet(key);
  if (persisted) {
    cloudCache.set(key, persisted); // 1차로 승격
    return persisted;
  }

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang, speed }),
    signal,
  });
  if (!res.ok) throw new Error(`tts ${res.status}`); // 키 없음(501)·검증 실패(400)·합성 실패(500)
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("tts empty");

  cloudCache.set(key, blob); // 1차
  if (cloudCache.size > CLOUD_CACHE_MAX) {
    const oldest = cloudCache.keys().next().value;
    if (oldest !== undefined) cloudCache.delete(oldest);
  }
  void ttsCachePut(key, blob); // 2차(best-effort, 비동기) — 실패해도 재생엔 지장 없음
  return blob;
}

/** Blob을 재생한다. objectURL은 재생마다 새로 만들고 종료·에러·취소에 반드시 회수한다(누수 금지). */
function playBlob(blob: Blob, token: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url: string;
    try {
      url = URL.createObjectURL(blob);
    } catch (e) {
      reject(e as Error);
      return;
    }
    const audio = new Audio(url);
    audio.playbackRate = 1; // 속도는 서버 speed로 이미 반영됨(이중 적용 금지)

    let settled = false;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      if (currentAudio === audio) {
        currentAudio = null;
        currentAudioUrl = null;
        currentPlayStop = null;
      }
      act();
    };

    currentAudio = audio;
    currentAudioUrl = url;
    currentPlayStop = () => {
      try {
        audio.pause();
      } catch {
        /* noop */
      }
      finish(() => resolve()); // 취소 = 정상 정지(폴백하지 않는다 — token으로 걸러진다)
    };

    audio.onended = () => finish(() => resolve());
    audio.onerror = () => finish(() => reject(new Error("audio play error")));
    void audio.play().catch((e) => finish(() => reject(e as Error)));

    // 시작하자마자 낡은 토큰이면(그새 새 speak가 옴) 바로 접는다.
    if (token !== playToken) currentPlayStop?.();
  });
}

/** 기기 음성(speechSynthesis)으로 읽는다 — 클라우드가 못 될 때의 폴백(§16-2). 에러를 띄우지 않는다. */
function fallbackDevice(text: string, lang: string, token: number): void {
  if (token !== playToken) return; // 취소로 인한 실패면 폴백도 하지 않는다
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = getTtsRate();
    const voice = resolveVoice(lang); // 고품질 음성 자동/수동 선택(§16) — 없으면 브라우저 기본
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* noop — 조용히 무음(에러 화면 금지) */
  }
}

/** 클라우드 시도 → 실패면 기기 음성. 세대 토큰으로 늦게 끝난 작업을 걸러 낸다. */
async function playViaCloud(text: string, lang: string, speed: number, token: number): Promise<void> {
  if (!canUseCloud(lang, text)) {
    fallbackDevice(text, lang, token);
    return;
  }
  try {
    const blob = await getAudioBlob(text, lang, speed);
    if (token !== playToken) return; // 합성 도중 새 재생이 왔다 → 버린다(폴백 안 함)
    await playBlob(blob, token);
    // 정상 종료·취소 모두 여기로 온다. 취소면 token이 이미 달라 아무 일도 안 한다.
  } catch {
    if (token !== playToken) return; // 취소로 인한 실패는 폴백하지 않는다
    fallbackDevice(text, lang, token); // 진짜 실패(fetch/재생) → 기기 음성
  }
}

// ───────────────────────── 프리페치 (첫 재생 지연 제거) ─────────────────────────

/**
 * 한 번에 미리 받을 **최대 개수**(비용 가드). 프리페치는 안 누를 음성까지 합성하므로 상한이 없으면
 * 비용·대역폭이 샌다. 화면에 보이는 것 위주로 이 수만큼만 채운다. 상한은 여기 한 곳에만 둔다.
 *
 * 30→90: 프리페치 대상을 단어뿐 아니라 **예문·정의**까지 넓혔다(엔트리당 최대 3배). 30단어 단어장이면
 * 단어30+예문+정의 ≈ 90 — 한 단어장의 🔊 버튼을 한 번에 덮는다. 각 항목은 **영속 캐시** 덕에 평생 1회만
 * 합성되므로(다음부터 IDB 적중) 상한을 올린 추가 비용은 첫 방문 1회로 그친다. 동시성은 2로 그대로(레이트 배려).
 */
export const PREFETCH_MAX_ITEMS = 90;
/** 프리페치 동시성 — 낮게. 서버·OpenAI 레이트·Cloud Run 동시성을 배려해 한 번에 이만큼만 나눠 보낸다. */
const PREFETCH_CONCURRENCY = 2;

/** 진행 중인 프리페치 배치의 중단기. 새 프리페치가 오거나 화면을 떠나면 abort한다. */
let prefetchAbort: AbortController | null = null;
/** 진행 중인 프리페치 배치의 언어(베이스). 엔진을 device로 바꿀 때 그 언어 배치만 끊으려고 둔다. */
let prefetchLang: string | null = null;

/**
 * 그 언어를 device로 바꾸는 순간 진행 중이던 그 언어 프리페치를 중단한다(이미 쏜 요청이 계속 돌면 낭비).
 * setTtsEngine에서 부른다(함수 선언이라 호이스팅 — 위에서 호출 가능).
 */
function stopPrefetchForLang(lang: string): void {
  if (prefetchLang !== null && prefetchLang === langBase(lang)) {
    prefetchAbort?.abort();
    prefetchAbort = null;
    prefetchLang = null;
  }
}

async function runPrefetch(targets: string[], lang: string, speed: number, signal: AbortSignal): Promise<void> {
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length && !signal.aborted) {
      const text = targets[idx++];
      try {
        await getAudioBlob(text, lang, speed, signal); // 캐시에 채우기만 한다(재생 X)
      } catch {
        /* 프리페치 실패는 조용히 무시 — 최적화일 뿐, 재생 시점에 다시 시도하거나 기기 음성으로 폴백 */
      }
    }
  };
  const n = Math.min(PREFETCH_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * 화면에 보이는 문장들을 **미리 합성해 캐시에 채운다**(재생하지 않는다). 이후 `speak()`가 캐시 히트로
 * 네트워크 없이 즉시 울린다 — 첫 재생 ~1초 지연 제거가 목적.
 *
 * 낭비 방지: 트림·빈문자 제거, 길이 상한(재생 경로와 **같은 상수** `TTS_TEXT_MAX_CHARS`), 중복 제거,
 * **이미 캐시된 것 스킵**, 개수 상한(`PREFETCH_MAX_ITEMS`), 낮은 동시성 순차 전송. 실패는 조용히 무시.
 *
 * **반환값은 중단 함수**다 — 화면 이탈 시 중단하도록 `useEffect(() => prefetchSpeech(texts, lang), [deps])`
 * 한 줄로 쓰면 cleanup에서 자동 abort된다. 새 프리페치가 오면 직전 배치도 자동 중단한다.
 */
export function prefetchSpeech(texts: string[], lang: string = TTS_LANG): () => void {
  const noop = () => {};
  if (typeof window === "undefined" || typeof fetch === "undefined") return noop;
  if (!isTtsLang(lang)) return noop; // 화이트리스트 밖 언어는 어차피 기기 음성이라 프리페치 무의미
  if (getTtsEngine(lang) !== "cloud") return noop; // device 언어는 클라우드를 안 쓰니 프리페치도 안 한다(네트워크 0)

  prefetchAbort?.abort(); // 직전 배치 중단(화면 전환 시 겹침 방지)
  const controller = new AbortController();
  prefetchAbort = controller;
  prefetchLang = langBase(lang); // 엔진을 device로 바꿀 때 이 언어 배치만 끊기 위해
  const speed = cloudSpeed(); // 재생(클라우드)과 같은 키가 되도록 클라우드 속도로 받는다

  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of texts) {
    const text = (raw ?? "").trim();
    if (!text || text.length > TTS_TEXT_MAX_CHARS) continue;
    const key = `${lang}:${speed}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cloudCache.has(key)) continue; // 이미 있으면 건너뛴다(네트워크 0)
    targets.push(text);
    if (targets.length >= PREFETCH_MAX_ITEMS) break; // 개수 상한(비용 가드)
  }
  if (targets.length === 0) return () => controller.abort();

  void runPrefetch(targets, lang, speed, controller.signal);
  return () => controller.abort();
}

// ───────────────────────── 공개 API (시그니처 불변) ─────────────────────────

/**
 * 한 덩어리의 텍스트를 읽는다.
 * 이전 재생을 취소하고 새로 시작한다 — 아이가 🔊를 연타해도 말이 겹치지 않는다.
 * 이 언어의 엔진(getTtsEngine)이 cloud면 클라우드 합성(~1초) 후 재생하고 실패 시 기기 음성으로 폴백,
 * device면 곧장 기기 음성으로 읽는다. 어느 쪽도 에러를 던지지 않는다(§16-2).
 *
 * `lang`은 발음 언어(BCP-47). **생략하면 `TTS_LANG`(en-US)** — 기존 영어 호출부는 인자 없이 부르므로
 * 동작이 그대로다(회귀 0). 일본어 화면은 `speak(surface, "ja-JP")`로 넘긴다. 속도(getTtsRate)·cancel
 * 규약은 언어·소스(클라우드/기기)와 무관하게 동일하다.
 */
export function speak(text: string, lang: string = TTS_LANG): void {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  cancelPlayback(); // 이전 것(클라우드·기기) 취소 + 토큰 증가
  const token = playToken; // 방금 올린 최신 세대
  // 이 언어의 엔진이 device면 클라우드를 아예 시도하지 않고 기기 음성으로 직행한다(불필요한 네트워크·지연 없음).
  if (getTtsEngine(lang) !== "cloud") {
    fallbackDevice(trimmed, lang, token);
    return;
  }
  void playViaCloud(trimmed, lang, cloudSpeed(), token); // 클라우드는 별도 속도 매핑
}

/**
 * 단어 여러 개를 **한 문장처럼** 이어 읽는다.
 *
 * ⚠️ utterance를 쪼개지 마라. `["fix","the","door"]`는 재생 3개가 아니라
 * `speak("fix the door")` **1개**다. 단어 경계마다 끊으면 로봇처럼 들린다 —
 * 공백으로 이어 붙여야 연음이 살아 "문장"으로 들린다.
 * 아이가 따라 말하는 대상은 단어의 나열이 아니라 문장이다.
 */
export function speakSequence(words: string[], lang: string = TTS_LANG): void {
  const sentence = words.join(" ").trim();
  if (!sentence) return;
  speak(sentence, lang);
}

/** 재생 중인 발음을 멈춘다 (화면 이탈·다음 문제로 넘어갈 때). 클라우드·기기 재생 모두 멈춘다. */
export function stopSpeaking(): void {
  cancelPlayback();
}

/** 테스트 전용 — 1차(메모리) 캐시를 비운다(새 세션 모사: 2차 IDB가 살아나는지 검증). */
export function __clearTtsMemoryCache(): void {
  cloudCache.clear();
}

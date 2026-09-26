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

import { audioMediaType, isTtsLang, TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { setTtsFingerprintProvider, ttsCacheDelete, ttsCacheGet, ttsCachePut } from "./tts-cache";

/**
 * 지문 공급자(GET /api/tts) 대기 상한. 망이 매달리면 initPromise를 함께 쓰는 **모든** 캐시 조회가 같이 매달려
 * 이미 IDB에 있는 오디오도 못 쓴다(§18-2, 출퇴근 망). 넘으면 throw(일시 실패) — 캐시가 이번 조회만 메모리로 처리하고
 * 다음 조회 때 다시 묻는다(최대 3회, lib/tts-cache.ts). 테스트는 `__setQueueTiming({ fingerprintMs })`로 줄인다.
 */
const FINGERPRINT_TIMEOUT_MS = 3000;

/**
 * 속도 변경 뒤 프리페치 재실행까지 기다리는 시간(trailing 디바운스, §16-5). 속도 버튼을 연달아 눌러도 마지막 조작 뒤
 * 한 번만 새 속도로 다시 받는다. 짧으면 연타마다 배치가 새로 돌고, 길면 속도를 바꾼 직후의 🔊가 합성을 기다린다
 * (그 🔊 자신은 디바운스와 무관하게 새 속도로 바로 합성한다). 테스트는 `__setQueueTiming({ rateDebounceMs })`로 줄인다.
 */
const RATE_PREFETCH_DEBOUNCE_MS = 600;

/**
 * 영속 캐시(IndexedDB)가 옛 목소리를 내지 않도록, 현재 voice|model을 **지문**으로 공급한다.
 * GET /api/tts는 env만 읽어(OpenAI 안 부름·키 불필요) 지문을 준다.
 * 반환 계약(setTtsFingerprintProvider): 지문 / **null = 서버가 명시적으로 없음**(200 아님·voice|model 없음 → 세션 내내 메모리만) /
 * **throw = 일시 실패**(타임아웃·네트워크·응답 도중 끊김 → 다음 조회에서 다시).
 */
async function fetchTtsFingerprint(): Promise<string | null> {
  // AbortSignal.timeout/any 대신 수동 결합(구형 iOS Safari 호환).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), queueTiming.fingerprintMs);
  try {
    const res = await fetch("/api/tts", { method: "GET", signal: ac.signal });
    if (!res.ok) return null;
    const cfg = (await res.json()) as { voice?: string; model?: string; instructions?: number };
    // 지시 버전까지 지문에 넣는다 — 낭독 지시(언어·억양)가 바뀌면 옛 오디오를 비워야 한다.
    // 안 그러면 중국어로 합성돼 캐시된 단어가 계속 중국어로 들린다(실사용에서 발견).
    return cfg.voice && cfg.model ? `${cfg.voice}|${cfg.model}|i${cfg.instructions ?? 0}` : null;
  } finally {
    clearTimeout(timer);
  }
}

// 여기선 공급자만 꽂고, 실제 호출은 캐시가 지연 실행(첫 조회 때).
if (typeof window !== "undefined") setTtsFingerprintProvider(fetchTtsFingerprint);

/** 테스트 전용 — 지문 공급자 그 자체(eval이 window 스텁 전에 이 모듈을 불러 공급자가 안 꽂히므로 직접 꽂는다). */
export const __fetchTtsFingerprint = fetchTtsFingerprint;

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
  // 클라우드 캐시 키에 속도가 들어가므로(`${lang}:${speed}:${text}`) 속도를 바꾸면 미리 받아 둔 소리가 전부 빗나간다 —
  // 마지막 프리페치를 새 속도로 다시 돌린다(§16-5). 안 그러면 🔊마다 합성을 기다려 iOS가 재생을 막을 여지가 커진다.
  // 단 **마지막 조작 뒤 한 번만**(trailing 디바운스) — 속도를 연타하면 누를 때마다 배치를 새로 쏘고 곧바로 버려
  // 상류 합성이 쌓였다(2026-09-25 QA: 5회 연타에 합성 8건이 전부 버려짐).
  scheduleRatePrefetchRerun();
}

/** 속도 변경 → 프리페치 재실행 디바운스 타이머(마지막 조작 뒤 `rateDebounceMs`). */
let ratePrefetchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 속도를 바꿨을 때: 옛 속도로 돌던 마지막 프리페치 배치는 **지금** 멈추고(새 속도가 정해지는 동안 버려질 합성을 더 쌓지
 * 않는다 — 끊긴 요청은 서버도 상류 합성을 멈춘다), 새 속도 배치는 마지막 조작 `rateDebounceMs` 뒤 한 번만 돈다.
 * 같은 속도 재탭은 아무것도 끊지 않는다. 엔진 cloud 전환(setTtsEngine)은 디바운스 없이 즉시다.
 */
function scheduleRatePrefetchRerun(): void {
  const req = lastPrefetch;
  if (req && !req.stopped && req.controller && !req.controller.signal.aborted && req.speed !== cloudSpeed()) {
    req.controller.abort();
  }
  if (ratePrefetchTimer !== null) clearTimeout(ratePrefetchTimer);
  ratePrefetchTimer = setTimeout(() => {
    ratePrefetchTimer = null;
    rerunLastPrefetch(); // 그새 화면을 떠났거나(stopped) device로 바꿨거나 같은 설정이면 여기서 걸러진다
  }, queueTiming.rateDebounceMs);
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
/**
 * 기본 엔진(청취 근거): 영어=클라우드, 일본어=기기(Kyoko), 한국어=클라우드. 그 밖 언어는 기기.
 * 한국어가 클라우드인 이유(§18-3): 기기 한국어 음성은 해설 속 일본어 인용(「は」)을 한국어식으로 읽거나 건너뛴다.
 * 그래서 해설 듣기의 기본 조합은 "한국어 해설자(클라우드) + 일본어 원어민(기기)"이다.
 */
const DEFAULT_ENGINE: Record<string, TtsEngine> = { en: "cloud", ja: "device", ko: "cloud" };

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
  // cloud로 바꾸면 화면을 다시 열지 않아도 그 언어의 마지막 프리페치를 지금 돌린다(§16-5 — device 기본인 일본어가
  // 화면을 연 뒤 cloud로 바꾸면 캐시가 비어 첫 🔊마다 합성을 기다리던 공백).
  if (engine === "device") stopPrefetchForLang(lang);
  else rerunLastPrefetch(lang);
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

/**
 * 합성 오디오 캐시 — `${lang}:${speed}:${text}` → Blob(세션 내). 연타·재청취에 재합성하지 않는다(§16-1).
 * 여기 드는 것은 **메모리 Blob뿐**이다(네트워크 바이트나 IndexedDB 바이트로 새로 만든 것 — IDB 레코드를 가리키는 Blob 금지,
 * lib/tts-cache.ts 헤더의 2026-09-27 규칙). 그래도 재생이 미디어 소스 오류로 실패하면 그 키를 빼고 한 번 새로 받는다(자가 치유).
 */
const cloudCache = new Map<string, Blob>();
/** 캐시 상한(항목 수). 넘으면 가장 오래된 것부터 버린다 — Blob은 GC 대상(objectURL을 담지 않으므로 revoke 불필요). */
const CLOUD_CACHE_MAX = 200;

/** 1차 캐시에 넣는다(상한 초과분은 가장 오래된 것부터 버린다). 네트워크·IndexedDB 적중이 같이 쓴다. */
function rememberInMemory(key: string, blob: Blob): void {
  cloudCache.delete(key); // 다시 넣으면 가장 최근으로
  cloudCache.set(key, blob);
  while (cloudCache.size > CLOUD_CACHE_MAX) {
    const oldest = cloudCache.keys().next().value;
    if (oldest === undefined) break;
    cloudCache.delete(oldest);
  }
}

/** 이 키의 오디오를 두 캐시(메모리·IndexedDB)에서 뺀다 — 재생할 수 없는 오디오를 다시 내주지 않게(자가 치유). */
function forgetCachedAudio(key: string): void {
  cloudCache.delete(key);
  void ttsCacheDelete(key);
}

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

/**
 * 활성 큐(speakQueue)를 **동기로** 끝내는 함수(§18-2 정지·종료 계약). cancelPlayback()이 토큰을 올린 직후 부른다 —
 * 그래서 다른 🔊·stopSpeaking()·새 speakQueue()가 오면 옛 큐의 onEnd("stopped")는 그 호출이 반환되기 전에,
 * 새 큐의 onItem(0)보다 먼저 온다(비동기로 늦게 오면 화면이 "정지"로 돌아가는데 새 큐 소리는 계속 나는 사고).
 */
let activeQueueEnd: (() => void) | null = null;

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

/** 클라우드·기기 재생을 모두 취소하고 세대 토큰을 올린다(연타·화면 이탈 규약). 활성 큐는 동기로 "stopped". */
function cancelPlayback(): void {
  playToken++;
  const endQueue = activeQueueEnd;
  activeQueueEnd = null;
  stopCloudAudio(); // 큐의 기기 대기(speakDeviceAwait)도 currentPlayStop으로 여기서 즉시 풀린다
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    unlockUtterance = null; // cancel()이 잠금 해제 발화도 지운다
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
  }
  endQueue?.(); // 반환 전에 동기로 — 옛 큐 onEnd("stopped")
}

// ───────────────────────── 폰 진단 — 마지막 클라우드 재생 결과 (§16-5) ─────────────────────────
//
// 서버 로그를 볼 수 없는 폰에서 "클라우드가 왜 안 나는지"를 소리 설정 옆 캡션 한 줄(TtsEngineControl)로 보여 준다.
// 언어 베이스별 **마지막 1건**만 메모리에 둔다(세션 한정·본문 텍스트 없음). 단발(speak)과 큐(speakQueue) 조각이 같이 쓴다.

/** 실패 단계 — cache: 캐시 조회(지문 GET·IndexedDB), synth: `/api/tts` 합성, play: 오디오 재생. */
export type TtsPlaybackStage = "cache" | "synth" | "play";

/** 마지막 클라우드 재생 결과. 성공이면 stage·reason·fallback이 null. */
export interface TtsPlaybackDiag {
  /** 기록 시각(ISO) */
  at: string;
  /** 재생 언어(BCP-47) */
  lang: string;
  /** 클라우드 오디오가 실제로 재생을 시작했는가 */
  ok: boolean;
  stage: TtsPlaybackStage | null;
  /** 실패 이유 — `tts 501`(키 없음)·`tts 500`·`timeout`(합성 대기 상한)·`network`·`NotAllowedError`(iOS 재생 차단) 등 */
  reason: string | null;
  /** 실패 뒤 기기 음성으로 대체했는가("none" = 기기 음성도 못 냄) */
  fallback: "device" | "none" | null;
  /**
   * 캐시(메모리·IndexedDB)에서 온 오디오가 재생 단계에서 미디어 소스 오류로 실패해 **그 키를 캐시에서 빼고 한 번 새로 받았는가**
   * (§16-5 자가 치유, 2026-09-27). 성공이면 새로 받은 오디오로 났다는 뜻, 실패면 새로 받은 뒤에도 실패했다는 뜻이다(stage·reason은 그 재시도의 것).
   */
  healed: boolean;
}

/** 진단이 바뀌면 쏘는 이벤트. detail: TtsPlaybackDiag */
export const TTS_DIAG_EVENT = "eunwoo:tts-diag";

const playbackDiag = new Map<string, TtsPlaybackDiag>();

/** 이 언어의 마지막 클라우드 재생 결과(없으면 null). 렌더 중이 아니라 **마운트 후**에 읽는다(hydration). */
export function getTtsPlaybackDiag(lang: string): TtsPlaybackDiag | null {
  return playbackDiag.get(langBase(lang)) ?? null;
}

const DIAG_OK = { ok: true, stage: null, reason: null, fallback: null, healed: false } as const;
/** 자가 치유(캐시 오디오 손상 → 새로 받음) 뒤 클라우드로 났다. */
const DIAG_HEALED = { ...DIAG_OK, healed: true } as const;

function noteCloudResult(lang: string, r: Omit<TtsPlaybackDiag, "at" | "lang">): void {
  const d: TtsPlaybackDiag = { at: new Date().toISOString(), lang, ...r };
  playbackDiag.set(langBase(lang), d);
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(TTS_DIAG_EVENT, { detail: d }));
  } catch {
    /* 진단은 best-effort */
  }
}

/**
 * 실패 이유를 캡션용 짧은 문자열로. 합성 HTTP 실패는 `tts {status}`, 200인데 오디오가 아니면 `tts type`, 빈 본문은 `tts empty`,
 * 대기 상한은 `timeout`, 재생 거부는 DOMException 이름.
 */
function failureReason(e: unknown): string {
  if (e === WAIT_TIMEOUT) return "timeout";
  const msg = e instanceof Error ? e.message : "";
  if (/^tts (\d{3}|empty|type)$/.test(msg)) return msg;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TypeError") return "network"; // fetch 네트워크 실패(Safari "Load failed"·Chrome "Failed to fetch")
  if (typeof name === "string" && name && name !== "Error") return name.slice(0, 40); // NotAllowedError·NotSupportedError…
  return (msg || String(e)).slice(0, 40) || "unknown";
}

/** 이 환경·입력이 클라우드 TTS를 쓸 수 있는가. 아니면 기기 음성으로 간다(§16-2). */
function canUseCloud(lang: string, text: string): boolean {
  if (typeof window === "undefined") return false; // SSR 방어(재생은 클릭 시점이라 실제로는 안 걸린다)
  if (typeof fetch === "undefined" || typeof Audio === "undefined") return false;
  if (!isTtsLang(lang)) return false; // 화이트리스트 밖 언어 → 기기 음성
  if (text.length > TTS_TEXT_MAX_CHARS) return false; // 상한 초과 → 기기 음성(§16-1)
  return true;
}

/** 우리 쪽 중단(소비자 abort)을 알리는 오류 — fetch가 abort로 끊길 때와 같은 이름(AbortError). */
function abortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  }
}

/**
 * **진행 중 합성 공유**(in-flight, §16-5). 같은 캐시 키를 🔊(speak)·프리페치·큐 look-ahead가 동시에 원하면
 * `/api/tts` 요청은 하나다 — 예전엔 속도를 바꾼 직후 🔊가 재실행 프리페치와 같은 문장을 두 번 합성했다(2026-09-25 QA).
 *
 * abort 의미 보존: 소비자는 자기 `signal`로만 **자기가 기다리는 것을** 그만둔다(AbortError로 reject). 공유 요청은
 * **기다리는 소비자가 0이 될 때만** 끊고(서버가 req.signal로 상류 합성까지 멈춘다) 곧바로 표에서 뺀다 — 그래서 뒤에 온
 * 소비자는 끊긴 요청에 붙지 않고 새로 보낸다. signal 없는 소비자(speak)는 끝까지 기다리는 쪽으로 센다(대기 상한이 지나도
 * 요청은 살려 둬 늦게라도 캐시에 남긴다 — 예전 동작 그대로).
 */
interface InflightSynth {
  key: string;
  promise: Promise<Blob>;
  /** 공유 요청 자체의 중단기(소비자 signal과 별개) */
  controller: AbortController;
  /** 아직 기다리는 소비자 수 */
  consumers: number;
  settled: boolean;
  /** 지금 단계(진단) — 붙어 있는 소비자들의 trace에 함께 적는다 */
  stage: TtsPlaybackStage;
  traces: Set<{ stage: TtsPlaybackStage }>;
  startedAt: number;
}
const inflightSynth = new Map<string, InflightSynth>();

/**
 * 공유 요청 하나를 시작한다: 2차(IndexedDB) 조회 → 없으면 `/api/tts` 합성 → 두 겹 캐시에 넣는다.
 * `skipPersisted`(자가 치유 전용): 2차 조회를 건너뛰고 곧장 합성한다 — 방금 캐시 오디오가 재생에 실패했다.
 */
function startSynthesis(key: string, text: string, lang: string, speed: number, skipPersisted = false): InflightSynth {
  const controller = new AbortController();
  const entry = {
    key,
    controller,
    consumers: 0,
    settled: false,
    stage: skipPersisted ? "synth" : "cache",
    traces: new Set(),
    startedAt: Date.now(),
  } as InflightSynth; // promise는 바로 아래에서 채운다(setStage가 entry를 참조하므로 먼저 만든다)
  const setStage = (s: TtsPlaybackStage) => {
    entry.stage = s;
    for (const t of entry.traces) t.stage = s;
  };
  entry.promise = (async () => {
    if (!skipPersisted) {
      // 2차(IndexedDB) 히트: 앱을 닫았다 열어도 산다 → 재합성·재요금 없음. IDB 불가면 null(조용히 통과).
      // 받는 것은 IDB 바이트로 새로 만든 메모리 Blob이다(lib/tts-cache.ts — 죽은 옛 Blob은 여기까지 오지 않고 미스가 된다).
      const persisted = await ttsCacheGet(key);
      if (persisted) {
        rememberInMemory(key, persisted); // 1차로 승격
        return persisted;
      }
      if (controller.signal.aborted) throw abortError(); // 조회 도중 모두 떠났다 — 보내지 않는다
    }

    setStage("synth");
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, lang, speed }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`tts ${res.status}`); // 키 없음(501)·검증 실패(400)·합성 실패(500)
    // 200인데 오디오가 아니다(호스팅 폴백 HTML·캡티브 포털) — 재생도 캐시도 하지 않는다(재생 NotSupportedError가 캐시에 굳지 않게).
    const type = audioMediaType(res.headers.get("content-type"));
    if (!type) throw new Error("tts type");
    // 바이트로 받아 메모리 Blob을 직접 만든다 — 형식(audio/*)을 보장하고, 2차 캐시에는 이 바이트가 들어간다.
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("tts empty");
    const blob = new Blob([bytes], { type });

    rememberInMemory(key, blob); // 1차
    void ttsCachePut(key, blob); // 2차(best-effort, 비동기) — 실패해도 재생엔 지장 없음
    return blob;
  })();
  const drop = () => {
    entry.settled = true;
    if (inflightSynth.get(key) === entry) inflightSynth.delete(key);
  };
  entry.promise.then(drop, drop); // 소비자가 모두 떠나 끊겨도 unhandled rejection이 나지 않게 여기서 받는다
  return entry;
}

/** 공유 요청에 소비자 하나로 붙는다. 자기 signal이 abort되면 자기만 떠나고, 마지막 소비자면 요청을 끊는다. */
function joinSynthesis(entry: InflightSynth, signal?: AbortSignal, trace?: { stage: TtsPlaybackStage }): Promise<Blob> {
  entry.consumers++;
  if (trace) {
    trace.stage = entry.stage;
    entry.traces.add(trace);
  }
  return new Promise<Blob>((resolve, reject) => {
    let left = false;
    const leave = (): boolean => {
      if (left) return false;
      left = true;
      signal?.removeEventListener("abort", onAbort);
      if (trace) entry.traces.delete(trace);
      entry.consumers--;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (entry.consumers === 0 && !entry.settled) {
        // 아무도 안 기다린다 — 표에서 먼저 빼고(뒤에 온 소비자는 새로 보낸다) 요청을 끊는다(서버·상류 합성도 멈춘다).
        if (inflightSynth.get(entry.key) === entry) inflightSynth.delete(entry.key);
        entry.controller.abort();
      }
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (blob) => {
        if (leave()) resolve(blob);
      },
      (e) => {
        if (leave()) reject(e);
      },
    );
  });
}

/**
 * 캐시 확인 → 없으면 `/api/tts` 합성 후 캐시에 넣는다. 200이 아니면(501·400·500) throw → 호출부가
 * 기기 음성으로 폴백(재생)하거나 조용히 무시(프리페치). `signal`은 프리페치·큐가 중단하는 용도 — 같은 키를 다른 소비자가
 * 기다리고 있으면 요청은 계속되고 이 호출만 AbortError로 물러난다(진행 중 합성 공유, 위 InflightSynth).
 * `trace`(선택, 진단용): 지금 어느 단계인지(cache → synth)를 적어 둔다 — 실패·타임아웃이 난 단계를 캡션에 보이려고.
 * 끝났을 때 `trace.stage`가 여전히 "cache"면 이 오디오는 **캐시(메모리·IndexedDB)에서 왔다**(자가 치유 판정이 쓴다).
 * `fresh`(자가 치유 전용): 두 캐시와 진행 중 요청을 건너뛰고 네트워크로 새로 받는다(새 요청이 표의 자리를 잇는다).
 */
function getAudioBlob(
  text: string,
  lang: string,
  speed: number,
  signal?: AbortSignal,
  trace?: { stage: TtsPlaybackStage },
  fresh = false,
): Promise<Blob> {
  const key = `${lang}:${speed}:${text}`;
  if (trace) trace.stage = fresh ? "synth" : "cache";
  if (!fresh) {
    const cached = cloudCache.get(key);
    if (cached) return Promise.resolve(cached); // 1차(메모리) 히트: 네트워크 0
  }
  if (signal?.aborted) return Promise.reject(abortError());

  let entry = fresh ? undefined : inflightSynth.get(key);
  // 합성 대기 상한(fetchMs)을 넘긴 요청에는 새로 붙지 않는다 — 매달린 요청에 묶여 다시 눌러도 영영 클라우드를 못 쓰는 일이
  // 없게(그 요청은 기존 소비자를 위해 살려 둔다). 끊긴 요청은 이미 표에서 빠져 있지만 한 번 더 거른다.
  if (entry && (entry.controller.signal.aborted || Date.now() - entry.startedAt > queueTiming.fetchMs)) entry = undefined;
  if (!entry) {
    entry = startSynthesis(key, text, lang, speed, fresh);
    inflightSynth.set(key, entry);
  }
  return joinSynthesis(entry, signal, trace);
}

/** playBlob이 `error` 이벤트로 끝날 때의 오류 — 캡션 문구("audio play error")는 예전 그대로, 미디어 오류 코드를 싣는다. */
const AUDIO_ERROR_MESSAGE = "audio play error";
type MediaPlayError = Error & { mediaCode: number | null };

/**
 * 재생 실패가 **오디오 자체**(미디어 소스) 문제인가 — 자가 치유 대상. WebKit은 읽을 수 없는 Blob을 `<audio>` error 4 +
 * `play()` NotSupportedError로 알린다(2026-09-27 신고). `error` 이벤트로 먼저 끝나면 playBlob이 mediaCode를 실어 준다 —
 * 사용자 중단(1, MEDIA_ERR_ABORTED)만 빼고 네트워크(2)·해독(3)·소스(4)·모름은 오디오 문제로 본다.
 * iOS 재생 차단(NotAllowedError)·AbortError·대기 상한은 오디오 문제가 아니다(새로 받아도 같다 — 요금만 난다).
 */
function isMediaSourceFailure(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotSupportedError") return true;
  if (e instanceof Error && e.message === AUDIO_ERROR_MESSAGE) return (e as MediaPlayError).mediaCode !== 1;
  return false;
}

/**
 * 자가 치유(§16-5, 2026-09-27)의 재시도 한 번: 네트워크로 새로 받아(`fresh`) 같은 재사용 요소로 재생한다.
 * `trace.stage`는 합성 → 재생을 따라간다(실패하면 호출부가 그 단계로 진단을 남긴다). 새로 받은 오디오도 미디어 소스 오류면
 * 그 키를 캐시에 남기지 않고 throw — 호출부가 기기 음성으로 간다. **다시 치유하지 않는다**(1회 — 무한 반복 금지).
 * 취소(토큰이 바뀜)면 조용히 돌아온다.
 */
async function replayFresh(
  text: string,
  lang: string,
  speed: number,
  token: number,
  trace: { stage: TtsPlaybackStage },
  signal: AbortSignal | undefined,
  cap: { fallbackMs: number; slackMs: number } | undefined,
  onStart: () => void,
): Promise<void> {
  const blob = await waitWithTimeout(getAudioBlob(text, lang, speed, signal, trace, true), queueTiming.fetchMs);
  if (token !== playToken) return;
  trace.stage = "play";
  try {
    await playBlob(blob, token, queueAudio ?? undefined, cap, onStart);
  } catch (e) {
    if (token === playToken && isMediaSourceFailure(e)) forgetCachedAudio(`${lang}:${speed}:${text}`);
    throw e;
  }
}

/**
 * Blob을 재생한다. objectURL은 재생마다 새로 만들고 종료·에러·취소에 반드시 회수한다(누수 금지).
 *
 * `el`(선택): 재사용할 오디오 요소 — iOS 재생 잠금 때문에 탭 안에서 풀어 둔 요소 하나(`queueAudio`)를 돌려 쓴다.
 * 큐(speakQueue, §18-2)와 단발(speak, §16-5 — 2026-09-25부터)이 모두 넘긴다. 생략하면 재생마다 `new Audio`
 * (요소를 못 만든 환경의 폴백). 요소를 재사용하므로 전역 정리의 동일성 검사는 요소가 아니라 **이번 호출의 url**(호출마다 유일)로 한다.
 *
 * `cap`(선택, 큐 전용): **재생 안전 타임아웃**(§18-2). `ended`가 끝내 안 오면 큐가 그 조각에서 영영 멈춘다 — 그래서
 * 오디오 duration이 유한하면 `duration × 1000 + slackMs`, 모르면 `fallbackMs`(기기 추정식) 뒤에 소리를 끊고
 * 끝난 것으로 본다(resolve → 다음 조각). 생략하면(speak() 경로) 상한 없음.
 *
 * `onStart`(선택, 진단용): play()가 실제로 시작됐을 때 한 번(이미 취소됐으면 부르지 않는다).
 */
function playBlob(
  blob: Blob,
  token: number,
  el?: HTMLAudioElement,
  cap?: { fallbackMs: number; slackMs: number },
  onStart?: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url: string;
    try {
      url = URL.createObjectURL(blob);
    } catch (e) {
      reject(e as Error);
      return;
    }
    let audio: HTMLAudioElement;
    if (el) {
      // 이전 재생의 핸들러가 새 소스에 반응하지 않게 먼저 비운다.
      el.onended = null;
      el.onerror = null;
      el.onpause = null;
      audio = el;
      try {
        audio.src = url;
      } catch (e) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* noop */
        }
        reject(e as Error);
        return;
      }
    } else {
      audio = new Audio(url);
    }
    audio.playbackRate = 1; // 속도는 서버 speed로 이미 반영됨(이중 적용 금지)

    let settled = false;
    let started = false; // 이번 play()가 실제로 시작됐는가(소스 교체로 생긴 낡은 pause 이벤트를 걸러 낸다)
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      audio.onended = null;
      audio.onerror = null;
      if (el) audio.onpause = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      if (currentAudioUrl === url) {
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
    audio.onerror = () =>
      finish(() => {
        const err = new Error(AUDIO_ERROR_MESSAGE) as MediaPlayError;
        const code = audio.error?.code;
        err.mediaCode = typeof code === "number" ? code : null; // 자가 치유 판정(isMediaSourceFailure)
        reject(err);
      });
    if (el) {
      // 우리가 일으키지 않은 pause(잠금 화면 ⏸·전화) = 정지로 본다 — ended가 안 와 큐가 막히지 않게(§18-2).
      // 끝까지 재생될 때도 pause가 ended 직전에 오므로 audio.ended로 거른다. 우리 pause()는 finish가 먼저 핸들러를 뗀다.
      audio.onpause = () => {
        if (!settled && started && !audio.ended && token === playToken) cancelPlayback();
      };
    }
    // 재생 안전 타임아웃 — 넘으면 소리를 끊고 "끝남"으로 본다(폴백 아님: 이 조각은 이미 소리를 냈다).
    // pause()가 쏘는 pause 이벤트는 finish가 핸들러를 먼저 떼므로 외부 정지로 오판되지 않는다.
    const armCap = (ms: number) => {
      clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        if (settled) return;
        try {
          audio.pause();
        } catch {
          /* noop */
        }
        finish(() => resolve());
      }, ms);
    };
    // play()가 시작도 끝도 안 하고 매달려도 풀리게 먼저 추정 상한을 건다. 시작되고 길이를 알면 그 길이로 다시 건다.
    if (cap) armCap(cap.fallbackMs);
    void audio.play().then(
      () => {
        started = true;
        if (!settled && onStart) {
          try {
            onStart();
          } catch {
            /* 진단 콜백 예외는 재생을 깨지 않는다 */
          }
        }
        const d = audio.duration;
        if (cap && !settled && Number.isFinite(d) && d > 0) armCap(d * 1000 + cap.slackMs);
      },
      (e) => {
        // 큐 요소의 play()가 AbortError로 끊겼다 = 시작 직전에 누가 멈췄다(우리 취소는 finish가 먼저 settled를 세운다).
        // 잠금 화면 ⏸가 시작 순간에 온 경우 — 실패(기기 음성 폴백)가 아니라 정지로 본다.
        if (el && !settled && token === playToken && (e as { name?: string } | null)?.name === "AbortError") {
          cancelPlayback();
          return;
        }
        finish(() => reject(e as Error));
      },
    );

    // 시작하자마자 낡은 토큰이면(그새 새 speak가 옴) 바로 접는다.
    if (token !== playToken) currentPlayStop?.();
  });
}

/**
 * iOS WebKit 멈춤 복구(§16-5, 2026-09-25): `cancel()` 뒤 speechSynthesis가 **paused 상태로 굳어** 이후 `speak()`가 에러도
 * 이벤트도 없이 무시되는 알려진 버그가 있다 — "기기랑 클라우드가 꼬인 것 같다, 속도를 바꾸다 보면 다시 나오기도 한다"는
 * 관찰의 기기 쪽 고리다(우리는 🔊·큐·폴백마다 cancel한다). 그래서 기기 음성으로 **말하기 직전**(fallbackDevice·
 * speakDeviceAwait·잠금 해제 빈 발화) paused면 `resume()`한다. 앱은 speechSynthesis.pause()를 쓰지 않으므로 paused는 이
 * 버그(또는 시스템)뿐이라 풀어도 잃을 것이 없다. 지원하지 않거나 던지면 조용히 넘어간다.
 */
function resumeIfPaused(ss: SpeechSynthesis): void {
  try {
    if (ss.paused && typeof ss.resume === "function") ss.resume();
  } catch {
    /* best-effort */
  }
}

/**
 * 기기 음성(speechSynthesis)으로 읽는다 — 클라우드가 못 될 때의 폴백(§16-2)이자 device 엔진의 단발 재생. 에러를 띄우지 않는다.
 * 반환값 = 발화를 실제로 걸었는가(진단의 "기기 음성으로 대체" 여부).
 *
 * cancel 규칙은 `speakDeviceAwait`(§18-2)와 같다 — **말하는 중·대기 중일 때만** cancel하고, 잠금 해제용 빈 발화만 남아
 * 있으면 끊지 않고 뒤에 잇는다. 쉬고 있을 때 무조건 cancel() 직후 speak()하면 iOS·Chrome에서 새 발화가 씹혀,
 * 클라우드 실패 뒤의 대체 재생까지 무음이 됐다(2026-09-25 신고, §16-5).
 */
function fallbackDevice(text: string, lang: string, token: number): boolean {
  if (token !== playToken) return false; // 취소로 인한 실패면 폴백도 하지 않는다
  if (!isSpeechSupported()) return false;
  try {
    const ss = window.speechSynthesis;
    if ((ss.speaking || ss.pending) && !unlockUtterance) ss.cancel();
    resumeIfPaused(ss); // iOS: cancel 뒤 paused로 굳어 있으면 이 발화가 조용히 무시된다
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = getTtsRate();
    const voice = resolveVoice(lang); // 고품질 음성 자동/수동 선택(§16) — 없으면 브라우저 기본
    if (voice) utterance.voice = voice;
    ss.speak(utterance);
    return true;
  } catch {
    return false; // 조용히 무음(에러 화면 금지)
  }
}

/**
 * 클라우드 시도 → 실패면 기기 음성. 세대 토큰으로 늦게 끝난 작업을 걸러 낸다. 호출 전에 speak()가 **동기로**
 * 재생 잠금을 풀어 두고(unlockPlayback), 여기선 그 재사용 요소(`queueAudio`)로 재생한다 — iOS는 합성 대기(비동기) 뒤
 * `new Audio().play()`를 막는다(NotAllowedError). 합성 대기에는 큐와 같은 상한(`fetchMs`)을 둬, 망이 매달려도 무음으로
 * 멈추지 않고 기기 음성으로 간다(요청은 끊지 않는다 — 늦게 와도 캐시에 남는다). 결과는 폰 진단에 남긴다.
 *
 * 자가 치유(2026-09-27): 재생이 미디어 소스 오류(NotSupportedError 등)로 실패하면 그 키를 두 캐시에서 뺀다. 그 오디오가
 * **캐시에서 왔으면** 네트워크로 한 번만 새로 받아 다시 재생하고(`replayFresh`), 방금 네트워크로 받은 것이었으면 곧바로 기기 음성
 * (다시 받아도 같다). 재시도도 실패하면 기기 음성 — 두 번 치유하지 않는다.
 */
async function playViaCloud(text: string, lang: string, speed: number, token: number): Promise<void> {
  const trace: { stage: TtsPlaybackStage } = { stage: "cache" };
  let healed = false;
  const onStart = () => noteCloudResult(lang, healed ? DIAG_HEALED : DIAG_OK);
  try {
    const blob = await waitWithTimeout(getAudioBlob(text, lang, speed, undefined, trace), queueTiming.fetchMs);
    if (token !== playToken) return; // 합성 도중 새 재생이 왔다 → 버린다(폴백 안 함)
    const fromCache = trace.stage === "cache";
    trace.stage = "play";
    try {
      await playBlob(blob, token, queueAudio ?? undefined, undefined, onStart);
      // 정상 종료·취소 모두 여기로 온다. 취소면 token이 이미 달라 아무 일도 안 한다.
    } catch (e) {
      if (token !== playToken || !isMediaSourceFailure(e)) throw e;
      forgetCachedAudio(`${lang}:${speed}:${text}`); // 못 트는 오디오를 다시 내주지 않는다
      if (!fromCache) throw e;
      healed = true; // 캐시 오디오 손상 → 새로 받음(1회)
      await replayFresh(text, lang, speed, token, trace, undefined, undefined, onStart);
    }
  } catch (e) {
    if (token !== playToken) return; // 취소로 인한 실패는 폴백·기록하지 않는다
    const fell = fallbackDevice(text, lang, token); // 진짜 실패(캐시·합성·재생·대기 상한) → 기기 음성
    noteCloudResult(lang, { ok: false, stage: trace.stage, reason: failureReason(e), fallback: fell ? "device" : "none", healed });
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
 * 화면이 부른 프리페치 요청 하나. 설정(엔진·속도)이 바뀌면 이 요청을 새 설정으로 다시 돌린다(§16-5) —
 * 그래서 device 언어라 네트워크 없이 끝난 요청도 기억한다(나중에 cloud로 바꾸면 그 자리에서 돈다).
 */
interface PrefetchRequest {
  texts: string[];
  lang: string;
  /** 이 요청의 현재 배치(아직 안 돌았으면 null). 설정이 바뀌어 다시 돌면 새 컨트롤러로 바뀐다. */
  controller: AbortController | null;
  /** 그 배치를 돌린 클라우드 속도(캐시 키의 일부) */
  speed: number;
  /** 화면이 중단 함수를 불렀다(화면 이탈) — 다시 돌지 않는다 */
  stopped: boolean;
}

/** 가장 최근의 프리페치 요청(화면이 중단하면 null). 새 요청이 오면 바뀐다 — "마지막 요청만 다시 돈다". */
let lastPrefetch: PrefetchRequest | null = null;

/** 요청을 지금 설정으로 돌린다. device 언어면 아무것도 안 한다(네트워크 0 — 직전 배치도 건드리지 않는다). */
function startPrefetch(req: PrefetchRequest): void {
  if (getTtsEngine(req.lang) !== "cloud") return; // device 언어는 클라우드를 안 쓰니 프리페치도 안 한다(네트워크 0)

  prefetchAbort?.abort(); // 직전 배치 중단(화면 전환 시 겹침 방지)
  const controller = new AbortController();
  prefetchAbort = controller;
  prefetchLang = langBase(req.lang); // 엔진을 device로 바꿀 때 이 언어 배치만 끊기 위해
  req.controller = controller;
  const speed = cloudSpeed(); // 재생(클라우드)과 같은 키가 되도록 클라우드 속도로 받는다
  req.speed = speed;

  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of req.texts) {
    const text = (raw ?? "").trim();
    if (!text || text.length > TTS_TEXT_MAX_CHARS) continue;
    const key = `${req.lang}:${speed}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cloudCache.has(key)) continue; // 이미 있으면 건너뛴다(네트워크 0)
    targets.push(text);
    if (targets.length >= PREFETCH_MAX_ITEMS) break; // 개수 상한(비용 가드)
  }
  if (targets.length === 0) return;
  void runPrefetch(targets, req.lang, speed, controller.signal);
}

/**
 * 설정이 바뀌었을 때(setTtsEngine → cloud, setTtsRate) 마지막 프리페치를 새 설정으로 다시 돌린다(§16-5).
 * `lang`을 주면 그 언어의 요청일 때만. 같은 설정으로 이미 돌고 있거나 다 받았으면 건드리지 않는다 —
 * 같은 버튼을 다시 눌러 진행 중 요청을 끊으면 합성 요금만 버린다.
 */
function rerunLastPrefetch(lang?: string): void {
  const req = lastPrefetch;
  if (!req || req.stopped) return;
  if (lang !== undefined && langBase(req.lang) !== langBase(lang)) return;
  if (getTtsEngine(req.lang) !== "cloud") return;
  if (req.controller && !req.controller.signal.aborted && req.speed === cloudSpeed()) return;
  startPrefetch(req);
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
 *
 * 설정 변경(§16-5): 이 요청은 "마지막 프리페치"로 기억된다. 화면이 떠 있는 동안 그 언어 엔진을 cloud로 바꾸거나
 * 속도를 바꾸면 **화면 코드 수정 없이** 새 설정으로 다시 돈다(device로 바꾸면 중단). 엔진 전환은 즉시, 속도는 옛 배치를
 * 곧바로 멈추고 마지막 조작 `RATE_PREFETCH_DEBOUNCE_MS` 뒤 한 번 돈다(연타 비용 가드). 중단 함수를 부르면 잊는다.
 * 같은 문장을 🔊·큐가 동시에 원하면 합성 요청을 함께 쓴다(getAudioBlob의 진행 중 합성 공유).
 */
export function prefetchSpeech(texts: string[], lang: string = TTS_LANG): () => void {
  const noop = () => {};
  if (typeof window === "undefined" || typeof fetch === "undefined") return noop;
  if (!isTtsLang(lang)) return noop; // 화이트리스트 밖 언어는 어차피 기기 음성이라 프리페치 무의미

  const req: PrefetchRequest = { texts: [...texts], lang, controller: null, speed: NaN, stopped: false };
  lastPrefetch = req; // device 언어여도 기억한다 — 나중에 cloud로 바꾸면 그 자리에서 돈다
  startPrefetch(req);
  return () => {
    req.stopped = true;
    req.controller?.abort();
    if (req.controller && prefetchAbort === req.controller) {
      prefetchAbort = null;
      prefetchLang = null;
    }
    if (lastPrefetch === req) lastPrefetch = null;
  };
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
 *
 * iOS(§16-5, 2026-09-25): 클라우드 경로는 **첫 await 전에 동기로** 재생 잠금을 푼다(speakQueue와 같은 unlockPlayback —
 * 재사용 요소에 무음 WAV play + 볼륨 0 빈 발화). 🔊 onClick에서 불리면 그 순간 잠금이 풀려, 합성(~1초) 뒤 같은 요소의
 * play()와 실패 시 기기 음성 대체가 탭 밖에서도 난다. 탭 밖(effect의 자동 낭독)에서 불리면 무음 play()가 거부될 뿐
 * (조용히 삼킨다) 예전보다 나빠지지 않는다 — 한 번이라도 탭으로 풀린 요소를 재사용하므로 오히려 날 가능성이 높다.
 */
export function speak(text: string, lang: string = TTS_LANG): void {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  cancelPlayback(); // 이전 것(클라우드·기기·큐) 취소 + 토큰 증가 — 활성 큐의 onEnd("stopped")는 여기서 동기로
  const token = playToken; // 방금 올린 최신 세대
  // 이 언어의 엔진이 device거나 클라우드를 쓸 수 없는 입력(300자 초과·화이트리스트 밖)이면 기기 음성으로 직행한다.
  if (getTtsEngine(lang) !== "cloud" || !canUseCloud(lang, trimmed)) {
    fallbackDevice(trimmed, lang, token);
    return;
  }
  unlockPlayback(true); // 첫 await 전(iOS) — 취소 다음에, 재사용 요소·기기 음성 잠금 해제
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
  inflightSynth.clear(); // 새 세션에는 진행 중 요청도 없다(앞 검증의 매달린 요청에 다음 검증이 붙지 않게)
}

// ───────────────────────── 연속 재생 큐 (§18-2) ─────────────────────────
//
// 해설 전체를 순서대로 이어 읽는다(한국어 설명은 한국어로, 일본어 문장은 일본어로). speak()와 **같은 토큰 규약**을
// 쓰므로 다른 🔊·stopSpeaking()·새 큐가 오면 곧바로 멈춘다. 조각마다 그 시점의 엔진·속도를 따른다(다음 조각부터 반영).

/** 큐 조각 — 쪼개지 않는다(인덱스 보존). 300자를 넘는 조각은 그 조각만 기기 음성. */
export interface SpeakQueueItem {
  text: string;
  lang: string;
}

/**
 * `onEnd`의 둘째 인자 — **하위 호환 추가**(인자 하나짜리 기존 핸들러는 그대로 동작한다. 늘 넘기지만 읽을지는 호출부 몫).
 * `sounded` = 끝까지 **소리를 냈다고 본** 조각 수(클라우드 재생이 끝났거나, 기기 음성이 onend·끊김·안전 타임아웃으로 끝났다).
 * 소리를 못 낸 조각(클라우드 불가 + 기기 음성 미지원·오류)은 세지 않는다. 멈춤·밀려남으로 도중에 끊긴 조각도 세지 않는다.
 * "stopped" 판정(무음 조각 **연속 QUEUE_SILENT_STOP개**)은 바뀌지 않는다 — 그보다 짧은 큐가 전부 무음이면 "done"이면서
 * `sounded === 0`이다. 소리를 꼭 들려야 하는 화면(토익 응시 질문 음성)은 이 값으로 "done"을 다시 판정한다.
 * 빈 items(모두 공백)·브라우저 밖은 0.
 */
export interface SpeakQueueEndInfo {
  sounded: number;
}

/**
 * 큐 핸들러. `onItem(i)`는 조각 i를 읽기 시작할 때, `onEnd`는 **정확히 한 번**(끝까지 = "done", 그 밖 = "stopped").
 * ⚠️ 핸들러 안에서 speak()/speakQueue()를 부르지 않는다(재진입 금지 — 계약). 핸들러 예외는 큐를 깨지 않는다.
 */
export interface SpeakQueueHandlers {
  onItem?: (index: number) => void;
  onEnd?: (reason: "done" | "stopped", info: SpeakQueueEndInfo) => void;
}

/**
 * 큐와 단발 재생(speak, §16-5)이 돌려 쓰는 오디오 요소 하나 — iOS는 탭 밖(합성 대기 뒤 포함)에서 새 Audio의 play()를
 * 막으므로, 탭 안에서 풀어 둔 요소를 재사용한다. 둘은 같은 세대 토큰·cancelPlayback으로 서로를 동기로 끊는다.
 */
let queueAudio: HTMLAudioElement | null = null;
/** 잠금 해제용 0.1초 무음 WAV의 objectURL — 한 번 만들고 상수처럼 쓴다(일부러 revoke하지 않는다). */
let silentUrl: string | null = null;
/** 큐의 기기 재생 발화 — 모듈 변수로 붙잡는다(GC로 onend가 사라지는 Chrome 버그). */
let currentUtterance: SpeechSynthesisUtterance | null = null;
/**
 * 잠금 해제용 무음 발화가 아직 대기열에 있는가. 있으면 첫 기기 조각에서 cancel()하지 않고 뒤에 잇는다 —
 * cancel() 직후의 speak()가 씹히는 iOS·Chrome 증상을 피한다(말하는 중일 때만 cancel 규약의 연장).
 */
let unlockUtterance: SpeechSynthesisUtterance | null = null;

/** 큐 타이밍 상수 — 테스트가 `__setQueueTiming`으로 줄인다. */
const QUEUE_TIMING_DEFAULT = {
  /** 재생 안전 타임아웃 추정 = max(minMs, 글자수 × perCharMs ÷ rate + slackMs) — 기기 조각, 그리고 길이를 모르는 클라우드 조각 */
  minMs: 3000,
  perCharMs: 250,
  slackMs: 2000,
  /** 만료 시 아직 말하는 중이면 이만큼씩 연장(상한 = 추정 × capFactor) */
  extendMs: 1000,
  capFactor: 3,
  /** 합성 대기 상한 — 큐가 그 조각을 기다리기 시작한 때부터. 넘으면 그 조각은 기기 음성(요청은 살려 둔다) */
  fetchMs: 8000,
  /** 클라우드 조각 재생 안전 타임아웃의 여유 — duration이 유한하면 duration × 1000 + 이 값 */
  playSlackMs: 3000,
  /** 지문 GET 대기 상한(큐 전용은 아니지만 테스트 훅을 하나로 둔다) */
  fingerprintMs: FINGERPRINT_TIMEOUT_MS,
  /** 속도 변경 → 프리페치 재실행 trailing 디바운스(마지막 조작 뒤 이만큼). 큐 전용은 아니지만 테스트 훅을 하나로 둔다 */
  rateDebounceMs: RATE_PREFETCH_DEBOUNCE_MS,
};
type QueueTiming = typeof QUEUE_TIMING_DEFAULT;
let queueTiming: QueueTiming = { ...QUEUE_TIMING_DEFAULT };

/** 재생 시간 추정(ms) = max(minMs, 글자수 × perCharMs ÷ rate + slackMs). 기기 조각 안전 타임아웃과 클라우드 조각 폴백 상한이 같이 쓴다. */
function estimateSpeechMs(text: string, rate: number): number {
  const r = rate > 0 ? rate : 1;
  return Math.max(queueTiming.minMs, (text.length * queueTiming.perCharMs) / r + queueTiming.slackMs);
}

/**
 * 소리를 낼 수 없는 조각이 연속 이만큼이면 큐를 "stopped"로 끝낸다(하이라이트만 번쩍이며 "done"이 되지 않게).
 * 이보다 짧은 큐는 전부 무음이어도 "done"이다 — 그 경우는 onEnd 둘째 인자 `sounded === 0`으로 알린다(SpeakQueueEndInfo).
 */
const QUEUE_SILENT_STOP = 3;
/** 큐 look-ahead로 미리 받을 다음 클라우드 조각 수(device 조각은 세지 않는다). 해설 전체를 미리 합성하지 않는다(비용 가드). */
const QUEUE_LOOKAHEAD = 2;

/** 테스트 전용 — 큐 타이밍 상수를 바꾼다(null이면 기본값으로). `__clearTtsMemoryCache`와 같은 관용구. */
export function __setQueueTiming(t: Partial<QueueTiming> | null): void {
  queueTiming = t ? { ...queueTiming, ...t } : { ...QUEUE_TIMING_DEFAULT };
}

/** 0.1초 무음 WAV(8kHz·8bit·mono, 844바이트)의 objectURL. */
function makeSilentWavUrl(): string {
  const rate = 8000;
  const n = 800;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 청크 크기
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byteRate = rate × 1ch × 1byte
  v.setUint16(32, 1, true); // blockAlign
  v.setUint16(34, 8, true); // bits
  str(36, "data");
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8bit PCM의 무음 = 128
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/**
 * iOS 재생 잠금 해제 — 큐 요소를 무음 WAV로 play()하고, 기기 음성도 볼륨 0 빈 발화를 한 번 말한다.
 * `afterCancel`: speakQueue·speak(cloud)가 cancelPlayback() **다음에** 부를 때 true(무조건). 공개 unlockSpeechPlayback()은
 * false — 지금 재생 중인 것(큐 요소·기기 발화)을 끊지 않도록 쉬고 있을 때만 한다(재생 중이면 이미 풀려 있다).
 */
function unlockPlayback(afterCancel: boolean): void {
  if (typeof window === "undefined") return;
  if (typeof Audio !== "undefined") {
    try {
      if (!queueAudio) queueAudio = new Audio();
      if (afterCancel || currentAudio !== queueAudio) {
        if (!silentUrl) silentUrl = makeSilentWavUrl();
        queueAudio.onended = null;
        queueAudio.onerror = null;
        queueAudio.onpause = null;
        queueAudio.src = silentUrl;
        const p = queueAudio.play();
        // 곧바로 실제 소스로 바뀌면 이 play()는 AbortError로 끝난다 — 조각 실패가 아니므로 따로 삼킨다.
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch {
      /* noop — 잠금 해제는 best-effort */
    }
  }
  if (isSpeechSupported()) {
    try {
      const ss = window.speechSynthesis;
      if (afterCancel || !(ss.speaking || ss.pending)) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        const clear = () => {
          if (unlockUtterance === u) unlockUtterance = null;
        };
        u.onend = clear;
        u.onerror = clear;
        unlockUtterance = u;
        resumeIfPaused(ss); // iOS: 바로 앞 cancelPlayback의 cancel()로 paused가 되면 잠금 해제 발화부터 무시된다
        ss.speak(u);
      }
    } catch {
      /* noop */
    }
  }
}

/**
 * **탭 핸들러 안에서 동기로** 부른다 — iOS Safari의 재생 잠금을 푼다. 이후 탭 밖(타이머 콜백 등)의 speakQueue도
 * 같은 오디오 요소를 쓰므로 소리가 날 가능성이 높다(§19 운동 안내가 쓴다). 재생 중이면 아무것도 끊지 않는다.
 */
export function unlockSpeechPlayback(): void {
  unlockPlayback(false);
}

/**
 * **기다릴 수 있는 기기 재생**(큐 전용). onend/onerror로 풀리고, `currentPlayStop`에 등록돼 cancelPlayback()이 이벤트를
 * 기다리지 않고 즉시 푼다. 안전 타임아웃: 추정 시간이 지나도 말하는 중이면 extendMs씩 연장(상한 = 추정 × capFactor),
 * 아니면(또는 상한) cancel() 후 다음 조각. 반환값 = 소리를 냈다고 볼 수 있는가(미지원·즉시 실패면 false).
 * fallbackDevice(onend 없음 — 기다릴 수 없다)는 큐에서 재사용하지 않는다. cancel 규칙은 둘이 같다(§16-5).
 */
function speakDeviceAwait(text: string, lang: string, token: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (token !== playToken) return resolve(true); // 이미 밀려났다 — 호출부가 토큰으로 물러난다
    if (!isSpeechSupported()) return resolve(false);
    const ss = window.speechSynthesis;
    let u: SpeechSynthesisUtterance;
    try {
      u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = getTtsRate();
      const voice = resolveVoice(lang);
      if (voice) u.voice = voice;
    } catch {
      return resolve(false);
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (sounded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      u.onend = null;
      u.onerror = null;
      if (currentPlayStop === stop) currentPlayStop = null;
      if (currentUtterance === u) currentUtterance = null;
      resolve(sounded);
    };
    const stop = () => finish(true); // speechSynthesis.cancel()은 cancelPlayback이 따로 한다
    currentPlayStop = stop;
    currentUtterance = u;
    u.onend = () => finish(true);
    u.onerror = (e) => {
      // 끊김(interrupted·canceled)은 소리 문제가 아니다. not-allowed·synthesis-failed 등은 "못 냄".
      const err = (e as SpeechSynthesisErrorEvent | undefined)?.error;
      finish(err === "interrupted" || err === "canceled");
    };

    const est = estimateSpeechMs(text, u.rate);
    const cap = est * queueTiming.capFactor;
    const t0 = Date.now();
    const tick = () => {
      if (settled) return;
      let busy = false;
      try {
        busy = ss.speaking || ss.pending;
      } catch {
        /* noop */
      }
      if (busy && Date.now() - t0 + queueTiming.extendMs <= cap) {
        timer = setTimeout(tick, queueTiming.extendMs);
        return;
      }
      unlockUtterance = null;
      try {
        ss.cancel();
      } catch {
        /* noop */
      }
      finish(true);
    };
    timer = setTimeout(tick, est);

    try {
      // 말하는 중일 때만 cancel — 조각마다 무조건 cancel하면 iOS·Chrome에서 새 발화가 씹힌다.
      // 잠금 해제용 무음 발화만 남아 있으면 끊지 않고 뒤에 잇는다.
      if ((ss.speaking || ss.pending) && !unlockUtterance) ss.cancel();
      resumeIfPaused(ss); // iOS: 앞 조각·cancelPlayback의 cancel 뒤 paused로 굳어 있으면 조각이 조용히 무시된다
      ss.speak(u);
    } catch {
      finish(false);
    }
  });
}

/** 합성 **대기** 타임아웃 표식 — 요청 실패가 아니다(요청은 살아 있다). */
const WAIT_TIMEOUT = new Error("tts wait timeout");

/** 큐의 합성 요청 → 그 요청이 지금 어느 단계인지(진단용). look-ahead가 먼저 만든 요청도 같은 표를 쓴다. */
const blobStage = new WeakMap<Promise<Blob>, { stage: TtsPlaybackStage }>();

/**
 * 합성 결과를 **기다리는 것에만** 타임아웃을 건다(큐 전용, §18-2). 타이머는 이 함수를 부른 때 = 큐가 그 조각을
 * 기다리기 시작한 때부터 돈다 — look-ahead가 요청을 먼저 보냈어도 앞 조각을 재생하던 시간은 세지 않는다.
 * 넘으면 WAIT_TIMEOUT으로 reject(→ 그 조각만 기기 음성)하되 **요청은 끊지 않는다** — 늦게라도 끝나면 캐시에 남아
 * 같은 문장·다음 재청취가 재합성 없이 쓴다. 요청은 큐가 끝날 때 큐의 AbortController가 정리한다.
 * (setTimeout 수동 구현 — `AbortSignal.timeout/any`는 iOS 17.4+라 쓰지 않는다.)
 */
function waitWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(WAIT_TIMEOUT), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 조각 배열을 **순서대로 이어 읽는다**(§18-2). 반환값 = 멈추기 함수.
 *
 * ⚠️ **탭 핸들러 안에서 동기로** 부른다(await·setTimeout 뒤 금지) — 첫 await 전에 iOS 재생 잠금을 푼다.
 * - 시작 시 이전 재생(단발·큐)을 끊는다. 옛 큐의 onEnd("stopped")는 이 호출 안에서, 새 onItem(0)보다 먼저 온다.
 * - 멈추기 함수: 이미 끝났으면 no-op, 아직 이 큐의 세대면 재생 취소, 다른 재생에 밀려났으면 자기만 정리
 *   (끝났거나 밀려난 큐의 stop이 그 뒤 시작된 다른 재생을 죽이지 않는다).
 * - 빈 items(모두 공백): 취소 없이 onEnd("done", { sounded: 0 })를 microtask로 한 번.
 * - 조각마다 그 시점의 엔진·속도. cloud 실패(합성·재생·타임아웃)면 그 조각만 기기 음성. 501(키 없음)이면 이후 기기 직행.
 * - onEnd 둘째 인자 `{ sounded }`(SpeakQueueEndInfo) — 소리를 낸 조각 수. 짧은 큐가 전부 무음이어도 "done"이므로
 *   소리가 꼭 나야 하는 호출부는 `sounded`로 다시 판정한다.
 */
export function speakQueue(items: SpeakQueueItem[], handlers: SpeakQueueHandlers = {}): () => void {
  const list = (items ?? []).map((it) => ({ text: (it?.text ?? "").trim(), lang: it?.lang || TTS_LANG }));
  const call = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* 핸들러 예외는 큐를 깨지 않는다 */
    }
  };
  const noop = () => {};
  if (list.every((it) => !it.text) || typeof window === "undefined") {
    const reason = list.every((it) => !it.text) ? "done" : "stopped";
    void Promise.resolve().then(() => call(() => handlers.onEnd?.(reason, { sounded: 0 })));
    return noop;
  }

  cancelPlayback(); // 옛 speak/큐 정지 + 옛 큐 onEnd("stopped") 동기 호출
  const token = playToken;
  unlockPlayback(true); // 첫 await 전(iOS) — 그래서 탭 핸들러 안에서 동기로 불려야 한다

  const ac = new AbortController(); // 큐 전용 — 전역 prefetchAbort를 건드리지 않는다
  /** 큐 로컬 진행 중 합성 — 재생 단계와 look-ahead가 같은 문장을 두 번 합성하지 않게(키 = 캐시 키). */
  const pending = new Map<string, Promise<Blob>>();
  let ended = false;
  let cloudOff = false;
  let silentRun = 0;
  /** 끝까지 소리를 냈다고 본 조각 수 — onEnd 둘째 인자(SpeakQueueEndInfo) */
  let soundedCount = 0;

  const end = (reason: "done" | "stopped") => {
    if (ended) return;
    ended = true;
    if (activeQueueEnd === endStopped) activeQueueEnd = null;
    ac.abort();
    pending.clear();
    const info: SpeakQueueEndInfo = { sounded: soundedCount };
    call(() => handlers.onEnd?.(reason, info));
  };
  const endStopped = () => end("stopped");
  activeQueueEnd = endStopped;
  const alive = () => !ended && token === playToken;

  const keyOf = (text: string, lang: string, speed: number) => `${lang}:${speed}:${text}`;
  const isCloud = (it: SpeakQueueItem) => !cloudOff && getTtsEngine(it.lang) === "cloud" && canUseCloud(it.lang, it.text);
  const noteError = (e: unknown) => {
    if (e instanceof Error && e.message === "tts 501") cloudOff = true; // 키 없음 — 조각마다 요청을 되풀이하지 않는다
  };
  /** 합성 요청(재생 단계·look-ahead 공용). 타임아웃은 여기 아니라 **기다리는 쪽**(waitWithTimeout)에 건다. */
  const blobFor = (text: string, lang: string, speed: number): Promise<Blob> => {
    const key = keyOf(text, lang, speed);
    let p = pending.get(key);
    if (!p) {
      const trace: { stage: TtsPlaybackStage } = { stage: "cache" };
      p = getAudioBlob(text, lang, speed, ac.signal, trace);
      blobStage.set(p, trace); // 진단 — 실패·대기 상한이 캐시·합성 중 어디서 났는지
      p.catch(noteError); // look-ahead만 하고 안 쓰여도 unhandled rejection이 나지 않게
      pending.set(key, p);
    }
    return p;
  };
  /** 조각 i 재생 중 다음 클라우드 조각 QUEUE_LOOKAHEAD개를 순차로 미리 받는다. 발사 직전 엔진·cloudOff 재확인. */
  const lookAhead = async (from: number) => {
    const targets: number[] = [];
    for (let j = from; j < list.length && targets.length < QUEUE_LOOKAHEAD; j++) {
      if (list[j].text && isCloud(list[j])) targets.push(j);
    }
    for (const j of targets) {
      if (!alive()) return;
      const it = list[j];
      if (!isCloud(it)) continue;
      try {
        await blobFor(it.text, it.lang, cloudSpeed());
      } catch {
        /* 재생 단계가 처리한다(그 조각은 기기 음성) */
      }
    }
  };

  void (async () => {
    let completed = false;
    try {
      for (let i = 0; i < list.length; i++) {
        if (!alive()) return;
        const it = list[i];
        if (!it.text) continue; // 공백 조각은 건너뛰되 인덱스는 보존
        call(() => handlers.onItem?.(i));
        if (!alive()) return;

        let sounded = false;
        if (isCloud(it)) {
          const speed = cloudSpeed();
          const key = keyOf(it.text, it.lang, speed);
          const req = blobFor(it.text, it.lang, speed);
          let timedOut = false;
          let playing = false;
          /** 자가 치유(캐시 오디오 손상 → 새로 받음, 1회)를 했으면 그 재시도의 단계 — 진단이 이 단계를 적는다. */
          let healTrace: { stage: TtsPlaybackStage } | null = null;
          const cap = { fallbackMs: estimateSpeechMs(it.text, getTtsRate()), slackMs: queueTiming.playSlackMs };
          const onStart = () => noteCloudResult(it.lang, healTrace ? DIAG_HEALED : DIAG_OK);
          try {
            // 대기 타임아웃은 **지금**(이 조각을 기다리기 시작한 때)부터 잰다(§18-2).
            const blob = await waitWithTimeout(req, queueTiming.fetchMs);
            if (!alive()) return;
            const fromCache = blobStage.get(req)?.stage === "cache";
            void lookAhead(i + 1);
            playing = true;
            try {
              await playBlob(blob, token, queueAudio ?? undefined, cap, onStart);
            } catch (e) {
              if (!alive() || !isMediaSourceFailure(e)) throw e;
              // 단발(playViaCloud)과 같은 자가 치유 — 못 트는 오디오는 두 캐시와 큐 로컬 표에서 빼고, 캐시에서 왔으면 한 번 새로 받는다.
              forgetCachedAudio(key);
              if (pending.get(key) === req) pending.delete(key);
              if (!fromCache) throw e;
              healTrace = { stage: "synth" };
              await replayFresh(it.text, it.lang, speed, token, healTrace, ac.signal, cap, onStart);
            }
            sounded = true;
          } catch (e) {
            timedOut = e === WAIT_TIMEOUT;
            noteError(e); // 합성·재생 실패·대기 타임아웃 → 아래에서 그 조각만 기기 음성(한 방향 폴백)
            if (alive()) {
              noteCloudResult(it.lang, {
                ok: false,
                stage: healTrace ? healTrace.stage : playing ? "play" : (blobStage.get(req)?.stage ?? "synth"),
                reason: failureReason(e),
                fallback: isSpeechSupported() ? "device" : "none",
                healed: healTrace !== null,
              });
            }
          } finally {
            const drop = () => {
              if (pending.get(key) === req) pending.delete(key);
            };
            // 대기만 타임아웃이면 요청은 아직 진행 중 — 끝날 때까지 맵에 둬서 같은 문장이 두 번 합성되지 않게 한다.
            if (timedOut) req.then(drop, drop);
            else drop();
          }
          if (!alive()) return;
        }
        if (!sounded) {
          void lookAhead(i + 1);
          sounded = await speakDeviceAwait(it.text, it.lang, token);
          if (!alive()) return;
        }
        if (sounded) soundedCount += 1;
        silentRun = sounded ? 0 : silentRun + 1;
        if (silentRun >= QUEUE_SILENT_STOP) return; // 소리를 낼 수 없다 → stopped
      }
      completed = true;
    } finally {
      end(completed && token === playToken ? "done" : "stopped");
    }
  })();

  return () => {
    if (ended) return;
    if (token === playToken) cancelPlayback(); // 아직 이 큐의 세대 — 재생까지 끊는다(onEnd는 그 안에서 동기로)
    else end("stopped"); // 이미 밀려났다 — 다른 재생은 건드리지 않고 자기만 정리
  };
}

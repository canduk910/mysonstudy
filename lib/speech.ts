/**
 * lib/speech.ts — 영어 발음 재생(Web Speech API)의 단일 정의처
 *
 * 왜 별도 모듈인가: `rate`·`lang` 같은 다이얼이 화면마다 복사되면 반드시 갈린다.
 * 카드 화면에서 0.9로 읽던 단어가 단어장에서는 1.0으로 읽히면, 같은 단어인데 다른
 * 목소리처럼 들린다 — 아이 입장에서는 앱이 두 개인 셈이다. 그래서 함수도 상수도
 * 여기 한 곳에만 둔다.
 *
 * 이 파일은 런타임 의존성이 없다(브라우저 전역만 사용) — 어느 클라이언트 컴포넌트에서
 * import해도 안전하다. 외부 API 호출도, 비용도 없다.
 */

/** 발음 언어 — 영어 원서용이므로 미국식 고정 */
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

/**
 * 이 브라우저가 발음 재생을 지원하는가.
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

/**
 * 한 덩어리의 영어 텍스트를 읽는다.
 * 이전 재생을 취소하고 새로 시작한다 — 아이가 🔊를 연타해도 말이 겹치지 않는다.
 * 지원하지 않는 환경에서는 조용히 아무것도 하지 않는다(에러를 던지지 않는다).
 */
export function speak(text: string): void {
  if (!isSpeechSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = TTS_LANG;
  utterance.rate = getTtsRate();
  window.speechSynthesis.speak(utterance);
}

/**
 * 단어 여러 개를 **한 문장처럼** 이어 읽는다.
 *
 * ⚠️ utterance를 쪼개지 마라. `["fix","the","door"]`는 utterance 3개가 아니라
 * `speak("fix the door")` **1개**다. 큐에 N개를 넣으면 단어 경계마다 끊겨
 * 로봇처럼 들린다 — 공백으로 이어 붙여야 연음이 살아 "문장"으로 들린다.
 * 아이가 따라 말하는 대상은 단어의 나열이 아니라 문장이다.
 */
export function speakSequence(words: string[]): void {
  const sentence = words.join(" ").trim();
  if (!sentence) return;
  speak(sentence);
}

/** 재생 중인 발음을 멈춘다 (화면 이탈·다음 문제로 넘어갈 때) */
export function stopSpeaking(): void {
  if (!isSpeechSupported()) return;
  window.speechSynthesis.cancel();
}

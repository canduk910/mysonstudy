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

/** 재생 속도 — 1.0은 아이가 따라 하기에 빠르다. 0.9가 카드 화면에서 쓰던 값이다 */
export const TTS_RATE = 0.9;

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
  utterance.rate = TTS_RATE;
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

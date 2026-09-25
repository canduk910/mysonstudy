/**
 * lib/toeic-audio-cue.ts — 모의고사 응시 화면의 **오디오 신호**(AudioContext 싱글턴·답변 시작 비프) — 클라이언트 전용
 * (docs/harness/toeic.md §6-4·§10)
 *
 * 운동 세션(components/workout-session.tsx)의 비프 관용구를 **따라 새로** 쓴다 — 운동 코드는 import하지도 고치지도 않는다
 * (§10: 실기기 검증이 끝난 경로라 회귀 위험을 지지 않는다).
 * - 컨텍스트는 **모듈 싱글턴**(iOS는 컨텍스트 개수 제한이 있어 응시마다 새로 만들지 않는다). **탭 핸들러 안에서 동기로**
 *   ensureToeicAudio()를 불러 만들거나 resume()한다(iOS는 제스처 밖 오디오를 막는다).
 * - 비프는 준비 종료 시각에 **미리 예약**한다(`ctx.currentTime + (endsAt − now)/1000`) — 타이머 콜백(탭 밖) 재생 제약을 피한다.
 *   예약분이 안 울렸으면(컨텍스트가 멈춰 있었다) 응시 화면이 지금 울린다. 취소는 disconnect(연결 끊기)로 한다.
 * - 같은 컨텍스트를 녹음 레벨 미터(lib/mic-session.ts의 AnalyserNode)도 쓴다.
 *
 * 비프 모양: 실제 시험처럼 "삐—" 한 번(1kHz · 약 0.45초). 운동의 3연음과 다르다.
 * ⚠️ 무음 스위치: Web Audio는 iOS 기본 세션(ambient)에서 무음 스위치에 음소거된다 — 응시 화면이 시작 탭에서
 * `navigator.audioSession.type = "playback"`(lib/mic-session.ts setAudioSessionPlayback)을 걸어 둔다. 실기기 확인 항목.
 */

let ctx: AudioContext | null = null;

/** 비프 길이(초) — 응시 화면이 비프 뒤 이만큼 기다렸다가 녹음을 연다(재생과 캡처를 겹치지 않는다, §6-4) */
export const TOEIC_BEEP_SEC = 0.5;
/** 비프 높이(Hz) */
export const TOEIC_BEEP_HZ = 1000;

/**
 * **탭 핸들러 안에서 동기로** 부른다 — AudioContext를 만들거나 resume()한다. 실패해도 조용히 null(비프는 best-effort,
 * 시계는 종료 시각 타이머가 기준이다).
 */
export function ensureToeicAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** 이미 만든 컨텍스트(없으면 null) — 탭 밖에서 새로 만들지 않는다 */
export function getToeicAudioContext(): AudioContext | null {
  return ctx;
}

/** visible 복귀 등 — 멈춘 컨텍스트를 깨워 둔다(이미 탭으로 풀린 컨텍스트라 대개 허용된다) */
export function resumeToeicAudio(): void {
  if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
}

/** "삐—" 한 번을 컨텍스트 시각 at(초)에 예약한다. 예약한 노드를 돌려준다(취소용). */
export function scheduleToeicBeep(c: AudioContext, at: number): OscillatorNode[] {
  try {
    const t0 = Math.max(at, c.currentTime);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = TOEIC_BEEP_HZ;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
    gain.gain.setValueAtTime(0.35, t0 + 0.38);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.47);
    return [osc];
  } catch {
    return []; // 비프는 best-effort
  }
}

/** 예약한 비프를 무음 처리한다 — 연결을 끊으면 예약돼 있어도 소리가 나지 않는다(stop 재호출은 브라우저마다 던질 수 있다). */
export function cancelToeicBeep(nodes: readonly OscillatorNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* noop */
    }
  }
}

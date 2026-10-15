/**
 * lib/workout-lockscreen.ts — 🔒 잠금화면 휴식 타이머(실험, SPEC §19-9 B). 클라이언트 전용(모듈 최상위에서 브라우저 전역을 읽지 않는다).
 *
 * 생각: 웹앱은 라이브 액티비티·상태막대를 못 쓰지만, **재생 중인 미디어**는 iOS 잠금 화면·다이나믹 아일랜드의 "지금 재생 중"에
 * 진행 막대와 남은 시간이 뜬다. 휴식 길이와 똑같은 길이의 **무음 WAV**를 `<audio>`로 틀고 Media Session 정보(제목 "휴식 · 다음 3세트",
 * 부제 "풀업 7 → 푸시업 10")와 `setPositionState`를 맞추면 iOS가 남은 시간을 스스로 그린다. 듣던 음악은 멈춘다(오디오 세션을 가져간다).
 *
 * 규약
 * - `start`·`update`는 **탭 핸들러 안에서 동기로** 부른다(첫 play()가 사용자 동작 안이어야 iOS가 허락한다). 같은 요소를 계속 쓰므로
 *   한 번 탭으로 풀린 뒤의 `resume()`(탭 밖 — 음성 안내가 끝난 뒤)도 대개 허락된다(실기기 미검증).
 * - **음성 안내·비프와의 순서**: 휴식을 시작하는 ✓ 탭은 이 무음을 **먼저** 틀고 음성 안내를 **나중에** 시작한다 — iOS가 한 번에
 *   하나만 재생하게 하더라도 밀려나는 쪽이 무음이지 안내가 아니게. 안내가 끝나면(speakQueue onEnd) `resume()`이 무음을 다시 틀고
 *   진행 막대를 다시 맞춘다. 무음 쪽에서 안내 요소를 멈추는 일은 하지 않는다. 비프는 Web Audio라 미디어 요소와 별개다.
 * - 잠금 화면 버튼(⏭ 등)은 걸지 않는다 — 탭 밖 건너뛰기는 음성 안내 재생 허락·연타 가드와 얽힌다(생략, §19-9).
 * - 끝(휴식 끝·건너뛰기·세션 닫기·토글 끔)에는 `stop()` — 정지·src 비우기·blob URL 해제·Media Session 정보 해제.
 */

import { bindMediaSession, setMediaSessionPlaybackState, setMediaSessionPositionState } from "./media-session";

/** 토글 저장 키 — 값 "on"일 때만 켠다(기본 끔) */
export const LOCKSCREEN_TIMER_KEY = "workout-lockscreen:v1";
/** 무음 WAV 표본율 — 8kHz 8비트 모노(1초 8KB, 3분 1.4MB). iOS가 재생하는 가장 낮은 흔한 표본율 */
export const SILENT_WAV_RATE = 8000;
/** 무음 길이 상한(초) — 예약 상한(15분)과 같게. 이보다 길면 잘라 만든다 */
export const SILENT_WAV_MAX_SEC = 15 * 60;

export function readLockscreenPref(): boolean {
  try {
    return window.localStorage.getItem(LOCKSCREEN_TIMER_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeLockscreenPref(on: boolean): void {
  try {
    window.localStorage.setItem(LOCKSCREEN_TIMER_KEY, on ? "on" : "off");
  } catch {
    /* noop */
  }
}

/**
 * 무음 WAV 바이트(순수 — eval이 머리말을 본다). 8비트 PCM 무음은 0x80. 길이는 1초 이상·상한 이하 정수 초로 맞춘다.
 */
export function silentWavBytes(seconds: number): Uint8Array {
  const sec = Math.min(SILENT_WAV_MAX_SEC, Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 1)));
  const n = sec * SILENT_WAV_RATE;
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + n, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt 청크 크기
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // 모노
  dv.setUint32(24, SILENT_WAV_RATE, true);
  dv.setUint32(28, SILENT_WAV_RATE, true); // byte rate = rate × 1 × 1
  dv.setUint16(32, 1, true); // block align
  dv.setUint16(34, 8, true); // 비트
  ascii(36, "data");
  dv.setUint32(40, n, true);
  buf.fill(0x80, 44);
  return buf;
}

export interface LockscreenRest {
  /** 휴식을 시작한 시각(epoch ms) — 진행 막대의 0 */
  startMs: number;
  /** 휴식 끝(epoch ms) */
  endsAt: number;
  title: string;
  artist: string;
}

export interface LockscreenTimer {
  /** 탭 안에서 — 휴식 길이만큼 무음을 만들고 튼다(이미 돌고 있으면 바꿔 튼다) */
  start(rest: LockscreenRest): void;
  /** 탭 안에서 — 끝 시각이 바뀌었다(2분/3분·+30초) */
  update(endsAt: number): void;
  /** 음성 안내가 끝난 뒤 — 밀려났으면 다시 틀고 진행 막대를 맞춘다. 휴식이 끝났으면 아무것도 안 한다 */
  resume(): void;
  stop(): void;
  isActive(): boolean;
}

export function createLockscreenTimer(): LockscreenTimer {
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let unbind: (() => void) | null = null;
  let cur: LockscreenRest | null = null;
  let seekOnLoad: (() => void) | null = null;

  const position = () => {
    if (!cur) return;
    setMediaSessionPositionState({ duration: (cur.endsAt - cur.startMs) / 1000, position: (Date.now() - cur.startMs) / 1000, playbackRate: 1 });
    setMediaSessionPlaybackState("playing");
  };

  const release = () => {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      url = null;
    }
  };

  const load = (rest: LockscreenRest) => {
    try {
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        audio.loop = false;
        audio.setAttribute("playsinline", "");
      }
      const a = audio;
      if (seekOnLoad) a.removeEventListener("loadedmetadata", seekOnLoad);
      release();
      const bytes = silentWavBytes((rest.endsAt - rest.startMs) / 1000);
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" }));
      seekOnLoad = () => {
        try {
          if (cur) a.currentTime = Math.max(0, (Date.now() - cur.startMs) / 1000);
        } catch {
          /* noop */
        }
        position();
      };
      a.addEventListener("loadedmetadata", seekOnLoad, { once: true });
      a.src = url;
      void a.play().catch(() => {});
    } catch {
      /* best-effort */
    }
  };

  return {
    start(rest) {
      cur = { ...rest };
      load(cur);
      unbind?.();
      unbind = bindMediaSession({ title: rest.title, artist: rest.artist, album: "💪 아빠의 운동", actions: {} });
      position();
    },
    update(endsAt) {
      if (!cur || endsAt === cur.endsAt) return;
      cur = { ...cur, endsAt };
      load(cur);
      position();
    },
    resume() {
      if (!cur || !audio) return;
      if (Date.now() >= cur.endsAt) return;
      try {
        if (audio.paused) void audio.play().catch(() => {});
      } catch {
        /* noop */
      }
      position();
    },
    stop() {
      cur = null;
      if (audio) {
        try {
          if (seekOnLoad) audio.removeEventListener("loadedmetadata", seekOnLoad);
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        } catch {
          /* noop */
        }
      }
      seekOnLoad = null;
      release();
      setMediaSessionPositionState(null);
      unbind?.();
      unbind = null;
    },
    isActive() {
      return cur !== null;
    },
  };
}

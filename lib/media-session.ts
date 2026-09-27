/**
 * lib/media-session.ts — 잠금 화면 조작(Media Session ⏯·⏭·⏮)을 **켜고 싶은 플레이어만** 켜는 얇은 관문
 *
 * 왜 따로 두는가(`docs/harness/toeic.md` §12-5-2): 발음 큐(`lib/speech.ts`)는 Media Session을 **걸지 않는다**. 표현집 전체 듣기·
 * 해설 낭독·응시 질문 음성·운동 안내 같은 기존 화면에서는 잠금 화면 ⏸가 지금처럼 **정지**여야 한다(큐 요소에 우리가 일으키지 않은
 * pause가 오면 "stopped" — SPEC §18-2). 핸들러를 걸면 브라우저가 ⏸를 요소에 직접 보내지 않고 핸들러를 부르므로, 걸지 않은 화면의
 * 동작은 한 줄도 바뀌지 않는다. 템플릿 따라 말하기 플레이어처럼 "멈추고 이어 듣기·다음 예문"이 필요한 화면만 이 함수로 켠다.
 *
 * 규약
 * - 재생을 시작할 때 `bindMediaSession(...)`, 멈추거나 화면을 떠날 때 돌려받은 함수를 부른다(`useEffect` cleanup). 푸는 함수는
 *   **자기가 건 바인딩일 때만** 푼다 — 뒤에 건 바인딩(다른 플레이어·다시 건 같은 플레이어)을 지우지 않는다.
 * - 핸들러 안에서는 탭 핸들러와 같은 규칙을 따른다(큐를 멈출 때는 큐가 돌려준 stop). 핸들러 예외는 삼킨다.
 * - 지원하지 않는 브라우저·동작(`setActionHandler`가 던짐)은 조용히 넘어간다(best-effort). 런타임 import 0 — 클라이언트 번들 안전.
 */

/** 이 모듈이 다루는 잠금 화면 동작. */
export type MediaSessionActionName = "play" | "pause" | "nexttrack" | "previoustrack" | "stop";

/** 잠금 화면에 보일 정보와 동작 핸들러. 비워 둔 동작은 걸지 않는다(브라우저 기본 동작). */
export interface MediaSessionBinding {
  /** 제목(예: "틀 따라 말하기") */
  title: string;
  /** 부제(예: 유형 이름 · 묶음 이름) */
  artist?: string;
  album?: string;
  actions: Partial<Record<MediaSessionActionName, () => void>>;
}

const ACTIONS: readonly MediaSessionActionName[] = ["play", "pause", "nexttrack", "previoustrack", "stop"];

/** 지금 걸려 있는 바인딩의 번호(0 = 없음). 푸는 함수가 자기 번호일 때만 푼다. */
let activeBinding = 0;
let bindingSeq = 0;

function getSession(): MediaSession | null {
  try {
    if (typeof navigator === "undefined") return null;
    return (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession ?? null;
  } catch {
    return null;
  }
}

function clearHandlers(ms: MediaSession): void {
  for (const a of ACTIONS) {
    try {
      ms.setActionHandler(a, null);
    } catch {
      /* 지원하지 않는 동작 */
    }
  }
}

/** 이 브라우저에 Media Session이 있는가(마운트 후에 부른다 — 렌더 중 호출은 hydration mismatch). */
export function isMediaSessionSupported(): boolean {
  return getSession() !== null;
}

/**
 * 잠금 화면 정보·핸들러를 건다(앞 바인딩의 핸들러는 먼저 뗀다). 돌려받은 함수를 부르면 **그 바인딩이 아직 걸려 있을 때만**
 * 핸들러·정보를 모두 null로 푼다. 지원하지 않으면 아무것도 하지 않는 함수를 돌려준다.
 */
export function bindMediaSession(binding: MediaSessionBinding): () => void {
  const ms = getSession();
  if (!ms) return () => {};
  const id = ++bindingSeq;
  clearHandlers(ms);
  activeBinding = id;
  try {
    if (typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({ title: binding.title, artist: binding.artist ?? "", album: binding.album ?? "" });
    }
  } catch {
    /* 정보 없이도 핸들러는 건다 */
  }
  for (const a of ACTIONS) {
    const fn = binding.actions[a];
    if (!fn) continue;
    try {
      ms.setActionHandler(a, () => {
        try {
          fn();
        } catch {
          /* 핸들러 예외는 삼킨다 */
        }
      });
    } catch {
      /* 이 동작은 지원하지 않는다 */
    }
  }
  return () => {
    if (activeBinding !== id) return; // 뒤에 건 바인딩을 지우지 않는다
    activeBinding = 0;
    clearHandlers(ms);
    try {
      ms.metadata = null;
    } catch {
      /* noop */
    }
    try {
      ms.playbackState = "none";
    } catch {
      /* noop */
    }
  };
}

/** 잠금 화면의 재생 상태 표시(⏯ 모양)를 맞춘다. 지원하지 않으면 조용히 넘어간다. */
export function setMediaSessionPlaybackState(state: "none" | "paused" | "playing"): void {
  const ms = getSession();
  if (!ms) return;
  try {
    ms.playbackState = state;
  } catch {
    /* noop */
  }
}

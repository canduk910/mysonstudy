/**
 * lib/talk-level-meter.ts — 자유대화 **기기 레벨 미터**(클라이언트 전용) (docs/harness/english.md §12-1 "끼어들기 판정")
 *
 * 선생님 소리가 나는 동안 서버로 가는 마이크 트랙은 꺼진다(반이중 — lib/talk-barge-in.ts). 그동안에도 은우가 진짜로 말하는지 알려고
 * **같은 마이크의 복제 트랙**(`track.clone()` — 서버로 보내지 않는다, enabled가 원본과 따로다)을 Web Audio `AnalyserNode`로 듣고
 * 약 TALK_LEVEL_POLL_MS(40ms)마다 RMS dBFS(`talkRmsDbfs`)를 넘긴다. getUserMedia가 echoCancellation·noiseSuppression·
 * autoGainControl을 켜고 잡은 트랙이므로(lib/mic-session.ts) 복제도 에코가 줄어든 신호다.
 *
 * - AudioContext는 📞 탭 안에서 동기로 만든다(`createTalkLevelContext` — iOS Safari는 탭 밖에서 만든 컨텍스트가 suspended로 남는다).
 *   주인은 컨트롤러다 — 대화가 끝나면(`end` — 숨김·뒤로가기·pagehide·끝내기 전부) 미터를 멈추고 컨텍스트를 닫는다.
 * - 그래프는 source → analyser 뿐이다(destination에 잇지 않는다 — 되울림 방지, 토익 레벨 미터와 같은 관용구).
 * - 실패(컨텍스트 없음·복제 실패·노드 생성 실패)는 던지지 않고 꺼진 미터(`offReason`)를 돌려준다 — 그러면 끼어들기 판정이 없고
 *   선생님은 자기 차례를 끝까지 말한다(마이크는 여전히 재생 중 닫힌다 — 짧은 소리로 끊기는 것보다 낫다). 결과 "진단"에 이유가 보인다.
 *
 * ⚠️ 모듈 최상위에서 window·AudioContext를 읽지 않는다(SSR·eval import 안전). 런타임 import는 순수 모듈 talk-barge-in뿐.
 */

import { talkRmsDbfs } from "./talk-barge-in";

/** 레벨을 읽는 간격(ms) — 판정 정밀도(±이 값)와 CPU 사이 */
export const TALK_LEVEL_POLL_MS = 40;
/** 분석 창 표본 수 — 48kHz에서 약 43ms(읽는 간격을 덮는다) */
export const TALK_LEVEL_FFT_SIZE = 2048;

export interface TalkLevelMeter {
  /** 꺼진 미터의 이유(켜져 있으면 null) — 결과 "진단" */
  readonly offReason: string | null;
  /** 프레임마다 (시각 epoch ms, dBFS) — 여러 번 불러도 한 번만 시작 */
  start(onFrame: (now: number, db: number) => void): void;
  /** 멈춤(멱등) — 타이머·노드·복제 트랙 정리. 컨텍스트는 닫지 않는다(주인은 컨트롤러) */
  stop(): void;
}

/** 꺼진 미터 */
export function offTalkLevelMeter(reason: string): TalkLevelMeter {
  return { offReason: reason, start() {}, stop() {} };
}

type AudioContextCtor = new () => AudioContext;

/**
 * 📞 탭 안에서 **동기로** 부른다 — 레벨 미터용 AudioContext. 못 만들면 null(끼어들기 판정 없이 대화는 그대로).
 * resume()도 탭 안에서 걸어 둔다(만들 때 suspended인 브라우저).
 */
export function createTalkLevelContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** 컨텍스트 닫기(멱등·조용히) */
export function closeTalkLevelContext(ctx: AudioContext | null | undefined): void {
  if (!ctx || ctx.state === "closed") return;
  try {
    void ctx.close().catch(() => {});
  } catch {
    /* noop */
  }
}

/**
 * 마이크 트랙의 복제로 레벨 미터를 만든다. 복제를 쓰는 이유: 서버로 가는 원본 트랙을 `enabled = false`로 끄면 그 트랙으로 만든
 * Web Audio 소스도 무음이 된다 — 복제는 enabled가 따로라 재생 중에도 들린다.
 */
export function createTalkLevelMeter(track: MediaStreamTrack | null, ctx: AudioContext | null): TalkLevelMeter {
  if (!track) return offTalkLevelMeter("마이크 트랙 없음");
  if (!ctx) return offTalkLevelMeter("오디오 컨텍스트 없음");
  if (typeof MediaStream === "undefined") return offTalkLevelMeter("MediaStream 없음");
  let clone: MediaStreamTrack;
  try {
    clone = track.clone();
  } catch {
    return offTalkLevelMeter("마이크 복제 실패");
  }
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = ctx.createMediaStreamSource(new MediaStream([clone]));
    analyser = ctx.createAnalyser();
    analyser.fftSize = TALK_LEVEL_FFT_SIZE;
    source.connect(analyser); // destination에는 잇지 않는다 — 되울림 방지
  } catch {
    try {
      clone.stop();
    } catch {
      /* noop */
    }
    return offTalkLevelMeter("분석 노드 생성 실패");
  }
  const floatBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  const byteBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  const hasFloat = typeof analyser.getFloatTimeDomainData === "function";
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const read = (): number => {
    if (hasFloat) {
      analyser.getFloatTimeDomainData(floatBuf);
      return talkRmsDbfs(floatBuf);
    }
    analyser.getByteTimeDomainData(byteBuf);
    for (let i = 0; i < byteBuf.length; i++) floatBuf[i] = (byteBuf[i] - 128) / 128;
    return talkRmsDbfs(floatBuf.subarray(0, byteBuf.length));
  };

  return {
    offReason: null,
    start(onFrame) {
      if (stopped || timer !== null) return;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      timer = setInterval(() => {
        if (stopped) return;
        let db: number;
        try {
          db = read();
        } catch {
          return;
        }
        onFrame(Date.now(), db);
      }, TALK_LEVEL_POLL_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
      try {
        clone.stop();
      } catch {
        /* noop */
      }
    },
  };
}

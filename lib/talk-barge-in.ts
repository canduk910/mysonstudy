/**
 * lib/talk-barge-in.ts — 자유대화 **반이중(half-duplex) 마이크 관문 + 기기 안 끼어들기 판정** 순수 상태 기계
 * (docs/harness/english.md §12-1 "끼어들기 판정", SPEC §21-1·§21-5 13)
 *
 * 왜(2026-10-03 두 번째 수정): 처음엔 세션을 `interrupt_response: false`로 두고 서버 말소리 이벤트(`speech_started`~`speech_stopped`)로
 * 700ms를 쟀다. 그런데 실연결 진단에서 서버가 그 설정을 **적용했는데도** 선생님 소리 재생 중 은우의 짧은 "Um."이
 * `input_audio_buffer.speech_started`로 잡히자 3ms 뒤 스스로 `output_audio_buffer.cleared` + `conversation.item.truncated`를 냈다
 * (앱은 아무것도 보내지 않음). WebRTC에서는 그 플래그로 서버의 재생 자르기를 막지 못한다 — 서버가 선생님 재생 중에 말소리를
 * **듣지 못하게** 해야 한다.
 *
 * 규칙(§12-1):
 * - **반이중**: 선생님 소리가 나는 중(`output_audio_buffer.started` ~ 같은 응답의 `stopped`/`cleared`)에는 서버로 가는 마이크 트랙을
 *   끈다(`micOpen = false` → 컨트롤러가 `track.enabled = false` — 무음 프레임). 재생이 끝나면 켠다.
 * - **기기 안 판정**: 같은 마이크의 복제 트랙(서버로 안 보낸다)을 기기에서 듣는다(`level` 이벤트 — RMS dBFS, 컨트롤러의 레벨 미터가
 *   약 40ms마다 넣는다). 문턱 이상인 소리가 **덩어리 안에서 합계 700ms**(TALK_BARGE_IN_MIN_MS) 쌓이면 진짜 끼어들기 → `cut_teacher`
 *   (진행 중 응답이 있으면 `response.cancel` + `output_audio_buffer.clear`, 생성이 끝나 소리만 남았으면 clear만) + 마이크를 켠다(그때부터
 *   은우 말이 서버 VAD로 간다). 덩어리는 문턱 아래가 TALK_BARGE_IN_GAP_MS(250ms) 넘게 이어지면 끝난다 — 그 전에 700ms를 못 채운
 *   덩어리는 **짧은 소리**("음"·맞장구·기침·잔향)라 선생님은 그대로다.
 * - **적응형 문턱**: 선생님이 말하지 않는 동안의 소음 바닥(`floorDb` — 빨리 내려가고 천천히 올라가는 추적, 디지털 무음은 건너뜀)을 재생이 시작될 때 얼려
 *   문턱 = max(TALK_BARGE_IN_MIN_THRESHOLD_DB(-45 dBFS), 바닥 + TALK_BARGE_IN_MARGIN_DB(15 dB))로 정한다. 재생 중에는 바닥을 고치지
 *   않는다(새어 든 선생님 소리가 바닥을 끌어올리지 않게).
 * - **닫힌 동안 끝난 서버 말소리**: 재생 전에 서버가 이미 듣기 시작한 말이 재생 중(마이크 닫힘)에 끝나면 서버는 그 조각을 커밋해 자동
 *   응답을 만들 수 있다 — 지금 선생님 말 뒤에 그 조각에 대한 대답이 이어지면 "선생님 두 명"(§12-7)이다. 그래서 그 `speech_stopped`부터
 *   replyWaitMs(1.5초) 안에 앱이 청하지 않은 `response.created`가 오면 그 응답만 취소한다(`cancel_reply` → `response.cancel
 *   {response_id}`, 소리 비우기 없음). 한 번에 한 번, 새 말소리가 시작되면 거둔다.
 * - **응답 id**(QA cutoff_2 P3-B): 재생 중인 응답과 다른 id의 `stopped`/`cleared`(늦게 온 앞 응답의 것)는 무시한다 — 그대로 받으면
 *   다음 응답 재생 중에 마이크가 열려 서버가 다시 자른다.
 * - 한 재생에서 끊기는 한 번이다(끊은 뒤에는 그 재생이 끝날 때까지 판정하지 않는다).
 *
 * 시계는 인자로 받는다(`now`, ms) — 같은 이벤트 열이면 늘 같은 결과(eval이 가상 시계로 돌린다). 700ms·250ms·1.5초는 개발 시간
 * 배율을 곱하지 않는다(말소리 길이·서버 지연이라 대화 규칙이 아니다). 어느 단계(live·wrapping)에서 동작을 실행할지는 컨트롤러가 정한다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0(타입만).
 */

import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";

/** 선생님 소리 위에서 은우 소리가 덩어리 안 합계로 이만큼 쌓이면 진짜 끼어들기(ms, §12-1) */
export const TALK_BARGE_IN_MIN_MS = 700;
/** 문턱 아래가 이보다 길게 이어지면 소리 덩어리가 끝난다(ms) — 말 속 음절 사이 틈은 이어 보고, "음 … 어"처럼 떨어진 소리는 가른다 */
export const TALK_BARGE_IN_GAP_MS = 250;
/** 끼어들기 문턱의 하한(dBFS) — 조용한 방에서도 이보다 작은 소리(새어 든 잔향·먼 소리)는 말로 보지 않는다 */
export const TALK_BARGE_IN_MIN_THRESHOLD_DB = -45;
/** 소음 바닥 위 여유(dB) — 문턱 = max(하한, 바닥 + 여유) */
export const TALK_BARGE_IN_MARGIN_DB = 15;
/** 음량 계산의 바닥(dBFS) — 완전 무음(0)은 이 값 */
export const TALK_LEVEL_SILENCE_DB = -100;
/** 한 프레임이 셀 수 있는 최대 시간(ms) — 타이머가 멈췄다 돌아와도 그 공백을 소리로 세지 않는다 */
export const TALK_LEVEL_FRAME_MAX_MS = 120;
/** 소음 바닥이 올라가는 시간 상수(ms) — 지금 문턱 아래 소리(주변 소음이 커짐) */
export const TALK_NOISE_FLOOR_RISE_MS = 2_000;
/** 소음 바닥이 올라가는 시간 상수(ms) — 문턱 이상의 큰 소리(대개 말소리 — 아주 천천히, 계속 크면 결국 따라간다) */
export const TALK_NOISE_FLOOR_LOUD_RISE_MS = 20_000;
/** 소음 바닥이 내려가는 비율(프레임마다, 0~1) — 조용해지면 빨리 따라 내려간다 */
export const TALK_NOISE_FLOOR_FALL = 0.3;
/** 진단에 남기는 최근 소리 덩어리 수 */
export const TALK_BARGE_IN_RECENT_MAX = 8;

export interface TalkBargeInConfig {
  /** 끼어들기 판정 — 덩어리 안 소리 합계(ms) */
  minMs: number;
  /** 덩어리를 끊는 조용한 틈(ms) */
  gapMs: number;
  /** 닫힌 동안 끝난 서버 말소리의 자동 응답을 기다리는 상한(ms) — 컨트롤러의 TALK_AUTO_REPLY_WAIT_MS를 넘긴다(같은 상수) */
  replyWaitMs: number;
  minThresholdDb: number;
  marginDb: number;
}

/** 재생 중 소리 덩어리 하나(진단) */
export interface TalkSoundSample {
  /** 문턱 이상이던 시간 합계(ms) */
  voicedMs: number;
  /** 덩어리 처음 ~ 마지막 큰 소리(ms) */
  spanMs: number;
  /** 덩어리 최대 음량(dBFS, 정수) */
  peakDb: number;
  /** 이 덩어리로 선생님을 멈췄다 */
  cut: boolean;
}

export interface TalkBargeInStats {
  /** 마이크를 닫은 선생님 재생 수 */
  playbacks: number;
  /** 기기 판정 끼어들기(700ms 넘게 말해 선생님을 멈춤) */
  bargeIns: number;
  /** 재생 중 문턱을 넘었지만 700ms를 못 채운 소리 덩어리 */
  shortSounds: number;
  /** 마이크가 닫힌 동안 끝난 서버 말소리의 자동 응답을 앱이 취소한 횟수 */
  repliesCancelled: number;
  /** 마지막 재생의 문턱(dBFS, 정수) */
  thresholdDb: number | null;
  /** 마지막 재생이 시작될 때의 소음 바닥(dBFS, 정수) */
  floorDb: number | null;
  /** 끊지 않고 끝난 재생 중 최대 음량(dBFS, 정수) — 새어 든 선생님 소리·주변 소리·짧은 소리의 크기(문턱을 고르는 근거) */
  quietPeakDb: number | null;
  /** 최근 재생 중 소리 덩어리(오래된 것부터, 최대 TALK_BARGE_IN_RECENT_MAX) */
  recent: readonly TalkSoundSample[];
}

export interface TalkBargeInState {
  config: TalkBargeInConfig;
  teacherPlaying: boolean;
  /** 재생 중인 응답 id(모르면 null) */
  playingResponseId: string | null;
  /** 서버로 가는 마이크 트랙을 켤 것인가(재생 중 false, 끼어들기·재생 끝에 true) */
  micOpen: boolean;
  /** 소음 바닥(dBFS) — 첫 프레임 전 null */
  floorDb: number | null;
  /** 이번 재생의 문턱(재생 시작 때 얼린다) */
  thresholdDb: number | null;
  lastFrameAt: number | null;
  /** 지금 소리 덩어리(재생 중에만) */
  run: { startedAt: number; voicedMs: number; lastLoudAt: number; peakDb: number } | null;
  /** 이번 재생을 이미 끊었다 */
  cut: boolean;
  /** 이번 재생 중 최대 음량 */
  playbackPeakDb: number | null;
  /** 닫힌 동안 끝난 서버 말소리 뒤 자동 응답을 취소할 기한(이 시각까지 온 response.created). 없으면 null */
  suppressUntil: number | null;
  stats: TalkBargeInStats;
}

export type TalkBargeInEvent =
  | { type: "teacher_audio_started"; now: number; responseId: string | null }
  /** output_audio_buffer.stopped·cleared */
  | { type: "teacher_audio_stopped"; now: number; responseId: string | null }
  /** 기기 레벨 미터 한 프레임 — responseActive = cut이 response.cancel을 보낼지(진행 중 응답이 실제로 있다) */
  | { type: "level"; now: number; db: number; responseActive: boolean }
  /** 서버 말소리(input_audio_buffer.speech_started·stopped) — 닫힌 동안 끝난 말의 자동 응답 취소에만 쓴다 */
  | { type: "child_speech_started"; now: number }
  | { type: "child_speech_stopped"; now: number }
  /** requestedByApp = 앱이 보낸 response.create의 응답(첫 인사·도움 요청·마무리) */
  | { type: "response_created"; now: number; responseId: string | null; requestedByApp: boolean }
  | { type: "tick"; now: number };

export type TalkBargeInAction =
  /** 선생님을 멈춘다 — cancelResponse면 response.cancel 뒤 output_audio_buffer.clear, 아니면 clear만 */
  | { type: "cut_teacher"; cancelResponse: boolean }
  /** 닫힌 동안 끝난 서버 말소리에 대한 자동 응답만 취소(response.cancel {response_id}) — 소리 비우기 없음 */
  | { type: "cancel_reply"; responseId: string | null };

export interface TalkBargeInStep {
  state: TalkBargeInState;
  actions: readonly TalkBargeInAction[];
}

// ---------------------------------------------------------------------------
// 음량·문턱 — 순수 함수
// ---------------------------------------------------------------------------

/** 표본(−1~1)의 RMS를 dBFS로(무음·빈 배열은 TALK_LEVEL_SILENCE_DB). 사인파 진폭 1 = −3.01 dBFS */
export function talkRmsDbfs(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return TALK_LEVEL_SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (!(rms > 0)) return TALK_LEVEL_SILENCE_DB;
  return Math.max(TALK_LEVEL_SILENCE_DB, 20 * Math.log10(rms));
}

/**
 * 소음 바닥 추적 한 걸음(선생님이 말하지 않는 동안만 부른다). 완전 무음(디지털 0 — 트랙이 막 열릴 때 등)은 방의 소리가 아니라서
 * 건너뛴다. 첫 프레임은 그 값 그대로. 바닥보다 작으면 빨리 내려가고(TALK_NOISE_FLOOR_FALL), 지금 문턱(max(하한, 바닥 + 여유)) 아래면
 * TALK_NOISE_FLOOR_RISE_MS로, 문턱 이상(대개 말소리)이면 TALK_NOISE_FLOOR_LOUD_RISE_MS로 천천히 올라간다. 범위는 [TALK_LEVEL_SILENCE_DB, 0].
 */
export function updateTalkNoiseFloor(
  floorDb: number | null,
  db: number,
  dtMs: number,
  minThresholdDb: number = TALK_BARGE_IN_MIN_THRESHOLD_DB,
  marginDb: number = TALK_BARGE_IN_MARGIN_DB,
): number | null {
  if (!Number.isFinite(db) || db <= TALK_LEVEL_SILENCE_DB + 0.5) return floorDb; // 디지털 무음 — 바닥을 끌어내리지 않는다
  const x = Math.min(0, db);
  if (floorDb === null) return x;
  let next: number;
  if (x < floorDb) next = floorDb + (x - floorDb) * TALK_NOISE_FLOOR_FALL;
  else {
    const tau = x < talkBargeInThresholdDb(floorDb, minThresholdDb, marginDb) ? TALK_NOISE_FLOOR_RISE_MS : TALK_NOISE_FLOOR_LOUD_RISE_MS;
    const a = Math.min(1, Math.max(0, dtMs) / tau);
    next = floorDb + (x - floorDb) * a;
  }
  return Math.min(0, Math.max(TALK_LEVEL_SILENCE_DB, next));
}

/** 끼어들기 문턱 = max(하한, 바닥 + 여유). 바닥을 아직 모르면 하한 */
export function talkBargeInThresholdDb(
  floorDb: number | null,
  minThresholdDb: number = TALK_BARGE_IN_MIN_THRESHOLD_DB,
  marginDb: number = TALK_BARGE_IN_MARGIN_DB,
): number {
  if (floorDb === null) return minThresholdDb;
  return Math.max(minThresholdDb, floorDb + marginDb);
}

// ---------------------------------------------------------------------------
// 상태 기계
// ---------------------------------------------------------------------------

/** 대화 시작 상태 — 마이크는 열려 있다 */
export function createTalkBargeIn(config: Partial<TalkBargeInConfig> & Pick<TalkBargeInConfig, "replyWaitMs">): TalkBargeInState {
  return {
    config: {
      minMs: config.minMs ?? TALK_BARGE_IN_MIN_MS,
      gapMs: config.gapMs ?? TALK_BARGE_IN_GAP_MS,
      replyWaitMs: config.replyWaitMs,
      minThresholdDb: config.minThresholdDb ?? TALK_BARGE_IN_MIN_THRESHOLD_DB,
      marginDb: config.marginDb ?? TALK_BARGE_IN_MARGIN_DB,
    },
    teacherPlaying: false,
    playingResponseId: null,
    micOpen: true,
    floorDb: null,
    thresholdDb: null,
    lastFrameAt: null,
    run: null,
    cut: false,
    playbackPeakDb: null,
    suppressUntil: null,
    stats: { playbacks: 0, bargeIns: 0, shortSounds: 0, repliesCancelled: 0, thresholdDb: null, floorDb: null, quietPeakDb: null, recent: [] },
  };
}

const NO_ACTIONS: readonly TalkBargeInAction[] = [];
const roundDb = (db: number) => Math.round(db);

function pushRecent(stats: TalkBargeInStats, sample: TalkSoundSample): TalkBargeInStats {
  return { ...stats, recent: [...stats.recent, sample].slice(-TALK_BARGE_IN_RECENT_MAX) };
}

/** 이벤트 하나를 접는다(순수). 바뀐 게 없으면 같은 상태 객체를 돌려준다(level은 시각을 적으므로 늘 새 객체). */
export function reduceTalkBargeIn(s: TalkBargeInState, ev: TalkBargeInEvent): TalkBargeInStep {
  const now = ev.now;
  switch (ev.type) {
    case "teacher_audio_started": {
      // 같은 응답의 started가 또 왔다(중복) — 그대로
      if (s.teacherPlaying && (ev.responseId === null || ev.responseId === s.playingResponseId)) return { state: s, actions: NO_ACTIONS };
      // 새 재생(앞 재생이 멈춤 없이 다음 응답으로 넘어간 경우 포함) — 마이크를 닫고 문턱을 얼린다
      const thresholdDb = talkBargeInThresholdDb(s.floorDb, s.config.minThresholdDb, s.config.marginDb);
      return {
        state: {
          ...s,
          teacherPlaying: true,
          playingResponseId: ev.responseId,
          micOpen: false,
          thresholdDb,
          run: null,
          cut: false,
          playbackPeakDb: null,
          stats: {
            ...s.stats,
            playbacks: s.stats.playbacks + 1,
            thresholdDb: roundDb(thresholdDb),
            floorDb: s.floorDb === null ? null : roundDb(s.floorDb),
          },
        },
        actions: NO_ACTIONS,
      };
    }
    case "teacher_audio_stopped": {
      if (!s.teacherPlaying) return { state: s, actions: NO_ACTIONS };
      // 늦게 온 앞 응답의 멈춤 — 지금 재생과 id가 다르면 무시(둘 다 알 때만 — QA cutoff_2 P3-B)
      if (s.playingResponseId !== null && ev.responseId !== null && ev.responseId !== s.playingResponseId) return { state: s, actions: NO_ACTIONS };
      // 재생이 끝났다(정상 종료·비움) — 마이크를 켠다. 진행 중이던 덩어리는 판정을 거둔다(그 말은 은우 차례 — 이제 서버가 듣는다)
      let stats = s.stats;
      if (!s.cut && s.playbackPeakDb !== null) {
        const peak = roundDb(s.playbackPeakDb);
        stats = { ...stats, quietPeakDb: stats.quietPeakDb === null ? peak : Math.max(stats.quietPeakDb, peak) };
      }
      return {
        state: { ...s, teacherPlaying: false, playingResponseId: null, micOpen: true, run: null, cut: false, playbackPeakDb: null, stats },
        actions: NO_ACTIONS,
      };
    }
    case "level": {
      const dt = s.lastFrameAt === null ? 0 : Math.min(TALK_LEVEL_FRAME_MAX_MS, Math.max(0, now - s.lastFrameAt));
      const db = Number.isFinite(ev.db) ? Math.min(0, Math.max(TALK_LEVEL_SILENCE_DB, ev.db)) : TALK_LEVEL_SILENCE_DB;
      if (!s.teacherPlaying) {
        // 선생님이 말하지 않는 동안 — 소음 바닥만 따라간다(재생 중에는 얼린다)
        return { state: { ...s, lastFrameAt: now, floorDb: updateTalkNoiseFloor(s.floorDb, db, dt, s.config.minThresholdDb, s.config.marginDb) }, actions: NO_ACTIONS };
      }
      if (s.cut) return { state: { ...s, lastFrameAt: now }, actions: NO_ACTIONS }; // 이미 끊었다 — 이 재생은 더 판정하지 않는다
      const peak = s.playbackPeakDb === null ? db : Math.max(s.playbackPeakDb, db);
      const threshold = s.thresholdDb ?? talkBargeInThresholdDb(s.floorDb, s.config.minThresholdDb, s.config.marginDb);
      let run = s.run;
      let stats = s.stats;
      if (db >= threshold) {
        run = run
          ? { ...run, voicedMs: run.voicedMs + dt, lastLoudAt: now, peakDb: Math.max(run.peakDb, db) }
          : { startedAt: now, voicedMs: dt, lastLoudAt: now, peakDb: db };
        if (run.voicedMs >= s.config.minMs) {
          // 진짜 끼어들기 — 선생님을 멈추고 마이크를 켠다(그때부터 은우 말이 서버로 간다)
          stats = pushRecent(
            { ...stats, bargeIns: stats.bargeIns + 1 },
            { voicedMs: Math.round(run.voicedMs), spanMs: Math.round(run.lastLoudAt - run.startedAt), peakDb: roundDb(run.peakDb), cut: true },
          );
          return {
            state: { ...s, lastFrameAt: now, playbackPeakDb: peak, run: null, cut: true, micOpen: true, stats },
            actions: [{ type: "cut_teacher", cancelResponse: ev.responseActive }],
          };
        }
      } else if (run && now - run.lastLoudAt > s.config.gapMs) {
        // 덩어리가 700ms를 못 채우고 끝났다 — 짧은 소리(선생님은 그대로, 마이크는 닫힌 채)
        stats = pushRecent(
          { ...stats, shortSounds: stats.shortSounds + 1 },
          { voicedMs: Math.round(run.voicedMs), spanMs: Math.round(run.lastLoudAt - run.startedAt), peakDb: roundDb(run.peakDb), cut: false },
        );
        run = null;
      }
      return { state: { ...s, lastFrameAt: now, playbackPeakDb: peak, run, stats }, actions: NO_ACTIONS };
    }
    case "child_speech_started":
      // 새 말소리 — 앞 말의 취소 예약은 거둔다(이 말의 대답을 취소하지 않게)
      return s.suppressUntil === null ? { state: s, actions: NO_ACTIONS } : { state: { ...s, suppressUntil: null }, actions: NO_ACTIONS };
    case "child_speech_stopped":
      // 마이크가 닫힌 채(재생 중·끊지 않음) 서버 말소리가 끝났다 — 재생 전에 듣기 시작한 말의 조각이다. 그 자동 응답은 취소한다
      if (s.teacherPlaying && !s.micOpen) return { state: { ...s, suppressUntil: now + s.config.replyWaitMs }, actions: NO_ACTIONS };
      return { state: s, actions: NO_ACTIONS };
    case "response_created": {
      if (s.suppressUntil === null) return { state: s, actions: NO_ACTIONS };
      if (now > s.suppressUntil) return { state: { ...s, suppressUntil: null }, actions: NO_ACTIONS };
      if (ev.requestedByApp) return { state: s, actions: NO_ACTIONS }; // 앱이 청한 응답(인사·도움 요청·마무리)은 건드리지 않는다
      return {
        state: { ...s, suppressUntil: null, stats: { ...s.stats, repliesCancelled: s.stats.repliesCancelled + 1 } },
        actions: [{ type: "cancel_reply", responseId: ev.responseId }],
      };
    }
    case "tick":
      if (s.suppressUntil !== null && now > s.suppressUntil) return { state: { ...s, suppressUntil: null }, actions: NO_ACTIONS };
      return { state: s, actions: NO_ACTIONS };
    default:
      return { state: s, actions: NO_ACTIONS };
  }
}

/** 여러 이벤트를 차례로 접는다(eval·재생용) — 나온 동작을 모두 모은다 */
export function reduceTalkBargeInEvents(
  events: readonly TalkBargeInEvent[],
  state: TalkBargeInState,
): { state: TalkBargeInState; actions: TalkBargeInAction[] } {
  const actions: TalkBargeInAction[] = [];
  let cur = state;
  for (const ev of events) {
    const step = reduceTalkBargeIn(cur, ev);
    cur = step.state;
    actions.push(...step.actions);
  }
  return { state: cur, actions };
}

/**
 * 음량 열 → 레벨 이벤트 열(eval·진단 재생용). `segments`는 [dBFS, 길이 ms] 차례, `frameMs` 간격으로 프레임을 찍는다(첫 프레임 시각 = start).
 */
export function talkLevelFrames(
  start: number,
  segments: readonly (readonly [number, number])[],
  frameMs: number,
  responseActive = false,
): Extract<TalkBargeInEvent, { type: "level" }>[] {
  const out: Extract<TalkBargeInEvent, { type: "level" }>[] = [];
  let t = start;
  for (const [db, ms] of segments) {
    const n = Math.round(ms / frameMs);
    for (let i = 0; i < n; i++) {
      t += frameMs;
      out.push({ type: "level", now: t, db, responseActive });
    }
  }
  return out;
}

/** 상태 기계가 듣는 GA 서버 이벤트 이름(SDK 타입으로 검사된다) */
export const TALK_BARGE_IN_SERVER_EVENTS = {
  teacherStarted: "output_audio_buffer.started",
  teacherStopped: "output_audio_buffer.stopped",
  teacherCleared: "output_audio_buffer.cleared",
  childStarted: "input_audio_buffer.speech_started",
  childStopped: "input_audio_buffer.speech_stopped",
  responseCreated: "response.created",
} as const satisfies Record<string, RealtimeServerEvent["type"]>;

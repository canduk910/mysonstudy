/**
 * lib/talk-hints.ts — 자유대화 **말문 막힘 도움** 순수 상태 기계 (docs/harness/english.md §12-6, SPEC §21-7)
 *
 * 시계는 인자로 받는다(`now`, ms) — 같은 이벤트 열이면 늘 같은 결과(e2e·eval이 시간을 흘려 본다). 화면은 이 상태에서
 * `viewTalkHints(state)`만 읽어 도움 카드를 그리고, `shouldNudge`가 켜진 전이 직후에 도움 요청을 한 번 보낸다.
 *
 * 규칙(§12-6):
 * - 최신 `show_hints`를 "지금 질문의 도움"으로 둔다(`hints_received`).
 * - 선생님이 다시 말하기 시작하면(`teacher_audio_started` ← output_audio_buffer.started) 카드를 접고 **이전 도움을 버린다**.
 *   "이전"은 선생님 소리가 마지막으로 멈춘(`teacher_audio_stopped`) 것보다 먼저 받은 도움이다 — 선생님이 도구만 먼저 부르고
 *   (오디오 없는 응답) 이어서 질문을 말하는 순서에서도 그 질문의 도움이 살아남는다.
 * - 선생님 소리가 멈춘 뒤 **5초**(TALK_HINT_SHOW_AFTER_MS) 동안 은우 발화가 없으면 카드를 띄운다. 은우가 말을 시작하면 접는다.
 * - 받은 도움이 없으면 기본 문구(TALK_FALLBACK_HINTS)를 보인다.
 * - **12초**(TALK_HINT_NUDGE_AFTER_MS) 동안 계속 조용하면 도움 요청(TALK_NUDGE_NOTE + response.create)을 한 번 — **선생님 차례 하나에
 *   한 번만**(차례 = 선생님이 말하기 시작할 때마다 새로 센다).
 * - **연속 상한**: 은우가 말하기 전까지 도움 요청(12초 자동·🙋 합산)은 **연속 2번**(TALK_HINT_NUDGE_STREAK_MAX)까지다. 은우가 말을
 *   시작하면(`child_speech_started`) 다시 0부터 센다. 상한에 닿으면 카드는 그대로 띄우되(5초·🙋) 요청은 보내지 않는다 — 은우가
 *   계속 조용할 때 선생님 차례마다 요청이 되풀이되며 대화 전체를 다시 입력으로 과금하는 고리를 끊는다.
 * - 🙋(`help_tapped`): 카드를 바로 띄우고, 선생님이 말하는 중이 아니고 이 차례에 아직 청하지 않았으면 도움 요청도 바로.
 *   선생님이 말하는 중이면 요청을 **보류**했다가 선생님 소리가 멈출 때 보낸다(같은 차례 안에서만 — 새 차례가 시작되면 보류를 버린다).
 *   선생님이 아직 한 번도 말하지 않았으면(연결 중) 카드만 띄운다.
 * - 마무리(`wrapup_started`) 뒤에는 카드도 요청도 없다(작별 인사 뒤에 선생님을 다시 부르지 않는다).
 * - 5·12초는 개발 전용 시간 배율의 적용을 받는다 — `createTalkHints(talkHintTimings(scale))`.
 *
 * 앱 배선(참고): output_audio_buffer.started → teacher_audio_started, output_audio_buffer.stopped/.cleared → teacher_audio_stopped,
 * input_audio_buffer.speech_started/.speech_stopped → child_speech_started/stopped (`talkHintEventFromServer`가 옮겨 준다),
 * 검사를 통과한 show_hints → hints_received, 🙋 → help_tapped, 5분 마무리 → wrapup_started, 250ms쯤마다 tick.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈 lib/talk-cards.ts(→ talk-transcript)뿐. openai는 `import type`만.
 */

import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import type { TalkCard } from "./ai/english/talk-schemas";
import { TALK_FALLBACK_HINTS, type TalkHints } from "./talk-cards";

// ---------------------------------------------------------------------------
// 시간 — 한 곳
// ---------------------------------------------------------------------------

/** 선생님 소리가 멈춘 뒤 도움 카드를 띄우기까지(§12-6 "5초") */
export const TALK_HINT_SHOW_AFTER_MS = 5_000;
/** 선생님 소리가 멈춘 뒤 도움 요청을 보내기까지(§12-6 "12초") */
export const TALK_HINT_NUDGE_AFTER_MS = 12_000;
/**
 * 은우가 말하기 전까지 보낼 수 있는 도움 요청 수(12초 자동·🙋 합산, §12-6 "연속 2번") — 은우 `speech_started`로 0이 된다.
 * 넘으면 카드만 띄우고 요청은 보내지 않는다. 시간 배율과 무관한 횟수다.
 */
export const TALK_HINT_NUDGE_STREAK_MAX = 2;

export interface TalkHintTimings {
  showAfterMs: number;
  nudgeAfterMs: number;
}

/**
 * 시간 설정 — `scale`은 개발 전용 시간 배율(e2e가 0.1이면 0.5초·1.2초). 1이면 스펙 값 그대로. 양수가 아니면 1로 본다.
 */
export function talkHintTimings(scale = 1): TalkHintTimings {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { showAfterMs: TALK_HINT_SHOW_AFTER_MS * k, nudgeAfterMs: TALK_HINT_NUDGE_AFTER_MS * k };
}

// ---------------------------------------------------------------------------
// 상태·이벤트
// ---------------------------------------------------------------------------

export type TalkHintsEvent =
  | { type: "teacher_audio_started"; now: number }
  | { type: "teacher_audio_stopped"; now: number }
  | { type: "child_speech_started"; now: number }
  | { type: "child_speech_stopped"; now: number }
  | { type: "hints_received"; now: number; hints: TalkHints }
  | { type: "help_tapped"; now: number }
  | { type: "wrapup_started"; now: number }
  | { type: "tick"; now: number };

export interface TalkHintsState {
  timing: TalkHintTimings;
  teacherSpeaking: boolean;
  childSpeaking: boolean;
  /** 조용함이 시작된 시각(선생님 소리가 멈췄거나 은우 말이 멈춘 때). 누가 말하는 중이거나 아직 한 번도 안 멈췄으면 null */
  quietSince: number | null;
  /** 선생님 소리가 멈춘 횟수 — 도움이 "이전 것"인지 가르는 기준 */
  stopCount: number;
  /** 지금 질문의 도움과, 받았을 때의 stopCount */
  hints: { value: TalkHints; epoch: number } | null;
  visible: boolean;
  /** 이 선생님 차례에 도움 요청을 이미 보냈다 */
  nudgedThisTurn: boolean;
  /** 은우가 마지막으로 말을 시작한 뒤(또는 대화 시작 뒤) 보낸 도움 요청 수 — TALK_HINT_NUDGE_STREAK_MAX에 닿으면 더 보내지 않는다 */
  nudgeStreak: number;
  /** 🙋가 선생님 말하는 중에 눌려 요청을 보류했다 */
  helpPending: boolean;
  /** 마무리 중 — 카드도 요청도 없다 */
  closed: boolean;
  /** **이 전이에서** 도움 요청을 보내야 한다(다음 이벤트에서 다시 false). 앱은 전이 직후 한 번 보낸다. */
  shouldNudge: boolean;
}

/** 대화 시작 상태 */
export function createTalkHints(timing: TalkHintTimings = talkHintTimings()): TalkHintsState {
  return {
    timing,
    teacherSpeaking: false,
    childSpeaking: false,
    quietSince: null,
    stopCount: 0,
    hints: null,
    visible: false,
    nudgedThisTurn: false,
    nudgeStreak: 0,
    helpPending: false,
    closed: false,
    shouldNudge: false,
  };
}

/** 도움 요청을 보낼 수 있는가 — 마무리 전, 이 차례에 아직 안 청했고, 은우가 말하기 전 연속 상한 아래 */
function canNudge(s: TalkHintsState): boolean {
  return !s.closed && !s.nudgedThisTurn && s.nudgeStreak < TALK_HINT_NUDGE_STREAK_MAX;
}

function requestNudge(s: TalkHintsState): TalkHintsState {
  if (!canNudge(s)) return s.helpPending ? { ...s, helpPending: false } : s;
  return { ...s, nudgedThisTurn: true, nudgeStreak: s.nudgeStreak + 1, helpPending: false, shouldNudge: true };
}

/** 이벤트 하나를 접는다(순수). `shouldNudge`는 이 전이에서만 켜진다. */
export function reduceTalkHints(prev: TalkHintsState, event: TalkHintsEvent): TalkHintsState {
  // 한 전이짜리 신호는 매번 끈다
  const s: TalkHintsState = prev.shouldNudge ? { ...prev, shouldNudge: false } : prev;
  if (s.closed) return s;
  const now = event.now;
  switch (event.type) {
    case "teacher_audio_started": {
      // 새 선생님 차례 — 카드를 접고, 마지막으로 소리가 멈추기 전에 받은 도움(이전 질문의 도움)을 버린다
      const keep = s.hints !== null && s.hints.epoch >= s.stopCount;
      return {
        ...s,
        teacherSpeaking: true,
        childSpeaking: false,
        quietSince: null,
        hints: keep ? s.hints : null,
        visible: false,
        nudgedThisTurn: false,
        helpPending: false,
      };
    }
    case "teacher_audio_stopped": {
      if (!s.teacherSpeaking) {
        // 겹친 멈춤(stopped 뒤 cleared 등)·시작을 못 받은 멈춤 — 도는 조용함 시계를 되감지 않고, 멈춘 횟수도 늘리지 않는다
        return s.quietSince === null && !s.childSpeaking ? { ...s, quietSince: now } : s;
      }
      const stopped: TalkHintsState = {
        ...s,
        teacherSpeaking: false,
        stopCount: s.stopCount + 1,
        quietSince: s.childSpeaking ? null : now,
      };
      return s.helpPending ? requestNudge(stopped) : stopped;
    }
    case "child_speech_started":
      // 은우가 말을 시작했다 — 도움 요청 연속 상한을 다시 센다
      return { ...s, childSpeaking: true, quietSince: null, visible: false, nudgeStreak: 0 };
    case "child_speech_stopped":
      return { ...s, childSpeaking: false, quietSince: s.teacherSpeaking ? null : now };
    case "hints_received":
      return { ...s, hints: { value: event.hints, epoch: s.stopCount } };
    case "help_tapped": {
      const shown: TalkHintsState = { ...s, visible: true };
      if (s.teacherSpeaking) return canNudge(s) ? { ...shown, helpPending: true } : shown;
      // 선생님이 아직 한 번도 말하지 않았다(연결 중) — 청할 "마지막 질문"이 없으니 카드만
      if (s.stopCount === 0) return shown;
      return requestNudge(shown);
    }
    case "wrapup_started":
      return { ...s, closed: true, visible: false, helpPending: false, quietSince: null };
    case "tick": {
      if (s.teacherSpeaking || s.childSpeaking || s.quietSince === null) return s;
      const quietMs = now - s.quietSince;
      let next = s;
      if (!next.visible && quietMs >= next.timing.showAfterMs) next = { ...next, visible: true };
      if (canNudge(next) && quietMs >= next.timing.nudgeAfterMs) next = requestNudge(next);
      return next;
    }
    default:
      return s;
  }
}

/** 여러 이벤트를 차례로 접는다(eval·e2e 재생용) */
export function reduceTalkHintsEvents(events: readonly TalkHintsEvent[], state: TalkHintsState = createTalkHints()): TalkHintsState {
  return events.reduce<TalkHintsState>((st, ev) => reduceTalkHints(st, ev), state);
}

// ---------------------------------------------------------------------------
// 화면이 읽는 것
// ---------------------------------------------------------------------------

/** 도움 카드 내용 — 답 예시(큰 글씨, 기본 문구면 우리말 뜻도)와 핵심 단어(이모지·영어·뜻) */
export interface TalkHintsCard {
  /** teacher = 선생님이 준비한 도움, fallback = 받은 도움이 없어 기본 문구 */
  source: "teacher" | "fallback";
  answers: { en: string; ko: string | null }[];
  words: TalkCard[];
}

export interface TalkHintsView {
  visible: boolean;
  /** 보일 카드 — visible일 때만 있다 */
  hints: TalkHintsCard | null;
  shouldNudge: boolean;
}

/** 상태 → 화면 */
export function viewTalkHints(s: TalkHintsState): TalkHintsView {
  if (!s.visible) return { visible: false, hints: null, shouldNudge: s.shouldNudge };
  const card: TalkHintsCard = s.hints
    ? { source: "teacher", answers: s.hints.value.answers.map((en) => ({ en, ko: null })), words: s.hints.value.words }
    : { source: "fallback", answers: TALK_FALLBACK_HINTS.map((h) => ({ en: h.en, ko: h.ko })), words: [] };
  return { visible: true, hints: card, shouldNudge: s.shouldNudge };
}

// ---------------------------------------------------------------------------
// 서버 이벤트 → 도움 이벤트
// ---------------------------------------------------------------------------

/** 상태 기계가 듣는 GA 서버 이벤트 이름(SDK 타입으로 검사된다) */
export const TALK_HINT_SERVER_EVENTS = {
  teacherStarted: "output_audio_buffer.started",
  teacherStopped: "output_audio_buffer.stopped",
  teacherCleared: "output_audio_buffer.cleared",
  childStarted: "input_audio_buffer.speech_started",
  childStopped: "input_audio_buffer.speech_stopped",
} as const satisfies Record<string, RealtimeServerEvent["type"]>;

/**
 * 데이터 채널 서버 이벤트(JSON 그대로) → 도움 상태 기계 이벤트. 해당 없는 이벤트면 null.
 * 선생님 소리가 끼어들기로 잘린 경우(`output_audio_buffer.cleared`)도 "멈춤"으로 본다.
 */
export function talkHintEventFromServer(event: unknown, now: number): TalkHintsEvent | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return null;
  const E = TALK_HINT_SERVER_EVENTS;
  switch ((event as { type?: unknown }).type) {
    case E.teacherStarted:
      return { type: "teacher_audio_started", now };
    case E.teacherStopped:
    case E.teacherCleared:
      return { type: "teacher_audio_stopped", now };
    case E.childStarted:
      return { type: "child_speech_started", now };
    case E.childStopped:
      return { type: "child_speech_stopped", now };
    default:
      return null;
  }
}

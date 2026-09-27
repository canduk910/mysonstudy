/**
 * lib/talk-hints.ts — 자유대화 **말문 막힘 도움** 순수 상태 기계 (docs/harness/english.md §12-6, SPEC §21-7)
 *
 * 시계는 인자로 받는다(`now`, ms) — 같은 이벤트 열이면 늘 같은 결과(e2e·eval이 시간을 흘려 본다). 화면은 이 상태에서
 * `viewTalkHints(state)`만 읽어 도움 카드를 그리고, `shouldNudge`가 켜진 전이 직후에 도움 요청을 한 번 보낸다.
 *
 * 규칙(§12-6):
 * - 최신 도움(호출 J 카드의 답 예시·핵심 단어 — §12-7)을 "지금 질문의 도움"으로 둔다(`hints_received`).
 * - 선생님이 다시 말하기 시작하면(`teacher_audio_started` ← output_audio_buffer.started) 카드를 접고 **앞 줄의 도움을 늘 버린다**
 *   (§12-7 2026-09-27 확정 — QA talk-cards-j P3-C). 호출 J는 늘 선생님 줄이 끝난 **뒤** 도착하므로, §12-6의 "마지막 멈춤보다 먼저 받은
 *   도움만 버린다"(도구를 먼저 부르고 말하던 순서를 위한 규칙)를 두면 L1의 도움이 L2 동안 살아남고, L2의 호출 J가 실패하면 L2 질문
 *   아래에 L1의 답 예시가 뜬다. 도움은 언제나 가장 최근 선생님 줄의 것이고, 호출 J가 실패한 줄에는 기본 문구가 뜬다.
 * - 선생님 소리가 멈춘 뒤 **5초**(TALK_HINT_SHOW_AFTER_MS) 동안 은우 발화가 없으면 카드를 띄운다. 은우가 말을 시작하면 접는다.
 * - 받은 도움이 없으면 기본 문구(TALK_FALLBACK_HINTS)를 보인다.
 * - **12초**(TALK_HINT_NUDGE_AFTER_MS) 동안 계속 조용하면 도움 요청(TALK_NUDGE_NOTE + response.create)을 한 번 — **선생님 차례 하나에
 *   한 번만**(차례 = 선생님이 말하기 시작할 때마다 새로 센다).
 * - **연속 상한**: 은우가 말하기 전까지 도움 요청(12초 자동·🙋 합산)은 **연속 2번**(TALK_HINT_NUDGE_STREAK_MAX)까지다. 은우가 말을
 *   시작하면(`child_speech_started`) 다시 0부터 센다. 상한에 닿으면 카드는 그대로 띄우되(5초·🙋) 요청은 보내지 않는다 — 은우가
 *   계속 조용할 때 선생님 차례마다 요청이 되풀이되며 대화 전체를 다시 입력으로 과금하는 고리를 끊는다.
 * - 🙋(`help_tapped`): 카드를 바로 띄우고, 선생님도 은우도 말하는 중이 아니고 이 차례에 아직 청하지 않았으면 도움 요청도 바로.
 *   선생님이 말하는 중이면 요청을 **보류**했다가 선생님 소리가 멈출 때 보낸다(같은 차례 안에서만 — 새 차례가 시작되면 보류를 버린다).
 *   선생님이 아직 한 번도 말하지 않았으면(연결 중) 카드만 띄운다. **은우가 말하는 중이면 카드만**이다(요청도 보류도 없다 — 은우 말에
 *   대한 선생님 대답은 서버 자동 응답이 한다. 보류 중에 은우가 말하기 시작했다가 선생님 소리가 멈추면 보류도 버린다 — QA full_1 P2-A 첫 겹).
 * - **셈은 보낸 요청이다**(`nudge_withheld`): "차례 하나에 한 번"·"연속 2번"은 앱이 실제로 보낸 도움 요청을 센다. 요청 신호
 *   (`shouldNudge`)를 받은 앱(lib/talk-realtime.ts)이 보내지 않고 버리면 — 은우 말이 막 끝나 자동 응답을 기다리는 틈(이 상태 기계는 모른다),
 *   보류한 요청을 은우 끼어들기·소리 있는 응답으로 버림 — 이 이벤트로 그 신호의 셈(`nudgedThisTurn`·`nudgeStreak`)을 되돌린다.
 *   되돌리지 않으면 보내지 않은 요청이 상한을 먹어 연속 2번이 1번이 되고, 자동 응답이 끝내 오지 않는 차례에는 12초 요청이 영영
 *   나가지 않는다(QA talk-cards-j full_2 P3-A).
 * - 마무리(`wrapup_started`) 뒤에는 카드도 요청도 없다(작별 인사 뒤에 선생님을 다시 부르지 않는다).
 * - 5·12초는 개발 전용 시간 배율의 적용을 받는다 — `createTalkHints(talkHintTimings(scale))`.
 *
 * 앱 배선(참고): output_audio_buffer.started → teacher_audio_started, output_audio_buffer.stopped/.cleared → teacher_audio_stopped,
 * input_audio_buffer.speech_started/.speech_stopped → child_speech_started/stopped (`talkHintEventFromServer`가 옮겨 준다),
 * 호출 J 도착(decideTalkCardsArrival의 hints) → hints_received, 🙋 → help_tapped, 5분 마무리 → wrapup_started, 250ms쯤마다 tick,
 * 요청 신호를 보내지 않고 버림 → nudge_withheld.
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
  | { type: "tick"; now: number }
  /** 앱이 요청 신호(`shouldNudge`) 하나를 보내지 않고 버렸다 — 그 신호의 셈을 되돌린다(셈은 보낸 요청, QA full_2 P3-A) */
  | { type: "nudge_withheld"; now: number };

export interface TalkHintsState {
  timing: TalkHintTimings;
  teacherSpeaking: boolean;
  childSpeaking: boolean;
  /** 조용함이 시작된 시각(선생님 소리가 멈췄거나 은우 말이 멈춘 때). 누가 말하는 중이거나 아직 한 번도 안 멈췄으면 null */
  quietSince: number | null;
  /** 선생님 소리가 멈춘 횟수 — 0이면 선생님이 아직 한 번도 말을 마치지 않았다(연결 중 🙋는 카드만) */
  stopCount: number;
  /** 지금 질문(가장 최근 선생님 줄)의 도움 — 선생님이 다시 말하기 시작하면 늘 비운다(§12-7) */
  hints: { value: TalkHints } | null;
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
      // 새 선생님 차례 — 카드를 접고 앞 줄의 도움을 늘 버린다(§12-7 — 호출 J는 줄이 끝난 뒤 도착한다. 이 줄의 도움은 이 줄의 호출 J가 준다)
      return {
        ...s,
        teacherSpeaking: true,
        childSpeaking: false,
        quietSince: null,
        hints: null,
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
      if (!s.helpPending) return stopped;
      // 보류 중에 은우가 말하기 시작했다(끼어들기) — 은우 말 위로 청하지 않는다. 보류는 셈 전이라 되돌릴 셈도 없다
      return s.childSpeaking ? { ...stopped, helpPending: false } : requestNudge(stopped);
    }
    case "child_speech_started":
      // 은우가 말을 시작했다 — 도움 요청 연속 상한을 다시 센다
      return { ...s, childSpeaking: true, quietSince: null, visible: false, nudgeStreak: 0 };
    case "child_speech_stopped":
      return { ...s, childSpeaking: false, quietSince: s.teacherSpeaking ? null : now };
    case "hints_received":
      return { ...s, hints: { value: event.hints } };
    case "help_tapped": {
      const shown: TalkHintsState = { ...s, visible: true };
      if (s.teacherSpeaking) return canNudge(s) ? { ...shown, helpPending: true } : shown;
      // 선생님이 아직 한 번도 말하지 않았다(연결 중) — 청할 "마지막 질문"이 없으니 카드만
      if (s.stopCount === 0) return shown;
      // 은우가 말하는 중("Um… I…") — 카드만. 그 말에 대한 선생님 대답은 서버 자동 응답이 한다(여기서 청하면 선생님 두 명)
      if (s.childSpeaking) return shown;
      return requestNudge(shown);
    }
    case "wrapup_started":
      return { ...s, closed: true, visible: false, helpPending: false, quietSince: null };
    case "nudge_withheld":
      // 앱이 요청 신호를 보내지 않고 버렸다 — 이 차례는 아직 "청한 차례"가 아니고, 연속 셈에서도 뺀다(셈은 보낸 요청)
      return { ...s, nudgedThisTurn: false, nudgeStreak: Math.max(0, s.nudgeStreak - 1) };
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

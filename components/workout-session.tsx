"use client";

/**
 * 운동 세션 모드(`▶ 운동 시작`) — 전면 오버레이 (SPEC §19-6).
 *
 * - 슈퍼세트 10스텝(풀업1 → 푸시업1 → 풀업2 …)은 엔진 `supersetSteps(target)`이 만든다(화면이 순서를 복제하지 않는다).
 * - **휴식은 세트(라운드) 사이에만** — 풀업+푸시업이 한 세트다(§19-1, 2026-09-25 사용자 정정). 풀업 ✓는 타이머 없이 곧바로
 *   같은 세트의 푸시업으로, 푸시업 ✓가 휴식을 시작한다. 이 규칙의 정의처는 엔진 `restFollowsStep`/`stepFollowsRest`(lib/workout.ts,
 *   eval:workout이 잠근다) 하나다 — ✓ 처리·음성 안내 대상(`stepsAfterRest`)·복원 정규화·목록의 휴식 줄이 같이 본다.
 *   풀업 ✓ 직후 같은 자리에 푸시업 ✓가 뜨므로, 연타가 푸시업(마지막 세트면 하루 완료 기록)까지 넘기지 않게 짧게 막는다(`CHAIN_TAP_GUARD_MS`).
 *   푸시업 ✓ 직후에는 같은 자리에 휴식 무대의 2분/3분 줄이 뜨므로, 같은 가드 시간 안의 휴식 조작(2분/3분·+30초·건너뛰기)도 무시한다.
 * - **세트 목록 순서는 실시간**(2026-09-25 사용자 요청): 지금 할 세트가 맨 위 → 남은 세트(번호순) → 완료 세트 맨 아래(번호순, 흐리게 ✓).
 *   순서는 현재 스텝에서 **파생**한다 — 규칙의 정의처는 엔진 `roundDisplayOrder`(lib/workout.ts, eval:workout "세트 목록 순서"가 잠근다).
 *   따로 저장하지 않으므로 복원·재진입은 애니메이션 없이 최종 순서로 그려진다.
 *   푸시업 ✓로 세트를 끝내면 약 1초 축하(체크 팝·이모지 버스트·"🎉 n세트 완료!"·짧은 진동) 뒤 그 행이 완료 구역으로 미끄러져
 *   내려간다(FLIP — 재배치 전후 위치를 재고 Web Animations로 transform을 0까지). 풀업 ✓는 그 칸의 체크 팝만(재배치 없음).
 *   목록은 작은 폰(보이는 높이 약 620px 미만)에서 첫 화면 아래라, **같은 문구를 늘 첫 화면에 있는 휴식 무대의 캡션 자리에도** 같은 시간 동안
 *   보인다(자동 스크롤 없음 — 철봉 아래에서 화면이 저절로 움직이면 방해다). 스크린리더 알림은 숨은 `role="status"` 한 곳만 한다.
 *   **애니메이션은 표시일 뿐** — 휴식·비프 예약·음성·저장·연타 가드는 탭 즉시 진행되고, 축하 중에도 조작은 상태 기준이다.
 *   `prefers-reduced-motion`이면 붙잡기·이동 없이 즉시 재배치하고, 휴식 무대의 문구만 움직임 없이 보인다. 마지막 세트 ✓는 축하 없이
 *   곧바로 완료 기록(기존 흐름).
 * - 오버레이: z-index 20 + 공용 `lockBodyScroll`(ja-vocab-detail-view 카드 모드 관용구). 스트릭 헤드라인(z:15)이
 *   가려지는 게 의도다(§17-4).
 * - **휴식 타이머는 종료 시각(epoch ms) 기반** — 백그라운드 스로틀·새로고침에도 남은 시간이 맞다. 기본 2:00, 2분/3분·+30초·건너뛰기.
 *   **마지막 스텝의 ✓는 타이머 없이 곧바로 완료 기록.**
 * - 알림(전부 best-effort, 시각 타이머가 기준):
 *   · 비프 — ✓ 탭 핸들러 안에서 AudioContext를 만들거나 resume()하고, **종료 시각에 미리 예약**한다(탭 밖 재생 제약 회피).
 *     컨텍스트는 모듈 싱글턴(iOS는 컨텍스트 개수 제한이 있어 세션마다 새로 만들지 않는다).
 *   · 진동 — navigator.vibrate(되는 기기만).
 *   · 음성 안내(토글, localStorage 영속, 기본 켬) — ✓ 탭에서 unlockSpeechPlayback(), 종료 시 speakQueue([{ text, lang: "ko-KR" }]).
 *     타이머 콜백(탭 밖)의 speakQueue는 iOS에서 앞서 탭이 unlockSpeechPlayback()을 불렀어야 소리가 난다(lib/speech 계약 (2)).
 *   · 화면 꺼짐 방지 — Wake Lock을 요청하고 visible 복귀 때 재요청(지원 안 하면 조용히 넘어간다).
 * - **진행 보존**: localStorage `workout-session:v1` 하나. **마운트 후 effect에서만** 읽고(hydration),
 *   cycleId·rev·day·targetDay·dateKst가 전부 props와 같을 때만 복원 — 다르면 조용히 버린다(undo·다른 기기 기록·어제 세션이
 *   새 목표에 이어 붙지 않게). 기록 성공·409·실패 기록 시 삭제. 모든 접근은 try/catch(프라이빗 모드 등).
 *   값 모양은 그대로다(키 v1 유지). 스텝마다 쉬던 옛 버전이 남긴 "푸시업 앞 휴식"(홀수 스텝 + restEndsAt)은 복원할 때 휴식만 버린다.
 * - 기록 요청의 결과는 부모가 처리한다(onResult) — ok면 새로고침, 409·404면 메시지 + 새로고침(자동 완료 409는 부모가
 *   새로고침 뒤 같은 Day의 recorded_today인지 보고 성공으로 보여 준다). 그 밖 오류는 세션 안에 남아 다시 누를 수 있다.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import {
  restFollowsStep,
  roundDisplayOrder,
  SETS_PER_EXERCISE,
  stepFollowsRest,
  stepsAfterRest,
  supersetSteps,
  type FailedAt,
  type SetPair,
  type WorkoutEventKind,
  type WorkoutStep,
} from "@/lib/workout";
import type { WorkoutLogRequest, WorkoutLogResponse } from "@/lib/workout-contract";
import s from "./workout-session.module.css";
import {
  exerciseKo,
  isStaleStatus,
  NETWORK_ERROR_KO,
  postWorkout,
  RepsSelect,
  SAVE_ERROR_KO,
  STALE_FALLBACK_KO,
  stepLabel,
  stepName,
  stepPhrase,
  WORKOUT_CAUTIONS,
} from "./workout-shared";

// ===========================================================================
// 진행 보존 — localStorage `workout-session:v1` (§19-6)
// ===========================================================================

export const WORKOUT_SESSION_KEY = "workout-session:v1";
/** 음성 안내 토글 — 기본 켬. 값 "off"일 때만 끈다 */
const VOICE_KEY = "workout-voice:v1";

const TOTAL_STEPS = SETS_PER_EXERCISE * 2; // 풀업·푸시업 교차 슈퍼세트(§19-1)
const LAST_STEP = TOTAL_STEPS - 1;
const REST_PRESETS: { ms: number; label: string }[] = [
  { ms: 120_000, label: "2분" },
  { ms: 180_000, label: "3분" },
];
const DEFAULT_REST_MS = REST_PRESETS[0].ms;
const REST_BUMP_MS = 30_000;
const TICK_MS = 250;
/**
 * 연타 가드 — 탭 한 번에 무대가 바뀌어 **같은 자리에 다른 버튼이 뜨는** 두 경우에, 이 시간 안의 두 번째 탭을 무시한다.
 * ① 풀업 ✓ → 곧바로 같은 자리에 푸시업 ✓: 연타가 푸시업 세트(마지막 세트면 하루 완료 기록)까지 넘기지 않게(onDone).
 * ② 푸시업 ✓ → 휴식 무대: ✓(64px)의 아래쪽이 2분/3분 줄과 겹쳐, 연타가 휴식을 조용히 3분으로 바꾸고 비프를 다시 예약했다
 *    (2026-09-25 QA D1). 휴식 시작 직후의 pickRest·bumpRest·skipRest를 무시한다.
 * 실제 푸시업 한 세트·휴식 길이를 읽고 고르는 데는 이보다 훨씬 길어 정상 흐름엔 보이지 않는다.
 * ⚠️ 축하(CELEBRATE_MS)가 이보다 짧아야 축하 중 다음 세트를 끝내는 일이 없다(그래도 엔진 roundDisplayOrder는 그 경우를 견딘다).
 */
const CHAIN_TAP_GUARD_MS = 1_200;
/** 세트 완료 축하를 보이는 시간 — 이 동안 끝낸 세트를 맨 위에 붙잡아 두었다가 완료 구역으로 내린다(표시만, §19-6 "약 1초") */
const CELEBRATE_MS = 1_000;
/** FLIP 재배치 — 내려가는 완료 행은 조금 길게(눈으로 따라가게), 올라오는 행은 짧게 */
const FLIP_DOWN_MS = 650;
const FLIP_UP_MS = 450;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** 축하 이모지 버스트 — 행 가운데에서 퍼진다. 가로 ±100px 안(320px 폭에서도 오버레이 밖으로 안 나간다) */
const BURST: { e: string; dx: number; dy: number; delay: number }[] = [
  { e: "🎉", dx: -96, dy: -46, delay: 0 },
  { e: "✨", dx: -52, dy: -70, delay: 40 },
  { e: "💪", dx: 0, dy: -80, delay: 0 },
  { e: "✨", dx: 54, dy: -68, delay: 60 },
  { e: "🎉", dx: 98, dy: -44, delay: 20 },
  { e: "⭐", dx: -76, dy: 22, delay: 80 },
  { e: "🔥", dx: 78, dy: 24, delay: 90 },
];

/** 복원 조건 — 이 다섯 값이 전부 같아야 이어 붙인다 */
export interface SessionMatch {
  cycleId: string;
  rev: number;
  day: number;
  targetDay: number;
  dateKst: string;
}

export interface SavedSession extends SessionMatch {
  /** 다음에 할 스텝(0..9) */
  step: number;
  /** 휴식 종료 시각(epoch ms) — 쉬는 중이 아니면 null */
  restEndsAt: number | null;
}

/**
 * 저장된 진행을 읽는다 — 다섯 값이 전부 같을 때만 돌려주고, 다르면 **조용히 버린다**(삭제).
 * 이벤트 핸들러·effect에서만 부른다(렌더 중 금지 — hydration).
 */
export function readSavedSession(m: SessionMatch): SavedSession | null {
  try {
    const raw = window.localStorage.getItem(WORKOUT_SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedSession> | null;
    const same =
      !!v &&
      v.cycleId === m.cycleId &&
      v.rev === m.rev &&
      v.day === m.day &&
      v.targetDay === m.targetDay &&
      v.dateKst === m.dateKst;
    if (!same) {
      window.localStorage.removeItem(WORKOUT_SESSION_KEY);
      return null;
    }
    const step = typeof v.step === "number" && Number.isInteger(v.step) && v.step >= 0 && v.step <= LAST_STEP ? v.step : 0;
    // 휴식은 세트 사이에만 있다 — 휴식 뒤 스텝이 아닌데 쉬는 중이던 값(스텝마다 쉬던 옛 버전의 "푸시업 앞 휴식")은
    // 휴식만 버리고 그 스텝부터 잇는다. 쉬는 중이면 다음 스텝은 언제나 세트의 풀업이라는 불변식을 지킨다(미리보기·음성 안내).
    const restEndsAt =
      typeof v.restEndsAt === "number" && Number.isFinite(v.restEndsAt) && stepFollowsRest(step) ? v.restEndsAt : null;
    return { ...m, step, restEndsAt };
  } catch {
    return null;
  }
}

/** 저장된 진행 삭제 — 기록 성공·409·실패 기록 시, 오늘이 운동일이 아닐 때 */
export function clearSavedSession(): void {
  try {
    window.localStorage.removeItem(WORKOUT_SESSION_KEY);
  } catch {
    /* 프라이빗 모드 등 — 무시 */
  }
}

function writeSavedSession(v: SavedSession): void {
  try {
    window.localStorage.setItem(WORKOUT_SESSION_KEY, JSON.stringify(v));
  } catch {
    /* 저장 못 해도 세션은 계속된다(새로고침하면 처음부터일 뿐) */
  }
}

/** 음성 안내 켬/끔 — 기본 켬. 핸들러·effect에서만 */
export function readVoicePref(): boolean {
  try {
    return window.localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeVoicePref(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_KEY, on ? "on" : "off");
  } catch {
    /* noop */
  }
}

/**
 * 그날 휴식 끝에 읽을 음성 안내 문구 — **휴식 뒤 스텝(2~5세트의 풀업) 4개**만. 세션 시작 탭에서
 * prefetchSpeech(…, "ko-KR")로 미리 받는다(§19-6). 대상 고르기는 엔진 `stepsAfterRest`(eval:workout이 "정확히 4개"로 잠근다),
 * 문구는 stepPhrase — finishRest가 휴식 끝에 읽는 문구(stepPhrase(휴식 뒤 스텝))와 같은 규칙이다.
 */
export function sessionPhrases(target: SetPair): string[] {
  return stepsAfterRest(target).map(stepPhrase);
}

/** 클래스 이름 잇기 — CSS 모듈에 없는 상태(남은 칸 등)가 "undefined" 문자열로 붙지 않게 거짓 값은 뺀다 */
function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** 움직임 줄이기 설정 — 핸들러에서만 읽는다(렌더 중 matchMedia 금지). 못 읽으면 줄이지 않는다 */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** FLIP 측정 — 목록 안 재배치 대상(data-flip)의 위쪽 위치를 **목록 기준**으로(스크롤·무대 높이 변화와 무관하게) */
function measureFlip(list: HTMLElement | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!list) return out;
  const base = list.getBoundingClientRect().top;
  list.querySelectorAll<HTMLElement>(":scope > [data-flip]").forEach((el) => {
    out.set(el.dataset.flip ?? "", el.getBoundingClientRect().top - base);
  });
  return out;
}

/**
 * FLIP 재생 — 재배치가 DOM에 반영된 직후(useLayoutEffect, 그리기 전) 부른다. 새 위치에서 옛 위치까지 transform으로
 * 되돌려 놓고 0까지 애니메이션한다. 새로 생긴 항목(완료 구분선)은 살짝 늦게 나타난다. Web Animations가 없으면 조용히 즉시 배치.
 */
function playFlip(list: HTMLElement | null, first: Map<string, number>): void {
  if (!list) return;
  const base = list.getBoundingClientRect().top;
  list.querySelectorAll<HTMLElement>(":scope > [data-flip]").forEach((el) => {
    try {
      if (typeof el.animate !== "function") return;
      el.getAnimations?.().forEach((a) => a.cancel()); // 이전 재배치가 아직 돌고 있으면 그 자리에서 이어받는다(first는 보이던 위치)
      const from = first.get(el.dataset.flip ?? "");
      if (from === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 250, easing: "ease-out", fill: "backwards" });
        return;
      }
      const dy = from - (el.getBoundingClientRect().top - base);
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: dy < 0 ? FLIP_DOWN_MS : FLIP_UP_MS,
        easing: FLIP_EASING,
      });
    } catch {
      /* 애니메이션은 표시일 뿐 — 실패하면 최종 위치 그대로 */
    }
  });
}

// ===========================================================================
// 비프 — 모듈 싱글턴 AudioContext (탭 핸들러 안에서 만들거나 resume)
// ===========================================================================

let audioCtx: AudioContext | null = null;

/**
 * **탭 핸들러 안에서 동기로** 부른다 — AudioContext를 만들거나 resume()한다(iOS는 제스처 밖 오디오를 막는다).
 * 세션 시작(▶) 탭과 ✓ 탭이 부른다. 실패해도 조용히 null(비프는 best-effort).
 */
export function ensureWorkoutAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

/** 삐-삐-삐잉 세 번(짧게). at = 컨텍스트 시각(초). 예약한 노드를 돌려준다(취소용) */
function scheduleBeep(ctx: AudioContext, at: number): OscillatorNode[] {
  const tones: [number, number][] = [
    [0, 880],
    [0.28, 880],
    [0.56, 1175],
  ];
  const nodes: OscillatorNode[] = [];
  for (const [offset, freq] of tones) {
    try {
      const t0 = Math.max(at + offset, ctx.currentTime);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.22);
      nodes.push(osc);
    } catch {
      /* 비프는 best-effort */
    }
  }
  return nodes;
}

function cancelNodes(nodes: OscillatorNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect(); // 연결을 끊으면 예약돼 있어도 소리가 나지 않는다(stop 재호출은 브라우저마다 던질 수 있다)
    } catch {
      /* noop */
    }
  }
}

function vibrate(pattern: number | number[] = [200, 100, 200]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* noop — iOS Safari 미지원 */
  }
}

// ===========================================================================
// 컴포넌트
// ===========================================================================

export type SessionResult =
  | { type: "logged"; kind: WorkoutEventKind }
  /** 409·404 — 다른 탭·기기·연타로 이미 바뀜. 부모가 메시지 + 새로고침(자동 완료면 recorded_today 확인) */
  | { type: "stale"; kind: WorkoutEventKind; messageKo: string };

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function WorkoutSession({
  match,
  target,
  isRepeat,
  onClose,
  onResult,
}: {
  match: SessionMatch;
  target: SetPair;
  isRepeat: boolean;
  /** 닫기(진행은 저장된 채로) */
  onClose: () => void;
  /** 기록 요청이 끝났다(ok 또는 409·404) — 부모가 세션을 닫고 새로고침한다 */
  onResult: (r: SessionResult) => void;
}) {
  const { cycleId, rev, day, targetDay, dateKst } = match;
  // target은 서버 스냅샷의 값이라 새로고침 전까지 참조가 같다 — 틱마다 다시 만들지 않는다
  const steps: WorkoutStep[] = useMemo(() => supersetSteps(target), [target]);
  /** 세트(라운드) 묶음 — 한 세트 = 같은 setIndex의 풀업 + 푸시업(엔진 순서 그대로). 목록이 이 단위로 보인다 */
  const rounds: WorkoutStep[][] = useMemo(
    () => Array.from({ length: SETS_PER_EXERCISE }, (_, r) => steps.filter((st) => st.setIndex === r)),
    [steps],
  );

  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState(0);
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null);
  /** 카운트다운 표시용 "지금" — 렌더 중 Date.now()를 읽지 않으려고 핸들러·타이머가 갱신한다 */
  const [now, setNow] = useState(0);
  const [restMs, setRestMs] = useState(DEFAULT_REST_MS);
  const [voiceOn, setVoiceOn] = useState(true);
  const [failOpen, setFailOpen] = useState(false);
  const [failReps, setFailReps] = useState<number | null>(null);
  const [sending, setSending] = useState<WorkoutEventKind | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  /**
   * 세트 완료 축하(표시 전용 — 저장·진행과 무관, 복원 시 늘 null). round = 끝낸 세트(0..4) — 휴식 무대에 "🎉 n세트 완료!"를 보인다.
   * hold = 목록에서 그 세트를 축하가 끝날 때까지 맨 위에 붙잡는가(움직임 줄이기면 false — 즉시 재배치, 무대 문구만 움직임 없이).
   */
  const [celebration, setCelebration] = useState<{ round: number; hold: boolean } | null>(null);
  /** 방금 ✓한 스텝 — 그 칸의 체크가 한 번 튀어 오른다(표시 전용) */
  const [popStep, setPopStep] = useState<number | null>(null);
  /** 스크린리더 알림(aria-live polite) — "n세트 완료!" */
  const [liveMsg, setLiveMsg] = useState("");

  const voiceOnRef = useRef(true);
  const beepRef = useRef<{ nodes: OscillatorNode[]; at: number } | null>(null);
  const speakStopRef = useRef<(() => void) | null>(null);
  /** 이미 처리한 휴식 종료 시각 — 타이머가 두 번 울리지 않게 */
  const endedForRef = useRef<number | null>(null);
  /** 기록이 끝났다(ok·409) — 이후 진행을 다시 저장하지 않는다 */
  const finishedRef = useRef(false);
  /** 마지막 풀업 ✓ 시각 — 곧바로 뜬 푸시업 ✓의 연타를 막는다(CHAIN_TAP_GUARD_MS) */
  const chainedAtRef = useRef(0);
  /** 휴식을 시작한 푸시업 ✓ 시각 — 같은 자리에 뜬 2분/3분 줄의 연타를 막는다(CHAIN_TAP_GUARD_MS, QA D1). 복원한 휴식은 0(가드 없음) */
  const restStartedAtRef = useRef(0);
  /** 세트 목록(<ol>) — FLIP 측정 기준 */
  const listRef = useRef<HTMLOListElement | null>(null);
  /** 축하가 끝나 재배치하기 직전에 잰 위치 — 다음 커밋의 레이아웃 effect가 소비해 FLIP을 재생한다 */
  const flipFromRef = useRef<Map<string, number> | null>(null);
  const celebrateTimerRef = useRef<number | null>(null);
  /** 타이머 콜백(탭 밖)이 "다음 스텝"을 읽는다 — 클로저가 낡지 않게 ref로 */
  const stepRef = useRef(0);
  const stepsRef = useRef(steps);
  useEffect(() => {
    stepRef.current = step;
    stepsRef.current = steps;
  }, [step, steps]);

  // body 스크롤 잠금(공용 ref-count 락)
  useEffect(() => lockBodyScroll(), []);

  // 마운트 후: 음성 설정·저장된 진행 복원(렌더 중 localStorage 금지 — hydration)
  useEffect(() => {
    const on = readVoicePref();
    voiceOnRef.current = on;
    setVoiceOn(on);
    const saved = readSavedSession({ cycleId, rev, day, targetDay, dateKst });
    if (saved) {
      const t = Date.now();
      setStep(saved.step);
      if (saved.restEndsAt !== null && saved.restEndsAt > t) {
        setRestEndsAt(saved.restEndsAt);
        // 시작 탭(▶)에서 컨텍스트를 풀어 뒀다면 남은 시간에 비프를 다시 예약한다
        if (audioCtx && audioCtx.state === "running") {
          const at = audioCtx.currentTime + (saved.restEndsAt - t) / 1000;
          beepRef.current = { nodes: scheduleBeep(audioCtx, at), at };
        }
      }
      setNow(t);
    }
    setHydrated(true);
  }, [cycleId, rev, day, targetDay, dateKst]);

  // 진행 저장 — 복원을 마친 뒤부터. 시작 전(0스텝·휴식 없음)이면 남기지 않는다.
  useEffect(() => {
    if (!hydrated || finishedRef.current) return;
    if (step === 0 && restEndsAt === null) clearSavedSession();
    else writeSavedSession({ cycleId, rev, day, targetDay, dateKst, step, restEndsAt });
  }, [hydrated, step, restEndsAt, cycleId, rev, day, targetDay, dateKst]);

  // 언마운트: 예약 비프 취소, 음성 멈춤(이 세션이 시작한 재생만 — speakQueue 멈추기 함수 규약), 축하 타이머 정리
  useEffect(
    () => () => {
      if (beepRef.current) cancelNodes(beepRef.current.nodes);
      beepRef.current = null;
      speakStopRef.current?.();
      speakStopRef.current = null;
      if (celebrateTimerRef.current !== null) window.clearTimeout(celebrateTimerRef.current);
      celebrateTimerRef.current = null;
    },
    [],
  );

  // FLIP — 축하가 끝나 재배치된 커밋에서만 재생한다(flipFromRef가 있을 때). 복원·재진입·움직임 줄이기는 flipFromRef가
  // 비어 있어 최종 순서로 바로 그려진다. 그리기 전에 되돌려 놓아야 깜빡임이 없어 레이아웃 effect다.
  useLayoutEffect(() => {
    const first = flipFromRef.current;
    if (!first) return;
    flipFromRef.current = null;
    playFlip(listRef.current, first);
  });

  const cancelBeep = useCallback(() => {
    if (beepRef.current) cancelNodes(beepRef.current.nodes);
    beepRef.current = null;
  }, []);

  /** 탭 핸들러 안에서 — 휴식 종료 시각에 비프를 (다시) 예약 */
  const rescheduleBeep = useCallback(
    (endsAt: number) => {
      cancelBeep();
      const ctx = ensureWorkoutAudio();
      if (!ctx) return;
      const at = ctx.currentTime + Math.max(0, endsAt - Date.now()) / 1000;
      beepRef.current = { nodes: scheduleBeep(ctx, at), at };
    },
    [cancelBeep],
  );

  /** 휴식 끝 — 타이머 콜백(탭 밖)에서 불린다. 비프(예약분이 아직이면 지금)·진동·음성 */
  const finishRest = useCallback(
    (endsAt: number) => {
      if (endedForRef.current === endsAt) return;
      endedForRef.current = endsAt;
      setRestEndsAt(null);
      // 예약한 비프가 아직 안 울렸으면(컨텍스트가 멈춰 있었다 등) 지금 울린다 — 늦게 튀어나오지 않게 예약분은 취소.
      const ctx = audioCtx;
      const b = beepRef.current;
      if (ctx && ctx.state === "running") {
        if (!b || ctx.currentTime < b.at - 0.05) {
          if (b) cancelNodes(b.nodes);
          beepRef.current = { nodes: scheduleBeep(ctx, ctx.currentTime + 0.01), at: ctx.currentTime + 0.01 };
        }
      }
      vibrate();
      if (voiceOnRef.current) {
        const next = stepsRef.current[stepRef.current];
        if (next) speakStopRef.current = speakQueue([{ text: stepPhrase(next), lang: "ko-KR" }]);
      }
    },
    [],
  );

  // 휴식 카운트다운 — 종료 시각 기반(스로틀돼도 다음 틱에서 맞춰진다)
  useEffect(() => {
    if (restEndsAt === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= restEndsAt) finishRest(restEndsAt);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [restEndsAt, finishRest]);

  // 화면 꺼짐 방지(best-effort) + visible 복귀 때 재요청·타이머 즉시 갱신
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    const request = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        if (sentinel && !sentinel.released) return;
        const got = await navigator.wakeLock.request("screen");
        if (disposed) {
          void got.release().catch(() => {});
          return;
        }
        sentinel = got;
      } catch {
        /* 미지원·거부 — 조용히 넘어간다 */
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      // 백그라운드에서 멈춘 컨텍스트를 깨워 둔다(이미 탭으로 풀린 컨텍스트라 대개 허용된다 — 안 되면 다음 ✓ 탭이 푼다)
      if (audioCtx && audioCtx.state !== "running") void audioCtx.resume().catch(() => {});
      void request();
    };
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 기록 요청
  // ---------------------------------------------------------------------------

  async function sendLog(kind: WorkoutEventKind, failed: FailedAt | null) {
    if (sending) return;
    setSending(kind);
    setErrorKo(null);
    const body: WorkoutLogRequest =
      kind === "fail" && failed
        ? { cycleId, expectedRev: rev, kind: "fail", day, targetDay, failed }
        : { cycleId, expectedRev: rev, kind: "complete", day, targetDay, failed: null };
    try {
      const { status, data } = await postWorkout<WorkoutLogResponse>("/api/workout/log", body);
      if (data?.ok) {
        finishedRef.current = true;
        clearSavedSession();
        onResult({ type: "logged", kind });
        return;
      }
      if (isStaleStatus(status)) {
        finishedRef.current = true;
        clearSavedSession();
        onResult({ type: "stale", kind, messageKo: data?.messageKo ?? STALE_FALLBACK_KO });
        return;
      }
      setErrorKo(data?.messageKo ?? SAVE_ERROR_KO);
    } catch {
      setErrorKo(NETWORK_ERROR_KO);
    } finally {
      setSending(null);
    }
  }

  // ---------------------------------------------------------------------------
  // 탭 핸들러 — 오디오 잠금 해제는 전부 여기서 **동기로**
  // ---------------------------------------------------------------------------

  /**
   * 축하 끝 — 무대 문구를 거둔다. 목록에 붙잡았던 세트가 있으면 지금 위치를 재 두고 놓는다(다음 커밋에서 FLIP) — 그 세트의 체크 팝도
   * 거둔다(행이 DOM에서 옮겨질 때 다시 튀지 않게). 움직임 줄이기(hold=false)는 이미 최종 순서라 재지 않는다(FLIP 없음).
   */
  function endCelebration(round: number, hold: boolean) {
    celebrateTimerRef.current = null;
    if (hold) flipFromRef.current = measureFlip(listRef.current);
    setCelebration(null);
    if (hold) setPopStep((p) => (p !== null && Math.floor(p / 2) === round ? null : p));
  }

  /**
   * 세트(라운드) 완료 축하 — **표시만**. 휴식·비프·저장은 호출 전에 이미 진행됐다. 휴식 무대의 "🎉 n세트 완료!"는 움직임 줄이기에서도
   * 같은 시간 보인다(움직임 없이). 움직임 줄이기면 목록은 붙잡지 않아 즉시 재배치되고 짧은 진동도 생략한다.
   * 스크린리더 알림은 숨은 role="status" 한 곳에서만, 움직임과 무관하게 늘 한다(무대·목록의 문구는 aria-hidden — 두 번 읽히지 않게).
   */
  function celebrateRound(round: number) {
    setLiveMsg(`${round + 1}세트 완료!`);
    if (celebrateTimerRef.current !== null) {
      window.clearTimeout(celebrateTimerRef.current); // 앞 축하가 아직이면 그냥 넘긴다(연타 가드 때문에 실제로는 생기지 않는다)
      celebrateTimerRef.current = null;
    }
    const hold = !prefersReducedMotion();
    if (hold) vibrate(40);
    setCelebration({ round, hold });
    celebrateTimerRef.current = window.setTimeout(() => endCelebration(round, hold), CELEBRATE_MS);
  }

  /** 휴식을 막 시작한 ✓의 연타인가 — 같은 자리에 뜬 휴식 버튼(2분/3분·+30초·건너뛰기)을 누른 것으로 치지 않는다(QA D1) */
  function restTapTooSoon(): boolean {
    return Date.now() - restStartedAtRef.current < CHAIN_TAP_GUARD_MS;
  }

  function onDone() {
    if (sending || failOpen || restEndsAt !== null) return;
    if (Date.now() - chainedAtRef.current < CHAIN_TAP_GUARD_MS) return; // 풀업 ✓의 연타가 푸시업까지 넘기지 않게
    // 오디오 잠금 해제는 휴식을 시작하지 않는 풀업 ✓에서도 한다 — 탭 안에서만 풀리므로 매 ✓마다(무해·멱등)
    ensureWorkoutAudio();
    if (voiceOnRef.current) unlockSpeechPlayback();
    if (step >= LAST_STEP) {
      // 마지막 스텝 — 타이머 없이 곧바로 완료 기록
      void sendLog("complete", null);
      return;
    }
    if (!restFollowsStep(step)) {
      // 풀업 — 쉬지 않고 곧바로 같은 세트의 푸시업(§19-1 슈퍼세트). 휴식·비프 예약 없음. 그 칸 체크만 튄다(재배치 없음).
      chainedAtRef.current = Date.now();
      setPopStep(step);
      setStep(step + 1);
      return;
    }
    // 푸시업 — 세트(라운드) 끝. 휴식 타이머 시작 + 종료 시각에 비프 예약(여기까지가 진행 — 축하는 그 뒤의 표시일 뿐)
    const t = Date.now();
    const endsAt = t + restMs;
    restStartedAtRef.current = t;
    rescheduleBeep(endsAt);
    setNow(t);
    setRestEndsAt(endsAt);
    setPopStep(step);
    setStep(step + 1);
    celebrateRound(steps[step]?.setIndex ?? Math.floor(step / 2));
  }

  function pickRest(ms: number) {
    if (restTapTooSoon()) return;
    if (restEndsAt !== null) {
      // 쉬는 중에 바꾸면 이번 휴식 길이도 그만큼 늘리거나 줄인다(시작 시각 기준 2분 ↔ 3분)
      const endsAt = restEndsAt + (ms - restMs);
      rescheduleBeep(endsAt);
      setNow(Date.now());
      setRestEndsAt(endsAt);
    }
    setRestMs(ms);
  }

  function bumpRest() {
    if (restEndsAt === null || restTapTooSoon()) return;
    const endsAt = Math.max(restEndsAt, Date.now()) + REST_BUMP_MS;
    rescheduleBeep(endsAt);
    setNow(Date.now());
    setRestEndsAt(endsAt);
  }

  function skipRest() {
    if (restTapTooSoon()) return;
    cancelBeep();
    setRestEndsAt(null);
  }

  function toggleVoice() {
    const on = !voiceOnRef.current;
    voiceOnRef.current = on;
    setVoiceOn(on);
    writeVoicePref(on);
    if (on) unlockSpeechPlayback();
    else {
      speakStopRef.current?.();
      speakStopRef.current = null;
    }
  }

  function openFail() {
    setFailReps(null);
    setErrorKo(null);
    setFailOpen(true);
  }

  function submitFail() {
    const cur = steps[step];
    if (!cur) return;
    void sendLog("fail", { exercise: cur.exercise, setIndex: cur.setIndex, reps: failReps });
  }

  // ---------------------------------------------------------------------------
  // 렌더
  // ---------------------------------------------------------------------------

  const cur = steps[step];
  const resting = restEndsAt !== null;
  const remaining = resting ? restEndsAt - now : 0;
  const held = celebration?.hold ? celebration.round : null;
  const { order, doneFrom } = roundDisplayOrder(step, held);
  const busy = sending !== null;
  /** 지금(쉬는 중이면 쉬고 나서) 할 스텝이 풀업이면 같은 세트의 푸시업 — 휴식 미리보기가 세트 전체를 보인다 */
  const partner =
    cur && cur.exercise === "pullup" ? steps.find((x) => x.setIndex === cur.setIndex && x.step !== cur.step) : undefined;
  /** ✓ 다음에 올 것 — 버튼 글자로 미리 알린다(풀업 → 바로 푸시업 / 푸시업 → 휴식 / 마지막 → 기록) */
  const doneLabel =
    sending === "complete"
      ? "기록하는 중…"
      : step >= LAST_STEP
        ? "✓ 완료 — 오늘 끝!"
        : restFollowsStep(step)
          ? "✓ 완료 → 휴식"
          : `✓ 완료 → 바로 ${steps[step + 1] ? exerciseKo(steps[step + 1].exercise) : "다음"}`;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label={`Day ${day} 운동 세션`}>
      <div className={s.inner}>
        <header className={s.head}>
          <div className="min-w-0">
            <p className="t-caption">💪 아빠의 운동 · 세션</p>
            <h2 className="t-section-title mt-0.5">
              Day {day} 운동{isRepeat && <span className="t-meta-chip ml-2 align-middle">Day {targetDay} 목표로 복귀</span>}
            </h2>
          </div>
          <button type="button" className="u-navbtn flex-none" onClick={onClose} disabled={busy}>
            닫기
          </button>
        </header>

        {/* 주의사항(원안 3항) — 세션 상단에 늘. "세트 사이"의 세트 = 풀업+푸시업 한 묶음 */}
        <ul className={`u-box ${s.cautions}`} aria-label="주의사항">
          {WORKOUT_CAUTIONS.map((c) => (
            <li key={c} className="t-caption text-ink-2">
              ⚠️ {c}
            </li>
          ))}
        </ul>

        {errorKo && (
          <p role="alert" className={`t-question-ko ${s.notice}`}>
            ⚠️ {errorKo}
          </p>
        )}

        {/* 현재 스텝 / 휴식 / 실패 입력 */}
        {failOpen && cur ? (
          <section className={s.stage} aria-label="실패 기록">
            <p className="t-caption">
              {cur.setIndex + 1} / {SETS_PER_EXERCISE} 세트
            </p>
            <p className="t-section-title mt-1">{stepName(cur)}에서 멈췄어요</p>
            <p className="t-caption mt-1">잘 멈췄어요. 이 세트 전까지는 다 한 것으로 기록돼요. 내일은 회복 휴식이에요.</p>
            <label htmlFor="workout-session-fail-reps" className="u-label mt-4">
              이 세트에서 몇 회 했나요? (목표 {cur.reps}회 · 선택)
            </label>
            <RepsSelect id="workout-session-fail-reps" max={cur.reps} value={failReps} onChange={setFailReps} disabled={busy} />
            <div className={s.actions}>
              <button type="button" className="u-btn u-btn-primary" onClick={submitFail} disabled={busy}>
                {sending === "fail" ? "기록하는 중…" : "실패로 기록하고 끝내기"}
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={() => setFailOpen(false)} disabled={busy}>
                돌아가기
              </button>
            </div>
          </section>
        ) : resting ? (
          <section className={s.stage} aria-label="휴식">
            {/* 캡션 자리 — 축하 중엔 같은 자리에 "🎉 n세트 완료!"(목록이 첫 화면 밖인 작은 폰에서도 보이게, 자리 높이를 미리 잡아 튀지 않는다).
                캡션 글자는 스크린리더용으로 남기고, 축하 문구는 aria-hidden(알림은 숨은 role="status" 한 곳) */}
            <p className={s.restCaption}>
              <span className={cx("t-caption", celebration && "sr-only")}>휴식{partner && cur ? ` · ${cur.setIndex}세트 끝` : ""}</span>
              {celebration && (
                <span key={celebration.round} className={s.stageCheer} aria-hidden>
                  🎉 {celebration.round + 1}세트 완료!
                </span>
              )}
            </p>
            <p className={s.clock} aria-live="off">
              {formatClock(remaining)}
            </p>
            {cur &&
              (partner ? (
                <>
                  <p className="t-question-ko text-ink">
                    다음 · <b className="font-medium">{cur.setIndex + 1}세트</b>
                  </p>
                  <p className="t-question-ko mt-1 text-ink">
                    {exerciseKo(cur.exercise)} {cur.reps}회 → 바로 {exerciseKo(partner.exercise)} {partner.reps}회
                  </p>
                </>
              ) : (
                <p className="t-question-ko text-ink">
                  다음 · <b className="font-medium">{stepLabel(cur)}</b>
                </p>
              ))}
            <div className={s.restRow} role="group" aria-label="휴식 시간">
              {REST_PRESETS.map((p) => (
                <button
                  key={p.ms}
                  type="button"
                  aria-pressed={restMs === p.ms}
                  onClick={() => pickRest(p.ms)}
                  className={`u-btn ${restMs === p.ms ? "border-accent bg-accent-soft text-accent-ink" : "u-btn-secondary"}`}
                >
                  {p.label}
                </button>
              ))}
              <button type="button" className="u-btn u-btn-secondary" onClick={bumpRest}>
                +30초
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={skipRest}>
                건너뛰기
              </button>
            </div>
          </section>
        ) : cur ? (
          <section className={s.stage} aria-label="지금 할 세트">
            <p className="t-caption">
              {cur.setIndex + 1} / {SETS_PER_EXERCISE} 세트{cur.exercise === "pushup" ? " · 쉬지 않고 이어서" : ""}
            </p>
            <p className="t-section-title mt-1">{stepName(cur)}</p>
            <p className={s.reps}>
              {cur.reps}
              <span className={s.repsUnit}>회</span>
            </p>
            <div className={s.actions}>
              <button type="button" className="u-btn u-btn-primary" onClick={onDone} disabled={busy}>
                {doneLabel}
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={openFail} disabled={busy}>
                ✗ 실패
              </button>
            </div>
          </section>
        ) : null}

        <div className={s.voiceRow}>
          <button type="button" aria-pressed={voiceOn} onClick={toggleVoice} className="u-navbtn">
            {voiceOn ? "🔊 음성 안내 켬" : "🔇 음성 안내 끔"}
          </button>
          <p className="t-caption">알림은 화면이 켜져 있을 때 가장 잘 돼요.</p>
        </div>

        {/* 세트(라운드) 목록 — 한 세트 = 풀업 + 푸시업, 휴식은 세트 사이에만(엔진 stepFollowsRest로 휴식 줄을 그린다).
            순서는 현재 스텝에서 파생: 지금 할 세트 맨 위 → 남은 세트 → 완료 세트 맨 아래(roundDisplayOrder).
            완료 ✓(accent)·현재 ▶(accent-soft)·남은 것(ink) / 지금 세트는 테두리 accent, 쉬는 중이면 그 휴식 줄이 accent */}
        <p className="sr-only" role="status" aria-live="polite">
          {liveMsg}
        </p>
        <ol
          ref={listRef}
          className={s.rounds}
          aria-label={`오늘의 ${SETS_PER_EXERCISE}세트 — 지금 할 세트가 맨 위, 끝낸 세트는 맨 아래. 한 세트는 풀업과 푸시업`}
        >
          {/* 한 줄로 편 배열(flatMap) — 행이 key로 옮겨 다녀야 DOM이 재사용되고 FLIP이 같은 요소를 움직인다 */}
          {order.flatMap((r, i) => {
            const pair = rounds[r];
            const first = pair?.[0];
            const last = pair?.[pair.length - 1];
            if (!pair || !first || !last) return [];
            const roundState = last.step < step ? "done" : first.step <= step && !resting ? "current" : "todo";
            const isHeld = held === r;
            // 이 세트 앞의 휴식 — 규칙은 엔진 stepFollowsRest 하나. 지나간 휴식은 그리지 않는다(지금 쉬는 중 · 앞으로 쉴 것만)
            const restState = !stepFollowsRest(first.step)
              ? null
              : resting && step === first.step
                ? "current"
                : first.step > step
                  ? "todo"
                  : null;
            const stateKo =
              roundState === "done" ? "완료" : first.step <= step ? (resting ? "휴식 뒤 할 세트" : "지금 할 세트") : "남은 세트";
            const divider =
              i === doneFrom && i > 0 ? (
                <li key="done-divider" data-flip="done-divider" className={s.doneDivider} aria-hidden>
                  끝낸 세트
                </li>
              ) : null;
            const row = (
              <li key={`r${r}`} data-flip={`r${r}`} className={cx(s.roundItem, isHeld && s.holding)}>
                {restState && (
                  <p className={cx(s.restGap, restState === "current" && s.current)} aria-hidden>
                    {restState === "current" ? "지금 휴식 중" : "휴식"}
                  </p>
                )}
                <div className={cx(s.round, roundState === "done" && s.done, roundState === "current" && s.current, isHeld && s.celebrate)}>
                  <span className={s.roundName}>
                    {r + 1}세트<span className="sr-only"> · {stateKo}</span>
                  </span>
                  <span className={s.pair}>
                    {pair.map((st) => {
                      const cs = st.step < step ? "done" : st.step === step && !resting ? "current" : "todo";
                      return (
                        <span
                          key={st.step}
                          className={cx(s.cell, cs === "done" && s.done, cs === "current" && s.current)}
                          aria-current={cs === "current" ? "step" : undefined}
                        >
                          <span className={cx(s.mark, cs === "done" && popStep === st.step && s.pop)} aria-hidden>
                            {cs === "done" ? "✓" : cs === "current" ? "▶" : ""}
                          </span>
                          {exerciseKo(st.exercise)} {st.reps}회
                        </span>
                      );
                    })}
                  </span>
                  {isHeld && (
                    <>
                      <span className={s.burst} aria-hidden>
                        {BURST.map((b, k) => (
                          <i
                            key={k}
                            style={{ "--dx": `${b.dx}px`, "--dy": `${b.dy}px`, animationDelay: `${b.delay}ms` } as CSSProperties}
                          >
                            {b.e}
                          </i>
                        ))}
                      </span>
                      <span className={s.cheer} aria-hidden>
                        🎉 {r + 1}세트 완료!
                      </span>
                    </>
                  )}
                </div>
              </li>
            );
            return divider ? [divider, row] : [row];
          })}
        </ol>
      </div>
    </div>
  );
}

"use client";

/**
 * 운동 세션 모드(`▶ 운동 시작`) — 전면 오버레이 (SPEC §19-6).
 *
 * - 슈퍼세트 10스텝(풀업1 → 푸시업1 → 풀업2 …)은 엔진 `supersetSteps(target)`이 만든다(화면이 순서를 복제하지 않는다).
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
 * - 기록 요청의 결과는 부모가 처리한다(onResult) — ok면 새로고침, 409·404면 메시지 + 새로고침(자동 완료 409는 부모가
 *   새로고침 뒤 같은 Day의 recorded_today인지 보고 성공으로 보여 준다). 그 밖 오류는 세션 안에 남아 다시 누를 수 있다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { SETS_PER_EXERCISE, supersetSteps, type FailedAt, type SetPair, type WorkoutEventKind, type WorkoutStep } from "@/lib/workout";
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
    const restEndsAt = typeof v.restEndsAt === "number" && Number.isFinite(v.restEndsAt) ? v.restEndsAt : null;
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

/** 그날의 음성 안내 문구 10개 — 세션 시작 탭에서 prefetchSpeech(…, "ko-KR")로 미리 받는다(§19-6) */
export function sessionPhrases(target: SetPair): string[] {
  return supersetSteps(target).map(stepPhrase);
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

function vibrate(): void {
  try {
    navigator.vibrate?.([200, 100, 200]);
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

  const voiceOnRef = useRef(true);
  const beepRef = useRef<{ nodes: OscillatorNode[]; at: number } | null>(null);
  const speakStopRef = useRef<(() => void) | null>(null);
  /** 이미 처리한 휴식 종료 시각 — 타이머가 두 번 울리지 않게 */
  const endedForRef = useRef<number | null>(null);
  /** 기록이 끝났다(ok·409) — 이후 진행을 다시 저장하지 않는다 */
  const finishedRef = useRef(false);
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

  // 언마운트: 예약 비프 취소, 음성 멈춤(이 세션이 시작한 재생만 — speakQueue 멈추기 함수 규약)
  useEffect(
    () => () => {
      if (beepRef.current) cancelNodes(beepRef.current.nodes);
      beepRef.current = null;
      speakStopRef.current?.();
      speakStopRef.current = null;
    },
    [],
  );

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

  function onDone() {
    if (sending || failOpen || restEndsAt !== null) return;
    ensureWorkoutAudio();
    if (voiceOnRef.current) unlockSpeechPlayback();
    if (step >= LAST_STEP) {
      // 마지막 스텝 — 타이머 없이 곧바로 완료 기록
      void sendLog("complete", null);
      return;
    }
    const t = Date.now();
    const endsAt = t + restMs;
    rescheduleBeep(endsAt);
    setNow(t);
    setRestEndsAt(endsAt);
    setStep(step + 1);
  }

  function pickRest(ms: number) {
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
    if (restEndsAt === null) return;
    const endsAt = Math.max(restEndsAt, Date.now()) + REST_BUMP_MS;
    rescheduleBeep(endsAt);
    setNow(Date.now());
    setRestEndsAt(endsAt);
  }

  function skipRest() {
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
  const busy = sending !== null;

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

        {/* 주의사항(원안 3항) — 세션 상단에 늘 */}
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
              {step + 1} / {TOTAL_STEPS} 스텝
            </p>
            <p className="t-section-title mt-1">
              {exerciseKo(cur.exercise)} {cur.setIndex + 1}세트에서 멈췄어요
            </p>
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
            <p className="t-caption">휴식</p>
            <p className={s.clock} aria-live="off">
              {formatClock(remaining)}
            </p>
            {cur && (
              <p className="t-question-ko text-ink">
                다음 · <b className="font-medium">{stepLabel(cur)}</b>
              </p>
            )}
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
              {step + 1} / {TOTAL_STEPS} 스텝
            </p>
            <p className="t-section-title mt-1">
              {exerciseKo(cur.exercise)} {cur.setIndex + 1}세트
            </p>
            <p className={s.reps}>
              {cur.reps}
              <span className={s.repsUnit}>회</span>
            </p>
            <div className={s.actions}>
              <button type="button" className="u-btn u-btn-primary" onClick={onDone} disabled={busy}>
                {sending === "complete" ? "기록하는 중…" : step >= LAST_STEP ? "✓ 완료 — 오늘 끝!" : "✓ 완료"}
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

        {/* 10스텝 목록 — 완료 ✓(accent)·현재 ▶·남은 것(ink-3) */}
        <ol className={s.steps} aria-label="오늘의 10스텝">
          {steps.map((st) => {
            const state = st.step < step ? "done" : st.step === step ? "current" : "todo";
            return (
              <li key={st.step} className={`${s.stepRow} ${s[state]}`} aria-current={state === "current" ? "step" : undefined}>
                <span className={s.stepMark} aria-hidden>
                  {state === "done" ? "✓" : state === "current" ? "▶" : st.step + 1}
                </span>
                <span className="min-w-0 flex-1">{stepLabel(st)}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

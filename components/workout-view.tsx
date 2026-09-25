"use client";

/**
 * 아빠의 운동 `/workout` 화면 (SPEC §19-6) — 클라이언트. 데이터는 서버 컴포넌트(app/workout/page.tsx)가 엔진 `snapshot()`으로
 * 계산해 props로 준다(오늘·내일은 KST 문자열 — 렌더 중 new Date()·localStorage 금지).
 *
 * ⚠️ **화면은 규칙을 다시 구현하지 않는다**(§19-2). 오늘 카드의 문구는 전부 `TodayStatus` 변형의 필드에서만 파생하고,
 *   Day·목표·일정·진행률·볼륨은 엔진이 준 값을 그대로 보인다. 미리보기(RM 폼)도 엔진 순수 함수로 계산한다.
 *
 * - 변경 흐름(§19-5): fetch → 계약 타입(lib/workout-contract) → ok면 `router.refresh()`. 409·404면 messageKo를 보이고
 *   `router.refresh()`. 요청 본문엔 동시성 토큰(`expectedRev` / `expectedActiveCycleId`)을 싣는다.
 *   기록·취소·사이클 시작이 ok거나 409(서버 상태가 이미 바뀜)면 STREAK_REFRESH_EVENT도 쏜다 — 상단 스트릭 💪 운동 트랙 즉시 갱신(§17-7, 시험 저장과 같은 관용구).
 * - 단일 비행: 요청 중이거나 새로고침(transition)이 도는 동안 변경 버튼은 전부 disabled — 낡은 rev로 두 번 보내지 않게.
 * - 화면이 다시 보이면(`visibilitychange`) `router.refresh()` — 자정을 넘겨 켜 둔 화면이 어제 상태를 보이지 않게
 *   (version-watch 관용구). **세션 중에는 건너뛴다**(세션이 든 목표·rev가 바뀌면 안 된다).
 * - 마지막 기록 취소·RM 다시 재기는 화면 하단에 작게, **화면 안 두 단계 확인 패널**(ja-dialog-library-view 관용구).
 *   `danger`는 이 확인 패널에만 쓴다(DESIGN §2). 완료/실패 표시는 accent·ink-3 명도 차 + 글리프(초록·빨강 금지).
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { prefetchSpeech, unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import {
  CYCLE_DAYS,
  DEFAULT_RM,
  SETS_PER_EXERCISE,
  supersetSteps,
  TOTAL_WORKOUT_DAYS,
  type DayKind,
  type WorkoutExercise,
} from "@/lib/workout";
import type {
  CycleSnapshot,
  TodayStatus,
  WorkoutCycleRequest,
  WorkoutCycleResponse,
  WorkoutHistoryRow,
  WorkoutLogRequest,
  WorkoutLogResponse,
  WorkoutUndoRequest,
  WorkoutUndoResponse,
} from "@/lib/workout-contract";
import WorkoutRmForm, { type WorkoutRmFormValue } from "./workout-rm-form";
import WorkoutSession, {
  clearSavedSession,
  ensureWorkoutAudio,
  readSavedSession,
  readVoicePref,
  sessionPhrases,
  type SessionMatch,
  type SessionResult,
} from "./workout-session";
import {
  eventText,
  exerciseKo,
  formatDotDate,
  formatShortDate,
  isStaleStatus,
  ladderText,
  NETWORK_ERROR_KO,
  postWorkout,
  RepsSelect,
  SAVE_ERROR_KO,
  SetTable,
  STALE_FALLBACK_KO,
  stepName,
  tomorrowText,
  upcomingText,
  WORKOUT_CAUTIONS,
} from "./workout-shared";
import s from "./workout-view.module.css";

export interface WorkoutViewProps {
  /** KST 오늘 `YYYY-MM-DD` — 서버 계산 */
  today: string;
  /** KST 내일 — 시작일 "내일" 버튼 표시용 */
  tomorrow: string;
  /** 활성 사이클 스냅샷(없으면 처음 시작 화면) */
  snapshot: CycleSnapshot | null;
  /** 닫힌 사이클 — cycleNo 내림차순, RM 변화는 다음 사이클 rm에서 파생(nextRm) */
  history: WorkoutHistoryRow[];
}

type Busy = "complete" | "fail" | "undo" | "cycle";
type Panel = "undo" | "remeasure" | null;

/** 계획표의 쉬는 날 이름 — DayKind 표시 매핑 */
const REST_KIND_KO: Record<Exclude<DayKind, "workout">, string> = {
  rest: "휴식",
  cycle_rest: "마무리 휴식",
  retest: "RM 재측정",
};

function rmChange(from: number, to: number | undefined): string {
  return to === undefined || to === from ? String(from) : `${from} → ${to}`;
}

/** 브리핑 셋째 줄 — 오늘 목표 합계(운동일) 또는 오늘의 성격(변형에서만 파생) */
function todayGoalText(t: TodayStatus): string {
  switch (t.kind) {
    case "workout":
      return `오늘 목표 풀업 ${t.totals.pullup}회 · 푸시업 ${t.totals.pushup}회`;
    case "rest":
      return t.cycleEnd ? `오늘은 사이클 마무리 휴식 ${t.index}/${t.of}` : "오늘은 휴식";
    case "recovery":
      return "오늘은 회복 휴식";
    case "recorded_today":
      return "오늘 기록 끝";
    case "retest":
      return "오늘은 RM 재측정";
    case "not_started":
      return `시작까지 ${t.daysUntil}일`;
  }
}

export default function WorkoutView({ today, tomorrow, snapshot: snap, history }: WorkoutViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  /** 세션 자동 완료가 409를 받았다 — 새로고침 뒤 같은 Day의 recorded_today(성공)면 성공으로 보인다(§19-6) */
  const [verify, setVerify] = useState<{ day: number; fallbackKo: string } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  // ✗ 실패 기록(세션 없이) — 운동·세트·횟수
  const [failOpen, setFailOpen] = useState(false);
  const [failEx, setFailEx] = useState<WorkoutExercise>("pullup");
  const [failSet, setFailSet] = useState(0);
  const [failReps, setFailReps] = useState<number | null>(null);

  // 세션
  const [sessionOpen, setSessionOpen] = useState(false);
  /** 저장된 진행이 있으면 "이어서 하기 · 푸시업 2세트부터" — 마운트 후 effect에서만 읽는다 */
  const [resumeStep, setResumeStep] = useState<number | null>(null);
  const sessionOpenRef = useRef(false);
  const prefetchStopRef = useRef<(() => void) | null>(null);

  const t = snap?.today ?? null;
  const locked = busy !== null || isPending;
  /** 저장된 진행이 이어질 스텝(엔진 순서 그대로) — "이어서 하기" 버튼 글자가 세션 무대 제목과 같은 이름을 쓴다 */
  const resumeAt = resumeStep !== null && t && t.kind === "workout" ? supersetSteps(t.target)[resumeStep] : undefined;

  const refresh = () => startTransition(() => router.refresh());

  // 오늘이 운동일일 때만 세션이 뜬다 — 복원 조건(cycleId·rev·day·targetDay·dateKst)
  const match: SessionMatch | null =
    snap && t && t.kind === "workout"
      ? { cycleId: snap.cycleId, rev: snap.rev, day: t.day, targetDay: t.targetDay, dateKst: today }
      : null;
  const mCycle = match?.cycleId ?? null;
  const mRev = match?.rev ?? null;
  const mDay = match?.day ?? null;
  const mTarget = match?.targetDay ?? null;

  useEffect(() => {
    sessionOpenRef.current = sessionOpen;
  }, [sessionOpen]);

  // 저장된 세션 진행 확인(마운트·상태 변경 후) — 일치하지 않으면 readSavedSession이 조용히 버린다.
  // 오늘이 운동일이 아니면 남은 진행은 전부 낡은 것이다(기록됨·휴식·다른 기기 기록) → 지운다.
  useEffect(() => {
    if (mCycle === null || mRev === null || mDay === null || mTarget === null) {
      clearSavedSession();
      setResumeStep(null);
      return;
    }
    const saved = readSavedSession({ cycleId: mCycle, rev: mRev, day: mDay, targetDay: mTarget, dateKst: today });
    setResumeStep(saved ? saved.step : null);
  }, [mCycle, mRev, mDay, mTarget, today]);

  // 화면 복귀 → 새로고침(세션 중 제외). version-watch.tsx의 visibilitychange 관용구.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || sessionOpenRef.current) return;
      startTransition(() => router.refresh());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  // 화면을 떠나면 안내 문구 프리페치 중단
  useEffect(() => () => prefetchStopRef.current?.(), []);

  // ---------------------------------------------------------------------------
  // 변경 요청 — 단일 비행, ok → refresh, 409·404 → 메시지 + refresh
  // ---------------------------------------------------------------------------

  async function mutate<Res extends { ok: boolean }>(kind: Busy, url: string, body: unknown, onOk?: () => void) {
    if (busy !== null || isPending) return;
    setBusy(kind);
    setErrorKo(null);
    setVerify(null);
    try {
      const { status, data } = await postWorkout<Res>(url, body);
      if (data?.ok) {
        onOk?.();
        window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 스트릭 헤드라인 💪 운동 트랙 즉시 갱신(§17-7)
        refresh();
        return;
      }
      const messageKo = (data as { messageKo?: string } | null)?.messageKo;
      if (isStaleStatus(status)) {
        // 409 = 서버 상태가 이미 바뀌었다(다른 탭·연타) — 스트릭도 다시 읽는다(읽기 1회, §17-7)
        window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT));
        // 완료 기록이 409면 응답만 잃고 이미 들어갔을 수 있다 — 세션 자동 완료와 같은 확인(새로고침 뒤 recorded_today면 성공)
        if (kind === "complete" && t && t.kind === "workout") setVerify({ day: t.day, fallbackKo: messageKo ?? STALE_FALLBACK_KO });
        else setErrorKo(messageKo ?? STALE_FALLBACK_KO);
        setPanel(null);
        setFailOpen(false);
        refresh();
        return;
      }
      setErrorKo(messageKo ?? SAVE_ERROR_KO);
    } catch {
      setErrorKo(NETWORK_ERROR_KO);
    } finally {
      setBusy(null);
    }
  }

  function logComplete() {
    if (!snap || !t || t.kind !== "workout") return;
    const body: WorkoutLogRequest = {
      cycleId: snap.cycleId,
      expectedRev: snap.rev,
      kind: "complete",
      day: t.day,
      targetDay: t.targetDay,
      failed: null,
    };
    void mutate<WorkoutLogResponse>("complete", "/api/workout/log", body, () => clearSavedSession());
  }

  function logFail() {
    if (!snap || !t || t.kind !== "workout") return;
    const body: WorkoutLogRequest = {
      cycleId: snap.cycleId,
      expectedRev: snap.rev,
      kind: "fail",
      day: t.day,
      targetDay: t.targetDay,
      failed: { exercise: failEx, setIndex: failSet, reps: failReps },
    };
    void mutate<WorkoutLogResponse>("fail", "/api/workout/log", body, () => {
      clearSavedSession();
      setFailOpen(false);
    });
  }

  function undoLast() {
    if (!snap) return;
    const body: WorkoutUndoRequest = { cycleId: snap.cycleId, expectedRev: snap.rev };
    void mutate<WorkoutUndoResponse>("undo", "/api/workout/undo", body, () => setPanel(null));
  }

  function startCycle(v: WorkoutRmFormValue) {
    const body: WorkoutCycleRequest = {
      pullupRm: v.pullupRm,
      pushupRm: v.pushupRm,
      start: v.start,
      expectedActiveCycleId: snap?.cycleId ?? null,
    };
    void mutate<WorkoutCycleResponse>("cycle", "/api/workout/cycle", body, () => setPanel(null));
  }

  // ---------------------------------------------------------------------------
  // 세션
  // ---------------------------------------------------------------------------

  /**
   * ▶ 탭 — 오디오를 **탭 안에서 동기로** 풀고, 음성 안내가 켜져 있으면 휴식 뒤 안내 문구 4개를 미리 받는다.
   * 휴식은 세트(풀업+푸시업) 사이에만 있어 휴식 끝에 읽히는 건 2~5세트 풀업 안내뿐이다 — 대상 고르기는 sessionPhrases 한 곳(§19-6).
   */
  function openSession() {
    if (!t || t.kind !== "workout" || locked) return;
    ensureWorkoutAudio();
    if (readVoicePref()) {
      unlockSpeechPlayback();
      prefetchStopRef.current?.();
      prefetchStopRef.current = prefetchSpeech(sessionPhrases(t.target), "ko-KR");
    }
    setErrorKo(null);
    setVerify(null);
    setPanel(null);
    setFailOpen(false);
    setSessionOpen(true);
  }

  function closeSession() {
    setSessionOpen(false);
    // 닫아도 진행은 남는다 — 버튼 글자("이어서 하기")를 다시 맞춘다
    setResumeStep(match ? (readSavedSession(match)?.step ?? null) : null);
  }

  function onSessionResult(r: SessionResult) {
    setSessionOpen(false);
    setResumeStep(null);
    // 세션이 기록을 저장했다(ok) — 스트릭 헤드라인 즉시 갱신(§17-7). 세션 오버레이(z:20)가 닫히면 바로 보인다.
    // 409(stale)도 서버 상태가 바뀌었다는 뜻이라 스트릭을 다시 읽는다 — 이미 기록돼 있었으면 🔥가 바로 따라온다
    if (r.type === "logged" || r.type === "stale") window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT));
    if (r.type === "stale") {
      if (r.kind === "complete" && t && t.kind === "workout") setVerify({ day: t.day, fallbackKo: r.messageKo });
      else setErrorKo(r.messageKo);
    }
    refresh();
  }

  // 자동 완료 409의 확인 결과 — 새로고침이 끝난 뒤 props에서 판정(변형에서만 파생)
  let verifyNotice: { ok: boolean; text: string } | null = null;
  if (verify) {
    if (isPending) verifyNotice = { ok: true, text: "기록 상태를 확인하는 중이에요…" };
    else if (t && t.kind === "recorded_today" && t.day === verify.day && t.outcome !== "fail")
      verifyNotice = { ok: true, text: "✅ 오늘 기록이 이미 들어가 있어요 — 완료로 처리됐어요." };
    else verifyNotice = { ok: false, text: verify.fallbackKo };
  }

  // ---------------------------------------------------------------------------
  // 렌더
  // ---------------------------------------------------------------------------

  const notices = (
    <>
      {errorKo && (
        <p role="alert" className={`t-question-ko ${s.warn}`}>
          ⚠️ {errorKo}
        </p>
      )}
      {verifyNotice && (
        <p role="status" className={`t-question-ko ${verifyNotice.ok ? "u-box-accent text-accent-ink" : s.warn}`}>
          {verifyNotice.ok ? "" : "⚠️ "}
          {verifyNotice.text}
        </p>
      )}
    </>
  );

  // ── 처음 시작: 활성 사이클 없음 ──
  if (!snap || !t) {
    return (
      <div className="flex flex-col gap-6">
        {notices}
        <section aria-label="처음 시작" className="u-card">
          <div className="u-cardbar" />
          <div className="flex flex-col gap-4 p-4">
            <div>
              <h2 className="t-section-title">처음 시작 — RM을 알려 주세요</h2>
              <p className="t-lead mt-1">
                RM은 반동 없는 정자세로 한 번에 할 수 있는 최대 개수예요. 이걸로 27일 사다리를 계산해요.
              </p>
              <p className="t-caption mt-2">
                풀업 1세트 → 쉬지 않고 푸시업 1세트 → 2~3분 휴식 → 풀업 2세트 → … 5세트. 6일 블록 4개(5일 운동 + 1일 휴식) 뒤
                마무리 휴식 3일, 27일째에 RM을 다시 재요.
              </p>
            </div>
            <WorkoutRmForm
              mode="setup"
              initialRm={history[0]?.rm ?? DEFAULT_RM}
              defaultStart="today"
              today={today}
              tomorrow={tomorrow}
              disabled={locked}
              submitLabel="이 RM으로 시작하기"
              onSubmit={startCycle}
            />
          </div>
        </section>
        <HistorySection history={history} />
      </div>
    );
  }

  const failTarget = t.kind === "workout" ? t.target[failEx][failSet] : 0;
  const upcomingList = t.kind === "retest" ? [] : snap.upcoming;

  return (
    <div className="flex flex-col gap-6">
      {notices}

      {/* ── 브리핑 — 서두에 군더더기 없이 ── */}
      <section aria-label="브리핑" className="u-box flex flex-col gap-1">
        <p className="t-section-title">
          Day {t.displayDay} / {CYCLE_DAYS} · 사이클 {snap.cycleNo}
        </p>
        <p className="t-question-ko text-ink">
          완료 {snap.progress.done}/{snap.progress.total}일 ({snap.progress.pct}%)
        </p>
        <div className={s.progress} aria-hidden>
          <div className={s.progressFill} style={{ width: `${snap.progress.pct}%` }} />
        </div>
        <p className="t-question-ko text-ink">{todayGoalText(t)}</p>
        <p className="t-caption mt-1">⚠️ {WORKOUT_CAUTIONS.join(" · ")}</p>
      </section>

      {/* ── 오늘 카드 — TodayStatus 변형별 ── */}
      <section aria-label="오늘" className="u-card">
        <div className="u-cardbar" />
        <div className="flex flex-col gap-4 p-4">
          <p className="t-caption">오늘 · {formatShortDate(today)}</p>

          {t.kind === "workout" && (
            <>
              <h2 className="t-section-title">🏋️ Day {t.day} 운동</h2>
              {t.isRepeat && (
                <p className="u-box-accent t-question-ko text-accent-ink">
                  실패 후 복귀 — Day {t.targetDay} 목표로 한 번, 성공하면 Day {t.day} 재도전
                </p>
              )}
              {t.retestHint && (
                <p className="u-box t-question-ko text-ink">💡 같은 Day에서 두 번 이상 막혔어요 — RM 재측정을 고려해 보세요</p>
              )}
              <SetTable target={t.target} caption={t.isRepeat ? `Day ${t.targetDay} 목표` : undefined} />
              <div className="flex flex-col gap-2">
                <button type="button" className="u-btn u-btn-primary" onClick={openSession} disabled={locked}>
                  ▶ {resumeAt ? `이어서 하기 · ${stepName(resumeAt)}부터` : "운동 시작"}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className="u-btn u-btn-secondary" onClick={logComplete} disabled={locked}>
                    {busy === "complete" ? "기록하는 중…" : "✓ 전부 해냈어요"}
                  </button>
                  <button
                    type="button"
                    className="u-btn u-btn-secondary"
                    aria-expanded={failOpen}
                    onClick={() => {
                      setFailOpen((v) => !v);
                      setFailReps(null);
                    }}
                    disabled={locked}
                  >
                    ✗ 실패 기록
                  </button>
                </div>
                <p className="t-caption">✓는 폰 없이 이미 끝냈을 때 한 번에 기록해요.</p>
              </div>

              {failOpen && (
                <div className="u-box flex flex-col gap-3" role="group" aria-label="실패 기록">
                  <p className="t-list-title">어디서 멈췄나요?</p>
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="운동">
                    {(["pullup", "pushup"] as const).map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        aria-pressed={failEx === ex}
                        disabled={locked}
                        onClick={() => {
                          setFailEx(ex);
                          setFailReps(null);
                        }}
                        className={`u-btn ${failEx === ex ? "border-accent bg-accent-soft text-accent-ink" : "u-btn-secondary"}`}
                      >
                        {exerciseKo(ex)}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-5 gap-2" role="group" aria-label="세트">
                    {Array.from({ length: SETS_PER_EXERCISE }, (_, i) => (
                      <button
                        key={i}
                        type="button"
                        aria-pressed={failSet === i}
                        disabled={locked}
                        onClick={() => {
                          setFailSet(i);
                          setFailReps(null);
                        }}
                        className={`u-btn px-0 ${failSet === i ? "border-accent bg-accent-soft text-accent-ink" : "u-btn-secondary"}`}
                      >
                        {i + 1}세트
                      </button>
                    ))}
                  </div>
                  <div>
                    <label htmlFor="workout-fail-reps" className="u-label">
                      {exerciseKo(failEx)} {failSet + 1}세트에서 몇 회 했나요? (목표 {failTarget}회 · 선택)
                    </label>
                    <RepsSelect id="workout-fail-reps" max={failTarget} value={failReps} onChange={setFailReps} disabled={locked} />
                  </div>
                  <p className="t-caption">
                    그 세트 전까지(풀업1 → 푸시업1 → 풀업2 … 순서)는 목표대로 한 것으로 기록돼요. 내일은 회복 휴식이에요.
                  </p>
                  <div className="flex gap-2">
                    <button type="button" className="u-btn u-btn-primary flex-1" onClick={logFail} disabled={locked}>
                      {busy === "fail" ? "기록하는 중…" : "실패로 기록"}
                    </button>
                    <button type="button" className="u-btn u-btn-secondary flex-1" onClick={() => setFailOpen(false)} disabled={locked}>
                      취소
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {t.kind === "recorded_today" && (
            <>
              {t.outcome === "complete" && (
                <h2 className="t-section-title">
                  🎉 Day {t.day} 완료 — {tomorrowText(t.tomorrow)}
                </h2>
              )}
              {t.outcome === "repeat_complete" && (
                <h2 className="t-section-title">
                  ✅ Day {t.targetDay} 목표 완료 —{" "}
                  {t.tomorrow.kind === "workout" ? `내일 Day ${t.tomorrow.day} 재도전` : tomorrowText(t.tomorrow)}
                </h2>
              )}
              {t.outcome === "fail" && (
                <>
                  <h2 className="t-section-title">🩹 Day {t.day} 실패 기록 — {tomorrowText(t.tomorrow)}</h2>
                  <p className="t-question-ko">잘 멈췄어요. 한두 개 남기고 멈추는 게 이 루틴의 규칙이에요.</p>
                </>
              )}
              {snap.lastEvent && <p className="t-caption">오늘 기록 · {eventText(snap.lastEvent)}</p>}
              <p className="t-caption">오늘은 더 할 게 없어요. 잘못 눌렀다면 맨 아래 &lsquo;마지막 기록 취소&rsquo;로 되돌릴 수 있어요.</p>
            </>
          )}

          {t.kind === "rest" && (
            <>
              <h2 className="t-section-title">
                😴 {t.cycleEnd ? `사이클 마무리 휴식 ${t.index}/${t.of}` : `Day ${t.day} 휴식`} — 상체 완전 휴식
              </h2>
              <p className="t-question-ko text-ink">{tomorrowText(t.next)}</p>
              <p className="t-caption">휴식일엔 운동하지 않아요 — 기록할 것도 없어요.</p>
            </>
          )}

          {t.kind === "recovery" && (
            <>
              <h2 className="t-section-title">🩹 회복 휴식 — 내일 Day {t.resumeTargetDay} 목표로 복귀</h2>
              <p className="t-question-ko text-ink">Day {t.pendingDay} 재도전 전 회복 휴식이에요.</p>
              <p className="t-caption">{tomorrowText(t.next)}</p>
            </>
          )}

          {t.kind === "not_started" && (
            <>
              <h2 className="t-section-title">
                🗓 Day 1은 {formatShortDate(t.startDate)}부터({t.daysUntil}일 뒤)
              </h2>
              {snap.plan[0]?.target && <SetTable target={snap.plan[0].target} caption="Day 1 목표" />}
            </>
          )}

          {t.kind === "retest" && (
            <>
              <h2 className="t-section-title">🏁 사이클 {snap.cycleNo} 완주 — 오늘은 RM 재측정</h2>
              <p className="t-caption">새 RM으로 다음 사이클 27일을 다시 계산해요. 지금 RM은 풀업 {snap.rm.pullup} · 푸시업 {snap.rm.pushup}.</p>
              <WorkoutRmForm
                mode="retest"
                initialRm={snap.rm}
                defaultStart="tomorrow"
                today={today}
                tomorrow={tomorrow}
                disabled={locked}
                submitLabel="새 사이클 시작"
                onSubmit={startCycle}
              />
            </>
          )}
        </div>
      </section>

      {/* ── 앞으로 3일 — 엔진 upcoming(오늘이 운동일이면 오늘 성공을 가정) ── */}
      {upcomingList.length > 0 && (
        <section aria-label="앞으로">
          <h2 className="t-section-title">앞으로</h2>
          {t.kind === "workout" && <p className="t-caption mt-1">오늘 목표를 해낸다고 치면</p>}
          <ul className="mt-2 flex flex-col gap-1.5">
            {upcomingList.map((e) => (
              <li key={e.date} className={s.upcomingRow}>
                <span className="t-meta-chip w-16 flex-none tabular-nums">{formatShortDate(e.date)}</span>
                <span className="t-question-ko min-w-0 text-ink">{upcomingText(e.item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 27일 계획표 (접이식) ── */}
      <details className="u-card">
        <summary className={`t-section-title ${s.planSummary}`}>📅 27일 계획표</summary>
        <div className="overflow-x-auto px-2 pb-3">
          <table className={`u-table ${s.planTable}`}>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">풀업</th>
                <th scope="col">푸시업</th>
                <th scope="col" className="text-center">
                  표시
                </th>
              </tr>
            </thead>
            <tbody>
              {snap.plan.map((row) => (
                <tr key={row.day} className={row.current ? s.currentRow : undefined} aria-current={row.current ? "date" : undefined}>
                  <td className="t-meta-chip tabular-nums">{row.day}</td>
                  {row.kind === "workout" && row.target && row.totals ? (
                    <>
                      <td className="tabular-nums">
                        {ladderText(row.target.pullup)} <span className="t-caption">({row.totals.pullup})</span>
                      </td>
                      <td className="tabular-nums">
                        {ladderText(row.target.pushup)} <span className="t-caption">({row.totals.pushup})</span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="t-caption">
                      {row.kind === "workout" ? "" : REST_KIND_KO[row.kind]}
                    </td>
                  )}
                  <td className={`text-center ${s.marks}`}>
                    {row.current && <span className={s.markNow}>▶</span>}
                    {row.completed && <span className={s.markDone}>✓</span>}
                    {row.fails > 0 && <span className={s.markFail}>✗{row.fails > 1 ? row.fails : ""}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="t-caption mt-2 px-2">✓ 완료 · ✗ 실패(숫자 = 횟수) · ▶ 오늘. 괄호는 그날 합계.</p>
        </div>
      </details>

      {/* ── 누적 ── */}
      <section aria-label="누적" className="u-box">
        <p className="t-meta-chip">이번 사이클 누적</p>
        <p className="t-question-ko mt-1 text-ink">
          풀업 {snap.volume.pullup}회 · 푸시업 {snap.volume.pushup}회 · 실패 {snap.failCount}회
        </p>
        <p className="t-caption mt-1">
          사이클 {snap.cycleNo} · {formatDotDate(snap.startDate)} 시작 · RM 풀업 {snap.rm.pullup} · 푸시업 {snap.rm.pushup}
        </p>
      </section>

      <HistorySection history={history} />

      {/* ── 하단 관리 — 작게, 화면 안 두 단계 확인 ── */}
      <section aria-label="기록 관리" className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {snap.eventCount > 0 && snap.lastEvent && (
            <button
              type="button"
              className="u-navbtn"
              aria-expanded={panel === "undo"}
              disabled={locked}
              onClick={() => {
                setPanel((p) => (p === "undo" ? null : "undo"));
                setErrorKo(null);
              }}
            >
              ↩︎ 마지막 기록 취소
            </button>
          )}
          {t.kind !== "retest" && (
            <button
              type="button"
              className="u-navbtn"
              aria-expanded={panel === "remeasure"}
              disabled={locked}
              onClick={() => {
                setPanel((p) => (p === "remeasure" ? null : "remeasure"));
                setErrorKo(null);
              }}
            >
              📏 RM 다시 재기(새 사이클)
            </button>
          )}
        </div>

        {panel === "undo" && snap.lastEvent && (
          <div role="group" aria-label="기록 취소 확인" className={s.dangerPanel}>
            <p className="t-list-title">
              {formatShortDate(snap.lastEvent.date)} · {eventText(snap.lastEvent)}
            </p>
            <p className="t-caption mt-1">
              이 기록을 지울까요? <span className="font-medium text-danger">되돌릴 수 없어요.</span>
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={undoLast} disabled={locked} className="u-btn flex-1 bg-danger text-bg">
                {busy === "undo" ? "지우는 중…" : "기록 지우기"}
              </button>
              <button type="button" onClick={() => setPanel(null)} disabled={locked} className="u-btn u-btn-secondary flex-1">
                취소
              </button>
            </div>
          </div>
        )}

        {panel === "remeasure" && (
          <div role="group" aria-label="RM 다시 재기 확인" className={snap.eventCount > 0 ? s.dangerPanel : "u-box"}>
            <p className="t-list-title">RM 다시 재기 — 새 사이클</p>
            {snap.eventCount > 0 ? (
              <p className="t-caption mt-1">
                지금 사이클 {snap.cycleNo}(기록 {snap.eventCount}건)은 지우지 않고 보관하고, 새 RM으로 사이클을 새로 시작해요.{" "}
                <span className="font-medium text-danger">지금 사이클로는 돌아갈 수 없어요.</span>
              </p>
            ) : (
              <p className="t-caption mt-1">아직 기록이 없어서 이 사이클의 RM·시작일만 새로 고쳐 써요.</p>
            )}
            <div className="mt-3">
              <WorkoutRmForm
                mode="remeasure"
                initialRm={snap.rm}
                // 기록 0건이면 사실상 설정 고치기 — 지금 시작일 선택을 그대로 둔다. 기록이 있으면 재측정 기본값(내일).
                defaultStart={snap.eventCount === 0 && snap.startDate !== tomorrow ? "today" : "tomorrow"}
                today={today}
                tomorrow={tomorrow}
                disabled={locked}
                // 기록 0건은 제자리 고치기(비파괴 — prod-guard 대상 아님)라 위험색을 쓰지 않는다
                danger={snap.eventCount > 0}
                submitLabel={snap.eventCount > 0 ? "새 사이클 시작" : "이대로 고치기"}
                onSubmit={startCycle}
                onCancel={() => setPanel(null)}
              />
            </div>
          </div>
        )}
      </section>

      {sessionOpen && match && t.kind === "workout" && (
        <WorkoutSession
          match={match}
          target={t.target}
          isRepeat={t.isRepeat}
          onClose={closeSession}
          onResult={onSessionResult}
        />
      )}
    </div>
  );
}

/** 지난 사이클 — 번호·시작일·RM 변화(다음 사이클 rm에서 파생)·완료/중단 */
function HistorySection({ history }: { history: WorkoutHistoryRow[] }) {
  if (history.length === 0) return null;
  return (
    <section aria-label="지난 사이클">
      <h2 className="t-section-title">지난 사이클</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {history.map((h) => (
          <li key={h.id} className="u-item">
            <span className="u-item-thumb" aria-hidden>
              {h.status === "completed" ? "🏁" : "⏸"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="t-list-title">사이클 {h.cycleNo}</span>
                <span className={h.status === "completed" ? "u-chip u-chip-accent" : "u-chip"}>
                  {h.status === "completed" ? "완료" : "중단"}
                </span>
              </span>
              <span className="t-caption mt-0.5 block">
                {formatDotDate(h.startDate)} 시작 · {h.done}/{TOTAL_WORKOUT_DAYS}일 · 실패 {h.failCount}회
              </span>
              <span className="t-caption block">
                RM 풀업 {rmChange(h.rm.pullup, h.nextRm?.pullup)} · 푸시업 {rmChange(h.rm.pushup, h.nextRm?.pushup)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

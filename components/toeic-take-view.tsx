"use client";

/**
 * 모의고사 응시 화면 (아빠의 영어 T4, docs/harness/toeic.md §6-4·§8) — 전면 오버레이(z 20 + 스크롤 잠금).
 *
 * ── 흐름 ──────────────────────────────────────────────────────────────────────
 * 시작 전: 마이크 점검(2초 녹음·레벨 표시 — 권한 창을 **탭 안**에서 먼저 띄운다). 거부·미지원이면 "녹음 없이 연습"(타이머만).
 * "시작" 탭 안에서 **동기로**: AudioContext 생성/resume · unlockSpeechPlayback · 오디오 세션 playback · 지시문·질문 프리페치(en-US) ·
 *   첫 단계(지시문 speakQueue) — 그다음 `POST /api/toeic/mocks/[id]/attempts`로 attemptId(녹음 IndexedDB 키).
 * 문항 하나: 지시문(파트 첫 문항, en-US + 한국어 캡션) → 표 읽기(Q8 앞 45초) → 질문 음성(Q10은 두 번) → 준비 → 비프 → 녹음 + 답변
 *   카운트다운(녹음 start 이벤트에서 시작) → 저장(IndexedDB) → 다음. 단계 전이는 순수 엔진(lib/toeic-mock nextPhase·beginAnswer).
 * 끝/그만두기: `POST /api/toeic/attempts/[id]/finish` → 녹음된 문항이 1개 이상이면 STREAK_REFRESH_EVENT → "결과 보기".
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────────
 * - 시계는 **종료 시각(epoch ms)** 기반 250ms 틱. 렌더 중 Date.now()를 읽지 않는다("지금"은 state — 핸들러·타이머가 갱신).
 * - 재생과 마이크 캡처를 겹치지 않는다 — 질문 음성·비프가 끝난 뒤 녹음(세션 전환은 lib/mic-session.ts 한 곳).
 * - 질문 음성은 큐가 돌려준 stop만 쓴다(전역 stopSpeaking 금지). 큐가 "stopped"(외부 pause·소리 못 냄)로 끝나거나, "done"이어도
 *   onEnd의 `sounded`가 모자라면(1~2조각 큐가 무음 — toeicSpeechOutcome) 일시정지 + "다시 듣기"/"질문 보기"(Q8–10은 평소 질문 글을 숨긴다).
 * - 녹음 중 화면이 숨겨지면 즉시 녹음을 버리고 그 문항 "중단됨" — 돌아오면 "이 문항 다시"/"다음 문항으로".
 * - 비프는 준비 종료 시각에 미리 예약(lib/toeic-audio-cue), Wake Lock은 visible 복귀 때 재요청(use-toeic-wake-lock).
 * - **개발 빌드 전용** 시간 배율(localStorage `toeic-debug-timescale`) — production 번들에서는 1로 고정된다.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ToeicInfoTableView from "@/components/toeic-info-table";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { useToeicWakeLock } from "@/components/use-toeic-wake-lock";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MIC_GUM_TIMEOUT_MS,
  MicError,
  detectMicSupport,
  getMicDiag,
  setAudioSessionPlayback,
  startRecording,
  type MicDiag,
  type MicErrorKind,
  type MicRecording,
  type RecordingResult,
} from "@/lib/mic-session";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { prefetchSpeech, speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import {
  TOEIC_DEBUG_TIMESCALE_KEY,
  toeicAttemptHref,
  type ToeicAttemptCreateResponse,
  type ToeicAttemptFinishResponse,
  type ToeicQuestionView,
} from "@/lib/toeic-attempt-contract";
import { TOEIC_BEEP_SEC, cancelToeicBeep, ensureToeicAudio, getToeicAudioContext, resumeToeicAudio, scheduleToeicBeep } from "@/lib/toeic-audio-cue";
import {
  TOEIC_DIRECTIONS_LANG,
  TOEIC_PART_DIRECTIONS,
  beginAnswer,
  firstPhase,
  nextPhase,
  remainingMs,
  toeicSpeechOutcome,
  type ToeicMockPart,
  type ToeicPhaseState,
} from "@/lib/toeic-mock";
import { toeicImageUrl } from "@/lib/toeic-mock-contract";
import { saveToeicRecording } from "@/lib/toeic-rec-store";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { splitForTts } from "@/lib/tts-split";
import s from "./toeic-take-view.module.css";

const TICK_MS = 250;
const LEVEL_MS = 90;
const MIC_CHECK_MS = 2000;
/** 마이크 점검에서 "소리가 들어와요"로 보는 최고 레벨(0..1, -60dB → 0 · 0dB → 1) */
const MIC_CHECK_OK_LEVEL = 0.35;
/**
 * 답변 단계에서 녹음이 이만큼 안에 시작되지 않으면 그 문항은 시간만 잰다. 값은 lib/mic-session의 getUserMedia 상한과 같다
 * (상한 상수는 그쪽 한 곳 — mic-session도 같은 상한에서 activeCaptures를 되돌리고 playback으로 복귀한다).
 */
const MIC_START_WATCHDOG_MS = MIC_GUM_TIMEOUT_MS;
/** 비프가 울린 뒤 녹음을 열기까지(비프 길이 + 여유) — 재생과 캡처를 겹치지 않는다 */
const BEEP_GAP_MS = Math.round(TOEIC_BEEP_SEC * 1000) + 150;

type Stage = "intro" | "running" | "done" | "error";
type Mode = "mic" | "nomic";

type AnswerStatus = "recording" | "recorded" | "interrupted" | "failed" | "empty" | "nomic";
interface AnswerState {
  status: AnswerStatus;
  durationMs: number | null;
  mimeType: string | null;
  size: number | null;
  /** 기기 보관 위치(저장 끝나면) */
  stored: "idb" | "memory" | null;
  error: string | null;
}

type Pause = { kind: "speech"; phase: "directions" | "question" } | { kind: "interrupted"; q: number };

type MicCheck =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; peak: number; url: string | null; mimeType: string; size: number }
  | { phase: "error"; kind: MicErrorKind; message: string };

type FinishState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; recordedCount: number }
  | { phase: "error"; message: string };

/** 개발 빌드 전용 시간 배율 — production에서는 1(컴파일 때 접힌다). 0.01~1만 받는다. */
function readDebugTimescale(): number {
  if (process.env.NODE_ENV === "production") return 1;
  try {
    const v = Number(window.localStorage.getItem(TOEIC_DEBUG_TIMESCALE_KEY));
    return Number.isFinite(v) && v > 0 && v < 1 ? Math.max(0.01, v) : 1;
  } catch {
    return 1;
  }
}

function enPieces(text: string | null): { text: string; lang: string }[] {
  if (!text) return [];
  return splitForTts(text, TTS_TEXT_MAX_CHARS)
    .filter((t) => t.trim() !== "")
    .map((t) => ({ text: t, lang: TOEIC_DIRECTIONS_LANG }));
}

function clock(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}`;
}

function kb(n: number | null): string {
  if (n === null) return "–";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

const PHASE_KO: Record<ToeicPhaseState["phase"], string> = {
  directions: "지시문",
  reading: "표 읽기",
  question: "질문 듣기",
  prep: "준비",
  beep: "삐—",
  answer: "답변",
  done: "끝",
};

const ANSWER_STATUS_KO: Record<AnswerStatus, string> = {
  recording: "녹음 중",
  recorded: "녹음됨",
  interrupted: "중단됨",
  failed: "녹음 실패",
  empty: "소리 없음",
  nomic: "녹음 없이",
};

export default function ToeicTakeView({
  mockId,
  titleKo,
  scope,
  parts,
  scopeLabelKo,
  questions,
}: {
  mockId: string;
  titleKo: string;
  scope: "full" | "part";
  parts: ToeicMockPart[];
  scopeLabelKo: string;
  questions: ToeicQuestionView[];
}) {
  const qs = useMemo(() => questions.map((v) => v.q), [questions]);
  const viewByQ = useMemo(() => new Map(questions.map((v) => [v.q, v] as const)), [questions]);

  // ── 화면 상태 ──
  const [stage, setStage] = useState<Stage>("intro");
  const [mode, setMode] = useState<Mode>("mic");
  const [phase, setPhaseState] = useState<ToeicPhaseState | null>(null);
  const [now, setNow] = useState(0);
  const [pause, setPauseState] = useState<Pause | null>(null);
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({});
  const [reveal, setReveal] = useState<Set<number>>(new Set());
  const [memo, setMemo] = useState<Record<number, string>>({});
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [finishState, setFinishState] = useState<FinishState>({ phase: "idle" });
  const [completed, setCompleted] = useState(false);
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [micCheck, setMicCheck] = useState<MicCheck>({ phase: "idle" });
  const [support, setSupport] = useState<ReturnType<typeof detectMicSupport> | null>(null);
  const [scale, setScale] = useState(1);
  const [diag, setDiag] = useState<MicDiag | null>(null);

  // ── 콜백이 읽는 최신 값(타이머·음성 콜백은 탭 밖 — 클로저가 낡지 않게) ──
  const phaseRef = useRef<ToeicPhaseState | null>(null);
  const pauseRef = useRef<Pause | null>(null);
  const answersRef = useRef<Record<number, AnswerState>>({});
  const modeRef = useRef<Mode>("mic");
  const scaleRef = useRef(1);
  /** 단계 세대 — 단계가 바뀌면 올라가고, 늦게 온 콜백(음성 끝·녹음 시작·비프 대기)은 자기 세대가 아니면 물러난다 */
  const runRef = useRef(0);
  const speakStopRef = useRef<(() => void) | null>(null);
  const beepRef = useRef<{ nodes: OscillatorNode[]; at: number } | null>(null);
  const beepTimerRef = useRef<number | null>(null);
  const recordingRef = useRef<{ rec: MicRecording; q: number } | null>(null);
  /** 이미 처리한 종료 시각 — 틱이 두 번 처리하지 않게 */
  const expiredForRef = useRef<number | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const attemptPromiseRef = useRef<Promise<string | null> | null>(null);
  /** attemptId가 오기 전에 끝난 녹음(드물다 — 시작 요청이 느릴 때) */
  const pendingRecRef = useRef<Map<number, RecordingResult & { createdAt: number }>>(new Map());
  const savesRef = useRef<Promise<unknown>[]>([]);
  const finishedAtRef = useRef<string | null>(null);
  const finishSentRef = useRef(false);
  const prefetchStopRef = useRef<(() => void) | null>(null);
  const checkRecRef = useRef<MicRecording | null>(null);
  const checkUrlRef = useRef<string | null>(null);
  const levelSourceRef = useRef<MicRecording | null>(null);

  const setPhase = useCallback((st: ToeicPhaseState | null) => {
    phaseRef.current = st;
    setPhaseState(st);
  }, []);
  const setPause = useCallback((p: Pause | null) => {
    pauseRef.current = p;
    setPauseState(p);
  }, []);
  const patchAnswer = useCallback((q: number, patch: Partial<AnswerState> | null) => {
    const next = { ...answersRef.current };
    const base: AnswerState = answersRef.current[q] ?? { status: "recording", durationMs: null, mimeType: null, size: null, stored: null, error: null };
    if (patch === null) delete next[q];
    else next[q] = { ...base, ...patch };
    answersRef.current = next;
    setAnswers(next);
  }, []);

  // ── 마운트: 스크롤 잠금·기능 감지·시간 배율(렌더 중 localStorage·navigator 금지 — hydration) ──
  useEffect(() => lockBodyScroll(), []);
  useEffect(() => {
    const sup = detectMicSupport();
    setSupport(sup);
    if (!sup.ok) setMode("nomic"); // 녹음할 수 없는 환경 — 처음부터 "녹음 없이 연습"
    const sc = readDebugTimescale();
    scaleRef.current = sc;
    setScale(sc);
  }, []);

  /** 시간이 정해진 단계의 종료 시각에 배율을 건다(개발 빌드 전용 — production은 1) */
  const scaled = useCallback((st: ToeicPhaseState, at: number): ToeicPhaseState => {
    const k = scaleRef.current;
    if (st.endsAt === null || k === 1) return st;
    return { ...st, endsAt: at + Math.round((st.endsAt - at) * k) };
  }, []);

  // ── 소리·녹음 정리 ──
  const stopSpeech = useCallback(() => {
    const stop = speakStopRef.current;
    speakStopRef.current = null;
    stop?.();
  }, []);
  const cancelBeep = useCallback(() => {
    if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
    beepRef.current = null;
    if (beepTimerRef.current !== null) window.clearTimeout(beepTimerRef.current);
    beepTimerRef.current = null;
  }, []);
  const abortRecording = useCallback(() => {
    const cur = recordingRef.current;
    recordingRef.current = null;
    levelSourceRef.current = null;
    cur?.rec.abort();
  }, []);

  // ── 녹음 보관(IndexedDB) ──
  const storeRecording = useCallback(
    (aid: string, q: number, r: RecordingResult & { createdAt: number }) => {
      const p = saveToeicRecording({ attemptId: aid, q, blob: r.blob, mimeType: r.mimeType, durationMs: r.durationMs, size: r.size, createdAt: r.createdAt })
        .then((where) => patchAnswer(q, { stored: where }))
        .catch(() => patchAnswer(q, { stored: "memory" }));
      savesRef.current.push(p);
    },
    [patchAnswer],
  );

  // ── 단계 진입(부수 효과는 여기서 — 탭 핸들러에서 불리면 speakQueue가 탭 안에서 동기로 불린다) ──
  // enterPhase·advance는 서로를 부른다 — ref로 최신 함수를 잡아 순환 의존을 끊는다.
  const enterRef = useRef<(st: ToeicPhaseState) => void>(() => {});
  const advance = useCallback(
    (token: number) => {
      if (token !== runRef.current) return;
      const cur = phaseRef.current;
      if (!cur) return;
      const t = Date.now();
      enterRef.current(scaled(nextPhase(qs, cur, t), t));
    },
    [qs, scaled],
  );

  const playSpeech = useCallback(
    (pieces: { text: string; lang: string }[], token: number, kind: "directions" | "question") => {
      stopSpeech();
      if (pieces.length === 0) {
        advance(token);
        return;
      }
      const stop = speakQueue(pieces, {
        onEnd: (reason, { sounded }) => {
          if (runRef.current !== token) return;
          speakStopRef.current = null;
          // "done"이어도 소리를 못 낸 조각이 있으면(짧은 큐 전부 무음 — 큐의 "stopped"는 연속 3조각부터) 멈춘다(§6-4 안전망)
          if (toeicSpeechOutcome(kind, reason, sounded, pieces.length) === "advance") advance(token);
          else setPause({ kind: "speech", phase: kind }); // 외부 pause·소리 못 냄 — 일시정지
        },
      });
      if (runRef.current === token) speakStopRef.current = stop;
    },
    [advance, setPause, stopSpeech],
  );

  const beginAnswerPhase = useCallback(
    (st: ToeicPhaseState, token: number) => {
      const q = st.q!;
      if (modeRef.current === "nomic") {
        patchAnswer(q, { status: "nomic" });
        const t = Date.now();
        setPhase(scaled(beginAnswer(st, t), t));
        return;
      }
      patchAnswer(q, { status: "recording", error: null, durationMs: null, size: null, mimeType: null, stored: null });
      /** 이 답변의 녹음을 포기했다(시작 실패·무응답) — 늦게 도착한 녹음은 버린다(시간만 재는 답변에 섞이지 않게) */
      let abandoned = false;
      const fallbackToTimer = (message: string) => {
        if (runRef.current !== token || abandoned) return;
        abandoned = true;
        window.clearTimeout(watchdog);
        abortRecording();
        patchAnswer(q, { status: "failed", error: message });
        setNotice(`Q${q} 녹음을 시작하지 못해 이 문항은 시간만 재요. (${message})`);
        const t = Date.now();
        const cur = phaseRef.current;
        if (cur && cur.phase === "answer") setPhase(scaled(beginAnswer(cur, t), t));
        setDiag(getMicDiag());
      };
      // 마이크가 끝내 답하지 않으면(권한 창이 탭 밖에서 떠 멈춤 등) 시간만 잰다 — 시험이 "녹음 준비 중"에 멈춰 서지 않게
      const watchdog = window.setTimeout(() => fallbackToTimer("마이크 응답이 없어요"), MIC_START_WATCHDOG_MS);
      startRecording({ audioContext: getToeicAudioContext() })
        .then((rec) => {
          if (runRef.current !== token || abandoned) {
            rec.abort();
            return;
          }
          recordingRef.current = { rec, q };
          levelSourceRef.current = rec;
          rec.started.then(
            (t) => {
              if (runRef.current !== token || abandoned) return;
              window.clearTimeout(watchdog);
              const cur = phaseRef.current;
              if (cur && cur.phase === "answer") setPhase(scaled(beginAnswer(cur, t), t)); // 답변 타이머는 녹음 start부터
              setDiag(getMicDiag());
            },
            (e: unknown) => fallbackToTimer(e instanceof Error ? e.message : "녹음 시작 실패"),
          );
        })
        .catch((e: unknown) => fallbackToTimer(e instanceof MicError ? e.message : e instanceof Error ? e.message : "녹음 시작 실패"));
    },
    [abortRecording, patchAnswer, scaled, setPhase],
  );

  /** 답변 시간이 끝났다 — 녹음을 멈추고(트랙 stop → 세션 playback) 기기에 보관한 뒤 다음 단계 */
  const finishAnswer = useCallback(
    (token: number) => {
      const st = phaseRef.current;
      const q = st?.q ?? null;
      const cur = recordingRef.current;
      recordingRef.current = null;
      levelSourceRef.current = null;
      setLevel(0);
      if (!cur || q === null) {
        advance(token);
        return;
      }
      setStopping(true);
      void cur.rec.stop().then((result) => {
        setStopping(false);
        setDiag(getMicDiag());
        if (result && result.durationMs > 0) {
          const r = { ...result, createdAt: Date.now() };
          patchAnswer(q, { status: "recorded", durationMs: result.durationMs, mimeType: result.mimeType, size: result.size, error: null });
          const aid = attemptIdRef.current;
          if (aid) storeRecording(aid, q, r);
          else pendingRecRef.current.set(q, r);
        } else {
          patchAnswer(q, { status: "empty", error: "녹음된 소리가 없어요" });
        }
        advance(token);
      });
    },
    [advance, patchAnswer, storeRecording],
  );

  // ── 끝/그만두기 저장 ──
  const buildFinishBody = useCallback(() => {
    return {
      finishedAt: finishedAtRef.current,
      answers: qs.map((q) => {
        const a = answersRef.current[q];
        const recorded = a?.status === "recorded" && (a.durationMs ?? 0) > 0;
        return { q, recorded, durationMs: recorded ? Math.round(a!.durationMs!) : null };
      }),
    };
  }, [qs]);

  const sendFinish = useCallback(async () => {
    setFinishState({ phase: "saving" });
    await Promise.allSettled(savesRef.current); // 결과 화면이 기기 녹음을 바로 읽게
    const aid = attemptIdRef.current ?? (attemptPromiseRef.current ? await attemptPromiseRef.current : null);
    if (!aid) {
      setFinishState({ phase: "error", message: "응시 기록이 만들어지지 않아 결과를 저장할 수 없어요." });
      return;
    }
    const body = buildFinishBody();
    finishSentRef.current = true;
    try {
      const res = await fetch(`/api/toeic/attempts/${encodeURIComponent(aid)}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicAttemptFinishResponse | null;
      const recordedCount =
        data?.ok === true ? data.recordedCount : data && !data.ok && data.error === "already_finished" ? (data.recordedCount ?? 0) : null;
      if (recordedCount !== null) {
        setFinishState({ phase: "saved", recordedCount });
        if (recordedCount > 0) window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 스트릭 헤드라인 즉시 갱신(§17-4)
        return;
      }
      finishSentRef.current = false;
      setFinishState({ phase: "error", message: data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요(서버 응답 없음)." });
    } catch {
      finishSentRef.current = false;
      setFinishState({ phase: "error", message: "네트워크 문제로 결과를 저장하지 못했어요. 연결을 확인하고 다시 저장해 주세요." });
    }
  }, [buildFinishBody]);

  const endTest = useCallback(
    (done: boolean) => {
      runRef.current += 1;
      stopSpeech();
      cancelBeep();
      const st = phaseRef.current;
      if (recordingRef.current && st?.q) {
        abortRecording();
        patchAnswer(st.q, { status: "interrupted", error: "그만두기로 멈춤" });
      }
      setPause(null);
      setLevel(0);
      finishedAtRef.current = done ? new Date().toISOString() : null;
      setCompleted(done);
      setStage("done");
      prefetchStopRef.current?.();
      prefetchStopRef.current = null;
      void sendFinish();
    },
    [abortRecording, cancelBeep, patchAnswer, sendFinish, setPause, stopSpeech],
  );

  const enterPhase = useCallback(
    (st: ToeicPhaseState) => {
      const token = ++runRef.current;
      setPhase(st);
      setPause(null);
      expiredForRef.current = null;
      setNow(Date.now());
      if (st.phase !== "beep") cancelBeepTimerOnly();
      switch (st.phase) {
        case "directions": {
          const v = st.q !== null ? viewByQ.get(st.q) : undefined;
          playSpeech(v ? enPieces(TOEIC_PART_DIRECTIONS[v.part].en) : [], token, "directions");
          break;
        }
        case "question": {
          const v = st.q !== null ? viewByQ.get(st.q) : undefined;
          const pieces = v ? [...(st.play === 0 ? enPieces(v.spokenIntro) : []), ...enPieces(v.question)] : [];
          playSpeech(pieces, token, "question");
          break;
        }
        case "prep": {
          // 준비 종료 시각에 비프를 **미리 예약**(탭 밖 재생 제약 회피 — 운동 비프 관용구)
          if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
          beepRef.current = null;
          resumeToeicAudio(); // 세션 전환·백그라운드로 멈췄을 수 있다(안 되면 비프 단계가 확인한다)
          const ctx = getToeicAudioContext();
          if (ctx && st.endsAt !== null) {
            const at = ctx.currentTime + Math.max(0, st.endsAt - Date.now()) / 1000;
            beepRef.current = { nodes: scheduleToeicBeep(ctx, at), at };
          }
          break;
        }
        case "beep": {
          // 예약분이 아직 안 울렸으면(컨텍스트가 멈춰 있었다) 지금 울린다 — 늦게 튀어나오지 않게 예약분은 취소
          const ctx = getToeicAudioContext();
          const b = beepRef.current;
          if (ctx && ctx.state === "running" && (!b || ctx.currentTime < b.at - 0.05)) {
            if (b) cancelToeicBeep(b.nodes);
            beepRef.current = { nodes: scheduleToeicBeep(ctx, ctx.currentTime + 0.01), at: ctx.currentTime + 0.01 };
          }
          beepTimerRef.current = window.setTimeout(() => advance(token), BEEP_GAP_MS);
          break;
        }
        case "answer":
          beginAnswerPhase(st, token);
          break;
        case "reading":
          break;
        case "done":
          endTest(true);
          break;
      }
      function cancelBeepTimerOnly() {
        if (beepTimerRef.current !== null) window.clearTimeout(beepTimerRef.current);
        beepTimerRef.current = null;
      }
    },
    [advance, beginAnswerPhase, endTest, playSpeech, setPause, setPhase, viewByQ],
  );
  useEffect(() => {
    enterRef.current = enterPhase;
  }, [enterPhase]);

  // ── 틱: 종료 시각 기반(스로틀돼도 다음 틱에서 맞춰진다) ──
  useEffect(() => {
    if (stage !== "running") return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const st = phaseRef.current;
      if (!st || pauseRef.current || st.endsAt === null || t < st.endsAt || expiredForRef.current === st.endsAt) return;
      expiredForRef.current = st.endsAt;
      if (st.phase === "answer") finishAnswer(runRef.current);
      else advance(runRef.current); // reading·prep
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [stage, advance, finishAnswer]);

  // ── 레벨 미터(녹음 중·마이크 점검 중) ──
  useEffect(() => {
    const id = window.setInterval(() => {
      const src = levelSourceRef.current;
      if (src) setLevel(src.level());
    }, LEVEL_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── 녹음 중 화면이 숨겨지면 즉시 버리고 "중단됨"(숨겨진 동안의 녹음은 믿을 수 없다 — 조사 §3-6) ──
  useEffect(() => {
    if (stage !== "running") return;
    const onVis = () => {
      if (document.visibilityState !== "hidden") return;
      const st = phaseRef.current;
      if (!st || st.phase !== "answer" || st.q === null || modeRef.current === "nomic") return;
      if (answersRef.current[st.q]?.status !== "recording") return;
      runRef.current += 1; // 진행 중인 녹음 시작·끝 콜백을 무효로
      abortRecording();
      setLevel(0);
      patchAnswer(st.q, { status: "interrupted", error: "화면이 꺼지거나 다른 앱으로 넘어가 녹음을 멈췄어요" });
      setPhase({ ...st, endsAt: null });
      setPause({ kind: "interrupted", q: st.q });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [stage, abortRecording, patchAnswer, setPause, setPhase]);

  // visible 복귀: 시계 즉시 갱신 + 오디오 컨텍스트 깨우기 + Wake Lock 재요청
  const onVisible = useCallback(() => {
    setNow(Date.now());
    resumeToeicAudio();
  }, []);
  useToeicWakeLock(stage === "running", onVisible);

  // ── 언마운트: 소리·녹음 정리, 시작했는데 끝을 못 보냈으면 best-effort로 "그만둠" 저장 ──
  useEffect(() => {
    const onPageHide = () => {
      const aid = attemptIdRef.current;
      if (!aid || finishSentRef.current) return;
      finishSentRef.current = true;
      try {
        const body = JSON.stringify({ ...buildFinishBody(), finishedAt: null });
        navigator.sendBeacon?.(`/api/toeic/attempts/${encodeURIComponent(aid)}/finish`, new Blob([body], { type: "application/json" }));
      } catch {
        /* best-effort */
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [buildFinishBody]);

  useEffect(
    () => () => {
      runRef.current += 1;
      const stop = speakStopRef.current;
      speakStopRef.current = null;
      stop?.();
      if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
      beepRef.current = null;
      if (beepTimerRef.current !== null) window.clearTimeout(beepTimerRef.current);
      recordingRef.current?.rec.abort();
      recordingRef.current = null;
      checkRecRef.current?.abort();
      prefetchStopRef.current?.();
      if (checkUrlRef.current) URL.revokeObjectURL(checkUrlRef.current);
      const aid = attemptIdRef.current;
      if (aid && !finishSentRef.current) {
        finishSentRef.current = true;
        // 화면을 떠났다(뒤로 가기 등) — 그만둔 응시로 닫는다(녹음된 문항은 그대로 남는다)
        const answersNow = qsRef.current.map((q) => {
          const a = answersRef.current[q];
          const recorded = a?.status === "recorded" && (a.durationMs ?? 0) > 0;
          return { q, recorded, durationMs: recorded ? Math.round(a!.durationMs!) : null };
        });
        void fetch(`/api/toeic/attempts/${encodeURIComponent(aid)}/finish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ finishedAt: null, answers: answersNow }),
          keepalive: true,
        }).catch(() => {});
      }
    },
    [],
  );
  const qsRef = useRef(qs);
  useEffect(() => {
    qsRef.current = qs;
  }, [qs]);

  // ── 마이크 점검(탭) — 권한 창을 여기서 먼저 띄운다 ──
  // 기다림마다 상한이 있다(QA m2 P2-B): getUserMedia는 MIC_CHECK_GUM_TIMEOUT_MS(권한 창 응답 시간 포함), start 이벤트·stop은
  // lib/mic-session의 상한. 그래서 버튼이 "듣는 중…"에 갇히지 않는다. 시작 실패면 녹음을 abort — 트랙·activeCaptures가 새지 않게.
  async function checkMic() {
    if (micCheck.phase === "checking") return;
    const gen = runRef.current; // 점검 중에 시작(녹음 없이)·언마운트가 오면 바뀐다 — 그러면 점검 녹음을 버린다
    const ctx = ensureToeicAudio();
    setMicCheck({ phase: "checking" });
    let rec: MicRecording | null = null;
    try {
      rec = await startRecording({ audioContext: ctx, gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS });
      if (runRef.current !== gen) {
        rec.abort();
        return;
      }
      checkRecRef.current = rec; // 언마운트·시작이 abort할 수 있게 — start 이벤트를 기다리는 동안에도
      await rec.started;
    } catch (e) {
      rec?.abort(); // start 이벤트가 상한 안에 안 왔다·recorder 오류 — 트랙 stop → playback(mic-session도 스스로 버린다, 멱등)
      if (checkRecRef.current === rec) checkRecRef.current = null;
      if (runRef.current !== gen) return;
      const err = e instanceof MicError ? e : new MicError("failed", e instanceof Error ? e.message : undefined);
      setMicCheck({ phase: "error", kind: err.kind, message: err.message });
      setDiag(getMicDiag());
      if (err.kind === "denied" || err.kind === "unsupported") setMode("nomic");
      return;
    }
    const live = rec;
    if (runRef.current !== gen) {
      live.abort();
      if (checkRecRef.current === live) checkRecRef.current = null;
      return;
    }
    levelSourceRef.current = live;
    let peak = 0;
    const peakTimer = window.setInterval(() => {
      peak = Math.max(peak, live.level());
    }, LEVEL_MS);
    await new Promise((r) => window.setTimeout(r, MIC_CHECK_MS));
    window.clearInterval(peakTimer);
    peak = Math.max(peak, live.level());
    const result = await live.stop(); // abort된 뒤면 null(같은 약속)
    if (checkRecRef.current === live) checkRecRef.current = null;
    if (levelSourceRef.current === live) levelSourceRef.current = null;
    if (runRef.current !== gen) return; // 점검 중에 시작했다 — 시작 화면 상태를 건드리지 않는다
    setLevel(0);
    setDiag(getMicDiag());
    if (checkUrlRef.current) URL.revokeObjectURL(checkUrlRef.current);
    const url = result ? URL.createObjectURL(result.blob) : null;
    checkUrlRef.current = url;
    setMicCheck({ phase: "done", peak, url, mimeType: result?.mimeType ?? "", size: result?.size ?? 0 });
    setMode("mic");
  }

  // ── 시작(탭 — 아래는 전부 동기로, 첫 await 전에) ──
  function start() {
    if (stage !== "intro") return;
    // 점검 녹음이 아직 돌면(녹음 없이 시작) 먼저 버린다 — 트랙 stop 뒤 playback(캡처 중이면 아래 playback 전환이 무시된다)
    checkRecRef.current?.abort();
    checkRecRef.current = null;
    ensureToeicAudio();
    unlockSpeechPlayback();
    setAudioSessionPlayback();
    const texts: string[] = [];
    for (const part of parts) texts.push(...enPieces(TOEIC_PART_DIRECTIONS[part].en).map((p) => p.text));
    for (const v of questions) texts.push(...enPieces(v.spokenIntro).map((p) => p.text), ...enPieces(v.question).map((p) => p.text));
    prefetchStopRef.current = prefetchSpeech(texts, TOEIC_DIRECTIONS_LANG);
    // Q3–4 사진을 미리 받아 둔다 — 준비 시간(45초)이 사진 로딩으로 깎이지 않게(비공개 캐시 응답이라 두 번째는 즉시)
    for (const v of questions) {
      if (!v.picture?.imageId) continue;
      try {
        const img = new Image();
        img.src = toeicImageUrl(v.picture.imageId);
      } catch {
        /* 미리 받기는 best-effort */
      }
    }
    modeRef.current = mode;
    setStage("running");
    setNotice(null);
    const t = Date.now();
    enterPhase(scaled(firstPhase(qs, t), t));
    attemptPromiseRef.current = createAttempt();
  }

  async function createAttempt(): Promise<string | null> {
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(mockId)}/attempts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, parts }),
      });
      const data = (await res.json().catch(() => null)) as ToeicAttemptCreateResponse | null;
      if (data?.ok) {
        attemptIdRef.current = data.attemptId;
        setAttemptId(data.attemptId);
        for (const [q, r] of pendingRecRef.current) storeRecording(data.attemptId, q, r);
        pendingRecRef.current.clear();
        return data.attemptId;
      }
      abortStart(data && !data.ok ? data.messageKo : "응시를 시작하지 못했어요(서버 응답 없음).");
      return null;
    } catch {
      abortStart("네트워크 문제로 응시를 시작하지 못했어요. 연결을 확인하고 다시 시작해 주세요.");
      return null;
    }
  }

  function abortStart(message: string) {
    runRef.current += 1;
    stopSpeech();
    cancelBeep();
    abortRecording();
    prefetchStopRef.current?.();
    prefetchStopRef.current = null;
    finishSentRef.current = true;
    setStartError(message);
    setStage("error");
  }

  // ── 일시정지·중단 복구(탭) ──
  function replaySpeech() {
    const st = phaseRef.current;
    if (!st) return;
    enterPhase({ ...st }); // 같은 단계 다시 — 탭 안이라 speakQueue가 재생 잠금을 다시 푼다
  }
  function continueAfterDirections() {
    advance(runRef.current);
  }
  function showQuestionText() {
    const st = phaseRef.current;
    if (!st || st.q === null) return;
    setReveal((prev) => new Set(prev).add(st.q!));
    const t = Date.now();
    let next = st;
    while (next.phase === "question") next = nextPhase(qs, next, t);
    enterPhase(scaled(next, t));
  }
  function retryQuestion() {
    const st = phaseRef.current;
    if (!st || st.q === null) return;
    ensureToeicAudio();
    const t = Date.now();
    let solo = firstPhase([st.q], t);
    while (solo.phase === "directions" || solo.phase === "reading") solo = nextPhase([st.q], solo, t);
    patchAnswer(st.q, null);
    setNotice(null);
    enterPhase(scaled({ ...solo, index: st.index }, t));
  }
  function skipQuestion() {
    const st = phaseRef.current;
    if (!st) return;
    const t = Date.now();
    enterPhase(scaled(nextPhase(qs, { ...st, phase: "answer", play: 0 }, t), t));
  }
  function confirmQuit() {
    setQuitConfirm(false);
    endTest(false);
  }

  // ── 렌더 ──
  const view = phase?.q ? viewByQ.get(phase.q) : undefined;
  const remain = phase ? remainingMs(phase, now) : null;
  const recordedCount = qs.filter((q) => answers[q]?.status === "recorded").length;
  const totalMin = Math.max(
    1,
    Math.round(questions.reduce((sum, v) => sum + v.prepSec + v.answerSec + v.readingSec + (v.questionPlays > 0 ? 8 * v.questionPlays : 0) + (v.directions ? 20 : 0), 0) / 60),
  );

  if (stage === "error") {
    return (
      <div className={s.overlay} role="dialog" aria-modal="true" aria-label="모의고사 응시">
        <div className={s.inner}>
          <p className={s.title}>{titleKo}</p>
          <div className={s.alert} role="alert">
            {startError}
          </div>
          <div className={s.row}>
            <button type="button" className="u-btn u-btn-primary" onClick={() => window.location.reload()}>
              ↻ 처음부터 다시
            </button>
            <Link href={`/toeic/mocks/${encodeURIComponent(mockId)}`} className="u-btn u-btn-secondary">
              학습 보기로
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "intro") {
    const unsupported = support !== null && !support.ok;
    const canStart = mode === "nomic" || micCheck.phase === "done";
    return (
      <div className={s.overlay} role="dialog" aria-modal="true" aria-label="모의고사 응시 준비">
        <div className={s.inner}>
          <div className={s.head}>
            <Link href={`/toeic/mocks/${encodeURIComponent(mockId)}`} className="u-navbtn">
              ← 학습 보기
            </Link>
            {scale !== 1 && <span className={s.devBadge}>⏩ 시간 ×{scale} (개발용)</span>}
          </div>
          <div>
            <p className={s.kicker}>{scopeLabelKo}</p>
            <h1 className={s.title}>{titleKo}</h1>
            <p className={s.lead}>
              {questions.length}문항 · 약 {totalMin}분. 문항마다 질문을 듣고 준비한 뒤, <strong>삐— 소리가 나면</strong> 답을 말하세요. 녹음은
              이 기기에만 저장되고, 끝난 뒤 결과 화면에서 다시 듣거나 AI 채점을 받을 수 있어요.
            </p>
          </div>

          <section className={s.card} aria-label="마이크 점검">
            <p className={s.cardTitle}>🎙️ 마이크 점검</p>
            {unsupported ? (
              <p className={s.warn}>{support?.reasonKo} 녹음 없이 시간만 재며 연습할 수 있어요.</p>
            ) : (
              <>
                <p className={s.caption}>버튼을 누르고 2초 동안 아무 말이나 해 보세요. 처음이면 마이크 권한을 물어봐요.</p>
                <div className={s.row}>
                  <button type="button" className="u-btn u-btn-secondary" onClick={() => void checkMic()} disabled={micCheck.phase === "checking"}>
                    {micCheck.phase === "checking" ? "듣는 중…" : micCheck.phase === "done" ? "↻ 다시 점검" : "🎙️ 마이크 점검(2초)"}
                  </button>
                </div>
                {micCheck.phase === "checking" && (
                  <div className={s.meter} role="meter" aria-label="입력 레벨" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                    <span className={s.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
                  </div>
                )}
                {micCheck.phase === "done" && (
                  <div className={s.checkResult}>
                    <p className={micCheck.peak >= MIC_CHECK_OK_LEVEL ? s.ok : s.warn} role="status">
                      {micCheck.peak >= MIC_CHECK_OK_LEVEL
                        ? "✓ 소리가 잘 들어와요."
                        : "소리가 거의 들어오지 않았어요 — 마이크 위치를 확인하세요. 그래도 시작할 수 있어요."}
                    </p>
                    {micCheck.url && (
                      <audio className={s.audio} controls src={micCheck.url} preload="metadata">
                        <track kind="captions" />
                      </audio>
                    )}
                    <p className={s.diag}>
                      점검 녹음 {micCheck.mimeType || "형식 모름"} · {kb(micCheck.size)} · 최고 레벨 {Math.round(micCheck.peak * 100)}
                    </p>
                  </div>
                )}
                {micCheck.phase === "error" && (
                  <p className={s.warn} role="alert">
                    {micCheck.message}
                  </p>
                )}
              </>
            )}
            <label className={s.nomic}>
              <input type="checkbox" checked={mode === "nomic"} onChange={(e) => setMode(e.target.checked ? "nomic" : "mic")} />
              <span>녹음 없이 연습(타이머만 — 채점할 녹음이 남지 않아요)</span>
            </label>
          </section>

          <details className={s.settings}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정(질문 음성)</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="en-US" />
            </div>
          </details>

          <button type="button" className={`u-btn u-btn-primary ${s.startBtn}`} onClick={start} disabled={!canStart}>
            {mode === "nomic" ? "▶ 녹음 없이 시작" : "▶ 시작"}
          </button>
          {!canStart && <p className={s.caption}>마이크 점검을 마치거나 "녹음 없이 연습"을 고르면 시작할 수 있어요.</p>}
        </div>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className={s.overlay} role="dialog" aria-modal="true" aria-label="모의고사 응시 끝">
        <div className={s.inner}>
          <p className={s.kicker}>{scopeLabelKo}</p>
          <h1 className={s.title}>{completed ? "🎉 끝났어요" : "그만뒀어요"}</h1>
          <p className={s.lead}>
            녹음 {recordedCount} / {qs.length}문항{mode === "nomic" ? " (녹음 없이 연습)" : ""}. 녹음은 이 기기에만 있어요 — 결과 화면에서 다시 듣고 AI 채점을 받을 수 있어요.
          </p>
          <ul className={s.answerList}>
            {qs.map((q) => {
              const a = answers[q];
              const v = viewByQ.get(q);
              return (
                <li key={q} className={s.answerRow}>
                  <span className={s.qBadge}>Q{q}</span>
                  <span className={s.answerPart}>{v?.partNameKo}</span>
                  <span className={`u-chip ${a?.status === "recorded" ? "u-chip-accent" : ""}`}>
                    {a ? ANSWER_STATUS_KO[a.status] : "안 함"}
                    {a?.status === "recorded" && a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)}초` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <div aria-live="polite">
            {finishState.phase === "saving" && <p className={s.caption}>결과를 저장하는 중…</p>}
            {finishState.phase === "error" && (
              <div className={s.alert} role="alert">
                <p>{finishState.message}</p>
                <button type="button" className="u-btn u-btn-secondary" onClick={() => void sendFinish()}>
                  ↻ 다시 저장
                </button>
              </div>
            )}
          </div>
          <div className={s.row}>
            {attemptId && finishState.phase === "saved" ? (
              <Link href={toeicAttemptHref(attemptId)} className="u-btn u-btn-primary">
                📊 결과 보기 · AI 채점
              </Link>
            ) : (
              <button type="button" className="u-btn u-btn-primary" disabled>
                📊 결과 보기 · AI 채점
              </button>
            )}
            <Link href={`/toeic/mocks/${encodeURIComponent(mockId)}`} className="u-btn u-btn-secondary">
              학습 보기로
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── 응시 중 ──
  const st = phase;
  const q = st?.q ?? null;
  const a = q !== null ? answers[q] : undefined;
  const showQuestion =
    !!view &&
    !!view.question &&
    (view.showQuestionText || (q !== null && reveal.has(q))) &&
    st !== null &&
    st.phase !== "directions" &&
    st.phase !== "reading";
  const contentVisible = st !== null && st.phase !== "directions";
  const phaseLabel =
    st?.phase === "question" && view && view.questionPlays > 1
      ? `${PHASE_KO.question} (${st.play + 1}/${view.questionPlays})`
      : st?.phase === "answer"
        ? mode === "nomic"
          ? "답변(녹음 없이)"
          : a?.status === "recording"
            ? stopping
              ? "저장 중…"
              : st.endsAt === null
                ? "녹음 준비 중…"
                : "● 녹음 중"
            : "답변"
        : st
          ? PHASE_KO[st.phase]
          : "";

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label="모의고사 응시">
      <div className={s.inner}>
        <div className={s.head}>
          <div className={s.headInfo}>
            <span className={s.qBadge}>Q{q ?? "–"}</span>
            <span className={s.partName}>{view?.partNameKo}</span>
            <span className={s.progress}>
              {(st?.index ?? 0) + 1} / {qs.length}
            </span>
            {scale !== 1 && <span className={s.devBadge}>⏩ ×{scale}</span>}
          </div>
          <button type="button" className={s.quitBtn} onClick={() => setQuitConfirm(true)}>
            그만두기
          </button>
        </div>

        {quitConfirm && (
          <div className={s.confirm} role="alertdialog" aria-label="그만두기 확인">
            <p>그만둘까요? 지금까지 녹음한 문항은 저장되고, 결과 화면에서 채점할 수 있어요.</p>
            <div className={s.row}>
              <button type="button" className="u-btn u-btn-primary" onClick={confirmQuit}>
                그만두기
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={() => setQuitConfirm(false)}>
                계속하기
              </button>
            </div>
          </div>
        )}

        <div className={`${s.stageCard} ${st?.phase === "answer" && mode === "mic" && a?.status === "recording" ? s.stageRec : ""}`} aria-live="polite">
          <p className={s.phaseLabel}>{phaseLabel}</p>
          {remain !== null && <p className={s.timer}>{clock(remain)}</p>}
          {(st?.phase === "directions" || st?.phase === "question") && !pause && <p className={s.caption}>🔊 듣고 있어요…</p>}
          {st?.phase === "answer" && mode === "mic" && a?.status === "recording" && (
            <div className={s.meter} role="meter" aria-label="입력 레벨" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              <span className={s.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          )}
        </div>

        {pause?.kind === "speech" && (
          <div className={s.alert} role="alert">
            <p>{pause.phase === "directions" ? "지시문 음성이 멈췄어요." : "질문 음성이 재생되지 않았어요."} 소리를 확인하고 다시 들어 보세요.</p>
            <div className={s.row}>
              <button type="button" className="u-btn u-btn-primary" onClick={replaySpeech}>
                🔊 다시 듣기
              </button>
              {pause.phase === "question" ? (
                <button type="button" className="u-btn u-btn-secondary" onClick={showQuestionText}>
                  📝 질문 보기
                </button>
              ) : (
                <button type="button" className="u-btn u-btn-secondary" onClick={continueAfterDirections}>
                  계속
                </button>
              )}
            </div>
          </div>
        )}
        {pause?.kind === "interrupted" && (
          <div className={s.alert} role="alert">
            <p>Q{pause.q} 녹음이 중단됐어요(화면이 꺼지거나 다른 앱으로 넘어갔어요).</p>
            <div className={s.row}>
              <button type="button" className="u-btn u-btn-primary" onClick={retryQuestion}>
                ↻ 이 문항 다시
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={skipQuestion}>
                다음 문항으로
              </button>
            </div>
          </div>
        )}
        {notice && <p className={s.warn}>{notice}</p>}

        {/* 지시문 — en(읽는 문장) + 한국어 캡션 */}
        {st?.phase === "directions" && view && (
          <section className={s.card} aria-label="지시문">
            <p className={s.cardTitle}>{view.partLabelKo}</p>
            <p className={s.en} lang="en">
              {TOEIC_PART_DIRECTIONS[view.part].en}
            </p>
            <p className={s.caption}>{TOEIC_PART_DIRECTIONS[view.part].ko}</p>
          </section>
        )}

        {/* 문항 자료 */}
        {contentVisible && view && !view.available && <p className={s.warn}>이 문항의 자료가 모의고사에 없어요 — 시간만 재요.</p>}
        {contentVisible && view?.passage && (
          <p className={s.passage} lang="en">
            {view.passage}
          </p>
        )}
        {contentVisible && view?.picture && (
          view.picture.imageId ? (
            <figure className={s.photo}>
              {/* eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트 */}
              <img src={toeicImageUrl(view.picture.imageId)} alt={`Q${view.q} 사진`} width={1536} height={1024} className={s.photoImg} />
            </figure>
          ) : (
            <div className={s.sceneBox} role="group" aria-label="장면 설명">
              <p className={s.caption}>📷 사진 대신 장면 설명</p>
              <p className={s.scene}>{view.picture.sceneKo}</p>
            </div>
          )
        )}
        {contentVisible && view?.intro && (
          <p className={s.intro} lang="en">
            {view.intro}
          </p>
        )}
        {contentVisible && view?.table && <ToeicInfoTableView table={view.table} />}
        {showQuestion && view?.question && (
          <p className={s.question} lang="en">
            {view.question}
          </p>
        )}

        {/* 메모장 — 준비·답변 중(저장하지 않는다) */}
        {q !== null && (st?.phase === "prep" || st?.phase === "answer" || st?.phase === "beep") && (
          <label className={s.memo}>
            <span className={s.caption}>메모(저장 안 함)</span>
            <textarea
              value={memo[q] ?? ""}
              onChange={(e) => setMemo((prev) => ({ ...prev, [q]: e.target.value }))}
              rows={3}
              className={s.memoInput}
            />
          </label>
        )}

        {diag && mode === "mic" && (
          <p className={s.diag}>
            진단 · 녹음 형식 {diag.mimeType ?? diag.requestedMimeType ?? "기본"} · 마지막{" "}
            {diag.durationMs !== null ? `${(diag.durationMs / 1000).toFixed(1)}초` : "–"} · {kb(diag.size)} · 세션 {diag.audioSession ?? "API 없음"}
            {diag.error ? ` · 오류 ${diag.error}` : ""}
            {attemptId ? "" : " · 응시 기록 만드는 중"}
          </p>
        )}
      </div>
    </div>
  );
}

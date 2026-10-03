"use client";

/**
 * 모의고사 응시 화면 (아빠의 영어 T4, docs/harness/toeic.md §6-4·§8) — 전면 오버레이(z 20 + 스크롤 잠금).
 *
 * ── 흐름 ──────────────────────────────────────────────────────────────────────
 * 시작 전: 마이크 점검(2초 녹음·레벨 표시 — 권한 창을 **탭 안**에서 먼저 띄운다). 거부·미지원이면 "녹음 없이 연습"(타이머만).
 * "시작" 탭 안에서 **동기로**: AudioContext 생성/resume · unlockSpeechPlayback · 오디오 세션 playback · 지시문·질문 프리페치(en-US) ·
 *   첫 단계(지시문 speakQueue) — 그다음 `POST /api/toeic/mocks/[id]/attempts`로 attemptId(녹음 IndexedDB 키).
 * 문항 하나: 지시문(파트 첫 문항, en-US + 한국어 캡션) → 표 읽기(Q8 앞 45초) → 질문 음성(Q10은 두 번) → 준비 → 비프 → 녹음 + 답변
 *   카운트다운(녹음 start 이벤트에서 시작) → 저장(IndexedDB) → 백그라운드 서버 보관(lib/toeic-rec-upload — §13-3, 동시 1개, 실패해도
 *   응시는 계속 — 진단 줄 "서버 ✓ / 올리는 중 / 대기", 끝 화면 "녹음 n개 중 m개를 서버에 보관했어요") → 다음. 단계 전이는 순수 엔진(lib/toeic-mock nextPhase·beginAnswer).
 * 끝/그만두기: `POST /api/toeic/attempts/[id]/finish` → 녹음된 문항이 1개 이상이면 STREAK_REFRESH_EVENT → "결과 보기".
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────────
 * - 시계는 **종료 시각(epoch ms)** 기반 250ms 틱. 렌더 중 Date.now()를 읽지 않는다("지금"은 state — 핸들러·타이머가 갱신).
 * - 재생과 마이크 캡처를 겹치지 않는다 — 질문 음성·비프가 끝난 뒤 녹음(세션 전환은 lib/mic-session.ts 한 곳).
 * - **마이크 유지**(2026-10-03, SPEC §20-4): 응시 하나에 `createMicKeeper()` 하나 — 마이크 점검에서 연 마이크를 응시 끝까지 쥐고
 *   문항마다 녹음기만 새로 만든다(정책 keep — Apple WebKit + audioSession). 놓는 때: 끝·그만두기·시작 실패·"녹음 없이" 시작·
 *   언마운트·pagehide·화면 숨김. 놓인 뒤 "시작"·"이 문항 다시" 탭은 탭 안에서 먼저 연다(keeper.prime — 권한 창을 탭 안에).
 * - 질문 음성은 큐가 돌려준 stop만 쓴다(전역 stopSpeaking 금지). 큐가 "stopped"(외부 pause·소리 못 냄)로 끝나거나, "done"이어도
 *   onEnd의 `sounded`가 모자라면(1~2조각 큐가 무음 — toeicSpeechOutcome) 일시정지 + "다시 듣기"/"질문 보기"(Q8–10은 평소 질문 글을 숨긴다).
 * - 녹음 중 화면이 숨겨지면 즉시 녹음을 버리고 그 문항 "중단됨" — 돌아오면 "이 문항 다시"/"다음 문항으로".
 * - **진행 멘트**(docs/harness/toeic.md §18): 준비·표 읽기 앞 "Begin preparing now.", 비프 앞 파트별 답변 멘트, Q10 둘째 재생 앞 "Now, listen again."
 *   (`toeicPhaseCue` — lib/toeic-mock). 멘트가 끝난 뒤 그 단계의 시계를 세운다(`playCue` — 안전망 없음·상한 뒤 그대로 진행).
 * - 비프는 답변 멘트 뒤 그 자리에서(lib/toeic-audio-cue), Wake Lock은 visible 복귀 때 재요청(use-toeic-wake-lock).
 * - **개발 빌드 전용** 시간 배율(localStorage `toeic-debug-timescale`) — production 번들에서는 1로 고정된다.
 * - 유형별 공략 **한 문제 연습**도 이 화면 그대로(docs/harness/toeic.md §12-7-4) — 형식표·시간·질문 음성·녹음 규칙이 실전과 같다.
 *   바뀌는 것은 셋: ① 지시문은 응시하는 그 파트 문항 수로 `toeicPartDirections(part, count)`(사진 1장 연습이면 한 장짜리 문장 —
 *   읽기·프리페치·화면 글 **세 곳이 같은 함수**라 캐시 글자가 맞는다) ② "뒤로"는 서버 페이지가 내려준 `back`(연습이면 유형 폴더)
 *   ③ 녹음 보관 풀 `recPool`(연습은 "drill" — 실전 녹음을 밀어내지 않게, §12-7-6).
 * - **문항 단위 다시 풀기**(2026-10-03, docs/harness/toeic.md §15-3)도 이 화면 그대로 — prop `retake`(원래 응시 id). 형식표·지시문(파트 첫 문항이면)·
 *   질문 음성·준비·답변 시간이 실전과 같다. 다른 것: 응시 기록 대신 `POST …/retakes`로 다시 풀기 id를 받고, 녹음은 원래 응시 id로 기기에 두며
 *   업로드에 `retakeId`를 싣고(§15-4), 끝/그만두기·화면 이탈은 `POST …/retakes/[rid]/finish`(녹음된 문항만 원래 결과에 합친다 — §15-5).
 * - **마이크 유지 대책**(2026-10-03, §15-10~§15-12 — QA q34-norec): F1 녹음 중 레벨 표본(lib/toeic-mic-health) → 무음이면 "소리 없음(무음)"(녹음은
 *   버리지 않는다) + 마이크를 놓아 다음 답변이 새로 연다 · 같은 응시에서 두 번이면 남은 문항은 문항마다 열기 · 3초 넘게 조용하면 바로 알림.
 *   F2 문항별 진단(정책·열기 횟수·오류·최고 레벨·크기)을 끝 화면 행에 보이고 끝내기 본문에 싣는다. F3 마이크를 놓은 채(keep) 준비·답변에 들어가거나
 *   녹음 시작이 8초 감시·오류로 실패하면 시험을 멈추고 "🎙️ 마이크 다시 켜기"(탭 안에서 연다) / "시간만 재고 계속".
 */

import { Barlow } from "next/font/google";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import ToeicMicKeepToggle from "@/components/toeic-mic-keep-toggle";
import { useToeicWakeLock } from "@/components/use-toeic-wake-lock";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MIC_GUM_TIMEOUT_MS,
  MicError,
  createMicKeeper,
  detectMicSupport,
  getMicDiag,
  setAudioSessionPlayback,
  type MicDiag,
  type MicKeeper,
  type MicErrorKind,
  type MicRecording,
  type RecordingResult,
} from "@/lib/mic-session";
import {
  TOEIC_MIC_CHECK_OK_LEVEL,
  initialToeicLevelTrack,
  stepToeicLevelTrack,
  toeicAnswerDiagLineKo,
  toeicMicFailureAction,
  toeicMicGate,
  toeicMicPromptReducer,
  toeicMicTroubleAction,
  toeicSilenceAlertOn,
  toeicSilenceVerdict,
  type ToeicAnswerDiag,
  type ToeicLevelTrack,
  type ToeicMicPromptEvent,
  type ToeicMicPromptState,
} from "@/lib/toeic-mic-health";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { prefetchSpeech, speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import {
  TOEIC_DEBUG_TIMESCALE_KEY,
  toeicAttemptHref,
  toeicRetakeFinishHref,
  toeicRetakesHref,
  type ToeicAttemptCreateResponse,
  type ToeicAttemptFinishResponse,
  type ToeicQuestionView,
  type ToeicRetakeFinishResponse,
  type ToeicRetakeStartResponse,
} from "@/lib/toeic-attempt-contract";
import { TOEIC_BEEP_SEC, cancelToeicBeep, ensureToeicAudio, getToeicAudioContext, resumeToeicAudio, scheduleToeicBeep } from "@/lib/toeic-audio-cue";
import {
  TOEIC_DIRECTIONS_LANG,
  TOEIC_MOCK_PARTS,
  beginAnswer,
  toeicCueCapMs,
  toeicCueTexts,
  toeicHoldForCue,
  toeicPhaseCue,
  toeicStartAfterCue,
  firstPhase,
  nextPhase,
  toeicPartDirections,
  toeicSpeechOutcome,
  type ToeicMockPart,
  type ToeicPhaseState,
} from "@/lib/toeic-mock";
import { toeicImageUrl } from "@/lib/toeic-mock-contract";
import {
  TOEIC_EXAM_CRITERIA_EN,
  TOEIC_EXAM_PART_TYPE_EN,
  formatToeicExamClock,
  toeicExamBandTitle,
  toeicExamDirectionsTitle,
  toeicExamPartRange,
  toeicExamScreenOf,
  toeicExamTimers,
} from "@/lib/toeic-exam-screen";
import type { ToeicSetBackLink } from "@/lib/toeic-guide-view";
import { deleteToeicRecordingsLocal, listToeicRecordings, saveToeicRecording, type ToeicRecPool } from "@/lib/toeic-rec-store";
import { toeicRetakeFinishOutcome, toeicRetakeHref } from "@/lib/toeic-retake";
import { drainToeicRecUploads } from "@/lib/toeic-rec-upload";
import { useToeicRecUploadStates } from "@/components/use-toeic-rec-uploads";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { splitForTts } from "@/lib/tts-split";
import s from "./toeic-take-view.module.css";

/**
 * 시험 창 머리 띠 "TOEIC Speaking" 글꼴 — 실제 시험 화면(DIN 계열)과 가장 가까운 Google 글꼴(Barlow 400, 폭·획 굵기 비교 — 리포트).
 * 이 화면에만 쓴다(next/font가 빌드 때 받아 같은 도메인에서 내준다 — 외부 요청 없음). 본문은 시험처럼 Arial.
 */
const examBrand = Barlow({ weight: "400", subsets: ["latin"], display: "swap", variable: "--toeic-exam-brand" });

const TICK_MS = 250;
const LEVEL_MS = 90;
const MIC_CHECK_MS = 2000;
/** 마이크 점검에서 "소리가 들어와요"로 보는 최고 레벨(0..1, -60dB → 0 · 0dB → 1) — 문턱 상수는 lib/toeic-mic-health 한 곳(무음 판정과 같은 척도) */
const MIC_CHECK_OK_LEVEL = TOEIC_MIC_CHECK_OK_LEVEL;
/**
 * 답변 단계에서 녹음이 이만큼 안에 시작되지 않으면 그 문항은 시간만 잰다. 값은 lib/mic-session의 getUserMedia 상한과 같다
 * (상한 상수는 그쪽 한 곳 — mic-session도 같은 상한에서 activeCaptures를 되돌리고 playback으로 복귀한다).
 */
const MIC_START_WATCHDOG_MS = MIC_GUM_TIMEOUT_MS;
/** 비프가 울린 뒤 녹음을 열기까지(비프 길이 + 여유) — 재생과 캡처를 겹치지 않는다 */
const BEEP_GAP_MS = Math.round(TOEIC_BEEP_SEC * 1000) + 150;

type Stage = "intro" | "running" | "done" | "error";
type Mode = "mic" | "nomic";

/** silent = 녹음은 됐는데 소리가 들어오지 않았다(F1 무음 판정 — 녹음은 버리지 않는다, §15-10) */
type AnswerStatus = "recording" | "recorded" | "silent" | "interrupted" | "failed" | "empty" | "nomic";
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
  /** 점검 녹음이 버려졌다(점검 중 화면 숨김·마이크 설정 바꿈 — 녹음이 null) — "✓"를 띄우지 않고 다시 점검하게(QA mic-keep P3-2) */
  | { phase: "stopped" }
  | { phase: "error"; kind: MicErrorKind; message: string };

type FinishState =
  | { phase: "idle" }
  | { phase: "saving" }
  /**
   * merged — 다시 풀기면 서버 응답(200·409 already_finished)의 합친 문항(끝 화면 문구는 이것으로 정한다 — 로컬 녹음 수가 아니라, QA rec-retake P2-2),
   * 새 응시면 null
   */
  | { phase: "saved"; recordedCount: number; merged: number[] | null }
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

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** 전체 화면 켜기/끄기(탭) — 지원하지 않거나 거부되면 조용히 무시 */
function toggleFullscreenQuietly(): void {
  try {
    const d = document as FsDoc;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      exitFullscreenQuietly();
      return;
    }
    const el = document.documentElement as FsEl;
    const r = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  } catch {
    /* 무시 */
  }
}
function exitFullscreenQuietly(): void {
  try {
    const d = document as FsDoc;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) return;
    const r = d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.();
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  } catch {
    /* 무시 */
  }
}

function kb(n: number | null): string {
  if (n === null) return "–";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 끝/그만두기 본문의 문항 목록 — 녹음됨·소리 없음(무음 — 녹음은 있다, §15-10)이면 recorded. 문항별 진단(§15-11)을 함께 싣는다.
 * 새 응시 끝내기·다시 풀기 끝·비콘·keepalive가 이 한 벌을 쓴다.
 */
function finishAnswersOf(
  qs: readonly number[],
  answers: Record<number, AnswerState>,
  diags: Record<number, ToeicAnswerDiag>,
): { q: number; recorded: boolean; durationMs: number | null; diag: ToeicAnswerDiag | null }[] {
  return qs.map((q) => {
    const a = answers[q];
    const recorded = (a?.status === "recorded" || a?.status === "silent") && (a.durationMs ?? 0) > 0;
    return { q, recorded, durationMs: recorded ? Math.round(a!.durationMs!) : null, diag: diags[q] ?? null };
  });
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

/** 진행 멘트를 읽는 동안의 앱 띠 단계 이름(§18) */
const CUE_LABEL_KO: Partial<Record<ToeicPhaseState["phase"], string>> = {
  reading: "준비 안내",
  prep: "준비 안내",
  beep: "답변 안내",
  question: "다시 듣기 안내",
};

const ANSWER_STATUS_KO: Record<AnswerStatus, string> = {
  recording: "녹음 중",
  recorded: "녹음됨",
  silent: "소리 없음(무음)",
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
  back,
  recPool,
  retake = null,
}: {
  mockId: string;
  titleKo: string;
  scope: "full" | "part";
  parts: ToeicMockPart[];
  scopeLabelKo: string;
  questions: ToeicQuestionView[];
  /** "뒤로"(헤더 링크·끝/오류 화면 버튼) — 모의고사면 학습 보기, 연습이면 유형 폴더(서버 페이지가 정한다) */
  back: ToeicSetBackLink;
  /** 녹음 보관 풀 — 연습은 "drill"(§12-7-6) */
  recPool: ToeicRecPool;
  /** 문항 단위 다시 풀기(§15-3) — 원래 응시 id와 (409 retake_in_progress 뒤 사용자가 고른) 닫을 진행 중 다시 풀기 id. null이면 새 응시 */
  retake?: { attemptId: string; replaceOpen: string | null } | null;
}) {
  const qs = useMemo(() => questions.map((v) => v.q), [questions]);
  const viewByQ = useMemo(() => new Map(questions.map((v) => [v.q, v] as const)), [questions]);
  /** 파트 → 그 파트 지시문(응시하는 문항 수로 — 사진 1장 연습이면 한 장짜리 문장). 읽기·프리페치·화면 글이 이것 하나를 본다. */
  const directionsByPart = useMemo(() => {
    const count = new Map<ToeicMockPart, number>();
    for (const v of questions) count.set(v.part, (count.get(v.part) ?? 0) + 1);
    return new Map([...count].map(([part, n]) => [part, toeicPartDirections(part, n)] as const));
  }, [questions]);

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
  /** 문항별 서버 보관 진행(§13-3 — "서버 ✓ / 올리는 중 / 대기") */
  const uploadStates = useToeicRecUploadStates(attemptId);
  /** F1 녹음 중 3초 넘게 조용함 — 실시간 알림(§15-10) */
  const [silenceAlert, setSilenceAlert] = useState(false);
  const silenceAlertRef = useRef(false);
  /** F2 문항별 진단(§15-11 — 끝 화면 행·끝내기 본문) */
  const [answerDiags, setAnswerDiags] = useState<Record<number, ToeicAnswerDiag>>({});
  const answerDiagsRef = useRef<Record<number, ToeicAnswerDiag>>({});
  /** F3 "🎙️ 마이크 다시 켜기" 상태 기계(§15-12 — lib/toeic-mic-health toeicMicPromptReducer) */
  const [micPrompt, setMicPromptState] = useState<ToeicMicPromptState>({ phase: "idle" });
  const micPromptRef = useRef<ToeicMicPromptState>({ phase: "idle" });
  const dispatchMic = useCallback((e: ToeicMicPromptEvent) => {
    const next = toeicMicPromptReducer(micPromptRef.current, e);
    micPromptRef.current = next;
    setMicPromptState(next);
  }, []);
  /** 같은 응시의 마이크 문제 횟수(F1 — 무음 판정 + 켠 뒤 muted 다시 열기) · 문항마다 열기로 바꿨는가 */
  const troublesRef = useRef(0);
  const [downgraded, setDowngraded] = useState(false);
  /** 지금 답변 녹음의 레벨 표본·진단 시작점(문항 하나 — 탭으로 다시 열어도 열기 횟수는 이어 센다) */
  const liveRef = useRef<{ q: number; track: ToeicLevelTrack; opens0: number; policy: "keep" | "per-answer"; error: string | null } | null>(null);
  /** F3 — 이 문항은 마이크 없이(시간만) 가기로 했다("시간만 재고 계속") */
  const skipMicQRef = useRef<number | null>(null);
  /** 다시 풀기 id(§15-3 — 시작 라우트가 준다) */
  const retakeIdRef = useRef<string | null>(null);
  /** 시작이 막혔을 때의 행동(다른 곳에서 다시 풀기 진행 중 → 그 다시 풀기를 닫고 새로 시작) */
  const [startAction, setStartAction] = useState<{ href: string; labelKo: string } | null>(null);
  /** 다시 풀기: 고른 문항의 예전 녹음이 이 기기에서 아직 서버에 없다(§15-3 — 다시 풀면 기기 사본이 새 녹음으로 바뀐다) */
  const [pendingOld, setPendingOld] = useState<number[]>([]);
  // ── 시험 창 표현(§17 — 상태 기계와 무관한 화면 상태) ──
  /** 실전 전체 응시의 시작 안내("Speaking Test Directions") — 준비 화면의 "▶ 시작"이 열고, 머리 띠 CONTINUE가 start()(탭 안) */
  const [testDirections, setTestDirections] = useState(false);
  /** 지금 읽는 질문 큐 조각(시작 전 -1) — Q5 상황 소개를 읽는 동안 상황 화면을 보이려고(toeicExamScreenOf) */
  const [speakIdx, setSpeakIdx] = useState(-1);
  /** 진행 멘트("Begin preparing now." 등 — §18)를 읽는 중(앱 띠 단계 이름만 바꾼다) */
  const [cueOn, setCueOn] = useState(false);
  /** 진행 멘트 상한 타이머(소리가 안 나도 이 시간 뒤 그대로 진행) */
  const cueTimerRef = useRef<number | null>(null);
  const [memoOpen, setMemoOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  /** 전체 화면 API가 있는가(마운트 뒤 판정 — 렌더 중 document 금지) · 지금 전체 화면인가 */
  const [fsSupported, setFsSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
  /** 이 응시의 마이크(전략 B — 세션 내내 하나). 렌더 중에 만들지 않는다(navigator) — 핸들러·effect에서 micKeeper()로 */
  const keeperRef = useRef<MicKeeper | null>(null);
  const micKeeper = useCallback((): MicKeeper => {
    if (!keeperRef.current) keeperRef.current = createMicKeeper();
    return keeperRef.current;
  }, []);
  /** 마이크를 놓는다(트랙 stop → playback) — 끝·그만두기·이탈·숨김. 다음 녹음은 새로 연다. */
  const releaseMic = useCallback(() => {
    keeperRef.current?.release();
  }, []);

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
  /** F2 — 그 문항의 진단을 확정한다(끝 화면 행·끝내기 본문). 레벨 표본·열기 횟수는 liveRef(그 문항)에서 */
  const finalizeDiag = useCallback(
    (q: number, status: ToeicAnswerDiag["status"], extra: { size?: number | null; durationMs?: number | null; error?: string | null; remuted?: number } = {}) => {
      const live = liveRef.current?.q === q ? liveRef.current : null;
      const k = keeperRef.current;
      const d: ToeicAnswerDiag = {
        q,
        status,
        policy: live?.policy ?? k?.policy ?? null,
        opens: Math.min(20, live && k ? Math.max(0, k.acquisitions() - live.opens0) : 0),
        remuted: Math.min(5, extra.remuted ?? 0),
        error: (extra.error ?? live?.error ?? null)?.slice(0, 120) ?? null,
        peak: live && live.track.samples > 0 ? Math.round(live.track.peak * 100) / 100 : null,
        size: extra.size ?? null,
        durationMs: extra.durationMs !== undefined && extra.durationMs !== null ? Math.max(0, Math.round(extra.durationMs)) : null,
        silent: status === "silent",
      };
      answerDiagsRef.current = { ...answerDiagsRef.current, [q]: d };
      setAnswerDiags(answerDiagsRef.current);
    },
    [],
  );

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

  // ── 다시 풀기(§15-3): 고른 문항의 예전 녹음이 이 기기에서 아직 서버에 없으면 먼저 올리고, 그래도 남으면 알린다(시작은 막지 않는다) ──
  const retakeAttemptId = retake?.attemptId ?? null;
  useEffect(() => {
    if (!retakeAttemptId) return;
    let alive = true;
    const pendingQs = async () =>
      (await listToeicRecordings(retakeAttemptId)).filter((r) => qs.includes(r.q) && r.upload === "pending").map((r) => r.q);
    void (async () => {
      if ((await pendingQs()).length === 0) return;
      await drainToeicRecUploads();
      const left = await pendingQs();
      if (alive) setPendingOld(left);
    })();
    return () => {
      alive = false;
    };
  }, [retakeAttemptId, qs]);

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
    silenceAlertRef.current = false;
    setSilenceAlert(false);
    cur?.rec.abort();
  }, []);

  // ── 녹음 보관(IndexedDB) ──
  const storeRecording = useCallback(
    (aid: string, q: number, r: RecordingResult & { createdAt: number }) => {
      // retakeId — 다시 풀기 녹음의 세대(§15-4): 업로드가 싣고, 결과 화면이 "지금 녹음"인지 가른다
      const p = saveToeicRecording({ attemptId: aid, pool: recPool, q, blob: r.blob, mimeType: r.mimeType, durationMs: r.durationMs, size: r.size, createdAt: r.createdAt, retakeId: retakeIdRef.current })
        .then((where) => patchAnswer(q, { stored: where }))
        .catch(() => patchAnswer(q, { stored: "memory" }))
        // 서버 보관(§13-3) — 기기에 저장된 직후 대기열을 백그라운드로 비운다(동시 1개, 실패는 응시를 멈추지 않는다)
        .finally(() => void drainToeicRecUploads());
      savesRef.current.push(p);
    },
    [patchAnswer, recPool],
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
        // 표현만(§17) — 지금 읽는 조각. 단계 전이에는 쓰지 않는다
        onItem: (i) => {
          if (runRef.current === token) setSpeakIdx(i);
        },
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

  /** 진행 멘트 상한 타이머만 걷는다(멘트 큐 자체는 stopSpeech — 같은 손잡이 speakStopRef) */
  const stopCue = useCallback(() => {
    if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current);
    cueTimerRef.current = null;
    setCueOn(false);
  }, []);

  /**
   * 진행 멘트(§18) — 지시문·질문과 같은 speakQueue(en-US). 끝나면(끝 알림 · 멈춤 · 소리 못 냄 · 상한 시간) `then`을 **한 번만** 부른다.
   * 질문 음성의 안전망(일시정지·"질문 보기")은 걸지 않는다 — 멘트가 안 나도 응시를 막지 않는다. 단계가 바뀌었으면(세대 token) 아무것도 하지 않는다.
   */
  const playCue = useCallback(
    (text: string | null, token: number, then: () => void) => {
      if (!text) {
        then();
        return;
      }
      stopSpeech();
      stopCue();
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        // 상한 — 아직 읽고 있으면 이 멘트의 큐만 끊는다(세대가 바뀌었으면 손잡이는 다른 소리 것이라 건드리지 않는다)
        const stop = runRef.current === token ? speakStopRef.current : null;
        if (stop) speakStopRef.current = null;
        finish();
        stop?.(); // 멈춘 큐의 onEnd는 settled라 무시된다
      }, toeicCueCapMs(text, scaleRef.current));
      function finish() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (cueTimerRef.current === timer) cueTimerRef.current = null;
        if (runRef.current !== token) return; // 그사이 단계가 바뀌었다(그만두기·건너뛰기·이 문항 다시)
        setCueOn(false);
        then();
      }
      cueTimerRef.current = timer;
      setCueOn(true);
      const stop = speakQueue([{ text, lang: TOEIC_DIRECTIONS_LANG }], {
        onEnd: () => {
          if (runRef.current === token) speakStopRef.current = null;
          finish();
        },
      });
      if (runRef.current === token && !settled) speakStopRef.current = stop;
    },
    [stopCue, stopSpeech],
  );

  const beginAnswerPhase = useCallback(
    (st: ToeicPhaseState, token: number, opts: { fromTap?: boolean } = {}) => {
      const q = st.q!;
      if (modeRef.current === "nomic") {
        patchAnswer(q, { status: "nomic" });
        finalizeDiag(q, "nomic");
        const t = Date.now();
        setPhase(scaled(beginAnswer(st, t), t));
        return;
      }
      // F3 "시간만 재고 계속"을 고른 문항 — 마이크를 열지 않고 시간만 잰다
      if (skipMicQRef.current === q) {
        patchAnswer(q, { status: "failed", error: "마이크를 다시 켜지 않고 시간만 쟀어요" });
        finalizeDiag(q, "failed", { error: "마이크를 다시 켜지 않음(시간만)" });
        const t = Date.now();
        setPhase(scaled(beginAnswer(st, t), t));
        return;
      }
      const k = micKeeper();
      // F3 — 마이크를 놓은 채(keep: 숨김·무음 판정·트랙 ended) 타이머 콜백에서 열면 iPhone이 권한 창을 띄워 8초 감시가 이 문항을 비운다(QA q34-norec
      // 갈래 B). 멈추고 "🎙️ 마이크 다시 켜기"로 탭 안에서 연다(§15-12)
      if (!opts.fromTap && toeicMicGate({ mode: "mic", policy: k.policy, holding: k.holding(), opening: k.opening() }) === "ask_tap") {
        setPhase({ ...st, endsAt: null });
        dispatchMic({ type: "need", reason: "released", q });
        return;
      }
      // F1·F2 — 이 문항의 레벨 표본·진단 시작점(탭으로 다시 열어도 열기 횟수는 이어 센다)
      if (!liveRef.current || liveRef.current.q !== q) liveRef.current = { q, track: initialToeicLevelTrack(), opens0: k.acquisitions(), policy: k.policy, error: null };
      else liveRef.current = { ...liveRef.current, track: initialToeicLevelTrack(), policy: k.policy };
      patchAnswer(q, { status: "recording", error: null, durationMs: null, size: null, mimeType: null, stored: null });
      /** 이 답변의 녹음을 포기했다(시작 실패·무응답) — 늦게 도착한 녹음은 버린다(시간만 재는 답변에 섞이지 않게) */
      let abandoned = false;
      const fallbackToTimer = (message: string, kind: MicErrorKind | "watchdog") => {
        if (runRef.current !== token || abandoned) return;
        abandoned = true;
        window.clearTimeout(watchdog);
        abortRecording();
        if (liveRef.current?.q === q) liveRef.current = { ...liveRef.current, error: message };
        setDiag(getMicDiag());
        if (toeicMicFailureAction(kind) === "ask_tap") {
          // F3 — 멈추고 탭으로 다시 켜게 한다(시계는 멈춘다). keep의 매달린 획득은 버린다 — 탭이 새로 연다
          patchAnswer(q, { status: "failed", error: message });
          const cur = phaseRef.current;
          if (cur && cur.phase === "answer") setPhase({ ...cur, endsAt: null });
          releaseMic();
          dispatchMic(opts.fromTap ? { type: "fail", message } : { type: "need", reason: "failed", q, message });
          return;
        }
        patchAnswer(q, { status: "failed", error: message });
        finalizeDiag(q, "failed", { error: message });
        setNotice(`Q${q} 녹음을 시작하지 못해 이 문항은 시간만 재요. (${message})`);
        const t = Date.now();
        const cur = phaseRef.current;
        if (cur && cur.phase === "answer") setPhase(scaled(beginAnswer(cur, t), t));
      };
      // 마이크가 끝내 답하지 않으면(권한 창이 탭 밖에서 떠 멈춤 등) 멈추고 탭으로 다시 켜게 한다 — 시험이 "녹음 준비 중"에 멈춰 서지 않게.
      // 탭으로 연 녹음은 권한 창에 답할 시간을 준다(점검과 같은 15초)
      const watchdog = window.setTimeout(() => fallbackToTimer("마이크 응답이 없어요", "watchdog"), opts.fromTap ? MIC_CHECK_GUM_TIMEOUT_MS : MIC_START_WATCHDOG_MS);
      micKeeper()
        .startRecording({ audioContext: getToeicAudioContext(), ...(opts.fromTap ? { gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS } : {}) })
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
              if (opts.fromTap) dispatchMic({ type: "opened" });
              setDiag(getMicDiag());
            },
            (e: unknown) => fallbackToTimer(e instanceof Error ? e.message : "녹음 시작 실패", e instanceof MicError ? e.kind : "failed"),
          );
        })
        .catch((e: unknown) =>
          fallbackToTimer(e instanceof MicError ? e.message : e instanceof Error ? e.message : "녹음 시작 실패", e instanceof MicError ? e.kind : "failed"),
        );
    },
    [abortRecording, dispatchMic, finalizeDiag, micKeeper, patchAnswer, releaseMic, scaled, setPhase],
  );

  /** F1 — 마이크 문제가 하나 더 났다: 무음이면 놓아 다음 답변이 새로 열게, 같은 응시에서 두 번이면 남은 문항은 문항마다 연다(기기 설정은 그대로) */
  const noteMicTrouble = useCallback(
    (kind: "silent" | "remuted") => {
      troublesRef.current += 1;
      const policy = keeperRef.current?.policy ?? "per-answer";
      const act = toeicMicTroubleAction({ troubles: troublesRef.current, policy, kind });
      if (act.perAnswer) {
        releaseMic();
        keeperRef.current = createMicKeeper({ policy: "per-answer" });
        setDowngraded(true);
      } else if (act.release) releaseMic();
    },
    [releaseMic],
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
      silenceAlertRef.current = false;
      setSilenceAlert(false);
      void cur.rec.stop().then((result) => {
        setStopping(false);
        setDiag(getMicDiag());
        const live = liveRef.current?.q === q ? liveRef.current : null;
        if (result && result.durationMs > 0) {
          const r = { ...result, createdAt: Date.now() };
          // F1 — 최고 레벨이 문턱 아래면 "소리 없음(무음)". 녹음은 버리지 않는다(기기 저장·서버 보관·recorded — 들어 보고 다시 풀거나 채점할 수 있다)
          const silent = live !== null && toeicSilenceVerdict(live.track) === "silent";
          patchAnswer(q, { status: silent ? "silent" : "recorded", durationMs: result.durationMs, mimeType: result.mimeType, size: result.size, error: null });
          finalizeDiag(q, silent ? "silent" : "recorded", { size: result.size, durationMs: result.durationMs, remuted: cur.rec.remuted });
          const aid = attemptIdRef.current;
          if (aid) storeRecording(aid, q, r);
          else pendingRecRef.current.set(q, r);
          if (cur.rec.remuted > 0) noteMicTrouble("remuted");
          if (silent) {
            setNotice(`Q${q}에 소리가 들어오지 않았어요 — 마이크를 다시 열어요. 녹음은 남겨 두었으니 결과 화면에서 들어 보세요.`);
            noteMicTrouble("silent");
          }
        } else {
          patchAnswer(q, { status: "empty", error: "녹음된 소리가 없어요" });
          finalizeDiag(q, "empty", { size: result?.size ?? 0, error: "녹음된 소리가 없어요", remuted: cur.rec.remuted });
        }
        liveRef.current = null;
        advance(token);
      });
    },
    [advance, finalizeDiag, noteMicTrouble, patchAnswer, storeRecording],
  );

  // ── 끝/그만두기 저장 ──
  const buildFinishBody = useCallback(() => {
    return { finishedAt: finishedAtRef.current, answers: finishAnswersOf(qs, answersRef.current, answerDiagsRef.current) };
  }, [qs]);
  /** 끝/그만두기 주소 — 새 응시는 `…/finish`, 다시 풀기는 `…/retakes/[rid]/finish`(§15-5 — 녹음된 문항만 원래 결과에 합친다) */
  const finishHref = useCallback((aid: string): string | null => {
    if (!retake) return `/api/toeic/attempts/${encodeURIComponent(aid)}/finish`;
    return retakeIdRef.current ? toeicRetakeFinishHref(aid, retakeIdRef.current) : null;
  }, [retake]);

  const sendFinish = useCallback(async () => {
    setFinishState({ phase: "saving" });
    await Promise.allSettled(savesRef.current); // 결과 화면이 기기 녹음을 바로 읽게
    const aid = attemptIdRef.current ?? (attemptPromiseRef.current ? await attemptPromiseRef.current : null);
    if (!aid) {
      setFinishState({ phase: "error", message: "응시 기록이 만들어지지 않아 결과를 저장할 수 없어요." });
      return;
    }
    const body = buildFinishBody();
    const href = finishHref(aid);
    if (!href) {
      setFinishState({ phase: "error", message: "다시 풀기 기록이 만들어지지 않아 결과를 저장할 수 없어요." });
      return;
    }
    finishSentRef.current = true;
    try {
      const res = await fetch(href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // 다시 풀기 끝 응답(ToeicRetakeFinishResponse)도 같은 자리(ok·recordedCount·already_finished)를 쓴다
      const data = (await res.json().catch(() => null)) as ToeicAttemptFinishResponse | ToeicRetakeFinishResponse | null;
      const recordedCount =
        data?.ok === true ? data.recordedCount : data && !data.ok && data.error === "already_finished" ? (data.recordedCount ?? 0) : null;
      if (recordedCount !== null) {
        // 다시 풀기는 서버가 실제로 합친 문항(merged)이 진실이다 — 409는 "이미 닫혔다"일 뿐 이 기기 녹음이 합쳐졌다는 뜻이 아니다
        // (다른 기기·탭이 다시 풀기를 새로 시작해 먼저 닫았으면 merged에 이 기기 녹음이 없다)
        const rd = retake ? (data as ToeicRetakeFinishResponse | null) : null;
        const merged = rd ? (rd.ok ? rd.merged : (rd.merged ?? [])) : null;
        setFinishState({ phase: "saved", recordedCount, merged });
        if (recordedCount > 0) window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 스트릭 헤드라인 즉시 갱신(§17-4)
        if (merged !== null && retakeIdRef.current) {
          // 합쳐지지 않은 이 기기 녹음 — 그 다시 풀기는 닫혔고 그 문항을 합치지 않았으니 이 사본이 들어갈 자리는 다시 생기지 않는다
          // (§15-4 5번 retaken · 결과 화면도 세대가 맞지 않아 쓰지 않는다). 이 다시 풀기 세대의 사본만 지운다(대기열에서도 빠진다)
          const { notMerged } = toeicRetakeFinishOutcome(
            qs.filter((q) => answersRef.current[q]?.status === "recorded" || answersRef.current[q]?.status === "silent"),
            merged,
          );
          if (notMerged.length > 0) void deleteToeicRecordingsLocal(aid, notMerged, { onlyGeneration: retakeIdRef.current });
        }
        return;
      }
      finishSentRef.current = false;
      setFinishState({ phase: "error", message: data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요(서버 응답 없음)." });
    } catch {
      finishSentRef.current = false;
      setFinishState({ phase: "error", message: "네트워크 문제로 결과를 저장하지 못했어요. 연결을 확인하고 다시 저장해 주세요." });
    }
  }, [buildFinishBody, finishHref, qs, retake]);

  const endTest = useCallback(
    (done: boolean) => {
      runRef.current += 1;
      stopSpeech();
      stopCue();
      cancelBeep();
      const st = phaseRef.current;
      if (recordingRef.current && st?.q) {
        abortRecording();
        patchAnswer(st.q, { status: "interrupted", error: "그만두기로 멈춤" });
        finalizeDiag(st.q, "interrupted", { error: "그만두기로 멈춤" });
      }
      dispatchMic({ type: "skip" });
      releaseMic(); // 응시가 끝났다 — 마이크를 놓는다(트랙 stop → playback)
      setPause(null);
      setLevel(0);
      finishedAtRef.current = done ? new Date().toISOString() : null;
      setCompleted(done);
      setStage("done");
      prefetchStopRef.current?.();
      prefetchStopRef.current = null;
      void sendFinish();
    },
    [abortRecording, cancelBeep, dispatchMic, finalizeDiag, patchAnswer, releaseMic, sendFinish, setPause, stopCue, stopSpeech],
  );

  const enterPhase = useCallback(
    (st: ToeicPhaseState) => {
      const token = ++runRef.current;
      // 앞 단계의 소리·멘트를 걷는다(평소엔 이미 끝났다 — 건너뛰기·이 문항 다시에서 겹치지 않게)
      stopSpeech();
      stopCue();
      setPhase(st);
      setPause(null);
      setSpeakIdx(-1);
      expiredForRef.current = null;
      setNow(Date.now());
      cancelBeepTimerOnly();
      /** 진행 멘트(§18)가 있는 단계 — 멘트를 읽는 동안 시계를 세우지 않고(종료 시각 null), 끝나면 그 단계의 시계를 멘트 끝에서 센다 */
      const holdThenStart = () => {
        const held = toeicHoldForCue(st);
        setPhase(held);
        playCue(toeicPhaseCue(st), token, () => {
          const t = Date.now();
          setNow(t);
          setPhase(scaled(toeicStartAfterCue(held, t), t));
        });
      };
      switch (st.phase) {
        case "directions": {
          const v = st.q !== null ? viewByQ.get(st.q) : undefined;
          playSpeech(v ? enPieces(directionsByPart.get(v.part)?.en ?? null) : [], token, "directions");
          break;
        }
        case "question": {
          const v = st.q !== null ? viewByQ.get(st.q) : undefined;
          const pieces = v ? [...(st.play === 0 ? enPieces(v.spokenIntro) : []), ...enPieces(v.question)] : [];
          // 두 번째 재생부터(Q10) "Now, listen again." 멘트 뒤 질문 — 멘트는 질문 큐와 따로(멘트가 안 나도 질문 안전망이 걸리지 않게)
          playCue(toeicPhaseCue(st), token, () => playSpeech(pieces, token, "question"));
          break;
        }
        case "prep": {
          // F3 — 마이크를 놓은 채(keep) 준비에 들어가면 멈추고 "🎙️ 마이크 다시 켜기"(§15-12). 탭이 연 뒤 준비를 처음부터 다시 시작한다
          if (st.q !== skipMicQRef.current) skipMicQRef.current = null;
          if (modeRef.current === "mic" && st.q !== null && skipMicQRef.current !== st.q) {
            const k = micKeeper();
            if (toeicMicGate({ mode: "mic", policy: k.policy, holding: k.holding(), opening: k.opening() }) === "ask_tap") {
              setPhase({ ...st, endsAt: null });
              dispatchMic({ type: "need", reason: "released", q: st.q });
              break;
            }
          }
          // "Begin preparing now." → 끝나면 준비 시계(§18). 비프는 이제 준비 끝이 아니라 답변 멘트 뒤라 여기서 예약하지 않는다
          if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
          beepRef.current = null;
          holdThenStart();
          break;
        }
        case "beep": {
          // 답변 멘트("Begin responding now." 등 — §18) → 비프 → 비프 길이 뒤 답변(녹음은 비프 뒤 — 멘트·비프가 녹음에 섞이지 않는다)
          resumeToeicAudio(); // 세션 전환·백그라운드로 멈췄을 수 있다 — 멘트를 읽는 동안 깨운다
          playCue(toeicPhaseCue(st), token, () => {
            const ctx = getToeicAudioContext();
            if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
            beepRef.current = null;
            if (ctx && ctx.state === "running") beepRef.current = { nodes: scheduleToeicBeep(ctx, ctx.currentTime + 0.01), at: ctx.currentTime + 0.01 };
            beepTimerRef.current = window.setTimeout(() => advance(token), BEEP_GAP_MS);
          });
          break;
        }
        case "answer":
          beginAnswerPhase(st, token);
          break;
        case "reading":
          // Q8 앞 표 읽기 — "Begin preparing now." → 끝나면 읽기 시계(§18)
          holdThenStart();
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
    [advance, beginAnswerPhase, directionsByPart, dispatchMic, endTest, micKeeper, playCue, playSpeech, scaled, setPause, setPhase, stopCue, stopSpeech, viewByQ],
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
      if (!src) return;
      const lv = src.level();
      setLevel(lv);
      // F1 — 답변 녹음의 레벨 표본(믿을 표본만 — 오디오 컨텍스트가 멈췄으면 세지 않는다) · 3초 넘게 조용하면 바로 알림
      const live = liveRef.current;
      const cur = recordingRef.current;
      if (live && cur && cur.rec === src && cur.q === live.q) {
        const at = Date.now();
        live.track = stepToeicLevelTrack(live.track, { at, level: lv, reliable: src.levelReliable() });
        const on = toeicSilenceAlertOn(live.track, at);
        if (on !== silenceAlertRef.current) {
          silenceAlertRef.current = on;
          setSilenceAlert(on);
        }
      }
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
      finalizeDiag(st.q, "interrupted", { error: "화면 숨김으로 멈춤" });
      setPhase({ ...st, endsAt: null });
      setPause({ kind: "interrupted", q: st.q });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [stage, abortRecording, finalizeDiag, patchAnswer, setPause, setPhase]);

  // ── 화면이 숨겨지면(잠금·앱 전환) 마이크를 놓는다 — 단계와 무관(SPEC §20-4 마이크 유지의 "놓는 때"). 돌아온 뒤의 녹음이 다시 연다 ──
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") releaseMic();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [releaseMic]);

  // visible 복귀: 시계 즉시 갱신 + 오디오 컨텍스트 깨우기 + Wake Lock 재요청
  const onVisible = useCallback(() => {
    setNow(Date.now());
    resumeToeicAudio();
  }, []);
  useToeicWakeLock(stage === "running", onVisible);

  // ── 전체 화면(앱 띠 "⛶ 전체 화면" — 지원할 때만, 실패는 무시) ──
  useEffect(() => {
    const d = document as Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null };
    setFsSupported(Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled));
    const onChange = () => setIsFullscreen(Boolean(d.fullscreenElement || d.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  // 응시가 끝나면(끝 화면·오류) 전체 화면에서 나온다 — 결과 화면은 앱 화면이다
  useEffect(() => {
    if (stage !== "done" && stage !== "error") return;
    exitFullscreenQuietly();
  }, [stage]);
  useEffect(() => () => exitFullscreenQuietly(), []);

  // ── 언마운트: 소리·녹음 정리, 시작했는데 끝을 못 보냈으면 best-effort로 "그만둠" 저장 ──
  useEffect(() => {
    const onPageHide = () => {
      releaseMic(); // 페이지를 떠난다 — 마이크부터 놓는다
      const aid = attemptIdRef.current;
      const href = aid ? finishHref(aid) : null;
      if (!aid || !href || finishSentRef.current) return;
      finishSentRef.current = true;
      try {
        const body = JSON.stringify({ ...buildFinishBody(), finishedAt: null });
        navigator.sendBeacon?.(href, new Blob([body], { type: "application/json" }));
      } catch {
        /* best-effort */
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [buildFinishBody, finishHref, releaseMic]);

  useEffect(
    () => () => {
      runRef.current += 1;
      const stop = speakStopRef.current;
      speakStopRef.current = null;
      stop?.();
      if (beepRef.current) cancelToeicBeep(beepRef.current.nodes);
      beepRef.current = null;
      if (beepTimerRef.current !== null) window.clearTimeout(beepTimerRef.current);
      if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current);
      recordingRef.current?.rec.abort();
      recordingRef.current = null;
      checkRecRef.current?.abort();
      keeperRef.current?.release(); // 화면을 떠났다 — 마이크를 놓는다(트랙 stop → playback)
      prefetchStopRef.current?.();
      if (checkUrlRef.current) URL.revokeObjectURL(checkUrlRef.current);
      const aid = attemptIdRef.current;
      const href = aid ? finishHrefRef.current(aid) : null;
      if (aid && href && !finishSentRef.current) {
        finishSentRef.current = true;
        // 화면을 떠났다(뒤로 가기 등) — 그만둔 응시로 닫는다(녹음된 문항은 그대로 남는다 · 다시 풀기면 녹음된 문항까지 합친다)
        const answersNow = finishAnswersOf(qsRef.current, answersRef.current, answerDiagsRef.current);
        void fetch(href, {
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
  const finishHrefRef = useRef(finishHref);
  useEffect(() => {
    finishHrefRef.current = finishHref;
  }, [finishHref]);

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
      rec = await micKeeper().startRecording({ audioContext: ctx, gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS }); // keep이면 이 마이크를 응시 끝까지 쥔다
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
    checkUrlRef.current = null;
    if (result === null) {
      // 점검 녹음이 버려졌다(점검 2초 도중 숨김 → releaseMic, 마이크 설정 바꿈) — 소리를 확인하지 못했으니 "✓"가 아니라 다시 점검(QA mic-keep P3-2)
      setMicCheck({ phase: "stopped" });
      return;
    }
    const url = URL.createObjectURL(result.blob);
    checkUrlRef.current = url;
    setMicCheck({ phase: "done", peak, url, mimeType: result.mimeType, size: result.size });
    setMode("mic");
  }

  // ── 시작(탭 — 아래는 전부 동기로, 첫 await 전에) ──
  function start() {
    if (stage !== "intro") return;
    // 점검 녹음이 아직 돌면(녹음 없이 시작) 먼저 버린다 — 트랙 stop 뒤 playback(캡처 중이면 아래 playback 전환이 무시된다)
    checkRecRef.current?.abort();
    checkRecRef.current = null;
    if (mode === "nomic") releaseMic(); // 녹음 없이 — 점검에서 연 마이크를 쥘 이유가 없다
    ensureToeicAudio();
    unlockSpeechPlayback();
    setAudioSessionPlayback(); // keep으로 마이크를 쥐고 있으면 아무것도 하지 않는다(play-and-record 유지 — 바꾸면 트랙이 끝난다)
    if (mode !== "nomic") {
      // 마이크 유지(keep): 점검 뒤 화면이 숨겨져 놓였으면 이 탭 안에서 다시 연다(권한 창이 탭 밖 타이머에서 뜨지 않게).
      // 무음 재생 잠금 해제 **뒤에** 연다(QA mic-keep P3-3 — 틀 테스트·자유대화의 "잠금 해제 → 캡처" 순서, 같은 탭·첫 await 전)
      const k = micKeeper();
      if (k.policy === "keep" && !k.holding()) void k.prime().catch(() => {}); // 실패는 첫 준비 단계의 게이트가 다시 판정한다(F3)
    }
    // 진행 멘트(§18 — 실전 5문장)를 **맨 앞에** 둔다: 멘트에는 재생 상한이 있어, 첫 응시(캐시 없음)에 지시문·질문 뒤로 밀려
    // 합성이 늦으면 멘트가 잘린다(QA cues P3-1). 캐시되면 다음 응시부터 합성 0
    const texts: string[] = [...toeicCueTexts(qs)];
    for (const part of parts) texts.push(...enPieces(directionsByPart.get(part)?.en ?? null).map((p) => p.text));
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
    if (retake) return createRetake(retake);
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

  /** 다시 풀기 시작(§15-2) — 녹음 키는 원래 응시 id, 업로드·끝은 다시 풀기 id. 409 retake_in_progress면 "그 다시 풀기를 닫고 새로 시작" */
  async function createRetake(r: { attemptId: string; replaceOpen: string | null }): Promise<string | null> {
    try {
      const res = await fetch(toeicRetakesHref(r.attemptId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: qs, replaceOpen: r.replaceOpen }),
      });
      const data = (await res.json().catch(() => null)) as ToeicRetakeStartResponse | null;
      if (data?.ok) {
        retakeIdRef.current = data.retakeId;
        attemptIdRef.current = r.attemptId;
        setAttemptId(r.attemptId);
        for (const [q, rec] of pendingRecRef.current) storeRecording(r.attemptId, q, rec);
        pendingRecRef.current.clear();
        return r.attemptId;
      }
      if (data && !data.ok && data.error === "retake_in_progress" && data.openRetake) {
        setStartAction({ href: `${toeicRetakeHref(r.attemptId, qs)}&replace=${encodeURIComponent(data.openRetake.id)}`, labelKo: "↻ 그 다시 풀기를 닫고 새로 시작" });
      }
      abortStart(data && !data.ok ? data.messageKo : "다시 풀기를 시작하지 못했어요(서버 응답 없음).");
      return null;
    } catch {
      abortStart("네트워크 문제로 다시 풀기를 시작하지 못했어요. 연결을 확인하고 다시 시작해 주세요.");
      return null;
    }
  }

  function abortStart(message: string) {
    runRef.current += 1;
    stopSpeech();
    stopCue();
    cancelBeep();
    abortRecording();
    dispatchMic({ type: "skip" });
    releaseMic();
    prefetchStopRef.current?.();
    prefetchStopRef.current = null;
    finishSentRef.current = true;
    setStartError(message);
    setStage("error");
  }

  // ── 일시정지·중단 복구(탭) ──
  /** 숨김 뒤 재개 탭 — keep이고 놓였으면 탭 안에서 다시 연다(QA mic-keep P3-4 — 다음 답변이 타이머 콜백에서 권한 창을 띄우지 않게) */
  function primeIfReleased() {
    if (modeRef.current !== "mic") return;
    const k = micKeeper();
    if (k.policy === "keep" && !k.holding() && !k.opening()) void k.prime().catch(() => {});
  }
  function replaySpeech() {
    const st = phaseRef.current;
    if (!st) return;
    primeIfReleased();
    enterPhase({ ...st }); // 같은 단계 다시 — 탭 안이라 speakQueue가 재생 잠금을 다시 푼다
  }
  function continueAfterDirections() {
    primeIfReleased();
    advance(runRef.current);
  }
  function showQuestionText() {
    const st = phaseRef.current;
    if (!st || st.q === null) return;
    primeIfReleased();
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
    // 숨김으로 마이크를 놓았다 — 이 탭 안에서 다시 연다(권한 창이 뜬다면 탭 안에서. 녹음은 질문·준비·비프 뒤라 겹치지 않는다)
    if (modeRef.current === "mic") {
      const k = micKeeper();
      if (k.policy === "keep" && !k.holding()) void k.prime().catch(() => {});
    }
    const t = Date.now();
    let solo = firstPhase([st.q], t);
    while (solo.phase === "directions" || solo.phase === "reading") solo = nextPhase([st.q], solo, t);
    patchAnswer(st.q, null);
    if (liveRef.current?.q === st.q) liveRef.current = null; // 이 문항 진단은 새로 센다
    dispatchMic({ type: "skip" });
    setNotice(null);
    enterPhase(scaled({ ...solo, index: st.index }, t));
  }
  function skipQuestion() {
    const st = phaseRef.current;
    if (!st) return;
    primeIfReleased();
    dispatchMic({ type: "skip" });
    const t = Date.now();
    enterPhase(scaled(nextPhase(qs, { ...st, phase: "answer", play: 0 }, t), t));
  }
  // ── F3 "🎙️ 마이크 다시 켜기"(탭) — 탭 안에서 동기로 연다(권한 창이 탭 맥락에서 뜨게, §15-12) ──
  function micPromptTap() {
    const mp = micPromptRef.current;
    if (mp.phase !== "ask" && mp.phase !== "failed") return;
    const st = phaseRef.current;
    if (!st || st.q === null) return;
    ensureToeicAudio();
    unlockSpeechPlayback();
    dispatchMic({ type: "tap" });
    setNotice(null);
    if (st.phase === "answer") {
      // 답변 — 그 녹음을 탭 안에서 다시 시작한다(타이머는 녹음 start부터)
      const token = ++runRef.current;
      beginAnswerPhase(st, token, { fromTap: true });
      return;
    }
    // 준비 앞 — 탭 안에서 마이크를 연 뒤 준비를 처음부터
    const k = micKeeper();
    void k.prime({ gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS }).then(
      () => {
        if (micPromptRef.current.phase !== "opening" || phaseRef.current !== st) return;
        dispatchMic({ type: "opened" });
        const v = viewByQ.get(st.q!);
        const t = Date.now();
        enterPhase(scaled({ ...st, endsAt: t + (v?.prepSec ?? 0) * 1000 }, t));
      },
      (e: unknown) => {
        if (micPromptRef.current.phase !== "opening") return;
        dispatchMic({ type: "fail", message: e instanceof MicError ? e.message : "마이크를 열지 못했어요." });
      },
    );
  }
  /** "시간만 재고 계속" — 이 문항은 마이크 없이(시간만). 준비 앞이면 준비부터, 답변이면 지금부터 답변 시간을 잰다 */
  function micPromptSkip() {
    const st = phaseRef.current;
    dispatchMic({ type: "skip" });
    if (!st || st.q === null) return;
    skipMicQRef.current = st.q;
    const t = Date.now();
    if (st.phase === "answer") {
      const token = ++runRef.current;
      beginAnswerPhase(st, token);
      return;
    }
    const v = viewByQ.get(st.q);
    enterPhase(scaled({ ...st, endsAt: t + (v?.prepSec ?? 0) * 1000 }, t));
  }
  function confirmQuit() {
    setQuitConfirm(false);
    endTest(false);
  }

  // ── 렌더 ──
  const view = phase?.q ? viewByQ.get(phase.q) : undefined;
  /** 녹음이 있는 문항 — 녹음됨 + 소리 없음(무음 — 녹음은 남겼다, §15-10) */
  const hasRec = (q: number) => answers[q]?.status === "recorded" || answers[q]?.status === "silent";
  const recordedCount = qs.filter(hasRec).length;
  /**
   * 다시 풀기 끝 — 서버 응답의 merged로 가른다(QA rec-retake P2-2). 저장 전이면 null.
   * notMerged = 이 기기에서 녹음했는데 원래 결과에 합쳐지지 않은 문항(다른 곳에서 새로 시작해 먼저 닫혔다 — 서버가 저장하지 않는다)
   */
  const retakeOutcome =
    retake && finishState.phase === "saved" && finishState.merged !== null ? toeicRetakeFinishOutcome(qs.filter(hasRec), finishState.merged) : null;
  const notMergedSet = new Set(retakeOutcome?.notMerged ?? []);
  /** 서버가 실제로 둔 녹음만 ✓ — 200 retaken(저장 안 함, slot null)은 세지 않는다 */
  const serverKept = (q: number) => uploadStates[q]?.state === "done" && uploadStates[q]?.slot !== null && !notMergedSet.has(q);
  const keepTargets = qs.filter((q) => hasRec(q) && !notMergedSet.has(q));
  const uploadedCount = keepTargets.filter(serverKept).length;
  /** 문항별 서버 보관 표시(§13-3) */
  const uploadLabel = (q: number, short = false): string => {
    if (notMergedSet.has(q)) return short ? "저장 안 됨" : "저장 안 됨(합치지 않음)";
    const st = uploadStates[q]?.state;
    if (st === "done") return serverKept(q) ? (short ? "✓" : "서버 ✓") : "서버 안 받음";
    return st === "uploading" ? "올리는 중" : st === "gone" ? "서버 안 받음" : "대기";
  };
  const qList = (list: readonly number[]) => list.map((q) => `Q${q}`).join("·");
  /** 다시 풀기 끝 화면 lead — 서버가 합친 문항으로(저장 전·실패면 그렇게 말한다) */
  const retakeLead = (): string => {
    if (finishState.phase === "error") return recordedCount > 0 ? "아직 원래 결과에 합치지 못했어요 — 아래에서 다시 저장해 주세요." : "녹음된 문항이 없어 원래 결과를 그대로 두었어요.";
    if (!retakeOutcome) return recordedCount > 0 ? `다시 푼 ${qList(qs.filter(hasRec))}를 원래 결과에 합치는 중이에요…` : "녹음된 문항이 없어 원래 결과를 그대로 두었어요.";
    const parts: string[] = [];
    if (retakeOutcome.merged.length > 0) parts.push(`다시 푼 ${qList(retakeOutcome.merged)}를 원래 결과에 합쳤어요. 결과 화면에서 AI 채점을 받으면 추정 등급을 다시 계산해요.`);
    if (retakeOutcome.notMerged.length > 0) {
      parts.push(
        `${qList(retakeOutcome.notMerged)}는 다른 기기(또는 탭)에서 다시 풀기를 새로 시작해 이 다시 풀기가 먼저 닫혀서 원래 결과에 합치지 못했어요 — 이 녹음은 저장되지 않았어요(이 기기 사본도 지웠어요). 원래 답은 그대로예요.`,
      );
    }
    if (parts.length === 0) parts.push("녹음된 문항이 없어 원래 결과를 그대로 두었어요.");
    return parts.join(" ");
  };
  const totalMin = Math.max(
    1,
    Math.round(questions.reduce((sum, v) => sum + v.prepSec + v.answerSec + v.readingSec + (v.questionPlays > 0 ? 8 * v.questionPlays : 0) + (v.directions ? 20 : 0), 0) / 60),
  );

  /** 실전 전체 응시만 시작 안내를 둔다 — 파트 연습·한 문제 연습·다시 풀기는 파트 안내부터(지금 흐름) */
  const showTestDirections = scope === "full" && !retake;

  if (stage === "error") {
    return (
      <div className={s.overlay} role="dialog" aria-modal="true" aria-label="모의고사 응시">
        <div className={s.inner}>
          <p className={s.title}>{titleKo}</p>
          <div className={s.alert} role="alert">
            {startError}
          </div>
          <div className={s.row}>
            {startAction && (
              <a href={startAction.href} className="u-btn u-btn-primary" data-testid="retake-replace">
                {startAction.labelKo}
              </a>
            )}
            <button type="button" className={`u-btn ${startAction ? "u-btn-secondary" : "u-btn-primary"}`} onClick={() => window.location.reload()}>
              ↻ 처음부터 다시
            </button>
            <Link href={back.href} className="u-btn u-btn-secondary">
              {back.buttonKo}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  /** 시험 창 머리 띠 — "TOEIC Speaking"(왼쪽 위) · 가운데 문항 · 오른쪽 CONTINUE(있으면)·VOLUME */
  const examBand = (title: string | null, onContinue: (() => void) | null) => (
    <header className={s.band}>
      <span className={s.brand}>TOEIC Speaking</span>
      {title && (
        <span className={s.bandTitle} data-testid="exam-band-title">
          {title}
        </span>
      )}
      <span className={s.bandBtns}>
        {onContinue && (
          <button type="button" className={s.continueBtn} onClick={onContinue} data-testid="exam-continue">
            CONTINUE
          </button>
        )}
        <button
          type="button"
          className={s.volumeBtn}
          onClick={() => setVolumeOpen((v) => !v)}
          aria-expanded={volumeOpen}
          aria-controls="toeic-exam-volume"
          aria-label="VOLUME — 소리 설정(질문 음성 속도·엔진)"
          data-testid="exam-volume"
        >
          <span className={s.volumeText}>VOLUME</span>
          <svg className={s.volumeIcon} viewBox="0 0 16 12" aria-hidden="true">
            <path d="M1 4h3l4-3v10L4 8H1z" fill="currentColor" />
            <path d="M10.5 3.5a3.5 3.5 0 0 1 0 5M12.5 1.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </header>
  );
  /** VOLUME이 여는 소리 설정 — 준비 화면에 있던 것과 같은 컨트롤(새 기능 없음) */
  const volumePanel = volumeOpen && (
    <div className={s.volumePanel} id="toeic-exam-volume" role="dialog" aria-label="소리 설정">
      <div className={s.volumePanelHead}>
        <p className={s.cardTitle}>🔈 소리 설정(질문 음성)</p>
        <button type="button" className={s.barBtn} onClick={() => setVolumeOpen(false)}>
          닫기
        </button>
      </div>
      <TtsSpeedControl />
      <TtsEngineControl lang="en-US" />
    </div>
  );
  const fsButton = fsSupported && (
    <button type="button" className={s.barBtn} onClick={toggleFullscreenQuietly} data-testid="exam-fullscreen">
      {isFullscreen ? "⛶ 전체 화면 끝" : "⛶ 전체 화면"}
    </button>
  );

  if (stage === "intro" && testDirections) {
    // 실전 전체 응시의 시작 안내 — 문장은 이 앱의 말(교재·ETS 문장을 옮기지 않는다). CONTINUE가 start()를 탭 안에서 부른다
    return (
      <div className={`${s.overlay} ${s.examOverlay}`} role="dialog" aria-modal="true" aria-label="모의고사 시작 안내">
        <div className={s.examStage}>
          <div className={`${s.win} ${examBrand.variable}`} data-testid="exam-window" data-screen="test-directions">
            {examBand(null, start)}
            <div className={`${s.winBody} ${s.dirBody} ${s.dirDense}`} lang="en">
              <h1 className={s.dirTitle}>Speaking Test Directions</h1>
              <p className={s.dirText}>
                This test has {qs.length} questions that measure a wide range of speaking skills. It takes about {totalMin} minutes in total.
              </p>
              <ul className={s.criteriaBox}>
                {TOEIC_MOCK_PARTS.map((part) => (
                  <li key={part} className={s.criteriaItem}>
                    <p className={s.criteriaHead}>
                      {toeicExamPartRange(part)} &lt;{TOEIC_EXAM_PART_TYPE_EN[part]}&gt;
                    </p>
                    <p className={s.criteriaText}>• {TOEIC_EXAM_CRITERIA_EN[part]}</p>
                  </li>
                ))}
              </ul>
              <p className={s.dirText}>Each question shows how much time you have to prepare and how much time you have to speak.</p>
              <p className={s.dirText}>Try to speak as much as you can in the time given. Speak clearly and follow each set of directions.</p>
              <p className={s.dirText}>
                Select <strong>Continue</strong> when you are ready to begin.
              </p>
            </div>
          </div>
        </div>
        <div className={s.appBar}>
          {/* 캡션 자리 — 응시 중 앱 띠와 같은 줄 수(창 크기가 화면마다 출렁이지 않게 — QA P3-5) */}
          <p className={s.barCaption}>CONTINUE를 누르면 시작해요.</p>
          <div className={s.appBarRow}>
            <p className={s.appStatus}>
              <span className={s.phaseLabel}>시작 안내</span>
              {scale !== 1 && <span className={s.devBadge}>⏩ ×{scale}</span>}
            </p>
            <span className={s.appBtns}>
              {fsButton}
              <button type="button" className={s.barBtn} onClick={() => setTestDirections(false)}>
                ← 준비로
              </button>
              <button type="button" className={`${s.barBtn} ${s.barBtnStrong}`} onClick={start}>
                시작
              </button>
            </span>
          </div>
        </div>
        {volumePanel}
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
            <Link href={back.href} className="u-navbtn">
              {back.labelKo}
            </Link>
            {scale !== 1 && <span className={s.devBadge}>⏩ 시간 ×{scale} (개발용)</span>}
          </div>
          <div>
            <p className={s.kicker}>{scopeLabelKo}</p>
            <h1 className={s.title}>{titleKo}</h1>
            {retake ? (
              <p className={s.lead} data-testid="retake-lead">
                {qs.map((q) => `Q${q}`).join(" · ")} 다시 풀기 · 약 {totalMin}분. 실전과 같은 지시문·질문·준비·답변 시간이에요. 녹음된 문항은 원래 결과에
                합치고(예전 답은 🎧 비교 ③ "다시 풀기 기록"에 남아요), 녹음이 안 된 문항은 예전 답을 그대로 둬요.
              </p>
            ) : (
              <p className={s.lead}>
                {questions.length}문항 · 약 {totalMin}분. 문항마다 질문을 듣고 준비한 뒤, <strong>삐— 소리가 나면</strong> 답을 말하세요. 녹음은
                이 기기에 먼저 저장하고 문항마다 서버에도 보관해요 — 끝난 뒤 결과 화면(다른 기기에서도)에서 다시 듣거나 AI 채점을 받을 수 있어요.
              </p>
            )}
            {pendingOld.length > 0 && (
              <p className={s.warn} data-testid="retake-pending-old">
                {pendingOld.map((q) => `Q${q}`).join("·")}의 예전 녹음이 아직 서버에 올라가지 않았어요 — 다시 풀면 이 기기의 예전 녹음은 새 녹음으로 바뀌어요.
              </p>
            )}
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
                    {micCheck.phase === "checking" ? "듣는 중…" : micCheck.phase === "done" ? "↻ 다시 점검" : micCheck.phase === "stopped" ? "🎙️ 다시 점검(2초)" : "🎙️ 마이크 점검(2초)"}
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
                {micCheck.phase === "stopped" && (
                  <p className={s.warn} role="status" data-testid="mic-check-stopped">
                    점검이 멈췄어요(화면이 가려졌거나 설정이 바뀌었어요) — 🎙️ 다시 점검해 주세요.
                  </p>
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
            <ToeicMicKeepToggle
              onChange={() => {
                // 정책이 바뀌었다 — 지금 쥔 마이크를 놓고 새 정책으로 다시 만든다(다음 녹음부터)
                keeperRef.current?.release();
                keeperRef.current = null;
              }}
            />
          </section>

          <details className={s.settings}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정(질문 음성)</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="en-US" />
            </div>
          </details>

          <button
            type="button"
            className={`u-btn u-btn-primary ${s.startBtn}`}
            // 실전 전체 응시는 시작 안내(Speaking Test Directions)를 먼저 — 그 화면의 CONTINUE 탭이 start()(오디오 잠금 해제·마이크가 탭 안에, §17)
            onClick={showTestDirections ? () => setTestDirections(true) : start}
            disabled={!canStart}
          >
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
          <h1 className={s.title}>{retake ? (completed ? "↻ 다시 풀기 끝" : "다시 풀기를 그만뒀어요") : completed ? "🎉 끝났어요" : "그만뒀어요"}</h1>
          <p className={s.lead} data-testid={retake ? "retake-done-lead" : undefined}>
            {retake
              ? retakeLead()
              : `녹음 ${recordedCount} / ${qs.length}문항${mode === "nomic" ? " (녹음 없이 연습)" : ""}. 결과 화면에서 다시 듣고 AI 채점을 받을 수 있어요.`}
          </p>
          {keepTargets.length > 0 && (
            <p className={s.caption} data-testid="rec-upload-summary" aria-live="polite">
              🗄️ 녹음 {keepTargets.length}개 중 {uploadedCount}개를 서버에 보관했어요
              {uploadedCount < keepTargets.length ? " — 나머지는 결과 화면에서 이어서 올려요." : "."}
            </p>
          )}
          <ul className={s.answerList}>
            {qs.map((q) => {
              const a = answers[q];
              const v = viewByQ.get(q);
              const d = answerDiags[q];
              return (
                <li key={q} className={s.answerRow} data-testid={`answer-row-${q}`}>
                  <span className={s.qBadge}>Q{q}</span>
                  <span className={s.answerPart}>{v?.partNameKo}</span>
                  <span className={`u-chip ${a?.status === "recorded" ? "u-chip-accent" : ""}`}>
                    {a ? ANSWER_STATUS_KO[a.status] : "안 함"}
                    {hasRec(q) && a?.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)}초` : ""}
                  </span>
                  {hasRec(q) && <span className={s.caption}>{uploadLabel(q)}</span>}
                  {/* F2 문항별 진단(§15-11) — 다음 "녹음이 안 됐어"에서 어느 갈래였는지 화면만으로 가른다 */}
                  {d && mode === "mic" && (
                    <span className={s.rowDiag} data-testid={`answer-diag-${q}`}>
                      {toeicAnswerDiagLineKo(d)}
                    </span>
                  )}
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
            <Link href={back.href} className="u-btn u-btn-secondary">
              {back.buttonKo}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── 응시 중 — 시험 창(실제 시험 화면 모양, §17) + 창 밖 앱 띠(조작·상태·진단) ──
  const st = phase;
  const q = st?.q ?? null;
  const a = q !== null ? answers[q] : undefined;
  const recording = st?.phase === "answer" && mode === "mic" && a?.status === "recording";
  const showQuestion =
    !!view &&
    !!view.question &&
    (view.showQuestionText || (q !== null && reveal.has(q))) &&
    st !== null &&
    st.phase !== "directions" &&
    st.phase !== "reading";
  const introPieces = view && st?.phase === "question" && st.play === 0 ? enPieces(view.spokenIntro).length : 0;
  const screen = st ? toeicExamScreenOf(st, { introPieces, speakingIndex: speakIdx, paused: pause !== null }) : "question";
  const timers = st ? toeicExamTimers(st, now) : [];
  const phaseLabel = cueOn && st
    ? CUE_LABEL_KO[st.phase] ?? "안내"
    : st?.phase === "question" && view && view.questionPlays > 1
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
  const listening = ((st?.phase === "directions" || st?.phase === "question") && !pause) || cueOn;
  const memoPhase = q !== null && (st?.phase === "prep" || st?.phase === "answer" || st?.phase === "beep");
  const timerRow = timers.length > 0 && (
    <div className={`${s.timerRow} ${view?.part === "opinion" ? s.timerCol : ""}`}>
      {timers.map((t) => (
        <div key={t.label} className={s.timerBox} role="timer" aria-label={t.label} data-running={t.running ? "1" : "0"}>
          <span className={s.timerHead}>{t.label}</span>
          <span className={s.timerValue}>{formatToeicExamClock(t.ms)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className={`${s.overlay} ${s.examOverlay}`} role="dialog" aria-modal="true" aria-label="모의고사 응시">
      <div className={s.examStage}>
        <div className={`${s.win} ${examBrand.variable}`} data-testid="exam-window" data-screen={screen}>
          {examBand(
            screen === "question" && q !== null ? toeicExamBandTitle(q) : null,
            // 지시문 음성이 멈췄을 때만 — 앱 띠의 "계속"과 같은 일(실제 시험 안내 화면에는 CONTINUE가 없다)
            screen === "directions" && pause?.kind === "speech" && pause.phase === "directions" ? continueAfterDirections : null,
          )}
          {screen === "directions" ? (
            <div className={`${s.winBody} ${s.dirBody}`} lang="en">
              {view && <h2 className={s.dirTitle}>{toeicExamDirectionsTitle(view.part, qs)}</h2>}
              {view && (
                <p className={s.dirText}>
                  <strong>Directions:</strong> {directionsByPart.get(view.part)?.en}
                </p>
              )}
            </div>
          ) : (
            <div className={`${s.winBody} ${s.qBody}`} lang="en">
              {view?.passage && <p className={s.xPassage}>{view.passage}</p>}
              {view?.picture &&
                (view.picture.imageId ? (
                  <figure className={s.xPhoto}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트 */}
                    <img src={toeicImageUrl(view.picture.imageId)} alt={`Q${view.q} 사진`} width={1536} height={1024} className={s.xPhotoImg} />
                  </figure>
                ) : (
                  <div className={s.xScene} role="group" aria-label="장면 설명" lang="ko">
                    <p className={s.xSceneCap}>📷 사진 대신 장면 설명</p>
                    <p>{view.picture.sceneKo}</p>
                  </div>
                ))}
              {view?.intro && <p className={s.xIntro}>{view.intro}</p>}
              {screen === "question" && view?.table && (
                <div className={s.xTable}>
                  <p className={s.xTableTitle}>{view.table.title}</p>
                  {view.table.meta.map((m, k) => (
                    <p key={k} className={s.xTableMeta}>
                      {m}
                    </p>
                  ))}
                  <table className={s.xTableGrid}>
                    <tbody>
                      {view.table.rows.map((r, k) => (
                        <tr key={k}>
                          <th scope="row">{r.left}</th>
                          <td>{r.right}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {view.table.notes.map((n, k) => (
                    <p key={k} className={s.xTableNote}>
                      {n}
                    </p>
                  ))}
                </div>
              )}
              {screen === "question" &&
                showQuestion &&
                view?.question &&
                (view.part === "opinion" ? (
                  // 의견 질문 — 문단(줄바꿈)마다 따로(실제 시험의 질문 + "근거를 들어 말하라" 둘째 문단 모양)
                  <div className={s.xOpinion}>
                    {view.question
                      .split(/\n+/)
                      .filter((line) => line.trim() !== "")
                      .map((line, k) => (
                        <p key={k}>{line}</p>
                      ))}
                  </div>
                ) : (
                  <p className={s.xQuestion}>{view.question}</p>
                ))}
              {screen === "question" && timerRow}
            </div>
          )}
        </div>
      </div>

      {/* 앱 띠 — 시험 창 밖(조작·상태·진단, 한국어). 시험 창에는 실제 시험에 없는 것을 두지 않는다 */}
      <div className={s.appBar}>
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

        {/* F3 — 마이크를 놓은 채 준비·답변에 들어가거나 녹음 시작이 실패했다: 멈추고 탭 안에서 다시 켠다(§15-12) */}
        {micPrompt.phase !== "idle" && (
          <div className={s.alert} role="alert" data-testid="mic-prompt">
            <p>
              {micPrompt.phase === "opening"
                ? "마이크를 여는 중… 권한 창이 뜨면 허용해 주세요."
                : micPrompt.phase === "failed"
                  ? `마이크를 다시 켜지 못했어요 — ${micPrompt.message}`
                  : micPrompt.reason === "failed"
                    ? `Q${micPrompt.q ?? ""} 녹음을 시작하지 못했어요${micPrompt.message ? `(${micPrompt.message})` : ""}. 🎙️ 마이크를 다시 켜 주세요.`
                    : `마이크가 꺼져 있어요(화면이 꺼졌거나 소리가 안 들어와 놓았어요). Q${micPrompt.q ?? ""}를 녹음하려면 🎙️ 마이크를 다시 켜 주세요.`}
            </p>
            {micPrompt.phase !== "opening" && (
              <div className={s.row}>
                <button type="button" className="u-btn u-btn-primary" onClick={micPromptTap} data-testid="mic-reopen">
                  🎙️ 마이크 다시 켜기
                </button>
                <button type="button" className="u-btn u-btn-secondary" onClick={micPromptSkip} data-testid="mic-skip">
                  시간만 재고 계속
                </button>
              </div>
            )}
          </div>
        )}

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
        {/* F1 — 녹음 중 3초 넘게 조용하면 바로 알린다(녹음은 멈추지 않는다, §15-10) */}
        {recording && silenceAlert && (
          <p className={s.silence} role="status" data-testid="silence-alert">
            🔇 소리가 안 들어와요 — 마이크를 가리지 않았는지 확인해 주세요.
          </p>
        )}
        {notice && <p className={s.warn}>{notice}</p>}
        {view && !view.available && st?.phase !== "directions" && <p className={s.warn}>이 문항의 자료가 모의고사에 없어요 — 시간만 재요.</p>}
        {/* 지시문 한국어 캡션 — 시험 창에는 영어만(실제 시험처럼). 자리는 늘 둔다(가로 배치에서 앱 띠 높이 = 시험 창 크기가 화면마다
            출렁이지 않게 — QA P3-5). 세로 배치는 빈 자리를 접는다 */}
        {st?.phase === "directions" && view ? (
          <p className={s.barCaption}>{directionsByPart.get(view.part)?.ko}</p>
        ) : (
          <p className={`${s.barCaption} ${s.barCaptionEmpty}`} aria-hidden="true">
            {"\u00a0"}
          </p>
        )}

        <div className={s.appBarRow}>
          <p className={s.appStatus} aria-live="polite">
            {recording && <span className={s.recDot} aria-hidden="true" data-testid="rec-dot" />}
            <span className={s.qBadge}>Q{q ?? "–"}</span>
            <span className={s.phaseLabel}>
              {phaseLabel}
              {listening ? " 🔊" : ""}
            </span>
            <span className={s.progress}>
              {(st?.index ?? 0) + 1} / {qs.length}
            </span>
            {recording && (
              <span className={s.miniMeter} role="meter" aria-label="입력 레벨" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                <span className={s.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
            )}
            {scale !== 1 && <span className={s.devBadge}>⏩ ×{scale}</span>}
          </p>
          <span className={s.appBtns}>
            {q !== null && (
              <button type="button" className={s.barBtn} onClick={() => setMemoOpen((v) => !v)} aria-expanded={memoOpen}>
                📝 메모
              </button>
            )}
            {diag && mode === "mic" && (
              <button type="button" className={s.barBtn} onClick={() => setDiagOpen((v) => !v)} aria-expanded={diagOpen} aria-controls="toeic-exam-diag">
                진단
              </button>
            )}
            {fsButton}
            <button type="button" className={s.quitBtn} onClick={() => setQuitConfirm(true)}>
              그만두기
            </button>
          </span>
        </div>

        {/* 메모장 — 저장하지 않는다. 문항마다 따로(실제 시험엔 없다 — 앱 띠에서 열 때만) */}
        {memoOpen && q !== null && (
          <label className={s.memo}>
            <span className={s.caption}>Q{q} 메모(저장 안 함){memoPhase ? "" : " — 준비·답변 때 쓰세요"}</span>
            <textarea
              value={memo[q] ?? ""}
              onChange={(e) => setMemo((prev) => ({ ...prev, [q]: e.target.value }))}
              rows={2}
              className={s.memoInput}
            />
          </label>
        )}

        {/* 진단 줄 — 앱 띠 "진단" 버튼으로 연다(닫혀 있어도 DOM에 있다 — 내용·testid 그대로) */}
        {diag && mode === "mic" && (
          <p className={s.diag} id="toeic-exam-diag" hidden={!diagOpen}>
              진단 · {diag.keep ? `마이크 ${diag.keep.policy === "keep" ? "유지" : downgraded ? "문항마다(이번 응시만 — 소리 문제 2회)" : "문항마다"} · 열기 ${diag.keep.acquisitions}회 · ` : ""}녹음 형식{" "}
              {diag.mimeType ?? diag.requestedMimeType ?? "기본"} · 마지막{" "}
              {diag.durationMs !== null ? `${(diag.durationMs / 1000).toFixed(1)}초` : "–"} · {kb(diag.size)} · 세션 {diag.audioSession ?? "API 없음"}
              {diag.error ? ` · 오류 ${diag.error}` : ""}
              {attemptId ? "" : " · 응시 기록 만드는 중"}
              {recordedCount > 0 && (
                <span data-testid="rec-upload-diag">
                  {" · 서버 "}
                  {qs
                    .filter(hasRec)
                    .map((q) => `Q${q} ${uploadLabel(q, true)}`)
                    .join(" · ")}
                </span>
              )}
          </p>
        )}
      </div>
      {volumePanel}
    </div>
  );
}

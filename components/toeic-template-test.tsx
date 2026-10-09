"use client";

/**
 * 🧩 틀 테스트 — (가) 예문 말하기 · (나) 틀 바꿔 말하기 (docs/harness/toeic.md §12-5-3~§12-5-6, SPEC §20-10) — 클라이언트 컴포넌트.
 *
 * 문항은 서버(`app/toeic/guides/[part]/templates/test/page.tsx`)가 조립해 넘긴다(고정 — hydration 안전). 여기선 진행·녹음·받아쓰기·
 * 비교 표시·판정·저장만 한다. 판단은 순수 함수(lib/toeic-template — 비교·상한, lib/toeic-template-test-view — 단서·유효 시도·저장 항목·요약).
 *
 * ── 흐름(탭마다 한 걸음 — 소리는 그 탭 핸들러 안에서 시작한다) ─────────────────────────
 * - **시작 탭**(검토 개선 7): `unlockSpeechPlayback()`·오디오 세션 playback·Wake Lock·멱등 키(소문자 UUID)·startedAt·첫 문항 소리.
 *   페이지가 열린 직후에는 소리 잠금을 푼 탭이 없어 iOS가 첫 소리를 막는다 — 그래서 "시작"을 먼저 둔다.
 * - (가): 정답 예문의 한국어 + 묶음·쓰임 한 줄만. (나): **영어 글자 0** — 한국어 틀의 자리마다 이번 문항의 영어 채움 칩(대본에 없던
 *   채움)과 묶음·쓰임 한 줄. 문항을 여는 탭에서 같은 틀의 다른 예문을 **소리로만** 한 번 읽고 🔊 다시 듣기를 둔다.
 *   묶음·쓰임 한 줄은 두 모드 모두 라틴을 "…"로 가린다(templateTestPromptMeta — `useKo`가 틀의 영어 고정 낱말을 담을 수 있다, QA S2 P2-1).
 * - 🎤 말하기 탭: **큐 멈춤 → unlockSpeechPlayback() → startRecording()** 순서(0.1초 무음 재생과 캡처 시작이 겹치지 않게 — 선례
 *   talk-start-view). 녹음 규칙은 응시와 같다(lib/mic-session — 재생과 캡처를 겹치지 않는다, 대기 상한, 첫 녹음은 권한 창 15초).
 *   **마이크 유지**(2026-10-03, SPEC §20-4): 테스트 하나에 `createMicKeeper()` 하나 — 첫 🎤에서 연 마이크를 끝까지 쥐고 🎤마다
 *   녹음기만 새로 만든다. 놓는 때: 끝·그만두기·"녹음 없이" 전환·언마운트·pagehide·화면 숨김. 다시 열어야 할 때만 15초 상한.
 * - "다 말했어요" 탭 또는 20초 → 녹음 끝(트랙 stop 뒤 playback) → 0.6초 미만이면 보내지 않음 → `toWav16kMono`(실패하면 원본) →
 *   전사 라우트(요청마다 45초 타임아웃). 한 번에 하나(요청이 떠 있는 동안 말하기 잠금), 문항당 2·세션당 20(canTranscribeAgain 하나).
 * - **유효한 첫 시도**(받아쓰기가 오고 들은 낱말이 있다 — isValidTemplateAttempt)로 판정한다. 무효면 정답을 공개하지 않은 채
 *   "잘 안 들렸어요" + 🎤 다시 말하기(상한 안) / 받아쓰기 없이 판정. 결과: 정답(고정 부분 굵게·채움 밑줄)·내가 한 말·비교 칩·제안 ○/✕·
 *   🔊 정답(한 번 자동 재생)·▶ 내 녹음(이 기기 메모리에만 — 세션이 끝나면 버린다). 정답을 본 뒤에는 "🗣️ 한 번 더 따라 말하기"뿐
 *   (녹음·전사·판정 변화 없음, 무음 쉼으로 따라 말할 틈).
 * - **최종 ○/✕는 아빠가 정한다** — 이 판정 탭이 다음 문항을 연다((나)는 그 탭 안에서 다음 문항의 예문 소리를 시작한다).
 * - 자기 판정 폴백(문항이 막히지 않게): 마이크 거부·미지원·녹음 실패 → 그 세션은 "녹음 없이"(말한 뒤 "정답 보기"), 키 없음(501) →
 *   받아쓰기 끔, 세션 상한 → 그 뒤 문항은 자기 판정. 이유를 한 줄로 알린다.
 * - 녹음 중(마이크 준비 포함) 화면이 숨겨지면 그 녹음은 버리고 그 문항을 탭("이 문항 다시")으로 다시 연다.
 * - 끝·그만두기 → 저장(`POST /api/toeic/guides/templates/sessions` — 멱등 키로 "다시 저장"·화면 이탈 저장이 같은 판을 두 벌 쌓지 않는다).
 *   판정한 문항이 없으면 저장하지 않는다. 화면을 떠나면(언마운트·pagehide 비캐시) 판정한 문항을 keepalive로 저장한다(best-effort) —
 *   진행 중이면 그만두기 모양, 끝 화면 저장이 실패한 채("다시 저장"이 보이는 채)면 그 판 본문 그대로(templateTestLeaveSave).
 *
 * 멈출 때는 이 화면이 연 큐의 stop을 쓴다(stopSpeaking 금지 — 다른 화면의 재생을 건드리지 않게). 모든 글은 텍스트로만 넣는다.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ToeicMicKeepToggle from "@/components/toeic-mic-keep-toggle";
import { ExampleLine, FrameLine, slotChipClass } from "@/components/toeic-template-lines";
import { useToeicWakeLock } from "@/components/use-toeic-wake-lock";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MicError,
  createMicKeeper,
  detectMicSupport,
  setAudioSessionPlayback,
  toWav16kMono,
  type MicKeeper,
  type MicRecording,
  type RecordingResult,
} from "@/lib/mic-session";
import { prefetchSpeech, speakQueue, unlockSpeechPlayback, type SpeakQueueItem } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName } from "@/lib/toeic-attempt-contract";
import { shadowPauseMs } from "@/lib/toeic-guide";
import {
  TOEIC_TEMPLATE_AUDIO_MAX_BYTES,
  TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO,
  type ToeicGuidePart,
  type ToeicTemplateSessionRequest,
  type ToeicTemplateSessionResponse,
  type ToeicTemplateTranscribeResponse,
} from "@/lib/toeic-guide-contract";
import { slotToneMap } from "@/lib/toeic-guide-view";
import type { ToeicTemplateQuizMode } from "@/lib/toeic-quiz";
import {
  TOEIC_TEMPLATE_REC_MAX_MS,
  TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS,
  canTranscribeAgain,
  compareTemplateAnswer,
  compareWithAlternatives,
  frameSlotNames,
  isSendableTemplateRecording,
  type TemplateAnswerCheck,
} from "@/lib/toeic-template";
import {
  TOEIC_TEMPLATE_SELF_REASON_KO,
  TOEIC_TEMPLATE_TEST_MODE_HINT_KO,
  TOEIC_TEMPLATE_TEST_MODE_TAG_KO,
  isValidTemplateAttempt,
  newTemplateSessionId,
  templateSwapClue,
  templateTestCostLabelKo,
  templateTestItems,
  templateTestLeaveSave,
  templateTestPromptMeta,
  templateTestSummary,
  toeicTemplateTabHref,
  type ToeicTemplateSelfReason,
  type ToeicTemplateTestScope,
  type ToeicTemplateTestStage,
  type ToeicTemplateVerdict,
} from "@/lib/toeic-template-test-view";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import StreakFinishHint from "@/components/streak-finish-hint";
import s from "./toeic-template-test.module.css";

/** 서버가 넘기는 문항 하나(필요한 칸만 — 다른 예문·다른 테스트 채움은 넘기지 않는다) */
export interface ToeicTemplateTestItemView {
  key: string;
  groupKo: string;
  useKo: string;
  frameEn: string;
  frameKo: string;
  /** 정답 문장 — (가) 그 예문 / (나) 틀 + 테스트 전용 채움(대본에 없던 새 문장) */
  answerEn: string;
  answerFills: string[];
  /** (가) 화면 단서(한국어 뜻) / (나) null */
  answerKo: string | null;
  /** (나) 문항을 여는 탭에서 소리로만 읽는 예문 / (가) null */
  listenEn: string | null;
  review: boolean;
  /** (가) 같은 뜻 교재 틀(한국어 틀이 같다) — 비교 대안 */
  alternatives: { key: string; frameEn: string; frameKo: string }[];
}

type Stage = ToeicTemplateTestStage;

type Phase =
  | { kind: "ask" }
  | { kind: "arming" }
  | { kind: "recording"; startedAt: number }
  | { kind: "stopping" }
  | { kind: "transcribing" }
  | { kind: "invalid"; reasonKo: string }
  | { kind: "interrupted" }
  | { kind: "result"; transcript: string; check: TemplateAnswerCheck; viaFrameEn: string | null }
  | { kind: "reveal"; noteKo: string | null };

type SaveState = "idle" | "saving" | "saved" | "error";

const EN = "en-US";

export default function ToeicTemplateTest({
  part,
  mode,
  scope,
  scopeLabelKo,
  questions,
  backHref,
  modeHrefs,
  retryHref,
  wrongRetryHref,
}: {
  part: ToeicGuidePart;
  mode: ToeicTemplateQuizMode;
  scope: ToeicTemplateTestScope;
  scopeLabelKo: string;
  questions: ToeicTemplateTestItemView[];
  backHref: string;
  modeHrefs: Record<ToeicTemplateQuizMode, string>;
  retryHref: string;
  wrongRetryHref: string;
}) {
  usePhraseHelperBlock(); // 시험·응답 중에는 표현 도우미를 띄우지 않는다(SPEC §22-3)
  const total = questions.length;
  const keys = useMemo(() => questions.map((q) => q.key), [questions]);

  // ── 상태(+ 비동기 콜백이 같은 순간을 보도록 ref) ──
  const [stage, setStageState] = useState<Stage>("intro");
  const stageRef = useRef<Stage>("intro");
  const setStage = useCallback((v: Stage) => {
    stageRef.current = v;
    setStageState(v);
  }, []);
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const [phase, setPhaseState] = useState<Phase>({ kind: "ask" });
  const phaseRef = useRef<Phase>({ kind: "ask" });
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [verdicts, setVerdicts] = useState<(ToeicTemplateVerdict | null)[]>(() => questions.map(() => null));
  const verdictsRef = useRef<(ToeicTemplateVerdict | null)[]>(questions.map(() => null));
  const [selfReason, setSelfReasonState] = useState<ToeicTemplateSelfReason | null>(null);
  const selfReasonRef = useRef<ToeicTemplateSelfReason | null>(null);
  const setSelfReason = useCallback((r: ToeicTemplateSelfReason | null) => {
    selfReasonRef.current = r;
    setSelfReasonState(r);
  }, []);
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const [counts, setCountsState] = useState({ perQuestion: 0, perSession: 0 });
  const countsRef = useRef({ perQuestion: 0, perSession: 0 });
  const setCounts = useCallback((c: { perQuestion: number; perSession: number }) => {
    countsRef.current = c;
    setCountsState(c);
  }, []);
  const [myRecUrl, setMyRecUrl] = useState<string | null>(null);
  const myRecUrlRef = useRef<string | null>(null);
  const [cue, setCue] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micSupported, setMicSupported] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const runRef = useRef(0); // 문항 안 비동기 콜백 무효화 토큰(녹음·전사)
  const stopSoundRef = useRef<(() => void) | null>(null);
  const recRef = useRef<MicRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const firstMicRef = useRef(true);
  /** 이 테스트의 마이크(전략 B — 테스트 내내 하나). 렌더 중에 만들지 않는다(navigator) — 핸들러에서 micKeeper()로 */
  const keeperRef = useRef<MicKeeper | null>(null);
  const micKeeper = (): MicKeeper => {
    if (!keeperRef.current) keeperRef.current = createMicKeeper();
    return keeperRef.current;
  };
  const sessionIdRef = useRef<string>("");
  const startedAtRef = useRef<string>("");
  const finishedAtRef = useRef<string | null | undefined>(undefined);
  const savedRef = useRef(false);
  const savingRef = useRef(false);
  const prefetchStopRef = useRef<(() => void) | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  useToeicWakeLock(stage === "run");

  // 마이크 지원 — 렌더 중이 아니라 마운트 뒤에 본다(hydration)
  useEffect(() => {
    setMicSupported(detectMicSupport().ok);
  }, []);

  const q = questions[index] ?? null;

  // ── 소리 — 이 화면이 연 큐만 멈춘다(stopSpeaking 금지) ──
  const stopSound = useCallback(() => {
    const st = stopSoundRef.current;
    stopSoundRef.current = null;
    st?.();
    setCue(false);
  }, []);
  /** 소리를 튼다 — ⚠️ 탭 핸들러 안에서 부르면 iOS 탭 안 재생 규칙을 지킨다(결과 자동 재생은 시작 탭에서 푼 요소를 쓴다) */
  const play = useCallback(
    (items: SpeakQueueItem[], withCue = false) => {
      stopSound();
      stopSoundRef.current = speakQueue(items, {
        onPause: () => {
          if (withCue) setCue(true);
        },
        onEnd: () => setCue(false),
      });
    },
    [stopSound],
  );

  const revokeMyRec = useCallback(() => {
    if (myRecUrlRef.current) URL.revokeObjectURL(myRecUrlRef.current);
    myRecUrlRef.current = null;
    setMyRecUrl(null);
  }, []);

  const clearAutoStop = useCallback(() => {
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
  }, []);

  /** 문항 안 비동기(녹음·전사)를 모두 끊는다 — 늦게 온 콜백은 토큰으로 무시 */
  const haltAsync = useCallback(() => {
    runRef.current += 1;
    clearAutoStop();
    recRef.current?.abort();
    recRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [clearAutoStop]);

  // ── 문항 열기(탭 안) ──
  const openQuestion = useCallback(
    (i: number, reopen = false) => {
      haltAsync();
      stopSound();
      revokeMyRec();
      indexRef.current = i;
      setIndexState(i);
      setPhase({ kind: "ask" });
      if (!reopen) setCounts({ perQuestion: 0, perSession: countsRef.current.perSession });
      const cur = questions[i];
      if (!cur) return;
      // 미리 받기 — 이 문항 정답(자동 재생·🔊)과 다음 문항의 들려줄 예문(판정 탭에서 곧바로 난다). 문항마다 짧은 합성 1회(§12-5-8)
      prefetchStopRef.current?.();
      const texts = [cur.answerEn, questions[i + 1]?.listenEn ?? ""].map((t) => t.trim()).filter(Boolean);
      prefetchStopRef.current = texts.length > 0 ? prefetchSpeech(texts, EN) : null;
      // (나) 문항을 여는 탭에서 예문을 소리로만 한 번(영어 글자는 보이지 않는다)
      if (cur.listenEn) play([{ text: cur.listenEn, lang: EN }]);
    },
    [haltAsync, stopSound, revokeMyRec, setPhase, setCounts, questions, play],
  );

  // ── 시작 탭 ──
  function start(withoutMic: boolean) {
    if (stageRef.current !== "intro" || total === 0) return;
    unlockSpeechPlayback(); // 시작 탭 안에서 — 이후 탭 밖(받아쓰기 응답 뒤) 정답 자동 재생도 같은 요소로 난다
    setAudioSessionPlayback();
    sessionIdRef.current = newTemplateSessionId();
    startedAtRef.current = new Date().toISOString();
    finishedAtRef.current = undefined;
    savedRef.current = false;
    if (withoutMic || micSupported === false || !detectMicSupport().ok) setSelfReason("nomic");
    setStage("run");
    openQuestion(0);
  }

  // ── 🎤 말하기(탭): 큐 멈춤 → unlockSpeechPlayback() → startRecording() ──
  function onMic() {
    const ph = phaseRef.current.kind;
    if ((ph !== "ask" && ph !== "invalid") || selfReasonRef.current !== null || !canTranscribeAgain(countsRef.current)) return;
    stopSound();
    unlockSpeechPlayback();
    haltAsync();
    const token = runRef.current;
    setPhase({ kind: "arming" });
    const keeper = micKeeper();
    // 마이크를 (다시) 열어야 할 때만 권한 창 시간(15초) — 첫 🎤, 또는 keep인데 놓인 뒤(숨김 등)
    const needsPrompt = firstMicRef.current || (keeper.policy === "keep" && !keeper.holding());
    const micFail = (e: unknown) => {
      if (runRef.current !== token) return;
      recRef.current?.abort();
      recRef.current = null;
      keeperRef.current?.release(); // 이 세션은 "녹음 없이" — 마이크를 쥘 이유가 없다
      clearAutoStop();
      const msg = e instanceof MicError ? e.message : e instanceof Error ? e.message : "녹음을 시작하지 못했어요.";
      setMicNotice(msg);
      setSelfReason("nomic");
      setPhase({ kind: "ask" });
    };
    keeper
      .startRecording(needsPrompt ? { gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS } : {})
      .then((rec) => {
        if (runRef.current !== token) {
          rec.abort();
          return;
        }
        recRef.current = rec;
        firstMicRef.current = false;
        rec.started.then(
          (t) => {
            if (runRef.current !== token) return;
            setElapsed(0);
            setPhase({ kind: "recording", startedAt: t });
            autoStopRef.current = window.setTimeout(() => finishRecording(token), TOEIC_TEMPLATE_REC_MAX_MS);
          },
          (e: unknown) => micFail(e),
        );
      })
      .catch((e: unknown) => micFail(e));
  }

  // 정답이 열리면 정답·판정 버튼이 화면 안에 오게(폰에서 문제 카드 아래로 밀려 스크롤해야 하지 않게)
  const answerOpen = phase.kind === "result" || phase.kind === "reveal";
  useEffect(() => {
    if (!answerOpen) return;
    const el = answerRef.current;
    if (!el) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* noop */
    }
    el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [answerOpen, index]);

  // 녹음 경과 시계(표시만)
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const startedAt = phase.startedAt;
    const id = window.setInterval(() => setElapsed(Math.max(0, Date.now() - startedAt)), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // ── 녹음 끝("다 말했어요" 탭 또는 20초) ──
  function finishRecording(token: number) {
    if (runRef.current !== token || phaseRef.current.kind !== "recording") return;
    clearAutoStop();
    const rec = recRef.current;
    recRef.current = null;
    setPhase({ kind: "stopping" });
    if (!rec) {
      setPhase({ kind: "invalid", reasonKo: "녹음이 멈춰 버렸어요." });
      return;
    }
    void rec.stop().then((result) => {
      setAudioSessionPlayback(); // 트랙 stop 뒤(모듈이 이미 했어도 무해) — 정답 소리가 수화기로 가지 않게
      if (runRef.current !== token) return;
      if (!result || !isSendableTemplateRecording(result.durationMs)) {
        setPhase({ kind: "invalid", reasonKo: "잘 안 들렸어요 — 녹음이 너무 짧아요." });
        return;
      }
      revokeMyRec();
      const url = URL.createObjectURL(result.blob);
      myRecUrlRef.current = url;
      setMyRecUrl(url);
      void transcribe(token, result);
    });
  }

  // ── 받아쓰기(전사 라우트 — 녹음만 보낸다, 정답은 보내지 않는다) ──
  async function transcribe(token: number, rec: RecordingResult) {
    const cur = questions[indexRef.current];
    if (!cur) return;
    setPhase({ kind: "transcribing" });

    const invalid = (reasonKo: string) => {
      if (runRef.current !== token) return;
      setPhase({ kind: "invalid", reasonKo });
    };

    // WAV 16kHz mono로(실패하면 원본) — 채점 업로드와 같은 규칙, 1 MiB 안
    let upload: Blob = rec.blob;
    try {
      const wav = await toWav16kMono(rec.blob);
      if (wav.blob.size <= TOEIC_TEMPLATE_AUDIO_MAX_BYTES) upload = wav.blob;
    } catch {
      /* 원본으로 */
    }
    if (runRef.current !== token) return; // 변환 중에 끊겼다("기다리지 않고 판정하기"·숨김·그만두기) — 보내지 않았으니 세지 않는다(QA S2 P3-3)
    const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(rec.mimeType);
    if (upload.size > TOEIC_TEMPLATE_AUDIO_MAX_BYTES || !isAcceptedToeicAudioType(type)) {
      invalid(upload.size > TOEIC_TEMPLATE_AUDIO_MAX_BYTES ? "녹음이 너무 길어 받아쓰기를 못 했어요." : "이 녹음 형식은 받아쓰기를 못 해요."); // 보내지 않았다 — 세지 않는다
      return;
    }
    const fd = new FormData();
    fd.append(TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO, upload.type ? upload : new Blob([upload], { type }), toeicAudioFileName(type) ?? "answer.webm");

    // 받아쓰기 수는 **보낸 요청만** 센다 — 요청 바로 앞에서 올린다(보낸 뒤의 실패·빈 전사·끊음은 센다, 501은 아래에서 되돌린다)
    const before = countsRef.current;
    setCounts({ perQuestion: before.perQuestion + 1, perSession: before.perSession + 1 });
    const ac = new AbortController();
    abortRef.current = ac;
    const timer = window.setTimeout(() => ac.abort(), TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS);
    let status = 0;
    let data: ToeicTemplateTranscribeResponse | null = null;
    try {
      const res = await fetch("/api/toeic/guides/templates/transcribe", { method: "POST", body: fd, signal: ac.signal });
      status = res.status;
      data = (await res.json().catch(() => null)) as ToeicTemplateTranscribeResponse | null;
    } catch {
      data = null;
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === ac) abortRef.current = null;
    }
    if (runRef.current !== token) return;

    if (data?.ok) {
      const check =
        mode === "tpl-recall"
          ? compareWithAlternatives({ key: cur.key, frameEn: cur.frameEn, frameKo: cur.frameKo }, cur.alternatives, cur.answerFills, data.text)
          : { check: compareTemplateAnswer(cur.frameEn, cur.answerFills, data.text), matchedKey: cur.key, viaAlternative: false };
      if (!isValidTemplateAttempt(data, check.check)) {
        invalid("잘 안 들렸어요 — 받아쓰기에 낱말이 없어요.");
        return;
      }
      const via = check.viaAlternative ? (cur.alternatives.find((a) => a.key === check.matchedKey)?.frameEn ?? null) : null;
      setPhase({ kind: "result", transcript: data.text, check: check.check, viaFrameEn: via });
      play([{ text: cur.answerEn, lang: EN }]); // 정답 한 번 자동 재생(들어 보기) — 시작 탭에서 푼 요소로
      return;
    }
    if (data && !data.ok && data.error === "no_api_key") {
      setCounts(before); // 받아쓰기가 일어나지 않았다
      setSelfReason("nokey");
      setPhase({ kind: "reveal", noteKo: TOEIC_TEMPLATE_SELF_REASON_KO.nokey });
      play([{ text: cur.answerEn, lang: EN }]);
      return;
    }
    const why = ac.signal.aborted ? "받아쓰기가 너무 오래 걸렸어요" : status === 0 ? "연결이 끊겼어요" : "받아쓰기를 못 했어요";
    invalid(`잘 안 들렸어요 — ${why}.`);
  }

  // ── 받아쓰기 없이 판정(탭) / 정답 보기(녹음 없이·자기 판정) ──
  function revealWithoutTranscript(noteKo: string | null) {
    const cur = questions[indexRef.current];
    if (!cur) return;
    haltAsync();
    setPhase({ kind: "reveal", noteKo });
    play([{ text: cur.answerEn, lang: EN }]); // 탭 안
  }

  function replayAnswer() {
    const cur = questions[indexRef.current];
    if (cur) play([{ text: cur.answerEn, lang: EN }]);
  }

  /** 🗣️ 한 번 더 따라 말하기 — 정답을 한 번 더 들려주고 따라 말할 틈(무음 쉼). 녹음·전사 없음, 판정·제안을 바꾸지 않는다 */
  function shadowOnceMore() {
    const cur = questions[indexRef.current];
    if (cur) play([{ text: cur.answerEn, lang: EN, pauseAfterMs: shadowPauseMs(cur.answerEn) }], true);
  }

  function replayListen() {
    const cur = questions[indexRef.current];
    if (cur?.listenEn) play([{ text: cur.listenEn, lang: EN }]);
  }

  // ── 저장 ──
  const buildBody = useCallback(
    (finishedAt: string | null): ToeicTemplateSessionRequest => ({
      clientSessionId: sessionIdRef.current,
      mode,
      startedAt: startedAtRef.current,
      finishedAt,
      items: templateTestItems(keys, verdictsRef.current),
    }),
    [keys, mode],
  );

  async function save(completed: boolean) {
    if (savingRef.current || savedRef.current) return;
    if (!verdictsRef.current.some((v) => v !== null)) {
      setSaveState("idle");
      setSaveMsg("판정한 문항이 없어 저장하지 않았어요.");
      return;
    }
    if (finishedAtRef.current === undefined) finishedAtRef.current = completed ? new Date().toISOString() : null;
    savingRef.current = true;
    setSaveState("saving");
    setSaveMsg(null);
    try {
      const res = await fetch("/api/toeic/guides/templates/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody(finishedAtRef.current)),
      });
      const data = (await res.json().catch(() => null)) as ToeicTemplateSessionResponse | null;
      if (data?.ok) {
        savedRef.current = true;
        setSaveState("saved");
        setSaveMsg(data.reused ? "이미 저장된 결과예요." : "결과를 저장했어요.");
        try {
          window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
        } catch {
          /* noop */
        }
      } else {
        setSaveState("error");
        setSaveMsg(data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요.");
      }
    } catch {
      setSaveState("error");
      setSaveMsg("연결이 끊겨 결과를 저장하지 못했어요.");
    } finally {
      savingRef.current = false;
    }
  }

  function finish(completed: boolean) {
    haltAsync();
    keeperRef.current?.release(); // 테스트가 끝났다 — 마이크를 놓는다(트랙 stop → playback)
    stopSound();
    revokeMyRec(); // 내 녹음은 이 세션 동안만 — 끝나면 버린다(§12-12 14)
    setStage("done");
    void save(completed);
  }

  // ── 판정(탭) — 이 탭이 다음 문항을 연다 ──
  function judge(correct: boolean) {
    const ph = phaseRef.current;
    if (ph.kind !== "result" && ph.kind !== "reveal") return;
    const i = indexRef.current;
    const verdict: ToeicTemplateVerdict = { correct, suggest: ph.kind === "result" ? ph.check.suggest : null };
    const next = verdictsRef.current.map((v, j) => (j === i ? verdict : v));
    verdictsRef.current = next;
    setVerdicts(next);
    if (i + 1 >= total) finish(true);
    else openQuestion(i + 1);
  }

  // ── 녹음 중(마이크 준비 포함) 화면이 숨겨지면 그 녹음은 버리고 문항을 탭으로 다시 연다 ──
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "hidden") return;
      const k = phaseRef.current.kind;
      if (k === "arming" || k === "recording" || k === "stopping") {
        haltAsync();
        setPhase({ kind: "interrupted" });
      }
      keeperRef.current?.release(); // 숨김이면 단계와 무관하게 마이크를 놓는다 — 다음 🎤(탭)가 다시 연다(SPEC §20-4)
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [haltAsync, setPhase]);

  // ── 화면을 떠날 때: 판정한 문항을 keepalive로 저장(best-effort — 멱등 키라 두 번 가도 한 벌), 소리·녹음·요청 정리 ──
  // 진행 중이면 그만두기 모양(finishedAt null), 끝 화면 저장이 실패한 채 떠나면 그 판 본문 그대로 한 번 더(QA S2 P3-4) — templateTestLeaveSave
  const leaveSaveRef = useRef<() => void>(() => {});
  useEffect(() => {
    leaveSaveRef.current = () => {
      const plan = templateTestLeaveSave({
        stage: stageRef.current,
        saved: savedRef.current,
        saving: savingRef.current,
        answered: verdictsRef.current.filter((v) => v !== null).length,
        hasSessionId: sessionIdRef.current !== "",
        finishedAt: finishedAtRef.current,
      });
      if (plan === null) return;
      savedRef.current = true;
      try {
        void fetch("/api/toeic/guides/templates/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildBody(plan.finishedAt)),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* best-effort */
      }
    };
  }, [buildBody]);
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) leaveSaveRef.current(); // bfcache로 되살아날 수 있는 이탈이면 저장하지 않는다(이어서 풀 수 있다)
      keeperRef.current?.release(); // 어떤 이탈이든 마이크는 놓는다(bfcache로 돌아오면 다음 🎤가 다시 연다)
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
  useEffect(
    () => () => {
      leaveSaveRef.current();
      runRef.current += 1;
      if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
      recRef.current?.abort();
      recRef.current = null;
      keeperRef.current?.release(); // 화면을 떠났다 — 마이크를 놓는다
      abortRef.current?.abort();
      abortRef.current = null;
      const st = stopSoundRef.current;
      stopSoundRef.current = null;
      st?.();
      prefetchStopRef.current?.();
      if (myRecUrlRef.current) URL.revokeObjectURL(myRecUrlRef.current);
      myRecUrlRef.current = null;
    },
    [],
  );

  // ── 렌더 ──
  const costLabel = templateTestCostLabelKo(counts.perSession);
  const reviewCount = questions.filter((x) => x.review).length;

  if (stage === "intro") {
    return (
      <section className={s.intro} aria-label="틀 테스트 시작">
        <div className={s.modeSwitch} role="group" aria-label="테스트 방식">
          {(["tpl-recall", "tpl-swap"] as const).map((m) => (
            <Link key={m} href={modeHrefs[m]} replace aria-current={m === mode ? "true" : undefined} className={`${s.modeChip} ${m === mode ? s.modeOn : ""}`}>
              {TOEIC_TEMPLATE_TEST_MODE_TAG_KO[m]}
            </Link>
          ))}
        </div>
        <p className={s.introHint}>{TOEIC_TEMPLATE_TEST_MODE_HINT_KO[mode]}</p>
        <ul className={s.introFacts}>
          <li>
            범위 · <b>{scopeLabelKo}</b>
          </li>
          <li>
            문항 <b>{total}개</b> · 약한 틀 먼저{reviewCount > 0 ? ` · 익힌 틀 복습 ${reviewCount}개` : ""} · 답변 흐름 순서
          </li>
          <li>말한 뒤 받아쓰기로 틀 부분을 비교해 보여 주고, ○/✕는 직접 정해요. 판정은 정답을 보기 전 첫 시도로 해요.</li>
        </ul>
        <p className={s.cost}>{costLabel}</p>
        {micSupported === false && <p className={s.notice}>{TOEIC_TEMPLATE_SELF_REASON_KO.nomic}</p>}
        <ToeicMicKeepToggle
          onChange={() => {
            keeperRef.current?.release(); // 정책이 바뀌었다 — 다음 🎤부터 새 정책
            keeperRef.current = null;
          }}
        />
        <div className={s.introActions}>
          <button type="button" className={`u-btn u-btn-primary ${s.startBtn}`} onClick={() => start(false)}>
            ▶ 시작
          </button>
          <button type="button" className={s.textBtn} onClick={() => start(true)}>
            녹음 없이 하기(스스로 판정)
          </button>
        </div>
      </section>
    );
  }

  if (stage === "done") {
    const sum = templateTestSummary(keys, verdicts);
    const byKey = new Map(questions.map((x) => [x.key, x]));
    const busy = saveState === "saving";
    return (
      <section className={s.done} aria-label="틀 테스트 결과">
        <StreakFinishHint partial={sum.answered !== total} />
        <p className="t-caption">{sum.answered === total ? "테스트 끝!" : "여기까지 했어요"}</p>
        <p className={s.scoreBig}>
          ○ {sum.correct} <span className={s.scoreSlash}>/</span> {sum.answered}
        </p>
        <p className={s.doneLead}>{sum.answered > 0 ? `${TOEIC_TEMPLATE_TEST_MODE_TAG_KO[mode]} · ${sum.answered}문항 중 ${sum.correct}개 ○` : "판정한 문항이 없어요."}</p>
        {sum.suggested > 0 && (
          <p className={s.doneMeta}>
            제안과 다르게 판정한 문항 {sum.mismatched}개 <span className={s.doneMetaSub}>(받아쓰기 제안이 있던 {sum.suggested}문항 중)</span>
          </p>
        )}
        {saveState === "saving" ? (
          <p role="status" className={s.saveMsg}>
            결과를 저장하는 중이에요…
          </p>
        ) : saveMsg ? (
          <p role="status" className={`${s.saveMsg} ${saveState === "error" ? s.saveMsgError : ""}`}>
            {saveMsg}
            {saveState === "error" && (
              <button type="button" className={s.textBtn} onClick={() => void save(finishedAtRef.current !== null)}>
                다시 저장
              </button>
            )}
          </p>
        ) : null}

        {sum.wrongKeys.length > 0 && (
          <div className={s.wrongBox}>
            <p className={s.wrongTitle}>✕ 다시 연습할 틀 {sum.wrongKeys.length}개</p>
            <ol className={s.wrongList}>
              {sum.wrongKeys.map((k) => {
                const it = byKey.get(k);
                if (!it) return null;
                const tones = slotToneMap(frameSlotNames(it.frameEn));
                return (
                  <li key={k}>
                    <Link href={toeicTemplateTabHref(part, { tpl: k })} className={s.wrongItem}>
                      <span className={s.wrongFrame} lang="en">
                        <FrameLine frame={it.frameEn} tones={tones} lang="en" />
                      </span>
                      <span className={s.wrongGroup}>{it.groupKo} · 카드로 →</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div className={s.doneActions}>
          {sum.wrongKeys.length > 0 && (
            <>
              <Link href={toeicTemplateTabHref(part, { range: "wrong" })} className={`u-btn u-btn-primary ${busy ? s.linkBusy : ""}`} aria-disabled={busy}>
                ▶ 틀린 틀만 따라 말하기
              </Link>
              <Link href={`${wrongRetryHref}&t=${Date.now()}`} className={`u-btn u-btn-secondary ${busy ? s.linkBusy : ""}`} aria-disabled={busy}>
                🧩 틀린 틀만 다시 테스트
              </Link>
            </>
          )}
          <Link href={`${retryHref}&t=${Date.now()}`} className="u-btn u-btn-secondary">
            🔁 다시 테스트
          </Link>
          <Link href={backHref} className="u-btn u-btn-secondary">
            🧩 템플릿 훈련으로
          </Link>
        </div>
      </section>
    );
  }

  // ── 진행 ──
  if (!q) return null;
  const tones = slotToneMap(frameSlotNames(q.frameEn));
  const meta = templateTestPromptMeta(q); // 묶음·쓰임 한 줄 — 라틴은 "…"로(두 모드 모두 — 틀과 영어는 가린다)
  const canMic = selfReason === null && canTranscribeAgain(counts);
  const effectiveSelf: ToeicTemplateSelfReason | null = selfReason ?? (canTranscribeAgain({ perQuestion: 0, perSession: counts.perSession }) ? null : "cap");
  const answered = phase.kind === "result" || phase.kind === "reveal";
  const progress = total > 0 ? ((index + (answered ? 1 : 0)) / total) * 100 : 0;

  return (
    <section className={s.run} aria-label="틀 테스트">
      <div className={s.topRow}>
        <span className={s.modeTag}>{TOEIC_TEMPLATE_TEST_MODE_TAG_KO[mode]}</span>
        <span className={s.counter} aria-live="polite">
          {index + 1} / {total}
        </span>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>
      <p className={s.cost}>{costLabel}</p>
      {effectiveSelf !== null && <p className={s.notice}>{TOEIC_TEMPLATE_SELF_REASON_KO[effectiveSelf]}</p>}
      {micNotice && selfReason === "nomic" && <p className={s.noticeSub}>{micNotice}</p>}

      {/* 문제 — (가) 한국어 뜻 / (나) 한국어 틀 + 영어 채움 칩(영어 틀·예문 글은 보이지 않는다) */}
      <div className={`${s.prompt} ${answered ? s.promptDone : ""}`}>
        <p className={s.promptMeta}>
          {q.review && <span className={s.reviewChip}>복습</span>}
          {meta.groupKo !== null && <span>{meta.groupKo}</span>}
          {meta.useKo !== null && (
            <span className={s.promptUse}>
              {meta.groupKo !== null ? " · " : ""}
              {meta.useKo}
            </span>
          )}
        </p>
        {mode === "tpl-recall" ? (
          <p className={s.promptKo}>{q.answerKo}</p>
        ) : (
          <>
            <p className={s.promptKo}>
              {templateSwapClue(q.frameKo, q.frameEn, q.answerFills).map((g, i) =>
                g.slot === null ? (
                  <span key={i}>{g.text}</span>
                ) : (
                  <span key={i} className={`${slotChipClass(g.slot)} ${s.clueFill}`} lang="en" aria-label={g.name ? `${g.name}: ${g.text}` : undefined}>
                    {g.text}
                  </span>
                ),
              )}
            </p>
            <div className={s.listenRow}>
              <button type="button" className={s.listenBtn} onClick={replayListen}>
                🔊 예문 다시 듣기
              </button>
              <span className={s.listenHint}>같은 틀에 이 채움을 넣어 말해 보세요.</span>
            </div>
          </>
        )}
      </div>

      {/* 한 걸음 */}
      <div className={s.step} aria-live="polite">
        {phase.kind === "ask" &&
          (canMic ? (
            <div className={s.stepCol}>
              <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={onMic}>
                🎤 말하기
              </button>
              <button type="button" className={s.textBtn} onClick={() => revealWithoutTranscript(null)}>
                받아쓰기 없이 판정
              </button>
            </div>
          ) : (
            <div className={s.stepCol}>
              <p className={s.stepHint}>🎙️ 소리 내어 영어로 말해 본 뒤 정답을 확인하세요.</p>
              <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={() => revealWithoutTranscript(null)}>
                정답 보기 🔊
              </button>
            </div>
          ))}

        {phase.kind === "arming" && <p className={s.stepHint}>마이크를 여는 중이에요…</p>}

        {phase.kind === "recording" && (
          <div className={s.stepCol}>
            <p className={s.recNow}>
              <span className={s.recDot} aria-hidden /> 듣고 있어요 · {Math.floor(elapsed / 1000)}초 / {Math.round(TOEIC_TEMPLATE_REC_MAX_MS / 1000)}초
            </p>
            <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={() => finishRecording(runRef.current)}>
              ✋ 다 말했어요
            </button>
          </div>
        )}

        {phase.kind === "stopping" && <p className={s.stepHint}>녹음을 마무리하는 중이에요…</p>}

        {phase.kind === "transcribing" && (
          <div className={s.stepCol}>
            <p className={s.stepHint}>받아쓰는 중이에요…</p>
            <button type="button" className={s.textBtn} onClick={() => revealWithoutTranscript(null)}>
              기다리지 않고 판정하기
            </button>
          </div>
        )}

        {phase.kind === "invalid" && (
          <div className={s.stepCol}>
            <p className={s.invalidMsg}>🙉 {phase.reasonKo}</p>
            {canTranscribeAgain(counts) && selfReason === null ? (
              <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={onMic}>
                🎤 다시 말하기
              </button>
            ) : (
              <p className={s.stepHint}>이 문항은 받아쓰기를 더 쓸 수 없어요.</p>
            )}
            <button type="button" className={s.textBtn} onClick={() => revealWithoutTranscript(null)}>
              받아쓰기 없이 판정
            </button>
          </div>
        )}

        {phase.kind === "interrupted" && (
          <div className={s.stepCol}>
            <p className={s.invalidMsg}>화면이 꺼지거나 다른 앱으로 넘어가 녹음을 멈췄어요.</p>
            <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={() => openQuestion(indexRef.current, true)}>
              ↻ 이 문항 다시
            </button>
          </div>
        )}

        {(phase.kind === "result" || phase.kind === "reveal") && (
          <div ref={answerRef} className={s.answerBox}>
            <div className={s.answerHead}>
              <span className={s.answerLabel}>정답</span>
              <button type="button" className={s.speak} onClick={replayAnswer} aria-label="정답 듣기">
                🔊
              </button>
            </div>
            <p className={s.answerEn} lang="en">
              <ExampleLine frameEn={q.frameEn} fills={q.answerFills} boldFixed />
            </p>
            {mode === "tpl-swap" && q.answerKo === null && (
              <p className={s.answerFrameKo}>
                <FrameLine frame={q.frameKo} tones={tones} lang="ko" />
              </p>
            )}
            {phase.kind === "reveal" && phase.noteKo && <p className={s.noticeSub}>{phase.noteKo}</p>}

            {phase.kind === "result" && (
              <>
                <div className={s.heardBox}>
                  <span className={s.answerLabel}>내가 한 말</span>
                  <p className={s.heard} lang="en">
                    &ldquo;{phase.transcript}&rdquo;
                  </p>
                </div>
                <p className={`${s.suggest} ${phase.check.suggest === "pass" ? s.suggestPass : s.suggestFail}`}>
                  제안 · {phase.check.suggest === "pass" ? "틀 맞음 ○" : "틀 다름 ✕"}
                  <span className={s.suggestWhy}> — {suggestWhyKo(phase.check)}</span>
                </p>
                {phase.viaFrameEn && (
                  <p className={s.viaAlt}>
                    같은 뜻의 다른 교재 틀로 말했어요 —{" "}
                    <span lang="en">
                      <FrameLine frame={phase.viaFrameEn} tones={slotToneMap(frameSlotNames(phase.viaFrameEn))} lang="en" />
                    </span>
                  </p>
                )}
              </>
            )}

            {/* 판정 — 제안 바로 아래(한 문항 15~20초 — 스크롤 없이 누르게). 이 탭이 다음 문항을 연다 */}
            <p className={s.judgeAsk}>틀을 제대로 꺼냈나요? 직접 정해요.</p>
            <div className={s.judgeRow}>
              <button type="button" className={`u-btn ${s.judgeBtn} ${s.judgeOk}`} onClick={() => judge(true)}>
                ○ 맞았어요
              </button>
              <button type="button" className={`u-btn ${s.judgeBtn} ${s.judgeNo}`} onClick={() => judge(false)}>
                ✕ 다시 연습
              </button>
            </div>

            {phase.kind === "result" && <CompareChips check={phase.check} />}
            {phase.kind === "result" && myRecUrl && (
              <div className={s.heardBox}>
                <span className={s.answerLabel}>내 녹음(이 기기에만 — 테스트가 끝나면 지워져요)</span>
                <audio className={s.myRec} controls preload="none" src={myRecUrl}>
                  내 녹음
                </audio>
              </div>
            )}
            <div className={s.shadowRow}>
              <button type="button" className={s.shadowBtn} onClick={shadowOnceMore}>
                🗣️ 한 번 더 따라 말하기
              </button>
              {cue && <span className={s.cue}>🗣️ 따라 말해 보세요</span>}
            </div>
          </div>
        )}
      </div>

      <div className={s.footer}>
        <button type="button" className="u-btn u-btn-secondary" onClick={() => finish(false)}>
          그만두기
        </button>
      </div>
    </section>
  );
}

/** 제안의 이유 한 줄(틀 낱말 맞은 수 · 자리) */
function suggestWhyKo(check: TemplateAnswerCheck): string {
  if (check.noSpeech) return "들은 낱말이 없어요";
  const ok = check.words.filter((w) => w.role === "fixed" && w.status === "ok").length;
  const emptySlots = check.slots.filter((x) => !x.filled).length;
  const frame = `틀 낱말 ${ok}/${check.fixedTotal}`;
  return emptySlots > 0 ? `${frame} · 빈 자리 ${emptySlots}` : `${frame} · 자리 채움`;
}

/** 비교 칩(§12-5-5 화면 표시) — 정규화된 낱말: 고정 낱말은 맞음/빠짐/다름, 자리 낱말은 자리 색, 더한 말은 회색. 원문에 되짚어 칠하지 않는다 */
function CompareChips({ check }: { check: TemplateAnswerCheck }) {
  return (
    <div className={s.compare}>
      <span className={s.answerLabel}>비교</span>
      <p className={s.chips} lang="en">
        {check.words.map((w, i) =>
          w.role === "fixed" ? (
            <span
              key={i}
              className={`${s.chip} ${w.status === "ok" ? s.chipOk : w.status === "missing" ? s.chipMissing : s.chipWrong}`}
              title={w.status === "ok" ? "맞음" : w.status === "missing" ? "빠짐" : "다름"}
            >
              {w.status === "wrong" && w.heard ? (
                <>
                  <del>{w.word}</del> {w.heard}
                </>
              ) : (
                w.word
              )}
              <span className={s.srOnly}>{w.status === "ok" ? " 맞음" : w.status === "missing" ? " 빠짐" : " 다름"}</span>
            </span>
          ) : (
            <span
              key={i}
              className={`${slotChipClass(w.slot ?? 0)} ${s.chipSlot} ${w.status === "ok" ? "" : s.chipSlotOther}`}
              title={w.status === "ok" ? "자리 낱말 — 그대로 들림" : "자리 낱말 — 다른 말로 채움(참고)"}
            >
              {w.word}
            </span>
          ),
        )}
      </p>
      {check.extra.length > 0 && (
        <p className={s.extra} lang="en">
          <span className={s.extraLabel}>더한 말</span> {check.extra.join(" ")}
        </p>
      )}
      <p className={s.legend}>
        <span className={`${s.chip} ${s.chipOk}`}>맞음</span> <span className={`${s.chip} ${s.chipMissing}`}>빠짐</span>{" "}
        <span className={`${s.chip} ${s.chipWrong}`}>다름</span> <span className={s.legendNote}>색 칩은 자리(채운 말 — 너그럽게 봐요)</span>
      </p>
    </div>
  );
}

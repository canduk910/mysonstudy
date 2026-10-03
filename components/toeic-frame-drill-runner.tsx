"use client";

/**
 * 🗣️ 틀 말하기 진행 화면 (docs/harness/toeic.md §20-1·§20-7, SPEC §20-17) — 클라이언트 컴포넌트.
 *
 * 문항은 서버(`app/toeic/guides/[part]/frame-drill/take/page.tsx`)가 출제해 넘긴다(고정 — hydration 안전). 여기선 진행·녹음·말 끝 판정·
 * 받아쓰기·저장만 한다. 판단은 순수 함수(lib/toeic-frame-drill — 말 끝 상태 기계 stepFrameDrillVoice, lib/toeic-frame-drill-view —
 * 보낼지 frameDrillShouldSend·결과 frameDrillItemResult).
 *
 * ── 흐름 ─────────────────────────────────────────────────────────────────────
 * - **시작 탭**: AudioContext 생성/resume(레벨 미터 — 응시 화면 싱글턴 lib/toeic-audio-cue)·unlockSpeechPlayback·오디오 세션 playback·
 *   멱등 id·startedAt, 그리고 **같은 탭 안에서** 첫 문항 녹음을 연다(권한 창이 탭 안에 — 첫 녹음만 권한 대기 15초).
 * - 문항: 한국어 문장만 크게(영어·틀·소리 없음 — 스피커 소리가 마이크로 들어가 말 끝 판정·전사를 흐리지 않게). 녹음 레벨 표본(90ms)을
 *   stepFrameDrillVoice에 넣어 말 끝(무음 1.5초)·상한(20초)·무응답(10초)을 판정한다. "다 말했어요" 탭으로도 끝난다.
 * - 끝나면 **바로** 모범 영어(크게) + 내 문장(작게 — 전사가 오면 채운다, 그동안 "듣는 중…")을 보이고 4초 뒤 자동 다음, 화면을 탭하면 바로
 *   다음(토큰으로 4초 타이머와 탭이 겹쳐도 한 문항만 넘어간다). 받아쓰기는 기다리지 않는다 — 다음 문항과 **병렬로** 돈다.
 * - 받아쓰기: 녹음 → WAV 16kHz mono(1 MiB 안, 실패하면 원본) → `POST /api/toeic/guides/templates/transcribe`(관문 T — 기대 문장 없음,
 *   저장 없음), 문항당 45초 상한. 무응답(믿을 만한 레벨로 말 시작이 없었다)은 보내지 않는다(비용 0). 501(키 없음)이면 그 뒤 문항은
 *   녹음 없이(정답 보기) — 그 문항들은 "인식 실패"(판정·통계 밖).
 * - 끝(문항 수만큼) 또는 그만두기(모범 영어까지 본 문항만) → 남은 받아쓰기를 기다려 한 판을 저장(`POST /api/toeic/frame-drill/sessions` —
 *   멱등 id, 실패하면 "다시 저장") → 스트릭 갱신 신호 → 결과 화면으로(거기서 판정·보충).
 * - 녹음 없이(마이크 거부·미지원·키 없음·"녹음 없이 하기"): 한국어 → "정답 보기" 탭 → 모범 영어. 녹음한 문항이 하나도 없으면 저장하지 않는다
 *   (판정할 답이 없다 — 통계를 더럽히지 않는다).
 * - 녹음 중(준비 포함) 화면이 숨겨지면 그 녹음은 버리고 그 문항을 "이 문항 다시" 탭으로 다시 연다. 숨김·pagehide·언마운트에 마이크를 놓는다.
 * - 진행 중에는 표현 도우미를 막는다(usePhraseHelperBlock — 경로로도 막힌다, 두 겹).
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
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
import { unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { isAcceptedToeicAudioType, toeicAudioBaseType, toeicAudioFileName } from "@/lib/toeic-attempt-contract";
import { ensureToeicAudio, getToeicAudioContext, resumeToeicAudio } from "@/lib/toeic-audio-cue";
import {
  TOEIC_FRAME_DRILL_REVEAL_MS,
  TOEIC_FRAME_DRILL_START_WAIT_MS,
  initialFrameDrillVoice,
  stepFrameDrillVoice,
  type ToeicFrameDrillOutcome,
  type ToeicFrameDrillPart,
  type ToeicFrameDrillVoiceEnd,
  type ToeicFrameDrillVoiceState,
} from "@/lib/toeic-frame-drill";
import {
  TOEIC_FRAME_DRILL_MIC_OWNER,
  toeicFrameDrillResultHref,
  type ToeicFrameDrillSelection,
  type ToeicFrameDrillSessionRequest,
  type ToeicFrameDrillSessionResponse,
} from "@/lib/toeic-frame-drill-contract";
import { TOEIC_FRAME_DRILL_REC_HARD_STOP_MS, frameDrillItemResult, frameDrillShouldSend } from "@/lib/toeic-frame-drill-view";
import { TOEIC_TEMPLATE_AUDIO_MAX_BYTES, TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO, type ToeicTemplateTranscribeResponse } from "@/lib/toeic-guide-contract";
import { TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS } from "@/lib/toeic-template";
import { newTemplateSessionId } from "@/lib/toeic-template-test-view";
import s from "./toeic-frame-drill.module.css";

/** 서버가 넘기는 문항 하나(출제 때 글자 그대로) */
export interface ToeicFrameDrillRunItem {
  itemId: string;
  frameKey: string;
  ko: string;
  en: string;
  /** `~` 형태 틀 */
  frame: string;
}

type Stage = "intro" | "run" | "finishing" | "saving" | "save_error" | "unsaved";

type Phase =
  | { kind: "arming" }
  | { kind: "listening"; speaking: boolean }
  | { kind: "reveal" }
  | { kind: "interrupted" }
  | { kind: "nomic" };

/** 문항 결과(화면 표시 + 저장) — pending = 받아쓰기 중 */
interface ItemResult {
  state: "pending" | "done";
  outcome: ToeicFrameDrillOutcome;
  transcript: string | null;
  /** 녹음 없이 넘어간 문항(정답 보기) */
  noRec: boolean;
}

/** 레벨 표본 간격(응시 화면 레벨 미터 관례) */
const LEVEL_MS = 90;

export default function ToeicFrameDrillRunner({
  part,
  selection,
  items,
  shortBy,
  topicNamesKo,
  backHref,
  retryHref,
}: {
  part: ToeicFrameDrillPart;
  selection: ToeicFrameDrillSelection;
  items: ToeicFrameDrillRunItem[];
  shortBy: number;
  topicNamesKo: string[];
  backHref: string;
  retryHref: string;
}) {
  usePhraseHelperBlock(); // 진행 중에는 표현 도우미를 띄우지 않는다(SPEC §22-3)
  const router = useRouter();
  const total = items.length;

  const [stage, setStageState] = useState<Stage>("intro");
  const stageRef = useRef<Stage>("intro");
  const setStage = useCallback((v: Stage) => {
    stageRef.current = v;
    setStageState(v);
  }, []);
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const [phase, setPhaseState] = useState<Phase>({ kind: "arming" });
  const phaseRef = useRef<Phase>({ kind: "arming" });
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [results, setResultsState] = useState<(ItemResult | null)[]>(() => items.map(() => null));
  const resultsRef = useRef<(ItemResult | null)[]>(items.map(() => null));
  const setResult = useCallback((i: number, r: ItemResult) => {
    const next = resultsRef.current.slice();
    next[i] = r;
    resultsRef.current = next;
    setResultsState(next);
  }, []);
  const [level, setLevel] = useState(0);
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const [micSupported, setMicSupported] = useState<boolean | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  /** 저장하지 않은 까닭 — none: 모범 영어까지 본 문항 0 · norec: 녹음한 문항 0(QA P3-C) */
  const [unsavedWhy, setUnsavedWhy] = useState<"none" | "norec">("none");

  const runRef = useRef(0); // 문항 안 비동기 콜백 무효화 토큰(녹음·말 끝·4초 넘김)
  const recRef = useRef<MicRecording | null>(null);
  const voiceRef = useRef<ToeicFrameDrillVoiceState | null>(null);
  const sawUnreliableRef = useRef(false);
  const hardStopRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const keeperRef = useRef<MicKeeper | null>(null);
  const firstMicRef = useRef(true);
  const noMicRef = useRef(false);
  const pendingRef = useRef(new Map<number, Promise<void>>());
  const abortsRef = useRef(new Set<AbortController>());
  const sessionIdRef = useRef("");
  const startedAtRef = useRef("");
  const endedRef = useRef<"done" | "quit">("done");
  const unmountedRef = useRef(false);

  const micKeeper = (): MicKeeper => {
    if (!keeperRef.current) keeperRef.current = createMicKeeper();
    return keeperRef.current;
  };

  useToeicWakeLock(stage === "run", resumeToeicAudio);

  useEffect(() => {
    setMicSupported(detectMicSupport().ok);
  }, []);

  const clearTimers = useCallback(() => {
    if (hardStopRef.current !== null) window.clearTimeout(hardStopRef.current);
    hardStopRef.current = null;
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = null;
  }, []);

  /** 문항 안 비동기(녹음·타이머)를 끊는다 — 늦게 온 콜백은 토큰으로 무시. 받아쓰기(이미 끝난 문항)는 끊지 않는다 */
  const haltItem = useCallback(() => {
    runRef.current += 1;
    clearTimers();
    recRef.current?.abort();
    recRef.current = null;
    voiceRef.current = null;
  }, [clearTimers]);

  // ── 받아쓰기(관문 T — 녹음만 보낸다, 정답은 보내지 않는다) — 다음 문항과 병렬. 일감 등록은 endItem이 stop을 부르는 그 자리에서(QA P2-A) ──
  const transcribe = useCallback(
    (i: number, rec: RecordingResult): Promise<void> => {
      return (async () => {
        let upload: Blob = rec.blob;
        try {
          const wav = await toWav16kMono(rec.blob);
          if (wav.blob.size <= TOEIC_TEMPLATE_AUDIO_MAX_BYTES) upload = wav.blob;
        } catch {
          /* 원본으로 */
        }
        const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(rec.mimeType);
        if (upload.size > TOEIC_TEMPLATE_AUDIO_MAX_BYTES || !isAcceptedToeicAudioType(type)) {
          setResult(i, { state: "done", ...frameDrillItemResult({ sent: true, ok: false }), noRec: false });
          return;
        }
        const fd = new FormData();
        fd.append(TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO, upload.type ? upload : new Blob([upload], { type }), toeicAudioFileName(type) ?? "answer.webm");
        const ac = new AbortController();
        abortsRef.current.add(ac);
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
          abortsRef.current.delete(ac);
        }
        if (unmountedRef.current) return;
        if (data?.ok) {
          setResult(i, { state: "done", ...frameDrillItemResult({ sent: true, ok: true, text: data.text }), noRec: false });
          return;
        }
        if (status === 501 || (data && !data.ok && data.error === "no_api_key")) {
          // 키가 없다 — 그 뒤 문항은 녹음 없이(받아쓰기를 더 보내 봐야 쓸 곳이 없다). 쥔 마이크도 놓는다(QA P3-B — keep 정책)
          noMicRef.current = true;
          keeperRef.current?.release();
          setMicNotice("API 키가 없어 받아쓰기를 할 수 없어요 — 남은 문항은 녹음 없이 정답만 볼게요.");
        }
        setResult(i, { state: "done", ...frameDrillItemResult({ sent: true, ok: false }), noRec: false });
      })();
    },
    [setResult],
  );

  /** 문항 일감(녹음 멈춤 → 보낼지 → 받아쓰기)을 **동기로** 등록한다 — finish가 반드시 기다린다(QA P2-A: stop이 풀리기 전에 넘겨도 답을 잃지 않게) */
  const track = useCallback((i: number, job: Promise<void>) => {
    pendingRef.current.set(i, job);
    setPendingCount(pendingRef.current.size);
    void job.finally(() => {
      pendingRef.current.delete(i);
      if (!unmountedRef.current) setPendingCount(pendingRef.current.size);
    });
  }, []);

  // ── 다음 문항 / 끝 ──
  const finishRef = useRef<(ended: "done" | "quit") => void>(() => {});
  const openRef = useRef<(i: number, fromTap: boolean) => void>(() => {});

  const goNext = useCallback(
    (token: number) => {
      if (runRef.current !== token || phaseRef.current.kind !== "reveal") return;
      const i = indexRef.current;
      if (i + 1 >= total) finishRef.current("done");
      else openRef.current(i + 1, false);
    },
    [total],
  );

  const reveal = useCallback(
    (i: number) => {
      const token = runRef.current;
      setPhase({ kind: "reveal" });
      if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = window.setTimeout(() => goNext(token), TOEIC_FRAME_DRILL_REVEAL_MS);
      void i;
    },
    [goNext, setPhase],
  );

  // ── 말 끝(상태 기계·"다 말했어요"·상한 타이머) → 녹음 멈춤 → 바로 모범 영어 ──
  const endItem = useCallback(
    (token: number, end: ToeicFrameDrillVoiceEnd | "manual") => {
      if (runRef.current !== token || phaseRef.current.kind !== "listening") return;
      const i = indexRef.current;
      clearTimers();
      const rec = recRef.current;
      recRef.current = null;
      voiceRef.current = null;
      const sawUnreliable = sawUnreliableRef.current;
      setResult(i, { state: "pending", outcome: "no_speech", transcript: null, noRec: false });
      reveal(i);
      if (!rec) {
        setResult(i, { state: "done", outcome: "no_speech", transcript: null, noRec: false });
        return;
      }
      track(
        i,
        (async () => {
          const result = await rec.stop().catch(() => null);
          setAudioSessionPlayback(); // 트랙 stop 뒤(모듈이 이미 했어도 무해)
          if (unmountedRef.current) return;
          if (!result || !frameDrillShouldSend({ end, sawUnreliable, durationMs: result.durationMs })) {
            setResult(i, { state: "done", ...frameDrillItemResult({ sent: false }), noRec: false });
            return;
          }
          // 진행·마무리(finish가 이 일감을 기다리는 중)일 때만 보낸다 — 저장이 시작된 뒤에는 쓸 곳이 없다(유료 호출 0)
          if (stageRef.current !== "run" && stageRef.current !== "finishing") return;
          await transcribe(i, result);
        })(),
      );
    },
    [clearTimers, reveal, setResult, transcribe, track],
  );

  const openItem = useCallback(
    (i: number, fromTap: boolean) => {
      haltItem();
      indexRef.current = i;
      setIndexState(i);
      setLevel(0);
      if (noMicRef.current) {
        keeperRef.current?.release(); // 녹음 없이 — 마이크를 쥘 이유가 없다(QA P3-B)
        setPhase({ kind: "nomic" });
        return;
      }
      if (!fromTap && typeof document !== "undefined" && document.visibilityState === "hidden") {
        setPhase({ kind: "interrupted" }); // 숨긴 채 녹음을 열지 않는다 — 돌아와서 탭으로
        return;
      }
      const token = runRef.current;
      setPhase({ kind: "arming" });
      const keeper = micKeeper();
      const needsPrompt = firstMicRef.current || (keeper.policy === "keep" && !keeper.holding());
      const micFail = (e: unknown) => {
        if (runRef.current !== token) return;
        recRef.current?.abort();
        recRef.current = null;
        keeperRef.current?.release();
        clearTimers();
        const msg = e instanceof MicError ? e.message : e instanceof Error ? e.message : "녹음을 시작하지 못했어요.";
        setMicNotice(`${msg} — 녹음 없이 이어 가요(정답 보기).`);
        noMicRef.current = true;
        setPhase({ kind: "nomic" });
      };
      keeper
        .startRecording({ audioContext: getToeicAudioContext(), owner: TOEIC_FRAME_DRILL_MIC_OWNER, ...(needsPrompt ? { gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS } : {}) })
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
              voiceRef.current = initialFrameDrillVoice(t);
              sawUnreliableRef.current = false;
              setPhase({ kind: "listening", speaking: false });
              hardStopRef.current = window.setTimeout(() => endItem(token, "max"), TOEIC_FRAME_DRILL_REC_HARD_STOP_MS);
            },
            (e: unknown) => micFail(e),
          );
        })
        .catch((e: unknown) => micFail(e));
    },
    // micKeeper는 ref 접근만 — 의존성 없음
    [haltItem, setPhase, clearTimers, endItem],
  );
  openRef.current = openItem;

  // ── 레벨 표본 → 말 끝 상태 기계(90ms) ──
  useEffect(() => {
    if (phase.kind !== "listening") return;
    const token = runRef.current;
    const id = window.setInterval(() => {
      const rec = recRef.current;
      const st = voiceRef.current;
      if (!rec || !st || runRef.current !== token) return;
      const lv = rec.level();
      const reliable = rec.levelReliable();
      if (!reliable) sawUnreliableRef.current = true;
      setLevel(lv);
      const next = stepFrameDrillVoice(st, { at: Date.now(), level: lv, reliable });
      voiceRef.current = next;
      if (next.speechAt !== null && phaseRef.current.kind === "listening" && !phaseRef.current.speaking) setPhase({ kind: "listening", speaking: true });
      if (next.ended !== null) endItem(token, next.ended);
    }, LEVEL_MS);
    return () => window.clearInterval(id);
  }, [phase.kind, endItem, setPhase]);

  // ── 끝·그만두기 → 남은 받아쓰기 → 저장 → 결과 화면 ──
  const saveSession = useCallback(async () => {
    const done = resultsRef.current.map((r, i) => ({ r, it: items[i] })).filter((x): x is { r: ItemResult; it: ToeicFrameDrillRunItem } => x.r !== null);
    if (done.length === 0 || done.every((x) => x.r.noRec)) {
      setUnsavedWhy(done.length === 0 ? "none" : "norec");
      setStage("unsaved");
      return;
    }
    setStage("saving");
    setSaveMsg(null);
    const body: ToeicFrameDrillSessionRequest = {
      clientSessionId: sessionIdRef.current,
      part,
      topicKeys: selection.topicKeys,
      questionTypeKeys: selection.questionTypeKeys,
      excludedFrameKeys: selection.excludedFrameKeys,
      requested: selection.count,
      startedAt: startedAtRef.current,
      finishedAt: new Date().toISOString(),
      ended: endedRef.current,
      items: done.map(({ r, it }) => ({
        itemId: it.itemId,
        frameKey: it.frameKey,
        ko: it.ko,
        en: it.en,
        frame: it.frame,
        outcome: r.noRec ? "transcribe_failed" : r.state === "pending" ? "transcribe_failed" : r.outcome,
        transcript: r.state === "done" ? r.transcript : null,
      })),
    };
    try {
      const res = await fetch("/api/toeic/frame-drill/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as ToeicFrameDrillSessionResponse | null;
      if (data?.ok) {
        try {
          window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
        } catch {
          /* noop */
        }
        router.replace(toeicFrameDrillResultHref(part, data.id));
        return;
      }
      setSaveMsg(data && !data.ok ? data.messageKo : "연습 기록을 저장하지 못했어요.");
      setStage("save_error");
    } catch {
      setSaveMsg("연결이 끊겨 연습 기록을 저장하지 못했어요.");
      setStage("save_error");
    }
  }, [items, part, router, selection, setStage]);

  const finish = useCallback(
    (ended: "done" | "quit") => {
      if (stageRef.current !== "run") return;
      endedRef.current = ended;
      haltItem();
      keeperRef.current?.release(); // 연습이 끝났다 — 마이크를 놓는다
      setStage("finishing");
      void Promise.allSettled([...pendingRef.current.values()]).then(() => {
        if (unmountedRef.current) return;
        void saveSession();
      });
    },
    [haltItem, saveSession, setStage],
  );
  finishRef.current = finish;

  // ── 시작 탭 ──
  function start(withoutMic: boolean) {
    if (stageRef.current !== "intro" || total === 0) return;
    ensureToeicAudio(); // 탭 안에서 동기로 — 레벨 미터 컨텍스트(응시 화면 싱글턴)
    unlockSpeechPlayback();
    setAudioSessionPlayback();
    sessionIdRef.current = newTemplateSessionId();
    startedAtRef.current = new Date().toISOString();
    if (withoutMic || micSupported === false || !detectMicSupport().ok) noMicRef.current = true;
    setStage("run");
    openItem(0, true); // 같은 탭 안에서 첫 녹음(권한 창)
  }

  /** 화면 탭 — 모범 영어를 보는 중이면 바로 다음, 녹음 없이면 정답 보기 */
  function onStageTap() {
    const ph = phaseRef.current.kind;
    if (ph === "reveal") goNext(runRef.current);
  }

  function showAnswerNoMic() {
    if (phaseRef.current.kind !== "nomic") return;
    const i = indexRef.current;
    setResult(i, { state: "done", outcome: "transcribe_failed", transcript: null, noRec: true });
    reveal(i);
  }

  // ── 숨김: 녹음 중(준비 포함)이면 버리고 탭으로 다시, 마이크는 놓는다 ──
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        resumeToeicAudio();
        return;
      }
      const k = phaseRef.current.kind;
      if (stageRef.current === "run" && (k === "arming" || k === "listening")) {
        haltItem();
        setPhase({ kind: "interrupted" });
      }
      keeperRef.current?.release();
    };
    document.addEventListener("visibilitychange", onVis);
    const onPageHide = () => keeperRef.current?.release();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [haltItem, setPhase]);

  // ── 언마운트: 녹음·타이머·받아쓰기·마이크 정리 ──
  useEffect(() => {
    unmountedRef.current = false;
    const aborts = abortsRef.current;
    return () => {
      unmountedRef.current = true;
      runRef.current += 1;
      if (hardStopRef.current !== null) window.clearTimeout(hardStopRef.current);
      if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
      recRef.current?.abort();
      recRef.current = null;
      keeperRef.current?.release();
      for (const ac of aborts) ac.abort();
      aborts.clear();
    };
  }, []);

  // ── 렌더 ──
  const item = items[index] ?? null;
  const res = results[index] ?? null;

  if (stage === "intro") {
    return (
      <section className={s.wrap} aria-label="틀 말하기 시작">
        <div className={s.box}>
          <p className={s.lead}>
            범위 · <b>{topicNamesKo.length > 0 ? topicNamesKo.join(" · ") : "고른 소재"}</b>
          </p>
          <p className={s.lead}>
            문항 <b>{total}개</b>
            {shortBy > 0 ? ` — 범위에 문항이 ${total}개뿐이라 ${total}문항으로 시작해요` : ""}
          </p>
          <ul className={s.bullets}>
            <li>한국어 문장이 뜨면 외운 틀로 바로 영어로 말해요. 소리는 나오지 않아요.</li>
            <li>말하고 1.5초 조용하면 끝난 걸로 알아채요(“다 말했어요”를 눌러도 돼요). 10초 동안 말이 없으면 넘어가요.</li>
            <li>모범 영어가 4초 보이고 다음 문장으로 — 화면을 누르면 바로 넘어가요.</li>
          </ul>
          {micSupported === false && <p className={s.notice}>이 브라우저는 녹음을 지원하지 않아요 — 녹음 없이 정답만 보며 연습해요(기록·판정은 남지 않아요).</p>}
          <div className={s.actions}>
            <button type="button" className="u-btn u-btn-primary" onClick={() => start(false)}>
              ▶ 시작
            </button>
            <button type="button" className={s.textBtn} onClick={() => start(true)}>
              녹음 없이 하기(기록 안 남음)
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (stage === "finishing" || stage === "saving") {
    return (
      <section className={s.stage} aria-live="polite">
        <p className={s.status}>{stage === "finishing" && pendingCount > 0 ? `받아쓰기를 마무리하는 중… (${pendingCount}개 남음)` : "기록을 저장하는 중…"}</p>
      </section>
    );
  }

  if (stage === "save_error") {
    return (
      <section className={s.stage}>
        <p className={s.status}>{saveMsg}</p>
        <div className={s.actions}>
          <button type="button" className="u-btn u-btn-primary" onClick={() => void saveSession()}>
            다시 저장
          </button>
          <Link href={backHref} className={s.textBtn}>
            저장하지 않고 나가기
          </Link>
        </div>
      </section>
    );
  }

  if (stage === "unsaved") {
    return (
      <section className={s.stage}>
        <p className={s.status}>
          {unsavedWhy === "norec" ? "녹음 없이 연습해서 기록·판정은 남기지 않았어요." : "모범 영어까지 본 문항이 없어 기록을 남기지 않았어요."}
        </p>
        <div className={s.actions}>
          <Link href={retryHref + `&t=${Date.now()}`} className="u-btn u-btn-primary">
            한 판 더
          </Link>
          <Link href={backHref} className="u-btn u-btn-secondary">
            ← 틀 말하기
          </Link>
        </div>
      </section>
    );
  }

  // stage === "run"
  const mineText =
    res === null || res.state === "pending"
      ? "듣는 중…"
      : res.noRec
        ? "(녹음 없이)"
        : res.outcome === "transcribe_failed"
          ? "인식 실패"
          : res.outcome === "no_speech"
            ? res.transcript
              ? `${res.transcript} — 답이 들리지 않았어요`
              : "답이 들리지 않았어요"
            : (res.transcript ?? "");

  return (
    <section className={s.wrap} aria-label="틀 말하기 진행">
      <div className={s.runHead}>
        <span className={s.progress}>
          {index + 1} / {total}
        </span>
        <button type="button" className={s.textBtn} onClick={() => finish("quit")}>
          그만두기
        </button>
      </div>
      {micNotice && <p className={s.notice}>{micNotice}</p>}

      {phase.kind === "reveal" && item ? (
        <div className={`${s.stage} ${s.stageTap}`} role="button" tabIndex={0} aria-label="다음 문장으로" onClick={onStageTap} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onStageTap()}>
          <p className={s.koSmall}>{item.ko}</p>
          <p className={s.modelEn} lang="en">
            {item.en}
          </p>
          <p className={s.mine}>
            <span className={s.mineLabel}>내 말</span>
            <span lang="en">{mineText}</span>
          </p>
          <div className={s.revealBar} aria-hidden>
            <div key={index} className={s.revealFill} style={{ animationDuration: `${TOEIC_FRAME_DRILL_REVEAL_MS}ms` }} />
          </div>
          <p className={s.caption}>{index + 1 >= total ? "누르면 끝내요" : "누르면 바로 다음 문장"}</p>
        </div>
      ) : item ? (
        <div className={s.stage}>
          <p className={s.ko}>{item.ko}</p>
          {phase.kind === "arming" && <p className={s.status}>마이크 준비 중…</p>}
          {phase.kind === "listening" && (
            <>
              <div className={s.meter} aria-hidden>
                <div className={s.meterFill} style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
              </div>
              <p className={s.status}>{phase.speaking ? "듣고 있어요 — 말을 멈추면 넘어가요" : `영어로 말해 보세요(${Math.round(TOEIC_FRAME_DRILL_START_WAIT_MS / 1000)}초 안에)`}</p>
              <div className={s.actions}>
                <button type="button" className="u-btn u-btn-secondary" onClick={() => endItem(runRef.current, "manual")}>
                  다 말했어요
                </button>
              </div>
            </>
          )}
          {phase.kind === "interrupted" && (
            <>
              <p className={s.status}>화면을 떠나 녹음을 멈췄어요.</p>
              <div className={s.actions}>
                <button type="button" className="u-btn u-btn-primary" onClick={() => openItem(indexRef.current, true)}>
                  이 문항 다시
                </button>
              </div>
            </>
          )}
          {phase.kind === "nomic" && (
            <>
              <p className={s.status}>소리 내어 말한 뒤 정답을 확인해요.</p>
              <div className={s.actions}>
                <button type="button" className="u-btn u-btn-primary" onClick={showAnswerNoMic}>
                  정답 보기
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

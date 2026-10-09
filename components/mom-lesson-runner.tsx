"use client";

/**
 * 엄마의 생활영어 하루 레슨 진행(설계 §4) — ① 오늘의 틀 → ② 소리 듣기 → ③ 따라 말하기 → ④ 발화 체크 → ⑤ 대화 듣기(선택) → 끝.
 *
 * - **끝까지 했을 때만 저장한다** — 중간에 나가면 아무것도 남지 않는다(저장 요청은 끝 화면 한 곳뿐).
 * - 저장 id는 처음 마운트 때 정해 두고 다시 보내도 같다(서버가 id 멱등 — 재전송은 reused).
 * - 받아쓰기를 못 하면(키 없음·서버 실패·네트워크·마이크 거부) "넘어가기"로 레슨을 끝낼 수 있다(verdict skipped, transcript null).
 * - 받아쓰기 요청엔 녹음만 보낸다 — 정답 문장은 보내지 않는다(무유도). 판정은 화면이 `judgeMomSpeech`로.
 * - 소리는 이 화면이 연 큐만 멈춘다(전역 stopSpeaking 금지). 마이크는 언마운트에서 놓는다.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOM_VERDICT_KO, type MomCheck, type MomLessonRecord, type MomVerdict } from "@/lib/mom-contract";
import { judgeMomSpeech, type MomJudge } from "@/lib/mom-judge";
import { momHintText, momListenScript, momShadowRepeat, momShadowScript } from "@/lib/mom-lesson-script";
import type { MomLesson } from "@/lib/mom-plan";
import { createMicKeeper, MIC_CHECK_GUM_TIMEOUT_MS, MIC_ERROR_KO, MicError, setAudioSessionPlayback, toWav16kMono, type MicKeeper, type MicRecording } from "@/lib/mic-session";
import { speakQueue, unlockSpeechPlayback, type SpeakQueueItem } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { toeicAudioBaseType, toeicAudioFileName } from "@/lib/toeic-attempt-contract";

type Stage = 0 | 1 | 2 | 3 | 4;
interface SpeakItem { id: string; en: string; ko: string; chunks: string[]; frameText?: string }
interface ListenItem { id: string; en: string; ko: string }
export interface MomLessonRunnerProps {
  lesson: MomLesson;
  stage: Stage;
  frame: { text: string; slots: string[] } | null;
  explainKo: string | null;
  speak: SpeakItem[];
  listen: ListenItem[];
}

type Step = "frame" | "listen" | "shadow" | "check" | "dialog" | "done";
type CheckPhase =
  | { kind: "ready"; noticeKo: string | null }
  | { kind: "arming" }
  | { kind: "recording" }
  | { kind: "working" }
  | { kind: "result"; transcript: string; judge: MomJudge }
  | { kind: "failed"; reasonKo: string };
type SaveState = "idle" | "saving" | "saved" | "error";

const EN = "en-US";
/** 녹음 자동 멈춤(ms) — 받아쓰기 업로드 상한(1 MiB ≈ 20초 WAV) 안 */
const MOM_REC_MAX_MS = 15_000;
/** 이보다 짧으면 "잘 안 들렸어요" */
const MOM_REC_MIN_MS = 400;
/** 받아쓰기 요청 기다림 상한(ms) */
const MOM_TRANSCRIBE_TIMEOUT_MS = 15_000;
const MOM_AUDIO_MAX_BYTES = 1024 * 1024;
const MOM_DIALOG_PAUSE_MS = 800;
const NO_TRANSCRIBE_KO = "지금은 받아쓰기를 못 해요. 정답을 보고 넘어가요.";

function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 보안 컨텍스트 밖(http LAN) — 아래로 */
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** 틀 글자의 `~`를 빈칸 강조로 */
function FrameText({ text }: { text: string }) {
  const parts = text.split("~");
  return (
    <span>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 ? (
            <span className="mx-1 inline-block min-w-[3em] rounded-md border-b-4 border-accent bg-accent/10 px-2 align-baseline">&nbsp;</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

const BIG = { minHeight: 56 } as const;

export default function MomLessonRunner({ lesson, stage, frame, explainKo, speak, listen }: MomLessonRunnerProps) {
  const steps: Step[] = [...(frame ? (["frame"] as const) : []), "listen", "shadow", "check", ...(listen.length > 0 ? (["dialog"] as const) : []), "done"];
  const [step, setStep] = useState<Step>(steps[0]);
  const [playing, setPlaying] = useState(false);
  const [cue, setCue] = useState(false);
  const [shadowAt, setShadowAt] = useState<number | null>(null);

  // ── 발화 체크 상태 ──
  const [ci, setCi] = useState(0);
  const [phase, setPhaseState] = useState<CheckPhase>({ kind: "ready", noticeKo: null });
  const phaseRef = useRef<CheckPhase>(phase);
  const setPhase = useCallback((p: CheckPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3>(0);
  /** 받아쓰기를 이 레슨에서 다시 쓸 수 없다(키 없음·마이크 거부) — 이후 문장은 곧바로 "넘어가기"만 */
  const [transcribeOff, setTranscribeOff] = useState<string | null>(null);
  const checksRef = useRef(new Map<string, MomCheck>());

  // ── 저장 ──
  const idRef = useRef<string>("");
  const startedAtRef = useRef<string>("");
  const finishedAtRef = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // ── 손잡이 ──
  const stopRef = useRef<(() => void) | null>(null);
  const keeperRef = useRef<MicKeeper | null>(null);
  const recRef = useRef<MicRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const firstMicRef = useRef(true);

  useEffect(() => {
    idRef.current = newClientId();
    startedAtRef.current = new Date().toISOString();
  }, []);

  const stopSound = useCallback(() => {
    const st = stopRef.current;
    stopRef.current = null;
    st?.();
    setPlaying(false);
    setCue(false);
    setShadowAt(null);
  }, []);

  /** 탭 안에서 부른다 — iOS 재생 잠금 */
  const play = useCallback(
    (items: SpeakQueueItem[], onItem?: (i: number) => void) => {
      stopSound();
      setPlaying(true);
      stopRef.current = speakQueue(items, {
        onItem: (i) => {
          setCue(false);
          onItem?.(i);
        },
        onPause: () => setCue(true),
        onEnd: () => {
          setPlaying(false);
          setCue(false);
        },
      });
    },
    [stopSound],
  );

  const haltAsync = useCallback(() => {
    runRef.current += 1;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    recRef.current?.abort();
    recRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // 언마운트 — 소리·녹음·요청·마이크 정리. 저장은 하지 않는다(중간에 나가면 기록 없음).
  useEffect(() => {
    return () => {
      haltAsync();
      stopRef.current?.();
      stopRef.current = null;
      keeperRef.current?.release();
      keeperRef.current = null;
    };
  }, [haltAsync]);

  const save = useCallback(async () => {
    if (!idRef.current) idRef.current = newClientId();
    if (!startedAtRef.current) startedAtRef.current = new Date().toISOString();
    if (!finishedAtRef.current) finishedAtRef.current = new Date().toISOString();
    const rec: MomLessonRecord = {
      id: idRef.current,
      lessonId: lesson.id,
      startedAt: startedAtRef.current,
      finishedAt: finishedAtRef.current,
      checks: speak.map((s) => checksRef.current.get(s.id) ?? { sentenceId: s.id, verdict: "skipped", transcript: null, hintLevel: 0 }),
    };
    setSaveState("saving");
    try {
      const res = await fetch("/api/mom/lessons", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !data?.ok) throw new Error(`save ${res.status}`);
      setSaveState("saved");
      window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
    } catch {
      setSaveState("error");
    }
  }, [lesson.id, speak]);

  const goTo = useCallback(
    (next: Step) => {
      stopSound();
      haltAsync();
      setStep(next);
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      if (next === "done") void save();
    },
    [stopSound, haltAsync, save],
  );
  const goNext = useCallback(() => {
    const i = steps.indexOf(step);
    goTo(steps[Math.min(i + 1, steps.length - 1)]);
  }, [steps, step, goTo]);

  // ── 발화 체크 ──
  const cur = speak[ci] ?? null;

  const openSentence = useCallback(
    (i: number) => {
      haltAsync();
      stopSound();
      setCi(i);
      setHintLevel(0);
      setPhase(transcribeOff ? { kind: "failed", reasonKo: transcribeOff } : { kind: "ready", noticeKo: null });
    },
    [haltAsync, stopSound, setPhase, transcribeOff],
  );

  const record = useCallback((s: SpeakItem, verdict: MomVerdict, transcript: string | null, hint: 0 | 1 | 2 | 3) => {
    checksRef.current.set(s.id, { sentenceId: s.id, verdict, transcript: transcript ? transcript.slice(0, 400) : null, hintLevel: hint });
  }, []);

  const nextSentence = useCallback(() => {
    if (ci + 1 < speak.length) openSentence(ci + 1);
    else goNext();
  }, [ci, speak.length, openSentence, goNext]);

  /** 넘어가기 — 마지막 받아쓰기가 있으면 남기고, 결과는 skipped */
  const skip = useCallback(() => {
    if (!cur) return;
    const p = phaseRef.current;
    record(cur, "skipped", p.kind === "result" ? p.transcript : null, hintLevel);
    nextSentence();
  }, [cur, record, hintLevel, nextSentence]);

  /** 판정을 받아들이고 다음 문장 */
  const accept = useCallback(() => {
    if (!cur) return;
    const p = phaseRef.current;
    if (p.kind === "result") record(cur, p.judge.verdict, p.transcript, hintLevel);
    nextSentence();
  }, [cur, record, hintLevel, nextSentence]);

  const failTranscribe = useCallback(
    (token: number, permanent: boolean, reasonKo = NO_TRANSCRIBE_KO) => {
      if (runRef.current !== token) return;
      if (permanent) setTranscribeOff(reasonKo);
      setPhase({ kind: "failed", reasonKo });
    },
    [setPhase],
  );

  async function transcribe(token: number, blob: Blob, mimeType: string, s: SpeakItem) {
    setPhase({ kind: "working" });
    let upload: Blob = blob;
    try {
      const wav = await toWav16kMono(blob);
      if (wav.blob.size <= MOM_AUDIO_MAX_BYTES) upload = wav.blob;
    } catch {
      /* 원본으로 */
    }
    if (runRef.current !== token) return;
    const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(mimeType);
    const name = toeicAudioFileName(type);
    if (!name || upload.size > MOM_AUDIO_MAX_BYTES) {
      failTranscribe(token, false, upload.size > MOM_AUDIO_MAX_BYTES ? "녹음이 너무 길어 받아쓰기를 못 했어요." : NO_TRANSCRIBE_KO);
      return;
    }
    const fd = new FormData();
    fd.append("audio", upload.type ? upload : new Blob([upload], { type }), name);
    const ac = new AbortController();
    abortRef.current = ac;
    const timer = window.setTimeout(() => ac.abort(), MOM_TRANSCRIBE_TIMEOUT_MS);
    let status = 0;
    let data: { ok?: boolean; text?: string } | null = null;
    try {
      const res = await fetch("/api/mom/transcribe", { method: "POST", body: fd, signal: ac.signal });
      status = res.status;
      data = (await res.json().catch(() => null)) as { ok?: boolean; text?: string } | null;
    } catch {
      data = null;
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === ac) abortRef.current = null;
    }
    if (runRef.current !== token) return;
    if (data?.ok && typeof data.text === "string") {
      const judge = judgeMomSpeech({ en: s.en, frameText: s.frameText ?? frame?.text ?? "", transcript: data.text });
      if (judge.noSpeech) {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 한 번 더 말해 볼까요?" });
        return;
      }
      setPhase({ kind: "result", transcript: data.text, judge });
      // 맞음·아깝다면 정답을 한 번 들려준다(🎤 탭에서 푼 재생 요소로). "다시"는 정답을 숨기고 힌트 사다리로
      if (judge.verdict !== "retry") play([{ text: s.en, lang: EN }]);
      return;
    }
    // 501 = 키 없음(이 레슨 내내 못 쓴다) / 500·네트워크·시간 초과 = 이번 문장만
    failTranscribe(token, status === 501);
  }

  function finishRecording(token: number) {
    if (runRef.current !== token || phaseRef.current.kind !== "recording") return;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    const rec = recRef.current;
    recRef.current = null;
    const s = cur;
    setPhase({ kind: "working" });
    if (!rec || !s) {
      setPhase({ kind: "ready", noticeKo: "녹음이 멈춰 버렸어요. 한 번 더 눌러 주세요." });
      return;
    }
    void rec.stop().then((result) => {
      setAudioSessionPlayback(); // 정답 소리가 수화기로 가지 않게
      if (runRef.current !== token) return;
      if (!result || result.durationMs < MOM_REC_MIN_MS) {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 조금 더 길게 말해 볼까요?" });
        return;
      }
      void transcribe(token, result.blob, result.mimeType, s);
    });
  }

  /** 🎤 탭 — 녹음 중이면 멈추고, 아니면 시작 */
  function onMic() {
    const k = phaseRef.current.kind;
    if (k === "recording") {
      finishRecording(runRef.current);
      return;
    }
    if (k !== "ready" && k !== "result") return;
    stopSound();
    unlockSpeechPlayback();
    haltAsync();
    const token = runRef.current;
    setPhase({ kind: "arming" });
    if (!keeperRef.current) keeperRef.current = createMicKeeper();
    const keeper = keeperRef.current;
    const needsPrompt = firstMicRef.current || (keeper.policy === "keep" && !keeper.holding());
    const micFail = (e: unknown) => {
      if (runRef.current !== token) return;
      recRef.current?.abort();
      recRef.current = null;
      keeperRef.current?.release();
      const msg = e instanceof MicError ? MIC_ERROR_KO[e.kind] : "마이크를 쓸 수 없어요.";
      // 권한 거부·지원 안 함·마이크 없음은 이 레슨 내내 그대로 — 그 밖(응답 없음·사용 중)은 다음 문장에서 다시 해 본다
      const permanent = !(e instanceof MicError) || e.kind === "denied" || e.kind === "unsupported" || e.kind === "no_device";
      failTranscribe(token, permanent, `${msg} 이번 문장은 정답을 보고 넘어가요.`);
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
          () => {
            if (runRef.current !== token) return;
            setPhase({ kind: "recording" });
            autoStopRef.current = window.setTimeout(() => finishRecording(token), MOM_REC_MAX_MS);
          },
          (e: unknown) => micFail(e),
        );
      })
      .catch((e: unknown) => micFail(e));
  }

  function onHint() {
    unlockSpeechPlayback();
    setHintLevel((h) => (h >= 3 ? 3 : ((h + 1) as 1 | 2 | 3)));
  }

  const stepNo = steps.indexOf(step) + 1;
  const stepTotal = steps.length - 1; // "done" 제외
  const stepTitle: Record<Step, string> = {
    frame: "오늘의 틀",
    listen: "소리 듣기",
    shadow: "따라 말하기",
    check: "말해 보기",
    dialog: "대화 듣기",
    done: "끝",
  };

  return (
    <div className="mt-2">
      {step !== "done" ? (
        <div className="mb-4 flex items-center justify-between">
          <p className="t-section-title">
            {stepNo}/{stepTotal} · {stepTitle[step]}
          </p>
          <div className="flex gap-1" aria-hidden>
            {steps.slice(0, -1).map((s, i) => (
              <span key={s} className={`h-2 w-6 rounded-full ${i < stepNo ? "bg-accent" : "bg-line"}`} />
            ))}
          </div>
        </div>
      ) : null}

      {/* ① 오늘의 틀 */}
      {step === "frame" && frame ? (
        <section className="u-card p-5">
          <p className="t-caption text-ink-3">이 모양을 익혀요</p>
          <p className="mt-2 text-2xl font-bold leading-relaxed" lang="en">
            <FrameText text={frame.text} />
          </p>
          {frame.slots.length > 0 ? <p className="t-caption mt-2 text-ink-3">빈칸에는: {frame.slots.join(" · ")}</p> : null}
          {explainKo ? <p className="t-body mt-4 text-ink-2">💡 {explainKo}</p> : null}
          <button type="button" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG} onClick={() => goNext()}>
            소리 듣기 ▶
          </button>
        </section>
      ) : null}

      {/* ② 소리 듣기 */}
      {step === "listen" && speak[0] ? (
        <section className="u-card p-5">
          <p className="t-caption text-ink-3">덩어리로 끊어서 들어 봐요</p>
          <p className="mt-3 text-2xl font-bold leading-relaxed" lang="en">
            {speak[0].chunks.join(" / ")}
          </p>
          <p className="t-body mt-2 text-ink-2">{speak[0].ko}</p>
          <button
            type="button"
            className="u-btn u-btn-primary mt-6 w-full text-lg"
            style={BIG}
            onClick={() => {
              unlockSpeechPlayback();
              play(momListenScript(speak[0]));
            }}
          >
            {playing ? "🔊 듣는 중… (다시 듣기)" : "🔊 듣기"}
          </button>
          <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={() => goNext()}>
            다음
          </button>
        </section>
      ) : null}

      {/* ③ 따라 말하기 */}
      {step === "shadow" ? (
        <ShadowStep
          speak={speak}
          repeat={momShadowRepeat(stage)}
          playing={playing}
          cue={cue}
          at={shadowAt}
          onPlay={() => {
            unlockSpeechPlayback();
            const per = 1 + momShadowRepeat(stage);
            play(momShadowScript(speak, momShadowRepeat(stage)), (i) => setShadowAt(Math.floor(i / per)));
          }}
          onNext={() => goNext()}
        />
      ) : null}

      {/* ④ 말해 보기 */}
      {step === "check" && cur ? (
        <section className="u-card p-5">
          <p className="t-caption text-ink-3">
            문장 {ci + 1}/{speak.length} · 영어로 말해 봐요
          </p>
          <p className="mt-3 text-2xl font-bold leading-relaxed">{cur.ko}</p>

          {hintLevel > 0 && phase.kind !== "failed" && !(phase.kind === "result" && phase.judge.verdict !== "retry") ? (
            <p className="mt-3 rounded-lg bg-accent/10 p-3 text-lg" lang="en">
              💡 {momHintText(cur.en, hintLevel as 1 | 2 | 3, cur.chunks)}
            </p>
          ) : null}

          {phase.kind === "ready" || phase.kind === "arming" || phase.kind === "recording" || phase.kind === "working" ? (
            <>
              {phase.kind === "ready" && phase.noticeKo ? <p className="t-body mt-3 text-ink-2">{phase.noticeKo}</p> : null}
              <button
                type="button"
                className="u-btn u-btn-primary mt-6 w-full text-xl"
                style={{ minHeight: 72 }}
                disabled={phase.kind === "arming" || phase.kind === "working"}
                onClick={onMic}
              >
                {phase.kind === "recording" ? "⏹ 다 말했어요" : phase.kind === "arming" ? "마이크 켜는 중…" : phase.kind === "working" ? "듣고 있어요…" : "🎤 말하기"}
              </button>
              <p className="t-caption mt-2 text-center text-ink-3">
                {phase.kind === "recording" ? "말하는 중이에요. 다 말하면 다시 눌러요." : "눌러서 말하고, 다 말하면 다시 눌러요"}
              </p>
              {phase.kind === "ready" ? (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} onClick={onHint} disabled={hintLevel >= 3}>
                    💡 힌트 {hintLevel > 0 ? `(${hintLevel}/3)` : ""}
                  </button>
                  <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} onClick={skip}>
                    넘어가기
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {phase.kind === "result" ? (
            <ResultView
              en={cur.en}
              judge={phase.judge}
              transcript={phase.transcript}
              hintLevel={hintLevel}
              onListen={() => {
                unlockSpeechPlayback();
                play([{ text: cur.en, lang: EN }]);
              }}
              onAgain={onMic}
              onHint={onHint}
              onSkip={skip}
              onNext={accept}
            />
          ) : null}

          {phase.kind === "failed" ? (
            <div className="mt-4">
              <p className="t-body text-ink-2">{phase.reasonKo}</p>
              <p className="mt-3 text-xl font-semibold" lang="en">
                {cur.en}
              </p>
              <button
                type="button"
                className="u-btn u-btn-secondary mt-3 w-full text-lg"
                style={BIG}
                onClick={() => {
                  unlockSpeechPlayback();
                  play([{ text: cur.en, lang: EN }]);
                }}
              >
                🔊 정답 듣기
              </button>
              <button type="button" className="u-btn u-btn-primary mt-3 w-full text-lg" style={BIG} onClick={skip}>
                넘어가기
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ⑤ 대화 듣기 */}
      {step === "dialog" ? (
        <section className="u-card p-5">
          <p className="t-caption text-ink-3">대화로 들어 봐요 (안 해도 돼요)</p>
          <ul className="mt-3 space-y-3">
            {listen.map((l) => (
              <li key={l.id}>
                <p className="text-lg font-semibold" lang="en">
                  {l.en}
                </p>
                <p className="t-caption text-ink-3">{l.ko}</p>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="u-btn u-btn-primary mt-6 w-full text-lg"
            style={BIG}
            onClick={() => {
              unlockSpeechPlayback();
              play(listen.map((l) => ({ text: l.en, lang: EN, pauseAfterMs: MOM_DIALOG_PAUSE_MS })));
            }}
          >
            {playing ? "🔊 듣는 중… (처음부터)" : "전체 듣기 ▶"}
          </button>
          <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={() => goNext()}>
            {playing ? "레슨 끝내기" : "건너뛰기"}
          </button>
        </section>
      ) : null}

      {/* 끝 */}
      {step === "done" ? (
        <section className="u-card p-6 text-center">
          {saveState === "saved" ? (
            <>
              <p className="text-3xl font-bold">오늘 레슨 끝! 🔥</p>
              <p className="t-body mt-2 text-ink-2">정말 잘했어요. 내일 또 만나요.</p>
              <Link href="/mom" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG}>
                홈으로
              </Link>
            </>
          ) : saveState === "error" ? (
            <>
              <p className="t-section-title">기록을 저장하지 못했어요</p>
              <p className="t-body mt-2 text-ink-2">인터넷을 확인하고 다시 눌러 주세요.</p>
              <button type="button" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG} onClick={() => void save()}>
                다시 저장하기
              </button>
            </>
          ) : (
            <p className="t-section-title">기록을 저장하고 있어요…</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function ShadowStep({
  speak,
  repeat,
  playing,
  cue,
  at,
  onPlay,
  onNext,
}: {
  speak: SpeakItem[];
  repeat: number;
  playing: boolean;
  cue: boolean;
  at: number | null;
  onPlay: () => void;
  onNext: () => void;
}) {
  return (
    <section className="u-card p-5">
      <p className="t-caption text-ink-3">한국어를 듣고, 영어를 {repeat}번 따라 말해요 (녹음은 안 해요)</p>
      <ol className="mt-3 space-y-3">
        {speak.map((s, i) => (
          <li key={s.id} className={`rounded-lg p-3 ${at === i ? "bg-accent/10" : ""}`}>
            <p className="t-caption text-ink-3">{s.ko}</p>
            <p className="text-lg font-semibold" lang="en">
              {s.en}
            </p>
          </li>
        ))}
      </ol>
      {playing && cue ? <p className="mt-3 text-center text-lg font-bold">🗣️ 따라 말해 보세요</p> : null}
      <button type="button" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG} onClick={onPlay}>
        {playing ? "🔊 처음부터 다시" : "▶ 시작"}
      </button>
      <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={onNext}>
        다음
      </button>
    </section>
  );
}

function ResultView({
  en,
  judge,
  transcript,
  hintLevel,
  onListen,
  onAgain,
  onHint,
  onSkip,
  onNext,
}: {
  en: string;
  judge: MomJudge;
  transcript: string;
  hintLevel: number;
  onListen: () => void;
  onAgain: () => void;
  onHint: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const badge = judge.verdict === "pass" ? "✅ " : judge.verdict === "close" ? "🙂 " : "🔁 ";
  return (
    <div className="mt-4">
      <p className="text-2xl font-bold">
        {badge}
        {MOM_VERDICT_KO[judge.verdict]}
      </p>
      <p className="t-caption mt-2 text-ink-3">들린 말: {transcript}</p>
      {judge.verdict !== "retry" ? (
        <p className="mt-3 text-xl font-semibold" lang="en">
          {en}
        </p>
      ) : (
        <p className="t-body mt-2 text-ink-2">💡 힌트를 보면서 한 번 더 말해 봐요.</p>
      )}
      {judge.noteKo ? <p className="t-body mt-2 text-ink-2">{judge.noteKo}</p> : null}
      {judge.verdict !== "retry" || hintLevel >= 3 ? (
        <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={onListen}>
          🔊 정답 듣기
        </button>
      ) : null}
      {judge.verdict === "retry" ? (
        <>
          <button type="button" className="u-btn u-btn-primary mt-3 w-full text-lg" style={BIG} onClick={onAgain}>
            🎤 한 번 더
          </button>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} onClick={onHint} disabled={hintLevel >= 3}>
              💡 힌트 {hintLevel > 0 ? `(${hintLevel}/3)` : ""}
            </button>
            <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} onClick={onSkip}>
              넘어가기
            </button>
          </div>
        </>
      ) : (
        <>
          <button type="button" className="u-btn u-btn-primary mt-3 w-full text-lg" style={BIG} onClick={onNext}>
            다음
          </button>
          {judge.verdict === "close" ? (
            <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={onAgain}>
              🎤 한 번 더
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

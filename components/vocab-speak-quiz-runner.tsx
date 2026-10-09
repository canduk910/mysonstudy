"use client";

/**
 * 그림 보고 말하기 러너 — 은우 단어장 (2026-10-03, SPEC §15-5, docs/harness/english.md §14) — 클라이언트 컴포넌트.
 *
 * 번역 없는 떠올리기: **이모지(크게) + 영영 정의만** 보여 주고 한국어 뜻은 숨긴다(이 화면은 한국어 뜻을 **받지도 않는다** —
 * 서버 페이지가 word·definitionEn·emoji만 넘긴다) → 은우가 영어 단어를 🎤로 말한다 → 관문 W 전사 → 순수 판정(lib/kid-speak.ts)
 * → 맞으면 칭찬, 아니면 단계적 도움(첫 글자 → 글자 수 밑줄 → 정답 공개 + 🔊) → 다음. 마이크가 없거나 거부되면 **스스로 확인**
 * (말해 보고 정답 보기 → 😀🤔😢).
 *
 * ── 소리 ─────────────────────────────────────────────────────────────────────
 * - 🔊는 탭할 때만. 프리페치 없음. 예외 하나 — **정답이 드러나는 순간**(맞혔을 때·정답 공개 때) 정답 단어를 한 번 읽는다(따라 말할 소리).
 * - 시작 탭 안에서 동기로 재생 잠금을 푼다(unlockSpeechPlayback). 녹음을 끝내는 탭도 한 번 더 푼다(전사 뒤 정답 소리가 탭 밖이라).
 * - 녹음 전에는 재생을 멈춘다(재생과 캡처를 겹치지 않는다). 녹음 중·전사 중에는 🔊를 막는다.
 *
 * ── 마이크 ──────────────────────────────────────────────────────────────────
 * lib/mic-session `startRecording`(owner "kid-speak" — 세션 전환·권한 대기 상한·끝나면 트랙 stop → playback). 첫 녹음은 권한 창에 답할
 * 시간(15초), 그다음은 8초. 6초면 저절로 끝난다. 0.3초 미만·무음은 올리지 않는다(비용 0). 화면이 숨겨지면 녹음을 버린다.
 * 화면이 사라지면(뒤로가기 — 언마운트) 녹음·전사 요청·소리를 모두 끊는다.
 *
 * ── 저장 ────────────────────────────────────────────────────────────────────
 * 끝·그만하기에 1회 POST `/api/english/vocab/[id]/quiz` `{ mode:"picture-speak" }` — 저장 모양은 다른 시험과 같고(VocabQuizItem 3상태)
 * 모드로만 갈린다. 숙련도는 다른 모드와 섞지 않는다(lib/vocab-quiz.ts VOCAB_SEPARATE_MASTERY_MODES). 스트릭 은우 트랙에 센다(§17).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KID_SPEAK_MODE,
  KID_SPEAK_REVEAL_STEP,
  judgeKidSpeech,
  kidSpeakHint,
  kidSpeakItemResult,
  pickKidSpeakWords,
  type KidSpeakOutcome,
  type KidSpeakPoolItem,
  type KidSpeakStatLike,
} from "@/lib/kid-speak";
import {
  KID_SPEAK_AUDIO_FIELD,
  KID_SPEAK_REC_MAX_MS,
  KID_SPEAK_REC_MIN_MS,
  KID_SPEAK_SILENCE_LEVEL,
  KID_SPEAK_TRANSCRIBE_CLIENT_TIMEOUT_MS,
  KID_SPEAK_TRANSCRIBE_ENDPOINT,
  type KidSpeakTranscribeResponse,
} from "@/lib/kid-speak-contract";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MIC_GUM_TIMEOUT_MS,
  MicError,
  detectMicSupport,
  startRecording,
  toWav16kMono,
  type MicRecording,
} from "@/lib/mic-session";
import { speak, stopSpeaking, unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import type { VocabQuizItem } from "@/lib/store";
import type { VocabQuizSubmitRequest, VocabQuizSubmitResponse } from "@/lib/vocab-quiz-contract";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import StreakFinishHint from "@/components/streak-finish-hint";
import s from "./vocab-speak-quiz-runner.module.css";

interface VocabSpeakQuizRunnerProps {
  /** 결과를 저장할 단어장 id */
  id: string;
  titleKo: string;
  dayLabel: string | null;
  /** 낼 수 있는 단어(정의가 있는 단어 — 오답 다시 말하기면 그 모드에서 틀린·미졸업 단어만). 한국어 뜻은 없다 */
  pool: KidSpeakPoolItem[];
  /** 그림 보고 말하기 모드만의 단어 통계(약한 단어부터 고르는 데 쓴다) */
  stats: Record<string, KidSpeakStatLike>;
  /** "wrong" = 오답노트에서 온 다시 말하기(문구만 다르다) */
  variant: "all" | "wrong";
}

type Phase = "intro" | "question" | "results";
type InputMode = "mic" | "self";
type MicState = "idle" | "starting" | "recording" | "listening";
type SaveState = "idle" | "saving" | "saved" | "error";

/** 문항 아래 한 줄 안내(판정·실패) */
type Note =
  | { kind: "close" | "wrong" | "list"; heard: string }
  | { kind: "empty" | "silent" | "short" | "fail" | "hidden" }
  | { kind: "switched"; messageKo: string };

/** lib/mic-session 공유 신호에 싣는 이 녹음의 이름 */
const KID_SPEAK_MIC_OWNER = "kid-speak";

/** 마이크 오류 → 1학년 문구(스스로 확인으로 바꾼다는 말까지) */
function micSwitchKo(e: unknown): string {
  const kind = e instanceof MicError ? e.kind : "failed";
  if (kind === "denied") return "마이크를 쓸 수 없어서(권한이 꺼져 있어요) 스스로 확인으로 할게요.";
  if (kind === "unsupported") return "이 기기에서는 녹음을 할 수 없어서 스스로 확인으로 할게요.";
  if (kind === "no_device") return "마이크를 찾지 못해서 스스로 확인으로 할게요.";
  if (kind === "timeout") return "마이크가 대답하지 않아서 스스로 확인으로 할게요.";
  return "마이크를 켜지 못해서 스스로 확인으로 할게요.";
}

function audioFileName(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  if (base.includes("wav") || base.includes("wave")) return "word.wav";
  if (base === "audio/mp4") return "word.mp4";
  if (base.includes("m4a")) return "word.m4a";
  return "word.webm";
}

export default function VocabSpeakQuizRunner({ id, titleKo, dayLabel, pool, stats, variant }: VocabSpeakQuizRunnerProps) {
  usePhraseHelperBlock(); // 시험·응답 중에는 표현 도우미를 띄우지 않는다(SPEC §22-3)

  const [words, setWords] = useState<KidSpeakPoolItem[] | null>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [inputMode, setInputMode] = useState<InputMode>("mic");
  const [micOk, setMicOk] = useState(false);
  const [current, setCurrent] = useState(0);
  const [step, setStep] = useState(0); // 도움 단계 0~3
  const [outcomes, setOutcomes] = useState<(KidSpeakOutcome | null)[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [mic, setMicState] = useState<MicState>("idle");
  const [recSec, setRecSec] = useState(0);
  const [startedAt, setStartedAt] = useState("");
  const [completed, setCompleted] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const micRef = useRef<MicState>("idle");
  const setMic = (m: MicState) => {
    micRef.current = m;
    setMicState(m);
  };
  const recRef = useRef<MicRecording | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const tokenRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peakRef = useRef(0);
  const reliableRef = useRef(false);
  const trAcRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const micGrantedRef = useRef(false);
  const finishRef = useRef<() => void>(() => {});
  const submittedRef = useRef(false);

  // 마운트 뒤 1회 — 단어 고르기(셔플이 rng라 hydration 뒤)·마이크 지원 감지
  useEffect(() => {
    setWords(pickKidSpeakWords(pool, stats));
    const ok = detectMicSupport().ok;
    setMicOk(ok);
    setInputMode(ok ? "mic" : "self");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearTimers = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (autoRef.current) clearTimeout(autoRef.current);
    tickRef.current = null;
    autoRef.current = null;
  };
  const closeCtx = () => {
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
  };

  /** 녹음·전사를 버린다(전사하지 않는다) — 숨김·다음·그만하기·언마운트·스스로 확인으로 바꾸기 */
  const cancelMic = useCallback(() => {
    tokenRef.current += 1;
    clearTimers();
    const rec = recRef.current;
    recRef.current = null;
    if (rec) rec.abort();
    trAcRef.current?.abort();
    trAcRef.current = null;
    closeCtx();
    if (micRef.current !== "idle") {
      micRef.current = "idle";
      if (aliveRef.current) setMicState("idle");
    }
  }, []);

  // 화면이 사라지면 전부 끊는다(뒤로가기 — 마이크·전사 요청·소리)
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelMic();
      stopSpeaking();
    };
  }, [cancelMic]);

  // 화면이 숨겨지면 녹음을 버린다(녹음 중 숨김 = 버림 — 토익 응시·표현 도우미와 같은 규칙)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "hidden") return;
      if (micRef.current === "starting" || micRef.current === "recording") {
        cancelMic();
        setNote({ kind: "hidden" });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [cancelMic]);

  if (!words) {
    return (
      <div className={s.wrap}>
        <p className="t-lead">준비하고 있어요…</p>
      </div>
    );
  }

  const total = words.length;
  const word = words[current];
  const outcome = outcomes[current] ?? null;
  const answeredCount = outcomes.filter((o) => o !== null && o !== "unanswered").length;
  const goodCount = outcomes.filter((o) => o === "said" || o === "said-hint" || o === "self-good").length;

  // ── 세션 ──────────────────────────────────────────────────────────────────
  function begin(mode: InputMode) {
    unlockSpeechPlayback(); // 시작 탭 안에서 동기로 — 뒤의 정답 소리(전사 뒤 = 탭 밖)가 나게
    setInputMode(mode);
    setOutcomes(new Array(total).fill(null));
    setCurrent(0);
    setStep(0);
    setNote(null);
    setStartedAt(new Date().toISOString());
    setCompleted(false);
    setSaveState("idle");
    setSaveMessage(null);
    submittedRef.current = false;
    setPhase("question");
  }

  function again() {
    cancelMic();
    stopSpeaking();
    setWords(pickKidSpeakWords(pool, stats));
    setPhase("intro");
  }

  function settle(o: KidSpeakOutcome) {
    setOutcomes((prev) => {
      const next = [...prev];
      next[current] = o;
      return next;
    });
  }

  /** 정답이 드러나는 순간 — 정답 단어를 한 번 읽는다(자동 재생 1회, 판단 근거는 머리 주석) */
  function sayAnswer() {
    speak(word.word, "en-US");
  }

  async function submit(list: (KidSpeakOutcome | null)[], complete: boolean) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSaveState("saving");
    setSaveMessage(null);
    const items: VocabQuizItem[] = words!.map((w, i) => ({ word: w.word, ...kidSpeakItemResult(list[i] ?? "unanswered") }));
    const body: VocabQuizSubmitRequest = {
      mode: KID_SPEAK_MODE,
      startedAt,
      finishedAt: complete ? new Date().toISOString() : null,
      items,
    };
    try {
      const res = await fetch(`/api/english/vocab/${id}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as VocabQuizSubmitResponse | null;
      if (!aliveRef.current) return;
      if (data && data.ok) {
        setSaveState("saved");
        setSaveMessage(complete ? "결과를 저장했어요!" : "여기까지 한 결과를 저장했어요.");
        window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 스트릭 헤드라인 즉시 갱신(§17-4)
      } else {
        submittedRef.current = false; // 다시 저장을 열어 둔다
        setSaveState("error");
        setSaveMessage(data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요.");
      }
    } catch {
      if (!aliveRef.current) return;
      submittedRef.current = false;
      setSaveState("error");
      setSaveMessage("연결이 끊겼어요. 결과를 저장하지 못했어요.");
    }
  }

  function next() {
    cancelMic();
    stopSpeaking();
    if (current + 1 >= total) {
      setCompleted(true);
      setPhase("results");
      void submit(outcomes, true);
      return;
    }
    setCurrent((c) => c + 1);
    setStep(0);
    setNote(null);
  }

  function stop() {
    cancelMic();
    stopSpeaking();
    setCompleted(false);
    setPhase("results");
    if (answeredCount > 0) void submit(outcomes, false);
    else {
      setSaveState("idle");
      setSaveMessage("아직 한 단어가 없어 저장하지 않았어요.");
    }
  }

  // ── 도움 ──────────────────────────────────────────────────────────────────
  /** 💡 — 한 단계 올린다. 마이크 모드에서 3단계(정답 공개)가 되면 그 단어는 "revealed"로 끝난다 */
  function hint() {
    if (outcome !== null || micRef.current !== "idle") return;
    const nextStep = Math.min(KID_SPEAK_REVEAL_STEP, step + 1);
    setStep(nextStep);
    setNote(null);
    if (nextStep >= KID_SPEAK_REVEAL_STEP) {
      if (inputMode === "mic") settle("revealed");
      sayAnswer();
    }
  }

  /** 스스로 확인 — 정답 보기(3단계) */
  function revealSelf() {
    if (outcome !== null) return;
    setStep(KID_SPEAK_REVEAL_STEP);
    setNote(null);
    sayAnswer();
  }

  function judgeSelf(o: "self-good" | "self-unsure" | "self-miss") {
    if (outcome !== null || step < KID_SPEAK_REVEAL_STEP) return;
    settle(o);
  }

  function switchToSelf(messageKo: string) {
    cancelMic();
    setInputMode("self");
    setNote({ kind: "switched", messageKo });
  }

  // ── 마이크 ────────────────────────────────────────────────────────────────
  function failMic(e: unknown) {
    clearTimers();
    recRef.current = null;
    closeCtx();
    if (!aliveRef.current) return;
    setMic("idle");
    switchToSelf(micSwitchKo(e));
  }

  function startMic() {
    if (micRef.current !== "idle" || outcome !== null || step >= KID_SPEAK_REVEAL_STEP) return;
    stopSpeaking(); // 재생과 캡처를 겹치지 않는다
    setNote(null);
    setMic("starting");
    let ctx: AudioContext | null = null;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        ctx = new AC();
        void ctx.resume().catch(() => {});
      }
    } catch {
      ctx = null;
    }
    ctxRef.current = ctx;
    peakRef.current = 0;
    reliableRef.current = false;
    const token = (tokenRef.current += 1);
    finishRef.current = finishMic; // 6초 자동 끝이 이 문항·이 도움 단계의 finishMic을 부르게(탭 핸들러 안에서 갱신)
    // 탭 안에서 동기로 — getUserMedia 요청이 첫 await 전에 나간다(권한 창). 처음엔 권한 창에 답할 시간을 준다
    startRecording({
      audioContext: ctx,
      gumTimeoutMs: micGrantedRef.current ? MIC_GUM_TIMEOUT_MS : MIC_CHECK_GUM_TIMEOUT_MS,
      owner: KID_SPEAK_MIC_OWNER,
    }).then(
      async (rec) => {
        if (!aliveRef.current || token !== tokenRef.current) {
          rec.abort();
          return;
        }
        recRef.current = rec;
        try {
          await rec.started;
        } catch (e) {
          if (token === tokenRef.current) failMic(e);
          return;
        }
        if (!aliveRef.current || token !== tokenRef.current) return;
        micGrantedRef.current = true;
        const t0 = Date.now();
        setRecSec(0);
        setMic("recording");
        tickRef.current = setInterval(() => {
          if (rec.levelReliable()) {
            reliableRef.current = true;
            peakRef.current = Math.max(peakRef.current, rec.level());
          }
          setRecSec(Math.floor((Date.now() - t0) / 1000));
        }, 100);
        autoRef.current = setTimeout(() => finishRef.current(), KID_SPEAK_REC_MAX_MS);
      },
      (e: unknown) => {
        if (token === tokenRef.current) failMic(e);
      },
    );
  }

  function finishMic() {
    const rec = recRef.current;
    if (!rec || micRef.current !== "recording") return;
    recRef.current = null;
    clearTimers();
    setMic("listening");
    const token = tokenRef.current;
    const answer = word.word;
    void (async () => {
      const r = await rec.stop(); // recorder.stop → 트랙 stop → 그다음 playback(모듈이 순서를 지킨다)
      closeCtx();
      if (!aliveRef.current || token !== tokenRef.current) return;
      const done = (n: Note | null) => {
        setMic("idle");
        setNote(n);
      };
      if (!r) return done({ kind: "empty" });
      if (r.durationMs < KID_SPEAK_REC_MIN_MS) return done({ kind: "short" });
      // 무음은 올리지 않는다(무음 전사는 엉뚱한 낱말을 지어낼 수 있다 — 비용 0). 레벨을 믿을 수 있을 때만 판정한다
      if (reliableRef.current && peakRef.current < KID_SPEAK_SILENCE_LEVEL) return done({ kind: "silent" });

      let blob: Blob = r.blob;
      let type = r.mimeType;
      try {
        const w = await toWav16kMono(r.blob);
        blob = w.blob;
        type = "audio/wav";
      } catch {
        /* 디코드 실패 — 원본을 올린다 */
      }
      if (!aliveRef.current || token !== tokenRef.current) return;

      const fd = new FormData();
      fd.append(KID_SPEAK_AUDIO_FIELD, blob, audioFileName(type)); // 정답은 보내지 않는다(전사 무유도)
      const ac = new AbortController();
      trAcRef.current = ac;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, KID_SPEAK_TRANSCRIBE_CLIENT_TIMEOUT_MS);
      try {
        const res = await fetch(KID_SPEAK_TRANSCRIBE_ENDPOINT, { method: "POST", body: fd, signal: ac.signal });
        const data = (await res.json().catch(() => null)) as KidSpeakTranscribeResponse | null;
        if (!aliveRef.current || token !== tokenRef.current) return;
        if (res.ok && data && data.ok) {
          const j = judgeKidSpeech(data.text, answer);
          if (j.verdict === "empty") return done({ kind: "empty" });
          if (j.verdict === "correct") {
            setMic("idle");
            setNote(null);
            settle(step > 0 ? "said-hint" : "said");
            sayAnswer();
            return;
          }
          // 틀림·거의·늘어놓기 — 도움 한 단계. 3단계면 정답 공개로 끝난다
          const nextStep = Math.min(KID_SPEAK_REVEAL_STEP, step + 1);
          setStep(nextStep);
          done({ kind: j.verdict, heard: j.heard });
          if (nextStep >= KID_SPEAK_REVEAL_STEP) {
            settle("revealed");
            sayAnswer();
          }
          return;
        }
        if (res.status === 501) {
          setMic("idle");
          switchToSelf("지금은 말하기 채점을 쓸 수 없어서 스스로 확인으로 할게요.");
          return;
        }
        return done({ kind: "fail" });
      } catch {
        if (!aliveRef.current || token !== tokenRef.current) return;
        if (ac.signal.aborted && !timedOut) return done(null);
        return done({ kind: "fail" });
      } finally {
        clearTimeout(timer);
        if (trAcRef.current === ac) trAcRef.current = null;
      }
    })();
  }
  function onMicTap() {
    if (micRef.current === "recording") {
      unlockSpeechPlayback(); // 이 탭 안에서 — 전사 뒤(탭 밖) 정답 소리가 나게
      finishMic();
    } else startMic();
  }

  const backToBook = (
    <Link href={`/english/vocab/${id}`} className="u-btn u-btn-secondary" onClick={() => stopSpeaking()}>
      <span aria-hidden>📖</span> 단어장으로
    </Link>
  );

  // ── 시작 화면 ──────────────────────────────────────────────────────────────
  if (phase === "intro") {
    return (
      <div className={s.wrap}>
        <section className={s.intro}>
          <p className={s.introEmoji} aria-hidden>
            🖼️🎤
          </p>
          <h2 className="t-section-title">{variant === "wrong" ? "못 떠올린 단어 다시 말하기" : "그림 보고 말하기"}</h2>
          <p className="t-lead">
            그림과 영어 뜻을 보고, 그 <b>영어 단어</b>를 소리 내어 말해요.
            <br />
            한국어 뜻은 숨겨 둘게요. 생각이 안 나면 💡를 눌러요.
          </p>
          <p className="t-caption">오늘 말할 단어 {total}개</p>
          <div className={s.introActions}>
            {micOk ? (
              <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={() => begin("mic")} data-testid="kid-speak-start-mic">
                <span aria-hidden>🎤</span> 말로 하기 시작
              </button>
            ) : null}
            <button
              type="button"
              className={`u-btn ${micOk ? "u-btn-secondary" : "u-btn-primary"} ${s.bigBtn}`}
              onClick={() => begin("self")}
              data-testid="kid-speak-start-self"
            >
              <span aria-hidden>👀</span> 스스로 확인하며 하기
            </button>
          </div>
          {!micOk ? <p className="t-caption">이 기기에서는 녹음을 할 수 없어서 스스로 확인으로 해요.</p> : null}
        </section>
        <div className={s.footer}>{backToBook}</div>
      </div>
    );
  }

  // ── 결과 화면 ──────────────────────────────────────────────────────────────
  if (phase === "results") {
    return (
      <div className={s.wrap}>
        <div className={s.results}>
          <StreakFinishHint partial={!completed} />
          <p className="t-caption">{completed ? "다 했어요!" : "여기까지 했어요"}</p>
          <p className={s.scoreBig}>
            {goodCount} <span className={s.scoreSlash}>/</span> {answeredCount}
          </p>
          <p className="t-lead">
            {answeredCount > 0 ? `${answeredCount}단어 중 ${goodCount}개를 떠올렸어요.` : "말한 단어가 없어요."}
          </p>
          <ul className={s.resultList} data-testid="kid-speak-results">
            {words.map((w, i) => {
              const o = outcomes[i];
              if (!o || o === "unanswered") return null;
              const good = o === "said" || o === "said-hint" || o === "self-good";
              return (
                <li key={w.word} className={`${s.resultRow} ${good ? s.resultGood : s.resultMiss}`}>
                  <span aria-hidden className={s.resultEmoji}>
                    {w.emoji ?? "·"}
                  </span>
                  <span className={s.resultWord} lang="en">
                    {w.word}
                  </span>
                  <span className={s.resultMark}>{o === "said" ? "⭐ 혼자 떠올림" : good ? "○" : "다시 해 봐요"}</span>
                </li>
              );
            })}
          </ul>
          {saveState === "saving" ? (
            <p role="status" className={s.saveMsg}>
              결과를 저장하는 중이에요…
            </p>
          ) : saveMessage ? (
            <p role="status" className={`${s.saveMsg} ${saveState === "error" ? s.saveMsgError : ""}`}>
              {saveMessage}
              {saveState === "error" ? (
                <button type="button" className={s.retryBtn} onClick={() => void submit(outcomes, completed)}>
                  다시 저장
                </button>
              ) : null}
            </p>
          ) : null}
          {saveState === "saved" ? <p className="t-caption">📅 못 떠올린 단어는 오늘의 복습에 먼저 나와요.</p> : null}
          <div className={s.resultActions}>
            <button type="button" className="u-btn u-btn-primary" onClick={again}>
              <span aria-hidden>🔁</span> 다시 하기
            </button>
            <Link href={`/english/vocab/${id}/wrong`} className="u-btn u-btn-secondary">
              <span aria-hidden>📕</span> 오답노트
            </Link>
            {backToBook}
          </div>
        </div>
      </div>
    );
  }

  // ── 문제 화면 ──────────────────────────────────────────────────────────────
  const h = kidSpeakHint(word.word, step);
  const revealed = step >= KID_SPEAK_REVEAL_STEP;
  const good = outcome === "said" || outcome === "said-hint";
  const micBusy = mic !== "idle";
  const progress = total > 0 ? ((current + (outcome ? 1 : 0)) / total) * 100 : 0;

  let noteText: string | null = null;
  if (note) {
    if (note.kind === "close") noteText = `거의 다 왔어요! “${note.heard}”(이)라고 들렸어요.`;
    else if (note.kind === "list") noteText = `“${note.heard}”(이)라고 들렸어요. 한 단어만 말해 볼까요?`;
    else if (note.kind === "wrong") noteText = note.heard ? `“${note.heard}”(이)라고 들렸어요. 다시 생각해 볼까요?` : "다시 생각해 볼까요?";
    else if (note.kind === "empty") noteText = "잘 안 들렸어요. 다시 말해 볼까요?";
    else if (note.kind === "silent") noteText = "소리가 안 들렸어요. 조금 더 크게 말해 볼까요?";
    else if (note.kind === "short") noteText = "너무 짧았어요. 🎤를 누르고 단어를 말한 뒤 다시 눌러요.";
    else if (note.kind === "fail") noteText = "잘 못 들었어요. 한 번 더 말해 볼까요?";
    else if (note.kind === "hidden") noteText = "화면을 떠나서 녹음을 멈췄어요. 다시 말해 볼까요?";
    else if (note.kind === "switched") noteText = note.messageKo;
  }

  return (
    <div className={s.wrap} data-testid="kid-speak-question" data-step={step} data-mode={inputMode}>
      <div className={s.topRow}>
        <p className="t-caption">
          {titleKo}
          {dayLabel && dayLabel !== titleKo ? ` · ${dayLabel}` : ""}
        </p>
        <p className={s.counter} aria-live="polite">
          {current + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>

      {/* 그림 + 영영 정의 — 한국어 뜻은 이 화면에 없다 */}
      <section className={s.card}>
        {word.emoji ? (
          <p className={s.emoji} aria-hidden>
            {word.emoji}
          </p>
        ) : null}
        <div className={s.defRow}>
          <p className={s.def} lang="en">
            {word.definitionEn}
          </p>
          <button
            type="button"
            className={s.speaker}
            onClick={() => speak(word.definitionEn, "en-US")}
            disabled={micBusy}
            aria-label="뜻 듣기"
            title="뜻 듣기"
          >
            🔊
          </button>
        </div>

        {/* 도움 — 첫 글자 → 글자 수 밑줄 → 정답 */}
        {h && !revealed && !good ? (
          <div className={s.hint} data-testid="kid-speak-hint">
            {h.cells ? (
              <p className={s.cells} lang="en" aria-label={`${h.first}로 시작하는 단어`}>
                {h.cells.map((c, i) => (
                  <span key={i} className={c.letter ? s.cell : s.cellGap}>
                    {c.ch === " " || (c.letter && c.ch === "_") ? "\u00a0" : c.ch}
                  </span>
                ))}
              </p>
            ) : (
              <p className={s.firstLetter}>
                <b lang="en">{h.first}</b>(으)로 시작해요
              </p>
            )}
          </div>
        ) : null}

        {revealed || good ? (
          <div className={`${s.answer} ${good ? s.answerGood : ""}`} data-testid="kid-speak-answer">
            <p className={s.answerWord} lang="en">
              {word.word}
            </p>
            <button type="button" className={s.speaker} onClick={sayAnswer} aria-label={`${word.word} 발음 듣기`}>
              🔊
            </button>
          </div>
        ) : null}
      </section>

      {/* 판정·안내 */}
      {good ? (
        <p className={`${s.feedback} ${s.feedbackGood}`} role="status">
          {outcome === "said" ? "정답이에요! 혼자 떠올렸어요 🎉" : "정답이에요! 잘했어요 🎉"}
        </p>
      ) : outcome === "revealed" ? (
        <p className={`${s.feedback} ${s.feedbackSoft}`} role="status">
          정답은 이 단어예요. 🔊 듣고 따라 말해 봐요!
        </p>
      ) : outcome && outcome.startsWith("self-") ? (
        <p className={`${s.feedback} ${s.feedbackSoft}`} role="status">
          {outcome === "self-good" ? "잘했어요! 🎉" : "괜찮아요, 다음에 또 만나요!"}
        </p>
      ) : noteText ? (
        <p className={s.note} role="status" data-testid="kid-speak-note">
          {noteText}
        </p>
      ) : null}

      {/* 조작 */}
      {outcome === null ? (
        inputMode === "mic" ? (
          <div className={s.controls}>
            <button
              type="button"
              className={`${s.micBtn} ${mic === "recording" ? s.micOn : ""}`}
              onClick={onMicTap}
              disabled={mic === "starting" || mic === "listening"}
              aria-pressed={mic === "recording"}
              data-testid="kid-speak-mic"
            >
              <span aria-hidden className={s.micIcon}>
                {mic === "recording" ? "⏹️" : "🎤"}
              </span>
              <span>
                {mic === "starting"
                  ? "마이크를 켜는 중…"
                  : mic === "recording"
                    ? `듣고 있어요 ${recSec}초 — 다 말하면 눌러요`
                    : mic === "listening"
                      ? "들어 보는 중…"
                      : "눌러서 말하기"}
              </span>
            </button>
            <div className={s.sideActions}>
              <button type="button" className="u-btn u-btn-secondary" onClick={hint} disabled={micBusy} data-testid="kid-speak-hint-btn">
                <span aria-hidden>💡</span> {step === 0 ? "힌트" : step === 1 ? "힌트 더" : "정답 보기"}
              </button>
              <button
                type="button"
                className={`u-btn u-btn-secondary ${s.smallBtn}`}
                onClick={() => switchToSelf("스스로 확인으로 바꿨어요 — 소리 내어 말해 보고 정답을 확인해요.")}
                disabled={mic === "listening"}
              >
                마이크 없이 하기
              </button>
            </div>
          </div>
        ) : revealed ? (
          <div className={s.selfJudge} role="group" aria-label="스스로 확인" data-testid="kid-speak-self-judge">
            <p className="t-caption">맞게 말했나요?</p>
            <div className={s.selfButtons}>
              <button type="button" className={s.selfBtn} onClick={() => judgeSelf("self-good")}>
                <span aria-hidden>😀</span> 말했어요
              </button>
              <button type="button" className={s.selfBtn} onClick={() => judgeSelf("self-unsure")}>
                <span aria-hidden>🤔</span> 헷갈렸어요
              </button>
              <button type="button" className={s.selfBtn} onClick={() => judgeSelf("self-miss")}>
                <span aria-hidden>😢</span> 몰랐어요
              </button>
            </div>
          </div>
        ) : (
          <div className={s.controls}>
            <p className="t-caption">소리 내어 말해 본 다음 정답을 확인해요.</p>
            <button type="button" className={`u-btn u-btn-primary ${s.bigBtn}`} onClick={revealSelf} data-testid="kid-speak-reveal">
              <span aria-hidden>👀</span> 정답 보기
            </button>
            <div className={s.sideActions}>
              {step < 2 ? (
                <button type="button" className="u-btn u-btn-secondary" onClick={hint} data-testid="kid-speak-hint-btn">
                  <span aria-hidden>💡</span> {step === 0 ? "힌트" : "힌트 더"}
                </button>
              ) : null}
              {micOk ? (
                <button
                  type="button"
                  className={`u-btn u-btn-secondary ${s.smallBtn}`}
                  onClick={() => {
                    setInputMode("mic");
                    setNote(null);
                  }}
                >
                  🎤 말로 하기
                </button>
              ) : null}
            </div>
          </div>
        )
      ) : null}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={next} disabled={outcome === null} data-testid="kid-speak-next">
          {current + 1 >= total ? "끝내기" : "다음 →"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop}>
          그만하기
        </button>
      </div>
    </div>
  );
}

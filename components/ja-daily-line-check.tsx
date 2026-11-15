"use client";

/**
 * components/ja-daily-line-check.tsx — 🗓️ 오늘의 일본어 회화 칸의 **🎤 핵심 문장 체크**(설계 §4 회화).
 *
 * 문장마다: 🔊 들어 보기 → 🎤 녹음(lib/mic-session — 탭 안에서 동기로) → 16kHz WAV로 줄여 `POST /api/japanese/daily/transcribe`
 * (기대 문장은 보내지 않는다 — 받아쓰기 무유도) → `judgeJaDailyLine`(lib/ja-daily-judge, alignJaReadAloud 재사용) →
 * ✓ 맞음(≥0.8) / 아깝다(≥0.5) / 다시 · 틀린 글자 강조 · 다시 말하기 · 넘어가기. **녹음은 저장하지 않는다**(메모리에서 보내고 버린다).
 *
 * 받아쓰기를 못 쓰면(501 키 없음·마이크 거부·미지원) 이 회차 내내 녹음 없이 "스스로 판정"(✓ 말했어요 = pass·정확도 null / 넘어가기)으로 간다.
 * 그 밖 실패(500·네트워크·시간 초과)는 그 문장만 — 다시 해 보거나 넘어간다. 모양은 엄마 발화 체크(components/mom-lesson-runner.tsx)와 같다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import type { JaDailyKaiwaCheck, JaDailyTranscribeResponse } from "@/lib/ja-daily-contract";
import type { JaDailyLine } from "@/lib/ja-daily-content";
import { JA_DAILY_VERDICT_KO, judgeJaDailyLine } from "@/lib/ja-daily-judge";
import type { JaReadDiff } from "@/lib/ja-speaking-score";
import { createMicKeeper, MIC_CHECK_GUM_TIMEOUT_MS, MIC_ERROR_KO, MicError, setAudioSessionPlayback, toWav16kMono, type MicKeeper, type MicRecording } from "@/lib/mic-session";
import { speak, stopSpeaking, unlockSpeechPlayback } from "@/lib/speech";
import { toeicAudioBaseType, toeicAudioFileName } from "@/lib/toeic-attempt-contract";
import { pauseAllMedia } from "@/components/ja-daily-media";

/** 녹음 자동 멈춤 */
const REC_MAX_MS = 15_000;
/** 이보다 짧으면 "잘 안 들렸어요" */
const REC_MIN_MS = 400;
/** 라우트 상한과 같은 1 MiB */
const AUDIO_MAX_BYTES = 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 15_000;
/** 문장이 바뀐 직후 연타 방지 */
const ADVANCE_GUARD_MS = 400;

type Phase =
  | { kind: "ready"; noticeKo: string | null }
  | { kind: "arming" }
  | { kind: "recording" }
  | { kind: "working" }
  | { kind: "result"; transcript: string; accuracy: number; verdict: "pass" | "close" | "retry"; diff: JaReadDiff | null }
  | { kind: "failed"; reasonKo: string };

const VERDICT_CLASS: Record<"pass" | "close" | "retry", string> = {
  pass: "border-accent bg-accent-soft text-accent-ink",
  close: "border-line-strong bg-surface-2 text-ink",
  retry: "border-danger bg-danger-soft text-danger",
};

/** 틀린 글자 강조 — 안 들린·다르게 들린 토큰에 표시 */
function DiffLine({ line, diff }: { line: JaDailyLine; diff: JaReadDiff | null }) {
  if (!diff) return <JaRuby tokens={line.tokens} className="text-xl" />;
  const bad = new Set([...diff.missing, ...diff.substituted.map((x) => x.expected)]);
  return (
    <span lang="ja" className="text-xl leading-loose">
      {line.tokens.map((t, i) =>
        bad.has(t.surface) ? (
          <mark key={i} className="rounded bg-danger-soft px-0.5 text-danger" data-testid="ja-daily-diff-bad">
            <JaRuby tokens={[t]} />
          </mark>
        ) : (
          <JaRuby key={i} tokens={[t]} />
        ),
      )}
    </span>
  );
}

export default function JaDailyLineCheck({ lines, onFinish }: { lines: JaDailyLine[]; onFinish: (checks: JaDailyKaiwaCheck[]) => void }) {
  const [ci, setCi] = useState(0);
  const [phase, setPhaseState] = useState<Phase>({ kind: "ready", noticeKo: null });
  const phaseRef = useRef<Phase>(phase);
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [offKo, setOffKo] = useState<string | null>(null);
  const checksRef = useRef<JaDailyKaiwaCheck[]>([]);
  const keeperRef = useRef<MicKeeper | null>(null);
  const recRef = useRef<MicRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const firstMicRef = useRef(true);
  const changedAtRef = useRef(0);
  const finishedRef = useRef(false);

  const halt = useCallback(() => {
    runRef.current += 1;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    recRef.current?.abort();
    recRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // 언마운트·숨김 — 녹음·요청·마이크를 놓는다
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        halt();
        keeperRef.current?.release();
        if (phaseRef.current.kind === "recording" || phaseRef.current.kind === "arming" || phaseRef.current.kind === "working") setPhase({ kind: "ready", noticeKo: "화면을 벗어나 녹음을 멈췄어요. 다시 눌러 주세요." });
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      halt();
      keeperRef.current?.release();
      keeperRef.current = null;
    };
  }, [halt, setPhase]);

  const cur = lines[ci] ?? null;

  const next = useCallback(
    (check: JaDailyKaiwaCheck) => {
      if (Date.now() - changedAtRef.current < ADVANCE_GUARD_MS) return;
      halt();
      stopSpeaking();
      checksRef.current = [...checksRef.current.filter((c) => c.lineId !== check.lineId), check];
      changedAtRef.current = Date.now();
      if (ci + 1 < lines.length) {
        setCi(ci + 1);
        setPhase(offKo ? { kind: "failed", reasonKo: offKo } : { kind: "ready", noticeKo: null });
      } else if (!finishedRef.current) {
        finishedRef.current = true;
        keeperRef.current?.release();
        onFinish(checksRef.current);
      }
    },
    [ci, lines.length, halt, offKo, onFinish, setPhase],
  );

  const fail = useCallback(
    (token: number, permanent: boolean, reasonKo: string) => {
      if (runRef.current !== token) return;
      if (permanent) setOffKo(reasonKo);
      setPhase({ kind: "failed", reasonKo });
    },
    [setPhase],
  );

  async function transcribe(token: number, blob: Blob, mimeType: string, line: JaDailyLine) {
    setPhase({ kind: "working" });
    let upload: Blob = blob;
    try {
      const wav = await toWav16kMono(blob);
      if (wav.blob.size <= AUDIO_MAX_BYTES) upload = wav.blob;
    } catch {
      /* 원본으로 */
    }
    if (runRef.current !== token) return;
    const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(mimeType);
    const name = toeicAudioFileName(type);
    if (!name || upload.size > AUDIO_MAX_BYTES) {
      fail(token, false, upload.size > AUDIO_MAX_BYTES ? "녹음이 너무 길어 받아쓰기를 못 했어요. 조금 짧게 다시 해 볼까요?" : "이 녹음 형식은 받아쓰기를 못 해요.");
      return;
    }
    const fd = new FormData();
    fd.append("audio", upload.type ? upload : new Blob([upload], { type }), name);
    const ac = new AbortController();
    abortRef.current = ac;
    const timer = window.setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS);
    let status = 0;
    let data: JaDailyTranscribeResponse | null = null;
    try {
      const res = await fetch("/api/japanese/daily/transcribe", { method: "POST", body: fd, signal: ac.signal });
      status = res.status;
      data = (await res.json().catch(() => null)) as JaDailyTranscribeResponse | null;
    } catch {
      data = null;
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === ac) abortRef.current = null;
    }
    if (runRef.current !== token) return;
    if (data && data.ok && typeof data.text === "string") {
      if (data.text.trim() === "") {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 한 번 더 말해 볼까요?" });
        return;
      }
      const j = judgeJaDailyLine(line.tokens, data.text);
      setPhase({ kind: "result", transcript: data.text, accuracy: j.accuracy, verdict: j.verdict, diff: j.diff });
      return;
    }
    if (status === 501) {
      fail(token, true, "받아쓰기를 쓸 수 없어요 — 녹음 없이 스스로 판정해 주세요.");
      return;
    }
    fail(token, false, status === 413 ? "녹음이 너무 길어요. 조금 짧게 다시 말해 주세요." : "받아쓰기를 하지 못했어요. 다시 해 보거나 넘어가세요.");
  }

  function finishRecording(token: number) {
    if (runRef.current !== token || phaseRef.current.kind !== "recording") return;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    const rec = recRef.current;
    recRef.current = null;
    const line = cur;
    setPhase({ kind: "working" });
    if (!rec || !line) {
      setPhase({ kind: "ready", noticeKo: "녹음이 멈춰 버렸어요. 한 번 더 눌러 주세요." });
      return;
    }
    void rec.stop().then((result) => {
      setAudioSessionPlayback();
      if (runRef.current !== token) return;
      if (!result || result.durationMs < REC_MIN_MS) {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 조금 더 길게 말해 볼까요?" });
        return;
      }
      void transcribe(token, result.blob, result.mimeType, line);
    });
  }

  /** 🎤 탭 — 녹음 중이면 멈추고, 아니면 시작(탭 안에서 동기로) */
  function onMic() {
    const k = phaseRef.current.kind;
    if (k === "recording") {
      finishRecording(runRef.current);
      return;
    }
    if (k !== "ready" && k !== "result") return;
    stopSpeaking();
    pauseAllMedia();
    unlockSpeechPlayback();
    halt();
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
      const permanent = !(e instanceof MicError) || e.kind === "denied" || e.kind === "unsupported" || e.kind === "no_device";
      fail(token, permanent, permanent ? `${msg} 녹음 없이 스스로 판정해 주세요.` : `${msg} 다시 눌러 보거나 넘어가세요.`);
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
            autoStopRef.current = window.setTimeout(() => finishRecording(token), REC_MAX_MS);
          },
          (e: unknown) => micFail(e),
        );
      })
      .catch((e: unknown) => micFail(e));
  }

  if (!cur) return null;
  const p = phase;
  const busy = p.kind === "arming" || p.kind === "working";
  return (
    <section className="u-card p-4" data-testid="ja-daily-check">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="t-section-title">🎤 핵심 문장 체크</p>
        <span className="t-caption text-ink-3">
          {ci + 1}/{lines.length}
        </span>
      </div>
      <p className="t-caption text-ink-3">문장을 듣고 그대로 말해 보세요. 글자 일치율로 봐요(발음·억양은 채점하지 않아요). 녹음은 저장하지 않아요.</p>
      <div className="mt-3 rounded-[var(--radius-box)] border border-line bg-surface-2 p-3">
        {p.kind === "result" ? <DiffLine line={cur} diff={p.diff} /> : <JaRuby tokens={cur.tokens} className="text-xl" />}
        <p className="t-caption mt-1 text-ink-2">{cur.ko}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="u-btn u-btn-secondary"
          disabled={p.kind === "recording" || busy}
          onClick={() => {
            pauseAllMedia();
            speak(cur.ja, "ja-JP");
          }}
        >
          🔊 듣기
        </button>
        {!offKo ? (
          <button type="button" className="u-btn u-btn-primary" onClick={onMic} disabled={busy || p.kind === "failed"} data-testid="ja-daily-mic">
            {p.kind === "recording" ? "⏹ 말하기 끝" : p.kind === "arming" ? "마이크 준비 중…" : p.kind === "working" ? "받아쓰는 중…" : p.kind === "result" ? "🎤 다시 말하기" : "🎤 말하기"}
          </button>
        ) : null}
      </div>

      {p.kind === "ready" && p.noticeKo ? <p className="t-caption mt-2 text-ink-2">{p.noticeKo}</p> : null}
      {p.kind === "recording" ? (
        <p className="t-caption mt-2 text-danger" role="status">
          ● 녹음 중 — 다 말했으면 ⏹를 누르세요
        </p>
      ) : null}

      {p.kind === "result" ? (
        <div className={`mt-3 rounded-[var(--radius-box)] border px-3 py-2 ${VERDICT_CLASS[p.verdict]}`} data-testid="ja-daily-verdict">
          <p className="font-bold">
            {p.verdict === "pass" ? "✓ " : ""}
            {JA_DAILY_VERDICT_KO[p.verdict]} · {Math.round(p.accuracy * 100)}%
          </p>
          <p className="t-caption mt-1 break-all" lang="ja">
            들린 말: {p.transcript}
          </p>
        </div>
      ) : null}

      {p.kind === "failed" ? (
        <p className="t-caption mt-3 text-ink-2" role="status" data-testid="ja-daily-check-off">
          {p.reasonKo}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {p.kind === "result" ? (
          <button type="button" className="u-btn u-btn-primary" onClick={() => next({ lineId: cur.id, accuracy: p.accuracy, verdict: p.verdict, transcript: p.transcript.slice(0, 400) })}>
            다음 문장 →
          </button>
        ) : null}
        {p.kind === "failed" ? (
          <>
            <button type="button" className="u-btn u-btn-primary" onClick={() => next({ lineId: cur.id, accuracy: null, verdict: "pass", transcript: null })} data-testid="ja-daily-self-pass">
              ✓ 말했어요
            </button>
            {!offKo ? (
              <button type="button" className="u-btn u-btn-secondary" onClick={() => setPhase({ kind: "ready", noticeKo: null })}>
                다시 해 보기
              </button>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="u-btn u-btn-secondary"
          disabled={p.kind === "recording" || busy}
          onClick={() =>
            // 결과를 보고 넘어가도 잰 정확도는 남긴다 — 약한 과 순위(pickWeakLessons)가 정확도만 본다(QA daily-full P3-2)
            next({ lineId: cur.id, accuracy: p.kind === "result" ? p.accuracy : null, verdict: "skipped", transcript: p.kind === "result" ? p.transcript.slice(0, 400) : null })
          }
          data-testid="ja-daily-check-skip"
        >
          넘어가기
        </button>
      </div>
    </section>
  );
}

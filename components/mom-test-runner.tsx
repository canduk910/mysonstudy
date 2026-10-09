"use client";

/**
 * 엄마의 생활영어 주간 테스트 진행·결과(설계 §5).
 *
 * - 문항마다 **한국어 뜻만** 보여 주고 🎤로 말한다(정답·판정은 테스트 중에 보이지 않는다 — 끝 화면에서 한꺼번에).
 * - 녹음이 끝나면 ① 기기에 보관(lib/toeic-rec-store, 풀 "mom" — 서버에 올리지 않는다, 풀마다 최근 5회분) ② 받아쓰기(`/api/mom/transcribe` —
 *   녹음만 보낸다, 정답 문장은 보내지 않는다) → `judgeMomSpeech`. 받아쓰기를 못 하면 verdict skipped, recorded true(녹음은 남는다).
 *   501(키 없음)이면 이 테스트 내내 받아쓰기를 건너뛰고 녹음만 한다. 마이크 거부·지원 안 함이면 "넘어가기"만.
 * - **끝까지 했을 때만 저장한다** — `POST /api/mom/tests`(id는 마운트 때 정하고 다시 보내도 같다 — 서버 멱등) → 이어서
 *   `POST /api/mom/tests/{id}/summary`(AI 총평 — 실패해도 결과 화면은 보인다) → STREAK_REFRESH_EVENT. 중간에 나가면 기록 없음.
 * - 결과: 맞음 n/전체, 문항별 판정·들린 말·정답, **내 녹음 ▶**(이 기기 사본 — 미리 objectURL로 받아 탭 안에서 동기로 play) /
 *   **원어민 ▶**(speakQueue en-US), AI 총평 두 줄(없으면 숨김).
 * - 소리는 이 화면이 연 큐·요소만 멈춘다(전역 stopSpeaking 금지). 마이크는 언마운트에서 놓는다. 녹음 흐름은 하루 레슨(mom-lesson-runner)과 같다.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOM_VERDICT_KO, type MomTestItem, type MomTestRecord, type MomVerdict } from "@/lib/mom-contract";
import { judgeMomSpeech } from "@/lib/mom-judge";
import { createMicKeeper, MIC_CHECK_GUM_TIMEOUT_MS, MIC_ERROR_KO, MicError, setAudioSessionPlayback, toWav16kMono, type MicKeeper, type MicRecording } from "@/lib/mic-session";
import { speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { toeicAudioBaseType, toeicAudioFileName } from "@/lib/toeic-attempt-contract";
import { getToeicRecording, saveToeicRecording } from "@/lib/toeic-rec-store";

type Stage = 0 | 1 | 2 | 3 | 4;
export interface MomTestRunnerItem { id: string; en: string; ko: string; frameText: string }
export interface MomTestRunnerProps {
  week: number;
  stage: Stage;
  items: MomTestRunnerItem[];
  /** 이미 끝낸 테스트 — 있으면 결과 화면부터 */
  saved: MomTestRecord | null;
}

type Phase =
  | { kind: "ready"; noticeKo: string | null }
  | { kind: "arming" }
  | { kind: "recording" }
  | { kind: "working" }
  | { kind: "captured"; noteKo: string | null }
  | { kind: "micOff"; reasonKo: string };
type Mode = "test" | "saving" | "saveError" | "result";
type Summary = { kind: "loading" } | { kind: "none" } | { kind: "ok"; goodKo: string; fixKo: string };

const EN = "en-US";
/** 녹음 자동 멈춤(ms) — 받아쓰기 업로드 상한(1 MiB ≈ 20초 WAV) 안 */
const MOM_REC_MAX_MS = 15_000;
/** 이보다 짧으면 "잘 안 들렸어요" */
const MOM_REC_MIN_MS = 400;
/** 받아쓰기 요청 기다림 상한(ms) */
const MOM_TRANSCRIBE_TIMEOUT_MS = 15_000;
/** 총평 요청 기다림 상한(ms) — 넘으면 총평 없이 */
const MOM_SUMMARY_CLIENT_TIMEOUT_MS = 50_000;
const MOM_AUDIO_MAX_BYTES = 1024 * 1024;
const BIG = { minHeight: 56 } as const;
/** 문항이 바뀐 직후 이 시간 동안은 넘어가기·다음 문제를 받지 않는다(빠른 두 번 탭이 두 문항을 건너뛰지 않게) */
const ADVANCE_GUARD_MS = 400;

function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 보안 컨텍스트 밖(http LAN) — 아래로 */
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function badgeOf(v: MomVerdict): string {
  return v === "pass" ? "✅" : v === "close" ? "🙂" : v === "retry" ? "🔁" : "⏭️";
}

export default function MomTestRunner({ week, items, saved }: MomTestRunnerProps) {
  const [mode, setMode] = useState<Mode>(saved ? "result" : "test");
  const [record, setRecord] = useState<MomTestRecord | null>(saved);
  const [summary, setSummary] = useState<Summary>(saved?.summaryKo ? { kind: "ok", ...saved.summaryKo } : { kind: "none" });

  // ── 진행 ──
  const [qi, setQi] = useState(0);
  const [phase, setPhaseState] = useState<Phase>({ kind: "ready", noticeKo: null });
  const phaseRef = useRef<Phase>(phase);
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  /** 501 — 이 테스트 내내 받아쓰기를 건너뛰고 녹음만 */
  const transcribeOffRef = useRef(false);
  /** 마이크 거부 등 — 이 테스트 내내 넘어가기만 */
  const [micOff, setMicOff] = useState<string | null>(null);
  const outcomesRef = useRef(new Map<number, MomTestItem>());
  const recordedRef = useRef(new Set<number>());

  // ── 저장 ──
  const idRef = useRef<string>(saved?.id ?? "");
  const startedAtRef = useRef<string>(saved?.startedAt ?? "");
  const finishedAtRef = useRef<string | null>(saved?.finishedAt ?? null);

  // ── 손잡이 ──
  const stopRef = useRef<(() => void) | null>(null);
  const keeperRef = useRef<MicKeeper | null>(null);
  const recRef = useRef<MicRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const firstMicRef = useRef(true);
  const aliveRef = useRef(true);
  /** 마지막으로 문항이 바뀐 시각 — 연타 방지. 다시 그리지 않는다 */
  const changedAtRef = useRef(0);

  // ── 결과 화면 재생 ──
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [recUrls, setRecUrls] = useState<Record<number, string | null> | null>(null);
  const urlsRef = useRef<string[]>([]);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playErr, setPlayErr] = useState<Record<number, string>>({});

  useEffect(() => {
    aliveRef.current = true;
    if (!idRef.current) idRef.current = newClientId();
    if (!startedAtRef.current) startedAtRef.current = new Date().toISOString();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const stopSound = useCallback(() => {
    const st = stopRef.current;
    stopRef.current = null;
    st?.();
    const a = audioRef.current;
    if (a) a.pause();
    setPlayingKey(null);
  }, []);

  const haltAsync = useCallback(() => {
    runRef.current += 1;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    recRef.current?.abort();
    recRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // 언마운트 — 소리·녹음·요청·마이크 정리. 저장은 하지 않는다(중간에 나가면 기록 없음 — 기기 녹음은 풀 정리가 지운다).
  useEffect(() => {
    return () => {
      haltAsync();
      stopRef.current?.();
      stopRef.current = null;
      audioRef.current?.pause();
      keeperRef.current?.release();
      keeperRef.current = null;
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, [haltAsync]);

  // 결과 화면 — 이 기기 녹음을 미리 objectURL로(탭 안에서 await하지 않게 — iOS 재생 규칙)
  useEffect(() => {
    if (mode !== "result" || !record) return;
    let alive = true;
    void (async () => {
      const out: Record<number, string | null> = {};
      for (let q = 0; q < record.items.length; q++) {
        const r = await getToeicRecording(record.id, q);
        if (r && r.blob.size > 0) {
          const u = URL.createObjectURL(r.blob);
          urlsRef.current.push(u);
          out[q] = u;
        } else out[q] = null;
      }
      if (alive) setRecUrls(out);
    })();
    return () => {
      alive = false;
    };
  }, [mode, record]);

  // ── 저장·총평 ──
  const requestSummary = useCallback(async (id: string) => {
    setSummary({ kind: "loading" });
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), MOM_SUMMARY_CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/mom/tests/${encodeURIComponent(id)}/summary`, { method: "POST", signal: ac.signal });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; summaryKo?: { goodKo?: unknown; fixKo?: unknown } } | null;
      if (!aliveRef.current) return;
      const s = data?.ok ? data.summaryKo : null;
      if (s && typeof s.goodKo === "string" && typeof s.fixKo === "string") setSummary({ kind: "ok", goodKo: s.goodKo, fixKo: s.fixKo });
      else setSummary({ kind: "none" });
    } catch {
      if (aliveRef.current) setSummary({ kind: "none" });
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  const save = useCallback(async () => {
    if (!idRef.current) idRef.current = newClientId();
    if (!startedAtRef.current) startedAtRef.current = new Date().toISOString();
    if (!finishedAtRef.current) finishedAtRef.current = new Date().toISOString();
    const body = {
      id: idRef.current,
      week,
      startedAt: startedAtRef.current,
      finishedAt: finishedAtRef.current,
      items: items.map(
        (it, q): MomTestItem => outcomesRef.current.get(q) ?? { sentenceId: it.id, verdict: "skipped", transcript: null, recorded: recordedRef.current.has(q) },
      ),
    };
    setMode("saving");
    try {
      const res = await fetch("/api/mom/tests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !data?.ok) throw new Error(`save ${res.status}`);
      if (!aliveRef.current) return;
      setRecord({ ...body, summaryKo: null });
      setMode("result");
      window.scrollTo({ top: 0 });
      window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
      void requestSummary(body.id);
    } catch {
      if (aliveRef.current) setMode("saveError");
    }
  }, [week, items, requestSummary]);

  // ── 진행 ──
  const cur = items[qi] ?? null;

  const goNext = useCallback(() => {
    if (Date.now() - changedAtRef.current < ADVANCE_GUARD_MS) return; // 연타 — 같은 자리의 다음 버튼이 두 번째 탭을 받지 않게
    haltAsync();
    stopSound();
    if (qi + 1 < items.length) {
      changedAtRef.current = Date.now();
      setQi(qi + 1);
      setPhase(micOff ? { kind: "micOff", reasonKo: micOff } : { kind: "ready", noticeKo: null });
      window.scrollTo({ top: 0 });
    } else void save();
  }, [haltAsync, stopSound, qi, items.length, setPhase, micOff, save]);

  /** 넘어가기 — 이 문항 결과가 없으면 skipped(녹음했으면 recorded true) */
  const skip = useCallback(() => {
    if (!cur || Date.now() - changedAtRef.current < ADVANCE_GUARD_MS) return;
    if (!outcomesRef.current.has(qi)) outcomesRef.current.set(qi, { sentenceId: cur.id, verdict: "skipped", transcript: null, recorded: recordedRef.current.has(qi) });
    goNext();
  }, [cur, qi, goNext]);

  async function transcribe(token: number, q: number, blob: Blob, mimeType: string, it: MomTestRunnerItem) {
    const skipped = (noteKo: string) => {
      outcomesRef.current.set(q, { sentenceId: it.id, verdict: "skipped", transcript: null, recorded: true });
      setPhase({ kind: "captured", noteKo });
    };
    if (transcribeOffRef.current) {
      skipped("받아쓰기는 지금 못 해요 — 녹음은 남았어요.");
      return;
    }
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
      skipped(upload.size > MOM_AUDIO_MAX_BYTES ? "녹음이 너무 길어 받아쓰기를 못 했어요 — 녹음은 남았어요." : "받아쓰기를 못 했어요 — 녹음은 남았어요.");
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
      const judge = judgeMomSpeech({ en: it.en, frameText: it.frameText, transcript: data.text });
      if (judge.noSpeech) {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 한 번 더 말해 볼까요?" });
        return;
      }
      outcomesRef.current.set(q, { sentenceId: it.id, verdict: judge.verdict, transcript: data.text.slice(0, 400), recorded: true });
      setPhase({ kind: "captured", noteKo: null });
      return;
    }
    // 501 = 키 없음(이 테스트 내내 녹음만) / 500·네트워크·시간 초과 = 이번 문항만
    if (status === 501) transcribeOffRef.current = true;
    skipped("받아쓰기를 못 해서 이 문제는 '넘어감'으로 남아요 — 녹음은 남았어요.");
  }

  function finishRecording(token: number) {
    if (runRef.current !== token || phaseRef.current.kind !== "recording") return;
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    const rec = recRef.current;
    recRef.current = null;
    const it = cur;
    const q = qi;
    setPhase({ kind: "working" });
    if (!rec || !it) {
      setPhase({ kind: "ready", noticeKo: "녹음이 멈춰 버렸어요. 한 번 더 눌러 주세요." });
      return;
    }
    void rec.stop().then(async (result) => {
      setAudioSessionPlayback(); // 다음 소리가 수화기로 가지 않게
      if (runRef.current !== token) return;
      if (!result || result.durationMs < MOM_REC_MIN_MS) {
        setPhase({ kind: "ready", noticeKo: "잘 안 들렸어요. 조금 더 길게 말해 볼까요?" });
        return;
      }
      // ① 기기 보관(던지지 않는다 — IndexedDB가 안 되면 이 탭 메모리에만)
      await saveToeicRecording({
        attemptId: idRef.current,
        pool: "mom",
        q,
        blob: result.blob,
        mimeType: result.mimeType,
        durationMs: result.durationMs,
        size: result.blob.size,
        createdAt: Date.now(),
        retakeId: null,
      });
      recordedRef.current.add(q);
      outcomesRef.current.delete(q); // 다시 말하기 — 앞 결과는 버린다
      if (runRef.current !== token) return;
      // ② 받아쓰기 → 판정
      void transcribe(token, q, result.blob, result.mimeType, it);
    });
  }

  /** 🎤 탭 — 녹음 중이면 멈추고, 아니면 시작 */
  function onMic() {
    const k = phaseRef.current.kind;
    if (k === "recording") {
      finishRecording(runRef.current);
      return;
    }
    if (k !== "ready" && k !== "captured") return;
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
      // 권한 거부·지원 안 함·마이크 없음은 이 테스트 내내 그대로 — 그 밖(응답 없음·사용 중)은 다시 해 볼 수 있다
      const permanent = !(e instanceof MicError) || e.kind === "denied" || e.kind === "unsupported" || e.kind === "no_device";
      if (permanent) {
        const reason = `${msg} 이번 테스트는 넘어가기로 끝낼 수 있어요.`;
        setMicOff(reason);
        setPhase({ kind: "micOff", reasonKo: reason });
      } else setPhase({ kind: "ready", noticeKo: `${msg} 한 번 더 눌러 주세요.` });
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

  // ── 결과 화면 재생(탭 안에서 동기로) ──
  function playMine(q: number) {
    const url = recUrls?.[q];
    const a = audioRef.current;
    if (!url || !a) return;
    stopSound();
    a.src = url;
    setPlayingKey(`me:${q}`);
    setPlayErr((p) => ({ ...p, [q]: "" }));
    void a.play().catch(() => {
      setPlayingKey(null);
      setPlayErr((p) => ({ ...p, [q]: "이 기기에서 이 녹음을 재생하지 못했어요." }));
    });
  }
  function playNative(q: number, en: string) {
    stopSound();
    unlockSpeechPlayback();
    setPlayingKey(`tts:${q}`);
    stopRef.current = speakQueue([{ text: en, lang: EN }], { onEnd: () => setPlayingKey(null) });
  }

  // ───────────────────────── 화면 ─────────────────────────

  if (mode === "saving" || mode === "saveError") {
    return (
      <section className="u-card mt-4 p-6 text-center">
        {mode === "saveError" ? (
          <>
            <p className="t-section-title">기록을 저장하지 못했어요</p>
            <p className="t-body mt-2 text-ink-2">인터넷을 확인하고 다시 눌러 주세요.</p>
            <button type="button" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG} onClick={() => void save()}>
              다시 저장하기
            </button>
          </>
        ) : (
          <p className="t-section-title">결과를 저장하고 있어요…</p>
        )}
      </section>
    );
  }

  if (mode === "result" && record) {
    const pass = record.items.filter((i) => i.verdict === "pass").length;
    return (
      <div className="mt-4">
        <audio ref={audioRef} preload="none" onEnded={() => setPlayingKey(null)} className="hidden" />
        <section className="u-card p-5 text-center">
          <p className="t-caption text-ink-3">맞음</p>
          <p className="text-4xl font-bold">
            {pass} / {record.items.length}
          </p>
          <p className="t-body mt-2 text-ink-2">끝까지 해냈어요! 내 녹음과 원어민 소리를 비교해 봐요.</p>
        </section>

        {summary.kind === "loading" ? <p className="t-caption mt-3 text-center text-ink-3">AI 총평을 쓰고 있어요…</p> : null}
        {summary.kind === "ok" ? (
          <section className="u-card mt-3 p-5">
            <p className="t-caption text-ink-3">AI 총평</p>
            <p className="t-body mt-2">👍 {summary.goodKo}</p>
            <p className="t-body mt-2">🎯 {summary.fixKo}</p>
          </section>
        ) : null}

        <ol className="mt-3 space-y-3">
          {record.items.map((it, q) => {
            const item = items[q];
            const url = recUrls?.[q] ?? null;
            return (
              <li key={`${it.sentenceId}-${q}`} className="u-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="t-body text-ink-2">
                    {q + 1}. {item?.ko ?? ""}
                  </p>
                  <span className="shrink-0 text-lg font-bold">
                    {badgeOf(it.verdict)} {MOM_VERDICT_KO[it.verdict]}
                  </span>
                </div>
                {item?.en ? (
                  <p className="mt-2 text-xl font-semibold" lang="en">
                    {item.en}
                  </p>
                ) : null}
                {it.transcript ? <p className="t-caption mt-1 text-ink-3">들린 말: {it.transcript}</p> : null}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {url ? (
                    <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} onClick={() => playMine(q)}>
                      {playingKey === `me:${q}` ? "🔊 내 녹음…" : "내 녹음 ▶"}
                    </button>
                  ) : (
                    <p className="t-caption self-center text-center text-ink-3">
                      {recUrls === null ? "녹음 찾는 중…" : it.recorded ? "이 기기에 녹음이 없어요" : "녹음 안 함"}
                    </p>
                  )}
                  <button type="button" className="u-btn u-btn-secondary text-lg" style={BIG} disabled={!item?.en} onClick={() => item && playNative(q, item.en)}>
                    {playingKey === `tts:${q}` ? "🔊 원어민…" : "원어민 ▶"}
                  </button>
                </div>
                {playErr[q] ? <p className="t-caption mt-2 text-ink-3">{playErr[q]}</p> : null}
              </li>
            );
          })}
        </ol>

        <Link href="/mom" className="u-btn u-btn-primary mt-6 w-full text-lg" style={BIG}>
          홈으로
        </Link>
      </div>
    );
  }

  if (!cur) return null;
  return (
    <div className="mt-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="t-section-title">
          문제 {qi + 1}/{items.length}
        </p>
        <div className="flex gap-1" aria-hidden>
          {items.map((it, i) => (
            <span key={`${it.id}-${i}`} className={`h-2 w-4 rounded-full ${i <= qi ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>
      </div>
      <section className="u-card p-5">
        <p className="t-caption text-ink-3">영어로 말해 봐요 (정답은 끝나고 보여 줘요)</p>
        <p className="mt-3 text-2xl font-bold leading-relaxed">{cur.ko}</p>

        {phase.kind === "micOff" ? (
          <div className="mt-4">
            <p className="t-body text-ink-2">{phase.reasonKo}</p>
            <button type="button" className="u-btn u-btn-primary mt-4 w-full text-lg" style={BIG} onClick={skip}>
              넘어가기
            </button>
          </div>
        ) : phase.kind === "captured" ? (
          <div className="mt-4">
            <p className="text-xl font-bold">✓ 녹음했어요</p>
            {phase.noteKo ? <p className="t-body mt-2 text-ink-2">{phase.noteKo}</p> : null}
            <button type="button" className="u-btn u-btn-primary mt-4 w-full text-lg" style={BIG} onClick={goNext}>
              {qi + 1 < items.length ? "다음 문제" : "결과 보기"}
            </button>
            <button type="button" className="u-btn u-btn-secondary mt-3 w-full text-lg" style={BIG} onClick={onMic}>
              🎤 다시 말하기
            </button>
          </div>
        ) : (
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
              <button type="button" className="u-btn u-btn-secondary mt-4 w-full text-lg" style={BIG} onClick={skip}>
                넘어가기
              </button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

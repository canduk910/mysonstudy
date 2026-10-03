"use client";

/**
 * 표현 도우미(간이 챗봇) — 한국어 단어·문장 → 가장 회화적인 표현 + 예문 (SPEC §22, docs/harness/phrase-helper.md §13)
 *
 * 루트 레이아웃이 한 번 마운트하는 **호스트**다. 지금 경로가 정하는 모드(lib/phrase-helper-scope.ts)에서만 버튼을 띄운다 —
 * 아빠의 영어 `toeic` · 아빠의 일본어 `japanese` · 은우 영어 `english-kid`. 홈·수학·운동에는 없다.
 *
 * ── 시험 중에는 없다(사용자 핵심 요구) ──────────────────────────────────────────
 * 시험 경로(isPhraseHelperExamPath)이거나 시험 화면이 블록을 건 동안(usePhraseHelperBlock — 자유대화 통화 오버레이·각 시험 러너)
 * 호스트는 **아무것도 그리지 않는다**. 위젯이 언마운트되며 정리가 돈다: 진행 중 물어보기·전사 요청 abort(서버 499 — 상류도 멈춘다),
 * 녹음 abort(트랙 stop → 세션 playback), 도우미가 튼 🔊만 멈춤(speakQueue의 자기 손잡이 — 시험 화면 소리는 건드리지 않는다).
 * 열려 있던 패널은 닫힌 상태로 기억한다(시험이 끝나도 저절로 다시 열리지 않는다).
 *
 * ── 모양 ─────────────────────────────────────────────────────────────────────
 * 닫힘: 오른쪽 아래 떠 있는 버튼. 열림: lg↑(Mac·iPad 가로) 오른쪽 도킹 패널(본문을 패널 폭만큼 민다 — 가리지 않는다, globals.css),
 * lg 미만(폰) 아래 시트 + 스크림. 열림 상태는 넓은 화면에서만 기기에 기억한다(localStorage — 편의, 없거나 막혀도 동작).
 * 입력 칸 → [물어보기] → 결과 카드(새것이 위). 기록은 저장하지 않는다 — 이 탭 메모리(모드별 최근 20개, 화면 이동 사이에는 남는다).
 *
 * ── 비용 ─────────────────────────────────────────────────────────────────────
 * 사람이 누를 때만 부른다(자동 완성·프리페치 없음). 한글이 없는 입력은 화면이 로컬 안내로 끝낸다(요청 0). 대기 중 보내기 잠금.
 * 🔊는 탭할 때만 speakQueue(프리페치 금지). 마이크: 🎤 탭 → 녹음(lib/mic-session startRecording — 권한 대기 상한·세션 전환·끝나면 트랙
 * stop) → 다시 탭하면 끝(30초 자동 끝) → 짧거나 무음이면 올리지 않음 → 전사 → **입력 칸에 채우기만**(자동 전송 없음).
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MIC_ERROR_KO,
  MicError,
  getLiveRecordingOwners,
  startRecording,
  subscribeMicRecording,
  toWav16kMono,
  type MicRecording,
} from "@/lib/mic-session";
import {
  PHRASE_HELPER_INPUT_MAX,
  PHRASE_HELPER_JA_REGISTER_LABELS_KO,
  normalizePhraseHelperInput,
  phraseHelperCharCount,
  phraseHelperLocalResult,
  phraseHelperSpeechLang,
  type PhraseHelperJaRegister,
  type PhraseHelperMode,
  type PhraseHelperResult,
} from "@/lib/phrase-helper";
import {
  PHRASE_HELPER_AUDIO_FIELD,
  PHRASE_HELPER_CLIENT_TIMEOUT_MS,
  PHRASE_HELPER_ENDPOINT,
  PHRASE_HELPER_REC_MAX_MS,
  PHRASE_HELPER_REC_MIN_MS,
  PHRASE_HELPER_SILENCE_LEVEL,
  PHRASE_HELPER_TRANSCRIBE_CLIENT_TIMEOUT_MS,
  PHRASE_HELPER_TRANSCRIBE_ENDPOINT,
  type PhraseHelperRequest,
  type PhraseHelperResponse,
  type PhraseHelperTranscribeResponse,
} from "@/lib/phrase-helper-contract";
import { getPhraseHelperBlockCount, phraseHelperVisibility, subscribePhraseHelperBlock } from "@/lib/phrase-helper-scope";
import { speakQueue } from "@/lib/speech";
import s from "./phrase-helper.module.css";

// ---------------------------------------------------------------------------
// 문구 — 아빠(성인)와 은우(1학년) 두 톤
// ---------------------------------------------------------------------------

interface Copy {
  fab: string;
  title: string;
  lead: string;
  placeholder: string;
  send: string;
  sending: string;
  empty: string;
  retry: string;
  noKeyKo: string;
  failKo: string;
  lockedKo: string;
  micStart: string;
  micStop: string;
  micRecordingKo: (sec: number) => string;
  micTranscribingKo: string;
  micFilledKo: string;
  micEmptyKo: string;
  micShortKo: string;
  micSilentKo: string;
  micFailKo: string;
  micNoKeyKo: string;
  micHiddenKo: string;
  micMovedKo: string;
  micBusyKo: string;
  micPreemptedKo: string;
  micDeniedKo: (e: MicError) => string;
  examplesHead: string;
  altHead: string;
}

const ADULT_BASE = {
  send: "물어보기",
  sending: "묻는 중…",
  empty: "물어본 표현이 여기에 쌓여요(저장하지 않아요).",
  retry: "다시 물어보기",
  noKeyKo: "OpenAI API 키가 설정되지 않아 지금은 쓸 수 없어요.",
  failKo: "답을 받지 못했어요. 다시 물어봐 주세요.",
  lockedKo: "잠금이 풀려 있지 않아요 — 새로고침한 뒤 PIN을 넣어 주세요.",
  micStart: "🎤",
  micStop: "■",
  micRecordingKo: (sec: number) => `● 듣는 중 ${sec}초 — ■를 누르면 끝나요(최대 30초)`,
  micTranscribingKo: "받아 적는 중…",
  micFilledKo: "받아 적었어요 — 고칠 곳을 고친 뒤 [물어보기]를 눌러 주세요.",
  micEmptyKo: "소리가 잘 안 들렸어요. 다시 말해 주세요.",
  micShortKo: "너무 짧아요. 🎤를 누르고 말한 뒤 ■를 눌러 주세요.",
  micSilentKo: "소리가 안 들렸어요. 마이크 가까이에서 다시 말해 주세요.",
  micFailKo: "말을 글자로 바꾸지 못했어요. 다시 말하거나 글자로 넣어 주세요.",
  micNoKeyKo: "OpenAI API 키가 설정되지 않아 말로 넣기를 쓸 수 없어요. 글자로 넣어 주세요.",
  micHiddenKo: "화면을 벗어나 녹음을 멈췄어요.",
  micMovedKo: "화면을 옮겨 녹음을 멈췄어요(받아 적지 않았어요).",
  micBusyKo: "화면의 다른 녹음이 진행 중이에요. 그 녹음이 끝난 뒤 🎤를 눌러 주세요.",
  micPreemptedKo: "화면의 다른 녹음이 시작돼 도우미 녹음을 멈췄어요.",
  micDeniedKo: (e: MicError) => MIC_ERROR_KO[e.kind],
  examplesHead: "예문",
  altHead: "다른 표현",
};

const COPY: Readonly<Record<PhraseHelperMode, Copy>> = {
  toeic: {
    ...ADULT_BASE,
    fab: "표현 도우미",
    title: "표현 도우미",
    lead: "한국어 단어·문장을 넣으면 가장 자연스러운 영어 표현과 예문을 알려 드려요.",
    placeholder: "예: 회의를 다음 주로 미루다",
  },
  japanese: {
    ...ADULT_BASE,
    fab: "표현 도우미",
    title: "표현 도우미",
    lead: "한국어 단어·문장을 넣으면 가장 자연스러운 일본어 표현과 읽기·말투·예문을 알려 드려요.",
    placeholder: "예: 잠깐만 기다려 주세요",
  },
  "english-kid": {
    fab: "영어로 뭐라고?",
    title: "영어로 뭐라고 해요?",
    lead: "한글로 적거나 🎤로 말하면 영어로 바꿔 줄게요!",
    placeholder: "예: 나 이거 좋아해",
    send: "바꿔 줘!",
    sending: "바꾸는 중…",
    empty: "궁금한 말을 적어 봐요.",
    retry: "다시 해 보기",
    noKeyKo: "지금은 도우미가 쉬고 있어요. 엄마 아빠에게 말해 줘요.",
    failKo: "답을 못 받았어요. 다시 해 볼까요?",
    lockedKo: "엄마 아빠에게 잠금을 풀어 달라고 해 줘요.",
    micStart: "🎤",
    micStop: "■",
    micRecordingKo: () => "● 듣고 있어요 — 다 말했으면 ■를 눌러요",
    micTranscribingKo: "글자로 바꾸는 중…",
    micFilledKo: "글자로 바꿨어요! 맞으면 [바꿔 줘!]를 눌러요.",
    micEmptyKo: "잘 안 들렸어요. 다시 말해 볼까요?",
    micShortKo: "조금 더 길게 말해 볼까요?",
    micSilentKo: "소리가 안 들렸어요. 조금 더 크게 말해 볼까요?",
    micFailKo: "글자로 못 바꿨어요. 다시 말해 볼까요?",
    micNoKeyKo: "지금은 말로 넣을 수 없어요. 글자로 적어 줘요.",
    micHiddenKo: "녹음을 멈췄어요.",
    micMovedKo: "다른 화면으로 가서 녹음을 멈췄어요.",
    micBusyKo: "지금은 다른 녹음을 하고 있어요. 끝나면 다시 눌러 줘요.",
    micPreemptedKo: "다른 녹음이 시작돼서 멈췄어요.",
    micDeniedKo: () => "마이크를 쓸 수 없어요. 글자로 적어 줘요.",
    examplesHead: "이렇게 말해요",
    altHead: "이렇게도 말해요",
  },
};

// ---------------------------------------------------------------------------
// 이 탭의 기록(저장하지 않는다) · 열림 기억(넓은 화면 편의)
// ---------------------------------------------------------------------------

interface Entry {
  id: number;
  result: PhraseHelperResult;
}
/** 모드별 최근 기록 — 모듈 메모리(새로고침하면 사라진다). 시험 화면을 오가며 위젯이 다시 마운트돼도 남는다 */
const sessionEntries = new Map<PhraseHelperMode, Entry[]>();
let entrySeq = 0;
const ENTRY_KEEP = 20;

const OPEN_PREF_KEY = "phrase-helper-open:v1";
/** lib/mic-session 공유 신호에 싣는 도우미 녹음의 이름 */
const PHRASE_HELPER_MIC_OWNER = "phrase-helper";
/** 폰 버튼 — 이 높이보다 위면 늘 보인다 */
const FAB_REVEAL_TOP_PX = 80;
const WIDE_QUERY = "(min-width: 1024px)";

function readOpenPref(): boolean {
  try {
    return window.localStorage.getItem(OPEN_PREF_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOpenPref(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_PREF_KEY, open ? "1" : "0");
  } catch {
    /* 막힌 저장소 — 기억만 못 한다 */
  }
}
function isWide(): boolean {
  try {
    return window.matchMedia(WIDE_QUERY).matches;
  } catch {
    return false;
  }
}

function audioFileName(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  if (base.includes("wav") || base.includes("wave")) return "speech.wav";
  if (base === "audio/mp4") return "speech.mp4";
  if (base.includes("m4a")) return "speech.m4a";
  return "speech.webm";
}

// ---------------------------------------------------------------------------
// 호스트 — 경로·블록으로 띄울지 정한다
// ---------------------------------------------------------------------------

export default function PhraseHelperHost() {
  const pathname = usePathname();
  const blockCount = useSyncExternalStore(subscribePhraseHelperBlock, getPhraseHelperBlockCount, () => 0);
  const vis = phraseHelperVisibility({ pathname, blockCount });

  // 시험이 시작되면 열려 있던 패널을 닫힌 것으로 기억한다(끝나도 저절로 다시 열리지 않게)
  useEffect(() => {
    if (vis.blocked) writeOpenPref(false);
  }, [vis.blocked]);

  if (vis.show === null) return null;
  return <PhraseHelperWidget key={vis.show} mode={vis.show} />;
}

// ---------------------------------------------------------------------------
// 위젯
// ---------------------------------------------------------------------------

type MicState = "idle" | "starting" | "recording" | "transcribing";

function PhraseHelperWidget({ mode }: { mode: PhraseHelperMode }) {
  const copy = COPY[mode];
  const kid = mode === "english-kid";
  const lang = phraseHelperSpeechLang(mode);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>(() => sessionEntries.get(mode) ?? []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ messageKo: string; retryInput: string | null } | null>(null);
  const [mic, setMicState] = useState<MicState>("idle");
  const [micNote, setMicNote] = useState<string | null>(null);
  const [recSec, setRecSec] = useState(0);

  const aliveRef = useRef(true);
  const pendingRef = useRef(false);
  const micRef = useRef<MicState>("idle");
  const micTokenRef = useRef(0);
  const askAcRef = useRef<AbortController | null>(null);
  const trAcRef = useRef<AbortController | null>(null);
  const recRef = useRef<MicRecording | null>(null);
  const recTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recAutoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const peakRef = useRef(0);
  const reliableRef = useRef(false);
  const speechStopRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const finishMicRef = useRef<() => void>(() => {});

  const setMic = useCallback((m: MicState) => {
    micRef.current = m;
    setMicState(m);
  }, []);

  const pushEntry = useCallback(
    (result: PhraseHelperResult) => {
      entrySeq += 1;
      const next = [{ id: entrySeq, result }, ...(sessionEntries.get(mode) ?? [])].slice(0, ENTRY_KEEP);
      sessionEntries.set(mode, next);
      setEntries(next);
    },
    [mode],
  );

  // ── 마이크 정리 도우미 ──
  const clearMicTimers = useCallback(() => {
    if (recTickRef.current) clearInterval(recTickRef.current);
    if (recAutoRef.current) clearTimeout(recAutoRef.current);
    recTickRef.current = null;
    recAutoRef.current = null;
  }, []);
  const closeCtx = useCallback(() => {
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
  }, []);
  /** 진행 중인 녹음·전사를 버린다(닫기·숨김·언마운트). 담긴 소리는 쓰지 않는다 */
  const cancelMic = useCallback(() => {
    micTokenRef.current += 1;
    clearMicTimers();
    const rec = recRef.current;
    recRef.current = null;
    rec?.abort();
    closeCtx();
    trAcRef.current?.abort();
    trAcRef.current = null;
    if (aliveRef.current) setMic("idle");
  }, [clearMicTimers, closeCtx, setMic]);

  // ── 마운트·언마운트 — 언마운트(시험 시작·영역 이동)에서 진행 중인 것을 전부 끊는다 ──
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      askAcRef.current?.abort();
      askAcRef.current = null;
      micTokenRef.current += 1;
      if (recTickRef.current) clearInterval(recTickRef.current);
      if (recAutoRef.current) clearTimeout(recAutoRef.current);
      recRef.current?.abort();
      recRef.current = null;
      trAcRef.current?.abort();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.close().catch(() => {});
      speechStopRef.current?.(); // 도우미가 튼 소리만(시험 화면 소리는 건드리지 않는다)
      speechStopRef.current = null;
    };
  }, []);

  // 넓은 화면에서 지난번에 열어 두었으면 다시 연다(마운트 뒤에 읽는다 — hydration)
  useEffect(() => {
    if (isWide() && readOpenPref()) setOpen(true);
  }, []);

  // 도킹 — 열린 동안 html 속성(globals.css가 lg↑에서 본문을 민다)
  useEffect(() => {
    if (!open) return;
    const el = document.documentElement;
    el.setAttribute("data-phrase-helper", "open");
    return () => el.removeAttribute("data-phrase-helper");
  }, [open]);

  // 화면이 숨겨지면 녹음을 멈춘다(녹음 중 숨김 = 버림 — 토익 응시와 같은 규칙)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "hidden") return;
      if (micRef.current === "starting" || micRef.current === "recording") {
        cancelMic();
        setMicNote(copy.micHiddenKo);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [cancelMic, copy.micHiddenKo]);

  // 화면을 옮기면(같은 영역 안이라도 경로가 바뀌면) 녹음을 버린다 — 전사하지 않는다(마이크가 모르는 사이 열려 있지 않게, QA P3-A)
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  useEffect(() => {
    if (pathRef.current === pathname) return;
    pathRef.current = pathname;
    if (micRef.current === "starting" || micRef.current === "recording") {
      cancelMic();
      setMicNote(copy.micMovedKo);
    }
  }, [pathname, cancelMic, copy.micMovedKo]);

  // 화면의 다른 녹음(토익 "고칠 문장 다시 녹음" 등)이 시작되면 도우미 녹음을 끝낸다 — 두 녹음이 동시에 돌지 않게(QA P3-C).
  // 공유 신호는 lib/mic-session(녹음기 단위 — owner 이름으로 자기 녹음과 가른다)
  useEffect(
    () =>
      subscribeMicRecording((ev) => {
        if (ev.type !== "start" || ev.owner === PHRASE_HELPER_MIC_OWNER) return;
        if (micRef.current === "starting" || micRef.current === "recording") {
          cancelMic();
          setMicNote(copy.micPreemptedKo);
        }
      }),
    [cancelMic, copy.micPreemptedKo],
  );

  // 폰(lg 미만): 아래로 스크롤하는 동안 버튼을 숨긴다 — 위로 스크롤하거나 맨 위 근처면 다시(.fabHidden은 lg 미만에서만 먹는다)
  const [fabHidden, setFabHidden] = useState(false);
  useEffect(() => {
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        if (y <= FAB_REVEAL_TOP_PX) setFabHidden(false);
        else if (y > lastY + 4) setFabHidden(true);
        else if (y < lastY - 4) setFabHidden(false);
        lastY = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  // 화면을 옮기면 버튼을 다시 보인다(새 화면은 맨 위에서 시작)
  useEffect(() => {
    setFabHidden(false);
  }, [pathname]);

  const openPanel = () => {
    setOpen(true);
    writeOpenPref(true);
    // 탭 안에서 바로 초점(폰 키보드) — 렌더 뒤
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const closePanel = useCallback(() => {
    setOpen(false);
    writeOpenPref(false);
    askAcRef.current?.abort(); // 화면이 끊으면 서버도 상류 호출을 멈춘다(499)
    cancelMic();
    speechStopRef.current?.();
    speechStopRef.current = null;
  }, [cancelMic]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePanel]);

  // ── 물어보기 ──
  const ask = (raw: string) => {
    if (pendingRef.current || micRef.current !== "idle") return; // 대기 중 잠금(중복 호출 방지)
    const v = normalizePhraseHelperInput(raw);
    if (!v.ok) {
      setError({ messageKo: v.messageKo, retryInput: null });
      return;
    }
    setMicNote(null);
    // 한글이 없으면 요청 없이 안내(비용 0 — 진입 함수와 같은 판정)
    const local = phraseHelperLocalResult(mode, v.text);
    if (local) {
      setError(null);
      pushEntry(local);
      setText((cur) => (cur === raw ? "" : cur));
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const ac = new AbortController();
    askAcRef.current = ac;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, PHRASE_HELPER_CLIENT_TIMEOUT_MS);
    const body: PhraseHelperRequest = { mode, input: v.text };
    void (async () => {
      try {
        const res = await fetch(PHRASE_HELPER_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const data = (await res.json().catch(() => null)) as PhraseHelperResponse | null;
        if (!aliveRef.current) return;
        if (res.ok && data && data.ok) {
          pushEntry(data.result);
          setText((cur) => (cur === raw ? "" : cur));
          return;
        }
        if (res.status === 501) setError({ messageKo: copy.noKeyKo, retryInput: null });
        else if (res.status === 401) setError({ messageKo: copy.lockedKo, retryInput: null });
        else if ((res.status === 400 || res.status === 413) && data && !data.ok) setError({ messageKo: data.messageKo, retryInput: null });
        else if (res.status === 499 && !timedOut) return; // 화면이 먼저 끊었다
        else setError({ messageKo: copy.failKo, retryInput: v.text });
      } catch {
        if (!aliveRef.current) return;
        if (ac.signal.aborted && !timedOut) return; // 닫기 — 조용히
        setError({ messageKo: copy.failKo, retryInput: v.text });
      } finally {
        clearTimeout(timer);
        if (askAcRef.current === ac) askAcRef.current = null;
        pendingRef.current = false;
        if (aliveRef.current) setPending(false);
      }
    })();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(text);
  };

  // ── 마이크 ──
  const failMic = (e: unknown) => {
    clearMicTimers();
    recRef.current = null;
    closeCtx();
    if (!aliveRef.current) return;
    setMic("idle");
    setMicNote(e instanceof MicError ? copy.micDeniedKo(e) : copy.micFailKo);
  };

  const finishMic = () => {
    const rec = recRef.current;
    if (!rec || micRef.current !== "recording") return;
    recRef.current = null;
    clearMicTimers();
    setMic("transcribing");
    const token = micTokenRef.current;
    void (async () => {
      const r = await rec.stop(); // recorder.stop → 트랙 stop → 그다음 playback(모듈이 순서를 지킨다)
      closeCtx();
      if (!aliveRef.current || token !== micTokenRef.current) return;
      const done = (note: string | null) => {
        setMic("idle");
        setMicNote(note);
      };
      if (!r) return done(copy.micEmptyKo);
      if (r.durationMs < PHRASE_HELPER_REC_MIN_MS) return done(copy.micShortKo);
      // 무음은 올리지 않는다(무음 전사는 엉뚱한 문장을 지어낼 수 있다 — 비용 0). 레벨을 믿을 수 있을 때만 판정한다
      if (reliableRef.current && peakRef.current < PHRASE_HELPER_SILENCE_LEVEL) return done(copy.micSilentKo);

      let blob: Blob = r.blob;
      let type = r.mimeType;
      try {
        const w = await toWav16kMono(r.blob);
        blob = w.blob;
        type = "audio/wav";
      } catch {
        /* 디코드 실패 — 원본을 올린다 */
      }
      if (!aliveRef.current || token !== micTokenRef.current) return;

      const fd = new FormData();
      fd.append(PHRASE_HELPER_AUDIO_FIELD, blob, audioFileName(type));
      const ac = new AbortController();
      trAcRef.current = ac;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, PHRASE_HELPER_TRANSCRIBE_CLIENT_TIMEOUT_MS);
      try {
        const res = await fetch(PHRASE_HELPER_TRANSCRIBE_ENDPOINT, { method: "POST", body: fd, signal: ac.signal });
        const data = (await res.json().catch(() => null)) as PhraseHelperTranscribeResponse | null;
        if (!aliveRef.current || token !== micTokenRef.current) return;
        if (res.ok && data && data.ok) {
          const heard = data.text.trim();
          if (!heard) return done(copy.micEmptyKo);
          // 입력 칸에 채우기만 한다 — 보내지 않는다(사람이 고친 뒤 보낸다)
          setText(heard);
          setError(null);
          done(copy.micFilledKo);
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        }
        if (res.status === 501) return done(copy.micNoKeyKo);
        if ((res.status === 400 || res.status === 413) && data && !data.ok) return done(kid ? copy.micFailKo : data.messageKo);
        if (res.status === 401) return done(copy.lockedKo);
        return done(copy.micFailKo);
      } catch {
        if (!aliveRef.current || token !== micTokenRef.current) return;
        if (ac.signal.aborted && !timedOut) return done(null);
        return done(copy.micFailKo);
      } finally {
        clearTimeout(timer);
        if (trAcRef.current === ac) trAcRef.current = null;
      }
    })();
  };
  // 30초 자동 끝 타이머가 최신 finishMic을 부르게(렌더 중이 아니라 커밋 뒤에 갱신)
  useEffect(() => {
    finishMicRef.current = finishMic;
  });

  const startMic = () => {
    if (micRef.current !== "idle" || pendingRef.current) return;
    // 화면의 다른 녹음이 돌고 있으면 시작하지 않는다(동시 녹음 금지 — 그쪽이 먼저다)
    if (getLiveRecordingOwners().some((o) => o !== PHRASE_HELPER_MIC_OWNER)) {
      setMicNote(copy.micBusyKo);
      return;
    }
    speechStopRef.current?.(); // 도우미 🔊가 녹음에 섞이지 않게
    speechStopRef.current = null;
    setMicNote(null);
    setError(null);
    setMic("starting");
    // 레벨 미터용 컨텍스트 — 탭 안에서 만든다(iOS)
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
    const token = (micTokenRef.current += 1);
    // 탭 안에서 동기로 — getUserMedia 요청이 첫 await 전에 나간다(권한 창). 대기 상한은 점검용 15초(처음엔 권한 창에 답할 시간)
    startRecording({ audioContext: ctx, gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS, owner: PHRASE_HELPER_MIC_OWNER }).then(
      async (rec) => {
        if (!aliveRef.current || token !== micTokenRef.current) {
          rec.abort();
          return;
        }
        recRef.current = rec;
        try {
          await rec.started;
        } catch (e) {
          if (token === micTokenRef.current) failMic(e);
          return;
        }
        if (!aliveRef.current || token !== micTokenRef.current) return;
        const t0 = Date.now();
        setRecSec(0);
        setMic("recording");
        recTickRef.current = setInterval(() => {
          if (rec.levelReliable()) {
            reliableRef.current = true;
            peakRef.current = Math.max(peakRef.current, rec.level());
          }
          setRecSec(Math.floor((Date.now() - t0) / 1000));
        }, 100);
        recAutoRef.current = setTimeout(() => finishMicRef.current(), PHRASE_HELPER_REC_MAX_MS);
      },
      (e: unknown) => {
        if (token === micTokenRef.current) failMic(e);
      },
    );
  };

  const onMic = () => {
    if (micRef.current === "recording") finishMic();
    else startMic();
  };

  // ── 🔊 — 탭할 때만(프리페치 없음). 자기 손잡이만 쥔다 ──
  const play = (t: string) => {
    if (micRef.current !== "idle") return;
    speechStopRef.current?.();
    speechStopRef.current = speakQueue([{ text: t, lang }]);
  };

  const count = phraseHelperCharCount(text.trim());
  const over = count > PHRASE_HELPER_INPUT_MAX;
  const micBusy = mic !== "idle";

  if (!open) {
    return (
      <button
        type="button"
        className={`${s.fab} ${kid ? s.fabKid : ""} ${fabHidden ? s.fabHidden : ""} print-hide`}
        onClick={openPanel}
        data-testid="phrase-helper-fab"
        data-mode={mode}
        data-hidden={fabHidden ? "1" : undefined}
        aria-label={copy.title}
      >
        <span aria-hidden="true">💬</span>
        <span className={s.fabLabel}>{copy.fab}</span>
      </button>
    );
  }

  let status: { text: string; rec?: boolean } | null = null;
  if (mic === "starting") status = { text: kid ? "마이크를 켜는 중…" : "마이크를 여는 중…" };
  else if (mic === "recording") status = { text: copy.micRecordingKo(recSec), rec: true };
  else if (mic === "transcribing") status = { text: copy.micTranscribingKo };
  else if (pending) status = { text: copy.sending };
  else if (micNote) status = { text: micNote };

  return (
    <>
      <div className={`${s.backdrop} print-hide`} onClick={closePanel} aria-hidden="true" />
      <section className={`${s.panel} ${kid ? s.kid : ""} print-hide`} aria-label={copy.title} data-testid="phrase-helper-panel" data-mode={mode}>
        <div className={s.head}>
          <h2 className={s.title}>💬 {copy.title}</h2>
          <button type="button" className={s.close} onClick={closePanel} aria-label="닫기" data-testid="phrase-helper-close">
            ✕
          </button>
        </div>
        <form className={s.form} onSubmit={onSubmit}>
          <p className={s.lead}>{copy.lead}</p>
          <div className={s.row}>
            <input
              ref={inputRef}
              className="u-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={copy.placeholder}
              enterKeyHint="send"
              autoComplete="off"
              aria-label={copy.title}
              data-testid="phrase-helper-input"
              disabled={mic === "recording" || mic === "transcribing"}
            />
            <button
              type="button"
              className={`${s.mic} ${mic === "recording" ? s.micOn : ""}`}
              onClick={onMic}
              disabled={pending || mic === "starting" || mic === "transcribing"}
              aria-label={mic === "recording" ? "녹음 끝내기" : "말로 넣기"}
              aria-pressed={mic === "recording"}
              data-testid="phrase-helper-mic"
              data-state={mic}
            >
              {mic === "recording" ? copy.micStop : copy.micStart}
            </button>
          </div>
          <div className={s.actions}>
            <button type="submit" className={`u-btn u-btn-primary ${s.send}`} disabled={pending || micBusy || text.trim() === ""} data-testid="phrase-helper-send">
              {pending ? copy.sending : copy.send}
            </button>
            <span className={`${s.count} ${over ? s.countOver : ""}`}>
              {count}/{PHRASE_HELPER_INPUT_MAX}
            </span>
          </div>
          {status && (
            <p className={`${s.status} ${status.rec ? s.statusRec : ""}`} role="status" data-testid="phrase-helper-status">
              {status.text}
            </p>
          )}
          {error && (
            <div className={s.errorBox} data-testid="phrase-helper-error">
              <p className={s.status} role="alert">
                {error.messageKo}
              </p>
              {error.retryInput && (
                <button type="button" className="u-btn u-btn-secondary" onClick={() => ask(error.retryInput!)} disabled={pending || micBusy}>
                  {copy.retry}
                </button>
              )}
            </div>
          )}
        </form>
        <div className={s.list}>
          {entries.length === 0 ? (
            <p className={s.empty}>{copy.empty}</p>
          ) : (
            entries.map((e) => <ResultCard key={e.id} result={e.result} copy={copy} onPlay={play} speakDisabled={micBusy} />)
          )}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 결과 카드
// ---------------------------------------------------------------------------

function SpeakBtn({ text, onPlay, disabled }: { text: string; onPlay: (t: string) => void; disabled: boolean }) {
  return (
    <button type="button" className={s.speak} onClick={() => onPlay(text)} disabled={disabled} aria-label={`듣기: ${text}`} data-testid="phrase-helper-speak">
      🔊
    </button>
  );
}

function RegisterChip({ register }: { register: PhraseHelperJaRegister }) {
  return (
    <span className="u-chip u-chip-accent" data-testid="phrase-helper-register">
      {PHRASE_HELPER_JA_REGISTER_LABELS_KO[register]}
    </span>
  );
}

function ResultCard({ result, copy, onPlay, speakDisabled }: { result: PhraseHelperResult; copy: Copy; onPlay: (t: string) => void; speakDisabled: boolean }) {
  return (
    <article className={s.entry} data-testid="phrase-helper-entry" data-status={result.status}>
      <p className={s.asked}>“{result.input}”</p>
      {result.status !== "ok" || result.main === null ? (
        <p className={s.notice} data-testid="phrase-helper-notice">
          {result.noteKo ?? copy.failKo}
        </p>
      ) : result.mode === "japanese" ? (
        <>
          <div className={s.mainRow}>
            <p className={s.mainExpr} data-testid="phrase-helper-main">
              {result.main.expression}
            </p>
            <SpeakBtn text={result.main.expression} onPlay={onPlay} disabled={speakDisabled} />
          </div>
          <div className={s.meta}>
            <p className={s.reading} data-testid="phrase-helper-reading">
              {result.main.reading}
            </p>
            <RegisterChip register={result.main.register} />
          </div>
          <p className={s.usage}>{result.main.usageKo}</p>
          {result.noteKo && <p className={s.note}>※ {result.noteKo}</p>}
          {result.alternatives.length > 0 && (
            <>
              <p className={s.subhead}>{copy.altHead}</p>
              {result.alternatives.map((a, i) => (
                <div key={i} className={s.item}>
                  <div className={s.itemBody}>
                    <p className={s.alt}>{a.expression}</p>
                    <div className={s.meta}>
                      <p className={s.reading}>{a.reading}</p>
                      <RegisterChip register={a.register} />
                    </div>
                    <p className={s.exKo}>{a.noteKo}</p>
                  </div>
                  <SpeakBtn text={a.expression} onPlay={onPlay} disabled={speakDisabled} />
                </div>
              ))}
            </>
          )}
          {result.examples.length > 0 && (
            <>
              <p className={s.subhead}>{copy.examplesHead}</p>
              {result.examples.map((x, i) => (
                <div key={i} className={s.item}>
                  <div className={s.itemBody}>
                    <p className={s.ex}>{x.ja}</p>
                    <p className={s.reading}>{x.reading}</p>
                    <p className={s.exKo}>{x.ko}</p>
                  </div>
                  <SpeakBtn text={x.ja} onPlay={onPlay} disabled={speakDisabled} />
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <div className={s.mainRow}>
            <p className={s.mainExpr} data-testid="phrase-helper-main">
              {result.main.expression}
            </p>
            <SpeakBtn text={result.main.expression} onPlay={onPlay} disabled={speakDisabled} />
          </div>
          <p className={s.usage}>{result.main.usageKo}</p>
          {result.noteKo && <p className={s.note}>※ {result.noteKo}</p>}
          {result.alternatives.length > 0 && (
            <>
              <p className={s.subhead}>{copy.altHead}</p>
              {result.alternatives.map((a, i) => (
                <div key={i} className={s.item}>
                  <div className={s.itemBody}>
                    <p className={s.alt}>{a.expression}</p>
                    <p className={s.exKo}>{a.noteKo}</p>
                  </div>
                  <SpeakBtn text={a.expression} onPlay={onPlay} disabled={speakDisabled} />
                </div>
              ))}
            </>
          )}
          {result.examples.length > 0 && (
            <>
              <p className={s.subhead}>{copy.examplesHead}</p>
              {result.examples.map((x, i) => (
                <div key={i} className={s.item}>
                  <div className={s.itemBody}>
                    <p className={s.ex}>{x.en}</p>
                    <p className={s.exKo}>{x.ko}</p>
                  </div>
                  <SpeakBtn text={x.en} onPlay={onPlay} disabled={speakDisabled} />
                </div>
              ))}
            </>
          )}
        </>
      )}
    </article>
  );
}

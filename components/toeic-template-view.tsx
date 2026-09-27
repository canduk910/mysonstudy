"use client";

/**
 * ② 🧩 템플릿 훈련 탭 — 틀 카드 + 따라 말하기 바 (docs/harness/toeic.md §12-5-1·§12-5-2·§12-5-7, SPEC §20-10) — 클라이언트 컴포넌트.
 *
 * **틀 보기**(§12-5-1): 흐름 순서(templateFlowOrder — 단계 → 단계 안 묶음 → 소재 묶음 → 기타)로 묶음이 늘어서고, 틀마다 카드 하나 —
 * 영어 틀(고정 부분 굵게·자리 칩, 자리 순서마다 색)과 한국어 틀(같은 자리 이름이 같은 색), useKo, 출처 칩(📘 교재 틀 → 연결된 교재 쪽 /
 * 새 틀), 공통 틀 칩, 배지 자리(두 테스트 모드 + 연결된 표현의 표현 시험 상태 — 읽기만), 예문(🔊, 채움에 자리 색 밑줄). testFills는 보이지
 * 않는다(틀 바꿔 말하기에서 처음 본다). 머리에 "이어서 하기" 카드(첫 미졸업 묶음)와 단계·소재 칩 줄. `?tpl=`로 열리면 그 카드로 스크롤.
 *
 * **따라 말하기 바**(§12-5-2 — sticky, top: var(--streak-h)):
 * - 범위 여섯(이 묶음·이 단계·여기부터 끝까지·이 틀·틀린 틀만·유형 전체 — shadowRangeTemplates) + 범위마다 예상 시간(estimateShadowMs,
 *   지금 말 속도 배율 getSpeechSpeedFactor). 반복 1~4 · 틈 끔/짧게/보통/길게 · 한국어/영어 틀 소개 — 기기에 기억(useToeicShadowSettings).
 * - ▶ 탭 안에서 **동기로** `unlockSpeechPlayback()` → "준비 n/m"(prepareSpeech — 범위의 고유 조각을 미리 받는다, "바로 시작"으로 건너뛴다)
 *   → 준비가 끝나면 큐 시작(탭 밖이지만 큐 요소가 이미 풀려 있다 — 운동 안내와 같은 방식). 쉼은 큐가 무음 조각으로 튼다(pauseAfterMs).
 * - 재생 중: 바에 지금 틀 줄과 지금 예문(채움 밑줄), 진행 "틀 3/12 · 예문 2/4 · 영어 3/4", 쉼 동안 "🗣️ 따라 말해 보세요", 지금 카드·예문 강조.
 * - 이어 듣기: 마지막으로 **시작한** 조각 번호를 대본 내용 서명마다 기기에 기억하고, 다시 시작은 **그 예문의 머리**부터(shadowResumeIndex).
 * - 잠금 화면(Media Session — 이 플레이어만): ⏸ = 멈추고 위치 기억, ▶ = 이어 듣기, ⏭ = 다음 예문 머리, ⏮ = 지금 예문 머리. ■·화면 이탈·
 *   끝까지 들음이면 핸들러를 푼다. Wake Lock은 준비·재생 동안.
 * - 정지 조건: 언마운트(탭 전환 포함), 대본 내용 서명 변경(범위·반복·틈·소개), ■. 멈출 때는 큐가 돌려준 stop(stopSpeaking 금지).
 * - 긴 범위(여기부터 끝까지·유형 전체): 재생이 앞으로 가면 그 앞 조각을 이어서 준비한다(ROLL_STEP마다 — 어차피 재생할 조각. 잠금 화면에서
 *   합성 요청이 늦어져도 끊기지 않게 — 스펙 공백을 채운 선택, 빌드 리포트).
 * - 프리페치(준비와 별개): 범위의 영어 예문(고유)을 prefetchSpeech — 탭을 열 때의 기본 묶음 포함. 한국어·틀 소개는 ▶ 때의 준비가 받는다.
 * - 스트릭에 세지 않는다(듣기 — §12-9).
 *
 * **🧩 틀 테스트**(§12-5-3 — 테스트 화면은 components/toeic-template-test.tsx): 이어서 하기 카드·묶음 소제목의 "🧩 테스트", 모드마다
 * "틀린 틀만 테스트"(그 모드의 틀린 틀이 있을 때), 탭 아래 "최근 테스트"(그 유형 틀이 든 세션 최신 10개 — 서버가 요약해 넘긴다).
 * 테스트 끝 화면의 "틀린 틀만 따라 말하기"는 `?range=wrong`으로 와서 범위 "틀린 틀만"을 골라 둔다(▶는 사용자가 누른다 — 탭 안 재생).
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExampleLine, FrameLine } from "@/components/toeic-template-lines";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { useToeicShadowSettings } from "@/components/use-toeic-shadow-settings";
import { useToeicWakeLock } from "@/components/use-toeic-wake-lock";
import { bindMediaSession, setMediaSessionPlaybackState } from "@/lib/media-session";
import {
  TTS_ENGINE_EVENT,
  TTS_RATE_EVENT,
  getSpeechSpeedFactor,
  prefetchSpeech,
  prepareSpeech,
  speak,
  speakQueue,
  unlockSpeechPlayback,
} from "@/lib/speech";
import type { ToeicGuidePart, ToeicTemplate, ToeicTemplateFlow, ToeicTemplateGuideRef } from "@/lib/toeic-guide-contract";
import {
  TOEIC_EXPRESSION_BADGE_LABELS_KO,
  TOEIC_SHADOW_RANGES,
  TOEIC_TEMPLATE_BADGE_LABELS_KO,
  countMastered,
  formatShadowDurationKo,
  guidePartShortKo,
  guideRefHref,
  guideRefLabelKo,
  nextShadowGroup,
  readShadowResume,
  shadowHeadIndex,
  shadowNextHeadIndex,
  shadowPositionAt,
  shadowPositionLabelKo,
  shadowRangeLabelKo,
  shadowRangeTemplates,
  shadowRangeTitleKo,
  shadowScriptSignature,
  slotToneMap,
  writeShadowResume,
  clearShadowResume,
  type ToeicShadowRange,
  type ToeicShadowSelection,
} from "@/lib/toeic-guide-view";
import { TOEIC_QUIZ_MODE_LABELS_KO, TOEIC_TEMPLATE_QUIZ_MODES, TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO, type ToeicQuizMode, type ToeicTemplateQuizMode } from "@/lib/toeic-quiz";
import {
  TOEIC_SHADOW_REPEAT_MAX,
  TOEIC_SHADOW_REPEAT_MIN,
  buildTemplateShadowScript,
  estimateShadowMs,
  frameSlotNames,
  splitExampleByFills,
  splitFrameForDisplay,
  templateFlowOrder,
  type ToeicShadowPauseLevel,
  type ToeicShadowPiece,
  type ToeicTemplateBadge,
} from "@/lib/toeic-template";
import { TOEIC_TEMPLATE_TEST_MODE_TAG_KO, toeicTemplateTestHref, type ToeicRecentTemplateTest } from "@/lib/toeic-template-test-view";
import { expressionKey } from "@/lib/toeic-text";
import s from "./toeic-template-view.module.css";

/** 이어 듣기 기억(기기 localStorage — 대본 서명마다) */
const RESUME_KEY = "toeic-shadow-resume:v1";
/** 긴 범위에서 이어서 준비하는 간격(조각) — 한 예문이 한국어 1 + 영어 N조각이라 약 20예문마다 */
const ROLL_STEP = 100;

const PAUSE_CHOICES: { label: string; pause: boolean; level: ToeicShadowPauseLevel }[] = [
  { label: "끔", pause: false, level: "normal" },
  { label: "짧게", pause: true, level: "short" },
  { label: "보통", pause: true, level: "normal" },
  { label: "길게", pause: true, level: "long" },
];

type Phase = "idle" | "preparing" | "playing" | "paused";

interface ActivePlay {
  script: ToeicShadowPiece[];
  sig: string;
  title: string;
}

function readResumeStore(): string | null {
  try {
    return window.localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}
function writeResumeStore(json: string): void {
  try {
    window.localStorage.setItem(RESUME_KEY, json);
  } catch {
    /* 기억 못 해도 재생은 된다 */
  }
}

export default function ToeicTemplateView({
  part,
  partLabelKo,
  templates,
  flows,
  badges,
  wrongKeys,
  masteredKeys,
  exprBadges,
  brokenTemplates,
  recentTests,
  wrongCounts,
  initialRange,
  focusKey,
  onNavigate,
}: {
  part: ToeicGuidePart;
  partLabelKo: string;
  templates: ToeicTemplate[];
  flows: ToeicTemplateFlow[];
  badges: Record<ToeicTemplateQuizMode, Record<string, ToeicTemplateBadge>>;
  wrongKeys: string[];
  masteredKeys: string[];
  exprBadges: Record<string, { mode: ToeicQuizMode; badge: "mastered" | "progress" | "wrong" }[]>;
  brokenTemplates: number;
  /** 그 유형 틀이 든 틀 세션 최신 10개(서버 요약) */
  recentTests: ToeicRecentTemplateTest[];
  /** 모드마다 그 유형의 틀린 틀 수(틀렸고 미졸업) */
  wrongCounts: Record<ToeicTemplateQuizMode, number>;
  /** 주소 `?range=` — 테스트 끝 화면의 "틀린 틀만 따라 말하기"가 "wrong"으로 연다 */
  initialRange: ToeicShadowRange | null;
  focusKey: string | null;
  onNavigate: (href: string) => void;
}) {
  const groups = useMemo(() => templateFlowOrder({ flows, items: templates }, part), [flows, templates, part]);
  const byKey = useMemo(() => new Map(templates.map((t) => [t.key, t])), [templates]);
  const mastered = useMemo(() => new Set(masteredKeys), [masteredKeys]);
  const wrong = useMemo(() => new Set(wrongKeys), [wrongKeys]);
  const next = useMemo(() => nextShadowGroup(groups, mastered), [groups, mastered]);
  const groupOfKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const t of g.templates) m.set(t.key, g.groupKo);
    return m;
  }, [groups]);

  // ── 설정(기기 기억) ──
  const [settings, updateSettings] = useToeicShadowSettings();
  const opts = useMemo(
    () => ({ repeat: settings.repeat, pause: settings.pause, pauseLevel: settings.pauseLevel, intro: settings.intro, introEn: settings.introEn }),
    [settings.repeat, settings.pause, settings.pauseLevel, settings.intro, settings.introEn],
  );

  // ── 범위 ──
  const [range, setRange] = useState<ToeicShadowRange>(() => (initialRange === "wrong" && wrongKeys.length > 0 ? "wrong" : "group"));
  const [sel, setSel] = useState<ToeicShadowSelection>(() => ({
    groupKo: (focusKey ? groupOfKey.get(focusKey) : undefined) ?? next?.groupKo ?? groups[0]?.groupKo ?? null,
    templateKey: focusKey && byKey.has(focusKey) ? focusKey : null,
  }));
  const buildFor = useCallback(
    (r: ToeicShadowRange, sl: ToeicShadowSelection) => buildTemplateShadowScript(shadowRangeTemplates(groups, r, sl, wrong), opts),
    [groups, wrong, opts],
  );
  const script = useMemo(() => buildFor(range, sel), [buildFor, range, sel]);
  const sig = useMemo(() => shadowScriptSignature(script, part), [script, part]);

  // 말 속도 배율 — 렌더 중에 읽지 않는다(hydration). 속도·엔진이 바뀌면 다시 읽는다.
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    const read = () => setSpeed(getSpeechSpeedFactor("en-US"));
    read();
    window.addEventListener(TTS_RATE_EVENT, read);
    window.addEventListener(TTS_ENGINE_EVENT, read);
    return () => {
      window.removeEventListener(TTS_RATE_EVENT, read);
      window.removeEventListener(TTS_ENGINE_EVENT, read);
    };
  }, []);

  const rangeEst = useMemo(() => {
    const out = {} as Record<ToeicShadowRange, number>;
    for (const r of TOEIC_SHADOW_RANGES) out[r] = estimateShadowMs(buildFor(r, sel), speed);
    return out;
  }, [buildFor, sel, speed]);
  const groupEst = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.groupKo, estimateShadowMs(buildTemplateShadowScript(g.templates, opts), speed));
    return m;
  }, [groups, opts, speed]);

  // ── 이어 듣기 기억(대본 서명마다) ──
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const sigRef = useRef(sig);
  useEffect(() => {
    sigRef.current = sig;
    setResumeAt(readShadowResume(readResumeStore(), sig));
  }, [sig]);

  // ── 재생 상태 ──
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [prep, setPrep] = useState<{ done: number; total: number } | null>(null);
  const [pos, setPos] = useState<number | null>(null);
  const [pausing, setPausing] = useState(false);
  const [active, setActive] = useState<ActivePlay | null>(null);
  const activeRef = useRef<ActivePlay | null>(null);
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const acRef = useRef<AbortController | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  const posRef = useRef(0);
  const startFromRef = useRef(0);
  const rollAtRef = useRef(0);
  const rollingRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  /** 상태와 ref를 함께 — 잠금 화면 핸들러·준비 콜백이 같은 순간의 단계를 본다 */
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  useToeicWakeLock(phase === "preparing" || phase === "playing");

  /** 큐·준비를 멈춘다(실행 번호를 올려 옛 콜백을 무시). 잠금 화면 바인딩은 두고 — 푸는 것은 stopPlayer */
  const haltAll = useCallback(() => {
    runRef.current++;
    const stop = stopRef.current;
    stopRef.current = null;
    stop?.();
    acRef.current?.abort();
    acRef.current = null;
    rollingRef.current = false;
  }, []);

  const unbindMedia = useCallback(() => {
    const u = unbindRef.current;
    unbindRef.current = null;
    u?.();
  }, []);

  const stopPlayer = useCallback(() => {
    haltAll();
    unbindMedia();
    activeRef.current = null;
    setActive(null);
    setPhase("idle");
    setPrep(null);
    setPos(null);
    setPausing(false);
  }, [haltAll, unbindMedia, setPhase]);

  function rememberResume(act: ActivePlay, index: number) {
    const json = writeShadowResume(readResumeStore(), act.sig, index);
    writeResumeStore(json);
    if (act.sig === sigRef.current) setResumeAt(index);
  }

  /** 긴 범위 — 재생 위치가 ROLL_STEP을 지나면 그 앞 조각을 이어서 준비한다(백그라운드, 실패는 무시) */
  function maybeRoll(run: number, act: ActivePlay, abs: number) {
    if (rollingRef.current || abs < rollAtRef.current) return;
    rollingRef.current = true;
    rollAtRef.current = abs + ROLL_STEP;
    const ac = new AbortController();
    acRef.current = ac;
    void prepareSpeech(
      act.script.slice(abs).map((p) => ({ text: p.text, lang: p.lang })),
      { signal: ac.signal },
    ).finally(() => {
      if (runRef.current === run) rollingRef.current = false;
    });
  }

  /** 큐 시작(from = 대본 절대 인덱스). 준비를 거친 시작은 탭 밖이다 — 큐 요소는 ▶ 탭에서 이미 풀었다 */
  function playQueue(run: number, from: number) {
    const act = activeRef.current;
    if (!act || runRef.current !== run) return;
    setPhase("playing");
    setPrep(null);
    setPausing(false);
    setMediaSessionPlaybackState("playing");
    rollAtRef.current = from + ROLL_STEP;
    rollingRef.current = false;
    posRef.current = from;
    setPos(from);
    const stop = speakQueue(
      act.script.slice(from).map((p) => ({ text: p.text, lang: p.lang, pauseAfterMs: p.pauseAfterMs })),
      {
        onItem: (i) => {
          if (runRef.current !== run) return;
          const abs = from + i;
          posRef.current = abs;
          setPos(abs);
          setPausing(false);
          rememberResume(act, abs);
          maybeRoll(run, act, abs);
        },
        onPause: () => {
          if (runRef.current === run) setPausing(true);
        },
        onEnd: (reason) => {
          if (runRef.current !== run) return;
          stopRef.current = null;
          setPausing(false);
          if (reason === "done") {
            // 끝까지 들었다 — 이어 듣기 기억을 지우고 잠금 화면 조작을 푼다
            writeResumeStore(clearShadowResume(readResumeStore(), act.sig));
            if (act.sig === sigRef.current) setResumeAt(null);
          }
          // "stopped"(외부 멈춤·무음 연속)이면 위치는 기억돼 있다 — 이어 듣기로 잇는다
          unbindMedia();
          activeRef.current = null;
          setActive(null);
          setPhase("idle");
          setPos(null);
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
  }

  // 잠금 화면 핸들러 — 최신 상태를 ref로 본다(바인딩은 재생 시작 때 한 번)
  const lockRef = useRef({ pause: () => {}, play: () => {}, next: () => {}, prev: () => {} });
  useEffect(() => {
    lockRef.current = {
    pause: () => {
      if (phaseRef.current !== "playing") return;
      runRef.current++;
      const stop = stopRef.current;
      stopRef.current = null;
      stop?.();
      setPhase("paused");
      setPausing(false);
      setMediaSessionPlaybackState("paused");
    },
    play: () => {
      const act = activeRef.current;
      if (!act || phaseRef.current === "playing") return;
      const run = ++runRef.current;
      playQueue(run, shadowHeadIndex(act.script, posRef.current));
    },
    next: () => {
      const act = activeRef.current;
      if (!act) return;
      const j = shadowNextHeadIndex(act.script, posRef.current);
      if (j < 0) return;
      haltAll();
      playQueue(runRef.current, j);
    },
    prev: () => {
      const act = activeRef.current;
      if (!act) return;
      haltAll();
      playQueue(runRef.current, shadowHeadIndex(act.script, posRef.current));
    },
    };
  });

  function bindMedia(title: string) {
    unbindMedia();
    unbindRef.current = bindMediaSession({
      title: "틀 따라 말하기",
      artist: `${partLabelKo} · ${title}`,
      actions: {
        pause: () => lockRef.current.pause(),
        play: () => lockRef.current.play(),
        nexttrack: () => lockRef.current.next(),
        previoustrack: () => lockRef.current.prev(),
      },
    });
  }

  /**
   * 재생 시작(준비 포함). ⚠️ **탭 핸들러 안에서 동기로** 부른다 — unlockSpeechPlayback()이 iOS 재생 잠금을 풀어야 준비 뒤(탭 밖) 큐가 난다.
   * scr·sg는 이 탭에서 계산한 대본(범위를 바꾸는 ▶는 상태가 바뀌기 전에 새 대본을 넘긴다 — 서명이 같아 "대본 변경 정지"에 걸리지 않는다).
   */
  function startWith(scr: ToeicShadowPiece[], sg: string, title: string, from: number) {
    haltAll();
    if (scr.length === 0 || from < 0 || from >= scr.length) return;
    unlockSpeechPlayback();
    // 설정을 연 채 재생하면 커진 sticky 바가 따라가는 카드·예문을 덮는다(S1 QA P3-1 — 읽기 탭과 같은 관용구)
    if (settingsRef.current) settingsRef.current.open = false;
    const run = runRef.current;
    const act: ActivePlay = { script: scr, sig: sg, title };
    activeRef.current = act;
    setActive(act);
    startFromRef.current = from;
    bindMedia(title);
    setPhase("preparing");
    setPrep({ done: 0, total: 0 });
    setPos(null);
    const ac = new AbortController();
    acRef.current = ac;
    void prepareSpeech(
      scr.slice(from).map((p) => ({ text: p.text, lang: p.lang })),
      {
        signal: ac.signal,
        onProgress: (done, total) => {
          if (runRef.current === run) setPrep({ done, total });
        },
      },
    ).then(() => {
      if (runRef.current !== run || ac.signal.aborted) return;
      playQueue(run, from);
    });
  }

  /** "바로 시작" — 준비를 끊고 탭 안에서 곧바로 큐를 시작한다 */
  function skipPrepare() {
    if (phaseRef.current !== "preparing") return;
    acRef.current?.abort();
    acRef.current = null;
    unlockSpeechPlayback();
    playQueue(runRef.current, startFromRef.current);
  }

  /** 범위·고른 것을 바꾸며 곧바로 재생(카드 ▶·묶음 ▶·이어서 하기) — 새 대본을 이 탭에서 만든다 */
  function playSelection(r: ToeicShadowRange, sl: ToeicShadowSelection) {
    const scr = buildFor(r, sl);
    const sg = shadowScriptSignature(scr, part);
    setRange(r);
    setSel(sl);
    sigRef.current = sg;
    startWith(scr, sg, shadowRangeTitleKo(r, groups, sl), 0);
  }

  // 정지 조건 — 언마운트(탭 전환 포함)
  useEffect(
    () => () => {
      haltAll();
      unbindMedia();
    },
    [haltAll, unbindMedia],
  );
  // 정지 조건 — 대본 내용 서명 변경(범위·반복·틈·소개). 방금 새 대본으로 시작한 것은 서명이 같아 멈추지 않는다.
  useEffect(() => {
    const act = activeRef.current;
    if (act && act.sig !== sig) stopPlayer();
  }, [sig, stopPlayer]);

  // ── 프리페치(준비와 별개): 범위의 영어 예문(고유·문서 순서) ──
  const prefetchKey = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of script) {
      if (p.lang !== "en-US" || p.example === null || seen.has(p.text)) continue;
      seen.add(p.text);
      out.push(p.text);
    }
    return out.join("\u0001");
  }, [script]);
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── 지금 위치 ──
  const curPiece = active && pos !== null && pos < active.script.length ? active.script[pos] : null;
  const curTpl = curPiece ? (byKey.get(curPiece.key) ?? null) : null;
  const position = active && pos !== null ? shadowPositionAt(active.script, pos) : null;

  // 바 실제 높이 → --tpl-bar-h(카드 scroll-margin-top)
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const rangeRowRef = useRef<HTMLDivElement>(null);
  // 테스트 끝 화면에서 "틀린 틀만"으로 왔으면 그 범위 칩이 칩 줄 안에서 보이게(가로로만 민다 — 페이지는 움직이지 않는다)
  useEffect(() => {
    if (initialRange !== "wrong") return;
    const row = rangeRowRef.current;
    const chip = row?.querySelector<HTMLElement>("button[aria-pressed='true']");
    if (row && chip) row.scrollLeft = Math.max(0, chip.offsetLeft - row.offsetLeft - 8);
  }, [initialRange]);
  useEffect(() => {
    const bar = barRef.current;
    const wrap = wrapRef.current;
    if (!bar || !wrap || typeof ResizeObserver === "undefined") return;
    const apply = () => wrap.style.setProperty("--tpl-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // 지금 카드·예문으로 따라간다 — (틀, 예문)이 바뀔 때만
  const activeSpot = curPiece ? `${curPiece.key}|${curPiece.example ?? "i"}` : "";
  useEffect(() => {
    if (!activeSpot) return;
    const [key, ex] = activeSpot.split("|");
    const card = wrapRef.current?.querySelector<HTMLElement>(`[data-tpl="${CSS.escape(key)}"]`);
    const el = (ex !== "i" ? card?.querySelector<HTMLElement>(`[data-ex="${ex}"]`) : null) ?? card;
    if (!el) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* noop */
    }
    el.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeSpot]);

  // ?tpl= → 그 카드로 스크롤·잠깐 강조(다른 탭의 🧩 칩이 여기로 온다)
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey || !byKey.has(focusKey)) return;
    if (phaseRef.current === "idle") setSel((prev) => ({ groupKo: groupOfKey.get(focusKey) ?? prev.groupKo, templateKey: focusKey }));
    setFlash(focusKey);
    const raf = window.requestAnimationFrame(() => {
      wrapRef.current?.querySelector<HTMLElement>(`[data-tpl="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: "start" });
    });
    const t = window.setTimeout(() => setFlash(null), 2400);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [focusKey, byKey, groupOfKey]);

  // ── 단계·소재 칩 ──
  const flow = flows[0] ?? null;
  const stepChips = useMemo(() => {
    if (!flow) return [];
    return flow.steps
      .map((st, i) => {
        const ts = groups.filter((g) => g.kind === "step" && g.stepKo === st.stepKo).flatMap((g) => g.templates);
        return { i, stepKo: st.stepKo, n: ts.length, m: countMastered(ts, mastered) };
      })
      .filter((c) => c.n > 0);
  }, [flow, groups, mastered]);
  const bankGroups = groups.filter((g) => g.kind !== "step");

  function scrollToAnchor(selector: string) {
    wrapRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "start" });
  }

  // ── 📘 교재 틀 칩 — 연결이 여럿이면 작은 목록 ──
  const [refMenu, setRefMenu] = useState<string | null>(null);
  function goRef(ref: ToeicTemplateGuideRef) {
    setRefMenu(null);
    onNavigate(guideRefHref(ref));
  }

  const playing = phase === "playing" || phase === "preparing";
  const selGroup = groups.find((g) => g.groupKo === sel.groupKo) ?? null;
  const curRangeLabel = shadowRangeLabelKo(range, groups, sel);

  // ── 렌더 ──
  let lastStep: string | null = null;
  let bankHeadDone = false;

  return (
    <div ref={wrapRef} className={s.wrap}>
      {brokenTemplates > 0 && <p className={s.warn}>⚠️ 형식이 맞지 않아 열지 못한 틀이 {brokenTemplates}개 있어요.</p>}

      {/* 이어서 하기(검토 S10) */}
      <section className={s.resumeCard} aria-label="이어서 하기">
        {next ? (
          <>
            <p className={s.resumeTitle}>
              <span className={s.resumeTag}>이어서 하기</span> {next.groupKo}
              {next.stepKo && <span className={s.resumeStep}> · {next.stepKo}</span>}
            </p>
            <div className={s.resumeActions}>
              <button
                type="button"
                className="u-btn u-btn-primary"
                onClick={() => playSelection("group", { groupKo: next.groupKo, templateKey: sel.templateKey })}
              >
                ▶ 따라 말하기({formatShadowDurationKo(groupEst.get(next.groupKo) ?? 0)})
              </button>
              <Link href={toeicTemplateTestHref(part, { mode: "tpl-recall", scope: "group", group: next.groupKo })} className="u-btn u-btn-secondary">
                🧩 틀 테스트
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className={s.resumeTitle}>🎓 다 익혔어요 — 틀 테스트로 복습해요.</p>
            <Link href={toeicTemplateTestHref(part, { mode: "tpl-swap", scope: "all" })} className="u-btn u-btn-primary">
              🧩 틀 테스트로 복습
            </Link>
          </>
        )}
        {TOEIC_TEMPLATE_QUIZ_MODES.some((m) => wrongCounts[m] > 0) && (
          <div className={s.wrongTests} aria-label="틀린 틀만 테스트">
            {TOEIC_TEMPLATE_QUIZ_MODES.filter((m) => wrongCounts[m] > 0).map((m) => (
              <Link key={m} href={toeicTemplateTestHref(part, { mode: m, scope: "wrong" })} className={s.wrongTestLink}>
                🧩 틀린 틀만 다시 테스트 · {TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO[m]} {wrongCounts[m]}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 단계·소재 칩 줄 — 가로로 민다(칩 줄 안의 스크롤) */}
      {stepChips.length > 0 && (
        <div className={s.chipRow} aria-label="답변 흐름 단계">
          {stepChips.map((c) => (
            <button key={c.i} type="button" className={s.stepChip} onClick={() => scrollToAnchor(`[data-step="${c.i}"]`)}>
              {c.stepKo} · 틀 {c.n} · 익힘 {c.m}
            </button>
          ))}
        </div>
      )}
      {bankGroups.length > 0 && (
        <div className={s.chipRow} aria-label="소재 묶음">
          {bankGroups.map((g) => (
            <button key={g.groupKo} type="button" className={s.bankChip} onClick={() => scrollToAnchor(`[data-group="${CSS.escape(g.groupKo)}"]`)}>
              {g.groupKo} · 틀 {g.templates.length}
            </button>
          ))}
        </div>
      )}

      {/* 따라 말하기 바 — sticky */}
      <div ref={barRef} className={s.bar} aria-label="따라 말하기">
        <div ref={rangeRowRef} className={s.rangeRow} role="group" aria-label="따라 말하기 범위">
          {TOEIC_SHADOW_RANGES.map((r) => {
            const ms = rangeEst[r];
            return (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                disabled={ms === 0}
                onClick={() => setRange(r)}
                className={`${s.rangeChip} ${range === r ? s.rangeOn : ""}`}
              >
                {shadowRangeLabelKo(r, groups, sel)}
                {ms > 0 && <span className={s.rangeTime}> · {formatShadowDurationKo(ms)}</span>}
              </button>
            );
          })}
        </div>
        <p className={s.rangeNow}>
          {curRangeLabel}
          {range === "group" || range === "step" || range === "from"
            ? selGroup
              ? ` — ${range === "step" && selGroup.kind === "step" && selGroup.stepKo ? selGroup.stepKo : selGroup.groupKo}`
              : ""
            : range === "template" && sel.templateKey
              ? ` — ${groupOfKey.get(sel.templateKey) ?? ""}`
              : ""}
        </p>
        <div className={s.controls}>
          {playing || phase === "paused" ? (
            <button type="button" className="u-btn u-btn-primary" onClick={stopPlayer}>
              ■ 멈추기
            </button>
          ) : (
            <button
              type="button"
              className="u-btn u-btn-primary"
              disabled={script.length === 0}
              onClick={() => startWith(script, sig, shadowRangeTitleKo(range, groups, sel), 0)}
            >
              ▶ 처음부터
            </button>
          )}
          {phase === "paused" && active ? (
            <button type="button" className="u-btn u-btn-secondary" onClick={() => startWith(active.script, active.sig, active.title, shadowHeadIndex(active.script, posRef.current))}>
              ↻ 이어 듣기
            </button>
          ) : (
            !playing &&
            resumeAt !== null &&
            resumeAt > 0 &&
            resumeAt < script.length && (
              <button type="button" className="u-btn u-btn-secondary" onClick={() => startWith(script, sig, shadowRangeTitleKo(range, groups, sel), shadowHeadIndex(script, resumeAt))}>
                ↻ 이어 듣기
              </button>
            )
          )}
          <span className={s.progress} aria-live="polite">
            {phase === "preparing" && prep ? `준비 ${prep.done}/${prep.total}` : position ? shadowPositionLabelKo(position) : `${script.length}조각`}
          </span>
          {phase === "preparing" && (
            <button type="button" className={s.skip} onClick={skipPrepare}>
              바로 시작
            </button>
          )}
        </div>

        {curTpl && curPiece && (
          <div className={s.now}>
            <p className={s.nowFrame} lang="en">
              <FrameLine frame={curTpl.frameEn} tones={slotToneMap(frameSlotNames(curTpl.frameEn))} lang="en" />
            </p>
            {curPiece.example !== null && curTpl.examples[curPiece.example] && (
              <p className={s.nowExample} lang="en">
                <ExampleLine frameEn={curTpl.frameEn} fills={curTpl.examples[curPiece.example].fills} />
              </p>
            )}
            {pausing && <p className={s.shadowCue}>🗣️ 따라 말해 보세요</p>}
          </div>
        )}

        <details className={s.settings} ref={settingsRef}>
          <summary className={s.settingsSummary}>⚙️ 따라 말하기 설정</summary>
          <div className={s.settingsBody}>
            <div className={s.optRow} role="group" aria-label="영어 반복">
              <span className={s.optLabel}>영어 반복</span>
              {Array.from({ length: TOEIC_SHADOW_REPEAT_MAX - TOEIC_SHADOW_REPEAT_MIN + 1 }, (_, i) => TOEIC_SHADOW_REPEAT_MIN + i).map((n) => (
                <button key={n} type="button" aria-pressed={settings.repeat === n} onClick={() => updateSettings({ repeat: n })} className={`${s.optChip} ${settings.repeat === n ? s.optOn : ""}`}>
                  {n}번
                </button>
              ))}
            </div>
            <div className={s.optRow} role="group" aria-label="따라 말할 틈">
              <span className={s.optLabel}>따라 말할 틈</span>
              {PAUSE_CHOICES.map((c) => {
                const on = c.pause ? settings.pause && settings.pauseLevel === c.level : !settings.pause;
                return (
                  <button key={c.label} type="button" aria-pressed={on} onClick={() => updateSettings(c.pause ? { pause: true, pauseLevel: c.level } : { pause: false })} className={`${s.optChip} ${on ? s.optOn : ""}`}>
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div className={s.optRow} role="group" aria-label="틀 소개">
              <span className={s.optLabel}>틀 소개</span>
              <button type="button" aria-pressed={settings.intro} onClick={() => updateSettings({ intro: !settings.intro })} className={`${s.optChip} ${settings.intro ? s.optOn : ""}`}>
                한국어 {settings.intro ? "켬" : "끔"}
              </button>
              <button type="button" aria-pressed={settings.introEn} onClick={() => updateSettings({ introEn: !settings.introEn })} className={`${s.optChip} ${settings.introEn ? s.optOn : ""}`}>
                영어 {settings.introEn ? "켬" : "끔"}
              </button>
            </div>
            <TtsSpeedControl />
            <TtsEngineControl lang="en-US" />
            <TtsEngineControl lang="ko-KR" />
            <p className="t-caption">화면을 끄고 이어폰으로 들으려면 영어·한국어 모두 클라우드 음성으로 두세요(기기 음성은 잠금 화면에서 멈출 수 있어요).</p>
          </div>
        </details>
      </div>

      {/* 틀 목록 — 단계 제목 → 묶음 소제목 → 틀 카드 / 소재 묶음은 "소재별 틀" 아래 */}
      {groups.map((g) => {
        const heads: ReactNode[] = [];
        if (g.kind === "step" && g.stepKo !== lastStep) {
          lastStep = g.stepKo;
          const stepIdx = flow ? flow.steps.findIndex((st) => st.stepKo === g.stepKo) : -1;
          const n = groups.filter((x) => x.kind === "step" && x.stepKo === g.stepKo).reduce((a, x) => a + x.templates.length, 0);
          heads.push(
            <h3 key={`step-${g.stepKo}`} data-step={stepIdx} className={s.stepHead}>
              {stepIdx >= 0 && <span className={s.stepNo}>{stepIdx + 1}</span>}
              {g.stepKo} <span className={s.stepCount}>· 틀 {n}</span>
            </h3>,
          );
        }
        if (g.kind !== "step" && !bankHeadDone) {
          bankHeadDone = true;
          lastStep = null;
          heads.push(
            <h3 key="banks" className={s.stepHead}>
              {g.kind === "bank" ? "소재별 틀" : "기타"}
            </h3>,
          );
        }
        const isSelGroup = sel.groupKo === g.groupKo;
        return (
          <Fragment key={g.groupKo}>
            {heads}
            <section data-group={g.groupKo} className={s.group} aria-label={g.groupKo}>
              <div className={s.groupHead}>
                <h4 className={s.groupTitle}>
                  {g.groupKo}
                  <span className={s.groupMeta}>
                    {" "}
                    · 틀 {g.templates.length} · {formatShadowDurationKo(groupEst.get(g.groupKo) ?? 0)}
                  </span>
                </h4>
                <span className={s.groupBtns}>
                  <button
                    type="button"
                    className={`${s.groupPlay} ${isSelGroup && range === "group" ? s.groupPlayOn : ""}`}
                    onClick={() => playSelection("group", { groupKo: g.groupKo, templateKey: sel.templateKey })}
                    aria-label={`${g.groupKo} 따라 말하기`}
                  >
                    ▶ 이 묶음
                  </button>
                  <Link
                    href={toeicTemplateTestHref(part, { mode: "tpl-recall", scope: "group", group: g.groupKo })}
                    className={s.groupPlay}
                    aria-label={`${g.groupKo} 틀 테스트`}
                  >
                    🧩 테스트
                  </Link>
                </span>
              </div>
              <ol className={s.cards}>
                {g.templates.map((t) => {
                  const tones = slotToneMap(frameSlotNames(t.frameEn));
                  const isCur = curPiece?.key === t.key;
                  const exprRefs = t.guideRefs.filter((r): r is Extract<ToeicTemplateGuideRef, { kind: "expression" }> => r.kind === "expression" && r.part === part);
                  const exprLines = exprRefs
                    .map((r) => exprBadges[expressionKey(r.expression)])
                    .filter((x): x is NonNullable<typeof x> => Array.isArray(x) && x.length > 0);
                  const otherParts = t.parts.filter((p) => p !== part);
                  return (
                    <li key={t.key} data-tpl={t.key} className={`${s.card} ${isCur ? s.cardActive : ""} ${flash === t.key ? s.cardFlash : ""}`}>
                      <p className={s.frameEn} lang="en">
                        <FrameLine frame={t.frameEn} tones={tones} lang="en" />
                      </p>
                      <p className={s.frameKo}>
                        <FrameLine frame={t.frameKo} tones={tones} lang="ko" />
                      </p>
                      <p className={s.use}>{t.useKo}</p>
                      <div className={s.chips}>
                        {t.guideRefs.length > 0 ? (
                          <span className={s.refWrap}>
                            <button
                              type="button"
                              className={s.refChip}
                              aria-expanded={t.guideRefs.length > 1 ? refMenu === t.key : undefined}
                              onClick={() => (t.guideRefs.length === 1 ? goRef(t.guideRefs[0]) : setRefMenu((k) => (k === t.key ? null : t.key)))}
                            >
                              {t.source === "guide" ? "📘 교재 틀" : "새 틀 · 📘 교재 단계"}
                              {t.guideRefs.length > 1 ? ` ${t.guideRefs.length}` : ""}
                            </button>
                            {refMenu === t.key && (
                              <span className={s.refMenu} role="menu">
                                {t.guideRefs.map((r, i) => (
                                  <button key={i} type="button" role="menuitem" className={s.refItem} onClick={() => goRef(r)}>
                                    {guideRefLabelKo(r, part)}
                                  </button>
                                ))}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="u-chip">새 틀</span>
                        )}
                        {otherParts.length > 0 && <span className="u-chip">{[part, ...otherParts].map(guidePartShortKo).join(" · ")} 공통</span>}
                        {TOEIC_TEMPLATE_QUIZ_MODES.map((m) => {
                          const b = badges[m][t.key] ?? "new";
                          return (
                            <span key={m} className={`u-chip ${b === "mastered" ? "u-chip-accent" : ""} ${b === "wrong" ? s.badgeWrong : ""}`}>
                              {TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO[m]} · {TOEIC_TEMPLATE_BADGE_LABELS_KO[b]}
                            </span>
                          );
                        })}
                        {exprLines.map((list, i) => (
                          <span key={`e${i}`} className="u-chip">
                            표현 시험: {list.map((x) => `${TOEIC_QUIZ_MODE_LABELS_KO[x.mode]} ${TOEIC_EXPRESSION_BADGE_LABELS_KO[x.badge]}`).join(" · ")}
                          </span>
                        ))}
                      </div>
                      <ol className={s.examples}>
                        {t.examples.map((ex, j) => (
                          <li key={j} data-ex={j} className={`${s.example} ${isCur && curPiece?.example === j ? s.exampleActive : ""}`}>
                            <div className={s.exampleRow}>
                              <p className={s.exampleEn} lang="en">
                                <ExampleLine frameEn={t.frameEn} fills={ex.fills} />
                              </p>
                              <button type="button" className={s.speak} onClick={() => speak(ex.en.trim(), "en-US")} aria-label={`예문 ${j + 1} 듣기`} title="듣기">
                                🔊
                              </button>
                            </div>
                            <p className={s.exampleKo}>{ex.ko}</p>
                          </li>
                        ))}
                      </ol>
                      <div className={s.cardFoot}>
                        <button type="button" className={s.cardPlay} onClick={() => playSelection("template", { groupKo: g.groupKo, templateKey: t.key })}>
                          ▶ 이 틀 따라 말하기
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          </Fragment>
        );
      })}

      {/* 최근 테스트(§12-5-6) — 그 유형 틀이 든 틀 세션 최신 10개 */}
      <section className={s.recent} aria-label="최근 테스트">
        <h3 className={s.stepHead}>🧩 최근 테스트</h3>
        {recentTests.length === 0 ? (
          <p className={s.recentEmpty}>아직 본 틀 테스트가 없어요. 묶음 옆 &ldquo;🧩 테스트&rdquo;로 시작해요.</p>
        ) : (
          <ol className={s.recentList}>
            {recentTests.map((r) => (
              <li key={r.id} className={s.recentRow}>
                <span className={s.recentWhen}>{r.whenKo}</span>
                <span className="u-chip">{TOEIC_TEMPLATE_TEST_MODE_TAG_KO[r.mode]}</span>
                <span className={s.recentScore}>
                  ○ {r.correct} / {r.answered}
                </span>
                {!r.finished && <span className={s.recentStop}>그만둠</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

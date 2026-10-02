"use client";

/**
 * ① 📖 공략 읽기 + 🔊 (docs/harness/toeic.md §12-4 — SPEC §18-4 관용구 그대로) — 클라이언트 컴포넌트.
 *
 * - 대본은 순수 함수 `buildToeicGuideScript(guide, mode, {pause, pauseLevel})`(lib/toeic-guide)가 만들고 화면은 소비만 한다. 줄 🔊·블록 🔊·
 *   섹션 ▶·"▶ 처음부터"는 **같은 대본의 연속 구간**을 `speakQueue`에 넘긴다(절대 인덱스 오프셋 — 캐시 키가 글자까지 같다). 예문 🔊도
 *   같은 정리 함수(cleanGuideEnForTts)를 거친 글자다.
 * - 재생은 **탭 핸들러 안에서 동기로** `speakQueue`(iOS 재생 잠금). 멈출 때는 큐가 돌려준 stop(stopSpeaking 금지 — 다른 🔊를 죽이지 않게).
 *   실행 번호(runRef)로 옛 실행의 onItem/onEnd를 무시한다.
 * - 정지 조건: 언마운트(탭 전환 포함 — 폴더 뷰가 탭을 바꾸면 이 뷰가 내려간다), 대본 내용 키 변경(모드·틈 토글·틈 단계).
 * - 듣기 바(sticky, top: var(--streak-h)): ▶ 처음부터 / ■ 멈추기 + 진행 `{i+1} / {n}`(aria-live) + 모드 "전부 / 영어만" + "영어만"일 때
 *   **따라 말할 틈 토글(기본 끔)**과 단계(짧게·보통·길게 — 템플릿 따라 말하기와 같은 기기 설정) + ⚙️ 소리 설정(속도·엔진 en/ko).
 * - 지금 읽는 줄(없으면 블록, 섹션 제목) 강조·scrollIntoView(nearest)·scroll-margin-top(바 실제 높이 — ResizeObserver). 재생이 접힌 섹션에
 *   닿으면 그 섹션을 연다. 재생을 시작하면 소리 설정을 접는다.
 * - 프리페치: 열린 섹션들의 **영어 조각만**(toeicGuidePrefetchTexts — 한국어는 큐의 look-ahead에 맡긴다, §18-5 비용 가드). 키는 문자열.
 * - 🧩 칩: 블록 머리(템플릿 줄 label·이어 말하기 머리말이 틀에 연결된 블록 — "🧩 템플릿 훈련 n")와 list 블록 줄 머리(그 줄 영어의 `~`
 *   모양이 틀이 연결한 교재 표현과 같은 줄). 누르면 ② 탭의 그 틀(여럿이면 첫 틀). 판정은 templateLinksForGuide 하나.
 * - `?goto=`(틀 카드의 📘 교재 틀 칩): 그 블록의 섹션을 열고 스크롤·잠깐 강조. `k:{틀 key}`(2026-10-02)는 그 틀의 첫 외울 틀 줄 블록.
 * - 모든 글은 텍스트로만 넣는다(HTML 해석 없음). label·note·marked는 읽지 않는다(화면 표시만).
 *
 * ── 2026-10-02 템플릿 중심 재정렬(docs/harness/toeic.md §12-13-1) — 외울 틀 강조 · 같은 자리 다른 표현 접기 ──
 * - 판정은 순수 함수 `guideReadMarks(sections, 연결 표, 같은 자리 다른 표현 표, 그 유형 틀)` 하나(lib/toeic-guide-view). 화면은 소비만 한다.
 * - **외울 틀 줄**: 강조 띠 + 줄 아래 그 틀의 **틀 줄**(고정 부분 굵게·자리 칩 — ② 카드와 같은 조각)과 틀 줄 머리의 "🧩 외울 틀" 칩(→ ② 그 카드)·
 *   탭 🔊(cleanGuideEnForTts(frameEn) — ② 카드 영어 틀 소개와 같은 글자, 미리 받지 않는다). 줄 영어의 `~` 모양이 그 틀과 같으면 틀 줄을 생략하고
 *   칩을 교재 줄 머리에. 템플릿 줄(label 연결)은 그 label의 첫 줄 아래에 연결된 틀 줄 목록, 이어 말하기 머리말은 머리말 아래에.
 * - **같은 자리 다른 표현**: 블록 통째(altBlocks)는 블록 자리에 닫힌 접기 하나(요약 "↳ 같은 자리 다른 표현" + 캡션 + "외울 틀: {대표 틀}"),
 *   줄 단위(altLines)는 블록 끝의 닫힌 접기 하나("↳ 같은 자리 다른 표현 n줄", 줄마다 "→ 🧩 {대표 틀}"), 이어 말하기 머리말만 접힘(bareBlocks)은
 *   머리말 자리에 접기 + "→ 🧩 {대표 틀}의 끝 자리에 넣어 말해 보세요" + 조각은 머리말 없이 그대로. 대표 틀이 렌더 불가·다른 유형이면 "외울 틀"
 *   표시만 빼고 접는다.
 * - **대본**: 섹션 ▶·▶ 처음부터·진행·프리페치·접히지 않은 줄 🔊·text 블록 🔊는 모두 `skip` 적용 대본(guideReadScriptSkip) — 접은 것은 듣지도
 *   미리 받지도 않고, framePicks 줄은 외울 틀 쪽 대안만, bareBlocks 조각은 조각만 읽는다. **접기 안의 줄 🔊**는 skip 없는 대본에서 그 주소로
 *   거른 조각(toeicGuideLinePieces)을 탭할 때만, 접힌 머리말 🔊는 toeicGuideLeadPieces를 탭할 때만(미리 받지 않는다 — §18-5 비용 가드).
 * - 머리 두 줄(틀 은행이 있을 때만): "🧩 이 유형 외울 틀 n개 · 이 읽기에 나온 것 m개 — 나머지는 🧩 템플릿 훈련에서"(m = guideReadFrameKeys)와
 *   범례(alternates가 비면 그 자리에 다시 가져오기 안내). 맨 끝에 닫힌 "📘 교재 표현 목록"(읽기 전용 — 옛 ③ 탭 목록, 대본·프리페치 밖).
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ToeicGuideExprList from "@/components/toeic-guide-expr-list";
import { FrameLine } from "@/components/toeic-template-lines";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { useToeicShadowSettings } from "@/components/use-toeic-shadow-settings";
import { prefetchSpeech, speakQueue } from "@/lib/speech";
import {
  TOEIC_GUIDE_SCRIPT_MODES,
  TOEIC_GUIDE_SCRIPT_MODE_LABELS_KO,
  buildToeicGuideScript,
  cleanGuideEnForTts,
  guideLineEn,
  splitGuideEnForDisplay,
  toeicGuideBlockKey,
  toeicGuideBlockPieces,
  toeicGuideLeadPieces,
  toeicGuideLineKey,
  toeicGuideLinePieces,
  toeicGuidePrefetchTexts,
  toeicGuideSectionStart,
  type ToeicGuideScriptMode,
  type ToeicGuideScriptPiece,
  type ToeicShadowPauseLevel,
} from "@/lib/toeic-guide";
import type { ToeicGuideBlock, ToeicGuideLine, ToeicGuidePart, ToeicGuideSection, ToeicTemplate, ToeicTemplateAlternate } from "@/lib/toeic-guide-contract";
import {
  findGuideGotoBlock,
  guideBlockTemplateKeys,
  guideGotoAddr,
  guideReadFrameKeys,
  guideReadInitialOpen,
  guideReadMarks,
  guideReadScriptSkip,
  slotToneMap,
} from "@/lib/toeic-guide-view";
import { frameSlotNames, frameToExpression, templateAlternateLinks, templateLinksForGuide, type ToeicTemplateGuideLinks } from "@/lib/toeic-template";
import { expressionKey } from "@/lib/toeic-text";
import { splitForTts } from "@/lib/tts-split";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import type { ToeicGuideExpressionItem } from "./toeic-guide-folder-view";
import s from "./toeic-guide-read-view.module.css";

const PAUSE_LEVEL_LABELS_KO: Record<ToeicShadowPauseLevel, string> = { short: "짧게", normal: "보통", long: "길게" };
const PAUSE_LEVELS: readonly ToeicShadowPauseLevel[] = ["short", "normal", "long"];

/** 실행 무효화 + 큐 멈춤(큐가 돌려준 stop만) */
function haltQueue(runRef: RefObject<number>, stopRef: RefObject<(() => void) | null>) {
  runRef.current++;
  const stop = stopRef.current;
  stopRef.current = null;
  stop?.();
}

type Range = [number, number];

/** 대본 주소 → 연속 구간(줄·블록) / 섹션 첫 조각. 한 줄·한 블록의 조각은 대본에서 이어져 있다(§12-4 표 순서). */
function buildAddress(script: readonly ToeicGuideScriptPiece[]) {
  const line = new Map<string, Range>();
  const block = new Map<string, Range>();
  const extend = (m: Map<string, Range>, k: string, i: number) => {
    const r = m.get(k);
    if (!r) m.set(k, [i, i + 1]);
    else r[1] = i + 1;
  };
  script.forEach((p, i) => {
    if (p.block === null) return;
    extend(block, `${p.section}:${p.block}`, i);
    if (p.line !== null) extend(line, `${p.section}:${p.block}:${p.line}`, i);
  });
  return { line, block };
}

/** 영어 줄 표시 — 자리 칩·형광·밑줄(splitGuideEnForDisplay — 이어 붙이면 원문) */
function EnText({ en, emphasis, underline }: { en: string; emphasis: readonly string[]; underline: readonly string[] }) {
  const segs = splitGuideEnForDisplay(en, emphasis, underline);
  return (
    <>
      {segs.map((g, i) => {
        if (g.slot !== null)
          return (
            <span key={i} className={s.slot}>
              {g.slot}
            </span>
          );
        const cls = [g.emphasis ? s.emph : "", g.underline ? s.under : ""].filter(Boolean).join(" ");
        return cls ? (
          <span key={i} className={cls}>
            {g.text}
          </span>
        ) : (
          <Fragment key={i}>{g.text}</Fragment>
        );
      })}
    </>
  );
}

export default function ToeicGuideReadView({
  part,
  sections,
  expressions,
  templates,
  alternates,
  bankReady,
  alternatesEmpty,
  goto,
  onOpenTemplate,
  onOpenTemplatesTab,
}: {
  part: ToeicGuidePart;
  sections: ToeicGuideSection[];
  /** 공략 세트의 교재 표현(① 끝 읽기 전용 "📘 교재 표현 목록") */
  expressions: ToeicGuideExpressionItem[];
  /** 그 유형의 렌더 가능한 틀(testFills 비움) */
  templates: ToeicTemplate[];
  /** 그 유형의 같은 자리 다른 표현(틀 은행 alternates) */
  alternates: ToeicTemplateAlternate[];
  /** 틀 은행이 렌더 가능하다(머리 두 줄·범례의 조건) */
  bankReady: boolean;
  /** 틀 은행 alternates가 통째로 비었다(다시 가져오기 안내) */
  alternatesEmpty: boolean;
  goto: string | null;
  onOpenTemplate: (key: string) => void;
  onOpenTemplatesTab: () => void;
}) {
  const [mode, setMode] = useState<ToeicGuideScriptMode>("all");
  const [pauseOn, setPauseOn] = useState(false); // "영어만" 따라 말할 틈 — 기본 끔(§12-4), 기억하지 않는다
  const [settings, updateSettings] = useToeicShadowSettings(); // 틈 단계는 템플릿 따라 말하기와 같은 기기 설정
  const pauseLevel = settings.pauseLevel;

  const guide = useMemo(() => ({ sections }), [sections]);
  const links: ToeicTemplateGuideLinks = useMemo(() => templateLinksForGuide({ items: templates }, part), [templates, part]);
  // 외울 틀 강조·같은 자리 다른 표현 접기 판정(§12-13-1) — 틀 은행이 없으면(두 표가 비면) 모든 판정이 빈다
  const altLinks: ToeicTemplateGuideLinks = useMemo(() => templateAlternateLinks({ alternates }, part), [alternates, part]);
  const marks = useMemo(() => guideReadMarks(sections, links, altLinks, templates), [sections, links, altLinks, templates]);
  const skip = useMemo(() => guideReadScriptSkip(marks), [marks]);
  // 섹션 ▶·처음부터·진행·프리페치·접히지 않은 줄 🔊·text 블록 🔊는 skip 적용 대본 하나(접은 것은 듣지도 미리 받지도 않는다)
  const script = useMemo(
    () => buildToeicGuideScript(guide, mode, { pause: mode === "english-only" && pauseOn, pauseLevel, skip }),
    [guide, mode, pauseOn, pauseLevel, skip],
  );
  // 접기 안의 줄 🔊 — skip 없는 대본에서 그 주소로 거른 조각(탭할 때만, 미리 받지 않는다 — 정리 함수가 같아 캐시 키 규칙 그대로)
  const fullScript = useMemo(() => buildToeicGuideScript(guide, mode, { pause: mode === "english-only" && pauseOn, pauseLevel }), [guide, mode, pauseOn, pauseLevel]);
  const scriptKey = useMemo(() => script.map((p) => `${p.lang}|${p.pauseAfterMs}|${p.text}`).join("\n"), [script]);
  const addr = useMemo(() => buildAddress(script), [script]);
  const tplByKey = useMemo(() => new Map(templates.map((t) => [t.key, t] as const)), [templates]);
  const readFrameCount = useMemo(() => guideReadFrameKeys(marks).size, [marks]);

  // ── 섹션 열림(첫 섹션만 열림 + `?goto=` 목표 섹션 — 첫 렌더부터, 서버 HTML 포함) ──
  const [open, setOpen] = useState<Set<number>>(() => new Set(guideReadInitialOpen(sections, goto, marks)));
  const openSection = useCallback((i: number) => setOpen((prev) => (prev.has(i) ? prev : new Set(prev).add(i))), []);

  // ── 재생 ──
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState<{ key: string; index: number } | null>(null);
  const [pausing, setPausing] = useState(false);
  const cur = playing && playing.key === scriptKey && playing.index < script.length ? playing.index : null;
  const curPiece = cur != null ? script[cur] : null;
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);

  // 정지 조건 ① 언마운트(탭 전환 포함) ② 대본 내용 키 변경(모드·틈 토글·틈 단계)
  useEffect(() => () => haltQueue(runRef, stopRef), []);
  useEffect(
    () => () => {
      haltQueue(runRef, stopRef);
      setPlaying(null);
      setPausing(false);
    },
    [scriptKey],
  );

  // 듣기 바 실제 높이 → --guide-bar-h(scroll-margin-top이 쓴다)
  useEffect(() => {
    const bar = barRef.current;
    const wrap = wrapRef.current;
    if (!bar || !wrap || typeof ResizeObserver === "undefined") return;
    const apply = () => wrap.style.setProperty("--guide-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // 재생이 접힌 섹션에 닿으면 연다
  const curSection = curPiece?.section ?? null;
  useEffect(() => {
    if (curSection !== null) openSection(curSection);
  }, [curSection, openSection]);

  // 지금 읽는 줄(없으면 블록, 섹션 제목)로 화면을 따라간다 — 주소가 바뀔 때만
  const activeAddr = curPiece
    ? curPiece.block === null
      ? `s:${curPiece.section}`
      : curPiece.line === null
        ? `b:${curPiece.section}:${curPiece.block}`
        : `l:${curPiece.section}:${curPiece.block}:${curPiece.line}`
    : "";
  useEffect(() => {
    if (!activeAddr) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-addr="${activeAddr}"]`);
    if (!el) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* noop */
    }
    el.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeAddr]);

  /** [start, end) 구간을 이어 읽는다. ⚠️ onClick 안에서 **동기로** 부른다(await·setTimeout 금지 — iOS 재생 잠금). */
  function playRange(start: number, end: number = script.length) {
    if (start < 0 || start >= end || start >= script.length) return;
    const run = ++runRef.current;
    const key = scriptKey;
    stopRef.current = null; // 옛 큐는 speakQueue 안에서 끊긴다(옛 onEnd는 실행 번호로 무시)
    setPausing(false);
    const stop = speakQueue(
      script.slice(start, end).map((p) => ({ text: p.text, lang: p.lang, pauseAfterMs: p.pauseAfterMs })),
      {
        onItem: (i) => {
          if (runRef.current !== run) return;
          setPausing(false);
          setPlaying({ key, index: start + i });
        },
        onPause: () => {
          if (runRef.current === run) setPausing(true);
        },
        onEnd: () => {
          if (runRef.current !== run) return;
          stopRef.current = null;
          setPlaying(null);
          setPausing(false);
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
    if (settingsRef.current) settingsRef.current.open = false; // 커진 sticky 바가 따라가는 줄을 덮지 않게
  }

  /** 예문 🔊 — 대본과 같은 정리 함수를 거친 글자(캐시 키가 같다). 강조 없이 그 문장만 */
  function playExample(en: string) {
    const pieces = splitForTts(cleanGuideEnForTts(en), TTS_TEXT_MAX_CHARS);
    if (pieces.length === 0) return;
    const run = ++runRef.current;
    stopRef.current = null;
    setPlaying(null);
    setPausing(false);
    const stop = speakQueue(
      pieces.map((text) => ({ text, lang: "en-US" })),
      {
        onEnd: () => {
          if (runRef.current === run) stopRef.current = null;
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
  }

  /** 접기 안 줄 🔊·접힌 머리말 🔊·틀 줄 🔊 — 그 조각만(지금 읽는 줄 강조 없이). ⚠️ 탭 핸들러 안에서 동기로 */
  function playPieces(pieces: readonly { text: string; lang: string }[]) {
    if (pieces.length === 0) return;
    const run = ++runRef.current;
    stopRef.current = null;
    setPlaying(null);
    setPausing(false);
    const stop = speakQueue(
      pieces.map((p) => ({ text: p.text, lang: p.lang })),
      {
        onEnd: () => {
          if (runRef.current === run) stopRef.current = null;
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
  }

  /** 틀 줄 🔊 — ② 카드의 영어 틀 소개와 같은 글자(cleanGuideEnForTts) */
  function playFrame(frameEn: string) {
    playPieces(splitForTts(cleanGuideEnForTts(frameEn), TTS_TEXT_MAX_CHARS).map((text) => ({ text, lang: "en-US" })));
  }

  function stopPlayback() {
    haltQueue(runRef, stopRef);
    setPlaying(null);
    setPausing(false);
  }

  // ── 프리페치: 열린 섹션들의 영어 조각(문서 순서·고유) ──
  const prefetchKey = useMemo(() => toeicGuidePrefetchTexts(script, open).join("\u0001"), [script, open]);
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── ?goto= (📘 교재 틀 칩) → 그 블록 ──
  // 스크롤은 목표 섹션의 열림이 **커밋된 뒤**에만 한다(QA final P2-1): 닫힌 <details> 안 블록은 상자가 없어 scrollIntoView가 아무것도
  // 하지 않는다. 옛 모양(openSection → rAF 스크롤)은 rAF가 열림 커밋보다 먼저 돌면 조용히 실패했다(엔진·경로마다 갈리는 경합).
  // - 마운트(② 📘 → ① 앱 안 이동·같은 주소 새로 불러오기·다른 폴더 연결 — 전부 이 뷰가 새로 마운트된다): 목표 섹션이 첫 렌더부터
  //   열려 있다(guideReadInitialOpen) → 아래 효과가 커밋 뒤 바로 스크롤한다(Next의 이동 스크롤은 layout 단계라 그보다 먼저 끝난다).
  // - 마운트된 채 goto가 바뀌면: 효과가 목표를 pendingGotoRef에 남기고 섹션을 연다 → 열림이 커밋된 뒤 layout 효과([open, flash])가 스크롤.
  // 키는 블록 주소 문자열 — 같은 목표면 데이터 새로 고침(sections 새 참조)에 다시 스크롤·강조하지 않는다.
  const gotoHit = useMemo(() => findGuideGotoBlock(sections, goto, marks), [sections, goto, marks]);
  const gotoAddr = guideGotoAddr(gotoHit);
  const gotoSection = gotoHit?.section ?? null;
  const pendingGotoRef = useRef<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** 남은 goto 목표를 스크롤한다 — 그 블록의 섹션 열림이 아직 커밋되지 않았으면 남겨 두고 다음 커밋에 다시 본다 */
  const scrollPendingGoto = useCallback(() => {
    const k = pendingGotoRef.current;
    if (!k) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-addr="${k}"]`);
    if (!el) return;
    const details = el.closest("details");
    if (details && !details.open) return;
    pendingGotoRef.current = null;
    el.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    if (gotoAddr === null || gotoSection === null) return;
    pendingGotoRef.current = gotoAddr;
    openSection(gotoSection);
    setFlash(gotoAddr);
    scrollPendingGoto();
    const t = window.setTimeout(() => setFlash(null), 2400);
    return () => {
      window.clearTimeout(t);
      pendingGotoRef.current = null;
    };
  }, [gotoAddr, gotoSection, openSection, scrollPendingGoto]);
  useLayoutEffect(() => {
    scrollPendingGoto();
  }, [open, flash, scrollPendingGoto]);

  // 목차 칩 → 섹션 머리 줄(summary). summary에만 scroll-margin-top(스트릭 + 듣기 바)이 있다 — <details>로 스크롤하면 머리 줄이
  // sticky 덮개 밑에 가린다(QA final P3-N1). summary는 섹션이 닫혀 있어도 상자가 있어 rAF 시점과 무관하다.
  function jumpToSection(i: number) {
    openSection(i);
    window.requestAnimationFrame(() => {
      wrapRef.current?.querySelector<HTMLElement>(`summary[data-addr="s:${i}"]`)?.scrollIntoView({ block: "start" });
    });
  }

  // ── 목차 칩 무리(groupKo — 이어진 섹션끼리) ──
  const tocGroups = useMemo(() => {
    const out: { groupKo: string | null; items: number[] }[] = [];
    sections.forEach((sec, i) => {
      const last = out[out.length - 1];
      if (last && last.groupKo === sec.groupKo) last.items.push(i);
      else out.push({ groupKo: sec.groupKo, items: [i] });
    });
    return out;
  }, [sections]);

  // ── 렌더 헬퍼(컴포넌트가 아니라 함수 — 재생 중 조각마다 다시 그려도 버튼이 재마운트되지 않게) ──
  const isActive = (a: string) => activeAddr === a;

  function speakBtn(range: Range | undefined, label: string) {
    if (!range) return null;
    return (
      <button type="button" className={s.speak} onClick={() => playRange(range[0], range[1])} aria-label={`${label} 듣기`} title="듣기">
        🔊
      </button>
    );
  }

  /** 접기 안의 🔊 — skip 없는 대본의 그 조각을 탭할 때만(미리 받지 않는다) */
  function foldSpeakBtn(pieces: readonly { text: string; lang: string }[], label: string) {
    if (pieces.length === 0) return null;
    return (
      <button type="button" className={s.speak} onClick={() => playPieces(pieces)} aria-label={`${label} 듣기`} title="듣기">
        🔊
      </button>
    );
  }

  function tplChip(keys: readonly string[], text: string, aria: string): ReactNode {
    if (keys.length === 0) return null;
    return (
      <button type="button" className={s.tplChip} onClick={() => onOpenTemplate(keys[0])} aria-label={aria}>
        {text}
      </button>
    );
  }

  /** 외울 틀 줄 아래의 **틀 줄** — 칩 "🧩 외울 틀"(→ ② 카드)은 틀 줄 머리, 탭 🔊(미리 받지 않는다) */
  function frameRows(keys: readonly string[]): ReactNode {
    const list = keys.map((k) => tplByKey.get(k)).filter((t): t is ToeicTemplate => t !== undefined);
    if (list.length === 0) return null;
    return (
      <div className={s.frameRows}>
        {list.map((t) => (
          <div key={t.key} className={s.frameRow} data-testid={`read-frame-${t.key}`}>
            <div className={s.frameRowHead}>
              <button type="button" className={s.tplChip} onClick={() => onOpenTemplate(t.key)} aria-label="이 틀의 템플릿 훈련 카드로">
                🧩 외울 틀
              </button>
              <button type="button" className={s.speak} onClick={() => playFrame(t.frameEn)} aria-label="외울 틀 듣기" title="듣기">
                🔊
              </button>
            </div>
            <p className={s.frameEn} lang="en">
              <FrameLine frame={t.frameEn} tones={slotToneMap(frameSlotNames(t.frameEn))} lang="en" />
            </p>
          </div>
        ))}
      </div>
    );
  }

  /** 대표 틀(같은 자리 다른 표현이 가리키는 외울 틀 — coveredBy 첫 key)의 `~` 형태 칩. 렌더 불가·다른 유형이면 null(접기는 한다) */
  function repChip(keys: readonly string[] | undefined, prefix: string, suffix = ""): ReactNode {
    const t = keys && keys.length > 0 ? tplByKey.get(keys[0]) : undefined;
    if (!t) return null;
    return (
      <button
        type="button"
        className={s.repChip}
        onClick={(e) => {
          e.preventDefault(); // <summary> 안에서도 접기를 여닫지 않게
          e.stopPropagation();
          onOpenTemplate(t.key);
        }}
        aria-label="외울 틀의 템플릿 훈련 카드로"
      >
        {prefix}
        <span lang="en">{frameToExpression(t.frameEn)}</span>
        {suffix}
      </button>
    );
  }

  /**
   * 줄 하나. `folded`면 접기 안(🔊는 skip 없는 대본 조각 — 탭할 때만, 강조·스크롤 대상 아님). `frameKeys`가 있으면 외울 틀 줄(강조 띠) —
   * `rows`면 그 틀 줄을 아래에 보인다(줄 영어의 `~` 모양이 그 틀과 같으면 틀 줄 대신 칩을 교재 줄 머리에).
   */
  function renderLine(
    block: ToeicGuideBlock,
    line: ToeicGuideLine,
    si: number,
    bi: number,
    li: number | "lead",
    opts: { ghostLead: boolean; folded?: boolean; rows?: boolean },
  ) {
    const a = `l:${si}:${bi}:${li}`;
    const lineKey = toeicGuideLineKey(si, bi, li);
    const readEn = guideLineEn(block, line);
    const frameKeys = opts.folded ? [] : (marks.frameLines.get(lineKey) ?? []);
    const lineExprKey = line.en ? expressionKey(frameToExpression(line.en)) : "";
    const sameKeys = frameKeys.filter((k) => {
      const t = tplByKey.get(k);
      return t !== undefined && lineExprKey !== "" && expressionKey(frameToExpression(t.frameEn)) === lineExprKey;
    });
    const rowKeys = opts.rows === false ? [] : frameKeys.filter((k) => !sameKeys.includes(k));
    const lead = block.kind === "lines" && block.style === "completions" ? block.lead : null;
    const speak = (label: string) =>
      opts.folded ? foldSpeakBtn(toeicGuideLinePieces(fullScript, si, bi, li), label) : speakBtn(addr.line.get(`${si}:${bi}:${li}`), label);
    // 손 표시(✎)는 줄 머리의 작은 표시 — 따로 줄을 차지하지 않게 글 앞에 붙인다(읽지 않는다)
    const marked = line.marked ? (
      <span className={s.marked} title="교재에 손으로 표시한 줄" aria-label="교재에 표시한 줄">
        ✎{" "}
      </span>
    ) : null;
    return (
      <div
        key={String(li)}
        data-addr={opts.folded ? undefined : a}
        className={`${s.line} ${frameKeys.length > 0 ? s.frameLine : ""} ${!opts.folded && isActive(a) ? s.active : ""}`}
      >
        {(line.label || sameKeys.length > 0) && (
          <div className={s.lineHead}>
            {line.label && <span className={s.label}>{line.label}</span>}
            {tplChip(sameKeys, "🧩 외울 틀", "이 줄의 템플릿 훈련 카드로")}
          </div>
        )}
        {line.en !== null && (
          <div className={s.enRow}>
            <p className={s.en} lang="en">
              {marked}
              {opts.ghostLead && lead?.en ? <span className={s.ghost}>{lead.en.trimEnd()} </span> : null}
              <EnText en={opts.ghostLead ? line.en.trimStart() : line.en} emphasis={line.emphasis} underline={line.underline} />
            </p>
            {readEn !== null && speak("이 줄")}
          </div>
        )}
        {line.en === null && line.ko !== null && (
          <div className={s.enRow}>
            <p className={s.ko}>
              {marked}
              {line.ko}
            </p>
            {speak("이 줄")}
          </div>
        )}
        {line.en !== null && line.ko !== null && <p className={s.ko}>{line.ko}</p>}
        {line.note !== null && <p className={s.note}>{line.note}</p>}
        {line.example && (
          <div className={s.example}>
            <span className={s.exampleTag}>예</span>
            <p className={s.exampleEn} lang="en">
              <EnText en={line.example.en} emphasis={line.example.emphasis} underline={[]} />
              {line.example.ko && <span className={s.exampleKo}>{line.example.ko}</span>}
            </p>
            <button type="button" className={s.speak} onClick={() => playExample(line.example!.en)} aria-label="예문 듣기" title="듣기">
              🔊
            </button>
          </div>
        )}
        {rowKeys.length > 0 && frameRows(rowKeys)}
      </div>
    );
  }

  /** 블록 끝 줄 단위 접기 — 한 블록 안의 같은 자리 다른 표현 줄들을 닫힌 접기 하나로(줄마다 "→ 🧩 {대표 틀}") */
  function altLinesFold(block: ToeicGuideBlock, si: number, bi: number, items: { line: ToeicGuideLine; li: number | "lead" }[]) {
    if (items.length === 0) return null;
    return (
      <details className={s.altFold} data-testid={`read-alt-lines-${si}-${bi}`}>
        <summary className={s.altSummary}>↳ 같은 자리 다른 표현 {items.length}줄</summary>
        <div className={s.altBody}>
          {items.map(({ line, li }) => (
            <div key={String(li)} className={s.altItem}>
              {renderLine(block, line, si, bi, li, { ghostLead: false, folded: true })}
              <p className={s.altPointer}>{repChip(marks.altLines.get(toeicGuideLineKey(si, bi, li)), "→ 🧩 ")}</p>
            </div>
          ))}
        </div>
      </details>
    );
  }

  /** 블록 안을 그린다 — `folded`면 블록 통째 접기 안(🔊는 skip 없는 대본 조각, 접기·강조 판정 없음) */
  function renderBlockInner(block: ToeicGuideBlock, si: number, bi: number, folded: boolean) {
    const blockKey = toeicGuideBlockKey(si, bi);
    const isAlt = (li: number | "lead") => !folded && marks.altLines.has(toeicGuideLineKey(si, bi, li));
    if (block.kind === "heading") return null;
    if (block.kind === "text") {
      const blockSpeak = folded
        ? foldSpeakBtn(toeicGuideBlockPieces(fullScript, si, bi), "이 설명")
        : speakBtn(addr.block.get(`${si}:${bi}`), "이 설명"); // skip 적용 대본(script)의 그 블록 조각 — 접은 줄은 빠져 있다
      const altItems = block.lines.flatMap((ln, li) => (isAlt(li) ? [{ line: ln, li }] : []));
      return (
        <>
          {(block.label || block.titleKo) && (
            <div className={s.blockHead}>
              {block.label && <span className={s.label}>{block.label}</span>}
              {block.titleKo && <span className={s.blockTitle}>{block.titleKo}</span>}
              {blockSpeak}
            </div>
          )}
          {block.bodyKo && (
            <div className={s.enRow}>
              <p className={s.body}>{block.bodyKo}</p>
              {!block.label && !block.titleKo && blockSpeak}
            </div>
          )}
          {block.lines.map((ln, li) => (isAlt(li) ? null : renderLine(block, ln, si, bi, li, { ghostLead: false, folded })))}
          {altLinesFold(block, si, bi, altItems)}
        </>
      );
    }
    const blockKeys = guideBlockTemplateKeys(links, block);
    const bare = !folded && block.style === "completions" && marks.bareBlocks.has(blockKey);
    const leadKey = toeicGuideLineKey(si, bi, "lead");
    const leadFrameKeys = folded ? [] : (marks.frameLines.get(leadKey) ?? []);
    const altItems: { line: ToeicGuideLine; li: number | "lead" }[] = [];
    if (block.style !== "completions" && block.lead && isAlt("lead")) altItems.push({ line: block.lead, li: "lead" });
    block.lines.forEach((ln, li) => {
      if (isAlt(li)) altItems.push({ line: ln, li });
    });
    // 템플릿 줄: 그 label의 첫 줄 아래에만 연결된 틀 줄 목록(같은 label의 다른 줄은 강조 띠만)
    const seenLabels = new Set<string>();
    let renderedTplRows = 0;
    return (
      <>
        {(block.captionKo || blockKeys.length > 0) && (
          <div className={s.blockHead}>
            {block.captionKo && <span className={s.blockTitle}>{block.captionKo}</span>}
            {tplChip(blockKeys, `🧩 템플릿 훈련 ${blockKeys.length}`, "이 블록의 템플릿 훈련 틀로")}
          </div>
        )}
        {block.style === "completions" && block.lead && bare && (
          <>
            <details className={s.altFold} data-testid={`read-bare-lead-${si}-${bi}`}>
              <summary className={s.altSummary}>↳ 같은 자리 다른 표현 — 머리말</summary>
              <div className={s.altBody}>
                <div className={s.enRow}>
                  <p className={s.leadEn} lang="en">
                    {block.lead.en} <span className={s.leadDots}>…</span>
                  </p>
                  {foldSpeakBtn(toeicGuideLeadPieces(block, si, bi, mode), "이 머리말")}
                </div>
                {block.lead.ko && <p className={s.ko}>{block.lead.ko}</p>}
              </div>
            </details>
            <p className={s.altPointer}>{repChip(marks.bareBlocks.get(blockKey), "→ 🧩 ", "의 끝 자리에 넣어 말해 보세요")}</p>
          </>
        )}
        {block.style === "completions" && block.lead && !bare && (
          <div
            data-addr={folded ? undefined : `l:${si}:${bi}:lead`}
            className={`${s.lead} ${leadFrameKeys.length > 0 ? s.frameLine : ""} ${!folded && isActive(`l:${si}:${bi}:lead`) ? s.active : ""}`}
          >
            {block.lead.marked && (
              <span className={s.marked} aria-label="교재에 표시한 줄">
                ✎
              </span>
            )}
            <p className={s.leadEn} lang="en">
              {block.lead.en} <span className={s.leadDots}>…</span>
            </p>
            {block.lead.ko && <p className={s.ko}>{block.lead.ko}</p>}
            {leadFrameKeys.length > 0 && frameRows(leadFrameKeys)}
          </div>
        )}
        {block.style !== "completions" && block.lead && !isAlt("lead") && (
          <div className={s.leadLine}>{renderLine(block, block.lead, si, bi, "lead", { ghostLead: false, folded })}</div>
        )}
        {block.style === "template" ? (
          <div className={s.tplRows}>
            {block.lines.map((ln, li) => {
              if (isAlt(li)) return null;
              const firstOfLabel = ln.label !== null && !seenLabels.has(ln.label);
              if (ln.label !== null) seenLabels.add(ln.label);
              const sep = ln.alt && renderedTplRows > 0;
              renderedTplRows++;
              return (
                <Fragment key={li}>
                  {sep && <p className={s.altSep}>또는</p>}
                  <div className={s.tplRow}>
                    <span className={s.tplLabel}>{ln.label ?? ""}</span>
                    <div className={s.tplCell}>
                      {renderLine(block, { ...ln, label: null }, si, bi, li, { ghostLead: false, folded, rows: firstOfLabel })}
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        ) : (
          block.lines.map((ln, li) =>
            isAlt(li) ? null : renderLine(block, ln, si, bi, li, { ghostLead: block.style === "completions" && !bare, folded }),
          )
        )}
        {altLinesFold(block, si, bi, altItems)}
      </>
    );
  }

  function renderBlock(block: ToeicGuideBlock, si: number, bi: number) {
    const a = `b:${si}:${bi}`;
    const blockKey = toeicGuideBlockKey(si, bi);
    if (block.kind === "heading") {
      return (
        <h4 key={bi} data-addr={a} className={`${s.heading} ${isActive(a) ? s.active : ""}`}>
          {block.textKo}
        </h4>
      );
    }
    const altBlock = marks.altBlocks.get(blockKey);
    if (altBlock) {
      // 블록 통째 — 같은 자리 다른 표현(접기를 열면 지금 모양 그대로, 줄 🔊는 탭으로만)
      const caption = block.kind === "text" ? block.titleKo : block.captionKo;
      return (
        <details key={bi} data-addr={a} className={`${s.altFold} ${s.altBlockFold}`} data-testid={`read-alt-block-${si}-${bi}`}>
          <summary className={s.altSummary}>
            <span>↳ 같은 자리 다른 표현{caption ? ` · ${caption}` : ""}</span>
            {repChip(altBlock, "외울 틀: ")}
          </summary>
          <div className={`${s.block} ${s.altBlockBody}`}>{renderBlockInner(block, si, bi, true)}</div>
        </details>
      );
    }
    const cls = `${s.block} ${isActive(a) ? s.active : ""} ${flash === a ? s.flash : ""}`;
    return (
      <div key={bi} data-addr={a} className={`${cls} ${block.kind === "lines" && block.style === "template" ? s.templateBlock : ""}`}>
        {renderBlockInner(block, si, bi, false)}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={s.wrap}>
      {/* 머리 두 줄(§12-13-1 — 틀 은행이 있을 때만): 외울 틀 수 대 이 읽기에 나온 수 · 범례(또는 다시 가져오기 안내) */}
      {bankReady && templates.length > 0 && (
        <div className={s.frameHead} data-testid="read-head">
          <button type="button" className={s.frameHeadLink} onClick={onOpenTemplatesTab}>
            🧩 이 유형 외울 틀 {templates.length}개 · 이 읽기에 나온 것 {readFrameCount}개 — 나머지는 🧩 템플릿 훈련에서
          </button>
          {alternatesEmpty ? (
            <p className={s.legend}>접힌 &lsquo;같은 자리 다른 표현&rsquo;이 아직 없어요 — 공략 파일을 이번 업데이트 뒤 한 번 다시 가져오면 생겨요(📂).</p>
          ) : (
            <p className={s.legend}>
              <span className={s.legendFrame}>🧩 외울 틀</span> · 보통 줄 = 예·참고 · ↳ 접힘 = 같은 자리 다른 표현(안 외워도 돼요)
            </p>
          )}
        </div>
      )}

      {/* 목차 칩 — groupKo로 무리 짓는다(대본에는 넣지 않는다) */}
      {sections.length > 1 && (
        <nav aria-label="공략 목차" className={s.toc}>
          {tocGroups.map((g, gi) => (
            <div key={gi} className={s.tocGroup}>
              {g.groupKo && <span className={s.tocGroupName}>{g.groupKo}</span>}
              {g.items.map((i) => (
                <button key={i} type="button" className={s.tocChip} onClick={() => jumpToSection(i)}>
                  {sections[i].label ? `${sections[i].label} · ` : ""}
                  {sections[i].titleKo}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}

      {/* 듣기 바 — sticky(스트릭 헤드라인 아래) */}
      <div ref={barRef} className={s.bar}>
        <div className={s.barRow}>
          <div role="group" aria-label="읽는 방식" className={s.modes}>
            {TOEIC_GUIDE_SCRIPT_MODES.map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`${s.modeChip} ${mode === m ? s.modeOn : ""}`}>
                {TOEIC_GUIDE_SCRIPT_MODE_LABELS_KO[m]}
              </button>
            ))}
          </div>
          {mode === "english-only" && (
            <div role="group" aria-label="따라 말할 틈" className={s.modes}>
              <button type="button" aria-pressed={pauseOn} onClick={() => setPauseOn((v) => !v)} className={`${s.modeChip} ${pauseOn ? s.modeOn : ""}`}>
                🗣️ 따라 말할 틈 {pauseOn ? "켬" : "끔"}
              </button>
              {pauseOn &&
                PAUSE_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    aria-pressed={pauseLevel === lv}
                    onClick={() => updateSettings({ pauseLevel: lv })}
                    className={`${s.modeChip} ${pauseLevel === lv ? s.modeOn : ""}`}
                  >
                    {PAUSE_LEVEL_LABELS_KO[lv]}
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className={s.barRow}>
          {cur != null ? (
            <button type="button" className="u-btn u-btn-primary" onClick={stopPlayback}>
              ■ 멈추기
            </button>
          ) : (
            <button type="button" className="u-btn u-btn-primary" onClick={() => playRange(0)} disabled={script.length === 0}>
              ▶ 처음부터
            </button>
          )}
          <span className={s.progress} aria-live="polite">
            {cur != null ? `${cur + 1} / ${script.length}` : `${script.length}조각`}
            {cur != null && pausing ? " · 🗣️ 따라 말해 보세요" : ""}
          </span>
          <details className={s.settings} ref={settingsRef}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="en-US" />
              <TtsEngineControl lang="ko-KR" />
            </div>
          </details>
        </div>
      </div>

      {/* 섹션 — 접기(첫 섹션만 열림) */}
      {sections.map((sec, si) => {
        const start = toeicGuideSectionStart(script, si);
        const titleA = `s:${si}`;
        return (
          <details
            key={si}
            data-sec={si}
            className={s.section}
            open={open.has(si)}
            onToggle={(e) => {
              if (e.target !== e.currentTarget) return; // 안쪽 접기(같은 자리 다른 표현)의 여닫기는 섹션 열림이 아니다
              const isOpen = (e.currentTarget as HTMLDetailsElement).open;
              setOpen((prev) => {
                if (prev.has(si) === isOpen) return prev;
                const next = new Set(prev);
                if (isOpen) next.add(si);
                else next.delete(si);
                return next;
              });
            }}
          >
            <summary data-addr={titleA} className={`${s.sectionHead} ${isActive(titleA) ? s.active : ""}`}>
              <span className={s.sectionTitle}>
                {sec.label && <span className={s.sectionLabel}>{sec.label}</span>}
                {sec.titleKo}
              </span>
              {start >= 0 && (
                <button
                  type="button"
                  className={s.sectionPlay}
                  onClick={(e) => {
                    e.preventDefault(); // summary 접기와 겹치지 않게
                    openSection(si);
                    playRange(start);
                  }}
                  aria-label={`${sec.titleKo}부터 듣기`}
                >
                  ▶
                </button>
              )}
            </summary>
            {sec.introKo && <p className={s.sectionIntro}>{sec.introKo}</p>}
            <div className={s.blocks}>{sec.blocks.map((b, bi) => renderBlock(b, si, bi))}</div>
          </details>
        );
      })}

      {/* ① 끝 — 📘 교재 표현 목록(읽기 전용, §12-13-1 · §12-12 34): 시험·?expr=·미리 받기 없음, 대본에 들지 않는다 */}
      {expressions.length > 0 && (
        <details className={s.exprFold} data-testid="read-expr-list">
          <summary className={s.exprFoldSummary}>📘 교재 표현 목록 {expressions.length}개</summary>
          <ToeicGuideExprList part={part} expressions={expressions} templates={templates} alternates={alternates} onOpenTemplate={onOpenTemplate} />
        </details>
      )}
    </div>
  );
}

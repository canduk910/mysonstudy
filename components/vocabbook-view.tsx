"use client";

/**
 * 단어장 상세 렌더러 (단어장 정복 V2) — 클라이언트 컴포넌트.
 *
 * 서버(`app/english/vocab/[id]/page.tsx`)는 데이터 로딩·404 판정과 정적 헤더/푸터만 하고, 표/카드
 * 토글·이어읽기·TTS가 붙는 본문은 여기서 그린다(전부 브라우저 상태). AI 호출·비용은 없다.
 *
 * ── 표 모드 vs 카드 모드 레이아웃 (V2-fit) ─────────────────────────────────
 * - **표 모드**: 서버 페이지의 헤더/푸터가 정상 문서 흐름으로 그대로 보인다(회귀 0). 이 컴포넌트는
 *   토글 툴바 + V1 표만 그린다.
 * - **카드 모드**: `100dvh` 전면 오버레이(position:fixed)로 뜬다. 서버 헤더는 큼직해서 카드 프레임을
 *   화면 밖으로 밀어내므로, 카드 모드에서는 **컴팩트한 클라이언트 chrome**(← 목록·제목·토글·힌트를
 *   슬림한 띠로)로 대체하고 그 아래를 `flex:1; min-height:0` 스크롤러가 정확히 채운다 →
 *   "한 화면 = 카드 한 장, 문서 스크롤 0". 오버레이가 뜬 동안 body 스크롤을 잠근다(모달과 같은 규약).
 *   프레임 높이를 매직 px로 빼지 않으므로 헤더가 줄바꿈돼도 안 깨진다.
 *
 * ── 세 기능 (V2) ──────────────────────────────────────────────────────────
 * 1. 표/카드 토글 — 고른 모드는 localStorage에 기억하되 **초기 렌더는 항상 표**(SSR=첫 클라 렌더 일치,
 *    hydration mismatch 회피), useEffect 마운트 후 저장값 반영.
 * 2. 단어·예문 스피커 — `lib/speech.ts`의 speak() 재사용(내부 지원 가드 → 항상 그려도 안전).
 * 3. 이어읽기(드래그+키보드) — 예문을 토큰으로 쪼개 연속 구간을 드래그로 골라 speakSequence로 한 문장처럼.
 *    **모드 토글 필수**: ON일 때만 예문이 선택 표면(touch-action:none)이 되고, OFF면 평범한 텍스트라
 *    세로 스크롤·탭이 그대로 산다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { isVocabBookEnriched } from "@/lib/ai/english/vocabbook-enrich";
import {
  PART_OF_SPEECH_LABELS_KO,
  RELATED_KIND_LABELS_KO,
  resolveVocabImage,
  type VocabEntry,
} from "@/lib/ai/english/vocabbook-schemas";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speak, speakSequence, stopSpeaking } from "@/lib/speech";
import type { VocabEnrichResponse } from "@/lib/vocab-enrich-contract";
import s from "./vocabbook-view.module.css";

const VIEW_MODE_KEY = "vocab-view-mode";
type ViewMode = "table" | "card";

interface VocabbookViewProps {
  /** 보강(호출 D) 라우트·시험 보기 링크가 부를 대상 레코드 id */
  id: string;
  entries: VocabEntry[];
  /** 카드 모드 컴팩트 chrome에 쓸 제목 (표 모드는 서버 헤더를 그대로 씀) */
  titleKo: string;
  /** 단원 표기(예: "DAY 01"). 제목과 다르면 컴팩트 chrome에 덧붙인다 */
  dayLabel: string | null;
  /** 시험 게이트 — 서버가 계산해 전달(정의 있는 단어 ≥ 최소치). false면 시험 보기를 비활성으로 안내한다 */
  canQuiz: boolean;
}

/** 보강 버튼 상태 — 로딩 중엔 재클릭을 막고, 끝나면 안내 배너를 남긴다 */
type EnrichPhase = "idle" | "loading" | "done" | "error";

export default function VocabbookView({ id, entries, titleKo, dayLabel, canQuiz }: VocabbookViewProps) {
  const router = useRouter();
  // 초기 렌더는 항상 표 — SSR과 첫 클라이언트 렌더가 같아야 hydration mismatch가 안 난다
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [readAlong, setReadAlong] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // 보강 상태 — 모드 토글을 넘어 유지되도록 최상위에 둔다(성공 배너가 표↔카드 전환에도 남는다).
  const [enrichPhase, setEnrichPhase] = useState<EnrichPhase>("idle");
  const [enrichMessage, setEnrichMessage] = useState<string | null>(null);

  // 정의 불변의 UI 측 단일 정의처는 저장된 entries다 — record.enriched를 믿지 않고 여기서 계산해
  // 서버 재조회(router.refresh) 뒤 자동으로 갱신되게 한다.
  const remainingDefs = entries.filter((e) => e.definitionEn === null).length;
  const enriched = isVocabBookEnriched(entries);
  const hasAnyDefinition = entries.some((e) => e.definitionEn !== null);

  async function runEnrich() {
    if (enrichPhase === "loading") return; // 중복 클릭 방어
    setEnrichPhase("loading");
    setEnrichMessage(null);
    try {
      const res = await fetch(`/api/english/vocab/${id}/enrich`, { method: "POST" });
      const data = (await res.json()) as VocabEnrichResponse;
      if (data.ok) {
        // 성공(부분 성공 포함) — 서버가 null 자리만 채웠다. 최신 entries를 다시 받아 그린다.
        const parts: string[] = [];
        if (data.filledDefinitions > 0) parts.push(`영영 뜻 ${data.filledDefinitions}개`);
        if (data.filledEmojis > 0) parts.push(`그림 ${data.filledEmojis}개`);
        const made = parts.length > 0 ? parts.join(" · ") + "를 새로 붙였어요." : "새로 채운 건 없었어요.";
        const tail =
          data.remainingDefinitions > 0
            ? ` 아직 ${data.remainingDefinitions}개가 남았어요 — 다시 만들기를 눌러 보세요.`
            : " 이제 모든 단어에 영영 뜻이 있어요!";
        setEnrichMessage(made + tail);
        setEnrichPhase("done");
        router.refresh(); // 서버 컴포넌트를 다시 그려 새 entries를 받는다(클라 상태는 유지)
      } else {
        setEnrichMessage(data.messageKo);
        setEnrichPhase("error");
      }
    } catch {
      setEnrichMessage("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setEnrichPhase("error");
    }
  }

  // 마운트 후 저장값 반영 (저장값이 없거나 못 읽어도 표 유지)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === "card" || saved === "table") setViewMode(saved);
    } catch {
      /* localStorage 접근 불가(프라이빗 모드 등) — 표로 둔다 */
    }
  }, []);

  // 카드 모드는 전면 오버레이 — 뜬 동안 body 스크롤을 잠가 문서 스크롤이 안 생기게 한다.
  // 공용 ref-count 락을 쓴다(드로어·크롭 모달과 중첩돼도 락이 안 샌다 — lib/scroll-lock.ts)
  useEffect(() => {
    if (viewMode !== "card") return;
    return lockBodyScroll();
  }, [viewMode]);

  // 카드 모드에서 지금 보이는 카드 번호 추적 (n / 전체 배지)
  useEffect(() => {
    if (viewMode !== "card") return;
    const root = scrollerRef.current;
    if (!root) return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (obs) => {
        for (const oe of obs) {
          const idx = Number((oe.target as HTMLElement).dataset.cardIndex);
          if (Number.isInteger(idx)) ratios.set(idx, oe.intersectionRatio);
        }
        let bestIdx = 0;
        let bestRatio = -1;
        ratios.forEach((r, idx) => {
          if (r > bestRatio) {
            bestRatio = r;
            bestIdx = idx;
          }
        });
        setActiveIndex(bestIdx);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    root.querySelectorAll<HTMLElement>("[data-card-index]").forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [viewMode, entries.length]);

  function chooseMode(mode: ViewMode) {
    setViewMode(mode);
    stopSpeaking(); // 표↔카드 전환 때 읽던 문장을 끊는다
    if (mode === "table") setReadAlong(false);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* 저장 실패는 조용히 무시 — 이번 세션만 못 기억할 뿐 */
    }
  }

  function toggleReadAlong() {
    setReadAlong((v) => {
      if (v) stopSpeaking(); // 끌 때 읽던 것 정지
      return !v;
    });
  }

  // 표/카드 토글 — 두 chrome(표 툴바·카드 오버레이)에서 같은 모양으로 쓴다
  const modeToggle = (
    <div role="group" aria-label="보기 방식" className={s.modeGroup}>
      <button
        type="button"
        onClick={() => chooseMode("table")}
        aria-pressed={viewMode === "table"}
        className={`u-btn ${s.modeBtn} ${viewMode === "table" ? "u-btn-primary" : "u-btn-secondary"}`}
      >
        표
      </button>
      <button
        type="button"
        onClick={() => chooseMode("card")}
        aria-pressed={viewMode === "card"}
        className={`u-btn ${s.modeBtn} ${viewMode === "card" ? "u-btn-primary" : "u-btn-secondary"}`}
      >
        카드
      </button>
    </div>
  );

  // 시험 보기 — 표 툴바에서 표/카드 토글과 한 줄 동급. 게이트(canQuiz)가 false면 비활성 + 사유를
  // 곁들여, "영영 뜻을 먼저 만들면 시험을 볼 수 있다"는 흐름을 바로 옆 보강 버튼과 함께 읽히게 한다.
  const quizButton = canQuiz ? (
    <Link href={`/english/vocab/${id}/quiz`} className={`u-btn u-btn-primary ${s.modeBtn}`}>
      <span aria-hidden>📝</span> 시험 보기
    </Link>
  ) : (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title="영영 뜻을 먼저 만들면 시험을 볼 수 있어요"
      className={`u-btn u-btn-secondary ${s.modeBtn}`}
    >
      <span aria-hidden>📝</span> 시험 보기
    </button>
  );

  // 보강 버튼 — 표 툴바(전체)와 카드 chrome(컴팩트)에서 같은 handler를 쓴다. enriched면 숨긴다.
  const enrichLabel = hasAnyDefinition
    ? `영영 뜻 다시 만들기${remainingDefs > 0 ? ` (${remainingDefs})` : ""}`
    : "영영 뜻 만들기";
  const enrichButton = enriched ? null : (
    <button
      type="button"
      onClick={runEnrich}
      disabled={enrichPhase === "loading"}
      className={`u-btn u-btn-primary ${s.enrichBtn}`}
    >
      {enrichPhase === "loading" ? (
        <>
          <span aria-hidden>⏳</span> 만드는 중…
        </>
      ) : (
        <>
          <span aria-hidden>✨</span> {enrichLabel}
        </>
      )}
    </button>
  );
  const enrichBanner = enrichMessage ? (
    <p role="status" className={`${s.enrichMsg} ${enrichPhase === "error" ? s.enrichMsgError : ""}`}>
      {enrichMessage}
    </p>
  ) : null;

  if (viewMode === "table") {
    return (
      <>
        <div className={s.toolbar}>
          {modeToggle}
          {quizButton}
          {enrichButton}
        </div>
        {/* 정의 불변을 문구로도 드러낸다 — "다시 만들기"가 이미 있는 정의를 안 건드림을 안내 */}
        {enriched ? null : (
          <p className={`t-caption ${s.enrichNote}`}>
            {hasAnyDefinition
              ? "이미 만든 영영 뜻은 그대로 둬요 — 비어 있는 단어만 채워요."
              : "영영 뜻과 그림을 붙이면 카드·시험에 쓸 수 있어요. 이모지가 없으면 첫 글자로 표시돼요."}
          </p>
        )}
        {enrichBanner}
        <TableView entries={entries} />
      </>
    );
  }

  // 카드 모드 — 100dvh 전면 오버레이 (chrome=auto + 스크롤러=flex:1/min-height:0)
  const daySuffix = dayLabel && dayLabel !== titleKo ? ` · ${dayLabel}` : "";
  return (
    <div className={s.cardOverlay} role="dialog" aria-label="단어 카드 보기">
      <div className={s.cardInner}>
        <div className={s.cardChrome}>
          <div className={s.chromeRow}>
            <div className={s.chromeTitle}>
              <Link href="/english/vocab" className={`u-navbtn ${s.backBtn}`}>
                ← 목록
              </Link>
              <span className={`t-caption ${s.titleText}`}>
                {titleKo}
                {daySuffix} · {entries.length}개
              </span>
            </div>
            {modeToggle}
          </div>
          <div className={s.chromeRow2}>
            <button
              type="button"
              onClick={toggleReadAlong}
              aria-pressed={readAlong}
              className={`u-btn ${s.modeBtn} ${readAlong ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              <span aria-hidden>👆</span> 이어읽기
            </button>
            {enrichButton}
            <span className={`t-caption ${s.hintText}`} role="status">
              {readAlong ? "단어를 누르면 하나씩, 쓸어서 이어 읽어요" : "↕ 넘겨서 다음 단어 · 🔊 눌러 듣기"}
            </span>
          </div>
          {enrichBanner}
        </div>

        <div ref={scrollerRef} className={s.scroller} aria-label="단어 카드">
          {entries.map((entry, i) => (
            <VocabCard
              key={i}
              entry={entry}
              index={i}
              total={entries.length}
              active={i === activeIndex}
              readAlong={readAlong}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 카드 한 장
// ---------------------------------------------------------------------------

function VocabCard({
  entry,
  index,
  total,
  active,
  readAlong,
}: {
  entry: VocabEntry;
  index: number;
  total: number;
  active: boolean;
  readAlong: boolean;
}) {
  return (
    <article className={s.card} data-card-index={index} aria-current={active ? "true" : undefined}>
      <span className={`t-meta-chip ${s.cardIndex}`}>
        {index + 1} / {total}
      </span>

      <div className={s.wordRow}>
        <VocabGlyph entry={entry} size="lg" />
        <span className="t-vocab-word">{entry.word}</span>
        <button
          type="button"
          className={s.speak}
          aria-label={`${entry.word} 발음 듣기`}
          title="발음 듣기"
          onClick={() => speak(entry.word)}
        >
          🔊
        </button>
      </div>

      {entry.ipa && <p className="t-vocab-pron">[{entry.ipa}]</p>}

      {entry.pos.length > 0 && (
        <p className={s.pos}>{entry.pos.map((p) => PART_OF_SPEECH_LABELS_KO[p]).join(" · ")}</p>
      )}

      {/* 영영 뜻(호출 D) — 없으면 자리만 두고 "정의 만들기"를 유도한다 */}
      <VocabDefinition definitionEn={entry.definitionEn} />

      {/* 단어 전체에 딸린 관련어(파생어 등) — 뜻 옆 유의어는 각 뜻 아래로 간다 */}
      {entry.related.length > 0 && (
        <span className={s.chips}>
          {entry.related.map((r, k) => (
            <span key={k} className="u-chip">
              {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
            </span>
          ))}
        </span>
      )}

      {entry.meanings.length > 0 && (
        <ol className={s.meanings}>
          {/* 교재의 `1 …/2 …/3 …` 번호 구조 재현 — 번호는 자동증가가 아니라 책의 no 그대로 */}
          {entry.meanings.map((m, k) => (
            <li key={k} className={s.meaning}>
              <span className="t-vocab-meaning">
                {m.no !== null && <span className={s.meaningNo}>{m.no}.</span>}
                {m.ko}
              </span>
              {m.related.length > 0 && (
                <span className={s.chips}>
                  {m.related.map((r, j) => (
                    <span key={j} className="u-chip">
                      {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {entry.examples.length > 0 && (
        <ul className={s.examples}>
          {entry.examples.map((ex, k) => (
            <li key={k} className={s.example}>
              <div className={s.exampleHead}>
                <button
                  type="button"
                  className={s.speak}
                  aria-label="예문 발음 듣기"
                  title="예문 듣기"
                  onClick={() => speak(ex.en)}
                >
                  🔊
                </button>
                {readAlong ? (
                  <ExampleReadAlong en={ex.en} />
                ) : (
                  <span className={`t-vocab-example ${s.exampleText}`}>{ex.en}</span>
                )}
              </div>
              {ex.ko ? <p className={s.exampleKo}>{ex.ko}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// 이어읽기 예문 — 토큰(단어)으로 쪼갠 드래그·키보드 선택 표면
// ---------------------------------------------------------------------------

/**
 * 예문 한 문장을 단어 버튼으로 쪼갠다. 이어읽기 모드 ON일 때만 렌더되므로 컨테이너는 늘
 * touch-action:none(드래그가 스크롤로 새지 않게).
 *
 * - 드래그(pointer): pointerdown에서 시작 토큰을 잡고 setPointerCapture. pointermove에서
 *   elementFromPoint로 지금 손가락 밑 토큰을 찾아 시작~현재를 하이라이트. pointerup에서 그 구간을
 *   speakSequence(공백으로 이어 붙여 utterance 1개)로 읽는다.
 * - 키보드: 토큰은 <button>이라 포커스 가능. Enter/Space로 나는 click은 detail===0 이라 pointer가
 *   만든 click(detail>=1)과 구분된다 — 키보드 클릭만 여기서 처리한다(마우스·터치는 pointerup이 이미 처리).
 *   그냥 클릭=한 단어, shift+클릭=직전 클릭(anchor)부터 범위.
 */
function ExampleReadAlong({ en }: { en: string }) {
  const tokens = useMemo(() => en.split(/\s+/).filter(Boolean), [en]);
  const containerRef = useRef<HTMLParagraphElement>(null);
  // 진행 중인 드래그: 시작 토큰·현재 토큰·shift 여부
  const dragRef = useRef<{ start: number; cur: number; shift: boolean } | null>(null);
  // 마지막으로 확정한 토큰 — shift 범위의 기준점
  const anchorRef = useRef<number | null>(null);
  // 현재 하이라이트 구간 [lo, hi] (읽은 뒤에도 남겨 아이가 무엇을 들었는지 보이게)
  const [range, setRange] = useState<[number, number] | null>(null);

  function tokenIndexFrom(el: Element | null): number | null {
    const btn = el?.closest("[data-ti]");
    if (!btn || !containerRef.current?.contains(btn)) return null;
    const ti = Number((btn as HTMLElement).dataset.ti);
    return Number.isInteger(ti) ? ti : null;
  }

  function onPointerDown(e: React.PointerEvent) {
    const idx = tokenIndexFrom(e.target as Element);
    if (idx == null) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 캡처 실패는 무시 — elementFromPoint 경로가 여전히 동작한다 */
    }
    dragRef.current = { start: idx, cur: idx, shift: e.shiftKey };
    setRange([idx, idx]);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const idx = tokenIndexFrom(document.elementFromPoint(e.clientX, e.clientY));
    if (idx == null) return; // 예문 밖으로 나갔으면 마지막 구간 유지
    drag.cur = idx;
    setRange([Math.min(drag.start, idx), Math.max(drag.start, idx)]);
  }

  function onPointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 이미 풀렸으면 무시 */
    }
    const { start, cur, shift } = drag;
    if (shift && anchorRef.current != null) {
      readRange(anchorRef.current, cur); // anchor는 유지(연속 shift 확장 가능)
    } else if (start !== cur) {
      readRange(start, cur);
      anchorRef.current = cur;
    } else {
      readSingle(start);
    }
  }

  function onClick(e: React.MouseEvent) {
    // 마우스·터치 클릭(detail>=1)은 pointerup이 이미 처리 — 키보드(detail===0)만 여기서.
    if (e.detail !== 0) return;
    const idx = tokenIndexFrom(e.target as Element);
    if (idx == null) return;
    if (e.shiftKey && anchorRef.current != null) {
      readRange(anchorRef.current, idx);
    } else {
      readSingle(idx);
    }
  }

  function readRange(a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    setRange([lo, hi]);
    speakSequence(tokens.slice(lo, hi + 1));
  }

  function readSingle(idx: number) {
    setRange([idx, idx]);
    anchorRef.current = idx;
    speak(tokens[idx]);
  }

  return (
    <p
      ref={containerRef}
      className={`t-vocab-example ${s.exampleText} ${s.tokenSurface}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      {tokens.map((tok, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          <button
            type="button"
            data-ti={i}
            className={`${s.token} ${range && i >= range[0] && i <= range[1] ? s.tokenActive : ""}`}
          >
            {tok}
          </button>
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 단어 그림 (호출 D) — 우선순위는 resolveVocabImage 한 곳에서 판정한다(svg>emoji>첫 글자).
// V3는 이모지 우선이라 svg 자리는 지금 항상 비어 letter/emoji로만 떨어진다. 미래 SVG(V3.1)까지
// dangerouslySetInnerHTML를 열지 않으려고, svg kind는 첫 글자 배지로 안전 폴백한다(XSS 표면 0).
// ---------------------------------------------------------------------------

function VocabGlyph({ entry, size }: { entry: VocabEntry; size: "lg" | "sm" }) {
  const img = resolveVocabImage(entry);
  const cls = size === "lg" ? s.glyphLg : s.glyphSm;
  if (img.kind === "emoji") {
    return (
      <span className={`${s.glyph} ${cls} ${s.glyphEmoji}`} aria-hidden>
        {img.emoji}
      </span>
    );
  }
  const letter = img.kind === "letter" ? img.letter : (entry.word.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={`${s.glyph} ${cls} ${s.glyphLetter}`} aria-hidden>
      {letter}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 영영 뜻 (호출 D) — 있으면 라벨과 함께, 없으면 "아직 없어요" 자리(정의 만들기 유도).
// ---------------------------------------------------------------------------

function VocabDefinition({ definitionEn }: { definitionEn: string | null }) {
  if (definitionEn) {
    return (
      <p className={s.defn} lang="en">
        <span className={s.defnLabel} lang="ko" aria-hidden>
          영영
        </span>
        {definitionEn}
      </p>
    );
  }
  return <p className={s.defnEmpty}>영영 뜻은 아직 없어요</p>;
}

// ---------------------------------------------------------------------------
// 표 모드 — V1 서버 표를 그대로 옮겼다 (회귀 0). 마크업·클래스·스타일 동일.
// ---------------------------------------------------------------------------

function TableView({ entries }: { entries: VocabEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="u-table vocab-table" style={{ minWidth: 600 }}>
        <colgroup>
          <col style={{ width: 52 }} />
          <col style={{ width: 168 }} />
          <col style={{ width: 168 }} />
          <col style={{ width: 212 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="text-right">번호</th>
            <th scope="col">단어</th>
            <th scope="col">뜻</th>
            <th scope="col">예문</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i}>
              <td className="t-meta-chip whitespace-nowrap text-right align-top">
                {entry.no ?? ""}
              </td>
              <td className="align-top">
                <span className={s.tableWordHead}>
                  <VocabGlyph entry={entry} size="sm" />
                  <span className="t-vocab-word break-words">{entry.word}</span>
                </span>
                {entry.ipa && <span className="t-vocab-pron block break-words">[{entry.ipa}]</span>}
                {entry.pos.length > 0 && (
                  <span className="t-caption block">
                    {entry.pos.map((p) => PART_OF_SPEECH_LABELS_KO[p]).join(" · ")}
                  </span>
                )}
                {entry.related.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {entry.related.map((r, k) => (
                      <span key={k} className="u-chip">
                        {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className="t-vocab-meaning align-top" style={{ wordBreak: "keep-all" }}>
                {entry.meanings.length > 0 ? (
                  <ol className="flex flex-col gap-1.5">
                    {/* 교재의 `1 …/2 …/3 …` 번호 구조 재현 — 번호는 자동증가가 아니라 책의 no를 그대로 */}
                    {entry.meanings.map((m, k) => (
                      <li key={k} className="flex flex-col gap-1">
                        <span>
                          {m.no !== null && (
                            <span className="mr-1 tabular-nums text-ink-3">{m.no}.</span>
                          )}
                          {m.ko}
                        </span>
                        {/* 이 뜻 옆에 붙은 유의어·반의어 — 뜻 아래 칩으로 (단어 전체 파생어는 단어 열) */}
                        {m.related.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {m.related.map((r, j) => (
                              <span key={j} className="u-chip">
                                {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                              </span>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <span className="t-caption">—</span>
                )}
                {/* 영영 뜻(호출 D) — 한글 뜻 아래에 영어 정의 자리. 없으면 자리만 둔다 */}
                <VocabDefinition definitionEn={entry.definitionEn} />
              </td>
              <td className="align-top" style={{ wordBreak: "keep-all" }}>
                {entry.examples.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {entry.examples.map((ex, k) => (
                      <li key={k} className="t-vocab-example">
                        {ex.en}
                        {ex.ko ? <span className="mt-0.5 block text-ink-3">{ex.ko}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="t-caption">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

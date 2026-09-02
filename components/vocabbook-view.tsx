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
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  PART_OF_SPEECH_LABELS_KO,
  RELATED_KIND_LABELS_KO,
  resolveVocabImage,
  type VocabEntry,
  type VocabRelated,
} from "@/lib/ai/english/vocabbook-schemas";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speak, speakSequence, stopSpeaking } from "@/lib/speech";
import type { VocabAddWordResponse } from "@/lib/vocab-add-word-contract";
import type { VocabEnrichResponse } from "@/lib/vocab-enrich-contract";
import type {
  VocabAddRelatedRequest,
  VocabAddRelatedResponse,
  VocabLinkKind,
  VocabLinkRequest,
  VocabLinkResponse,
  VocabRelatedCandidate,
  VocabSuggestRelatedResponse,
} from "@/lib/vocab-link-contract";
import TtsSpeedControl from "./tts-speed-control";
import s from "./vocabbook-view.module.css";

const VIEW_MODE_KEY = "vocab-view-mode";
type ViewMode = "table" | "card";

/** 더블탭으로 인정하는 두 번째 탭까지의 최대 간격(ms). PC dblclick·모바일 연속 탭 모두 이 창 안. */
const DOUBLE_TAP_MS = 300;

/**
 * 더블탭한 단어를 "이 단어장에 담기" 팝업으로 올리는 콜백을 자식(정의·예문 토큰)에게 내려보내는
 * 컨텍스트 (V8). prop drilling(VocabbookView→TableView→행→VocabDefinition) 대신 컨텍스트로 잇는다.
 * null이면(제공 안 됨) DoubleTapText가 평범한 텍스트로 폴백한다 — 담기 대상이 아닌 화면에서 안전.
 */
const AddWordContext = createContext<((word: string) => void) | null>(null);

/**
 * 유의어/반의어 연결(V8) — 뜻별 "＋ 추가" 버튼·사용자 칩 해제가 쓰는 컨텍스트. 표·카드 두 모드가 같은
 * 추가 시트·해제 흐름을 공유하도록 최상위에서 내려보낸다. null이면(제공 안 됨) 연결 UI를 그리지 않는다.
 * - `bookId`   : suggest-related·add-related(추가·연결)·DELETE `/link`(해제) 라우트 대상
 * - `entries`  : 해제 시 targetIndex 역해석의 원본(화면이 보는 그 배열 = 인덱스 기준)
 * - `openLink` : 어느 (단어 index·뜻 index)에서 추가 시트를 열지 시작점을 넘긴다
 * - `onLinked` : 추가/연결/해제 성공 후 서버 재조회(router.refresh) — 표·카드의 관계 칩을 갱신한다
 */
interface VocabLinkContext {
  bookId: string;
  entries: VocabEntry[];
  openLink: (sourceIndex: number, sourceMeaningIndex: number) => void;
  onLinked: () => void;
}
const LinkContext = createContext<VocabLinkContext | null>(null);

/**
 * 해제(DELETE) 때 관련어 칩의 상대 단어(word)·linkedNo로 **대상 단어의 entries 인덱스**를 역해석한다.
 * no가 있으면 (word·no) 둘 다 맞는 것을, 없으면 word만 맞는 첫 항목을 고른다(자기 자신 제외). 스토어가
 * targetIndex로 대상 뜻의 대칭 링크를 찾아 지운다. 못 찾으면(-1) 라우트가 invalid(400)로 안전히 거른다.
 */
function resolveTargetIndex(entries: VocabEntry[], sourceIndex: number, r: VocabRelated): number {
  if (r.linkedNo !== null) {
    const byNo = entries.findIndex(
      (e, k) => k !== sourceIndex && e.word === r.word && e.no === r.linkedNo,
    );
    if (byNo >= 0) return byNo;
  }
  return entries.findIndex((e, k) => k !== sourceIndex && e.word === r.word);
}

/**
 * 토큰에서 앞뒤 구두점을 벗겨 담을 단어만 남긴다. 내부 아포스트로피·하이픈은 지킨다(don't · well-known).
 * 곡선 아포스트로피(’)는 직선(')으로 정규화 — 서버 WORD_PATTERN이 직선만 받는다. 벗기고 나서 빈
 * 문자열이면(순수 구두점·숫자) 담기를 열지 않는다.
 */
function cleanWord(tok: string): string {
  return tok.replace(/’/g, "'").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
}

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

  // 더블탭 담기 팝업(V8) — 지금 팝업에 올라온 단어(null=닫힘). 표·카드 두 모드 공용이라 최상위에 둔다.
  const [pickWord, setPickWord] = useState<string | null>(null);

  // 유의어/반의어 연결 시트(V8) — 지금 연결을 시작한 (단어 index·뜻 index). null=닫힘. 표·카드 공용.
  const [linkSource, setLinkSource] = useState<{ sourceIndex: number; sourceMeaningIndex: number } | null>(
    null,
  );
  // 연결 컨텍스트 — 콜백·entries를 자식(표·카드의 뜻 칩)에게 내려보낸다. entries가 바뀔 때만 새로 만든다.
  const linkCtx = useMemo<VocabLinkContext>(
    () => ({
      bookId: id,
      entries,
      openLink: (sourceIndex, sourceMeaningIndex) => setLinkSource({ sourceIndex, sourceMeaningIndex }),
      onLinked: () => router.refresh(),
    }),
    [id, entries, router],
  );

  // 정의 불변의 UI 측 단일 정의처는 저장된 entries다 — record.enriched를 믿지 않고 여기서 계산해
  // 서버 재조회(router.refresh) 뒤 자동으로 갱신되게 한다.
  // 보강 대상 = EN 또는 KO가 빠진 단어(entriesToEnrich와 같은 규칙, V7 해석 백필 포함). 버튼 활성·라벨 N·
  // 안내 문구의 단일 기준 — 정의는 있는데 해석만 없는 책도 이 값이 >0이라 "다시 만들기"가 활성된다.
  const remainingToEnrich = entries.filter(
    (e) => e.definitionEn === null || e.definitionKo === null,
  ).length;
  const fullyEnriched = remainingToEnrich === 0; // EN·KO 둘 다 완료 — 보강 버튼·안내 숨김 기준
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
        if (data.filledKoGlosses > 0) parts.push(`우리말 해석 ${data.filledKoGlosses}개`);
        if (data.filledEmojis > 0) parts.push(`그림 ${data.filledEmojis}개`);
        let made: string;
        if (parts.length === 0) {
          made = "새로 채운 건 없었어요.";
        } else if (data.filledDefinitions === 0 && data.filledKoGlosses > 0) {
          // 정의(EN)는 그대로 두고 해석만 백필한 경우 — 정의 불변을 문구로 드러낸다
          made = `이미 만든 영영 뜻은 그대로 두고 ${parts.join(" · ")}를 채웠어요.`;
        } else {
          made = parts.join(" · ") + "를 새로 붙였어요.";
        }
        // 남은 것도 EN·KO를 분리해 안내한다(한 숫자로 뭉치지 않는다 — P2-1).
        const remainParts: string[] = [];
        if (data.remainingDefinitions > 0) remainParts.push(`영영 뜻 ${data.remainingDefinitions}개`);
        if (data.remainingGlosses > 0) remainParts.push(`우리말 해석 ${data.remainingGlosses}개`);
        const tail =
          remainParts.length > 0
            ? ` 아직 ${remainParts.join(" · ")}가 남았어요 — 다시 만들기를 눌러 보세요.`
            : " 이제 모든 단어에 영영 뜻과 해석이 있어요!";
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
    ? `영영 뜻·해석 다시 만들기${remainingToEnrich > 0 ? ` (${remainingToEnrich})` : ""}`
    : "영영 뜻 만들기";
  const enrichButton = fullyEnriched ? null : (
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

  const tableBody = (
      <>
        <div className={s.toolbar}>
          {modeToggle}
          {quizButton}
          {enrichButton}
          {/* 읽어주기 속도 — 전역 하나(lib/speech.ts). 단어·예문 낭독과 시험 자동낭독에 함께 적용된다. */}
          <TtsSpeedControl />
        </div>
        {/* 정의 불변을 문구로도 드러낸다 — "다시 만들기"가 이미 있는 정의를 안 건드림을 안내 */}
        {fullyEnriched ? null : (
          <p className={`t-caption ${s.enrichNote}`}>
            {hasAnyDefinition
              ? "이미 만든 영영 뜻은 그대로 두고, 비어 있는 뜻과 우리말 해석만 채워요."
              : "영영 뜻과 우리말 해석·그림을 붙이면 카드·시험에 쓸 수 있어요. 이모지가 없으면 첫 글자로 표시돼요."}
          </p>
        )}
        {enrichBanner}
        <TableView entries={entries} />
      </>
  );

  // 카드 모드 — 100dvh 전면 오버레이 (chrome=auto + 스크롤러=flex:1/min-height:0)
  const daySuffix = dayLabel && dayLabel !== titleKo ? ` · ${dayLabel}` : "";
  const cardBody = (
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

  // 팝업이 뜬 순간의 중복 여부를 저장 entries로 즉시 판정한다(대소문자 무시) — 서버 왕복 없이
  // "이미 있어요"를 바로 안내(라우트도 최종 확인하지만 UX는 즉답). 담기 콜백을 컨텍스트로 내려보낸다.
  const alreadyExists =
    pickWord !== null &&
    entries.some((e) => e.word.trim().toLowerCase() === pickWord.trim().toLowerCase());

  return (
    <LinkContext.Provider value={linkCtx}>
      <AddWordContext.Provider value={setPickWord}>
        {viewMode === "table" ? tableBody : cardBody}
        {pickWord !== null && (
          <AddWordSheet
            bookId={id}
            word={pickWord}
            alreadyExists={alreadyExists}
            onClose={() => setPickWord(null)}
          />
        )}
        {linkSource !== null && (
          <LinkSheet
            bookId={id}
            entries={entries}
            sourceIndex={linkSource.sourceIndex}
            sourceMeaningIndex={linkSource.sourceMeaningIndex}
            onClose={() => setLinkSource(null)}
            onLinked={() => router.refresh()}
          />
        )}
      </AddWordContext.Provider>
    </LinkContext.Provider>
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

      {/* 영영 뜻(호출 D) — 없으면 자리만 두고 "정의 만들기"를 유도한다. 아래 우리말 해석(V7) 포함 */}
      <VocabDefinition definitionEn={entry.definitionEn} definitionKo={entry.definitionKo} />

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
              {/* 이 뜻 옆 관련어 칩 + "＋ 연결" 버튼(사용자 링크는 해제 가능) — 표·카드 공용(MeaningLinks) */}
              <MeaningLinks entryIndex={index} meaningIndex={k} related={m.related} className={s.chips} />
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
                  // 이어읽기 OFF면 예문 단어를 더블탭 담기 표면으로(드래그와 동시 존재하지 않음 — 드래그 우선)
                  <DoubleTapText text={ex.en} className={`t-vocab-example ${s.exampleText}`} />
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
// 더블탭 담기 (V8) — 정의·예문 텍스트를 단어 토큰으로 쪼개, 더블탭한 단어를 팝업으로 올린다.
// ---------------------------------------------------------------------------

/**
 * 영어 텍스트(정의·예문)를 단어 토큰으로 쪼개, 각 토큰의 **더블탭**(PC dblclick / 모바일 300ms 내 2탭)을
 * 감지해 그 단어를 "이 단어장에 담기" 팝업으로 올린다 (V8). V2 이어읽기의 공백 토큰화를 재사용하되,
 * 이건 별개 제스처(더블탭)라 이어읽기 상태와 독립이다.
 *
 * ── 기존 제스처와 충돌 방지 ────────────────────────────────────────────────
 * - **단일탭**은 아무 일도 안 한다(두 번째 탭을 기다리는 arming만) — 예문·단어의 🔊 발음 버튼은
 *   별개 <button>이라 그대로 산다. 더블탭만 담기.
 * - **이어읽기(드래그)**: 예문이 이어읽기 모드 ON이면 호출부가 이 컴포넌트 대신 ExampleReadAlong을
 *   그린다 — 즉 드래그 표면과 더블탭 표면은 동시에 존재하지 않는다("드래그 우선").
 * - 각 토큰은 <button> + touch-action:manipulation(모바일 더블탭 확대 억제) + user-select:none
 *   (기본 텍스트 선택 억제). 감지는 onClick 하나로 PC·모바일 통일(둘 다 두 번째 click을 낸다).
 *
 * onPick 컨텍스트가 없으면(담기 대상이 아닌 화면) 평범한 텍스트로 폴백한다(시험 화면 안전).
 */
function DoubleTapText({
  text,
  className,
  lang = "en",
}: {
  text: string;
  className?: string;
  lang?: string;
}) {
  const onPick = useContext(AddWordContext);
  const tokens = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  // 마지막으로 탭한 토큰 인덱스·시각 — 같은 토큰을 DOUBLE_TAP_MS 내 다시 탭하면 더블탭(담기).
  const lastTap = useRef<{ i: number; t: number } | null>(null);

  if (!onPick) {
    return (
      <span className={className} lang={lang}>
        {text}
      </span>
    );
  }

  function onTap(i: number, tok: string) {
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.i === i && now - prev.t < DOUBLE_TAP_MS) {
      lastTap.current = null; // 소비 — 세 번째 탭이 또 담기로 새지 않게
      const w = cleanWord(tok);
      if (w) onPick?.(w);
    } else {
      lastTap.current = { i, t: now }; // 첫 탭 — 두 번째를 기다린다(단일탭은 무동작)
    }
  }

  return (
    <span className={className} lang={lang}>
      {tokens.map((tok, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          <button type="button" className={s.pickToken} onClick={() => onTap(i, tok)}>
            {tok}
          </button>
        </span>
      ))}
    </span>
  );
}

/**
 * 더블탭한 단어를 현재 DAY에 담는 팝업(화면 하단 시트) (V8). 열린 순간의 중복 여부(alreadyExists)를
 * 부모가 저장 entries로 즉시 판정해 넘긴다 — 이미 있으면 추가 버튼 없이 "이미 있어요"만 보인다.
 * 추가는 `POST /api/english/vocab/[id]/add-word` 한 번. 성공(담김)이면 router.refresh로 새 항목 반영.
 * 키 없음(501·added:true)도 단어는 저장됐으므로 refresh하고 "뜻은 나중에"를 안내한다(단어 유실 0).
 */
function AddWordSheet({
  bookId,
  word,
  alreadyExists,
  onClose,
}: {
  bookId: string;
  word: string;
  alreadyExists: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // 시트가 뜬 동안 body 스크롤 잠금(카드 오버레이·크롭 모달과 같은 공용 ref-count 락).
  useEffect(() => lockBodyScroll(), []);
  // Esc로 닫기(데스크톱) — 배경 탭·닫기 버튼과 함께 세 경로.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function add() {
    if (phase === "loading") return; // 중복 클릭 방어
    setPhase("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/english/vocab/${bookId}/add-word`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word }),
      });
      const data = (await res.json()) as VocabAddWordResponse;
      if (data.ok) {
        if (!data.added) {
          // 서버가 최종 확인한 중복(1차 통과 뒤 경합 포함) — 담지 않았음을 안내.
          setMessage("이미 이 단어장에 있어요.");
          setPhase("done");
        } else {
          setMessage(
            data.enrichSkipped
              ? "담았어요! 뜻은 잠시 후 '다시 만들기'로 채울 수 있어요."
              : "담았어요! 뜻도 만들었어요.",
          );
          setPhase("done");
          router.refresh(); // 서버 컴포넌트를 다시 그려 새 항목을 표·카드에 반영
        }
      } else if (data.error === "no_api_key" && data.added) {
        // 키는 없지만 단어는 저장됐다(뜻 null) — refresh로 반영하고 뜻은 나중에.
        setMessage("담았어요! API 키가 준비되면 '다시 만들기'로 뜻을 채워요.");
        setPhase("done");
        router.refresh();
      } else {
        setMessage(data.messageKo);
        setPhase("error");
      }
    } catch {
      setMessage("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("error");
    }
  }

  const showAddButton = !alreadyExists && phase !== "done";
  const bodyText = alreadyExists
    ? "이미 이 단어장에 있어요."
    : phase === "done" || phase === "error"
      ? message
      : "이 단어를 이 단어장에 담을까요?";

  return (
    <div
      className={s.sheetBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${word} 단어 담기`}
      onClick={onClose}
    >
      {/* 시트 안쪽 클릭은 닫힘으로 전파되지 않게 막는다 */}
      <div className={s.sheet} onClick={(e) => e.stopPropagation()}>
        <p className={s.sheetWord} lang="en">
          {word}
        </p>
        <p className={`${s.sheetHint} ${phase === "error" ? s.sheetError : ""}`} role="status">
          {bodyText}
        </p>
        <div className={s.sheetBtns}>
          {showAddButton ? (
            <button
              type="button"
              className={`u-btn u-btn-primary ${s.sheetBtn}`}
              onClick={add}
              disabled={phase === "loading"}
            >
              {phase === "loading" ? (
                <>
                  <span aria-hidden>⏳</span> 담는 중…
                </>
              ) : (
                <>
                  <span aria-hidden>➕</span> 이 단어장에 추가
                </>
              )}
            </button>
          ) : null}
          <button type="button" className={`u-btn u-btn-secondary ${s.sheetBtn}`} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 유의어/반의어 연결 (V8 관계 문제) — 뜻마다 관련어 칩 + "＋ 연결" 버튼 + 사용자 링크 해제
// ---------------------------------------------------------------------------

/**
 * 한 뜻(meaning) 아래 관련어 칩과 연결 버튼을 그린다 — 표·카드 두 모드가 이 한 컴포넌트를 쓴다.
 * - 교재 판독 관련어(source:"book")는 그대로 칩으로.
 * - 사용자가 이은 것(source:"user")은 accent 톤 + "내가 연결" 표식 + ✕ 해제 버튼(UserLinkChip).
 * - 맨 끝에 "＋ 유의어/반의어 추가" 버튼 — LinkContext.openLink로 이 (단어 index·뜻 index)에서 추가 시트를 연다.
 * LinkContext가 없으면(제공 안 됨) 추가 버튼·해제 없이 칩만 그린다(안전 폴백).
 */
function MeaningLinks({
  entryIndex,
  meaningIndex,
  related,
  className,
}: {
  entryIndex: number;
  meaningIndex: number;
  related: VocabRelated[];
  className: string;
}) {
  const ctx = useContext(LinkContext);
  return (
    <span className={className}>
      {related.map((r, j) =>
        r.source === "user" ? (
          <UserLinkChip key={j} entryIndex={entryIndex} meaningIndex={meaningIndex} related={r} />
        ) : (
          <span key={j} className="u-chip">
            {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
          </span>
        ),
      )}
      {ctx ? (
        <button
          type="button"
          className={s.linkAddBtn}
          onClick={() => ctx.openLink(entryIndex, meaningIndex)}
        >
          ＋ 유의어/반의어 추가
        </button>
      ) : null}
    </span>
  );
}

/** 사용자가 이은 관계 칩 하나 — "내가 연결" 표식 + ✕ 해제(DELETE `/link`). 성공하면 onLinked로 refresh. */
function UserLinkChip({
  entryIndex,
  meaningIndex,
  related,
}: {
  entryIndex: number;
  meaningIndex: number;
  related: VocabRelated;
}) {
  const ctx = useContext(LinkContext);
  const [busy, setBusy] = useState(false);
  // 사용자 링크는 유의어·반의어만 만든다(파생어 user 링크는 없음) — 계약 kind로 좁힌다(방어적으로 syn 폴백).
  const kind: VocabLinkKind = related.kind === "antonym" ? "antonym" : "synonym";

  async function unlink() {
    if (!ctx || busy) return;
    // 상대 단어의 entries 인덱스·뜻 인덱스를 역해석 — 하나라도 없으면(구조 변화) 조용히 무시(라우트도 400 방어).
    const targetIndex = resolveTargetIndex(ctx.entries, entryIndex, related);
    if (targetIndex < 0 || related.linkedMeaningIndex === null) return;
    setBusy(true);
    try {
      const body: VocabLinkRequest = {
        sourceIndex: entryIndex,
        sourceMeaningIndex: meaningIndex,
        targetIndex,
        targetMeaningIndex: related.linkedMeaningIndex,
        kind,
      };
      const res = await fetch(`/api/english/vocab/${ctx.bookId}/link`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as VocabLinkResponse;
      if (data.ok) {
        ctx.onLinked(); // 서버 재조회 — 이 칩이 사라진 새 entries로 다시 그려진다
      } else {
        setBusy(false); // 실패면 다시 시도할 수 있게 되돌린다
      }
    } catch {
      setBusy(false);
    }
  }

  return (
    <span className={`u-chip ${s.userChip}`}>
      {RELATED_KIND_LABELS_KO[related.kind]} {related.word}
      <span className={s.userTag}>내가 연결</span>
      <button
        type="button"
        className={s.unlinkBtn}
        onClick={unlink}
        disabled={busy}
        aria-label={`${related.word} 연결 해제`}
        title="연결 해제"
      >
        ✕
      </button>
    </span>
  );
}

/**
 * 유의어/반의어 추가 시트(하단 시트, V8 재작업) — 상대를 **AI 추천** 또는 **직접 입력**으로 골라 잇는다.
 * 종류(유의어/반의어)를 고르면 호출 H로 후보를 받아 칩으로 보여주고, 하나를 고르면 `add-related`가
 * **없으면 새로 추가(+자동 보강) / 있으면 연결만** 한다. 성공하면 refresh하고 시트는 유지해 여러 개를 이어
 * 추가할 수 있다(방금 추가한 후보는 "연결됨"으로 표식). AddWordSheet와 같은 시트 규약(스크롤 잠금·Esc·배경 탭).
 */
function LinkSheet({
  bookId,
  entries,
  sourceIndex,
  sourceMeaningIndex,
  onClose,
  onLinked,
}: {
  bookId: string;
  entries: VocabEntry[];
  sourceIndex: number;
  sourceMeaningIndex: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [kind, setKind] = useState<VocabLinkKind>("synonym");
  // 추천 상태 — null=아직 없음. suggestPhase: 요청 중/완료/오류.
  const [suggestPhase, setSuggestPhase] = useState<"loading" | "done" | "error">("loading");
  const [candidates, setCandidates] = useState<VocabRelatedCandidate[]>([]);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [noKey, setNoKey] = useState(false); // 키 없음(501) — 추천 불가, 직접 입력 유도
  // 직접 입력
  const [directWord, setDirectWord] = useState("");
  const [directGloss, setDirectGloss] = useState("");
  // 직접 입력 접이식(V8 UX) — 기본 접힘으로 추천 목록에 높이를 양보한다. 추천 실패·후보 0·키 없음이면
  // 아래 effect가 자동으로 펼친다(안내 문구와 일관). 사용자가 <details>를 직접 여닫으면 onToggle이 동기화.
  const [directOpen, setDirectOpen] = useState(false);
  // 추가·연결 진행/결과
  const [adding, setAdding] = useState<string | null>(null); // 진행 중인 후보 word(중복 클릭 방어). null=없음
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => lockBodyScroll(), []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const source = entries[sourceIndex];
  const sourceMeaning = source?.meanings[sourceMeaningIndex];

  // 이미 이 뜻에 이 kind로 이은 상대 word(소문자) — 후보에 "연결됨" 표식(중복 방지).
  const linkedWords = useMemo(() => {
    return new Set(
      (sourceMeaning?.related ?? [])
        .filter((r) => r.source === "user" && r.kind === kind)
        .map((r) => r.word.trim().toLowerCase()),
    );
  }, [sourceMeaning, kind]);

  // 추천 호출(호출 H) — 종류 선택마다 다시 부른다. source/뜻은 시트가 열려 있는 동안 고정이라 kind에만 반응.
  useEffect(() => {
    if (!source || !sourceMeaning) return;
    let alive = true;
    setSuggestPhase("loading");
    setSuggestError(null);
    setNoKey(false);
    (async () => {
      try {
        const res = await fetch(`/api/english/vocab/${bookId}/suggest-related`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ word: source.word, meaningKo: sourceMeaning.ko, kind }),
        });
        const data = (await res.json()) as VocabSuggestRelatedResponse;
        if (!alive) return;
        if (data.ok) {
          setCandidates(data.candidates);
          setSuggestPhase("done");
        } else {
          setCandidates([]);
          setNoKey(data.error === "no_api_key");
          setSuggestError(data.messageKo);
          setSuggestPhase("error");
        }
      } catch {
        if (!alive) return;
        setSuggestError("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
        setSuggestPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
    // bookId·source.word·sourceMeaning.ko는 시트 생명주기 동안 고정 — kind 변경에만 재요청한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // 추천을 못 쓰면(오류·후보 0·키 없음) 직접 입력을 자동으로 펼친다 — 안내 문구와 일관(바로 입력).
  useEffect(() => {
    if (suggestPhase === "error" || (suggestPhase === "done" && candidates.length === 0)) {
      setDirectOpen(true);
    }
  }, [suggestPhase, candidates.length]);

  // 고른(추천 또는 직접입력) 상대를 추가·연결한다. 성공하면 refresh하고 시트는 유지(여러 개 이어 추가).
  async function addRelated(chosen: VocabRelatedCandidate) {
    const w = chosen.word.trim();
    const g = chosen.glossKo.trim();
    if (adding || w === "" || g === "") return;
    setAdding(w);
    setAddError(null);
    setAddMessage(null);
    try {
      const body: VocabAddRelatedRequest = {
        sourceIndex,
        sourceMeaningIndex,
        chosen: { word: w, glossKo: g },
        kind,
      };
      const res = await fetch(`/api/english/vocab/${bookId}/add-related`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as VocabAddRelatedResponse;
      if (data.ok) {
        setAddMessage(
          data.added
            ? data.enrichSkipped
              ? `"${w}" 추가·연결했어요! 영영 뜻은 나중에 "다시 만들기"로 채울 수 있어요.`
              : `"${w}" 추가·연결했어요!`
            : `"${w}" 연결했어요! (이미 단어장에 있던 단어예요)`,
        );
        setDirectWord("");
        setDirectGloss("");
        onLinked(); // 서버 재조회 — 양쪽 뜻에 칩이 생긴 새 entries로 다시 그린다(시트는 유지)
      } else {
        setAddError(data.messageKo);
      }
    } catch {
      setAddError("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setAdding(null);
    }
  }

  const directDisabled = directWord.trim() === "" || directGloss.trim() === "" || adding !== null;

  return (
    <div
      className={s.sheetBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${source?.word ?? ""} 유의어·반의어 추가`}
      onClick={onClose}
    >
      <div className={`${s.sheet} ${s.linkSheet}`} onClick={(e) => e.stopPropagation()}>
        <p className={s.sheetWord} lang="en">
          {source?.word}
        </p>
        <p className={s.sheetHint}>
          <b lang="ko">{sourceMeaning?.ko}</b> 뜻에 이을 {kind === "synonym" ? "유의어" : "반의어"}를 골라요.
        </p>

        {/* 종류 선택 — 바꾸면 추천을 다시 받는다 */}
        <div role="group" aria-label="관계 종류" className={s.linkKindGroup}>
          <button
            type="button"
            onClick={() => setKind("synonym")}
            aria-pressed={kind === "synonym"}
            className={`u-btn ${s.linkKindBtn} ${kind === "synonym" ? "u-btn-primary" : "u-btn-secondary"}`}
          >
            유의어
          </button>
          <button
            type="button"
            onClick={() => setKind("antonym")}
            aria-pressed={kind === "antonym"}
            className={`u-btn ${s.linkKindBtn} ${kind === "antonym" ? "u-btn-primary" : "u-btn-secondary"}`}
          >
            반의어
          </button>
        </div>

        {/* 추천 후보 영역 */}
        <div className={s.suggestArea}>
          <p className={`t-caption ${s.suggestLabel}`}>
            <span aria-hidden>✨</span> 추천 {kind === "synonym" ? "유의어" : "반의어"}
          </p>
          {suggestPhase === "loading" ? (
            <p className={`t-caption ${s.suggestState}`} role="status">
              <span aria-hidden>⏳</span> 후보를 불러오는 중…
            </p>
          ) : suggestPhase === "error" ? (
            <div className={s.suggestState} role="status">
              <p className={`t-caption ${s.sheetError}`}>{suggestError}</p>
              {noKey ? (
                <p className="t-caption">아래에서 직접 입력으로 이어 줄 수 있어요.</p>
              ) : (
                <button type="button" className="u-btn u-btn-secondary" onClick={() => setKind(kind)}>
                  <span aria-hidden>🔁</span> 다시 시도
                </button>
              )}
            </div>
          ) : candidates.length === 0 ? (
            <p className={`t-caption ${s.suggestState}`}>추천 후보가 없어요. 아래에서 직접 입력해 보세요.</p>
          ) : (
            <ul className={s.linkList}>
              {candidates.map((c) => {
                const already = linkedWords.has(c.word.trim().toLowerCase());
                return (
                  <li key={c.word}>
                    <button
                      type="button"
                      className={s.linkItem}
                      onClick={() => addRelated(c)}
                      disabled={already || adding !== null}
                    >
                      {/* 콤팩트: 단어(20px)와 우리말 뜻을 한 줄에(뜻은 말줄임). 표식은 오른쪽 끝. */}
                      <span className={s.linkItemWord} lang="en">
                        {c.word}
                      </span>
                      <span className={s.linkItemGloss} lang="ko">
                        {c.glossKo}
                      </span>
                      {already ? <span className={`${s.userTag} ${s.linkItemTag}`}>연결됨</span> : null}
                      {adding === c.word.trim() ? (
                        <span className={`${s.userTag} ${s.linkItemTag}`}>추가 중…</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 직접 입력 — 접이식(기본 접힘, 추천 목록에 높이 양보). 추천 실패·후보 0·키 없음이면 자동 펼침. */}
        <details
          className={s.directArea}
          open={directOpen}
          onToggle={(e) => setDirectOpen(e.currentTarget.open)}
        >
          <summary className={s.directSummary}>
            <span aria-hidden>✏️</span> 직접 입력
          </summary>
          <div className={s.directBody}>
            <div className={s.directRow}>
              <input
                type="text"
                value={directWord}
                onChange={(e) => setDirectWord(e.target.value)}
                placeholder="영단어"
                aria-label="이을 영단어"
                lang="en"
                className={s.linkSearch}
              />
              <input
                type="text"
                value={directGloss}
                onChange={(e) => setDirectGloss(e.target.value)}
                placeholder="우리말 뜻"
                aria-label="그 단어의 우리말 뜻"
                lang="ko"
                className={s.linkSearch}
              />
            </div>
            <button
              type="button"
              className={`u-btn u-btn-primary ${s.directAddBtn}`}
              onClick={() => addRelated({ word: directWord, glossKo: directGloss })}
              disabled={directDisabled}
            >
              {adding !== null ? (
                <>
                  <span aria-hidden>⏳</span> 추가 중…
                </>
              ) : (
                <>
                  <span aria-hidden>➕</span> 이어 추가
                </>
              )}
            </button>
          </div>
        </details>

        {addMessage ? (
          <p className={`${s.sheetHint} ${s.suggestOk}`} role="status">
            {addMessage}
          </p>
        ) : null}
        {addError ? (
          <p className={`${s.sheetHint} ${s.sheetError}`} role="status">
            {addError}
          </p>
        ) : null}

        <div className={s.sheetBtns}>
          <button type="button" className={`u-btn u-btn-secondary ${s.sheetBtn}`} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
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

function VocabDefinition({
  definitionEn,
  definitionKo,
}: {
  definitionEn: string | null;
  definitionKo: string | null;
}) {
  if (!definitionEn) {
    return <p className={s.defnEmpty}>영영 뜻은 아직 없어요</p>;
  }
  return (
    <div className={s.defnBlock}>
      {/* 영영 정의 — 문제/발음 대상. 🔊는 단어·예문 스피커와 같은 관용구(lib/speech, en-US) */}
      <p className={s.defn} lang="en">
        <span className={s.defnText}>
          <span className={s.defnLabel} lang="ko" aria-hidden>
            영영
          </span>
          {/* 정의 텍스트를 단어 토큰으로 — 모르는 단어 더블탭 담기(V8). 담기 대상이 아니면 평범한 텍스트 */}
          <DoubleTapText text={definitionEn} />
        </span>
        <button
          type="button"
          className={s.speak}
          aria-label="영영 뜻 발음 듣기"
          title="영영 뜻 듣기"
          onClick={() => speak(definitionEn)}
        >
          🔊
        </button>
      </p>
      {/* 우리말 해석(V7) — 정의 아래 보조 텍스트(작은 회색). 없으면 자리 강제 없이 생략.
          KO는 en-US TTS에 부적합해 🔊를 두지 않는다(EN이 발음 대상, KO는 보조 해석). */}
      {definitionKo ? (
        <p className={s.defnKo} lang="ko">
          {definitionKo}
        </p>
      ) : null}
    </div>
  );
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
                        {/* 이 뜻 옆 관련어 칩 + "＋ 연결" 버튼(사용자 링크는 해제 가능) — 표·카드 공용(MeaningLinks) */}
                        <MeaningLinks
                          entryIndex={i}
                          meaningIndex={k}
                          related={m.related}
                          className="flex flex-wrap items-center gap-1"
                        />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <span className="t-caption">—</span>
                )}
                {/* 영영 뜻(호출 D) — 한글 뜻 아래에 영어 정의 자리(+우리말 해석 V7). 없으면 자리만 둔다 */}
                <VocabDefinition definitionEn={entry.definitionEn} definitionKo={entry.definitionKo} />
              </td>
              <td className="align-top" style={{ wordBreak: "keep-all" }}>
                {entry.examples.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {entry.examples.map((ex, k) => (
                      <li key={k} className="t-vocab-example">
                        {/* 예문 단어 더블탭 담기(V8) — 표 모드에서도 정의·예문에서 담을 수 있다 */}
                        <DoubleTapText text={ex.en} />
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

"use client";

/**
 * 일본어 JLPT 단어장 상세 (아빠의 일본어 J1 + 표/카드 보기) — 클라이언트 컴포넌트.
 *
 * 서버(`app/japanese/vocab/[id]/page.tsx`)가 데이터·404를 맡고, 여기서 표기·예문을 **후리가나(ja-ruby)**로 그리고
 * 🔊는 **surface 원문을 `speak(text,"ja-JP")`**로 읽는다(루비는 읽히지 않는다 — §5). 제목은 인라인 수정(rename).
 *
 * ── 표/카드 보기 (은우 단어장 관용구를 일본어에 맞게) ─────────────────────────────
 * - **표 모드**(기본): 한눈에 여러 단어(현재 상세) + 툴바에 토글.
 * - **카드 모드**: 100dvh 전면 오버레이 + 세로 scroll-snap — 한 화면 = 단어 하나(후리가나 크게). 컴팩트 chrome.
 * - **hydration 규약**: 초기 렌더는 **항상 표**(SSR=첫 클라 렌더 일치). 저장값(localStorage `ja-vocab-view-mode`,
 *   영어 키와 겹치지 않게 별도)은 useEffect 마운트 후 반영 — 렌더 중 localStorage를 읽으면 mismatch(영어 선례).
 * - 오버레이가 뜬 동안 body 스크롤 잠금(lib/scroll-lock). 모드 전환·이탈 시 stopSpeaking().
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import TtsSpeedControl from "@/components/tts-speed-control";
import TtsEngineControl from "@/components/tts-engine-control";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { prefetchSpeech, speak, stopSpeaking } from "@/lib/speech";
import { JA_TITLE_MAX, type JaVocabEntry, type JlptLevel, type JaGlyph } from "@/lib/japanese-vocab-contract";
import type { JaVocabRenameResponse } from "@/lib/japanese-vocab-contract";
import s from "./ja-vocab-detail-view.module.css";

const VIEW_MODE_KEY = "ja-vocab-view-mode"; // 영어 "vocab-view-mode"와 겹치지 않게 별도 키
type ViewMode = "table" | "card";

/** 일본어 발음 — surface 원문을 ja-JP로. 루비(reading)는 읽지 않는다(§5). */
function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

/** 서버가 resolveJaGlyph로 계산해 내려준 글리프를 그린다(이모지 또는 표기 첫 글자 배지). card=큼직/table=작은 배지. */
function JaGlyphView({ glyph, variant }: { glyph: JaGlyph; variant: ViewMode }) {
  const sizeCls = variant === "card" ? s.glyphLg : s.glyphSm;
  if (glyph.kind === "emoji") {
    return (
      <span className={`${s.glyph} ${sizeCls} ${s.glyphEmoji}`} aria-hidden>
        {glyph.emoji}
      </span>
    );
  }
  return (
    <span className={`${s.glyph} ${sizeCls} ${s.glyphLetter}`} aria-hidden lang="ja">
      {glyph.letter}
    </span>
  );
}

/** 표·카드 공용 엔트리 본문 — variant로 표기 크기만 다르게(카드=크게). glyph는 서버가 내려준 값. */
function JaEntryContent({ entry: e, glyph, variant }: { entry: JaVocabEntry; glyph: JaGlyph; variant: ViewMode }) {
  return (
    <>
      <div className={s.wordRow}>
        <JaGlyphView glyph={glyph} variant={variant} />
        <JaRuby
          tokens={e.wordTokens.length > 0 ? e.wordTokens : [{ surface: e.word, reading: null }]}
          className={variant === "card" ? s.cardWord : s.word}
        />
        <button
          type="button"
          className={s.speak}
          onClick={() => speakJa(e.word)}
          aria-label={`${e.word} 발음 듣기`}
          title="발음 듣기"
        >
          🔊
        </button>
        {e.level && <span className={`u-chip ${s.levelChip}`}>{e.level}</span>}
      </div>

      {e.kana && e.kana !== e.word && (
        <p className={s.kana} lang="ja">
          {e.kana}
        </p>
      )}

      {e.pos.length > 0 && (
        <p className={s.pos}>
          {e.pos.map((p) => (
            <span key={p} className="u-chip">
              {p}
            </span>
          ))}
        </p>
      )}

      {e.meaningsKo.length > 0 && (
        <ol className={s.meanings}>
          {e.meaningsKo.map((m, k) => (
            <li key={k} className={s.meaning}>
              {e.meaningsKo.length > 1 && <span className={s.meaningNo}>{k + 1}.</span>}
              {m}
            </li>
          ))}
        </ol>
      )}

      {/* 일일정의(일본어 뜻풀이) — meaningsKo(한국어)와 구분. definitionTokens 있으면 루비, 없으면 평문 폴백. null이면 자리 비움. */}
      {(e.definitionTokens || e.definitionJa) && (
        <div className={s.definition}>
          <span className={s.definitionLabel} aria-hidden>
            뜻풀이
          </span>
          {e.definitionTokens ? (
            <JaRuby tokens={e.definitionTokens} className={s.definitionText} />
          ) : (
            <span className={s.definitionText} lang="ja">
              {e.definitionJa}
            </span>
          )}
        </div>
      )}

      {e.example.ja && (
        <div className={s.example}>
          <div className={s.exampleHead}>
            <button
              type="button"
              className={s.speak}
              onClick={() => speakJa(e.example.ja)}
              aria-label="예문 발음 듣기"
              title="예문 듣기"
            >
              🔊
            </button>
            <JaRuby
              tokens={e.example.tokens.length > 0 ? e.example.tokens : [{ surface: e.example.ja, reading: null }]}
              className={s.exampleJa}
            />
          </div>
          {e.example.ko && <p className={s.exampleKo}>{e.example.ko}</p>}
        </div>
      )}
    </>
  );
}

export default function JaVocabDetailView({
  id,
  titleKo,
  levels,
  topic,
  entries,
  glyphs,
}: {
  id: string;
  titleKo: string;
  levels: JlptLevel[];
  topic: string | null;
  entries: JaVocabEntry[];
  /** entries와 1:1 정렬된 글리프(서버가 resolveJaGlyph로 계산). 이모지 없으면 첫 글자 배지. */
  glyphs: JaGlyph[];
}) {
  // 방어: glyphs가 짧으면(프롭 어긋남) 첫 글자로 폴백 — 화면이 빈자리를 안 만든다.
  const glyphOf = (i: number): JaGlyph =>
    glyphs[i] ?? { kind: "letter", letter: (entries[i]?.word.trim()[0] ?? "?") };
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("table"); // 초기 렌더는 항상 표(hydration 일치)
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 프리페치(§16): 화면에 보이는 단어(표기)를 미리 캐시 → 🔊 첫 재생 지연 제거. 화면 이탈 시 자동 중단.
  useEffect(() => prefetchSpeech(entries.map((e) => e.word), "ja-JP"), [entries]);

  // 제목 인라인 수정
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [saving, setSaving] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  // 마운트 후 저장된 보기 모드 반영(렌더 중 localStorage 접근 금지 — mismatch 방지)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === "card" || saved === "table") setViewMode(saved);
    } catch {
      /* 프라이빗 모드 등 — 표 유지 */
    }
  }, []);

  // 카드 모드 오버레이가 뜬 동안 body 스크롤 잠금(공용 ref-count 락)
  useEffect(() => {
    if (viewMode !== "card") return;
    return lockBodyScroll();
  }, [viewMode]);

  // 카드 모드에서 지금 보이는 카드 번호(n/전체) 추적
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

  // 화면 이탈 시 재생 정지
  useEffect(() => () => stopSpeaking(), []);

  function chooseMode(mode: ViewMode) {
    setViewMode(mode);
    stopSpeaking(); // 표↔카드 전환 때 읽던 것 정지
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* 저장 실패는 조용히 무시 */
    }
  }

  async function saveTitle() {
    const next = draft.trim();
    if (next === "" || next === titleKo) {
      setEditing(false);
      setDraft(titleKo);
      return;
    }
    setSaving(true);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/vocab/${id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json()) as JaVocabRenameResponse;
      if (data.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setErrorKo(data.messageKo);
      }
    } catch {
      setErrorKo("이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  // 표/카드 토글 — 표 툴바·카드 chrome 양쪽에서 같은 모양으로 쓴다
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

  // ── 표 모드 ──────────────────────────────────────────────────────────────────
  const tableBody = (
    <div className={s.wrap}>
      <div className={s.titleRow}>
        {editing ? (
          <div className={s.titleEdit}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={JA_TITLE_MAX}
              aria-label="단어장 이름"
              className={s.titleInput}
              autoFocus
            />
            <div className={s.titleBtns}>
              <button type="button" className="u-btn u-btn-primary" onClick={saveTitle} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                className="u-btn u-btn-secondary"
                onClick={() => {
                  setEditing(false);
                  setDraft(titleKo);
                  setErrorKo(null);
                }}
                disabled={saving}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className={s.titleView}>
            <h1 className="t-book-title">{titleKo}</h1>
            <button
              type="button"
              className="u-btn u-btn-secondary"
              onClick={() => setEditing(true)}
              aria-label="단어장 이름 수정"
            >
              <span aria-hidden>✏️</span> 이름
            </button>
          </div>
        )}
      </div>
      {errorKo && <p role="alert" className={s.error}>{errorKo}</p>}

      <div className={s.toolbar}>
        {modeToggle}
        {/* 시험 진입(J2) — 시험 보기·오답노트·시험 기록. 기록·오답노트는 항상 활성(영어 관용구). */}
        <Link href={`/japanese/vocab/${id}/quiz`} className={`u-btn u-btn-primary ${s.modeBtn}`}>
          <span aria-hidden>📝</span> 시험 보기
        </Link>
        <Link href={`/japanese/vocab/${id}/wrong`} className={`u-btn u-btn-secondary ${s.modeBtn}`}>
          <span aria-hidden>📕</span> 오답노트
        </Link>
        <Link href={`/japanese/vocab/${id}/history`} className={`u-btn u-btn-secondary ${s.modeBtn}`}>
          <span aria-hidden>📊</span> 시험 기록
        </Link>
        <TtsSpeedControl />
        <TtsEngineControl lang="ja-JP" />
      </div>

      <div className={s.metaRow}>
        <span className="t-caption flex flex-wrap items-center gap-1.5">
          {levels.map((lv) => (
            <span key={lv} className="u-chip">
              {lv}
            </span>
          ))}
          {topic && <span className="u-chip">{topic}</span>}
          <span className="u-chip">단어 {entries.length}개</span>
        </span>
      </div>

      <ul className={s.list}>
        {entries.map((e, i) => (
          <li key={i} className={s.entry}>
            <JaEntryContent entry={e} glyph={glyphOf(i)} variant="table" />
          </li>
        ))}
      </ul>
    </div>
  );

  // ── 카드 모드 (100dvh 오버레이 + 세로 scroll-snap) ────────────────────────────
  const cardBody = (
    <div className={s.cardOverlay} role="dialog" aria-label="단어 카드 보기">
      <div className={s.cardInner}>
        <div className={s.cardChrome}>
          <div className={s.chromeRow}>
            <div className={s.chromeTitle}>
              <Link href="/japanese/vocab" className={`u-navbtn ${s.backBtn}`}>
                ← 목록
              </Link>
              <span className={`t-caption ${s.titleText}`}>
                {titleKo} · {entries.length}개
              </span>
            </div>
            {modeToggle}
          </div>
          <div className={s.chromeRow2}>
            <TtsSpeedControl />
            <TtsEngineControl lang="ja-JP" />
            <span className={`t-caption ${s.hintText}`} aria-live="polite">
              {activeIndex + 1} / {entries.length}
            </span>
          </div>
        </div>

        <div ref={scrollerRef} className={s.scroller} aria-label="단어 카드">
          {entries.map((e, i) => (
            <article
              key={i}
              className={s.cardFrame}
              data-card-index={i}
              aria-current={i === activeIndex ? "true" : undefined}
            >
              <span className={`t-meta-chip ${s.cardIndex}`}>
                {i + 1} / {entries.length}
              </span>
              <JaEntryContent entry={e} glyph={glyphOf(i)} variant="card" />
            </article>
          ))}
        </div>
      </div>
    </div>
  );

  return viewMode === "table" ? tableBody : cardBody;
}

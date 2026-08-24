"use client";

/**
 * 챕터 리더 (호출 F · 챕터화, docs/harness/english.md §9) — 카드 화면에 붙는 섹션.
 *
 * **유튜브 낭독 자막이 있는 책**을 챕터마다 **영어 원문 문장 + 그 아래 우리말 해석 +
 * 영어 읽어주기(TTS)** 로 보여준다. 목차(toc)가 있으면 챕터별로, 없으면 자막 전체를 "전체"
 * 단일 챕터로 담는다(자막이 필수, 목차는 선택 — §9).
 *
 * 세 가지 상태를 한 컴포넌트가 그린다(카드 화면은 이 한 줄만 얹으면 된다):
 * - chapters 있음 → 리더(챕터별 또는 "전체" 단일 블록) + "다시 나누기"
 * - chapters 없지만 자막 준비됨(canChapterize) → "📖 챕터로 읽기 만들기" 버튼
 * - 자막도 챕터도 없음 → 아무것도 그리지 않는다(회귀 0 — 자막 없는 카드 화면은 그대로)
 *
 * ⚠️ 영어 원문 표시는 이 리더에 한해 허용된 것이다(§9 서두, 가족 전용 확정). 카드의 다른
 * 부분(줄거리·예문)은 여전히 원문을 옮기지 않는다.
 *
 * ── M2 · 단어 더블탭 뜻 팝업 + "모은 단어" 담기 (호출 G, §10) ─────────────────
 * 영어 문장을 **단어 토큰으로 쪼개**(V2/V8 공백 토큰화 재사용), 각 단어의 **더블클릭(PC)/더블탭(폰)**을
 * 감지해 하단 시트를 올린다: 그 단어 + 로딩 후 **문맥 우리말 뜻**(POST /api/word-meaning, 단어+그 문장)
 * + **🔊 발음**(speak, lib/speech 재사용) + **"모은 단어장에 추가"**(POST collected add-word).
 * - **단일탭 = 무동작**(두 번째 탭을 기다리는 arming만). 문장 🔊(단일 클릭 버튼)·이어읽기와 겹치지 않는다.
 * - 더블탭 감지는 onClick 하나로 PC·모바일 통일(둘 다 두 번째 click을 낸다) — V8 DoubleTapText와 같은 방식.
 * - 뜻 조회 실패는 **비치명**: 안내만 하고 발음은 그대로, 담기는 뜻이 있어야만 연다.
 *
 * lib/store는 타입을 쓰지 않는다 — chapters는 부모(card-view)가 book에서 꺼내 넘긴다.
 * 발음은 lib/speech.ts가 단일 정의처다(카드 단어 스피커와 같은 목소리·속도).
 */

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { WHOLE_TRANSCRIPT_TITLE, type Chapter } from "@/lib/ai/english/schemas";
import type { CollectedAddWordResponse } from "@/lib/collected-vocab-contract";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speak, speakSequence } from "@/lib/speech";
import type { WordMeaningResponse } from "@/lib/word-meaning-contract";
import s from "./chapter-reader.module.css";

/** 더블탭으로 인정하는 두 번째 탭까지의 최대 간격(ms). PC dblclick·모바일 연속 탭 모두 이 창 안(V8과 같은 값). */
const DOUBLE_TAP_MS = 300;

/** 토큰에서 앞뒤 구두점을 벗겨 담을 단어만 남긴다. 내부 아포스트로피·하이픈은 지킨다(don't · well-known). */
function cleanWord(tok: string): string {
  return tok.replace(/’/g, "'").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
}

/**
 * 더블탭한 단어(+그 문장 맥락)를 뜻 팝업으로 올리는 콜백을 자식(문장 토큰)에게 내려보내는 통로.
 * null이면(담기 대상이 아닌 자리) 문장을 평범한 텍스트로 폴백한다(안전).
 */
const WordPickContext = createContext<((word: string, sentence: string) => void) | null>(null);

// ---------------------------------------------------------------------------
// 문장 → 단어 토큰(더블탭 감지) (M2)
// ---------------------------------------------------------------------------

/**
 * 영어 문장 한 개를 단어 토큰으로 쪼개, 각 토큰의 **더블탭**을 감지해 뜻 팝업을 연다(M2).
 * V2/V8의 공백 토큰화를 재사용하되 이건 별개 제스처(더블탭)라 이어읽기·문장 🔊와 독립이다.
 *
 * - 각 토큰은 <button> + touch-action:manipulation(모바일 더블탭 확대 억제) + user-select:none.
 * - **단일탭은 arming만**(무동작) → 두 번째 탭이 DOUBLE_TAP_MS 안에 같은 토큰에 오면 더블탭으로 확정.
 * - 세 번째 탭이 또 열지 않게, 확정 시 lastTap을 비워 소비한다(V8과 같은 규약).
 */
function SentenceWords({ en }: { en: string }) {
  const onPick = useContext(WordPickContext);
  const tokens = useMemo(() => en.split(/\s+/).filter(Boolean), [en]);
  // 마지막으로 탭한 토큰 인덱스·시각 — 같은 토큰을 DOUBLE_TAP_MS 내 다시 탭하면 더블탭(뜻 팝업).
  const lastTap = useRef<{ i: number; t: number } | null>(null);

  if (!onPick) {
    return (
      <p className={s.en} lang="en">
        {en}
      </p>
    );
  }

  function onTap(i: number, tok: string) {
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.i === i && now - prev.t < DOUBLE_TAP_MS) {
      lastTap.current = null; // 소비 — 세 번째 탭이 또 열지 않게
      const w = cleanWord(tok);
      if (w) onPick?.(w, en);
    } else {
      lastTap.current = { i, t: now }; // 첫 탭 — 두 번째를 기다린다(단일탭은 무동작)
    }
  }

  return (
    <p className={s.en} lang="en">
      {tokens.map((tok, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          <button type="button" className={s.wordToken} onClick={() => onTap(i, tok)}>
            {tok}
          </button>
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 뜻 팝업(하단 시트) — 문맥 뜻 + 발음 + "모은 단어" 담기 (M2)
// ---------------------------------------------------------------------------

/**
 * 더블탭한 단어의 뜻 팝업(화면 하단 시트).
 * 열리면 그 단어+문장으로 뜻을 조회(호출 G)해 보여주고, 🔊 발음과 "모은 단어장에 추가"를 준다.
 * - 뜻 조회 실패는 비치명 — 안내만 하고 발음은 그대로 산다(담기는 뜻이 있어야 연다).
 * - 담기는 POST /api/english/vocab/collected/add-word 한 번(get-or-create + append). 성공/중복을 안내한다.
 */
function WordMeaningSheet({
  word,
  sentence,
  onClose,
}: {
  word: string;
  sentence: string;
  onClose: () => void;
}) {
  const [meaningPhase, setMeaningPhase] = useState<"loading" | "ready" | "error">("loading");
  const [meaningKo, setMeaningKo] = useState<string | null>(null);
  const [meaningError, setMeaningError] = useState<string | null>(null);
  const [addPhase, setAddPhase] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [addMessage, setAddMessage] = useState<string | null>(null);

  // 시트가 뜬 동안 body 스크롤 잠금(카드 오버레이·단어장 시트와 같은 공용 ref-count 락).
  useEffect(() => lockBodyScroll(), []);
  // Esc로 닫기(데스크톱) — 배경 탭·닫기 버튼과 함께 세 경로.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 뜻 조회(호출 G) — 단어가 바뀌면 다시 조회. 언마운트/재조회 시 stale 응답을 버린다.
  useEffect(() => {
    let alive = true;
    setMeaningPhase("loading");
    setMeaningKo(null);
    setMeaningError(null);
    setAddPhase("idle");
    setAddMessage(null);
    (async () => {
      try {
        const res = await fetch("/api/word-meaning", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ word, sentence }),
        });
        const data = (await res.json()) as WordMeaningResponse;
        if (!alive) return;
        if (data.ok) {
          setMeaningKo(data.meaningKo);
          setMeaningPhase("ready");
        } else {
          setMeaningError(data.messageKo);
          setMeaningPhase("error");
        }
      } catch {
        if (!alive) return;
        setMeaningError("뜻을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
        setMeaningPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [word, sentence]);

  async function addToCollected() {
    if (addPhase === "loading" || addPhase === "done") return; // 중복 클릭 방어
    if (meaningKo === null) return; // 뜻이 있어야 담는다
    setAddPhase("loading");
    setAddMessage(null);
    try {
      const res = await fetch("/api/english/vocab/collected/add-word", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word, meaningKo }),
      });
      const data = (await res.json()) as CollectedAddWordResponse;
      if (data.ok) {
        setAddMessage(data.added ? "모은 단어장에 담았어요!" : "이미 모은 단어장에 있어요.");
        setAddPhase("done");
      } else {
        setAddMessage(data.messageKo);
        setAddPhase("error");
      }
    } catch {
      setAddMessage("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setAddPhase("error");
    }
  }

  const canAdd = meaningPhase === "ready" && addPhase !== "loading" && addPhase !== "done";

  return (
    <div
      className={s.sheetBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${word} 뜻과 담기`}
      onClick={onClose}
    >
      {/* 시트 안쪽 클릭은 닫힘으로 전파되지 않게 막는다 */}
      <div className={s.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={s.sheetWordRow}>
          <p className={s.sheetWord} lang="en">
            {word}
          </p>
          <button
            type="button"
            className={s.sheetSpeak}
            aria-label={`${word} 발음 듣기`}
            title="발음 듣기"
            onClick={() => speak(word)}
          >
            🔊
          </button>
        </div>

        {/* 뜻(문맥) — 로딩 → 뜻 → 실패 안내 */}
        {meaningPhase === "loading" && (
          <p className={s.sheetMeaning} role="status">
            <span aria-hidden>⏳</span> 뜻을 불러오는 중…
          </p>
        )}
        {meaningPhase === "ready" && meaningKo !== null && (
          <p className={s.sheetMeaning} role="status">
            {meaningKo}
          </p>
        )}
        {meaningPhase === "error" && (
          <p className={`${s.sheetMeaning} ${s.sheetError}`} role="status">
            {meaningError ?? "뜻을 불러오지 못했어요."}
          </p>
        )}

        {/* 담기 결과 안내(있을 때만) */}
        {addMessage && (
          <p className={`${s.sheetAddMsg} ${addPhase === "error" ? s.sheetError : ""}`} role="status">
            {addMessage}
          </p>
        )}

        <div className={s.sheetBtns}>
          <button
            type="button"
            className={`u-btn u-btn-primary ${s.sheetBtn}`}
            onClick={addToCollected}
            disabled={!canAdd}
          >
            {addPhase === "loading" ? (
              <>
                <span aria-hidden>⏳</span> 담는 중…
              </>
            ) : (
              <>
                <span aria-hidden>➕</span> 모은 단어장에 추가
              </>
            )}
          </button>
          <button type="button" className={`u-btn ${s.sheetBtn}`} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

/** matched(내용 있음) 챕터 중 첫 번째를 기본 선택 — 없으면 0번 */
function firstMatchedIndex(chapters: readonly Chapter[]): number {
  const idx = chapters.findIndex((ch) => ch.matched && ch.sentences.length > 0);
  return idx >= 0 ? idx : 0;
}

/** 선택된 챕터 한 개의 본문(문장 목록 또는 "못 찾음" 안내) */
function ChapterBody({ chapter }: { chapter: Chapter }) {
  if (!chapter.matched || chapter.sentences.length === 0) {
    return (
      <p className={s.notFound}>
        이 챕터는 낭독 자막에서 찾지 못했어요. 영상이 이 챕터까지 닿지 않았거나 이 부분을 읽지 않았을 수 있어요.
      </p>
    );
  }
  return (
    <>
      <div className={s.chapterTools}>
        <button
          type="button"
          className={s.readAllBtn}
          onClick={() => speakSequence(chapter.sentences.map((sent) => sent.en))}
        >
          🔊 이 챕터 이어 읽기
        </button>
      </div>
      <ol className={s.sentences}>
        {chapter.sentences.map((sent, i) => (
          <li key={i} className={s.sentence}>
            <div className={s.enRow}>
              {/* 영어 문장 — 단어를 더블탭하면 뜻 팝업(M2). 단일탭·문장 🔊와 겹치지 않는다. */}
              <SentenceWords en={sent.en} />
              <button
                type="button"
                className={s.speak}
                aria-label="이 문장 영어로 듣기"
                title="영어로 듣기"
                onClick={() => speak(sent.en)}
              >
                🔊
              </button>
            </div>
            <p className={s.ko}>{sent.ko}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** 챕터가 있을 때의 리더(목록 + 본문) */
function Reader({
  chapters,
  onRechapterize,
  busy,
}: {
  chapters: Chapter[];
  onRechapterize: () => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(() => firstMatchedIndex(chapters));
  // selected가 범위를 벗어나지 않게(챕터 수가 바뀌는 경우 대비) 안전하게 좁힌다
  const active = chapters[Math.min(selected, chapters.length - 1)] ?? chapters[0];
  const matchedCount = useMemo(() => chapters.filter((ch) => ch.matched).length, [chapters]);

  // 목차 없이 자막만 있으면 "전체" 단일 챕터 하나로 온다 — 챕터 목록·제목 없이 문장을 바로 보여준다.
  // (실제 목차가 1챕터인 책은 제목이 있으므로 "전체"로 오판하지 않게 제목까지 확인한다.)
  const single = chapters.length === 1 && chapters[0]?.titleEn === WHOLE_TRANSCRIPT_TITLE;

  return (
    <div className={s.reader}>
      <p className={s.readerNote}>
        {single
          ? "낭독 자막 전체를 영어 원문과 우리말 해석으로 담았어요. 🔊로 문장을 영어로 들을 수 있어요. "
          : `낭독 자막을 목차의 챕터별로 나눴어요. 챕터를 고르면 영어 원문과 우리말 해석을 함께 볼 수 있고, 🔊로 영어를 들을 수 있어요. `}
        <strong>단어를 두 번 톡톡</strong> 치면 뜻과 발음을 보고 모은 단어장에 담을 수 있어요.
        {!single && ` (챕터 ${chapters.length}개 중 ${matchedCount}개에 내용이 있어요.)`}
      </p>

      {/* 챕터 목록 — 가로 스크롤 탭. matched 아닌 챕터는 흐리게. 단일 "전체" 챕터면 목록 생략 */}
      {!single && (
        <div className={s.tabs} role="tablist" aria-label="챕터 목록">
          {chapters.map((ch, i) => {
            const isActive = ch === active;
            const dim = !ch.matched || ch.sentences.length === 0;
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`${s.tab} ${isActive ? s.tabActive : ""} ${dim ? s.tabDim : ""}`}
                onClick={() => setSelected(i)}
              >
                <span className={s.tabNo}>{i + 1}</span>
                <span className={s.tabTitle} lang="en">
                  {ch.titleEn}
                </span>
                {dim && <span className={s.tabDimMark}>내용 없음</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* 선택된 챕터 본문 (단일 "전체" 챕터면 제목 헤딩 생략하고 문장부터) */}
      <div className={s.chapterPane}>
        {!single && (
          <h4 className={s.chapterTitle} lang="en">
            {active.titleEn}
          </h4>
        )}
        <ChapterBody chapter={active} />
      </div>

      {/* 다시 나누기 — 자막·목차를 다시 넣을 필요 없이 book에 저장된 근거로 재호출 */}
      <div className={s.rechapterize}>
        <button type="button" className={s.rechapterizeBtn} onClick={onRechapterize} disabled={busy}>
          {busy ? "⏳ 다시 나누는 중…" : "🔀 다시 나누기"}
        </button>
      </div>
    </div>
  );
}

export default function ChapterReaderSection({
  bookId,
  chapters,
  canChapterize,
}: {
  bookId: string;
  /** 저장된 챕터화 결과(호출 F). null이면 아직 안 나눴거나 자막이 없다 */
  chapters: Chapter[] | null;
  /** 낭독 자막이 있어 챕터 리더를 만들 수 있는지(목차는 선택) — 서버가 판정해 넘긴다 */
  canChapterize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 더블탭한 단어(+그 문장 맥락). null이면 팝업 닫힘. (M2)
  const [picked, setPicked] = useState<{ word: string; sentence: string } | null>(null);

  const hasChapters = !!chapters && chapters.length > 0;

  // 목차/자막도 없고 챕터도 없으면 섹션 자체를 그리지 않는다(회귀 0)
  if (!hasChapters && !canChapterize) return null;

  async function runChapterize() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chapterize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; messageKo?: string }
        | null;
      if (res.ok && data?.ok) {
        // 서버 컴포넌트를 다시 읽어 book.chapters(새 결과)를 화면에 반영한다
        router.refresh();
        return;
      }
      setError(data?.messageKo ?? "챕터로 나누지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.section} aria-label="챕터별로 읽기">
      <h3 className={s.h3}>
        📖 챕터별로 읽기 <span className={s.h3en}>Chapter Reader</span>
      </h3>

      {/* 문장 단어 더블탭 → 뜻 팝업 통로(M2). 리더 안 문장 토큰이 이 콜백으로 단어를 올린다. */}
      <WordPickContext.Provider value={(word, sentence) => setPicked({ word, sentence })}>
        {hasChapters ? (
          <Reader chapters={chapters!} onRechapterize={runChapterize} busy={busy} />
        ) : (
          <div className={s.cta}>
            <p className={s.ctaText}>
              이 책은 유튜브 낭독 자막이 있어요. 자막을 영어 원문과 우리말 해석으로 담아 함께
              읽을 수 있어요. 목차가 있으면 챕터별로, 없으면 전체를 하나로 보여줘요.
            </p>
            <button type="button" className={s.ctaBtn} onClick={runChapterize} disabled={busy}>
              {busy ? "⏳ 만드는 중…" : "📖 챕터로 읽기 만들기"}
            </button>
          </div>
        )}
      </WordPickContext.Provider>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}

      {picked && (
        <WordMeaningSheet
          key={`${picked.word}::${picked.sentence}`}
          word={picked.word}
          sentence={picked.sentence}
          onClose={() => setPicked(null)}
        />
      )}
    </section>
  );
}

"use client";

/**
 * 학습 카드 화면 (SPEC §4-2) — design/영어책_학습카드_샘플.html의 룩앤필 이식.
 * 구성 순서: 북헤더 → 이 책은? → STEP 1~4 → [논픽션] funFacts → 확장 놀이.
 * 클라이언트 컴포넌트인 이유: 단어별 스피커(speechSynthesis)·인쇄(window.print)·
 * "다시 생성"(fetch) 상호작용 때문. lib/store는 타입만 import한다(값 import 금지).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
// schemas.ts는 zod 외에 아무것도 import하지 않는 순수 모듈이라 클라이언트 컴포넌트에서
// 값 import해도 안전하다 (lib/ai/client.ts와 달리 openai·API 키를 건드리지 않는다).
import {
  resolveStorySource,
  STORY_SOURCE_LABELS_KO,
  type SceneDigestItem,
  type StorySource,
} from "@/lib/ai/english/schemas";
// 발음 재생은 lib/speech.ts가 단일 정의처다 (lang·rate 다이얼이 화면마다 갈리지 않도록).
import { speak } from "@/lib/speech";
import type { BookRecord, CardRecord, ReadingRecord } from "@/lib/store";
// 챕터 리더(호출 F, §9) — 목차+자막이 있을 때만 스스로를 그린다(없으면 null → 회귀 0).
import ChapterReaderSection from "./chapter-reader";
import s from "./card-view.module.css";

/**
 * 카드 히스토리 한 줄 — 서버가 CardRecord에서 화면에 필요한 것만 추려 넘긴다
 * (카드 본문을 버전 수만큼 클라이언트로 보내지 않기 위해).
 */
export interface CardHistoryItem {
  id: string;
  createdAt: string; // ISO 8601
  model: string;
  /** 근거 배지 — 서버에서 resolveStorySource()를 거친 값(구·신 카드 모두 해석됨) */
  storySource: StorySource | null;
  /** 장면 메모 개수 — 버전 간 차이를 한눈에 보여주는 지표 */
  sceneCount: number;
}

/** 예문 속 대상 단어를 굵게 (첫 일치 부분만) */
function ExampleEn({ example, word }: { example: string; word: string }) {
  const idx = example.toLowerCase().indexOf(word.toLowerCase());
  if (idx < 0) return <>{example}</>;
  return (
    <>
      {example.slice(0, idx)}
      <b>{example.slice(idx, idx + word.length)}</b>
      {example.slice(idx + word.length)}
    </>
  );
}

/**
 * 장면별 읽기 가이드 (SPEC §4-2 구성 4번) — 호출 A′가 만든 sceneDigest를 보여준다.
 *
 * 왜 접히는 섹션인가: 카드는 A4 1~2쪽 인쇄를 목표로 한 **한 장짜리 물건**이다(SPEC §4-2).
 * 그림책 펼침면 16장이면 장면도 16개라 본문에 펼쳐 놓으면 카드가 아니라 책이 된다.
 * 그래서 카드 본문에는 확장된 storyOutlineKo만 두고, 장면별 요약은 접어 둔다.
 * 인쇄에서는 통째로 빠진다(모듈 CSS의 @media print).
 *
 * askKo가 이 섹션의 핵심이다 — STEP 4의 질문 8개는 책 전체 기준이라 부모가 "언제
 * 던질지"를 판단해야 하는데, 장면에 붙은 질문은 그 부담이 없다. 책장을 넘기면서
 * 그 자리에서 바로 읽으면 된다.
 */
function ReadingGuide({ scenes }: { scenes: SceneDigestItem[] }) {
  const askCount = scenes.filter((scene) => scene.askKo?.trim()).length;

  return (
    <details className={s.guide}>
      <summary className={s.guideSummary}>
        <span className={s.guideTitle}>📑 장면별 읽기 가이드</span>
        <span className={s.guideMeta}>
          {scenes.length}장면{askCount > 0 ? ` · 질문 ${askCount}개` : ""}
        </span>
        <span className={s.guideToggle} aria-hidden>
          펼치기
        </span>
      </summary>

      <p className={s.guideNote}>
        책장을 넘기면서 그 자리에서 바로 쓰는 질문이에요. STEP 4의 질문은 다 읽고 나서
        나누는 대화용이고, 여기 질문은 <b>지금 보고 있는 그 장면</b>에 대한 거예요.
      </p>

      <ol className={s.scenes}>
        {scenes.map((scene, i) => (
          <li key={i} className={s.scene}>
            {/*
             * gapBefore는 불리언이라 '몇 장면이 빠졌는지'를 표현하지 못한다
             * (연속으로 빠져도 마커는 1개). 그래서 개수를 단정하지 않는다.
             * 앱이 내용을 지어내 메우지 않았다는 사실만 알린다 (SPEC §7-1′).
             */}
            {scene.gapBefore && (
              <p className={s.sceneGap}>
                ⋯ 이 사이가 비어 있어요 — 사진이 빠졌거나 순서가 바뀐 것 같아요
              </p>
            )}
            <p className={s.sceneLabel}>{scene.labelKo}</p>
            <p className={s.sceneText}>{scene.summaryKo}</p>
            {scene.askKo && <p className={s.sceneAsk}>💬 {scene.askKo}</p>}
            {scene.confidence === "low" && (
              <p className={s.sceneWarn}>
                🔍 이 사진은 흐려서 잘 못 읽었어요. 이 장면만 다시 찍으면 더 정확해져요.
              </p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** 사용자 로컬 달력 기준 오늘 (YYYY-MM-DD) — 읽은 '날'의 기준은 브라우저 쪽이다 */
function localDateString(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * "오늘 읽었어요" 읽음 기록 (M3, SPEC §4-3) — 별점(1~5, 선택)과 함께 POST /api/readings.
 * '오늘' 판정은 hydration 이후 로컬 날짜로 한다 (SSR 시점의 서버 시간과 어긋나도
 * 화면이 깨지지 않도록 마운트 전에는 중립 상태를 그린다).
 */
function ReadingLog({
  bookId,
  initialReadings,
}: {
  bookId: string;
  initialReadings: ReadingRecord[];
}) {
  const [readings, setReadings] = useState(initialReadings);
  const [today, setToday] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToday(localDateString());
  }, []);

  const todayReading = today
    ? readings.find((r) => r.readAt.slice(0, 10) === today)
    : undefined;

  async function recordToday() {
    setBusy(true);
    setError(null);
    // 클릭 시점의 로컬 날짜를 한 번만 계산해 POST와 today 갱신에 함께 쓴다.
    // 자정을 넘긴 스테일 화면에서도 성공 시 '오늘' 기준이 현재 날짜로 맞춰진다 (QA F1).
    const d = localDateString();
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId,
          readAt: d,
          ...(rating > 0 ? { rating } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; duplicate?: boolean; reading?: ReadingRecord; messageKo?: string }
        | null;
      if (res.ok && data?.ok && data.reading) {
        const reading = data.reading;
        // duplicate 여부와 무관하게 중복 없이 병합 — 다른 탭/기기에서 이미 기록된
        // 기존 reading(duplicate 응답)도 상태에 반영돼 완료 패널이 뜬다 (QA F1).
        setReadings((prev) =>
          prev.some((r) => r.id === reading.id) ? prev : [reading, ...prev]
        );
        setToday(d);
        setFeedback(data.messageKo ?? "오늘의 읽기를 기록했어요!");
      } else {
        setError(data?.messageKo ?? "기록에 실패했어요. 잠시 후 다시 시도해 주세요.");
      }
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.reading} aria-label="읽음 기록">
      <h3 className={s.readingTitle}>📖 오늘 읽었어요</h3>
      {readings.length > 0 && (
        <p className={s.readingCount}>지금까지 이 책을 {readings.length}번 읽었어요.</p>
      )}

      {todayReading ? (
        // 오늘 기록 완료 — 확인 피드백
        <div className={s.readingDone}>
          <p className={s.readingDoneMsg}>
            ✅ 오늘 읽기 완료!
            {todayReading.rating != null && (
              <span className={s.readingStars} aria-label={`별점 ${todayReading.rating}점`}>
                {" "}
                {"★".repeat(todayReading.rating)}
                {"☆".repeat(5 - todayReading.rating)}
              </span>
            )}
          </p>
          {feedback && <p className={s.readingFeedback}>{feedback}</p>}
          <Link href="/library" className={s.readingLibraryLink}>
            📚 서재에서 읽기 기록 모아보기 →
          </Link>
        </div>
      ) : (
        <div className={s.readingForm}>
          <div className={s.readingRatingRow}>
            <span className={s.readingRatingLabel}>오늘은 몇 점? (선택)</span>
            <span role="group" aria-label="별점 선택">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={s.starBtn}
                  aria-pressed={rating >= n}
                  aria-label={`별점 ${n}점`}
                  // 같은 별을 다시 누르면 별점 취소 (별점은 선택 사항)
                  onClick={() => setRating(rating === n ? 0 : n)}
                >
                  {rating >= n ? "★" : "☆"}
                </button>
              ))}
            </span>
          </div>
          <button
            type="button"
            className={s.readingSubmit}
            onClick={recordToday}
            disabled={busy || today == null}
          >
            {busy ? "⏳ 기록하는 중…" : "✔ 오늘 읽었어요"}
          </button>
          {error && <p className={s.actionsError}>{error}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * 카드 히스토리 (story-4) — 이 책의 카드 버전 목록.
 *
 * 왜 여기 있나: 서재 목록은 **책 단위**라 재생성으로 쌓인 버전이 보이지 않는다.
 * 보이는 단위와 지우는 단위를 맞추기 위해, 버전 목록과 **낱개 삭제**를 이 페이지에 둔다
 * (서재에서는 책을, 여기서는 카드를 지운다). 예전에는 서재의 한 줄을 지우면 형제
 * 카드가 통째로 사라졌다.
 *
 * 장면별 읽기 가이드와 같은 규약: **기본 접힘 + 인쇄 제외.** 카드가 A4 1~2쪽
 * 인쇄물이라는 제약(SPEC §4-2)은 그대로다 — 히스토리는 종이에 나올 것이 아니다.
 */
function CardHistory({
  history,
  currentCardId,
  bookTitle,
}: {
  history: CardHistoryItem[];
  currentCardId: string;
  bookTitle: string;
}) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [lastCardBookId, setLastCardBookId] = useState<string | null>(null);

  // 버전이 1장뿐이면 보여줄 "히스토리"가 없다 — 섹션 자체를 생략한다
  if (history.length <= 1) return null;

  async function runDelete(item: CardHistoryItem) {
    setBusyId(item.id);
    setErrorKo(null);
    setLastCardBookId(null);
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; messageKo?: string; bookId?: string; latestCardId?: string }
        | null;

      if (res.ok && data?.ok) {
        setConfirmId(null);
        // 지금 보던 버전을 지웠으면 남은 최신 버전으로 옮겨 간다 (404 화면 방지)
        if (item.id === currentCardId && data.latestCardId) {
          router.push(`/card/${data.latestCardId}`);
          return;
        }
        router.refresh();
        return;
      }
      if (res.status === 409) {
        // 마지막 한 장 — 카드만 지우면 열 수 없는 책이 남는다. 책 삭제로 안내한다.
        setLastCardBookId(data?.bookId ?? null);
        setErrorKo(data?.messageKo ?? "이 책의 마지막 카드예요.");
        setConfirmId(null);
        return;
      }
      if (res.status === 404) {
        // 이미 지워진 카드(다른 기기·중복 클릭) — 새로고침하면 목록에서 사라진다
        setConfirmId(null);
        router.refresh();
        return;
      }
      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <details className={s.history}>
      <summary className={s.guideSummary}>
        <span className={s.guideTitle}>🗂 카드 히스토리</span>
        <span className={s.guideMeta}>{history.length}장</span>
        <span className={s.guideToggle} aria-hidden>
          펼치기
        </span>
      </summary>

      <p className={s.guideNote}>
        『{bookTitle}』로 만든 카드예요. &ldquo;다시 생성&rdquo;은 예전 카드를 덮어쓰지 않고
        새로 쌓기 때문에 <b>이전 버전과 비교</b>할 수 있어요. 지우면 그 버전 하나만 사라져요.
      </p>

      {errorKo && (
        <p role="alert" className={s.historyError}>
          {errorKo}
          {lastCardBookId && (
            <>
              {" "}
              <Link href="/library" className={s.historyLink}>
                서재에서 책 지우기 →
              </Link>
            </>
          )}
        </p>
      )}

      <ol className={s.versions}>
        {history.map((item, i) => {
          const isCurrent = item.id === currentCardId;
          return (
            <li key={item.id} className={s.version}>
              <div className={s.versionHead}>
                <span className={s.versionNo}>
                  v{history.length - i}
                  {i === 0 && <span className={s.versionLatest}> · 최신</span>}
                </span>
                {isCurrent && <span className={s.versionCurrent}>지금 보는 카드</span>}
              </div>
              <p className={s.versionMeta}>
                {item.createdAt.slice(0, 10).replace(/-/g, ".")}
                {item.storySource && ` · ${STORY_SOURCE_LABELS_KO[item.storySource]}`}
                {item.sceneCount > 0 && ` · 장면 ${item.sceneCount}개`}
              </p>
              <p className={s.versionModel}>{item.model}</p>

              {confirmId === item.id ? (
                <div role="group" aria-label="삭제 확인" className={s.versionConfirm}>
                  <p className={s.versionConfirmMsg}>
                    이 카드 <b>한 장만</b> 지울까요? 책과 다른 버전, 읽기 기록은 그대로예요.
                  </p>
                  <div className={s.versionBtns}>
                    <button
                      type="button"
                      onClick={() => void runDelete(item)}
                      disabled={busyId === item.id}
                      className={`${s.versionBtn} ${s.versionBtnDanger}`}
                    >
                      {busyId === item.id ? "지우는 중…" : "지우기"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      disabled={busyId === item.id}
                      className={s.versionBtn}
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div className={s.versionBtns}>
                  {!isCurrent && (
                    <Link href={`/card/${item.id}`} className={s.versionBtn}>
                      이 버전 보기
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmId(item.id);
                      setErrorKo(null);
                      setLastCardBookId(null);
                    }}
                    className={s.versionBtn}
                  >
                    🗑 지우기
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default function CardView({
  book,
  card,
  readings,
  history,
  canChapterize,
}: {
  book: BookRecord;
  card: CardRecord;
  readings: ReadingRecord[];
  /** 이 책의 카드 버전 목록(최신순). 1장뿐이면 섹션이 생략된다 */
  history: CardHistoryItem[];
  /** 목차(toc)+낭독 자막이 둘 다 있어 챕터로 나눌 수 있는가 — 서버가 판정해 넘긴다(§9) */
  canChapterize: boolean;
}) {
  const router = useRouter();
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const c = card.content;
  // 픽션/논픽션 = 색조가 아니라 같은 파랑의 명도 차이 (DESIGN §2).
  // globals.css의 테마 스코프 클래스가 --accent를 갈아끼우므로, 카드 안의
  // 컬러바·STEP 배지·칩·질문 태그가 한 번에 따라온다. 칩 라벨을 함께 표시해
  // 색만으로 구분하지 않는다(접근성).
  const theme = book.isFiction ? "theme-fiction" : "theme-nonfiction";
  const emoji = book.coverEmoji || "📖";

  /*
   * 줄거리 근거 배지 (SPEC §4-2) — 예상 / 소개글 기반 / 목차 기반 / 본문 확인.
   * 근거가 두꺼울수록 부모가 더 믿고 쓸 수 있다는 것을 한눈에 보이게 한다.
   *
   * 반드시 resolveStorySource()를 거친다. 신규 카드에는 storySource만, 구 카드에는
   * storyIsGuess만 있어서 어느 한쪽을 직접 비교하면 다른 세대가 조용히 죽는다
   * (`c.storyIsGuess === true`가 신규 카드에서 항상 false였던 QA F5 회귀).
   * 배지 문구도 여기 적지 않는다 — STORY_SOURCE_LABELS_KO가 단일 정의처다.
   */
  const storySrc = resolveStorySource(c);
  const sceneDigest = c.sceneDigest ?? [];

  const youtubeQuery = [book.title, book.author !== "미상" ? book.author : "", "read aloud"]
    .filter(Boolean)
    .join(" ");
  const youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(youtubeQuery)}`;

  const byline = [
    book.series,
    `${book.author} 지음`,
    book.isFiction ? "픽션(이야기 책)" : "논픽션(실제 정보를 알려주는 책)",
  ]
    .filter(Boolean)
    .join(" · ");

  /** "다시 생성" — 같은 book으로 /api/card 재호출, 기존 카드는 유지 (SPEC §4-2) */
  async function regenerate() {
    setRegenBusy(true);
    setRegenError(null);
    let navigating = false;
    try {
      const res = await fetch("/api/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: book.id }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; cardId?: string; messageKo?: string }
        | null;
      if (res.ok && data?.ok && data.cardId) {
        navigating = true;
        router.push(`/card/${data.cardId}`);
        return;
      }
      setRegenError(data?.messageKo ?? "다시 생성에 실패했어요. 잠시 후 또 시도해 주세요.");
    } catch {
      setRegenError("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (!navigating) setRegenBusy(false);
    }
  }

  return (
    <div className={`${s.wrap} ${theme}`}>
      {/* 액션 바 — 인쇄 시 숨김 */}
      <div className={s.actions}>
        {/* 북카드 홈은 `/english/books`다 (`/english`는 허브, `/`는 과목 선택 갈림길) —
            카드에서 돌아올 때 고르기 화면을 한 번 더 지나지 않게 북카드 홈으로 바로 간다 */}
        <Link href="/english/books" className={s.actionBtn}>← 홈으로</Link>
        <Link href="/library" className={s.actionBtn}>📚 서재</Link>
        <button type="button" className={s.actionBtn} onClick={() => window.print()}>
          🖨️ 인쇄
        </button>
        <a className={s.actionBtn} href={youtubeUrl} target="_blank" rel="noopener noreferrer">
          ▶️ 읽어주기 영상 찾기
        </a>
        <button type="button" className={s.actionBtn} onClick={regenerate} disabled={regenBusy}>
          {regenBusy ? "⏳ 카드 만드는 중…" : "🔄 다시 생성"}
        </button>
      </div>
      {regenError && <p className={s.actionsError}>{regenError}</p>}

      <article className={s.book}>
        <div className={s.bookbar} />

        {/* 1. 북헤더 — 썸네일이 있으면 썸네일 우선, 없으면 이모지 (SPEC §8) */}
        <div className={s.bookhead}>
          {book.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일 1장, next/image 원격 설정은 과설계
            <img className={s.coverImg} src={book.coverUrl} alt={`${book.title} 표지`} />
          ) : (
            <div className={s.cover} aria-hidden>{emoji}</div>
          )}
          <div>
            <h2 className={s.title}>{book.title}</h2>
            <div className={s.byline}>{byline}</div>
            <div className={s.chips}>
              {/* 상단 컬러바와 짝을 이루는 유형 라벨만 파란 칩 — 나머지 메타는 중립 칩 */}
              <span className={s.chipHl}>{book.isFiction ? "픽션" : "논픽션"}</span>
              {book.arLevel != null && <span className={s.chip}>AR {book.arLevel}</span>}
              {book.lexile != null && <span className={s.chip}>Lexile {book.lexile}L</span>}
              {book.wordCount != null && (
                <span className={s.chip}>{book.wordCount.toLocaleString()} 단어</span>
              )}
              {book.levelEstimated && <span className={s.chipEstimated}>레벨 추정</span>}
            </div>
          </div>
        </div>

        {/* 2. 이 책은? (2문장 소개 + 레벨 설명) */}
        <p className={s.intro}>
          {c.bookIntroKo} {c.levelNoteKo}
        </p>

        {/*
         * 3. 줄거리/내용 미리보기 (storyOutlineKo, SPEC §4-2) — 픽션은 "줄거리",
         * 논픽션은 "내용". 근거 배지는 storySource로 판정(4종).
         * 구(舊) 저장 카드에는 이 필드가 없다 — 부재 시 섹션을 조용히 생략(하위 호환).
         */}
        {c.storyOutlineKo && (
          <section className={s.section}>
            <div className={s.story}>
              <h3 className={s.storyTitle}>
                📖 {book.isFiction ? "줄거리 미리보기" : "내용 미리보기"}
                {storySrc && (
                  <span className={s.chipEstimated}>{STORY_SOURCE_LABELS_KO[storySrc]}</span>
                )}
              </h3>
              <p className={s.storyText}>{c.storyOutlineKo}</p>
            </div>
          </section>
        )}

        {/*
         * 4. 장면별 읽기 가이드 — sceneDigest가 있을 때만 (SPEC §4-2 구성 4번).
         * 없으면 섹션 통째 생략: 표지만으로 만든 카드·구 저장 카드는 화면이 그대로다.
         */}
        {sceneDigest.length > 0 && (
          <section className={s.guideSection}>
            <ReadingGuide scenes={sceneDigest} />
          </section>
        )}

        {/* 5. STEP 1 읽기 전 워밍업 */}
        <section className={s.section}>
          <h3 className={s.h3}>
            <span className={s.step}>STEP 1</span> 읽기 전 워밍업 <span className={s.h3en}>Before Reading</span>
          </h3>
          <ul className={s.plain}>
            {c.beforeReading.map((item, i) => (
              <li key={i}>{item.ko}</li>
            ))}
          </ul>
        </section>

        {/* 5. STEP 2 필수 단어장 + 엄빠 티칭 포인트 */}
        <section className={s.section}>
          <h3 className={s.h3}>
            <span className={s.step}>STEP 2</span> 필수 단어장{" "}
            <span className={s.h3en}>Key Words · {c.vocab.length}</span>
          </h3>
          <div className={s.tableWrap}>
            <table className={s.vocab}>
              <thead>
                <tr>
                  <th>단어</th>
                  <th>뜻</th>
                  <th className={s.easy}>쉬운 영어로</th>
                  <th>이렇게 써요</th>
                </tr>
              </thead>
              <tbody>
                {c.vocab.map((v) => (
                  <tr key={v.word}>
                    {/* 영단어가 카드에서 가장 큰 글자 (26/700) — 아이가 먼저 본다 */}
                    <td className={s.w}>
                      <span className={s.wordRow}>
                        <span className={s.word}>{v.word}</span>
                        <button
                          type="button"
                          className={s.speak}
                          aria-label={`${v.word} 발음 듣기`}
                          title="발음 듣기"
                          onClick={() => speak(v.word)}
                        >
                          🔊
                        </button>
                      </span>
                      <span className={s.pron}>[{v.pronKo}]</span>
                      {(v.isCore || v.difficulty === "challenge") && (
                        <span className={s.marks}>
                          {v.isCore ? <span className={s.mark}>★ 핵심</span> : null}
                          {v.difficulty === "challenge" ? (
                            <span className={s.mark}>★ 도전</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className={s.mean}>{v.meaningKo}</td>
                    <td className={s.easy}>{v.easyEn}</td>
                    <td className={s.ex}>
                      <ExampleEn example={v.exampleEn} word={v.word} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.tip}>
            <b>엄빠 티칭 포인트:</b> {c.teachingTipKo}
          </div>
        </section>

        {/* 6. STEP 3 읽으면서 미션 */}
        <section className={s.section}>
          <h3 className={s.h3}>
            <span className={s.step}>STEP 3</span> 읽으면서 미션 <span className={s.h3en}>While Reading</span>
          </h3>
          <ul className={s.plain}>
            {c.whileReading.map((item, i) => (
              <li key={i}>{item.ko}</li>
            ))}
          </ul>
        </section>

        {/* 7. STEP 4 읽고 나서 대화 */}
        <section className={s.section}>
          <h3 className={s.h3}>
            <span className={s.step}>STEP 4</span> 읽고 나서 대화 나누기{" "}
            <span className={s.h3en}>After Reading · {c.questions.length} Questions</span>
          </h3>
          <ol className={s.talk}>
            {c.questions.map((q, i) => (
              <li key={i}>
                <span className={s.qtag}>{q.type}</span>
                <p className={s.qEn}>{q.en}</p>
                <p className={s.qKo}>{q.ko}</p>
                {q.hintKo && <p className={s.qHint}>{q.hintKo}</p>}
              </li>
            ))}
          </ol>
        </section>

        {/* 8. [논픽션만] 엄빠 찬스: 재미있는 사실 */}
        {!book.isFiction && c.funFacts && c.funFacts.length > 0 && (
          <section className={s.section}>
            <h3 className={s.h3}>
              <span className={s.step}>보너스</span> 엄빠 찬스 · 재미있는 사실{" "}
              <span className={s.h3en}>Fun Facts</span>
            </h3>
            <ul className={s.plain}>
              {c.funFacts.map((fact, i) => (
                <li key={i}>
                  <span className={s.factEn}>{fact.en}</span>
                  <span className={s.factKo}>{fact.ko}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 9. 확장 놀이 */}
        <section className={s.section}>
          <h3 className={s.h3}>
            <span className={s.step}>확장 놀이</span> 몸으로 한 번 더 <span className={s.h3en}>Play &amp; Learn</span>
          </h3>
          <ul className={s.plain}>
            {c.activities.map((activity, i) => (
              <li key={i}>
                <b>{activity.titleKo}:</b> {activity.descKo}
              </li>
            ))}
          </ul>
        </section>
      </article>

      {/*
       * 챕터별로 읽기 (호출 F · §9) — 낭독 자막이 있는 책에 나타난다(목차는 선택).
       * chapters가 저장돼 있으면 리더를(챕터별 또는 "전체" 단일 블록), 아직 안 만들었으면
       * "챕터로 읽기 만들기" 버튼을 그린다. 자막이 없으면 canChapterize=false·chapters=null이라
       * 아무것도 그리지 않는다(회귀 0). 화면 전용(자체 @media print로 숨김) —
       * 영어 원문 표시는 §9가 이 리더에 한해 허용한 것이다.
       */}
      <ChapterReaderSection bookId={book.id} chapters={book.chapters} canChapterize={canChapterize} />

      {/* M3 — 읽음 기록 (인쇄 시 숨김, SPEC §4-3) */}
      <ReadingLog bookId={book.id} initialReadings={readings} />

      {/* story-4 — 카드 히스토리 (버전 전환·낱개 삭제). 1장뿐이면 렌더되지 않는다 */}
      <CardHistory history={history} currentCardId={card.id} bookTitle={book.title} />

      <footer className={s.note}>
        {/* 무엇을 근거로 만들었는지는 storySource가 안다 — 사실과 다른 안내를 하지 않는다 */}
        <p>
          <b>이 카드는 이렇게 만들어졌어요:</b>{" "}
          {storySrc === "pages" || storySrc === "toc"
            ? `책의 제목·난이도·주제 같은 정보와, 올려 주신 ${
                storySrc === "toc" ? "목차" : "본문"
              } 사진에서 읽은 우리말 요약을 근거로 새로 만든 카드예요. 영어 원문은 옮기지 않았고, 올린 사진은 저장하지 않아요.`
            : storySrc === "transcript"
              ? "책의 제목·난이도·주제 같은 정보와, 유튜브 낭독 영상의 자막(책 전체 내용)을 근거로 새로 만든 카드예요. 영어 원문은 그대로 옮기지 않았어요."
              : storySrc === "blurb"
                ? "책의 제목·난이도·주제 같은 정보와 뒤표지 소개글을 근거로 새로 만든 카드예요. 책 본문은 옮기지 않았어요."
                : "책의 제목·난이도·주제 같은 정보만으로 새로 만든 카드예요. 책 본문은 옮기지 않았어요."}
        </p>
        {/* 종이에서는 의미 없는 안내 — 인쇄 시 숨김 (M4) */}
        <p className={s.printHide}>🖨️ 인쇄 버튼을 누르면 종이로 뽑아 책 옆에 두고 쓸 수 있어요.</p>
      </footer>
    </div>
  );
}

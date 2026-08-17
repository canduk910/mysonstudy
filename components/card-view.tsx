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
import type { BookRecord, CardRecord, ReadingRecord } from "@/lib/store";
import s from "./card-view.module.css";

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

/** 단어 발음 재생 — Web Speech API (en-US, 외부 API·비용 없음) */
function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
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

export default function CardView({
  book,
  card,
  readings,
}: {
  book: BookRecord;
  card: CardRecord;
  readings: ReadingRecord[];
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
        <Link href="/" className={s.actionBtn}>← 홈으로</Link>
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
         * 논픽션은 "내용". storyIsGuess=true면 "예상" 배지(레벨 추정 배지와 같은 스타일).
         * 구(舊) 저장 카드에는 이 필드가 없다 — 부재 시 섹션을 조용히 생략(하위 호환).
         */}
        {c.storyOutlineKo && (
          <section className={s.section}>
            <div className={s.story}>
              <h3 className={s.storyTitle}>
                📖 {book.isFiction ? "줄거리 미리보기" : "내용 미리보기"}
                {c.storyIsGuess === true && <span className={s.chipEstimated}>예상</span>}
              </h3>
              <p className={s.storyText}>{c.storyOutlineKo}</p>
            </div>
          </section>
        )}

        {/* 4. STEP 1 읽기 전 워밍업 */}
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

        {/* 5. STEP 2 필수 단어장 + 아빠 티칭 포인트 */}
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
            <b>아빠 티칭 포인트:</b> {c.teachingTipKo}
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

        {/* 8. [논픽션만] 아빠 찬스: 재미있는 사실 */}
        {!book.isFiction && c.funFacts && c.funFacts.length > 0 && (
          <section className={s.section}>
            <h3 className={s.h3}>
              <span className={s.step}>보너스</span> 아빠 찬스 · 재미있는 사실{" "}
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

      {/* M3 — 읽음 기록 (인쇄 시 숨김, SPEC §4-3) */}
      <ReadingLog bookId={book.id} initialReadings={readings} />

      <footer className={s.note}>
        <p>
          <b>이 카드는 이렇게 만들어졌어요:</b> 책의 제목·난이도·주제 같은 정보만으로 새로 만든
          카드예요. 책 본문은 옮기지 않았어요.
        </p>
        {/* 종이에서는 의미 없는 안내 — 인쇄 시 숨김 (M4) */}
        <p className={s.printHide}>🖨️ 인쇄 버튼을 누르면 종이로 뽑아 책 옆에 두고 쓸 수 있어요.</p>
      </footer>
    </div>
  );
}

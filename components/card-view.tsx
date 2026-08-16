"use client";

/**
 * 학습 카드 화면 (SPEC §4-2) — design/영어책_학습카드_샘플.html의 룩앤필 이식.
 * 구성 순서: 북헤더 → 이 책은? → STEP 1~4 → [논픽션] funFacts → 확장 놀이.
 * 클라이언트 컴포넌트인 이유: 단어별 스피커(speechSynthesis)·인쇄(window.print)·
 * "다시 생성"(fetch) 상호작용 때문. lib/store는 타입만 import한다(값 import 금지).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BookRecord, CardRecord } from "@/lib/store";
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

export default function CardView({ book, card }: { book: BookRecord; card: CardRecord }) {
  const router = useRouter();
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const c = card.content;
  const theme = book.isFiction ? s.fiction : s.nonfiction;
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
              {book.arLevel != null && <span className={s.chipHl}>AR {book.arLevel}</span>}
              {book.lexile != null && <span className={s.chipHl}>Lexile {book.lexile}L</span>}
              {book.wordCount != null && (
                <span className={s.chip}>{book.wordCount.toLocaleString()} 단어</span>
              )}
              <span className={s.chip}>{book.isFiction ? "픽션" : "논픽션"}</span>
              {book.levelEstimated && <span className={s.chipEstimated}>레벨 추정</span>}
            </div>
          </div>
        </div>

        {/* 2. 이 책은? (2문장 소개 + 레벨 설명) */}
        <p className={s.intro}>
          {c.bookIntroKo} {c.levelNoteKo}
        </p>

        {/* 3. STEP 1 읽기 전 워밍업 */}
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

        {/* 4. STEP 2 필수 단어장 + 아빠 티칭 포인트 */}
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
                    <td className={s.w}>
                      {v.word}
                      <button
                        type="button"
                        className={s.speak}
                        aria-label={`${v.word} 발음 듣기`}
                        title="발음 듣기"
                        onClick={() => speak(v.word)}
                      >
                        🔊
                      </button>
                      <small className={s.pron}>[{v.pronKo}]</small>
                      {v.isCore ? <span className={s.star}>★핵심</span> : null}
                      {v.difficulty === "challenge" ? <span className={s.star}>★도전</span> : null}
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

        {/* 5. STEP 3 읽으면서 미션 */}
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

        {/* 6. STEP 4 읽고 나서 대화 */}
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

        {/* 7. [논픽션만] 아빠 찬스: 재미있는 사실 */}
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

        {/* 8. 확장 놀이 */}
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

      <footer className={s.note}>
        <p>
          <b>이 카드는 이렇게 만들어졌어요:</b> 책의 제목·난이도·주제 같은 정보만으로 새로 만든
          카드예요. 책 본문은 옮기지 않았어요.
        </p>
        <p>🖨️ 인쇄 버튼을 누르면 종이로 뽑아 책 옆에 두고 쓸 수 있어요.</p>
      </footer>
    </div>
  );
}

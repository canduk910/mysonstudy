/**
 * 단어장 시험 `/english/vocab/[id]/quiz` (단어장 정복 V4·V5) — 서버 컴포넌트.
 *
 * 저장된 DAY 하나를 읽어, **영영 정의가 있는 단어(definitionEn !== null)만** 문제 풀로 골라
 * 클라이언트 시험 화면(`components/vocab-quiz-view.tsx`)에 넘긴다. 진행·채점·저장은 전부
 * 클라이언트에서 돈다 — 이 서버 컴포넌트는 데이터 로딩·404 판정·**게이트**·**풀 계산**만 맡는다.
 *
 * ── 두 가지 모드 ────────────────────────────────────────────────────────────
 * - 기본(일반 시험, V4): 정의 있는 단어 **전체**가 문제 풀. 정의가 최소치(5, 5지선다라 정답1+오답4)에
 *   못 미치면 "먼저 정의를 만들어 주세요"로 막는다(§V4 게이트).
 * - `?mode=wrong`(오답복습, V5 층1): 그 DAY의 **틀린·미졸업 단어만** 문제 풀. 세션 집계
 *   (`aggregateWordStats`)로 골라, {wrong>0 && 미졸업}인 단어를 다시 낸다. 남은 오답이 없으면
 *   "모두 졸업" 축하 화면. 오답 4개는 **여전히 같은 DAY**에서 뽑는다(buildChoices 계약 — cross-DAY 금지).
 *
 * 저장은 두 모드가 같은 라우트(`POST …/quiz`)를 쓰되 `mode`로 구분한다(일반 시험 vs 오답복습).
 * 집계는 모드를 가리지 않고 모든 시도를 세므로, 재시험이 streak를 밀어 올려 졸업이 성립한다(§V5).
 *
 * 존재·렌더 판정은 상세/보강과 **같은 함수**(lib/vocabbook-record.ts) — 갈리면 "목록엔 보이는데
 * 눌렀더니 500"이 된다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabQuizView from "@/components/vocab-quiz-view";
import { MIN_QUIZ_WORDS, type QuizPoolItem } from "@/lib/vocab-quiz";
import { aggregateWordStats, isStatMastered } from "@/lib/vocab-mastery";
import {
  buildReviewCandidates,
  selectReviewSet,
  type ReviewWordSource,
} from "@/lib/vocab-review";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

/** 가족용 소규모 앱 — 전 DAY를 훑기에 충분한 상한(층2와 같은 값) */
const REVIEW_BOOK_LIMIT = 500;

export const dynamic = "force-dynamic";

interface QuizPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}

export async function generateMetadata({ params }: QuizPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} 시험 — 은우 북카드` };
}

export default async function VocabQuizPage({ params, searchParams }: QuizPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const isWrong = (Array.isArray(sp.mode) ? sp.mode[0] : sp.mode) === "wrong";

  const store = getStore();
  const record = await store.getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) notFound();

  // 오답 후보는 항상 DAY 전체 단어(buildChoices가 정답·중복을 걸러낸다). 두 모드가 공유한다.
  const dayWords = record.entries.map((e) => e.word);
  // 정의 있는 단어 = 시험에 낼 수 있는 단어(정의가 곧 문제).
  const definedWords: QuizPoolItem[] = record.entries
    .filter((e) => e.definitionEn !== null)
    .map((e) => ({ word: e.word, definitionEn: e.definitionEn as string }));

  const backHeader = (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/english/vocab/${id}`} className="u-navbtn">
          ← 단어장으로
        </Link>
        <p className="t-caption flex-none">{isWrong ? "오답 다시 풀기" : "단어 시험"}</p>
      </div>
      <h1 className="t-book-title mt-4">{record.titleKo}</h1>
    </header>
  );

  // ── 오답복습 모드 (V5 층1) ──────────────────────────────────────────────────
  if (isWrong) {
    const quizzes = await store.listVocabQuizzes(id);
    const stats = aggregateWordStats(quizzes);
    // 틀린 적 있고 아직 졸업 못 한 단어만(오답노트의 "틀린" 필터와 같은 규칙).
    const wrongPool = definedWords.filter((w) => {
      const st = stats[w.word];
      return st != null && st.wrong > 0 && !isStatMastered(st);
    });

    if (wrongPool.length === 0) {
      return (
        <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
          {backHeader}
          <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
            <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
              🎓🎉
            </p>
            <h2 className="t-section-title mt-2">다시 풀 오답이 없어요</h2>
            <p className="t-lead mt-2">
              틀린 단어를 모두 졸업했거나, 아직 틀린 단어가 없어요. 정말 잘했어요!
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Link href={`/english/vocab/${id}/wrong`} className="u-btn u-btn-primary">
                <span aria-hidden>📕</span> 오답노트 보기
              </Link>
              <Link href={`/english/vocab/${id}/quiz`} className="u-btn u-btn-secondary">
                <span aria-hidden>📝</span> 전체 시험 보기
              </Link>
            </div>
          </section>
        </main>
      );
    }

    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        {backHeader}
        <VocabQuizView
          id={record.id}
          titleKo={record.titleKo}
          dayLabel={record.dayLabel}
          pool={wrongPool}
          dayWords={dayWords}
          mode="wrong-review"
        />
      </main>
    );
  }

  // ── 일반 시험 모드 (V4) — 게이트: 정의가 부족하면 시험을 낼 수 없다 ─────────────
  if (definedWords.length < MIN_QUIZ_WORDS) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        {backHeader}
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📖✨
          </p>
          <h2 className="t-section-title mt-2">먼저 영영 뜻을 만들어 주세요</h2>
          <p className="t-lead mt-2">
            시험은 <b>영영 뜻</b>을 보고 단어를 맞히는 놀이예요. 그래서 뜻이 있는 단어가 최소{" "}
            {MIN_QUIZ_WORDS}개는 있어야 해요.
            <br />
            지금은 {definedWords.length}개예요 — 단어장에서 “영영 뜻 만들기”를 눌러 채워 주세요.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/english/vocab/${id}`} className="u-btn u-btn-primary">
              <span aria-hidden>📖</span> 단어장으로 가서 뜻 만들기
            </Link>
            <Link href="/english/vocab" className="u-btn u-btn-secondary">
              <span aria-hidden>📓</span> 단어장 목록
            </Link>
          </div>
        </section>
      </main>
    );
  }

  // ── V6 복습 리마인드 — 다른 DAY의 (틀린 4 + 잘한 1)을 이번 시험 앞에 끼운다 ────────
  // 복습 범위 = 모든 DAY 누적(사용자 확정). 후보가 0이면 selectReviewSet이 []를 주고 기존 시험 그대로다.
  const [allBooks, allQuizzes] = await Promise.all([
    store.listVocabBooks(REVIEW_BOOK_LIMIT),
    store.listAllVocabQuizzes(),
  ]);
  const candidates = buildReviewCandidates(allQuizzes);
  // 복습 출처 = **다른 DAY**의 단어 중, 정의가 있고, 그 DAY에 정의 있는 단어가 ≥ MIN_QUIZ_WORDS(5지선다
  // 보기를 온전히 만들 수 있는 DAY)인 것. 같은 단어가 여러 DAY에 있으면 먼저 만난 DAY를 출처로(결정적).
  const sources = new Map<string, ReviewWordSource>();
  for (const book of allBooks) {
    if (book.id === id) continue; // 현재 DAY는 복습 출처에서 제외(이번 시험에서 새로 낸다)
    if (!isRenderableVocabBook(book)) continue;
    const bookDefined = book.entries.filter((e) => e.definitionEn !== null);
    if (bookDefined.length < MIN_QUIZ_WORDS) continue; // 보기 5개를 못 만드는 DAY는 출처 불가
    const bookDayWords = book.entries.map((e) => e.word);
    for (const e of bookDefined) {
      if (sources.has(e.word)) continue;
      sources.set(e.word, {
        definitionEn: e.definitionEn as string,
        sourceBookId: book.id,
        sourceDayWords: bookDayWords,
      });
    }
  }
  const reviewQuestions = selectReviewSet(candidates, {
    totalSessions: allQuizzes.length,
    currentDayWords: dayWords, // 이번 DAY의 단어는 복습에서 제외(중복 방지)
    sources,
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {backHeader}
      <VocabQuizView
        id={record.id}
        titleKo={record.titleKo}
        dayLabel={record.dayLabel}
        pool={definedWords}
        dayWords={dayWords}
        reviewQuestions={reviewQuestions}
      />
    </main>
  );
}

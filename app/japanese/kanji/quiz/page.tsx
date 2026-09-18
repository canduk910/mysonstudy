/**
 * 한자 시험 `/japanese/kanji/quiz` (아빠의 일본어 JK, §12-4) — 서버 컴포넌트.
 *
 * 정보가 있는 한자로 `buildJaKanjiQuizQuestions`(kanji-to-on·kanji-to-meaning)를 **서버가 조립**해 러너에 넘긴다
 * (lib/ai 경계 → 서버 조립, hydration 안전). 음독 없는 한자의 kanji-to-on은 자동 skip(사실 보고). `?t=`는 재조립 논스.
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaKanjiQuizRunner, { type JaKanjiFeedback } from "@/components/ja-kanji-quiz-runner";
import { buildJaKanjiQuizQuestions } from "@/lib/ai/japanese/quiz";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "한자 시험 — 아빠의 일본어",
};

interface KanjiQuizPageProps {
  searchParams: Promise<{ t?: string | string[] }>;
}

export default async function JaKanjiQuizPage({ searchParams }: KanjiQuizPageProps) {
  const sp = await searchParams;
  const t = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const kanji = await getStore().listJaKanji();

  const header = (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/japanese/kanji" className="u-navbtn">
          ← 한자 목록
        </Link>
        <p className="t-caption flex-none">한자 시험</p>
      </div>
      <h1 className="t-book-title mt-4">📝 한자 시험</h1>
    </header>
  );

  // 정보가 있는 한자만 출제 대상(buildJaKanjiQuizQuestions는 음독·뜻을 읽는다).
  const built = buildJaKanjiQuizQuestions(kanji);
  const cards: JaKanjiFeedback[] = kanji.map((k) => ({
    kanji: k.kanji,
    koReading: k.koReading,
    onyomi: k.onyomi,
    meaningKo: k.meaningKo,
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {header}
      {built.questions.length === 0 ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>🈳✨</p>
          <h2 className="t-section-title mt-2">먼저 한자 정보를 만들어요</h2>
          <p className="t-lead mt-2">한자 시험은 음독·뜻을 묻는 놀이예요. 한자 목록에서 "정보 만들기"를 눌러 채워 주세요.</p>
          <div className="mt-6 flex justify-center">
            <Link href="/japanese/kanji" className="u-btn u-btn-primary">🈳 한자 목록으로</Link>
          </div>
        </section>
      ) : (
        <JaKanjiQuizRunner
          key={t ?? "0"}
          questions={built.questions}
          skipped={built.skipped}
          cards={cards}
          retryHref="/japanese/kanji/quiz"
        />
      )}
    </main>
  );
}

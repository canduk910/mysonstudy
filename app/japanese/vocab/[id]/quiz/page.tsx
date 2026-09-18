/**
 * 일본어 시험 `/japanese/vocab/[id]/quiz` (아빠의 일본어 J2, §6) — 서버 컴포넌트.
 *
 * **세션 조립을 서버가 한다** — `buildJaQuizQuestions`(lib/ai/japanese/quiz)는 클라 번들 경계라 클라가 못 부른다.
 * 서버가 1회 조립해 러너에 넘기면 문항이 고정이라 hydration도 안전(영어처럼 클라에서 셔플하지 않는다).
 *
 * ── 세 갈래 ────────────────────────────────────────────────────────────────────
 * - `?modes=a,b,c` : 그 콘텐츠 모드로 혼합 세션. (모드 선택 없이 들어오면 아래 picker.)
 * - `?wrong=<mode>`: 오답복습 — 그 모드에서 틀리고 미졸업인 단어만, 그 모드로. (aggregateJaStatsByMode)
 * - 파라미터 없음   : 모드 선택 화면(JaQuizPicker).
 * `?t=` 는 "다시 풀기"가 붙이는 논스 — 서버 재조립(새 셔플)을 강제하고 러너를 remount한다.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaQuizRunner from "@/components/ja-quiz-runner";
import JaQuizPicker from "@/components/ja-quiz-picker";
import {
  JA_QUIZ_CONTENT_MODES,
  aggregateJaStatsByMode,
  buildJaQuizQuestions,
  type JaQuizContentMode,
} from "@/lib/ai/japanese/quiz";
import { isStatMastered } from "@/lib/vocab-mastery";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface QuizPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ modes?: string | string[]; wrong?: string | string[]; t?: string | string[] }>;
}

export async function generateMetadata({ params }: QuizPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) return { title: "단어장을 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `${record.titleKo} 시험 — 아빠의 일본어` };
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isContentMode = (m: string): m is JaQuizContentMode =>
  (JA_QUIZ_CONTENT_MODES as readonly string[]).includes(m);

export default async function JaQuizPage({ params, searchParams }: QuizPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const store = getStore();
  const record = await store.getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) notFound();

  const backHeader = (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/japanese/vocab/${id}`} className="u-navbtn">
          ← 단어장으로
        </Link>
        <p className="t-caption flex-none">시험</p>
      </div>
      <h1 className="t-book-title mt-4">📝 {record.titleKo}</h1>
    </header>
  );

  const main = (inner: ReactNode) => (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {backHeader}
      {inner}
    </main>
  );

  const wrongParam = one(sp.wrong);
  const modesParam = one(sp.modes);
  // "다시 풀기" 논스 — 세션 key에 넣어 러너를 remount(새 서버 셔플로 초기화). 없으면 "0".
  const sessionKey = `${wrongParam ?? modesParam ?? ""}-${one(sp.t) ?? "0"}`;

  // ── 오답복습 (?wrong=<mode>) ─────────────────────────────────────────────────
  if (wrongParam && isContentMode(wrongParam)) {
    const mode = wrongParam;
    const quizzes = await store.listJaQuizzes(id);
    const stats = aggregateJaStatsByMode(quizzes)[mode] ?? {};
    const wrongSet = new Set(
      record.entries
        .map((e) => e.word)
        .filter((w) => {
          const st = stats[w];
          return st != null && st.wrong > 0 && !isStatMastered(st);
        }),
    );
    const sourceEntries = record.entries.filter((e) => wrongSet.has(e.word));
    const built = buildJaQuizQuestions(sourceEntries, { modes: [mode] });
    if (built.questions.length === 0) {
      return main(
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>🎓🎉</p>
          <h2 className="t-section-title mt-2">다시 풀 오답이 없어요</h2>
          <p className="t-lead mt-2">이 방식에서 틀린 단어를 모두 졸업했어요. 잘하고 있어요!</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/japanese/vocab/${id}/wrong`} className="u-btn u-btn-primary">📕 오답노트</Link>
            <Link href={`/japanese/vocab/${id}/quiz`} className="u-btn u-btn-secondary">📝 전체 시험</Link>
          </div>
        </section>,
      );
    }
    return main(
      <JaQuizRunner
        key={sessionKey}
        id={id}
        titleKo={record.titleKo}
        questions={built.questions}
        skipped={built.skipped}
        entries={record.entries}
        retryHref={`/japanese/vocab/${id}/quiz?wrong=${mode}`}
        isReview
      />,
    );
  }

  // ── 혼합/부분 세션 (?modes=a,b,c) ─────────────────────────────────────────────
  if (modesParam) {
    const modes = modesParam.split(",").map((m) => m.trim()).filter(isContentMode);
    if (modes.length > 0) {
      const built = buildJaQuizQuestions(record.entries, { modes });
      if (built.questions.length === 0) {
        return main(
          <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
            <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>🤔</p>
            <h2 className="t-section-title mt-2">낼 수 있는 문제가 없어요</h2>
            <p className="t-lead mt-2">
              고른 방식으로는 이 단어장에서 문제를 만들 수 없었어요(예: 한자 없는 단어뿐). 다른 방식을 골라 보세요.
            </p>
            <div className="mt-6 flex justify-center">
              <Link href={`/japanese/vocab/${id}/quiz`} className="u-btn u-btn-primary">방식 다시 고르기</Link>
            </div>
          </section>,
        );
      }
      return main(
        <JaQuizRunner
          key={sessionKey}
          id={id}
          titleKo={record.titleKo}
          questions={built.questions}
          skipped={built.skipped}
          entries={record.entries}
          retryHref={`/japanese/vocab/${id}/quiz?modes=${modes.join(",")}`}
          isReview={false}
        />,
      );
    }
  }

  // ── 모드 선택(파라미터 없음) ──────────────────────────────────────────────────
  return main(<JaQuizPicker id={id} contentModes={[...JA_QUIZ_CONTENT_MODES]} />);
}

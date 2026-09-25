/**
 * 표현 시험 `/toeic/sets/[id]/quiz` (아빠의 영어 T2, docs/harness/toeic.md §6-1) — 서버 컴포넌트.
 *
 * **세션 조립을 서버가 한다**(lib/toeic-quiz의 순수 함수) — 서버가 1회 조립해 러너에 넘기면 문항이 고정이라 hydration이
 * 안전하다(클라이언트에서 셔플하면 SSR과 첫 렌더가 갈린다). 표현 시험은 AI를 부르지 않는다.
 *
 * ── 갈래 ─────────────────────────────────────────────────────────────────────
 * - 파라미터 없음      : 모드 고르기(기본 5지선다 3모드 혼합 + 말하기 따로).
 * - `?modes=a,b,c`     : 그 5지선다 모드로 혼합 세션. `?modes=speak`는 말하기(자기 채점) 세션.
 * - `?wrong=<mode>`    : 오답 재시험 — 그 모드에서 틀리고 미졸업인 항목만, 그 모드로(toeicWrongKeys — 모드별 무오염).
 * - `?t=`              : "다시 풀기" 논스 — 서버 재조립(새 셔플)을 강제하고 러너를 remount(일본어 관용구).
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicQuizPicker from "@/components/toeic-quiz-picker";
import { ToeicChoiceRunner, ToeicSpeakRunner, type ToeicQuizEntryInfo } from "@/components/toeic-quiz-runner";
import { getStore } from "@/lib/store";
import {
  TOEIC_CHOICE_QUIZ_MODES,
  buildToeicChoiceQuestions,
  buildToeicSpeakSession,
  isToeicQuizMode,
  toeicWrongKeys,
  type ToeicChoiceQuizMode,
} from "@/lib/toeic-quiz";
import { isRenderableToeicSet } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

interface QuizPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ modes?: string | string[]; wrong?: string | string[]; t?: string | string[] }>;
}

export async function generateMetadata({ params }: QuizPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) return { title: "표현집을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${record.titleKo} 시험 — 아빠의 영어` };
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function ToeicQuizPage({ params, searchParams }: QuizPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const store = getStore();
  const record = await store.getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) notFound();

  // 러너가 피드백에 쓰는 표현 정보(표현 → 뜻·예문·구간). entries 전문 대신 필요한 것만.
  const entryInfo: ToeicQuizEntryInfo[] = record.entries.map((e) => ({
    expression: e.expression,
    meaningKo: e.meaningKo,
    example: e.example,
    exampleKo: e.exampleKo,
    exampleSpan: e.points?.exampleSpan ?? null,
  }));

  const main = (inner: ReactNode) => (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/toeic/sets/${id}`} className="u-navbtn">
            ← 표현집으로
          </Link>
          <p className="t-caption flex-none">시험</p>
        </div>
        <h1 className="t-book-title mt-4">📝 {record.titleKo}</h1>
      </header>
      {inner}
    </main>
  );

  const emptyCard = (emoji: string, title: string, lead: string, actions: ReactNode) => (
    <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
      <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
        {emoji}
      </p>
      <h2 className="t-section-title mt-2">{title}</h2>
      <p className="t-lead mt-2">{lead}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>
    </section>
  );

  const wrongParam = one(sp.wrong);
  const modesParam = one(sp.modes);
  const sessionKey = `${wrongParam ?? modesParam ?? ""}-${one(sp.t) ?? "0"}`;

  // ── 오답 재시험 (?wrong=<mode>) ──
  if (wrongParam && isToeicQuizMode(wrongParam)) {
    const mode = wrongParam;
    const sessions = await store.listToeicQuizzes(id);
    const keys = toeicWrongKeys(sessions, mode);
    const retryHref = `/toeic/sets/${id}/quiz?wrong=${mode}`;
    const graduated = emptyCard(
      "🎓🎉",
      "다시 풀 오답이 없어요",
      "이 방식에서 틀린 항목을 모두 졸업했어요(연속 2번 정답).",
      <>
        <Link href={`/toeic/sets/${id}/wrong`} className="u-btn u-btn-primary">
          📕 오답노트
        </Link>
        <Link href={`/toeic/sets/${id}/quiz`} className="u-btn u-btn-secondary">
          📝 시험 고르기
        </Link>
      </>,
    );
    if (keys.size === 0) return main(graduated);
    if (mode === "speak") {
      const questions = buildToeicSpeakSession(record, sessions.filter((s) => s.mode === "speak"), { onlyKeys: keys });
      if (questions.length === 0) return main(graduated);
      return main(
        <ToeicSpeakRunner key={sessionKey} id={id} titleKo={record.titleKo} questions={questions} retryHref={retryHref} isReview />,
      );
    }
    const built = buildToeicChoiceQuestions(record, { modes: [mode], onlyKeys: keys });
    if (built.questions.length === 0) return main(graduated);
    return main(
      <ToeicChoiceRunner
        key={sessionKey}
        id={id}
        titleKo={record.titleKo}
        questions={built.questions}
        skipped={built.skipped}
        entries={entryInfo}
        retryHref={retryHref}
        isReview
      />,
    );
  }

  // ── 세션 (?modes=...) ──
  if (modesParam) {
    const requested = modesParam.split(",").map((m) => m.trim());
    if (requested.includes("speak")) {
      const sessions = await store.listToeicQuizzes(id);
      const questions = buildToeicSpeakSession(record, sessions.filter((s) => s.mode === "speak"));
      if (questions.length === 0) {
        return main(
          emptyCard(
            "🤔",
            "말하기 문제를 만들 수 없어요",
            "말하기 시험은 교재 QUIZ와 발화 포인트의 활용 문장으로 내요. 표현집 화면에서 발화 포인트를 먼저 만들어 주세요.",
            <Link href={`/toeic/sets/${id}`} className="u-btn u-btn-primary">
              📒 표현집으로
            </Link>,
          ),
        );
      }
      return main(
        <ToeicSpeakRunner
          key={sessionKey}
          id={id}
          titleKo={record.titleKo}
          questions={questions}
          retryHref={`/toeic/sets/${id}/quiz?modes=speak`}
          isReview={false}
        />,
      );
    }
    const modes = TOEIC_CHOICE_QUIZ_MODES.filter((m) => requested.includes(m));
    if (modes.length > 0) {
      const built = buildToeicChoiceQuestions(record, { modes });
      if (built.questions.length === 0) {
        return main(
          emptyCard(
            "🤔",
            "낼 수 있는 문제가 없어요",
            "고른 방식으로는 이 표현집에서 문제를 만들 수 없었어요. 보기를 만들려면 뜻이 다른 표현이 2개 이상 있어야 하고, 빈칸은 예문과 발화 포인트도 있어야 해요. 다른 방식을 골라 보세요.",
            <Link href={`/toeic/sets/${id}/quiz`} className="u-btn u-btn-primary">
              방식 다시 고르기
            </Link>,
          ),
        );
      }
      return main(
        <ToeicChoiceRunner
          key={sessionKey}
          id={id}
          titleKo={record.titleKo}
          questions={built.questions}
          skipped={built.skipped}
          entries={entryInfo}
          retryHref={`/toeic/sets/${id}/quiz?modes=${modes.join(",")}`}
          isReview={false}
        />,
      );
    }
  }

  // ── 모드 고르기 ── 방식마다 낼 수 있는 문항 수를 미리 센다(빈칸은 발화 포인트가 있어야, 말하기는 QUIZ·활용 문장)
  const choiceCounts = Object.fromEntries(
    TOEIC_CHOICE_QUIZ_MODES.map((m) => [m, buildToeicChoiceQuestions(record, { modes: [m] }).questions.length]),
  ) as Record<ToeicChoiceQuizMode, number>;
  // 0문항인 방식의 이유(§6-1) — 빈칸은 예문·구간(발화 포인트)이 먼저, 그다음은 세 방식 공통으로 "보기 2개 이상"(TOEIC_CHOICE_MIN):
  // 뜻이 다른 표현이 2개 미만이면 오답 보기를 거르고 나서 정답 하나만 남아 출제하지 않는다.
  const hasClozeSource = record.entries.some((e) => e.example !== null && (e.points?.exampleSpan ?? null) !== null);
  const needTwoKo = "보기를 만들려면 뜻이 다른 표현이 2개 이상 필요해요";
  const choiceZeroReasonsKo: Record<ToeicChoiceQuizMode, string> = {
    "ko-to-expr": needTwoKo,
    "expr-to-ko": needTwoKo,
    cloze: hasClozeSource ? needTwoKo : "예문과 발화 포인트가 있어야 낼 수 있어요",
  };
  // 말하기 문항 수는 키 중복 제거·최대 10(TOEIC_SPEAK_SESSION_MAX)까지 조립 함수가 정한다 — 개수는 rng와 무관하다
  const speakCount = buildToeicSpeakSession(record, []).length;
  return main(
    <ToeicQuizPicker
      id={id}
      choiceModes={[...TOEIC_CHOICE_QUIZ_MODES]}
      choiceCounts={choiceCounts}
      choiceZeroReasonsKo={choiceZeroReasonsKo}
      speakCount={speakCount}
    />,
  );
}

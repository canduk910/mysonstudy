/**
 * 표현 시험 오답노트 `/toeic/sets/[id]/wrong` (아빠의 영어 T2, docs/harness/toeic.md §6-2) — 서버 컴포넌트.
 *
 * 그 세트의 시험 세션을 `aggregateToeicStatsByMode`로 **모드별로 갈라** 접는다 — 뜻은 아는데 말로 못 꺼내는 상태가 흔해서,
 * 모드가 다른 결과를 한 통계에 섞으면 "안다" 판정이 거짓이 된다(§6-2). 모드마다 틀리고 미졸업인 항목(연속 2회 정답이면 졸업)
 * + 졸업한 항목을 클라이언트 탭 화면에 넘긴다. 집계는 저장하지 않고 읽을 때 계산한다. AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicQuizWrongView, { type ToeicWrongModeGroup } from "@/components/toeic-quiz-wrong-view";
import { getStore } from "@/lib/store";
import { TOEIC_QUIZ_MODES, aggregateToeicStatsByMode, speakKeyForBookQuiz } from "@/lib/toeic-quiz";
import { toeicItemKeyLabel } from "@/lib/toeic-quiz-contract";
import { isRenderableToeicSet } from "@/lib/toeic-record";
import { isStatMastered } from "@/lib/vocab-mastery";

export const dynamic = "force-dynamic";

interface WrongPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: WrongPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) return { title: "표현집을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${record.titleKo} 오답노트 — 아빠의 영어` };
}

export default async function ToeicWrongPage({ params }: WrongPageProps) {
  const { id } = await params;
  const store = getStore();
  const record = await store.getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) notFound();

  const sessions = await store.listToeicQuizzes(id);
  const byMode = aggregateToeicStatsByMode(sessions);

  // 항목 키 → 보여 줄 글(표현 키는 표현·뜻, QUIZ 키는 우리말 문장·모범답변). 세트에서 사라진 키는 키 글자 그대로.
  const info = new Map<string, { title: string; sub: string | null }>();
  for (const q of record.quiz) info.set(speakKeyForBookQuiz(q), { title: q.modelAnswer, sub: q.promptKo });
  for (const e of record.entries) info.set(e.expression, { title: e.expression, sub: e.meaningKo });

  const groups: ToeicWrongModeGroup[] = TOEIC_QUIZ_MODES.map((mode) => {
    const stats = byMode[mode] ?? {};
    let attempted = 0;
    const wrong: ToeicWrongModeGroup["wrong"] = [];
    const mastered: ToeicWrongModeGroup["mastered"] = [];
    for (const [key, st] of Object.entries(stats)) {
      if (st.total === 0) continue;
      attempted += 1;
      const shown = info.get(key) ?? { title: toeicItemKeyLabel(key), sub: null };
      if (isStatMastered(st)) mastered.push({ key, ...shown });
      else if (st.wrong > 0) wrong.push({ key, ...shown, wrongCount: st.wrong });
    }
    wrong.sort((a, b) => b.wrongCount - a.wrongCount);
    return { mode, attempted, wrong, mastered };
  });

  const anyAttempted = groups.some((g) => g.attempted > 0);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/toeic/sets/${id}`} className="u-navbtn">
            ← 표현집으로
          </Link>
          <p className="t-caption flex-none">오답노트</p>
        </div>
        <h1 className="t-book-title mt-4">📕 {record.titleKo}</h1>
        <p className="t-lead mt-1">
          방식(뜻·표현·빈칸·말하기)마다 따로 봐요 — 뜻은 아는데 말로 못 꺼내는 표현이 바로 보여요. 연속 2번 맞히면 졸업이에요.
        </p>
      </header>

      {!anyAttempted ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📝✨
          </p>
          <h2 className="t-section-title mt-2">아직 오답이 없어요</h2>
          <p className="t-lead mt-2">시험을 보면 틀린 표현이 방식별로 여기에 모여요.</p>
          <div className="mt-6 flex justify-center">
            <Link href={`/toeic/sets/${id}/quiz`} className="u-btn u-btn-primary">
              📝 시험 보기
            </Link>
          </div>
        </section>
      ) : (
        <ToeicQuizWrongView id={id} groups={groups} />
      )}
    </main>
  );
}

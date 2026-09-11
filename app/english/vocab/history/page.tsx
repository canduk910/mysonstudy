/**
 * 시험 응시기록 — DAY를 넘어 통합 `/english/vocab/history` (V8) — 서버 컴포넌트.
 *
 * **모든 단어장**의 시험 세션(`listAllVocabQuizzes`, startedAt 오름차순)을 **최근순으로 뒤집어** 클라이언트
 * 화면(`components/vocab-quiz-history-view.tsx`)에 넘긴다. 각 줄에 어느 단어장(DAY)인지 라벨을 붙인다.
 * **저장된 레코드를 읽어 보여주기만** 한다(AI·스토어 스키마 변경 0, 집계는 화면이 읽을 때 계산).
 *
 * 정적 세그먼트 `history`는 동적 `[id]`보다 우선하므로 `/english/vocab/history`가 `[id]="history"`로 먹히지
 * 않는다(Next 규칙 — `wrong`·`new`와 같은 선례). `getStore()`를 직접 읽는다(조회용 API 라우트 없음). AI 0.
 *
 * 삭제된 단어장 처리: `deleteVocabBook`이 그 단어장의 시험 세션까지 **연쇄 삭제**하므로 고아 세션은 정상
 * 경로에서 생기지 않는다. 그래도 방어적으로, 라벨 맵에 없는 bookId면 숨기지 않고 "(삭제된 단어장)"으로 보여준다
 * (데이터를 감추기보다 정직하게 — 화면 컴포넌트가 bookLabel:null을 그렇게 렌더).
 */

import type { Metadata } from "next";
import Link from "next/link";
import VocabQuizHistoryView, {
  type QuizHistorySession,
} from "@/components/vocab-quiz-history-view";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "시험 기록 — 은우 북카드",
  description: "모든 단어장의 시험 응시 기록을 시간순으로 봐요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한(오답노트 통합 화면과 같은 값) */
const LIST_LIMIT = 500;

export default async function VocabHistoryAllPage() {
  const store = getStore();
  const [books, allQuizzes] = await Promise.all([
    store.listVocabBooks(LIST_LIMIT),
    store.listAllVocabQuizzes(),
  ]);

  // bookId → 라벨(제목 [· dayLabel]). 렌더 가능 여부와 무관하게 전부 담아 둔다(라벨은 세션에만 쓰인다).
  const labelById = new Map<string, string>();
  for (const b of books) {
    const suffix = b.dayLabel && b.dayLabel !== b.titleKo ? ` · ${b.dayLabel}` : "";
    labelById.set(b.id, `${b.titleKo}${suffix}`);
  }

  // 최근순(startedAt 내림차순) — listAllVocabQuizzes는 오름차순이라 뒤집는다.
  const sessions: QuizHistorySession[] = [...allQuizzes].reverse().map((q) => ({
    id: q.id,
    mode: q.mode,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    items: q.items.map((it) => ({ word: it.word, correct: it.correct, answered: it.answered })),
    bookLabel: labelById.get(q.bookId) ?? null, // null → 화면이 "(삭제된 단어장)"으로 렌더
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/english/vocab" className="u-navbtn">
            ← 단어장 목록
          </Link>
          <p className="t-caption flex-none">시험 기록</p>
        </div>
        <h1 className="t-book-title mt-4">📊 모든 시험 기록</h1>
        <p className="t-lead mt-1">모든 단어장에서 본 시험을 시간순으로 모았어요.</p>
      </header>

      {sessions.length === 0 ? (
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📊✨
          </p>
          <h2 className="t-section-title mt-2">아직 시험 기록이 없어요</h2>
          <p className="t-lead mt-2">
            단어장에서 <b>시험</b>을 보면, 응시한 기록이 여기에 모두 쌓여요.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href="/english/vocab" className="u-btn u-btn-primary">
              <span aria-hidden>📓</span> 단어장으로 가기
            </Link>
          </div>
        </section>
      ) : (
        <VocabQuizHistoryView sessions={sessions} scope="all" />
      )}
    </main>
  );
}

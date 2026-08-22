/**
 * 오답노트 — DAY를 넘어 통합 `/english/vocab/wrong` (단어장 정복 V5 층2) — 서버 컴포넌트.
 *
 * **모든 단어장**의 시험 세션(`listAllVocabQuizzes`, startedAt 오름차순)을 bookId별로 갈라
 * `aggregateWordStats`로 접고, DAY마다 오답(미졸업) 단어 + 정복률을 만들어 클라이언트 화면
 * (`components/vocab-wrong-all-view.tsx`)에 넘긴다. **집계는 저장하지 않고 읽을 때 계산한다**(계획 §V5).
 *
 * 정적 세그먼트 `wrong`은 동적 `[id]`보다 우선하므로 라우팅이 겹치지 않는다(Next 규칙).
 * `getStore()`를 직접 읽는다(목록·서재와 같은 규약 — 조회용 API 라우트를 두지 않는다). AI 호출·비용 0.
 */

import type { Metadata } from "next";
import Link from "next/link";
import VocabWrongAllView, {
  type WrongDayGroup,
  type WrongDeckWord,
} from "@/components/vocab-wrong-all-view";
import { aggregateWordStats, isStatMastered } from "@/lib/vocab-mastery";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore, type VocabQuizRecord } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "오답노트 — 은우 북카드",
  description: "모든 DAY의 틀린 단어를 모아 다시 풀어요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function VocabWrongAllPage() {
  const store = getStore();
  const [books, allQuizzes] = await Promise.all([
    store.listVocabBooks(LIST_LIMIT),
    store.listAllVocabQuizzes(),
  ]);

  // bookId별로 세션을 가른다 — 전역 startedAt 오름차순 안에서 상대 순서가 보존되므로 streak가 옳다.
  const byBook = new Map<string, VocabQuizRecord[]>();
  for (const q of allQuizzes) {
    const arr = byBook.get(q.bookId);
    if (arr) arr.push(q);
    else byBook.set(q.bookId, [q]);
  }

  const renderable = books.filter(isRenderableVocabBook);
  const groups: WrongDayGroup[] = [];
  let totalOpen = 0;

  for (const book of renderable) {
    const quizzes = byBook.get(book.id) ?? [];
    if (quizzes.length === 0) continue; // 시험을 본 적 없는 DAY는 오답노트에 넣지 않는다

    const stats = aggregateWordStats(quizzes);
    const defined = book.entries.filter((e) => e.definitionEn !== null);

    let attempted = 0;
    let mastered = 0;
    const words: WrongDeckWord[] = [];
    for (const e of defined) {
      const st = stats[e.word];
      if (!st || st.total === 0) continue; // 안 본 단어는 정복률·오답 모두에서 제외
      attempted += 1;
      if (isStatMastered(st)) {
        mastered += 1;
      } else if (st.wrong > 0) {
        words.push({
          word: e.word,
          definitionEn: e.definitionEn as string,
          wrong: st.wrong,
          streak: st.streak,
        });
      }
    }

    // 이 DAY에서 시도한 단어가 하나도 없으면(그만하기만 반복 등) 건너뛴다.
    if (attempted === 0) continue;

    totalOpen += words.length;
    groups.push({
      id: book.id,
      titleKo: book.titleKo,
      dayLabel: book.dayLabel,
      definedTotal: defined.length,
      attempted,
      mastered,
      words,
    });
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <h1 className="t-book-title">📕 오답노트</h1>
        <p className="t-lead mt-1">모든 DAY에서 틀린 단어를 모았어요. 2번 연속 맞히면 졸업이에요!</p>
      </header>

      {groups.length === 0 ? (
        // 시험을 한 번도 본 적이 없거나, 볼 만한 오답이 아직 없다.
        <section className="u-card" style={{ padding: "2rem 1.25rem", textAlign: "center" }}>
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden>
            📝✨
          </p>
          <h2 className="t-section-title mt-2">아직 오답이 없어요</h2>
          <p className="t-lead mt-2">
            단어장에서 <b>시험</b>을 보면, 틀린 단어가 여기에 모여요. 하나씩 다시 풀어 졸업해 봐요!
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href="/english/vocab" className="u-btn u-btn-primary">
              <span aria-hidden>📓</span> 단어장으로 가기
            </Link>
          </div>
        </section>
      ) : (
        <VocabWrongAllView groups={groups} totalOpen={totalOpen} />
      )}
    </main>
  );
}

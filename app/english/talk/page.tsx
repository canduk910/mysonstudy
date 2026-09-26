/**
 * 은우 자유대화 시작 `/english/talk` (SPEC §21-2 1, docs/harness/english.md §12) — 서버 컴포넌트.
 *
 * `getStore()`를 직접 읽는다(목록 API 라우트를 만들지 않는다 — 단어장 목록과 같은 규약).
 * - 단어장 고르기: **줄 정보만** 내린다(id·이름·DAY·단어 수·"모은 단어" 표시). 단어 목록은 대화를 시작할 때 서버가 id로 읽는다
 *   (§12-1 "클라이언트는 id만 보낸다"). 렌더 판정은 단어장 화면과 같은 함수(isRenderableVocabBook).
 * - 지난 대화: 줄 정보만(`toTalkHistoryItem`), 렌더 판정은 대화 보기와 같은 함수(isRenderableTalkSession). 대화 컬렉션을 못 읽으면
 *   빈 목록으로(새 컬렉션의 읽기 실패가 시작 화면을 죽이지 않게).
 * - 선생님에게 넣을 안내 글(첫 인사·마무리·도움 요청 — english.md §12-1·§12-6 원문)을 **props로** 내린다 — 클라이언트 모듈이
 *   프롬프트 파일을 값으로 import하지 않게(english-routes §5).
 */

import type { Metadata } from "next";
import TalkStartView from "@/components/talk-start-view";
import { TALK_GREETING_INSTRUCTIONS, TALK_NUDGE_NOTE, TALK_WRAPUP_INSTRUCTIONS } from "@/lib/ai/english/talk-prompts";
import { COLLECTED_VOCAB_DAY_LABEL } from "@/lib/collected-vocab-contract";
import { getStore, type TalkSessionRecord } from "@/lib/store";
import type { TalkVocabBookOption } from "@/lib/talk-contract";
import { isRenderableTalkSession, sortTalkHistory, toTalkHistoryItem } from "@/lib/talk-record";
import type { TalkAppNotes } from "@/lib/talk-realtime";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "자유대화 — 은우 영어",
  description: "Sunny 선생님과 영어로 전화하듯 이야기하고, 대화가 끝나면 문장마다 설명을 들어요.",
};

/** 가족용 소규모 앱 — 전체 목록으로 충분한 상한 */
const LIST_LIMIT = 500;

export default async function TalkStartPage() {
  const store = getStore();
  const [books, sessions] = await Promise.all([
    store.listVocabBooks(LIST_LIMIT),
    store.listTalkSessions(LIST_LIMIT).catch((err: unknown): TalkSessionRecord[] => {
      console.error("[/english/talk] 지난 대화를 읽지 못했다 — 빈 목록으로", err);
      return [];
    }),
  ]);

  const vocabBooks: TalkVocabBookOption[] = books
    .filter(isRenderableVocabBook)
    .sort((a, b) => {
      const aNull = a.sortIndex == null;
      const bNull = b.sortIndex == null;
      if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      if (aNull) return -1;
      if (bNull) return 1;
      return (a.sortIndex as number) - (b.sortIndex as number);
    })
    .map((b) => ({
      id: b.id,
      titleKo: b.titleKo,
      dayLabel: b.dayLabel,
      wordCount: b.entries.length,
      collected: b.dayLabel === COLLECTED_VOCAB_DAY_LABEL,
    }));

  const history = sortTalkHistory(sessions.filter(isRenderableTalkSession).map(toTalkHistoryItem));

  const notes: TalkAppNotes = {
    greeting: TALK_GREETING_INSTRUCTIONS,
    wrapup: TALK_WRAPUP_INSTRUCTIONS,
    nudge: TALK_NUDGE_NOTE,
  };

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {/* 상단 내비는 공통 셸(app/english/layout.tsx)이 담당 */}
      <header className="mb-6">
        <h1 className="t-book-title">💬 자유대화</h1>
        <p className="t-lead mt-1">Sunny 선생님과 영어로 전화하듯 이야기해요. 막히면 화면에 말해 볼 문장이 떠요.</p>
      </header>

      <TalkStartView vocabBooks={vocabBooks} history={history} notes={notes} />
    </main>
  );
}

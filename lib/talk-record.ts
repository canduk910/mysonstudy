/**
 * lib/talk-record.ts — 저장된 자유대화(`TalkSessionRecord`)를 화면에 올리기 전에 통과시키는 **단일 판정처**
 * (docs/harness/english.md §12-4, lib/vocabbook-record.ts·lib/math-record.ts 관용구)
 *
 * 목록(`/english/talk`)과 대화 보기(`/english/talk/[id]`)·설명·이름·삭제 라우트가 **같은 함수**를 본다 — 두 벌로 살면
 * "목록에는 보이는데 눌렀더니 404"가 난다. 읽기는 lib/talk-normalize.ts가 이미 모양을 조였으므로, 여기서는 화면이 실제로
 * 그리는 것(말풍선이 될 턴·주제 라벨)이 있는지만 본다.
 *
 * 서버 전용으로 쓴다(store 타입만 `import type`). 화면은 서버 컴포넌트가 줄인 `TalkHistoryItem`만 받는다.
 */

import type { TalkSessionRecord } from "./store";
import { TALK_TITLE_MAX_CHARS, type TalkHistoryItem } from "./talk-contract";

/** 말풍선으로 그릴 턴이 있고 뼈대가 제자리인가(턴 0개 기록은 열지 않는다 — 저장 조건상 생기지 않지만 손으로 넣은 문서 방어) */
export function isRenderableTalkSession(record: TalkSessionRecord | null | undefined): record is TalkSessionRecord {
  if (!record) return false;
  const r = record as Partial<TalkSessionRecord>;
  if (!r.id || typeof r.createdAt !== "string" || typeof r.titleKo !== "string") return false;
  if (!r.topic || typeof r.topic.labelKo !== "string") return false;
  if (!Array.isArray(r.turns) || r.turns.length === 0) return false;
  for (const t of r.turns) {
    if (!t || (t.speaker !== "teacher" && t.speaker !== "child") || typeof t.text !== "string") return false;
  }
  return Array.isArray(r.explanations) && Array.isArray(r.cards);
}

/** 기본 화면 이름 — "{주제 라벨} 대화"(§12-4), 상한 안으로 */
export function defaultTalkTitle(topic: { labelKo: string }): string {
  const label = (topic.labelKo || "자유").trim() || "자유";
  return Array.from(`${label} 대화`).slice(0, TALK_TITLE_MAX_CHARS).join("");
}

/** 레코드 → 목록 한 줄(전문을 넘기지 않는다) */
export function toTalkHistoryItem(r: TalkSessionRecord): TalkHistoryItem {
  return {
    id: r.id,
    titleKo: r.titleKo,
    topicLabelKo: r.topic.labelKo,
    topicKind: r.topic.kind,
    childTurnCount: r.childTurnCount,
    durationSec: r.durationSec,
    hasScene: r.sceneImageId !== null,
    explanationCount: r.explanations.length,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    sortIndex: r.sortIndex,
  };
}

/** 목록 정렬(서재·단어장과 같은 규칙) — sortIndex null이 먼저(createdAt 역순), 그다음 sortIndex 오름차순 */
export function sortTalkHistory(items: TalkHistoryItem[]): TalkHistoryItem[] {
  return [...items].sort((a, b) => {
    const aNull = a.sortIndex == null;
    const bNull = b.sortIndex == null;
    if (aNull && bNull) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    if (aNull) return -1;
    if (bNull) return 1;
    return (a.sortIndex as number) - (b.sortIndex as number);
  });
}

/**
 * lib/japanese-record.ts — 저장된 일본어 단어장(`JaVocabBookRecord`)을 화면에 올리기 전 통과시키는
 * **단일 판정처** (아빠의 일본어 J1, `lib/vocabbook-record.ts` 관용구).
 *
 * 같은 판정이 목록(`/japanese/vocab`)과 상세(`/japanese/vocab/[id]`)에 두 벌로 살면 갈린다 — 갈리는 순간
 * "목록엔 보이는데 눌렀더니 500"이 된다. 두 화면이 이 함수 하나를 본다(목록은 그 줄만 건너뛰고, 상세는 notFound).
 *
 * 여기서 보는 것은 품질이 아니라 **모양**이다 — 화면이 실제로 읽는 자리(entries 배열, 각 항목의 word·배열 필드)만.
 */

import type { JaVocabBookRecord } from "./store";
import type { JaVocabEntry } from "./ai/japanese/schemas";

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * 화면이 **실제로 읽는 필드**가 전부 제자리에 있는가.
 * **단어가 하나도 없는 레코드는 열지 않는다** — 상세 표에 그릴 것이 없다(빈 화면 방지, 영어와 같은 규칙).
 */
export function isRenderableJaVocabBook(record: JaVocabBookRecord): boolean {
  const r = record as Partial<JaVocabBookRecord>;

  if (!r.id || typeof r.createdAt !== "string") return false;
  if (typeof r.titleKo !== "string") return false;
  if (r.kind !== "jlpt" && r.kind !== "collected") return false;
  if (!isArray(r.levels)) return false;
  if (!isArray(r.entries) || r.entries.length === 0) return false;

  for (const raw of r.entries) {
    const e = raw as Partial<JaVocabEntry>;
    if (!e || typeof e.word !== "string" || e.word.trim() === "") return false;
    // 표가 순회하는 배열 필드들(빈 배열은 정상, 없음은 .map에서 터진다)
    if (typeof e.kana !== "string") return false;
    if (!isArray(e.pos) || !isArray(e.meaningsKo) || !isArray(e.wordTokens)) return false;
    if (!e.example || !isArray((e.example as { tokens?: unknown }).tokens)) return false;
  }

  return true;
}

/**
 * lib/vocabbook-record.ts — 저장된 단어장(`VocabBookRecord`)을 화면에 올리기 전에 통과시키는
 * **단일 판정처** (V1, `lib/math-record.ts` 관용구)
 *
 * ── 왜 별도 모듈인가 ────────────────────────────────────────────────────────
 * 같은 판정이 목록(`/english/vocab`)과 표 상세(`/english/vocab/[id]`)에 두 벌로 살면 언젠가
 * 갈린다. 갈리는 순간 나타나는 증상이 **"목록에는 보이는데 눌렀더니 500"**이라 가장 나쁜
 * 형태다. 그래서 두 화면이 같은 함수 하나를 본다 — 목록은 그 줄만 건너뛰고, 상세는 `notFound()`.
 *
 * ── 타입이 보증하지 못하는 자리 ─────────────────────────────────────────────
 * `VocabBookRecord`의 타입은 필드를 필수로 선언하지만 **읽기 경로에는 타입이 없다.**
 * Firestore 문서는 손으로 넣을 수도 있고, 저장 시점의 스키마가 지금과 다를 수도 있다.
 * 그래서 "타입이 그렇다니까"가 아니라 **표가 실제로 읽는 것**이 제자리에 있는지 확인한다.
 *
 * 여기서 볼 것은 품질이 아니라 **모양**이다(판독 zod로 대신하지 않는 이유도 같다) — 표가
 * `.map()`·`.length`를 태우는 자리(entries 배열, 각 항목의 word·배열 필드)만 본다.
 */

import type { VocabEntry } from "./ai/english/vocabbook-schemas";
import type { VocabBookRecord } from "./store";

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * 표가 **실제로 읽는 필드**가 전부 제자리에 있는가.
 *
 * **단어가 하나도 없는 레코드는 열지 않는다** — 표에 그릴 것이 없어 빈 화면만 뜬다.
 * 목록에도 걸지 않는 편이(링크가 404로 떨어지는 것보다) 정직하다.
 */
export function isRenderableVocabBook(record: VocabBookRecord): boolean {
  const r = record as Partial<VocabBookRecord>;

  // 뼈대 — 목록 줄과 상세 헤더가 문자열로 다룬다(`createdAt.slice()`가 던지는 자리)
  if (!r.id || typeof r.createdAt !== "string") return false;
  if (typeof r.titleKo !== "string") return false;
  if (!isArray(r.entries) || r.entries.length === 0) return false;

  // 각 항목 — 표가 word를 제목으로 쓰고 배열 필드를 순회한다(빈 배열은 정상, 없음은 터진다)
  for (const raw of r.entries) {
    const e = raw as Partial<VocabEntry>;
    if (!e || typeof e.word !== "string" || e.word.trim() === "") return false;
    if (!isArray(e.pos) || !isArray(e.meaningsKo)) return false;
    if (!isArray(e.examples) || !isArray(e.related)) return false;
  }

  return true;
}

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
import type { JaSpeakingMockRecord } from "./ja-speaking-record";
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

// ---------------------------------------------------------------------------
// 🎙️ 말하기 모의고사(docs/harness/japanese.md §15-10-2) — 목록·학습 보기·응시·결과·라우트가 이 판정 하나를 본다
// ---------------------------------------------------------------------------

function isLine(v: unknown): boolean {
  const l = v as { ja?: unknown; tokens?: unknown; ko?: unknown } | null;
  return !!l && typeof l.ja === "string" && Array.isArray(l.tokens) && typeof l.ko === "string";
}

function isRenderableJaSpeakingPart(part: string, p: unknown): boolean {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  switch (part) {
    case "read":
      return Array.isArray(o.items) && o.items.length > 0 && o.items.every((it) => isLine((it as { passage?: unknown })?.passage) && Array.isArray((it as { tipsKo?: unknown }).tipsKo));
    case "picture":
      return (
        Array.isArray(o.items) &&
        o.items.length > 0 &&
        o.items.every((it) => {
          const x = it as { sampleAnswer?: unknown; sceneKo?: unknown; imagePrompt?: unknown; keyPointsKo?: unknown; image?: { status?: unknown } };
          return isLine(x?.sampleAnswer) && typeof x.sceneKo === "string" && typeof x.imagePrompt === "string" && Array.isArray(x.keyPointsKo) && !!x.image && typeof x.image.status === "string";
        })
      );
    case "respond":
    case "info": {
      const intro = part === "respond" ? o.intro : o.callerIntro;
      if (!isLine(intro) || !Array.isArray(o.questions) || o.questions.length === 0) return false;
      if (!o.questions.every((qq) => isLine((qq as { question?: unknown })?.question) && isLine((qq as { sampleAnswer?: unknown }).sampleAnswer))) return false;
      if (part === "info") {
        const t = o.table as { title?: unknown; meta?: unknown; rows?: unknown; notes?: unknown } | null;
        return !!t && typeof t.title === "string" && Array.isArray(t.meta) && Array.isArray(t.rows) && Array.isArray(t.notes);
      }
      return true;
    }
    case "opinion":
      return isLine(o.question) && isLine(o.sampleAnswer) && Array.isArray(o.outlineKo);
    default:
      return false;
  }
}

/** 화면이 실제로 읽는 자리가 제자리에 있는가 — 파트 하나라도 모양이 깨졌으면 열지 않는다(null 파트는 정상 — "이 파트 만들기") */
export function isRenderableJaSpeakingMock(record: JaSpeakingMockRecord): boolean {
  const r = record as Partial<JaSpeakingMockRecord>;
  if (!r.id || typeof r.createdAt !== "string" || typeof r.titleKo !== "string" || typeof r.level !== "string") return false;
  if (!r.parts || typeof r.parts !== "object" || !Array.isArray(r.topicHints)) return false;
  const parts = r.parts as Record<string, unknown>;
  for (const part of ["read", "picture", "respond", "info", "opinion"]) {
    const p = parts[part];
    if (p === null || p === undefined) continue;
    if (!isRenderableJaSpeakingPart(part, p)) return false;
  }
  return true;
}

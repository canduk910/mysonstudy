/**
 * lib/toeic-record.ts — 저장된 아빠의 영어(토익스피킹) 레코드를 화면에 올리기 전 통과시키는 **단일 판정처**
 * (docs/harness/toeic.md §1-2, `lib/japanese-record.ts`·`lib/vocabbook-record.ts` 관용구).
 *
 * 같은 판정이 목록·상세·시험·오답노트·기록 페이지와 rename·quiz·points 라우트에 여러 벌로 살면 갈린다 — 갈리는 순간
 * "목록엔 보이는데 눌렀더니 500"이 된다. 전부 이 함수를 본다(목록은 그 줄만 건너뛰고, 상세·라우트는 404).
 *
 * 여기서 보는 것은 품질이 아니라 **모양**이다 — 화면이 실제로 읽는 자리(배열 필드·문자열)만. 저장 계층이 이미
 * lib/toeic-normalize.ts로 조였지만, 판정은 정규화를 거치지 않은 값(손으로 넣은 문서 등)도 받는다고 보고 방어한다.
 */

import type { ToeicMockRecord, ToeicSetRecord } from "./store";
import { TOEIC_MOCK_PARTS } from "./toeic-mock";

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isStrOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

/** 발화 포인트가 있으면 카드가 순회하는 배열·객체가 제자리에 있는가(없으면 null이 정상 — "발화 포인트 만들기") */
function isRenderablePoints(p: unknown): boolean {
  if (p === null) return true;
  if (!isObj(p)) return false;
  if (typeof p.coreKo !== "string" || typeof p.pronunciationKo !== "string") return false;
  if (!isArray(p.useIn) || !isArray(p.frames) || !isArray(p.variations)) return false;
  if (!isObj(p.followUp)) return false;
  return isStrOrNull(p.exampleSpan) && isStrOrNull(p.pitfallKo) && isStrOrNull(p.grammarKo);
}

/**
 * 표현집 세트를 화면에 올릴 수 있는가. **표현이 하나도 없는 세트는 열지 않는다**(카드·시험이 그릴 것이 없다 —
 * 저장 라우트도 1개 이상을 강제한다, §7-1).
 */
export function isRenderableToeicSet(record: ToeicSetRecord): boolean {
  const r = record as Partial<ToeicSetRecord>;
  if (!r.id || typeof r.createdAt !== "string" || typeof r.titleKo !== "string") return false;
  if (!isArray(r.entries) || r.entries.length === 0 || !isArray(r.quiz)) return false;
  for (const raw of r.entries) {
    if (!isObj(raw)) return false;
    if (typeof raw.expression !== "string" || raw.expression.trim() === "") return false;
    if (typeof raw.meaningKo !== "string") return false;
    if (!isStrOrNull(raw.example) || !isStrOrNull(raw.exampleKo)) return false;
    if (!isRenderablePoints(raw.points)) return false;
  }
  for (const raw of r.quiz) {
    if (!isObj(raw)) return false;
    if (typeof raw.promptKo !== "string" || typeof raw.modelAnswer !== "string" || !isArray(raw.keyExpressions)) return false;
  }
  return true;
}

/** usedExpressions — 모범답변 하이라이트가 순회한다 */
function isUsedList(v: unknown): boolean {
  return isArray(v) && v.every((u) => isObj(u) && typeof u.expression === "string" && typeof u.span === "string");
}
function isStrList(v: unknown): boolean {
  return isArray(v) && v.every((x) => typeof x === "string");
}
/** C3·C4 질문 하나 */
function isQuestion(v: unknown): boolean {
  return isObj(v) && typeof v.question === "string" && typeof v.sampleAnswer === "string" && typeof v.tipKo === "string" && isUsedList(v.usedExpressions);
}

/**
 * 파트 하나가 학습 보기·응시 화면이 읽는 모양인가(§4-8 스키마 결과 + C2 image). null은 호출측이 "없는 파트"로 다룬다.
 * 쓰기 때 zod를 통과한 값이라 정상 경로에서는 늘 참이다 — 손으로 넣은 문서 등을 막는 방어다.
 */
function isRenderableMockPart(part: string, p: unknown): boolean {
  if (!isObj(p)) return false;
  switch (part) {
    case "read":
      return (
        isArray(p.items) &&
        p.items.every((it) => isObj(it) && typeof it.text === "string" && isStrList(it.chunks) && isStrList(it.stressWords) && isStrList(it.tipsKo))
      );
    case "picture":
      return (
        isArray(p.items) &&
        p.items.every(
          (it) =>
            isObj(it) &&
            typeof it.imagePrompt === "string" &&
            typeof it.sceneKo === "string" &&
            typeof it.sampleAnswer === "string" &&
            isStrList(it.keyPointsKo) &&
            isUsedList(it.usedExpressions) &&
            isObj(it.image),
        )
      );
    case "respond":
      return typeof p.intro === "string" && isArray(p.questions) && p.questions.every(isQuestion);
    case "info": {
      const t = p.table;
      return (
        isObj(t) &&
        typeof t.title === "string" &&
        isStrList(t.meta) &&
        isArray(t.rows) &&
        t.rows.every((r) => isObj(r) && typeof r.left === "string" && typeof r.right === "string") &&
        isStrList(t.notes) &&
        typeof p.callerIntro === "string" &&
        isArray(p.questions) &&
        p.questions.every(isQuestion)
      );
    }
    case "opinion":
      return (
        typeof p.question === "string" && typeof p.sampleAnswer === "string" && isStrList(p.outlineKo) && typeof p.tipKo === "string" && isUsedList(p.usedExpressions)
      );
    default:
      return false;
  }
}

/**
 * 모의고사를 화면에 올릴 수 있는가(목록·학습 보기·라우트가 같이 본다). 파트는 null(실패·미선택)이 정상이다 — 모든 파트가
 * null이어도 목록에는 보이고 "이 파트 만들기"로 채운다. null이 아닌 파트는 화면이 읽는 모양(배열·문자열·사진 상태)을 본다.
 */
export function isRenderableToeicMock(record: ToeicMockRecord): boolean {
  const r = record as Partial<ToeicMockRecord>;
  if (!r.id || typeof r.createdAt !== "string" || typeof r.titleKo !== "string") return false;
  if (!isObj(r.parts) || !isArray(r.expressionsUsed) || !isArray(r.topicHints)) return false;
  const parts = r.parts as Record<string, unknown>;
  for (const part of TOEIC_MOCK_PARTS) {
    const p = parts[part];
    if (p === null || p === undefined) continue;
    if (!isRenderableMockPart(part, p)) return false;
  }
  return true;
}

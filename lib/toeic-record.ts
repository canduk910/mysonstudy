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
import { TOEIC_GUIDE_PARTS } from "./toeic-guide";

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

// ---------------------------------------------------------------------------
// 한 문제 연습(docs/harness/toeic.md §12-3·§12-7) — 모의고사 목록·제목 번호·학습 보기에서 가리는 판정
// ---------------------------------------------------------------------------

/**
 * 한 문제 연습 문서인가(`drillPart`가 null이 아니다) — 모의고사 목록·제목 번호·학습 보기가 연습을 가리는 **유일한** 판정.
 * 목록은 이 판정으로 먼저 빼고 그다음에 skippedCount("열지 못한 n개")를 센다(순서가 반대면 연습이 "깨진 문서"로 보고된다).
 */
export function isToeicDrill(m: Pick<ToeicMockRecord, "drillPart">): boolean {
  return m.drillPart !== null && m.drillPart !== undefined;
}

/**
 * 모의고사 목록 — 연습을 **먼저** 빼고 렌더 판정을 한 뒤 `skippedCount`(연습이 아닌데 열지 못한 문서 수)를 센다(§12-3 표).
 * 목록은 상한 없이 읽은 전체를 받는다 — 상한으로 자른 뒤 거르면 연습이 많아질 때 오래된 모의고사가 빠진다. 순서는 받은 그대로.
 */
export function listableToeicMocks<T extends ToeicMockRecord>(stored: readonly T[]): { mocks: T[]; skippedCount: number } {
  const notDrill = stored.filter((m) => !isToeicDrill(m));
  const mocks = notDrill.filter(isRenderableToeicMock);
  return { mocks, skippedCount: notDrill.length - mocks.length };
}

// ---------------------------------------------------------------------------
// 유형별 공략(docs/harness/toeic.md §12-3) — 공략 계열 가리기·렌더 판정
// ---------------------------------------------------------------------------

const GUIDE_PART_SET: ReadonlySet<string> = new Set(TOEIC_GUIDE_PARTS);

/**
 * 공략 계열 문서인가(유형 공략 + 틀 은행) — 기존 목록(표현집 목록·모의고사 주제 칩·활용할 표현)에서 가리는 **유일한** 판정.
 * 목록은 이 판정으로 먼저 빼고 그다음에 skippedCount("열지 못한 n개")를 센다(순서가 반대면 공략 세트·틀 은행이 "깨진 문서"로 보고된다).
 */
export function isToeicGuideSet(s: Pick<ToeicSetRecord, "guide">): boolean {
  return s.guide !== null && s.guide !== undefined;
}

/** 유형 공략 문서인가(guide.kind "part" — 판정 전 모양 방어) */
export function isToeicGuidePartSet(s: Pick<ToeicSetRecord, "guide">): boolean {
  const g = s.guide as unknown;
  return isObj(g) && g.kind === "part";
}

/** 틀 은행 문서인가(guide.kind "templates") */
export function isToeicTemplateBankSet(s: Pick<ToeicSetRecord, "guide">): boolean {
  const g = s.guide as unknown;
  return isObj(g) && g.kind === "templates";
}

/** 줄 하나 — 읽기 탭이 읽는 자리 */
function isRenderableGuideLine(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!isStrOrNull(v.label) || !isStrOrNull(v.en) || !isStrOrNull(v.ko) || !isStrOrNull(v.note)) return false;
  if (!isStrList(v.emphasis) || !isStrList(v.underline)) return false;
  if (typeof v.alt !== "boolean" || typeof v.marked !== "boolean") return false;
  const ex = v.example;
  if (ex === null) return true;
  return isObj(ex) && typeof ex.en === "string" && isStrOrNull(ex.ko) && isStrList(ex.emphasis);
}

function isRenderableGuideBlock(v: unknown): boolean {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "heading":
      return typeof v.textKo === "string";
    case "text":
      return isStrOrNull(v.label) && isStrOrNull(v.titleKo) && isStrOrNull(v.bodyKo) && isArray(v.lines) && v.lines.every(isRenderableGuideLine);
    case "lines":
      return (
        (v.style === "list" || v.style === "template" || v.style === "completions") &&
        isStrOrNull(v.captionKo) &&
        (v.lead === null || isRenderableGuideLine(v.lead)) &&
        isArray(v.lines) &&
        v.lines.every(isRenderableGuideLine)
      );
    default:
      return false;
  }
}

/**
 * 유형 공략을 📖 읽기 탭·폴더 카드 "가져옴" 표시에 올릴 수 있는가 — kind "part"·part 네 값·섹션·블록·줄 배열과 문자열 자리.
 * **시험 페이지는 이 판정을 보지 않는다**(isRenderableToeicSet만 — 시험은 entries·quiz만 쓰므로 본문이 깨져도 시험은 된다).
 */
export function isRenderableToeicGuide(record: ToeicSetRecord): boolean {
  const g = (record as Partial<ToeicSetRecord>).guide as unknown;
  if (!isObj(g) || g.kind !== "part") return false;
  if (typeof g.part !== "string" || !GUIDE_PART_SET.has(g.part)) return false;
  if (!isStrOrNull(g.introKo) || !isArray(g.sections)) return false;
  return g.sections.every(
    (sec) => isObj(sec) && typeof sec.titleKo === "string" && isStrOrNull(sec.label) && isStrOrNull(sec.introKo) && isStrOrNull(sec.groupKo) && isArray(sec.blocks) && sec.blocks.every(isRenderableGuideBlock),
  );
}

/**
 * 틀 하나가 화면이 읽는 모양인가 — key·frameEn·frameKo·groupKo·useKo 문자열, parts·guideRefs 배열, testFills 문자열 배열의 배열,
 * examples의 en·ko·fills. 모양이 깨진 틀은 **그 틀만** 빠지고 나머지는 보인다(폴더 머리 "열지 못한 틀 n개").
 */
export function isRenderableToeicTemplate(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (typeof v.key !== "string" || v.key === "") return false;
  if (typeof v.frameEn !== "string" || typeof v.frameKo !== "string" || typeof v.groupKo !== "string" || typeof v.useKo !== "string") return false;
  if (!isStrList(v.parts) || !isArray(v.guideRefs) || !v.guideRefs.every(isObj)) return false;
  if (!isArray(v.testFills) || !v.testFills.every(isStrList)) return false;
  return isArray(v.examples) && v.examples.every((ex) => isObj(ex) && typeof ex.en === "string" && typeof ex.ko === "string" && isStrList(ex.fills));
}

/**
 * 틀 은행 문서를 열 수 있는가 — kind "templates", flows·items 배열, 흐름마다 steps 배열(단계마다 stepKo 문자열·groupsKo 문자열 배열)·
 * banksKo 배열. 틀 하나하나는 isRenderableToeicTemplate으로 따로 본다. **틀 은행은 isRenderableToeicSet을 통과하지 못한다**(entries 0) —
 * 틀 은행을 여는 곳은 전부 이 판정을 쓴다.
 */
export function isRenderableToeicTemplateBank(record: ToeicSetRecord): boolean {
  const r = record as Partial<ToeicSetRecord>;
  if (!r.id || typeof r.createdAt !== "string" || typeof r.titleKo !== "string") return false;
  const g = r.guide as unknown;
  if (!isObj(g) || g.kind !== "templates") return false;
  if (!isArray(g.flows) || !isArray(g.items)) return false;
  return g.flows.every(
    (f) =>
      isObj(f) &&
      typeof f.part === "string" &&
      isArray(f.steps) &&
      f.steps.every((st) => isObj(st) && typeof st.stepKo === "string" && isStrList(st.groupsKo)) &&
      isStrList(f.banksKo),
  );
}

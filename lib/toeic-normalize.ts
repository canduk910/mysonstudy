/**
 * lib/toeic-normalize.ts — 아빠의 영어(토익스피킹) 저장 레코드 방어 정규화 **단일 정의처** (docs/harness/toeic.md §7)
 *
 * 두 저장 백엔드(파일 `lib/store.ts`·Firestore `lib/store-firestore.ts`)가 **같은 함수**로 읽고 쓴다 — 예전에 정규화가
 * 한쪽 백엔드에만 있어 키를 잃은 선례가 있다(normalizeProblem·normalizeVocabEntry 주석). 파일 백엔드는 readDb와 쓰기에서,
 * Firestore는 to*(읽기)와 쓰기 직전에 부른다.
 *
 * 규칙(app-patterns §4 normalize 관용구):
 * - **던지지 않는다.** 없는 키는 null·빈 배열·기본값으로 채우고, 깨진 조각(모르는 문항 축의 useIn 등)은 버린다 — 읽기가
 *   던지면 페이지가 500이 된다.
 * - **값을 손보지 않는다.** 교재 원문(표현·뜻·예문)과 AI 결과는 다듬으면 원문이 바뀐다. "없는 것을 없음으로" 적을 뿐.
 * - **undefined를 남기지 않는다** — Firestore가 거부한다(getDb는 ignoreUndefinedProperties를 켜지 않는다).
 * - 세트의 `enriched`는 저장값을 믿지 않고 entries에서 **다시 계산**한다(단일 정의처 isToeicSetEnriched, §3-4) —
 *   파생 상태를 저장값과 따로 두면 진실이 둘이 된다.
 *
 * 서버 전용(lib/ai/toeic/schemas·points가 zod를 싣는다) — 클라이언트 컴포넌트에서 값으로 import하지 말 것.
 * 레코드 타입은 lib/store.ts에 있고 여기서는 `import type`만 한다(타입 순환은 컴파일 때 지워진다).
 */

import type {
  ToeicAttemptRecord,
  ToeicImageRecord,
  ToeicMockRecord,
  ToeicQuizItem,
  ToeicQuizRecord,
  ToeicSetRecord,
} from "./store";
import {
  TOEIC_CONFIDENCES,
  TOEIC_GUIDE_PARTS,
  TOEIC_IMAGE_STATUSES,
  TOEIC_PARTS,
  TOEIC_TEMPLATE_REF_KINDS,
  type ToeicAnswer,
  type ToeicAnswerFlow,
  type ToeicAnswerFlowFrame,
  type ToeicBookQuiz,
  type ToeicExprEntry,
  type ToeicFeedback,
  type ToeicGuideDoc,
  type ToeicGuidePartDoc,
  type ToeicMockParts,
  type ToeicPart,
  type ToeicPictureImage,
  type ToeicReadDiff,
  type ToeicSpeakingPoints,
  type ToeicTemplateAlternate,
  type ToeicTemplateBankDoc,
} from "./ai/toeic/schemas";
import { isToeicSetEnriched } from "./ai/toeic/points";
import { isToeicQuizMode, isToeicTemplateBankMode } from "./toeic-quiz";
import { TOEIC_DEFAULT_TARGET_GRADE, TOEIC_MOCK_PARTS, TOEIC_QUESTION_COUNT, TOEIC_TARGET_GRADES, type ToeicMockPart } from "./toeic-mock";
import { toeicAttemptQuestions } from "./toeic-attempt-rules";
import { normalizeToeicRecordingDeletions, normalizeToeicStoredFixRecordings, normalizeToeicStoredRecordings } from "./toeic-rec-rules";
import { normalizeToeicAnswerHistory, normalizeToeicRetakes } from "./toeic-retake";
import { normalizeToeicAnswerDiags } from "./toeic-mic-health";

// ---------------------------------------------------------------------------
// 작은 방어 헬퍼
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function obj(v: unknown): Loose | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function isoOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}
const EPOCH = new Date(0).toISOString();

const PART_SET: ReadonlySet<string> = new Set(TOEIC_PARTS);
const CONFIDENCE_SET: ReadonlySet<string> = new Set(TOEIC_CONFIDENCES);
const IMAGE_STATUS_SET: ReadonlySet<string> = new Set(TOEIC_IMAGE_STATUSES);
const MOCK_PART_SET: ReadonlySet<string> = new Set(TOEIC_MOCK_PARTS);
const GRADE_SET: ReadonlySet<string> = new Set(TOEIC_TARGET_GRADES);
const GUIDE_PART_SET: ReadonlySet<string> = new Set(TOEIC_GUIDE_PARTS);
const REF_KIND_SET: ReadonlySet<string> = new Set(TOEIC_TEMPLATE_REF_KINDS);

function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 같은 자리 다른 표현(§12-13-1) — 배열이 아니거나 없으면 [](옛 문서·다시 가져오기 전), 항목마다 모양(part 네 값·kind 세 값·ref·coveredBy
 * 비지 않은 문자열)을 보고 맞는 것만. 깨져도 틀 은행은 연다(접기만 빠진다 — 렌더 판정에 넣지 않는다). **이 필드를 명시적으로 옮긴다** —
 * 빠뜨리면 alternates만 지워지고 contentHash(alternates 포함)는 저장돼, 같은 파일을 다시 넣어도 unchanged라 접기 자료가 영영 안 들어간다.
 */
export function normalizeToeicTemplateAlternates(v: unknown): ToeicTemplateAlternate[] {
  if (!Array.isArray(v)) return [];
  const out: ToeicTemplateAlternate[] = [];
  for (const raw of v) {
    const a = obj(raw);
    if (!a) continue;
    if (typeof a.part !== "string" || !GUIDE_PART_SET.has(a.part)) continue;
    if (typeof a.kind !== "string" || !REF_KIND_SET.has(a.kind)) continue;
    if (!nonEmptyStr(a.ref) || !nonEmptyStr(a.coveredBy)) continue;
    out.push({ part: a.part as ToeicTemplateAlternate["part"], kind: a.kind as ToeicTemplateAlternate["kind"], ref: a.ref, coveredBy: a.coveredBy });
  }
  return out;
}

function normalizeFlowFrame(v: unknown): ToeicAnswerFlowFrame | null {
  const f = obj(v);
  if (!f || !nonEmptyStr(f.key) || !nonEmptyStr(f.expression)) return null;
  return { key: f.key, expression: f.expression };
}

/**
 * 모의고사·연습 문서의 답변 흐름(§7-2·§12-13-3) — 배열이 아니거나 없으면 [](옛 문서 = 흐름 없음 → 다시 만들기·채점 모두 "없음"),
 * 모양이 깨진 흐름은 **그 항목만** 버린다(part가 read를 뺀 네 파트 밖·steps·banks가 배열이 아님·단계 이름 빈 값·틀 모양이 깨짐·같은 파트
 * 두 번째). 단계·틀은 형식을 보고 옮긴다(배열 속 배열이 없다 — 흐름 = 배열 안 객체 안 배열이라 Firestore 제약에 걸리지 않는다).
 */
export function normalizeToeicAnswerFlows(v: unknown): ToeicAnswerFlow[] {
  if (!Array.isArray(v)) return [];
  const out: ToeicAnswerFlow[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const f = obj(raw);
    if (!f || typeof f.part !== "string" || !MOCK_PART_SET.has(f.part) || f.part === "read" || seen.has(f.part)) continue;
    if (!Array.isArray(f.steps) || !Array.isArray(f.banks)) continue;
    let broken = false;
    const steps: ToeicAnswerFlow["steps"] = [];
    for (const rs of f.steps) {
      const st = obj(rs);
      if (!st || !nonEmptyStr(st.stepKo) || !Array.isArray(st.frames)) {
        broken = true;
        break;
      }
      const frames = st.frames.map(normalizeFlowFrame);
      if (frames.some((x) => x === null)) {
        broken = true;
        break;
      }
      steps.push({ stepKo: st.stepKo, frames: frames as ToeicAnswerFlowFrame[] });
    }
    const banks = f.banks.map(normalizeFlowFrame);
    if (broken || banks.some((x) => x === null)) continue;
    seen.add(f.part);
    out.push({ part: f.part as ToeicAnswerFlow["part"], steps, banks: banks as ToeicAnswerFlowFrame[] });
  }
  return out;
}

function enKo(v: unknown): { en: string; ko: string } {
  const o = obj(v) ?? {};
  return { en: str(o.en), ko: str(o.ko) };
}

// ---------------------------------------------------------------------------
// 표현집 세트(§7-1)
// ---------------------------------------------------------------------------

/** 발화 포인트(호출 B 결과) — 객체가 아니면 null(= 아직 없음). 모르는 문항 축의 useIn은 버린다. */
export function normalizeToeicSpeakingPoints(v: unknown): ToeicSpeakingPoints | null {
  const p = obj(v);
  if (!p) return null;
  const useIn = Array.isArray(p.useIn)
    ? p.useIn.flatMap((u) => {
        const o = obj(u);
        if (!o || typeof o.part !== "string" || !PART_SET.has(o.part)) return [];
        return [{ part: o.part as ToeicPart, sentence: str(o.sentence), sentenceKo: str(o.sentenceKo) }];
      })
    : [];
  return {
    exampleSpan: strOrNull(p.exampleSpan),
    coreKo: str(p.coreKo),
    useIn,
    frames: strArr(p.frames),
    variations: Array.isArray(p.variations) ? p.variations.map(enKo) : [],
    pronunciationKo: str(p.pronunciationKo),
    pitfallKo: strOrNull(p.pitfallKo),
    grammarKo: strOrNull(p.grammarKo),
    followUp: enKo(p.followUp),
  };
}

/** 표현 항목(§7-1). `example`이 null이면 `exampleKo`도 null(§2-4 불변). */
export function normalizeToeicExprEntry(v: unknown): ToeicExprEntry {
  const e = obj(v) ?? {};
  const example = strOrNull(e.example);
  return {
    no: intOrNull(e.no),
    expression: str(e.expression),
    meaningKo: str(e.meaningKo),
    example,
    exampleKo: example === null ? null : strOrNull(e.exampleKo),
    points: normalizeToeicSpeakingPoints(e.points),
    confidence: typeof e.confidence === "string" && CONFIDENCE_SET.has(e.confidence) ? (e.confidence as ToeicExprEntry["confidence"]) : "medium",
    partial: e.partial === true,
  };
}

/** 교재 하단 QUIZ(§7-1) */
export function normalizeToeicBookQuiz(v: unknown): ToeicBookQuiz {
  const q = obj(v) ?? {};
  return {
    no: intOrNull(q.no),
    promptKo: str(q.promptKo),
    hint: strOrNull(q.hint),
    modelAnswer: str(q.modelAnswer),
    keyExpressions: strArr(q.keyExpressions),
  };
}

/**
 * 공략 계열 문서 표시(docs/harness/toeic.md §12-3 "정규화 깊이") — normalizeToeicSetRecord가 모르는 키를 버리므로 **명시적으로 옮긴다**
 * (빠뜨리면 생성·이름 바꾸기·병합 경로에서 공략이 조용히 표현집으로 둔갑한다).
 * - 키가 없거나 null → null(옛 문서 = 표현집).
 * - 객체 → kind를 보고 옮긴다. "templates"면 flows·items를 배열이면 통째로, "part"(또는 kind 없음 — 방어)면 part·introKo·contentHash·
 *   updatedAt은 형식을 보고 옮기고 sections는 배열이면 통째로(안쪽 모양은 렌더 판정이 본다).
 * - kind가 두 값 밖이거나 part가 네 값 밖이거나 sections·items가 배열이 아니어도 **null로 떨어뜨리지 않는다** — 떨어뜨리면 깨진
 *   공략이 표현집 목록에 섞인다. 받은 값을 그대로 두고(없으면 null — Firestore undefined 거부), 렌더 판정(lib/toeic-record.ts)이
 *   막는다. 그래서 이 반환값은 타입과 다른 값을 담을 수 있다 — 화면은 늘 렌더 판정을 먼저 본다.
 * - 객체가 아닌 값(문자열·숫자·배열 등)도 깨진 유형 공략으로 둔다(isToeicGuideSet true, 렌더 false).
 */
export function normalizeToeicGuideDoc(v: unknown): ToeicGuideDoc | null {
  if (v === undefined || v === null) return null;
  const g = obj(v);
  const keep = (x: unknown): unknown => (x === undefined ? null : x);
  if (!g) {
    const broken = { kind: "part", part: "", introKo: null, sections: null, contentHash: "", updatedAt: EPOCH };
    return broken as unknown as ToeicGuidePartDoc;
  }
  if (g.kind === "templates") {
    const bank = {
      kind: "templates" as const,
      flows: Array.isArray(g.flows) ? g.flows : keep(g.flows),
      items: Array.isArray(g.items) ? g.items : keep(g.items),
      // 같은 자리 다른 표현(§12-13-1) — 캐스트라 빠뜨려도 tsc가 못 잡는다. 명시적으로 옮긴다(eval 파일 저장소 왕복이 잠근다)
      alternates: normalizeToeicTemplateAlternates(g.alternates),
      contentHash: str(g.contentHash),
      updatedAt: isoOr(g.updatedAt, EPOCH),
    };
    return bank as unknown as ToeicTemplateBankDoc;
  }
  const part = {
    // kind 없음 → "part"로 읽는다. 모르는 kind는 그대로 둔다(렌더 판정에서 떨어진다)
    kind: g.kind === undefined || g.kind === null ? "part" : keep(g.kind),
    part: typeof g.part === "string" ? g.part : keep(g.part),
    introKo: strOrNull(g.introKo),
    sections: Array.isArray(g.sections) ? g.sections : keep(g.sections),
    contentHash: str(g.contentHash),
    updatedAt: isoOr(g.updatedAt, EPOCH),
  };
  return part as unknown as ToeicGuidePartDoc;
}

/** 표현집 세트 레코드(§7-1) — enriched는 entries에서 다시 계산한다(entries가 비면 false — 틀 은행). guide는 §12-3 정규화. */
export function normalizeToeicSetRecord(v: unknown): ToeicSetRecord {
  const r = obj(v) ?? {};
  const entries = Array.isArray(r.entries) ? r.entries.map(normalizeToeicExprEntry) : [];
  return {
    id: str(r.id),
    titleKo: str(r.titleKo),
    dayNo: intOrNull(r.dayNo),
    topicKo: strOrNull(r.topicKo),
    source: r.source === "import" ? "import" : "photo",
    presetKey: strOrNull(r.presetKey),
    entries,
    quiz: Array.isArray(r.quiz) ? r.quiz.map(normalizeToeicBookQuiz) : [],
    photoCount: typeof r.photoCount === "number" && Number.isFinite(r.photoCount) ? r.photoCount : 0,
    enriched: entries.length > 0 && isToeicSetEnriched(entries),
    model: strOrNull(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
    sortIndex: numOrNull(r.sortIndex),
    guide: normalizeToeicGuideDoc(r.guide),
  };
}

// ---------------------------------------------------------------------------
// 표현 시험 세션(§7-3)
// ---------------------------------------------------------------------------

/** 문항 결과 — answered 3상태(true/false/null) 유지, correct는 boolean으로 굳힌다(영어·일본어와 같은 규약). */
export function normalizeToeicQuizItem(v: unknown): ToeicQuizItem {
  const it = obj(v) ?? {};
  return {
    word: str(it.word),
    correct: it.correct === true,
    answered: it.answered === true ? true : it.answered === false ? false : null,
  };
}

/**
 * 시험 세션 레코드. **모르는 mode면 null**(호출측이 버린다) — 모드별 숙련도(§6-2)가 이 축에 매달려 있어, 모르는 값을
 * 아무 모드로 떨어뜨리면 그 모드의 "안다" 판정이 오염된다. 저장 라우트 zod가 막으므로 정상 경로에서는 오지 않는다.
 * 받는 mode는 표현 시험 네 모드 + 틀 은행 세션 다섯 모드(② 틀 테스트 둘 · ③ 틀 시험 셋 — §12-3·§12-13-2)다.
 */
export function normalizeToeicQuizRecord(v: unknown): ToeicQuizRecord | null {
  const r = obj(v) ?? {};
  if (!isToeicQuizMode(r.mode) && !isToeicTemplateBankMode(r.mode)) return null;
  return {
    id: str(r.id),
    setId: str(r.setId),
    mode: r.mode,
    startedAt: isoOr(r.startedAt, EPOCH),
    finishedAt: strOrNull(r.finishedAt),
    items: Array.isArray(r.items) ? r.items.map(normalizeToeicQuizItem) : [],
  };
}

// ---------------------------------------------------------------------------
// 모의고사·생성 사진·응시(§7-2·§7-4·§7-5) — T3~T5가 채운다. 파트 본문은 쓰기 때 zod를 통과한 값이라 통째로 담고
// (설명 기록 toExplanation과 같은 판단), 화면이 곧바로 쓰는 자리(사진 상태·배열)만 조인다.
// ---------------------------------------------------------------------------

function normalizePictureImage(v: unknown): ToeicPictureImage {
  const o = obj(v) ?? {};
  const status = typeof o.status === "string" && IMAGE_STATUS_SET.has(o.status) ? (o.status as ToeicPictureImage["status"]) : "failed";
  return { status, imageId: status === "ready" ? strOrNull(o.imageId) : null };
}

function normalizeMockParts(v: unknown): ToeicMockParts {
  const src = obj(v) ?? {};
  const out = {} as Record<ToeicMockPart, unknown>;
  for (const part of TOEIC_MOCK_PARTS) {
    const p = obj(src[part]);
    if (!p) {
      out[part] = null;
      continue;
    }
    if (part === "picture") {
      const items = Array.isArray(p.items) ? p.items : [];
      out[part] = { ...p, items: items.map((it) => ({ ...(obj(it) ?? {}), image: normalizePictureImage(obj(it)?.image) })) };
    } else {
      out[part] = p;
    }
  }
  return out as ToeicMockParts;
}

export function normalizeToeicMockRecord(v: unknown): ToeicMockRecord {
  const r = obj(v) ?? {};
  return {
    id: str(r.id),
    titleKo: str(r.titleKo),
    targetGrade: typeof r.targetGrade === "string" && GRADE_SET.has(r.targetGrade) ? (r.targetGrade as ToeicMockRecord["targetGrade"]) : TOEIC_DEFAULT_TARGET_GRADE,
    expressionsUsed: strArr(r.expressionsUsed),
    // T3에서 더한 필드 — 이전 문서는 빈 배열(파트 다시 만들기가 "주제 힌트 없음"으로 부른다)
    topicHints: strArr(r.topicHints),
    parts: normalizeMockParts(r.parts),
    // 유형별 공략 한 문제 연습(§12-3) — 필드가 없거나 다섯 파트 밖이면 null(= 모의고사). 옛 문서는 모두 모의고사다.
    drillPart: typeof r.drillPart === "string" && MOCK_PART_SET.has(r.drillPart) ? (r.drillPart as ToeicMockPart) : null,
    // 답변 흐름(§7-2·§12-13-3 — 2026-10-02) — 모르는 키를 버리는 정규화라 명시적으로 옮긴다. 옛 문서 = []
    answerFlows: normalizeToeicAnswerFlows(r.answerFlows),
    model: str(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
    sortIndex: numOrNull(r.sortIndex),
  };
}

export function normalizeToeicImageRecord(v: unknown): ToeicImageRecord {
  const r = obj(v) ?? {};
  return {
    id: str(r.id),
    mockId: str(r.mockId),
    slot: r.slot === 1 ? 1 : 0,
    dataUrl: str(r.dataUrl),
    model: str(r.model),
    createdAt: isoOr(r.createdAt, EPOCH),
  };
}

function normalizeReadDiff(v: unknown): ToeicReadDiff | null {
  const d = obj(v);
  if (!d) return null;
  return {
    accuracy: typeof d.accuracy === "number" && Number.isFinite(d.accuracy) ? d.accuracy : 0,
    missing: strArr(d.missing),
    extra: strArr(d.extra),
    substituted: Array.isArray(d.substituted)
      ? d.substituted.map((s) => {
          const o = obj(s) ?? {};
          return { expected: str(o.expected), heard: str(o.heard) };
        })
      : [],
  };
}

function normalizeFeedback(v: unknown): ToeicFeedback | null {
  const f = obj(v);
  if (!f) return null;
  return {
    score: typeof f.score === "number" && Number.isFinite(f.score) ? f.score : 0,
    summaryKo: str(f.summaryKo),
    strengths: strArr(f.strengths),
    fixes: Array.isArray(f.fixes)
      ? f.fixes.map((x) => {
          const o = obj(x) ?? {};
          return { said: str(o.said), better: str(o.better), whyKo: str(o.whyKo) };
        })
      : [],
    missingKo: strArr(f.missingKo),
    improvedAnswer: str(f.improvedAnswer),
    tryExpressions: strArr(f.tryExpressions),
  };
}

/** 응시 문항 결과(§7-5). q가 정수가 아니면 0(추정 총점이 1..11 밖으로 건너뛴다 — QA P2-9 방어). */
export function normalizeToeicAnswer(v: unknown): ToeicAnswer {
  const a = obj(v) ?? {};
  return {
    q: typeof a.q === "number" && Number.isInteger(a.q) ? a.q : 0,
    recorded: a.recorded === true,
    durationMs: numOrNull(a.durationMs),
    transcript: strOrNull(a.transcript),
    readDiff: normalizeReadDiff(a.readDiff),
    feedback: normalizeFeedback(a.feedback),
    score: numOrNull(a.score),
    scoredAt: strOrNull(a.scoredAt),
  };
}

/**
 * 응시 범위 문항(§12-3 `questions`) — 1..11 정수만 중복 없이 오름차순. 필드가 없는 옛 문서·비었거나 깨진 값은 파트의 문항
 * (`toeicAttemptQuestions(parts)`)으로 읽는다 — 범위가 비면 끝내기가 아무 문항도 채우지 못해 "닫힘"이 서지 않는다.
 */
function normalizeAttemptQuestions(v: unknown, parts: readonly ToeicMockPart[]): number[] {
  const list = Array.isArray(v) ? v.filter((q): q is number => typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= TOEIC_QUESTION_COUNT) : [];
  const uniq = [...new Set(list)].sort((a, b) => a - b);
  return uniq.length > 0 ? uniq : toeicAttemptQuestions(parts);
}

export function normalizeToeicAttemptRecord(v: unknown): ToeicAttemptRecord {
  const r = obj(v) ?? {};
  const parts = strArr(r.parts).filter((p): p is ToeicMockPart => MOCK_PART_SET.has(p));
  return {
    id: str(r.id),
    mockId: str(r.mockId),
    scope: r.scope === "part" ? "part" : "full",
    parts,
    questions: normalizeAttemptQuestions(r.questions, parts),
    startedAt: isoOr(r.startedAt, EPOCH),
    finishedAt: strOrNull(r.finishedAt),
    answers: Array.isArray(r.answers) ? r.answers.map(normalizeToeicAnswer) : [],
    // 내 녹음 서버 보관 메타(§13-5) — 모르는 키를 버리는 정규화라 명시적으로 옮긴다. 옛 문서 = [], 깨진 항목만 버림, 같은 q는 늦은 녹음 하나
    recordings: normalizeToeicStoredRecordings(r.recordings),
    // 고칠 문장 다시 녹음 메타·지운 자리(§14-2·§14-3) — 같은 이유로 명시적으로 옮긴다. 옛 문서 = []
    fixRecordings: normalizeToeicStoredFixRecordings(r.fixRecordings),
    recordingDeletions: normalizeToeicRecordingDeletions(r.recordingDeletions),
    // 문항 단위 다시 풀기(§15-1) — 다시 풀기 기록·예전 답 이력·문항별 진단. 같은 이유로 명시적으로 옮긴다. 옛 문서 = []
    retakes: normalizeToeicRetakes(r.retakes),
    answerHistory: normalizeToeicAnswerHistory(r.answerHistory, normalizeToeicAnswer),
    answerDiags: normalizeToeicAnswerDiags(r.answerDiags),
  };
}

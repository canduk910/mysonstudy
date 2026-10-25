/**
 * lib/ja-speaking-contract.ts — 🎙️ 일본어 말하기 모의고사 라우트 ↔ 화면 경계 타입·주소·문항 화면 자료 (docs/harness/japanese.md §15-10)
 *
 * 응답 shape의 **단일 정의처**다. 라우트는 응답 헬퍼의 인자 타입으로 걸고, 화면은 같은 타입으로 받는다.
 * ⚠️ 클라이언트 번들 안전: `lib/ai/*`·`lib/store`·`lib/ja-speaking-record`는 **`import type`만**. 값은 런타임 의존이 순수 모듈뿐인
 * `lib/ja-speaking`(→ toeic-mock)·`lib/toeic-attempt-contract`(토익 응시 화면 계약 — 업로드 형식·크기·동시 채점 수를 같은 값으로 쓴다)에서만.
 */

import type { JlptLevel } from "./ai/japanese/schemas";
import type { JaLine, JaSpeakingInfoTable } from "./ai/japanese/speaking-schemas";
import type { JaSpeakingParts } from "./ai/japanese/speaking";
import type { JaSpeakingAnswer, JaSpeakingAttemptRecord, JaSpeakingMockRecord } from "./ja-speaking-record";
import type { JaToken } from "./japanese-ruby-contract";
import type { ToeicQuestionView } from "./toeic-attempt-contract";
import type { ToeicSetBackLink } from "./toeic-guide-view";
import {
  JA_SPEAKING_PARTS,
  JA_SPEAKING_PART_NAME_KO,
  JA_SPEAKING_QUESTION_COUNT,
  defaultJaSpeakingTitle,
  jaSpeakingQuestionFormat,
  jaSpeakingQuestionsForParts,
  type JaSpeakingPart,
} from "./ja-speaking";

export type { JaSpeakingAnswer, JaSpeakingAttemptRecord, JaSpeakingMockRecord, JaSpeakingParts };

type Issue = { path: string; message: string };

// ===========================================================================
// 주소
// ===========================================================================

export const JA_SPEAKING_HOME_HREF = "/japanese/speaking";
export function jaSpeakingMockHref(id: string): string {
  return `/japanese/speaking/${encodeURIComponent(id)}`;
}
/** 응시 주소 — 실전(scope=full) 또는 유형 연습(scope=part&part=…) */
export function jaSpeakingTakeHref(id: string, scope: "full" | "part", part?: JaSpeakingPart): string {
  const base = `/japanese/speaking/${encodeURIComponent(id)}/take`;
  return scope === "full" ? `${base}?scope=full` : `${base}?scope=part&part=${encodeURIComponent(part ?? "")}`;
}
export function jaSpeakingAttemptHref(attemptId: string): string {
  return `/japanese/speaking/attempts/${encodeURIComponent(attemptId)}`;
}
/** 사진 바이트(PIN 게이트 안, cache-control private) */
export function jaSpeakingImageUrl(imageId: string): string {
  return `/api/japanese/speaking/images/${encodeURIComponent(imageId)}`;
}
export function jaSpeakingAttemptsApi(mockId: string): string {
  return `/api/japanese/speaking/mocks/${encodeURIComponent(mockId)}/attempts`;
}
export function jaSpeakingFinishApi(attemptId: string): string {
  return `/api/japanese/speaking/attempts/${encodeURIComponent(attemptId)}/finish`;
}
export function jaSpeakingScoreApi(attemptId: string): string {
  return `/api/japanese/speaking/attempts/${encodeURIComponent(attemptId)}/score`;
}

/** 학습 보기 "← 상위"·응시 화면 "뒤로" */
export function jaSpeakingMockBackLink(mockId: string): ToeicSetBackLink {
  return { href: jaSpeakingMockHref(mockId), labelKo: "← 학습 보기", buttonKo: "학습 보기로" };
}

// ===========================================================================
// 라벨
// ===========================================================================

/** "Q1–2 지문 읽기" */
export function jaSpeakingPartLabelKo(part: JaSpeakingPart): string {
  const qs = jaSpeakingQuestionsForParts([part]);
  const range = qs.length > 1 ? `Q${qs[0]}–${qs[qs.length - 1]}` : `Q${qs[0]}`;
  return `${range} ${JA_SPEAKING_PART_NAME_KO[part]}`;
}
/** "실전 응시" / "유형 연습 · Q5–7 듣고 답하기" */
export function jaSpeakingScopeLabelKo(scope: "full" | "part", parts: readonly JaSpeakingPart[]): string {
  return scope === "full" ? "실전 응시" : `유형 연습 · ${parts.map(jaSpeakingPartLabelKo).join(" · ")}`;
}

// ===========================================================================
// 시험 창 화면 글자(일본어 — 실전 일본어 시험 느낌, docs/harness/japanese.md §15-10-3 시험 프로필 examLabels)
// 토익은 lib/toeic-exam-screen의 영어 그대로(프로필이 없으면 이 표를 쓰지 않는다)
// ===========================================================================

/** 파트 유형 이름(시험 창 지시문 제목) */
export const JA_SPEAKING_EXAM_PART_TYPE_JA: Record<JaSpeakingPart, string> = {
  read: "音読",
  picture: "写真描写",
  respond: "質問への応答",
  info: "資料を見て答える",
  opinion: "意見を述べる",
};
export const JA_SPEAKING_EXAM_TIMER_JA = { "PREPARATION TIME": "準備時間", "RESPONSE TIME": "回答時間" } as const;
export const JA_SPEAKING_EXAM_DIRECTIONS_LABEL = "指示：";
export const JA_SPEAKING_EXAM_CONTINUE = "次へ";
export const JA_SPEAKING_EXAM_VOLUME = "音量";

function jaQuestionRange(qs: readonly number[]): string {
  return qs.length > 1 ? `問題 ${qs[0]}–${qs[qs.length - 1]}` : `問題 ${qs[0]}`;
}
/** 머리 띠 가운데 — "問題 3 / 11" · 정보 활용은 파트 내내 "問題 8–10 / 11"(토익 toeicExamBandTitle과 같은 자리) */
export function jaSpeakingExamBandTitle(q: number): string {
  const f = jaSpeakingQuestionFormat(q);
  const total = JA_SPEAKING_QUESTION_COUNT;
  if (f.part === "info") return `${jaQuestionRange(jaSpeakingQuestionsForParts(["info"]))} / ${total}`;
  return `問題 ${q} / ${total}`;
}
/** 지시문 화면 제목 — "問題 1–2：音読"(응시 범위 안의 그 파트 문항 — 사진 1장이면 "問題 3：写真描写") */
export function jaSpeakingExamDirectionsTitle(part: JaSpeakingPart, attemptQs: readonly number[]): string {
  const inPart = attemptQs.filter((q) => jaSpeakingQuestionFormat(q).part === part);
  return `${jaQuestionRange(inPart.length > 0 ? inPart : jaSpeakingQuestionsForParts([part]))}：${JA_SPEAKING_EXAM_PART_TYPE_JA[part]}`;
}
/** 시험 프로필 examLabels(일본어) */
export const JA_SPEAKING_EXAM_LABELS = {
  bandTitle: jaSpeakingExamBandTitle,
  directionsTitle: jaSpeakingExamDirectionsTitle,
  directionsLabel: JA_SPEAKING_EXAM_DIRECTIONS_LABEL,
  continueLabel: JA_SPEAKING_EXAM_CONTINUE,
  volumeLabel: JA_SPEAKING_EXAM_VOLUME,
  timerLabel: (label: keyof typeof JA_SPEAKING_EXAM_TIMER_JA): string => JA_SPEAKING_EXAM_TIMER_JA[label] ?? label,
};

/** 지문 종류(한국어) */
export const JA_SPEAKING_READ_KIND_KO: Record<string, string> = {
  advertisement: "광고",
  announcement: "안내 방송",
  news: "뉴스",
  introduction: "소개",
  tour: "관광 안내",
  voicemail: "음성 메시지",
};

/** 다음 기본 제목 — 기존 "말하기 모의고사 n" 가운데 가장 큰 n + 1(지운 번호를 다시 쓰지 않는다) */
export function nextJaSpeakingTitle(existingTitles: readonly string[]): string {
  let max = 0;
  for (const t of existingTitles) {
    const m = /^말하기 모의고사 (\d{1,4})$/.exec(t.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return defaultJaSpeakingTitle(max + 1);
}

/** 제목 상한(이름 바꾸기) */
export const JA_SPEAKING_TITLE_MAX_CHARS = 40;

// ===========================================================================
// 만들기 — `POST /api/japanese/speaking/mocks`
// ===========================================================================

export interface JaSpeakingCreateRequest {
  level: JlptLevel;
  /** 생략 = 다섯 파트 */
  parts?: JaSpeakingPart[];
  topicHints?: string[];
}
export type JaSpeakingCreateResponse =
  | { ok: true; id: string; titleKo: string; createdParts: JaSpeakingPart[]; failedParts: JaSpeakingPart[] }
  | { ok: false; error: "invalid_input" | "no_api_key" | "ai_failed" | "save_failed"; messageKo: string; issues?: Issue[]; retriable?: boolean };

// ===========================================================================
// 상세·삭제·이름 — `GET|DELETE /api/japanese/speaking/mocks/[id]` · `POST …/[id]/rename`
// ===========================================================================

export type JaSpeakingMockGetResponse =
  | { ok: true; mock: JaSpeakingMockRecord }
  | { ok: false; error: "mock_not_found" | "load_failed"; messageKo: string };
export type JaSpeakingMockDeleteResponse =
  | { ok: true }
  | { ok: false; error: "mock_not_found" | "prod_guard" | "delete_failed"; messageKo: string };
export interface JaSpeakingRenameRequest {
  titleKo: string;
}
export type JaSpeakingRenameResponse =
  | { ok: true; id: string; titleKo: string }
  | { ok: false; error: "invalid_input" | "mock_not_found" | "save_failed"; messageKo: string; issues?: Issue[] };

// ===========================================================================
// 파트 다시 만들기 — `POST …/[id]/regenerate?part=`
// ===========================================================================

export type JaSpeakingRegenerateResponse =
  | { ok: true; id: string; part: JaSpeakingPart }
  | {
      ok: false;
      error: "invalid_input" | "mock_not_found" | "part_exists" | "no_api_key" | "ai_failed" | "save_failed";
      messageKo: string;
      retriable?: boolean;
    };

// ===========================================================================
// 사진 — `POST …/[id]/image` {slot}
// ===========================================================================

export interface JaSpeakingImageRequest {
  slot: 0 | 1;
}
export type JaSpeakingImageSlotView = { status: "pending" | "ready" | "failed"; imageId: string | null };
export type JaSpeakingImageResponse =
  | { ok: true; slot: 0 | 1; image: JaSpeakingImageSlotView; reused: boolean }
  | {
      ok: false;
      error: "invalid_input" | "mock_not_found" | "picture_not_found" | "scene_changed" | "no_api_key" | "image_failed" | "save_failed";
      messageKo: string;
      image: JaSpeakingImageSlotView | null;
      retriable?: boolean;
    };

// ===========================================================================
// 응시 시작·끝 — 토익 응시 화면(components/toeic-take-view.tsx)이 같은 자리(ok·attemptId / ok·recordedCount·already_finished)를 읽는다
// ===========================================================================

export interface JaSpeakingAttemptCreateRequest {
  scope: "full" | "part";
  parts: JaSpeakingPart[];
}
export type JaSpeakingAttemptCreateResponse =
  | { ok: true; attemptId: string; scope: "full" | "part"; parts: JaSpeakingPart[]; questions: number[]; startedAt: string }
  | { ok: false; error: "invalid_input" | "mock_not_found" | "incomplete_mock" | "part_missing" | "save_failed"; messageKo: string; issues?: Issue[] };

export interface JaSpeakingAttemptFinishRequest {
  finishedAt: string | null;
  /** 응시 화면이 진단(diag)을 함께 실어 보낸다 — 일본어는 저장하지 않는다(토익 §15-11 전용) */
  answers: { q: number; recorded: boolean; durationMs: number | null; diag?: unknown }[];
}
export type JaSpeakingAttemptFinishResponse =
  | { ok: true; id: string; finishedAt: string | null; recordedCount: number; answers: JaSpeakingAnswer[] }
  | { ok: false; error: "invalid_input" | "attempt_not_found" | "already_finished" | "save_failed"; messageKo: string; issues?: Issue[]; recordedCount?: number };

// ===========================================================================
// AI 채점 — `POST /api/japanese/speaking/attempts/[id]/score` (multipart q·audio — 필드 이름·형식·크기는 토익 계약 그대로)
// ===========================================================================

export type JaSpeakingScoreResponse =
  | { ok: true; q: number; answer: JaSpeakingAnswer; reused: boolean; transcriptSource: "new" | "stored" | "reused"; noResponse: boolean }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "audio_too_large"
        | "attempt_not_found"
        | "question_not_found"
        | "not_finished"
        | "not_recorded"
        | "no_api_key"
        | "transcribe_failed"
        | "ai_failed"
        | "save_failed"
        | "client_closed";
      messageKo: string;
      retriable?: boolean;
      /** ai_failed면 전사문까지 저장된 그 문항 */
      answer?: JaSpeakingAnswer | null;
    };

// ===========================================================================
// 문항 화면 자료 — 토익 응시 화면이 읽는 모양(ToeicQuestionView) + 일본어 토큰·한국어 뜻(후리가나 렌더·뜻 펼치기)
// ===========================================================================

export interface JaSpeakingQuestionExtra {
  /** Q1–2 지문 */
  passage: JaLine | null;
  /** Q5–7 상황 소개 · Q8–10 전화 건 사람 도입 */
  intro: JaLine | null;
  /** Q5–11 질문 */
  question: JaLine | null;
  /** Q3–11 모범답변 */
  sampleAnswer: JaLine | null;
  /** Q8–10 표 한국어 제목 */
  tableTitleKo: string | null;
}
export type JaSpeakingQuestionView = ToeicQuestionView & { ja: JaSpeakingQuestionExtra };

function emptyView(q: number): JaSpeakingQuestionView {
  const f = jaSpeakingQuestionFormat(q);
  return {
    q,
    part: f.part,
    slot: f.slot,
    partNameKo: JA_SPEAKING_PART_NAME_KO[f.part],
    partLabelKo: jaSpeakingPartLabelKo(f.part),
    prepSec: f.prepSec,
    answerSec: f.answerSec,
    readingSec: f.readingSec,
    questionPlays: f.questionPlays,
    maxScore: f.maxScore,
    showQuestionText: f.showQuestionText,
    directions: f.directions,
    spokenIntro: null,
    available: false,
    passage: null,
    passageKindKo: null,
    picture: null,
    intro: null,
    table: null,
    question: null,
    sampleAnswer: null,
    usedExpressions: [],
    tipKo: null,
    keyPointsKo: [],
    outlineKo: [],
    ja: { passage: null, intro: null, question: null, sampleAnswer: null, tableTitleKo: null },
  };
}

function toeicTable(t: JaSpeakingInfoTable): ToeicQuestionView["table"] {
  return { kind: t.kind, title: t.title, meta: t.meta, rows: t.rows, notes: t.notes };
}

/**
 * 모의고사 파트 → 문항 하나의 화면 자료. 숫자(시간·만점·재생 횟수)는 형식표에서(이중 정의 없음). 자료가 없으면 available:false.
 * 토익 칸(passage·question·intro·spokenIntro·sampleAnswer)에는 일본어 원문(ja)을 넣는다 — 응시 화면이 그 글을 ja-JP로 읽는다.
 * spokenIntro는 Q5(상황 소개)·Q8(전화 건 사람)에만(jaSpeakingQuestionPieces와 같은 자리).
 */
export function buildJaSpeakingQuestionView(parts: JaSpeakingParts, q: number): JaSpeakingQuestionView {
  const v = emptyView(q);
  switch (v.part) {
    case "read": {
      const it = parts.read?.items[v.slot];
      if (!it) return v;
      return {
        ...v,
        available: true,
        passage: it.passage.ja,
        passageKindKo: JA_SPEAKING_READ_KIND_KO[it.kind] ?? it.kind,
        keyPointsKo: it.tipsKo,
        ja: { ...v.ja, passage: it.passage },
      };
    }
    case "picture": {
      const it = parts.picture?.items[v.slot];
      if (!it) return v;
      const imageId = it.image?.status === "ready" && it.image.imageId ? it.image.imageId : null;
      return {
        ...v,
        available: true,
        picture: { sceneKo: it.sceneKo, imageId, place: it.place },
        sampleAnswer: it.sampleAnswer.ja,
        keyPointsKo: it.keyPointsKo,
        ja: { ...v.ja, sampleAnswer: it.sampleAnswer },
      };
    }
    case "respond": {
      const p = parts.respond;
      const qq = p?.questions[v.slot];
      if (!p || !qq) return v;
      return {
        ...v,
        available: true,
        intro: p.intro.ja,
        spokenIntro: v.slot === 0 ? p.intro.ja : null,
        question: qq.question.ja,
        sampleAnswer: qq.sampleAnswer.ja,
        tipKo: qq.tipKo,
        ja: { ...v.ja, intro: p.intro, question: qq.question, sampleAnswer: qq.sampleAnswer },
      };
    }
    case "info": {
      const p = parts.info;
      const qq = p?.questions[v.slot];
      if (!p || !qq) return v;
      return {
        ...v,
        available: true,
        table: toeicTable(p.table),
        spokenIntro: v.slot === 0 ? p.callerIntro.ja : null,
        question: qq.question.ja,
        sampleAnswer: qq.sampleAnswer.ja,
        tipKo: qq.tipKo,
        ja: { ...v.ja, intro: p.callerIntro, question: qq.question, sampleAnswer: qq.sampleAnswer, tableTitleKo: p.table.titleKo },
      };
    }
    case "opinion": {
      const p = parts.opinion;
      if (!p) return v;
      return {
        ...v,
        available: true,
        question: p.question.ja,
        sampleAnswer: p.sampleAnswer.ja,
        tipKo: p.tipKo,
        outlineKo: p.outlineKo,
        ja: { ...v.ja, question: p.question, sampleAnswer: p.sampleAnswer },
      };
    }
  }
}

export function buildJaSpeakingQuestionViews(parts: JaSpeakingParts, qs: readonly number[]): JaSpeakingQuestionView[] {
  return qs.map((q) => buildJaSpeakingQuestionView(parts, q));
}

/** 완전한 세트(다섯 파트 모두 있다) — 실전 응시 가능 */
export function isCompleteJaSpeakingMock(parts: JaSpeakingParts): boolean {
  return JA_SPEAKING_PARTS.every((p) => parts[p] !== null && parts[p] !== undefined);
}

/** 토큰 줄을 ja-ruby가 그리는 모양으로(타입만 다르다) */
export function jaLineTokens(line: JaLine | null): JaToken[] {
  return line ? line.tokens : [];
}

/** 응시 기록 요약(목록·학습 보기) */
export interface JaSpeakingAttemptSummary {
  id: string;
  scope: "full" | "part";
  parts: JaSpeakingPart[];
  questions: number[];
  startedAt: string;
  finishedAt: string | null;
  recordedCount: number;
  scoredCount: number;
}
export function summarizeJaSpeakingAttempt(a: JaSpeakingAttemptRecord): JaSpeakingAttemptSummary {
  return {
    id: a.id,
    scope: a.scope,
    parts: a.parts,
    questions: a.questions,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    recordedCount: a.answers.filter((x) => x.recorded).length,
    scoredCount: a.answers.filter((x) => x.score !== null).length,
  };
}

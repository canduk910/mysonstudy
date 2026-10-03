/**
 * lib/toeic-attempt-contract.ts — 아빠의 영어 **모의고사 응시·채점** 라우트의 요청·응답 계약 + 화면 순수 도우미
 * (docs/harness/toeic.md §5-0·§6-4·§7-5·§8, 로드맵 T4·T5)
 *
 * 라우트(서버)와 화면(클라이언트)이 같은 shape을 보게 하는 단일 정의처다 — qa-inspector가 라우트 응답 ↔ 프론트 기대 타입을
 * 교차 검증할 곳. 라우트는 응답 헬퍼 인자 타입으로 여기 타입을 건다.
 *
 * - `POST /api/toeic/mocks/[id]/attempts`  응시 시작 — 녹음 IndexedDB 키로 attemptId가 필요해 시작에 만든다(§7-5)
 * - `POST /api/toeic/attempts/[id]/finish`  끝/그만두기 — 문항별 recorded·durationMs(한 번만 받는다 — lib/toeic-attempt-rules)
 * - `POST /api/toeic/attempts/[id]/score`   AI 채점 한 문항(multipart: q, audio) — 관문 T 전사 + 호출 D / Q1–2 대조
 * - `PUT|GET|DELETE /api/toeic/attempts/[id]/recordings/[q]`  내 녹음 서버 보관 한 문항 올리기·내려받기(§13-4 — PIN 게이트 뒤 프록시)·지우기(§14-4)
 * - `PUT|GET|DELETE /api/toeic/attempts/[id]/recordings/[q]/fixes/[i]`  고칠 문장 다시 녹음 하나(§14-5)
 * - `DELETE /api/toeic/attempts/[id]/recordings`  응시 녹음 통째 지우기(§14-4 — 응시 기록·점수는 남는다)
 * - `POST /api/toeic/attempts/[id]/retakes`  문항 단위 다시 풀기 시작(§15-2) · `POST …/retakes/[rid]/finish` 끝·합치기(§15-5)
 * - `GET|DELETE /api/toeic/attempts/[id]/recordings/[q]/history/[rid]`  다시 풀기로 밀려난 예전 답의 녹음(§15-8)
 *
 * ── 클라이언트 번들 경계 ──────────────────────────────────────────────────────
 * `lib/ai/*`·`lib/store`는 **`import type` / `export type`만** 한다. 값은 런타임 의존이 0인 순수 모듈(`lib/toeic-mock.ts`·
 * `lib/toeic-mock-contract.ts`)에서만 가져온다. 여기 상한(업로드 크기·형식)은 라우트 검사와 화면 검사가 **같이 import**한다.
 */

import type {
  ToeicAnswer,
  ToeicAttemptScope,
  ToeicFeedback,
  ToeicInfoTable,
  ToeicMockParts,
  ToeicReadDiff,
  ToeicUsedExpression,
} from "./ai/toeic/schemas";
import type { ToeicAttemptRecord } from "./store";
import type { ToeicRecordingDeletion, ToeicStoredFixRecording, ToeicStoredRecording } from "./toeic-rec-rules";
import type { ToeicAnswerHistoryEntry, ToeicRetakeSession } from "./toeic-retake";
import type { ToeicAnswerDiag } from "./toeic-mic-health";
import { TOEIC_READ_KIND_KO, toeicMockPartLabelKo } from "./toeic-mock-contract";
import { TOEIC_MOCK_PART_NAME_KO, toeicPartQuestions, toeicQuestionFormat, type ToeicMockPart } from "./toeic-mock";

export type {
  ToeicAnswer,
  ToeicAttemptRecord,
  ToeicAttemptScope,
  ToeicFeedback,
  ToeicInfoTable,
  ToeicReadDiff,
  ToeicRecordingDeletion,
  ToeicStoredFixRecording,
  ToeicStoredRecording,
  ToeicAnswerHistoryEntry,
  ToeicRetakeSession,
  ToeicAnswerDiag,
};

type Issue = { path: string; message: string };

// ===========================================================================
// 업로드 상한·형식 (라우트 검사·화면 검사 공용 — 단일 정의)
// ===========================================================================

/**
 * 채점 업로드 한 파일의 상한(바이트). 16kHz mono 16-bit WAV 60초 ≈ 1.92MB라 여유가 있고, 정규화에 실패해 원본(iOS mp4·webm)을
 * 올려도 60초면 1MB 안팎이다. proxy 본문 버퍼 10MB·전사 API 25MB보다 한참 작게 둔다(§5-0, understand_toeic_audio §4-4).
 */
export const TOEIC_SCORE_AUDIO_MAX_BYTES = 4 * 1024 * 1024;

/** 받는 오디오 형식(기본 타입, 파라미터 제외) → 전사 API에 넘길 파일 이름. 전사 API는 확장자·바이트로 형식을 본다. */
export const TOEIC_SCORE_AUDIO_TYPES: Readonly<Record<string, string>> = {
  "audio/wav": "answer.wav",
  "audio/x-wav": "answer.wav",
  "audio/wave": "answer.wav",
  "audio/vnd.wave": "answer.wav",
  "audio/mp4": "answer.mp4",
  "audio/m4a": "answer.m4a",
  "audio/x-m4a": "answer.m4a",
  "audio/webm": "answer.webm",
};

/** `audio/webm;codecs=opus` → `audio/webm`(소문자·파라미터 제거). 빈 값은 "". */
export function toeicAudioBaseType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

/** 파일 이름 확장자 → 기본 타입(브라우저가 Blob 타입을 비워 보낼 때의 폴백) */
export function toeicAudioTypeFromName(name: string | null | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? "");
  switch (m?.[1]?.toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp4":
      return "audio/mp4";
    case "m4a":
      return "audio/m4a";
    case "webm":
      return "audio/webm";
    default:
      return "";
  }
}

/** 받는 형식인가(파라미터는 무시) */
export function isAcceptedToeicAudioType(type: string | null | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(TOEIC_SCORE_AUDIO_TYPES, toeicAudioBaseType(type));
}

/** 업로드·전사 파일 이름(형식에 맞는 확장자). 모르는 형식이면 null. */
export function toeicAudioFileName(type: string | null | undefined): string | null {
  const base = toeicAudioBaseType(type);
  return Object.prototype.hasOwnProperty.call(TOEIC_SCORE_AUDIO_TYPES, base) ? TOEIC_SCORE_AUDIO_TYPES[base] : null;
}

/** 결과 화면 "AI 채점 받기"의 동시 요청 수(§5-0 "동시 2개") */
export const TOEIC_SCORE_CONCURRENCY = 2;

/**
 * **개발 빌드 전용** 시간 배율(localStorage 키) — QA가 20분 시험을 빨리 돌리려고 준비·표 읽기·답변 시간을 곱한다(예: "0.05").
 * production 번들에서는 읽지 않는다(응시 화면이 `process.env.NODE_ENV === "production"`이면 1로 고정 — 컴파일 때 상수로 접힌다).
 * 질문 음성·비프 길이는 곱하지 않는다(실제 소리라서).
 */
export const TOEIC_DEBUG_TIMESCALE_KEY = "toeic-debug-timescale";

// ===========================================================================
// 주소·라벨
// ===========================================================================

/** 응시 결과 화면 주소(§8 `/toeic/attempts/[id]`) */
export function toeicAttemptHref(attemptId: string): string {
  return `/toeic/attempts/${encodeURIComponent(attemptId)}`;
}

/** 응시 범위 라벨 — "실전 응시" / "유형 연습 · Q5–7 듣고 답하기" */
export function toeicScopeLabelKo(scope: ToeicAttemptScope, parts: readonly ToeicMockPart[]): string {
  return scope === "full" ? "실전 응시" : `유형 연습 · ${parts.map(toeicMockPartLabelKo).join(" · ")}`;
}

/**
 * 한 문제 연습의 응시 범위 라벨(docs/harness/toeic.md §12-7-4) — "공략 연습 · Q3–4 사진 묘사", 문항이 파트의 일부면 " · Q3"을 덧붙인다.
 * 기존 "유형 연습 · …"은 두 문항을 푸는 것처럼 읽혀 연습에 쓰지 않는다. 응시·결과 페이지가 문서의 drillPart로 고른다.
 */
export function toeicDrillScopeLabelKo(part: ToeicMockPart, questions: readonly number[]): string {
  const base = `공략 연습 · ${toeicMockPartLabelKo(part)}`;
  const all = toeicPartQuestions(part);
  const qs = [...new Set(questions)].filter((q) => all.includes(q)).sort((a, b) => a - b);
  if (qs.length === 0 || qs.length === all.length) return base;
  return `${base} · ${qs.map((q) => `Q${q}`).join(" · ")}`;
}

// ===========================================================================
// 응시 시작 — `POST /api/toeic/mocks/[id]/attempts`
// ===========================================================================

export interface ToeicAttemptCreateRequest {
  scope: ToeicAttemptScope;
  /** 실전(full)은 다섯 파트 전부, 유형 연습(part)은 한 파트 */
  parts: ToeicMockPart[];
}

export type ToeicAttemptCreateResponse =
  | {
      ok: true;
      attemptId: string;
      scope: ToeicAttemptScope;
      /** 형식표 순서로 정리한 파트 */
      parts: ToeicMockPart[];
      /** 응시 범위의 문항 번호(형식표 순서) */
      questions: number[];
      startedAt: string;
    }
  | {
      ok: false;
      /** incomplete_mock: 실전인데 빠진 파트가 있다 · part_missing: 유형 연습 파트가 비었다 */
      error: "invalid_input" | "mock_not_found" | "incomplete_mock" | "part_missing" | "save_failed";
      messageKo: string;
      issues?: Issue[];
    };

// ===========================================================================
// 끝/그만두기 — `POST /api/toeic/attempts/[id]/finish`
// ===========================================================================

export interface ToeicAttemptFinishRequest {
  /** 끝까지 마친 시각(ISO). 중간에 그만뒀으면 null(§7-5) */
  finishedAt: string | null;
  /** 응시 범위의 문항별 녹음 결과. 빠진 문항은 서버가 recorded:false로 채운다. diag = 문항별 진단(§15-11, 선택 — 옛 화면은 없다) */
  answers: { q: number; recorded: boolean; durationMs: number | null; diag?: ToeicAnswerDiag | null }[];
}

export type ToeicAttemptFinishResponse =
  | { ok: true; id: string; finishedAt: string | null; recordedCount: number; answers: ToeicAnswer[] }
  | {
      ok: false;
      /**
       * already_finished: 이미 닫힌 응시(끝/그만두기는 한 번만 — lib/toeic-attempt-rules decideAttemptFinish).
       * 화면은 이것을 **성공으로** 본다(첫 요청이 이미 저장됐다) — recordedCount는 저장된 값.
       */
      error: "invalid_input" | "attempt_not_found" | "already_finished" | "save_failed";
      messageKo: string;
      issues?: Issue[];
      recordedCount?: number;
    };

// ===========================================================================
// AI 채점 — `POST /api/toeic/attempts/[id]/score` (multipart: q, audio)
// ===========================================================================

/** multipart 필드 이름(라우트·화면 공용) */
export const TOEIC_SCORE_FIELD_Q = "q";
export const TOEIC_SCORE_FIELD_AUDIO = "audio";

export type ToeicScoreResponse =
  | {
      ok: true;
      q: number;
      /** 저장된 그 문항 — 화면은 이것으로 바꿔 끼운다 */
      answer: ToeicAnswer;
      /** 이미 채점돼 있어 그대로 돌려줬다(AI 호출 0) */
      reused: boolean;
      /** 전사문 출처 — new: 방금 전사 · stored: 앞선 시도에서 저장된 전사문(호출 D만 다시) · reused: 채점 결과 그대로 */
      transcriptSource: "new" | "stored" | "reused";
      /** 전사문 단어 2개 미만 — 호출 D 없이 0점(§5-0 3) */
      noResponse: boolean;
    }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "audio_too_large"
        | "attempt_not_found"
        | "question_not_found"
        /** 아직 닫히지 않은 응시(끝/그만두기 전) */
        | "not_finished"
        /** 녹음되지 않은 문항 */
        | "not_recorded"
        | "no_api_key"
        /** 전사 실패 — 아무것도 저장하지 않았다 */
        | "transcribe_failed"
        /** 피드백(호출 D) 실패 — 전사문은 저장됐다(answer에 실림). 다시 누르면 전사 없이 호출 D만 한다 */
        | "ai_failed"
        | "save_failed"
        | "client_closed"
        /** 채점하는 사이 그 문항을 다시 풀어 답이 바뀌었다(§15-6) — 화면을 새로 고친다 */
        | "answer_changed";
      messageKo: string;
      retriable?: boolean;
      /** ai_failed면 전사문까지 저장된 그 문항 */
      answer?: ToeicAnswer | null;
    };

// ===========================================================================
// 문항 화면 자료 — 응시·결과 화면이 같이 쓴다(모의고사 레코드 → 문항별로 펼친 모양)
// ===========================================================================

export interface ToeicQuestionView {
  q: number;
  part: ToeicMockPart;
  slot: number;
  /** "지문 읽기" */
  partNameKo: string;
  /** "Q1–2 지문 읽기" */
  partLabelKo: string;
  prepSec: number;
  answerSec: number;
  readingSec: number;
  questionPlays: number;
  maxScore: 3 | 5;
  /** 실전 화면에 질문 글을 보이는가(Q8–10은 표만) */
  showQuestionText: boolean;
  /** 파트 첫 문항(지시문 단계가 있다) */
  directions: boolean;
  /** 첫 재생 앞에 읽는 도입(Q5 상황 소개 · Q8 전화 건 사람). 없으면 null */
  spokenIntro: string | null;
  /** 그 파트·문항이 모의고사에 있는가(없으면 화면이 "자료 없음") */
  available: boolean;
  /** Q1–2 지문 */
  passage: string | null;
  /** Q1–2 지문 종류(한국어) */
  passageKindKo: string | null;
  /** Q3–4 사진 — imageId가 없으면 장면 설명으로 대신한다 */
  picture: { sceneKo: string; imageId: string | null; place: string } | null;
  /** Q5–7 상황 소개(화면) */
  intro: string | null;
  /** Q8–10 표 */
  table: ToeicInfoTable | null;
  /** Q5–11 질문 */
  question: string | null;
  /** Q3–11 모범답변(참고용) */
  sampleAnswer: string | null;
  usedExpressions: ToeicUsedExpression[];
  tipKo: string | null;
  keyPointsKo: string[];
  outlineKo: string[];
}

function emptyView(q: number): ToeicQuestionView {
  const f = toeicQuestionFormat(q);
  return {
    q,
    part: f.part,
    slot: f.slot,
    partNameKo: TOEIC_MOCK_PART_NAME_KO[f.part],
    partLabelKo: toeicMockPartLabelKo(f.part),
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
  };
}

/**
 * 모의고사 파트 → 문항 하나의 화면 자료. 숫자(시간·만점·재생 횟수)는 형식표에서 읽는다(이중 정의 없음).
 * 자료가 없으면 available:false(파트가 null이거나 칸이 없다 — 손으로 넣은 문서 방어).
 */
export function buildToeicQuestionView(parts: ToeicMockParts, q: number): ToeicQuestionView {
  const v = emptyView(q);
  switch (v.part) {
    case "read": {
      const it = parts.read?.items[v.slot];
      if (!it) return v;
      return { ...v, available: true, passage: it.text, passageKindKo: TOEIC_READ_KIND_KO[it.kind] ?? it.kind };
    }
    case "picture": {
      const it = parts.picture?.items[v.slot];
      if (!it) return v;
      const imageId = it.image.status === "ready" && it.image.imageId ? it.image.imageId : null;
      return {
        ...v,
        available: true,
        picture: { sceneKo: it.sceneKo, imageId, place: it.place },
        sampleAnswer: it.sampleAnswer,
        usedExpressions: it.usedExpressions,
        keyPointsKo: it.keyPointsKo,
      };
    }
    case "respond": {
      const p = parts.respond;
      const qq = p?.questions[v.slot];
      if (!p || !qq) return v;
      return {
        ...v,
        available: true,
        intro: p.intro,
        spokenIntro: v.slot === 0 ? p.intro : null,
        question: qq.question,
        sampleAnswer: qq.sampleAnswer,
        usedExpressions: qq.usedExpressions,
        tipKo: qq.tipKo,
      };
    }
    case "info": {
      const p = parts.info;
      const qq = p?.questions[v.slot];
      if (!p || !qq) return v;
      return {
        ...v,
        available: true,
        table: p.table,
        spokenIntro: v.slot === 0 ? p.callerIntro : null,
        question: qq.question,
        sampleAnswer: qq.sampleAnswer,
        usedExpressions: qq.usedExpressions,
        tipKo: qq.tipKo,
      };
    }
    case "opinion": {
      const p = parts.opinion;
      if (!p) return v;
      return {
        ...v,
        available: true,
        question: p.question,
        sampleAnswer: p.sampleAnswer,
        usedExpressions: p.usedExpressions,
        tipKo: p.tipKo,
        outlineKo: p.outlineKo,
      };
    }
  }
}

/** 응시 범위의 문항들 → 화면 자료(순서 그대로) */
export function buildToeicQuestionViews(parts: ToeicMockParts, qs: readonly number[]): ToeicQuestionView[] {
  return qs.map((q) => buildToeicQuestionView(parts, q));
}

// ===========================================================================
// 내 녹음 서버 보관 — `PUT`·`GET /api/toeic/attempts/[id]/recordings/[q]` (docs/harness/toeic.md §13-2·§13-4·§13-5)
// ===========================================================================

/**
 * 보관 업로드가 받는 형식(기본 타입, 파라미터 무시) → 바이트 판정 계열(대표 타입). 채점 업로드의 TOEIC_SCORE_AUDIO_TYPES와 **별도 상수**다 —
 * 보관은 Firefox 녹음(ogg)도 받는다(채점은 WAV 정규화를 거친다). WAV는 장래 대비(지금 녹음기는 내지 않는다).
 * 저장하는 contentType은 선언이 아니라 **바이트로 판정한 계열**(sniffToeicAudioType)이다.
 */
export const TOEIC_REC_STORE_TYPES: Readonly<Record<string, "audio/mp4" | "audio/webm" | "audio/ogg" | "audio/wav">> = {
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
};

/** multipart 필드 이름(라우트·대기열 공용 — 단일 정의) */
export const TOEIC_REC_FIELD_AUDIO = "audio";
export const TOEIC_REC_FIELD_DURATION_MS = "durationMs";
/** 기기에서 녹음이 끝난 시각(epoch ms 정수) — 같은 문항 녹음끼리 어느 쪽이 새것인지 가를 때만 쓴다 */
export const TOEIC_REC_FIELD_RECORDED_AT = "recordedAt";
/** 그 녹음을 만든 다시 풀기 id(§15-4 — 선택, 없으면 처음 응시의 녹음) */
export const TOEIC_REC_FIELD_RETAKE_ID = "retakeId";
/** 고칠 문장 녹음이 기댄 답의 세대(§15-6 — 선택, 처음 응시는 빈 문자열) */
export const TOEIC_REC_FIELD_ANSWER_SOURCE = "answerSource";

/**
 * 녹음 한 문항 주소 — 마지막 조각에 **점이 없다**(proxy.ts 정적 확장자 예외를 피한다, §13-4).
 * `fixIndex`를 주면 그 문항의 고칠 문장 다시 녹음 하나(§14-5 — `…/recordings/{q}/fixes/{i}`).
 */
export function toeicRecordingHref(attemptId: string, q: number, fixIndex?: number): string {
  const base = `/api/toeic/attempts/${encodeURIComponent(attemptId)}/recordings/${Math.trunc(q)}`;
  return fixIndex === undefined ? base : `${base}/fixes/${Math.trunc(fixIndex)}`;
}

/** 응시 녹음 통째 지우기 주소(§14-4) */
export function toeicAttemptRecordingsHref(attemptId: string): string {
  return `/api/toeic/attempts/${encodeURIComponent(attemptId)}/recordings`;
}

/** 예전 답(다시 풀기로 밀려난 답) 녹음 주소(§15-8) — `…/recordings/{q}/history/{rid}`(점 없음) */
export function toeicRecordingHistoryHref(attemptId: string, q: number, replacedBy: string): string {
  return `/api/toeic/attempts/${encodeURIComponent(attemptId)}/recordings/${Math.trunc(q)}/history/${encodeURIComponent(replacedBy)}`;
}

/** `PUT` 응답(§13-4·§15-4) */
export type ToeicRecordingPutResponse =
  | {
      ok: true;
      q: number;
      /** stored: 새로 저장 · reused: 같은 바이트가 이미 있음 · superseded: 이미 더 새 녹음이 있음(recording이 그 메타) */
      outcome: "stored" | "reused" | "superseded";
      /** 그 녹음의 자리 — 지금 답(current) · 다시 풀기 대기 자리(staged) · 예전 답 이력(history). 결과 화면은 current만 지금 메타로 쓴다 */
      slot: "current" | "staged" | "history";
      recording: ToeicStoredRecording;
    }
  | {
      ok: true;
      q: number;
      /** 그 문항은 다시 풀기로 바뀌었고 이 녹음이 들어갈 자리가 없다 — 저장하지 않았다(기기는 done — 캐시로만) */
      outcome: "retaken";
      slot: null;
      recording: null;
    }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "audio_too_large"
        | "attempt_not_found"
        | "question_not_found"
        | "retake_not_found"
        | "recording_locked"
        | "recording_deleted"
        | "storage_failed"
        | "save_failed";
      messageKo: string;
      retriable?: boolean;
    };

/** `GET` 오류 응답(200은 오디오 바이트) */
export interface ToeicRecordingGetErrorResponse {
  ok: false;
  error: "attempt_not_found" | "recording_not_found" | "recording_missing" | "storage_failed";
  messageKo: string;
  retriable?: boolean;
}

// ===========================================================================
// 녹음 관리 · 고칠 문장 다시 녹음 (2026-10-03, docs/harness/toeic.md §14)
// ===========================================================================

/** `PUT …/recordings/[q]/fixes/[i]` 응답(§14-5) — multipart 필드 이름은 답변 녹음과 같다(TOEIC_REC_FIELD_*) */
export type ToeicFixRecordingPutResponse =
  | {
      ok: true;
      q: number;
      fixIndex: number;
      /** stored: 새로 저장(옛 녹음은 바꿔 꼈다) · reused: 같은 바이트 · superseded: 이미 더 새 녹음이 있음(recording이 그 메타) */
      outcome: "stored" | "reused" | "superseded";
      recording: ToeicStoredFixRecording;
    }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "audio_too_large"
        | "attempt_not_found"
        | "question_not_found"
        | "fix_not_found"
        | "recording_deleted"
        /** 그 답을 다시 풀어 피드백이 바뀌었다(§15-6 — 예전 피드백 자리의 녹음을 새 피드백에 붙이지 않는다) */
        | "answer_changed"
        | "storage_failed"
        | "save_failed";
      messageKo: string;
      retriable?: boolean;
    };

/** 녹음 지우기 응답(§14-4) — 답변 한 문항 · 고칠 문장 하나 · 응시 통째 모두 같은 모양. 응시의 녹음 메타 세 필드를 새 값으로 돌려준다 */
export type ToeicRecordingDeleteResponse =
  | {
      ok: true;
      /** deleted: 메타를 뺐다 · absent: 서버 메타가 없었다(기기에만 있던 녹음 — 지운 자리만 남겼다) */
      outcome: "deleted" | "absent";
      /** 보관소에서 지운 객체 수(대체된 옛 객체 포함) */
      removedObjects: number;
      recordings: ToeicStoredRecording[];
      fixRecordings: ToeicStoredFixRecording[];
      recordingDeletions: ToeicRecordingDeletion[];
      /** 예전 답 이력(§15-8 — 예전 답 녹음을 지우면 그 줄의 녹음 메타가 비워진다) */
      answerHistory: ToeicAnswerHistoryEntry[];
    }
  | {
      ok: false;
      error: "invalid_input" | "attempt_not_found" | "question_not_found" | "history_not_found" | "prod_guard" | "delete_failed";
      messageKo: string;
      retriable?: boolean;
    };

/** 예전 답 녹음 `GET` 오류(200은 오디오 바이트) */
export interface ToeicHistoryRecordingGetErrorResponse {
  ok: false;
  error: "attempt_not_found" | "history_not_found" | "recording_not_found" | "recording_missing" | "storage_failed";
  messageKo: string;
  retriable?: boolean;
}

// ===========================================================================
// 문항 단위 다시 풀기 (2026-10-03, docs/harness/toeic.md §15)
// ===========================================================================

/** 다시 풀기 시작·끝 주소 */
export function toeicRetakesHref(attemptId: string): string {
  return `/api/toeic/attempts/${encodeURIComponent(attemptId)}/retakes`;
}
export function toeicRetakeFinishHref(attemptId: string, retakeId: string): string {
  return `${toeicRetakesHref(attemptId)}/${encodeURIComponent(retakeId)}/finish`;
}

/** `POST …/retakes` 본문 */
export interface ToeicRetakeStartRequest {
  questions: number[];
  /** 진행 중인 다른 다시 풀기를 닫고 시작한다(그 id) — 409 retake_in_progress 뒤 사용자가 고를 때만 */
  replaceOpen?: string | null;
}

/** `POST …/retakes` 응답(§15-2) */
export type ToeicRetakeStartResponse =
  | { ok: true; retakeId: string; questions: number[]; startedAt: string }
  | {
      ok: false;
      error: "invalid_input" | "attempt_not_found" | "question_not_found" | "not_finished" | "retake_in_progress" | "history_full" | "save_failed";
      messageKo: string;
      issues?: Issue[];
      retriable?: boolean;
      /** retake_in_progress면 진행 중인 다시 풀기 */
      openRetake?: { id: string; startedAt: string; questions: number[] };
      /** history_full이면 이력이 가득 찬 문항 */
      questions?: number[];
    };

/** `POST …/retakes/[rid]/finish` 본문 — 끝내기와 같은 모양(§15-5) */
export type ToeicRetakeFinishRequest = ToeicAttemptFinishRequest;

/** `POST …/retakes/[rid]/finish` 응답(§15-5) */
export type ToeicRetakeFinishResponse =
  | { ok: true; retakeId: string; merged: number[]; recordedCount: number; answers: ToeicAnswer[] }
  | {
      ok: false;
      /** already_finished: 이미 닫힌 다시 풀기(한 번만) — 오류로 멈추지 않지만 이 기기 녹음이 합쳐졌다는 뜻은 아니다: 끝 화면은 `merged`(저장된 값)로 합친·못 합친 문항을 가른다(§15-5) */
      error: "invalid_input" | "attempt_not_found" | "retake_not_found" | "already_finished" | "save_failed";
      messageKo: string;
      issues?: Issue[];
      merged?: number[];
      recordedCount?: number;
    };

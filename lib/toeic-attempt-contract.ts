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
import { TOEIC_READ_KIND_KO, toeicMockPartLabelKo } from "./toeic-mock-contract";
import { TOEIC_MOCK_PART_NAME_KO, toeicQuestionFormat, type ToeicMockPart } from "./toeic-mock";

export type { ToeicAnswer, ToeicAttemptRecord, ToeicAttemptScope, ToeicFeedback, ToeicInfoTable, ToeicReadDiff };

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
  /** 응시 범위의 문항별 녹음 결과. 빠진 문항은 서버가 recorded:false로 채운다 */
  answers: { q: number; recorded: boolean; durationMs: number | null }[];
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
        | "client_closed";
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

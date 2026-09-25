/**
 * lib/toeic-set-contract.ts — 아빠의 영어 **표현집** 라우트의 요청·응답 계약 (docs/harness/toeic.md §2·§3·§7·§8)
 *
 * 라우트(서버)와 화면(클라이언트)이 같은 shape을 보게 하는 단일 정의처다. qa-inspector가 라우트 응답 shape ↔ 프론트
 * 기대 타입을 교차 검증할 곳.
 *
 * ── 클라이언트 번들 경계 ──────────────────────────────────────────────────────
 * `lib/ai/*`·`lib/store`는 **`import type` / `export type`만** 한다(isolatedModules로 컴파일 때 지워져 런타임 import가 없다
 * — zod·openai·node:fs가 폰 번들로 새지 않는다). 값은 런타임 의존이 0인 순수 모듈(`lib/toeic-mock.ts`)에서만 가져온다.
 * 상한 숫자(TOEIC_SET_TITLE_MAX 등)는 lib/ai/toeic/schemas가 단일 정의처라, 화면이 필요하면 **서버 페이지가 props로**
 * 내린다(`ToeicSetEditLimits`) — 여기 숫자를 다시 적지 않는다(일본어 계약과 같은 방침).
 */

import type {
  ToeicBookQuiz,
  ToeicConfidence,
  ToeicEnKo,
  ToeicExprEntry,
  ToeicPart,
  ToeicSpeakingPoints,
  ToeicUseIn,
} from "./ai/toeic/schemas";
import type { ToeicSetDraft } from "./ai/toeic/extract-merge";
import type { ToeicSetRecord } from "./store";
import { TOEIC_MOCK_PARTS, TOEIC_MOCK_PART_NAME_KO, TOEIC_MOCK_PART_TO_TOEIC_PART } from "./toeic-mock";

export type { ToeicBookQuiz, ToeicConfidence, ToeicEnKo, ToeicExprEntry, ToeicPart, ToeicSpeakingPoints, ToeicUseIn };
export type { ToeicSetDraft, ToeicSetRecord };

/** 발화 포인트 문항 축 배지(§3-0 useIn) — "Q3–4 사진 묘사". 파트 이름은 lib/toeic-mock의 단일 정의에서 만든다. */
export const TOEIC_PART_BADGE_KO: Record<ToeicPart, string> = Object.fromEntries(
  TOEIC_MOCK_PARTS.map((p) => {
    const tp = TOEIC_MOCK_PART_TO_TOEIC_PART[p];
    const range = tp.slice(1).replace("_", "–"); // q3_4 → 3–4, q11 → 11
    return [tp, `Q${range} ${TOEIC_MOCK_PART_NAME_KO[p]}`];
  }),
) as Record<ToeicPart, string>;

/** 화면 입력 상한 — 서버 페이지가 lib/ai/toeic/schemas의 상수로 채워 props로 내린다(숫자 이중 정의 금지). */
export interface ToeicSetEditLimits {
  photos: number;
  title: number;
  expression: number;
  meaningKo: number;
  example: number;
  hint: number;
  entriesMax: number;
  quizMax: number;
}

type Issue = { path: string; message: string };

// ===========================================================================
// 400 issues 경로 → 한국어 위치 ("sets.2.entries.5.meaningKo" → "세트 3 › 표현 6 › 뜻")
// ===========================================================================

/** 배열 필드(뒤에 번호가 오는 칸) — 번호는 1부터 보인다 */
const ISSUE_COLLECTION_KO: Record<string, string> = {
  sets: "세트",
  entries: "표현",
  quiz: "QUIZ",
  useIn: "활용 문장",
  frames: "답변 틀",
  variations: "바꿔 쓰기",
  keyExpressions: "굵은 표현",
  images: "사진",
  items: "문항",
  orderedIds: "순서",
};

/** 값 필드 */
const ISSUE_FIELD_KO: Record<string, string> = {
  format: "파일 형식",
  presetKey: "가져오기 키",
  titleKo: "이름",
  dayNo: "DAY 번호",
  topicKo: "주제",
  no: "번호",
  expression: "영어 표현",
  meaningKo: "뜻",
  example: "예문",
  exampleKo: "예문 해석",
  confidence: "판독 확신도",
  partial: "잘림 표시",
  points: "발화 포인트",
  exampleSpan: "예문 속 구간",
  coreKo: "핵심 한 줄",
  part: "문항 종류",
  sentence: "문장",
  sentenceKo: "해석",
  en: "영어",
  ko: "우리말",
  pronunciationKo: "발음 팁",
  pitfallKo: "흔한 실수",
  grammarKo: "문법",
  followUp: "이어 말하기",
  promptKo: "우리말 문장",
  hint: "힌트",
  modelAnswer: "모범답변",
  photoCount: "사진 수",
  model: "모델",
  mode: "시험 방식",
  startedAt: "시작 시각",
  finishedAt: "끝난 시각",
  word: "항목",
  correct: "정답 여부",
  answered: "답 여부",
  force: "다시 만들기",
};

/**
 * 400 `issues[].path`(점 표기)를 사람이 읽을 위치로 — 화면이 "entries.3.expression: …"를 그대로 보이지 않게.
 * `indexLabel`을 주면 배열 번호를 화면 쪽 이름으로 바꾼다(검토 화면: 뺀 항목을 건너뛴 저장 요청의 번호 → 교재 번호).
 * 모르는 조각은 그대로 둔다. 빈 경로(본문 전체)는 빈 문자열.
 */
export function toeicIssueWhereKo(path: string, indexLabel?: (collection: string, index: number) => string | null): string {
  if (path === "") return "";
  const segs = path.split(".");
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    const col = ISSUE_COLLECTION_KO[seg];
    if (col !== undefined && next !== undefined && /^\d+$/.test(next)) {
      const n = Number(next);
      out.push(indexLabel?.(seg, n) ?? `${col} ${n + 1}`);
      i += 1;
      continue;
    }
    out.push(col ?? ISSUE_FIELD_KO[seg] ?? seg);
  }
  return out.join(" › ");
}

/** 400 issue 한 줄 — "세트 3 › 표현 6 › 뜻: 뜻은 한국어로 적어 주세요" (위치가 없으면 문구만) */
export function toeicIssueLineKo(issue: Issue, indexLabel?: (collection: string, index: number) => string | null): string {
  const where = toeicIssueWhereKo(issue.path, indexLabel);
  return where ? `${where}: ${issue.message}` : issue.message;
}

// ===========================================================================
// 판독 — `POST /api/toeic/sets/extract` (호출 A, 사진별 병렬, 저장 없음)
// ===========================================================================

export interface ToeicExtractRequest {
  /** base64 data URL(image/jpeg 등) 1~8장 — 형식·길이는 lib/upload-limits.ts */
  images: string[];
}

/** 사진 한 장의 판독 결과 요약(사진 번호는 0부터, 고른 순서) */
export interface ToeicExtractPhotoOutcome {
  photoIndex: number;
  /** 재요청까지 실패(throw)했으면 false */
  ok: boolean;
  /** 표현 암기장 페이지로 판독됐는가(ok=false면 false) */
  isExpressionPage: boolean;
  entryCount: number;
  quizCount: number;
}

export type ToeicExtractResponse =
  | {
      ok: true;
      /** DAY별 초안(저장 안 됨) — 검토 화면이 고친 뒤 POST /api/toeic/sets로 하나씩 저장 */
      drafts: ToeicSetDraft[];
      photoCount: number;
      /** 재요청까지 실패한 사진 수 */
      failedPhotoCount: number;
      /** 표현 암기장이 아니라고 판독된 사진 수 */
      notExpressionPhotoCount: number;
      pages: ToeicExtractPhotoOutcome[];
      /** 판독 모델 — 저장 요청에 실어 record.model로 굳힌다 */
      model: string;
    }
  /** 판독 실패는 정상 흐름 — 읽을 표현이 하나도 없다(200) */
  | { ok: false; reason: "retake"; messageKo: string }
  | {
      ok: false;
      error: "invalid_input" | "no_api_key" | "ai_failed";
      messageKo: string;
      /** ai_failed(전 사진 실패)면 true — "다시 읽기" */
      retriable?: boolean;
      issues?: Issue[];
    };

// ===========================================================================
// 저장 — `POST /api/toeic/sets` (검토한 초안 하나 = 세트 하나, AI 없음)
// ===========================================================================

/** 저장할 표현 항목 — 발화 포인트는 저장 뒤 호출 B가 채운다(points는 보내지 않는다) */
export interface ToeicSetSaveEntry {
  no: number | null;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  confidence: ToeicConfidence;
  partial: boolean;
}

export interface ToeicSetSaveRequest {
  /** 빈 문자열이면 서버가 "DAY {n} {topicKo}" 기본 제목을 붙인다 */
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  entries: ToeicSetSaveEntry[];
  quiz: ToeicBookQuiz[];
  photoCount: number;
  model: string | null;
}

export type ToeicSetSaveResponse =
  | {
      ok: true;
      id: string;
      /** 저장 세트의 표현과 대응이 안 돼 버린 QUIZ keyExpressions 수(표현을 고치거나 뺀 경우) */
      droppedKeyExpressions: number;
    }
  | { ok: false; error: "invalid_input" | "save_failed"; messageKo: string; issues?: Issue[] };

// ===========================================================================
// 파일로 가져오기 — `POST /api/toeic/sets/import` (§7-6, presetKey 멱등)
// ===========================================================================

/** 요청 본문 = 가져오기 파일 JSON 그대로(`{ format: "toeic-sets/v1", sets: [...] }`) */
export type ToeicImportResponse =
  | {
      ok: true;
      /** 새로 만든 세트 수 */
      created: number;
      /** 같은 presetKey가 이미 있어 건너뛴 세트 수 */
      skipped: number;
      createdIds: string[];
    }
  | { ok: false; error: "invalid_input" | "save_failed"; messageKo: string; issues?: Issue[] };

// ===========================================================================
// 발화 포인트 — `POST /api/toeic/sets/[id]/points` (호출 B, 7개 묶음 병렬, 부분 성공)
// ===========================================================================

export interface ToeicPointsRequest {
  /** true면 이미 있는 포인트도 다시 만든다("다시 만들기"). 기본(false)은 빈 자리만 */
  force: boolean;
}

export type ToeicPointsResponse =
  | {
      ok: true;
      /** 이번에 채운(force면 갈아 끼운) 표현 수 */
      filled: number;
      /** 대상이었지만 못 채운 표현 수 — 실패한 묶음(화면이 "N개는 다시 만들기"를 알린다) */
      remaining: number;
      /** 세트 전부 포인트가 있는가 */
      enriched: boolean;
      /** 실패한 묶음 수 / 전체 묶음 수 */
      failedChunks: number;
      totalChunks: number;
      /** 채울 것이 없어 호출하지 않았다(기본 모드에서 이미 전부 있음) */
      nothingToFill: boolean;
    }
  | {
      ok: false;
      error: "invalid_input" | "set_not_found" | "no_api_key" | "points_failed" | "save_failed";
      messageKo: string;
      issues?: Issue[];
    };

// ===========================================================================
// 이름 수정 · 삭제
// ===========================================================================

export type ToeicSetRenameResponse =
  | { ok: true; id: string; titleKo: string }
  | { ok: false; error: "invalid_input" | "set_not_found" | "save_failed"; messageKo: string; issues?: Issue[] };

export type ToeicSetDeleteResponse =
  | { ok: true }
  | { ok: false; error: "set_not_found" | "delete_failed" | "prod_guard"; messageKo: string };

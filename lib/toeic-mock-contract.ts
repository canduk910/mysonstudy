/**
 * lib/toeic-mock-contract.ts — 아빠의 영어 **모의고사** 라우트의 요청·응답 계약 + 화면 순수 도우미
 * (docs/harness/toeic.md §4-0·§4-10·§7-2·§7-4·§8)
 *
 * 라우트(서버)와 화면(클라이언트)이 같은 shape을 보게 하는 단일 정의처다 — qa-inspector가 라우트 응답 ↔ 프론트 기대 타입을
 * 교차 검증할 곳. 라우트는 응답 헬퍼 인자 타입으로 여기 타입을 건다.
 *
 * ── 클라이언트 번들 경계 ──────────────────────────────────────────────────────
 * `lib/ai/*`·`lib/store`는 **`import type` / `export type`만** 한다(컴파일 때 지워진다 — zod·openai·node:fs가 폰 번들로 새지
 * 않는다). 값은 런타임 의존이 0인 순수 모듈(`lib/toeic-mock.ts`)에서만 가져온다. 여기 정의한 상한(주제 힌트·제목)은 AI 호출
 * 규칙이 아니라 **요청·입력 칸의 상한**이라 이 파일이 단일 정의처다(라우트 zod와 화면 maxLength가 같이 import).
 */

import type {
  ToeicInfoKind,
  ToeicInfoPart,
  ToeicMockParts,
  ToeicMockQuestion,
  ToeicOpinionKind,
  ToeicOpinionPart,
  ToeicPictureImage,
  ToeicPictureItem,
  ToeicPicturePart,
  ToeicReadItem,
  ToeicReadKind,
  ToeicReadPart,
  ToeicRespondPart,
  ToeicUsedExpression,
} from "./ai/toeic/schemas";
import type { ToeicAttemptRecord, ToeicMockRecord } from "./store";
import {
  TOEIC_MOCK_FORMAT,
  TOEIC_MOCK_PARTS,
  TOEIC_MOCK_PART_NAME_KO,
  defaultToeicMockTitle,
  type ToeicMockPart,
  type ToeicTargetGrade,
} from "./toeic-mock";

export type {
  ToeicAttemptRecord,
  ToeicInfoPart,
  ToeicMockParts,
  ToeicMockPart,
  ToeicMockQuestion,
  ToeicMockRecord,
  ToeicOpinionPart,
  ToeicPictureImage,
  ToeicPictureItem,
  ToeicPicturePart,
  ToeicReadItem,
  ToeicReadPart,
  ToeicRespondPart,
  ToeicTargetGrade,
  ToeicUsedExpression,
};

type Issue = { path: string; message: string };

// ===========================================================================
// 입력 상한 (요청 zod·화면 maxLength 공용 — 단일 정의)
// ===========================================================================

/** 주제 힌트 최대 개수 — 호출 C 사용자 메시지 "주제 힌트:" 한 줄이 과해지지 않게 */
export const TOEIC_MOCK_TOPIC_HINTS_MAX = 8;
/** 주제 힌트 한 개 길이 상한(자) */
export const TOEIC_MOCK_TOPIC_HINT_MAX_CHARS = 40;
/** 모의고사 이름 길이 상한(자) — 표현집 이름과 같은 폭 */
export const TOEIC_MOCK_TITLE_MAX = 120;

// ===========================================================================
// 화면 라벨 (한국어) — 파트·종류 이름의 단일 정의
// ===========================================================================

/** "Q1–2 지문 읽기" — 형식표에서 문항 범위를 계산한다(숫자 이중 정의 없음) */
export function toeicMockPartLabelKo(part: ToeicMockPart): string {
  const qs = TOEIC_MOCK_FORMAT.filter((f) => f.part === part).map((f) => f.q);
  const range = qs.length > 1 ? `Q${qs[0]}–${qs[qs.length - 1]}` : `Q${qs[0]}`;
  return `${range} ${TOEIC_MOCK_PART_NAME_KO[part]}`;
}

/** 목표 등급 설명(§0-2 — 모범답변의 길이·수준이 달라진다) */
export const TOEIC_TARGET_GRADE_DESC_KO: Record<ToeicTargetGrade, string> = {
  IM3: "짧고 분명한 문장",
  IH: "기본 — 이유·예시까지",
  AL: "길고 다양한 연결",
};

export const TOEIC_READ_KIND_KO: Record<ToeicReadKind, string> = {
  advertisement: "광고",
  announcement: "안내방송",
  news: "뉴스·소식",
  introduction: "소개",
  tour: "투어 안내",
  voicemail: "자동 응답 메시지",
};

export const TOEIC_INFO_KIND_KO: Record<ToeicInfoKind, string> = {
  schedule: "행사 일정",
  itinerary: "출장·여행 일정",
  timetable: "시간표",
  interview: "면접 일정",
  resume: "이력서",
};

export const TOEIC_OPINION_KIND_KO: Record<ToeicOpinionKind, string> = {
  agree: "찬반",
  choice: "둘 중 선택",
  proscons: "장단점",
};

// ===========================================================================
// 화면 순수 도우미
// ===========================================================================

/** 생성 사진 주소 — `GET /api/toeic/images/[id]`(PIN 게이트 안). 확장자를 붙이지 않는다(proxy 정적 파일 예외에 걸리면 잠금을 우회한다). */
export function toeicImageUrl(imageId: string): string {
  return `/api/toeic/images/${encodeURIComponent(imageId)}`;
}

/** 응시 화면 주소(§8 `/toeic/mocks/[id]/take`) — 실전은 scope=full, 유형 연습은 scope=part&part=<part> */
export function toeicTakeHref(mockId: string, scope: "full" | "part", part?: ToeicMockPart): string {
  const base = `/toeic/mocks/${encodeURIComponent(mockId)}/take`;
  return scope === "full" || !part ? `${base}?scope=full` : `${base}?scope=part&part=${part}`;
}

/** 비어 있는(실패·미선택) 파트 — 형식표 순서 */
export function missingToeicMockParts(parts: ToeicMockParts): ToeicMockPart[] {
  return TOEIC_MOCK_PARTS.filter((p) => parts[p] === null || parts[p] === undefined);
}

/**
 * 새 모의고사 기본 이름의 번호 — "모의고사 {n}"(§7-2). 지운 뒤 만들어도 이름이 겹치지 않게 **지금 개수와 기존 "모의고사 N"의
 * 최대 N 중 큰 값 + 1**.
 */
export function nextToeicMockTitle(existingTitles: readonly string[]): string {
  let max = existingTitles.length;
  const prefix = defaultToeicMockTitle(0).replace(/0$/, ""); // "모의고사 "
  for (const t of existingTitles) {
    if (!t.startsWith(prefix)) continue;
    const rest = t.slice(prefix.length);
    if (/^\d{1,6}$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return defaultToeicMockTitle(max + 1);
}

/** 하이라이트 조각 — `mark`면 강조(활용한 표현 구간·강세 단어) */
export interface ToeicTextSegment {
  text: string;
  mark: boolean;
  /** 활용한 표현이면 원래 표현(목록의 문자열) — 강조 칸의 title */
  expression: string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 겹치지 않는 [start, end) 구간들로 조각을 만든다(앞에서부터, 겹치면 먼저 시작한 구간이 이긴다) */
function toSegments(text: string, ranges: { start: number; end: number; expression: string | null }[]): ToeicTextSegment[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ToeicTextSegment[] = [];
  let at = 0;
  for (const r of sorted) {
    if (r.start < at) continue; // 겹침
    if (r.start > at) out.push({ text: text.slice(at, r.start), mark: false, expression: null });
    out.push({ text: text.slice(r.start, r.end), mark: true, expression: r.expression });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false, expression: null });
  return out;
}

/**
 * 모범답변 속 **활용한 표현** 구간(usedExpressions[].span)을 강조 조각으로. span은 저장 전에 모범답변의 실제 표기로 맞춰져
 * 있다(cleanUsedExpressions) — 그래도 대소문자·연속 공백이 달라도 찾는다. 못 찾은 span은 조용히 건너뛴다(원문 그대로 보인다).
 */
export function segmentUsedExpressions(text: string, used: readonly ToeicUsedExpression[]): ToeicTextSegment[] {
  const ranges: { start: number; end: number; expression: string | null }[] = [];
  for (const u of used) {
    const words = u.span.trim().split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) continue;
    const m = new RegExp(words.map(escapeRe).join("\\s+"), "i").exec(text);
    if (m) ranges.push({ start: m.index, end: m.index + m[0].length, expression: u.expression });
  }
  return toSegments(text, ranges);
}

/**
 * 지문 조각 속 **강세 단어**를 강조 조각으로(Q1–2 끊어 읽기 표시). 대소문자 무시·단어 경계(영숫자 기준 — "side"가
 * "Riverside" 안에서 강조되지 않게). 한 단어가 여러 번 나오면 모두 강조한다.
 * ⚠️ 클라이언트 번들 — 정규식 lookbehind를 쓰지 않는다(구형 iOS Safari).
 */
export function segmentStressWords(text: string, stressWords: readonly string[]): ToeicTextSegment[] {
  const ranges: { start: number; end: number; expression: string | null }[] = [];
  for (const w of stressWords) {
    const words = w.trim().split(/\s+/).filter((x) => x !== "");
    if (words.length === 0) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])(${words.map(escapeRe).join("\\s+")})(?=$|[^A-Za-z0-9])`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index + m[1].length;
      ranges.push({ start, end: start + m[2].length, expression: null });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return toSegments(text, ranges);
}

// ===========================================================================
// 만들기 — `POST /api/toeic/mocks` (호출 C 파트별 병렬, 부분 성공)
// ===========================================================================

export interface ToeicMockCreateRequest {
  targetGrade: ToeicTargetGrade;
  /** 만들 파트 1~5개(중복 없이). 고르지 않은 파트는 null로 저장된다(유형 연습용 부분 세트) */
  parts: ToeicMockPart[];
  /** 주제 힌트 0~TOEIC_MOCK_TOPIC_HINTS_MAX개(표현집 세트 주제 칩 + 직접 입력). 비면 "없음" */
  topicHints: string[];
}

export type ToeicMockCreateResponse =
  | {
      ok: true;
      id: string;
      titleKo: string;
      /** 만든 파트(형식표 순서) */
      createdParts: ToeicMockPart[];
      /** 골랐지만 만들지 못한 파트 — null로 저장됐고 학습 보기에서 "이 파트 다시 만들기"로 채운다 */
      failedParts: ToeicMockPart[];
      /** 호출 C에 넘긴 활용할 표현 수(표현집이 비면 0) */
      expressionsCount: number;
    }
  | {
      ok: false;
      error: "invalid_input" | "no_api_key" | "ai_failed" | "save_failed";
      messageKo: string;
      /** ai_failed(고른 파트 전부 실패 — 저장 안 함)면 true */
      retriable?: boolean;
      issues?: Issue[];
    };

// ===========================================================================
// 읽기 — `GET /api/toeic/mocks/[id]` (사진 요청이 끊겼을 때 "이미 저장됐는지" 다시 읽는 자리, §4-10)
// ===========================================================================

export type ToeicMockGetResponse = { ok: true; mock: ToeicMockRecord } | { ok: false; error: "mock_not_found"; messageKo: string };

// ===========================================================================
// 파트 다시 만들기 — `POST /api/toeic/mocks/[id]/regenerate?part=<part>` (빈 파트만)
// ===========================================================================

export type ToeicMockRegenerateResponse =
  | { ok: true; id: string; part: ToeicMockPart }
  | {
      ok: false;
      /** part_exists: 이미 있는 파트(덮지 않는다 — 화면이 새로 읽는다) */
      error: "invalid_input" | "mock_not_found" | "part_exists" | "no_api_key" | "ai_failed" | "save_failed";
      messageKo: string;
      retriable?: boolean;
    };

// ===========================================================================
// 사진 — `POST /api/toeic/mocks/[id]/image` (관문 P, 사진 한 장 = 요청 하나)
// ===========================================================================

export interface ToeicMockImageRequest {
  slot: 0 | 1;
}

export type ToeicMockImageResponse =
  | {
      ok: true;
      slot: 0 | 1;
      /** 늘 ready + imageId */
      image: ToeicPictureImage;
      /** 이미 준비된 사진을 그대로 돌려줬다(새로 만들지 않음 — 비용 0) */
      reused: boolean;
    }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "mock_not_found"
        | "picture_not_found"
        /** 그사이 장면이 바뀌었다 — 만든 사진은 버렸다 */
        | "scene_changed"
        | "no_api_key"
        /** 생성 실패(API 오류·시간 초과·크기 초과) — 칸은 failed로 저장됐다 */
        | "image_failed"
        | "save_failed";
      messageKo: string;
      /** 응답 시점의 그 칸 상태(알 수 있으면) — 화면이 다시 읽지 않고 반영한다 */
      image: ToeicPictureImage | null;
      retriable?: boolean;
    };

// ===========================================================================
// 이름 수정 · 삭제 · 순서(lib/reorder-contract.ts 재사용) · 사진 GET 오류
// ===========================================================================

export type ToeicMockRenameResponse =
  | { ok: true; id: string; titleKo: string }
  | { ok: false; error: "invalid_input" | "mock_not_found" | "save_failed"; messageKo: string; issues?: Issue[] };

export type ToeicMockDeleteResponse =
  | { ok: true }
  | { ok: false; error: "mock_not_found" | "delete_failed" | "prod_guard"; messageKo: string };

/** `GET /api/toeic/images/[id]` 실패 본문(성공은 image/jpeg 바이트) */
export type ToeicImageGetErrorResponse = { ok: false; error: "image_not_found" | "image_unreadable"; messageKo: string };

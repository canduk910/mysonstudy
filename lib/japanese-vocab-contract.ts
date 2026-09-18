/**
 * lib/japanese-vocab-contract.ts — 일본어 JLPT 단어장 라우트의 요청·응답 계약 (아빠의 일본어 J1, §2·§8)
 *
 * **타입만 있는 모듈이다**(값 export 0 — zod는 라우트 파일에 둔다). 라우트(서버)와 화면(클라이언트)이 같은
 * shape을 보게 하는 단일 정의처다. qa-inspector가 라우트 응답 shape ↔ 프론트 기대 타입을 교차 검증할 곳.
 *
 * ── 클라이언트 번들 경계 (중요) ──────────────────────────────────────────────
 * `lib/ai/*`는 클라이언트에서 import 금지(zod 등 런타임이 번들에 샌다 — QA가 빌드로 확인하는 차단선). 그래서
 * 화면이 쓸 **타입**은 여기서 `export type`으로 재수출한다(`isolatedModules`로 컴파일 시 완전히 지워져 런타임
 * import가 없다). **값**(JLPT_LEVELS·JA_VOCAB_TOPIC_PRESETS 등 상수 배열)이 화면에 필요하면 서버 컴포넌트가
 * props로 내려보낸다 — 이 파일에 값 import를 넣지 않는다.
 */

import type { JlptLevel, JaPos, JaVocabEntry, JaToken } from "@/lib/ai/japanese/schemas";

// 타입 전용 재수출 — 화면(클라)이 lib/ai를 직접 import하지 않고 이 통로로 타입만 본다.
export type { JlptLevel, JaPos, JaVocabEntry, JaToken };

// ===========================================================================
// 생성 — `POST /api/japanese/vocab/generate` (호출 A, 레벨별 병렬)
// ===========================================================================

/** 생성 요청 — 고른 레벨들·주제(없으면 null)·꼭 넣을 단어(표기). exclude는 서버가 조립한다(§7-4). */
export interface JaVocabGenerateRequest {
  levels: JlptLevel[];
  topic: string | null;
  include: string[];
}

/** 레벨 한 개의 생성 결과 보고(§2-4) — 화면이 "못 넣은 포함 단어·걸러진 중복"을 사실대로 알린다. */
export interface JaVocabPerLevelResult {
  level: JlptLevel;
  /** 제외 재적용+중복 접기로 버려진 개수 */
  filteredCount: number;
  /** include 중 결과에 못 들어간 표기(오류 아님, 보고용) */
  missingIncludes: string[];
  /** 이 레벨 호출이 실패(격리)했는가 — true면 이 레벨 단어는 entries에 없다 */
  failed: boolean;
}

export type JaVocabGenerateResponse =
  | {
      ok: true;
      /** 모든 성공 레벨의 엔트리 합(레벨 태깅 완료). 검토 화면이 그대로 보여주고 저장으로 넘긴다 */
      entries: JaVocabEntry[];
      perLevel: JaVocabPerLevelResult[];
      /** 생성에 쓴 모델 id — 저장 요청에 그대로 실어 record.model로 굳힌다 */
      model: string;
    }
  | {
      ok: false;
      error: "invalid_input" | "no_api_key" | "generate_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

// ===========================================================================
// 저장 — `POST /api/japanese/vocab`
// ===========================================================================

/** 저장 요청 — 검토 화면이 확정한 단어장. kind:"jlpt"는 서버가 붙인다(대화 collected와 구분). */
export interface JaVocabSaveRequest {
  titleKo: string;
  topic: string | null;
  levels: JlptLevel[];
  entries: JaVocabEntry[];
  /** 생성 응답의 model을 그대로 실어 보낸다(어느 모델이 만들었는지 기록) */
  model: string;
}

export type JaVocabSaveResponse =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "invalid_input" | "save_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

// ===========================================================================
// 이름 수정 — `POST /api/japanese/vocab/[id]/rename`
// ===========================================================================

export type JaVocabRenameResponse =
  | { ok: true; id: string; titleKo: string }
  | {
      ok: false;
      error: "invalid_input" | "vocabbook_not_found" | "save_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

// ===========================================================================
// 삭제 — `DELETE /api/japanese/vocab/[id]`
// ===========================================================================

export type JaVocabDeleteResponse =
  | { ok: true }
  | { ok: false; error: "vocabbook_not_found" | "delete_failed" | "prod_guard"; messageKo: string };

/** 제목 상한(화면 maxLength·라우트 zod 공용). 영어 VOCAB_LIMITS.titleKo(120)와 같은 값. */
export const JA_TITLE_MAX = 120;

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

import type { JlptLevel, JaPos, JaVocabEntry, JaToken, JaGlyph, JaKoIncludeMapping } from "@/lib/ai/japanese/schemas";
import type { JaQuizMode, JaQuizContentMode, JaQuizQuestion } from "@/lib/ai/japanese/quiz";

// 타입 전용 재수출 — 화면(클라)이 lib/ai를 직접 import하지 않고 이 통로로 타입만 본다.
// JaGlyph는 서버(page.tsx)가 resolveJaGlyph(값)로 계산해 props로 내려주고, 화면은 이 타입으로 받아 그린다
// (값 resolveJaGlyph는 lib/ai에 남는다 — 클라 번들 경계 유지). JaQuiz* 타입도 같은 통로로 화면에 준다.
export type { JlptLevel, JaPos, JaVocabEntry, JaToken, JaGlyph };
// 한국어 꼭 넣을 단어 매핑 {ko, word, kana}(2026-09-27, §2-4 6번) — 검토 화면의 "여권 → パスポート".
export type { JaKoIncludeMapping };
export type { JaQuizMode, JaQuizContentMode, JaQuizQuestion };

// ===========================================================================
// 시험 (J2, §6) — 모드 한글 라벨 + 세션 저장 계약
// ===========================================================================

/**
 * 시험 모드 → 한글 라벨(배지·탭·안내 단일 정의처). 값 상수라 lib/ai에 의존하지 않아 클라가 직접 import해도 안전.
 * 콘텐츠 4모드 + wrong-review. 화면은 이 라벨로 종류를 보여준다(§6-1 표와 같은 뜻).
 */
export const JA_QUIZ_MODE_LABELS_KO: Record<JaQuizMode, string> = {
  "ko-to-word": "뜻→표기",
  "kanji-to-kana": "한자→읽기",
  "word-to-ko": "표기→뜻",
  cloze: "빈칸 채우기",
  "def-to-word": "일일정의→표기",
  "wrong-review": "오답복습",
};

/** 세션 저장 요청 — 한 콘텐츠 모드분(혼합 세션은 화면이 모드별로 갈라 여러 번 보낸다, §6-2 무오염). */
export interface JaQuizSubmitRequest {
  mode: JaQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];
}

export type JaQuizSubmitResponse =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "invalid_input" | "vocabbook_not_found" | "save_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

// ===========================================================================
// 생성 — `POST /api/japanese/vocab/generate` (호출 A, 레벨별 병렬)
// ===========================================================================

/** 생성 요청 — 고른 레벨들·주제(없으면 null)·꼭 넣을 단어. exclude는 서버가 조립한다(§7-4). */
export interface JaVocabGenerateRequest {
  levels: JlptLevel[];
  topic: string | null;
  /**
   * 꼭 넣을 단어 줄 — 줄마다 **일본어 표기 또는 한국어 뜻**(2026-09-27, §2-2). 두 종류를 **섞인 그대로** 보낸다
   * (가르는 일은 서버의 배분 계획이 `classifyJaIncludeLine`으로 한다). 합쳐 최대 count개, 한 줄은 정규화 뒤 1~20자.
   * 한 줄 안에 일본 문자와 한글이 섞이거나 라틴·숫자가 들면 400이다 — 화면도 같은 함수로 먼저 막는다. 400 `issues`의
   * 문구는 화면 칩과 같은 `jaIncludeRejectReason`이 고른다(여러 단어를 한 줄에 이어 쓴 줄은 "한 줄에 하나씩").
   */
  include: string[];
}

/** 레벨 한 개의 생성 결과 보고(§2-4) — 화면이 "못 넣은 포함 단어·걸러진 중복"을 사실대로 알린다. */
export interface JaVocabPerLevelResult {
  level: JlptLevel;
  /** 제외 재적용+중복 접기로 버려진 개수 — koExcluded로 뺀 항목도 여기에 들어 있다 */
  filteredCount: number;
  /**
   * 꼭 넣을 단어 중 결과에 못 들어간 것(오류 아님, 보고용). 일본어 표기 먼저, 이어서 한국어 뜻(모델이 일본어로
   * 바꿔 내지 못한 줄 — **한국어 그대로**). koExcluded로 뺀 줄은 여기에 없다(못 넣은 게 아니라 이미 있어서 뺀 것).
   * **실패 레벨이면 그 레벨에 배분됐던 꼭 넣을 단어 전부**다(같은 순서 — 배분은 첫 레벨에만 하므로 대개 첫 레벨).
   * 화면은 `failed`와 함께 "꼭 넣을 단어 N개는 이 레벨이 실패해 넣지 못했어요"로 알린다(QA 3회차 P3-C).
   */
  missingIncludes: string[];
  /**
   * 한국어 줄이 일본어 단어로 바뀌어 **결과에 들어간** 매핑(한국어 입력 순서). 화면은 "여권 → パスポート"로 보여 준다
   * — 뜻이 갈리는 말은 원하는 단어가 아닐 수 있어 확인하게 한다. word는 entries에 실제로 남은 항목의 표기다
   * (같은 단어로 접혔으면 남은 쪽). 실패 레벨이면 []
   */
  koConverted: JaKoIncludeMapping[];
  /**
   * 한국어 줄이 바뀐 단어가 이미 가진 단어라 **뺀** 매핑 — 화면은 "이미 있어서 뺐어요: 여권 → パスポート"로 알린다
   * (실패 아님). 이 항목 수는 filteredCount에도 **이미 들어 있다**(화면은 두 번 세지 않는다). 실패 레벨이면 []
   */
  koExcluded: JaKoIncludeMapping[];
  /** 이 레벨 호출이 실패(격리)했는가 — true면 이 레벨 단어는 entries에 없고 filteredCount 0·매핑 둘은 []다 */
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

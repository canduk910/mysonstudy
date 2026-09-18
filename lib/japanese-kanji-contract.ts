/**
 * lib/japanese-kanji-contract.ts — 한자 단위 학습(JK)의 요청·응답 계약 + 화면 데이터 타입 (아빠의 일본어 §12·§12-5)
 *
 * 타입 재수출 + 값 상수(라벨)만 있는 모듈이다. 화면(클라)이 `lib/ai/japanese/*`를 직접 import하지 않게(§10 번들 경계),
 * 타입은 `export type`로 재수출하고, 한자 정보(JaKanjiRecord)는 서버가 props로 내려준다. 라벨 상수는 lib/ai 무관(number/string).
 */

import type { JaKanjiQuizMode, JaKanjiQuizQuestion } from "@/lib/ai/japanese/quiz";

export type { JaKanjiQuizMode, JaKanjiQuizQuestion };

/** 한자 시험 2모드 → 한글 라벨(배지·안내 단일 정의처). §12-4. */
export const JA_KANJI_QUIZ_MODE_LABELS_KO: Record<JaKanjiQuizMode, string> = {
  "kanji-to-on": "한자→음독",
  "kanji-to-meaning": "한자→뜻",
};

// ===========================================================================
// 화면 데이터 (서버가 수집·조인해 props로 내려준다)
// ===========================================================================

/** 한자 목록 한 줄 — 수집된 한자 + 정보 유무 + 등장 단어 수. 정보 없으면 흐리게 + "정보 만들기"(§12-5). */
export interface JaKanjiListItem {
  kanji: string;
  /** 내 단어장에서 이 한자가 든 단어 수(읽을 때 계산) */
  wordCount: number;
  /** JaKanjiRecord가 있으면 true. false면 흐리게. */
  hasInfo: boolean;
  /** 정보 있을 때만 채워짐(목록 미리보기용) */
  koReading: string | null;
  meaningKo: string;
}

/** 한자 카드 — 정보 + "이 한자가 든 내 단어들"(§12-5). */
export interface JaKanjiCardData {
  kanji: string;
  hasInfo: boolean;
  koReading: string | null;
  onyomi: string[];
  kunyomi: string[];
  meaningKo: string;
  /** 내 단어장에서 이 한자가 든 단어 표기들(읽을 때 계산). 각 단어가 어느 단어장인지 링크용 */
  words: { word: string; bookId: string }[];
}

// ===========================================================================
// enrich (호출 D) — `POST /api/japanese/kanji/enrich`
// ===========================================================================

/** 한자 배치 한 개의 결과 보고(§12-2-3, 부분 성공). */
export interface JaKanjiEnrichBatch {
  /** 이 배치가 실패(격리)했는가 */
  failed: boolean;
  /** 이 배치에서 요청 밖·중복이라 버린 수 */
  droppedCount: number;
  /** 이 배치에서 요청했지만 못 채운 한자 */
  missingKanji: string[];
}

export type JaKanjiEnrichResponse =
  | {
      ok: true;
      /** 새로 채운 한자 수(저장된 것) */
      filled: number;
      /** 전 배치 합산 — 못 채운 한자(사실 보고) */
      missingKanji: string[];
      /** 전 배치 합산 — 요청 밖·중복으로 버린 수 */
      droppedCount: number;
      batches: JaKanjiEnrichBatch[];
      /** 채울 한자가 애초에 없었으면(전부 이미 있음) true */
      nothingToFill: boolean;
    }
  | {
      ok: false;
      error: "no_api_key" | "enrich_failed";
      messageKo: string;
    };

// ===========================================================================
// 한자 시험 세션 저장 — `POST /api/japanese/kanji/quiz`
// ===========================================================================

export interface JaKanjiQuizSubmitRequest {
  mode: JaKanjiQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: { word: string; correct: boolean; answered: boolean | null }[];
}

export type JaKanjiQuizSubmitResponse =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_input" | "save_failed"; messageKo: string; issues?: { path: string; message: string }[] };

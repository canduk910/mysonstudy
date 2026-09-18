/**
 * lib/japanese-dialog-contract.ts — 대화 복습(J3~J5)의 요청·응답 계약 (아빠의 일본어 §3·§4·§7-2·§7-5·§8)
 *
 * 타입 재수출 + 응답 shape만 있는 모듈이다. 화면(클라)이 `lib/ai/japanese/*`를 직접 import하지 않게(§10 번들 경계),
 * 타입은 `export type`로 재수출한다(전사·해설 데이터는 서버가 props로 내려준다).
 */

import type {
  JaDialogTurn,
  JaDialogFeedback,
  JaDialogCoaching,
  JaDialogGood,
  JaDialogFix,
  JaDialogItem,
  JaDialogSpeaker,
  JaExample,
  JaToken,
} from "@/lib/ai/japanese/schemas";

export type {
  JaDialogTurn,
  JaDialogFeedback,
  JaDialogCoaching,
  JaDialogGood,
  JaDialogFix,
  JaDialogItem,
  JaDialogSpeaker,
  JaExample,
  JaToken,
};

/** 제목 상한(JLPT와 같은 값). */
export const JA_DIALOG_TITLE_MAX = 120;

// ===========================================================================
// extract (호출 B, vision) — `POST /api/japanese/dialog/extract`
// ===========================================================================

/** 판독 요청 — 스크린샷 base64 data URL 목록(촬영 순서). 리사이즈는 화면이 미리 한다(공유 파이프). */
export interface JaDialogExtractRequest {
  images: string[];
}

export type JaDialogExtractResponse =
  | {
      ok: true;
      /** 병합된 전사 — 검토 화면이 그대로 보여주고, 해설·저장으로 넘긴다 */
      focusKo: string | null;
      turns: JaDialogTurn[];
      partial: boolean;
      /** 경계 겹침으로 접힌 발화 수(사실 보고) */
      mergedCount: number;
      /** 발화가 있는데 전부 speaker=unknown이면 true — "화자를 확인하세요" 경고 */
      allUnknown: boolean;
      model: string;
    }
  | {
      ok: false;
      error: "invalid_input" | "no_api_key" | "extract_failed";
      messageKo: string;
      issues?: { path: string; message: string }[];
    };

// ===========================================================================
// coach (호출 C) — `POST /api/japanese/dialog/coach` (생성·재생성, best-effort)
// ===========================================================================

/** 해설 요청 — 저장된 대화면 `{id}`(재생성·저장까지), 아직 안 저장한 전사면 `{focusKo,turns}`(생성만·반환). */
export type JaDialogCoachRequest = { id: string } | { focusKo: string | null; turns: JaDialogTurn[] };

export type JaDialogCoachResponse =
  | { ok: true; coaching: JaDialogCoaching }
  | { ok: false; error: "invalid_input" | "no_api_key" | "coach_failed" | "not_found"; messageKo: string };

// ===========================================================================
// 저장 — `POST /api/japanese/dialog`
// ===========================================================================

/** 저장 요청 — 검토 화면이 확정한 대화(전사 본체 + 해설, 해설 실패면 null). 사진 원본은 보내지 않는다(SPEC §1). */
export interface JaDialogSaveRequest {
  titleKo: string;
  focusKo: string | null;
  turns: JaDialogTurn[];
  coaching: JaDialogCoaching | null;
  photoCount: number;
  partial: boolean;
  model: string;
}

export type JaDialogSaveResponse =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_input" | "save_failed"; messageKo: string; issues?: { path: string; message: string }[] };

// ===========================================================================
// rename / delete
// ===========================================================================

export type JaDialogRenameResponse =
  | { ok: true; id: string; titleKo: string }
  | { ok: false; error: "invalid_input" | "not_found" | "save_failed"; messageKo: string; issues?: { path: string; message: string }[] };

export type JaDialogDeleteResponse =
  | { ok: true }
  | { ok: false; error: "not_found" | "delete_failed" | "prod_guard"; messageKo: string };

// ===========================================================================
// J5 — 대화 어휘 담기 `POST /api/japanese/dialog/[id]/add-word`
// ===========================================================================

/** 담기 요청 — 해설 items 배열의 인덱스. 서버가 그 항목을 collected 단어장에 매핑·append한다. */
export interface JaDialogAddWordRequest {
  itemIndex: number;
}

export type JaDialogAddWordResponse =
  | {
      ok: true;
      /** true=새로 담음, false=같은 kana가 이미 있어 안 담음(중복) */
      added: boolean;
      /** 담긴 "대화에서 모은 단어" 단어장 id(상세로 링크) */
      bookId: string;
      word: string;
    }
  | { ok: false; error: "invalid_input" | "not_found" | "save_failed"; messageKo: string };

/**
 * lib/toeic-guide-contract.ts — 토익스피킹 **유형별 공략** 라우트의 요청·응답 계약 (docs/harness/toeic.md §12-2-6·§12-5-4·§12-5-6·§12-7-2)
 *
 * 라우트(서버)와 화면(클라이언트)이 같은 shape을 보게 하는 단일 정의처다 — 라우트는 응답 헬퍼 인자 타입으로 여기 타입을 걸고,
 * 요청 타입은 라우트 zod(lib/ai/toeic/schemas.ts toeicTemplateSessionBodySchema 등)와 양방향으로 묶는다.
 *
 * - `POST /api/toeic/guides/import`                 파일로 가져오기(toeic-guides/v2 — 제자리 갱신·멱등, 틀 은행 포함)
 * - `POST /api/toeic/guides/templates/transcribe`   녹음 → 글자(관문 T, 저장 없음)
 * - `POST /api/toeic/guides/templates/sessions`     템플릿 테스트 기록(멱등 — 문서 id tpl-{clientSessionId})
 * - `POST /api/toeic/guides/[part]/drills`          한 문제 연습 만들기(호출 C 1회)
 *
 * ── 클라이언트 번들 경계 ──────────────────────────────────────────────────────
 * 값은 **자기 상수뿐**이다. lib/ai·lib/store는 `import type`만(zod·openai가 폰 번들로 새지 않게), 다른 순수 모듈도 타입만 가져온다.
 */

import type { ToeicGuidePart } from "./toeic-guide";
import type { ToeicTemplateBankMode, ToeicTemplateChoiceMode, ToeicTemplateQuizMode } from "./toeic-quiz";
import type { ToeicMockPart, ToeicTargetGrade } from "./toeic-mock";

export type { ToeicGuidePart, ToeicTemplateQuizMode, ToeicTemplateChoiceMode, ToeicTemplateBankMode };

/**
 * 화면(클라이언트)이 받는 공략·틀 자료의 타입 — 클라이언트 컴포넌트는 lib/ai를 직접 import하지 않고 이 계약 파일에서 타입만 가져간다
 * (`export type` — 컴파일 때 지워져 zod가 폰 번들로 새지 않는다, app-patterns §3).
 */
export type {
  ToeicAnswerFlow,
  ToeicAnswerFlowFrame,
  ToeicTemplateAlternate,
  ToeicGuideBlock,
  ToeicGuideExpression,
  ToeicGuideLine,
  ToeicGuideSection,
  ToeicGuideSpeak,
  ToeicTemplate,
  ToeicTemplateFlow,
  ToeicTemplateGuideRef,
} from "./ai/toeic/schemas";

type Issue = { path: string; message: string };

// ===========================================================================
// 상한·형식 (라우트 검사·화면 검사 공용 — 단일 정의)
// ===========================================================================

/**
 * 템플릿 테스트 받아쓰기 업로드 한 파일의 상한(바이트) — 1 MiB. 20초 16kHz mono WAV가 약 640KB, 원본 mp4는 더 작다(§12-5-4).
 * 화면이 올리기 전에 보고, 라우트가 413으로 본다.
 */
export const TOEIC_TEMPLATE_AUDIO_MAX_BYTES = 1024 * 1024;
/** `content-length` 선검사 여유 — multipart 경계·헤더 몫(16 KiB). 이 합을 넘으면 본문을 읽지 않고 413(검토 개선 8) */
export const TOEIC_TEMPLATE_AUDIO_MULTIPART_SLACK_BYTES = 16 * 1024;

/**
 * 템플릿 테스트 세션의 멱등 키 형식 — **소문자 UUID**(자유대화 TALK_SAVE_ID_RE와 같은 모양, 검토 B4). 문서 id가 `tpl-{clientSessionId}`라
 * `/`가 들어가면 Firestore doc()이 하위 경로를 가리킨다 — 형식부터 막는다.
 */
export const TOEIC_TEMPLATE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 템플릿 테스트 세션 문서 id 접두어 */
export const TOEIC_TEMPLATE_SESSION_DOC_ID_PREFIX = "tpl-";

/** 템플릿 테스트 세션 문서 id — `tpl-{clientSessionId}` */
export function toeicTemplateSessionDocId(clientSessionId: string): string {
  return `${TOEIC_TEMPLATE_SESSION_DOC_ID_PREFIX}${clientSessionId}`;
}

// ===========================================================================
// 파일로 가져오기 — `POST /api/toeic/guides/import` (§12-2-6)
// ===========================================================================

/** 충돌 사유(§12-2-5) — 같은 presetKey가 표현집 세트 / 다른 유형 자리 / 그 자리를 다른 presetKey가 가짐 */
export type ToeicGuideConflictReason = "preset_key_is_book" | "part_mismatch" | "part_taken";

export interface ToeicGuideConflict {
  presetKey: string;
  /** 틀 은행 충돌이면 "templates" */
  part: ToeicGuidePart | "templates";
  reason: ToeicGuideConflictReason;
}

export type ToeicGuideImportResponse =
  /** 각각 presetKey 배열(파일 순서 — 유형 항목들 다음 틀 은행) */
  | { ok: true; created: string[]; updated: string[]; unchanged: string[] }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: Issue[] }
  | { ok: false; error: "guide_conflict"; messageKo: string; conflicts: ToeicGuideConflict[] }
  | { ok: false; error: "save_failed"; messageKo: string };

// ===========================================================================
// 받아쓰기 — `POST /api/toeic/guides/templates/transcribe` (§12-5-4)
// ===========================================================================

/** multipart 필드 이름 — 녹음 파일 하나(화면이 보내고 라우트가 읽는다) */
export const TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO = "audio";

/** 본문: multipart `audio` 하나. 정답·틀·표현은 보내지 않는다(기대 문장을 전사 prompt로 넣지 않는 원칙을 구조로 지킨다) */
export type ToeicTemplateTranscribeResponse =
  /** words = countWords(text) — 0이면 화면이 비교 없이 "잘 안 들렸어요"(유효하지 않은 시도) */
  | { ok: true; text: string; words: number }
  | { ok: false; error: "invalid_input"; messageKo: string; issues?: Issue[] }
  | { ok: false; error: "audio_too_large"; messageKo: string }
  | { ok: false; error: "no_api_key"; messageKo: string }
  | { ok: false; error: "client_closed"; messageKo: string }
  | { ok: false; error: "transcribe_failed"; messageKo: string; retriable: true };

// ===========================================================================
// 템플릿 테스트 기록 — `POST /api/toeic/guides/templates/sessions` (§12-5-6)
// ===========================================================================

export interface ToeicTemplateSessionRequest {
  /** 화면이 세션을 시작할 때 만든 소문자 UUID(TOEIC_TEMPLATE_SESSION_ID_RE) */
  clientSessionId: string;
  /** 틀 은행 세션 모드 다섯(§12-13-2) — ② 틀 테스트(말하기) 둘 · ③ 틀 시험(고르기·빈칸) 셋 */
  mode: ToeicTemplateBankMode;
  startedAt: string;
  /** 끝까지 풀면 ISO, 그만두면 null */
  finishedAt: string | null;
  /** word = `tpl:{틀 key}`, 한 판 한 틀(중복 거부), 1~10(말하기) · 1~20(틀 시험). 그만두면 판정한 문항만 answered true, 나머지 null */
  items: { word: string; correct: boolean; answered: boolean | null }[];
}

export type ToeicTemplateSessionResponse =
  /** reused: 같은 id·같은 판(mode·startedAt)이 이미 있어 새로 쓰지 않았다 */
  | { ok: true; id: string; reused: boolean }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: Issue[] }
  | { ok: false; error: "bank_not_found"; messageKo: string }
  | { ok: false; error: "save_failed"; messageKo: string };

// ===========================================================================
// 한 문제 연습 만들기 — `POST /api/toeic/guides/[part]/drills` (§12-7-2)
// ===========================================================================

export interface ToeicDrillCreateRequest {
  targetGrade: ToeicTargetGrade;
}

export type ToeicDrillCreateResponse =
  | { ok: true; id: string; titleKo: string; mockPart: ToeicMockPart; expressionsCount: number }
  | { ok: false; error: "part_not_found"; messageKo: string }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: Issue[] }
  | { ok: false; error: "no_api_key"; messageKo: string }
  /** 파트가 하나라 부분 성공이 없다 — 저장하지 않았다 */
  | { ok: false; error: "ai_failed"; messageKo: string; retriable: true }
  | { ok: false; error: "save_failed"; messageKo: string };

/**
 * lib/toeic-frame-drill-contract.ts — 소재별 틀 말하기 라우트의 요청·응답 계약 + 화면 이동 도우미 (docs/harness/toeic.md §20-10, SPEC §20-17)
 *
 * - `POST /api/toeic/frame-drill/import`                파일로 가져오기(`toeic-frame-drill/v1` — 은행 문서만, 통계 불변, 멱등)
 * - `POST /api/toeic/frame-drill/sessions`              끝난 한 판 저장(멱등 — 문서 id `fd-{clientSessionId}`)
 * - `POST /api/toeic/frame-drill/sessions/[id]/judge`   판정·총평(호출 E 또는 AI 0) + 통계 한 번 — 한 원자 단위
 * - `POST /api/toeic/frame-drill/sessions/[id]/supply`  보충 판정 → (필요하면) 호출 F → 최신 은행 위에 합치기 — 한 판에 한 번
 * - 전사는 기존 `POST /api/toeic/guides/templates/transcribe`(관문 T — 기대 문장 없음, 저장 없음)를 그대로 쓴다.
 *
 * ── 클라이언트 번들 경계 ──────────────────────────────────────────────────────
 * 값 import는 클라이언트 안전한 순수 모듈 `./toeic-frame-drill`의 상수뿐이다. lib/ai·lib/store는 쓰지 않는다(타입도 순수 모듈에서).
 */

import {
  TOEIC_FRAME_DRILL_COUNT_DEFAULT,
  TOEIC_FRAME_DRILL_KEY_RE,
  TOEIC_FRAME_DRILL_SESSION_ID_RE,
  TOEIC_FRAME_DRILL_SESSION_PREFIX,
  clampFrameDrillCount,
  type ToeicFrameDrillOutcome,
  type ToeicFrameDrillPart,
  type ToeicFrameDrillSession,
  type ToeicFrameDrillSupplyMark,
} from "./toeic-frame-drill";

export type { ToeicFrameDrillPart, ToeicFrameDrillSession };

type Issue = { path: string; message: string };

// ===========================================================================
// 가져오기
// ===========================================================================

export type ToeicFrameDrillImportResponse =
  | {
      ok: true;
      /** 시드 문항 — 새로 생김 · 글자가 바뀜(교정) · 파일에서 빠져 지움 */
      created: number;
      updated: number;
      removed: number;
      /** AI 보충 문항 — 남김 · 시드와 겹치거나 틀이 빠져 버림 */
      aiKept: number;
      aiDropped: number;
      /** 같은 파일 다시 가져오기 — 은행 글자 그대로(쓰기 0) */
      unchanged: boolean;
      topics: number;
      frames: number;
      items: number;
    }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: Issue[] }
  | { ok: false; error: "too_large"; messageKo: string }
  | { ok: false; error: "save_failed"; messageKo: string };

// ===========================================================================
// 한 판 저장
// ===========================================================================

/** 화면이 보내는 문항 하나 — 출제 때 글자 그대로 + 결과(판정 칸은 서버가 null로 시작) */
export interface ToeicFrameDrillSessionItemInput {
  itemId: string;
  frameKey: string;
  ko: string;
  en: string;
  /** `~` 형태 틀(frameToExpression) */
  frame: string;
  outcome: ToeicFrameDrillOutcome;
  /** 전사문(무응답이면 null 또는 짧은 글) — 서버가 frameDrillOutcomeOf로 다시 가른다 */
  transcript: string | null;
}

export interface ToeicFrameDrillSessionRequest {
  /** 화면이 시작 탭에서 만든 id(TOEIC_FRAME_DRILL_SESSION_ID_RE) — 문서 id `fd-{clientSessionId}` */
  clientSessionId: string;
  part: ToeicFrameDrillPart;
  topicKeys: string[];
  questionTypeKeys: string[];
  excludedFrameKeys: string[];
  requested: number;
  startedAt: string;
  finishedAt: string;
  ended: "done" | "quit";
  items: ToeicFrameDrillSessionItemInput[];
}

export type ToeicFrameDrillSessionResponse =
  | { ok: true; id: string; reused: boolean }
  | { ok: false; error: "invalid_input"; messageKo: string; issues: Issue[] }
  | { ok: false; error: "save_failed"; messageKo: string };

// ===========================================================================
// 판정 · 보충
// ===========================================================================

/** 화면이 받는 한 판(문서 id 포함) */
export type ToeicFrameDrillSessionView = ToeicFrameDrillSession & { id: string };

export type ToeicFrameDrillJudgeResponse =
  /** judged: 이번 요청이 판정을 썼다(false = 이미 판정된 판을 돌려줬다) · ai: 호출 E를 불렀다 */
  | { ok: true; session: ToeicFrameDrillSessionView; judged: boolean; ai: boolean }
  | { ok: false; error: "not_found"; messageKo: string }
  | { ok: false; error: "no_api_key"; messageKo: string }
  | { ok: false; error: "ai_failed"; messageKo: string; retriable: true }
  | { ok: false; error: "save_failed"; messageKo: string };

export type ToeicFrameDrillSupplyResponse =
  /**
   * status = 이 판의 보충 표시. fresh = 이번 요청이 표시를 바꿨다(false = 이미 끝난 표시를 돌려줬다 — 재방문).
   * added = 은행에 더한 새 문항 수(skipped면 0), dropped = 은행과 겹쳐 버린 수, reason = skipped·failed 이유.
   */
  | { ok: true; status: ToeicFrameDrillSupplyMark["status"]; fresh: boolean; added: number; dropped: number; reason: string | null }
  | { ok: false; error: "not_found"; messageKo: string }
  | { ok: false; error: "not_judged" | "running"; messageKo: string }
  | { ok: false; error: "no_api_key"; messageKo: string }
  | { ok: false; error: "ai_failed"; messageKo: string; retriable: true }
  | { ok: false; error: "save_failed"; messageKo: string };

// ===========================================================================
// 화면 이동 — 고르기(폴더 탭) → 진행(take) → 결과([id])
// ===========================================================================

/** 진행 화면 녹음의 이름(lib/mic-session owner — 공유 신호에 실린다) */
export const TOEIC_FRAME_DRILL_MIC_OWNER = "toeic-frame-drill";

/** 문서 id(접두어 + 화면이 만든 id) */
export function toeicFrameDrillSessionDocId(clientSessionId: string): string {
  return `${TOEIC_FRAME_DRILL_SESSION_PREFIX}${clientSessionId}`;
}

/** 주소의 id가 한 판 문서 id 모양인가(`fd-` + 화면 id) — 아니면 라우트·페이지가 404(`/`가 든 값이 Firestore 하위 경로를 가리키지 않게) */
export function isToeicFrameDrillDocId(id: string): boolean {
  return id.startsWith(TOEIC_FRAME_DRILL_SESSION_PREFIX) && TOEIC_FRAME_DRILL_SESSION_ID_RE.test(id.slice(TOEIC_FRAME_DRILL_SESSION_PREFIX.length));
}

/** 진행 화면에 넘기는 고르기 */
export interface ToeicFrameDrillSelection {
  topicKeys: string[];
  excludedFrameKeys: string[];
  questionTypeKeys: string[];
  count: number;
}

const keyList = (v: string | string[] | undefined): string[] => {
  const raw = Array.isArray(v) ? v.join(",") : (v ?? "");
  const out: string[] = [];
  for (const k of raw.split(",")) {
    const t = k.trim();
    if (TOEIC_FRAME_DRILL_KEY_RE.test(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 400);
};

/** 주소(`?topics=a,b&ex=c&qt=d&n=10`) → 고르기. 문법 밖 key는 버리고 문항 수는 1~20으로 */
export function parseFrameDrillSelection(sp: Record<string, string | string[] | undefined>): ToeicFrameDrillSelection {
  const n = Number(Array.isArray(sp.n) ? sp.n[0] : sp.n);
  return {
    topicKeys: keyList(sp.topics),
    excludedFrameKeys: keyList(sp.ex),
    questionTypeKeys: keyList(sp.qt),
    count: Number.isFinite(n) && n > 0 ? clampFrameDrillCount(n) : TOEIC_FRAME_DRILL_COUNT_DEFAULT,
  };
}

/** 진행 화면 주소(`t` = 다시 하기 논스 — 서버가 새로 출제하게) */
export function toeicFrameDrillTakeHref(part: ToeicFrameDrillPart, sel: ToeicFrameDrillSelection, nonce?: string | number): string {
  const q = new URLSearchParams();
  q.set("topics", sel.topicKeys.join(","));
  if (sel.excludedFrameKeys.length > 0) q.set("ex", sel.excludedFrameKeys.join(","));
  if (sel.questionTypeKeys.length > 0) q.set("qt", sel.questionTypeKeys.join(","));
  q.set("n", String(clampFrameDrillCount(sel.count)));
  if (nonce !== undefined) q.set("t", String(nonce));
  return `/toeic/guides/${part}/frame-drill/take?${q.toString().replace(/%2C/g, ",")}`;
}

export function toeicFrameDrillResultHref(part: ToeicFrameDrillPart, id: string): string {
  return `/toeic/guides/${part}/frame-drill/${encodeURIComponent(id)}`;
}

export function toeicFrameDrillTabHref(part: ToeicFrameDrillPart): string {
  return `/toeic/guides/${part}?tab=frame`;
}

/** 보충 skipped·failed 이유 → 한 줄(결과 화면 아래 작은 글) */
export const TOEIC_FRAME_DRILL_SUPPLY_REASON_KO: Record<string, string> = {
  already: "이 판의 보충은 이미 끝났어요",
  no_scope: "범위에 문항이 없어 새 문제를 만들지 않았어요",
  sample: "아직 연습한 문항이 적어 새 문제를 만들지 않았어요",
  rate: "아직 틀리는 문항이 있어 새 문제는 만들지 않았어요",
  full: "문제 은행이 가득 차 새 문제를 만들지 않았어요",
  no_api_key: "API 키가 없어 새 문제를 만들지 못했어요",
  ai_failed: "새 문제를 만들지 못했어요 — 다음에 결과를 열 때 다시 해 볼게요",
};

/**
 * lib/phrase-helper-scope.ts — 표현 도우미를 **어디서 띄우고 어디서 막는가**의 단일 정의처 (SPEC §22-2·§22-3,
 * docs/harness/phrase-helper.md §13)
 *
 * - `phraseHelperModeForPath(pathname)` — 경로 → 모드. 아빠의 영어(`/toeic/**`) → `toeic`, 아빠의 일본어(`/japanese/**`) → `japanese`,
 *   은우 영어(`/english/**`·서재 `/library`·북카드 `/card/**`) → `english-kid`. 홈(`/`)·수학·운동·잠금 화면은 null(띄우지 않는다).
 * - `isPhraseHelperExamPath(pathname)` — **경로만으로** 시험 화면임을 아는 곳(시험·응시 라우트 전체 — 방식 고르기 화면 포함).
 * - 블록 카운터 — 경로로 못 가르는 시험(같은 페이지 안에서 열리는 자유대화 통화 오버레이 등)은 그 화면이 **마운트된 동안** 블록을 건다
 *   (`acquirePhraseHelperBlock()` — 참조 카운트, 해제는 멱등). 시험 러너는 경로로 막히는 곳에서도 블록을 함께 건다(두 겹).
 * - `phraseHelperVisibility({pathname, blockCount})` — 둘을 합친 판정(화면이 쓰는 것은 이것 하나).
 *
 * ⚠️ 런타임 import 0·`window` 미사용 — 화면이 값으로 import하고 eval이 그대로 부른다. 정규식 lookbehind 금지(구형 iOS Safari).
 */

import type { PhraseHelperMode } from "./phrase-helper";

// ---------------------------------------------------------------------------
// 경로 → 모드
// ---------------------------------------------------------------------------

/** 쿼리·해시를 떼고 끝 슬래시를 정리한 경로(빈 값은 "/") */
export function normalizePhraseHelperPath(pathname: string | null | undefined): string {
  const raw = typeof pathname === "string" ? pathname : "";
  const noQuery = raw.split(/[?#]/)[0] ?? "";
  const trimmed = noQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** 첫 경로 조각 → 모드. 여기에 없는 조각(홈·math·workout·unlock·api 등)은 도우미를 띄우지 않는다 */
const FIRST_SEGMENT_MODE: Readonly<Record<string, PhraseHelperMode>> = {
  toeic: "toeic",
  japanese: "japanese",
  english: "english-kid",
  library: "english-kid", // 은우 영어 서재(북카드 목록)
  card: "english-kid", // 은우 북카드 한 장
};

/** 경로 → 도우미 모드(null = 이 화면에는 도우미가 없다) */
export function phraseHelperModeForPath(pathname: string | null | undefined): PhraseHelperMode | null {
  const path = normalizePhraseHelperPath(pathname);
  const first = path.split("/")[1] ?? "";
  return Object.prototype.hasOwnProperty.call(FIRST_SEGMENT_MODE, first) ? FIRST_SEGMENT_MODE[first] : null;
}

// ---------------------------------------------------------------------------
// 시험 화면 — 경로로 아는 곳 (SPEC §22-3 표와 같은 순서)
// ---------------------------------------------------------------------------

/** 경로로 막는 시험 화면. 라벨은 리포트·eval 표에만 쓴다 */
export const PHRASE_HELPER_EXAM_PATHS: readonly { re: RegExp; labelKo: string }[] = [
  { re: /^\/toeic\/mocks\/[^/]+\/take$/, labelKo: "토익 모의고사 응시(실전·파트 연습·한 문제 연습)" },
  { re: /^\/toeic\/attempts\/[^/]+\/retake$/, labelKo: "토익 문항 다시 풀기" },
  { re: /^\/toeic\/sets\/[^/]+\/quiz$/, labelKo: "토익 표현 시험(방식 고르기 포함)" },
  { re: /^\/toeic\/guides\/[^/]+\/templates\/quiz$/, labelKo: "토익 👀 틀 시험" },
  { re: /^\/toeic\/guides\/[^/]+\/templates\/test$/, labelKo: "토익 🧩 틀 테스트" },
  { re: /^\/toeic\/guides\/[^/]+\/frame-drill\/take$/, labelKo: "토익 🗣️ 틀 말하기 진행" },
  { re: /^\/japanese\/vocab\/[^/]+\/quiz$/, labelKo: "일본어 단어 시험(방식 고르기·오답 다시 풀기 포함)" },
  { re: /^\/japanese\/kanji\/quiz$/, labelKo: "일본어 한자 시험" },
  { re: /^\/english\/vocab\/[^/]+\/quiz$/, labelKo: "은우 단어장 시험(오답 재시험·관계 문제 포함)" },
  { re: /^\/english\/vocab\/[^/]+\/speak$/, labelKo: "은우 그림 보고 말하기(다시 말해 보기 포함, SPEC §15-5)" },
  { re: /^\/(english|japanese|toeic)\/review$/, labelKo: "오늘의 복습 러너(은우 영어·일본어·토익 — 가린 채 떠올리기, SPEC §23)" },
];

/** 경로만으로 시험 화면인가 */
export function isPhraseHelperExamPath(pathname: string | null | undefined): boolean {
  const path = normalizePhraseHelperPath(pathname);
  return PHRASE_HELPER_EXAM_PATHS.some((p) => p.re.test(path));
}

// ---------------------------------------------------------------------------
// 블록 카운터 — 시험 화면이 마운트된 동안 건다 (참조 카운트)
// ---------------------------------------------------------------------------

let blockCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* 구독자 예외는 다른 구독자를 막지 않는다 */
    }
  }
}

/** 블록을 하나 건다. 돌려준 해제 함수는 **멱등**(두 번 불러도 한 번만 내린다 — StrictMode 이중 정리 안전) */
export function acquirePhraseHelperBlock(): () => void {
  blockCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    blockCount = Math.max(0, blockCount - 1);
    emit();
  };
}

/** 지금 걸린 블록 수(useSyncExternalStore의 snapshot) */
export function getPhraseHelperBlockCount(): number {
  return blockCount;
}

/** 블록 수가 바뀔 때 알림(해제 함수 반환) */
export function subscribePhraseHelperBlock(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// 합친 판정
// ---------------------------------------------------------------------------

export interface PhraseHelperVisibility {
  /** 이 경로의 모드(null = 도우미가 없는 화면) */
  mode: PhraseHelperMode | null;
  /** 시험 중이라 막혔는가(mode가 null이면 false) */
  blocked: boolean;
  /** 버튼·패널을 보일 모드(막혔거나 없으면 null) */
  show: PhraseHelperMode | null;
}

export function phraseHelperVisibility(input: { pathname: string | null | undefined; blockCount: number }): PhraseHelperVisibility {
  const mode = phraseHelperModeForPath(input.pathname);
  if (mode === null) return { mode: null, blocked: false, show: null };
  const blocked = isPhraseHelperExamPath(input.pathname) || input.blockCount > 0;
  return { mode, blocked, show: blocked ? null : mode };
}

/**
 * lib/ai/toeic/island-prompts.ts — 🏝️ 나만의 답변 섬 호출 G(섬 문장 해석) 프롬프트 + 사용자 메시지 + 호출 옵션
 * (docs/harness/toeic.md §21-7)
 *
 * ── spec-sync ─────────────────────────────────────────────────────────────────
 * 아래 `TOEIC_ISLAND_TRANSLATE_*` 문자열 상수는 docs/harness/toeic.md §21-7 코드블록과 **바이트 단위로 일치**해야 한다
 * (scripts/eval-toeic-island.ts의 ISLAND_SPEC_SYNC_TARGETS — eval-toeic.ts가 부른다). 문구를 고치면 스펙도 같이 고친다.
 * 사용자 메시지는 템플릿 상수(줄 템플릿 포함)를 spec-sync하고, 빌더는 prompts.ts의 fillTemplate(단일 패스·모르는 키 throw)로 채운다.
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 해석은 성인 수험자가 "이 한국어를 보고 내 영어 문장을 떠올리는" 단서다. 섬 문장은 런타임에 저장소에서 읽는다 —
 * 프롬프트 상수에 교재·틀 원본 글을 박지 않는다(공개 저장소).
 *
 * ⚠️ 서버 전용 모듈에서만 쓴다(calls.ts·eval). 화면은 lib/toeic-island.ts(클라이언트 안전)만 import한다.
 */

import { collapseSpaces } from "../../toeic-text";
import { fillTemplate } from "./prompts";

// ===========================================================================
// 원문 상수 — docs/harness/toeic.md §21-7 코드블록 그대로 (손대지 말 것: spec-sync가 바이트 대조)
// ===========================================================================

/** 호출 G 시스템 프롬프트 (§21-7 원문 그대로) */
export const TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT = `너는 TOEIC Speaking을 준비하는 한국인 성인 수험자가 모아 둔 영어 답변 문장을 한국어로 옮기는 번역가다. 수험자는 나중에 이 한국어 해석만 보고 원래 영어 문장을 떠올려 말하는 연습을 한다.

[입력]
- 번호(index)가 붙은 영어 항목 목록을 받는다. 한 항목은 한 문장일 수도, 이어진 여러 문장(답변 하나)일 수도 있다.
- 수험자가 직접 말하거나 쓴 문장이라 문법이 어색할 수 있다. 고치거나 평가하지 않고 말하려는 뜻을 옮긴다.

[해석 — items]
- 받은 index마다 정확히 하나씩 쓴다(index는 받은 번호 그대로, 개수는 받은 항목 수와 같다). 항목을 합치거나 나누지 않는다.
- ko: 그 항목 전체의 한국어 해석이다. 자연스러운 한국어 구어체 존댓말(~요)로 쓴다.
- 해석만 보고 원래 문장을 떠올릴 수 있어야 한다. 원문의 내용 낱말(누가, 무엇을, 언제, 어디서, 왜, 얼마나, 숫자, 이유와 예)을 하나도 빠뜨리지 않고, 원문에 없는 내용을 더하지 않는다.
- 의역을 지나치게 하지 않는다. 문장 순서와 연결어(먼저, 게다가, 그래서, 예를 들면)를 원문대로 살리고, 원문이 여러 문장이면 해석도 같은 수의 문장으로 쓴다.
- 영어 낱말을 그대로 섞지 않는다. 고유명사와 한국어에서도 영어로 쓰는 말만 그대로 둘 수 있다.

[금지]
- 설명, 주석, 영어 원문, 괄호 속 영어를 ko에 넣지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.`;

/** 호출 G 사용자 메시지 형식 (§21-7 원문 그대로) */
export const TOEIC_ISLAND_TRANSLATE_USER_TEMPLATE = `항목 수: {count}
영어 항목:
{items}`;

/** 호출 G 항목 한 줄의 형식 (§21-7 원문 그대로) — 항목끼리는 줄바꿈 하나로 잇는다 */
export const TOEIC_ISLAND_TRANSLATE_ITEM_TEMPLATE = `[{index}] {en}`;

// ===========================================================================
// 플레이스홀더 · 빌더
// ===========================================================================

export const TOEIC_ISLAND_TRANSLATE_PLACEHOLDERS = { count: "{count}", items: "{items}" } as const;
export const TOEIC_ISLAND_TRANSLATE_ITEM_PLACEHOLDERS = { index: "{index}", en: "{en}" } as const;

/** 호출 G 입력 항목 하나 — index는 그 호출 안 순번(0부터, translateIslandSentences가 붙인다) */
export interface ToeicIslandTranslateInputItem {
  index: number;
  en: string;
}

export interface ToeicIslandTranslateInput {
  items: readonly ToeicIslandTranslateInputItem[];
}

/** 호출 G 사용자 메시지(§21-7) — 항목마다 한 줄. 값의 공백·줄바꿈은 한 칸으로 접는다(한 항목 = 한 줄) */
export function buildIslandTranslateUserMessage(input: ToeicIslandTranslateInput): string {
  const P = TOEIC_ISLAND_TRANSLATE_ITEM_PLACEHOLDERS;
  const items = input.items
    .map((it) => fillTemplate(TOEIC_ISLAND_TRANSLATE_ITEM_TEMPLATE, { [P.index]: String(it.index), [P.en]: collapseSpaces(it.en).trim() }))
    .join("\n");
  return fillTemplate(TOEIC_ISLAND_TRANSLATE_USER_TEMPLATE, {
    [TOEIC_ISLAND_TRANSLATE_PLACEHOLDERS.count]: String(input.items.length),
    [TOEIC_ISLAND_TRANSLATE_PLACEHOLDERS.items]: items,
  });
}

// ===========================================================================
// 호출 옵션 (스펙 값 그대로 — §21-7. 모델은 메인 resolveModel — 출제·채점이 아니다)
// ===========================================================================

/** 호출 G — 옮기기 0.2. 한 묶음(영어 3000자 예산)의 해석 */
export const TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS = { call: "toeic_island_translate", temperature: 0.2, maxOutputTokens: 6_000 } as const;

/** 호출 G 전체(첫 요청 + zod 재요청)의 서버 시간 상한 — 요청 하나의 60초 상한(§1-1) 안쪽 */
export const TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS = 45_000;

/** 호출 G의 SDK 자동 재시도 기본값 — 시간 상한이 있는 호출이라 0(retry-after 대기가 신호를 보지 않는다 — docs/HARNESS.md §2) */
export const TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES = 0;

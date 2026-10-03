/**
 * lib/ai/toeic/frame-drill-prompts.ts — 소재별 틀 말하기 호출 E(판정·총평)·F(보충 출제) 프롬프트 + 사용자 메시지 + 호출 옵션
 * (docs/harness/toeic.md §20-5·§20-6)
 *
 * ── spec-sync ─────────────────────────────────────────────────────────────────
 * 아래 `TOEIC_FRAME_*` 문자열 상수는 docs/harness/toeic.md §20 코드블록과 **바이트 단위로 일치**해야 한다
 * (scripts/eval-toeic-frame-drill.ts의 FRAME_DRILL_SPEC_SYNC_TARGETS — eval-toeic.ts가 부른다). 문구를 고치면 스펙도 같이 고친다.
 * 사용자 메시지는 템플릿 상수(줄 템플릿 포함)를 spec-sync하고, 빌더는 prompts.ts의 fillTemplate(단일 패스·모르는 키 throw)로 채운다.
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 설명은 한국어, 학습 대상은 영어. 틀·문장 글자는 런타임에 문제 은행 문서에서 읽는다 — 프롬프트 상수에 교재·틀 원본 글을 박지 않는다(공개 저장소).
 *
 * ⚠️ 서버 전용 모듈에서만 쓴다(calls.ts·eval). 화면은 lib/toeic-frame-drill.ts(클라이언트 안전)만 import한다.
 */

import { collapseSpaces } from "../../toeic-text";
import { frameSlotNames } from "../../toeic-template";
import type { ToeicFrameDrillSupplyPlan } from "../../toeic-frame-drill";
import { fillTemplate } from "./prompts";

// ===========================================================================
// 원문 상수 — docs/harness/toeic.md §20 코드블록 그대로 (손대지 말 것: spec-sync가 바이트 대조)
// ===========================================================================

/** 호출 E 시스템 프롬프트 (§20-5 원문 그대로) */
export const TOEIC_FRAME_JUDGE_SYSTEM_PROMPT = `너는 TOEIC Speaking을 준비하는 한국인 성인 수험자의 "틀 말하기" 연습을 채점하는 코치다. 수험자는 한국어 문장을 보고, 미리 외운 영어 틀(~ 자리에 내용을 채우는 문장 뼈대)로 그 뜻을 영어로 말했다. 문항마다 판정하고 짧게 고쳐 준 뒤, 한 판 전체의 총평과 개선점을 한국어로 준다.

[입력]
- 문항마다 번호, 한국어 문장, 틀 key와 틀(~는 바꿔 끼울 자리), 모범 영어 문장, 그리고 음성 인식으로 얻은 수험자의 답(전사문)을 받는다.
- 전사문은 음성 인식 결과라 발음과 억양을 알 수 없고 인식 오류가 섞여 있을 수 있다. 발음은 평가하지 않는다. 인식 오류로 보이는 단어, 문장부호와 대소문자 차이, 축약형 차이(I'm / I am)는 틀린 것으로 보지 않는다.
- 모범 영어 문장은 참고용이다. ~ 자리를 모범 문장과 다른 말로 채웠어도 한국어 문장의 뜻을 전하면 맞다.

[판정 — verdict]
- correct: 한국어 문장의 뜻을 빠짐없이 전했고, 틀의 ~ 밖 글자를 그대로 썼고, 문법 오류가 없다.
- close: 뜻은 대부분 전했지만 다음 중 하나 이상이다 — 틀의 ~ 밖 글자를 바꾸거나 빼고 다른 말로 말했다, 문법·어휘 실수가 한두 개 있다, 작은 정보 하나가 빠졌다. 틀을 쓰지 않았어도 뜻과 문법이 맞으면 wrong이 아니라 close다.
- wrong: 뜻이 다르거나 절반 이상 빠졌다, 문장을 끝내지 못했다, 영어가 아니다, 다른 문장을 말했다.

[문항별 고침 — items]
- 받은 문항 번호마다 정확히 하나씩 쓴다(no는 받은 번호 그대로).
- correct면 fixedEn은 null이고, reasonKo는 null이거나 잘한 점 한 줄(한국어)이다.
- close·wrong이면 reasonKo에 무엇이 틀렸는지 한 줄(한국어)을, fixedEn에 고친 영어 문장을 쓴다. fixedEn은 수험자가 말한 내용을 살려 틀의 ~ 밖 글자를 그대로 쓰고 ~ 자리만 채운 올바른 문장이다. 살릴 내용이 없으면 모범 영어 문장을 쓴다. ~를 채우지 않은 채 남기지 않는다.

[총평]
- summaryKo: 한 판 전체의 총평 2~3문장(한국어). 얼마나 맞혔는지와 되풀이된 실수의 경향을 말한다.
- improvements: 다음 연습에서 고칠 점 2~4개(한국어, 한 줄씩). 어떤 틀이나 어떤 문법을 어떻게 고칠지 구체적으로 쓴다.
- strongFrames: 잘 쓴 틀의 key 0~3개. weakFrames: 약한 틀의 key 0~3개. 받은 틀 key를 그대로 쓰고, 한 key를 두 목록에 함께 넣지 않는다.

[금지]
- 전사문에 없는 말을 수험자가 했다고 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.`;

/** 호출 E 사용자 메시지 형식 (§20-5 원문 그대로) */
export const TOEIC_FRAME_JUDGE_USER_TEMPLATE = `문항 수: {count}
문항:
{items}`;

/** 호출 E 문항 한 개의 형식 (§20-5 원문 그대로) — 문항끼리는 빈 줄 하나로 잇는다 */
export const TOEIC_FRAME_JUDGE_ITEM_TEMPLATE = `[{no}]
한국어: {ko}
틀({frameKey}): {frame}
모범 영어: {en}
수험자 답: {transcript}`;

/** 호출 F 시스템 프롬프트 (§20-6 원문 그대로) */
export const TOEIC_FRAME_SUPPLY_SYSTEM_PROMPT = `너는 TOEIC Speaking을 준비하는 한국인 성인 수험자의 "틀 말하기" 연습 문항을 새로 만드는 출제자다. 문항 하나는 한국어 문장 하나와, 그 뜻을 미리 외운 영어 틀로 말한 모범 영어 문장 하나다. 모범 영어 문장은 앱이 틀의 {자리}에 네가 쓴 채움(fills)을 넣어 만든다.

[만들기]
- 받은 틀 목록의 틀마다 적힌 개수만큼 만든다. 전체 개수는 '만들 문항 수'와 같다. frameKey에는 그 틀의 key를 그대로 쓴다.
- fills: 틀의 {자리}에 넣을 영어를 자리 순서대로, 자리 수와 같은 개수로 쓴다. 틀의 {자리} 밖 글자는 앱이 그대로 쓰므로 fills에 넣지 않는다.
- 틀에 '채움 후보'(자리=영어(한국어 뜻))가 있으면 그 자리에는 후보의 영어를 글자 그대로 먼저 골라 쓰고, 이미 있는 문장과 다른 조합이 되게 고른다. 후보로 자연스러운 문장이 되지 않거나 겹치면 새 채움을 쓴다. 후보를 쓴 자리의 한국어는 후보의 한국어 뜻을 살린다.
- 틀에 '질문 유형'이 있으면 그 유형의 질문에 대한 답으로 쓸 수 있는 문장으로 만든다.
- 자리가 문장 맨 앞이면 그 채움은 대문자로 시작한다. 채운 문장 전체가 문법에 맞고 자연스러워야 한다.
- 채운 영어 문장은 TOEIC Speaking Q5–7(듣고 답하기)·Q11(의견 말하기) 답변에서 그대로 쓸 만한 문장으로, 20단어를 넘지 않게 쓴다. 수준은 IM3~IH 수험자가 말할 수 있는 쉬운 낱말이다.
- 내용은 그 틀의 소재를 따르고, 직장·기술·경제·건강·환경·교육·생활처럼 성인이 경험으로 말할 수 있는 것으로 쓴다.
- ko: 수험자가 보고 그 영어 문장으로 말할 한국어 문장이다. 영어 문장의 뜻을 빠짐없이 담은 자연스러운 한국어로 쓰고, 영어 낱말을 섞지 않는다.
- '이미 있는 한국어 문장'과 같은 문장이나 낱말만 살짝 바꾼 문장을 만들지 않는다. 새로 만드는 문항끼리도 겹치지 않게 내용을 다양하게 한다.

[금지]
- 실제 기출 문항, 교재 예문, 실존 기업·유명인 이름을 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.`;

/** 호출 F 사용자 메시지 형식 (§20-6 원문 그대로) */
export const TOEIC_FRAME_SUPPLY_USER_TEMPLATE = `만들 문항 수: {count}
틀 목록:
{frames}
이미 있는 한국어 문장:
{existing}`;

/** 호출 F 틀 한 줄의 형식 (§20-6 원문 그대로) */
export const TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE = `- {frameKey} | 소재: {topic} | 질문 유형: {questionTypes} | 틀: {frameEn} | 뜻: {frameKo} | 자리: {slots} | 채움 후보: {fillOptions} | {want}개`;

// ===========================================================================
// 플레이스홀더 · 빌더
// ===========================================================================

export const TOEIC_FRAME_JUDGE_PLACEHOLDERS = { count: "{count}", items: "{items}" } as const;
export const TOEIC_FRAME_JUDGE_ITEM_PLACEHOLDERS = {
  no: "{no}",
  ko: "{ko}",
  frameKey: "{frameKey}",
  frame: "{frame}",
  en: "{en}",
  transcript: "{transcript}",
} as const;
export const TOEIC_FRAME_SUPPLY_PLACEHOLDERS = { count: "{count}", frames: "{frames}", existing: "{existing}" } as const;
export const TOEIC_FRAME_SUPPLY_FRAME_PLACEHOLDERS = {
  frameKey: "{frameKey}",
  topic: "{topic}",
  questionTypes: "{questionTypes}",
  frameEn: "{frameEn}",
  frameKo: "{frameKo}",
  slots: "{slots}",
  fillOptions: "{fillOptions}",
  want: "{want}",
} as const;

/** 채움 후보 → 틀 줄 값: `{자리}=영어(한국어)`를 " / "로, 없으면 "없음". 상한(틀당 40)은 가져오기 zod가 이미 건다 */
export function formatFrameFillOptions(options: readonly { slot: string; en: string; ko: string }[]): string {
  if (options.length === 0) return "없음";
  return options.map((o) => `${collapseSpaces(o.slot)}=${collapseSpaces(o.en)}(${collapseSpaces(o.ko)})`).join(" / ");
}

/** 호출 E 입력 문항 하나 — no는 한 판 안 순번(lib/toeic-frame-drill.ts frameDrillJudgeTargets) */
export interface ToeicFrameJudgeInputItem {
  no: number;
  ko: string;
  frameKey: string;
  /** `~` 형태 틀(frameToExpression) */
  frame: string;
  en: string;
  transcript: string;
}

export interface ToeicFrameJudgeInput {
  items: readonly ToeicFrameJudgeInputItem[];
}

/** 호출 E 사용자 메시지(§20-5) — 문항마다 줄 템플릿, 문항끼리 빈 줄. 값의 공백은 접는다 */
export function buildFrameJudgeUserMessage(input: ToeicFrameJudgeInput): string {
  const P = TOEIC_FRAME_JUDGE_ITEM_PLACEHOLDERS;
  const items = input.items
    .map((it) =>
      fillTemplate(TOEIC_FRAME_JUDGE_ITEM_TEMPLATE, {
        [P.no]: String(it.no),
        [P.ko]: collapseSpaces(it.ko),
        [P.frameKey]: it.frameKey,
        [P.frame]: collapseSpaces(it.frame),
        [P.en]: collapseSpaces(it.en),
        [P.transcript]: collapseSpaces(it.transcript),
      }),
    )
    .join("\n\n");
  return fillTemplate(TOEIC_FRAME_JUDGE_USER_TEMPLATE, {
    [TOEIC_FRAME_JUDGE_PLACEHOLDERS.count]: String(input.items.length),
    [TOEIC_FRAME_JUDGE_PLACEHOLDERS.items]: items,
  });
}

/** 호출 F 사용자 메시지(§20-6) — 계획의 틀마다 한 줄(질문 유형·채움 후보 포함, 없으면 "없음"), 이미 있는 한국어 문장은 `- ` 줄(없으면 "없음") */
export function buildFrameSupplyUserMessage(plan: ToeicFrameDrillSupplyPlan): string {
  const P = TOEIC_FRAME_SUPPLY_FRAME_PLACEHOLDERS;
  const frames = plan.frames
    .map((x) =>
      fillTemplate(TOEIC_FRAME_SUPPLY_FRAME_TEMPLATE, {
        [P.frameKey]: x.frame.key,
        [P.topic]: collapseSpaces(x.topicNameKo),
        [P.questionTypes]: x.questionTypeNamesKo.length > 0 ? x.questionTypeNamesKo.map(collapseSpaces).join(", ") : "없음",
        [P.fillOptions]: formatFrameFillOptions(x.frame.fillOptions),
        [P.frameEn]: collapseSpaces(x.frame.frameEn),
        [P.frameKo]: collapseSpaces(x.frame.frameKo),
        [P.slots]: frameSlotNames(x.frame.frameEn).join(", "),
        [P.want]: String(x.want),
      }),
    )
    .join("\n");
  const existing = plan.existingKo.length > 0 ? plan.existingKo.map((k) => `- ${collapseSpaces(k)}`).join("\n") : "없음";
  return fillTemplate(TOEIC_FRAME_SUPPLY_USER_TEMPLATE, {
    [TOEIC_FRAME_SUPPLY_PLACEHOLDERS.count]: String(plan.count),
    [TOEIC_FRAME_SUPPLY_PLACEHOLDERS.frames]: frames,
    [TOEIC_FRAME_SUPPLY_PLACEHOLDERS.existing]: existing,
  });
}

// ===========================================================================
// 호출 옵션 (스펙 값 그대로 — §20-5·§20-6. 모델은 resolveToeicModel — 토익 출제·채점)
// ===========================================================================

/** 호출 E — 평가 0.2. 문항 20개 × (판정·이유·고친 문장) + 총평 */
export const TOEIC_FRAME_JUDGE_CALL_OPTIONS = { call: "toeic_frame_judge", temperature: 0.2, maxOutputTokens: 5_000 } as const;

/** 호출 F — 출제 0.8. 문항 최대 10개 */
export const TOEIC_FRAME_SUPPLY_CALL_OPTIONS = { call: "toeic_frame_supply", temperature: 0.8, maxOutputTokens: 3_000 } as const;

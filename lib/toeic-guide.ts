/**
 * lib/toeic-guide.ts — 토익스피킹 **유형별 공략** 읽기 대본·정리·표시 분할 순수 함수 (docs/harness/toeic.md §12-4·§12-5-2)
 *
 * - 공략 읽기(① 탭)의 낭독 대본 `buildToeicGuideScript`, 줄의 읽을 영어 `guideLineEn`(이어 말하기 합성), TTS 정리 둘
 *   (`cleanGuideEnForTts`·`cleanGuideKoForTts`), 강조·밑줄·자리 표시 분할 `splitGuideEnForDisplay`를 여기 한 곳에 둔다.
 *   화면은 판단하지 않고 소비만 한다(§6-3·§18-1 관용구).
 * - 따라 말할 틈 `shadowPauseMs`(세 단계)도 여기 산다 — 공략 읽기 "영어만"의 틈과 템플릿 따라 말하기(lib/toeic-template.ts)가
 *   **같은 함수**를 쓴다(§12-5-2). 템플릿 모듈이 이 모듈을 import하므로 이 모듈은 템플릿 모듈을 import하지 않는다(순환 금지).
 * - 유형 폴더 이름표(`TOEIC_GUIDE_PARTS`)와 결정적 문서 id(`guide-{part}`·`guide-templates`)의 단일 정의처이기도 하다
 *   (lib/ai/toeic/schemas.ts가 여기서 가져간다 — TOEIC_MOCK_PARTS가 lib/toeic-mock.ts에 사는 것과 같은 관용구).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/tts-shared·lib/tts-split·lib/ja-coaching-script(normalizeKoForTts)·
 * lib/toeic-text(countWords)뿐, lib/ai는 `import type`만. 정규식 lookbehind 금지(구형 iOS Safari).
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { splitForTts } from "./tts-split";
import { normalizeKoForTts } from "./ja-coaching-script";
import { countWords, hasLatin } from "./toeic-text";
import type { ToeicGuideBlock, ToeicGuideLine, ToeicGuideSection } from "./ai/toeic/schemas";
import type { ToeicMockPart } from "./toeic-mock";

// ---------------------------------------------------------------------------
// 유형 폴더·문서 id (§12-2-2·§12-2-5·§12-3)
// ---------------------------------------------------------------------------

/** 공략 유형 — ToeicPart에서 q1_2를 뺀 넷(Q1–2는 단순 읽기라 공략 폴더가 없다, §12-0) */
export const TOEIC_GUIDE_PARTS = ["q3_4", "q5_7", "q8_10", "q11"] as const;
export type ToeicGuidePart = (typeof TOEIC_GUIDE_PARTS)[number];

export function isToeicGuidePart(v: unknown): v is ToeicGuidePart {
  return typeof v === "string" && (TOEIC_GUIDE_PARTS as readonly string[]).includes(v);
}

/** 공략 유형 → 모의고사 파트(연습 생성기·유형 이름표가 같은 표를 본다, §12-7-1) */
export const TOEIC_GUIDE_PART_TO_MOCK_PART: Readonly<Record<ToeicGuidePart, ToeicMockPart>> = {
  q3_4: "picture",
  q5_7: "respond",
  q8_10: "info",
  q11: "opinion",
};

/**
 * 모의고사 파트 → 공략 유형(TOEIC_GUIDE_PART_TO_MOCK_PART의 역, §12-13-3). `read`(Q1–2)는 공략 폴더가 없어 null — 답변 흐름도 없다.
 */
export function toeicGuidePartOfMockPart(mockPart: ToeicMockPart): ToeicGuidePart | null {
  for (const p of TOEIC_GUIDE_PARTS) if (TOEIC_GUIDE_PART_TO_MOCK_PART[p] === mockPart) return p;
  return null;
}

/** 공략 세트 문서 id 접두어 — 결정적 id `guide-{part}`(점 없음 — 경로 조각에 점을 쓰면 PIN 게이트 정적 예외에 걸린다, §12-8) */
export const TOEIC_GUIDE_SET_ID_PREFIX = "guide-";
/** 틀 은행 문서 id(§12-3) — 유형 공략과 같은 `toeicSets` 컬렉션, 문서 하나 */
export const TOEIC_TEMPLATE_BANK_ID = "guide-templates";
/** 멱등 판정의 "유형 자리" 값 — 틀 은행은 이 자리 하나를 가진다(§12-2-5) */
export const TOEIC_TEMPLATE_BANK_SLOT = "templates" as const;
/** 틀 은행 세트 제목(§12-3) */
export const TOEIC_TEMPLATE_BANK_TITLE_KO = "템플릿 훈련";

/** 유형 공략 세트 문서 id — `guide-q3_4` 꼴 */
export function toeicGuideSetId(part: ToeicGuidePart): string {
  return `${TOEIC_GUIDE_SET_ID_PREFIX}${part}`;
}

// ---------------------------------------------------------------------------
// 자리 `{…}` 훑기 — 가져오기 zod·표시 분할·틀 모듈이 같은 판정을 쓴다(§12-2-3)
// ---------------------------------------------------------------------------

/** 자리 이름 길이 상한(§12-2-3 "안이 1~20자") */
export const TOEIC_GUIDE_SLOT_NAME_MAX = 20;

export interface ToeicSlotSpan {
  /** `{` 위치 */
  start: number;
  /** `}` 다음 위치(exclusive) */
  end: number;
  /** 괄호 안 글자(그대로 — trim하지 않는다) */
  name: string;
}

export type ToeicSlotProblem = "unbalanced" | "nested" | "empty" | "too_long";

/**
 * `{…}` 자리를 앞에서부터 훑는다. 짝이 맞지 않음(여는 괄호만·닫는 괄호만)·겹침(`{a{b}}`)·빈 자리(공백뿐 포함)·20자 초과를
 * 문제로 모은다. 문제가 있어도 짝이 맞은 자리는 slots에 담는다(표시 분할이 망가지지 않게).
 */
export function scanSlots(text: string): { slots: ToeicSlotSpan[]; problems: ToeicSlotProblem[] } {
  const slots: ToeicSlotSpan[] = [];
  const problems = new Set<ToeicSlotProblem>();
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (open >= 0) problems.add("nested");
      open = i;
    } else if (ch === "}") {
      if (open < 0) {
        problems.add("unbalanced");
        continue;
      }
      const name = text.slice(open + 1, i);
      if (name.trim() === "") problems.add("empty");
      else if (name.length > TOEIC_GUIDE_SLOT_NAME_MAX) problems.add("too_long");
      slots.push({ start: open, end: i + 1, name });
      open = -1;
    }
  }
  if (open >= 0) problems.add("unbalanced");
  return { slots, problems: [...problems] };
}

/** 자리 밖 글자만 — 자리 `{…}`를 지운 문자열(한글이 자리 밖에 있는지 등을 볼 때) */
export function textOutsideSlots(text: string): string {
  return text.replace(/\{[^{}]*\}/g, " ");
}

// ---------------------------------------------------------------------------
// 줄의 읽을 영어 — 이어 말하기 합성 (§12-4)
// ---------------------------------------------------------------------------

/**
 * 줄의 읽을 영어. `completions` 블록이면 머리말 + " " + 조각(완성 문장), 그 밖에는 줄 `en` 그대로.
 * 대본·줄 🔊·프리페치·말하기 문항 합성(§12-2-1)이 **모두 이 함수 하나**를 거친다 — 글자가 같아야 캐시가 맞는다.
 */
export function guideLineEn(block: ToeicGuideBlock, line: Pick<ToeicGuideLine, "en">): string | null {
  if (line.en === null) return null;
  if (block.kind === "lines" && block.style === "completions" && block.lead && block.lead.en) {
    return `${block.lead.en.trimEnd()} ${line.en.trimStart()}`;
  }
  return line.en;
}

// ---------------------------------------------------------------------------
// TTS 정리 (§12-4) — 정리 **뒤** splitForTts
// ---------------------------------------------------------------------------

/**
 * 영어 조각 정리: 자리 `{…}`와 물결(`~`·`～`·`〜`)은 말줄임표 `…`(쉼, 바로 뒤의 쉼표·마침표는 뗀다), `/`는 `, `(대안 나열),
 * 소괄호는 떼고 안의 글은 남긴다(생략 가능 단어), 문장부호 앞 공백 제거·연속 공백 접기·trim.
 * 예(지어낸 것): `My pick is {선택}, mainly since {이유}.` → `My pick is … mainly since …`, `It looks busy/crowded.` → `It looks busy, crowded.`
 */
export function cleanGuideEnForTts(text: string): string {
  return (text ?? "")
    .replace(/\{[^{}]*\}/g, "…")
    .replace(/[~～〜]/g, "…")
    .replace(/…[,.]+/g, "…")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/[()]/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 한국어 조각 정리. **먼저** 자리 표시(`~`·`～`·`〜`·en dash `–`)와 이름 있는 자리 `{…}`를 `…`(쉼)로 바꾸고(자리 이름은 읽지 않는다 —
 * "{활동}은" → "…은"), 공식 표기 `+`와 `/`를 `, `로 바꾼 뒤 normalizeKoForTts(화살표·이모지, SPEC §18-1)를 부른다.
 * 순서가 중요하다 — normalizeKoForTts는 전각 물결을 **지운다**. 공략의 `~`는 문장 가운데에 조사와 붙어 있어, 지우면 조사만 남는다.
 */
export function cleanGuideKoForTts(text: string): string {
  const s = (text ?? "")
    .replace(/\{[^{}]*\}/g, "…")
    .replace(/[~～〜–]/g, "…")
    .replace(/\s*[+/]\s*/g, ", ");
  return normalizeKoForTts(s);
}

// ---------------------------------------------------------------------------
// 따라 말할 틈 (§12-5-2) — 공략 읽기 "영어만"과 템플릿 따라 말하기가 같은 함수
// ---------------------------------------------------------------------------

/** 속도 1 기준 쉼 공식 — clamp(700 + 400 × 낱말 수, 1500, 8000) */
export const TOEIC_SHADOW_PAUSE = { baseMs: 700, perWordMs: 400, minMs: 1500, maxMs: 8000 } as const;
/** 틈 길이 세 단계(검토 S2 — 성인 학습자는 원어민의 1.3~1.5배 걸린다) */
export const TOEIC_SHADOW_PAUSE_LEVELS = { short: 0.8, normal: 1, long: 1.5 } as const;
export type ToeicShadowPauseLevel = keyof typeof TOEIC_SHADOW_PAUSE_LEVELS;
export const TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT: ToeicShadowPauseLevel = "normal";

/**
 * 따라 말할 틈(ms, 속도 1 기준) = clamp(700 + 400 × countWords(text), 1500, 8000) × 단계 배율. 재생할 때 큐가 실제 말 속도로 나눈다.
 * 지어낸 예: 8낱말 → 보통 3,900 · 짧게 3,120 · 길게 5,850.
 */
export function shadowPauseMs(text: string, level: ToeicShadowPauseLevel = TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT): number {
  const P = TOEIC_SHADOW_PAUSE;
  const base = Math.min(P.maxMs, Math.max(P.minMs, P.baseMs + P.perWordMs * countWords(text)));
  const k = TOEIC_SHADOW_PAUSE_LEVELS[level] ?? 1;
  return Math.round(base * k);
}

// ---------------------------------------------------------------------------
// 공략 읽기 대본 (§12-4 표)
// ---------------------------------------------------------------------------

export const TOEIC_GUIDE_SCRIPT_MODES = ["all", "english-only"] as const;
export type ToeicGuideScriptMode = (typeof TOEIC_GUIDE_SCRIPT_MODES)[number];
export const TOEIC_GUIDE_SCRIPT_MODE_LABELS_KO: Record<ToeicGuideScriptMode, string> = { all: "전부", "english-only": "영어만" };

export type ToeicGuideLang = "en-US" | "ko-KR";

/** 대본 조각의 주소 — block null = 섹션 제목·소개, line null = 블록 단위(제목·본문·캡션), "lead" = 머리말 줄 */
export interface ToeicGuideScriptPiece {
  text: string;
  lang: ToeicGuideLang;
  section: number;
  block: number | null;
  line: number | "lead" | null;
  /** 이 조각 뒤 따라 말할 틈(ms, 속도 1 기준). 0이면 틈 없음 — speakQueue는 0 이하를 쉼 없는 경로로 탄다 */
  pauseAfterMs: number;
}

/** 대본 주소 키 — 블록 `"s:b"`(§12-13-1 ToeicGuideReadMarks·ToeicGuideScriptSkip이 같은 모양을 쓴다) */
export function toeicGuideBlockKey(section: number, block: number): string {
  return `${section}:${block}`;
}

/** 대본 주소 키 — 줄 `"s:b:l"` 또는 머리말 줄 `"s:b:lead"` */
export function toeicGuideLineKey(section: number, block: number, line: number | "lead"): string {
  return `${section}:${block}:${line}`;
}

/**
 * 공략 읽기 대본에서 뺄 것(§12-13-1 — 같은 자리 다른 표현). 화면은 `guideReadMarks`(lib/toeic-guide-view.ts) 결과로 만든다 —
 * `{ blocks: altBlocks의 키, lines: altLines의 키, bareLeads: bareBlocks의 키, picks: framePicks }`.
 */
export interface ToeicGuideScriptSkip {
  /** 블록 키 — 그 블록의 조각 전부(캡션·머리말·줄)를 내지 않는다 */
  blocks: ReadonlySet<string>;
  /** 줄 키 — 그 줄의 조각을 내지 않는다(bareLeads 블록의 머리말 줄 포함) */
  lines: ReadonlySet<string>;
  /** 블록 키 — 이어 말하기 줄의 읽을 영어를 머리말 없이 줄 en 그대로(guideLineEn 대신) */
  bareLeads: ReadonlySet<string>;
  /** 줄 키 → 그 줄 영어 대신 읽을 글자(슬래시 대안 중 외울 틀 쪽 — 정리 함수·쪼개기는 그대로 거친다) */
  picks: ReadonlyMap<string, string>;
}

export interface ToeicGuideScriptOptions {
  /** "영어만"의 따라 말할 틈 — 기본 끔(§12-4 검토 반영). "전부"에서는 켜도 0이다 */
  pause?: boolean;
  pauseLevel?: ToeicShadowPauseLevel;
  /**
   * 같은 자리 다른 표현 빼기(§12-13-1 — 2026-10-02). 함수 입력이라 선택 칸이다. **없으면(또는 네 칸이 모두 비면) 지금과 글자까지 같은 대본**.
   */
  skip?: ToeicGuideScriptSkip;
}

/** 조각 만들기 — 정리 → 라틴 없는 영어는 버림 → splitForTts(…, 300), 틈은 마지막 조각에만. 대본·머리말 🔊(toeicGuideLeadPieces)이 같은 함수 */
function guidePieces(
  raw: string | null | undefined,
  lang: ToeicGuideLang,
  section: number,
  block: number | null,
  line: number | "lead" | null,
  pauseMs: (cleaned: string) => number,
): ToeicGuideScriptPiece[] {
  if (raw === null || raw === undefined) return [];
  const cleaned = lang === "en-US" ? cleanGuideEnForTts(raw) : cleanGuideKoForTts(raw);
  if (cleaned === "") return [];
  if (lang === "en-US" && !hasLatin(cleaned)) return [];
  const pieces = splitForTts(cleaned, TTS_TEXT_MAX_CHARS);
  const pause = pauseMs(cleaned);
  return pieces.map((text, k) => ({ text, lang, section, block, line, pauseAfterMs: k === pieces.length - 1 ? pause : 0 }));
}

/**
 * 공략 한 유형의 낭독 대본(§12-4 표 순서). 조각은 정리 뒤 splitForTts(…, 300)를 거친다 — trim·비어 있지 않음·≤300·lang 명시.
 * 라틴 문자가 남지 않는 영어 조각은 만들지 않는다. `label`·`note`·`marked`·유형 소개(introKo)는 읽지 않는다.
 * - all: 섹션 titleKo → introKo → 블록들 / heading textKo / text titleKo → bodyKo → 줄들 / list·template captionKo → lead → 줄들 /
 *   completions captionKo → lead.ko → 줄들(lead.en은 줄마다 들어 있다) / 줄 = 읽을 영어 → ko → example.en → example.ko
 * - english-only: 블록들 / text 줄들 / list·template lead → 줄들 / completions 줄들 / 줄 = 읽을 영어 → example.en
 * 틈(pauseAfterMs)은 english-only + opts.pause일 때 영어 조각에만 싣는다(조각이 나뉘면 마지막 조각에만).
 */
export function buildToeicGuideScript(
  guide: { sections: readonly ToeicGuideSection[] },
  mode: ToeicGuideScriptMode,
  opts: ToeicGuideScriptOptions = {},
): ToeicGuideScriptPiece[] {
  const out: ToeicGuideScriptPiece[] = [];
  const englishOnly = mode === "english-only";
  const withPause = englishOnly && opts.pause === true;
  const level = opts.pauseLevel ?? TOEIC_SHADOW_PAUSE_LEVEL_DEFAULT;
  const skip = opts.skip;

  const push = (raw: string | null | undefined, lang: ToeicGuideLang, section: number, block: number | null, line: number | "lead" | null) => {
    out.push(...guidePieces(raw, lang, section, block, line, (cleaned) => (lang === "en-US" && withPause ? shadowPauseMs(cleaned, level) : 0)));
  };

  /** 줄의 읽을 영어 — bareLeads 블록이면 머리말 없이 줄 en, framePicks가 있으면 그 글자, 그 밖은 guideLineEn */
  const lineEn = (b: ToeicGuideBlock, ln: ToeicGuideLine, s: number, bi: number, li: number | "lead"): string | null => {
    if (skip && li !== "lead" && skip.bareLeads.has(toeicGuideBlockKey(s, bi))) return ln.en;
    const pick = skip?.picks.get(toeicGuideLineKey(s, bi, li));
    return pick !== undefined ? pick : guideLineEn(b, ln);
  };

  const pushLine = (b: ToeicGuideBlock, ln: ToeicGuideLine, s: number, bi: number, li: number | "lead") => {
    if (skip && skip.lines.has(toeicGuideLineKey(s, bi, li))) return;
    push(lineEn(b, ln, s, bi, li), "en-US", s, bi, li);
    if (!englishOnly) push(ln.ko, "ko-KR", s, bi, li);
    if (ln.example) {
      push(ln.example.en, "en-US", s, bi, li);
      if (!englishOnly) push(ln.example.ko, "ko-KR", s, bi, li);
    }
  };

  guide.sections.forEach((sec, s) => {
    if (!englishOnly) {
      push(sec.titleKo, "ko-KR", s, null, null);
      push(sec.introKo, "ko-KR", s, null, null);
    }
    sec.blocks.forEach((b, bi) => {
      if (skip && skip.blocks.has(toeicGuideBlockKey(s, bi))) return;
      switch (b.kind) {
        case "heading":
          if (!englishOnly) push(b.textKo, "ko-KR", s, bi, null);
          return;
        case "text":
          if (!englishOnly) {
            push(b.titleKo, "ko-KR", s, bi, null);
            push(b.bodyKo, "ko-KR", s, bi, null);
          }
          b.lines.forEach((ln, li) => pushLine(b, ln, s, bi, li));
          return;
        case "lines":
          if (!englishOnly) push(b.captionKo, "ko-KR", s, bi, null);
          if (b.style === "completions") {
            // 머리말 영어는 줄마다 합성 문장에 들어 있다 — 따로 읽지 않는다. 한국어 머리말만 한 번.
            if (!englishOnly && b.lead && !(skip && skip.lines.has(toeicGuideLineKey(s, bi, "lead")))) push(b.lead.ko, "ko-KR", s, bi, "lead");
          } else if (b.lead) {
            pushLine(b, b.lead, s, bi, "lead");
          }
          b.lines.forEach((ln, li) => pushLine(b, ln, s, bi, li));
          return;
      }
    });
  });
  return out;
}

/**
 * 접힌 이어 말하기 머리말의 🔊(§12-13-1 — bareBlocks). 원래 대본에는 머리말 영어 조각이 따로 없어(줄마다 합성 문장 안에만 있다)
 * 탭할 때 이것을 만든다 — `lead.en` 한 조각 en-US + "전부"면 `lead.ko` 한 조각 ko-KR(같은 정리 함수·쪼개기, 틈 없음). 미리 받지 않는다.
 * completions 블록이 아니거나 머리말이 없으면 빈 배열.
 */
export function toeicGuideLeadPieces(block: ToeicGuideBlock, section: number, blockIndex: number, mode: ToeicGuideScriptMode): ToeicGuideScriptPiece[] {
  if (block.kind !== "lines" || block.style !== "completions" || !block.lead) return [];
  const none = () => 0;
  const en = guidePieces(block.lead.en, "en-US", section, blockIndex, "lead", none);
  return mode === "english-only" ? en : [...en, ...guidePieces(block.lead.ko, "ko-KR", section, blockIndex, "lead", none)];
}

/** 줄 🔊 조각 = 대본에서 그 줄 주소로 거른 것(§12-4 — 섹션 재생·프리페치와 같은 글자) */
export function toeicGuideLinePieces(
  script: readonly ToeicGuideScriptPiece[],
  section: number,
  block: number,
  line: number | "lead",
): ToeicGuideScriptPiece[] {
  return script.filter((p) => p.section === section && p.block === block && p.line === line);
}

/** 블록 🔊 조각(`text` 블록 🔊 — 그 블록의 제목·본문·줄 전부) */
export function toeicGuideBlockPieces(script: readonly ToeicGuideScriptPiece[], section: number, block: number): ToeicGuideScriptPiece[] {
  return script.filter((p) => p.section === section && p.block === block);
}

/** 섹션 ▶의 시작 인덱스(절대 인덱스 — speakQueue에 잘라 넘기고 오프셋을 더한다, §18-4). 조각이 없으면 -1 */
export function toeicGuideSectionStart(script: readonly ToeicGuideScriptPiece[], section: number): number {
  return script.findIndex((p) => p.section === section);
}

/**
 * 프리페치 목록 — 열린 섹션들(생략하면 전부)의 **영어 조각만** 문서 순서로, 같은 글자는 한 번. 한국어는 미리 받지 않는다(§12-4 비용 가드).
 * 상한(PREFETCH_MAX_ITEMS 90)은 prefetchSpeech가 자른다.
 */
export function toeicGuidePrefetchTexts(script: readonly ToeicGuideScriptPiece[], sections?: ReadonlySet<number>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of script) {
    if (p.lang !== "en-US") continue;
    if (sections && !sections.has(p.section)) continue;
    if (seen.has(p.text)) continue;
    seen.add(p.text);
    out.push(p.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 표시 분할 — 자리 칩·형광·밑줄 (§12-4 화면)
// ---------------------------------------------------------------------------

export interface ToeicGuideTextSegment {
  /** 원문 조각(이어 붙이면 원문과 같다 — 자리 조각은 `{이름}` 그대로) */
  text: string;
  /** 자리 조각이면 자리 이름(칩), 아니면 null */
  slot: string | null;
  emphasis: boolean;
  underline: boolean;
}

/**
 * 같은 배열 안: 각 구간은 **첫 등장** 위치로 잡고, 긴 것 먼저(같으면 앞에 나오는 것, 그다음 배열 순서) 칠한다. 이미 칠한 구간과
 * 겹치면 뒤의 것을 건너뛴다.
 */
function markRanges(text: string, marks: readonly string[], into: Uint8Array): void {
  const order = marks
    .map((m, i) => ({ m, i, at: m.length > 0 ? text.indexOf(m) : -1 }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => b.m.length - a.m.length || a.at - b.at || a.i - b.i);
  for (const { m, at } of order) {
    let overlap = false;
    for (let k = at; k < at + m.length; k++) {
      if (into[k]) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    for (let k = at; k < at + m.length; k++) into[k] = 1;
  }
}

/**
 * 공략 영어 줄 표시 분할 — 글자마다 표시(자리·형광·밑줄)를 매긴 뒤 같은 표시가 이어지는 구간으로 묶는다.
 * 형광과 밑줄은 서로 겹쳐도 둘 다 보인다. 이어 붙이면 원문과 같다. 모든 글은 텍스트로만 넣는다(HTML 해석 없음 — 화면 몫).
 */
export function splitGuideEnForDisplay(en: string, emphasis: readonly string[], underline: readonly string[]): ToeicGuideTextSegment[] {
  const n = en.length;
  if (n === 0) return [];
  const slotOf = new Int32Array(n).fill(-1);
  const { slots } = scanSlots(en);
  slots.forEach((s, i) => {
    for (let k = s.start; k < s.end; k++) slotOf[k] = i;
  });
  const emph = new Uint8Array(n);
  const under = new Uint8Array(n);
  markRanges(en, emphasis, emph);
  markRanges(en, underline, under);
  const out: ToeicGuideTextSegment[] = [];
  let from = 0;
  for (let k = 1; k <= n; k++) {
    const boundary = k === n || slotOf[k] !== slotOf[from] || emph[k] !== emph[from] || under[k] !== under[from];
    if (!boundary) continue;
    const si = slotOf[from];
    out.push({ text: en.slice(from, k), slot: si >= 0 ? slots[si].name : null, emphasis: emph[from] === 1, underline: under[from] === 1 });
    from = k;
  }
  return out;
}

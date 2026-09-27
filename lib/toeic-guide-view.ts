/**
 * lib/toeic-guide-view.ts — 유형별 공략 **화면**이 판단하는 자리를 모은 순수 함수 (docs/harness/toeic.md §12-4·§12-5-1·§12-5-2·§12-5-7·§12-8)
 *
 * 폴더 목록(틀 n·익힘 m)·폴더 탭(기본 탭·`?tab=`)·틀 탭(열지 못한 틀·이어서 하기·배지 문구)·따라 말하기 바(범위 여섯·지금 위치·
 * 다음/이 예문 머리·이어 듣기 기억·설정 기억)·읽기 탭(블록 🧩 칩·교재 틀 연결 주소·`goto` 블록 찾기)이 판단하는 것을 여기 한 곳에 둔다.
 * 화면 컴포넌트는 판단하지 않고 소비만 한다(§6-3·§18-1 관용구) — eval-toeic "공략 화면 순수 함수"가 이 모듈을 잠근다.
 *
 * 틀·대본의 규칙 자체(흐름 순서·대본·예상 시간·이어 듣기 위치·연결 표)는 lib/toeic-template.ts·lib/toeic-guide.ts가 단일 정의처다 —
 * 여기서는 그 함수들을 조합만 한다(다시 정의하지 않는다).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/toeic-guide·lib/toeic-template·lib/toeic-record·lib/toeic-text·lib/vocab-mastery뿐,
 * lib/toeic-quiz·lib/ai는 `import type`만. localStorage·window를 읽지 않는다(문자열을 받아 문자열을 돌려준다 — 저장은 화면 몫). 정규식 lookbehind 금지.
 */

import { TOEIC_GUIDE_PARTS, type ToeicGuidePart } from "./toeic-guide";
import {
  TOEIC_SHADOW_REPEAT_DEFAULT,
  aggregateToeicTemplateStats,
  clampShadowRepeat,
  flattenTemplateFlow,
  shadowResumeIndex,
  type ToeicShadowPauseLevel,
  type ToeicShadowPiece,
  type ToeicTemplateBadge,
  type ToeicTemplateFlowGroup,
  type ToeicTemplateGuideLinks,
} from "./toeic-template";
import { isRenderableToeicTemplate } from "./toeic-record";
import { collapseSpaces, expressionKey } from "./toeic-text";
import { isStatMastered, type WordStat } from "./vocab-mastery";
import type { ToeicQuizMode, ToeicQuizSessionLike } from "./toeic-quiz";
import type { ToeicGuideBlock, ToeicGuideSection, ToeicTemplate, ToeicTemplateGuideRef } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 폴더 탭 (§12-8)
// ---------------------------------------------------------------------------

/** 탭 순서 = 학습 흐름(① 읽기 ② 템플릿 훈련 ③ 표현 시험 ④ 한 문제 연습) */
export const TOEIC_GUIDE_TABS = ["read", "templates", "quiz", "drill"] as const;
export type ToeicGuideTab = (typeof TOEIC_GUIDE_TABS)[number];

export const TOEIC_GUIDE_TAB_LABELS_KO: Record<ToeicGuideTab, string> = {
  read: "📖 공략 읽기",
  templates: "🧩 템플릿 훈련",
  quiz: "📝 표현 시험",
  drill: "🎤 한 문제 연습",
};

/**
 * 주소의 `?tab=` → 열 탭. 모르는 값·아직 없는 탭(available 밖)은 기본 탭으로 — **그 유형 틀이 1개 이상이면 ② 템플릿 훈련, 없으면 ① 읽기**
 * (템플릿 반복이 핵심 — 폴더를 여는 대부분의 이유, §12-8). 기기에 마지막 탭을 기억하지 않는다(주소만 — §12-12 10).
 */
export function resolveGuideTab(param: string | null | undefined, templateCount: number, available: readonly ToeicGuideTab[] = TOEIC_GUIDE_TABS): ToeicGuideTab {
  if (param && (available as readonly string[]).includes(param)) return param as ToeicGuideTab;
  return templateCount > 0 && available.includes("templates") ? "templates" : "read";
}

/** 폴더 이름 순서(폴더 목록) — TOEIC_GUIDE_PARTS 그대로 */
export const TOEIC_GUIDE_FOLDER_ORDER: readonly ToeicGuidePart[] = TOEIC_GUIDE_PARTS;

// ---------------------------------------------------------------------------
// 틀 은행 → 그 유형 틀 (§12-3 렌더 판정 · §12-5-1 "열지 못한 틀 n개")
// ---------------------------------------------------------------------------

/**
 * 틀 은행 items(정규화 뒤 — 모양은 믿지 않는다) → 그 유형의 **렌더 가능한** 틀(파일 순서)과 열지 못한 틀 수.
 * 모양이 깨진 틀은 그 틀만 빠진다. 깨진 틀 중 `parts`를 읽을 수 없는 것은 어느 폴더 것인지 몰라 모든 폴더에서 센다.
 */
export function guideTemplatesForPart(items: readonly unknown[], part: ToeicGuidePart): { templates: ToeicTemplate[]; broken: number } {
  const templates: ToeicTemplate[] = [];
  let broken = 0;
  for (const it of items ?? []) {
    if (isRenderableToeicTemplate(it)) {
      const t = it as ToeicTemplate;
      if (t.parts.includes(part)) templates.push(t);
      continue;
    }
    const parts = (it as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts) || parts.includes(part)) broken += 1;
  }
  return { templates, broken };
}

// ---------------------------------------------------------------------------
// 숙련도 표시 (§12-5-6 — 폴더 카드·단계 칩의 "익힘 m" = 틀 바꿔 말하기 졸업)
// ---------------------------------------------------------------------------

/** 틀 바꿔 말하기(`tpl-swap`)에서 졸업한 틀 key — 폴더 카드·단계 칩의 "익힘"(두 모드 중 더 어려운 쪽, 검토 B2) */
export function templateSwapMasteredKeys(sessions: readonly ToeicQuizSessionLike[]): Set<string> {
  const stats = aggregateToeicTemplateStats(sessions)["tpl-swap"];
  const out = new Set<string>();
  for (const [key, st] of Object.entries(stats)) if (isStatMastered(st)) out.add(key);
  return out;
}

/** 틀 목록 중 익힌 수 */
export function countMastered(templates: readonly Pick<ToeicTemplate, "key">[], mastered: ReadonlySet<string>): number {
  return templates.filter((t) => mastered.has(t.key)).length;
}

/**
 * "이어서 하기"(검토 S10) — 흐름 순서로 첫 **미졸업 묶음**(그 묶음 틀 중 틀 바꿔 말하기에서 졸업하지 않은 틀이 있는 첫 묶음).
 * 모두 졸업이면 null(화면: "다 익혔어요 — 🧩 틀 테스트로 복습").
 */
export function nextShadowGroup(groups: readonly ToeicTemplateFlowGroup[], mastered: ReadonlySet<string>): ToeicTemplateFlowGroup | null {
  return groups.find((g) => g.templates.some((t) => !mastered.has(t.key))) ?? null;
}

/** 배지 문구(§12-5-6) — 키가 없으면(시도 0) 안 해 봄 */
export const TOEIC_TEMPLATE_BADGE_LABELS_KO: Record<ToeicTemplateBadge, string> = {
  new: "안 해 봄",
  progress: "진행 중",
  today: "오늘 ○ — 내일 한 번 더",
  wrong: "✕ 다시",
  mastered: "🎓 익힘",
};

/** 표현 시험 한 모드의 상태(읽기만 — 틀 카드에 나란히, §12-5-7). 시도가 없으면 null(표시하지 않는다) */
export function expressionStatBadge(st: WordStat | undefined): "mastered" | "progress" | "wrong" | null {
  if (!st || st.total === 0) return null;
  if (isStatMastered(st)) return "mastered";
  return st.streak > 0 ? "progress" : "wrong";
}

export const TOEIC_EXPRESSION_BADGE_LABELS_KO = { mastered: "🎓", progress: "진행 중", wrong: "✕" } as const;

/** 틀 카드의 표현 시험 상태를 보는 두 모드(§12-5-7 "뜻→표현 🎓 · 표현→뜻 ✕") */
export const TOEIC_TEMPLATE_CARD_EXPRESSION_MODES: readonly ToeicQuizMode[] = ["ko-to-expr", "expr-to-ko"];

// ---------------------------------------------------------------------------
// 따라 말하기 범위 (§12-5-2 — 여섯)
// ---------------------------------------------------------------------------

export const TOEIC_SHADOW_RANGES = ["group", "step", "from", "template", "wrong", "all"] as const;
export type ToeicShadowRange = (typeof TOEIC_SHADOW_RANGES)[number];

export const TOEIC_SHADOW_RANGE_LABELS_KO: Record<ToeicShadowRange, string> = {
  group: "이 묶음",
  step: "이 단계",
  from: "여기부터 끝까지",
  template: "이 틀",
  wrong: "틀린 틀만",
  all: "유형 전체",
};

export interface ToeicShadowSelection {
  /** 고른 묶음(기본 — 이어서 하기 묶음) */
  groupKo: string | null;
  /** 카드 ▶로 고른 틀 */
  templateKey: string | null;
}

/**
 * 범위의 틀(흐름 순서 — §12-5-1 templateFlowOrder 결과를 그대로 자른다).
 * - group: 고른 묶음 · step: 고른 묶음이 단계 묶음이면 그 단계의 묶음 전부, 소재·기타 묶음이면 소재·기타 묶음 전부("소재별 틀")
 * - from: 고른 묶음부터 흐름 끝까지(검토 S3 — 출퇴근 30~60분을 탭 없이) · template: 그 틀 하나
 * - wrong: 두 테스트 모드 중 하나라도 틀렸고 미졸업(toeicTemplateWrongKeysAnyMode) · all: 유형 전체
 * 고른 묶음을 찾지 못하면 group·step은 빈 목록, from은 전체다.
 */
export function shadowRangeTemplates(
  groups: readonly ToeicTemplateFlowGroup[],
  range: ToeicShadowRange,
  sel: ToeicShadowSelection,
  wrongKeys: ReadonlySet<string>,
): ToeicTemplate[] {
  const gi = groups.findIndex((g) => g.groupKo === sel.groupKo);
  const g = gi >= 0 ? groups[gi] : null;
  switch (range) {
    case "group":
      return g ? [...g.templates] : [];
    case "step":
      if (!g) return [];
      return g.kind === "step"
        ? flattenTemplateFlow(groups.filter((x) => x.kind === "step" && x.stepKo === g.stepKo))
        : flattenTemplateFlow(groups.filter((x) => x.kind !== "step"));
    case "from":
      return flattenTemplateFlow(gi >= 0 ? groups.slice(gi) : groups);
    case "template":
      return flattenTemplateFlow(groups).filter((t) => t.key === sel.templateKey);
    case "wrong":
      return flattenTemplateFlow(groups).filter((t) => wrongKeys.has(t.key));
    case "all":
      return flattenTemplateFlow(groups);
  }
}

/** 범위 칩 이름 — "이 단계"는 고른 묶음이 소재 묶음이면 "소재 묶음 전체"로 */
export function shadowRangeLabelKo(range: ToeicShadowRange, groups: readonly ToeicTemplateFlowGroup[], sel: ToeicShadowSelection): string {
  if (range === "step") {
    const g = groups.find((x) => x.groupKo === sel.groupKo);
    if (g && g.kind !== "step") return "소재 묶음 전체";
  }
  return TOEIC_SHADOW_RANGE_LABELS_KO[range];
}

/**
 * 재생 범위의 이름(잠금 화면 부제·바 표시) — 묶음 이름·단계 이름 등 **앱이 붙인 분류 이름**만 쓴다(틀·예문 글은 넣지 않는다).
 */
export function shadowRangeTitleKo(range: ToeicShadowRange, groups: readonly ToeicTemplateFlowGroup[], sel: ToeicShadowSelection): string {
  const g = groups.find((x) => x.groupKo === sel.groupKo) ?? null;
  switch (range) {
    case "group":
      return g ? g.groupKo : TOEIC_SHADOW_RANGE_LABELS_KO.group;
    case "step":
      return g ? (g.kind === "step" && g.stepKo ? g.stepKo : "소재 묶음 전체") : TOEIC_SHADOW_RANGE_LABELS_KO.step;
    case "from":
      return g ? `${g.groupKo}부터 끝까지` : TOEIC_SHADOW_RANGE_LABELS_KO.from;
    case "template": {
      const owner = groups.find((x) => x.templates.some((t) => t.key === sel.templateKey));
      return owner ? `${owner.groupKo} · 틀 하나` : TOEIC_SHADOW_RANGE_LABELS_KO.template;
    }
    case "wrong":
    case "all":
      return TOEIC_SHADOW_RANGE_LABELS_KO[range];
  }
}

/** 유형 짧은 표시 — "Q3–4"·"Q11"(공통 틀 칩 "Q5–7 · Q11 공통") */
export function guidePartShortKo(part: string): string {
  return `Q${part.slice(1).replace("_", "–")}`;
}

/** 예상 시간 표시 — "약 n분"(1분 미만은 "약 1분"), 60분 이상은 "약 h시간 m분" */
export function formatShadowDurationKo(ms: number): string {
  const min = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 60_000));
  if (min < 60) return `약 ${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `약 ${h}시간` : `약 ${h}시간 ${m}분`;
}

// ---------------------------------------------------------------------------
// 따라 말하기 — 지금 위치·다음 예문·이어 듣기 기억 (§12-5-2)
// ---------------------------------------------------------------------------

export interface ToeicShadowPosition {
  key: string;
  /** 1부터 — 대본 안 틀 순서 */
  tplNo: number;
  tplTotal: number;
  /** 1부터. 틀 소개 조각이면 null */
  exampleNo: number | null;
  exampleTotal: number;
  /** 1부터 — 영어 반복 번호. 한국어·소개 조각이면 null */
  rep: number | null;
  repeat: number;
  lang: "en-US" | "ko-KR";
}

/** 대본 index 조각의 위치("틀 3/12 · 예문 2/4 · 영어 3/4"). 범위 밖이면 null */
export function shadowPositionAt(script: readonly ToeicShadowPiece[], index: number): ToeicShadowPosition | null {
  if (!Number.isInteger(index) || index < 0 || index >= script.length) return null;
  const cur = script[index];
  const keys: string[] = [];
  const seen = new Set<string>();
  let exampleTotal = 0;
  let repeat = 0;
  for (const p of script) {
    if (!seen.has(p.key)) {
      seen.add(p.key);
      keys.push(p.key);
    }
    if (p.key !== cur.key) continue;
    if (p.example !== null) exampleTotal = Math.max(exampleTotal, p.example + 1);
    if (p.example === cur.example) repeat = Math.max(repeat, p.rep);
  }
  return {
    key: cur.key,
    tplNo: keys.indexOf(cur.key) + 1,
    tplTotal: keys.length,
    exampleNo: cur.example === null ? null : cur.example + 1,
    exampleTotal,
    rep: cur.rep > 0 ? cur.rep : null,
    repeat,
    lang: cur.lang,
  };
}

/** "틀 3/12 · 예문 2/4 · 영어 3/4" */
export function shadowPositionLabelKo(pos: ToeicShadowPosition): string {
  const parts = [`틀 ${pos.tplNo}/${pos.tplTotal}`];
  if (pos.exampleNo === null) parts.push("틀 소개");
  else {
    parts.push(`예문 ${pos.exampleNo}/${pos.exampleTotal}`);
    parts.push(pos.rep === null ? "한국어" : `영어 ${pos.rep}/${pos.repeat}`);
  }
  return parts.join(" · ");
}

/**
 * ⏭(잠금 화면 nexttrack) — 지금 조각 뒤 **다음 예문 머리**(다음 예문의 한국어 조각, 틀이 바뀌면 그 틀의 첫 조각 — 소개 포함).
 * 없으면 -1(마지막 예문).
 */
export function shadowNextHeadIndex(script: readonly Pick<ToeicShadowPiece, "key" | "example">[], index: number): number {
  if (script.length === 0) return -1;
  const from = Math.max(0, Math.min(Math.floor(Number.isFinite(index) ? index : 0), script.length - 1));
  const cur = script[from];
  for (let j = from + 1; j < script.length; j++) {
    const p = script[j];
    const prev = script[j - 1];
    const isHead = p.key !== prev.key || (p.example !== null && p.example !== prev.example);
    if (isHead && !(p.key === cur.key && p.example === cur.example)) return j;
  }
  return -1;
}

/** ⏮(previoustrack)·이어 듣기 — 지금 예문의 머리(lib/toeic-template shadowResumeIndex 그대로 — 다시 정의하지 않는다) */
export const shadowHeadIndex = shadowResumeIndex;

/**
 * 대본 내용 서명 — 이어 듣기 위치를 대본 내용(범위·반복·틈·소개가 만든 조각 글자들)마다 기억한다(§12-5-2). 대본이 바뀌면(틀 교정·설정
 * 변경) 서명이 달라져 이어 듣기가 꺼진다. FNV-1a 32비트 16진 + 조각 수.
 */
export function shadowScriptSignature(script: readonly { text: string; lang: string; pauseAfterMs: number }[], extra = ""): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(extra);
  for (const p of script) feed(`\n${p.lang}|${p.pauseAfterMs}|${p.text}`);
  return `${h.toString(16).padStart(8, "0")}-${script.length}`;
}

/** 이어 듣기 기억 개수 상한(기기 localStorage — 최근 것부터) */
export const TOEIC_SHADOW_RESUME_MAX = 30;

function parseResumeList(json: string | null): [string, number][] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is [string, number] => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && Number.isInteger(x[1]) && (x[1] as number) >= 0,
    );
  } catch {
    return [];
  }
}

/** 기억한 이어 듣기 위치(마지막으로 **시작한** 조각 번호). 없거나 깨졌으면 null */
export function readShadowResume(json: string | null, sig: string): number | null {
  const hit = parseResumeList(json).find(([s]) => s === sig);
  return hit ? hit[1] : null;
}

/** 이어 듣기 위치를 기억한 새 JSON — 같은 서명은 맨 앞으로, 상한을 넘으면 오래된 것부터 버린다 */
export function writeShadowResume(json: string | null, sig: string, index: number, max = TOEIC_SHADOW_RESUME_MAX): string {
  const list = parseResumeList(json).filter(([s]) => s !== sig);
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return JSON.stringify([[sig, i], ...list].slice(0, Math.max(1, max)));
}

/** 이어 듣기 기억을 지운 새 JSON(끝까지 들었을 때) */
export function clearShadowResume(json: string | null, sig: string): string {
  return JSON.stringify(parseResumeList(json).filter(([s]) => s !== sig));
}

// ---------------------------------------------------------------------------
// 따라 말하기 설정 기억 (§12-5-2 "반복·틈·소개는 기기에 기억한다" — 읽기 탭 "영어만" 틈 단계도 같은 기기 설정)
// ---------------------------------------------------------------------------

export interface ToeicShadowSettings {
  repeat: number;
  /** 따라 말할 틈 켬/끔 */
  pause: boolean;
  pauseLevel: ToeicShadowPauseLevel;
  /** 한국어 틀 소개 */
  intro: boolean;
  /** 영어 틀 소개(기본 끔 — 검토 S16) */
  introEn: boolean;
}

export const TOEIC_SHADOW_SETTINGS_DEFAULT: ToeicShadowSettings = {
  repeat: TOEIC_SHADOW_REPEAT_DEFAULT,
  pause: true,
  pauseLevel: "normal",
  intro: true,
  introEn: false,
};

const PAUSE_LEVELS: readonly ToeicShadowPauseLevel[] = ["short", "normal", "long"];

/** 기기 저장값(JSON 문자열) → 설정. 없거나 깨진 칸은 기본값 */
export function parseShadowSettings(json: string | null): ToeicShadowSettings {
  const d = TOEIC_SHADOW_SETTINGS_DEFAULT;
  if (!json) return { ...d };
  try {
    const v = JSON.parse(json) as Partial<Record<keyof ToeicShadowSettings, unknown>> | null;
    if (!v || typeof v !== "object") return { ...d };
    return {
      repeat: typeof v.repeat === "number" ? clampShadowRepeat(v.repeat) : d.repeat,
      pause: typeof v.pause === "boolean" ? v.pause : d.pause,
      pauseLevel: typeof v.pauseLevel === "string" && (PAUSE_LEVELS as readonly string[]).includes(v.pauseLevel) ? (v.pauseLevel as ToeicShadowPauseLevel) : d.pauseLevel,
      intro: typeof v.intro === "boolean" ? v.intro : d.intro,
      introEn: typeof v.introEn === "boolean" ? v.introEn : d.introEn,
    };
  } catch {
    return { ...d };
  }
}

// ---------------------------------------------------------------------------
// 틀 표시 — 자리 색 (§12-5-1 "자리 순서마다 다른 색, 기존 CSS 변수만")
// ---------------------------------------------------------------------------

/** 자리 색 가짓수(자리는 틀마다 1~4개 — zod) */
export const TOEIC_SLOT_TONE_COUNT = 4;

/**
 * 자리 이름 → 색 번호(0~3). 영어·한국어 틀의 같은 자리 이름이 같은 번호가 되게, 화면은 **영어 틀의 자리 순서**(frameSlotNames(frameEn))로
 * 이 표를 만들고 한국어 틀의 자리는 이름으로 찾는다(zod가 두 틀의 자리 이름 모임이 같음을 보장한다).
 */
export function slotToneMap(slotNames: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  slotNames.forEach((n, i) => {
    if (!m.has(n)) m.set(n, i % TOEIC_SLOT_TONE_COUNT);
  });
  return m;
}

// ---------------------------------------------------------------------------
// 교재 틀과 오가기 (§12-4 🧩 칩 · §12-5-7 📘 교재 틀 칩)
// ---------------------------------------------------------------------------

/** 읽기 탭 `?goto=` 값 — 답변 틀 단계(템플릿 줄 label) / 이어 말하기 머리말 */
export const TOEIC_GUIDE_GOTO_TEMPLATE_PREFIX = "t:";
export const TOEIC_GUIDE_GOTO_LEAD_PREFIX = "l:";

/** 폴더 주소 */
export function toeicGuideFolderHref(part: ToeicGuidePart, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams(params).toString();
  return `/toeic/guides/${part}${qs ? `?${qs}` : ""}`;
}

/**
 * 📘 교재 틀 칩의 연결 하나 → 갈 주소. expression → ③ 탭 그 표현(`?tab=quiz&expr=`), template·lead → ① 탭 그 블록(`?tab=read&goto=`).
 * 다른 유형의 연결이면 그 유형 폴더로 간다(주소가 유형을 담는다).
 */
export function guideRefHref(ref: ToeicTemplateGuideRef): string {
  if (ref.kind === "expression") return toeicGuideFolderHref(ref.part, { tab: "quiz", expr: ref.expression });
  if (ref.kind === "template") return toeicGuideFolderHref(ref.part, { tab: "read", goto: `${TOEIC_GUIDE_GOTO_TEMPLATE_PREFIX}${ref.step}` });
  return toeicGuideFolderHref(ref.part, { tab: "read", goto: `${TOEIC_GUIDE_GOTO_LEAD_PREFIX}${ref.leadEn}` });
}

/** 연결 한 줄 이름("표현 · …" / "답변 틀 · …" / "머리말 · …"), 다른 유형이면 앞에 유형 표시 */
export function guideRefLabelKo(ref: ToeicTemplateGuideRef, currentPart: ToeicGuidePart): string {
  const what = ref.kind === "expression" ? `표현 · ${ref.expression}` : ref.kind === "template" ? `답변 틀 · ${ref.step}` : `머리말 · ${ref.leadEn}`;
  return ref.part === currentPart ? what : `${guidePartShortKo(ref.part)} ${what}`;
}

/**
 * 읽기 탭 `?goto=` → 그 블록(섹션·블록 번호). `t:{label}` = 그 label의 템플릿 줄이 든 style "template" 블록, `l:{leadEn}` = 머리말이
 * 같은(공백 정리) completions 블록. 못 찾으면 null.
 */
export function findGuideGotoBlock(sections: readonly ToeicGuideSection[], goto: string | null | undefined): { section: number; block: number } | null {
  if (!goto) return null;
  const isT = goto.startsWith(TOEIC_GUIDE_GOTO_TEMPLATE_PREFIX);
  const isL = goto.startsWith(TOEIC_GUIDE_GOTO_LEAD_PREFIX);
  if (!isT && !isL) return null;
  const want = goto.slice(2);
  for (let s = 0; s < sections.length; s++) {
    const blocks = sections[s].blocks;
    for (let b = 0; b < blocks.length; b++) {
      const bl = blocks[b];
      if (bl.kind !== "lines") continue;
      if (isT && bl.style === "template" && bl.lines.some((ln) => ln.label !== null && ln.label.trim() === want.trim())) return { section: s, block: b };
      if (isL && bl.style === "completions" && bl.lead?.en && collapseSpaces(bl.lead.en) === collapseSpaces(want)) return { section: s, block: b };
    }
  }
  return null;
}

/** goto 블록의 화면 주소(`data-addr` — 읽기 탭 블록 주소와 같은 모양 `b:{섹션}:{블록}`). 없으면 null */
export function guideGotoAddr(hit: { section: number; block: number } | null): string | null {
  return hit ? `b:${hit.section}:${hit.block}` : null;
}

/**
 * 읽기 탭 섹션의 **첫 렌더** 열림(§12-4 "첫 섹션만 열림" + §12-5-7 goto "섹션을 열고 스크롤") — 첫 섹션, 그리고 `?goto=` 목표가 있으면
 * 그 섹션. 목표 섹션을 첫 렌더(서버 HTML 포함)부터 열어 두어야 마운트 직후 스크롤이 닫힌 `<details>` 안 블록(상자 없음 —
 * scrollIntoView가 아무것도 안 한다)을 만나지 않는다(QA final P2-1 — 앱 안 이동·새로 불러오기·다른 폴더 전부 마운트 경로다).
 */
export function guideReadInitialOpen(sections: readonly ToeicGuideSection[], goto: string | null | undefined): number[] {
  const out = sections.length > 0 ? [0] : [];
  const hit = findGuideGotoBlock(sections, goto);
  if (hit && !out.includes(hit.section)) out.push(hit.section);
  return out;
}

/**
 * 블록 머리 🧩 칩 — 그 블록을 가리키는 틀 key들(§12-4 검토 B5): style "template"이면 줄 label들이 연결된 틀, completions면 머리말이
 * 연결된 틀. 그 밖의 블록은 빈 배열(목록 줄은 줄 머리 칩 — guideLineTemplateKeys).
 */
export function guideBlockTemplateKeys(links: ToeicTemplateGuideLinks, block: ToeicGuideBlock): string[] {
  if (block.kind !== "lines") return [];
  const out: string[] = [];
  const push = (keys: readonly string[] | undefined) => {
    for (const k of keys ?? []) if (!out.includes(k)) out.push(k);
  };
  if (block.style === "template") {
    for (const ln of block.lines) if (ln.label !== null) push(links.templateLabels.get(ln.label) ?? links.templateLabels.get(ln.label.trim()));
  } else if (block.style === "completions" && block.lead?.en) {
    push(links.leads.get(collapseSpaces(block.lead.en)));
  }
  return out;
}

/** ③ 탭 `?expr=` → 표현 목록 번호(expressionKey 같음 — 대소문자·공백 차이 무시). 없으면 -1 */
export function findGuideExpressionIndex(expressions: readonly { expression: string }[], expr: string | null | undefined): number {
  if (!expr) return -1;
  const k = expressionKey(expr);
  return expressions.findIndex((e) => expressionKey(e.expression) === k);
}

// ---------------------------------------------------------------------------
// 공략 표현 시험 화면의 "뒤로" (§12-3 표 "뒤로·이동 링크" · §12-6)
// ---------------------------------------------------------------------------

/** 세트가 유형 공략이면 그 유형(guide.kind "part" — kind가 없으면 "part"로 읽는다), 아니면 null(표현집·틀 은행·깨진 guide) */
export function toeicGuidePartOfSet(set: { guide: unknown }): ToeicGuidePart | null {
  const g = set.guide;
  if (g === null || typeof g !== "object") return null;
  const kind = (g as { kind?: unknown }).kind;
  const part = (g as { part?: unknown }).part;
  if (kind !== undefined && kind !== "part") return null;
  return typeof part === "string" && (TOEIC_GUIDE_PARTS as readonly string[]).includes(part) ? (part as ToeicGuidePart) : null;
}

/** 시험·오답노트·기록 화면의 "뒤로" — 헤더 링크(`labelKo`)와 끝 화면 버튼(`buttonKo`) */
export interface ToeicSetBackLink {
  href: string;
  labelKo: string;
  buttonKo: string;
}

/**
 * 세트 → "뒤로"(서버 페이지가 내려준다). 유형 공략이면 그 유형 폴더의 ③ 표현 시험 탭("← Q3–4 공략"), 표현집이면 표현집 상세
 * ("← 표현집으로" — 기존 문구 그대로). 틀 은행·깨진 공략은 폴더 목록(이 화면들에 오지 않지만 — 리다이렉트·404 — 문구가 틀리지 않게).
 */
export function toeicSetBackLink(set: { id: string; guide: unknown }): ToeicSetBackLink {
  const part = toeicGuidePartOfSet(set);
  if (part) {
    const short = guidePartShortKo(part);
    return { href: toeicGuideFolderHref(part, { tab: "quiz" }), labelKo: `← ${short} 공략`, buttonKo: `🧭 ${short} 공략으로` };
  }
  if (set.guide !== null && set.guide !== undefined) return { href: "/toeic/guides", labelKo: "← 유형별 공략", buttonKo: "🧭 유형별 공략으로" };
  return { href: `/toeic/sets/${encodeURIComponent(set.id)}`, labelKo: "← 표현집으로", buttonKo: "📒 표현집으로" };
}

/**
 * lib/toeic-template-test-view.ts — 🧩 틀 테스트 **화면**이 판단하는 자리를 모은 순수 함수 (docs/harness/toeic.md §12-5-3·§12-5-4·§12-5-6)
 *
 * 테스트 주소(`?mode=recall|swap&scope=group|step|wrong|all&group=&step=`) 풀기·만들기, 범위의 틀, (나) 틀 바꿔 말하기의 단서
 * (한국어 틀 + 영어 채움 칩), 유효한 시도 판정, 비용 표시, 저장 항목·끝 화면 요약, ② 탭의 최근 테스트·틀린 틀 수를 여기 한 곳에 둔다.
 * 화면 컴포넌트(components/toeic-template-test.tsx·toeic-template-view.tsx)는 판단하지 않고 소비만 한다 — eval-toeic이 이 모듈을 잠근다.
 *
 * 틀·비교·숙련도 규칙 자체(문항 고르기·전사 비교·같은 날 ○ 접기·상한)는 lib/toeic-template.ts가 단일 정의처다 — 여기서는 조합만 한다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/toeic-template·lib/toeic-quiz·lib/toeic-guide-view·lib/kst뿐, lib/ai는 `import type`만.
 * window·localStorage를 읽지 않는다. 정규식 lookbehind 금지.
 */

import { formatKst } from "./kst";
import { toeicGuideFolderHref } from "./toeic-guide-view";
import { TOEIC_TEMPLATE_QUIZ_MODES, TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO, type ToeicQuizSessionLike, type ToeicTemplateQuizMode } from "./toeic-quiz";
import {
  TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION,
  flattenTemplateFlow,
  frameSlotNames,
  splitFrameForDisplay,
  templateItemKey,
  templateKeyFromItemKey,
  toeicTemplateWrongKeys,
  type ToeicTemplateFlowGroup,
} from "./toeic-template";
import type { ToeicGuidePart } from "./toeic-guide";
import type { ToeicTemplate } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 주소 (§12-5-3 경로)
// ---------------------------------------------------------------------------

/** 주소의 모드 값 ↔ 기록 모드 */
export const TOEIC_TEMPLATE_TEST_MODE_BY_PARAM = { recall: "tpl-recall", swap: "tpl-swap" } as const satisfies Record<string, ToeicTemplateQuizMode>;
export type ToeicTemplateTestModeParam = keyof typeof TOEIC_TEMPLATE_TEST_MODE_BY_PARAM;

export function templateTestModeParam(mode: ToeicTemplateQuizMode): ToeicTemplateTestModeParam {
  return mode === "tpl-swap" ? "swap" : "recall";
}

/** 화면 이름 — (가) 예문 말하기 · (나) 틀 바꿔 말하기(모드 이름은 lib/toeic-quiz 단일 정의처) */
export const TOEIC_TEMPLATE_TEST_MODE_TAG_KO: Record<ToeicTemplateQuizMode, string> = {
  "tpl-recall": `(가) ${TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO["tpl-recall"]}`,
  "tpl-swap": `(나) ${TOEIC_TEMPLATE_QUIZ_MODE_LABELS_KO["tpl-swap"]}`,
};

/** 모드 한 줄 설명(시작 화면) */
export const TOEIC_TEMPLATE_TEST_MODE_HINT_KO: Record<ToeicTemplateQuizMode, string> = {
  "tpl-recall": "한국어 뜻만 보고 외운 예문을 영어로 말해요.",
  "tpl-swap": "영어 글자 없이 — 예문을 소리로만 듣고, 한국어 틀에 끼운 새 영어 채움으로 같은 틀의 새 문장을 말해요.",
};

export const TOEIC_TEMPLATE_TEST_SCOPES = ["group", "step", "wrong", "all"] as const;
export type ToeicTemplateTestScope = (typeof TOEIC_TEMPLATE_TEST_SCOPES)[number];

export interface ToeicTemplateTestParams {
  mode: ToeicTemplateQuizMode;
  scope: ToeicTemplateTestScope;
  group: string | null;
  step: string | null;
}

const one = (v: string | string[] | undefined | null): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s : null;
};

/** 주소 → 테스트 조건. 모르는 모드는 (가) 예문 말하기, 모르는 범위는 묶음(group) — 틀린 값이 화면을 막지 않게 */
export function parseTemplateTestParams(sp: Record<string, string | string[] | undefined>): ToeicTemplateTestParams {
  const m = one(sp.mode);
  const mode = m !== null && m in TOEIC_TEMPLATE_TEST_MODE_BY_PARAM ? TOEIC_TEMPLATE_TEST_MODE_BY_PARAM[m as ToeicTemplateTestModeParam] : "tpl-recall";
  const sc = one(sp.scope);
  const scope = sc !== null && (TOEIC_TEMPLATE_TEST_SCOPES as readonly string[]).includes(sc) ? (sc as ToeicTemplateTestScope) : "group";
  return { mode, scope, group: one(sp.group), step: one(sp.step) };
}

/** 테스트 주소 — `/toeic/guides/{part}/templates/test?mode=&scope=&group=&step=`(값이 없는 칸은 싣지 않는다) */
export function toeicTemplateTestHref(
  part: ToeicGuidePart,
  p: { mode: ToeicTemplateQuizMode; scope: ToeicTemplateTestScope; group?: string | null; step?: string | null },
): string {
  const qs = new URLSearchParams({ mode: templateTestModeParam(p.mode), scope: p.scope });
  if (p.group) qs.set("group", p.group);
  if (p.step) qs.set("step", p.step);
  return `/toeic/guides/${part}/templates/test?${qs.toString()}`;
}

/** 테스트에서 폴더 ② 탭으로(끝 화면 "폴더로"·헤더) — 틀 카드(`tpl`)나 따라 말하기 범위(`range`)를 실을 수 있다 */
export function toeicTemplateTabHref(part: ToeicGuidePart, extra: { tpl?: string; range?: "wrong" } = {}): string {
  const params: Record<string, string> = { tab: "templates" };
  if (extra.tpl) params.tpl = extra.tpl;
  if (extra.range) params.range = extra.range;
  return toeicGuideFolderHref(part, params);
}

/**
 * 범위의 틀(흐름 순서 — templateFlowOrder 결과를 자른다)과 범위 이름.
 * - group: 그 묶음 · step: `step`이 있으면 그 단계의 묶음 전부, 없고 `group`이 소재·기타 묶음이면 소재·기타 묶음 전부("소재 묶음 전체"),
 *   단계 묶음이면 그 묶음의 단계 · wrong·all: 유형 전체(틀린 틀만은 문항 고르기의 onlyWrong이 거른다 — 그 모드의 틀린 틀).
 * 못 찾으면 빈 목록(화면: "틀이 없어요").
 */
export function templateTestScopeTemplates(
  groups: readonly ToeicTemplateFlowGroup[],
  p: Pick<ToeicTemplateTestParams, "scope" | "group" | "step">,
): { templates: ToeicTemplate[]; labelKo: string } {
  if (p.scope === "all") return { templates: flattenTemplateFlow(groups), labelKo: "유형 전체" };
  if (p.scope === "wrong") return { templates: flattenTemplateFlow(groups), labelKo: "틀린 틀만" };
  if (p.scope === "group") {
    const g = groups.find((x) => x.groupKo === p.group) ?? null;
    return g ? { templates: [...g.templates], labelKo: `묶음 · ${g.groupKo}` } : { templates: [], labelKo: "묶음" };
  }
  // step
  const stepKo = p.step ?? groups.find((x) => x.groupKo === p.group && x.kind === "step")?.stepKo ?? null;
  if (stepKo !== null) {
    const gs = groups.filter((x) => x.kind === "step" && x.stepKo === stepKo);
    return gs.length > 0 ? { templates: flattenTemplateFlow(gs), labelKo: `단계 · ${stepKo}` } : { templates: [], labelKo: "단계" };
  }
  const g = groups.find((x) => x.groupKo === p.group) ?? null;
  if (g && g.kind !== "step") return { templates: flattenTemplateFlow(groups.filter((x) => x.kind !== "step")), labelKo: "소재 묶음 전체" };
  return { templates: [], labelKo: "단계" };
}

// ---------------------------------------------------------------------------
// 한 문항 (§12-5-3)
// ---------------------------------------------------------------------------

/** (나) 단서 조각 — 한국어 틀의 고정 글(slot null)과, 자리마다 이번 문항의 **영어 채움**(slot = 영어 틀 자리 순서 — 색을 맞춘다) */
export interface ToeicTemplateClueSegment {
  text: string;
  slot: number | null;
  /** 자리 이름(칩 aria용) */
  name: string | null;
}

/**
 * (나) 틀 바꿔 말하기의 단서 = 한국어 틀 `frameKo`의 자리마다 영어 채움 칩(§12-5-3 검토 B2 — 영어 틀·예문 글은 보이지 않는다).
 * 자리 이름으로 영어 틀의 자리 순서를 찾아 그 채움을 끼운다(한국어 어순이 영어와 달라도 이름이 짝을 잇는다). 이름을 못 찾으면 이름 그대로.
 * 칩이 아닌 조각(한국어 틀의 고정 글·못 찾은 자리 이름)은 maskLatinForTestKo를 지난다 — 화면의 영어 글자는 채움 칩뿐이다
 * (지금 원본의 한국어 틀에는 라틴이 없다 — 교정 가져오기로 들어와도 (나) "영어 글자 0"이 깨지지 않게, QA S2 P2-1).
 */
export function templateSwapClue(frameKo: string, frameEn: string, fills: readonly string[]): ToeicTemplateClueSegment[] {
  const order = frameSlotNames(frameEn);
  return splitFrameForDisplay(frameKo).map((g) => {
    if (g.name === null) return { text: maskLatinForTestKo(g.text), slot: null, name: null };
    const i = order.indexOf(g.name);
    if (i >= 0 && i < fills.length) return { text: fills[i], slot: i, name: g.name };
    return { text: maskLatinForTestKo(g.name), slot: i >= 0 ? i : null, name: g.name };
  });
}

/** 가린 영어 자리 표시 — 한 글자 말줄임표(U+2026) */
export const TOEIC_TEMPLATE_TEST_LATIN_MASK = "…";

// 라틴 낱말 하나(붙은 숫자까지 — "Q11"·"9am"·"B2B"가 "…11"처럼 반쯤 남지 않게)
const LATIN_WORD_RE = /\p{Nd}*\p{Script=Latin}[\p{Script=Latin}\p{Nd}]*/gu;
// 가린 자리 사이가 문장부호·공백·숫자뿐이면(한글·한자·괄호가 없으면) 한 자리로 접는다 — "… … …"·"…·…"·"… / …" → "…"
const MASK_RUN_RE = /…(?:[^\p{Script=Hangul}\p{Script=Han}(){}\[\]（）]*?…)+/gu;

/**
 * 테스트 화면에 보이는 한국어 글(묶음 이름·`useKo`·(나) 한국어 틀 조각)에서 **라틴 글자를 모두 "…"로 가린다**(§12-5-3 — (가) "틀과
 * 영어는 가린다"·(나) "영어 글자는 하나도 보이지 않는다", QA S2 P2-1). `useKo`는 zod가 한글 포함만 요구해 영어를 담을 수 있다 — 원본
 * 152틀 중 38틀이 라틴을, 26틀이 그 틀의 영어 **고정 낱말**을 담아, 그대로 보이면 (나) 테스트가 "틀을 꺼냈나"를 재지 못한다.
 * 이어진 영어 구간(낱말 사이가 공백·문장부호뿐)은 "…" 하나가 된다. 한글·한자·괄호·중괄호는 그대로, 앞뒤 공백도 그대로다(조각을
 * 이어 붙이는 쓰임이 있어 다듬지 않는다 — 머리 줄은 templateTestPromptMeta가 다듬는다). 예문 한국어 뜻(`answerKo`)에는 쓰지 않는다
 * (라틴은 고유명사·약어뿐이고 틀 고정 낱말이 없다 — QA 실측 30/650 예문, 고정 낱말 0).
 */
export function maskLatinForTestKo(text: string): string {
  return text.replace(LATIN_WORD_RE, TOEIC_TEMPLATE_TEST_LATIN_MASK).replace(MASK_RUN_RE, TOEIC_TEMPLATE_TEST_LATIN_MASK);
}

/**
 * 문제 카드 머리 줄(두 모드 공통 — "묶음 이름 · 쓰임") — 라틴을 가리고(maskLatinForTestKo) 공백을 다듬는다. 가리고 나서 글자(한글 등)가
 * 하나도 남지 않으면 그 칸은 null(화면이 "· …"만 보이지 않게 — zod가 한글 포함을 요구하므로 지금 원본에서는 생기지 않는다).
 */
export function templateTestPromptMeta(q: { groupKo: string; useKo: string }): { groupKo: string | null; useKo: string | null } {
  const clean = (s: string): string | null => {
    const m = maskLatinForTestKo(s).replace(/\s+/g, " ").trim();
    return /\p{L}/u.test(m) ? m : null;
  };
  return { groupKo: clean(q.groupKo), useKo: clean(q.useKo) };
}

/**
 * 유효한 시도(§12-5-3) — 받아쓰기가 돌아왔고 들은 낱말이 있다. 라우트의 `words`(countWords — 공백 덩어리 수)와 비교의 `noSpeech`
 * (정규화 낱말 0)를 **둘 다** 본다 — 전사가 `"..."`나 한국어 군말뿐이면 words는 1인데 비교할 낱말이 없다(기반 QA P3-4). 그런 시도는
 * 정답을 공개하지 않은 채 "잘 안 들렸어요"로 둔다(다시 말하기 기회를 지킨다).
 */
export function isValidTemplateAttempt(res: { words: number }, check: { noSpeech: boolean }): boolean {
  return Number.isFinite(res.words) && res.words >= 1 && !check.noSpeech;
}

/** 비용 표시(검토 S12) — 시작 화면·테스트 머리 "받아쓰기 n/20 · 이 판 최대 약 1센트" */
export function templateTestCostLabelKo(used: number): string {
  const n = Math.max(0, Math.min(TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION, Math.floor(Number.isFinite(used) ? used : 0)));
  return `받아쓰기 ${n}/${TOEIC_TEMPLATE_TRANSCRIBE_PER_SESSION} · 이 판 최대 약 1센트`;
}

/** 받아쓰기를 못 쓰는 이유(그 세션은 자기 판정 — 문항이 막히지 않게, §12-5-3) */
export type ToeicTemplateSelfReason = "nomic" | "nokey" | "cap";

export const TOEIC_TEMPLATE_SELF_REASON_KO: Record<ToeicTemplateSelfReason, string> = {
  nomic: "마이크를 쓸 수 없어 녹음 없이 해요 — 소리 내어 말한 뒤 \"정답 보기\"를 누르고 스스로 판정해요.",
  nokey: "받아쓰기를 쓸 수 없어 스스로 판정해요.",
  cap: "받아쓰기 한도에 닿아 스스로 판정해요.",
};

// ---------------------------------------------------------------------------
// 저장·끝 화면 (§12-5-6)
// ---------------------------------------------------------------------------

/** 문항 하나의 판정 — 아빠의 최종 ○/✕와, 첫 유효 시도의 제안(없으면 null — 자기 판정·받아쓰기 없이 판정) */
export interface ToeicTemplateVerdict {
  correct: boolean;
  suggest: "pass" | "fail" | null;
}

/**
 * 저장 항목 — 문항 순서대로 `{ word: tpl:{key}, correct, answered }`. 판정한 문항만 answered true, 판정 전(그만두기)은 null·correct false
 * (§12-5-3 "그만두면 판정한 문항만 answered: true, 나머지는 null").
 */
export function templateTestItems(keys: readonly string[], verdicts: readonly (ToeicTemplateVerdict | null)[]): { word: string; correct: boolean; answered: boolean | null }[] {
  return keys.map((key, i) => {
    const v = verdicts[i] ?? null;
    return { word: templateItemKey(key), correct: v?.correct === true, answered: v ? true : null };
  });
}

/** 끝 화면 요약 — ○ 수·판정 수·제안과 다르게 판정한 수(첫 유효 시도 제안이 있던 문항만 — §12-12 15)·✕한 틀 key(문항 순서) */
export function templateTestSummary(
  keys: readonly string[],
  verdicts: readonly (ToeicTemplateVerdict | null)[],
): { correct: number; answered: number; suggested: number; mismatched: number; wrongKeys: string[] } {
  let correct = 0;
  let answered = 0;
  let suggested = 0;
  let mismatched = 0;
  const wrongKeys: string[] = [];
  keys.forEach((key, i) => {
    const v = verdicts[i] ?? null;
    if (!v) return;
    answered += 1;
    if (v.correct) correct += 1;
    else wrongKeys.push(key);
    if (v.suggest !== null) {
      suggested += 1;
      if ((v.suggest === "pass") !== v.correct) mismatched += 1;
    }
  });
  return { correct, answered, suggested, mismatched, wrongKeys };
}

/** 테스트 화면의 단계 — 시작 화면 · 진행 · 끝 화면 */
export type ToeicTemplateTestStage = "intro" | "run" | "done";

/**
 * 화면을 떠날 때(언마운트·`pagehide` 비캐시) keepalive로 한 번 더 저장할지와 그 본문의 `finishedAt`(null = 저장하지 않는다).
 * - 진행 중(run)에 판정한 문항이 있으면 → 그만두기와 같은 모양(`finishedAt: null`).
 * - 끝 화면(done)인데 저장이 실패한 채(저장됨도 저장 중도 아님 — "다시 저장"이 보이는 상태) → 그 판의 `finishedAt` 그대로(다시 저장과
 *   같은 본문 — 멱등 키라 앞선 저장이 실제로 들어갔어도 reused로 한 벌, QA S2 P3-4).
 * - 시작 화면·저장됨·저장 중·판정 0·멱등 키 없음 → 저장하지 않는다.
 */
export function templateTestLeaveSave(s: {
  stage: ToeicTemplateTestStage;
  saved: boolean;
  saving: boolean;
  answered: number;
  hasSessionId: boolean;
  finishedAt: string | null | undefined;
}): { finishedAt: string | null } | null {
  if (s.stage === "intro" || s.saved || s.saving || !(s.answered > 0) || !s.hasSessionId) return null;
  return { finishedAt: s.stage === "done" ? (s.finishedAt ?? null) : null };
}

// ---------------------------------------------------------------------------
// ② 탭 — 최근 테스트·틀린 틀 수 (§12-5-6)
// ---------------------------------------------------------------------------

export interface ToeicRecentTemplateTest {
  id: string;
  mode: ToeicTemplateQuizMode;
  /** KST "YYYY.MM.DD HH:mm"(서버가 formatKst로 — hydration 안전) */
  whenKo: string;
  correct: number;
  answered: number;
  /** 끝까지 풀었는가(그만두면 false) */
  finished: boolean;
}

/**
 * 그 유형 틀이 든 틀 세션 최신 `max`개(최신 먼저). ○ n / 전체는 그 세션 전체의 판정한 문항 기준(공통 틀은 여러 유형에서 푼다 — 세션을
 * 쪼개지 않는다). 틀 모드가 아닌 세션·판정 0 세션은 뺀다.
 */
export function recentTemplateTests(sessions: readonly ToeicQuizSessionLike[], partKeys: ReadonlySet<string>, max = 10): ToeicRecentTemplateTest[] {
  const out: ToeicRecentTemplateTest[] = [];
  const sorted = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  for (const s of sorted) {
    if (!(TOEIC_TEMPLATE_QUIZ_MODES as readonly string[]).includes(s.mode)) continue;
    if (!s.items.some((it) => partKeys.has(templateKeyFromItemKey(it.word) ?? ""))) continue;
    const answeredItems = s.items.filter((it) => it.answered === true);
    if (answeredItems.length === 0) continue;
    out.push({
      id: s.id,
      mode: s.mode as ToeicTemplateQuizMode,
      whenKo: formatKst(s.startedAt),
      correct: answeredItems.filter((it) => it.correct === true).length,
      answered: answeredItems.length,
      finished: s.finishedAt !== null,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 모드마다 그 유형의 틀린 틀 수(틀렸고 미졸업 — toeicTemplateWrongKeys) — ② 탭의 "틀린 틀만 테스트" 버튼 */
export function templateWrongCountsByMode(sessions: readonly ToeicQuizSessionLike[], partKeys: ReadonlySet<string>): Record<ToeicTemplateQuizMode, number> {
  const out = {} as Record<ToeicTemplateQuizMode, number>;
  for (const mode of TOEIC_TEMPLATE_QUIZ_MODES) out[mode] = [...toeicTemplateWrongKeys(sessions, mode)].filter((k) => partKeys.has(k)).length;
  return out;
}

/**
 * 멱등 키(소문자 UUID v4 — TOEIC_TEMPLATE_SESSION_ID_RE)를 만든다. `crypto.randomUUID`가 있으면 그것(소문자), 없으면 16바이트 난수로
 * 직접 짠다(비보안 컨텍스트·구형 브라우저). 테스트를 **시작하는 탭**에서 한 번 부른다.
 */
export function newTemplateSessionId(
  c: { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(a: T) => T } | undefined = typeof crypto === "undefined" ? undefined : crypto,
): string {
  if (c?.randomUUID) {
    try {
      return c.randomUUID().toLowerCase();
    } catch {
      /* 비보안 컨텍스트 — 아래로 */
    }
  }
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

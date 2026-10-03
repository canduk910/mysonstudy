/**
 * lib/toeic-island.ts — 🏝️ 나만의 답변 섬 순수 함수·타입의 단일 정의처 (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * Q5–7·Q11 단골 소재마다 **내 경험으로 만든 답변 조각**을 모아 두는 곳. 담는 길은 셋(AI 호출 0):
 *   ① 🗣️ 틀 말하기 결과의 문항(고친 문장 → 없으면 모범 영어 · 내가 말한 전사 · 한글 문장 · 틀 key · 소재)
 *   ② 모의고사 결과(첨삭)의 Q5–7·Q11 "개선 답변" 또는 "고칠 문장 → 고친 문장"(소재는 사용자가 칩으로, 쓰인 틀이 있으면 그 소재를 추천)
 *   ③ 섬 화면에서 직접 쓰기(영어 문장 + 한 줄 한국어 메모 + 소재)
 * 같은 원본에서 두 번 담아도 한 개 — **문서 id가 원본 키**다(islandDocId — 확인과 생성이 한 원자 단위, 자유대화·틀 말하기 저장 관용구).
 * `ko`(한국어 단서)는 나중 회차의 "오늘의 복습(한국어 메모 → 내 문장 떠올리기)" 연결 자리다 — 지금은 화면 표시만.
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import는 lib/toeic-template·lib/toeic-frame-drill·lib/toeic-guide·lib/toeic-text(전부 클라이언트 안전)뿐.
 * lib/ai·store·openai·zod 값 import 금지, 정규식 lookbehind 금지(구형 iOS Safari).
 */

import { templateRunSpans, templateSpanSegments } from "./toeic-template";
import {
  TOEIC_FRAME_DRILL_PARTS,
  TOEIC_FRAME_DRILL_SESSION_ID_RE,
  TOEIC_FRAME_DRILL_SESSION_PREFIX,
  type ToeicFrameDrillFrame,
  type ToeicFrameDrillPart,
  type ToeicFrameDrillSession,
  type ToeicFrameDrillTopic,
} from "./toeic-frame-drill";
import { toeicGuidePartOfMockPart } from "./toeic-guide";
import { collapseSpaces } from "./toeic-text";
import type { ToeicMockPart } from "./toeic-mock";

// ===========================================================================
// 상수
// ===========================================================================

/** 섬이 받는 유형 — 틀 말하기와 같은 둘(Q5–7 · Q11) */
export const TOEIC_ISLAND_PARTS = TOEIC_FRAME_DRILL_PARTS;
export type ToeicIslandPart = ToeicFrameDrillPart;

/** 섬 문장(영어) 상한 — Q11 개선 답변 하나가 통째로 들어갈 만큼. 넘으면 담지 않는다(400 too_long) */
export const TOEIC_ISLAND_EN_MAX = 1200;
/** 한국어 단서(메모·한글 문장) 상한 — 한 줄 */
export const TOEIC_ISLAND_KO_MAX = 200;
/** 내가 말한 문장(전사) 상한 — 곁들이는 기록이라 넘으면 자른다(거부하지 않는다) */
export const TOEIC_ISLAND_SPOKEN_MAX = 1500;
/** 질문 사본 상한 — 넘으면 자른다 */
export const TOEIC_ISLAND_QUESTION_MAX = 600;
/** 소재 이름 사본 상한 */
export const TOEIC_ISLAND_TOPIC_NAME_MAX = 40;
/** 섬 전체 문장 수 상한(가족 규모 — 목록 한 번 읽기) */
export const TOEIC_ISLAND_ENTRIES_MAX = 2000;

/** 문서 id 접두어 · 형식 */
export const TOEIC_ISLAND_ID_PREFIX = "isl-";
export const TOEIC_ISLAND_ID_RE = /^isl-[A-Za-z0-9_-]{4,140}$/;
/** 직접 쓰기의 클라이언트 키(두 번 눌러도 한 개) */
export const TOEIC_ISLAND_CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 소재 key 형식(틀 말하기 은행 key와 같은 문법) */
export const TOEIC_ISLAND_TOPIC_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const TOEIC_ISLAND_PART_LABEL_KO: Record<ToeicIslandPart, string> = { q5_7: "Q5–7", q11: "Q11" };

// ===========================================================================
// 데이터 모양
// ===========================================================================

/** 어디서 담았나 — 문서 id(원본 키)가 여기서 나온다 */
export type ToeicIslandOrigin =
  | { kind: "frame_drill"; sessionId: string; index: number }
  | { kind: "attempt"; attemptId: string; q: number; fixIndex: number | null }
  | { kind: "manual"; clientId: string };

export interface ToeicIslandEntryData {
  part: ToeicIslandPart;
  /** 틀 말하기 은행의 소재 key — 없으면 null("소재 없음") */
  topicKey: string | null;
  /** 담을 때의 소재 이름 사본(은행이 바뀌어도 묶음 이름이 남는다) */
  topicNameKo: string | null;
  /** 섬 문장 — 떠올릴 대상 */
  en: string;
  /** 한국어 단서(한글 문장·메모) — 나중 복습 큐의 앞면 */
  ko: string | null;
  /** 내가 실제로 말한 문장(전사·고칠 문장의 "말한 것") */
  spokenEn: string | null;
  /** 모의고사 질문 사본(②만) */
  question: string | null;
  /** 틀 말하기 틀 key(①만) */
  frameKey: string | null;
  origin: ToeicIslandOrigin;
  createdAt: string;
  updatedAt: string;
}

export type ToeicIslandEntry = ToeicIslandEntryData & { id: string };

// ===========================================================================
// 텍스트 정규화
// ===========================================================================

/** 공백·줄바꿈을 한 칸으로, 앞뒤를 잘라 빈 값이면 null */
export function cleanIslandText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = collapseSpaces(raw.replace(/[\u0000-\u001f\u007f]+/g, " ")).trim();
  return t === "" ? null : t;
}

/** 상한을 넘으면 잘라 "…"을 붙인다(곁들이는 기록용 — 섬 문장 en에는 쓰지 않는다) */
export function clipIslandText(raw: unknown, max: number): string | null {
  const t = cleanIslandText(raw);
  if (t === null) return null;
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// ===========================================================================
// 문서 id = 원본 키 (멱등)
// ===========================================================================

/** 원본 → 문서 id. 형식이 틀린 원본은 null(라우트가 400) */
export function islandDocId(origin: ToeicIslandOrigin): string | null {
  if (origin.kind === "frame_drill") {
    const sid = origin.sessionId;
    if (!sid.startsWith(TOEIC_FRAME_DRILL_SESSION_PREFIX) || !TOEIC_FRAME_DRILL_SESSION_ID_RE.test(sid.slice(TOEIC_FRAME_DRILL_SESSION_PREFIX.length))) return null;
    if (!Number.isInteger(origin.index) || origin.index < 0 || origin.index > 99) return null;
    return `${TOEIC_ISLAND_ID_PREFIX}${sid}-${origin.index}`;
  }
  if (origin.kind === "attempt") {
    if (!ATTEMPT_ID_RE.test(origin.attemptId)) return null;
    if (!Number.isInteger(origin.q) || origin.q < 1 || origin.q > 11) return null;
    if (origin.fixIndex !== null && (!Number.isInteger(origin.fixIndex) || origin.fixIndex < 0 || origin.fixIndex > 9)) return null;
    return `${TOEIC_ISLAND_ID_PREFIX}at-${origin.attemptId}-q${origin.q}-${origin.fixIndex === null ? "imp" : `fix${origin.fixIndex}`}`;
  }
  if (!TOEIC_ISLAND_CLIENT_ID_RE.test(origin.clientId)) return null;
  return `${TOEIC_ISLAND_ID_PREFIX}m-${origin.clientId}`;
}

export function isToeicIslandDocId(id: string): boolean {
  return TOEIC_ISLAND_ID_RE.test(id);
}

/** 화면이 "이미 담았어요"를 그리는 키 — 문서 id와 같다(같은 함수) */
export function islandSourceKeyOf(origin: ToeicIslandOrigin): string | null {
  return islandDocId(origin);
}

// ===========================================================================
// 원본 → 담을 내용 (서버가 저장된 원본에서 만든다 — 클라이언트가 보낸 글자를 믿지 않는다)
// ===========================================================================

export type ToeicIslandDraft = Omit<ToeicIslandEntryData, "topicKey" | "topicNameKo" | "createdAt" | "updatedAt"> & {
  /** 원본이 알려 주는 소재 추천(사용자 선택이 없으면 이것) */
  suggestedTopicKey: string | null;
};

export type ToeicIslandDraftResult = { ok: true; draft: ToeicIslandDraft } | { ok: false; reason: "not_found" | "part" | "empty" | "too_long" };

/**
 * ① 틀 말하기 한 문항 → 담을 내용. 섬 문장 = 판정이 준 고친 문장(fixedEn), 없으면 모범 영어(en).
 * 소재 = 은행에서 그 틀의 topicKey → 없으면 판의 소재가 하나일 때 그것.
 */
export function buildIslandFromFrameDrill(
  session: Pick<ToeicFrameDrillSession, "part" | "topicKeys" | "items">,
  sessionId: string,
  index: number,
  frames: readonly Pick<ToeicFrameDrillFrame, "key" | "topicKey">[],
): ToeicIslandDraftResult {
  const it = session.items[index];
  if (!it) return { ok: false, reason: "not_found" };
  if (!(TOEIC_ISLAND_PARTS as readonly string[]).includes(session.part)) return { ok: false, reason: "part" };
  const en = cleanIslandText(it.fixedEn) ?? cleanIslandText(it.en);
  if (en === null) return { ok: false, reason: "empty" };
  if (en.length > TOEIC_ISLAND_EN_MAX) return { ok: false, reason: "too_long" };
  const frameTopic = frames.find((f) => f.key === it.frameKey)?.topicKey ?? null;
  const suggested = frameTopic ?? (session.topicKeys.length === 1 ? session.topicKeys[0] : null);
  return {
    ok: true,
    draft: {
      part: session.part,
      en,
      ko: clipIslandText(it.ko, TOEIC_ISLAND_KO_MAX),
      spokenEn: it.outcome === "spoken" ? clipIslandText(it.transcript, TOEIC_ISLAND_SPOKEN_MAX) : null,
      question: null,
      frameKey: it.frameKey || null,
      origin: { kind: "frame_drill", sessionId, index },
      suggestedTopicKey: suggested,
    },
  };
}

/** 모의고사 파트 → 섬 유형(respond → Q5–7 · opinion → Q11, 그 밖은 null) */
export function islandPartOfMockPart(part: ToeicMockPart): ToeicIslandPart | null {
  const g = toeicGuidePartOfMockPart(part);
  return g !== null && (TOEIC_ISLAND_PARTS as readonly string[]).includes(g) ? (g as ToeicIslandPart) : null;
}

/**
 * ② 모의고사 결과 한 문항 → 담을 내용. fixIndex null = 개선 답변(improvedAnswer, 내가 말한 문장 = 그 문항 전사),
 * 숫자 = 고칠 문장의 고친 문장(better, 내가 말한 문장 = said). 한국어 단서는 사용자가 메모로 단다(없으면 null).
 */
export function buildIslandFromAttempt(args: {
  attemptId: string;
  q: number;
  fixIndex: number | null;
  mockPart: ToeicMockPart;
  question: string | null;
  transcript: string | null;
  feedback: { improvedAnswer: string; fixes: readonly { said: string; better: string }[] } | null;
}): ToeicIslandDraftResult {
  const part = islandPartOfMockPart(args.mockPart);
  if (part === null) return { ok: false, reason: "part" };
  const fb = args.feedback;
  if (!fb) return { ok: false, reason: "not_found" };
  let en: string | null;
  let spoken: string | null;
  if (args.fixIndex === null) {
    en = cleanIslandText(fb.improvedAnswer);
    spoken = clipIslandText(args.transcript, TOEIC_ISLAND_SPOKEN_MAX);
  } else {
    const f = fb.fixes[args.fixIndex];
    if (!f) return { ok: false, reason: "not_found" };
    en = cleanIslandText(f.better);
    spoken = clipIslandText(f.said, TOEIC_ISLAND_SPOKEN_MAX);
  }
  if (en === null) return { ok: false, reason: "empty" };
  if (en.length > TOEIC_ISLAND_EN_MAX) return { ok: false, reason: "too_long" };
  return {
    ok: true,
    draft: {
      part,
      en,
      ko: null,
      spokenEn: spoken,
      question: clipIslandText(args.question, TOEIC_ISLAND_QUESTION_MAX),
      frameKey: null,
      origin: { kind: "attempt", attemptId: args.attemptId, q: args.q, fixIndex: args.fixIndex },
      suggestedTopicKey: null,
    },
  };
}

// ===========================================================================
// 소재 추천 — 문장에 쓰인 틀의 소재(AI 없음)
// ===========================================================================

/**
 * 문장 속 틀 → 소재 추천. 틀 말하기 틀(frameEn)을 templateRunSpans(틀 강조와 **같은 일치 규칙**)로 찾고, 공략 틀 은행 틀이 찾히면
 * bankKey로 이어진 틀 말하기 틀의 소재도 센다. 가장 많이 찾힌 소재, 같으면 문장에서 먼저 나온 소재. 없으면 null.
 */
export function suggestIslandTopic(
  text: string,
  frames: readonly Pick<ToeicFrameDrillFrame, "key" | "topicKey" | "frameEn" | "bankKey">[],
  guideTemplates: readonly { key: string; frameEn: string }[] = [],
): string | null {
  const src = text ?? "";
  if (src.trim() === "" || frames.length === 0) return null;
  const score = new Map<string, { n: number; at: number }>();
  const bump = (topicKey: string, at: number) => {
    const cur = score.get(topicKey);
    if (cur) cur.n += 1;
    else score.set(topicKey, { n: 1, at });
  };
  for (const sp of templateRunSpans(src, frames)) {
    const f = frames.find((x) => x.key === sp.key);
    if (f) bump(f.topicKey, sp.runs[0]?.start ?? 0);
  }
  if (guideTemplates.length > 0) {
    for (const sp of templateRunSpans(src, guideTemplates)) {
      for (const f of frames) if (f.bankKey === sp.key) bump(f.topicKey, sp.runs[0]?.start ?? 0);
    }
  }
  let best: { key: string; n: number; at: number } | null = null;
  for (const [key, v] of score) {
    if (!best || v.n > best.n || (v.n === best.n && v.at < best.at)) best = { key, ...v };
  }
  return best?.key ?? null;
}

/** 틀 강조 조각 — 섬 문장 하나를 틀(틀 말하기 틀 + 공략 틀)이 쓰인 구간과 아닌 구간으로 나눈다(templateRunSpans · templateSpanSegments) */
export function islandHighlightSegments(
  text: string,
  templates: readonly { key: string; frameEn: string }[],
): { text: string; keys: string[] }[] {
  if (templates.length === 0) return [{ text, keys: [] }];
  return templateSpanSegments(text, templateRunSpans(text, templates));
}

// ===========================================================================
// 저장 레코드 정규화 (렌더 가능 판정의 단일 정의처)
// ===========================================================================

function isPart(v: unknown): v is ToeicIslandPart {
  return typeof v === "string" && (TOEIC_ISLAND_PARTS as readonly string[]).includes(v);
}

function normalizeOrigin(raw: unknown): ToeicIslandOrigin | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "frame_drill" && typeof o.sessionId === "string" && Number.isInteger(o.index)) {
    return { kind: "frame_drill", sessionId: o.sessionId, index: o.index as number };
  }
  if (o.kind === "attempt" && typeof o.attemptId === "string" && Number.isInteger(o.q)) {
    return { kind: "attempt", attemptId: o.attemptId, q: o.q as number, fixIndex: Number.isInteger(o.fixIndex) ? (o.fixIndex as number) : null };
  }
  if (o.kind === "manual" && typeof o.clientId === "string") return { kind: "manual", clientId: o.clientId };
  return null;
}

/** 원본 문서 → 렌더 가능한 항목(섬 문장이 없거나 유형이 깨졌으면 null). 선택 칸은 null로 채운다(Firestore undefined 거부) */
export function normalizeToeicIslandEntry(id: string, raw: unknown): ToeicIslandEntry | null {
  if (!raw || typeof raw !== "object" || !isToeicIslandDocId(id)) return null;
  const r = raw as Record<string, unknown>;
  const en = cleanIslandText(r.en);
  const origin = normalizeOrigin(r.origin);
  if (en === null || !isPart(r.part) || origin === null) return null;
  const topicKey = typeof r.topicKey === "string" && TOEIC_ISLAND_TOPIC_KEY_RE.test(r.topicKey) ? r.topicKey : null;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
  return {
    id,
    part: r.part,
    topicKey,
    topicNameKo: topicKey === null ? null : clipIslandText(r.topicNameKo, TOEIC_ISLAND_TOPIC_NAME_MAX),
    en,
    ko: clipIslandText(r.ko, TOEIC_ISLAND_KO_MAX),
    spokenEn: clipIslandText(r.spokenEn, TOEIC_ISLAND_SPOKEN_MAX),
    question: clipIslandText(r.question, TOEIC_ISLAND_QUESTION_MAX),
    frameKey: typeof r.frameKey === "string" && r.frameKey !== "" ? r.frameKey : null,
    origin,
    createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : createdAt,
  };
}

/** 저장 본문(id 뺌) — 키 순서 고정, undefined 없음 */
export function islandEntryData(e: ToeicIslandEntry): ToeicIslandEntryData {
  return {
    part: e.part,
    topicKey: e.topicKey,
    topicNameKo: e.topicNameKo,
    en: e.en,
    ko: e.ko,
    spokenEn: e.spokenEn,
    question: e.question,
    frameKey: e.frameKey,
    origin: { ...e.origin },
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** 목록 정렬 — 최근에 담은 것이 위(createdAt 내림차순, 같으면 id) */
export function sortIslandEntries(entries: readonly ToeicIslandEntry[]): ToeicIslandEntry[] {
  return entries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ===========================================================================
// 소재 고르기 · 편집 판정
// ===========================================================================

/**
 * 고른 소재 key → {topicKey, topicNameKo}. null·빈 값은 "소재 없음". 은행에 없는 key는 형식만 맞으면 받되 이름은 원래 사본을 유지한다
 * (은행을 다시 가져와 소재가 빠져도 편집이 깨지지 않게). 형식이 틀리면 invalid.
 */
export function resolveIslandTopic(
  topicKey: unknown,
  topics: readonly ToeicFrameDrillTopic[],
  prevNameKo: string | null = null,
): { ok: true; topicKey: string | null; topicNameKo: string | null } | { ok: false } {
  if (topicKey === null || topicKey === undefined || topicKey === "") return { ok: true, topicKey: null, topicNameKo: null };
  if (typeof topicKey !== "string" || !TOEIC_ISLAND_TOPIC_KEY_RE.test(topicKey)) return { ok: false };
  const t = topics.find((x) => x.key === topicKey);
  return { ok: true, topicKey, topicNameKo: clipIslandText(t?.nameKo ?? prevNameKo, TOEIC_ISLAND_TOPIC_NAME_MAX) };
}

export type IslandPatch = { en?: string; ko?: string | null; topicKey?: string | null; topicNameKo?: string | null; part?: ToeicIslandPart };

/** 편집 판정 — 바꾼 칸만 덮는다. 섬 문장을 비우거나 상한을 넘으면 거부 */
export function applyIslandPatch(
  e: ToeicIslandEntry,
  patch: IslandPatch,
  nowIso: string,
): { ok: true; entry: ToeicIslandEntry; changed: boolean } | { ok: false; reason: "empty" | "too_long" } {
  const next: ToeicIslandEntry = { ...e, origin: { ...e.origin } };
  if (patch.en !== undefined) {
    const en = cleanIslandText(patch.en);
    if (en === null) return { ok: false, reason: "empty" };
    if (en.length > TOEIC_ISLAND_EN_MAX) return { ok: false, reason: "too_long" };
    next.en = en;
  }
  if (patch.ko !== undefined) {
    const ko = cleanIslandText(patch.ko);
    if (ko !== null && ko.length > TOEIC_ISLAND_KO_MAX) return { ok: false, reason: "too_long" };
    next.ko = ko;
  }
  if (patch.topicKey !== undefined) {
    next.topicKey = patch.topicKey;
    next.topicNameKo = patch.topicKey === null ? null : (patch.topicNameKo ?? null);
  }
  if (patch.part !== undefined) next.part = patch.part;
  const changed = JSON.stringify(islandEntryData({ ...next, updatedAt: e.updatedAt })) !== JSON.stringify(islandEntryData(e));
  if (changed) next.updatedAt = nowIso;
  return { ok: true, entry: changed ? next : e, changed };
}

// ===========================================================================
// 화면 묶기
// ===========================================================================

export interface ToeicIslandGroup {
  /** null = 소재 없음 */
  topicKey: string | null;
  nameKo: string;
  entries: ToeicIslandEntry[];
}

/**
 * 소재별 묶음 — 은행 소재 순서(topics) 먼저, 은행에 없는 소재는 담긴 이름 사본으로 그 뒤, "소재 없음"은 맨 끝.
 * 묶음 안은 최근 순(sortIslandEntries). part를 주면 그 유형만.
 */
export function groupIslandByTopic(
  entries: readonly ToeicIslandEntry[],
  topics: readonly ToeicFrameDrillTopic[],
  part: ToeicIslandPart | null = null,
): ToeicIslandGroup[] {
  const list = sortIslandEntries(part ? entries.filter((e) => e.part === part) : entries);
  const byKey = new Map<string | null, ToeicIslandEntry[]>();
  for (const e of list) {
    const k = e.topicKey;
    const arr = byKey.get(k);
    if (arr) arr.push(e);
    else byKey.set(k, [e]);
  }
  const out: ToeicIslandGroup[] = [];
  for (const t of topics) {
    const arr = byKey.get(t.key);
    if (arr) {
      out.push({ topicKey: t.key, nameKo: t.nameKo, entries: arr });
      byKey.delete(t.key);
    }
  }
  for (const [k, arr] of byKey) {
    if (k === null) continue;
    out.push({ topicKey: k, nameKo: arr.find((e) => e.topicNameKo)?.topicNameKo ?? k, entries: arr });
  }
  const none = byKey.get(null);
  if (none) out.push({ topicKey: null, nameKo: "소재 없음", entries: none });
  return out;
}

/** 원본 표시 한 줄 */
export function islandOriginLabelKo(o: ToeicIslandOrigin): string {
  if (o.kind === "frame_drill") return "🗣️ 틀 말하기에서";
  if (o.kind === "attempt") return o.fixIndex === null ? `🧑‍💼 모의고사 Q${o.q} 개선 답변에서` : `🧑‍💼 모의고사 Q${o.q} 고친 문장에서`;
  return "✍️ 직접 씀";
}

/**
 * lib/toeic-frame-drill-record.ts — 소재별 틀 말하기(docs/harness/toeic.md §20) **저장 계층의 순수 판정·정규화** 단일 정의처
 *
 * 두 저장 백엔드(파일 `lib/store.ts` mutate · Firestore `lib/store-firestore.ts` runTransaction)가 **같은 함수**로 판정하고 같은 모양을 쓴다
 * (app-patterns §4·§5 — 판정은 순수 함수, 쓰기는 원자 단위 안에서). 값 규칙(출제·통계·보충·합치기)은 `lib/toeic-frame-drill.ts`가
 * 단일 정의처이고, 이 파일은 그것을 **저장 단위로 묶기만** 한다:
 * - 정규화(던지지 않는다 · undefined를 남기지 않는다 · 값을 손보지 않는다): 은행 · 통계 · 한 판.
 * - 판정 저장 `decideFrameDrillJudgeWrite` — 판정 합치기 + review + (한 번만) 통계 더하기 + statsAppliedAt 를 **한 결과**로.
 * - 보충 시작 `decideFrameDrillSupplyStart` — 잡기(decideFrameDrillSupplyClaim) → 보충 판정(decideFrameDrillSupply)을 같은 원자 단위에서.
 * - 보충 끝 `decideFrameDrillSupplyFinish` — 최신 은행 위에 acceptFrameDrillSupply + 표시 added / 실패 표시 failed.
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import는 ./toeic-frame-drill뿐(그 모듈도 클라이언트 안전). store·lib/ai·openai·zod 값 import 금지.
 * 공개 저장소: 예시·주석에 교재 문장을 적지 않는다.
 */

import {
  TOEIC_FRAME_DRILL_MAX_BYTES,
  TOEIC_FRAME_DRILL_OUTCOMES,
  TOEIC_FRAME_DRILL_PARTS,
  TOEIC_FRAME_DRILL_VERDICTS,
  acceptFrameDrillSupply,
  applyFrameDrillStats,
  decideFrameDrillJudge,
  decideFrameDrillStatsApply,
  decideFrameDrillSupply,
  decideFrameDrillSupplyClaim,
  frameDrillBankBytes,
  frameDrillNoAiReview,
  frameDrillScopeFrameKeys,
  frameDrillScopeItems,
  mergeFrameDrillVerdicts,
  type ToeicFrameDrillBank,
  type ToeicFrameDrillFrame,
  type ToeicFrameDrillItem,
  type ToeicFrameDrillJudgeItemOut,
  type ToeicFrameDrillPart,
  type ToeicFrameDrillReview,
  type ToeicFrameDrillSession,
  type ToeicFrameDrillSessionItem,
  type ToeicFrameDrillStat,
  type ToeicFrameDrillStatsDoc,
  type ToeicFrameDrillSupplyMark,
  type ToeicFrameDrillSupplyOut,
  type ToeicFrameDrillSupplySkip,
} from "./toeic-frame-drill";

/** 저장된 한 판(문서 id 포함 — id = "fd-" + clientSessionId) */
export type ToeicFrameDrillSessionRecord = ToeicFrameDrillSession & { id: string };

// ===========================================================================
// 정규화 — 던지지 않는다
// ===========================================================================

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function isFrameDrillPart(v: unknown): v is ToeicFrameDrillPart {
  return typeof v === "string" && (TOEIC_FRAME_DRILL_PARTS as readonly string[]).includes(v);
}

function normalizeFrame(raw: unknown): ToeicFrameDrillFrame | null {
  if (!isObj(raw) || typeof raw.key !== "string" || typeof raw.frameEn !== "string" || typeof raw.frameKo !== "string") return null;
  return {
    key: raw.key,
    topicKey: str(raw.topicKey),
    frameEn: raw.frameEn,
    frameKo: raw.frameKo,
    useKo: strOrNull(raw.useKo),
    parts: (Array.isArray(raw.parts) ? raw.parts : []).filter(isFrameDrillPart),
    bankKey: strOrNull(raw.bankKey),
    sources: strArr(raw.sources),
    questionTypes: strArr(raw.questionTypes),
    fillOptions: (Array.isArray(raw.fillOptions) ? raw.fillOptions : [])
      .filter(isObj)
      .filter((o) => typeof o.slot === "string" && typeof o.en === "string" && typeof o.ko === "string")
      .map((o) => ({ slot: o.slot as string, en: o.en as string, ko: o.ko as string })),
  };
}

function normalizeBankItem(raw: unknown): ToeicFrameDrillItem | null {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.frameKey !== "string" || typeof raw.ko !== "string" || typeof raw.en !== "string") return null;
  return {
    id: raw.id,
    frameKey: raw.frameKey,
    ko: raw.ko,
    fills: strArr(raw.fills),
    en: raw.en,
    source: raw.source === "ai" ? "ai" : "seed",
    createdAt: str(raw.createdAt),
  };
}

/** 은행 문서 → 은행(깨진 틀·문항은 버린다 · 문서가 깨졌으면 null) */
export function normalizeToeicFrameDrillBank(raw: unknown): ToeicFrameDrillBank | null {
  if (!isObj(raw) || !Array.isArray(raw.frames) || !Array.isArray(raw.items)) return null;
  const topics = (Array.isArray(raw.topics) ? raw.topics : [])
    .filter(isObj)
    .filter((t) => typeof t.key === "string" && typeof t.nameKo === "string")
    .map((t) => ({ key: t.key as string, nameKo: t.nameKo as string }));
  const questionTypes = (Array.isArray(raw.questionTypes) ? raw.questionTypes : [])
    .filter(isObj)
    .filter((q) => typeof q.key === "string" && typeof q.nameKo === "string")
    .map((q) => ({ key: q.key as string, nameKo: q.nameKo as string }));
  return {
    presetKey: str(raw.presetKey),
    topics,
    questionTypes,
    frames: raw.frames.map(normalizeFrame).filter((f): f is ToeicFrameDrillFrame => f !== null),
    items: raw.items.map(normalizeBankItem).filter((it): it is ToeicFrameDrillItem => it !== null),
    updatedAt: str(raw.updatedAt),
  };
}

/** 통계 문서 → 통계(없거나 깨졌으면 빈 통계) */
export function normalizeToeicFrameDrillStats(raw: unknown): ToeicFrameDrillStatsDoc {
  const items: Record<string, ToeicFrameDrillStat> = {};
  const src = isObj(raw) && isObj(raw.items) ? raw.items : {};
  for (const [id, v] of Object.entries(src)) {
    if (!isObj(v)) continue;
    const attempts = Math.max(0, Math.floor(num(v.attempts)));
    const wrong = Math.min(attempts, Math.max(0, Math.floor(num(v.wrong))));
    items[id] = { attempts, wrong, lastAt: str(v.lastAt) };
  }
  return { items, updatedAt: isObj(raw) ? str(raw.updatedAt) : "" };
}

function normalizeSessionItem(raw: unknown): ToeicFrameDrillSessionItem | null {
  if (!isObj(raw) || typeof raw.itemId !== "string" || typeof raw.ko !== "string" || typeof raw.en !== "string") return null;
  const outcome = (TOEIC_FRAME_DRILL_OUTCOMES as readonly unknown[]).includes(raw.outcome) ? (raw.outcome as ToeicFrameDrillSessionItem["outcome"]) : "transcribe_failed";
  const verdict = (TOEIC_FRAME_DRILL_VERDICTS as readonly unknown[]).includes(raw.verdict) ? (raw.verdict as ToeicFrameDrillSessionItem["verdict"]) : null;
  return {
    itemId: raw.itemId,
    frameKey: str(raw.frameKey),
    ko: raw.ko,
    en: raw.en,
    frame: str(raw.frame),
    outcome,
    transcript: strOrNull(raw.transcript),
    verdict,
    reasonKo: strOrNull(raw.reasonKo),
    fixedEn: strOrNull(raw.fixedEn),
  };
}

function normalizeReview(raw: unknown): ToeicFrameDrillReview | null {
  if (!isObj(raw) || typeof raw.summaryKo !== "string") return null;
  return {
    summaryKo: raw.summaryKo,
    improvements: strArr(raw.improvements),
    strongFrameKeys: strArr(raw.strongFrameKeys),
    weakFrameKeys: strArr(raw.weakFrameKeys),
    model: strOrNull(raw.model),
    at: str(raw.at),
  };
}

const SUPPLY_STATUSES = ["running", "added", "skipped", "failed"] as const;

function normalizeSupplyMark(raw: unknown): ToeicFrameDrillSupplyMark | null {
  if (!isObj(raw) || !(SUPPLY_STATUSES as readonly unknown[]).includes(raw.status)) return null;
  return { status: raw.status as ToeicFrameDrillSupplyMark["status"], reason: strOrNull(raw.reason), added: Math.max(0, Math.floor(num(raw.added))), at: str(raw.at) };
}

/** 한 판 문서 → 한 판(문항이 하나도 안 읽히거나 유형을 모르면 null — 목록·결과에서 빠진다) */
export function normalizeToeicFrameDrillSession(id: string, raw: unknown): ToeicFrameDrillSessionRecord | null {
  if (!isObj(raw) || !isFrameDrillPart(raw.part)) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeSessionItem).filter((x): x is ToeicFrameDrillSessionItem => x !== null);
  if (items.length === 0) return null;
  return {
    id,
    part: raw.part,
    topicKeys: strArr(raw.topicKeys),
    questionTypeKeys: strArr(raw.questionTypeKeys),
    excludedFrameKeys: strArr(raw.excludedFrameKeys),
    requested: Math.max(0, Math.floor(num(raw.requested, items.length))),
    startedAt: str(raw.startedAt),
    finishedAt: str(raw.finishedAt),
    ended: raw.ended === "quit" ? "quit" : "done",
    items,
    review: normalizeReview(raw.review),
    statsAppliedAt: strOrNull(raw.statsAppliedAt),
    supply: normalizeSupplyMark(raw.supply),
  };
}

/** 저장 본문(id 뺀 것) — 쓰기 직전에 정규화를 한 번 더 태운다(undefined 0) */
export function frameDrillSessionData(rec: ToeicFrameDrillSessionRecord): ToeicFrameDrillSession {
  const n = normalizeToeicFrameDrillSession(rec.id, rec) ?? rec;
  const { id: _id, ...data } = n;
  return data;
}

// ===========================================================================
// 판정 저장 — 판정 합치기 · review · 통계(한 번만) · statsAppliedAt
// ===========================================================================

/** 호출 E 결과(AI 0이면 null) — 라우트가 judgeFrameDrill 결과에서 만든다 */
export interface FrameDrillJudged {
  items: readonly ToeicFrameDrillJudgeItemOut[];
  summaryKo: string;
  improvements: readonly string[];
  strongFrameKeys: readonly string[];
  weakFrameKeys: readonly string[];
  model: string;
}

export type FrameDrillJudgeWrite =
  /** 이미 판정된 판 — 쓰지 않는다(먼저 저장된 판정이 이긴다) */
  | { kind: "already"; session: ToeicFrameDrillSessionRecord }
  /** 판정할 문항이 있는데 AI 결과가 없다 — 호출측 실수(쓰지 않는다) */
  | { kind: "needs_ai" }
  | { kind: "write"; session: ToeicFrameDrillSessionRecord; stats: Record<string, ToeicFrameDrillStat> | null };

/**
 * 판정 저장 판정(순수 — 두 백엔드가 원자 단위 **안에서** 부른다). already면 쓰지 않는다. no_ai면 judged 없이 AI 0 총평.
 * 판정을 쓰는 같은 단위에서 통계를 한 번 더한다(decideFrameDrillStatsApply) — 통계를 바꿀 때만 `stats`가 null이 아니다.
 */
export function decideFrameDrillJudgeWrite(
  session: ToeicFrameDrillSessionRecord,
  judged: FrameDrillJudged | null,
  stats: Readonly<Record<string, ToeicFrameDrillStat>>,
  at: string,
): FrameDrillJudgeWrite {
  const d = decideFrameDrillJudge(session);
  if (d === "already") {
    // 판정은 있는데 통계를 아직 못 더한 판(이전 쓰기가 통계만 실패할 일은 원자 단위라 없지만 방어) — 지금 더한다
    if (decideFrameDrillStatsApply(session) === "apply") {
      return { kind: "write", session: { ...session, statsAppliedAt: at }, stats: applyFrameDrillStats(stats, session.items, at) };
    }
    return { kind: "already", session };
  }
  if (d === "call" && judged === null) return { kind: "needs_ai" };
  const items = mergeFrameDrillVerdicts(session.items, d === "call" && judged ? judged.items : null);
  const review: ToeicFrameDrillReview =
    d === "call" && judged
      ? {
          summaryKo: judged.summaryKo,
          improvements: [...judged.improvements],
          strongFrameKeys: [...judged.strongFrameKeys],
          weakFrameKeys: [...judged.weakFrameKeys],
          model: judged.model,
          at,
        }
      : frameDrillNoAiReview(session.items, at);
  const judgedSession: ToeicFrameDrillSessionRecord = { ...session, items, review };
  if (decideFrameDrillStatsApply(judgedSession) !== "apply") return { kind: "write", session: judgedSession, stats: null };
  return { kind: "write", session: { ...judgedSession, statsAppliedAt: at }, stats: applyFrameDrillStats(stats, items, at) };
}

// ===========================================================================
// 보충 — 시작(잡기 + 판정) · 끝(합치기)
// ===========================================================================

/** 이 판의 범위 틀(지금 은행 기준 — 은행이 바뀐 뒤면 모르는 key는 조용히 빠진다) */
export function frameDrillSessionScopeKeys(bank: ToeicFrameDrillBank, session: Pick<ToeicFrameDrillSession, "part" | "topicKeys" | "excludedFrameKeys" | "questionTypeKeys">): string[] {
  return frameDrillScopeFrameKeys(bank, session.part, session.topicKeys, session.excludedFrameKeys, session.questionTypeKeys);
}

export type FrameDrillSupplyStart =
  | { kind: "not_judged" }
  /** 이미 끝난 보충(added·skipped) — 쓰지 않는다 */
  | { kind: "already"; mark: ToeicFrameDrillSupplyMark }
  /** 다른 탭이 진행 중(2분 안) — 쓰지 않는다 */
  | { kind: "running" }
  /** 보충하지 않는다 — 표시 skipped를 쓴다(AI 0) */
  | { kind: "skip"; reason: ToeicFrameDrillSupplySkip; rate: number | null; mark: ToeicFrameDrillSupplyMark }
  /** 보충한다 — 표시 running을 쓰고 원자 단위 밖에서 호출 F */
  | { kind: "supply"; count: number; rate: number; scopeFrameKeys: string[]; mark: ToeicFrameDrillSupplyMark };

/**
 * 보충 시작 판정(순수 — 원자 단위 안). 판정 전이면 not_judged(409). 잡기가 already·running이면 쓰지 않는다.
 * 잡았으면 통계를 더한 뒤의 통계로 decideFrameDrillSupply — skip이면 skipped 표시, supply면 running 표시.
 * 은행이 없으면 범위 0 → skip no_scope.
 */
export function decideFrameDrillSupplyStart(
  session: ToeicFrameDrillSessionRecord,
  bank: ToeicFrameDrillBank | null,
  stats: Readonly<Record<string, ToeicFrameDrillStat>>,
  nowMs: number,
  nowIso: string,
): FrameDrillSupplyStart {
  if (session.review === null) return { kind: "not_judged" };
  const claim = decideFrameDrillSupplyClaim(session.supply, nowMs);
  if (claim === "already") return { kind: "already", mark: session.supply! };
  if (claim === "running") return { kind: "running" };
  const scopeFrameKeys = bank ? frameDrillSessionScopeKeys(bank, session) : [];
  const scopeItems = bank ? frameDrillScopeItems(bank, scopeFrameKeys) : [];
  const d = decideFrameDrillSupply({ bankItemCount: bank?.items.length ?? 0, scopeItems, stats, alreadySupplied: false });
  if (d.kind === "skip") return { kind: "skip", reason: d.reason, rate: d.rate, mark: { status: "skipped", reason: d.reason, added: 0, at: nowIso } };
  return { kind: "supply", count: d.count, rate: d.rate, scopeFrameKeys, mark: { status: "running", reason: null, added: 0, at: nowIso } };
}

export type FrameDrillSupplyFinish =
  | { kind: "write"; mark: ToeicFrameDrillSupplyMark; bank: ToeicFrameDrillBank | null; added: number; dropped: number };

/**
 * 보충 끝 판정(순수 — 원자 단위 안). `out`이 null이면 실패 표시(failed — 다시 누르면 다시 잡는다).
 * 성공이면 **최신 은행 위에** acceptFrameDrillSupply(겹침 버림·결정적 id·상한) — 바이트 상한을 넘기면 더하지 않는다(full).
 * 은행이 그 사이 사라졌으면 더할 곳이 없다 — skipped no_scope.
 */
export function decideFrameDrillSupplyFinish(
  bank: ToeicFrameDrillBank | null,
  out: readonly ToeicFrameDrillSupplyOut[] | null,
  failReason: string | null,
  at: string,
): FrameDrillSupplyFinish {
  if (out === null) return { kind: "write", mark: { status: "failed", reason: failReason ?? "failed", added: 0, at }, bank: null, added: 0, dropped: 0 };
  if (!bank) return { kind: "write", mark: { status: "skipped", reason: "no_scope", added: 0, at }, bank: null, added: 0, dropped: out.length };
  const r = acceptFrameDrillSupply(bank, out, at);
  if (r.added.length === 0) return { kind: "write", mark: { status: "added", reason: null, added: 0, at }, bank: null, added: 0, dropped: r.dropped };
  const next: ToeicFrameDrillBank = { ...bank, items: [...bank.items, ...r.added], updatedAt: at };
  if (frameDrillBankBytes(next) > TOEIC_FRAME_DRILL_MAX_BYTES) {
    return { kind: "write", mark: { status: "skipped", reason: "full", added: 0, at }, bank: null, added: 0, dropped: out.length };
  }
  return { kind: "write", mark: { status: "added", reason: null, added: r.added.length, at }, bank: next, added: r.added.length, dropped: r.dropped };
}

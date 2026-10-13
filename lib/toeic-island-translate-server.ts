/**
 * lib/toeic-island-translate-server.ts — 🏝️ 답변 섬 문장의 AI 해석(`trKo`)을 **채워 저장하는** 서버 배선
 * (docs/harness/toeic.md §21-7, SPEC §23). 서버 전용 — 호출 G(lib/ai/toeic/calls translateIslandSentences)와 저장소를 잇는다.
 *
 * 부르는 곳 셋(전부 **부수 효과 — best-effort**. 이 모듈의 공개 함수는 던지지 않는다):
 * - `POST /api/toeic/island`(담은 직후) · `PATCH /api/toeic/island/[id]`(고친 직후) → `translateSavedIslandEntry`
 * - 오늘의 복습 `/toeic/review` 페이지 → `fillIslandTranslationsForReview`(이미 담긴 문장 채우기 — 요청당 한 묶음)
 * 담기·고치기·복습은 해석이 없어도 그대로 성공한다 — 키 없음·AI 실패·시간 초과는 조용히 "해석 없이"로 떨어진다
 * (복습 단서는 옛 순서 — lib/review-sources toeicIslandItems).
 *
 * 시간: 화면은 `budgetMs`까지만 기다린다. 그 안에 끝나지 않으면 해석 없이 응답하고, 이미 보낸 호출은 **끊지 않고**
 * 응답 뒤에 마저 저장한다(`after` — 호출 G 자체의 45초 상한 안). 그래서 느린 날에도 같은 묶음을 매번 버리고 다시 사지 않는다
 * (다음에 열면 채워져 있다). 저장은 원자 단위(`updateToeicIslandEntry`) 안에서 `applyIslandTranslation`이 판정한다 —
 * 그사이 섬 문장이 바뀌었으면 `stale`, 먼저 채워졌으면 `exists`로 쓰지 않는다(동시에 두 번 열려도 무해 — 비용만 한 번 더).
 *
 * 실패 격리(QA island-tr 1 P2-A): 묶음이 **내용 때문에** 실패하면(검증 위반·출력 미완성) 반으로 나눠 되는 것부터 저장하고, 한 문장으로도
 * 안 되는 항목은 프로세스 메모리에 쿨다운(6시간 — 문서에 표식을 남기지 않는다)을 걸어 다음 계획에서 뺀다. 채우기 한 번에 호출 G는
 * 최대 `TOEIC_ISLAND_TR_MAX_CALLS`(6)번 — 호출마다 검증 재요청이 한 번 붙을 수 있어 HTTP 요청으로는 최대 12. 새 호출은 시작 뒤
 * `TOEIC_ISLAND_TR_WORK_MAX_MS`(45초)까지만 연다. 첫 호출이 실패하면 다음 채우기의 첫 묶음 크기를 반으로 줄인다(성공하면 다시 키운다 —
 * 시간에 쫓겨 격리를 못 끝내도 다음에 열 때 더 작은 묶음으로 수렴한다). 연결 실패·5xx·429는 격리하지 않고 1분 쉰다(문장 탓이 아니다).
 * 진행 중인 항목은 같은 프로세스에서 다시 부르지 않는다(P3-D — 상한을 넘긴 직후 다시 열어도 같은 묶음을 또 사지 않는다).
 *
 * 로그는 개수·길이·시간만(섬 문장·해석 없음).
 */

import { after } from "next/server";
import { translateIslandSentences } from "./ai/toeic/calls";
import { parseReviewItemKey } from "./review-schedule";
import { getStore, type StudyStore } from "./store";
import {
  TOEIC_ISLAND_TR_BATCH_MAX,
  applyIslandTranslation,
  cleanIslandText,
  islandNeedsTranslation,
  planIslandTranslateBatches,
  type IslandTranslateTarget,
  type ToeicIslandEntry,
} from "./toeic-island";

/** 담기·고치기 응답이 해석을 기다리는 상한 — 넘으면 해석 없이 응답(저장은 응답 뒤에 마저 된다) */
export const TOEIC_ISLAND_TR_SAVE_WAIT_MS = 8_000;
/** 오늘의 복습 페이지가 해석 한 묶음을 기다리는 상한 — 넘으면 옛 단서로 연다 */
export const TOEIC_ISLAND_TR_REVIEW_WAIT_MS = 10_000;

/** 채우기 한 번(= 페이지 한 번·담기 한 번)에 보내는 호출 G의 최대 수 — 실패 격리로 묶음을 나눠 다시 청하는 것까지 합친 값 */
export const TOEIC_ISLAND_TR_MAX_CALLS = 6;
/** 채우기 한 번이 새 호출을 여는 시간 창(시작부터) — 넘으면 남은 항목은 다음 기회로 */
export const TOEIC_ISLAND_TR_WORK_MAX_MS = 45_000;
/** 한 문장으로도 해석에 실패한 항목을 계획에서 빼 두는 시간(프로세스 메모리 — 재시작하면 풀린다. 섬 문장을 고치면 바로 풀린다) */
export const TOEIC_ISLAND_TR_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** 연결 실패·5xx·429 뒤 해석 호출을 쉬는 시간 */
export const TOEIC_ISLAND_TR_OUTAGE_BACKOFF_MS = 60_000;

interface IslandTrState {
  /** 지금 해석을 받고 있는 항목 id */
  inflight: Set<string>;
  /** 한 문장으로도 실패한 항목 — id → 그때의 섬 문장·풀리는 시각 */
  cooldown: Map<string, { en: string; until: number }>;
  /** 이 시각까지 호출을 쉰다(연결 실패·5xx·429) */
  outageUntil: number;
  /** 다음 채우기의 첫 묶음 최대 항목 수 */
  startMax: number;
}

// 라우트 번들과 페이지 번들이 모듈 사본을 따로 가질 수 있어 프로세스 전역에 둔다
const STATE_KEY = Symbol.for("mysonstudy.toeicIslandTranslate");
function trState(): IslandTrState {
  const g = globalThis as unknown as Record<symbol, IslandTrState | undefined>;
  return (g[STATE_KEY] ??= { inflight: new Set(), cooldown: new Map(), outageUntil: 0, startMax: TOEIC_ISLAND_TR_BATCH_MAX });
}

/** 실패의 갈래 — content: 문장·출력 탓(나눠서 다시) · slow: 시간 상한·끊김(묶음을 줄인다) · outage: 연결·서버 탓(쉰다) */
function classifyTranslateFailure(err: unknown): "content" | "slow" | "outage" {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 400 || status === 422 ? "content" : "outage";
  const name = err instanceof Error ? `${err.name} ${err.constructor?.name ?? ""}` : "";
  if (/Abort|Timeout/.test(name)) return "slow";
  if (/APIConnection/.test(name)) return "outage";
  return "content";
}

function isCooling(st: IslandTrState, e: Pick<ToeicIslandEntry, "id" | "en">, now: number): boolean {
  const c = st.cooldown.get(e.id);
  if (!c) return false;
  if (c.until <= now || c.en !== cleanIslandText(e.en)) {
    st.cooldown.delete(e.id);
    return false;
  }
  return true;
}

export type IslandFillSkip = "nothing" | "no_key" | "timeout" | "failed";

export interface IslandFillResult {
  /** 이번에 해석이 붙은(또는 먼저 붙어 있던 것을 읽은) 항목 — id → 최신 항목 */
  updated: Map<string, ToeicIslandEntry>;
  /** 호출 G를 실제로 보냈나(과금) */
  called: boolean;
  /** 해석 없이 끝난 까닭(성공이면 null) */
  skipped: IslandFillSkip | null;
}

function hasKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** 묶음 하나를 호출 G 한 번으로 해석해 저장한다 — 호출이 실패하면 던진다(translateAndSave가 갈래를 보고 나눈다) */
async function translateAndSaveOnce(store: StudyStore, batch: readonly IslandTranslateTarget[], updated: Map<string, ToeicIslandEntry>): Promise<void> {
  const kos = await translateIslandSentences(batch.map((t) => t.en));
  let wrote = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const target = batch[i];
    const trKo = kos[i];
    if (typeof trKo !== "string") continue;
    try {
      // 판정과 쓰기를 한 원자 단위로 — stale(그사이 문장이 바뀜)·invalid는 쓰지 않고, exists는 먼저 채운 것을 그대로 읽는다
      const r = await store.updateToeicIslandEntry<ToeicIslandEntry | null>(target.id, (cur) => {
        const a = applyIslandTranslation(cur, { en: target.en, trKo });
        if (a.ok) return { entry: a.entry, result: a.entry };
        return { entry: null, result: a.reason === "exists" ? cur : null };
      });
      if (r) {
        updated.set(target.id, r);
        wrote += 1;
      }
    } catch (err) {
      console.error("[island-translate] 해석 저장 실패(그 항목만 건너뜀):", err instanceof Error ? err.name : "unknown");
    }
  }
  console.log(`[island-translate] ${batch.length}문장 해석 · ${wrote}개 반영`);
}

/**
 * 묶음을 해석해 저장한다 — **실패 격리**. 통째로 청해 보고, 내용 탓으로 실패하면 반으로 나눠(앞 절반 먼저) 다시 청한다.
 * 한 문장으로도 안 되면 그 항목에 쿨다운을 건다. 호출 수 `TOEIC_ISLAND_TR_MAX_CALLS`·시간 창 `TOEIC_ISLAND_TR_WORK_MAX_MS` 안에서만 돈다
 * (20문장 묶음도 앞 절반만 따라 내려가면 20→10→5→2→1 다섯 번이라, 여섯 번 안에 "저장" 아니면 "한 항목 쿨다운" 중 하나는 반드시 일어난다).
 * 붙은 항목은 `updated`에 그때그때 쌓인다(화면이 기다리다 끊겨도 그때까지 붙은 것은 쓴다).
 */
async function translateAndSave(store: StudyStore, batch: readonly IslandTranslateTarget[], updated: Map<string, ToeicIslandEntry>): Promise<void> {
  const st = trState();
  const started = Date.now();
  const stack: (readonly IslandTranslateTarget[])[] = [batch];
  let calls = 0;
  let cooled = 0;
  while (stack.length > 0 && calls < TOEIC_ISLAND_TR_MAX_CALLS && Date.now() - started < TOEIC_ISLAND_TR_WORK_MAX_MS) {
    const part = stack.pop() as readonly IslandTranslateTarget[];
    const first = calls === 0;
    calls += 1;
    try {
      await translateAndSaveOnce(store, part, updated);
      if (first) st.startMax = Math.min(TOEIC_ISLAND_TR_BATCH_MAX, Math.max(st.startMax, part.length) * 2);
    } catch (err) {
      const kind = classifyTranslateFailure(err);
      console.error(`[island-translate] 해석 실패(${part.length}문장 · ${kind} · ${Date.now() - started}ms):`, err instanceof Error ? err.constructor?.name ?? err.name : "unknown");
      if (kind === "outage") {
        st.outageUntil = Date.now() + TOEIC_ISLAND_TR_OUTAGE_BACKOFF_MS;
        break;
      }
      if (first) st.startMax = Math.max(1, Math.floor(part.length / 2));
      if (kind === "slow") break; // 느린 날에는 더 열지 않는다 — 다음 채우기가 줄어든 묶음으로 시작한다(쿨다운은 걸지 않는다 — 문장 탓이 아니다)
      if (part.length === 1) {
        st.cooldown.set(part[0].id, { en: part[0].en, until: Date.now() + TOEIC_ISLAND_TR_COOLDOWN_MS });
        cooled += 1;
      } else {
        const mid = Math.floor(part.length / 2);
        stack.push(part.slice(mid), part.slice(0, mid)); // 앞 절반을 먼저 꺼낸다
      }
    }
  }
  if (calls > 1 || cooled > 0) console.log(`[island-translate] 실패 격리: 호출 ${calls}번 · 반영 ${updated.size} · 쿨다운 ${cooled} · 남김 ${stack.reduce((n, p) => n + p.length, 0)}`);
}

/**
 * 해석이 빠진 항목을 **한 묶음만** 채운다(받은 순서대로 — 앞쪽이 먼저). 던지지 않는다.
 * 대상이 없으면 키 검사·AI 없이 끝난다. 키가 없으면 아무것도 하지 않는다.
 * 지금 해석을 받고 있는 항목과 쿨다운 중인 항목은 대상에서 빠진다. 호출 G는 실패 격리까지 합쳐 최대 TOEIC_ISLAND_TR_MAX_CALLS번.
 */
export async function fillIslandTranslations(
  entries: readonly ToeicIslandEntry[],
  opts: { budgetMs: number; store?: StudyStore },
): Promise<IslandFillResult> {
  const st = trState();
  const updated = new Map<string, ToeicIslandEntry>();
  const none = (skipped: IslandFillSkip, called = false): IslandFillResult => ({ updated: new Map(updated), called, skipped });
  let batch: IslandTranslateTarget[] | undefined;
  try {
    const now = Date.now();
    const candidates = entries.filter((e) => !st.inflight.has(e.id) && !isCooling(st, e, now));
    batch = planIslandTranslateBatches(candidates)[0]?.slice(0, st.startMax);
  } catch {
    return none("failed");
  }
  if (!batch || batch.length === 0) return none("nothing");
  if (!hasKey()) return none("no_key");
  if (Date.now() < st.outageUntil) return none("failed");
  const store = opts.store ?? getStore();

  const ids = batch.map((t) => t.id);
  for (const id of ids) st.inflight.add(id);
  // 일은 끝까지 간다(호출마다 자체 상한 45초 · 새 호출은 시간 창 안에서만). 화면은 budgetMs까지만 기다린다
  const work: Promise<boolean> = translateAndSave(store, batch, updated)
    .catch((err) => {
      console.error("[island-translate] 채우기 실패:", err instanceof Error ? err.name : "unknown");
    })
    .then(() => {
      for (const id of ids) st.inflight.delete(id);
      return true;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    work,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), opts.budgetMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (done) return updated.size > 0 ? { updated: new Map(updated), called: true, skipped: null } : none("failed", true);

  // 응답은 (그때까지 붙은 것만 싣고) 나간다 — 보낸 호출은 응답 뒤에 마저 저장한다(다음에 열면 채워져 있다)
  console.log(`[island-translate] ${opts.budgetMs}ms 안에 끝나지 않아 먼저 응답 — 저장은 응답 뒤에 이어 간다`);
  try {
    after(() => work.then(() => undefined));
  } catch {
    /* 요청 밖(스크립트)에서 불렸다 — work는 이미 돌고 있고 스스로 삼킨다 */
  }
  return none("timeout", true);
}

/**
 * 담은·고친 직후의 항목 하나 — 해석이 필요하면 만들어 붙인 최신 항목을, 아니면(필요 없음·키 없음·실패·시간 초과) 받은 항목을 그대로 돌려준다.
 */
export async function translateSavedIslandEntry(entry: ToeicIslandEntry, opts: { store?: StudyStore; budgetMs?: number } = {}): Promise<ToeicIslandEntry> {
  if (!islandNeedsTranslation(entry)) return entry;
  const r = await fillIslandTranslations([entry], { budgetMs: opts.budgetMs ?? TOEIC_ISLAND_TR_SAVE_WAIT_MS, store: opts.store });
  return r.updated.get(entry.id) ?? entry;
}

/**
 * 오늘의 복습(toeic) — 이미 담긴 섬 문장의 해석 채우기(요청당 한 묶음). 페이지가 큐를 만든 **뒤에** 부른다(다른 영역은 부르지 않는다).
 *
 * 키가 있고 해석이 빠진 섬 문장이 있으면 **오늘 큐에 나온 것을 앞세워** 한 묶음만 채운다. 하나라도 붙었으면 true —
 * 페이지가 큐를 다시 만들어 이번 화면의 단서에 반영한다. 키 없음·대상 없음·실패·시간 초과는 false(옛 단서 그대로). 던지지 않는다.
 */
export async function fillIslandTranslationsForReview(
  queuedCards: readonly { kind: string; itemKey: string }[],
  opts: { store?: StudyStore; budgetMs?: number } = {},
): Promise<boolean> {
  if (!hasKey()) return false;
  try {
    const store = opts.store ?? getStore();
    const entries = await store.listToeicIslandEntries();
    if (!entries.some(islandNeedsTranslation)) return false;
    const queued = new Set<string>();
    for (const c of queuedCards) {
      if (c.kind !== "toeic-island") continue;
      const k = parseReviewItemKey(c.itemKey);
      if (k) queued.add(k.raw);
    }
    const ordered = [...entries.filter((e) => queued.has(e.id)), ...entries.filter((e) => !queued.has(e.id))];
    const r = await fillIslandTranslations(ordered, { budgetMs: opts.budgetMs ?? TOEIC_ISLAND_TR_REVIEW_WAIT_MS, store });
    return r.updated.size > 0;
  } catch (err) {
    console.error("[island-translate] 복습 큐 해석 채우기 실패 — 옛 단서로 연다:", err instanceof Error ? err.name : "unknown");
    return false;
  }
}

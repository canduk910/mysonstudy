/**
 * lib/toeic-rec-store.ts — 모의고사 답변 녹음의 **기기 보관소** (IndexedDB, 클라이언트 전용) (docs/harness/toeic.md §6-4·§13-3·§13-6)
 *
 * 2026-10-03(§13)부터 녹음 원본은 **서버(GCS 비공개 버킷)에 보관**한다 — 이 기기 보관소는 **업로드 대기열 + 빠른 재생 캐시**다.
 * 응시 중 문항 녹음이 끝나면 먼저 여기 저장하고(네트워크가 끊겨도 잃지 않게), lib/toeic-rec-upload가 백그라운드로 올린다.
 * 메타의 `upload`가 대기열 상태다 — "pending"(아직 서버에 없음/모름) · "done"(서버가 받음) · "gone"(다시 보내도 받지 않음 — 캐시로만).
 * 필드가 없는 옛 메타는 "pending"으로 읽혀(§13-6 이행) 처음 토익 화면을 여는 순간부터 올라간다. DB 버전·store 이름은 그대로다.
 * 결과 화면은 이 기기 사본 → 서버 사본 순으로 소리를 찾는다(다른 기기에서는 서버 사본).
 *
 * 규칙(lib/tts-cache.ts 관용구):
 * - DB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`. 같은 키에 다시 쓰면 바꾼다("이 문항 다시" — 새 녹음은 다시 "pending").
 * - **최근 응시 5회분만** 남긴다(응시마다 가장 최근 녹음 시각으로 순위, 6번째부터 통째로 지운다) — 한 회 11문항 × 최대 ~1MB.
 *   **풀마다 따로** 센다(docs/harness/toeic.md §12-7-6): 메타 `pool`이 "mock"(모의고사 — 필드가 없는 옛 메타도)·"drill"(유형별 공략
 *   한 문제 연습). 실전 응시 뒤 채점 전에 연습을 여러 번 해도 실전 녹음이 밀려 지워지지 않게 — 같은 pickAttemptsToEvict를 풀별로 부른다.
 *   **"pending" 녹음이 하나라도 있는 응시는 정리에서 뺀다**(toeicRecPinnedAttempts, §13-3) — 서버에 없는 녹음을 지우면 영영 잃는다.
 *   고정된 응시는 순위 칸을 차지하지 않는다. 오래 오프라인이면 5회분을 넘어 늘 수 있다 — 잃는 것보다 낫다.
 * - 목록·정리는 메타 store만 읽는다(녹음 바이트를 한꺼번에 메모리에 올리지 않는다). 바이트는 `rec` store에 따로.
 * - **조용한 실패**: IndexedDB를 못 쓰는 환경(프라이빗 모드 등)이면 메모리에만 두고(이 탭의 마지막 응시분) 정상 동작한다.
 *   응시 → 결과 화면은 같은 탭 안 이동이라 메모리만으로도 다시 듣기·채점·업로드가 된다(올리기 전에 탭을 닫으면 사라진다).
 *
 * - **지우기**(2026-10-03, §14-4): 녹음 관리(결과 화면 "녹음 지우기"·"내 녹음" 목록)가 서버에서 지운 **뒤에** `deleteToeicRecordingsLocal`로
 *   이 기기 사본을 지운다 — 바이트·메타가 함께 사라지므로 **대기열(pending)에 있던 것은 업로드도 취소**된다(비우기는 매 차례 대기열을
 *   새로 읽는다). 다른 기기에서 지운 녹음은 그 기기의 결과 화면·목록이 지운 자리를 보고, 대기열은 409 recording_deleted를 받고 지운다.
 *   고칠 문장 다시 녹음(§14-5)은 이 보관소에 넣지 않는다(결과 화면이 메모리에 두고 바로 올린다).
 *
 * 순수 함수(pickAttemptsToEvict)는 브라우저 전역 없이 돌아 eval이 잠근다. ⚠️ 모듈 최상위에서 indexedDB를 읽지 않는다.
 */

import { toeicRecPinnedAttempts, toeicRecUploadStateOf, type ToeicRecUploadState } from "./toeic-rec-rules";

export type { ToeicRecUploadState };

export const TOEIC_REC_DB_NAME = "eunwoo-toeic-rec";
const DB_VERSION = 1;
const STORE_REC = "rec";
const STORE_META = "meta";

/** 남길 응시 수(§6-4 "최근 응시 5회분") — 풀마다 같은 값(§12-7-6) */
export const TOEIC_REC_KEEP_ATTEMPTS = 5;

/**
 * 녹음 보관 풀 — 모의고사 응시 / 한 문제 연습 응시(§12-7-6). 응시 화면이 문서의 drillPart로 고른다.
 * "mom"(2026-10-09, 엄마의 생활영어 주간 테스트 — 설계 §5): **기기에만** 둔다 — 서버 업로드 대기열에 넣지 않고("gone"으로 저장 →
 * 고정되지 않아 풀마다 최근 5회분 정리를 그대로 받는다), 토익 "내 녹음" 목록·대기열 목록에도 나오지 않는다. 풀이 따로라 토익 녹음을 밀어내지 않는다.
 */
export type ToeicRecPool = "mock" | "drill" | "mom";
export const TOEIC_REC_POOLS: readonly ToeicRecPool[] = ["mock", "drill", "mom"];

/** 메타의 풀 — "drill"·"mom"이 아니면 전부 "mock"(필드가 없는 옛 메타 = 모의고사 응시) */
export function toeicRecPoolOf(meta: { pool?: unknown }): ToeicRecPool {
  return meta.pool === "drill" ? "drill" : meta.pool === "mom" ? "mom" : "mock";
}

/** 기기에만 두는 풀(서버에 올리지 않는다) */
function isDeviceOnlyPool(meta: { pool?: unknown }): boolean {
  return toeicRecPoolOf(meta) === "mom";
}

export interface ToeicRecordingMeta {
  attemptId: string;
  /** 보관 풀(§12-7-6). 옛 메타에는 없다 — 읽을 때 toeicRecPoolOf로 "mock" */
  pool: ToeicRecPool;
  q: number;
  /** 실제 녹음 형식(recorder.mimeType) */
  mimeType: string;
  durationMs: number;
  size: number;
  /** 저장 시각(epoch ms) — 응시 순위, 서버 업로드의 recordedAt(같은 문항 녹음끼리 새것 가르기) */
  createdAt: number;
  /** 업로드 대기열 상태(§13-3). 옛 메타에는 없다 — 읽을 때 toeicRecUploadStateOf로 "pending" */
  upload: ToeicRecUploadState;
  /** 서버가 받은 시각(epoch ms). pending·gone이면 null */
  uploadedAt: number | null;
  /**
   * 그 녹음을 만든 다시 풀기 id(2026-10-03, docs/harness/toeic.md §15-3·§15-4 — 업로드가 `retakeId`로 싣는다). 처음 응시의 녹음·옛 메타는 null.
   * 결과 화면은 이 값이 지금 답의 세대와 같을 때만 "지금 녹음"으로 쓴다(§15-6).
   */
  retakeId: string | null;
}

/** 저장할 때 넘기는 녹음 — 대기열 필드는 저장이 "pending"으로 채운다 */
export type NewToeicRecording = Omit<ToeicRecording, "upload" | "uploadedAt">;

export interface ToeicRecording extends ToeicRecordingMeta {
  blob: Blob;
}

/** IndexedDB 키 */
export function toeicRecKey(attemptId: string, q: number): string {
  return `${attemptId}:${q}`;
}

/**
 * 지울 응시 id들(순수) — 응시마다 가장 최근 녹음 시각으로 내림차순, 앞 keep개만 남긴다. keepAlso(지금 쓰는 응시)는 늘 남긴다.
 * 시각이 같으면 id 사전순(결정적).
 */
export function pickAttemptsToEvict(
  entries: readonly { attemptId: string; createdAt: number }[],
  keep: number = TOEIC_REC_KEEP_ATTEMPTS,
  keepAlso: string | null = null,
): string[] {
  const latest = new Map<string, number>();
  for (const e of entries) latest.set(e.attemptId, Math.max(latest.get(e.attemptId) ?? -Infinity, e.createdAt));
  const ranked = [...latest.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id);
  const kept = new Set(ranked.slice(0, Math.max(0, keep)));
  if (keepAlso !== null) kept.add(keepAlso);
  return ranked.filter((id) => !kept.has(id));
}

/**
 * 풀마다 따로 지울 응시 id들(순수, §12-7-6) — 메타를 풀(toeicRecPoolOf — 옛 메타는 mock)로 나눠 풀마다 pickAttemptsToEvict(keep)를
 * 부르고 합친다. 연습을 몇 번 해도 모의고사 풀의 순위는 바뀌지 않는다(반대도 같다). keepAlso(지금 쓰는 응시)는 늘 남긴다.
 */
export function pickAttemptsToEvictByPool(
  entries: readonly { attemptId: string; createdAt: number; pool?: unknown }[],
  keep: number = TOEIC_REC_KEEP_ATTEMPTS,
  keepAlso: string | null = null,
): string[] {
  return TOEIC_REC_POOLS.flatMap((pool) =>
    pickAttemptsToEvict(
      entries.filter((e) => toeicRecPoolOf(e) === pool),
      keep,
      keepAlso,
    ),
  );
}

// ───────────────────────── 메모리 폴백(이 탭의 마지막 응시분) ─────────────────────────

const memory = new Map<string, ToeicRecording>();

function rememberInMemory(rec: ToeicRecording): void {
  // 다른 응시의 녹음은 비운다 — 탭 메모리에 여러 응시분 바이트를 쌓지 않는다
  // 엄마 풀과 토익 풀은 서로 비우지 않는다(엄마 테스트가 아직 못 올린 토익 메모리 녹음을 지우지 않게)
  for (const [k, v] of memory) if (v.attemptId !== rec.attemptId && isDeviceOnlyPool(v) === isDeviceOnlyPool(rec)) memory.delete(k);
  memory.set(toeicRecKey(rec.attemptId, rec.q), rec);
}

// ───────────────────────── IndexedDB ─────────────────────────

function hasIdb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TOEIC_REC_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REC)) db.createObjectStore(STORE_REC);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb blocked"));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isMeta(v: unknown): v is ToeicRecordingMeta {
  const m = v as Partial<ToeicRecordingMeta> | null;
  return !!m && typeof m.attemptId === "string" && typeof m.q === "number" && typeof m.createdAt === "number";
}

async function listAllMeta(db: IDBDatabase): Promise<ToeicRecordingMeta[]> {
  const all = await reqToPromise(db.transaction(STORE_META, "readonly").objectStore(STORE_META).getAll());
  // 옛 메타(pool 없음)는 모의고사 풀로 읽는다(§12-7-6)
  // 옛 메타(upload 없음)는 "pending"(§13-6 이행), uploadedAt 없음은 null
  return (all as unknown[])
    .filter(isMeta)
    .map((m) => ({
      ...m,
      pool: toeicRecPoolOf(m),
      upload: toeicRecUploadStateOf(m),
      uploadedAt: typeof m.uploadedAt === "number" ? m.uploadedAt : null,
      // 다시 풀기 세대(§15-4) — 옛 메타(필드 없음)는 처음 응시의 녹음
      retakeId: typeof (m as { retakeId?: unknown }).retakeId === "string" && (m as { retakeId: string }).retakeId !== "" ? (m as { retakeId: string }).retakeId : null,
    }));
}

/**
 * 녹음 한 문항 저장. 반환: "idb"(기기에 남음) / "memory"(IndexedDB 불가 — 이 탭에서만). 던지지 않는다.
 * 저장 뒤 풀마다 최근 5회분만 남기고 지운다(지금 응시는 늘 남긴다 — §12-7-6).
 */
export async function saveToeicRecording(input: NewToeicRecording): Promise<"idb" | "memory"> {
  const rec: ToeicRecording = isDeviceOnlyPool(input) ? { ...input, upload: "gone", uploadedAt: null } : { ...input, upload: "pending", uploadedAt: null };
  rememberInMemory(rec);
  if (!hasIdb()) return "memory";
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const key = toeicRecKey(rec.attemptId, rec.q);
    const meta: ToeicRecordingMeta = {
      attemptId: rec.attemptId,
      pool: toeicRecPoolOf(rec),
      q: rec.q,
      mimeType: rec.mimeType,
      durationMs: rec.durationMs,
      size: rec.size,
      createdAt: rec.createdAt,
      upload: rec.upload,
      uploadedAt: null,
      retakeId: typeof rec.retakeId === "string" && rec.retakeId !== "" ? rec.retakeId : null,
    };
    const tx = db.transaction([STORE_REC, STORE_META], "readwrite");
    tx.objectStore(STORE_REC).put(rec.blob, key);
    tx.objectStore(STORE_META).put(meta, key);
    await txDone(tx);
    await evict(db, rec.attemptId).catch(() => {});
    return "idb";
  } catch {
    return "memory";
  } finally {
    db?.close();
  }
}

async function evict(db: IDBDatabase, current: string): Promise<void> {
  // 아직 서버에 올리지 못한("pending") 녹음이 있는 응시는 정리 대상에서 먼저 뺀다(§13-3) — 순위 칸도 차지하지 않는다
  const all = await listAllMeta(db);
  const pinned = toeicRecPinnedAttempts(all);
  const metas = all.filter((m) => !pinned.has(m.attemptId));
  const drop = new Set(pickAttemptsToEvictByPool(metas, TOEIC_REC_KEEP_ATTEMPTS, current));
  if (drop.size === 0) return;
  const tx = db.transaction([STORE_REC, STORE_META], "readwrite");
  for (const m of metas) {
    if (!drop.has(m.attemptId)) continue;
    const key = toeicRecKey(m.attemptId, m.q);
    tx.objectStore(STORE_REC).delete(key);
    tx.objectStore(STORE_META).delete(key);
  }
  await txDone(tx);
}

/** 그 응시의 녹음들(q 오름차순). IndexedDB가 안 되면 메모리분. 던지지 않는다. */
export async function listToeicRecordings(attemptId: string): Promise<ToeicRecording[]> {
  const fromMemory = () =>
    [...memory.values()].filter((r) => r.attemptId === attemptId).sort((a, b) => a.q - b.q);
  if (!hasIdb()) return fromMemory();
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const metas = (await listAllMeta(db)).filter((m) => m.attemptId === attemptId).sort((a, b) => a.q - b.q);
    // 요청을 한 번에 다 걸고 기다린다 — 약속 사이에 트랜잭션이 닫히는 구형 Safari를 피한다
    const store = db.transaction(STORE_REC, "readonly").objectStore(STORE_REC);
    const blobs = await Promise.all(metas.map((m) => reqToPromise(store.get(toeicRecKey(m.attemptId, m.q))) as Promise<unknown>));
    const out: ToeicRecording[] = [];
    metas.forEach((m, i) => {
      const blob = blobs[i];
      if (blob instanceof Blob && blob.size > 0) out.push({ ...m, blob });
    });
    // IndexedDB 쓰기가 실패해 메모리에만 있는 문항을 보탠다(같은 탭)
    for (const r of fromMemory()) if (!out.some((x) => x.q === r.q)) out.push(r);
    return out.sort((a, b) => a.q - b.q);
  } catch {
    return fromMemory();
  } finally {
    db?.close();
  }
}

/** 녹음 한 문항(없으면 null). 던지지 않는다. */
export async function getToeicRecording(attemptId: string, q: number): Promise<ToeicRecording | null> {
  const list = await listToeicRecordings(attemptId);
  return list.find((r) => r.q === q) ?? null;
}

// ───────────────────────── 업로드 대기열(§13-3) — lib/toeic-rec-upload가 쓴다 ─────────────────────────

/** "pending" 녹음 메타 — 오래된 순(createdAt 오름차순). IndexedDB가 안 되면 메모리분. 던지지 않는다. */
export async function listPendingToeicRecordings(): Promise<ToeicRecordingMeta[]> {
  const fromMemory = (): ToeicRecordingMeta[] =>
    [...memory.values()].filter((r) => r.upload === "pending" && !isDeviceOnlyPool(r)).map(({ blob: _b, ...m }) => m);
  if (!hasIdb()) return fromMemory().sort((a, b) => a.createdAt - b.createdAt);
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const metas = (await listAllMeta(db)).filter((m) => m.upload === "pending" && !isDeviceOnlyPool(m));
    // IndexedDB 쓰기가 실패해 메모리에만 있는 녹음을 보탠다(같은 탭)
    for (const m of fromMemory()) if (!metas.some((x) => x.attemptId === m.attemptId && x.q === m.q)) metas.push(m);
    return metas.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return fromMemory().sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db?.close();
  }
}

/** 녹음 바이트 한 문항(같은 녹음 — createdAt이 같을 때만). 없으면 null. 던지지 않는다. */
export async function getToeicRecordingBlob(attemptId: string, q: number, createdAt: number): Promise<Blob | null> {
  const r = await getToeicRecording(attemptId, q);
  return r && r.createdAt === createdAt ? r.blob : null;
}

/**
 * 대기열 상태 바꾸기 — **같은 녹음일 때만**(메타의 createdAt이 올린 녹음과 같을 때). 올리는 사이 "이 문항 다시"로 새 녹음이 들어왔으면
 * 새 녹음을 done으로 바꾸지 않는다(새 녹음은 pending으로 남아 다음 차례에 올라간다). 던지지 않는다.
 */
export async function setToeicRecUploadState(
  attemptId: string,
  q: number,
  createdAt: number,
  upload: ToeicRecUploadState,
  uploadedAt: number | null,
): Promise<void> {
  const key = toeicRecKey(attemptId, q);
  const mem = memory.get(key);
  if (mem && mem.createdAt === createdAt) memory.set(key, { ...mem, upload, uploadedAt });
  if (!hasIdb()) return;
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const tx = db.transaction(STORE_META, "readwrite");
    const store = tx.objectStore(STORE_META);
    // 읽기와 쓰기를 같은 트랜잭션의 onsuccess 안에서 — 약속 사이에 트랜잭션이 닫히는 구형 Safari를 피한다
    const req = store.get(key);
    req.onsuccess = () => {
      const cur = req.result as unknown;
      if (isMeta(cur) && cur.createdAt === createdAt) store.put({ ...cur, upload, uploadedAt }, key);
    };
    await txDone(tx);
  } catch {
    // 조용한 실패 — 다음 비우기에서 서버가 reused로 답한다(멱등)
  } finally {
    db?.close();
  }
}

// ───────────────────────── 녹음 관리(§14-4) — 목록·지우기 ─────────────────────────

/** 이 기기의 토익 녹음 메타 전부(바이트 없이 — "내 녹음" 목록, 엄마 풀 제외). 오래된 순. IndexedDB가 안 되면 메모리분. 던지지 않는다. */
export async function listAllToeicRecordingMetas(): Promise<ToeicRecordingMeta[]> {
  const fromMemory = (): ToeicRecordingMeta[] => [...memory.values()].filter((r) => !isDeviceOnlyPool(r)).map(({ blob: _b, ...m }) => m);
  if (!hasIdb()) return fromMemory().sort((a, b) => a.createdAt - b.createdAt);
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const metas = (await listAllMeta(db)).filter((m) => !isDeviceOnlyPool(m));
    for (const m of fromMemory()) if (!metas.some((x) => x.attemptId === m.attemptId && x.q === m.q)) metas.push(m);
    return metas.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return fromMemory().sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db?.close();
  }
}

/**
 * 이 기기 사본 지우기 — 그 응시의 문항들(`"all"`이면 그 응시 전부). 바이트·메타를 함께 지운다(대기열에서도 빠진다 — 업로드 취소).
 * 서버에서 지운 **뒤에** 부른다(서버 먼저). 지운 수를 돌려준다. 던지지 않는다(실패하면 -1 — 다음에 화면이 지운 자리를 보고 다시 지운다).
 */
export async function deleteToeicRecordingsLocal(
  attemptId: string,
  qs: readonly number[] | "all",
  opts: { keepGeneration?: string | null; onlyGeneration?: string | null } = {},
): Promise<number> {
  // keepGeneration(§15-8): 예전 답 녹음을 지울 때 지금 답 세대의 사본은 남긴다(같은 키 `{attemptId}:{q}`에 세대가 하나만 산다)
  const keep = Object.prototype.hasOwnProperty.call(opts, "keepGeneration");
  // onlyGeneration(§15-5): 그 세대의 사본만 지운다 — 합쳐지지 않은 다시 풀기 녹음을 지울 때 다른 세대 사본(예: 기기 저장이 메모리로 떨어져
  // IndexedDB에 남은 예전 답 사본)은 건드리지 않는다(QA rec-retake P2-2)
  const only = Object.prototype.hasOwnProperty.call(opts, "onlyGeneration");
  const hit = (m: { attemptId: string; q: number; retakeId?: string | null }) =>
    m.attemptId === attemptId &&
    (qs === "all" || qs.includes(m.q)) &&
    !(keep && (m.retakeId ?? null) === (opts.keepGeneration ?? null)) &&
    !(only && (m.retakeId ?? null) !== (opts.onlyGeneration ?? null));
  let n = 0;
  for (const [k, v] of memory) {
    if (hit(v)) {
      memory.delete(k);
      n += 1;
    }
  }
  if (!hasIdb()) return n;
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const metas = (await listAllMeta(db)).filter(hit);
    if (metas.length === 0) return n;
    const tx = db.transaction([STORE_REC, STORE_META], "readwrite");
    for (const m of metas) {
      const key = toeicRecKey(m.attemptId, m.q);
      tx.objectStore(STORE_REC).delete(key);
      tx.objectStore(STORE_META).delete(key);
    }
    await txDone(tx);
    return Math.max(n, metas.length);
  } catch {
    return -1;
  } finally {
    db?.close();
  }
}

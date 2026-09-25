/**
 * lib/toeic-rec-store.ts — 모의고사 답변 녹음의 **기기 보관소** (IndexedDB, 클라이언트 전용) (docs/harness/toeic.md §0-2·§6-4·§8)
 *
 * 녹음은 **기기에만** 둔다 — 서버에는 전사문·점수·피드백만(원본 미저장 원칙 SPEC §13, Firestore 문서 1MB, 버킷 없음).
 * 결과 화면이 여기서 녹음을 꺼내 다시 듣기(▶)와 AI 채점 업로드를 한다. 다른 기기·브라우저에서는 없다 — 화면이
 * "녹음은 응시한 기기에만 있어요"로 안내한다.
 *
 * 규칙(lib/tts-cache.ts 관용구):
 * - DB `eunwoo-toeic-rec`, 키 `{attemptId}:{q}`. 같은 키에 다시 쓰면 바꾼다("이 문항 다시").
 * - **최근 응시 5회분만** 남긴다(응시마다 가장 최근 녹음 시각으로 순위, 6번째부터 통째로 지운다) — 한 회 11문항 × 최대 ~1MB.
 * - 목록·정리는 메타 store만 읽는다(녹음 바이트를 한꺼번에 메모리에 올리지 않는다). 바이트는 `rec` store에 따로.
 * - **조용한 실패**: IndexedDB를 못 쓰는 환경(프라이빗 모드 등)이면 메모리에만 두고(이 탭의 마지막 응시분) 정상 동작한다.
 *   응시 → 결과 화면은 같은 탭 안 이동이라 메모리만으로도 다시 듣기·채점이 된다(새로고침하면 사라진다).
 *
 * 순수 함수(pickAttemptsToEvict)는 브라우저 전역 없이 돌아 eval이 잠근다. ⚠️ 모듈 최상위에서 indexedDB를 읽지 않는다.
 */

export const TOEIC_REC_DB_NAME = "eunwoo-toeic-rec";
const DB_VERSION = 1;
const STORE_REC = "rec";
const STORE_META = "meta";

/** 남길 응시 수(§6-4 "최근 응시 5회분") */
export const TOEIC_REC_KEEP_ATTEMPTS = 5;

export interface ToeicRecordingMeta {
  attemptId: string;
  q: number;
  /** 실제 녹음 형식(recorder.mimeType) */
  mimeType: string;
  durationMs: number;
  size: number;
  /** 저장 시각(epoch ms) — 응시 순위 */
  createdAt: number;
}

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

// ───────────────────────── 메모리 폴백(이 탭의 마지막 응시분) ─────────────────────────

const memory = new Map<string, ToeicRecording>();

function rememberInMemory(rec: ToeicRecording): void {
  // 다른 응시의 녹음은 비운다 — 탭 메모리에 여러 응시분 바이트를 쌓지 않는다
  for (const [k, v] of memory) if (v.attemptId !== rec.attemptId) memory.delete(k);
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
  return (all as unknown[]).filter(isMeta);
}

/**
 * 녹음 한 문항 저장. 반환: "idb"(기기에 남음) / "memory"(IndexedDB 불가 — 이 탭에서만). 던지지 않는다.
 * 저장 뒤 최근 5회분만 남기고 지운다(지금 응시는 늘 남긴다).
 */
export async function saveToeicRecording(rec: ToeicRecording): Promise<"idb" | "memory"> {
  rememberInMemory(rec);
  if (!hasIdb()) return "memory";
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const key = toeicRecKey(rec.attemptId, rec.q);
    const meta: ToeicRecordingMeta = {
      attemptId: rec.attemptId,
      q: rec.q,
      mimeType: rec.mimeType,
      durationMs: rec.durationMs,
      size: rec.size,
      createdAt: rec.createdAt,
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
  const metas = await listAllMeta(db);
  const drop = new Set(pickAttemptsToEvict(metas, TOEIC_REC_KEEP_ATTEMPTS, current));
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

/**
 * lib/ja-audio-store.ts — 🗓️ 오늘의 일본어 **원음 기기 보관소**(IndexedDB, 브라우저 전용) (설계 §2-2).
 *
 * - DB `eunwoo-ja-audio`, store `tracks`(keyPath `key` = audioKey), 저장 값 `{ key, type, data: ArrayBuffer, bytes, savedAt }`.
 *   **IndexedDB에 Blob을 넣지 않는다**(app-patterns §8 — WebKit은 이전 프로세스가 쓴 Blob 레코드를 다시 쓰면 그 레코드·꺼낸 Blob을
 *   읽을 수 없게 만든다. 원음 묶음을 다시 가져오면 같은 키를 덮어쓰므로 정확히 그 조건이다). 바이트로 넣고, 꺼낼 때마다 새 메모리 Blob을
 *   만들어 내준다(2단계에서 바꿈 — 바깥 모양 `JaAudioTrack.blob`은 그대로). 옛 Blob 레코드(`blob` 칸)도 읽는다.
 * - **원음은 서버로 보내지 않는다** — 이 모듈은 fetch를 쓰지 않는다. 서버(라우트·store)에서 import하지 않는다.
 * - 가져오기(`importJaAudioPack`)는 묶음을 `File.slice`로 **트랙 하나씩** 읽어 넣는다(파일 전체를 메모리에 올리지 않는다).
 *   이미 있는 키는 덮어쓴다(멱등). 중간에 끊겨도 들어간 트랙은 남는다(트랙마다 따로 커밋). 진행률은 콜백으로.
 *   조각은 ArrayBuffer로 읽어 그대로 넣는다 — 고른 파일(File)과의 연결을 끊어 iOS가 원본 파일 접근을 거둬도 재생된다.
 * - `requestJaAudioPersist()` — 가져오기 탭 안에서 한 번 `navigator.storage.persist()`(iOS가 지우지 않게 — 결과는 안내만).
 * - **조용한 실패**: IndexedDB를 못 쓰면(프라이빗 모드 등) 가져오기는 실패를 돌려주고, 조회는 null — 화면은 합성 음성으로 이어 간다.
 *
 * ⚠️ 모듈 최상위에서 indexedDB·window를 읽지 않는다(서버 렌더·eval에서 import만 해도 안전).
 */
import { jaPackSlice, readJaPackIndex, type JaPackBlobLike, type JaPackError } from "./ja-audio-pack";

export const JA_AUDIO_DB_NAME = "eunwoo-ja-audio";
const DB_VERSION = 1;
const STORE = "tracks";

export interface JaAudioTrack {
  key: string;
  type: string;
  blob: Blob;
  bytes: number;
  savedAt: number;
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let openedDb: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const f = idb();
  if (!f) return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = f.open(JA_AUDIO_DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      let settled = false;
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          // onblocked로 이미 null을 돌려준 뒤 늦게 열렸다 — 들고 있지 않고 닫는다(QA daily1 P3-e)
          db.close();
          return;
        }
        settled = true;
        // 브라우저가 연결을 닫거나(onclose) 다른 탭이 버전을 올리면(onversionchange) 캐시를 비워 다음 호출이 다시 연다(QA daily1 P3-e)
        db.onclose = () => {
          if (dbPromise && openedDb === db) dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          if (dbPromise && openedDb === db) dbPromise = null;
        };
        openedDb = db;
        resolve(db);
      };
      req.onerror = () => {
        settled = true;
        resolve(null);
      };
      req.onblocked = () => {
        settled = true;
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  }).then((db) => {
    if (!db) dbPromise = null; // 다음 호출에서 다시 시도
    return db;
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      let value: T | null = null;
      req.onsuccess = () => {
        value = req.result;
      };
      t.oncomplete = () => resolve(value);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** 트랙 하나 넣기(같은 키는 바꾼다). 성공 여부 */
/** 저장 모양 — 바이트(data). 옛 레코드는 blob 칸 */
interface StoredJaAudioTrack {
  key: string;
  type: string;
  data?: ArrayBuffer;
  blob?: Blob;
  bytes: number;
  savedAt: number;
}

/** 트랙 하나 넣기(같은 키는 바꾼다) — 바이트로 넣는다. 성공 여부 */
export async function putJaAudioTrack(track: JaAudioTrack | (Omit<JaAudioTrack, "blob"> & { data: ArrayBuffer })): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const data = "data" in track ? track.data : await track.blob.arrayBuffer();
  const rec: StoredJaAudioTrack = { key: track.key, type: track.type, data, bytes: track.bytes, savedAt: track.savedAt };
  const r = await tx(db, "readwrite", (s) => s.put(rec));
  return r !== null;
}

/** 꺼낼 때마다 새 메모리 Blob(IDB 레코드를 가리키는 Blob은 밖으로 내보내지 않는다) */
export async function getJaAudioTrack(key: string): Promise<JaAudioTrack | null> {
  const db = await openDb();
  if (!db) return null;
  const r = await tx<StoredJaAudioTrack | undefined>(db, "readonly", (s) => s.get(key) as IDBRequest<StoredJaAudioTrack | undefined>);
  if (!r) return null;
  try {
    const data = r.data ?? (r.blob ? await r.blob.arrayBuffer() : null);
    if (!data || data.byteLength === 0) return null;
    return { key: r.key, type: r.type, blob: new Blob([data], { type: r.type }), bytes: r.bytes, savedAt: r.savedAt };
  } catch {
    return null;
  }
}

export async function countJaAudioTracks(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  return (await tx(db, "readonly", (s) => s.count())) ?? 0;
}

/** 들어 있는 키 목록(바이트는 읽지 않는다) */
export async function listJaAudioKeys(): Promise<string[]> {
  const db = await openDb();
  if (!db) return [];
  const keys = await tx(db, "readonly", (s) => s.getAllKeys());
  return (keys ?? []).map(String);
}

/** iOS가 지우지 않게 저장소 유지를 한 번 요청 — 결과는 안내용(true/false), 지원하지 않으면 null */
export async function requestJaAudioPersist(): Promise<boolean | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export type JaAudioImportResult =
  | { ok: true; saved: number; total: number; aborted: boolean }
  | { ok: false; error: JaPackError | "no_storage" | "write_failed" | "read_failed"; messageKo: string; saved: number; total: number };

const READ_FAILED_KO = "파일을 읽는 중 끊겼어요 — 다시 가져오면 이어서 넣어요(들어간 트랙은 남아 있어요).";

/**
 * 원음 묶음 가져오기 — 트랙 하나씩 읽어 넣는다. onProgress(saved, total)는 트랙마다.
 * signal로 끊으면 거기서 멈추고 들어간 것은 남긴다(aborted: true).
 * **던지지 않는다**: 파일 읽기 실패(iOS가 앱을 내리거나 화면이 잠겨 File 접근을 거두면 NotReadableError)는
 * `{ok:false, error:"read_failed"}` — 화면이 진행 막대를 거두고 다시 가져오기를 안내한다(QA daily-full P2-B).
 */
export async function importJaAudioPack(
  file: JaPackBlobLike,
  opts: { onProgress?: (saved: number, total: number) => void; signal?: AbortSignal; now?: () => number } = {},
): Promise<JaAudioImportResult> {
  let idx: Awaited<ReturnType<typeof readJaPackIndex>>;
  try {
    idx = await readJaPackIndex(file);
  } catch {
    return { ok: false, error: "read_failed", messageKo: READ_FAILED_KO, saved: 0, total: 0 };
  }
  if (!idx.ok) return { ok: false, error: idx.error, messageKo: idx.messageKo, saved: 0, total: 0 };
  const total = idx.value.length;
  const db = await openDb();
  if (!db) return { ok: false, error: "no_storage", messageKo: "이 기기에서는 원음을 보관할 수 없어요. 합성 음성으로 들을 수 있어요.", saved: 0, total };
  const now = opts.now ?? (() => Date.now());
  let saved = 0;
  for (const e of idx.value) {
    if (opts.signal?.aborted) return { ok: true, saved, total, aborted: true };
    let buf: ArrayBuffer;
    try {
      buf = await jaPackSlice(file, e);
    } catch {
      return { ok: false, error: "read_failed", messageKo: READ_FAILED_KO, saved, total };
    }
    let ok = false;
    try {
      ok = await putJaAudioTrack({ key: e.key, type: e.type, data: buf, bytes: e.length, savedAt: now() });
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, error: "write_failed", messageKo: "원음을 저장하지 못했어요(저장 공간을 확인해 주세요). 들어간 트랙은 남아 있어요.", saved, total };
    saved += 1;
    opts.onProgress?.(saved, total);
  }
  return { ok: true, saved, total, aborted: false };
}

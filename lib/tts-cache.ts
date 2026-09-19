/**
 * lib/tts-cache.ts — 클라우드 TTS 오디오의 **영속(2차) 캐시** (SPEC §16). 클라이언트 전용, 런타임 의존성 없음.
 *
 * lib/speech.ts의 메모리 Map이 1차(세션 내), 이 모듈이 2차(IndexedDB, 세션·앱 종료를 넘어 유지)다. 단어장은
 * 같은 걸 반복해 보는 물건이라, 열 때마다 재합성하면 지연·요금이 다시 든다 — 그래서 한 번 만든 오디오를 디스크에
 * 남긴다. 합성 지연(~1.3초)은 바닥이라(모델·스트리밍으로 못 줄인다) **캐시 적중률만이 답**이라는 실측에 근거.
 *
 * 규칙:
 * - 키는 speech.ts와 동일(`${lang}:${speed}:${text}`). 값은 오디오 Blob.
 * - **지문 무효화**: 음성(OPENAI_TTS_VOICE)·모델이 바뀌면 옛 오디오가 남아 **옛 목소리가 섞여 나온다.**
 *   GET /api/tts의 `voice|model`을 지문으로 삼아, 저장된 지문과 다르면 store를 **통째로 비운다**(키는 그대로 두되
 *   store를 갈아엎어 잔재 0). 지문을 못 구하면(오프라인 등) **IDB를 아예 쓰지 않는다**(메모리만) — 검증 안 된
 *   목소리를 절대 내보내지 않기 위해.
 * - **LRU 상한**: 항목 수·총 바이트를 넘으면 가장 오래 안 쓴 것부터 축출(오디오 1개 ~20~60KB).
 * - **조용한 실패**: IDB를 못 쓰는 환경(프라이빗 모드 등)이면 메모리만 쓰고 정상 동작(에러 없음).
 * - device 엔진 언어는 speech.ts가 이 모듈을 **아예 부르지 않는다**(조회·저장 0) — 기존 하드 요구 유지.
 */

/** LRU 상한 기본값(테스트에서 __setTtsCacheLimits로 낮춰 검증). */
let MAX_ITEMS = 300;
let MAX_BYTES = 50 * 1024 * 1024; // 50MB

export interface TtsKvEntry {
  blob: Blob;
  size: number;
  atime: number; // 마지막 접근(LRU)
}

/** 영속 백엔드 최소 계약 — 기본은 IndexedDB, 테스트는 인메모리 페이크를 주입한다. LRU·지문 로직은 이 모듈이 쥔다. */
export interface TtsKvBackend {
  get(key: string): Promise<TtsKvEntry | null>;
  put(key: string, entry: TtsKvEntry): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<{ key: string; size: number; atime: number }[]>;
  clear(): Promise<void>;
  getFingerprint(): Promise<string | null>;
  setFingerprint(fp: string): Promise<void>;
}

let backend: TtsKvBackend | null | undefined = undefined; // undefined=미결정, null=사용안함(메모리만)
let fingerprintProvider: (() => Promise<string | null>) | null = null;
let initPromise: Promise<boolean> | null = null; // 지문 확인 완료 + IDB 사용 가능 여부

/** 지문 공급자 설정 — speech.ts가 GET /api/tts로 voice|model을 가져오게 꽂는다. */
export function setTtsFingerprintProvider(fn: (() => Promise<string | null>) | null): void {
  fingerprintProvider = fn;
}

/** 백엔드 주입(브라우저=IDB 자동, 테스트=페이크). 다시 설정하면 init을 리셋한다. */
export function setTtsKvBackend(b: TtsKvBackend | null): void {
  backend = b;
  initPromise = null;
}

/** 테스트용 상한 조정. */
export function __setTtsCacheLimits(items: number, bytes: number): void {
  MAX_ITEMS = items;
  MAX_BYTES = bytes;
}

async function resolveBackend(): Promise<TtsKvBackend | null> {
  if (backend === undefined) {
    backend = typeof indexedDB !== "undefined" ? createIdbBackend() : null;
  }
  if (!backend) return null;
  if (!initPromise) initPromise = initFingerprint(backend);
  const usable = await initPromise;
  return usable ? backend : null;
}

/** 지문을 확인해 바뀌었으면 store를 비운다. 지문을 못 구하면 false(=IDB 사용 안 함, 메모리만). */
async function initFingerprint(b: TtsKvBackend): Promise<boolean> {
  try {
    const current = fingerprintProvider ? await fingerprintProvider() : null;
    if (!current) return false; // 지문 미상 → 검증 안 된 목소리를 낼 수 없으니 IDB 미사용
    const stored = await b.getFingerprint();
    if (stored !== current) {
      await b.clear(); // 음성·모델이 바뀌었다 → 옛 오디오 전부 폐기
      await b.setFingerprint(current);
    }
    return true;
  } catch {
    return false; // IDB 문제 → 조용히 메모리만
  }
}

/** 2차 캐시 조회. 없거나 IDB 불가면 null. 조회 시 atime 갱신(LRU). */
export async function ttsCacheGet(key: string): Promise<Blob | null> {
  const b = await resolveBackend();
  if (!b) return null;
  try {
    const entry = await b.get(key);
    if (!entry) return null;
    void b.put(key, { ...entry, atime: Date.now() }); // touch (best-effort)
    return entry.blob;
  } catch {
    return null;
  }
}

/** 2차 캐시 저장(best-effort) + LRU 축출. */
export async function ttsCachePut(key: string, blob: Blob): Promise<void> {
  const b = await resolveBackend();
  if (!b) return;
  try {
    await b.put(key, { blob, size: blob.size ?? 0, atime: Date.now() });
    await evictIfNeeded(b);
  } catch {
    /* noop — 캐시는 최적화일 뿐 */
  }
}

async function evictIfNeeded(b: TtsKvBackend): Promise<void> {
  const items = await b.list();
  let count = items.length;
  let bytes = items.reduce((s, i) => s + i.size, 0);
  if (count <= MAX_ITEMS && bytes <= MAX_BYTES) return;
  const oldestFirst = [...items].sort((a, z) => a.atime - z.atime);
  for (const it of oldestFirst) {
    if (count <= MAX_ITEMS && bytes <= MAX_BYTES) break;
    await b.delete(it.key);
    count -= 1;
    bytes -= it.size;
  }
}

// ───────────────────────── IndexedDB 백엔드 (브라우저 기본) ─────────────────────────

const DB_NAME = "eunwoo-tts";
const DB_VERSION = 1;
const STORE_AUDIO = "audio";
const STORE_META = "meta";
const META_FP_KEY = "fingerprint";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO, { keyPath: "key" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB 어댑터. 저장 레코드: {key, blob, size, atime}(audio store), 지문(meta store). */
function createIdbBackend(): TtsKvBackend {
  return {
    async get(key) {
      const db = await openDb();
      try {
        const rec = await reqToPromise(db.transaction(STORE_AUDIO, "readonly").objectStore(STORE_AUDIO).get(key));
        if (!rec) return null;
        return { blob: rec.blob, size: rec.size, atime: rec.atime };
      } finally {
        db.close();
      }
    },
    async put(key, entry) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_AUDIO, "readwrite");
        tx.objectStore(STORE_AUDIO).put({ key, blob: entry.blob, size: entry.size, atime: entry.atime });
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_AUDIO, "readwrite");
        tx.objectStore(STORE_AUDIO).delete(key);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openDb();
      try {
        const recs = await reqToPromise(db.transaction(STORE_AUDIO, "readonly").objectStore(STORE_AUDIO).getAll());
        return (recs as { key: string; size: number; atime: number }[]).map((r) => ({ key: r.key, size: r.size, atime: r.atime }));
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_AUDIO, "readwrite");
        tx.objectStore(STORE_AUDIO).clear();
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async getFingerprint() {
      const db = await openDb();
      try {
        const v = await reqToPromise(db.transaction(STORE_META, "readonly").objectStore(STORE_META).get(META_FP_KEY));
        return (v as string | undefined) ?? null;
      } finally {
        db.close();
      }
    },
    async setFingerprint(fp) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_META, "readwrite");
        tx.objectStore(STORE_META).put(fp, META_FP_KEY);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
  };
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

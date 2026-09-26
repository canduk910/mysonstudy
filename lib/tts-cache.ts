/**
 * lib/tts-cache.ts — 클라우드 TTS 오디오의 **영속(2차) 캐시** (SPEC §16). 클라이언트 전용. 런타임 import는
 * 의존성 0인 `./tts-shared`뿐이다(번들 경계 — openai·store를 끌어오지 않는다).
 *
 * lib/speech.ts의 메모리 Map이 1차(세션 내), 이 모듈이 2차(IndexedDB, 세션·앱 종료를 넘어 유지)다. 단어장은
 * 같은 걸 반복해 보는 물건이라, 열 때마다 재합성하면 지연·요금이 다시 든다 — 그래서 한 번 만든 오디오를 디스크에
 * 남긴다. 합성 지연(~1.3초)은 바닥이라(모델·스트리밍으로 못 줄인다) **캐시 적중률만이 답**이라는 실측에 근거.
 *
 * 규칙:
 * - 키는 speech.ts와 동일(`${lang}:${speed}:${text}`).
 * - **오디오는 Blob이 아니라 바이트(ArrayBuffer)+형식으로 저장하고, 꺼낼 때마다 `new Blob([bytes])`로 새 메모리 Blob을 만든다.**
 *   **오디오가 든 레코드는 조회 때 다시 쓰지 않는다**(LRU 시각은 오디오 없는 목록 레코드만 고친다 — `touch`).
 *   왜(2026-09-27 iPhone 신고 "클라우드 실패(재생 NotSupportedError) → 기기 음성"): 예전엔 IDB에서 꺼낸 Blob을 atime을 고치려고
 *   같은 키에 다시 put했다. WebKit에서 **이전 프로세스(앱 재실행 전)가 쓴 Blob 레코드**를 이렇게 다시 쓰면 꺼낸 Blob이 읽히지 않고
 *   (`WebKitBlobResource error 1`) 그 레코드도 그 프로세스 동안 죽는다 → `<audio>` error 4 → `play()` NotSupportedError. 죽은 Blob도
 *   null이 아니라 재합성이 영영 일어나지 않았다(QA 리포트 common_tts-notsupported_1 — Chromium은 정상이라 로컬에서 안 보였다).
 *   바이트 레코드는 IDB가 Blob 파일을 따로 두지 않아 이 결함 밖이다.
 * - **옛 형식(v1, `{key, blob, size, atime}`) 레코드**: 꺼내면 곧바로 바이트로 읽어(`arrayBuffer`, 상한 `LEGACY_READ_TIMEOUT_MS`)
 *   메모리 Blob으로 돌려주고, 바이트를 손에 쥔 **뒤에** 새 형식으로 옮겨 적는다(재합성 비용 0 — 디스크의 옛 오디오는 멀쩡하다).
 *   읽기가 실패하거나(이미 죽었다)·매달리거나·오디오 형식이 아니면 **미스로 보고 지운다**(그 한 건만 재합성).
 * - **지문 무효화**: 음성(OPENAI_TTS_VOICE)·모델이 바뀌면 옛 오디오가 남아 **옛 목소리가 섞여 나온다.**
 *   GET /api/tts의 `voice|model`을 지문으로 삼아, 저장된 지문과 다르면 store를 **통째로 비운다**(키는 그대로 두되
 *   store를 갈아엎어 잔재 0). 지문을 못 구하면 **IDB를 쓰지 않는다**(메모리만) — 검증 안 된 목소리를 절대 내보내지 않기 위해.
 *   단, 못 구한 이유를 둘로 가른다(§18-2): 서버가 **명시적으로 지문 없음**(공급자가 null)이면 그 세션 내내 메모리만.
 *   **타임아웃·네트워크 실패**(공급자가 throw)면 이번 조회만 메모리로 처리하고 **다음 조회 때 다시 묻는다**(최대 3회) —
 *   한 번의 느린 응답이 영어 단어장까지 모든 화면의 영속 캐시를 그 세션 내내 꺼 재합성 요금을 내지 않게.
 * - **LRU 상한**: 항목 수·총 바이트를 넘으면 가장 오래 안 쓴 것부터 축출(오디오 1개 ~20~60KB).
 * - **쓰기는 한 줄로 선다**(`enqueueWrite`): 저장·삭제·LRU·형식 이전이 부른 순서대로 끝난다 — 재생 실패로 지운 키(speech.ts 자가 치유)를
 *   늦게 끝난 옛 쓰기가 되살리지 않게.
 * - **조용한 실패**: IDB를 못 쓰는 환경(프라이빗 모드 등)이면 메모리만 쓰고 정상 동작(에러 없음).
 * - device 엔진 언어는 speech.ts가 이 모듈을 **아예 부르지 않는다**(조회·저장 0) — 기존 하드 요구 유지.
 */

import { audioMediaType, TTS_AUDIO_MIME } from "./tts-shared";

/**
 * LRU 상한 기본값(테스트에서 __setTtsCacheLimits로 낮춰 검증).
 * 항목 300→1000(§18-3): 해설 한 번이면 한국어 조각 30~60개가 들어와, 300이면 대화 몇 개만 들어도 은우의 영어 단어
 * 오디오가 밀려난다. 실제 제약은 바이트 상한(50MB 그대로)이 한다.
 */
let MAX_ITEMS = 1000;
let MAX_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * 옛 형식 Blob 읽기 대기 상한(ms). 죽은 Blob은 대개 곧바로 NotFoundError로 거부되지만, 읽기가 매달리면 그 키의 재생이
 * 합성 대기 상한(8초)까지 묶이므로 이만큼 지나면 미스로 본다. 테스트는 `__setLegacyReadTimeout`으로 줄인다.
 */
let LEGACY_READ_TIMEOUT_MS = 3000;

/** 새 형식으로 쓸 오디오 한 건. `bytes`는 ArrayBuffer(Blob 금지 — 위 규칙). */
export interface TtsKvWrite {
  bytes: ArrayBuffer;
  /** 오디오 MIME(예: audio/mpeg) */
  type: string;
  size: number;
  atime: number; // 마지막 접근(LRU)
}

/**
 * 백엔드 `get`의 결과 — 새 형식(바이트) 또는 옛 형식(v1 Blob). 새 형식인데 바이트가 없으면(목록과 바이트가 어긋남) `bytes: null`.
 * 이 모듈은 둘 다 **메모리 Blob으로 바꿔서만** 밖에 내준다.
 */
export type TtsKvRecord =
  | { kind: "bytes"; bytes: ArrayBuffer | null; type: string; size: number; atime: number }
  | { kind: "legacy"; blob: Blob; size: number; atime: number };

/** 영속 백엔드 최소 계약 — 기본은 IndexedDB, 테스트는 인메모리 페이크를 주입한다. LRU·지문·형식 판정은 이 모듈이 쥔다. */
export interface TtsKvBackend {
  get(key: string): Promise<TtsKvRecord | null>;
  /** 새 형식으로 쓴다(같은 키의 옛 형식 레코드는 바뀐다). 새 합성 저장·옛 형식 이전만 부른다 — **조회 경로에서 부르지 않는다.** */
  put(key: string, entry: TtsKvWrite): Promise<void>;
  /** LRU 시각만 고친다. **오디오(바이트·Blob)가 든 레코드는 다시 쓰지 않는다** — 옛 형식 레코드면 아무것도 하지 않는다. */
  touch(key: string, atime: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<{ key: string; size: number; atime: number }[]>;
  clear(): Promise<void>;
  getFingerprint(): Promise<string | null>;
  setFingerprint(fp: string): Promise<void>;
}

let backend: TtsKvBackend | null | undefined = undefined; // undefined=미결정, null=사용안함(메모리만)
let fingerprintProvider: (() => Promise<string | null>) | null = null;
/** 지문 확인 완료 + IDB 사용 가능 여부. 일시 실패면 비워서(null) 다음 조회가 다시 묻게 한다. */
let initPromise: Promise<boolean> | null = null;

/** 지문 조회 일시 실패(타임아웃·네트워크) 허용 횟수 — 이만큼 실패하면 그 세션은 메모리만(§18-2). */
const FINGERPRINT_MAX_ATTEMPTS = 3;
let fingerprintFailures = 0;

/** 쓰기 줄(위 규칙) — 늘 성공으로 끝나는 꼬리만 붙잡는다. */
let writeChain: Promise<void> = Promise.resolve();

/** 쓰기 하나를 줄 끝에 세운다. 반환 약속은 그 쓰기의 결과(실패면 reject — 호출부가 삼킨다). */
function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const p = writeChain.then(fn);
  writeChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * 지문 공급자 설정 — speech.ts가 GET /api/tts로 voice|model을 가져오게 꽂는다.
 * 계약: 지문 문자열 = 확인됨 / **null = 서버가 명시적으로 지문 없음**(세션 내내 메모리만) /
 * **throw = 일시 실패**(타임아웃·네트워크 — 이번 조회만 메모리, 다음 조회 때 다시, 최대 3회).
 */
export function setTtsFingerprintProvider(fn: (() => Promise<string | null>) | null): void {
  fingerprintProvider = fn;
}

/** 백엔드 주입(브라우저=IDB 자동, 테스트=페이크). 다시 설정하면 init과 지문 실패 횟수를 리셋한다. */
export function setTtsKvBackend(b: TtsKvBackend | null): void {
  backend = b;
  initPromise = null;
  fingerprintFailures = 0;
}

/** 테스트용 상한 조정. */
export function __setTtsCacheLimits(items: number, bytes: number): void {
  MAX_ITEMS = items;
  MAX_BYTES = bytes;
}

/** 테스트용 — 옛 형식 Blob 읽기 대기 상한(null이면 기본 3초). */
export function __setLegacyReadTimeout(ms: number | null): void {
  LEGACY_READ_TIMEOUT_MS = ms ?? 3000;
}

/** 테스트용 — 줄에 선 쓰기(LRU·형식 이전·삭제)가 모두 끝날 때까지 기다린다. */
export function __flushTtsCacheWrites(): Promise<void> {
  return writeChain;
}

/**
 * 쓸 수 있는 백엔드(지문 확인 완료) 또는 null(메모리만).
 * `initiate=false`(저장·삭제 경로): 지문 조회를 **새로 일으키지 않는다** — 일시 실패 직후의 저장이 재시도 횟수를 갉아먹지 않게.
 * 저장은 늘 조회(getAudioBlob) 뒤에 오므로, 지문이 확인된 세션에서는 이 제한이 걸리지 않는다.
 */
async function resolveBackend(initiate = true): Promise<TtsKvBackend | null> {
  if (backend === undefined) {
    backend = typeof indexedDB !== "undefined" ? createIdbBackend() : null;
  }
  if (!backend) return null;
  if (!initPromise) {
    if (!initiate) return null;
    const p: Promise<boolean> = initFingerprint(backend).then((r) => {
      // 일시 실패 — 이번 조회(이 약속을 함께 기다린 조회들)만 메모리. 다음 조회가 다시 묻도록 비운다.
      if (r === "retry" && initPromise === p) initPromise = null;
      return r === "ok";
    });
    initPromise = p;
  }
  const usable = await initPromise;
  return usable ? backend : null;
}

/**
 * 지문을 확인해 바뀌었으면 store를 비운다.
 * "ok" = IDB 사용 / "off" = 세션 내내 메모리만(지문 명시적 없음·IDB 문제·일시 실패 3회) / "retry" = 이번만 메모리, 다음 조회에서 다시.
 */
async function initFingerprint(b: TtsKvBackend): Promise<"ok" | "off" | "retry"> {
  let current: string | null;
  try {
    current = fingerprintProvider ? await fingerprintProvider() : null;
  } catch {
    // 타임아웃·네트워크 실패 — 세션을 영구히 메모리만으로 고정하지 않는다(최대 3회까지 다시 묻는다).
    fingerprintFailures += 1;
    return fingerprintFailures < FINGERPRINT_MAX_ATTEMPTS ? "retry" : "off";
  }
  if (!current) return "off"; // 서버가 지문 없음 → 검증 안 된 목소리를 낼 수 없으니 IDB 미사용
  try {
    const stored = await b.getFingerprint();
    if (stored !== current) {
      await b.clear(); // 음성·모델이 바뀌었다 → 옛 오디오 전부 폐기
      await b.setFingerprint(current);
    }
    return "ok";
  } catch {
    return "off"; // IDB 문제 → 조용히 메모리만
  }
}

/** ArrayBuffer로 보이는가(realm·구현을 가리지 않는 덕 타이핑 — IDB·테스트 페이크 공용). */
function isArrayBufferLike(v: unknown): v is ArrayBuffer {
  return !!v && typeof v === "object" && typeof (v as ArrayBuffer).byteLength === "number" && typeof (v as ArrayBuffer).slice === "function";
}

/** Blob → 바이트. `Blob.arrayBuffer`가 없는 구형 브라우저는 Response로 읽는다. */
function blobToBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

/** 옛 형식 Blob을 상한 안에 읽는다. 거부(죽은 Blob)·매달림·빈 바이트면 null. */
function readLegacyBytes(blob: Blob): Promise<ArrayBuffer | null> {
  return new Promise<ArrayBuffer | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), LEGACY_READ_TIMEOUT_MS);
    let read: Promise<ArrayBuffer>;
    try {
      read = blobToBytes(blob);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    read.then(
      (buf) => {
        clearTimeout(timer);
        resolve(isArrayBufferLike(buf) && buf.byteLength > 0 ? buf : null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** 저장된 형식 → 재생에 쓸 형식. 비어 있으면 mp3(합성 형식), 오디오가 아니라고 적혀 있으면 null(쓰지 않는다). */
function storedAudioType(type: string | null | undefined): string | null {
  if (!type) return TTS_AUDIO_MIME;
  return audioMediaType(type);
}

/**
 * 2차 캐시 조회. 없거나 IDB 불가면 null. 돌려주는 것은 **늘 새로 만든 메모리 Blob**이다(IDB 레코드를 가리키는 Blob을 내주지 않는다).
 * LRU 시각은 오디오 없는 목록 레코드만 고친다(`touch`). 쓸 수 없는 레코드(죽은 옛 Blob·빈 바이트·오디오 아닌 형식)는 지우고 null.
 */
export async function ttsCacheGet(key: string): Promise<Blob | null> {
  const b = await resolveBackend();
  if (!b) return null;
  let rec: TtsKvRecord | null;
  try {
    rec = await b.get(key);
  } catch {
    return null;
  }
  if (!rec) return null;
  const drop = () => void enqueueWrite(() => b.delete(key)).catch(() => {});

  if (rec.kind === "bytes") {
    const type = storedAudioType(rec.type);
    if (!isArrayBufferLike(rec.bytes) || rec.bytes.byteLength === 0 || !type) {
      drop();
      return null;
    }
    const now = Date.now();
    void enqueueWrite(() => b.touch(key, now)).catch(() => {}); // LRU(best-effort) — 오디오 레코드는 건드리지 않는다
    return new Blob([rec.bytes], { type });
  }

  // 옛 형식(v1 Blob) — 바이트를 먼저 손에 쥔다. 이 Blob을 그대로 내주면 뒤따르는 쓰기(이전·축출·다른 탭)에 죽을 수 있다.
  const type = storedAudioType(rec.blob?.type);
  const bytes = type ? await readLegacyBytes(rec.blob) : null;
  if (!bytes || !type) {
    drop(); // 이미 죽었다(앱 재실행 뒤 옛 코드의 touch)·매달림·오디오 아님 → 이 한 건만 재합성
    return null;
  }
  // 새 형식으로 옮겨 적는다(바이트를 쥔 뒤라 옛 Blob이 이 쓰기로 죽어도 상관없다). 다음 조회부터는 바이트 레코드다.
  const entry: TtsKvWrite = { bytes, type, size: bytes.byteLength, atime: Date.now() };
  void enqueueWrite(() => b.put(key, entry)).catch(() => {});
  return new Blob([bytes], { type });
}

/**
 * 2차 캐시 저장(best-effort) + LRU 축출. 지문 조회를 새로 일으키지 않는다(resolveBackend 참고).
 * 받은 Blob은 **바이트로 읽어** 저장한다(Blob을 IDB에 넣지 않는다 — 위 규칙). 오디오 형식이 아니면 저장하지 않는다.
 * 쓰기 줄의 자리는 **부른 순간에** 잡는다 — 바이트 읽기가 늦어도, 그 뒤에 부른 삭제(자가 치유)보다 먼저 끝난다.
 */
export function ttsCachePut(key: string, blob: Blob): Promise<void> {
  return enqueueWrite(async () => {
    const b = await resolveBackend(false);
    if (!b) return;
    const type = storedAudioType(blob.type);
    if (!type) return;
    const bytes = await blobToBytes(blob);
    if (!isArrayBufferLike(bytes) || bytes.byteLength === 0) return;
    await b.put(key, { bytes, type, size: bytes.byteLength, atime: Date.now() });
    await evictIfNeeded(b);
  }).catch(() => {
    /* noop — 캐시는 최적화일 뿐 */
  });
}

/**
 * 2차 캐시에서 한 키를 뺀다(best-effort). speech.ts의 **자가 치유**가 부른다 — 재생 단계에서 미디어 소스 오류가 난 오디오를
 * 두 캐시에서 빼고(캐시에서 왔으면) 새로 받는다(§16-5). 지문 조회를 새로 일으키지 않는다. 자리는 부른 순간에 잡는다(위와 같다).
 */
export function ttsCacheDelete(key: string): Promise<void> {
  return enqueueWrite(async () => {
    const b = await resolveBackend(false);
    if (!b) return;
    await b.delete(key);
  }).catch(() => {
    /* noop */
  });
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
//
// v2(2026-09-27): 오디오 바이트를 별도 store(`bytes`)로 옮겼다. `audio` store는 이제 **목록**(key·size·atime·type)이라
// LRU 시각을 고쳐도 오디오를 다시 쓰지 않고, 축출 목록(getAll)이 오디오 바이트를 메모리에 올리지 않는다.
// v1 레코드(`{key, blob, size, atime}`)는 `audio` store에 그대로 남아 있다가 조회 때 새 형식으로 옮겨진다(ttsCacheGet).

const DB_NAME = "eunwoo-tts";
const DB_VERSION = 2;
/** 목록: 새 형식 `{key, size, atime, type}` / 옛 형식(v1) `{key, blob, size, atime}` — 옛 형식은 새로 쓰지 않는다. */
const STORE_AUDIO = "audio";
/** 오디오 바이트: `{key, bytes: ArrayBuffer}` — 새 합성 저장(같은 키 교체)·삭제만 한다. LRU는 여기를 건드리지 않는다. */
const STORE_BYTES = "bytes";
const STORE_META = "meta";
const META_FP_KEY = "fingerprint";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO, { keyPath: "key" });
      if (!db.objectStoreNames.contains(STORE_BYTES)) db.createObjectStore(STORE_BYTES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // 다음 버전 올림을 막지 않는다(연산마다 닫지만 방어)
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface IdbListRecord {
  key: string;
  size: number;
  atime: number;
  type?: string;
  /** v1 레코드에만 있다 */
  blob?: Blob;
}

/** IndexedDB 어댑터. 목록(audio store)·바이트(bytes store)·지문(meta store). */
function createIdbBackend(): TtsKvBackend {
  return {
    async get(key) {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE_AUDIO, STORE_BYTES], "readonly");
        const [rec, data] = await Promise.all([
          reqToPromise(tx.objectStore(STORE_AUDIO).get(key)) as Promise<IdbListRecord | undefined>,
          reqToPromise(tx.objectStore(STORE_BYTES).get(key)) as Promise<{ key: string; bytes?: ArrayBuffer } | undefined>,
        ]);
        if (!rec) return null;
        if (rec.blob) return { kind: "legacy", blob: rec.blob, size: rec.size, atime: rec.atime };
        return { kind: "bytes", bytes: data?.bytes ?? null, type: rec.type ?? "", size: rec.size, atime: rec.atime };
      } finally {
        db.close();
      }
    },
    async put(key, entry) {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE_AUDIO, STORE_BYTES], "readwrite");
        tx.objectStore(STORE_BYTES).put({ key, bytes: entry.bytes });
        // 목록 레코드는 필드를 골라 새로 만든다 — 옛 형식의 blob이 섞여 들어가지 않게.
        tx.objectStore(STORE_AUDIO).put({ key, size: entry.size, atime: entry.atime, type: entry.type });
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async touch(key, atime) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_AUDIO, "readwrite");
        const st = tx.objectStore(STORE_AUDIO);
        const r = st.get(key);
        r.onsuccess = () => {
          const rec = r.result as IdbListRecord | undefined;
          // 옛 형식(Blob이 든 레코드)은 절대 다시 쓰지 않는다 — 그게 이번 결함의 방아쇠였다.
          if (!rec || rec.blob) return;
          st.put({ key, size: rec.size, atime, type: rec.type ?? "" });
        };
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE_AUDIO, STORE_BYTES], "readwrite");
        tx.objectStore(STORE_AUDIO).delete(key);
        tx.objectStore(STORE_BYTES).delete(key);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openDb();
      try {
        const recs = await reqToPromise(db.transaction(STORE_AUDIO, "readonly").objectStore(STORE_AUDIO).getAll());
        return (recs as IdbListRecord[]).map((r) => ({ key: r.key, size: r.size, atime: r.atime }));
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE_AUDIO, STORE_BYTES], "readwrite");
        tx.objectStore(STORE_AUDIO).clear();
        tx.objectStore(STORE_BYTES).clear();
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

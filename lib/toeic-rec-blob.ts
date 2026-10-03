/**
 * lib/toeic-rec-blob.ts — 내 녹음 **보관소** 두 벌(GCS · 로컬 파일), 서버 전용 (docs/harness/toeic.md §13-1·§13-7)
 *
 * - **백엔드는 스토어와 하나다** — `resolveStoreBackend()`(lib/store-backend — lib/store가 다시 내보내는 같은 함수)가 `firestore`이면
 *   GCS 비공개 버킷, `file`이면 로컬 디렉터리. 따로 판정하면 "문서는 파일, 녹음은 프로덕션 버킷"이 된다.
 *   - GCS: `firebase-admin/storage`(Firestore와 같은 앱 — ADC). 버킷 env `TOEIC_REC_BUCKET`(빈 값·공백이면 기본값).
 *   - 파일: env `TOEIC_REC_DIR`(빈 값이면 `data/recordings` — git·배포 업로드 밖). eval은 스크래치 디렉터리로 돌린다.
 * - 객체 키는 lib/toeic-rec-rules `toeicRecObjectKey`가 만든 것만 받는다(`TOEIC_REC_OBJECT_KEY_RE`) — 파일 백엔드에서 경로 밖으로
 *   나가는 키(`..`·`/`)를 막는다. 한 녹음 = 한 객체, 객체는 바꾸지 않는다(같은 키 = 같은 바이트라 다시 써도 멱등).
 * - **지우기**: 응시 접두사(`deleteAttemptRecordings` — 모의고사 삭제 연쇄)와, 2026-10-03(§14) 녹음 관리의 **자리 접두사**
 *   (`deleteRecordingPrefixes` — 답변 한 문항 `attempts/{id}/{q}/`·고칠 문장 하나 `attempts/{id}/fixes/{q}/{i}/`·응시 통째 `attempts/{id}/`)와
 *   고칠 문장 다시 녹음이 바꿔 낀 **옛 객체 하나**(`deleteRecordingObject` — 메타 커밋 **뒤**). 답변 녹음 업로드 경로에는 여전히 지우는 동작이
 *   없다(대체된 옛 답변 객체는 그 문항·응시·모의고사를 지울 때 접두사째 사라진다). GCS 지우기는 모두 스스로 prod-guard
 *   (`deleteToeicRecordings`)를 지난다 — 개발 환경에서 프로덕션 버킷을 지우면 던진다. 파일 백엔드는 가드가 없다(스토어 규칙과 같다).
 * - 개발 환경인데 GCS(=프로덕션 버킷)를 잡으면 `getStore()`와 같은 경고를 찍는다. 쓰기는 막지 않는다(스토어와 같다).
 *
 * 로그에는 키·바이트 수만 남긴다(바이트 내용·파일 이름은 남기지 않는다).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { assertDestructiveAllowed } from "./prod-guard";
import { resolveStoreBackend } from "./store-backend";
import { TOEIC_REC_PREFIX_RE, isToeicRecObjectKey, toeicRecObjectPrefix } from "./toeic-rec-rules";

/** 버킷 기본 이름(§13-1) — env `TOEIC_REC_BUCKET`이 비면 이것 */
export const TOEIC_REC_BUCKET_DEFAULT = "eunwoo-bookcard-toeic-rec";

export interface ToeicRecBlobStore {
  readonly backend: "gcs" | "file";
  /** 객체 쓰기(같은 키 = 같은 바이트 — 다시 써도 멱등) */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** 객체 읽기 — 없으면 null */
  get(key: string): Promise<Uint8Array | null>;
  /** 응시 하나의 녹음 전부(대체된 옛 객체까지) 지우기 — 지운 수. 실패하면 던진다 */
  deleteAttempt(attemptId: string): Promise<number>;
  /** 자리 접두사(TOEIC_REC_PREFIX_RE) 아래 객체 전부 지우기(§14-4) — 지운 수. 이미 없으면 0(멱등). 실패하면 던진다 */
  deletePrefix(prefix: string): Promise<number>;
  /** 객체 하나 지우기(§14-5 — 고칠 문장 다시 녹음이 바꿔 낀 옛 객체) — 지웠으면 true, 이미 없으면 false. 실패하면 던진다 */
  deleteKey(key: string): Promise<boolean>;
}

function assertKey(key: string): void {
  if (!isToeicRecObjectKey(key)) throw new Error("toeic-rec-blob: 객체 키 모양이 아니에요");
}

function assertPrefix(prefix: string): void {
  if (!TOEIC_REC_PREFIX_RE.test(prefix)) throw new Error("toeic-rec-blob: 지우기 접두사 모양이 아니에요");
}

// ---------------------------------------------------------------------------
// 파일 백엔드
// ---------------------------------------------------------------------------

export function toeicRecFileDir(): string {
  const env = process.env.TOEIC_REC_DIR?.trim();
  return env ? path.resolve(env) : path.join(process.cwd(), "data", "recordings");
}

/** 키 → 디렉터리 안 경로. 결과가 디렉터리 밖이면 던진다(키 검사 뒤 두 번째 방어) */
function filePathOf(dir: string, key: string): string {
  const p = path.resolve(dir, ...key.split("/"));
  if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error("toeic-rec-blob: 경로가 보관 디렉터리 밖이에요");
  return p;
}

class FileRecBlobStore implements ToeicRecBlobStore {
  readonly backend = "file" as const;
  constructor(private readonly dir: string) {}

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    assertKey(key);
    const target = filePathOf(this.dir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // 원자적 쓰기 — 임시 파일 뒤 rename(읽는 쪽이 반쯤 쓴 파일을 보지 않게)
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      return new Uint8Array(await fs.readFile(filePathOf(this.dir, key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async deleteAttempt(attemptId: string): Promise<number> {
    return this.deletePrefix(toeicRecObjectPrefix(attemptId)); // 모양 검사(던진다)
  }

  async deleteKey(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await fs.unlink(filePathOf(this.dir, key));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertPrefix(prefix);
    const target = filePathOf(this.dir, prefix.replace(/\/$/, ""));
    let count = 0;
    const walk = async (d: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) await walk(path.join(d, ent.name));
        else count += 1;
      }
    };
    await walk(target);
    await fs.rm(target, { recursive: true, force: true });
    return count;
  }
}

// ---------------------------------------------------------------------------
// GCS 백엔드
// ---------------------------------------------------------------------------

export function toeicRecBucketName(): string {
  return process.env.TOEIC_REC_BUCKET?.trim() || TOEIC_REC_BUCKET_DEFAULT;
}

class GcsRecBlobStore implements ToeicRecBlobStore {
  readonly backend = "gcs" as const;
  constructor(private readonly bucketName: string) {}

  private bucket() {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    return getStorage(app).bucket(this.bucketName);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertKey(key);
    await this.bucket()
      .file(key)
      .save(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        resumable: false,
        contentType,
        metadata: { cacheControl: "private, no-store" },
      });
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      const [buf] = await this.bucket().file(key).download();
      return new Uint8Array(buf);
    } catch (e) {
      if ((e as { code?: unknown }).code === 404) return null;
      throw e;
    }
  }

  async deleteAttempt(attemptId: string): Promise<number> {
    // 개발 환경에서 프로덕션 버킷의 녹음을 지우려 하면 던진다 — deleteToeicMock이 먼저 막지만 다른 자리에서 불려도 막히게 한 겹 더
    assertDestructiveAllowed("deleteToeicRecordings");
    const prefix = toeicRecObjectPrefix(attemptId);
    const [files] = await this.bucket().getFiles({ prefix });
    // 하나라도 실패하면 던진다(호출자가 문서를 지우지 않는다). 이미 없는 객체(404)는 지운 것으로 본다 — 다시 눌러도 멱등.
    await Promise.all(
      files.map((f) =>
        f.delete().catch((e: unknown) => {
          if ((e as { code?: unknown }).code === 404) return;
          throw e;
        }),
      ),
    );
    return files.length;
  }

  async deletePrefix(prefix: string): Promise<number> {
    // 녹음 관리(§14-4) — 같은 가드를 먼저. 하나라도 실패하면 던진다(라우트가 메타를 지우지 않는다). 이미 없는 객체(404)는 지운 것으로 본다
    assertDestructiveAllowed("deleteToeicRecordings");
    assertPrefix(prefix);
    const [files] = await this.bucket().getFiles({ prefix });
    await Promise.all(
      files.map((f) =>
        f.delete().catch((e: unknown) => {
          if ((e as { code?: unknown }).code === 404) return;
          throw e;
        }),
      ),
    );
    return files.length;
  }

  async deleteKey(key: string): Promise<boolean> {
    // 고칠 문장 다시 녹음이 바꿔 낀 옛 객체(§14-5) — 같은 가드를 먼저
    assertDestructiveAllowed("deleteToeicRecordings");
    assertKey(key);
    try {
      await this.bucket().file(key).delete();
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === 404) return false;
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// 선택 — 스토어와 같은 판정
// ---------------------------------------------------------------------------

declare global {
  // dev(HMR) 재평가로 인스턴스가 늘지 않게 + eval 주입(실패 주입으로 삭제 순서를 잠근다)
  var __toeicRecBlobStore: ToeicRecBlobStore | undefined;
}

export function getToeicRecBlobStore(): ToeicRecBlobStore {
  if (!globalThis.__toeicRecBlobStore) {
    const backend = resolveStoreBackend();
    globalThis.__toeicRecBlobStore = backend === "firestore" ? new GcsRecBlobStore(toeicRecBucketName()) : new FileRecBlobStore(toeicRecFileDir());
    if (backend === "firestore" && process.env.NODE_ENV !== "production") {
      console.warn(
        "[toeic-rec] ⚠️  개발 환경인데 **프로덕션 녹음 버킷**을 잡았어요(스토어가 firestore).\n" +
          "         여기서 올린 녹음은 가족 버킷에 그대로 남습니다. 지우기는 prod-guard가 막습니다.\n" +
          "         로컬 테스트라면 STORE_BACKEND=file 로 돌리세요.",
      );
    }
  }
  return globalThis.__toeicRecBlobStore;
}

/** 응시 하나의 녹음 지우기(§13-7) — 스토어의 deleteToeicMock이 문서보다 **먼저** 부른다. 실패하면 던진다. */
export async function deleteAttemptRecordings(attemptId: string): Promise<number> {
  return getToeicRecBlobStore().deleteAttempt(attemptId);
}

/** 녹음 관리(§14-4) — 자리 접두사들을 **차례로** 지운다. 하나라도 실패하면 던진다(호출자가 메타를 지우지 않는다 — 서버 먼저 → 메타 정리). */
export async function deleteRecordingPrefixes(prefixes: readonly string[]): Promise<number> {
  const blob = getToeicRecBlobStore();
  let n = 0;
  for (const p of prefixes) n += await blob.deletePrefix(p);
  return n;
}

/** 객체 하나 지우기(§14-5 — 고칠 문장 옛 객체·자리를 얻지 못한 방금 쓴 객체). 실패하면 던진다 — 호출자는 best-effort로 받는다. */
export async function deleteRecordingObject(key: string): Promise<boolean> {
  return getToeicRecBlobStore().deleteKey(key);
}

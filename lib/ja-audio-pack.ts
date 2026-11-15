/**
 * lib/ja-audio-pack.ts — 원음 묶음 `jpack/1` 파서(설계 §2-2). 순수 검증 + Blob slice를 받는 얇은 읽기 함수.
 *
 * ```
 * offset 0  : ASCII "JPAK1\n"            (6 bytes)
 * offset 6  : uint32 LE  indexLength
 * offset 10 : UTF-8 JSON index  [{ "key", "type", "offset"(파일 처음 기준), "length" }]
 * 이후      : blob들
 * ```
 *
 * - 순수 부분(`parseJaPackHeader`·`parseJaPackIndex`·`jaPackRanges`)은 바이트·문자열만 받는다 — eval이 지어낸 바이트로 잠근다.
 * - `readJaPackIndex(file)`은 파일 전체를 메모리에 올리지 않는다 — 머리 10바이트와 색인만 `slice`로 읽는다. 조각은 `jaPackSlice`로 하나씩.
 * - 손상 파일은 던지지 않고 `{ ok:false, error, messageKo }`로 돌려준다(화면이 안내만 한다).
 *
 * ⚠️ 런타임 import 0 — 브라우저·eval 공용(서버는 쓰지 않는다 — 원음은 서버로 보내지 않는다).
 */

export const JA_PACK_MAGIC = "JPAK1\n";
export const JA_PACK_HEADER_BYTES = 10;
/** 색인 상한 — 트랙 수천 개도 1MiB면 넉넉하다 */
export const JA_PACK_INDEX_MAX_BYTES = 1024 * 1024;
export const JA_PACK_MAX_ENTRIES = 2000;
/** 한 트랙 상한(48kbps 모노 10분 ≈ 3.6MB) */
export const JA_PACK_TRACK_MAX_BYTES = 30 * 1024 * 1024;
export const JA_PACK_TYPES = ["audio/mp4", "audio/mpeg", "audio/aac", "audio/x-m4a"] as const;
export const JA_PACK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface JaPackEntry {
  key: string;
  type: (typeof JA_PACK_TYPES)[number];
  offset: number;
  length: number;
}

export type JaPackError = "too_small" | "bad_magic" | "bad_index_length" | "bad_index_json" | "bad_entry" | "duplicate_key" | "out_of_range" | "overlap" | "empty";
export type JaPackResult<T> = { ok: true; value: T } | { ok: false; error: JaPackError; messageKo: string };

const fail = <T>(error: JaPackError, messageKo: string): JaPackResult<T> => ({ ok: false, error, messageKo });

/** 머리 10바이트 → 색인 길이. fileSize는 파일 전체 바이트 */
export function parseJaPackHeader(head: Uint8Array, fileSize: number): JaPackResult<{ indexLength: number }> {
  if (head.length < JA_PACK_HEADER_BYTES || fileSize < JA_PACK_HEADER_BYTES) return fail("too_small", "원음 묶음 파일이 너무 작아요.");
  for (let i = 0; i < JA_PACK_MAGIC.length; i++) {
    if (head[i] !== JA_PACK_MAGIC.charCodeAt(i)) return fail("bad_magic", "원음 묶음(jpack) 파일이 아니에요.");
  }
  const indexLength = (head[6] | (head[7] << 8) | (head[8] << 16)) + head[9] * 0x1000000;
  if (indexLength < 2 || indexLength > JA_PACK_INDEX_MAX_BYTES || JA_PACK_HEADER_BYTES + indexLength > fileSize) {
    return fail("bad_index_length", "원음 묶음의 색인 길이가 올바르지 않아요.");
  }
  return { ok: true, value: { indexLength } };
}

/** 색인 JSON 문자열 → 검증된 항목(offset 오름차순). 조각은 색인 뒤에 있어야 하고 서로 겹치지 않는다 */
export function parseJaPackIndex(indexText: string, indexLength: number, fileSize: number): JaPackResult<JaPackEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(indexText);
  } catch {
    return fail("bad_index_json", "원음 묶음의 색인을 읽지 못했어요.");
  }
  if (!Array.isArray(raw)) return fail("bad_index_json", "원음 묶음의 색인 모양이 올바르지 않아요.");
  if (raw.length === 0) return fail("empty", "원음 묶음에 트랙이 없어요.");
  if (raw.length > JA_PACK_MAX_ENTRIES) return fail("bad_entry", "원음 묶음의 트랙이 너무 많아요.");
  const dataStart = JA_PACK_HEADER_BYTES + indexLength;
  const out: JaPackEntry[] = [];
  const keys = new Set<string>();
  for (const e of raw) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return fail("bad_entry", "원음 묶음의 색인 항목이 올바르지 않아요.");
    const { key, type, offset, length } = e as Record<string, unknown>;
    if (typeof key !== "string" || !JA_PACK_KEY_RE.test(key)) return fail("bad_entry", "트랙 이름이 올바르지 않아요.");
    if (typeof type !== "string" || !(JA_PACK_TYPES as readonly string[]).includes(type)) return fail("bad_entry", `받지 않는 형식이에요: ${key}`);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (length as number) <= 0 || (length as number) > JA_PACK_TRACK_MAX_BYTES) {
      return fail("bad_entry", `트랙 위치가 올바르지 않아요: ${key}`);
    }
    if (keys.has(key)) return fail("duplicate_key", `같은 트랙이 두 번 있어요: ${key}`);
    keys.add(key);
    const o = offset as number;
    const n = length as number;
    if (o < dataStart || o + n > fileSize) return fail("out_of_range", `트랙이 파일 밖을 가리켜요: ${key}`);
    out.push({ key, type: type as JaPackEntry["type"], offset: o, length: n });
  }
  out.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < out.length; i++) {
    if (out[i].offset < out[i - 1].offset + out[i - 1].length) return fail("overlap", `트랙끼리 겹쳐요: ${out[i - 1].key}·${out[i].key}`);
  }
  return { ok: true, value: out };
}

/** 항목 → slice 범위 [start, end) */
export function jaPackRanges(entries: readonly JaPackEntry[]): { key: string; start: number; end: number; type: string }[] {
  return entries.map((e) => ({ key: e.key, start: e.offset, end: e.offset + e.length, type: e.type }));
}

/** 이 정도만 있으면 되는 Blob 모양(File·Blob 둘 다) */
export interface JaPackBlobLike {
  size: number;
  slice(start?: number, end?: number, contentType?: string): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** 파일 → 색인(머리·색인만 읽는다) */
export async function readJaPackIndex(file: JaPackBlobLike): Promise<JaPackResult<JaPackEntry[]>> {
  const head = new Uint8Array(await file.slice(0, JA_PACK_HEADER_BYTES).arrayBuffer());
  const h = parseJaPackHeader(head, file.size);
  if (!h.ok) return h;
  const bytes = new Uint8Array(await file.slice(JA_PACK_HEADER_BYTES, JA_PACK_HEADER_BYTES + h.value.indexLength).arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("bad_index_json", "원음 묶음의 색인 글자가 깨졌어요.");
  }
  return parseJaPackIndex(text, h.value.indexLength, file.size);
}

/** 한 트랙의 바이트(그 조각만 읽는다) */
export async function jaPackSlice(file: JaPackBlobLike, e: JaPackEntry): Promise<ArrayBuffer> {
  return file.slice(e.offset, e.offset + e.length, e.type).arrayBuffer();
}

/** 묶음 만들기(eval·개발 도구용 — 지어낸 바이트로 파서를 잠근다) */
export function buildJaPack(tracks: readonly { key: string; type: JaPackEntry["type"]; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  // 색인 길이가 offset 숫자 자릿수에 따라 바뀌므로 두 번 맞춘다
  let indexLength = 0;
  let index: JaPackEntry[] = [];
  for (let pass = 0; pass < 3; pass++) {
    let off = JA_PACK_HEADER_BYTES + indexLength;
    index = tracks.map((t) => {
      const e = { key: t.key, type: t.type, offset: off, length: t.bytes.length };
      off += t.bytes.length;
      return e;
    });
    const len = new TextEncoder().encode(JSON.stringify(index)).length;
    if (len === indexLength) break;
    indexLength = len;
  }
  const idx = new TextEncoder().encode(JSON.stringify(index));
  const total = JA_PACK_HEADER_BYTES + idx.length + tracks.reduce((n, t) => n + t.bytes.length, 0);
  const out = new Uint8Array(total);
  for (let i = 0; i < JA_PACK_MAGIC.length; i++) out[i] = JA_PACK_MAGIC.charCodeAt(i);
  const L = idx.length;
  out[6] = L & 0xff;
  out[7] = (L >>> 8) & 0xff;
  out[8] = (L >>> 16) & 0xff;
  out[9] = (L >>> 24) & 0xff;
  out.set(idx, JA_PACK_HEADER_BYTES);
  let p = JA_PACK_HEADER_BYTES + idx.length;
  for (const t of tracks) {
    out.set(t.bytes, p);
    p += t.bytes.length;
  }
  return out;
}

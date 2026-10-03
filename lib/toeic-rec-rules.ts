/**
 * lib/toeic-rec-rules.ts — 내 녹음 **서버 보관** 판정 순수 함수 (docs/harness/toeic.md §13-1~§13-6)
 *
 * 라우트(`PUT`/`GET /api/toeic/attempts/[id]/recordings/[q]`)·스토어 두 백엔드(파일 mutate · Firestore runTransaction)·녹음 보관소
 * (lib/toeic-rec-blob)·기기 대기열(lib/toeic-rec-upload · lib/toeic-rec-store)·결과 화면이 **같은 함수**를 본다. 판정이 여러 벌이면
 * "라우트는 받았는데 스토어가 거부" 같은 어긋남이 난다(lib/toeic-attempt-rules 관용구).
 *
 * - 객체 키 `attempts/{attemptId}/{q}/{recordedAtMs}` — 확장자 없음, 녹음마다 다른 객체(늦게 온 옛 업로드가 새 녹음을 덮지 않게).
 * - 바이트 판정 `sniffToeicAudioType` — 클라이언트가 붙인 타입을 믿고 같은 출처에서 내려주지 않는다(오디오라고 올린 HTML 차단).
 * - 교체 판정 `decideToeicRecordingUpload` — 잠그는 기준은 열림/닫힘이 아니라 "그 문항이 전사됐는가" 하나다.
 * - 메타는 응시 기록의 `recordings`(answers **밖**) — answers에 넣으면 "닫힌 응시" 판정(answers.length > 0)이 뒤집힌다.
 * - 기기 대기열 판정 `toeicRecUploadStateOf`·`nextToeicRecUploadAction`·`toeicRecPinnedAttempts`.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-attempt-rules·lib/toeic-attempt-contract·lib/toeic-mock)뿐.
 *    firebase-admin·lib/store·lib/ai 값 import 금지(eval이 소스로 잠근다). 모듈 최상위에서 브라우저 전역을 읽지 않는다.
 */

import { TOEIC_QUESTION_COUNT } from "./toeic-mock";
import { maxToeicRecordingMs } from "./toeic-attempt-rules";
import { TOEIC_REC_STORE_TYPES, TOEIC_SCORE_AUDIO_MAX_BYTES, toeicAudioBaseType, toeicAudioTypeFromName } from "./toeic-attempt-contract";

// ===========================================================================
// 레코드 모양(§13-5)
// ===========================================================================

/** 응시 기록에 붙는 녹음 메타 한 줄 — q마다 하나("지금 녹음") */
export interface ToeicStoredRecording {
  /** 1..11 — attempt.questions 안 */
  q: number;
  /** §13-1 "attempts/{attemptId}/{q}/{recordedAtMs}" */
  objectKey: string;
  /** 바이트로 판정한 대표 타입(audio/mp4 | audio/webm | audio/ogg | audio/wav) */
  mimeType: string;
  /** 바이트, 1..TOEIC_SCORE_AUDIO_MAX_BYTES */
  size: number;
  /** 소문자 hex 64자(서버 계산) */
  sha256: string;
  /** 기기가 잰 녹음 길이(1..maxToeicRecordingMs(q)) */
  durationMs: number;
  /** 기기 녹음 끝 시각(ISO — 같은 문항 녹음끼리 버전 비교에만 쓴다) */
  recordedAt: string;
  /** 서버가 받은 시각(ISO) */
  uploadedAt: string;
}

/** 녹음 보관 대표 타입 */
export type ToeicAudioFamily = "audio/mp4" | "audio/webm" | "audio/ogg" | "audio/wav";

// ===========================================================================
// 객체 키(§13-1)
// ===========================================================================

/** 응시 id 모양 — 스토어가 만든 UUID·Firestore 자동 id가 통과한다. `.`·`/`가 없어 파일 경로 밖으로 나가지 못한다. */
export const TOEIC_REC_ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isToeicRecAttemptId(id: unknown): id is string {
  return typeof id === "string" && TOEIC_REC_ATTEMPT_ID_RE.test(id);
}

export function isToeicRecQuestion(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= TOEIC_QUESTION_COUNT;
}

/** 응시 하나의 녹음 접두사 `attempts/{attemptId}/` — 모양이 어긋나면 던진다(지우기 범위가 넓어지지 않게) */
export function toeicRecObjectPrefix(attemptId: string): string {
  if (!isToeicRecAttemptId(attemptId)) throw new Error("toeicRecObjectPrefix: 응시 id 모양이 아니에요");
  return `attempts/${attemptId}/`;
}

/** 객체 키(§13-1). 어긋나면 키를 만들지 않고 던진다 — 라우트는 그 앞에서 400. 결과에 점이 없다. */
export function toeicRecObjectKey(attemptId: string, q: number, recordedAtMs: number): string {
  if (!isToeicRecAttemptId(attemptId)) throw new Error("toeicRecObjectKey: 응시 id 모양이 아니에요");
  if (!isToeicRecQuestion(q)) throw new Error("toeicRecObjectKey: 문항 번호는 1~11 정수예요");
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs <= 0) throw new Error("toeicRecObjectKey: 녹음 시각은 양의 정수예요");
  return `${toeicRecObjectPrefix(attemptId)}${q}/${recordedAtMs}`;
}

/** 객체 키 모양인가(파일 백엔드 경로 방어 — 키를 만든 함수와 같은 규칙) */
export const TOEIC_REC_OBJECT_KEY_RE = /^attempts\/[A-Za-z0-9_-]{1,64}\/(?:[1-9]|1[01])\/[1-9]\d{0,15}$/;

// ===========================================================================
// 형식 · 바이트 판정(§13-2)
// ===========================================================================

/** 선언 타입(파라미터 무시) → 보관 계열. 받지 않는 형식이면 null. */
export function toeicRecFamilyOfType(type: string | null | undefined): ToeicAudioFamily | null {
  const base = toeicAudioBaseType(type);
  return Object.prototype.hasOwnProperty.call(TOEIC_REC_STORE_TYPES, base) ? TOEIC_REC_STORE_TYPES[base] : null;
}

function ascii(bytes: Uint8Array, from: number, len: number): string {
  let s = "";
  for (let i = from; i < from + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * 앞 12바이트로 형식 계열을 가른다 — mp4(4~8바이트 `ftyp`) · webm(`1A 45 DF A3` EBML) · ogg(`OggS`) · wav(`RIFF`…`WAVE`).
 * 넷 다 아니면 null(HTML·텍스트·빈 바이트).
 */
export function sniffToeicAudioType(bytes: Uint8Array): ToeicAudioFamily | null {
  if (bytes.length >= 8 && ascii(bytes, 4, 4) === "ftyp") return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  return null;
}

// ===========================================================================
// 업로드 계약 검사(§13-4 — 400·413 순서). 라우트가 multipart를 풀어 넘긴다.
// ===========================================================================

export interface ToeicRecUploadInput {
  /** 경로의 q 조각 */
  q: string;
  /** multipart `durationMs`(문자열) */
  durationMs: unknown;
  /** multipart `recordedAt`(문자열 epoch ms) */
  recordedAt: unknown;
  /** 파일 Blob 타입(비면 파일 이름 확장자) */
  declaredType: string;
  fileName: string;
  size: number;
  /** 파일 앞 바이트(12바이트 이상이면 충분) */
  head: Uint8Array;
}

export type ToeicRecUploadCheck =
  | { ok: true; q: number; durationMs: number; recordedAtMs: number; mimeType: ToeicAudioFamily }
  | { ok: false; status: 400 | 413; error: "invalid_input" | "audio_too_large"; messageKo: string };

const INT_RE = /^\d{1,16}$/;

/** 경로 q 조각 → 1..11 정수, 어긋나면 null(`^\d{1,2}$`) */
export function parseToeicRecQuestion(raw: string): number | null {
  const t = (raw ?? "").trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const q = Number(t);
  return isToeicRecQuestion(q) ? q : null;
}

function intField(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!INT_RE.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** 업로드 형식 검사 — 400(형식) · 413(크기). 응시·문항 존재(404)는 라우트가 스토어로 본다. */
export function checkToeicRecordingUpload(input: ToeicRecUploadInput): ToeicRecUploadCheck {
  const bad = (messageKo: string): ToeicRecUploadCheck => ({ ok: false, status: 400, error: "invalid_input", messageKo });
  const q = parseToeicRecQuestion(input.q);
  if (q === null) return bad(`문항 번호는 1~${TOEIC_QUESTION_COUNT}이어야 해요.`);
  const declared = toeicAudioBaseType(input.declaredType) || toeicAudioTypeFromName(input.fileName);
  const family = toeicRecFamilyOfType(declared);
  if (family === null) return bad("받지 않는 녹음 형식이에요(mp4·m4a·webm·ogg·wav만).");
  if (input.size <= 0) return bad("녹음 파일이 비어 있어요.");
  if (input.size > TOEIC_SCORE_AUDIO_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: "audio_too_large",
      messageKo: `녹음 파일이 너무 커요(최대 ${Math.round(TOEIC_SCORE_AUDIO_MAX_BYTES / 1024 / 1024)}MB).`,
    };
  }
  const sniffed = sniffToeicAudioType(input.head);
  if (sniffed === null || sniffed !== family) return bad("녹음 파일의 내용이 선언한 형식과 달라요.");
  const durationMs = intField(input.durationMs);
  if (durationMs === null || durationMs < 1 || durationMs > maxToeicRecordingMs(q)) return bad("녹음 길이(durationMs)가 올바르지 않아요.");
  const recordedAtMs = intField(input.recordedAt);
  if (recordedAtMs === null || recordedAtMs <= 0) return bad("녹음 시각(recordedAt)이 올바르지 않아요.");
  return { ok: true, q, durationMs, recordedAtMs, mimeType: sniffed };
}

// ===========================================================================
// 교체 판정(§13-4 표)
// ===========================================================================

export type ToeicRecUploadDecision = "store" | "reused" | "superseded" | "locked" | "question_not_found";

export interface ToeicRecAttemptLike {
  questions: readonly number[];
  answers: readonly { q: number; transcript: string | null }[];
  recordings: readonly ToeicStoredRecording[];
}

function isoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 한 문항 녹음 업로드 판정 — 지금 그 문항 메타와 그 문항 답을 본다. 열린/닫힌 응시는 판정에 넣지 않는다(다시 녹음 업로드가 끝내기보다
 * 늦게 와도 받아야 한다). `recorded:false` 문항의 녹음도 받는다(목소리를 잃지 않는 쪽). 원자 단위 **안에서도** 같은 함수로 다시 판정한다.
 */
export function decideToeicRecordingUpload(
  attempt: ToeicRecAttemptLike,
  q: number,
  incoming: { sha256: string; recordedAtMs: number },
): ToeicRecUploadDecision {
  if (!attempt.questions.includes(q)) return "question_not_found";
  const current = attempt.recordings.find((r) => r.q === q);
  if (!current) return "store";
  if (current.sha256 === incoming.sha256) return "reused";
  if (incoming.recordedAtMs <= isoMs(current.recordedAt)) return "superseded";
  const answer = attempt.answers.find((a) => a.q === q);
  if (answer && answer.transcript !== null) return "locked";
  return "store";
}

/** 그 문항 메타를 바꿔 끼운 recordings(q 오름차순, q마다 하나) — 다른 필드(answers·finishedAt)는 건드리지 않는다 */
export function applyToeicAttemptRecording<T extends { recordings: readonly ToeicStoredRecording[] }>(attempt: T, recording: ToeicStoredRecording): T {
  const recordings = [...attempt.recordings.filter((r) => r.q !== recording.q), recording].sort((a, b) => a.q - b.q);
  return { ...attempt, recordings };
}

/** "녹음 서버 보관" 판정은 메타가 있는가 하나다(§13-5) — 화면 문구·채점 자격·비교 버튼이 모두 이것을 쓴다 */
export function toeicStoredRecordingOf(attempt: { recordings: readonly ToeicStoredRecording[] }, q: number): ToeicStoredRecording | null {
  return attempt.recordings.find((r) => r.q === q) ?? null;
}

// ===========================================================================
// 정규화(§13-5) — 저장 레코드 방어. 던지지 않는다.
// ===========================================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 배열이 아니면 [], 항목 모양이 깨진 것은 그 항목만 버린다, 같은 q가 둘이면 recordedAt이 늦은 것 하나. q 오름차순. */
export function normalizeToeicStoredRecordings(v: unknown): ToeicStoredRecording[] {
  if (!Array.isArray(v)) return [];
  const byQ = new Map<number, ToeicStoredRecording>();
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const { q, objectKey, mimeType, size, sha256, durationMs, recordedAt, uploadedAt } = raw;
    if (!isToeicRecQuestion(q)) continue;
    if (typeof objectKey !== "string" || objectKey === "" || typeof mimeType !== "string" || typeof sha256 !== "string") continue;
    if (typeof recordedAt !== "string" || typeof uploadedAt !== "string") continue;
    if (typeof size !== "number" || !Number.isFinite(size) || typeof durationMs !== "number" || !Number.isFinite(durationMs)) continue;
    const rec: ToeicStoredRecording = { q, objectKey, mimeType, size, sha256, durationMs, recordedAt, uploadedAt };
    const prev = byQ.get(q);
    if (!prev || isoMs(rec.recordedAt) > isoMs(prev.recordedAt)) byQ.set(q, rec);
  }
  return [...byQ.values()].sort((a, b) => a.q - b.q);
}

// ===========================================================================
// 기기 대기열(§13-3)
// ===========================================================================

export type ToeicRecUploadState = "pending" | "done" | "gone";

/** 기기 메타의 업로드 상태 — 필드가 없는 옛 메타는 "pending"(§13-6 이행) */
export function toeicRecUploadStateOf(meta: { upload?: unknown }): ToeicRecUploadState {
  return meta.upload === "done" || meta.upload === "gone" ? meta.upload : "pending";
}

export type ToeicRecUploadAction = "done" | "gone" | "retry";

/**
 * `PUT` 결과 → 대기열 동작. 200(ok) → done · 400·404·409·413 → gone · 401·408·429·5xx·네트워크 예외·JSON 아닌 응답 → retry.
 * 그 밖의 4xx는 다시 보내도 같다 → gone.
 */
export function nextToeicRecUploadAction(result: { kind: "network" } | { kind: "response"; status: number; body: unknown }): ToeicRecUploadAction {
  if (result.kind === "network") return "retry";
  const { status, body } = result;
  const okBody = isObj(body) && body.ok === true;
  if (status >= 200 && status < 300) return okBody ? "done" : "retry";
  if (status === 401 || status === 408 || status === 429 || status >= 500) return "retry";
  if (isObj(body) && body.retriable === true) return "retry";
  return "gone";
}

/** 기기 보관 정리에서 뺄 응시 — "pending" 녹음이 하나라도 있는 응시 id(서버에 없는 녹음을 지우면 영영 잃는다) */
export function toeicRecPinnedAttempts(metas: readonly { attemptId: string; upload?: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const m of metas) if (toeicRecUploadStateOf(m) === "pending") out.add(m.attemptId);
  return out;
}

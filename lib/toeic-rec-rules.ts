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
 * - **녹음 관리·고칠 문장 다시 녹음**(2026-10-03, docs/harness/toeic.md §14): 고칠 문장 녹음 메타 `ToeicStoredFixRecording`(응시 기록의
 *   `fixRecordings` — 고칠 문장마다 최신 하나), 객체 키 `attempts/{id}/fixes/{q}/{fixIndex}/{recordedAtMs}`, 판정 `decideToeicFixRecordingUpload`,
 *   지운 자리 `ToeicRecordingDeletion`(응시 기록의 `recordingDeletions` — 지운 뒤 늦게 온 업로드가 녹음을 되살리지 않게), 지우기 적용
 *   `applyToeicRecordingDeletion`·지울 접두사 `toeicRecDeletionPrefixes`.
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
  const q = parseToeicRecQuestion(input.q);
  if (q === null) return { ok: false, status: 400, error: "invalid_input", messageKo: `문항 번호는 1~${TOEIC_QUESTION_COUNT}이어야 해요.` };
  return checkUploadBody(input, q, maxToeicRecordingMs(q));
}

/** 형식·크기·길이·시각 — 답변 녹음과 고칠 문장 녹음이 같은 검사를 쓴다(길이 상한만 다르다) */
function checkUploadBody(input: ToeicRecUploadInput, q: number, maxDurationMs: number): ToeicRecUploadCheck {
  const bad = (messageKo: string): ToeicRecUploadCheck => ({ ok: false, status: 400, error: "invalid_input", messageKo });
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
  if (durationMs === null || durationMs < 1 || durationMs > maxDurationMs) return bad("녹음 길이(durationMs)가 올바르지 않아요.");
  const recordedAtMs = intField(input.recordedAt);
  if (recordedAtMs === null || recordedAtMs <= 0) return bad("녹음 시각(recordedAt)이 올바르지 않아요.");
  return { ok: true, q, durationMs, recordedAtMs, mimeType: sniffed };
}

// ===========================================================================
// 교체 판정(§13-4 표)
// ===========================================================================

export type ToeicRecUploadDecision = "store" | "reused" | "superseded" | "locked" | "question_not_found" | "deleted";

export interface ToeicRecAttemptLike {
  questions: readonly number[];
  answers: readonly { q: number; transcript: string | null }[];
  recordings: readonly ToeicStoredRecording[];
  /** 지운 자리(§14-3) — 없으면 지운 적 없음(옛 문서·판정 픽스처) */
  recordingDeletions?: readonly ToeicRecordingDeletion[];
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
  // 지운 뒤 늦게 온 업로드(다른 기기의 대기열·이 기기의 진행 중 업로드)는 받지 않는다 — 지운 녹음이 되살아나지 않게(§14-3)
  if (isToeicRecordingTombstoned(attempt.recordingDeletions ?? [], q, null, incoming.recordedAtMs)) return "deleted";
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

/** purge: 서버가 "지운 녹음"이라고 답했다(409 recording_deleted) — 기기 사본도 지운다(§14-4) */
export type ToeicRecUploadAction = "done" | "gone" | "retry" | "purge";

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
  if (status === 409 && isObj(body) && body.error === "recording_deleted") return "purge";
  return "gone";
}

/** 기기 보관 정리에서 뺄 응시 — "pending" 녹음이 하나라도 있는 응시 id(서버에 없는 녹음을 지우면 영영 잃는다) */
export function toeicRecPinnedAttempts(metas: readonly { attemptId: string; upload?: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const m of metas) if (toeicRecUploadStateOf(m) === "pending") out.add(m.attemptId);
  return out;
}

// ===========================================================================
// 녹음 관리 · 고칠 문장 다시 녹음 (2026-10-03, docs/harness/toeic.md §14)
// ===========================================================================

/** 고칠 문장 녹음 메타 한 줄 — 응시 기록의 `fixRecordings`, (q, fixIndex)마다 하나(최신). 다시 녹음하면 바꾼다. */
export interface ToeicStoredFixRecording {
  /** 1..11 — 그 문항의 피드백(feedback.fixes)이 있는 문항 */
  q: number;
  /** 0.. — 그 문항 feedback.fixes의 자리 */
  fixIndex: number;
  /** 녹음할 때의 고친 문장(feedback.fixes[fixIndex].better — 서버가 피드백에서 옮긴다. "내 녹음" 목록이 피드백 없이 보이게) */
  better: string;
  /** "attempts/{attemptId}/fixes/{q}/{fixIndex}/{recordedAtMs}" */
  objectKey: string;
  mimeType: string;
  size: number;
  sha256: string;
  durationMs: number;
  recordedAt: string;
  uploadedAt: string;
}

/**
 * 지운 자리(tombstone) — 응시 기록의 `recordingDeletions`. 지운 뒤 다른 기기 대기열·진행 중 업로드가 그 녹음을 다시 올려도 받지 않게
 * (녹음 시각 ≤ 지운 시각이면 "deleted"). 지운 뒤 **새로** 녹음한 것(고칠 문장 다시 말하기)은 받는다.
 * - `q: null` = 응시 통째(답변·고칠 문장 모두) · `fixIndex: null` = 그 문항의 답변 녹음 · 둘 다 숫자 = 그 고칠 문장 녹음
 */
export interface ToeicRecordingDeletion {
  q: number | null;
  fixIndex: number | null;
  /** 서버가 지운 시각(ISO) */
  deletedAt: string;
}

/** 고칠 문장 자리 번호의 구조 상한(객체 키 모양) — 실제 범위는 그 문항 feedback.fixes 길이(호출 D zod 0~5개 — eval이 이 값 ≥ zod 상한을 잠근다) */
export const TOEIC_FIX_REC_INDEX_MAX = 9;
/** 고칠 문장 한 번 녹음의 자동 멈춤(화면) — 한 문장을 다시 말하는 데 충분하다 */
export const TOEIC_FIX_REC_LIMIT_MS = 30_000;
/** 서버가 받는 길이 상한 — 자동 멈춤 + 녹음기 여유 */
export const TOEIC_FIX_REC_MAX_MS = TOEIC_FIX_REC_LIMIT_MS + 5_000;

export function isToeicFixRecIndex(i: unknown): i is number {
  return typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= TOEIC_FIX_REC_INDEX_MAX;
}

/** 경로 i 조각 → 0..9 정수, 어긋나면 null(`^\d$` — 점·부호·두 자리 거부) */
export function parseToeicFixRecIndex(raw: string): number | null {
  const t = (raw ?? "").trim();
  if (!/^\d$/.test(t)) return null;
  const i = Number(t);
  return isToeicFixRecIndex(i) ? i : null;
}

/** 고칠 문장 녹음 객체 키 — 응시 접두사 **아래**(모의고사 삭제의 접두사 지우기가 함께 지운다). 어긋나면 던진다. 결과에 점이 없다. */
export function toeicFixRecObjectKey(attemptId: string, q: number, fixIndex: number, recordedAtMs: number): string {
  if (!isToeicRecQuestion(q)) throw new Error("toeicFixRecObjectKey: 문항 번호는 1~11 정수예요");
  if (!isToeicFixRecIndex(fixIndex)) throw new Error("toeicFixRecObjectKey: 고칠 문장 번호가 올바르지 않아요");
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs <= 0) throw new Error("toeicFixRecObjectKey: 녹음 시각은 양의 정수예요");
  return `${toeicRecObjectPrefix(attemptId)}fixes/${q}/${fixIndex}/${recordedAtMs}`;
}

/** 고칠 문장 녹음 키 모양 */
export const TOEIC_REC_FIX_OBJECT_KEY_RE = /^attempts\/[A-Za-z0-9_-]{1,64}\/fixes\/(?:[1-9]|1[01])\/[0-9]\/[1-9]\d{0,15}$/;

/** 보관소가 받는 객체 키(답변 또는 고칠 문장) — 파일 백엔드 경로 방어 */
export function isToeicRecObjectKey(key: string): boolean {
  return TOEIC_REC_OBJECT_KEY_RE.test(key) || TOEIC_REC_FIX_OBJECT_KEY_RE.test(key);
}

/** 지우기 접두사 모양 — 응시 통째 `attempts/{id}/` · 답변 한 문항 `attempts/{id}/{q}/` · 고칠 문장 하나 `attempts/{id}/fixes/{q}/{i}/` */
export const TOEIC_REC_PREFIX_RE = /^attempts\/[A-Za-z0-9_-]{1,64}\/(?:(?:[1-9]|1[01])\/|fixes\/(?:[1-9]|1[01])\/[0-9]\/)?$/;

/** 지울 대상 — 답변 한 문항 · 고칠 문장 하나 · 응시 통째(녹음만 — 응시 기록·점수는 남는다) */
export type ToeicRecDeleteTarget = { kind: "answer"; q: number } | { kind: "fix"; q: number; fixIndex: number } | { kind: "attempt" };

/** 대상 → 보관소에서 지울 접두사(대체된 옛 객체까지 — 한 자리의 모든 객체). 모양이 어긋나면 던진다. */
export function toeicRecDeletionPrefixes(attemptId: string, target: ToeicRecDeleteTarget): string[] {
  const base = toeicRecObjectPrefix(attemptId);
  if (target.kind === "attempt") return [base];
  if (!isToeicRecQuestion(target.q)) throw new Error("toeicRecDeletionPrefixes: 문항 번호가 올바르지 않아요");
  if (target.kind === "answer") return [`${base}${target.q}/`];
  if (!isToeicFixRecIndex(target.fixIndex)) throw new Error("toeicRecDeletionPrefixes: 고칠 문장 번호가 올바르지 않아요");
  return [`${base}fixes/${target.q}/${target.fixIndex}/`];
}

/** 지운 자리가 이 녹음(그 자리 · 녹음 시각)을 덮는가 — 응시 통째 지운 자리는 모든 자리를 덮는다 */
export function isToeicRecordingTombstoned(
  deletions: readonly ToeicRecordingDeletion[],
  q: number,
  fixIndex: number | null,
  recordedAtMs: number,
): boolean {
  for (const d of deletions) {
    const covers = d.q === null || (d.q === q && d.fixIndex === fixIndex);
    if (covers && recordedAtMs <= isoMs(d.deletedAt)) return true;
  }
  return false;
}

/** 그 자리를 지운 적이 있는가(가장 늦은 지운 시각 — 화면 "녹음을 지웠어요") */
export function toeicRecordingDeletedAt(deletions: readonly ToeicRecordingDeletion[], q: number, fixIndex: number | null): string | null {
  let best: string | null = null;
  for (const d of deletions) {
    const covers = d.q === null || (d.q === q && d.fixIndex === fixIndex);
    if (covers && (best === null || isoMs(d.deletedAt) > isoMs(best))) best = d.deletedAt;
  }
  return best;
}

export type ToeicFixRecUploadDecision = "store" | "reused" | "superseded" | "deleted" | "question_not_found" | "fix_not_found";

export interface ToeicFixRecAttemptLike {
  questions: readonly number[];
  answers: readonly { q: number; feedback: { fixes: readonly { better: string }[] } | null }[];
  fixRecordings: readonly ToeicStoredFixRecording[];
  recordingDeletions: readonly ToeicRecordingDeletion[];
}

/**
 * 고칠 문장 녹음 업로드 판정 — 답변 녹음과 달리 **잠그지 않는다**(채점과 무관한 연습이라 몇 번이고 다시 말해 최신으로 바꾼다).
 * 문항이 범위 밖이면 question_not_found, 그 문항에 그 자리의 고칠 문장이 없으면 fix_not_found, 지운 자리가 덮으면 deleted.
 */
export function decideToeicFixRecordingUpload(
  attempt: ToeicFixRecAttemptLike,
  q: number,
  fixIndex: number,
  incoming: { sha256: string; recordedAtMs: number },
): ToeicFixRecUploadDecision {
  if (!attempt.questions.includes(q)) return "question_not_found";
  const fixes = attempt.answers.find((a) => a.q === q)?.feedback?.fixes ?? [];
  if (!Number.isInteger(fixIndex) || fixIndex < 0 || fixIndex >= fixes.length) return "fix_not_found";
  if (isToeicRecordingTombstoned(attempt.recordingDeletions, q, fixIndex, incoming.recordedAtMs)) return "deleted";
  const current = attempt.fixRecordings.find((r) => r.q === q && r.fixIndex === fixIndex);
  if (!current) return "store";
  if (current.sha256 === incoming.sha256) return "reused";
  if (incoming.recordedAtMs <= isoMs(current.recordedAt)) return "superseded";
  return "store";
}

/** 그 고칠 문장의 고친 문장(서버가 메타에 옮긴다) — 없으면 null */
export function toeicFixBetterOf(attempt: Pick<ToeicFixRecAttemptLike, "answers">, q: number, fixIndex: number): string | null {
  const f = attempt.answers.find((a) => a.q === q)?.feedback?.fixes?.[fixIndex];
  return f ? f.better : null;
}

const byQFix = (a: { q: number; fixIndex: number }, b: { q: number; fixIndex: number }) => a.q - b.q || a.fixIndex - b.fixIndex;

/** 그 자리 메타를 바꿔 끼운 fixRecordings((q, fixIndex) 오름차순, 자리마다 하나) — 다른 필드는 건드리지 않는다 */
export function applyToeicFixRecording<T extends { fixRecordings: readonly ToeicStoredFixRecording[] }>(attempt: T, recording: ToeicStoredFixRecording): T {
  const fixRecordings = [...attempt.fixRecordings.filter((r) => !(r.q === recording.q && r.fixIndex === recording.fixIndex)), recording].sort(byQFix);
  return { ...attempt, fixRecordings };
}

/** 그 고칠 문장 녹음 메타(없으면 null) */
export function toeicStoredFixRecordingOf(attempt: { fixRecordings: readonly ToeicStoredFixRecording[] }, q: number, fixIndex: number): ToeicStoredFixRecording | null {
  return attempt.fixRecordings.find((r) => r.q === q && r.fixIndex === fixIndex) ?? null;
}

/** 지운 자리 한 줄을 더한다 — 같은 자리는 늦은 시각 하나만 남긴다(자리 수가 늘지 않게). 응시 통째면 다른 자리 줄은 덮이므로 정리한다. */
export function addToeicRecordingDeletion(deletions: readonly ToeicRecordingDeletion[], next: ToeicRecordingDeletion): ToeicRecordingDeletion[] {
  const slot = (d: ToeicRecordingDeletion) => `${d.q ?? "*"}:${d.fixIndex ?? "a"}`;
  const nextMs = isoMs(next.deletedAt);
  const kept = deletions.filter((d) => {
    if (slot(d) === slot(next)) return false;
    // 응시 통째 지운 자리가 더 늦으면 그보다 이른 다른 자리 줄은 의미가 없다
    if (next.q === null && isoMs(d.deletedAt) <= nextMs) return false;
    return true;
  });
  const prev = deletions.find((d) => slot(d) === slot(next));
  const merged = prev && isoMs(prev.deletedAt) > nextMs ? prev : next;
  return [...kept, merged].sort((a, b) => (a.q ?? 0) - (b.q ?? 0) || (a.fixIndex ?? -1) - (b.fixIndex ?? -1));
}

export interface ToeicRecDeletionApplied<T> {
  next: T;
  removedAnswers: ToeicStoredRecording[];
  removedFixes: ToeicStoredFixRecording[];
}

/**
 * 지우기 적용(순수) — 대상의 메타를 빼고 지운 자리를 더한다. **answers(점수·전사·피드백)·finishedAt은 건드리지 않는다** — 점수는 남고
 * 그 문항은 소리가 없어 다시 채점할 수 없다. 스토어 두 백엔드가 원자 단위 안에서 부른다(보관소 객체는 라우트가 **먼저** 지웠다).
 */
export function applyToeicRecordingDeletion<
  T extends { recordings: readonly ToeicStoredRecording[]; fixRecordings: readonly ToeicStoredFixRecording[]; recordingDeletions: readonly ToeicRecordingDeletion[] },
>(attempt: T, target: ToeicRecDeleteTarget, deletedAtIso: string): ToeicRecDeletionApplied<T> {
  const hitAnswer = (r: ToeicStoredRecording) => target.kind === "attempt" || (target.kind === "answer" && r.q === target.q);
  const hitFix = (r: ToeicStoredFixRecording) => target.kind === "attempt" || (target.kind === "fix" && r.q === target.q && r.fixIndex === target.fixIndex);
  const removedAnswers = attempt.recordings.filter(hitAnswer);
  const removedFixes = attempt.fixRecordings.filter(hitFix);
  const tomb: ToeicRecordingDeletion =
    target.kind === "attempt"
      ? { q: null, fixIndex: null, deletedAt: deletedAtIso }
      : target.kind === "answer"
        ? { q: target.q, fixIndex: null, deletedAt: deletedAtIso }
        : { q: target.q, fixIndex: target.fixIndex, deletedAt: deletedAtIso };
  const next = {
    ...attempt,
    recordings: attempt.recordings.filter((r) => !hitAnswer(r)),
    fixRecordings: attempt.fixRecordings.filter((r) => !hitFix(r)),
    recordingDeletions: addToeicRecordingDeletion(attempt.recordingDeletions, tomb),
  };
  return { next, removedAnswers, removedFixes };
}

/** 고칠 문장 녹음 메타 정규화 — 깨진 항목만 버리고, 같은 자리 둘이면 늦은 recordedAt 하나. (q, fixIndex) 오름차순. 던지지 않는다. */
export function normalizeToeicStoredFixRecordings(v: unknown): ToeicStoredFixRecording[] {
  if (!Array.isArray(v)) return [];
  const bySlot = new Map<string, ToeicStoredFixRecording>();
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const { q, fixIndex, better, objectKey, mimeType, size, sha256, durationMs, recordedAt, uploadedAt } = raw;
    if (!isToeicRecQuestion(q) || !isToeicFixRecIndex(fixIndex)) continue;
    if (typeof better !== "string" || typeof objectKey !== "string" || objectKey === "" || typeof mimeType !== "string" || typeof sha256 !== "string") continue;
    if (typeof recordedAt !== "string" || typeof uploadedAt !== "string") continue;
    if (typeof size !== "number" || !Number.isFinite(size) || typeof durationMs !== "number" || !Number.isFinite(durationMs)) continue;
    const rec: ToeicStoredFixRecording = { q, fixIndex, better, objectKey, mimeType, size, sha256, durationMs, recordedAt, uploadedAt };
    const k = `${q}:${fixIndex}`;
    const prev = bySlot.get(k);
    if (!prev || isoMs(rec.recordedAt) > isoMs(prev.recordedAt)) bySlot.set(k, rec);
  }
  return [...bySlot.values()].sort(byQFix);
}

/** 지운 자리 정규화 — 깨진 항목만 버리고 같은 자리는 늦은 시각 하나. 던지지 않는다. */
export function normalizeToeicRecordingDeletions(v: unknown): ToeicRecordingDeletion[] {
  if (!Array.isArray(v)) return [];
  let out: ToeicRecordingDeletion[] = [];
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const { q, fixIndex, deletedAt } = raw;
    if (typeof deletedAt !== "string" || !Number.isFinite(Date.parse(deletedAt))) continue;
    if (q !== null && !isToeicRecQuestion(q)) continue;
    if (fixIndex !== null && !isToeicFixRecIndex(fixIndex)) continue;
    if (q === null && fixIndex !== null) continue;
    out = addToeicRecordingDeletion(out, { q: q as number | null, fixIndex: fixIndex as number | null, deletedAt });
  }
  return out;
}

/** 고칠 문장 녹음 업로드 형식 검사 — 답변 녹음과 같은 형식·크기 규칙, 길이 상한만 TOEIC_FIX_REC_MAX_MS. 경로 i 조각도 본다. */
export function checkToeicFixRecordingUpload(
  input: ToeicRecUploadInput & { fixIndex: string },
): (ToeicRecUploadCheck & { ok: false }) | (Extract<ToeicRecUploadCheck, { ok: true }> & { fixIndex: number }) {
  const q = parseToeicRecQuestion(input.q);
  if (q === null) return { ok: false, status: 400, error: "invalid_input", messageKo: `문항 번호는 1~${TOEIC_QUESTION_COUNT}이어야 해요.` };
  const fixIndex = parseToeicFixRecIndex(input.fixIndex);
  if (fixIndex === null) return { ok: false, status: 400, error: "invalid_input", messageKo: "고칠 문장 번호가 올바르지 않아요." };
  const r = checkUploadBody(input, q, TOEIC_FIX_REC_MAX_MS);
  return r.ok ? { ...r, fixIndex } : r;
}

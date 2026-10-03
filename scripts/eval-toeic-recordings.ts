/**
 * scripts/eval-toeic-recordings.ts — 내 녹음 **서버 보관 + 비교** 오프라인 검증 (docs/harness/toeic.md §13-10) — scripts/eval-toeic.ts가 부른다.
 *
 * 12묶음: ① 업로드 계약·바이트 판정 ② 객체 키 ③ 경로·게이트 ④ 교체 판정 표 ⑤ 레코드(정규화·끝내기/채점 보존·응시 중 메타가 닫힘을
 * 뒤집지 않음) ⑥ 파일 백엔드 왕복 ⑦ 삭제 연쇄(순서 반례·prod-guard) ⑧ 기기 대기열 순수 함수 ⑨ 비교 순수 함수 ⑩ 틀 범위
 * ⑪ 소스 대조(캐시 헤더·src 금지·keepalive 금지·번들 경계·백엔드 판정 한 벌) ⑫ 회귀(스트릭 배선 무관).
 *
 * 네트워크·GCS를 부르지 않는다. 스토어·보관소를 실제로 돌리는 묶음(⑤ 일부·⑥·⑦)은 **자식 프로세스**에서 — 임시 폴더를 cwd로,
 * `STORE_BACKEND=file`·GCP env 비움·`TOEIC_REC_DIR`=임시 폴더(이 프로세스는 이미 lib/store를 불러 저장소 data/db.json을 가리키므로
 * 여기서 스토어를 만들지 않는다 — 전후 sha로 무접촉을 확인한다). 바이트 픽스처는 손으로 만든 머리 바이트(+0 채움), 문장은 지어낸 영어다.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToeicAttemptRecord } from "../lib/store";
import { applyAttemptAnswer, applyAttemptFinish } from "../lib/store";
import { TOEIC_REC_STORE_TYPES, TOEIC_SCORE_AUDIO_MAX_BYTES, toeicRecordingHref } from "../lib/toeic-attempt-contract";
import { isToeicAttemptClosed, maxToeicRecordingMs } from "../lib/toeic-attempt-rules";
import {
  TOEIC_COMPARE_HISTORY_MAX,
  pickToeicCompareAttempts,
  pickToeicCompareTarget,
  toeicAttemptDelta,
  toeicPreviousAttempt,
  toeicQuestionHistory,
  toeicScoreDelta,
  toeicScoreDeltaLabelKo,
  type ToeicCompareAttempt,
} from "../lib/toeic-compare";
import { normalizeToeicAttemptRecord } from "../lib/toeic-normalize";
import {
  TOEIC_REC_OBJECT_KEY_RE,
  applyToeicAttemptRecording,
  checkToeicRecordingUpload,
  decideToeicRecordingUpload,
  nextToeicRecUploadAction,
  normalizeToeicStoredRecordings,
  sniffToeicAudioType,
  toeicRecObjectKey,
  toeicRecPinnedAttempts,
  toeicRecUploadStateOf,
  toeicStoredRecordingOf,
  type ToeicStoredRecording,
} from "../lib/toeic-rec-rules";
import { TOEIC_REC_KEEP_ATTEMPTS, pickAttemptsToEvictByPool } from "../lib/toeic-rec-store";
import { findTemplatesInTranscript, frameFixedWordRuns, normalizeTemplateWords, sameTemplateWord, templateRunSpans, templateSpanSegments } from "../lib/toeic-template";
import type { GuideCheckResult } from "./eval-toeic-guides";

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
/** 주석을 뺀 코드 */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
/** 런타임 import 경로(import type·전부 type인 named import 제외) */
function runtimeImportPaths(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m[1]) continue;
    const clause = m[2].trim();
    if (/^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------------------
// 바이트 픽스처 — 손으로 만든 머리 바이트(+0 채움)
// ---------------------------------------------------------------------------

function bytesOf(head: number[] | string, size = 32): Uint8Array {
  const b = new Uint8Array(size);
  const arr = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  b.set(arr.slice(0, size));
  return b;
}
const MP4 = bytesOf([0, 0, 0, 0x18, ...[..."ftypM4A "].map((c) => c.charCodeAt(0))]);
const WEBM = bytesOf([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const OGG = bytesOf("OggS\u0000\u0002");
const WAV = bytesOf("RIFF$\u0000\u0000\u0000WAVEfmt ");
const HTML = bytesOf("<!doctype html><html>");

function upload(over: Partial<Parameters<typeof checkToeicRecordingUpload>[0]> = {}) {
  return checkToeicRecordingUpload({
    q: "5",
    durationMs: "12000",
    recordedAt: "1759450000000",
    declaredType: "audio/mp4",
    fileName: "answer.mp4",
    size: 300_000,
    head: MP4,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// ① 업로드 계약 · 바이트 판정
// ---------------------------------------------------------------------------

function runUploadContractChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ① 업로드 계약");
  add("sniff: mp4·webm·ogg·wav 머리 각각 판정", sniffToeicAudioType(MP4) === "audio/mp4" && sniffToeicAudioType(WEBM) === "audio/webm" && sniffToeicAudioType(OGG) === "audio/ogg" && sniffToeicAudioType(WAV) === "audio/wav");
  add("sniff: HTML·빈 바이트·RIFF인데 WAVE 아님 → null", sniffToeicAudioType(HTML) === null && sniffToeicAudioType(new Uint8Array(0)) === null && sniffToeicAudioType(bytesOf("RIFF\u0000\u0000\u0000\u0000AVI ")) === null);
  const ok = upload();
  add("정상 업로드 통과 — q·길이·시각·계열", ok.ok && ok.q === 5 && ok.durationMs === 12000 && ok.recordedAtMs === 1759450000000 && ok.mimeType === "audio/mp4", JSON.stringify(ok));
  for (const t of Object.keys(TOEIC_REC_STORE_TYPES)) {
    const head = TOEIC_REC_STORE_TYPES[t] === "audio/mp4" ? MP4 : TOEIC_REC_STORE_TYPES[t] === "audio/webm" ? WEBM : TOEIC_REC_STORE_TYPES[t] === "audio/ogg" ? OGG : WAV;
    const r = upload({ declaredType: t, head });
    add(`받는 타입 ${t} → 저장 contentType = 판정 계열 ${TOEIC_REC_STORE_TYPES[t]}`, r.ok && r.mimeType === TOEIC_REC_STORE_TYPES[t], JSON.stringify(r));
  }
  const xm4a = upload({ declaredType: "audio/x-m4a" });
  add("선언 audio/x-m4a → 저장 audio/mp4(선언이 아니라 판정 계열)", xm4a.ok && xm4a.mimeType === "audio/mp4");
  const params = upload({ declaredType: "audio/webm;codecs=opus", head: WEBM });
  add("파라미터는 무시(audio/webm;codecs=opus)", params.ok && params.mimeType === "audio/webm");
  const byName = upload({ declaredType: "", fileName: "answer.m4a" });
  add("타입이 비면 파일 이름 확장자로", byName.ok && byName.mimeType === "audio/mp4");
  const bad = (r: ReturnType<typeof upload>, status: 400 | 413) => !r.ok && r.status === status;
  add("받지 않는 타입(audio/mpeg·text/html) → 400", bad(upload({ declaredType: "audio/mpeg" }), 400) && bad(upload({ declaredType: "text/html" }), 400));
  add("선언 audio/mp4인데 webm 바이트 → 400", bad(upload({ head: WEBM }), 400));
  add("선언 audio/mp4인데 HTML 바이트(<!doctype) → 400", bad(upload({ head: HTML }), 400));
  add("빈 파일 → 400", bad(upload({ size: 0 }), 400));
  add("크기 경계: 4MB 통과 · +1바이트 413", upload({ size: TOEIC_SCORE_AUDIO_MAX_BYTES }).ok && bad(upload({ size: TOEIC_SCORE_AUDIO_MAX_BYTES + 1 }), 413));
  const max5 = maxToeicRecordingMs(5);
  add(
    `durationMs 경계: 0 거부 · maxToeicRecordingMs(5)=${max5} 통과 · +1 거부 · 소수·문자 거부`,
    bad(upload({ durationMs: "0" }), 400) && upload({ durationMs: String(max5) }).ok && bad(upload({ durationMs: String(max5 + 1) }), 400) &&
      bad(upload({ durationMs: "12.5" }), 400) && bad(upload({ durationMs: "abc" }), 400) && bad(upload({ durationMs: null }), 400),
  );
  add("recordedAt 정수 아님·0·없음 → 400", bad(upload({ recordedAt: "1759450000000.5" }), 400) && bad(upload({ recordedAt: "0" }), 400) && bad(upload({ recordedAt: null }), 400) && bad(upload({ recordedAt: "-5" }), 400));
  add("q 0·12·\"3.5\"·\"03a\"·빈 값 → 400", ["0", "12", "3.5", "03a", ""].every((q) => bad(upload({ q }), 400)));
  add("Q11 상한은 그 문항 기준(60초 + 여유)", upload({ q: "11", durationMs: String(maxToeicRecordingMs(11)) }).ok && bad(upload({ q: "11", durationMs: String(maxToeicRecordingMs(11) + 1) }), 400));
  return results;
}

// ---------------------------------------------------------------------------
// ② 객체 키
// ---------------------------------------------------------------------------

function runObjectKeyChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ② 객체 키");
  const key = toeicRecObjectKey("0b7c1f9e-1d2a-4c3b-9e8f-112233445566", 7, 1759450000123);
  add("형식 리터럴 attempts/{id}/{q}/{ms}", key === "attempts/0b7c1f9e-1d2a-4c3b-9e8f-112233445566/7/1759450000123", key);
  add("결과에 점이 없다 · 키 모양 정규식 통과", !key.includes(".") && TOEIC_REC_OBJECT_KEY_RE.test(key));
  add("Firestore 자동 id(20자 영숫자)도 통과", TOEIC_REC_OBJECT_KEY_RE.test(toeicRecObjectKey("AbCdEfGhIjKlMnOpQrSt", 1, 1)));
  add(
    "attemptId에 ..·/·.·빈 값·65자 → 던짐",
    throws(() => toeicRecObjectKey("..", 3, 1)) && throws(() => toeicRecObjectKey("a/b", 3, 1)) && throws(() => toeicRecObjectKey("a.b", 3, 1)) &&
      throws(() => toeicRecObjectKey("", 3, 1)) && throws(() => toeicRecObjectKey("a".repeat(65), 3, 1)) && !throws(() => toeicRecObjectKey("a".repeat(64), 3, 1)),
  );
  add("q 0·12·3.5 → 던짐", throws(() => toeicRecObjectKey("abc", 0, 1)) && throws(() => toeicRecObjectKey("abc", 12, 1)) && throws(() => toeicRecObjectKey("abc", 3.5, 1)));
  add("recordedAtMs 0·음수·소수 → 던짐", throws(() => toeicRecObjectKey("abc", 3, 0)) && throws(() => toeicRecObjectKey("abc", 3, -1)) && throws(() => toeicRecObjectKey("abc", 3, 1.5)));
  add("키 모양 정규식이 경로 밖 키를 거부", !TOEIC_REC_OBJECT_KEY_RE.test("attempts/../x/3/1") && !TOEIC_REC_OBJECT_KEY_RE.test("../attempts/a/3/1") && !TOEIC_REC_OBJECT_KEY_RE.test("attempts/a/3/1.m4a"));
  return results;
}

// ---------------------------------------------------------------------------
// ③ 경로 · 게이트
// ---------------------------------------------------------------------------

function runPathGateChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ③ 경로·게이트");
  const routeRel = "app/api/toeic/attempts/[id]/recordings/[q]/route.ts";
  add("녹음 라우트 파일이 있다(경로 조각에 점 없음)", existsSync(path.join(ROOT, routeRel)) && routeRel.split("/").slice(0, -1).every((seg) => !seg.includes(".")), routeRel);
  const href = toeicRecordingHref("abc-123", 3);
  add("화면 주소 toeicRecordingHref 마지막 조각에 점 없음", href === "/api/toeic/attempts/abc-123/recordings/3" && !href.split("/").pop()!.includes("."), href);
  const proxy = read("proxy.ts");
  const m = /const STATIC_FILE = \/(.+)\/([a-z]*);/.exec(proxy);
  const re = m ? new RegExp(m[1], m[2]) : null;
  add("proxy STATIC_FILE가 /api/toeic/attempts/x/recordings/3에 맞지 않는다(PIN 게이트가 걸린다)", re !== null && !re.test("/api/toeic/attempts/x/recordings/3") && !re.test(href));
  add("STATIC_FILE에 오디오 확장자(m4a|mp4|webm|wav|ogg)가 없다(누가 더하면 실패)", m !== null && !/\b(m4a|mp4|webm|wav|ogg)\b/.test(m[1]), m?.[1] ?? "정규식 없음");
  add("PUBLIC_PATHS에 녹음 경로가 없다", !/recordings/.test(/PUBLIC_PATHS = new Set\(\[[^\]]*\]\)/.exec(proxy)?.[0] ?? "x"));
  return results;
}

// ---------------------------------------------------------------------------
// ④ 교체 판정 표
// ---------------------------------------------------------------------------

const ISO = (ms: number) => new Date(ms).toISOString();
function stored(q: number, recordedAtMs: number, sha = "a".repeat(64), attemptId = "att-1"): ToeicStoredRecording {
  return {
    q,
    objectKey: toeicRecObjectKey(attemptId, q, recordedAtMs),
    mimeType: "audio/mp4",
    size: 1000,
    sha256: sha,
    durationMs: 9000,
    recordedAt: ISO(recordedAtMs),
    uploadedAt: ISO(recordedAtMs + 500),
  };
}

function runDecisionChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ④ 교체 판정");
  const T = 1_759_450_000_000;
  const base = { questions: [5, 6, 7], answers: [] as { q: number; transcript: string | null }[], recordings: [] as ToeicStoredRecording[] };
  const withRec = { ...base, recordings: [stored(5, T, "a".repeat(64))] };
  add("메타 없음 → store", decideToeicRecordingUpload(base, 5, { sha256: "b".repeat(64), recordedAtMs: T }) === "store");
  add("같은 sha → reused", decideToeicRecordingUpload(withRec, 5, { sha256: "a".repeat(64), recordedAtMs: T + 9 }) === "reused");
  add("더 이르거나 같은 녹음(다른 바이트) → superseded", decideToeicRecordingUpload(withRec, 5, { sha256: "b".repeat(64), recordedAtMs: T - 1 }) === "superseded" && decideToeicRecordingUpload(withRec, 5, { sha256: "b".repeat(64), recordedAtMs: T }) === "superseded");
  add("더 새 녹음 + 아직 전사 전 → store", decideToeicRecordingUpload({ ...withRec, answers: [{ q: 5, transcript: null }] }, 5, { sha256: "b".repeat(64), recordedAtMs: T + 1 }) === "store");
  add("더 새 녹음 + 이미 전사됨 → locked", decideToeicRecordingUpload({ ...withRec, answers: [{ q: 5, transcript: "I walk there every day." }] }, 5, { sha256: "b".repeat(64), recordedAtMs: T + 1 }) === "locked");
  add("범위 밖 q → question_not_found", decideToeicRecordingUpload(base, 3, { sha256: "b".repeat(64), recordedAtMs: T }) === "question_not_found");
  // 열림/닫힘은 결과를 바꾸지 않는다 — 판정 입력에 finishedAt이 있어도 무시
  const closed = { ...withRec, finishedAt: ISO(T), answers: [{ q: 5, transcript: null }, { q: 6, transcript: null }] };
  add("열린/닫힌 응시가 결과를 바꾸지 않음(닫힌 응시도 메타 없음 → store, 전사 전 새 녹음 → store)", decideToeicRecordingUpload({ ...closed, recordings: [] }, 5, { sha256: "c".repeat(64), recordedAtMs: T }) === "store" && decideToeicRecordingUpload(closed, 5, { sha256: "c".repeat(64), recordedAtMs: T + 1 }) === "store");
  const notRecorded = { ...base, answers: [{ q: 6, transcript: null, recorded: false }] };
  add("recorded:false 문항의 녹음도 store(목소리를 잃지 않는다)", decideToeicRecordingUpload(notRecorded, 6, { sha256: "d".repeat(64), recordedAtMs: T }) === "store");
  add("채점된 문항이어도 메타가 처음이면 store(이행분)", decideToeicRecordingUpload({ ...base, answers: [{ q: 5, transcript: "We usually meet on weekends." }] }, 5, { sha256: "e".repeat(64), recordedAtMs: T }) === "store");
  const applied = applyToeicAttemptRecording({ ...withRec, answers: [] as unknown[] }, stored(5, T + 1, "f".repeat(64)));
  add("applyToeicAttemptRecording: 그 q만 바꾸고 q마다 하나·answers 그대로", applied.recordings.length === 1 && applied.recordings[0].sha256 === "f".repeat(64) && applied.answers.length === 0);
  return results;
}

// ---------------------------------------------------------------------------
// ⑤ 레코드
// ---------------------------------------------------------------------------

function runRecordChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑤ 레코드");
  const T = 1_759_450_000_000;
  const legacy = normalizeToeicAttemptRecord({ id: "old", mockId: "m", scope: "part", parts: ["respond"], startedAt: ISO(T), finishedAt: null, answers: [] });
  add("옛 응시 문서(recordings 없음) → []", eqJson(legacy.recordings, []));
  const messy = normalizeToeicStoredRecordings([
    stored(6, T),
    { ...stored(5, T), size: "big" },
    null,
    { q: 12, objectKey: "x", mimeType: "a", size: 1, sha256: "s", durationMs: 1, recordedAt: ISO(T), uploadedAt: ISO(T) },
    stored(5, T + 10, "b".repeat(64)),
    stored(5, T + 5, "c".repeat(64)),
  ]);
  add("깨진 항목만 버림 · 같은 q 둘 → 늦은 recordedAt 하나 · q 오름차순", eqJson(messy.map((r) => `${r.q}:${r.sha256[0]}`), ["5:b", "6:a"]), JSON.stringify(messy.map((r) => r.q)));
  add("배열이 아니면 []", eqJson(normalizeToeicStoredRecordings({ q: 1 }), []) && eqJson(normalizeToeicStoredRecordings(undefined), []));
  const open: ToeicAttemptRecord = { id: "att-1", mockId: "m", scope: "part", parts: ["respond"], questions: [5, 6, 7], startedAt: ISO(T), finishedAt: null, answers: [], recordings: [], fixRecordings: [], recordingDeletions: [], retakes: [], answerHistory: [], answerDiags: [] };
  const withRec = applyToeicAttemptRecording(open, stored(5, T));
  add("응시 중 메타 저장이 answers를 만들지 않는다 → 닫힘 판정 false 유지(answers에 넣는 구현이면 실패)", withRec.answers.length === 0 && !isToeicAttemptClosed(withRec) && withRec.recordings.length === 1);
  const fin = applyAttemptFinish(withRec, { finishedAt: ISO(T + 1000), answers: [{ q: 5, recorded: true, durationMs: 9000 }] });
  add("applyAttemptFinish가 recordings를 그대로 둔다", eqJson(fin.recordings, withRec.recordings));
  const scored = applyAttemptAnswer(fin, 5, { transcript: "I like going there.", readDiff: null, feedback: null, score: 2, scoredAt: ISO(T + 2000) });
  add("applyAttemptAnswer가 recordings를 그대로 둔다", eqJson(scored.recordings, withRec.recordings));
  add("toeicStoredRecordingOf: 메타가 있는가 하나", toeicStoredRecordingOf(scored, 5)?.q === 5 && toeicStoredRecordingOf(scored, 6) === null);
  const round = normalizeToeicAttemptRecord(JSON.parse(JSON.stringify(scored)));
  add("정규화 왕복에서 recordings가 살아남는다(모르는 키를 버리는 정규화)", eqJson(round.recordings, scored.recordings));
  return results;
}

// ---------------------------------------------------------------------------
// ⑥·⑦ 파일 백엔드 실행 — 자식 프로세스(임시 cwd)
// ---------------------------------------------------------------------------

const CHILD_DB = {
  toeicAttempts: [{ id: "legacy-att", mockId: "legacy-mock", scope: "part", parts: ["respond"], startedAt: "2026-09-01T01:00:00.000Z", finishedAt: null, answers: [] }],
};

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const blobMod = await import(process.env.EVAL_BLOB_URL);
const rules = await import(process.env.EVAL_RULES_URL);
const attemptRules = await import(process.env.EVAL_ATTEMPT_RULES_URL);
const fs = await import("node:fs");
const path = await import("node:path");
const out = { cwd: process.cwd() };
const st = store.getStore();
const blob = blobMod.getToeicRecBlobStore();
out.backend = blob.backend;
out.storeBackend = store.resolveStoreBackend();
const recDir = blobMod.toeicRecFileDir();
out.recDir = recDir;
const MP4 = new Uint8Array(64); MP4.set([0,0,0,0x18,0x66,0x74,0x79,0x70,0x4d,0x34,0x41,0x20]);
const OTHER = new Uint8Array(64); OTHER.set([0,0,0,0x18,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d]);
const same = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

// ⑥ 왕복
const kA = rules.toeicRecObjectKey("att-a", 3, 1000);
await blob.put(kA, MP4, "audio/mp4");
out.roundTrip = same(await blob.get(kA), MP4);
await blob.put(kA, MP4, "audio/mp4");
out.rewriteSame = same(await blob.get(kA), MP4);
out.missingNull = (await blob.get(rules.toeicRecObjectKey("att-a", 4, 1000))) === null;
const esc = [];
for (const k of ["attempts/../../escape/3/1", "../escape", "attempts/att-a/3/1/../../../../x", "/etc/x"]) {
  try { await blob.put(k, MP4, "audio/mp4"); esc.push("written"); } catch { esc.push("rejected"); }
}
out.escape = esc;
out.escapedFile = fs.existsSync(path.join(process.cwd(), "escape")) || fs.existsSync(path.join(recDir, "..", "escape"));
await blob.put(rules.toeicRecObjectKey("att-b", 3, 1000), MP4, "audio/mp4");
out.deletedA = await blob.deleteAttempt("att-a");
out.aGone = (await blob.get(kA)) === null;
out.bKept = same(await blob.get(rules.toeicRecObjectKey("att-b", 3, 1000)), MP4);
out.deleteAgain = await blob.deleteAttempt("att-a");
let badPrefix = "ok"; try { await blob.deleteAttempt("../x"); badPrefix = "deleted"; } catch { badPrefix = "rejected"; }
out.badPrefix = badPrefix;

// 옛 문서
const legacy = await st.getToeicAttempt("legacy-att");
out.legacyRecordings = legacy ? legacy.recordings : "missing";

// 스토어 — 모의고사 둘, 응시 둘
const parts = { read: null, picture: null, respond: null, info: null, opinion: null };
const base = { targetGrade: "IH", expressionsUsed: [], topicHints: [], model: "x", parts, drillPart: null };
const m1 = await st.createToeicMock({ ...base, titleKo: "모의고사 가" });
const m2 = await st.createToeicMock({ ...base, titleKo: "모의고사 나" });
const mk = (mockId) => st.createToeicAttempt({ mockId, scope: "part", parts: ["respond"], questions: [5, 6, 7], startedAt: new Date().toISOString(), finishedAt: null, answers: [], recordings: [] });
const a1 = await mk(m1.id);
const a2 = await mk(m2.id);
const T = 1759450000000;
const rec = (aid, q, t, sha) => ({ q, objectKey: rules.toeicRecObjectKey(aid, q, t), mimeType: "audio/mp4", size: 64, sha256: sha, durationMs: 9000, recordedAt: new Date(t).toISOString(), uploadedAt: new Date().toISOString() });
for (const t of [T, T + 2000]) await blob.put(rules.toeicRecObjectKey(a1.id, 5, t), MP4, "audio/mp4");
await blob.put(rules.toeicRecObjectKey(a2.id, 5, T), OTHER, "audio/mp4");
// 동시 두 업로드(같은 q) — 새 녹음과 늦게 도착한 옛 녹음
const [rNew, rOld] = await Promise.all([
  st.setToeicAttemptRecording(a1.id, rec(a1.id, 5, T + 2000, "b".repeat(64))),
  st.setToeicAttemptRecording(a1.id, rec(a1.id, 5, T, "a".repeat(64))),
]);
out.concurrent = [rNew && rNew.outcome, rOld && rOld.outcome];
let cur = await st.getToeicAttempt(a1.id);
out.metaRecordedAt = cur.recordings.find((r) => r.q === 5).recordedAt;
out.answersEmptyWhileOpen = cur.answers.length === 0 && !attemptRules.isToeicAttemptClosed(cur);
out.reused = (await st.setToeicAttemptRecording(a1.id, rec(a1.id, 5, T + 2000, "b".repeat(64)))).outcome;
out.unknownQ = (await st.setToeicAttemptRecording(a1.id, rec(a1.id, 3, T, "z".repeat(64)))).outcome;
out.missingAttempt = await st.setToeicAttemptRecording("no-such-attempt", rec("no-such-attempt", 5, T, "q".repeat(64)));
const fin = await st.finishToeicAttempt(a1.id, { finishedAt: new Date().toISOString(), answers: [{ q: 5, recorded: true, durationMs: 9000 }] });
out.finishOutcome = fin.outcome;
cur = await st.getToeicAttempt(a1.id);
out.recordingsAfterFinish = cur.recordings.length;
// 끝낸 뒤 늦게 온 다시 녹음(전사 전) → 받는다
out.lateStore = (await st.setToeicAttemptRecording(a1.id, rec(a1.id, 5, T + 3000, "c".repeat(64)))).outcome;
await st.updateToeicAttemptAnswer(a1.id, 5, { transcript: "We go there on weekends.", readDiff: null, feedback: null, score: null, scoredAt: null });
out.lockedOutcome = (await st.setToeicAttemptRecording(a1.id, rec(a1.id, 5, T + 4000, "d".repeat(64)))).outcome;
cur = await st.getToeicAttempt(a1.id);
out.afterLockSha = cur.recordings.find((r) => r.q === 5).sha256[0];
out.answersAfterScore = cur.answers.length;

// ⑦ 삭제 연쇄 — 녹음 지우기 실패 주입 → 문서가 그대로(순서 반례)
const real = globalThis.__toeicRecBlobStore;
globalThis.__toeicRecBlobStore = { backend: "file", put: (...a) => real.put(...a), get: (...a) => real.get(...a), deleteAttempt: async () => { throw new Error("inject"); } };
let threw = false;
try { await st.deleteToeicMock(m1.id); } catch { threw = true; }
out.injectThrew = threw;
out.docsKeptOnFailure = (await st.getToeicMock(m1.id)) !== null && (await st.getToeicAttempt(a1.id)) !== null;
out.recsKeptOnFailure = fs.existsSync(path.join(recDir, "attempts", a1.id));
globalThis.__toeicRecBlobStore = real;
const del = await st.deleteToeicMock(m1.id);
out.delOk = del.ok;
out.a1DirGone = !fs.existsSync(path.join(recDir, "attempts", a1.id));
out.a2Kept = fs.existsSync(path.join(recDir, "attempts", a2.id)) && (await st.getToeicAttempt(a2.id)) !== null && (await st.getToeicMock(m2.id)) !== null;
out.docsGone = (await st.getToeicMock(m1.id)) === null && (await st.getToeicAttempt(a1.id)) === null;
out.delAgain = (await st.deleteToeicMock(m1.id)).ok;
console.log("@@RESULT@@" + JSON.stringify(out));
`;

function sha(file: string): string | null {
  return existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : null;
}

function runFileBackendChildChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add6 = adder(results, "녹음 ⑥ 파일 백엔드 왕복");
  const add5 = adder(results, "녹음 ⑤ 레코드");
  const add7 = adder(results, "녹음 ⑦ 삭제 연쇄");
  const repoDb = path.join(ROOT, "data", "db.json");
  const repoRec = path.join(ROOT, "data", "recordings");
  const beforeSha = sha(repoDb);
  const repoRecBefore = existsSync(repoRec);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-rec-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "db.json"), JSON.stringify(CHILD_DB));
    const recDir = path.join(dir, "recs");
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;
    const r = spawnSync(tsx, [script], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 90_000,
      env: {
        ...process.env,
        NODE_ENV: "development",
        STORE_BACKEND: "file",
        GOOGLE_APPLICATION_CREDENTIALS: "",
        GOOGLE_CLOUD_PROJECT: "",
        K_SERVICE: "",
        OPENAI_API_KEY: "",
        ALLOW_PROD_DESTRUCTIVE: "",
        TOEIC_REC_DIR: recDir,
        TOEIC_REC_BUCKET: "",
        EVAL_STORE_URL: url("lib/store.ts"),
        EVAL_BLOB_URL: url("lib/toeic-rec-blob.ts"),
        EVAL_RULES_URL: url("lib/toeic-rec-rules.ts"),
        EVAL_ATTEMPT_RULES_URL: url("lib/toeic-attempt-rules.ts"),
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add6("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 400)}`);
      return results;
    }
    const o = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    add6(
      "자식 cwd = 임시 폴더 · 스토어·보관소 백엔드 = file · 보관 디렉터리 = TOEIC_REC_DIR",
      realpathSync(String(o.cwd)) === realpathSync(dir) && o.backend === "file" && o.storeBackend === "file" && path.resolve(String(o.recDir)) === path.resolve(recDir),
      String(o.backend),
    );
    add6("쓰기 → 읽기 같은 바이트 · 같은 키 다시 쓰기 멱등 · 없는 키 null", o.roundTrip === true && o.rewriteSame === true && o.missingNull === true);
    add6("경로 밖 쓰기 시도 4종 전부 거부 · 밖에 파일이 생기지 않음", eqJson(o.escape, ["rejected", "rejected", "rejected", "rejected"]) && o.escapedFile === false, JSON.stringify(o.escape));
    add6("접두사 지우기가 그 응시만(옆 응시 남음) · 다시 지우면 0건(멱등) · 모양이 아닌 id는 거부", o.deletedA === 1 && o.aGone === true && o.bKept === true && o.deleteAgain === 0 && o.badPrefix === "rejected", `${o.deletedA}/${o.deleteAgain}/${o.badPrefix}`);
    add6("동시 두 업로드(같은 q, 옛 녹음이 늦게 도착) → 메타가 새 녹음을 가리킨다", new Date(String(o.metaRecordedAt)).getTime() === 1759450002000 && Array.isArray(o.concurrent) && (o.concurrent as string[]).includes("stored"), JSON.stringify(o.concurrent));
    add6("같은 바이트 다시 → reused · 범위 밖 q → question_not_found · 없는 응시 → null", o.reused === "reused" && o.unknownQ === "question_not_found" && o.missingAttempt === null);
    add5("옛 응시 문서(파일 백엔드) 읽기 → recordings []", eqJson(o.legacyRecordings, []));
    add5("응시 중 메타 저장 → answers 빈 배열·닫힘 false → 끝내기가 finished(409가 아니다)", o.answersEmptyWhileOpen === true && o.finishOutcome === "finished" && o.recordingsAfterFinish === 1);
    add5("끝낸 뒤 늦게 온 다시 녹음(전사 전) → store · 전사된 뒤 새 녹음 → locked(메타 그대로)", o.lateStore === "stored" && o.lockedOutcome === "locked" && o.afterLockSha === "c" && o.answersAfterScore === 1);
    add7("녹음 지우기 실패 주입 → deleteToeicMock이 던지고 모의고사·응시 문서·녹음이 그대로(순서 반례)", o.injectThrew === true && o.docsKeptOnFailure === true && o.recsKeptOnFailure === true);
    add7("deleteToeicMock → 그 모의고사 응시들의 녹음 디렉터리가 사라지고 다른 모의고사의 것은 남는다", o.delOk === true && o.a1DirGone === true && o.a2Kept === true && o.docsGone === true && o.delAgain === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add6("저장소 data/db.json 무접촉(전후 sha 같음) · 저장소 data/recordings 새로 안 생김", sha(repoDb) === beforeSha && existsSync(repoRec) === repoRecBefore, String(beforeSha));
  return results;
}

function runDeleteSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑦ 삭제 연쇄");
  const guard = read("lib/prod-guard.ts");
  add("DestructiveOp 유니온에 deleteToeicRecordings", /\|\s*"deleteToeicRecordings"/.test(codeOnly(guard)));
  const blob = codeOnly(read("lib/toeic-rec-blob.ts"));
  const gcsDel = /class GcsRecBlobStore[\s\S]*?async deleteAttempt\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(blob)?.[1] ?? "";
  add("GCS 지우기 함수가 assertDestructiveAllowed(\"deleteToeicRecordings\")를 먼저 부른다", /^\s*assertDestructiveAllowed\("deleteToeicRecordings"\);/.test(gcsDel), gcsDel.slice(0, 80));
  const fsSrc = codeOnly(read("lib/store-firestore.ts"));
  const fsDel = /async deleteToeicMock\(id: string\)[\s\S]*?\n {2}\}/.exec(fsSrc)?.[0] ?? "";
  add(
    "Firestore deleteToeicMock: 가드 → 녹음 지우기(deleteAttemptRecordings) → 문서 배치 지우기 순서",
    fsDel.indexOf('assertDestructiveAllowed("deleteToeicMock")') >= 0 &&
      fsDel.indexOf('assertDestructiveAllowed("deleteToeicMock")') < fsDel.indexOf("deleteAttemptRecordings(") &&
      fsDel.indexOf("deleteAttemptRecordings(") < fsDel.indexOf("batch.delete"),
  );
  const fileSrc = codeOnly(read("lib/store.ts"));
  const fileDel = /async deleteToeicMock\(id: string\)[\s\S]*?\n {2}\}/.exec(fileSrc)?.[0] ?? "";
  add("파일 deleteToeicMock: 녹음 지우기가 mutate(문서 지우기)보다 먼저", fileDel.indexOf("deleteAttemptRecordings(") >= 0 && fileDel.indexOf("deleteAttemptRecordings(") < fileDel.indexOf("this.mutate("));
  const route = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/route.ts"));
  // 2026-10-03(§14-4): 같은 파일에 녹음 관리 DELETE 핸들러가 생겼다 — 이 줄은 **업로드(PUT) 본문**에 지우기가 없음을 본다
  const putOnly = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function GET"));
  add("업로드(PUT) 본문에 지우기 동작이 없다(대체된 옛 답변 객체는 문항·응시·모의고사를 지울 때 접두사째)", putOnly.length > 0 && !/deleteAttempt|\.delete\(|deleteAttemptRecordings|deleteRecording/.test(putOnly));
  return results;
}

// ---------------------------------------------------------------------------
// ⑧ 기기 대기열 순수 함수
// ---------------------------------------------------------------------------

function runQueueChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑧ 기기 대기열");
  add("toeicRecUploadStateOf: 옛 메타(필드 없음)·모르는 값 → pending, done·gone 그대로", toeicRecUploadStateOf({}) === "pending" && toeicRecUploadStateOf({ upload: "x" }) === "pending" && toeicRecUploadStateOf({ upload: "done" }) === "done" && toeicRecUploadStateOf({ upload: "gone" }) === "gone");
  const act = (status: number, body: unknown) => nextToeicRecUploadAction({ kind: "response", status, body });
  const table: [string, string][] = [
    ["network", nextToeicRecUploadAction({ kind: "network" })],
    ["200 ok", act(200, { ok: true })],
    ["200 본문 깨짐", act(200, null)],
    ["400", act(400, { ok: false, error: "invalid_input" })],
    ["404", act(404, { ok: false, error: "attempt_not_found" })],
    ["409", act(409, { ok: false, error: "recording_locked" })],
    ["413", act(413, { ok: false, error: "audio_too_large" })],
    ["401", act(401, { ok: false, error: "locked" })],
    ["500 retriable", act(500, { ok: false, error: "storage_failed", retriable: true })],
    ["502 JSON 아님", act(502, null)],
    ["503 not_configured", act(503, { ok: false, error: "not_configured" })],
    ["403", act(403, { ok: false })],
  ];
  const want = ["retry", "done", "retry", "gone", "gone", "gone", "gone", "retry", "retry", "retry", "retry", "gone"];
  add("nextToeicRecUploadAction 표: 200→done · 400·404·409·413→gone · 401·5xx·네트워크·JSON 아님→retry", eqJson(table.map((x) => x[1]), want), table.map((x) => `${x[0]}=${x[1]}`).join(" "));
  // 정리 고정 — 모의고사 풀 7회분, 가장 오래된 둘이 pending
  const metas = Array.from({ length: 7 }, (_, i) => ({ attemptId: `mock-${i + 1}`, createdAt: 1000 + i, pool: "mock", upload: i < 2 ? "pending" : "done" }));
  const drills = Array.from({ length: 6 }, (_, i) => ({ attemptId: `drill-${i + 1}`, createdAt: 2000 + i, pool: "drill", upload: "done" }));
  const all = [...metas, ...drills];
  const pinned = toeicRecPinnedAttempts(all);
  const evicted = pickAttemptsToEvictByPool(all.filter((m) => !pinned.has(m.attemptId)), TOEIC_REC_KEEP_ATTEMPTS, "drill-6");
  add("toeicRecPinnedAttempts: pending이 있는 응시 id", eqJson([...pinned].sort(), ["mock-1", "mock-2"]));
  add("pending 응시는 6번째 이후여도 남고 순위 칸을 차지하지 않는다(done 5회분 그대로 남음)", !evicted.includes("mock-1") && !evicted.includes("mock-2") && evicted.filter((x) => x.startsWith("mock-")).length === 0, JSON.stringify(evicted));
  add("풀 분리(§12-7-6) 회귀 없음 — 연습 풀은 6번째(가장 오래된 drill-1)만", eqJson(evicted.filter((x) => x.startsWith("drill-")), ["drill-1"]), JSON.stringify(evicted));
  const allDone = metas.map((m) => ({ ...m, upload: "done" }));
  add("done만 있으면 지금 규칙(풀마다 5) 그대로", eqJson(pickAttemptsToEvictByPool(allDone.filter((m) => !toeicRecPinnedAttempts(allDone).has(m.attemptId)), 5, null).sort(), ["mock-1", "mock-2"]));
  const store = codeOnly(read("lib/toeic-rec-store.ts"));
  const evictBody = /async function evict\([\s\S]*?\n\}/.exec(store)?.[0] ?? "";
  add(
    "기기 정리(evict)가 pending 응시를 먼저 빼고(toeicRecPinnedAttempts) 나머지로 정리하고, 지우는 목록도 뺀 메타에서 돈다",
    /toeicRecPinnedAttempts\(all\)/.test(evictBody) && /const metas = all\.filter\(\(m\) => !pinned\.has\(m\.attemptId\)\)/.test(evictBody) && /pickAttemptsToEvictByPool\(metas, TOEIC_REC_KEEP_ATTEMPTS, current\)/.test(evictBody) && /for \(const m of metas\)/.test(evictBody),
  );
  add("저장이 새 녹음을 pending으로 · 옛 메타는 읽을 때 pending(toeicRecUploadStateOf)", /upload: "pending",\s*uploadedAt: null/.test(store) && /upload: toeicRecUploadStateOf\(m\)/.test(store));
  add("대기열 상태 바꾸기는 같은 녹음일 때만(createdAt 대조 — 다시 녹음을 done으로 덮지 않음)", /cur\.createdAt === createdAt/.test(store));
  const up = codeOnly(read("lib/toeic-rec-upload.ts"));
  add("비우기는 한 번에 하나(진행 중 약속 합류 — 재시도 대기 중이면 깨운다) · 재시도 2·10·30초", /if \(running\) \{\s*wake\?\.\(\);[^}]*return running;/.test(up) && /\[2_000, 10_000, 30_000\]/.test(up));
  return results;
}

// ---------------------------------------------------------------------------
// ⑨ 비교 순수 함수
// ---------------------------------------------------------------------------

function cmpAttempt(id: string, startedAt: string, opts: Partial<ToeicCompareAttempt> = {}): ToeicCompareAttempt {
  return { id, startedAt, finishedAt: startedAt, scope: "part", answers: [], recordings: [], ...opts };
}

function runCompareChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑨ 비교 함수");
  const q5 = { q: 5, passage: null, sampleAnswer: "I usually go there with my friends." };
  const fb = (improvedAnswer: string) => ({ feedback: { improvedAnswer } });
  add("대상: 개선 답변 우선", pickToeicCompareTarget(q5, fb("I often go there with my close friends."))?.kind === "improved");
  add("대상: 개선 답변이 없으면(빈 글·피드백 없음) 모범답변", pickToeicCompareTarget(q5, fb(""))?.kind === "sample" && pickToeicCompareTarget(q5, null)?.kind === "sample");
  add("대상: 칩 sample이면 모범답변", pickToeicCompareTarget(q5, fb("Another line here."), "sample")?.kind === "sample");
  add("대상: Q1–2는 지문", pickToeicCompareTarget({ q: 1, passage: "Welcome to the city garden tour.", sampleAnswer: null }, null)?.kind === "passage");
  add("대상: 글이 하나도 없으면 null", pickToeicCompareTarget({ q: 6, passage: null, sampleAnswer: null }, null) === null);

  const ans = (q: number, score: number | null, recorded = true) => ({ q, recorded, score, transcript: score === null ? null : `Sentence number ${score}.` });
  const atts: ToeicCompareAttempt[] = [
    cmpAttempt("a1", "2026-10-01T01:00:00.000Z", { answers: [ans(5, 1)] }),
    cmpAttempt("a2-open", "2026-10-01T02:00:00.000Z", { finishedAt: null, answers: [] }),
    cmpAttempt("a3-norec", "2026-10-01T03:00:00.000Z", { answers: [ans(5, null, false)] }),
    cmpAttempt("a4", "2026-10-01T04:00:00.000Z", { answers: [ans(5, null)], recordings: [stored(5, 1)] }),
    cmpAttempt("cur", "2026-10-01T05:00:00.000Z", { answers: [ans(5, 2)] }),
    cmpAttempt("a6-later", "2026-10-01T06:00:00.000Z", { answers: [ans(5, 0)] }),
  ];
  const h = toeicQuestionHistory([...atts].reverse(), "cur", 5, { localCopies: new Set(["a1"]) });
  add("기록: 시간순 · 열린 응시·녹음 안 된 문항 제외 · 이번 포함", eqJson(h.map((r) => r.attemptId), ["a1", "a4", "cur", "a6-later"]), JSON.stringify(h.map((r) => r.attemptId)));
  add("기록: hasRecording = 서버 메타 또는 이 기기 사본 · maxScore = 형식표", h[0].hasRecording && h[1].hasRecording && !h[2].hasRecording && h[0].maxScore === 3);
  const d = toeicScoreDelta(h);
  add("점수 변화: 앞선 가장 가까운 **채점된** 행(a4 채점 전 → a1) · 뒤 응시 무시", eqJson(d, { delta: 1, previous: 1, current: 2 }) && toeicScoreDeltaLabelKo(d!) === "▲1 (지난번 1)", JSON.stringify(d));
  add("점수 변화: 이번 점수 없음·앞선 채점 없음 → null", toeicScoreDelta(toeicQuestionHistory(atts, "a4", 5)) === null && toeicScoreDelta(toeicQuestionHistory(atts, "a1", 5)) === null);
  add("점수 변화 글: ▼·＝", toeicScoreDeltaLabelKo({ delta: -1, previous: 3 }) === "▼1 (지난번 3)" && toeicScoreDeltaLabelKo({ delta: 0, previous: 2 }) === "＝ (지난번 2)");
  const many = Array.from({ length: 8 }, (_, i) => cmpAttempt(`m${i}`, `2026-10-0${i + 1}T00:00:00.000Z`, { answers: [ans(7, i % 4)] }));
  const hLatest = toeicQuestionHistory(many, "m7", 7);
  add(`기록: 최근 ${TOEIC_COMPARE_HISTORY_MAX}개(이번 포함)`, hLatest.length === TOEIC_COMPARE_HISTORY_MAX && hLatest[hLatest.length - 1].attemptId === "m7" && hLatest[0].attemptId === "m3");
  const hOld = toeicQuestionHistory(many, "m1", 7);
  add("기록: 옛 결과를 다시 열면 이번 + 최근 4(시간순)", eqJson(hOld.map((r) => r.attemptId), ["m1", "m4", "m5", "m6", "m7"]), JSON.stringify(hOld.map((r) => r.attemptId)));
  add("응시 고르기: 최신 20 + 이번 늘 포함", pickToeicCompareAttempts(many, "m0", 3).map((a) => a.id).join(",") === "m0,m6,m7" && pickToeicCompareAttempts(many, "m7", 3).map((a) => a.id).join(",") === "m5,m6,m7");

  const full = (id: string, startedAt: string, scores: (number | null)[]) =>
    cmpAttempt(id, startedAt, { scope: "full", answers: scores.map((sc, i) => ({ q: i + 1, recorded: true, score: sc, transcript: null })) });
  const f1 = full("f1", "2026-10-01T00:00:00.000Z", [3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 3]);
  const f2 = full("f2", "2026-10-02T00:00:00.000Z", [3, 3, 3, 3, 2, 2, 3, 2, 2, 2, 4]);
  const tot = toeicAttemptDelta(f2, f1);
  add("응시 변화: 실전 둘 다 총점 → 총점 차", tot?.kind === "total" && tot.delta === tot.to - tot.from && tot.delta > 0, JSON.stringify(tot));
  const f1part = full("f1p", "2026-10-01T00:00:00.000Z", [3, 3, 2, null, null, null, null, null, null, null, null]);
  const sum = toeicAttemptDelta(f2, f1part);
  add("응시 변화: 한쪽이 덜 채점 → 둘 다 채점된 같은 문항 합", sum?.kind === "sum" && sum.count === 3 && sum.from === 8 && sum.to === 9, JSON.stringify(sum));
  add("응시 변화: 겹치는 채점 문항 0 → null · 앞선 응시 없음 → null", toeicAttemptDelta(cmpAttempt("x", "2026-10-03T00:00:00.000Z", { answers: [ans(5, 2)] }), cmpAttempt("y", "2026-10-01T00:00:00.000Z", { answers: [ans(6, 1)] })) === null && toeicAttemptDelta(f2, null) === null);
  add("앞선 응시: 같은 범위·닫힘·이번보다 먼저 중 가장 가까운", toeicPreviousAttempt([f1, f2, full("f3", "2026-10-03T00:00:00.000Z", [])], "f2")?.id === "f1" && toeicPreviousAttempt(atts, "cur")?.id === "a4");
  return results;
}

// ---------------------------------------------------------------------------
// ⑩ 틀 범위 — templateRunSpans ↔ findTemplatesInTranscript (지어낸 틀·문장)
// ---------------------------------------------------------------------------

const TPLS = [
  { key: "in-photo", frameEn: "In this photo, I can see {who}" },
  { key: "looks-like", frameEn: "It looks like {who} is {doing} near {place}" },
  { key: "busy", frameEn: "It is a busy {place}" },
  { key: "count", frameEn: "There are twenty five {things} in the room" },
  { key: "single", frameEn: "{a} and {b}" },
  { key: "reason", frameEn: "The main reason is that {why}" },
  { key: "dont", frameEn: "I don't usually {do} on weekends" },
];
const TEXTS = [
  "In this photo, I can see two people. It looks like a man is standing near the door.",
  "It's a busy street. There are twenty-five chairs in the room, and the main reason is that it is new.",
  "I don't usually cook on weekends. In this photo I can see a dog and a cat.",
  "Nothing here matches the frames at all.",
  "",
  "IN THIS PHOTO, I CAN SEE a big bus... It looks like the driver is waving near the gate!",
];

function runSpanChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑩ 틀 범위");
  TEXTS.forEach((text, i) => {
    const spans = templateRunSpans(text, TPLS);
    const found = findTemplatesInTranscript(text, TPLS).found.map((f) => f.key);
    add(`#${i + 1} key 집합 == findTemplatesInTranscript`, eqJson([...spans.map((x) => x.key)].sort(), [...found].sort()), `${spans.map((x) => x.key).join(",")} / ${found.join(",")}`);
    let inside = true;
    let noOverlap = true;
    let wordsMatch = true;
    for (const sp of spans) {
      const runs = frameFixedWordRuns(TPLS.find((t) => t.key === sp.key)!.frameEn).filter((w) => w.length >= 2);
      sp.runs.forEach((r, j) => {
        if (r.start < 0 || r.end > text.length || r.end <= r.start) inside = false;
        if (j > 0 && r.start < sp.runs[j - 1].end) noOverlap = false;
        const got = normalizeTemplateWords(text.slice(r.start, r.end));
        const want = runs[j] ?? [];
        if (got.length !== want.length || !want.every((w, k) => sameTemplateWord(w, got[k]))) wordsMatch = false;
      });
    }
    add(`#${i + 1} 범위가 글자 안 · 한 틀 안 조각 겹침 없음 · 범위의 낱말 = 고정 조각(sameTemplateWord)`, inside && noOverlap && wordsMatch, JSON.stringify(spans));
  });
  const multi = TEXTS.flatMap((t) => templateRunSpans(t, TPLS)).map((x) => x.key);
  add("픽스처가 여러 조각 틀·축약형·숫자 합치기·대문자를 실제로 거친다(찾은 틀이 비지 않음)", ["in-photo", "busy", "count", "reason", "dont"].every((k) => multi.includes(k)), multi.join(","));
  const segs = templateSpanSegments("It's a busy street.", templateRunSpans("It's a busy street.", TPLS));
  add("조각 나누기: 틀 구간과 나머지가 원문 그대로 이어진다", segs.map((x) => x.text).join("") === "It's a busy street." && segs[0].keys.join() === "busy" && segs[0].text === "It's a busy", JSON.stringify(segs));
  return results;
}

// ---------------------------------------------------------------------------
// ⑪ 소스 대조
// ---------------------------------------------------------------------------

function runSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑪ 소스 대조");
  const route = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/route.ts"));
  const getBody = route.slice(route.indexOf("export async function GET"));
  add("GET이 cache-control private, no-store + nosniff + inline을 싣는다", /"cache-control": "private, no-store"/.test(getBody) && /"x-content-type-options": "nosniff"/.test(getBody) && /"content-disposition": "inline"/.test(getBody));
  add("GET content-type = 메타의 mimeType(바이트 판정)", /"content-type": meta\.mimeType/.test(getBody));
  const putBody = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function GET"));
  add("PUT: 객체 먼저(put) → 메타(setToeicAttemptRecording)", putBody.indexOf(".put(objectKey") > 0 && putBody.indexOf(".put(objectKey") < putBody.indexOf("setToeicAttemptRecording("));
  // 2026-10-03(§15-4): 쓰기 전 판정은 세대를 보는 decideToeicAnswerUpload(이력이 없고 세대가 null이면 decideToeicRecordingUpload와 같다 — eval-toeic-retake가 무작위 대조)
  add("PUT: 판정을 쓰기 전에 한 번(decideToeicAnswerUpload — §13-4 표를 감싼다) — 원자 단위 안 판정은 스토어", putBody.indexOf("decideToeicAnswerUpload(") > 0 && putBody.indexOf("decideToeicAnswerUpload(") < putBody.indexOf(".put(objectKey"));
  add("PUT: sha256은 서버가 바이트로 계산(클라이언트 값을 받지 않음)", /createHash\("sha256"\)\.update\(bytes\)/.test(putBody) && !/form\.get\([^)]*sha/i.test(putBody));
  add("PUT·GET에 OpenAI 키 검사·AI 호출 없음", !/OPENAI_API_KEY|lib\/ai\//.test(route));
  add("라우트 로그에 바이트·파일 이름을 남기지 않는다(id·q·바이트 수·결과·ms)", !/console\.(log|error)\([^;]*(fileName|\.name\b|bytes\))/.test(route));
  const view = read("components/toeic-attempt-view.tsx");
  add("결과 화면 소스에 녹음 API 주소를 src=로 넣는 곳이 없다", !/src=\{?[^}\n]*(toeicRecordingHref|\/recordings\/)/.test(view) && !/\.src\s*=\s*toeicRecordingHref/.test(view));
  add("결과 화면: 서버 사본은 fetch로 미리 받아 objectURL(toeicRecordingHref는 fetch 안에서만)", /fetch\(toeicRecordingHref\(/.test(view) && /URL\.createObjectURL\(blob\)/.test(view));
  add("결과 화면: 이어 듣기 탭 안에서 unlockSpeechPlayback → 공용 플레이어 play()", /unlockSpeechPlayback\(\);[\s\S]{0,400}const p = playerRef\.current;/.test(view) && /p\.src = c\.url;\s*void p\.play\(\)/.test(view));
  const up = codeOnly(read("lib/toeic-rec-upload.ts"));
  add("업로드 모듈이 keepalive를 쓰지 않는다", !/keepalive/.test(up));
  for (const f of ["lib/toeic-rec-rules.ts", "lib/toeic-compare.ts", "lib/toeic-rec-upload.ts", "lib/toeic-rec-store.ts"]) {
    const paths = runtimeImportPaths(read(f));
    const bad = paths.filter((p) => /firebase-admin|(^|\/)store$|\/store-|\/ai\/|^openai$|^zod$|node:/.test(p));
    add(`번들 경계: ${f} — firebase-admin·lib/store·lib/ai·node: 값 import 없음`, bad.length === 0, bad.join(", ") || paths.join(", "));
  }
  const blob = codeOnly(read("lib/toeic-rec-blob.ts"));
  add("녹음 보관소는 백엔드를 resolveStoreBackend로만 고른다(판정 함수 두 벌 금지)", /resolveStoreBackend\(\)/.test(blob) && !/process\.env\.(STORE_BACKEND|K_SERVICE|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT)/.test(blob));
  const store = codeOnly(read("lib/store.ts"));
  add("lib/store가 같은 판정 함수를 내보낸다(export resolveStoreBackend)", /export \{ resolveStoreBackend/.test(store) && /const backend = resolveStoreBackend\(\);/.test(store));
  add("버킷 이름 env 빈 값 폴백(?.trim() ||) · 기본값 eunwoo-bookcard-toeic-rec", /process\.env\.TOEIC_REC_BUCKET\?\.trim\(\) \|\| TOEIC_REC_BUCKET_DEFAULT/.test(blob) && /TOEIC_REC_BUCKET_DEFAULT = "eunwoo-bookcard-toeic-rec"/.test(blob));
  add("SDK는 firebase-admin/storage(@google-cloud/storage 직접 import 없음)", /from "firebase-admin\/storage"/.test(blob) && !/from "@google-cloud\/storage"/.test(blob));
  const take = read("components/toeic-take-view.tsx");
  add("응시 화면: 기기 저장 직후 대기열 비우기(drainToeicRecUploads) — 업로드 실패가 응시를 멈추지 않는다(await 없음)", /saveToeicRecording\([\s\S]{0,400}\.finally\(\(\) => void drainToeicRecUploads\(\)\)/.test(take));
  return results;
}

// ---------------------------------------------------------------------------
// ⑫ 회귀 — 업로드는 스트릭과 무관
// ---------------------------------------------------------------------------

function runRegressionChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음 ⑫ 회귀");
  const streak = codeOnly(read("lib/toeic-streak.ts"));
  add("토익 스트릭 판정이 recordings(서버 보관)를 보지 않는다 — 녹음된 문항(answers.recorded) 그대로", !/recordings/.test(streak) && /recorded/.test(streak));
  const finish = codeOnly(read("app/api/toeic/attempts/[id]/finish/route.ts"));
  add("끝내기 라우트가 recordings를 쓰지 않는다", !/recordings/.test(finish));
  const score = codeOnly(read("app/api/toeic/attempts/[id]/score/route.ts"));
  add("채점 라우트 계약 그대로(multipart q·audio — 서버 사본 직접 읽기 없음)", !/getToeicRecBlobStore|recordings/.test(score));
  return results;
}

export function runToeicRecordingChecks(): GuideCheckResult[] {
  return [
    ...runUploadContractChecks(),
    ...runObjectKeyChecks(),
    ...runPathGateChecks(),
    ...runDecisionChecks(),
    ...runRecordChecks(),
    ...runFileBackendChildChecks(),
    ...runDeleteSourceChecks(),
    ...runQueueChecks(),
    ...runCompareChecks(),
    ...runSpanChecks(),
    ...runSourceChecks(),
    ...runRegressionChecks(),
  ];
}

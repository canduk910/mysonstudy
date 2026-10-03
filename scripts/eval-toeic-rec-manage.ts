/**
 * scripts/eval-toeic-rec-manage.ts — **녹음 관리 + 고칠 문장 다시 녹음** 오프라인 검증 (docs/harness/toeic.md §14-10) — scripts/eval-toeic.ts가 부른다.
 *
 * 11묶음: ① 객체 키·경로·게이트 ② 업로드 계약(고칠 문장) ③ 고칠 문장 판정 표 ④ 답변 판정 + 지운 자리 ⑤ 지우기 적용(점수 남음·자리 병합)
 * ⑥ 정규화 ⑦ 기기 대기열(purge) ⑧ 파일 백엔드 실행(자식 프로세스 — 고칠 문장 저장·교체·지우기 순서·실패 주입 일관성·연쇄)
 * ⑨ 목록 묶음 순수 함수 ⑩ 소스 대조(지우기 순서·prod-guard·번들 경계·src 금지·마이크 관문) ⑪ 마이크 점검 거짓 ✓ 회귀(QA mic-keep P3-2).
 *
 * 네트워크·GCS를 부르지 않는다. 스토어·보관소를 실제로 돌리는 묶음(⑧)은 eval-toeic-recordings와 같은 방식 — 임시 폴더를 cwd로 한 **자식 프로세스**,
 * `STORE_BACKEND=file`·GCP env 비움·`TOEIC_REC_DIR`=임시 폴더. 바이트 픽스처는 손으로 만든 머리 바이트, 문장은 지어낸 영어다(교재 문장 0).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOEIC_FEEDBACK_LIMITS } from "../lib/ai/toeic/schemas";
import { TOEIC_SCORE_AUDIO_MAX_BYTES, toeicAttemptRecordingsHref, toeicRecordingHref } from "../lib/toeic-attempt-contract";
import { normalizeToeicAttemptRecord } from "../lib/toeic-normalize";
import {
  TOEIC_FIX_REC_INDEX_MAX,
  TOEIC_FIX_REC_LIMIT_MS,
  TOEIC_FIX_REC_MAX_MS,
  TOEIC_REC_FIX_OBJECT_KEY_RE,
  TOEIC_REC_OBJECT_KEY_RE,
  TOEIC_REC_PREFIX_RE,
  addToeicRecordingDeletion,
  applyToeicFixRecording,
  applyToeicRecordingDeletion,
  checkToeicFixRecordingUpload,
  decideToeicFixRecordingUpload,
  decideToeicRecordingUpload,
  isToeicRecObjectKey,
  isToeicRecordingTombstoned,
  nextToeicRecUploadAction,
  normalizeToeicRecordingDeletions,
  normalizeToeicStoredFixRecordings,
  parseToeicFixRecIndex,
  toeicFixBetterOf,
  toeicFixRecObjectKey,
  toeicRecDeletionPrefixes,
  toeicRecObjectKey,
  toeicRecordingDeletedAt,
  type ToeicRecordingDeletion,
  type ToeicStoredFixRecording,
  type ToeicStoredRecording,
} from "../lib/toeic-rec-rules";
import { buildToeicRecManageView, withoutToeicRecGroup, withoutToeicRecItem, type ToeicRecAttemptSummary } from "../lib/toeic-rec-manage";
import type { GuideCheckResult } from "./eval-toeic-guides";

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
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
const ISO = (ms: number) => new Date(ms).toISOString();
const T = 1_759_450_000_000;
const ATT = "att-9f3c";

function bytesOf(head: number[] | string, size = 32): Uint8Array {
  const b = new Uint8Array(size);
  const arr = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  b.set(arr.slice(0, size));
  return b;
}
const MP4 = bytesOf([0, 0, 0, 0x18, ...[..."ftypM4A "].map((c) => c.charCodeAt(0))]);
const WEBM = bytesOf([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const HTML = bytesOf("<!doctype html><html>");

function ansRec(q: number, ms: number, sha = "a".repeat(64)): ToeicStoredRecording {
  return { q, objectKey: toeicRecObjectKey(ATT, q, ms), mimeType: "audio/mp4", size: 900, sha256: sha, durationMs: 9000, recordedAt: ISO(ms), uploadedAt: ISO(ms + 400) };
}
function fixRec(q: number, i: number, ms: number, sha = "f".repeat(64)): ToeicStoredFixRecording {
  return {
    q,
    fixIndex: i,
    better: `I usually take the bus to work, number ${i}.`,
    objectKey: toeicFixRecObjectKey(ATT, q, i, ms),
    mimeType: "audio/mp4",
    size: 300,
    sha256: sha,
    durationMs: 3200,
    recordedAt: ISO(ms),
    uploadedAt: ISO(ms + 300),
  };
}
const FIXES = [
  { said: "I go to work by bus usually.", better: "I usually take the bus to work.", whyKo: "어순" },
  { said: "It make me happy.", better: "It makes me happy.", whyKo: "3인칭 단수" },
];
function feedback(fixes = FIXES) {
  return { score: 2, summaryKo: "좋아요", strengths: ["분명해요"], fixes, missingKo: [], improvedAnswer: "I usually take the bus to work, and it makes me happy.", tryExpressions: [] };
}

// ---------------------------------------------------------------------------
// ① 객체 키 · 경로 · 게이트
// ---------------------------------------------------------------------------

function runKeyChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ① 키·경로");
  const k = toeicFixRecObjectKey("0b7c1f9e-1d2a-4c3b-9e8f-112233445566", 5, 2, 1759450000123);
  add("고칠 문장 키 형식 attempts/{id}/fixes/{q}/{i}/{ms} · 점 없음 · 응시 접두사 아래", k === "attempts/0b7c1f9e-1d2a-4c3b-9e8f-112233445566/fixes/5/2/1759450000123" && !k.includes(".") && k.startsWith("attempts/0b7c1f9e-1d2a-4c3b-9e8f-112233445566/"), k);
  add("고칠 문장 키 정규식 통과 · 답변 키 정규식은 거부(두 모양이 섞이지 않음)", TOEIC_REC_FIX_OBJECT_KEY_RE.test(k) && !TOEIC_REC_OBJECT_KEY_RE.test(k) && !TOEIC_REC_FIX_OBJECT_KEY_RE.test(toeicRecObjectKey(ATT, 5, 1)));
  add("isToeicRecObjectKey: 답변·고칠 문장 둘 다 받고 경로 밖·확장자 키 거부", isToeicRecObjectKey(k) && isToeicRecObjectKey(toeicRecObjectKey(ATT, 3, 1)) && !isToeicRecObjectKey("attempts/a/fixes/5/2/../../x") && !isToeicRecObjectKey("attempts/a/fixes/5/2/1.m4a") && !isToeicRecObjectKey("../attempts/a/fixes/5/2/1"));
  add(
    "fixIndex 10·-1·1.5·q 12·시각 0 → 던짐(키를 만들지 않는다)",
    throws(() => toeicFixRecObjectKey(ATT, 5, 10, 1)) && throws(() => toeicFixRecObjectKey(ATT, 5, -1, 1)) && throws(() => toeicFixRecObjectKey(ATT, 5, 1.5, 1)) && throws(() => toeicFixRecObjectKey(ATT, 12, 0, 1)) && throws(() => toeicFixRecObjectKey(ATT, 5, 0, 0)) && throws(() => toeicFixRecObjectKey("a/b", 5, 0, 1)),
  );
  add(`고칠 문장 자리 구조 상한 ${TOEIC_FIX_REC_INDEX_MAX} ≥ 호출 D zod fixes 상한 ${TOEIC_FEEDBACK_LIMITS.fixes[1]}(키가 실제 피드백을 다 담는다)`, TOEIC_FIX_REC_INDEX_MAX + 1 >= TOEIC_FEEDBACK_LIMITS.fixes[1]);
  add("parseToeicFixRecIndex: \"0\"~\"9\"만 · \"10\"·\"1.5\"·\"-1\"·\"a\"·빈 값 → null", parseToeicFixRecIndex("0") === 0 && parseToeicFixRecIndex("9") === 9 && ["10", "1.5", "-1", "a", "", " 2x"].every((x) => parseToeicFixRecIndex(x) === null));
  add(
    "지우기 접두사: 답변 한 문항 attempts/{id}/{q}/ · 고칠 문장 attempts/{id}/fixes/{q}/{i}/ · 응시 attempts/{id}/",
    eqJson(toeicRecDeletionPrefixes(ATT, { kind: "answer", q: 5 }), [`attempts/${ATT}/5/`]) &&
      eqJson(toeicRecDeletionPrefixes(ATT, { kind: "fix", q: 5, fixIndex: 1 }), [`attempts/${ATT}/fixes/5/1/`]) &&
      eqJson(toeicRecDeletionPrefixes(ATT, { kind: "attempt" }), [`attempts/${ATT}/`]),
  );
  add(
    "접두사 정규식: 세 모양만 · 'fixes/'만·두 자리 q 12·경로 밖·끝 슬래시 없음 거부 · 답변 q1 접두사가 q11을 덮지 않음(끝 슬래시)",
    [`attempts/${ATT}/`, `attempts/${ATT}/11/`, `attempts/${ATT}/fixes/11/4/`].every((p) => TOEIC_REC_PREFIX_RE.test(p)) &&
      [`attempts/${ATT}/fixes/`, `attempts/${ATT}/12/`, `attempts/../`, `attempts/${ATT}/5`, `attempts/${ATT}/fixes/5/`, "attempts/"].every((p) => !TOEIC_REC_PREFIX_RE.test(p)) &&
      !toeicRecObjectKey(ATT, 11, 5).startsWith(toeicRecDeletionPrefixes(ATT, { kind: "answer", q: 1 })[0]),
  );
  add("접두사: 답변 접두사가 고칠 문장 객체를 덮지 않는다(답변을 지워도 고칠 문장 녹음은 남는다)", !toeicFixRecObjectKey(ATT, 5, 0, 1).startsWith(toeicRecDeletionPrefixes(ATT, { kind: "answer", q: 5 })[0]));
  add("지우기 접두사: 범위 밖 q·자리 → 던짐", throws(() => toeicRecDeletionPrefixes(ATT, { kind: "answer", q: 0 })) && throws(() => toeicRecDeletionPrefixes(ATT, { kind: "fix", q: 5, fixIndex: 11 })) && throws(() => toeicRecDeletionPrefixes("..", { kind: "attempt" })));
  const fixHref = toeicRecordingHref("abc-123", 5, 2);
  add("화면 주소: 고칠 문장 …/recordings/5/fixes/2 · 응시 통째 …/recordings · 조각에 점 없음", fixHref === "/api/toeic/attempts/abc-123/recordings/5/fixes/2" && toeicAttemptRecordingsHref("abc-123") === "/api/toeic/attempts/abc-123/recordings" && fixHref.split("/").every((x) => !x.includes(".")), fixHref);
  const routes = ["app/api/toeic/attempts/[id]/recordings/[q]/fixes/[i]/route.ts", "app/api/toeic/attempts/[id]/recordings/route.ts"];
  add("라우트 파일 둘이 있다(경로 조각에 점 없음)", routes.every((r) => existsSync(path.join(ROOT, r)) && r.split("/").slice(0, -1).every((seg) => !seg.includes("."))));
  const proxy = read("proxy.ts");
  const m = /const STATIC_FILE = \/(.+)\/([a-z]*);/.exec(proxy);
  const re = m ? new RegExp(m[1], m[2]) : null;
  add("proxy STATIC_FILE가 고칠 문장·통째 지우기 주소에 맞지 않는다(PIN 게이트가 걸린다)", re !== null && !re.test(fixHref) && !re.test(toeicAttemptRecordingsHref("x")) && !re.test("/toeic/recordings"));
  return results;
}

// ---------------------------------------------------------------------------
// ② 업로드 계약 — 고칠 문장
// ---------------------------------------------------------------------------

function fixUpload(over: Partial<Parameters<typeof checkToeicFixRecordingUpload>[0]> = {}) {
  return checkToeicFixRecordingUpload({
    q: "5",
    fixIndex: "1",
    durationMs: "3200",
    recordedAt: String(T),
    declaredType: "audio/mp4",
    fileName: "fix.mp4",
    size: 120_000,
    head: MP4,
    ...over,
  });
}

function runFixContractChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ② 업로드 계약");
  const ok = fixUpload();
  add("정상 → q·fixIndex·길이·시각·판정 계열", ok.ok && ok.q === 5 && ok.fixIndex === 1 && ok.durationMs === 3200 && ok.recordedAtMs === T && ok.mimeType === "audio/mp4", JSON.stringify(ok));
  const bad = (r: ReturnType<typeof fixUpload>, status: 400 | 413) => !r.ok && r.status === status;
  add("fixIndex 조각 \"10\"·\"x\"·빈 값 → 400", bad(fixUpload({ fixIndex: "10" }), 400) && bad(fixUpload({ fixIndex: "x" }), 400) && bad(fixUpload({ fixIndex: "" }), 400));
  add(`길이: 화면 자동 멈춤 ${TOEIC_FIX_REC_LIMIT_MS}ms < 서버 상한 ${TOEIC_FIX_REC_MAX_MS}ms · 상한 통과 · +1 거부 · 0 거부`, TOEIC_FIX_REC_LIMIT_MS < TOEIC_FIX_REC_MAX_MS && fixUpload({ durationMs: String(TOEIC_FIX_REC_MAX_MS) }).ok && bad(fixUpload({ durationMs: String(TOEIC_FIX_REC_MAX_MS + 1) }), 400) && bad(fixUpload({ durationMs: "0" }), 400));
  add("바이트 판정이 답변 녹음과 같다 — HTML 바이트·선언과 다른 계열 → 400, 저장 계열은 판정값", bad(fixUpload({ head: HTML }), 400) && bad(fixUpload({ head: WEBM }), 400) && (() => { const r = fixUpload({ declaredType: "audio/x-m4a" }); return r.ok && r.mimeType === "audio/mp4"; })());
  add("크기: 4MB 통과 · +1 413 · 빈 파일 400", fixUpload({ size: TOEIC_SCORE_AUDIO_MAX_BYTES }).ok && bad(fixUpload({ size: TOEIC_SCORE_AUDIO_MAX_BYTES + 1 }), 413) && bad(fixUpload({ size: 0 }), 400));
  add("q·recordedAt 형식 → 400", bad(fixUpload({ q: "12" }), 400) && bad(fixUpload({ recordedAt: "0" }), 400) && bad(fixUpload({ recordedAt: "1.5" }), 400));
  return results;
}

// ---------------------------------------------------------------------------
// ③ 고칠 문장 판정 표 · ④ 답변 판정 + 지운 자리
// ---------------------------------------------------------------------------

function fixAttempt(over: Partial<Parameters<typeof decideToeicFixRecordingUpload>[0]> = {}) {
  return {
    questions: [5, 6, 7],
    answers: [
      { q: 5, feedback: feedback() },
      { q: 6, feedback: null },
    ],
    fixRecordings: [] as ToeicStoredFixRecording[],
    recordingDeletions: [] as ToeicRecordingDeletion[],
    ...over,
  };
}

function runDecisionChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ③ 고칠 문장 판정");
  const inc = (ms: number, sha = "b".repeat(64)) => ({ sha256: sha, recordedAtMs: ms });
  add("메타 없음 → store", decideToeicFixRecordingUpload(fixAttempt(), 5, 1, inc(T)) === "store");
  const withRec = fixAttempt({ fixRecordings: [fixRec(5, 1, T)] });
  add("같은 sha → reused", decideToeicFixRecordingUpload(withRec, 5, 1, inc(T + 5, "f".repeat(64))) === "reused");
  add("더 이르거나 같은 녹음 → superseded(늦게 온 옛 업로드가 새 녹음을 덮지 않는다)", decideToeicFixRecordingUpload(withRec, 5, 1, inc(T)) === "superseded" && decideToeicFixRecordingUpload(withRec, 5, 1, inc(T - 1)) === "superseded");
  add("더 새 녹음 → store(다시 말하면 최신으로 바뀐다)", decideToeicFixRecordingUpload(withRec, 5, 1, inc(T + 1)) === "store");
  add("잠그지 않는다 — 채점된 문항(점수·전사)이어도 새 녹음 → store", decideToeicFixRecordingUpload({ ...withRec, answers: [{ q: 5, feedback: feedback(), transcript: "x", score: 3 } as never] }, 5, 1, inc(T + 9)) === "store");
  add("자리 밖(fixes 길이 2 → 2)·피드백 없는 문항 → fix_not_found", decideToeicFixRecordingUpload(fixAttempt(), 5, 2, inc(T)) === "fix_not_found" && decideToeicFixRecordingUpload(fixAttempt(), 6, 0, inc(T)) === "fix_not_found" && decideToeicFixRecordingUpload(fixAttempt(), 7, 0, inc(T)) === "fix_not_found");
  add("범위 밖 q → question_not_found", decideToeicFixRecordingUpload(fixAttempt(), 3, 0, inc(T)) === "question_not_found");
  const tomb = fixAttempt({ recordingDeletions: [{ q: 5, fixIndex: 1, deletedAt: ISO(T + 100) }] });
  add("지운 자리가 덮는 녹음(시각 ≤ 지운 시각) → deleted · 지운 뒤 새로 말한 것 → store", decideToeicFixRecordingUpload(tomb, 5, 1, inc(T + 100)) === "deleted" && decideToeicFixRecordingUpload(tomb, 5, 1, inc(T + 101)) === "store");
  add("다른 자리의 지운 자리는 무관 · 답변 자리(fixIndex null)는 고칠 문장을 덮지 않음", decideToeicFixRecordingUpload(tomb, 5, 0, inc(T)) === "store" && decideToeicFixRecordingUpload(fixAttempt({ recordingDeletions: [{ q: 5, fixIndex: null, deletedAt: ISO(T + 100) }] }), 5, 0, inc(T)) === "store");
  add("응시 통째 지운 자리(q null)는 모든 고칠 문장 자리를 덮는다", decideToeicFixRecordingUpload(fixAttempt({ recordingDeletions: [{ q: null, fixIndex: null, deletedAt: ISO(T + 100) }] }), 5, 0, inc(T)) === "deleted");
  add("toeicFixBetterOf: 서버가 피드백에서 고친 문장을 옮긴다 · 없으면 null", toeicFixBetterOf(fixAttempt(), 5, 1) === FIXES[1].better && toeicFixBetterOf(fixAttempt(), 5, 2) === null && toeicFixBetterOf(fixAttempt(), 6, 0) === null);
  const applied = applyToeicFixRecording(withRec, fixRec(5, 1, T + 50, "c".repeat(64)));
  const two = applyToeicFixRecording(applied, fixRec(5, 0, T + 60));
  add("applyToeicFixRecording: 자리마다 하나(바꿔 끼움) · (q, fixIndex) 오름차순 · 다른 필드 그대로", applied.fixRecordings.length === 1 && applied.fixRecordings[0].sha256 === "c".repeat(64) && eqJson(two.fixRecordings.map((r) => r.fixIndex), [0, 1]) && two.answers === withRec.answers);

  const addA = adder(results, "녹음관리 ④ 답변 판정·지운 자리");
  const base = { questions: [5, 6], answers: [] as { q: number; transcript: string | null }[], recordings: [] as ToeicStoredRecording[] };
  const del = { ...base, recordingDeletions: [{ q: 5, fixIndex: null, deletedAt: ISO(T + 100) }] };
  addA("답변 녹음: 지운 자리가 덮는 늦은 업로드(다른 기기 대기열) → deleted", decideToeicRecordingUpload(del, 5, { sha256: "b".repeat(64), recordedAtMs: T }) === "deleted");
  addA("답변 녹음: 지운 자리가 없거나 다른 문항이면 지금 판정 그대로(store)", decideToeicRecordingUpload(base, 5, { sha256: "b".repeat(64), recordedAtMs: T }) === "store" && decideToeicRecordingUpload(del, 6, { sha256: "b".repeat(64), recordedAtMs: T }) === "store");
  addA("답변 녹음: 고칠 문장 지운 자리(fixIndex 숫자)는 답변을 덮지 않는다", decideToeicRecordingUpload({ ...base, recordingDeletions: [{ q: 5, fixIndex: 0, deletedAt: ISO(T + 100) }] }, 5, { sha256: "b".repeat(64), recordedAtMs: T }) === "store");
  addA("답변 녹음: 응시 통째 지운 자리 → 모든 문항 deleted", decideToeicRecordingUpload({ ...base, recordingDeletions: [{ q: null, fixIndex: null, deletedAt: ISO(T + 100) }] }, 6, { sha256: "b".repeat(64), recordedAtMs: T }) === "deleted");
  addA("isToeicRecordingTombstoned 경계: 같은 시각은 덮는다 · 1ms 뒤는 덮지 않는다", isToeicRecordingTombstoned(del.recordingDeletions, 5, null, T + 100) && !isToeicRecordingTombstoned(del.recordingDeletions, 5, null, T + 101));
  addA("toeicRecordingDeletedAt: 자리의 가장 늦은 지운 시각(응시 통째 포함) · 지운 적 없으면 null", toeicRecordingDeletedAt([{ q: 5, fixIndex: null, deletedAt: ISO(T) }, { q: null, fixIndex: null, deletedAt: ISO(T + 9) }], 5, null) === ISO(T + 9) && toeicRecordingDeletedAt([], 5, null) === null);
  return results;
}

// ---------------------------------------------------------------------------
// ⑤ 지우기 적용 · ⑥ 정규화 · ⑦ 기기 대기열
// ---------------------------------------------------------------------------

function runApplyChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ⑤ 지우기 적용");
  const answers = [
    { q: 5, recorded: true, durationMs: 9000, transcript: "I usually go by bus.", readDiff: null, feedback: feedback(), score: 2, scoredAt: ISO(T) },
    { q: 6, recorded: true, durationMs: 8000, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null },
  ];
  const a = {
    id: ATT,
    answers,
    finishedAt: ISO(T),
    recordings: [ansRec(5, T), ansRec(6, T)],
    fixRecordings: [fixRec(5, 0, T + 10), fixRec(5, 1, T + 20)],
    recordingDeletions: [] as ToeicRecordingDeletion[],
  };
  const ansDel = applyToeicRecordingDeletion(a, { kind: "answer", q: 5 }, ISO(T + 1000));
  add("답변 지우기: 그 문항 답변 메타만 빠진다 · 고칠 문장 녹음은 남는다", eqJson(ansDel.next.recordings.map((r) => r.q), [6]) && ansDel.next.fixRecordings.length === 2 && ansDel.removedAnswers.length === 1 && ansDel.removedFixes.length === 0);
  add("답변 지우기: **점수·전사·피드백·finishedAt 그대로**(answers 깊은 같음)", eqJson(ansDel.next.answers, answers) && ansDel.next.finishedAt === ISO(T));
  add("답변 지우기: 지운 자리 {q:5, fixIndex:null}", eqJson(ansDel.next.recordingDeletions, [{ q: 5, fixIndex: null, deletedAt: ISO(T + 1000) }]));
  const fixDel = applyToeicRecordingDeletion(a, { kind: "fix", q: 5, fixIndex: 1 }, ISO(T + 1000));
  add("고칠 문장 지우기: 그 자리만 빠진다 · 답변 녹음·다른 자리 남음", eqJson(fixDel.next.fixRecordings.map((r) => r.fixIndex), [0]) && fixDel.next.recordings.length === 2 && fixDel.removedFixes.length === 1);
  const allDel = applyToeicRecordingDeletion(a, { kind: "attempt" }, ISO(T + 1000));
  add("응시 통째: 답변·고칠 문장 메타 모두 빠지고 지운 자리 q:null 하나 · answers 그대로", allDel.next.recordings.length === 0 && allDel.next.fixRecordings.length === 0 && eqJson(allDel.next.recordingDeletions, [{ q: null, fixIndex: null, deletedAt: ISO(T + 1000) }]) && eqJson(allDel.next.answers, answers) && allDel.removedAnswers.length === 2 && allDel.removedFixes.length === 2);
  const again = applyToeicRecordingDeletion(ansDel.next, { kind: "answer", q: 5 }, ISO(T + 2000));
  add("다시 지우기(멱등): 뺄 메타 0 · 같은 자리 지운 자리는 늦은 시각 하나(늘지 않는다)", again.removedAnswers.length === 0 && eqJson(again.next.recordingDeletions, [{ q: 5, fixIndex: null, deletedAt: ISO(T + 2000) }]));
  const merged = addToeicRecordingDeletion([{ q: 5, fixIndex: null, deletedAt: ISO(T + 5) }, { q: 6, fixIndex: 0, deletedAt: ISO(T + 6) }], { q: null, fixIndex: null, deletedAt: ISO(T + 10) });
  add("응시 통째 지운 자리가 더 늦으면 그보다 이른 자리 줄은 정리된다(덮이므로)", eqJson(merged, [{ q: null, fixIndex: null, deletedAt: ISO(T + 10) }]));
  const older = addToeicRecordingDeletion([{ q: 5, fixIndex: null, deletedAt: ISO(T + 50) }], { q: 5, fixIndex: null, deletedAt: ISO(T + 10) });
  add("같은 자리에 더 이른 시각이 와도 늦은 시각을 지킨다", eqJson(older, [{ q: 5, fixIndex: null, deletedAt: ISO(T + 50) }]));

  const addN = adder(results, "녹음관리 ⑥ 정규화");
  const legacy = normalizeToeicAttemptRecord({ id: "old", mockId: "m", scope: "part", parts: ["respond"], startedAt: ISO(T), finishedAt: null, answers: [], recordings: [] });
  addN("옛 응시 문서(필드 없음) → fixRecordings [] · recordingDeletions []", eqJson(legacy.fixRecordings, []) && eqJson(legacy.recordingDeletions, []));
  const messy = normalizeToeicStoredFixRecordings([fixRec(5, 1, T), { ...fixRec(5, 0, T), better: 3 }, null, { ...fixRec(5, 1, T), fixIndex: 12 }, fixRec(5, 1, T + 9, "9".repeat(64)), fixRec(4, 0, T)]);
  addN("고칠 문장 메타: 깨진 항목만 버림 · 같은 자리 둘 → 늦은 녹음 · (q, i) 오름차순", eqJson(messy.map((r) => `${r.q}:${r.fixIndex}:${r.sha256[0]}`), ["4:0:f", "5:1:9"]), JSON.stringify(messy.map((r) => `${r.q}:${r.fixIndex}`)));
  const dels = normalizeToeicRecordingDeletions([{ q: 5, fixIndex: null, deletedAt: ISO(T) }, { q: 5, fixIndex: null, deletedAt: ISO(T + 9) }, { q: null, fixIndex: 2, deletedAt: ISO(T) }, { q: 12, fixIndex: null, deletedAt: ISO(T) }, { q: 6, fixIndex: 0, deletedAt: "어제" }, "x"]);
  addN("지운 자리: 깨진 항목(q null인데 자리 숫자·범위 밖·시각 아님)만 버림 · 같은 자리 늦은 것 하나", eqJson(dels, [{ q: 5, fixIndex: null, deletedAt: ISO(T + 9) }]), JSON.stringify(dels));
  const full = normalizeToeicAttemptRecord({ ...legacy, fixRecordings: [fixRec(5, 1, T)], recordingDeletions: [{ q: 6, fixIndex: null, deletedAt: ISO(T) }] });
  const round = normalizeToeicAttemptRecord(JSON.parse(JSON.stringify(full)));
  addN("정규화 왕복에서 두 필드가 살아남는다(모르는 키를 버리는 정규화)", eqJson(round.fixRecordings, full.fixRecordings) && eqJson(round.recordingDeletions, full.recordingDeletions) && round.fixRecordings.length === 1);

  const addQ = adder(results, "녹음관리 ⑦ 기기 대기열");
  const act = (status: number, body: unknown) => nextToeicRecUploadAction({ kind: "response", status, body });
  addQ("409 recording_deleted → purge(기기 사본도 지운다) · 409 recording_locked → gone 그대로 · 200 → done", act(409, { ok: false, error: "recording_deleted" }) === "purge" && act(409, { ok: false, error: "recording_locked" }) === "gone" && act(200, { ok: true }) === "done");
  const up = codeOnly(read("lib/toeic-rec-upload.ts"));
  addQ("비우기: purge면 같은 녹음일 때만 이 기기 사본을 지운다(deleteToeicRecordingsLocal) · keepalive 없음", /result\.action === "purge"[\s\S]{0,400}getToeicRecordingBlob\(meta\.attemptId, meta\.q, meta\.createdAt\)[\s\S]{0,120}deleteToeicRecordingsLocal\(meta\.attemptId, \[meta\.q\]\)/.test(up) && !/keepalive/.test(up));
  const st = codeOnly(read("lib/toeic-rec-store.ts"));
  const delBody = /export async function deleteToeicRecordingsLocal[\s\S]*?\n\}/.exec(st)?.[0] ?? "";
  addQ("기기 지우기: 메모리·바이트(rec)·메타(meta)를 함께 지운다 — 대기열에서도 빠진다(업로드 취소)", /memory\.delete\(k\)/.test(delBody) && /objectStore\(STORE_REC\)\.delete\(key\)/.test(delBody) && /objectStore\(STORE_META\)\.delete\(key\)/.test(delBody));
  return results;
}

// ---------------------------------------------------------------------------
// ⑧ 파일 백엔드 실행 — 자식 프로세스(임시 cwd)
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const blobMod = await import(process.env.EVAL_BLOB_URL);
const rules = await import(process.env.EVAL_RULES_URL);
const delMod = await import(process.env.EVAL_DELETE_URL);
const fs = await import("node:fs");
const path = await import("node:path");
const out = {};
const st = store.getStore();
const blob = blobMod.getToeicRecBlobStore();
out.backend = blob.backend;
const recDir = blobMod.toeicRecFileDir();
const MP4 = new Uint8Array(64); MP4.set([0,0,0,0x18,0x66,0x74,0x79,0x70,0x4d,0x34,0x41,0x20]);
const T = 1759450000000;
const iso = (ms) => new Date(ms).toISOString();
const parts = { read: null, picture: null, respond: null, info: null, opinion: null };
const m1 = await st.createToeicMock({ targetGrade: "IH", expressionsUsed: [], topicHints: [], model: "x", parts, drillPart: null, titleKo: "모의고사 가" });
const fb = { score: 2, summaryKo: "좋아요", strengths: ["분명해요"], fixes: [{ said: "It make me happy.", better: "It makes me happy.", whyKo: "단수" }, { said: "I go there usually.", better: "I usually go there.", whyKo: "어순" }], missingKo: [], improvedAnswer: "It makes me happy.", tryExpressions: [] };
const a1 = await st.createToeicAttempt({ mockId: m1.id, scope: "part", parts: ["respond"], questions: [5, 6, 7], startedAt: iso(T), finishedAt: iso(T + 1000),
  answers: [{ q: 5, recorded: true, durationMs: 9000, transcript: "It make me happy.", readDiff: null, feedback: fb, score: 2, scoredAt: iso(T + 2000) },
            { q: 6, recorded: true, durationMs: 9000, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null },
            { q: 7, recorded: false, durationMs: null, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null }],
  recordings: [], fixRecordings: [], recordingDeletions: [] });
out.newFields = Array.isArray(a1.fixRecordings) && Array.isArray(a1.recordingDeletions);
const ans = (q, t, sha) => ({ q, objectKey: rules.toeicRecObjectKey(a1.id, q, t), mimeType: "audio/mp4", size: 64, sha256: sha, durationMs: 9000, recordedAt: iso(t), uploadedAt: iso(t + 1) });
const fix = (q, i, t, sha) => ({ q, fixIndex: i, better: fb.fixes[i].better, objectKey: rules.toeicFixRecObjectKey(a1.id, q, i, t), mimeType: "audio/mp4", size: 64, sha256: sha, durationMs: 3000, recordedAt: iso(t), uploadedAt: iso(t + 1) });
for (const q of [5, 6]) { for (const t of [T, T + 10]) await blob.put(rules.toeicRecObjectKey(a1.id, q, t), MP4, "audio/mp4"); }
await st.setToeicAttemptRecording(a1.id, ans(5, T + 10, "a".repeat(64)));
await st.setToeicAttemptRecording(a1.id, ans(6, T + 10, "b".repeat(64)));
// 고칠 문장 — 저장 → 다시 말하기(교체: replaced 돌려줌) → 늦게 온 옛것(superseded) → 자리 밖
await blob.put(rules.toeicFixRecObjectKey(a1.id, 5, 0, T + 3000), MP4, "audio/mp4");
const f1 = await st.setToeicAttemptFixRecording(a1.id, fix(5, 0, T + 3000, "c".repeat(64)));
await blob.put(rules.toeicFixRecObjectKey(a1.id, 5, 0, T + 4000), MP4, "audio/mp4");
const f2 = await st.setToeicAttemptFixRecording(a1.id, fix(5, 0, T + 4000, "d".repeat(64)));
out.fixFirst = f1.outcome; out.fixReplace = f2.outcome; out.replacedKey = f2.replaced && f2.replaced.objectKey;
out.fixLate = (await st.setToeicAttemptFixRecording(a1.id, fix(5, 0, T + 3500, "e".repeat(64)))).outcome;
out.fixOutside = (await st.setToeicAttemptFixRecording(a1.id, { ...fix(5, 1, T + 3000, "f".repeat(64)), fixIndex: 2 })).outcome;
out.fixNoFeedback = (await st.setToeicAttemptFixRecording(a1.id, { ...fix(5, 0, T + 3000, "1".repeat(64)), q: 6 })).outcome;
await blob.put(rules.toeicFixRecObjectKey(a1.id, 5, 1, T + 5000), MP4, "audio/mp4");
await st.setToeicAttemptFixRecording(a1.id, fix(5, 1, T + 5000, "2".repeat(64)));
// 옛 객체 지우기(라우트가 커밋 뒤에) — deleteKey
out.deleteKeyOld = await blob.deleteKey(rules.toeicFixRecObjectKey(a1.id, 5, 0, T + 3000));
out.deleteKeyAgain = await blob.deleteKey(rules.toeicFixRecObjectKey(a1.id, 5, 0, T + 3000));
let cur = await st.getToeicAttempt(a1.id);
out.fixMetaCount = cur.fixRecordings.length;
out.answersAfterFix = JSON.stringify(cur.answers);

// ── 지우기(라우트 한 벌 lib/toeic-rec-delete) — 실패 주입: 보관소 지우기가 던지면 메타가 그대로(서버 먼저 → 메타 정리)
const real = globalThis.__toeicRecBlobStore;
globalThis.__toeicRecBlobStore = { ...real, backend: "file", put: (...a) => real.put(...a), get: (...a) => real.get(...a), deleteKey: (...a) => real.deleteKey(...a), deleteAttempt: (...a) => real.deleteAttempt(...a), deletePrefix: async () => { throw new Error("inject"); } };
const failed = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 5 });
out.injectStatus = failed.status; out.injectError = failed.body.error; out.injectRetriable = failed.body.retriable === true;
cur = await st.getToeicAttempt(a1.id);
out.metaKeptOnFailure = cur.recordings.some((r) => r.q === 5) && cur.recordingDeletions.length === 0;
out.objectsKeptOnFailure = fs.existsSync(path.join(recDir, "attempts", a1.id, "5"));
globalThis.__toeicRecBlobStore = real;
// 성공 — 답변 Q5: 그 문항 디렉터리(옛 객체 포함)만 사라지고 Q6·고칠 문장은 남는다, 점수·전사·피드백 그대로
const okDel = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 5 });
out.delStatus = okDel.status; out.delOutcome = okDel.body.outcome; out.delObjects = okDel.body.removedObjects;
out.q5DirGone = !fs.existsSync(path.join(recDir, "attempts", a1.id, "5"));
out.q6Kept = fs.existsSync(path.join(recDir, "attempts", a1.id, "6"));
out.fixDirKept = fs.existsSync(path.join(recDir, "attempts", a1.id, "fixes", "5", "0"));
cur = await st.getToeicAttempt(a1.id);
out.answersSame = JSON.stringify(cur.answers) === out.answersAfterFix;
out.recQs = cur.recordings.map((r) => r.q);
out.tomb = cur.recordingDeletions;
out.bodyMatches = JSON.stringify(okDel.body.recordings) === JSON.stringify(cur.recordings) && JSON.stringify(okDel.body.recordingDeletions) === JSON.stringify(cur.recordingDeletions);
// 지운 뒤 늦게 온 업로드(다른 기기 대기열의 옛 Q5) → deleted, 메타 되살아나지 않음
out.lateAfterDelete = (await st.setToeicAttemptRecording(a1.id, ans(5, T + 10, "a".repeat(64)))).outcome;
out.stillGone = !(await st.getToeicAttempt(a1.id)).recordings.some((r) => r.q === 5);
// 다시 지우기 → absent(멱등), 객체 0
const again = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 5 });
out.againOutcome = again.body.outcome; out.againObjects = again.body.removedObjects;
// 고칠 문장 하나 지우기 → 그 자리 디렉터리만
const fd = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "fix", q: 5, fixIndex: 0 });
out.fixDelOutcome = fd.body.outcome;
out.fix0Gone = !fs.existsSync(path.join(recDir, "attempts", a1.id, "fixes", "5", "0"));
out.fix1Kept = fs.existsSync(path.join(recDir, "attempts", a1.id, "fixes", "5", "1"));
// 지운 고칠 문장 자리에 지운 뒤 새로 말한 것 → store(연습은 다시 할 수 있다)
await blob.put(rules.toeicFixRecObjectKey(a1.id, 5, 0, Date.now() + 5000), MP4, "audio/mp4");
out.fixAfterDelete = (await st.setToeicAttemptFixRecording(a1.id, fix(5, 0, Date.now() + 5000, "3".repeat(64)))).outcome;
// 범위 밖 문항 → 404 · 없는 응시 → 404
out.qOutside = (await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 3 })).status;
out.noAttempt = (await delMod.deleteToeicRecordingTarget("no-such-attempt", { kind: "attempt" })).status;
// 응시 통째 → 응시 디렉터리가 사라지고 응시 기록·점수는 남는다
const whole = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "attempt" });
out.wholeStatus = whole.status;
out.attemptDirGone = !fs.existsSync(path.join(recDir, "attempts", a1.id));
cur = await st.getToeicAttempt(a1.id);
out.wholeKeepsAttempt = cur !== null && cur.answers.length === 3 && cur.answers[0].score === 2 && cur.answers[0].feedback !== null;
out.wholeMeta = [cur.recordings.length, cur.fixRecordings.length, cur.recordingDeletions.length, cur.recordingDeletions[0] && cur.recordingDeletions[0].q];
out.lateAfterWhole = (await st.setToeicAttemptRecording(a1.id, ans(6, T + 10, "b".repeat(64)))).outcome;
// 모의고사 삭제 연쇄가 고칠 문장 객체까지(응시 접두사 아래) 지운다
const a2 = await st.createToeicAttempt({ mockId: m1.id, scope: "part", parts: ["respond"], questions: [5], startedAt: iso(T + 9000), finishedAt: null, answers: [], recordings: [], fixRecordings: [], recordingDeletions: [] });
await blob.put(rules.toeicFixRecObjectKey(a2.id, 5, 0, T), MP4, "audio/mp4");
const delMock = await st.deleteToeicMock(m1.id);
out.mockDel = delMock.ok && !fs.existsSync(path.join(recDir, "attempts", a2.id));
console.log("@@RESULT@@" + JSON.stringify(out));
`;

function runFileBackendChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ⑧ 파일 백엔드");
  const repoRec = path.join(ROOT, "data", "recordings");
  const repoRecBefore = existsSync(repoRec);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-recman-"));
  const childDb = path.join(dir, "data", "db.json"); // 자식 cwd의 빈 파일 저장소(저장소 data/db.json 무접촉)
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(childDb, JSON.stringify({}));
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
        EVAL_DELETE_URL: url("lib/toeic-rec-delete.ts"),
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 600)}`);
      return results;
    }
    const o = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    add("보관소 백엔드 = file(임시 TOEIC_REC_DIR) · 생성 응시에 두 필드", o.backend === "file" && o.newFields === true);
    add("고칠 문장: 처음 stored → 다시 말하기 stored(replaced = 옛 키) → 늦게 온 옛것 superseded", o.fixFirst === "stored" && o.fixReplace === "stored" && typeof o.replacedKey === "string" && String(o.replacedKey).endsWith("/fixes/5/0/1759450003000") && o.fixLate === "superseded", JSON.stringify([o.fixFirst, o.fixReplace, o.fixLate, o.replacedKey]));
    add("고칠 문장: 자리 밖 → fix_not_found · 피드백 없는 문항 → fix_not_found · 자리마다 하나(메타 2)", o.fixOutside === "fix_not_found" && o.fixNoFeedback === "fix_not_found" && o.fixMetaCount === 2);
    add("deleteKey: 옛 객체 지우면 true · 다시 지우면 false(멱등)", o.deleteKeyOld === true && o.deleteKeyAgain === false);
    add(
      "실패 주입(보관소 지우기가 던짐) → 500 delete_failed(retriable) · **메타·지운 자리·객체 모두 그대로**(상태 일관)",
      o.injectStatus === 500 && o.injectError === "delete_failed" && o.injectRetriable === true && o.metaKeptOnFailure === true && o.objectsKeptOnFailure === true,
      JSON.stringify([o.injectStatus, o.injectError, o.metaKeptOnFailure, o.objectsKeptOnFailure]),
    );
    add("답변 Q5 지우기 → 200 deleted · 그 문항 객체(대체된 옛 객체 포함 2개)만 · Q6·고칠 문장 남음", o.delStatus === 200 && o.delOutcome === "deleted" && o.delObjects === 2 && o.q5DirGone === true && o.q6Kept === true && o.fixDirKept === true, JSON.stringify([o.delObjects, o.q5DirGone, o.q6Kept, o.fixDirKept]));
    add("답변 지우기 뒤 **점수·전사·피드백 그대로**(answers 같음) · 메타 Q6만 · 지운 자리 {q:5, fixIndex:null} · 응답 = 저장값", o.answersSame === true && eqJson(o.recQs, [6]) && Array.isArray(o.tomb) && (o.tomb as ToeicRecordingDeletion[]).length === 1 && (o.tomb as ToeicRecordingDeletion[])[0].q === 5 && (o.tomb as ToeicRecordingDeletion[])[0].fixIndex === null && o.bodyMatches === true);
    add("지운 뒤 늦게 온 옛 업로드(다른 기기 대기열) → deleted · 메타 되살아나지 않음", o.lateAfterDelete === "deleted" && o.stillGone === true);
    add("다시 지우기 → 200 absent · 객체 0(멱등)", o.againOutcome === "absent" && o.againObjects === 0);
    add("고칠 문장 하나 지우기 → 그 자리만(다른 자리 남음) · 지운 뒤 새로 말한 것은 store", o.fixDelOutcome === "deleted" && o.fix0Gone === true && o.fix1Kept === true && o.fixAfterDelete === "stored");
    add("범위 밖 문항 → 404 · 없는 응시 → 404", o.qOutside === 404 && o.noAttempt === 404);
    add("응시 통째 → 200 · 응시 디렉터리 사라짐 · **응시 기록·점수·피드백 남음** · 메타 0·0 · 지운 자리 q:null 하나 · 늦은 업로드 deleted", o.wholeStatus === 200 && o.attemptDirGone === true && o.wholeKeepsAttempt === true && eqJson(o.wholeMeta, [0, 0, 1, null]) && o.lateAfterWhole === "deleted", JSON.stringify(o.wholeMeta));
    add("모의고사 삭제 연쇄가 고칠 문장 객체까지 지운다(응시 접두사 아래)", o.mockDel === true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("저장소 data/recordings 새로 안 생김(자식은 임시 폴더만)", existsSync(repoRec) === repoRecBefore);
  return results;
}

// ---------------------------------------------------------------------------
// ⑨ 목록 묶음 순수 함수
// ---------------------------------------------------------------------------

function summary(id: string, startedAt: string, over: Partial<ToeicRecAttemptSummary> = {}): ToeicRecAttemptSummary {
  return {
    id,
    mockId: "m1",
    titleKo: "모의고사 가",
    scopeLabelKo: "실전 응시",
    startedAt,
    questions: [5, 6, 7],
    answers: [
      { q: 5, recorded: true, score: 2 },
      { q: 6, recorded: true, score: null },
    ],
    recordings: [],
    fixRecordings: [],
    recordingDeletions: [],
    ...over,
  };
}

function runManageViewChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ⑨ 목록 묶음");
  const s1 = summary("old", "2026-10-01T01:00:00.000Z", { recordings: [{ ...ansRec(5, T), objectKey: toeicRecObjectKey("old", 5, T) }] });
  const s2 = summary("new", "2026-10-02T01:00:00.000Z", {
    recordings: [{ ...ansRec(5, T), objectKey: toeicRecObjectKey("new", 5, T) }],
    fixRecordings: [{ ...fixRec(5, 1, T), objectKey: toeicFixRecObjectKey("new", 5, 1, T) }, { ...fixRec(5, 0, T), objectKey: toeicFixRecObjectKey("new", 5, 0, T) }],
    recordingDeletions: [{ q: 7, fixIndex: null, deletedAt: ISO(T + 1000) }],
  });
  const s3 = summary("none", "2026-10-03T01:00:00.000Z");
  const local = [
    { attemptId: "new", q: 6, durationMs: 8000, size: 10, createdAt: T, upload: "pending" },
    { attemptId: "new", q: 7, durationMs: 7000, size: 10, createdAt: T, upload: "done" }, // 지운 자리가 덮는다 → purge
    { attemptId: "old", q: 5, durationMs: 9000, size: 10, createdAt: T, upload: "done" },
    { attemptId: "gone-att", q: 3, durationMs: 4000, size: 10, createdAt: T + 5 },
  ];
  const v = buildToeicRecManageView([s1, s2, s3], local);
  add("묶음: 녹음 없는 응시는 빠지고 최신 응시 먼저", eqJson(v.groups.map((g) => g.attemptId), ["new", "old"]));
  const g = v.groups[0];
  add(
    "항목: 문항 순 · 같은 문항은 답변 → 고칠 문장(자리 순) · 이 기기에만 있는 pending 답변 포함",
    eqJson(g.items.map((i) => (i.kind === "answer" ? `a${i.q}` : i.kind === "fix" ? `f${i.q}.${i.fixIndex}` : `h${i.q}`)), ["a5", "f5.0", "f5.1", "a6"]),
    JSON.stringify(g.items.map((i) => i.kind + i.q)),
  );
  const a6 = g.items.find((i) => i.kind === "answer" && i.q === 6);
  add("이 기기에만 있는 답변: server false · local true · pending true · 점수 없음", !!a6 && a6.kind === "answer" && !a6.server && a6.local && a6.pending && a6.score === null);
  const a5 = g.items.find((i) => i.kind === "answer" && i.q === 5);
  add("서버 답변: 점수 2/3 · 유형 이름 듣고 답하기", !!a5 && a5.kind === "answer" && a5.server && a5.score === 2 && a5.maxScore === 3 && a5.partNameKo === "듣고 답하기");
  add("지운 자리가 덮는 이 기기 사본(Q7)은 목록에서 빠지고 purgeLocal에 담긴다", !g.items.some((i) => i.q === 7) && eqJson(v.purgeLocal, [{ attemptId: "new", qs: [7] }]));
  add("응시 기록이 없는 이 기기 사본 → orphans(이 기기에서만 지우기)", eqJson(v.orphans.map((o) => [o.attemptId, o.qs]), [["gone-att", [3]]]));
  add("합계: 답변 2 · 고칠 문장 2 · 길이 합", g.answerCount === 2 && g.fixCount === 2 && g.totalMs === 9000 + 3200 + 3200 + 8000, String(g.totalMs));
  const afterItem = withoutToeicRecItem(v, "new", { kind: "fix", q: 5, fixIndex: 0 });
  add("항목 하나 지운 뒤: 그 항목만 빠지고 합계 다시 셈(다른 자리 고칠 문장 남음)", afterItem.groups[0].fixCount === 1 && afterItem.groups[0].items.some((i) => i.kind === "fix" && i.fixIndex === 1));
  const lastOut = withoutToeicRecItem(v, "old", { kind: "answer", q: 5 });
  add("항목이 0이 되면 묶음도 빠진다 · 응시 통째 지운 뒤 그 묶음이 빠진다", !lastOut.groups.some((x) => x.attemptId === "old") && !withoutToeicRecGroup(v, "new").groups.some((x) => x.attemptId === "new"));
  const fixOnly = buildToeicRecManageView([summary("f", "2026-10-02T01:00:00.000Z", { fixRecordings: [{ ...fixRec(5, 0, T), objectKey: toeicFixRecObjectKey("f", 5, 0, T) }] })], []);
  add("답변 녹음을 지우고 고칠 문장 녹음만 남은 응시도 묶음으로 보인다", fixOnly.groups.length === 1 && fixOnly.groups[0].answerCount === 0 && fixOnly.groups[0].fixCount === 1);
  return results;
}

// ---------------------------------------------------------------------------
// ⑩ 소스 대조 · ⑪ 마이크 점검 회귀
// ---------------------------------------------------------------------------

function fnBody(src: string, head: RegExp): string {
  const m = head.exec(src);
  if (!m) return "";
  return src.slice(m.index, m.index + 4000);
}

function runSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ⑩ 소스 대조");
  const helper = codeOnly(read("lib/toeic-rec-delete.ts"));
  add("지우기 한 벌: 보관소 지우기(deleteRecordingPrefixes) → **그다음** 메타 정리(deleteToeicAttemptRecordingMeta)", helper.indexOf("deleteRecordingPrefixes(") > 0 && helper.indexOf("deleteRecordingPrefixes(") < helper.indexOf("deleteToeicAttemptRecordingMeta("));
  add("지우기 한 벌: prod-guard면 403 prod_guard · 그 밖 실패 500 delete_failed retriable", /isProdGuardError\(err\)[\s\S]{0,120}status: 403/.test(helper) && /error: "delete_failed"[^}]*retriable: true/.test(helper));
  const qRoute = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/route.ts"));
  const fixRoute = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/fixes/[i]/route.ts"));
  const allRoute = codeOnly(read("app/api/toeic/attempts/[id]/recordings/route.ts"));
  add(
    "세 DELETE 라우트가 모두 같은 한 벌(deleteToeicRecordingTarget)을 부른다 — 답변 {kind:answer} · 고칠 문장 {kind:fix} · 통째 {kind:attempt}",
    /export async function DELETE[\s\S]*deleteToeicRecordingTarget\(id, \{ kind: "answer", q \}\)/.test(qRoute) &&
      /export async function DELETE[\s\S]*deleteToeicRecordingTarget\(id, \{ kind: "fix", q, fixIndex \}\)/.test(fixRoute) &&
      /deleteToeicRecordingTarget\(id, \{ kind: "attempt" \}\)/.test(allRoute),
  );
  const putFix = fixRoute.slice(fixRoute.indexOf("export async function PUT"), fixRoute.indexOf("export async function GET"));
  add("고칠 문장 PUT: 판정(쓰기 전) → 객체 put → 메타(setToeicAttemptFixRecording) → **커밋 뒤** 옛 객체 지우기", putFix.indexOf("decideToeicFixRecordingUpload(") > 0 && putFix.indexOf("decideToeicFixRecordingUpload(") < putFix.indexOf(".put(objectKey") && putFix.indexOf(".put(objectKey") < putFix.indexOf("setToeicAttemptFixRecording(") && putFix.indexOf("setToeicAttemptFixRecording(") < putFix.indexOf("dropObject(res.replaced.objectKey"));
  add("고칠 문장 PUT: sha256 서버 계산 · better는 피드백에서(toeicFixBetterOf — 클라이언트 값 없음)", /createHash\("sha256"\)\.update\(bytes\)/.test(putFix) && /toeicFixBetterOf\(attempt, q, fixIndex\)/.test(putFix) && !/form\.get\([^)]*(better|sha)/i.test(putFix));
  const getFix = fixRoute.slice(fixRoute.indexOf("export async function GET"));
  add("고칠 문장 GET: private, no-store · nosniff · inline · content-type = 메타 mimeType", /"cache-control": "private, no-store"/.test(getFix) && /"x-content-type-options": "nosniff"/.test(getFix) && /"content-disposition": "inline"/.test(getFix) && /"content-type": meta\.mimeType/.test(getFix));
  add("새 라우트·지우기 한 벌에 OpenAI 키 검사·AI 호출 없음(AI 0)", ![fixRoute, allRoute, helper].some((src) => /OPENAI_API_KEY|lib\/ai\//.test(src)));
  const blob = codeOnly(read("lib/toeic-rec-blob.ts"));
  const gcs = blob.slice(blob.indexOf("class GcsRecBlobStore"));
  const gp = /async deletePrefix\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(gcs)?.[1] ?? "";
  const gk = /async deleteKey\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(gcs)?.[1] ?? "";
  add("GCS deletePrefix·deleteKey가 assertDestructiveAllowed(\"deleteToeicRecordings\")를 먼저 부른다", /^\s*assertDestructiveAllowed\("deleteToeicRecordings"\);/.test(gp) && /^\s*assertDestructiveAllowed\("deleteToeicRecordings"\);/.test(gk));
  const fsStore = codeOnly(read("lib/store-firestore.ts"));
  const fsDel = /async deleteToeicAttemptRecordingMeta\([\s\S]*?\n {2}\}/.exec(fsStore)?.[0] ?? "";
  add("Firestore 메타 정리가 prod-guard(deleteToeicRecordings) → runTransaction 안에서 applyToeicRecordingDeletion · answers는 쓰지 않음", fsDel.indexOf('assertDestructiveAllowed("deleteToeicRecordings")') >= 0 && fsDel.indexOf('assertDestructiveAllowed("deleteToeicRecordings")') < fsDel.indexOf("runTransaction") && /applyToeicRecordingDeletion(All)?\(current, target, deletedAt\)/.test(fsDel) && !/answers:/.test(/tx\.update\(ref, \{[^}]*\}/.exec(fsDel)?.[0] ?? "answers:"));
  const fsFix = /async setToeicAttemptFixRecording\([\s\S]*?\n {2}\}/.exec(fsStore)?.[0] ?? "";
  add("Firestore 고칠 문장 저장: 트랜잭션 안에서 판정 · fixRecordings 필드만 바꾼다", /runTransaction[\s\S]*decideToeicFixRecordingUpload\(/.test(fsFix) && /tx\.update\(ref, \{ fixRecordings: next\.fixRecordings \}\)/.test(fsFix));
  const view = read("components/toeic-attempt-view.tsx");
  const list = read("components/toeic-recordings-view.tsx");
  add("화면 둘: 녹음 API 주소를 src=로 넣는 곳이 없다(fetch → Blob → objectURL)", [view, list].every((src) => !/src=\{?[^}\n]*(toeicRecordingHref|toeicAttemptRecordingsHref|\/recordings\/)/.test(src)) && /fetch\(toeicRecordingHref\(/.test(list));
  const delView = fnBody(view, /async function deleteRecording\(/);
  add("결과 화면 지우기: 확인 창 → 서버 DELETE → **그다음** 이 기기 사본(deleteToeicRecordingsLocal) · 서버 실패면 return(기기 사본 그대로)", /window\.confirm\(/.test(delView) && delView.indexOf('{ method: "DELETE" }') > 0 && delView.indexOf('{ method: "DELETE" }') < delView.indexOf("deleteToeicRecordingsLocal(") && /if \(!data\?\.ok\) \{[\s\S]{0,200}return;/.test(delView));
  const delItem = fnBody(list, /async function deleteItem\(/);
  const delGroup = fnBody(list, /async function deleteGroup\(/);
  add("목록 지우기(하나·통째): 확인 창 → 서버 먼저 → 실패면 return → 이 기기 사본", [delItem, delGroup].every((b) => /window\.confirm\(/.test(b) && b.indexOf("serverDelete(") > 0 && b.indexOf("serverDelete(") < b.indexOf("deleteToeicRecordingsLocal(") && /if \(!r\.ok && !r\.gone\) \{[\s\S]{0,160}return;/.test(b)));
  add("결과 화면·목록: 지운 자리가 덮는 이 기기 사본은 열 때 지운다", /isToeicRecordingTombstoned\(deletionsRef\.current, r\.q, null, r\.createdAt\)/.test(view) && /for \(const p of v\.purgeLocal\) void deleteToeicRecordingsLocal/.test(list));
  const rec = codeOnly(read("components/use-toeic-fix-recorder.ts"));
  // 2026-10-03(§15-13): 정책은 기기 설정과 상관없이 toeicFixRecMicPolicy — createMicKeeper({ policy }) 하나
  add("고칠 문장 녹음기: 마이크는 createMicKeeper 하나(맨 startRecording·getUserMedia·audioSession 직접 호출 없음)", /createMicKeeper\(\{ policy: toeicFixRecMicPolicy\(detectMicKeepEnv\(\)\) \}\)/.test(rec) && !/(^|[^.\w])startRecording\(/.test(rec) && !/getUserMedia|audioSession/.test(rec) && /keeper\(\)\.startRecording\(/.test(rec));
  add("고칠 문장 녹음기: 숨김·pagehide·언마운트에 놓는다(release) · 시작 전 재생 멈춤(stopPlayback) · 자동 멈춤 30초", /visibilityState === "hidden"\) release\(\)/.test(rec) && /addEventListener\("pagehide", onPageHide\)/.test(rec) && /return \(\) => \{[\s\S]{0,200}release\(\);/.test(rec) && /stopPlayback\(\);[\s\S]{0,200}keeper\(\)\.startRecording/.test(rec) && /TOEIC_FIX_REC_LIMIT_MS\)/.test(rec));
  add("고칠 문장 녹음기: 기기 보관소(IndexedDB)·keepalive를 쓰지 않는다 · AI 0", !/toeic-rec-store|keepalive|\/api\/toeic\/attempts\/[^`]*\/score|lib\/ai\//.test(rec));
  for (const f of ["lib/toeic-rec-manage.ts", "components/use-toeic-fix-recorder.ts", "components/toeic-recordings-view.tsx"]) {
    const paths = runtimeImportPaths(read(f));
    const bad = paths.filter((p) => /firebase-admin|(^|\/)store$|lib\/store$|\/store-|\/ai\/|^openai$|^zod$|node:|toeic-rec-blob|toeic-rec-delete/.test(p));
    add(`번들 경계: ${f} — 서버 모듈 값 import 없음`, bad.length === 0, bad.join(", ") || paths.join(", "));
  }
  const hub = read("app/toeic/page.tsx");
  add("허브: 🎙️ 내 녹음 카드 → /toeic/recordings", /href="\/toeic\/recordings"/.test(hub) && /내 녹음/.test(hub));
  add("내 녹음 페이지: force-dynamic · 요약만 넘김(피드백 본문·전사문 없음)", /export const dynamic = "force-dynamic"/.test(read("app/toeic/recordings/page.tsx")) && !/transcript|feedback/.test(codeOnly(read("app/toeic/recordings/page.tsx")).replace(/\/\/.*$/gm, "")));
  const qPut = qRoute.slice(qRoute.indexOf("export async function PUT"), qRoute.indexOf("export async function GET"));
  add("답변 PUT: 지운 자리 → 409 recording_deleted(쓰기 전·원자 단위 안 두 곳) · PUT 본문에 지우기 동작 없음", (qPut.match(/error: "recording_deleted"/g) ?? []).length === 2 && !/deleteAttempt|\.delete\(|deleteRecording/.test(qPut));
  return results;
}

function runMicCheckRegression(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "녹음관리 ⑪ 마이크 점검");
  const take = codeOnly(read("components/toeic-take-view.tsx"));
  const body = fnBody(take, /async function checkMic\(\)/);
  add(
    "점검 녹음이 버려지면(result null — 점검 중 숨김·설정 바꿈) ✓ 대신 stopped(다시 점검) — done은 결과가 있을 때만(QA mic-keep P3-2)",
    /if \(result === null\) \{[\s\S]{0,300}setMicCheck\(\{ phase: "stopped" \}\);[\s\S]{0,40}return;/.test(body) && body.indexOf('phase: "stopped"') < body.indexOf('phase: "done"') && !/result\?\.mimeType/.test(body),
  );
  add("시작 버튼은 done일 때만(stopped는 다시 점검해야 녹음 응시)", /const canStart = mode === "nomic" \|\| micCheck\.phase === "done";/.test(take));
  return results;
}

export function runToeicRecManageChecks(): GuideCheckResult[] {
  return [
    ...runKeyChecks(),
    ...runFixContractChecks(),
    ...runDecisionChecks(),
    ...runApplyChecks(),
    ...runFileBackendChecks(),
    ...runManageViewChecks(),
    ...runSourceChecks(),
    ...runMicCheckRegression(),
  ];
}

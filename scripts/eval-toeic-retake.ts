/**
 * scripts/eval-toeic-retake.ts — **문항 단위 다시 풀기 + 마이크 유지 대책(F1~F3) + 고칠 문장 녹음 마이크 고정** 오프라인 검증
 * (docs/harness/toeic.md §15-14) — scripts/eval-toeic.ts가 부른다.
 *
 * 17묶음: ① 시작 판정 ② 합치기 ③ 업로드 세대 판정(§13-4 표와 무작위 대조 포함) ④ 채점 경합(세대) ⑤ 추정 재계산 ⑥ 지울 계획·적용 ⑦ 정규화
 * ⑧ 비교 행 ⑨ 이 기기 사본 쓰임새 ⑩ 오류 문항 사유 ⑪ 스트릭 ⑫ 파일 백엔드 자식 프로세스(시작 → 대기 업로드 → 끝·합침 → 늦은 업로드 →
 * 예전 답 GET·지우기 → 통째 · 동시 두 시작 · 채점 경합) ⑬ F1 무음 판정·알림·문제 횟수 ⑭ F2 진단 zod·저장 ⑮ F3 상태 기계·게이트·실패 분기
 * ⑯ 고칠 문장 녹음 정책 ⑰ 소스 대조.
 *
 * 네트워크·GCS를 부르지 않는다. 스토어·보관소를 실제로 돌리는 묶음(⑫)은 eval-toeic-rec-manage와 같은 방식 — 임시 폴더를 cwd로 한 **자식 프로세스**,
 * `STORE_BACKEND=file`·GCP env 비움·`TOEIC_REC_DIR`=임시 폴더. 문장 픽스처는 지어낸 영어다(교재 문장 0).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToeicAnswer } from "../lib/ai/toeic/schemas";
import { applyAttemptFinish, type ToeicAttemptRecord } from "../lib/store";
import { isToeicAttemptClosed } from "../lib/toeic-attempt-rules";
import { toeicFinishBodySchema, finishAnswerIssues, finishBodyDiags } from "../lib/toeic-finish-body";
import { micKeepPolicyFor, toeicFixRecMicPolicy } from "../lib/mic-session";
import {
  TOEIC_MIC_CHECK_OK_LEVEL,
  TOEIC_MIC_TROUBLE_MAX,
  TOEIC_SILENCE_ALERT_MS,
  TOEIC_SILENCE_MIN_SAMPLES,
  TOEIC_SILENT_PEAK_LEVEL,
  initialToeicLevelTrack,
  normalizeToeicAnswerDiags,
  stepToeicLevelTrack,
  toToeicAnswerDiag,
  toeicAnswerDiagLineKo,
  toeicMicFailureAction,
  toeicMicGate,
  toeicMicPromptReducer,
  toeicMicTroubleAction,
  toeicSilenceAlertOn,
  toeicSilenceVerdict,
  type ToeicAnswerDiag,
  type ToeicMicPromptState,
} from "../lib/toeic-mic-health";
import { normalizeToeicAttemptRecord } from "../lib/toeic-normalize";
import { decideToeicRecordingUpload, toeicRecDeletionPrefixes, toeicRecObjectKey, type ToeicStoredFixRecording, type ToeicStoredRecording } from "../lib/toeic-rec-rules";
import {
  TOEIC_RETAKE_HISTORY_MAX,
  TOEIC_RETAKE_STALE_MS,
  applyToeicAnswerUpload,
  applyToeicRecordingDeletionAll,
  applyToeicRetakeFinish,
  applyToeicRetakeStart,
  decideToeicAnswerUpload,
  decideToeicRetakeStart,
  newToeicRetakeSession,
  parseToeicRetakeQuestions,
  toToeicCompareHistory,
  toeicAnswerRecordingDeleted,
  toeicAnswerSourceOf,
  toeicDeletedHistoryLocalCopies,
  toeicOtherAttemptLocalCopies,
  toeicErrorQuestions,
  toeicRetakeFinishOutcome,
  toeicLocalCopyRole,
  toeicRecDeletionPlan,
  toeicRetakeEstimates,
  toeicRetakeHref,
  type ToeicRetakeAttemptLike,
} from "../lib/toeic-retake";
import { toToeicCompareAttempt, toeicQuestionHistory, toeicScoreDelta } from "../lib/toeic-compare";
import { buildToeicRecManageView, type ToeicRecAttemptSummary } from "../lib/toeic-rec-manage";
import { toeicStreakSessions } from "../lib/toeic-streak";
import { computeStreak } from "../lib/streak";
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
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) if (!m[1]) out.push(m[3]);
  return out;
}

const T = 1759450000000;
const ISO = (ms: number) => new Date(ms).toISOString();
const AID = "att-retake-1";

function ans(q: number, over: Partial<ToeicAnswer> = {}): ToeicAnswer {
  return { q, recorded: true, durationMs: 20000, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null, ...over };
}
function rec(q: number, ms: number, sha = "a".repeat(64)): ToeicStoredRecording {
  return { q, objectKey: toeicRecObjectKey(AID, q, ms), mimeType: "audio/mp4", size: 1000, sha256: sha, durationMs: 20000, recordedAt: ISO(ms), uploadedAt: ISO(ms + 1) };
}
function fixRec(q: number, i: number, ms: number): ToeicStoredFixRecording {
  return { q, fixIndex: i, better: "It makes me happy.", objectKey: `attempts/${AID}/fixes/${q}/${i}/${ms}`, mimeType: "audio/mp4", size: 300, sha256: "f".repeat(64), durationMs: 3000, recordedAt: ISO(ms), uploadedAt: ISO(ms + 1) };
}
function diag(q: number, over: Partial<ToeicAnswerDiag> = {}): ToeicAnswerDiag {
  return { q, status: "recorded", policy: "keep", opens: 1, remuted: 0, error: null, peak: 0.8, size: 1000, durationMs: 20000, silent: false, ...over };
}
type A = ToeicRetakeAttemptLike & { id: string; startedAt: string };
function attempt(over: Partial<A> = {}): A {
  return {
    id: AID,
    startedAt: ISO(T),
    questions: [3, 4, 5],
    finishedAt: ISO(T + 600_000),
    answers: [ans(3, { transcript: "Some people walk.", score: 2 }), ans(4, { recorded: false, durationMs: null }), ans(5)],
    recordings: [rec(3, T + 100), rec(5, T + 300)],
    fixRecordings: [fixRec(3, 0, T + 900_000)],
    recordingDeletions: [],
    retakes: [],
    answerHistory: [],
    answerDiags: [diag(3), diag(4, { status: "failed", error: "마이크 응답이 없어요", peak: null, size: null, durationMs: null, opens: 2 }), diag(5)],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ① 시작 판정
// ---------------------------------------------------------------------------

function runStartChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ① 시작 판정");
  const a = attempt();
  const now = T + 3_600_000;
  add("문항 없음·중복·정수 아님 → invalid", decideToeicRetakeStart(a, [], now).kind === "invalid" && decideToeicRetakeStart(a, [3, 3], now).kind === "invalid" && decideToeicRetakeStart(a, [3.5], now).kind === "invalid");
  const qnf = decideToeicRetakeStart(a, [3, 9], now);
  add("응시 범위 밖 → question_not_found(그 문항)", qnf.kind === "question_not_found" && eqJson(qnf.questions, [9]));
  add("아직 닫히지 않은 응시 → not_finished", decideToeicRetakeStart(attempt({ finishedAt: null, answers: [] }), [3], now).kind === "not_finished");
  add("그만둔 응시(finishedAt null + answers 있음)도 닫힘 → start", decideToeicRetakeStart(attempt({ finishedAt: null }), [3], now).kind === "start");
  const open = newToeicRetakeSession("r-open", [4], ISO(now - 60_000));
  const busy = attempt({ retakes: [open] });
  const ip = decideToeicRetakeStart(busy, [3], now);
  add("진행 중 기록(2시간 안) → in_progress + openRetake", ip.kind === "in_progress" && ip.open.id === "r-open" && eqJson(ip.open.questions, [4]));
  add("replaceOpen이 다른 id면 여전히 in_progress", decideToeicRetakeStart(busy, [3], now, "r-other").kind === "in_progress");
  const rep = decideToeicRetakeStart(busy, [3], now, "r-open");
  add("replaceOpen = 그 id → start + 그 기록을 먼저 닫는다", rep.kind === "start" && eqJson(rep.close, ["r-open"]));
  const stale = attempt({ retakes: [newToeicRetakeSession("r-stale", [4], ISO(now - TOEIC_RETAKE_STALE_MS))] });
  const st = decideToeicRetakeStart(stale, [3], now);
  add("오래된 진행 기록(≥ 2시간) → start + 자동으로 닫는다", st.kind === "start" && eqJson(st.close, ["r-stale"]));
  const full = attempt({
    answerHistory: Array.from({ length: TOEIC_RETAKE_HISTORY_MAX }, (_, i) => ({
      q: 3,
      replacedBy: `r${i}`,
      replacedAt: ISO(T + 1000 + i),
      answer: ans(3),
      recording: null,
      fixRecordings: [],
      diag: null,
      recordingDeletedAt: null,
    })),
  });
  const hf = decideToeicRetakeStart(full, [3, 4], now);
  add(`같은 문항 이력 ${TOEIC_RETAKE_HISTORY_MAX}줄 → history_full(조용히 버리지 않는다)`, hf.kind === "history_full" && eqJson(hf.questions, [3]));
  add("정상 → start(닫을 것 없음)", eqJson(decideToeicRetakeStart(a, [4, 3], now), { kind: "start", close: [] }));
  // 적용: 오래된 기록의 대기 녹음은 닫으며 합친다
  const staged = { ...newToeicRetakeSession("r-stale", [4], ISO(now - TOEIC_RETAKE_STALE_MS)), recordings: [rec(4, now - 7_000_000)] };
  const withStaged = attempt({ retakes: [staged] });
  const applied = applyToeicRetakeStart(withStaged, ["r-stale"], newToeicRetakeSession("r-new", [3], ISO(now)), ISO(now));
  const closed = applied.retakes.find((r) => r.id === "r-stale");
  add(
    "시작 적용: 닫은 기록의 대기 녹음 문항(Q4)은 그 녹음 길이로 합침 · 새 기록 진행 중 · 진행 중 하나",
    closed?.closedAt === ISO(now) && eqJson(closed?.merged, [4]) && applied.answers.find((x) => x.q === 4)?.recorded === true && applied.retakes.filter((r) => r.closedAt === null).length === 1,
    JSON.stringify(closed),
  );
  add("parseToeicRetakeQuestions: '3,4' → [3,4] · '4,3,3' → [3,4] · '3.5'·'0'·'12'·'' → null", eqJson(parseToeicRetakeQuestions("3,4"), [3, 4]) && eqJson(parseToeicRetakeQuestions("4,3,3"), [3, 4]) && [".5", "3.5", "0", "12", "", "3,"].every((x) => parseToeicRetakeQuestions(x) === null));
  add("toeicRetakeHref: 오름차순 · 점 없는 경로", toeicRetakeHref("a-1", [4, 3]) === "/toeic/attempts/a-1/retake?q=3,4");
  return results;
}

// ---------------------------------------------------------------------------
// ② 합치기
// ---------------------------------------------------------------------------

function runMergeChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ② 합치기");
  const now = T + 3_600_000;
  const session = { ...newToeicRetakeSession("r1", [3, 4], ISO(now)), recordings: [rec(3, now + 60_000, "b".repeat(64))] };
  const a = attempt({ retakes: [session] });
  const lenBefore = a.answers.length;
  const r = applyToeicRetakeFinish(
    a,
    "r1",
    { finishedAt: ISO(now + 120_000), answers: [{ q: 3, recorded: true, durationMs: 29_000 }, { q: 4, recorded: false, durationMs: null }], diags: [diag(3, { peak: 0.02, silent: true, status: "silent" }), diag(4, { status: "failed" })] },
    ISO(now + 121_000),
  );
  const n = r.next;
  add("finished · merged = 녹음된 문항(Q3)만 — 녹음 없는 Q4는 원래 답 그대로", r.outcome === "finished" && eqJson(r.merged, [3]) && eqJson(n.answers.find((x) => x.q === 4), a.answers.find((x) => x.q === 4)));
  add("answers 길이·순서 불변 · finishedAt 불변 · 닫힘 판정 불변(끝내기 409 규칙과 충돌 없음)", n.answers.length === lenBefore && eqJson(n.answers.map((x) => x.q), [3, 4, 5]) && n.finishedAt === a.finishedAt && isToeicAttemptClosed(n));
  const h = n.answerHistory.find((x) => x.q === 3);
  add(
    "이력 줄: 예전 답(점수·전사)·예전 녹음 메타·그 답의 고칠 문장 녹음·예전 진단 · replacedBy/replacedAt",
    !!h && h.answer.score === 2 && h.answer.transcript === "Some people walk." && h.recording?.objectKey === rec(3, T + 100).objectKey && h.fixRecordings.length === 1 && h.diag?.status === "recorded" && h.replacedBy === "r1" && h.replacedAt === ISO(now + 121_000) && h.recordingDeletedAt === null,
    JSON.stringify(h),
  );
  const q3 = n.answers.find((x) => x.q === 3)!;
  add("새 답: recorded·길이(이번 본문) · 전사·피드백·점수 비움(채점 전)", q3.recorded && q3.durationMs === 29_000 && q3.transcript === null && q3.feedback === null && q3.score === null && q3.scoredAt === null);
  add("지금 녹음 메타 = 대기 자리 녹음 · 그 답 고칠 문장 녹음은 지금 자리에서 빠짐 · Q5 메타 그대로", n.recordings.find((x) => x.q === 3)?.sha256 === "b".repeat(64) && n.fixRecordings.length === 0 && n.recordings.some((x) => x.q === 5));
  add("진단: Q3은 이번 진단(무음)으로 · Q4(합치지 않음)는 예전 진단 그대로", n.answerDiags.find((d) => d.q === 3)?.silent === true && n.answerDiags.find((d) => d.q === 4)?.opens === 2);
  const s1 = n.retakes.find((x) => x.id === "r1")!;
  add("기록 닫힘: closedAt·finishedAt·merged·대기 자리 비움·이번 진단", s1.closedAt === ISO(now + 121_000) && s1.finishedAt === ISO(now + 120_000) && eqJson(s1.merged, [3]) && s1.recordings.length === 0 && s1.diags.length === 2);
  add("지금 세대 = r1(이력 마지막 줄) · Q4·Q5는 null", toeicAnswerSourceOf(n, 3) === "r1" && toeicAnswerSourceOf(n, 4) === null && toeicAnswerSourceOf(n, 5) === null);
  const again = applyToeicRetakeFinish(n, "r1", { finishedAt: null, answers: [{ q: 4, recorded: true, durationMs: 1000 }] }, ISO(now + 200_000));
  add("한 번만 — 다시 끝내기 → already_closed · 쓰지 않음(merged는 저장값)", again.outcome === "already_closed" && again.next === n && eqJson(again.merged, [3]));
  add("없는 기록 → retake_not_found", applyToeicRetakeFinish(n, "nope", { finishedAt: null, answers: [] }, ISO(now)).outcome === "retake_not_found");
  // 그만둠·대기 녹음만(본문 recorded false) → 대기 녹음 길이로 합친다
  const s2 = { ...newToeicRetakeSession("r2", [4], ISO(now)), recordings: [{ ...rec(4, now + 5000), durationMs: 17_000 }] };
  const quit = applyToeicRetakeFinish(attempt({ retakes: [s2] }), "r2", { finishedAt: null, answers: [{ q: 4, recorded: false, durationMs: null }] }, ISO(now + 9000));
  add("그만둠(finishedAt null) + 대기 자리에 녹음 → 그 녹음 길이로 합침(목소리를 잃지 않는다)", eqJson(quit.merged, [4]) && quit.next.answers.find((x) => x.q === 4)?.durationMs === 17_000 && quit.next.retakes[0].finishedAt === null);
  // 두 번째 다시 풀기 — 이력이 쌓이고 세대가 이어진다
  const s3 = newToeicRetakeSession("r3", [3], ISO(now + 300_000));
  const second = applyToeicRetakeFinish({ ...n, retakes: [...n.retakes, s3] }, "r3", { finishedAt: ISO(now + 330_000), answers: [{ q: 3, recorded: true, durationMs: 25_000 }] }, ISO(now + 331_000));
  const rows3 = second.next.answerHistory.filter((x) => x.q === 3);
  add("두 번째 다시 풀기: 이력 2줄(시간순) · 둘째 줄 = r1 세대의 답(채점 전) · 지금 세대 r3", rows3.length === 2 && rows3[0].replacedBy === "r1" && rows3[1].replacedBy === "r3" && rows3[1].answer.durationMs === 29_000 && toeicAnswerSourceOf(second.next, 3) === "r3");
  return results;
}

// ---------------------------------------------------------------------------
// ③ 업로드 세대 판정
// ---------------------------------------------------------------------------

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runUploadChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ③ 업로드 세대");
  // (가) 이력 없음 + gen null → §13-4 표와 같다(무작위 300회)
  const rnd = mulberry(20261003);
  let mismatch = 0;
  let firstBad = "";
  for (let i = 0; i < 300; i++) {
    const q = [3, 4, 5, 9][Math.floor(rnd() * 4)];
    const hasMeta = rnd() < 0.6;
    const transcribed = rnd() < 0.4;
    const tomb = rnd() < 0.15;
    const a = attempt({
      recordings: hasMeta ? [rec(3, T + 1000, "c".repeat(64)), rec(5, T + 1000, "c".repeat(64))] : [],
      answers: [ans(3, { transcript: transcribed ? "x y z" : null }), ans(4), ans(5, { transcript: transcribed ? "x y" : null })],
      recordingDeletions: tomb ? [{ q: 3, fixIndex: null, deletedAt: ISO(T + 1500) }] : [],
    });
    const inc = { sha256: rnd() < 0.3 ? "c".repeat(64) : "d".repeat(64), recordedAtMs: T + Math.floor(rnd() * 3000) };
    const base = decideToeicRecordingUpload(a, q, inc);
    const d = decideToeicAnswerUpload(a, q, null, inc);
    const mapped = d.kind === "store" ? "store" : d.kind;
    if (mapped !== base) {
      mismatch += 1;
      if (!firstBad) firstBad = `${q} ${base} vs ${d.kind}`;
    }
  }
  add("이력 없음 + 세대 null → §13-4 표(decideToeicRecordingUpload)와 같은 결과(무작위 300회)", mismatch === 0, firstBad);
  const now = T + 3_600_000;
  const open = { ...newToeicRetakeSession("r1", [3], ISO(now)), recordings: [] as ToeicStoredRecording[] };
  const a = attempt({ retakes: [open] });
  const inc = (ms: number, sha = "e".repeat(64)) => ({ sha256: sha, recordedAtMs: ms });
  add("진행 중 다시 풀기 + 대기 자리 없음 → store_staged(지금 자리는 그대로)", decideToeicAnswerUpload(a, 3, "r1", inc(now + 10)).kind === "store_staged");
  const st = applyToeicAnswerUpload(a, "r1", decideToeicAnswerUpload(a, 3, "r1", inc(now + 10)), rec(3, now + 10, "e".repeat(64)));
  add("store_staged 적용: 대기 자리에 메타 · 지금 녹음 메타·answers 불변", st.retakes[0].recordings.length === 1 && eqJson(st.recordings, a.recordings) && eqJson(st.answers, a.answers));
  const r1 = decideToeicAnswerUpload(st, 3, "r1", inc(now + 10));
  add("대기 자리 같은 sha → reused(slot staged) · 이른 다른 바이트 → superseded · 더 새것 → store_staged(잠그지 않는다)", r1.kind === "reused" && r1.slot === "staged" && decideToeicAnswerUpload(st, 3, "r1", inc(now + 5, "1".repeat(64))).kind === "superseded" && decideToeicAnswerUpload(st, 3, "r1", inc(now + 20, "1".repeat(64))).kind === "store_staged");
  add("없는 다시 풀기 → retake_not_found · 그 다시 풀기 문항이 아님 → question_not_found", decideToeicAnswerUpload(a, 3, "nope", inc(now)).kind === "retake_not_found" && decideToeicAnswerUpload(a, 5, "r1", inc(now)).kind === "question_not_found");
  add("지운 자리가 덮으면 세대와 무관하게 deleted", decideToeicAnswerUpload(attempt({ retakes: [open], recordingDeletions: [{ q: null, fixIndex: null, deletedAt: ISO(now + 100) }] }), 3, "r1", inc(now + 10)).kind === "deleted");
  // 진행 중일 때 처음 응시의 늦은 업로드 → 지금 자리(§13-4 표) — 원래 답은 아직 지금 답이다
  add("진행 중 + 처음 응시(gen null) 늦은 업로드 → 지금 자리 표(메타 있음·전사됨 → locked)", decideToeicAnswerUpload(a, 3, null, inc(T + 200)).kind === "locked");
  // 합친 뒤
  const merged = applyToeicRetakeFinish(st, "r1", { finishedAt: ISO(now + 50), answers: [{ q: 3, recorded: true, durationMs: 29_000 }] }, ISO(now + 60)).next;
  add("합친 뒤 r1 녹음 다시 올림(같은 sha) → reused(slot current — 지금 메타)", (() => {
    const d = decideToeicAnswerUpload(merged, 3, "r1", inc(now + 10));
    return d.kind === "reused" && d.slot === "current";
  })());
  // 대기 자리 없이 합친 경우(업로드가 끝보다 늦다) → 지금 자리 store
  const s2 = newToeicRetakeSession("r2", [5], ISO(now));
  const m2 = applyToeicRetakeFinish(attempt({ retakes: [s2] }), "r2", { finishedAt: ISO(now + 50), answers: [{ q: 5, recorded: true, durationMs: 10_000 }] }, ISO(now + 60)).next;
  const late = decideToeicAnswerUpload(m2, 5, "r2", inc(now + 20));
  add("끝보다 늦게 온 다시 풀기 녹음 → 지금 자리 store(합친 문항, 세대 = 지금)", late.kind === "store" && m2.recordings.every((r) => r.q !== 5));
  const m2s = applyToeicAnswerUpload(m2, "r2", late, rec(5, now + 20, "9".repeat(64)));
  add("store 적용 → recordings에 그 문항 메타", m2s.recordings.find((r) => r.q === 5)?.sha256 === "9".repeat(64));
  // 예전 세대(처음 응시) 녹음 — 이력 줄에 녹음이 없고 그 답이 recorded면 store_history
  const noRecHistory = applyToeicRetakeFinish(attempt({ recordings: [rec(3, T + 100)], retakes: [s2] }), "r2", { finishedAt: null, answers: [{ q: 5, recorded: true, durationMs: 9000 }] }, ISO(now + 60)).next;
  const old5 = decideToeicAnswerUpload(noRecHistory, 5, null, inc(T + 300, "7".repeat(64)));
  add("예전 세대 녹음 + 이력 줄 녹음 없음 + recorded → store_history(다른 기기의 늦은 예전 녹음을 이력에)", old5.kind === "store_history");
  const hs = applyToeicAnswerUpload(noRecHistory, null, old5, rec(5, T + 300, "7".repeat(64)));
  add("store_history 적용: 그 이력 줄에 메타 · 지금 녹음은 그대로", hs.answerHistory.find((h) => h.q === 5)?.recording?.sha256 === "7".repeat(64) && eqJson(hs.recordings, noRecHistory.recordings));
  add("이력 줄 녹음 같은 sha → reused(slot history) · 다른 바이트 → retaken(저장 안 함)", (() => {
    const r = decideToeicAnswerUpload(hs, 5, null, inc(T + 300, "7".repeat(64)));
    return r.kind === "reused" && r.slot === "history" && decideToeicAnswerUpload(hs, 5, null, inc(T + 301, "8".repeat(64))).kind === "retaken";
  })());
  add("예전 답 녹음을 지운 줄 → 늦게 와도 retaken(되살아나지 않음)", decideToeicAnswerUpload(applyToeicRecordingDeletionAll(hs, { kind: "history", q: 5, replacedBy: "r2" }, ISO(now + 99)).next, 5, null, inc(T + 300, "7".repeat(64))).kind === "retaken");
  // 닫혔는데 합치지 않은 문항의 녹음 → retaken
  const s4 = newToeicRetakeSession("r4", [4], ISO(now));
  const notMerged = applyToeicRetakeFinish(attempt({ retakes: [s4] }), "r4", { finishedAt: null, answers: [{ q: 4, recorded: false, durationMs: null }] }, ISO(now + 1)).next;
  add("닫혔는데 합치지 않은 문항의 녹음 → retaken", decideToeicAnswerUpload(notMerged, 4, "r4", inc(now + 0)).kind === "retaken");
  return results;
}

// ---------------------------------------------------------------------------
// ⑤ 추정 재계산 · ⑥ 지우기 · ⑦ 정규화
// ---------------------------------------------------------------------------

function full11(scoreOf: (q: number) => number | null): ToeicAnswer[] {
  return Array.from({ length: 11 }, (_, i) => ans(i + 1, { score: scoreOf(i + 1), transcript: "x y z" }));
}

function runEstimateChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑤ 추정 재계산");
  const answers = full11((q) => (q === 11 ? 3 : 2));
  const s = newToeicRetakeSession("r1", [3], ISO(T + 1000));
  const a = attempt({ questions: Array.from({ length: 11 }, (_, i) => i + 1), answers, recordings: [], fixRecordings: [], answerDiags: [], retakes: [s] });
  const merged = applyToeicRetakeFinish(a, "r1", { finishedAt: null, answers: [{ q: 3, recorded: true, durationMs: 20000 }] }, ISO(T + 2000)).next;
  const est1 = toeicRetakeEstimates(merged.answers, merged.answerHistory);
  add("합친 뒤 채점 전: 지금 추정 미완(10/11) · 다시 풀기 전 추정 완성", !!est1 && !est1.now.complete && est1.now.scoredCount === 10 && est1.before.complete, JSON.stringify(est1));
  const scored = { ...merged, answers: merged.answers.map((x) => (x.q === 3 ? { ...x, score: 3, transcript: "a b c" } : x)) };
  const est2 = toeicRetakeEstimates(scored.answers, scored.answerHistory);
  const b2 = est2?.before;
  const n2 = est2?.now;
  add("다시 푼 문항을 채점하면 지금 추정 완성 · 지금 ≥ 전(점수 2 → 3)", !!b2 && !!n2 && b2.complete && n2.complete && n2.raw === b2.raw + 1 && n2.scaled >= b2.scaled, JSON.stringify(est2));
  add("이력이 없으면 null(줄 없음)", toeicRetakeEstimates(answers, []) === null);
  return results;
}

function runDeleteChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑥ 지우기");
  const noHist = attempt();
  add("이력 없음: 답변·고칠 문장·통째 = §14-2 접두사 그대로", eqJson(toeicRecDeletionPlan(AID, noHist, { kind: "answer", q: 3 }), { prefixes: toeicRecDeletionPrefixes(AID, { kind: "answer", q: 3 }), keys: [] }) && eqJson(toeicRecDeletionPlan(AID, noHist, { kind: "fix", q: 3, fixIndex: 0 }).prefixes, toeicRecDeletionPrefixes(AID, { kind: "fix", q: 3, fixIndex: 0 })) && eqJson(toeicRecDeletionPlan(AID, noHist, { kind: "attempt" }).prefixes, [`attempts/${AID}/`]));
  const s = { ...newToeicRetakeSession("r1", [3], ISO(T + 1000)), recordings: [rec(3, T + 2000, "b".repeat(64))] };
  const m = applyToeicRetakeFinish(attempt({ retakes: [s] }), "r1", { finishedAt: null, answers: [{ q: 3, recorded: true, durationMs: 20000 }] }, ISO(T + 3000)).next;
  const p1 = toeicRecDeletionPlan(AID, m, { kind: "answer", q: 3 });
  add("이력 있음: 지금 답 지우기 = 그 메타 키만(접두사 없음 — 예전 답 녹음을 지우지 않게)", p1.prefixes.length === 0 && eqJson(p1.keys, [rec(3, T + 2000).objectKey]));
  const p2 = toeicRecDeletionPlan(AID, m, { kind: "history", q: 3, replacedBy: "r1" });
  add("예전 답 지우기 = 그 줄의 답변 녹음 키 + 고칠 문장 녹음 키", p2.prefixes.length === 0 && eqJson(p2.keys, [rec(3, T + 100).objectKey, fixRec(3, 0, T + 900_000).objectKey]));
  add("없는 예전 답 → 지울 것 없음", eqJson(toeicRecDeletionPlan(AID, m, { kind: "history", q: 3, replacedBy: "nope" }), { prefixes: [], keys: [] }));
  const ah = applyToeicRecordingDeletionAll(m, { kind: "history", q: 3, replacedBy: "r1" }, ISO(T + 9000));
  const row = ah.next.answerHistory.find((h) => h.q === 3)!;
  add("예전 답 지우기 적용: 그 줄 녹음·고칠 문장 비움 + recordingDeletedAt · 답·점수 남음 · 지금 녹음·지운 자리 그대로", row.recording === null && row.fixRecordings.length === 0 && row.recordingDeletedAt === ISO(T + 9000) && row.answer.score === 2 && eqJson(ah.next.recordings, m.recordings) && ah.next.recordingDeletions.length === 0 && ah.removedAnswers.length === 1 && ah.removedFixes.length === 1);
  const cur = applyToeicRecordingDeletionAll(m, { kind: "answer", q: 3 }, ISO(T + 9000));
  add("지금 답 지우기 적용: 지금 메타 빠짐 · 지운 자리(q3) · 이력 녹음은 남음", !cur.next.recordings.some((r) => r.q === 3) && cur.next.recordingDeletions.some((d) => d.q === 3) && cur.next.answerHistory[0].recording !== null);
  const open = { ...newToeicRetakeSession("r9", [5], ISO(T + 9500)), recordings: [rec(5, T + 9600)] };
  const all = applyToeicRecordingDeletionAll({ ...m, retakes: [...m.retakes, open] }, { kind: "attempt" }, ISO(T + 9999));
  add("통째 지우기: 지금·고칠 문장·이력 녹음·대기 자리 메타 모두 비움 · 이력 답은 남음 · 지운 자리 q:null", all.next.recordings.length === 0 && all.next.answerHistory.every((h) => h.recording === null && h.recordingDeletedAt === ISO(T + 9999)) && all.next.retakes.every((r) => r.recordings.length === 0) && all.next.answerHistory[0].answer.score === 2 && all.next.recordingDeletions.some((d) => d.q === null));
  return results;
}

function runNormalizeChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑦ 정규화");
  const old = normalizeToeicAttemptRecord({ id: "x", mockId: "m", scope: "full", parts: ["read"], startedAt: ISO(T), finishedAt: null, answers: [] });
  add("옛 문서(필드 없음) → retakes·answerHistory·answerDiags = []", eqJson([old.retakes, old.answerHistory, old.answerDiags], [[], [], []]));
  const n = normalizeToeicAttemptRecord({
    id: "x",
    mockId: "m",
    scope: "part",
    parts: ["picture"],
    startedAt: ISO(T),
    finishedAt: ISO(T + 1),
    answers: [{ q: 3, recorded: true }],
    retakes: [
      { id: "r1", questions: [3, 3, 99], startedAt: ISO(T + 5), closedAt: null, finishedAt: null, merged: [3, 4], recordings: [{ bad: 1 }], diags: [{ q: 3, status: "silent", opens: 99, silent: true }] },
      { id: "bad.id", questions: [3], startedAt: ISO(T) },
      { id: "r2", questions: [], startedAt: ISO(T) },
      "junk",
    ],
    answerHistory: [
      { q: 3, replacedBy: "r1", replacedAt: ISO(T + 9), answer: { q: 7, recorded: true, score: 2 }, recording: null, fixRecordings: [], diag: { q: 3, status: "nope" }, recordingDeletedAt: null },
      { q: 3, replacedBy: "r1", replacedAt: ISO(T + 9), answer: {} },
      { q: 0, replacedBy: "r1", replacedAt: ISO(T) },
    ],
    answerDiags: [{ q: 3, status: "recorded", peak: 1.7, error: "x".repeat(300) }, { q: 12 }],
  });
  add("깨진 기록 버림(id 모양·문항 0개·객체 아님) · 문항 중복·범위 밖 정리 · merged ⊂ questions", n.retakes.length === 1 && eqJson(n.retakes[0].questions, [3]) && eqJson(n.retakes[0].merged, [3]) && n.retakes[0].recordings.length === 0);
  add("기록 진단 정리: 열기 상한 20 · 무음", n.retakes[0].diags[0]?.opens === 20 && n.retakes[0].diags[0]?.silent === true);
  add("이력: 같은 (q, replacedBy)는 하나 · q 범위 밖 버림 · 답의 q는 줄의 q로 · 진단 상태 모르면 none", n.answerHistory.length === 1 && n.answerHistory[0].answer.q === 3 && n.answerHistory[0].diag?.status === "none");
  add("지금 진단: 최고 레벨 0..1로 · 오류 120자 · q 범위 밖 버림", n.answerDiags.length === 1 && n.answerDiags[0].peak === 1 && n.answerDiags[0].error?.length === 120);
  const round = normalizeToeicAttemptRecord(JSON.parse(JSON.stringify(n)));
  add("왕복(JSON) 같음", eqJson(round, n));
  return results;
}

// ---------------------------------------------------------------------------
// ⑧ 비교 행 · ⑨ 이 기기 사본 · ⑩ 오류 문항 · ⑪ 스트릭
// ---------------------------------------------------------------------------

function runCompareChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑧ 비교 행");
  const s = { ...newToeicRetakeSession("r1", [3], ISO(T + 86_400_000 * 2)), recordings: [rec(3, T + 86_400_000 * 2 + 1000, "b".repeat(64))] };
  const a = applyToeicRetakeFinish(attempt({ retakes: [s] }), "r1", { finishedAt: null, answers: [{ q: 3, recorded: true, durationMs: 20000 }] }, ISO(T + 86_400_000 * 2 + 9000)).next;
  const scored = { ...a, answers: a.answers.map((x) => (x.q === 3 ? { ...x, score: 3, transcript: "a b c" } : x)) };
  const rec0 = { ...scored, scope: "part" as const };
  const cmpThis = toToeicCompareAttempt(rec0);
  // 다른 응시(하루 뒤 — 다시 풀기보다 앞)
  const other = toToeicCompareAttempt({
    id: "att-other",
    startedAt: ISO(T + 86_400_000),
    finishedAt: ISO(T + 86_400_000 + 1),
    scope: "part",
    answers: [{ ...ans(3), score: 1, transcript: "x y" }],
    recordings: [],
  });
  const rows = toeicQuestionHistory([cmpThis, other], AID, 3);
  add(
    "③ 행: 다시 풀기 전(처음 응시) → 다른 응시 → 이번(다시 푼 답) — 세대 시작 시각으로 시간순",
    eqJson(rows.map((r) => (r.isCurrent ? "now" : r.historyOf ? "before" : r.attemptId)), ["before", "att-other", "now"]),
    JSON.stringify(rows.map((r) => [r.key, r.startedAt])),
  );
  add("예전 답 행: historyOf = r1 · 점수 = 예전 점수(2) · 녹음 있음 · key 고유", rows[0].historyOf === "r1" && rows[0].score === 2 && rows[0].hasRecording && new Set(rows.map((r) => r.key)).size === 3);
  const d = toeicScoreDelta(rows);
  add("점수 변화: 이번(3) − 앞선 가장 가까운 채점 행(다른 응시 1)", !!d && d.delta === 2 && d.previous === 1);
  const rowsOnly = toeicQuestionHistory([cmpThis], AID, 3);
  const d2 = toeicScoreDelta(rowsOnly);
  add("다른 응시 없이도 예전 답이 앞선 행 — 3 − 2 = +1", !!d2 && d2.delta === 1 && d2.previous === 2);
  const h = toToeicCompareHistory(rec0);
  add("toToeicCompareHistory: 이력 줄 시작 = 응시 시작 · 지금 답 세대 시작 = r1 시작", h.answerHistory[0].startedAt === ISO(T) && eqJson(h.answerSince, [{ q: 3, startedAt: ISO(T + 86_400_000 * 2) }]));
  add("이력이 없는 문항(Q5) — 기존 행 그대로(지금 답 하나)", toeicQuestionHistory([cmpThis], AID, 5).length === 1);
  return results;
}

function runLocalRoleChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑨ 이 기기 사본");
  const hist = { answerHistory: [{ q: 3, replacedBy: "r1" }, { q: 3, replacedBy: "r2" }] };
  add("이력 없음 + 사본 세대 null(옛 메타) → current", toeicLocalCopyRole({ answerHistory: [] }, 3, null).role === "current" && toeicLocalCopyRole({ answerHistory: [] }, 3, undefined).role === "current");
  add("지금 세대 r2 · 사본 r2 → current", toeicLocalCopyRole(hist, 3, "r2").role === "current");
  const h0 = toeicLocalCopyRole(hist, 3, null);
  const h1 = toeicLocalCopyRole(hist, 3, "r1");
  add("사본 null → 첫 이력 줄(replacedBy r1) · 사본 r1 → 둘째 줄(replacedBy r2)", h0.role === "history" && h0.replacedBy === "r1" && h1.role === "history" && h1.replacedBy === "r2");
  add("모르는 세대 → stale(쓰지 않는다 — 예전 사본으로 새 답을 채점하지 않게)", toeicLocalCopyRole(hist, 3, "r9").role === "stale");
  // 목록: 예전 답 항목·세대별 사본
  const summary: ToeicRecAttemptSummary = {
    id: AID,
    mockId: "m",
    titleKo: "모의고사",
    scopeLabelKo: "실전 응시",
    startedAt: ISO(T),
    questions: [3],
    answers: [{ q: 3, recorded: true, score: null }],
    recordings: [rec(3, T + 5000)],
    fixRecordings: [],
    recordingDeletions: [],
    answerHistory: [{ q: 3, replacedBy: "r1", startedAt: ISO(T), score: 2, recording: rec(3, T + 100), fixCount: 1, recordingDeletedAt: null }],
  };
  const v = buildToeicRecManageView([summary], [{ attemptId: AID, q: 3, durationMs: 1, size: 1, createdAt: T + 5000, upload: "done", retakeId: "r1" }]);
  const items = v.groups[0]?.items ?? [];
  add(
    "내 녹음 목록: 지금 답 항목(사본 = 지금 세대) + '다시 풀기 전 답' 항목(서버 ✓) · 순서 답변 → 예전 답",
    eqJson(items.map((i) => i.kind), ["answer", "history"]) && items[0].kind === "answer" && items[0].local === true && items[1].kind === "history" && items[1].server && items[1].score === 2 && v.groups[0].historyCount === 1,
    JSON.stringify(items),
  );
  const v2 = buildToeicRecManageView([summary], [{ attemptId: AID, q: 3, durationMs: 1, size: 1, createdAt: T + 100, upload: "done", retakeId: null }]);
  const it2 = v2.groups[0]?.items ?? [];
  add("예전 세대 사본(retakeId null)은 지금 답 항목의 '이 기기'가 아니라 예전 답 항목의 '이 기기'", it2[0]?.kind === "answer" && it2[0].local === false && it2[1]?.kind === "history" && it2[1].local === true);
  return results;
}

function runErrorChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑩ 오류 문항");
  const row = (q: number, over: Partial<Parameters<typeof toeicErrorQuestions>[0][number]> = {}) => ({
    q,
    recorded: true,
    score: 2 as number | null,
    transcript: "a b" as string | null,
    diagStatus: "recorded" as ToeicAnswerDiag["status"] | null,
    silent: false,
    deleted: false,
    scoreFailed: false,
    ...over,
  });
  const out = toeicErrorQuestions([
    row(1),
    row(2, { recorded: false, diagStatus: "failed", score: null, transcript: null }),
    row(3, { recorded: false, diagStatus: "interrupted", score: null, transcript: null }),
    row(4, { recorded: true, silent: true, score: null, transcript: null }),
    row(5, { recorded: false, diagStatus: null, score: null, transcript: null }),
    row(6, { deleted: true }),
    row(7, { score: null, transcript: "only transcript" }),
    row(8, { score: null, transcript: null, scoreFailed: true }),
    row(9, { score: null, transcript: null }),
    row(10, { recorded: false, diagStatus: "nomic", score: null, transcript: null }),
  ]);
  add(
    "사유: 녹음 실패·중단됨·소리 없음(무음)·녹음 없음·녹음 지움·채점 실패(전사만·이 화면 실패)·녹음 없이 — 정상·채점 전은 빠진다",
    eqJson(out, [
      { q: 2, reason: "failed" },
      { q: 3, reason: "interrupted" },
      { q: 4, reason: "silent" },
      { q: 5, reason: "no_recording" },
      { q: 6, reason: "deleted" },
      { q: 7, reason: "score_failed" },
      { q: 8, reason: "score_failed" },
      { q: 10, reason: "nomic" },
    ]),
    JSON.stringify(out),
  );
  return results;
}

function runStreakChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑪ 스트릭");
  const TODAY = "2026-10-03";
  const a = {
    startedAt: "2026-10-01T03:00:00.000Z",
    answers: [{ recorded: true }],
    retakes: [
      { startedAt: "2026-10-02T03:00:00.000Z", closedAt: "2026-10-02T03:10:00.000Z", merged: [3] },
      { startedAt: "2026-10-03T03:00:00.000Z", closedAt: "2026-10-03T03:10:00.000Z", merged: [3] },
    ],
  };
  const st = computeStreak(toeicStreakSessions([], [a]), TODAY);
  add("다시 풀기(합친 문항 ≥1)가 그 날짜 세션 — 10/1 응시 + 10/2·10/3 다시 풀기 → 3일 연속", st.current === 3, JSON.stringify(st));
  const none = computeStreak(toeicStreakSessions([], [{ ...a, retakes: [{ startedAt: "2026-10-03T03:00:00.000Z", closedAt: null, merged: [] }, { startedAt: "2026-10-02T03:00:00.000Z", closedAt: "2026-10-02T03:10:00.000Z", merged: [] }] }]), TODAY);
  add("진행 중·합친 문항 0인 다시 풀기는 세지 않는다(10/1만 — 오늘 0)", none.current === 0, JSON.stringify(none));
  add("retakes가 없는 옛 응시 모양은 그대로", computeStreak(toeicStreakSessions([], [{ startedAt: "2026-10-03T03:00:00.000Z", answers: [{ recorded: true }] }]), TODAY).current === 1);
  return results;
}

// ---------------------------------------------------------------------------
// ⑫ 파일 백엔드(자식 프로세스)
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const storeMod = await import(process.env.EVAL_STORE_URL);
const blobMod = await import(process.env.EVAL_BLOB_URL);
const rules = await import(process.env.EVAL_RULES_URL);
const delMod = await import(process.env.EVAL_DELETE_URL);
const fs = await import("node:fs");
const path = await import("node:path");
const out = {};
const st = storeMod.getStore();
const blob = blobMod.getToeicRecBlobStore();
out.backend = blob.backend;
const recDir = blobMod.toeicRecFileDir();
const MP4 = new Uint8Array(64); MP4.set([0,0,0,0x18,0x66,0x74,0x79,0x70,0x4d,0x34,0x41,0x20]);
const T = 1759450000000;
const iso = (ms) => new Date(ms).toISOString();
const parts = { read: null, picture: null, respond: null, info: null, opinion: null };
const m1 = await st.createToeicMock({ targetGrade: "IH", expressionsUsed: [], topicHints: [], model: "x", parts, drillPart: null, titleKo: "모의고사 가" });
const fb = { score: 2, summaryKo: "좋아요", strengths: [], fixes: [{ said: "It make me happy.", better: "It makes me happy.", whyKo: "단수" }], missingKo: [], improvedAnswer: "It makes me happy.", tryExpressions: [] };
const a1 = await st.createToeicAttempt({ mockId: m1.id, scope: "part", parts: ["picture"], questions: [3, 4], startedAt: iso(T), finishedAt: iso(T + 1000),
  answers: [{ q: 3, recorded: true, durationMs: 9000, transcript: "Some people walk.", readDiff: null, feedback: fb, score: 2, scoredAt: iso(T + 2000) },
            { q: 4, recorded: true, durationMs: 9000, transcript: null, readDiff: null, feedback: null, score: null, scoredAt: null }],
  recordings: [], fixRecordings: [], recordingDeletions: [], retakes: [], answerHistory: [], answerDiags: [] });
const meta = (q, t, sha) => ({ q, objectKey: rules.toeicRecObjectKey(a1.id, q, t), mimeType: "audio/mp4", size: 64, sha256: sha, durationMs: 9000, recordedAt: iso(t), uploadedAt: iso(t + 1) });
await blob.put(rules.toeicRecObjectKey(a1.id, 3, T + 10), MP4, "audio/mp4");
out.orig = (await st.setToeicAttemptRecording(a1.id, meta(3, T + 10, "a".repeat(64)))).outcome;
await blob.put(rules.toeicFixRecObjectKey(a1.id, 3, 0, T + 3000), MP4, "audio/mp4");
await st.setToeicAttemptFixRecording(a1.id, { q: 3, fixIndex: 0, better: fb.fixes[0].better, objectKey: rules.toeicFixRecObjectKey(a1.id, 3, 0, T + 3000), mimeType: "audio/mp4", size: 64, sha256: "f".repeat(64), durationMs: 2000, recordedAt: iso(T + 3000), uploadedAt: iso(T + 3001) });
// 동시 두 시작 — 하나만 started
const now = Date.now();
const [s1, s2] = await Promise.all([
  st.startToeicRetake(a1.id, { questions: [3, 4], replaceOpen: null, newId: "rA", nowIso: iso(now) }),
  st.startToeicRetake(a1.id, { questions: [3], replaceOpen: null, newId: "rB", nowIso: iso(now) }),
]);
out.starts = [s1.outcome, s2.outcome].sort();
const rid = s1.outcome === "started" ? s1.session.id : s2.session.id;
out.retakeId = rid;
// 채점 경합 — 읽을 때 세대 null, 합친 뒤 저장 → 던진다
const expectBefore = null;
// 진행 중 업로드 → 대기 자리
await blob.put(rules.toeicRecObjectKey(a1.id, 3, now + 5000), MP4, "audio/mp4");
const up1 = await st.setToeicAttemptRecording(a1.id, { ...meta(3, now + 5000, "b".repeat(64)) }, rid);
out.staged = [up1.outcome, up1.slot];
let cur = await st.getToeicAttempt(a1.id);
out.currentUnchanged = cur.recordings.find((r) => r.q === 3).sha256 === "a".repeat(64) && cur.answers.find((a) => a.q === 3).score === 2;
// 끝 — Q3만 녹음, Q4는 실패
const fin = await st.finishToeicRetake(a1.id, rid, { finishedAt: iso(now + 60000), answers: [{ q: 3, recorded: true, durationMs: 29000 }, { q: 4, recorded: false, durationMs: null }], diags: [{ q: 3, status: "silent", policy: "keep", opens: 1, remuted: 0, error: null, peak: 0.01, size: 64, durationMs: 29000, silent: true }], nowIso: iso(now + 61000) });
out.finish = [fin.outcome, fin.merged];
cur = await st.getToeicAttempt(a1.id);
out.afterMerge = { len: cur.answers.length, q3score: cur.answers.find((a) => a.q === 3).score, q4: cur.answers.find((a) => a.q === 4).recorded, cur3: cur.recordings.find((r) => r.q === 3)?.sha256, hist: cur.answerHistory.length, histRec: cur.answerHistory[0]?.recording?.sha256, histFix: cur.answerHistory[0]?.fixRecordings.length, fix: cur.fixRecordings.length, diag3: cur.answerDiags.find((d) => d.q === 3)?.silent };
out.finishAgain = (await st.finishToeicRetake(a1.id, rid, { finishedAt: null, answers: [], nowIso: iso(now + 99000) })).outcome;
// 채점 경합
try { await st.updateToeicAttemptAnswer(a1.id, 3, { transcript: "old", readDiff: null, feedback: null, score: 1, scoredAt: iso(now) }, expectBefore); out.race = "saved"; } catch (e) { out.race = e && e.name; }
const ok = await st.updateToeicAttemptAnswer(a1.id, 3, { transcript: "new answer here", readDiff: null, feedback: null, score: 3, scoredAt: iso(now) }, rid);
out.raceOk = ok.answers.find((a) => a.q === 3).score;
// 처음 응시 녹음의 늦은 업로드 → 이력 줄에 이미 같은 녹음 → reused(history)
out.lateOrig = (await st.setToeicAttemptRecording(a1.id, meta(3, T + 10, "a".repeat(64)), null)).outcome;
// 예전 답 녹음 GET 경로 = 이력 줄 메타 키로 보관소에서 읽는다
cur = await st.getToeicAttempt(a1.id);
const h = cur.answerHistory[0];
out.histBytes = (await blob.get(h.recording.objectKey))?.length ?? 0;
// 지금 답 지우기 — 이력이 있으니 키만: 예전 답 녹음 객체는 남는다
const delCur = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 3 });
out.delCur = [delCur.status, delCur.body.outcome, delCur.body.removedObjects];
out.histObjKept = fs.existsSync(path.join(recDir, ...h.recording.objectKey.split("/")));
out.curObjGone = !fs.existsSync(path.join(recDir, ...rules.toeicRecObjectKey(a1.id, 3, now + 5000).split("/")));
// 예전 답 지우기 — 그 줄 키들만, 답·점수 남음
const delH = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "history", q: 3, replacedBy: rid });
out.delH = [delH.status, delH.body.outcome, delH.body.removedObjects];
cur = await st.getToeicAttempt(a1.id);
out.histAfter = { rec: cur.answerHistory[0].recording, fixes: cur.answerHistory[0].fixRecordings.length, score: cur.answerHistory[0].answer.score, delAt: typeof cur.answerHistory[0].recordingDeletedAt };
out.histObjGone = !fs.existsSync(path.join(recDir, ...h.recording.objectKey.split("/")));
out.delHnf = (await delMod.deleteToeicRecordingTarget(a1.id, { kind: "history", q: 3, replacedBy: "nope" })).body.error;
// 실패 주입 — 키 지우기가 던지면 메타 그대로
const s3 = await st.startToeicRetake(a1.id, { questions: [4], replaceOpen: null, newId: "rC", nowIso: iso(now + 200000) });
await blob.put(rules.toeicRecObjectKey(a1.id, 4, now + 201000), MP4, "audio/mp4");
await st.setToeicAttemptRecording(a1.id, meta(4, now + 201000, "c".repeat(64)), "rC");
await st.finishToeicRetake(a1.id, "rC", { finishedAt: null, answers: [{ q: 4, recorded: true, durationMs: 9000 }], nowIso: iso(now + 202000) });
const real = globalThis.__toeicRecBlobStore;
globalThis.__toeicRecBlobStore = { ...real, backend: "file", put: (...a) => real.put(...a), get: (...a) => real.get(...a), deletePrefix: (...a) => real.deletePrefix(...a), deleteAttempt: (...a) => real.deleteAttempt(...a), deleteKey: async () => { throw new Error("inject"); } };
const failed = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "answer", q: 4 });
globalThis.__toeicRecBlobStore = real;
cur = await st.getToeicAttempt(a1.id);
out.inject = [failed.status, failed.body.error, cur.recordings.some((r) => r.q === 4)];
out.startOk = s3.outcome;
// 통째
const whole = await delMod.deleteToeicRecordingTarget(a1.id, { kind: "attempt" });
cur = await st.getToeicAttempt(a1.id);
out.whole = [whole.status, fs.existsSync(path.join(recDir, "attempts", a1.id)), cur.recordings.length, cur.answerHistory.every((x) => x.recording === null), cur.answerHistory.length, cur.answers.length];
console.log("@@RESULT@@" + JSON.stringify(out));
`;

function runFileBackendChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑫ 파일 백엔드");
  const repoRec = path.join(ROOT, "data", "recordings");
  const repoRecBefore = existsSync(repoRec);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-retake-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "db.json"), JSON.stringify({}));
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
        TOEIC_REC_DIR: path.join(dir, "recs"),
        TOEIC_REC_BUCKET: "",
        EVAL_STORE_URL: url("lib/store.ts"),
        EVAL_BLOB_URL: url("lib/toeic-rec-blob.ts"),
        EVAL_RULES_URL: url("lib/toeic-rec-rules.ts"),
        EVAL_DELETE_URL: url("lib/toeic-rec-delete.ts"),
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 800)}`);
      return results;
    }
    const o = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    add("보관소 file · 처음 응시 녹음 stored", o.backend === "file" && o.orig === "stored");
    add("동시 두 시작 → 하나만 started, 하나는 in_progress(원자 단위)", eqJson(o.starts, ["in_progress", "started"]), JSON.stringify(o.starts));
    add("진행 중 업로드(retakeId) → stored/staged · 지금 녹음·점수는 그대로", eqJson(o.staged, ["stored", "staged"]) && o.currentUnchanged === true);
    const am = o.afterMerge as Record<string, unknown>;
    add(
      "끝 → finished·merged [3] · answers 길이 2 · Q3 새 답(채점 전)·지금 녹음 = 대기 녹음 · Q4 원래 답 · 이력 1줄(예전 녹음·고칠 문장 1) · 무음 진단",
      eqJson(o.finish, ["finished", [3]]) && am.len === 2 && am.q3score === null && am.q4 === true && am.cur3 === "b".repeat(64) && am.hist === 1 && am.histRec === "a".repeat(64) && am.histFix === 1 && am.fix === 0 && am.diag3 === true,
      JSON.stringify(am),
    );
    add("다시 끝내기 → already_closed(한 번만)", o.finishAgain === "already_closed");
    add("채점 경합: 읽을 때 세대(null)로 저장 → ToeicAnswerChangedError · 지금 세대로 저장 → 됨", o.race === "ToeicAnswerChangedError" && o.raceOk === 3, String(o.race));
    add("처음 응시 녹음이 늦게 다시 와도(같은 바이트) reused — 지금 자리를 덮지 않음", o.lateOrig === "reused");
    add("예전 답 녹음은 그 줄 메타 키로 보관소에서 읽힌다(GET history 경로)", o.histBytes === 64);
    add("이력 있는 문항 지금 답 지우기 → 200 deleted · 객체 1개(키만) · 예전 답 녹음 객체 남음", eqJson(o.delCur, [200, "deleted", 1]) && o.histObjKept === true && o.curObjGone === true, JSON.stringify(o.delCur));
    const ha = o.histAfter as Record<string, unknown>;
    add("예전 답 지우기 → 200 deleted · 객체 2개(답변 + 고칠 문장) · 줄 녹음 비움·점수 남음·지운 시각", eqJson(o.delH, [200, "deleted", 2]) && ha.rec === null && ha.fixes === 0 && ha.score === 2 && ha.delAt === "string" && o.histObjGone === true, JSON.stringify([o.delH, ha]));
    add("없는 예전 답 → history_not_found", o.delHnf === "history_not_found");
    add("실패 주입(키 지우기가 던짐) → 500 delete_failed · 메타 그대로", eqJson(o.inject, [500, "delete_failed", true]) && o.startOk === "started", JSON.stringify(o.inject));
    add("통째 → 디렉터리 없음 · 지금·이력 녹음 메타 비움 · 이력 답·answers 남음", eqJson(o.whole, [200, false, 0, true, 2, 2]), JSON.stringify(o.whole));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("저장소 data/recordings 새로 안 생김(자식은 임시 폴더만)", existsSync(repoRec) === repoRecBefore);
  return results;
}

// ---------------------------------------------------------------------------
// ⑬ F1 · ⑭ F2 · ⑮ F3 · ⑯ 고칠 문장 정책
// ---------------------------------------------------------------------------

function runSilenceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "마이크대책 ⑬ F1 무음");
  add("문턱: 무음 = 점검 문턱의 1/3(약 -53dB) · 점검 문턱 0.35", Math.abs(TOEIC_SILENT_PEAK_LEVEL - TOEIC_MIC_CHECK_OK_LEVEL / 3) < 1e-12 && TOEIC_MIC_CHECK_OK_LEVEL === 0.35);
  const feed = (levels: number[], reliable = true, start = 0, step = 90) => {
    let s = initialToeicLevelTrack();
    levels.forEach((lv, i) => (s = stepToeicLevelTrack(s, { at: start + i * step, level: lv, reliable })));
    return s;
  };
  add("믿을 표본이 모자라면 unknown(판정 안 함)", toeicSilenceVerdict(feed(Array(TOEIC_SILENCE_MIN_SAMPLES - 1).fill(0))) === "unknown");
  add("0만 10표본 → silent · 문턱 바로 아래 → silent · 문턱 이상 하나라도 → sound", toeicSilenceVerdict(feed(Array(10).fill(0))) === "silent" && toeicSilenceVerdict(feed(Array(10).fill(TOEIC_SILENT_PEAK_LEVEL - 0.001))) === "silent" && toeicSilenceVerdict(feed([...Array(9).fill(0), TOEIC_SILENT_PEAK_LEVEL])) === "sound");
  add("믿을 수 없는 표본(오디오 컨텍스트 멈춤)은 세지 않는다 → 0이 많아도 unknown", toeicSilenceVerdict(feed(Array(50).fill(0), false)) === "unknown");
  add("레벨은 0..1로 자른다 · NaN 무시", feed([2, NaN]).peak === 1 && feed([2, NaN]).samples === 1);
  const quiet = feed(Array(40).fill(0));
  add(`실시간 알림: 조용함 ${TOEIC_SILENCE_ALERT_MS}ms 넘으면 켜짐 · 그 전에는 꺼짐`, toeicSilenceAlertOn(quiet, 0 + TOEIC_SILENCE_ALERT_MS) && !toeicSilenceAlertOn(quiet, TOEIC_SILENCE_ALERT_MS - 1));
  const back = stepToeicLevelTrack(quiet, { at: 3600, level: 0.8, reliable: true });
  add("소리가 다시 들어오면 알림 꺼짐(quietSince null)", back.quietSince === null && !toeicSilenceAlertOn(back, 9999));
  add("믿을 수 없는 표본은 조용한 시간도 바꾸지 않는다", stepToeicLevelTrack(quiet, { at: 99_999, level: 0.9, reliable: false }).quietSince === 0);
  const t1 = toeicMicTroubleAction({ troubles: 1, policy: "keep", kind: "silent" });
  const t2 = toeicMicTroubleAction({ troubles: TOEIC_MIC_TROUBLE_MAX, policy: "keep", kind: "silent" });
  add("문제 1번(무음): 놓기만 · 2번: 남은 문항 문항마다 열기 · muted 다시 열기는 놓지 않음 · per-answer면 바꿀 것 없음", t1.release && !t1.perAnswer && t2.release && t2.perAnswer && !toeicMicTroubleAction({ troubles: 2, policy: "keep", kind: "remuted" }).release && toeicMicTroubleAction({ troubles: 2, policy: "keep", kind: "remuted" }).perAnswer && !toeicMicTroubleAction({ troubles: 5, policy: "per-answer", kind: "silent" }).perAnswer);
  return results;
}

function runDiagChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "마이크대책 ⑭ F2 진단");
  const ok = toeicFinishBodySchema.safeParse({ finishedAt: null, answers: [{ q: 3, recorded: true, durationMs: 1000, diag: diag(3) }, { q: 4, recorded: false, durationMs: null }] });
  add("끝내기 본문: 진단 있음·없음 모두 받는다(옛 화면 호환)", ok.success);
  const bad = (d: Partial<ToeicAnswerDiag>) => !toeicFinishBodySchema.safeParse({ finishedAt: null, answers: [{ q: 3, recorded: true, durationMs: 1000, diag: { ...diag(3), ...d } }] }).success;
  add("진단 zod 경계: 상태 모름·정책 모름·열기 21·muted 다시 열기 6·최고 레벨 1.01·오류 121자·음수 크기 거부", bad({ status: "x" as never }) && bad({ policy: "always" as never }) && bad({ opens: 21 }) && bad({ remuted: 6 }) && bad({ peak: 1.01 }) && bad({ error: "x".repeat(121) }) && bad({ size: -1 }));
  add("진단 경계 통과: 열기 20·최고 레벨 0·1·null", !bad({ opens: 20 }) && !bad({ peak: 0 }) && !bad({ peak: 1 }) && !bad({ peak: null }));
  const iss = finishAnswerIssues([3, 4], [{ q: 3, recorded: true, durationMs: 1000, diag: diag(4) }]);
  add("진단 문항 번호가 답과 다르면 400 issue", iss.some((i) => i.path === "answers.0.diag.q"));
  add("finishBodyDiags: 있는 진단만 정규화해 모은다", eqJson(finishBodyDiags([{ q: 3, recorded: true, durationMs: 1, diag: diag(3) }, { q: 4, recorded: false, durationMs: null }]).map((d) => d.q), [3]));
  const base = normalizeToeicAttemptRecord({ id: "x", mockId: "m", scope: "part", parts: ["picture"], questions: [3, 4], startedAt: ISO(T), finishedAt: null, answers: [] }) as ToeicAttemptRecord;
  const fin = applyAttemptFinish(base, { finishedAt: ISO(T + 1), answers: [{ q: 3, recorded: true, durationMs: 1000 }, { q: 4, recorded: false, durationMs: null }], diags: [diag(3, { silent: true, status: "silent" }), diag(9)] });
  add("끝내기 적용: 응시 범위 진단만 저장(Q9 버림) · 진단 없으면 그대로", fin.answerDiags.length === 1 && fin.answerDiags[0].silent && applyAttemptFinish(base, { finishedAt: null, answers: [] }).answerDiags.length === 0);
  add("toToeicAnswerDiag: 객체 아님·q 범위 밖 → null · 정규화 목록 같은 q는 뒤의 것", toToeicAnswerDiag("x") === null && toToeicAnswerDiag({ q: 0 }) === null && normalizeToeicAnswerDiags([diag(3, { opens: 1 }), diag(3, { opens: 2 })])[0].opens === 2);
  const line = toeicAnswerDiagLineKo(diag(3, { status: "failed", error: "마이크 응답이 없어요", opens: 3, peak: null, size: null, durationMs: null }));
  add("진단 한 줄: 상태·최고 레벨·정책·열기 횟수·오류", /녹음 실패/.test(line) && /최고 레벨 —/.test(line) && /마이크 유지/.test(line) && /열기 3회/.test(line) && /오류 마이크 응답이 없어요/.test(line), line);
  return results;
}

function runPromptChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "마이크대책 ⑮ F3 재획득");
  const g = (mode: "mic" | "nomic", policy: "keep" | "per-answer", holding: boolean, opening: boolean) => toeicMicGate({ mode, policy, holding, opening });
  add("게이트: keep·놓임·여는 중 아님 → ask_tap", g("mic", "keep", false, false) === "ask_tap");
  add("게이트: 쥐고 있음·여는 중·per-answer·녹음 없이 → go", g("mic", "keep", true, false) === "go" && g("mic", "keep", false, true) === "go" && g("mic", "per-answer", false, false) === "go" && g("nomic", "keep", false, false) === "go");
  add("실패 분기: denied·unsupported → timer_only · timeout·failed·busy·no_device·watchdog → ask_tap", toeicMicFailureAction("denied") === "timer_only" && toeicMicFailureAction("unsupported") === "timer_only" && (["timeout", "failed", "busy", "no_device", "watchdog"] as const).every((k) => toeicMicFailureAction(k) === "ask_tap"));
  const idle: ToeicMicPromptState = { phase: "idle" };
  const ask = toeicMicPromptReducer(idle, { type: "need", reason: "released", q: 3 });
  const opening = toeicMicPromptReducer(ask, { type: "tap" });
  const done = toeicMicPromptReducer(opening, { type: "opened" });
  const failed = toeicMicPromptReducer(opening, { type: "fail", message: "거부" });
  const retry = toeicMicPromptReducer(failed, { type: "tap" });
  add("상태 기계: idle →need→ ask →tap→ opening →opened→ idle", ask.phase === "ask" && ask.q === 3 && opening.phase === "opening" && done.phase === "idle");
  add("상태 기계: opening →fail→ failed(메시지) →tap→ opening", failed.phase === "failed" && failed.message === "거부" && retry.phase === "opening" && retry.q === 3);
  add("어디서든 skip → idle", [ask, opening, failed].every((s) => toeicMicPromptReducer(s, { type: "skip" }).phase === "idle"));
  add("맞지 않는 사건은 상태 그대로(늦은 opened·fail·tap·중복 need)", toeicMicPromptReducer(idle, { type: "opened" }) === idle && toeicMicPromptReducer(idle, { type: "fail", message: "x" }) === idle && toeicMicPromptReducer(idle, { type: "tap" }) === idle && toeicMicPromptReducer(ask, { type: "need", reason: "failed", q: 4 }) === ask && toeicMicPromptReducer(ask, { type: "opened" }) === ask);
  return results;
}

function runFixPolicyChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "마이크대책 ⑯ 고칠 문장 정책");
  const p = (appleWebKit: boolean, audioSession: boolean, perAnswerPref: boolean) => toeicFixRecMicPolicy({ appleWebKit, audioSession, perAnswerPref });
  add("Apple WebKit + audioSession → keep — 기기 설정 '문항마다 열기'를 켜도(기본값) keep", p(true, true, true) === "keep" && p(true, true, false) === "keep");
  add("audioSession 없음·Apple 아님 → per-answer", p(true, false, false) === "per-answer" && p(false, true, true) === "per-answer" && p(false, false, false) === "per-answer");
  add("응시 화면 정책은 그대로 기기 설정을 따른다(0ec640c 기본 — 켬이면 per-answer)", micKeepPolicyFor({ appleWebKit: true, audioSession: true, perAnswerPref: true }) === "per-answer");
  return results;
}

// ---------------------------------------------------------------------------
// ⑰ 소스 대조
// ---------------------------------------------------------------------------

function fnBody(src: string, head: string, len = 4000): string {
  const at = src.indexOf(head);
  return at < 0 ? "" : src.slice(at, at + len);
}

function runSourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑰ 소스 대조");
  const start = codeOnly(read("app/api/toeic/attempts/[id]/retakes/route.ts"));
  const finish = codeOnly(read("app/api/toeic/attempts/[id]/retakes/[rid]/finish/route.ts"));
  const hist = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/history/[rid]/route.ts"));
  const put = codeOnly(read("app/api/toeic/attempts/[id]/recordings/[q]/route.ts"));
  const putBody = put.slice(put.indexOf("export async function PUT"), put.indexOf("export async function GET"));
  add("시작 라우트: 원자 단위(store.startToeicRetake) 안 판정 · 409 셋(not_finished·retake_in_progress·history_full)", /store\.startToeicRetake\(/.test(start) && ["not_finished", "retake_in_progress", "history_full"].every((e) => start.includes(`error: "${e}"`)));
  add("끝 라우트: 본문 zod 한 벌(toeicFinishBodySchema) · 범위 = 그 기록 문항 · store.finishToeicRetake · 409 already_finished", /toeicFinishBodySchema\.safeParse/.test(finish) && /finishAnswerIssues\(session\.questions,/.test(finish) && /store\.finishToeicRetake\(/.test(finish) && /error: "already_finished"/.test(finish));
  add("예전 답 GET: private, no-store · nosniff · inline · content-type = 메타 mimeType · DELETE는 지우기 한 벌", /"cache-control": "private, no-store"/.test(hist) && /"x-content-type-options": "nosniff"/.test(hist) && /"content-disposition": "inline"/.test(hist) && /"content-type": meta\.mimeType/.test(hist) && /deleteToeicRecordingTarget\(id, \{ kind: "history", q, replacedBy: rid \}\)/.test(hist));
  add("답변 PUT: 세대 필드 retakeId → 판정(decideToeicAnswerUpload) → 객체 → 메타(세대) · PUT 본문에 지우기 없음", /TOEIC_REC_FIELD_RETAKE_ID/.test(putBody) && /setToeicAttemptRecording\(id, recording, gen\)/.test(putBody) && !/deleteAttempt|\.delete\(|deleteRecording/.test(putBody));
  add("새 라우트·순수 모듈에 OpenAI 키 검사·AI 호출 없음(AI 0)", ![start, finish, hist, codeOnly(read("lib/toeic-retake.ts")), codeOnly(read("lib/toeic-mic-health.ts"))].some((src) => /OPENAI_API_KEY|lib\/ai\/[a-z]/.test(src.replace(/import type [^;]+;/g, ""))));
  for (const f of ["lib/toeic-retake.ts", "lib/toeic-mic-health.ts"]) {
    const paths = runtimeImportPaths(read(f));
    const bad = paths.filter((p) => /firebase-admin|(^|\/)store$|\/store-|\/ai\/|^openai$|^zod$|node:/.test(p));
    add(`번들 경계: ${f} — 서버 모듈 값 import 없음`, bad.length === 0, bad.join(", ") || paths.join(", "));
  }
  const fsStore = codeOnly(read("lib/store-firestore.ts"));
  add("Firestore: 시작·끝은 runTransaction 안에서 판정 · 업로드는 세대 판정", /async startToeicRetake\([\s\S]{0,600}runTransaction[\s\S]{0,400}decideToeicRetakeStart\(/.test(fsStore) && /async finishToeicRetake\([\s\S]{0,700}runTransaction[\s\S]{0,400}applyToeicRetakeFinish\(/.test(fsStore) && /decideToeicAnswerUpload\(current, recording\.q, gen,/.test(fsStore));
  const score = codeOnly(read("app/api/toeic/attempts/[id]/score/route.ts"));
  add("채점 라우트: 읽을 때 세대 → 저장에 expectSource · 409 answer_changed", /const expectSource = toeicAnswerSourceOf\(attempt, q\);/.test(score) && /updateToeicAttemptAnswer\(id, q, patch, expectSource\)/.test(score) && /error: "answer_changed"/.test(score));
  const take = codeOnly(read("components/toeic-take-view.tsx"));
  const startFn = fnBody(take, "function start()", 2400);
  add("응시 화면 start(): 잠금 해제(unlockSpeechPlayback) **뒤에** prime(QA mic-keep P3-3)", startFn.indexOf("unlockSpeechPlayback();") > 0 && startFn.indexOf("unlockSpeechPlayback();") < startFn.indexOf("void k.prime()"));
  add("응시 화면 F3: 준비 진입·답변 열기 두 곳에서 toeicMicGate → ask_tap이면 멈춤(need)", (take.match(/toeicMicGate\(/g) ?? []).length === 2 && (take.match(/dispatchMic\(\{ type: "need", reason: "released"/g) ?? []).length === 2);
  add("응시 화면 F3: '마이크 다시 켜기' 탭 → 답변은 beginAnswerPhase(fromTap — 탭 안 startRecording) · 준비 앞은 prime", /function micPromptTap\(\)[\s\S]{0,900}beginAnswerPhase\(st, token, \{ fromTap: true \}\)[\s\S]{0,400}k\.prime\(\{ gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS \}\)/.test(take));
  add("응시 화면 F3: 녹음 시작 실패 → toeicMicFailureAction · 매달린 획득 버림(releaseMic) · 시계 멈춤", /toeicMicFailureAction\(kind\) === "ask_tap"/.test(take) && /if \(cur && cur\.phase === "answer"\) setPhase\(\{ \.\.\.cur, endsAt: null \}\);\s*releaseMic\(\);/.test(take));
  add("응시 화면 F1: 레벨 표본은 levelReliable일 때만 · 무음이면 status silent(녹음 저장·업로드는 그대로) · 문제 횟수", /reliable: src\.levelReliable\(\)/.test(take) && /status: silent \? "silent" : "recorded"/.test(take) && /if \(silent\) \{[\s\S]{0,300}noteMicTrouble\("silent"\)/.test(take) && /if \(aid\) storeRecording\(aid, q, r\);/.test(take));
  add("응시 화면 F2: 끝내기·비콘·keepalive 본문이 한 벌(finishAnswersOf — 진단 포함, 무음도 recorded)", (take.match(/finishAnswersOf\(/g) ?? []).length >= 3 && /diag: diags\[q\] \?\? null/.test(take) && /a\?\.status === "recorded" \|\| a\?\.status === "silent"/.test(take));
  add("응시 화면 다시 풀기: 시작 = POST …/retakes · 끝·비콘 = …/retakes/[rid]/finish · 녹음 메타에 retakeId", /fetch\(toeicRetakesHref\(r\.attemptId\)/.test(take) && /toeicRetakeFinishHref\(aid, retakeIdRef\.current\)/.test(take) && /retakeId: retakeIdRef\.current/.test(take));
  const view = codeOnly(read("components/toeic-attempt-view.tsx"));
  add("결과 화면: 이 기기 사본 쓰임새(toeicLocalCopyRole) · 오류 문항(toeicErrorQuestions) · 다시 풀기 링크 · 예전 답 서버 사본 fetch", /toeicLocalCopyRole\(/.test(view) && /toeicErrorQuestions\(/.test(view) && /toeicRetakeHref\(id, \[v\.q\]\)/.test(view) && /fetch\(toeicRecordingHistoryHref\(/.test(view) && !/src=\{?[^}\n]*toeicRecordingHistoryHref/.test(view));
  add("결과 화면: ⚙️ '문항마다 마이크 다시 열기'는 응시·다시 풀기 화면용 문구 · 고칠 문장 마이크를 놓지 않는다", /note="응시·다시 풀기 화면에만 적용돼요/.test(view) && !/resetMic\(\)/.test(view));
  const fix = codeOnly(read("components/use-toeic-fix-recorder.ts"));
  add("고칠 문장 녹음기: 업로드에 answerSource(그 답 세대) · 정책 toeicFixRecMicPolicy", /TOEIC_REC_FIELD_ANSWER_SOURCE/.test(fix) && /toeicFixRecMicPolicy\(detectMicKeepEnv\(\)\)/.test(fix));
  const up = codeOnly(read("lib/toeic-rec-upload.ts"));
  add("업로드 대기열: retakeId 실음 · 결과 화면 이벤트 메타는 slot current일 때만 · keepalive 없음", /fd\.append\(TOEIC_REC_FIELD_RETAKE_ID, meta\.retakeId\)/.test(up) && /body\.slot === "current"/.test(up) && !/keepalive/.test(up));
  const mic = codeOnly(read("lib/mic-session.ts"));
  add("mic-session per-answer: 기다리는 사이 놓이면 released(P3-5) · 열기 횟수는 지원될 때만(P3-6)", /const myGen = gen;\s*const rec = await startRecording\(o\);\s*if \(myGen !== gen\)/.test(mic) && /if \(detectMicSupport\(\)\.ok\) \{\s*gumCount \+= 1;/.test(mic));
  const page = codeOnly(read("app/toeic/attempts/[id]/retake/page.tsx"));
  add("다시 풀기 페이지: force-dynamic · 범위 대조 · 닫힘 확인 · ToeicTakeView retake", /export const dynamic = "force-dynamic"/.test(page) && /attempt\.questions\.includes\(q\)/.test(page) && /isToeicAttemptClosed\(attempt\)/.test(page) && /retake=\{\{ attemptId: attempt\.id, replaceOpen \}\}/.test(page));
  return results;
}

// ---------------------------------------------------------------------------
// ⑱ QA rec-retake 1 반례(P2-1~P2-4) — 화면이 서버 상태를 잘못 보이던 네 길
// ---------------------------------------------------------------------------

/** 처음 응시 → (Td에 Q5 지움) → 다시 풀기 r1(Q5) 시작·끝 — 실제 판정·합치기 함수로 만든 기록 */
function deletedThenRetaken(deleteAtMs: number, retakeStartMs: number): A {
  const base = attempt();
  const del = applyToeicRecordingDeletionAll(base, { kind: "answer", q: 5 }, ISO(deleteAtMs)).next;
  const started = applyToeicRetakeStart(del, [], newToeicRetakeSession("r1", [5], ISO(retakeStartMs)), ISO(retakeStartMs));
  return applyToeicRetakeFinish(started, "r1", { finishedAt: ISO(retakeStartMs + 60_000), answers: [{ q: 5, recorded: true, durationMs: 25_000 }] }, ISO(retakeStartMs + 61_000)).next;
}

function runQaFix1Checks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑱ QA rec-retake P2 반례");
  // ── P2-1: 지운 자리 vs 지금 답 세대 시작 ──
  const td = T + 900_000;
  const fresh = applyToeicRecordingDeletionAll(attempt(), { kind: "answer", q: 5 }, ISO(td)).next;
  add("P2-1 지금 답(처음 응시)을 지웠다 → 지움", toeicAnswerRecordingDeleted(fresh, 5) === true);
  add("P2-1 지운 적 없음 → 지움 아님", toeicAnswerRecordingDeleted(attempt(), 5) === false);
  const retaken = deletedThenRetaken(td, td + 3_600_000);
  add(
    "P2-1 반례: 지운 뒤 다시 풀어 합친 새 답(업로드 전) → 지움 아님(\"아직 서버에 올라가지 않았어요\" 갈래)",
    toeicAnswerSourceOf(retaken, 5) === "r1" && retaken.recordingDeletions.length === 1 && toeicAnswerRecordingDeleted(retaken, 5) === false,
    JSON.stringify(retaken.recordingDeletions),
  );
  const reDeleted = applyToeicRecordingDeletionAll(retaken, { kind: "answer", q: 5 }, ISO(td + 7_200_000)).next;
  add("P2-1 합친 새 답을 다시 지웠다(지운 시각 > 다시 풀기 시작) → 지움", toeicAnswerRecordingDeleted(reDeleted, 5) === true);
  const wholeBefore = applyToeicRecordingDeletionAll(deletedThenRetaken(td, td + 3_600_000), { kind: "attempt" }, ISO(td + 7_200_000)).next;
  add("P2-1 응시 통째 지운 자리도 같은 규칙 — 다시 풀기 뒤 통째 지움 → 지움", toeicAnswerRecordingDeleted(wholeBefore, 5) === true);
  const wholeEarly = deletedThenRetaken(td, td + 3_600_000);
  const wholeEarly2 = { ...wholeEarly, recordingDeletions: [{ q: null, fixIndex: null, deletedAt: ISO(td + 1) }] };
  add("P2-1 다시 풀기 시작 전의 통째 지운 자리 → 새 답은 지움 아님", toeicAnswerRecordingDeleted(wholeEarly2, 5) === false);
  add("P2-1 다른 문항(Q3)은 지운 자리가 없으면 지움 아님", toeicAnswerRecordingDeleted(retaken, 3) === false);
  // 서버 판정과 맞물린다 — 그 새 답의 늦은 업로드는 지운 자리에 걸리지 않고 지금 자리에 들어간다
  const lateUp = decideToeicAnswerUpload(retaken, 5, "r1", { sha256: "c".repeat(64), recordedAtMs: td + 3_600_000 + 30_000 });
  add("P2-1 서버와 같은 쪽: 그 새 답의 늦은 업로드 = store current(지운 자리가 막지 않는다)", lateUp.kind === "store" && lateUp.slot === "current", JSON.stringify(lateUp));
  const errs = toeicErrorQuestions(
    retaken.answers.map((a) => ({
      q: a.q,
      recorded: a.recorded === true,
      score: a.score,
      transcript: a.transcript,
      diagStatus: null,
      silent: false,
      deleted: a.recorded === true && toeicAnswerRecordingDeleted(retaken, a.q),
      scoreFailed: false,
    })),
  );
  add("P2-1 오류 문항: 다시 푼 Q5는 '녹음 지움'이 아니다", !errs.some((e) => e.q === 5 && e.reason === "deleted"), JSON.stringify(errs));
  const view = codeOnly(read("components/toeic-attempt-view.tsx"));
  add(
    "P2-1 결과 화면: answerDeleted = 소리 없음 && toeicAnswerRecordingDeleted(세대 시작 비교) · 오류 문항 deleted가 같은 함수",
    /const answerDeleted = \(q: number\) => !hasSound\(q\) && toeicAnswerRecordingDeleted\(deletionView, q\);/.test(view) && /deleted: a\?\.recorded === true && answerDeleted\(q\)/.test(view) && !/toeicRecordingDeletedAt\(/.test(view),
  );

  // ── P2-2: 다시 풀기 끝 화면은 서버 merged로 ──
  add("P2-2 교체로 닫힌 다시 풀기(409 merged []) → Q11은 합치지 않음", eqJson(toeicRetakeFinishOutcome([11], []), { merged: [], notMerged: [11] }));
  add("P2-2 일부만 합침(merged [3]) → merged [3] · notMerged [4]", eqJson(toeicRetakeFinishOutcome([4, 3], [3]), { merged: [3], notMerged: [4] }));
  add("P2-2 대기 자리로 합쳐진 문항(이 기기 녹음 밖)도 merged에 든다 · 중복 제거", eqJson(toeicRetakeFinishOutcome([3, 3], [4, 3]), { merged: [3, 4], notMerged: [] }));
  // 실제 교체 닫기: B가 새로 시작하며 A의 기록을 닫는다 → 늦은 A 업로드는 retaken, A의 끝은 already_closed merged []
  const baseA = attempt({ questions: [3, 4, 5, 11], answers: [...attempt().answers, ans(11)] });
  const openA = applyToeicRetakeStart(baseA, [], newToeicRetakeSession("rA", [11], ISO(T + 1000)), ISO(T + 1000));
  const replaced = applyToeicRetakeStart(openA, ["rA"], newToeicRetakeSession("rB", [11], ISO(T + 2000)), ISO(T + 2000));
  const upA = decideToeicAnswerUpload(replaced, 11, "rA", { sha256: "d".repeat(64), recordedAtMs: T + 1500 });
  const finA = applyToeicRetakeFinish(replaced, "rA", { finishedAt: ISO(T + 3000), answers: [{ q: 11, recorded: true, durationMs: 50_000 }] }, ISO(T + 3001));
  add(
    "P2-2 실제 판정: 교체로 닫힌 rA의 늦은 업로드 = retaken(저장 안 함) · rA 끝 = already_closed merged [] → 끝 화면 notMerged [11]",
    upA.kind === "retaken" && finA.outcome === "already_closed" && eqJson(toeicRetakeFinishOutcome([11], finA.merged).notMerged, [11]),
    JSON.stringify({ upA, finA: { outcome: finA.outcome, merged: finA.merged } }),
  );
  add("P2-2 그 기기 사본(세대 rA)은 결과 화면에서도 쓰이지 않는다(stale) — 지워도 잃는 쓰임이 없다", toeicLocalCopyRole(finA.next, 11, "rA").role === "stale");
  const take = codeOnly(read("components/toeic-take-view.tsx"));
  const up = codeOnly(read("lib/toeic-rec-upload.ts"));
  add(
    "P2-2 응시 화면: 끝 화면 lead는 toeicRetakeFinishOutcome(…, finishState.merged) · 로컬 녹음 목록으로 '합쳤어요'를 만들지 않는다",
    /toeicRetakeFinishOutcome\(qs\.filter\(hasRec\), finishState\.merged\)/.test(take) && /retakeOutcome\.merged\.length > 0\) parts\.push\(`다시 푼 \$\{qList\(retakeOutcome\.merged\)\}를 원래 결과에 합쳤어요/.test(take) && !/qs\.filter\(hasRec\)\.map\(\(q\) => `Q\$\{q\}`\)\.join\("·"\)\}를 원래 결과에 합쳤어요/.test(take),
  );
  add(
    "P2-2 응시 화면: merged는 200·409 응답에서 · 합치지 않은 문항의 이 기기 사본은 그 세대만 지운다(onlyGeneration)",
    /rd\.ok \? rd\.merged : \(rd\.merged \?\? \[\]\)/.test(take) && /deleteToeicRecordingsLocal\(aid, notMerged, \{ onlyGeneration: retakeIdRef\.current \}\)/.test(take),
  );
  add(
    "P2-2 서버 ✓는 slot이 있을 때만(200 retaken = slot null은 세지 않는다) · 업로드 이벤트가 slot을 싣는다",
    /uploadStates\[q\]\?\.state === "done" && uploadStates\[q\]\?\.slot !== null/.test(take) && /slot: body && body\.ok \? body\.slot : null/.test(up) && /state: "done", recording: result\.recording, slot: result\.slot/.test(up),
  );

  // ── P2-3: 목록의 예전 답 '이 기기' 키 = q:replacedBy ──
  const crossSummary: ToeicRecAttemptSummary = {
    id: AID,
    mockId: "m",
    titleKo: "모의고사",
    scopeLabelKo: "실전 응시",
    startedAt: ISO(T),
    questions: [3, 4],
    answers: [
      { q: 3, recorded: true, score: null },
      { q: 4, recorded: true, score: null },
    ],
    recordings: [rec(3, T + 9000), rec(4, T + 9500)],
    fixRecordings: [],
    recordingDeletions: [],
    answerHistory: [
      { q: 3, replacedBy: "r1", startedAt: ISO(T), score: 1, recording: rec(3, T + 100), fixCount: 0, recordingDeletedAt: null },
      { q: 4, replacedBy: "r1", startedAt: ISO(T), score: 1, recording: null, fixCount: 0, recordingDeletedAt: null },
      { q: 4, replacedBy: "r2", startedAt: ISO(T + 5000), score: 2, recording: rec(4, T + 5100), fixCount: 0, recordingDeletedAt: null },
    ],
  };
  const crossLocals = [
    { attemptId: AID, q: 3, durationMs: 1, size: 1, createdAt: T + 100, upload: "done", retakeId: null }, // Q3 처음 응시 세대 → Q3 r1 줄
    { attemptId: AID, q: 4, durationMs: 1, size: 1, createdAt: T + 9500, upload: "done", retakeId: "r2" }, // Q4 지금 세대
  ];
  const cv = buildToeicRecManageView([crossSummary], crossLocals);
  const ci = cv.groups[0]?.items ?? [];
  add(
    "P2-3 반례: Q3 예전 세대 사본이 Q4 r1 줄의 '이 기기'로 새지 않는다(Q4 r1 줄 = 녹음 없음 → 항목 없음) · Q3 r1 줄은 이 기기",
    !ci.some((i) => i.kind === "history" && i.q === 4 && i.replacedBy === "r1") && ci.some((i) => i.kind === "history" && i.q === 3 && i.replacedBy === "r1" && i.local) && ci.some((i) => i.kind === "history" && i.q === 4 && i.replacedBy === "r2" && !i.local) && ci.some((i) => i.kind === "answer" && i.q === 4 && i.local),
    JSON.stringify(ci.map((i) => [i.kind, i.q, i.kind === "history" ? i.replacedBy : "-", i.local])),
  );
  const mg = codeOnly(read("lib/toeic-rec-manage.ts"));
  add("P2-3 목록 키 = `${q}:${replacedBy}`(결과 화면과 같다)", /\[`\$\{m\.q\}:\$\{r\.replacedBy\}`\]/.test(mg) && /histLocal\.has\(`\$\{h\.q\}:\$\{h\.replacedBy\}`\)/.test(mg) && /hm\.set\(`\$\{r\.q\}:\$\{role\.replacedBy\}`/.test(view));

  // ── P2-4: 지운 예전 답의 이 기기 사본 ──
  const hd = [
    { q: 3, replacedBy: "r1", recordingDeletedAt: ISO(T + 99) },
    { q: 4, replacedBy: "r1", recordingDeletedAt: null },
  ];
  add("P2-4 지운 예전 답(Q3 r1)의 예전 세대 사본(null) → 지운다 · keepGeneration = 지금 세대 r1", eqJson(toeicDeletedHistoryLocalCopies({ answerHistory: hd }, [{ q: 3, retakeId: null }]), [{ q: 3, keepGeneration: "r1" }]));
  add("P2-4 지금 세대 사본(r1)·안 지운 줄의 사본·모르는 세대 사본은 그대로", eqJson(toeicDeletedHistoryLocalCopies({ answerHistory: hd }, [{ q: 3, retakeId: "r1" }, { q: 4, retakeId: null }, { q: 3, retakeId: "zz" }]), []));
  // 실제 지우기 적용으로 만든 기록(iPad에서 그 줄 지움) → iPhone 사본 판정
  const histBase = deletedThenRetaken(T + 500, T + 600_000);
  const withHistRec = { ...histBase, answerHistory: histBase.answerHistory.map((h) => (h.q === 5 ? { ...h, recording: rec(5, T + 300), recordingDeletedAt: null } : h)) };
  const histDel = applyToeicRecordingDeletionAll(withHistRec, { kind: "history", q: 5, replacedBy: "r1" }, ISO(T + 900_000)).next;
  add(
    "P2-4 실제 적용: 예전 답 지우기는 지운 자리를 남기지 않고 recordingDeletedAt만 → 그 사본이 지울 대상",
    histDel.recordingDeletions.length === withHistRec.recordingDeletions.length && eqJson(toeicDeletedHistoryLocalCopies(histDel, [{ q: 5, retakeId: null }]), [{ q: 5, keepGeneration: "r1" }]),
  );
  const delSummary: ToeicRecAttemptSummary = {
    ...crossSummary,
    questions: [3],
    answers: [{ q: 3, recorded: true, score: null }],
    recordings: [rec(3, T + 9000)],
    answerHistory: [{ q: 3, replacedBy: "r1", startedAt: ISO(T), score: 1, recording: null, fixCount: 0, recordingDeletedAt: ISO(T + 99) }],
  };
  const dv = buildToeicRecManageView([delSummary], [{ attemptId: AID, q: 3, durationMs: 1, size: 1, createdAt: T + 100, upload: "done", retakeId: null }]);
  add(
    "P2-4 목록: 지운 예전 답의 이 기기 사본은 항목에서 빠지고 purgeLocalHistory에 담긴다(keepGeneration = 지금 세대) · purgeLocal은 그대로",
    !(dv.groups[0]?.items ?? []).some((i) => i.kind === "history") && eqJson(dv.purgeLocalHistory, [{ attemptId: AID, q: 3, keepGeneration: "r1" }]) && dv.purgeLocal.length === 0,
    JSON.stringify(dv),
  );
  const dvKeep = buildToeicRecManageView([delSummary], [{ attemptId: AID, q: 3, durationMs: 1, size: 1, createdAt: T + 9000, upload: "done", retakeId: "r1" }]);
  add("P2-4 목록: 지금 세대 사본만 있으면 지우지 않는다(지금 답 항목 이 기기 그대로)", dvKeep.purgeLocalHistory.length === 0 && (dvKeep.groups[0]?.items ?? []).some((i) => i.kind === "answer" && i.q === 3 && i.local));
  const list = codeOnly(read("components/toeic-recordings-view.tsx"));
  const page = codeOnly(read("app/toeic/recordings/page.tsx"));
  add(
    "P2-4 배선: 결과 화면·목록이 열 때 지운 예전 답 사본을 keepGeneration으로 지운다 · 목록 요약에 recordingDeletedAt",
    /toeicDeletedHistoryLocalCopies\(historyRef0\.current,/.test(view) && /deleteToeicRecordingsLocal\(id, \[p\.q\], \{ keepGeneration: p\.keepGeneration \}\)/.test(view) && /for \(const p of v\.purgeLocalHistory\) void deleteToeicRecordingsLocal\(p\.attemptId, \[p\.q\], \{ keepGeneration: p\.keepGeneration \}\)/.test(list) && /recordingDeletedAt: h\.recordingDeletedAt/.test(page),
  );

  // ── P2-5(QA rec-retake 2): 다른 응시(같은 모의고사의 앞 응시 Y)의 이 기기 사본 — 그 응시의 지금 세대만 ③ "그 응시의 지금 답" 행에 ──
  // 페이지가 넘기는 모양(toToeicCompareAttempt) 그대로. Y의 Q5를 다른 기기에서 다시 풀어(r1) 합쳤고, 이 기기엔 처음 응시 세대(null) 사본만 있다
  const cmpOf = (a: A): { answerHistory: NonNullable<ReturnType<typeof toToeicCompareAttempt>["answerHistory"]> } => ({
    answerHistory: toToeicCompareAttempt({ ...a, scope: "part" as const }).answerHistory ?? [],
  });
  const yRetaken = cmpOf(deletedThenRetaken(T + 500, T + 600_000));
  const yLocalOld = { q: 5, retakeId: null, tag: "old-9444B" };
  const ySplit = toeicOtherAttemptLocalCopies(yRetaken, [yLocalOld]);
  add(
    "P2-5 반례: 다른 응시 사본 세대(null) ≠ 그 응시 지금 세대(r1) → 그 응시의 지금 답 행에 쓰지 않는다(서버 사본을 받는다) · 지운 적 없으니 정리도 없음",
    toeicAnswerSourceOf(yRetaken, 5) === "r1" && ySplit.current.length === 0 && ySplit.purge.length === 0,
    JSON.stringify(ySplit),
  );
  add(
    "P2-5 대조: 그 응시 지금 세대(r1) 사본은 쓰고 · 다시 푼 적 없는 응시의 처음 세대(null) 사본도 그대로 쓴다",
    eqJson(toeicOtherAttemptLocalCopies(yRetaken, [{ q: 5, retakeId: "r1" }]).current, [{ q: 5, retakeId: "r1" }]) &&
      eqJson(toeicOtherAttemptLocalCopies(cmpOf(attempt()), [{ q: 3, retakeId: null }, { q: 5 }]).current, [{ q: 3, retakeId: null }, { q: 5 }]),
  );
  const yHistDel = cmpOf(histDel);
  add(
    "P2-5 두 번째 증상: 다른 기기에서 그 응시의 예전 답(Q5 r1 줄)을 지웠다 → 이 기기 예전 세대 사본은 정리(keepGeneration r1) · 지금 답 행에도 안 쓴다",
    eqJson(toeicOtherAttemptLocalCopies(yHistDel, [{ q: 5, retakeId: null }]), { current: [], purge: [{ q: 5, keepGeneration: "r1" }] }) &&
      eqJson(toeicOtherAttemptLocalCopies({ answerHistory: yHistDel.answerHistory.map((h) => ({ q: h.q, replacedBy: h.replacedBy })) }, [{ q: 5, retakeId: null }]).purge, []),
  );
  add(
    "P2-5 배선: 결과 화면 otherLocal = toeicOtherAttemptLocalCopies(그 응시 answerHistory).current · purge는 keepGeneration · 세대 키로 다시 가른다",
    /const split = toeicOtherAttemptLocalCopies\(\{ answerHistory: other\?\.answerHistory \?\? \[\] \}, all\.filter\(\(r\) => !gone\.includes\(r\)\)\);/.test(view) &&
      /for \(const p of split\.purge\) void deleteToeicRecordingsLocal\(aid, \[p\.q\], \{ keepGeneration: p\.keepGeneration \}\);/.test(view) &&
      /const list = split\.current;/.test(view) &&
      /\}, \[historyIdsKey, historyGenKey\]\);/.test(view),
  );
  return results;
}

/** 이 기기 보관소(메모리 폴백 — Node엔 IndexedDB가 없다) — keepGeneration·onlyGeneration 실제 동작 */
export async function runToeicRetakeLocalStoreChecks(): Promise<GuideCheckResult[]> {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "다시풀기 ⑱ 이 기기 보관소(메모리)");
  const { saveToeicRecording, listToeicRecordings, deleteToeicRecordingsLocal } = await import("../lib/toeic-rec-store");
  const aid = "att-local-gen";
  const put = (q: number, retakeId: string | null, createdAt: number) =>
    saveToeicRecording({ attemptId: aid, pool: "mock", q, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }), mimeType: "audio/mp4", durationMs: 1000, size: 3, createdAt, retakeId });
  await put(3, null, T + 1);
  await put(4, "r1", T + 2);
  await put(11, "rA", T + 3);
  const gens = async () => (await listToeicRecordings(aid)).map((r) => [r.q, r.retakeId ?? null]);
  const n1 = await deleteToeicRecordingsLocal(aid, [3, 4], { keepGeneration: "r1" });
  add("keepGeneration r1: 예전 세대(Q3 null)는 지우고 지금 세대(Q4 r1)는 남긴다", n1 === 1 && eqJson(await gens(), [[4, "r1"], [11, "rA"]]), JSON.stringify(await gens()));
  const n2 = await deleteToeicRecordingsLocal(aid, [4, 11], { onlyGeneration: "rA" });
  add("onlyGeneration rA(P2-2 합치지 않은 다시 풀기 사본): 그 세대만 지운다(Q4 r1 남음)", n2 === 1 && eqJson(await gens(), [[4, "r1"]]), JSON.stringify(await gens()));
  const n3 = await deleteToeicRecordingsLocal(aid, [4], { onlyGeneration: null });
  add("onlyGeneration null: 처음 응시 세대만 — r1 사본은 남는다", n3 === 0 && eqJson(await gens(), [[4, "r1"]]));
  await deleteToeicRecordingsLocal(aid, "all");
  add("옵션 없음: 지금처럼 전부", (await listToeicRecordings(aid)).length === 0);
  return results;
}

export function runToeicRetakeChecks(): GuideCheckResult[] {
  return [
    ...runStartChecks(),
    ...runMergeChecks(),
    ...runUploadChecks(),
    ...runEstimateChecks(),
    ...runDeleteChecks(),
    ...runNormalizeChecks(),
    ...runCompareChecks(),
    ...runLocalRoleChecks(),
    ...runErrorChecks(),
    ...runStreakChecks(),
    ...runFileBackendChecks(),
    ...runSilenceChecks(),
    ...runDiagChecks(),
    ...runPromptChecks(),
    ...runFixPolicyChecks(),
    ...runSourceChecks(),
    ...runQaFix1Checks(),
  ];
}

/**
 * scripts/eval-toeic-frame-drill-app.ts — 소재별 틀 말하기 **앱 층** 오프라인 점검 (docs/harness/toeic.md §20-10·§20-14, SPEC §20-17)
 *
 * `eval-toeic.ts`가 `runToeicFrameDrillAppChecks()`로 부른다(실호출 0 — AI·네트워크 없음). AI 층·순수 층은 eval-toeic-frame-drill.ts.
 * 1. 저장 판정(lib/toeic-frame-drill-record): 판정 저장(통계 한 번)·보충 시작(잡기·판정)·보충 끝(합치기·실패)·정규화(키 순서가 섞여도 같은 파일 = unchanged)
 * 2. 화면 판단(lib/toeic-frame-drill-view): 보낼지·결과·탭 자료·범위 수 · 계약(주소·문서 id)
 * 3. 파일 백엔드 실제 동작(자식 프로세스 — 임시 cwd의 db.json): 가져오기 → 판 저장(멱등) → 판정(통계 한 번) → 보충 판정 → 다시 가져오기(통계 보존)
 * 4. 소스 배선: 라우트 키 검사 위치·store 경계·화면 import 경계·표현 도우미 경로
 * 픽스처는 전부 지어낸 것(교재·강의 문장 없음).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TOEIC_FRAME_DRILL_SUPPLY_STALE_MS,
  mergeFrameDrillImport,
  type ToeicFrameDrillBank,
  type ToeicFrameDrillFile,
  type ToeicFrameDrillItem,
  type ToeicFrameDrillSessionItem,
  type ToeicFrameDrillStat,
} from "../lib/toeic-frame-drill";
import {
  decideFrameDrillJudgeWrite,
  decideFrameDrillSupplyFinish,
  decideFrameDrillSupplyStart,
  normalizeToeicFrameDrillBank,
  normalizeToeicFrameDrillSession,
  normalizeToeicFrameDrillStats,
  type ToeicFrameDrillSessionRecord,
} from "../lib/toeic-frame-drill-record";
import { buildFrameDrillTabData, frameDrillItemResult, frameDrillShouldSend, frameDrillTabScope } from "../lib/toeic-frame-drill-view";
import {
  isToeicFrameDrillDocId,
  parseFrameDrillSelection,
  toeicFrameDrillSessionDocId,
  toeicFrameDrillTakeHref,
} from "../lib/toeic-frame-drill-contract";
import { isPhraseHelperExamPath } from "../lib/phrase-helper-scope";

export interface FrameDrillAppCheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AT = "2026-10-03T00:00:00.000Z";
const AT2 = "2026-10-03T01:00:00.000Z";

function adder(results: FrameDrillAppCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 것
// ---------------------------------------------------------------------------

function fixtureFile(itemsPerFrame = 4): ToeicFrameDrillFile {
  const nouns = ["apples", "boxes", "chairs", "desks", "eggs", "forks", "games", "hats", "inks", "jars", "kites", "lamps"];
  const items: ToeicFrameDrillFile["items"] = [];
  for (let i = 0; i < itemsPerFrame; i++) {
    items.push({ id: `buy-more-s${i + 1}`, frameKey: "buy-more", ko: `저는 요즘 ${i + 1}번 물건을 더 사요.`, fills: [nouns[i]], en: `These days I buy more ${nouns[i]}.` });
    items.push({ id: `walk-to-s${i + 1}`, frameKey: "walk-to", ko: `저는 ${i + 1}번 장소까지 걸어가요.`, fills: [`place ${i + 1}`], en: `I usually walk to place ${i + 1}.` });
  }
  return {
    format: "toeic-frame-drill/v1",
    presetKey: "eval-frame-app",
    topics: [
      { key: "shop", nameKo: "쇼핑 소재" },
      { key: "move", nameKo: "이동 소재" },
    ],
    questionTypes: [{ key: "how", nameKo: "어떻게" }],
    frames: [
      { key: "buy-more", topicKey: "shop", frameEn: "These days I buy more {물건}.", frameKo: "요즘 저는 {물건}을 더 사요.", useKo: null, parts: ["q5_7", "q11"], bankKey: null, sources: ["new"], questionTypes: [], fillOptions: [] },
      { key: "walk-to", topicKey: "move", frameEn: "I usually walk to {장소}.", frameKo: "저는 보통 {장소}까지 걸어가요.", useKo: null, parts: ["q5_7"], bankKey: null, sources: ["new"], questionTypes: ["how"], fillOptions: [] },
    ],
    items,
  };
}

function bankOf(file = fixtureFile()): ToeicFrameDrillBank {
  return mergeFrameDrillImport(null, file, AT).bank;
}

function sItem(over: Partial<ToeicFrameDrillSessionItem>): ToeicFrameDrillSessionItem {
  return { itemId: "buy-more-s1", frameKey: "buy-more", ko: "지어낸 문장이에요.", en: "These days I buy more apples.", frame: "These days I buy more ~", outcome: "spoken", transcript: "these days i buy more apples", verdict: null, reasonKo: null, fixedEn: null, ...over };
}

function session(over: Partial<ToeicFrameDrillSessionRecord> = {}): ToeicFrameDrillSessionRecord {
  return {
    id: "fd-evalsess1",
    part: "q5_7",
    topicKeys: ["shop"],
    questionTypeKeys: [],
    excludedFrameKeys: [],
    requested: 3,
    startedAt: AT,
    finishedAt: AT2,
    ended: "done",
    items: [
      sItem({ itemId: "buy-more-s1" }),
      sItem({ itemId: "buy-more-s2", outcome: "no_speech", transcript: null }),
      sItem({ itemId: "buy-more-s3", outcome: "transcribe_failed", transcript: null }),
    ],
    review: null,
    statsAppliedAt: null,
    supply: null,
    ...over,
  };
}

const judged = (verdict: "correct" | "close" | "wrong") => ({
  items: [{ no: 1, verdict, reasonKo: verdict === "correct" ? null : "지어낸 이유예요", fixedEn: verdict === "correct" ? null : "These days I buy more apples." }],
  summaryKo: "지어낸 총평이에요.",
  improvements: ["지어낸 개선점 하나", "지어낸 개선점 둘"],
  strongFrameKeys: ["buy-more"],
  weakFrameKeys: [],
  model: "gpt-test",
});

// ---------------------------------------------------------------------------
// 1. 저장 판정
// ---------------------------------------------------------------------------

function runRecordChecks(): FrameDrillAppCheckResult[] {
  const results: FrameDrillAppCheckResult[] = [];
  const add = adder(results, "틀 말하기 앱 ① 저장 판정");

  // 판정 저장
  const w1 = decideFrameDrillJudgeWrite(session(), judged("close"), {}, AT2);
  add(
    "판정(call): 말한 문항 = AI 판정 · 무응답 = AI 없이 wrong · 전사 실패 = null · review·statsAppliedAt 한 번에",
    w1.kind === "write" &&
      w1.session.items[0].verdict === "close" &&
      w1.session.items[1].verdict === "wrong" &&
      w1.session.items[2].verdict === null &&
      w1.session.review?.model === "gpt-test" &&
      w1.session.statsAppliedAt === AT2,
    JSON.stringify(w1.kind === "write" ? w1.session.items.map((i) => i.verdict) : w1),
  );
  add(
    "판정과 같은 결과에 통계: close·무응답 = 오답 · 전사 실패 = 건너뜀",
    w1.kind === "write" && eqJson(w1.stats, { "buy-more-s1": { attempts: 1, wrong: 1, lastAt: AT2 }, "buy-more-s2": { attempts: 1, wrong: 1, lastAt: AT2 } }),
    JSON.stringify(w1.kind === "write" ? w1.stats : null),
  );
  const done = w1.kind === "write" ? w1.session : session();
  const w2 = decideFrameDrillJudgeWrite(done, judged("correct"), w1.kind === "write" ? w1.stats! : {}, AT2);
  add("이미 판정된 판 → already(쓰지 않음 — 먼저 저장된 판정이 이기고 통계는 두 번 더해지지 않는다)", w2.kind === "already");
  add("말한 문항이 있는데 AI 결과 없음 → needs_ai(쓰지 않음)", decideFrameDrillJudgeWrite(session(), null, {}, AT2).kind === "needs_ai");
  const allSilent = session({ items: [sItem({ outcome: "no_speech", transcript: null }), sItem({ itemId: "x2", outcome: "transcribe_failed", transcript: null })] });
  const w3 = decideFrameDrillJudgeWrite(allSilent, null, {}, AT2);
  add("말한 문항 0 → AI 0 총평(model null) + 통계(무응답만 오답)", w3.kind === "write" && w3.session.review?.model === null && eqJson(Object.keys(w3.stats ?? {}), ["buy-more-s1"]));
  const halfApplied = { ...done, statsAppliedAt: null };
  const w4 = decideFrameDrillJudgeWrite(halfApplied, null, {}, AT2);
  add("판정은 있는데 통계 표시가 없는 판(방어) → 통계만 지금 한 번 더한다", w4.kind === "write" && w4.session.statsAppliedAt === AT2 && w4.stats !== null);

  // 보충 시작
  const bank = bankOf(fixtureFile(6)); // shop 범위 6문항
  const lowStats: Record<string, ToeicFrameDrillStat> = Object.fromEntries(bank.items.filter((it) => it.frameKey === "buy-more").map((it) => [it.id, { attempts: 10, wrong: 1, lastAt: AT }]));
  const judgedSession = { ...done };
  const nowMs = Date.parse(AT2);
  add("보충 시작: 판정 전 → not_judged", decideFrameDrillSupplyStart(session(), bank, lowStats, nowMs, AT2).kind === "not_judged");
  const st1 = decideFrameDrillSupplyStart(judgedSession, bank, lowStats, nowMs, AT2);
  add(
    "보충 시작: 범위 6문항 · 표본 6 · 오답률 10% → supply 1개(running 표시 · 범위 틀 = 그 판 소재)",
    st1.kind === "supply" && st1.count === 1 && st1.mark.status === "running" && eqJson(st1.scopeFrameKeys, ["buy-more"]),
    JSON.stringify(st1),
  );
  const st2 = decideFrameDrillSupplyStart(judgedSession, bank, {}, nowMs, AT2);
  add("보충 시작: 표본 부족 → skip sample(skipped 표시 — 다시 열어도 AI 0)", st2.kind === "skip" && st2.reason === "sample" && st2.mark.status === "skipped");
  const highStats = Object.fromEntries(Object.keys(lowStats).map((k) => [k, { attempts: 5, wrong: 1, lastAt: AT }]));
  const st3 = decideFrameDrillSupplyStart(judgedSession, bank, highStats, nowMs, AT2);
  add("보충 시작: 평균 오답률 20%(경계) → skip rate", st3.kind === "skip" && st3.reason === "rate");
  add(
    "보충 시작: 이미 added·skipped → already(쓰지 않음) · running 2분 안 → running · 오래된 running·failed → 다시 잡음",
    decideFrameDrillSupplyStart({ ...judgedSession, supply: { status: "added", reason: null, added: 1, at: AT } }, bank, lowStats, nowMs, AT2).kind === "already" &&
      decideFrameDrillSupplyStart({ ...judgedSession, supply: { status: "skipped", reason: "rate", added: 0, at: AT } }, bank, lowStats, nowMs, AT2).kind === "already" &&
      decideFrameDrillSupplyStart({ ...judgedSession, supply: { status: "running", reason: null, added: 0, at: AT2 } }, bank, lowStats, nowMs + 1000, AT2).kind === "running" &&
      decideFrameDrillSupplyStart({ ...judgedSession, supply: { status: "running", reason: null, added: 0, at: AT2 } }, bank, lowStats, nowMs + TOEIC_FRAME_DRILL_SUPPLY_STALE_MS + 1, AT2).kind === "supply" &&
      decideFrameDrillSupplyStart({ ...judgedSession, supply: { status: "failed", reason: "ai_failed", added: 0, at: AT2 } }, bank, lowStats, nowMs, AT2).kind === "supply",
  );
  add("보충 시작: 은행 없음 → skip no_scope", (() => {
    const r = decideFrameDrillSupplyStart(judgedSession, null, lowStats, nowMs, AT2);
    return r.kind === "skip" && r.reason === "no_scope";
  })());

  // 보충 끝
  const f1 = decideFrameDrillSupplyFinish(bank, [{ frameKey: "buy-more", ko: "저는 요즘 지어낸 새 물건을 더 사요.", fills: ["new mugs"] }], null, AT2);
  add(
    "보충 끝: 최신 은행 위에 더함 — 영어는 코드가 fillFrame으로(틀 글자 그대로) · source ai · 표시 added 1",
    f1.mark.status === "added" && f1.added === 1 && f1.bank?.items.at(-1)?.en === "These days I buy more new mugs." && f1.bank?.items.at(-1)?.source === "ai" && f1.bank?.updatedAt === AT2,
    JSON.stringify(f1.bank?.items.at(-1)),
  );
  const f2 = decideFrameDrillSupplyFinish(bank, [{ frameKey: "buy-more", ko: "다른 한국어 문장이에요.", fills: ["apples"] }], null, AT2);
  add("보충 끝: 은행과 영어가 겹치면 버림(쓰지 않음 — added 0, 표시 added)", f2.added === 0 && f2.dropped === 1 && f2.bank === null && f2.mark.status === "added");
  const f3 = decideFrameDrillSupplyFinish(bank, null, "ai_failed", AT2);
  add("보충 끝: 실패 → 표시 failed(이유) · 은행 쓰지 않음", f3.mark.status === "failed" && f3.mark.reason === "ai_failed" && f3.bank === null);

  // 정규화
  add("정규화: 깨진 은행 문서 → null · 없는 통계 → 빈 통계 · 깨진 판 → null", normalizeToeicFrameDrillBank({ x: 1 }) === null && eqJson(normalizeToeicFrameDrillStats(null).items, {}) && normalizeToeicFrameDrillSession("fd-x", { part: "q3_4", items: [] }) === null);
  const shuffled = JSON.parse(JSON.stringify(bank), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  const reread = normalizeToeicFrameDrillBank(shuffled);
  const again = mergeFrameDrillImport(reread, fixtureFile(6), AT2);
  add("정규화: 키 순서가 뒤섞인 문서(Firestore)를 읽어도 같은 파일 다시 가져오기 = unchanged(쓰기 0 · updatedAt 그대로)", again.unchanged && again.bank.updatedAt === AT, `unchanged=${again.unchanged}`);
  const stats = normalizeToeicFrameDrillStats({ items: { a: { attempts: 3, wrong: 9, lastAt: AT }, b: "x" } });
  add("정규화: 통계 wrong ≤ attempts · 깨진 줄은 버림", eqJson(stats.items, { a: { attempts: 3, wrong: 3, lastAt: AT } }));
  const sess = normalizeToeicFrameDrillSession("fd-y", { ...session(), id: undefined, items: [{ ...sItem({}), outcome: "weird", verdict: "maybe" }] });
  add("정규화: 모르는 outcome → transcribe_failed(판정·통계 밖) · 모르는 verdict → null · undefined 0", sess !== null && sess.items[0].outcome === "transcribe_failed" && sess.items[0].verdict === null && !JSON.stringify(sess).includes("undefined"));
  return results;
}

// ---------------------------------------------------------------------------
// 2. 화면 판단 · 계약
// ---------------------------------------------------------------------------

function runViewChecks(): FrameDrillAppCheckResult[] {
  const results: FrameDrillAppCheckResult[] = [];
  const add = adder(results, "틀 말하기 앱 ② 화면 판단");

  const send = (end: Parameters<typeof frameDrillShouldSend>[0]["end"], sawUnreliable: boolean, durationMs = 3000) => frameDrillShouldSend({ end, sawUnreliable, durationMs });
  add(
    "보낼지: silence·max·다 말했어요 → 보냄 · 0.6초 미만 → 안 보냄",
    send("silence", false) && send("max", false) && send("manual", false) && !send("silence", false, 500) && !send("manual", true, 599),
  );
  add("보낼지: 무응답 + 표본이 모두 믿을 만함 → 안 보냄(비용 0) · 믿을 수 없는 표본이 있었음 → 보내서 전사로 가른다", !send("no_speech", false) && send("no_speech", true));
  add(
    "결과: 안 보냄 → no_speech · 실패 → transcribe_failed · 한 낱말 → no_speech · 두 낱말 이상 → spoken",
    frameDrillItemResult({ sent: false }).outcome === "no_speech" &&
      frameDrillItemResult({ sent: true, ok: false }).outcome === "transcribe_failed" &&
      frameDrillItemResult({ sent: true, ok: true, text: "apples" }).outcome === "no_speech" &&
      eqJson(frameDrillItemResult({ sent: true, ok: true, text: "  these   days " }), { outcome: "spoken", transcript: "these days" }),
  );

  const bank = bankOf(fixtureFile(3));
  const stats = { "buy-more-s1": { attempts: 2, wrong: 1, lastAt: AT }, "buy-more-s2": { attempts: 1, wrong: 0, lastAt: AT } };
  const sessions = [session({ id: "fd-a1234567" }), session({ id: "fd-b1234567", part: "q11" })];
  const tab = buildFrameDrillTabData({ part: "q5_7", bank, bankExists: true, stats, sessions });
  add(
    "탭 자료(Q5–7): 소재 2 · 틀 문항 수 · 오답률(연습한 문항 평균) · 질문 유형(이 폴더 틀에 붙은 것) · 지난 판은 이 유형만",
    tab.bankState === "ready" &&
      eqJson(tab.topics.map((t) => [t.key, t.frames.map((f) => [f.key, f.itemCount, f.wrongRate])]), [["shop", [["buy-more", 3, 0.25]]], ["move", [["walk-to", 3, null]]]]) &&
      eqJson(tab.questionTypes.map((q) => q.key), ["how"]) &&
      eqJson(tab.recent.map((r) => r.id), ["fd-a1234567"]),
    JSON.stringify(tab.topics),
  );
  const tab11 = buildFrameDrillTabData({ part: "q11", bank, bankExists: true, stats, sessions });
  add("탭 자료(Q11): 이 폴더 틀만(walk-to는 Q5–7 전용 — 소재 move가 빠진다) · 질문 유형 0", eqJson(tab11.topics.map((t) => t.key), ["shop"]) && tab11.questionTypes.length === 0);
  add(
    "탭 자료: 은행 없음 → none · 있는데 깨짐 → broken · 이 폴더 틀 0 → empty",
    buildFrameDrillTabData({ part: "q5_7", bank: null, bankExists: false, stats: {}, sessions: [] }).bankState === "none" &&
      buildFrameDrillTabData({ part: "q5_7", bank: null, bankExists: true, stats: {}, sessions: [] }).bankState === "broken" &&
      buildFrameDrillTabData({ part: "q11", bank: { ...bank, frames: bank.frames.filter((f) => f.key === "walk-to") }, bankExists: true, stats: {}, sessions: [] }).bankState === "empty",
  );
  const sc = frameDrillTabScope(tab, { topicKeys: ["shop", "move"], excludedFrameKeys: [], questionTypeKeys: [] });
  const scQt = frameDrillTabScope(tab, { topicKeys: ["shop", "move"], excludedFrameKeys: [], questionTypeKeys: ["how"] });
  const scEx = frameDrillTabScope(tab, { topicKeys: ["shop", "move"], excludedFrameKeys: ["walk-to"], questionTypeKeys: [] });
  add(
    "범위: 소재 둘 = 틀 2·6문항 · 질문 유형 how로 좁힘 = walk-to만 · 틀 빼기 = buy-more만 · 소재 없음 = 0",
    sc.itemCount === 6 && eqJson(scQt.frameKeys, ["walk-to"]) && eqJson(scEx.frameKeys, ["buy-more"]) && frameDrillTabScope(tab, { topicKeys: [], excludedFrameKeys: [], questionTypeKeys: [] }).itemCount === 0,
  );

  const href = toeicFrameDrillTakeHref("q11", { topicKeys: ["shop", "move"], excludedFrameKeys: ["walk-to"], questionTypeKeys: ["how"], count: 33 });
  const parsed = parseFrameDrillSelection(Object.fromEntries(new URL(href, "http://x").searchParams));
  add(
    "주소 왕복: 고르기 → 진행 주소 → 다시 읽기(문항 수 21 → 20으로)",
    href.startsWith("/toeic/guides/q11/frame-drill/take?") && eqJson(parsed, { topicKeys: ["shop", "move"], excludedFrameKeys: ["walk-to"], questionTypeKeys: ["how"], count: 20 }),
    href,
  );
  add(
    "주소 읽기: 문법 밖 key·중복은 버림 · 문항 수 없음 → 기본 10",
    eqJson(parseFrameDrillSelection({ topics: "shop,Shop!,shop,../x", n: "abc" }), { topicKeys: ["shop"], excludedFrameKeys: [], questionTypeKeys: [], count: 10 }),
  );
  add(
    "문서 id: fd- + 화면 id만(`/`·짧은 값·접두어 없음 거부)",
    isToeicFrameDrillDocId(toeicFrameDrillSessionDocId("0f8e9a5b-1c2d-4e3f-8a9b-0c1d2e3f4a5b")) && !isToeicFrameDrillDocId("fd-a/b12345678") && !isToeicFrameDrillDocId("fd-abc") && !isToeicFrameDrillDocId("abcdefgh123"),
  );
  add(
    "표현 도우미: 진행 경로는 막힘 · 결과·폴더 탭은 아님",
    isPhraseHelperExamPath("/toeic/guides/q5_7/frame-drill/take") && !isPhraseHelperExamPath("/toeic/guides/q5_7/frame-drill/fd-abc12345") && !isPhraseHelperExamPath("/toeic/guides/q5_7"),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 3. 파일 백엔드 실제 동작(자식 프로세스 — 임시 cwd)
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const st = store.getStore();
const file = JSON.parse(process.env.EVAL_FILE);
const out = { backend: process.env.STORE_BACKEND };
const at = "2026-10-03T00:00:00.000Z";
const r1 = await st.importToeicFrameDrill(file, at);
out.import1 = r1.kind === "ok" ? [r1.result.created, r1.result.unchanged] : r1.kind;
const r2 = await st.importToeicFrameDrill(file, "2026-10-03T00:05:00.000Z");
out.import2 = r2.kind === "ok" ? [r2.result.created, r2.result.unchanged, r2.result.bank.updatedAt] : r2.kind;
const sess = {
  part: "q5_7", topicKeys: ["shop"], questionTypeKeys: [], excludedFrameKeys: [], requested: 2,
  startedAt: "2026-10-03T00:10:00.000Z", finishedAt: "2026-10-03T00:12:00.000Z", ended: "done",
  items: [
    { itemId: "buy-more-s1", frameKey: "buy-more", ko: "k1", en: "These days I buy more apples.", frame: "These days I buy more ~", outcome: "no_speech", transcript: null, verdict: null, reasonKo: null, fixedEn: null },
    { itemId: "buy-more-s2", frameKey: "buy-more", ko: "k2", en: "These days I buy more boxes.", frame: "These days I buy more ~", outcome: "transcribe_failed", transcript: null, verdict: null, reasonKo: null, fixedEn: null },
  ],
  review: null, statsAppliedAt: null, supply: null,
};
const c1 = await st.createToeicFrameDrillSession("fd-evalchild1", sess);
const c2 = await st.createToeicFrameDrillSession("fd-evalchild1", { ...sess, requested: 9 });
out.create = [c1.reused, c2.reused, c2.record.requested];
const [j1, j2] = await Promise.all([st.judgeToeicFrameDrillSession("fd-evalchild1", null, "2026-10-03T00:13:00.000Z"), st.judgeToeicFrameDrillSession("fd-evalchild1", null, "2026-10-03T00:13:01.000Z")]);
out.judge = [j1.kind, j2.kind].sort();
out.stats1 = (await st.getToeicFrameDrillStats()).items;
const s1 = await st.startToeicFrameDrillSupply("fd-evalchild1", Date.parse("2026-10-03T00:14:00.000Z"), "2026-10-03T00:14:00.000Z");
out.supply1 = s1.start.kind === "skip" ? ["skip", s1.start.reason] : [s1.start.kind];
const s2 = await st.startToeicFrameDrillSupply("fd-evalchild1", Date.parse("2026-10-03T00:15:00.000Z"), "2026-10-03T00:15:00.000Z");
out.supply2 = s2.start.kind;
const r3 = await st.importToeicFrameDrill({ ...file, items: file.items.slice(1) }, "2026-10-03T00:20:00.000Z");
out.import3 = r3.kind === "ok" ? [r3.result.removed, r3.result.unchanged] : r3.kind;
out.stats2 = (await st.getToeicFrameDrillStats()).items;
out.list = (await st.listToeicFrameDrillSessions()).map((s) => [s.id, s.review !== null, s.supply && s.supply.status]);
out.missing = [await st.judgeToeicFrameDrillSession("fd-nope12345", null, at), await st.startToeicFrameDrillSupply("fd-nope12345", 0, at)];
console.log("@@RESULT@@" + JSON.stringify(out));
`;

function runFileBackendChecks(): FrameDrillAppCheckResult[] {
  const results: FrameDrillAppCheckResult[] = [];
  const add = adder(results, "틀 말하기 앱 ③ 파일 백엔드");
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-frame-app-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "db.json"), JSON.stringify({}));
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
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
        EVAL_STORE_URL: pathToFileURL(path.join(ROOT, "lib/store.ts")).href,
        EVAL_FILE: JSON.stringify(fixtureFile(2)),
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 800)}`);
      return results;
    }
    const o = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    add("백엔드 file(임시 cwd — 저장소 data/db.json 무관)", o.backend === "file");
    add("가져오기: 처음 created 4 · 같은 파일 다시 = unchanged(updatedAt 그대로)", eqJson(o.import1, [4, false]) && eqJson(o.import2, [0, true, AT]), JSON.stringify([o.import1, o.import2]));
    add("판 저장 멱등: 같은 id 두 번 → 두 번째 reused · 내용은 처음 것", eqJson(o.create, [false, true, 2]), JSON.stringify(o.create));
    add("판정 동시 두 요청(AI 0 판) → 하나만 write, 하나는 already(원자 단위)", eqJson(o.judge, ["already", "write"]), JSON.stringify(o.judge));
    add(
      "통계 한 번: 무응답 = 시도 1·오답 1 · 전사 실패 = 줄 없음",
      eqJson(o.stats1, { "buy-more-s1": { attempts: 1, wrong: 1, lastAt: "2026-10-03T00:13:00.000Z" } }) ||
        eqJson(o.stats1, { "buy-more-s1": { attempts: 1, wrong: 1, lastAt: "2026-10-03T00:13:01.000Z" } }),
      JSON.stringify(o.stats1),
    );
    add("보충: 표본 부족 → skip sample(skipped 표시) · 다시 열면 already(호출 F 0회)", eqJson(o.supply1, ["skip", "sample"]) && o.supply2 === "already", JSON.stringify([o.supply1, o.supply2]));
    add("다시 가져오기(문항 하나 뺌): removed 1 · **통계 문서는 그대로**(빠진 문항 줄도 남는다)", eqJson(o.import3, [1, false]) && eqJson(o.stats2, o.stats1), JSON.stringify([o.import3, o.stats2]));
    add("판 목록: 판정·보충 표시가 남는다 · 없는 id → null", eqJson(o.list, [["fd-evalchild1", true, "skipped"]]) && eqJson(o.missing, [null, null]), JSON.stringify([o.list, o.missing]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 4. 소스 배선
// ---------------------------------------------------------------------------

function runSourceChecks(): FrameDrillAppCheckResult[] {
  const results: FrameDrillAppCheckResult[] = [];
  const add = adder(results, "틀 말하기 앱 ④ 소스 배선");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
  const judge = read("app/api/toeic/frame-drill/sessions/[id]/judge/route.ts");
  const supply = read("app/api/toeic/frame-drill/sessions/[id]/supply/route.ts");
  const imp = read("app/api/toeic/frame-drill/import/route.ts");
  const sess = read("app/api/toeic/frame-drill/sessions/route.ts");
  const keyBefore = (src: string, call: string) => {
    const k = src.indexOf("process.env.OPENAI_API_KEY");
    const c = src.indexOf(call + "(");
    return k > 0 && c > 0 && k < c;
  };
  add("판정 라우트: 키 검사가 호출 E보다 앞(call일 때만 — already·no_ai는 키 없이)", keyBefore(judge, "judgeFrameDrill") && /if \(decision === "call"\) \{\s*\/\/[^\n]*\n\s*if \(!process\.env\.OPENAI_API_KEY\)/.test(judge));
  add("보충 라우트: 키 검사가 호출 F보다 앞 · 키 없음이면 잡은 표시를 failed로 되돌림", keyBefore(supply, "supplyFrameDrillItems") && /finishToeicFrameDrillSupply\(id, null, "no_api_key"/.test(supply));
  add("가져오기·판 저장 라우트: AI·키 검사 없음(키 없이도 저장)", !/OPENAI_API_KEY|lib\/ai\/toeic\/calls/.test(imp) && !/OPENAI_API_KEY|lib\/ai\/toeic\/calls/.test(sess));
  add("라우트 4개 모두 runtime nodejs", [judge, supply, imp, sess].every((src) => /export const runtime = "nodejs";/.test(src)));
  add("판정·보충 라우트: 문서 id 모양 검사(isToeicFrameDrillDocId) — `/`가 든 값이 하위 경로를 가리키지 않게", /isToeicFrameDrillDocId\(id\)/.test(judge) && /isToeicFrameDrillDocId\(id\)/.test(supply));
  add("로그에 문장·전사문 없음(판정·보충 라우트는 개수·ms·이름만)", ![judge, supply].some((src) => /console\.[a-z]+\([^)]*(transcript|\.ko\b|\.en\b|summaryKo)/.test(src)));

  // 화면 번들 경계 — 클라이언트 컴포넌트·순수 모듈이 lib/ai·store·openai·zod 값을 import하지 않는다
  const clientFiles = [
    "components/toeic-frame-drill-tab.tsx",
    "components/toeic-frame-drill-runner.tsx",
    "components/toeic-frame-drill-result.tsx",
    "components/toeic-frame-drill-import-button.tsx",
    "lib/toeic-frame-drill-view.ts",
    "lib/toeic-frame-drill-record.ts",
    "lib/toeic-frame-drill-contract.ts",
  ];
  const leaks = clientFiles.filter((f) => /from "(@\/lib\/ai\/|\.\/ai\/|\.\.\/ai\/|@\/lib\/store|\.\/store|openai|zod)/.test(read(f).replace(/import type [^;]+;/g, "")));
  add("화면·순수 모듈 번들 경계: lib/ai·store·openai·zod 값 import 0", leaks.length === 0, leaks.join(", "));
  add("순수 모듈 lookbehind 0(구형 iOS Safari)", !["lib/toeic-frame-drill-view.ts", "lib/toeic-frame-drill-record.ts", "lib/toeic-frame-drill-contract.ts"].some((f) => /\(\?<[=!]/.test(read(f))));
  const runner = read("components/toeic-frame-drill-runner.tsx");
  add(
    "진행 화면: 표현 도우미 블록 · 녹음 owner · 첫 녹음 권한 대기 15초 · 소리 없음(speakQueue·prefetchSpeech 0)",
    /usePhraseHelperBlock\(\)/.test(runner) && /owner: TOEIC_FRAME_DRILL_MIC_OWNER/.test(runner) && /MIC_CHECK_GUM_TIMEOUT_MS/.test(runner) && !/speakQueue\(|prefetchSpeech\(|speak\(/.test(runner),
  );
  add("진행 화면: 전사 라우트에 녹음만(정답·틀을 보내지 않는다)", /fd\.append\(TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO/.test(runner) && !/fd\.append\([^)]*(\.en|\.frame|\.ko)/.test(runner));
  // QA frame-drill_1 P2-A — 문항 일감은 endItem이 stop을 부르는 그 자리에서 동기 등록(finish가 반드시 기다린다), 저장이 시작된 뒤엔 전사를 보내지 않는다
  const endItemSrc = runner.slice(runner.indexOf("const endItem = useCallback"), runner.indexOf("const openItem = useCallback"));
  add(
    "진행 화면(QA P2-A): endItem이 track(i, (async … rec.stop() …)())로 일감을 동기 등록 · 진행·마무리 단계에서만 전사",
    /track\(\s*i,\s*\(async \(\) => \{\s*const result = await rec\.stop\(\)/.test(endItemSrc) &&
      /if \(stageRef\.current !== "run" && stageRef\.current !== "finishing"\) return;\s*await transcribe\(i, result\);/.test(endItemSrc) &&
      !/pendingRef\.current\.set/.test(runner.slice(runner.indexOf("const transcribe = useCallback"), runner.indexOf("const track = useCallback"))),
  );
  add(
    "진행 화면(QA P3-B): 전사 501·녹음 없이 문항 열기에서 마이크를 놓는다",
    /noMicRef\.current = true;\s*keeperRef\.current\?\.release\(\);/.test(runner) && /if \(noMicRef\.current\) \{\s*keeperRef\.current\?\.release\(\);/.test(runner),
  );
  add("진행 화면(QA P3-C): 저장하지 않은 까닭별 문구(본 문항 0 · 녹음 0)", /setUnsavedWhy\(done\.length === 0 \? "none" : "norec"\)/.test(runner) && /모범 영어까지 본 문항이 없어/.test(runner));
  const result = read("components/toeic-frame-drill-result.tsx");
  add("결과 화면: 🔊는 탭할 때만(speak가 onClick 안에만 — 자동 재생·미리 받기 0)", (result.match(/speak\(/g) ?? []).length === 2 && (result.match(/onClick=\{\(\) => speak\(/g) ?? []).length === 2 && !/prefetchSpeech|speakQueue/.test(result));
  const store = read("lib/store.ts");
  add("새 컬렉션 체크리스트: DbShape·emptyDb·readDb·mergeDbForSeed(mergeById)·seed.ts", /toeicFrameBank: ToeicFrameBankDoc\[\]/.test(store) && /toeicFrameBank: \[\], toeicFrameDrills: \[\]/.test(store) && /parsed\.toeicFrameBank \?\? \[\]/.test(store) && /mergeById\(cur\.toeicFrameDrills, seed\.toeicFrameDrills\)/.test(store) && /toeicFrameDrills: \[\]/.test(read("scripts/seed.ts")));
  add("migrate-to-firestore에 넣지 않았다(교재 유래 — 앱 가져오기로만)", !/toeicFrame/.test(read("scripts/migrate-to-firestore.ts")));
  return results;
}

export function runToeicFrameDrillAppChecks(): FrameDrillAppCheckResult[] {
  return [...runRecordChecks(), ...runViewChecks(), ...runFileBackendChecks(), ...runSourceChecks()];
}

export type { ToeicFrameDrillItem };

/**
 * scripts/eval-toeic-guides-s3.ts — 유형별 공략 **S3 앱 층**(T9 한 문제 연습 · T12 실전 적용) 오프라인 검증 — scripts/eval-toeic.ts가 부른다.
 *
 * - 레코드·정규화(§12-3): `ToeicMockRecord.drillPart`(옛 문서 = null)·`ToeicAttemptRecord.questions`(옛 문서 = 파트 문항), 연습 가리기
 *   (`isToeicDrill`·`listableToeicMocks` — 먼저 빼고 skippedCount), 모의고사 제목 번호가 연습을 무시.
 * - 녹음 보관 풀(§12-7-6): 연습 6회가 채점 전 실전 녹음을 지우지 않는다, 옛 메타 = mock 풀.
 * - 연습 화면 순수 함수(lib/toeic-drill-view): "뒤로"·최근 연습 상태·응시 전 연습·폴더 카드·목표 등급 기억·비용 캡션·단계마다 틀 하나·
 *   🧩 틀 점검(쓴 틀·빠진 단계·쓸 수 있었던 틀 — 채점 전은 모범답변만)·틀 점검 자료(예문·테스트 채움을 넘기지 않는다).
 * - 사진 연습 상태코드(§12-10): 사진 slot 1은 칸이 없어 404 picture_not_found(판정이 키 검사·관문 P 앞 — 소스 대조 + 순수 판정),
 *   끝내기 Q4 = 범위 밖 400·채점 Q4 = 404 question_not_found(라우트가 attempt.questions로 범위를 잡는다 — 소스 대조).
 * - **파일 백엔드 실행**(자식 프로세스 — 임시 폴더를 cwd로 둔 새 프로세스에서 getStore(): listToeicDrills·옛 문서 정규화·questions 저장).
 *   이 프로세스는 이미 lib/store를 불러 저장소 data/db.json을 가리키므로 여기서 스토어를 만들지 않는다(전후 sha로 확인).
 * - 소스 대조(eval은 라우트 핸들러를 부르지 않는다): 연습 라우트(키 먼저 → 404 → 본문, 세션을 setId로 가름, 보낸 목록 = 저장 목록,
 *   drillPart 저장), regenerate 409 is_drill(키 검사 앞), 시작·끝내기·채점 라우트의 범위 원천, 응시 화면 지시문 세 곳·"뒤로"·녹음 풀,
 *   결과 화면 묘사 포인트/답변 뼈대·"학습 보기로" 숨김·틀 점검·영어 표현 칩 줄바꿈(QA final P2-2), 학습 보기 리다이렉트, 모의고사 목록, 스토어 등호 쿼리, 연습 탭(자동 사진 요청 없음).
 *
 * 공개 저장소: 픽스처는 전부 **지어낸 영어·한국어**다. 실호출 0.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToeicMockParts, ToeicPicturePart, ToeicTemplate, ToeicTemplateFlow } from "../lib/ai/toeic/schemas";
import type { ToeicMockRecord } from "../lib/store";
import { toDrillRecordPart } from "../lib/toeic-drill";
import {
  drillStepPicks,
  drillTemplateCheck,
  parseDrillGrade,
  pendingToeicDrills,
  summarizeToeicDrill,
  toeicDrillCheckData,
  toeicDrillCostCaptionKo,
  toeicDrillFolderCard,
  toeicDrillFolderHref,
  toeicDrillStatusKo,
  toeicMockBackLink,
  type ToeicDrillCheckData,
} from "../lib/toeic-drill-view";
import { TOEIC_TEMPLATE_BANK_ID } from "../lib/toeic-guide";
import { nextToeicMockTitle } from "../lib/toeic-mock-contract";
import { decidePictureImage } from "../lib/toeic-mock-apply";
import { normalizeToeicAttemptRecord, normalizeToeicMockRecord } from "../lib/toeic-normalize";
import type { ToeicQuizSessionLike } from "../lib/toeic-quiz";
import { isToeicDrill, listableToeicMocks } from "../lib/toeic-record";
import { pickAttemptsToEvict, pickAttemptsToEvictByPool, toeicRecPoolOf } from "../lib/toeic-rec-store";
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
/** a가 b보다 앞에 있다(둘 다 있어야 한다) */
const before = (src: string, a: string, b: string) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};
/** CSS 모듈에서 줄 머리 단일 클래스 규칙(`.name {`)의 본문 · 그 선택자가 줄 머리에 나오는 횟수 */
const cssRule = (css: string, cls: string) => ({
  body: new RegExp(`^\\.${cls} \\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "",
  count: (css.match(new RegExp(`^\\.${cls}\\b`, "gm")) ?? []).length,
});
/** 칩 안 줄바꿈(QA final P2-2) — 전역 .u-chip의 nowrap·flex 항목 min-width: auto를 푼다 */
const chipWraps = (r: { body: string; count: number }) =>
  r.count === 1 &&
  /white-space: normal;/.test(r.body) &&
  /overflow-wrap: anywhere;/.test(r.body) &&
  /min-width: 0;/.test(r.body) &&
  /max-width: 100%;/.test(r.body) &&
  !/nowrap/.test(r.body);
/** lang="en" 칩(u-chip) span들의 className 식 */
const enChipClasses = (tsx: string) =>
  [...tsx.matchAll(/<span\b[^>]*?className=(\{`[^`]*`\}|"[^"]*")[^>]*?lang="en"/g)].map((m) => m[1]).filter((c) => /\bu-chip\b/.test(c));

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 것
// ---------------------------------------------------------------------------

function tpl(key: string, groupKo: string, frameEn: string, frameKo: string, parts: string[], guideRefs: ToeicTemplate["guideRefs"] = []): ToeicTemplate {
  const fill = (f: string[]) => {
    let i = 0;
    return frameEn.replace(/\{[^{}]*\}/g, () => f[i++] ?? "");
  };
  const n = (frameEn.match(/\{[^{}]*\}/g) ?? []).length;
  const fills = [0, 1, 2].map((k) => Array.from({ length: n }, (_x, i) => `word${k}${i}`));
  return {
    key,
    groupKo,
    frameEn,
    frameKo,
    useKo: "지어낸 쓰임 설명",
    parts: parts as ToeicTemplate["parts"],
    source: "new",
    guideRefs,
    examples: fills.map((f) => ({ en: fill(f), ko: "지어낸 해석", fills: f })),
    testFills: [Array.from({ length: n }, (_x, i) => `secret${i}`)],
  };
}

const T_OP = tpl("my-view", "입장 말하기", "In my view, {주장}.", "제 생각에는 {주장}.", ["q11"]);
const T_REASON = tpl("main-reason", "이유 대기", "The main reason is that {이유}.", "가장 큰 이유는 {이유}예요.", ["q11", "q5_7"], [{ kind: "expression", part: "q11", expression: "The key reason is ~" }]);
const T_REASON2 = tpl("another-reason", "이유 대기", "Another reason is that {이유}.", "또 다른 이유는 {이유}예요.", ["q11"]);
const T_EX = tpl("for-instance", "예 들기", "For instance, {예}.", "예를 들어 {예}.", ["q11"]);
const T_SUM = tpl("all-in-all", "정리하기", "All in all, {정리}.", "결국 {정리}.", ["q11"]);
const T_TOPIC = tpl("keeps-me", "건강 소재", "It keeps me {상태}.", "그건 저를 {상태} 유지해 줘요.", ["q11"]);
const T_PIC = tpl("in-the-picture", "장면", "In the picture, I can see {대상}.", "사진에서 {대상}이 보여요.", ["q3_4"]);
const FLOW_Q11 = {
  part: "q11",
  steps: [
    { stepKo: "입장", groupsKo: ["입장 말하기"] },
    { stepKo: "이유", groupsKo: ["이유 대기"] },
    { stepKo: "예시", groupsKo: ["예 들기"] },
    { stepKo: "정리", groupsKo: ["정리하기"] },
    { stepKo: "덧붙임", groupsKo: ["없는 묶음"] },
  ],
  banksKo: ["건강 소재"],
} as unknown as ToeicTemplateFlow;
const FLOW_Q5 = { part: "q5_7", steps: [{ stepKo: "답", groupsKo: ["이유 대기"] }], banksKo: [] } as unknown as ToeicTemplateFlow;
const ITEMS = [T_OP, T_REASON, T_REASON2, T_EX, T_SUM, T_TOPIC, T_PIC];

function sess(mode: "tpl-recall" | "tpl-swap", startedAt: string, items: [string, boolean][]): ToeicQuizSessionLike {
  return { id: `s-${startedAt}`, setId: TOEIC_TEMPLATE_BANK_ID, mode, startedAt, finishedAt: startedAt, items: items.map(([k, c]) => ({ word: `tpl:${k}`, correct: c, answered: true })) };
}

const scene = (place: string) => ({
  place,
  imagePrompt: `A wide photo of a quiet ${place} with a few people.`,
  sceneKo: "조용한 곳",
  sampleAnswer: "This picture shows a quiet place.",
  keyPointsKo: ["장소", "사람"],
  usedExpressions: [],
  image: { status: "pending" as const, imageId: null },
});

function mockRec(over: Partial<ToeicMockRecord>): ToeicMockRecord {
  const parts: ToeicMockParts = { read: null, picture: null, respond: null, info: null, opinion: null };
  return normalizeToeicMockRecord({
    id: "m",
    titleKo: "모의고사 1",
    targetGrade: "IH",
    expressionsUsed: [],
    topicHints: [],
    parts,
    drillPart: null,
    model: "x",
    createdAt: "2026-09-27T00:00:00.000Z",
    sortIndex: null,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. 레코드·정규화·목록 가리기 (§12-3)
// ---------------------------------------------------------------------------

function runRecordChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S3 연습 레코드");
  const oldMock = normalizeToeicMockRecord({ id: "old", titleKo: "모의고사 1", parts: {}, expressionsUsed: [], topicHints: [], createdAt: "2026-09-01T00:00:00.000Z" });
  add(
    "옛 모의고사 문서(drillPart 없음) = null · 다섯 파트 값은 그대로 · 공략 유형 이름·모르는 값은 null",
    oldMock.drillPart === null &&
      normalizeToeicMockRecord({ drillPart: "picture" }).drillPart === "picture" &&
      normalizeToeicMockRecord({ drillPart: "opinion" }).drillPart === "opinion" &&
      normalizeToeicMockRecord({ drillPart: "q3_4" }).drillPart === null &&
      normalizeToeicMockRecord({ drillPart: 3 }).drillPart === null,
  );
  const a = (v: Record<string, unknown>) => normalizeToeicAttemptRecord({ id: "a", mockId: "m", scope: "part", startedAt: "2026-09-27T00:00:00.000Z", answers: [], ...v });
  add(
    "옛 응시 문서(questions 없음) = 파트 문항 · 연습 [3] 그대로 · 중복·범위 밖·글자는 버리고 오름차순 · 비거나 깨지면 파트 문항",
    eqJson(a({ parts: ["picture"] }).questions, [3, 4]) &&
      eqJson(a({ parts: ["picture"], questions: [3] }).questions, [3]) &&
      eqJson(a({ parts: ["respond"], questions: [7, 5, 5, "6", 12, 0, 6.5] }).questions, [5, 7]) &&
      eqJson(a({ parts: ["opinion"], questions: [] }).questions, [11]) &&
      eqJson(a({ parts: ["info"], questions: "8" }).questions, [8, 9, 10]) &&
      eqJson(a({ scope: "full", parts: ["read", "picture", "respond", "info", "opinion"] }).questions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  );
  add("isToeicDrill: drillPart가 있으면 연습(없음·null은 모의고사)", isToeicDrill({ drillPart: "picture" }) && !isToeicDrill({ drillPart: null }) && !isToeicDrill({} as { drillPart: null }));

  // 목록 — 연습을 먼저 빼고 skippedCount(모의고사 3·깨진 모의고사 1·연습 3 → 열지 못한 1, 연습은 세지 않는다)
  const broken = { ...mockRec({ id: "broken" }), parts: "x" } as unknown as ToeicMockRecord;
  const drill = (id: string) => ({ ...mockRec({ id, drillPart: "picture", titleKo: `사진 묘사 연습 ${id}` }), parts: "x" } as unknown as ToeicMockRecord); // 모양이 깨진 연습도 "열지 못한"에 세지 않는다
  const stored = [mockRec({ id: "m1" }), drill("d1"), mockRec({ id: "m2" }), broken, drill("d2"), mockRec({ id: "m3" }), drill("d3")];
  const listed = listableToeicMocks(stored);
  add(
    "모의고사 목록: 연습을 먼저 빼고 → 렌더 판정 → skippedCount(연습 3개가 있어도 '열지 못한 n' = 깨진 모의고사 수만)",
    eqJson(listed.mocks.map((m) => m.id), ["m1", "m2", "m3"]) && listed.skippedCount === 1,
    `${listed.mocks.map((m) => m.id).join(",")} skipped=${listed.skippedCount}`,
  );
  add(
    "listableToeicMocks: 연습만 있으면 목록 0·열지 못한 0",
    eqJson(listableToeicMocks([drill("x1"), drill("x2"), drill("x3")]), { mocks: [], skippedCount: 0 }),
  );
  const titles = [mockRec({ titleKo: "모의고사 1" }), mockRec({ titleKo: "모의고사 2" }), ...Array.from({ length: 7 }, (_x, i) => mockRec({ titleKo: `사진 묘사 연습 ${i + 1}`, drillPart: "picture" }))];
  add(
    "모의고사 제목 번호는 연습을 빼고 센다(연습 7개가 있어도 \"모의고사 3\")",
    nextToeicMockTitle(titles.filter((m) => !isToeicDrill(m)).map((m) => m.titleKo)) === "모의고사 3" && nextToeicMockTitle(titles.map((m) => m.titleKo)) !== "모의고사 3",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 2. 녹음 보관 풀 (§12-7-6)
// ---------------------------------------------------------------------------

function runRecPoolChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S3 녹음 보관 풀");
  add("toeicRecPoolOf: pool 없음(옛 메타)·모르는 값 = mock, \"drill\"만 drill", toeicRecPoolOf({}) === "mock" && toeicRecPoolOf({ pool: "x" }) === "mock" && toeicRecPoolOf({ pool: "drill" }) === "drill" && toeicRecPoolOf({ pool: "mock" }) === "mock");
  // 채점 전 실전 응시 1회(옛 메타 — pool 없음, 가장 오래됨) + 연습 6회
  const entries = [
    { attemptId: "real", q: 3, createdAt: 1000 },
    { attemptId: "real", q: 11, createdAt: 1100 },
    ...Array.from({ length: 6 }, (_x, i) => ({ attemptId: `drill-${i + 1}`, q: 3, createdAt: 2000 + i * 100, pool: "drill" })),
  ];
  const byPool = pickAttemptsToEvictByPool(entries, 5, "drill-6");
  const flat = pickAttemptsToEvict(entries, 5, "drill-6");
  add(
    "연습 6회가 채점 전 실전 녹음을 지우지 않는다(풀마다 최근 5회 — 연습 풀에서 가장 오래된 것만)",
    eqJson(byPool, ["drill-1"]) && flat.includes("real"),
    `풀별=${byPool.join(",")} · 옛 방식=${flat.join(",")}`,
  );
  const mocks = Array.from({ length: 6 }, (_x, i) => ({ attemptId: `mock-${i + 1}`, q: 1, createdAt: 100 * (i + 1), pool: i % 2 === 0 ? undefined : "mock" }));
  add("모의고사 풀은 그대로 최근 5회(옛 메타·pool mock 섞여도 한 풀)", eqJson(pickAttemptsToEvictByPool(mocks, 5, "mock-6"), ["mock-1"]));
  add("지금 쓰는 응시는 늘 남긴다(keepAlso)", eqJson(pickAttemptsToEvictByPool(entries, 1, "drill-1"), ["drill-5", "drill-4", "drill-3", "drill-2"]));
  const store = read("lib/toeic-rec-store.ts");
  add(
    "저장이 메타에 pool을 적고(toeicRecPoolOf) 정리는 풀별(pickAttemptsToEvictByPool), 옛 메타는 읽을 때 mock",
    /pool: toeicRecPoolOf\(rec\)/.test(store) && /pickAttemptsToEvictByPool\(metas, TOEIC_REC_KEEP_ATTEMPTS, current\)/.test(store) && /pool: toeicRecPoolOf\(m\)/.test(store) && !/new Set\(pickAttemptsToEvict\(metas/.test(store),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 3. 연습 화면 순수 함수 (lib/toeic-drill-view)
// ---------------------------------------------------------------------------

function runDrillViewChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S3 연습 화면 순수 함수");

  const bPic = toeicMockBackLink({ id: "d1", drillPart: "picture" });
  const bOp = toeicMockBackLink({ id: "d2", drillPart: "opinion" });
  const bMock = toeicMockBackLink({ id: "m 1", drillPart: null });
  add(
    "\"뒤로\": 연습 → 그 유형 폴더 ④ 탭(\"← Q3–4 공략\"·\"🧭 Q3–4 공략으로\"), 모의고사 → 학습 보기(기존 문구)",
    bPic.href === "/toeic/guides/q3_4?tab=drill" && bPic.labelKo === "← Q3–4 공략" && bPic.buttonKo === "🧭 Q3–4 공략으로" &&
      bOp.href === "/toeic/guides/q11?tab=drill" && bOp.labelKo === "← Q11 공략" &&
      bMock.href === "/toeic/mocks/m%201" && bMock.labelKo === "← 학습 보기" && bMock.buttonKo === "학습 보기로",
    `${bPic.href} ${bOp.href} ${bMock.href}`,
  );
  add(
    "toeicDrillFolderHref: 네 파트 → 네 폴더 ④ 탭, 연습이 없는 파트(read) → 폴더 목록",
    toeicDrillFolderHref("picture") === "/toeic/guides/q3_4?tab=drill" &&
      toeicDrillFolderHref("respond") === "/toeic/guides/q5_7?tab=drill" &&
      toeicDrillFolderHref("info") === "/toeic/guides/q8_10?tab=drill" &&
      toeicDrillFolderHref("opinion") === "/toeic/guides/q11?tab=drill" &&
      toeicDrillFolderHref("read") === "/toeic/guides",
  );

  // 최근 연습 상태
  const pic = (status: "pending" | "ready" | "failed") => {
    const p: ToeicPicturePart = { items: [{ ...scene("park"), image: { status, imageId: status === "ready" ? "img" : null } }] };
    return mockRec({ id: `p-${status}`, drillPart: "picture", parts: { read: null, picture: p, respond: null, info: null, opinion: null } });
  };
  const att = (id: string, mockId: string, startedAt: string, questions: number[], answers: [number, boolean, number | null][]) => ({
    id,
    mockId,
    startedAt,
    questions,
    answers: answers.map(([q, recorded, score]) => ({ q, recorded, score })),
  });
  const respond = mockRec({ id: "r1", drillPart: "respond", parts: { read: null, picture: null, respond: {} as never, info: null, opinion: null } });
  const sPend = summarizeToeicDrill(pic("pending"), []);
  const sReady = summarizeToeicDrill(pic("ready"), [att("x", "other", "2026-09-27T01:00:00.000Z", [3], [[3, true, 3]])]);
  const sRec = summarizeToeicDrill(respond, [
    att("old", "r1", "2026-09-27T01:00:00.000Z", [5, 6, 7], [[5, true, 3], [6, true, 3], [7, true, 3]]),
    att("new", "r1", "2026-09-27T02:00:00.000Z", [5, 6, 7], [[5, true, 2], [6, true, null], [7, false, null]]),
  ]);
  const sDone = summarizeToeicDrill(respond, [att("a", "r1", "2026-09-27T02:00:00.000Z", [5, 6, 7], [[5, true, 2], [6, true, 3], [7, false, null]])]);
  const sQ4 = summarizeToeicDrill(pic("ready"), [att("q", "p-ready", "2026-09-27T02:00:00.000Z", [3], [[3, true, 2], [4, true, 3]])]);
  add(
    "상태: 사진 pending·응시 없음 = \"사진 준비 중\" · 준비됨/다른 문서 응시만 = \"응시 전\" · 가장 늦은 응시로 \"녹음 n · 채점 m\" · 다 채점 = \"점수 합 / 만점\"",
    toeicDrillStatusKo(sPend) === "사진 준비 중" &&
      toeicDrillStatusKo(sReady) === "응시 전" && sReady.attemptCount === 0 &&
      toeicDrillStatusKo(sRec) === "녹음 2 · 채점 1" && sRec.latest?.id === "new" && sRec.attemptCount === 2 &&
      toeicDrillStatusKo(sDone) === "점수 5 / 9" &&
      toeicDrillStatusKo(sQ4) === "점수 2 / 3",
    [sPend, sReady, sRec, sDone, sQ4].map(toeicDrillStatusKo).join(" | "),
  );
  add(
    "최근 연습 한 줄에 파트 본문(모범답변·장면)이 없다 — 응시 전 노출 방지",
    !JSON.stringify([sPend, sRec]).includes("sampleAnswer") && !JSON.stringify(sPend).includes("This picture shows"),
  );
  const list = [sRec, sPend, sReady];
  add("응시 전 연습 = 응시 기록 0(받은 순서 그대로 — 첫 줄이 가장 최근)", eqJson(pendingToeicDrills(list).map((s) => s.id), ["p-pending", "p-ready"]));
  add(
    "폴더 카드: 연습 수와 최신순으로 처음 만나는 다 채점한 연습의 점수",
    eqJson(toeicDrillFolderCard([sRec, sDone, sPend]), { count: 3, lastScoreKo: "5/9" }) && eqJson(toeicDrillFolderCard([sPend]), { count: 1, lastScoreKo: null }),
  );
  add("목표 등급 기억: 모르는 값·없음 = IH, 세 값은 그대로", parseDrillGrade(null) === "IH" && parseDrillGrade("AL") === "AL" && parseDrillGrade("IM3") === "IM3" && parseDrillGrade("ih") === "IH" && parseDrillGrade("") === "IH");
  const cPic = toeicDrillCostCaptionKo("q3_4");
  const cOp = toeicDrillCostCaptionKo("q11");
  add(
    "비용 캡션: AI 문제 만들기 1회 + 폴더·공략 듣기는 AI 0, 사진 폴더에만 \"사진 1장 포함\"",
    cPic.includes("AI 문제 만들기 1회") && cPic.includes("사진 1장 포함") && cPic.includes("AI 0") && cOp.includes("AI 문제 만들기 1회") && !cOp.includes("사진"),
    `${cPic} | ${cOp}`,
  );

  // 단계마다 틀 하나 — 두 모드 합친 약함, 같으면 파일 순서(결정적), 틀 없는 단계는 null
  const sessions = [sess("tpl-recall", "2026-09-20T00:00:00.000Z", [["main-reason", true], ["another-reason", false], ["my-view", true]])];
  const picks = drillStepPicks(ITEMS, sessions, "q11", [FLOW_Q11, FLOW_Q5]);
  add(
    "drillStepPicks: 단계마다 가장 약한 틀(틀린 틀 > 안 해 봄 > 진행 중), 같은 약함은 파일 순서, 틀 없는 단계 = null",
    eqJson(
      picks.map((p) => [p.stepKo, p.template?.key ?? null]),
      [["입장", "my-view"], ["이유", "another-reason"], ["예시", "for-instance"], ["정리", "all-in-all"], ["덧붙임", null]],
    ) && eqJson(drillStepPicks(ITEMS, sessions, "q11", [FLOW_Q11]), picks),
    picks.map((p) => `${p.stepKo}:${p.template?.key ?? "-"}`).join(" "),
  );
  add("drillStepPicks: 흐름이 없는 유형은 빈 배열, 다른 유형 틀은 들어가지 않는다", drillStepPicks(ITEMS, [], "q8_10", [FLOW_Q11]).length === 0 && drillStepPicks(ITEMS, [], "q5_7", [FLOW_Q5])[0].template?.key === "main-reason");

  // 🧩 틀 점검
  const data: ToeicDrillCheckData = toeicDrillCheckData("q11", ITEMS.filter((t) => t.parts.includes("q11")), [FLOW_Q11, FLOW_Q5], sessions);
  add(
    "틀 점검 자료: 그 유형 흐름만·예문·테스트 채움(정답 채움)을 넘기지 않는다·단계마다 가장 약한 틀 key",
    data.flows.length === 1 && data.flows[0].part === "q11" && !JSON.stringify(data).includes("secret") && !JSON.stringify(data).includes("examples") &&
      eqJson(data.stepPicks.map((p) => p.key), ["my-view", "another-reason", "for-instance", "all-in-all", null]),
  );
  const said = "In my view, remote work is great. For instance, I save an hour a day. It keeps me calm.";
  const r1 = drillTemplateCheck(data, { transcript: said, sampleUsedExpressions: ["The main reason is that ~"], tryExpressions: ["It keeps me ~", "All in all, ~"] });
  add(
    "쓴 틀(전사문 순서·단계/묶음 이름) · 빠진 단계(쓴 틀이 없는 단계 — 소재 묶음 틀은 단계를 채우지 않는다)",
    r1.scored && r1.flowChecked &&
      eqJson(r1.used, [
        { key: "my-view", stepKo: "입장", groupKo: "입장 말하기" },
        { key: "for-instance", stepKo: "예시", groupKo: "예 들기" },
        { key: "keeps-me", stepKo: null, groupKo: "건강 소재" },
      ]) &&
      eqJson(r1.missingSteps, ["이유", "정리", "덧붙임"]),
    `${r1.used.map((u) => u.key).join(",")} / ${r1.missingSteps.join(",")}`,
  );
  // §12-13-3 검토 B4(2026-10-02) — 옛 순서(모범답변 → 피드백 → 빠진 단계)를 교체: 빠진 단계(그 단계의 모범답변 틀 우선, 없으면 가장 약한 틀)
  // → 피드백 → 남은 모범답변. 이유 단계는 모범답변 틀(main-reason), 정리 단계는 가장 약한 틀(all-in-all), 덧붙임은 틀이 없다
  add(
    "쓸 수 있었던 틀: 빠진 단계(그 단계 모범답변 틀 → 없으면 가장 약한 틀) → 피드백(내가 쓴 틀 제외) → 모범답변, 겹치지 않게",
    eqJson(
      r1.suggestions.map((x) => [x.key, x.source]),
      [["main-reason", "step"], ["all-in-all", "step"]],
    ),
    r1.suggestions.map((x) => `${x.key}:${x.source}`).join(" "),
  );
  const r2 = drillTemplateCheck(data, { transcript: null, sampleUsedExpressions: ["The key reason is ~", "For instance, ~"], tryExpressions: ["All in all, ~"] });
  add(
    "채점 전(전사문 없음): 모범답변이 쓴 틀만(교재 표현 글자로도 되짚는다 — guideRefs), 쓴 틀·빠진 단계 없음",
    !r2.scored && r2.used.length === 0 && r2.missingSteps.length === 0 && eqJson(r2.suggestions.map((x) => [x.key, x.source]), [["main-reason", "sample"], ["for-instance", "sample"]]),
    r2.suggestions.map((x) => x.key).join(","),
  );
  const q5 = toeicDrillCheckData("q5_7", ITEMS.filter((t) => t.parts.includes("q5_7")), [FLOW_Q5], []);
  const r3 = drillTemplateCheck(q5, { transcript: "I do not know.", sampleUsedExpressions: [], tryExpressions: [] });
  add("Q5–7은 빠진 단계를 내지 않는다(질문마다 짧게 답한다)", r3.scored && !r3.flowChecked && r3.missingSteps.length === 0 && r3.suggestions.length === 0);
  const r4 = drillTemplateCheck(data, { transcript: "Um.", sampleUsedExpressions: [], tryExpressions: [] });
  add("무응답도 전사문으로 본다 — 쓴 틀 0 · 빠진 단계 = 틀이 있는 단계의 가장 약한 틀(최대 5)", r4.scored && r4.used.length === 0 && r4.suggestions.length === 4 && r4.suggestions.every((x) => x.source === "step"));
  const r5 = drillTemplateCheck(data, { transcript: "The main reason is that it is quiet.", sampleUsedExpressions: ["The main reason is that ~"], tryExpressions: [] });
  add("내가 쓴 틀은 쓸 수 있었던 틀에서 빠진다", r5.used.some((u) => u.key === "main-reason") && !r5.suggestions.some((x) => x.key === "main-reason"));

  // 사진 slot 1 — 연습 문서에는 칸이 하나뿐(판정이 missing → 라우트 404 picture_not_found)
  const twoScenes: ToeicPicturePart = { items: [scene("park"), scene("station")] };
  const one = toDrillRecordPart("picture", twoScenes, () => 0.99);
  const drillDoc = mockRec({ id: "dp", drillPart: "picture", parts: { read: null, picture: one, respond: null, info: null, opinion: null } });
  add(
    "사진 연습 문서는 칸 하나 — slot 1 판정 missing(라우트 404 picture_not_found), slot 0은 apply",
    drillDoc.parts.picture?.items.length === 1 && decidePictureImage(drillDoc, 1, one.items[0].imagePrompt) === "missing" && decidePictureImage(drillDoc, 0, one.items[0].imagePrompt) === "apply",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 4. 파일 백엔드 실행 — 자식 프로세스(임시 cwd)에서 getStore()
// ---------------------------------------------------------------------------

/** 옛 문서(필드 없음) — 임시 폴더의 db.json에 그대로 둔다 */
const CHILD_DB = {
  toeicMocks: [
    { id: "legacy-mock", titleKo: "모의고사 1", targetGrade: "IH", expressionsUsed: [], topicHints: [], parts: { read: null, picture: null, respond: null, info: null, opinion: null }, model: "x", createdAt: "2026-09-01T00:00:00.000Z", sortIndex: null },
  ],
  toeicAttempts: [{ id: "legacy-attempt", mockId: "legacy-mock", scope: "part", parts: ["picture"], startedAt: "2026-09-01T01:00:00.000Z", finishedAt: null, answers: [] }],
};

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const st = store.getStore();
const parts = (p) => ({ read: null, picture: null, respond: null, info: null, opinion: null, ...p });
const base = { targetGrade: "IH", expressionsUsed: ["In my view, ~"], topicHints: ["공원"], model: "x" };
const sleep = () => new Promise((r) => setTimeout(r, 8));
const p1 = await st.createToeicMock({ ...base, titleKo: "사진 묘사 연습 1", parts: parts({ picture: { items: [] } }), drillPart: "picture" });
await sleep();
const o1 = await st.createToeicMock({ ...base, titleKo: "의견 말하기 연습 1", parts: parts({ opinion: {} }), drillPart: "opinion" });
await sleep();
const p2 = await st.createToeicMock({ ...base, titleKo: "사진 묘사 연습 2", parts: parts({ picture: { items: [] } }), drillPart: "picture" });
await sleep();
const m1 = await st.createToeicMock({ ...base, titleKo: "모의고사 2", parts: parts({}), drillPart: null });
const pics = await st.listToeicDrills("picture");
const ops = await st.listToeicDrills("opinion");
const res = await st.listToeicDrills("respond");
const legacy = await st.getToeicMock("legacy-mock");
const legacyAttempt = await st.getToeicAttempt("legacy-attempt");
const att = await st.createToeicAttempt({ mockId: p2.id, scope: "part", parts: ["picture"], questions: [3], startedAt: new Date().toISOString(), finishedAt: null, answers: [] });
const attRead = await st.getToeicAttempt(att.id);
const all = await st.listToeicMocks();
console.log("@@RESULT@@" + JSON.stringify({
  cwd: process.cwd(),
  pics: pics.map((m) => m.id === p2.id ? "p2" : m.id === p1.id ? "p1" : "?"),
  ops: ops.map((m) => m.id === o1.id ? "o1" : "?"),
  res: res.length,
  legacyDrill: legacy ? legacy.drillPart : "missing",
  legacyQuestions: legacyAttempt ? legacyAttempt.questions : "missing",
  attQuestions: attRead ? attRead.questions : "missing",
  mockDrill: m1.drillPart,
  allCount: all.length,
}));
`;

function sha(file: string): string | null {
  return existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : null;
}

function runFileStoreChildChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S3 연습 — 파일 백엔드 실행");
  const repoDb = path.join(ROOT, "data", "db.json");
  const beforeSha = sha(repoDb);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-s3-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    const dataDir = path.join(dir, "data");
    spawnSync("mkdir", ["-p", dataDir]);
    writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(CHILD_DB));
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [script], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        STORE_BACKEND: "file",
        GOOGLE_APPLICATION_CREDENTIALS: "",
        GOOGLE_CLOUD_PROJECT: "",
        K_SERVICE: "",
        OPENAI_API_KEY: "",
        EVAL_STORE_URL: pathToFileURL(path.join(ROOT, "lib", "store.ts")).href,
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 300)}`);
      return results;
    }
    const out = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    const cwd = realpathSync(String(out.cwd));
    add("자식 프로세스 cwd = 임시 폴더(저장소 data/db.json이 아니다) · STORE_BACKEND=file", cwd === realpathSync(dir) && cwd !== realpathSync(ROOT), "임시 폴더");
    add("listToeicDrills: 그 유형 연습만 최신순(모의고사·다른 유형·옛 문서는 빠진다)", eqJson(out.pics, ["p2", "p1"]) && eqJson(out.ops, ["o1"]) && out.res === 0, JSON.stringify([out.pics, out.ops, out.res]));
    add("옛 모의고사 문서 → drillPart null · 옛 응시 → questions = 파트 문항 [3,4]", out.legacyDrill === null && eqJson(out.legacyQuestions, [3, 4]), JSON.stringify([out.legacyDrill, out.legacyQuestions]));
    add("응시 기록 questions [3] 저장·읽기 그대로 · 모의고사 생성 drillPart null · 전체 목록은 연습도 함께(목록이 먼저 거른다)", eqJson(out.attQuestions, [3]) && out.mockDrill === null && out.allCount === 5, JSON.stringify([out.attQuestions, out.allCount]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("저장소 data/db.json 무접촉(전후 sha 같음)", sha(repoDb) === beforeSha, String(beforeSha));
  return results;
}

// ---------------------------------------------------------------------------
// 5. 소스 대조 — 라우트·스토어·화면·페이지
// ---------------------------------------------------------------------------

function runS3SourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S3 소스 대조");

  // 연습 라우트
  const drillRoute = codeOnly(read("app/api/toeic/guides/[part]/drills/route.ts"));
  add(
    "연습 라우트: 키 검사가 맨 먼저 → 유형 404 part_not_found → 본문 → 호출 C",
    before(drillRoute, "if (!process.env.OPENAI_API_KEY)", "isToeicGuidePart(part)") &&
      before(drillRoute, "isToeicGuidePart(part)", "await req.json()") &&
      before(drillRoute, "await req.json()", "generateMockPart(") &&
      /error: "part_not_found"/.test(drillRoute) &&
      /\}, 404\)/.test(drillRoute),
  );
  add(
    "연습 라우트: 주제 하나(pickDrillTopic — 그 유형 최근 연습의 topicHints) → topicHints [주제]로 호출 C와 문서에 같은 값",
    /pickDrillTopic\(\s*unit\.mockPart,\s*drills\.map\(\(d\) => d\.topicHints\),?\s*\)/.test(drillRoute) &&
      /const topicHints = \[topic\];/.test(drillRoute) &&
      /generateMockPart\(mockPart, \{ targetGrade, topicHints, expressions, answerFlow \}\)/.test(drillRoute) &&
      /createToeicMock\(\{[\s\S]*?topicHints,[\s\S]*?\}\)/.test(drillRoute),
  );
  add(
    "연습 라우트: 세션을 setId로 가른다 — 틀 세션 = guide-templates · 공략 = 그 공략 세트(표현 시험 모드) · 표현집 = setId ∈ 표현집 세트(표현 시험 모드)",
    /templateSessions = quizzes\.filter\(\(q\) => q\.setId === TOEIC_TEMPLATE_BANK_ID\)/.test(drillRoute) &&
      /quizzes\.filter\(isToeicQuizModeSession\)\.filter\(\(q\) => q\.setId === guideId\)/.test(drillRoute) &&
      /quizzes\.filter\(isToeicQuizModeSession\)\.filter\(\(q\) => bookSetIds\.has\(q\.setId\)\)/.test(drillRoute) &&
      /sets\.filter\(\(s\) => !isToeicGuideSet\(s\)\)\.filter\(isRenderableToeicSet\)/.test(drillRoute),
  );
  add(
    "연습 라우트: 보낸 목록 = 저장 목록(normalizeMockExpressions(pickExpressionsForDrill(…)) 한 변수를 호출 C와 expressionsUsed에)",
    /expressions = normalizeMockExpressions\(\s*pickExpressionsForDrill\(/.test(drillRoute) && /expressionsUsed: expressions,/.test(drillRoute) && /expressionsCount: expressions\.length/.test(drillRoute),
  );
  add(
    "연습 라우트: 사진이면 한 장면만(toDrillRecordPart) · drillPart = 그 파트 · 제목 nextToeicDrillTitle(같은 유형 연습 제목) · 틀은 렌더 가능한 것만",
    /toDrillRecordPart\(mockPart, recordPart\)/.test(drillRoute) &&
      /drillPart: mockPart,/.test(drillRoute) &&
      /titleKo: nextToeicDrillTitle\(mockPart, existingTitles\)/.test(drillRoute) &&
      /existingTitles = drills\.map\(\(d\) => d\.titleKo\)/.test(drillRoute) &&
      /guideTemplatesForPart\(bankDoc\.items, part\)\.templates/.test(drillRoute),
  );
  add(
    "연습 라우트: 호출 C 실패 = 500 ai_failed retriable(저장 안 함) · 저장 예외 = 500 save_failed · 응답 헬퍼가 계약 타입(ToeicDrillCreateResponse)",
    /error: "ai_failed",[\s\S]{0,200}retriable: true/.test(drillRoute) && /error: "save_failed"/.test(drillRoute) && /function json\(body: ToeicDrillCreateResponse/.test(drillRoute) &&
      before(drillRoute, "error: \"ai_failed\"", "store.createToeicMock("),
  );
  add("연습 라우트: 로그에 틀·표현 글자를 싣지 않는다(개수·오류 이름만)", !/console\.[a-z]+\([^)]*expressions\.join/.test(drillRoute) && !/console\.[a-z]+\([^)]*frameEn/.test(drillRoute));

  // regenerate 409 is_drill
  const regen = codeOnly(read("app/api/toeic/mocks/[id]/regenerate/route.ts"));
  add(
    "파트 다시 만들기: 연습이면 409 is_drill — 키 검사·호출 C보다 먼저, 계약 유니온에 is_drill",
    /if \(isToeicDrill\(mock\)\) \{\s*return json\(\{ ok: false, error: "is_drill"/.test(regen) &&
      before(regen, "isToeicDrill(mock)", "process.env.OPENAI_API_KEY") &&
      before(regen, "isToeicDrill(mock)", "generateMockPart(") &&
      /"part_exists" \| "is_drill"/.test(read("lib/toeic-mock-contract.ts")),
  );

  // 시작·끝내기·채점 — 범위의 원천
  const startRoute = codeOnly(read("app/api/toeic/mocks/[id]/attempts/route.ts"));
  add(
    "시작 라우트: decideAttemptScope(…, mock.drillPart) · 응시 기록에 questions: scope.questions · 응답 questions = 레코드 값 · 연습 문구",
    /decideAttemptScope\(parsed\.data\.scope, parsed\.data\.parts, mock\.parts, mock\.drillPart\)/.test(startRoute) &&
      /questions: scope\.questions,/.test(startRoute) &&
      /questions: record\.questions,/.test(startRoute) &&
      /"공략 연습은 그 유형 하나로만 응시해요\."/.test(startRoute) &&
      !/toeicAttemptQuestions\(/.test(startRoute),
  );
  const finish = codeOnly(read("app/api/toeic/attempts/[id]/finish/route.ts"));
  add(
    "끝내기 라우트: 범위 = attempt.questions(Q4가 오면 \"이 응시 범위에 없는 문항\" 400 — 기존 관용구) · completeFinishAnswers(qs, …)",
    // 2026-10-03(§15-5): 범위·중복·길이 검사는 끝내기·다시 풀기 끝이 함께 쓰는 한 벌(lib/toeic-finish-body finishAnswerIssues) — 범위 인자는 여전히 attempt.questions
    /const qs = attempt\.questions;/.test(finish) && /finishAnswerIssues\(qs, parsed\.data\.answers\)/.test(finish) &&
      /if \(!allowed\.has\(a\.q\)\) issues\.push\(\{ path: `answers\.\$\{i\}\.q`, message: "이 응시 범위에 없는 문항이에요" \}\)/.test(codeOnly(read("lib/toeic-finish-body.ts"))) &&
      /completeFinishAnswers\(qs, parsed\.data\.answers\)/.test(finish) && !/toeicAttemptQuestions\(/.test(finish),
  );
  const score = codeOnly(read("app/api/toeic/attempts/[id]/score/route.ts"));
  add(
    "채점 라우트: 범위 = attempt.questions — 범위 밖(Q4)은 404 question_not_found(기존 계약, 400으로 바꾸지 않는다)",
    /if \(!attempt\.questions\.includes\(q\)\) \{\s*return json\(\{ ok: false, error: "question_not_found"[\s\S]{0,160}\}, 404\)/.test(score) && !/toeicAttemptQuestions\(/.test(score),
  );
  const image = codeOnly(read("app/api/toeic/mocks/[id]/image/route.ts"));
  add(
    "사진 라우트(변경 없음 — 잠금): 칸이 없으면 404 picture_not_found가 키 검사·관문 P 호출보다 먼저",
    /const item = mock\.parts\.picture\?\.items\[slot\];\s*if \(!item\) \{\s*return json\(\{ ok: false, error: "picture_not_found"[\s\S]{0,120}\}, 404\)/.test(image) &&
      before(image, "error: \"picture_not_found\"", "process.env.OPENAI_API_KEY") &&
      before(image, "error: \"picture_not_found\"", "runImageJob(id, slot"),
  );

  // 응시 페이지·화면
  const takePage = codeOnly(read("app/toeic/mocks/[id]/take/page.tsx"));
  add(
    "응시 페이지: 판정에 drillPart · 문항 = decided.questions · 연습 라벨 toeicDrillScopeLabelKo · 뒤로(back)·녹음 풀 drill/mock",
    /decideAttemptScope\(scope, requested, mock\.parts, mock\.drillPart\)/.test(takePage) &&
      /const qs = decided\.questions;/.test(takePage) &&
      /toeicDrillScopeLabelKo\(mock\.drillPart, qs\)/.test(takePage) &&
      /back=\{back\}/.test(takePage) &&
      /recPool=\{mock\.drillPart !== null \? "drill" : "mock"\}/.test(takePage) &&
      /<Link href=\{back\.href\} className="u-navbtn">/.test(takePage) &&
      !/toeicAttemptQuestions\(/.test(takePage),
  );
  const take = codeOnly(read("components/toeic-take-view.tsx"));
  const dirUses = (take.match(/directionsByPart\.get\(/g) ?? []).length;
  add(
    "응시 화면: TOEIC_PART_DIRECTIONS[ 직접 참조 0 — 지시문 읽기·프리페치·화면 글 세 곳 모두 toeicPartDirections(파트, 응시 문항 수)",
    !/TOEIC_PART_DIRECTIONS/.test(take) && /toeicPartDirections\(part, n\)/.test(take) && dirUses >= 4 &&
      /playSpeech\(v \? enPieces\(directionsByPart\.get\(v\.part\)\?\.en/.test(take) &&
      /texts\.push\(\.\.\.enPieces\(directionsByPart\.get\(part\)\?\.en/.test(take) &&
      /\{directionsByPart\.get\(view\.part\)\?\.en\}/.test(take) && /\{directionsByPart\.get\(view\.part\)\?\.ko\}/.test(take),
    `directionsByPart.get ${dirUses}곳`,
  );
  add(
    "응시 화면: \"뒤로\" 세 곳이 back(학습 보기 하드코딩 0) · 녹음 저장이 pool: recPool",
    (take.match(/href=\{back\.href\}/g) ?? []).length === 3 && !/href=\{`\/toeic\/mocks\/\$\{encodeURIComponent\(mockId\)\}`\}/.test(take) && /pool: recPool,/.test(take),
  );

  // 결과 페이지·화면
  const attemptPage = codeOnly(read("app/toeic/attempts/[id]/page.tsx"));
  // 2026-10-02(§12-13-3): 틀 점검 자료는 연습뿐 아니라 실전 모의고사도 — 응시 범위의 파트마다(read 제외, drillPart와 상관없이)
  add(
    "결과 페이지: 문항 = attempt.questions · 연습 라벨 · 뒤로 = toeicMockBackLink · 틀 점검 자료는 응시 범위의 파트마다(read 제외 — 연습·모의고사 모두, toeicTemplateCheckData) · 저장된 흐름을 넘긴다",
    /const qs = attempt\.questions;/.test(attemptPage) &&
      /toeicDrillScopeLabelKo\(mock\.drillPart, qs\)/.test(attemptPage) &&
      /const back = toeicMockBackLink\(mock\);/.test(attemptPage) &&
      /const checkParts = TOEIC_MOCK_PARTS\.filter\(\(p\) => toeicGuidePartOfMockPart\(p\) !== null && questions\.some\(\(v\) => v\.part === p\)\);/.test(attemptPage) &&
      /checks\[p\] = toeicTemplateCheckData\(guidePart, templates, doc\.flows, bankSessions\)/.test(attemptPage) &&
      !/if \(mock\.drillPart !== null\) \{[^}]*toeicTemplateCheckData\(/.test(attemptPage) &&
      /answerFlows=\{mock\.answerFlows\}/.test(attemptPage) &&
      !/toeicAttemptQuestions\(/.test(attemptPage),
  );
  const view = codeOnly(read("components/toeic-attempt-view.tsx"));
  // 접기 머리는 속성이 붙을 수 있다(인쇄 펼치기 data-print-expand — docs/harness/toeic.md §16) — 여는 태그 앞부분으로 찾는다
  const modelBlock = view.slice(view.indexOf("<details className={s.model}"), view.indexOf("</details>", view.indexOf("<details className={s.model}")));
  add(
    "결과 화면: 모범답변 접기 안 tipKo 아래에 묘사 포인트(keyPointsKo)·답변 뼈대(outlineKo — 번호 목록), 비어 있지 않으면 보인다",
    before(modelBlock, "v.tipKo", "v.keyPointsKo.length > 0") && before(modelBlock, "v.keyPointsKo.length > 0", "v.outlineKo.length > 0") && /<ol className=\{s\.olist\}>/.test(modelBlock),
  );
  const drillBtns = view.slice(view.indexOf("{drill ? ("), view.indexOf(")}", view.indexOf("학습 보기로")));
  add(
    "결과 화면: 연습이면 \"같은 문제 다시\"·\"새 문제\"만 — \"학습 보기로\"는 모의고사 갈래에만",
    /\{drill \? \(\s*<div className=\{s\.row\}>\s*<Link href=\{drill\.retakeHref\}[\s\S]*같은 문제 다시[\s\S]*<Link href=\{drill\.newHref\}[\s\S]*새 문제[\s\S]*\) : \(/.test(drillBtns) &&
      drillBtns.indexOf("학습 보기로") > drillBtns.indexOf(") : ("),
  );
  add(
    "결과 화면: 🧩 틀 점검은 그 파트 자료(checks[v.part])가 있을 때 · drillTemplateCheck(전사문·모범답변 글·usedExpressions·피드백 tryExpressions) · 연습은 펼쳐서, 모의고사는 닫힌 접기 · \"이 틀 연습하기\" = ② 탭 ?tpl=",
    /drillTemplateCheck\(data, \{\s*transcript: a\?\.transcript \?\? null,\s*sampleAnswer: v\.sampleAnswer,\s*sampleUsedExpressions: v\.usedExpressions\.map\(\(u\) => u\.expression\),\s*tryExpressions: a\?\.feedback\?\.tryExpressions \?\? \[\],/.test(view) &&
      /const data = checks\[v\.part\];/.test(view) &&
      /if \(drill\) \{\s*return \(\s*<section className=\{s\.tplCheck\}/.test(view) &&
      /<details className=\{s\.tplCheckFold\}/.test(view) &&
      /toeicGuideFolderHref\(data\.part, \{ tab: "templates", tpl: key \}\)/.test(view),
  );
  // 결과 화면 칩 줄바꿈(QA final P2-2) — 공략 연습의 D tryExpressions는 틀의 `~` 형태(50자 넘음)가 올 수 있다
  const tryAt = view.indexOf("<p className={s.tryList}>");
  const tryBlock = tryAt < 0 ? "" : view.slice(tryAt, view.indexOf("</p>", tryAt));
  const tryChips = [...tryBlock.matchAll(/<span\b[^>]*?className=(\{`[^`]*`\}|"[^"]*")/g)].map((m) => m[1]).filter((c) => /\bu-chip\b/.test(c));
  const attemptCss = read("components/toeic-attempt-view.module.css");
  add(
    "결과 화면: \"넣었으면 좋았을 표현\" 칩(tryList)이 줄바꿈 클래스 s.tryChip을 갖고, .tryChip = white-space normal·overflow-wrap anywhere·min-width 0·max-width 100%(nowrap 없음)",
    tryChips.length === 1 && tryChips.every((c) => c.includes("${s.tryChip}")) && chipWraps(cssRule(attemptCss, "tryChip")),
    `칩 ${tryChips.length} · 규칙 ${cssRule(attemptCss, "tryChip").count}`,
  );
  const enAttempt = enChipClasses(view);
  const mockView = codeOnly(read("components/toeic-mock-detail-view.tsx"));
  const enMock = enChipClasses(mockView);
  const mockCss = read("components/toeic-mock-detail-view.module.css");
  add(
    "영어 표현 칩(lang=\"en\" u-chip)은 전부 칩 안에서 줄바꿈 — 결과 화면 s.tryChip · 학습 보기(활용한 표현·넘긴 활용할 표현) s.exprChip",
    enAttempt.length >= 1 && enAttempt.every((c) => c.includes("${s.tryChip}")) &&
      enMock.length === 2 && enMock.every((c) => c.includes("${s.exprChip}")) && chipWraps(cssRule(mockCss, "exprChip")),
    `결과 ${enAttempt.length} · 학습 보기 ${enMock.length}`,
  );

  // 학습 보기 리다이렉트·모의고사 목록·제목·스토어
  const detail = codeOnly(read("app/toeic/mocks/[id]/page.tsx"));
  add(
    "학습 보기: 연습이면 무조건 유형 폴더 ④ 탭으로(응시 기록 읽기·화면보다 먼저)",
    /if \(record\.drillPart !== null\) redirect\(toeicDrillFolderHref\(record\.drillPart\)\);/.test(detail) && before(detail, "redirect(toeicDrillFolderHref", "listToeicAttemptsByMock(id)"),
  );
  const mocksPage = codeOnly(read("app/toeic/mocks/page.tsx"));
  add(
    "모의고사 목록: 상한 없이 읽고(listToeicMocks()) 연습을 먼저 뺀 뒤 skippedCount(listableToeicMocks), 상한은 거른 뒤",
    /store\.listToeicMocks\(\),/.test(mocksPage) && /listableToeicMocks\(storedMocks\)/.test(mocksPage) && /listed\.mocks\.slice\(0, LIST_LIMIT\)/.test(mocksPage) && !/storedMocks\.length - /.test(mocksPage),
  );
  const mocksRoute = codeOnly(read("app/api/toeic/mocks/route.ts"));
  add(
    "모의고사 만들기: 제목 번호는 연습을 뺀 제목으로 · 새 문서 drillPart null · 활용할 표현은 표현집 세트의 세션만(실전 입력 그대로)",
    /existingTitles = mocks\.filter\(\(m\) => !isToeicDrill\(m\)\)\.map\(\(m\) => m\.titleKo\)/.test(mocksRoute) && /drillPart: null,/.test(mocksRoute) && /bookSetIds\.has\(q\.setId\)/.test(mocksRoute),
  );
  const fileStore = codeOnly(read("lib/store.ts"));
  const fsStore = codeOnly(read("lib/store-firestore.ts"));
  const fsDrills = fsStore.slice(fsStore.indexOf("async listToeicDrills("), fsStore.indexOf("async deleteToeicMock("));
  add(
    "스토어 listToeicDrills: 파일 = 메모리 거르기·최신순, Firestore = where(\"drillPart\", \"==\", mockPart) 등호 하나(orderBy 없음 — 복합 색인 불필요)",
    /db\.toeicMocks\.filter\(\(m\) => m\.drillPart === mockPart\)\.sort\(byCreatedAtDesc\)/.test(fileStore) &&
      /where\("drillPart", "==", mockPart\)\.get\(\)/.test(fsDrills) && !/orderBy/.test(fsDrills) && /\.sort\(byCreatedAtDesc\)/.test(fsDrills),
  );

  // 스트릭·폴더·연습 탭
  const streak = codeOnly(read("lib/streak-server.ts"));
  add("스트릭 라벨: 응시 라벨을 toeicAttemptStreakLabel(연습이면 `공략 연습 · {유형}`)로", /toeicAttemptStreakLabel\(mock, TOEIC_DRILL_PART_KO\)/.test(streak) && !/`모의고사 · \$\{mock\.titleKo\}`/.test(streak));
  const folderPage = codeOnly(read("app/toeic/guides/[part]/page.tsx"));
  // 2026-10-02(§12-13-3): ④ 준비 접기 = 단계마다 첫 틀 + "+n"(모범답변이 고르는 목록과 같은 흐름 — buildAnswerFlow(…, { order: "flow" }))
  add(
    "폴더 페이지: 그 유형 연습(listToeicDrills)·응시 → 요약(파트 본문 없음)·최근 10·응시 전·답변 흐름 접기(buildAnswerFlow order flow → drillPrepFlowFold)",
    /store\.listToeicDrills\(unit\.mockPart\)/.test(folderPage) && /summarizeToeicDrill\(d, drillAttempts\)/.test(folderPage) && /drillSummaries\.slice\(0, TOEIC_DRILL_RECENT_MAX\)/.test(folderPage) &&
      /drillPrepFlowFold\(bankDoc \? buildAnswerFlow\(bankDoc, unit\.mockPart, templates, \{ order: "flow" \}\) : null\)/.test(folderPage) && !/sampleAnswer/.test(folderPage),
  );
  const folderView = codeOnly(read("components/toeic-guide-folder-view.tsx"));
  add("폴더 탭: ④ 한 문제 연습 탭이 있다(공략 없이도 — 빈 상태 없음)", /AVAILABLE_TABS: readonly ToeicGuideTab\[\] = \["read", "templates", "quiz", "drill"\]/.test(folderView) && /tab === "drill" && <ToeicDrillView/.test(folderView));
  const drillView = codeOnly(read("components/toeic-drill-view.tsx"));
  const effects = drillView.split("useEffect(").slice(1).map((b) => b.slice(0, b.indexOf("}, [")));
  add(
    "연습 탭: 사진은 만들기 성공 뒤 같은 흐름 안(await requestImage) 또는 버튼으로만 — 화면을 열 때 자동 요청 없음(useEffect 안 requestImage 0)",
    /if \(isPicture\) await requestImage\(got\.id\);/.test(drillView) && effects.every((b) => !/requestImage\(/.test(b)) && /onClick=\{\(\) => void requestImage\(active\.id\)\}/.test(drillView),
  );
  add(
    "연습 탭: 사진 실패를 받으면 한 번 다시 읽어 확인(GET /api/toeic/mocks/[id]) · 준비 카드에 사진 이미지를 그리지 않는다(<img 0)",
    /await rereadReady\(id\)/.test(drillView) && /fetch\(`\/api\/toeic\/mocks\/\$\{encodeURIComponent\(id\)\}`, \{ cache: "no-store" \}\)/.test(drillView) && !/<img/.test(drillView) && !/toeicImageUrl/.test(drillView),
  );
  add(
    "연습 탭: 끊긴 응답 → 목록을 새로 읽고 누르기 전에 없던 연습이 있으면 그것을 연다 · 없으면 \"그래도 새로 만들기\" · 목표 등급 기억은 try/catch",
    /cutWatchRef\.current = knownIds;/.test(drillView) && /data\.recent\.find\(\(d\) => !watch\.has\(d\.id\)\)/.test(drillView) && /"그래도 새로 만들기"/.test(drillView) &&
      /try \{\s*setGrade\(parseDrillGrade\(window\.localStorage\.getItem\(TOEIC_DRILL_GRADE_STORAGE_KEY\)\)\);\s*\} catch/.test(drillView) &&
      /try \{\s*window\.localStorage\.setItem\(TOEIC_DRILL_GRADE_STORAGE_KEY, g\);\s*\} catch/.test(drillView),
  );

  // 번들 경계 — 새 클라이언트 안전 모듈
  const dv = read("lib/toeic-drill-view.ts");
  const dvImports = runtimeImportPaths(dv).map((p) => p.replace(/^\.\//, ""));
  add(
    "번들 경계: lib/toeic-drill-view.ts 런타임 import는 toeic-drill·toeic-guide-view·toeic-template·toeic-mock뿐(lib/ai·store·zod·openai 값 0, lookbehind 0)",
    dvImports.every((p) => ["toeic-drill", "toeic-guide-view", "toeic-template", "toeic-mock"].includes(p)) && !/\(\?<[=!]/.test(dv),
    dvImports.join(","),
  );
  const compImports = runtimeImportPaths(read("components/toeic-drill-view.tsx"));
  add(
    "번들 경계: 연습 탭 컴포넌트가 lib/ai·lib/store·서버 모듈을 값으로 import하지 않는다",
    compImports.every((p) => !/\/ai\/|\/store|openai|zod|toeic-normalize|toeic-image|toeic-transcribe/.test(p)),
    compImports.join(","),
  );
  return results;
}

export function runToeicGuideS3Checks(): GuideCheckResult[] {
  return [...runRecordChecks(), ...runRecPoolChecks(), ...runDrillViewChecks(), ...runFileStoreChildChecks(), ...runS3SourceChecks()];
}

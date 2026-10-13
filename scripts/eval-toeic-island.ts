/**
 * scripts/eval-toeic-island.ts — 🏝️ 나만의 답변 섬 오프라인 점검 (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * `eval-toeic.ts`가 `runToeicIslandChecks()`로 부른다(실호출 0 — AI·네트워크 없음).
 * 1. 순수(lib/toeic-island): 문서 id = 원본 키(멱등)·원본 → 담을 내용(틀 말하기·모의고사)·소재 추천·정규화·편집 판정·소재별 묶음
 * 2. 파일 백엔드 실제 동작(자식 프로세스 — 임시 cwd의 db.json): 담기 두 번 = 한 개 · 편집 · 삭제 · 옛 db.json 하위호환
 * 3. 소스 배선: 담기·고치기 라우트에 키 검사·501 없음(키 없이도 담긴다) · 해석(호출 G)은 저장 성공 뒤 best-effort · 해석 서버 모듈은 던지지 않고
 *    메인 모델 진입 함수만 · 삭제 prod-guard · 클라이언트 경계
 * 4. 해석 호출 G(§21-7 — 2026-10-13): spec-sync(원문 3 · JSON Schema 1 · 호출 옵션 1) · 사용자 메시지 · zod 반례 · 필요한 항목 판정 ·
 *    묶음 계획 · 적용 판정 · 편집 시 trKo 초기화 · 정규화 · calls.ts 배선(소스 대조 — 오프라인 게이트가 fetch를 막아 태울 수 없다)
 *    실호출은 runIslandLiveChecks() — eval-toeic.ts 게이트(EVAL_TOEIC=1) 안에서 EVAL_TOEIC_ISLAND=1일 때만. 에이전트는 실행하지 않는다.
 * 픽스처는 전부 지어낸 것(교재·강의 문장 없음).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSpecSync, extractSpecBlocks, type SpecSyncTarget } from "./spec-sync";
import {
  TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS,
  TOEIC_ISLAND_TRANSLATE_ITEM_TEMPLATE,
  TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES,
  TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT,
  TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS,
  TOEIC_ISLAND_TRANSLATE_USER_TEMPLATE,
  buildIslandTranslateUserMessage,
} from "../lib/ai/toeic/island-prompts";
import { TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA, buildIslandTranslateZod } from "../lib/ai/toeic/island-schemas";
import {
  TOEIC_ISLAND_EN_MAX,
  TOEIC_ISLAND_SPOKEN_MAX,
  TOEIC_ISLAND_TR_BATCH_CHARS,
  TOEIC_ISLAND_TR_BATCH_MAX,
  TOEIC_ISLAND_TR_KO_MAX,
  applyIslandPatch,
  applyIslandTranslation,
  islandEntryData,
  islandNeedsTranslation,
  normalizeIslandTrKo,
  planIslandTranslateBatches,
  buildIslandFromAttempt,
  buildIslandFromFrameDrill,
  cleanIslandText,
  groupIslandByTopic,
  islandDocId,
  islandHighlightSegments,
  islandPartOfMockPart,
  isToeicIslandDocId,
  normalizeToeicIslandEntry,
  resolveIslandTopic,
  suggestIslandTopic,
  type ToeicIslandEntry,
} from "../lib/toeic-island";

export interface IslandCheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AT = "2026-10-03T00:00:00.000Z";
const AT2 = "2026-10-03T01:00:00.000Z";
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function adder(results: IslandCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}

// 지어낸 틀·소재(교재 문구 아님)
const FRAMES = [
  { key: "go-to-spot", topicKey: "leisure", frameEn: "My go-to place for {activity} is {place}.", bankKey: null },
  { key: "buy-online", topicKey: "shopping", frameEn: "These days I usually buy {item} online because {reason}.", bankKey: "tpl-online" },
];
const TOPICS = [
  { key: "leisure", nameKo: "여가" },
  { key: "shopping", nameKo: "쇼핑" },
];
const GUIDE_TPLS = [{ key: "tpl-online", frameEn: "I usually buy {item} online because {reason}." }];

function entry(over: Partial<ToeicIslandEntry> = {}): ToeicIslandEntry {
  return {
    id: "isl-m-abcdefgh1",
    part: "q5_7",
    topicKey: "leisure",
    topicNameKo: "여가",
    en: "My go-to place for running is the river path.",
    ko: "달리기 단골 장소",
    trKo: null,
    spokenEn: null,
    question: null,
    frameKey: null,
    origin: { kind: "manual", clientId: "abcdefgh1" },
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 순수
// ---------------------------------------------------------------------------

function runPureChecks(): IslandCheckResult[] {
  const results: IslandCheckResult[] = [];
  const add = adder(results, "답변 섬 ① 순수");

  // 문서 id = 원본 키
  const fdId = islandDocId({ kind: "frame_drill", sessionId: "fd-abc12345", index: 2 });
  add("틀 말하기 원본 → isl-fd-…-2 · 같은 원본 = 같은 id(멱등)", fdId === "isl-fd-abc12345-2" && fdId === islandDocId({ kind: "frame_drill", sessionId: "fd-abc12345", index: 2 }), String(fdId));
  const imp = islandDocId({ kind: "attempt", attemptId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", q: 6, fixIndex: null });
  const fix = islandDocId({ kind: "attempt", attemptId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", q: 6, fixIndex: 1 });
  add("모의고사: 개선 답변과 고친 문장은 다른 id", imp !== null && fix !== null && imp !== fix && imp.endsWith("-q6-imp") && fix.endsWith("-q6-fix1"), `${imp} ${fix}`);
  add("직접 쓰기: clientId → isl-m-…", islandDocId({ kind: "manual", clientId: "abcdefgh1" }) === "isl-m-abcdefgh1");
  add(
    "형식 틀린 원본 → null(세션 접두어 없음·q 12·fixIndex -1·짧은 clientId·경로 문자)",
    [
      islandDocId({ kind: "frame_drill", sessionId: "abc12345", index: 0 }),
      islandDocId({ kind: "attempt", attemptId: "1b9d6bcd-bbfd", q: 12, fixIndex: null }),
      islandDocId({ kind: "attempt", attemptId: "1b9d6bcd-bbfd", q: 5, fixIndex: -1 }),
      islandDocId({ kind: "manual", clientId: "short" }),
      islandDocId({ kind: "manual", clientId: "abc/def/ghi" }),
    ].every((x) => x === null),
  );
  add("만든 id는 모두 isToeicIslandDocId 통과 · 경로 문자 id 거부", [fdId, imp, fix].every((x) => x !== null && isToeicIslandDocId(x)) && !isToeicIslandDocId("isl-../x") && !isToeicIslandDocId("fd-abc12345"));

  // 틀 말하기 → 담을 내용
  const sess = {
    part: "q5_7" as const,
    topicKeys: ["leisure", "shopping"],
    items: [
      { itemId: "a", frameKey: "go-to-spot", ko: "주말 산책 단골은 동네 공원이야.", en: "My go-to place for walks is the park.", frame: "x", outcome: "spoken" as const, transcript: "my go to place for walk is park", verdict: "close" as const, reasonKo: "r", fixedEn: "My go-to place for walks is the neighborhood park." },
      { itemId: "b", frameKey: "unknown-frame", ko: "  요즘   온라인으로 산다 ", en: "These days I usually buy shoes online because it is cheap.", frame: "x", outcome: "no_speech" as const, transcript: null, verdict: "wrong" as const, reasonKo: null, fixedEn: null },
    ],
  };
  const d0 = buildIslandFromFrameDrill(sess, "fd-abc12345", 0, FRAMES);
  add(
    "틀 말하기: 섬 문장 = 고친 문장 · 말한 문장 = 전사 · 한글 = ko · 틀 key · 소재 = 그 틀의 소재",
    d0.ok && d0.draft.en === sess.items[0].fixedEn && d0.draft.spokenEn === sess.items[0].transcript && d0.draft.ko === sess.items[0].ko && d0.draft.frameKey === "go-to-spot" && d0.draft.suggestedTopicKey === "leisure",
    JSON.stringify(d0),
  );
  const d1 = buildIslandFromFrameDrill(sess, "fd-abc12345", 1, FRAMES);
  add(
    "틀 말하기: 고친 문장 없으면 모범 영어 · 무응답이면 말한 문장 null · 공백 정리 · 은행에 없는 틀 + 판 소재 둘 → 추천 null",
    d1.ok && d1.draft.en === sess.items[1].en && d1.draft.spokenEn === null && d1.draft.ko === "요즘 온라인으로 산다" && d1.draft.suggestedTopicKey === null,
    JSON.stringify(d1),
  );
  const d1b = buildIslandFromFrameDrill({ ...sess, topicKeys: ["shopping"] }, "fd-abc12345", 1, FRAMES);
  add("틀 말하기: 틀을 못 찾아도 판 소재가 하나면 그 소재", d1b.ok && d1b.draft.suggestedTopicKey === "shopping");
  const d2 = buildIslandFromFrameDrill(sess, "fd-abc12345", 5, FRAMES);
  add("틀 말하기: 없는 문항 → not_found", !d2.ok && d2.reason === "not_found");
  const long = buildIslandFromFrameDrill({ ...sess, items: [{ ...sess.items[1], en: "a ".repeat(TOEIC_ISLAND_EN_MAX) }] }, "fd-abc12345", 0, FRAMES);
  add("틀 말하기: 상한 넘는 문장 → too_long(자르지 않는다)", !long.ok && long.reason === "too_long");

  // 모의고사 → 담을 내용
  const fb = {
    improvedAnswer: "These days I usually buy books online because it saves time.",
    fixes: [{ said: "i buy book online", better: "I usually buy books online." }],
  };
  const a0 = buildIslandFromAttempt({ attemptId: "att12345678", q: 6, fixIndex: null, mockPart: "respond", question: "  How often do you shop online? ", transcript: "i buy book online because save time", feedback: fb });
  add(
    "모의고사 개선 답변: 섬 문장 = improvedAnswer · 말한 문장 = 전사 · 질문 사본 · 유형 Q5–7 · 한국어 단서 null",
    a0.ok && a0.draft.en === fb.improvedAnswer && a0.draft.spokenEn === "i buy book online because save time" && a0.draft.question === "How often do you shop online?" && a0.draft.part === "q5_7" && a0.draft.ko === null,
    JSON.stringify(a0),
  );
  const a1 = buildIslandFromAttempt({ attemptId: "att12345678", q: 11, fixIndex: 0, mockPart: "opinion", question: null, transcript: "x", feedback: fb });
  add("모의고사 고친 문장: 섬 문장 = better · 말한 문장 = said · 유형 Q11", a1.ok && a1.draft.en === fb.fixes[0].better && a1.draft.spokenEn === fb.fixes[0].said && a1.draft.part === "q11");
  const a2 = buildIslandFromAttempt({ attemptId: "att12345678", q: 3, fixIndex: null, mockPart: "picture", question: null, transcript: null, feedback: fb });
  const a3 = buildIslandFromAttempt({ attemptId: "att12345678", q: 6, fixIndex: 4, mockPart: "respond", question: null, transcript: null, feedback: fb });
  const a4 = buildIslandFromAttempt({ attemptId: "att12345678", q: 6, fixIndex: null, mockPart: "respond", question: null, transcript: null, feedback: null });
  add("모의고사: Q3–4·Q8–10 → part · 없는 고칠 문장·채점 전 → not_found", !a2.ok && a2.reason === "part" && !a3.ok && a3.reason === "not_found" && !a4.ok && a4.reason === "not_found");
  add(
    "유형 대응: respond→q5_7 · opinion→q11 · read·picture·info → null",
    islandPartOfMockPart("respond") === "q5_7" && islandPartOfMockPart("opinion") === "q11" && ["read", "picture", "info"].every((p) => islandPartOfMockPart(p as "read") === null),
  );
  const longSpoken = buildIslandFromAttempt({ attemptId: "att12345678", q: 6, fixIndex: null, mockPart: "respond", question: null, transcript: "word ".repeat(1000), feedback: fb });
  add("말한 문장은 상한에서 자른다(거부하지 않는다)", longSpoken.ok && longSpoken.draft.spokenEn !== null && longSpoken.draft.spokenEn.length <= TOEIC_ISLAND_SPOKEN_MAX && longSpoken.draft.spokenEn.endsWith("…"));

  // 소재 추천
  add("추천: 틀 말하기 틀이 쓰인 문장 → 그 소재", suggestIslandTopic("Honestly, my go-to place for reading is a quiet cafe.", FRAMES) === "leisure");
  add("추천: 공략 틀만 찾혀도 bankKey로 이어진 소재", suggestIslandTopic("I usually buy groceries online because it is easy.", FRAMES.filter((f) => f.key !== "buy-online").concat([{ ...FRAMES[1], frameEn: "Nothing {x} matches here at all." }]), GUIDE_TPLS) === "shopping");
  add("추천: 틀이 없으면 null · 빈 문장 null · 틀 목록 없음 null", suggestIslandTopic("I like dogs.", FRAMES) === null && suggestIslandTopic("  ", FRAMES) === null && suggestIslandTopic("My go-to place for x is y.", []) === null);
  add(
    "추천: 두 소재가 같이 쓰이면 많이 찾힌 쪽, 같으면 문장에서 먼저 나온 쪽",
    suggestIslandTopic("These days I usually buy tea online because it is fresh. My go-to place for tea is my kitchen.", FRAMES) === "shopping",
  );

  // 강조
  const segs = islandHighlightSegments("Well, my go-to place for jogging is the river.", FRAMES);
  add("강조: 틀 고정 조각이 표시되고 조각을 이으면 원문", segs.some((g) => g.keys.length > 0 && /go-to place for/i.test(g.text)) && segs.map((g) => g.text).join("") === "Well, my go-to place for jogging is the river.", JSON.stringify(segs));
  add("강조: 틀 목록 없으면 한 조각", eqJson(islandHighlightSegments("abc", []), [{ text: "abc", keys: [] }]));

  // 정규화
  add("텍스트 정리: 제어문자·줄바꿈·연속 공백 → 한 칸 · 빈 값 null", cleanIslandText(" a\n\tb  c ") === "a b c" && cleanIslandText("   ") === null && cleanIslandText(3) === null);
  const n1 = normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), id: undefined, ko: undefined, extra: 1 });
  add("정규화: 빠진 선택 칸 → null(Firestore undefined 거부) · 모르는 칸 버림", n1 !== null && n1.ko === null && !("extra" in n1) && Object.values(n1).every((v) => v !== undefined), JSON.stringify(n1));
  add(
    "정규화: 섬 문장 없음·유형 깨짐·원본 깨짐·id 형식 → null",
    normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), en: " " }) === null &&
      normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), part: "q3_4" }) === null &&
      normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), origin: { kind: "x" } }) === null &&
      normalizeToeicIslandEntry("bad", entry()) === null,
  );
  add("정규화: 소재 key 형식이 틀리면 소재 없음(이름 사본도 null)", (() => {
    const n = normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), topicKey: "Bad Key" });
    return n !== null && n.topicKey === null && n.topicNameKo === null;
  })());

  // 소재 고르기
  add("소재: null·빈 값 → 소재 없음 · 은행 key → 이름 · 형식 틀림 → 거부", eqJson(resolveIslandTopic(null, TOPICS), { ok: true, topicKey: null, topicNameKo: null }) && eqJson(resolveIslandTopic("shopping", TOPICS), { ok: true, topicKey: "shopping", topicNameKo: "쇼핑" }) && !resolveIslandTopic("Bad Key", TOPICS).ok);
  add("소재: 은행에 없는 key는 받되 이전 이름 사본 유지", eqJson(resolveIslandTopic("travel", TOPICS, "여행"), { ok: true, topicKey: "travel", topicNameKo: "여행" }));

  // 편집 판정
  const e0 = entry();
  const p1 = applyIslandPatch(e0, { ko: "  새 메모 " }, AT2);
  add("편집: 바꾼 칸만 · updatedAt 갱신 · 원본·createdAt 불변", p1.ok && p1.changed && p1.entry.ko === "새 메모" && p1.entry.en === e0.en && p1.entry.updatedAt === AT2 && p1.entry.createdAt === AT && eqJson(p1.entry.origin, e0.origin));
  const p2 = applyIslandPatch(e0, { en: e0.en }, AT2);
  add("편집: 같은 값 → changed false · updatedAt 그대로", p2.ok && !p2.changed && p2.entry.updatedAt === AT);
  const p3 = applyIslandPatch(e0, { en: "  " }, AT2);
  const p4 = applyIslandPatch(e0, { en: "x".repeat(TOEIC_ISLAND_EN_MAX + 1) }, AT2);
  add("편집: 섬 문장 비우기 → empty · 상한 넘기 → too_long", !p3.ok && p3.reason === "empty" && !p4.ok && p4.reason === "too_long");
  const p5 = applyIslandPatch(e0, { topicKey: null }, AT2);
  add("편집: 소재 없음으로 → 이름 사본도 null", p5.ok && p5.entry.topicKey === null && p5.entry.topicNameKo === null);

  // 묶음
  const list = [
    entry({ id: "isl-m-aaaaaaaa1", topicKey: "shopping", topicNameKo: "쇼핑", createdAt: "2026-10-01T00:00:00.000Z" }),
    entry({ id: "isl-m-aaaaaaaa2", topicKey: null, topicNameKo: null }),
    entry({ id: "isl-m-aaaaaaaa3", topicKey: "travel", topicNameKo: "여행" }),
    entry({ id: "isl-m-aaaaaaaa4", topicKey: "leisure", createdAt: "2026-10-02T00:00:00.000Z" }),
    entry({ id: "isl-m-aaaaaaaa5", topicKey: "leisure", createdAt: "2026-10-04T00:00:00.000Z" }),
    entry({ id: "isl-m-aaaaaaaa6", part: "q11", topicKey: "leisure" }),
  ];
  const g = groupIslandByTopic(list, TOPICS, "q5_7");
  add(
    "묶음: 은행 소재 순서 → 은행 밖 소재(이름 사본) → 소재 없음 끝 · 묶음 안 최근 순 · 유형 거름",
    eqJson(g.map((x) => [x.topicKey, x.nameKo, x.entries.map((e) => e.id)]), [
      ["leisure", "여가", ["isl-m-aaaaaaaa5", "isl-m-aaaaaaaa4"]],
      ["shopping", "쇼핑", ["isl-m-aaaaaaaa1"]],
      ["travel", "여행", ["isl-m-aaaaaaaa3"]],
      [null, "소재 없음", ["isl-m-aaaaaaaa2"]],
    ]),
    JSON.stringify(g.map((x) => [x.topicKey, x.entries.map((e) => e.id)])),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 2. 파일 백엔드 실제 동작(자식 프로세스 — 임시 cwd)
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const st = store.getStore();
const out = { backend: process.env.STORE_BACKEND };
const base = JSON.parse(process.env.EVAL_ENTRY);
const [c1, c2] = await Promise.all([st.createToeicIslandEntry(base), st.createToeicIslandEntry({ ...base, en: "Different text." })]);
out.create = [c1.reused, c2.reused].sort();
out.list1 = (await st.listToeicIslandEntries()).map((e) => [e.id, e.en]);
out.upd = await st.updateToeicIslandEntry(base.id, (cur) => ({ entry: { ...cur, ko: "고친 메모", updatedAt: "2026-10-03T01:00:00.000Z" }, result: "w" }));
out.got = await st.getToeicIslandEntry(base.id);
out.noWrite = await st.updateToeicIslandEntry(base.id, (cur) => ({ entry: null, result: cur.ko }));
out.missing = [await st.getToeicIslandEntry("isl-m-nopenope1"), await st.updateToeicIslandEntry("isl-m-nopenope1", () => ({ entry: null, result: 1 }))];
// 해석 서버 모듈(§21-7) — 키가 없으면 AI 0·받은 항목 그대로·던지지 않는다(이 프로세스는 OPENAI_API_KEY=""이고 네트워크를 쓰지 않는다)
try {
  const tr = await import(process.env.EVAL_TR_URL);
  const same = await tr.translateSavedIslandEntry(out.got, { store: st });
  const filled = await tr.fillIslandTranslations([out.got], { budgetMs: 50, store: st });
  out.noKey = { same: same === out.got, review: await tr.fillIslandTranslationsForReview([{ kind: "toeic-island", itemKey: "toeic-island:" + base.id }], { store: st }), skipped: filled.skipped, called: filled.called, trKo: (await st.getToeicIslandEntry(base.id)).trKo };
} catch (err) {
  out.noKey = { error: String(err && err.message).slice(0, 300) };
}
out.del = [await st.deleteToeicIslandEntry(base.id), await st.deleteToeicIslandEntry(base.id)];
out.list2 = (await st.listToeicIslandEntries()).length;
console.log("@@RESULT@@" + JSON.stringify(out));
`;

function runFileBackendChecks(): IslandCheckResult[] {
  const results: IslandCheckResult[] = [];
  const add = adder(results, "답변 섬 ② 파일 백엔드");
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-island-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    // 옛 db.json — toeicIsland 키가 없다(하위호환)
    writeFileSync(path.join(dir, "data", "db.json"), JSON.stringify({ books: [] }));
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
        EVAL_TR_URL: pathToFileURL(path.join(ROOT, "lib/toeic-island-translate-server.ts")).href,
        EVAL_ENTRY: JSON.stringify(entry()),
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 800)}`);
      return results;
    }
    const o = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    const got = o.got as ToeicIslandEntry | null;
    add("백엔드 file(임시 cwd — 저장소 data/db.json 무관) · 옛 db.json(키 없음)도 열린다", o.backend === "file" && Array.isArray(o.list1));
    add("같은 원본 동시 두 번 담기 → 하나만 생기고 하나는 reused · 내용은 먼저 것", eqJson(o.create, [false, true]) && eqJson(o.list1, [[entry().id, entry().en]]), JSON.stringify([o.create, o.list1]));
    add("편집: 원자 단위 안 판정 결과를 쓴다 · 다시 읽으면 바뀐 값", o.upd === "w" && got !== null && got.ko === "고친 메모" && got.updatedAt === "2026-10-03T01:00:00.000Z", JSON.stringify(got));
    add("편집: entry null이면 쓰지 않고 결과만 · 없는 id → null", o.noWrite === "고친 메모" && eqJson(o.missing, [null, null]));
    add(
      "키 없는 서버: translateSavedIslandEntry는 받은 항목 그대로 · 채우기는 no_key(호출 0) · 복습 채우기 false · 저장된 trKo null · 던지지 않음",
      eqJson(o.noKey, { same: true, review: false, skipped: "no_key", called: false, trKo: null }),
      JSON.stringify(o.noKey),
    );
    add("삭제: 처음 true · 다시 false · 목록 0", eqJson(o.del, [true, false]) && o.list2 === 0, JSON.stringify(o.del));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. 소스 배선
// ---------------------------------------------------------------------------

function runWiringChecks(): IslandCheckResult[] {
  const results: IslandCheckResult[] = [];
  const add = adder(results, "답변 섬 ③ 배선");
  const read = (p: string) => readFileSync(path.join(ROOT, p), "latin1");
  const create = read("app/api/toeic/island/route.ts");
  const one = read("app/api/toeic/island/[id]/route.ts");
  const fs = read("lib/store-firestore.ts");
  const lib = read("lib/toeic-island.ts");
  const contract = read("lib/toeic-island-contract.ts");
  const view = read("components/toeic-island-view.tsx");
  const save = read("components/toeic-island-save.tsx");
  // 2026-10-13(§21-7) — 담기·고치기가 저장 뒤 해석(호출 G)을 best-effort로 붙인다. 옛 "라우트: AI·키 검사 없음" 한 줄은 AI 호출이
  // 서버 모듈로 옮겨 가며 뜻을 보증하지 못하게 됐다 → 실제로 지킬 성질로 나눈다(주석을 뺀 소스로 본다).
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const createC = strip(create);
  const oneC = strip(one);
  const trSrv = strip(read("lib/toeic-island-translate-server.ts"));
  add("라우트: 키 검사·501·lib/ai 직접 import 없음 — 키 없음이 담기·고치기를 실패로 만들 길이 없다", ![createC, oneC].some((src) => /OPENAI_API_KEY|no_api_key|\b501\b|callWithSchema|from "@\/lib\/ai\/(?:client|toeic\/calls)"/.test(src)));
  const postTr = createC.indexOf("await translateSavedIslandEntry(");
  add(
    "담기: 해석은 저장(createToeicIslandEntry)·상한 판정 뒤, 성공 응답 안에서 · 새로 담았을 때만(reused는 그대로) · 한 번",
    (createC.match(/translateSavedIslandEntry\(/g) ?? []).length === 1 &&
      postTr > createC.indexOf("await store.createToeicIslandEntry(") &&
      createC.indexOf("await store.createToeicIslandEntry(") > 0 &&
      postTr > createC.indexOf("if (full) return json(") &&
      /return json\(\{ ok: true, entry: reused \? record : await translateSavedIslandEntry\(record, \{ store \}\), reused \}\);/.test(createC),
  );
  add("담기: 저장 본문의 trKo는 늘 null(해석은 저장 뒤 따로 붙는다 — 클라이언트·원본이 해석을 끼워 넣을 수 없다)", (createC.match(/trKo: null/g) ?? []).length >= 2 && !/trKo: (?!null)/.test(createC), String((createC.match(/trKo:[^,\n]*/g) ?? []).join(" | ")));
  const patchBody = oneC.slice(oneC.indexOf("export async function PATCH"), oneC.indexOf("export async function DELETE"));
  const delBody = oneC.slice(oneC.indexOf("export async function DELETE"));
  const patchTr = patchBody.indexOf("await translateSavedIslandEntry(");
  add(
    "고치기: 해석은 편집 원자 단위(updateToeicIslandEntry)와 실패 갈래(404·400) 뒤, 성공 응답 안에서 한 번 · 삭제에는 없음",
    (oneC.match(/translateSavedIslandEntry\(/g) ?? []).length === 1 &&
      patchTr > patchBody.indexOf("await store.updateToeicIslandEntry") &&
      patchBody.indexOf("await store.updateToeicIslandEntry") > 0 &&
      patchTr > patchBody.lastIndexOf("if (!r.ok) {") &&
      /return json\(\{ ok: true, entry: await translateSavedIslandEntry\(r\.entry, \{ store \}\) \}\);/.test(patchBody) &&
      !/translateSavedIslandEntry/.test(delBody),
  );
  const fillBody = /export async function fillIslandTranslations\(([\s\S]*?)\n}\n/.exec(trSrv)?.[0] ?? "";
  const reviewBody = /export async function fillIslandTranslationsForReview\(([\s\S]*?)\n}\n/.exec(trSrv)?.[0] ?? "";
  add(
    "해석 서버 모듈: 던지지 않는다 — throw 0 · 호출 약속에 .catch · 복습 채우기는 try/catch로 false",
    trSrv.length > 0 && !/\bthrow\b/.test(trSrv) && /translateAndSave\(store, batch, updated\)\s*\.catch\(/.test(fillBody) && /try \{[\s\S]*\} catch \(err\) \{[\s\S]*return false;\s*\}\s*\}\s*$/.test(reviewBody),
  );
  const iNothing = fillBody.indexOf('return none("nothing")');
  const iKey = fillBody.indexOf('if (!hasKey()) return none("no_key")');
  const iCall = fillBody.indexOf("translateAndSave(store, batch, updated)");
  add(
    "해석 서버 모듈: 대상 없음 → 키 확인 → 호출 순서(대상이 없으면 키도 안 본다 · 키가 없으면 호출 0) · 복습은 키가 없으면 목록도 읽지 않는다",
    iNothing > 0 && iKey > iNothing && iCall > iKey && reviewBody.indexOf("if (!hasKey()) return false;") > 0 && reviewBody.indexOf("if (!hasKey()) return false;") < reviewBody.indexOf("listToeicIslandEntries()"),
    `${iNothing} ${iKey} ${iCall}`,
  );
  const aiImports = [...trSrv.matchAll(/^import (?!type )([^;]*?) from "(?:\.\/ai\/|@\/lib\/ai\/)([^"]+)";/gm)].map((m) => `${m[2]}:${m[1].replace(/\s+/g, " ").trim()}`);
  add(
    "해석 서버 모듈: lib/ai에서 translateIslandSentences(메인 모델 진입 함수)만 — 공유 래퍼·출제/채점 모델·openai 직접 사용 없음",
    eqJson(aiImports, ["toeic/calls:{ translateIslandSentences }"]) && !/callWithSchema|resolveToeicModel|resolveModel|from "openai"|"gpt-/.test(trSrv) && /await translateIslandSentences\(batch\.map\(\(t\) => t\.en\)\)/.test(trSrv),
    aiImports.join(" , "),
  );
  add(
    "해석 서버 모듈: 저장은 원자 단위(updateToeicIslandEntry) 안 applyIslandTranslation — stale·invalid는 쓰지 않고 exists는 읽기만 · 한 묶음만(planIslandTranslateBatches(...)[0])",
    /store\.updateToeicIslandEntry<[^>]*>\(target\.id, \(cur\) => \{\s*const a = applyIslandTranslation\(cur, \{ en: target\.en, trKo \}\);\s*if \(a\.ok\) return \{ entry: a\.entry, result: a\.entry \};\s*return \{ entry: null, result: a\.reason === "exists" \? cur : null \};/.test(trSrv) &&
      /planIslandTranslateBatches\(candidates\)\[0\]/.test(fillBody),
  );
  // 실패 격리(QA island-tr 1 P2-A·P3-D) — 한 항목이 계속 어겨도 같은 묶음을 끝없이 되풀이하지 않는다
  const isoBody = /async function translateAndSave\(([\s\S]*?)\n}\n/.exec(trSrv)?.[0] ?? "";
  add(
    "해석 서버 모듈: 실패 격리 — 호출 수 상한(6)·시간 창 안에서 반으로 나눠 다시 · 한 문장 실패는 쿨다운(프로세스 메모리 — 문서에 새 칸 없음) · 연결/서버 실패는 나누지 않고 쉰다",
    /export const TOEIC_ISLAND_TR_MAX_CALLS = 6;/.test(trSrv) &&
      /while \(stack\.length > 0 && calls < TOEIC_ISLAND_TR_MAX_CALLS && Date\.now\(\) - started < TOEIC_ISLAND_TR_WORK_MAX_MS\)/.test(isoBody) &&
      /if \(part\.length === 1\) \{\s*st\.cooldown\.set\(/.test(isoBody) &&
      /stack\.push\(part\.slice\(mid\), part\.slice\(0, mid\)\)/.test(isoBody) &&
      /if \(kind === "outage"\) \{\s*st\.outageUntil = [^;]*;\s*break;/.test(isoBody) &&
      !/cooldown|inflight|startMax/.test(strip(lib)),
  );
  add(
    "해석 서버 모듈: 진행 중·쿨다운 항목은 계획에서 뺀다 · 진행 표시는 일이 끝나면(성공·실패 모두) 지운다 · 쉬는 중이면 키 확인 뒤 호출 없이 끝",
    /entries\.filter\(\(e\) => !st\.inflight\.has\(e\.id\) && !isCooling\(st, e, now\)\)/.test(fillBody) &&
      /for \(const id of ids\) st\.inflight\.add\(id\);/.test(fillBody) &&
      /\.catch\([\s\S]*?\)\s*\.then\(\(\) => \{\s*for \(const id of ids\) st\.inflight\.delete\(id\);/.test(fillBody) &&
      fillBody.indexOf("if (Date.now() < st.outageUntil) return none(") > fillBody.indexOf('if (!hasKey()) return none("no_key")') &&
      fillBody.indexOf("if (Date.now() < st.outageUntil) return none(") < fillBody.indexOf("translateAndSave(store, batch, updated)"),
  );
  const specTxt = readFileSync(path.join(ROOT, "docs/harness/toeic.md"), "utf8");
  const waitNum = (name: string) => Number(new RegExp(`export const ${name} = ([\\d_]+);`).exec(trSrv)?.[1]?.replace(/_/g, "") ?? NaN);
  const specNum = (re: RegExp) => Number(re.exec(specTxt)?.[1] ?? NaN) * 1000;
  add(
    "해석 서버 모듈: 기다림 상한 == 스펙 §21-7 숫자(담기·고치기 8초 · 복습 10초) · 넘기면 after()로 응답 뒤 저장 · 호출 G 자체 상한(45초)보다 짧다",
    waitNum("TOEIC_ISLAND_TR_SAVE_WAIT_MS") === specNum(/`TOEIC_ISLAND_TR_SAVE_WAIT_MS` (\d+)초/) &&
      waitNum("TOEIC_ISLAND_TR_REVIEW_WAIT_MS") === specNum(/`TOEIC_ISLAND_TR_REVIEW_WAIT_MS` (\d+)초/) &&
      waitNum("TOEIC_ISLAND_TR_REVIEW_WAIT_MS") < TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS &&
      /after\(\(\) => work\.then\(/.test(fillBody) &&
      /import \{ after \} from "next\/server";/.test(trSrv),
    `${waitNum("TOEIC_ISLAND_TR_SAVE_WAIT_MS")} ${waitNum("TOEIC_ISLAND_TR_REVIEW_WAIT_MS")}`,
  );
  const reviewPage = strip(read("app/toeic/review/page.tsx"));
  add(
    "복습 페이지(toeic): 큐를 만든 뒤 한 번 채우고, 붙었을 때만 다시 만든다 — 다시 만들기 실패는 처음 큐 그대로",
    (reviewPage.match(/fillIslandTranslationsForReview\(/g) ?? []).length === 1 &&
      reviewPage.indexOf('loadReviewQueue("toeic", today)') > 0 &&
      reviewPage.indexOf('loadReviewQueue("toeic", today)') < reviewPage.indexOf("fillIslandTranslationsForReview(q.cards)") &&
      /if \(await fillIslandTranslationsForReview\(q\.cards\)\) \{\s*q = await loadReviewQueue\("toeic", today\)\.catch\(\(\) => q\);/.test(reviewPage),
  );
  const others = ["app/english/review/page.tsx", "app/japanese/review/page.tsx", "app/mom/review/page.tsx", "app/api/review/[area]/route.ts", "app/api/review/record/route.ts", "lib/review-server.ts"];
  const otherSrc = others.map((p) => {
    try {
      return read(p);
    } catch {
      return null;
    }
  });
  add("다른 영역 복습 페이지·/api/review·review-server는 해석 모듈을 import하지 않는다(AI 0 그대로) — 대상 파일이 모두 있다", otherSrc.every((x) => x !== null && !/toeic-island-translate-server/.test(x)), others.filter((_, i) => otherSrc[i] === null).join(","));
  add("담기: 원본 글자는 저장소에서 읽는다(getToeicFrameDrillSession·getToeicAttempt)", /getToeicFrameDrillSession\(/.test(create) && /getToeicAttempt\(/.test(create));
  add("삭제: Firestore가 prod-guard deleteToeicIslandEntry · 라우트가 403 prod_guard", /assertDestructiveAllowed\("deleteToeicIslandEntry"\)/.test(fs) && /isProdGuardError/.test(one) && /403/.test(one));
  add("Firestore 담기 = create(ALREADY_EXISTS 멱등 — 상한을 주면 같은 트랜잭션 안 tx.create, QA common_review_1 P3-E) · 편집 = runTransaction", /toeicIsland\(\)\.doc\(entry\.id\)[\s\S]{0,1400}tx\.create\(ref[\s\S]{0,800}ref\.create\(/.test(fs) && /updateToeicIslandEntry[\s\S]{0,300}runTransaction/.test(fs));
  const runtimeBad = /^import (?!type )[^;]*from "(?:(?:@\/lib\/|\.\.?\/)(?:ai\/|store)|zod"|openai")/m;
  add("클라이언트 경계: 순수 모듈·계약·화면이 lib/ai·store·zod·openai 값을 import하지 않는다(타입만)", ![lib, contract, view, save].some((src) => runtimeBad.test(src)));
  add("🔊는 탭할 때만 — 섬 화면·담기 버튼에 prefetchSpeech·자동 재생 없음", !/prefetchSpeech|speakQueue|autoPlay/.test(view + save) && /onClick=\{\(\) => speak\(/.test(view));
  add("정규식 lookbehind 없음(구형 iOS Safari)", !/\(\?<[=!]/.test(lib));
  // 채점 직후 담기 버튼(QA island-part 1) — island는 서버가 렌더 때 만든다. 채점 큐가 다 끝난 뒤 한 번만 새로 고친다(문항마다 하지 않는다)
  const attemptView = readFileSync(path.join(ROOT, "components/toeic-attempt-view.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const scoreOneSrc = /const scoreOne = useCallback\(([\s\S]*?)\n {2}\);/.exec(attemptView)?.[1] ?? "";
  const runScoringSrc = /const runScoring = useCallback\(([\s\S]*?)\n {2}\);/.exec(attemptView)?.[1] ?? "";
  const successBranch = /if \(data\?\.ok\) \{([\s\S]*?)\n {6}\}/.exec(scoreOneSrc)?.[1] ?? "";
  add(
    "채점 직후 섬 버튼: runScoring이 큐(Promise.all) 뒤·setRunning(false) 뒤에 성공분이 있을 때 한 번 router.refresh()",
    /await Promise\.all\([\s\S]*setRunning\(false\);[\s\S]*if \(scored > 0\) router\.refresh\(\);/.test(runScoringSrc) &&
      (runScoringSrc.match(/router\.refresh\(\)/g) ?? []).length === 1 &&
      /if \(await scoreOne\(q\)\) scored \+= 1;/.test(runScoringSrc),
  );
  add(
    "채점 직후 섬 버튼: 문항 성공 갈래(scoreOne의 data.ok)에는 refresh 없음 · 성공만 true",
    successBranch.length > 0 && !/router\.refresh/.test(successBranch) && /return true;/.test(successBranch) && (scoreOneSrc.match(/return true;/g) ?? []).length === 1,
  );
  return results;
}

// ---------------------------------------------------------------------------
// 4. 해석 호출 G (§21-7)
// ---------------------------------------------------------------------------

const SPEC_URL = new URL("../docs/harness/toeic.md", import.meta.url);
const ISLAND_PROMPT_SRC = "lib/ai/toeic/island-prompts.ts";

export const ISLAND_SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  { constName: "TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT", source: ISLAND_PROMPT_SRC, specLabel: "§21-7 호출 G 시스템 프롬프트", text: TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "TOEIC_ISLAND_TRANSLATE_USER_TEMPLATE", source: ISLAND_PROMPT_SRC, specLabel: "§21-7 호출 G 사용자 메시지", text: TOEIC_ISLAND_TRANSLATE_USER_TEMPLATE, mode: "block-exact" },
  { constName: "TOEIC_ISLAND_TRANSLATE_ITEM_TEMPLATE", source: ISLAND_PROMPT_SRC, specLabel: "§21-7 호출 G 항목 형식", text: TOEIC_ISLAND_TRANSLATE_ITEM_TEMPLATE, mode: "block-exact" },
];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

// 지어낸 섬 문장(교재 문구 아님)
const TR_INPUT = {
  items: [
    { index: 0, en: "My go-to place on weekends is a small bakery near my office." },
    { index: 1, en: "First, it saves time. On top of that, I can compare three or four prices at once." },
  ],
};
const TR_OUT = {
  items: [
    { index: 0, ko: "제가 주말에 자주 가는 곳은 사무실 근처의 작은 빵집이에요." },
    { index: 1, ko: "먼저, 시간을 아껴 줘요. 게다가 서너 가지 가격을 한 번에 비교할 수 있어요." },
  ],
};

function runTranslateChecks(): IslandCheckResult[] {
  const results: IslandCheckResult[] = [];
  const add = adder(results, "답변 섬 ④ 해석 호출 G");

  // --- spec-sync ---
  for (const o of checkSpecSync(SPEC_URL, ISLAND_SPEC_SYNC_TARGETS)) add(`${o.constName}이 toeic.md §21-7 원문 그대로`, o.ok, o.ok ? o.summary : `${o.summary}\n${o.detail}`);
  add("spec-sync 원문 대상 = 3개(G 시스템·사용자·항목 줄)", ISLAND_SPEC_SYNC_TARGETS.length === 3, String(ISLAND_SPEC_SYNC_TARGETS.length));
  const parsed = new Map<string, unknown>();
  for (const b of extractSpecBlocks(SPEC_URL)) {
    try {
      const v = JSON.parse(b.text) as { name?: unknown };
      if (v && typeof v === "object" && typeof v.name === "string") parsed.set(v.name, v);
    } catch {
      // JSON 아닌 블록
    }
  }
  const specSchema = parsed.get("toeic_island_translate");
  add("JSON Schema toeic_island_translate ↔ 스펙 의미 동치", specSchema !== undefined && deepEqual(specSchema, TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA), specSchema === undefined ? "스펙 블록 없음" : "");
  add("스펙의 toeic_island_* JSON 블록 수 = 1", [...parsed.keys()].filter((k) => k.startsWith("toeic_island_")).length === 1, [...parsed.keys()].filter((k) => k.startsWith("toeic_island_")).join(","));
  const strictOk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return true;
    const n = node as Record<string, unknown>;
    if ("minItems" in n || "maxItems" in n) return false;
    if (n.type === "object") {
      const props = Object.keys((n.properties as Record<string, unknown>) ?? {});
      const req = (n.required as string[]) ?? [];
      if (n.additionalProperties !== false || props.length !== req.length || !props.every((p) => req.includes(p))) return false;
    }
    return Object.values(n).every(strictOk);
  };
  add("JSON Schema strict 모양(additionalProperties false · required 전부 · min/maxItems 없음)", strictOk(TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA.schema));
  const spec = readFileSync(SPEC_URL, "utf-8");
  const opt = [...spec.matchAll(/temperature ([\d.]+), maxOutputTokens (\d+), call 라벨 `([^`]+)`/g)].find((m) => m[3] === TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.call);
  add(
    "호출 옵션 == 스펙 문장: toeic_island_translate",
    !!opt && Number(opt[1]) === TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.temperature && Number(opt[2]) === TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS.maxOutputTokens,
    opt ? `스펙 t=${opt[1]} max=${opt[2]}` : "스펙 문장 없음",
  );
  const num = (re: RegExp) => {
    const m = re.exec(spec);
    return m ? Number(m[1]) : NaN;
  };
  add(
    "스펙 산문 숫자 == 상수: 해석 상한·묶음 항목 수·묶음 글자 예산·시간 상한·SDK 재시도",
    num(/해석 상한 `TOEIC_ISLAND_TR_KO_MAX` (\d+)자/) === TOEIC_ISLAND_TR_KO_MAX &&
      num(/한 묶음은 `TOEIC_ISLAND_TR_BATCH_MAX` (\d+)개/) === TOEIC_ISLAND_TR_BATCH_MAX &&
      num(/`TOEIC_ISLAND_TR_BATCH_CHARS` (\d+)자 이하/) === TOEIC_ISLAND_TR_BATCH_CHARS &&
      num(/시간 상한 `TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS` (\d+)초/) * 1000 === TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS &&
      num(/SDK 자동 재시도 기본 `TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES` (\d+)/) === TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES,
    `${TOEIC_ISLAND_TR_KO_MAX} ${TOEIC_ISLAND_TR_BATCH_MAX} ${TOEIC_ISLAND_TR_BATCH_CHARS} ${TOEIC_ISLAND_TRANSLATE_TIMEOUT_MS} ${TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES}`,
  );

  // --- 사용자 메시지 ---
  const msg = buildIslandTranslateUserMessage(TR_INPUT);
  add("사용자 메시지: 항목 수 줄 · 항목마다 [index] 한 줄", msg === `항목 수: 2\n영어 항목:\n[0] ${TR_INPUT.items[0].en}\n[1] ${TR_INPUT.items[1].en}`, msg);
  const tricky = buildIslandTranslateUserMessage({ items: [{ index: 0, en: "  I wrote {count}\n and {items}   here. " }] });
  add("사용자 메시지: 값 안의 플레이스홀더 모양은 다시 치환되지 않는다(단일 패스) · 줄바꿈·연속 공백은 한 칸", tricky === "항목 수: 1\n영어 항목:\n[0] I wrote {count} and {items} here.", tricky);

  // --- zod 반례 ---
  const zod = buildIslandTranslateZod(TR_INPUT);
  const ok = (v: unknown) => zod.safeParse(v).success;
  add("zod: 올바른 해석 통과 · 순서가 뒤바뀌어도 통과(index로 짝짓는다)", ok(TR_OUT) && ok({ items: [TR_OUT.items[1], TR_OUT.items[0]] }));
  add("zod 반례: 개수 불일치(하나 빠짐 · 하나 더)", !ok({ items: [TR_OUT.items[0]] }) && !ok({ items: [...TR_OUT.items, { index: 2, ko: "하나 더 있어요." }] }));
  add("zod 반례: index 중복(개수는 맞지만 1이 빠짐)", !ok({ items: [TR_OUT.items[0], { index: 0, ko: "같은 번호를 또 썼어요." }] }));
  add("zod 반례: 받지 않은 index · 정수가 아닌 index", !ok({ items: [TR_OUT.items[0], { index: 7, ko: "모르는 번호예요." }] }) && !ok({ items: [TR_OUT.items[0], { index: 1.5, ko: "소수예요." }] }));
  add("zod 반례: 빈 해석 · 공백만", !ok({ items: [TR_OUT.items[0], { index: 1, ko: "" }] }) && !ok({ items: [TR_OUT.items[0], { index: 1, ko: "   " }] }));
  add("zod 반례: 한글 없는 해석(영어를 그대로 돌려줌 · 숫자·기호만)", !ok({ items: [TR_OUT.items[0], { index: 1, ko: TR_INPUT.items[1].en }] }) && !ok({ items: [TR_OUT.items[0], { index: 1, ko: "3-4 !!" }] }));
  add(
    "zod 경계: 해석 길이 상한(TOEIC_ISLAND_TR_KO_MAX 통과 · +1 거부)",
    ok({ items: [TR_OUT.items[0], { index: 1, ko: "가".repeat(TOEIC_ISLAND_TR_KO_MAX) }] }) && !ok({ items: [TR_OUT.items[0], { index: 1, ko: "가".repeat(TOEIC_ISLAND_TR_KO_MAX + 1) }] }),
  );
  add("zod 반례: 모르는 칸(strict) · 고유명사 라틴이 섞인 해석은 통과", !ok({ items: TR_OUT.items.map((x) => ({ ...x, en: "x" })) }) && ok({ items: [TR_OUT.items[0], { index: 1, ko: "먼저, Wi-Fi가 빨라서 시간을 아껴 줘요." }] }));
  const issues = zod.safeParse({ items: [{ index: 0, ko: TR_INPUT.items[0].en }] });
  add("zod 오류 메시지에 섬 문장·해석 값이 없다(경로·규칙만)", !issues.success && !JSON.stringify(issues.error.issues).includes("bakery"), issues.success ? "" : JSON.stringify(issues.error.issues.map((i) => i.message)));

  // --- 필요한 항목 판정 ---
  const manual = entry();
  const attempt = entry({ id: "isl-at-att12345678-q6-imp", origin: { kind: "attempt", attemptId: "att12345678", q: 6, fixIndex: null }, ko: null });
  const drill = entry({ id: "isl-fd-abc12345-0", origin: { kind: "frame_drill", sessionId: "fd-abc12345", index: 0 }, ko: "주말 산책 단골은 동네 공원이야." });
  add("판정: 직접 쓰기(메모 있음)·모의고사(메모 없음)는 해석 필요 — 메모는 해석이 아니다", islandNeedsTranslation(manual) && islandNeedsTranslation(attempt));
  add("판정: 틀 말하기 원본 + 한글 문장 있음 → 필요 없음(AI 0) · 한글 문장이 비면 필요", !islandNeedsTranslation(drill) && islandNeedsTranslation({ ...drill, ko: null }) && islandNeedsTranslation({ ...drill, ko: "  " }));
  add("판정: trKo가 이미 있으면 필요 없음 · 공백뿐인 trKo는 없는 것", !islandNeedsTranslation({ ...manual, trKo: "달리기 하러 자주 가는 곳은 강변길이에요." }) && islandNeedsTranslation({ ...manual, trKo: "  " }));

  // --- 묶음 계획 ---
  const many = Array.from({ length: 45 }, (_, i) => entry({ id: `isl-m-plan${String(i).padStart(4, "0")}`, en: `Sentence number ${i} is short.` }));
  const plan = planIslandTranslateBatches([...many.slice(0, 3), drill, { ...many[3], trKo: "이미 있어요." }, many[0], ...many.slice(4)]);
  add(
    "계획: 필요한 항목만(틀 말하기+한글·이미 해석 있음·같은 id 빠짐) · 받은 순서 · 한 묶음 ≤ 20개",
    plan.flat().length === 44 && plan.every((b) => b.length >= 1 && b.length <= TOEIC_ISLAND_TR_BATCH_MAX) && eqJson(plan.map((b) => b.length), [20, 20, 4]) && plan[0][0].id === many[0].id && !plan.flat().some((t) => t.id === drill.id || t.id === many[3].id),
    JSON.stringify(plan.map((b) => b.length)),
  );
  const longEn = `${"word ".repeat(239)}end.`; // 1199자
  const longPlan = planIslandTranslateBatches(Array.from({ length: 5 }, (_, i) => entry({ id: `isl-m-long${String(i).padStart(4, "0")}`, en: longEn })));
  add(
    "계획: 글자 예산(TOEIC_ISLAND_TR_BATCH_CHARS)을 넘기 전에 끊는다 · 묶음마다 예산 이하",
    eqJson(longPlan.map((b) => b.length), [2, 2, 1]) && longPlan.every((b) => b.reduce((n, t) => n + t.en.length, 0) <= TOEIC_ISLAND_TR_BATCH_CHARS),
    JSON.stringify(longPlan.map((b) => b.length)),
  );
  add("계획: limit개까지만(나머지는 다음 요청) · 대상이 없으면 빈 배열 · en은 공백 정리된 요청 시점 문장", planIslandTranslateBatches(many, 5).flat().length === 5 && planIslandTranslateBatches([drill]).length === 0 && planIslandTranslateBatches([entry({ en: "  Two   spaces. " })])[0][0].en === "Two spaces.");

  // --- 적용 판정 ---
  const ap = applyIslandTranslation(manual, { en: manual.en, trKo: "  달리기 하러 자주 가는 곳은   강변길이에요. " });
  add(
    "적용: trKo만 채운다(공백 정리) · 메모·섬 문장·updatedAt·원본 불변",
    ap.ok && ap.entry.trKo === "달리기 하러 자주 가는 곳은 강변길이에요." && ap.entry.ko === manual.ko && ap.entry.en === manual.en && ap.entry.updatedAt === manual.updatedAt && eqJson(ap.entry.origin, manual.origin) && manual.trKo === null,
    JSON.stringify(ap),
  );
  const stale = applyIslandTranslation({ ...manual, en: "I changed this sentence." }, { en: manual.en, trKo: "옛 문장의 해석이에요." });
  const exists = applyIslandTranslation({ ...manual, trKo: "먼저 채운 해석이에요." }, { en: manual.en, trKo: "뒤에 온 해석이에요." });
  add("적용: 요청 뒤 섬 문장이 바뀌었으면 stale(쓰지 않음) · 이미 있으면 exists(먼저 채운 것이 이긴다)", !stale.ok && stale.reason === "stale" && !exists.ok && exists.reason === "exists");
  add(
    "적용: 빈 값·한글 없음·상한 초과 → invalid",
    [" ", "only english", "가".repeat(TOEIC_ISLAND_TR_KO_MAX + 1)].every((t) => {
      const r = applyIslandTranslation(manual, { en: manual.en, trKo: t });
      return !r.ok && r.reason === "invalid";
    }),
  );

  // --- 편집 시 trKo 초기화 ---
  const withTr = { ...manual, trKo: "달리기 하러 자주 가는 곳은 강변길이에요." };
  const e1 = applyIslandPatch(withTr, { en: "My go-to place for running is the lake trail." }, AT2);
  add("편집: 섬 문장이 바뀌면 trKo → null(다시 만들 대상) · 메모는 그대로", e1.ok && e1.changed && e1.entry.trKo === null && e1.entry.ko === withTr.ko && islandNeedsTranslation(e1.entry));
  const e2 = applyIslandPatch(withTr, { en: `  ${withTr.en} ` }, AT2);
  const e3 = applyIslandPatch(withTr, { ko: "새 메모", topicKey: null }, AT2);
  add("편집: 같은 문장(공백만 다름)·메모·소재만 고치면 trKo 유지", e2.ok && !e2.changed && e2.entry.trKo === withTr.trKo && e3.ok && e3.changed && e3.entry.trKo === withTr.trKo);
  add("편집: patch로 trKo를 넣을 수 없다(IslandPatch에 칸 없음 — 모르는 칸은 무시)", (() => {
    const r = applyIslandPatch(manual, { ko: "메모", ...({ trKo: "끼워 넣은 해석" } as object) }, AT2);
    return r.ok && r.entry.trKo === null;
  })());

  // --- 정규화 · 저장 본문 ---
  const old = normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), id: undefined, trKo: undefined });
  const kept = normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), trKo: "  달리기 하러  자주 가요. " });
  add("정규화: 옛 문서(trKo 칸 없음) → null(undefined 아님) · 있는 값은 공백 정리해 유지", old !== null && old.trKo === null && kept !== null && kept.trKo === "달리기 하러 자주 가요.");
  add("정규화: 한글 없는 trKo·문자열 아닌 값은 버린다(null)", normalizeIslandTrKo("english only") === null && normalizeIslandTrKo(3) === null && normalizeIslandTrKo("") === null && normalizeToeicIslandEntry("isl-m-abcdefgh1", { ...entry(), trKo: "abc" })?.trKo === null);
  add("저장 본문(islandEntryData)에 trKo 칸이 실린다(빠지면 다시 저장할 때 조용히 지워진다) · undefined 없음", (() => {
    const d = islandEntryData(withTr);
    return d.trKo === withTr.trKo && Object.keys(d).includes("trKo") && Object.values(d).every((v) => v !== undefined) && !("id" in d);
  })());
  const fromDrill = buildIslandFromFrameDrill({ part: "q5_7", topicKeys: [], items: [{ itemId: "a", frameKey: "go-to-spot", ko: "산책 단골은 공원이야.", en: "My go-to place for walks is the park.", frame: "x", outcome: "no_speech", transcript: null, verdict: "wrong", reasonKo: null, fixedEn: null }] }, "fd-abc12345", 0, FRAMES);
  const fromAttempt = buildIslandFromAttempt({ attemptId: "att12345678", q: 6, fixIndex: null, mockPart: "respond", question: null, transcript: null, feedback: { improvedAnswer: "I usually shop online.", fixes: [] } });
  add("담을 내용(두 원본): trKo는 늘 null로 시작(담기는 AI 0 — 해석은 뒤에 따로)", fromDrill.ok && fromDrill.draft.trKo === null && fromAttempt.ok && fromAttempt.draft.trKo === null);

  // --- calls.ts 배선(소스 대조) ---
  const calls = readFileSync(path.join(ROOT, "lib/ai/toeic/calls.ts"), "utf8");
  const fn = /export async function translateIslandSentences\(([\s\S]*?)\n}\n/.exec(calls)?.[0] ?? "";
  add("calls.ts: translateIslandSentences가 callWithSchema를 G 원문·스키마·zod·옵션으로 부른다", /call: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS\.call/.test(fn) && /system: TOEIC_ISLAND_TRANSLATE_SYSTEM_PROMPT/.test(fn) && /jsonSchema: TOEIC_ISLAND_TRANSLATE_JSON_SCHEMA/.test(fn) && /zodSchema: buildIslandTranslateZod\(input\)/.test(fn) && /temperature: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS\.temperature/.test(fn) && /maxOutputTokens: TOEIC_ISLAND_TRANSLATE_CALL_OPTIONS\.maxOutputTokens/.test(fn));
  add("calls.ts: 모델은 메인 resolveModel() — 출제·채점 모델(resolveToeicModel)이 아니다", /model: resolveModel\(\)/.test(fn) && !/resolveToeicModel/.test(fn));
  add("calls.ts: 합친 신호(시간 상한 + 호출측 신호) · SDK 재시도는 호출측 값 → 없으면 0", /signal: islandTranslateAbortSignal\(options\.signal\)/.test(fn) && /maxRetries: options\.maxRetries \?\? TOEIC_ISLAND_TRANSLATE_SDK_MAX_RETRIES/.test(fn) && /AbortSignal\.any\(\[external, timeout\]\)/.test(calls));
  add("calls.ts: 빈 입력·상한 초과·빈 문장은 호출 전에 throw(과금 0) — 검사가 callWithSchema보다 앞", fn.indexOf("throw new Error") > 0 && fn.indexOf("throw new Error") < fn.indexOf("callWithSchema(") && /sentences\.length === 0 \|\| sentences\.length > TOEIC_ISLAND_TR_BATCH_MAX/.test(fn));
  const promptSrc = readFileSync(path.join(ROOT, ISLAND_PROMPT_SRC), "utf8");
  const schemaSrc = readFileSync(path.join(ROOT, "lib/ai/toeic/island-schemas.ts"), "utf8");
  add("상한 단일 정의: TOEIC_ISLAND_TR_KO_MAX는 lib/toeic-island.ts 한 곳(zod는 import) · 프롬프트 파일에 모델 문자열 없음", /import \{ TOEIC_ISLAND_TR_KO_MAX \} from "\.\.\/\.\.\/toeic-island"/.test(schemaSrc) && !/TOEIC_ISLAND_TR_KO_MAX\s*=/.test(schemaSrc) && !/"gpt-/.test(promptSrc + schemaSrc + fn));
  return results;
}

/** 실호출(게이트 — EVAL_TOEIC=1 EVAL_TOEIC_ISLAND=1): G 1회(지어낸 2문장). 결과는 개수·길이만 찍는다. 에이전트는 실행하지 않는다 */
export async function runIslandLiveChecks(): Promise<IslandCheckResult[]> {
  const results: IslandCheckResult[] = [];
  const add = adder(results, "실호출(게이트) — 답변 섬 해석");
  const calls = await import("../lib/ai/toeic/calls");
  try {
    const t0 = Date.now();
    const out = await calls.translateIslandSentences(TR_INPUT.items.map((x) => x.en));
    add("G 해석(2문장)", out.length === 2 && out.every((k) => /[가-힣]/.test(k)), `해석 길이 ${out.map((k) => k.length).join("·")}자 · ${Date.now() - t0}ms`);
  } catch (e) {
    add("G 해석(2문장)", false, e instanceof Error ? e.message : String(e));
  }
  return results;
}

export function runToeicIslandChecks(): IslandCheckResult[] {
  return [...runPureChecks(), ...runFileBackendChecks(), ...runWiringChecks(), ...runTranslateChecks()];
}

// 단독 실행: npx tsx scripts/eval-toeic-island.ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = runToeicIslandChecks();
  for (const r of all) console.log(`${r.pass ? "PASS" : "FAIL"}  [${r.book}] ${r.check}${r.pass || !r.detail ? "" : ` — ${r.detail}`}`);
  const fail = all.filter((r) => !r.pass).length;
  console.log(`\n${all.length - fail}/${all.length} PASS`);
  if (fail > 0) process.exit(1);
}

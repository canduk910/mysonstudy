/**
 * scripts/eval-toeic-island.ts — 🏝️ 나만의 답변 섬 오프라인 점검 (docs/harness/toeic.md §21, SPEC §20-18)
 *
 * `eval-toeic.ts`가 `runToeicIslandChecks()`로 부른다(실호출 0 — AI·네트워크 없음).
 * 1. 순수(lib/toeic-island): 문서 id = 원본 키(멱등)·원본 → 담을 내용(틀 말하기·모의고사)·소재 추천·정규화·편집 판정·소재별 묶음
 * 2. 파일 백엔드 실제 동작(자식 프로세스 — 임시 cwd의 db.json): 담기 두 번 = 한 개 · 편집 · 삭제 · 옛 db.json 하위호환
 * 3. 소스 배선: AI·키 검사 없음 · 삭제 prod-guard · 클라이언트 경계
 * 픽스처는 전부 지어낸 것(교재·강의 문장 없음).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TOEIC_ISLAND_EN_MAX,
  TOEIC_ISLAND_SPOKEN_MAX,
  applyIslandPatch,
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
  add("라우트: AI·키 검사 없음(키가 없어도 담긴다)", ![create, one].some((src) => /OPENAI_API_KEY|lib\/ai\/(client|toeic\/calls)|callWithSchema/.test(src)));
  add("담기: 원본 글자는 저장소에서 읽는다(getToeicFrameDrillSession·getToeicAttempt)", /getToeicFrameDrillSession\(/.test(create) && /getToeicAttempt\(/.test(create));
  add("삭제: Firestore가 prod-guard deleteToeicIslandEntry · 라우트가 403 prod_guard", /assertDestructiveAllowed\("deleteToeicIslandEntry"\)/.test(fs) && /isProdGuardError/.test(one) && /403/.test(one));
  add("Firestore 담기 = create(ALREADY_EXISTS 멱등 — 상한을 주면 같은 트랜잭션 안 tx.create, QA common_review_1 P3-E) · 편집 = runTransaction", /toeicIsland\(\)\.doc\(entry\.id\)[\s\S]{0,1400}tx\.create\(ref[\s\S]{0,800}ref\.create\(/.test(fs) && /updateToeicIslandEntry[\s\S]{0,300}runTransaction/.test(fs));
  const runtimeBad = /^import (?!type )[^;]*from "(?:(?:@\/lib\/|\.\.?\/)(?:ai\/|store)|zod"|openai")/m;
  add("클라이언트 경계: 순수 모듈·계약·화면이 lib/ai·store·zod·openai 값을 import하지 않는다(타입만)", ![lib, contract, view, save].some((src) => runtimeBad.test(src)));
  add("🔊는 탭할 때만 — 섬 화면·담기 버튼에 prefetchSpeech·자동 재생 없음", !/prefetchSpeech|speakQueue|autoPlay/.test(view + save) && /onClick=\{\(\) => speak\(/.test(view));
  add("정규식 lookbehind 없음(구형 iOS Safari)", !/\(\?<[=!]/.test(lib));
  return results;
}

export function runToeicIslandChecks(): IslandCheckResult[] {
  return [...runPureChecks(), ...runFileBackendChecks(), ...runWiringChecks()];
}

// 단독 실행: npx tsx scripts/eval-toeic-island.ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = runToeicIslandChecks();
  for (const r of all) console.log(`${r.pass ? "PASS" : "FAIL"}  [${r.book}] ${r.check}${r.pass || !r.detail ? "" : ` — ${r.detail}`}`);
  const fail = all.filter((r) => !r.pass).length;
  console.log(`\n${all.length - fail}/${all.length} PASS`);
  if (fail > 0) process.exit(1);
}

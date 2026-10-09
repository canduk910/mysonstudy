/**
 * scripts/eval-mom.ts — 엄마의 생활영어 오프라인 점검(실호출 0). 픽스처 문장은 지어낸 것 — 교재 문장 금지(PUBLIC 저장소).
 */
import { readFileSync } from "node:fs";
import { MOM_IMPORT_FORMAT, momBlockHash, momImportFileSchema, isSpeakRole } from "../lib/mom-content";
import { decideMomImport, momLessonSaveSchema, momTestSaveSchema } from "../lib/mom-contract";
import { frameWordsOf, judgeMomSpeech } from "../lib/mom-judge";
import { buildMomWeeks, isFullMomLesson, momPickTestItems, momProgress, momStageOfWeek, momTestSize, momToday, MOM_REVIEW_WEEKS } from "../lib/mom-plan";

globalThis.fetch = (() => {
  throw new Error("eval:mom은 네트워크를 쓰지 않는다");
}) as typeof fetch;

interface CheckResult { area: string; check: string; pass: boolean; detail: string }
const results: CheckResult[] = [];
const add = (area: string, check: string, pass: boolean, detail = "") => results.push({ area, check, pass, detail });
export const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

/** 지어낸 블록 — 테스트 전용 */
export function fakeBlock(id: string, week: number, stage: 0 | 1 | 2 | 3 | 4, n = 6) {
  return {
    id, source: "mp3" as const, no: 1, stage, week,
    frame: { text: "I would like ~", slots: ["무엇"] },
    explainKo: "원하는 것을 공손하게 말할 때 써요.",
    sentences: [
      ...Array.from({ length: n }, (_, i) => ({ id: `${id}-s${i}`, role: (i === 0 ? "core" : "expand") as "core" | "expand", en: `I would like item ${i}.`, ko: `물건 ${i}을 원해요.`, chunks: ["I would like", `item ${i}.`] })),
      { id: `${id}-d0`, role: "dialog" as const, en: "Sure, here you go.", ko: "네, 여기 있어요.", chunks: ["Sure,", "here you go."] },
      { id: `${id}-t0`, role: "smalltalk" as const, en: "How was it?", ko: "어땠어요?", chunks: ["How was it?"] },
    ],
  };
}

// ── 1) 가져오기 계약 ──
{
  const A = "가져오기 계약";
  const ok = { format: MOM_IMPORT_FORMAT, presetKey: "mom-v1", blocks: [fakeBlock("b1", 5, 1)] };
  add(A, "정상 파일 통과", momImportFileSchema.safeParse(ok).success);
  const badChunks = structuredClone(ok);
  badChunks.blocks[0].sentences[0].chunks = ["I would", "like item 9."];
  add(A, "chunks를 이으면 en과 같아야(공백 정규화) — 다르면 거부", !momImportFileSchema.safeParse(badChunks).success);
  const dupId = structuredClone(ok);
  dupId.blocks.push(structuredClone(dupId.blocks[0]));
  add(A, "블록 id 중복 거부", !momImportFileSchema.safeParse(dupId).success);
  const badWeek = structuredClone(ok);
  badWeek.blocks[0].week = 53;
  add(A, "week 1~52 밖 거부", !momImportFileSchema.safeParse(badWeek).success);
  const emptyKo = structuredClone(ok);
  emptyKo.blocks[0].sentences[0].ko = " ";
  add(A, "빈 한국어 뜻 거부", !momImportFileSchema.safeParse(emptyKo).success);
  add(A, "말하기 역할 = core·expand·situation", isSpeakRole("core") && isSpeakRole("situation") && !isSpeakRole("dialog") && !isSpeakRole("smalltalk"));
  const b = fakeBlock("b1", 5, 1);
  const b2 = structuredClone(b);
  b2.explainKo = "바뀐 설명";
  add(A, "블록 해시: 같은 내용 같은 값, 다르면 다른 값", momBlockHash(b) === momBlockHash(structuredClone(b)) && momBlockHash(b) !== momBlockHash(b2));
}

// ── 2) 가져오기 결정·저장 계약 ──
{
  const A = "가져오기 결정";
  const file = { format: MOM_IMPORT_FORMAT, presetKey: "mom-v1", blocks: [fakeBlock("b1", 5, 1), fakeBlock("b2", 6, 1)] } as never;
  const first = decideMomImport(file, [], "2026-10-10T00:00:00.000Z");
  add(A, "처음 → 모두 created", first.result.created.length === 2 && first.writes.length === 2);
  const again = decideMomImport(file, first.writes, "2026-10-11T00:00:00.000Z");
  add(A, "같은 파일 재반입 → unchanged, 쓰기 0", again.result.unchanged.length === 2 && again.writes.length === 0);
  const changed = structuredClone(file) as { blocks: { explainKo: string }[] };
  changed.blocks[0].explainKo = "다른 설명";
  const upd = decideMomImport(changed as never, first.writes, "2026-10-11T00:00:00.000Z");
  add(A, "내용 바뀐 블록만 updated(importedAt 갱신), 나머지 unchanged", upd.result.updated.join() === "b1" && upd.result.unchanged.join() === "b2" && upd.writes.length === 1);
  add(A, "파일에 없는 기존 블록은 지우지 않는다(writes에 삭제 없음)", decideMomImport({ ...(file as object), blocks: [fakeBlock("b1", 5, 1)] } as never, first.writes, "x").writes.every((w) => w.id === "b1"));

  const L = "저장 계약";
  const lesson = { id: "c-1", lessonId: "w5-d1", startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:05:00.000Z", checks: [{ sentenceId: "b1-s0", verdict: "pass", transcript: "i would like item 0", hintLevel: 0 }] };
  add(L, "레슨 저장 정상", momLessonSaveSchema.safeParse(lesson).success);
  add(L, "레슨 verdict 밖 거부", !momLessonSaveSchema.safeParse({ ...lesson, checks: [{ ...lesson.checks[0], verdict: "great" }] }).success);
  add(L, "레슨 id 형식(클라이언트 멱등 키) — 공백·긴 값 거부", !momLessonSaveSchema.safeParse({ ...lesson, id: "a b" }).success && !momLessonSaveSchema.safeParse({ ...lesson, id: "x".repeat(80) }).success);
  const test = { id: "t-1", week: 5, startedAt: lesson.startedAt, finishedAt: lesson.finishedAt, items: [{ sentenceId: "b1-s0", verdict: "close", transcript: "i like item", recorded: true }] };
  add(L, "테스트 저장 정상·summaryKo는 받지 않는다", momTestSaveSchema.safeParse(test).success && !momTestSaveSchema.safeParse({ ...test, summaryKo: { goodKo: "a", fixKo: "b" } }).success);
}

// ── 3) 진도 엔진 ──
{
  const A = "진도 엔진";
  const blocks = [fakeBlock("b5a", 5, 1, 6), fakeBlock("b5b", 5, 1, 6), fakeBlock("b6", 6, 1, 6)];
  add(A, "블록 0 → empty(던지지 않음)", momToday({ blocks: [], lessons: [], tests: [] }).kind === "empty");
  const weeks = buildMomWeeks(blocks as never);
  const w5 = weeks.find((w) => w.week === 5)!;
  add(A, "주당 레슨 4개, 말하기 12문장을 3·3·3·3으로", w5.lessons.length === 4 && w5.lessons.every((l) => l.speakIds.length === 3), JSON.stringify(w5.lessons.map((l) => l.speakIds.length)));
  add(A, "smalltalk·dialog는 말하기에서 빠지고 dialog는 듣기로", w5.lessons.every((l) => l.speakIds.every((id) => !id.includes("-t") && !id.includes("-d"))) && w5.lessons[0].listenIds.length === 1);
  add(A, "단계: 1~4주 0, 5~16주 1, 17~32 2, 33~46 3, 47~52 4", [1, 4, 5, 16, 17, 32, 33, 46, 47, 52].map(momStageOfWeek).join() === "0,0,1,1,2,2,3,3,4,4");
  add(A, "테스트 문항 수 5·5·8·10·10", [0, 1, 2, 3, 4].map((s) => momTestSize(s as 0)).join() === "5,5,8,10,10");
  add(A, "복습 주 = 8·16·24·32·40·48", MOM_REVIEW_WEEKS.join() === "8,16,24,32,40,48");
  const t0 = momToday({ blocks: blocks as never, lessons: [], tests: [] });
  add(A, "처음 → w5-d1", t0.kind === "lesson" && t0.lesson.id === "w5-d1");
  const done = (id: string, speak: string[]) => ({ id: `c-${id}`, lessonId: id, startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:05:00.000Z", checks: speak.map((s) => ({ sentenceId: s, verdict: "pass" as const, transcript: "x", hintLevel: 0 as const })) });
  const quit = { ...done("w5-d1", w5.lessons[0].speakIds), finishedAt: null };
  add(A, "그만둔 레슨은 완료 아님 → 여전히 w5-d1", (() => { const t = momToday({ blocks: blocks as never, lessons: [quit], tests: [] }); return t.kind === "lesson" && t.lesson.id === "w5-d1"; })());
  add(A, "isFullMomLesson: 말하기 문장 하나라도 결과 없으면 아님", !isFullMomLesson({ finishedAt: "x", checks: done("w5-d1", w5.lessons[0].speakIds.slice(1)).checks }, w5.lessons[0]));
  const allW5 = w5.lessons.map((l) => done(l.id, l.speakIds));
  const t1 = momToday({ blocks: blocks as never, lessons: allW5, tests: [] });
  add(A, "주 레슨 다 끝나면 → 그 주 테스트(5문항)", t1.kind === "test" && t1.week === 5 && t1.size === 5);
  const test5 = (rate: number, week = 5) => ({ id: `t${week}`, week, startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:09:00.000Z", items: Array.from({ length: 10 }, (_, i) => ({ sentenceId: `x${i}`, verdict: (i < rate * 10 ? "pass" : "retry") as "pass" | "retry", transcript: null, recorded: true })), summaryKo: null });
  const t2 = momToday({ blocks: blocks as never, lessons: allW5, tests: [test5(0.8)] });
  add(A, "테스트 끝 → 다음 주 w6-d1", t2.kind === "lesson" && t2.lesson.id === "w6-d1");
  const pick = momPickTestItems({ week: 5, blocks: blocks as never, lessons: [{ ...allW5[0], checks: allW5[0].checks.map((c, i) => (i === 0 ? { ...c, verdict: "retry" as const } : c)) }], size: 5 });
  add(A, "테스트 문항: 다시였던 문장 먼저·결정적·중복 없음", pick[0] === allW5[0].checks[0].sentenceId && new Set(pick).size === 5 && JSON.stringify(pick) === JSON.stringify(momPickTestItems({ week: 5, blocks: blocks as never, lessons: [{ ...allW5[0], checks: allW5[0].checks.map((c, i) => (i === 0 ? { ...c, verdict: "retry" as const } : c)) }], size: 5 })));
  // 자동 감속: 5·6주 테스트 모두 0.5 → 7주 앞에 가상 복습 주
  const b7 = fakeBlock("b7", 7, 1, 6);
  const w6 = buildMomWeeks([...blocks, b7] as never).find((w) => w.week === 6)!;
  const allW6 = w6.lessons.map((l) => done(l.id, l.speakIds));
  const slow = momToday({ blocks: [...blocks, b7] as never, lessons: [...allW5, ...allW6], tests: [test5(0.5, 5), test5(0.5, 6)] });
  add(A, "2주 연속 60% 미만 → 다음 주 앞에 복습 주", slow.kind === "lesson" && slow.lesson.kind === "review", JSON.stringify(slow));
  const fast = momToday({ blocks: [...blocks, b7] as never, lessons: [...allW5, ...allW6], tests: [test5(0.5, 5), test5(0.7, 6)] });
  add(A, "한 주만 낮으면 감속 없음", fast.kind === "lesson" && fast.lesson.id === "w7-d1");
  const pr = momProgress({ blocks: blocks as never, lessons: allW5, tests: [] });
  add(A, "진도 지도: 5주 current(테스트 남음), 완료 레슨 4", pr.currentWeek === 5 && pr.doneLessons === 4 && pr.weeks.find((w) => w.week === 5)?.status === "current");

  // 완료 순서대로 끝까지 밀어 보는 도우미 — 레슨은 모두 맞음, 테스트는 주별 비율(기본 0.9). 지나간 오늘 항목 id를 돌려준다.
  type Rec = ReturnType<typeof done>;
  type TRec = ReturnType<typeof test5>;
  const runUntil = (bl: unknown[], rates: Record<number, number>, stopAt: string) => {
    const ls: Rec[] = [];
    const ts: TRec[] = [];
    const trace: string[] = [];
    for (let i = 0; i < 80; i++) {
      const t = momToday({ blocks: bl as never, lessons: ls, tests: ts });
      const key = t.kind === "lesson" ? t.lesson.id : t.kind === "test" ? `test${t.week}` : t.kind;
      trace.push(key);
      if (key === stopAt || t.kind === "done" || t.kind === "empty") break;
      if (t.kind === "lesson") ls.push(done(t.lesson.id, t.lesson.speakIds));
      else if (t.kind === "test") ts.push(test5(rates[t.week] ?? 0.9, t.week));
    }
    return { trace, ls, ts };
  };
  const bb = (weeks: number[]) => weeks.map((w) => fakeBlock(`k${w}`, w, 1, 6));
  const r67 = runUntil(bb([6, 7, 9]), { 6: 0.5, 7: 0.5, 8: 0.9 }, "w9-d1");
  add(A, "6·7주 낮음 → 8주(실제 복습 주)로 충족, 가상 주 없음 → 다음은 w9-d1", r67.trace.includes("rw8-d1") && r67.trace.at(-1) === "w9-d1" && !r67.trace.some((k) => /^rw1\d\d-/.test(k)), r67.trace.join(" "));
  const r567 = runUntil(bb([5, 6, 7, 9]), { 5: 0.5, 6: 0.5, 7: 0.5 }, "w9-d1");
  const virt = [...new Set(r567.trace.filter((k) => /^rw1\d\d-/.test(k)).map((k) => k.split("-")[0]))];
  add(A, "5·6·7주 모두 낮음 → 가상 복습 주는 한 번만(7주 앞), 8주 다음 w9-d1", virt.join() === "rw107" && r567.trace.indexOf("rw107-d1") < r567.trace.indexOf("w7-d1") && r567.trace.indexOf("rw8-d1") < r567.trace.indexOf("w9-d1") && r567.trace.at(-1) === "w9-d1", r567.trace.join(" "));
  const prv = momProgress({ blocks: [...blocks, b7] as never, lessons: [...allW5, ...allW6], tests: [test5(0.5, 5), test5(0.5, 6)] });
  add(A, "가상 복습 주 진행 중: currentWeek = 원래 7주·currentIsReview·7주 current", prv.currentWeek === 7 && prv.currentIsReview && prv.weeks.find((w) => w.week === 7)?.status === "current" && prv.weeks.every((w) => w.week < 100), JSON.stringify(prv));
  add(A, "말하기 문장 없는 블록만 → empty(done 아님)", momToday({ blocks: [fakeBlock("bz", 5, 1, 0)] as never, lessons: [], tests: [] }).kind === "empty");
  const span = buildMomWeeks([fakeBlock("ba", 10, 1, 2), fakeBlock("bc", 10, 1, 7)] as never).find((w) => w.week === 10)!;
  add(A, "두 블록에 걸친 레슨의 듣기 = 두 블록 dialog 모두(블록 순서)", JSON.stringify(span.lessons[0].listenIds) === JSON.stringify(["ba-d0", "bc-d0"]), JSON.stringify(span.lessons.map((l) => [l.speakIds.length, l.listenIds])));
}

// ── 4) 발화 판정 ──
{
  const A = "발화 판정";
  const F = "I would like ~";
  const j = (t: string, en = "I would like a cup of tea.") => judgeMomSpeech({ en, frameText: F, transcript: t });
  add(A, "틀 낱말 = i would like", frameWordsOf(F).join(" ") === "i would like");
  add(A, "정확히 → pass", j("I would like a cup of tea").verdict === "pass");
  add(A, "축약형 I'd like → pass", j("I'd like a cup of tea").verdict === "pass");
  add(A, "관사 빠짐 → pass(감점 없음)", j("I would like cup of tea").verdict === "pass");
  add(A, "복수형 차이 → pass", j("I would like a cup of teas").verdict === "pass");
  add(A, "틀 맞고 내용 절반 → close", j("I would like a cup").verdict === "close", JSON.stringify(j("I would like a cup")));
  add(A, "틀 빠지고 내용 다 → close", j("a cup of tea please").verdict === "close");
  add(A, "엉뚱한 말 → retry", j("good morning everyone").verdict === "retry");
  add(A, "무응답·한 낱말 → retry + noSpeech", j("").noSpeech && j("tea").verdict === "retry");
  add(A, "문장에 틀이 없으면 틀 검사 통과로", judgeMomSpeech({ en: "Where is the exit?", frameText: F, transcript: "where is the exit" }).verdict === "pass");
  add(A, "다른 말에 목표 낱말이 섞임(덧붙임 많음) → close", j("I would like a cup of coffee and a tea cake").verdict === "close", JSON.stringify(j("I would like a cup of coffee and a tea cake")));
  add(A, "군말(um·please)은 덧붙임 아님 → pass", j("Um, I would like a cup of tea please").verdict === "pass");
  const FS = "What time/When ~?";
  const js = (en: string, t: string) => judgeMomSpeech({ en, frameText: FS, transcript: t });
  add(A, "빗금 틀 — 틀 빠진 말 → pass 아님", js("What time does it start?", "does it start").verdict !== "pass", JSON.stringify(js("What time does it start?", "does it start")));
  add(A, "빗금 틀 — 구절 대안(When) → pass", js("When does it start?", "When does it start").verdict === "pass");
  add(A, "빗금 틀 — 문장에 맞는 대안의 틀 낱말", frameWordsOf(FS, "When does it start?").join(" ") === "when" && frameWordsOf(FS, "What time does it start?").join(" ") === "what time");
  add(A, "시제 차이(불규칙 go/went) → pass", judgeMomSpeech({ en: "I go to school.", frameText: "I go to ~", transcript: "I went to school" }).verdict === "pass");
  add(A, "시제 차이(-ed) → pass", judgeMomSpeech({ en: "I walk to school.", frameText: "I walk to ~", transcript: "I walked to school" }).verdict === "pass");
  add(A, "다른 낱말(like/lie)은 시제 관용 아님 → pass 아님", judgeMomSpeech({ en: "I would like tea.", frameText: F, transcript: "I would lie tea" }).verdict !== "pass");
  const FU = "Can I/Could I have ~?";
  const ju = (en: string, t: string) => judgeMomSpeech({ en, frameText: FU, transcript: t });
  add(A, "고르지 않은 빗금 틀 — 틀 빠진 말 → pass 아님(안전장치)", ju("Can I have a glass of water?", "a glass of water please").verdict !== "pass", JSON.stringify(ju("Can I have a glass of water?", "a glass of water please")));
  add(A, "고르지 않은 빗금 틀 — Can I have → pass", ju("Can I have a glass of water?", "Can I have a glass of water").verdict === "pass");
  add(A, "고르지 않은 빗금 틀 — Could I have → pass", ju("Could I have a glass of water?", "Could I have a glass of water").verdict === "pass");
  add(A, "need ≠ nee(-d 떼기 제한) → pass 아님", judgeMomSpeech({ en: "I need a pen.", frameText: "I need ~", transcript: "I nee a pen" }).verdict !== "pass");
  add(A, "liked = like(-d 떼기) → pass", judgeMomSpeech({ en: "I like it.", frameText: "I like ~", transcript: "I liked it" }).verdict === "pass");
  add(A, "자연스러운 첫말 yes는 덧붙임 아님 → pass", j("Yes, I would like a cup of tea").verdict === "pass");
  const jh = (en: string, t: string) => judgeMomSpeech({ en, frameText: "~ will go home", transcript: t }).verdict;
  add(A, "짧은 낱말 -d 떼기 금지(we/wed·she/shed → pass 아님, used/use는 pass)", jh("We will go home.", "Wed will go home") !== "pass" && jh("She will go home.", "Shed will go home") !== "pass" && judgeMomSpeech({ en: "I use it.", frameText: "I use ~", transcript: "I used it" }).verdict === "pass");
}

// ── 5) 배선(정적) ──
{
  const A = "배선";
  const tr = src("../app/api/mom/transcribe/route.ts");
  add(A, "받아쓰기: 키 검사가 formData보다 먼저·기대 문장 미전송", tr.indexOf("no_api_key") < tr.indexOf("formData()") && /transcribeAnswer\(/.test(tr) && !/prompt|expected|answer\s*:/.test(tr.replace(/transcribeAnswer/g, "")));
  add(A, "홈 진입 카드 /mom", /href="\/mom"/.test(src("../app/page.tsx")));
}

// ── 출력 ──
void (async () => {
  console.log("| 결과 | 영역 | 점검 항목 | 상세 |\n|---|---|---|---|");
  for (const r of results) console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.area} | ${r.check} | ${r.detail.replace(/\|/g, "\\|").slice(0, 160)} |`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`FAIL — 엄마 영어 ${failed.length}개 항목 실패.`);
    process.exit(1);
  }
  console.log(`PASS — 엄마 영어 ${results.length}개 항목 통과 (실호출 0회).`);
})();

/**
 * scripts/eval-mom.ts — 엄마의 생활영어 오프라인 점검(실호출 0). 픽스처 문장은 지어낸 것 — 교재 문장 금지(PUBLIC 저장소).
 */
import { readFileSync } from "node:fs";
import { MOM_IMPORT_FORMAT, momBlockHash, momImportFileSchema, isSpeakRole } from "../lib/mom-content";
import { decideMomImport, momLessonSaveSchema, momTestSaveSchema } from "../lib/mom-contract";

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

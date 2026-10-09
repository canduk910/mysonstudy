# 엄마의 생활영어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엄마(영어 말하기 입문자)를 위한 1년 소리 블록 과정 — 가져오기 파일 → 진도 엔진 → 하루 레슨(틀·듣기·따라 말하기·발화 체크) → 주간 테스트(녹음·판정·AI 총평) → 복습·스트릭·알림 통합.

**Architecture:** 교재 내용은 git 밖 가져오기 파일(`mom-english/v1`)로만 들어와 `momContent`에 저장된다. 진도·레슨 구성·판정은 순수 모듈(`lib/mom-*.ts`)이 결정적으로 계산하고, 라우트는 읽기·저장·관문 호출만 한다. 기존 부품(받아쓰기 관문 `transcribeAnswer`, 틀 비교 `normalizeTemplateWords`·`alignWordSeq`, 낭독 `speakQueue`·`buildTemplateShadowScript` 방식, 녹음 `createMicKeeper`·`toWav16kMono`, 기기 녹음 저장 `lib/toeic-rec-store.ts`, 오늘의 복습, 스트릭 v2)을 재사용한다.

**Tech Stack:** Next.js 16 App Router(먼저 `node_modules/next/dist/docs/` 해당 가이드를 읽는다 — route handler의 `params`는 Promise), TypeScript, zod, OpenAI Responses API(`callWithSchema`), tsx eval 스크립트.

**Spec:** `docs/superpowers/specs/2026-10-09-mom-english-design.md` (선행: `docs/superpowers/specs/2026-10-09-family-streak-design.md`)

## Global Constraints

- **저작권/PUBLIC 저장소**: 교재·강의·음원의 문장을 코드·픽스처·eval·문서·리포트·커밋 메시지 어디에도 옮기지 않는다. eval 픽스처 문장은 지어낸 것만. 자료는 `design/mom_english/`·`data/private/`(둘 다 gitignore)에만.
- 로컬 실행은 항상 `OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= …`(eval은 `EVAL_OFFLINE_ONLY=1`, dev 서버는 `APP_PIN=`). 실호출이 필요한 단계(Task 3 번역, Task 8 M1 1회)는 오케스트레이터가 사용자 동의 범위 안에서만.
- dev 서버 전 `data/db.json` 백업 + sha, 끝나면 복원·대조, 서버 끈 뒤 `git checkout CLAUDE.md`(next dev가 자동 블록을 다시 씀).
- **git push 금지**(main 푸시 = 배포). 스테이징은 경로 명시만. lint 스크립트 없음 — `npx tsc --noEmit -p .`가 검사.
- 진도표: 0단계 1~4주(md, 하루 새 2~3), 1단계 5~16주(mp3 1~15 + PDF 공항·기내·식당·카페 약 100), 2단계 17~32주(mp3 16~47 + PDF 쇼핑·숙소·관광지 약 100), 3단계 33~46주(mp3 48~85 + PDF 남은 약 50), 4단계 47~52주(mp3 86~100). 주당 레슨 4개 + 주간 테스트 1개. 복습 주 = 8·16·24·32·40·48주(새 문장 없음). 자동 감속 = 주간 테스트 맞음 비율이 2주 연속 0.6 미만이면 다음 주를 복습 주로.
- 블록 역할: 말하기 필수 = `core`·`expand`·`situation`, 듣기만 = `dialog`, 1회차 제외 = `smalltalk`.
- 발화 판정: ✓ = 틀 낱말 순서대로 포함 + 내용 낱말 70% 이상, 아깝다 = 틀 맞고 내용 40~70% 또는 내용 맞고 틀 일부 누락, 다시 = 그 밖·무응답. 관사·시제·복수형 차이는 감점 없음.
- 주간 테스트 문항 수: 0~1단계 5, 2단계 8, 3~4단계 10.
- 한 판(스트릭) = 레슨 완료(모든 말하기 문장에 결과) 또는 주간 테스트 완료 또는 `mom` 복습 한 판.
- 화면 문구는 한국어, 입문자 눈높이(용어 쉽게, 한국어 설명 두껍게). 합성 음성만(원음 없음).
- AI: 앱 안 호출은 M1 주간 총평 하나(테스트당 1회), 기본 텍스트 모델(`resolveModel()`).

## Review Focus

1. **가져오기 파일을 다시 넣었을 때 진도·기록이 사라지면 안 된다** — 같은 블록 id는 내용만 갱신(해시 같으면 그대로), `momLessons`·`momTests`·복습 일정은 그대로. Task 2에 테스트.
2. **레슨을 중간에 나가면** 기록이 "완료"로 저장되거나 🔥가 켜지면 안 된다 — 미완 레슨은 저장하지 않거나 `finishedAt: null`. Task 7에 테스트.
3. **받아쓰기가 실패(키 없음 501·네트워크)해도 레슨을 끝낼 수 있어야 한다** — "넘어가기"로 그 문장에 `skipped` 결과, 판정 없이 진행. Task 7에 테스트.
4. **블록이 0개(가져오기 전)** — 홈이 "파일로 가져오기" 안내만 보이고 엔진이 던지지 않는다. Task 4에 테스트.
5. **같은 주 테스트를 두 번 저장(재전송)** — 클라이언트 id 멱등으로 한 번만 저장, 총평 호출도 한 번. Task 8에 테스트.

---

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `lib/mom-content.ts` | 가져오기 계약 — 타입·zod·형식 상수·블록/문장 조회 (순수) | 새로 |
| `lib/mom-plan.ts` | 진도 엔진 — 주차·단계·레슨 구성·오늘 할 것·감속·진도 지도 (순수) | 새로 |
| `lib/mom-judge.ts` | 발화 판정 (순수) | 새로 |
| `lib/mom-contract.ts` | 라우트 요청/응답 타입·zod(레슨·테스트 저장) | 새로 |
| `lib/store.ts`, `lib/store-firestore.ts`, `scripts/seed.ts` | `momContent`·`momLessons`·`momTests` | 수정 |
| `app/api/mom/import/route.ts` | 가져오기 | 새로 |
| `app/api/mom/transcribe/route.ts` | 받아쓰기(관문 재사용) | 새로 |
| `app/api/mom/lessons/route.ts` | 레슨 저장 | 새로 |
| `app/api/mom/tests/route.ts`, `app/api/mom/tests/[id]/summary/route.ts` | 테스트 저장·총평 | 새로 |
| `lib/ai/mom/{prompts,schemas,calls}.ts` | 호출 M1 | 새로 |
| `app/mom/page.tsx`, `components/mom-home.tsx`, `components/mom-import-button.tsx` | 홈 | 새로 |
| `app/mom/lesson/[id]/page.tsx`, `components/mom-lesson-runner.tsx` | 레슨 | 새로 |
| `app/mom/test/[week]/page.tsx`, `components/mom-test-runner.tsx` | 주간 테스트 | 새로 |
| `app/mom/review/page.tsx` | 복습 | 새로 |
| `lib/review-schedule.ts`, `lib/review-sources.ts`, `lib/review-server.ts`, `lib/phrase-helper-scope.ts`, `scripts/eval-review.ts` | 복습 영역 `mom` | 수정 |
| `lib/toeic-rec-store.ts` | 녹음 풀에 `"mom"` | 수정 |
| `lib/streak-v2-sources.ts`, `lib/streak-server.ts`, `lib/push-decide.ts`, `components/streak-headline.tsx`, `scripts/eval-streak.ts` | 엄마 트랙 | 수정 |
| `app/page.tsx` | 홈 진입 카드 | 수정 |
| `scripts/eval-mom.ts`, `package.json` | 오프라인 eval | 새로/수정 |
| `docs/harness/mom.md`, `docs/HARNESS.md`, `docs/SPEC.md`, `README.md`, `CLAUDE.md`, `docs/BACKLOG.md`, `.claude/skills/study-orchestrator/SKILL.md` | 문서·하네스 | 새로/수정 |

---

### Task 1: 가져오기 계약 `lib/mom-content.ts` + eval 뼈대

**Files:**
- Create: `lib/mom-content.ts`, `scripts/eval-mom.ts`
- Modify: `package.json` (scripts에 `"eval:mom": "tsx scripts/eval-mom.ts"`)

**Interfaces:**
- Produces:
  ```ts
  export const MOM_IMPORT_FORMAT = "mom-english/v1";
  export const MOM_ROLES = ["core","expand","dialog","smalltalk","situation"] as const; export type MomRole;
  export const MOM_SPEAK_ROLES: readonly MomRole[]; // core·expand·situation
  export const MOM_SOURCES = ["md","mp3","pdf"] as const; export type MomSource;
  export interface MomSentence { id: string; role: MomRole; en: string; ko: string; chunks: string[] }
  export interface MomBlock { id: string; source: MomSource; no: number; stage: 0|1|2|3|4; week: number; frame: { text: string; slots: string[] }; explainKo: string; sentences: MomSentence[] }
  export interface MomImportFile { format: typeof MOM_IMPORT_FORMAT; presetKey: string; blocks: MomBlock[] }
  export const momImportFileSchema: z.ZodType<MomImportFile>;
  export function isSpeakRole(r: MomRole): boolean;
  export function momBlockHash(b: MomBlock): string; // 결정적 내용 해시(순수 JS, crypto 없이)
  ```

- [ ] **Step 1: eval 뼈대 + 실패하는 묶음 1**

`scripts/eval-mom.ts`(지어낸 문장만):
```ts
/**
 * scripts/eval-mom.ts — 엄마의 생활영어 오프라인 점검(실호출 0). 픽스처 문장은 지어낸 것 — 교재 문장 금지(PUBLIC 저장소).
 */
import { readFileSync } from "node:fs";
import { MOM_IMPORT_FORMAT, momBlockHash, momImportFileSchema, isSpeakRole } from "../lib/mom-content";

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
```
`package.json` scripts에 `"eval:mom": "tsx scripts/eval-mom.ts"` 추가.

- [ ] **Step 2: 실패 확인** — `OPENAI_API_KEY= STORE_BACKEND=file EVAL_OFFLINE_ONLY=1 npm run -s eval:mom` → 모듈 없음.

- [ ] **Step 3: 구현** — `lib/mom-content.ts`:
```ts
/**
 * lib/mom-content.ts — 엄마의 생활영어 가져오기 계약(설계 §6-1). 순수 — 클라이언트·서버 공용.
 * 교재 내용은 이 형식의 파일(git 밖)로만 들어온다. 이 모듈·eval에 교재 문장을 두지 않는다.
 */
import { z } from "zod";

export const MOM_IMPORT_FORMAT = "mom-english/v1";
export const MOM_ROLES = ["core", "expand", "dialog", "smalltalk", "situation"] as const;
export type MomRole = (typeof MOM_ROLES)[number];
export const MOM_SPEAK_ROLES: readonly MomRole[] = ["core", "expand", "situation"];
export const MOM_SOURCES = ["md", "mp3", "pdf"] as const;
export type MomSource = (typeof MOM_SOURCES)[number];

export interface MomSentence { id: string; role: MomRole; en: string; ko: string; chunks: string[] }
export interface MomBlock {
  id: string;
  source: MomSource;
  no: number;
  stage: 0 | 1 | 2 | 3 | 4;
  week: number;
  frame: { text: string; slots: string[] };
  explainKo: string;
  sentences: MomSentence[];
}
export interface MomImportFile { format: typeof MOM_IMPORT_FORMAT; presetKey: string; blocks: MomBlock[] }

export function isSpeakRole(r: MomRole): boolean {
  return MOM_SPEAK_ROLES.includes(r);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const text = (max: number) => z.string().transform(squash).pipe(z.string().min(1).max(max));
const ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const sentenceSchema = z
  .object({ id: ID, role: z.enum(MOM_ROLES), en: text(300), ko: text(300), chunks: z.array(text(200)).min(1).max(12) })
  .strict()
  .refine((s) => squash(s.chunks.join(" ")) === s.en, { message: "chunks를 이으면 en과 같아야 해요", path: ["chunks"] });

const blockSchema = z
  .object({
    id: ID,
    source: z.enum(MOM_SOURCES),
    no: z.number().int().min(0).max(999),
    stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    week: z.number().int().min(1).max(52),
    frame: z.object({ text: text(120), slots: z.array(text(40)).max(4) }).strict(),
    explainKo: text(400),
    sentences: z.array(sentenceSchema).min(1).max(40),
  })
  .strict()
  .refine((b) => new Set(b.sentences.map((s) => s.id)).size === b.sentences.length, { message: "문장 id가 겹쳐요", path: ["sentences"] });

export const momImportFileSchema: z.ZodType<MomImportFile> = z
  .object({ format: z.literal(MOM_IMPORT_FORMAT), presetKey: ID, blocks: z.array(blockSchema).min(1).max(400) })
  .strict()
  .refine((f) => new Set(f.blocks.map((b) => b.id)).size === f.blocks.length, { message: "블록 id가 겹쳐요", path: ["blocks"] })
  .refine((f) => new Set(f.blocks.flatMap((b) => b.sentences.map((s) => s.id))).size === f.blocks.reduce((n, b) => n + b.sentences.length, 0), {
    message: "문장 id가 파일 전체에서 겹쳐요",
    path: ["blocks"],
  }) as unknown as z.ZodType<MomImportFile>;

/** 결정적 내용 해시(FNV-1a 32bit ×2) — 같은 블록 재반입 판정용. 브라우저·서버 공용이라 crypto를 쓰지 않는다. */
export function momBlockHash(b: MomBlock): string {
  const s = JSON.stringify(b);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
```

- [ ] **Step 4: 통과 확인** — `PASS — 엄마 영어 7개 항목 통과`.

- [ ] **Step 5: 커밋**
```bash
npx tsc --noEmit -p .
git add lib/mom-content.ts scripts/eval-mom.ts package.json
git commit -m "feat(mom): 가져오기 계약·eval 뼈대"
```

---

### Task 2: 저장 — `momContent`·`momLessons`·`momTests` + 가져오기 라우트·버튼

**Files:**
- Create: `lib/mom-contract.ts`, `app/api/mom/import/route.ts`, `components/mom-import-button.tsx`
- Modify: `lib/store.ts`, `lib/store-firestore.ts`, `scripts/seed.ts`, `lib/prod-guard.ts`(삭제 연산 없음 — 변경 없음 확인만), `scripts/eval-mom.ts`(묶음 2)

**Interfaces:**
- Consumes: Task 1 `MomBlock`, `MomImportFile`, `momImportFileSchema`, `momBlockHash`
- Produces:
  ```ts
  // lib/mom-contract.ts
  export const MOM_VERDICTS = ["pass","close","retry","skipped"] as const; export type MomVerdict;
  export interface MomCheck { sentenceId: string; verdict: MomVerdict; transcript: string | null; hintLevel: 0|1|2|3 }
  export interface MomLessonRecord { id: string; lessonId: string; startedAt: string; finishedAt: string | null; checks: MomCheck[] }
  export interface MomTestItem { sentenceId: string; verdict: MomVerdict; transcript: string | null; recorded: boolean }
  export interface MomTestRecord { id: string; week: number; startedAt: string; finishedAt: string | null; items: MomTestItem[]; summaryKo: { goodKo: string; fixKo: string } | null }
  export const momLessonSaveSchema: z.ZodType<MomLessonRecord>;
  export const momTestSaveSchema: z.ZodType<Omit<MomTestRecord, "summaryKo">>;
  export interface MomImportResult { created: string[]; updated: string[]; unchanged: string[] }
  export function decideMomImport(file: MomImportFile, existing: readonly MomBlockRecord[], nowIso: string): { result: MomImportResult; writes: MomBlockRecord[] };
  export interface MomBlockRecord extends MomBlock { presetKey: string; hash: string; importedAt: string }
  // store (StudyStore)
  importMomContent(file: MomImportFile, nowIso: string): Promise<MomImportResult>;
  listMomBlocks(): Promise<MomBlockRecord[]>;
  listMomLessons(): Promise<MomLessonRecord[]>;
  saveMomLesson(rec: MomLessonRecord): Promise<{ record: MomLessonRecord; reused: boolean }>; // id 멱등: 있으면 그대로 반환
  listMomTests(): Promise<MomTestRecord[]>;
  saveMomTest(rec: Omit<MomTestRecord, "summaryKo">): Promise<{ record: MomTestRecord; reused: boolean }>;
  setMomTestSummary(id: string, summary: { goodKo: string; fixKo: string }): Promise<MomTestRecord | null>;
  ```

- [ ] **Step 1: 실패하는 eval 묶음 2(가져오기 결정·저장 계약)**
```ts
import { decideMomImport, momLessonSaveSchema, momTestSaveSchema } from "../lib/mom-contract";
```
```ts
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
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: `lib/mom-contract.ts`**
```ts
/**
 * lib/mom-contract.ts — 엄마의 생활영어 저장 계약(설계 §6-2). 순수 — 라우트·화면·스토어 공용.
 */
import { z } from "zod";
import { momBlockHash, type MomBlock, type MomImportFile } from "./mom-content";

export const MOM_VERDICTS = ["pass", "close", "retry", "skipped"] as const;
export type MomVerdict = (typeof MOM_VERDICTS)[number];
export const MOM_VERDICT_KO: Record<MomVerdict, string> = { pass: "맞음", close: "아깝다", retry: "다시", skipped: "넘어감" };

export interface MomCheck { sentenceId: string; verdict: MomVerdict; transcript: string | null; hintLevel: 0 | 1 | 2 | 3 }
export interface MomLessonRecord { id: string; lessonId: string; startedAt: string; finishedAt: string | null; checks: MomCheck[] }
export interface MomTestItem { sentenceId: string; verdict: MomVerdict; transcript: string | null; recorded: boolean }
export interface MomTestRecord {
  id: string;
  week: number;
  startedAt: string;
  finishedAt: string | null;
  items: MomTestItem[];
  summaryKo: { goodKo: string; fixKo: string } | null;
}
export interface MomBlockRecord extends MomBlock { presetKey: string; hash: string; importedAt: string }
export interface MomImportResult { created: string[]; updated: string[]; unchanged: string[] }

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ISO = z.string().datetime();
const transcript = z.string().max(400).nullable();

export const momLessonSaveSchema: z.ZodType<MomLessonRecord> = z
  .object({
    id: ID,
    lessonId: z.string().regex(/^(w\d{1,2}-d[1-4]|rw\d{1,2}-d[1-4])$/),
    startedAt: ISO,
    finishedAt: ISO.nullable(),
    checks: z
      .array(z.object({ sentenceId: z.string().min(1).max(80), verdict: z.enum(MOM_VERDICTS), transcript, hintLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict())
      .max(60),
  })
  .strict();

export const momTestSaveSchema: z.ZodType<Omit<MomTestRecord, "summaryKo">> = z
  .object({
    id: ID,
    week: z.number().int().min(1).max(60),
    startedAt: ISO,
    finishedAt: ISO.nullable(),
    items: z.array(z.object({ sentenceId: z.string().min(1).max(80), verdict: z.enum(MOM_VERDICTS), transcript, recorded: z.boolean() }).strict()).max(20),
  })
  .strict();

/** 가져오기 결정(순수) — 블록 id 기준 upsert. 해시 같으면 unchanged(쓰기 없음). 파일에 없는 기존 블록은 건드리지 않는다. */
export function decideMomImport(file: MomImportFile, existing: readonly MomBlockRecord[], nowIso: string): { result: MomImportResult; writes: MomBlockRecord[] } {
  const byId = new Map(existing.map((b) => [b.id, b]));
  const result: MomImportResult = { created: [], updated: [], unchanged: [] };
  const writes: MomBlockRecord[] = [];
  for (const b of file.blocks) {
    const hash = momBlockHash(b);
    const cur = byId.get(b.id);
    if (cur && cur.hash === hash) {
      result.unchanged.push(b.id);
      continue;
    }
    (cur ? result.updated : result.created).push(b.id);
    writes.push({ ...b, presetKey: file.presetKey, hash, importedAt: nowIso });
  }
  return { result, writes };
}
```

- [ ] **Step 4: 스토어** — `lib/store.ts`:
  1. import: `import type { MomBlockRecord, MomImportResult, MomLessonRecord, MomTestRecord } from "./mom-contract"; import { decideMomImport } from "./mom-contract"; import type { MomImportFile } from "./mom-content";`
  2. `StudyStore` 인터페이스에 위 7개 메서드(Interfaces 블록 그대로).
  3. `DbShape`에 `momContent: MomBlockRecord[]; momLessons: MomLessonRecord[]; momTests: MomTestRecord[];` → `emptyDb()`에 빈 배열 3개 → `readDb()`에 `momContent: (parsed.momContent ?? []) as MomBlockRecord[]`, `momLessons`, `momTests` 같은 꼴(정규화는 저장 시 zod로 했으므로 배열 확인만: `Array.isArray(x) ? x : []`) → `mergeDbForSeed()`에 `mergeById` 3개 → `scripts/seed.ts`의 `const db: DbShape`에 `momContent: [], momLessons: [], momTests: []`.
  4. file 백엔드 구현(모두 한 `this.mutate` 안):
  ```ts
  async importMomContent(file: MomImportFile, nowIso: string): Promise<MomImportResult> {
    return this.mutate((db) => {
      const { result, writes } = decideMomImport(file, db.momContent, nowIso);
      for (const w of writes) {
        const i = db.momContent.findIndex((b) => b.id === w.id);
        if (i >= 0) db.momContent[i] = w;
        else db.momContent.push(w);
      }
      return result;
    });
  }
  async listMomBlocks() { return (await this.read()).momContent.slice(); }
  async listMomLessons() { return (await this.read()).momLessons.slice(); }
  async saveMomLesson(rec: MomLessonRecord) {
    return this.mutate((db) => {
      const cur = db.momLessons.find((l) => l.id === rec.id);
      if (cur) return { record: cur, reused: true };
      db.momLessons.push(rec);
      return { record: rec, reused: false };
    });
  }
  async listMomTests() { return (await this.read()).momTests.slice(); }
  async saveMomTest(rec: Omit<MomTestRecord, "summaryKo">) {
    return this.mutate((db) => {
      const cur = db.momTests.find((t) => t.id === rec.id);
      if (cur) return { record: cur, reused: true };
      const full: MomTestRecord = { ...rec, summaryKo: null };
      db.momTests.push(full);
      return { record: full, reused: false };
    });
  }
  async setMomTestSummary(id: string, summary: { goodKo: string; fixKo: string }) {
    return this.mutate((db) => {
      const cur = db.momTests.find((t) => t.id === id);
      if (!cur) return null;
      cur.summaryKo = summary;
      return cur;
    });
  }
  ```
  (`this.read()`가 이 파일에서 다른 이름이면 그 이름 — 기존 `listReviewSchedules` 구현이 쓰는 읽기 함수를 따른다.)
  5. `lib/store-firestore.ts`: 컬렉션 접근자 `momContent()`·`momLessons()`·`momTests()`(`getDb().collection("momContent")` 등). `importMomContent`는 `runTransaction` 안에서 `file.blocks`의 id로 `tx.get` 전부(읽기 먼저) → `decideMomImport` → `tx.set(doc(w.id), frameFirestoreData(w))`. 블록 400개 상한이라 트랜잭션 쓰기 500 한도 안. `saveMomLesson`/`saveMomTest`는 `ref.create(frameFirestoreData(...))`, `GRPC_ALREADY_EXISTS`(6)면 `ref.get()`으로 기존 반환(`reused: true`) — `toeicIsland` 생성 관용구. `setMomTestSummary`는 `runTransaction`(get → 없으면 null → `tx.update({summaryKo})`). 목록은 `.get()` 후 메모리 정렬(`startedAt` 오름차순).

- [ ] **Step 5: 가져오기 라우트** — `app/api/mom/import/route.ts`:
```ts
/** POST /api/mom/import — 엄마의 생활영어 가져오기 파일(mom-english/v1). AI 없음. 블록 id upsert(해시 같으면 그대로). */
import { NextResponse } from "next/server";
import { momImportFileSchema } from "@/lib/mom-content";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", messageKo: "파일이 너무 커요(5MB까지)." }, { status: 413 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요." }, { status: 400 });
  }
  const parsed = momImportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "가져오기 파일 형식이 맞지 않아요.", issues }, { status: 400 });
  }
  try {
    const result = await getStore().importMomContent(parsed.data, new Date().toISOString());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[mom/import] 저장 실패", err);
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, { status: 500 });
  }
}
```

- [ ] **Step 6: 가져오기 버튼** — `components/mom-import-button.tsx`: `components/toeic-guide-import-button.tsx`의 흐름을 그대로(숨긴 file input `accept=".json,application/json"` → 5MB 사전 검사 → `JSON.parse(await file.text())` → `fetch("/api/mom/import", {method:"POST", headers:{"content-type":"application/json"}, body})` → 성공이면 `추가 n · 고침 n · 그대로 n` 표시 후 `router.refresh()`, 실패면 `messageKo`(+ 첫 이슈 path) 표시 → `e.target.value = ""`). Props `{ label?: string }`, 기본 라벨 "📥 파일로 가져오기".

- [ ] **Step 7: 통과·실측·커밋**
```bash
OPENAI_API_KEY= STORE_BACKEND=file EVAL_OFFLINE_ONLY=1 npm run -s eval:mom | tail -1   # PASS — 15
npx tsc --noEmit -p .
# 실측: db 백업 → dev 서버 → 지어낸 2블록 파일을 scratch에 쓰고 두 번 POST(두 번째 unchanged 2) → db 복원·sha 대조 → git checkout CLAUDE.md
git add lib/mom-contract.ts lib/store.ts lib/store-firestore.ts scripts/seed.ts app/api/mom/import/route.ts components/mom-import-button.tsx scripts/eval-mom.ts
git commit -m "feat(mom): 저장(momContent·momLessons·momTests)·가져오기 라우트·버튼"
```

---

### Task 3: 가져오기 파일 빌드 (오케스트레이터 직접 — 저장소 밖)

> 이 작업은 **서브에이전트가 아니라 오케스트레이터가** 한다(사용자 동의 2026-10-09: 한국어 뜻·끊는 위치 AI 1회). 산출물은 `data/private/mom-english-v1.json` 하나이고 **커밋하지 않는다**. 빌드 스크립트는 scratchpad에만 둔다.

**Files:**
- Create(git 밖): `data/private/mom-english-v1.json`, scratchpad의 `build-mom.mjs`

- [ ] **Step 1: 원자료 정리(사람 작업)** — Claude가 `design/mom_english/soritune_speaking.md`(10강)·`data/private/mom-english/transcripts/*.json`(100)·PDF 텍스트(`pdftotext -layout`)를 읽어 블록 초안 JSON을 scratch에 만든다:
  - md 10강 → 블록 `md-01`~`md-10`(stage 0, week = 강 순서로 1~4주에 2~3강씩), frame·slots·`explainKo`(Claude가 **새로 쓴** 쉬운 설명 — 강의 문장 인용 금지), 대표 예문 3~5개(`role: "core"`/`"expand"`).
  - mp3 100 → 블록 `mp3-001`~`mp3-100`: 핵심(`core`) 1, 확장(`expand`) 5, 대화(`dialog`) 4, 스몰토크(`smalltalk`) 6. 잘린 첫 문장은 대화·확장에서 같은 틀 문장으로 복원, 복원이 안 되면 `dialog`로 강등.
  - PDF 250 → 블록 `pdf-ch{1..5}-{nn}`: 장별로 틀이 같은 문장끼리 묶어 블록(frame = 공통 틀), 문장 `role: "situation"`, `ko`는 PDF의 한국어.
  - week 배치(Global Constraints 진도표): mp3 블록은 단계 범위 안에서 번호 순으로 주당 1(1단계)·2(2단계)·2~3(3단계)·2~3(4단계), 복습 주(8·16·24·32·40·48)에는 배치하지 않는다. PDF 블록은 단계별 장 배정(1단계: 1·4장, 2단계: 3·2·5장, 3단계: 남은 것)을 단어 수 오름차순으로 주마다 6~8문장씩.
- [ ] **Step 2: AI 번역·끊기(1회)** — `build-mom.mjs`가 `en`만 있고 `ko`가 없는 문장(md·mp3)과 모든 문장의 `chunks`를 묶음 40문장씩 텍스트 모델(`gpt-6-luna`, Structured Outputs `{items:[{id, ko, chunks}]}`)로 채운다. 키는 `.env`의 `OPENAI_API_KEY`를 `grep -oE 'sk-[A-Za-z0-9_-]+'`로 읽어 env로만 넘기고 출력하지 않는다. 지침: "입문자용 자연스러운 한국어 뜻(직역보다 뜻 전달), chunks는 소리 블록 단위 2~5덩어리(의도·핵심 동사·디테일), 이으면 원문과 같게". 응답의 `chunks` 조인 ≠ `en`이면 그 문장만 1회 재요청, 그래도 다르면 `chunks = [en]`.
- [ ] **Step 3: 검증·표본 검수** — `npx tsx -e` 로 `momImportFileSchema.parse(JSON.parse(readFileSync(...)))` 통과, 블록 수(md 10 + mp3 100 + PDF 약 40~60), 단계별 주당 말하기 문장 수가 진도표 범위인지 표로 출력. 각 단계에서 무작위 10문장의 `ko`·`chunks`를 Claude가 읽고 어색한 것을 고친다.
- [ ] **Step 4: 기록** — 커밋 없음. `git status --short`로 `data/private`가 안 보이는지 확인. 결과 요약(블록 수·문장 수·AI 호출 수·대략 비용)만 사용자에게 보고(문장 인용 금지).

---

### Task 4: 진도 엔진 `lib/mom-plan.ts`

**Files:**
- Create: `lib/mom-plan.ts`
- Modify: `scripts/eval-mom.ts`(묶음 3)

**Interfaces:**
- Consumes: `MomBlock`, `isSpeakRole` (Task 1), `MomLessonRecord`, `MomTestRecord` (Task 2)
- Produces:
  ```ts
  export const MOM_LESSONS_PER_WEEK = 4;
  export const MOM_REVIEW_WEEKS: readonly number[]; // [8,16,24,32,40,48]
  export const MOM_SLOWDOWN_THRESHOLD = 0.6;
  export function momStageOfWeek(week: number): 0|1|2|3|4;
  export function momTestSize(stage: 0|1|2|3|4): number; // 5,5,8,10,10
  export function momMinutesHint(stage): string; // "5~7분" …
  export interface MomLesson { id: string; week: number; day: 1|2|3|4; kind: "new"|"review"; blockId: string | null; speakIds: string[]; listenIds: string[] }
  export interface MomWeekPlan { week: number; stage; kind: "new"|"review"; lessons: MomLesson[] }
  export function buildMomWeeks(blocks: readonly MomBlock[]): MomWeekPlan[];
  export type MomTodayItem = { kind: "empty" } | { kind: "lesson"; lesson: MomLesson; stage; minutesHint: string } | { kind: "test"; week: number; stage; size: number } | { kind: "done" };
  export function momToday(input: { blocks: readonly MomBlock[]; lessons: readonly MomLessonRecord[]; tests: readonly MomTestRecord[] }): MomTodayItem;
  export function isFullMomLesson(rec: Pick<MomLessonRecord,"finishedAt"|"checks">, lesson: Pick<MomLesson,"speakIds">): boolean;
  export function isFullMomTest(rec: Pick<MomTestRecord,"finishedAt"|"items">): boolean;
  export function momTestPassRate(rec: Pick<MomTestRecord,"items">): number; // pass / items
  export function momPickTestItems(input: { week: number; blocks; lessons: readonly MomLessonRecord[]; size: number }): string[]; // 결정적
  export interface MomProgress { currentWeek: number; stage; doneLessons: number; totalLessons: number; weeks: { week: number; kind: "new"|"review"; status: "done"|"current"|"todo" }[] }
  export function momProgress(input: same as momToday): MomProgress;
  ```

**규칙(설계 §3 — 진도는 완료 순서)**
- `buildMomWeeks`: 블록을 `week`로 묶는다. 각 주의 말하기 문장(블록 순서 → 블록 안 문장 순서, `isSpeakRole`)을 4개 레슨에 **앞에서부터 고르게**(`ceil` 분할) 나누고, 레슨의 `blockId` = 그 레슨 첫 말하기 문장의 블록, `listenIds` = 그 블록의 `dialog` 문장. 블록이 없는 주(복습 주 8·16·…)는 `kind: "review"` 레슨 4개(`rw{week}-d{n}`, `speakIds` = 직전 8주 말하기 문장 중 결정적 5개씩 — 아래 `momPickTestItems`와 같은 시드 규칙). 레슨 id = `w{week}-d{day}`.
- `momToday`: 블록 0 → `empty`. 주를 오름차순으로 걸으며 ① 그 주 레슨 중 완료(`isFullMomLesson`) 안 된 첫 레슨 → `lesson`, ② 레슨 다 끝났는데 그 주 테스트(`week` 같은 완료 테스트)가 없으면 → `test`(복습 주도 테스트 있음), ③ 다음 주로. 끝까지 → `done`.
- **자동 감속**: 걸어가며, 직전 두 주(복습 주 제외)의 완료 테스트 맞음 비율이 둘 다 0.6 미만이고 다음 주가 `new`면, 그 다음 주 앞에 **가상 복습 주**(id `rw{week}x-d{n}` — 레슨 id 정규식에 맞게 `rw{N}` 형식, N = 감속이 걸린 다음 주 번호 + 100)를 끼운다. 이 가상 주의 레슨·테스트가 끝나면 원래 주로 진행. (가상 주 번호 = 다음 주 번호 + 100 → 표시는 "복습 주".)
- `momPickTestItems`: 그 주(복습 주는 직전 8주) 말하기 문장 중, 그 주 레슨 기록에서 `retry`·`close`였던 문장 먼저, 나머지는 `sentenceId`의 FNV 해시(`momBlockHash`와 같은 함수 꼴 — 문자열용 `hashStr` 내부 함수) + 주 번호 시드로 정렬해 `size`개.
- `isFullMomLesson`: `finishedAt !== null` 그리고 `speakIds` 모두에 대해 check가 있다(verdict 무엇이든 — `skipped` 포함).
- `isFullMomTest`: `finishedAt !== null` 그리고 items ≥ 1, 모든 item verdict 있음.

- [ ] **Step 1: 실패하는 eval 묶음 3**
```ts
import { buildMomWeeks, isFullMomLesson, momPickTestItems, momProgress, momStageOfWeek, momTestSize, momToday, MOM_REVIEW_WEEKS } from "../lib/mom-plan";
```
```ts
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
}
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** — `lib/mom-plan.ts`를 위 규칙대로. 핵심 코드:
```ts
/**
 * lib/mom-plan.ts — 엄마의 생활영어 진도 엔진(설계 §3·§6-3). 순수·결정적 — 진도는 달력이 아니라 완료 순서.
 */
import { isSpeakRole, type MomBlock } from "./mom-content";
import type { MomLessonRecord, MomTestRecord } from "./mom-contract";

export const MOM_LESSONS_PER_WEEK = 4;
export const MOM_REVIEW_WEEKS: readonly number[] = [8, 16, 24, 32, 40, 48];
export const MOM_SLOWDOWN_THRESHOLD = 0.6;
export const MOM_REVIEW_LESSON_SIZE = 5;
type Stage = 0 | 1 | 2 | 3 | 4;

export function momStageOfWeek(week: number): Stage {
  if (week <= 4) return 0;
  if (week <= 16) return 1;
  if (week <= 32) return 2;
  if (week <= 46) return 3;
  return 4;
}
export function momTestSize(stage: Stage): number {
  return [5, 5, 8, 10, 10][stage];
}
export function momMinutesHint(stage: Stage): string {
  return ["5~7분", "8~10분", "12~15분", "15~18분", "18~20분"][stage];
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export interface MomLesson { id: string; week: number; day: 1 | 2 | 3 | 4; kind: "new" | "review"; blockId: string | null; speakIds: string[]; listenIds: string[] }
export interface MomWeekPlan { week: number; stage: Stage; kind: "new" | "review"; lessons: MomLesson[] }

function speakOf(blocks: readonly MomBlock[]): { id: string; blockId: string }[] {
  return blocks.flatMap((b) => b.sentences.filter((s) => isSpeakRole(s.role)).map((s) => ({ id: s.id, blockId: b.id })));
}

function seededPick(ids: readonly string[], seed: number, size: number, first: readonly string[] = []): string[] {
  const head = first.filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !head.includes(id)).sort((a, b) => (hashStr(`${seed}:${a}`) - hashStr(`${seed}:${b}`)) || (a < b ? -1 : 1));
  return [...new Set([...head, ...rest])].slice(0, size);
}

function reviewLessons(weekLabel: number, idPrefix: string, pool: readonly string[]): MomLesson[] {
  const picked = seededPick(pool, weekLabel, MOM_REVIEW_LESSON_SIZE * MOM_LESSONS_PER_WEEK);
  return ([1, 2, 3, 4] as const).map((day) => ({
    id: `${idPrefix}-d${day}`,
    week: weekLabel,
    day,
    kind: "review",
    blockId: null,
    speakIds: picked.slice((day - 1) * MOM_REVIEW_LESSON_SIZE, day * MOM_REVIEW_LESSON_SIZE),
    listenIds: [],
  }));
}

export function buildMomWeeks(blocks: readonly MomBlock[]): MomWeekPlan[] {
  if (blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) => a.week - b.week || a.no - b.no || (a.id < b.id ? -1 : 1));
  const maxWeek = Math.max(...sorted.map((b) => b.week));
  const out: MomWeekPlan[] = [];
  for (let week = 1; week <= maxWeek; week++) {
    const wb = sorted.filter((b) => b.week === week);
    const stage = momStageOfWeek(week);
    if (wb.length === 0) {
      if (!MOM_REVIEW_WEEKS.includes(week)) continue;
      const pool = speakOf(sorted.filter((b) => b.week < week && b.week >= week - 8)).map((s) => s.id);
      out.push({ week, stage, kind: "review", lessons: reviewLessons(week, `rw${week}`, pool) });
      continue;
    }
    const speak = speakOf(wb);
    const per = Math.ceil(speak.length / MOM_LESSONS_PER_WEEK);
    const lessons: MomLesson[] = ([1, 2, 3, 4] as const)
      .map((day) => {
        const part = speak.slice((day - 1) * per, day * per);
        const blockId = part[0]?.blockId ?? null;
        const block = wb.find((b) => b.id === blockId);
        return {
          id: `w${week}-d${day}`,
          week,
          day,
          kind: "new" as const,
          blockId,
          speakIds: part.map((p) => p.id),
          listenIds: block ? block.sentences.filter((s) => s.role === "dialog").map((s) => s.id) : [],
        };
      })
      .filter((l) => l.speakIds.length > 0);
    out.push({ week, stage, kind: "new", lessons });
  }
  return out;
}
```
그리고 `isFullMomLesson`·`isFullMomTest`·`momTestPassRate`·`momPickTestItems`(그 주 블록의 말하기 문장, 복습 주는 직전 8주, `first` = 그 주 레슨 기록에서 retry·close였던 문장, `seededPick(ids, week, size, first)`)·`momToday`·`momProgress`를 규칙대로. 가상 복습 주: `{ week: next.week + 100, stage: momStageOfWeek(next.week), kind: "review", lessons: reviewLessons(next.week + 100, \`rw${next.week + 100}\`, 직전 8주 풀) }` — 레슨 id 정규식(`rw\d{1,2}`)이 세 자리를 못 받으므로 **Task 2의 `momLessonSaveSchema` lessonId 정규식을 `/^(w\d{1,2}-d[1-4]|rw\d{1,3}-d[1-4])$/`로 넓힌다**(이 Task에서 함께 수정·eval 묶음 2 재통과 확인). 가상 주 테스트의 `week` 값도 `next.week + 100`(`momTestSaveSchema` week 상한을 `160`으로 넓힌다).

- [ ] **Step 4: 통과 확인** — 묶음 3 15개 추가, 전체 PASS.

- [ ] **Step 5: 커밋**
```bash
npx tsc --noEmit -p .
git add lib/mom-plan.ts lib/mom-contract.ts scripts/eval-mom.ts
git commit -m "feat(mom): 진도 엔진(완료 순서·복습 주·자동 감속·테스트 문항)"
```

---

### Task 5: 발화 판정 `lib/mom-judge.ts`

**Files:**
- Create: `lib/mom-judge.ts`
- Modify: `scripts/eval-mom.ts`(묶음 4)

**Interfaces:**
- Consumes: `normalizeTemplateWords(text): string[]`, `sameTemplateWord(a,b): boolean` (`lib/toeic-template.ts`), `alignWordSeq` (`lib/toeic-score.ts`)
- Produces:
  ```ts
  export const MOM_PASS_CONTENT = 0.7; export const MOM_CLOSE_CONTENT = 0.4; export const MOM_FUNCTION_WORDS: ReadonlySet<string>;
  export interface MomJudge { verdict: "pass"|"close"|"retry"; frameOk: boolean; contentRate: number; missing: string[]; noSpeech: boolean; noteKo: string | null }
  export function frameWordsOf(frameText: string): string[]; // "~"·"…" 자리 표시를 뺀 틀 낱말(정규화)
  export function judgeMomSpeech(input: { en: string; frameText: string; transcript: string }): MomJudge;
  ```

규칙: `heard = normalizeTemplateWords(transcript)`; `noSpeech = heard.length < 2` → `retry`. 틀 낱말이 `heard`에 **순서대로**(부분 수열, `sameTemplateWord`) 있으면 `frameOk`. 단, 문장 `en`에 틀 낱말이 순서대로 없으면(예: PDF 상황 문장이 틀과 다른 변형) 틀 검사는 통과로 본다. 내용 낱말 = `normalizeTemplateWords(en)`에서 `MOM_FUNCTION_WORDS`(a, an, the, to, of, in, on, at, for, with, and, is, are, am, be)와 틀 낱말을 뺀 것(비면 틀 낱말을 내용으로). `contentRate` = 내용 낱말 중 `heard`에 `sameTemplateWord`로 하나라도 맞는 비율(단수·복수 차이는 끝 "s" 제거 비교로도 허용). `pass` = frameOk && rate ≥ 0.7, `close` = (frameOk && rate ≥ 0.4) || (!frameOk && rate ≥ 0.7), 그 밖 `retry`. `noteKo`: pass인데 기능어 차이가 있으면 "이렇게도 말해요: {en}", 아니면 null.

- [ ] **Step 1: 실패하는 eval 묶음 4**(지어낸 문장)
```ts
import { frameWordsOf, judgeMomSpeech } from "../lib/mom-judge";
```
```ts
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
}
```

- [ ] **Step 2: 실패 확인** · **Step 3: 구현**(위 규칙, `lib/toeic-template`·`lib/toeic-score`의 함수만 import — 둘 다 순수인지 import 줄로 확인) · **Step 4: 통과**

- [ ] **Step 5: 커밋**
```bash
npx tsc --noEmit -p .
git add lib/mom-judge.ts scripts/eval-mom.ts
git commit -m "feat(mom): 발화 판정(너그러운 틀·내용 비율)"
```

---

### Task 6: 홈 `/mom` + 받아쓰기 라우트 + 홈 진입 카드

**Files:**
- Create: `app/mom/page.tsx`, `components/mom-home.tsx`, `app/api/mom/transcribe/route.ts`
- Modify: `app/page.tsx`, `scripts/eval-mom.ts`(묶음 5 — 정적 배선)

**Interfaces:**
- Consumes: `getStore().listMomBlocks/listMomLessons/listMomTests`, `momToday`, `momProgress`, `momMinutesHint`, `MomImportButton`, `ReviewTodayCard`(Task 9 전에는 넣지 않는다 — Task 9에서 추가), `transcribeAnswer`, `hasToeicTranscribeApiKey` (`lib/toeic-transcribe.ts`), 타입 헬퍼 `isAcceptedToeicAudioType`·`toeicAudioBaseType`·`toeicAudioFileName`·`toeicAudioTypeFromName` (`lib/toeic-attempt-contract.ts`)
- Produces: `/mom` 화면, `POST /api/mom/transcribe`(multipart 필드 `"audio"`, ≤1MiB, 200 `{ok:true,text}` / 501 `no_api_key` / 400 / 413 / 499 / 500)

- [ ] **Step 1: 받아쓰기 라우트** — `app/api/toeic/guides/templates/transcribe/route.ts`를 **그대로 본떠** `app/api/mom/transcribe/route.ts`를 만든다(같은 검사 순서: 키 → 501 먼저, content-length → 413, formData의 `"audio"` → 400, 크기 → 413, `transcribeAnswer({bytes, fileName, type})` → 200 `{ok:true, text}` / aborted 499 / 그 밖 500 `{error:"transcribe_failed", retriable:true}`). 기대 문장을 보내지 않는다(받아쓰기 무유도). 상한 상수는 같은 파일 안 `const MOM_AUDIO_MAX_BYTES = 1024 * 1024`.

- [ ] **Step 2: 홈** — `app/mom/page.tsx`:
```tsx
import Link from "next/link";
import MomHome from "@/components/mom-home";
import { getStore } from "@/lib/store";
import { momProgress, momToday } from "@/lib/mom-plan";

export const dynamic = "force-dynamic";

export default async function MomPage() {
  const store = getStore();
  const [blocks, lessons, tests] = await Promise.all([store.listMomBlocks(), store.listMomLessons(), store.listMomTests()]);
  const today = momToday({ blocks, lessons, tests });
  const progress = momProgress({ blocks, lessons, tests });
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <Link href="/" className="u-navbtn">← 과목 선택</Link>
      <h1 className="t-book-title mt-3">👩 엄마의 생활영어</h1>
      <p className="t-lead">소리 블록으로 하루 한 레슨 — 듣고, 따라 하고, 말해 봐요.</p>
      <MomHome today={today} progress={progress} hasContent={blocks.length > 0} />
    </main>
  );
}
```
`components/mom-home.tsx`(client 불필요 — server component로 둬도 된다; 가져오기 버튼만 client):
  - `hasContent === false` → 안내 카드 "아직 학습 자료가 없어요. 받은 파일을 가져오면 시작돼요." + `<MomImportButton />`.
  - 오늘 카드: `lesson` → "오늘의 레슨 · {week}주차 {day}일 · 약 {minutesHint}" + 큰 버튼 `href=/mom/lesson/{lesson.id}`("시작하기"), 복습 레슨이면 "복습 레슨"; `test` → "이번 주 테스트 · {size}문제" + 버튼 `href=/mom/test/{week}`; `done` → "1회차를 다 했어요! 🎉".
  - 진도 지도: 52칸(가상 복습 주 제외) 그리드 — done ✓, current 강조, review 주는 🔁 표시, 단계 경계 라벨(0 몸풀기·1 부탁하고 원하기·2 일상 말하기·3 길게 잇기·4 원어민 표현).
  - 맨 아래 작은 링크 행: `<MomImportButton label="📥 자료 다시 가져오기" />`.

- [ ] **Step 3: 홈 진입 카드** — `app/page.tsx`의 운동 카드 앞에:
```tsx
        <Link href="/mom" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>👩</span>
          <span className="u-entry-title">엄마의 생활영어</span>
          <span className="u-entry-desc">하루 5분부터 — 소리 블록 틀로 듣고 따라 하고 말해 봐요.</span>
        </Link>
```

- [ ] **Step 4: eval 묶음 5(정적 배선)**
```ts
// ── 5) 배선(정적) ──
{
  const A = "배선";
  const tr = src("../app/api/mom/transcribe/route.ts");
  add(A, "받아쓰기: 키 검사가 formData보다 먼저·기대 문장 미전송", tr.indexOf("no_api_key") < tr.indexOf("formData()") && /transcribeAnswer\(/.test(tr) && !/prompt|expected|answer\s*:/.test(tr.replace(/transcribeAnswer/g, "")));
  add(A, "홈 진입 카드 /mom", /href="\/mom"/.test(src("../app/page.tsx")));
}
```

- [ ] **Step 5: 화면 확인** — db 백업 → dev 서버(키 비움) → Task 3 파일이 있으면 `/mom`에서 가져오기(없으면 Task 2의 지어낸 파일) → 360px 스크린샷(`.playwright-mcp/`, 끝나면 삭제) → 가로 넘침 0 → db 복원·sha 대조 → `git checkout CLAUDE.md`.

- [ ] **Step 6: 커밋**
```bash
OPENAI_API_KEY= STORE_BACKEND=file EVAL_OFFLINE_ONLY=1 npm run -s eval:mom | tail -1
npx tsc --noEmit -p .
git add app/mom/page.tsx components/mom-home.tsx app/api/mom/transcribe/route.ts app/page.tsx scripts/eval-mom.ts
git commit -m "feat(mom): 홈(오늘의 레슨·진도 지도)·받아쓰기 라우트·진입 카드"
```

---

### Task 7: 하루 레슨 `/mom/lesson/[id]` + 레슨 저장 라우트

**Files:**
- Create: `app/mom/lesson/[id]/page.tsx`, `components/mom-lesson-runner.tsx`, `app/api/mom/lessons/route.ts`, `lib/mom-lesson-script.ts`
- Modify: `scripts/eval-mom.ts`(묶음 6)

**Interfaces:**
- Consumes: `buildMomWeeks`, `momStageOfWeek`, `judgeMomSpeech`, `momLessonSaveSchema`, `getStore().saveMomLesson`, `speakQueue`·`unlockSpeechPlayback`·`prepareSpeech` (`lib/speech.ts` — `SpeakQueueItem {text, lang, pauseAfterMs?}`, 반환값이 정지 손잡이), `createMicKeeper`·`toWav16kMono`·`MIC_CHECK_GUM_TIMEOUT_MS` (`lib/mic-session.ts`), `toeicAudioFileName` (`lib/toeic-attempt-contract.ts`), `STREAK_REFRESH_EVENT` (`lib/streak.ts`)
- Produces:
  ```ts
  // lib/mom-lesson-script.ts (순수)
  export function momListenScript(s: { en: string; chunks: string[] }): SpeakQueueItem[]; // 덩어리마다 en-US, pauseAfterMs 600, 마지막에 전체 문장 1번
  export function momShadowScript(sentences: readonly { ko: string; en: string }[], repeat: number): SpeakQueueItem[]; // ko 1번(ko-KR, 400ms) → en × repeat(각 pauseAfterMs = 단어 수×450ms, 최소 1500)
  export function momShadowRepeat(stage: 0|1|2|3|4): number; // 0단계 3, 1~2단계 3, 3~4단계 2
  export function momHintText(en: string, level: 1|2|3, chunks: string[]): string; // 1 = 첫 낱말 + "…", 2 = 첫 덩어리 + "…", 3 = 전체
  // POST /api/mom/lessons  body = MomLessonRecord → 200 {ok:true, reused}
  ```

**레슨 흐름(설계 §4)** — `components/mom-lesson-runner.tsx`(client). props: `{ lesson: MomLesson; stage; frame: {text, slots} | null; explainKo: string | null; speak: {id, en, ko, chunks}[]; listen: {id, en, ko}[] }`.
  1. 단계 `"frame"`(복습 레슨이면 건너뜀): 틀 카드 — `frame.text`의 `~`를 빈칸 강조 span으로, 아래 `explainKo`. 버튼 "소리 듣기 ▶".
  2. 단계 `"listen"`: 레슨 첫 문장(핵심) `momListenScript` 재생(탭 안에서 `unlockSpeechPlayback()` 후 `speakQueue`, 손잡이 ref 보관, 화면 이탈·다음 단계에서 정지). "다시 듣기" / "다음".
  3. 단계 `"shadow"`: `momShadowScript(speak, momShadowRepeat(stage))` 재생, 진행 표시(`onItem`), "다음".
  4. 단계 `"check"`: 문장마다 카드(한국어 뜻 크게, 영어는 가림) → 🎤 탭 → `keeper.startRecording(first ? { gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS } : {})` → 다시 탭하면 `stop()` → `toWav16kMono`(실패 시 원본) → `FormData("audio", blob, toeicAudioFileName(type))` → `POST /api/mom/transcribe`(AbortController 15초) → `judgeMomSpeech({en, frameText: frame?.text ?? "", transcript})` → 판정 배지(맞음/아깝다/다시) + 정답 영어 공개 + 🔊 정답 듣기 + `noteKo`. "다시"면 "한 번 더"(재녹음) / 힌트 버튼(`momHintText` 1→2→3, hintLevel 기록) / **"넘어가기"**(verdict `skipped`). 받아쓰기 실패(501·500·네트워크·마이크 거부) → "지금은 받아쓰기를 못 해요" 안내 + "넘어가기"만(`skipped`, transcript null). 문장별 마지막 결과를 `checks`에 둔다(같은 문장 재시도는 덮어씀).
  5. 단계 `"dialog"`(listen이 있을 때, 선택): 대화 줄 목록 + "전체 듣기 ▶"(en-US, 줄마다 pauseAfterMs 800) + "건너뛰기".
  6. 끝: `finishedAt` 채워 `POST /api/mom/lessons`(id = 처음 마운트 때 `crypto.randomUUID()`를 `useRef`로 고정 — 재전송 멱등) → 성공 시 `window.dispatchEvent(new Event(STREAK_REFRESH_EVENT))` → "오늘 레슨 끝! 🔥" + "홈으로".
  - **중간에 나가면 저장하지 않는다**(Review Focus 2). 마이크는 언마운트에서 `keeper.release()`, 소리는 손잡이로 정지.
  - 문구는 입문자 눈높이(예: 🎤 "눌러서 말하고, 다 말하면 다시 눌러요").

`app/mom/lesson/[id]/page.tsx`(server, `force-dynamic`): `params: Promise<{id: string}>` → 블록·기록 읽기 → `buildMomWeeks(blocks)`(+ 가상 복습 주는 `momToday`가 내준 레슨이면 그것)에서 id로 레슨 찾기(없으면 `notFound()`) → 문장 id로 블록 문장 조회 → 러너에 props. "← 엄마의 생활영어" 뒤로가기.

`app/api/mom/lessons/route.ts`: `req.json()` → `momLessonSaveSchema.safeParse` 실패 400 → `finishedAt`이 null이면 400(`messageKo: "끝낸 레슨만 저장해요"`) → `getStore().saveMomLesson(data)` → 200 `{ok:true, reused}` / 500.

- [ ] **Step 1: 실패하는 eval 묶음 6**
```ts
import { momHintText, momListenScript, momShadowRepeat, momShadowScript } from "../lib/mom-lesson-script";
```
```ts
// ── 6) 레슨 대본·저장 ──
{
  const A = "레슨";
  const s = { en: "I would like a cup of tea.", ko: "차 한 잔 주세요.", chunks: ["I would like", "a cup of tea."] };
  const ls = momListenScript(s);
  add(A, "듣기: 덩어리 2 + 전체 1, 모두 en-US, 덩어리 뒤 쉼", ls.length === 3 && ls.every((x) => x.lang === "en-US") && (ls[0].pauseAfterMs ?? 0) > 0 && ls[2].text === s.en);
  const sh = momShadowScript([s], 3);
  add(A, "따라 말하기: ko 1 → en 3, en 쉼 ≥ 1500ms", sh.length === 4 && sh[0].lang === "ko-KR" && sh.slice(1).every((x) => x.lang === "en-US" && (x.pauseAfterMs ?? 0) >= 1500));
  add(A, "반복: 0~2단계 3, 3~4단계 2", [0, 1, 2, 3, 4].map((x) => momShadowRepeat(x as 0)).join() === "3,3,3,2,2");
  add(A, "힌트 1 첫 낱말 · 2 첫 덩어리 · 3 전체", momHintText(s.en, 1, s.chunks) === "I …" && momHintText(s.en, 2, s.chunks) === "I would like …" && momHintText(s.en, 3, s.chunks) === s.en);
  const route = src("../app/api/mom/lessons/route.ts");
  add(A, "저장 라우트: finishedAt null 거부·zod·멱등 저장", /finishedAt === null|finishedAt == null|!data\.finishedAt/.test(route) && /momLessonSaveSchema/.test(route) && /saveMomLesson/.test(route));
  const runner = src("../components/mom-lesson-runner.tsx");
  add(A, "러너: 넘어가기(skipped)·받아쓰기 실패 경로·완료 때만 저장·스트릭 갱신", /"skipped"/.test(runner) && /\/api\/mom\/transcribe/.test(runner) && /STREAK_REFRESH_EVENT/.test(runner) && (runner.match(/\/api\/mom\/lessons/g) ?? []).length === 1);
}
```

- [ ] **Step 2: 실패 확인** · **Step 3: 구현**(대본 모듈 → 라우트 → 페이지 → 러너) · **Step 4: eval 통과 + tsc**

- [ ] **Step 5: 화면 확인** — db 백업 → dev 서버(키 비움 → 받아쓰기 501 경로) → 레슨 열기 → 틀 카드·듣기·따라 말하기 단계 진행(소리는 501 → 기기 음성 폴백은 헤드리스에서 무음일 수 있음, 단계 전환만 확인) → 발화 체크에서 "넘어가기"로 전부 넘김 → 끝 → `momLessons` 1건, 홈이 다음 레슨(`w*-d2`)을 보임 → 중간에 나간 경우 저장 0 확인 → 복원·sha·`git checkout CLAUDE.md`. 가짜 마이크로 녹음까지는 Playwright `--use-fake-device-for-media-stream`이 가능하면 시도하고, 안 되면 "실기기 확인 필요"로 보고.

- [ ] **Step 6: 커밋**
```bash
git add lib/mom-lesson-script.ts app/api/mom/lessons/route.ts app/mom/lesson components/mom-lesson-runner.tsx scripts/eval-mom.ts
git commit -m "feat(mom): 하루 레슨(틀·듣기·따라 말하기·발화 체크·대화)·저장"
```

---

### Task 8: 주간 테스트 `/mom/test/[week]` + 녹음 보관 + 호출 M1 총평

**Files:**
- Create: `app/mom/test/[week]/page.tsx`, `components/mom-test-runner.tsx`, `app/api/mom/tests/route.ts`, `app/api/mom/tests/[id]/summary/route.ts`, `lib/ai/mom/prompts.ts`, `lib/ai/mom/schemas.ts`, `lib/ai/mom/calls.ts`
- Modify: `lib/toeic-rec-store.ts`(풀 타입에 `"mom"`), `scripts/eval-mom.ts`(묶음 7)

**Interfaces:**
- Consumes: `momPickTestItems`, `momTestSize`, `momStageOfWeek`, `judgeMomSpeech`, `momTestSaveSchema`, `saveMomTest`, `setMomTestSummary`, `callWithSchema`·`textPart` (`lib/ai/client.ts`), `resolveModel`, `saveToeicRecording`·`getToeicRecordingBlob`·`toeicRecKey` (`lib/toeic-rec-store.ts`)
- Produces:
  ```ts
  // lib/ai/mom/prompts.ts
  export const MOM_SUMMARY_SYSTEM_PROMPT: string;
  export const MOM_SUMMARY_CALL_OPTIONS = { call: "mom_summary", temperature: 0.4, maxOutputTokens: 400 } as const;
  export function buildMomSummaryUserMessage(items: readonly { ko: string; en: string; transcript: string | null; verdict: MomVerdict }[]): string;
  // lib/ai/mom/schemas.ts
  export const MOM_SUMMARY_JSON_SCHEMA: StrictJsonSchema; // {goodKo, fixKo}
  export const momSummaryZod: z.ZodType<{ goodKo: string; fixKo: string }>; // 각 1~120자, 한글 포함
  // lib/ai/mom/calls.ts
  export async function summarizeMomTest(items, signal?: AbortSignal): Promise<{ goodKo: string; fixKo: string }>;
  ```

**프롬프트(호출 M1)** — `MOM_SUMMARY_SYSTEM_PROMPT`:
```
너는 영어 말하기를 처음 배우는 성인(엄마)의 다정한 코치다. 이번 주 말하기 테스트 결과를 보고 한국어로 짧게 말해 준다.
- goodKo: 잘한 점 하나(구체적으로 — 어떤 문장·틀을 잘 말했는지). 1문장, 60자 안팎.
- fixKo: 다음 주에 고칠 점 하나(가장 자주 틀린 틀이나 소리 하나만, 쉬운 말로). 1문장, 60자 안팎.
- 영어 용어(관사·시제 등)는 쓰지 말고 쉬운 한국어로. 점수·등급·비교는 말하지 않는다.
- 받아쓰기는 기계가 받아 적은 것이라 틀릴 수 있다 — 발음을 단정하지 말고 "이렇게 들렸어요" 수준으로만.
- 영어 문장을 인용할 때는 입력에 있는 목표 문장만 그대로 쓴다.
```
`buildMomSummaryUserMessage`: 문항마다 `- 뜻: … / 목표: … / 받아쓰기: …(없으면 "없음") / 판정: 맞음|아깝다|다시|넘어감` 줄.
JSON Schema: `{name:"mom_summary", schema:{type:"object", additionalProperties:false, required:["goodKo","fixKo"], properties:{goodKo:{type:"string"}, fixKo:{type:"string"}}}}`; zod: 각 `z.string().trim().min(1).max(120).refine(/[가-힣]/.test)`.
`summarizeMomTest`: `callWithSchema({ ...MOM_SUMMARY_CALL_OPTIONS, system, user:[textPart(msg)], jsonSchema, zodSchema, model: resolveModel(), signal })`.

**테스트 화면(설계 §5)** — `components/mom-test-runner.tsx`(client). props `{ week; stage; items: {id, en, ko, frameText}[] }`(페이지가 `momPickTestItems`로 고름 — 이미 완료한 같은 주 테스트가 있으면 결과 화면으로).
  - 문항마다: 한국어 뜻만 → 🎤 녹음(Task 7과 같은 `createMicKeeper` 흐름) → 끝나면 ① 기기 저장 `saveToeicRecording({ attemptId: testId, pool: "mom", q: index, blob, mimeType, durationMs, … })` ② 받아쓰기 → `judgeMomSpeech`. 받아쓰기 실패면 verdict `skipped`, recorded true(녹음은 남음). "다음 문제".
  - 끝: `POST /api/mom/tests`(id = `useRef(crypto.randomUUID())` — 멱등) → 이어서 `POST /api/mom/tests/{id}/summary`(실패해도 결과 화면은 보임) → `STREAK_REFRESH_EVENT`.
  - 결과 화면: 맞음 n/전체, 문항별 판정·받아쓰기·정답, **내 녹음 ▶**(`getToeicRecordingBlob` → `<audio>`; 다른 기기면 "이 기기에 녹음이 없어요") / **원어민 ▶**(`speakQueue([{text: en, lang:"en-US"}])`), AI 총평 두 줄(없으면 숨김), "홈으로".
  - 중간에 나가면 저장하지 않는다(녹음은 기기에 남아도 무해 — 풀 상한 5로 정리).

`lib/toeic-rec-store.ts`: 풀 유니온을 `"mock" | "drill" | "mom"`으로 넓히고 풀별 보관 5 규칙이 `"mom"`에도 적용되는지 확인(다른 풀을 밀어내지 않음).

라우트:
  - `POST /api/mom/tests`: zod 400 → `finishedAt` null 400 → `saveMomTest` → 200 `{ok:true, reused, id}`.
  - `POST /api/mom/tests/[id]/summary`(`params: Promise<{id}>`): 테스트 없음 404 → 이미 `summaryKo` 있으면 그대로 200(키 없이도) → 키 없음 501 `no_api_key` → 블록에서 문항 문장(ko·en) 조회 → `summarizeMomTest` → `setMomTestSummary` → 200 `{ok:true, summaryKo}` / 500. **재전송은 저장된 총평 재사용**(Review Focus 5 — 호출 1회).

- [ ] **Step 1: 실패하는 eval 묶음 7**
```ts
import { MOM_SUMMARY_JSON_SCHEMA, momSummaryZod } from "../lib/ai/mom/schemas";
import { MOM_SUMMARY_CALL_OPTIONS, buildMomSummaryUserMessage } from "../lib/ai/mom/prompts";
```
```ts
// ── 7) 주간 테스트·M1 ──
{
  const A = "테스트·총평";
  add(A, "zod: 한글 1~120자 둘 다 필요", momSummaryZod.safeParse({ goodKo: "인사 틀을 잘 말했어요.", fixKo: "끝소리를 또렷하게 해 봐요." }).success && !momSummaryZod.safeParse({ goodKo: "good", fixKo: "ok" }).success && !momSummaryZod.safeParse({ goodKo: "가".repeat(121), fixKo: "나" }).success);
  const js = MOM_SUMMARY_JSON_SCHEMA.schema as { required: string[]; additionalProperties: boolean };
  add(A, "JSON Schema ↔ zod 필드 일치(goodKo·fixKo, 추가 필드 없음)", js.required.join() === "goodKo,fixKo" && js.additionalProperties === false);
  add(A, "호출 옵션 call=mom_summary", MOM_SUMMARY_CALL_OPTIONS.call === "mom_summary");
  const msg = buildMomSummaryUserMessage([{ ko: "차 주세요.", en: "Tea, please.", transcript: null, verdict: "skipped" }]);
  add(A, "사용자 메시지: 받아쓰기 없음 표기·판정 한국어", msg.includes("없음") && msg.includes("넘어감"));
  const sum = src("../app/api/mom/tests/[id]/summary/route.ts");
  add(A, "총평 라우트: 저장된 총평 재사용이 키 검사보다 먼저", sum.indexOf("summaryKo") < sum.indexOf("no_api_key") && /summarizeMomTest/.test(sum));
  add(A, "테스트 저장: 멱등·finishedAt null 거부", /saveMomTest/.test(src("../app/api/mom/tests/route.ts")) && /finishedAt/.test(src("../app/api/mom/tests/route.ts")));
  add(A, "녹음 풀에 mom", /"mom"/.test(src("../lib/toeic-rec-store.ts")));
}
```

- [ ] **Step 2: 실패 확인** · **Step 3: 구현** · **Step 4: eval·tsc 통과**

- [ ] **Step 5: 화면 확인**(키 비움): 테스트 열기 → 받아쓰기 501 → 문항 전부 skipped로 끝 → 저장 1건 → 총평 501(결과 화면은 보임) → 같은 저장 재전송 시 `reused: true` → 복원·sha·`git checkout CLAUDE.md`. 실호출 M1 1회는 **오케스트레이터가 사용자 동의 뒤**(eval 게이트 `EVAL_MOM=1` — Task 11에서 추가).

- [ ] **Step 6: 커밋**
```bash
git add app/mom/test components/mom-test-runner.tsx app/api/mom/tests lib/ai/mom lib/toeic-rec-store.ts scripts/eval-mom.ts
git commit -m "feat(mom): 주간 테스트·기기 녹음·AI 총평(M1)"
```

---

### Task 9: 오늘의 복습 영역 `mom`

**Files:**
- Modify: `lib/review-schedule.ts`, `lib/review-sources.ts`, `lib/review-server.ts`, `lib/phrase-helper-scope.ts`, `scripts/eval-review.ts`, `components/mom-home.tsx`
- Create: `app/mom/review/page.tsx`

**Interfaces:**
- Consumes: `ReviewSourceItem`, `ReviewCard`, `aggregateReviewStats`, `firstLetterHint`, `latinSkeleton`(`lib/review-sources.ts`), `MomBlockRecord`·`MomLessonRecord`·`MomTestRecord`, `ReviewRunner`, `ReviewTodayCard`, `loadReviewQueue`
- Produces: `REVIEW_AREAS` += `"mom"`, `REVIEW_KINDS` += `"mom-sentence"`, `REVIEW_KIND_AREA["mom-sentence"] = "mom"`, `REVIEW_KIND_LABEL_KO["mom-sentence"] = "엄마 문장"`, `REVIEW_AREA_PATH.mom = "/mom/review"`; `export function momSentenceItems(blocks, lessons, tests): ReviewSourceItem[]`

**어댑터 규칙**: 말하기 문장 중 **레슨에서 한 번이라도 결과가 있는 것**만(`skipped` 포함). 카드: `cue = {emoji:"👩", main: ko, sub: frame.text, lang:"ko"}`, `hint1 = firstLetterHint(en)`, `hint2 = chunks[0] + " …"`, `answer = {main: en, sub: ko, ruby: null}`, `speak = {text: en, lang:"en-US"}`, `sourceKo = "엄마의 생활영어 · {week}주차"`. 통계 = 레슨 checks + 테스트 items에서 `aggregateReviewStats`(틀림 = retry·close·skipped). `firstDueOn` = 그 문장을 처음 끝낸 레슨의 KST 날짜 + 1일(담은 다음 날부터 — 섬 관용구).

- [ ] **Step 1: eval-review에 실패 항목** — 기존 "모든 영역에 종류 ≥ 1" 점검(84행 근처)은 자동으로 `mom`을 요구하게 된다. 추가로 묶음 끝에:
```ts
  {
    const blocks = [{ id: "b1", week: 5, frame: { text: "I would like ~", slots: [] }, sentences: [{ id: "b1-s0", role: "core", en: "I would like tea.", ko: "차 주세요.", chunks: ["I would like", "tea."] }, { id: "b1-d0", role: "dialog", en: "Here.", ko: "여기요.", chunks: ["Here."] }] }];
    const lessons = [{ id: "c1", lessonId: "w5-d1", startedAt: "2026-10-10T03:00:00.000Z", finishedAt: "2026-10-10T03:05:00.000Z", checks: [{ sentenceId: "b1-s0", verdict: "retry", transcript: "x", hintLevel: 0 }] }];
    const items = momSentenceItems(blocks as never, lessons as never, []);
    add("엄마", "끝낸 말하기 문장만·dialog 제외·다음 날부터·틀림 1", items.length === 1 && items[0].card.itemKey === "mom-sentence:b1-s0" && items[0].stats.firstDueOn === "2026-10-11" && items[0].stats.wrongCount === 1, JSON.stringify(items[0]?.stats));
  }
```
(import `momSentenceItems` 추가. `examRows` 경로 목록(519행 근처)에 `/mom/review` 행을 기존 형식대로 추가.)

- [ ] **Step 2: 실패 확인** — `npm run -s eval:review`.

- [ ] **Step 3: 구현** — 상수 5곳, 어댑터, `REVIEW_SOURCES.mom = [{ kind: "mom-sentence", collect: async (store) => momSentenceItems(await store.listMomBlocks(), await store.listMomLessons(), await store.listMomTests()) }]`, `lib/phrase-helper-scope.ts`의 정규식에 `mom` 추가(`/^\/(english|japanese|toeic|mom)\/review$/`), `app/mom/review/page.tsx`(`app/toeic/review/page.tsx` 그대로 — area `"mom"`, tone `"adult"`, back `/mom` "엄마의 생활영어"), `components/mom-home.tsx`에 `<ReviewTodayCard area="mom" tone="adult" />`(오늘 카드 아래).

- [ ] **Step 4: 통과** — eval:review PASS(이전 85 + 새 항목), eval:mom·eval:streak 그대로 PASS, tsc.

- [ ] **Step 5: 커밋**
```bash
git add lib/review-schedule.ts lib/review-sources.ts lib/review-server.ts lib/phrase-helper-scope.ts scripts/eval-review.ts app/mom/review components/mom-home.tsx
git commit -m "feat(mom): 오늘의 복습 영역 mom(엄마 문장)"
```

---

### Task 10: 스트릭·가족·알림 통합

**Files:**
- Modify: `lib/streak-v2-sources.ts`, `lib/streak-server.ts`, `lib/push-decide.ts`, `components/streak-headline.tsx`, `scripts/eval-streak.ts`

**Interfaces:**
- Consumes: `isFullMomLesson`, `isFullMomTest`, `buildMomWeeks`(레슨 id → speakIds), `reviewFullDays`, `personV2`, `familyV2`, `weekCells`, `badgesOf`, `addRuns`
- Produces: `/api/streak` 응답의 `mom: PersonStreak`(블록이 하나도 없으면 여전히 null), `week.rows.mom`, `badges` 의 `mom`; `pushStates`가 실제 엄마 상태 사용

- [ ] **Step 1: 실패하는 eval(eval-streak 묶음 17 "엄마 트랙")**
```ts
// 17) 엄마 트랙(엄마의 생활영어 설계 §7)
{
  const B = "엄마 트랙";
  const ss = src("../lib/streak-server.ts");
  add(B, "가족 조립에 엄마 사람(momP) — null 아님", /familyV2\(\[eunwooP, appaP, momP\]/.test(ss), "");
  add(B, "엄마 runs = 완료 레슨 + 완료 테스트 + mom 복습 한 판", /isFullMomLesson/.test(ss) && /isFullMomTest/.test(ss) && /reviewFullDays\(reviewsOf\("mom"\)\)/.test(ss), "");
  add(B, "엄마 기록 읽기 실패는 엄마만 null(라우트 200)", /listMomLessons\(\)\.catch/.test(ss), "");
  const pd = src("../lib/push-decide.ts");
  add(B, "알림: 엄마 자리표시 제거·URL /mom", !/person: "mom", doneToday: true/.test(pd) && /mom: "\/mom"/.test(pd), "");
  add(B, "헤드라인 👩 칸", /emoji="👩"/.test(src("../components/streak-headline.tsx")), "");
}
```
(그리고 pushStates 순수 시험: `r.mom === null`이면 엄마는 **알림 대상에서 빠진다**(가족 알림 수신만을 위한 자리표시를 대체 — 아래 Step 3) — 항목 하나: `pushStates({...응답 모양, mom: null})`에 엄마 state가 없고 `prefs.mom.familyAlerts`가 참이어도 21:00 가족 알림 대상 판단은 별도로 동작.)

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**
  - `lib/streak-server.ts`: `Promise.all`에 `store.listMomBlocks().catch(() => null)`, `store.listMomLessons().catch(() => null)`, `store.listMomTests().catch(() => null)`. 셋 다 있고 블록 ≥ 1이면 `momT: TrackInput = { legacyDays: new Set(), runs }` — runs: 완료 레슨(`buildMomWeeks`로 lessonId → speakIds 매핑, 가상 복습 주 레슨은 `rw`로 시작하면 checks 수 ≥ 1이면 완료로) `addRuns(m, …startedAt)`, 완료 테스트 `addRuns`, `addDays(m, reviewFullDays(reviewsOf("mom")))`. `momP = personV2([momT], today)`; `familyV2([eunwooP, appaP, momP], today)`; `week.rows.mom = weekCells({info: momP.info, litDays: momP.litDays, weekDays, today, startDay: momP.startDay})`; badges에 `{key:"mom", ...badgesOf(momP.info)}`; 응답 `mom = { info: momP.info, todayLabel }`(라벨: 오늘 완료 레슨이면 `레슨 · {week}주차`, 테스트면 `주간 테스트 · {week}주차`, 복습이면 기존 `reviewTodayLabel(reviewsOf("mom"), today)`). 엄마 데이터가 없거나 실패면 지금처럼 `mom: null`. v2 실패 폴백 경로에도 `mom: null` 유지.
  - `lib/push-decide.ts` `pushStates`: `if (r.mom) out.push(s("mom", r.mom.info))` 그대로, **else 분기의 자리표시 삭제**. 대신 가족 알림 수신 판단을 states와 분리: `decidePushes`의 가족 알림 루프가 `input.states`가 아니라 `PUSH_PEOPLE` 중 `prefs[p].familyAlerts`인 사람을 돌게 바꾸고, 그 사람의 state가 없으면 상한 계산을 `sentCount`로만 한다(엄마 영역 전에도 엄마 폰이 21:00 "은우가 아직이에요"를 받음). `URL_OF.mom = "/mom"`. eval-streak 묶음 15의 기존 가족 알림 항목이 계속 통과해야 한다.
  - `components/streak-headline.tsx`: 아빠 묶음 뒤 구분선 + `<Person emoji="👩" name="엄마" p={data?.mom ?? undefined} compact={compact} />`(엄마가 null이면 렌더하지 않음 — `data?.mom &&`), `compact` 배열에 `data.mom`, aria-label `"학습 스트릭 — 가족, 은우, 아빠(어학·운동), 엄마"`. 만회 안내는 `needsMoreToday`/`repairHintText` 기존 함수 그대로.
  - 360·390px 폭 재실측(응답 주입 두 자리, 엄마 포함) — 넘치면 `compact` 문턱 유지 상태에서 엄마 칸 이름을 폰에서 sr-only로.

- [ ] **Step 4: 통과** — eval:streak 전체 PASS(이전 138 + 새 항목), eval:mom·eval:review PASS, tsc, `npm run build` 통과.

- [ ] **Step 5: 커밋**
```bash
git add lib/streak-v2-sources.ts lib/streak-server.ts lib/push-decide.ts components/streak-headline.tsx scripts/eval-streak.ts
git commit -m "feat(mom): 엄마 스트릭 트랙·가족 연속일 참여·알림 실제 상태"
```

---

### Task 11: 하네스·문서

**Files:**
- Create: `docs/harness/mom.md`
- Modify: `docs/HARNESS.md`(과목표 행), `docs/SPEC.md`(§24 append — `## 18.` 같은 기존 절 번호 불변, 파일 끝에 새 절), `README.md`(소개·eval·판단 기록 1행), `CLAUDE.md`(서문 한 구 + 변경 이력 1행 — `<!-- BEGIN:nextjs-agent-rules -->` **위**), `docs/BACKLOG.md`(과제: mp3 원음 연결 — 제안 시점 단서 "합성 음성 연음이 아쉽다는 신호"), `.claude/skills/study-orchestrator/SKILL.md`(subject `mom` — 과목 판별 단서: 엄마·생활영어·소리 블록·여권 문장·레슨·주간 테스트(엄마); "영어"만으로는 은우·아빠·엄마를 가르지 못함; 비용 줄: 레슨 받아쓰기 문장당 1회, 테스트 받아쓰기 문항당 1 + M1 1회), `scripts/eval-mom.ts`(spec-sync + `EVAL_MOM=1` 게이트)

- [ ] **Step 1: `docs/harness/mom.md`** — 절: §0 학습자·눈높이(입문 성인), §1 호출 표(M1만 — 받아쓰기는 관문 T 재사용), §2 M1 원문(코드블록에 `MOM_SUMMARY_SYSTEM_PROMPT` 그대로, JSON Schema 그대로, 호출 옵션 문장), §3 판정 규칙(상수 값), §4 진도 엔진 규칙, §5 eval(오프라인 항목 수, 게이트 `EVAL_MOM=1` = M1 1회 — 지어낸 5문항), §6 저작권(자료 위치·금지 사항).
- [ ] **Step 2: spec-sync + 게이트(eval-mom 묶음 8)**
```ts
// ── 8) spec-sync + 실호출 게이트 ──
{
  const A = "spec-sync";
  const spec = src("../docs/harness/mom.md");
  const { MOM_SUMMARY_SYSTEM_PROMPT } = await import("../lib/ai/mom/prompts");
  add(A, "M1 시스템 프롬프트가 스펙 코드블록과 같다", spec.includes(MOM_SUMMARY_SYSTEM_PROMPT.trim()));
  add(A, "판정 상수가 스펙에 적힌 값과 같다(0.7·0.4)", spec.includes("0.7") && spec.includes("0.4"));
}
```
(`await import`는 출력용 `void (async () => …)` 블록 안으로 옮기거나 파일 위쪽 정적 import로 바꾼다 — tsx ESM top-level await 지원이면 그대로.) 게이트: `if (process.env.EVAL_MOM === "1" && !process.env.EVAL_OFFLINE_ONLY)` 이면 지어낸 5문항으로 `summarizeMomTest` 1회 → zod 통과·한글 포함을 항목으로. 기본은 실행 안 함.
- [ ] **Step 3: 나머지 문서** — 위 Files 목록대로. 교재 문장 인용 금지(예시는 지어낸 것).
- [ ] **Step 4: 전체 검증**
```bash
for t in mom streak review speech toeic english japanese workout; do OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= EVAL_OFFLINE_ONLY=1 npm run -s eval:$t | tail -1; done
npx tsc --noEmit -p .
OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= K_SERVICE= npm run build
git checkout CLAUDE.md 2>/dev/null; git status --short   # data/private·design 미노출 확인
```
- [ ] **Step 5: 교재 유출 스캔** — `data/private/mom-english-v1.json`의 영어 문장 전부를 추적 파일(`git ls-files -co --exclude-standard`)에서 고정 문자열 검색 → 0건이어야 한다(스크립트는 scratch에).
- [ ] **Step 6: 커밋**
```bash
git add docs/harness/mom.md docs/HARNESS.md docs/SPEC.md README.md CLAUDE.md docs/BACKLOG.md .claude/skills/study-orchestrator/SKILL.md scripts/eval-mom.ts
git commit -m "docs(mom): 하네스 스펙·SPEC·README·오케스트레이터 과목 mom"
```

---

## 배포 뒤(오케스트레이터)

1. 사용자 승인 → main 푸시 → 배포 확인.
2. `data/private/mom-english-v1.json`을 엄마 폰으로 보내(SendUserFile) 앱 `/mom`의 "파일로 가져오기"로 넣게 안내 — 프로덕션 DB에 로컬에서 쓰지 않는다.
3. 동의 뒤 `EVAL_MOM=1` M1 1회.
4. 엄마 폰 실기기: 홈 화면 앱·마이크 권한·레슨 1개·소리(합성 음성)·테스트 녹음 ▶·알림 "나는 엄마".

## Self-Review 결과

- 스펙 커버리지: §1·§6-1 → Task 1·3, §6-2 → Task 2, §3·§6-3 → Task 4, §4-1 → Task 5, §4 → Task 6·7, §5 → Task 8, 복습 → Task 9, §7 → Task 10, §8 → Task 8·11, §9 → 각 Task eval + Task 11 Step 4·5, §10 순서 = Task 순서(빌드를 Task 3으로 당겨 이후 화면 확인에 실제 파일을 쓴다).
- 설계와 달라진 점(설계 문서 갱신은 Task 11에서): ① 주간 테스트는 **요일이 아니라 그 주 레슨 4개를 끝낸 다음 차례**로 연다(설계의 "진도는 완료 순서" 원칙과 맞추기 위해 — 금요일 고정은 밀린 레슨과 충돌). ② 레슨 하나 = 그 주 말하기 문장을 4등분한 묶음(설계의 "주당 블록 n개"를 하루 단위로 고르게 나눈 것). ③ 가족 알림 수신을 사람 state와 분리해 엄마 자리표시를 없앤다.
- 이름 일관성: `MomBlock`·`MomBlockRecord`·`MomLessonRecord`·`MomTestRecord`·`MomVerdict`·`momImportFileSchema`·`decideMomImport`·`buildMomWeeks`·`momToday`·`momProgress`·`momPickTestItems`·`isFullMomLesson`·`isFullMomTest`·`judgeMomSpeech`·`frameWordsOf`·`momListenScript`·`momShadowScript`·`momShadowRepeat`·`momHintText`·`summarizeMomTest`·`momSentenceItems` — 정의 Task와 사용 Task 대조 완료.

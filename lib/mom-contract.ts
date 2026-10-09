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
    lessonId: z.string().regex(/^(w\d{1,2}-d[1-4]|rw\d{1,3}-d[1-4])$/),
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
    week: z.number().int().min(1).max(160),
    startedAt: ISO,
    finishedAt: ISO.nullable(),
    items: z.array(z.object({ sentenceId: z.string().min(1).max(80), verdict: z.enum(MOM_VERDICTS), transcript, recorded: z.boolean() }).strict()).max(20),
  })
  .strict();

/**
 * 가져오기 결정(순수) — 블록 id 기준 upsert. 해시 같으면 unchanged(쓰기 없음). 파일에 없는 기존 블록은 건드리지 않는다.
 * 해시는 zod를 통과한 파일 블록에서만 계산하고, 기존 쪽은 **저장된 hash 필드**와 비교한다 — 저장 문서를 다시 해시하지 않는다
 * (Firestore 왕복이 키 순서를 바꿀 수 있다).
 */
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

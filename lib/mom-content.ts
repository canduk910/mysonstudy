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

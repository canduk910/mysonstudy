/**
 * lib/ja-daily-content.ts — 🗓️ 오늘의 일본어 **반입 계약** `ja-daily/v1` (설계 docs/superpowers/specs/2026-11-15-ja-daily-design.md §2-1).
 * 순수 — 라우트·저장소·eval이 같은 zod를 쓴다.
 *
 * 교재 내용(회화 대본·N5 단어·청해·모의 문항)은 **이 형식의 파일(git 밖 `data/private/`)로만** 들어온다. 이 모듈·eval·리포트에 교재 문장을 두지 않는다.
 *
 * - 토큰 무결성은 일본어 단어장과 **같은 zod**를 쓴다(`jaTokenSchema` — reading은 한자만인 토큰에만·히라가나만, 한자+가나 섞인 토큰에
 *   reading이면 거부, 가나 토큰의 reading은 null로 정리 / `tokensJoinEqual` — surface를 이으면 원문과 같다, japanese.md §5).
 * - 가타카나 외래어 정규화는 반입 파일을 만들 때 한다 — 계약은 단어의 `written`·`reading`을 둘 다 받고, reading은 가나(히라가나·가타카나·ー)만.
 * - id 형식 `^[a-z0-9][a-z0-9-]{0,63}$`, **파일 전체 유일**(과·문장·단어·요령·청해 문항·지문·모의 문항 id를 한 집합으로 본다).
 * - 문장 밑줄 표시는 `[[ ]]`(짝이 맞고 중첩 없음).
 * - 문서 수 상한(과 64 + 날 40 + 요령 40 + 청해 300 + 모의 6 = 450)은 Firestore 트랜잭션 쓰기 500 한도 안에 들게 정했다.
 *
 * ⚠️ 번들 경계: 이 모듈은 `lib/ai/japanese/schemas`(zod)를 **값으로** import한다(토큰 규칙을 두 벌 두지 않으려고). 화면은 타입만
 *   `import type`으로 가져간다 — 값을 import하면 zod와 일본어 스키마 모듈이 폰 번들로 딸려 간다. 검증은 서버 라우트가 한다.
 */
import { z } from "zod";
import { jaTokenSchema, tokensJoinEqual } from "./ai/japanese/schemas";

export const JA_DAILY_IMPORT_FORMAT = "ja-daily/v1";

/** 저장 종류 — 문서 id는 `{kind}:{id}` */
export const JA_DAILY_CONTENT_KINDS = ["lesson", "vocab", "tip", "litem", "mock"] as const;
export type JaDailyContentKind = (typeof JA_DAILY_CONTENT_KINDS)[number];

export const JA_DAILY_TRACK_PARTS = ["sound", "kaiwa1", "kaiwa2", "renshu1", "renshu2"] as const;
export type JaDailyTrackPart = (typeof JA_DAILY_TRACK_PARTS)[number];

export const JA_DAILY_MOCK_SECTIONS = ["moji", "bunpou", "dokkai", "listening"] as const;
export type JaDailyMockSectionName = (typeof JA_DAILY_MOCK_SECTIONS)[number];

/** 개수·글자 상한 — 한 곳에서 정의한다 */
export const JA_DAILY_LIMITS = {
  lessons: 64,
  vocabDays: 40,
  tips: 40,
  litems: 300,
  mocks: 6,
  tracksPerLesson: 24,
  linesPerTrack: 120,
  wordsPerDay: 60,
  pointsKo: 12,
  sectionsPerMock: 24,
  itemsPerSection: 40,
  passagesPerSection: 12,
  scriptLines: 80,
  jaMax: 300,
  koMax: 400,
  titleMax: 120,
  pointMax: 400,
  stemMax: 800,
  choiceMax: 300,
  passageMax: 4000,
  explanationMax: 3000,
  wordMax: 40,
  meaningMax: 120,
  audioKeyMax: 64,
} as const;

// ---------------------------------------------------------------------------
// 타입 (설계 §2-1 그대로 — 선택 키는 반입 파일 모양을 따른다. 저장은 JSON 왕복이라 undefined가 Firestore로 새지 않는다)
// ---------------------------------------------------------------------------

export interface JaDailyToken {
  surface: string;
  reading: string | null;
}
export interface JaDailyLine {
  id: string;
  speaker: string | null;
  ja: string;
  tokens: JaDailyToken[];
  ko: string;
}
export interface JaDailyTrack {
  audioKey: string;
  part: JaDailyTrackPart;
  lines: JaDailyLine[];
}
export interface JaDailyLesson {
  id: string;
  step: 1 | 2 | 3;
  lesson: number;
  kind: "kana" | "dialog";
  titleJa: string;
  titleKo: string;
  pointsKo: string[];
  tracks: JaDailyTrack[];
  keyLineIds: string[];
}
export interface JaDailyWord {
  id: string;
  written: string;
  reading: string;
  meaningKo: string;
}
export interface JaDailyVocabDay {
  day: number;
  words: JaDailyWord[];
}
export interface JaDailyListeningTip {
  id: string;
  audioKey: string;
  titleKo: string;
  pointsKo: string[];
}
export interface JaDailyScriptLine {
  speaker: string | null;
  ja: string;
  ko: string;
}
export interface JaDailyListeningItem {
  id: string;
  audioKey: string;
  mondai: 1 | 2 | 3 | 4;
  no: number;
  example?: boolean;
  situationJa: string | null;
  questionJa: string | null;
  script: JaDailyScriptLine[];
  choices: { ja: string; ko: string }[] | null;
  /** 1부터 */
  answer: number | null;
  answerKo?: string;
  explanationKo?: string;
}
export interface JaDailyMockItem {
  id: string;
  no: number;
  passageId?: string;
  audioKey?: string;
  stemJa: string;
  choices: string[];
  /** 1부터 */
  answer: number;
  needsImage?: boolean;
  /** 청해 상황 문장·문제3 장면 */
  introJa?: string;
  questionJa?: string;
  /** 그림 보기 문항의 보기별 한국어 설명 — 길이 = choices 길이 */
  imageChoicesKo?: string[];
  /** 보기가 소리로만 나온다 — 답하기 전엔 보기 글자를 숨긴다 */
  choicesAreAudio?: boolean;
  script?: { speaker: string | null; ja: string }[];
  translationKo?: string;
  explanationKo?: string;
}
export interface JaDailyMockSection {
  section: JaDailyMockSectionName;
  mondai: number;
  /** 문항 하나의 배점 */
  points: number;
  instructionJa?: string;
  instructionKo?: string;
  passages?: { id: string; ja: string; ko?: string; introJa?: string }[];
  items: JaDailyMockItem[];
}
export interface JaDailyMock {
  round: number;
  sections: JaDailyMockSection[];
}
export interface JaDailyImportFile {
  format: typeof JA_DAILY_IMPORT_FORMAT;
  presetKey: string;
  lessons: JaDailyLesson[];
  vocabDays: JaDailyVocabDay[];
  listening: { tips: JaDailyListeningTip[]; items: JaDailyListeningItem[] };
  mocks: JaDailyMock[];
}

// ---------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------

const L = JA_DAILY_LIMITS;
export const JA_DAILY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = z.string().regex(JA_DAILY_ID_RE, "id는 소문자·숫자·하이픈(64자까지)");
const AUDIO_KEY = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "audioKey는 영문·숫자·_.-(64자까지)");
/** 앞뒤 공백 없는 비어 있지 않은 글(일본어는 토큰 무결성 때문에 공백을 정리하지 않는다 — 앞뒤 공백만 거부) */
const exact = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() === s, { message: "앞뒤 공백이 없어야 해요" });
const ko = (max: number) => z.string().trim().min(1).max(max);
/** 화자 — 자유 문자열("A"·"B"·"C"·"男"·"女" 등) 또는 null */
const SPEAKER = z.string().trim().min(1).max(40).nullable();
const KANA_READING = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/;

/** `[[ ]]` 밑줄 표시 — 짝이 맞고 중첩·빈 표시가 없어야 한다 */
export function isUnderlineMarkupValid(s: string): boolean {
  const rest = s.replace(/\[\[[^[\]]+\]\]/g, "");
  return !rest.includes("[[") && !rest.includes("]]");
}
const marked = (max: number) => exact(max).refine(isUnderlineMarkupValid, { message: "밑줄 표시 [[ ]]의 짝이 맞지 않아요" });

const lineSchema = z
  .object({
    id: ID,
    speaker: SPEAKER,
    ja: exact(L.jaMax),
    tokens: z.array(jaTokenSchema).min(1).max(200),
    ko: ko(L.koMax),
  })
  .strict()
  .refine((l) => tokensJoinEqual(l.tokens, l.ja), { message: "토큰 surface를 이으면 ja와 같아야 해요", path: ["tokens"] });

const trackSchema = z
  .object({ audioKey: AUDIO_KEY, part: z.enum(JA_DAILY_TRACK_PARTS), lines: z.array(lineSchema).max(L.linesPerTrack) })
  .strict();

const lessonSchema = z
  .object({
    id: ID,
    step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    lesson: z.number().int().min(1).max(99),
    kind: z.enum(["kana", "dialog"]),
    titleJa: exact(L.titleMax),
    titleKo: ko(L.titleMax),
    pointsKo: z.array(ko(L.pointMax)).max(L.pointsKo),
    tracks: z.array(trackSchema).min(1).max(L.tracksPerLesson),
    keyLineIds: z.array(ID).max(12),
  })
  .strict()
  .superRefine((l, ctx) => {
    const lineIds = new Set(l.tracks.flatMap((t) => t.lines.map((x) => x.id)));
    l.keyLineIds.forEach((k, i) => {
      if (!lineIds.has(k)) ctx.addIssue({ code: "custom", path: ["keyLineIds", i], message: "keyLineIds는 그 과의 문장 id여야 해요" });
    });
    if (new Set(l.keyLineIds).size !== l.keyLineIds.length) ctx.addIssue({ code: "custom", path: ["keyLineIds"], message: "keyLineIds가 겹쳐요" });
  });

const wordSchema = z
  .object({
    id: ID,
    written: exact(L.wordMax),
    reading: z.string().min(1).max(L.wordMax).regex(KANA_READING, "reading은 가나만"),
    meaningKo: ko(L.meaningMax),
  })
  .strict();

const vocabDaySchema = z.object({ day: z.number().int().min(1).max(99), words: z.array(wordSchema).min(1).max(L.wordsPerDay) }).strict();

const tipSchema = z
  .object({ id: ID, audioKey: AUDIO_KEY, titleKo: ko(L.titleMax), pointsKo: z.array(ko(L.pointMax)).max(L.pointsKo) })
  .strict();

const scriptLineSchema = z.object({ speaker: SPEAKER, ja: exact(L.jaMax), ko: ko(L.koMax) }).strict();

const listeningItemSchema = z
  .object({
    id: ID,
    audioKey: AUDIO_KEY,
    mondai: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    no: z.number().int().min(0).max(99),
    example: z.boolean().optional(),
    situationJa: exact(L.stemMax).nullable(),
    questionJa: exact(L.stemMax).nullable(),
    // 문제3은 대화 없이 situationJa만 있을 수 있다 — 빈 배열 허용
    script: z.array(scriptLineSchema).max(L.scriptLines),
    choices: z
      .array(z.object({ ja: exact(L.choiceMax), ko: ko(L.choiceMax) }).strict())
      .min(2)
      .max(4)
      .nullable(),
    answer: z.number().int().min(1).max(4).nullable(),
    answerKo: ko(L.choiceMax).optional(),
    explanationKo: ko(L.explanationMax).optional(),
  })
  .strict()
  .superRefine((it, ctx) => {
    if ((it.choices === null) !== (it.answer === null)) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "보기가 있으면 정답도, 없으면 정답도 없어야 해요" });
    } else if (it.choices && it.answer !== null && it.answer > it.choices.length) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "answer는 1..보기 수" });
    }
  });

const mockItemSchema = z
  .object({
    id: ID,
    no: z.number().int().min(0).max(99),
    passageId: ID.optional(),
    audioKey: AUDIO_KEY.optional(),
    // 청해 모의 문항은 문제 문장이 소리로만 나오는 경우가 있어 빈 문자열을 허용한다(앞뒤 공백·밑줄 짝 규칙은 같다)
    stemJa: z
      .string()
      .max(L.stemMax)
      .refine((s) => s.trim() === s, { message: "앞뒤 공백이 없어야 해요" })
      .refine(isUnderlineMarkupValid, { message: "밑줄 표시 [[ ]]의 짝이 맞지 않아요" }),
    choices: z.array(marked(L.choiceMax)).min(2).max(4),
    answer: z.number().int().min(1).max(4),
    needsImage: z.boolean().optional(),
    introJa: exact(L.stemMax).optional(),
    questionJa: exact(L.stemMax).optional(),
    imageChoicesKo: z.array(ko(L.choiceMax)).min(2).max(4).optional(),
    choicesAreAudio: z.boolean().optional(),
    script: z.array(z.object({ speaker: SPEAKER, ja: exact(L.jaMax) }).strict()).max(L.scriptLines).optional(),
    translationKo: ko(L.explanationMax).optional(),
    explanationKo: ko(L.explanationMax).optional(),
  })
  .strict()
  .refine((it) => it.answer <= it.choices.length, { message: "answer는 1..보기 수", path: ["answer"] })
  .refine((it) => it.imageChoicesKo === undefined || it.imageChoicesKo.length === it.choices.length, {
    message: "imageChoicesKo 길이는 보기 수와 같아야 해요",
    path: ["imageChoicesKo"],
  });

const mockSectionSchema = z
  .object({
    section: z.enum(JA_DAILY_MOCK_SECTIONS),
    mondai: z.number().int().min(1).max(20),
    points: z.number().int().min(0).max(20),
    instructionJa: exact(L.stemMax).optional(),
    instructionKo: ko(L.stemMax).optional(),
    passages: z.array(z.object({ id: ID, ja: marked(L.passageMax), ko: ko(L.passageMax).optional(), introJa: exact(L.stemMax).optional() }).strict()).max(L.passagesPerSection).optional(),
    items: z.array(mockItemSchema).min(1).max(L.itemsPerSection),
  })
  .strict()
  .superRefine((s, ctx) => {
    const pids = new Set((s.passages ?? []).map((p) => p.id));
    s.items.forEach((it, i) => {
      if (it.passageId !== undefined && !pids.has(it.passageId)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "passageId"], message: "passageId는 같은 섹션의 지문 id여야 해요" });
      }
    });
  });

const mockSchema = z.object({ round: z.number().int().min(1).max(20), sections: z.array(mockSectionSchema).min(1).max(L.sectionsPerMock) }).strict();

/** 파일 안의 모든 id(종류 무관) — 파일 전체 유일 검사용 */
export function jaDailyAllIds(f: Pick<JaDailyImportFile, "lessons" | "vocabDays" | "listening" | "mocks">): string[] {
  const ids: string[] = [];
  for (const l of f.lessons) {
    ids.push(l.id);
    for (const t of l.tracks) for (const x of t.lines) ids.push(x.id);
  }
  for (const d of f.vocabDays) for (const w of d.words) ids.push(w.id);
  for (const t of f.listening.tips) ids.push(t.id);
  for (const it of f.listening.items) ids.push(it.id);
  for (const m of f.mocks)
    for (const s of m.sections) {
      for (const p of s.passages ?? []) ids.push(p.id);
      for (const it of s.items) ids.push(it.id);
    }
  return ids;
}

export const jaDailyImportFileSchema = z
  .object({
    format: z.literal(JA_DAILY_IMPORT_FORMAT),
    presetKey: ID,
    lessons: z.array(lessonSchema).max(L.lessons),
    vocabDays: z.array(vocabDaySchema).max(L.vocabDays),
    listening: z.object({ tips: z.array(tipSchema).max(L.tips), items: z.array(listeningItemSchema).max(L.litems) }).strict(),
    mocks: z.array(mockSchema).max(L.mocks),
  })
  .strict()
  .superRefine((f, ctx) => {
    const ids = jaDailyAllIds(f as JaDailyImportFile);
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const id of ids) (seen.has(id) ? dups : seen).add(id);
    if (dups.size > 0) ctx.addIssue({ code: "custom", path: [], message: `id가 파일 안에서 겹쳐요: ${[...dups].slice(0, 5).join(", ")}` });
    const uniq = <T>(xs: T[]) => new Set(xs).size === xs.length;
    if (!uniq(f.lessons.map((l) => `${l.step}-${l.lesson}`))) ctx.addIssue({ code: "custom", path: ["lessons"], message: "같은 step·과 번호가 겹쳐요" });
    if (!uniq(f.vocabDays.map((d) => d.day))) ctx.addIssue({ code: "custom", path: ["vocabDays"], message: "DAY 번호가 겹쳐요" });
    if (!uniq(f.mocks.map((m) => m.round))) ctx.addIssue({ code: "custom", path: ["mocks"], message: "모의 회차가 겹쳐요" });
    const total = f.lessons.length + f.vocabDays.length + f.listening.tips.length + f.listening.items.length + f.mocks.length;
    if (total === 0) ctx.addIssue({ code: "custom", path: [], message: "가져올 내용이 하나도 없어요" });
  }) as unknown as z.ZodType<JaDailyImportFile>;

// ---------------------------------------------------------------------------
// 저장 문서로 나누기 · 해시
// ---------------------------------------------------------------------------

export type JaDailyContentData = JaDailyLesson | JaDailyVocabDay | JaDailyListeningTip | JaDailyListeningItem | JaDailyMock;

/** 파일 → 저장 단위(과 하나·날 하나·요령 하나·청해 문항 하나·모의 회차 하나). 날은 `d{day}`, 모의는 `r{round}`가 id */
export function splitJaDailyFile(f: JaDailyImportFile): { kind: JaDailyContentKind; contentId: string; data: JaDailyContentData }[] {
  return [
    ...f.lessons.map((l) => ({ kind: "lesson" as const, contentId: l.id, data: l })),
    ...f.vocabDays.map((d) => ({ kind: "vocab" as const, contentId: `d${d.day}`, data: d })),
    ...f.listening.tips.map((t) => ({ kind: "tip" as const, contentId: t.id, data: t })),
    ...f.listening.items.map((it) => ({ kind: "litem" as const, contentId: it.id, data: it })),
    ...f.mocks.map((m) => ({ kind: "mock" as const, contentId: `r${m.round}`, data: m })),
  ];
}

export function jaDailyDocId(kind: JaDailyContentKind, contentId: string): string {
  return `${kind}:${contentId}`;
}

/** 결정적 내용 해시(FNV-1a 32bit ×2) — 엄마 momBlockHash와 같은 방식. 브라우저·서버 공용이라 crypto를 쓰지 않는다 */
export function jaDailyHash(data: unknown): string {
  const s = JSON.stringify(data);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

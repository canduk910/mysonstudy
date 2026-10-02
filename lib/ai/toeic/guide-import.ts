/**
 * lib/ai/toeic/guide-import.ts — 유형별 공략 **가져오기 계획·다시 가져오기 판정** (docs/harness/toeic.md §12-2-5·§12-3)
 *
 * - `planToeicGuideImport(file)` — zod를 통과한 가져오기 파일 → 쓸 문서 초안(유형 공략 문서 id `guide-{part}`, 틀 은행 `guide-templates`)과
 *   내용 지문 `contentHash`(SHA-256, 16진). 지문은 **zod 출력**의 JSON.stringify라 키 순서가 스키마 순서로 고정된다 — 파일의 키 순서만
 *   다른 두 파일은 같은 지문이다. 틀 은행의 alignmentSkips는 그대로 넣지 않는다 — `coveredBy`가 있는 것(같은 자리 다른 표현)만 이유 글을
 *   빼고 문서 `alternates`와 지문에 넣는다(§12-13-1 — 2026-10-02. 배포 뒤 같은 파일을 다시 넣으면 틀 은행이 한 번 updated).
 * - `decideGuideUpsert(items, existing, nowIso)` — 저장소 상태 → created / updated / unchanged / 충돌(preset_key_is_book·part_mismatch·
 *   part_taken). **충돌이 하나라도 있으면 파일 전체를 쓰지 않는다**(409). 스토어(upsertToeicGuides)가 원자 단위(파일 mutate /
 *   Firestore runTransaction) **안에서, 모두 읽은 뒤** 부른다 — 파일에 든 유형들의 `guide-{part}`·`guide-templates` 문서(id로)와
 *   presetKey가 같은 문서들(30개씩 `in`)을 existing으로 넘긴다.
 *
 * 서버 전용(node:crypto). 순수 판정은 I/O 없이 결정적이다 — eval이 가짜 저장소 상태로 표 여섯 갈래를 잠근다.
 */

import { createHash } from "node:crypto";
import type { ToeicSetRecord } from "../../store";
import {
  TOEIC_TEMPLATE_BANK_ID,
  TOEIC_TEMPLATE_BANK_SLOT,
  TOEIC_TEMPLATE_BANK_TITLE_KO,
  TOEIC_GUIDE_PART_TO_MOCK_PART,
  toeicGuideSetId,
} from "../../toeic-guide";
import { toeicMockPartLabelKo } from "../../toeic-mock-contract";
import { isToeicSetEnriched } from "./points";
import {
  toeicGuideEntryContent,
  toeicTemplateAlternatesFromSkips,
  toeicTemplateBankContent,
  type ToeicBookQuiz,
  type ToeicExprEntry,
  type ToeicGuideFile,
  type ToeicGuideFileEntry,
  type ToeicGuidePartDoc,
  type ToeicGuideSlot,
  type ToeicTemplateBankDoc,
  type ToeicTemplateBankFile,
} from "./schemas";
import type { ToeicGuideConflict, ToeicGuideConflictReason } from "../../toeic-guide-contract";

export type { ToeicGuideConflict, ToeicGuideConflictReason };

/** 다시 가져오기에서 updated가 쓰는 필드(Firestore 부분 갱신용) — 파생값 enriched를 함께 쓴다(§12-2-5) */
export const TOEIC_GUIDE_UPDATE_FIELDS = ["titleKo", "entries", "quiz", "guide", "enriched"] as const;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 유형 공략 내용 지문 — part·introKo·sections·expressions·speak(zod 출력 — 키 순서 고정)의 SHA-256 */
export function toeicGuideContentHash(entry: ToeicGuideFileEntry): string {
  return sha256Hex(JSON.stringify(toeicGuideEntryContent(entry)));
}

/**
 * 틀 은행 내용 지문 — flows·items·alternates(alignmentSkips 중 coveredBy가 있는 것, 이유 글 없음)의 SHA-256(§12-2-5 — 2026-10-02).
 * 건너뜀 이유만 고친 파일은 unchanged다.
 */
export function toeicTemplateBankContentHash(bank: Pick<ToeicTemplateBankFile, "flows" | "items" | "alignmentSkips">): string {
  return sha256Hex(JSON.stringify(toeicTemplateBankContent(bank)));
}

/** 쓸 문서 초안 하나 — guide.updatedAt은 판정 때 채운다 */
export interface ToeicGuideImportItem {
  presetKey: string;
  slot: ToeicGuideSlot;
  /** 결정적 문서 id — guide-{part} / guide-templates */
  docId: string;
  contentHash: string;
  titleKo: string;
  guide: Omit<ToeicGuidePartDoc, "updatedAt"> | Omit<ToeicTemplateBankDoc, "updatedAt">;
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
}

/**
 * 가져오기 계획(§12-3) — 유형 항목마다 공략 세트 하나(entries = 파일 expressions — points null·confidence high·partial false,
 * quiz = 파일 speak — keyExpressions [], titleKo = 유형 긴 이름), 그다음(templates가 있으면) 틀 은행 하나(entries·quiz 빈 배열,
 * titleKo "템플릿 훈련"). 순서는 파일 순서(유형 항목들 → 틀 은행) — 응답 배열 순서가 된다.
 */
export function planToeicGuideImport(file: ToeicGuideFile): ToeicGuideImportItem[] {
  const out: ToeicGuideImportItem[] = file.guides.map((g) => {
    const contentHash = toeicGuideContentHash(g);
    return {
      presetKey: g.presetKey,
      slot: g.part,
      docId: toeicGuideSetId(g.part),
      contentHash,
      titleKo: toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[g.part]),
      guide: { kind: "part", part: g.part, introKo: g.introKo, sections: g.sections, contentHash },
      entries: g.expressions.map((e) => ({
        no: e.no,
        expression: e.expression,
        meaningKo: e.meaningKo,
        example: e.example,
        exampleKo: e.exampleKo,
        points: null,
        confidence: "high",
        partial: false,
      })),
      quiz: g.speak.map((q) => ({ no: q.no, promptKo: q.promptKo, hint: q.hint, modelAnswer: q.modelAnswer, keyExpressions: [] })),
    };
  });
  if (file.templates !== null) {
    const bank = file.templates;
    const contentHash = toeicTemplateBankContentHash(bank);
    out.push({
      presetKey: bank.presetKey,
      slot: TOEIC_TEMPLATE_BANK_SLOT,
      docId: TOEIC_TEMPLATE_BANK_ID,
      contentHash,
      titleKo: TOEIC_TEMPLATE_BANK_TITLE_KO,
      guide: { kind: "templates", flows: bank.flows, items: bank.items, alternates: toeicTemplateAlternatesFromSkips(bank.alignmentSkips), contentHash },
      entries: [],
      quiz: [],
    });
  }
  return out;
}

/** 저장된 문서의 "유형 자리" — 표현집이면 null, 틀 은행이면 "templates", 유형 공략이면 part(깨진 값이면 그 값 그대로) */
export function toeicGuideSlotOf(record: Pick<ToeicSetRecord, "guide">): string | null {
  const g = record.guide as unknown;
  if (g === null || g === undefined || typeof g !== "object") return g === null || g === undefined ? null : "";
  const o = g as { kind?: unknown; part?: unknown };
  if (o.kind === "templates") return TOEIC_TEMPLATE_BANK_SLOT;
  return typeof o.part === "string" ? o.part : "";
}

export type ToeicGuideUpsertOutcome = "created" | "updated" | "unchanged";

export interface ToeicGuideUpsertResult {
  presetKey: string;
  slot: ToeicGuideSlot;
  outcome: ToeicGuideUpsertOutcome;
  /** 문서 id(결정적) */
  id: string;
}

export interface ToeicGuideUpsertWrite {
  outcome: "created" | "updated";
  /** 쓸 레코드 전체 — created는 tx.create, updated는 TOEIC_GUIDE_UPDATE_FIELDS만 부분 갱신해도 된다 */
  record: ToeicSetRecord;
}

export type ToeicGuideUpsertDecision =
  | { ok: true; results: ToeicGuideUpsertResult[]; writes: ToeicGuideUpsertWrite[] }
  | { ok: false; conflicts: ToeicGuideConflict[] };

/**
 * 다시 가져오기 판정(§12-2-5 표 — 틀 은행도 "유형 자리 하나"로 같은 표). `existing`은 원자 단위 안에서 읽은 문서들(id로 읽은 결정적
 * id 문서 + presetKey로 읽은 문서들 — 겹쳐도 된다). 판정 순서:
 * 1. 같은 presetKey 문서가 **표현집**(guide null) → preset_key_is_book
 * 2. 같은 presetKey의 공략 문서가 **다른 자리** → part_mismatch
 * 3. 결정적 id 문서가 있는데 presetKey가 다르다(다른 키가 그 자리를 가졌다 — 표현집이 그 id를 쓴 경우 포함) → part_taken
 * 4. 결정적 id 문서가 같은 presetKey → 지문이 같으면 unchanged(쓰지 않는다), 다르면 updated(guide·entries·quiz·titleKo·enriched,
 *    id·createdAt·sortIndex·presetKey는 그대로, 시험 기록은 건드리지 않는다)
 * 5. 없음 → created(id = 결정적 id, sortIndex null, enriched 파생값 — 공략·틀 은행 모두 false)
 * 충돌이 하나라도 있으면 writes 없이 conflicts만(파일 전체를 쓰지 않는다).
 */
export function decideGuideUpsert(items: readonly ToeicGuideImportItem[], existing: readonly ToeicSetRecord[], nowIso: string): ToeicGuideUpsertDecision {
  const byId = new Map<string, ToeicSetRecord>();
  for (const r of existing) if (!byId.has(r.id)) byId.set(r.id, r);
  const conflicts: ToeicGuideConflict[] = [];
  const results: ToeicGuideUpsertResult[] = [];
  const writes: ToeicGuideUpsertWrite[] = [];
  const conflict = (it: ToeicGuideImportItem, reason: ToeicGuideConflictReason) => conflicts.push({ presetKey: it.presetKey, part: it.slot, reason });

  for (const it of items) {
    const sameKey = existing.filter((r) => r.presetKey === it.presetKey);
    if (sameKey.some((r) => toeicGuideSlotOf(r) === null)) {
      conflict(it, "preset_key_is_book");
      continue;
    }
    if (sameKey.some((r) => toeicGuideSlotOf(r) !== it.slot || r.id !== it.docId)) {
      conflict(it, "part_mismatch");
      continue;
    }
    const atId = byId.get(it.docId) ?? null;
    if (atId !== null && atId.presetKey !== it.presetKey) {
      conflict(it, "part_taken");
      continue;
    }
    const guide = { ...it.guide, updatedAt: nowIso } as ToeicSetRecord["guide"];
    const enriched = it.entries.length > 0 && isToeicSetEnriched(it.entries);
    if (atId !== null) {
      const currentHash = (atId.guide as { contentHash?: unknown } | null)?.contentHash;
      if (currentHash === it.contentHash && toeicGuideSlotOf(atId) === it.slot) {
        results.push({ presetKey: it.presetKey, slot: it.slot, outcome: "unchanged", id: atId.id });
        continue;
      }
      const record: ToeicSetRecord = { ...atId, titleKo: it.titleKo, entries: it.entries, quiz: it.quiz, guide, enriched };
      results.push({ presetKey: it.presetKey, slot: it.slot, outcome: "updated", id: atId.id });
      writes.push({ outcome: "updated", record });
      continue;
    }
    const record: ToeicSetRecord = {
      id: it.docId,
      titleKo: it.titleKo,
      dayNo: null,
      topicKo: null,
      source: "import",
      presetKey: it.presetKey,
      entries: it.entries,
      quiz: it.quiz,
      photoCount: 0,
      enriched,
      model: null,
      createdAt: nowIso,
      sortIndex: null,
      guide,
    };
    results.push({ presetKey: it.presetKey, slot: it.slot, outcome: "created", id: it.docId });
    writes.push({ outcome: "created", record });
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, results, writes };
}

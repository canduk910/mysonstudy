/**
 * lib/ai/english/vocabbook-merge.ts — 여러 사진의 판독 결과를 한 DAY로 병합 (docs/harness/english.md §7-5)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 부수효과·import를 최소로 둔다 (타입만 import).
 * 값을 만드는 것은 여기뿐이고, 다른 곳은 결과를 소비만 한다 — 병합 규칙이 두 곳에 살면 어긋난다.
 *
 * 왜 병합이 필요한가: DAY 하나가 사진 2~4장에 걸쳐 있고, 부모가 겹쳐 찍는다(같은 단어가 두 사진에
 * 모두 잡힘). 그대로 이으면 중복이 남고, 한 사진에서 잘린 항목(partial)이 다른 사진의 완전본과
 * 따로 논다. 번호(no)로 같은 단어를 알아보고 합쳐, 표에 각 단어가 한 번만·완전한 모습으로 뜨게 한다.
 */

import type {
  VocabConfidence,
  VocabEntry,
  VocabExample,
  VocabExtractEntry,
  VocabMeaning,
  VocabRelated,
} from "./vocabbook-schemas";

/** 번호 수열의 구멍을 훑을 최대 폭 — 이보다 넓게 벌어지면(오독 등) 열거하지 않는다 */
export const VOCAB_MISSING_SCAN_MAX = 200;

/** 병합에 넣을 사진 1장의 판독 결과 — 앱이 사진 인덱스(0부터)를 붙여 넘긴다 */
export interface VocabPageForMerge {
  /** 이 판독이 나온 사진의 인덱스 (0부터) */
  photoIndex: number;
  entries: readonly VocabExtractEntry[];
}

export interface VocabMergeResult {
  /** 번호 오름차순으로 정렬된 병합 결과 */
  entries: VocabEntry[];
  /** 겹쳐 찍기로 합쳐진(접힌) 항목 수 = 입력 항목 수 − 출력 항목 수 */
  mergedCount: number;
  /** 번호 수열의 구멍 (사진 한 장 통째 누락 신호) */
  missingNos: string[];
}

const CONFIDENCE_RANK: Record<VocabConfidence, number> = { high: 2, medium: 1, low: 0 };

/** 조인 키 — 번호가 있으면 번호, 없으면 표제어 소문자. */
function joinKey(entry: Pick<VocabExtractEntry, "no" | "word">): string {
  const no = entry.no?.trim();
  if (no) return `no:${no}`;
  return `word:${entry.word.trim().toLowerCase()}`;
}

/** 문자열 배열 합집합 — 앞선 것의 순서를 지키고, trim 기준으로 중복만 뺀다 */
function unionStrings(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list) {
      const key = raw.trim();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
  }
  return out;
}

/** 예문 합집합 — 영어 문장(소문자·trim) 기준 중복 제거 */
function unionExamples(lists: readonly (readonly VocabExample[])[]): VocabExample[] {
  const out: VocabExample[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const ex of list) {
      const key = ex.en.trim().toLowerCase();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(ex);
    }
  }
  return out;
}

/** 관련어 합집합 — 종류+단어(소문자) 기준 중복 제거 */
function unionRelated(lists: readonly (readonly VocabRelated[])[]): VocabRelated[] {
  const out: VocabRelated[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const rel of list) {
      const key = `${rel.kind}:${rel.word.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rel);
    }
  }
  return out;
}

/**
 * 뜻 합집합 (§7-5) — 뜻 번호(no)가 있으면 번호, 없으면 ko 소문자를 조인 키로 같은 뜻을 묶는다.
 * 같은 뜻으로 묶이면 그 뜻에 붙은 related(유의어·반의어)도 합집합으로 접는다 — 그래야 겹쳐 찍기가
 * "뜻 1의 유의어 repair"를 잃지 않는다. 등장 순서를 지켜 표의 뜻 순서가 안정적이게 한다.
 * ko는 멤버 중 가장 긴 것(= 잘리지 않고 온전히 읽힌 쪽)을 대표로 쓴다.
 */
function unionMeanings(lists: readonly (readonly VocabMeaning[])[]): VocabMeaning[] {
  const order: string[] = [];
  const groups = new Map<string, VocabMeaning[]>();
  for (const list of lists) {
    for (const m of list) {
      const key = m.no !== null ? `no:${m.no}` : `ko:${m.ko.trim().toLowerCase()}`;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(m);
      } else {
        groups.set(key, [m]);
        order.push(key);
      }
    }
  }
  return order.map((key) => {
    const members = groups.get(key)!;
    // no: 첫 non-null(한쪽만 번호를 읽었을 수 있다). ko: 가장 긴 것. related: 멤버 합집합.
    const no = members.map((m) => m.no).find((v) => v !== null) ?? null;
    const ko = members.reduce((best, m) => (m.ko.trim().length > best.trim().length ? m.ko : best), members[0].ko);
    const related = unionRelated(members.map((m) => m.related));
    return { no, ko, related };
  });
}

/**
 * 같은 단어의 판독본 여러 개를 하나로 합친다.
 * - 배열(pos·meanings·examples·related)은 합집합. meanings는 뜻 번호 기준으로 묶고 그 뜻의 related도 합친다.
 * - 스칼라(word·ipa·no)는 '내용이 더 많은 쪽'. 대표본(primary)을 하나 골라 그 값을 기준으로 쓴다.
 * - partial은 완전본(partial=false)이 하나라도 있으면 해제.
 * - confidence는 가장 높은 것(선명하게 읽힌 쪽).
 * - photoIndex는 대표본의 사진.
 * - (B) AI 창작 필드는 non-null이 있으면 살린다 (V1에서는 전부 null이라 사실상 null).
 */
function mergeGroup(members: readonly WithPhoto[]): VocabEntry {
  // 대표본: 완전본 우선 → 내용(뜻+예문+관련어) 많은 순 → 사진 인덱스 낮은 순.
  const primary = members
    .slice()
    .sort((a, b) => {
      if (a.entry.partial !== b.entry.partial) return a.entry.partial ? 1 : -1;
      const richA = a.entry.meanings.length + a.entry.examples.length + a.entry.related.length;
      const richB = b.entry.meanings.length + b.entry.examples.length + b.entry.related.length;
      if (richA !== richB) return richB - richA;
      return a.photoIndex - b.photoIndex;
    })[0];

  const bestConfidence = members.reduce<VocabConfidence>(
    (best, m) => (CONFIDENCE_RANK[m.entry.confidence] > CONFIDENCE_RANK[best] ? m.entry.confidence : best),
    "low",
  );

  // 번호: 대표본에 있으면 그것, 없으면 아무 멤버의 번호라도 살린다 (한쪽만 번호를 읽었을 수 있다)
  const no = primary.entry.no ?? members.map((m) => m.entry.no).find((v) => v !== null) ?? null;
  // 발음기호: 대표본에 있으면 그것, 없으면 다른 멤버 것
  const ipa = primary.entry.ipa ?? members.map((m) => m.entry.ipa).find((v) => v !== null) ?? null;

  return {
    // (A)
    no,
    word: primary.entry.word,
    ipa,
    pos: unionStrings(members.map((m) => m.entry.pos)) as VocabEntry["pos"],
    meanings: unionMeanings(members.map((m) => m.entry.meanings)),
    examples: unionExamples(members.map((m) => m.entry.examples)),
    related: unionRelated(members.map((m) => m.entry.related)),
    // (B) AI 창작 — 판독(호출 C) 입력엔 없다. V1에서는 전부 null로 열어 두고 V3(호출 D)가 채운다.
    definitionEn: null,
    definitionKo: null,
    imageEmoji: null,
    imageSvg: null,
    // (C)
    photoIndex: primary.photoIndex,
    confidence: bestConfidence,
    partial: members.every((m) => m.entry.partial),
  };
}

interface WithPhoto {
  photoIndex: number;
  entry: VocabExtractEntry;
}

/** 번호를 정수로 (정렬·구멍 탐지용). 숫자가 아니면 null. */
function parseNo(no: string | null): number | null {
  if (no === null) return null;
  const trimmed = no.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * 여러 사진의 판독을 한 DAY로 병합한다 (§7-5).
 * 조인 키는 번호(no), 없으면 표제어 소문자. 겹쳐 찍기를 정상 처리하고 번호 오름차순으로 정렬한다.
 */
export function mergeVocabPages(pages: readonly VocabPageForMerge[]): VocabMergeResult {
  const all: WithPhoto[] = [];
  for (const page of pages) {
    for (const entry of page.entries) {
      all.push({ photoIndex: page.photoIndex, entry });
    }
  }

  // 조인 키로 묶는다. 등장 순서를 지켜 그룹 순서가 안정적이게 한다.
  const groups = new Map<string, WithPhoto[]>();
  for (const item of all) {
    const key = joinKey(item.entry);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const merged: VocabEntry[] = [];
  for (const members of groups.values()) {
    merged.push(mergeGroup(members));
  }

  // 번호 오름차순 정렬 — 숫자 번호가 있는 것 먼저(번호 순), 없는 것은 뒤에(표제어 순).
  merged.sort((a, b) => {
    const na = parseNo(a.no);
    const nb = parseNo(b.no);
    if (na !== null && nb !== null) return na - nb || a.word.localeCompare(b.word);
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.word.localeCompare(b.word);
  });

  return {
    entries: merged,
    mergedCount: all.length - merged.length,
    missingNos: findMissingNumbers(merged),
  };
}

/**
 * 번호 수열의 구멍을 찾는다 (§7-5). 관측된 번호 중 최소~최대 사이에서 빠진 번호를,
 * 관측된 번호의 최대 자릿수에 맞춰 0으로 채워 돌려준다 (예: "0011").
 *
 * 사진 한 장이 통째로 빠지면 연속된 번호 구간이 비어 여기서 잡힌다. 벌어짐이 비정상적으로
 * 넓으면(VOCAB_MISSING_SCAN_MAX 초과) 오독으로 보고 열거하지 않는다 — 표 밑에 헛경고를 쏟지 않으려는 것.
 */
export function findMissingNumbers(entries: readonly { no: string | null }[]): string[] {
  const present: number[] = [];
  let width = 0;
  for (const e of entries) {
    const n = parseNo(e.no);
    if (n === null) continue;
    present.push(n);
    width = Math.max(width, (e.no as string).trim().length);
  }
  if (present.length < 2) return [];

  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max - min > VOCAB_MISSING_SCAN_MAX) return [];

  const have = new Set(present);
  const missing: string[] = [];
  for (let n = min + 1; n < max; n++) {
    if (!have.has(n)) missing.push(String(n).padStart(width, "0"));
  }
  return missing;
}

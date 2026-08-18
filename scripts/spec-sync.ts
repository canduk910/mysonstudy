/**
 * scripts/spec-sync.ts — 프롬프트 원문 ↔ 스펙 문서 자동 대조 (과목 공통 · 실호출 0회)
 *
 * 이 저장소는 "스펙이 단일 진실 원천"으로 돌아간다. 그런데 `docs/harness/*.md`의 프롬프트 원문과
 * `lib/ai/{english,math}/prompts.ts`의 실제 문자열이 같은지 **확인하는 코드가 없었다.** 일치의 근거는 사람이
 * 그때그때 돌린 diff뿐이었고, 한 번만 빠뜨려도 스펙과 프롬프트가 조용히 갈라진다.
 * (eval의 O4·O6이 재는 것은 프롬프트↔`schemas.ts` **다이얼 상수**이지 스펙 문서가 아니다.)
 *
 * 핵심 판정: **각 시스템 프롬프트 문자열이 해당 스펙 문서 안에 원문 그대로 존재하는가.**
 *
 * 설계 원칙 — 매핑을 위치로 못 박지 않는다.
 *   "이 프롬프트는 스펙의 N번째 코드블록"이라고 적으면 절이 하나 늘 때마다 깨진다. 그래서 스펙에서
 *   ``` 코드블록을 **전부** 뽑아 두고 "이 프롬프트와 정확히 같은 블록이 하나라도 있는가"만 묻는다.
 *   블록의 절 번호·제목은 **사람에게 보여줄 라벨로만** 쓰고, 판정에는 일절 쓰지 않는다.
 *
 * 조립(assembly) — 스펙이 한 프롬프트를 여러 절에 나눠 적는 경우가 있다.
 *   예: 호출 B 프롬프트는 §3-1 블록의 `[3막 구조]` 뒤에 §10-6 블록을 끼워 넣은 것이다.
 *   그래서 "프롬프트에 통째로 박혀 있는 다른 스펙 블록"을 먼저 떼어 낸 뒤(줄 단위·정확 일치),
 *   남은 것이 어떤 블록과 같은지를 묻는다. 이때도 어느 절인지는 **내용으로** 찾는다.
 *   떼어 낸 조각은 리포트에 전부 이름으로 남으므로, 조립 결과를 사람이 눈으로 감사할 수 있다.
 *
 * 어긋났을 때 쓸모 있어야 한다 — "다르다"만 찍으면 사람이 다시 diff를 돌려야 한다. 그래서
 *   (1) 전체가 가장 비슷한 블록과 (2) 첫 줄이 프롬프트 안에서 발견되는 '부분 절' 후보를 각각 골라,
 *   **첫 불일치 줄 번호(프롬프트 쪽·스펙 파일 쪽 양쪽)와 양쪽 줄 내용**을 찍는다.
 *   그래야 "절을 통째로 못 찾음"과 "한 줄만 어긋남"이 구분된다.
 *
 * 정규화 범위(딱 이만큼이다 — 더 늘리면 진짜 차이를 놓친다):
 *   - 유니코드 NFC (조합형/완성형 한글 차이는 모델에게 같은 글자다)
 *   - CRLF·CR → LF
 *   - 각 줄의 **끝** 공백·탭 제거
 *   - 문자열 맨 앞·맨 뒤의 빈 줄 제거
 *   정규화하지 **않는** 것: 줄 안쪽 공백, 들여쓰기, 빈 줄의 개수와 위치, 대소문자, 문장부호.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

/** 대조 전 정규화 — 위 주석의 4가지만 한다 */
export function normalizeForCompare(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// 스펙 코드블록 추출
// ---------------------------------------------------------------------------

export interface SpecBlock {
  /** 리포트용 파일 이름 (예: "math.md") */
  file: string;
  /** 여는 ``` 줄 (1-based) */
  fenceLine: number;
  /** 블록 본문 첫 줄의 파일 내 줄 번호 (1-based) */
  bodyLine: number;
  /** 블록 직전의 마크다운 제목 — **보고용 라벨일 뿐 판정에 쓰지 않는다** */
  heading: string;
  /** 펜스 언어 태그 ("" | "json" | "ts" …) */
  lang: string;
  /** 정규화된 본문 */
  text: string;
  /** 정규화된 본문의 줄 배열 */
  lines: string[];
}

/** `docs/harness/*.md`에서 ``` 코드블록을 전부 뽑는다. 절 번호로 고르지 않는다 — 전부 후보다. */
export function extractSpecBlocks(specUrl: URL): SpecBlock[] {
  const file = specUrl.pathname.split("/").pop() ?? specUrl.pathname;
  const raw = readFileSync(specUrl, "utf-8").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  const blocks: SpecBlock[] = [];
  let heading = "(문서 머리)";
  let open: { lang: string; fenceLine: number; heading: string; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open === null) {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        heading = h[1].trim();
        continue;
      }
    }
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      if (open === null) {
        open = { lang: fence[1].trim(), fenceLine: i + 1, heading, body: [] };
      } else {
        const text = normalizeForCompare(open.body.join("\n"));
        blocks.push({
          file,
          fenceLine: open.fenceLine,
          bodyLine: open.fenceLine + 1,
          heading: open.heading,
          lang: open.lang,
          text,
          lines: text.split("\n"),
        });
        open = null;
      }
      continue;
    }
    if (open) open.body.push(line);
  }

  if (open !== null) {
    // 닫히지 않은 펜스는 스펙 문서 쪽 오류다. 조용히 넘기면 대조가 반쪽이 되므로 던진다
    // (호출부가 잡아서 FAIL로 만든다 — SKIP으로 삼키지 않는다).
    throw new Error(`${file}:${open.fenceLine} 코드블록이 닫히지 않았습니다`);
  }
  return blocks;
}

/** 사람이 읽을 블록 이름 — 절 제목 앞부분 + 파일:줄 */
function blockLabel(block: SpecBlock): string {
  const head = block.heading.length > 34 ? `${block.heading.slice(0, 33)}…` : block.heading;
  return `"${head}" (${block.file}:${block.fenceLine})`;
}

// ---------------------------------------------------------------------------
// 대조 대상
// ---------------------------------------------------------------------------

export type SpecSyncMode =
  /** 스펙의 ``` 코드블록과 원문이 같아야 한다 (시스템 프롬프트) */
  | "block"
  /** 스펙 본문 어딘가에 원문이 그대로 들어 있어야 한다 (인라인 코드로만 적힌 한 줄짜리) */
  | "inline";

export interface SpecSyncTarget {
  /** 상수 이름 */
  constName: string;
  /** 상수가 사는 파일 (리포트용) */
  source: string;
  /** 스펙에서 기대되는 위치 — **라벨일 뿐 판정에 쓰지 않는다** */
  specLabel: string;
  /** 실제 문자열 */
  text: string;
  mode: SpecSyncMode;
}

export interface SpecSyncOutcome {
  constName: string;
  /** 표에 넣을 한 줄 */
  summary: string;
  /** 실패했을 때 표 뒤에 찍을 여러 줄 (통과면 "") */
  detail: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// 조립 — 프롬프트에 통째로 박힌 다른 스펙 블록을 떼어 낸다
// ---------------------------------------------------------------------------

/** 떼어 낼 수 있는 최소 크기 — 짧은 블록이 우연히 박혀 잘못 떼이는 것을 막는다 */
const MIN_ADDENDUM_CHARS = 40;
const MIN_ADDENDUM_LINES = 3;
const MAX_REDUCTIONS = 8;

/** 줄 배열 + 각 줄이 원래 프롬프트의 몇 번째 줄이었는지(1-based) */
interface Residue {
  lines: string[];
  origin: number[];
}

/** blockLines가 residue 안에 연속으로 정확히 들어 있으면 시작 인덱스, 없으면 -1 */
function findRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** run과 인접한 빈 줄 1개까지 함께 들어낸다 (뒤쪽 우선 — 앞 절의 문단 구분을 남긴다) */
function cutRun(residue: Residue, start: number, length: number): Residue {
  const lines = residue.lines.slice();
  const origin = residue.origin.slice();
  lines.splice(start, length);
  origin.splice(start, length);
  if (lines[start] === "") {
    lines.splice(start, 1);
    origin.splice(start, 1);
  } else if (start > 0 && lines[start - 1] === "") {
    lines.splice(start - 1, 1);
    origin.splice(start - 1, 1);
  }
  return { lines, origin };
}

interface Reduction {
  residue: Residue;
  /** 떼어 낸 블록들 (내용으로 찾은 것이다 — 절 번호를 미리 적어 둔 것이 아니다) */
  addenda: SpecBlock[];
  /** 최종 잔여물과 정확히 같은 블록 (없으면 null) */
  base: SpecBlock | null;
}

function reduce(promptLines: readonly string[], blocks: readonly SpecBlock[]): Reduction {
  let residue: Residue = {
    lines: promptLines.slice(),
    origin: promptLines.map((_, i) => i + 1),
  };
  const addenda: SpecBlock[] = [];

  for (let round = 0; round <= MAX_REDUCTIONS; round++) {
    const joined = residue.lines.join("\n");
    const exact = blocks.find((b) => b.text === joined);
    if (exact) return { residue, addenda, base: exact };

    const candidates = blocks
      .filter(
        (b) =>
          !addenda.includes(b) &&
          b.text.length >= MIN_ADDENDUM_CHARS &&
          b.lines.length >= MIN_ADDENDUM_LINES &&
          b.lines.length < residue.lines.length,
      )
      .sort((a, b) => b.text.length - a.text.length);

    let cut = false;
    for (const cand of candidates) {
      const at = findRun(residue.lines, cand.lines);
      if (at < 0) continue;
      residue = cutRun(residue, at, cand.lines.length);
      addenda.push(cand);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  return { residue, addenda, base: null };
}

// ---------------------------------------------------------------------------
// 불일치 진단
// ---------------------------------------------------------------------------

interface Alignment {
  block: SpecBlock;
  /** residue의 몇 번째 줄부터 블록 첫 줄을 맞췄는가 */
  offset: number;
  matched: number;
  score: number;
  /** 블록 기준 첫 불일치 인덱스 (없으면 null) */
  firstDiff: number | null;
}

function align(residue: Residue, block: SpecBlock, offset: number, denom: number): Alignment {
  let matched = 0;
  let firstDiff: number | null = null;
  const span = Math.max(residue.lines.length - offset, block.lines.length);
  for (let i = 0; i < span; i++) {
    const a = residue.lines[offset + i];
    const b = block.lines[i];
    if (a !== undefined && b !== undefined && a === b) matched++;
    else if (firstDiff === null) firstDiff = i;
  }
  return { block, offset, matched, score: denom === 0 ? 0 : matched / denom, firstDiff };
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function show(line: string | undefined): string {
  if (line === undefined) return "(줄 없음 — 길이가 다름)";
  return JSON.stringify(line);
}

/**
 * 첫 불일치를 사람이 바로 열어볼 수 있는 형태로 적는다.
 * **"프롬프트 N행"은 상수 문자열 안에서 센 줄 번호**다(파일 줄 번호가 아니다).
 */
function describe(residue: Residue, a: Alignment, kind: string): string[] {
  const out: string[] = [];
  out.push(
    `    ${kind}: ${blockLabel(a.block)} · 유사도 ${pct(a.score)}` +
      (a.offset > 0 ? ` · 프롬프트(상수 안) ${residue.origin[a.offset] ?? "?"}행에서 맞춤` : ""),
  );
  if (a.firstDiff === null) {
    out.push("      (이 정렬에서는 불일치 줄이 없다 — 길이만 다르다)");
    return out;
  }
  const promptIdx = a.offset + a.firstDiff;
  const promptLineNo = residue.origin[promptIdx];
  const specLineNo = a.block.bodyLine + a.firstDiff;
  out.push(
    `      첫 불일치 — 프롬프트(상수 안) ${promptLineNo ?? "(끝을 넘어섬)"}행 ↔ 스펙 ${a.block.file}:${specLineNo}`,
  );
  out.push(`        프롬프트: ${show(residue.lines[promptIdx])}`);
  out.push(`        스펙    : ${show(a.block.lines[a.firstDiff])}`);
  out.push(
    `      줄 수 — 프롬프트(잔여) ${residue.lines.length} · 스펙 블록 ${a.block.lines.length}`,
  );
  return out;
}

function diagnose(target: SpecSyncTarget, reduction: Reduction, blocks: readonly SpecBlock[]): string {
  const { residue, addenda } = reduction;
  const out: string[] = [];
  out.push(`  [FAIL] ${target.constName} (${target.source}) ↔ ${target.specLabel}`);
  if (addenda.length > 0) {
    out.push(
      `    프롬프트에 통째로 박힌 스펙 블록을 먼저 떼어 냈다: ${addenda.map(blockLabel).join(", ")}`,
    );
    out.push("    (아래 줄 번호는 프롬프트 원본 기준이다 — 떼어 낸 뒤에도 원래 행을 가리킨다.)");
  }

  // (1) 전체가 가장 비슷한 블록 — "절을 통째로 못 찾음"인지 가른다
  let whole: Alignment | null = null;
  for (const b of blocks) {
    const a = align(residue, b, 0, Math.max(residue.lines.length, b.lines.length));
    if (!whole || a.score > whole.score) whole = a;
  }

  // (2) 첫 줄이 프롬프트 안에 있는 '부분 절' 후보 — "한 줄만 어긋남"을 집어낸다
  let region: Alignment | null = null;
  for (const b of blocks) {
    if (b.lines.length < MIN_ADDENDUM_LINES) continue;
    const at = residue.lines.indexOf(b.lines[0]);
    if (at < 0) continue;
    const a = align(residue, b, at, b.lines.length);
    if (!region || a.score > region.score) region = a;
  }

  if (!whole) {
    out.push("    스펙에서 코드블록을 하나도 찾지 못했다 — 스펙 파일이 비었거나 형식이 깨졌다.");
    return out.join("\n");
  }
  out.push(...describe(residue, whole, "가장 비슷한 블록"));
  if (region && region.score > whole.score && region.block !== whole.block) {
    out.push(...describe(residue, region, "부분 절 후보"));
  }
  if (whole.score < 0.4 && (!region || region.score < 0.6)) {
    out.push(
      "    → 정확히 같은 블록이 스펙에 없다. 첫 불일치 줄부터가 스펙에 없는 내용이거나" +
        "(절이 통째로 빠졌다), 스펙 파일을 잘못 짚었다.",
    );
  } else {
    out.push("    → 절은 찾았고 내용이 어긋난다. 위 첫 불일치 줄부터 맞춰라.");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

/**
 * 프롬프트 상수들을 스펙 문서와 대조한다.
 *
 * 스펙 파일을 못 읽거나(없음·깨짐) 대응 블록을 못 찾으면 **FAIL**이다. SKIP으로 삼키지 않는다 —
 * 대조가 조용히 꺼지면 이 점검을 만든 의미가 없다.
 */
export function checkSpecSync(
  specUrl: URL,
  targets: readonly SpecSyncTarget[],
): SpecSyncOutcome[] {
  let blocks: SpecBlock[];
  let specText: string;
  try {
    blocks = extractSpecBlocks(specUrl);
    specText = normalizeForCompare(readFileSync(specUrl, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return targets.map((t) => ({
      constName: t.constName,
      ok: false,
      summary: `스펙 문서를 읽지 못함 — ${message}`,
      detail: `  [FAIL] ${t.constName} (${t.source}) — 스펙(${specUrl.pathname})을 읽지 못했다: ${message}`,
    }));
  }

  if (blocks.length === 0) {
    return targets.map((t) => ({
      constName: t.constName,
      ok: false,
      summary: "스펙에 코드블록이 하나도 없음",
      detail: `  [FAIL] ${t.constName} (${t.source}) — ${specUrl.pathname}에서 코드펜스 블록을 찾지 못했다.`,
    }));
  }

  return targets.map((target) => {
    const text = normalizeForCompare(target.text);

    if (target.mode === "inline") {
      const found = specText.includes(text);
      return {
        constName: target.constName,
        ok: found,
        summary: found
          ? `원문 포함 · ${target.specLabel} (${blocks[0].file})`
          : `스펙 본문에서 찾지 못함 · ${target.specLabel}`,
        detail: found
          ? ""
          : [
              `  [FAIL] ${target.constName} (${target.source}) ↔ ${target.specLabel}`,
              `    이 문자열이 ${blocks[0].file} 어디에도 없다: ${JSON.stringify(text)}`,
            ].join("\n"),
      };
    }

    const reduction = reduce(text.split("\n"), blocks);
    if (reduction.base) {
      const { base, addenda } = reduction;
      const summary =
        addenda.length === 0
          ? `원문 일치 · ${blockLabel(base)}`
          : `조립 일치 · 기준 ${blockLabel(base)} + 삽입 ${addenda.map(blockLabel).join(" + ")}`;
      return { constName: target.constName, ok: true, summary, detail: "" };
    }

    return {
      constName: target.constName,
      ok: false,
      summary: `불일치 — 같은 블록이 스펙에 없음 · 기대 위치 ${target.specLabel}`,
      detail: diagnose(target, reduction, blocks),
    };
  });
}

/** 실패 상세를 표 뒤에 찍는다 (통과면 아무것도 찍지 않는다) */
export function printSpecSyncDetails(outcomes: readonly SpecSyncOutcome[]): void {
  const failed = outcomes.filter((o) => !o.ok && o.detail);
  if (failed.length === 0) return;
  console.log("");
  console.log("── 프롬프트 ↔ 스펙 대조 상세 ──────────────────────────────");
  for (const f of failed) console.log(f.detail);
  console.log("───────────────────────────────────────────────────────────");
  console.log("");
}

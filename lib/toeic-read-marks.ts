/**
 * lib/toeic-read-marks.ts — Q1–2 지문 대조 결과를 **지문 위에 표시**하기 위한 순수 함수 (docs/harness/toeic.md §5-4·§8)
 *
 * 채점 값(accuracy·빠짐·치환 목록)의 단일 정의처는 `lib/toeic-score.ts` alignReadAloud다 — 이 모듈은 점수를 내지 않는다.
 * alignReadAloud는 정규화 단어 목록만 돌려주므로 "지문의 어느 단어가 빠졌는지"를 알 수 없다. 그래서 같은 정규화
 * (normalizeReadWords)·같은 편집거리 점화식·같은 되짚기 순서(일치·치환 → 삭제 → 삽입)로 **위치까지** 다시 정렬해,
 * 결과 화면이 지문 원문 위에 빠진·바뀐 단어를 표시한다. 빠짐·치환 **개수는 alignReadAloud와 같아야 한다**(eval이 잠근다).
 *
 * 지문 단어(공백으로 나눈 조각) ↔ 정규화 단어의 대응: 조각을 하나씩 더해 가며 정규화 길이가 늘어난 만큼을 그 조각이 가진다.
 * "twenty five"처럼 두 조각이 한 정규화 단어("25")로 접히면 뒤 조각은 앞 조각의 판정을 따른다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-score)뿐. 정규식 lookbehind를 쓰지 않는다.
 */

import { normalizeReadWords } from "./toeic-score";

export type ReadMarkStatus = "ok" | "missing" | "substituted";

export interface ReadMarkSegment {
  /** 원문 조각(공백 조각 포함 — 이어 붙이면 지문 원문과 같다) */
  text: string;
  /** 공백 조각이면 true(판정 없음) */
  space: boolean;
  status: ReadMarkStatus;
  /** 치환이면 들린 말(정규화 단어, 여럿이면 공백으로) */
  heard: string | null;
}

export interface ReadMarks {
  segments: ReadMarkSegment[];
  /** 전사문에만 있는 단어(정규화) */
  extra: string[];
  missingCount: number;
  substitutedCount: number;
}

type WordStatus = { status: ReadMarkStatus; heard: string | null };

/** 정규화 단어열 a(지문)·b(전사) 정렬 — alignReadAloud와 같은 점화식·되짚기 순서. a의 위치별 판정 + 삽입 단어. */
function alignPositions(a: readonly string[], b: readonly string[]): { perA: WordStatus[]; extra: string[] } {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      d[i][j] = Math.min(sub, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const perA: WordStatus[] = a.map(() => ({ status: "ok", heard: null }));
  const extra: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      perA[i - 1] = { status: "substituted", heard: b[j - 1] };
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      perA[i - 1] = { status: "missing", heard: null };
      i -= 1;
    } else {
      extra.push(b[j - 1]);
      j -= 1;
    }
  }
  extra.reverse();
  return { perA, extra };
}

/**
 * 지문 원문을 조각으로 나눠 조각마다 판정을 붙인다. 조각을 이어 붙이면 원문과 같다(표시가 글자를 바꾸지 않는다).
 * transcript가 비면 모든 단어가 missing이다.
 */
export function markReadAloud(text: string, transcript: string): ReadMarks {
  const pieces = text.split(/(\s+)/).filter((p) => p !== "");
  const wordPieceIdx: number[] = [];
  pieces.forEach((p, k) => {
    if (!/^\s+$/.test(p)) wordPieceIdx.push(k);
  });

  // 조각 → 정규화 단어 대응(앞에서부터 더해 가며 늘어난 만큼)
  const owned: number[][] = pieces.map(() => []);
  const inheritFrom: (number | null)[] = pieces.map(() => null);
  let prevCount = 0;
  const words: string[] = [];
  for (let w = 0; w < wordPieceIdx.length; w++) {
    words.push(pieces[wordPieceIdx[w]]);
    const count = normalizeReadWords(words.join(" ")).length;
    const k = wordPieceIdx[w];
    if (count > prevCount) {
      for (let j = prevCount; j < count; j++) owned[k].push(j);
    } else if (count > 0) {
      // 앞 조각과 한 단어로 접혔다(twenty five → 25) — 그 단어를 가진 조각의 판정을 따른다
      const target = count - 1;
      const ownerPiece = owned.findIndex((list) => list.includes(target));
      inheritFrom[k] = ownerPiece >= 0 ? ownerPiece : null;
    }
    prevCount = Math.max(prevCount, count);
  }

  const a = normalizeReadWords(text);
  const b = normalizeReadWords(transcript);
  const { perA, extra } = alignPositions(a, b);

  const judge = (k: number): WordStatus => {
    const idx = owned[k];
    if (idx.length === 0) return { status: "ok", heard: null };
    const st = idx.map((j) => perA[j] ?? { status: "ok" as const, heard: null });
    if (st.some((x) => x.status === "missing")) return { status: "missing", heard: null };
    const subs = st.filter((x) => x.status === "substituted");
    if (subs.length > 0) return { status: "substituted", heard: subs.map((x) => x.heard).join(" ") };
    return { status: "ok", heard: null };
  };

  const segments: ReadMarkSegment[] = pieces.map((p, k) => {
    if (/^\s+$/.test(p)) return { text: p, space: true, status: "ok", heard: null };
    const src = inheritFrom[k];
    const j = src !== null ? judge(src) : judge(k);
    return { text: p, space: false, status: j.status, heard: j.heard };
  });

  return {
    segments,
    extra,
    missingCount: perA.filter((x) => x.status === "missing").length,
    substitutedCount: perA.filter((x) => x.status === "substituted").length,
  };
}

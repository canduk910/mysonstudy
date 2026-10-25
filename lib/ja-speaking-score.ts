/**
 * lib/ja-speaking-score.ts — 말하기 모의고사 **Q1–2 지문 대조(AI 없음)**·무응답 판정·`said` 대조 순수 함수
 * (docs/harness/japanese.md §15-5)
 *
 * ── 왜 글자 단위 + 읽기 대안인가(§15-5-1) ──────────────────────────────────────
 * 일본어는 띄어쓰기가 없어 토익의 단어 단위 대조(`alignReadAloud`)를 쓸 수 없다. 전사(관문 T-ja)는 한자·가나 섞인 표기로 오고
 * **읽기를 주지 않는다**(사전 없이 전사문을 가나로 바꿀 수 없다 — 형태소 분석기는 이 저장소에 없다). 그래서 정규화 방향을 거꾸로 잡는다:
 * 지문 쪽 토큰은 후리가나 읽기를 가지고 있으므로, 지문 토큰마다 **표기(surface)와 읽기(reading) 두 갈래**를 열어 두고
 * 전사문 글자열과 편집거리 정렬을 한다(갈래가 있는 격자와 문자열의 편집거리). 전사가 한자를 가나로 적어도(今日 ↔ きょう) 맞는다.
 * 반대 방향(지문은 가나인데 전사가 한자 — わたし ↔ 私)은 맞추지 못한다 — 그래서 호출 E1 프롬프트가 지문을 **표준 표기**(보통 한자로
 * 쓰는 말은 한자로)로 쓰게 하고, 읽기는 후리가나가 돕는다(§15-3-1). 남는 틈(숫자 표기 3 ↔ 三, 동음 다른 한자)은 알려진 한계다(§15-5-4).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0. 정규식 lookbehind를 쓰지 않는다.
 */

/** 지문 토큰 모양(후리가나 토큰과 같다) — 타입 import 없이 구조로만 받는다 */
export interface JaReadToken {
  surface: string;
  reading: string | null;
}

/** Q1–2 대조 결과 — 토익 `ToeicReadDiff`와 **같은 모양**(결과 화면 렌더를 같이 쓸 수 있게). 단위가 단어가 아니라 지문 토큰·글자다 */
export interface JaReadDiff {
  /** 1 − (빠진 글자 + 바뀐 글자) / 고른 경로의 지문 글자 수, 0..1 */
  accuracy: number;
  /** 통째로 안 들린 지문 토큰(표기) */
  missing: string[];
  /** 덧붙여 들린 전사 글자 묶음(군말 등) */
  extra: string[];
  /** 다르게 들린 지문 토큰 — expected는 토큰 표기, heard는 그 자리에 정렬된 전사 글자 */
  substituted: { expected: string; heard: string }[];
}

export const JA_SPEAKING_READ_NOTICE_KO = "발음·억양은 채점하지 않았어요 — 글자 일치율이에요. 녹음을 다시 들어 보세요";

/**
 * 대조용 글자 정규화 — NFKC(전각 숫자·반각 가나 통일) → 소문자 → 가타카나를 히라가나로 → 히라가나·ー·한자(々 포함)·숫자·라틴만 남긴다.
 * 문장부호·공백·기호는 버린다. 결과는 코드포인트 배열.
 */
export function normalizeJaReadChars(s: string): string[] {
  const out: string[] = [];
  for (const ch of s.normalize("NFKC").toLowerCase()) {
    const cp = ch.codePointAt(0) as number;
    let c = ch;
    if (cp >= 0x30a1 && cp <= 0x30f6) c = String.fromCodePoint(cp - 0x60); // カタカナ → ひらがな
    const k = c.codePointAt(0) as number;
    const keep =
      (k >= 0x3041 && k <= 0x3096) || // ひらがな
      k === 0x309d ||
      k === 0x309e || // ゝゞ
      k === 0x30fc || // ー
      k === 0x3005 || // 々
      (k >= 0x4e00 && k <= 0x9fff) || // CJK 통합 한자
      (k >= 0x3400 && k <= 0x4dbf) || // 확장 A
      (k >= 0x30 && k <= 0x39) || // 0-9
      (k >= 0x61 && k <= 0x7a); // a-z
    if (keep) out.push(c);
  }
  return out;
}

/** 참고 점수 문턱(글자 일치율) — 토익 readProxyScore와 같은 값으로 시작한다(튜닝 대상, §15-15) */
export const JA_READ_PROXY_THRESHOLDS = [0.95, 0.85, 0.6] as const;

/** 참고 점수: ≥0.95 → 3, ≥0.85 → 2, ≥0.6 → 1, 그 밖 0 */
export function jaReadProxyScore(accuracy: number): 0 | 1 | 2 | 3 {
  const [a3, a2, a1] = JA_READ_PROXY_THRESHOLDS;
  if (!Number.isFinite(accuracy)) return 0;
  if (accuracy >= a3) return 3;
  if (accuracy >= a2) return 2;
  if (accuracy >= a1) return 1;
  return 0;
}

/** 정렬에 넣는 전사 글자 상한 = max(JA_READ_ALIGN_MIN_CHARS, 지문 최장 갈래 글자 수 × 이 배수) */
export const JA_READ_ALIGN_TRANSCRIPT_FACTOR = 3;
export const JA_READ_ALIGN_MIN_CHARS = 60;

interface TokenUnit {
  surface: string;
  alts: string[][];
}

function tokenUnits(tokens: readonly JaReadToken[]): TokenUnit[] {
  const units: TokenUnit[] = [];
  for (const t of tokens) {
    const s = normalizeJaReadChars(t.surface);
    if (s.length === 0) continue; // 문장부호만인 토큰은 세지 않는다
    const alts: string[][] = [s];
    if (t.reading) {
      const r = normalizeJaReadChars(t.reading);
      if (r.length > 0 && r.join("") !== s.join("")) alts.push(r);
    }
    units.push({ surface: t.surface, alts });
  }
  return units;
}

/**
 * Q1–2 대조 — 지문 토큰(표기 | 읽기 두 갈래) 격자와 전사문 글자열의 편집거리 정렬(빠짐·덧붙음·바뀜 각 1).
 * 토큰마다 고른 갈래의 글자 수가 분모가 된다. 같은 비용이면 표기 갈래를 먼저 고른다.
 */
export function alignJaReadAloud(tokens: readonly JaReadToken[], transcript: string): JaReadDiff {
  const units = tokenUnits(tokens);
  // 격자 크기 상한(§15-5-2, QA speaking-ai 1 P3-B) — 전사 모델의 반복 환각에 대비해 정규화한 전사를 지문 최장 갈래 글자 수 × 3(최소 60자)로 자른다.
  // 잘린 꼬리는 어차피 덧붙음이라 정확도에 영향이 없다(덧붙음은 깎지 않는다).
  const passageMax = units.reduce((n, u) => n + Math.max(...u.alts.map((a) => a.length)), 0);
  const t = normalizeJaReadChars(transcript).slice(0, Math.max(JA_READ_ALIGN_MIN_CHARS, passageMax * JA_READ_ALIGN_TRANSCRIPT_FACTOR));
  const m = t.length;
  // rows[i][a][k] = 토큰 i의 갈래 a에서 k글자까지 소비했을 때의 비용 벡터(길이 m+1). k=0은 앞 경계 D_{i-1}
  const bounds: Int32Array[] = [];
  const d0 = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) d0[j] = j; // 앞에 덧붙은 글자
  bounds.push(d0);
  const rows: Int32Array[][][] = [];
  for (const u of units) {
    const prev = bounds[bounds.length - 1];
    const perAlt: Int32Array[][] = [];
    const next = new Int32Array(m + 1).fill(2 ** 30);
    for (const alt of u.alts) {
      const r: Int32Array[] = [prev];
      for (let k = 1; k <= alt.length; k++) {
        const above = r[k - 1];
        const cur = new Int32Array(m + 1);
        cur[0] = above[0] + 1;
        for (let j = 1; j <= m; j++) {
          const diag = above[j - 1] + (alt[k - 1] === t[j - 1] ? 0 : 1);
          const miss = above[j] + 1;
          const ext = cur[j - 1] + 1;
          cur[j] = Math.min(diag, miss, ext);
        }
        r.push(cur);
      }
      perAlt.push(r);
      const last = r[alt.length];
      for (let j = 0; j <= m; j++) if (last[j] < next[j]) next[j] = last[j];
    }
    rows.push(perAlt);
    bounds.push(next);
  }

  // 역추적
  const missing: string[] = [];
  const substituted: { expected: string; heard: string }[] = [];
  const extraIdx = new Set<number>();
  let errors = 0;
  let denom = 0;
  let j = m;
  const perToken: { status: "ok" | "missing" | "changed"; heard: string }[] = new Array(units.length);
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    const target = bounds[i + 1][j];
    let a = 0;
    for (let x = 0; x < u.alts.length; x++) {
      if (rows[i][x][u.alts[x].length][j] === target) {
        a = x;
        break;
      }
    }
    const alt = u.alts[a];
    const r = rows[i][a];
    denom += alt.length;
    let k = alt.length;
    const jEnd = j;
    let tokErr = 0;
    let matchedOrSub = 0;
    const tokExtra: number[] = [];
    while (k > 0) {
      const cur = r[k][j];
      if (j > 0 && alt[k - 1] === t[j - 1] && r[k - 1][j - 1] === cur) {
        k--;
        j--;
        matchedOrSub++;
      } else if (j > 0 && r[k - 1][j - 1] + 1 === cur) {
        k--;
        j--;
        tokErr++;
        matchedOrSub++;
      } else if (r[k - 1][j] + 1 === cur) {
        k--;
        tokErr++;
      } else {
        tokExtra.push(j - 1);
        j--;
      }
    }
    errors += tokErr;
    const spanChars: string[] = [];
    for (let x = j; x < jEnd; x++) if (!tokExtra.includes(x)) spanChars.push(t[x]);
    for (const x of tokExtra) extraIdx.add(x);
    if (tokErr === 0) perToken[i] = { status: "ok", heard: spanChars.join("") };
    else if (matchedOrSub === 0) perToken[i] = { status: "missing", heard: "" };
    else perToken[i] = { status: "changed", heard: spanChars.join("") };
  }
  for (let x = 0; x < j; x++) extraIdx.add(x); // 첫 토큰 앞에 덧붙은 글자
  units.forEach((u, i) => {
    const p = perToken[i];
    if (p.status === "missing") missing.push(u.surface);
    else if (p.status === "changed") substituted.push({ expected: u.surface, heard: p.heard });
  });
  const extra: string[] = [];
  let run = "";
  let last = -2;
  for (const x of [...extraIdx].sort((p, q) => p - q)) {
    if (x !== last + 1 && run) {
      extra.push(run);
      run = "";
    }
    run += t[x];
    last = x;
  }
  if (run) extra.push(run);
  const accuracy = denom === 0 ? 0 : Math.max(0, 1 - errors / denom);
  return { accuracy, missing, extra, substituted };
}

// ---------------------------------------------------------------------------
// 무응답·said 대조
// ---------------------------------------------------------------------------

/** 전사문 발화 글자(정규화 뒤)가 이보다 적으면 무응답 — 호출 F 없이 0점(비용 절약, 토익 2단어 규칙의 일본어판) */
export const JA_SPEAKING_MIN_TRANSCRIPT_CHARS = 4;
export const JA_SPEAKING_NO_RESPONSE_KO = "답변이 인식되지 않았어요";

export function isJaNoResponseTranscript(transcript: string | null): boolean {
  if (transcript === null) return true;
  return normalizeJaReadChars(transcript).length < JA_SPEAKING_MIN_TRANSCRIPT_CHARS;
}

/** said 대조용 정규화 — NFKC·소문자, 공백·문장부호·기호를 걷는다(가나 종류는 바꾸지 않는다 — 전사문 그대로의 구간이어야 하므로) */
export function normalizeJaQuote(s: string): string {
  const m = s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]/gu);
  return m ? m.join("") : "";
}

/** said가 전사문에 **연속 구간으로** 있는가(문장부호·공백·대소문자 무시). 정규화 뒤 2글자 미만이면 false */
export function isSaidInJaTranscript(said: string, transcript: string): boolean {
  const n = normalizeJaQuote(said);
  if (n.length < 2) return false;
  return normalizeJaQuote(transcript).includes(n);
}

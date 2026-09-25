/**
 * lib/tts-split.ts — TTS 한 번에 읽을 수 있게 텍스트를 쪼개는 **공용 순수 함수** (docs/SPEC.md §18-1, docs/harness/toeic.md §6-3)
 *
 * 원래 lib/ja-coaching-script.ts(대화 해설 낭독) 안에 있던 것을 **그대로 옮겼다**(동작 변화 0 — eval:speech가 잠근다).
 * 토익 전체 듣기(lib/toeic-listen.ts)도 300자를 넘는 조각을 같은 규칙으로 나눠야 해서 공용 모듈로 뺐다.
 * lib/ja-coaching-script.ts는 기존 import 경로가 깨지지 않게 이 함수를 재수출한다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0. 서버 전용 모듈(lib/tts.ts·lib/ai/*)을 import하지 않는다.
 */

/** 공백 없이도 문장이 끝나는 부호(전각). */
const FULL_STOP = new Set(["。", "？", "！"]);
/** 뒤에 공백·문자열 끝이 와야 문장이 끝나는 부호(반각) — `3.5배`·`N5.x`는 안 자른다. */
const HALF_STOP = new Set([".", "?", "!"]);
/** 문장 끝 부호 바로 뒤에 붙는 닫는 기호 — 앞 조각에 붙인다(`「そうです。」라고`의 `」`가 뒤 조각 머리로 가지 않게). */
const CLOSERS = new Set(["」", "』", "）", ")", '"', "'", "’", "”", "】"]);
/** 문장이 max를 넘을 때 자를 수 있는 쉼표. */
const COMMAS = new Set([",", "、", "，"]);

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * t[dot]의 `.`이 **번호 목록 머리**(`1. …`, `2. …`)인가 — 문자열 머리나 공백 뒤 숫자 1~2자리 + `.` + 공백.
 * 이건 문장 끝이 아니다. 끝으로 보면 긴 총평의 "… 써요. 2. 어미 …"에서 `2.`가 앞 조각 꼬리에 붙는다(QA F9).
 * 숫자 3자리 이상(`2024.`)은 연도처럼 문장 끝일 수 있어 그대로 끝으로 본다.
 */
function isListMarkerDot(t: string, dot: number): boolean {
  if (t[dot] !== "." || !isWs(t[dot + 1])) return false;
  let k = dot - 1;
  while (k >= 0 && isDigit(t[k])) k--;
  const digits = dot - 1 - k;
  return digits >= 1 && digits <= 2 && (k < 0 || isWs(t[k]));
}

/** 조각이 번호 목록 머리(`… 2.`)로 끝나는가 — 강제 자르기가 그 자리에서 자르지 않게. */
const endsWithListMarker = (s: string) => /(^|\s)\d{1,2}\.$/.test(s);

/** t 안의 문장 끝 위치(exclusive) 목록. 마지막은 항상 t.length. */
function sentenceEnds(t: string): number[] {
  const ends: number[] = [];
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (isListMarkerDot(t, i)) {
      i++; // 번호 목록 머리 — 문장 끝 아님
      continue;
    }
    if (FULL_STOP.has(ch) || HALF_STOP.has(ch)) {
      // 이어지는 끝 부호(…, ?!, 。」)와 닫는 기호를 한데 묶는다.
      let j = i + 1;
      let full = FULL_STOP.has(ch);
      while (j < t.length && (FULL_STOP.has(t[j]) || HALF_STOP.has(t[j]) || CLOSERS.has(t[j]))) {
        if (FULL_STOP.has(t[j])) full = true;
        j++;
      }
      if (full || j >= t.length || isWs(t[j])) {
        ends.push(j);
        i = j;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (ends[ends.length - 1] !== t.length) ends.push(t.length);
  return ends;
}

/**
 * 한 문장이 max를 넘을 때: max 이내 마지막 쉼표·공백에서, 없으면 max에서(서로게이트 쌍은 안 쪼갠다).
 * 번호 목록 머리(`… 2.`) 바로 뒤 공백에서는 자르지 않는다 — 번호가 앞 조각 꼬리로 떨어지지 않게.
 */
function hardSplit(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    let cut = -1;
    for (let c = max; c >= 1; c--) {
      if (COMMAS.has(rest[c - 1]) || isWs(rest[c - 1]) || isWs(rest[c])) {
        const head = rest.slice(0, c).trim();
        if (!head || endsWithListMarker(head)) continue;
        cut = c;
        break;
      }
    }
    if (cut < 1) {
      cut = max;
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1; // 이모지 가운데서 자르지 않는다
      if (cut < 1) cut = 2; // max=1인데 첫 글자가 서로게이트 쌍 — 쌍을 지키는 쪽을 택한다
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * TTS 한 번에 읽을 수 있게 텍스트를 쪼갠다(§18-1 규칙 확정).
 * - 길이는 `String.length`(UTF-16) — 서버 zod와 같은 단위. `max < 1`은 1로 취급.
 * - `trim().length ≤ max`면 한 조각. 아니면 문장 단위로 자른 뒤 max 이하로 앞에서부터 탐욕적으로 묶는다.
 * - 불변식: 모든 조각 trim·비어 있지 않음·`length ≤ max`, 공백을 뺀 글자는 원문과 같다(조각 내부 공백은 그대로).
 */
export function splitForTts(text: string, max: number): string[] {
  const m = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  const t = (text ?? "").trim();
  if (!t) return [];
  if (t.length <= m) return [t];

  const ends = sentenceEnds(t);
  const out: string[] = [];
  let start = 0;
  let k = 0;
  while (k < ends.length) {
    const first = t.slice(start, ends[k]).trim();
    if (!first) {
      start = ends[k];
      k++;
      continue;
    }
    if (first.length > m) {
      out.push(...hardSplit(first, m));
      start = ends[k];
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < ends.length && t.slice(start, ends[e + 1]).trim().length <= m) e++;
    out.push(t.slice(start, ends[e]).trim());
    start = ends[e];
    k = e + 1;
  }
  return out;
}

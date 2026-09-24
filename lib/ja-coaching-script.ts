/**
 * lib/ja-coaching-script.ts — 대화 해설 → **낭독 대본**(재생할 조각 배열) (docs/SPEC.md §18-1)
 *
 * 해설(호출 C 결과)을 "무엇을 어느 언어로 어떤 순서로 읽을지"로 바꾸는 일은 화면이 아니라 이 **순수 함수**가 한다.
 * 화면은 대본을 speakQueue에 넘기고 onItem 인덱스로 카드를 강조할 뿐이다. 오프라인 eval(eval-speech.ts)로 잠근다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 `./tts-shared`의 상수뿐, 타입은 `import type`.
 * 서버 전용 `lib/tts.ts`(openai)를 절대 import하지 않는다(speech.ts와 같은 규약).
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import type { JaDialogCoaching } from "./japanese-dialog-contract";

export type ScriptSection = "summary" | "goods" | "fixes" | "items" | "practice";

/** 재생할 조각 하나. */
export interface ScriptPiece {
  /** 읽을 텍스트(trim됨, 비어 있지 않음, length ≤ TTS_TEXT_MAX_CHARS) */
  text: string;
  lang: "ko-KR" | "ja-JP";
  section: ScriptSection;
  /** 하이라이트 대상 카드 번호. 섹션 제목 조각은 null, 총평 본문은 0 */
  item: number | null;
}

/** 섹션 제목(한국어로 읽는다). 끝의 마침표는 낭독에서 짧게 쉬게 하려는 것. */
const SECTION_TITLE: Record<ScriptSection, string> = {
  summary: "총평.",
  goods: "잘한 점.",
  fixes: "고칠 점.",
  items: "어휘.",
  practice: "다음 연습.",
};

// ───────────────────────── 한국어 정리 ─────────────────────────

/** 이모지 한 덩어리(ZWJ 결합·스킨톤·변형 선택자 U+FE0F 포함). */
const EMOJI_RE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

/**
 * 한국어 조각만, **쪼개기 전에** 적용한다: `→`·`⇒`는 `, `로, `〜`·`～`는 제거, 이모지 제거, 연속 공백은 하나로.
 * TTS가 기호를 "화살표"·"물결"로 읽거나 멈칫하지 않게 한다. 일본어 조각은 정리하지 않는다(🔊·프리페치 캐시 키 일치).
 * 키캡 이모지(`1️⃣` = 숫자 + U+FE0F + U+20E3)는 숫자가 그림 문자가 아니라 위 정규식에 안 걸린다 — 결합 기호만 지워 숫자를 남긴다.
 */
export function normalizeKoForTts(text: string): string {
  return (text ?? "")
    .replace(/\s*[→⇒]\s*/g, ", ")
    .replace(/[〜～]/g, "")
    .replace(EMOJI_RE, "")
    .replace(/[\uFE0F\u200D\u20E3]/g, "") // 떨어져 남은 변형 선택자·ZWJ·키캡 결합 기호
    .replace(/\s+([.,!?。、，])/g, "$1") // 지운 이모지 자리에 남은 "요 ." 같은 공백을 부호에 붙인다
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────── 쪼개기 ─────────────────────────

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

// ───────────────────────── 대본 ─────────────────────────

/**
 * 해설 → 낭독 대본(§18-1 표 순서). 빈 섹션은 제목까지 통째로 건너뛴다. 각 필드는 `(s ?? "").trim()`, 비면 조각 없음.
 * 한국어는 정리(normalizeKoForTts) 후 쪼개고, 일본어는 원문 trim 그대로(≤300이면 한 조각). 쪼갠 조각은 같은 section·item.
 */
export function buildCoachingScript(c: JaDialogCoaching): ScriptPiece[] {
  const out: ScriptPiece[] = [];

  const section = (sec: ScriptSection, fill: (push: (text: string | null | undefined, lang: ScriptPiece["lang"], item: number) => void) => void) => {
    const body: ScriptPiece[] = [];
    fill((raw, lang, item) => {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) return;
      const src = lang === "ko-KR" ? normalizeKoForTts(trimmed) : trimmed;
      for (const text of splitForTts(src, TTS_TEXT_MAX_CHARS)) body.push({ text, lang, section: sec, item });
    });
    if (body.length === 0) return; // 빈 섹션 → 제목도 없음
    out.push({ text: SECTION_TITLE[sec], lang: "ko-KR", section: sec, item: null }, ...body);
  };

  section("summary", (push) => push(c.summaryKo, "ko-KR", 0));

  section("goods", (push) =>
    (c.goods ?? []).forEach((g, i) => {
      push(g.quoteJa, "ja-JP", i);
      push(g.whyKo, "ko-KR", i);
    }),
  );

  section("fixes", (push) =>
    (c.fixes ?? []).forEach((f, i) => {
      push(f.originalJa, "ja-JP", i);
      // "고치면,"은 고친 문장이 있을 때만 — 없는 문장을 예고하지 않는다.
      if ((f.betterJa ?? "").trim()) push("고치면,", "ko-KR", i);
      push(f.betterJa, "ja-JP", i);
      push(f.whyKo, "ko-KR", i);
      const grammar = (f.grammarKo ?? "").trim();
      if (grammar) push(`문법: ${grammar}`, "ko-KR", i);
    }),
  );

  section("items", (push) =>
    (c.items ?? []).forEach((it, i) => {
      push(it.word, "ja-JP", i);
      push(it.meaningKo, "ko-KR", i);
      push(it.usageKo, "ko-KR", i);
    }),
  );

  section("practice", (push) =>
    (c.practice ?? []).forEach((p, i) => {
      push(p.ja, "ja-JP", i);
      push(p.ko, "ko-KR", i);
    }),
  );

  return out;
}

/**
 * 해설 속 일본어 문장 목록(프리페치용) — 잘한 점 인용·고칠 점 원문/고친 문장·어휘·다음 연습.
 * trim만 하고 빈 것은 뺀다 — 대본의 일본어 조각·🔊 speak(ja, "ja-JP")와 글자까지 같아야 캐시가 맞는다.
 */
export function coachingJaTexts(c: JaDialogCoaching): string[] {
  return [
    ...(c.goods ?? []).map((g) => g.quoteJa),
    ...(c.fixes ?? []).flatMap((f) => [f.originalJa, f.betterJa]),
    ...(c.items ?? []).map((i) => i.word),
    ...(c.practice ?? []).map((p) => p.ja),
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
}

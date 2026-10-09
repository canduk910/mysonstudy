/**
 * 엄마의 생활영어 — 발화 판정(너그럽게, AI 없음). 설계 §4-1.
 *
 * 순수 모듈 — 클라이언트 화면이 그대로 import한다. 낱말 정규화·축약형·대안 낱말 비교는
 * 토익 틀 비교 함수(`lib/toeic-template.ts`)를 재사용하고, 임계값만 엄마용 상수로 둔다.
 */
import { expandSlashAlternatives, normalizeTemplateWords, sameTemplateWord } from "./toeic-template";

/** 내용 낱말 일치 비율 — 이 이상이고 틀이 맞으면 통과 */
export const MOM_PASS_CONTENT = 0.7;
/** 틀이 맞고 이 이상이면 아깝다 */
export const MOM_CLOSE_CONTENT = 0.4;
/** 내용 낱말에서 빼는 기능어(관사·전치사·be동사 등) — 빠지거나 바뀌어도 감점 없음 */
export const MOM_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "and", "is", "are", "am", "be",
]);

export interface MomJudge {
  verdict: "pass" | "close" | "retry";
  frameOk: boolean;
  contentRate: number;
  /** 들리지 않은 내용 낱말(정규화형) */
  missing: string[];
  /** 목표 문장에 없는 덧붙인 내용 낱말(기능어·군말·틀 낱말 제외) — 많으면 통과를 아깝다로 낮춘다 */
  extras: string[];
  /** 무응답 — 전사 2낱말 미만 */
  noSpeech: boolean;
  noteKo: string | null;
}

const PLACEHOLDER_RE = /^(~+|…+|\.\.\.+)[?.!,]*$/;

/** 내용 비교에서 빼는 군말(덧붙여도 감점 없음) */
export const MOM_FILLER_WORDS: ReadonlySet<string> = new Set(["um", "uh", "er", "ah", "oh", "please", "okay", "ok"]);

/**
 * 틀 글자의 슬래시 대안을 펼친 낱말열들.
 * 낱말 단위 곱은 `expandSlashAlternatives`(토익 틀 함수) 그대로, 여기에 구절 단위 해석을 더한다 —
 * "What time/When ~?"처럼 오른쪽 대안이 앞 구절 전체(틀 처음 또는 직전 자리 표시·슬래시 뒤부터)를 바꾸는 경우.
 */
export function frameAlternativesOf(frameText: string): string[][] {
  const text = (frameText ?? "").trim();
  const variants = new Set<string>(text.includes("/") ? expandSlashAlternatives(text) : [text]);
  const tokens = text.split(/\s+/).filter((t) => t !== "");
  const firstAlt = (t: string) => (t.includes("/") ? (t.split("/").find((x) => x !== "") ?? t) : t);
  tokens.forEach((t, i) => {
    if (!t.includes("/")) return;
    let from = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (PLACEHOLDER_RE.test(tokens[k]) || tokens[k].includes("/")) { from = k + 1; break; }
    }
    for (const r of t.split("/").slice(1).filter((x) => x !== "")) {
      variants.add([...tokens.slice(0, from).map(firstAlt), r, ...tokens.slice(i + 1).map(firstAlt)].join(" "));
    }
  });
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    const words = normalizeTemplateWords(v.replace(/[~…]|\.\.\./g, " "));
    const key = words.join(" ");
    if (words.length > 0 && !seen.has(key)) { seen.add(key); out.push(words); }
  }
  return out;
}

/** 틀 대안 중 문장(target)에 순서대로 들어 있는 것 — 다른 적용 대안의 진부분 수열인 짧은 대안은 뺀다(틀이 약해지지 않게) */
function applicableFrames(alts: string[][], target: string[]): string[][] {
  const app = alts.filter((a) => inOrder(a, target, sameLoose));
  return app.filter((a) => !app.some((b) => b.length > a.length && inOrder(a, b, (x, y) => x === y)));
}

/** "~"·"…" 자리 표시를 뺀 틀 낱말(정규화). `en`을 주면 그 문장에 맞는 대안, 아니면 첫 대안 */
export function frameWordsOf(frameText: string, en?: string): string[] {
  const alts = frameAlternativesOf(frameText);
  if (en !== undefined) {
    const app = applicableFrames(alts, normalizeTemplateWords(en));
    if (app.length > 0) return app[0];
  }
  return alts[0] ?? [];
}

/** 단수·복수 차이 허용 — 끝 "s"를 뗀 형태(짧은 낱말은 그대로) */
function stemS(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** 불규칙 활용 — 같은 줄의 꼴끼리 같다(시제 감점 없음) */
const IRREGULAR_GROUPS: readonly (readonly string[])[] = [
  ["go", "went", "gone", "goes"], ["have", "has", "had"], ["do", "does", "did", "done"], ["get", "got", "gotten"],
  ["make", "made"], ["take", "took", "taken"], ["come", "came"], ["see", "saw", "seen"], ["say", "said"],
  ["eat", "ate", "eaten"], ["buy", "bought"], ["is", "was"], ["are", "were"], ["am", "was"], ["give", "gave", "given"],
  ["find", "found"], ["tell", "told"], ["think", "thought"], ["feel", "felt"], ["leave", "left"], ["know", "knew", "known"],
];

/** 한 낱말의 너그러운 형태들 — 원형·복수 s·-ed/-d/-ing 뗀 꼴(남는 줄기 3글자 이상) */
function looseForms(w: string): Set<string> {
  const f = new Set<string>([w, stemS(w)]);
  for (const suf of ["ing", "ed", "d"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) f.add(w.slice(0, -suf.length));
  }
  return f;
}

function sameLooseOne(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = looseForms(a);
  for (const x of looseForms(b)) if (fa.has(x)) return true;
  return IRREGULAR_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

/** 너그러운 낱말 같음 — 대안 낱말(`would|had`)은 뜻 하나라도, 복수·시제 차이는 같게 */
function sameLoose(a: string, b: string): boolean {
  if (sameTemplateWord(a, b)) return true;
  const as = a.split("|");
  const bs = b.split("|");
  return as.some((x) => bs.some((y) => sameLooseOne(x, y)));
}

/** needle이 hay 안에 순서대로(부분 수열) 있는가 */
function inOrder(needle: string[], hay: string[], same: (a: string, b: string) => boolean): boolean {
  let i = 0;
  for (const h of hay) {
    if (i < needle.length && same(needle[i], h)) i++;
  }
  return i === needle.length;
}

export function judgeMomSpeech(input: { en: string; frameText: string; transcript: string }): MomJudge {
  const heard = normalizeTemplateWords(input.transcript ?? "");
  const target = normalizeTemplateWords(input.en ?? "");
  const alts = frameAlternativesOf(input.frameText ?? "");
  const allFrameWords = alts.flat();

  if (heard.length < 2) {
    return { verdict: "retry", frameOk: false, contentRate: 0, missing: [], extras: [], noSpeech: true, noteKo: null };
  }

  // 문장 자체가 어느 틀 대안도 순서대로 담지 않으면(틀과 다른 변형 문장) 틀 검사는 통과로 본다
  const applicable = applicableFrames(alts, target);
  const frameOk = applicable.length === 0 || applicable.some((a) => inOrder(a, heard, sameLoose));

  const isFrameWord = (w: string) => allFrameWords.some((f) => sameLoose(f, w));
  let content = target.filter((w) => !MOM_FUNCTION_WORDS.has(w) && !isFrameWord(w));
  if (content.length === 0) content = applicable[0] ?? alts[0] ?? target;

  const missing = content.filter((w) => !heard.some((h) => sameLoose(w, h)));
  const contentRate = content.length === 0 ? 1 : (content.length - missing.length) / content.length;

  // 목표에 없는 내용 낱말을 덧붙였는가(다른 말을 했는데 목표 낱말이 우연히 섞인 경우 — 통과 금지)
  const extras = heard.filter(
    (h) => !MOM_FUNCTION_WORDS.has(h) && !MOM_FILLER_WORDS.has(h) && !isFrameWord(h) && !content.some((c) => sameLoose(c, h)),
  );

  let verdict: MomJudge["verdict"];
  if (frameOk && contentRate >= MOM_PASS_CONTENT) verdict = "pass";
  else if ((frameOk && contentRate >= MOM_CLOSE_CONTENT) || (!frameOk && contentRate >= MOM_PASS_CONTENT)) verdict = "close";
  else verdict = "retry";
  if (verdict === "pass" && content.length > 0 && extras.length * 2 >= content.length) verdict = "close";

  // 통과했지만 관사·기능어·시제·복수형 등이 문장과 다르면 원래 문장을 한 줄로 보여 준다
  const exact = heard.length === target.length && heard.every((h, i) => sameTemplateWord(target[i], h));
  const noteKo = verdict === "pass" && !exact ? `이렇게도 말해요: ${input.en}` : null;

  return { verdict, frameOk, contentRate, missing, extras, noSpeech: false, noteKo };
}

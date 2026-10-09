/**
 * 엄마의 생활영어 — 발화 판정(너그럽게, AI 없음). 설계 §4-1.
 *
 * 순수 모듈 — 클라이언트 화면이 그대로 import한다. 낱말 정규화·축약형·대안 낱말 비교는
 * 토익 틀 비교 함수(`lib/toeic-template.ts`)를 재사용하고, 임계값만 엄마용 상수로 둔다.
 */
import { normalizeTemplateWords, sameTemplateWord } from "./toeic-template";

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
  /** 무응답 — 전사 2낱말 미만 */
  noSpeech: boolean;
  noteKo: string | null;
}

/** "~"·"…" 자리 표시를 뺀 틀 낱말(정규화) */
export function frameWordsOf(frameText: string): string[] {
  return normalizeTemplateWords((frameText ?? "").replace(/[~…]|\.\.\./g, " "));
}

/** 단수·복수 차이 허용 — 끝 "s"를 뗀 형태(짧은 낱말은 그대로) */
function stemS(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function sameLoose(a: string, b: string): boolean {
  if (sameTemplateWord(a, b)) return true;
  if (a.includes("|") || b.includes("|")) return false;
  return stemS(a) === stemS(b);
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
  const frame = frameWordsOf(input.frameText ?? "");

  if (heard.length < 2) {
    return { verdict: "retry", frameOk: false, contentRate: 0, missing: [], noSpeech: true, noteKo: null };
  }

  // 문장 자체가 틀을 순서대로 담지 않으면(틀과 다른 변형 문장) 틀 검사는 통과로 본다
  const frameApplies = frame.length > 0 && inOrder(frame, target, sameTemplateWord);
  const frameOk = !frameApplies || inOrder(frame, heard, sameTemplateWord);

  const isFrameWord = (w: string) => frame.some((f) => sameTemplateWord(f, w));
  let content = target.filter((w) => !MOM_FUNCTION_WORDS.has(w) && !isFrameWord(w));
  if (content.length === 0) content = frame.length > 0 ? frame : target;

  const missing = content.filter((w) => !heard.some((h) => sameLoose(w, h)));
  const contentRate = content.length === 0 ? 1 : (content.length - missing.length) / content.length;

  let verdict: MomJudge["verdict"];
  if (frameOk && contentRate >= MOM_PASS_CONTENT) verdict = "pass";
  else if ((frameOk && contentRate >= MOM_CLOSE_CONTENT) || (!frameOk && contentRate >= MOM_PASS_CONTENT)) verdict = "close";
  else verdict = "retry";

  // 통과했지만 관사·기능어·복수형 등이 문장과 다르면 원래 문장을 한 줄로 보여 준다
  const exact = heard.length === target.length && heard.every((h, i) => sameTemplateWord(target[i], h));
  const noteKo = verdict === "pass" && !exact ? `이렇게도 말해요: ${input.en}` : null;

  return { verdict, frameOk, contentRate, missing, noSpeech: false, noteKo };
}

/**
 * lib/ja-speaking.ts — 아빠의 일본어 **🎙️ 말하기 모의고사** 형식·지시문·멘트·길이 안내·추정 수준 순수 함수
 * (docs/harness/japanese.md §15)
 *
 * - **형식표는 토익과 같은 표를 그대로 쓴다**(§15-1 결정) — 11문항 5파트·준비/답변 시간·질문 재생 횟수·만점이 토익 형식표
 *   (`lib/toeic-mock.ts` TOEIC_MOCK_FORMAT)와 같으므로 숫자를 두 벌 두지 않는다. 단계 전이(firstPhase·nextPhase·beginAnswer·
 *   toeicSpeechOutcome)도 언어와 무관해 응시 화면이 그대로 쓴다. 이 파일은 **언어가 다른 것**만 둔다 — 지시문(일본어 + 한국어 캡션)·
 *   진행 멘트(일본어)·읽기 언어(ja-JP)·모범답변 길이 안내(레벨별 글자 수)·추정 수준.
 * - 지시문·멘트는 **이 앱의 문장**이다(시험 원문을 옮기지 않는다). 지시문 속 숫자는 형식표에서 계산한다.
 * - 길이 안내(§15-3-7)는 프롬프트에 **계산해 주입**한다 — 프롬프트·zod·eval이 같은 함수를 본다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 `./toeic-mock`(그 자체가 클라이언트 안전 — 런타임 import 0)뿐이다. lib/ai·openai·zod·store를
 * 값으로 import하지 않는다(타입은 `import type`). 정규식 lookbehind를 쓰지 않는다(구형 iOS Safari).
 */

import type { JlptLevel } from "./ai/japanese/schemas";
import type {
  JaSpeakingInfoPart,
  JaSpeakingLevelEstimate,
  JaSpeakingOpinionPart,
  JaSpeakingRespondPart,
} from "./ai/japanese/speaking-schemas";
import {
  TOEIC_MOCK_FORMAT,
  TOEIC_MOCK_PARTS,
  TOEIC_QUESTION_COUNT,
  toeicQuestionFormat,
  type ToeicMockPart,
  type ToeicPhaseState,
} from "./toeic-mock";

// ---------------------------------------------------------------------------
// 파트·레벨
// ---------------------------------------------------------------------------

/** 파트 다섯(호출 E1~E5) — 토익 모의고사와 같은 키·같은 순서(형식표 공유) */
export const JA_SPEAKING_PARTS = TOEIC_MOCK_PARTS;
export type JaSpeakingPart = ToeicMockPart;

/** 한 세트의 문항 수(11) — 형식표 공유 */
export const JA_SPEAKING_QUESTION_COUNT = TOEIC_QUESTION_COUNT;

/** 만들기 화면의 레벨 버튼 순서(쉬운 → 어려운). 값 집합은 JLPT_LEVELS와 같다 */
export const JA_SPEAKING_LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const satisfies readonly JlptLevel[];
/** 기본 레벨 */
export const JA_SPEAKING_DEFAULT_LEVEL: JlptLevel = "N4";

/** 파트 이름(한국어) — 화면 배지·호출 F 사용자 메시지의 "{유형 이름}" */
export const JA_SPEAKING_PART_NAME_KO: Record<JaSpeakingPart, string> = {
  read: "지문 읽기",
  picture: "사진 묘사",
  respond: "듣고 답하기",
  info: "정보 활용",
  opinion: "의견 말하기",
};

/** 지시문·질문·멘트·모범답변을 읽는 언어 — lang은 항상 명시한다(한국어 캡션은 소리로 읽지 않는다) */
export const JA_SPEAKING_SPEECH_LANG = "ja-JP" as const;

/** 기본 제목 "말하기 모의고사 {n}" */
export function defaultJaSpeakingTitle(n: number): string {
  return `말하기 모의고사 ${n}`;
}

/** 문항 번호 → 형식(토익 형식표 그대로). 1..11 밖이면 throw */
export const jaSpeakingQuestionFormat = toeicQuestionFormat;

/** 만점 — Q11=5, 나머지 3 */
export function jaSpeakingMaxScore(q: number): 3 | 5 {
  return toeicQuestionFormat(q).maxScore;
}

/** 응시할 파트들 → 문항 번호들(형식표 순서) */
export function jaSpeakingQuestionsForParts(parts: readonly JaSpeakingPart[]): number[] {
  const set = new Set(parts);
  return TOEIC_MOCK_FORMAT.filter((f) => set.has(f.part)).map((f) => f.q);
}

// ---------------------------------------------------------------------------
// 파트 지시문 — 이 앱의 문장. 일본어(ja)를 ja-JP로 읽고 한국어(ko)는 화면 캡션. 숫자는 형식표에서 계산한다
// ---------------------------------------------------------------------------

function partFormats(part: JaSpeakingPart) {
  return TOEIC_MOCK_FORMAT.filter((f) => f.part === part);
}

function buildDirections(): Record<JaSpeakingPart, { ja: string; ko: string }> {
  const read = partFormats("read");
  const pic = partFormats("picture");
  const res = partFormats("respond");
  const inf = partFormats("info");
  const op = partFormats("opinion")[0];
  const last = <T,>(a: T[]): T => a[a.length - 1];
  return {
    read: {
      ja: `音読の問題です。短い文章が${read.length}つ、一つずつ表示されます。それぞれ${read[0].prepSec}秒で目を通してから、${read[0].answerSec}秒で声に出して読んでください。`,
      ko: `지문 읽기. 짧은 지문 ${read.length}개가 하나씩 나와요. 지문마다 ${read[0].prepSec}초 동안 훑어본 뒤, ${read[0].answerSec}초 동안 소리 내어 읽으세요.`,
    },
    picture: {
      ja: `写真描写の問題です。写真が${pic.length}枚、一枚ずつ表示されます。それぞれ${pic[0].prepSec}秒で写真を見てから、${pic[0].answerSec}秒で写真について話してください。`,
      ko: `사진 묘사. 사진 ${pic.length}장이 한 장씩 나와요. 사진마다 ${pic[0].prepSec}초 동안 살펴본 뒤, ${pic[0].answerSec}초 동안 묘사하세요.`,
    },
    respond: {
      ja: `質問に答える問題です。画面の状況にいると考えて、${res.length}つの質問に答えてください。質問を聞いたあと、${res[0].prepSec}秒で準備してください。はじめの二つは${res[0].answerSec}秒ずつ、最後の質問は${last(res).answerSec}秒で答えてください。`,
      ko: `듣고 답하기. 화면의 상황에 있다고 생각하고 질문 ${res.length}개에 답하세요. 질문을 들은 뒤 ${res[0].prepSec}초 준비하고, 앞의 두 질문은 ${res[0].answerSec}초, 마지막 질문은 ${last(res).answerSec}초 동안 답하세요.`,
    },
    info: {
      ja: `表を見て答える問題です。まず${inf[0].readingSec}秒で表を見てください。そのあと、電話をかけてきた人が表について${inf.length}つ質問します。質問ごとに${inf[0].prepSec}秒で準備して、はじめの二つは${inf[0].answerSec}秒ずつ、最後の質問は${last(inf).answerSec}秒で答えてください。最後の質問は${last(inf).questionPlays}回聞こえます。`,
      ko: `정보 활용. 먼저 ${inf[0].readingSec}초 동안 표를 살펴보세요. 이어서 전화한 사람이 표에 대해 ${inf.length}가지를 묻습니다. 질문마다 ${inf[0].prepSec}초 준비하고, 앞의 두 질문은 ${inf[0].answerSec}초, 마지막 질문은 ${last(inf).answerSec}초 동안 답하세요. 마지막 질문은 ${last(inf).questionPlays}번 들려줘요.`,
    },
    opinion: {
      ja: `意見を述べる問題です。質問について自分の立場をはっきり決めて、理由と例を挙げて話してください。準備は${op.prepSec}秒、話す時間は${op.answerSec}秒です。`,
      ko: `의견 말하기. 질문에 대한 입장을 분명히 정하고 이유와 예시로 뒷받침하세요. ${op.prepSec}초 준비하고 ${op.answerSec}초 동안 말하세요.`,
    },
  };
}

/** 파트 지시문 — 파트마다 한 번만 정의. ja는 읽기용(JA_SPEAKING_SPEECH_LANG), ko는 화면 캡션 */
export const JA_SPEAKING_PART_DIRECTIONS: Record<JaSpeakingPart, { ja: string; ko: string }> = buildDirections();

/**
 * 응시 문항 수에 맞춘 지시문 — count가 그 파트 문항 수와 같으면 JA_SPEAKING_PART_DIRECTIONS[part]를 **그대로**(같은 객체),
 * 사진 1장(`picture`, count 1)이면 한 장짜리 문장. 그 밖은 파트 지시문 그대로(토익 `toeicPartDirections`와 같은 규칙).
 */
export function jaSpeakingPartDirections(part: JaSpeakingPart, count: number): { ja: string; ko: string } {
  const formats = partFormats(part);
  if (count === formats.length) return JA_SPEAKING_PART_DIRECTIONS[part];
  if (part === "picture" && count === 1) {
    const f = formats[0];
    return {
      ja: `写真描写の問題です。写真が1枚表示されます。${f.prepSec}秒で写真を見てから、${f.answerSec}秒で写真について話してください。`,
      ko: `사진 묘사. 사진 1장이 나와요. ${f.prepSec}초 동안 살펴본 뒤, ${f.answerSec}초 동안 묘사하세요.`,
    };
  }
  return JA_SPEAKING_PART_DIRECTIONS[part];
}

// ---------------------------------------------------------------------------
// 진행 멘트 — 토익 §18 관용구를 일본어로(상태 기계는 그대로, 멘트가 끝난 뒤 그 단계의 시계를 세운다)
// ---------------------------------------------------------------------------

/** 준비 시작 — 모든 파트 준비 앞, Q8 앞 표 읽기 앞 */
export const JA_SPEAKING_CUE_PREPARE = "準備を始めてください。" as const;
/** 질문을 다시 들려주기 전(두 번째 재생부터 — Q10) */
export const JA_SPEAKING_CUE_LISTEN_AGAIN = "もう一度聞いてください。" as const;
/** 답변 시작 — 파트마다 */
export const JA_SPEAKING_ANSWER_CUE: Record<JaSpeakingPart, string> = {
  read: "音読を始めてください。",
  picture: "話し始めてください。",
  respond: "答え始めてください。",
  info: "答え始めてください。",
  opinion: "話し始めてください。",
};

/** 그 단계에 들어갈 때 먼저 읽는 멘트(없으면 null) — 토익 `toeicPhaseCue`와 같은 자리, 글자만 일본어 */
export function jaSpeakingPhaseCue(st: Pick<ToeicPhaseState, "phase" | "q" | "play">): string | null {
  if (st.q === null) return null;
  switch (st.phase) {
    case "reading":
    case "prep":
      return JA_SPEAKING_CUE_PREPARE;
    case "beep":
      return JA_SPEAKING_ANSWER_CUE[toeicQuestionFormat(st.q).part];
    case "question":
      return st.play >= 1 ? JA_SPEAKING_CUE_LISTEN_AGAIN : null;
    default:
      return null;
  }
}

/** 이번 응시에서 읽을 수 있는 멘트 전부(중복 없음, 처음 나오는 순서) — 시작 탭의 미리 받기. 실전이면 5개 */
export function jaSpeakingCueTexts(qs: readonly number[]): string[] {
  const out: string[] = [];
  const push = (t: string | null) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const q of qs) {
    const f = toeicQuestionFormat(q);
    if (f.readingSec > 0) push(jaSpeakingPhaseCue({ phase: "reading", q, play: 0 }));
    for (let p = 1; p < f.questionPlays; p++) push(jaSpeakingPhaseCue({ phase: "question", q, play: p }));
    push(jaSpeakingPhaseCue({ phase: "prep", q, play: 0 }));
    push(jaSpeakingPhaseCue({ phase: "beep", q, play: 0 }));
  }
  return out;
}

/**
 * 질문 음성 조각(ja-JP) — question 단계의 `play`번째 재생에서 읽을 일본어 문장들. 없으면 [](Q1–4 — 화면으로만).
 * - Q5 첫 재생: 상황 소개(intro) + 질문 / Q8 첫 재생: 전화 건 사람 도입(callerIntro) + 질문 / 그 밖: 질문만
 * - 파트 결과가 없거나 슬롯이 없으면 [](화면은 빈 큐를 speakQueue에 넘기지 않는다)
 */
export function jaSpeakingQuestionPieces(
  parts: { respond: JaSpeakingRespondPart | null; info: JaSpeakingInfoPart | null; opinion: JaSpeakingOpinionPart | null },
  q: number,
  play: number,
): string[] {
  const f = toeicQuestionFormat(q);
  if (f.questionPlays === 0) return [];
  if (f.part === "respond") {
    const p = parts.respond;
    const item = p?.questions[f.slot];
    if (!p || !item) return [];
    return f.speakIntro && play === 0 ? [p.intro.ja, item.question.ja] : [item.question.ja];
  }
  if (f.part === "info") {
    const p = parts.info;
    const item = p?.questions[f.slot];
    if (!p || !item) return [];
    return f.speakIntro && play === 0 ? [p.callerIntro.ja, item.question.ja] : [item.question.ja];
  }
  if (f.part === "opinion") {
    const p = parts.opinion;
    return p ? [p.question.ja] : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 길이 — 발화 글자 수(공백·문장부호 제외)와 레벨별 말하기 속도로 계산한다(§15-3-7)
// ---------------------------------------------------------------------------

/**
 * 레벨별 학습자 말하기 속도(초당 글자 수, 표기 글자 — 한자 1자도 1). 모범답변·지문 길이 안내의 바탕이다.
 * 원어민 보통 속도는 초당 5~7자 안팎이고, 학습자는 레벨이 낮을수록 느리다(지어낸 근사 — 튜닝 대상, §15-15).
 */
export const JA_SPEAKING_CHARS_PER_SEC: Record<JlptLevel, readonly [number, number]> = {
  N5: [2, 3],
  N4: [2.5, 3.5],
  N3: [3, 4],
  N2: [3.5, 4.5],
  N1: [4, 5],
};
/** 모범답변이 채우는 답변 시간의 몫 — 아래는 느린 속도 × 0.6, 위는 빠른 속도 × 0.8(시간을 다 채우지 않게) */
export const JA_SPEAKING_ANSWER_FILL = [0.6, 0.8] as const;
/** 지문 길이 몫 — 답변(읽기) 시간 × 느린 속도 × 0.8 ~ 빠른 속도 × 0.9 */
export const JA_SPEAKING_PASSAGE_FILL = [0.8, 0.9] as const;

/** 발화 글자 수 — NFKC 뒤 문자(\p{L})·숫자(\p{N})만 센다(공백·문장부호·기호 제외, ー·々는 문자로 센다) */
export function countJaSpeechChars(s: string): number {
  const m = s.normalize("NFKC").match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/** 레벨·답변 시간 → 모범답변 길이 안내 [하한, 상한](글자) */
export function jaSpeakingAnswerRange(level: JlptLevel, answerSec: number): [number, number] {
  const [lo, hi] = JA_SPEAKING_CHARS_PER_SEC[level];
  return [Math.round(answerSec * lo * JA_SPEAKING_ANSWER_FILL[0]), Math.round(answerSec * hi * JA_SPEAKING_ANSWER_FILL[1])];
}

/** 레벨 → Q1–2 지문 길이 안내 [하한, 상한](글자) — 읽기 시간은 형식표 Q1 답변 시간 */
export function jaSpeakingPassageRange(level: JlptLevel): [number, number] {
  const [lo, hi] = JA_SPEAKING_CHARS_PER_SEC[level];
  const sec = toeicQuestionFormat(1).answerSec;
  return [Math.round(sec * lo * JA_SPEAKING_PASSAGE_FILL[0]), Math.round(sec * hi * JA_SPEAKING_PASSAGE_FILL[1])];
}

/**
 * zod 폭(레벨 무관, 프롬프트 안내보다 넓게 — 경계에서 재요청을 태우지 않고 크게 벗어난 것만 거부. 토익 §4-9 관용구).
 * 모범답변: 답변 시간 × 0.8 ~ × 6 글자. 지문: 50~260 글자.
 */
export const JA_SPEAKING_ZOD_ANSWER_PER_SEC = [0.8, 6] as const;
export const JA_SPEAKING_ZOD_PASSAGE = [50, 260] as const;
export function jaSpeakingZodAnswerBand(answerSec: number): [number, number] {
  return [Math.ceil(answerSec * JA_SPEAKING_ZOD_ANSWER_PER_SEC[0]), Math.floor(answerSec * JA_SPEAKING_ZOD_ANSWER_PER_SEC[1])];
}

/**
 * 호출 E 사용자 메시지의 `길이:` 아래 줄들(§15-3-7) — 파트마다 형식표의 답변 시간으로 계산한다. 줄은 "- " 머리, \n으로 잇는다.
 */
export function jaSpeakingLengthLines(part: JaSpeakingPart, level: JlptLevel): string {
  const fs = partFormats(part);
  if (part === "read") {
    const [a, b] = jaSpeakingPassageRange(level);
    return `- 지문: ${a}~${b}자`;
  }
  if (part === "respond" || part === "info") {
    const first = fs[0];
    const lastF = fs[fs.length - 1];
    const [a1, b1] = jaSpeakingAnswerRange(level, first.answerSec);
    const [a3, b3] = jaSpeakingAnswerRange(level, lastF.answerSec);
    return [`- 질문 1·2 모범답변(${first.answerSec}초): ${a1}~${b1}자`, `- 질문 3 모범답변(${lastF.answerSec}초): ${a3}~${b3}자`].join("\n");
  }
  const f = fs[0];
  const [a, b] = jaSpeakingAnswerRange(level, f.answerSec);
  return `- 모범답변(${f.answerSec}초): ${a}~${b}자`;
}

// ---------------------------------------------------------------------------
// 추정 수준 — JLPT에는 말하기 시험이 없다. 공식 척도가 아니라 이 앱의 추정이다(§15-6)
// ---------------------------------------------------------------------------

export const JA_SPEAKING_ESTIMATE_LABEL_KO = "추정(참고용) — JLPT에는 말하기 시험이 없어요";

/** 추정 수준 순서(낮음 → 높음) */
export const JA_SPEAKING_LEVEL_ORDER: readonly JaSpeakingLevelEstimate[] = ["below_n5", "N5", "N4", "N3", "N2", "N1"];
/** 추정 수준 이름(화면) */
export const JA_SPEAKING_LEVEL_LABEL_KO: Record<JaSpeakingLevelEstimate, string> = {
  below_n5: "N5 미만",
  N5: "N5",
  N4: "N4",
  N3: "N3",
  N2: "N2",
  N1: "N1",
};
/** 응시 전체의 추정 수준을 내려면 문항별 추정이 최소 이만큼 있어야 한다 */
export const JA_SPEAKING_LEVEL_MIN_ESTIMATES = 3;

/**
 * 문항별 추정(호출 F `levelEstimate`, Q3–11)을 모아 응시 전체의 추정 수준 — **아래쪽 중앙값**(짝수 개면 낮은 쪽, 보수적).
 * 유효한 추정이 JA_SPEAKING_LEVEL_MIN_ESTIMATES 미만이면 null(사진 2장만 푼 연습 등). 모르는 값은 센 수에 넣지 않는다.
 */
export function estimateJaSpeakingLevel(
  answers: readonly { levelEstimate: string | null | undefined }[],
): { level: JaSpeakingLevelEstimate; count: number } | null {
  const ranks = answers
    .map((a) => JA_SPEAKING_LEVEL_ORDER.indexOf(a.levelEstimate as JaSpeakingLevelEstimate))
    .filter((r) => r >= 0)
    .sort((a, b) => a - b);
  if (ranks.length < JA_SPEAKING_LEVEL_MIN_ESTIMATES) return null;
  const mid = ranks[Math.floor((ranks.length - 1) / 2)];
  return { level: JA_SPEAKING_LEVEL_ORDER[mid], count: ranks.length };
}

export type JaSpeakingAchievementBand = "reached" | "near" | "below";
/** 달성도 문턱 — 점수 합 / 만점 합 */
export const JA_SPEAKING_ACHIEVEMENT_REACHED = 0.8;
export const JA_SPEAKING_ACHIEVEMENT_NEAR = 0.6;
export const JA_SPEAKING_ACHIEVEMENT_LABEL_KO: Record<JaSpeakingAchievementBand, string> = {
  reached: "이 레벨 말하기에 도달했어요",
  near: "이 레벨에 가까워요",
  below: "이 레벨은 아직이에요",
};

export type JaSpeakingAchievement =
  | { ok: true; raw: number; max: number; ratio: number; band: JaSpeakingAchievementBand }
  | { ok: false; scoredCount: number; total: number };

/**
 * 문항 레벨 달성도 — 응시 범위(qs)의 **모든 문항**이 채점됐을 때만 계산한다(하나라도 없으면 ok:false + 채점된 수).
 * 점수가 정수 0~만점 밖이거나 문항 번호가 범위 밖이면 그 답은 채점되지 않은 것으로 센다(던지지 않는다 — 결과 화면이 깨지지 않게).
 */
export function jaSpeakingAchievement(qs: readonly number[], answers: readonly { q: number; score: number | null }[]): JaSpeakingAchievement {
  const valid = new Map<number, number>();
  for (const a of answers) {
    if (!qs.includes(a.q)) continue;
    if (a.score === null || !Number.isInteger(a.score)) continue;
    const max = jaSpeakingMaxScore(a.q);
    if (a.score < 0 || a.score > max) continue;
    valid.set(a.q, a.score);
  }
  if (qs.length === 0 || valid.size < qs.length) return { ok: false, scoredCount: valid.size, total: qs.length };
  let raw = 0;
  let max = 0;
  for (const q of qs) {
    raw += valid.get(q) as number;
    max += jaSpeakingMaxScore(q);
  }
  const ratio = raw / max;
  const band: JaSpeakingAchievementBand =
    ratio >= JA_SPEAKING_ACHIEVEMENT_REACHED ? "reached" : ratio >= JA_SPEAKING_ACHIEVEMENT_NEAR ? "near" : "below";
  return { ok: true, raw, max, ratio, band };
}

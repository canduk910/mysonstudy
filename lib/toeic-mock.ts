/**
 * lib/toeic-mock.ts — 토익스피킹 모의고사 **형식표·단계 전이·지시문** 순수 함수 (docs/harness/toeic.md §6-4)
 *
 * - 형식표(TOEIC_MOCK_FORMAT)는 **여기 한 곳**이 단일 정의다. 준비·답변 시간, 질문 재생 횟수, 표 읽기 시간, 만점, 화면에
 *   질문 텍스트를 보이는지가 전부 이 표에서 나온다. 응시 화면·채점 메시지(호출 D의 "답변 시간 N초 · 만점 M")·지시문이
 *   숫자를 다시 적지 않고 이 표를 읽는다.
 * - 단계 전이(nextPhase)는 **종료 시각(epoch ms)** 기반이다(운동 세션 타이머 관용구) — 화면이 잠들었다 깨도 남은 시간이
 *   어긋나지 않는다. 답변 타이머는 녹음 `start` 이벤트에서 시작하므로(§6-4 녹음 규칙) answer 단계의 종료 시각은
 *   nextPhase가 아니라 beginAnswer가 매긴다.
 * - 지시문은 **이 앱의 문장**이다(ETS 원문을 옮기지 않는다, §6-4). 숫자는 형식표에서 계산해 넣는다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0(타입만 lib/ai/toeic/schemas에서 `import type`).
 */

import type { ToeicPart } from "./ai/toeic/schemas";

// ---------------------------------------------------------------------------
// 파트·등급 상수 (단일 정의 — lib/ai/toeic/schemas.ts가 여기서 가져간다)
// ---------------------------------------------------------------------------

/** 모의고사 파트 5개(호출 C1~C5) — 형식표 순서 */
export const TOEIC_MOCK_PARTS = ["read", "picture", "respond", "info", "opinion"] as const;
export type ToeicMockPart = (typeof TOEIC_MOCK_PARTS)[number];

/** 목표 등급(§0-2) — 모범답변의 길이·수준이 달라진다 */
export const TOEIC_TARGET_GRADES = ["IM3", "IH", "AL"] as const;
export type ToeicTargetGrade = (typeof TOEIC_TARGET_GRADES)[number];
/** 기본 목표 등급(§0-2 "IH(기본)") */
export const TOEIC_DEFAULT_TARGET_GRADE: ToeicTargetGrade = "IH";

/** 모의고사 파트 → 발화 포인트 문항 축(호출 B의 useIn.part) */
export const TOEIC_MOCK_PART_TO_TOEIC_PART: Record<ToeicMockPart, ToeicPart> = {
  read: "q1_2",
  picture: "q3_4",
  respond: "q5_7",
  info: "q8_10",
  opinion: "q11",
};

/** 파트 이름(한국어) — 화면 배지·호출 D 사용자 메시지의 "{유형 이름}"(§5-2) */
export const TOEIC_MOCK_PART_NAME_KO: Record<ToeicMockPart, string> = {
  read: "지문 읽기",
  picture: "사진 묘사",
  respond: "듣고 답하기",
  info: "정보 활용",
  opinion: "의견 말하기",
};

/** 한 세트의 문항 수 */
export const TOEIC_QUESTION_COUNT = 11;

// ---------------------------------------------------------------------------
// 형식표 (§6-4 표 — 단일 정의)
// ---------------------------------------------------------------------------

export interface ToeicQuestionFormat {
  /** 문항 번호 1..11 */
  q: number;
  part: ToeicMockPart;
  /** 파트 안에서 몇 번째 문항인가(0부터) — 파트 결과 배열의 인덱스 */
  slot: number;
  /** 파트 첫 문항이면 지시문(directions) 단계를 둔다 */
  directions: boolean;
  /** 질문 음성 전에 표를 읽는 시간(초). Q8 앞만 45, 그 밖 0 */
  readingSec: number;
  /** 질문 음성을 틀어 주는 횟수. Q1–4는 0(지문·사진을 화면으로만), Q10은 2 */
  questionPlays: number;
  /** 첫 재생 앞에 상황 소개(Q5 intro)·전화 건 사람 도입(Q8 callerIntro)을 읽는가 */
  speakIntro: boolean;
  prepSec: number;
  answerSec: number;
  /** 질문 텍스트를 화면에 보이는가 — Q8–10은 표만 보이고 질문은 숨긴다 */
  showQuestionText: boolean;
  /** 만점 — Q11만 5, 나머지 3 */
  maxScore: 3 | 5;
}

const F = (
  q: number,
  part: ToeicMockPart,
  slot: number,
  o: Omit<ToeicQuestionFormat, "q" | "part" | "slot" | "maxScore" | "directions">,
): ToeicQuestionFormat => ({ q, part, slot, directions: slot === 0, maxScore: q === 11 ? 5 : 3, ...o });

/** §6-4 형식표. 화면·타이머·채점 메시지는 숫자를 다시 적지 말고 이 표를 읽는다. */
export const TOEIC_MOCK_FORMAT: readonly ToeicQuestionFormat[] = [
  F(1, "read", 0, { readingSec: 0, questionPlays: 0, speakIntro: false, prepSec: 45, answerSec: 45, showQuestionText: false }),
  F(2, "read", 1, { readingSec: 0, questionPlays: 0, speakIntro: false, prepSec: 45, answerSec: 45, showQuestionText: false }),
  F(3, "picture", 0, { readingSec: 0, questionPlays: 0, speakIntro: false, prepSec: 45, answerSec: 30, showQuestionText: false }),
  F(4, "picture", 1, { readingSec: 0, questionPlays: 0, speakIntro: false, prepSec: 45, answerSec: 30, showQuestionText: false }),
  F(5, "respond", 0, { readingSec: 0, questionPlays: 1, speakIntro: true, prepSec: 3, answerSec: 15, showQuestionText: true }),
  F(6, "respond", 1, { readingSec: 0, questionPlays: 1, speakIntro: false, prepSec: 3, answerSec: 15, showQuestionText: true }),
  F(7, "respond", 2, { readingSec: 0, questionPlays: 1, speakIntro: false, prepSec: 3, answerSec: 30, showQuestionText: true }),
  F(8, "info", 0, { readingSec: 45, questionPlays: 1, speakIntro: true, prepSec: 3, answerSec: 15, showQuestionText: false }),
  F(9, "info", 1, { readingSec: 0, questionPlays: 1, speakIntro: false, prepSec: 3, answerSec: 15, showQuestionText: false }),
  F(10, "info", 2, { readingSec: 0, questionPlays: 2, speakIntro: false, prepSec: 3, answerSec: 30, showQuestionText: false }),
  F(11, "opinion", 0, { readingSec: 0, questionPlays: 1, speakIntro: false, prepSec: 45, answerSec: 60, showQuestionText: true }),
];

/** 문항 번호의 형식. 1..11 밖이면 throw(프로그램 오류). */
export function toeicQuestionFormat(q: number): ToeicQuestionFormat {
  const f = TOEIC_MOCK_FORMAT.find((x) => x.q === q);
  if (!f) throw new Error(`[toeic-mock] 문항 번호는 1~${TOEIC_QUESTION_COUNT}이어야 합니다: ${q}`);
  return f;
}

/** 파트 → 문항 번호들(오름차순) */
export function toeicPartQuestions(part: ToeicMockPart): number[] {
  return TOEIC_MOCK_FORMAT.filter((f) => f.part === part).map((f) => f.q);
}

/** 응시할 파트들 → 문항 번호들(형식표 순서). 실전은 5개 파트 전부, 유형 연습은 하나(scope:"part"). */
export function toeicQuestionsForParts(parts: readonly ToeicMockPart[]): number[] {
  const set = new Set(parts);
  return TOEIC_MOCK_FORMAT.filter((f) => set.has(f.part)).map((f) => f.q);
}

/** 만점 — Q11=5, 나머지 3(§5-3) */
export function toeicMaxScore(q: number): 3 | 5 {
  return toeicQuestionFormat(q).maxScore;
}

/** 완전한 11문항 세트 = 다섯 파트가 모두 non-null(§7-2) */
export function isCompleteToeicMock(parts: Record<ToeicMockPart, unknown | null>): boolean {
  return TOEIC_MOCK_PARTS.every((p) => parts[p] !== null && parts[p] !== undefined);
}

/** 모의고사 기본 제목(§7-2 "모의고사 {n}") */
export function defaultToeicMockTitle(n: number): string {
  return `모의고사 ${n}`;
}

// ---------------------------------------------------------------------------
// 파트 지시문 — 이 앱의 문장(ETS 원문 아님). 숫자는 형식표에서 계산한다.
// ---------------------------------------------------------------------------

/** 지시문을 읽는 언어 — 시험처럼 영어로 읽고 한국어는 화면 보조 문구로 쓴다(lang은 항상 명시, §6-1 소리 규칙) */
export const TOEIC_DIRECTIONS_LANG = "en-US" as const;

const COUNT_EN: Record<number, string> = { 1: "One", 2: "Two", 3: "Three" };

function partFormats(part: ToeicMockPart): ToeicQuestionFormat[] {
  return TOEIC_MOCK_FORMAT.filter((f) => f.part === part);
}

function buildDirections(): Record<ToeicMockPart, { en: string; ko: string }> {
  const read = partFormats("read");
  const pic = partFormats("picture");
  const res = partFormats("respond");
  const inf = partFormats("info");
  const op = partFormats("opinion")[0];
  const last = <T,>(a: T[]): T => a[a.length - 1];
  return {
    read: {
      en: `Reading aloud. ${COUNT_EN[read.length]} short texts will appear one at a time. Look over each text for ${read[0].prepSec} seconds, then read it out loud in ${read[0].answerSec} seconds.`,
      ko: `지문 읽기. 짧은 지문 ${read.length}개가 하나씩 나와요. 지문마다 ${read[0].prepSec}초 동안 훑어본 뒤, ${read[0].answerSec}초 동안 소리 내어 읽으세요.`,
    },
    picture: {
      en: `Describing a picture. ${COUNT_EN[pic.length]} photos will appear one at a time. Study each photo for ${pic[0].prepSec} seconds, then talk about it for ${pic[0].answerSec} seconds.`,
      ko: `사진 묘사. 사진 ${pic.length}장이 한 장씩 나와요. 사진마다 ${pic[0].prepSec}초 동안 살펴본 뒤, ${pic[0].answerSec}초 동안 묘사하세요.`,
    },
    respond: {
      en: `Answering questions. Picture yourself in the situation on the screen. After each question you hear, you get ${res[0].prepSec} seconds to get ready. Answer the first two in ${res[0].answerSec} seconds each and the last one in ${last(res).answerSec} seconds.`,
      ko: `듣고 답하기. 화면의 상황에 있다고 생각하고 질문 ${res.length}개에 답하세요. 질문을 들은 뒤 ${res[0].prepSec}초 준비하고, 앞의 두 질문은 ${res[0].answerSec}초, 마지막 질문은 ${last(res).answerSec}초 동안 답하세요.`,
    },
    info: {
      en: `Answering with the table. First, look over the table for ${inf[0].readingSec} seconds. Then a caller will ask you ${COUNT_EN[inf.length].toLowerCase()} questions about it. After each one, you get ${inf[0].prepSec} seconds to get ready. Answer the first two in ${inf[0].answerSec} seconds each and the last one in ${last(inf).answerSec} seconds. You will hear the last question ${last(inf).questionPlays === 2 ? "twice" : "once"}.`,
      ko: `정보 활용. 먼저 ${inf[0].readingSec}초 동안 표를 살펴보세요. 이어서 전화한 사람이 표에 대해 ${inf.length}가지를 묻습니다. 질문마다 ${inf[0].prepSec}초 준비하고, 앞의 두 질문은 ${inf[0].answerSec}초, 마지막 질문은 ${last(inf).answerSec}초 동안 답하세요. 마지막 질문은 ${last(inf).questionPlays}번 들려줘요.`,
    },
    opinion: {
      en: `Giving your opinion. Take a clear position on the question, and back it up with reasons and examples. You get ${op.prepSec} seconds to prepare and ${op.answerSec} seconds to speak.`,
      ko: `의견 말하기. 질문에 대한 입장을 분명히 정하고 이유와 예시로 뒷받침하세요. ${op.prepSec}초 준비하고 ${op.answerSec}초 동안 말하세요.`,
    },
  };
}

/** 파트 지시문(§6-4) — 파트마다 한 번만 정의. en은 읽기용(TOEIC_DIRECTIONS_LANG), ko는 화면 보조 문구 */
export const TOEIC_PART_DIRECTIONS: Record<ToeicMockPart, { en: string; ko: string }> = buildDirections();

// ---------------------------------------------------------------------------
// 단계 전이 (§6-4) — directions(파트 첫 문항만) → reading(Q8 앞만) → question(음성 × 재생 횟수) → prep → beep → answer
// ---------------------------------------------------------------------------

export type ToeicMockPhase = "directions" | "reading" | "question" | "prep" | "beep" | "answer" | "done";

export interface ToeicPhaseState {
  /** 이번 응시 문항 목록(qs) 안의 위치. done이면 qs.length */
  index: number;
  /** 문항 번호 1..11. done이면 null */
  q: number | null;
  phase: ToeicMockPhase;
  /** question 단계의 몇 번째 재생인가(0부터). 다른 단계는 0 */
  play: number;
  /**
   * 시간이 정해진 단계(reading·prep·answer)의 종료 시각(epoch ms). 그 밖(음성·비프가 끝나면 넘어가는 단계)은 null.
   * answer는 nextPhase가 null로 두고, 녹음 `start` 이벤트에서 beginAnswer가 매긴다(답변 타이머는 녹음 시작부터).
   */
  endsAt: number | null;
}

interface Step {
  phase: Exclude<ToeicMockPhase, "done">;
  play: number;
}

function stepsFor(q: number): Step[] {
  const f = toeicQuestionFormat(q);
  const steps: Step[] = [];
  if (f.directions) steps.push({ phase: "directions", play: 0 });
  if (f.readingSec > 0) steps.push({ phase: "reading", play: 0 });
  for (let p = 0; p < f.questionPlays; p++) steps.push({ phase: "question", play: p });
  steps.push({ phase: "prep", play: 0 }, { phase: "beep", play: 0 }, { phase: "answer", play: 0 });
  return steps;
}

function enter(qs: readonly number[], index: number, step: Step, nowMs: number): ToeicPhaseState {
  const q = qs[index];
  const f = toeicQuestionFormat(q);
  let endsAt: number | null = null;
  if (step.phase === "reading") endsAt = nowMs + f.readingSec * 1000;
  else if (step.phase === "prep") endsAt = nowMs + f.prepSec * 1000;
  return { index, q, phase: step.phase, play: step.play, endsAt };
}

function done(qs: readonly number[]): ToeicPhaseState {
  return { index: qs.length, q: null, phase: "done", play: 0, endsAt: null };
}

/** 응시 첫 단계. qs가 비면 done. */
export function firstPhase(qs: readonly number[], nowMs: number): ToeicPhaseState {
  if (qs.length === 0) return done(qs);
  return enter(qs, 0, stepsFor(qs[0])[0], nowMs);
}

/**
 * 다음 단계. 시간이 정해진 단계는 종료 시각이 지났을 때, 나머지는 음성·비프·녹음이 끝났을 때 화면이 부른다.
 * 마지막 문항의 answer 다음은 done. done에서 부르면 done 그대로.
 */
export function nextPhase(qs: readonly number[], state: ToeicPhaseState, nowMs: number): ToeicPhaseState {
  if (state.phase === "done" || state.q === null) return done(qs);
  const steps = stepsFor(state.q);
  const at = steps.findIndex((s) => s.phase === state.phase && s.play === state.play);
  if (at >= 0 && at + 1 < steps.length) return enter(qs, state.index, steps[at + 1], nowMs);
  const nextIndex = state.index + 1;
  if (nextIndex >= qs.length) return done(qs);
  return enter(qs, nextIndex, stepsFor(qs[nextIndex])[0], nowMs);
}

/** 녹음이 실제로 시작된 시각에 답변 타이머를 건다(answer 단계가 아니면 그대로). */
export function beginAnswer(state: ToeicPhaseState, startedAtMs: number): ToeicPhaseState {
  if (state.phase !== "answer" || state.q === null) return state;
  return { ...state, endsAt: startedAtMs + toeicQuestionFormat(state.q).answerSec * 1000 };
}

/** 남은 시간(ms). 시간이 정해지지 않은 단계는 null, 지나면 0. */
export function remainingMs(state: ToeicPhaseState, nowMs: number): number | null {
  if (state.endsAt === null) return null;
  return Math.max(0, state.endsAt - nowMs);
}

/** 남은 시간(초, 올림) — 화면 표시용. */
export function remainingSec(state: ToeicPhaseState, nowMs: number): number | null {
  const ms = remainingMs(state, nowMs);
  return ms === null ? null : Math.ceil(ms / 1000);
}

/** 시간이 정해진 단계의 종료 시각이 지났는가 */
export function isPhaseExpired(state: ToeicPhaseState, nowMs: number): boolean {
  return state.endsAt !== null && nowMs >= state.endsAt;
}

/**
 * 지시문·질문 음성 큐가 끝났을 때 다음 단계로 갈지, 멈추고 "다시 듣기"/"질문 보기"를 띄울지(§6-4 안전망 — QA m2 P2-A).
 * speakQueue는 무음 조각이 **연속 3개**여야 "stopped"라, 1~2조각인 토익 질문 큐는 전부 무음(클라우드 불가 + 기기 음성 오류)이어도
 * "done"으로 끝난다. 그래서 onEnd 둘째 인자 `sounded`(소리를 낸 조각 수, lib/speech SpeakQueueEndInfo)로 다시 판정한다.
 * - "stopped"(외부 pause·연속 무음) → pause
 * - 질문: 한 조각이라도 소리를 못 냈으면 pause — Q5·Q8은 도입 + 질문 두 조각이라 "도입만 들리고 질문은 무음"도 막는다
 *   (Q8–10은 평소 질문 글을 숨겨, 못 들으면 답할 근거가 없다)
 * - 지시문: 한 조각도 소리를 못 냈을 때만 pause(한국어 캡션이 함께 보이고, 형식은 파트마다 같다)
 * 조각이 없으면(빈 큐) advance — 화면은 빈 큐를 speakQueue에 넘기지 않고 바로 넘어간다.
 */
export function toeicSpeechOutcome(
  kind: "directions" | "question",
  reason: "done" | "stopped",
  sounded: number,
  pieceCount: number,
): "advance" | "pause" {
  if (reason !== "done") return "pause";
  if (pieceCount <= 0) return "advance";
  if (kind === "question") return sounded < pieceCount ? "pause" : "advance";
  return sounded <= 0 ? "pause" : "advance";
}

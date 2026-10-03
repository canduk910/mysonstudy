/**
 * 모의고사 응시 화면의 **시험 창 표현**(실제 시험 화면 모양 — docs/harness/toeic.md §17, SPEC §20-15) — 순수 함수.
 *
 * 응시 화면(components/toeic-take-view.tsx)의 상태 기계·타이밍·녹음·음성은 그대로 두고, 지금 단계(ToeicPhaseState)를 시험 창의
 * 화면 종류·머리 띠 문구·타이머 상자로 옮기는 규칙만 여기 한 곳에 둔다(화면은 판단하지 않는다 — eval-toeic-exam-screen이 잠근다).
 *
 * - 화면 종류: 안내(베이지 — 파트 지시문) · 상황(Q5–7 상황 소개를 읽는 동안 상황 문장만) · 문제(밝은 회색 — 지문·사진·질문·표).
 * - 머리 띠 가운데: 문제 화면만 "Question 3 of 11", 정보 활용은 파트 내내 "Questions 8-10 of 11". 안내·상황 화면은 비운다.
 * - 타이머 상자: 표 읽기(Q8 앞)는 PREPARATION TIME 하나(읽기 시간), 그 밖 문제 화면은 PREPARATION·RESPONSE 둘.
 *   진행 중인 쪽만 줄고(종료 시각 기준 남은 시간), 아닌 쪽은 원래 시간 — 준비가 끝난 뒤(비프·답변)의 준비 상자는 0.
 *   종료 시각이 없는 동안(진행 멘트를 읽는 중·답변 녹음이 아직 시작 전·마이크 다시 켜기 대기)은 원래 시간 그대로다.
 *   진행 중 상자는 형식표 시간을 넘지 않는다(시계를 막 세운 순간의 한 틱 — QA P3-2).
 * - 숫자는 형식표(lib/toeic-mock TOEIC_MOCK_FORMAT)에서만 읽는다. 문구는 파트 공식 유형명(영어)뿐 — 교재 문장은 없다.
 *
 * 클라이언트 번들 — lib/toeic-mock만 import한다(lib/ai·store·zod 없음).
 */

import {
  TOEIC_QUESTION_COUNT,
  toeicPartQuestions,
  toeicQuestionFormat,
  type ToeicMockPart,
  type ToeicPhaseState,
} from "./toeic-mock";

/** 파트 공식 유형명(영어) — 안내 화면 제목·시작 안내 목록 */
export const TOEIC_EXAM_PART_TYPE_EN: Record<ToeicMockPart, string> = {
  read: "Read a text aloud",
  picture: "Describe a picture",
  respond: "Respond to questions",
  info: "Respond to questions using information provided",
  opinion: "Express an opinion",
};

/** 문항 범위 표기 — 하나면 "Question 3", 여럿이면 "Questions 3-4"(형식표 순서의 처음·끝) */
function rangeLabel(qs: readonly number[]): string {
  if (qs.length === 0) return "";
  const sorted = [...qs].sort((a, b) => a - b);
  return sorted.length === 1 ? `Question ${sorted[0]}` : `Questions ${sorted[0]}-${sorted[sorted.length - 1]}`;
}

/** 파트 전체 범위("Questions 1-2" …) — 시작 안내 목록 */
export function toeicExamPartRange(part: ToeicMockPart): string {
  return rangeLabel(toeicPartQuestions(part));
}

/**
 * 안내 화면 제목 — "Questions 1-2: Read a text aloud". 범위는 **이번 응시**에서 그 파트 문항(사진 1장 연습·Q3만 다시 풀기면
 * "Question 3: Describe a picture") — 읽는 지시문(toeicPartDirections(part, count))과 같은 개수를 본다.
 */
export function toeicExamDirectionsTitle(part: ToeicMockPart, attemptQs: readonly number[]): string {
  const inPart = attemptQs.filter((q) => toeicQuestionFormat(q).part === part);
  return `${rangeLabel(inPart.length > 0 ? inPart : toeicPartQuestions(part))}: ${TOEIC_EXAM_PART_TYPE_EN[part]}`;
}

/** 문제 화면 머리 띠 가운데 — "Question 3 of 11" · 정보 활용은 파트 내내 "Questions 8-10 of 11" */
export function toeicExamBandTitle(q: number): string {
  const f = toeicQuestionFormat(q);
  if (f.part === "info") return `${toeicExamPartRange("info")} of ${TOEIC_QUESTION_COUNT}`;
  return `Question ${q} of ${TOEIC_QUESTION_COUNT}`;
}

export type ToeicExamScreen = "directions" | "situation" | "question";

/**
 * 단계 → 화면 종류.
 * - directions(파트 지시문) → 안내 화면
 * - 듣고 답하기에서 상황 소개를 읽는 문항(형식표 speakIntro — Q5)의 첫 질문 재생 중 **상황 소개 조각을 읽는 동안** → 상황 화면
 *   (상황 문장만, 머리 띠 번호 없음).
 *   `speakingIndex`는 질문 큐에서 지금 읽는 조각(시작 전 -1), `introPieces`는 큐 앞쪽 상황 소개 조각 수.
 *   멈춤(소리 못 냄 안전망)이면 문제 화면 — "질문 보기"·"다시 듣기"가 문제 화면에서 돈다.
 * - 그 밖(표 읽기·질문·준비·비프·답변) → 문제 화면
 */
export function toeicExamScreenOf(
  st: Pick<ToeicPhaseState, "phase" | "q" | "play">,
  o: { introPieces: number; speakingIndex: number; paused: boolean },
): ToeicExamScreen {
  if (st.phase === "directions") return "directions";
  if (
    st.phase === "question" &&
    st.q !== null &&
    st.play === 0 &&
    toeicQuestionFormat(st.q).part === "respond" &&
    toeicQuestionFormat(st.q).speakIntro &&
    o.introPieces > 0 &&
    o.speakingIndex < o.introPieces &&
    !o.paused
  ) {
    return "situation";
  }
  return "question";
}

export type ToeicExamTimerLabel = "PREPARATION TIME" | "RESPONSE TIME";
export interface ToeicExamTimerBox {
  label: ToeicExamTimerLabel;
  /** 상자에 보일 시간(ms) */
  ms: number;
  /** 지금 줄고 있는 상자인가 */
  running: boolean;
}

/**
 * 문제 화면의 타이머 상자. 안내·끝 단계는 빈 배열.
 * - reading(표 읽기) → [PREPARATION TIME = 읽기 시간]
 * - 그 밖 → [PREPARATION TIME, RESPONSE TIME]
 */
export function toeicExamTimers(st: ToeicPhaseState, nowMs: number): ToeicExamTimerBox[] {
  if (st.q === null || st.phase === "directions" || st.phase === "done") return [];
  const f = toeicQuestionFormat(st.q);
  const left = st.endsAt === null ? null : Math.max(0, st.endsAt - nowMs);
  // 진행 중 상자는 형식표 시간을 넘지 않는다 — 화면의 "지금"은 마지막 틱(최대 250ms 전)이라 시계를 막 세운 순간
  // ceil((종료 − 지금)/1000)이 한 칸 크게("00:00:16") 보이던 것(QA realtest-print 1 P3-2)
  const capped = (fullMs: number) => (left === null ? fullMs : Math.min(fullMs, left));
  if (st.phase === "reading") {
    return [{ label: "PREPARATION TIME", ms: capped(f.readingSec * 1000), running: left !== null }];
  }
  const prepRunning = st.phase === "prep" && left !== null;
  const prepMs = st.phase === "prep" ? capped(f.prepSec * 1000) : st.phase === "beep" || st.phase === "answer" ? 0 : f.prepSec * 1000;
  const respRunning = st.phase === "answer" && left !== null;
  const respMs = respRunning ? capped(f.answerSec * 1000) : f.answerSec * 1000;
  return [
    { label: "PREPARATION TIME", ms: prepMs, running: prepRunning },
    { label: "RESPONSE TIME", ms: respMs, running: respRunning },
  ];
}

/** 시험 타이머 표기 "00:00:45" — 초는 올림(남은 0.2초도 1초로), 음수는 0 */
export function formatToeicExamClock(ms: number): string {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** 시작 안내(실전 전체 응시) — 파트별 평가 항목. 문장은 이 앱의 말(공개된 채점 항목을 우리 말투로) */
export const TOEIC_EXAM_CRITERIA_EN: Record<ToeicMockPart, string> = {
  read: "Scored on: pronunciation, intonation, and stress",
  picture: "Scored on: everything above, plus grammar, vocabulary, and how well your ideas connect",
  respond: "Scored on: everything above, plus how relevant and complete your answers are",
  info: "Scored on: everything above",
  opinion: "Scored on: everything above",
};

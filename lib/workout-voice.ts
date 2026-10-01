/**
 * lib/workout-voice.ts — 아빠의 운동 세션 **음성 안내 계획** (SPEC §19-6 "음성 안내", 2026-10-01). 순수 함수 — AI·저장·브라우저 없음.
 *
 * 사용자 신고(2026-10-01): "운동할 때 풀업 시작할 때만 음성이 나와. 음성안내가 좀더 촘촘했으면 해." 예전 설계는 휴식이 끝날 때만
 * 읽어서(휴식은 세트 사이에만 → 2~5세트 풀업 4번) 그 밖의 순간은 조용했다. 지금은 **세트 시작마다**(✓ 직후·휴식 끝·건너뛰기),
 * **휴식 카운트다운**(30초·10초·셋·둘·하나), **진행 상황·격려**(절반·마지막 라운드·마지막 세트·돌려 쓰는 격려),
 * **시작·완료 요약**(그날 총합·소요시간·엔진이 준 내일)을 읽는다.
 *
 * - **무엇을 언제 읽을지의 정의처는 이 파일 하나다.** 화면(components/workout-view.tsx·workout-session.tsx)은 사건이 날 때
 *   `workoutVoiceLines`가 준 조각 배열을 그대로 `speakQueue`에 넣고, 카운트다운 시각은 `restCuePlan`이, 미리 받을 목록은
 *   `workoutVoicePrefetch`가 정한다. 화면에 문구를 두면 eval이 import하지 못해 옛 규칙으로 되돌려도 통과한다(2026-09-25 QA F3 교훈).
 * - **조각 하나 = 큐 항목 하나.** 날마다 같은 고정 조각(격려·진행·카운트다운·휴식 시작)은 발음 관문의 영속 캐시(§16-5)에 한 번만
 *   합성된다. 휴식 끝 문구는 옛 형식(`다음, 풀업 2세트 5회`) 그대로 둔다 — 이미 캐시된 오디오를 다시 쓴다.
 * - **결정적이다**(같은 입력 = 같은 출력). 격려는 `(슬롯 day + step) % 5`로 돌려 쓴다 — 무작위 금지(eval 재현성).
 * - 런타임 의존은 순수 엔진 `./workout`뿐 — 클라이언트 번들·eval이 그대로 import한다(store·speech·브라우저 의존 금지).
 *   발음 관문 상수(`PREFETCH_MAX_ITEMS`)도 import하지 않는다 — 상한은 `prefetchSpeech`가 자르고, eval이 그 상수와 대조한다.
 * - 운동·세트 이름(`풀업 1세트`)도 여기가 정의처다 — 화면 글자와 음성 안내가 같은 이름을 쓰게(components/workout-shared가 재수출).
 */

import {
  DEFAULT_REST_SEC,
  isValidDurationSec,
  restFollowsStep,
  setTotals,
  SETS_PER_EXERCISE,
  stepsAfterRest,
  supersetSteps,
  type SetPair,
  type Upcoming,
  type WorkoutExercise,
  type WorkoutStep,
} from "./workout";

// ===========================================================================
// 상수
// ===========================================================================

/** 음성 안내 언어 — 한국어(발음 관문의 기본 엔진은 클라우드, 키가 없거나 실패하면 기기 음성 — §16-2) */
export const WORKOUT_VOICE_LANG = "ko-KR";

/** 슈퍼세트 스텝 수(풀업 5 + 푸시업 5)와 마지막 스텝 — 엔진 supersetSteps와 같은 규칙 */
const TOTAL_STEPS = SETS_PER_EXERCISE * 2;
const LAST_STEP = TOTAL_STEPS - 1;
const LAST_SET_INDEX = SETS_PER_EXERCISE - 1;

/**
 * 휴식 길이 선택지(초) — 세션의 2분/3분 버튼이 이 값을 쓰고, 미리 받기가 두 길이의 휴식 시작 안내를 함께 받는다(정의처 하나).
 * 기본은 엔진 상수 DEFAULT_REST_SEC(근사 소요시간의 "쉰 휴식 한 번"과 같은 값, §19-8).
 */
export const WORKOUT_REST_PRESET_SEC: readonly number[] = [DEFAULT_REST_SEC, 180];

/** 세트를 끝낼 때 돌려 쓰는 격려 — `(day + step) % 길이`(결정적) */
export const WORKOUT_ENCOURAGEMENTS: readonly string[] = ["좋아요!", "잘했어요!", "훌륭해요!", "멋져요!", "깔끔해요!"];

/** 진행 상황 — 10세트 중 5세트째를 끝낸 순간 */
export const VOICE_HALF = "절반 끝났어요.";
/** 진행 상황 — 5세트(마지막 라운드)가 시작되는 순간(5세트 풀업) */
export const VOICE_LAST_ROUND = "마지막 라운드예요.";
/** 그날 마지막 세트(5세트 푸시업)가 시작되는 순간 */
export const VOICE_LAST_SET = "마지막 세트예요.";
/** 이어서 하기 — 첫 조각 */
export const VOICE_RESUME = "이어서 할게요.";
/** 이어서 하기 — 쉬는 중이었다(카운트다운은 남은 휴식 기준으로 이어진다) */
export const VOICE_RESTING = "휴식 중이에요.";
/** 오늘 완료 — 첫 조각 */
export const VOICE_DONE = "오늘 운동 완료!";

/** 휴식 카운트다운 큐 — 남은 초와 문구. 3·2·1은 고유어(숫자 한 글자만 있는 조각은 문맥이 없어 영어로 읽힐 수 있다) */
export const REST_CUES: readonly { sec: number; text: string }[] = [
  { sec: 30, text: "30초 남았어요." },
  { sec: 10, text: "10초." },
  { sec: 3, text: "셋" },
  { sec: 2, text: "둘" },
  { sec: 1, text: "하나" },
];
/** 3·2·1 묶음 — 첫 큐(셋)가 빠지면 묶음째 뺀다(반쪽 카운트다운을 내지 않는다) */
const COUNTDOWN_GROUP_MAX_SEC = 3;
/**
 * 큐는 그 시각이 계획 시점보다 이만큼 이상 뒤일 때만 낸다 — 휴식 시작 안내(격려 + "휴식 2분.")와 겹치지 않고, 짧게 남은 휴식은
 * 앞 큐를 건너뛴다(§19-6 카운트다운 생략 규칙).
 */
export const REST_CUE_LEAD_MS = 4_000;
/** 타이머가 큐 시각보다 이만큼 넘게 늦게 깨면(백그라운드 스로틀·화면 잠금) 그 큐는 버린다 — 늦은 카운트다운을 몰아서 읽지 않는다 */
export const REST_CUE_STALE_MS = 1_500;

// ===========================================================================
// 타입
// ===========================================================================

/** 안내 계획의 입력 — 그날 세션이 아는 값(전부 서버 스냅샷에서 온다) */
export interface WorkoutVoiceContext {
  /** 슬롯 Day */
  day: number;
  /** 목표 Day — 재부여면 직전 성공 Day */
  targetDay: number;
  isRepeat: boolean;
  target: SetPair;
  /** 오늘 성공을 가정한 내일(엔진 `snapshot().upcoming[0]`, KST 내일일 때만) — 모르면 null(그 조각을 뺀다 — 스펙 밖 종류도, tomorrowLine) */
  tomorrow: Upcoming | null;
}

/** 음성 안내 사건 — 카운트다운은 시각이 붙어 따로(`restCuePlan`) */
export type WorkoutVoiceEvent =
  /** ▶ 운동 시작(저장된 진행 없음, 또는 0스텝·쉬는 중 아님) */
  | { kind: "session_start" }
  /** ▶ 이어서 하기 — step = 이어질 스텝, resting = 아직 쉬는 중 */
  | { kind: "session_resume"; step: number; resting: boolean }
  /** ✓ — step = 방금 끝낸 스텝(0..8; 마지막 스텝은 session_done), restSec = 지금 고른 휴식 길이(휴식이 시작될 때만 읽는다) */
  | { kind: "step_done"; step: number; restSec: number }
  /** 휴식 끝(타이머) 또는 건너뛰기 — step = 휴식 뒤 스텝(2·4·6·8) */
  | { kind: "rest_end"; step: number }
  /** 마지막 ✓ — 실측 소요시간(초, §19-8). 모르면 null(그 조각을 뺀다) */
  | { kind: "session_done"; durationSec: number | null };

/** 카운트다운 큐 하나 — at = 낼 시각(epoch ms) */
export interface RestCue {
  at: number;
  sec: number;
  text: string;
}

// ===========================================================================
// 이름·숫자 — 화면과 음성이 같은 이름을 쓴다
// ===========================================================================

export function exerciseKo(e: WorkoutExercise): string {
  return e === "pullup" ? "풀업" : "푸시업";
}

/**
 * 슈퍼세트 한 스텝의 이름 — `풀업 1세트`. 세트 번호는 곧 라운드 번호다(한 세트 = 풀업 + 푸시업, 휴식은 세트 사이 — §19-1).
 * 세션 무대 제목·실패 제목·"이어서 하기" 버튼·음성 안내가 같은 이름을 쓴다.
 */
export function stepName(st: WorkoutStep): string {
  return `${exerciseKo(st.exercise)} ${st.setIndex + 1}세트`;
}

/** 초 → TTS가 자연스럽게 읽는 꼴 — `2분`·`3분`·`2분 30초`·`45초`(정수로 반올림, 음수·비숫자는 0) */
export function spokenSeconds(sec: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/**
 * 소요시간(초) → `14분`(분 반올림), 1분 미만은 `45초`, 반올림해 60분 이상이면 `1시간`·`1시간 5분`(3570초부터 — §19-6 오늘 완료).
 * 말로는 초까지 읽지 않는다.
 */
export function spokenDuration(sec: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  if (total < 60) return `${total}초`;
  const minutes = Math.round(total / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

// ===========================================================================
// 조각 만들기
// ===========================================================================

/** 격려 — `(슬롯 day + step) % 5`(재부여 날도 슬롯 Day — Day 7 ← Day 5 목표면 7, §19-6). 이웃 스텝끼리 다르고, 같은 입력이면 언제나 같다 */
export function encouragement(day: number, step: number): string {
  const n = WORKOUT_ENCOURAGEMENTS.length;
  const i = (((Math.trunc(day) + Math.trunc(step)) % n) + n) % n;
  return WORKOUT_ENCOURAGEMENTS[Number.isFinite(i) ? i : 0];
}

/** 세트 시작 뒤에 붙는 진행 조각 — 5세트 풀업이면 "마지막 라운드", 5세트 푸시업이면 "마지막 세트"(한 스텝에 둘을 겹치지 않는다) */
function setStartSuffix(st: WorkoutStep): string[] {
  if (st.setIndex !== LAST_SET_INDEX) return [];
  return st.exercise === "pullup" ? [VOICE_LAST_ROUND] : [VOICE_LAST_SET];
}

/** 세트 시작 — `푸시업 1세트, 9회.` (+ 마지막 라운드·마지막 세트) */
export function setStartLines(st: WorkoutStep): string[] {
  return [`${stepName(st)}, ${st.reps}회.`, ...setStartSuffix(st)];
}

/** 휴식 끝 문구 — `다음, 풀업 2세트 7회`(옛 형식 그대로 — 영속 캐시에 있는 오디오를 다시 쓴다) */
export function restEndPhrase(st: WorkoutStep): string {
  return `다음, ${stepName(st)} ${st.reps}회`;
}

/** 휴식 끝(타이머)·건너뛰기 — 옛 문구 + 마지막 라운드 */
export function restEndLines(st: WorkoutStep): string[] {
  return [restEndPhrase(st), ...setStartSuffix(st)];
}

/** 그날 요약 — `Day 1, 풀업 5세트 총 20회, 푸시업 5세트 총 35회.` (재부여면 `Day 7, Day 5 목표로 한 번. 풀업 …`) */
export function summaryLine(ctx: WorkoutVoiceContext): string {
  const t = setTotals(ctx.target);
  const sets = `풀업 ${SETS_PER_EXERCISE}세트 총 ${t.pullup}회, 푸시업 ${SETS_PER_EXERCISE}세트 총 ${t.pushup}회.`;
  return ctx.isRepeat ? `Day ${ctx.day}, Day ${ctx.targetDay} 목표로 한 번. ${sets}` : `Day ${ctx.day}, ${sets}`;
}

/**
 * 내일 — 엔진이 준 Upcoming을 말로. 재부여를 성공한 날의 내일(같은 Day)은 "재도전". 스펙(§19-6 "내일")의 문구는 넷뿐이다 —
 * 운동·재도전·휴식·마무리 휴식. 오늘 성공을 가정한 내일로는 나오지 않는 것(회복·재측정·재부여 목표 운동 — 실패 뒤에만 생긴다)은
 * null(그 조각을 뺀다 — "모르면 뺀다"와 같은 규칙). 스펙 밖 문구를 미리 받기·영속 캐시에 들이지 않는다.
 */
export function tomorrowLine(ctx: Pick<WorkoutVoiceContext, "day" | "isRepeat">, u: Upcoming): string | null {
  switch (u.kind) {
    case "workout":
      if (u.targetDay !== u.day) return null;
      return ctx.isRepeat && u.day === ctx.day ? `내일은 Day ${u.day} 재도전이에요.` : `내일은 Day ${u.day} 운동이에요.`;
    case "rest":
      return u.cycleEnd ? "내일은 사이클 마무리 휴식이에요." : "내일은 휴식이에요.";
    case "recovery":
    case "retest":
      return null;
  }
}

/**
 * ▶ 탭이 어느 사건인가 — 저장된 진행이 없거나 0스텝·쉬는 중 아님이면 세션 시작(아직 한 세트도 안 했다), 아니면 이어서 하기.
 * saved = 복원될 진행(readSavedSession이 맞다고 본 값)에서 이어질 스텝과 "아직 쉬는 중인가".
 */
export function sessionOpenEvent(saved: { step: number; resting: boolean } | null): WorkoutVoiceEvent {
  if (!saved || (saved.step <= 0 && !saved.resting)) return { kind: "session_start" };
  return { kind: "session_resume", step: saved.step, resting: saved.resting };
}

/**
 * 사건 하나에 읽을 조각 — 화면은 이 배열을 그대로 `speakQueue`에 넣는다(조각 = 큐 항목). 범위 밖 스텝·마지막 스텝의 step_done은 []
 * (오늘 완료는 session_done이 대신한다). 던지지 않는다.
 */
export function workoutVoiceLines(ctx: WorkoutVoiceContext, ev: WorkoutVoiceEvent): string[] {
  const steps = supersetSteps(ctx.target);
  switch (ev.kind) {
    case "session_start":
      return [summaryLine(ctx), ...setStartLines(steps[0])];
    case "session_resume": {
      if (ev.resting) return [VOICE_RESUME, VOICE_RESTING];
      const st = steps[ev.step];
      return st ? [VOICE_RESUME, ...setStartLines(st)] : [VOICE_RESUME];
    }
    case "step_done": {
      const k = ev.step;
      if (!Number.isInteger(k) || k < 0 || k >= LAST_STEP) return [];
      const out = [encouragement(ctx.day, k)];
      if (k + 1 === TOTAL_STEPS / 2) out.push(VOICE_HALF);
      if (restFollowsStep(k)) out.push(`휴식 ${spokenSeconds(ev.restSec)}.`);
      else out.push(...setStartLines(steps[k + 1]));
      return out;
    }
    case "rest_end": {
      const st = steps[ev.step];
      return st ? restEndLines(st) : [];
    }
    case "session_done": {
      const t = setTotals(ctx.target);
      const out = [VOICE_DONE, `총 ${t.pullup + t.pushup}회.`];
      if (ev.durationSec !== null && isValidDurationSec(ev.durationSec)) out.push(`${spokenDuration(ev.durationSec)} 걸렸어요.`);
      const tomorrow = ctx.tomorrow ? tomorrowLine(ctx, ctx.tomorrow) : null;
      if (tomorrow !== null) out.push(tomorrow);
      return out;
    }
  }
}

// ===========================================================================
// 휴식 카운트다운
// ===========================================================================

/**
 * 휴식 카운트다운 계획 — 종료 시각(epoch ms)과 계획 시점(now)으로 낼 큐와 그 시각. 계획 시점 = 휴식 시작·휴식 길이 변경·+30초·
 * 새로고침 복원·음성 켬(화면은 종료 시각이 바뀔 때마다 다시 짠다).
 * - 큐마다 그 시각이 now보다 REST_CUE_LEAD_MS 이상 뒤일 때만 — 휴식 시작 안내와 겹치지 않고, 짧게 남은 휴식은 앞 큐를 건너뛴다.
 * - 셋·둘·하나는 한 묶음 — 셋이 빠지면 묶음째 뺀다. `하나`가 종료 1초 전이라 휴식 끝 안내(종료 시각)와 겹치지 않는다.
 */
export function restCuePlan(restEndsAt: number, now: number): RestCue[] {
  if (!Number.isFinite(restEndsAt) || !Number.isFinite(now)) return [];
  const fits = (sec: number) => restEndsAt - sec * 1000 - now >= REST_CUE_LEAD_MS;
  const countdownFits = fits(COUNTDOWN_GROUP_MAX_SEC);
  return REST_CUES.filter((c) => (c.sec <= COUNTDOWN_GROUP_MAX_SEC ? countdownFits : fits(c.sec))).map((c) => ({
    at: restEndsAt - c.sec * 1000,
    sec: c.sec,
    text: c.text,
  }));
}

/** 타이머가 큐 시각보다 REST_CUE_STALE_MS 넘게 늦게 깼는가 — 늦은 큐는 버린다 */
export function isRestCueStale(cueAt: number, firedAt: number): boolean {
  return !(firedAt - cueAt <= REST_CUE_STALE_MS);
}

// ===========================================================================
// 미리 받기
// ===========================================================================

/**
 * ▶ 탭에서 미리 받을 조각 — 그날 낼 수 있는 조각 전부를 **처음 쓰이는 순서로**, 중복 없이. 세션 시작 → ✓ 스텝 0~8(휴식 시작은
 * 두 길이 모두) → 카운트다운 → 휴식 끝 → 이어서 하기 → 오늘 완료(소요시간 조각 제외 — 그때 합성한다, 실패하면 기기 음성).
 * 상한(PREFETCH_MAX_ITEMS 90)은 prefetchSpeech가 자르고, eval이 이 목록이 그 안인지 대조한다.
 */
export function workoutVoicePrefetch(ctx: WorkoutVoiceContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (lines: readonly string[]) => {
    for (const raw of lines) {
      const text = raw.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  };
  add(workoutVoiceLines(ctx, { kind: "session_start" }));
  for (let k = 0; k < LAST_STEP; k++) {
    for (const restSec of restFollowsStep(k) ? WORKOUT_REST_PRESET_SEC : [DEFAULT_REST_SEC]) {
      add(workoutVoiceLines(ctx, { kind: "step_done", step: k, restSec }));
    }
  }
  add(REST_CUES.map((c) => c.text));
  for (const st of stepsAfterRest(ctx.target)) add(workoutVoiceLines(ctx, { kind: "rest_end", step: st.step }));
  add(workoutVoiceLines(ctx, { kind: "session_resume", step: 0, resting: true }));
  for (let k = 1; k <= LAST_STEP; k++) add(workoutVoiceLines(ctx, { kind: "session_resume", step: k, resting: false }));
  add(workoutVoiceLines(ctx, { kind: "session_done", durationSec: null }));
  return out;
}

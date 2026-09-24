/**
 * components/workout-shared.tsx — 아빠의 운동 화면(`workout-view`)·세션(`workout-session`)·RM 폼이 함께 쓰는 표시 보조 (SPEC §19-6).
 *
 * ⚠️ 여기서 **규칙을 다시 구현하지 않는다**(§19-2 "화면은 규칙을 다시 구현하지 않는다"). 하는 일은 엔진이 준 값
 * (`TodayStatus`·`Upcoming`·`SetPair`·`WorkoutEvent`)을 한국어 글자로 옮기는 것뿐이다. Day 계산·목표·스텝 순서는 전부
 * 순수 엔진 lib/workout.ts가 한다(클라이언트 번들 안전 — 런타임 의존성은 ./kst뿐).
 * 날짜는 KST 문자열(`YYYY-MM-DD`)만 받는다 — 표시용 요일도 그 문자열에서 결정적으로 뽑는다(렌더 중 "지금"을 읽지 않는다).
 */

import type { SetPair, Upcoming, WorkoutEvent, WorkoutExercise, WorkoutStep } from "@/lib/workout";
import { RETEST_DAY, setTotals, SETS_PER_EXERCISE } from "@/lib/workout";

/** 세션 상단·브리핑에 늘 보이는 주의사항(원안 3항, §19-6) */
export const WORKOUT_CAUTIONS = [
  "실패 지점까지 가지 마세요 — 한두 개 남기고 멈추기",
  "반동 없는 엄격한 정자세",
  "세트 사이 최소 2분 휴식",
] as const;

export function exerciseKo(e: WorkoutExercise): string {
  return e === "pullup" ? "풀업" : "푸시업";
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** `YYYY-MM-DD` → 요일 한 글자. 문자열에서 UTC 자정으로 계산(결정적 — 서버·클라이언트 같은 값) */
function weekdayKo(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  return WEEKDAY_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** `2026-09-25` → `9/25(금)` */
export function formatShortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  if (!m || !d) return date;
  const w = weekdayKo(date);
  return w ? `${m}/${d}(${w})` : `${m}/${d}`;
}

/** `2026-09-25` → `2026.09.25` (지난 사이클 시작일 — 연도까지) */
export function formatDotDate(date: string): string {
  return date.replace(/-/g, ".");
}

/** 사다리 한 줄 — `6·5·4·3·2` */
export function ladderText(arr: readonly number[]): string {
  return arr.join("·");
}

/** 앞으로의 하루(엔진 `Upcoming`)를 한 줄로 — 일정 목록·미리보기 공용 */
export function upcomingText(u: Upcoming): string {
  switch (u.kind) {
    case "workout":
      // 재부여(실패 후 복귀) — 슬롯 Day와 목표 Day가 다르다. 엔진이 준 두 값을 그대로 옮긴다.
      return u.targetDay !== u.day ? `Day ${u.day} 자리 — Day ${u.targetDay} 목표로 한 번` : `Day ${u.day} 운동`;
    case "rest":
      return u.cycleEnd ? `사이클 마무리 휴식 ${u.index}/${u.of} (Day ${u.day})` : `Day ${u.day} 휴식`;
    case "recovery":
      return `회복 휴식 (Day ${u.pendingDay} 재도전 전)`;
    case "retest":
      return `RM 재측정 (Day ${RETEST_DAY})`;
  }
}

/** "내일은 …" 문구 — 오늘 카드의 미리보기 */
export function tomorrowText(u: Upcoming): string {
  switch (u.kind) {
    case "workout":
      return u.targetDay !== u.day ? `내일은 Day ${u.targetDay} 목표로 한 번 (Day ${u.day} 재도전 전)` : `내일은 Day ${u.day} 운동`;
    case "rest":
      return u.cycleEnd ? `내일은 사이클 마무리 휴식 ${u.index}/${u.of}` : `내일은 휴식(Day ${u.day})`;
    case "recovery":
      return "내일은 회복 휴식";
    case "retest":
      return "내일은 RM 재측정";
  }
}

/** 슈퍼세트 한 스텝 — `풀업 1세트 · 6회` */
export function stepLabel(st: WorkoutStep): string {
  return `${exerciseKo(st.exercise)} ${st.setIndex + 1}세트 · ${st.reps}회`;
}

/** 휴식 끝 음성 안내 — `다음, 푸시업 1세트 9회` (§19-6 문구 그대로) */
export function stepPhrase(st: WorkoutStep): string {
  return `다음, ${exerciseKo(st.exercise)} ${st.setIndex + 1}세트 ${st.reps}회`;
}

/** 기록 한 건을 한 줄로(취소 확인 패널) — 사건 값만 옮긴다 */
export function eventText(e: WorkoutEvent): string {
  if (e.kind === "fail") {
    const f = e.failed;
    const where = f ? ` — ${exerciseKo(f.exercise)} ${f.setIndex + 1}세트${f.reps !== null ? ` ${f.reps}회에서` : "에서"} 멈춤` : "";
    return `Day ${e.day} 실패${where}`;
  }
  return e.targetDay !== e.day ? `Day ${e.targetDay} 목표 완료(Day ${e.day} 재도전 전 복귀)` : `Day ${e.day} 완료`;
}

/**
 * 세트표 — 1~5세트 × 풀업/푸시업 + 합계. 행 순서가 곧 슈퍼세트 진행 순서(풀업1 → 푸시업1 → 풀업2 …)라
 * 위에서 아래로, 왼쪽에서 오른쪽으로 읽으면 된다.
 */
export function SetTable({ target, caption }: { target: SetPair; caption?: string }) {
  const totals = setTotals(target);
  return (
    <table className="u-table">
      {caption && <caption className="t-caption pb-2 text-left">{caption}</caption>}
      <thead>
        <tr>
          <th scope="col">세트</th>
          <th scope="col" className="text-right">
            풀업
          </th>
          <th scope="col" className="text-right">
            푸시업
          </th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: SETS_PER_EXERCISE }, (_, i) => (
          <tr key={i}>
            <td className="t-caption align-middle">{i + 1}세트</td>
            <td className="t-section-title text-right tabular-nums">{target.pullup[i]}</td>
            <td className="t-section-title text-right tabular-nums">{target.pushup[i]}</td>
          </tr>
        ))}
        <tr>
          <td className="t-meta-chip align-middle">합계</td>
          <td className="t-list-title text-right tabular-nums">{totals.pullup}회</td>
          <td className="t-list-title text-right tabular-nums">{totals.pushup}회</td>
        </tr>
      </tbody>
    </table>
  );
}

/** 실패 세트에서 한 횟수 고르기(선택, 0..목표) — 값 null = "모름·안 적음". 세션·오늘 카드 공용 */
export function RepsSelect({
  id,
  max,
  value,
  onChange,
  disabled,
}: {
  id: string;
  max: number;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      className="u-input"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      <option value="">안 적을래요</option>
      {Array.from({ length: max + 1 }, (_, n) => (
        <option key={n} value={n}>
          {n}회{n === max ? " (횟수는 채웠지만 자세가 무너짐)" : ""}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// 요청 — fetch → 계약 타입. 409·404면 화면은 messageKo를 보이고 router.refresh()한다(§19-5).
// ---------------------------------------------------------------------------

/** `POST /api/workout/*` — 응답 JSON이 깨졌으면 data=null(네트워크 예외는 호출부 catch로) */
export async function postWorkout<Res>(url: string, body: unknown): Promise<{ status: number; data: Res | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, data };
}

/** 화면이 낡았다는 응답인가(다른 탭·기기·연타로 이미 바뀜) — 메시지 + 새로고침 대상 */
export function isStaleStatus(status: number): boolean {
  return status === 409 || status === 404;
}

export const NETWORK_ERROR_KO = "네트워크 문제로 저장하지 못했어요. 연결을 확인하고 다시 눌러 주세요.";
export const SAVE_ERROR_KO = "저장하지 못했어요. 잠시 후 다시 시도해 주세요.";
export const STALE_FALLBACK_KO = "그 사이 기록이 바뀌었어요. 화면을 새로 불러왔어요.";

"use client";

/**
 * RM 입력 폼 — 처음 시작·재측정(Day 27)·도중 재측정 공용 (SPEC §19-3·§19-6). 요청은 부모(workout-view)가 보낸다
 * (단일 비행·409 처리·expectedActiveCycleId를 한 곳에서 다루려고). 이 폼은 값 고르기와 미리보기만 한다.
 *
 * - 미리보기(Day 1 사다리)·낮은 RM 경고는 **순수 엔진 함수**(makeBase·lowRmWarning)로 계산한다 — 화면이 규칙을 복제하지 않는다.
 * - RM은 정수 1~150(라우트 zod와 같은 범위 — RM_MIN·RM_MAX). 입력 중에는 문자열로 두고 제출 때만 숫자로 바꾼다.
 * - 경고("RM이 낮으면…")는 막지 않는다(§19-1).
 * - 시작일은 오늘/내일 둘 중 하나. 기본값은 부모가 정한다(처음 = 오늘, 재측정 = 내일 — 최대치 측정 당일 또 운동하지 않게).
 */

import { useId, useState, type FormEvent } from "react";
import { isValidRm, lowRmWarning, makeBase, RM_MAX, RM_MIN, setTotals, type WorkoutRm } from "@/lib/workout";
import { formatShortDate, ladderText } from "./workout-shared";

export type WorkoutRmFormMode = "setup" | "retest" | "remeasure";

export interface WorkoutRmFormValue {
  pullupRm: number;
  pushupRm: number;
  start: "today" | "tomorrow";
}

/** 입력 문자열 → RM(정수 1~150) 또는 null */
function parseRm(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return isValidRm(n) ? n : null;
}

export default function WorkoutRmForm({
  mode,
  initialRm,
  defaultStart,
  today,
  tomorrow,
  disabled,
  submitLabel,
  danger = false,
  onSubmit,
  onCancel,
}: {
  mode: WorkoutRmFormMode;
  initialRm: WorkoutRm;
  defaultStart: "today" | "tomorrow";
  /** KST 오늘·내일 `YYYY-MM-DD` — 서버가 계산해 props로 내려준 값(렌더 중 new Date() 금지) */
  today: string;
  tomorrow: string;
  /** 요청 중(단일 비행) */
  disabled: boolean;
  submitLabel: string;
  /** 도중 재측정 확인 패널 안이면 true — danger는 확인 패널에만(DESIGN §2) */
  danger?: boolean;
  onSubmit: (v: WorkoutRmFormValue) => void;
  onCancel?: () => void;
}) {
  const uid = useId();
  const [pullupRaw, setPullupRaw] = useState(String(initialRm.pullup));
  const [pushupRaw, setPushupRaw] = useState(String(initialRm.pushup));
  const [start, setStart] = useState<"today" | "tomorrow">(defaultStart);
  const [touched, setTouched] = useState(false);

  const pullup = parseRm(pullupRaw);
  const pushup = parseRm(pushupRaw);
  const rm: WorkoutRm | null = pullup !== null && pushup !== null ? { pullup, pushup } : null;
  const base = rm ? makeBase(rm) : null;
  const totals = base ? setTotals(base) : null;
  const warn = rm ? lowRmWarning(rm) : false;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!rm || disabled) return;
    onSubmit({ pullupRm: rm.pullup, pushupRm: rm.pushup, start });
  }

  const rangeHint = `${RM_MIN}~${RM_MAX} 사이 정수로 적어 주세요.`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {mode !== "setup" && (
        <p className="u-box t-question-ko text-ink">
          📏 엄격한 정자세로, 반동 없이 — <b className="font-medium">오늘 하루만 최대치</b>로 재 보세요.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${uid}-pullup`} className="u-label">
            풀업 RM (한 번에 최대 몇 개)
          </label>
          <input
            id={`${uid}-pullup`}
            className="u-input tabular-nums"
            type="number"
            inputMode="numeric"
            min={RM_MIN}
            max={RM_MAX}
            step={1}
            value={pullupRaw}
            disabled={disabled}
            onChange={(e) => setPullupRaw(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && pullup === null}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-pushup`} className="u-label">
            푸시업 RM (한 번에 최대 몇 개)
          </label>
          <input
            id={`${uid}-pushup`}
            className="u-input tabular-nums"
            type="number"
            inputMode="numeric"
            min={RM_MIN}
            max={RM_MAX}
            step={1}
            value={pushupRaw}
            disabled={disabled}
            onChange={(e) => setPushupRaw(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && pushup === null}
          />
        </div>
      </div>
      {touched && !rm && (
        <p role="alert" className="t-caption text-ink-2">
          ⚠️ {rangeHint}
        </p>
      )}

      {/* Day 1 사다리 미리보기 — 엔진 makeBase 그대로 */}
      {base && totals && (
        <div className="u-box-accent">
          <p className="t-meta-chip text-accent-ink">Day 1 사다리 미리보기</p>
          <p className="t-question-ko mt-1 text-ink">
            풀업 <span className="font-medium tabular-nums">{ladderText(base.pullup)}</span>{" "}
            <span className="t-caption">({totals.pullup}회)</span>
          </p>
          <p className="t-question-ko text-ink">
            푸시업 <span className="font-medium tabular-nums">{ladderText(base.pushup)}</span>{" "}
            <span className="t-caption">({totals.pushup}회)</span>
          </p>
        </div>
      )}
      {warn && (
        <p className="u-box t-question-ko text-ink">⚠️ RM이 낮으면 이 루틴의 부담이 커요 — 사다리가 평평해져요.</p>
      )}

      <fieldset>
        <legend className="u-label">Day 1 시작일</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["today", `오늘 ${formatShortDate(today)}`],
              ["tomorrow", `내일 ${formatShortDate(tomorrow)}`],
            ] as const
          ).map(([value, label]) => {
            const on = start === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => setStart(value)}
                className={`u-btn ${on ? "border-accent bg-accent-soft text-accent-ink" : "u-btn-secondary"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          disabled={disabled || !rm}
          className={`u-btn flex-1 ${danger ? "bg-danger text-bg" : "u-btn-primary"}`}
        >
          {disabled ? "저장하는 중…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={disabled} className="u-btn u-btn-secondary flex-1">
            취소
          </button>
        )}
      </div>
    </form>
  );
}

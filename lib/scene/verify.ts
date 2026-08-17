/**
 * lib/scene/verify.ts — 1단 장면 숫자 검산 + 답 비교 정규화
 * (docs/harness/math.md §4 · §5-2)
 *
 * **심판 2**다. 심판 1(호출 C)이 "답 자체가 틀렸나"를 보는 동안, 여기서는 AI가 쓴 장면 대본의
 * 숫자를 앱이 직접 더하고 빼 본다. 답은 맞는데 그림이 다른 이야기를 하는 경우를 잡는 자리다.
 *
 * **이 파일은 순수 함수만 둔다.** AI 호출·네트워크·파일 접근·시각·난수 금지.
 * 코드 검산이 불확실해지면 심판이 둘이 아니라 하나가 된다. (그래서 `lib/ai/`를 import하지 않는다 —
 * 의존 방향은 `lib/ai/math/pipeline.ts` → `lib/scene/verify.ts` 한 방향뿐이다.)
 *
 * 실패는 던지지 않고 **사유 문자열 배열**로 돌려준다. 빈 배열이면 통과다.
 * 사유에는 **어느 단계·어느 인덱스·기대값·실제값**을 담는다 — 이 문자열이 §5-3 재시도 프롬프트에
 * 그대로 실리므로, 모호하면 재시도가 같은 실수를 반복한다.
 * 인덱스는 전부 0-based(`steps[0]`이 첫 단계, `values[0]`이 첫 entity).
 */

import type { AnswerItem, Scene, SceneStep } from "./types";

/** 소수 비교 허용 오차 (§5-2). 정수 비교에 부동소수 함정이 끼지 않게 한다 */
export const NUMERIC_EPSILON = 1e-6;

function eq(a: number, b: number): boolean {
  return Math.abs(a - b) <= NUMERIC_EPSILON;
}

/** 숫자를 사유 문자열에 넣을 때 -0·부동소수 꼬리를 없앤다 */
function num(v: number | null): string {
  if (v === null) return "null";
  const rounded = Math.round(v * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

// ---------------------------------------------------------------------------
// §5-2 답 비교 정규화 — compare()
// 여기 두는 이유: verifyScene 규칙 5('start' ↔ answer 라벨 매칭)와 §5-3 파이프라인의
// B↔C 답 비교, 그리고 §3-4 2단 HTML의 답 태그 대조가 **같은 구현**을 써야 하기 때문이다.
// 세 곳에 따로 만들면 반드시 어긋난다 (§3-4 "라벨 정규화는 §5의 compare()와 같은 구현을 쓴다").
// ---------------------------------------------------------------------------

/**
 * 라벨 정규화 (§5-2): 공백 제거 + **끝에 붙은** 조사 1글자(은/는/이/가/의) 제거.
 * `"가 통"`≡`"가통"`, `"승환이"`≡`"승환"`.
 *
 * **조사를 문자열 아무 데서나 지우지 않는 이유**가 중요하다. 이 교재의 라벨은 `가·나·다`가
 * 흔한데(가 통, 나 상자), 조사 글자를 전역 치환하면 `"가통" → "통"`이 되어 **다른 대상을 같다고
 * 판정**한다. 심판이 무력해지는 정확히 그 지점이다. 그래서 (1) 끝 1글자만, (2) 지우고 나서
 * 빈 문자열이 되면 지우지 않는다(라벨 `"가"` 자체를 보존).
 *
 * 스펙 경고 그대로 — **관대하게 만들지 마라.** 애매하면 불일치로 두고 `held`로 보내는 편이 안전하다.
 */
export function normalizeLabel(raw: string): string {
  const compact = raw.normalize("NFC").replace(/\s+/g, "");
  if (compact.length <= 1) return compact;
  const last = compact.slice(-1);
  if (last === "은" || last === "는" || last === "이" || last === "가" || last === "의") {
    return compact.slice(0, -1);
  }
  return compact;
}

/**
 * 답 비교 (§5-2). 개수가 다르거나 라벨이 하나라도 매칭 안 되면 불일치, 값은 `1e-6` 허용 오차.
 *
 * **단위(unit)는 비교하지 않는다.** §5-2가 비교 대상으로 라벨과 값만 열거했고, 호출 C의 스키마는
 * unit을 nullable로 두어 심판이 단위를 생략해도 되게 되어 있다. 단위까지 요구하면 "600원 vs 600"이
 * 불일치가 되어 **정답인데 held**가 쏟아진다. 단위 오류는 3막 텍스트에 남아 사람이 본다.
 */
export function compare(a: readonly AnswerItem[], b: readonly AnswerItem[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return false; // 답이 없으면 "확인됨"이 아니라 확인 불가다 → 불일치
  const remaining = b.map((item) => ({ label: normalizeLabel(item.label), value: item.value }));
  for (const item of a) {
    const label = normalizeLabel(item.label);
    const hit = remaining.findIndex((r) => r.label === label && eq(r.value, item.value));
    if (hit === -1) return false;
    remaining.splice(hit, 1);
  }
  return true;
}

/** 사유·로그·재시도 프롬프트에 쓰는 답 표기 (`자=600원, 지우개=300`) */
export function formatAnswer(items: readonly AnswerItem[]): string {
  if (items.length === 0) return "(없음)";
  return items.map((i) => `${i.label}=${num(i.value)}${i.unit ?? ""}`).join(", ");
}

// ---------------------------------------------------------------------------
// §4 장면 숫자 검산 — verifyScene()
// ---------------------------------------------------------------------------

/**
 * 장면 대본을 계산기로 다시 두드려 본다 (§4의 9규칙).
 *
 * @returns 실패 사유 배열. **빈 배열이면 통과.**
 *
 * 실패해도 던지지 않는 이유: §5-3은 장면 검산이 실패하면 **장면만 버리고**(`scene = null`)
 * 텍스트 3막은 살린다. 그림 하나 때문에 설명을 통째로 날릴 이유가 없다.
 */
export function verifyScene(scene: Scene, answer: readonly AnswerItem[]): string[] {
  const errors: string[] = [];
  const n = scene.entities.length;

  // ── 규칙 1: entities 개수, 모든 steps[i].values 길이 ────────────────────────
  if (n < 1) errors.push(`entities: expected >= 1, got ${n}`);
  scene.steps.forEach((step, i) => {
    if (step.values.length !== n) {
      errors.push(`step ${i} (${step.mode}): values length expected ${n}, got ${step.values.length}`);
    }
  });
  // 길이가 어긋난 채로 뒤 규칙을 돌리면 사유가 전부 헛것(undefined 비교)이 된다.
  // 구조가 깨졌을 때는 그 사실만 정확히 돌려주고 멈춘다.
  if (errors.length > 0) return errors;

  // ── 규칙 2: moves의 from/to 범위, from ≠ to, amt > 0 ────────────────────────
  scene.moves.forEach((m, i) => {
    if (!Number.isInteger(m.from) || m.from < 0 || m.from >= n) {
      errors.push(`moves[${i}]: from expected 0..${n - 1}, got ${m.from}`);
    }
    if (!Number.isInteger(m.to) || m.to < 0 || m.to >= n) {
      errors.push(`moves[${i}]: to expected 0..${n - 1}, got ${m.to}`);
    }
    if (m.from === m.to) errors.push(`moves[${i}]: from and to must differ, both ${m.from}`);
    if (!(m.amt > 0)) errors.push(`moves[${i}]: amt expected > 0, got ${num(m.amt)}`);
  });

  // ── 규칙 3: steps 순서 ─────────────────────────────────────────────────────
  const steps = scene.steps;
  if (steps.length === 0) {
    errors.push("steps: expected at least 1, got 0");
    return errors;
  }
  if (steps[0].mode !== "end") {
    errors.push(`steps[0]: mode expected 'end', got '${steps[0].mode}'`);
  }
  const lastIndex = steps.length - 1;
  if (steps[lastIndex].mode !== "ok") {
    errors.push(`steps: last mode expected 'ok', got '${steps[lastIndex].mode}' at step ${lastIndex}`);
  }
  const startIndexes = steps.flatMap((s, i) => (s.mode === "start" ? [i] : []));
  if (startIndexes.length !== 1) {
    errors.push(
      `steps: exactly one 'start' expected, got ${startIndexes.length}` +
        (startIndexes.length > 1 ? ` (at steps ${startIndexes.join(", ")})` : ""),
    );
  }
  steps.forEach((s, i) => {
    if (s.mode !== "ok") return;
    const prevMode = i > 0 ? steps[i - 1].mode : null;
    if (prevMode !== "start") {
      errors.push(
        `steps: 'ok' at step ${i} must be preceded by 'start', got ${
          prevMode === null ? "no previous step" : `'${prevMode}' at step ${i - 1}`
        }`,
      );
    }
  });

  // ── 규칙 4: rewind 단계 산술 ───────────────────────────────────────────────
  // prev는 "직전 단계"다. null인 자리는 되돌릴 근거가 없어 건너뛴다(§4-4 "null 아닌 값 기준").
  steps.forEach((step, i) => {
    if (step.mode !== "rewind") {
      // types.ts: "되감기 단계에서 되돌리는 원래 이동의 인덱스. 그 외 단계는 null".
      // 플레이어가 이 인덱스로 이동 애니메이션을 고르므로, 엉뚱한 단계에 붙은 move는
      // 숫자가 맞아도 **틀린 그림**을 만든다.
      if (step.move !== null) {
        errors.push(`step ${i} (${step.mode}): move expected null, got ${step.move}`);
      }
      return;
    }
    if (step.move === null || !Number.isInteger(step.move) || step.move < 0 || step.move >= scene.moves.length) {
      errors.push(
        `rewind step ${i}: move index expected 0..${scene.moves.length - 1}, got ${step.move === null ? "null" : step.move}`,
      );
      return;
    }
    if (i === 0) {
      errors.push(`rewind step ${i}: no previous step to rewind from`);
      return;
    }
    const m = scene.moves[step.move];
    if (m.from < 0 || m.from >= n || m.to < 0 || m.to >= n) return; // 규칙 2가 이미 보고했다
    const prev = steps[i - 1].values;
    const cur = step.values;
    for (let k = 0; k < n; k++) {
      const before = prev[k];
      if (before === null) continue; // 근거 없음 — 검산 대상에서 제외
      const delta = k === m.from ? m.amt : k === m.to ? -m.amt : 0;
      const expected = before + delta;
      const actual = cur[k];
      if (actual === null) {
        errors.push(`rewind step ${i}: values[${k}] expected ${num(expected)}, got null`);
      } else if (!eq(actual, expected)) {
        const label = k === m.from || k === m.to ? "" : " (must not change)";
        errors.push(`rewind step ${i}: values[${k}]${label} expected ${num(expected)}, got ${num(actual)}`);
      }
    }
  });

  // ── 규칙 5: 'start' 단계 values ↔ answer ───────────────────────────────────
  // §3-1: "mode 'start' 단계의 values는 answer와 완전히 일치해야 한다."
  // '완전히'를 개수까지 포함해 읽는다 — entity 하나가 답에 없으면 그림이 답보다 많은 이야기를
  // 하는 것이고, 되감기의 종착점이 곧 답이라는 전제가 깨진다. 오탐 비용은 '장면 폐기'뿐이고,
  // 미탐 비용은 '틀린 그림을 아이가 봄'이다.
  if (startIndexes.length === 1) {
    const si = startIndexes[0];
    const start = steps[si];
    const entityLabels = scene.entities.map((e) => normalizeLabel(e.labelKo));
    const dup = entityLabels.findIndex((l, i) => entityLabels.indexOf(l) !== i);
    if (dup !== -1) {
      errors.push(
        `start step ${si}: entities[${entityLabels.indexOf(entityLabels[dup])}] and entities[${dup}] normalize to the same label "${entityLabels[dup]}" — cannot match answer`,
      );
    } else if (answer.length !== n) {
      errors.push(`start step ${si}: answer has ${answer.length} item(s) but scene has ${n} entities`);
    } else {
      for (const item of answer) {
        const label = normalizeLabel(item.label);
        const k = entityLabels.indexOf(label);
        if (k === -1) {
          errors.push(
            `start step ${si}: answer label "${item.label}" matches no entity (entities: ${scene.entities.map((e) => e.labelKo).join(", ")})`,
          );
          continue;
        }
        const actual = start.values[k];
        if (actual === null || !eq(actual, item.value)) {
          errors.push(
            `start step ${si}: values[${k}] (${scene.entities[k].labelKo}) expected ${num(item.value)}, got ${num(actual)}`,
          );
        }
      }
    }
  }

  // ── 규칙 6: 'ok' 단계 values === 첫 'end' 단계 values (null이면 'find' 값) ──
  const endIndex = steps.findIndex((s) => s.mode === "end");
  if (endIndex !== -1) {
    const reference: (number | null)[] = [...steps[endIndex].values];
    const findSteps = steps.filter((s) => s.mode === "find");
    for (let k = 0; k < n; k++) {
      if (reference[k] !== null) continue;
      for (const f of findSteps) {
        if (f.values[k] !== null) {
          reference[k] = f.values[k];
          break;
        }
      }
    }
    // [스펙 공백] end에 null이 남고 'find'도 없는 대본이 있다 — `bar layout='compare'`의 끝 장면이
    // 그렇다("합 900, 차 300"만 알고 각각은 모른다). 이때 규칙 6은 **위반이 아니라 공허**하다
    // (대조할 값이 애초에 없다). 그래서 그 자리는 건너뛴다 — 정상 대본을 오탐으로 날리면
    // 개정 1이 1단으로 끌어올린 합·차 문제가 전부 그림을 잃는다.
    //
    // 단, 되감기(`rewind`)가 있는 대본에서는 다르다. 규칙 4도 prev가 null이면 건너뛰므로,
    // 끝 장면이 미정이면 되감기 사슬 전체가 **한 줄도 검산되지 않는** 상태가 된다.
    // §3-1이 "끝 장면 숫자가 숨어 있으면 찾는 단계를 반드시 따로 둔다"고 못박은 이유가 이것이라,
    // 그 경우만 오류로 돌린다.
    const hasRewind = steps.some((s) => s.mode === "rewind");
    steps.forEach((step, i) => {
      if (step.mode !== "ok") return;
      for (let k = 0; k < n; k++) {
        const expected = reference[k];
        if (expected === null) {
          if (hasRewind) {
            errors.push(
              `ok step ${i}: values[${k}] cannot be verified — end step ${endIndex} is null and no 'find' step supplies it`,
            );
          }
          continue;
        }
        const actual = step.values[k];
        if (actual === null || !eq(actual, expected)) {
          errors.push(
            `ok step ${i}: values[${k}] expected ${num(expected)} (end step ${endIndex}), got ${num(actual)}`,
          );
        }
      }
    });
  }

  // ── 규칙 7: conservation — null 없는 모든 단계에서 sum === total ────────────
  if (scene.conservation) {
    const total = scene.conservation.total;
    steps.forEach((step, i) => {
      // [스펙 내부 충돌] §4-7은 "null 없는 모든 단계"를 요구하지만, 개정 1의 `split` 단계는
      // **차를 떼어 낸 나머지**(total − difference.amount)를 보이는 것이 정상이라 정의상 total과 다르다.
      // 규칙 7을 그대로 적용하면 정상 합·차 대본이 100% 오탐된다. split의 합은 §4-9가 prevSum(또는
      // conservation에서 유도한 값)으로 **더 엄격하게** 고정하므로, 여기서 빼도 검산 구멍이 생기지 않는다.
      if (step.mode === "split") return;
      if (step.values.some((v) => v === null)) return;
      const sum = (step.values as number[]).reduce((a, b) => a + b, 0);
      if (!eq(sum, total)) {
        errors.push(`conservation: step ${i} (${step.mode}) values sum expected ${num(total)}, got ${num(sum)}`);
      }
    });
  }

  // ── 규칙 8: 모든 값 ≤ maxValue, ≥ 0 (numberline은 음수 허용) ────────────────
  const allowNegative = scene.kind === "numberline";
  steps.forEach((step, i) => {
    step.values.forEach((v, k) => {
      if (v === null) return;
      if (v > scene.maxValue + NUMERIC_EPSILON) {
        errors.push(`step ${i} (${step.mode}): values[${k}] expected <= maxValue ${num(scene.maxValue)}, got ${num(v)}`);
      }
      if (!allowNegative && v < -NUMERIC_EPSILON) {
        errors.push(`step ${i} (${step.mode}): values[${k}] expected >= 0, got ${num(v)}`);
      }
    });
  });

  // ── 규칙 9 [개정 1]: kind === 'bar' 추가 규칙 ──────────────────────────────
  errors.push(...verifyBarRules(scene, steps, startIndexes));

  return errors;
}

/**
 * §4-9 — 합·차 문제(`bar layout='compare'`)의 검산.
 *
 * **이 프로젝트에서 가장 값어치 있는 규칙이다.** 은우는 "900원, 자가 300원 더 비쌈"에서
 * 900÷2로 **반씩 나눴다**(450/150). 정답은 600/300이다. `split` 단계 검산이 정확히 그 오답을
 * 거부한다 — "차를 떼어 낸 뒤 남은 것을 똑같이 둘로 나눈" 상태만 통과하기 때문이다.
 */
function verifyBarRules(scene: Scene, steps: readonly SceneStep[], startIndexes: readonly number[]): string[] {
  const errors: string[] = [];
  const splitIndexes = steps.flatMap((s, i) => (s.mode === "split" ? [i] : []));

  if (scene.kind !== "bar") {
    // layout·difference는 §3-3에서 bar 전용, split은 bar layout='compare' 전용으로 못박혀 있다.
    // 다른 kind에 붙어 있으면 대본이 스스로 어느 그림인지 모르는 상태다.
    if (scene.layout !== null) errors.push(`kind '${scene.kind}': layout expected null, got '${scene.layout}'`);
    if (scene.difference !== null) {
      errors.push(`kind '${scene.kind}': difference expected null, got amount ${num(scene.difference.amount)}`);
    }
    for (const i of splitIndexes) {
      errors.push(`step ${i}: mode 'split' is only for kind 'bar' layout 'compare', got kind '${scene.kind}'`);
    }
    return errors;
  }

  if (scene.layout === null) {
    errors.push("bar: layout expected 'parts' or 'compare', got null");
    return errors; // layout을 모르면 아래 규칙의 기준이 없다
  }

  if (scene.layout === "parts") {
    if (scene.difference !== null) {
      errors.push(
        `bar layout='parts': difference expected null, got amount ${num(scene.difference.amount)}`,
      );
    }
    for (const i of splitIndexes) {
      errors.push(`bar layout='parts': step ${i} mode 'split' is not allowed`);
    }
    return errors;
  }

  // ── layout === 'compare' ──────────────────────────────────────────────────
  const n = scene.entities.length;
  if (n !== 2) errors.push(`bar layout='compare': entities expected 2, got ${n}`);
  if (scene.difference === null) {
    errors.push("bar layout='compare': difference expected non-null, got null");
    return errors; // 차를 모르면 split·start 검산의 기준이 없다
  }
  if (!(scene.difference.amount > 0)) {
    errors.push(`difference: amount expected > 0, got ${num(scene.difference.amount)}`);
  }
  if (n !== 2) return errors;

  const amount = scene.difference.amount;

  // 'start' 단계: 두 띠의 길이 차가 difference.amount와 같아야 한다.
  // 규칙 5(start ↔ answer)와 짝을 이룬다 — 답이 차 조건을 지켰는지를 그림 쪽에서 한 번 더 본다.
  if (startIndexes.length === 1) {
    const si = startIndexes[0];
    const [v0, v1] = steps[si].values;
    if (v0 === null || v1 === null) {
      errors.push(
        `bar layout='compare' start step ${si}: values expected both non-null to check difference, got [${num(v0)}, ${num(v1)}]`,
      );
    } else {
      const diff = Math.abs(v0 - v1);
      if (!eq(diff, amount)) {
        errors.push(
          `bar layout='compare' start step ${si}: |values[0] - values[1]| expected ${num(amount)} (difference.amount), got ${num(diff)}`,
        );
      }
      if (scene.conservation && !eq(scene.conservation.total, v0 + v1)) {
        errors.push(
          `bar layout='compare': conservation.total expected ${num(v0 + v1)} (start step ${si} sum), got ${num(scene.conservation.total)}`,
        );
      }
    }
  }

  // 'split' 단계 — §4-9의 백미.
  for (const i of splitIndexes) {
    const [v0, v1] = steps[i].values;
    if (v0 === null || v1 === null) {
      errors.push(`split step ${i}: values expected both non-null, got [${num(v0)}, ${num(v1)}]`);
      continue;
    }
    // (1) 두 값이 서로 같다 = "똑같이 둘로 갈랐다"
    if (!eq(v0, v1)) {
      errors.push(`split step ${i}: values[0] and values[1] expected equal, got ${num(v0)} and ${num(v1)}`);
    }
    // (2) 그 합이 직전 단계 합과 같다 = "직전 단계에서 차를 떼어 낸 뒤의 양을 나눴다"
    //     반씩 나누기(차를 안 뗀 상태)는 합이 전체(total)라 여기서 걸린다.
    const sum = v0 + v1;
    const prev = i > 0 ? steps[i - 1].values : null;
    if (prev === null) {
      errors.push(`split step ${i}: no previous step to take the remainder from`);
      continue;
    }
    if (prev.every((v) => v !== null)) {
      const prevSum = (prev as number[]).reduce((a, b) => a + b, 0);
      if (!eq(sum, prevSum)) {
        errors.push(`split step ${i}: values sum expected ${num(prevSum)} (previous step ${i - 1} sum), got ${num(sum)}`);
      }
      continue;
    }
    // [스펙 공백] 직전 단계 값이 아직 null인 대본이 흔하다("합 900, 차 300"만 아는 끝 장면).
    // prevSum을 못 구한다고 넘어가면 이 규칙이 존재하는 이유(반씩 나누기 거부)가 사라지므로,
    // conservation에서 기대 합을 유도한다: 차를 떼어 낸 나머지 = total − difference.amount.
    if (scene.conservation) {
      const expectedSum = scene.conservation.total - amount;
      if (!eq(sum, expectedSum)) {
        errors.push(
          `split step ${i}: values sum expected ${num(expectedSum)} (conservation.total ${num(scene.conservation.total)} - difference.amount ${num(amount)}), got ${num(sum)}`,
        );
      }
      continue;
    }
    errors.push(
      `split step ${i}: previous step ${i - 1} has null values and no conservation — cannot verify that the difference was taken out first`,
    );
  }

  return errors;
}

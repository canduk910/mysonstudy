/**
 * lib/scene/types.ts — 되감기 플레이어 1단(전용 렌더러) 장면 타입 (docs/harness/math.md §3-3)
 *
 * **이 파일이 `Scene`의 단일 정의처다.** 세 모듈이 같은 타입을 본다:
 * - `lib/ai/math/schemas.ts` — 호출 B·D의 JSON Schema + zod (zod 추론 타입이 이 타입과 일치하는지 컴파일 타임 대조)
 * - `lib/scene/verify.ts`    — §4 장면 숫자 검산 (verifyScene)
 * - `lib/ai/math/pipeline.ts`— §5-3 explainProblem 흐름
 * 타입을 고치면 세 곳이 함께 움직인다. 필드를 늘리기 전에 §4 검산 규칙을 먼저 확인할 것.
 *
 * 값 자체의 정합성(되감기 산술, 보존량, split 등)은 타입이 아니라 §4 `verifyScene()`가 본다.
 * 타입은 "모양"만 보증한다.
 */

/** 1단 렌더러 종류 (§3-1 [scene] — 이 3종으로 자연스럽게 표현될 때만 1단) */
export const SCENE_KINDS = ["containers", "bar", "numberline"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** containers 전용 시각화 — 물이면 tank, 돈이면 coin, 그 외 bar (§3-1) */
export const SCENE_VISUALS = ["tank", "coin", "bar"] as const;
export type SceneVisual = (typeof SCENE_VISUALS)[number];

/**
 * bar 전용 레이아웃 [개정 1]
 * - `parts`   : 부분들이 모여 전체가 되는 문제
 * - `compare` : 합과 차가 함께 주어진 문제 (difference 필수). 은우가 가장 자주 틀리는 유형이다
 */
export const BAR_LAYOUTS = ["parts", "compare"] as const;
export type BarLayout = (typeof BAR_LAYOUTS)[number];

/**
 * 단계 종류 (§3-3)
 * - `end`    : 끝 장면(출발점)
 * - `find`   : 숨은 값 찾기 ("똑같아졌다" 같은 미지의 끝 장면 확정)
 * - `rewind` : 이동 1개를 되돌리기 (§4-4 산술 검산 대상)
 * - `split`  : [개정 1] 차를 떼어 낸 나머지를 똑같이 둘로 가르기 (§4-9 검산 대상)
 * - `start`  : 처음 장면 — values가 answer와 일치해야 한다 (§4-5)
 * - `ok`     : 검사 장면 (forward true)
 */
export const SCENE_STEP_MODES = ["end", "find", "rewind", "split", "start", "ok"] as const;
export type SceneStepMode = (typeof SCENE_STEP_MODES)[number];

/** 장면 단계 캡션 (§3-1 공통) */
export interface Caption {
  tag: string; // 예: "되감기 1"
  title: string;
  body: string; // 아이에게 하는 말
  calc: string | null;
}

/** 통·사람 등 값의 주체. steps[i].values의 인덱스가 이 배열의 인덱스다 */
export interface SceneEntity {
  id: string;
  labelKo: string;
}

/** 실제 이동 1건. from/to는 entities 인덱스 (§4-2) */
export interface SceneMove {
  from: number;
  to: number;
  amt: number;
  labelKo: string;
}

/** bar layout='compare'의 두 띠 길이 차 [개정 1] */
export interface SceneDifference {
  amount: number;
  labelKo: string;
}

/** 전체 합이 보존되면 채운다 (§4-7 저울 검산 대상) */
export interface SceneConservation {
  total: number;
  labelKo: string;
}

/** 되감기 한 단계. values 길이 = entities 길이, 값은 숫자 또는 null(아직 모름) */
export interface SceneStep {
  mode: SceneStepMode;
  values: (number | null)[];
  /** 되감기 단계에서 되돌리는 원래 이동의 인덱스 (moves 인덱스). 그 외 단계는 null */
  move: number | null;
  forward: boolean;
  caption: Caption;
}

/** 1단: 전용 렌더러 장면 대본 (엄격 검산 가능) — §3-3 원문 타입 */
export interface Scene {
  kind: SceneKind;
  visual: SceneVisual | null; // containers 전용
  layout: BarLayout | null; // bar 전용 [개정 1]
  difference: SceneDifference | null; // bar layout='compare' 전용 [개정 1]
  unit: string;
  maxValue: number; // 그림 눈금 상한 (값 중 최대의 1.3배쯤 반올림)
  entities: SceneEntity[];
  moves: SceneMove[];
  conservation: SceneConservation | null;
  steps: SceneStep[]; // 3~8개 (개수는 zod가 검사 — §3-3)
}

/**
 * 구조화된 답 한 줄 (§3-1 [답과 채점]).
 *
 * 호출 B·C·D가 모두 이 모양으로 답을 낸다. `verifyScene(scene, answer)`(§4)와
 * `compare()`(§5-2)가 같은 타입을 받으므로 `lib/ai/math/`가 아니라 여기 둔다 —
 * `lib/scene/`가 `lib/ai/`를 import하지 않게 하기 위해서다.
 * 라벨은 문제 속 이름 그대로(가/나/다, 승환/영민/지훈), 값은 숫자.
 */
export interface AnswerItem {
  label: string;
  value: number;
  unit: string | null;
}

/**
 * 그림 단수 (§5-3 `sceneTier`).
 * - `typed` : 1단 전용 렌더러 (`Scene`)
 * - `html`  : 2단 호출 E가 만든 HTML
 * - `none`  : 그림 없이 텍스트 3막만
 *
 * [개정 4] 2단은 예외가 아니라 기본 경로다. 유형별 집계가 다음에 만들 전용 렌더러를 알려준다(§8).
 */
export const SCENE_TIERS = ["typed", "html", "none"] as const;
export type SceneTier = (typeof SCENE_TIERS)[number];

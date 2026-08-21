/**
 * lib/scene/containers-html.ts — 1단 전용 렌더러 `containers`: 대본(`Scene`) → 플레이어 HTML
 * (docs/harness/math.md §3-3 · §3-1의 [scene] 절 · §11-2 "1단 전용 렌더러")
 *
 * ┌─ 왜 React 컴포넌트가 아니라 HTML 문자열인가 ─────────────────────────────┐
 * │ 그림(물통·동전·띠·저울)은 이미 `public/player-kit/kit.js`에 **한 벌만** 있고,  │
 * │ 그 그림의 색·간격·VCR 바·되감기 규칙은 `kit.css`에만 있다. 이 둘은 iframe    │
 * │ 안에서만 사는 자원이다. React로 옮기면 **같은 그림이 두 곳(kit.js + 컴포넌트,  │
 * │ kit.css + globals.css)에 살게 되고**, 어긋나는 순간 1단과 2단이 다른 그림을     │
 * │ 보여준다. 그래서 1단도 2단과 같은 부엌을 쓴다 — 다만 요리사가 AI가 아니라      │
 * │ **이 파일**이다.                                                            │
 * │                                                                            │
 * │ 바꿔 말하면: 그리는 코드는 kit.js 한 곳, 그것을 부르는 쪽이 둘(이 파일 = 1단,   │
 * │ 호출 E의 AI = 2단)이다. `Kit`의 시그니처를 바꾸면 **양쪽을 같은 커밋에서** 고친다. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── 2단과 무엇이 다른가 ─────────────────────────────────────────────────────
 * | | 2단 (호출 E) | 1단 (이 파일) |
 * |---|---|---|
 * | 코드 출처 | AI | 우리 |
 * | 정적 검사(`runStaticCheck`) | 필요 — 걸리면 재생성 | **불필요** |
 * | 답 태그 대조 | 필요 — 마지막 그물 | 불필요 (§4-5가 `start` values ↔ answer를 이미 검산) |
 * | iframe 격리·3초 폴백 | 필요 | **그대로 유지** |
 *
 * 격리를 1단에서도 유지하는 이유는 보안이 아니라 **환경**이다. kit.css/kit.js가
 * 부모 문서의 스타일과 섞이지 않아야 그림이 늘 같은 얼굴을 하고, 3초 폴백은
 * "깨진 그림보다 없는 편이 낫다"를 1단에도 그대로 준다.
 *
 * 답 태그(`<script id="answer">`)는 **대조용이 아니라 점검용**으로 남긴다 —
 * `inspectSceneHtml()`을 이 출력에 그대로 돌리면 배선이 답을 흐트러뜨리지 않았는지
 * 무비용으로 확인할 수 있다(qa-inspector용 이음매).
 */

import { CONTAINERS_RUNTIME } from "./containers-runtime";
import type { AnswerItem, Scene } from "./types";

// ---------------------------------------------------------------------------
// 뷰모델 — `#scene-data`에 실려 `CONTAINERS_RUNTIME`이 읽는 모양
// ---------------------------------------------------------------------------

/**
 * 런타임이 받는 JSON. `Scene`에서 `containers`가 쓰지 않는 필드(`kind`·`layout`·
 * `difference`)를 덜어내고, 그림에만 필요한 파생값(동전 단위) 둘을 더한 것이다.
 *
 * **파생값을 여기서 계산하는 이유**: 런타임은 iframe 안 문자열이라 테스트가 어렵다.
 * 계산은 전부 TS 쪽에 두고 런타임은 배선만 하게 나눈다.
 */
export interface ContainersViewModel {
  visual: "tank" | "coin" | "bar";
  unit: string;
  maxValue: number;
  /** 동전 1개가 나타내는 값 (visual==='coin'에서만 의미가 있다) */
  coinPer: number;
  /** 동전 자리 수 */
  coinSlots: number;
  entities: { labelKo: string }[];
  moves: { from: number; to: number; amt: number; labelKo: string }[];
  conservation: { total: number; labelKo: string } | null;
  steps: {
    mode: string;
    values: (number | null)[];
    move: number | null;
    caption: { tag: string; title: string; body: string; calc: string | null };
  }[];
}

// ---------------------------------------------------------------------------
// 동전 단위 고르기
// ---------------------------------------------------------------------------

/**
 * 동전 더미는 9개까지만 쌓인다(kit.js `coins`의 viewBox가 그만큼이다).
 * `maxValue`를 9칸 안에 담을 수 있는 **가장 작은** 익숙한 단위를 고른다 —
 * 작을수록 동전 개수가 많아 눈으로 세기 좋다.
 */
const COIN_UNITS = [1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000] as const;
const COIN_MAX_SLOTS = 9;

export function pickCoinUnit(maxValue: number): { per: number; slots: number } {
  const top = maxValue > 0 ? maxValue : 1;
  const per =
    COIN_UNITS.find((u) => Math.ceil(top / u) <= COIN_MAX_SLOTS) ??
    COIN_UNITS[COIN_UNITS.length - 1];
  return { per, slots: Math.max(1, Math.min(COIN_MAX_SLOTS, Math.ceil(top / per))) };
}

// ---------------------------------------------------------------------------
// 문자열 안전 처리
// ---------------------------------------------------------------------------

/** 마크업에 넣는 텍스트 — 태그로 읽히지 않게 한다 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `<script type="application/json">` 안에 넣는 JSON.
 *
 * `<`만 이스케이프하면 충분하다 — JSON에서 `<`는 문자열 안에만 나오고, 그것 하나를
 * 막으면 `</script`로 태그를 조기에 닫을 수 없다. 대본의 글은 AI가 쓴 것이므로
 * (캡션·라벨) 이 처리가 없으면 따옴표 하나로 문서가 통째로 깨질 수 있다.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export interface BuildContainersHtmlInput {
  scene: Scene;
  /** 호출 B가 낸 답 — 점검용 답 태그에 그대로 싣는다 */
  answer: readonly AnswerItem[];
  /** 문제 문장. 플레이어 안에도 한 줄 두면 그림만 보고도 무슨 문제인지 안다 */
  problemText?: string | null;
}

/** 플레이어 카드 맨 위 문제 문장은 한 줄로만 — 본문은 위쪽 3막에 이미 온전히 있다 */
const PROBLEM_MAX = 140;

/**
 * `containers` 대본을 iframe `<body>` 안 조각으로 옮긴다.
 *
 * `kind`가 `containers`가 아니면 **null**이다 — `bar`·`numberline`은 아직 전용 렌더러가
 * 없어 화면이 기존 "준비 중" 안내를 그대로 띄워야 한다(§11-2). 여기서 억지로 그리면
 * 검산이 보증하지 않는 그림이 나간다.
 *
 * 반환 문자열은 `buildSceneSrcdoc()`의 `html`에 그대로 넣는다 — 2단과 같은 자리다.
 */
export function buildContainersHtml(input: BuildContainersHtmlInput): string | null {
  const { scene } = input;
  if (scene.kind !== "containers") return null;

  const visual = scene.visual ?? "bar";
  const coin = pickCoinUnit(scene.maxValue);

  const model: ContainersViewModel = {
    visual,
    unit: scene.unit,
    maxValue: scene.maxValue,
    coinPer: coin.per,
    coinSlots: coin.slots,
    entities: scene.entities.map((e) => ({ labelKo: e.labelKo })),
    moves: scene.moves.map((m) => ({
      from: m.from,
      to: m.to,
      amt: m.amt,
      labelKo: m.labelKo,
    })),
    conservation: scene.conservation
      ? { total: scene.conservation.total, labelKo: scene.conservation.labelKo }
      : null,
    steps: scene.steps.map((s) => ({
      mode: s.mode,
      values: s.values,
      move: s.move,
      caption: {
        tag: s.caption.tag,
        title: s.caption.title,
        body: s.caption.body,
        calc: s.caption.calc,
      },
    })),
  };

  /*
   * 무대 그릇이 visual에 따라 갈린다.
   * - tank·coin → `.kit-stage`(가로 flex). 통이 나란히 서야 주고받기가 보인다.
   * - bar       → 클래스 없는 div. `Kit.bar`는 한 줄짜리 `.kit-bar-row`를 붙이는데
   *               `.kit-stage`에 넣으면 `> * { flex: 1 1 90px }`가 걸려 띠가 옆으로 눕는다.
   */
  const stageClass = visual === "bar" ? "" : ' class="kit-stage"';

  const problem = (input.problemText ?? "").trim().replace(/\s+/g, " ");
  const problemLine = problem
    ? `\n    <p class="kit-problem">${escapeHtml(
        problem.length > PROBLEM_MAX ? `${problem.slice(0, PROBLEM_MAX)}…` : problem,
      )}</p>`
    : "";

  const scaleCard = scene.conservation ? '\n  <div class="kit-card" id="scale-card"></div>' : "";

  return `<div class="kit-wrap">
  <div class="kit-card">${problemLine}
    <div class="kit-lane" id="lane"></div>
    <div id="stage"${stageClass}></div>
  </div>${scaleCard}
</div>

<script type="application/json" id="scene-data">${embedJson(model)}</script>
<script type="application/json" id="answer">${embedJson(input.answer)}</script>

<script>${CONTAINERS_RUNTIME}</script>`;
}

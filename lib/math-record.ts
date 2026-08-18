/**
 * lib/math-record.ts — 저장된 수학 설명 기록(`ExplanationRecord`)을 화면에 올리기 전에
 * 통과시키는 **단일 판정처** (docs/harness/math.md §9-4 · QA 5-4 · QA P3-5)
 *
 * ── 왜 별도 모듈인가 ────────────────────────────────────────────────────────
 * 같은 판정이 서재(`/math/library`)와 상세(`/math/problem/[id]`)에 두 벌로 살면 언젠가
 * 갈린다. 갈리는 순간 나타나는 증상이 **"목록에는 보이는데 눌렀더니 500"**이라 사용자
 * 입장에서 가장 나쁜 형태다. 그래서 두 화면이 같은 함수 하나를 본다.
 *
 * ── 타입이 보증하지 못하는 자리 ─────────────────────────────────────────────
 * `ExplanationRecord`의 타입은 필드를 필수로 선언하지만 **읽기 경로에는 타입이 없다.**
 * Firestore 문서는 손으로 넣을 수도 있고, 저장 시점의 스키마가 지금과 다를 수도 있다
 * (M4에 저장된 기록에는 `content.insight` 키가 아예 없다). 그래서 "타입이 그렇다니까"가
 * 아니라 **실제로 있는지 확인한다.**
 *
 * ── 판정 실패의 뜻 ──────────────────────────────────────────────────────────
 * - 서재: 그 줄만 건너뛰고 건수를 알린다(한 건 때문에 목록 전체를 잃지 않게).
 * - 상세: `notFound()` — **404지 500이 아니다.** 서버가 고장 난 게 아니라 열 수 없는
 *   기록이고, 사용자는 서재의 "예전 형식이라 열지 못한 기록이 N건" 안내로 맥락을 안다.
 */

import { CHILD_GRADES, PROBLEM_PATTERNS } from "./ai/math/schemas";
import type { MathExplainSuccess } from "./math-explain-contract";
import { SCENE_TIERS } from "./scene/types";
import type { ExplanationRecord } from "./store";

/** 배열인지 — `.map()`·`.length`·`.includes()`를 태우기 전 확인하는 유일한 조건 */
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** 객체인지 (null·배열 제외) — 하위 필드를 읽기 전 확인 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 두 화면이 **실제로 읽는 필드**가 전부 제자리에 있는가.
 *
 * 목록이 지금 확인하는 것보다 범위가 넓다(배열·중첩 객체·`sceneTier`까지 본다). 상세
 * 화면이 훨씬 깊이 파고들기 때문인데, 좁은 판정과 넓은 판정을 따로 두면 위에서 말한
 * "목록에는 보이는데 눌렀더니 깨진다"가 그대로 돌아온다. **열 수 없는 기록은 목록에도
 * 걸지 않는다** — 링크가 404로 떨어지는 편보다 처음부터 안 보이는 편이 정직하다.
 *
 * zod(`ExplanationSchema`)로 대신하지 않는 이유: 그 스키마는 지금의 다이얼(단계 수·글자
 * 수 한도)까지 강제하고 `insight` 키를 **필수**로 본다. 태우면 정상적으로 저장된 M4
 * 기록이 전부 떨어진다. 여기서 볼 것은 품질이 아니라 **모양**이다.
 */
export function isRenderableExplanation(record: ExplanationRecord): boolean {
  const r = record as Partial<ExplanationRecord>;

  // 뼈대 — 목록 줄과 상세 헤더가 문자열로 다룬다(`createdAt.slice()`가 던지는 자리)
  if (!r.id || typeof r.createdAt !== "string") return false;
  if (!isObject(r.problem) || typeof r.problem.text !== "string") return false;
  if (!isObject(r.content) || !isObject(r.verify)) return false;
  if (!(SCENE_TIERS as readonly string[]).includes(r.sceneTier as string)) return false;

  // 라벨 표(`GRADE_BADGE`)와 유형 집계가 키로 쓰는 값 — 모르는 값이면 표가 undefined다
  const content = r.content as Record<string, unknown>;
  if (!(PROBLEM_PATTERNS as readonly string[]).includes(content.problemPattern as string)) {
    return false;
  }
  if (!(CHILD_GRADES as readonly string[]).includes(content.childGrade as string)) return false;

  // 3막 본문 — 상세 화면이 중첩 필드를 읽고 배열을 순회한다
  if (!isObject(content.analogy)) return false;
  if (!isObject(content.act1) || !isArray(content.act1.castKo) || !isArray(content.act1.movesKo)) {
    return false;
  }
  if (!isObject(content.act2) || !isArray(content.act2.steps)) return false;
  if (!isObject(content.act3) || !isArray(content.act3.checks)) return false;
  if (!isArray(content.rules) || !isArray(content.answer)) return false;

  /*
   * 두 번째 풀이(§10-6). **없는 것(null·키 없음)은 정상이다** — 모델이 억지로 만들지
   * 않았다는 뜻이고 M4 기록에는 키 자체가 없다. 다만 객체가 **있다면** 화면이
   * `stepsKo.map()`을 태우므로 그 배열까지 확인한다(반쪽짜리 객체가 상세 화면을 터뜨린
   * 실제 사례 — QA P3-5).
   */
  if (content.insight != null) {
    if (!isObject(content.insight) || !isArray(content.insight.stepsKo)) return false;
  }

  // 검산 보고 — 상세 화면이 `heldReasons.map()`·`sceneErrors.length`를 태운다
  const verify = r.verify as Record<string, unknown>;
  if (typeof verify.status !== "string") return false;
  if (!isArray(verify.heldReasons) || !isArray(verify.sceneErrors)) return false;

  return true;
}

/**
 * 레코드 → 화면(`<MathExplanationView>`)이 기대하는 응답 모양.
 * **필드를 옮기기만 한다** — 여기서 답을 손보거나 held를 뒤집으면 저장해 둔 검산 결과가
 * 화면에서 달라진다. `isRenderableExplanation()`을 통과한 레코드에만 쓴다.
 *
 * 예외가 둘 있다: `insight`와 `insightDropped`는 **`??`로 정규화한다**(QA P3-4).
 * M4 시절 저장된 기록에는 두 키가 아예 없어 런타임 값이 `undefined`인데, 반환 타입은
 * `Insight | null`·`boolean`이라고 말한다 — **타입이 거짓말을 하는 상태**다. 지금 화면이
 * truthy 판정이라 무사할 뿐이고, 다음 소비자가 타입을 믿고 `=== null`이나 `!insightDropped`
 * 집계를 쓰면 옛 기록에서 조용히 어긋난다. 되살리는 이 자리에서 조여 두면 소비자가
 * "옛 기록은 undefined일 수 있다"를 기억할 필요가 없어진다(§10-3 · §10-4).
 *
 * 값을 바꾸는 게 아니라 **없는 것을 "없음"으로 적는 것**이라 위 원칙과 부딪히지 않는다:
 * 키가 없다 = 두 번째 풀이가 없었다(§10-2 정상 출력) = `null` · 버린 적 없음 = `false`.
 */
export function toExplainSuccess(record: ExplanationRecord): MathExplainSuccess {
  return {
    ok: true,
    id: record.id,
    content: { ...record.content, insight: record.content.insight ?? null },
    sceneHtml: record.sceneHtml,
    sceneTier: record.sceneTier,
    verify: { ...record.verify, insightDropped: record.verify.insightDropped ?? false },
  };
}

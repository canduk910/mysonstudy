/**
 * lib/ai/math/player.ts — 호출 E(2단 플레이어 HTML) 실행과 파이프라인 연결
 * (docs/harness/math.md §3-4)
 *
 * 세 조각이 여기서 만난다:
 *   - 프롬프트·few-shot : `lib/ai/math/prompts.ts` (§1 파일 배치)
 *   - 출력 스키마       : `lib/ai/math/schemas.ts` (`player_html`)
 *   - 검사·조립         : `lib/scene/html.ts` (정적 검사 · 답 태그 대조 · iframe srcdoc)
 *
 * `lib/scene/html.ts`가 `lib/ai/`를 모르도록 파일을 가른 결과다. 그쪽은 순수 검사·조립이라
 * 실호출 없이 반례를 먹여 볼 수 있고, 화면(클라이언트)이 `buildSceneSrcdoc`을 import해도
 * OpenAI SDK가 딸려 오지 않는다.
 *
 * **서버 전용 모듈이다.** 클라이언트 번들에서 import 금지.
 */

import { callWithSchema, textPart } from "../client";
import { resolveSceneHtml, type SceneHtmlOutcome } from "../../scene/html";
import type { SceneHtmlRenderer } from "./pipeline";
import {
  PLAYER_HTML_CALL_OPTIONS,
  PLAYER_HTML_SYSTEM_MESSAGE,
  buildPlayerHtmlUserMessage,
  type PlayerHtmlUserMessageInput,
} from "./prompts";
import { PLAYER_HTML_JSON_SCHEMA, playerHtmlSchema, type PlayerHtml } from "./schemas";

/**
 * 호출 E 1회 (§3-4: temperature 0.4 · 출력 한도 ~8,000).
 *
 * 시스템 메시지는 **원문 프롬프트 + few-shot HTML**이다(`PLAYER_HTML_SYSTEM_MESSAGE`).
 * few-shot이 프롬프트 문장보다 강하게 작동하므로, 결과물의 모양을 바꾸고 싶으면
 * 문장이 아니라 `PLAYER_HTML_FEWSHOT`을 먼저 고쳐라.
 */
export async function callPlayerHtml(input: PlayerHtmlUserMessageInput): Promise<PlayerHtml> {
  return callWithSchema<PlayerHtml>({
    call: PLAYER_HTML_CALL_OPTIONS.call,
    system: PLAYER_HTML_SYSTEM_MESSAGE,
    user: [textPart(buildPlayerHtmlUserMessage(input))],
    jsonSchema: PLAYER_HTML_JSON_SCHEMA,
    zodSchema: playerHtmlSchema,
    temperature: PLAYER_HTML_CALL_OPTIONS.temperature,
    maxOutputTokens: PLAYER_HTML_CALL_OPTIONS.maxOutputTokens,
  });
}

/**
 * `explainProblem(input, { renderSceneHtml })`에 주입하는 2단 렌더러 (§5-3).
 *
 * 흐름: 호출 E → 정적 검사 + 답 태그 대조 → 걸리면 사유를 실어 **재생성 1회** → 그래도 실패면 null.
 * 파이프라인은 null을 받으면 `sceneTier: 'none'`으로 두고 텍스트 3막만 내보낸다 —
 * **깨진 그림보다 없는 편이 낫다.**
 *
 * 예외도 삼킨다. 호출 E가 죽었다고 3막 설명까지 잃을 이유가 없다(§5-3 "실패 시 null").
 * 다만 **왜 실패했는지는 반드시 남긴다.** 이 로그가 §8이 말한 "다음에 만들 전용 렌더러"의 근거다 —
 * 특정 유형이 2단에서 자주 실패하면 그 유형을 1단으로 승격할 신호다.
 */
export const renderSceneHtml: SceneHtmlRenderer = async ({ problem, explanation }) => {
  let outcome: SceneHtmlOutcome;
  try {
    outcome = await resolveSceneHtml(
      (retryNote) =>
        callPlayerHtml({
          number: problem.number ?? null,
          text: problem.text,
          figureDesc: problem.figureDesc ?? null,
          explanation,
          retryNote,
        }).then((r) => r.html),
      explanation.answer,
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        call: "math-player",
        problemPattern: explanation.problemPattern,
        ok: false,
        thrown: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }

  // §8 운영 로그: 호출 E 수와 실패 사유를 유형별로 집계할 수 있게 problemPattern을 함께 남긴다.
  console.log(
    JSON.stringify({
      call: "math-player",
      problemPattern: explanation.problemPattern,
      ok: outcome.html !== null,
      attempts: outcome.attempts.length,
      failures: outcome.attempts.flatMap((a) => a.failures),
      reasons: outcome.attempts.flatMap((a) => a.reasons),
    }),
  );

  return outcome.html;
};

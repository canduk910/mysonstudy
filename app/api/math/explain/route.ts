/**
 * POST /api/math/explain — 문제 1개 → 3막 설명 (M1) + 설명 기록 저장 (M4)
 *
 * 흐름: zod 입력 검증 → `explainProblem()` (호출 B ∥ 호출 C → 답 비교 + 장면 검산 →
 * 어긋나면 1회 재시도 → `ok`/`held` 판정, docs/harness/math.md §5-3) → 결과 반환.
 * 프롬프트·스키마·검산은 전부 `lib/ai/math/`·`lib/scene/` 소관이다. 이 라우트는
 * **입력을 다듬어 넘기고 결과를 그대로 내려주는 일만** 한다 — 여기서 답을 손보거나
 * held를 뒤집으면 검산 두 겹이 하는 일이 없어진다.
 *
 * [M4] 파이프라인 성공 직후 `explanations`에 **자동 저장**한다(§9-3).
 *   - `held`도 저장한다 — 보류율 집계가 §8의 목적이고, 접어 둔 답도 부모가 나중에 볼 근거다.
 *   - **best-effort**: 저장 실패가 설명을 죽이면 안 된다. try/catch로 감싸고 실패하면
 *     로그만 남긴 뒤 `id: null`로 응답한다.
 *   - 저장은 결과를 바꾸지 않는다. 금지된 것은 답을 손보거나 held를 뒤집는 일이지
 *     기록을 남기는 일이 아니다.
 *
 * ┌─ 호출 E(2단 플레이어 HTML) 주입 [M2.5] ──────────────────────────────────────┐
 * │ `explainProblem(problem, { renderSceneHtml })` — 두 번째 인자가 **2단 렌더러다.**│
 * │ (M1까지는 이 자리가 비어 있었고 `sceneHtml`이 항상 null이었다. 이제 아니다.)      │
 * │                                                                              │
 * │ 주입은 이 라우트에서만 한다. `renderSceneHtml`은 `lib/ai/math/player.ts`의       │
 * │ **서버 전용** 값이라 클라이언트 컴포넌트가 import하면 OpenAI SDK와 API 키가       │
 * │ 브라우저 번들로 따라간다 — 화면은 결과(`sceneHtml` 문자열)만 받는다.             │
 * │                                                                              │
 * │ 언제 무엇이 나오는가 (§5-3):                                                   │
 * │   - 1단 장면(`content.scene`)이 있으면 → `sceneTier: 'typed'`, 호출 E는 안 나간다 │
 * │   - `status === 'ok'` + 1단 없음 + `sceneHtmlRequest` → 호출 E → `'html'`       │
 * │   - 호출 E가 검사(정적·답 태그)를 두 번 다 못 넘기면 null → `'none'`             │
 * │ **`held`면 2단을 만들지 않는다.** 답이 흔들리는데 그림까지 그리면 틀린 답을        │
 * │ 움직이는 그림으로 가르치게 된다 — 파이프라인이 막는다(여기서 뒤집지 마라).        │
 * │                                                                              │
 * │ 렌더러는 실패해도 던지지 않는다. 그림이 없다고 3막 설명까지 잃을 이유가 없다.      │
 * │ 그래서 "그림이 왜 안 나오지?"는 조용하다 — 사유는 `{call:"math-player"}` 로그에.  │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 응답 shape (단일 정의처는 `lib/math-explain-contract.ts`):
 * - 200 { ok: true, id, content, sceneHtml, sceneTier, verify }   ← **held도 200이다**
 *       (`id`는 저장된 기록의 id. 저장에 실패했으면 null — 설명은 그대로 온다)
 * - 400 { ok: false, error: "invalid_input", messageKo, issues }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }   ← 재시도 소진(throw)
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * (401 locked / 503 not_configured는 proxy.ts가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveModel } from "@/lib/ai/client";
import { explainProblem } from "@/lib/ai/math/pipeline";
import { renderSceneHtml } from "@/lib/ai/math/player";
import type { MathExplainSuccess } from "@/lib/math-explain-contract";
import { getStore, type MathProblemInput } from "@/lib/store";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// 입력 스키마 — HARNESS §3-2 템플릿이 받는 값 그대로
// ---------------------------------------------------------------------------

/**
 * `retryNote`는 **의도적으로 없다.** zod object는 모르는 키를 조용히 버리므로,
 * 클라이언트가 `retryNote`를 실어 보내도 프롬프트에 닿지 않는다.
 * (파이프라인 내부 값이다 — 열어 두면 "이전 답이 틀렸다"는 거짓 맥락으로 모델을 흔들 수 있다.)
 *
 * 길이 상한은 프롬프트 폭주 방지용 안전장치다. 초등 문제 문장은 길어야 몇 줄이라
 * 2,000자면 서술형까지 넉넉히 덮는다.
 */
const bodySchema = z.object({
  text: z.string().trim().min(1, "문제 문장을 적어 주세요.").max(2000),
  number: z.string().trim().max(20).nullish(),
  figureDesc: z.string().trim().max(2000).nullish(),
  givens: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        value: z.number(),
        unit: z.string().trim().max(20).nullish(),
      }),
    )
    .max(30)
    .nullish(),
  childAnswer: z.string().trim().max(500).nullish(),
  childWork: z.string().trim().max(2000).nullish(),
  childNote: z.string().trim().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// 응답 헬퍼
// ---------------------------------------------------------------------------

function invalidInput(error: z.ZodError) {
  return NextResponse.json(
    {
      ok: false,
      error: "invalid_input",
      messageKo: "입력 내용을 확인해 주세요.",
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // 키가 없으면 아무 일도 하지 않고 명시적으로 알린다 (로컬 데모 배려 — 영어 라우트와 같은 규약)
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      { status: 501 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "요청 본문이 올바른 JSON이 아니에요.",
        issues: [],
      },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;

  // 파이프라인 입력을 **키 하나씩 명시적으로** 짓는다. `{...input}` 스프레드를 쓰면
  // 나중에 스키마에 필드가 늘었을 때 무엇이 프롬프트로 나가는지 이 자리에서 안 보인다.
  //
  // 타입이 `ExplainProblemInput`이 아니라 `MathProblemInput`(§9-1)인 것은 의도다 —
  // **프롬프트에 넣은 값과 기록에 남는 값이 같은 객체 하나**여야 "무엇을 물었는지"가
  // 어긋나지 않는다. 선택 키가 없는 필수 nullable 모양이라 그대로 `explainProblem()`에
  // 넘길 수 있고, 저장 시 undefined가 섞여 Firestore가 거부하는 일도 없다.
  const problem: MathProblemInput = {
    number: input.number ?? null,
    text: input.text,
    figureDesc: input.figureDesc ?? null,
    givens: input.givens?.map((g) => ({ label: g.label, value: g.value, unit: g.unit ?? null })) ?? null,
    childAnswer: input.childAnswer ?? null,
    childWork: input.childWork ?? null,
    childNote: input.childNote ?? null,
  };

  try {
    // [M2.5] 2단 렌더러 주입 — 파일 상단 주석 참조. 호출 E가 실제로 나가는 유일한 자리다.
    const result = await explainProblem(problem, { renderSceneHtml });

    // [M4 §9-3] 자동 저장 — best-effort. 여기서 던져도 설명은 그대로 내려간다.
    let id: string | null = null;
    try {
      const saved = await getStore().createExplanation({
        problem,
        content: result.content,
        sceneHtml: result.sceneHtml,
        sceneTier: result.sceneTier,
        verify: result.verify,
        // 기록에 남길 모델은 **호출 B(설명)를 만든 모델**이다. 검산(호출 C)은
        // `OPENAI_MODEL_VERIFY`로 따로 갈 수 있지만, 저장하는 `content`를 지은 것은 B다.
        model: resolveModel(),
      });
      id = saved.id;
    } catch (err) {
      // 로그만 남기고 계속 간다 — 사용자에게는 설명이 본체다.
      console.error("[/api/math/explain] 설명 기록 저장 실패(설명은 그대로 반환):", err);
    }

    const payload: MathExplainSuccess = {
      ok: true,
      id,
      content: result.content,
      sceneHtml: result.sceneHtml,
      sceneTier: result.sceneTier,
      verify: result.verify,
    };
    // held도 200이다. 설명은 온전하고 답만 접으면 되므로 오류로 만들지 않는다(§5-3).
    return NextResponse.json(payload);
  } catch (err) {
    // 여기까지 오는 것은 호출 B가 1회 재요청까지 쓰고도 스키마를 못 맞춘 경우다.
    // (호출 C는 실패해도 던지지 않는다 — 파이프라인이 held로 흡수한다.)
    console.error("[/api/math/explain] 설명 생성 실패:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "ai_failed",
        messageKo:
          "설명을 만들다가 문제가 생겼어요. 잠시 후 '다시 만들기'를 눌러 주세요.",
        retriable: true,
      },
      { status: 500 },
    );
  }
}

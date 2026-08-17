/**
 * POST /api/math/explain — 문제 1개 → 3막 설명 (M1)
 *
 * 흐름: zod 입력 검증 → `explainProblem()` (호출 B ∥ 호출 C → 답 비교 + 장면 검산 →
 * 어긋나면 1회 재시도 → `ok`/`held` 판정, docs/harness/math.md §5-3) → 결과 반환.
 * 프롬프트·스키마·검산은 전부 `lib/ai/math/`·`lib/scene/` 소관이다. 이 라우트는
 * **입력을 다듬어 넘기고 결과를 그대로 내려주는 일만** 한다 — 여기서 답을 손보거나
 * held를 뒤집으면 검산 두 겹이 하는 일이 없어진다.
 *
 * 저장 없음(M1). 만든 설명을 화면에 보여주기만 하고 새로고침하면 사라진다.
 * Firestore `explanations` 컬렉션은 M4다.
 *
 * ┌─ 호출 E(2단 플레이어 HTML)를 왜 안 부르는가 ─────────────────────────────────┐
 * │ `explainProblem(input, { renderSceneHtml })`의 두 번째 인자를 **일부러 비워 둔다.**│
 * │ 미주입은 버그가 아니라 M1의 정상 상태다:                                        │
 * │   - `sceneHtml`은 항상 null (2단 그림은 M2.5에서 player-builder가 붙인다)        │
 * │   - 1단 장면(`content.scene`)이 있으면 `sceneTier: 'typed'`,                    │
 * │     없으면 `'none'`. **`'html'`은 M1에서 절대 나오지 않는다.**                   │
 * │ 파이프라인이 주입 방식인 이유는 (1) 2단 구현에 컴파일 타임으로 묶이지 않고        │
 * │ (2) held·재시도 흐름을 실호출 없이 스텁으로 돌리기 위해서다.                     │
 * │ 조용히 null이 되므로 "그림이 왜 안 나오지?"를 버그로 오해하기 쉽다 — 그때         │
 * │ 고칠 곳은 이 라우트(렌더러 주입)이지 pipeline.ts가 아니다.                      │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 응답 shape (단일 정의처는 `lib/math-explain-contract.ts`):
 * - 200 { ok: true, content, sceneHtml, sceneTier, verify }   ← **held도 200이다**
 * - 400 { ok: false, error: "invalid_input", messageKo, issues }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }   ← 재시도 소진(throw)
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * (401 locked / 503 not_configured는 proxy.ts가 이 핸들러 앞에서 내려보낸다)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { explainProblem, type ExplainProblemInput } from "@/lib/ai/math/pipeline";
import type { MathExplainSuccess } from "@/lib/math-explain-contract";

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
  const problem: ExplainProblemInput = {
    number: input.number ?? null,
    text: input.text,
    figureDesc: input.figureDesc ?? null,
    givens: input.givens ?? null,
    childAnswer: input.childAnswer ?? null,
    childWork: input.childWork ?? null,
    childNote: input.childNote ?? null,
  };

  try {
    // 두 번째 인자(호출 E 렌더러)를 넘기지 않는 것이 M1의 정상 상태다 — 파일 상단 주석 참조.
    const result = await explainProblem(problem);

    const payload: MathExplainSuccess = {
      ok: true,
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

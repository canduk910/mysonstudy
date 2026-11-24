/**
 * scripts/smoke-anthropic-schemas.ts — Claude 실호출 스모크 게이트: 저장소의 strict JSON Schema 전부를 Claude 구조화 출력에 **1회씩** 보낸다.
 * (docs/HARNESS.md §5 — `AI_PROVIDER=anthropic`으로 바꾸기 전 확인용. **비용이 드는 실호출**이다.)
 *
 * 왜: 스키마 컴파일 거부·beta(fallbacks) 미지원은 400으로 오고, 백업 판정(decideFallback)은 400을 넘기지 않는다 — Anthropic 모드에서
 * 그 기능이 백업 없이 통째로 깨진다. 오프라인 점검(eval:provider의 validateClaudeSchema)은 흔한 원인만 잡으므로, 실제 수용 여부는 여기서 본다.
 *
 * 게이트(둘 다 아니면 **네트워크 전에** 즉시 종료):
 *   - env `SMOKE_ANTHROPIC=1`
 *   - env `ANTHROPIC_API_KEY`(빈 값 = 없음)
 * 에이전트는 실행하지 않는다 — 오케스트레이터가 사용자 동의를 받은 뒤:
 *   SMOKE_ANTHROPIC=1 ANTHROPIC_API_KEY=… OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= npx tsx scripts/smoke-anthropic-schemas.ts
 *   (선택) SMOKE_ONLY=<스키마 이름 일부> — 그 스키마만.
 *
 * 비용: 스키마 39개 × 1요청(effort low, max_tokens = CLAUDE_MIN_MAX_TOKENS 8,000 — 상한일 뿐 과금은 실제 생성분, 입력 수백 토큰·출력 수백~수천 토큰). 재요청·백업 없음 — callWithSchema를 거치지 않고
 * 같은 순수 조립 함수(buildClaudeRequest)로 직접 보낸다(zod는 과목 입력마다 달라 여기서는 JSON 파싱까지만 본다).
 * 저장소·DB를 건드리지 않는다. 출력은 스키마 이름·결과·stop_reason·토큰·오류 요약뿐(모델 출력 본문은 찍지 않는다).
 */

const gateOn = process.env.SMOKE_ANTHROPIC === "1";
const hasKey = (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "";
if (!gateOn || !hasKey) {
  console.log(
    `smoke-anthropic-schemas: 건너뜀 — ${!gateOn ? "SMOKE_ANTHROPIC=1이 아님" : "ANTHROPIC_API_KEY 없음"} (실호출 0회).`,
  );
  process.exit(0);
}

async function main(): Promise<void> {
  // 게이트를 지난 뒤에만 SDK·클라이언트를 불러온다
  const { getAnthropicClient } = await import("../lib/ai/client");
  const { buildClaudeRequest, interpretClaudeResponse, claudeUsageTokens, CLAUDE_MIN_MAX_TOKENS } = await import("../lib/ai/provider-anthropic");
  const { resolveAnthropicModel } = await import("../lib/ai/provider");
  const { summarizeProviderError } = await import("../lib/ai/provider-errors");
  const { collectStrictSchemas } = await import("./provider-schemas");

  const only = process.env.SMOKE_ONLY?.trim() ?? "";
  const schemas = (await collectStrictSchemas()).filter((s) => only === "" || s.name.includes(only));
  const model = resolveAnthropicModel();
  console.log(`smoke-anthropic-schemas: ${schemas.length}개 스키마 → ${model} (effort low, 1회씩)`);

  const rows: { name: string; ok: boolean; detail: string }[] = [];
  let inTok = 0;
  let outTok = 0;
  for (const s of schemas) {
    const params = buildClaudeRequest({
      model,
      system: "You are a schema conformance tester. Output one small JSON object that matches the required schema. Keep every string very short and every array at most 2 items.",
      user: [{ type: "input_text", text: `Produce a minimal valid example for the "${s.name}" schema.` }],
      schema: s.schema,
      maxOutputTokens: CLAUDE_MIN_MAX_TOKENS, // 조립 함수가 어차피 이 하한으로 올린다 — 표기를 실제 값과 맞춘다
      effort: "low",
    });
    try {
      const res = await getAnthropicClient().beta.messages.create(params, { maxRetries: 1 });
      const used = claudeUsageTokens(res.usage);
      inTok += used.inputTokens;
      outTok += used.outputTokens;
      const outcome = interpretClaudeResponse(res);
      let parsed = false;
      try {
        JSON.parse(outcome.raw);
        parsed = true;
      } catch {}
      rows.push({
        name: s.name,
        ok: outcome.kind === "text" && parsed,
        detail: `stop=${res.stop_reason} · json=${parsed} · model=${res.model} · in/out=${used.inputTokens}/${used.outputTokens}`,
      });
    } catch (e) {
      rows.push({ name: s.name, ok: false, detail: summarizeProviderError(e) });
    }
  }

  console.log("");
  console.log("| 결과 | 스키마 | 상세 |");
  console.log("|------|--------|------|");
  for (const r of rows) console.log(`| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.detail} |`);
  const failed = rows.filter((r) => !r.ok);
  console.log("");
  console.log(`${failed.length === 0 ? "PASS" : "FAIL"} — ${rows.length - failed.length}/${rows.length}개 스키마 수용 · 토큰 합계 in ${inTok} / out ${outTok}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

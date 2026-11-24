/**
 * lib/ai/mom/calls.ts — 엄마의 생활영어 호출 M1(주간 테스트 총평) 진입 함수 (**서버 전용**, 설계 §5·§8).
 * 공유 래퍼 `callWithSchema`를 그대로 부른다. 모델은 기본 텍스트 모델(resolveModel). 키 검사(501)는 라우트가 먼저 한다.
 * 재요청까지 실패하면 throw — 라우트가 500으로 바꾼다. ⚠️ 클라이언트 컴포넌트에서 import 금지.
 */
import type { MomVerdict } from "../../mom-contract";
import { callWithSchema, resolveModel, textPart } from "../client";
import { MOM_SUMMARY_CALL_OPTIONS, MOM_SUMMARY_SYSTEM_PROMPT, buildMomSummaryUserMessage } from "./prompts";
import { MOM_SUMMARY_JSON_SCHEMA, momSummaryZod } from "./schemas";

export async function summarizeMomTest(
  items: readonly { ko: string; en: string; transcript: string | null; verdict: MomVerdict }[],
  signal?: AbortSignal,
): Promise<{ goodKo: string; fixKo: string }> {
  return callWithSchema({
    ...MOM_SUMMARY_CALL_OPTIONS,
    system: MOM_SUMMARY_SYSTEM_PROMPT,
    user: [textPart(buildMomSummaryUserMessage(items))],
    jsonSchema: MOM_SUMMARY_JSON_SCHEMA,
    zodSchema: momSummaryZod,
    model: resolveModel(),
    signal,
  });
}

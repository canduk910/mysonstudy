/**
 * POST /api/phrase-helper — 표현 도우미: 한국어 단어·구·문장 → 가장 회화적인 표현 + 예문 (SPEC §22, docs/harness/phrase-helper.md §8·§13)
 *
 * 본문 `{ mode, input }`(lib/phrase-helper-contract.ts PhraseHelperRequest). 진입 함수 `explainPhrase`(lib/ai/phrase-helper/calls.ts)를
 * 한 번 부르고, **저장하지 않는다**(결과·입력 모두). PIN 게이트는 proxy.ts가 앞에서 한다.
 *
 * ── 검사 순서 ─────────────────────────────────────────────────────────────
 * 1. 키(501) — **맨 먼저**(본문도 읽기 전에). 키를 비운 로컬은 실호출이 구조적으로 0이다.
 *    (한글이 없는 입력은 explainPhrase가 키 없이도 로컬 안내를 돌려줄 수 있지만, 키 없는 환경에서는 501이 먼저 난다 — 스펙 §8 허용.)
 * 2. 선언 길이·실제 바이트가 PHRASE_HELPER_BODY_MAX_BYTES(4 KiB)를 넘으면 413 — 해석하지 않는다.
 * 3. 400 — JSON 아님·모양(zod: mode enum·input 문자열) 위반·입력 거부(PhraseHelperInputError의 messageKo 그대로).
 * 4. explainPhrase(mode, input, { signal: req.signal }) — 진입 함수가 30초 상한과 이 신호를 합친다. 화면이 끊으면 상류도 멈춘다.
 *    성공 200 { ok:true, result } · 끊김 499 · 그 밖 500 ai_failed retriable.
 *
 * 로그에 입력·결과 글을 남기지 않는다(오류 이름과 ms만 — 공유 래퍼의 토큰 로그 한 줄은 따로 난다).
 *
 * 응답 shape(단일 정의처 lib/phrase-helper-contract.ts PhraseHelperResponse):
 * - 200 { ok:true, result: PhraseHelperResult }
 * - 400 { ok:false, error:"invalid_input", messageKo }
 * - 413 { ok:false, error:"body_too_large", messageKo }
 * - 499 { ok:false, error:"client_closed", messageKo }
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { explainPhrase, isPhraseHelperInputError } from "@/lib/ai/phrase-helper/calls";
import { PHRASE_HELPER_MODES } from "@/lib/phrase-helper";
import { PHRASE_HELPER_BODY_MAX_BYTES, type PhraseHelperRequest, type PhraseHelperResponse } from "@/lib/phrase-helper-contract";

export const runtime = "nodejs";

function json(body: PhraseHelperResponse, status = 200) {
  return NextResponse.json(body, { status });
}

const bodySchema = z.object({
  mode: z.enum(PHRASE_HELPER_MODES),
  input: z.string(),
});
type BodyInput = z.infer<typeof bodySchema>;
// 화면 계약 ↔ 라우트 zod를 양방향으로 묶는다(한쪽 필드명만 바뀌면 컴파일 오류)
const requestMatchesSchema: [PhraseHelperRequest, BodyInput] extends [BodyInput, PhraseHelperRequest] ? true : never = true;
void requestMatchesSchema;

const TOO_LARGE_KO = "보낸 글이 너무 커요.";

export async function POST(req: Request) {
  // ── 1. 키 — 맨 먼저 ──
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 표현 도우미를 쓸 수 없어요." }, 501);
  }

  // ── 2. 본문 크기 — 선언 길이로 먼저, 읽은 뒤 실제 바이트로 한 번 더 ──
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PHRASE_HELPER_BODY_MAX_BYTES) {
    return json({ ok: false, error: "body_too_large", messageKo: TOO_LARGE_KO }, 413);
  }
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청을 읽지 못했어요." }, 400);
  }
  if (new TextEncoder().encode(rawText).byteLength > PHRASE_HELPER_BODY_MAX_BYTES) {
    return json({ ok: false, error: "body_too_large", messageKo: TOO_LARGE_KO }, 413);
  }

  // ── 3. 형식 ──
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 형식(JSON)이 올바르지 않아요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "모드나 입력이 올바르지 않아요." }, 400);
  }

  // ── 4. 호출 ──
  const started = Date.now();
  try {
    const result = await explainPhrase(parsed.data.mode, parsed.data.input, { signal: req.signal });
    return json({ ok: true, result });
  } catch (err) {
    if (isPhraseHelperInputError(err)) return json({ ok: false, error: "invalid_input", messageKo: err.messageKo }, 400);
    if (req.signal.aborted) return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    const name = err instanceof Error ? err.constructor?.name || err.name : typeof err;
    console.error(`[/api/phrase-helper] 실패 mode=${parsed.data.mode} ${name} ${Date.now() - started}ms`);
    return json({ ok: false, error: "ai_failed", messageKo: "답을 받지 못했어요. 잠시 뒤 다시 물어봐 주세요.", retriable: true }, 500);
  }
}

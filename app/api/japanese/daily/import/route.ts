/**
 * POST /api/japanese/daily/import — 🗓️ 오늘의 일본어 내용 파일(`ja-daily/v1`) 가져오기(설계 §2-1). AI 없음 · 키 검사 없음.
 *
 * 문서 단위 upsert(과·날·요령·청해 문항·모의 회차) — 해시가 같으면 그대로, 바뀐 것만 갱신, **파일에 없는 것은 지우지 않는다**.
 * 200 { ok:true, result: { lesson|vocab|tip|litem|mock: {added, updated, unchanged} } } · 400 invalid_input(+issues) · 413 too_large · 500 save_failed.
 * 응답 shape 정의처: lib/ja-daily-contract.ts `JaDailyImportResponse`. 로그에 내용을 남기지 않는다(문서 수만).
 */
import { NextResponse } from "next/server";
import { jaDailyImportFileSchema } from "@/lib/ja-daily-content";
import type { JaDailyImportResponse } from "@/lib/ja-daily-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 6MB 상한(반입 파일 실측 1~2MB) */
const JA_DAILY_IMPORT_MAX_BYTES = 6 * 1024 * 1024;

function json(body: JaDailyImportResponse, status = 200) {
  return NextResponse.json(body, { status });
}
const tooLarge = () => json({ ok: false, error: "too_large", messageKo: "파일이 너무 커요(6MB까지)." }, 413);

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > JA_DAILY_IMPORT_MAX_BYTES) return tooLarge();
  let text: string;
  try {
    text = await req.text();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "파일을 읽지 못했어요." }, 400);
  }
  // 길이 머리가 없거나 틀린 요청도 실제 바이트로 한 번 더
  if (Buffer.byteLength(text, "utf8") > JA_DAILY_IMPORT_MAX_BYTES) return tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요." }, 400);
  }
  const parsed = jaDailyImportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
    return json({ ok: false, error: "invalid_input", messageKo: "가져오기 파일 형식이 맞지 않아요.", issues }, 400);
  }
  try {
    const result = await getStore().importJaDailyContent(parsed.data, new Date().toISOString());
    const changed = Object.values(result).reduce((n, c) => n + c.added + c.updated, 0);
    console.log(`[ja-daily/import] 문서 갱신 ${changed}`);
    return json({ ok: true, result });
  } catch (err) {
    console.error("[ja-daily/import] 저장 실패", err);
    return json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, 500);
  }
}

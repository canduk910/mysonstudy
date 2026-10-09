/** POST /api/mom/import — 엄마의 생활영어 가져오기 파일(mom-english/v1). AI 없음. 블록 id upsert(해시 같으면 그대로). */
import { NextResponse } from "next/server";
import { momImportFileSchema } from "@/lib/mom-content";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", messageKo: "파일이 너무 커요(5MB까지)." }, { status: 413 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요." }, { status: 400 });
  }
  const parsed = momImportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ ok: false, error: "invalid_input", messageKo: "가져오기 파일 형식이 맞지 않아요.", issues }, { status: 400 });
  }
  try {
    const result = await getStore().importMomContent(parsed.data, new Date().toISOString());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[mom/import] 저장 실패", err);
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, { status: 500 });
  }
}

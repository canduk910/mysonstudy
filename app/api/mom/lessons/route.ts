/**
 * POST /api/mom/lessons — 끝낸 하루 레슨 기록 저장(설계 §4·§6-2). AI 없음.
 * 본문 = MomLessonRecord. id 멱등 — 같은 id를 다시 보내면 저장된 기록을 그대로 돌려준다(reused: true).
 * 화면은 레슨을 끝까지 했을 때만 보낸다 — 끝나지 않은 기록(finishedAt null)은 받지 않는다.
 */
import { NextResponse } from "next/server";
import { momLessonSaveSchema } from "@/lib/mom-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 64 * 1024;

function bad(messageKo: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error: "invalid_input", messageKo, ...extra }, { status: 400 });
}

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", messageKo: "기록이 너무 커요." }, { status: 413 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return bad("JSON이 아니에요.");
  }
  const parsed = momLessonSaveSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));
    return bad("레슨 기록 형식이 맞지 않아요.", { issues });
  }
  const data = parsed.data;
  if (data.finishedAt === null) return bad("끝낸 레슨만 저장해요");
  try {
    const { reused } = await getStore().saveMomLesson(data);
    return NextResponse.json({ ok: true, reused });
  } catch (err) {
    console.error("[mom/lessons] 저장 실패", err);
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, { status: 500 });
  }
}

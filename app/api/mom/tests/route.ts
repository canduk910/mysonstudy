/**
 * POST /api/mom/tests — 끝낸 주간 테스트 기록 저장(설계 §5·§6-2). AI 없음.
 * 본문 = MomTestRecord(summaryKo 빼고). id 멱등 — 같은 id를 다시 보내면 저장된 기록을 그대로 돌려준다(reused: true).
 * 화면은 테스트를 끝까지 했을 때만 보낸다 — 끝나지 않은 기록(finishedAt null)은 받지 않는다. 녹음은 오지 않는다(기기에만).
 * 주 번호는 실제 주 1~52 또는 자동 감속 가상 복습 주 101~152(isMomVirtualWeek)만.
 */
import { NextResponse } from "next/server";
import { momTestSaveSchema } from "@/lib/mom-contract";
import { isMomTestWeek } from "@/lib/mom-plan";
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
  const parsed = momTestSaveSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));
    return bad("테스트 기록 형식이 맞지 않아요.", { issues });
  }
  const data = parsed.data;
  if (data.finishedAt === null) return bad("끝낸 테스트만 저장해요");
  if (!isMomTestWeek(data.week)) return bad("주 번호가 맞지 않아요.");
  if (data.items.length === 0) return bad("문항이 없어요.");
  try {
    const { record, reused } = await getStore().saveMomTest(data);
    return NextResponse.json({ ok: true, reused, id: record.id });
  } catch (err) {
    console.error("[mom/tests] 저장 실패", err);
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, { status: 500 });
  }
}

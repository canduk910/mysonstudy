/**
 * POST /api/japanese/daily/sessions — 끝낸 회차 기록 저장(설계 §4 끝·§6). AI 없음 · 키 검사 없음.
 *
 * 본문 = JaDailySessionRecord(lib/ja-daily-contract `jaDailySessionSaveSchema`). 화면은 회차를 끝까지 했을 때만 보낸다(칸 건너뜀 포함).
 * - 같은 id 재전송 → 본문이 같으면 200 { ok:true, reused:true }(그대로), 다르면 409 id_conflict(QA daily1 P3-a)
 * - 진도 회차(replay:false)는 n ≤ 다음 회차만 — 앞질러 저장 400(nextN). 다시 하기(replay:true)는 진도 기록으로 끝낸 n만 — 아니면 400.
 * 200 { ok:true, reused } · 400 invalid_input · 409 id_conflict · 413 too_large(선언 길이·실제 바이트 두 번) · 500 save_failed.
 * 앞질러 저장 판정과 생성 사이는 원자 단위가 아니다 — 겹쳐도 같은 회차가 두 번 저장될 뿐(진도·스트릭 무해)이라 트랜잭션을 두지 않았다.
 */
import { NextResponse } from "next/server";
import { decideJaDailySave, jaDailySessionSaveSchema, type JaDailySaveResponse } from "@/lib/ja-daily-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 128 * 1024;

function json(body: JaDailySaveResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BYTES) return json({ ok: false, error: "too_large", messageKo: "기록이 너무 커요." }, 413);
  // 실제 읽은 바이트로도 상한(content-length가 없거나 틀려도 — QA daily1 P3-b)
  let text: string;
  try {
    text = await req.text();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "본문을 읽지 못했어요." }, 400);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return json({ ok: false, error: "too_large", messageKo: "기록이 너무 커요." }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "JSON이 아니에요." }, 400);
  }
  const parsed = jaDailySessionSaveSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
    return json({ ok: false, error: "invalid_input", messageKo: "회차 기록 형식이 맞지 않아요.", issues }, 400);
  }
  const rec = parsed.data;
  try {
    const store = getStore();
    const decision = decideJaDailySave(rec, await store.listJaDailySessions());
    if (decision.kind === "reused") return json({ ok: true, reused: true });
    if (decision.kind === "conflict") return json({ ok: false, error: "id_conflict", messageKo: "같은 기록 id로 다른 내용이 왔어요. 화면을 새로 고쳐 다시 해 주세요." }, 409);
    if (decision.kind === "ahead") return json({ ok: false, error: "invalid_input", messageKo: `아직 그 회차 차례가 아니에요 — 지금은 Day ${decision.next} 차례예요.`, nextN: decision.next }, 400);
    if (decision.kind === "replay_not_done") return json({ ok: false, error: "invalid_input", messageKo: "끝낸 회차만 다시 할 수 있어요." }, 400);
    const { reused } = await store.saveJaDailySession(rec);
    return json({ ok: true, reused });
  } catch (err) {
    console.error("[ja-daily/sessions] 저장 실패", err);
    return json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 뒤 다시 해 주세요." }, 500);
  }
}

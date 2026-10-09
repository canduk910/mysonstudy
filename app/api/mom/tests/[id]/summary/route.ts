/**
 * POST /api/mom/tests/[id]/summary — 주간 테스트 AI 총평(호출 M1, 설계 §5·§8). 테스트당 1회.
 *
 * 순서: 1. 테스트 없음 404 2. 이미 저장된 summaryKo가 있으면 그대로 200(키 없이도 — 재전송은 호출 0회)
 * 3. 키 없음 501 4. 블록에서 문항 문장(ko·en) 조회 → summarizeMomTest → setMomTestSummary → 200 { ok:true, summaryKo } / 실패 500.
 * 입력은 문항별 (한국어 뜻, 목표 문장, 받아쓰기, 판정)만 — 녹음은 없다. 실패해도 테스트 기록은 그대로다(총평 없이).
 */
import { NextResponse } from "next/server";
import { summarizeMomTest } from "@/lib/ai/mom/calls";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 총평 호출 기다림 상한(ms) */
const MOM_SUMMARY_TIMEOUT_MS = 45_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();
  const test = (await store.listMomTests()).find((t) => t.id === id) ?? null;
  if (!test) return NextResponse.json({ ok: false, error: "not_found", messageKo: "테스트 기록이 없어요." }, { status: 404 });

  // 이미 받은 총평은 다시 만들지 않는다(재전송 = 호출 0회)
  if (test.summaryKo) return NextResponse.json({ ok: true, summaryKo: test.summaryKo, reused: true });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "no_api_key", messageKo: "AI 총평은 아직 쓸 수 없어요. 결과는 그대로 볼 수 있어요." }, { status: 501 });
  }

  const blocks = await store.listMomBlocks();
  const byId = new Map<string, { ko: string; en: string }>();
  for (const b of blocks) for (const s of b.sentences) byId.set(s.id, { ko: s.ko, en: s.en });
  const items = test.items.flatMap((it) => {
    const s = byId.get(it.sentenceId);
    return s ? [{ ko: s.ko, en: s.en, transcript: it.transcript, verdict: it.verdict }] : [];
  });
  if (items.length === 0) return NextResponse.json({ ok: false, error: "no_items", messageKo: "문항 문장을 찾지 못했어요." }, { status: 422 });

  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(MOM_SUMMARY_TIMEOUT_MS)]);
    const summary = await summarizeMomTest(items, signal);
    const saved = await store.setMomTestSummary(id, summary);
    return NextResponse.json({ ok: true, summaryKo: saved?.summaryKo ?? summary, reused: false });
  } catch (err) {
    console.error("[mom/tests/summary] 총평 실패", err instanceof Error ? err.name : "error");
    return NextResponse.json({ ok: false, error: "summary_failed", messageKo: "AI 총평을 만들지 못했어요. 결과는 그대로예요." }, { status: 500 });
  }
}

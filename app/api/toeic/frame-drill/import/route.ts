/**
 * POST /api/toeic/frame-drill/import — 소재별 틀 말하기 문제 은행 "파일로 가져오기" (docs/harness/toeic.md §20-3·§20-10, SPEC §20-17)
 *
 * 형식 `toeic-frame-drill/v1`. 문제 은행은 교재·강의 유래라 저장소(PUBLIC)에 넣지 않고 git 밖 파일(`data/private/`)로 둔다 —
 * 프로덕션에 넣는 것은 사용자가 앱에서 파일을 고르는 행동이다(로컬에서 프로덕션 DB로 쓰지 않는다).
 *
 * - 검증: `toeicFrameDrillFileSchema`(lib/ai/toeic/frame-drill-schemas — 소재·틀·문항 연결, 틀 글자 규칙은 틀 은행과 같은 함수,
 *   en = fillFrame(frameEn, fills) 글자까지, 은행 바이트 상한). 통과 못 하면 400 — 본문은 `toeicFrameDrillImportInvalidBody`가
 *   **그대로** 만든다(경로 + 규칙만, 값 없음).
 * - 저장: 스토어 `importToeicFrameDrill` — 지금 은행을 읽어 `mergeFrameDrillImport`(id가 정체성 — 같은 id면 createdAt을 이어받고,
 *   AI 문항은 남기되 시드와 겹치면 버린다) → 바뀌었을 때만 **은행 문서만** 쓴다. 통계 문서는 건드리지 않는다(다시 가져와도 오답 통계가
 *   이어진다). 같은 파일 두 번 = unchanged(쓰기 0). 읽기·병합·쓰기가 한 원자 단위.
 * - AI·키 검사·prod-guard 없음(생성·수정 — 키가 없어도 동작).
 * - 원문 누출 방지: 본문·파싱 결과를 로그에 찍지 않는다(개수·오류 이름만). 응답에는 개수만 싣는다.
 *
 * 응답 shape (단일 정의처 `lib/toeic-frame-drill-contract.ts` ToeicFrameDrillImportResponse):
 * - 200 { ok:true, created, updated, removed, aiKept, aiDropped, unchanged, topics, frames, items }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }   ← issues ≤ 20, { path, message }(값 없음)
 * - 413 { ok:false, error:"too_large", messageKo }               ← 지금 은행의 AI 문항과 합치니 문서 상한을 넘었다(아무것도 쓰지 않음)
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { toeicFrameDrillFileSchema, toeicFrameDrillImportInvalidBody } from "@/lib/ai/toeic/frame-drill-schemas";
import { getStore } from "@/lib/store";
import type { ToeicFrameDrillImportResponse } from "@/lib/toeic-frame-drill-contract";
import { toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

function json(body: ToeicFrameDrillImportResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요. 틀 말하기 문제 파일(.json)을 골라 주세요.", issues: [] }, 400);
  }

  const parsed = toeicFrameDrillFileSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    console.warn(`[/api/toeic/frame-drill/import] 형식 거부: 문제 ${parsed.error.issues.length}곳`);
    return json(toeicFrameDrillImportInvalidBody(parsed.error.issues), 400);
  }

  const nowIso = new Date().toISOString(); // 원자 단위 밖에서 한 번 — 트랜잭션이 재시도해도 같은 시각
  try {
    const r = await getStore().importToeicFrameDrill(parsed.data, nowIso);
    if (r.kind === "too_large") {
      console.warn(`[/api/toeic/frame-drill/import] 합친 은행 ${r.bytes}바이트 — 쓰지 않음`);
      return json({ ok: false, error: "too_large", messageKo: "지금 은행의 새 문제와 합치니 저장 한도를 넘어요. 파일의 문항 수를 줄여 주세요." }, 413);
    }
    const x = r.result;
    const body: ToeicFrameDrillImportResponse = {
      ok: true,
      created: x.created,
      updated: x.updated,
      removed: x.removed,
      aiKept: x.aiKept,
      aiDropped: x.aiDropped,
      unchanged: x.unchanged,
      topics: x.bank.topics.length,
      frames: x.bank.frames.length,
      items: x.bank.items.length,
    };
    console.log(
      `[/api/toeic/frame-drill/import] 소재 ${body.topics} · 틀 ${body.frames} · 문항 ${body.items} · 추가 ${x.created} · 고침 ${x.updated} · 지움 ${x.removed} · AI ${x.aiKept}/${x.aiDropped} · 그대로 ${x.unchanged}`,
    );
    return json(body);
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "-";
    console.error(`[/api/toeic/frame-drill/import] 저장 실패: ${err instanceof Error ? err.name : typeof err} (code ${code})`);
    return json({ ok: false, error: "save_failed", messageKo: "가져오지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

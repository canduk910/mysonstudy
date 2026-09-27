/**
 * POST /api/toeic/guides/import — 유형별 공략 "파일로 가져오기" (docs/harness/toeic.md §12-2 — 형식 `toeic-guides/v2`)
 *
 * 교재 공략 쪽 전사와 템플릿 훈련의 틀은 저장소(PUBLIC)에 넣지 않고 git 밖 파일(`data/private/`)로 둔다(§0-2·§12-2-1). 공략 폴더 목록·
 * 폴더의 "📂 파일로 가져오기"가 사용자가 고른 JSON을 그대로 이 라우트에 보낸다 — 프로덕션에 넣는 것은 사용자가 앱에서 파일을 고르는
 * 행동이다(로컬에서 프로덕션 DB로 쓰지 않는다).
 *
 * - 검증: `toeicGuideFileSchema`(lib/ai/toeic/schemas — 공략 + 틀 은행, 정렬 빠짐 0까지). 통과 못 하면 400 — 본문은 순수 함수
 *   `toeicGuideImportInvalidBody`가 **그대로** 만든다(경로 + 규칙 문구만, 값 없음 — eval이 같은 함수로 누출을 본다).
 * - 계획: `planToeicGuideImport`(유형마다 문서 `guide-{part}`, 틀 은행 `guide-templates`, 내용 지문 SHA-256).
 * - 저장: 스토어 `upsertToeicGuides` — 확인(decideGuideUpsert)과 쓰기가 한 원자 단위. **제자리 갱신·멱등**(같은 파일 두 번 = unchanged),
 *   충돌이 하나라도 있으면 파일 전체를 쓰지 않는다(409). 시험·테스트 기록은 건드리지 않는다(교정해도 기록·스트릭이 이어진다).
 * - AI·키 검사·prod-guard 없음(생성·수정이다 — 키가 없어도 동작).
 * - 원문 누출 방지(§12-2-6): 본문·파싱 결과를 로그에 찍지 않는다(개수·오류 이름만). 응답에는 키·유형·개수만 싣는다.
 *
 * 응답 shape (단일 정의처 `lib/toeic-guide-contract.ts` ToeicGuideImportResponse):
 * - 200 { ok:true, created, updated, unchanged }                         — 각각 presetKey 배열(파일 순서 — 유형 항목들 다음 틀 은행)
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }           — issues ≤ 20, { path, message }(값 없음)
 * - 409 { ok:false, error:"guide_conflict", messageKo, conflicts }        — { presetKey, part("templates" 가능), reason }[]
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { planToeicGuideImport } from "@/lib/ai/toeic/guide-import";
import { toeicGuideFileSchema, toeicGuideImportInvalidBody } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import type { ToeicGuideConflictReason, ToeicGuideImportResponse } from "@/lib/toeic-guide-contract";
import { toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

function json(body: ToeicGuideImportResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 409 문구 — 사유별로 한 줄(키·유형 이름만, 교재 글은 싣지 않는다) */
const CONFLICT_MESSAGE_KO: Record<ToeicGuideConflictReason, string> = {
  preset_key_is_book: "같은 키(presetKey)를 표현집이 이미 쓰고 있어요",
  part_mismatch: "같은 키로 다른 유형(또는 틀 모음)이 이미 들어가 있어요",
  part_taken: "그 유형(또는 틀 모음)을 다른 키의 공략이 이미 차지하고 있어요",
};

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요. 공략 가져오기용 파일(.json)을 골라 주세요.", issues: [] }, 400);
  }

  const parsed = toeicGuideFileSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    // 개수만 로그(경로·값 없음 — 교재 원문이 로그로 새지 않게)
    console.warn(`[/api/toeic/guides/import] 형식 거부: 문제 ${parsed.error.issues.length}곳`);
    return json(toeicGuideImportInvalidBody(parsed.error.issues), 400);
  }

  const items = planToeicGuideImport(parsed.data);
  const nowIso = new Date().toISOString(); // 원자 단위 밖에서 한 번 — 트랜잭션이 재시도해도 같은 시각

  try {
    const decision = await getStore().upsertToeicGuides(items, nowIso);
    if (!decision.ok) {
      const reasons = [...new Set(decision.conflicts.map((c) => c.reason))];
      console.warn(`[/api/toeic/guides/import] 충돌 ${decision.conflicts.length}건(${reasons.join(",")}) — 쓰지 않음`);
      return json(
        {
          ok: false,
          error: "guide_conflict",
          messageKo: `가져오지 않았어요 — ${reasons.map((r) => CONFLICT_MESSAGE_KO[r]).join(" / ")}. 파일의 presetKey를 확인해 주세요.`,
          conflicts: decision.conflicts,
        },
        409,
      );
    }
    const pick = (o: "created" | "updated" | "unchanged") => decision.results.filter((r) => r.outcome === o).map((r) => r.presetKey);
    const body = { ok: true as const, created: pick("created"), updated: pick("updated"), unchanged: pick("unchanged") };
    console.log(
      `[/api/toeic/guides/import] 항목 ${items.length} · 추가 ${body.created.length} · 고침 ${body.updated.length} · 그대로 ${body.unchanged.length}`,
    );
    return json(body);
  } catch (err) {
    // 오류 이름·코드만(메시지에 문서 내용이 섞일 수 있다 — §12-2-6 "개수와 오류 이름만")
    const code = err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "-";
    console.error(`[/api/toeic/guides/import] 저장 실패: ${err instanceof Error ? err.name : typeof err} (code ${code})`);
    return json({ ok: false, error: "save_failed", messageKo: "가져오지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

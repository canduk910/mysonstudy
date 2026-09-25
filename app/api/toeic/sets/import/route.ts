/**
 * POST /api/toeic/sets/import — 표현집 "파일로 가져오기" (docs/harness/toeic.md §7-6)
 *
 * 교재 전사본은 저장소(PUBLIC)에 넣지 않고 git 밖 파일로 둔다(§0-2). 목록 화면의 "파일로 가져오기"가 사용자가 고른 JSON을
 * 그대로 이 라우트에 보낸다 — 프로덕션에 넣는 것은 사용자가 앱에서 파일을 고르는 행동이다(로컬에서 프로덕션 DB로 쓰지 않는다).
 *
 * - 검증: `toeicImportFileSchema`(lib/ai/toeic/schemas) — entries·points·quiz에 호출 A·B와 **같은 규칙**(exampleSpan ⊂ example,
 *   keyExpressions ⊂ entries 등). 통과 못 하면 400 + 위치(issues, 값은 싣지 않는다 — 교재 원문이 로그·응답에 새지 않게).
 *   스키마가 문구를 정하지 않은 기본 오류(형식 표시·타입·상한)는 `toeicZodErrorKo`(per-parse)로 한국어 — 화면이 그대로 보인다.
 * - **멱등**: 같은 presetKey가 이미 있으면 건너뛴다. 확인과 생성은 스토어의 한 원자 단위(importToeicSets)라 두 번 눌러도 한 번.
 * - AI 호출 없음(키가 없어도 동작). 가져온 세트는 source:"import", photoCount 0, model null. enriched는 저장 계층이 계산.
 *
 * 응답 shape (단일 정의처는 `lib/toeic-set-contract.ts` ToeicImportResponse):
 * - 200 { ok:true, created, skipped, createdIds }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { toeicImportFileSchema } from "@/lib/ai/toeic/schemas";
import { getStore, type NewToeicSet } from "@/lib/store";
import type { ToeicImportResponse } from "@/lib/toeic-set-contract";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

/** 400 응답에 싣는 검증 위치 상한 — 파일이 통째로 틀리면 수백 줄이 된다 */
const ISSUES_MAX = 20;

function json(body: ToeicImportResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "JSON 파일이 아니에요. 가져오기용 파일을 골라 주세요.", issues: [] }, 400);
  }
  const parsed = toeicImportFileSchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    const formatIssue = parsed.error.issues.find((i) => i.path[0] === "format");
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: formatIssue
          ? "표현집 가져오기 파일(toeic-sets/v1)이 아니에요."
          : `파일 내용이 표현집 형식과 맞지 않아요(${parsed.error.issues.length}곳).`,
        // 위치와 규칙 메시지만 — zod 메시지에는 값을 넣지 않는다(schemas.ts 규약)
        issues: toToeicIssues(parsed.error.issues, ISSUES_MAX),
      },
      400,
    );
  }

  const inputs: NewToeicSet[] = parsed.data.sets.map((s) => ({
    titleKo: s.titleKo.trim(),
    dayNo: s.dayNo,
    topicKo: s.topicKo,
    source: "import",
    presetKey: s.presetKey,
    entries: s.entries,
    quiz: s.quiz,
    photoCount: 0,
    enriched: false, // 저장 계층이 entries에서 다시 계산한다
    model: null,
  }));

  try {
    const result = await getStore().importToeicSets(inputs);
    return json({
      ok: true,
      created: result.created.length,
      skipped: result.skippedKeys.length,
      createdIds: result.created.map((r) => r.id),
    });
  } catch (err) {
    console.error("[/api/toeic/sets/import] 가져오기 실패:", err);
    return json({ ok: false, error: "save_failed", messageKo: "가져오지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

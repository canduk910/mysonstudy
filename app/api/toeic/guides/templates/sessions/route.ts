/**
 * POST /api/toeic/guides/templates/sessions — 템플릿(틀) 테스트·틀 시험 기록 저장 (docs/harness/toeic.md §12-5-6·§12-13-2, SPEC §20-10)
 *
 * 본문 `{ clientSessionId, mode, startedAt, finishedAt, items: { word, correct, answered }[] }` → `toeicQuizzes`에 **틀 은행 id로**
 * (`setId: "guide-templates"` — 본문 값을 믿지 않고 고정) 한 건. AI·키 검사·prod-guard 없음(생성 — 키가 없어도 저장된다).
 *
 * ── 검사(검토 B4 — 문서 id가 사용자 값에서 온다) ────────────────────────────────
 * 본문 zod는 `toeicTemplateSessionBodySchema`(lib/ai/toeic/schemas.ts — 요청 계약 타입과 양방향으로 묶였다) 하나다:
 * `clientSessionId`는 **소문자 UUID**(TOEIC_TEMPLATE_SESSION_ID_RE — `/`가 들어가면 Firestore doc()이 하위 경로를 가리킨다),
 * `startedAt`·`finishedAt`은 `z.string().datetime()`(finishedAt은 null도), `mode`는 틀 모드 다섯(TOEIC_TEMPLATE_BANK_MODES — ② 말하기
 * `tpl-recall`·`tpl-swap` + 2026-10-02 ③ 👀 틀 시험 고르기 `tpl-ko-frame`·`tpl-frame-ko`·`tpl-cloze`), `word`는 `tpl:{틀 key}`, 세션 안
 * `word` 중복 거부(한 판 한 틀 — 거짓 졸업 방지), items 1개 이상 · 상한은 모드로 갈린다(말하기 TOEIC_TEMPLATE_TEST_MAX 10 · 고르기
 * TOEIC_TEMPLATE_CHOICE_MAX 20). 틀 은행에 지금 없는 키도 받는다(교정하다 빠진 틀의 기록을 버리지 않는다). 틀 시험 러너는 판 하나를 **모드마다
 * 한 건**으로 보낸다(clientSessionId는 모드마다, startedAt은 같다 — §12-13-2).
 *
 * ── 멱등 ────────────────────────────────────────────────────────────────────────
 * 문서 id = `tpl-{clientSessionId}`(화면이 세션을 시작할 때 만든 UUID). 스토어 `addToeicQuizWithId`가 원자 단위 안에서 판정한다 —
 * 없으면 만든다(reused:false) · 같은 판(mode·startedAt)이면 쓰지 않고 돌려준다(reused:true — "다시 저장"·응답 유실 뒤 재전송·
 * 화면 이탈 저장이 같은 판을 두 벌 쌓아 거짓 졸업을 만들지 않게) · 다른 판이면 덮지 않고 새 id(reused:false).
 *
 * 응답 shape (단일 정의처 `lib/toeic-guide-contract.ts` ToeicTemplateSessionResponse):
 * - 200 { ok:true, id, reused }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues: {path, message}[] }   ← 경로·규칙만(값 없음)
 * - 404 { ok:false, error:"bank_not_found", messageKo }                            ← 틀 은행이 없거나 렌더 불가
 * - 500 { ok:false, error:"save_failed", messageKo }                               ← 틀 은행 읽기·저장 예외(로그는 오류 이름·메시지 200자만)
 */

import { NextResponse } from "next/server";
import { toeicTemplateSessionBodySchema } from "@/lib/ai/toeic/schemas";
import { getStore } from "@/lib/store";
import { TOEIC_TEMPLATE_BANK_ID } from "@/lib/toeic-guide";
import { toeicTemplateSessionDocId, type ToeicTemplateSessionResponse } from "@/lib/toeic-guide-contract";
import { isRenderableToeicTemplateBank } from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

function json(body: ToeicTemplateSessionResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", issues: [] }, 400);
  }
  const parsed = toeicTemplateSessionBodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "테스트 결과를 저장할 수 없어요.", issues: toToeicIssues(parsed.error.issues) }, 400);
  }
  const { clientSessionId, mode, startedAt, finishedAt, items } = parsed.data;

  // 스토어 읽기(틀 은행)도 저장과 같은 try 안 — 읽기 예외도 계약의 500 save_failed JSON으로 돌려준다(Next 기본 500 HTML이 아니게, QA S2 P3-2)
  try {
    const store = getStore();
    const bank = await store.getToeicSet(TOEIC_TEMPLATE_BANK_ID);
    if (!bank || !isRenderableToeicTemplateBank(bank)) {
      return json({ ok: false, error: "bank_not_found", messageKo: "템플릿 훈련 틀 모음이 없거나 열 수 없어요. 공략 파일을 다시 가져와 주세요." }, 404);
    }
    const { record, reused } = await store.addToeicQuizWithId(toeicTemplateSessionDocId(clientSessionId), {
      setId: TOEIC_TEMPLATE_BANK_ID,
      mode,
      startedAt,
      finishedAt,
      items,
    });
    return json({ ok: true, id: record.id, reused });
  } catch (err) {
    // JSON 파싱 오류(파일 백엔드의 깨진 db.json)는 메시지에 파일 내용 조각이 실리므로 이름만 남긴다(교재 원문이 로그로 새지 않게)
    const why = err instanceof SyntaxError ? err.name : err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown";
    console.error("[/api/toeic/guides/templates/sessions] 읽기·저장 실패:", why);
    return json({ ok: false, error: "save_failed", messageKo: "테스트 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

/**
 * POST /api/toeic/mocks/[id]/image — Q3–4 사진 한 장 만들기 (docs/harness/toeic.md §4-10·§7-4, 관문 P)
 *
 * 본문 `{slot: 0|1}` → 그 칸의 C2 `imagePrompt`로 `generateSceneImage`(lib/toeic-image.ts, 하네스 밖 관문) → 성공하면 스토어
 * `saveToeicPictureImage`가 **사진 문서 생성 + picture.items[slot].image = {ready, imageId}를 한 원자 단위로** 쓴다. 실패하면
 * `markToeicPictureImageFailed`가 {failed}로 적는다 — 화면은 장면 설명(sceneKo)을 대신 보여 주고 "사진 다시 만들기"를 띄운다.
 *
 * ── 응답이 끊겨도 서버는 끝까지 저장한다(§4-10) ─────────────────────────────────
 * 사진 한 장은 수십 초가 걸려 프로덕션의 60초 상한(Firebase Hosting → Cloud Run)에 걸릴 수 있다. 그래서 생성에 **요청 신호
 * (req.signal)를 넘기지 않는다** — 클라이언트가 끊겨도 만들고 저장한다. 대신 서버 쪽 시간 상한(IMAGE_JOB_TIMEOUT_MS)만 건다.
 * 화면은 실패를 받으면 `GET /api/toeic/mocks/[id]`로 한 번 다시 읽어 이미 저장됐는지 확인한 뒤에만 실패로 표시한다.
 *
 * ── 같은 칸을 두 번 만들지 않는다 ─────────────────────────────────────────────
 * - 이미 ready면 새로 만들지 않고 그 사진을 돌려준다(`reused:true`, 비용 0).
 * - 같은 인스턴스 안에서 같은 칸의 생성이 진행 중이면 **그 작업에 합류**한다(IN_FLIGHT) — 생성 직후 자동 요청과 "사진 다시
 *   만들기"·새로고침 뒤 자동 요청이 겹쳐도 한 장 값만 든다.
 * - 인스턴스가 달라 둘 다 만들더라도 저장은 "먼저 준비된 사진이 이긴다"(lib/toeic-mock-apply.ts) — 늦은 쪽은 쓰지 않고(고아
 *   사진 0) 먼저 저장된 사진을 돌려준다. 늦게 온 실패도 이미 준비된 사진을 failed로 내리지 않는다.
 *
 * 키가 없으면 501(생성·기록 모두 하지 않는다 — 칸 상태를 바꾸지 않는다).
 *
 * 응답 shape (단일 정의처는 `lib/toeic-mock-contract.ts` ToeicMockImageResponse):
 * - 200 { ok:true, slot, image:{status:"ready", imageId}, reused }
 * - 400 { ok:false, error:"invalid_input", messageKo, image:null }
 * - 404 { ok:false, error:"mock_not_found" | "picture_not_found", messageKo, image:null }
 * - 409 { ok:false, error:"scene_changed", messageKo, image }          ← 그사이 장면이 바뀜(만든 사진은 버림)
 * - 501 { ok:false, error:"no_api_key", messageKo, image }
 * - 500 { ok:false, error:"image_failed", messageKo, image:{failed}, retriable:true }
 * - 500 { ok:false, error:"save_failed", messageKo, image:null }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import type { ToeicPictureImage } from "@/lib/ai/toeic/schemas";
import { generateSceneImage } from "@/lib/toeic-image";
import type { ToeicMockImageRequest, ToeicMockImageResponse } from "@/lib/toeic-mock-contract";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

/** 서버 쪽 생성 상한 — 요청 상한(60초)과 무관하게 끝까지 만들되, 끝없이 매달리지는 않는다(Cloud Run 요청 상한 안쪽). */
const IMAGE_JOB_TIMEOUT_MS = 170_000;

const bodySchema = z.object({ slot: z.union([z.literal(0), z.literal(1)]) });

type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [ToeicMockImageRequest, BodyInput] extends [BodyInput, ToeicMockImageRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: ToeicMockImageResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** 작업 결과 — 라우트가 응답으로 바꾼다(합류한 요청도 같은 값을 받는다) */
type JobOutcome =
  | { kind: "ready"; image: ToeicPictureImage; reused: boolean }
  | { kind: "failed"; image: ToeicPictureImage | null; reason: "failed" | "too_large" }
  | { kind: "no_api_key" }
  | { kind: "stale"; image: ToeicPictureImage | null }
  | { kind: "missing" };

/**
 * 진행 중인 생성 — 키는 `모의고사:칸:장면`. 같은 인스턴스의 중복 생성을 합친다(비용 가드). 작업이 끝나면 지운다.
 * 모듈 전역이라 한 인스턴스 안에서만 유효하다 — 인스턴스 사이는 저장 판정(먼저 준비된 사진이 이긴다)이 막는다.
 */
const IN_FLIGHT = new Map<string, Promise<JobOutcome>>();

async function runImageJob(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<JobOutcome> {
  const store = getStore();
  const result = await generateSceneImage(imagePrompt, AbortSignal.timeout(IMAGE_JOB_TIMEOUT_MS));
  if (!result.ok && result.error === "no_api_key") return { kind: "no_api_key" };

  if (result.ok) {
    const saved = await store.saveToeicPictureImage({ mockId, slot, imagePrompt, dataUrl: result.dataUrl, model: result.model });
    switch (saved.outcome) {
      case "saved":
        return { kind: "ready", image: { status: "ready", imageId: saved.image.id }, reused: false };
      case "kept": // 다른 요청이 먼저 저장했다 — 그 사진을 쓴다(이 사진은 쓰지 않았다)
        return { kind: "ready", image: saved.record.parts.picture!.items[slot].image, reused: true };
      case "stale":
        return { kind: "stale", image: saved.record.parts.picture?.items[slot]?.image ?? null };
      case "missing":
        return { kind: "missing" };
    }
  }

  const reason = result.error === "too_large" ? "too_large" : "failed";
  console.error(`[/api/toeic/mocks/${mockId}/image] slot ${slot} 생성 실패(${reason}):`, result.detail);
  const marked = await store.markToeicPictureImageFailed(mockId, slot, imagePrompt);
  switch (marked.outcome) {
    case "marked":
      return { kind: "failed", image: { status: "failed", imageId: null }, reason };
    case "kept": // 그사이 다른 요청이 사진을 준비했다 — 실패로 내리지 않고 그 사진을 돌려준다
      return { kind: "ready", image: marked.record.parts.picture!.items[slot].image, reused: true };
    case "stale":
      return { kind: "stale", image: marked.record.parts.picture?.items[slot]?.image ?? null };
    case "missing":
      return { kind: "missing" };
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요.", image: null }, 400);
  }
  const parsed = bodySchema.safeParse(raw, { error: toeicZodErrorKo });
  if (!parsed.success) {
    const issue = toToeicIssues(parsed.error.issues)[0];
    return json({ ok: false, error: "invalid_input", messageKo: `사진 칸(slot)은 0 또는 1이에요.${issue ? ` (${issue.message})` : ""}`, image: null }, 400);
  }
  const { slot } = parsed.data;

  const mock = await getStore().getToeicMock(id);
  if (!mock || !isRenderableToeicMock(mock)) {
    return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요.", image: null }, 404);
  }
  const item = mock.parts.picture?.items[slot];
  if (!item) {
    return json({ ok: false, error: "picture_not_found", messageKo: "이 모의고사에는 그 사진 칸이 없어요.", image: null }, 404);
  }
  if (item.image.status === "ready" && item.image.imageId) {
    return json({ ok: true, slot, image: item.image, reused: true });
  }
  if (!process.env.OPENAI_API_KEY) {
    return json(
      { ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 사진을 만들 수 없어요. 장면 설명으로 연습할 수 있어요.", image: item.image },
      501,
    );
  }

  const key = `${id}:${slot}:${item.imagePrompt}`;
  let job = IN_FLIGHT.get(key);
  if (!job) {
    job = runImageJob(id, slot, item.imagePrompt).finally(() => IN_FLIGHT.delete(key));
    IN_FLIGHT.set(key, job);
  }

  let outcome: JobOutcome;
  try {
    outcome = await job;
  } catch (err) {
    console.error(`[/api/toeic/mocks/${id}/image] slot ${slot} 저장 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "사진을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", image: null }, 500);
  }

  switch (outcome.kind) {
    case "ready":
      return json({ ok: true, slot, image: outcome.image, reused: outcome.reused });
    case "failed":
      return json(
        {
          ok: false,
          error: "image_failed",
          messageKo:
            outcome.reason === "too_large"
              ? "사진이 너무 커서 저장하지 못했어요 — 다시 만들어 볼까요?"
              : "사진을 만들지 못했어요. 장면 설명으로 연습하거나 다시 만들어 보세요.",
          image: outcome.image,
          retriable: true,
        },
        500,
      );
    case "no_api_key":
      return json(
        { ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 사진을 만들 수 없어요.", image: null },
        501,
      );
    case "stale":
      return json(
        { ok: false, error: "scene_changed", messageKo: "그사이 장면이 바뀌어 만든 사진을 쓰지 않았어요 — 화면을 새로 읽을게요.", image: outcome.image },
        409,
      );
    case "missing":
      return json({ ok: false, error: "mock_not_found", messageKo: "그사이 지워진 모의고사예요.", image: null }, 404);
  }
}

/**
 * POST /api/japanese/speaking/mocks/[id]/image — Q3–4 일본 배경 사진 한 장 {slot} (docs/harness/japanese.md §15-7, 관문 P)
 *
 * 토익 §4-10·§7-2와 같은 규칙: 사진 한 장 = 요청 하나 · 응답이 끊겨도 서버는 끝까지 만들어 저장한다(요청 신호를 넘기지 않고 서버 시간 상한만) ·
 * 먼저 준비된 사진이 이긴다(ready는 바뀌지 않는다 — 판정은 원자 단위 안, lib/ja-speaking-record.ts) · 같은 칸 동시 요청은 이 인스턴스 안에서
 * 한 작업으로 묶는다 · 실패하면 그 칸을 failed로 적고 화면은 sceneKo로 대신 보인다("사진 다시 만들기").
 * 이미 ready면 키 없이 200 reused(학습 보기 화면이 열 때마다 불러도 비용 0).
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingImageResponse):
 * 200 { ok:true, slot, image, reused } · 400 invalid_input · 404 mock_not_found·picture_not_found · 409 scene_changed · 501 no_api_key ·
 * 500 image_failed(retriable)·save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { JaSpeakingImageSlot } from "@/lib/ai/japanese/speaking-schemas";
import type { JaSpeakingImageRequest, JaSpeakingImageResponse } from "@/lib/ja-speaking-contract";
import { generateJaSpeakingSceneImage } from "@/lib/ja-speaking-image";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";
import { toToeicIssues, toeicZodErrorKo } from "@/lib/toeic-zod-ko";

export const runtime = "nodejs";

/** 서버 쪽 사진 작업 시간 상한(토익과 같은 값 — 1회 재시도 포함) */
const IMAGE_JOB_TIMEOUT_MS = 170_000;

const bodySchema = z.object({ slot: z.union([z.literal(0), z.literal(1)]) });
type BodyInput = z.input<typeof bodySchema>;
const requestMatchesSchema: [JaSpeakingImageRequest, BodyInput] extends [BodyInput, JaSpeakingImageRequest] ? true : never = true;
void requestMatchesSchema;

function json(body: JaSpeakingImageResponse, status = 200) {
  return NextResponse.json(body, { status });
}

type JobOutcome =
  | { kind: "ready"; image: JaSpeakingImageSlot; reused: boolean }
  | { kind: "failed"; image: JaSpeakingImageSlot | null; reason: "failed" | "too_large" }
  | { kind: "no_api_key" }
  | { kind: "stale"; image: JaSpeakingImageSlot | null }
  | { kind: "missing" };

/** 같은 칸·같은 장면의 진행 중 작업(이 인스턴스) — 두 요청이 사진을 두 장 만들지 않게 */
const IN_FLIGHT = new Map<string, Promise<JobOutcome>>();

async function runImageJob(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<JobOutcome> {
  const store = getStore();
  const result = await generateJaSpeakingSceneImage(imagePrompt, AbortSignal.timeout(IMAGE_JOB_TIMEOUT_MS));
  if (!result.ok && result.error === "no_api_key") return { kind: "no_api_key" };
  if (result.ok) {
    const saved = await store.saveJaSpeakingPictureImage({ mockId, slot, imagePrompt, dataUrl: result.dataUrl, model: result.model });
    switch (saved.outcome) {
      case "saved":
        return { kind: "ready", image: { status: "ready", imageId: saved.image.id }, reused: false };
      case "kept":
        return { kind: "ready", image: saved.record.parts.picture!.items[slot].image, reused: true };
      case "stale":
        return { kind: "stale", image: saved.record.parts.picture?.items[slot]?.image ?? null };
      case "missing":
        return { kind: "missing" };
    }
  }
  const reason = result.error === "too_large" ? "too_large" : "failed";
  console.error(`[/api/japanese/speaking/mocks/${mockId}/image] slot ${slot} 생성 실패(${reason}):`, result.detail);
  const marked = await store.markJaSpeakingPictureImageFailed(mockId, slot, imagePrompt);
  switch (marked.outcome) {
    case "marked":
      return { kind: "failed", image: { status: "failed", imageId: null }, reason };
    case "kept":
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

  const mock = await getStore().getJaSpeakingMock(id);
  if (!mock || !isRenderableJaSpeakingMock(mock)) return json({ ok: false, error: "mock_not_found", messageKo: "없거나 열 수 없는 모의고사예요.", image: null }, 404);
  const item = mock.parts.picture?.items[slot];
  if (!item) return json({ ok: false, error: "picture_not_found", messageKo: "이 모의고사에는 그 사진 칸이 없어요.", image: null }, 404);
  if (item.image.status === "ready" && item.image.imageId) return json({ ok: true, slot, image: item.image, reused: true });
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 사진을 만들 수 없어요. 장면 설명으로 연습할 수 있어요.", image: item.image }, 501);
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
    console.error(`[/api/japanese/speaking/mocks/${id}/image] slot ${slot} 저장 실패:`, err);
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
          messageKo: outcome.reason === "too_large" ? "사진이 너무 커서 저장하지 못했어요 — 다시 만들어 볼까요?" : "사진을 만들지 못했어요. 장면 설명으로 연습하거나 다시 만들어 보세요.",
          image: outcome.image,
          retriable: true,
        },
        500,
      );
    case "no_api_key":
      return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 사진을 만들 수 없어요.", image: null }, 501);
    case "stale":
      return json({ ok: false, error: "scene_changed", messageKo: "그사이 장면이 바뀌어 만든 사진을 쓰지 않았어요 — 화면을 새로 읽을게요.", image: outcome.image }, 409);
    case "missing":
      return json({ ok: false, error: "mock_not_found", messageKo: "그사이 지워진 모의고사예요.", image: null }, 404);
  }
}

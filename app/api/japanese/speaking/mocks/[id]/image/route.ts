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
import { runPictureImageJob, settlePictureImageJob, type PictureJobOutcome } from "@/lib/picture-image-job";
import { getStore, type JaSpeakingMockRecord } from "@/lib/store";
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

/** 같은 칸·같은 장면의 진행 중 작업(이 인스턴스) — 두 요청이 사진을 두 장 만들지 않게. 몸통은 토익과 공용(lib/picture-image-job.ts) */
const IN_FLIGHT = new Map<string, Promise<PictureJobOutcome<JaSpeakingImageSlot>>>();

function runImageJob(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<PictureJobOutcome<JaSpeakingImageSlot>> {
  const store = getStore();
  return runPictureImageJob<JaSpeakingImageSlot, JaSpeakingMockRecord>(
    {
      logPath: `/api/japanese/speaking/mocks/${mockId}/image`,
      // 요청 신호를 넘기지 않는다 — 서버 시간 상한만
      generate: (prompt) => generateJaSpeakingSceneImage(prompt, AbortSignal.timeout(IMAGE_JOB_TIMEOUT_MS)),
      save: (input) => store.saveJaSpeakingPictureImage(input),
      markFailed: (m, s, prompt) => store.markJaSpeakingPictureImageFailed(m, s, prompt),
      keptImage: (record, s) => record.parts.picture!.items[s].image,
      slotImage: (record, s) => record.parts.picture?.items[s]?.image ?? null,
    },
    mockId,
    slot,
    imagePrompt,
  );
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
  const settled = await settlePictureImageJob(IN_FLIGHT, key, () => runImageJob(id, slot, item.imagePrompt), {
    logPath: `/api/japanese/speaking/mocks/${id}/image`,
    slot,
  });
  return json(settled.body, settled.status);
}

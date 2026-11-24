/**
 * lib/picture-image-job.ts — Q3–4 사진 한 장 만들기 라우트 공용 몸통 (**서버 전용**, 2026-11-25 정리)
 *
 * 토익(`app/api/toeic/mocks/[id]/image/route.ts`, toeic.md §4-10·§7-4)과 일본어 말하기
 * (`app/api/japanese/speaking/mocks/[id]/image/route.ts`, japanese.md §15-7)가 같은 몸통을 두 벌 들고 있었다.
 * 여기에는 **요청 검사 뒤의 공통부**만 있다 — 생성(관문 P) → 원자 단위 저장(먼저 준비된 사진이 이긴다)·실패 기록 →
 * 같은 인스턴스의 같은 칸·장면 요청 합류(IN_FLIGHT) → 결과를 응답 본문·상태코드로. 응답 문구·상태코드는 두 라우트가 쓰던 것 그대로다.
 *
 * 각 라우트에 남는 것(라우트마다 계약·검사 순서가 eval로 잠겨 있다): 본문 zod · 모의고사/칸 조회(404) ·
 * ready면 키 없이 reused · 키 없으면 501 · 생성 함수와 **서버 시간 상한 신호**(요청 신호를 넘기지 않는다 — 응답이 끊겨도 끝까지 저장).
 */

/** 칸의 사진 상태(토익 ToeicPictureImage·일본어 JaSpeakingImageSlot 둘 다 이 모양) */
export interface PictureSlotImage {
  status: "pending" | "ready" | "failed";
  imageId: string | null;
}

/** 관문 P 결과 중 이 몸통이 보는 부분(lib/image-gen.ts JpegImageResult) */
export type PictureGenResult =
  | { ok: true; dataUrl: string; model: string }
  | { ok: false; error: string; detail?: unknown };

export type PictureSaveResult<R> =
  | { outcome: "saved"; image: { id: string } }
  | { outcome: "kept" | "stale"; record: R }
  | { outcome: "missing" };

export type PictureMarkResult<R> = { outcome: "marked" | "kept" | "stale"; record: R } | { outcome: "missing" };

export interface PictureImageJobDeps<I extends PictureSlotImage, R> {
  /** 로그 머리(`/api/toeic/mocks/<id>/image`) */
  logPath: string;
  /** 생성 — 라우트가 서버 시간 상한 신호를 붙여 넘긴다 */
  generate: (imagePrompt: string) => Promise<PictureGenResult>;
  save: (input: { mockId: string; slot: 0 | 1; imagePrompt: string; dataUrl: string; model: string }) => Promise<PictureSaveResult<R>>;
  markFailed: (mockId: string, slot: 0 | 1, imagePrompt: string) => Promise<PictureMarkResult<R>>;
  /** kept — 다른 요청이 준비해 둔 그 칸의 사진(있다고 판정된 자리) */
  keptImage: (record: R, slot: 0 | 1) => I;
  /** stale — 응답에 실을 그 칸의 현재 상태(없으면 null) */
  slotImage: (record: R, slot: 0 | 1) => I | null;
}

/** 작업 결과 — 합류한 요청도 같은 값을 받는다 */
export type PictureJobOutcome<I> =
  | { kind: "ready"; image: I; reused: boolean }
  | { kind: "failed"; image: I | null; reason: "failed" | "too_large" }
  | { kind: "no_api_key" }
  | { kind: "stale"; image: I | null }
  | { kind: "missing" };

export async function runPictureImageJob<I extends PictureSlotImage, R>(
  deps: PictureImageJobDeps<I, R>,
  mockId: string,
  slot: 0 | 1,
  imagePrompt: string,
): Promise<PictureJobOutcome<I>> {
  const result = await deps.generate(imagePrompt);
  if (!result.ok && result.error === "no_api_key") return { kind: "no_api_key" };

  if (result.ok) {
    const saved = await deps.save({ mockId, slot, imagePrompt, dataUrl: result.dataUrl, model: result.model });
    switch (saved.outcome) {
      case "saved":
        return { kind: "ready", image: { status: "ready", imageId: saved.image.id } as I, reused: false };
      case "kept": // 다른 요청이 먼저 저장했다 — 그 사진을 쓴다(이 사진은 쓰지 않았다)
        return { kind: "ready", image: deps.keptImage(saved.record, slot), reused: true };
      case "stale":
        return { kind: "stale", image: deps.slotImage(saved.record, slot) };
      case "missing":
        return { kind: "missing" };
    }
  }

  const reason = result.error === "too_large" ? "too_large" : "failed";
  console.error(`[${deps.logPath}] slot ${slot} 생성 실패(${reason}):`, result.detail);
  const marked = await deps.markFailed(mockId, slot, imagePrompt);
  switch (marked.outcome) {
    case "marked":
      return { kind: "failed", image: { status: "failed", imageId: null } as I, reason };
    case "kept": // 그사이 다른 요청이 사진을 준비했다 — 실패로 내리지 않고 그 사진을 돌려준다
      return { kind: "ready", image: deps.keptImage(marked.record, slot), reused: true };
    case "stale":
      return { kind: "stale", image: deps.slotImage(marked.record, slot) };
    case "missing":
      return { kind: "missing" };
  }
}

/** 응답 본문 — 두 라우트 계약(ToeicMockImageResponse·JaSpeakingImageResponse)이 품는 모양 */
export type PictureImageBody<I> =
  | { ok: true; slot: 0 | 1; image: I; reused: boolean }
  | {
      ok: false;
      error: "mock_not_found" | "scene_changed" | "no_api_key" | "image_failed" | "save_failed";
      messageKo: string;
      image: I | null;
      retriable?: boolean;
    };

/**
 * 같은 칸·같은 장면의 진행 중 작업에 합류하거나 새로 시작하고, 결과를 응답 본문·상태코드로 바꾼다.
 * `inFlight`는 라우트 모듈 전역 Map(인스턴스 안에서만 유효 — 인스턴스 사이는 저장 판정이 막는다).
 */
export async function settlePictureImageJob<I>(
  inFlight: Map<string, Promise<PictureJobOutcome<I>>>,
  key: string,
  start: () => Promise<PictureJobOutcome<I>>,
  ctx: { logPath: string; slot: 0 | 1 },
): Promise<{ status: number; body: PictureImageBody<I> }> {
  let job = inFlight.get(key);
  if (!job) {
    job = start().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }

  let outcome: PictureJobOutcome<I>;
  try {
    outcome = await job;
  } catch (err) {
    console.error(`[${ctx.logPath}] slot ${ctx.slot} 저장 실패:`, err);
    return { status: 500, body: { ok: false, error: "save_failed", messageKo: "사진을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", image: null } };
  }

  switch (outcome.kind) {
    case "ready":
      return { status: 200, body: { ok: true, slot: ctx.slot, image: outcome.image, reused: outcome.reused } };
    case "failed":
      return {
        status: 500,
        body: {
          ok: false,
          error: "image_failed",
          messageKo:
            outcome.reason === "too_large"
              ? "사진이 너무 커서 저장하지 못했어요 — 다시 만들어 볼까요?"
              : "사진을 만들지 못했어요. 장면 설명으로 연습하거나 다시 만들어 보세요.",
          image: outcome.image,
          retriable: true,
        },
      };
    case "no_api_key":
      return { status: 501, body: { ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 사진을 만들 수 없어요.", image: null } };
    case "stale":
      return {
        status: 409,
        body: { ok: false, error: "scene_changed", messageKo: "그사이 장면이 바뀌어 만든 사진을 쓰지 않았어요 — 화면을 새로 읽을게요.", image: outcome.image },
      };
    case "missing":
      return { status: 404, body: { ok: false, error: "mock_not_found", messageKo: "그사이 지워진 모의고사예요.", image: null } };
  }
}
